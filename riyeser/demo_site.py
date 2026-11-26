"""Demo data for Riyeser Bookings on site: checklists, a finished and signed job sheet with before/after photos,
parts and time on site, ready to invoice, plus today's visit with its checklist ready to tick. Practice data only."""
import io
from datetime import date, datetime, timedelta

from .db import to_cents

CHECKLISTS = {
    "Call-out": "Check in with the customer\nTurn off the water at the meter\nFind and fix the fault\n"
                "Test for leaks\nClean up and show the customer",
    "Half day": "Check in with the customer\nIsolate the system\nService the pump and filters\nTest pressure\n"
                "Clean up and show the customer",
    "Full day": "Site induction\nIsolate the system\nInstall\nPressure test\nShow the customer how it works\n"
                "Clean up",
}


def _picture(before):
    """A made-up photo: a pipe that drips (before) or is dry (after), marked as a demo picture."""
    from PIL import Image, ImageDraw
    w, h = 1200, 900
    im = Image.new("RGB", (w, h), (226, 232, 240) if not before else (214, 196, 170))
    d = ImageDraw.Draw(im)
    for y in range(0, h, 60):  # tiles
        d.line([(0, y), (w, y)], fill=(203, 213, 225) if not before else (190, 170, 140), width=3)
    d.rectangle([0, 380, w, 470], fill=(148, 163, 184) if not before else (150, 110, 70))
    d.rectangle([520, 330, 680, 520], fill=(100, 116, 139) if not before else (120, 80, 45))
    if before:
        for i, x in enumerate((585, 610, 640)):
            d.ellipse([x - 14, 560 + i * 70, x + 14, 600 + i * 70], fill=(37, 99, 235))
        d.ellipse([480, 780, 760, 860], fill=(96, 165, 250))
    else:
        d.rectangle([505, 320, 695, 335], fill=(22, 163, 74))
    d.rectangle([20, 20, 300, 80], fill=(255, 255, 255))
    d.text((36, 40), ("BEFORE" if before else "AFTER") + "  (demo photo)", fill=(15, 23, 42))
    out = io.BytesIO()
    im.save(out, "JPEG", quality=80)
    return out.getvalue()


def _signature():
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (600, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pts = [(40, 140), (70, 60), (95, 150), (120, 70), (150, 140), (190, 90), (230, 120), (270, 80), (320, 130),
           (360, 95), (420, 120), (480, 100), (560, 110)]
    d.line(pts, fill=(15, 23, 42, 255), width=4, joint="curve")
    d.line([(60, 165), (540, 160)], fill=(15, 23, 42, 255), width=2)
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


def seed_job_sheets(db, staff, svc, customers, admin):
    from .jobsite import shrink, checklist_items
    from .views.bookings import refresh_job
    for name, items in CHECKLISTS.items():
        db.execute("UPDATE booking_services SET checklist=? WHERE name=? AND checklist IS NULL", (items, name))
    if not db.execute("SELECT bookings_labour_rate FROM company WHERE id=1").fetchone()[0]:
        db.execute("UPDATE company SET bookings_labour_rate=? WHERE id=1", (to_cents(110),))
    if not staff or not customers:
        return
    # a job finished yesterday, signed by the customer, charged as time and materials: ready to invoice
    day = date.today() - timedelta(days=1)
    cid = customers[2 % len(customers)]
    addr = "5 Placeholder Ave, Sampletown"
    jid = db.execute("INSERT INTO booking_jobs (contact_id, service_id, title, address, billing, created_by)"
                     " VALUES (?,?,?,?,'time',?)", (cid, svc["Call-out"], "Hot water leak in the laundry", addr,
                                                    admin)).lastrowid
    arrived, left = datetime.combine(day, datetime.min.time()).replace(hour=9, minute=5), None
    left = arrived + timedelta(minutes=95)
    bid = db.execute("INSERT INTO bookings (contact_id, resource_id, service_id, starts_at, minutes, title, address,"
                     " status, outcome, outcome_note, job_id, mode, created_by, arrived_at, left_at, site_notes)"
                     " VALUES (?,?,?,?,?,?,?,'done','finished',NULL,?,'jobs',?,?,?,?)",
                     (cid, staff[1 % len(staff)], svc["Call-out"], f"{day.isoformat()}T09:00", 60,
                      "Hot water leak in the laundry", addr, jid, admin, arrived.isoformat(sep=" "),
                      left.isoformat(sep=" "),
                      "Found a split flexible hose under the laundry tub. Replaced the hose and the isolation valve, "
                      "checked the hot water unit's relief valve. No more leaks.")).lastrowid
    db.execute("INSERT INTO booking_time (job_id, booking_id, user_id, minutes, note, site) VALUES (?,?,?,?,?,1)",
               (jid, bid, admin, 95, "Time on site"))
    for i, item in enumerate(checklist_items(CHECKLISTS["Call-out"])):
        db.execute("INSERT INTO booking_checks (booking_id, job_id, pos, item, done, done_at, user_id)"
                   " VALUES (?,?,?,?,1,?,?)", (bid, jid, i, item, (arrived + timedelta(minutes=10 + 15 * i))
                                               .isoformat(sep=" "), admin))
    for desc, qty, price in (("Flexible hose 450 mm", 1, 24.50), ("Isolation valve 15 mm", 1, 32.00),
                             ("Thread tape", 1, 3.50)):
        db.execute("INSERT INTO booking_materials (job_id, booking_id, description, qty, unit_price, user_id)"
                   " VALUES (?,?,?,?,?,?)", (jid, bid, desc, qty, to_cents(price), admin))
    for kind, caption in (("before", "Split hose under the laundry tub"), ("after", "New hose and valve, all dry")):
        data, thumb, w, h = shrink(_picture(kind == "before"))
        db.execute("INSERT INTO booking_photos (job_id, booking_id, kind, caption, mime, data, thumb, width, height,"
                   " user_id) VALUES (?,?,?,?,?,?,?,?,?,?)", (jid, bid, kind, caption, "image/jpeg", data, thumb, w, h,
                                                              admin))
    cname = db.execute("SELECT name FROM contacts WHERE id=?", (cid,)).fetchone()[0]
    db.execute("INSERT INTO booking_signoffs (job_id, booking_id, name, signed_at, image, user_id) VALUES (?,?,?,?,?,?)",
               (jid, bid, cname, (left + timedelta(minutes=2)).isoformat(sep=" "), _signature(), admin))
    refresh_job(db, jid)
