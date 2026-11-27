"""Options on one quote (Good / Better / Best): the customer chooses one of them.

The quote's own lines are always ONE option's lines: the recommended option's while the customer decides, then the
chosen option's once they accept. So the quote's total and tax, the invoice it becomes and the Bookings job it makes
are always one option's, worked out exactly like any other quote (ledger.save_document). Every option's lines and
totals are kept in document_options (made by riyeser/measure/store.py ensure(), so every company file has it).

A quote with options can't become an invoice until it's marked accepted with the option the customer chose.
"""
import json

from .db import audit
from .ledger import PostingError, calc_line

LINE_KEYS = ("item_id", "description", "qty", "unit_price", "discount_pct", "account_id", "tax_code_id", "job_id",
             "measure_line")
MAX = 3


def _rate(db, tax_code_id, cache):
    if not tax_code_id:
        return 0
    if tax_code_id not in cache:
        r = db.execute("SELECT rate FROM tax_codes WHERE id=?", (tax_code_id,)).fetchone()
        cache[tax_code_id] = r["rate"] if r else 0
    return cache[tax_code_id]


def totals(db, lines, tax_inclusive=False):
    """(subtotal, tax, total) in cents, line by line the way save_document works them out (so they always match)."""
    cache, sub, tax = {}, 0, 0
    for l in lines:
        if not (l.get("item_id") or l.get("description") or l.get("unit_price")):
            continue
        n, t = calc_line(l.get("qty") or 0, l.get("unit_price") or 0, l.get("discount_pct") or 0,
                         _rate(db, l.get("tax_code_id"), cache), tax_inclusive)
        sub, tax = sub + n, tax + t
    return sub, tax, sub + tax


def clean_line(l):
    return {k: l.get(k) for k in LINE_KEYS}


def of(db, doc_id):
    """The quote's options, [] when it has none: [{'n', 'name', 'recommended', 'chosen', 'on_quote', 'lines',
    'subtotal', 'tax_total', 'total'}]."""
    try:
        rows = db.execute("SELECT * FROM document_options WHERE document_id=? ORDER BY n", (doc_id,)).fetchall()
    except Exception:   # a company file from before options
        return []
    if not rows:
        return []
    doc = db.execute("SELECT chosen_option, tax_inclusive FROM documents WHERE id=?", (doc_id,)).fetchone()
    chosen = doc["chosen_option"] if doc else None
    incl = bool(doc["tax_inclusive"]) if doc else False
    out, cache = [], {}
    for r in rows:
        try:
            lines = json.loads(r["lines"])
        except ValueError:
            lines = []
        for l in lines:   # what each line comes to, for showing (the amount printed is with tax when tax-inclusive)
            net, tax = calc_line(l.get("qty") or 0, l.get("unit_price") or 0, l.get("discount_pct") or 0,
                                 _rate(db, l.get("tax_code_id"), cache), incl)
            l["net_amount"], l["tax_amount"], l["amount"] = net, tax, net + (tax if incl else 0)
        out.append({"n": r["n"], "name": r["name"], "recommended": bool(r["recommended"]), "chosen": r["n"] == chosen,
                    "lines": lines, "subtotal": r["subtotal"], "tax_total": r["tax_total"], "total": r["total"]})
    cur = chosen or next((o["n"] for o in out if o["recommended"]), out[0]["n"])
    for o in out:
        o["on_quote"] = o["n"] == cur
    return out


def has(db, doc_id):
    return bool(of(db, doc_id))


def recommended(opts):
    return next((o for o in opts if o["recommended"]), opts[0] if opts else None)


def lowest(opts):
    return min((o["total"] for o in opts), default=0)


def save(db, doc_id, options, tax_inclusive=False):
    """Replace the quote's options: [{'name', 'lines', 'recommended'}] (2 or 3 of them)."""
    if not 2 <= len(options) <= MAX:
        raise PostingError(f"A quote has 2 or 3 options (this one has {len(options)}).")
    db.execute("DELETE FROM document_options WHERE document_id=?", (doc_id,))
    rec = next((i for i, o in enumerate(options) if o.get("recommended")), 0)
    for i, o in enumerate(options, 1):
        lines = [clean_line(l) for l in o["lines"]]
        sub, tax, tot = totals(db, lines, tax_inclusive)
        db.execute("INSERT INTO document_options (document_id, n, name, recommended, lines, subtotal, tax_total, total)"
                   " VALUES (?,?,?,?,?,?,?,?)", (doc_id, i, (o.get("name") or f"Option {i}")[:40], 1 if i - 1 == rec else 0,
                                                 json.dumps(lines), sub, tax, tot))
    db.execute("UPDATE documents SET chosen_option=NULL WHERE id=?", (doc_id,))


