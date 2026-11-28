"""Product variants: a product (for example a T-shirt) with up to 3 options (Size, Colour, ...), where every
combination is its own stock item with its own SKU, barcode, price, cost and stock.

Each variant is an ordinary item (items.parent_id = the product), so invoices, the till, stock valuation, cost of
sales and every report already work per variant. The product itself holds no stock and isn't sold on its own: at the
till it's one tile that opens a quick picker. A product without variants behaves exactly as before.
"""
import csv
import io
import itertools
import json
import re
from datetime import date

from flask import render_template, request, redirect, url_for, flash, abort, Response

from ..db import get_db, audit, to_cents, linked, write_txn, cents_str
from ..ledger import PostingError, stock_adjust
from . import guarded, once, opt_float
from .inventory import bp

MAX_OPTIONS = 3
MAX_VALUES = 30
MAX_VARIANTS = 300
CSV_COLS = ["product_sku", "product", "option1", "value1", "option2", "value2", "option3", "value3", "sku",
            "barcodes", "sell_price_ex_tax", "buy_price", "reorder_level", "on_hand", "active"]


def options_of(item):
    """The product's options: [{"name": "Size", "values": ["S", "M"]}] (older or empty data gives [])."""
    try:
        raw = json.loads(item["variant_options"] or "null")
    except (ValueError, TypeError):
        raw = None
    if isinstance(raw, dict):
        raw = raw.get("options")
    return [o for o in raw or [] if isinstance(o, dict) and o.get("name")]


def variants_of(db, pid, active_only=False):
    rows = db.execute("SELECT * FROM items WHERE parent_id=?" + (" AND active=1" if active_only else "")
                      + " ORDER BY id", (pid,)).fetchall()
    out = []
    for r in rows:
        try:
            vals = json.loads(r["variant_values"] or "[]")
        except ValueError:
            vals = []
        out.append(dict(r, vals=vals, label=" / ".join(vals)))
    return out


def _slug(v):
    return re.sub(r"[^A-Z0-9]+", "", v.upper())[:6] or "X"


def _unique_sku(db, base):
    sku, n = base, 2
    while db.execute("SELECT 1 FROM items WHERE sku=? COLLATE NOCASE", (sku,)).fetchone():
        sku, n = f"{base}-{n}", n + 1
    return sku


def variant_name(product_name, vals):
    return f"{product_name} ({' / '.join(vals)})"


def _parse_options(f):
    opts = []
    for n in range(1, MAX_OPTIONS + 1):
        name = (f.get(f"opt_name_{n}") or "").strip()[:30]
        vals = list(dict.fromkeys(v.strip()[:30] for v in (f.get(f"opt_values_{n}") or "").replace("\n", ",")
                                  .split(",") if v.strip()))
        if not name and not vals:
            continue
        if not name:
            raise PostingError(f"Option {n} needs a name, for example Size or Colour.")
        if not vals:
            raise PostingError(f"Type the choices for {name}, separated by commas (for example S, M, L).")
        if len(vals) > MAX_VALUES:
            raise PostingError(f"{name} has more than {MAX_VALUES} choices.")
        if any(o["name"].lower() == name.lower() for o in opts):
            raise PostingError(f"There are two options called {name}.")
        opts.append(dict(name=name, values=vals))
    return opts


def _new_variant(db, p, vals, sku=None, price=None, cost=None, flags=None):
    fl = flags or _flags(p)
    sku = _unique_sku(db, sku or f"{p['sku']}-{'-'.join(_slug(v) for v in vals)}")
    return db.execute(
        "INSERT INTO items (sku, name, description, is_sold, is_bought, is_inventoried, sell_price, buy_price,"
        " income_account_id, expense_account_id, asset_account_id, sale_tax_code_id, purchase_tax_code_id,"
        " reorder_level, active, category, pos_favourite, block_oversell, parent_id, variant_values, supplier_id,"
        " reorder_up_to) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)",
        (sku, variant_name(p["name"], vals), p["description"], fl["sold"], fl["bought"], fl["stock"],
         p["sell_price"] if price is None else price, p["buy_price"] if cost is None else cost,
         p["income_account_id"], p["expense_account_id"],
         (p["asset_account_id"] or linked(db, "inventory")) if fl["stock"] else None, p["sale_tax_code_id"],
         p["purchase_tax_code_id"], p["reorder_level"], p["category"], p["pos_favourite"], p["block_oversell"],
         p["id"], json.dumps(vals), p["supplier_id"], p["reorder_up_to"])).lastrowid


