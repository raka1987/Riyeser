"""Riyeser Bookings, on site: Start / Finish, checklists, parts, photos, the customer's sign-off and lock, the job
sheet PDF and invoicing the job at the job type's or staff member's labour rate."""
import base64
import io

from PIL import Image, ImageDraw

from riyeser.db import get_db
from tests.test_bookings_app import _jobs_setup, _book, _one


def _png_url(ink=True):
    im = Image.new("RGBA", (300, 100), (0, 0, 0, 0))
    if ink:
        ImageDraw.Draw(im).line([(10, 80), (80, 20), (150, 70), (290, 30)], fill=(15, 23, 42, 255), width=3)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _photo(w=3000, h=2000):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (200, 80, 40)).save(buf, "JPEG")
    buf.seek(0)
    return buf


def _visit(tmp_path, monkeypatch, checklist="Turn off the water\nReplace washer\nTest for leaks", billing="time"):
    app, c, item, cust, staff = _jobs_setup(tmp_path, monkeypatch)
    svc = _one(app, "SELECT id FROM booking_services WHERE name='Call-out'")["id"]
    with app.app_context():
        get_db().execute("UPDATE booking_services SET checklist=? WHERE id=?", (checklist, svc))
        get_db().execute("UPDATE company SET bookings_labour_rate=12000")
        get_db().commit()
    _book(c, contact_id=cust, resource_id=staff, service_id=svc, address="1 Main St")
    bid = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    jid = _one(app, "SELECT job_id FROM bookings WHERE id=?", (bid,))["job_id"]
    c.post(f"/bookings/job/{jid}", data={"contact_id": cust, "billing": billing, "address": "1 Main St",
                                           "service_id": svc})
    return app, c, item, cust, staff, svc, bid, jid


def _set_times(app, bid, arrived, left=None):
    with app.app_context():
        get_db().execute("UPDATE bookings SET arrived_at=?, left_at=? WHERE id=?", (arrived, left, bid))
        get_db().commit()


def test_on_site_start_finish_logs_time_on_site(tmp_path, monkeypatch):
    app, c, item, cust, staff, svc, bid, jid = _visit(tmp_path, monkeypatch)
    page = c.get(f"/bookings/{bid}/site").get_data(as_text=True).replace("&#39;", "'")
    assert "Start work" in page and "Turn off the water" in page and "Customer sign-off" in page
    assert "On site" in c.get(f"/bookings/{bid}").get_data(as_text=True).replace("&#39;", "'")     # from the visit
    assert "Coral Coast Hotel" in c.get("/bookings/site?d=2026-11-24").get_data(as_text=True).replace("&#39;", "'")
    r = c.post(f"/bookings/{bid}/site/start", follow_redirects=True)
    assert "Started at" in r.get_data(as_text=True).replace("&#39;", "'")
    b = _one(app, "SELECT * FROM bookings WHERE id=?", (bid,))
    assert b["status"] == "started" and b["arrived_at"] and not b["left_at"]
    assert _one(app, "SELECT status FROM booking_jobs")["status"] == "in_progress"
    _set_times(app, bid, "2026-11-24 09:00:00")         # pretend they arrived at 9
    from riyeser import jobsite
    monkeypatch.setattr(jobsite, "now", lambda: __import__("datetime").datetime(2026, 11, 24, 10, 30))
    r = c.post(f"/bookings/{bid}/site/finish", data={"outcome": "finished"}, follow_redirects=True)
    assert "1 h 30 min on site" in r.get_data(as_text=True).replace("&#39;", "'")
    t = _one(app, "SELECT * FROM booking_time WHERE booking_id=?", (bid,))
    assert t["minutes"] == 90 and t["site"] == 1
    assert _one(app, "SELECT status FROM bookings WHERE id=?", (bid,))["status"] == "done"
    # finishing needs a reason when a return visit is needed
    app2 = _one(app, "SELECT status FROM booking_jobs")
    assert app2["status"] == "completed"


