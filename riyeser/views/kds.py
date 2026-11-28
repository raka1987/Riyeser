"""Kitchen display screen (KDS): open order tickets by station, on any tablet or PC browser.

Who can open it:
- someone signed in to Riyeser POS whose user has the "Kitchen screen" permission (Users & roles), or
- a paired device: on the till PC, POS > Kitchen shows the address to open and a 6-digit pairing code (10 minutes).
  The device keeps a long random key (only its hash is stored) and can be signed out under POS > Kitchen.

The desktop POS program only listens on this PC. Turning on "Kitchen screens on this network" opens a second
listener on the local network that serves the kitchen screen and nothing else (every other address gives 404).
The screen shows what to cook: item names, quantities, notes and options, the table or takeaway number, how long
it has waited, and moved or voided items. No prices, customers or totals are sent to it.
"""
import hashlib
import hmac
import json
import secrets
import socket
import threading
from datetime import datetime, timedelta

from flask import Blueprint, render_template, request, redirect, url_for, jsonify, g, current_app, make_response

from ..db import get_db, audit, write_txn
from .. import perms

bp = Blueprint("kds", __name__, url_prefix="/kds")
COOKIE = "riyeser_kds"
DEFAULTS = {"amber": 8, "red": 15, "lan": False}
PAIR_MINUTES = 10
PAIR_TRIES = 5
LAN_PORT = 8765


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def settings(db):
    raw = db.execute("SELECT kds_settings FROM company WHERE id=1").fetchone()[0]
    out = dict(DEFAULTS)
    try:
        out.update(json.loads(raw) if raw else {})
    except ValueError:
        pass
    return out


def save_settings(db, s):
    db.execute("UPDATE company SET kds_settings=? WHERE id=1", (json.dumps(s),))


def _hash(v):
    return hashlib.sha256(v.encode()).hexdigest()


def new_pair_code(db):
    code = f"{secrets.randbelow(1_000_000):06d}"
    s = settings(db)
    s.update(pair_hash=_hash(code), pair_code=code, pair_fails=0,
             pair_until=(datetime.now() + timedelta(minutes=PAIR_MINUTES)).strftime("%Y-%m-%d %H:%M:%S"))
    save_settings(db, s)
    return code


# ------------------------------------------------------------ who is asking: a paired device or a signed-in user
def _company_path(co_id):
    from .. import companies as co
    if not co_id or co_id == co.MAIN:
        return None
    return co.path_of(co_id)


def kds_guard(app):
    """Run before every kds.* request (riyeser/__init__.py). None: go ahead as a paired device (or to the pairing
    page). False: not a device; the normal sign-in rules apply (a user with the Kitchen screen permission)."""
    from .. import companies as co
    from .. import db as dbmod
    co_id, _, token = (request.cookies.get(COOKIE) or "").partition(".")
    is_pair = request.endpoint == "kds.pair"
    if is_pair and request.args.get("co"):
        co_id, token = request.args["co"], ""
    path = None
    if co_id and co_id != co.MAIN:
        path = co.path_of(co_id)
        if not path:
            co_id, token = "", ""
    if not token and not is_pair:
        return False
    g.db_path = path
    db = get_db()
    here = path or app.config["DATABASE"]
    migrated = app.config.setdefault("_migrated_dbs", set())
    if here not in migrated:
        dbmod.migrate(db)
        migrated.add(here)
    row = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    g.company = dict(row) if row else None
    g.kds_company = co_id or co.MAIN
    if token:
        d = db.execute("SELECT * FROM kds_devices WHERE token_hash=? AND revoked_at IS NULL", (_hash(token),)).fetchone()
        if d:
            g.kds_device = d
            if not d["last_seen"] or d["last_seen"][:16] != _now()[:16]:
                db.execute("UPDATE kds_devices SET last_seen=? WHERE id=?", (_now(), d["id"]))
                db.commit()
            return None
    if is_pair:
        return None
    from ..db import close_db
    close_db()
    g.db_path = None
    g.company = None
    return False


def _allowed(edit=False):
    if g.get("kds_device"):
        return True
    return perms.can("kitchen", perms.EDIT if edit else perms.VIEW)


def _deny():
    if request.accept_mimetypes.best == "application/json" or request.method == "POST" or request.path.endswith(".json"):
        return jsonify(ok=False, error="This screen isn't paired any more. Pair it again."), 401
    return redirect(url_for("kds.pair"))


