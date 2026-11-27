"""An estimate's price, and the Riyeser quote it makes.

price(): the measurements + the chosen trade templates + the quick changes on the Review step (markup %, a line's
rate or waste) -> lines grouped Labour / Materials / Other, with the profit for the business (never on the quote).

make_quote(): one click makes the quote in the shared quote system (valid until, accept/decline, -> invoice or
Bookings job in the other apps). Measuring again and pressing it again updates only the lines Estimate made; lines
typed into the quote by hand stay. A quote that's been accepted or invoiced is never changed.
"""
import json
from datetime import date

from flask import g

from ..db import linked, audit
from ..ledger import save_document, PostingError
from . import engine, store
from .units import round_up


def adjustments(takeoff):
    try:
        a = json.loads(takeoff["adjust"] or "{}")
        return a if isinstance(a, dict) else {}
    except (ValueError, TypeError):
        return {}


def price(db, takeoff, items=None):
    """{'lines', 'sections': [(name, lines)], 'total', 'profit', 'missing_rates', 'templates'}"""
    items = store.items_of(db, takeoff["id"]) if items is None else items
    adj = adjustments(takeoff)
    per = adj.get("lines") or {}
    markup = float(adj.get("markup_pct") or 0)
    prices = {r["id"]: (r["sell_price"], r["buy_price"]) for r in db.execute("SELECT id, sell_price, buy_price FROM items")}
    out, used = [], []
    for tid in store.template_ids(takeoff):
        t, tl = store.template(db, tid)
        if not t:
            continue
        used.append(t)
        for ln in tl:
            o = per.get(str(ln["id"])) or {}
            if o.get("rate") not in (None, ""):
                ln["rate"] = int(o["rate"])
            if o.get("waste_pct") not in (None, ""):
                ln["waste_pct"] = float(o["waste_pct"])
        out += engine.build_lines(t, tl, items, {k: v[0] for k, v in prices.items()}, {k: v[1] for k, v in prices.items()})
    if markup:
        for l in out:
            l["unit_price"] = int(round(l["unit_price"] * (1 + markup / 100.0)))
    sections = [(s, [l for l in out if l["section"] == s]) for s in engine.SECTIONS]
    return {"lines": out, "sections": [(s, ls) for s, ls in sections if ls], "total": engine.lines_total(out),
            "profit": engine.profit(out), "missing_rates": [l["description"] for l in out if not l["unit_price"]],
            "templates": used, "markup_pct": markup}


def _defaults(db):
    acct = linked(db, "default_income")
    row = db.execute("SELECT tax_code_id FROM accounts WHERE id=?", (acct,)).fetchone()
    co = db.execute("SELECT gst_registered FROM company WHERE id=1").fetchone()
    return acct, (row["tax_code_id"] if row and co and co["gst_registered"] else None)


def notes_for(db, takeoff, items):
    bits = [f"Measured with Riyeser Estimate: {takeoff['title']}."]
    if takeoff["address"]:
        bits.append(f"Job address: {takeoff['address']}.")
    if any(i["source"] == "map" for i in items):
        bits.append("Some sizes are estimates from satellite imagery, which may be out of date. They will be checked "
                    "on site before work starts.")
    if takeoff["notes"]:
        bits.append(takeoff["notes"])
    return "\n".join(bits)


def doc_lines(db, priced):
    acct, tax = _defaults(db)
    items = {r["id"]: r for r in db.execute("SELECT id, income_account_id, sale_tax_code_id FROM items")}
    out = []
    for l in priced["lines"]:
        it = items.get(l["item_id"]) if l["item_id"] else None
        qty = l["qty"]
        out.append({"item_id": l["item_id"], "description": f"{l['section']}: {l['description']}" + (f" [{l['unit_label']}]" if l.get("show_unit") else ""),
                    "qty": qty, "unit_price": l["unit_price"], "discount_pct": 0,
                    "account_id": (it["income_account_id"] if it and it["income_account_id"] else acct),
                    "tax_code_id": (it["sale_tax_code_id"] if it else tax), "job_id": None})
    return out


def quote_state(db, takeoff):
    """None (no quote yet) or the quote row and its state (waiting, accepted, declined, expired)."""
    if not takeoff["document_id"]:
        return None, None
    doc = db.execute("SELECT * FROM documents WHERE id=?", (takeoff["document_id"],)).fetchone()
    if not doc:
        return None, None
    from ..views.quotes import state
    return doc, state(doc)


