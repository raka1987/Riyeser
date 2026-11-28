"""Functional QA pass (feat/qa-apps): the books stay balanced and consistent through every kind of posting, with
synthetic data. Each test ends by checking the same invariants: every journal entry balances, the Trial Balance and
Balance Sheet balance, Profit & Loss agrees with the Balance Sheet's current-year earnings, Trade Debtors/Creditors
agree with the open documents and Inventory agrees with the stock on hand."""
import io
import json
from datetime import date, timedelta

import pytest

from riyeser import create_app
from riyeser.db import get_db, init_db, linked
from riyeser import ledger as L

TODAY = date.today().isoformat()


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.delenv("RIYESER_APP_EDITION", raising=False)
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "qa.db")})
    with app.app_context():
        init_db("QA Test Co")
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


def seed(db):
    acc, tc = ids(db)
    cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','Synthetic Customer')").lastrowid
    sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Synthetic Supplier')").lastrowid
    item = db.execute("INSERT INTO items (sku, name, is_inventoried, is_sold, is_bought, income_account_id,"
                      " expense_account_id, asset_account_id, sell_price, sale_tax_code_id, active)"
                      " VALUES ('W1','Widget',1,1,1,?,?,?,1000,?,1)",
                      (acc["4-1000"], acc["5-1000"], acc["1-1300"], tc["GST"])).lastrowid
    db.commit()
    return acc, tc, cust, sup, item


def books_consistent(db, asof=None, strict_stock=False):
    """The invariants every posting must keep. Returns a list of problems (empty = all good)."""
    from riyeser.views import reports as R
    asof = asof or TODAY
    bad = []
    for r in db.execute("SELECT entry_id, SUM(debit) d, SUM(credit) c FROM journal_lines GROUP BY entry_id"
                        " HAVING SUM(debit) != SUM(credit)"):
        bad.append(f"entry {r['entry_id']} out of balance {r['d']} vs {r['c']}")
    ar = L.account_balance(db, linked(db, "receivables"), asof)
    docs_ar = db.execute("SELECT COALESCE(SUM(total-amount_paid),0) FROM documents WHERE side='sale' AND"
                         " status='open' AND entry_id IS NOT NULL OR (side='sale' AND kind='payment_credit' AND"
                         " status='open')").fetchone()[0]
    if ar != docs_ar:
        bad.append(f"Trade Debtors {ar} != open sales documents {docs_ar}")
    ap = -L.account_balance(db, linked(db, "payables"), asof)
    docs_ap = db.execute("SELECT COALESCE(SUM(total-amount_paid),0) FROM documents WHERE side='purchase' AND"
                         " status='open' AND entry_id IS NOT NULL OR (side='purchase' AND kind='payment_credit' AND"
                         " status='open')").fetchone()[0]
    if ap != docs_ap:
        bad.append(f"Trade Creditors {ap} != open purchase documents {docs_ap}")
    inv = sum(v for k, v in L.balances(db, end=asof).items() if k in {
        r[0] for r in db.execute("SELECT DISTINCT asset_account_id FROM items WHERE is_inventoried=1")} | {
        linked(db, "inventory")})
    stock = round(db.execute("SELECT COALESCE(SUM(qty_on_hand*avg_cost),0) FROM items WHERE is_inventoried=1"
                             ).fetchone()[0])
    # average cost: each posting is rounded to the cent while the average isn't, so the two can differ by up to
    # half a cent per stock movement (APP-012 in the QA register); anything more is a real difference
    moves = db.execute("SELECT COUNT(*) FROM stock_movements").fetchone()[0]
    if abs(inv - stock) > (0 if strict_stock else max(1, moves / 2)):
        bad.append(f"Inventory account {inv} != stock value {stock}")
    from flask import current_app
    with current_app.test_request_context(f"/reports/x?asof={asof}&start={L.fy_start(db, asof)}&end={asof}"):
        p = R._params(db)
        tb = R.rpt_trial_balance(db, p)
        if "OUT OF BALANCE" in tb["subtitle"]:
            bad.append("Trial Balance out of balance")
        bs = R.rpt_balance_sheet(db, p)
        if "OUT OF BALANCE" in bs["subtitle"]:
            bad.append("Balance Sheet out of balance")
        pnl = R.rpt_pnl(db, p)
        net = [r for r in pnl["rows"] if r["cells"][0] == "Net Profit / (Loss)"][0]["cells"][1]
        ce = linked(db, "current_earnings")
        fys = L.fy_start(db, asof)
        accts = db.execute("SELECT id, type FROM accounts").fetchall()
        typ = {a["id"]: a["type"] for a in accts}
        cur = sum(-v for k, v in L.balances(db, start=fys, end=asof).items()
                  if typ.get(k) in R.INCOME + R.EXPENSE)
        if net != cur:
            bad.append(f"P&L net {net} != current year earnings {cur} (account {ce})")
    return bad


