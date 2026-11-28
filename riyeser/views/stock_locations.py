"""Stock locations, transfers between them, and the stocktake at one location.

A transfer goes Draft -> Sent (the stock leaves the sending location and is "in transit") -> Received (it arrives),
and can be received in parts. Transfers only move stock: the total on hand and its value don't change, so nothing
is posted to the books (the Inventory account stays as it is). What hasn't arrived can be sent back to where it
came from to close the transfer.
"""
from datetime import date

from flask import render_template, request, redirect, url_for, flash, abort, g

from ..db import get_db, audit, write_txn
from ..ledger import PostingError, _move
from .. import locations as LOC
from .. import perms
from . import guarded, once, opt_int, opt_float
from .inventory import bp

STATUS = {"draft": "Draft", "sent": "Sent (in transit)", "partial": "Part received", "received": "Received",
          "cancelled": "Cancelled"}


def _stock_items(db):
    return db.execute("SELECT id, sku, name FROM items WHERE is_inventoried=1 AND active=1 ORDER BY sku").fetchall()


# ------------------------------------------------------------ locations
@bp.route("/locations", methods=["GET", "POST"])
def locations():
    db = get_db()
    if request.method == "POST":
        return _save_locations()
    rows = []
    for l in LOC.stores(db, active_only=False):
        lv = LOC.levels(db, l["id"])
        val = db.execute("SELECT id, avg_cost FROM items WHERE is_inventoried=1").fetchall()
        rows.append(dict(l, units=sum(max(v, 0) for v in lv.values()),
                         value=round(sum(lv.get(i["id"], 0) * i["avg_cost"] for i in val)),
                         tills=[t["name"] for t in db.execute("SELECT name FROM pos_tills WHERE active=1 AND"
                                                               " location_id=?", (l["id"],))]))
    transit = LOC.levels(db, LOC.transit_id(db))
    return render_template("inventory/locations.html", rows=rows, in_transit=sum(v for v in transit.values() if v > 0),
                           open_transfers=db.execute("SELECT COUNT(*) FROM stock_transfers WHERE status IN"
                                                     " ('sent','partial')").fetchone()[0])


@guarded
@once
def _save_locations():
    db = get_db()
    f = request.form
    for l in LOC.stores(db, active_only=False):
        name = (f.get(f"name_{l['id']}") or "").strip()[:60]
        if not name:
            continue
        active = 1 if l["is_default"] or f.get(f"active_{l['id']}") else 0
        if not active and l["active"]:
            if any(abs(v) > 1e-9 for v in LOC.levels(db, l["id"]).values()):
                raise PostingError(f"{l['name']} still has stock. Transfer it to another location (or stocktake it "
                                   "to 0) before switching it off.")
            if db.execute("SELECT 1 FROM pos_tills WHERE active=1 AND location_id=?", (l["id"],)).fetchone():
                raise PostingError(f"A till still belongs to {l['name']}. Move the till to another location first "
                                   "(POS setup).")
        db.execute("UPDATE stock_locations SET name=?, active=?, address=? WHERE id=?",
                   (name, active, (f.get(f"address_{l['id']}") or "").strip()[:120] or None, l["id"]))
    new = (f.get("new_name") or "").strip()[:60]
    if new:
        if db.execute("SELECT 1 FROM stock_locations WHERE name=? COLLATE NOCASE", (new,)).fetchone():
            raise PostingError(f"There's already a location called {new}.")
        db.execute("INSERT INTO stock_locations (name, address) VALUES (?,?)",
                   (new, (f.get("new_address") or "").strip()[:120] or None))
        audit(db, "location_add", new)
    audit(db, "locations_save", "")
    flash("Locations saved.", "ok")
    return redirect(url_for("inventory.locations"))


@bp.route("/locations/<int:lid>", methods=["GET", "POST"])
def location_view(lid):
    db = get_db()
    loc = db.execute("SELECT * FROM stock_locations WHERE id=? AND kind='store'", (lid,)).fetchone()
    if not loc:
        abort(404)
    if request.method == "POST":
        return _save_location_levels(lid)
    lv = LOC.levels(db, lid)
    own = LOC.location_reorder(db, lid)
    items = [dict(i, here=lv.get(i["id"], 0), own_level=own.get(i["id"], (None, None))[0],
                  own_up_to=own.get(i["id"], (None, None))[1])
             for i in db.execute("SELECT * FROM items WHERE is_inventoried=1 AND active=1 ORDER BY sku")]
    return render_template("inventory/location.html", loc=loc, items=items)