# ------------------------------------------------------------ pairing
@bp.route("/pair", methods=["GET", "POST"])
def pair():
    db = get_db()
    err = None
    if request.method == "POST":
        write_txn(db)
        s = settings(db)
        code = (request.form.get("code") or "").strip().replace(" ", "")
        name = (request.form.get("name") or "").strip()[:40] or "Kitchen screen"
        live = s.get("pair_hash") and s.get("pair_until", "") > _now()
        if not live:
            err = "There's no pairing code right now. On the till, open POS > Kitchen and tap New pairing code."
        elif not hmac.compare_digest(_hash(code), s["pair_hash"]):
            s["pair_fails"] = int(s.get("pair_fails") or 0) + 1
            if s["pair_fails"] >= PAIR_TRIES:
                s.pop("pair_hash", None)
                s.pop("pair_code", None)
                err = "Too many wrong codes, so that code has stopped working. Make a new one on the till."
            else:
                err = "That code isn't right. Check the code on the till and try again."
            save_settings(db, s)
        else:
            token = secrets.token_urlsafe(32)
            station = request.form.get("station")
            db.execute("INSERT INTO kds_devices (name, token_hash, station_id) VALUES (?,?,?)",
                       (name, _hash(token), int(station) if station and station.isdigit() else None))
            for k in ("pair_hash", "pair_code", "pair_until", "pair_fails"):
                s.pop(k, None)  # a code pairs one screen
            save_settings(db, s)
            audit(db, "kds_paired", name)
            db.commit()
            resp = make_response(redirect(url_for("kds.board")))
            resp.set_cookie(COOKIE, f"{g.kds_company}.{token}", max_age=400 * 86400, httponly=True, samesite="Strict")
            return resp
        db.commit()
    return render_template("pos/kds_pair.html", err=err, company=g.get("company"))


@bp.route("/unpair", methods=["POST"])
def unpair():
    if g.get("kds_device"):
        db = get_db()
        db.execute("UPDATE kds_devices SET revoked_at=? WHERE id=?", (_now(), g.kds_device["id"]))
        db.commit()
    resp = make_response(redirect(url_for("kds.pair")))
    resp.delete_cookie(COOKIE)
    return resp


# ------------------------------------------------------------ the screen
@bp.route("/")
def board():
    if not _allowed():
        return _deny()
    db = get_db()
    from .pos_kitchen import stations
    sts = [dict(id=s["id"], name=s["name"]) for s in stations(db) if s["output"] in ("screen", "both")]
    s = settings(db)
    dev = g.get("kds_device")
    return render_template("pos/kds.html", stations=sts, amber=s["amber"], red=s["red"],
                           device=dict(name=dev["name"], station=dev["station_id"]) if dev else None,
                           can_bump=_allowed(edit=True), company_name=(g.company["name"] if g.get("company") else ""))


def tickets(db, station=None, now=None):
    """Open tickets for screen stations, oldest first. Only what the kitchen needs: no prices."""
    from .pos_kitchen import label
    now = now or datetime.now()
    q = ("SELECT t.*, s.name station_name, o.order_type, o.table_no, o.note order_note, o.id oid, o.status ostatus"
         " FROM kds_tickets t JOIN pos_stations s ON s.id=t.station_id JOIN pos_orders o ON o.id=t.order_id"
         " WHERE t.bumped_at IS NULL AND s.output IN ('screen','both') AND s.active=1")
    args = []
    if station:
        q += " AND t.station_id=?"
        args.append(station)
    out = []
    for t in db.execute(q + " ORDER BY t.created_at, t.id", args).fetchall():
        items = db.execute("SELECT * FROM kds_items WHERE ticket_id=? ORDER BY id", (t["id"],)).fetchall()
        if not items:
            continue
        waited = max(0, int((now - datetime.strptime(t["created_at"], "%Y-%m-%d %H:%M:%S")).total_seconds()))
        out.append(dict(id=t["id"], label=label(dict(id=t["oid"], order_type=t["order_type"], table_no=t["table_no"])),
                        station=t["station_name"], station_id=t["station_id"], send=t["send_no"],
                        order=t["oid"], at=t["created_at"][11:16], waited=waited, note=t["order_note"] or "",
                        recalled=bool(t["recalled_at"]), cancelled=t["ostatus"] == "cancelled",
                        items=[dict(id=k["id"], name=k["name"], qty=k["qty"], note=k["note"] or "",
                                    voided=k["status"] == "voided", voided_qty=k["voided_qty"] or 0,
                                    moved_from=k["moved_from"] or "", bumped=bool(k["bumped_at"])) for k in items]))
    return out


@bp.route("/tickets.json")
def tickets_json():
    if not _allowed():
        return _deny()
    db = get_db()
    st = request.args.get("station")
    s = settings(db)
    last = _last_bumped(db, int(st) if st and st.isdigit() else None)
    return jsonify(ok=True, now=_now(), amber=s["amber"] * 60, red=s["red"] * 60,
                   tickets=tickets(db, int(st) if st and st.isdigit() else None),
                   recall=dict(id=last["id"], label=last["label"]) if last else None)


def _last_bumped(db, station=None):
    from .pos_kitchen import label
    q = ("SELECT t.*, o.order_type, o.table_no FROM kds_tickets t JOIN pos_orders o ON o.id=t.order_id JOIN"
         " pos_stations s ON s.id=t.station_id WHERE t.bumped_at IS NOT NULL AND s.output IN ('screen','both')")
    args = []
    if station:
        q += " AND t.station_id=?"
        args.append(station)
    r = db.execute(q + " ORDER BY t.bumped_at DESC, t.id DESC LIMIT 1", args).fetchone()
    return dict(id=r["id"], label=label(dict(id=r["order_id"], order_type=r["order_type"], table_no=r["table_no"]))) \
        if r else None


