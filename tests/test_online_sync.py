"""Riyeser online connections on the PC: post-box items filed in the company file (every kind, once only, test items
never touching the books), the local-only API Riyeser Central uses, and what's published (catalogue, stock, free
times across time zones, working hours and existing bookings)."""
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from riyeser import create_app
from riyeser import online as O
from riyeser.db import get_db, init_db
from riyeser import ledger as L
from riyeser.views.online import token, local_api_file, write_local_api, remove_local_api


@pytest.fixture
def app(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "o.db")})
    with app.app_context():
        init_db("Online Co")
        db = get_db()
        acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
        gst = db.execute("SELECT id FROM tax_codes WHERE code='GST'").fetchone()[0]
        db.execute("INSERT INTO items (sku, name, is_inventoried, sell_price, buy_price, income_account_id,"
                   " expense_account_id, asset_account_id, sale_tax_code_id) VALUES ('MUG-1','Mug',1,1000,400,?,?,?,?)",
                   (acc["4-1000"], acc["5-1000"], acc["1-1300"], gst))
        db.execute("INSERT INTO items (sku, name, is_inventoried, sell_price, income_account_id, sale_tax_code_id,"
                   " block_oversell) VALUES ('RARE','Rare thing',1,5000,?,?,1)", (acc["4-1000"], gst))
        db.execute("INSERT INTO items (sku, name, sell_price, income_account_id, sale_tax_code_id, category)"
                   " VALUES ('GIFT','Gift card',2000,?,?,'Gifts')", (acc["4-1000"], gst))
        db.execute("INSERT INTO items (sku, name, sell_price, income_account_id) VALUES ('BAD SKU','Spaced',100,?)",
                   (acc["4-1000"],))
        L.stock_adjust(db, db.execute("SELECT id FROM items WHERE sku='MUG-1'").fetchone()[0], "2026-01-01", 10, 400,
                       "Opening")
        db.execute("UPDATE company SET bookings_mode='appointments', currency='FJD'")
        db.execute("INSERT INTO booking_resources (name, kind) VALUES ('Ana','staff')")
        db.execute("INSERT INTO booking_resources (name, kind) VALUES ('Ben','staff')")
        db.execute("INSERT INTO booking_services (name, minutes, price) VALUES ('Haircut', 30, 4500)")
        db.execute("INSERT INTO contacts (kind, name, email, phone) VALUES ('customer','Jo Smith','jo@example.com',"
                   "'+679 123 4567')")
        O.save_settings(db, dict(timezone="Pacific/Fiji", hours={d: "09:00-17:00" for d in O.WEEKDAYS}))
        db.commit()
    return app


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return c


def api(app, method, path, body=None, **headers):
    c = app.test_client()
    with app.app_context():
        h = {"X-Riyeser-Token": token(app), **headers}
    return getattr(c, method)(f"/online/api/{path}", json=body, headers=h)


def one(app, sql, *args):
    with app.app_context():
        r = get_db().execute(sql, args).fetchone()
        return r[0] if r is not None and len(r.keys()) == 1 else r


def item(kind, payload, test=False, **kw):
    return dict(id=kw.pop("id", None) or str(uuid.uuid4()), kind=kind, test=test, source=kw.pop("source", "api"),
                key_name="Shop", attempts=0, created_at="2026-11-27T01:00:00.000Z", payload=payload)


def file(app, *items):
    r = api(app, "post", "import", {"items": list(items)})
    assert r.status_code == 200, r.get_data(as_text=True)
    res = r.get_json()["results"]
    return res[0] if len(res) == 1 else res


FJ = ZoneInfo("Pacific/Fiji")


def next_local(hour, minute=0, days=2, tz=FJ):
    d = datetime.now(tz).date() + timedelta(days=days)
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=tz)


def booking(start, **kw):
    p = {"service": "SVC-1", "start": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
         "customer": {"name": "Mere Tui", "email": "mere@example.com", "phone": "+679 999 0000"}}
    p.update(kw)
    return p


# ---------------------------------------------------------------- the local API
def test_local_api_needs_the_token_and_refuses_browsers(app):
    c = app.test_client()
    assert c.get("/online/api/status").status_code == 401
    assert c.get("/online/api/status", headers={"X-Riyeser-Token": "nope"}).status_code == 401
    r = api(app, "get", "status")
    assert r.status_code == 200 and r.get_json()["company"] == "Online Co"
    assert api(app, "get", "status", Origin="https://evil.example").status_code == 403
    assert api(app, "get", "status", **{"Sec-Fetch-Site": "cross-site"}).status_code == 403
    r = app.test_client().get("/online/api/status", headers={"X-Riyeser-Token": token(app)},
                              environ_base={"REMOTE_ADDR": "192.168.1.20"})
    assert r.status_code == 403   # only this PC


def test_local_api_file_is_written_and_removed(app):
    with app.app_context():
        f = write_local_api(app, 5123, "Riyeser Bookings")
        assert f == local_api_file(app)
        info = json.load(open(f))
        assert info["port"] == 5123 and info["token"] == token(app) and info["program"] == "Riyeser Bookings"
        remove_local_api(app)
    import os
    assert not os.path.exists(f)


