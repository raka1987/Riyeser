"""Sales (quotes, orders, invoices, receipts) and Purchases (quotes, orders, bills, payments)."""
import json
from datetime import date

from flask import Blueprint, render_template, request, redirect, url_for, flash, abort, g, Response

from ..db import get_db, to_cents, linked
from .. import pdf as pdfmod
from ..ledger import save_document, convert_document, void_document, record_payment, void_payment, add_days
from . import lookups, opt_int, opt_float, form_lines, guarded

bp = Blueprint("documents", __name__)

LABELS = {
    "sale": dict(title="Sales", contact="Customer", kind="customer", doc="Invoice", pay="Receive Payment"),
    "purchase": dict(title="Purchases", contact="Supplier", kind="supplier", doc="Bill", pay="Pay Bills"),
}


def _side(side):
    if side not in LABELS:
        abort(404)
    return LABELS[side]


@bp.route("/<side>/list")
def index(side):
    L = _side(side)
    db = get_db()
    status = request.args.get("status", "open")
    q = request.args.get("q", "")
    sql = ("SELECT d.*, c.name cname FROM documents d JOIN contacts c ON c.id=d.contact_id"
           " WHERE d.side=? AND (c.name LIKE ? OR d.number LIKE ?)")
    p = [side, f"%{q}%", f"%{q}%"]
    if status != "all":
        sql += " AND d.status=?"; p.append(status)
    sql += " ORDER BY d.date DESC, d.id DESC LIMIT 500"
    rows = db.execute(sql, p).fetchall()
    return render_template("documents/index.html", rows=rows, side=side, L=L, status=status, q=q,
                           today=date.today().isoformat())


@bp.route("/<side>/new", methods=["GET", "POST"])
@bp.route("/<side>/<int:doc_id>/edit", methods=["GET", "POST"])
def edit(side, doc_id=None):
    L = _side(side)
    db = get_db()
    if request.method == "POST":
        return _save(side, doc_id)
    doc = lines = None
    if doc_id:
        doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if doc["status"] not in ("quote", "order"):
            flash("Posted documents can't be edited. Void and re-enter instead.", "error")
            return redirect(url_for("documents.view", doc_id=doc_id))
        lines = db.execute("SELECT * FROM document_lines WHERE document_id=?", (doc_id,)).fetchall()
    contacts = db.execute("SELECT * FROM contacts WHERE kind=? AND active=1 ORDER BY name", (L["kind"],)).fetchall()
    col = "is_sold" if side == "sale" else "is_bought"
    items = db.execute(f"SELECT * FROM items WHERE active=1 AND {col}=1 ORDER BY sku").fetchall()
    lk = lookups(db)
    item_json = {i["id"]: dict(name=i["name"], price=(i["sell_price"] if side == "sale" else i["buy_price"]) / 100,
                               account=(i["income_account_id"] if side == "sale" else
                                        (i["asset_account_id"] if i["is_inventoried"] else i["expense_account_id"])),
                               tax=i["sale_tax_code_id"] if side == "sale" else i["purchase_tax_code_id"],
                               qty=i["qty_on_hand"])
                 for i in items}
    contact_json = {c["id"]: dict(terms=c["terms_days"] if c["terms_days"] is not None
                                  else g.company["default_terms_days"],
                                  account=c["default_account_id"], tax=c["tax_code_id"]) for c in contacts}
    tax_json = {t["id"]: t["rate"] for t in lk["tax_codes"]}
    default_account = linked(db, "default_income" if side == "sale" else "default_expense")
    return render_template("documents/edit.html", side=side, L=L, doc=doc, lines=lines, contacts=contacts,
                           items=items, item_json=json.dumps(item_json), contact_json=json.dumps(contact_json),
                           tax_json=json.dumps(tax_json), default_account=default_account,
                           preset_status=request.args.get("status", "open"),
                           preset_contact=opt_int(request.args.get("contact")), **lk)


@guarded
def _save(side, doc_id):
    db = get_db()
    f = request.form
    header = dict(contact_id=opt_int(f.get("contact_id")), date=f["date"], due_date=f.get("due_date") or None,
                  reference=f.get("reference"), notes=f.get("notes"), tax_inclusive=bool(f.get("tax_inclusive")))
    if not header["due_date"]:
        header["due_date"] = add_days(header["date"], g.company["default_terms_days"])
    lines = []
    for l in form_lines(["item", "description", "qty", "price", "discount", "account", "tax", "job"]):
        lines.append(dict(item_id=opt_int(l["item"]), description=l["description"].strip(),
                          qty=opt_float(l["qty"], 1.0), unit_price=to_cents(l["price"]),
                          discount_pct=opt_float(l["discount"]), account_id=opt_int(l["account"]),
                          tax_code_id=opt_int(l["tax"]), job_id=opt_int(l["job"])))
    status = f.get("status", "open")
    if status not in ("quote", "order", "open"):
        raise ValueError("Invalid status.")
    did = save_document(db, side, header, lines, status, doc_id)
    doc = db.execute("SELECT number FROM documents WHERE id=?", (did,)).fetchone()
    flash(f"{doc['number']} saved.", "ok")
    if status == "open":
        _auto_pdf(db, did)
    return redirect(url_for("documents.view", doc_id=did))


