"""Accounting fix list items after batch 2 (S, M and F12 items): each test proves the item's "Done when"."""
import io
import json

import pytest

from riyeser import create_app
from riyeser import ledger as L
from riyeser.db import get_db, init_db
from tests.test_batch2 import ids, _contacts, _employee


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
    return c


def page(r):
    return r.get_data(as_text=True)


# ------------------------------------------------------------------ S29
def test_s29_manual_pay_run_upload_works(client, app):
    html = page(client.get("/links/payroll"))
    assert '<form method="post" id="imp" enctype="multipart/form-data">' in html
    run = {"format": "riyeser.payrun.v1", "payrun_id": "U1", "pay_date": "2026-11-14",
           "employees": [{"name": "Ben", "gross": 500, "tax_withheld": 20, "employer_contribution": 50}]}
    with app.app_context():
        bank = get_db().execute("SELECT id FROM accounts WHERE code='1-1110'").fetchone()[0]
    r = client.post("/links/payroll", data={"bank_account_id": bank, "upload": "1",
                                            "file": (io.BytesIO(json.dumps(run).encode()), "U1.json")},
                    content_type="multipart/form-data", follow_redirects=True)
    assert "Pay run U1 imported" in page(r)


# ------------------------------------------------------------------ S38, S39 (OWNER-BACKUP)
def _sale(app, amount=10000):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust = db.execute("SELECT id FROM contacts WHERE kind='customer'").fetchone()
        cust = cust[0] if cust else _contacts(db)[0]
        L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-20"),
                        [dict(description="Work", qty=1, unit_price=amount, account_id=acc["4-2000"])], "open")
        db.commit()


def test_s38_back_up_now_daily_automatic_keep_30_and_reminder(client, app, tmp_path):
    from datetime import datetime, timedelta
    from riyeser import backups as bk
    folder = tmp_path / "Riyeser" / "Accounting" / "Backups" / "t"
    assert "Back up now" in page(client.get("/setup/backups/")) and "Open the backups folder" in page(client.get("/setup/backups/"))
    assert "no backup of this company in the last 7 days" in page(client.get("/setup/backups/"))
    r = client.post("/setup/backups/now", follow_redirects=True)
    files = list(folder.glob("*.db"))
    assert len(files) == 1 and files[0].name.endswith(" Test Co.db") and "Backed up to" in page(r)
    assert bk.describe(files[0])["name"] == "Test Co"
    assert "no backup of this company" not in page(client.get("/setup/backups/"))
    # the open-folder button works (on a server it says where the folder is)
    assert str(folder) in page(client.post("/setup/backups/open", follow_redirects=True))
    # downloading a copy
    r = client.post("/setup/backups/download")
    assert r.status_code == 200 and r.data[:15] == b"SQLite format 3"
    # automatic: one a day per company, the first time it's used that day
    app.config["AUTO_BACKUP"] = True
    for f in folder.glob("*.db"):
        f.unlink()
    client.get("/")
    client.get("/")
    assert len(list(folder.glob("*.db"))) == 1
    assert bk.daily_backup(str(tmp_path / "t.db")) is None                       # already done today
    # the last 30 are kept
    start = datetime(2026, 10, 1, 9)
    for i in range(33):
        p = bk.backup_now(str(tmp_path / "t.db"), now=start + timedelta(days=i))
        t = (start + timedelta(days=i)).timestamp()
        import os
        os.utime(p, (t, t))
    names = sorted(f.name for f in folder.glob("*.db"))
    assert len(names) == 30 and names[0].startswith("2026-10-05")  # 33 dated + today's automatic one: the oldest 4 go
    assert bk.needs_reminder(str(tmp_path / "t.db"), now=datetime.now() + timedelta(days=8))
    # Settings lists Backups
    assert 'href="/setup/backups/"' in page(client.get("/setup/company"))


