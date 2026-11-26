"""Riyeser Bookings, on site: the worker's screen for one visit (riyeser/jobsite.py has the data and the PDF).

Start / Finish, the job type's checklist, notes, parts, before/after photos, the customer's signature, the job
sheet PDF (download or email) and "Invoice this job". Same blueprint as Bookings, so the same permissions apply:
looking needs View on Bookings, recording needs Add & edit, unlocking a signed sheet needs a manager (Full on
Bookings), who can sign in on the worker's device just for that.
"""
from datetime import date, datetime, timedelta

from flask import render_template, request, redirect, url_for, flash, g, abort, Response, jsonify
from werkzeug.security import check_password_hash

from .. import jobsite as JS
from ..db import get_db, audit, to_cents
from ..ledger import PostingError
from .. import perms
from . import guarded, opt_int
from .bookings import (bp, M, OPEN, OUTCOMES, STATUSES, refresh_job, get_job, job_no, job_charges, _sold_items,
                       resources, services)

FULL = perms.FULL


def _visit_row(db, bid):
    b = db.execute("SELECT b.*, c.name customer, c.email cemail, c.phone cphone, c.address caddress, r.name resource,"
                   " s.name service, s.checklist FROM bookings b LEFT JOIN contacts c ON c.id=b.contact_id"
                   " LEFT JOIN booking_resources r ON r.id=b.resource_id LEFT JOIN booking_services s"
                   " ON s.id=b.service_id WHERE b.id=?", (bid,)).fetchone()
    if not b or not b["job_id"]:
        abort(404)
    return b


def _editable(db, b):
    """Raise when this visit's sheet can't change: invoiced, or signed by the customer."""
    if db.execute("SELECT document_id FROM booking_jobs WHERE id=?", (b["job_id"],)).fetchone()[0]:
        raise PostingError("This job is already invoiced, so its job sheet is closed. Void the invoice to change it.")
    if JS.is_signed(db, b["id"]):
        raise PostingError("The customer has signed this job sheet, so it's locked. A manager can unlock it.")


def _here(bid, anchor=None):
    return redirect(url_for("bookings.site", bid=bid) + (f"#{anchor}" if anchor else ""))


def _ensure_checks(db, b):
    """The first time a visit's sheet opens, it gets its own copy of the job type's checklist, so changing the
    checklist in Bookings setup later doesn't change sheets already started."""
    if db.execute("SELECT 1 FROM booking_checks WHERE booking_id=?", (b["id"],)).fetchone():
        return
    if JS.is_signed(db, b["id"]) or b["status"] in ("cancelled", "no_show"):
        return
    for i, item in enumerate(JS.checklist_items(b["checklist"])):
        db.execute("INSERT INTO booking_checks (booking_id, job_id, pos, item) VALUES (?,?,?,?)",
                   (b["id"], b["job_id"], i, item))
    db.commit()


# ---------------------------------------------------------------- today's visits

@bp.route("/site")
def site_today():
    """On site: today's visits as big cards, for a phone or tablet."""
    db = get_db()
    try:
        d = date.fromisoformat(request.args.get("d") or "")
    except ValueError:
        d = date.today()
    who = opt_int(request.args.get("r"))
    rows = db.execute("SELECT b.*, c.name customer, r.name resource, r.colour, s.name service,"
                      " (SELECT 1 FROM booking_signoffs x WHERE x.booking_id=b.id AND x.status='signed') signed"
                      " FROM bookings b LEFT JOIN contacts c ON c.id=b.contact_id"
                      " LEFT JOIN booking_resources r ON r.id=b.resource_id LEFT JOIN booking_services s ON s.id=b.service_id"
                      " WHERE b.starts_at >= ? AND b.starts_at < ? AND b.status NOT IN ('cancelled','no_show')"
                      + (" AND b.resource_id=?" if who else "") + " ORDER BY b.starts_at",
                      (d.isoformat(), (d + timedelta(days=1)).isoformat()) + ((who,) if who else ())).fetchall()
    return render_template("bookings/site_today.html", rows=rows, d=d, who=who, res=resources(db), m=M(),
                           statuses=dict(STATUSES), prev=d - timedelta(days=1), next=d + timedelta(days=1),
                           today=date.today())


# ---------------------------------------------------------------- one visit's sheet

