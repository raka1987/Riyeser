"""Online connections screens (Setup → Online connections; the Online list) and the local-only API Riyeser Central's
sync loop uses on the business's sync PC.

The local API answers only on this PC (127.0.0.1 / ::1), only with the token this program made when it started (kept
in local-api.json next to the company file, which only this Windows user can read), and never to a web page (a
request with an Origin header is refused, so a website open in a browser can't reach it).

    GET  /online/api/status         {ok, company, version, demo, counts, settings}
    POST /online/api/import         {items: [post-box items]} -> {results: [{id, outcome, result, reason, ...}]}
    GET  /online/api/catalog        {items, skipped}            for api_publish_catalog
    GET  /online/api/stock          {levels, enabled}           for api_publish_stock
    GET  /online/api/availability   {settings, staff, open_times, from_at, to_at, enabled}
    GET  /online/api/outbox         {events: [{id, event, event_id, data, test}]}   for api_notify
    POST /online/api/outbox/done    {sent: [ids], errors: {id: message}}
    POST /online/api/sync-report    what Central's sync loop last did (shown on the Online list) and its activity
                                    trail entries since the last report (kept 90 days: Online → Activity)

Errors: never a bare 500. Anything that goes wrong answers JSON {error, message, what, reason, ref, log} with a
plain message ("Riyeser POS couldn't publish your prices: ..."), a reference (OA-XXXXXX) that is also in the
program's Support Diagnostics (Recent errors) and in online-api.log next to the company file, where Riyeser Central
reads it for Get help.
"""
import hmac
import json
import os
import secrets
import sqlite3
import traceback
from datetime import date, datetime, timedelta

from flask import (Blueprint, render_template, request, redirect, url_for, flash, g, abort, jsonify, current_app,
                   Response)
from werkzeug.exceptions import HTTPException

from ..db import get_db
from .. import online as O
from . import guarded

bp = Blueprint("online", __name__, url_prefix="/online")
api = Blueprint("online_api", __name__, url_prefix="/online/api")

TABS = [("all", "Everything"), ("booking", "Bookings"), ("order", "Orders"), ("order_request", "Order requests"), ("enquiry", "Enquiries"),
        ("customer", "Customers"), ("quote_accept", "Quotes"), ("invoice_payment", "Payments"),
        ("problems", "Needs a look"), ("test", "Test")]
STATUS_LABELS = {"done": "Filed", "rejected": "Turned down", "failed": "Will try again"}
ORDER_AS = [("invoice", "A sales invoice", "Stock comes off now. Paid online: the payment is recorded against it. "
             "Not paid: it waits as an unpaid invoice."),
            ("pos_sale", "A POS sale", "Shows in Riyeser POS's sales. Stock comes off now. If it wasn't paid in full "
             "online, it's made an unpaid invoice instead."),
            ("sales_order", "A sales order", "Fill it and turn it into the invoice later (stock comes off then). Money "
             "paid online is kept as the customer's credit until then.")]
TIMEZONES = ["Pacific/Fiji", "Pacific/Auckland", "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
             "Australia/Adelaide", "Australia/Darwin", "Australia/Perth", "Australia/Hobart", "Pacific/Apia",
             "Pacific/Tongatapu", "Pacific/Efate", "Pacific/Port_Moresby", "Pacific/Guadalcanal", "Pacific/Noumea",
             "Pacific/Tarawa", "Pacific/Honolulu", "Asia/Singapore", "Asia/Kolkata", "Europe/London",
             "America/New_York", "America/Los_Angeles", "UTC"]


# ---------------------------------------------------------------- the local API (Riyeser Central only)
def local_api_file(app=None):
    app = app or current_app
    db = app.config.get("NORMAL_DATABASE") or app.config["DATABASE"]
    return os.path.join(os.path.dirname(os.path.abspath(db)), "local-api.json")


def token(app=None):
    app = app or current_app
    if not app.config.get("ONLINE_TOKEN"):
        app.config["ONLINE_TOKEN"] = secrets.token_urlsafe(32)
    return app.config["ONLINE_TOKEN"]


