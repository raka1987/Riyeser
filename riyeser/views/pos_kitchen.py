"""Kitchen: stations (kitchen, bar, ...), what each order line has been sent, and the tickets for the kitchen
display screen (riyeser/views/kds.py) and the printed dockets.

Every line on an open order has its own id (uid) and remembers when it went to the kitchen (sent). "Send to
kitchen" sends only lines not sent before, one ticket per station. A station prints a docket, shows the ticket on
the kitchen screen, or both. Lines already sent are never sent again: not when the order is saved again, not when
items or the whole order move to another table. Taking away a sent line (or some of its quantity) shows it as voided
on the kitchen screen.
"""
import json
import secrets

from flask import render_template, request, redirect, url_for, flash, abort, g

from ..db import get_db, audit, write_txn
from .. import perms
from . import opt_int
from .pos import bp

OUTPUTS = {"print": "Print a docket", "screen": "Kitchen screen", "both": "Both"}


def new_uid():
    return secrets.token_hex(6)


def now():
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def lines_of(o):
    """An order's lines, each with a uid and sent time. Older orders (before line ids) get steady ids from their
    position, and count as sent when the order was sent to the kitchen."""
    lines = json.loads(o["lines"]) if o["lines"] else []
    for n, l in enumerate(lines):
        if not l.get("uid"):
            l["uid"] = f"o{o['id']}l{n}"
        if "sent" not in l:
            l["sent"] = o["kitchen_sent_at"] if "kitchen_sent_at" in o.keys() else None
    return lines


def label(o):
    if o["order_type"] == "dine_in" and o["table_no"]:
        return f"Table {o['table_no']}"
    if o["order_type"] == "takeaway":
        return f"Takeaway #{o['id']}"
    return f"Order #{o['id']}"


def event(db, oid, kind, details):
    """Every move, merge, split and void is kept with who did it (and in the audit trail)."""
    db.execute("INSERT INTO pos_order_events (order_id, kind, details, user_id) VALUES (?,?,?,?)",
               (oid, kind, json.dumps(details), g.user["id"] if g.get("user") else None))
    audit(db, f"pos_order_{kind}", f"order {oid}: {json.dumps(details)[:300]}")


def reconcile(old_lines, new_lines):
    """The order's lines after an edit at the till. Sent lines can't change what was cooked: more of a sent item is
    a new (unsent) line, less is voided. Returns (lines, voids [(uid, qty)])."""
    old = {l["uid"]: l for l in old_lines}
    out, voids, seen = [], [], set()
    for nl in new_lines:
        o = old.get(nl.get("uid")) if nl.get("uid") else None
        if o is None or not o.get("sent"):
            line = dict(nl, sent=None)
            if o is None or nl["uid"] in seen:
                line["uid"] = new_uid()
            if o is not None and o.get("moved_from"):
                line["moved_from"] = o["moved_from"]
            seen.add(line["uid"])
            out.append(line)
            continue
        seen.add(o["uid"])
        keep = dict(o, discount_pct=nl.get("discount_pct", o.get("discount_pct", 0)))
        if nl["qty"] > o["qty"] + 1e-9:
            out.append(keep)
            out.append(dict(nl, uid=new_uid(), sent=None, qty=round(nl["qty"] - o["qty"], 6)))
        elif nl["qty"] < o["qty"] - 1e-9:
            voids.append((o["uid"], round(o["qty"] - nl["qty"], 6)))
            keep["qty"] = nl["qty"]
            out.append(keep)
        else:
            out.append(keep)
    for uid, o in old.items():
        if uid not in seen and o.get("sent"):
            voids.append((uid, o["qty"]))
    return out, voids


def void_on_screen(db, voids):
    """Sent items taken off an order: struck through on the kitchen screen (and listed on the next docket)."""
    for uid, qty in voids:
        k = db.execute("SELECT * FROM kds_items WHERE line_uid=? ORDER BY id DESC LIMIT 1", (uid,)).fetchone()
        if not k:
            continue
        vq = min(k["qty"], (k["voided_qty"] or 0) + qty)
        db.execute("UPDATE kds_items SET voided_qty=?, status=? WHERE id=?",
                   (vq, "voided" if vq >= k["qty"] - 1e-9 else k["status"], k["id"]))
        db.execute("UPDATE kds_tickets SET bumped_at=NULL WHERE id=? AND bumped_at IS NOT NULL", (k["ticket_id"],))