def test_demo_mode_never_takes_online_items(tmp_path, monkeypatch):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "d.db"), "DEMO_MODE": True,
                      "NORMAL_DATABASE": str(tmp_path / "real.db")})
    r = api(app, "post", "import", {"items": [item("enquiry", {"customer": {"name": "A", "email": "a@b.co"},
                                                                 "message": "hi"})]})
    assert r.status_code == 409 and r.get_json()["error"] == "demo"


# ---------------------------------------------------------------- bookings
def test_booking_is_filed_with_customer_found_by_email(app):
    start = next_local(10)
    r = file(app, item("booking", booking(start, customer={"name": "Jo", "email": "JO@example.com"}, notes="Short")))
    assert r["outcome"] == "done" and r["result"]["state"] == "pending" and r["result"]["reference"].startswith("BK-")
    b = one(app, "SELECT * FROM bookings")
    assert b["contact_id"] == one(app, "SELECT id FROM contacts WHERE name='Jo Smith'")
    assert b["starts_at"] == start.strftime("%Y-%m-%dT%H:%M")      # UTC turned into the business's own time
    assert b["status"] == "booked" and b["minutes"] == 30 and b["resource_id"] == 1 and "Booked online" in b["notes"]
    assert "Short" in b["notes"]


def test_booking_customer_matched_by_phone_or_created(app):
    file(app, item("booking", booking(next_local(10), customer={"name": "Jo", "phone": "123 4567"})))
    assert one(app, "SELECT contact_id FROM bookings") == one(app, "SELECT id FROM contacts WHERE name='Jo Smith'")
    file(app, item("booking", booking(next_local(11))))
    c = one(app, "SELECT * FROM contacts WHERE email='mere@example.com'")
    assert c["name"] == "Mere Tui" and c["phone"] == "+679 999 0000" and c["kind"] == "customer"


def test_booking_confirmed_setting_and_notify(app):
    with app.app_context():
        O.save_settings(get_db(), {"booking_status": "confirmed"})
        get_db().commit()
    r = file(app, item("booking", booking(next_local(10))))
    assert r["result"]["state"] == "confirmed" and one(app, "SELECT status FROM bookings") == "confirmed"
    ev = api(app, "get", "outbox").get_json()["events"]
    assert [e["event"] for e in ev] == ["booking.confirmed"] and ev[0]["event_id"] == r["id"]
    assert ev[0]["data"]["start"].endswith("Z")
    # widget bookings always wait for the business
    r = file(app, item("booking", booking(next_local(12)), source="widget"))
    assert r["result"]["state"] == "pending"


def test_booking_conflicts_are_turned_down_with_a_reason(app):
    start = next_local(10)
    assert file(app, item("booking", booking(start, staff="S1")))["outcome"] == "done"
    r = file(app, item("booking", booking(start + timedelta(minutes=15), staff="S1")))
    assert r["outcome"] == "rejected" and r["result"]["state"] == "slot_taken" and "taken" in r["result"]["message"]
    # no staff asked for: the next free one gets it
    r = file(app, item("booking", booking(start)))
    assert r["outcome"] == "done" and one(app, "SELECT resource_id FROM bookings ORDER BY id DESC LIMIT 1") == 2
    r = file(app, item("booking", booking(start)))   # both busy now
    assert r["result"]["state"] == "slot_taken"
    assert file(app, item("booking", booking(next_local(7))))["result"]["state"] == "outside_hours"
    assert file(app, item("booking", booking(next_local(16, 45))))["result"]["state"] == "outside_hours"  # ends 17:15
    assert file(app, item("booking", booking(next_local(10), service="NOPE")))["result"]["state"] == "unknown_service"
    assert file(app, item("booking", booking(next_local(10), staff="S99")))["result"]["state"] == "unknown_staff"
    past = datetime.now(timezone.utc) - timedelta(hours=3)
    assert file(app, item("booking", booking(past)))["result"]["state"] == "in_the_past"
    assert one(app, "SELECT COUNT(*) FROM bookings") == 2
    assert one(app, "SELECT COUNT(*) FROM online_inbox WHERE status='rejected'") == 7


def test_confirming_in_bookings_tells_the_website(app, client):
    r = file(app, item("booking", booking(next_local(10))))
    bid = one(app, "SELECT id FROM bookings")
    client.post(f"/bookings/{bid}/status", data={"status": "confirmed"})
    client.post(f"/bookings/{bid}/status", data={"status": "cancelled"})
    ev = api(app, "get", "outbox").get_json()["events"]
    assert [e["event"] for e in ev] == ["booking.confirmed", "booking.cancelled"]
    assert all(e["event_id"] == r["id"] for e in ev) and ev[0]["data"]["reference"] == f"BK-{bid}"
    api(app, "post", "outbox/done", {"sent": [ev[0]["id"]], "errors": {str(ev[1]["id"]): "offline"}})
    left = api(app, "get", "outbox").get_json()["events"]
    assert [e["id"] for e in left] == [ev[1]["id"]]
    # a booking made in Riyeser itself sends nothing
    client.post("/bookings/new", data={"date": "2026-12-01", "time": "09:00", "minutes": "30", "status": "booked",
                                       "past_ok": "1", "new_customer": "Walk in"})
    nid = one(app, "SELECT MAX(id) FROM bookings")
    client.post(f"/bookings/{nid}/status", data={"status": "confirmed"})
    assert len(api(app, "get", "outbox").get_json()["events"]) == 1


