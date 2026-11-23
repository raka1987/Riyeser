"""Riyeser POS: a basic point of sale.

Each sale becomes an ordinary tax invoice (prices include GST) that is paid at once,
so stock, the cash drawer / bank, GST and every report stay in step automatically.
"""
import json
from datetime import date

from flask import Blueprint, render_template, request, redirect, url_for, flash, jsonify, abort, g, current_app

from ..db import get_db, linked, round_cents, audit
from ..ledger import save_document, record_payment, void_payment, void_document, PostingError
from . import guarded, opt_int
from .. import perms

bp = Blueprint("pos", __name__, url_prefix="/pos")

METHODS = {"cash": "Cash", "card": "Card / EFTPOS"}
WALK_IN = "Walk-in Customer"


def walk_in_customer(db):
    row = db.execute("SELECT id FROM contacts WHERE kind='customer' AND name=?", (WALK_IN,)).fetchone()
    if row:
        return row["id"]
    return db.execute("INSERT INTO contacts (kind, name, terms_days) VALUES ('customer', ?, 0)", (WALK_IN,)).lastrowid


def _price_inc(item, rate):
    return round_cents(item["sell_price"] * (1 + (rate or 0) / 100.0))


PALETTE = ["#0e7c72", "#2563eb", "#c2410c", "#7c3aed", "#b45309", "#be185d", "#15803d", "#0369a1", "#9f1239",
           "#4d7c0f"]

# What each kind of business can switch on. Retail never sees tables or the kitchen, so it can't be set up wrong.
MODES = {
    "retail": dict(name="Retail", blurb="Shops: clothing, hardware, gifts, homewares. No tables or kitchen.", features=[
        ("scan", "Barcode scanning", "Scan a barcode to add the item straight to the sale"),
        ("stock", "Show stock on tiles", "“Only 2 left” and sold-out labels"),
        ("sku", "Show product codes", "The SKU under each product"),
        ("hold", "Hold sales", "Put a sale aside and come back to it"),
        ("customer", "Choose a customer", "Pick a customer card for the sale"),
        ("discount", "Discounts", "Give a % discount on an item"),
        ("notes", "Item notes", "A short note on an item, e.g. size or colour"),
    ]),
    "restaurant": dict(name="Restaurant", blurb="Cafes, restaurants, takeaway: tables and kitchen dockets.", features=[
        ("tables", "Tables (dine-in)", "Seat customers at a table and run their bill"),
        ("kitchen", "Send to kitchen", "Print a docket for the kitchen"),
        ("takeaway", "Takeaway orders", "Orders that are taken away"),
        ("notes", "Item options & notes", "e.g. oat milk, no onions, extra hot"),
        ("customer", "Choose a customer", "Pick a customer card for the order"),
        ("discount", "Discounts", "Give a % discount on an item"),
        ("stock", "Show stock on tiles", "“Only 2 left” and sold-out labels"),
    ]),
}
DEFAULT_ON = {"retail": {"scan", "stock", "sku", "hold", "customer", "discount", "notes"},
              "restaurant": {"tables", "kitchen", "takeaway", "notes", "customer", "discount"}}


def pos_config(db):
    """The business type and the switches that are on, limited to what that type allows."""
    c = db.execute("SELECT pos_mode, pos_features FROM company WHERE id=1").fetchone()
    mode = c["pos_mode"] if c["pos_mode"] in MODES else "retail"
    allowed = {k for k, _, _ in MODES[mode]["features"]}
    try:
        saved = json.loads(c["pos_features"]) if c["pos_features"] else None
    except ValueError:
        saved = None
    on = set(saved.get(mode, [])) if isinstance(saved, dict) and mode in saved else DEFAULT_ON[mode]
    return mode, on & allowed


def _tills(db):
    return db.execute("SELECT * FROM pos_tills WHERE active=1 ORDER BY id").fetchall()


