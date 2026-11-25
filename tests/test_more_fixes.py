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


# ------------------------------------------------------------------ S36, S44
def test_s36_payment_details_print_on_invoices_and_statements(client, app):
    from tests.test_batch2 import _pdf_text
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, _ = _contacts(db)
        db.commit()
        f = {k: v for k, v in dict(db.execute("SELECT * FROM company").fetchone()).items() if v is not None}
    f.update(bank_account_name="Test Co Pty Ltd", bank_bsb="062-000", bank_account_no="1234 5678",
             payment_instructions="Use the invoice number as the reference")
    client.post("/setup/company", data=f)
    client.post("/sale/new", data=_inv_form(cust, [dict(description="x", qty="1", price="60", account=acc["4-1000"],
                                                          tax=tc["GST"])]))
    with app.app_context():
        inv = get_db().execute("SELECT id FROM documents").fetchone()[0]
    text = _pdf_text(client.get(f"/document/{inv}?pdf=1").data)
    assert "Howtopay" in text and "BSB062-000" in text and "Account12345678" in text and "invoicenumberasthereference" in text
    assert "BSB062-000" in _pdf_text(client.get(f"/cards/statement/{cust}?pdf=1").data)
    assert "BSB 062-000" in page(client.get(f"/cards/statement/{cust}"))


def test_s44_activity_statement_with_ageing_overdue_and_all_customers(client, app):
    from tests.test_batch2 import _pdf_text
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, sup = _contacts(db)
        other = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','Zero Balance Ltd')").lastrowid
        line = [dict(description="x", qty=1, unit_price=10000, account_id=acc["4-1000"], tax_code_id=tc["N-T"])]
        L.save_document(db, "sale", dict(contact_id=cust, date="2026-09-01", due_date="2026-09-15"), line, "open")
        i2 = L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-03", due_date="2026-12-03"), line, "open")
        L.record_payment(db, "in", cust, acc["1-1110"], "2026-11-10", [(i2, 4000)])
        L.save_document(db, "purchase", dict(contact_id=sup, date="2026-11-05"),
                        [dict(description="y", qty=1, unit_price=500, account_id=acc["6-1500"], tax_code_id=tc["N-T"])],
                        "open")
        db.commit()
    html = page(client.get(f"/cards/statement/{cust}?start=2026-11-01&end=2026-11-30"))
    assert "Opening balance" in html and "$100.00" in html                  # September's invoice, carried in
    assert "Payment received" in html and "-$40.00" in html
    assert "Balance due at 2026-11-30" in html and "$160.00" in html
    assert "Overdue:" in html and "76 days" in html                         # ageing: 61-90 days
    assert html.count("$100.00") >= 2
    sup_html = page(client.get(f"/cards/statement/{sup}?start=2026-11-01&end=2026-11-30"))
    assert "Supplier" in sup_html and "Customer" not in sup_html
    allp = page(client.get("/cards/statements?start=2026-11-01&end=2026-11-30"))
    assert "C</td>" in allp and "Zero Balance Ltd" not in allp
    text = _pdf_text(client.get("/cards/statements?pdf=1&start=2026-11-01&end=2026-11-30").data)
    assert "Openingbalance" in text and "61–90DAYS" in text


# ------------------------------------------------------------------ S18 (email, with a fake SMTP server)
class FakeSMTP:
    sent = []
    fail = False

    def __init__(self, host, port, timeout=None, **kw):
        if FakeSMTP.fail:
            raise OSError("connection refused")
        self.host, self.port = host, port

    def starttls(self, context=None):
        pass

    def login(self, user, pw):
        self.user = user

    def send_message(self, m):
        FakeSMTP.sent.append(m)

    def quit(self):
        pass


@pytest.fixture
def smtp(monkeypatch):
    import smtplib
    FakeSMTP.sent, FakeSMTP.fail = [], False
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    return FakeSMTP


def _email_setup(client):
    client.post("/setup/email/", data={"smtp_host": "smtp.example.test", "smtp_port": "587", "smtp_security": "starttls",
                                       "smtp_user": "me", "smtp_password": "secret-pw", "smtp_from": "accounts@testco.test"})


