"""A trade template + a takeoff's measurements -> quote lines.

Each template line reads one quantity (its "basis": floor_area, wall_area, roof_area, length, posts, hours...):

    base     = the takeoff's total of that quantity (only measurements in `group`, when the line names one)
    amount   = base in the line's unit (m², sq ft, squares, m, ft, m³, cu yd, each, hours) x factor x (1 + waste %)
    qty      = whole packs when the line has a pack size (tiles per box, sheets, tins), whole numbers for counts,
               otherwise 2 decimal places
    price    = qty x rate (the rate per unit or per pack; a linked stock item's sell price when the rate is blank)
    a line's minimum charge raises a small line to that amount; a template's minimum charge tops up the whole quote.

Lines whose quantity comes to 0 are left out, so one template works for jobs with and without (say) gates.
"""
import math

from . import units as U
from .geometry import QUANTITIES, takeoff_quantities

SECTIONS = ("Labour", "Materials", "Other")
FIXED = "fixed"   # a basis that's always 1 (call-out fee, skip hire, scaffold)


def group_items(items, group):
    """Measurements in this group (case-insensitive, by group name or label); all of them when group is blank."""
    g = (group or "").strip().lower()
    if not g:
        return list(items)
    return [i for i in items if g in (i.get("group") or "").lower() or g in (i.get("label") or "").lower()]


def line_amount(line, base_si):
    """(qty, unit label, explanation) for one template line, from the SI base quantity."""
    unit = line.get("unit") or "each"
    dim = U.dimension(unit)
    base = U.from_si(base_si, unit) if dim in ("length", "area", "volume") else float(base_si)
    factor = float(line.get("factor") if line.get("factor") not in (None, "") else 1)
    waste = float(line.get("waste_pct") or 0)
    raw = base * factor * (1 + waste / 100.0)
    pack = float(line.get("pack_size") or 0)
    label = (line.get("unit_label") or "").strip()
    if pack > 0:
        qty = U.round_up(raw / pack)
        label = label or "packs"
    elif dim in ("count", "fixed") or line.get("whole"):
        qty = U.round_up(raw)
    else:
        qty = round(raw, 2)
    label = label or U.label(unit)
    bits = [f"{_n(base)} {U.label(unit)}"]
    if factor != 1:
        bits.append(f"x {_n(factor, 4)}")
    if waste:
        bits.append(f"+ {_n(waste)}% waste")
    if pack > 0:
        bits.append(f"in {label} of {_n(pack)}")
    return qty, label, " ".join(bits)


def _n(v, places=2):
    s = f"{v:,.{places}f}".rstrip("0").rstrip(".")
    return s or "0"


def build_lines(template, lines, items, item_prices=None, item_costs=None):
    """Quote lines for one template: [{'section', 'description', 'qty', 'unit_price' (cents), 'unit_cost', 'item_id',
    'basis', 'tl_id'}]. `item_prices` / `item_costs` map stock item id -> sell / buy price in cents (used when a line's
    rate / cost is blank)."""
    item_prices = item_prices or {}
    item_costs = item_costs or {}
    out = []
    for ln in sorted(lines, key=lambda l: (SECTIONS.index(l.get("section")) if l.get("section") in SECTIONS else 9,
                                           l.get("sort") or 0, l.get("id") or 0)):
        basis = ln.get("basis") or FIXED
        if basis == FIXED:
            base = 1.0
        else:
            base = takeoff_quantities(group_items(items, ln.get("group_filter"))).get(basis, 0.0)
        if base <= 0:
            continue
        qty, label, why = line_amount(ln, base)
        pack = float(ln.get("pack_size") or 0)
        if qty <= 0:
            continue
        rate = ln.get("rate")
        if rate in (None, "") and ln.get("item_id"):
            rate = item_prices.get(ln["item_id"], 0)
        rate = int(rate or 0)
        cost = ln.get("cost")
        if cost in (None, "") and ln.get("item_id"):
            cost = item_costs.get(ln["item_id"])
        desc = ln.get("description") or QUANTITIES.get(basis, (basis,))[0]
        note = "" if basis == FIXED else f" ({why})"
        line = {"section": ln.get("section") or "Other", "description": f"{desc}{note}", "qty": qty,
                "unit_label": label, "unit_price": rate, "item_id": ln.get("item_id") or None, "basis": basis,
                "tl_id": ln.get("id"), "unit_cost": None if cost in (None, "") else int(cost), "rate_set": rate > 0,
                "template": template.get("name"), "show_unit": pack > 0 or bool((ln.get("unit_label") or "").strip())}
        minimum = int(ln.get("min_charge") or 0)
        if minimum and qty * rate < minimum:
            line.update(qty=1, unit_price=minimum, unit_cost=None if line["unit_cost"] is None else int(line["unit_cost"] * qty),
                        description=f"{desc} (minimum charge{note and ';' + note[1:-1]})")
        out.append(line)
    minimum = int(template.get("min_charge") or 0)
    total = sum(round(l["qty"] * l["unit_price"]) for l in out)
    if minimum and total < minimum:
        out.append({"section": "Other", "description": f"Minimum charge for {template.get('name') or 'this job'}",
                    "qty": 1, "unit_label": "item", "unit_price": minimum - total, "item_id": None, "basis": FIXED,
                    "tl_id": None, "unit_cost": 0, "rate_set": True, "template": template.get("name")})
    return out


def lines_total(lines):
    return sum(int(round(l["qty"] * l["unit_price"])) for l in lines)


def profit(lines):
    """{'sell', 'cost', 'profit', 'margin_pct', 'unknown'}: cost from each line's cost (lines without one count as all
    profit and are listed in 'unknown'). For the business only: never on the quote."""
    sell = lines_total(lines)
    cost = sum(int(round(l["qty"] * l["unit_cost"])) for l in lines if l.get("unit_cost") is not None)
    unknown = [l["description"] for l in lines if l.get("unit_cost") is None and l["unit_price"]]
    p = sell - cost
    return {"sell": sell, "cost": cost, "profit": p, "margin_pct": round(100.0 * p / sell, 1) if sell else 0.0,
            "unknown": unknown}


def describe(lines):
    """Plain text for a quick look (tests, logs)."""
    return "\n".join(f"{l['section']}: {l['description']} | {l['qty']} {l['unit_label']} @ {l['unit_price']}"
                     for l in lines)


def ceil(x):
    return int(math.ceil(x))
