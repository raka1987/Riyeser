"""Riyeser POS: a basic point of sale.

Each sale becomes an ordinary tax invoice (prices include GST) that is paid at once,
so stock, the cash drawer / bank, GST and every report stay in step automatically.
"""
import json
from datetime import date, datetime, timedelta

from werkzeug.security import check_password_hash, generate_password_hash

from flask import Blueprint, render_template, request, redirect, url_for, flash, jsonify, abort, g, current_app

from ..db import get_db, linked, round_cents, audit, to_cents
from ..ledger import save_document, record_payment, void_payment, void_document, post_entry, stock_in, tax_code, \
    PostingError
from . import guarded, opt_int
from .. import perms

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

# What each kind of business can switch on. Retail never sees tables or the kitchen, so it can't be set up wrong.
MODES = {
    "retail": dict(name="Retail", blurb="Shops: clothing, hardware, gifts, homewares. No tables or kitchen.", features=[
        ("scan", "Barcode scanning", "Scan a barcode to add the item straight to the sale"),
        ("stock", "Show stock on tiles", "“Only 2 left” and sold-out labels"),
        ("sku", "Show product codes", "The SKU under each product"),
        ("hold", "Hold sales", "Put a sale aside and come back to it"),
        ("customer", "Choose a customer", "Pick a customer card for the sale"),
        ("discount", "Discounts", "Give a % discount on an item"),
        ("notes", "Item notes", "A short note on an item, e.g. size or colour"),
    ]),
    "restaurant": dict(name="Restaurant", blurb="Cafes, restaurants, takeaway: tables and kitchen dockets.", features=[
        ("tables", "Tables (dine-in)", "Seat customers at a table and run their bill"),
        ("kitchen", "Send to kitchen", "Print a docket for the kitchen"),
        ("takeaway", "Takeaway orders", "Orders that are taken away"),
        ("notes", "Item options & notes", "e.g. oat milk, no onions, extra hot"),
        ("customer", "Choose a customer", "Pick a customer card for the order"),
        ("discount", "Discounts", "Give a % discount on an item"),
        ("stock", "Show stock on tiles", "“Only 2 left” and sold-out labels"),
    ]),
}
DEFAULT_ON = {"retail": {"scan", "stock", "sku", "hold", "customer", "discount", "notes"},
              "restaurant": {"tables", "kitchen", "takeaway", "notes", "customer", "discount"}}


def pos_config(db):
    """The business type and the switches that are on, limited to what that type allows."""
    c = db.execute("SELECT pos_mode, pos_features FROM company WHERE id=1").fetchone()
    mode = c["pos_mode"] if c["pos_mode"] in MODES else "retail"
    allowed = {k for k, _, _ in MODES[mode]["features"]}
    try:
        saved = json.loads(c["pos_features"]) if c["pos_features"] else None
    except ValueError:
        saved = None
    on = set(saved.get(mode, [])) if isinstance(saved, dict) and mode in saved else DEFAULT_ON[mode]
    return mode, on & allowed


# ------------------------------------------------------------ 90-day free trial, then a licence (see riyeser/plan.py)
def plan(db):
    from .. import plan as P
    return P.plan(db, "pos")


@bp.app_template_global()
def pos_free_plan():
    """For the till's banner: trial days left, or a licence (None outside a company)."""
    try:
        return plan(get_db())
    except Exception:
        return None


def _tills(db):
    return db.execute("SELECT * FROM pos_tills WHERE active=1 ORDER BY id").fetchall()


# ------------------------------------------------------------ manager approvals (PIN or manager card)
APPROVAL_DEFAULTS = {"method": "either", "discount": True, "discount_limit": 10, "close": True, "close_limit": 200}
METHOD_NAMES = {"pin": "PIN only", "either": "Card or PIN", "both": "Card + PIN"}
REASONS = {
    "void": ["Wrong item", "Customer changed mind", "Duplicate sale", "Price error", "Training / test sale", "Other"],
    "refund": ["Faulty item", "Customer changed mind", "Wrong item", "Price error", "Other"],
    "discount": ["Damaged item", "Staff discount", "Price match", "Loyal customer", "Other"],
    "close": ["Gave wrong change", "Paid out from the till", "Counting error", "Unknown"],
}
APPROVAL_TTL = timedelta(minutes=10)
MAX_FAILS = 3


def approval_rules(db):
    raw = db.execute("SELECT pos_approval_rules FROM company WHERE id=1").fetchone()[0]
    rules = dict(APPROVAL_DEFAULTS)
    try:
        rules.update(json.loads(raw) if raw else {})
    except ValueError:
        pass
    if rules["method"] not in METHOD_NAMES:
        rules["method"] = "either"
    return rules


def approvers(db):
    """People who can approve: anyone with Full access to Sales (the same people who may void)."""
    return [u for u in db.execute("SELECT * FROM users WHERE active=1 ORDER BY full_name, username")
            if perms.level("sales", u) >= perms.FULL]


def self_approves(user=None):
    return perms.level("sales", user) >= perms.FULL


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _fails(db, uid):
    since = (datetime.now() - timedelta(minutes=5)).strftime("%Y-%m-%d %H:%M:%S")
    return db.execute("SELECT COUNT(*) FROM pos_auth_fails WHERE user_id=? AND at>=?", (uid, since)).fetchone()[0]


