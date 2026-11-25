"""Core double-entry posting engine and business transactions.

Every business event (invoice, bill, payment, money out, pay run, stock
adjustment...) is turned into a balanced journal entry here.  Reports read
only from journal_lines, so the books always reconcile.
"""
from collections import defaultdict
from datetime import date as _date, timedelta

from flask import g

from .db import linked, audit, round_cents, fmt_money, write_txn


class PostingError(ValueError):
    pass


# ======================================================================= core
def check_lock(db, d):
    row = db.execute("SELECT lock_date FROM company WHERE id=1").fetchone()
    if row and row["lock_date"] and d <= row["lock_date"]:
        raise PostingError(f"Period is locked up to {row['lock_date']}; cannot post on {d}.")


def post_entry(db, date, memo, source_type, lines, source_id=None, reference=None, contact_id=None,
               reverses_id=None):
    """lines: list of dicts with account_id, debit, credit and optional tax_code_id, job_id, memo."""
    if not date:
        raise PostingError("A date is required.")
    check_lock(db, date)
    lines = [l for l in lines if (l.get("debit") or 0) or (l.get("credit") or 0)]
    if not lines:
        raise PostingError("Transaction has no amounts.")
    for l in lines:
        if (l.get("debit") or 0) < 0 or (l.get("credit") or 0) < 0:
            # normalise negative amounts onto the opposite side
            d, c = l.get("debit") or 0, l.get("credit") or 0
            net = d - c
            l["debit"], l["credit"] = (net, 0) if net > 0 else (0, -net)
        if not l.get("account_id"):
            raise PostingError("Every line needs an account.")
    dr = sum(l.get("debit") or 0 for l in lines)
    cr = sum(l.get("credit") or 0 for l in lines)
    if dr != cr:
        raise PostingError(f"Out of balance: debits {fmt_money(dr)} vs credits {fmt_money(cr)}.")
    user = getattr(g, "user", None)
    cur = db.execute(
        "INSERT INTO journal_entries (date, memo, reference, source_type, source_id, contact_id, reverses_id, created_by)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (date, memo, reference, source_type, source_id, contact_id, reverses_id, user["id"] if user else None))
    entry_id = cur.lastrowid
    for l in lines:
        db.execute(
            "INSERT INTO journal_lines (entry_id, account_id, debit, credit, tax_code_id, job_id, memo)"
            " VALUES (?,?,?,?,?,?,?)",
            (entry_id, l["account_id"], l.get("debit") or 0, l.get("credit") or 0,
             l.get("tax_code_id"), l.get("job_id"), l.get("memo")))
    return entry_id


def reverse_entry(db, entry_id, date=None, memo=None):
    e = db.execute("SELECT * FROM journal_entries WHERE id=?", (entry_id,)).fetchone()
    if not e:
        raise PostingError("Entry not found.")
    if e["voided"]:
        raise PostingError("Entry is already reversed.")
    lines = db.execute("SELECT * FROM journal_lines WHERE entry_id=?", (entry_id,)).fetchall()
    for l in lines:
        if l["reconciliation_id"]:
            raise PostingError("Entry contains reconciled bank lines; un-reconcile first.")
    rev = [dict(account_id=l["account_id"], debit=l["credit"], credit=l["debit"], tax_code_id=l["tax_code_id"],
                job_id=l["job_id"], memo=l["memo"]) for l in lines]
    rid = post_entry(db, date or e["date"], memo or f"Reversal of #{entry_id}: {e['memo'] or ''}", "reversal", rev,
                     source_id=e["source_id"], reference=e["reference"], contact_id=e["contact_id"],
                     reverses_id=entry_id)
    db.execute("UPDATE journal_entries SET voided=1 WHERE id IN (?,?)", (entry_id, rid))
    return rid


def tax_code(db, tid):
    if not tid:
        return None
    return db.execute("SELECT * FROM tax_codes WHERE id=?", (tid,)).fetchone()


def calc_line(qty, unit_price, discount_pct, rate, tax_inclusive):
    """Return (net_cents, tax_cents) for a document line."""
    gross = round_cents(float(qty) * unit_price * (1 - (discount_pct or 0) / 100.0))
    if not rate:
        return gross, 0
    if tax_inclusive:
        tax = round_cents(gross * rate / (100.0 + rate))
        return gross - tax, tax
    return gross, round_cents(gross * rate / 100.0)


def split_inclusive(amount, rate):
    """Split a tax-inclusive amount into (net, tax)."""
    if not rate:
        return amount, 0
    tax = round_cents(amount * rate / (100.0 + rate))
    return amount - tax, tax


# ================================================================== inventory
def stock_in(db, item_id, qty, unit_cost, date, source_type, source_id=None, memo=None):
    write_txn(db)
    item = db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    old_q, old_c = item["qty_on_hand"], item["avg_cost"]
    new_q = old_q + qty
    if new_q > 0 and old_q > 0:
        new_c = (old_q * old_c + qty * unit_cost) / new_q
    else:
        new_c = unit_cost
    # Stock sold before it was bought (on hand below 0) went out at the last known cost; the units now carry this
    # purchase's cost, so the difference goes to cost of sales and the Inventory account still matches (F13).
    correction = round_cents(old_q * old_c + qty * unit_cost - new_q * new_c) if old_q < 0 else 0
    db.execute("UPDATE items SET qty_on_hand=?, avg_cost=? WHERE id=?", (new_q, new_c, item_id))
    db.execute("INSERT INTO stock_movements (item_id, date, qty, unit_cost, source_type, source_id, memo)"
               " VALUES (?,?,?,?,?,?,?)", (item_id, date, qty, unit_cost, source_type, source_id, memo))
    if correction:
        _stock_value_entry(db, item, date, correction, item["expense_account_id"] or linked(db, "cogs"),
                           "Stock cost correction (sold before bought)")


def _stock_value_entry(db, item, date, too_high, other_account, memo):
    """The Inventory account is too_high cents above the stock's value (negative: below): bring it into line."""
    asset = item["asset_account_id"] or linked(db, "inventory")
    lines = [dict(account_id=other_account, debit=too_high, memo=memo),
             dict(account_id=asset, credit=too_high, memo=memo)]
    eid = post_entry(db, date, f"{memo}: {item['sku']}", "stock_adj", lines)
    db.execute("UPDATE journal_entries SET source_id=? WHERE id=?", (eid, eid))
    return eid


def last_cost(item):
    """What a unit costs when there's none on hand to average: the last average cost, else the item's buy price."""
    return item["avg_cost"] if item["avg_cost"] and item["avg_cost"] > 0 else float(item["buy_price"] or 0)


def stock_out(db, item_id, qty, date, source_type, source_id=None, memo=None):
    """Remove qty at average cost; returns total cost in cents. With nothing on hand to average (selling before
    buying), the last known cost is used, so cost of sales is never left at $0 (F13)."""
    write_txn(db)
    item = db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    cost = last_cost(item)
    db.execute("UPDATE items SET qty_on_hand=qty_on_hand-?, avg_cost=? WHERE id=?", (qty, cost, item_id))
    db.execute("INSERT INTO stock_movements (item_id, date, qty, unit_cost, source_type, source_id, memo)"
               " VALUES (?,?,?,?,?,?,?)", (item_id, date, -qty, cost, source_type, source_id, memo))
    return round_cents(cost * qty)


def _unstock_bill(db, m, doc):
    """Voiding a bill takes its stock out at the bill's own unit cost (the ledger reversal removes exactly that),
    and re-averages what's left (F13)."""
    item = db.execute("SELECT * FROM items WHERE id=?", (m["item_id"],)).fetchone()
    new_q = item["qty_on_hand"] - m["qty"]
    remaining = item["qty_on_hand"] * item["avg_cost"] - round_cents(m["qty"] * m["unit_cost"])
    if new_q > 1e-9 and remaining >= 0:
        new_c, too_high = remaining / new_q, 0
    else:
        new_c = item["avg_cost"]
        too_high = round_cents(remaining - max(new_q, 0) * new_c)
    db.execute("UPDATE items SET qty_on_hand=?, avg_cost=? WHERE id=?", (max(new_q, 0), new_c, item["id"]))
    db.execute("INSERT INTO stock_movements (item_id, date, qty, unit_cost, source_type, source_id, memo)"
               " VALUES (?,?,?,?,?,?,?)", (item["id"], doc["date"], -m["qty"], m["unit_cost"], "void", doc["id"],
                                           "Void " + doc["number"]))
    if too_high:
        _stock_value_entry(db, item, doc["date"], too_high, linked(db, "stock_adjust"),
                           f"Stock value after voiding {doc['number']}")


def stock_adjust(db, item_id, date, qty_change, unit_cost=None, memo="Inventory adjustment", account_id=None):
    write_txn(db)
    item = db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    if not item or not item["is_inventoried"]:
        raise PostingError("Item is not an inventoried item.")
    adj_acct = account_id or linked(db, "stock_adjust")
    asset = item["asset_account_id"] or linked(db, "inventory")
    if qty_change > 0:
        cost = unit_cost if unit_cost else last_cost(item)
        if not cost:
            raise PostingError(f"{item['sku']} has never been bought, so there's no cost to use: enter a unit cost.")
        value = round_cents(cost * qty_change)
        lines = [dict(account_id=asset, debit=value), dict(account_id=adj_acct, credit=value)]
    else:
        value = round_cents(last_cost(item) * -qty_change)
        lines = [dict(account_id=adj_acct, debit=value), dict(account_id=asset, credit=value)]
    eid = post_entry(db, date, f"{memo}: {item['sku']} {qty_change:+g}", "stock_adj", lines)
    if qty_change > 0:
        stock_in(db, item_id, qty_change, cost, date, "stock_adj", eid, memo)
    else:
        stock_out(db, item_id, -qty_change, date, "stock_adj", eid, memo)
    db.execute("UPDATE journal_entries SET source_id=? WHERE id=?", (eid, eid))
    audit(db, "stock_adjust", f"{item['sku']} {qty_change:+g}")
    return eid


# ================================================================== documents
def next_number(db, side, series=None):
    """The next free number, inside the write transaction (two people saving at once get different numbers).
    A number already used (typed in by hand earlier) is skipped. series: None (invoices / bills), 'quote' (S35),
    'credit' (credit notes, S17) or 'payment_credit' (S43), each with its own prefix."""
    write_txn(db)
    if series:
        key = f"{series}_{side}"
        r = db.execute("SELECT prefix, next_no FROM number_series WHERE key=?", (key,)).fetchone()
        prefix, no = (r["prefix"], r["next_no"]) if r else (series[:2].upper(), 1)
    else:
        c = db.execute("SELECT * FROM company WHERE id=1").fetchone()
        prefix, col = (c["invoice_prefix"], "next_invoice_no") if side == "sale" else (c["bill_prefix"], "next_bill_no")
        no = c[col]
    while True:
        n = f"{prefix}{no:05d}"
        no += 1
        if not db.execute("SELECT 1 FROM documents WHERE side=? AND number=?", (side, n)).fetchone():
            break
    if series:
        db.execute("INSERT OR REPLACE INTO number_series (key, prefix, next_no) VALUES (?,?,?)", (key, prefix, no))
    else:
        db.execute(f"UPDATE company SET {col}=? WHERE id=1", (no,))
    return n


def _number_taken(db, side, number, doc_id=None):
    return db.execute("SELECT 1 FROM documents WHERE side=? AND number=? AND id IS NOT ?",
                      (side, number, doc_id)).fetchone() is not None


def save_document(db, side, header, lines, status, doc_id=None):
    """Create or update a document.  header: contact_id, date, due_date, reference, notes, tax_inclusive.
    lines: list of dicts item_id, description, qty, unit_price(cents), discount_pct, account_id, tax_code_id, job_id.
    If status == 'open' the document is posted to the ledger."""
    if not header.get("contact_id"):
        raise PostingError("Choose a customer/supplier.")
    write_txn(db)
    kind = header.get("kind") or "invoice"
    if kind not in ("invoice", "credit"):
        raise PostingError("Invalid document type.")
    credit = kind == "credit"
    clean = []
    for n, l in enumerate(lines, 1):
        if not (l.get("item_id") or l.get("description") or l.get("unit_price")):
            continue
        try:
            l["qty"] = float(l.get("qty") if l.get("qty") not in (None, "") else 0)
        except (TypeError, ValueError):
            raise PostingError(f"Line {n}: quantity must be a number.")  # S16
        if credit:
            if l["qty"] < 0 or (l.get("unit_price") or 0) < 0:
                raise PostingError(f"Line {n}: enter a credit note's amounts as positive numbers.")
            l["qty"] = -l["qty"]  # a credit note is stored as negative amounts, so balances net off by themselves
        if l.get("item_id"):
            item = db.execute("SELECT * FROM items WHERE id=?", (l["item_id"],)).fetchone()
            if item["is_inventoried"] and side == "purchase":
                # a stocked item always goes to its stock (asset) account, so the Inventory account follows the
                # stock (F13); an expense account picked on the line is ignored
                l["account_id"] = item["asset_account_id"] or linked(db, "inventory")
            elif not l.get("account_id"):
                l["account_id"] = item["income_account_id"] if side == "sale" else item["expense_account_id"]
            if not l.get("description"):
                l["description"] = item["name"]
        if not l.get("account_id"):
            raise PostingError(f"Line '{l.get('description') or ''}' needs an account.")
        tc = tax_code(db, l.get("tax_code_id"))
        net, tax = calc_line(l.get("qty") or 0, l.get("unit_price") or 0, l.get("discount_pct") or 0,
                             tc["rate"] if tc else 0, header.get("tax_inclusive"))
        l["net_amount"], l["tax_amount"] = net, tax
        clean.append(l)
    if not clean:
        raise PostingError("Add at least one line.")
    subtotal = sum(l["net_amount"] for l in clean)
    tax_total = sum(l["tax_amount"] for l in clean)
    total = subtotal + tax_total
    word = "invoice" if side == "sale" else "bill"
    if not credit and total < 0:
        raise PostingError(f"An {word} can't be below $0. Create a credit note instead." if side == "sale" else
                           "A bill can't be below $0. Enter a supplier credit instead.")  # S15
    if credit and total >= 0:
        raise PostingError("A credit note needs an amount.")
    if credit and side == "purchase" and any(_stocked(db, l) for l in clean):
        raise PostingError("For stock sent back to a supplier, use a stock adjustment; a supplier credit is for "
                           "amounts only.")
    if doc_id:
        doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if doc["status"] not in ("quote", "order"):
            raise PostingError("Only quotes and orders can be edited; void and re-enter posted documents.")
        db.execute("UPDATE documents SET contact_id=?, date=?, due_date=?, reference=?, notes=?, tax_inclusive=?,"
                   " subtotal=?, tax_total=?, total=?, status=? WHERE id=?",
                   (header["contact_id"], header["date"], header.get("due_date"), header.get("reference"),
                    header.get("notes"), 1 if header.get("tax_inclusive") else 0, subtotal, tax_total, total,
                    status, doc_id))
        db.execute("DELETE FROM document_lines WHERE document_id=?", (doc_id,))
    else:
        if credit and status != "open":
            raise PostingError("A credit note is saved straight away (it can't be a quote or an order).")
        series = "credit" if credit else ("quote" if status == "quote" else
                                          "order" if status == "order" and side == "purchase" else None)
        number = (header.get("number") or "").strip() or next_number(db, side, series)
        if _number_taken(db, side, number):
            raise PostingError(f"{'Invoice' if side == 'sale' else 'Bill'} number {number} is already used.")
        doc_id = db.execute(
            "INSERT INTO documents (side, status, number, contact_id, date, due_date, reference, notes, tax_inclusive,"
            " subtotal, tax_total, total, kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (side, status, number, header["contact_id"], header["date"], header.get("due_date"),
             header.get("reference"), header.get("notes"), 1 if header.get("tax_inclusive") else 0,
             subtotal, tax_total, total, kind)).lastrowid
    for l in clean:
        db.execute("INSERT INTO document_lines (document_id, item_id, description, qty, unit_price, discount_pct,"
                   " account_id, tax_code_id, job_id, net_amount, tax_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                   (doc_id, l.get("item_id"), l.get("description"), l.get("qty") or 0, l.get("unit_price") or 0,
                    l.get("discount_pct") or 0, l["account_id"], l.get("tax_code_id"), l.get("job_id"),
                    l["net_amount"], l["tax_amount"]))
    if status == "open":
        post_document(db, doc_id)
    audit(db, f"{side}_{status}", f"document {doc_id}")
    return doc_id


