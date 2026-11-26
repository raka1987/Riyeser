"""Low stock and reordering.

An item is low when what's on hand is at or below its reorder level (the same rule as the dashboard and the
Items to Reorder report). The list suggests how many to order: back up to the item's "reorder up to" level when it
has one, otherwise twice the reorder level, less what's already on order. "Order these" makes one purchase order per
supplier (the ordinary purchase order, so it prints, saves as a PDF and emails like any other).
"""
import math
from datetime import date, timedelta

from flask import render_template, request, redirect, url_for, flash, g

from ..db import get_db, audit
from ..ledger import save_document, PostingError
from .. import perms
from . import guarded, opt_float, opt_int
from .inventory import bp


def on_order(db):
    """{item_id: quantity still to come on open purchase orders}."""
    return {r[0]: r[1] for r in db.execute(
        "SELECT l.item_id, SUM(MAX(l.qty - l.qty_received, 0)) FROM document_lines l"
        " JOIN documents d ON d.id=l.document_id WHERE d.side='purchase' AND d.status='order'"
        " AND d.received_at IS NULL AND l.item_id IS NOT NULL GROUP BY l.item_id")}


def last_supplier(db, item_id):
    """The supplier this item was last ordered or bought from (when it has no preferred supplier)."""
    r = db.execute("SELECT d.contact_id FROM document_lines l JOIN documents d ON d.id=l.document_id"
                   " JOIN contacts c ON c.id=d.contact_id WHERE l.item_id=? AND d.side='purchase'"
                   " AND d.status IN ('order','open','paid') AND c.active=1 ORDER BY d.date DESC, d.id DESC LIMIT 1",
                   (item_id,)).fetchone()
    return r[0] if r else None


def target_level(item):
    """How many we'd like on hand after the order arrives."""
    if item["reorder_up_to"]:
        return item["reorder_up_to"]
    return max((item["reorder_level"] or 0) * 2, (item["reorder_level"] or 0) + 1)


def suggested_qty(item, coming=0):
    return max(math.ceil(target_level(item) - item["qty_on_hand"] - (coming or 0) - 1e-9), 0)


def low_stock(db, limit=None):
    """Stocked items at or below their reorder level, with what's on order, a suggested order and a supplier."""
    coming = on_order(db)
    rows = db.execute("SELECT i.*, c.name supplier_name FROM items i LEFT JOIN contacts c ON c.id=i.supplier_id"
                      " WHERE i.is_inventoried=1 AND i.active=1 AND i.qty_on_hand<=i.reorder_level"
                      " ORDER BY i.sku" + (f" LIMIT {int(limit)}" if limit else "")).fetchall()
    out = []
    for i in rows:
        sup = i["supplier_id"] or last_supplier(db, i["id"])
        out.append(dict(i, on_order=coming.get(i["id"], 0), suggested=suggested_qty(i, coming.get(i["id"], 0)),
                        target=target_level(i), order_supplier=sup, preferred=bool(i["supplier_id"])))
    return out


def low_after_sale(db, item_ids):
    """The items in a sale that are now at or below their reorder level: 'Coffee beans (2 left)'."""
    out = []
    for iid in dict.fromkeys(item_ids):
        i = db.execute("SELECT name, qty_on_hand, reorder_level FROM items WHERE id=? AND is_inventoried=1"
                       " AND qty_on_hand<=reorder_level", (iid,)).fetchone()
        if i:
            out.append(f"{i['name']} ({max(i['qty_on_hand'], 0):g} left)")
    return out


def _can_order():
    from ..edition import is_pos_app
    return not is_pos_app() and perms.can("purchases", perms.EDIT)


