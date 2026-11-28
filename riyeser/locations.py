"""Stock locations: where stock is (shops, a warehouse, a van) and how much of each item is at each one.

The default location (made as "Main" the first time) holds whatever isn't recorded at another location, so stock
from before locations existed is at Main, and anything that changes stock without naming a location changes Main.
Other locations, and stock in transit between them, keep a quantity in stock_levels. Adding up every location (and
what's in transit) always gives the item's total on hand, and a transfer never changes the total or its value.
"""
from .db import write_txn


def default_id(db):
    return db.execute("SELECT id FROM stock_locations WHERE is_default=1").fetchone()[0]


def transit_id(db):
    return db.execute("SELECT id FROM stock_locations WHERE kind='transit'").fetchone()[0]


def stores(db, active_only=True):
    """The real locations (not "In transit"), the default one first."""
    return db.execute("SELECT * FROM stock_locations WHERE kind='store'" + (" AND active=1" if active_only else "")
                      + " ORDER BY is_default DESC, name COLLATE NOCASE").fetchall()


def store_id(db, location_id):
    """A real location (not "In transit") from what was asked for, else the default one."""
    ids = {l["id"] for l in stores(db)}
    return location_id if location_id in ids else default_id(db)


def several(db):
    """More than one location in use: only then do screens ask which one."""
    return db.execute("SELECT COUNT(*) FROM stock_locations WHERE kind='store' AND active=1").fetchone()[0] > 1


def resolve(db, location_id):
    """A location id to use for a stock change: the one given (when it exists), else the default."""
    if location_id:
        r = db.execute("SELECT id FROM stock_locations WHERE id=?", (location_id,)).fetchone()
        if r:
            return r["id"]
    return default_id(db)


def add_level(db, item_id, location_id, delta):
    """Record delta more (or less) of an item at a location. The default location needs no record."""
    if not delta:
        return
    loc = resolve(db, location_id)
    if loc == default_id(db):
        return
    write_txn(db)
    db.execute("INSERT INTO stock_levels (item_id, location_id, qty) VALUES (?,?,?) ON CONFLICT(item_id, location_id)"
               " DO UPDATE SET qty=qty+excluded.qty", (item_id, loc, delta))


def qty_at(db, item_id, location_id=None):
    """How many of an item are at a location (the default location when none is given)."""
    loc = resolve(db, location_id)
    if loc != default_id(db):
        r = db.execute("SELECT qty FROM stock_levels WHERE item_id=? AND location_id=?", (item_id, loc)).fetchone()
        return r["qty"] if r else 0.0
    total = db.execute("SELECT qty_on_hand FROM items WHERE id=?", (item_id,)).fetchone()
    others = db.execute("SELECT COALESCE(SUM(qty),0) FROM stock_levels WHERE item_id=?", (item_id,)).fetchone()[0]
    return round((total["qty_on_hand"] if total else 0) - others, 6)


def levels(db, location_id=None):
    """{item_id: qty at the location} for every stocked item."""
    loc = resolve(db, location_id)
    if loc != default_id(db):
        return {r[0]: r[1] for r in db.execute("SELECT item_id, qty FROM stock_levels WHERE location_id=?", (loc,))}
    others = {r[0]: r[1] for r in db.execute("SELECT item_id, SUM(qty) FROM stock_levels GROUP BY item_id")}
    return {r["id"]: round(r["qty_on_hand"] - others.get(r["id"], 0), 6)
            for r in db.execute("SELECT id, qty_on_hand FROM items WHERE is_inventoried=1")}


def by_location(db, item_id):
    """[(location row, qty)] for one item: every active store, then In transit when anything is on the way."""
    out = [(l, qty_at(db, item_id, l["id"])) for l in stores(db)]
    t = db.execute("SELECT * FROM stock_locations WHERE kind='transit'").fetchone()
    q = qty_at(db, item_id, t["id"])
    if abs(q) > 1e-9:
        out.append((t, q))
    return out


def till_location(db, till_id):
    r = db.execute("SELECT location_id FROM pos_tills WHERE id=?", (till_id,)).fetchone() if till_id else None
    return resolve(db, r["location_id"] if r else None)


def name_of(db, location_id):
    r = db.execute("SELECT name FROM stock_locations WHERE id=?", (resolve(db, location_id),)).fetchone()
    return r["name"] if r else ""


def location_reorder(db, location_id):
    """{item_id: (reorder level, reorder up to)} set for one location (an item without one uses its own levels)."""
    return {r["item_id"]: (r["reorder_level"], r["reorder_up_to"]) for r in db.execute(
        "SELECT * FROM location_levels WHERE location_id=?", (location_id,))}
