"""Riyeser Estimate: the Estimates list (home) and the six steps of an estimate.

  1 Customer & job address   2 How to measure (map, plan or photo, type in sizes, import a scan)   3 Measure
  4 Trade template           5 Review price (profit for you, quick changes)        6 Send (PDF, email, print)

Every step saves as you go and you can jump back to any step. Measurements are saved one at a time (JSON from the
measuring screen, or a plain form when typing sizes), so nothing is lost if the phone goes to sleep on site.
After the 90-day trial without Estimate on the plan, everything is read-only (riyeser/measure/licence.py).
"""
import base64
import csv
import io
import json
from datetime import date

from flask import Blueprint, render_template, request, redirect, url_for, flash, abort, g, jsonify, Response

from ..db import get_db, to_cents, audit, fmt_money
from ..ledger import PostingError
from ..measure import store, geometry as G, units as U, engine, quote as Q, licence as ML
from . import guarded, opt_int

bp = Blueprint("estimate", __name__, url_prefix="/estimate")

STEPS = [(1, "customer", "Customer"), (2, "how", "How to measure"), (3, "measure", "Measure"),
         (4, "template", "Template"), (5, "price", "Price"), (6, "send", "Send")]
METHODS = {"map": "On the map", "plan": "On a plan or photo", "manual": "Type in sizes", "scan": "Import a scan"}
KINDS = {"room": "Room", "rect": "Rectangle", "circle": "Circle", "triangle": "Triangle", "area": "Area",
         "length": "Length", "count": "Count", "volume": "Volume", "hours": "Hours", "shape": "Drawn area",
         "line": "Drawn length", "markers": "Counted points", "roof": "Roof face", "fence": "Fence"}
COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4b5563"]
TRADE_ICONS = {"roofing": "🏠", "fencing": "🚧", "decking": "🪵", "painting": "🎨", "flooring": "🟫", "tiling": "🧱",
               "plastering": "🧰", "concreting": "🏗️", "paving": "🧱", "landscaping": "🌱", "cleaning": "💦",
               "gutters": "🌧️", "insulation": "🧶", "electrical": "💡", "plumbing": "🚰"}
MAX_PLAN_BYTES = 40 * 1024 * 1024
PLAN_TYPES = {"application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"}
# Map imagery providers. Only Esri World Imagery is switched on; others need their own terms checked and a key.
def map_key():
    """Riyeser's ArcGIS Location Platform API key (built in by packaging/build_desktop.py from RIYESER_ESRI_KEY, or the
    environment). Without one, the public World Imagery tiles are used and address search may be refused."""
    import os
    k = os.environ.get("RIYESER_ESRI_KEY", "").strip()
    if k:
        return k
    try:
        from .._map_key import ESRI_KEY
        return ESRI_KEY
    except ImportError:
        return ""


MAP_PROVIDERS = {
    "esri": {"name": "Esri World Imagery", "tiles": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
             "attribution": "Powered by Esri | Source: Esri, Vantor (Maxar), Earthstar Geographics, and the GIS User Community",
             "max_zoom": 21, "geocode": "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates",
             # with an ArcGIS Location Platform key: the basemap layer service (counted against Riyeser's free tile tier)
             "tiles_key": "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"},
}


# ---------------------------------------------------------------- helpers
def register_filters(app):
    app.jinja_env.globals["estimate_pill"] = lambda: _safe(ML.pill)
    app.jinja_env.filters["cur"] = lambda cents: money(cents)
    app.jinja_env.filters["mdate"] = lambda v: show_date(v)


def _safe(fn):
    try:
        return fn()
    except Exception:
        return None


SYMBOLS = {"AUD": "$", "NZD": "$", "USD": "$", "CAD": "$", "FJD": "$", "SGD": "$", "HKD": "$", "SBD": "$", "WST": "WS$",
           "TOP": "T$", "VUV": "VT ", "PGK": "K", "EUR": "€", "GBP": "£", "INR": "₹", "JPY": "¥", "CNY": "¥",
           "ZAR": "R", "PHP": "₱", "NGN": "₦", "KES": "KSh ", "AED": "AED ", "MYR": "RM", "IDR": "Rp", "THB": "฿"}


def money(cents):
    """Money in the company's currency ($1,234.50, €1,234.50, KSh 1,234.50)."""
    c = (g.get("company") or {}).get("currency") or "AUD"
    s = fmt_money(cents or 0)
    sym = SYMBOLS.get(c, f"{c} ")
    return s.replace("$", sym, 1)


def show_date(v):
    """A date in the company's format: iso (2026-11-27), dmy (27/11/2026) or mdy (11/27/2026)."""
    if not v:
        return ""
    v = str(v)[:10]
    fmt = (g.get("company") or {}).get("date_format") or "iso"
    try:
        y, m, d = v.split("-")
    except ValueError:
        return v
    return {"dmy": f"{d}/{m}/{y}", "mdy": f"{m}/{d}/{y}"}.get(fmt, v)


def _t(tid):
    t = get_db().execute("SELECT t.*, c.name cname FROM takeoffs t LEFT JOIN contacts c ON c.id=t.contact_id WHERE t.id=?",
                         (tid,)).fetchone()
    if not t:
        abort(404)
    return t


def _units(t=None):
    return store.takeoff_units(t, g.company)


def _touch(tid):
    get_db().execute("UPDATE takeoffs SET updated_at=datetime('now','localtime') WHERE id=?", (tid,))


def item_view(it, sys_):
    """An item with its quantities shown in these units."""
    q = G.item_quantities(it["kind"], it["data"])
    q.pop("_edges", None)
    shown = [(G.QUANTITIES[k][0], U.fmt(v, G.QUANTITIES[k][1], sys_)) for k, v in q.items() if k in G.QUANTITIES and v]
    if "pitch_deg" in q:
        shown.append(("Pitch", f"{q['pitch_deg']:.1f}° (x{q['pitch_factor']:.3f})"))
    return {"id": it["id"], "kind": it["kind"], "kind_label": KINDS.get(it["kind"], it["kind"]), "source": it["source"],
            "label": it["label"] or KINDS.get(it["kind"], ""), "group": it["grp"] or "", "color": it["color"] or COLORS[0],
            "data": it["data"], "plan_id": it["plan_id"], "page": it["page"], "verified": bool(it["verified"]),
            "shown": shown}