class StockShort(PostingError):
    """Selling more than is on hand (S25, S40). confirm: False when the item is set to never sell below 0."""
    def __init__(self, msg, confirm=True):
        super().__init__(msg)
        self.confirm = confirm


def check_stock(db, lines, sell_anyway=False):
    """Refuse a sale of more stock than is on hand unless sell_anyway (and the item allows it)."""
    want = defaultdict(float)
    for l in lines:
        if l.get("item_id"):
            want[l["item_id"]] += float(l.get("qty") or 0)
    msgs, block = [], False
    for iid, q in want.items():
        it = db.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
        if not it or not it["is_inventoried"] or q <= 0 or q <= it["qty_on_hand"] + 1e-9:
            continue
        if it["block_oversell"]:
            block = True
            msgs.append(f"Only {max(it['qty_on_hand'], 0):g} {it['name']} in stock, and it can't be sold below 0.")
        else:
            msgs.append(f"Only {max(it['qty_on_hand'], 0):g} {it['name']} in stock (selling {q:g}).")
    if block:
        raise StockShort(" ".join(msgs), confirm=False)
    if msgs and not sell_anyway:
        raise StockShort(" ".join(msgs) + " Sell anyway?")


def _stocked(db, l):
    if not l.get("item_id"):
        return False
    r = db.execute("SELECT is_inventoried FROM items WHERE id=?", (l["item_id"],)).fetchone()
    return bool(r and r["is_inventoried"])