# ---------------------------------------------------------------- idempotency and test mode
def test_the_same_item_twice_is_filed_once(app):
    it = item("booking", booking(next_local(10)))
    a = file(app, it)
    b = file(app, it)
    assert a["result"] == b["result"] and b["replay"] and one(app, "SELECT COUNT(*) FROM bookings") == 1
    o = item("order", {"customer": {"name": "Kim", "email": "kim@example.com"},
                       "items": [{"sku": "MUG-1", "quantity": 2}], "payment": {"status": "paid", "provider": "stripe",
                                                                             "transaction_id": "pi_1"}})
    x, y = file(app, o, o)
    assert x["result"]["reference"] == y["result"]["reference"]
    assert one(app, "SELECT COUNT(*) FROM documents WHERE side='sale'") == 1
    assert one(app, "SELECT COUNT(*) FROM payments") == 1
    assert one(app, "SELECT qty_on_hand FROM items WHERE sku='MUG-1'") == 8


def test_a_temporary_problem_is_retried_and_then_filed(app, monkeypatch):
    it = item("enquiry", {"customer": {"name": "A", "email": "a@b.co"}, "message": "Hello"})
    real = O.HANDLERS["enquiry"]
    monkeypatch.setitem(O.HANDLERS, "enquiry", lambda *a: (_ for _ in ()).throw(L.PostingError("database is locked")))
    r = file(app, it)
    assert r["outcome"] == "retry" and "locked" in r["reason"] and one(app, "SELECT status FROM online_inbox") == "failed"
    assert one(app, "SELECT COUNT(*) FROM contact_notes") == 0
    monkeypatch.setitem(O.HANDLERS, "enquiry", real)
    r = file(app, it)
    assert r["outcome"] == "done" and one(app, "SELECT attempts FROM online_inbox") == 2


def test_test_items_never_touch_the_books(app, client):
    before = {t: one(app, f"SELECT COUNT(*) FROM {t}") for t in
              ("bookings", "documents", "payments", "contacts", "contact_notes", "journal_entries", "stock_movements")}
    rs = file(app,
              item("booking", booking(next_local(10)), test=True),
              item("order", {"customer": {"name": "T", "email": "t@example.com"}, "items": [{"sku": "MUG-1", "quantity": 1}],
                             "payment": {"status": "paid"}}, test=True),
              item("enquiry", {"customer": {"name": "T", "email": "t@example.com"}, "message": "hi"}, test=True),
              item("customer", {"name": "New Person", "email": "np@example.com"}, test=True),
              item("invoice_payment", {"invoice_ref": "INV99999", "amount": 10, "method": "card"}, test=True),
              item("booking", booking(next_local(6)), test=True))
    assert [r["outcome"] for r in rs] == ["done"] * 5 + ["rejected"]
    assert rs[0]["result"]["reference"].startswith("TEST-BK-") and "(test)" in rs[0]["result"]["message"]
    assert rs[5]["result"]["state"] == "outside_hours"   # the same checks as a real one
    after = {t: one(app, f"SELECT COUNT(*) FROM {t}") for t in before}
    assert after == before and one(app, "SELECT qty_on_hand FROM items WHERE sku='MUG-1'") == 10
    assert one(app, "SELECT COUNT(*) FROM online_inbox WHERE test=1") == 6
    page = client.get("/online/?t=test").get_data(as_text=True)
    assert "test key" in page and "nothing was added" in page
    assert "Mere Tui" not in client.get("/online/").get_data(as_text=True)   # not among the real ones
    assert api(app, "get", "outbox").get_json()["events"] == []


# ---------------------------------------------------------------- orders
def test_order_as_invoice_paid_online_with_fee(app):
    r = file(app, item("order", {"reference": "W-1001", "customer": {"name": "Kim", "email": "kim@example.com"},
                                 "items": [{"sku": "MUG-1", "quantity": 3, "unit_price": 12.5, "notes": "blue"},
                                           {"name": "Custom engraving", "quantity": 1, "unit_price": 5}],
                                 "fulfilment": {"type": "pickup", "time": "Sat 10am"},
                                 "payment": {"status": "paid", "amount": 42.5, "provider": "stripe",
                                             "transaction_id": "pi_123"},
                                 "totals": {"total": 42.5}, "metadata": {"fee": 1.53}}))
    assert r["outcome"] == "done" and r["result"]["state"] == "accepted"
    d = one(app, "SELECT * FROM documents WHERE number=?", r["result"]["reference"])
    assert d["status"] == "paid" and d["total"] == 4250 and d["reference"] == "Online W-1001" and "pickup" in d["notes"]
    lines = [dict(x) for x in get_rows(app, "SELECT * FROM document_lines WHERE document_id=? ORDER BY id", d["id"])]
    assert lines[0]["description"] == "Mug (blue)" and lines[0]["unit_price"] == 1250 and lines[1]["item_id"] is None
    assert one(app, "SELECT qty_on_hand FROM items WHERE sku='MUG-1'") == 7          # stock taken off
    p = one(app, "SELECT * FROM payments")
    assert p["amount"] == 4250 and p["reference"] == "stripe pi_123"
    fee = one(app, "SELECT SUM(l.debit) FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code='6-1100'")
    assert fee == 153


