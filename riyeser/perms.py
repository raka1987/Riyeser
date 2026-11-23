"""Who can see and change what, area by area.

Each user has a level for each area of the books:
    0 Hidden      - the area is not shown at all, and its pages and figures are refused
    1 View        - look and print only
    2 Add & edit  - create and change, but not delete or void
    3 Full        - everything, including delete and void
Administrators always have Full everywhere and are the only ones who manage users.
Users without their own settings follow their role: accountant = Full, viewer = View.
The checks run on the server for every request, so hiding is real, not just a missing button.
"""
import json

from flask import g, request

HIDDEN, VIEW, EDIT, FULL = 0, 1, 2, 3
LEVELS = [(HIDDEN, "Hidden"), (VIEW, "View"), (EDIT, "Add & edit"), (FULL, "Full")]
AREAS = [
    ("sales", "Sales", "Invoices, quotes, customers, payments received and the shop counter"),
    ("purchases", "Purchases", "Bills, purchase orders, suppliers and paying bills"),
    ("banking", "Banking", "Bank accounts, money in and out, transfers, reconciling and statement import"),
    ("stock", "Stock", "Stock items, stocktake and adjustments"),
    ("payroll", "Payroll", "Employees, pay rates, pay runs and payslips"),
    ("accounts", "Accounts & reports", "Chart of accounts, journals, transaction search, financial reports and GST/BAS"),
    ("setup", "Setup", "Company details, tax codes, jobs, budgets and the audit trail"),
]
AREA_KEYS = [a for a, _, _ in AREAS]
PRESETS = {
    "owner": ("Owner / manager", {a: FULL for a in AREA_KEYS}),
    "bookkeeper": ("Bookkeeper", {**{a: FULL for a in AREA_KEYS}, "setup": EDIT}),
    "sales": ("Sales staff", {"sales": EDIT, "purchases": HIDDEN, "banking": HIDDEN, "stock": VIEW, "payroll": HIDDEN,
                              "accounts": HIDDEN, "setup": HIDDEN}),
    "payroll": ("Payroll officer", {"sales": HIDDEN, "purchases": HIDDEN, "banking": VIEW, "stock": HIDDEN, "payroll": FULL,
                                    "accounts": HIDDEN, "setup": HIDDEN}),
    "readonly": ("Read-only (no payroll)", {**{a: VIEW for a in AREA_KEYS}, "payroll": HIDDEN}),
}
PAYROLL_SOURCES = ("payrun", "payroll_import")

# Actions that remove or cancel something: they need Full.
DESTRUCTIVE = {"documents.void", "documents.delete", "documents.payment_void", "banking.feed_delete", "core.reverse",
               "payroll.void_run", "pos.void", "pos.cancel_order"}
REPORT_AREA = {
    "aged_receivables": "sales", "sales_customer": "sales", "sales_item": "sales",
    "aged_payables": "purchases", "purchases_supplier": "purchases",
    "inventory_valuation": "stock", "reorder": "stock",
    "payroll_summary": "payroll",
}


def role_defaults(role):
    level = FULL if role in ("admin", "accountant") else VIEW
    return {a: level for a in AREA_KEYS}


def levels_for(user):
    """This user's level for every area."""
    if not user:
        return {a: HIDDEN for a in AREA_KEYS}
    if user["role"] == "admin":
        return _capped({a: FULL for a in AREA_KEYS}, user)
    base = role_defaults(user["role"])
    raw = user["perms"] if "perms" in user.keys() else None
    if raw:
        try:
            custom = json.loads(raw)
            for a in AREA_KEYS:
                if a in custom and int(custom[a]) in (HIDDEN, VIEW, EDIT, FULL):
                    base[a] = int(custom[a])
        except (ValueError, TypeError):
            pass
    if user["role"] == "viewer":  # a viewer never changes anything, whatever is saved
        base = {a: min(v, VIEW) for a, v in base.items()}
    return _capped(base, user)


