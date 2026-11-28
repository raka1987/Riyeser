"""Sales (quotes, orders, invoices, receipts) and Purchases (quotes, orders, bills, payments)."""
import json
from datetime import date

from flask import Blueprint, render_template, request, redirect, url_for, flash, abort, g, Response

from ..db import get_db, to_cents, linked
from .. import pdf as pdfmod
from ..ledger import save_document, convert_document, void_document, record_payment, void_payment, add_days, \
    PostingError, credits_for, apply_credit, refund_credit, credit_available
from . import lookups, opt_int, opt_float, form_lines, guarded, once

bp = Blueprint("documents", __name__)

LABELS = {
    "sale": dict(title="Sales", contact="Customer", kind="customer", doc="Invoice", pay="Receive Payment"),
    "purchase": dict(title="Purchases", contact="Supplier", kind="supplier", doc="Bill", pay="Pay Bills"),
}


def _side(side):
    if side not in LABELS:
        abort(404)
    return LABELS[side]


DOC_STATUS = {
    "open": [("overdue", "Overdue"), ("not_due", "Not yet due")],
    "all": [("open", "Open"), ("overdue", "Overdue"), ("paid", "Paid"), ("void", "Void"), ("quote", "Quote"),
            ("order", "Order")],
}
_DOC_STATUS_SQL = {
    "overdue": (" AND status='open' AND due_date < ?", True), "not_due": (" AND (due_date IS NULL OR due_date >= ?)", True),
    "open": (" AND status='open'", False), "paid": (" AND status='paid'", False), "void": (" AND status='void'", False),
    "quote": (" AND status='quote'", False), "order": (" AND status='order'", False),
}


def _doc_status_sql(v, today):
    sql, dated = _DOC_STATUS_SQL[v]
    return sql, ([today] if dated else [])


def register_spec(side, status):
    """The Sales / Purchases register as a sortable, filterable list (riyeser/listing.py)."""
    from ..listing import ListSpec, Col, Choice
    L = LABELS[side]
    due = "Valid until" if side == "sale" and status == "quote" else "Due"
    choices = [Choice("st", "Status", DOC_STATUS[status], where=_doc_status_sql)] if status in DOC_STATUS else []
    return ListSpec(f"docs:{side}:{status}", [
        Col("number", "Number", "code"), Col("date", "Date", "date"), Col("cname", L["contact"]),
        Col("reference", "Reference"), Col("due_on", due, "date"), Col("status", "Status"),
        Col("total", "Total", "num"), Col("balance", "Balance due", "num")],
        sort="date", dir="desc", date_col="date", search=("number", "cname", "reference"),
        search_hint=f"Number, {L['contact'].lower()} or reference", choices=choices, noun="documents")


@bp.route("/<side>/list")
def index(side):
    L = _side(side)
    db = get_db()
    status = request.args.get("status", "open")
    if status not in ("open", "quote", "order", "paid", "void", "all"):
        status = "open"
    sql = ("SELECT d.*, c.name cname, (SELECT SUM(qty_received) FROM document_lines x WHERE x.document_id=d.id) recv,"
           " CASE WHEN d.status='open' THEN d.total-d.amount_paid ELSE 0 END balance,"
           " CASE WHEN d.status='quote' AND d.side='sale' THEN d.valid_until ELSE d.due_date END due_on"
           " FROM documents d JOIN contacts c ON c.id=d.contact_id WHERE d.side=?")
    p = [side]
    if status != "all":
        sql += " AND d.status=?"; p.append(status)
    if status == "order":
        sql += " AND d.received_at IS NULL"  # a purchase order that's all in (or closed) is finished: see All
    qs = request.args.get("qs", "") if side == "sale" and status == "quote" else ""
    if qs:
        from .quotes import filter_sql
        more, args = filter_sql(qs, date.today().isoformat())
        sql += more; p += args
    from ..listing import from_request
    lst = from_request(register_spec(side, status), keep=dict(status=status, qs=qs))
    rows = lst.fetch(db, sql, p, sums=("total", "balance"))
    from .quotes import FILTERS
    return render_template("documents/index.html", rows=rows, side=side, L=L, status=status, q=lst.q, lst=lst,
                           today=date.today().isoformat(), qs=qs, quote_filters=FILTERS)


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
        from .receiving import received_any
        if received_any(db, doc_id) or doc["received_at"]:
            flash("Goods have already been received on this order, so it can't be changed. Receive the rest, or "
                  "close it and make a new order.", "error")
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
    # S14: a typed line starts with the default account's tax code (GST), not "no tax", when registered for GST
    acct = db.execute("SELECT tax_code_id FROM accounts WHERE id=?", (default_account,)).fetchone()
    default_tax = acct["tax_code_id"] if acct and g.company.get("gst_registered", 1) else None
    kind = "credit" if (request.args.get("kind") == "credit" and not doc) else "invoice"
    from ..quote_options import of as options_of
    qoptions = options_of(db, doc_id) if doc_id else []
    return render_template("documents/edit.html", side=side, L=L, doc=doc, lines=lines, contacts=contacts,
                           qoptions=qoptions,
                           items=items, item_json=json.dumps(item_json), contact_json=json.dumps(contact_json),
                           tax_json=json.dumps(tax_json), default_account=default_account, default_tax=default_tax,
                           kind=kind,
                           preset_status=request.args.get("status", "open"),
                           preset_contact=opt_int(request.args.get("contact")), **lk)