def totals_view(items, sys_):
    tot = G.takeoff_quantities(items)
    return [{"key": k, "label": G.QUANTITIES[k][0], "text": U.fmt(v, G.QUANTITIES[k][1], sys_)}
            for k, v in tot.items() if k in G.QUANTITIES]


def _api_error(msg, code=400):
    return jsonify({"ok": False, "error": msg}), code


@bp.before_request
def _licence():
    """Using Riyeser Estimate starts its 90-day trial on this PC. After it (without Estimate on the plan): read-only."""
    if not g.get("user"):
        return None
    st = _safe(ML.touch) or {}
    g.estimate_read_only = st.get("mode") == "expired"
    if g.estimate_read_only and request.method == "POST" and request.endpoint not in ("estimate.mark_sent",):
        if request.is_json or request.path.endswith((".json", "/items", "/view")) or "/items/" in request.path \
                or "/scans" in request.path:
            return _api_error(ML.message(), 402)
        flash(ML.message(), "error")
        return redirect(request.referrer or url_for("estimate.index"))
    return None


@bp.context_processor
def _ctx():
    return {"steps": STEPS, "read_only": g.get("estimate_read_only"), "METHODS": METHODS}


# ---------------------------------------------------------------- the Estimates list (home)
FILTERS = [("", "All"), ("draft", "Draft"), ("sent", "Sent"), ("accepted", "Accepted"), ("declined", "Declined"),
           ("expired", "Expired")]
SORTS = {"new": ("Newest first", "t.updated_at DESC, t.id DESC"), "old": ("Oldest first", "t.updated_at, t.id"),
         "title": ("Job A to Z", "t.title COLLATE NOCASE"), "customer": ("Customer A to Z", "c.name COLLATE NOCASE")}


@bp.route("/")
def index():
    db = get_db()
    q = (request.args.get("q") or "").strip()
    st = request.args.get("st", "")
    sort = request.args.get("sort", "new") if request.args.get("sort") in SORTS else "new"
    sql = ("SELECT t.*, c.name cname, d.number qnum, d.total qtotal FROM takeoffs t LEFT JOIN contacts c ON c.id=t.contact_id"
           " LEFT JOIN documents d ON d.id=t.document_id")
    p = []
    if q:
        sql += " WHERE (t.title LIKE ? OR c.name LIKE ? OR t.address LIKE ? OR d.number LIKE ?)"
        p += [f"%{q}%"] * 4
    rows = []
    for r in db.execute(sql + " ORDER BY " + SORTS[sort][1], p).fetchall():
        s = Q.status_of(db, r)
        if st and s != st:
            continue
        rows.append(dict(r, status=s, status_label=Q.STATUS_LABELS[s]))
    counts = {}
    for r in db.execute("SELECT * FROM takeoffs").fetchall():
        s = Q.status_of(db, r)
        counts[s] = counts.get(s, 0) + 1
    return render_template("estimate/index.html", rows=rows, q=q, st=st, sort=sort, sorts=SORTS, filters=FILTERS,
                           counts=counts, total=sum(counts.values()))


@bp.route("/quotes")
def quotes():
    """The quotes Estimate made (they're ordinary quotes, so they also show in Invoices, Bookings and Accounting)."""
    db = get_db()
    rows = db.execute("SELECT d.*, c.name cname, t.id tid, t.title FROM takeoffs t JOIN documents d ON d.id=t.document_id"
                      " JOIN contacts c ON c.id=d.contact_id ORDER BY d.date DESC, d.id DESC").fetchall()
    from .quotes import state
    return render_template("estimate/quotes.html", rows=[dict(r, qstate=state(r) or r["status"]) for r in rows])


# ---------------------------------------------------------------- step 1: customer & job address
def _customer_from_form(db, f):
    cid = opt_int(f.get("contact_id"))
    name = (f.get("new_name") or "").strip()
    if not cid and name:
        cid = db.execute("INSERT INTO contacts (kind, name, phone, email, address) VALUES ('customer',?,?,?,?)",
                         (name, (f.get("new_phone") or "").strip() or None, (f.get("new_email") or "").strip() or None,
                          (f.get("address") or "").strip() or None)).lastrowid
    if not cid:
        raise PostingError("Choose a customer, or type a new customer's name.")
    return cid


@bp.route("/new", methods=["GET", "POST"])
def new():
    db = get_db()
    if request.method == "POST":
        return _save_customer(None)
    contacts = db.execute("SELECT id, name, address, phone FROM contacts WHERE kind='customer' AND active=1 ORDER BY name").fetchall()
    return render_template("estimate/step_customer.html", t=None, step=1, contacts=contacts,
                           preset_contact=opt_int(request.args.get("contact")))


@bp.route("/<int:tid>/customer", methods=["GET", "POST"])
def customer(tid):
    db = get_db()
    t = _t(tid)
    if request.method == "POST":
        return _save_customer(tid)
    contacts = db.execute("SELECT id, name, address, phone FROM contacts WHERE kind='customer' AND active=1 ORDER BY name").fetchall()
    return render_template("estimate/step_customer.html", t=t, step=1, contacts=contacts, preset_contact=t["contact_id"])


@guarded
def _save_customer(tid):
    db = get_db()
    f = request.form
    cid = _customer_from_form(db, f)
    address = (f.get("address") or "").strip() or None
    if not address:
        row = db.execute("SELECT address FROM contacts WHERE id=?", (cid,)).fetchone()
        address = row["address"] if row else None
    cname = db.execute("SELECT name FROM contacts WHERE id=?", (cid,)).fetchone()["name"]
    title = (f.get("title") or "").strip() or f"Job for {cname}"
    if tid:
        db.execute("UPDATE takeoffs SET title=?, contact_id=?, address=?, notes=?, updated_at=datetime('now','localtime')"
                   " WHERE id=?", (title[:120], cid, address, (f.get("notes") or "").strip() or None, tid))
    else:
        tid = db.execute("INSERT INTO takeoffs (title, contact_id, address, notes, created_by) VALUES (?,?,?,?,?)",
                         (title[:120], cid, address, (f.get("notes") or "").strip() or None, g.user["id"])).lastrowid
        audit(db, "estimate_new", title)
    t = _t(tid)
    nxt = request.form.get("go")
    if nxt in ("how", "measure", "template", "price", "send"):
        return redirect(url_for(f"estimate.{nxt}", tid=tid))
    return redirect(url_for("estimate.how" if not t["method"] else "estimate.measure", tid=tid))


