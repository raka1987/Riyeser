"""Low stock and reordering (purchase orders per supplier, receiving in parts, the till's warning) and quotes that
customers accept or decline (valid until, Expired, the list filters, invoice and Bookings job from an accepted quote)."""
from datetime import date, timedelta

import pytest

from riyeser import create_app
from riyeser.db import get_db, init_db
from riyeser import ledger as L
from tests.test_batch2 import _pdf_text
from tests.test_pos_app import make, _trial


@pytest.fixture
def app(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "s.db")})
    with app.app_context():
        init_db("Stock Co")
    return app


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return c


def one(app, sql, *args):
    with app.app_context():
        r = get_db().execute(sql, args).fetchone()
        return r[0] if r and len(r.keys()) == 1 else r


def setup_stock(app):
    """Two suppliers and three stocked items. Returns dict of ids."""
    with app.app_context():
        db = get_db()
        acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
        gst = db.execute("SELECT id FROM tax_codes WHERE code='GST'").fetchone()[0]
        ids = dict(gst=gst, acc=acc)
        ids["sup_a"] = db.execute("INSERT INTO contacts (kind, name, terms_days) VALUES ('supplier','Acme Wholesale',30)").lastrowid
        ids["sup_b"] = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Bolt Supplies')").lastrowid
        ids["cust"] = db.execute("INSERT INTO contacts (kind, name, address, phone) VALUES"
                                 " ('customer','Jo Smith','4 High St, Sampletown','0400 000 000')").lastrowid

        def item(sku, name, level, up_to=None, supplier=None, buy=500):
            return db.execute(
                "INSERT INTO items (sku, name, is_inventoried, sell_price, buy_price, income_account_id,"
                " expense_account_id, asset_account_id, sale_tax_code_id, purchase_tax_code_id, reorder_level,"
                " reorder_up_to, supplier_id) VALUES (?,?,1,1000,?,?,?,?,?,?,?,?,?)",
                (sku, name, buy, acc["4-1000"], acc["5-1000"], acc["1-1300"], gst, gst, level, up_to, supplier)).lastrowid
        ids["widget"] = item("W1", "Widget", 5, 20, ids["sup_a"])
        ids["gadget"] = item("G1", "Gadget", 4, None, None)     # no preferred supplier, no reorder-up-to
        ids["plenty"] = item("P1", "Plenty", 2, 10, ids["sup_a"])
        for iid, qty in ((ids["widget"], 3), (ids["plenty"], 50)):
            L.stock_adjust(db, iid, "2026-01-01", qty, 500, "Opening")
        # the gadget was last bought from Bolt, then mostly sold
        L.save_document(db, "purchase", dict(contact_id=ids["sup_b"], date="2026-02-01"),
                        [dict(item_id=ids["gadget"], qty=5, unit_price=400, tax_code_id=gst)], "open")
        L.save_document(db, "sale", dict(contact_id=ids["cust"], date="2026-02-02"),
                        [dict(item_id=ids["gadget"], qty=4, unit_price=1000, tax_code_id=gst)], "open")
        db.commit()
    return ids


# ---------------------------------------------------------------- low stock and ordering
def test_low_stock_suggests_quantities_and_suppliers(app, client):
    ids = setup_stock(app)
    from riyeser.views.reorder import low_stock
    with app.app_context():
        rows = {r["sku"]: r for r in low_stock(get_db())}
    assert set(rows) == {"W1", "G1"}                          # Plenty has 50 on hand
    assert rows["W1"]["suggested"] == 17                       # back up to 20 from 3
    assert rows["W1"]["order_supplier"] == ids["sup_a"] and rows["W1"]["preferred"]
    assert rows["G1"]["suggested"] == 7                        # no "up to": twice the reorder level (8) less 1 on hand
    assert rows["G1"]["order_supplier"] == ids["sup_b"] and not rows["G1"]["preferred"]  # last bought from
    page = client.get("/inventory/low-stock").get_data(as_text=True)
    assert "Low stock" in page and "Widget" in page and "Gadget" in page and "Plenty" not in page
    assert "Order these" in page and "Last bought from" in page
    assert "Low stock" in client.get("/inventory/").get_data(as_text=True)  # in the menu