def stations(db, active_only=True):
    return db.execute("SELECT * FROM pos_stations" + (" WHERE active=1" if active_only else "")
                      + " ORDER BY sort, id").fetchall()


def station_for(db, item_id, cache):
    """Which station an item goes to: its category's station, else the first one."""
    if "default" not in cache:
        s = stations(db)
        cache["default"] = s[0]["id"] if s else None
        cache["cats"] = {r["category"]: r["station_id"] for r in db.execute(
            "SELECT c.* FROM pos_station_categories c JOIN pos_stations s ON s.id=c.station_id WHERE s.active=1")}
    cat = db.execute("SELECT category FROM items WHERE id=?", (item_id,)).fetchone()
    return cache["cats"].get(cat["category"] if cat else None, cache["default"])


def send_to_kitchen(db, o, lines):
    """Send the lines not sent before: a ticket per station. Returns (lines, send number, stations that print)."""
    write_txn(db)
    todo = [l for l in lines if not l.get("sent")]
    if not todo:
        return lines, None, []
    names = {r["id"]: r["name"] for r in db.execute("SELECT id, name FROM items")}
    send_no = (db.execute("SELECT COALESCE(MAX(send_no),0) FROM kds_tickets WHERE order_id=?",
                          (o["id"],)).fetchone()[0] or 0) + 1
    cache, tickets, stamp = {}, {}, now()
    for l in todo:
        st = station_for(db, l["item_id"], cache)
        if st is None:
            continue
        if st not in tickets:
            tickets[st] = db.execute("INSERT INTO kds_tickets (order_id, station_id, send_no, created_at) VALUES"
                                     " (?,?,?,?)", (o["id"], st, send_no, stamp)).lastrowid
        db.execute("INSERT INTO kds_items (ticket_id, line_uid, name, qty, note, moved_from) VALUES (?,?,?,?,?,?)",
                   (tickets[st], l["uid"], names.get(l["item_id"], "?"), l["qty"], l.get("note") or None,
                    l.get("moved_from")))
        l["sent"] = stamp
    printing = [s["id"] for s in stations(db) if s["id"] in tickets and s["output"] in ("print", "both")]
    return lines, send_no, printing


# ------------------------------------------------------------ dockets
@bp.route("/docket/<int:oid>")
def docket(oid):
    """The kitchen docket. With ?send=N: only what that send added (per printing station). Without: the whole
    order (a reprint)."""
    db = get_db()
    o = db.execute("SELECT * FROM pos_orders WHERE id=?", (oid,)).fetchone()
    if not o:
        abort(404)
    from .pos import _order_json
    send = opt_int(request.args.get("send"))
    groups = []
    if send:
        for s in stations(db, active_only=False):
            if s["output"] not in ("print", "both"):
                continue
            items = db.execute("SELECT k.* FROM kds_items k JOIN kds_tickets t ON t.id=k.ticket_id WHERE t.order_id=?"
                               " AND t.send_no=? AND t.station_id=? ORDER BY k.id", (oid, send, s["id"])).fetchall()
            if items:
                groups.append(dict(station=s["name"], items=items))
    return render_template("pos/docket.html", o=_order_json(db, o), user=g.user, groups=groups, send=send,
                           label=label(o), several=len(stations(db)) > 1)


