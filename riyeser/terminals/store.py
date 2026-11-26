"""Every card terminal attempt, kept in the company file with its full status history.

An attempt is written (and committed) *before* the machine is asked for money, and again after every answer, so if
the till PC crashes mid-payment nothing is lost: on restart the Sell screen lists unfinished attempts and the
cashier checks the machine and resolves each one. One active (pending) attempt per till at a time; an approved
payment can be used by exactly one sale, an approved refund by exactly one refund (double-charge protection).
"""
import json
from datetime import datetime

from . import PROVIDERS, NONE, TerminalResult, TerminalUnavailable, FINAL, PENDING, APPROVED, CANCELLED, ERROR

KINDS = ("payment", "refund", "test")


class TerminalBusy(Exception):
    def __init__(self, txn):
        super().__init__("This till's card machine is still busy with another payment. Finish or cancel that first.")
        self.txn = txn


class TerminalError(Exception):
    pass


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def ensure_schema(db):
    """Additive only: new tables, one new column on pos_sales, and each older sale's single payment as a tender."""
    db.execute("""CREATE TABLE IF NOT EXISTS pos_terminal_settings (
        till_id INTEGER PRIMARY KEY REFERENCES pos_tills(id), provider TEXT NOT NULL DEFAULT 'none', config TEXT,
        updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_terminal_txns (
        id INTEGER PRIMARY KEY, till_id INTEGER REFERENCES pos_tills(id), provider TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'payment',          -- payment, refund, test
        status TEXT NOT NULL DEFAULT 'pending',        -- pending, approved, declined, cancelled, timeout, error
        amount INTEGER NOT NULL, currency TEXT NOT NULL, reference TEXT, checkout_ref TEXT,
        sale_id INTEGER REFERENCES pos_sales(id),      -- payment: the sale it paid; refund: the sale refunded
        refund_id INTEGER REFERENCES pos_refunds(id),  -- refund: the refund it paid back
        original_txn_id INTEGER REFERENCES pos_terminal_txns(id),
        payload TEXT,                                  -- the cart / refund lines, so a crash can be finished later
        provider_txn_id TEXT, provider_state TEXT,
        approved_amount INTEGER, tip INTEGER NOT NULL DEFAULT 0, cashout INTEGER NOT NULL DEFAULT 0,
        surcharge INTEGER NOT NULL DEFAULT 0, card_scheme TEXT, card_last4 TEXT, entry_mode TEXT, auth_code TEXT,
        terminal_ref TEXT, receipt_lines TEXT, message TEXT,
        resolution TEXT, extras_entry_id INTEGER REFERENCES journal_entries(id),
        user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT, finished_at TEXT)""")
    db.execute("CREATE INDEX IF NOT EXISTS pos_terminal_txns_till ON pos_terminal_txns(till_id, status)")
    db.execute("CREATE INDEX IF NOT EXISTS pos_terminal_txns_sale ON pos_terminal_txns(sale_id)")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_terminal_events (
        id INTEGER PRIMARY KEY, txn_id INTEGER NOT NULL REFERENCES pos_terminal_txns(id), status TEXT NOT NULL,
        note TEXT, user_id INTEGER REFERENCES users(id), at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_tenders (
        id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES pos_sales(id), method TEXT NOT NULL,
        amount INTEGER NOT NULL,                       -- what this tender paid of the sale
        tendered INTEGER NOT NULL DEFAULT 0, change_given INTEGER NOT NULL DEFAULT 0,
        payment_id INTEGER REFERENCES payments(id), terminal_txn_id INTEGER REFERENCES pos_terminal_txns(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("CREATE INDEX IF NOT EXISTS pos_tenders_sale ON pos_tenders(sale_id)")
    if "checkout_ref" not in {r["name"] for r in db.execute("PRAGMA table_info(pos_sales)")}:
        db.execute("ALTER TABLE pos_sales ADD COLUMN checkout_ref TEXT")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS pos_sales_checkout ON pos_sales(checkout_ref)"
               " WHERE checkout_ref IS NOT NULL")
    # sales made before split payments: their one payment becomes their one tender
    db.execute("INSERT INTO pos_tenders (sale_id, method, amount, tendered, change_given, payment_id, created_at)"
               " SELECT p.id, p.method, d.total, CASE WHEN p.method='cash' THEN p.tendered ELSE d.total END,"
               " CASE WHEN p.method='cash' THEN p.change_given ELSE 0 END, p.payment_id, p.created_at"
               " FROM pos_sales p JOIN documents d ON d.id=p.document_id"
               " WHERE d.total<>0 AND p.method IN ('cash','card')"
               " AND NOT EXISTS (SELECT 1 FROM pos_tenders t WHERE t.sale_id=p.id)")


# ------------------------------------------------------------ settings, per till
def setting(db, till_id):
    row = db.execute("SELECT * FROM pos_terminal_settings WHERE till_id=?", (till_id,)).fetchone() if till_id else None
    return row


def provider_for(db, till_id):
    """The card terminal this till uses. Not set: the practice terminal in a demo company, otherwise none."""
    if not till_id:
        return NONE
    row = setting(db, till_id)
    if row and (row["provider"] == NONE or (row["provider"] in PROVIDERS and PROVIDERS[row["provider"]].available)):
        return row["provider"]
    demo = db.execute("SELECT is_demo FROM company WHERE id=1").fetchone()
    return "practice" if demo and demo["is_demo"] else NONE


def save_setting(db, till_id, provider, user_id, config=None):
    if provider != NONE and (provider not in PROVIDERS or not PROVIDERS[provider].available):
        raise TerminalError("That card terminal isn't available yet.")
    db.execute("INSERT INTO pos_terminal_settings (till_id, provider, config, updated_by, updated_at)"
               " VALUES (?,?,?,?,?) ON CONFLICT(till_id) DO UPDATE SET provider=excluded.provider,"
               " config=COALESCE(excluded.config, config), updated_by=excluded.updated_by,"
               " updated_at=excluded.updated_at",
               (till_id, provider, json.dumps(config) if config is not None else None, user_id, _now()))


# ------------------------------------------------------------ attempts
def get(db, txn_id):
    return db.execute("SELECT * FROM pos_terminal_txns WHERE id=?", (txn_id,)).fetchone()


def event(db, txn_id, status, note, user_id=None):
    db.execute("INSERT INTO pos_terminal_events (txn_id, status, note, user_id, at) VALUES (?,?,?,?,?)",
               (txn_id, status, note, user_id, _now()))


def events(db, txn_id):
    return db.execute("SELECT * FROM pos_terminal_events WHERE txn_id=? ORDER BY id", (txn_id,)).fetchall()


def _adapter(db, row):
    cls = PROVIDERS.get(row["provider"])
    if not cls:
        raise TerminalUnavailable("This card terminal type isn't known.")
    s = setting(db, row["till_id"])
    cfg = json.loads(s["config"]) if s and s["config"] else {}
    return cls(cfg, json.loads(row["provider_state"]) if row["provider_state"] else {})


def _save_state(db, txn_id, adapter):
    db.execute("UPDATE pos_terminal_txns SET provider_state=?, updated_at=? WHERE id=?",
               (json.dumps(adapter.state), _now(), txn_id))


def pending_for_till(db, till_id):
    return db.execute("SELECT * FROM pos_terminal_txns WHERE till_id=? AND status='pending' ORDER BY id LIMIT 1",
                      (till_id,)).fetchone()


def start(db, till_id, kind, amount, user_id, currency="AUD", checkout_ref=None, payload=None, sale_id=None,
          original_txn_id=None):
    """Record the attempt (committed), then ask the machine. Returns the attempt row."""
    if kind not in KINDS:
        raise TerminalError("Unknown kind of card transaction.")
    provider = provider_for(db, till_id)
    if provider == NONE:
        raise TerminalError("This till has no card terminal set up. Choose one in POS setup, Card payments.")
    cls = PROVIDERS[provider]
    if not cls.available:
        raise TerminalUnavailable(f"{cls.name} is coming soon.")
    amount = int(amount)
    if amount <= 0:
        raise TerminalError("The card amount must be more than $0.00.")
    busy = pending_for_till(db, till_id)
    if busy:
        if checkout_ref and busy["checkout_ref"] == checkout_ref and busy["kind"] == kind \
                and busy["amount"] == amount:
            return busy  # the same request again (double tap, page retry): carry on with it
        raise TerminalBusy(busy)
    tid = db.execute("INSERT INTO pos_terminal_txns (till_id, provider, kind, amount, currency, checkout_ref, sale_id,"
                     " original_txn_id, payload, user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (till_id, provider, kind, amount, currency, checkout_ref, sale_id, original_txn_id,
                      json.dumps(payload) if payload is not None else None, user_id, _now(), _now())).lastrowid
    ref = f"RIY{tid:07d}"
    db.execute("UPDATE pos_terminal_txns SET reference=? WHERE id=?", (ref, tid))
    event(db, tid, PENDING, f"{kind.title()} of {amount / 100:,.2f} {currency} sent to {cls.name}", user_id)
    db.commit()  # written down before any money can move
    row = get(db, tid)
    a = _adapter(db, row)
    try:
        if kind == "refund":
            orig = get(db, original_txn_id) if original_txn_id else None
            pid = a.refund(orig["provider_txn_id"] if orig else None, amount, currency, ref)
        else:
            pid = a.start_payment(amount, currency, ref)
    except Exception as e:  # the machine couldn't be asked: nothing was charged
        apply(db, row, TerminalResult(status=ERROR, message=str(e) or "The card machine could not be reached."),
              user_id)
        db.commit()
        return get(db, tid)
    db.execute("UPDATE pos_terminal_txns SET provider_txn_id=? WHERE id=?", (pid, tid))
    _save_state(db, tid, a)
    db.commit()
    return get(db, tid)


def apply(db, row, result, user_id=None, note=None, resolution=None):
    """Record what the machine (or the cashier) reported. Final answers are never overwritten."""
    if row["status"] in FINAL:
        return get(db, row["id"])
    if result.status == PENDING:
        return row
    r = result
    approved = r.status == APPROVED
    amount = (r.amount or row["amount"]) if approved else None
    total = (r.total or (amount + r.tip + r.cashout + r.surcharge)) if approved else None
    db.execute("UPDATE pos_terminal_txns SET status=?, approved_amount=?, tip=?, cashout=?, surcharge=?, card_scheme=?,"
               " card_last4=?, entry_mode=?, auth_code=?, terminal_ref=?, provider_txn_id=COALESCE(NULLIF(?,''),"
               " provider_txn_id), receipt_lines=?, message=?, resolution=COALESCE(?, resolution), updated_at=?,"
               " finished_at=? WHERE id=? AND status='pending'",
               (r.status, total, r.tip if approved else 0, r.cashout if approved else 0,
                r.surcharge if approved else 0, r.card_scheme or None, (r.card_last4 or "")[-4:] or None,
                r.entry_mode or None, r.auth_code or None, r.terminal_ref or None, r.provider_txn_id,
                json.dumps(r.receipt_lines) if r.receipt_lines else None, r.message or None, resolution, _now(),
                _now(), row["id"]))
    if approved and amount != row["amount"]:  # a partial approval: the rest of the sale stays to pay
        db.execute("UPDATE pos_terminal_txns SET amount=? WHERE id=?", (amount, row["id"]))
    bits = [note or r.message or r.status]
    if approved:
        bits.append(f"charged {total / 100:,.2f}")
        if r.card_scheme or r.card_last4:
            bits.append(f"{r.card_scheme or 'card'} ..{(r.card_last4 or '')[-4:]}")
    event(db, row["id"], r.status, "; ".join(bits), user_id)
    payload = json.loads(row["payload"]) if row["payload"] else {}
    if approved and row["kind"] == "refund" and payload.get("orphan_of"):
        db.execute("UPDATE pos_terminal_txns SET resolution='refunded' WHERE id=?", (payload["orphan_of"],))
        event(db, payload["orphan_of"], APPROVED, f"Refunded to the card (attempt #{row['id']})", user_id)
    return get(db, row["id"])


def refresh(db, txn_id, user_id=None):
    """Ask the machine what happened (only while still pending)."""
    row = get(db, txn_id)
    if not row or row["status"] != PENDING:
        return row
    a = _adapter(db, row)
    try:
        res = a.status(row["provider_txn_id"])
    except TerminalUnavailable as e:
        res = TerminalResult(status=ERROR, message=str(e))
    _save_state(db, row["id"], a)
    row = apply(db, row, res, user_id)
    db.commit()
    return row


def cancel(db, txn_id, user_id=None):
    row = get(db, txn_id)
    if not row or row["status"] != PENDING:
        return row
    a = _adapter(db, row)
    a.cancel(row["provider_txn_id"])
    _save_state(db, row["id"], a)
    event(db, row["id"], PENDING, "Cancel asked for at the till", user_id)
    db.commit()
    return refresh(db, txn_id, user_id)


def practice(db, txn_id, action, user_id=None, **kw):
    row = get(db, txn_id)
    if not row or row["provider"] != "practice":
        raise TerminalError("That isn't a practice terminal payment.")
    if row["status"] != PENDING:
        return row
    a = _adapter(db, row)
    a.simulate(action, **kw)
    _save_state(db, row["id"], a)
    db.commit()
    return refresh(db, txn_id, user_id)


def manual(db, txn_id, approved, user_id=None, last4="", auth="", scheme="", ref=""):
    row = get(db, txn_id)
    if not row or row["provider"] != "manual":
        raise TerminalError("That isn't a manual card payment.")
    if row["status"] != PENDING:
        return row
    last4 = "".join(ch for ch in (last4 or "") if ch.isdigit())[-4:]
    a = _adapter(db, row)
    a.record(approved, last4=last4, auth=(auth or "").strip(), scheme=(scheme or "").strip()[:20],
             ref=(ref or "").strip())
    _save_state(db, row["id"], a)
    db.commit()
    return refresh(db, txn_id, user_id)


def resolve(db, txn_id, action, user_id=None, last4="", auth="", scheme=""):
    """After a crash or lost contact: the cashier checked the machine and says what it shows."""
    row = get(db, txn_id)
    if not row or row["status"] != PENDING:
        return row
    if action == "approved":
        last4 = "".join(ch for ch in (last4 or "") if ch.isdigit())[-4:]
        res = TerminalResult(status=APPROVED, amount=row["amount"], total=row["amount"], card_last4=last4,
                             auth_code=(auth or "").strip()[:12], card_scheme=(scheme or "").strip()[:20],
                             message="Cashier checked the card machine: approved")
        row = apply(db, row, res, user_id, resolution="cashier_confirmed")
    elif action == "not_charged":
        row = apply(db, row, TerminalResult(status=CANCELLED, message="Cashier checked the card machine: not charged"),
                    user_id, resolution="cashier_not_charged")
    else:
        raise TerminalError("Choose what the card machine shows.")
    db.commit()
    return row


def unresolved(db):
    """Attempts the cashier must deal with: still waiting, or approved but never put on a sale / refund."""
    return db.execute(
        "SELECT x.*, t.name till_name FROM pos_terminal_txns x LEFT JOIN pos_tills t ON t.id=x.till_id"
        " WHERE x.status='pending'"
        " OR (x.status='approved' AND x.kind='payment' AND x.sale_id IS NULL AND COALESCE(x.resolution,'')<>'refunded')"
        " OR (x.status='approved' AND x.kind='refund' AND x.refund_id IS NULL AND COALESCE(x.resolution,'')<>'refunded'"
        "     AND COALESCE(x.payload,'') NOT LIKE '%orphan_of%')"
        " ORDER BY x.id").fetchall()


def as_json(row, db=None):
    if not row:
        return None
    d = {k: row[k] for k in row.keys() if k not in ("provider_state",)}
    d["payload"] = json.loads(row["payload"]) if row["payload"] else None
    d["receipt_lines"] = json.loads(row["receipt_lines"]) if row["receipt_lines"] else []
    d["final"] = row["status"] in FINAL
    cls = PROVIDERS.get(row["provider"])
    d["provider_name"] = cls.name if cls else row["provider"]
    d["cashier_confirms"] = bool(cls and cls.cashier_confirms)
    if db is not None:
        d["history"] = [dict(at=e["at"], status=e["status"], note=e["note"]) for e in events(db, row["id"])]
    return d


# ------------------------------------------------------------ used by the till when it finalises
def claim_for_sale(db, txn_id, sale_id, checkout_ref):
    row = get(db, txn_id)
    if not row or row["kind"] != "payment" or row["status"] != APPROVED:
        raise TerminalError("That card payment wasn't approved.")
    if row["sale_id"]:
        raise TerminalError("That card payment is already on another sale.")
    if row["resolution"] == "refunded":
        raise TerminalError("That card payment was refunded to the card.")
    if row["checkout_ref"] and checkout_ref != row["checkout_ref"]:
        raise TerminalError("That card payment belongs to a different sale.")
    n = db.execute("UPDATE pos_terminal_txns SET sale_id=?, updated_at=? WHERE id=? AND sale_id IS NULL"
                   " AND status='approved'", (sale_id, _now(), txn_id)).rowcount
    if n != 1:
        raise TerminalError("That card payment is already on another sale.")
    event(db, txn_id, APPROVED, f"Put on sale #{sale_id}")
    return get(db, txn_id)


def claim_for_refund(db, txn_id, refund_id, sale_id, amount):
    row = get(db, txn_id)
    if not row or row["kind"] != "refund" or row["status"] != APPROVED or row["refund_id"]:
        raise TerminalError("That card refund wasn't approved, or it is already recorded.")
    if row["sale_id"] and row["sale_id"] != sale_id:
        raise TerminalError("That card refund belongs to a different sale.")
    if row["amount"] != amount:
        raise TerminalError(f"The card machine refunded {row['amount'] / 100:,.2f}, not {amount / 100:,.2f}.")
    n = db.execute("UPDATE pos_terminal_txns SET refund_id=?, updated_at=? WHERE id=? AND refund_id IS NULL",
                   (refund_id, _now(), txn_id)).rowcount
    if n != 1:
        raise TerminalError("That card refund is already recorded.")
    event(db, txn_id, APPROVED, f"Recorded as refund #{refund_id}")


def card_totals(pay_rows, refund_rows):
    """Close of day: approved terminal transactions by card scheme, to compare with the machine's settlement."""
    by = {}
    for r in pay_rows:
        s = by.setdefault(r["card_scheme"] or "Card (type not given)", dict(count=0, amount=0, refunds=0, refunded=0))
        s["count"] += 1
        s["amount"] += r["approved_amount"] or 0
    for r in refund_rows:
        s = by.setdefault(r["card_scheme"] or "Card (type not given)", dict(count=0, amount=0, refunds=0, refunded=0))
        s["refunds"] += 1
        s["refunded"] += r["approved_amount"] or 0
    schemes = [dict(scheme=k, net=v["amount"] - v["refunded"], **v) for k, v in sorted(by.items())]
    charged = sum(r["approved_amount"] or 0 for r in pay_rows)
    refunded = sum(r["approved_amount"] or 0 for r in refund_rows)
    return dict(schemes=schemes, count=len(pay_rows), charged=charged, refunded=refunded, net=charged - refunded,
                tips=sum(r["tip"] for r in pay_rows), cashout=sum(r["cashout"] for r in pay_rows),
                surcharge=sum(r["surcharge"] for r in pay_rows))