def log_file(app=None):
    """online-api.log next to the company file: what went wrong in the local API (Central sends its end with Get help)."""
    return os.path.join(os.path.dirname(local_api_file(app)), "online-api.log")


def program_name(app=None):
    app = app or current_app
    if app.config.get("ONLINE_PROGRAM"):
        return app.config["ONLINE_PROGRAM"]
    try:
        from ..db import EDITIONS, POS_APP, INVOICES_APP, BOOKINGS_APP, ESTIMATE_APP
        from ..edition import app_edition, is_pos_app, is_invoices_app, is_bookings_app, is_estimate_app
        ed = app_edition()
        return (POS_APP["app"] if is_pos_app() else INVOICES_APP["app"] if is_invoices_app()
                else BOOKINGS_APP["app"] if is_bookings_app() else ESTIMATE_APP["app"] if is_estimate_app()
                else EDITIONS[ed]["app"] if ed else "Riyeser Accounting")
    except Exception:
        return "Riyeser Accounting"


def write_local_api(app, port, program=None):
    """Tell Riyeser Central where this program's local API is (called once the server is up)."""
    from .. import __version__
    f = local_api_file(app)
    if program:
        app.config["ONLINE_PROGRAM"] = program.replace(" (serve)", "")
    info = {"port": int(port), "token": token(app), "pid": os.getpid(), "program": program or "Riyeser Accounting",
            "version": __version__, "company_file": app.config.get("NORMAL_DATABASE") or app.config["DATABASE"],
            "demo": bool(app.config.get("DEMO_MODE")), "log": log_file(app), "api": 2}
    os.makedirs(os.path.dirname(f), exist_ok=True)
    tmp = f + f".{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(info, fh)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, f)
    return f


def remove_local_api(app):
    """On the way out: only our own entry (another copy of the program may have written a newer one)."""
    f = local_api_file(app)
    try:
        with open(f, encoding="utf-8") as fh:
            if json.load(fh).get("pid") == os.getpid():
                os.remove(f)
    except (OSError, ValueError):
        pass


# What each local API call does, for the plain message when it goes wrong ("... couldn't publish your prices: ...").
WHAT = {"online_api.api_status": "open the company file for online connections",
        "online_api.api_import": "file what came in from your website",
        "online_api.api_catalog": "publish your prices", "online_api.api_stock": "publish your stock levels",
        "online_api.api_availability": "publish your free booking times",
        "online_api.api_outbox": "read the news for your website", "online_api.api_outbox_done": "note the news sent",
        "online_api.api_sync_report": "save what Riyeser Central did"}


def plain_reason(e):
    """The error in words an owner can act on (the technical detail is in the log and Support Diagnostics)."""
    name, text = type(e).__name__, str(e)
    if name == "ZoneInfoNotFoundError" or "No time zone found" in text:
        return "this PC has no time-zone data for " + text.split("key ")[-1].strip("'\" ")
    if isinstance(e, sqlite3.OperationalError):
        if "locked" in text or "busy" in text:
            return "the company file is busy (another program is saving). It will be tried again in a minute"
        if "no such table" in text or "no such column" in text:
            return "the company file needs updating. Open the program once so it can bring it up to date"
        if "readonly" in text or "unable to open" in text:
            return "the company file can't be written to. Check the file isn't read-only or on a disconnected drive"
        if "disk" in text:
            return "the disk is full or not available"
    if isinstance(e, PermissionError):
        return "Windows didn't allow it to open a file it needs (check antivirus or folder permissions)"
    return (text or name)[:200]


def _write_log(ref, e):
    try:
        f = log_file()
        if os.path.exists(f) and os.path.getsize(f) > 512 * 1024:
            os.replace(f, f + ".1")
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {ref} {request.method} {request.path}: {type(e).__name__}: {e}\n")
            fh.write("".join(traceback.format_exception(type(e), e, e.__traceback__)[-6:]).rstrip() + "\n")
    except OSError:
        pass


