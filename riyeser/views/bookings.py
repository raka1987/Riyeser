"""Riyeser Bookings: book and schedule jobs, appointments or restaurant tables, then invoice them.

One app for three kinds of business, chosen under Bookings setup (company.bookings_mode):
  * jobs          trades and site work: a job at the customer's address, given to a staff member
  * appointments  salons, clinics, consultants: a service at a time, with a staff member
  * tables        cafes and restaurants: a table for a party at a time
Bookings live in the same company file as Riyeser Accounting, Invoices and POS: customers are shared, and
"Invoice" on a booking makes a real invoice there. Staff are bookable resources (staff, tables, rooms, vehicles).

Every booking is a visit on a job (booking_jobs). A job can have several visits, with time and parts logged on
each, and is invoiced once: at its agreed price, or for its hours and parts.
"""
from datetime import date, datetime, timedelta

from flask import Blueprint, render_template, request, redirect, url_for, flash, g, abort

from ..db import get_db, audit, to_cents
from ..ledger import save_document, PostingError
from . import guarded, opt_int, opt_float

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
OPEN = ("booked", "confirmed", "started")
JOB_STATUSES = [("requested", "Needs a time"), ("scheduled", "Booked"), ("in_progress", "In progress"),
                ("needs_visit", "Needs another visit"), ("on_hold", "On hold"), ("completed", "Work finished"),
                ("cancelled", "Cancelled")]
OUTCOMES = [("finished", "Work finished"), ("return", "Return visit needed"), ("no_access", "Couldn't get in")]
BILLING = [("fixed", "Fixed price"), ("time", "Time and materials")]
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
    """Nothing is added on its own any more: a new company starts blank. Returns True once there's someone or
    something to book (staff, tables or rooms). Starters are added only on request, with add_starters()."""
    return bool(db.execute("SELECT 1 FROM booking_resources").fetchone())


def add_starters(db, key=None):
    """The suggested staff/tables and services for this kind of business (all can be renamed). Only fills what's
    empty, so pressing it twice adds nothing more. Returns how many were added."""
    m = MODES[key or mode()]
    n = 0
    if not db.execute("SELECT 1 FROM booking_resources").fetchone():
        for i, name in enumerate(m["starter_who"]):
            db.execute("INSERT INTO booking_resources (name, kind, capacity, colour) VALUES (?,?,?,?)",
                       (name, m["kind"], 4 if m["kind"] == "table" else None, COLOURS[i % len(COLOURS)]))
            n += 1
    if not db.execute("SELECT 1 FROM booking_services").fetchone():
        for name, mins, price in m["starter_what"]:
            db.execute("INSERT INTO booking_services (name, minutes, price) VALUES (?,?,?)", (name, mins, price))
            n += 1
    return n