# ---------------------------------------------------------------- step 2: how to measure
@bp.route("/<int:tid>/how", methods=["GET", "POST"])
def how(tid):
    db = get_db()
    t = _t(tid)
    if request.method == "POST":
        m = request.form.get("method")
        if m not in METHODS:
            flash("Choose how you'll measure.", "error")
            return redirect(url_for("estimate.how", tid=tid))
        db.execute("UPDATE takeoffs SET method=?, updated_at=datetime('now','localtime') WHERE id=?", (m, tid))
        db.commit()
        return redirect(url_for("estimate.measure", tid=tid))
    return render_template("estimate/step_how.html", t=t, step=2)


# ---------------------------------------------------------------- step 3: measure
@bp.route("/<int:tid>/measure")
def measure(tid):
    db = get_db()
    t = _t(tid)
    method = request.args.get("m") or t["method"] or "manual"
    if method not in METHODS:
        method = "manual"
    sys_ = _units(t)
    items = store.items_of(db, tid)
    plans = db.execute("SELECT id, name, mime, pages FROM takeoff_plans WHERE takeoff_id=? ORDER BY id", (tid,)).fetchall()
    pages = {}
    for r in db.execute("SELECT p.plan_id, p.page, p.scale, p.scale_note FROM takeoff_plan_pages p JOIN takeoff_plans x"
                        " ON x.id=p.plan_id WHERE x.takeoff_id=?", (tid,)):
        pages[f"{r['plan_id']}:{r['page']}"] = {"scale": r["scale"], "note": r["scale_note"]}
    prov = MAP_PROVIDERS.get((g.company or {}).get("map_provider") or "esri", MAP_PROVIDERS["esri"])
    import os
    key = "" if os.environ.get("RIYESER_MAP_TILES") else map_key()
    tiles = os.environ.get("RIYESER_MAP_TILES") or (prov["tiles_key"] + "?token=" + key if key and prov.get("tiles_key") else prov["tiles"])
    geocode = os.environ.get("RIYESER_MAP_GEOCODE", prov["geocode"])   # tests point these at a local stand-in
    try:
        view = json.loads(t["map_view"]) if t["map_view"] else None
    except ValueError:
        view = None
    cfg = {"tid": tid, "units": sys_, "method": method, "readOnly": bool(g.get("estimate_read_only")),
           "colors": COLORS, "kinds": KINDS, "as": G.AS_LABELS, "edgeTypes": G.EDGE_LABELS,
           "map": {"tiles": tiles, "attribution": prov["attribution"], "maxZoom": prov["max_zoom"], "geocode": geocode,
                   "provider": prov["name"], "view": view, "key": key},
           "plans": [dict(p) for p in plans], "pages": pages,
           "urls": {"items": url_for("estimate.items_api", tid=tid), "plans": url_for("estimate.plan_upload", tid=tid),
                    "view": url_for("estimate.save_view", tid=tid), "base": url_for("estimate.index"),
                    "static": url_for("static", filename=""), "scans": url_for("estimate.scan_upload", tid=tid),
                    "model": url_for("estimate.model", tid=tid), "floorplan": url_for("estimate.floorplan_svg", tid=tid)}}
    from markupsafe import Markup
    from ..measure import floorplan
    from .estimate_scan import scans_of
    scans = scans_of(db, tid)
    if method == "scan":
        cfg["scans"] = scans
        cfg["maxMB"] = 100
    plan_svg = floorplan.svg(items, sys_, title=f"Floor plan: {t['title']}")
    return render_template("estimate/step_measure.html", t=t, step=3, method=method, sys_=sys_, cfg=cfg,
                           items=[item_view(i, sys_) for i in items], totals=totals_view(items, sys_),
                           plans=plans, as_labels=G.AS_LABELS, colors=COLORS, edge_labels=G.EDGE_LABELS,
                           scans=scans, floorplan=Markup(plan_svg) if plan_svg else None)


def _clean_data(kind, data, sys_):
    """Data from the browser or the typing form -> SI, checked. Lengths typed as text are parsed in the takeoff's units."""
    if kind not in KINDS:
        raise ValueError("Choose what you're measuring.")
    d = dict(data or {})
    for k in ("length", "width", "height", "depth", "diameter", "radius", "base", "a", "b", "c", "spacing"):
        if k in d and isinstance(d[k], str):
            d[k] = U.parse_length(d[k], sys_)
    for k in ("ridge", "hip", "valley", "eave", "rake", "flashing", "plan_area", "area", "perimeter", "count", "hours", "corners"):
        if k in d and isinstance(d[k], str):
            v = U.parse_number(d[k])
            if v is not None and k in ("ridge", "hip", "valley", "eave", "rake", "flashing", "perimeter"):
                v = U.to_si(v, "ft" if sys_ == "imperial" else "m")
            elif v is not None and k in ("plan_area", "area"):
                v = U.to_si(v, "ft2" if sys_ == "imperial" else "m2")
            d[k] = v
    for o in d.get("openings") or []:
        for k in ("width", "height"):
            if isinstance(o.get(k), str):
                o[k] = U.parse_length(o[k], sys_)
    for gt in d.get("gates") or []:
        if isinstance(gt.get("width"), str):
            gt["width"] = U.parse_length(gt["width"], sys_)
    if kind == "roof":
        G.pitch_factor(G.pitch_degrees(d.get("pitch")))   # checks the pitch
    q = G.item_quantities(kind, d)
    for k, v in q.items():
        if k != "_edges" and isinstance(v, float) and (v != v or v < 0):
            raise ValueError("That measurement doesn't add up. Check the numbers.")
    return d


