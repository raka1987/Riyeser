"""Expense claims (Accounting Basics and Plus): staff paid for something for the business and want the money back.

Anyone with Add & edit on Expense claims enters their own claim with the receipt. Someone with Full approves or
declines it (with a reason). An approved claim goes into the books with the usual posting code: either as a bill
owed to the staff member (paid later under Pay bills, and the claim shows Paid once the bill is paid) or as money
already paid out of a bank account. Riyeser Invoices, Bookings and POS don't have expense claims
(riyeser/__init__.py keeps each app to its own screens)."""
from datetime import date, timedelta

from flask import Blueprint, render_template, request, redirect, url_for, flash, abort, g, Response

from .. import perms
from ..db import get_db, audit, to_cents, fmt_money, linked, round_cents
from ..ledger import save_document, bank_transaction, PostingError
from . import guarded, once, opt_int

bp = Blueprint("expenses", __name__, url_prefix="/expenses")

STATUSES = [("waiting", "Waiting"), ("approved", "Approved"), ("declined", "Declined"), ("paid", "Paid")]
RECEIPT_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "application/pdf"}
MAX_RECEIPT = 10 * 1024 * 1024


def is_manager():
    return perms.can("expenses", perms.FULL)


def me():
    return g.user["full_name"] or g.user["username"]


def _sync(db):
    """A claim owed as a bill is Paid once that bill is paid; if the bill was voided, the claim waits again."""
    db.execute("UPDATE expense_claims SET status='paid' WHERE status='approved' AND pay_how='bill' AND document_id IN"
               " (SELECT id FROM documents WHERE status='paid')")
    db.execute("UPDATE expense_claims SET status='waiting', pay_how=NULL, document_id=NULL, decided_by=NULL,"
               " decided_at=NULL, reason='The bill for this claim was voided, so it needs approving again.'"
               " WHERE status IN ('approved','paid') AND pay_how='bill' AND document_id IN"
               " (SELECT id FROM documents WHERE status='void')")
    db.commit()


def expense_accounts(db):
    return db.execute("SELECT * FROM accounts WHERE active=1 AND type IN ('expense','cost_of_sales','other_expense')"
                      " ORDER BY code").fetchall()


def _claim(db, xid):
    x = db.execute("SELECT x.*, a.code acode, a.name aname, u.full_name ufull, u.username uname,"
                   " d.full_name dfull, d.username dname, doc.number doc_no, doc.status doc_status,"
                   " doc.total - doc.amount_paid doc_due, r.filename rname, r.mime rmime"
                   " FROM expense_claims x LEFT JOIN accounts a ON a.id=x.account_id LEFT JOIN users u ON u.id=x.user_id"
                   " LEFT JOIN users d ON d.id=x.decided_by LEFT JOIN documents doc ON doc.id=x.document_id"
                   " LEFT JOIN expense_receipts r ON r.claim_id=x.id WHERE x.id=?", (xid,)).fetchone()
    if not x:
        abort(404)
    if not is_manager() and x["user_id"] != g.user["id"]:
        abort(403)  # staff see their own claims only
    return x