def make_quote(db, takeoff_id):
    """Make (or update) the quote. Returns (document id, 'made'|'updated')."""
    t = db.execute("SELECT * FROM takeoffs WHERE id=?", (takeoff_id,)).fetchone()
    if not t:
        raise PostingError("That estimate doesn't exist.")
    if not t["contact_id"]:
        raise PostingError("Choose the customer first (step 1).")
    items = store.items_of(db, takeoff_id)
    if not items:
        raise PostingError("Add a measurement first (step 3).")
    if not store.template_ids(t):
        raise PostingError("Choose a trade template first (step 4).")
    priced = price(db, t, items)
    if not priced["lines"]:
        raise PostingError("The template didn't make any lines from these measurements. Check the template "
                           "uses what you measured (for example floor area for a room).")
    lines = doc_lines(db, priced)
    doc, st = quote_state(db, t)
    header = {"contact_id": t["contact_id"], "date": date.today().isoformat(), "reference": t["title"][:60],
              "notes": notes_for(db, t, items), "tax_inclusive": False}
    if doc and doc["status"] == "quote" and st in ("waiting", "expired", "declined") and not doc["converted_to"]:
        keep = [dict(r) for r in db.execute("SELECT * FROM document_lines WHERE document_id=? AND measure_line IS NULL"
                                            " ORDER BY id", (doc["id"],))]
        header["date"] = doc["date"]
        manual = [{k: r[k] for k in ("item_id", "description", "qty", "unit_price", "discount_pct", "account_id",
                                     "tax_code_id", "job_id")} for r in keep]
        did = save_document(db, "sale", header, manual + lines, "quote", doc["id"])
        ids = [r["id"] for r in db.execute("SELECT id FROM document_lines WHERE document_id=? ORDER BY id", (did,))]
        mark = ids[len(manual):]
        how = "updated"
    elif doc and (st == "accepted" or doc["converted_to"] or doc["status"] != "quote"):
        raise PostingError(f"Quote {doc['number']} has been accepted, so it isn't changed. Duplicate this estimate to "
                           "quote again.")
    else:
        did = save_document(db, "sale", header, lines, "quote")
        from ..views.quotes import set_valid_until
        set_valid_until(db, did, None, header["date"])
        mark = [r["id"] for r in db.execute("SELECT id FROM document_lines WHERE document_id=?", (did,))]
        how = "made"
    if mark:
        db.execute(f"UPDATE document_lines SET measure_line=1 WHERE id IN ({','.join('?' * len(mark))})", mark)
    db.execute("UPDATE takeoffs SET document_id=?, quoted_at=datetime('now','localtime'),"
               " updated_at=datetime('now','localtime') WHERE id=?", (did, takeoff_id))
    num = db.execute("SELECT number FROM documents WHERE id=?", (did,)).fetchone()["number"]
    audit(db, f"estimate_quote_{how}", f"{t['title']} -> {num}")
    return did, how


def status_of(db, takeoff, today=None):
    """The chip on the Estimates list: draft, sent, accepted, declined, expired."""
    doc, st = quote_state(db, takeoff)
    if not doc:
        return "draft"
    if st in ("accepted", "declined", "expired"):
        return st
    if takeoff["sent_at"] or db.execute("SELECT 1 FROM email_queue WHERE kind='document' AND ref_id=? LIMIT 1",
                                        (doc["id"],)).fetchone():
        return "sent"
    return "draft"


STATUS_LABELS = {"draft": "Draft", "sent": "Sent", "accepted": "Accepted", "declined": "Declined", "expired": "Expired"}


def duplicate(db, takeoff_id, title=None):
    """A copy of an estimate (sizes, plans, templates and quick changes) with no quote yet: reuse a past job."""
    t = db.execute("SELECT * FROM takeoffs WHERE id=?", (takeoff_id,)).fetchone()
    if not t:
        raise PostingError("That estimate doesn't exist.")
    nid = db.execute("INSERT INTO takeoffs (title, contact_id, address, units, templates, summary_on_pdf, map_view, notes,"
                     " method, adjust, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (title or f"{t['title']} (copy)", t["contact_id"], t["address"], t["units"], t["templates"],
                      t["summary_on_pdf"], t["map_view"], t["notes"], t["method"], t["adjust"],
                      g.user["id"] if g.get("user") else None)).lastrowid
    plan_map = {}
    for p in db.execute("SELECT * FROM takeoff_plans WHERE takeoff_id=?", (takeoff_id,)).fetchall():
        npid = db.execute("INSERT INTO takeoff_plans (takeoff_id, name, mime, data, pages) VALUES (?,?,?,?,?)",
                          (nid, p["name"], p["mime"], p["data"], p["pages"])).lastrowid
        plan_map[p["id"]] = npid
        db.execute("INSERT INTO takeoff_plan_pages (plan_id, page, scale, scale_note, width, height, snapshot)"
                   " SELECT ?, page, scale, scale_note, width, height, snapshot FROM takeoff_plan_pages WHERE plan_id=?",
                   (npid, p["id"]))
    for i in db.execute("SELECT * FROM takeoff_items WHERE takeoff_id=? ORDER BY sort, id", (takeoff_id,)).fetchall():
        db.execute("INSERT INTO takeoff_items (takeoff_id, kind, source, label, grp, color, data, plan_id, page, verified, sort)"
                   " VALUES (?,?,?,?,?,?,?,?,?,0,?)", (nid, i["kind"], i["source"], i["label"], i["grp"], i["color"],
                                                       i["data"], plan_map.get(i["plan_id"]), i["page"], i["sort"]))
    audit(db, "estimate_duplicated", f"{t['title']} -> {nid}")
    return nid


__all__ = ["price", "make_quote", "duplicate", "status_of", "round_up"]
