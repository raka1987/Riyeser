"""Riyeser Bookings: book and schedule jobs, appointments or restaurant tables, then invoice them.

One app for three kinds of business, chosen under Bookings setup (company.bookings_mode):
  * jobs          trades and site work: a job at the customer's address, given to a staff member
  * appointments  salons, clinics, consultants: a service at a time, with a staff member
  * tables        cafes and restaurants: a table for a party at a time
Bookings live in the same company file as Riyeser Accounting, Invoices and POS: customers are shared, and
"Invoice" on a booking makes a real invoice there. Staff are bookable resources (staff, tables, rooms, vehicles).
"""
from datetime import date, datetime, timedelta

from flask import Blueprint, render_template, request, redirect, url_for, flash, g, abort

from ..db import get_db, audit, to_cents
from ..ledger import save_document, PostingError
from . import guarded, opt_int

bp = Blueprint("bookings", __name__, url_prefix="/bookings")

MODES = {
    "jobs": dict(name="Trades & site jobs", one="job", many="jobs", who="Staff", who_one="staff member",
                 what="Job type", kind="staff", address=True, party=False, minutes=120,
                 starter_who=["Staff 1"], starter_what=[("Call-out", 60, 0), ("Half day", 240, 0), ("Full day", 480, 0)]),
    "appointments": dict(name="Appointments", one="appointment", many="appointments", who="Staff", who_one="staff member",
                         what="Service", kind="staff", address=False, party=False, minutes=60,
                         starter_who=["Staff 1"], starter_what=[("Consultation", 30, 0), ("Standard appointment", 60, 0)]),
    "tables": dict(name="Restaurant tables", one="booking", many="bookings", who="Tables", who_one="table",
                   what="Sitting", kind="table", address=False, party=True, minutes=90,
                   starter_who=["Table 1", "Table 2", "Table 3", "Table 4"], starter_what=[]),
}
STATUSES = [("booked", "Booked"), ("confirmed", "Confirmed"), ("started", "In progress"), ("done", "Done"),
            ("cancelled", "Cancelled"), ("no_show", "No-show")]
ACTIVE = ("booked", "confirmed", "started", "done")
COLOURS = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#dc2626", "#0891b2", "#db2777", "#65a30d"]
SLOT = 30  # minutes per row on the day view


def mode(db=None):
    c = g.get("company") or {}
    m = c.get("bookings_mode") if hasattr(c, "get") else None
    return m if m in MODES else "jobs"


def M():
    return MODES[mode()]


def _hours(db):
    raw = (g.get("company") or {}).get("bookings_hours") or "07:00-18:00"
    try:
        a, b = raw.split("-")
        h1, h2 = int(a.split(":")[0]), int(b.split(":")[0]) + (1 if b.split(":")[1] != "00" else 0)
        if 0 <= h1 < h2 <= 24:
            return h1, h2
    except (ValueError, IndexError):
        pass
    return 7, 18


def _day(v):
    try:
        return date.fromisoformat(v) if v else date.today()
    except ValueError:
        return date.today()


def resources(db, all_=False):
    return db.execute("SELECT * FROM booking_resources" + ("" if all_ else " WHERE active=1") + " ORDER BY id").fetchall()


def services(db, all_=False):
    return db.execute("SELECT s.*, i.name item_name FROM booking_services s LEFT JOIN items i ON i.id=s.item_id"
                      + ("" if all_ else " WHERE s.active=1") + " ORDER BY s.name").fetchall()


def ensure_started(db):
    """First time in: add starter staff/tables and services for this kind of business (all can be renamed)."""
    if db.execute("SELECT 1 FROM booking_resources").fetchone():
        return
    m = M()
    for i, name in enumerate(m["starter_who"]):
        db.execute("INSERT INTO booking_resources (name, kind, capacity, colour) VALUES (?,?,?,?)",
                   (name, m["kind"], 4 if m["kind"] == "table" else None, COLOURS[i % len(COLOURS)]))
    for name, mins, price in m["starter_what"]:
        db.execute("INSERT INTO booking_services (name, minutes, price) VALUES (?,?,?)", (name, mins, price))
    db.commit()