def test_typed_times_replace_the_recorded_ones(tmp_path, monkeypatch):
    app, c, item, cust, staff, svc, bid, jid = _visit(tmp_path, monkeypatch)
    r = c.post(f"/bookings/{bid}/site/times", data={"arrived": "10:00", "left": "09:00"},
               headers={"Referer": f"/bookings/{bid}/site"}, follow_redirects=True)
    assert "must be after" in r.get_data(as_text=True).replace("&#39;", "'")
    c.post(f"/bookings/{bid}/site/times", data={"arrived": "08:15", "left": "09:00"})
    c.post(f"/bookings/{bid}/site/times", data={"arrived": "08:00", "left": "10:00"})
    assert _one(app, "SELECT COUNT(*) n, SUM(minutes) m FROM booking_time WHERE booking_id=?", (bid,))["m"] == 120


def test_checklist_notes_and_parts(tmp_path, monkeypatch):
    app, c, item, cust, staff, svc, bid, jid = _visit(tmp_path, monkeypatch)
    c.get(f"/bookings/{bid}/site")                    # the visit gets its own copy of the job type's checklist
    checks = [r["id"] for r in get_rows(app, "SELECT id FROM booking_checks WHERE booking_id=? ORDER BY pos", (bid,))]
    assert len(checks) == 3
    r = c.post(f"/bookings/{bid}/site/checks", data={"done": [checks[0], checks[2]]}, headers={"X-Requested-With": "fetch"})
    assert r.get_json() == {"ok": True}
    assert [x["done"] for x in get_rows(app, "SELECT done FROM booking_checks ORDER BY pos")] == [1, 0, 1]
    c.post(f"/bookings/{bid}/site/checks", data={"done": [checks[0]], "new_item": "Clean up"})
    assert _one(app, "SELECT COUNT(*) n FROM booking_checks")["n"] == 4
    # changing the checklist in setup later doesn't change a sheet already started
    with app.app_context():
        get_db().execute("UPDATE booking_services SET checklist='Something else' WHERE id=?", (svc,))
        get_db().commit()
    assert "Replace washer" in c.get(f"/bookings/{bid}/site").get_data(as_text=True).replace("&#39;", "'")
    c.post(f"/bookings/{bid}/site/notes", data={"site_notes": "Replaced the tap washer"})
    assert _one(app, "SELECT site_notes FROM bookings WHERE id=?", (bid,))["site_notes"] == "Replaced the tap washer"
    c.post(f"/bookings/{bid}/part", data={"item_id": item, "qty": "2", "back": f"/bookings/{bid}/site#parts"})
    r = c.post(f"/bookings/{bid}/part", data={"description": "Washer kit", "qty": "1", "unit_price": "8.50",
                                             "back": f"/bookings/{bid}/site#parts"})
    assert r.headers["Location"].endswith(f"/bookings/{bid}/site#parts")
    page = c.get(f"/bookings/{bid}/site").get_data(as_text=True).replace("&#39;", "'")
    assert "Washer kit" in page and "Coffee" in page


def get_rows(app, sql, args=()):
    with app.app_context():
        return get_db().execute(sql, args).fetchall()


def test_photos_are_shrunk_and_shown(tmp_path, monkeypatch):
    app, c, item, cust, staff, svc, bid, jid = _visit(tmp_path, monkeypatch)
    r = c.post(f"/bookings/{bid}/site/photo", data={"kind": "before", "caption": "Leak under the sink",
                                                   "photo": (_photo(), "big.jpg")},
               content_type="multipart/form-data", headers={"X-Requested-With": "fetch"})
    assert r.get_json() == {"ok": True}
    p = _one(app, "SELECT * FROM booking_photos")
    assert p["kind"] == "before" and p["caption"] == "Leak under the sink" and p["job_id"] == jid
    assert max(p["width"], p["height"]) == 1600                  # shrunk from 3000 x 2000
    assert Image.open(io.BytesIO(p["thumb"])).size[0] <= 360
    assert c.get(f"/bookings/photo/{p['id']}?thumb=1").mimetype == "image/jpeg"
    assert "Leak under the sink" in c.get(f"/bookings/{bid}/site").get_data(as_text=True).replace("&#39;", "'")
    assert "Leak under the sink" in c.get(f"/bookings/job/{jid}").get_data(as_text=True).replace("&#39;", "'")
    # not a picture: refused, nothing saved
    r = c.post(f"/bookings/{bid}/site/photo", data={"photo": (io.BytesIO(b"not an image"), "x.jpg")},
               content_type="multipart/form-data", headers={"X-Requested-With": "fetch"})
    assert r.status_code == 400 and "isn't a photo" in r.get_json()["error"]
    # a plain form upload (no JavaScript) works too, and captions can change
    c.post(f"/bookings/{bid}/site/photo", data={"kind": "after", "photo": (_photo(800, 600), "a.png")},
           content_type="multipart/form-data")
    after = _one(app, "SELECT id, width FROM booking_photos WHERE kind='after'")
    assert after["width"] == 800
    c.post(f"/bookings/photo/{after['id']}/edit", data={"caption": "All dry", "kind": "after"})
    assert _one(app, "SELECT caption FROM booking_photos WHERE id=?", (after["id"],))["caption"] == "All dry"