@bp.route("/<int:bid>/site")
def site(bid):
    db = get_db()
    b = _visit_row(db, bid)
    _ensure_checks(db, b)
    j = get_job(db, b["job_id"])
    inv = db.execute("SELECT id, number FROM documents WHERE id=?", (j["document_id"],)).fetchone() \
        if j["document_id"] else None
    sign = JS.signoff(db, bid)
    from .. import mailer
    times = db.execute("SELECT t.*, u.username who FROM booking_time t LEFT JOIN users u ON u.id=t.user_id"
                       " WHERE t.booking_id=? ORDER BY t.id", (bid,)).fetchall()
    lines, sm = job_charges(db, j)
    return render_template(
        "bookings/site.html", b=b, j=j, inv=inv, sign=sign, m=M(), job_no=job_no, outcomes=OUTCOMES,
        statuses=dict(STATUSES), kinds=JS.PHOTO_KINDS, items=_sold_items(db), times=times, sm=sm, lines=lines,
        minutes=sum(t["minutes"] for t in times), nice=JS.nice_minutes,
        checks=db.execute("SELECT * FROM booking_checks WHERE booking_id=? ORDER BY pos, id", (bid,)).fetchall(),
        parts=db.execute("SELECT * FROM booking_materials WHERE booking_id=? ORDER BY id", (bid,)).fetchall(),
        photos=db.execute("SELECT id, kind, caption, created_at FROM booking_photos WHERE booking_id=? ORDER BY"
                          " CASE kind WHEN 'before' THEN 0 WHEN 'after' THEN 1 ELSE 2 END, id", (bid,)).fetchall(),
        history=db.execute("SELECT s.*, u.username unlocker FROM booking_signoffs s LEFT JOIN users u"
                           " ON u.id=s.unlocked_by WHERE s.booking_id=? AND s.status='unlocked' ORDER BY s.id",
                           (bid,)).fetchall(),
        locked=bool(sign or inv), is_manager=perms.can("bookings", FULL), email_ready=bool(mailer.settings(db)),
        now=JS.now())


@bp.route("/<int:bid>/site/start", methods=["POST"])
@guarded
def site_start(bid):
    db = get_db()
    b = _visit_row(db, bid)
    _editable(db, b)
    if b["status"] not in OPEN:
        raise PostingError("This visit is already finished. Book another visit on the job for more work.")
    if b["arrived_at"] and not b["left_at"]:
        return _here(bid)  # pressed twice: already started
    t = JS.now()
    db.execute("UPDATE bookings SET arrived_at=?, left_at=NULL, status='started', updated_at=datetime('now','localtime')"
               " WHERE id=?", (t.isoformat(sep=" "), bid))
    refresh_job(db, b["job_id"])
    audit(db, "booking_site_start", f"#{bid}")
    flash(f"Started at {t:%H:%M}. Press Finish when you leave.", "ok")
    return _here(bid)


@bp.route("/<int:bid>/site/finish", methods=["POST"])
@guarded
def site_finish(bid):
    """Finish: the time on site is logged as labour, and the visit is done (or needs a return visit)."""
    db = get_db()
    b = _visit_row(db, bid)
    _editable(db, b)
    f = request.form
    outcome = f.get("outcome") if f.get("outcome") in dict(OUTCOMES) else "finished"
    note = (f.get("outcome_note") or "").strip() or None
    if outcome != "finished" and not note:
        raise PostingError("Say what's still needed, so the office knows what to book next.")
    t = JS.now()
    mins = 0
    if b["arrived_at"] and not b["left_at"]:
        mins = JS.site_minutes(b["arrived_at"], t.isoformat(sep=" "))
        db.execute("INSERT INTO booking_time (job_id, booking_id, user_id, minutes, note, site) VALUES (?,?,?,?,?,1)",
                   (b["job_id"], bid, g.user["id"], mins, "Time on site"))
        db.execute("UPDATE bookings SET left_at=? WHERE id=?", (t.isoformat(sep=" "), bid))
    db.execute("UPDATE bookings SET status='done', outcome=?, outcome_note=COALESCE(?, outcome_note),"
               " updated_at=datetime('now','localtime') WHERE id=?", (outcome, note, bid))
    refresh_job(db, b["job_id"])
    audit(db, "booking_site_finish", f"#{bid} {outcome} {mins} min")
    flash((f"Finished at {t:%H:%M}: {JS.nice_minutes(mins)} on site. " if mins else "Visit finished. ")
          + "Now ask the customer to sign below.", "ok")
    return _here(bid, "sign")