def clear(db, doc_id):
    try:
        db.execute("DELETE FROM document_options WHERE document_id=?", (doc_id,))
        db.execute("UPDATE documents SET chosen_option=NULL WHERE id=?", (doc_id,))
    except Exception:
        pass


def find(opts, value):
    """The option a customer picked, by its number (1, 2, 3) or its name (any case), or None."""
    if value is None:
        return None
    v = str(value).strip()
    if not v:
        return None
    for o in opts:
        if v == str(o["n"]) or v.lower() == o["name"].strip().lower():
            return o
    return None


def _put_lines(db, doc_id, lines):
    """Put these lines on the quote (its totals worked out again), keeping which lines Estimate made."""
    from .ledger import save_document
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    header = {"contact_id": doc["contact_id"], "date": doc["date"], "due_date": doc["due_date"],
              "reference": doc["reference"], "notes": doc["notes"], "tax_inclusive": bool(doc["tax_inclusive"]),
              "kind": doc["kind"] or "invoice"}
    keep = [dict(l) for l in lines if l.get("item_id") or l.get("description") or l.get("unit_price")]
    save_document(db, doc["side"], header, [dict(l) for l in keep], doc["status"], doc_id)
    ids = [r["id"] for r in db.execute("SELECT id FROM document_lines WHERE document_id=? ORDER BY id", (doc_id,))]
    mark = [i for i, l in zip(ids, keep) if l.get("measure_line")]
    if mark:
        db.execute(f"UPDATE document_lines SET measure_line=1 WHERE id IN ({','.join('?' * len(mark))})", mark)


def choose(db, doc_id, n):
    """The customer chose option n: its lines go on the quote (so the invoice and the job are that option)."""
    opts = of(db, doc_id)
    o = next((x for x in opts if x["n"] == n), None)
    if not o:
        raise PostingError("Choose one of the quote's options.")
    _put_lines(db, doc_id, o["lines"])
    db.execute("UPDATE documents SET chosen_option=? WHERE id=?", (n, doc_id))
    audit(db, "quote_option_chosen", f"document {doc_id}: {o['name']}")
    return o


def unchoose(db, doc_id):
    """Back to waiting: the recommended option goes back on the quote."""
    opts = of(db, doc_id)
    if not opts:
        return
    _put_lines(db, doc_id, recommended(opts)["lines"])
    db.execute("UPDATE documents SET chosen_option=NULL WHERE id=?", (doc_id,))


def sync_from_document(db, doc_id):
    """The quote was edited by hand: the option on it now (chosen, else recommended) takes the edited lines."""
    opts = of(db, doc_id)
    if not opts:
        return
    cur = next(o for o in opts if o["on_quote"])
    doc = db.execute("SELECT tax_inclusive FROM documents WHERE id=?", (doc_id,)).fetchone()
    lines = [clean_line(dict(r)) for r in db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id",
                                                      (doc_id,))]
    sub, tax, tot = totals(db, lines, bool(doc["tax_inclusive"]))
    db.execute("UPDATE document_options SET lines=?, subtotal=?, tax_total=?, total=? WHERE document_id=? AND n=?",
               (json.dumps(lines), sub, tax, tot, doc_id, cur["n"]))


def check_chosen(db, doc):
    """A quote with options becomes an invoice only once the customer's choice is recorded."""
    if doc and doc["status"] == "quote" and not doc["chosen_option"] and has(db, doc["id"]):
        raise PostingError(f"{doc['number']} has {len(of(db, doc['id']))} options. Mark it accepted with the option "
                           "the customer chose first, so the invoice is for that option.")


__all__ = ["of", "has", "save", "clear", "choose", "unchoose", "find", "totals", "recommended", "lowest",
           "sync_from_document", "check_chosen"]