@bp.route("/<int:tid>/items", methods=["GET", "POST"])
def items_api(tid):
    """GET: every measurement and the totals. POST (JSON): add or change one measurement."""
    db = get_db()
    t = _t(tid)
    sys_ = _units(t)
    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        try:
            data = _clean_data(body.get("kind"), body.get("data"), sys_)
        except ValueError as e:
            return _api_error(str(e))
        iid = opt_int(body.get("id"))
        vals = (body["kind"], body.get("source") or "manual", (body.get("label") or "").strip()[:80] or None,
                (body.get("group") or "").strip()[:40] or None, body.get("color") or None, json.dumps(data),
                opt_int(body.get("plan_id")), opt_int(body.get("page")), 1 if body.get("verified") else 0)
        if iid:
            if not db.execute("SELECT 1 FROM takeoff_items WHERE id=? AND takeoff_id=?", (iid, tid)).fetchone():
                return _api_error("That measurement isn't on this estimate.", 404)
            db.execute("UPDATE takeoff_items SET kind=?, source=?, label=?, grp=?, color=?, data=?, plan_id=?, page=?, verified=?"
                       " WHERE id=?", vals + (iid,))
        else:
            n = db.execute("SELECT COALESCE(MAX(sort),0)+1 FROM takeoff_items WHERE takeoff_id=?", (tid,)).fetchone()[0]
            iid = db.execute("INSERT INTO takeoff_items (kind, source, label, grp, color, data, plan_id, page, verified,"
                             " takeoff_id, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?)", vals + (tid, n)).lastrowid
        _touch(tid)
        db.commit()
    items = store.items_of(db, tid)
    out = {"ok": True, "items": [item_view(i, sys_) for i in items], "totals": totals_view(items, sys_)}
    if request.method == "POST":
        out["id"] = iid
    return jsonify(out)


@bp.route("/<int:tid>/items/<int:iid>/delete", methods=["POST"])
def item_delete(tid, iid):
    db = get_db()
    t = _t(tid)
    row = db.execute("SELECT * FROM takeoff_items WHERE id=? AND takeoff_id=?", (iid, tid)).fetchone()
    if not row:
        return _api_error("That measurement isn't on this estimate.", 404)
    db.execute("DELETE FROM takeoff_items WHERE id=?", (iid,))
    _touch(tid)
    db.commit()
    items = store.items_of(db, tid)
    sys_ = _units(t)
    gone = {k: row[k] for k in row.keys() if k not in ("id",)}
    gone["data"] = json.loads(row["data"])
    gone["group"] = row["grp"]
    if request.is_json or request.headers.get("X-Requested-With") == "fetch":
        return jsonify({"ok": True, "items": [item_view(i, sys_) for i in items], "totals": totals_view(items, sys_),
                        "deleted": gone})
    flash("Measurement removed.", "ok")
    return redirect(url_for("estimate.measure", tid=tid, m="manual"))


# The typing form (works with no JavaScript, and with a laser measurer that types into the box)
@bp.route("/<int:tid>/items/manual", methods=["POST"])
@guarded
def item_manual(tid):
    db = get_db()
    t = _t(tid)
    sys_ = _units(t)
    f = request.form
    kind = f.get("kind")
    data = {k: f.get(k) for k in ("length", "width", "height", "depth", "diameter", "base", "a", "b", "c", "area",
                                  "perimeter", "count", "hours", "spacing", "plan_area", "corners", "as")
            if (f.get(k) or "").strip()}
    if kind == "room":
        ops = []
        for k, w, h, n in zip(f.getlist("op_kind"), f.getlist("op_w"), f.getlist("op_h"), f.getlist("op_n")):
            if (w or "").strip() and (h or "").strip():
                ops.append({"kind": k, "width": w, "height": h, "count": U.parse_number(n, 1) or 1})
        data["openings"] = ops
    if kind == "roof":
        data["pitch"] = ({"rise": U.parse_number(f.get("rise")), "run": U.parse_number(f.get("run"), 12)}
                         if (f.get("rise") or "").strip() else {"deg": U.parse_number(f.get("pitch_deg"), 0)})
        for e in G.EDGE_TYPES:
            if (f.get(e) or "").strip():
                data[e] = f.get(e)
    if kind == "fence":
        n = U.parse_number(f.get("gates"), 0) or 0
        if n:
            data["gates"] = [{"width": f.get("gate_width") or "0", "count": int(n)}]
    data = _clean_data(kind, data, sys_)
    iid = opt_int(f.get("id"))
    label = (f.get("label") or "").strip()[:80] or None
    grp = (f.get("group") or "").strip()[:40] or None
    src = "laser" if f.get("source") == "laser" else "manual"
    if iid:
        db.execute("UPDATE takeoff_items SET kind=?, label=?, grp=?, data=?, verified=? WHERE id=? AND takeoff_id=?",
                   (kind, label, grp, json.dumps(data), 1 if f.get("verified") else 0, iid, tid))
    else:
        n = db.execute("SELECT COALESCE(MAX(sort),0)+1 FROM takeoff_items WHERE takeoff_id=?", (tid,)).fetchone()[0]
        db.execute("INSERT INTO takeoff_items (takeoff_id, kind, source, label, grp, color, data, verified, sort)"
                   " VALUES (?,?,?,?,?,?,?,?,?)", (tid, kind, src, label, grp, COLORS[(n - 1) % len(COLORS)],
                                                   json.dumps(data), 1, n))
    _touch(tid)
    flash(f"{label or KINDS[kind]} saved.", "ok")
    return redirect(url_for("estimate.measure", tid=tid, m="manual") + "#list")


@bp.route("/<int:tid>/view", methods=["POST"])
def save_view(tid):
    """Where the map was left (so it opens there again). Only a centre and zoom: never imagery."""
    _t(tid)
    b = request.get_json(silent=True) or {}
    try:
        v = {"lat": float(b["lat"]), "lng": float(b["lng"]), "zoom": int(b["zoom"])}
    except (KeyError, TypeError, ValueError):
        return _api_error("No map position.")
    get_db().execute("UPDATE takeoffs SET map_view=? WHERE id=?", (json.dumps(v), tid))
    get_db().commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- plans and photos