@guarded
@once
def _save(side, doc_id):
    db = get_db()
    f = request.form
    kind = "credit" if f.get("kind") == "credit" else "invoice"
    header = dict(contact_id=opt_int(f.get("contact_id")), date=f["date"], due_date=f.get("due_date") or None,
                  reference=f.get("reference"), notes=f.get("notes"), tax_inclusive=bool(f.get("tax_inclusive")),
                  kind=kind)
    if not header["due_date"]:
        header["due_date"] = add_days(header["date"], g.company["default_terms_days"])
    lines = []
    for n, l in enumerate(form_lines(["item", "description", "qty", "price", "discount", "account", "tax", "job"]), 1):
        raw = (l["qty"] or "").strip()
        try:
            qty = float(raw.replace(",", "")) if raw else 1.0
        except ValueError:
            if l["item"] or l["description"].strip() or l["price"].strip():
                raise PostingError(f"Line {n}: quantity must be a number (you typed \"{raw}\").")  # S16
            qty = 1.0
        try:
            price = to_cents(l["price"])
        except ValueError:
            raise PostingError(f"Line {n}: price must be an amount (you typed \"{l['price']}\").")
        lines.append(dict(item_id=opt_int(l["item"]), description=l["description"].strip(),
                          qty=qty, unit_price=price,
                          discount_pct=opt_float(l["discount"]), account_id=opt_int(l["account"]),
                          tax_code_id=opt_int(l["tax"]), job_id=opt_int(l["job"])))
    status = "open" if kind == "credit" else f.get("status", "open")
    if status not in ("quote", "order", "open"):
        raise ValueError("Invalid status.")
    capped_quote = False
    if side == "sale" and status == "open" and kind == "invoice" and _free_invoices_capped(db):
        status, capped_quote = "quote", True  # M10: the typed invoice is kept, as a quote
    if status == "open" and not f.get("amount_checked"):
        _check_big(db, side, lines, header)  # M2
    if side == "sale" and status == "open" and kind == "invoice":
        _check_free_invoices(db)
        from ..ledger import check_stock
        check_stock(db, lines, bool(f.get("sell_anyway")))  # S40: tick "Sell anyway" to go below 0
    was_quote = doc_id and db.execute("SELECT status FROM documents WHERE id=?", (doc_id,)).fetchone()["status"] == "quote"
    from . import quotes
    if doc_id and status != "quote":
        quotes.check_convertible(db, doc_id)
        from .receiving import received_any
        if received_any(db, doc_id):
            raise PostingError("Goods have already been received on this order, so it can't be changed.")
    if was_quote and status != "quote":
        # S35: the quote keeps what was quoted; the order / invoice is a new document linked to it
        save_document(db, side, header, lines, "quote", doc_id)
        did = convert_document(db, doc_id, status)
        quotes.after_convert(db, doc_id, did)
    else:
        did = save_document(db, side, header, lines, status, doc_id)
        if side == "sale" and status == "quote" and doc_id:
            from ..quote_options import sync_from_document
            sync_from_document(db, did)   # a quote with options: the option on it takes the edited lines
    if side == "sale" and (status == "quote" or was_quote):
        quotes.set_valid_until(db, doc_id if was_quote else did, f.get("valid_until"), header["date"])
    doc = db.execute("SELECT number, tax_total FROM documents WHERE id=?", (did,)).fetchone()
    if capped_quote:
        from .. import plan as P
        flash(f"{P.capped_message('basic')} Your invoice is saved as quote {doc['number']}: convert it to an invoice "
              "once the licence is in.", "warn")
        return redirect(url_for("documents.view", doc_id=did))
    flash(f"{doc['number']} saved.", "ok")
    if side == "sale" and kind == "invoice" and status == "open" and not doc["tax_total"] \
            and g.company.get("gst_registered", 1):
        flash(f"{doc['number']} has no GST on it. If it should, void it and enter it again with the GST tax code.",
              "warn")  # S14
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
    from . import quotes, receiving
    from .. import perms
    from ..quote_options import of as options_of
    extra = dict(qstate=quotes.state(doc), sources=quotes.SOURCES, qoptions=options_of(db, doc_id))
    if extra["qstate"]:
        extra["bookings_on"] = quotes.uses_bookings(db) and perms.can("bookings", perms.EDIT)
        extra["job"] = db.execute("SELECT id FROM booking_jobs WHERE id=?", (doc["booking_job_id"],)).fetchone() \
            if doc["booking_job_id"] else None
    if doc["side"] == "purchase" and doc["status"] == "order":
        extra["rcv"] = receiving.receiving_status(db, doc)
    if doc["side"] == "sale" and doc["status"] == "quote":
        from .estimate import estimate_for_document
        extra["estimate"] = estimate_for_document(db, doc_id)
        if extra["estimate"]:
            from ..measure.licence import status as est_status
            st = est_status()   # only while Estimate is on this business's plan, or its trial has started here
            extra["estimate_link"] = st.get("mode") == "licensed" or (st.get("mode") == "trial" and st.get("started", True))
    if doc["source_document_id"]:
        extra["source_doc"] = db.execute("SELECT id, number FROM documents WHERE id=?",
                                         (doc["source_document_id"],)).fetchone()
    return render_template(tpl, doc=doc, lines=lines, pays=pays, L=LABELS[doc["side"]], **extra)