@bp.route("/<int:bid>/site/times", methods=["POST"])
@guarded
def site_times(bid):
    """Forgot to press Start or Finish? Type the times instead; they replace the times recorded for this visit."""
    db = get_db()
    b = _visit_row(db, bid)
    _editable(db, b)
    day = b["starts_at"][:10]
    try:
        a = datetime.fromisoformat(f"{day}T{request.form.get('arrived')}")
        left = datetime.fromisoformat(f"{day}T{request.form.get('left')}")
    except ValueError:
        raise PostingError("Type the start and finish times, for example 08:30 and 10:15.")
    if left <= a:
        raise PostingError("The finish time must be after the start time.")
    mins = JS.site_minutes(a.isoformat(sep=" "), left.isoformat(sep=" "))
    db.execute("DELETE FROM booking_time WHERE booking_id=? AND site=1", (bid,))
    db.execute("INSERT INTO booking_time (job_id, booking_id, user_id, minutes, note, site) VALUES (?,?,?,?,?,1)",
               (b["job_id"], bid, g.user["id"], mins, "Time on site (typed in)"))
    db.execute("UPDATE bookings SET arrived_at=?, left_at=?, updated_at=datetime('now','localtime') WHERE id=?",
               (a.isoformat(sep=" "), left.isoformat(sep=" "), bid))
    audit(db, "booking_site_times", f"#{bid} {a:%H:%M}-{left:%H:%M}")
    flash(f"Times saved: {a:%H:%M} to {left:%H:%M}, {JS.nice_minutes(mins)} on site.", "ok")
    return _here(bid, "times")


@bp.route("/<int:bid>/site/checks", methods=["POST"])
def site_checks(bid):
    """Ticks on the checklist (each tick saves straight away from the page; the Save button does the same)."""
    db = get_db()
    b = _visit_row(db, bid)
    try:
        _editable(db, b)
    except PostingError as e:
        if request.headers.get("X-Requested-With") == "fetch":
            return jsonify(ok=False, error=str(e)), 409
        flash(str(e), "error")
        return _here(bid, "checks")
    ticked = {opt_int(v) for v in request.form.getlist("done")}
    for ch in db.execute("SELECT id, done FROM booking_checks WHERE booking_id=?", (bid,)).fetchall():
        on = ch["id"] in ticked
        if on != bool(ch["done"]):
            db.execute("UPDATE booking_checks SET done=?, done_at=?, user_id=? WHERE id=?",
                       (1 if on else 0, JS.now().isoformat(sep=" ") if on else None, g.user["id"], ch["id"]))
    extra = (request.form.get("new_item") or "").strip()
    if extra:
        pos = db.execute("SELECT COALESCE(MAX(pos),0)+1 FROM booking_checks WHERE booking_id=?", (bid,)).fetchone()[0]
        db.execute("INSERT INTO booking_checks (booking_id, job_id, pos, item) VALUES (?,?,?,?)",
                   (bid, b["job_id"], pos, extra))
    db.commit()
    if request.headers.get("X-Requested-With") == "fetch":
        return jsonify(ok=True)
    flash("Checklist saved.", "ok")
    return _here(bid, "checks")


@bp.route("/<int:bid>/site/notes", methods=["POST"])
@guarded
def site_notes(bid):
    db = get_db()
    b = _visit_row(db, bid)
    _editable(db, b)
    db.execute("UPDATE bookings SET site_notes=?, updated_at=datetime('now','localtime') WHERE id=?",
               ((request.form.get("site_notes") or "").strip() or None, bid))
    audit(db, "booking_site_notes", f"#{bid}")
    flash("Notes saved.", "ok")
    return _here(bid, "notes")


# ---------------------------------------------------------------- photos

@bp.route("/<int:bid>/site/photo", methods=["POST"])
def site_photo(bid):
    """Photos from the camera or the device. The page sends them shrunk, by fetch (answered with JSON)."""
    db = get_db()
    fetched = request.headers.get("X-Requested-With") == "fetch"
    try:
        resp = _site_photo(db, bid)
        db.commit()
        return jsonify(ok=True) if fetched else resp
    except (PostingError, ValueError) as e:
        db.rollback()
        if fetched:
            return jsonify(ok=False, error=str(e)), 400
        flash(str(e), "error")
        return _here(bid, "photos")


