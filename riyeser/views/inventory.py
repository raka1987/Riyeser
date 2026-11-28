"""Inventory: stock items, item maintenance, stock adjustments, movements."""
import base64
import binascii

from flask import Blueprint, render_template, request, redirect, url_for, flash, abort

from ..db import get_db, to_cents, audit, linked
from ..ledger import stock_adjust
from . import lookups, opt_int, opt_float, guarded, once

bp = Blueprint("inventory", __name__, url_prefix="/inventory")


def items_spec(categories):
    from ..listing import ListSpec, Col, Choice
    return ListSpec("items", [
        Col("sku", "SKU", "code"), Col("name", "Name"), Col("category", "Category"), Col("type", "Type"),
        Col("qty_on_hand", "On hand", "num", sql="CASE WHEN is_inventoried THEN qty_on_hand END"),
        Col("avg_cost", "Avg cost", "num", sql="CASE WHEN is_inventoried THEN avg_cost END"),
        Col("sell_price", "Sell price", "num"), Col("value", "Value", "num")],
        sort="sku", search=("sku", "name", "category", "barcodes", "description"), search_hint="SKU, name, category or barcode",
        lead="active DESC", tiebreak="sku", noun="items", choices=[
            Choice("cat", "Category", [(c, c) for c in categories] + [("-", "(No category)")],
                   where=lambda v, t: (" AND COALESCE(category,'')=''", []) if v == "-" else (" AND category=?", [v])),
            Choice("type", "Type", [("Stock", "Stock"), ("Non-stock", "Non-stock")]),
            Choice("st", "Status", [("active", "Active"), ("inactive", "Inactive"), ("reorder", "At or below reorder level")],
                   where={"active": (" AND active=1", []), "inactive": (" AND active=0", []),
                          "reorder": (" AND is_inventoried=1 AND qty_on_hand<=reorder_level", [])})])


@bp.route("/")
def index():
    db = get_db()
    from ..listing import from_request
    cats = [r[0] for r in db.execute("SELECT DISTINCT category FROM items WHERE COALESCE(category,'')<>''"
                                     " ORDER BY category COLLATE NOCASE")]
    lst = from_request(items_spec(cats))
    rows = lst.fetch(db, "SELECT *, CASE WHEN is_inventoried THEN 'Stock' ELSE 'Non-stock' END type,"
                         " CASE WHEN is_inventoried THEN qty_on_hand*avg_cost END value FROM items", sums=("value",))
    return render_template("inventory/index.html", rows=rows, q=lst.q, value=lst.sums["value"], lst=lst)


@bp.route("/new", methods=["GET", "POST"])
@bp.route("/<int:iid>/edit", methods=["GET", "POST"])
def edit(iid=None):
    db = get_db()
    if request.method == "POST":
        return _save(iid)
    item = db.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone() if iid else None
    defaults = dict(income=linked(db, "default_income"), cogs=linked(db, "cogs"), asset=linked(db, "inventory"))
    cats = [r[0] for r in db.execute("SELECT DISTINCT category FROM items WHERE category IS NOT NULL ORDER BY 1")]
    has_photo = bool(iid and db.execute("SELECT 1 FROM item_photos WHERE item_id=?", (iid,)).fetchone())
    suppliers = db.execute("SELECT id, name FROM contacts WHERE kind='supplier' AND active=1 ORDER BY name").fetchall()
    vflags = None
    if item and item["has_variants"]:
        from .variants import _flags
        vflags = _flags(item)
    prefill = None if item else (request.args.get("barcode") or "").strip()[:64] or None  # "add a product" from a scan
    return render_template("inventory/edit.html", item=item, defaults=defaults, categories=cats, has_photo=has_photo,
                           suppliers=suppliers, vflags=vflags, prefill_barcode=prefill, **lookups(db))