@bp.route("/<int:tid>/plans", methods=["POST"])
def plan_upload(tid):
    db = get_db()
    _t(tid)
    f = request.files.get("file")
    if not f or not f.filename:
        return _api_error("Choose a PDF plan or a photo.")
    data = f.read(MAX_PLAN_BYTES + 1)
    if len(data) > MAX_PLAN_BYTES:
        return _api_error("That file is over 40 MB. Save a smaller copy (one page, or a lower resolution) and try again.")
    mime = f.mimetype if f.mimetype in PLAN_TYPES else None
    if data[:5] == b"%PDF-":
        mime = "application/pdf"
    elif data[:8] == b"\x89PNG\r\n\x1a\n":
        mime = "image/png"
    elif data[:3] == b"\xff\xd8\xff":
        mime = "image/jpeg"
    if mime not in PLAN_TYPES:
        return _api_error("That isn't a PDF or a picture (PNG, JPG, WebP).")
    pages = max(1, int(request.form.get("pages") or 1))
    pid = db.execute("INSERT INTO takeoff_plans (takeoff_id, name, mime, data, pages) VALUES (?,?,?,?,?)",
                     (tid, f.filename[:120], mime, data, pages)).lastrowid
    _touch(tid)
    db.commit()
    return jsonify({"ok": True, "plan": {"id": pid, "name": f.filename[:120], "mime": mime, "pages": pages}})


@bp.route("/<int:tid>/plans/<int:pid>/file")
def plan_file(tid, pid):
    r = get_db().execute("SELECT * FROM takeoff_plans WHERE id=? AND takeoff_id=?", (pid, tid)).fetchone() or abort(404)
    return Response(r["data"], mimetype=r["mime"], headers={"Cache-Control": "private, max-age=3600",
                                                            "X-Content-Type-Options": "nosniff"})


@bp.route("/<int:tid>/plans/<int:pid>/page", methods=["POST"])
def plan_page(tid, pid):
    """A page's scale (set from a line of known length, or a drawing scale like 1:100), size, page count, and a
    picture of the page with the lines drawn on it (for the quote's measurements page)."""
    db = get_db()
    _t(tid)
    if not db.execute("SELECT 1 FROM takeoff_plans WHERE id=? AND takeoff_id=?", (pid, tid)).fetchone():
        return _api_error("That plan isn't on this estimate.", 404)
    b = request.get_json(silent=True) or {}
    page = int(b.get("page") or 1)
    if b.get("pages"):
        db.execute("UPDATE takeoff_plans SET pages=? WHERE id=?", (max(1, int(b["pages"])), pid))
    db.execute("INSERT OR IGNORE INTO takeoff_plan_pages (plan_id, page) VALUES (?,?)", (pid, page))
    if b.get("scale") is not None:
        s = float(b["scale"])
        if not 0 < s < 1e6:
            return _api_error("That scale doesn't look right.")
        db.execute("UPDATE takeoff_plan_pages SET scale=?, scale_note=? WHERE plan_id=? AND page=?",
                   (s, (b.get("note") or "")[:60], pid, page))
        # measurements already drawn on this page take the new scale
        for it in db.execute("SELECT id, data FROM takeoff_items WHERE plan_id=? AND page=?", (pid, page)).fetchall():
            d = json.loads(it["data"])
            d["scale"] = s
            db.execute("UPDATE takeoff_items SET data=? WHERE id=?", (json.dumps(d), it["id"]))
    if b.get("width"):
        db.execute("UPDATE takeoff_plan_pages SET width=?, height=? WHERE plan_id=? AND page=?",
                   (float(b["width"]), float(b.get("height") or 0), pid, page))
    snap = b.get("snapshot") or ""
    if snap.startswith("data:image/png;base64,"):
        png = base64.b64decode(snap.split(",", 1)[1])
        if png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) < 8 * 1024 * 1024:
            db.execute("UPDATE takeoff_plan_pages SET snapshot=? WHERE plan_id=? AND page=?", (png, pid, page))
    _touch(tid)
    db.commit()
    return jsonify({"ok": True})


@bp.route("/<int:tid>/plans/<int:pid>/delete", methods=["POST"])
@guarded
def plan_delete(tid, pid):
    db = get_db()
    _t(tid)
    db.execute("DELETE FROM takeoff_items WHERE plan_id=? AND takeoff_id=?", (pid, tid))
    db.execute("DELETE FROM takeoff_plan_pages WHERE plan_id=?", (pid,))
    db.execute("DELETE FROM takeoff_plans WHERE id=? AND takeoff_id=?", (pid, tid))
    flash("Plan and the measurements drawn on it removed.", "ok")
    return redirect(url_for("estimate.measure", tid=tid, m="plan"))


# ---------------------------------------------------------------- step 4: trade template
@bp.route("/<int:tid>/template", methods=["GET", "POST"])
def template(tid):
    db = get_db()
    t = _t(tid)
    sys_ = _units(t)
    store.seed_templates(db, sys_)
    db.commit()
    if request.method == "POST":
        ids = [int(x) for x in request.form.getlist("template_id") if x.isdigit()]
        if not ids:
            flash("Choose at least one template.", "error")
            return redirect(url_for("estimate.template", tid=tid))
        db.execute("UPDATE takeoffs SET templates=?, updated_at=datetime('now','localtime') WHERE id=?", (json.dumps(ids), tid))
        db.commit()
        return redirect(url_for("estimate.price", tid=tid))
    chosen = store.template_ids(t)
    # recently used first (by the business's other estimates), then the rest A to Z
    recent = {}
    for r in db.execute("SELECT templates, updated_at FROM takeoffs WHERE templates IS NOT NULL ORDER BY updated_at"):
        for x in store.template_ids(r):
            recent[x] = r["updated_at"]
    tpls = [dict(r) for r in db.execute("SELECT t.*, (SELECT COUNT(*) FROM measure_template_lines l WHERE l.template_id=t.id)"
                                        " n, (SELECT COUNT(*) FROM measure_template_lines l WHERE l.template_id=t.id AND"
                                        " (l.rate IS NULL OR l.rate=0) AND l.item_id IS NULL) unpriced FROM measure_templates t"
                                        " WHERE t.active=1 AND (t.units=? OR t.shipped=0) ORDER BY t.name", (sys_,))]
    rec = sorted((x for x in tpls if x["id"] in recent), key=lambda x: recent[x["id"]], reverse=True)
    tpls = rec + [x for x in tpls if x["id"] not in recent]
    items = store.items_of(db, tid)
    have = set(G.takeoff_quantities(items))
    for x in tpls:
        x["icon"] = TRADE_ICONS.get(x["trade"] or "", "📐")
        x["recent"] = x["id"] in recent
        bases = {r["basis"] for r in db.execute("SELECT basis FROM measure_template_lines WHERE template_id=?", (x["id"],))}
        x["fits"] = bool(bases & have) or not items
    return render_template("estimate/step_template.html", t=t, step=4, tpls=tpls, chosen=chosen)


