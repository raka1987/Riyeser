"""Quotes that customers accept or decline.

A sale quote is Waiting until it's marked Accepted or Declined. Once its "valid until" date has passed while still
waiting, it shows as Expired (it can still be accepted: the customer may ring a day late). Turning a quote into an
invoice counts as accepted. An accepted quote becomes an invoice with one click, and, when the business uses Riyeser
Bookings, a job there, carrying the customer, address and lines.

Who accepted, when and how is kept on the quote (accepted_source: in_person, phone, email, or accepted_online once
customers can accept over the internet: record_online_acceptance() is the one place that will call it).
"""
from datetime import date, datetime, timedelta

from flask import request, redirect, url_for, flash, g, abort

from ..db import get_db, audit, fmt_money
from ..ledger import PostingError
from .. import perms
from . import guarded
from .documents import bp

VALID_DAYS = 30  # a new quote is valid for 30 days unless another date is typed
SOURCES = {"in_person": "In person", "phone": "By phone", "email": "By email", "accepted_online": "Online"}
FILTERS = [("waiting", "Waiting"), ("accepted", "Accepted"), ("declined", "Declined"), ("expired", "Expired")]


def state(doc, today=None):
    """'accepted', 'declined', 'expired' or 'waiting' for a sale quote; None for anything else."""
    if doc["side"] != "sale" or doc["status"] != "quote":
        return None
    if doc["quote_status"] == "accepted" or doc["converted_to"]:
        return "accepted"
    if doc["quote_status"] == "declined":
        return "declined"
    today = today or date.today().isoformat()
    if doc["valid_until"] and doc["valid_until"] < today:
        return "expired"
    return "waiting"


def filter_sql(qs, today):
    """(SQL, params) narrowing the quotes list to one of FILTERS."""
    accepted = "(d.quote_status='accepted' OR d.converted_to IS NOT NULL)"
    open_ = "d.quote_status IS NULL AND d.converted_to IS NULL"
    return {"accepted": (f" AND {accepted}", []),
            "declined": (" AND d.quote_status='declined' AND d.converted_to IS NULL", []),
            "expired": (f" AND {open_} AND d.valid_until < ?", [today]),
            "waiting": (f" AND {open_} AND (d.valid_until IS NULL OR d.valid_until >= ?)", [today])}.get(qs, ("", []))


def set_valid_until(db, doc_id, value, quote_date):
    """Keep the typed date; a new quote with none is valid for VALID_DAYS from its date."""
    value = (value or "").strip()
    if value:
        try:
            date.fromisoformat(value)
        except ValueError:
            raise PostingError("\"Valid until\" must be a date.")
        if value < quote_date:
            raise PostingError("\"Valid until\" can't be before the quote's date.")
    else:
        cur = db.execute("SELECT valid_until FROM documents WHERE id=?", (doc_id,)).fetchone()
        if cur and cur["valid_until"]:
            return
        value = (date.fromisoformat(quote_date) + timedelta(days=VALID_DAYS)).isoformat()
    db.execute("UPDATE documents SET valid_until=? WHERE id=?", (value, doc_id))


def _quote(db, doc_id):
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone() or abort(404)
    if doc["side"] != "sale" or doc["status"] != "quote":
        raise PostingError("Only a customer quote can be accepted or declined.")
    return doc


def _who():
    u = g.get("user")
    return (u["full_name"] or u["username"]) if u else None


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def mark_accepted(db, doc_id, name=None, source="in_person", by=None, note=None, at=None, option=None):
    """option: for a quote with options (Good / Better / Best), the one the customer chose (its number or name). Its
    lines go on the quote, so the invoice and the Bookings job made from it are that option."""
    from .. import quote_options as QO
    doc = _quote(db, doc_id)
    if source not in SOURCES:
        raise PostingError("Choose how the customer accepted.")
    opts = QO.of(db, doc_id)
    chosen = None
    if opts:
        chosen = QO.find(opts, option)
        if not chosen:
            raise PostingError(f"{doc['number']} has options: choose the one the customer accepted.")
        QO.choose(db, doc_id, chosen["n"])
    db.execute("UPDATE documents SET quote_status='accepted', quote_status_at=?, quote_status_by=?, accepted_name=?,"
               " accepted_source=?, quote_status_note=? WHERE id=?",
               (at or _now(), by or _who(), (name or "").strip() or None, source, (note or "").strip() or None, doc_id))
    audit(db, "quote_accepted", f"{doc['number']} ({source})" + (f": option {chosen['name']}" if chosen else ""))


def record_online_acceptance(db, doc_id, name, at=None, option=None):
    """The customer accepted the quote over the internet (sent down from the cloud). For a quote with options, the
    option they ticked (number or name); none given: the recommended one."""
    from .. import quote_options as QO
    doc = _quote(db, doc_id)
    if doc["quote_status"] == "declined" or doc["converted_to"]:
        return False
    opts = QO.of(db, doc_id)
    if opts and option in (None, ""):
        option = QO.recommended(opts)["n"]
    mark_accepted(db, doc_id, name=name, source="accepted_online", by="customer", at=at, option=option)
    return True


