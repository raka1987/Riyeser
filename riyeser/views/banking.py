"""Banking: money in and out, transfers, bank reconciliation, bank statement import."""
import json
from datetime import date

from flask import Blueprint, render_template, request, redirect, url_for, flash, abort

from ..db import get_db, to_cents, audit, linked, fmt_money, write_txn
from ..ledger import bank_transaction, transfer, balances, PostingError
from . import lookups, opt_int, form_lines, guarded, once

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
@once
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
@once
def _save_transfer():
    f = request.form
    eid = transfer(get_db(), int(f["from_id"]), int(f["to_id"]), f["date"], to_cents(f["amount"]), f.get("memo"))
    flash("Transfer recorded.", "ok")
    return redirect(url_for("core.entry", eid=eid))


# ------------------------------------------------------------------ reconciliation
RECONCILE_PAGE = 500
@bp.route("/reconcile", methods=["GET", "POST"])
def reconcile():
    db = get_db()
    if request.method == "POST":
        return _save_reconcile()
    lk = lookups(db)
    aid = opt_int(request.args.get("account")) or (lk["bank_accounts"][0]["id"] if lk["bank_accounts"] else None)
    stmt_date = request.args.get("date") or date.today().isoformat()
    lines, rec_bal, last, more = [], 0, None, 0
    if aid:
        rec_bal = db.execute("SELECT COALESCE(SUM(debit-credit),0) b FROM journal_lines WHERE account_id=?"
                             " AND reconciliation_id IS NOT NULL", (aid,)).fetchone()["b"]
        from ..perms import collapse_pay
        lines = collapse_pay(db.execute(
            "SELECT l.*, e.date, e.memo emo, e.reference, e.id eid, e.source_type, e.source_id FROM journal_lines l"
            " JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_id=? AND"
            " l.reconciliation_id IS NULL AND e.date<=? ORDER BY e.date, e.id LIMIT ?",
            (aid, stmt_date, RECONCILE_PAGE + 1)).fetchall())
        if len(lines) > RECONCILE_PAGE:  # S52: the oldest lines first, a page at a time
            lines = lines[:RECONCILE_PAGE]
            more = db.execute("SELECT COUNT(*) FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id"
                              " WHERE l.account_id=? AND l.reconciliation_id IS NULL AND e.date<=?",
                              (aid, stmt_date)).fetchone()[0]
        last = db.execute("SELECT * FROM reconciliations WHERE account_id=? ORDER BY id DESC LIMIT 1",
                          (aid,)).fetchone()
        seen = {r[0] for r in db.execute("SELECT line_id FROM bank_feed_lines WHERE account_id=? AND line_id IS NOT NULL",
                                         (aid,))}
        for l in lines:  # S24: lines on an imported statement come ticked
            l["on_statement"] = any(i in seen for i in l["ids"])
    return render_template("banking/reconcile.html", aid=aid, stmt_date=stmt_date, lines=lines, rec_bal=rec_bal,
                           last=last, more=more, page_size=RECONCILE_PAGE, **lk)


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
    ids = [int(x) for v in f.getlist("line") for x in v.split(",") if x.strip()]  # a pay run's line stands for several
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
    saved = db.execute("SELECT * FROM bank_import_maps WHERE account_id=?", (aid,)).fetchone()
    mapping = json.loads(saved["mapping"]) if saved else {}
    return render_template("banking/feed.html", aid=aid, rows=rows, matches={r["id"]: _suggest(db, r) for r in rows
                                                                            if not r["entry_id"]},
                           mapping=mapping, date_order=(saved["date_order"] if saved else None) or "dmy", **lk)


def _suggest(db, fl):
    """Transactions already in the books that look like this statement line (S24): same bank account and amount,
    within a week, not reconciled, not matched to another line."""
    from datetime import timedelta
    d = date.fromisoformat(fl["date"])
    return db.execute(
        "SELECT l.id, e.id eid, e.date, COALESCE(l.memo, e.memo) memo FROM journal_lines l"
        " JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_id=? AND l.debit-l.credit=? AND"
        " l.reconciliation_id IS NULL AND e.voided=0 AND e.date BETWEEN ? AND ? AND l.id NOT IN"
        " (SELECT line_id FROM bank_feed_lines WHERE line_id IS NOT NULL) ORDER BY ABS(julianday(e.date)-julianday(?))"
        " LIMIT 3", (fl["account_id"], fl["amount"], (d - timedelta(days=7)).isoformat(),
                     (d + timedelta(days=7)).isoformat(), fl["date"])).fetchall()