def test_s39_restore_over_this_company_or_as_a_named_copy(client, app, tmp_path):
    from riyeser import backups as bk
    _sale(app)
    snap = bk.backup_now(str(tmp_path / "t.db"))
    _sale(app, 5000)                                         # after the backup
    with open(snap, "rb") as f:
        r = client.post("/setup/backups/restore", data={"file": (io.BytesIO(f.read()), "my backup.db")},
                        content_type="multipart/form-data", follow_redirects=True)
    html = page(r)
    assert "Test Co" in html and "Restore over this company" in html and "(restored " in html
    token = r.request.path.rsplit("/", 1)[1]
    # 1. restore over: the company as it was is saved first, then replaced
    r = client.post(f"/setup/backups/restore/{token}", data={"action": "over"}, follow_redirects=True)
    assert "Test Co restored" in page(r)
    before = list((tmp_path / "Riyeser" / "Accounting" / "Backups" / "t").glob("*(before restore).db"))
    assert len(before) == 1 and bk.describe(before[0])["counts"]["invoices"] == 2
    assert bk.describe(tmp_path / "t.db")["counts"]["invoices"] == 1
    # 2. bring it in as a copy named "... (restored <date>)", not a second "Test Co"
    client.post("/login", data={"username": "admin", "password": "admin"})
    with open(snap, "rb") as f:
        r = client.post("/setup/backups/restore", data={"file": (io.BytesIO(f.read()), "b.db")},
                        content_type="multipart/form-data", follow_redirects=True)
    token = r.request.path.rsplit("/", 1)[1]
    client.post(f"/setup/backups/restore/{token}", data={"action": "copy"})
    with app.test_request_context():
        from riyeser import companies as co
        names = [c["name"] for c in co.all_companies()]
    assert names[0] == "Test Co" and len(names) == 2 and names[1].startswith("Test Co (restored ")
    # not a company file: refused
    r = client.post("/setup/backups/restore", data={"file": (io.BytesIO(b"hello"), "x.db")},
                    content_type="multipart/form-data", follow_redirects=True)
    assert "isn&#39;t a Riyeser Accounting company file" in page(r)


def test_owner_backup_first_run_offers_restore(tmp_path, monkeypatch):
    from riyeser import backups as bk
    monkeypatch.setenv("RIYESER_DOCS", str(tmp_path / "Riyeser"))
    old = create_app({"TESTING": True, "DATABASE": str(tmp_path / "old" / "company.db")})
    (tmp_path / "old").mkdir()
    with old.app_context():
        init_db("Moved PC Pty Ltd")
    snap = bk.backup_now(str(tmp_path / "old" / "company.db"))
    new = create_app({"TESTING": True, "DATABASE": str(tmp_path / "new" / "company.db")})
    (tmp_path / "new").mkdir()
    c = new.test_client()
    html = page(c.get("/setup"))
    assert "Restore from a backup…" in html and "Create company file" in html
    with open(snap, "rb") as f:
        r = c.post("/setup/backups/restore", data={"file": (io.BytesIO(f.read()), snap.name)},
                   content_type="multipart/form-data", follow_redirects=True)
    assert "Moved PC Pty Ltd" in page(r)
    token = r.request.path.rsplit("/", 1)[1]
    r = c.post(f"/setup/backups/restore/{token}", data={"action": "over"}, follow_redirects=True)
    assert "Moved PC Pty Ltd restored" in page(r)
    assert bk.describe(tmp_path / "new" / "company.db")["name"] == "Moved PC Pty Ltd"
    c.post("/login", data={"username": "admin", "password": "admin"})
    assert c.get("/").status_code == 200


# ------------------------------------------------------------------ S37
def test_s37_password_rules_lockout_and_taken_username(client, app):
    r = client.post("/users/save", data={"username": "sam", "password": "1", "preset": "sales"},
                    headers={"Referer": "/users"}, follow_redirects=True)
    assert "at least 8 characters" in page(r)
    client.post("/users/save", data={"username": "sam", "password": "long-enough", "preset": "sales"})
    r = client.post("/users/save", data={"username": "Sam", "password": "another-one", "preset": "sales"},
                    headers={"Referer": "/users"}, follow_redirects=True)
    assert "That username is taken" in page(r)
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM users WHERE username LIKE 'sam'").fetchone()[0] == 1
    # five wrong passwords, then sign-in waits (even with the right one), longer each time
    c = app.test_client()
    for _ in range(5):
        assert c.post("/login", data={"username": "admin", "password": "wrong"}).status_code == 200
    r = c.post("/login", data={"username": "admin", "password": "admin"})
    assert r.status_code == 429 and "Try again in 30 seconds" in page(r)
    fails = app.config["_login_fails"]
    key = next(iter(fails))
    fails[key] = (fails[key][0], 0)          # the wait is over
    assert c.post("/login", data={"username": "admin", "password": "admin"}).status_code == 302
    assert key not in fails


# ------------------------------------------------------------------ S22, S23
def _run(client, emp, hours, **extra):
    with client.application.app_context():
        bank = get_db().execute("SELECT id FROM accounts WHERE code='1-1110'").fetchone()[0]
    data = {"action": "process", "frequency": "fortnightly", "period_start": "2026-11-11", "period_end": "2026-11-24",
            "pay_date": "2026-11-24", "bank_account_id": bank, f"inc_{emp}": "1", f"hours_{emp}": hours, **extra}
    return client.post("/payroll/run", data=data, headers={"Referer": "/payroll/run"}, follow_redirects=True)