# ---------------------------------------------------------------- step 5: review price
@bp.route("/<int:tid>/price", methods=["GET", "POST"])
def price(tid):
    db = get_db()
    t = _t(tid)
    if request.method == "POST":
        return _save_adjust(tid)
    priced = Q.price(db, t)
    doc, st = Q.quote_state(db, t)
    return render_template("estimate/step_price.html", t=t, step=5, p=priced, adj=Q.adjustments(t), doc=doc, qst=st)


@guarded
def _save_adjust(tid):
    db = get_db()
    t = _t(tid)
    f = request.form
    adj = Q.adjustments(t)
    adj["markup_pct"] = U.parse_number(f.get("markup_pct"), 0) or 0
    lines = adj.get("lines") or {}
    for key in f:
        if key.startswith("rate_") or key.startswith("waste_"):
            kind, lid = key.split("_", 1)
            v = (f.get(key) or "").strip()
            o = lines.setdefault(lid, {})
            if kind == "rate":
                o["rate"] = to_cents(v) if v else None
            else:
                o["waste_pct"] = U.parse_number(v) if v else None
            if f.get("save_to_template") and v:   # also change the template, for next time
                col = "rate" if kind == "rate" else "waste_pct"
                db.execute(f"UPDATE measure_template_lines SET {col}=? WHERE id=?", (o[kind if kind == "rate" else "waste_pct"], int(lid)))
    adj["lines"] = {k: v for k, v in lines.items() if any(x is not None for x in v.values())}
    db.execute("UPDATE takeoffs SET adjust=?, updated_at=datetime('now','localtime') WHERE id=?", (json.dumps(adj), tid))
    if f.get("go") == "quote":
        did, how = Q.make_quote(db, tid)
        num = db.execute("SELECT number FROM documents WHERE id=?", (did,)).fetchone()["number"]
        flash(f"Quote {num} {how}.", "ok")
        return redirect(url_for("estimate.send", tid=tid))
    flash("Price updated.", "ok")
    return redirect(url_for("estimate.price", tid=tid))


@bp.route("/<int:tid>/quote", methods=["POST"])
@guarded
def make_quote(tid):
    db = get_db()
    did, how = Q.make_quote(db, tid)
    num = db.execute("SELECT number FROM documents WHERE id=?", (did,)).fetchone()["number"]
    flash(f"Quote {num} {how}.", "ok")
    return redirect(url_for("estimate.send", tid=tid))


# ---------------------------------------------------------------- step 6: send
@bp.route("/<int:tid>/send")
def send(tid):
    db = get_db()
    t = _t(tid)
    doc, st = Q.quote_state(db, t)
    if not doc:
        flash("Make the quote first (step 5).", "error")
        return redirect(url_for("estimate.price", tid=tid))
    from .. import perms
    from .quotes import uses_bookings
    c = db.execute("SELECT email FROM contacts WHERE id=?", (doc["contact_id"],)).fetchone()
    return render_template("estimate/step_send.html", t=t, step=6, doc=doc, qst=st, cemail=c["email"] if c else "",
                           status=Q.status_of(db, t), bookings=uses_bookings(db) and perms.can("bookings", perms.EDIT))


@bp.route("/<int:tid>/quote.pdf")
def quote_pdf(tid):
    db = get_db()
    t = _t(tid)
    if not t["document_id"]:
        abort(404)
    from .. import pdf as pdfmod
    name, _ = pdfmod.document_filename(db, t["document_id"])
    disp = "attachment" if request.args.get("download") else "inline"
    return Response(pdfmod.document_pdf(db, t["document_id"]), mimetype="application/pdf",
                    headers={"Content-Disposition": f'{disp}; filename="{name}"'})


@bp.route("/<int:tid>/sent", methods=["POST"])
def mark_sent(tid):
    db = get_db()
    _t(tid)
    db.execute("UPDATE takeoffs SET sent_at=COALESCE(sent_at, datetime('now','localtime')) WHERE id=?", (tid,))
    db.commit()
    flash("Marked as sent.", "ok")
    return redirect(url_for("estimate.send", tid=tid))


@bp.route("/<int:tid>/summary", methods=["POST"])
@guarded
def summary_toggle(tid):
    db = get_db()
    _t(tid)
    db.execute("UPDATE takeoffs SET summary_on_pdf=? WHERE id=?", (1 if request.form.get("on") else 0, tid))
    flash("Saved.", "ok")
    return redirect(url_for("estimate.send", tid=tid))


# ---------------------------------------------------------------- duplicate, delete, units
@bp.route("/<int:tid>/duplicate", methods=["POST"])
@guarded
def duplicate(tid):
    nid = Q.duplicate(get_db(), tid)
    flash("Copied. Change the customer and sizes, then price it.", "ok")
    return redirect(url_for("estimate.customer", tid=nid))


@bp.route("/<int:tid>/delete", methods=["POST"])
@guarded
def delete(tid):
    db = get_db()
    t = _t(tid)
    db.execute("DELETE FROM takeoff_items WHERE takeoff_id=?", (tid,))
    for p in db.execute("SELECT id FROM takeoff_plans WHERE takeoff_id=?", (tid,)).fetchall():
        db.execute("DELETE FROM takeoff_plan_pages WHERE plan_id=?", (p["id"],))
    db.execute("DELETE FROM takeoff_plans WHERE takeoff_id=?", (tid,))
    db.execute("DELETE FROM takeoff_scans WHERE takeoff_id=?", (tid,))
    db.execute("DELETE FROM takeoffs WHERE id=?", (tid,))
    audit(db, "estimate_deleted", t["title"])
    flash(f"{t['title']} deleted. Its quote (if any) is kept.", "ok")
    return redirect(url_for("estimate.index"))


