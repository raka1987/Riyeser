"""Riyeser POS promotions: a percentage or an amount off a product, a category or the whole sale, with optional
dates, days and times, and an optional code the cashier types at the till.

The rules, kept simple (the till's script in templates/pos/front.html works them out the same way, and the server's
answer here is the one that counts):

  * Each item on the sale gets its one best promotion (the one that takes the most off). Promotions don't stack on
    an item, and a discount the cashier typed on the item is kept when it is bigger.
  * "Amount off" a product or a category comes off each one sold. "Amount off the whole sale" comes off the sale's
    total once (the biggest such promotion), after the items' own promotions, shared across the items.
  * A promotion with a code only counts when that code was typed at the till.

Money is whole cents throughout. A promotion is stored on the invoice as each line's discount, so stock, tax and
every report stay right; pos_sale_promos remembers which promotion took how much, for the receipt.
"""
import json
from datetime import datetime

from .db import round_cents

KINDS = {"percent": "Percentage off", "amount": "Amount off"}
SCOPES = {"sale": "The whole sale", "category": "A category", "item": "One product"}
DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def days_of(p):
    try:
        v = json.loads(p["days"]) if p["days"] else []
    except (ValueError, TypeError):
        v = []
    return sorted({int(x) for x in v if str(x).isdigit() and 0 <= int(x) <= 6})


def as_json(p):
    """A promotion as the till's script needs it."""
    return dict(id=p["id"], name=p["name"], kind=p["kind"], value=p["value"], scope=p["scope"],
                category=p["category"], item_id=p["item_id"], start=p["start_date"], end=p["end_date"],
                days=days_of(p), time_from=p["time_from"], time_to=p["time_to"],
                code=(p["code"] or "").strip().upper() or None)


def active_promotions(db):
    return [as_json(p) for p in db.execute("SELECT * FROM pos_promotions WHERE active=1 ORDER BY id")]


def is_on(p, now=None, codes=()):
    """Is this promotion running right now (dates, days and times), and was its code typed (when it has one)?"""
    now = now or datetime.now()
    day, hm = now.strftime("%Y-%m-%d"), now.strftime("%H:%M")
    if p["start"] and day < p["start"]:
        return False
    if p["end"] and day > p["end"]:
        return False
    if p["days"] and now.weekday() not in p["days"]:
        return False
    f, t = p["time_from"] or "", p["time_to"] or ""
    if f and t and f > t:              # over midnight, e.g. 22:00 to 02:00
        if not (hm >= f or hm < t):
            return False
    else:
        if f and hm < f:
            return False
        if t and hm >= t:
            return False
    if p["code"] and p["code"] not in {str(c).strip().upper() for c in codes or ()}:
        return False
    return True


def when_text(p):
    """"Mon to Fri, 3 pm to 5 pm, until 31 Dec" for the Promotions list."""
    bits = []
    d = p["days"]
    if d and len(d) < 7:
        runs = d == list(range(d[0], d[-1] + 1)) and len(d) > 2
        bits.append(f"{DAY_NAMES[d[0]]} to {DAY_NAMES[d[-1]]}" if runs else ", ".join(DAY_NAMES[x] for x in d))

    def clock(hm):
        h, m = int(hm[:2]), hm[3:5]
        return f"{(h % 12) or 12}{'' if m == '00' else ':' + m} {'am' if h < 12 else 'pm'}"
    if p["time_from"] and p["time_to"]:
        bits.append(f"{clock(p['time_from'])} to {clock(p['time_to'])}")
    elif p["time_from"]:
        bits.append(f"from {clock(p['time_from'])}")
    elif p["time_to"]:
        bits.append(f"until {clock(p['time_to'])}")
    if p["start"] and p["end"]:
        bits.append(f"{p['start']} to {p['end']}")
    elif p["start"]:
        bits.append(f"from {p['start']}")
    elif p["end"]:
        bits.append(f"until {p['end']}")
    return ", ".join(bits) or "Always"


def _fits(p, line):
    if p["scope"] == "item":
        return p["item_id"] in (line["item_id"], line.get("parent_id"))
    if p["scope"] == "category":
        return bool(p["category"]) and (line.get("category") or "") == p["category"]
    return True