@guarded
@once
def _save_location_levels(lid):
    db = get_db()
    f = request.form
    n = 0
    for i in db.execute("SELECT id FROM items WHERE is_inventoried=1 AND active=1").fetchall():
        lv, up = f.get(f"level_{i['id']}", "").strip(), f.get(f"upto_{i['id']}", "").strip()
        if lv == "" and up == "":
            db.execute("DELETE FROM location_levels WHERE item_id=? AND location_id=?", (i["id"], lid))
            continue
        lvf, upf = opt_float(lv, None), opt_float(up, None)
        if (lvf is not None and lvf < 0) or (upf is not None and upf < 0):
            raise PostingError("Reorder levels can't be below 0.")
        db.execute("INSERT INTO location_levels (item_id, location_id, reorder_level, reorder_up_to) VALUES"
                   " (?,?,?,?) ON CONFLICT(item_id, location_id) DO UPDATE SET reorder_level=excluded.reorder_level,"
                   " reorder_up_to=excluded.reorder_up_to", (i["id"], lid, lvf, upf))
        n += 1
    audit(db, "location_levels", f"location {lid}: {n} items")
    flash("Reorder levels for this location saved.", "ok")
    return redirect(url_for("inventory.location_view", lid=lid))


# ------------------------------------------------------------ transfers
def _transfer(db, tid):
    t = db.execute("SELECT t.*, f.name from_name, o.name to_name FROM stock_transfers t JOIN stock_locations f ON"
                   " f.id=t.from_id JOIN stock_locations o ON o.id=t.to_id WHERE t.id=?", (tid,)).fetchone()
    if not t:
        abort(404)
    return t


def _lines(db, tid):
    return [dict(l, left=round(l["qty"] - l["qty_received"] - l["qty_returned"], 6)) for l in db.execute(
        "SELECT l.*, i.sku, i.name, i.avg_cost FROM stock_transfer_lines l JOIN items i ON i.id=l.item_id"
        " WHERE l.transfer_id=? ORDER BY l.id", (tid,))]


@bp.route("/transfers")
def transfers():
    db = get_db()
    st = request.args.get("st") or ""
    q = ("SELECT t.*, f.name from_name, o.name to_name, (SELECT COUNT(*) FROM stock_transfer_lines l WHERE"
         " l.transfer_id=t.id) n, (SELECT COALESCE(SUM(qty),0) FROM stock_transfer_lines l WHERE l.transfer_id=t.id)"
         " units FROM stock_transfers t JOIN stock_locations f ON f.id=t.from_id JOIN stock_locations o ON"
         " o.id=t.to_id")
    args = []
    if st == "open":
        q += " WHERE t.status IN ('draft','sent','partial')"
    elif st in STATUS:
        q += " WHERE t.status=?"
        args.append(st)
    rows = db.execute(q + " ORDER BY t.id DESC LIMIT 200", args).fetchall()
    return render_template("inventory/transfers.html", rows=rows, status=STATUS, st=st, several=LOC.several(db))


@bp.route("/transfers/new", methods=["GET", "POST"])
@bp.route("/transfers/<int:tid>/edit", methods=["GET", "POST"])
def transfer_edit(tid=None):
    db = get_db()
    t = _transfer(db, tid) if tid else None
    if t and t["status"] != "draft":
        flash("Only a draft transfer can be changed.", "error")
        return redirect(url_for("inventory.transfer_view", tid=tid))
    if request.method == "POST":
        return _save_transfer(tid)
    stores = LOC.stores(db)
    levels = {l["id"]: LOC.levels(db, l["id"]) for l in stores}
    return render_template("inventory/transfer_edit.html", t=t, lines=_lines(db, tid) if tid else [],
                           stores=stores, items=_stock_items(db), levels=levels)


