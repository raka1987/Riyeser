"""Banking: money in and out, transfers, bank reconciliation, bank statement import."""
import csv
import io
from datetime import date

from flask import Blueprint, render_template, request, redirect, url_for, flash, abort

from ..db import get_db, to_cents, audit, linked, fmt_money, write_txn
from ..ledger import bank_transaction, transfer, balances, PostingError
from . import lookups, opt_int, form_lines, guarded

bp = Blueprint("banking", __name__, url_prefix="/banking")


@bp.route("/")
def index():
    db = get_db()
    bal = balances(db)
    banks = db.execute("SELECT * FROM accounts WHERE is_bank=1 AND active=1 ORDER BY code").fetchall()
    unrec = {r["account_id"]: r["n"] for r in db.execute(
        "SELECT account_id, COUNT(*) n FROM journal_lines WHERE reconciliation_id IS NULL GROUP BY account_id")}
    feed = {r["account_id"]: r["n"] for r in db.execute(
        "SELECT account_id, COUNT(*) n FROM bank_feed_lines WHERE entry_id IS NULL GROUP BY account_id")}
    recent = db.execute("SELECT e.*, (SELECT SUM(debit) FROM journal_lines WHERE entry_id=e.id) amt"
                        " FROM journal_entries e WHERE source_type IN ('spend','receive','transfer')"
                        " ORDER BY e.date DESC, e.id DESC LIMIT 25").fetchall()
    return render_template("banking/index.html", banks=banks, bal=bal, unrec=unrec, feed=feed, recent=recent)


@bp.route("/<kind>", methods=["GET", "POST"])
def money(kind):
    if kind not in ("spend", "receive"):
        return redirect(url_for("banking.index"))
    db = get_db()
    if request.method == "POST":
        return _save_money(kind)
    side = "supplier" if kind == "spend" else "customer"
    contacts = db.execute("SELECT * FROM contacts WHERE active=1 ORDER BY name").fetchall()
    return render_template("banking/money.html", kind=kind, contacts=contacts, side=side,
                           default_bank=linked(db, "default_bank"), **lookups(db))


@guarded
def _save_money(kind):
    db = get_db()
    f = request.form
    lines = [dict(account_id=opt_int(l["account"]), amount=to_cents(l["amount"]), tax_code_id=opt_int(l["tax"]),
                  job_id=opt_int(l["job"]), memo=l["memo"])
             for l in form_lines(["account", "amount", "tax", "job", "memo"]) if l["account"] and l["amount"]]
    cid = opt_int(f.get("contact_id"))
    payee = f.get("payee") or (db.execute("SELECT name FROM contacts WHERE id=?", (cid,)).fetchone()["name"]
                               if cid else "")
    eid = bank_transaction(db, kind, int(f["bank_account_id"]), f["date"], lines, payee=payee,
                           reference=f.get("reference"), memo=f.get("memo") or None, contact_id=cid,
                           tax_inclusive=bool(f.get("tax_inclusive")))
    feed_id = opt_int(f.get("feed_id"))
    if feed_id:
        db.execute("UPDATE bank_feed_lines SET entry_id=? WHERE id=?", (eid, feed_id))
    flash(f"{'Spend' if kind == 'spend' else 'Receive'} money #{eid} recorded.", "ok")
    return redirect(url_for("core.entry", eid=eid))


@bp.route("/transfer", methods=["GET", "POST"])
def transfer_money():
    db = get_db()
    if request.method == "POST":
        return _save_transfer()
    return render_template("banking/transfer.html", **lookups(db))


@guarded
def _save_transfer():
    f = request.form
    eid = transfer(get_db(), int(f["from_id"]), int(f["to_id"]), f["date"], to_cents(f["amount"]), f.get("memo"))
    flash("Transfer recorded.", "ok")
    return redirect(url_for("core.entry", eid=eid))


# ------------------------------------------------------------------ reconciliation
@bp.route("/reconcile", methods=["GET", "POST"])
def reconcile():
    db = get_db()
    if request.method == "POST":
        return _save_reconcile()
    lk = lookups(db)
    aid = opt_int(request.args.get("account")) or (lk["bank_accounts"][0]["id"] if lk["bank_accounts"] else None)
    stmt_date = request.args.get("date") or date.today().isoformat()
    lines, rec_bal, last = [], 0, None
    if aid:
        rec_bal = db.execute("SELECT COALESCE(SUM(debit-credit),0) b FROM journal_lines WHERE account_id=?"
                             " AND reconciliation_id IS NOT NULL", (aid,)).fetchone()["b"]
        lines = db.execute("SELECT l.*, e.date, e.memo emo, e.reference, e.id eid FROM journal_lines l"
                           " JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_id=? AND"
                           " l.reconciliation_id IS NULL AND e.date<=? ORDER BY e.date, e.id",
                           (aid, stmt_date)).fetchall()
        last = db.execute("SELECT * FROM reconciliations WHERE account_id=? ORDER BY id DESC LIMIT 1",
                          (aid,)).fetchone()
    return render_template("banking/reconcile.html", aid=aid, stmt_date=stmt_date, lines=lines, rec_bal=rec_bal,
                           last=last, **lk)


