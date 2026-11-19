import os
from datetime import date

from flask import Flask, g, session, redirect, url_for, request, abort, flash

from . import db as dbmod
from .db import fmt_money, cents_str, get_db


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
        if uid:
            g.user = db.execute("SELECT * FROM users WHERE id=? AND active=1", (uid,)).fetchone()
        g.company = db.execute("SELECT * FROM company WHERE id=1").fetchone()
        public = ("auth.login", "auth.setup_company", "static")
        if g.user is None and request.endpoint not in public:
            return redirect(url_for("auth.login", next=request.path))
        if g.user is not None and request.method == "POST" and g.user["role"] == "viewer" \
                and request.endpoint not in ("auth.logout", "auth.login"):
            abort(403)

    @app.context_processor
    def inject():
        return dict(user=g.get("user"), company=g.get("company"))

    @app.errorhandler(403)
    def forbidden(_e):
        flash("You do not have permission to do that (read-only role).", "error")
        return redirect(request.referrer or url_for("core.dashboard"))

    from .views import auth, core, contacts, documents, banking, inventory, payroll, reports
    app.register_blueprint(auth.bp)
    app.register_blueprint(core.bp)
    app.register_blueprint(contacts.bp)
    app.register_blueprint(documents.bp)
    app.register_blueprint(banking.bp)
    app.register_blueprint(inventory.bp)
    app.register_blueprint(payroll.bp)
    app.register_blueprint(reports.bp)
    return app


def admin_required():
    if not g.user or g.user["role"] != "admin":
        abort(403)
