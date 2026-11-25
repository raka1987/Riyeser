"""Database connection, initialisation and seed data."""
import os
import sqlite3
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation

from flask import current_app, g
from werkzeug.security import generate_password_hash


# ---------------------------------------------------------------- money helpers
def to_cents(value) -> int:
    """Parse '1,234.56' / '$10' / 10.5 into integer cents (half-up)."""
    if value is None:
        return 0
    if isinstance(value, int):
        return value * 100
    s = str(value).replace(",", "").replace("$", "").strip()
    if not s:
        return 0
    try:
        return int((Decimal(s) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except InvalidOperation:
        raise ValueError(f"Invalid amount: {value!r}")


def round_cents(x) -> int:
    return int(Decimal(str(x)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def fmt_money(cents, blank_zero=False) -> str:
    if cents is None:
        cents = 0
    cents = round_cents(cents)
    if blank_zero and cents == 0:
        return ""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100:,}.{cents % 100:02d}"


def cents_str(cents) -> str:
    """Plain decimal string for form inputs."""
    cents = round_cents(cents or 0)
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"


# ---------------------------------------------------------------- connection
def get_db():
    if "db" not in g:
        # the company that's open; several people can share it (riyeser serve), so wait for each other's writes
        g.db = sqlite3.connect(g.get("db_path") or current_app.config["DATABASE"], timeout=30)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_e=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def write_txn(db):
    """Start the write transaction now (BEGIN IMMEDIATE) unless one is already open.

    Call it before reading anything a write depends on (the next invoice number, the balance still due, stock on
    hand, who was already paid): another person saving at the same moment then waits for this one to commit,
    instead of both reading the same value and writing twice (F15). Already in a transaction = this connection has
    written, so it already holds the write lock."""
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")


def linked(db, key) -> int:
    row = db.execute("SELECT account_id FROM linked_accounts WHERE key=?", (key,)).fetchone()
    if not row:
        raise ValueError(f"Default account '{key}' is not configured")
    return row["account_id"]


def audit(db, action, details=""):
    uid = getattr(g, "user", None)
    uid = uid["id"] if uid else None
    db.execute("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)", (uid, action, details))


# ---------------------------------------------------------------- seed data
DEFAULT_ACCOUNTS = [
    # code, name, type, is_bank, default tax code
    ("1-1110", "Business Cheque Account", "asset", 1, "N-T"),
    ("1-1120", "Business Savings Account", "asset", 1, "N-T"),
    ("1-1190", "Undeposited Funds", "asset", 1, "N-T"),
    ("1-1200", "Trade Debtors", "asset", 0, "N-T"),
    ("1-1300", "Inventory", "asset", 0, "N-T"),
    ("1-1400", "Prepayments", "asset", 0, "N-T"),
    ("1-2100", "Office Equipment at Cost", "asset", 0, "CAP"),
    ("1-2110", "Office Equipment Accum Dep", "asset", 0, "N-T"),
    ("1-2200", "Motor Vehicles at Cost", "asset", 0, "CAP"),
    ("1-2210", "Motor Vehicles Accum Dep", "asset", 0, "N-T"),
    ("2-1100", "Business Credit Card", "liability", 1, "N-T"),
    ("2-1200", "Trade Creditors", "liability", 0, "N-T"),
    ("2-1310", "GST Collected", "liability", 0, "N-T"),
    ("2-1330", "GST Paid", "liability", 0, "N-T"),
    ("2-1410", "PAYG Withholding Payable", "liability", 0, "N-T"),
    ("2-1420", "Superannuation Payable", "liability", 0, "N-T"),
    ("2-1500", "Customer Deposits", "liability", 0, "N-T"),
    ("2-2100", "Business Loan", "liability", 0, "N-T"),
    ("3-1000", "Owner's Capital", "equity", 0, "N-T"),
    ("3-2000", "Owner's Drawings", "equity", 0, "N-T"),
    ("3-8000", "Retained Earnings", "equity", 0, "N-T"),
    ("3-9000", "Current Year Earnings", "equity", 0, "N-T"),
    ("3-9999", "Historical Balancing", "equity", 0, "N-T"),
    ("4-1000", "Sales - Products", "income", 0, "GST"),
    ("4-2000", "Sales - Services", "income", 0, "GST"),
    ("4-3000", "Freight Collected", "income", 0, "GST"),
    ("5-1000", "Cost of Goods Sold", "cost_of_sales", 0, "GST"),
    ("5-1100", "Freight Inwards", "cost_of_sales", 0, "GST"),
    ("5-1200", "Inventory Adjustments", "cost_of_sales", 0, "N-T"),
    ("5-1300", "Subcontractors", "cost_of_sales", 0, "GST"),
    ("6-1000", "Advertising & Marketing", "expense", 0, "GST"),
    ("6-1100", "Bank Fees", "expense", 0, "FRE"),
    ("6-1200", "Depreciation", "expense", 0, "N-T"),
    ("6-1300", "Electricity & Gas", "expense", 0, "GST"),
    ("6-1400", "Insurance", "expense", 0, "GST"),
    ("6-1500", "Office Supplies", "expense", 0, "GST"),
    ("6-1600", "Rent", "expense", 0, "GST"),
    ("6-1700", "Telephone & Internet", "expense", 0, "GST"),
    ("6-1800", "Motor Vehicle Expenses", "expense", 0, "GST"),
    ("6-1900", "Repairs & Maintenance", "expense", 0, "GST"),
    ("6-2000", "Accounting & Legal", "expense", 0, "GST"),
    ("6-2100", "Software Subscriptions", "expense", 0, "GST"),
    ("6-2200", "Travel", "expense", 0, "GST"),
    ("6-5000", "Wages & Salaries", "expense", 0, "N-T"),
    ("6-5100", "Superannuation Expense", "expense", 0, "N-T"),
    ("8-1000", "Interest Income", "other_income", 0, "INP"),
    ("9-1000", "Interest Expense", "other_expense", 0, "INP"),
]

DEFAULT_TAX_CODES = [
    ("GST", "Goods & Services Tax", 10.0, "gst"),
    ("CAP", "Capital Acquisitions", 10.0, "capital"),
    ("FRE", "GST Free", 0.0, "gst_free"),
    ("EXP", "Exports", 0.0, "export"),
    ("INP", "Input Taxed", 0.0, "input_taxed"),
    ("N-T", "Not Reportable", 0.0, "not_reportable"),
]

LINKED = {
    "receivables": "1-1200",
    "payables": "2-1200",
    "inventory": "1-1300",
    "cogs": "5-1000",
    "stock_adjust": "5-1200",
    "gst_collected": "2-1310",
    "gst_paid": "2-1330",
    "wages": "6-5000",
    "super_expense": "6-5100",
    "payg_payable": "2-1410",
    "super_payable": "2-1420",
    "retained_earnings": "3-8000",
    "current_earnings": "3-9000",
    "historical_balancing": "3-9999",
    "default_bank": "1-1110",
    "default_income": "4-1000",
    "default_expense": "6-1500",
}


def migrate(db):
    """Bring an older company file up to date. Safe to run repeatedly."""
    if "perms" not in {r["name"] for r in db.execute("PRAGMA table_info(users)")}:
        db.execute("ALTER TABLE users ADD COLUMN perms TEXT")  # per-area levels (riyeser/perms.py)
    cols = {r["name"] for r in db.execute("PRAGMA table_info(company)")}
    if "edition" not in cols:
        db.execute("ALTER TABLE company ADD COLUMN edition TEXT NOT NULL DEFAULT 'enterprise'")
    if "pos_mode" not in cols:
        db.execute("ALTER TABLE company ADD COLUMN pos_mode TEXT NOT NULL DEFAULT 'retail'")
    if "category" not in {r["name"] for r in db.execute("PRAGMA table_info(items)")}:
        db.execute("ALTER TABLE items ADD COLUMN category TEXT")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_orders (
        id INTEGER PRIMARY KEY,
        order_type TEXT NOT NULL DEFAULT 'retail',   -- retail (parked sale), dine_in, takeaway
        table_no TEXT, customer_id INTEGER REFERENCES contacts(id), lines TEXT NOT NULL, note TEXT,
        status TEXT NOT NULL DEFAULT 'open',          -- open, paid, cancelled
        sale_id INTEGER REFERENCES pos_sales(id), user_id INTEGER REFERENCES users(id),
        kitchen_sent_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    if "auto_pdf" not in cols:
        db.execute("ALTER TABLE company ADD COLUMN auto_pdf INTEGER NOT NULL DEFAULT 0")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_sales (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        payment_id INTEGER REFERENCES payments(id),
        method TEXT NOT NULL,
        tendered INTEGER NOT NULL DEFAULT 0,
        change_given INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER REFERENCES users(id),
        voided INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS imported_payruns (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, payrun_id TEXT NOT NULL, pay_date TEXT,
        employees INTEGER, gross INTEGER, entry_id INTEGER REFERENCES journal_entries(id),
        file_name TEXT, imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE(source, payrun_id))""")
    # Riyeser POS: favourites, product photos, the switches chosen on POS setup, and named tills.
    if "pos_favourite" not in {r["name"] for r in db.execute("PRAGMA table_info(items)")}:
        db.execute("ALTER TABLE items ADD COLUMN pos_favourite INTEGER NOT NULL DEFAULT 0")
    if "pos_features" not in {r["name"] for r in db.execute("PRAGMA table_info(company)")}:
        db.execute("ALTER TABLE company ADD COLUMN pos_features TEXT")  # JSON list; empty = the defaults for the mode
    db.execute("""CREATE TABLE IF NOT EXISTS item_photos (
        item_id INTEGER PRIMARY KEY REFERENCES items(id), mime TEXT NOT NULL, data BLOB NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_tills (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, location TEXT, active INTEGER NOT NULL DEFAULT 1)""")
    if not db.execute("SELECT 1 FROM pos_tills").fetchone():
        db.execute("INSERT INTO pos_tills (name, location) VALUES ('Till 1', 'Front counter')")
    if "till_id" not in {r["name"] for r in db.execute("PRAGMA table_info(pos_sales)")}:
        db.execute("ALTER TABLE pos_sales ADD COLUMN till_id INTEGER REFERENCES pos_tills(id)")
    # Manager approvals (PIN / manager card) and opening + closing the till.
    ucols = {r["name"] for r in db.execute("PRAGMA table_info(users)")}
    for col in ("pos_pin_hash", "pos_card_hash", "pos_card_last4"):
        if col not in ucols:
            db.execute(f"ALTER TABLE users ADD COLUMN {col} TEXT")
    if "pos_approval_rules" not in {r["name"] for r in db.execute("PRAGMA table_info(company)")}:
        db.execute("ALTER TABLE company ADD COLUMN pos_approval_rules TEXT")  # JSON; empty = the defaults
    db.execute("""CREATE TABLE IF NOT EXISTS pos_approvals (
        id INTEGER PRIMARY KEY, action TEXT NOT NULL, ref TEXT, amount INTEGER NOT NULL DEFAULT 0, reason TEXT,
        requested_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id), method TEXT NOT NULL,
        till_id INTEGER REFERENCES pos_tills(id), used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_auth_fails (
        id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id),
        at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_shifts (
        id INTEGER PRIMARY KEY, till_id INTEGER NOT NULL REFERENCES pos_tills(id), status TEXT NOT NULL DEFAULT 'open',
        opened_by INTEGER REFERENCES users(id), opened_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        float_amount INTEGER NOT NULL DEFAULT 0, closed_by INTEGER REFERENCES users(id), closed_at TEXT,
        counts TEXT, counted INTEGER, expected INTEGER, variance INTEGER, card_settlement INTEGER,
        reason TEXT, approval_id INTEGER REFERENCES pos_approvals(id), deposit INTEGER,
        deposit_account_id INTEGER REFERENCES accounts(id), summary TEXT)""")
    db.execute("""CREATE TABLE IF NOT EXISTS pos_refunds (
        id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES pos_sales(id),
        entry_id INTEGER REFERENCES journal_entries(id), method TEXT NOT NULL, amount INTEGER NOT NULL,
        tax INTEGER NOT NULL DEFAULT 0, lines TEXT NOT NULL, reason TEXT, user_id INTEGER REFERENCES users(id),
        approval_id INTEGER REFERENCES pos_approvals(id), shift_id INTEGER REFERENCES pos_shifts(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    if "shift_id" not in {r["name"] for r in db.execute("PRAGMA table_info(pos_sales)")}:
        db.execute("ALTER TABLE pos_sales ADD COLUMN shift_id INTEGER REFERENCES pos_shifts(id)")
    if not db.execute("SELECT 1 FROM linked_accounts WHERE key='cash_over_short'").fetchone():
        row = db.execute("SELECT id FROM accounts WHERE code='6-1950'").fetchone()
        if not row:
            ntc = db.execute("SELECT id FROM tax_codes WHERE code='N-T'").fetchone()
            row = {"id": db.execute("INSERT INTO accounts (code, name, type, is_bank, tax_code_id) VALUES"
                                    " ('6-1950', 'Cash Over/Short', 'expense', 0, ?)",
                                    (ntc["id"] if ntc else None,)).lastrowid}
        db.execute("INSERT INTO linked_accounts (key, account_id) VALUES ('cash_over_short', ?)", (row["id"],))
    for key, code in (("pos_cash", "1-1190"), ("pos_card", "1-1110")):
        if not db.execute("SELECT 1 FROM linked_accounts WHERE key=?", (key,)).fetchone():
            row = db.execute("SELECT id FROM accounts WHERE code=?", (code,)).fetchone() or \
                db.execute("SELECT account_id id FROM linked_accounts WHERE key='default_bank'").fetchone()
            if row:
                db.execute("INSERT INTO linked_accounts (key, account_id) VALUES (?,?)", (key, row["id"]))
    # Riyeser Bookings: jobs, appointments and table bookings, with who/what they're booked on and the services offered.
    ccols = {r["name"] for r in db.execute("PRAGMA table_info(company)")}
    if "bookings_mode" not in ccols:
        db.execute("ALTER TABLE company ADD COLUMN bookings_mode TEXT NOT NULL DEFAULT 'jobs'")  # jobs, appointments, tables
    if "bookings_hours" not in ccols:
        db.execute("ALTER TABLE company ADD COLUMN bookings_hours TEXT NOT NULL DEFAULT '07:00-18:00'")
    db.execute("""CREATE TABLE IF NOT EXISTS booking_resources (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'staff',  -- staff, table, room, vehicle
        capacity INTEGER, colour TEXT, active INTEGER NOT NULL DEFAULT 1)""")
    db.execute("""CREATE TABLE IF NOT EXISTS booking_services (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 60, price INTEGER NOT NULL DEFAULT 0,
        item_id INTEGER REFERENCES items(id), active INTEGER NOT NULL DEFAULT 1)""")
    db.execute("""CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'jobs', contact_id INTEGER REFERENCES contacts(id),
        resource_id INTEGER REFERENCES booking_resources(id), service_id INTEGER REFERENCES booking_services(id),
        starts_at TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 60, title TEXT, address TEXT, party INTEGER,
        phone TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'booked',  -- booked, confirmed, started, done, cancelled, no_show
        document_id INTEGER REFERENCES documents(id), created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("CREATE INDEX IF NOT EXISTS bookings_starts ON bookings(starts_at)")
    if "price" not in {r["name"] for r in db.execute("PRAGMA table_info(bookings)")}:
        db.execute("ALTER TABLE bookings ADD COLUMN price INTEGER")  # older files only: the price now lives on booking_jobs
    if "description" not in {r["name"] for r in db.execute("PRAGMA table_info(booking_services)")}:
        db.execute("ALTER TABLE booking_services ADD COLUMN description TEXT")  # wording on the invoice line
    # A job holds one or more visits (rows in bookings). The calendar schedules visits; the office invoices the job.
    if "bookings_labour_rate" not in ccols:
        db.execute("ALTER TABLE company ADD COLUMN bookings_labour_rate INTEGER NOT NULL DEFAULT 0")  # cents/hour inc GST
    db.execute("""CREATE TABLE IF NOT EXISTS booking_jobs (
        id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id), service_id INTEGER REFERENCES booking_services(id),
        title TEXT, address TEXT, phone TEXT, notes TEXT,
        billing TEXT NOT NULL DEFAULT 'fixed',  -- fixed: the agreed price; time: hours at the labour rate plus parts
        price INTEGER,                          -- agreed price in cents inc GST; empty = the job type's price
        status TEXT NOT NULL DEFAULT 'requested',  -- requested, scheduled, in_progress, needs_visit, on_hold, completed, cancelled
        next_action TEXT,                       -- why it needs another visit
        document_id INTEGER REFERENCES documents(id), created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS booking_time (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES booking_jobs(id), booking_id INTEGER REFERENCES bookings(id),
        user_id INTEGER REFERENCES users(id), minutes INTEGER NOT NULL, note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS booking_materials (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES booking_jobs(id), booking_id INTEGER REFERENCES bookings(id),
        item_id INTEGER REFERENCES items(id), description TEXT, qty REAL NOT NULL DEFAULT 1,
        unit_price INTEGER NOT NULL DEFAULT 0, user_id INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    bcols = {r["name"] for r in db.execute("PRAGMA table_info(bookings)")}
    for col, ddl in (("job_id", "INTEGER REFERENCES booking_jobs(id)"), ("outcome", "TEXT"), ("outcome_note", "TEXT")):
        if col not in bcols:
            db.execute(f"ALTER TABLE bookings ADD COLUMN {col} {ddl}")  # outcome: finished, return, no_access
    # every older booking becomes a job with one visit
    for b in db.execute("SELECT * FROM bookings WHERE job_id IS NULL").fetchall():
        st = {"booked": "scheduled", "confirmed": "scheduled", "started": "in_progress", "done": "completed"}.get(
            b["status"], "cancelled")
        jid = db.execute("INSERT INTO booking_jobs (contact_id, service_id, title, address, phone, price, status, document_id,"
                         " created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (b["contact_id"], b["service_id"], b["title"], b["address"], b["phone"], b["price"], st,
                          b["document_id"], b["created_by"], b["created_at"])).lastrowid
        db.execute("UPDATE bookings SET job_id=? WHERE id=?", (jid, b["id"]))
    db.execute("CREATE INDEX IF NOT EXISTS bookings_job ON bookings(job_id)")
    # Demo companies are marked, so every screen can say so. Start again keeps a ledger head here (riyeser/archive.py).
    if "is_demo" not in {r["name"] for r in db.execute("PRAGMA table_info(company)")}:
        db.execute("ALTER TABLE company ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0")
    db.execute("CREATE TABLE IF NOT EXISTS archive_meta (key TEXT PRIMARY KEY, value TEXT)")
    if "kind" not in {r["name"] for r in db.execute("PRAGMA table_info(payruns)")}:
        db.execute("ALTER TABLE payruns ADD COLUMN kind TEXT NOT NULL DEFAULT 'regular'")  # regular, extra (bonus)
    _unique_document_numbers(db)
    db.commit()


def duplicate_numbers(db):
    """[(side, number, count)] of document numbers used more than once (older files, saved by two people at once)."""
    return [tuple(r) for r in db.execute("SELECT side, number, COUNT(*) n FROM documents GROUP BY side, number"
                                         " HAVING COUNT(*) > 1 ORDER BY side, number")]


def _unique_document_numbers(db):
    """One number per invoice (bill): UNIQUE(side, number) (F15). A file that already has duplicates keeps them as
    they are (nothing is renumbered behind anyone's back) and opens as before; it's logged, and the index is added
    once they're sorted out."""
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name='documents_side_number'").fetchone():
        return
    dups = duplicate_numbers(db)
    if dups:
        import logging
        logging.getLogger("riyeser").warning(
            "This company file has %d document numbers used more than once (%s). They're kept as they are; new "
            "numbers are still checked for duplicates.", len(dups),
            ", ".join(f"{n} x{c}" for _s, n, c in dups[:10]))
        return
    db.execute("CREATE UNIQUE INDEX documents_side_number ON documents(side, number)")


# Riyeser prices in one place: US dollars a month per business (the same as riyeser.com/pricing.html).
# Each paid program includes 3 users; each extra user is US$7 a month for that program. Plus includes Basics.
PRICE_USD = {"basic": 25, "plus": 39, "payroll": 25, "pos": 29, "bookings": 25, "calls": 39, "as_built": 29,
             "extra_user": 7, "extra_company": 10}
PRICES = {k: f"US${v}" for k, v in PRICE_USD.items()}   # for screens: {{ prices.basic }} -> "US$25"

# Edition names in one place: change them here and every screen follows.
#   name  = short name used in menus, settings and help ("Basic", "Enterprise")
#   title = the product name in the app's logo
#   app   = the full name of the separate Windows app (window title, installer, Start menu)
EDITIONS = {
    "basic": {"name": "Basics", "title": "Accounting Basics", "app": "Riyeser Accounting Basics", "price": f"{PRICES['basic']} a month"},
    "enterprise": {"name": "Plus", "title": "Accounting Plus", "app": "Riyeser Accounting Plus", "price": f"{PRICES['plus']} a month"},
}

# The third app built from this code base: the till on its own (see riyeser/edition.py).
POS_APP = {"name": "POS", "title": "POS", "app": "Riyeser POS", "price": f"{PRICES['pos']} a month"}

# The fourth: free invoicing on its own. Same company file, so a business can move up to Accounting Basics any time.
INVOICES_APP = {"name": "Invoices", "title": "Invoices", "app": "Riyeser Invoices", "price": "Free"}

# The fifth: bookings and scheduling for trades jobs, appointments and restaurant tables.
BOOKINGS_APP = {"name": "Bookings", "title": "Bookings", "app": "Riyeser Bookings", "price": f"{PRICES['bookings']} a month"}



def init_db(company_name="My Company Pty Ltd", admin_password="admin", edition=None):
    db = get_db()
    with current_app.open_resource("schema.sql") as f:
        db.executescript(f.read().decode("utf8"))
    db.execute("INSERT INTO company (id, name) VALUES (1, ?)", (company_name,))
    for code, name, rate, kind in DEFAULT_TAX_CODES:
        db.execute("INSERT INTO tax_codes (code, name, rate, kind) VALUES (?,?,?,?)", (code, name, rate, kind))
    tc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM tax_codes")}
    for code, name, typ, is_bank, tax in DEFAULT_ACCOUNTS:
        db.execute("INSERT INTO accounts (code, name, type, is_bank, tax_code_id) VALUES (?,?,?,?,?)",
                   (code, name, typ, is_bank, tc[tax]))
    acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
    for key, code in LINKED.items():
        db.execute("INSERT INTO linked_accounts (key, account_id) VALUES (?,?)", (key, acc[code]))
    db.execute("UPDATE tax_codes SET collected_account_id=?, paid_account_id=? WHERE kind IN ('gst','capital')",
               (acc["2-1310"], acc["2-1330"]))
    db.execute("INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)",
               ("admin", generate_password_hash(admin_password), "Administrator", "admin"))
    db.commit()
    migrate(db)
    if edition not in EDITIONS:
        from .edition import app_edition, is_invoices_app, is_bookings_app
        edition = app_edition() or ("basic" if is_invoices_app() or is_bookings_app() else "enterprise")
    db.execute("UPDATE company SET edition=? WHERE id=1", (edition,))
    db.commit()


def init_app(app):
    app.teardown_appcontext(close_db)

    @app.cli.command("init-db")
    def init_db_command():
        """Create a fresh company file."""
        path = app.config["DATABASE"]
        if os.path.exists(path):
            _archive_before_replacing(path, "init-db from the command line")
        init_db()
        _keep_ledger_head(path)
        print(f"Initialised {path} (login admin / admin)")

    @app.cli.command("seed-demo")
    def seed_demo_command():
        """Create a fresh company file populated with demo data."""
        from .demo import seed_demo
        path = app.config["DATABASE"]
        if os.path.exists(path):
            _archive_before_replacing(path, "seed-demo from the command line")
        init_db("Sample Trading Co (demo)")
        seed_demo(get_db())
        _keep_ledger_head(path)
        print(f"Demo company created at {path} (login admin / admin)")


def _archive_before_replacing(path, reason):
    """Command-line tools that start a company file again keep a locked archive copy first (nothing is lost)."""
    from . import archive
    archive.archive_company(path, os.path.dirname(os.path.abspath(path)), "main", by="command line", reason=reason,
                            main_db=path)
    from datetime import datetime, timezone
    os.replace(path, f"{path}.{datetime.now(timezone.utc):%Y%m%d-%H%M%S}.replaced")  # moved aside, never deleted


def _keep_ledger_head(path):
    from . import archive
    archive.copy_head_into(path, os.path.dirname(os.path.abspath(path)))