def _site_photo(db, bid):
    b = _visit_row(db, bid)
    _editable(db, b)
    files = [f for f in request.files.getlist("photo") if f and f.filename]
    if not files:
        raise PostingError("Take or choose a photo first.")
    kind = request.form.get("kind") if request.form.get("kind") in dict(JS.PHOTO_KINDS) else "before"
    caption = (request.form.get("caption") or "").strip()[:200] or None
    for f in files:
        raw = f.read(JS.MAX_UPLOAD + 1)
        if len(raw) > JS.MAX_UPLOAD:
            raise PostingError("That photo is too big (over 25 MB). Try again with a smaller one.")
        data, thumb, w, h = JS.shrink(raw)
        db.execute("INSERT INTO booking_photos (job_id, booking_id, kind, caption, mime, data, thumb, width, height,"
                   " user_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
                   (b["job_id"], bid, kind, caption, "image/jpeg", data, thumb, w, h, g.user["id"]))
    audit(db, "booking_photo", f"#{bid} {kind} x{len(files)}")
    flash(f"{len(files)} photo{'s' if len(files) > 1 else ''} added.", "ok")
    return _here(bid, "photos")


@bp.route("/photo/<int:pid>")
def site_photo_file(pid):
    row = get_db().execute("SELECT mime, data, thumb FROM booking_photos WHERE id=?", (pid,)).fetchone() or abort(404)
    body = row["thumb"] if request.args.get("thumb") and row["thumb"] else row["data"]
    return Response(body, mimetype=row["mime"], headers={"Cache-Control": "private, max-age=86400"})


@bp.route("/photo/<int:pid>/edit", methods=["POST"])
@guarded
def site_photo_edit(pid):
    db = get_db()
    p = db.execute("SELECT * FROM booking_photos WHERE id=?", (pid,)).fetchone() or abort(404)
    b = _visit_row(db, p["booking_id"])
    _editable(db, b)
    if request.form.get("delete"):
        db.execute("DELETE FROM booking_photos WHERE id=?", (pid,))
        audit(db, "booking_photo_delete", f"#{b['id']} photo {pid}")
        flash("Photo removed.", "ok")
    else:
        kind = request.form.get("kind") if request.form.get("kind") in dict(JS.PHOTO_KINDS) else p["kind"]
        db.execute("UPDATE booking_photos SET caption=?, kind=? WHERE id=?",
                   ((request.form.get("caption") or "").strip()[:200] or None, kind, pid))
        flash("Caption saved.", "ok")
    return _here(b["id"], "photos")


# ---------------------------------------------------------------- sign-off

@bp.route("/<int:bid>/site/sign", methods=["POST"])
@guarded
def site_sign(bid):
    db = get_db()
    b = _visit_row(db, bid)
    _editable(db, b)
    name = (request.form.get("name") or "").strip()
    if not name:
        raise PostingError("Type the customer's name under the signature.")
    png = JS.signature_png(request.form.get("signature"))
    t = JS.now()
    db.execute("INSERT INTO booking_signoffs (job_id, booking_id, name, signed_at, image, user_id) VALUES (?,?,?,?,?,?)",
               (b["job_id"], bid, name[:120], t.isoformat(sep=" "), png, g.user["id"]))
    audit(db, "booking_signed", f"#{bid} by {name[:120]}")
    flash(f"Signed by {name} at {t:%H:%M}. The job sheet is now locked.", "ok")
    return _here(bid, "sign")


@bp.route("/signature/<int:sid>")
def site_signature(sid):
    row = get_db().execute("SELECT image FROM booking_signoffs WHERE id=?", (sid,)).fetchone() or abort(404)
    return Response(row["image"], mimetype="image/png", headers={"Cache-Control": "private, max-age=86400"})


