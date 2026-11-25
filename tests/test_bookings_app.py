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
    data = {"date": "2026-11-24", "time": "09:00", "minutes": "60", "status": "booked", "past_ok": "1"}
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
    assert "Riyeser Bookings" in page and "ed-book" in page and "No staff yet" in page   # blank: nothing added
    c.post("/bookings/setup/starters")
    assert "Staff 1" in c.get("/bookings/").get_data(as_text=True)   # suggested staff for trades jobs
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
    assert who not in c.get("/bookings/").get_data(as_text=True)
    c.post("/bookings/setup/starters")
    page = c.get("/bookings/").get_data(as_text=True)
    assert who in page
    form = c.get("/bookings/new").get_data(as_text=True)
    assert ("Job address" in form) == (mode == "jobs")
    assert ('name="party"' in form) == (mode == "tables")


def test_book_clash_and_invoice(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    c.post("/bookings/setup/starters")                  # the suggested staff and job types
    cust = _cust(app)
    staff = _one(app, "SELECT id FROM booking_resources")["id"]
    with app.app_context():
        get_db().execute("UPDATE booking_services SET price=15000 WHERE name='Call-out'")
        get_db().commit()
    svc = _one(app, "SELECT id FROM booking_services WHERE name='Call-out'")["id"]
    assert "Visit saved" in _book(c, contact_id=cust, resource_id=staff, service_id=svc, address="1 Main St").get_data(as_text=True)
    # the same staff member at an overlapping time is refused, unless double-booking is allowed
    assert "already has Jo Smith" in _book(c, contact_id=cust, resource_id=staff, time="09:30").get_data(as_text=True)
    assert "Visit saved" in _book(c, contact_id=cust, resource_id=staff, time="09:30", allow_overlap=1).get_data(as_text=True)
    assert "Jo Smith" in c.get("/bookings/?d=2026-11-24").get_data(as_text=True)
    bid = _one(app, "SELECT id FROM bookings ORDER BY id")["id"]
    r = c.post(f"/bookings/{bid}/invoice", follow_redirects=True)
    assert "Invoice made" in r.get_data(as_text=True)
    b = _one(app, "SELECT * FROM bookings WHERE id=?", (bid,))
    doc = _one(app, "SELECT * FROM documents WHERE id=?", (b["document_id"],))
    assert b["status"] == "done" and doc["side"] == "sale" and doc["total"] == 15000 and doc["contact_id"] == cust
    assert doc["reference"] == "Job J-0001"
    # a second click opens the same invoice instead of making another
    c.post(f"/bookings/{bid}/invoice")
    assert _one(app, "SELECT COUNT(*) n FROM documents")["n"] == 1


def test_price_typed_on_the_booking_is_invoiced(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    c.post("/bookings/setup/starters")                  # the suggested staff and job types
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
    assert _one(app, "SELECT j.price FROM booking_jobs j JOIN bookings b ON b.job_id=j.id WHERE b.id=?", (bid,))["price"] == 22000
    assert "220.00" in c.get(f"/bookings/{bid}").get_data(as_text=True)
    assert "Invoice made" in c.post(f"/bookings/{bid}/invoice", follow_redirects=True).get_data(as_text=True)
    doc = _one(app, "SELECT d.total FROM documents d JOIN bookings b ON b.document_id=d.id WHERE b.id=?", (bid,))
    assert doc["total"] == 22000


def test_job_type_description_goes_on_the_invoice(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    c.post("/bookings/setup/starters")                  # the suggested staff and job types
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
    c.post("/bookings/setup/starters")                  # the suggested staff and job types
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
    assert "Visit saved" in _book(c, title="X").get_data(as_text=True)


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


def _setup_form(app, **extra):
    data = {"open": "07:00", "close": "18:00"}
    with app.app_context():
        db = get_db()
        for r in db.execute("SELECT * FROM booking_resources"):
            data[f"res_name_{r['id']}"] = r["name"]; data[f"res_on_{r['id']}"] = "1" if r["active"] else ""
        for s in db.execute("SELECT * FROM booking_services"):
            data[f"svc_name_{s['id']}"] = s["name"]; data[f"svc_min_{s['id']}"] = s["minutes"]
            data[f"svc_on_{s['id']}"] = "1" if s["active"] else ""
        data["mode"] = db.execute("SELECT bookings_mode FROM company").fetchone()[0]
    data.update(extra)
    return data


def test_switching_business_type_swaps_the_starters(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    c.post("/bookings/setup/starters")                  # the suggested staff and job types
    r = c.post("/bookings/setup", data=_setup_form(app, mode="appointments"), follow_redirects=True)
    page = r.get_data(as_text=True)
    assert "Set up for appointments" in page and "Consultation" in page and "Call-out" not in page and "Services" in page
    page = c.post("/bookings/setup", data=_setup_form(app, mode="tables"), follow_redirects=True).get_data(as_text=True)
    assert "Table 4" in page and "Seats" in page


def test_add_several_and_remove_job_types_and_staff(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    c.post("/bookings/setup/starters")                  # the suggested staff and job types
    form = _setup_form(app)
    form = list(form.items()) + [("svc_new", "Gas fitting"), ("svc_new_min", "90"), ("svc_new_price", "180"),
                                 ("svc_new", "Leak check"), ("svc_new_min", "30"), ("svc_new_price", "60"),
                                 ("res_new", "Alex"), ("res_new_cap", ""), ("res_new", "Sam"), ("res_new_cap", "")]
    from werkzeug.datastructures import MultiDict
    c.post("/bookings/setup", data=MultiDict(form))
    assert _one(app, "SELECT price FROM booking_services WHERE name='Leak check'")["price"] == 6000
    assert _one(app, "SELECT COUNT(*) n FROM booking_resources")["n"] == 3
    # remove one nobody booked: gone; remove one with a booking: hidden and kept
    gas = _one(app, "SELECT id FROM booking_services WHERE name='Gas fitting'")["id"]
    leak = _one(app, "SELECT id FROM booking_services WHERE name='Leak check'")["id"]
    _book(c, title="Tap", service_id=leak)
    c.post("/bookings/setup", data=_setup_form(app, svc_del=gas))
    assert _one(app, "SELECT COUNT(*) n FROM booking_services WHERE id=?", (gas,))["n"] == 0
    page = c.post("/bookings/setup", data=_setup_form(app, svc_del=leak), follow_redirects=True).get_data(as_text=True)
    assert "Hidden rather than deleted" in page
    assert _one(app, "SELECT active FROM booking_services WHERE id=?", (leak,))["active"] == 0


# ---------------------------------------------------------------- jobs with several visits

def _jobs_setup(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    c.post("/bookings/setup/starters")                  # the suggested staff and job types
    cust = _cust(app, "Coral Coast Hotel")
    staff = _one(app, "SELECT id FROM booking_resources")["id"]
    return app, c, item, cust, staff


def test_wifi_fault_two_visits_one_invoice(tmp_path, monkeypatch):
    """The office logs a fault, the first visit diagnoses it, a return visit fixes it, one invoice covers both."""
    app, c, item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    c.post("/bookings/setup", data={"mode": "jobs", "open": "07:00", "close": "18:00", "labour_rate": "120"})
    # 1. the office logs the job from a phone call, no time yet
    assert c.get("/bookings/job/new").status_code == 200
    r = c.post("/bookings/job/new", data={"contact_id": cust, "title": "Wi-Fi fault, level 2", "address": "Queens Rd",
                                          "billing": "time"}, follow_redirects=True)
    assert "J-0001" in r.get_data(as_text=True)
    jid = _one(app, "SELECT id FROM booking_jobs")["id"]
    assert _one(app, "SELECT status FROM booking_jobs")["status"] == "requested"
    assert "Wi-Fi fault" in c.get("/bookings/jobs").get_data(as_text=True)
    # 2. book the first visit on the job
    form = c.get(f"/bookings/new?job={jid}").get_data(as_text=True)
    assert 'name="job_id"' in form and "Queens Rd" in form
    _book(c, job_id=jid, contact_id=cust, resource_id=staff, address="Queens Rd")
    v1 = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    assert _one(app, "SELECT status FROM booking_jobs")["status"] == "scheduled"
    # 3. the technician logs time, then finishes: a return visit is needed
    c.post(f"/bookings/{v1}/time", data={"hours": "1.5", "note": "Diagnosis"})
    r = c.post(f"/bookings/{v1}/finish", data={"outcome": "return", "outcome_note": "Replace access point in room 204"},
               follow_redirects=True)
    assert "waiting for its return visit" in r.get_data(as_text=True)
    j = _one(app, "SELECT * FROM booking_jobs")
    assert j["status"] == "needs_visit" and j["next_action"] == "Replace access point in room 204"
    assert "Replace access point in room 204" in c.get("/bookings/jobs").get_data(as_text=True)
    assert "J-0001" in c.get("/bookings/jobs?q=Room 204").get_data(as_text=True)     # finds words in visit notes
    assert "J-0001" not in c.get("/bookings/jobs?q=Room 999").get_data(as_text=True)
    visit = c.get(f"/bookings/{v1}").get_data(as_text=True)
    assert "Book the return visit" in visit and "Time and parts on this visit" in visit
    # 4. return visit on the same job, with a part from stock and a one-off part
    _book(c, job_id=jid, contact_id=cust, resource_id=staff, date="2026-11-27", address="Queens Rd")
    v2 = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    assert _one(app, "SELECT COUNT(*) n FROM booking_jobs")["n"] == 1
    assert _one(app, "SELECT status FROM booking_jobs")["status"] == "scheduled"
    c.post(f"/bookings/{v2}/part", data={"item_id": item, "qty": "1"})
    c.post(f"/bookings/{v2}/part", data={"description": "Patch lead", "qty": "2"})
    c.post(f"/bookings/{v2}/finish", data={"outcome": "finished", "hours": "1"})
    assert _one(app, "SELECT status FROM booking_jobs")["status"] == "completed"
    page = c.get(f"/bookings/job/{jid}").get_data(as_text=True)
    assert "Ready to invoice" in c.get("/bookings/jobs").get_data(as_text=True)
    assert "price to add" in page and "What the invoice will charge" in page
    patch = _one(app, "SELECT id FROM booking_materials WHERE description='Patch lead'")["id"]
    c.post(f"/bookings/job/{jid}/part-price", data={f"price_{patch}": "15"})
    # 5. one invoice for both visits: 2.5 h at $120 + the stock item + 2 patch leads
    sell = _one(app, "SELECT sell_price FROM items WHERE id=?", (item,))["sell_price"]
    sell = round(sell * 1.1)  # the till's price: the job invoice is GST-inclusive (F9)
    r = c.post(f"/bookings/job/{jid}/invoice", follow_redirects=True)
    assert "Invoice made" in r.get_data(as_text=True)
    doc = _one(app, "SELECT * FROM documents")
    assert doc["total"] == 30000 + sell + 3000 and doc["reference"] == "Job J-0001"
    assert _one(app, "SELECT COUNT(*) n FROM document_lines")["n"] == 3
    assert _one(app, "SELECT COUNT(*) n FROM bookings WHERE document_id=?", (doc["id"],))["n"] == 2
    # pressing it again (on the job or on a visit) opens the same invoice
    c.post(f"/bookings/job/{jid}/invoice")
    c.post(f"/bookings/{v1}/invoice")
    assert _one(app, "SELECT COUNT(*) n FROM documents")["n"] == 1
    # and the charges are locked
    r = c.post(f"/bookings/{v2}/time", data={"hours": "1"}, headers={"Referer": f"/bookings/{v2}"}, follow_redirects=True)
    assert "already invoiced" in r.get_data(as_text=True)


def test_fixed_price_job_does_not_charge_logged_hours(tmp_path, monkeypatch):
    app, c, item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    c.post("/bookings/setup", data={"mode": "jobs", "open": "07:00", "close": "18:00", "labour_rate": "120"})
    _book(c, contact_id=cust, resource_id=staff, price="450")
    bid = _one(app, "SELECT id FROM bookings")["id"]
    c.post(f"/bookings/{bid}/finish", data={"outcome": "finished", "hours": "3"})
    jid = _one(app, "SELECT job_id FROM bookings")["job_id"]
    page = c.get(f"/bookings/job/{jid}").get_data(as_text=True)
    assert "aren't charged on top" in page and "3 h" in page
    c.post(f"/bookings/{bid}/invoice")
    assert _one(app, "SELECT total FROM documents")["total"] == 45000


def test_time_job_needs_a_labour_rate(tmp_path, monkeypatch):
    app, c, item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    _book(c, contact_id=cust, resource_id=staff)
    bid = _one(app, "SELECT id FROM bookings")["id"]
    jid = _one(app, "SELECT job_id FROM bookings")["job_id"]
    c.post(f"/bookings/job/{jid}", data={"contact_id": cust, "billing": "time"})
    c.post(f"/bookings/{bid}/time", data={"hours": "2"})
    r = c.post(f"/bookings/job/{jid}/invoice", headers={"Referer": f"/bookings/job/{jid}"}, follow_redirects=True)
    assert "hourly labour rate" in r.get_data(as_text=True)
    assert _one(app, "SELECT COUNT(*) n FROM documents")["n"] == 0


def test_return_visit_needs_a_reason(tmp_path, monkeypatch):
    app, c, item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    _book(c, contact_id=cust, resource_id=staff)
    bid = _one(app, "SELECT id FROM bookings")["id"]
    r = c.post(f"/bookings/{bid}/finish", data={"outcome": "no_access"}, headers={"Referer": f"/bookings/{bid}"},
               follow_redirects=True)
    assert "what's still needed" in r.get_data(as_text=True)
    assert _one(app, "SELECT status FROM bookings")["status"] == "booked"


def test_older_bookings_become_jobs(tmp_path, monkeypatch):
    app, c, item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    from riyeser.db import migrate
    with app.app_context():
        db = get_db()
        db.execute("INSERT INTO bookings (contact_id, starts_at, minutes, status, price) VALUES (?, '2026-10-01T09:00', 60,"
                   " 'done', 9900)", (cust,))
        db.commit()
        migrate(db)
    b = _one(app, "SELECT * FROM bookings WHERE price=9900")
    j = _one(app, "SELECT * FROM booking_jobs WHERE id=?", (b["job_id"],))
    assert j["status"] == "completed" and j["price"] == 9900 and j["contact_id"] == cust
    assert "Ready to invoice" in c.get("/bookings/jobs").get_data(as_text=True)
