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


@bp.route("/")
def register():
    db = get_db()
    rows = db.execute("SELECT i.*, t.rate FROM items i LEFT JOIN tax_codes t ON t.id=i.sale_tax_code_id"
                      " WHERE i.active=1 AND i.is_sold=1 ORDER BY i.name").fetchall()
    items = [dict(id=r["id"], sku=r["sku"], name=r["name"], price=_price_inc(r, r["rate"]),
                  stock=r["qty_on_hand"] if r["is_inventoried"] else None) for r in rows]
    customers = db.execute("SELECT id, name FROM contacts WHERE kind='customer' AND active=1 ORDER BY name").fetchall()
    return render_template("pos/register.html", items_json=json.dumps(items), customers=customers,
                           walk_in=WALK_IN, methods=METHODS)


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
            lines.append(dict(item_id=item["id"], qty=qty, unit_price=_price_inc(item, item["rate"]),
                              discount_pct=disc, tax_code_id=item["sale_tax_code_id"]))
        if not lines:
            raise PostingError("Add at least one item.")
        cid = opt_int(data.get("customer_id")) or walk_in_customer(db)
        today = date.today().isoformat()
        doc_id = save_document(db, "sale", dict(contact_id=cid, date=today, due_date=today, tax_inclusive=True,
                                                reference="POS", notes=(data.get("note") or "")[:200]),
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
