"""Riyeser POS: a basic point of sale.

Each sale becomes an ordinary tax invoice (prices include GST) that is paid at once,
so stock, the cash drawer / bank, GST and every report stay in step automatically.
"""
import json
from datetime import date

from flask import Blueprint, render_template, request, redirect, url_for, flash, jsonify, abort, g

from ..db import get_db, linked, round_cents, audit
from ..ledger import save_document, record_payment, void_payment, void_document, PostingError
from . import guarded, opt_int

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


def _items(db):
    rows = db.execute("SELECT i.*, t.rate FROM items i LEFT JOIN tax_codes t ON t.id=i.sale_tax_code_id"
                      " WHERE i.active=1 AND i.is_sold=1 ORDER BY COALESCE(i.category,'~'), i.name").fetchall()
    cats = sorted({r["category"] for r in rows if r["category"]})
    color = {c: PALETTE[i % len(PALETTE)] for i, c in enumerate(cats)}
    return [dict(id=r["id"], sku=r["sku"], name=r["name"], price=_price_inc(r, r["rate"]),
                 cat=r["category"] or "Other", color=color.get(r["category"], "#475467"),
                 stock=r["qty_on_hand"] if r["is_inventoried"] else None) for r in rows], cats


@bp.route("/")
def register():
    db = get_db()
    items, cats = _items(db)
    customers = db.execute("SELECT id, name FROM contacts WHERE kind='customer' AND active=1 ORDER BY name").fetchall()
    return render_template("pos/front.html", items_json=json.dumps(items), cats=cats, customers=customers,
                           walk_in=WALK_IN, methods=METHODS, mode=g.company["pos_mode"])


@bp.route("/mode", methods=["POST"])
def set_mode():
    db = get_db()
    mode = request.form.get("mode")
    if mode in ("retail", "restaurant"):
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
        sid = db.execute("INSERT INTO pos_sales (document_id, payment_id, method, tendered, change_given, user_id)"
                         " VALUES (?,?,?,?,?,?)", (doc_id, pid, method, tendered, tendered - total,
                                                    g.user["id"])).lastrowid
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
    rows = db.execute("SELECT p.*, d.number, d.total, d.tax_total, c.name cname FROM pos_sales p"
                      " JOIN documents d ON d.id=p.document_id JOIN contacts c ON c.id=d.contact_id"
                      " WHERE d.date=? ORDER BY p.id DESC", (day,)).fetchall()
    live = [r for r in rows if not r["voided"]]
    by_method = {m: sum(r["total"] for r in live if r["method"] == m) for m in METHODS}
    return dict(rows=rows, count=len(live), total=sum(r["total"] for r in live),
                gst=sum(r["tax_total"] for r in live), by_method=by_method,
                cash_out=sum(r["change_given"] for r in live if r["method"] == "cash"))


@bp.route("/sales")
def sales():
    day = request.args.get("date") or date.today().isoformat()
    return render_template("pos/sales.html", day=day, methods=METHODS, **day_summary(get_db(), day))


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