def test_sign_off_locks_the_sheet_and_a_manager_unlocks_it(tmp_path, monkeypatch):
    app, c, item, cust, staff, svc, bid, jid = _visit(tmp_path, monkeypatch)
    ref = {"Referer": f"/bookings/{bid}/site"}
    r = c.post(f"/bookings/{bid}/site/sign", data={"name": "Jo", "signature": _png_url(ink=False)}, headers=ref,
               follow_redirects=True)
    assert "sign in the box first" in r.get_data(as_text=True).replace("&#39;", "'")
    r = c.post(f"/bookings/{bid}/site/sign", data={"name": "", "signature": _png_url()}, headers=ref,
               follow_redirects=True)
    assert "customer's name" in r.get_data(as_text=True).replace("&#39;", "'")
    r = c.post(f"/bookings/{bid}/site/sign", data={"name": "Jo Manager", "signature": _png_url()}, follow_redirects=True)
    assert "Signed by Jo Manager" in r.get_data(as_text=True).replace("&#39;", "'")
    s = _one(app, "SELECT * FROM booking_signoffs")
    assert s["status"] == "signed" and s["image"].startswith(b"\x89PNG") and s["signed_at"]
    assert c.get(f"/bookings/signature/{s['id']}").mimetype == "image/png"
    # locked: no more notes, parts, time or photos on this visit
    for url, data in ((f"/bookings/{bid}/site/notes", {"site_notes": "x"}), (f"/bookings/{bid}/part", {"description": "x"}),
                      (f"/bookings/{bid}/time", {"hours": "1"}), (f"/bookings/{bid}/site/start", {})):
        r = c.post(url, data=data, headers=ref, follow_redirects=True)
        assert "locked" in r.get_data(as_text=True).replace("&#39;", "'"), url
    assert _one(app, "SELECT COUNT(*) n FROM booking_materials")["n"] == 0
    assert "Start work" not in c.get(f"/bookings/{bid}/site").get_data(as_text=True).replace("&#39;", "'")
    # a worker (Add & edit on Bookings) can't unlock it alone, but can with a manager's user name and password
    import json
    from werkzeug.security import generate_password_hash
    with app.app_context():
        db = get_db()
        db.execute("INSERT INTO users (username, password_hash, role, perms) VALUES ('sam', ?, 'accountant', ?)",
                   (generate_password_hash("sam-pass"), json.dumps({"bookings": 2, "sales": 2})))
        db.commit()
    w = app.test_client()
    w.post("/login", data={"username": "sam", "password": "sam-pass"})
    ref = {"Referer": f"/bookings/{bid}/site"}
    r = w.post(f"/bookings/{bid}/site/unlock", data={"reason": "Extra part"}, headers=ref, follow_redirects=True)
    assert "Only a manager" in r.get_data(as_text=True).replace("&#39;", "'")
    r = w.post(f"/bookings/{bid}/site/unlock", data={"reason": "Extra part", "manager": "sam", "password": "sam-pass"},
               headers=ref, follow_redirects=True)
    assert "isn't a manager" in r.get_data(as_text=True).replace("&#39;", "'")
    assert _one(app, "SELECT status FROM booking_signoffs")["status"] == "signed"
    r = w.post(f"/bookings/{bid}/site/unlock", data={"reason": "Extra part", "manager": "admin", "password": "admin"},
               headers=ref, follow_redirects=True)
    assert "Unlocked by admin" in r.get_data(as_text=True).replace("&#39;", "'")
    s = _one(app, "SELECT s.*, u.username FROM booking_signoffs s JOIN users u ON u.id=s.unlocked_by")
    assert s["status"] == "unlocked" and s["unlock_reason"] == "Extra part" and s["username"] == "admin"
    assert _one(app, "SELECT COUNT(*) n FROM audit_log WHERE action='booking_unlock'")["n"] == 1
    assert "Earlier signature by Jo Manager" in w.get(f"/bookings/{bid}/site").get_data(as_text=True).replace("&#39;", "'")
    w.post(f"/bookings/{bid}/part", data={"description": "Extra part", "qty": "1"})
    assert _one(app, "SELECT COUNT(*) n FROM booking_materials")["n"] == 1


