"""Inventory: stock items, item maintenance, stock adjustments, movements."""
import base64
import binascii

from flask import Blueprint, render_template, request, redirect, url_for, flash, abort

from ..db import get_db, to_cents, audit, linked
from ..ledger import stock_adjust
from . import lookups, opt_int, opt_float, guarded

bp = Blueprint("inventory", __name__, url_prefix="/inventory")


@bp.route("/")
def index():
    db = get_db()
    q = request.args.get("q", "")
    rows = db.execute("SELECT * FROM items WHERE sku LIKE ? OR name LIKE ? ORDER BY active DESC, sku",
                      (f"%{q}%", f"%{q}%")).fetchall()
    value = sum(r["qty_on_hand"] * r["avg_cost"] for r in rows if r["is_inventoried"])
    return render_template("inventory/index.html", rows=rows, q=q, value=value)


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
    return render_template("inventory/edit.html", item=item, defaults=defaults, categories=cats, has_photo=has_photo,
                           **lookups(db))


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
    db.execute("UPDATE items SET category=?, pos_favourite=?, block_oversell=? WHERE id=?",
               ((f.get("category") or "").strip() or None, 1 if f.get("pos_favourite") else 0,
                1 if f.get("block_oversell") else 0, iid))
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
    """Stocktake: enter counted quantities, post the differences."""
    db = get_db()
    items = db.execute("SELECT * FROM items WHERE is_inventoried=1 AND active=1 ORDER BY sku").fetchall()
    if request.method == "POST":
        return _save_count(items)
    return render_template("inventory/count.html", items=items, **lookups(db))


@guarded
def _save_count(items):
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
            stock_adjust(db, it["id"], request.form["date"], diff, None, "Stocktake")
            n += 1
    flash(f"Stocktake posted: {n} adjustments.", "ok")
    return redirect(url_for("inventory.index"))