@guarded
@once
def _save_transfer(tid):
    db = get_db()
    write_txn(db)
    f = request.form
    src, dst = opt_int(f.get("from_id")), opt_int(f.get("to_id"))
    ids = {l["id"] for l in LOC.stores(db)}
    if src not in ids or dst not in ids:
        raise PostingError("Choose where the stock comes from and where it goes.")
    if src == dst:
        raise PostingError("The two locations must be different.")
    lines = []
    for iid, q in zip(f.getlist("line_item"), f.getlist("line_qty")):
        iid, qty = opt_int(iid), opt_float(q)
        if not iid and not qty:
            continue
        it = db.execute("SELECT sku FROM items WHERE id=? AND is_inventoried=1", (iid,)).fetchone() if iid else None
        if not it:
            raise PostingError("Choose a stock item on each line.")
        if qty <= 0:
            raise PostingError(f"Type how many {it['sku']} to send.")
        lines.append((iid, qty))
    if not lines:
        raise PostingError("Add at least one item to transfer.")
    note = (f.get("note") or "").strip()[:200] or None
    if tid:
        db.execute("UPDATE stock_transfers SET from_id=?, to_id=?, note=? WHERE id=? AND status='draft'",
                   (src, dst, note, tid))
        db.execute("DELETE FROM stock_transfer_lines WHERE transfer_id=?", (tid,))
    else:
        n = (db.execute("SELECT COALESCE(MAX(id),0) FROM stock_transfers").fetchone()[0] or 0) + 1
        number = f"TR{n:05d}"
        while db.execute("SELECT 1 FROM stock_transfers WHERE number=?", (number,)).fetchone():
            n += 1
            number = f"TR{n:05d}"
        tid = db.execute("INSERT INTO stock_transfers (number, from_id, to_id, note, created_by) VALUES (?,?,?,?,?)",
                         (number, src, dst, note, g.user["id"])).lastrowid
    for iid, qty in lines:
        db.execute("INSERT INTO stock_transfer_lines (transfer_id, item_id, qty) VALUES (?,?,?)", (tid, iid, qty))
    t = _transfer(db, tid)
    audit(db, "transfer_save", f"{t['number']} {t['from_name']} -> {t['to_name']}")
    if f.get("then") == "send":
        _send(db, tid)
        flash(f"Transfer {t['number']} sent. The stock is in transit until {t['to_name']} receives it.", "ok")
    else:
        flash(f"Transfer {t['number']} saved as a draft.", "ok")
    return redirect(url_for("inventory.transfer_view", tid=tid))


def _send(db, tid):
    write_txn(db)
    t = _transfer(db, tid)
    if t["status"] != "draft":
        raise PostingError("This transfer has already been sent.")
    today = date.today().isoformat()
    transit = LOC.transit_id(db)
    short = []
    for l in _lines(db, tid):
        have = LOC.qty_at(db, l["item_id"], t["from_id"])
        if l["qty"] > have + 1e-9:
            short.append(f"{l['sku']} (only {max(have, 0):g} at {t['from_name']})")
    if short:
        raise PostingError("Not enough stock to send: " + ", ".join(short) + ".")
    for l in _lines(db, tid):
        memo = f"Transfer {t['number']} to {t['to_name']}"
        _move(db, l["item_id"], today, -l["qty"], l["avg_cost"], "transfer_out", tid, memo, t["from_id"])
        _move(db, l["item_id"], today, l["qty"], l["avg_cost"], "transfer_transit", tid, memo, transit)
    db.execute("UPDATE stock_transfers SET status='sent', sent_by=?, sent_at=datetime('now','localtime') WHERE id=?",
               (g.user["id"], tid))
    audit(db, "transfer_send", t["number"])


@bp.route("/transfers/<int:tid>")
def transfer_view(tid):
    db = get_db()
    t = _transfer(db, tid)
    users = {u["id"]: u["full_name"] or u["username"] for u in db.execute("SELECT id, full_name, username FROM users")}
    return render_template("inventory/transfer.html", t=t, lines=_lines(db, tid), status=STATUS, users=users,
                           can_edit=perms.can("stock", perms.EDIT))


@bp.route("/transfers/<int:tid>/send", methods=["POST"])
@guarded
@once
def transfer_send(tid):
    db = get_db()
    _send(db, tid)
    t = _transfer(db, tid)
    flash(f"Transfer {t['number']} sent. The stock is in transit until {t['to_name']} receives it.", "ok")
    return redirect(url_for("inventory.transfer_view", tid=tid))