def post_document(db, doc_id):
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    lines = db.execute("SELECT * FROM document_lines WHERE document_id=?", (doc_id,)).fetchall()
    sale = doc["side"] == "sale"
    control = linked(db, "receivables" if sale else "payables")
    jl = []
    tax_by_acct = defaultdict(int)
    cogs = []
    for l in lines:
        jl.append(dict(account_id=l["account_id"], debit=0 if sale else l["net_amount"],
                       credit=l["net_amount"] if sale else 0, tax_code_id=l["tax_code_id"], job_id=l["job_id"],
                       memo=l["description"]))
        if l["tax_amount"]:
            tc = tax_code(db, l["tax_code_id"])
            acct = (tc["collected_account_id"] if sale else tc["paid_account_id"]) or \
                linked(db, "gst_collected" if sale else "gst_paid")
            tax_by_acct[acct] += l["tax_amount"]
        if l["item_id"]:
            cogs.append(l)
    for acct, amt in tax_by_acct.items():
        jl.append(dict(account_id=acct, debit=0 if sale else amt, credit=amt if sale else 0, memo="GST"))
    jl.append(dict(account_id=control, debit=doc["total"] if sale else 0, credit=0 if sale else doc["total"],
                   memo=doc["number"]))
    contact = db.execute("SELECT name FROM contacts WHERE id=?", (doc["contact_id"],)).fetchone()
    memo = f"{'Sale' if sale else 'Purchase'}; {contact['name']}"
    eid = post_entry(db, doc["date"], memo, "invoice" if sale else "bill", jl, source_id=doc_id,
                     reference=doc["number"], contact_id=doc["contact_id"])
    # Inventory movements
    cogs_lines = []
    for l in cogs:
        item = db.execute("SELECT * FROM items WHERE id=?", (l["item_id"],)).fetchone()
        if not item["is_inventoried"]:
            continue
        if sale:
            cost = stock_out(db, item["id"], l["qty"], doc["date"], "invoice", doc_id, doc["number"])
            if cost:  # negative on a credit note: the goods come back, so cost of sales goes the other way
                cogs_lines.append(dict(account_id=item["expense_account_id"] or linked(db, "cogs"),
                                       debit=max(cost, 0), credit=max(-cost, 0), job_id=l["job_id"],
                                       memo=f"COGS {item['sku']}"))
                cogs_lines.append(dict(account_id=item["asset_account_id"] or linked(db, "inventory"),
                                       debit=max(-cost, 0), credit=max(cost, 0), memo=f"COGS {item['sku']}"))
        else:
            unit = l["net_amount"] / l["qty"] if l["qty"] else 0
            stock_in(db, item["id"], l["qty"], unit, doc["date"], "bill", doc_id, doc["number"])
    if cogs_lines:
        for cl in cogs_lines:
            db.execute("INSERT INTO journal_lines (entry_id, account_id, debit, credit, job_id, memo)"
                       " VALUES (?,?,?,?,?,?)", (eid, cl["account_id"], cl.get("debit", 0), cl.get("credit", 0),
                                                 cl.get("job_id"), cl["memo"]))
    db.execute("UPDATE documents SET entry_id=?, status='open' WHERE id=?", (eid, doc_id))
    return eid