def get_rows(app, sql, *args):
    with app.app_context():
        return get_db().execute(sql, args).fetchall()


def test_order_unpaid_is_an_unpaid_invoice_and_own_prices(app):
    with app.app_context():
        O.save_settings(get_db(), {"order_prices": "riyeser", "order_as": "pos_sale"})
        get_db().commit()
    r = file(app, item("order", {"customer": {"name": "Lu", "phone": "555 1234"},
                                 "items": [{"sku": "mug-1", "quantity": 1, "unit_price": 0.01}],
                                 "payment": {"status": "unpaid"}}))
    d = one(app, "SELECT * FROM documents WHERE number=?", r["result"]["reference"])
    assert d["status"] == "open" and d["total"] == 1100 and d["amount_paid"] == 0    # 10.00 + GST, not 0.01
    assert one(app, "SELECT COUNT(*) FROM pos_sales") == 0 and "invoice" in r["result"]["message"]


def test_order_as_pos_sale(app, client):
    with app.app_context():
        O.save_settings(get_db(), {"order_as": "pos_sale"})
        get_db().commit()
    r = file(app, item("order", {"customer": {"name": "Kim", "email": "kim@example.com"},
                                 "items": [{"sku": "GIFT", "quantity": 1}], "payment": {"status": "paid"}}))
    s = one(app, "SELECT * FROM pos_sales")
    assert s["method"] == "online" and s["checkout_ref"] == f"online:{r['id']}"
    assert one(app, "SELECT status FROM documents WHERE id=?", s["document_id"]) == "paid"
    assert client.get(f"/pos/receipt/{s['id']}").status_code == 200
    assert "Paid online" in client.get("/pos/sales").get_data(as_text=True)


def test_order_as_sales_order_keeps_payment_as_credit(app):
    with app.app_context():
        O.save_settings(get_db(), {"order_as": "sales_order"})
        get_db().commit()
    r = file(app, item("order", {"customer": {"name": "Kim", "email": "kim@example.com"},
                                 "items": [{"sku": "MUG-1", "quantity": 1}], "payment": {"status": "paid", "amount": 11}}))
    d = one(app, "SELECT * FROM documents WHERE number=?", r["result"]["reference"])
    assert d["status"] == "order" and one(app, "SELECT qty_on_hand FROM items WHERE sku='MUG-1'") == 10
    assert one(app, "SELECT total FROM documents WHERE kind='payment_credit'") == -1100


def test_order_rejections(app):
    def order(items, **kw):
        return file(app, item("order", {"customer": {"name": "K", "email": "k@example.com"}, "items": items, **kw}))
    assert order([{"sku": "NOPE", "quantity": 1}])["result"]["state"] == "unknown_item"
    assert order([{"sku": "RARE", "quantity": 1}])["result"]["state"] == "out_of_stock"   # never sold below 0
    assert order([{"sku": "MUG-1", "quantity": 1}], currency="USD")["result"]["state"] == "wrong_currency"
    with app.app_context():
        get_db().execute("UPDATE items SET is_sold=0 WHERE sku='GIFT'")
        get_db().commit()
    assert order([{"sku": "GIFT", "quantity": 1}])["result"]["state"] == "not_sold"
    assert one(app, "SELECT COUNT(*) FROM documents WHERE side='sale'") == 0
    # selling more than is on hand is allowed for an item that may go below 0 (the shop sorts it out)
    assert order([{"sku": "MUG-1", "quantity": 12}])["outcome"] == "done"
    assert one(app, "SELECT qty_on_hand FROM items WHERE sku='MUG-1'") == -2


# ---------------------------------------------------------------- enquiries and customers
def test_enquiry_is_a_note_with_a_follow_up_on_today(app, client):
    r = file(app, item("enquiry", {"customer": {"name": "Jo", "email": "jo@example.com"}, "subject": "Prices",
                                   "message": "<b>How much?</b>", "preferred_contact": "phone"}))
    assert r["result"]["state"] == "received"
    n = one(app, "SELECT * FROM contact_notes")
    assert n["contact_id"] == one(app, "SELECT id FROM contacts WHERE name='Jo Smith'")
    assert n["follow_up_on"] == date.today().isoformat() and "Prices" in n["note"] and "prefers phone" in n["note"]
    page = client.get("/").get_data(as_text=True)
    assert "Follow-ups due" in page and "&lt;b&gt;How much?" in page and "<b>How much?" not in page   # escaped
    assert "New from your website" in page