def _flags(p):
    """What the variants are (sold, bought, stocked): the product's own settings, kept when it became a product."""
    try:
        raw = json.loads(p["variant_options"] or "null")
    except (ValueError, TypeError):
        raw = None
    if isinstance(raw, dict) and isinstance(raw.get("flags"), dict):
        return {k: int(bool(raw["flags"].get(k))) for k in ("sold", "bought", "stock")}
    return dict(sold=p["is_sold"], bought=p["is_bought"], stock=p["is_inventoried"])


def _store_options(db, p, opts, flags=None):
    db.execute("UPDATE items SET variant_options=? WHERE id=?",
               (json.dumps(dict(options=opts, flags=flags or _flags(p))), p["id"]))


def make_product(db, pid, opts, stock_to_vals=None):
    """Turn an item into a product with variants (or add the missing combinations). Returns the new variant ids."""
    write_txn(db)
    p = db.execute("SELECT * FROM items WHERE id=?", (pid,)).fetchone()
    if not p:
        raise PostingError("That item doesn't exist.")
    if p["parent_id"]:
        raise PostingError("This is already a variant. Add options on its product instead.")
    if not opts:
        raise PostingError("Add at least one option, for example Size: S, M, L.")
    flags = _flags(p)
    combos = [list(c) for c in itertools.product(*[o["values"] for o in opts])]
    existing = {tuple(v["vals"]) for v in variants_of(db, pid)}
    if len(existing | {tuple(c) for c in combos}) > MAX_VARIANTS:
        raise PostingError(f"That makes more than {MAX_VARIANTS} variants. Use fewer choices.")
    first = not p["has_variants"]
    _store_options(db, p, opts, flags)
    made = [_new_variant(db, p, c, flags=flags) for c in combos if tuple(c) not in existing]
    if first:
        _move_stock_to_variant(db, p, made, combos, stock_to_vals)
        db.execute("UPDATE items SET has_variants=1, is_sold=0, is_bought=0, is_inventoried=0 WHERE id=?", (pid,))
    audit(db, "variants_generate", f"{p['sku']}: {len(made)} new")
    return made


def _move_stock_to_variant(db, p, made, combos, stock_to_vals):
    """The item had stock of its own before it had variants: it goes, at its own cost, to the variant chosen."""
    if not p["is_inventoried"] or abs(p["qty_on_hand"]) < 1e-9:
        return
    from .. import locations as LOC
    want = tuple(stock_to_vals or [])
    target = next((vid for vid, c in zip(made, combos) if tuple(c) == want), None)
    if not target:
        raise PostingError(f"{p['sku']} has {p['qty_on_hand']:g} on hand. Choose which variant that stock is.")
    today = date.today().isoformat()
    for l in LOC.stores(db, active_only=False) + [db.execute("SELECT * FROM stock_locations WHERE kind='transit'").fetchone()]:
        q = LOC.qty_at(db, p["id"], l["id"])
        if abs(q) < 1e-9:
            continue
        for iid, qty in ((p["id"], -q), (target, q)):
            db.execute("INSERT INTO stock_movements (item_id, date, qty, unit_cost, source_type, source_id, memo,"
                       " location_id) VALUES (?,?,?,?,?,?,?,?)", (iid, today, qty, p["avg_cost"], "variant_move",
                                                                  p["id"], "Stock moved to its variant", l["id"]))
    db.execute("UPDATE stock_levels SET item_id=? WHERE item_id=?", (target, p["id"]))
    db.execute("UPDATE items SET qty_on_hand=?, avg_cost=? WHERE id=?", (p["qty_on_hand"], p["avg_cost"], target))
    db.execute("UPDATE items SET qty_on_hand=0 WHERE id=?", (p["id"],))


def propagate(db, pid):
    """After the product is edited: its variants follow its category, accounts, tax codes, sold / bought and name.
    The product itself stays a holder (no stock, not sold on its own)."""
    p = db.execute("SELECT * FROM items WHERE id=?", (pid,)).fetchone()
    if not p or not p["has_variants"]:
        return
    flags = dict(sold=p["is_sold"], bought=p["is_bought"], stock=_flags(p)["stock"])
    _store_options(db, p, options_of(p), flags)
    for v in variants_of(db, pid):
        db.execute("UPDATE items SET name=?, category=?, income_account_id=?, expense_account_id=?, sale_tax_code_id=?,"
                   " purchase_tax_code_id=?, is_sold=?, is_bought=?, description=? WHERE id=?",
                   (variant_name(p["name"], v["vals"]), p["category"], p["income_account_id"], p["expense_account_id"],
                    p["sale_tax_code_id"], p["purchase_tax_code_id"], flags["sold"], flags["bought"],
                    p["description"], v["id"]))
    if not p["active"]:
        db.execute("UPDATE items SET active=0 WHERE parent_id=?", (pid,))
    db.execute("UPDATE items SET is_sold=0, is_bought=0, is_inventoried=0 WHERE id=?", (pid,))