# ---------------------------------------------------------------- invoices, tax and rounding
def test_tax_rounding_is_per_line_and_total_is_the_sum(app):
    with app.app_context():
        db = get_db()
        acc, tc, cust, sup, item = seed(db)
        # three lines of $3.33 ex GST: GST 33.3c each rounds to 33c; total = 3 x (333 + 33)
        did = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY),
                              [dict(description="A", qty=1, unit_price=333, account_id=acc["4-2000"],
                                    tax_code_id=tc["GST"]) for _ in range(3)], "open")
        d = db.execute("SELECT * FROM documents WHERE id=?", (did,)).fetchone()
        assert (d["subtotal"], d["tax_total"], d["total"]) == (999, 99, 1098)
        # tax-inclusive: $1.05 inc GST -> GST 9.545c -> 10c (half up), net 95c
        did = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY, tax_inclusive=True),
                              [dict(description="B", qty=1, unit_price=105, account_id=acc["4-2000"],
                                    tax_code_id=tc["GST"])], "open")
        d = db.execute("SELECT * FROM documents WHERE id=?", (did,)).fetchone()
        assert (d["subtotal"], d["tax_total"], d["total"]) == (95, 10, 105)
        # discount: 3 x $9.99 less 12.5% = 26.22375 -> $26.22, GST $2.62
        did = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY),
                              [dict(description="C", qty=3, unit_price=999, discount_pct=12.5,
                                    account_id=acc["4-2000"], tax_code_id=tc["GST"])], "open")
        d = db.execute("SELECT * FROM documents WHERE id=?", (did,)).fetchone()
        assert (d["subtotal"], d["tax_total"], d["total"]) == (2622, 262, 2884)
        assert books_consistent(db) == []


def test_invoice_numbers_are_unique_and_a_typed_duplicate_is_refused(app):
    with app.app_context():
        db = get_db()
        acc, tc, cust, sup, item = seed(db)
        line = [dict(description="S", qty=1, unit_price=1000, account_id=acc["4-2000"])]
        a = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY), [dict(x) for x in line], "open")
        n1 = db.execute("SELECT number FROM documents WHERE id=?", (a,)).fetchone()[0]
        with pytest.raises(L.PostingError, match="already used"):
            L.save_document(db, "sale", dict(contact_id=cust, date=TODAY, number=n1), [dict(x) for x in line], "open")
        # a number typed ahead of the series is skipped by the series later
        nxt = "INV" + str(int(n1[3:]) + 1).zfill(5)
        L.save_document(db, "sale", dict(contact_id=cust, date=TODAY, number=nxt), [dict(x) for x in line], "open")
        c = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY), [dict(x) for x in line], "open")
        nums = [r[0] for r in db.execute("SELECT number FROM documents WHERE side='sale'")]
        assert len(nums) == len(set(nums)) == 3
        assert db.execute("SELECT number FROM documents WHERE id=?", (c,)).fetchone()[0] not in (n1, nxt)


def _invoice_form(cust, acc_id, price="50"):
    return {"contact_id": cust, "date": TODAY, "status": "open", "line_item": "", "line_description": "Service",
            "line_qty": "1", "line_price": price, "line_discount": "", "line_account": acc_id, "line_tax": "",
            "line_job": ""}