def _capped(levels, user):
    """A company beyond the plan's included companies is read-only for everyone until the add-on is bought."""
    if g.get("over_allowance") and user is g.get("user"):
        return {a: min(v, VIEW) for a, v in levels.items()}
    return levels


def level(area, user=None):
    return levels_for(user if user is not None else g.get("user")).get(area, HIDDEN)


def can(area, needed=VIEW, user=None):
    return level(area, user) >= needed


def report_area(name):
    return REPORT_AREA.get(name, "accounts")


def _side_area(side):
    return "sales" if side == "sale" else "purchases" if side == "purchase" else None


def _kind_area(kind):
    return "sales" if kind == "customer" else "purchases" if kind == "supplier" else None


def area_of(endpoint, view_args, args, db):
    """Which area a page or action belongs to (None = open to everyone signed in)."""
    if not endpoint:
        return None
    bp = endpoint.split(".", 1)[0]
    va = view_args or {}
    if bp == "documents":
        if va.get("side"):
            return _side_area(va["side"])
        if va.get("doc_id"):
            r = db.execute("SELECT side FROM documents WHERE id=?", (va["doc_id"],)).fetchone()
            return _side_area(r["side"]) if r else None
        if va.get("pid"):
            r = db.execute("SELECT direction FROM payments WHERE id=?", (va["pid"],)).fetchone()
            return ("sales" if r["direction"] == "in" else "purchases") if r else None
        return None
    if bp == "contacts":
        if va.get("kind"):
            return _kind_area(va["kind"])
        if va.get("cid"):
            r = db.execute("SELECT kind FROM contacts WHERE id=?", (va["cid"],)).fetchone()
            return _kind_area(r["kind"]) if r else None
        return None
    if endpoint in ("pos.setup", "pos.set_mode"):
        return "setup"  # how the till is set up is a setup decision, not a sales one
    if bp == "pos":
        return "sales"
    if bp == "banking":
        return "banking"
    if bp == "inventory":
        return "stock"
    if bp in ("payroll", "links"):
        return "payroll"
    if bp == "reports":
        return report_area(va["name"]) if endpoint == "reports.show" and va.get("name") else None
    if endpoint in ("core.accounts", "core.save_account", "core.account_ledger", "core.journal_list", "core.journal_new",
                    "core.entry", "core.reverse"):
        return "accounts"
    if endpoint in ("core.company", "core.tax_codes", "core.jobs", "core.budgets", "core.audit_log"):
        return "setup"
    return None


def needed_level(endpoint, method):
    if endpoint in DESTRUCTIVE:
        return FULL
    if method == "POST":
        return EDIT
    return VIEW


def check_request(db):
    """Returns None when allowed, else a short reason (the caller refuses the request)."""
    user = g.get("user")
    if not user:
        return None
    area = area_of(request.endpoint, request.view_args, request.args, db)
    if area is None:
        return None
    need = needed_level(request.endpoint, request.method)
    # Saving a PDF copy of an invoice or bill only needs View.
    if request.endpoint == "documents.save_pdf":
        need = VIEW
    have = level(area, user)
    if have >= need:
        return None
    name = dict((a, n) for a, n, _ in AREAS)[area]
    if g.get("over_allowance") and need > VIEW:
        return ("This company is read-only: your plan includes fewer companies. "
                "Extra companies are $10 a month each — add them in Riyeser Central.")
    if have == HIDDEN:
        return f"{name} isn't available for your user."
    if need == FULL:
        return f"Your user can't delete or void in {name}. Ask an administrator."
    return f"Your user can only look at {name}, not change it."


def parse_form(form):
    """Levels from the Users screen (fields perm_<area>)."""
    out = {}
    for a in AREA_KEYS:
        v = form.get(f"perm_{a}")
        if v is not None and v.isdigit() and int(v) in (HIDDEN, VIEW, EDIT, FULL):
            out[a] = int(v)
    return out