def test_job_sheet_pdf_and_email(tmp_path, monkeypatch):
    from pypdf import PdfReader
    app, c, item, cust, staff, svc, bid, jid = _visit(tmp_path, monkeypatch)
    c.get(f"/bookings/{bid}/site")
    c.post(f"/bookings/{bid}/site/times", data={"arrived": "08:00", "left": "09:45"})
    c.post(f"/bookings/{bid}/site/notes", data={"site_notes": "Replaced the tap washer"})
    first = _one(app, "SELECT id FROM booking_checks ORDER BY pos")["id"]
    c.post(f"/bookings/{bid}/site/checks", data={"done": [first]})
    c.post(f"/bookings/{bid}/part", data={"description": "Washer kit", "qty": "3", "unit_price": "8.50"})
    c.post(f"/bookings/{bid}/site/photo", data={"kind": "before", "caption": "Dripping tap", "photo": (_photo(), "b.jpg")},
           content_type="multipart/form-data")
    c.post(f"/bookings/{bid}/site/sign", data={"name": "Jo Manager", "signature": _png_url()})
    r = c.get(f"/bookings/job/{jid}/sheet.pdf")
    assert r.mimetype == "application/pdf"
    pdf = PdfReader(io.BytesIO(r.data))
    text = " ".join(p.extract_text() for p in pdf.pages)
    for words in ("Job sheet", "J-0001", "Coral Coast Hotel", "1 Main St", "Started 08:00", "finished 09:45",
                  "1 h 45 min", "Replaced the tap washer", "Turn off the water", "(not done)", "Washer kit",
                  "Dripping tap", "Signed by Jo Manager"):
        assert words in text, words
    assert sum(len(p.images) for p in pdf.pages) >= 2          # the photo and the signature
    # email: needs email set up; with it, the PDF goes as an attachment
    r = c.post(f"/bookings/job/{jid}/sheet/email", data={"to": "jo@example.com"},
               headers={"Referer": f"/bookings/job/{jid}"}, follow_redirects=True)
    assert "isn't set up" in r.get_data(as_text=True).replace("&#39;", "'")
    from riyeser import mailer
    sent = []
    monkeypatch.setattr(mailer, "settings", lambda db: {"host": "x"})
    monkeypatch.setattr(mailer, "send_pending", lambda db: (sent.append(1) or 1, 0))
    r = c.post(f"/bookings/job/{jid}/sheet/email", data={"to": "jo@example.com"}, follow_redirects=True)
    assert "Emailed to jo@example.com" in r.get_data(as_text=True).replace("&#39;", "'")
    q = _one(app, "SELECT * FROM email_queue WHERE kind='job_sheet'")
    assert q["to_addr"] == "jo@example.com" and "J-0001" in q["subject"]


def test_invoice_this_job_uses_job_type_or_staff_rates(tmp_path, monkeypatch):
    app, c, item, cust, staff, svc, bid, jid = _visit(tmp_path, monkeypatch)
    # the staff member's rate ($90) beats the company's ($120)
    form = {"mode": "jobs", "open": "07:00", "close": "18:00", "labour_rate": "120", f"res_rate_{staff}": "90"}
    c.post("/bookings/setup", data=form)
    assert _one(app, "SELECT labour_rate FROM booking_resources WHERE id=?", (staff,))["labour_rate"] == 9000
    c.post(f"/bookings/{bid}/site/times", data={"arrived": "08:00", "left": "10:00"})
    c.post(f"/bookings/{bid}/part", data={"description": "Washer kit", "qty": "2", "unit_price": "10"})
    page = c.get(f"/bookings/{bid}/site").get_data(as_text=True).replace("&#39;", "'")
    assert "Invoice this job" in page and "$200.00" in page      # 2 h x $90 + 2 x $10
    # the job type's rate ($150) beats the staff member's; the checklist is saved from setup too
    c.post("/bookings/setup", data={**form, f"svc_rate_{svc}": "150", f"svc_check_{svc}": "Check A\n\n- Check B"})
    s = _one(app, "SELECT labour_rate, checklist FROM booking_services WHERE id=?", (svc,))
    assert s["labour_rate"] == 15000 and s["checklist"] == "Check A\nCheck B"
    c.post(f"/bookings/{bid}/site/sign", data={"name": "Jo Manager", "signature": _png_url()})
    r = c.post(f"/bookings/job/{jid}/invoice", follow_redirects=True)
    assert "Invoice made" in r.get_data(as_text=True).replace("&#39;", "'")
    doc = _one(app, "SELECT * FROM documents")
    assert doc["total"] == 30000 + 2000 and doc["reference"] == "Job J-0001"
    assert "Job sheet signed by Jo Manager" in doc["notes"]
    assert _one(app, "SELECT document_id FROM booking_jobs WHERE id=?", (jid,))["document_id"] == doc["id"]
    lines = get_rows(app, "SELECT description, qty, unit_price FROM document_lines ORDER BY id")
    assert lines[0]["description"].startswith("Labour") and lines[0]["qty"] == 2 and lines[0]["unit_price"] == 15000
    # invoiced: the sheet is closed
    assert "Open invoice" in c.get(f"/bookings/{bid}/site").get_data(as_text=True).replace("&#39;", "'")


