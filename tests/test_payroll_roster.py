"""Riyeser Payroll 2.3.1 pay run files carry rostered vs paid hours (optional fields). Accounting shows them on the
inbox list, the import history and the imported journal, keeps them with the import, and posts the same amounts."""
import json

import pytest

from riyeser import create_app
from riyeser import ledger as L
from riyeser.db import get_db, init_db, migrate


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("RIYESER_DOCS", str(tmp_path / "Riyeser"))
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "t.db")})
    with app.app_context():
        init_db("Test Co")
    return app


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    c.post("/setup/company", data={"name": "Test Co", "currency": "fjd", "fy_start_month": "1"})
    return c


def _run(pid, with_roster):
    emps = [{"name": "Ana", "gross": 400, "tax_withheld": 20, "employer_contribution": 40, "other_deductions": 32,
             "net": 348},
            {"name": "Ben", "gross": 108, "tax_withheld": 0, "employer_contribution": 10.8, "other_deductions": 8.64,
             "net": 99.36}]
    run = {"format": "riyeser.payrun.v1", "source": "Riyeser Payroll", "payrun_id": pid, "pay_date": "2030-03-11",
           "period_start": "2030-03-04", "period_end": "2030-03-10", "currency": "FJD", "employees": emps}
    if with_roster:
        emps[0].update(rostered_hours=37.5, paid_hours=40, hours_difference=2.5, hours_source="roster")
        emps[1].update(rostered_hours=8, paid_hours=6.5, hours_difference=-1.5, hours_source="typed",
                       some_future_field={"x": 1})
        run["roster_summary"] = {"rostered_hours": 45.5, "paid_hours": 46.5, "hours_difference": 1, "employees": 2,
                                 "from_roster": 1}
        run["something_new"] = "ignored"
    return run


def _post(client, app, name):
    with app.app_context():
        bank = get_db().execute("SELECT id FROM accounts WHERE code='1-1110'").fetchone()["id"]
    return client.post("/links/payroll", data={"bank_account_id": bank, "name": name}, follow_redirects=True)


def test_payrun_files_with_and_without_roster_hours(client, app, tmp_path):
    inbox = tmp_path / "Riyeser" / "Inbox" / "Payroll"
    inbox.mkdir(parents=True, exist_ok=True)
    (inbox / "old.json").write_text(json.dumps(_run("OLD-1", False)))
    (inbox / "new.json").write_text(json.dumps(_run("NEW-1", True)))

    page = client.get("/links/payroll").get_data(as_text=True)
    assert "Rostered 45.5 h" in page and "paid 46.5 h" in page and 'class="hrs-over">+1 h' in page
    assert "1 person&#39;s hours from the roster" in page and "hours from roster" in page
    assert '<b class="hrs-under">&minus;1.5 h</b>' in page        # Ben: under the roster
    assert page.count('class="hrs-row"') == 1                    # the old file has no hours line

    r = _post(client, app, "old.json")
    assert r.status_code == 200 and "Hours: rostered vs paid" not in r.get_data(as_text=True)
    with app.app_context():
        db = get_db()
        bal_old = L.balances(db)
        row = db.execute("SELECT * FROM imported_payruns WHERE payrun_id='OLD-1'").fetchone()
        assert row["roster"] is None
        e_old = row["entry_id"]

    r = _post(client, app, "new.json")
    entry = r.get_data(as_text=True)
    assert "Hours: rostered vs paid" in entry and "Rostered 45.5 h" in entry and "hours from roster" in entry
    with app.app_context():
        db = get_db()
        row = db.execute("SELECT * FROM imported_payruns WHERE payrun_id='NEW-1'").fetchone()
        kept = json.loads(row["roster"])
        assert kept["total"] == {"rostered": 45.5, "paid": 46.5, "diff": 1.0} and kept["from_roster"] == 1
        assert [(x["name"], x["rostered"], x["paid"], x["diff"], x["source"]) for x in kept["employees"]] == [
            ("Ana", 37.5, 40.0, 2.5, "roster"), ("Ben", 8.0, 6.5, -1.5, "typed")]
        # the same amounts are posted with or without the hours
        lines = lambda eid: sorted((x["debit"], x["credit"]) for x in db.execute(
            "SELECT debit, credit FROM journal_lines WHERE entry_id=?", (eid,)))
        assert lines(row["entry_id"]) == lines(e_old)
        bal_new = L.balances(db)
        assert all(bal_new[k] == 2 * v for k, v in bal_old.items() if v)

    # the import history keeps them (viewed later), the old one shows none
    page = client.get("/links/payroll").get_data(as_text=True)
    hist = page.split("<h2>Imported</h2>")[1]
    assert hist.count('class="hrs-row"') == 1 and "Rostered 45.5 h" in hist
    # an uploaded file works the same; bad hour values are left out, not refused
    bad = _run("NEW-2", True)
    bad["employees"][0]["rostered_hours"] = "lots"
    with app.app_context():
        bank = get_db().execute("SELECT id FROM accounts WHERE code='1-1110'").fetchone()["id"]
    import io
    r = client.post("/links/payroll", data={"bank_account_id": bank, "upload": "1",
                                            "file": (io.BytesIO(json.dumps(bad).encode()), "NEW-2.json")},
                    content_type="multipart/form-data", follow_redirects=True)
    assert r.status_code == 200 and "imported" in r.get_data(as_text=True)
    with app.app_context():
        kept = json.loads(get_db().execute("SELECT roster FROM imported_payruns WHERE payrun_id='NEW-2'").fetchone()[0])
        assert [x["name"] for x in kept["employees"]] == ["Ben"]


def test_migrate_adds_the_roster_column_to_an_older_company_file(app):
    with app.app_context():
        db = get_db()
        db.execute("DROP TABLE imported_payruns")
        db.execute("""CREATE TABLE imported_payruns (
            id INTEGER PRIMARY KEY, source TEXT NOT NULL, payrun_id TEXT NOT NULL, pay_date TEXT,
            employees INTEGER, gross INTEGER, entry_id INTEGER REFERENCES journal_entries(id),
            file_name TEXT, imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            UNIQUE(source, payrun_id))""")
        db.execute("INSERT INTO imported_payruns (source, payrun_id, pay_date, employees, gross) "
                   "VALUES ('Riyeser Payroll','X1','2026-01-01',1,100)")
        migrate(db)
        migrate(db)  # twice is fine
        row = db.execute("SELECT * FROM imported_payruns WHERE payrun_id='X1'").fetchone()
        assert row["roster"] is None and row["gross"] == 100