def convert_document(db, doc_id, to_status):
    """An order becomes the invoice (bill). A quote is kept as it was quoted (S35): the order or invoice is a new
    document with its own number, linked from the quote. Returns the id of the order / invoice."""
    write_txn(db)
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc["status"] not in ("quote", "order"):
        raise PostingError("Only quotes/orders can be converted.")
    if doc["converted_to"]:
        raise PostingError(f"{doc['number']} has already been converted.")
    if doc["status"] == "quote":
        lines = [dict(r) for r in db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (doc_id,))]
        header = dict(contact_id=doc["contact_id"], date=_date.today().isoformat(), due_date=doc["due_date"],
                      reference=doc["reference"] or doc["number"], notes=doc["notes"],
                      tax_inclusive=bool(doc["tax_inclusive"]))
        new = save_document(db, doc["side"], header, lines, "order" if to_status == "order" else "open")
        db.execute("UPDATE documents SET converted_to=? WHERE id=?", (new, doc_id))
        audit(db, "convert_document", f"{doc['number']} -> document {new}")
        return new
    if to_status == "order":
        return doc_id
    if doc["side"] == "purchase":  # M13: a purchase order (PO…) becomes a bill with a bill number
        db.execute("UPDATE documents SET number=? WHERE id=?", (next_number(db, "purchase"), doc_id))
    post_document(db, doc_id)
    audit(db, "convert_document", f"{doc['number']} -> {to_status}")
    return doc_id