def test_two_staff_rates_make_two_labour_lines(tmp_path, monkeypatch):
    app, c, item, cust, staff, svc, bid, jid = _visit(tmp_path, monkeypatch)
    with app.app_context():
        db = get_db()
        other = db.execute("INSERT INTO booking_resources (name, kind, labour_rate) VALUES ('Apprentice', 'staff', 6000)"
                           ).lastrowid
        db.execute("UPDATE booking_resources SET labour_rate=10000 WHERE id=?", (staff,))
        db.commit()
    _book(c, job_id=jid, contact_id=cust, resource_id=other, date="2026-11-25")
    v2 = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    c.post(f"/bookings/{bid}/site/times", data={"arrived": "08:00", "left": "09:00"})
    c.post(f"/bookings/{v2}/site/times", data={"arrived": "08:00", "left": "10:00"})
    c.post(f"/bookings/job/{jid}/invoice")
    lines = get_rows(app, "SELECT description, qty, unit_price FROM document_lines ORDER BY id")
    assert [(l["qty"], l["unit_price"]) for l in lines] == [(1, 10000), (2, 6000)]
    assert "(Apprentice)" in lines[1]["description"]
    assert _one(app, "SELECT total FROM documents")["total"] == 22000


def test_viewer_can_look_but_not_record(tmp_path, monkeypatch):
    app, c, item, cust, staff, svc, bid, jid = _visit(tmp_path, monkeypatch)
    from werkzeug.security import generate_password_hash
    with app.app_context():
        get_db().execute("INSERT INTO users (username, password_hash, role) VALUES ('vee', ?, 'viewer')",
                         (generate_password_hash("vee-pass"),))
        get_db().commit()
    v = app.test_client()
    v.post("/login", data={"username": "vee", "password": "vee-pass"})
    page = v.get(f"/bookings/{bid}/site").get_data(as_text=True).replace("&#39;", "'")
    assert "Time on site" in page and "▶ Start work" not in page and "<canvas" not in page
    v.post(f"/bookings/{bid}/site/start")
    assert _one(app, "SELECT arrived_at FROM bookings WHERE id=?", (bid,))["arrived_at"] is None


def test_demo_has_on_site_job_sheets(tmp_path, monkeypatch):
    from tests.test_pos_app import make
    from riyeser.demo import seed_demo
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    with app.app_context():
        seed_demo(get_db())
    assert _one(app, "SELECT COUNT(*) n FROM booking_photos")["n"] >= 2
    assert _one(app, "SELECT COUNT(*) n FROM booking_signoffs WHERE status='signed'")["n"] >= 1
    assert _one(app, "SELECT COUNT(*) n FROM booking_services WHERE checklist IS NOT NULL")["n"] >= 1
    jid = _one(app, "SELECT job_id FROM booking_signoffs")["job_id"]
    assert c.get(f"/bookings/job/{jid}/sheet.pdf").mimetype == "application/pdf"
    bid = _one(app, "SELECT booking_id FROM booking_signoffs")["booking_id"]
    assert "Signed by" in c.get(f"/bookings/{bid}/site").get_data(as_text=True).replace("&#39;", "'")