def test_customer_create_then_update_by_external_id(app):
    r = file(app, item("customer", {"name": "Sam Lee", "email": "sam@example.com", "external_id": "web-7",
                                    "marketing_consent": True, "tags": ["vip"]}))
    assert r["result"]["state"] == "created"
    cid = one(app, "SELECT id FROM contacts WHERE email='sam@example.com'")
    r = file(app, item("customer", {"name": "Samuel Lee", "email": "samuel@example.com", "phone": "021 555",
                                    "external_id": "web-7", "marketing_consent": False}))
    assert r["result"]["state"] == "updated"
    c = one(app, "SELECT * FROM contacts WHERE id=?", cid)
    assert c["name"] == "Samuel Lee" and c["email"] == "samuel@example.com" and c["phone"] == "021 555"
    ref = one(app, "SELECT * FROM online_customer_refs")
    assert ref["marketing_consent"] == 0 and json.loads(ref["tags"]) == ["vip"]
    assert one(app, "SELECT COUNT(*) FROM contacts WHERE kind='customer'") == 2


# ---------------------------------------------------------------- quotes
def _quote(app, valid_until=None, status=None):
    with app.app_context():
        db = get_db()
        cust = db.execute("SELECT id FROM contacts WHERE name='Jo Smith'").fetchone()[0]
        mug = db.execute("SELECT id FROM items WHERE sku='MUG-1'").fetchone()[0]
        gst = db.execute("SELECT id FROM tax_codes WHERE code='GST'").fetchone()[0]
        qid = L.save_document(db, "sale", dict(contact_id=cust, date=date.today().isoformat(), tax_inclusive=True),
                              [dict(item_id=mug, qty=2, unit_price=1100, tax_code_id=gst)], "quote")
        db.execute("UPDATE documents SET valid_until=?, quote_status=? WHERE id=?", (valid_until, status, qid))
        db.commit()
        return db.execute("SELECT number FROM documents WHERE id=?", (qid,)).fetchone()[0], qid


def test_quote_accepted_online(app):
    num, qid = _quote(app, (date.today() + timedelta(days=5)).isoformat())
    r = file(app, item("quote_accept", {"quote_ref": num, "accepted_by": {"name": "Jo Smith", "position": "Owner"},
                                        "signature": "Jo Smith", "po_number": "PO-77", "options": ["Gift wrap"]}))
    assert r["outcome"] == "done" and r["result"]["state"] == "accepted"
    q = one(app, "SELECT * FROM documents WHERE id=?", qid)
    assert q["quote_status"] == "accepted" and q["accepted_source"] == "accepted_online"
    assert q["quote_status_by"] == "customer" and q["accepted_name"] == "Jo Smith" and q["reference"] == "PO-77"
    assert "Gift wrap" in q["quote_status_note"] and "Owner" in q["quote_status_note"]
    assert one(app, "SELECT COUNT(*) FROM documents WHERE status IN ('open','paid')") == 0   # no invoice by default


def test_quote_accept_makes_the_invoice_or_job_per_setting(app):
    with app.app_context():
        O.save_settings(get_db(), {"quote_after": "invoice"})
        get_db().commit()
    num, qid = _quote(app)
    r = file(app, item("quote_accept", {"quote_ref": num, "accepted_by": {"name": "Jo"}}))
    q = one(app, "SELECT * FROM documents WHERE id=?", qid)
    inv = one(app, "SELECT * FROM documents WHERE id=?", q["converted_to"])
    assert inv["status"] == "open" and inv["total"] == 2200 and r["result"]["reference"] == inv["number"]
    assert one(app, "SELECT qty_on_hand FROM items WHERE sku='MUG-1'") == 8
    with app.app_context():
        O.save_settings(get_db(), {"quote_after": "job"})
        get_db().commit()
    num2, qid2 = _quote(app)
    r = file(app, item("quote_accept", {"quote_ref": num2, "accepted_by": {"name": "Jo"}}))
    assert r["result"]["reference"].startswith(num2 + " / J-")
    assert one(app, "SELECT booking_job_id FROM documents WHERE id=?", qid2)


def test_quote_accept_rejections(app):
    assert file(app, item("quote_accept", {"quote_ref": "Q99999", "accepted_by": {"name": "X"}}))["result"]["state"] == "not_found"
    num, _ = _quote(app, (date.today() - timedelta(days=1)).isoformat())
    assert file(app, item("quote_accept", {"quote_ref": num, "accepted_by": {"name": "X"}}))["result"]["state"] == "expired"
    num, _ = _quote(app, None, "declined")
    assert file(app, item("quote_accept", {"quote_ref": num, "accepted_by": {"name": "X"}}))["result"]["state"] == "declined"


# ---------------------------------------------------------------- invoice payments
def _invoice(app, cents=5500):
    with app.app_context():
        db = get_db()
        cust = db.execute("SELECT id FROM contacts WHERE name='Jo Smith'").fetchone()[0]
        gst = db.execute("SELECT id FROM tax_codes WHERE code='GST'").fetchone()[0]
        inc = db.execute("SELECT id FROM accounts WHERE code='4-1000'").fetchone()[0]
        did = L.save_document(db, "sale", dict(contact_id=cust, date=date.today().isoformat(), tax_inclusive=True),
                              [dict(description="Work", qty=1, unit_price=cents, tax_code_id=gst, account_id=inc)], "open")
        db.commit()
        return db.execute("SELECT number FROM documents WHERE id=?", (did,)).fetchone()[0], did


