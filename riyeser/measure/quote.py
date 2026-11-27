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


# ---------------------------------------------------------------- Good / Better / Best
OPTION_NAMES = ("Good", "Better", "Best")
MAX_OPTIONS = 3


def options(takeoff):
    """The estimate's options, or None for one price: {'list': [{'name', 'templates', 'adjust'}], 'recommended': i}."""
    try:
        o = json.loads(takeoff["options"] or "null") if "options" in takeoff.keys() else None
    except (ValueError, TypeError):
        return None
    if not isinstance(o, dict) or not isinstance(o.get("list"), list) or len(o["list"]) < 2:
        return None
    lst = []
    for i, x in enumerate(o["list"][:MAX_OPTIONS]):
        x = x if isinstance(x, dict) else {}
        lst.append({"name": (str(x.get("name") or "").strip() or f"Option {i + 1}")[:40],
                    "templates": [int(t) for t in (x.get("templates") or []) if str(t).isdigit()],
                    "adjust": x.get("adjust") if isinstance(x.get("adjust"), dict) else {}})
    rec = o.get("recommended")
    rec = rec if isinstance(rec, int) and 0 <= rec < len(lst) else min(1, len(lst) - 1)
    return {"list": lst, "recommended": rec}


def save_options(db, tid, opts):
    db.execute("UPDATE takeoffs SET options=?, updated_at=datetime('now','localtime') WHERE id=?",
               (json.dumps(opts) if opts else None, tid))


def start_options(takeoff, n=3):
    """Add options: the current price copied into Good, Better and Best (Better recommended)."""
    base = {"templates": store.template_ids(takeoff), "adjust": adjustments(takeoff)}
    return {"list": [dict(json.loads(json.dumps(base)), name=OPTION_NAMES[i]) for i in range(n)],
            "recommended": 1 if n > 2 else 0}


def option_takeoff(takeoff, opt):
    """The estimate as one option sees it: its own templates and quick changes (markup, rates, waste)."""
    d = dict(takeoff)
    d["templates"] = json.dumps(opt.get("templates") or [])
    d["adjust"] = json.dumps(opt.get("adjust") or {})
    return d