@bp.route("/bump", methods=["POST"])
def bump():
    """Bump one item, or the whole ticket. A ticket whose items are all done (or voided) is bumped."""
    if not _allowed(edit=True):
        return _deny()
    db = get_db()
    d = request.get_json(silent=True) or {}
    write_txn(db)
    stamp = _now()
    if d.get("item_id"):
        k = db.execute("SELECT * FROM kds_items WHERE id=?", (int(d["item_id"]),)).fetchone()
        if not k:
            return jsonify(ok=False, error="That item has gone."), 404
        db.execute("UPDATE kds_items SET bumped_at=? WHERE id=?", (None if k["bumped_at"] else stamp, k["id"]))
        tid = k["ticket_id"]
        if not db.execute("SELECT 1 FROM kds_items WHERE ticket_id=? AND bumped_at IS NULL AND status<>'voided'",
                          (tid,)).fetchone():
            db.execute("UPDATE kds_tickets SET bumped_at=? WHERE id=?", (stamp, tid))
    else:
        tid = int(d.get("ticket_id") or 0)
        if not db.execute("SELECT 1 FROM kds_tickets WHERE id=? AND bumped_at IS NULL", (tid,)).fetchone():
            return jsonify(ok=False, error="That ticket has already gone."), 404
        db.execute("UPDATE kds_items SET bumped_at=? WHERE ticket_id=? AND bumped_at IS NULL", (stamp, tid))
        db.execute("UPDATE kds_tickets SET bumped_at=? WHERE id=?", (stamp, tid))
    db.commit()
    return jsonify(ok=True)


@bp.route("/recall", methods=["POST"])
def recall():
    """Bring back the last bumped ticket (at this station), as it was before it was bumped."""
    if not _allowed(edit=True):
        return _deny()
    db = get_db()
    d = request.get_json(silent=True) or {}
    write_txn(db)
    st = d.get("station")
    last = _last_bumped(db, int(st) if st and str(st).isdigit() else None)
    if not last:
        return jsonify(ok=False, error="Nothing to recall."), 404
    t = db.execute("SELECT * FROM kds_tickets WHERE id=?", (last["id"],)).fetchone()
    db.execute("UPDATE kds_items SET bumped_at=NULL WHERE ticket_id=? AND bumped_at=?", (t["id"], t["bumped_at"]))
    db.execute("UPDATE kds_tickets SET bumped_at=NULL, recalled_at=? WHERE id=?", (_now(), t["id"]))
    db.commit()
    return jsonify(ok=True, recalled=last)


# ------------------------------------------------------------ the local-network listener (desktop POS)
_lan = {"server": None, "thread": None, "port": None, "error": None}


def kds_only(app):
    """WSGI wrapper for the network listener: the kitchen screen's addresses, nothing else."""
    def wsgi(environ, start_response):
        path = environ.get("PATH_INFO") or "/"
        if path == "/":
            start_response("302 Found", [("Location", "/kds/")])
            return [b""]
        if not (path == "/kds" or path.startswith("/kds/")):
            start_response("404 Not Found", [("Content-Type", "text/plain; charset=utf-8")])
            return [b"Not found. This address only shows the Riyeser kitchen screen: /kds/"]
        return app(environ, start_response)
    return wsgi


def lan_addresses(port=None):
    """This PC's addresses on the local network (for the tablet to open). No internet needed."""
    port = port or _lan["port"] or LAN_PORT
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:  # the address used for the local network (a UDP "connect" sends nothing)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    ips = sorted(i for i in ips if not i.startswith("127."))
    return [f"http://{i}:{port}/kds/" for i in ips]


def lan_listener():
    return dict(running=bool(_lan["server"]), port=_lan["port"] or LAN_PORT, error=_lan["error"])


def start_lan(app=None, port=None):
    """Start the kitchen-screen listener on the local network. Returns an error message, or None."""
    if _lan["server"]:
        return None
    app = app or current_app._get_current_object()
    port = port or app.config.get("KDS_PORT") or LAN_PORT
    try:
        from waitress import create_server
        srv = create_server(kds_only(app), host="0.0.0.0", port=port, threads=4)
    except Exception as e:  # port in use, no permission
        _lan["error"] = f"Couldn't open the kitchen screen on the network (port {port}): {e}"
        return _lan["error"]
    th = threading.Thread(target=srv.run, daemon=True, name="riyeser-kds")
    th.start()
    _lan.update(server=srv, thread=th, port=port, error=None)
    return None


def stop_lan():
    srv = _lan.get("server")
    if srv:
        try:
            srv.close()
        except Exception:
            pass
    _lan.update(server=None, thread=None)


def autostart(app):
    """At start-up (riyeser/desktop.py): open the network listener again if it was left on."""
    try:
        with app.app_context():
            from flask import g as _g
            _g.db_path = None
            db = get_db()
            on = settings(db).get("lan")
        if on:
            start_lan(app)
    except Exception:
        pass
