"""Help pages and the support diagnostics bundle (groundwork for the Riyeser AI Assistant)."""
import json
import os
import platform
import sys
from datetime import datetime

from flask import Blueprint, render_template, Response, current_app, g, request

from ..db import get_db
from .. import __version__

bp = Blueprint("help", __name__, url_prefix="/help")

# which help section each part of the app belongs to
SECTION_FOR = {"core": "accounts", "documents": "sales", "contacts": "sales", "banking": "banking",
               "inventory": "stock", "payroll": "payroll", "reports": "reports", "pos": "pos", "links": "modules",
               "auth": "users", "help": "start"}


def section_for(endpoint):
    bp_name = (endpoint or "").split(".")[0]
    if endpoint in ("core.dashboard",):
        return "start"
    if endpoint in ("core.company", "core.tax_codes", "core.jobs", "core.budgets", "core.audit_log"):
        return "setup"
    if (endpoint or "").startswith("documents.") and request.view_args and request.view_args.get("side") == "purchase":
        return "stock"
    return SECTION_FOR.get(bp_name, "start")


@bp.route("/")
def index():
    return render_template("help/index.html", version=__version__)


def diagnostics(db):
    q = lambda sql, *a: db.execute(sql, a).fetchone()[0]
    tb = db.execute("SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) FROM journal_lines").fetchone()
    c = db.execute("SELECT name, edition, lock_date, gst_registered, fy_start_month, pos_mode FROM company").fetchone()
    checks = {
        "books_balance": tb[0] == tb[1],
        "negative_stock_items": q("SELECT COUNT(*) FROM items WHERE is_inventoried=1 AND qty_on_hand<0"),
        "inventory_value_vs_ledger_cents": round(
            q("SELECT COALESCE(SUM(qty_on_hand*avg_cost),0) FROM items WHERE is_inventoried=1")
            - q("SELECT COALESCE(SUM(l.debit-l.credit),0) FROM journal_lines l WHERE l.account_id ="
                " (SELECT account_id FROM linked_accounts WHERE key='inventory')")),
        "open_documents_overpaid": q("SELECT COUNT(*) FROM documents WHERE amount_paid>total"),
        "unallocated_bank_lines": q("SELECT COUNT(*) FROM bank_feed_lines WHERE entry_id IS NULL"),
        "open_pos_orders": q("SELECT COUNT(*) FROM pos_orders WHERE status='open'"),
    }
    counts = {t: q(f"SELECT COUNT(*) FROM {t}") for t in
              ("accounts", "contacts", "items", "documents", "payments", "journal_entries", "journal_lines",
               "employees", "payruns", "pos_sales", "users")}
    errors = [dict(at=r["at"], details=r["details"]) for r in
              db.execute("SELECT at, details FROM audit_log WHERE action='error' ORDER BY id DESC LIMIT 20")]
    recent = [dict(at=r["at"], action=r["action"]) for r in
              db.execute("SELECT at, action FROM audit_log WHERE action<>'error' ORDER BY id DESC LIMIT 30")]
    return {
        "product": "Riyeser Accounting", "publisher": "Riyeser Group", "version": __version__,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "edition": c["edition"], "pos_mode": c["pos_mode"], "gst_registered": bool(c["gst_registered"]),
        "fy_start_month": c["fy_start_month"], "lock_date": c["lock_date"],
        "company_file_size_kb": round(os.path.getsize(current_app.config["DATABASE"]) / 1024),
        "frozen_desktop_build": bool(getattr(sys, "frozen", False)),
        "python": platform.python_version(), "os": f"{platform.system()} {platform.release()}",
        "checks": checks, "record_counts": counts, "recent_errors": errors, "recent_actions": recent,
        "note": "No customer, supplier, employee or bank details are included.",
    }


@bp.route("/diagnostics")
def diagnostics_view():
    data = diagnostics(get_db())
    if request.args.get("download"):
        name = f"riyeser-diagnostics-{datetime.now():%Y%m%d-%H%M}.json"
        return Response(json.dumps(data, indent=2), mimetype="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})
    return render_template("help/diagnostics.html", d=data)
