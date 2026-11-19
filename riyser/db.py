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
        g.db = sqlite3.connect(current_app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_e=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def linked(db, key) -> int:
    row = db.execute("SELECT account_id FROM linked_accounts WHERE key=?", (key,)).fetchone()
    if not row:
        raise ValueError(f"Linked account '{key}' is not configured")
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


def init_db(company_name="My Company Pty Ltd", admin_password="admin"):
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


def init_app(app):
    app.teardown_appcontext(close_db)

    @app.cli.command("init-db")
    def init_db_command():
        """Create a fresh company file."""
        path = app.config["DATABASE"]
        if os.path.exists(path):
            os.remove(path)
        init_db()
        print(f"Initialised {path} (login admin / admin)")

    @app.cli.command("seed-demo")
    def seed_demo_command():
        """Create a fresh company file populated with demo data."""
        from .demo import seed_demo
        path = app.config["DATABASE"]
        if os.path.exists(path):
            os.remove(path)
        init_db("Clearwater Trading Pty Ltd")
        seed_demo(get_db())
        print(f"Demo company created at {path} (login admin / admin)")
