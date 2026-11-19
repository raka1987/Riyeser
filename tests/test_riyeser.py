import re
from datetime import date

import pytest

from riyeser import create_app
from riyeser.db import get_db, init_db, linked, to_cents
from riyeser import ledger as L
from riyeser.views.reports import gst_figures


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


def trial_balance_ok(db):
    r = db.execute("SELECT SUM(debit) d, SUM(credit) c FROM journal_lines").fetchone()
    return (r["d"] or 0) == (r["c"] or 0)


def test_money_parsing():
    assert to_cents("1,234.565") == 123457
    assert to_cents("$10") == 1000
    assert to_cents("") == 0
    with pytest.raises(ValueError):
        to_cents("abc")


def test_unbalanced_journal_rejected(app):
    with app.app_context():
        db = get_db()
        acc, _ = ids(db)
        with pytest.raises(L.PostingError):
            L.general_journal(db, "2026-08-01", "bad", [dict(account_id=acc["1-1110"], debit=100),
                                                        dict(account_id=acc["3-1000"], credit=99)])


def test_lock_date(app):
    with app.app_context():
        db = get_db()
        acc, _ = ids(db)
        db.execute("UPDATE company SET lock_date='2026-06-30'")
        with pytest.raises(L.PostingError):
            L.general_journal(db, "2026-06-30", "x", [dict(account_id=acc["1-1110"], debit=100),
                                                      dict(account_id=acc["3-1000"], credit=100)])


def test_invoice_with_inventory_payment_and_void(app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','C')").lastrowid
        sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','S')").lastrowid
        item = db.execute("INSERT INTO items (sku, name, is_inventoried, income_account_id, expense_account_id,"
                          " asset_account_id, sell_price) VALUES ('W','Widget',1,?,?,?,2000)",
                          (acc["4-1000"], acc["5-1000"], acc["1-1300"])).lastrowid
        # buy 10 @ $8 then 10 @ $12 -> avg $10
        for price in (800, 1200):
            L.save_document(db, "purchase", dict(contact_id=sup, date="2026-08-01"),
                            [dict(item_id=item, qty=10, unit_price=price, tax_code_id=tc["GST"])], "open")
        it = db.execute("SELECT * FROM items WHERE id=?", (item,)).fetchone()
        assert it["qty_on_hand"] == 20 and abs(it["avg_cost"] - 1000) < 1e-9
        inv = L.save_document(db, "sale", dict(contact_id=cust, date="2026-08-05"),
                              [dict(item_id=item, qty=5, unit_price=2000, tax_code_id=tc["GST"])], "open")
        doc = db.execute("SELECT * FROM documents WHERE id=?", (inv,)).fetchone()
        assert (doc["subtotal"], doc["tax_total"], doc["total"]) == (10000, 1000, 11000)
        b = L.balances(db)
        assert b[acc["1-1200"]] == 11000            # receivable
        assert b[acc["5-1000"]] == 5000             # COGS 5 x $10
        assert b[acc["1-1300"]] == 20000 - 5000     # inventory
        assert b[acc["2-1310"]] == -1000            # GST collected
        assert trial_balance_ok(db)
        # partial then full payment
        L.record_payment(db, "in", cust, acc["1-1110"], "2026-08-10", [(inv, 5000)])
        assert db.execute("SELECT status FROM documents WHERE id=?", (inv,)).fetchone()["status"] == "open"
        with pytest.raises(L.PostingError):
            L.record_payment(db, "in", cust, acc["1-1110"], "2026-08-11", [(inv, 7000)])  # overpay
        pid = L.record_payment(db, "in", cust, acc["1-1110"], "2026-08-11", [(inv, 6000)])
        assert db.execute("SELECT status FROM documents WHERE id=?", (inv,)).fetchone()["status"] == "paid"
        assert L.balances(db)[acc["1-1200"]] == 0
        # cannot void a paid invoice until payment voided
        with pytest.raises(L.PostingError):
            L.void_document(db, inv)
        L.void_payment(db, pid)
        L.void_payment(db, db.execute("SELECT id FROM payments WHERE id<>? AND voided=0", (pid,)).fetchone()["id"])
        L.void_document(db, inv)
        b = L.balances(db)
        assert b.get(acc["5-1000"], 0) == 0 and b[acc["1-1300"]] == 20000
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (item,)).fetchone()["qty_on_hand"] == 20
        assert trial_balance_ok(db)


