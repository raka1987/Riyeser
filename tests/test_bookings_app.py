"""Riyeser Bookings: jobs, appointments and table bookings, linked to invoicing in the same company file."""
import pytest

from riyeser.db import get_db
from tests.test_pos_app import make, _trial


def _cust(app, name="Jo Smith"):
    with app.app_context():
        cid = get_db().execute("INSERT INTO contacts (kind, name, phone) VALUES ('customer',?, '0400 000 000')",
                               (name,)).lastrowid
        get_db().commit()
    return cid


def _book(c, **kw):
    data = {"date": "2026-11-24", "time": "09:00", "minutes": "60", "status": "booked"}
    data.update({k: str(v) for k, v in kw.items()})
    return c.post("/bookings/new", data=data, follow_redirects=True)


def _one(app, sql, args=()):
    with app.app_context():
        return get_db().execute(sql, args).fetchone()


def test_bookings_app_shows_the_calendar_only(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    r = c.get("/")
    assert r.status_code == 302 and r.headers["Location"].endswith("/bookings/")
    page = c.get("/bookings/").get_data(as_text=True)
    assert "Riyeser Bookings" in page and "ed-book" in page and "Staff 1" in page   # starter staff for trades jobs
    for gone in ("Bank accounts", "General journal", "Enter bill", "Payroll"):
        assert gone not in page, gone
    for url in ("/banking/", "/purchase/new", "/inventory/", "/pos/"):
        r = c.get(url)
        assert r.status_code == 302 and r.headers["Location"].endswith("/bookings/"), url
    assert c.get("/bookings/week").status_code == 200 and c.get("/bookings/list").status_code == 200
    assert c.get("/bookings/setup").status_code == 200


@pytest.mark.parametrize("mode,who", [("jobs", "Staff 1"), ("appointments", "Staff 1"), ("tables", "Table 1")])
def test_each_kind_of_business(tmp_path, monkeypatch, mode, who):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    with app.app_context():
        get_db().execute("UPDATE company SET bookings_mode=?", (mode,))
        get_db().commit()
    page = c.get("/bookings/").get_data(as_text=True)
    assert who in page
    form = c.get("/bookings/new").get_data(as_text=True)
    assert ("Job address" in form) == (mode == "jobs")
    assert ('name="party"' in form) == (mode == "tables")


def test_book_clash_and_invoice(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    c.get("/bookings/")                                 # starts the staff list
    cust = _cust(app)
    staff = _one(app, "SELECT id FROM booking_resources")["id"]
    with app.app_context():
        get_db().execute("UPDATE booking_services SET price=15000 WHERE name='Call-out'")
        get_db().commit()
    svc = _one(app, "SELECT id FROM booking_services WHERE name='Call-out'")["id"]
    assert "Job saved" in _book(c, contact_id=cust, resource_id=staff, service_id=svc, address="1 Main St").get_data(as_text=True)
    # the same staff member at an overlapping time is refused, unless double-booking is allowed
    assert "already has Jo Smith" in _book(c, contact_id=cust, resource_id=staff, time="09:30").get_data(as_text=True)
    assert "Job saved" in _book(c, contact_id=cust, resource_id=staff, time="09:30", allow_overlap=1).get_data(as_text=True)
    assert "Jo Smith" in c.get("/bookings/?d=2026-11-24").get_data(as_text=True)
    bid = _one(app, "SELECT id FROM bookings ORDER BY id")["id"]
    r = c.post(f"/bookings/{bid}/invoice", follow_redirects=True)
    assert "Invoice made" in r.get_data(as_text=True)
    b = _one(app, "SELECT * FROM bookings WHERE id=?", (bid,))
    doc = _one(app, "SELECT * FROM documents WHERE id=?", (b["document_id"],))
    assert b["status"] == "done" and doc["side"] == "sale" and doc["total"] == 15000 and doc["contact_id"] == cust
    assert doc["reference"] == f"Booking {bid}"
    # a second click opens the same invoice instead of making another
    c.post(f"/bookings/{bid}/invoice")
    assert _one(app, "SELECT COUNT(*) n FROM documents")["n"] == 1


def test_price_typed_on_the_booking_is_invoiced(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    c.get("/bookings/")
    cust = _cust(app)
    form = c.get("/bookings/new").get_data(as_text=True)
    assert 'name="price"' in form and "Price" in form
    _book(c, contact_id=cust)                            # no job type and no price
    bid = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    r = c.post(f"/bookings/{bid}/invoice", headers={"Referer": f"/bookings/{bid}"}, follow_redirects=True)
    assert "has no price yet" in r.get_data(as_text=True)
    assert _one(app, "SELECT COUNT(*) n FROM documents")["n"] == 0
    # type the price on the job, save, then invoice
    c.post(f"/bookings/{bid}", data={"contact_id": cust, "date": "2026-11-24", "time": "09:00", "minutes": "60",
                                     "status": "booked", "price": "220.00"})
    assert _one(app, "SELECT price FROM bookings WHERE id=?", (bid,))["price"] == 22000
    assert "220.00" in c.get(f"/bookings/{bid}").get_data(as_text=True)
    assert "Invoice made" in c.post(f"/bookings/{bid}/invoice", follow_redirects=True).get_data(as_text=True)
    doc = _one(app, "SELECT d.total FROM documents d JOIN bookings b ON b.document_id=d.id WHERE b.id=?", (bid,))
    assert doc["total"] == 22000


def test_job_type_description_goes_on_the_invoice(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    c.get("/bookings/")
    cust = _cust(app)
    page = c.get("/bookings/setup").get_data(as_text=True)
    assert "Invoice description" in page and "Add a new job type" in page
    c.post("/bookings/setup", data={"mode": "jobs", "open": "07:00", "close": "18:00", "svc_new": "Gutter clean",
                                    "svc_new_desc": "Clean and flush all gutters and downpipes",
                                    "svc_new_min": "120", "svc_new_price": "330"})
    svc = _one(app, "SELECT * FROM booking_services WHERE name='Gutter clean'")
    assert svc["description"] == "Clean and flush all gutters and downpipes" and svc["price"] == 33000
    _book(c, contact_id=cust, service_id=svc["id"])
    bid = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    c.post(f"/bookings/{bid}/invoice")
    line = _one(app, "SELECT l.description, d.total FROM document_lines l JOIN documents d ON d.id=l.document_id")
    assert line["description"].startswith("Clean and flush all gutters and downpipes") and line["total"] == 33000


def test_new_customer_from_the_booking_form(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    _book(c, new_customer="Sam Lee", phone="0411 111 111")
    assert _one(app, "SELECT name, phone FROM contacts WHERE name='Sam Lee'")["phone"] == "0411 111 111"


def test_table_bigger_than_its_seats_is_refused(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    with app.app_context():
        get_db().execute("UPDATE company SET bookings_mode='tables'")
        get_db().commit()
    c.get("/bookings/")
    t = _one(app, "SELECT id FROM booking_resources WHERE name='Table 1'")["id"]
    assert "seats 4" in _book(c, title="Party", resource_id=t, party=8, time="19:00").get_data(as_text=True)
    assert "Booking saved" in _book(c, title="Party", resource_id=t, party=4, time="19:00").get_data(as_text=True)


def test_bookings_trial_then_licence(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    _trial(tmp_path, 10)
    assert "Free trial · 80 days left" in c.get("/bookings/").get_data(as_text=True)
    _trial(tmp_path, 95)
    assert "90-day free trial has ended" in _book(c, title="X").get_data(as_text=True)
    _trial(tmp_path, 95, licensed=True)
    assert "Job saved" in _book(c, title="X").get_data(as_text=True)


@pytest.mark.parametrize("edition", ["basics", "plus", "invoices", "pos"])
def test_other_apps_link_to_bookings(tmp_path, monkeypatch, edition):
    app, c, item = make(tmp_path, monkeypatch, edition)
    r = c.get("/bookings/")
    assert r.status_code == 302 and r.headers["Location"].endswith("/setup/bookings-app")
    page = c.get("/setup/bookings-app").get_data(as_text=True)
    assert "RiyeserBookings-Setup.exe" in page and "same company file" in page


def test_customer_page_lists_their_bookings(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, None)    # run from source: everything in one app
    cust = _cust(app)
    _book(c, contact_id=cust, title="Kitchen tap")
    assert "Kitchen tap" in c.get(f"/cards/view/{cust}").get_data(as_text=True)


def test_users_can_be_kept_out_of_bookings(tmp_path, monkeypatch):
    from riyeser import perms
    assert "bookings" in perms.AREA_KEYS
