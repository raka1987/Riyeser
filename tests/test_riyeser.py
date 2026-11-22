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


def test_forgot_password_only_in_desktop_mode(tmp_path):
    for local in (False, True):
        app = create_app({"TESTING": True, "DATABASE": str(tmp_path / f"f{local}.db"), "LOCAL_RESET": local})
        with app.app_context():
            init_db("Co", "oldpw")
        c = app.test_client()
        page = c.get("/forgot").get_data(as_text=True)
        assert ("Set new password" in page) == local
        c.post("/forgot", data={"username": "admin", "password": "newpw", "confirm": "newpw"})
        r = c.post("/login", data={"username": "admin", "password": "newpw"})
        assert (r.status_code == 302) == local
        # a remote computer can never reset, even in desktop mode
        r = c.post("/forgot", data={"username": "admin", "password": "hack", "confirm": "hack"},
                   environ_base={"REMOTE_ADDR": "192.168.1.50"})
        assert c.post("/login", data={"username": "admin", "password": "hack"}).status_code == 200


def test_cli_reset_password(tmp_path):
    from riyeser.cli import main
    db = str(tmp_path / "c.db")
    main(["--db", db, "init", "--password", "orig"])
    main(["--db", db, "reset-password", "admin", "--password", "fresh"])
    app = create_app({"TESTING": True, "DATABASE": db})
    r = app.test_client().post("/login", data={"username": "admin", "password": "fresh"})
    assert r.status_code == 302


def test_basic_edition_menus_and_guard(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "b.db")})
    with app.app_context():
        init_db("Shop", "pw", "basic")
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "pw"})
    home = c.get("/").get_data(as_text=True)
    assert "Basic · Riyeser Group" in home and "Stock items" in home and "Run payroll" not in home
    # enterprise-only screens redirect to the dashboard
    for url in ("/payroll/", "/journal/new", "/banking/reconcile", "/setup/budgets"):
        r = c.get(url)
        assert r.status_code == 302 and r.location.endswith("/"), url
    assert c.get("/reports/inventory_valuation").status_code == 200
    assert c.get("/reports/trial_balance").status_code == 404
    reports = c.get("/reports/").get_data(as_text=True)
    assert "Inventory Valuation" in reports and "Payroll Activity" not in reports
    # invoicing still works in Basic
    assert c.get("/sale/new").status_code == 200
    # upgrade keeps data and unlocks everything
    with app.app_context():
        db = get_db()
        f = {k: v for k, v in dict(db.execute("SELECT * FROM company").fetchone()).items() if v is not None}
    f.update(edition="enterprise", gst_registered="1")
    c.post("/setup/company", data=f)
    assert c.get("/payroll/").status_code == 200


def test_migrates_old_company_file(tmp_path):
    import sqlite3
    path = tmp_path / "old.db"
    app = create_app({"TESTING": True, "DATABASE": str(path)})
    with app.app_context():
        init_db("Old Co", "pw")
    con = sqlite3.connect(path)  # simulate a file made before editions and POS existed
    con.executescript("ALTER TABLE company DROP COLUMN edition; DROP TABLE pos_sales;"
                      " DELETE FROM linked_accounts WHERE key LIKE 'pos_%';")
    con.commit(); con.close()
    app2 = create_app({"TESTING": True, "DATABASE": str(path)})
    c = app2.test_client()
    c.post("/login", data={"username": "admin", "password": "pw"})
    assert c.get("/").status_code == 200
    con = sqlite3.connect(path)
    assert con.execute("SELECT edition FROM company").fetchone()[0] == "enterprise"
    assert con.execute("SELECT COUNT(*) FROM linked_accounts WHERE key LIKE 'pos_%'").fetchone()[0] == 2


def _pos_setup(app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        item = db.execute("INSERT INTO items (sku, name, is_inventoried, income_account_id, expense_account_id,"
                          " asset_account_id, sell_price, sale_tax_code_id) VALUES ('CUP','Coffee cup',1,?,?,?,1000,?)",
                          (acc["4-1000"], acc["5-1000"], acc["1-1300"], tc["GST"])).lastrowid
        L.stock_adjust(db, item, "2026-01-01", 10, 400, "Opening")
        db.commit()
        return item, acc


def test_pos_cash_sale_receipt_and_void(client, app):
    item, acc = _pos_setup(app)
    assert "Coffee cup" in client.get("/pos/").get_data(as_text=True)
    # $10 ex GST -> $11 inc GST; 2 cups = $22, pay $50 cash
    r = client.post("/pos/sale", json={"method": "cash", "tendered": "50", "lines": [{"item_id": item, "qty": 2}]})
    d = r.get_json()
    assert d["ok"] and d["total"] == 2200 and d["change"] == 2800
    assert "TAX INVOICE" in client.get(d["receipt_url"]).get_data(as_text=True)
    with app.app_context():
        db = get_db()
        b = L.balances(db)
        assert b[linked(db, "pos_cash")] == 2200          # takings in the cash drawer
        assert b[acc["4-1000"]] == -2000 and b[acc["2-1310"]] == -200
        assert b[acc["5-1000"]] == 800                     # COGS 2 x $4
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (item,)).fetchone()[0] == 8
        assert db.execute("SELECT status FROM documents").fetchone()[0] == "paid"
        assert trial_balance_ok(db)
    summary = client.get("/pos/sales").get_data(as_text=True)
    assert "$22.00" in summary
    client.post(f"/pos/sale/{d['sale_id']}/void")
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (item,)).fetchone()[0] == 10
        assert L.balances(db).get(linked(db, "pos_cash"), 0) == 0
        assert trial_balance_ok(db)