def test_tax_inclusive_and_spend_money_and_bas(app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','C')").lastrowid
        L.save_document(db, "sale", dict(contact_id=cust, date="2026-08-05", tax_inclusive=True),
                        [dict(description="Service", qty=1, unit_price=11000, account_id=acc["4-2000"],
                              tax_code_id=tc["GST"])], "open")
        L.bank_transaction(db, "spend", acc["1-1110"], "2026-08-06",
                           [dict(account_id=acc["6-1600"], amount=2200, tax_code_id=tc["GST"]),
                            dict(account_id=acc["6-1100"], amount=500, tax_code_id=tc["FRE"])], payee="x")
        L.bank_transaction(db, "spend", acc["1-1110"], "2026-08-07",
                           [dict(account_id=acc["1-2100"], amount=3300, tax_code_id=tc["CAP"])], payee="pc")
        f = gst_figures(db, "2026-07-01", "2026-09-30")
        assert f["G1"] == 11000 and f["A1"] == 1000
        assert f["B1"] == 200 + 300
        assert f["G10"] == 3300
        assert f["G11"] == 2200 + 500
        assert trial_balance_ok(db)


def test_payroll_and_reversal(app):
    from riyeser.payroll_calc import compute_pay
    emp = dict(pay_basis="salary", annual_salary=to_cents(78000), std_hours=38, hourly_rate=0,
               tax_free_threshold=1, super_rate=12.0)
    p = compute_pay(emp, "fortnightly")
    assert p["gross"] == 300000
    assert p["super"] == 36000
    assert p["net"] == p["gross"] - p["tax"] and p["tax"] % 100 == 0
    # 2024-25 rates: 78k -> 4288 + 0.3*33000 = 14188 + medicare 1560 = 15748 /26 = 605.69 -> $606
    assert p["tax"] == 60600


def test_balance_sheet_balances_after_demo(tmp_path):
    from riyeser.demo import seed_demo
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "d.db")})
    with app.app_context():
        init_db("Demo")
        seed_demo(get_db())
        assert trial_balance_ok(get_db())
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    html = c.get("/reports/balance_sheet").get_data(as_text=True)
    assert "OUT OF BALANCE" not in html
    html = c.get("/reports/trial_balance").get_data(as_text=True)
    assert "OUT OF BALANCE" not in html


def test_web_flow_invoice_and_receive_payment(client, app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
    r = client.post("/cards/customer/new", data={"name": "Web Cust", "terms_days": "14", "active": "1"})
    assert r.status_code == 302
    cid = int(re.search(r"/cards/view/(\d+)", r.location).group(1))
    r = client.post("/sale/new", data={
        "contact_id": cid, "date": "2026-09-01", "status": "open",
        "line_item": ["", ""], "line_description": ["Consulting", ""], "line_qty": ["2", ""],
        "line_price": ["150", ""], "line_discount": ["", ""], "line_account": [acc["4-2000"], ""],
        "line_tax": [tc["GST"], ""], "line_job": ["", ""]})
    assert r.status_code == 302 and "/document/" in r.location
    doc_id = int(r.location.rsplit("/", 1)[1])
    page = client.get(f"/document/{doc_id}").get_data(as_text=True)
    assert "$330.00" in page
    r = client.post("/sale/pay", data={"contact_id": cid, "bank_account_id": acc["1-1110"], "date": "2026-09-05",
                                       f"alloc_{doc_id}": "330.00"})
    assert r.status_code == 302
    with app.app_context():
        assert get_db().execute("SELECT status FROM documents WHERE id=?", (doc_id,)).fetchone()["status"] == "paid"


def test_viewer_is_read_only(client, app):
    client.post("/users/save", data={"username": "v", "password": "pw", "role": "viewer"})
    c2 = app.test_client()
    c2.post("/login", data={"username": "v", "password": "pw"})
    assert c2.get("/").status_code == 200
    c2.post("/cards/customer/new", data={"name": "Nope", "active": "1"})
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) n FROM contacts WHERE name='Nope'").fetchone()["n"] == 0


def test_reconcile(client, app):
    with app.app_context():
        db = get_db()
        acc, _ = ids(db)
        L.general_journal(db, "2026-08-01", "cap", [dict(account_id=acc["1-1110"], debit=10000),
                                                    dict(account_id=acc["3-1000"], credit=10000)])
        db.commit()
        line = db.execute("SELECT id FROM journal_lines WHERE account_id=?", (acc["1-1110"],)).fetchone()["id"]
    r = client.post("/banking/reconcile", data={"account_id": acc["1-1110"], "statement_date": "2026-08-31",
                                                "statement_balance": "99.00", "line": [line]})
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) n FROM reconciliations").fetchone()["n"] == 0
    client.post("/banking/reconcile", data={"account_id": acc["1-1110"], "statement_date": "2026-08-31",
                                            "statement_balance": "100.00", "line": [line]})
    with app.app_context():
        assert get_db().execute("SELECT reconciliation_id FROM journal_lines WHERE id=?",
                                (line,)).fetchone()["reconciliation_id"]
