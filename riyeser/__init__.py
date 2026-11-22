import os
import traceback
from datetime import date

from flask import Flask, g, session, redirect, url_for, request, abort, flash, render_template

from . import db as dbmod
from .db import fmt_money, cents_str, get_db

__version__ = "1.3.0"


def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("RIYESER_SECRET", "dev-change-me"),
        DATABASE=os.environ.get("RIYESER_DB", os.path.join(app.instance_path, "company.db")),
    )
    if test_config:
        app.config.update(test_config)
    os.makedirs(app.instance_path, exist_ok=True)
    dbmod.init_app(app)

    app.jinja_env.filters["money"] = fmt_money
    app.jinja_env.filters["money0"] = lambda c: fmt_money(c, blank_zero=True)
    app.jinja_env.filters["cents"] = cents_str
    app.jinja_env.globals["today"] = lambda: date.today().isoformat()

    TYPE_LABELS = {"asset": "Asset", "liability": "Liability", "equity": "Equity", "income": "Income",
                   "cost_of_sales": "Cost of Sales", "expense": "Expense", "other_income": "Other Income",
                   "other_expense": "Other Expense"}
    app.jinja_env.globals["TYPE_LABELS"] = TYPE_LABELS

    @app.before_request
    def load_user():
        g.user = None
        g.company = None
        if not os.path.exists(app.config["DATABASE"]):
            if request.endpoint not in ("auth.setup_company", "static"):
                return redirect(url_for("auth.setup_company"))
            return
        uid = session.get("uid")
        db = get_db()
        if app.config.get("_migrated_db") != app.config["DATABASE"]:
            dbmod.migrate(db)
            app.config["_migrated_db"] = app.config["DATABASE"]
        if uid:
            g.user = db.execute("SELECT * FROM users WHERE id=? AND active=1", (uid,)).fetchone()
        g.company = db.execute("SELECT * FROM company WHERE id=1").fetchone()
        public = ("auth.login", "auth.setup_company", "auth.forgot", "static")
        if g.user is None and request.endpoint not in public:
            return redirect(url_for("auth.login", next=request.path))
        if g.user is not None and request.method == "POST" and g.user["role"] == "viewer" \
                and request.endpoint not in ("auth.logout", "auth.login", "auth.forgot"):
            abort(403)
        if g.user is not None:
            from .perms import check_request
            why = check_request(db)
            if why:
                flash(why, "error")
                back = request.referrer if request.method == "POST" and request.referrer else url_for("core.dashboard")
                return redirect(back)
        if g.user is not None and g.company["edition"] == "basic" and _enterprise_only(request.endpoint):
            flash("That's part of Riyeser Accounting Enterprise. An administrator can upgrade under "
                  "Setup → Company (your data stays as it is).", "error")
            return redirect(url_for("core.dashboard"))

    @app.context_processor
    def inject():
        from .licence import status as licence_status
        from . import perms
        return dict(user=g.get("user"), company=g.get("company"), licence=licence_status() if g.get("user") else None,
                    can=lambda area, need=1: perms.can(area, need), lv=lambda area: perms.level(area),
                    report_area=perms.report_area)

    @app.errorhandler(403)
    def forbidden(_e):
        flash("Your user doesn't have permission to do that. Ask an administrator.", "error")
        return redirect(request.referrer or url_for("core.dashboard"))

    from .views import auth, core, contacts, documents, banking, inventory, payroll, reports, pos, links, help
    app.register_blueprint(auth.bp)
    app.register_blueprint(core.bp)
    app.register_blueprint(contacts.bp)
    app.register_blueprint(documents.bp)
    app.register_blueprint(banking.bp)
    app.register_blueprint(inventory.bp)
    app.register_blueprint(payroll.bp)
    app.register_blueprint(reports.bp)
    app.register_blueprint(pos.bp)
    app.register_blueprint(links.bp)
    app.register_blueprint(help.bp)
    app.jinja_env.globals["help_section"] = help.section_for
    app.jinja_env.globals["riyeser_version"] = __version__

    @app.errorhandler(500)
    def server_error(e):
        """Record the error (for diagnostics / support) and show a friendly page."""
        err = getattr(e, "original_exception", e)
        try:
            db = get_db()
            db.rollback()
            db.execute("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)",
                       (g.user["id"] if g.get("user") else None, "error",
                        f"{request.method} {request.path}: {type(err).__name__}: {err}"[:500]))
            db.commit()
        except Exception:
            pass
        app.logger.error("".join(traceback.format_exception(err)))
        return render_template("help/error.html"), 500
    return app


ENTERPRISE_ONLY = {"core.journal_new", "core.journal_list", "core.budgets", "core.jobs", "core.reverse",
                   "banking.reconcile", "banking.feed", "banking.allocate", "banking.feed_delete",
                   "banking.transfer_money"}


def _enterprise_only(endpoint):
    return bool(endpoint) and (endpoint in ENTERPRISE_ONLY or endpoint.startswith("payroll."))


def admin_required():
    if not g.user or g.user["role"] != "admin":
        abort(403)