@bp.route("/<int:bid>/site/unlock", methods=["POST"])
@guarded
def site_unlock(bid):
    """A manager reopens a signed job sheet. The signature is kept, marked unlocked, with who, when and why."""
    db = get_db()
    b = _visit_row(db, bid)
    s = JS.signoff(db, bid) or abort(404)
    if db.execute("SELECT document_id FROM booking_jobs WHERE id=?", (b["job_id"],)).fetchone()[0]:
        raise PostingError("This job is already invoiced. Void the invoice first, then unlock the job sheet.")
    reason = (request.form.get("reason") or "").strip()
    if not reason:
        raise PostingError("Say why the job sheet is being unlocked.")
    manager = g.user
    if not perms.can("bookings", FULL):
        uname = (request.form.get("manager") or "").strip()
        u = db.execute("SELECT * FROM users WHERE username=? AND active=1", (uname,)).fetchone() if uname else None
        if not u or not check_password_hash(u["password_hash"], request.form.get("password") or ""):
            audit(db, "booking_unlock_refused", f"#{bid} {uname}")
            db.commit()
            raise PostingError("Only a manager can unlock a signed job sheet. Ask a manager to type their user name"
                               " and password.")
        if perms.level("bookings", u) < FULL:
            raise PostingError(f"{u['username']} isn't a manager for Bookings (it needs Full access to Bookings).")
        manager = u
    db.execute("UPDATE booking_signoffs SET status='unlocked', unlocked_at=?, unlocked_by=?, unlock_reason=? WHERE id=?",
               (JS.now().isoformat(sep=" "), manager["id"], reason[:300], s["id"]))
    audit(db, "booking_unlock", f"#{bid} by {manager['username']}: {reason[:300]}")
    flash(f"Unlocked by {manager['username']}. The customer will need to sign again.", "ok")
    return _here(bid, "sign")


# ---------------------------------------------------------------- the job sheet PDF

def _sheet_name(db, jid):
    from ..pdf import safe_name
    j = get_job(db, jid)
    return safe_name(f"Job sheet {job_no(jid)} {j['customer'] or j['title'] or ''}") + ".pdf"


@bp.route("/job/<int:jid>/sheet.pdf")
def job_sheet(jid):
    db = get_db()
    get_job(db, jid)
    disp = "attachment" if request.args.get("download") else "inline"
    return Response(JS.job_sheet_pdf(db, jid), mimetype="application/pdf",
                    headers={"Content-Disposition": f'{disp}; filename="{_sheet_name(db, jid)}"'})


@bp.route("/job/<int:jid>/sheet/email", methods=["POST"])
@guarded
def job_sheet_email(jid):
    from .email import send_or_queue
    db = get_db()
    j = get_job(db, jid)
    c = db.execute("SELECT name, email FROM contacts WHERE id=?", (j["contact_id"],)).fetchone() \
        if j["contact_id"] else None
    to = (request.form.get("to") or (c["email"] if c else "") or "").strip()
    if not to or "@" not in to:
        raise PostingError("Type the customer's email address.")
    co = g.company["name"]
    body = (f"Hello {c['name'] if c else ''},\n\nPlease find attached the job sheet for job {job_no(jid)}"
            + (f" ({j['title']})" if j["title"] else "") + f".\n\nThank you,\n{co}")
    msg = send_or_queue(db, to, f"Job sheet {job_no(jid)} from {co}", body,
                        (_sheet_name(db, jid), JS.job_sheet_pdf(db, jid)), "job_sheet", jid)
    audit(db, "booking_sheet_email", f"job {jid} to {to}")
    flash(msg, "ok")
    return redirect(request.form.get("back") or url_for("bookings.job", jid=jid))


# ---------------------------------------------------------------- Bookings setup: checklists and labour rates

def save_setup_extras(db, f):
    """Called from Bookings setup's Save: each job type's checklist and labour rate, each staff member's rate."""
    for s in services(db, True):
        if f"svc_check_{s['id']}" in f:
            items = JS.checklist_items(f.get(f"svc_check_{s['id']}"))
            db.execute("UPDATE booking_services SET checklist=? WHERE id=?", ("\n".join(items) or None, s["id"]))
        if f"svc_rate_{s['id']}" in f:
            v = (f.get(f"svc_rate_{s['id']}") or "").strip()
            rate = to_cents(v) if v else None
            if rate is not None and rate < 0:
                raise PostingError("A labour rate can't be below $0.")
            db.execute("UPDATE booking_services SET labour_rate=? WHERE id=?", (rate or None, s["id"]))
    for r in resources(db, True):
        if f"res_rate_{r['id']}" in f:
            v = (f.get(f"res_rate_{r['id']}") or "").strip()
            rate = to_cents(v) if v else None
            if rate is not None and rate < 0:
                raise PostingError("A labour rate can't be below $0.")
            db.execute("UPDATE booking_resources SET labour_rate=? WHERE id=?", (rate or None, r["id"]))