def day_bookings(db, d, d2=None):
    d2 = d2 or d + timedelta(days=1)
    return db.execute("""SELECT b.*, c.name customer, r.name resource, r.colour, s.name service, doc.number inv_no,
                                doc.status inv_status
                         FROM bookings b LEFT JOIN contacts c ON c.id=b.contact_id
                         LEFT JOIN booking_resources r ON r.id=b.resource_id LEFT JOIN booking_services s ON s.id=b.service_id
                         LEFT JOIN documents doc ON doc.id=b.document_id
                         WHERE b.starts_at >= ? AND b.starts_at < ? ORDER BY b.starts_at""",
                      (d.isoformat(), d2.isoformat())).fetchall()


def ends(b):
    return datetime.fromisoformat(b["starts_at"]) + timedelta(minutes=b["minutes"] or 0)


def clash(db, resource_id, start, minutes, skip_id=None):
    """Another live booking on the same staff member or table that overlaps this time."""
    if not resource_id:
        return None
    end = start + timedelta(minutes=minutes)
    rows = db.execute("SELECT b.*, c.name customer FROM bookings b LEFT JOIN contacts c ON c.id=b.contact_id"
                      " WHERE b.resource_id=? AND b.status IN ('booked','confirmed','started') AND b.id IS NOT ?"
                      " AND b.starts_at < ? AND b.starts_at >= ?",
                      (resource_id, skip_id, end.isoformat(timespec="minutes"),
                       (start - timedelta(days=1)).isoformat(timespec="minutes"))).fetchall()
    for r in rows:
        if ends(r) > start:
            return r
    return None


def plan_check(db):
    from .. import plan as P
    if P.plan(db, "bookings")["locked"]:
        raise PostingError(P.capped_message("bookings"))


# ---------------------------------------------------------------- calendar