def test_double_submitting_the_new_invoice_form_makes_one_invoice(app, client):
    with app.app_context():
        db = get_db()
        acc, tc, cust, sup, item = seed(db)
    form = dict(_invoice_form(cust, acc["4-2000"]), _once="qa-token-1")
    r1 = client.post("/sale/new", data=form)
    r2 = client.post("/sale/new", data=form)          # the same form sent twice (double click, refresh)
    assert r1.status_code == r2.status_code == 302
    assert r1.headers["Location"] == r2.headers["Location"]
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM documents WHERE side='sale'").fetchone()[0] == 1
    # a new form (a new token) is a new invoice
    client.post("/sale/new", data=dict(form, _once="qa-token-2"))
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM documents WHERE side='sale'").fetchone()[0] == 2


def test_double_submitting_a_part_payment_records_it_once(app, client):
    with app.app_context():
        db = get_db()
        acc, tc, cust, sup, item = seed(db)
        did = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY),
                              [dict(description="S", qty=1, unit_price=10000, account_id=acc["4-2000"])], "open")
        db.commit()
        bank = linked(db, "default_bank")
    form = {"contact_id": cust, "bank_account_id": bank, "date": TODAY, f"alloc_{did}": "30", "amount": "",
            "_once": "qa-pay-1"}
    client.post("/sale/pay", data=form)
    client.post("/sale/pay", data=form)
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM payments").fetchone()[0] == 1
        assert db.execute("SELECT amount_paid FROM documents WHERE id=?", (did,)).fetchone()[0] == 3000
        assert books_consistent(db) == []


def test_a_failed_save_can_be_sent_again_with_the_same_form(app, client):
    with app.app_context():
        db = get_db()
        acc, tc, cust, sup, item = seed(db)
    bad = dict(_invoice_form(cust, acc["4-2000"]), contact_id="", _once="qa-token-x")
    client.post("/sale/new", data=bad)                 # refused: no customer
    client.post("/sale/new", data=dict(bad, contact_id=cust))   # fixed and sent again: saved
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM documents WHERE side='sale'").fetchone()[0] == 1


# ---------------------------------------------------------------- payments, credits
def test_partial_over_payments_credit_notes_and_refunds_keep_the_books_balanced(app):
    with app.app_context():
        db = get_db()
        acc, tc, cust, sup, item = seed(db)
        bank = linked(db, "default_bank")
        line = lambda p: [dict(description="S", qty=1, unit_price=p, account_id=acc["4-2000"], tax_code_id=tc["GST"])]
        a = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY), line(10000), "open")   # $110
        b = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY), line(5000), "open")    # $55
        L.record_payment(db, "in", cust, bank, TODAY, [(a, 4000)])                               # part
        assert db.execute("SELECT status, amount_paid FROM documents WHERE id=?", (a,)).fetchone()[:] == ("open", 4000)
        with pytest.raises(L.PostingError, match="exceeds"):
            L.record_payment(db, "in", cust, bank, TODAY, [(a, 7001)])                            # over the balance
        L.record_payment(db, "in", cust, bank, TODAY, [(a, 7000)], amount=9000)                   # overpaid by $20
        assert db.execute("SELECT status FROM documents WHERE id=?", (a,)).fetchone()[0] == "paid"
        pc = db.execute("SELECT * FROM documents WHERE kind='payment_credit'").fetchone()
        assert pc["total"] == -2000
        L.apply_credit(db, pc["id"], b, 1500)
        cn = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY, kind="credit"), line(1000), "open")
        assert db.execute("SELECT total FROM documents WHERE id=?", (cn,)).fetchone()[0] == -1100
        L.apply_credit(db, cn, b, 1100)
        L.refund_credit(db, pc["id"], bank, TODAY, 500)
        with pytest.raises(L.PostingError):
            L.refund_credit(db, pc["id"], bank, TODAY, 1)      # nothing left on it
        assert db.execute("SELECT total-amount_paid FROM documents WHERE id=?", (b,)).fetchone()[0] == 5500 - 2600
        assert books_consistent(db) == []
        # voiding the overpayment is refused while its credit is used
        pid = pc["payment_id"]
        with pytest.raises(L.PostingError):
            L.void_payment(db, pid)
        assert books_consistent(db) == []