def void_document(db, doc_id):
    write_txn(db)
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc["status"] == "void":
        raise PostingError("Already void.")
    if doc["kind"] == "payment_credit":
        raise PostingError("This credit is part of a payment: void the payment instead.")
    if doc["amount_paid"]:
        raise PostingError("Document has payments applied; void the payments first.")
    if doc["entry_id"]:
        moves = db.execute("SELECT * FROM stock_movements WHERE source_type IN ('invoice','bill') AND source_id=?",
                           (doc_id,)).fetchall()
        for m in moves:
            if m["qty"] > 0:
                it = db.execute("SELECT sku, qty_on_hand FROM items WHERE id=?", (m["item_id"],)).fetchone()
                if it["qty_on_hand"] < m["qty"] - 1e-9:
                    raise PostingError(
                        f"Some of {it['sku']} on this bill has already been sold or used ({it['qty_on_hand']:g} left "
                        f"of {m['qty']:g}). Enter a supplier credit or a stock adjustment instead of voiding.")
        reverse_entry(db, doc["entry_id"])
        for m in moves:
            if m["qty"] < 0:
                stock_in(db, m["item_id"], -m["qty"], m["unit_cost"], doc["date"], "void", doc_id, "Void " + doc["number"])
            else:
                _unstock_bill(db, m, doc)
    db.execute("UPDATE documents SET status='void' WHERE id=?", (doc_id,))
    audit(db, "void_document", doc["number"])


