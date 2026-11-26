"""Card payments (EFTPOS) on the till: start an attempt on the card terminal, follow it, cancel it, record what the
cashier saw (manual machines, and after a crash), the practice terminal's pretend buttons, and the setup screen.

The till never finalises a sale from here: once an attempt is approved the till sends it with the sale
(riyeser/views/pos.py, sale), which claims it exactly once.
"""
from datetime import datetime

from flask import request, jsonify, render_template, redirect, url_for, flash, g

from ..db import get_db, audit, to_cents
from ..ledger import PostingError
from ..terminals import store as T, choices, PROVIDERS, NONE, SCHEMES, ENTRY_MODES, STATUS_WORDS
from . import opt_int
from .. import perms
from .pos import bp, _tills, self_approves, APPROVAL_TTL, use_approval, card_ctx


def _currency(db):
    return db.execute("SELECT currency FROM company WHERE id=1").fetchone()[0] or "AUD"


def _err(msg, code=400, **kw):
    return jsonify(ok=False, error=msg, **kw), code


def _ok(db, row):
    return jsonify(ok=True, txn=T.as_json(row, db))


def _approval_ok(db, approval_id, ref):
    """A fresh, unused refund approval for this sale, by this user (spent later, when the refund is recorded)."""
    a = db.execute("SELECT * FROM pos_approvals WHERE id=?", (opt_int(approval_id) or 0,)).fetchone()
    fresh = a and datetime.strptime(a["created_at"], "%Y-%m-%d %H:%M:%S") >= datetime.now() - APPROVAL_TTL
    return bool(a and fresh and not a["used_at"] and a["action"] == "refund" and a["ref"] == str(ref)
                and a["requested_by"] == g.user["id"])


def _card_left(db, sid):
    paid = db.execute("SELECT COALESCE(SUM(amount),0) FROM pos_tenders WHERE sale_id=? AND method='card'",
                      (sid,)).fetchone()[0]
    back = db.execute("SELECT COALESCE(SUM(amount),0) FROM pos_refunds WHERE sale_id=? AND method='card'",
                      (sid,)).fetchone()[0]
    return paid - back


@bp.route("/terminal/start", methods=["POST"])
def terminal_start():
    """Ask this till's card machine to take (or refund) an amount. Returns the attempt to follow."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    till = opt_int(d.get("till_id"))
    kind = d.get("kind") or "payment"
    if not till or not db.execute("SELECT 1 FROM pos_tills WHERE id=? AND active=1", (till,)).fetchone():
        return _err("Choose a till.")
    try:
        amount = int(d.get("amount") or 0)
        payload, sale_id, original = d.get("payload"), None, None
        if kind == "payment":
            from .pos import plan
            if plan(db)["locked"]:
                from ..plan import capped_message
                return _err(capped_message("pos"), 402)
            if not d.get("checkout_ref"):
                raise PostingError("Start the payment from the till.")
        elif kind == "test":
            if not perms.can("setup", perms.FULL):
                raise PostingError("Only an owner or administrator can run a test payment.")
            amount = 100
        elif kind == "refund":
            if d.get("orphan_of"):  # a card payment whose sale was never finished: give the money back
                orig = T.get(db, opt_int(d["orphan_of"]))
                if not orig or orig["kind"] != "payment" or orig["status"] != "approved" or orig["sale_id"] \
                        or orig["resolution"] == "refunded":
                    raise PostingError("That card payment can't be refunded from here.")
                if not self_approves():
                    use_approval(db, d.get("approval_id"), "refund", f"card {orig['id']}")
                amount, original, payload = orig["approved_amount"], orig["id"], {"orphan_of": orig["id"]}
            else:
                sale_id = opt_int(d.get("sale_id"))
                if not sale_id or not db.execute("SELECT 1 FROM pos_sales WHERE id=? AND voided=0",
                                                 (sale_id,)).fetchone():
                    raise PostingError("Choose the sale to refund.")
                if not self_approves() and not _approval_ok(db, d.get("approval_id"), sale_id):
                    raise PostingError("This needs a manager's approval. Please ask a manager.")
                if amount > _card_left(db, sale_id):
                    raise PostingError("That's more than was paid by card on this sale.")
                o = db.execute("SELECT id FROM pos_terminal_txns WHERE sale_id=? AND kind='payment' AND"
                               " status='approved' ORDER BY id LIMIT 1", (sale_id,)).fetchone()
                original = o["id"] if o else None
        else:
            raise PostingError("Unknown kind of card transaction.")
        row = T.start(db, till, kind, amount, g.user["id"], currency=_currency(db),
                      checkout_ref=str(d.get("checkout_ref") or "")[:64] or None, payload=payload,
                      sale_id=sale_id, original_txn_id=original)
        audit(db, "pos_card_" + kind, f"#{row['id']} {amount / 100:.2f} {row['provider']}")
        db.commit()
    except T.TerminalBusy as e:
        db.rollback()
        return _err(str(e), 409, busy=T.as_json(e.txn, db))
    except (PostingError, T.TerminalError, T.TerminalUnavailable, ValueError, TypeError) as e:
        db.rollback()
        return _err(str(e) or "Could not start the card payment.")
    return _ok(db, row)


@bp.route("/terminal/<int:tid>")
def terminal_status(tid):
    db = get_db()
    row = T.refresh(db, tid, g.user["id"])
    return _ok(db, row) if row else _err("Not found.", 404)


@bp.route("/terminal/<int:tid>/cancel", methods=["POST"])
def terminal_cancel(tid):
    db = get_db()
    try:
        row = T.cancel(db, tid, g.user["id"])
    except T.TerminalUnavailable as e:
        return _err(str(e))
    return _ok(db, row) if row else _err("Not found.", 404)


@bp.route("/terminal/<int:tid>/practice", methods=["POST"])
def terminal_practice(tid):
    """The pretend machine's buttons."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    try:
        row = T.practice(db, tid, d.get("action"), g.user["id"], tip=to_cents(d.get("tip") or "0"),
                         cashout=to_cents(d.get("cashout") or "0"), scheme=d.get("scheme") or "Visa",
                         entry=d.get("entry") or "tap", last4=d.get("last4") or None)
    except (T.TerminalError, ValueError) as e:
        return _err(str(e))
    return _ok(db, row)