def _items(db):
    rows = db.execute("SELECT i.*, t.rate, (SELECT 1 FROM item_photos p WHERE p.item_id=i.id) has_photo"
                      " FROM items i LEFT JOIN tax_codes t ON t.id=i.sale_tax_code_id"
                      " WHERE i.active=1 AND i.is_sold=1 ORDER BY COALESCE(i.category,'~'), i.name").fetchall()
    cats = sorted({r["category"] for r in rows if r["category"]})
    color = {c: PALETTE[i % len(PALETTE)] for i, c in enumerate(cats)}
    return [dict(id=r["id"], sku=r["sku"], name=r["name"], price=_price_inc(r, r["rate"]), rate=r["rate"] or 0,
                 cat=r["category"] or "Other", color=color.get(r["category"], "#475467"),
                 fav=bool(r["pos_favourite"]), photo=bool(r["has_photo"]),
                 stock=r["qty_on_hand"] if r["is_inventoried"] else None) for r in rows], cats


@bp.route("/")
def register():
    db = get_db()
    items, cats = _items(db)
    mode, features = pos_config(db)
    customers = db.execute("SELECT id, name FROM contacts WHERE kind='customer' AND active=1 ORDER BY name").fetchall()
    return render_template("pos/front.html", items_json=json.dumps(items), cats=cats, customers=customers,
                           walk_in=WALK_IN, methods=METHODS, mode=mode, features=sorted(features),
                           tills=_tills(db))


@bp.route("/photo/<int:iid>")
def photo(iid):
    row = get_db().execute("SELECT mime, data FROM item_photos WHERE item_id=?", (iid,)).fetchone()
    if not row:
        abort(404)
    return current_app.response_class(row["data"], mimetype=row["mime"],
                                      headers={"Cache-Control": "private, max-age=300"})


@bp.route("/setup", methods=["GET", "POST"])
def setup():
    db = get_db()
    if request.method == "POST":
        if not perms.can("setup", perms.FULL):
            flash("Only an owner or administrator can change how the till is set up.", "error")
            return redirect(url_for("pos.setup"))
        f = request.form
        mode = f.get("mode") if f.get("mode") in MODES else "retail"
        allowed = {k for k, _, _ in MODES[mode]["features"]}
        try:
            saved = json.loads(db.execute("SELECT pos_features FROM company WHERE id=1").fetchone()[0] or "{}")
            saved = saved if isinstance(saved, dict) else {}
        except ValueError:
            saved = {}
        if f.get("mode_changed") == "1":
            on = DEFAULT_ON[mode]  # a new business type starts from its sensible defaults
        else:
            on = {k for k in f.getlist("feature") if k in allowed}
        saved[mode] = sorted(on)
        db.execute("UPDATE company SET pos_mode=?, pos_features=? WHERE id=1", (mode, json.dumps(saved)))
        for t in _tills(db):
            name = (f.get(f"till_name_{t['id']}") or "").strip()[:40]
            if f.get(f"till_remove_{t['id']}") and len(_tills(db)) > 1:
                db.execute("UPDATE pos_tills SET active=0 WHERE id=?", (t["id"],))
            elif name:
                db.execute("UPDATE pos_tills SET name=?, location=? WHERE id=?",
                           (name, (f.get(f"till_loc_{t['id']}") or "").strip()[:60] or None, t["id"]))
        if (f.get("new_till") or "").strip():
            db.execute("INSERT INTO pos_tills (name, location) VALUES (?,?)",
                       (f["new_till"].strip()[:40], (f.get("new_till_loc") or "").strip()[:60] or None))
        audit(db, "pos_setup", f"{mode}: {', '.join(sorted(on)) or 'no extras'}")
        db.commit()
        flash(f"POS setup saved: {MODES[mode]['name']}." if f.get("mode_changed") != "1" else
              f"Switched to {MODES[mode]['name']}. Sensible features are on; adjust them below.", "ok")
        return redirect(url_for("pos.setup"))
    mode, on = pos_config(db)
    return render_template("pos/setup.html", modes=MODES, mode=mode, on=on, tills=_tills(db),
                           can_change=perms.can("setup", perms.FULL))