# =================================================================== payments
def record_payment(db, direction, contact_id, bank_account_id, date, allocations, reference=None, memo=None,
                   amount=None):
    """allocations: list of (document_id, amount_cents). amount: what was received (paid); more than the
    allocations leaves the rest as the customer's (supplier's) credit (S43), and with no allocations it's a
    deposit. Returns the payment id."""
    allocations = [(d, a) for d, a in allocations if a]
    if not allocations and not amount:
        raise PostingError("Enter an amount against at least one document.")
    write_txn(db)  # the balance due is read and paid in one go: two people can't both pay the same invoice
    total = 0
    side = "sale" if direction == "in" else "purchase"
    for doc_id, amt in allocations:
        doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not doc or doc["side"] != side or doc["contact_id"] != int(contact_id) or doc["status"] != "open" \
                or (doc["kind"] or "invoice") != "invoice":
            raise PostingError("Invalid document allocation.")
        if amt < 0 or amt > doc["total"] - doc["amount_paid"]:
            raise PostingError(f"Amount for {doc['number']} exceeds the balance due.")
        total += amt
    bank = db.execute("SELECT is_bank FROM accounts WHERE id=?", (bank_account_id,)).fetchone()
    if not bank or not bank["is_bank"]:
        raise PostingError("Choose a bank or credit card account for the payment.")  # M19
    received = total if amount is None else amount
    if received < total:
        raise PostingError(f"The amounts applied ({fmt_money(total)}) are more than the payment ({fmt_money(received)}).")
    if received <= 0:
        raise PostingError("Enter the amount received.")
    extra = received - total
    control = linked(db, "receivables" if direction == "in" else "payables")
    contact = db.execute("SELECT name FROM contacts WHERE id=?", (contact_id,)).fetchone()
    if direction == "in":
        lines = [dict(account_id=bank_account_id, debit=received), dict(account_id=control, credit=received)]
        m = memo or f"Payment; {contact['name']}"
    else:
        lines = [dict(account_id=control, debit=received), dict(account_id=bank_account_id, credit=received)]
        m = memo or f"Payment to {contact['name']}"
    # each document is paid only up to what's still due (a second payment of the same invoice changes no row)
    db.execute("SAVEPOINT record_payment")
    for doc_id, amt in allocations:
        cur = db.execute("UPDATE documents SET amount_paid=amount_paid+?,"
                         " status=CASE WHEN amount_paid+?>=total THEN 'paid' ELSE 'open' END"
                         " WHERE id=? AND status='open' AND amount_paid+?<=total", (amt, amt, doc_id, amt))
        if cur.rowcount != 1:
            db.execute("ROLLBACK TO record_payment")
            db.execute("RELEASE record_payment")
            raise PostingError("That document was paid (or changed) by someone else just now. Check its balance.")
    db.execute("RELEASE record_payment")
    pid = db.execute("INSERT INTO payments (direction, contact_id, bank_account_id, date, amount, reference, memo)"
                     " VALUES (?,?,?,?,?,?,?)",
                     (direction, contact_id, bank_account_id, date, received, reference, m)).lastrowid
    eid = post_entry(db, date, m, "receipt" if direction == "in" else "payment", lines, source_id=pid,
                     reference=reference, contact_id=contact_id)
    db.execute("UPDATE payments SET entry_id=? WHERE id=?", (eid, pid))
    for doc_id, amt in allocations:
        db.execute("INSERT INTO payment_allocations (payment_id, document_id, amount) VALUES (?,?,?)",
                   (pid, doc_id, amt))
    if extra:
        # the rest stays with the customer as credit: a credit line on their account, used later or refunded
        db.execute("INSERT INTO documents (side, status, number, contact_id, date, due_date, reference, notes,"
                   " subtotal, tax_total, total, kind, payment_id) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)",
                   (side, "open", next_number(db, side, "payment_credit"), contact_id, date, date, reference,
                    f"Unapplied payment of {fmt_money(received)}", -extra, -extra, "payment_credit", pid))
    audit(db, "payment_" + direction, f"{fmt_money(received)} {contact['name']}" +
          (f" ({fmt_money(extra)} left as credit)" if extra else ""))
    return pid


def void_payment(db, payment_id):
    write_txn(db)
    p = db.execute("SELECT * FROM payments WHERE id=?", (payment_id,)).fetchone()
    if not p or p["voided"]:
        raise PostingError("Payment not found or already void.")
    cr = db.execute("SELECT * FROM documents WHERE payment_id=? AND kind='payment_credit'", (payment_id,)).fetchone()
    if cr and cr["amount_paid"]:
        raise PostingError(f"Part of this payment's credit ({cr['number']}) has been used or refunded. Undo that first.")
    reverse_entry(db, p["entry_id"])
    for a in db.execute("SELECT * FROM payment_allocations WHERE payment_id=?", (payment_id,)).fetchall():
        db.execute("UPDATE documents SET amount_paid=amount_paid-?, status='open' WHERE id=?",
                   (a["amount"], a["document_id"]))
    if cr:
        db.execute("UPDATE documents SET status='void' WHERE id=?", (cr["id"],))
    db.execute("UPDATE payments SET voided=1 WHERE id=?", (payment_id,))
    audit(db, "void_payment", str(payment_id))


