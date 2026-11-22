"""Core double-entry posting engine and business transactions.

Every business event (invoice, bill, payment, money out, pay run, stock
adjustment...) is turned into a balanced journal entry here.  Reports read
only from journal_lines, so the books always reconcile.
"""
from collections import defaultdict
from datetime import date as _date, timedelta

from flask import g

from .db import linked, audit, round_cents, fmt_money


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
    item = db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    old_q, old_c = item["qty_on_hand"], item["avg_cost"]
    new_q = old_q + qty
    if new_q > 0 and old_q > 0:
        new_c = (old_q * old_c + qty * unit_cost) / new_q
    else:
        new_c = unit_cost
    db.execute("UPDATE items SET qty_on_hand=?, avg_cost=? WHERE id=?", (new_q, new_c, item_id))
    db.execute("INSERT INTO stock_movements (item_id, date, qty, unit_cost, source_type, source_id, memo)"
               " VALUES (?,?,?,?,?,?,?)", (item_id, date, qty, unit_cost, source_type, source_id, memo))


def stock_out(db, item_id, qty, date, source_type, source_id=None, memo=None):
    """Remove qty at average cost; returns total cost in cents."""
    item = db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    cost = item["avg_cost"]
    db.execute("UPDATE items SET qty_on_hand=qty_on_hand-? WHERE id=?", (qty, item_id))
    db.execute("INSERT INTO stock_movements (item_id, date, qty, unit_cost, source_type, source_id, memo)"
               " VALUES (?,?,?,?,?,?,?)", (item_id, date, -qty, cost, source_type, source_id, memo))
    return round_cents(cost * qty)


def stock_adjust(db, item_id, date, qty_change, unit_cost=None, memo="Inventory adjustment", account_id=None):
    item = db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    if not item or not item["is_inventoried"]:
        raise PostingError("Item is not an inventoried item.")
    adj_acct = account_id or linked(db, "stock_adjust")
    asset = item["asset_account_id"] or linked(db, "inventory")
    if qty_change > 0:
        cost = unit_cost if unit_cost is not None else item["avg_cost"]
        value = round_cents(cost * qty_change)
        lines = [dict(account_id=asset, debit=value), dict(account_id=adj_acct, credit=value)]
    else:
        value = round_cents(item["avg_cost"] * -qty_change)
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
def next_number(db, side):
    c = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    if side == "sale":
        n = f"{c['invoice_prefix']}{c['next_invoice_no']:05d}"
        db.execute("UPDATE company SET next_invoice_no=next_invoice_no+1 WHERE id=1")
    else:
        n = f"{c['bill_prefix']}{c['next_bill_no']:05d}"
        db.execute("UPDATE company SET next_bill_no=next_bill_no+1 WHERE id=1")
    return n


def save_document(db, side, header, lines, status, doc_id=None):
    """Create or update a document.  header: contact_id, date, due_date, reference, notes, tax_inclusive.
    lines: list of dicts item_id, description, qty, unit_price(cents), discount_pct, account_id, tax_code_id, job_id.
    If status == 'open' the document is posted to the ledger."""
    if not header.get("contact_id"):
        raise PostingError("Choose a customer/supplier.")
    clean = []
    for l in lines:
        if not (l.get("item_id") or l.get("description") or l.get("unit_price")):
            continue
        if l.get("item_id"):
            item = db.execute("SELECT * FROM items WHERE id=?", (l["item_id"],)).fetchone()
            if not l.get("account_id"):
                if item["is_inventoried"] and side == "purchase":
                    l["account_id"] = item["asset_account_id"] or linked(db, "inventory")
                else:
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
        number = header.get("number") or next_number(db, side)
        doc_id = db.execute(
            "INSERT INTO documents (side, status, number, contact_id, date, due_date, reference, notes, tax_inclusive,"
            " subtotal, tax_total, total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (side, status, number, header["contact_id"], header["date"], header.get("due_date"),
             header.get("reference"), header.get("notes"), 1 if header.get("tax_inclusive") else 0,
             subtotal, tax_total, total)).lastrowid
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
            if cost:
                cogs_lines.append(dict(account_id=item["expense_account_id"] or linked(db, "cogs"), debit=cost,
                                       job_id=l["job_id"], memo=f"COGS {item['sku']}"))
                cogs_lines.append(dict(account_id=item["asset_account_id"] or linked(db, "inventory"), credit=cost,
                                       memo=f"COGS {item['sku']}"))
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
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc["status"] not in ("quote", "order"):
        raise PostingError("Only quotes/orders can be converted.")
    if to_status == "order":
        db.execute("UPDATE documents SET status='order' WHERE id=?", (doc_id,))
    else:
        post_document(db, doc_id)
    audit(db, "convert_document", f"{doc['number']} -> {to_status}")