def test_s22_impossible_hours_are_refused(client, app):
    with app.app_context():
        db = get_db()
        emp = _employee(db)
        db.commit()
    assert "can&#39;t be below 0" in page(_run(client, emp, "-10"))
    assert "more than anyone can work" in page(_run(client, emp, "500"))
    assert "hours must be a number" in page(_run(client, emp, "abc"))
    assert "more than their normal 76" in page(_run(client, emp, "110"))
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM payruns").fetchone()[0] == 0
    _run(client, emp, "110", hours_checked="1")         # overtime, confirmed
    with app.app_context():
        assert get_db().execute("SELECT hours FROM payslips").fetchone()[0] == 110


def test_s23_run_payroll_opens_on_the_staff_frequency_and_next_period(client, app):
    with app.app_context():
        db = get_db()
        emp = _employee(db)                                # fortnightly
        db.commit()
    html = page(client.get("/payroll/run"))
    assert "<option selected>fortnightly</option>" in html and "No active weekly employees" not in html
    _run(client, emp, "76")
    html = page(client.get("/payroll/run"))
    assert 'name="period_start" value="2026-11-25"' in html and 'name="period_end" value="2026-12-08"' in html


# ------------------------------------------------------------------ F12 (the safe part)
def test_f12_australian_payroll_is_labelled_not_for_real_pay_runs(client, app):
    from tests.test_batch2 import _pdf_text
    with app.app_context():
        db = get_db()
        emp = _employee(db)
        db.commit()
    assert "not for real pay runs yet" in page(client.get("/payroll/run"))
    r = _run(client, emp, "76")
    assert "not for real pay runs yet" in page(r)                       # the pay run page
    with app.app_context():
        sid = get_db().execute("SELECT id FROM payslips").fetchone()[0]
    assert "not for real pay runs yet" in page(client.get(f"/payroll/payslip/{sid}"))
    assert "notforrealpayrunsyet" in _pdf_text(client.get(f"/payroll/payslip/{sid}?pdf=1").data)


# ------------------------------------------------------------------ S14, S15, S16, S17, S35, S43
def _inv_form(cust, lines, **extra):
    data = {"contact_id": cust, "date": "2026-11-20", "status": "open", **extra}
    for k in ("item", "description", "qty", "price", "discount", "account", "tax", "job"):
        data[f"line_{k}"] = [l.get(k, "") for l in lines]
    return data


