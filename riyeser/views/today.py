"""The Today screen (the home screen) and what each Riyeser app has, for it and the customer page."""
from datetime import date, timedelta

from flask import g

from .. import perms


def features():
    """What this app has. One code base makes five apps (riyeser/edition.py); run from source, everything is here."""
    from ..edition import app_product
    p = app_product()
    return {
        "product": p,
        "purchases": p not in ("invoices", "bookings", "pos"),
        "stock": p not in ("invoices", "bookings"),
        "bookings_here": p in (None, "bookings"),   # Accounting, Invoices and POS open Riyeser Bookings separately
        "expenses": p in (None, "basic", "enterprise"),
        "overview": p in (None, "basic", "enterprise"),
    }


def _has_bookings(db):
    try:
        return db.execute("SELECT 1 FROM bookings LIMIT 1").fetchone() is not None
    except Exception:
        return False


def show_bookings(db, f=None):
    """Bookings show where the app has them, or where the company file has some (made in Riyeser Bookings)."""
    f = f or features()
    return perms.can("bookings") and (f["bookings_here"] or _has_bookings(db))


def visible_kinds():
    return [k for k, area in (("customer", "sales"), ("supplier", "purchases")) if perms.can(area)]


def follow_ups_due(db, day, limit=20):
    kinds = visible_kinds()
    if not kinds:
        return []
    return db.execute(
        "SELECT n.*, c.name cname, c.kind ckind, c.phone cphone, u.full_name ufull, u.username uname"
        " FROM contact_notes n JOIN contacts c ON c.id=n.contact_id LEFT JOIN users u ON u.id=n.user_id"
        f" WHERE n.follow_up_on IS NOT NULL AND n.follow_up_on<=? AND n.done_at IS NULL"
        f" AND c.kind IN ({','.join('?' * len(kinds))}) ORDER BY n.follow_up_on, n.id LIMIT ?",
        (day, *kinds, limit)).fetchall()


def today_data(db):
    day = g.get("today") or date.today().isoformat()
    d = date.fromisoformat(day)
    monday = (d - timedelta(days=d.weekday())).isoformat()
    f = features()
    out = {"today": day, "monday": monday, "f": f, "label": f"{d:%A} {d.day} {d:%B %Y}"}
    if perms.can("sales"):
        out["sales"] = db.execute(
            "SELECT COALESCE(SUM(total),0) s, COUNT(CASE WHEN kind='invoice' THEN 1 END) n FROM documents"
            " WHERE side='sale' AND status IN ('open','paid') AND kind IN ('invoice','credit') AND date=?",
            (day,)).fetchone()
        out["money_in"] = db.execute(
            "SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM payments WHERE direction='in' AND voided=0"
            " AND date BETWEEN ? AND ?", (monday, day)).fetchone()
        out["unpaid"] = db.execute(
            "SELECT d.*, c.name cname, (d.due_date IS NOT NULL AND d.due_date < ?) overdue FROM documents d"
            " JOIN contacts c ON c.id=d.contact_id WHERE d.side='sale' AND d.status='open' AND d.kind='invoice'"
            " ORDER BY overdue DESC, d.due_date, d.id LIMIT 8", (day,)).fetchall()
        out["owed"] = db.execute(
            "SELECT COALESCE(SUM(total-amount_paid),0) s, COUNT(*) n,"
            " COALESCE(SUM(CASE WHEN due_date < ? THEN total-amount_paid END),0) over_s,"
            " COUNT(CASE WHEN due_date < ? THEN 1 END) over_n"
            " FROM documents WHERE side='sale' AND status='open' AND kind='invoice'", (day, day)).fetchone()
    if f["purchases"] and perms.can("purchases"):
        week = (d + timedelta(days=7)).isoformat()
        out["bills"] = db.execute(
            "SELECT d.*, c.name cname, (d.due_date IS NOT NULL AND d.due_date < ?) overdue FROM documents d"
            " JOIN contacts c ON c.id=d.contact_id WHERE d.side='purchase' AND d.status='open' AND d.kind='invoice'"
            " AND (d.due_date IS NULL OR d.due_date <= ?) ORDER BY overdue DESC, d.due_date, d.id LIMIT 8",
            (day, week)).fetchall()
        out["owe"] = db.execute(
            "SELECT COALESCE(SUM(total-amount_paid),0) s, COUNT(*) n FROM documents WHERE side='purchase'"
            " AND status='open' AND kind='invoice' AND (due_date IS NULL OR due_date <= ?)", (week,)).fetchone()
    if f["stock"] and perms.can("stock") and db.execute(
            "SELECT 1 FROM items WHERE is_inventoried=1 AND active=1 LIMIT 1").fetchone():
        out["low_stock"] = db.execute(
            "SELECT * FROM items WHERE is_inventoried=1 AND active=1 AND qty_on_hand<=reorder_level"
            " ORDER BY qty_on_hand - reorder_level, sku LIMIT 8").fetchall()
    if show_bookings(db, f):
        from .bookings import day_bookings
        out["bookings"] = [b for b in day_bookings(db, d) if b["status"] not in ("cancelled",)]
    if visible_kinds():
        out["follow_ups"] = follow_ups_due(db, day)
    if f["expenses"] and perms.can("expenses", perms.FULL):
        out["claims"] = db.execute("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM expense_claims"
                                   " WHERE status='waiting'").fetchone()
    return out