@bp.route("/mode", methods=["POST"])
def set_mode():
    db = get_db()
    mode = request.form.get("mode")
    if mode in MODES and perms.can("setup", perms.FULL):
        db.execute("UPDATE company SET pos_mode=? WHERE id=1", (mode,))
        db.commit()
    return redirect(url_for("pos.register"))


# ------------------------------------------------------------ held orders (parked sales, tables, takeaway)
def _clean_lines(raw):
    out = []
    for l in raw or []:
        out.append(dict(item_id=int(l["item_id"]), qty=float(l.get("qty") or 1),
                        discount_pct=min(max(float(l.get("discount_pct") or 0), 0), 100),
                        note=str(l.get("note") or "")[:120]))
    return out


def _order_json(db, o):
    lines = json.loads(o["lines"])
    names = {r["id"]: r for r in db.execute("SELECT i.id, i.name, i.sell_price, t.rate FROM items i LEFT JOIN tax_codes t"
                                            " ON t.id=i.sale_tax_code_id")}
    total = 0
    for l in lines:
        it = names.get(l["item_id"])
        l["name"] = it["name"] if it else "?"
        l["price"] = _price_inc(it, it["rate"]) if it else 0
        total += round(l["qty"] * l["price"] * (1 - l["discount_pct"] / 100))
    return dict(id=o["id"], order_type=o["order_type"], table_no=o["table_no"], customer_id=o["customer_id"],
                note=o["note"], lines=lines, total=total, kitchen_sent_at=o["kitchen_sent_at"],
                created_at=o["created_at"], updated_at=o["updated_at"])


@bp.route("/orders")
def orders():
    db = get_db()
    rows = db.execute("SELECT * FROM pos_orders WHERE status='open' ORDER BY id").fetchall()
    return jsonify([_order_json(db, o) for o in rows])


@bp.route("/order", methods=["POST"])
def save_order():
    db = get_db()
    d = request.get_json(silent=True) or {}
    try:
        lines = _clean_lines(d.get("lines"))
        if not lines:
            raise ValueError("Add at least one item.")
        otype = d.get("order_type") if d.get("order_type") in ("retail", "dine_in", "takeaway") else "retail"
        table = (str(d.get("table_no") or "").strip()[:10]) or None
        if otype == "dine_in" and not table:
            raise ValueError("Choose a table for a dine-in order.")
        vals = (otype, table, opt_int(d.get("customer_id")), json.dumps(lines), (d.get("note") or "")[:200])
        oid = opt_int(d.get("id"))
        if oid:
            if not db.execute("SELECT 1 FROM pos_orders WHERE id=? AND status='open'", (oid,)).fetchone():
                raise ValueError("That order is no longer open.")
            db.execute("UPDATE pos_orders SET order_type=?, table_no=?, customer_id=?, lines=?, note=?,"
                       " updated_at=datetime('now','localtime') WHERE id=?", vals + (oid,))
        else:
            oid = db.execute("INSERT INTO pos_orders (order_type, table_no, customer_id, lines, note, user_id)"
                             " VALUES (?,?,?,?,?,?)", vals + (g.user["id"],)).lastrowid
        if d.get("kitchen"):
            db.execute("UPDATE pos_orders SET kitchen_sent_at=datetime('now','localtime') WHERE id=?", (oid,))
        db.commit()
    except (ValueError, KeyError, TypeError) as e:
        db.rollback()
        return jsonify(ok=False, error=str(e)), 400
    return jsonify(ok=True, id=oid, docket_url=url_for("pos.docket", oid=oid))