def test_stock_sale_credit_note_and_void_keep_inventory_and_cogs_in_step(app):
    with app.app_context():
        db = get_db()
        acc, tc, cust, sup, item = seed(db)
        L.save_document(db, "purchase", dict(contact_id=sup, date=TODAY),
                        [dict(item_id=item, qty=3, unit_price=333, tax_code_id=tc["GST"])], "open")   # $3.33 each
        inv = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY),
                              [dict(item_id=item, qty=2, unit_price=1000, tax_code_id=tc["GST"])], "open")
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (item,)).fetchone()[0] == 1
        cn = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY, kind="credit"),
                             [dict(item_id=item, qty=1, unit_price=1000, tax_code_id=tc["GST"])], "open")
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (item,)).fetchone()[0] == 2
        assert books_consistent(db) == []
        L.void_document(db, cn)
        L.void_document(db, inv)
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (item,)).fetchone()[0] == 3
        assert books_consistent(db) == []


# ---------------------------------------------------------------- locked periods and year close
def test_locked_period_refuses_postings_voids_and_payments(app):
    with app.app_context():
        db = get_db()
        acc, tc, cust, sup, item = seed(db)
        bank = linked(db, "default_bank")
        old = "2025-03-01"
        did = L.save_document(db, "sale", dict(contact_id=cust, date=old),
                              [dict(description="S", qty=1, unit_price=1000, account_id=acc["4-2000"])], "open")
        db.execute("UPDATE company SET lock_date='2025-06-30'")
        db.commit()
        for fn in (lambda: L.save_document(db, "sale", dict(contact_id=cust, date=old),
                                           [dict(description="S", qty=1, unit_price=1, account_id=acc["4-2000"])],
                                           "open"),
                   lambda: L.void_document(db, did),
                   lambda: L.record_payment(db, "in", cust, bank, "2025-06-30", [(did, 1000)]),
                   lambda: L.bank_transaction(db, "spend", bank, old, [dict(account_id=acc["6-1500"], amount=100)])):
            with pytest.raises(L.PostingError, match="locked"):
                fn()
            db.rollback()   # as every screen does when a save is refused
        L.record_payment(db, "in", cust, bank, "2025-07-01", [(did, 1000)])   # after the lock: fine
        assert books_consistent(db) == []


def test_year_close_moves_last_years_profit_into_retained_earnings(app):
    with app.app_context():
        db = get_db()
        acc, tc, cust, sup, item = seed(db)
        db.execute("UPDATE company SET fy_start_month=7")
        L.save_document(db, "sale", dict(contact_id=cust, date="2025-05-01"),
                        [dict(description="Last year", qty=1, unit_price=50000, account_id=acc["4-2000"])], "open")
        L.save_document(db, "sale", dict(contact_id=cust, date="2025-08-01"),
                        [dict(description="This year", qty=1, unit_price=20000, account_id=acc["4-2000"])], "open")
        from flask import current_app
        from riyeser.views import reports as R
        with current_app.test_request_context("/reports/x?asof=2025-12-31"):
            p = R._params(db)
            tb = R.rpt_trial_balance(db, p)
            retained = [r for r in tb["rows"] if r["cells"][0] == "3-8000"]
            assert retained and retained[0]["cells"][3] == 50000           # credit: last year's profit
            sales = [r for r in tb["rows"] if r["cells"][0] == "4-2000"][0]
            assert sales["cells"][3] == 20000                              # this year's income only
        assert books_consistent(db, "2025-12-31") == []
        with current_app.test_request_context("/reports/x?asof=2025-06-30"):
            p = R._params(db)
            assert "OUT OF BALANCE" not in R.rpt_trial_balance(db, p)["subtitle"]
            assert "OUT OF BALANCE" not in R.rpt_balance_sheet(db, p)["subtitle"]


