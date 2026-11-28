"""A quote whose tax rate has changed since it was made (Country and tax: "Change my GST code to 15% for new
transactions" keeps the old code as GST10, no longer in use, with the new GST as its successor).

When such a quote becomes an invoice (Convert / Make the invoice, or Bookings invoicing a job made from it), the
person chooses, on a short panel, before anything is created:
  - use the current rate, adding the extra tax (net prices stay the same, the tax goes up)            -> "add"
  - use the current rate, keeping the customer's total the same (the net is worked back from it)    -> "same_total"
  - keep the quoted rate                                                                            -> "keep"
The quote itself never changes; only the new invoice's lines differ. The choice is audited. No panel otherwise.
"""
from .ledger import calc_line

CHOICES = ("add", "same_total", "keep")


def successor(db, tax_code_id):
    """The code that replaced this one (followed to the one in use), or None if it's in use / wasn't replaced."""
    seen = set()
    row = db.execute("SELECT * FROM tax_codes WHERE id=?", (tax_code_id,)).fetchone() if tax_code_id else None
    if not row or row["active"] or not row["replaced_by"]:
        return None
    first_kind = row["kind"]
    while row and not row["active"] and row["replaced_by"] and row["id"] not in seen:
        seen.add(row["id"])
        row = db.execute("SELECT * FROM tax_codes WHERE id=?", (row["replaced_by"],)).fetchone()
    if not row or not row["active"] or row["kind"] != first_kind:
        return None
    return row


def _lines(db, doc_id):
    return [dict(r) for r in db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (doc_id,))]


def _rate(db, tid, cache):
    if not tid:
        return 0
    if tid not in cache:
        r = db.execute("SELECT rate FROM tax_codes WHERE id=?", (tid,)).fetchone()
        cache[tid] = (r["rate"] or 0) if r else 0
    return cache[tid]


def stale(db, doc_id):
    """{old code id: (old code row, successor row)} for the quote's lines whose code was replaced; {} = none."""
    out = {}
    for l in _lines(db, doc_id):
        tid = l.get("tax_code_id")
        if tid and tid not in out:
            s = successor(db, tid)
            if s is not None:
                out[tid] = (db.execute("SELECT * FROM tax_codes WHERE id=?", (tid,)).fetchone(), s)
    return out


def plan(db, doc_id, choice):
    """(tax_inclusive, lines) for the invoice made from this quote with this choice. The quote isn't touched."""
    doc = db.execute("SELECT tax_inclusive FROM documents WHERE id=?", (doc_id,)).fetchone()
    incl = bool(doc["tax_inclusive"])
    lines = _lines(db, doc_id)
    if choice not in CHOICES or choice == "keep":
        return incl, lines
    swap = {old: s["id"] for old, (_o, s) in stale(db, doc_id).items()}
    cache = {}
    if choice == "add":
        for l in lines:
            if l.get("tax_code_id") in swap:
                new = swap[l["tax_code_id"]]
                if incl:  # prices include tax: raise each price so its net stays as quoted
                    r_old, r_new = _rate(db, l["tax_code_id"], cache), _rate(db, new, cache)
                    l["unit_price"] = round((l["unit_price"] or 0) * (100 + r_new) / (100 + r_old))
                l["tax_code_id"] = new
        return incl, lines
    # same_total: every line keeps its tax-inclusive amount exactly; the invoice's prices include tax
    out, residual = [], 0
    for l in lines:
        target = (l["net_amount"] or 0) + (l["tax_amount"] or 0)      # what the customer was quoted for this line
        if l.get("tax_code_id") in swap:
            l["tax_code_id"] = swap[l["tax_code_id"]]
        factor = float(l["qty"] or 0) * (1 - (l["discount_pct"] or 0) / 100.0)
        if factor:
            l["unit_price"] = round(target / factor)
        gross = sum(calc_line(l["qty"] or 0, l["unit_price"] or 0, l["discount_pct"] or 0, 0, True))
        residual += target - gross
        out.append(l)
    if residual:   # cents lost to rounding a unit price: put them on a line whose price is exact (qty 1, no discount)
        exact = next((l for l in out if float(l["qty"] or 0) == 1 and not l["discount_pct"]), None)
        if exact is not None:
            exact["unit_price"] = (exact["unit_price"] or 0) + residual
        else:
            first = out[0]
            out.append({"description": "Rounding (tax rate change)", "qty": 1, "unit_price": residual,
                        "discount_pct": 0, "account_id": first["account_id"], "tax_code_id": first["tax_code_id"],
                        "job_id": first.get("job_id")})
    return True, out


def totals(db, incl, lines):
    cache, sub, tax = {}, 0, 0
    for l in lines:
        n, t = calc_line(l.get("qty") or 0, l.get("unit_price") or 0, l.get("discount_pct") or 0,
                         _rate(db, l.get("tax_code_id"), cache), incl)
        sub, tax = sub + n, tax + t
    return {"subtotal": sub, "tax": tax, "total": sub + tax}


def panel(db, doc_id):
    """What the panel shows, or None when no line's code has been replaced (then there's no panel at all)."""
    st = stale(db, doc_id)
    if not st:
        return None
    pairs = sorted({(o["rate"], s["rate"]) for o, s in st.values()})
    return {"old_rate": pairs[0][0], "new_rate": pairs[0][1], "pairs": pairs,
            "codes": [(o["code"], s["code"]) for o, s in st.values()],
            "totals": {c: totals(db, *plan(db, doc_id, c)) for c in CHOICES}}


def choice_from(form):
    """'add' / 'same_total' / 'keep' from the panel's two questions, or None when the panel wasn't answered."""
    rate = form.get("rate_choice")
    if rate == "quoted":
        return "keep"
    if rate == "current":
        return "same_total" if form.get("rate_how") == "same_total" else "add"
    return None


def describe(choice, p, tax, money):
    t = p["totals"][choice]["total"]
    return {"add": f"used the current rate ({p['new_rate']:g}%) and added the extra {tax}, total {money(t)}",
            "same_total": f"used the current rate ({p['new_rate']:g}%) and kept the customer's total, {money(t)}",
            "keep": f"kept the quoted rate ({p['old_rate']:g}%), total {money(t)}"}[choice]