# ============================================================ credits (S17, S43)
def credit_available(doc):
    """What's left to use on a credit note or unapplied payment (positive cents)."""
    return -(doc["total"] - doc["amount_paid"])


def credits_for(db, contact_id, side):
    return db.execute("SELECT * FROM documents WHERE contact_id=? AND side=? AND status='open' AND kind IN"
                      " ('credit','payment_credit') AND total-amount_paid<0 ORDER BY date, id",
                      (contact_id, side)).fetchall()


def apply_credit(db, credit_id, document_id, amount, date=None):
    """Use a credit note or unapplied payment against an invoice (bill) of the same customer (supplier)."""
    write_txn(db)
    cr = db.execute("SELECT * FROM documents WHERE id=?", (credit_id,)).fetchone()
    doc = db.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
    if not cr or cr["kind"] not in ("credit", "payment_credit") or cr["status"] != "open":
        raise PostingError("That credit isn't available.")
    if not doc or doc["kind"] != "invoice" or doc["status"] != "open" or doc["contact_id"] != cr["contact_id"] \
            or doc["side"] != cr["side"]:
        raise PostingError("Choose an open invoice of the same customer.")
    if amount <= 0 or amount > credit_available(cr) or amount > doc["total"] - doc["amount_paid"]:
        raise PostingError(f"Enter up to {fmt_money(min(credit_available(cr), doc['total'] - doc['amount_paid']))}.")
    db.execute("UPDATE documents SET amount_paid=amount_paid+?, status=CASE WHEN amount_paid+?>=total THEN 'paid'"
               " ELSE 'open' END WHERE id=?", (amount, amount, document_id))
    db.execute("UPDATE documents SET amount_paid=amount_paid-?, status=CASE WHEN total-(amount_paid-?)>=0 THEN 'paid'"
               " ELSE 'open' END WHERE id=?", (amount, amount, credit_id))
    db.execute("INSERT INTO credit_uses (credit_id, document_id, amount, date) VALUES (?,?,?,?)",
               (credit_id, document_id, amount, date or _date.today().isoformat()))
    audit(db, "apply_credit", f"{cr['number']} -> {doc['number']} {fmt_money(amount)}")


def refund_credit(db, credit_id, bank_account_id, date, amount, reference=None):
    """Pay a customer's credit back to them (or a supplier's credit back to us)."""
    write_txn(db)
    cr = db.execute("SELECT * FROM documents WHERE id=?", (credit_id,)).fetchone()
    if not cr or cr["kind"] not in ("credit", "payment_credit") or cr["status"] != "open":
        raise PostingError("That credit isn't available.")
    if amount <= 0 or amount > credit_available(cr):
        raise PostingError(f"Refund up to {fmt_money(credit_available(cr))}.")
    bank = db.execute("SELECT is_bank FROM accounts WHERE id=?", (bank_account_id,)).fetchone()
    if not bank or not bank["is_bank"]:
        raise PostingError("Choose a bank or credit card account for the refund.")
    sale = cr["side"] == "sale"
    control = linked(db, "receivables" if sale else "payables")
    contact = db.execute("SELECT name FROM contacts WHERE id=?", (cr["contact_id"],)).fetchone()
    lines = ([dict(account_id=control, debit=amount), dict(account_id=bank_account_id, credit=amount)] if sale else
             [dict(account_id=bank_account_id, debit=amount), dict(account_id=control, credit=amount)])
    eid = post_entry(db, date, f"Refund of {cr['number']}; {contact['name']}", "refund", lines,
                     reference=reference or cr["number"], contact_id=cr["contact_id"])
    db.execute("UPDATE journal_entries SET source_id=? WHERE id=?", (credit_id, eid))
    db.execute("UPDATE documents SET amount_paid=amount_paid-?, status=CASE WHEN total-(amount_paid-?)>=0 THEN 'paid'"
               " ELSE 'open' END WHERE id=?", (amount, amount, credit_id))
    db.execute("INSERT INTO credit_uses (credit_id, refund_entry_id, amount, date) VALUES (?,?,?,?)",
               (credit_id, eid, amount, date))
    audit(db, "refund_credit", f"{cr['number']} {fmt_money(amount)}")
    return eid