@guarded
def _save(iid):
    db = get_db()
    f = request.form
    if not f.get("sku", "").strip() or not f.get("name", "").strip():
        raise ValueError("SKU and name are required.")
    inv = 1 if f.get("is_inventoried") else 0
    vals = (f["sku"].strip(), f["name"].strip(), f.get("description"), 1 if f.get("is_sold") else 0,
            1 if f.get("is_bought") else 0, inv, to_cents(f.get("sell_price")), to_cents(f.get("buy_price")),
            opt_int(f.get("income_account_id")), opt_int(f.get("expense_account_id")),
            opt_int(f.get("asset_account_id")) if inv else None, opt_int(f.get("sale_tax_code_id")),
            opt_int(f.get("purchase_tax_code_id")), opt_float(f.get("reorder_level")), 1 if f.get("active") else 0)
    other = db.execute("SELECT name FROM items WHERE sku=? COLLATE NOCASE AND id IS NOT ?", (vals[0], iid)).fetchone()
    if other:
        raise ValueError(f"SKU {vals[0]} is already used by {other['name']}.")  # M23
    if iid:
        old = db.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
        if old and old["is_inventoried"] and not inv and abs(old["qty_on_hand"]) > 1e-9:
            # S54: the stock value would vanish while the Inventory account keeps it
            raise ValueError(f"{old['sku']} has {old['qty_on_hand']:g} on hand. Stocktake it to 0 first, then untick "
                             f"\"I inventory this item\".")
        db.execute("UPDATE items SET sku=?, name=?, description=?, is_sold=?, is_bought=?, is_inventoried=?,"
                   " sell_price=?, buy_price=?, income_account_id=?, expense_account_id=?, asset_account_id=?,"
                   " sale_tax_code_id=?, purchase_tax_code_id=?, reorder_level=?, active=? WHERE id=?", vals + (iid,))
    else:
        iid = db.execute("INSERT INTO items (sku, name, description, is_sold, is_bought, is_inventoried, sell_price,"
                         " buy_price, income_account_id, expense_account_id, asset_account_id, sale_tax_code_id,"
                         " purchase_tax_code_id, reorder_level, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         vals).lastrowid
        oq = opt_float(f.get("opening_qty"))
        if inv and oq:
            stock_adjust(db, iid, f.get("opening_date") or __import__("datetime").date.today().isoformat(), oq,
                         to_cents(f.get("opening_cost") or f.get("buy_price")), "Opening stock",
                         account_id=linked(db, "historical_balancing"))
    codes = ",".join(dict.fromkeys(c.strip() for c in (f.get("barcodes") or "").replace("\n", ",").split(",") if c.strip()))
    db.execute("UPDATE items SET category=?, pos_favourite=?, block_oversell=?, barcodes=? WHERE id=?",
               ((f.get("category") or "").strip() or None, 1 if f.get("pos_favourite") else 0,
                1 if f.get("block_oversell") else 0, codes or None, iid))
    up_to = opt_float(f.get("reorder_up_to"))
    if up_to is not None and up_to < 0:
        raise ValueError("\"Reorder up to\" can't be below 0.")
    db.execute("UPDATE items SET reorder_up_to=?, supplier_id=? WHERE id=?",
               (up_to or None, opt_int(f.get("supplier_id")), iid))
    from .variants import propagate
    propagate(db, iid)  # a product with variants: they follow its category, accounts, tax and name
    _save_photo(db, iid, f)
    audit(db, "save_item", vals[0])
    flash(f"Item {vals[0]} saved.", "ok")
    return redirect(url_for("inventory.view", iid=iid))


PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_PHOTO = 1_500_000  # bytes, after the browser has shrunk it


def _save_photo(db, iid, f):
    """Store the POS photo sent as a data URL (the form shrinks it first)."""
    if f.get("photo_remove"):
        db.execute("DELETE FROM item_photos WHERE item_id=?", (iid,))
    raw = f.get("photo_data") or ""
    if not raw:
        return
    try:
        head, b64 = raw.split(",", 1)
        mime = head[5:].split(";", 1)[0]
        data = base64.b64decode(b64, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("That photo couldn't be read. Try a JPG or PNG.")
    if mime not in PHOTO_TYPES or not data:
        raise ValueError("Photos must be JPG, PNG or WebP.")
    if len(data) > MAX_PHOTO:
        raise ValueError("That photo is too large. Try a smaller one.")
    db.execute("INSERT OR REPLACE INTO item_photos (item_id, mime, data, updated_at)"
               " VALUES (?,?,?,datetime('now','localtime'))", (iid, mime, data))


@bp.route("/<int:iid>")
def view(iid):
    db = get_db()
    item = db.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not item:
        abort(404)
    moves = db.execute("SELECT * FROM stock_movements WHERE item_id=? ORDER BY date DESC, id DESC", (iid,)).fetchall()
    sales = db.execute("SELECT COALESCE(SUM(l.qty),0) q, COALESCE(SUM(l.net_amount),0) v FROM document_lines l"
                       " JOIN documents d ON d.id=l.document_id WHERE l.item_id=? AND d.side='sale'"
                       " AND d.status IN ('open','paid')", (iid,)).fetchone()
    return render_template("inventory/view.html", item=item, moves=moves, sales=sales, **lookups(db))


@bp.route("/<int:iid>/adjust", methods=["POST"])
@guarded
def adjust(iid):
    f = request.form
    qty = opt_float(f.get("qty"))
    if not qty:
        raise ValueError("Enter a quantity change (e.g. -2 or 5).")
    cost = to_cents(f["unit_cost"]) if f.get("unit_cost") else None
    stock_adjust(get_db(), iid, f["date"], qty, cost, f.get("memo") or "Inventory adjustment",
                 account_id=opt_int(f.get("account_id")))
    flash("Stock adjusted.", "ok")
    return redirect(url_for("inventory.view", iid=iid))


@bp.route("/count", methods=["GET", "POST"])
def count():
    """Stocktake: enter counted quantities, post the differences. With more than one location, it's the count at
    one location (chosen at the top), compared with what Riyeser has there."""
    db = get_db()
    from .. import locations as LOC
    locs = LOC.stores(db) if LOC.several(db) else []
    loc = LOC.store_id(db, opt_int(request.values.get("loc"))) if locs else None
    here = LOC.levels(db, loc) if loc else None
    items = [dict(i, qty_on_hand=here.get(i["id"], 0)) if here is not None else i for i in db.execute(
        "SELECT * FROM items WHERE is_inventoried=1 AND active=1 ORDER BY sku").fetchall()]
    if request.method == "POST":
        return _save_count(items, loc)
    return render_template("inventory/count.html", items=items, locations=locs, loc=loc,
                           loc_name=LOC.name_of(db, loc) if loc else None, **lookups(db))


@guarded
@once
def _save_count(items, loc=None):
    db = get_db()
    n = 0
    for it in items:
        v = request.form.get(f"count_{it['id']}", "").strip()
        if v == "":
            continue
        try:
            counted = float(v)
        except ValueError:
            raise ValueError(f"Count for {it['sku']} must be a number.")  # M14
        if counted < 0:
            raise ValueError(f"{it['sku']}: a count can't be below 0.")  # F13
        diff = round(counted - it["qty_on_hand"], 4)
        if diff:
            from .. import locations as LOC
            stock_adjust(db, it["id"], request.form["date"], diff, None,
                         f"Stocktake at {LOC.name_of(db, loc)}" if loc else "Stocktake", location_id=loc)
            n += 1
    from ..ledger import settle_stock_rounding
    settle_stock_rounding(db, request.form["date"], "stocktake")   # a stocktake also clears leftover cents
    flash(f"Stocktake posted: {n} adjustments." if n else "Stocktake done: every count matched.", "ok")
    return redirect(url_for("inventory.index"))


from . import reorder  # noqa: E402,F401  (low stock and reordering: its routes are on this blueprint)
from . import stock_locations  # noqa: E402,F401  (locations, transfers)
from . import variants  # noqa: E402,F401  (product variants: options, combinations, CSV)