def _barcode_owner(db, code, not_ids):
    """The SKU of another item (not one of not_ids) that already has this barcode."""
    code = code.lower()
    skip = {not_ids} if isinstance(not_ids, int) else set(not_ids)
    for r in db.execute("SELECT id, sku, barcodes FROM items WHERE barcodes IS NOT NULL"):
        if r["id"] not in skip and code in [b.strip().lower() for b in r["barcodes"].split(",")]:
            return r["sku"]
    return None


# ------------------------------------------------------------ the setup page
@bp.route("/<int:iid>/variants", methods=["GET", "POST"])
def variants(iid):
    db = get_db()
    p = db.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not p:
        abort(404)
    if p["parent_id"]:
        return redirect(url_for("inventory.variants", iid=p["parent_id"]))
    if request.method == "POST":
        return _save_variants(iid)
    from .. import locations as LOC
    rows = variants_of(db, iid)
    moved = {r["item_id"] for r in db.execute("SELECT DISTINCT item_id FROM stock_movements WHERE item_id IN"
                                              " (SELECT id FROM items WHERE parent_id=?)", (iid,))}
    rate = db.execute("SELECT rate FROM tax_codes WHERE id=?", (p["sale_tax_code_id"],)).fetchone()
    per_loc = None
    if LOC.several(db) and rows:
        stores = LOC.stores(db)
        lv = {l["id"]: LOC.levels(db, l["id"]) for l in stores}
        per_loc = dict(stores=stores, qty={v["id"]: [lv[l["id"]].get(v["id"], 0) for l in stores] for v in rows})
    return render_template("inventory/variants.html", p=p, opts=options_of(p), rows=rows, moved=moved,
                           rate=(rate["rate"] if rate else 0) or 0, flags=_flags(p), per_loc=per_loc,
                           max_options=MAX_OPTIONS)


@guarded
@once
def _save_variants(iid):
    db = get_db()
    f = request.form
    write_txn(db)
    p = db.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if f.get("what") == "generate":
        opts = _parse_options(f)
        if p["has_variants"]:  # options can grow; a choice already used can't disappear
            old = options_of(p)
            if [o["name"] for o in old] != [o["name"] for o in opts][:len(old)] or len(opts) != len(old):
                if variants_of(db, iid):
                    raise PostingError("The options of a product with variants can't be renamed, added or removed "
                                       "(its variants keep their history). Add more choices to an option instead.")
            for o, n in zip(old, opts):
                gone = [v for v in o["values"] if v not in n["values"]]
                if gone:
                    raise PostingError(f"{', '.join(gone)} can't be taken off {o['name']}: there are variants with it. "
                                       "Switch those variants off instead.")
        stock_to = [v.strip() for v in (f.get("stock_to") or "").split("|") if v.strip()]
        made = make_product(db, iid, opts, stock_to)
        flash(f"{len(made)} variant{'s' if len(made) != 1 else ''} made. Check the SKUs, barcodes and prices below."
              if made else "Every combination already exists.", "ok")
        return redirect(url_for("inventory.variants", iid=iid))
    if f.get("what") != "save":
        raise PostingError("Nothing to save.")
    today = date.today().isoformat()
    seen_skus, seen_codes = set(), {}
    opening = []
    mine = {v["id"] for v in variants_of(db, iid)}
    for v in variants_of(db, iid):
        k = v["id"]
        sku = (f.get(f"sku_{k}") or "").strip()[:40]
        if not sku:
            raise PostingError(f"{v['label']}: the SKU can't be empty.")
        if sku.lower() in seen_skus or db.execute("SELECT 1 FROM items WHERE sku=? COLLATE NOCASE AND id<>?",
                                                  (sku, k)).fetchone():
            raise PostingError(f"SKU {sku} is already used.")
        seen_skus.add(sku.lower())
        codes = ",".join(dict.fromkeys(c.strip() for c in (f.get(f"barcodes_{k}") or "").split(",") if c.strip()))
        for c in codes.split(",") if codes else []:
            other = seen_codes.get(c.lower()) or _barcode_owner(db, c, mine)
            if other:
                raise PostingError(f"Barcode {c} is already on {other}. Each barcode must belong to one item.")
            seen_codes[c.lower()] = sku
        price, cost = to_cents(f.get(f"price_{k}") or "0"), to_cents(f.get(f"cost_{k}") or "0")
        if price < 0 or cost < 0:
            raise PostingError(f"{v['label']}: prices can't be below $0.")
        db.execute("UPDATE items SET sku=?, barcodes=?, sell_price=?, buy_price=?, reorder_level=?, active=? WHERE id=?",
                   (sku, codes or None, price, cost, opt_float(f.get(f"reorder_{k}")),
                    1 if f.get(f"active_{k}") else 0, k))
        oq = opt_float(f.get(f"opening_{k}"))
        if oq:
            if oq < 0:
                raise PostingError(f"{v['label']}: opening stock can't be below 0.")
            if db.execute("SELECT 1 FROM stock_movements WHERE item_id=?", (k,)).fetchone():
                raise PostingError(f"{v['label']} already has stock movements: use a stocktake or adjustment.")
            opening.append((k, oq, cost))
    for k, oq, cost in opening:
        it = db.execute("SELECT is_inventoried, sku FROM items WHERE id=?", (k,)).fetchone()
        if not it["is_inventoried"]:
            continue
        if not cost:
            raise PostingError(f"{it['sku']}: type its cost (buy price) so the opening stock has a value.")
        stock_adjust(db, k, today, oq, cost, "Opening stock", account_id=linked(db, "historical_balancing"))
    audit(db, "variants_save", p["sku"])
    flash("Variants saved.", "ok")
    return redirect(url_for("inventory.variants", iid=iid))