@bp.route("/order/<int:oid>/cancel", methods=["POST"])
def cancel_order(oid):
    db = get_db()
    db.execute("UPDATE pos_orders SET status='cancelled', updated_at=datetime('now','localtime')"
               " WHERE id=? AND status='open'", (oid,))
    audit(db, "pos_order_cancel", str(oid))
    db.commit()
    return jsonify(ok=True)


@bp.route("/docket/<int:oid>")
def docket(oid):
    db = get_db()
    o = db.execute("SELECT * FROM pos_orders WHERE id=?", (oid,)).fetchone()
    if not o:
        abort(404)
    return render_template("pos/docket.html", o=_order_json(db, o), user=g.user)


@bp.route("/sale", methods=["POST"])
def sale():
    db = get_db()
    data = request.get_json(silent=True) or {}
    try:
        method = data.get("method")
        if method not in METHODS:
            raise PostingError("Choose how the customer paid.")
        lines = []
        for l in data.get("lines") or []:
            item = db.execute("SELECT i.*, t.rate FROM items i LEFT JOIN tax_codes t ON t.id=i.sale_tax_code_id"
                              " WHERE i.id=? AND i.active=1 AND i.is_sold=1", (int(l["item_id"]),)).fetchone()
            qty = float(l.get("qty") or 0)
            if not item or qty <= 0:
                raise PostingError("The sale has an invalid item or quantity.")
            disc = min(max(float(l.get("discount_pct") or 0), 0), 100)
            note = str(l.get("note") or "").strip()[:120]
            lines.append(dict(item_id=item["id"], qty=qty, unit_price=_price_inc(item, item["rate"]),
                              discount_pct=disc, tax_code_id=item["sale_tax_code_id"],
                              description=f"{item['name']} ({note})" if note else item["name"]))
        if not lines:
            raise PostingError("Add at least one item.")
        cid = opt_int(data.get("customer_id")) or walk_in_customer(db)
        today = date.today().isoformat()
        ref = "POS"
        if data.get("order_type") == "dine_in" and data.get("table_no"):
            ref = f"POS Table {str(data['table_no'])[:10]}"
        elif data.get("order_type") == "takeaway":
            ref = "POS Takeaway"
        doc_id = save_document(db, "sale", dict(contact_id=cid, date=today, due_date=today, tax_inclusive=True,
                                                reference=ref, notes=(data.get("note") or "")[:200]),
                               lines, "open")
        total = db.execute("SELECT total FROM documents WHERE id=?", (doc_id,)).fetchone()["total"]
        tendered = round_cents(float(data.get("tendered") or 0) * 100) if method == "cash" else total
        if method == "cash" and tendered < total:
            raise PostingError("Cash tendered is less than the total.")
        acct = linked(db, "pos_cash" if method == "cash" else "pos_card")
        pid = record_payment(db, "in", cid, acct, today, [(doc_id, total)], reference="POS",
                             memo=f"POS {METHODS[method]}")
        till = opt_int(data.get("till_id"))
        if till and not db.execute("SELECT 1 FROM pos_tills WHERE id=? AND active=1", (till,)).fetchone():
            till = None
        sid = db.execute("INSERT INTO pos_sales (document_id, payment_id, method, tendered, change_given, user_id,"
                         " till_id) VALUES (?,?,?,?,?,?,?)", (doc_id, pid, method, tendered, tendered - total,
                                                              g.user["id"], till)).lastrowid
        oid = opt_int(data.get("order_id"))
        if oid:
            db.execute("UPDATE pos_orders SET status='paid', sale_id=?, updated_at=datetime('now','localtime')"
                       " WHERE id=? AND status='open'", (sid, oid))
        audit(db, "pos_sale", f"#{sid} {method}")
        db.commit()
    except (PostingError, ValueError, KeyError, TypeError) as e:
        db.rollback()
        return jsonify(ok=False, error=str(e) or "Could not complete the sale."), 400
    return jsonify(ok=True, sale_id=sid, total=total, change=tendered - total,
                   receipt_url=url_for("pos.receipt", sid=sid))