def _find_approver(db, rules, pin, card):
    """Who is approving, from what they typed or scanned. Raises with a plain message if it doesn't match."""
    people = approvers(db)
    pin, card = (pin or "").strip(), (card or "").strip()
    who = None
    if card and rules["method"] in ("either", "both"):
        who = next((u for u in people if u["pos_card_hash"] and check_password_hash(u["pos_card_hash"], card)), None)
        if not who:
            raise PostingError("That card isn't a manager card (or it has been disabled).")
        if rules["method"] == "both":
            if not pin or not (who["pos_pin_hash"] and check_password_hash(who["pos_pin_hash"], pin)):
                raise PostingError("Wrong PIN for that card.")
        return who, "card + PIN" if rules["method"] == "both" else "card"
    if rules["method"] == "both":
        raise PostingError("Scan the manager card, then type the PIN.")
    if not pin:
        raise PostingError("Type the manager PIN" + (" or scan a manager card." if rules["method"] == "either" else "."))
    who = next((u for u in people if u["pos_pin_hash"] and check_password_hash(u["pos_pin_hash"], pin)), None)
    if not who:
        raise PostingError("Wrong PIN.")
    return who, "PIN"


def use_approval(db, approval_id, action, ref=None, min_amount=None):
    """Spend a one-time approval made for this exact action, by this user, in the last few minutes."""
    a = db.execute("SELECT * FROM pos_approvals WHERE id=?", (opt_int(approval_id) or 0,)).fetchone()
    fresh = a and datetime.strptime(a["created_at"], "%Y-%m-%d %H:%M:%S") >= datetime.now() - APPROVAL_TTL
    if not a or a["used_at"] or not fresh or a["action"] != action or a["requested_by"] != g.user["id"] \
            or (ref is not None and a["ref"] != str(ref)) or (min_amount is not None and a["amount"] < min_amount):
        raise PostingError("This needs a manager's approval. Please ask a manager.")
    db.execute("UPDATE pos_approvals SET used_at=? WHERE id=?", (_now(), a["id"]))
    return a


def self_approval(db, action, ref, amount, reason):
    """An owner/manager doing it themselves: still recorded in the override log."""
    return db.execute("INSERT INTO pos_approvals (action, ref, amount, reason, requested_by, approved_by, method,"
                      " used_at) VALUES (?,?,?,?,?,?,'self',?)", (action, str(ref), amount, reason, g.user["id"],
                                                                  g.user["id"], _now())).lastrowid