def test_invoice_payment_recorded_with_reference_and_fee(app):
    num, did = _invoice(app)
    r = file(app, item("invoice_payment", {"invoice_ref": num, "amount": 20, "method": "card", "provider": "stripe",
                                           "transaction_id": "ch_9", "metadata": {"fee": "0.88"}}))
    assert r["result"]["state"] == "recorded" and r["result"]["reference"].startswith("PAY-")
    d = one(app, "SELECT * FROM documents WHERE id=?", did)
    assert d["amount_paid"] == 2000 and d["status"] == "open"
    assert one(app, "SELECT reference FROM payments") == "stripe ch_9"
    assert one(app, "SELECT SUM(l.debit) FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code='6-1100'") == 88


def test_overpayment_and_unknown_invoice_are_kept_as_credit(app):
    num, did = _invoice(app, 1000)
    r = file(app, item("invoice_payment", {"invoice_ref": num, "amount": 15, "method": "bank_transfer"}))
    assert one(app, "SELECT status FROM documents WHERE id=?", did) == "paid"
    assert one(app, "SELECT total FROM documents WHERE kind='payment_credit'") == -500 and "credit" in r["reason"]
    r = file(app, item("invoice_payment", {"invoice_ref": "INV-NOPE", "amount": 7, "method": "paypal",
                                           "payer": {"name": "Pat", "email": "pat@example.com"}}))
    assert r["outcome"] == "done" and "couldn't find" in r["reason"]
    pat = one(app, "SELECT id FROM contacts WHERE email='pat@example.com'")
    assert one(app, "SELECT total FROM documents WHERE kind='payment_credit' AND contact_id=?", pat) == -700
    r = file(app, item("invoice_payment", {"invoice_ref": "X", "amount": 3, "method": "other"}))
    assert one(app, "SELECT name FROM contacts WHERE id=(SELECT contact_id FROM payments ORDER BY id DESC LIMIT 1)") == \
        "Unallocated online payments"
    r = file(app, item("invoice_payment", {"invoice_ref": num, "amount": 3, "method": "card", "currency": "USD"}))
    assert r["outcome"] == "rejected" and "USD" in r["reason"]


# ---------------------------------------------------------------- publishing
def test_catalog_and_stock(app):
    cat = api(app, "get", "catalog").get_json()
    skus = {i["sku"]: i for i in cat["items"]}
    assert set(skus) == {"SVC-1", "MUG-1", "RARE", "GIFT"} and cat["skipped"][0]["sku"] == "BAD SKU"
    assert skus["MUG-1"]["price"] == 11.0 and skus["MUG-1"]["tax_rate"] == 10 and skus["MUG-1"]["currency"] == "FJD"
    assert skus["SVC-1"]["type"] == "service" and skus["SVC-1"]["duration_minutes"] == 30 and skus["SVC-1"]["price"] == 45
    assert skus["GIFT"]["category"] == "Gifts" and "buy_price" not in json.dumps(cat)
    st = api(app, "get", "stock").get_json()
    assert {l["sku"]: l["quantity"] for l in st["levels"]} == {"MUG-1": 10, "RARE": 0}
    with app.app_context():
        db = get_db()
        O.save_settings(db, {"publish_items": "chosen", "chosen_items": [db.execute("SELECT id FROM items WHERE sku='GIFT'").fetchone()[0]],
                             "publish_services": "none", "publish_stock": False})
        db.commit()
    assert [i["sku"] for i in api(app, "get", "catalog").get_json()["items"]] == ["GIFT"]
    assert api(app, "get", "stock").get_json() == {"levels": [], "enabled": False}


def _avail(app, now, tz="Pacific/Fiji", hours=None, days=3):
    with app.app_context():
        db = get_db()
        O.save_settings(db, {"timezone": tz, "days_ahead": days, "hours": hours or {d: "09:00-17:00" for d in O.WEEKDAYS}})
        db.commit()
        return O.availability(db, now=now)


def test_availability_windows_less_bookings(app):
    now = datetime(2026, 12, 1, 18, 0, tzinfo=timezone.utc)   # Wed 2 Dec 06:00 in Fiji (UTC+12)
    with app.app_context():
        db = get_db()
        db.execute("INSERT INTO bookings (resource_id, starts_at, minutes, status) VALUES (1,'2026-12-02T10:00',60,'booked')")
        db.execute("INSERT INTO bookings (resource_id, starts_at, minutes, status) VALUES (1,'2026-12-02T16:30',90,'confirmed')")
        db.execute("INSERT INTO bookings (resource_id, starts_at, minutes, status) VALUES (1,'2026-12-02T13:00',60,'cancelled')")
        db.commit()
    a = _avail(app, now, hours={**{d: "09:00-17:00" for d in O.WEEKDAYS}, "sun": ""})
    assert a["settings"]["timezone"] == "Pacific/Fiji" and a["from_at"] == "2026-12-01T12:00:00.000Z"
    assert a["to_at"] == "2026-12-04T12:00:00.000Z" and [s["ref"] for s in a["staff"]] == ["S1", "S2"]
    ana = [(w["start"], w["end"]) for w in a["open_times"] if w["staff_ref"] == "S1"]
    assert ana[:2] == [("2026-12-01T21:00:00.000Z", "2026-12-01T22:00:00.000Z"),   # 09:00-10:00 Fiji
                       ("2026-12-01T23:00:00.000Z", "2026-12-02T04:30:00.000Z")]   # 11:00-16:30 (cancelled ignored)
    assert len(ana) == 4   # Wed (2 parts), Thu, Fri
    ben = [w for w in a["open_times"] if w["staff_ref"] == "S2"]
    assert len(ben) == 3 and all(w["capacity"] == 1 for w in ben)
    # a closed day has no windows; Sunday 6 Dec is outside the 3 days anyway, so close Thursday
    a = _avail(app, now, hours={**{d: "09:00-17:00" for d in O.WEEKDAYS}, "thu": ""})
    assert not [w for w in a["open_times"] if w["start"].startswith("2026-12-02T2") or w["start"].startswith("2026-12-02T23")]