def test_s18_email_invoice_quote_and_statements_with_pdf(client, app, smtp):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust = db.execute("INSERT INTO contacts (kind, name, email) VALUES ('customer','Nadi Traders','ap@nadi.test')"
                          ).lastrowid
        db.commit()
    client.post("/sale/new", data=_inv_form(cust, [dict(description="x", qty="1", price="60", account=acc["4-1000"],
                                                          tax=tc["GST"])]))
    with app.app_context():
        inv = get_db().execute("SELECT id FROM documents").fetchone()[0]
    r = client.post(f"/document/{inv}/email", data={}, headers={"Referer": f"/document/{inv}"}, follow_redirects=True)
    assert "Email isn&#39;t set up yet" in page(r)
    _email_setup(client)
    assert "Email" in page(client.get(f"/document/{inv}"))
    r = client.post(f"/document/{inv}/email", data={}, follow_redirects=True)
    assert "Emailed to ap@nadi.test" in page(r)
    m = smtp.sent[-1]
    assert m["To"] == "ap@nadi.test" and "Tax Invoice INV00001" in m["Subject"] and "accounts@testco.test" in m["From"]
    att = [p for p in m.iter_attachments()]
    assert att[0].get_filename().endswith(".pdf") and att[0].get_content()[:4] == b"%PDF"
    assert "$66.00" in m.get_body().get_content()
    # a quote
    client.post("/sale/new", data=_inv_form(cust, [dict(description="q", qty="1", price="10", account=acc["4-1000"],
                                                          tax=tc["GST"])], status="quote"))
    with app.app_context():
        q = get_db().execute("SELECT id FROM documents WHERE status='quote'").fetchone()[0]
    client.post(f"/document/{q}/email", data={})
    assert "Quote Q00001" in smtp.sent[-1]["Subject"]
    # statements: one, and all customers with a balance
    client.post(f"/cards/statement/{cust}/email", data={"start": "2026-11-01", "end": "2026-11-30"})
    assert "Statement" in smtp.sent[-1]["Subject"]
    n = len(smtp.sent)
    r = client.post("/cards/statements/email", data={"start": "2026-11-01", "end": "2026-11-30"}, follow_redirects=True)
    assert len(smtp.sent) == n + 1 and "emailed or queued for 1 customers" in page(r)
    # a server that's down: the email waits in the outbox, and goes when it's back
    smtp.fail = True
    r = client.post(f"/document/{inv}/email", data={}, follow_redirects=True)
    assert "Queued for ap@nadi.test" in page(r)
    assert "connection refused" in page(client.get("/setup/email/"))
    smtp.fail = False
    client.post("/setup/email/send")
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM email_queue WHERE status<>'sent'").fetchone()[0] == 0


# ------------------------------------------------------------------ S25, S40
def test_s25_till_asks_before_selling_stock_you_dont_have(tmp_path, monkeypatch):
    from tests.test_pos_app import make
    app, c, _coffee = make(tmp_path, monkeypatch, "pos")
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        pump = db.execute("INSERT INTO items (sku, name, is_sold, is_inventoried, sell_price, income_account_id,"
                          " expense_account_id, asset_account_id, sale_tax_code_id, buy_price) VALUES"
                          " ('P','Pump',1,1,1000,?,?,?,?,500)", (acc["4-1000"], acc["5-1000"], acc["1-1300"], tc["GST"])
                          ).lastrowid
        L.stock_adjust(db, pump, "2026-11-01", 15, 500)
        db.commit()
    sale = {"method": "card", "lines": [{"item_id": pump, "qty": 16}]}
    r = c.post("/pos/sale", json=sale)
    d = r.get_json()
    assert r.status_code == 409 and d["confirm_stock"] and "Only 15 Pump in stock" in d["error"] and "Sell anyway?" in d["error"]
    assert c.post("/pos/sale", json=dict(sale, sell_anyway=True)).get_json()["ok"]
    # an item set to never go below 0 is refused outright
    with app.app_context():
        db = get_db()
        db.execute("UPDATE items SET block_oversell=1 WHERE id=?", (pump,))
        db.commit()
    d = c.post("/pos/sale", json=dict(sale, sell_anyway=True)).get_json()
    assert not d["ok"] and not d["confirm_stock"] and "can&#39;t be sold below 0" not in d["error"]
    assert "can't be sold below 0" in d["error"]


