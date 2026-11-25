"""Money and records that were wrong (fix list batch 2): concurrency, pay periods, stock vs the Inventory account,
job invoice GST, bank import, pay privacy, non-English letters in PDFs, imported Fiji pay runs, the Trial Balance
and aged reports."""
import sqlite3
import threading

import pytest

from riyeser import create_app
from riyeser import ledger as L
from riyeser.db import get_db, init_db, migrate, duplicate_numbers


@pytest.fixture
def app(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "t.db")})
    with app.app_context():
        init_db("Test Co")
    return app


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return c


def ids(db):
    acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
    tc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM tax_codes")}
    return acc, tc


def _contacts(db):
    cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','C')").lastrowid
    sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','S')").lastrowid
    return cust, sup


# ------------------------------------------------------------------ F15
def _in_threads(n, fn):
    barrier = threading.Barrier(n)
    errors = []

    def run(i):
        try:
            barrier.wait()
            fn(i)
        except Exception as e:  # noqa: BLE001 - collected and checked by the test
            errors.append(e)
    ts = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return errors


def test_f15_four_clerks_get_unique_numbers_and_one_payment_wins(app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, _ = _contacts(db)
        db.commit()

    def clerk(_i):
        with app.app_context():
            db = get_db()
            for _ in range(40):
                L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-20"),
                                [dict(description="Work", qty=1, unit_price=10000, account_id=acc["4-2000"],
                                      tax_code_id=tc["GST"])], "open")
                db.commit()
    assert _in_threads(4, clerk) == []
    with app.app_context():
        db = get_db()
        nums = [r["number"] for r in db.execute("SELECT number FROM documents WHERE side='sale'")]
        assert len(nums) == 160 and len(set(nums)) == 160
        inv = db.execute("SELECT id, total FROM documents ORDER BY id LIMIT 1").fetchone()

    def pay(_i):
        with app.app_context():
            db = get_db()
            try:
                L.record_payment(db, "in", cust, acc["1-1110"], "2026-11-21", [(inv["id"], inv["total"])])
                db.commit()
            except L.PostingError:
                db.rollback()
    assert _in_threads(2, pay) == []
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM payments").fetchone()[0] == 1
        d = db.execute("SELECT amount_paid, total, status FROM documents WHERE id=?", (inv["id"],)).fetchone()
        assert d["amount_paid"] == d["total"] and d["status"] == "paid"


def test_f15_document_numbers_are_unique_and_old_duplicates_still_open(app, tmp_path):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, _ = _contacts(db)
        line = [dict(description="x", qty=1, unit_price=100, account_id=acc["4-2000"])]
        L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-20", number="INV00002"), line, "open")
        # the counter skips a number already typed in by hand
        d = L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-20"), line, "open")
        d = L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-20"), line, "open")
        assert db.execute("SELECT number FROM documents WHERE id=?", (d,)).fetchone()[0] == "INV00003"
        with pytest.raises(L.PostingError, match="already used"):
            L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-20", number="INV00003"), line, "open")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO documents (side, status, number, contact_id, date) VALUES"
                       " ('sale','open','INV00003',?,'2026-11-20')", (cust,))
        db.commit()
    # an older file that already has a duplicate: kept as it is, a warning, and it still opens
    old = tmp_path / "old.db"
    con = sqlite3.connect(str(tmp_path / "t.db"))
    con.execute("DROP INDEX documents_side_number")
    con.execute("INSERT INTO documents (side, status, number, contact_id, date) VALUES"
                " ('sale','open','INV00003',?,'2026-11-20')", (cust,))
    con.commit()
    con.execute(f"VACUUM INTO '{old}'")
    con.close()
    con = sqlite3.connect(str(old))
    con.row_factory = sqlite3.Row
    migrate(con)
    assert duplicate_numbers(con) == [("sale", "INV00003", 2)]
    assert not con.execute("SELECT 1 FROM sqlite_master WHERE name='documents_side_number'").fetchone()
    con.close()


# ------------------------------------------------------------------ F11
def _employee(db, first="Jo", last="Bloggs", freq="fortnightly"):
    return db.execute("INSERT INTO employees (first_name, last_name, pay_basis, hourly_rate, std_hours, pay_frequency,"
                      " tax_free_threshold, super_rate) VALUES (?,?,'hourly',3000,76,?,1,12)",
                      (first, last, freq)).lastrowid


def _pay(client, emp, start="2026-11-11", end="2026-11-24", **extra):
    with client.application.app_context():
        bank = get_db().execute("SELECT id FROM accounts WHERE code='1-1110'").fetchone()[0]
    data = {"action": "process", "frequency": "fortnightly", "period_start": start, "period_end": end,
            "pay_date": end, "bank_account_id": bank, f"inc_{emp}": "1", f"hours_{emp}": "76", **extra}
    return client.post("/payroll/run", data=data, follow_redirects=True)


def test_f11_same_pay_period_twice_is_refused_unless_extra_run(client, app):
    with app.app_context():
        db = get_db()
        emp = _employee(db)
        db.commit()
    _pay(client, emp)
    r = _pay(client, emp, start="2026-11-18", end="2026-12-01")       # overlaps 11-24 Nov
    assert "already paid on 2026-11-24" in r.get_data(as_text=True)
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM payruns").fetchone()[0] == 1
        leave = db.execute("SELECT leave_hours FROM employees WHERE id=?", (emp,)).fetchone()[0]
    _pay(client, emp, start="2026-11-25", end="2026-12-08")           # the next fortnight is fine
    r = _pay(client, emp, extra_run="1")                               # a bonus, on purpose
    with app.app_context():
        db = get_db()
        runs = db.execute("SELECT kind FROM payruns ORDER BY id").fetchall()
        assert [x[0] for x in runs] == ["regular", "regular", "extra"]
        assert db.execute("SELECT memo FROM journal_entries WHERE source_type='payrun' ORDER BY id DESC"
                          ).fetchone()[0].startswith("Extra pay run (bonus)")
        first = db.execute("SELECT id FROM payruns ORDER BY id LIMIT 1").fetchone()[0]
    # voiding the first run frees its dates again
    client.post(f"/payroll/payrun/{first}/void")
    _pay(client, emp)
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM payruns").fetchone()[0] == 4
    assert leave > 0