@bp.route("/")
def index():
    db = get_db()
    _sync(db)
    show = request.args.get("show", "waiting")
    if show not in dict(STATUSES) and show != "all":
        show = "waiting"
    who = request.args.get("who", "").strip()
    where, args = ["1=1"], []
    if not is_manager():
        where.append("x.user_id=?")
        args.append(g.user["id"])
    elif who:
        where.append("x.claimant=?")
        args.append(who)
    counts = {r["status"]: r["n"] for r in db.execute(
        f"SELECT status, COUNT(*) n FROM expense_claims x WHERE {' AND '.join(where)} GROUP BY status", args)}
    counts["all"] = sum(counts.values())
    if show != "all":
        where.append("x.status=?")
        args.append(show)
    from ..listing import ListSpec, Col, from_request
    lst = from_request(ListSpec(f"expenses:{show}", [
        Col("date", "Date", "date"), Col("claimant", "Who"), Col("supplier", "Supplier"), Col("aname", "What for"),
        Col("status", "Status"), Col("gst", "GST", "num"), Col("amount", "Amount", "num")],
        sort="date", dir="desc", date_col="date", search=("supplier", "aname", "note", "claimant"),
        search_hint="Supplier, what for or note", noun="claims"), keep=dict(show=show, who=who))
    rows = lst.fetch(db, "SELECT x.*, a.name aname, (SELECT 1 FROM expense_receipts r WHERE r.claim_id=x.id) has_receipt"
                         " FROM expense_claims x LEFT JOIN accounts a ON a.id=x.account_id"
                         f" WHERE {' AND '.join(where)}", args, sums=("amount",))
    people = [r[0] for r in db.execute("SELECT DISTINCT claimant FROM expense_claims ORDER BY claimant")] \
        if is_manager() else []
    return render_template("expenses/index.html", rows=rows, show=show, counts=counts, statuses=STATUSES, lst=lst,
                           manager=is_manager(), people=people, who=who, total=lst.sums["amount"])


@bp.route("/new", methods=["GET", "POST"])
def new():
    db = get_db()
    if request.method == "POST":
        return _save()
    co = db.execute("SELECT gst_registered FROM company WHERE id=1").fetchone()
    return render_template("expenses/new.html", accounts=expense_accounts(db), default_account=linked(db, "default_expense"),
                           manager=is_manager(), me=me(), gst=bool(co["gst_registered"]),
                           people=[r[0] for r in db.execute("SELECT DISTINCT claimant FROM expense_claims ORDER BY claimant")]
                           if is_manager() else [])


def _gst_rate(db):
    tc = db.execute("SELECT * FROM tax_codes WHERE kind='gst' ORDER BY active DESC, code='GST' DESC, id LIMIT 1").fetchone()
    return tc


@guarded
@once
def _save():
    db = get_db()
    f = request.form
    when = (f.get("date") or "").strip()
    try:
        date.fromisoformat(when)
    except ValueError:
        raise ValueError("Enter the date you paid, like 2026-11-24.")
    amount = to_cents(f.get("amount"))
    if amount <= 0:
        raise ValueError("Enter how much you paid, including GST.")
    co = db.execute("SELECT gst_registered FROM company WHERE id=1").fetchone()
    gst = to_cents(f.get("gst")) if co["gst_registered"] else 0
    if gst < 0:
        raise ValueError("GST can't be below $0.")
    tc = _gst_rate(db)
    rate = tc["rate"] if tc else 10.0
    if gst and gst > round_cents(amount * rate / (100 + rate)) + 1:
        raise ValueError(f"The GST can't be more than {fmt_money(round_cents(amount * rate / (100 + rate)))} "
                         f"on {fmt_money(amount)}. Check the receipt.")
    acct = opt_int(f.get("account_id"))
    if not acct or acct not in {a["id"] for a in expense_accounts(db)}:
        raise ValueError("Choose what it was for (the category).")
    claimant = me()
    if is_manager() and (f.get("claimant") or "").strip():
        claimant = f["claimant"].strip()  # a manager can enter a claim for a staff member
    up = request.files.get("receipt")
    data = None
    if up and up.filename:
        data = up.read(MAX_RECEIPT + 1)
        mime = (up.mimetype or "").lower()
        if len(data) > MAX_RECEIPT:
            raise ValueError("That receipt is bigger than 10 MB. Take the photo again at a smaller size, or attach a PDF.")
        if mime not in RECEIPT_TYPES:
            raise ValueError("Attach the receipt as a photo (JPG, PNG, HEIC) or a PDF.")
        if not data:
            data = None
    xid = db.execute("INSERT INTO expense_claims (user_id, claimant, date, supplier, amount, gst, account_id, note)"
                     " VALUES (?,?,?,?,?,?,?,?)",
                     (g.user["id"], claimant, when, (f.get("supplier") or "").strip() or None, amount, gst, acct,
                      (f.get("note") or "").strip() or None)).lastrowid
    if data:
        db.execute("INSERT INTO expense_receipts (claim_id, filename, mime, data) VALUES (?,?,?,?)",
                   (xid, up.filename[-120:], mime, data))
    audit(db, "expense_claim", f"#{xid} {claimant} {fmt_money(amount)}")
    flash(f"Expense claim for {fmt_money(amount)} sent. A manager will approve it." +
          ("" if data else " Tip: attach the receipt so it can be checked."), "ok")
    return redirect(url_for("expenses.view", xid=xid))