def api_error(e):
    """Any error in the local API: a JSON answer with a plain message and a reference, never a bare 500."""
    if isinstance(e, HTTPException):
        return jsonify(error=f"http_{e.code}", message=f"{program_name()} doesn't know {request.path} "
                       "(Riyeser Central may be newer than this program: update it)."), e.code
    ref = "OA-" + secrets.token_hex(3).upper()
    what = WHAT.get(request.endpoint or "", "do that")
    reason = plain_reason(e)
    message = f"{program_name()} couldn't {what}: {reason}."
    current_app.logger.error("Online connections %s: %s", ref, "".join(traceback.format_exception(type(e), e, e.__traceback__)))
    _write_log(ref, e)
    try:
        db = get_db()
        db.rollback()
        db.execute("INSERT INTO audit_log (user_id, action, details) VALUES (NULL,'error',?)",
                   (f"Online connections {ref} {request.method} {request.path}: {type(e).__name__}: {e}"[:500],))
        db.commit()
    except Exception:
        pass
    return jsonify(error="internal", message=message, what=what, reason=reason, ref=ref, log=log_file(),
                   detail=f"{type(e).__name__}: {e}"[:300]), 500


def api_guard():
    """Called before every /online/api request (instead of the sign-in check)."""
    try:
        return _api_guard()
    except Exception as e:  # e.g. an older company file that can't be brought up to date: JSON, not an error page
        return api_error(e)


def _api_guard():
    if request.remote_addr not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        return jsonify(error="local_only"), 403
    if request.headers.get("Origin") or request.headers.get("Sec-Fetch-Site") not in (None, "none"):
        return jsonify(error="no_browsers"), 403
    given = request.headers.get("X-Riyeser-Token") or ""
    if not hmac.compare_digest(given.encode(), token().encode()):
        return jsonify(error="bad_token"), 401
    if current_app.config.get("DEMO_MODE"):
        return jsonify(error="demo", message="Demo mode is on in Riyeser Central: online items wait until it's off."), 409
    if not os.path.exists(current_app.config["DATABASE"]):
        return jsonify(error="no_company", message="There's no company file on this PC yet."), 409
    from .. import db as dbmod
    db = get_db()
    done = current_app.config.setdefault("_migrated_dbs", set())
    if current_app.config["DATABASE"] not in done:
        dbmod.migrate(db)
        done.add(current_app.config["DATABASE"])
    row = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    if row is None:
        return jsonify(error="no_company", message="The company file on this PC isn't set up yet. Open "
                       f"{program_name()} and finish setting up the company."), 409
    g.company = dict(row)
    return None


@api.errorhandler(Exception)
def _api_any_error(e):
    return api_error(e)


@api.route("/status")
def api_status():
    from .. import __version__
    db = get_db()
    s = O.settings(db)
    return jsonify(ok=True, company=g.company["name"], version=__version__, demo=False, counts=O.counts(db),
                   program=program_name(), api=2, test_request=O.test_request(db),
                   settings={k: s[k] for k in ("order_as", "booking_status", "publish_items", "publish_services",
                                               "publish_stock", "days_ahead", "timezone")})


@api.route("/import", methods=["POST"])
def api_import():
    d = request.get_json(silent=True) or {}
    items = d.get("items")
    if not isinstance(items, list) or len(items) > 100:
        return jsonify(error="bad_request", message="Send {items: [...]} with at most 100 items."), 400
    return jsonify(results=O.import_batch(get_db(), items))


@api.route("/catalog")
def api_catalog():
    return jsonify(O.catalog(get_db()))


@api.route("/stock")
def api_stock():
    return jsonify(O.stock(get_db()))


@api.route("/availability")
def api_availability():
    return jsonify(O.availability(get_db()))


@api.route("/outbox")
def api_outbox():
    return jsonify(events=O.outbox(get_db()))


@api.route("/outbox/done", methods=["POST"])
def api_outbox_done():
    d = request.get_json(silent=True) or {}
    db = get_db()
    O.outbox_done(db, d.get("sent") or [], d.get("errors") or {})
    db.commit()
    return jsonify(ok=True)


