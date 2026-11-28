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
    ("bookings", "Bookings", "The bookings calendar: jobs, appointments and table bookings"),
    ("kitchen", "Kitchen screen", "Riyeser POS kitchen display: order tickets to cook and bump. No prices or "
                                  "customers. Add & edit: bump and recall tickets"),
    ("payroll", "Payroll", "Employees, pay rates, pay runs and payslips"),
    ("expenses", "Expense claims", "Staff paid for something and want it back. Add & edit: claim your own. "
                                   "Full: see everyone's, approve or decline, and pay them back"),
    ("accounts", "Accounts & reports", "Chart of accounts, journals, transaction search, financial reports and GST/BAS"),
    ("setup", "Setup", "Company details, tax codes, jobs, budgets and the audit trail"),
]
AREA_KEYS = [a for a, _, _ in AREAS]
PRESETS = {
    "owner": ("Owner / manager", {a: FULL for a in AREA_KEYS}),
    "bookkeeper": ("Bookkeeper", {**{a: FULL for a in AREA_KEYS}, "setup": EDIT}),
    "kitchen": ("Kitchen staff (kitchen screen only)", {**{a: HIDDEN for a in AREA_KEYS}, "kitchen": EDIT}),
    "sales": ("Sales staff", {"sales": EDIT, "bookings": EDIT, "kitchen": EDIT, "purchases": HIDDEN, "banking": HIDDEN, "stock": VIEW, "payroll": HIDDEN,
                              "accounts": HIDDEN, "setup": HIDDEN, "expenses": EDIT}),
    "payroll": ("Payroll officer", {"sales": HIDDEN, "bookings": VIEW, "kitchen": HIDDEN, "purchases": HIDDEN, "banking": VIEW, "stock": HIDDEN, "payroll": FULL,
                                    "accounts": HIDDEN, "setup": HIDDEN, "expenses": EDIT}),
    "readonly": ("Read-only (no payroll)", {**{a: VIEW for a in AREA_KEYS}, "payroll": HIDDEN}),
}
# Riyeser POS's own starting points (2.11.1). Levels only: the till's own rules do the rest. Sales "Add & edit" sells,
# takes payments and opens/closes the person's own till; refunds, voids, "No sale" and discounts over the limit need a
# manager's PIN (pos.void / pos.refund / no sale check for themselves). Sales "Full" is a manager at the till.
_NONE = {a: HIDDEN for a in AREA_KEYS}
PRESETS.update({
    "cashier": ("Cashier", {**_NONE, "sales": EDIT}),
    "supervisor": ("Supervisor / shift manager", {**_NONE, "sales": FULL, "kitchen": EDIT, "stock": VIEW, "bookings": EDIT}),
    "stock_staff": ("Stock & products", {**_NONE, "stock": FULL, "purchases": EDIT}),
    "manager": ("Manager", {**{a: FULL for a in AREA_KEYS}, "payroll": HIDDEN}),
})
HINTS = {
    "cashier": "Sell, take payments and open or close their own till. Refunds, voids, No sale and big discounts need "
               "a manager's PIN.",
    "supervisor": "Everything a Cashier can do, plus approve refunds, voids, No sale and discounts, close any till, and "
                  "see the day's sales.",
    "stock_staff": "Products, variants, stock, transfers, stocktake and receiving deliveries. No till.",
    "kitchen": "The kitchen screen only: order tickets to cook and bump. No prices or customers.",
    "manager": "Everything in the POS, including reports and setup, but not managing users.",
    "owner": "Full access to every area, but not managing users.",
    "bookkeeper": "Full access to the books; can look at setup but not change it.",
    "sales": "Invoices, quotes, customers and bookings. No banking, payroll or reports.",
    "payroll": "Employees, pay runs and payslips. Can look at bookings and banking.",
    "readonly": "Look and print only. Can't change anything.",
    "admin": "Everything, including adding users and changing what they can do.",
}
# Which starting points each app offers (the others still apply to people who already have them).
APP_PRESETS = {
    "pos": ["cashier", "supervisor", "stock_staff", "kitchen", "manager", "readonly"],
    "accounting": ["owner", "bookkeeper", "sales", "payroll", "readonly"],
    "invoices": ["owner", "bookkeeper", "sales", "readonly"],
    "bookings": ["owner", "bookkeeper", "sales", "readonly"],
    "estimate": ["owner", "sales", "readonly"],
    None: ["owner", "bookkeeper", "cashier", "supervisor", "sales", "stock_staff", "kitchen", "payroll", "readonly"],
}
PRESET_LABELS = {"readonly": {"pos": "Read-only"}, "sales": {"bookings": "Bookings & sales staff"}}
DEFAULT_PRESET = {"pos": "cashier"}


def app_key():
    """'pos', 'accounting', 'invoices', 'bookings', 'estimate' or None (run from source: everything is there)."""
    from .edition import app_product
    p = app_product()
    return "accounting" if p in ("basic", "enterprise") else p


def presets_for_app(key=None):
    """The starting points this app shows, in order: {key: (label, levels, hint)} (Administrator is added by the page)."""
    key = app_key() if key is None else key
    out = {}
    for k in APP_PRESETS.get(key, APP_PRESETS[None]):
        name, levels = PRESETS[k]
        out[k] = (PRESET_LABELS.get(k, {}).get(key, name), levels, HINTS.get(k, ""))
    return out


