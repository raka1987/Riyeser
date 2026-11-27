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
    POST /online/api/sync-report    what Central's sync loop last did (shown on the Online list)
"""
import hmac
import json
import os
import secrets
from datetime import date

from flask import Blueprint, render_template, request, redirect, url_for, flash, g, abort, jsonify, current_app

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


def write_local_api(app, port, program=None):
    """Tell Riyeser Central where this program's local API is (called once the server is up)."""
    from .. import __version__
    f = local_api_file(app)
    info = {"port": int(port), "token": token(app), "pid": os.getpid(), "program": program or "Riyeser Accounting",
            "version": __version__, "company_file": app.config.get("NORMAL_DATABASE") or app.config["DATABASE"],
            "demo": bool(app.config.get("DEMO_MODE"))}
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


def api_guard():
    """Called before every /online/api request (instead of the sign-in check)."""
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
    g.company = dict(db.execute("SELECT * FROM company WHERE id=1").fetchone())
    return None


@api.route("/status")
def api_status():
    from .. import __version__
    db = get_db()
    s = O.settings(db)
    return jsonify(ok=True, company=g.company["name"], version=__version__, demo=False, counts=O.counts(db),
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
    db = get_db()
    O.set_sync_status(db, d if isinstance(d, dict) else {})
    db.commit()
    return jsonify(ok=True)


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
                           staff=len(avail["staff"]), stock_n=len(O.stock(db, s)["levels"]))


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