def test_order_these_makes_one_purchase_order_per_supplier(app, client):
    ids = setup_stock(app)
    w, g_ = ids["widget"], ids["gadget"]
    r = client.post("/inventory/low-stock/order", data={"pick": [w, g_], f"qty_{w}": "17", f"supplier_{w}": ids["sup_a"],
                                                       f"qty_{g_}": "7", f"supplier_{g_}": ids["sup_b"]},
                    follow_redirects=True)
    page = r.get_data(as_text=True)
    assert "2 purchase orders made" in page
    with app.app_context():
        db = get_db()
        pos = db.execute("SELECT * FROM documents WHERE side='purchase' AND status='order' ORDER BY id").fetchall()
        assert [p["contact_id"] for p in pos] == [ids["sup_a"], ids["sup_b"]]
        assert all(p["number"].startswith("PO") and p["entry_id"] is None for p in pos)  # nothing posted yet
        l = db.execute("SELECT * FROM document_lines WHERE document_id=?", (pos[0]["id"],)).fetchone()
        assert l["item_id"] == w and l["qty"] == 17 and l["unit_price"] == 500
        assert db.execute("SELECT supplier_id FROM items WHERE id=?", (g_,)).fetchone()[0] == ids["sup_b"]  # remembered
        from riyeser.views.reorder import low_stock
        rows = {r["sku"]: r for r in low_stock(db)}
        assert rows["W1"]["on_order"] == 17 and rows["W1"]["suggested"] == 0  # already on order
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (w,)).fetchone()[0] == 3  # stock not in yet
    # the purchase order prints and emails like any other
    pdf = client.get(f"/document/{pos[0]['id']}?pdf=1")
    assert pdf.data[:4] == b"%PDF" and "PurchaseOrder" in _pdf_text(pdf.data)
    view = client.get(f"/document/{pos[0]['id']}").get_data(as_text=True)
    assert "Receive goods" in view and "Email it" in view


def test_order_needs_a_supplier_and_a_quantity(app, client):
    ids = setup_stock(app)
    w = ids["widget"]
    r = client.post("/inventory/low-stock/order", data={"pick": [w], f"qty_{w}": "5", f"supplier_{w}": ""},
                    follow_redirects=True)
    assert "Choose a supplier for Widget" in r.get_data(as_text=True)
    r = client.post("/inventory/low-stock/order", data={"pick": [w], f"qty_{w}": "", f"supplier_{w}": ids["sup_a"]},
                    follow_redirects=True)
    assert "how many Widget" in r.get_data(as_text=True)
    assert one(app, "SELECT COUNT(*) FROM documents WHERE status='order'") == 0


def _po(app, ids, qty=10):
    with app.app_context():
        db = get_db()
        po = L.save_document(db, "purchase", dict(contact_id=ids["sup_a"], date="2026-03-01"),
                             [dict(item_id=ids["widget"], qty=qty, unit_price=500, tax_code_id=ids["gst"]),
                              dict(description="Freight", qty=1, unit_price=2000, account_id=ids["acc"]["5-1100"]
                                   if "5-1100" in ids["acc"] else ids["acc"]["5-1000"], tax_code_id=ids["gst"])],
                             "order")
        db.commit()
        lines = [r[0] for r in db.execute("SELECT id FROM document_lines WHERE document_id=? ORDER BY id", (po,))]
    return po, lines