# ---------------------------------------------------------------- bank import
def test_bank_statement_imported_twice_adds_each_line_once(app, client):
    with app.app_context():
        bank = linked(get_db(), "default_bank")
    csv = "Date,Description,Amount\n01/11/2026,Coffee beans,-45.50\n02/11/2026,Customer deposit,120.00\n"
    for _ in range(2):
        client.post("/banking/feed", data={"account_id": bank, "file": (io.BytesIO(csv.encode()), "s.csv")},
                    content_type="multipart/form-data")
    overlap = csv + "03/11/2026,Rent,-800.00\n"
    r = client.post("/banking/feed", data={"account_id": bank, "file": (io.BytesIO(overlap.encode()), "s2.csv")},
                    content_type="multipart/form-data", follow_redirects=True)
    assert "2 were already imported" in r.get_data(as_text=True)
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM bank_feed_lines").fetchone()[0] == 3
        fid = db.execute("SELECT id FROM bank_feed_lines WHERE amount=-4550").fetchone()[0]
        acc, tc = ids(db)
    for _ in range(2):   # allocating the same line twice posts once
        client.post(f"/banking/feed/{fid}/allocate", data={"account_id": acc["6-1500"], "tax_code_id": tc["GST"]})
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM journal_entries WHERE source_type='spend'").fetchone()[0] == 1
        assert books_consistent(db) == []


# ---------------------------------------------------------------- payroll import
def test_payroll_import_balances_and_is_refused_the_second_time(app):
    from riyeser.views import links
    with app.app_context():
        db = get_db()
        raw = json.dumps({"format": "riyeser.payrun.v1", "payrun_id": "PR-QA-1", "pay_date": TODAY,
                          "currency": "AUD", "employees": [
                              {"name": "Synthetic A", "gross": "1000.00", "tax_withheld": "150.33",
                               "employer_contribution": "115.00", "other_deductions": "20.00", "net": "829.67"},
                              {"name": "Synthetic B", "gross": "523.45", "tax_withheld": "0",
                               "employer_contribution": "60.20", "net": "523.45"}]})
        pr = links.parse_payrun(raw)
        links.import_payrun(db, pr, linked(db, "default_bank"))
        with pytest.raises(L.PostingError, match="already been imported"):
            links.import_payrun(db, links.parse_payrun(raw), linked(db, "default_bank"))
        bad = json.loads(raw)
        bad["payrun_id"] = "PR-QA-2"
        bad["employees"][0]["net"] = "829.66"
        with pytest.raises(L.PostingError, match="doesn't equal"):
            links.parse_payrun(json.dumps(bad))
        fj = json.loads(raw)
        fj["payrun_id"], fj["currency"] = "PR-QA-3", "FJD"
        with pytest.raises(L.PostingError, match="FJD"):
            links.import_payrun(db, links.parse_payrun(json.dumps(fj)), linked(db, "default_bank"))
        assert books_consistent(db) == []


# ---------------------------------------------------------------- POS
@pytest.fixture
def pos(tmp_path, monkeypatch):
    monkeypatch.setenv("RIYESER_APP_EDITION", "pos")
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "pos.db")})
    with app.app_context():
        init_db("QA Shop")
        db = get_db()
        acc, tc = ids(db)
        sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Synthetic Supplier')").lastrowid
        item = db.execute("INSERT INTO items (sku, name, is_inventoried, is_sold, is_bought, income_account_id,"
                          " expense_account_id, asset_account_id, sell_price, sale_tax_code_id, active)"
                          " VALUES ('T1','Tea',1,1,1,?,?,?,302,?,1)",   # $3.02 ex GST -> $3.32 inc GST
                          (acc["4-1000"], acc["5-1000"], acc["1-1300"], tc["GST"])).lastrowid
        L.save_document(db, "purchase", dict(contact_id=sup, date=TODAY),
                        [dict(item_id=item, qty=10, unit_price=117, tax_code_id=tc["GST"])], "open")
        db.commit()
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return app, c, item