@api.route("/sync-report", methods=["POST"])
def api_sync_report():
    d = request.get_json(silent=True) or {}
    d = d if isinstance(d, dict) else {}
    db = get_db()
    O.set_sync_status(db, d)
    O.add_trail(db, d.get("trail") or [])
    if isinstance(d.get("test_sent"), dict):
        O.test_sent(db, d["test_sent"])
    db.commit()
    return jsonify(ok=True)


@api.route("/<path:rest>", methods=["GET", "POST"])
def api_unknown(rest):
    return jsonify(error="not_found", message=f"{program_name()} doesn't know /online/api/{rest[:60]} (Riyeser Central "
                   "may be newer than this program: update it)."), 404


# ---------------------------------------------------------------- screens
def record_link(r):
    """Where the thing it became is, or None."""
    t, i = r["record_type"], r["record_id"]
    if not t or not i or r["test"] or r["status"] != "done":
        return None
    if t == "booking":
        from .today import features
        return url_for("bookings.edit", bid=i) if features()["bookings_here"] else url_for("core.bookings_app")
    if t == "job":
        from .today import features
        return url_for("bookings.job", jid=i) if features()["bookings_here"] else url_for("core.bookings_app")
    if t == "document":
        return url_for("documents.view", doc_id=i)
    if t == "pos_sale":
        return url_for("pos.receipt", sid=i)
    if t in ("contact", "payment", "note") and r["contact_id"]:
        return url_for("contacts.view", cid=r["contact_id"]) + ("#notes" if t == "note" else "")
    return None