def test_receive_a_purchase_order_in_parts(app, client):
    ids = setup_stock(app)
    po, (wl, fl) = _po(app, ids)
    assert "Receive goods: PO" in client.get(f"/document/{po}/receive").get_data(as_text=True)
    # first delivery: 4 widgets, no freight yet
    r = client.post(f"/document/{po}/receive", data={"date": "2026-03-05", "reference": "INV-1", f"recv_{wl}": "4",
                                                     f"recv_{fl}": "0"}, follow_redirects=True)
    page = r.get_data(as_text=True)
    assert "and the stock is in" in page and "7 still to come" in page
    with app.app_context():
        db = get_db()
        bill = db.execute("SELECT * FROM documents WHERE source_document_id=?", (po,)).fetchone()
        assert bill["status"] == "open" and bill["reference"] == "INV-1" and bill["entry_id"]
        assert bill["subtotal"] == 2000
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (ids["widget"],)).fetchone()[0] == 7
        assert db.execute("SELECT status, received_at FROM documents WHERE id=?", (po,)).fetchone()[:] == ("order", None)
        from riyeser.views.reorder import on_order
        assert on_order(db)[ids["widget"]] == 6
    assert "Part received" in client.get("/purchase/list?status=order").get_data(as_text=True)
    # a part-received order can't be edited or converted the old way, and can't take more than is left
    assert "so it can&#39;t be changed" in client.get(f"/purchase/{po}/edit", follow_redirects=True).get_data(as_text=True)
    r = client.post(f"/document/{po}/convert", data={"to": "open"}, follow_redirects=True,
                    headers={"Referer": f"/document/{po}"})
    assert "already been received" in r.get_data(as_text=True)
    r = client.post(f"/document/{po}/receive", data={f"recv_{wl}": "9"}, follow_redirects=True)
    assert "only 6 still to come" in r.get_data(as_text=True)
    # the rest, at the price on the supplier's invoice
    r = client.post(f"/document/{po}/receive", data={"date": "2026-03-09", f"recv_{wl}": "6", f"price_{wl}": "5.50",
                                                     f"recv_{fl}": "1"}, follow_redirects=True)
    assert "fully received" in r.get_data(as_text=True)
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM documents WHERE source_document_id=?", (po,)).fetchone()[0] == 2
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (ids["widget"],)).fetchone()[0] == 13
        assert db.execute("SELECT received_at FROM documents WHERE id=?", (po,)).fetchone()[0]
        last = db.execute("SELECT subtotal FROM documents WHERE source_document_id=? ORDER BY id DESC", (po,)).fetchone()
        assert last[0] == 6 * 550 + 2000
        r = db.execute("SELECT SUM(debit) - SUM(credit) FROM journal_lines").fetchone()[0]
        assert r == 0
    lst = client.get("/purchase/list?status=order").get_data(as_text=True)
    assert "PO" not in lst.split("<table>")[1].split("</table>")[0] or "Nothing here" in lst  # finished: not in Orders
    assert "Received" in client.get("/purchase/list?status=all").get_data(as_text=True)


def test_voiding_a_receipt_puts_it_back_on_the_order_and_closing(app, client):
    ids = setup_stock(app)
    po, (wl, fl) = _po(app, ids)
    client.post(f"/document/{po}/receive", data={f"recv_{wl}": "10", f"recv_{fl}": "1"})
    bill = one(app, "SELECT id FROM documents WHERE source_document_id=?", po)
    assert one(app, "SELECT received_at FROM documents WHERE id=?", po)
    client.post(f"/document/{bill}/void")
    assert one(app, "SELECT status FROM documents WHERE id=?", bill) == "void"
    assert one(app, "SELECT received_at FROM documents WHERE id=?", po) is None
    assert one(app, "SELECT SUM(qty_received) FROM document_lines WHERE document_id=?", po) == 0
    assert one(app, "SELECT qty_on_hand FROM items WHERE id=?", ids["widget"]) == 3
    # part of it comes, the supplier can't send the rest: close the order
    client.post(f"/document/{po}/receive", data={f"recv_{wl}": "2"})
    r = client.post(f"/document/{po}/receive", data={"close": "1"}, follow_redirects=True)
    assert "is closed" in r.get_data(as_text=True)
    with app.app_context():
        from riyeser.views.reorder import on_order
        assert ids["widget"] not in on_order(get_db())
    # an order with goods received is kept (closed, not deleted)
    r = client.post(f"/document/{po}/delete", follow_redirects=True, headers={"Referer": f"/document/{po}"})
    assert "so it&#39;s kept" in r.get_data(as_text=True)


def test_a_whole_purchase_order_can_still_be_received_in_one_go(app, client):
    ids = setup_stock(app)
    po, (wl, fl) = _po(app, ids)
    r = client.post(f"/document/{po}/receive", data={f"recv_{wl}": "10", f"recv_{fl}": "1"}, follow_redirects=True)
    assert "fully received" in r.get_data(as_text=True)
    assert one(app, "SELECT qty_on_hand FROM items WHERE id=?", ids["widget"]) == 13