@bp.route("/<int:xid>")
def view(xid):
    db = get_db()
    _sync(db)
    x = _claim(db, xid)
    from . import lookups
    return render_template("expenses/view.html", x=x, manager=is_manager(),
                           own=x["user_id"] == g.user["id"], admin=g.user["role"] == "admin",
                           bank_accounts=lookups(db)["bank_accounts"], today=date.today().isoformat(),
                           statuses=dict(STATUSES))


@bp.route("/<int:xid>/receipt")
def receipt(xid):
    db = get_db()
    _claim(db, xid)
    r = db.execute("SELECT * FROM expense_receipts WHERE claim_id=?", (xid,)).fetchone() or abort(404)
    name = (r["filename"] or f"receipt-{xid}").replace('"', "")
    how = "attachment" if request.args.get("download") else "inline"
    return Response(r["data"], mimetype=r["mime"], headers={"Content-Disposition": f'{how}; filename="{name}"',
                                                            "X-Content-Type-Options": "nosniff"})


@bp.route("/<int:xid>/withdraw", methods=["POST"])
@guarded
def withdraw(xid):
    db = get_db()
    x = _claim(db, xid)
    if x["status"] != "waiting":
        raise ValueError("Only a claim that's still waiting can be withdrawn.")
    db.execute("DELETE FROM expense_receipts WHERE claim_id=?", (xid,))
    db.execute("DELETE FROM expense_claims WHERE id=?", (xid,))
    audit(db, "expense_claim_withdrawn", f"#{xid} {x['claimant']} {fmt_money(x['amount'])}")
    flash("Claim withdrawn.", "ok")
    return redirect(url_for("expenses.index"))


def staff_contact(db, claimant):
    """The staff member as a supplier card, so the bill has someone to be paid to."""
    r = db.execute("SELECT contact_id FROM expense_claims WHERE claimant=? AND contact_id IS NOT NULL"
                   " ORDER BY id DESC LIMIT 1", (claimant,)).fetchone()
    if r and db.execute("SELECT 1 FROM contacts WHERE id=? AND kind='supplier'", (r[0],)).fetchone():
        return r[0]
    r = db.execute("SELECT id FROM contacts WHERE kind='supplier' AND name=? COLLATE NOCASE ORDER BY active DESC, id",
                   (claimant,)).fetchone()
    if r:
        return r[0]
    return db.execute("INSERT INTO contacts (kind, name, notes) VALUES ('supplier', ?, ?)",
                      (claimant, "Staff member: expense claims are paid back to them.")).lastrowid


def claim_lines(db, x):
    """The amount split so the books get exactly the GST on the receipt: the part with GST on the GST code, the
    rest (if any) GST free. Amounts include GST."""
    co = db.execute("SELECT gst_registered FROM company WHERE id=1").fetchone()
    tc = _gst_rate(db)
    from ..countries import tax_code_id
    free = {"id": tax_code_id(db, "free" if co["gst_registered"] else "none")}
    memo = " · ".join(v for v in (x["supplier"], x["note"]) if v) or "Expense claim"
    memo = f"{memo} (claim {x['id']}, {x['claimant']})"
    base = dict(account_id=x["account_id"], memo=memo, description=memo)
    if x["gst"] and tc and tc["rate"]:
        taxable = min(x["amount"], round_cents(x["gst"] * (100 + tc["rate"]) / tc["rate"]))
        out = [dict(base, amount=taxable, tax_code_id=tc["id"])]
        if x["amount"] - taxable > 0:
            out.append(dict(base, amount=x["amount"] - taxable, tax_code_id=free["id"] if free else None))
        return out
    return [dict(base, amount=x["amount"], tax_code_id=free["id"] if free else None)]