@bp.route("/document/<int:doc_id>/convert", methods=["POST"])
@guarded
def convert(doc_id):
    db = get_db()
    to = request.form.get("to", "open")
    doc = db.execute("SELECT side FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc and doc["side"] == "sale" and to == "open":
        _check_free_invoices(db)
    from . import quotes
    from .receiving import received_any
    quotes.check_convertible(db, doc_id)
    if received_any(db, doc_id):
        raise PostingError("Part of this order has already been received. Use \"Receive goods\" for the rest.")
    new = convert_document(db, doc_id, to)
    quotes.after_convert(db, doc_id, new)
    num = db.execute("SELECT number FROM documents WHERE id=?", (new,)).fetchone()["number"]
    flash(f"Converted: {num}." + (" The quote is kept as it was." if new != doc_id else ""), "ok")
    if to == "open":
        _auto_pdf(db, new)
    return redirect(url_for("documents.view", doc_id=new))


def free_invoices_apply():
    """Accounting Basics (and Plus once its trial has ended without a licence) is free up to a number of invoices."""
    from ..edition import is_invoices_app
    if is_invoices_app():
        return False  # Riyeser Invoices is free forever
    c = g.get("company") or {}
    return c.get("edition") == "basic" or bool(c.get("plus_locked"))


def _free_invoices_capped(db):
    from .. import plan as P
    return free_invoices_apply() and P.plan(db, "basic")["locked"]


BIG_FLOOR = 1_000_000_00  # $1,000,000


def _check_big(db, side, lines, header):
    """M2: an amount far above the business's usual ones is checked first (a slip of the keyboard)."""
    from ..ledger import calc_line
    total = sum(abs(calc_line(l["qty"], l["unit_price"], l["discount_pct"], 0, False)[0]) for l in lines)
    top = db.execute("SELECT MAX(ABS(total)) FROM documents WHERE side=? AND status IN ('open','paid')",
                     (side,)).fetchone()[0] or 0
    if total > max(top * 10, BIG_FLOOR):
        raise PostingError(f"{pdfmod.fmt_money(total)} is far more than this business's usual amounts. Check it, then "
                           "tick \"Amount checked\" and save again.")


def _check_free_invoices(db):
    from .. import plan as P
    if free_invoices_apply() and P.plan(db, "basic")["locked"]:
        raise PostingError(P.capped_message("basic") + " Quotes and orders can still be saved.")


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


@bp.route("/document/<int:doc_id>/email", methods=["POST"])
@guarded
def email(doc_id):
    """Email an invoice, quote or credit note with its PDF (S18)."""
    from .email import send_or_queue
    db = get_db()
    doc = db.execute("SELECT d.*, c.name cname, c.email cemail FROM documents d JOIN contacts c ON c.id=d.contact_id"
                     " WHERE d.id=?", (doc_id,)).fetchone() or abort(404)
    title = pdfmod.doc_title(doc)
    to = (request.form.get("to") or doc["cemail"] or "").strip()
    if not to:
        raise ValueError(f"Add {doc['cname']}'s email address first (or type one in).")
    name, _ = pdfmod.document_filename(db, doc_id)
    due = doc["total"] - doc["amount_paid"]
    body = request.form.get("message") or (
        f"Hello {doc['cname']},\n\nPlease find attached {title.lower()} {doc['number']}"
        + (f" for {pdfmod.fmt_money(due)}, due {doc['due_date']}" if doc["status"] == "open" and due > 0 and
           doc["kind"] == "invoice" else "")
        + (f", valid until {doc['valid_until']}" if doc["status"] == "quote" and doc["valid_until"] else "")
        + f".\n\nThank you,\n{g.company['name']}")
    msg = send_or_queue(db, to, request.form.get("subject") or f"{title} {doc['number']} from {g.company['name']}",
                        body, (name, pdfmod.document_pdf(db, doc_id)), "document", doc_id)
    flash(msg, "ok")
    return redirect(url_for("documents.view", doc_id=doc_id))


@bp.route("/document/<int:doc_id>/void", methods=["POST"])
@guarded
def void(doc_id):
    void_document(get_db(), doc_id)
    from .receiving import undo_receipt
    undo_receipt(get_db(), doc_id)  # a bill from a purchase order: those goods are "still to come" again
    flash("Document voided and reversed in the ledger.", "ok")
    return redirect(url_for("documents.view", doc_id=doc_id))


@bp.route("/document/<int:doc_id>/delete", methods=["POST"])
@guarded
def delete(doc_id):
    db = get_db()
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc["status"] not in ("quote", "order"):
        raise ValueError("Only quotes and orders can be deleted.")
    from .receiving import received_any
    if received_any(db, doc_id):
        raise ValueError("Goods have been received on this order, so it's kept. Close it instead if nothing more is "
                         "coming.")
    db.execute("UPDATE documents SET source_document_id=NULL WHERE source_document_id=?", (doc_id,))
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
    # every active customer: a deposit or prepayment can come before any invoice (S43)
    contacts = db.execute("SELECT * FROM contacts WHERE kind=? AND active=1 ORDER BY name", (L["kind"],)).fetchall()
    docs, credits = [], []
    if cid:
        docs = db.execute("SELECT * FROM documents WHERE side=? AND contact_id=? AND status='open' AND kind='invoice'"
                          " ORDER BY due_date", (side, cid)).fetchall()
        credits = [dict(c, available=credit_available(c)) for c in credits_for(db, cid, side)]
    return render_template("documents/pay.html", side=side, L=L, contacts=contacts, cid=cid, docs=docs,
                           credits=credits, default_bank=linked(db, "default_bank"), **lookups(db))


@guarded
@once
def _save_payment(side):
    db = get_db()
    f = request.form
    allocs = [(int(k[6:]), to_cents(v)) for k, v in f.items() if k.startswith("alloc_") and v.strip()]
    if not f.get("date_ok"):  # M17
        for d_id, _a in allocs:
            d = db.execute("SELECT number, date FROM documents WHERE id=?", (d_id,)).fetchone()
            if d and f["date"] < d["date"]:
                raise PostingError(f"{f['date']} is before the date of {d['number']} ({d['date']}). Check the date, "
                                   "or tick \"Save anyway\".")
    amount = to_cents(f["amount"]) if (f.get("amount") or "").strip() else None
    pid = record_payment(db, "in" if side == "sale" else "out", int(f["contact_id"]), int(f["bank_account_id"]),
                         f["date"], allocs, f.get("reference"), f.get("memo") or None, amount=amount)
    extra = db.execute("SELECT number, total FROM documents WHERE payment_id=? AND kind='payment_credit'",
                       (pid,)).fetchone()
    flash("Payment recorded." + (f" {pdfmod.fmt_money(-extra['total'])} is kept as credit ({extra['number']}): use it on "
                                 f"a later {LABELS[side]['doc'].lower()} or refund it." if extra else ""), "ok")
    return redirect(url_for("documents.payments", side=side, hl=pid))


@bp.route("/credit/<int:cid>/apply", methods=["POST"])
@guarded
@once
def credit_apply(cid):
    db = get_db()
    cr = db.execute("SELECT * FROM documents WHERE id=?", (cid,)).fetchone() or abort(404)
    apply_credit(db, cid, opt_int(request.form.get("document_id")), to_cents(request.form.get("amount")),
                 request.form.get("date") or None)
    flash("Credit applied.", "ok")
    return redirect(url_for("documents.pay", side=cr["side"], contact=cr["contact_id"]))


@bp.route("/credit/<int:cid>/refund", methods=["POST"])
@guarded
@once
def credit_refund(cid):
    db = get_db()
    cr = db.execute("SELECT * FROM documents WHERE id=?", (cid,)).fetchone() or abort(404)
    f = request.form
    refund_credit(db, cid, int(f["bank_account_id"]), f.get("date") or date.today().isoformat(), to_cents(f.get("amount")),
                  f.get("reference"))
    flash("Refund recorded.", "ok")
    return redirect(url_for("documents.pay", side=cr["side"], contact=cr["contact_id"]))


@bp.route("/<side>/payments")
def payments(side):
    L = _side(side)
    db = get_db()
    from ..listing import ListSpec, Col, Choice, from_request
    banks = [(str(r["id"]), r["name"]) for r in db.execute("SELECT id, name FROM accounts WHERE is_bank=1 ORDER BY code")]
    spec = ListSpec(f"payments:{side}", [
        Col("date", "Date", "date"), Col("cname", L["contact"]), Col("bank", "Bank"), Col("reference", "Reference"),
        Col("memo", "Memo"), Col("amount", "Amount", "num")],
        sort="date", dir="desc", date_col="date", search=("cname", "reference", "memo"),
        search_hint=f"{L['contact']}, reference or memo", noun="payments", choices=[
            Choice("bank_id", "Bank account", banks, col="bank_account_id"),
            Choice("st", "Status", [("ok", "Not voided"), ("void", "Voided")],
                   where={"ok": (" AND voided=0", []), "void": (" AND voided=1", [])})])
    lst = from_request(spec)
    rows = lst.fetch(db, "SELECT p.*, c.name cname, a.name bank FROM payments p JOIN contacts c ON c.id=p.contact_id"
                         " JOIN accounts a ON a.id=p.bank_account_id WHERE p.direction=?",
                     ("in" if side == "sale" else "out",), sums=("CASE WHEN voided=0 THEN amount ELSE 0 END",))
    return render_template("documents/payments.html", rows=rows, side=side, L=L, hl=opt_int(request.args.get("hl")),
                           lst=lst, paid=lst.sums["CASE WHEN voided=0 THEN amount ELSE 0 END"])


@bp.route("/payment/<int:pid>/void", methods=["POST"])
@guarded
def payment_void(pid):
    db = get_db()
    p = db.execute("SELECT * FROM payments WHERE id=?", (pid,)).fetchone()
    void_payment(db, pid)
    flash("Payment voided.", "ok")
    return redirect(url_for("documents.payments", side="sale" if p["direction"] == "in" else "purchase"))


from . import quotes, receiving  # noqa: E402,F401  (their routes are on this blueprint)