def mark_declined(db, doc_id, note=None):
    doc = _quote(db, doc_id)
    if doc["converted_to"]:
        raise PostingError(f"{doc['number']} has already been turned into an invoice or order.")
    db.execute("UPDATE documents SET quote_status='declined', quote_status_at=?, quote_status_by=?, accepted_name=NULL,"
               " accepted_source=NULL, quote_status_note=? WHERE id=?",
               (_now(), _who(), (note or "").strip() or None, doc_id))
    if doc["chosen_option"]:
        from ..quote_options import unchoose
        unchoose(db, doc_id)
    audit(db, "quote_declined", doc["number"])


def check_convertible(db, doc_id):
    """A declined quote isn't turned into an invoice by mistake."""
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc and doc["side"] == "sale" and doc["status"] == "quote" and doc["quote_status"] == "declined":
        raise PostingError(f"{doc['number']} was declined. Press \"Undo\" on it first if the customer has changed "
                           "their mind.")
    if doc and doc["side"] == "sale":
        from ..quote_options import check_chosen
        check_chosen(db, doc)


def after_convert(db, quote_id, new_id):
    """A quote became an invoice: it counts as accepted, and a Bookings job made from it is billed by that invoice."""
    q = db.execute("SELECT * FROM documents WHERE id=?", (quote_id,)).fetchone()
    if not q or q["side"] != "sale":
        return
    new = db.execute("SELECT status FROM documents WHERE id=?", (new_id,)).fetchone()
    if q["booking_job_id"] and new and new["status"] in ("open", "paid"):
        db.execute("UPDATE booking_jobs SET document_id=?, updated_at=datetime('now','localtime')"
                   " WHERE id=? AND document_id IS NULL", (new_id, q["booking_job_id"]))


# ---------------------------------------------------------------- Bookings
def uses_bookings(db):
    """The business uses Riyeser Bookings (same company file): it's the Bookings app, or bookings are set up."""
    from ..edition import is_bookings_app
    return is_bookings_app() or bool(db.execute(
        "SELECT 1 FROM booking_resources UNION ALL SELECT 1 FROM booking_jobs LIMIT 1").fetchone())


def make_job(db, doc_id):
    """A Bookings job from an accepted quote: the customer, their address and phone, the lines in the notes, and the
    quote's total as the agreed price. Returns the job id."""
    from .bookings import plan_check, job_no
    doc = db.execute("SELECT d.*, c.name cname, c.address caddress, c.phone cphone FROM documents d"
                     " JOIN contacts c ON c.id=d.contact_id WHERE d.id=?", (doc_id,)).fetchone() or abort(404)
    if doc["side"] != "sale" or doc["status"] != "quote":
        raise PostingError("Only a customer quote can become a job.")
    if state(doc) != "accepted":
        raise PostingError(f"Mark {doc['number']} as accepted first, then make the job.")
    if doc["booking_job_id"] and db.execute("SELECT 1 FROM booking_jobs WHERE id=?", (doc["booking_job_id"],)).fetchone():
        raise PostingError(f"{doc['number']} already has job {job_no(doc['booking_job_id'])}.")
    plan_check(db)
    lines = db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (doc_id,)).fetchall()
    first = next((l["description"] for l in lines if l["description"]), None)
    from ..quote_options import of as options_of
    picked = next((o for o in options_of(db, doc_id) if o["chosen"]), None)
    notes = [f"From quote {doc['number']}" + (f", accepted by {doc['accepted_name']}" if doc["accepted_name"] else "")
             + (f", option {picked['name']}" if picked else "") + ":"]
    notes += [f"- {l['qty']:g} x {l['description'] or ''}" for l in lines]
    notes.append(f"Quoted total {fmt_money(doc['total'])} including GST.")
    if doc["notes"]:
        notes += ["", doc["notes"]]
    invoice = None
    if doc["converted_to"]:
        t = db.execute("SELECT id, status FROM documents WHERE id=?", (doc["converted_to"],)).fetchone()
        invoice = t["id"] if t and t["status"] in ("open", "paid") else None
    jid = db.execute("INSERT INTO booking_jobs (contact_id, title, address, phone, notes, billing, price, status,"
                     " document_id, created_by) VALUES (?,?,?,?,?, 'fixed', ?, 'requested', ?, ?)",
                     (doc["contact_id"], f"{first or 'Work'} ({doc['number']})"[:120], doc["caddress"], doc["cphone"],
                      "\n".join(notes), doc["total"], invoice, g.user["id"] if g.get("user") else None)).lastrowid
    db.execute("UPDATE documents SET booking_job_id=? WHERE id=?", (jid, doc_id))
    audit(db, "quote_to_job", f"{doc['number']} -> job {jid}")
    return jid