def closest_preset(user, offered, most=2):
    """(key, customised): the offered starting point this person's access matches, or is closest to (a few areas
    changed: "Cashier (customised)"); (None, True) when it's nothing like any of them ("Custom")."""
    exact = matching_preset(user, offered)
    if exact:
        return exact, False
    have = levels_for(user)
    best = min(((sum(have.get(a) != lv.get(a, HIDDEN) for a in AREA_KEYS), k) for k, (_, lv, _) in offered.items()),
               default=(99, None))
    return (best[1], True) if best[0] <= most else (None, True)


def matching_preset(user, offered):
    """Which offered starting point this person's access matches exactly, else None ("Custom")."""
    if user["role"] == "admin":
        return "admin"
    have = levels_for(user)
    for k, (_, levels, _) in offered.items():
        if all(have.get(a) == levels.get(a, HIDDEN) for a in AREA_KEYS):
            return k
    return None


PAYROLL_SOURCES = ("payrun", "payroll_import")


def pay_label(row):
    """'Wages (pay run 12)': how a pay run reads for people who can't see payroll."""
    ref = row["source_id"] if row["source_type"] == "payrun" else (row["reference"] or row["source_id"])
    return f"Wages (pay run {ref})"


def collapse_pay(rows, show=None):
    """Ledger lines as dicts, each with 'ids' (the journal line ids it stands for) and 'masked'.

    For people without Payroll access (F14), each pay run's lines on one account become a single line,
    "Wages (pay run 12)", with the total and no names, so no one's pay can be picked out. Rows need eid (or
    entry_id), account_id, debit, credit, memo, source_type, source_id and reference."""
    show = can("payroll") if show is None else show
    out, groups = [], {}
    for r in rows:
        d = dict(r)
        d["ids"], d["masked"] = [d.get("id")], False
        if show or d.get("source_type") not in PAYROLL_SOURCES:
            out.append(d)
            continue
        key = (d.get("eid") or d.get("entry_id"), d.get("account_id"))
        if key in groups:
            g_ = groups[key]
            g_["debit"] += d["debit"] or 0
            g_["credit"] += d["credit"] or 0
            g_["ids"].append(d.get("id"))
            continue
        d.update(memo=pay_label(d), emo=pay_label(d), masked=True, job_id=None)
        groups[key] = d
        out.append(d)
    for d in groups.values():  # a debit and a credit on one account in the same run: show the net only
        net = (d["debit"] or 0) - (d["credit"] or 0)
        d["debit"], d["credit"] = max(net, 0), max(-net, 0)
    return out

# Actions that remove or cancel something: they need Full.
DESTRUCTIVE = {"documents.void", "documents.delete", "documents.payment_void", "banking.feed_delete", "core.reverse",
               "payroll.void_run", "pos.cancel_order", "estimate.delete", "estimate.template_delete"}
# pos.void and pos.refund check for themselves: staff may do them with a manager's PIN or card.
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
            if "expenses" not in custom:
                # Saved before expense claims existed: everyone may claim their own; whoever has Full on
                # Purchases (bills) approves them.
                base["expenses"] = FULL if base["purchases"] == FULL else EDIT
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
        if endpoint in ("contacts.statements_all", "contacts.email_statements"):
            return "sales"
        if va.get("kind"):
            return _kind_area(va["kind"])
        if va.get("cid"):
            r = db.execute("SELECT kind FROM contacts WHERE id=?", (va["cid"],)).fetchone()
            return _kind_area(r["kind"]) if r else None
        return None
    if endpoint == "online.settings" or bp == "branding":
        return "setup"   # Business details & branding is a setup page in every app
    if bp == "online":
        return "sales"   # what came in from the website: bookings, orders, enquiries, payments
    if endpoint == "bookings.setup":
        return "setup" if request.method == "POST" else "bookings"
    if endpoint == "bookings.starters":
        return "setup"
    if bp == "bookings":
        return "bookings"
    if endpoint in ("pos.setup", "pos.set_mode", "pos.approvals", "pos.hardware", "pos.hardware_save",
                    "pos.hardware_start", "pos.hardware_test_print", "pos.hardware_test_docket",
                    "pos.hardware_scanner_tested", "pos.tables_setup", "pos.promotions"):
        return "setup"  # how the till is set up is a setup decision, not a sales one
    if bp == "pos":
        return "sales"
    if bp == "kds":
        return None if endpoint == "kds.pair" else "kitchen"  # the kitchen screen has its own permission
    if bp == "banking":
        return "banking"
    if bp == "inventory":
        return "stock"
    if bp in ("payroll", "links"):
        return "payroll"
    if bp == "expenses":
        return "expenses"
    if bp == "estimate":   # Riyeser Estimate: estimates and the quotes they make are sales; its settings are setup
        return "setup" if endpoint == "estimate.settings" and request.method == "POST" else "sales"
    if bp == "email":
        return "setup"
    if bp == "backups":
        return None  # anyone signed in can back up; restoring checks for an administrator itself
    if bp == "reports":
        return report_area(va["name"]) if endpoint == "reports.show" and va.get("name") else None
    if endpoint in ("core.accounts", "core.save_account", "core.account_ledger", "core.journal_list", "core.journal_new",
                    "core.entry", "core.reverse"):
        return "accounts"
    if endpoint in ("core.company", "core.tax_codes", "core.jobs", "core.budgets", "core.audit_log", "core.country",
                    "core.country_review"):
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
        from .db import PRICES
        return ("This company is read-only: your plan includes fewer companies. "
                f"Extra companies are {PRICES['extra_company']} a month each — add them in Riyeser Central.")
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
