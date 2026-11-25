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


# ------------------------------------------------------------------ F13 + S54 + S55
def _stock_vs_gl(db):
    from riyeser.ledger import balances
    value = round(sum(r["qty_on_hand"] * r["avg_cost"] for r in db.execute("SELECT * FROM items WHERE is_inventoried=1")))
    gl = balances(db).get(db.execute("SELECT id FROM accounts WHERE code='1-1300'").fetchone()[0], 0)
    return value, gl


def _item(db, acc, sku, buy=0):
    return db.execute("INSERT INTO items (sku, name, is_inventoried, income_account_id, expense_account_id,"
                      " asset_account_id, sell_price, buy_price) VALUES (?,?,1,?,?,?,1000,?)",
                      (sku, sku, acc["4-1000"], acc["5-1000"], acc["1-1300"], buy)).lastrowid


def test_f13_stock_value_always_equals_the_inventory_account(client, app):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust, sup = _contacts(db)
        pump = _item(db, acc, "PUMP")

        def bill(item, qty, cost, account=None):
            return L.save_document(db, "purchase", dict(contact_id=sup, date="2026-11-01"),
                                   [dict(item_id=item, qty=qty, unit_price=cost, tax_code_id=tc["GST"],
                                         account_id=account)], "open")

        def sell(item, qty):
            return L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-02"),
                                   [dict(item_id=item, qty=qty, unit_price=1000, tax_code_id=tc["GST"])], "open")
        b5 = bill(pump, 10, 500)
        bill(pump, 10, 700)
        sell(pump, 5)
        L.stock_adjust(db, pump, "2026-11-03", -1, memo="Stocktake")        # count 14
        assert _stock_vs_gl(db) == (8400, 8400)
        # 1. void a bill after the average has blended: out at the bill's own $5
        L.void_document(db, b5)
        assert _stock_vs_gl(db) == (3400, 3400)
        # 2. sell before you buy, then buy
        hose = _item(db, acc, "HOSE")
        sell(hose, 2)
        bill(hose, 10, 500)
        assert _stock_vs_gl(db) == (7400, 7400)
        # 3. a stock item billed to an expense account still goes to Inventory
        bill(hose, 10, 500, account=acc["6-1500"])
        assert _stock_vs_gl(db) == (12400, 12400)
        # a bill whose stock has since been sold can't simply be voided
        tap = _item(db, acc, "TAP")
        bt = bill(tap, 2, 500)
        sell(tap, 1)
        db.commit()
        with pytest.raises(L.PostingError, match="already been sold"):
            L.void_document(db, bt)
        db.rollback()
        assert _stock_vs_gl(db) == (12900, 12900)
    # 4. a stocktake can't be negative
    r = client.post("/inventory/count", data={"date": "2026-11-04", f"count_{pump}": "-5"}, follow_redirects=True)
    assert "can&#39;t be below 0" in r.get_data(as_text=True)
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (pump,)).fetchone()[0] == 4
        assert _stock_vs_gl(db) == (12900, 12900)
    page = client.get("/reports/inventory_valuation").get_data(as_text=True)
    assert "doesn&#39;t match the Inventory account" not in page
    # S54: "not stocked" with stock on hand is refused
    r = client.post(f"/inventory/{pump}/edit", data={"sku": "PUMP", "name": "Pump", "active": "1"},
                    follow_redirects=True)
    assert "Stocktake it to 0 first" in r.get_data(as_text=True)
    with app.app_context():
        assert get_db().execute("SELECT is_inventoried FROM items WHERE id=?", (pump,)).fetchone()[0] == 1
    # S55: journals can't post to Inventory, Trade Debtors or Trade Creditors; GST only as a GST adjustment
    for code in ("1-1300", "1-1200", "2-1200"):
        r = client.post("/journal/new", data={"date": "2026-11-05", "memo": "x",
                                              "line_account": [str(acc[code]), str(acc["3-1000"])],
                                              "line_debit": ["300", ""], "line_credit": ["", "300"]},
                        follow_redirects=True)
        assert "can&#39;t post to the" in r.get_data(as_text=True)
    gst = {"date": "2026-11-05", "memo": "GST fix", "line_account": [str(acc["2-1310"]), str(acc["6-2000"])],
           "line_debit": ["10", ""], "line_credit": ["", "10"]}
    assert "can&#39;t post to the GST" in client.post("/journal/new", data=gst, follow_redirects=True).get_data(as_text=True)
    assert "recorded" in client.post("/journal/new", data=dict(gst, gst_adjustment="1"),
                                     follow_redirects=True).get_data(as_text=True)
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM journal_entries WHERE source_type='journal'").fetchone()[0] == 1
        assert _stock_vs_gl(db) == (12900, 12900)
        # the valuation report shows a red warning if they ever differ
        L.general_journal(db, "2026-11-05", "forced", [dict(account_id=acc["1-1300"], debit=500),
                                                       dict(account_id=acc["3-1000"], credit=500)])
        db.commit()
    assert "doesn&#39;t match the Inventory account" in client.get("/reports/inventory_valuation").get_data(as_text=True)
    # S55: the type of a linked account can't be changed
    r = client.post("/accounts/save", data={"id": acc["1-1200"], "code": "1-1200", "name": "Trade Debtors",
                                            "type": "expense", "active": "1"},
                    headers={"Referer": "/accounts"}, follow_redirects=True)
    assert "type can&#39;t be" in r.get_data(as_text=True)
    with app.app_context():
        assert get_db().execute("SELECT type FROM accounts WHERE code='1-1200'").fetchone()[0] == "asset"