def quote_for_job(db, jid):
    """The quote a job was made from, when Bookings would invoice the job with that quote's lines (else None)."""
    j = db.execute("SELECT * FROM booking_jobs WHERE id=?", (jid,)).fetchone()
    q = db.execute("SELECT * FROM documents WHERE booking_job_id=? AND side='sale' AND status='quote'"
                   " ORDER BY id DESC LIMIT 1", (jid,)).fetchone()
    if not j or not q or q["converted_to"] or q["quote_status"] == "declined":
        return None
    if j["billing"] != "fixed" or j["price"] != q["total"] or j["contact_id"] != q["contact_id"]:
        return None
    return q


def invoice_from_quote(db, jid, rate_choice=None):
    """Bookings is invoicing a job made from a quote at the quoted price: the invoice is the quote's own lines (so
    stock items come off the shelf). Returns the invoice id, or None to invoice the job the usual way."""
    j = db.execute("SELECT * FROM booking_jobs WHERE id=?", (jid,)).fetchone()
    q = db.execute("SELECT * FROM documents WHERE booking_job_id=? AND side='sale' AND status='quote'"
                   " ORDER BY id DESC LIMIT 1", (jid,)).fetchone()
    if not j or not q or q["converted_to"] or q["quote_status"] == "declined":
        return None
    if j["billing"] != "fixed" or j["price"] != q["total"] or j["contact_id"] != q["contact_id"]:
        return None
    from ..ledger import convert_document
    return convert_document(db, q["id"], "open", rate_choice)


def link_job_invoice(db, jid, invoice_id):
    """A job made from a quote was invoiced in Bookings: the quote counts as done (it can't be invoiced twice)."""
    db.execute("UPDATE documents SET converted_to=? WHERE booking_job_id=? AND status='quote' AND converted_to IS NULL",
               (invoice_id, jid))


# ---------------------------------------------------------------- routes
def _back_on_get(fn):
    """These are buttons on the quote: a GET (after a refused one, with no referrer) goes back to the quote."""
    from functools import wraps

    @wraps(fn)
    def wrapper(doc_id):
        if request.method == "GET":
            return redirect(url_for("documents.view", doc_id=doc_id))
        return fn(doc_id)
    return wrapper


@bp.route("/document/<int:doc_id>/quote/accept", methods=["GET", "POST"])
@_back_on_get
@guarded
def quote_accept(doc_id):
    db = get_db()
    f = request.form
    mark_accepted(db, doc_id, f.get("accepted_name"), f.get("source") or "in_person", note=f.get("note"),
                  option=f.get("option"))
    doc = db.execute("SELECT number, chosen_option FROM documents WHERE id=?", (doc_id,)).fetchone()
    from ..quote_options import of as options_of
    picked = next((o for o in options_of(db, doc_id) if o["chosen"]), None)
    flash(f"{doc['number']} marked as accepted" + (f" ({picked['name']})" if picked else "")
          + ". Make the invoice (or the job) when you're ready.", "ok")
    return redirect(url_for("documents.view", doc_id=doc_id))


@bp.route("/document/<int:doc_id>/quote/decline", methods=["GET", "POST"])
@_back_on_get
@guarded
def quote_decline(doc_id):
    db = get_db()
    mark_declined(db, doc_id, request.form.get("note"))
    flash("Quote marked as declined. It stays on file under Quotes → Declined.", "ok")
    return redirect(url_for("documents.view", doc_id=doc_id))


@bp.route("/document/<int:doc_id>/quote/undo", methods=["GET", "POST"])
@_back_on_get
@guarded
def quote_undo(doc_id):
    db = get_db()
    doc = _quote(db, doc_id)
    if doc["converted_to"]:
        raise PostingError(f"{doc['number']} has already been turned into an invoice or order.")
    db.execute("UPDATE documents SET quote_status=NULL, quote_status_at=NULL, quote_status_by=NULL, accepted_name=NULL,"
               " accepted_source=NULL, quote_status_note=NULL WHERE id=?", (doc_id,))
    from ..quote_options import unchoose
    unchoose(db, doc_id)   # a quote with options: the recommended one goes back on it
    audit(db, "quote_undo", doc["number"])
    flash(f"{doc['number']} is waiting for the customer again.", "ok")
    return redirect(url_for("documents.view", doc_id=doc_id))


@bp.route("/document/<int:doc_id>/quote/job", methods=["GET", "POST"])
@_back_on_get
@guarded
def quote_job(doc_id):
    from .bookings import job_no
    db = get_db()
    if not perms.can("bookings", perms.EDIT):
        raise PostingError("Your user can't add bookings. Ask an administrator.")
    if not uses_bookings(db):
        raise PostingError("This business doesn't use Riyeser Bookings yet.")
    jid = make_job(db, doc_id)
    flash(f"Job {job_no(jid)} made in Riyeser Bookings. Book a time for it there.", "ok")
    return redirect(url_for("documents.view", doc_id=doc_id))