def test_pos_rejects_bad_sales(client, app):
    item, _ = _pos_setup(app)
    r = client.post("/pos/sale", json={"method": "cash", "tendered": "5", "lines": [{"item_id": item, "qty": 1}]})
    assert r.status_code == 400 and "less than" in r.get_json()["error"]
    r = client.post("/pos/sale", json={"method": "card", "lines": []})
    assert r.status_code == 400
    r = client.post("/pos/sale", json={"method": "card", "lines": [{"item_id": item, "qty": 1, "discount_pct": 10}]})
    assert r.get_json()["total"] == 990
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM pos_sales").fetchone()[0] == 1


def test_pdfs_download_and_riyeser_folder(client, app, tmp_path, monkeypatch):
    from pypdf import PdfReader
    import io
    monkeypatch.setenv("RIYESER_DOCS", str(tmp_path / "Riyeser"))
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cid = db.execute("INSERT INTO contacts (kind, name, address) VALUES ('customer','Café Ōra & Co','1 Main St')").lastrowid
        doc = L.save_document(db, "sale", dict(contact_id=cid, date="2026-09-01", notes="Thanks – see you soon"),
                              [dict(description="Consulting — day rate", qty=2, unit_price=15000,
                                    account_id=acc["4-2000"], tax_code_id=tc["GST"])], "open")
        db.execute("UPDATE company SET auto_pdf=1")
        db.commit()
    r = client.get(f"/document/{doc}?pdf=1")
    assert r.status_code == 200 and r.mimetype == "application/pdf"
    text = PdfReader(io.BytesIO(r.data)).pages[0].extract_text()
    assert "Tax Invoice" in text and "INV00001" in text and "$330.00" in text
    client.post(f"/document/{doc}/save-pdf")
    saved = list((tmp_path / "Riyeser" / "Accounting" / "Invoices" / "2026").glob("*.pdf"))
    assert len(saved) == 1 and "INV00001" in saved[0].name
    assert client.get(f"/cards/statement/{cid}?pdf=1").mimetype == "application/pdf"
    # auto-save when a new invoice is posted from the screen
    client.post("/sale/new", data={"contact_id": cid, "date": "2026-09-02", "status": "open",
                                   "line_item": [""], "line_description": ["Widget"], "line_qty": ["1"],
                                   "line_price": ["10"], "line_discount": [""], "line_account": [acc["4-2000"]],
                                   "line_tax": [tc["GST"]], "line_job": [""]})
    assert len(list((tmp_path / "Riyeser" / "Accounting" / "Invoices" / "2026").glob("*.pdf"))) == 2


def test_import_payroll_payrun(client, app, tmp_path, monkeypatch):
    import json as _json
    monkeypatch.setenv("RIYESER_DOCS", str(tmp_path / "Riyeser"))
    inbox = tmp_path / "Riyeser" / "Inbox" / "Payroll"
    inbox.mkdir(parents=True)
    run = {"format": "riyeser.payrun.v1", "source": "Riyeser Payroll", "payrun_id": "W46", "pay_date": "2026-11-14",
           "employees": [{"name": "Iliesa", "gross": 650, "tax_withheld": 48, "employer_contribution": 65,
                          "other_deductions": 52, "net": 550},
                         {"name": "Ben", "gross": 500, "tax_withheld": 20, "employer_contribution": 50}]}
    (inbox / "2026-11-14 W46.json").write_text(_json.dumps(run))
    (inbox / "broken.json").write_text("{nope")
    page = client.get("/links/payroll").get_data(as_text=True)
    assert "W46" in page and "not valid JSON" in page and "$1,150.00" in page
    with app.app_context():
        db = get_db()
        acc, _ = ids(db)
    client.post("/links/payroll", data={"bank_account_id": acc["1-1110"], "name": "2026-11-14 W46.json"})
    with app.app_context():
        db = get_db()
        b = L.balances(db)
        assert b[linked(db, "wages")] == 115000
        assert b[linked(db, "super_expense")] == 11500
        assert b[acc["1-1110"]] == -(55000 + 48000)
        assert b[linked(db, "payg_payable")] == -(4800 + 2000 + 5200)
        assert trial_balance_ok(db)
    assert (inbox / "Imported" / "2026-11-14 W46.json").exists()
    # the same pay run cannot be imported twice
    (inbox / "again.json").write_text(_json.dumps(run))
    client.post("/links/payroll", data={"bank_account_id": acc["1-1110"], "name": "again.json"})
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM imported_payruns").fetchone()[0] == 1