@bp.route("/<int:xid>/decide", methods=["POST"])
@guarded
def decide(xid):
    db = get_db()
    x = _claim(db, xid)
    if not is_manager():
        raise ValueError("Only a manager (Full access to Expense claims) can approve or decline claims.")
    if x["status"] != "waiting":
        raise ValueError("This claim has already been decided.")
    if x["user_id"] == g.user["id"] and g.user["role"] != "admin":
        raise ValueError("Someone else needs to approve your own claim (or an administrator).")
    f = request.form
    if f.get("action") == "decline":
        reason = (f.get("reason") or "").strip()
        if not reason:
            raise ValueError("Say why it's declined, so they know what to fix (for example: no receipt).")
        db.execute("UPDATE expense_claims SET status='declined', reason=?, decided_by=?,"
                   " decided_at=datetime('now','localtime') WHERE id=?", (reason, g.user["id"], xid))
        audit(db, "expense_claim_declined", f"#{xid} {x['claimant']}: {reason}")
        flash(f"Claim declined. {x['claimant']} will see the reason.", "ok")
        return redirect(url_for("expenses.view", xid=xid))
    if f.get("action") != "approve":
        raise ValueError("Choose Approve or Decline.")
    how = f.get("pay_how")
    lines = claim_lines(db, x)
    if how == "bill":
        cid = staff_contact(db, x["claimant"])
        doc = save_document(db, "purchase", dict(
            contact_id=cid, date=x["date"], due_date=(date.today() + timedelta(days=7)).isoformat(),
            reference=f"Claim {xid}", notes=f"Expense claim {xid} from {x['claimant']}", tax_inclusive=True),
            [dict(description=l["description"], qty=1, unit_price=l["amount"], account_id=l["account_id"],
                  tax_code_id=l["tax_code_id"]) for l in lines], "open")
        db.execute("UPDATE expense_claims SET status='approved', pay_how='bill', contact_id=?, document_id=?,"
                   " decided_by=?, decided_at=datetime('now','localtime'), reason=NULL WHERE id=?",
                   (cid, doc, g.user["id"], xid))
        number = db.execute("SELECT number FROM documents WHERE id=?", (doc,)).fetchone()[0]
        audit(db, "expense_claim_approved", f"#{xid} {x['claimant']} {fmt_money(x['amount'])} as bill {number}")
        flash(f"Approved. Bill {number} for {fmt_money(x['amount'])} is owed to {x['claimant']}: pay it under Pay bills.",
              "ok")
    elif how == "bank":
        bank = opt_int(f.get("bank_account_id"))
        paid_on = (f.get("paid_on") or "").strip() or date.today().isoformat()
        row = db.execute("SELECT is_bank FROM accounts WHERE id=?", (bank,)).fetchone() if bank else None
        if not row or not row["is_bank"]:
            raise PostingError("Choose the bank account the money was paid from.")
        eid = bank_transaction(db, "spend", bank, paid_on,
                               [dict(account_id=l["account_id"], amount=l["amount"], tax_code_id=l["tax_code_id"],
                                     memo=l["memo"]) for l in lines],
                               payee=x["claimant"], reference=f"Claim {xid}",
                               memo=f"Expense claim {xid}: {x['claimant']}", tax_inclusive=True)
        db.execute("UPDATE expense_claims SET status='paid', pay_how='bank', entry_id=?, decided_by=?,"
                   " decided_at=datetime('now','localtime'), reason=NULL WHERE id=?", (eid, g.user["id"], xid))
        audit(db, "expense_claim_approved", f"#{xid} {x['claimant']} {fmt_money(x['amount'])} paid from bank")
        flash(f"Approved and paid: {fmt_money(x['amount'])} to {x['claimant']} from the bank.", "ok")
    else:
        raise ValueError("Choose how it's paid back: owed to them as a bill, or already paid from a bank account.")
    return redirect(url_for("expenses.view", xid=xid))