def test_till_warns_managers_about_low_stock_without_blocking(tmp_path, monkeypatch):
    app, c, coffee = make(tmp_path, monkeypatch, "pos")
    with app.app_context():
        db = get_db()
        db.execute("UPDATE items SET is_inventoried=1, reorder_level=2, asset_account_id="
                   "(SELECT id FROM accounts WHERE code='1-1300'), expense_account_id="
                   "(SELECT id FROM accounts WHERE code='5-1000') WHERE id=?", (coffee,))
        L.stock_adjust(db, coffee, date.today().isoformat(), 3, 100, "Opening")
        db.commit()
    assert "low on stock" not in c.get("/pos/").get_data(as_text=True)
    d = c.post("/pos/sale", json={"method": "card", "lines": [{"item_id": coffee, "qty": 1}]}).get_json()
    assert d["ok"] and d["low_stock"] == ["Coffee (2 left)"]
    assert "1 item is low on stock" in c.get("/pos/").get_data(as_text=True)
    assert c.get("/inventory/low-stock").status_code == 200            # part of Riyeser POS
    assert "Order these" not in c.get("/inventory/low-stock").get_data(as_text=True)  # ordering is Accounting's
    # a cashier (not a manager) sells on without the warning
    c.post("/users/save", data={"username": "cash", "password": "pw-staff1", "preset": "sales"})
    cashier = app.test_client()
    cashier.post("/login", data={"username": "cash", "password": "pw-staff1"})
    d = cashier.post("/pos/sale", json={"method": "card", "lines": [{"item_id": coffee, "qty": 1}]}).get_json()
    assert d["ok"] and d["low_stock"] == []
    assert "low on stock" not in cashier.get("/pos/").get_data(as_text=True)


def test_item_form_saves_reorder_up_to_and_preferred_supplier(app, client):
    ids = setup_stock(app)
    acc = ids["acc"]
    r = client.post("/inventory/new", data={"sku": "N1", "name": "New thing", "is_sold": "1", "is_bought": "1",
                                            "is_inventoried": "1", "sell_price": "10", "buy_price": "4",
                                            "asset_account_id": acc["1-1300"], "reorder_level": "3",
                                            "reorder_up_to": "12", "supplier_id": ids["sup_b"], "active": "1"})
    assert r.status_code == 302
    row = one(app, "SELECT reorder_up_to, supplier_id FROM items WHERE sku='N1'")
    assert tuple(row) == (12, ids["sup_b"])
    page = client.get(f"/inventory/{one(app, 'SELECT id FROM items WHERE sku=?', 'N1')}/edit").get_data(as_text=True)
    assert "Reorder up to" in page and "Preferred supplier" in page


# ---------------------------------------------------------------- quotes
def _quote(c, cust, item=None, valid="", qdate=None):
    with c.application.app_context():
        income = get_db().execute("SELECT id FROM accounts WHERE code='4-1000'").fetchone()[0]
    return c.post("/sale/new", data={"contact_id": cust, "date": qdate or date.today().isoformat(), "status": "quote",
                                     "valid_until": valid, "line_item": item or "", "line_description": "Paint the fence",
                                     "line_qty": "2", "line_price": "150", "line_discount": "", "line_account": income,
                                     "line_tax": "", "line_job": ""}, follow_redirects=True)


def _last_quote(app):
    return one(app, "SELECT id FROM documents WHERE status='quote' ORDER BY id DESC LIMIT 1")


def test_quotes_are_in_the_free_invoices_app_even_after_any_trial(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "invoices")
    _trial(tmp_path, 400)
    with app.app_context():
        cust = get_db().execute("INSERT INTO contacts (kind, name) VALUES ('customer','Jo')").lastrowid
        get_db().commit()
    assert "New quote" in c.get("/sale/list").get_data(as_text=True)
    assert "saved" in _quote(c, cust, item).get_data(as_text=True)
    q = _last_quote(app)
    page = c.get(f"/document/{q}").get_data(as_text=True)
    assert "Mark accepted" in page and "Declined" in page and "Valid until" in page
    c.post(f"/document/{q}/quote/accept", data={"accepted_name": "Jo", "source": "phone"})
    assert one(app, "SELECT quote_status FROM documents WHERE id=?", q) == "accepted"
    r = c.post(f"/document/{q}/convert", data={"to": "open"}, follow_redirects=True)
    assert "Converted" in r.get_data(as_text=True)          # Riyeser Invoices is free forever