def _ago(at):
    from datetime import datetime, timezone
    try:
        t = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if not t.tzinfo:
        t = t.astimezone()
    mins = int((datetime.now(timezone.utc) - t).total_seconds() // 60)
    if mins < 1:
        return "just now"
    if mins < 60:
        return f"{mins} min ago"
    if mins < 48 * 60:
        return f"{mins // 60} h ago"
    return f"{mins // 1440} days ago"


@bp.route("/")
def index():
    db = get_db()
    tab = request.args.get("t") if request.args.get("t") in dict(TABS) else "all"
    where, args = ["1=1"], []
    if tab == "test":
        where.append("test=1")
    else:
        where.append("test=0")
        if tab == "problems":
            where.append("status IN ('failed','rejected')")
        elif tab == "order_request":
            where.append("order_request=1")
        elif tab != "all":
            where.append("kind=?")
            args.append(tab)
    rows = db.execute(f"SELECT * FROM online_inbox WHERE {' AND '.join(where)} ORDER BY filed_at DESC, rowid DESC"
                      " LIMIT 300", args).fetchall()
    sync = O.sync_status(db)
    return render_template("online/index.html", rows=rows, tab=tab, tabs=TABS, labels=O.KIND_LABELS,
                           statuses=STATUS_LABELS, counts=O.counts(db), sync=sync, ago=_ago(sync.get("at")),
                           sv=O.sync_view(sync), agof=_ago,
                           link=record_link, summary=O.summarizer(db), news_kinds=O.NEWS_KINDS, label=O.label,
                           tests=db.execute("SELECT COUNT(*) FROM online_inbox WHERE test=1").fetchone()[0])


@bp.route("/item/<iid>")
def view(iid):
    db = get_db()
    r = db.execute("SELECT * FROM online_inbox WHERE id=?", (iid,)).fetchone() or abort(404)
    if not r["seen_at"] and request.method == "GET":
        db.execute("UPDATE online_inbox SET seen_at=datetime('now','localtime') WHERE id=?", (iid,))
        db.commit()
    try:
        payload = json.loads(r["payload"])
    except ValueError:
        payload = {}
    news = db.execute("SELECT * FROM online_outbox WHERE event_id=? ORDER BY id", (iid,)).fetchall()
    booking = None
    if r["record_type"] == "booking" and r["record_id"]:
        booking = db.execute("SELECT * FROM bookings WHERE id=?", (r["record_id"],)).fetchone()
    req = []
    for l in O.order_request_lines(payload) if r["order_request"] else []:
        it = db.execute("SELECT name, active, is_sold FROM items WHERE sku=? COLLATE NOCASE", (l["sku"],)).fetchone()
        req.append(dict(l, name=it["name"] if it else None, known=bool(it and it["active"] and it["is_sold"])))
    md = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    return render_template("online/view.html", r=r, p=payload, labels=O.KIND_LABELS, statuses=STATUS_LABELS,
                           title=O.label(r), req=req, convert_as=O.CONVERT_AS,
                           source_page=payload.get("source_page") or md.get("source_page"),
                           converted_link=(url_for("documents.view", doc_id=r["converted_id"])
                                           if r["converted_type"] == "document" else None),
                           link=record_link(r), news=news, booking=booking,
                           pretty=json.dumps(payload, indent=2, ensure_ascii=False))


@bp.route("/item/<iid>/news", methods=["POST"])
@guarded
def news(iid):
    """Ready / Completed on an online order; Confirm / Cancel on an online booking."""
    db = get_db()
    what = request.form.get("what")
    r = db.execute("SELECT * FROM online_inbox WHERE id=?", (iid,)).fetchone() or abort(404)
    if r["kind"] == "order":
        O.order_news(db, iid, what)
        flash("The website will hear the order is " + ("ready." if what == "ready" else "complete."), "ok")
    elif r["kind"] == "booking" and r["record_id"] and what in ("confirmed", "cancelled") and not r["test"]:
        b = db.execute("SELECT * FROM bookings WHERE id=?", (r["record_id"],)).fetchone() or abort(404)
        db.execute("UPDATE bookings SET status=?, updated_at=datetime('now','localtime') WHERE id=?", (what, b["id"]))
        from .bookings import refresh_job
        refresh_job(db, b["job_id"])
        O.booking_changed(db, b["id"], b["status"], what)
        db.execute("UPDATE online_inbox SET state=? WHERE id=?", (what, iid))
        flash("Booking " + ("confirmed." if what == "confirmed" else "cancelled.") + " The customer's website will hear.",
              "ok")
    else:
        abort(400)
    return redirect(url_for("online.view", iid=iid))


@bp.route("/item/<iid>/convert", methods=["POST"])
def convert(iid):
    """An order request from the website, confirmed by the business: made into a sales order, invoice or till order."""
    from ..ledger import PostingError
    db = get_db()
    how = request.form.get("how")
    try:
        ctype, cid = O.convert_order_request(db, iid, how)
        db.commit()
    except (PostingError, ValueError) as e:
        db.rollback()
        flash(str(e), "error")
        return redirect(url_for("online.view", iid=iid))
    flash(f"Made the {O.CONVERT_AS[how].lower()}.", "ok")
    if ctype == "document":
        return redirect(url_for("documents.view", doc_id=cid))
    return redirect(url_for("online.view", iid=iid))


@bp.route("/item/<iid>/seen", methods=["POST"])
def seen(iid):
    db = get_db()
    db.execute("UPDATE online_inbox SET seen_at=COALESCE(seen_at, datetime('now','localtime')) WHERE id=?", (iid,))
    db.commit()
    return redirect(request.form.get("back") or url_for("core.today"))


@bp.route("/settings", methods=["GET", "POST"])
def settings():
    db = get_db()
    if request.method == "POST":
        return _save()
    s = O.settings(db)
    items = db.execute("SELECT id, sku, name, is_inventoried FROM items WHERE active=1 AND is_sold=1 ORDER BY name").fetchall()
    svcs = db.execute("SELECT id, name, minutes, price FROM booking_services WHERE active=1 ORDER BY name").fetchall()
    banks = db.execute("SELECT id, code, name FROM accounts WHERE active=1 AND is_bank=1 ORDER BY code").fetchall()
    cat = O.catalog(db, s)
    avail = O.availability(db, s)
    return render_template("online/settings.html", s=s, items=items, svcs=svcs, banks=banks, order_as=ORDER_AS,
                           weekdays=O.WEEKDAYS, timezones=TIMEZONES if s["timezone"] in TIMEZONES else [s["timezone"]] + TIMEZONES,
                           pay_default=O.payment_account(db, s), published=cat, windows=len(avail["open_times"]),
                           staff=len(avail["staff"]), stock_n=len(O.stock(db, s)["levels"]),
                           tz_fallback=O.tz_fallback(s["timezone"]))


@guarded
def _save():
    from .. import perms
    if not perms.can("setup", perms.EDIT):
        abort(403)
    db = get_db()
    f = request.form

    def num(k, lo, hi, default):
        try:
            return min(max(int(f.get(k) or default), lo), hi)
        except ValueError:
            return default
    hours = {}
    for d in O.WEEKDAYS:
        if f.get(f"open_{d}"):
            a, b = (f.get(f"from_{d}") or "").strip(), (f.get(f"to_{d}") or "").strip()
            hours[d] = f"{a}-{b}"
            if not O.parse_hours(hours[d]):
                raise ValueError(f"Check the hours for {d.capitalize()}: the closing time must be after the opening time.")
        else:
            hours[d] = ""
    O.save_settings(db, dict(
        order_as=f.get("order_as"), order_prices=f.get("order_prices"), booking_status=f.get("booking_status"),
        quote_after=f.get("quote_after"),
        payment_account_id=int(f["payment_account_id"]) if (f.get("payment_account_id") or "").isdigit() else None,
        publish_items=f.get("publish_items"), chosen_items=[int(x) for x in f.getlist("item") if x.isdigit()],
        publish_services=f.get("publish_services"),
        chosen_services=[int(x) for x in f.getlist("service") if x.isdigit()],
        publish_stock=bool(f.get("publish_stock")), timezone=(f.get("timezone") or "UTC").strip(),
        days_ahead=num("days_ahead", 1, 365, 30), slot_minutes=num("slot_minutes", 5, 240, 15),
        min_notice_minutes=num("min_notice_minutes", 0, 43200, 60), hours=hours))
    flash("Saved. Riyeser Central sends the changes to your website within a few minutes.", "ok")
    return redirect(url_for("online.settings"))


# ---------------------------------------------------------------- "Connect your website" guide and the activity trail
GUIDE_CHOICES = [
    ("booking", "A booking form", "Customers pick a service and a free time on your website. Needs Riyeser Bookings."),
    ("enquiry", "An enquiry form", "Questions and quote requests from your website, with a call-back reminder."),
    ("order", "An order button", "\u201cOrder\u201d or \u201cRequest\u201d buttons on your products: you confirm each one."),
    ("shop", "An online shop", "Your shop (Shopify, WooCommerce\u2026) sends paid orders; it reads prices and stock."),
    ("developer", "Something my developer builds", "The full API: send them riyeser.com/developers."),
]
BUILDERS = [
    ("WordPress", "Edit the page, add a <b>Custom HTML</b> block where the form should go, paste, then <b>Update</b>."),
    ("Wix", "<b>Add Elements → Embed Code → Embed HTML</b>, choose <b>Code</b>, paste, then <b>Update</b> and publish."),
    ("Squarespace", "Edit the page, add a <b>Code</b> block, paste, untick <b>Display source</b>, then <b>Save</b>."),
    ("Shopify", "<b>Online Store → Themes → Customize</b>, add a <b>Custom Liquid</b> (or Custom HTML) section, paste, "
                "<b>Save</b>."),
    ("Plain HTML", "Paste it in your page where the form should appear, before <code>&lt;/body&gt;</code>, and upload."),
]


def guide_checklist(sync, db):
    """The guide's checklist, ticked from what really happened (Riyeser Central reports the cloud side)."""
    c = (sync or {}).get("cloud") or {}
    got_here = db.execute("SELECT COUNT(*) FROM online_inbox").fetchone()[0]
    return [
        ("key", "A key made in Riyeser Link", bool(c.get("keys_active"))),
        ("request", "Your website has talked to Riyeser Online", bool(c.get("last_request_at"))),
        ("sync", "Riyeser Central on this PC brings items in", bool(sync.get("at")) and sync.get("state") != "off"),
        ("item", "The first item arrived here", got_here > 0),
        ("publish", "Prices and free times published", bool(c.get("catalog_at") or sync.get("last_publish"))),
    ]


@bp.route("/connect")
def connect():
    db = get_db()
    sync = O.sync_status(db)
    return render_template("online/connect.html", choices=GUIDE_CHOICES, builders=BUILDERS, sync=sync,
                           sv=O.sync_view(sync), ago=_ago(sync.get("at")), checklist=guide_checklist(sync, db),
                           test=O.test_progress(db), pick=request.args.get("what") or "booking", counts=O.counts(db))


@bp.route("/connect/test", methods=["POST"])
def connect_test():
    db = get_db()
    O.ask_for_test(db, request.form.get("kind"))
    db.commit()
    if request.headers.get("Accept", "").startswith("application/json"):
        return jsonify(O.test_progress(db))
    flash("Test asked for. Riyeser Central sends it within a minute and it shows below when it arrives.", "ok")
    return redirect(url_for("online.connect") + "#test")


@bp.route("/connect/test.json")
def connect_test_status():
    db = get_db()
    return jsonify(O.test_progress(db))


TRAIL_FILTERS = [("", "Everything"), ("problems", "Problems"), ("done", "Filed"), ("rejected", "Turned down"),
                 ("retry", "Trying again"), ("ok", "Checks"), ("error", "Errors")]
TRAIL_TYPES = [("", "All kinds"), ("item", "Items"), ("run", "Sync runs"), ("publish", "Publishing"),
               ("test", "Tests"), ("problem", "Problems"), ("setup", "Setup")]
TRAIL_STATUS_LABELS = {"ok": "OK", "done": "Filed", "rejected": "Turned down", "retry": "Trying again",
                       "waiting": "Waiting", "error": "Problem", "info": "Note"}


def _trail_args():
    day = request.args.get("day") or ""
    try:
        day = date.fromisoformat(day).isoformat() if day else ""
    except ValueError:
        day = ""
    st = request.args.get("st") if request.args.get("st") in dict(TRAIL_FILTERS) else ""
    kind = request.args.get("kind") if request.args.get("kind") in dict(TRAIL_TYPES) else ""
    return day, st, kind


def _local(at):
    try:
        t = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
        return t.astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(at)[:16]


@bp.route("/activity")
def activity():
    db = get_db()
    day, st, kind = _trail_args()
    rows = O.trail(db, day or None, st or None, kind or None)
    total = db.execute("SELECT COUNT(*) FROM online_trail").fetchone()[0]
    return render_template("online/activity.html", rows=rows, day=day, st=st, kind=kind, filters=TRAIL_FILTERS,
                           kinds=TRAIL_TYPES, labels=TRAIL_STATUS_LABELS, total=total, local=_local,
                           filtered=bool(day or st or kind), sync=O.sync_status(db))


def _cell(v):
    """A spreadsheet cell that can't run as a formula (customer names come from the internet)."""
    v = "" if v is None else str(v)
    return "'" + v if v[:1] in ("=", "+", "-", "@", "\t", "\r") else v


@bp.route("/activity.csv")
def activity_csv():
    import csv
    import io
    db = get_db()
    day, st, kind = _trail_args()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["When (this PC's time)", "When (UTC)", "Kind", "Status", "Source", "What happened", "Details",
                "Reference", "PC", "Times"])
    for r in O.trail(db, day or None, st or None, kind or None, limit=100000):
        w.writerow([_local(r["at"]), r["at"], r["type"], TRAIL_STATUS_LABELS.get(r["status"], r["status"]),
                    *(_cell(r[k]) for k in ("source", "what", "detail", "ref", "pc")), r["n"]])
    name = f"online-activity-{day or date.today().isoformat()}.csv"
    return Response("\ufeff" + buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