# ------------------------------------------------------------------ F9
def test_f9_job_invoice_charges_a_stock_part_at_the_till_price(tmp_path, monkeypatch):
    from tests.test_bookings_app import _jobs_setup, _book, _one
    from riyeser.views.pos import _price_inc
    app, c, _item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    c.post("/bookings/setup", data={"mode": "jobs", "open": "07:00", "close": "18:00", "labour_rate": "120"})
    with app.app_context():
        db = get_db()
        gst = db.execute("SELECT id, rate FROM tax_codes WHERE code='GST'").fetchone()
        inc = db.execute("SELECT id FROM accounts WHERE code='4-1000'").fetchone()[0]
        pump = db.execute("INSERT INTO items (sku, name, sell_price, sale_tax_code_id, income_account_id) VALUES"
                          " ('PP240','Pressure pump 240V',64900,?,?)", (gst["id"], inc)).lastrowid
        till = _price_inc(db.execute("SELECT * FROM items WHERE id=?", (pump,)).fetchone(), gst["rate"])
        db.commit()
    assert till == 71390
    c.post("/bookings/job/new", data={"contact_id": cust, "title": "Pump", "billing": "time"})
    jid = _one(app, "SELECT id FROM booking_jobs")["id"]
    _book(c, job_id=jid, contact_id=cust, resource_id=staff)
    v = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    c.post(f"/bookings/{v}/part", data={"item_id": pump, "qty": "1"})
    c.post(f"/bookings/job/{jid}/invoice")
    line = _one(app, "SELECT * FROM document_lines WHERE item_id=?", (pump,))
    assert line["net_amount"] + line["tax_amount"] == till
    assert (line["net_amount"], line["tax_amount"]) == (64900, 6490)


# ------------------------------------------------------------------ F10
def test_f10_bank_statement_import_dropdowns_and_allocate(client, app):
    import io
    with app.app_context():
        acc, tc = ids(get_db())
    csv_text = "Date,Description,Amount\n2026-11-03,Officeworks,-55.00\n04/11/2026,Customer deposit,220.00\n"
    client.post("/banking/feed", data={"account_id": acc["1-1110"],
                                       "file": (io.BytesIO(csv_text.encode()), "statement.csv")},
                content_type="multipart/form-data")
    page = client.get(f"/banking/feed?account={acc['1-1110']}").get_data(as_text=True)
    assert "&lt;select" not in page
    with app.app_context():
        fid = get_db().execute("SELECT id FROM bank_feed_lines WHERE description='Officeworks'").fetchone()[0]
    assert f'<select name="account_id" form="f{fid}" required>' in page
    assert f'<select name="tax_code_id" form="f{fid}">' in page
    r = client.post(f"/banking/feed/{fid}/allocate", data={"account_id": acc["6-1500"], "tax_code_id": tc["GST"]},
                    follow_redirects=True)
    assert r.status_code == 200 and "Statement line allocated" in r.get_data(as_text=True)
    with app.app_context():
        db = get_db()
        eid = db.execute("SELECT entry_id FROM bank_feed_lines WHERE id=?", (fid,)).fetchone()[0]
        lines = {r["account_id"]: (r["debit"], r["credit"]) for r in
                 db.execute("SELECT * FROM journal_lines WHERE entry_id=?", (eid,))}
        assert lines[acc["6-1500"]] == (5000, 0) and lines[acc["1-1110"]] == (0, 5500)
    # allocating again is refused, not posted twice
    client.post(f"/banking/feed/{fid}/allocate", data={"account_id": acc["6-1500"]}, headers={"Referer": "/banking/feed"})
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM journal_entries WHERE source_type='spend'").fetchone()[0] == 1