@bp.route("/low-stock")
def low():
    db = get_db()
    rows = low_stock(db)
    suppliers = db.execute("SELECT id, name FROM contacts WHERE kind='supplier' AND active=1 ORDER BY name").fetchall()
    names = {s["id"]: s["name"] for s in suppliers}
    for r in rows:
        r["sup_name"] = names.get(r["order_supplier"]) or r["supplier_name"] or ""
    from ..listing import ListSpec, Col, Choice, from_request
    cats = sorted({r["category"] for r in rows if r.get("category")}, key=str.casefold)
    lst = from_request(ListSpec("low_stock", [
        Col("sku", "Item", "code"), Col("name", "Name"), Col("qty_on_hand", "On hand", "num"),
        Col("reorder_level", "Reorder level", "num"), Col("on_order", "On order", "num"),
        Col("suggested", "Order qty", "num"), Col("sup_name", "Supplier")],
        sort="sku", search=("sku", "name", "category", "sup_name"), search_hint="Item, category or supplier",
        per_page=None, noun="items", choices=[
            Choice("cat", "Category", [(c, c) for c in cats], col="category"),
            Choice("sup", "Supplier", [(str(s["id"]), s["name"]) for s in suppliers] + [("-", "(No supplier)")],
                   test=lambda r, v, t: (not r["order_supplier"]) if v == "-" else str(r["order_supplier"]) == v)]))
    rows = lst.apply(rows)
    return render_template("inventory/low.html", rows=rows, suppliers=suppliers, can_order=_can_order(), lst=lst)


@bp.route("/low-stock/order", methods=["GET", "POST"])
def order():
    """Make purchase orders for the ticked items, one per supplier."""
    if request.method == "GET":  # after a refused order (the form's page is the list)
        return redirect(url_for("inventory.low"))
    return _order()


@guarded
def _order():
    db = get_db()
    if not _can_order():
        raise PostingError("Your user can't make purchase orders. Ask an administrator.")
    f = request.form
    by_supplier = {}
    for iid in [opt_int(v) for v in f.getlist("pick")]:
        item = db.execute("SELECT * FROM items WHERE id=? AND is_inventoried=1", (iid,)).fetchone() if iid else None
        if not item:
            continue
        qty = opt_float(f.get(f"qty_{iid}"))
        if not qty or qty <= 0:
            raise PostingError(f"Type how many {item['name']} to order (or untick it).")
        sup = opt_int(f.get(f"supplier_{iid}"))
        if not sup or not db.execute("SELECT 1 FROM contacts WHERE id=? AND kind='supplier'", (sup,)).fetchone():
            raise PostingError(f"Choose a supplier for {item['name']}.")
        if not item["supplier_id"]:  # remembered as the preferred supplier for next time
            db.execute("UPDATE items SET supplier_id=? WHERE id=?", (sup, iid))
        by_supplier.setdefault(sup, []).append(dict(item_id=iid, description=item["name"], qty=qty,
                                                    unit_price=item["buy_price"],
                                                    tax_code_id=item["purchase_tax_code_id"]))
    if not by_supplier:
        raise PostingError("Tick at least one item to order.")
    today = date.today()
    made = []
    for sup, lines in by_supplier.items():
        c = db.execute("SELECT name, terms_days FROM contacts WHERE id=?", (sup,)).fetchone()
        terms = c["terms_days"] if c["terms_days"] is not None else (g.company.get("default_terms_days") or 30)
        did = save_document(db, "purchase", dict(contact_id=sup, date=today.isoformat(),
                                                 due_date=(today + timedelta(days=terms)).isoformat()),
                            lines, "order")
        made.append((did, db.execute("SELECT number FROM documents WHERE id=?", (did,)).fetchone()[0], c["name"]))
    audit(db, "reorder", ", ".join(n for _, n, _ in made))
    if len(made) == 1:
        flash(f"Purchase order {made[0][1]} made for {made[0][2]}. Check it, then email or print it to the supplier.",
              "ok")
        return redirect(url_for("documents.view", doc_id=made[0][0]))
    flash(f"{len(made)} purchase orders made: " + ", ".join(f"{n} ({s})" for _, n, s in made)
          + ". Open each one to email or print it to the supplier.", "ok")
    return redirect(url_for("documents.index", side="purchase", status="order"))