@bp.route("/approve", methods=["POST"])
def approve():
    """Check a manager PIN / card for one action. Returns a one-time approval the action then uses."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    action = d.get("action")
    try:
        if action not in REASONS:
            raise PostingError("Unknown action.")
        reason = str(d.get("reason") or "").strip()[:120]
        if not reason:
            raise PostingError("Choose a reason.")
        if _fails(db, g.user["id"]) >= MAX_FAILS:
            raise PostingError("Too many wrong tries. Wait 5 minutes, then try again.")
        rules = approval_rules(db)
        if self_approves():
            who, method = g.user, "self"
        else:
            try:
                who, method = _find_approver(db, rules, d.get("pin"), d.get("card"))
            except PostingError as e:
                db.execute("INSERT INTO pos_auth_fails (user_id) VALUES (?)", (g.user["id"],))
                db.commit()
                left = MAX_FAILS - _fails(db, g.user["id"])
                raise PostingError(f"{e} {left} tr{'y' if left == 1 else 'ies'} left." if left > 0 else
                                   f"{e} Too many wrong tries. Wait 5 minutes.")
        aid = db.execute("INSERT INTO pos_approvals (action, ref, amount, reason, requested_by, approved_by, method,"
                         " till_id) VALUES (?,?,?,?,?,?,?,?)",
                         (action, str(d.get("ref") or ""), int(d.get("amount") or 0), reason, g.user["id"], who["id"],
                          method, opt_int(d.get("till_id")))).lastrowid
        audit(db, "pos_approval", f"{action} {d.get('ref') or ''} by {who['full_name'] or who['username']} ({method}): {reason}")
        db.commit()
    except (PostingError, ValueError, TypeError) as e:
        db.rollback()
        return jsonify(ok=False, error=str(e)), 400
    return jsonify(ok=True, approval_id=aid, approver=who["full_name"] or who["username"], method=method)


@bp.route("/approvals", methods=["GET", "POST"])
def approvals():
    """Admin page: how managers approve, what needs approval, PINs and manager cards, and the override log."""
    db = get_db()
    can_change = perms.can("setup", perms.FULL)
    if request.method == "POST":
        if not can_change:
            flash("Only an owner or administrator can change manager approvals.", "error")
            return redirect(url_for("pos.approvals"))
        f = request.form
        try:
            msg = _save_approvals(db, f)
            db.commit()
            flash(msg, "ok")
        except (PostingError, ValueError) as e:
            db.rollback()
            flash(str(e), "error")
        return redirect(url_for("pos.approvals"))
    log = db.execute("SELECT a.*, r.full_name rname, r.username runame, m.full_name mname, m.username muname"
                     " FROM pos_approvals a LEFT JOIN users r ON r.id=a.requested_by LEFT JOIN users m ON"
                     " m.id=a.approved_by ORDER BY a.id DESC LIMIT 60").fetchall()
    return render_template("pos/approvals.html", rules=approval_rules(db), methods=METHOD_NAMES,
                           people=approvers(db), log=log, can_change=can_change)


def _save_approvals(db, f):
    if f.get("what") == "rules":
        rules = approval_rules(db)
        rules.update(method=f.get("method") if f.get("method") in METHOD_NAMES else "either",
                     discount=bool(f.get("discount")), close=bool(f.get("close")),
                     discount_limit=min(max(int(float(f.get("discount_limit") or 10)), 0), 100),
                     close_limit=max(to_cents(f.get("close_limit") or "2"), 0))
        db.execute("UPDATE company SET pos_approval_rules=? WHERE id=1", (json.dumps(rules),))
        audit(db, "pos_approval_rules", json.dumps(rules))
        return "Manager approval settings saved."
    uid = opt_int(f.get("user_id"))
    person = next((u for u in approvers(db) if u["id"] == uid), None)
    if not person:
        raise PostingError("Only people with Full access to Sales can be managers.")
    name = person["full_name"] or person["username"]
    others = [u for u in approvers(db) if u["id"] != uid]
    if f.get("what") == "pin":
        pin = (f.get("pin") or "").strip()
        if not (pin.isdigit() and 4 <= len(pin) <= 6):
            raise PostingError("A PIN is 4 to 6 numbers.")
        if any(u["pos_pin_hash"] and check_password_hash(u["pos_pin_hash"], pin) for u in others):
            raise PostingError("Another manager already uses that PIN. Choose a different one.")
        db.execute("UPDATE users SET pos_pin_hash=? WHERE id=?", (generate_password_hash(pin), uid))
        audit(db, "pos_pin_set", name)
        return f"PIN saved for {name}."
    if f.get("what") == "card":
        code = (f.get("card") or "").strip()
        if len(code) < 4:
            raise PostingError("Scan the card into the box (or type the number printed on it).")
        if any(u["pos_card_hash"] and check_password_hash(u["pos_card_hash"], code) for u in others):
            raise PostingError("That card already belongs to another manager.")
        db.execute("UPDATE users SET pos_card_hash=?, pos_card_last4=? WHERE id=?",
                   (generate_password_hash(code), code[-4:], uid))
        audit(db, "pos_card_set", name)
        return f"Manager card registered for {name}."
    if f.get("what") == "card_off":
        db.execute("UPDATE users SET pos_card_hash=NULL, pos_card_last4=NULL WHERE id=?", (uid,))
        audit(db, "pos_card_disabled", name)
        return f"{name}'s manager card is disabled. It won't work any more."
    if f.get("what") == "pin_off":
        db.execute("UPDATE users SET pos_pin_hash=NULL WHERE id=?", (uid,))
        audit(db, "pos_pin_removed", name)
        return f"{name}'s PIN is removed."
    raise PostingError("Nothing to save.")


def approval_ctx(db):
    """What the till screens need to show the approval popup."""
    rules = approval_rules(db)
    return dict(rules=rules, reasons=REASONS, self_ok=self_approves(),
                has_card=any(u["pos_card_hash"] for u in approvers(db)))


# ------------------------------------------------------------ opening and closing the till (shifts)
DENOMS = [10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5]


def open_shift(db, till_id):
    return db.execute("SELECT * FROM pos_shifts WHERE till_id=? AND status='open' ORDER BY id DESC LIMIT 1",
                      (till_id,)).fetchone()


def shift_figures(db, sh):
    """Everything the X / Z report needs for one shift."""
    sales = db.execute("SELECT p.*, d.total, d.tax_total FROM pos_sales p JOIN documents d ON d.id=p.document_id"
                       " WHERE p.shift_id=?", (sh["id"],)).fetchall()
    live = [r for r in sales if not r["voided"]]
    voids = [r for r in sales if r["voided"]]
    refunds = db.execute("SELECT * FROM pos_refunds WHERE shift_id=?", (sh["id"],)).fetchall()
    cash = sum(r["total"] for r in live if r["method"] == "cash")
    card = sum(r["total"] for r in live if r["method"] == "card")
    ref_cash = sum(r["amount"] for r in refunds if r["method"] == "cash")
    ref_card = sum(r["amount"] for r in refunds if r["method"] == "card")
    disc = db.execute("SELECT COALESCE(SUM(ROUND(l.qty*l.unit_price*l.discount_pct/100.0)),0) FROM pos_sales p"
                      " JOIN document_lines l ON l.document_id=p.document_id WHERE p.shift_id=? AND p.voided=0",
                      (sh["id"],)).fetchone()[0]
    return dict(count=len(live), total=cash + card, cash=cash, card=card, gst=sum(r["tax_total"] for r in live)
                - sum(r["tax"] for r in refunds), voids=len(voids), void_total=sum(r["total"] for r in voids),
                refunds=len(refunds), refund_cash=ref_cash, refund_card=ref_card, discounts=int(disc),
                float=sh["float_amount"], expected=sh["float_amount"] + cash - ref_cash,
                card_net=card - ref_card)


@bp.route("/shift/open", methods=["POST"])
def shift_open():
    db = get_db()
    d = request.get_json(silent=True) or request.form
    till = opt_int(d.get("till_id"))
    if not till or not db.execute("SELECT 1 FROM pos_tills WHERE id=? AND active=1", (till,)).fetchone():
        return jsonify(ok=False, error="Choose a till."), 400
    if open_shift(db, till):
        return jsonify(ok=True)
    amt = to_cents(d.get("float") or "0")
    if amt < 0:
        return jsonify(ok=False, error="The float can't be negative."), 400
    db.execute("INSERT INTO pos_shifts (till_id, opened_by, float_amount) VALUES (?,?,?)", (till, g.user["id"], amt))
    name = db.execute("SELECT name FROM pos_tills WHERE id=?", (till,)).fetchone()[0]
    audit(db, "pos_till_open", f"{name} float {amt / 100:.2f}")
    db.commit()
    return jsonify(ok=True)


def _last_float(db, till):
    r = db.execute("SELECT float_amount FROM pos_shifts WHERE till_id=? ORDER BY id DESC LIMIT 1", (till,)).fetchone()
    return r[0] if r else 20000


@bp.route("/close", methods=["GET", "POST"])
def close_till():
    db = get_db()
    tills = _tills(db)
    till = opt_int(request.values.get("till")) or (tills[0]["id"] if tills else None)
    sh = open_shift(db, till) if till else None
    if request.method == "POST":
        if not sh:
            flash("That till isn't open.", "error")
            return redirect(url_for("pos.close_till", till=till))
        try:
            sid = _close(db, sh, request.form)
            db.commit()
        except (PostingError, ValueError) as e:
            db.rollback()
            flash(str(e), "error")
            return redirect(url_for("pos.close_till", till=till))
        flash("Till closed. The Z-report is ready to print.", "ok")
        return redirect(url_for("pos.shift_report", shid=sid, done=1))
    mode, features = pos_config(db)
    history = db.execute("SELECT s.*, t.name till_name, u.full_name, u.username FROM pos_shifts s JOIN pos_tills t"
                         " ON t.id=s.till_id LEFT JOIN users u ON u.id=s.closed_by WHERE s.status='closed'"
                         " ORDER BY s.id DESC LIMIT 10").fetchall()
    banks = db.execute("SELECT id, code, name FROM accounts WHERE is_bank=1 AND active=1 AND id<>? ORDER BY code",
                       (linked(db, "pos_cash"),)).fetchall()
    return render_template("pos/close.html", mode=mode, features=sorted(features), tills=tills, till=till,
                           shift=sh, fig=shift_figures(db, sh) if sh else None, denoms=DENOMS, history=history,
                           banks=banks, default_bank=linked(db, "default_bank"), active="close",
                           opener=db.execute("SELECT full_name, username FROM users WHERE id=?",
                                             (sh["opened_by"],)).fetchone() if sh else None,
                           **approval_ctx(db))


def _close(db, sh, f):
    counts = {}
    for d in DENOMS:
        n = f.get(f"n{d}") or "0"
        if not n.isdigit():
            raise PostingError("Counts must be whole numbers.")
        counts[d] = int(n)
    counted = sum(d * n for d, n in counts.items())
    fig = shift_figures(db, sh)
    variance = counted - fig["expected"]
    rules = approval_rules(db)
    reason = (f.get("reason") or "").strip()[:120]
    approval_id = None
    if abs(variance) > rules["close_limit"]:
        if not reason:
            raise PostingError(f"The drawer is out by {abs(variance) / 100:.2f}. Choose a reason.")
        if rules["close"]:
            if self_approves():
                approval_id = self_approval(db, "close", sh["id"], variance, reason)
            else:
                approval_id = use_approval(db, f.get("approval_id"), "close", sh["id"])["id"]
    today = date.today().isoformat()
    till = db.execute("SELECT name FROM pos_tills WHERE id=?", (sh["till_id"],)).fetchone()["name"]
    cash_acct = linked(db, "pos_cash")
    if variance:
        post_entry(db, today, f"{till} close: drawer {'over' if variance > 0 else 'short'}", "pos_close",
                   [dict(account_id=cash_acct, debit=variance), dict(account_id=linked(db, "cash_over_short"),
                                                                     credit=variance)], source_id=sh["id"])
    deposit = counted - sh["float_amount"]
    bank = opt_int(f.get("bank_id"))
    if f.get("bank_it") and deposit > 0:
        if not bank or bank == cash_acct:
            raise PostingError("Choose the bank account the cash goes to.")
        post_entry(db, today, f"{till} takings banked", "pos_close",
                   [dict(account_id=bank, debit=deposit), dict(account_id=cash_acct, credit=deposit)],
                   source_id=sh["id"])
    else:
        bank = None
    settle = (f.get("card_settlement") or "").strip()
    fig.update(counted=counted, variance=variance)
    db.execute("UPDATE pos_shifts SET status='closed', closed_by=?, closed_at=?, counts=?, counted=?, expected=?,"
               " variance=?, card_settlement=?, reason=?, approval_id=?, deposit=?, deposit_account_id=?, summary=?"
               " WHERE id=?", (g.user["id"], _now(), json.dumps(counts), counted, fig["expected"], variance,
                               to_cents(settle) if settle else None, reason or None, approval_id,
                               deposit if bank else 0, bank, json.dumps(fig), sh["id"]))
    audit(db, "pos_till_close", f"{till}: counted {counted / 100:.2f}, expected {fig['expected'] / 100:.2f}")
    return sh["id"]


@bp.route("/shift/<int:shid>")
def shift_report(shid):
    """X-read (till still open) or Z-report (closed), on 80mm paper."""
    db = get_db()
    sh = db.execute("SELECT s.*, t.name till_name FROM pos_shifts s JOIN pos_tills t ON t.id=s.till_id WHERE s.id=?",
                    (shid,)).fetchone()
    if not sh:
        abort(404)
    fig = json.loads(sh["summary"]) if sh["summary"] else shift_figures(db, sh)
    users = {u["id"]: u["full_name"] or u["username"] for u in db.execute("SELECT id, full_name, username FROM users")}
    appr = db.execute("SELECT * FROM pos_approvals WHERE id=?", (sh["approval_id"],)).fetchone() \
        if sh["approval_id"] else None
    bank = db.execute("SELECT name FROM accounts WHERE id=?", (sh["deposit_account_id"],)).fetchone() \
        if sh["deposit_account_id"] else None
    return render_template("pos/shift.html", sh=sh, fig=fig, users=users, appr=appr, bank=bank,
                           counts=sorted(((int(k), v) for k, v in json.loads(sh["counts"]).items()), reverse=True)
                           if sh["counts"] else [], now=_now())


def tile_labels(rows):
    """M5: the letters on tiles without a photo are different for every item: initials, else the item code."""
    def initials(n):
        return "".join(w[0] for w in n.split() if w[:1].isalnum())[:2].upper() or n[:2].upper()
    count = {}
    for r in rows:
        count[initials(r["name"])] = count.get(initials(r["name"]), 0) + 1
    out, used = {}, set()
    for r in rows:
        t = initials(r["name"])
        if count[t] > 1:
            t = (r["sku"] or t)[:5].upper()
        base, n = t, 2
        while t in used:
            t, n = f"{base[:4]}{n}", n + 1
        used.add(t)
        out[r["id"]] = t
    return out


BIG_QTY = 1000          # M28: more than this of one item, or
BIG_CHANGE = 1000_00    # more than $1,000 change, is checked first


def _items(db):
    rows = db.execute("SELECT i.*, t.rate, (SELECT 1 FROM item_photos p WHERE p.item_id=i.id) has_photo"
                      " FROM items i LEFT JOIN tax_codes t ON t.id=i.sale_tax_code_id"
                      " WHERE i.active=1 AND i.is_sold=1 ORDER BY COALESCE(i.category,'~'), i.name").fetchall()
    cats = sorted({r["category"] for r in rows if r["category"]})
    tiles = tile_labels(rows)
    color = {c: PALETTE[i % len(PALETTE)] for i, c in enumerate(cats)}
    return [dict(id=r["id"], sku=r["sku"], name=r["name"], price=_price_inc(r, r["rate"]), rate=r["rate"] or 0,
                 tile=tiles[r["id"]], barcodes=[b.strip().lower() for b in (r["barcodes"] or "").split(",") if b.strip()],
                 cat=r["category"] or "Other", color=color.get(r["category"], "#475467"),
                 fav=bool(r["pos_favourite"]), photo=bool(r["has_photo"]),
                 stock=r["qty_on_hand"] if r["is_inventoried"] else None) for r in rows], cats


@bp.route("/")
def register():
    db = get_db()
    items, cats = _items(db)
    mode, features = pos_config(db)
    customers = db.execute("SELECT id, name FROM contacts WHERE kind='customer' AND active=1 ORDER BY name").fetchall()
    tills = _tills(db)
    shifts = {t["id"]: bool(open_shift(db, t["id"])) for t in tills}
    floats = {t["id"]: _last_float(db, t["id"]) for t in tills}
    low = 0
    if _sees_low_stock():
        low = db.execute("SELECT COUNT(*) FROM items WHERE is_inventoried=1 AND active=1 AND is_sold=1"
                         " AND qty_on_hand<=reorder_level").fetchone()[0]
    return render_template("pos/front.html", items_json=json.dumps(items), cats=cats, customers=customers, low_count=low,
                           walk_in=WALK_IN, methods=METHODS, mode=mode, features=sorted(features),
                           tills=tills, shifts=shifts, floats=floats, **approval_ctx(db))


@bp.route("/photo/<int:iid>")
def photo(iid):
    row = get_db().execute("SELECT mime, data FROM item_photos WHERE item_id=?", (iid,)).fetchone()
    if not row:
        abort(404)
    return current_app.response_class(row["data"], mimetype=row["mime"],
                                      headers={"Cache-Control": "private, max-age=300"})


@bp.route("/setup", methods=["GET", "POST"])
def setup():
    db = get_db()
    if request.method == "POST":
        if not perms.can("setup", perms.FULL):
            flash("Only an owner or administrator can change how the till is set up.", "error")
            return redirect(url_for("pos.setup"))
        f = request.form
        mode = f.get("mode") if f.get("mode") in MODES else "retail"
        allowed = {k for k, _, _ in MODES[mode]["features"]}
        try:
            saved = json.loads(db.execute("SELECT pos_features FROM company WHERE id=1").fetchone()[0] or "{}")
            saved = saved if isinstance(saved, dict) else {}
        except ValueError:
            saved = {}
        if f.get("mode_changed") == "1":
            on = DEFAULT_ON[mode]  # a new business type starts from its sensible defaults
        else:
            on = {k for k in f.getlist("feature") if k in allowed}
        saved[mode] = sorted(on)
        db.execute("UPDATE company SET pos_mode=?, pos_features=? WHERE id=1", (mode, json.dumps(saved)))
        for t in _tills(db):
            name = (f.get(f"till_name_{t['id']}") or "").strip()[:40]
            if f.get(f"till_remove_{t['id']}") and len(_tills(db)) > 1:
                db.execute("UPDATE pos_tills SET active=0 WHERE id=?", (t["id"],))
            elif name:
                db.execute("UPDATE pos_tills SET name=?, location=? WHERE id=?",
                           (name, (f.get(f"till_loc_{t['id']}") or "").strip()[:60] or None, t["id"]))
        if (f.get("new_till") or "").strip():
            db.execute("INSERT INTO pos_tills (name, location) VALUES (?,?)",
                       (f["new_till"].strip()[:40], (f.get("new_till_loc") or "").strip()[:60] or None))
        audit(db, "pos_setup", f"{mode}: {', '.join(sorted(on)) or 'no extras'}")
        db.commit()
        flash(f"POS setup saved: {MODES[mode]['name']}." if f.get("mode_changed") != "1" else
              f"Switched to {MODES[mode]['name']}. Sensible features are on; adjust them below.", "ok")
        return redirect(url_for("pos.setup"))
    mode, on = pos_config(db)
    return render_template("pos/setup.html", modes=MODES, mode=mode, on=on, tills=_tills(db),
                           can_change=perms.can("setup", perms.FULL))


@bp.route("/mode", methods=["POST"])
def set_mode():
    db = get_db()
    mode = request.form.get("mode")
    if mode in MODES and perms.can("setup", perms.FULL):
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
    if plan(db)["locked"]:
        from ..plan import capped_message
        return jsonify(ok=False, error=capped_message("pos")), 402
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
        from ..ledger import check_stock, StockShort
        try:
            check_stock(db, lines, bool(data.get("sell_anyway")))  # S25
        except StockShort as e:
            return jsonify(ok=False, error=str(e), confirm_stock=e.confirm,
                           confirm_key="sell_anyway" if e.confirm else None), 409
        big = max(l["qty"] for l in lines)
        if big > BIG_QTY and not data.get("confirm_big"):
            return jsonify(ok=False, error=f"{big:g} of one item is a lot. Is that right?", confirm_key="confirm_big"), 409
        # A discount above the limit needs a manager (owners and managers approve their own).
        rules = approval_rules(db)
        top = max(l["discount_pct"] for l in lines)
        discount_approval = None
        if rules["discount"] and top > rules["discount_limit"]:
            if self_approves():
                discount_approval = self_approval(db, "discount", "sale", round(top), "Discount at the till")
            else:
                discount_approval = use_approval(db, data.get("approval_id"), "discount", min_amount=round(top))["id"]
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
        if method == "cash" and tendered - total > BIG_CHANGE and not data.get("confirm_big"):
            db.rollback()
            return jsonify(ok=False, error=f"Change of ${(tendered - total) / 100:,.2f}? Check the cash tendered.",
                           confirm_key="confirm_big"), 409
        acct = linked(db, "pos_cash" if method == "cash" else "pos_card")
        if total == 0:  # M28: a free item (staff meal, giveaway) with a reason; nothing to pay
            why = str(data.get("reason") or "").strip()[:120]
            if not why:
                db.rollback()
                return jsonify(ok=False, error="A $0 sale needs a reason (for example staff meal or giveaway).",
                               reason_key="reason"), 409
            db.execute("UPDATE documents SET status='paid', notes=TRIM(COALESCE(notes,'') || ' Free: ' || ?) WHERE id=?",
                       (why, doc_id))
            pid = None
        else:
            pid = record_payment(db, "in", cid, acct, today, [(doc_id, total)], reference="POS",
                                 memo=f"POS {METHODS[method]}")
        till = opt_int(data.get("till_id"))
        if till and not db.execute("SELECT 1 FROM pos_tills WHERE id=? AND active=1", (till,)).fetchone():
            till = None
        shift = open_shift(db, till) if till else None
        sid = db.execute("INSERT INTO pos_sales (document_id, payment_id, method, tendered, change_given, user_id,"
                         " till_id, shift_id) VALUES (?,?,?,?,?,?,?,?)",
                         (doc_id, pid, method, tendered, tendered - total, g.user["id"], till,
                          shift["id"] if shift else None)).lastrowid
        if discount_approval:
            db.execute("UPDATE pos_approvals SET ref=? WHERE id=?", (f"sale {sid}", discount_approval))
        oid = opt_int(data.get("order_id"))
        if oid:
            db.execute("UPDATE pos_orders SET status='paid', sale_id=?, updated_at=datetime('now','localtime')"
                       " WHERE id=? AND status='open'", (sid, oid))
        audit(db, "pos_sale", f"#{sid} {method}")
        db.commit()
    except (PostingError, ValueError, KeyError, TypeError) as e:
        db.rollback()
        return jsonify(ok=False, error=str(e) or "Could not complete the sale."), 400
    from .reorder import low_after_sale
    low = low_after_sale(db, [l["item_id"] for l in lines]) if _sees_low_stock() else []  # a warning, never a block
    return jsonify(ok=True, sale_id=sid, total=total, change=tendered - total, low_stock=low,
                   receipt_url=url_for("pos.receipt", sid=sid))


def _sees_low_stock():
    """Managers (who can approve at the till) and people who look after stock see the low-stock warnings."""
    return self_approves() or perms.can("stock", perms.EDIT)


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
    rows = db.execute("SELECT p.*, d.number, d.total, d.tax_total, c.name cname, t.name till_name FROM pos_sales p"
                      " JOIN documents d ON d.id=p.document_id JOIN contacts c ON c.id=d.contact_id"
                      " LEFT JOIN pos_tills t ON t.id=p.till_id WHERE d.date=? ORDER BY p.id DESC", (day,)).fetchall()
    live = [r for r in rows if not r["voided"]]
    refunds = db.execute("SELECT r.*, d.number FROM pos_refunds r JOIN pos_sales p ON p.id=r.sale_id"
                         " JOIN documents d ON d.id=p.document_id WHERE substr(r.created_at,1,10)=?"
                         " ORDER BY r.id DESC", (day,)).fetchall()
    refunded = {}
    for r in db.execute("SELECT sale_id, SUM(amount) a FROM pos_refunds GROUP BY sale_id"):
        refunded[r["sale_id"]] = r["a"]
    by_method = {m: sum(r["total"] for r in live if r["method"] == m)
                 - sum(r["amount"] for r in refunds if r["method"] == m) for m in METHODS}
    return dict(rows=rows, count=len(live), total=sum(r["total"] for r in live) - sum(r["amount"] for r in refunds),
                gst=sum(r["tax_total"] for r in live) - sum(r["tax"] for r in refunds), by_method=by_method,
                cash_out=sum(r["change_given"] for r in live if r["method"] == "cash"), refunds=refunds,
                refunded=refunded)


def day_extras(db, day):
    """Sales by hour and best sellers for the Today screen (voided sales left out)."""
    hours = {}
    for r in db.execute("SELECT substr(p.created_at, 12, 2) h, SUM(d.total) t FROM pos_sales p"
                        " JOIN documents d ON d.id=p.document_id WHERE d.date=? AND p.voided=0 GROUP BY h", (day,)):
        hours[int(r["h"])] = r["t"]
    best = db.execute("SELECT i.id, i.name, i.category, SUM(l.qty) qty, SUM(l.net_amount + l.tax_amount) amt,"
                      " (SELECT 1 FROM item_photos ph WHERE ph.item_id=i.id) photo"
                      " FROM pos_sales p JOIN documents d ON d.id=p.document_id"
                      " JOIN document_lines l ON l.document_id=d.id JOIN items i ON i.id=l.item_id"
                      " WHERE d.date=? AND p.voided=0 GROUP BY i.id ORDER BY amt DESC LIMIT 5", (day,)).fetchall()
    open_orders = db.execute("SELECT COUNT(*) FROM pos_orders WHERE status='open'").fetchone()[0]
    return dict(hours=hours, best=best, open_orders=open_orders)


@bp.route("/sales")
def sales():
    db = get_db()
    day = request.args.get("date") or date.today().isoformat()
    mode, features = pos_config(db)
    try:
        d = date.fromisoformat(day)
        day_label = f"{d:%A} {d.day} {d:%B %Y}"
    except ValueError:
        abort(404)
    return render_template("pos/sales.html", day=day, day_label=day_label, methods=METHODS, mode=mode,
                           features=sorted(features),
                           tills=_tills(db), **day_summary(db, day), **day_extras(db, day), **approval_ctx(db))


@bp.route("/sale/<int:sid>/void", methods=["POST"])
@guarded
def void(sid):
    """Void a whole sale. Staff need a manager's approval; owners and managers approve their own."""
    db = get_db()
    s = _sale(db, sid)
    if s["voided"]:
        raise PostingError("This sale is already voided.")
    if db.execute("SELECT 1 FROM pos_refunds WHERE sale_id=?", (sid,)).fetchone():
        raise PostingError("Part of this sale was refunded, so it can't be voided. Refund the rest instead.")
    reason = (request.form.get("reason") or "").strip()[:120]
    if self_approves():
        self_approval(db, "void", sid, s["total"], reason or "Voided by manager")
    else:
        reason = use_approval(db, request.form.get("approval_id"), "void", sid)["reason"]
    if s["payment_id"]:  # a free sale (M28) has no payment
        void_payment(db, s["payment_id"])
    void_document(db, s["document_id"])
    db.execute("UPDATE pos_sales SET voided=1 WHERE id=?", (sid,))
    audit(db, "pos_void", f"#{sid}: {reason}")
    flash(f"Sale {s['number']} voided: stock returned and the takings reversed.", "ok")
    return redirect(url_for("pos.sales", date=s["date"]))