def test_s40_invoice_warns_before_selling_stock_you_dont_have(client, app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, _ = _contacts(db)
        pump = db.execute("INSERT INTO items (sku, name, is_sold, is_inventoried, sell_price, income_account_id,"
                          " expense_account_id, asset_account_id, buy_price) VALUES ('P','Pump',1,1,1000,?,?,?,500)",
                          (acc["4-1000"], acc["5-1000"], acc["1-1300"])).lastrowid
        db.commit()
    form = _inv_form(cust, [dict(item=pump, description="Pump", qty="2", price="10", account=acc["4-1000"], tax=tc["GST"])])
    r = client.post("/sale/new", data=form, headers={"Referer": "/sale/new"}, follow_redirects=True)
    assert "Only 0 Pump in stock" in page(r)
    client.post("/sale/new", data=dict(form, sell_anyway="1"))
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (pump,)).fetchone()[0] == -2
        # and cost of sales is posted at the buy price, not $0 (F13)
        assert L.balances(db)[acc["5-1000"]] == 1000


# ------------------------------------------------------------------ S19, S20, S21
def test_s19_s20_s21_bookings_past_dates_unpriced_parts_and_follow_up_jobs(tmp_path, monkeypatch):
    from tests.test_bookings_app import _jobs_setup, _book, _one
    app, c, item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    c.post("/bookings/setup", data={"mode": "jobs", "open": "07:00", "close": "18:00", "labour_rate": "120"})
    # S19: a new booking in the past asks first
    r = _book(c, contact_id=cust, resource_id=staff, date="2025-01-01", past_ok="")
    assert "is in the past" in page(r) and _one(app, "SELECT COUNT(*) n FROM bookings")["n"] == 0
    _book(c, contact_id=cust, resource_id=staff, date="2025-01-01", past_ok="1")
    assert _one(app, "SELECT COUNT(*) n FROM bookings")["n"] == 1
    # S20: parts can't be negative, and unpriced parts are listed before invoicing
    c.post("/bookings/job/new", data={"contact_id": cust, "title": "Leak", "billing": "time"})
    jid = _one(app, "SELECT id FROM booking_jobs ORDER BY id DESC")["id"]
    _book(c, job_id=jid, contact_id=cust, resource_id=staff)
    v = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    r = c.post(f"/bookings/{v}/part", data={"description": "Washer", "qty": "1", "unit_price": "-20"},
               headers={"Referer": f"/bookings/{v}"}, follow_redirects=True)
    assert "can&#39;t be below $0" in page(r)
    c.post(f"/bookings/{v}/part", data={"description": "Tap", "qty": "1"})
    c.post(f"/bookings/{v}/time", data={"hours": "1"})
    r = c.post(f"/bookings/job/{jid}/invoice", headers={"Referer": f"/bookings/job/{jid}"}, follow_redirects=True)
    assert "Price these parts first, then invoice: Tap" in page(r)
    assert _one(app, "SELECT COUNT(*) n FROM documents")["n"] == 0
    tap = _one(app, "SELECT id FROM booking_materials WHERE description='Tap'")["id"]
    c.post(f"/bookings/job/{jid}/part-price", data={f"price_{tap}": "25"})
    c.post(f"/bookings/job/{jid}/invoice")
    assert _one(app, "SELECT total FROM documents")["total"] == 12000 + 2500
    # S21: a visit booked on the invoiced job goes on a follow-up job that can log work
    assert "Book a follow-up job" in page(c.get(f"/bookings/job/{jid}"))
    r = _book(c, job_id=jid, contact_id=cust, resource_id=staff, date="2026-12-10")
    assert "already invoiced, so this is on a new follow-up job" in page(r)
    nv = _one(app, "SELECT * FROM bookings ORDER BY id DESC")
    assert nv["job_id"] != jid
    assert _one(app, "SELECT title FROM booking_jobs WHERE id=?", (nv["job_id"],))["title"].startswith("Follow-up to J-")
    c.post(f"/bookings/{nv['id']}/time", data={"hours": "0.5"})
    assert _one(app, "SELECT COUNT(*) n FROM booking_time WHERE job_id=?", (nv["job_id"],))["n"] == 1