def test_quote_valid_until_expired_and_the_list_filters(app, client):
    ids = setup_stock(app)
    today = date.today()
    _quote(client, ids["cust"])
    waiting = _last_quote(app)
    assert one(app, "SELECT valid_until FROM documents WHERE id=?", waiting) == (today + timedelta(days=30)).isoformat()
    _quote(client, ids["cust"], qdate=(today - timedelta(days=40)).isoformat(),
           valid=(today - timedelta(days=10)).isoformat())
    expired = _last_quote(app)
    _quote(client, ids["cust"])
    accepted = _last_quote(app)
    _quote(client, ids["cust"])
    declined = _last_quote(app)
    client.post(f"/document/{accepted}/quote/accept", data={"accepted_name": "Jo Smith", "source": "in_person"})
    client.post(f"/document/{declined}/quote/decline", data={"note": "Too dear"})
    nums = {i: one(app, "SELECT number FROM documents WHERE id=?", i) for i in (waiting, expired, accepted, declined)}

    def listed(qs):
        page = client.get(f"/sale/list?status=quote&qs={qs}").get_data(as_text=True)
        return {i for i, n in nums.items() if f"<b>{n}</b>" in page}
    assert listed("waiting") == {waiting}
    assert listed("expired") == {expired}
    assert listed("accepted") == {accepted}
    assert listed("declined") == {declined}
    allq = client.get("/sale/list?status=quote").get_data(as_text=True)
    assert "Expired" in allq and "Accepted" in allq and "Declined" in allq and "Waiting" in allq
    # who, when and the typed signature are kept
    row = one(app, "SELECT * FROM documents WHERE id=?", accepted)
    assert row["accepted_name"] == "Jo Smith" and row["accepted_source"] == "in_person" and row["quote_status_by"]
    assert row["quote_status_at"].startswith(today.isoformat())
    assert "Signed" in client.get(f"/document/{accepted}").get_data(as_text=True)
    # the quote PDF says how long it's valid
    text = _pdf_text(client.get(f"/document/{waiting}?pdf=1").data)
    assert "Validuntil" + (today + timedelta(days=30)).isoformat() in text
    assert "Accepted" in _pdf_text(client.get(f"/document/{accepted}?pdf=1").data)


def test_a_declined_quote_is_not_invoiced_by_mistake_and_undo(app, client):
    ids = setup_stock(app)
    _quote(client, ids["cust"])
    q = _last_quote(app)
    client.post(f"/document/{q}/quote/decline", data={})
    r = client.post(f"/document/{q}/convert", data={"to": "open"}, follow_redirects=True,
                    headers={"Referer": f"/document/{q}"})
    assert "was declined" in r.get_data(as_text=True)
    assert one(app, "SELECT converted_to FROM documents WHERE id=?", q) is None
    client.post(f"/document/{q}/quote/undo")
    assert one(app, "SELECT quote_status FROM documents WHERE id=?", q) is None
    assert client.post(f"/document/{q}/convert", data={"to": "open"}).status_code == 302
    assert one(app, "SELECT converted_to FROM documents WHERE id=?", q)


def test_online_acceptance_can_be_recorded(app, client):
    ids = setup_stock(app)
    _quote(client, ids["cust"])
    q = _last_quote(app)
    from riyeser.views.quotes import record_online_acceptance, state
    with app.app_context():
        db = get_db()
        assert record_online_acceptance(db, q, "Jo Smith", at="2026-11-20 09:00")
        row = db.execute("SELECT * FROM documents WHERE id=?", (q,)).fetchone()
        assert (row["accepted_source"], row["quote_status_by"], row["accepted_name"]) == ("accepted_online", "customer",
                                                                                           "Jo Smith")
        assert state(row) == "accepted"
        db.commit()
    assert "Online" in client.get(f"/document/{q}").get_data(as_text=True)