def _refundable(db, s):
    """Each line of a sale with how many can still be refunded."""
    done = {}
    for r in db.execute("SELECT lines FROM pos_refunds WHERE sale_id=?", (s["id"],)):
        for lid, q in json.loads(r["lines"]).items():
            done[int(lid)] = done.get(int(lid), 0) + q
    out = []
    for l in db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (s["document_id"],)):
        left = l["qty"] - done.get(l["id"], 0)
        out.append(dict(id=l["id"], description=l["description"], qty=l["qty"], left=left,
                        each=round((l["net_amount"] + l["tax_amount"]) / l["qty"]) if l["qty"] else 0))
    return out


@bp.route("/sale/<int:sid>/lines")
def sale_lines(sid):
    db = get_db()
    s = _sale(db, sid)
    return jsonify(number=s["number"], method=s["method"], voided=bool(s["voided"]), lines=_refundable(db, s))


@bp.route("/sale/<int:sid>/refund", methods=["POST"])
def refund(sid):
    """Refund some or all items of a sale: income, GST and stock are reversed, money goes back out."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    try:
        s = _sale(db, sid)
        if s["voided"]:
            raise PostingError("This sale was voided, so there is nothing to refund.")
        method = d.get("method") if d.get("method") in METHODS else s["method"]
        want = {int(k): float(v) for k, v in (d.get("lines") or {}).items() if float(v or 0) > 0}
        if not want:
            raise PostingError("Choose what to refund.")
        lines = {l["id"]: l for l in db.execute("SELECT * FROM document_lines WHERE document_id=?",
                                                (s["document_id"],))}
        left = {l["id"]: l["left"] for l in _refundable(db, s)}
        jl, total, tax, stock = [], 0, 0, []
        for lid, q in want.items():
            l = lines.get(lid)
            if not l or q > left.get(lid, 0) + 1e-9:
                raise PostingError("You can't refund more than was sold.")
            net, t = round(l["net_amount"] * q / l["qty"]), round(l["tax_amount"] * q / l["qty"])
            jl.append(dict(account_id=l["account_id"], debit=net, tax_code_id=l["tax_code_id"],
                           memo=f"Refund {l['description']}"))
            if t:
                tc = tax_code(db, l["tax_code_id"])
                jl.append(dict(account_id=(tc["collected_account_id"] if tc else None) or linked(db, "gst_collected"),
                               debit=t, memo="GST refund"))
            total, tax = total + net + t, tax + t
            if l["item_id"]:
                stock.append((l, q))
        reason = str(d.get("reason") or "").strip()[:120]
        if self_approves():
            appr = self_approval(db, "refund", sid, total, reason or "Refund by manager")
        else:
            a = use_approval(db, d.get("approval_id"), "refund", sid)
            appr, reason = a["id"], a["reason"]
        today = date.today().isoformat()
        jl.append(dict(account_id=linked(db, "pos_cash" if method == "cash" else "pos_card"), credit=total,
                       memo=f"Refund {s['number']}"))
        eid = post_entry(db, today, f"POS refund {s['number']}", "pos_refund", jl, reference=s["number"],
                         contact_id=db.execute("SELECT contact_id FROM documents WHERE id=?",
                                               (s["document_id"],)).fetchone()[0])
        for l, q in stock:
            item = db.execute("SELECT * FROM items WHERE id=?", (l["item_id"],)).fetchone()
            if not item["is_inventoried"]:
                continue
            mv = db.execute("SELECT unit_cost FROM stock_movements WHERE source_type='invoice' AND source_id=? AND"
                            " item_id=? ORDER BY id LIMIT 1", (s["document_id"], item["id"])).fetchone()
            cost = mv["unit_cost"] if mv else item["avg_cost"]
            stock_in(db, item["id"], q, cost, today, "pos_refund", eid, f"Refund {s['number']}")
            amt = round_cents(cost * q)
            if amt:
                for acct, dr, cr in ((item["asset_account_id"] or linked(db, "inventory"), amt, 0),
                                     (item["expense_account_id"] or linked(db, "cogs"), 0, amt)):
                    db.execute("INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo) VALUES"
                               " (?,?,?,?,?)", (eid, acct, dr, cr, f"Refund stock {item['sku']}"))
        till = opt_int(d.get("till_id"))
        shift = open_shift(db, till) if till else None
        rid = db.execute("INSERT INTO pos_refunds (sale_id, entry_id, method, amount, tax, lines, reason, user_id,"
                         " approval_id, shift_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (sid, eid, method, total, tax, json.dumps({str(k): v for k, v in want.items()}), reason,
                          g.user["id"], appr, shift["id"] if shift else None)).lastrowid
        audit(db, "pos_refund", f"{s['number']} {total / 100:.2f} {method}: {reason}")
        db.commit()
    except (PostingError, ValueError, TypeError) as e:
        db.rollback()
        return jsonify(ok=False, error=str(e)), 400
    return jsonify(ok=True, refund_id=rid, amount=total)
