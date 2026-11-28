"""Riyeser POS 2.11: product variants, stock locations and transfers, table moves and split bills, the cash drawer
and the kitchen display screen. Only adds tables and columns, so an older company file opens as before.

Stock locations: the default location ("Main") holds whatever isn't recorded at another location, so every stock
change made before locations existed (or by code that doesn't name a location) is simply at Main. Other locations,
and stock in transit, keep their own quantity in stock_levels. Total on hand (items.qty_on_hand) is unchanged.
"""


def _cols(db, table):
    return {r["name"] for r in db.execute(f"PRAGMA table_info({table})")}


def _add(db, table, cols):
    have = _cols(db, table)
    for col, ddl in cols:
        if col not in have:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


def ensure_schema(db):
    # ---- variants: a product (the parent) with up to 3 options; each combination is an item of its own
    _add(db, "items", (("parent_id", "INTEGER REFERENCES items(id)"),
                       ("has_variants", "INTEGER NOT NULL DEFAULT 0"),
                       ("variant_options", "TEXT"),     # parent: JSON [{"name": "Size", "values": ["S", "M"]}]
                       ("variant_values", "TEXT")))     # variant: JSON ["Navy", "M"]
    db.execute("CREATE INDEX IF NOT EXISTS items_parent ON items(parent_id)")
    # ---- stock locations
    db.execute("""CREATE TABLE IF NOT EXISTS stock_locations (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'store',  -- store, transit
        is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, address TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    if not db.execute("SELECT 1 FROM stock_locations WHERE is_default=1").fetchone():
        db.execute("INSERT INTO stock_locations (name, is_default) VALUES ('Main', 1)")
    if not db.execute("SELECT 1 FROM stock_locations WHERE kind='transit'").fetchone():
        db.execute("INSERT INTO stock_locations (name, kind) VALUES ('In transit', 'transit')")
    main = db.execute("SELECT id FROM stock_locations WHERE is_default=1").fetchone()[0]
    db.execute("""CREATE TABLE IF NOT EXISTS stock_levels (
        item_id INTEGER NOT NULL REFERENCES items(id), location_id INTEGER NOT NULL REFERENCES stock_locations(id),
        qty REAL NOT NULL DEFAULT 0, PRIMARY KEY (item_id, location_id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS location_levels (
        item_id INTEGER NOT NULL REFERENCES items(id), location_id INTEGER NOT NULL REFERENCES stock_locations(id),
        reorder_level REAL, reorder_up_to REAL, PRIMARY KEY (item_id, location_id))""")
    if "location_id" not in _cols(db, "stock_movements"):
        db.execute("ALTER TABLE stock_movements ADD COLUMN location_id INTEGER REFERENCES stock_locations(id)")
        db.execute("UPDATE stock_movements SET location_id=? WHERE location_id IS NULL", (main,))
    _add(db, "documents", (("location_id", "INTEGER REFERENCES stock_locations(id)"),))  # NULL = the default
    _add(db, "pos_tills", (("location_id", "INTEGER REFERENCES stock_locations(id)"),
                           ("drawer_mode", "TEXT NOT NULL DEFAULT 'none'"),     # none, printer
                           ("drawer_printer", "TEXT"),                          # the Windows printer's name
                           ("raw_receipts", "INTEGER NOT NULL DEFAULT 0")))     # ESC/POS receipts to that printer
    db.execute("UPDATE pos_tills SET location_id=? WHERE location_id IS NULL", (main,))
    db.execute("""CREATE TABLE IF NOT EXISTS stock_transfers (
        id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE,
        from_id INTEGER NOT NULL REFERENCES stock_locations(id), to_id INTEGER NOT NULL REFERENCES stock_locations(id),
        status TEXT NOT NULL DEFAULT 'draft',      -- draft, sent, partial, received, cancelled
        note TEXT, created_by INTEGER REFERENCES users(id), sent_by INTEGER REFERENCES users(id), sent_at TEXT,
        received_by INTEGER REFERENCES users(id), received_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS stock_transfer_lines (
        id INTEGER PRIMARY KEY, transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id),
        item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL,
        qty_received REAL NOT NULL DEFAULT 0, qty_returned REAL NOT NULL DEFAULT 0)""")
    # ---- restaurant: moves, merges and split bills, every one audited
    db.execute("""CREATE TABLE IF NOT EXISTS pos_order_events (
        id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES pos_orders(id), kind TEXT NOT NULL,
        details TEXT, user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_bills (
        id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES pos_orders(id), sale_id INTEGER REFERENCES pos_sales(id),
        mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',     -- open, paid, cancelled
        created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_bill_parts (
        id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES pos_bills(id), n INTEGER NOT NULL,
        label TEXT, amount INTEGER NOT NULL, lines TEXT, method TEXT, checkout_ref TEXT UNIQUE,
        tendered INTEGER NOT NULL DEFAULT 0, change_given INTEGER NOT NULL DEFAULT 0, paid_at TEXT,
        paid_by INTEGER REFERENCES users(id))""")
    _add(db, "pos_tenders", (("part_id", "INTEGER REFERENCES pos_bill_parts(id)"),))
    # ---- kitchen: stations (print, screen or both) and the tickets on the kitchen display
    db.execute("""CREATE TABLE IF NOT EXISTS pos_stations (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, output TEXT NOT NULL DEFAULT 'print',  -- print, screen, both
        sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1)""")
    if not db.execute("SELECT 1 FROM pos_stations").fetchone():
        db.execute("INSERT INTO pos_stations (name, output) VALUES ('Kitchen', 'print')")  # as before: dockets print
    db.execute("""CREATE TABLE IF NOT EXISTS pos_station_categories (
        category TEXT PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES pos_stations(id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS kds_tickets (
        id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES pos_orders(id),
        station_id INTEGER NOT NULL REFERENCES pos_stations(id), send_no INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), bumped_at TEXT, recalled_at TEXT)""")
    db.execute("CREATE INDEX IF NOT EXISTS kds_tickets_open ON kds_tickets(station_id, bumped_at)")
    db.execute("""CREATE TABLE IF NOT EXISTS kds_items (
        id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES kds_tickets(id), line_uid TEXT NOT NULL,
        name TEXT NOT NULL, qty REAL NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'new',  -- new, voided
        voided_qty REAL NOT NULL DEFAULT 0, moved_from TEXT, bumped_at TEXT)""")
    db.execute("""CREATE TABLE IF NOT EXISTS kds_devices (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, station_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), last_seen TEXT, revoked_at TEXT)""")
    _add(db, "company", (("kds_settings", "TEXT"),        # JSON: amber/red minutes, pairing code (hash) + expiry
                         ("pos_drawer_reasons", "TEXT")))
    # ---- the cash drawer: every time it is opened (sale, refund, no sale, test), and whether it worked
    db.execute("""CREATE TABLE IF NOT EXISTS pos_drawer_events (
        id INTEGER PRIMARY KEY, till_id INTEGER REFERENCES pos_tills(id), kind TEXT NOT NULL,  -- sale, part, refund, no_sale, test, receipt
        ref TEXT, reason TEXT, user_id INTEGER REFERENCES users(id), approval_id INTEGER REFERENCES pos_approvals(id),
        ok INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    # ---- 2.11.1: cashier PINs at the till (riyeser/pos_pins.py), printers and the other till hardware
    _add(db, "company", (("pos_cashier_settings", "TEXT"),    # JSON: pins auto/off, lock_minutes
                         ("pos_receipt_settings", "TEXT"),    # JSON: logo, header lines, footer
                         ("pos_scanner_settings", "TEXT")))   # JSON: prefix, suffix, capture, beep, unknown
    db.execute("""CREATE TABLE IF NOT EXISTS pos_pin_fails (
        id INTEGER PRIMARY KEY, device TEXT, target_id INTEGER REFERENCES users(id), till_id INTEGER, why TEXT,
        at_epoch REAL NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_cashier_events (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL,      -- unlock, lock, auto_lock, open_till
        user_id INTEGER REFERENCES users(id), signed_in_id INTEGER REFERENCES users(id), till_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    _add(db, "pos_tills", (("receipt_printer", "TEXT"),                      # NULL = ask each time (Windows print box)
                           ("paper_mm", "INTEGER NOT NULL DEFAULT 80"),       # 80 or 58
                           ("print_after", "TEXT NOT NULL DEFAULT 'ask'"),    # always, ask, never
                           ("receipt_copies", "INTEGER NOT NULL DEFAULT 1"),
                           ("drawer_on", "TEXT"),                             # JSON: cash_sale, cash_refund, no_sale
                           ("hw_setup_at", "TEXT"),                           # the first-time walkthrough was done
                           ("print_layout", "TEXT")))                         # JSON: "Adjust print layout"
    # 2.11.0 "print receipts straight to this printer" carries over as this till's receipt printer
    db.execute("UPDATE pos_tills SET receipt_printer=drawer_printer WHERE receipt_printer IS NULL AND raw_receipts=1"
               " AND drawer_printer IS NOT NULL")
    _add(db, "pos_stations", (("printer", "TEXT"), ("paper_mm", "INTEGER NOT NULL DEFAULT 80"), ("print_layout", "TEXT")))