@bp.route("/")
def calendar():
    db = get_db()
    ensure_started(db)
    d = _day(request.args.get("d"))
    h1, h2 = _hours(db)
    res = resources(db)
    rows = day_bookings(db, d)
    cols = [{"id": r["id"], "name": r["name"], "colour": r["colour"] or COLOURS[0], "capacity": r["capacity"], "items": []}
            for r in res]
    spare = {"id": None, "name": "Not given to anyone yet", "colour": "#64748b", "items": []}
    by_id = {c["id"]: c for c in cols}
    first, last = h1 * 60, h2 * 60
    for b in rows:
        st = datetime.fromisoformat(b["starts_at"])
        mins = st.hour * 60 + st.minute
        first, last = min(first, mins - mins % 60), max(last, mins + (b["minutes"] or 0))
    for b in rows:
        st = datetime.fromisoformat(b["starts_at"])
        top = (st.hour * 60 + st.minute - first) / SLOT
        item = dict(b=b, top=top, height=max((b["minutes"] or SLOT) / SLOT, 1), start=st.strftime("%H:%M"),
                    end=ends(b).strftime("%H:%M"))
        (by_id.get(b["resource_id"]) or spare)["items"].append(item)
    if spare["items"]:
        cols.append(spare)
    slots = [(first + i * SLOT) for i in range((last - first + SLOT - 1) // SLOT)]
    counts = {k: sum(1 for b in rows if b["status"] == k) for k, _ in STATUSES}
    return render_template("bookings/calendar.html", d=d, cols=cols, slots=slots, rows=rows, counts=counts, m=M(),
                           prev=d - timedelta(days=1), next=d + timedelta(days=1), today=date.today(),
                           statuses=dict(STATUSES))


@bp.route("/week")
def week():
    db = get_db()
    ensure_started(db)
    d = _day(request.args.get("d"))
    start = d - timedelta(days=d.weekday())
    rows = day_bookings(db, start, start + timedelta(days=7))
    days = []
    for i in range(7):
        day = start + timedelta(days=i)
        days.append((day, [b for b in rows if b["starts_at"][:10] == day.isoformat()]))
    return render_template("bookings/week.html", days=days, start=start, m=M(), statuses=dict(STATUSES),
                           prev=start - timedelta(days=7), next=start + timedelta(days=7), today=date.today())


@bp.route("/list")
def upcoming():
    db = get_db()
    q = request.args.get("q", "").strip()
    show = request.args.get("show", "upcoming")
    sql = ("SELECT b.*, c.name customer, r.name resource, s.name service, doc.number inv_no FROM bookings b"
           " LEFT JOIN contacts c ON c.id=b.contact_id LEFT JOIN booking_resources r ON r.id=b.resource_id"
           " LEFT JOIN booking_services s ON s.id=b.service_id LEFT JOIN documents doc ON doc.id=b.document_id WHERE 1=1")
    args = []
    if show == "upcoming":
        sql += " AND b.starts_at >= ? AND b.status IN ('booked','confirmed','started')"
        args.append(date.today().isoformat())
    elif show == "to_invoice":
        sql += " AND b.status='done' AND b.document_id IS NULL"
    if q:
        sql += " AND (c.name LIKE ? OR b.title LIKE ? OR b.address LIKE ? OR b.phone LIKE ?)"
        args += [f"%{q}%"] * 4
    sql += " ORDER BY b.starts_at" + (" DESC" if show == "all" else "") + " LIMIT 500"
    return render_template("bookings/list.html", rows=db.execute(sql, args).fetchall(), q=q, show=show, m=M(),
                           statuses=dict(STATUSES))


# ---------------------------------------------------------------- one booking

def _form_lookups(db):
    return dict(res=resources(db), svcs=services(db), m=M(), statuses=STATUSES,
                customers=db.execute("SELECT id, name, phone, address FROM contacts WHERE kind='customer' AND active=1"
                                     " ORDER BY name").fetchall())


@bp.route("/new", methods=["GET", "POST"])
@bp.route("/<int:bid>", methods=["GET", "POST"])
def edit(bid=None):
    db = get_db()
    ensure_started(db)
    b = db.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone() if bid else None
    if bid and not b:
        abort(404)
    if request.method == "POST":
        return _save(bid)
    pre = dict(date=request.args.get("d") or date.today().isoformat(), time=request.args.get("t") or "",
               resource_id=opt_int(request.args.get("r")), contact_id=opt_int(request.args.get("c")))
    inv = None
    if b and b["document_id"]:
        inv = db.execute("SELECT id, number, status, total, amount_paid FROM documents WHERE id=?", (b["document_id"],)).fetchone()
    return render_template("bookings/edit.html", b=b, pre=pre, inv=inv, **_form_lookups(db))


@guarded
def _save(bid):
    db = get_db()
    f = request.form
    m = M()
    if not bid:
        plan_check(db)
    cid = opt_int(f.get("contact_id"))
    new_name = (f.get("new_customer") or "").strip()
    if not cid and new_name:
        cid = db.execute("INSERT INTO contacts (kind, name, phone, address) VALUES ('customer',?,?,?)",
                         (new_name, f.get("phone") or None, f.get("address") or None)).lastrowid
    if not cid and not (f.get("title") or "").strip():
        raise PostingError("Choose a customer, add a new one, or give the " + m["one"] + " a name.")
    try:
        start = datetime.fromisoformat(f"{f.get('date')}T{f.get('time') or '09:00'}")
    except ValueError:
        raise PostingError("Enter a date and time.")
    svc = db.execute("SELECT * FROM booking_services WHERE id=?", (opt_int(f.get("service_id")),)).fetchone()
    minutes = opt_int(f.get("minutes")) or (svc["minutes"] if svc else m["minutes"])
    if minutes <= 0 or minutes > 24 * 60 * 14:
        raise PostingError("How long should it take? Enter the minutes.")
    rid = opt_int(f.get("resource_id"))
    status = f.get("status") if f.get("status") in dict(STATUSES) else "booked"
    party = opt_int(f.get("party")) if m["party"] else None
    if status in ("booked", "confirmed", "started"):
        other = clash(db, rid, start, minutes, bid)
        if other and not f.get("allow_overlap"):
            raise PostingError(f"That {m['who_one']} already has {other['customer'] or other['title'] or 'a booking'} "
                               f"at {other['starts_at'][11:16]}. Pick another time or {m['who_one']}, or tick "
                               "'Allow double-booking'.")
    if m["party"] and rid and party:
        cap = db.execute("SELECT capacity FROM booking_resources WHERE id=?", (rid,)).fetchone()
        if cap and cap["capacity"] and party > cap["capacity"] and not f.get("allow_overlap"):
            raise PostingError(f"That table seats {cap['capacity']}. Pick a bigger table, or tick 'Allow double-booking' "
                               "to book it anyway.")
    vals = (cid, rid, svc["id"] if svc else None, start.isoformat(timespec="minutes"), minutes,
            (f.get("title") or "").strip() or None, (f.get("address") or "").strip() or None, party,
            (f.get("phone") or "").strip() or None, (f.get("notes") or "").strip() or None, status)
    if bid:
        db.execute("UPDATE bookings SET contact_id=?, resource_id=?, service_id=?, starts_at=?, minutes=?, title=?,"
                   " address=?, party=?, phone=?, notes=?, status=?, updated_at=datetime('now','localtime') WHERE id=?",
                   vals + (bid,))
        audit(db, "booking_edit", f"#{bid}")
    else:
        bid = db.execute("INSERT INTO bookings (contact_id, resource_id, service_id, starts_at, minutes, title, address,"
                         " party, phone, notes, status, mode, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         vals + (mode(), g.user["id"])).lastrowid
        audit(db, "booking_new", f"#{bid} {start:%Y-%m-%d %H:%M}")
    flash(f"{m['one'].capitalize()} saved.", "ok")
    return redirect(url_for("bookings.calendar", d=start.date().isoformat()))


@bp.route("/<int:bid>/status", methods=["POST"])
@guarded
def set_status(bid):
    db = get_db()
    st = request.form.get("status")
    if st not in dict(STATUSES):
        abort(400)
    b = db.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone() or abort(404)
    db.execute("UPDATE bookings SET status=?, updated_at=datetime('now','localtime') WHERE id=?", (st, bid))
    audit(db, "booking_status", f"#{bid} {st}")
    flash(f"Marked {dict(STATUSES)[st].lower()}.", "ok")
    return redirect(request.form.get("back") or url_for("bookings.calendar", d=b["starts_at"][:10]))


def _income_account(db):
    """Sales - Services (4-2000) if the company has it, else the default income account."""
    r = db.execute("SELECT id FROM accounts WHERE code='4-2000'").fetchone() or \
        db.execute("SELECT account_id id FROM linked_accounts WHERE key='default_income'").fetchone() or \
        db.execute("SELECT id FROM accounts WHERE type='income' ORDER BY code").fetchone()
    return r["id"] if r else None


def _gst(db):
    if not (g.get("company") or {}).get("gst_registered", 1):
        r = db.execute("SELECT id FROM tax_codes WHERE code='FRE'").fetchone()
        return r["id"] if r else None
    r = db.execute("SELECT id FROM tax_codes WHERE code='GST'").fetchone()
    return r["id"] if r else None


@bp.route("/<int:bid>/invoice", methods=["POST"])
@guarded
def invoice(bid):
    """Make a customer invoice from a booking, in the same company file as Riyeser Accounting and Invoices."""
    db = get_db()
    b = db.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone() or abort(404)
    if b["document_id"]:
        return redirect(url_for("documents.view", doc_id=b["document_id"]))
    if not b["contact_id"]:
        raise PostingError("Choose the customer on this booking first, then invoice it.")
    svc = db.execute("SELECT * FROM booking_services WHERE id=?", (b["service_id"],)).fetchone() if b["service_id"] else None
    st = datetime.fromisoformat(b["starts_at"])
    what = (svc["name"] if svc else None) or b["title"] or M()["one"].capitalize()
    desc = f"{what} — {st:%a %d %b %Y}" + (f", {b['address']}" if b["address"] else "")
    line = dict(description=desc, qty=1, unit_price=svc["price"] if svc else 0, discount_pct=0,
                tax_code_id=_gst(db), item_id=svc["item_id"] if svc and svc["item_id"] else None)
    if not line["item_id"]:
        line["account_id"] = _income_account(db)
    if svc and svc["item_id"]:
        item = db.execute("SELECT sell_price, sale_tax_code_id FROM items WHERE id=?", (svc["item_id"],)).fetchone()
        if item and not line["unit_price"]:
            line["unit_price"] = item["sell_price"] or 0
        if item and item["sale_tax_code_id"]:
            line["tax_code_id"] = item["sale_tax_code_id"]
    terms = (g.get("company") or {}).get("default_terms_days") or 14
    today = date.today()
    doc_id = save_document(db, "sale", dict(contact_id=b["contact_id"], date=today.isoformat(),
                                            due_date=(today + timedelta(days=terms)).isoformat(),
                                            reference=f"Booking {bid}", notes=b["notes"] or "", tax_inclusive=True),
                           [line], "open")
    db.execute("UPDATE bookings SET document_id=?, status=CASE WHEN status IN ('booked','confirmed','started')"
               " THEN 'done' ELSE status END, updated_at=datetime('now','localtime') WHERE id=?", (doc_id, bid))
    audit(db, "booking_invoice", f"#{bid} -> document {doc_id}")
    flash("Invoice made. Check the price, then save or send it.", "ok")
    return redirect(url_for("documents.view", doc_id=doc_id))


# ---------------------------------------------------------------- setup

@bp.route("/setup", methods=["GET", "POST"])
def setup():
    db = get_db()
    ensure_started(db)
    if request.method == "POST":
        return _save_setup()
    items = db.execute("SELECT id, name FROM items WHERE is_sold=1 ORDER BY name").fetchall()
    return render_template("bookings/setup.html", res=resources(db, True), svcs=services(db, True), modes=MODES,
                           here=mode(), m=M(), items=items, hours=(g.company.get("bookings_hours") or "07:00-18:00"),
                           colours=COLOURS)


@guarded
def _save_setup():
    db = get_db()
    f = request.form
    if f.get("mode") in MODES:
        db.execute("UPDATE company SET bookings_mode=? WHERE id=1", (f["mode"],))
    h1, h2 = f.get("open") or "07:00", f.get("close") or "18:00"
    if h1 >= h2:
        raise PostingError("Closing time must be after opening time.")
    db.execute("UPDATE company SET bookings_hours=? WHERE id=1", (f"{h1}-{h2}",))
    for r in resources(db, True):
        name = (f.get(f"res_name_{r['id']}") or "").strip()
        if name:
            db.execute("UPDATE booking_resources SET name=?, capacity=?, colour=?, active=? WHERE id=?",
                       (name, opt_int(f.get(f"res_cap_{r['id']}")), f.get(f"res_col_{r['id']}") or r["colour"],
                        1 if f.get(f"res_on_{r['id']}") else 0, r["id"]))
    if (f.get("res_new") or "").strip():
        n = db.execute("SELECT COUNT(*) FROM booking_resources").fetchone()[0]
        kind = MODES[f.get("mode") if f.get("mode") in MODES else mode()]["kind"]
        db.execute("INSERT INTO booking_resources (name, kind, capacity, colour) VALUES (?,?,?,?)",
                   (f["res_new"].strip(), kind, opt_int(f.get("res_new_cap")), COLOURS[n % len(COLOURS)]))
    for s in services(db, True):
        name = (f.get(f"svc_name_{s['id']}") or "").strip()
        if name:
            db.execute("UPDATE booking_services SET name=?, minutes=?, price=?, item_id=?, active=? WHERE id=?",
                       (name, opt_int(f.get(f"svc_min_{s['id']}")) or 60, to_cents(f.get(f"svc_price_{s['id']}") or 0),
                        opt_int(f.get(f"svc_item_{s['id']}")), 1 if f.get(f"svc_on_{s['id']}") else 0, s["id"]))
    if (f.get("svc_new") or "").strip():
        db.execute("INSERT INTO booking_services (name, minutes, price, item_id) VALUES (?,?,?,?)",
                   (f["svc_new"].strip(), opt_int(f.get("svc_new_min")) or 60, to_cents(f.get("svc_new_price") or 0),
                    opt_int(f.get("svc_new_item"))))
    audit(db, "bookings_setup", f.get("mode") or "")
    flash("Bookings setup saved.", "ok")
    return redirect(url_for("bookings.setup"))


def customer_bookings(db, cid):
    """For a customer's page in any Riyeser app: their recent and upcoming bookings."""
    try:
        return db.execute("SELECT b.*, r.name resource, s.name service FROM bookings b"
                          " LEFT JOIN booking_resources r ON r.id=b.resource_id LEFT JOIN booking_services s ON s.id=b.service_id"
                          " WHERE b.contact_id=? ORDER BY b.starts_at DESC LIMIT 20", (cid,)).fetchall()
    except Exception:
        return []