# ------------------------------------------------------------------ S52
def test_s52_gl_detail_defaults_to_this_month_and_long_lists_are_cut(client, app, monkeypatch):
    from datetime import date
    from riyeser.views import reports, banking
    with app.app_context():
        db = get_db()
        acc, _ = ids(db)
        for i in range(30):
            L.bank_transaction(db, "spend", acc["1-1110"], "2026-07-01" if i < 20 else date.today().isoformat(),
                               [dict(account_id=acc["6-1500"], amount=100 + i)], memo=f"Line {i}")
        db.commit()
    html = page(client.get("/reports/gl_detail"))
    assert f"{date.today().replace(day=1).isoformat()} to {date.today().isoformat()}" in html
    assert "Line 25" in html and "Line 5<" not in html                 # only this month by default
    monkeypatch.setattr(reports, "GL_DETAIL_MAX", 10)
    html = page(client.get("/reports/gl_detail?start=2026-07-01"))
    assert "the first 10 are shown" in html
    csv = page(client.get("/reports/gl_detail?start=2026-07-01&format=csv"))
    assert csv.count("Line ") == 60                                     # both sides of every line, all of them
    monkeypatch.setattr(banking, "RECONCILE_PAGE", 7)
    html = page(client.get(f"/banking/reconcile?account={acc['1-1110']}"))
    assert html.count('class="rl"') == 7 and "30 unreconciled transactions" in html


# ------------------------------------------------------------------ S53
def _unlabelled(html, within=None):
    """Form fields a screen reader can't name: no aria-label, no <label for=id>, not inside a <label>."""
    from html.parser import HTMLParser

    class P(HTMLParser):
        def __init__(self):
            super().__init__()
            self.fields, self.fors, self.depth, self.tpl = [], set(), 0, 0

        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            if tag == "template":
                self.tpl += 1
            if tag == "label":
                self.depth += 1
                if a.get("for"):
                    self.fors.add(a["for"])
            if tag in ("input", "select", "textarea") and a.get("type") not in ("hidden", "submit", "button") \
                    and not self.tpl:
                self.fields.append((a, self.depth > 0))

        def handle_endtag(self, tag):
            if tag == "label":
                self.depth -= 1
            if tag == "template":
                self.tpl -= 1
    p = P()
    p.feed(html)
    return [a.get("name") for a, in_label in p.fields
            if not in_label and not a.get("aria-label") and a.get("id") not in p.fors]


def test_s53_invoice_payment_and_login_fields_have_labels(client, app):
    with app.app_context():
        db = get_db()
        cust, _ = _contacts(db)
        acc, tc = ids(db)
        L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-20"),
                        [dict(description="x", qty=1, unit_price=100, account_id=acc["4-1000"])], "open")
        db.commit()
    assert _unlabelled(page(app.test_client().get("/login"))) == []
    html = page(client.get("/sale/new"))
    assert 'aria-label="Line 1 description"' in html and 'aria-label="Line 3 tax code"' in html
    main = html[html.index('<form method="post" id="doc-form"'):]
    assert _unlabelled(main) == []
    pay = page(client.get(f"/sale/pay?contact={cust}"))
    assert _unlabelled(pay[pay.index('<form method="post" id="pay-form"'):]) == []


# ------------------------------------------------------------------ S24
def _import(client, bank, text, **form):
    return client.post("/banking/feed", data={"account_id": bank, "file": (io.BytesIO(text.encode()), "s.csv"), **form},
                       content_type="multipart/form-data", follow_redirects=True)