def price_options(db, takeoff, items=None):
    """[(option, priced)] for every option (each priced like a one-price estimate), or [] for one price."""
    opts = options(takeoff)
    if not opts:
        return []
    items = store.items_of(db, takeoff["id"]) if items is None else items
    out = []
    for i, o in enumerate(opts["list"]):
        p = price(db, option_takeoff(takeoff, o), items)
        out.append((dict(o, index=i, recommended=i == opts["recommended"]), p))
    return out


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
    if any(i["source"] == "scan" and (i["data"] or {}).get("estimated") for i in items):
        bits.append("Some room sizes were estimated from a 3D scan. They will be checked on site before work starts.")
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
    if not store.template_ids(t) and not options(t):
        raise PostingError("Choose a trade template first (step 4).")
    from .. import quote_options as QO
    opts = price_options(db, t, items)
    if opts:
        for o, p in opts:
            if not o["templates"]:
                raise PostingError(f"Choose a template for option {o['name']} (step 5).")
            if not p["lines"]:
                raise PostingError(f"Option {o['name']} has no lines: its template doesn't use what you measured.")
        sets = [doc_lines(db, p) for _o, p in opts]
        rec = next(i for i, (o, _p) in enumerate(opts) if o["recommended"])
    else:
        priced = price(db, t, items)
        if not priced["lines"]:
            raise PostingError("The template didn't make any lines from these measurements. Check the template "
                               "uses what you measured (for example floor area for a room).")
        sets, rec = [doc_lines(db, priced)], 0
    for ls in sets:
        for l in ls:
            l["measure_line"] = 1
    lines = [dict(l) for l in sets[rec]]
    doc, st = quote_state(db, t)
    header = {"contact_id": t["contact_id"], "date": date.today().isoformat(), "reference": t["title"][:60],
              "notes": notes_for(db, t, items), "tax_inclusive": False}
    if doc and doc["status"] == "quote" and st in ("waiting", "expired", "declined") and not doc["converted_to"]:
        keep = [dict(r) for r in db.execute("SELECT * FROM document_lines WHERE document_id=? AND measure_line IS NULL"
                                            " ORDER BY id", (doc["id"],))]
        header["date"] = doc["date"]
        manual = [{k: r[k] for k in ("item_id", "description", "qty", "unit_price", "discount_pct", "account_id",
                                     "tax_code_id", "job_id")} for r in keep]
        if doc["chosen_option"]:   # declined after a choice: the recommended option goes back on
            db.execute("UPDATE documents SET chosen_option=NULL WHERE id=?", (doc["id"],))
        did = save_document(db, "sale", header, manual + lines, "quote", doc["id"])
        ids = [r["id"] for r in db.execute("SELECT id FROM document_lines WHERE document_id=? ORDER BY id", (did,))]
        mark = ids[len(manual):]
        how = "updated"
    elif doc and (st == "accepted" or doc["converted_to"] or doc["status"] != "quote"):
        raise PostingError(f"Quote {doc['number']} has been accepted, so it isn't changed. Duplicate this estimate to "
                           "quote again.")
    else:
        manual = []
        did = save_document(db, "sale", header, lines, "quote")
        from ..views.quotes import set_valid_until
        set_valid_until(db, did, None, header["date"])
        mark = [r["id"] for r in db.execute("SELECT id FROM document_lines WHERE document_id=?", (did,))]
        how = "made"
    if mark:
        db.execute(f"UPDATE document_lines SET measure_line=1 WHERE id IN ({','.join('?' * len(mark))})", mark)
    if opts:   # every option on the one quote (the lines typed into the quote by hand go with each of them)
        QO.save(db, did, [{"name": o["name"], "recommended": o["recommended"],
                           "lines": [dict(m) for m in manual] + [dict(l) for l in ls]}
                          for (o, _p), ls in zip(opts, sets)], tax_inclusive=False)
    else:
        QO.clear(db, did)
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
                     " method, adjust, options, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (title or f"{t['title']} (copy)", t["contact_id"], t["address"], t["units"], t["templates"],
                      t["summary_on_pdf"], t["map_view"], t["notes"], t["method"], t["adjust"], t["options"],
                      g.user["id"] if g.get("user") else None)).lastrowid
    plan_map = {}
    for p in db.execute("SELECT * FROM takeoff_plans WHERE takeoff_id=?", (takeoff_id,)).fetchall():
        npid = db.execute("INSERT INTO takeoff_plans (takeoff_id, name, mime, data, pages) VALUES (?,?,?,?,?)",
                          (nid, p["name"], p["mime"], p["data"], p["pages"])).lastrowid
        plan_map[p["id"]] = npid
        db.execute("INSERT INTO takeoff_plan_pages (plan_id, page, scale, scale_note, width, height, snapshot)"
                   " SELECT ?, page, scale, scale_note, width, height, snapshot FROM takeoff_plan_pages WHERE plan_id=?",
                   (npid, p["id"]))
    scan_map = {}
    for sc in db.execute("SELECT * FROM takeoff_scans WHERE takeoff_id=?", (takeoff_id,)).fetchall():
        scan_map[sc["id"]] = db.execute("INSERT INTO takeoff_scans (takeoff_id, name, format, quality, size, data, preview,"
                                        " result) VALUES (?,?,?,?,?,?,?,?)", (nid, sc["name"], sc["format"], sc["quality"],
                                                                             sc["size"], sc["data"], sc["preview"],
                                                                             sc["result"])).lastrowid
    for i in db.execute("SELECT * FROM takeoff_items WHERE takeoff_id=? ORDER BY sort, id", (takeoff_id,)).fetchall():
        data = i["data"]
        if i["source"] == "scan":
            try:
                d = json.loads(data)
                if d.get("scan_id") in scan_map:
                    d["scan_id"] = scan_map[d["scan_id"]]
                    data = json.dumps(d)
            except ValueError:
                pass
        db.execute("INSERT INTO takeoff_items (takeoff_id, kind, source, label, grp, color, data, plan_id, page, verified, sort)"
                   " VALUES (?,?,?,?,?,?,?,?,?,0,?)", (nid, i["kind"], i["source"], i["label"], i["grp"], i["color"],
                                                       data, plan_map.get(i["plan_id"]), i["page"], i["sort"]))
    for ph in db.execute("SELECT * FROM takeoff_photos WHERE takeoff_id=? ORDER BY sort, id", (takeoff_id,)).fetchall():
        db.execute("INSERT INTO takeoff_photos (takeoff_id, name, mime, size, width, height, data, markup, flat, caption,"
                   " on_pdf, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                   (nid, ph["name"], ph["mime"], ph["size"], ph["width"], ph["height"], ph["data"], ph["markup"],
                    ph["flat"], ph["caption"], ph["on_pdf"], ph["sort"]))
    audit(db, "estimate_duplicated", f"{t['title']} -> {nid}")
    return nid


__all__ = ["price", "make_quote", "duplicate", "status_of", "round_up", "options", "price_options", "start_options",
           "save_options", "option_takeoff"]