@bp.route("/<int:tid>/units", methods=["POST"])
@guarded
def set_units(tid):
    u = request.form.get("units")
    get_db().execute("UPDATE takeoffs SET units=? WHERE id=?", (u if u in U.SYSTEMS else None, tid))
    return redirect(request.referrer or url_for("estimate.measure", tid=tid))


# ---------------------------------------------------------------- templates
@bp.route("/templates")
def templates():
    db = get_db()
    sys_ = store.company_units(g.company)
    store.seed_templates(db, sys_)
    db.commit()
    rows = db.execute("SELECT t.*, (SELECT COUNT(*) FROM measure_template_lines l WHERE l.template_id=t.id) n,"
                      " (SELECT COUNT(*) FROM measure_template_lines l WHERE l.template_id=t.id AND (l.rate IS NULL OR"
                      " l.rate=0) AND l.item_id IS NULL) unpriced FROM measure_templates t WHERE t.active=1 ORDER BY t.name").fetchall()
    return render_template("estimate/templates.html", rows=[dict(r, icon=TRADE_ICONS.get(r["trade"] or "", "📐")) for r in rows],
                           sys_=sys_)


BASES = [("fixed", "A fixed item (call-out, skip, scaffold)")] + [(k, v[0]) for k, v in G.QUANTITIES.items()]
UNIT_CHOICES = ["m2", "ft2", "square", "yd2", "m", "ft", "yd", "m3", "yd3", "ft3", "each", "hour", "item"]


@bp.route("/templates/new", methods=["GET", "POST"])
@bp.route("/templates/<int:tpl>", methods=["GET", "POST"])
def template_edit(tpl=None):
    db = get_db()
    if request.method == "POST":
        return _save_template(tpl)
    t, lines = store.template(db, tpl) if tpl else ({"name": "", "trade": "", "notes": "", "units": store.company_units(g.company),
                                                     "min_charge": 0, "shipped": 0}, [])
    if tpl and not t:
        abort(404)
    items = db.execute("SELECT id, sku, name, sell_price, buy_price FROM items WHERE active=1 AND is_sold=1 ORDER BY name").fetchall()
    return render_template("estimate/template_edit.html", tpl=t, tid=tpl, lines=lines, bases=BASES, units=UNIT_CHOICES,
                           unit_label=U.label, items=items, sections=engine.SECTIONS)


@guarded
def _save_template(tpl):
    db = get_db()
    f = request.form
    name = (f.get("name") or "").strip()
    if not name:
        raise PostingError("Give the template a name.")
    vals = (name[:80], (f.get("trade") or "").strip()[:40] or None, (f.get("notes") or "").strip() or None,
            f.get("units") if f.get("units") in U.SYSTEMS else "metric", to_cents(f.get("min_charge") or "0"))
    if tpl:
        db.execute("UPDATE measure_templates SET name=?, trade=?, notes=?, units=?, min_charge=?, updated_at=datetime('now','localtime')"
                   " WHERE id=?", vals + (tpl,))
    else:
        tpl = db.execute("INSERT INTO measure_templates (name, trade, notes, units, min_charge) VALUES (?,?,?,?,?)", vals).lastrowid
    keep = []
    cols = ("lid", "section", "description", "basis", "unit", "factor", "waste", "pack", "label", "group", "rate", "cost",
            "min", "item")
    rows = list(zip(*[f.getlist(f"l_{c}") for c in cols]))
    for n, r in enumerate(rows, 1):
        d = dict(zip(cols, r))
        if not d["description"].strip():
            continue
        if d["basis"] not in dict(BASES):
            raise PostingError(f"Line {n}: choose what it's priced by.")
        ln = {"sort": n, "section": d["section"] if d["section"] in engine.SECTIONS else "Other",
              "description": d["description"].strip()[:120], "basis": d["basis"],
              "unit": d["unit"] if d["unit"] in U.UNITS else "each", "factor": U.parse_number(d["factor"], 1) or 1,
              "waste_pct": U.parse_number(d["waste"], 0) or 0, "pack_size": U.parse_number(d["pack"], 0) or 0,
              "unit_label": d["label"].strip()[:30] or None, "group_filter": d["group"].strip()[:40] or None,
              "rate": to_cents(d["rate"]) if d["rate"].strip() else None,
              "cost": to_cents(d["cost"]) if d["cost"].strip() else None,
              "min_charge": to_cents(d["min"]) if d["min"].strip() else 0, "item_id": opt_int(d["item"])}
        lid = opt_int(d["lid"])
        if lid and not db.execute("SELECT 1 FROM measure_template_lines WHERE id=? AND template_id=?", (lid, tpl)).fetchone():
            lid = None
        keep.append(store.save_line(db, tpl, ln, lid))
    db.execute(f"DELETE FROM measure_template_lines WHERE template_id=? AND id NOT IN ({','.join('?' * len(keep)) or 'NULL'})",
               [tpl] + keep)
    flash(f"Template {name} saved.", "ok")
    return redirect(url_for("estimate.template_edit", tpl=tpl))


@bp.route("/templates/<int:tpl>/copy", methods=["POST"])
@guarded
def template_copy(tpl):
    db = get_db()
    t, lines = store.template(db, tpl)
    if not t:
        abort(404)
    nid = db.execute("INSERT INTO measure_templates (name, trade, notes, units, min_charge) VALUES (?,?,?,?,?)",
                     (f"{t['name']} (my copy)", t["trade"], t["notes"], t["units"], t["min_charge"])).lastrowid
    for ln in lines:
        store.save_line(db, nid, ln)
    flash("Copied. Change it to suit your work.", "ok")
    return redirect(url_for("estimate.template_edit", tpl=nid))


@bp.route("/templates/<int:tpl>/delete", methods=["POST"])
@guarded
def template_delete(tpl):
    db = get_db()
    db.execute("UPDATE measure_templates SET active=0 WHERE id=?", (tpl,))
    flash("Template removed. Estimates that used it keep their quotes.", "ok")
    return redirect(url_for("estimate.templates"))


