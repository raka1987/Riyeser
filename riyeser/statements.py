"""Activity statements for customers and suppliers (S44): opening balance, invoices, credits, payments and refunds
in the period, closing balance, ageing and overdue invoices, and how to pay (S36)."""
from datetime import date

BUCKETS = ["Current", "1–30 days", "31–60 days", "61–90 days", "90+ days"]


def _side(contact):
    return "sale" if contact["kind"] == "customer" else "purchase"


def _balance_to(db, cid, side, before=None, upto=None):
    """Invoices and credit notes less payments, plus refunds (the contact's balance), by date."""
    cond, p = "", []
    if before:
        cond, p = " AND date<?", [before]
    elif upto:
        cond, p = " AND date<=?", [upto]
    docs = db.execute("SELECT COALESCE(SUM(total),0) FROM documents WHERE contact_id=? AND side=? AND kind IN"
                      " ('invoice','credit') AND status IN ('open','paid')" + cond, [cid, side] + p).fetchone()[0]
    pays = db.execute("SELECT COALESCE(SUM(amount),0) FROM payments WHERE contact_id=? AND direction=? AND voided=0"
                      + cond, [cid, "in" if side == "sale" else "out"] + p).fetchone()[0]
    refunds = db.execute("SELECT COALESCE(SUM(u.amount),0) FROM credit_uses u JOIN documents d ON d.id=u.credit_id"
                         " WHERE d.contact_id=? AND d.side=? AND u.refund_entry_id IS NOT NULL AND u.voided=0"
                         + cond.replace("date", "u.date"), [cid, side] + p).fetchone()[0]
    return docs - pays + refunds


def statement(db, cid, start, end):
    c = db.execute("SELECT * FROM contacts WHERE id=?", (cid,)).fetchone()
    side = _side(c)
    opening = _balance_to(db, cid, side, before=start)
    acts = []
    for d in db.execute("SELECT * FROM documents WHERE contact_id=? AND side=? AND kind IN ('invoice','credit') AND"
                        " status IN ('open','paid') AND date BETWEEN ? AND ? ORDER BY date, id", (cid, side, start, end)):
        word = ("Invoice" if side == "sale" else "Bill") if d["kind"] == "invoice" else \
            ("Credit note" if side == "sale" else "Supplier credit")
        acts.append(dict(date=d["date"], what=f"{word} {d['number']}", ref=d["reference"] or "", amount=d["total"],
                         due=d["due_date"], doc_id=d["id"]))
    for p in db.execute("SELECT * FROM payments WHERE contact_id=? AND direction=? AND voided=0 AND date BETWEEN ? AND ?"
                        " ORDER BY date, id", (cid, "in" if side == "sale" else "out", start, end)):
        acts.append(dict(date=p["date"], what="Payment received" if side == "sale" else "Payment made",
                         ref=p["reference"] or "", amount=-p["amount"], due=None, doc_id=None))
    for u in db.execute("SELECT u.*, d.number FROM credit_uses u JOIN documents d ON d.id=u.credit_id WHERE"
                        " d.contact_id=? AND d.side=? AND u.refund_entry_id IS NOT NULL AND u.voided=0 AND"
                        " u.date BETWEEN ? AND ?", (cid, side, start, end)):
        acts.append(dict(date=u["date"], what=f"Refund of {u['number']}", ref="", amount=u["amount"], due=None,
                         doc_id=None))
    acts.sort(key=lambda a: a["date"])
    run = opening
    for a in acts:
        run += a["amount"]
        a["balance"] = run
    closing = run
    ages = [0] * 5
    overdue = []
    asof = date.fromisoformat(end)
    for d in db.execute("SELECT * FROM documents WHERE contact_id=? AND side=? AND status='open' AND date<=?"
                        " ORDER BY due_date", (cid, side, end)):
        due = d["total"] - d["amount_paid"]
        if not due:
            continue
        days = (asof - date.fromisoformat(d["due_date"] or d["date"])).days
        ages[0 if days <= 0 else 1 if days <= 30 else 2 if days <= 60 else 3 if days <= 90 else 4] += due
        if days > 0 and due > 0 and d["kind"] == "invoice":
            overdue.append(dict(number=d["number"], due_date=d["due_date"], days=days, due=due, doc_id=d["id"]))
    late = {o["doc_id"] for o in overdue}
    for a in acts:
        a["overdue"] = a["doc_id"] in late
    return dict(contact=c, side=side, label="Customer" if side == "sale" else "Supplier", start=start, end=end,
                opening=opening, activity=acts, closing=closing, ages=ages, buckets=BUCKETS, overdue=overdue)


def payment_details(company):
    """The 'How to pay' lines from Setup, Company details (S36); [] when none are set."""
    keys = company.keys() if hasattr(company, "keys") else company
    get = (lambda k: company[k] if k in keys else None)
    lines = []
    if get("bank_account_name") or get("bank_bsb") or get("bank_account_no"):
        lines.append("Bank transfer: " + ", ".join(x for x in (
            get("bank_account_name") and f"Account name {get('bank_account_name')}",
            get("bank_name"),
            get("bank_bsb") and f"BSB {get('bank_bsb')}",
            get("bank_account_no") and f"Account {get('bank_account_no')}") if x))
    if get("payment_instructions"):
        lines.append(get("payment_instructions"))
    return lines


def with_balance(db, kind="customer"):
    """Contacts whose balance isn't zero today, for printing or emailing every statement at once."""
    side = "sale" if kind == "customer" else "purchase"
    today = date.today().isoformat()
    return [c for c in db.execute("SELECT * FROM contacts WHERE kind=? AND active=1 ORDER BY name", (kind,))
            if _balance_to(db, c["id"], side, upto=today)]