def test_s14_typed_lines_default_to_gst_and_no_gst_is_warned(client, app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, _ = _contacts(db)
        db.commit()
    html = page(client.get("/sale/new"))
    assert f'<option value="{tc["GST"]}" selected>GST</option>' in html
    r = client.post("/sale/new", data=_inv_form(cust, [dict(description="Widget", qty="3", price="19.99",
                                                             account=acc["4-1000"], tax="")]), follow_redirects=True)
    assert "has no GST on it" in page(r)


def test_s15_s16_negative_and_non_numeric_lines_are_refused(client, app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, _ = _contacts(db)
        db.commit()
    r = client.post("/sale/new", data=_inv_form(cust, [dict(description="x", qty="-5", price="10", account=acc["4-1000"])]),
                    headers={"Referer": "/sale/new"}, follow_redirects=True)
    assert "can&#39;t be below $0. Create a credit note instead" in page(r)
    r = client.post("/sale/new", data=_inv_form(cust, [dict(description="x", qty="abc", price="10", account=acc["4-1000"])]),
                    headers={"Referer": "/sale/new"}, follow_redirects=True)
    assert "Line 1: quantity must be a number" in page(r)
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0


def test_s17_credit_note_reduces_balance_with_gst_applies_and_refunds(client, app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, _ = _contacts(db)
        db.commit()
    line = lambda price: [dict(description="Service", qty="1", price=price, account=acc["4-1000"], tax=tc["GST"])]
    client.post("/sale/new", data=_inv_form(cust, line("100")))
    assert "Credit note" in page(client.get("/sale/new?kind=credit"))
    r = client.post("/sale/new", data=_inv_form(cust, line("30"), kind="credit"), follow_redirects=True)
    assert "CN00001 saved" in page(r)
    with app.app_context():
        db = get_db()
        b = L.balances(db)
        assert b[acc["1-1200"]] == 11000 - 3300                          # the customer owes less
        assert b[acc["2-1310"]] == -(1000 - 300)                          # GST adjusted too
        cn = db.execute("SELECT * FROM documents WHERE kind='credit'").fetchone()
        inv = db.execute("SELECT * FROM documents WHERE kind='invoice'").fetchone()
    from tests.test_batch2 import _pdf_text
    assert "AdjustmentNote" in _pdf_text(client.get(f"/document/{cn['id']}?pdf=1").data)
    # apply $20 of it to the invoice, refund the other $13
    client.post(f"/credit/{cn['id']}/apply", data={"document_id": inv["id"], "amount": "20"})
    client.post(f"/credit/{cn['id']}/refund", data={"bank_account_id": acc["1-1110"], "date": "2026-11-21",
                                                   "amount": "13"})
    with app.app_context():
        db = get_db()
        inv = db.execute("SELECT * FROM documents WHERE id=?", (inv["id"],)).fetchone()
        cn = db.execute("SELECT * FROM documents WHERE id=?", (cn["id"],)).fetchone()
        assert inv["amount_paid"] == 2000 and cn["status"] == "paid"
        b = L.balances(db)
        assert b[acc["1-1200"]] == 11000 - 2000 == inv["total"] - inv["amount_paid"]
        assert b[acc["1-1110"]] == -1300


def test_s43_overpayment_leaves_customer_credit(client, app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, _ = _contacts(db)
        db.commit()
    client.post("/sale/new", data=_inv_form(cust, [dict(description="x", qty="1", price="60", account=acc["4-1000"],
                                                          tax=tc["N-T"])]))
    with app.app_context():
        inv = get_db().execute("SELECT id FROM documents").fetchone()[0]
    r = client.post("/sale/pay", data={"contact_id": cust, "bank_account_id": acc["1-1110"], "date": "2026-11-21",
                                       "amount": "100", f"alloc_{inv}": "60"}, follow_redirects=True)
    assert "$40.00 is kept as credit" in page(r)
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT status FROM documents WHERE id=?", (inv,)).fetchone()[0] == "paid"
        bal = db.execute("SELECT SUM(total-amount_paid) FROM documents WHERE contact_id=? AND status='open'",
                         (cust,)).fetchone()[0]
        assert bal == -4000 and L.balances(db)[acc["1-1200"]] == -4000      # Trade Debtors -$40 for them
    from tests.test_batch2 import _report
    ar = _report(app, "aged_receivables", asof="2026-11-30")
    assert ar["rows"][-1]["cells"][-1] == -4000
    # a later invoice uses the credit
    client.post("/sale/new", data=_inv_form(cust, [dict(description="y", qty="1", price="25", account=acc["4-1000"],
                                                          tax=tc["N-T"])]))
    with app.app_context():
        db = get_db()
        inv2 = db.execute("SELECT id FROM documents WHERE kind='invoice' ORDER BY id DESC").fetchone()[0]
        cr = db.execute("SELECT id FROM documents WHERE kind='payment_credit'").fetchone()[0]
    assert "Credit available" in page(client.get(f"/sale/pay?contact={cust}"))
    client.post(f"/credit/{cr}/apply", data={"document_id": inv2, "amount": "25"})
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT status FROM documents WHERE id=?", (inv2,)).fetchone()[0] == "paid"
        assert L.balances(db)[acc["1-1200"]] == -1500
    # a deposit before any invoice
    client.post("/sale/pay", data={"contact_id": cust, "bank_account_id": acc["1-1110"], "date": "2026-11-22",
                                   "amount": "50"})
    with app.app_context():
        assert L.balances(get_db())[acc["1-1200"]] == -6500


def test_s35_quotes_have_their_own_numbers_and_are_kept_when_converted(client, app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, _ = _contacts(db)
        db.commit()
    client.post("/sale/new", data=_inv_form(cust, [dict(description="x", qty="1", price="60", account=acc["4-1000"],
                                                          tax=tc["GST"])], status="quote"))
    with app.app_context():
        q = get_db().execute("SELECT * FROM documents").fetchone()
    assert q["number"] == "Q00001"
    r = client.post(f"/document/{q['id']}/convert", data={"to": "open"}, follow_redirects=True)
    assert "INV00001" in page(r) and "The quote is kept" in page(r)
    with app.app_context():
        db = get_db()
        q2 = db.execute("SELECT * FROM documents WHERE id=?", (q["id"],)).fetchone()
        inv = db.execute("SELECT * FROM documents WHERE number='INV00001'").fetchone()
        assert q2["status"] == "quote" and q2["converted_to"] == inv["id"] and inv["total"] == q2["total"] == 6600
        assert inv["reference"] == "Q00001"
    assert "Converted: open the" in page(client.get(f"/document/{q['id']}"))


def test_s15_booking_price_cannot_be_negative(tmp_path, monkeypatch):
    from tests.test_bookings_app import _jobs_setup, _book, _one
    app, c, _item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    r = _book(c, contact_id=cust, resource_id=staff, price="-50")
    assert "can&#39;t be below $0" in page(r)
    assert _one(app, "SELECT COUNT(*) n FROM bookings")["n"] == 0