@bp.route("/templates/from/<int:tid>", methods=["POST"])
@guarded
def template_from_estimate(tid):
    """Copy last job: a new template from this estimate's templates and its quick changes (rates, waste, markup)."""
    db = get_db()
    t = _t(tid)
    adj = Q.adjustments(t)
    ids = store.template_ids(t)
    if not ids:
        raise PostingError("Choose a template for this estimate first.")
    markup = float(adj.get("markup_pct") or 0)
    nid = db.execute("INSERT INTO measure_templates (name, units) VALUES (?,?)",
                     (f"Like {t['title']}"[:80], _units(t))).lastrowid
    n = 0
    for x in ids:
        tt, lines = store.template(db, x)
        for ln in lines:
            o = (adj.get("lines") or {}).get(str(ln["id"])) or {}
            if o.get("rate") is not None:
                ln["rate"] = o["rate"]
            if o.get("waste_pct") is not None:
                ln["waste_pct"] = o["waste_pct"]
            if markup and ln.get("rate"):
                ln["rate"] = int(round(ln["rate"] * (1 + markup / 100.0)))
            n += 1
            ln["sort"] = n
            store.save_line(db, nid, ln)
    flash("Saved as a template for next time.", "ok")
    return redirect(url_for("estimate.template_edit", tpl=nid))


@bp.route("/templates/prices", methods=["GET", "POST"])
def price_list():
    """Supplier price list (CSV): update material rates (and costs) in your templates by matching names or stock codes."""
    db = get_db()
    if request.method == "GET":
        return render_template("estimate/price_list.html", result=None)
    f = request.files.get("file")
    if not f or not f.filename:
        flash("Choose the supplier's price list (a CSV file).", "error")
        return redirect(url_for("estimate.price_list"))
    try:
        result = import_price_list(db, f.read().decode("utf-8-sig", errors="replace"),
                                   markup=U.parse_number(request.form.get("markup"), 0) or 0,
                                   apply=bool(request.form.get("apply")))
    except ValueError as e:
        flash(str(e), "error")
        return redirect(url_for("estimate.price_list"))
    if request.form.get("apply"):
        if g.get("estimate_read_only"):
            abort(402)
        db.commit()
        flash(f"{result['changed']} template line{'s' if result['changed'] != 1 else ''} updated from the price list.", "ok")
    return render_template("estimate/price_list.html", result=result, markup=request.form.get("markup") or "0")


def import_price_list(db, text, markup=0.0, apply=False):
    """CSV columns (any order, first row headings): name or description, code or sku (optional), price (your cost).
    Lines in your templates whose description, or linked stock item's code or name, matches get cost = price and
    rate = price + markup %. Returns {'rows', 'matched': [(line, old, new)], 'unmatched', 'changed'}."""
    rdr = csv.DictReader(io.StringIO(text))
    heads = {h.lower().strip(): h for h in (rdr.fieldnames or []) if h}
    name_h = next((heads[h] for h in ("name", "description", "product", "item") if h in heads), None)
    code_h = next((heads[h] for h in ("code", "sku", "item code", "product code") if h in heads), None)
    price_h = next((heads[h] for h in ("price", "cost", "unit price", "buy price") if h in heads), None)
    if not price_h or not (name_h or code_h):
        raise ValueError("The price list needs a heading row with a name (or code) column and a price column.")
    prices = {}
    n = 0
    for r in rdr:
        n += 1
        try:
            p = to_cents(r.get(price_h))
        except ValueError:
            continue
        for key in ((r.get(name_h) or "").strip().lower() if name_h else "", (r.get(code_h) or "").strip().lower() if code_h else ""):
            if key:
                prices[key] = p
    lines = db.execute("SELECT l.*, t.name tname, i.sku, i.name iname FROM measure_template_lines l JOIN measure_templates t"
                       " ON t.id=l.template_id LEFT JOIN items i ON i.id=l.item_id WHERE t.active=1 AND l.section='Materials'").fetchall()
    matched, hit = [], set()
    for l in lines:
        for key in ((l["sku"] or "").lower(), (l["iname"] or "").lower(), l["description"].lower()):
            if key and key in prices:
                cost = prices[key]
                rate = int(round(cost * (1 + markup / 100.0)))
                matched.append({"template": l["tname"], "line": l["description"], "old": l["rate"], "new": rate, "cost": cost})
                hit.add(key)
                if apply:
                    db.execute("UPDATE measure_template_lines SET rate=?, cost=? WHERE id=?", (rate, cost, l["id"]))
                break
    return {"rows": n, "matched": matched, "unmatched": sorted(k for k in prices if k not in hit)[:50],
            "changed": len(matched) if apply else 0}


# ---------------------------------------------------------------- settings
@bp.route("/settings", methods=["GET", "POST"])
def settings():
    db = get_db()
    if request.method == "POST":
        return _save_settings()
    return render_template("estimate/settings.html", units=store.company_units(g.company), providers=MAP_PROVIDERS)


@guarded
def _save_settings():
    db = get_db()
    f = request.form
    cur = (f.get("currency") or "").strip().upper()
    if cur and not (len(cur) == 3 and cur.isalpha()):
        raise PostingError("The currency is a 3-letter code, like USD, EUR, GBP, AUD or FJD.")
    db.execute("UPDATE company SET measure_units=?, tax_name=?, date_format=?, map_provider=?" + (", currency=?" if cur else "")
               + " WHERE id=1", [f.get("units") if f.get("units") in U.SYSTEMS else None,
                                 (f.get("tax_name") or "GST").strip()[:20] or "GST",
                                 f.get("date_format") if f.get("date_format") in ("iso", "dmy", "mdy") else "iso",
                                 f.get("map_provider") if f.get("map_provider") in MAP_PROVIDERS else "esri"] + ([cur] if cur else []))
    flash("Settings saved.", "ok")
    return redirect(url_for("estimate.settings"))


@bp.route("/help")
def help_page():
    return render_template("estimate/help.html")


@bp.route("/today")
def today_redirect():
    return redirect(url_for("estimate.index"))


def estimate_for_document(db, doc_id):
    """The estimate a quote came from (for the small link on a quote in the other apps), or None."""
    try:
        return db.execute("SELECT id, title FROM takeoffs WHERE document_id=?", (doc_id,)).fetchone()
    except Exception:
        return None


__all__ = ["bp", "register_filters", "money", "import_price_list", "estimate_for_document", "date"]


from . import estimate_scan  # noqa: E402,F401  (Import a scan: its routes are on this blueprint)