def test_s24_statement_import_layouts_duplicates_skipped_rows_and_matching(client, app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, _ = _contacts(db)
        inv = L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-01"),
                              [dict(description="x", qty=1, unit_price=22000, account_id=acc["4-1000"],
                                    tax_code_id=tc["N-T"])], "open")
        L.record_payment(db, "in", cust, acc["1-1110"], "2026-11-04", [(inv, 22000)])
        db.commit()
    bank = acc["1-1110"]
    # CommBank: date, amount, description, balance, no header
    cba = "03/11/2026,-55.00,OFFICEWORKS 123,1000.00\n05/11/2026,+220.00,TRANSFER FROM C,1220.00\n"
    r = _import(client, bank, cba)
    assert "Imported 2 statement lines" in page(r)
    # the same file again: nothing doubled
    assert "2 were already imported" in page(_import(client, bank, cba))
    # Debit/Credit columns, "(40.00)", a bad row reported
    dc = "Date,Narrative,Debit,Credit\n06/11/2026,Bank fee,(4.00),\n07/11/2026,Interest,,1.25\nxx,Broken,1,\n"
    r = _import(client, bank, dc)
    assert "Imported 2 statement lines" in page(r) and "row 4: the date" in page(r)
    # US dates, chosen once and remembered for the account
    us = "Date,Description,Amount\n11/08/2026,Coffee,-4.50\n"
    _import(client, bank, us, date_order="mdy")
    with app.app_context():
        db = get_db()
        got = {r["description"]: (r["date"], r["amount"]) for r in db.execute("SELECT * FROM bank_feed_lines")}
        assert got["OFFICEWORKS 123"] == ("2026-11-03", -5500) and got["Bank fee"] == ("2026-11-06", -400)
        assert got["Interest"] == ("2026-11-07", 125) and got["Coffee"] == ("2026-11-08", -450)
        fid = db.execute("SELECT id FROM bank_feed_lines WHERE description='TRANSFER FROM C'").fetchone()[0]
        pay_line = db.execute("SELECT l.id FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id"
                              " WHERE e.source_type='receipt' AND l.account_id=?", (bank,)).fetchone()[0]
    # the $220 deposit is the customer's payment already recorded: matched, not posted again
    html = page(client.get(f"/banking/feed?account={bank}"))
    assert "Match #" in html
    client.post(f"/banking/feed/{fid}/match", data={"line_id": pay_line})
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM journal_entries WHERE source_type='receive'").fetchone()[0] == 0
        assert L.balances(db)[bank] == 22000
    # and it comes ticked on Reconcile
    rec = page(client.get(f"/banking/reconcile?account={bank}&date=2026-11-30"))
    assert f'value="{pay_line}" data-amt="22000" onchange="recUpd()" checked' in rec and "on statement" in rec


# ------------------------------------------------------------------ F3 (README wording)
def test_f3_readme_has_the_90_day_trial_wording_and_no_old_caps_or_prices():
    from pathlib import Path
    text = (Path(__file__).parent.parent / "README.md").read_text()
    assert "first 50 invoices" not in text and "first 500 sales" not in text and "50 invoices" not in text
    assert "Free for 90 days" in text and "US$" not in text