def test_pos_cash_card_split_refund_void_and_stock(pos):
    app, c, item = pos
    s1 = c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": 1000}],
                                   "lines": [{"item_id": item, "qty": 2}], "checkout_ref": "qa-1"}).get_json()
    assert s1["ok"] and s1["change"] == 1000 - s1["total"]
    again = c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": 1000}],
                                      "lines": [{"item_id": item, "qty": 2}], "checkout_ref": "qa-1"}).get_json()
    assert again["repeat"] and again["sale_id"] == s1["sale_id"]              # double tap: one sale
    short = c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": 100}],
                                      "lines": [{"item_id": item, "qty": 1}]}).get_json()
    assert not short["ok"]
    s2 = c.post("/pos/sale", json={"tenders": [{"method": "card", "amount": 300}, {"method": "cash", "tendered": 2000}],
                                   "lines": [{"item_id": item, "qty": 3}]}).get_json()
    assert s2["ok"]
    s3 = c.post("/pos/sale", json={"method": "card", "lines": [{"item_id": item, "qty": 1}]}).get_json()
    assert s3["ok"]
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (item,)).fetchone()[0] == 4
        assert db.execute("SELECT method FROM pos_sales WHERE id=?", (s2["sale_id"],)).fetchone()[0] == "split"
        assert books_consistent(db) == []
        lid = db.execute("SELECT id FROM document_lines WHERE document_id=(SELECT document_id FROM pos_sales"
                         " WHERE id=?)", (s2["sale_id"],)).fetchone()[0]
    r = c.post(f"/pos/sale/{s2['sale_id']}/refund", json={"lines": {str(lid): 1}, "method": "cash"}).get_json()
    assert r["ok"]
    assert not c.post(f"/pos/sale/{s2['sale_id']}/refund", json={"lines": {str(lid): 3}}).get_json()["ok"]
    for _ in range(2):
        assert c.post(f"/pos/sale/{s2['sale_id']}/refund", json={"lines": {str(lid): 1}, "method": "cash"}
                      ).get_json()["ok"]
    with app.app_context():
        db = get_db()
        refunded = db.execute("SELECT SUM(amount) FROM pos_refunds WHERE sale_id=?", (s2["sale_id"],)).fetchone()[0]
        assert refunded == s2["total"]                    # refunded one by one: exactly what was paid, to the cent
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (item,)).fetchone()[0] == 7
        assert books_consistent(db) == []
    c.post(f"/pos/sale/{s3['sale_id']}/void", data={"reason": "QA"})
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT voided FROM pos_sales WHERE id=?", (s3["sale_id"],)).fetchone()[0] == 1
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (item,)).fetchone()[0] == 8
        assert books_consistent(db) == []


def test_pos_refunds_one_at_a_time_never_return_more_than_the_line(pos):
    """A line of 3 at a price whose GST doesn't split evenly: refunding each unit separately must add up to the
    line exactly (no cent over or under)."""
    app, c, item = pos
    s = c.post("/pos/sale", json={"method": "card", "lines": [{"item_id": item, "qty": 3}]}).get_json()
    with app.app_context():
        db = get_db()
        line = db.execute("SELECT * FROM document_lines WHERE document_id=(SELECT document_id FROM pos_sales"
                          " WHERE id=?)", (s["sale_id"],)).fetchone()
    for _ in range(3):
        assert c.post(f"/pos/sale/{s['sale_id']}/refund", json={"lines": {str(line['id']): 1}}).get_json()["ok"]
    with app.app_context():
        db = get_db()
        r = db.execute("SELECT SUM(amount) a, SUM(tax) t FROM pos_refunds WHERE sale_id=?", (s["sale_id"],)).fetchone()
        assert (r["a"], r["t"]) == (line["net_amount"] + line["tax_amount"], line["tax_amount"])
        assert books_consistent(db) == []


# ---------------------------------------------------------------- quote -> invoice
def test_quote_converts_once(app, client):
    with app.app_context():
        db = get_db()
        acc, tc, cust, sup, item = seed(db)
        q = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY),
                            [dict(description="Q", qty=1, unit_price=1000, account_id=acc["4-2000"])], "quote")
        db.commit()
    for _ in range(2):
        client.post(f"/document/{q}/convert", data={"to": "open"})
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM documents WHERE side='sale' AND status='open'").fetchone()[0] == 1
        assert books_consistent(db) == []


# ---------------------------------------------------------------- the demo company: every kind of posting at once
def test_demo_company_books_are_consistent(app):
    from riyeser.demo import seed_demo
    with app.app_context():
        db = get_db()
        seed_demo(db)
        db.commit()
        kinds = {r[0] for r in db.execute("SELECT DISTINCT source_type FROM journal_entries")}
        assert {"invoice", "bill", "receipt", "payment"} <= kinds
        assert books_consistent(db) == []


