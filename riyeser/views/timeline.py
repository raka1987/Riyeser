"""A customer's (or supplier's) page as one timeline: quotes, orders, invoices, credit notes, payments, bookings and
notes, newest first, with what they owe now, what they paid this year and when you were last in touch."""
from datetime import date

from flask import g, url_for

from .. import perms
from ..ledger import fy_start
from .today import features, show_bookings

SHOW = [("all", "Everything"), ("docs", "Quotes & invoices"), ("pay", "Payments"), ("bk", "Bookings"),
        ("notes", "Notes")]


def _doc_item(d, sale, link):
    if d["kind"] == "credit":
        what, dot, short = ("Credit note" if sale else "Supplier credit"), "crd", "CN"
    elif d["kind"] == "payment_credit":
        what, dot, short = "Credit from a payment", "crd", "CR"
    elif d["status"] == "quote":
        what, dot, short = "Quote", "quo", "Q"
    elif d["status"] == "order":
        what, dot, short = ("Order" if sale else "Purchase order"), "quo", "O"
    else:
        what, dot, short = ("Invoice" if sale else "Bill"), "inv", "INV" if sale else "BILL"
    return dict(date=d["date"], sort=f"{d['date']} {d['created_at'] or ''}", group="docs", dot=dot, short=short,
                title=f"{what} {d['number']}", amount=abs(d["total"]), doc=d, link=link)


def contact_page(db, c, show="all"):
    sale = c["kind"] == "customer"
    side = "sale" if sale else "purchase"
    f = features()
    today = g.get("today") or date.today().isoformat()
    # Riyeser POS has no invoice screens: its sales show here without a link
    doc_link = f["product"] != "pos"
    items = []
    docs = db.execute("SELECT * FROM documents WHERE contact_id=? AND side=? ORDER BY date DESC, id DESC",
                      (c["id"], side)).fetchall()
    for d in docs:
        items.append(_doc_item(d, sale, url_for("documents.view", doc_id=d["id"]) if doc_link else None))
    pays = db.execute("SELECT p.*, a.name bank FROM payments p JOIN accounts a ON a.id=p.bank_account_id"
                      " WHERE p.contact_id=? ORDER BY p.date DESC, p.id DESC", (c["id"],)).fetchall()
    paid_for = {}
    for a in db.execute("SELECT a.payment_id, d.number FROM payment_allocations a JOIN documents d ON d.id=a.document_id"
                        " JOIN payments p ON p.id=a.payment_id WHERE p.contact_id=?", (c["id"],)):
        paid_for.setdefault(a["payment_id"], []).append(a["number"])
    for p in pays:
        items.append(dict(date=p["date"], sort=f"{p['date']} ~{p['id']:09d}", group="pay", dot="pay", short="$",
                          title=("Payment received" if p["direction"] == "in" else "Payment made"),
                          amount=p["amount"], pay=p, paid_for=paid_for.get(p["id"], []), link=None))
    bks = []
    if sale and show_bookings(db, f):
        from .bookings import customer_bookings
        bks = customer_bookings(db, c["id"])
        for b in bks:
            items.append(dict(date=b["starts_at"][:10], sort=b["starts_at"].replace("T", " "), group="bk", dot="bk",
                              short="BK", title=b["service"] or b["title"] or "Booking", booking=b, amount=None,
                              link=url_for("core.bookings_app") if not f["bookings_here"] else
                              url_for("bookings.edit", bid=b["id"])))
    notes = db.execute("SELECT n.*, u.full_name ufull, u.username uname, d.full_name dfull, d.username dname"
                       " FROM contact_notes n LEFT JOIN users u ON u.id=n.user_id LEFT JOIN users d ON d.id=n.done_by"
                       " WHERE n.contact_id=? ORDER BY n.date DESC, n.id DESC", (c["id"],)).fetchall()
    for n in notes:
        items.append(dict(date=n["date"], sort=f"{n['date']} {n['created_at']}", group="notes", dot="note", short="N",
                          title="Note", note=n, amount=None, link=None))
    counts = {k: sum(1 for i in items if k == "all" or i["group"] == k) for k, _ in SHOW}
    if show not in counts:
        show = "all"
    shown = sorted((i for i in items if show == "all" or i["group"] == show), key=lambda i: i["sort"], reverse=True)

    # totals
    owed = sum(d["total"] - d["amount_paid"] for d in docs if d["status"] == "open")
    year_from = fy_start(db, today)
    paid_year = sum(p["amount"] for p in pays if not p["voided"] and p["date"] >= year_from and
                    p["direction"] == ("in" if sale else "out"))
    overdue = sum(d["total"] - d["amount_paid"] for d in docs if d["status"] == "open" and d["kind"] == "invoice"
                  and d["due_date"] and d["due_date"] < today)
    touch = [n["date"] for n in notes] + [p["date"] for p in pays if not p["voided"]] + \
        [d["date"] for d in docs if d["status"] != "void"] + \
        [b["starts_at"][:10] for b in bks if b["starts_at"][:10] <= today and b["status"] not in ("cancelled",)]
    touch = [t for t in touch if t <= today]
    last = max(touch) if touch else None
    last_ago = (date.fromisoformat(today) - date.fromisoformat(last)).days if last else None
    follow = [n for n in notes if n["follow_up_on"] and not n["done_at"]]
    follow.sort(key=lambda n: n["follow_up_on"])
    area = "sales" if sale else "purchases"
    return dict(items=shown, counts=counts, show=show, shows=[s for s in SHOW if s[0] != "bk" or bks],
                balance=owed, overdue=overdue, paid_year=paid_year, year_from=year_from, last=last,
                last_ago=last_ago, follow=follow, today=today, doc_link=doc_link,
                can_note=perms.can(area, perms.EDIT), can_full=perms.can(area, perms.FULL),
                pos_here=f["product"] == "pos", purchases_here=f["purchases"])