# ------------------------------------------------------------------ M items
def _setup_sale(app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, sup = _contacts(db)
        db.commit()
    return acc, tc, cust, sup


def test_m2_huge_amounts_are_checked_first(client, app):
    acc, tc, cust, _ = _setup_sale(app)
    form = _inv_form(cust, [dict(description="x", qty="1", price="99999999999", account=acc["4-1000"], tax=tc["GST"])])
    r = client.post("/sale/new", data=form, headers={"Referer": "/sale/new"}, follow_redirects=True)
    assert "far more than this business" in page(r)
    client.post("/sale/new", data=dict(form, amount_checked="1"))
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1


def test_m10_after_the_trial_a_typed_invoice_is_kept_as_a_quote(client, app, monkeypatch):
    from riyeser.views import documents as D
    acc, tc, cust, _ = _setup_sale(app)
    monkeypatch.setattr(D, "_free_invoices_capped", lambda db: True)
    r = client.post("/sale/new", data=_inv_form(cust, [dict(description="x", qty="1", price="5", account=acc["4-1000"],
                                                             tax=tc["GST"])]), follow_redirects=True)
    assert "saved as quote Q00001" in page(r)
    with app.app_context():
        assert get_db().execute("SELECT status FROM documents").fetchone()[0] == "quote"


def test_m11_m12_gst_detail_and_last_year(app):
    from tests.test_batch2 import _report
    from riyeser.views.reports import year_back
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        L.general_journal(db, "2026-11-02", "Capital", [dict(account_id=acc["1-1110"], debit=498500, tax_code_id=tc["N-T"]),
                                                       dict(account_id=acc["3-1000"], credit=498500, tax_code_id=tc["N-T"])])
        db.commit()
    rep = _report(app, "gst_detail", start="2026-11-01", end="2026-11-30")
    assert all(r["cells"][0] != "N-T" for r in rep["rows"])
    assert year_back("2028-07-01") == "2027-07-01" and year_back("2028-02-29") == "2027-02-28"


def test_m13_bills_have_their_own_prefix_and_purchase_orders_keep_po(client, app):
    acc, tc, _cust, sup = _setup_sale(app)
    with app.app_context():
        db = get_db()
        line = [dict(description="x", qty=1, unit_price=100, account_id=acc["6-1500"])]
        b = L.save_document(db, "purchase", dict(contact_id=sup, date="2026-11-20"), line, "open")
        po = L.save_document(db, "purchase", dict(contact_id=sup, date="2026-11-20"), line, "order")
        num = lambda i: db.execute("SELECT number FROM documents WHERE id=?", (i,)).fetchone()[0]
        assert num(b) == "BILL00001" and num(po) == "PO00001"
        L.convert_document(db, po, "open")
        assert num(po) == "BILL00002"


def test_m14_stock_adjustment_needs_a_cost_and_counts_must_be_numbers(client, app):
    acc, tc, _c, _s = _setup_sale(app)
    with app.app_context():
        db = get_db()
        bolt = db.execute("INSERT INTO items (sku, name, is_inventoried, asset_account_id) VALUES ('BOLT','Bolt',1,?)",
                          (acc["1-1300"],)).lastrowid
        db.commit()
    r = client.post(f"/inventory/{bolt}/adjust", data={"date": "2026-11-20", "qty": "5"},
                    headers={"Referer": f"/inventory/{bolt}"}, follow_redirects=True)
    assert "enter a unit cost" in page(r)
    r = client.post("/inventory/count", data={"date": "2026-11-20", f"count_{bolt}": "ten"},
                    headers={"Referer": "/inventory/count"}, follow_redirects=True)
    assert "Count for BOLT must be a number" in page(r)


def test_m17_m19_payment_date_and_account_are_checked(client, app):
    acc, tc, cust, _ = _setup_sale(app)
    with app.app_context():
        db = get_db()
        inv = L.save_document(db, "sale", dict(contact_id=cust, date="2026-09-01"),
                              [dict(description="x", qty=1, unit_price=1000, account_id=acc["4-1000"])], "open")
        db.commit()
    base = {"contact_id": cust, "bank_account_id": acc["1-1110"], "date": "2026-01-01", f"alloc_{inv}": "10"}
    r = client.post("/sale/pay", data=base, headers={"Referer": "/sale/pay"}, follow_redirects=True)
    assert "is before the date of INV00001" in page(r)
    r = client.post("/sale/pay", data=dict(base, date="2026-09-05", bank_account_id=acc["4-1000"]),
                    headers={"Referer": "/sale/pay"}, follow_redirects=True)
    assert "Choose a bank or credit card account" in page(r)
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM payments").fetchone()[0] == 0
    client.post("/sale/pay", data=dict(base, date_ok="1"))
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM payments").fetchone()[0] == 1


def test_m18_lock_date_changes_are_recorded(client, app):
    with app.app_context():
        db = get_db()
        f = {k: v for k, v in dict(db.execute("SELECT * FROM company").fetchone()).items() if v is not None}
    client.post("/setup/company", data=dict(f, lock_date="2026-09-30"))
    client.post("/setup/company", data=dict(f, lock_date=""))
    with app.app_context():
        log = [r[0] for r in get_db().execute("SELECT details FROM audit_log WHERE action='lock_date' ORDER BY id")]
    assert log == ["Lock date changed from (none) to 30/09/2026 by admin",
                   "Lock date changed from 30/09/2026 to (none) by admin"]


def test_m22_long_lists_say_they_stop_at_500(client, app, monkeypatch):
    acc, tc, cust, _ = _setup_sale(app)
    with app.app_context():
        db = get_db()
        for i in range(501):
            db.execute("INSERT INTO documents (side, status, number, contact_id, date) VALUES ('sale','open',?,?,'2026-11-01')",
                       (f"X{i}", cust))
        db.commit()
    assert "Showing the latest 500" in page(client.get("/sale/list"))


def test_m23_m24_duplicate_codes_and_journal_and_bank_account_checks(client, app):
    acc, tc, _c, _s = _setup_sale(app)
    r = client.post("/accounts/save", data={"code": "1-1110", "name": "Another", "type": "asset"},
                    headers={"Referer": "/accounts"}, follow_redirects=True)
    assert r.status_code == 200 and "Code 1-1110 is already used by Business Cheque Account" in page(r)
    client.post("/inventory/new", data={"sku": "W1", "name": "Widget", "active": "1"})
    r = client.post("/inventory/new", data={"sku": "w1", "name": "Other", "active": "1"},
                    headers={"Referer": "/inventory/new"}, follow_redirects=True)
    assert "SKU w1 is already used by Widget" in page(r)
    j = lambda dr, cr: {"date": "2026-11-05", "memo": "x", "line_account": [str(acc["6-1500"]), str(acc["3-1000"])],
                        "line_debit": [dr, ""], "line_credit": [cr, "100"]}
    assert "either a debit or a credit" in page(client.post("/journal/new", data=j("100", "5"), headers={"Referer": "/journal/new"}, follow_redirects=True))
    assert "enter positive amounts" in page(client.post("/journal/new", data=j("-100", ""), headers={"Referer": "/journal/new"}, follow_redirects=True))
    with app.app_context():
        db = get_db()
        L.general_journal(db, "2026-11-05", "cash in", [dict(account_id=acc["1-1110"], debit=5000),
                                                       dict(account_id=acc["3-1000"], credit=5000)])
        db.commit()
    form = {"id": acc["1-1110"], "code": "1-1110", "name": "Business Cheque Account", "type": "asset"}
    r = client.post("/accounts/save", data=form, headers={"Referer": "/accounts"}, follow_redirects=True)
    assert "This bank account has $50.00 in it" in page(r)
    client.post("/accounts/save", data=dict(form, confirm_unbank="1"))
    with app.app_context():
        assert get_db().execute("SELECT is_bank FROM accounts WHERE id=?", (acc["1-1110"],)).fetchone()[0] == 0


# ------------------------------------------------------------------ M5, M6, M28
def test_m5_tiles_have_different_letters():
    from riyeser.views.pos import tile_labels
    rows = [dict(id=1, name="Flat White", sku="FW1"), dict(id=2, name="Filtered water tap", sku="TAP-220"),
            dict(id=3, name="Muffin", sku="")]
    t = tile_labels(rows)
    assert len(set(t.values())) == 3 and t[3] == "M" and t[1] == "FW1" and t[2] == "TAP-2"


def test_m6_clash_keeps_the_typed_booking_and_overlaps_sit_side_by_side(tmp_path, monkeypatch):
    from tests.test_bookings_app import _jobs_setup, _book, _one
    app, c, item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    _book(c, contact_id=cust, resource_id=staff, date="2026-12-01", time="10:00")
    r = _book(c, contact_id=cust, resource_id=staff, date="2026-12-01", time="10:30", title="Second job")
    html = page(r)
    assert html.count("already has") == 1 and 'value="10:30"' in html and 'value="Second job"' in html
    _book(c, contact_id=cust, resource_id=staff, date="2026-12-01", time="10:30", allow_overlap="1")
    cal = page(c.get("/bookings/?d=2026-12-01"))
    assert "width:calc((100% - 8px) / 2 - 3px)" in cal


def test_m28_free_items_big_quantities_and_cash_and_barcodes(tmp_path, monkeypatch):
    from tests.test_pos_app import make
    app, c, coffee = make(tmp_path, monkeypatch, "pos")
    free = {"method": "card", "lines": [{"item_id": coffee, "qty": 1, "discount_pct": 100}]}
    d = c.post("/pos/sale", json=free).get_json()
    assert not d["ok"] and d["reason_key"] == "reason"
    assert c.post("/pos/sale", json=dict(free, reason="Staff meal")).get_json()["ok"]
    big = {"method": "card", "lines": [{"item_id": coffee, "qty": 1000000}]}
    d = c.post("/pos/sale", json=big).get_json()
    assert not d["ok"] and d["confirm_key"] == "confirm_big"
    cash = {"method": "cash", "tendered": 1000000, "lines": [{"item_id": coffee, "qty": 1}]}
    d = c.post("/pos/sale", json=cash).get_json()
    assert not d["ok"] and "Change of $999,995.60" in d["error"]
    assert c.post("/pos/sale", json=dict(cash, confirm_big=True)).get_json()["ok"]
    # barcodes: several per item, and the till matches them
    with app.app_context():
        sku = get_db().execute("SELECT sku, name FROM items WHERE id=?", (coffee,)).fetchone()
    c.post(f"/inventory/{coffee}/edit", data={"sku": sku["sku"], "name": sku["name"], "is_sold": "1", "active": "1",
                                             "barcodes": "9300601123456, 9300601999999"})
    with app.app_context():
        from riyeser.views.pos import _items
        it = next(i for i in _items(get_db())[0] if i["id"] == coffee)
    assert it["barcodes"] == ["9300601123456", "9300601999999"]
    assert "(i.barcodes||[]).includes(q)" in page(c.get("/pos/"))


# ------------------------------------------------------------------ S51
def test_s51_booking_reminders_queued_the_day_before_or_a_prepared_email(tmp_path, monkeypatch, smtp):
    from datetime import date, timedelta
    from riyeser import mailer
    from tests.test_bookings_app import _jobs_setup, _book, _one
    app, c, item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    with app.app_context():
        db = get_db()
        db.execute("UPDATE contacts SET email='guest@coral.test' WHERE id=?", (cust,))
        db.commit()
    day = (date.today() + timedelta(days=5)).isoformat()
    # no email set up: the booking offers a prepared email to send yourself
    _book(c, contact_id=cust, resource_id=staff, date=day, time="10:00")
    bid = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    html = page(c.get(f"/bookings/{bid}"))
    assert "mailto:guest%40coral.test?subject=Reminder" in html and "opens your email program" in html
    # with email set up: the reminder is queued for 9am the day before, and a Send reminder button sends now
    _email_setup(c)
    _book(c, contact_id=cust, resource_id=staff, date=day, time="14:00")
    bid2 = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    q = _one(app, "SELECT * FROM email_queue WHERE kind='booking_reminder' AND ref_id=?", (bid2,))
    assert q["to_addr"] == "guest@coral.test" and q["send_after"].startswith(
        (date.today() + timedelta(days=4)).isoformat() + " 09:00") and "To confirm, just reply" in q["body"]
    with app.app_context():
        db = get_db()
        assert mailer.send_pending(db) == (0, 0)                                       # not due yet
        assert mailer.send_pending(db, now=f"{day} 08:00:00") == (1, 0)                # due: sent
    assert "Reminder:" in smtp.sent[-1]["Subject"] and "14:00" in smtp.sent[-1]["Subject"]
    assert "Send reminder</button>" in page(c.get(f"/bookings/{bid}"))
    r = c.post(f"/bookings/{bid}/remind", follow_redirects=True)
    assert "Emailed to guest@coral.test" in page(r) and "10:00" in smtp.sent[-1]["Subject"]


def test_version_is_the_same_in_the_package_and_pyproject():
    import re
    from pathlib import Path
    import riyeser
    toml = (Path(__file__).parent.parent / "pyproject.toml").read_text()
    assert re.search(r'^version = "(.+)"', toml, re.M).group(1) == riyeser.__version__