# ---------------------------------------------------------------- bookings
def test_new_booking_sent_twice_is_saved_once(tmp_path, monkeypatch):
    from tests.test_pos_app import make
    app, c, _item = make(tmp_path, monkeypatch, "bookings")
    data = {"title": "Walk-in", "date": "2026-11-24", "time": "09:00", "minutes": "60", "status": "booked",
            "past_ok": "1", "_once": "qa-book-1"}
    c.post("/bookings/new", data=data)
    c.post("/bookings/new", data=data)
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM bookings").fetchone()[0] == 1


def test_a_booking_longer_than_a_day_still_blocks_the_staff_member(tmp_path, monkeypatch):
    from tests.test_pos_app import make
    app, c, _item = make(tmp_path, monkeypatch, "bookings")
    c.post("/bookings/setup/starters")
    with app.app_context():
        staff = get_db().execute("SELECT id FROM booking_resources").fetchone()[0]
    base = {"title": "Hire", "status": "booked", "past_ok": "1", "resource_id": staff}
    c.post("/bookings/new", data=dict(base, date="2026-12-01", time="08:00", minutes=str(3 * 24 * 60)))
    r = c.post("/bookings/new", data=dict(base, title="Clash", date="2026-12-03", time="10:00", minutes="60"),
               follow_redirects=True)
    assert "already has" in r.get_data(as_text=True)
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM bookings").fetchone()[0] == 1


# ---------------------------------------------------------------- estimate: markup vs margin
def test_online_booking_clash_sees_a_booking_that_started_days_earlier(app):
    from datetime import datetime
    from riyeser import online
    with app.app_context():
        db = get_db()
        rid = db.execute("INSERT INTO booking_resources (name) VALUES ('Excavator')").lastrowid
        db.execute("INSERT INTO bookings (resource_id, starts_at, minutes, status, title) VALUES"
                   " (?, '2026-12-01T08:00', ?, 'booked', 'Hire')", (rid, 5 * 24 * 60))
        assert online._clash(db, rid, datetime(2026, 12, 4, 9, 0), 60)
        assert not online._clash(db, rid, datetime(2026, 12, 6, 9, 0), 60)


def test_markup_is_on_cost_and_margin_is_on_the_selling_price():
    from riyeser.measure import engine
    lines = engine.build_lines({"name": "T"}, [
        {"id": 1, "section": "Labour", "description": "Job", "basis": "count", "unit": "each", "rate": 10000,
         "cost": 10000}], [{"kind": "count", "data": {"count": 1}, "label": "x"}])
    for l in lines:   # quote.price(): a 25% markup
        l["unit_price"] = int(round(l["unit_price"] * 1.25))
    p = engine.profit(lines)
    assert (p["sell"], p["cost"], p["profit"]) == (12500, 10000, 2500)
    assert p["margin_pct"] == 20.0          # 25% markup = 20% margin


# ---------------------------------------------------------------- bank import: identical lines in one file
def test_identical_lines_in_one_statement_are_all_kept_and_flagged(app, client):
    with app.app_context():
        bank = linked(get_db(), "default_bank")
    csv = ("Date,Description,Amount\n05/11/2026,Coffee,-4.50\n05/11/2026,Coffee,-4.50\n"
           "06/11/2026,Rent,-800.00\n")
    post = lambda: client.post("/banking/feed", data={"account_id": bank, "file": (io.BytesIO(csv.encode()), "s.csv")},
                               content_type="multipart/form-data", follow_redirects=True).get_data(as_text=True)
    page = post()
    assert "Imported 3 statement lines" in page and "2 lines look the same as another line" in page
    with app.app_context():
        rows = get_db().execute("SELECT amount, check_note FROM bank_feed_lines ORDER BY id").fetchall()
    assert [r["amount"] for r in rows] == [-450, -450, -80000]
    assert [bool(r["check_note"]) for r in rows] == [True, True, False]
    assert "Looks the same as another line" in client.get(f"/banking/feed?account={bank}").get_data(as_text=True)
    page = post()                                   # the same file again: nothing new
    assert "Imported 0 statement lines" in page and "3 were already imported" in page
    bigger = csv + "05/11/2026,Coffee,-4.50\n"       # a later statement with a third coffee that day: just that one
    client.post("/banking/feed", data={"account_id": bank, "file": (io.BytesIO(bigger.encode()), "s3.csv")},
                content_type="multipart/form-data")
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM bank_feed_lines").fetchone()[0] == 4