# ------------------------------------------------------------ CSV export and import
@bp.route("/variants.csv")
def variants_export():
    db = get_db()
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(CSV_COLS)
    for p in db.execute("SELECT * FROM items WHERE has_variants=1 ORDER BY sku").fetchall():
        opts = options_of(p)
        for v in variants_of(db, p["id"]):
            row = [p["sku"], p["name"]]
            for n in range(MAX_OPTIONS):
                row += [opts[n]["name"] if n < len(opts) else "", v["vals"][n] if n < len(v["vals"]) else ""]
            row += [v["sku"], v["barcodes"] or "", cents_str(v["sell_price"]), cents_str(v["buy_price"]),
                    f"{v['reorder_level']:g}", f"{v['qty_on_hand']:g}" if v["is_inventoried"] else "",
                    "yes" if v["active"] else "no"]
            w.writerow(row)
    return Response(out.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=variants-{date.today().isoformat()}.csv"})


@bp.route("/variants/import", methods=["GET", "POST"])
def variants_import():
    if request.method == "GET":
        return render_template("inventory/variants_import.html", cols=CSV_COLS)
    return _import()


@guarded
@once
def _import():
    db = get_db()
    write_txn(db)
    up = request.files.get("file")
    if not up or not up.filename:
        raise PostingError("Choose the CSV file to import.")
    try:
        text = up.read().decode("utf-8-sig")
    except UnicodeDecodeError:
        raise PostingError("That file isn't a CSV saved as UTF-8. In Excel, use Save As > CSV UTF-8.")
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows or "sku" not in (rows[0].keys() if rows else []) or "product_sku" not in rows[0].keys():
        raise PostingError("The file needs the columns " + ", ".join(CSV_COLS) + " (export first to get a template).")
    made = updated = 0
    errors = []
    today = date.today().isoformat()
    for n, r in enumerate(rows, 2):
        r = {k: (v or "").strip() for k, v in r.items() if k}
        try:
            psku = r.get("product_sku")
            if not psku:
                raise PostingError("product_sku is empty")
            p = db.execute("SELECT * FROM items WHERE sku=? COLLATE NOCASE", (psku,)).fetchone()
            if p and p["parent_id"]:
                raise PostingError(f"{psku} is a variant, not a product")
            opts, vals = [], []
            for k in range(1, MAX_OPTIONS + 1):
                if r.get(f"option{k}") or r.get(f"value{k}"):
                    if not (r.get(f"option{k}") and r.get(f"value{k}")):
                        raise PostingError(f"option{k} and value{k} go together")
                    opts.append(r[f"option{k}"][:30])
                    vals.append(r[f"value{k}"][:30])
            if not opts:
                raise PostingError("give at least option1 and value1")
            if not p:
                if not r.get("product"):
                    raise PostingError(f"there's no product {psku}: give its name in the product column to make it")
                from ..countries import tax_code_id
                pid = db.execute("INSERT INTO items (sku, name, is_sold, is_bought, is_inventoried, sell_price,"
                                 " buy_price, income_account_id, expense_account_id, asset_account_id,"
                                 " sale_tax_code_id, purchase_tax_code_id) VALUES (?,?,1,1,1,?,?,?,?,?,?,?)",
                                 (psku, r["product"][:80], to_cents(r.get("sell_price_ex_tax") or "0"),
                                  to_cents(r.get("buy_price") or "0"), linked(db, "default_income"), linked(db, "cogs"),
                                  linked(db, "inventory"), tax_code_id(db, "standard"),
                                  tax_code_id(db, "standard"))).lastrowid
                p = db.execute("SELECT * FROM items WHERE id=?", (pid,)).fetchone()
            cur = options_of(p)
            if cur and [o["name"].lower() for o in cur] != [o.lower() for o in opts]:
                raise PostingError(f"{psku}'s options are {', '.join(o['name'] for o in cur)}")
            if not cur:
                cur = [dict(name=o, values=[]) for o in opts]
            for o, v in zip(cur, vals):
                if v not in o["values"]:
                    o["values"].append(v)
            flags = _flags(p)
            _store_options(db, p, cur, flags)
            if not p["has_variants"]:
                if p["is_inventoried"] and abs(p["qty_on_hand"]) > 1e-9:
                    raise PostingError(f"{psku} has stock of its own: give it variants on its Variants page first")
                db.execute("UPDATE items SET has_variants=1, is_sold=0, is_bought=0, is_inventoried=0 WHERE id=?",
                           (p["id"],))
            p = db.execute("SELECT * FROM items WHERE id=?", (p["id"],)).fetchone()
            vs = variants_of(db, p["id"])
            v = next((x for x in vs if r.get("sku") and x["sku"].lower() == r["sku"].lower()), None) or \
                next((x for x in vs if x["vals"] == vals), None)
            sku = r.get("sku")
            if sku:
                other = db.execute("SELECT parent_id FROM items WHERE sku=? COLLATE NOCASE AND id IS NOT ?",
                                   (sku, v["id"] if v else None)).fetchone()
                if other:
                    raise PostingError(f"SKU {sku} is already used by another item")
            price = to_cents(r["sell_price_ex_tax"]) if r.get("sell_price_ex_tax") else None
            cost = to_cents(r["buy_price"]) if r.get("buy_price") else None
            if v is None:
                vid = _new_variant(db, p, vals, sku=sku or None, price=price, cost=cost, flags=flags)
                made += 1
                oq = opt_float(r.get("on_hand"))
                if oq and flags["stock"]:
                    c = cost if cost is not None else p["buy_price"]
                    if not c:
                        raise PostingError("give buy_price so the opening stock has a value")
                    stock_adjust(db, vid, today, oq, c, "Opening stock (import)",
                                 account_id=linked(db, "historical_balancing"))
            else:
                vid = v["id"]
                updated += 1
            sets, args = [], []
            if sku:
                sets.append("sku=?")
                args.append(sku)
            if price is not None:
                sets.append("sell_price=?")
                args.append(price)
            if cost is not None:
                sets.append("buy_price=?")
                args.append(cost)
            if r.get("barcodes"):
                codes = ",".join(dict.fromkeys(c.strip() for c in r["barcodes"].split(",") if c.strip()))
                for c in codes.split(","):
                    owner = _barcode_owner(db, c, vid)
                    if owner:
                        raise PostingError(f"barcode {c} is already on {owner}")
                sets.append("barcodes=?")
                args.append(codes)
            if r.get("reorder_level"):
                sets.append("reorder_level=?")
                args.append(opt_float(r["reorder_level"]))
            if r.get("active"):
                sets.append("active=?")
                args.append(0 if r["active"].lower() in ("no", "n", "0", "false") else 1)
            if sets:
                db.execute(f"UPDATE items SET {', '.join(sets)} WHERE id=?", args + [vid])
        except PostingError as e:
            errors.append(f"row {n}: {e}")
        except ValueError as e:
            errors.append(f"row {n}: {e}")
    if errors:
        raise PostingError("Nothing was imported. Fix these and try again: " + "; ".join(errors[:12])
                           + (f" (and {len(errors) - 12} more)" if len(errors) > 12 else ""))
    audit(db, "variants_import", f"{made} new, {updated} updated")
    flash(f"Import done: {made} variant{'s' if made != 1 else ''} added and {updated} updated. "
          "Stock on hand of variants already there is not changed by an import: use a stocktake for that.", "ok")
    return redirect(url_for("inventory.index"))