@bp.route("/terminal/<int:tid>/manual", methods=["POST"])
def terminal_manual(tid):
    """Manual machine: the cashier says what their machine showed."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    try:
        row = T.manual(db, tid, d.get("result") == "approved", g.user["id"], last4=d.get("last4") or "",
                       auth=d.get("auth") or "", scheme=d.get("scheme") or "", ref=d.get("ref") or "")
    except T.TerminalError as e:
        return _err(str(e))
    return _ok(db, row)


@bp.route("/terminal/<int:tid>/resolve", methods=["POST"])
def terminal_resolve(tid):
    """After a crash or lost contact: the cashier checked the card machine."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    try:
        row = T.resolve(db, tid, d.get("action"), g.user["id"], last4=d.get("last4") or "", auth=d.get("auth") or "",
                        scheme=d.get("scheme") or "")
        audit(db, "pos_card_resolve", f"#{tid} {d.get('action')}")
        db.commit()
    except T.TerminalError as e:
        return _err(str(e))
    return _ok(db, row)


@bp.route("/terminal/unresolved")
def terminal_unresolved():
    return jsonify(card_ctx(get_db())["unresolved"])


@bp.route("/terminal/practice")
def practice_machine():
    """The practice terminal on its own screen (a second tablet or window can act as the customer's machine)."""
    db = get_db()
    till = opt_int(request.args.get("till"))
    if request.args.get("poll"):
        row = T.pending_for_till(db, till) if till else None
        return jsonify(txn=T.as_json(row) if row and row["provider"] == "practice" else None)
    return render_template("pos/practice.html", tills=_tills(db), till=till, schemes=SCHEMES)


@bp.route("/card-payments", methods=["GET", "POST"])
def card_setup():
    """POS setup, Card payments: which card terminal each till uses, a test payment, and the recent attempts."""
    db = get_db()
    can_change = perms.can("setup", perms.FULL)
    tills = _tills(db)
    if request.method == "POST":
        if not can_change:
            flash("Only an owner or administrator can change card payments.", "error")
            return redirect(url_for("pos.card_setup"))
        try:
            for t in tills:
                p = request.form.get(f"provider_{t['id']}")
                if p is None:
                    continue
                if p != NONE and (p not in PROVIDERS or not PROVIDERS[p].available):
                    raise T.TerminalError(f"{PROVIDERS[p].name if p in PROVIDERS else p} isn't available yet.")
                T.save_setting(db, t["id"], p, g.user["id"])
                audit(db, "pos_card_setup", f"{t['name']}: {p}")
            db.commit()
            flash("Card payments saved.", "ok")
        except T.TerminalError as e:
            db.rollback()
            flash(str(e), "error")
        return redirect(url_for("pos.card_setup"))
    current = {t["id"]: T.provider_for(db, t["id"]) for t in tills}
    saved = {t["id"]: bool(T.setting(db, t["id"])) for t in tills}
    recent = db.execute("SELECT x.*, t.name till_name FROM pos_terminal_txns x LEFT JOIN pos_tills t ON"
                        " t.id=x.till_id ORDER BY x.id DESC LIMIT 25").fetchall()
    history = {r["id"]: T.events(db, r["id"]) for r in recent}
    demo = db.execute("SELECT is_demo FROM company WHERE id=1").fetchone()[0]
    return render_template("pos/card_setup.html", tills=tills, providers=choices(), current=current, saved=saved,
                           recent=recent, history=history, can_change=can_change, demo=demo,
                           words=STATUS_WORDS, card_payments=card_ctx(db), schemes=SCHEMES,
                           entry_modes=ENTRY_MODES)