def price(promos, lines, now=None, codes=()):
    """Work out a sale. lines: [{item_id, parent_id, category, qty, price (each, in cents, tax included),
    manual_pct}]. Returns (priced lines, the whole-sale promotion or None): each priced line has base (before any
    discount), total (what the customer pays for it), promo ({id, name, saved, pct} or None) and sale_share (its part of
    an amount off the whole sale)."""
    live = [p for p in promos if is_on(p, now, codes)]
    out = []
    for l in lines:
        qty, each = float(l["qty"]), l["price"]
        base = round_cents(qty * each)
        total = round_cents(qty * each * (1 - (l.get("manual_pct") or 0) / 100.0))
        best = None
        for p in live:
            if (p["kind"] == "amount" and p["scope"] == "sale") or not _fits(p, l):
                continue
            t = round_cents(qty * each * (1 - min(max(p["value"], 0), 100) / 100.0)) if p["kind"] == "percent" \
                else round_cents(qty * max(each - int(p["value"]), 0))
            if best is None or t < best[0]:
                best = (t, p)
        promo = None
        if best and best[0] < total:
            total, promo = best[0], dict(id=best[1]["id"], name=best[1]["name"], saved=base - best[0],
                                         pct=best[1]["value"] if best[1]["kind"] == "percent" else None)
        out.append(dict(l, base=base, total=total, promo=promo, sale_share=0))
    whole = None
    offers = [p for p in live if p["kind"] == "amount" and p["scope"] == "sale" and p["value"] > 0]
    total = sum(x["total"] for x in out)
    if offers and total > 0:
        p = max(offers, key=lambda x: (x["value"], -x["id"]))
        off = min(int(p["value"]), total)
        cum = given = 0
        for x in out:                       # shared across the items in whole cents, nothing lost to rounding
            cum += x["total"]
            share = (off * cum) // total - given
            given += share
            x["sale_share"] = share
            x["total"] -= share
        whole = dict(id=p["id"], name=p["name"], saved=off)
    return out, whole


def discount_pct(qty, each, total):
    """The line discount (%) that makes an invoice line of qty at each come to exactly total cents."""
    gross = float(qty) * each
    if gross <= 0 or total >= round_cents(gross):
        return 0.0
    pct = (1 - total / gross) * 100.0
    for nudge in (0, 1e-9, -1e-9, 1e-7, -1e-7):
        if round_cents(gross * (1 - (pct + nudge) / 100.0)) == total:
            return pct + nudge
    return pct


def apply(db, lines, codes=(), now=None):
    """Put the promotions running now onto a sale's invoice lines (from views/pos.build_sale_lines), in place.
    Returns what to remember for the receipt: [(line index, promotion id, name, cents, whole)], whole = True for
    the line's share of an amount off the whole sale."""
    promos = active_promotions(db)
    if not promos:
        return []
    info = {r["id"]: r for r in db.execute("SELECT id, parent_id, category FROM items WHERE id IN (%s)" % ",".join(
        "?" * len(lines)), [l["item_id"] for l in lines])} if lines else {}
    cart = [dict(item_id=l["item_id"], parent_id=info[l["item_id"]]["parent_id"] if l["item_id"] in info else None,
                 category=_category(db, info.get(l["item_id"])), qty=l["qty"], price=l["unit_price"],
                 manual_pct=l["discount_pct"]) for l in lines]
    priced, whole = price(promos, cart, now, codes)
    used = []
    for n, (l, x) in enumerate(zip(lines, priced)):
        if x["promo"] or x["sale_share"]:
            # a percentage promotion is stored as that percentage (10% reads as 10%); anything else as the
            # discount that brings the line to its exact cents
            plain = x["promo"] and x["promo"]["pct"] is not None and not x["sale_share"]
            l["discount_pct"] = min(max(float(x["promo"]["pct"]), 0), 100) if plain else \
                discount_pct(l["qty"], l["unit_price"], x["total"])
            l["promo_applied"] = True
        if x["promo"]:
            used.append((n, x["promo"]["id"], x["promo"]["name"], x["promo"]["saved"], False))
        if x["sale_share"]:
            used.append((n, whole["id"], whole["name"], x["sale_share"], True))
    return used


def _category(db, row):
    """An item's category; a variant uses its product's."""
    if row is None:
        return None
    if row["category"] or not row["parent_id"]:
        return row["category"]
    par = db.execute("SELECT category FROM items WHERE id=?", (row["parent_id"],)).fetchone()
    return par["category"] if par else None


def remember(db, doc_id, used):
    """Save which promotions took how much on this invoice (for the receipt)."""
    if not used:
        return
    ids = [r["id"] for r in db.execute("SELECT id FROM document_lines WHERE document_id=? ORDER BY id", (doc_id,))]
    for n, pid, name, amount, whole in used:
        db.execute("INSERT INTO pos_sale_promos (document_id, line_id, promo_id, name, amount, whole) VALUES"
                   " (?,?,?,?,?,?)", (doc_id, ids[n] if n < len(ids) else None, pid, name, amount, 1 if whole else 0))


def on_document(db, doc_id):
    """For a receipt: dict(lines={line id: [(name, cents)]} (each item's own promotion), whole=[(name, cents)] (off
    the whole sale), back={line id: cents} (what to add back to a line to show it at its full price), saved=cents).
    The receipt shows each item at its full price, then what each promotion took off, so it adds up to the total."""
    lines, whole, back, saved = {}, {}, {}, 0
    for r in db.execute("SELECT * FROM pos_sale_promos WHERE document_id=? ORDER BY id", (doc_id,)):
        if r["whole"]:
            whole[r["name"]] = whole.get(r["name"], 0) + r["amount"]
        else:
            lines.setdefault(r["line_id"], []).append((r["name"], r["amount"]))
        back[r["line_id"]] = back.get(r["line_id"], 0) + r["amount"]
        saved += r["amount"]
    return dict(lines=lines, whole=list(whole.items()), back=back, saved=saved)