def void_document(db, doc_id):
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if doc["status"] == "void":
        raise PostingError("Already void.")
    if doc["amount_paid"]:
        raise PostingError("Document has payments applied; void the payments first.")
    if doc["entry_id"]:
        reverse_entry(db, doc["entry_id"])
        for m in db.execute("SELECT * FROM stock_movements WHERE source_type IN ('invoice','bill') AND source_id=?",
                            (doc_id,)).fetchall():
            if m["qty"] < 0:
                stock_in(db, m["item_id"], -m["qty"], m["unit_cost"], doc["date"], "void", doc_id, "Void " + doc["number"])
            else:
                stock_out(db, m["item_id"], m["qty"], doc["date"], "void", doc_id, "Void " + doc["number"])
    db.execute("UPDATE documents SET status='void' WHERE id=?", (doc_id,))
    audit(db, "void_document", doc["number"])


# =================================================================== payments
def record_payment(db, direction, contact_id, bank_account_id, date, allocations, reference=None, memo=None):
    """allocations: list of (document_id, amount_cents)."""
    allocations = [(d, a) for d, a in allocations if a]
    if not allocations:
        raise PostingError("Enter an amount against at least one document.")
    total = 0
    side = "sale" if direction == "in" else "purchase"
    for doc_id, amt in allocations:
        doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        if not doc or doc["side"] != side or doc["contact_id"] != int(contact_id) or doc["status"] != "open":
            raise PostingError("Invalid document allocation.")
        if amt < 0 or amt > doc["total"] - doc["amount_paid"]:
            raise PostingError(f"Amount for {doc['number']} exceeds the balance due.")
        total += amt
    control = linked(db, "receivables" if direction == "in" else "payables")
    contact = db.execute("SELECT name FROM contacts WHERE id=?", (contact_id,)).fetchone()
    if direction == "in":
        lines = [dict(account_id=bank_account_id, debit=total), dict(account_id=control, credit=total)]
        m = memo or f"Payment; {contact['name']}"
    else:
        lines = [dict(account_id=control, debit=total), dict(account_id=bank_account_id, credit=total)]
        m = memo or f"Payment to {contact['name']}"
    pid = db.execute("INSERT INTO payments (direction, contact_id, bank_account_id, date, amount, reference, memo)"
                     " VALUES (?,?,?,?,?,?,?)",
                     (direction, contact_id, bank_account_id, date, total, reference, m)).lastrowid
    eid = post_entry(db, date, m, "receipt" if direction == "in" else "payment", lines, source_id=pid,
                     reference=reference, contact_id=contact_id)
    db.execute("UPDATE payments SET entry_id=? WHERE id=?", (eid, pid))
    for doc_id, amt in allocations:
        db.execute("INSERT INTO payment_allocations (payment_id, document_id, amount) VALUES (?,?,?)",
                   (pid, doc_id, amt))
        db.execute("UPDATE documents SET amount_paid=amount_paid+?,"
                   " status=CASE WHEN amount_paid+?>=total THEN 'paid' ELSE 'open' END WHERE id=?",
                   (amt, amt, doc_id))
    audit(db, "payment_" + direction, f"{fmt_money(total)} {contact['name']}")
    return pid


def void_payment(db, payment_id):
    p = db.execute("SELECT * FROM payments WHERE id=?", (payment_id,)).fetchone()
    if not p or p["voided"]:
        raise PostingError("Payment not found or already void.")
    reverse_entry(db, p["entry_id"])
    for a in db.execute("SELECT * FROM payment_allocations WHERE payment_id=?", (payment_id,)).fetchall():
        db.execute("UPDATE documents SET amount_paid=amount_paid-?, status='open' WHERE id=?",
                   (a["amount"], a["document_id"]))
    db.execute("UPDATE payments SET voided=1 WHERE id=?", (payment_id,))
    audit(db, "void_payment", str(payment_id))


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