def _sale(db, sid):
    s = db.execute("SELECT p.*, d.number, d.total, d.tax_total, d.subtotal, d.date, d.notes, c.name cname,"
                   " u.full_name, u.username FROM pos_sales p JOIN documents d ON d.id=p.document_id"
                   " JOIN contacts c ON c.id=d.contact_id LEFT JOIN users u ON u.id=p.user_id WHERE p.id=?",
                   (sid,)).fetchone()
    if not s:
        abort(404)
    return s


@bp.route("/receipt/<int:sid>")
def receipt(sid):
    db = get_db()
    s = _sale(db, sid)
    lines = db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (s["document_id"],)).fetchall()
    return render_template("pos/receipt.html", s=s, lines=lines, methods=METHODS)


def day_summary(db, day):
    rows = db.execute("SELECT p.*, d.number, d.total, d.tax_total, c.name cname, t.name till_name FROM pos_sales p"
                      " JOIN documents d ON d.id=p.document_id JOIN contacts c ON c.id=d.contact_id"
                      " LEFT JOIN pos_tills t ON t.id=p.till_id WHERE d.date=? ORDER BY p.id DESC", (day,)).fetchall()
    live = [r for r in rows if not r["voided"]]
    by_method = {m: sum(r["total"] for r in live if r["method"] == m) for m in METHODS}
    return dict(rows=rows, count=len(live), total=sum(r["total"] for r in live),
                gst=sum(r["tax_total"] for r in live), by_method=by_method,
                cash_out=sum(r["change_given"] for r in live if r["method"] == "cash"))


def day_extras(db, day):
    """Sales by hour and best sellers for the Today screen (voided sales left out)."""
    hours = {}
    for r in db.execute("SELECT substr(p.created_at, 12, 2) h, SUM(d.total) t FROM pos_sales p"
                        " JOIN documents d ON d.id=p.document_id WHERE d.date=? AND p.voided=0 GROUP BY h", (day,)):
        hours[int(r["h"])] = r["t"]
    best = db.execute("SELECT i.id, i.name, i.category, SUM(l.qty) qty, SUM(l.net_amount + l.tax_amount) amt,"
                      " (SELECT 1 FROM item_photos ph WHERE ph.item_id=i.id) photo"
                      " FROM pos_sales p JOIN documents d ON d.id=p.document_id"
                      " JOIN document_lines l ON l.document_id=d.id JOIN items i ON i.id=l.item_id"
                      " WHERE d.date=? AND p.voided=0 GROUP BY i.id ORDER BY amt DESC LIMIT 5", (day,)).fetchall()
    open_orders = db.execute("SELECT COUNT(*) FROM pos_orders WHERE status='open'").fetchone()[0]
    return dict(hours=hours, best=best, open_orders=open_orders)


@bp.route("/sales")
def sales():
    db = get_db()
    day = request.args.get("date") or date.today().isoformat()
    mode, features = pos_config(db)
    try:
        d = date.fromisoformat(day)
        day_label = f"{d:%A} {d.day} {d:%B %Y}"
    except ValueError:
        abort(404)
    return render_template("pos/sales.html", day=day, day_label=day_label, methods=METHODS, mode=mode,
                           features=sorted(features),
                           tills=_tills(db), **day_summary(db, day), **day_extras(db, day))


@bp.route("/sale/<int:sid>/void", methods=["POST"])
@guarded
def void(sid):
    db = get_db()
    s = _sale(db, sid)
    if s["voided"]:
        raise PostingError("This sale is already voided.")
    void_payment(db, s["payment_id"])
    void_document(db, s["document_id"])
    db.execute("UPDATE pos_sales SET voided=1 WHERE id=?", (sid,))
    audit(db, "pos_void", f"#{sid}")
    flash(f"Sale {s['number']} voided: stock returned and the takings reversed.", "ok")
    return redirect(url_for("pos.sales", date=s["date"]))