@bp.route("/transfers/<int:tid>/receive", methods=["POST"])
@guarded
@once
def transfer_receive(tid):
    """Receive some or all of what was sent. What's left stays in transit (Part received)."""
    db = get_db()
    write_txn(db)
    t = _transfer(db, tid)
    if t["status"] not in ("sent", "partial"):
        raise PostingError("Only a sent transfer can be received.")
    f = request.form
    today = date.today().isoformat()
    transit = LOC.transit_id(db)
    got = 0
    for l in _lines(db, tid):
        q = opt_float(f.get(f"recv_{l['id']}"))
        if not q:
            continue
        if q < 0 or q > l["left"] + 1e-9:
            raise PostingError(f"{l['sku']}: you can receive at most {l['left']:g}.")
        memo = f"Transfer {t['number']} from {t['from_name']}"
        _move(db, l["item_id"], today, -q, l["avg_cost"], "transfer_transit", tid, memo, transit)
        _move(db, l["item_id"], today, q, l["avg_cost"], "transfer_in", tid, memo, t["to_id"])
        db.execute("UPDATE stock_transfer_lines SET qty_received=qty_received+? WHERE id=?", (q, l["id"]))
        got += 1
    if not got:
        raise PostingError("Type how many of each item arrived.")
    done = all(l["left"] <= 1e-9 for l in _lines(db, tid))
    db.execute("UPDATE stock_transfers SET status=?, received_by=?, received_at=datetime('now','localtime')"
               " WHERE id=?", ("received" if done else "partial", g.user["id"], tid))
    audit(db, "transfer_receive", f"{t['number']} {'all' if done else 'part'}")
    flash(f"Received at {t['to_name']}." + ("" if done else " The rest is still in transit."), "ok")
    return redirect(url_for("inventory.transfer_view", tid=tid))


@bp.route("/transfers/<int:tid>/return", methods=["POST"])
@guarded
@once
def transfer_return(tid):
    """Close a part-received transfer: what didn't arrive goes back to the sending location."""
    db = get_db()
    write_txn(db)
    t = _transfer(db, tid)
    if t["status"] not in ("sent", "partial"):
        raise PostingError("Only a transfer that is still in transit can be closed this way.")
    today = date.today().isoformat()
    transit = LOC.transit_id(db)
    for l in _lines(db, tid):
        if l["left"] > 1e-9:
            memo = f"Transfer {t['number']}: not received, back to {t['from_name']}"
            _move(db, l["item_id"], today, -l["left"], l["avg_cost"], "transfer_transit", tid, memo, transit)
            _move(db, l["item_id"], today, l["left"], l["avg_cost"], "transfer_back", tid, memo, t["from_id"])
            db.execute("UPDATE stock_transfer_lines SET qty_returned=qty_returned+? WHERE id=?", (l["left"], l["id"]))
    db.execute("UPDATE stock_transfers SET status='received', received_by=?, received_at=datetime('now','localtime')"
               " WHERE id=?", (g.user["id"], tid))
    audit(db, "transfer_close", t["number"])
    flash(f"Transfer {t['number']} closed. What didn't arrive is back at {t['from_name']}.", "ok")
    return redirect(url_for("inventory.transfer_view", tid=tid))


@bp.route("/transfers/<int:tid>/cancel", methods=["POST"])
@guarded
@once
def transfer_cancel(tid):
    db = get_db()
    t = _transfer(db, tid)
    if t["status"] != "draft":
        raise PostingError("Only a draft can be cancelled. A sent transfer can be closed instead.")
    db.execute("UPDATE stock_transfers SET status='cancelled' WHERE id=?", (tid,))
    audit(db, "transfer_cancel", t["number"])
    flash(f"Transfer {t['number']} cancelled.", "ok")
    return redirect(url_for("inventory.transfers"))


@bp.route("/transfers/<int:tid>/docket")
def transfer_docket(tid):
    """A printable transfer docket (A4 or 80 mm), to go with the stock."""
    db = get_db()
    t = _transfer(db, tid)
    users = {u["id"]: u["full_name"] or u["username"] for u in db.execute("SELECT id, full_name, username FROM users")}
    return render_template("inventory/transfer_docket.html", t=t, lines=_lines(db, tid), status=STATUS, users=users)