def _only_starters(db, key):
    """Exactly the suggestions for that kind of business, untouched (so switching kind can swap them)."""
    m = MODES[key]
    who = [r["name"] for r in db.execute("SELECT name FROM booking_resources ORDER BY id")]
    what = sorted(r["name"] for r in db.execute("SELECT name FROM booking_services"))
    return bool(who or what) and who == m["starter_who"] and what == sorted(n for n, _, _ in m["starter_what"])


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
    b = db.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone() if bid else None
    if bid and not b:
        abort(404)
    if request.method == "POST":
        return _save(bid)
    pre = dict(date=request.args.get("d") or date.today().isoformat(), time=request.args.get("t") or "",
               resource_id=opt_int(request.args.get("r")), contact_id=opt_int(request.args.get("c")))
    job = None
    jid = (b["job_id"] if b else None) or opt_int(request.args.get("job"))
    if jid:
        job = db.execute("SELECT * FROM booking_jobs WHERE id=?", (jid,)).fetchone()
        if job and not b:   # a new visit on an existing job starts from the job's details
            pre.update(contact_id=pre["contact_id"] or job["contact_id"], service_id=job["service_id"],
                       title=job["title"], address=job["address"], phone=job["phone"])
    inv = None
    doc_id = (job["document_id"] if job else None) or (b["document_id"] if b else None)
    if doc_id:
        inv = db.execute("SELECT id, number, status, total, amount_paid FROM documents WHERE id=?", (doc_id,)).fetchone()
    extra = {}
    if b and job:
        extra = dict(times=db.execute("SELECT t.*, u.username who FROM booking_time t LEFT JOIN users u ON u.id=t.user_id"
                                      " WHERE t.booking_id=? ORDER BY t.id", (b["id"],)).fetchall(),
                     parts=db.execute("SELECT * FROM booking_materials WHERE booking_id=? ORDER BY id", (b["id"],)).fetchall(),
                     items=_sold_items(db), outcomes=OUTCOMES,
                     visits=db.execute("SELECT COUNT(*) FROM bookings WHERE job_id=?", (job["id"],)).fetchone()[0])
    return render_template("bookings/edit.html", b=b, pre=pre, inv=inv, job=job, **extra, **_form_lookups(db))


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
    jid = opt_int(f.get("job_id"))
    if bid:
        jid = db.execute("SELECT job_id FROM bookings WHERE id=?", (bid,)).fetchone()["job_id"] or jid
    price = to_cents(f.get("price")) if (f.get("price") or "").strip() else None
    jvals = (cid, svc["id"] if svc else None, (f.get("title") or "").strip() or None,
             (f.get("address") or "").strip() or None, (f.get("phone") or "").strip() or None)
    if not jid:
        jid = db.execute("INSERT INTO booking_jobs (contact_id, service_id, title, address, phone, price, created_by)"
                         " VALUES (?,?,?,?,?,?,?)", jvals + (price, g.user["id"])).lastrowid
    else:
        visits = db.execute("SELECT COUNT(*) FROM bookings WHERE job_id=? AND id IS NOT ?", (jid, bid)).fetchone()[0]
        if bid and not visits:  # a job with only this visit follows its details
            db.execute("UPDATE booking_jobs SET contact_id=?, service_id=?, title=?, address=?, phone=? WHERE id=?",
                       jvals + (jid,))
        else:                   # another visit on the job only fills in what the job is missing
            db.execute("UPDATE booking_jobs SET contact_id=COALESCE(contact_id, ?), service_id=COALESCE(service_id, ?),"
                       " title=COALESCE(title, ?), address=COALESCE(address, ?), phone=COALESCE(phone, ?) WHERE id=?",
                       jvals + (jid,))
        if "price" in f:
            db.execute("UPDATE booking_jobs SET price=? WHERE id=?", (price, jid))
    vals = (cid, rid, svc["id"] if svc else None, start.isoformat(timespec="minutes"), minutes,
            (f.get("title") or "").strip() or None, (f.get("address") or "").strip() or None, party,
            (f.get("phone") or "").strip() or None, (f.get("notes") or "").strip() or None, status, jid)
    if bid:
        db.execute("UPDATE bookings SET contact_id=?, resource_id=?, service_id=?, starts_at=?, minutes=?, title=?,"
                   " address=?, party=?, phone=?, notes=?, status=?, job_id=?, updated_at=datetime('now','localtime')"
                   " WHERE id=?",
                   vals + (bid,))
        audit(db, "booking_edit", f"#{bid}")
    else:
        bid = db.execute("INSERT INTO bookings (contact_id, resource_id, service_id, starts_at, minutes, title, address,"
                         " party, phone, notes, status, job_id, mode, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         vals + (mode(), g.user["id"])).lastrowid
        audit(db, "booking_new", f"#{bid} {start:%Y-%m-%d %H:%M}")
    refresh_job(db, jid)
    flash(("Visit" if m["address"] else m["one"].capitalize()) + " saved.", "ok")
    return redirect(url_for("bookings.calendar", d=start.date().isoformat()))


@bp.route("/<int:bid>/status", methods=["POST"])
@guarded
def set_status(bid):
    db = get_db()
    st = request.form.get("status")
    if st not in dict(STATUSES):
        abort(400)
    b = db.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone() or abort(404)
    db.execute("UPDATE bookings SET status=?, outcome=CASE WHEN ?='done' THEN COALESCE(outcome, 'finished') ELSE outcome END,"
               " updated_at=datetime('now','localtime') WHERE id=?", (st, st, bid))
    audit(db, "booking_status", f"#{bid} {st}")
    refresh_job(db, b["job_id"])
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
    """Invoice the job this booking is a visit on (all its visits on one invoice)."""
    db = get_db()
    b = db.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone() or abort(404)
    return _invoice_job(db, b["job_id"])


# ---------------------------------------------------------------- jobs: one job, many visits, one invoice

def _sold_items(db):
    return db.execute("SELECT id, name, sell_price FROM items WHERE is_sold=1 AND active=1 ORDER BY name").fetchall()


def get_job(db, jid):
    j = db.execute("SELECT j.*, c.name customer, s.name service, s.description service_desc, s.price service_price,"
                   " s.item_id service_item FROM booking_jobs j LEFT JOIN contacts c ON c.id=j.contact_id"
                   " LEFT JOIN booking_services s ON s.id=j.service_id WHERE j.id=?", (jid,)).fetchone()
    return j or abort(404)


def job_no(jid):
    return f"J-{jid:04d}"


def refresh_job(db, jid):
    """Work out a job's status from its visits after a visit changes."""
    if not jid:
        return
    j = db.execute("SELECT status, document_id FROM booking_jobs WHERE id=?", (jid,)).fetchone()
    vs = db.execute("SELECT status, outcome, outcome_note FROM bookings WHERE job_id=? ORDER BY starts_at, id",
                    (jid,)).fetchall()
    live = [v for v in vs if v["status"] in OPEN]
    done = [v for v in vs if v["status"] == "done"]
    nxt = None
    if any(v["status"] == "started" for v in live):
        st = "in_progress"
    elif live:
        st = "scheduled"
    elif j["status"] in ("on_hold", "cancelled") and not j["document_id"]:
        st = j["status"]
    elif done and done[-1]["outcome"] in ("return", "no_access"):
        st, nxt = "needs_visit", done[-1]["outcome_note"] or dict(OUTCOMES)[done[-1]["outcome"]]
    elif done:
        st = "completed"
    elif vs:
        st = "cancelled"
    else:
        st = "requested"
    db.execute("UPDATE booking_jobs SET status=?, next_action=?, updated_at=datetime('now','localtime') WHERE id=?",
               (st, nxt, jid))


def job_charges(db, j):
    """What was logged on a job and what its invoice will charge.  Returns (lines, summary)."""
    visits = db.execute("SELECT * FROM bookings WHERE job_id=? AND status NOT IN ('cancelled','no_show')"
                        " ORDER BY starts_at", (j["id"],)).fetchall()
    minutes = db.execute("SELECT COALESCE(SUM(minutes),0) FROM booking_time WHERE job_id=?", (j["id"],)).fetchone()[0]
    parts = db.execute("SELECT m.*, i.name item_name, i.sale_tax_code_id FROM booking_materials m"
                       " LEFT JOIN items i ON i.id=m.item_id WHERE m.job_id=? ORDER BY m.id", (j["id"],)).fetchall()
    rate = (g.get("company") or {}).get("bookings_labour_rate") or 0
    hours = round(minutes / 60.0, 2)
    gst = _gst(db)
    what = j["service_desc"] or j["service"] or j["title"] or M()["one"].capitalize()
    days = ", ".join(datetime.fromisoformat(v["starts_at"]).strftime("%a %d %b %Y") for v in visits)
    desc = what + (f" — {days}" if days else "") + (f", {j['address']}" if j["address"] else "")
    lines = []
    if j["billing"] == "time":
        if hours:
            lines.append(dict(description=f"Labour — {desc}", qty=hours, unit_price=rate, discount_pct=0,
                              tax_code_id=gst, account_id=_income_account(db)))
        for p in parts:
            line = dict(description=p["description"] or p["item_name"] or "Parts", qty=p["qty"],
                        unit_price=p["unit_price"], discount_pct=0, tax_code_id=p["sale_tax_code_id"] or gst,
                        item_id=p["item_id"])
            if not p["item_id"]:
                line["account_id"] = _income_account(db)
            lines.append(line)
    else:
        price = j["price"] if j["price"] is not None else (j["service_price"] or 0)
        line = dict(description=desc, qty=1, unit_price=price, discount_pct=0, tax_code_id=gst, item_id=j["service_item"])
        if j["service_item"]:
            item = db.execute("SELECT sell_price, sale_tax_code_id FROM items WHERE id=?", (j["service_item"],)).fetchone()
            if item and not line["unit_price"]:
                line["unit_price"] = item["sell_price"] or 0
            if item and item["sale_tax_code_id"]:
                line["tax_code_id"] = item["sale_tax_code_id"]
        else:
            line["account_id"] = _income_account(db)
        if line["unit_price"]:
            lines.append(line)
    for l in lines:
        l["amount"] = round(float(l["qty"]) * (l["unit_price"] or 0))
    summary = dict(visits=visits, minutes=minutes, hours=hours, rate=rate, parts=parts,
                   parts_value=sum(round(p["qty"] * p["unit_price"]) for p in parts), labour_value=round(hours * rate),
                   total=sum(l["amount"] for l in lines))
    return lines, summary


def _invoice_job(db, jid):
    j = get_job(db, jid)
    if j["document_id"]:
        return redirect(url_for("documents.view", doc_id=j["document_id"]))
    if not j["contact_id"]:
        raise PostingError(f"Choose the customer on this {M()['one']} first, then invoice it.")
    lines, sm = job_charges(db, j)
    if j["billing"] == "time" and sm["minutes"] and not sm["rate"]:
        raise PostingError("Set your hourly labour rate in Bookings setup first, then invoice this job.")
    if not lines or not sm["total"]:
        one = M()["one"]
        if j["billing"] == "time":
            raise PostingError(f"Nothing to charge yet. Log the time and parts on this {one}'s visits, then invoice it.")
        raise PostingError(f"This {one} has no price yet. Type the price in the Price box on this {one},"
                           " press Save, then press Invoice again.")
    for l in lines:
        l.pop("amount", None)
    terms = (g.get("company") or {}).get("default_terms_days") or 14
    today = date.today()
    first = db.execute("SELECT notes FROM bookings WHERE job_id=? ORDER BY starts_at LIMIT 1", (jid,)).fetchone()
    doc_id = save_document(db, "sale", dict(contact_id=j["contact_id"], date=today.isoformat(),
                                            due_date=(today + timedelta(days=terms)).isoformat(),
                                            reference=f"Job {job_no(jid)}",
                                            notes=(first["notes"] if first else None) or "", tax_inclusive=True),
                           lines, "open")
    db.execute("UPDATE booking_jobs SET document_id=?, status='completed', next_action=NULL,"
               " updated_at=datetime('now','localtime') WHERE id=?", (doc_id, jid))
    db.execute("UPDATE bookings SET document_id=?, status=CASE WHEN status IN ('booked','confirmed','started')"
               " THEN 'done' ELSE status END, updated_at=datetime('now','localtime') WHERE job_id=?", (doc_id, jid))
    audit(db, "booking_invoice", f"job {jid} -> document {doc_id}")
    flash("Invoice made. You can print or email it from here.", "ok")
    return redirect(url_for("documents.view", doc_id=doc_id))


@bp.route("/jobs")
def jobs():
    db = get_db()
    q = request.args.get("q", "").strip()
    sql = ("SELECT j.*, c.name customer, s.name service, doc.number inv_no,"
           " (SELECT MIN(starts_at) FROM bookings b WHERE b.job_id=j.id AND b.status IN ('booked','confirmed','started'))"
           " next_visit, (SELECT COUNT(*) FROM bookings b WHERE b.job_id=j.id) visits"
           " FROM booking_jobs j LEFT JOIN contacts c ON c.id=j.contact_id"
           " LEFT JOIN booking_services s ON s.id=j.service_id LEFT JOIN documents doc ON doc.id=j.document_id")
    args = []
    if q:
        num = q.upper().removeprefix("J-").lstrip("0")
        sql += (" WHERE (c.name LIKE ? OR j.title LIKE ? OR j.address LIKE ? OR j.phone LIKE ? OR j.notes LIKE ?"
                " OR EXISTS (SELECT 1 FROM bookings b WHERE b.job_id=j.id AND (b.notes LIKE ? OR b.outcome_note LIKE ?))"
                " OR j.id=?)")
        args = [f"%{q}%"] * 7 + [int(num) if num.isdigit() else -1]
    else:
        sql += " WHERE j.status NOT IN ('cancelled') AND NOT (j.status='completed' AND j.document_id IS NOT NULL)"
    rows = db.execute(sql + " ORDER BY j.id DESC LIMIT 500", args).fetchall()
    groups = [
        ("Needs a visit", "Logged but not booked yet, or the last visit said it needs another one.",
         [r for r in rows if r["status"] in ("requested", "needs_visit")]),
        ("In hand", "Booked, in progress or on hold.", [r for r in rows if r["status"] in ("scheduled", "in_progress", "on_hold")]),
        ("Ready to invoice", "Work finished, not invoiced yet.",
         [r for r in rows if r["status"] == "completed" and not r["document_id"]]),
    ]
    if q:
        groups.append(("Invoiced or cancelled", "", [r for r in rows if r["status"] == "cancelled" or
                                                       (r["status"] == "completed" and r["document_id"])]))
    return render_template("bookings/jobs.html", groups=groups, q=q, m=M(), statuses=dict(JOB_STATUSES), job_no=job_no)


@bp.route("/job/new", methods=["GET", "POST"])
@bp.route("/job/<int:jid>", methods=["GET", "POST"])
def job(jid=None):
    db = get_db()
    j = get_job(db, jid) if jid else None
    if request.method == "POST":
        return _save_job(jid)
    ctx = dict(j=j, billing=BILLING, jstatuses=JOB_STATUSES, job_no=job_no, items=_sold_items(db), outcomes=dict(OUTCOMES),
               bstatuses=dict(STATUSES), **_form_lookups(db))
    if j:
        lines, sm = job_charges(db, j)
        ctx.update(lines=lines, sm=sm,
                   times=db.execute("SELECT t.*, u.username who, b.starts_at FROM booking_time t"
                                    " LEFT JOIN users u ON u.id=t.user_id LEFT JOIN bookings b ON b.id=t.booking_id"
                                    " WHERE t.job_id=? ORDER BY t.id", (jid,)).fetchall(),
                   visits=db.execute("SELECT b.*, r.name resource FROM bookings b LEFT JOIN booking_resources r"
                                     " ON r.id=b.resource_id WHERE b.job_id=? ORDER BY b.starts_at", (jid,)).fetchall(),
                   inv=db.execute("SELECT id, number, status, total FROM documents WHERE id=?",
                                  (j["document_id"],)).fetchone() if j["document_id"] else None)
    return render_template("bookings/job.html", **ctx)


@guarded
def _save_job(jid):
    db = get_db()
    f = request.form
    if not jid:
        plan_check(db)
    cid = opt_int(f.get("contact_id"))
    new_name = (f.get("new_customer") or "").strip()
    if not cid and new_name:
        cid = db.execute("INSERT INTO contacts (kind, name, phone, address) VALUES ('customer',?,?,?)",
                         (new_name, f.get("phone") or None, f.get("address") or None)).lastrowid
    title = (f.get("title") or "").strip() or None
    if not cid and not title:
        raise PostingError(f"Choose a customer, add a new one, or give the {M()['one']} a name.")
    svc = opt_int(f.get("service_id"))
    billing = f.get("billing") if f.get("billing") in dict(BILLING) else "fixed"
    price = to_cents(f.get("price")) if (f.get("price") or "").strip() else None
    vals = (cid, svc, title, (f.get("address") or "").strip() or None, (f.get("phone") or "").strip() or None,
            (f.get("notes") or "").strip() or None, billing, price)
    if jid:
        j = get_job(db, jid)
        if j["document_id"]:
            raise PostingError("This job is already invoiced, so its charges can't change. Void the invoice to change it.")
        db.execute("UPDATE booking_jobs SET contact_id=?, service_id=?, title=?, address=?, phone=?, notes=?, billing=?,"
                   " price=?, updated_at=datetime('now','localtime') WHERE id=?", vals + (jid,))
        st = f.get("status")
        if st in ("on_hold", "cancelled", "completed") or (st in dict(JOB_STATUSES) and st != j["status"]):
            db.execute("UPDATE booking_jobs SET status=? WHERE id=?", (st, jid))
        audit(db, "booking_job_edit", f"job {jid}")
        flash("Job saved.", "ok")
    else:
        jid = db.execute("INSERT INTO booking_jobs (contact_id, service_id, title, address, phone, notes, billing, price,"
                         " status, created_by) VALUES (?,?,?,?,?,?,?,?, 'requested', ?)", vals + (g.user["id"],)).lastrowid
        audit(db, "booking_job_new", f"job {jid}")
        flash(f"Job {job_no(jid)} saved. Book its first visit when you have a time.", "ok")
    return redirect(url_for("bookings.job", jid=jid))


@bp.route("/job/<int:jid>/invoice", methods=["POST"])
@guarded
def invoice_job(jid):
    return _invoice_job(get_db(), jid)


def _visit(db, bid):
    b = db.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone() or abort(404)
    if b["job_id"] and db.execute("SELECT document_id FROM booking_jobs WHERE id=?", (b["job_id"],)).fetchone()[0]:
        raise PostingError("This job is already invoiced. Void the invoice to change its time or parts.")
    return b


def _back(b):
    return redirect(request.form.get("back") or url_for("bookings.edit", bid=b["id"]))


@bp.route("/<int:bid>/finish", methods=["POST"])
@guarded
def finish(bid):
    """The technician finishes a visit: what happened, and whether the job needs another visit."""
    db = get_db()
    b = db.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone() or abort(404)
    f = request.form
    outcome = f.get("outcome") if f.get("outcome") in dict(OUTCOMES) else "finished"
    note = (f.get("outcome_note") or "").strip() or None
    if outcome != "finished" and not note:
        raise PostingError("Say what's still needed, so the office knows what to book next.")
    hours = opt_float(f.get("hours"))
    if hours < 0 or hours > 24:
        raise PostingError("Enter the hours worked on this visit (0 to 24).")
    if hours and b["job_id"]:
        db.execute("INSERT INTO booking_time (job_id, booking_id, user_id, minutes, note) VALUES (?,?,?,?,?)",
                   (b["job_id"], bid, g.user["id"], round(hours * 60), "On finishing the visit"))
    db.execute("UPDATE bookings SET status='done', outcome=?, outcome_note=?, updated_at=datetime('now','localtime')"
               " WHERE id=?", (outcome, note, bid))
    refresh_job(db, b["job_id"])
    audit(db, "booking_finish", f"#{bid} {outcome}")
    flash({"finished": "Visit finished.", "return": "Visit finished. The job is waiting for its return visit.",
           "no_access": "Saved. The job is waiting for another visit."}[outcome], "ok")
    return _back(b)


@bp.route("/<int:bid>/time", methods=["POST"])
@guarded
def add_time(bid):
    db = get_db()
    b = _visit(db, bid)
    hours = opt_float(request.form.get("hours"))
    if hours <= 0 or hours > 24:
        raise PostingError("Enter the hours worked, for example 1.5.")
    db.execute("INSERT INTO booking_time (job_id, booking_id, user_id, minutes, note) VALUES (?,?,?,?,?)",
               (b["job_id"], bid, g.user["id"], round(hours * 60), (request.form.get("note") or "").strip() or None))
    audit(db, "booking_time", f"#{bid} {hours}h")
    flash(f"{hours:g} hours added.", "ok")
    return _back(b)


@bp.route("/<int:bid>/part", methods=["POST"])
@guarded
def add_part(bid):
    db = get_db()
    b = _visit(db, bid)
    f = request.form
    item = db.execute("SELECT * FROM items WHERE id=?", (opt_int(f.get("item_id")),)).fetchone()
    desc = (f.get("description") or "").strip() or (item["name"] if item else "")
    if not desc:
        raise PostingError("Pick a stock item or type what the part is.")
    qty = opt_float(f.get("qty"), 1)
    if qty <= 0:
        raise PostingError("Enter how many were used.")
    price = to_cents(f.get("unit_price")) if (f.get("unit_price") or "").strip() else (item["sell_price"] if item else 0)
    db.execute("INSERT INTO booking_materials (job_id, booking_id, item_id, description, qty, unit_price, user_id)"
               " VALUES (?,?,?,?,?,?,?)", (b["job_id"], bid, item["id"] if item else None, desc, qty, price, g.user["id"]))
    audit(db, "booking_part", f"#{bid} {desc}")
    flash(f"{desc} added." + ("" if price else " The office will add its price."), "ok")
    return _back(b)


@bp.route("/job/<int:jid>/remove", methods=["POST"])
@guarded
def remove_entry(jid):
    db = get_db()
    j = get_job(db, jid)
    if j["document_id"]:
        raise PostingError("This job is already invoiced. Void the invoice to change its time or parts.")
    table = {"time": "booking_time", "part": "booking_materials"}.get(request.form.get("kind")) or abort(400)
    db.execute(f"DELETE FROM {table} WHERE id=? AND job_id=?", (opt_int(request.form.get("id")), jid))
    audit(db, "booking_remove", f"job {jid} {table}")
    flash("Removed.", "ok")
    return redirect(request.form.get("back") or url_for("bookings.job", jid=jid))


@bp.route("/job/<int:jid>/part-price", methods=["POST"])
@guarded
def part_price(jid):
    """The office prices a one-off part a technician added."""
    db = get_db()
    j = get_job(db, jid)
    if j["document_id"]:
        raise PostingError("This job is already invoiced.")
    for k, v in request.form.items():
        if k.startswith("price_") and v.strip():
            db.execute("UPDATE booking_materials SET unit_price=? WHERE id=? AND job_id=?",
                       (to_cents(v), opt_int(k[6:]), jid))
    flash("Prices saved.", "ok")
    return redirect(url_for("bookings.job", jid=jid))


# ---------------------------------------------------------------- setup

@bp.route("/setup", methods=["GET", "POST"])
def setup():
    db = get_db()
    if request.method == "POST":
        return _save_setup()
    items = db.execute("SELECT id, name FROM items WHERE is_sold=1 ORDER BY name").fetchall()
    return render_template("bookings/setup.html", res=resources(db, True), svcs=services(db, True), modes=MODES,
                           here=mode(), m=M(), items=items, hours=(g.company.get("bookings_hours") or "07:00-18:00"),
                           colours=COLOURS, labour_rate=g.company.get("bookings_labour_rate") or 0)


@bp.route("/setup/starters", methods=["POST"])
@guarded
def starters():
    db = get_db()
    n = add_starters(db)
    audit(db, "bookings_starters", f"{mode()}: {n} added")
    flash(f"Added {n} suggestions. Rename them below to suit you." if n else "You already have staff and services.", "ok")
    return redirect(url_for("bookings.setup"))


@guarded
def _save_setup():
    db = get_db()
    f = request.form
    new_mode = f.get("mode") if f.get("mode") in MODES else mode()
    old_mode = mode()
    if new_mode != old_mode:
        db.execute("UPDATE company SET bookings_mode=? WHERE id=1", (new_mode,))
        g.company["bookings_mode"] = new_mode
        nothing_booked = not db.execute("SELECT 1 FROM bookings").fetchone() and \
            not db.execute("SELECT 1 FROM booking_jobs").fetchone()
        # Nothing booked yet and only the suggestions added: swap them for the new kind of business's suggestions.
        if nothing_booked and _only_starters(db, old_mode):
            db.execute("DELETE FROM booking_resources")
            db.execute("DELETE FROM booking_services")
            add_starters(db, new_mode)
            audit(db, "bookings_setup", new_mode)
            flash(f"Set up for {MODES[new_mode]['name'].lower()}. Rename the starters below to suit you.", "ok")
            return redirect(url_for("bookings.setup"))
    h1, h2 = f.get("open") or "07:00", f.get("close") or "18:00"
    if h1 >= h2:
        raise PostingError("Closing time must be after opening time.")
    db.execute("UPDATE company SET bookings_hours=? WHERE id=1", (f"{h1}-{h2}",))
    if "labour_rate" in f:
        db.execute("UPDATE company SET bookings_labour_rate=? WHERE id=1", (to_cents(f.get("labour_rate") or 0),))
    # Remove one: deleted if nothing was ever booked on it, otherwise hidden so past bookings keep their name.
    for key, table, col in (("res_del", "booking_resources", "resource_id"), ("svc_del", "booking_services", "service_id")):
        rid = opt_int(f.get(key))
        if rid:
            if db.execute(f"SELECT 1 FROM bookings WHERE {col}=?", (rid,)).fetchone() or (key == "svc_del" and db.execute(
                    "SELECT 1 FROM booking_jobs WHERE service_id=?", (rid,)).fetchone()):
                db.execute(f"UPDATE {table} SET active=0 WHERE id=?", (rid,))
                flash("Hidden rather than deleted, because past bookings use it. Tick 'In use' to bring it back.", "ok")
            else:
                db.execute(f"DELETE FROM {table} WHERE id=?", (rid,))
                flash("Removed.", "ok")
            audit(db, "bookings_setup_remove", f"{table} {rid}")
            return redirect(url_for("bookings.setup"))
    for r in resources(db, True):
        name = (f.get(f"res_name_{r['id']}") or "").strip()
        if name:
            db.execute("UPDATE booking_resources SET name=?, capacity=?, colour=?, active=? WHERE id=?",
                       (name, opt_int(f.get(f"res_cap_{r['id']}")), f.get(f"res_col_{r['id']}") or r["colour"],
                        1 if f.get(f"res_on_{r['id']}") else 0, r["id"]))
    caps = f.getlist("res_new_cap")
    for i, name in enumerate(f.getlist("res_new")):
        if name.strip():
            n = db.execute("SELECT COUNT(*) FROM booking_resources").fetchone()[0]
            db.execute("INSERT INTO booking_resources (name, kind, capacity, colour) VALUES (?,?,?,?)",
                       (name.strip(), MODES[new_mode]["kind"], opt_int(caps[i] if i < len(caps) else None),
                        COLOURS[n % len(COLOURS)]))
    for s in services(db, True):
        name = (f.get(f"svc_name_{s['id']}") or "").strip()
        if name:
            db.execute("UPDATE booking_services SET name=?, description=?, minutes=?, price=?, item_id=?, active=?"
                       " WHERE id=?",
                       (name, (f.get(f"svc_desc_{s['id']}") or "").strip() or None,
                        opt_int(f.get(f"svc_min_{s['id']}")) or 60, to_cents(f.get(f"svc_price_{s['id']}") or 0),
                        opt_int(f.get(f"svc_item_{s['id']}")), 1 if f.get(f"svc_on_{s['id']}") else 0, s["id"]))
    mins, prices, items = f.getlist("svc_new_min"), f.getlist("svc_new_price"), f.getlist("svc_new_item")
    descs = f.getlist("svc_new_desc")
    at = lambda lst, i: lst[i] if i < len(lst) else None
    for i, name in enumerate(f.getlist("svc_new")):
        if name.strip():
            db.execute("INSERT INTO booking_services (name, description, minutes, price, item_id) VALUES (?,?,?,?,?)",
                       (name.strip(), (at(descs, i) or "").strip() or None, opt_int(at(mins, i)) or 60,
                        to_cents(at(prices, i) or 0), opt_int(at(items, i))))
    audit(db, "bookings_setup", new_mode)
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
