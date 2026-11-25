"""Contacts: customers and suppliers."""
from flask import Blueprint, render_template, request, redirect, url_for, flash, abort

from ..db import get_db, audit, to_cents
from . import lookups, opt_int, guarded

bp = Blueprint("contacts", __name__, url_prefix="/cards")


@bp.route("/<kind>")
def index(kind):
    if kind not in ("customer", "supplier"):
        abort(404)
    db = get_db()
    q = request.args.get("q", "")
    side = "sale" if kind == "customer" else "purchase"
    rows = db.execute(
        "SELECT c.*, COALESCE((SELECT SUM(total-amount_paid) FROM documents d WHERE d.contact_id=c.id"
        " AND d.side=? AND d.status='open'),0) balance FROM contacts c WHERE c.kind=? AND c.name LIKE ?"
        " ORDER BY c.active DESC, c.name", (side, kind, f"%{q}%")).fetchall()
    return render_template("contacts/index.html", rows=rows, kind=kind, q=q)


@bp.route("/<kind>/new", methods=["GET", "POST"])
@bp.route("/<kind>/<int:cid>/edit", methods=["GET", "POST"])
def edit(kind, cid=None):
    if kind not in ("customer", "supplier"):
        abort(404)
    db = get_db()
    if request.method == "POST":
        return _save(kind, cid)
    c = db.execute("SELECT * FROM contacts WHERE id=?", (cid,)).fetchone() if cid else None
    return render_template("contacts/edit.html", c=c, kind=kind, **lookups(db))


@guarded
def _save(kind, cid):
    db = get_db()
    f = request.form
    if not f.get("name", "").strip():
        raise ValueError("Name is required.")
    vals = (f["name"].strip(), f.get("abn"), f.get("contact_person"), f.get("email"), f.get("phone"),
            f.get("address"), opt_int(f.get("terms_days")), to_cents(f.get("credit_limit")) or None,
            opt_int(f.get("default_account_id")), opt_int(f.get("tax_code_id")), f.get("notes"),
            1 if f.get("active") else 0)
    if cid:
        db.execute("UPDATE contacts SET name=?, abn=?, contact_person=?, email=?, phone=?, address=?, terms_days=?,"
                   " credit_limit=?, default_account_id=?, tax_code_id=?, notes=?, active=? WHERE id=?",
                   vals + (cid,))
    else:
        cid = db.execute("INSERT INTO contacts (name, abn, contact_person, email, phone, address, terms_days,"
                         " credit_limit, default_account_id, tax_code_id, notes, active, kind)"
                         " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", vals + (kind,)).lastrowid
    audit(db, f"save_{kind}", vals[0])
    flash(f"{vals[0]} saved.", "ok")
    return redirect(url_for("contacts.view", cid=cid))


@bp.route("/view/<int:cid>")
def view(cid):
    db = get_db()
    c = db.execute("SELECT * FROM contacts WHERE id=?", (cid,)).fetchone()
    if not c:
        abort(404)
    docs = db.execute("SELECT * FROM documents WHERE contact_id=? ORDER BY date DESC, id DESC", (cid,)).fetchall()
    pays = db.execute("SELECT p.*, a.name bank FROM payments p JOIN accounts a ON a.id=p.bank_account_id"
                      " WHERE contact_id=? ORDER BY date DESC", (cid,)).fetchall()
    balance = sum(d["total"] - d["amount_paid"] for d in docs if d["status"] == "open")
    from .bookings import customer_bookings
    from .. import perms
    bks = customer_bookings(db, cid) if c["kind"] == "customer" and perms.can("bookings") else []
    return render_template("contacts/view.html", c=c, docs=docs, pays=pays, balance=balance, bks=bks)


def _period():
    from datetime import date
    end = request.args.get("end") or date.today().isoformat()
    start = request.args.get("start") or date.fromisoformat(end).replace(day=1).isoformat()
    return start, end


@bp.route("/statement/<int:cid>")
def statement(cid):
    """An activity statement for a period (S44), for customers and suppliers."""
    from ..statements import statement as build, payment_details
    db = get_db()
    c = db.execute("SELECT * FROM contacts WHERE id=?", (cid,)).fetchone()
    if not c:
        abort(404)
    start, end = _period()
    if request.args.get("pdf"):
        from flask import Response
        from .. import pdf as pdfmod
        name = pdfmod.safe_name(f"Statement {c['name']} {end}") + ".pdf"
        return Response(pdfmod.statement_pdf(db, cid, start, end), mimetype="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})
    return render_template("contacts/statement.html", st=build(db, cid, start, end), c=c,
                           how_to_pay=payment_details(db.execute("SELECT * FROM company WHERE id=1").fetchone()))


@bp.route("/statements")
def statements_all():
    """Every customer with a balance: one PDF to print, or email them all (S44)."""
    from ..statements import with_balance
    db = get_db()
    start, end = _period()
    people = with_balance(db, "customer")
    if request.args.get("pdf"):
        from flask import Response
        from .. import pdf as pdfmod
        doc = pdfmod._PDF(pdfmod._company(db))
        for c in people:
            pdfmod.statement_pdf(db, c["id"], start, end, pdf=doc)
        if not people:
            doc.add_page()
            doc.notes("No customer has a balance.")
        return Response(bytes(doc.output()), mimetype="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="Statements {end}.pdf"'})
    return render_template("contacts/statements.html", people=people, start=start, end=end)