@guarded
def _save_reconcile():
    db = get_db()
    f = request.form
    aid = int(f["account_id"])
    if f.get("undo"):
        last = db.execute("SELECT * FROM reconciliations WHERE account_id=? ORDER BY id DESC LIMIT 1",
                          (aid,)).fetchone()
        if last:
            db.execute("UPDATE journal_lines SET reconciliation_id=NULL WHERE reconciliation_id=?", (last["id"],))
            db.execute("DELETE FROM reconciliations WHERE id=?", (last["id"],))
            audit(db, "undo_reconcile", str(last["id"]))
            flash("Last reconciliation undone.", "ok")
        return redirect(url_for("banking.reconcile", account=aid))
    ids = [int(x) for x in f.getlist("line")]
    stmt = to_cents(f["statement_balance"])
    rec_bal = db.execute("SELECT COALESCE(SUM(debit-credit),0) b FROM journal_lines WHERE account_id=?"
                         " AND reconciliation_id IS NOT NULL", (aid,)).fetchone()["b"]
    acct = db.execute("SELECT type FROM accounts WHERE id=?", (aid,)).fetchone()
    sel = 0
    if ids:
        q = ",".join("?" * len(ids))
        sel = db.execute(f"SELECT COALESCE(SUM(debit-credit),0) b FROM journal_lines WHERE id IN ({q})"
                         " AND account_id=? AND reconciliation_id IS NULL", ids + [aid]).fetchone()["b"]
    calc = rec_bal + sel
    if acct["type"] == "liability":  # credit cards: statement shows amount owed
        calc = -calc
    if calc != stmt:
        raise PostingError(f"Out of balance by {fmt_money(stmt - calc)} "
                           f"(calculated {fmt_money(calc)} vs statement {fmt_money(stmt)}).")
    rid = db.execute("INSERT INTO reconciliations (account_id, statement_date, statement_balance) VALUES (?,?,?)",
                     (aid, f["statement_date"], stmt)).lastrowid
    if ids:
        db.execute(f"UPDATE journal_lines SET reconciliation_id=? WHERE id IN ({q}) AND account_id=?",
                   [rid] + ids + [aid])
    audit(db, "reconcile", f"account {aid} to {f['statement_date']}")
    flash(f"Reconciled {len(ids)} transactions.", "ok")
    return redirect(url_for("banking.reconcile", account=aid))


# ------------------------------------------------------------------ bank statement import
@bp.route("/feed", methods=["GET", "POST"])
def feed():
    db = get_db()
    if request.method == "POST":
        return _import_feed()
    lk = lookups(db)
    aid = opt_int(request.args.get("account")) or (lk["bank_accounts"][0]["id"] if lk["bank_accounts"] else None)
    rows = db.execute("SELECT * FROM bank_feed_lines WHERE account_id=? ORDER BY (entry_id IS NOT NULL), date",
                      (aid,)).fetchall()
    return render_template("banking/feed.html", aid=aid, rows=rows, **lk)


@guarded
def _import_feed():
    db = get_db()
    aid = int(request.form["account_id"])
    file = request.files.get("file")
    if not file or not file.filename:
        raise ValueError("Choose a CSV file.")
    text = file.read().decode("utf-8-sig")
    n = 0
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 3:
            continue
        d, desc, amt = row[0].strip(), row[1].strip(), row[2].strip()
        try:
            cents = to_cents(amt)
        except ValueError:
            continue  # header row
        d = _parse_date(d)
        if not d:
            continue
        db.execute("INSERT INTO bank_feed_lines (account_id, date, description, amount) VALUES (?,?,?,?)",
                   (aid, d, desc, cents))
        n += 1
    audit(db, "bank_import", f"{n} lines")
    flash(f"Imported {n} statement lines.", "ok")
    return redirect(url_for("banking.feed", account=aid))


def _parse_date(s):
    from datetime import datetime
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None


@bp.route("/feed/<int:fid>/allocate", methods=["POST"])
@guarded
def allocate(fid):
    db = get_db()
    write_txn(db)  # two people allocating the same line: only the first one posts
    fl = db.execute("SELECT * FROM bank_feed_lines WHERE id=?", (fid,)).fetchone()
    if not fl:
        abort(404)
    if fl["entry_id"]:
        raise ValueError("Already allocated.")
    acct = opt_int(request.form.get("account_id"))
    if not acct:
        raise ValueError("Choose the account to allocate this line to.")
    kind = "receive" if fl["amount"] > 0 else "spend"
    eid = bank_transaction(db, kind, fl["account_id"], fl["date"],
                           [dict(account_id=acct, amount=abs(fl["amount"]),
                                 tax_code_id=opt_int(request.form.get("tax_code_id")))],
                           payee=fl["description"], memo=fl["description"])
    db.execute("UPDATE bank_feed_lines SET entry_id=? WHERE id=?", (eid, fid))
    flash("Statement line allocated.", "ok")
    return redirect(url_for("banking.feed", account=fl["account_id"]))


@bp.route("/feed/<int:fid>/delete", methods=["POST"])
@guarded
def feed_delete(fid):
    db = get_db()
    fl = db.execute("SELECT * FROM bank_feed_lines WHERE id=?", (fid,)).fetchone()
    db.execute("DELETE FROM bank_feed_lines WHERE id=? AND entry_id IS NULL", (fid,))
    return redirect(url_for("banking.feed", account=fl["account_id"]))