@guarded
def _import_feed():
    from .. import bank_import
    db = get_db()
    aid = int(request.form["account_id"])
    file = request.files.get("file")
    if not file or not file.filename:
        raise ValueError("Choose a CSV file.")
    text = file.read().decode("utf-8-sig", errors="replace")
    chosen = {role: opt_int(request.form.get(f"col_{role}")) for role in bank_import.ROLES}
    chosen = {k: v - 1 for k, v in chosen.items() if v}                     # the form counts columns from 1
    saved = db.execute("SELECT * FROM bank_import_maps WHERE account_id=?", (aid,)).fetchone()
    order = request.form.get("date_order") or (saved["date_order"] if saved else None) or "dmy"
    lines, skipped, used = bank_import.read(text, chosen, order, json.loads(saved["mapping"]) if saved else None)
    if lines:  # remembered for this bank account (S24)
        db.execute("INSERT OR REPLACE INTO bank_import_maps (account_id, mapping, date_order) VALUES (?,?,?)",
                   (aid, json.dumps(used), order))
    write_txn(db)
    # A line already imported (the same file again, or statements that overlap) is skipped; it's matched by count,
    # so two identical coffees on one day are two lines. Identical lines within this file are all kept and marked
    # for a look, never merged.
    key = lambda l: (l["date"], l["amount"], l["description"])
    in_file = {}
    for l in lines:
        in_file[key(l)] = in_file.get(key(l), 0) + 1
    had, seen = {}, {}
    n = dup = same = 0
    for l in lines:
        k = key(l)
        if k not in had:
            had[k] = db.execute("SELECT COUNT(*) FROM bank_feed_lines WHERE account_id=? AND date=? AND amount=? AND"
                                " COALESCE(description,'')=?", (aid,) + k).fetchone()[0]
        seen[k] = seen.get(k, 0) + 1
        if seen[k] <= had[k]:
            dup += 1
            continue
        note = "Looks the same as another line — check" if in_file[k] > 1 else None
        db.execute("INSERT INTO bank_feed_lines (account_id, date, description, amount, check_note) VALUES (?,?,?,?,?)",
                   (aid, l["date"], l["description"], l["amount"], note))
        n += 1
        same += bool(note)
    audit(db, "bank_import", f"{n} lines, {dup} already imported, {len(skipped)} skipped")
    flash(f"Imported {n} statement lines." + (f" {dup} were already imported, so they were skipped." if dup else ""),
          "ok" if n or dup else "error")
    if same:
        flash(f"{same} lines look the same as another line in this file (same date, amount and description). All "
              "are kept: check each against your statement before allocating it.", "warn")
    if skipped:
        flash("Not imported: " + "; ".join(f"row {r}: {why}" if r else why for r, why in skipped[:15])
              + (f"; and {len(skipped) - 15} more" if len(skipped) > 15 else "") + ".", "warn")
    return redirect(url_for("banking.feed", account=aid))


def _parse_date(s):
    from .. import bank_import
    return bank_import.parse_date(s)


@bp.route("/feed/<int:fid>/match", methods=["POST"])
@guarded
def feed_match(fid):
    """This statement line is a transaction already in the books (a payment, money in or out): link them."""
    db = get_db()
    write_txn(db)
    fl = db.execute("SELECT * FROM bank_feed_lines WHERE id=?", (fid,)).fetchone() or abort(404)
    if fl["entry_id"]:
        raise ValueError("Already allocated.")
    lid = opt_int(request.form.get("line_id"))
    if lid not in {m["id"] for m in _suggest(db, fl)}:
        raise ValueError("That transaction doesn't match this statement line.")
    eid = db.execute("SELECT entry_id FROM journal_lines WHERE id=?", (lid,)).fetchone()[0]
    db.execute("UPDATE bank_feed_lines SET entry_id=?, line_id=? WHERE id=?", (eid, lid, fid))
    flash("Matched: nothing new was posted, and it's ticked on Reconcile.", "ok")
    return redirect(url_for("banking.feed", account=fl["account_id"]))


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
    line = db.execute("SELECT id FROM journal_lines WHERE entry_id=? AND account_id=?", (eid, fl["account_id"])).fetchone()
    db.execute("UPDATE bank_feed_lines SET entry_id=?, line_id=? WHERE id=?", (eid, line["id"] if line else None, fid))
    flash("Statement line allocated.", "ok")
    return redirect(url_for("banking.feed", account=fl["account_id"]))


@bp.route("/feed/<int:fid>/delete", methods=["POST"])
@guarded
def feed_delete(fid):
    db = get_db()
    fl = db.execute("SELECT * FROM bank_feed_lines WHERE id=?", (fid,)).fetchone()
    db.execute("DELETE FROM bank_feed_lines WHERE id=? AND entry_id IS NULL", (fid,))
    return redirect(url_for("banking.feed", account=fl["account_id"]))