# ------------------------------------------------------------ stations setup (and the kitchen screen's settings)
@bp.route("/kitchen", methods=["GET", "POST"])
def kitchen_setup():
    db = get_db()
    can_change = perms.can("setup", perms.FULL)
    if request.method == "POST":
        if not can_change:
            flash("Only an owner or administrator can change the kitchen settings.", "error")
            return redirect(url_for("pos.kitchen_setup"))
        f = request.form
        try:
            msg = _save_kitchen(db, f)
            db.commit()
            if msg:
                flash(msg, "ok")
        except ValueError as e:
            db.rollback()
            flash(str(e), "error")
        return redirect(url_for("pos.kitchen_setup"))
    from .kds import settings as kds_settings, lan_addresses, lan_listener
    cats = [r[0] for r in db.execute("SELECT DISTINCT category FROM items WHERE COALESCE(category,'')<>'' AND"
                                     " (is_sold=1 OR has_variants=1) ORDER BY category COLLATE NOCASE")]
    mapped = {r["category"]: r["station_id"] for r in db.execute("SELECT * FROM pos_station_categories")}
    devices = db.execute("SELECT * FROM kds_devices WHERE revoked_at IS NULL ORDER BY id DESC").fetchall()
    ks = kds_settings(db)
    pair = ks.get("pair_code") if ks.get("pair_until", "") > now() else None
    from .. import companies as co
    cid = co.current_id()
    suffix = "" if not cid or cid == co.MAIN else f"pair?co={cid}"  # another company file: pair with that one
    return render_template("pos/kitchen.html", stations=stations(db, active_only=False), outputs=OUTPUTS, cats=cats,
                           mapped=mapped, devices=devices, ks=ks, pair=pair, can_change=can_change,
                           addresses=[a + suffix for a in lan_addresses()], listener=lan_listener())


def _save_kitchen(db, f):
    what = f.get("what")
    from .kds import settings as kds_settings, save_settings, new_pair_code, start_lan, stop_lan
    if what == "pair":
        new_pair_code(db)
        audit(db, "kds_pair_code", "new pairing code")
        return None
    if what == "revoke":
        did = opt_int(f.get("device_id"))
        db.execute("UPDATE kds_devices SET revoked_at=? WHERE id=?", (now(), did))
        audit(db, "kds_device_revoke", str(did))
        return "That screen is signed out. It needs a new pairing code to come back."
    if what == "lan":
        ks = kds_settings(db)
        on = f.get("on") == "1"
        if on:
            err = start_lan()
            if err:
                raise ValueError(err)
        else:
            stop_lan()
        ks["lan"] = on
        save_settings(db, ks)
        audit(db, "kds_lan", "on" if on else "off")
        return "Kitchen screens on this network are on." if on else "Kitchen screens on this network are off."
    for s in stations(db, active_only=False):
        name = (f.get(f"name_{s['id']}") or "").strip()[:30]
        if not name:
            continue
        out = f.get(f"output_{s['id']}") if f.get(f"output_{s['id']}") in OUTPUTS else "print"
        active = 1 if f.get(f"active_{s['id']}") or s["id"] == stations(db, active_only=False)[0]["id"] else 0
        db.execute("UPDATE pos_stations SET name=?, output=?, active=? WHERE id=?", (name, out, active, s["id"]))
    new = (f.get("new_name") or "").strip()[:30]
    if new:
        db.execute("INSERT INTO pos_stations (name, output, sort) VALUES (?,?,?)",
                   (new, f.get("new_output") if f.get("new_output") in OUTPUTS else "screen",
                    len(stations(db, active_only=False))))
    db.execute("DELETE FROM pos_station_categories")
    for k, v in f.items():
        if k.startswith("cat::") and opt_int(v):
            db.execute("INSERT OR REPLACE INTO pos_station_categories (category, station_id) VALUES (?,?)",
                       (k[5:], int(v)))
    ks = kds_settings(db)
    try:
        amber, red = int(f.get("amber") or ks["amber"]), int(f.get("red") or ks["red"])
    except ValueError:
        raise ValueError("Type the minutes as whole numbers.")
    if not 1 <= amber < red <= 240:
        raise ValueError("The red time must be longer than the amber time (1 to 240 minutes).")
    ks.update(amber=amber, red=red)
    save_settings(db, ks)
    audit(db, "pos_kitchen_setup", ", ".join(f"{s['name']}={s['output']}" for s in stations(db, active_only=False)))
    return "Kitchen settings saved."