def test_availability_follows_daylight_saving_and_other_zones(app):
    # Auckland moves to NZDT (UTC+13) on Sun 27 Sep 2026: 09:00 is 21:00Z the day before, then 20:00Z
    now = datetime(2026, 9, 25, 0, 0, tzinfo=timezone.utc)
    a = _avail(app, now, tz="Pacific/Auckland", days=4)
    starts = sorted({w["start"] for w in a["open_times"]})
    assert starts == ["2026-09-24T21:00:00.000Z", "2026-09-25T21:00:00.000Z", "2026-09-26T20:00:00.000Z",
                      "2026-09-27T20:00:00.000Z"]
    assert a["from_at"] == "2026-09-24T12:00:00.000Z"     # midnight Fri 25 Sep NZST
    # New York (UTC-5 in December): the day is still Tuesday there, so Tuesday's hours count
    now = datetime(2026, 12, 1, 15, 0, tzinfo=timezone.utc)   # 10:00 Tue in New York
    a = _avail(app, now, tz="America/New_York", days=1)
    assert {(w["start"], w["end"]) for w in a["open_times"]} == {("2026-12-01T14:00:00.000Z", "2026-12-01T22:00:00.000Z")}
    # UTC
    a = _avail(app, datetime(2026, 12, 1, 0, 0, tzinfo=timezone.utc), tz="UTC", days=1)
    assert a["open_times"][0]["start"] == "2026-12-01T09:00:00.000Z" and a["settings"]["timezone"] == "UTC"


def test_availability_drops_past_windows_and_tables_mode(app):
    now = datetime(2026, 12, 2, 3, 0, tzinfo=timezone.utc)    # 15:00 Wed in Fiji: today's window is still open
    a = _avail(app, now, days=1)
    assert {w["start"] for w in a["open_times"]} == {"2026-12-01T21:00:00.000Z"}  # ends 05:00Z, after now
    a = _avail(app, datetime(2026, 12, 2, 6, 0, tzinfo=timezone.utc), days=1)     # 18:00: closed for the day
    assert a["open_times"] == []
    with app.app_context():
        db = get_db()
        db.execute("UPDATE company SET bookings_mode='tables'")
        db.execute("UPDATE booking_resources SET kind='table', capacity=4 WHERE id=1")
        db.execute("UPDATE booking_resources SET kind='table', capacity=6 WHERE id=2")
        db.commit()
    a = _avail(app, datetime(2026, 12, 1, 0, 0, tzinfo=timezone.utc), days=1)
    assert a["staff"] == [] and sorted(w["capacity"] for w in a["open_times"]) == [4, 6]
    assert all(w["staff_ref"] is None for w in a["open_times"])


def test_booking_from_published_slot_round_trip(app):
    """A start time inside a published window is accepted; once booked, it's gone from the next publish."""
    a = api(app, "get", "availability").get_json()
    w = next(w for w in a["open_times"] if w["staff_ref"] == "S1" and
             datetime.fromisoformat(w["start"].replace("Z", "+00:00")) > datetime.now(timezone.utc) + timedelta(hours=2))
    start = datetime.fromisoformat(w["start"].replace("Z", "+00:00"))
    assert file(app, item("booking", booking(start, staff="S1")))["outcome"] == "done"
    b = api(app, "get", "availability").get_json()
    assert not any(x["staff_ref"] == "S1" and x["start"] == w["start"] for x in b["open_times"])