def test_accepted_quote_becomes_a_booking_job_and_its_invoice_has_the_quote_lines(app, client):
    ids = setup_stock(app)
    _quote(client, ids["cust"], ids["widget"])
    q = _last_quote(app)
    # not using Bookings yet: no job button
    client.post(f"/document/{q}/quote/accept", data={"accepted_name": "Jo Smith"})
    assert "Make a booking job" not in client.get(f"/document/{q}").get_data(as_text=True)
    with app.app_context():
        get_db().execute("INSERT INTO booking_resources (name) VALUES ('Staff 1')")
        get_db().commit()
    assert "Make a booking job" in client.get(f"/document/{q}").get_data(as_text=True)
    r = client.post(f"/document/{q}/quote/job", follow_redirects=True)
    assert "Job J-" in r.get_data(as_text=True)
    quote = one(app, "SELECT * FROM documents WHERE id=?", q)
    job = one(app, "SELECT * FROM booking_jobs WHERE id=?", quote["booking_job_id"])
    assert job["contact_id"] == ids["cust"] and job["address"] == "4 High St, Sampletown"
    assert job["phone"] == "0400 000 000" and job["price"] == quote["total"] and job["billing"] == "fixed"
    assert "2 x Paint the fence" in job["notes"] and quote["number"] in job["notes"]
    assert "already has job" in client.post(f"/document/{q}/quote/job", follow_redirects=True).get_data(as_text=True)
    # invoicing the job in Bookings uses the quote's own lines (the widgets come off the shelf), once
    r = client.post(f"/bookings/job/{job['id']}/invoice", follow_redirects=True)
    assert "Invoice made" in r.get_data(as_text=True)
    inv = one(app, "SELECT document_id FROM booking_jobs WHERE id=?", job["id"])
    assert one(app, "SELECT converted_to FROM documents WHERE id=?", q) == inv
    assert one(app, "SELECT total FROM documents WHERE id=?", inv) == quote["total"]
    assert one(app, "SELECT item_id FROM document_lines WHERE document_id=?", inv) == ids["widget"]
    assert one(app, "SELECT qty_on_hand FROM items WHERE id=?", ids["widget"]) == 1


def test_invoice_from_quote_first_then_job_is_already_billed(app, client):
    ids = setup_stock(app)
    with app.app_context():
        get_db().execute("INSERT INTO booking_resources (name) VALUES ('Staff 1')")
        get_db().commit()
    _quote(client, ids["cust"])
    q = _last_quote(app)
    client.post(f"/document/{q}/quote/accept", data={})
    client.post(f"/document/{q}/quote/job")
    jid = one(app, "SELECT booking_job_id FROM documents WHERE id=?", q)
    client.post(f"/document/{q}/convert", data={"to": "open"})
    inv = one(app, "SELECT converted_to FROM documents WHERE id=?", q)
    assert one(app, "SELECT document_id FROM booking_jobs WHERE id=?", jid) == inv   # not invoiced twice
    # and the other way round: job made after the invoice
    _quote(client, ids["cust"])
    q2 = _last_quote(app)
    client.post(f"/document/{q2}/convert", data={"to": "open"})                  # invoicing counts as accepted
    assert "Accepted" in client.get(f"/document/{q2}").get_data(as_text=True)
    client.post(f"/document/{q2}/quote/job")
    j2 = one(app, "SELECT booking_job_id FROM documents WHERE id=?", q2)
    assert one(app, "SELECT document_id FROM booking_jobs WHERE id=?", j2) == one(
        app, "SELECT converted_to FROM documents WHERE id=?", q2)


def test_a_waiting_quote_cant_become_a_job(app, client):
    ids = setup_stock(app)
    with app.app_context():
        get_db().execute("INSERT INTO booking_resources (name) VALUES ('Staff 1')")
        get_db().commit()
    _quote(client, ids["cust"])
    q = _last_quote(app)
    r = client.post(f"/document/{q}/quote/job", follow_redirects=True)
    assert "Mark" in r.get_data(as_text=True) and "accepted first" in r.get_data(as_text=True)


def test_demo_has_low_stock_a_part_received_order_and_quotes_in_every_state(tmp_path):
    from riyeser.demo import seed_demo
    from riyeser.views.quotes import state
    from riyeser.views.reorder import low_stock
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "d.db")})
    with app.app_context():
        init_db("Demo Co")
        db = get_db()
        seed_demo(db)
        assert {r["sku"] for r in low_stock(db)} >= {"HSG-400", "WSH-500"}
        assert db.execute("SELECT COUNT(*) FROM document_lines WHERE qty_received > 0").fetchone()[0] == 1
        quotes = db.execute("SELECT * FROM documents WHERE side='sale' AND status='quote'").fetchall()
        assert {state(q) for q in quotes} == {"waiting", "accepted", "declined", "expired"}
        r = db.execute("SELECT SUM(debit) - SUM(credit) FROM journal_lines").fetchone()[0]
        assert r == 0