def test_pos_restaurant_tables_kitchen_and_pay(client, app):
    item, acc = _pos_setup(app)
    client.post("/pos/mode", data={"mode": "restaurant"})
    page = client.get("/pos/").get_data(as_text=True)
    assert "Send to kitchen" in page and "Dine in" in page
    # dine-in needs a table
    r = client.post("/pos/order", json={"order_type": "dine_in", "lines": [{"item_id": item, "qty": 1}]})
    assert r.status_code == 400
    r = client.post("/pos/order", json={"order_type": "dine_in", "table_no": "7", "kitchen": True,
                                        "lines": [{"item_id": item, "qty": 2, "note": "no sugar"}]}).get_json()
    assert r["ok"]
    docket = client.get(r["docket_url"]).get_data(as_text=True)
    assert "TABLE 7" in docket and "no sugar" in docket
    open_orders = client.get("/pos/orders").get_json()
    assert len(open_orders) == 1 and open_orders[0]["total"] == 2200
    # add to the table's order, then pay the bill
    client.post("/pos/order", json={"id": r["id"], "order_type": "dine_in", "table_no": "7",
                                    "lines": [{"item_id": item, "qty": 3, "note": "no sugar"}]})
    d = client.post("/pos/sale", json={"order_id": r["id"], "order_type": "dine_in", "table_no": "7", "method": "card",
                                       "lines": [{"item_id": item, "qty": 3, "note": "no sugar"}]}).get_json()
    assert d["ok"] and d["total"] == 3300
    assert client.get("/pos/orders").get_json() == []
    with app.app_context():
        db = get_db()
        doc = db.execute("SELECT * FROM documents ORDER BY id DESC").fetchone()
        assert doc["reference"] == "POS Table 7"
        assert "no sugar" in db.execute("SELECT description FROM document_lines WHERE document_id=?",
                                        (doc["id"],)).fetchone()[0]


def test_pos_retail_park_and_cancel(client, app):
    item, _ = _pos_setup(app)
    page = client.get("/pos/").get_data(as_text=True)
    assert "Park sale" in page and "Coffee cup" in page
    r = client.post("/pos/order", json={"order_type": "retail", "lines": [{"item_id": item, "qty": 1}]}).get_json()
    assert len(client.get("/pos/orders").get_json()) == 1
    client.post(f"/pos/order/{r['id']}/cancel")
    assert client.get("/pos/orders").get_json() == []


def test_help_diagnostics_and_error_logging(client, app):
    assert "Riyeser POS" in client.get("/help/").get_data(as_text=True)
    dash = client.get("/").get_data(as_text=True)
    assert "/help/#start" in dash
    assert "/help/#pos" in client.get("/pos/sales").get_data(as_text=True)
    r = client.get("/help/diagnostics?download=1")
    d = r.get_json()
    assert d["checks"]["books_balance"] is True and d["edition"] == "enterprise" and d["version"]


def test_unexpected_error_is_logged_for_support(tmp_path):
    app = create_app({"DATABASE": str(tmp_path / "e.db")})
    with app.app_context():
        init_db("Co")

    @app.route("/boom")
    def boom():
        raise RuntimeError("kaboom")
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    r = c.get("/boom")
    assert r.status_code == 500 and "something went wrong" in r.get_data(as_text=True)
    errs = c.get("/help/diagnostics?download=1").get_json()["recent_errors"]
    assert errs and "kaboom" in errs[0]["details"]


def test_licence_status_from_central_file(tmp_path):
    import json
    from datetime import datetime, timedelta, timezone
    from riyeser.licence import status
    f = tmp_path / "licence.json"
    now = datetime(2026, 5, 1, tzinfo=timezone.utc)
    assert status(now, str(f))["mode"] == "unknown"  # no Riyeser Central yet: show nothing
    f.write_text(json.dumps({"trialStart": (now - timedelta(days=80)).isoformat()}))
    assert status(now, str(f)) == {"mode": "trial", "days_left": 10, "buy_url": "https://riyeser.com/pricing.html"}
    f.write_text(json.dumps({"trialStart": (now - timedelta(days=95)).isoformat()}))
    assert status(now, str(f))["mode"] == "expired"
    f.write_text(json.dumps({"trialStart": (now - timedelta(days=95)).isoformat(), "key": "K",
                             "licence": {"status": "active", "plan": "Riyeser · 5 users", "checkedAt": (now - timedelta(days=3)).isoformat()}}))
    assert status(now, str(f)) == {"mode": "licensed", "plan": "Riyeser · 5 users"}