# ==================================================================== banking
def bank_transaction(db, kind, bank_account_id, date, lines, payee=None, reference=None, memo=None,
                     contact_id=None, tax_inclusive=True):
    """Money out (kind='spend') or money in (kind='receive').
    lines: list of dicts account_id, amount (cents), tax_code_id, job_id, memo."""
    jl = []
    total = 0
    tax_by_acct = defaultdict(int)
    spend = kind == "spend"
    for l in lines:
        if not l.get("amount"):
            continue
        tc = tax_code(db, l.get("tax_code_id"))
        rate = tc["rate"] if tc else 0
        if tax_inclusive:
            net, tax = split_inclusive(l["amount"], rate)
        else:
            net, tax = l["amount"], round_cents(l["amount"] * rate / 100.0)
        jl.append(dict(account_id=l["account_id"], debit=net if spend else 0, credit=0 if spend else net,
                       tax_code_id=l.get("tax_code_id"), job_id=l.get("job_id"), memo=l.get("memo")))
        if tax:
            acct = (tc["paid_account_id"] if spend else tc["collected_account_id"]) or \
                linked(db, "gst_paid" if spend else "gst_collected")
            tax_by_acct[acct] += tax
        total += net + tax
    if not total:
        raise PostingError("Enter at least one amount.")
    for acct, amt in tax_by_acct.items():
        jl.append(dict(account_id=acct, debit=amt if spend else 0, credit=0 if spend else amt, memo="GST"))
    jl.append(dict(account_id=bank_account_id, debit=0 if spend else total, credit=total if spend else 0,
                   memo=payee))
    m = memo or (f"{'Spend' if spend else 'Receive'} money: {payee or ''}").strip()
    eid = post_entry(db, date, m, kind, jl, reference=reference, contact_id=contact_id)
    db.execute("UPDATE journal_entries SET source_id=? WHERE id=?", (eid, eid))
    audit(db, kind, f"{fmt_money(total)} {payee or ''}")
    return eid


def transfer(db, from_id, to_id, date, amount, memo=None):
    if from_id == to_id:
        raise PostingError("Choose two different accounts.")
    eid = post_entry(db, date, memo or "Transfer money", "transfer",
                     [dict(account_id=to_id, debit=amount), dict(account_id=from_id, credit=amount)])
    audit(db, "transfer", fmt_money(amount))
    return eid


def control_accounts(db):
    """{account_id: (what it is, what to use instead)} for accounts other records keep in step (S55): customers'
    and suppliers' balances, stock, and GST."""
    out = {}
    for key, what, use in (("receivables", "Trade Debtors", "an invoice, a credit or a customer payment"),
                           ("payables", "Trade Creditors", "a bill, a credit or a supplier payment"),
                           ("inventory", "Inventory", "a bill, a sale or a stock adjustment"),
                           ("gst_collected", "GST", "an invoice or bill with a tax code"),
                           ("gst_paid", "GST", "an invoice or bill with a tax code")):
        row = db.execute("SELECT account_id FROM linked_accounts WHERE key=?", (key,)).fetchone()
        if row:
            out.setdefault(row["account_id"], (what, use))
    for r in db.execute("SELECT DISTINCT asset_account_id a FROM items WHERE is_inventoried=1 AND asset_account_id"
                        " IS NOT NULL"):
        out.setdefault(r["a"], ("Inventory", "a bill, a sale or a stock adjustment"))
    for r in db.execute("SELECT collected_account_id c, paid_account_id p FROM tax_codes"):
        for a in (r["c"], r["p"]):
            if a:
                out.setdefault(a, ("GST", "an invoice or bill with a tax code"))
    return out


def check_journal_lines(db, lines, gst_ok=False):
    """Journals can't post straight to Trade Debtors, Trade Creditors or Inventory: the customer/supplier balances
    and stock wouldn't follow (S55). GST accounts only when it's deliberately a GST adjustment."""
    ctl = control_accounts(db)
    for l in lines:
        hit = ctl.get(l.get("account_id"))
        if hit and (l.get("debit") or l.get("credit")) and not (gst_ok and hit[0] == "GST"):
            extra = " (or tick \"This is a GST adjustment\")" if hit[0] == "GST" else ""
            raise PostingError(f"A journal can't post to the {hit[0]} control account: use {hit[1]}{extra}.")


def general_journal(db, date, memo, lines, reference=None):
    eid = post_entry(db, date, memo, "journal", lines, reference=reference)
    db.execute("UPDATE journal_entries SET source_id=? WHERE id=?", (eid, eid))
    audit(db, "general_journal", f"#{eid} {memo}")
    return eid


# ==================================================================== queries
def balances(db, end=None, start=None, job_id=None, account_ids=None):
    """Return {account_id: debit-credit} for the date range."""
    sql = ("SELECT l.account_id, SUM(l.debit - l.credit) AS bal FROM journal_lines l"
           " JOIN journal_entries e ON e.id=l.entry_id WHERE 1=1")
    p = []
    if start:
        sql += " AND e.date >= ?"; p.append(start)
    if end:
        sql += " AND e.date <= ?"; p.append(end)
    if job_id:
        sql += " AND l.job_id = ?"; p.append(job_id)
    sql += " GROUP BY l.account_id"
    return {r["account_id"]: r["bal"] for r in db.execute(sql, p)}


def account_balance(db, account_id, end=None):
    return balances(db, end=end).get(account_id, 0)


def fy_start(db, on=None):
    on = _date.fromisoformat(on) if on else _date.today()
    m = db.execute("SELECT fy_start_month FROM company WHERE id=1").fetchone()["fy_start_month"]
    y = on.year if on.month >= m else on.year - 1
    return _date(y, m, 1).isoformat()


def add_days(d, n):
    return (_date.fromisoformat(d) + timedelta(days=n)).isoformat()