# ---------------------------------------------------------------- stock rounding (APP-012)
def _drifting_item(db):
    """Buy 3 at $10.00, sell 1, buy 1 at $10.01: the average is $10.00333 and each sale is rounded to $10.00, so
    selling the last 3 leaves 1c in the Inventory account with nothing on hand."""
    acc, tc, cust, sup, item = seed(db)
    buy = lambda p, q: L.save_document(db, "purchase", dict(contact_id=sup, date=TODAY),
                                       [dict(item_id=item, qty=q, unit_price=p)], "open")
    sell = lambda q: L.save_document(db, "sale", dict(contact_id=cust, date=TODAY),
                                     [dict(item_id=item, qty=q, unit_price=2000)], "open")
    buy(1000, 3)
    sell(1)
    buy(1001, 1)
    sell(1)
    sell(1)
    return item, sell


def test_cents_left_when_an_item_sells_out_are_cleared_to_stock_rounding(app):
    with app.app_context():
        db = get_db()
        item, sell = _drifting_item(db)
        assert not db.execute("SELECT 1 FROM journal_entries WHERE source_type='stock_rounding'").fetchone()
        sell(1)                                        # sold out
        e = db.execute("SELECT * FROM journal_entries WHERE source_type='stock_rounding'").fetchall()
        assert len(e) == 1 and "Stock rounding" in e[0]["memo"]
        lines = db.execute("SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.id=l.account_id"
                           " WHERE entry_id=? ORDER BY a.code", (e[0]["id"],)).fetchall()
        assert [tuple(r) for r in lines] == [("1-1300", 0, 1), ("5-1250", 1, 0)]
        assert db.execute("SELECT type FROM accounts WHERE code='5-1250'").fetchone()[0] == "cost_of_sales"
        assert db.execute("SELECT 1 FROM audit_log WHERE action='stock_rounding'").fetchone()
        assert books_consistent(db, strict_stock=True) == []


def test_stock_rounding_never_posts_in_a_locked_period(app):
    with app.app_context():
        db = get_db()
        _drifting_item(db)
        # 1 on hand at $10.00333 (value $10.00) and $10.01 in the account: 1c of rounding
        db.execute("UPDATE company SET lock_date=?", (TODAY,))
        assert L.settle_stock_rounding(db, TODAY, "test") == []
        db.execute("UPDATE company SET lock_date=NULL")
        assert len(L.settle_stock_rounding(db, TODAY, "test")) == 1


def test_a_bigger_stock_difference_is_left_alone_and_shown_as_a_warning(app, client):
    with app.app_context():
        db = get_db()
        item, sell = _drifting_item(db)
        db.execute("UPDATE items SET avg_cost=avg_cost+10 WHERE id=?", (item,))   # now 10c out (1 on hand)
        db.commit()
        assert L.settle_stock_rounding(db, TODAY, "test") == []
        db.commit()
    page = client.get("/reports/inventory_valuation").get_data(as_text=True)
    assert "doesn&#39;t match the Inventory account" in page or "doesn't match the Inventory account" in page


def test_stocktake_clears_small_rounding(app, client):
    with app.app_context():
        db = get_db()
        item, sell = _drifting_item(db)
        db.commit()
        gl, value = L.stock_value_gaps(db)[db.execute("SELECT asset_account_id FROM items WHERE id=?",
                                                      (item,)).fetchone()[0]]
        assert 0 < abs(gl - value) <= L.STOCK_ROUNDING_MAX
    client.post("/inventory/count", data={"date": TODAY, f"count_{item}": "1"})   # counted what's there
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM journal_entries WHERE source_type='stock_rounding'").fetchone()[0] == 1
        assert books_consistent(db, strict_stock=True) == []