@bp.route("/document/<int:doc_id>")
def view(doc_id):
    db = get_db()
    doc = db.execute("SELECT d.*, c.name cname, c.address caddress, c.abn cabn, c.email cemail FROM documents d"
                     " JOIN contacts c ON c.id=d.contact_id WHERE d.id=?", (doc_id,)).fetchone()
    if not doc:
        abort(404)
    lines = db.execute("SELECT l.*, a.code acode, t.code tcode, i.sku, j.code jcode FROM document_lines l"
                       " LEFT JOIN accounts a ON a.id=l.account_id LEFT JOIN tax_codes t ON t.id=l.tax_code_id"
                       " LEFT JOIN items i ON i.id=l.item_id LEFT JOIN jobs j ON j.id=l.job_id"
                       " WHERE l.document_id=? ORDER BY l.id", (doc_id,)).fetchall()
    pays = db.execute("SELECT p.*, a.amount alloc FROM payment_allocations a JOIN payments p ON p.id=a.payment_id"
                      " WHERE a.document_id=? ORDER BY p.date", (doc_id,)).fetchall()
    if request.args.get("pdf"):
        name, _ = pdfmod.document_filename(db, doc_id)
        return Response(pdfmod.document_pdf(db, doc_id), mimetype="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})
    tpl = "documents/print.html" if request.args.get("print") else "documents/view.html"
    return render_template(tpl, doc=doc, lines=lines, pays=pays, L=LABELS[doc["side"]])


@bp.route("/document/<int:doc_id>/convert", methods=["POST"])
@guarded
def convert(doc_id):
    db = get_db()
    to = request.form.get("to", "open")
    convert_document(db, doc_id, to)
    flash("Document converted.", "ok")
    if to == "open":
        _auto_pdf(db, doc_id)
    return redirect(url_for("documents.view", doc_id=doc_id))


def _auto_pdf(db, doc_id):
    if g.company["auto_pdf"]:
        try:
            path = pdfmod.save_document_pdf(db, doc_id)
            flash(f"PDF saved to {path}", "ok")
        except OSError as e:
            flash(f"Saved, but the PDF could not be written to the Riyeser folder: {e}", "error")


@bp.route("/document/<int:doc_id>/save-pdf", methods=["POST"])
def save_pdf(doc_id):
    try:
        path = pdfmod.save_document_pdf(get_db(), doc_id)
        flash(f"PDF saved to {path}", "ok")
    except OSError as e:
        flash(f"Could not write the PDF: {e}", "error")
    return redirect(url_for("documents.view", doc_id=doc_id))


@bp.route("/document/<int:doc_id>/void", methods=["POST"])
@guarded
def void(doc_id):
    void_document(get_db(), doc_id)
    flash("Document voided and reversed in the ledger.", "ok")
    return redirect(url_for("documents.view", doc_id=doc_id))


@bp.route("/document/<int:doc_id>/delete", methods=["POST"])
@guarded
def delete(doc_id):
    db = get_db()
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc["status"] not in ("quote", "order"):
        raise ValueError("Only quotes and orders can be deleted.")
    db.execute("DELETE FROM documents WHERE id=?", (doc_id,))
    flash(f"{doc['number']} deleted.", "ok")
    return redirect(url_for("documents.index", side=doc["side"], status=doc["status"]))


# ------------------------------------------------------------------ payments
@bp.route("/<side>/pay", methods=["GET", "POST"])
def pay(side):
    L = _side(side)
    db = get_db()
    if request.method == "POST":
        return _save_payment(side)
    cid = opt_int(request.args.get("contact"))
    contacts = db.execute("SELECT * FROM contacts WHERE kind=? AND id IN (SELECT contact_id FROM documents"
                          " WHERE side=? AND status='open') ORDER BY name", (L["kind"], side)).fetchall()
    docs = []
    if cid:
        docs = db.execute("SELECT * FROM documents WHERE side=? AND contact_id=? AND status='open' ORDER BY due_date",
                          (side, cid)).fetchall()
    return render_template("documents/pay.html", side=side, L=L, contacts=contacts, cid=cid, docs=docs,
                           default_bank=linked(db, "default_bank"), **lookups(db))


@guarded
def _save_payment(side):
    db = get_db()
    f = request.form
    allocs = [(int(k[6:]), to_cents(v)) for k, v in f.items() if k.startswith("alloc_") and v.strip()]
    pid = record_payment(db, "in" if side == "sale" else "out", int(f["contact_id"]), int(f["bank_account_id"]),
                         f["date"], allocs, f.get("reference"), f.get("memo") or None)
    flash("Payment recorded.", "ok")
    return redirect(url_for("documents.payments", side=side, hl=pid))


@bp.route("/<side>/payments")
def payments(side):
    L = _side(side)
    rows = get_db().execute(
        "SELECT p.*, c.name cname, a.name bank FROM payments p JOIN contacts c ON c.id=p.contact_id"
        " JOIN accounts a ON a.id=p.bank_account_id WHERE p.direction=? ORDER BY p.date DESC, p.id DESC LIMIT 500",
        ("in" if side == "sale" else "out",)).fetchall()
    return render_template("documents/payments.html", rows=rows, side=side, L=L, hl=opt_int(request.args.get("hl")))


@bp.route("/payment/<int:pid>/void", methods=["POST"])
@guarded
def payment_void(pid):
    db = get_db()
    p = db.execute("SELECT * FROM payments WHERE id=?", (pid,)).fetchone()
    void_payment(db, pid)
    flash("Payment voided.", "ok")
    return redirect(url_for("documents.payments", side="sale" if p["direction"] == "in" else "purchase"))
