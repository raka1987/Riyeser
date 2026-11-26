"""Receiving a purchase order, all at once or in parts.

Each delivery makes a bill (stock comes in and you owe the supplier) for what arrived, linked back to the order.
The order keeps track of how much of each line has arrived, and is finished when everything has, or when you close it
because the rest isn't coming. Voiding a bill made this way puts its quantities back as "still to come".
"""
from datetime import date, timedelta

from flask import render_template, request, redirect, url_for, flash, g, abort

from ..db import get_db, to_cents, audit
from ..ledger import save_document, PostingError
from . import guarded
from .documents import bp


def _po(db, doc_id):
    doc = db.execute("SELECT d.*, c.name cname, c.terms_days FROM documents d JOIN contacts c ON c.id=d.contact_id"
                     " WHERE d.id=?", (doc_id,)).fetchone() or abort(404)
    if doc["side"] != "purchase" or doc["status"] != "order":
        raise PostingError("Only a purchase order can be received.")
    return doc


def received_any(db, doc_id):
    return bool(db.execute("SELECT 1 FROM document_lines WHERE document_id=? AND qty_received > 0",
                           (doc_id,)).fetchone())


def po_lines(db, doc_id):
    rows = db.execute("SELECT l.*, i.sku FROM document_lines l LEFT JOIN items i ON i.id=l.item_id"
                      " WHERE l.document_id=? ORDER BY l.id", (doc_id,)).fetchall()
    return [dict(r, left=max(round(r["qty"] - r["qty_received"], 4), 0)) for r in rows]


def receive(db, doc_id, qtys, on=None, reference=None, prices=None):
    """Receive {line_id: qty} against purchase order doc_id. Makes and posts the bill; returns its id."""
    po = _po(db, doc_id)
    if po["received_at"]:
        raise PostingError(f"{po['number']} is already finished.")
    prices = prices or {}
    lines, updates = [], []
    for l in po_lines(db, doc_id):
        q = qtys.get(l["id"]) or 0
        if not q:
            continue
        if q < 0:
            raise PostingError(f"{l['description'] or 'A line'}: the quantity received can't be below 0.")
        if q > l["left"] + 1e-9:
            raise PostingError(f"{l['description'] or 'A line'}: only {l['left']:g} still to come on {po['number']}. "
                               "Edit the quantity, or receive the extra on a separate bill.")
        lines.append(dict(item_id=l["item_id"], description=l["description"], qty=q,
                          unit_price=prices.get(l["id"], l["unit_price"]), discount_pct=l["discount_pct"],
                          account_id=l["account_id"], tax_code_id=l["tax_code_id"], job_id=l["job_id"]))
        updates.append((q, l["id"]))
    if not lines:
        raise PostingError("Type how many of each line arrived.")
    on = on or date.today().isoformat()
    terms = po["terms_days"] if po["terms_days"] is not None else ((g.get("company") or {}).get("default_terms_days") or 30)
    bill = save_document(db, "purchase", dict(
        contact_id=po["contact_id"], date=on,
        due_date=(date.fromisoformat(on) + timedelta(days=terms)).isoformat(),
        reference=(reference or "").strip() or po["number"], notes=f"Goods received on purchase order {po['number']}.",
        tax_inclusive=bool(po["tax_inclusive"])), lines, "open")
    db.execute("UPDATE documents SET source_document_id=? WHERE id=?", (doc_id, bill))
    for q, lid in updates:
        db.execute("UPDATE document_lines SET qty_received=qty_received+? WHERE id=?", (q, lid))
    if all(l["left"] <= 1e-9 for l in po_lines(db, doc_id)):
        db.execute("UPDATE documents SET received_at=datetime('now','localtime'), converted_to=? WHERE id=?",
                   (bill, doc_id))
    audit(db, "receive_po", f"{po['number']} -> document {bill}")
    return bill


def undo_receipt(db, bill_id):
    """A bill made by receiving a purchase order was voided: its quantities are still to come again."""
    bill = db.execute("SELECT * FROM documents WHERE id=?", (bill_id,)).fetchone()
    if not bill or not bill["source_document_id"]:
        return
    po_id = bill["source_document_id"]
    left = {}
    for l in db.execute("SELECT item_id, description, qty FROM document_lines WHERE document_id=?", (bill_id,)):
        left[(l["item_id"], l["description"])] = left.get((l["item_id"], l["description"]), 0) + l["qty"]
    for pl in db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id DESC", (po_id,)).fetchall():
        key = (pl["item_id"], pl["description"])
        back = min(left.get(key, 0), pl["qty_received"])
        if back > 0:
            db.execute("UPDATE document_lines SET qty_received=qty_received-? WHERE id=?", (back, pl["id"]))
            left[key] -= back
    db.execute("UPDATE documents SET received_at=NULL, converted_to=NULL WHERE id=? AND status='order'", (po_id,))


@bp.route("/document/<int:doc_id>/receive", methods=["GET", "POST"])
def receive_goods(doc_id):
    db = get_db()
    if request.method == "POST":
        return _receive(doc_id)
    try:
        po = _po(db, doc_id)
    except PostingError as e:
        flash(str(e), "error")
        return redirect(url_for("documents.view", doc_id=doc_id))
    bills = db.execute("SELECT id, number, date, total, status FROM documents WHERE source_document_id=? ORDER BY id",
                       (doc_id,)).fetchall()
    return render_template("documents/receive.html", po=po, lines=po_lines(db, doc_id), bills=bills)


@guarded
def _receive(doc_id):
    db = get_db()
    f = request.form
    if f.get("close"):
        po = _po(db, doc_id)
        if not received_any(db, doc_id):
            raise PostingError("Nothing has arrived on this order yet. Delete it instead if it isn't needed.")
        db.execute("UPDATE documents SET received_at=datetime('now','localtime') WHERE id=?", (doc_id,))
        audit(db, "close_po", po["number"])
        flash(f"{po['number']} is closed: nothing more is expected on it.", "ok")
        return redirect(url_for("documents.view", doc_id=doc_id))
    qtys, prices = {}, {}
    for k, v in f.items():
        if k.startswith("recv_") and v.strip():
            try:
                qtys[int(k[5:])] = float(v.replace(",", ""))
            except ValueError:
                raise PostingError(f"\"{v}\" isn't a quantity.")
        elif k.startswith("price_") and v.strip():
            prices[int(k[6:])] = to_cents(v)
    bill = receive(db, doc_id, qtys, f.get("date") or None, f.get("reference"), prices)
    n = db.execute("SELECT number FROM documents WHERE id=?", (bill,)).fetchone()[0]
    po = db.execute("SELECT number, received_at FROM documents WHERE id=?", (doc_id,)).fetchone()
    left = sum(l["left"] for l in po_lines(db, doc_id))
    flash(f"Bill {n} made and the stock is in. " + (f"{po['number']} is fully received." if po["received_at"] else
                                                   f"{left:g} still to come on {po['number']}."), "ok")
    return redirect(url_for("documents.view", doc_id=bill))


def receiving_status(db, doc):
    """For a purchase order's page: (received so far, ordered) and the bills made from it."""
    tot = db.execute("SELECT COALESCE(SUM(qty),0), COALESCE(SUM(MIN(qty_received, qty)),0) FROM document_lines"
                     " WHERE document_id=?", (doc["id"],)).fetchone()
    bills = db.execute("SELECT id, number, status FROM documents WHERE source_document_id=? ORDER BY id",
                       (doc["id"],)).fetchall()
    return dict(ordered=tot[0], received=tot[1], bills=bills)