# ---------------------------------------------------------------- screens
def test_online_list_settings_and_detail(app, client):
    file(app, item("booking", booking(next_local(10))))
    r = file(app, item("order", {"customer": {"name": "Kim <script>", "email": "kim@example.com"},
                                 "items": [{"sku": "MUG-1", "quantity": 1}]}))
    file(app, item("booking", booking(next_local(3))))
    api(app, "post", "sync-report", {"at": datetime.now(timezone.utc).isoformat(), "ok": True, "pc": "Front desk"})
    page = client.get("/online/").get_data(as_text=True)
    assert "Online orders &amp; bookings" in page and "Mere Tui" in page and "Turned down" in page
    assert "Kim &lt;script&gt;" in page and "<script>" not in page.split("Kim")[1][:20]
    assert "received today" in page and "Front desk" in page
    assert "Needs a look" in page and "outside the online booking hours" in client.get("/online/?t=problems").get_data(as_text=True)
    v = client.get(f"/online/item/{r['id']}").get_data(as_text=True)
    assert "Ready for the customer" in v and r["result"]["reference"] in v
    client.post(f"/online/item/{r['id']}/news", data={"what": "ready"})
    assert [e["event"] for e in api(app, "get", "outbox").get_json()["events"]] == ["order.ready"]
    s = client.get("/online/settings").get_data(as_text=True)
    assert "Orders from your website" in s and "BAD SKU" in s and "Pacific/Fiji" in s
    form = {"order_as": "pos_sale", "order_prices": "website", "booking_status": "confirmed", "quote_after": "job",
            "publish_items": "all", "publish_services": "all", "publish_stock": "1", "timezone": "Pacific/Auckland",
            "days_ahead": "14", "slot_minutes": "30", "min_notice_minutes": "120",
            "open_mon": "1", "from_mon": "08:00", "to_mon": "12:00"}
    assert "Saved" in client.post("/online/settings", data=form, follow_redirects=True).get_data(as_text=True)
    with app.app_context():
        s = O.settings(get_db())
    assert s["order_as"] == "pos_sale" and s["timezone"] == "Pacific/Auckland" and s["days_ahead"] == 14
    assert s["hours"]["mon"] == "08:00-12:00" and s["hours"]["tue"] == ""
    bad = dict(form, from_mon="13:00", to_mon="12:00")
    assert "closing time" in client.post("/online/settings", data=bad, follow_redirects=True).get_data(as_text=True)


def test_online_screens_in_the_separate_apps(tmp_path, monkeypatch):
    from tests.test_pos_app import make
    for ed in ("bookings", "invoices", "pos"):
        (tmp_path / ed).mkdir()
        app, c, _ = make(tmp_path / ed, monkeypatch, ed)
        assert c.get("/online/").status_code == 200, ed
        assert c.get("/online/settings").status_code == 200, ed


# ---------------------------------------------------------------- order requests (the widget's order button)
def _order_request(**md):
    return {"customer": {"name": "Cake Fan", "email": "fan@example.com"}, "subject": "Order request: 2 × Mug",
            "message": "2 x Mug", "source_page": "https://shop.example.com/mugs", "preferred_time": "Saturday morning",
            "metadata": {"order_sku": "MUG-1", "order_quantity": 2, "order_unit_price": 12, "order_currency": "FJD", **md}}


def test_order_request_is_shown_and_confirmed_by_the_business(app, client):
    r = file(app, item("enquiry", _order_request(), source="widget"))
    assert r["outcome"] == "done" and r["order_request"] and "order request" in r["result"]["message"]
    assert one(app, "SELECT COUNT(*) FROM documents WHERE side='sale'") == 0          # nothing made on its own
    assert one(app, "SELECT qty_on_hand FROM items WHERE sku='MUG-1'") == 10
    page = client.get("/online/").get_data(as_text=True)
    assert "Order request" in page and "2 × MUG-1" in page and "To confirm" in page
    v = client.get(f"/online/item/{r['id']}").get_data(as_text=True)
    assert "https://shop.example.com/mugs" in v and "Make a sales order" in v and "Make an invoice" in v and "Mug" in v
    assert "Saturday morning" in v
    res = client.post(f"/online/item/{r['id']}/convert", data={"how": "invoice"})
    assert res.status_code == 302 and "/document/" in res.headers["Location"]
    d = one(app, "SELECT * FROM documents WHERE side='sale'")
    assert d["status"] == "open" and d["total"] == 2400 and "shop.example.com/mugs" in d["notes"]
    assert one(app, "SELECT qty_on_hand FROM items WHERE sku='MUG-1'") == 8
    # once only
    assert "already" in client.post(f"/online/item/{r['id']}/convert", data={"how": "sales_order"},
                                    follow_redirects=True).get_data(as_text=True)
    assert one(app, "SELECT COUNT(*) FROM documents WHERE side='sale'") == 1


def test_order_request_as_sales_order_or_till_order_and_test_ones(app, client):
    a = file(app, item("enquiry", _order_request()))
    client.post(f"/online/item/{a['id']}/convert", data={"how": "sales_order"})
    assert one(app, "SELECT status FROM documents WHERE side='sale'") == "order"
    b = file(app, item("enquiry", _order_request(order_sku_2="GIFT", order_quantity_2=1)))
    client.post(f"/online/item/{b['id']}/convert", data={"how": "pos_order"})
    o = one(app, "SELECT * FROM pos_orders")
    assert o["status"] == "open" and [l["qty"] for l in json.loads(o["lines"])] == [2, 1]
    t = file(app, item("enquiry", _order_request(), test=True))
    assert "test key" in client.post(f"/online/item/{t['id']}/convert", data={"how": "invoice"},
                                     follow_redirects=True).get_data(as_text=True)
    plain = file(app, item("enquiry", {"customer": {"name": "Q", "email": "q@example.com"}, "message": "Hi"}))
    assert not plain["order_request"]
    assert "Only an order request" in client.post(f"/online/item/{plain['id']}/convert", data={"how": "invoice"},
                                                  follow_redirects=True).get_data(as_text=True)
