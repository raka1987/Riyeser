import os
import traceback
from datetime import date

from flask import Flask, g, session, redirect, url_for, request, abort, flash, render_template

from . import db as dbmod
from .db import fmt_money, cents_str, get_db

__version__ = "2.9.1"


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
    from . import demo_mode
    if app.config.get("DEMO_MODE") is None:  # not decided by the caller: Riyeser Central's demo.json decides
        app.config["DEMO_MODE"] = demo_mode.demo_on()
    if app.config["DEMO_MODE"]:
        # Demo mode: a separate demo folder next to the real books, which are never opened.
        app.config["NORMAL_DATABASE"] = app.config["DATABASE"]
        app.config["DATABASE"] = demo_mode.demo_db(app.config["DATABASE"])
        demo_mode.ensure_company(app)

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
        if app.config["DEMO_MODE"]:
            if not demo_mode.demo_on():  # Central has left demo mode while this program was open
                if request.endpoint != "static":
                    return render_template("help/demo_ended.html"), 503
                return
            if not os.path.exists(app.config["DATABASE"]):  # the demo folder was moved aside: make a fresh one
                demo_mode.ensure_company(app)
            if request.endpoint in ("auth.setup_company", "companies.start_again", "companies.start_everything"):
                flash("This is the demo company. Leave demo mode from Riyeser Central.", "error")
                return redirect(url_for("core.dashboard"))
        if not os.path.exists(app.config["DATABASE"]):
            if request.endpoint not in ("auth.setup_company", "static"):
                return redirect(url_for("auth.setup_company"))
            return
        from . import companies as co
        g.db_path = None
        if session.get("co") and session.get("co") != co.MAIN:
            path = co.path_of(session["co"])
            if path and session["co"] in (session.get("access") or {}):
                g.db_path = path
            else:
                session.pop("co", None)
                session.pop("uid", None)
        uid = session.get("uid")
        db = get_db()
        migrated = app.config.setdefault("_migrated_dbs", set())
        here = g.db_path or app.config["DATABASE"]
        if here not in migrated:
            dbmod.migrate(db)
            migrated.add(here)
        if uid:
            g.user = db.execute("SELECT * FROM users WHERE id=? AND active=1", (uid,)).fetchone()
        g.company = db.execute("SELECT * FROM company WHERE id=1").fetchone()
        if g.company is not None:
            from .licence import enterprise_allowed
            from .edition import app_edition
            g.company = dict(g.company)
            g.company["chosen_edition"] = g.company["edition"]
            g.company["enterprise_allowed"] = enterprise_allowed()
            g.company["plus_locked"] = False
            app_ed = app_edition()
            if app_ed:
                # The separate Basics / Plus apps: the app decides, not the company file (so the same books open in
                # either one, and nothing is lost going up or down).
                g.company["edition"] = app_ed
                g.company["plus_locked"] = app_ed == "enterprise" and not g.company["enterprise_allowed"]
            elif not g.company["enterprise_allowed"]:
                g.company["edition"] = "basic"  # after the trial: Enterprise needs a licence (data is kept)
        if g.user is None and app.config["DEMO_MODE"] and g.company and g.company.get("is_demo") \
                and not g.db_path and not session.get("demo_signed_out") and request.endpoint != "auth.logout":
            # Demo mode signs you in as demo straight away: only in the demo folder, only on the demo company.
            u = db.execute("SELECT * FROM users WHERE username=? AND active=1 AND role='admin'",
                           (demo_mode.DEMO_USER,)).fetchone()
            if u:
                session["access"] = {co.MAIN: u["id"]}
                session["co"] = co.MAIN
                session["uid"] = u["id"]
                g.user = u
        public = ("auth.login", "auth.setup_company", "auth.forgot", "static")
        if g.user is None and request.endpoint not in public:
            return redirect(url_for("auth.login", next=request.path))
        if g.user is not None and request.method == "POST" and g.user["role"] == "viewer" \
                and request.endpoint not in ("auth.logout", "auth.login", "auth.forgot"):
            abort(403)
        if g.user is not None:
            g.over_allowance = not co.within_allowance(co.current_id())
            from .perms import check_request
            why = check_request(db)
            if why:
                flash(why, "error")
                back = request.referrer if request.method == "POST" and request.referrer else url_for("core.dashboard")
                return redirect(back)
        if g.user is not None:
            sep = _separate_app_redirect(request.endpoint or "")
            if sep:
                return sep
        if g.user is not None and _enterprise_only(request.endpoint):
            ent, basic = dbmod.EDITIONS["enterprise"]["title"], dbmod.EDITIONS["basic"]["title"]
            from .edition import app_edition
            if g.company["plus_locked"]:
                flash(f"Your free trial has ended, so this {ent} screen needs a licence. Enter one in Riyeser Central "
                      f"(Licence). Nothing has been removed. Or switch to the free {basic} under Setup.", "error")
                return redirect(url_for("core.dashboard"))
            if g.company["edition"] == "basic":
                if app_edition() == "basic":
                    return redirect(url_for("core.upgrade"))
                if g.company["enterprise_allowed"]:
                    flash(f"That's part of {ent}. An administrator can switch to {ent} under "
                          "Setup → Company (your data stays as it is).", "error")
                else:
                    flash(f"That's part of {ent}, which needs a licence after the 90-day free trial. "
                          f"Enter a licence in Riyeser Central to unlock {ent} (your data stays as it is).", "error")
                return redirect(url_for("core.dashboard"))

    @app.context_processor
    def inject():
        from .licence import status as licence_status
        from . import perms
        from . import companies as co
        acc = session.get("access") or {}
        mine = [c for c in co.all_companies() if c["id"] in acc] if g.get("user") else []
        from .edition import app_edition, is_pos_app, is_accounting_app, is_invoices_app, is_bookings_app
        if is_bookings_app():
            product = {"key": "bookings", "app": dbmod.BOOKINGS_APP["app"], "title": dbmod.BOOKINGS_APP["title"],
                       "letter": "Bk", "cls": "ed-book", "separate": True}
        elif is_pos_app():
            product = {"key": "pos", "app": dbmod.POS_APP["app"], "title": dbmod.POS_APP["title"], "letter": "Po",
                       "cls": "ed-pos", "separate": True}
        elif is_invoices_app():
            product = {"key": "invoices", "app": dbmod.INVOICES_APP["app"], "title": dbmod.INVOICES_APP["title"],
                       "letter": "In", "cls": "ed-inv", "separate": True}
        else:
            ed = app_edition() or ((g.get("company") or {}).get("edition"))
            product = {"key": ed, "app": dbmod.EDITIONS[ed]["app"] if ed else "Riyeser Accounting",
                       "title": dbmod.EDITIONS[ed]["title"] if ed else "Riyeser Accounting",
                       "letter": {"basic": "B", "enterprise": "P"}.get(ed, "R"),
                       "cls": {"basic": "ed-basic", "enterprise": "ed-plus"}.get(ed, ""), "separate": bool(app_edition())}
        product["pos_separate"] = is_accounting_app() or is_invoices_app() or is_bookings_app()
        product["bookings_separate"] = is_accounting_app() or is_invoices_app() or is_pos_app()  # Accounting builds: the till is in Riyeser POS
        return dict(product=product, user=g.get("user"), company=g.get("company"), licence=licence_status() if g.get("user") else None,
                    my_companies=mine, current_company=co.current_id() if g.get("user") else None,
                    over_allowance=g.get("over_allowance"), company_allowance=co.allowance() if g.get("user") else None,
                    can=lambda area, need=1: perms.can(area, need), lv=lambda area: perms.level(area),
                    report_area=perms.report_area, prices=dbmod.PRICES)

    @app.errorhandler(403)
    def forbidden(_e):
        if request.endpoint in ("companies.start_again", "companies.start_everything", "companies.check_archives"):
            return render_template("companies/refused.html"), 403
        flash("Your user doesn't have permission to do that. Ask an administrator.", "error")
        return redirect(request.referrer or url_for("core.dashboard"))

    from .views import auth, core, contacts, documents, banking, inventory, payroll, reports, pos, links, help, companies
    from .views import bookings
    app.register_blueprint(auth.bp)
    app.register_blueprint(companies.bp)
    app.register_blueprint(core.bp)
    app.register_blueprint(contacts.bp)
    app.register_blueprint(documents.bp)
    app.register_blueprint(banking.bp)
    app.register_blueprint(inventory.bp)
    app.register_blueprint(payroll.bp)
    app.register_blueprint(reports.bp)
    app.register_blueprint(pos.bp)
    app.register_blueprint(bookings.bp)
    app.register_blueprint(links.bp)
    app.register_blueprint(help.bp)
    app.jinja_env.globals["help_section"] = help.section_for
    app.jinja_env.globals["riyeser_version"] = __version__
    app.jinja_env.globals["central_demo"] = bool(app.config["DEMO_MODE"])
    app.jinja_env.globals["demo_login"] = (demo_mode.DEMO_USER, demo_mode.DEMO_PASSWORD)
    app.jinja_env.globals["editions"] = dbmod.EDITIONS

    def free_plan(product):
        """For banners and pills: how much of a free allowance is left (None when it doesn't apply here)."""
        from . import plan as P
        from .views.documents import free_invoices_apply
        if product == "basic" and not free_invoices_apply():
            return None
        try:
            return P.plan(get_db(), product)
        except Exception:
            return None
    app.jinja_env.globals["free_plan"] = free_plan
    from .edition import app_edition, download_url
    app.jinja_env.globals["app_edition"] = app_edition
    app.jinja_env.globals["edition_download"] = download_url

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


# Riyeser POS is the till plus what a shop needs to run it: products and stock, customers, users, help.
# Everything else is Riyeser Accounting's, so POS sends people back to the till.
POS_APP_AREAS = ("pos.", "inventory.", "contacts.", "companies.", "help.", "auth.")


def _separate_app_redirect(endpoint):
    """Keep each app to its own screens. Riyeser POS shows only the till (and products, customers, users, help);
    Accounting Basics and Plus send the till's screens to Riyeser POS. Both open the same company file."""
    from .edition import is_pos_app, is_accounting_app, is_invoices_app, is_bookings_app
    if is_bookings_app():
        return _bookings_app_redirect(endpoint)
    if is_invoices_app():
        if endpoint.startswith("bookings."):
            return redirect(url_for("core.bookings_app"))
        return _invoices_app_redirect(endpoint)
    if is_pos_app():
        if endpoint == "core.dashboard":
            return redirect(url_for("pos.register"))
        if endpoint.startswith("bookings."):
            return redirect(url_for("core.bookings_app"))
        if endpoint.startswith(POS_APP_AREAS) or endpoint in ("static", "core.bookings_app"):
            return None
        flash("That's part of Riyeser Accounting. Open it in Riyeser Accounting: it uses the same company file.",
              "error")
        return redirect(url_for("pos.register"))
    if endpoint.startswith("bookings.") and (is_accounting_app() or is_pos_app()):
        return redirect(url_for("core.bookings_app"))
    if is_accounting_app() and endpoint.startswith("pos.") and endpoint != "pos.photo":
        return redirect(url_for("links.pos_app"))
    return None


# Riyeser Invoices (free): quotes, invoices, customers, receiving payments and who owes you. Everything else is
# Riyeser Accounting's, and opens there with the same company file.
INVOICES_APP_ENDPOINTS = ("companies.", "help.", "auth.")
INVOICES_APP_EXACT = {"static", "core.company", "core.invoices_upgrade", "core.bookings_app", "documents.save_pdf"}


def _invoices_app_redirect(endpoint):
    from . import perms
    home = url_for("documents.index", side="sale")
    if endpoint == "core.dashboard":
        return redirect(home)
    if endpoint in INVOICES_APP_EXACT or endpoint.startswith(INVOICES_APP_ENDPOINTS):
        return None
    if endpoint == "reports.show" and (request.view_args or {}).get("name") == "aged_receivables":
        return None
    if endpoint.startswith(("documents.", "contacts.")):
        try:
            area = perms.area_of(endpoint, request.view_args, request.args, get_db())
        except Exception:
            area = None
        if area == "sales":
            return None
    flash("That's part of Riyeser Accounting Basics. It opens the same company file, so everything you've made here "
          "is already in it.", "error")
    return redirect(url_for("core.invoices_upgrade"))

# Riyeser Bookings: the calendar, customers, and the invoices it makes (so they can be checked and sent from here).
def _bookings_app_redirect(endpoint):
    from . import perms
    home = url_for("bookings.calendar")
    if endpoint == "core.dashboard":
        return redirect(home)
    if endpoint.startswith(("bookings.", "companies.", "help.", "auth.")) or endpoint in ("static", "core.company"):
        return None
    if endpoint.startswith(("documents.", "contacts.")):
        try:
            area = perms.area_of(endpoint, request.view_args, request.args, get_db())
        except Exception:
            area = None
        if area == "sales":
            return None
    flash("That's part of Riyeser Accounting. It opens the same company file, so your bookings' invoices are already "
          "there.", "error")
    return redirect(home)

ENTERPRISE_ONLY = {"core.journal_new", "core.journal_list", "core.budgets", "core.jobs", "core.reverse",
                   "banking.reconcile", "banking.feed", "banking.allocate", "banking.feed_delete",
                   "banking.transfer_money"}


def _enterprise_only(endpoint):
    return bool(endpoint) and (endpoint in ENTERPRISE_ONLY or endpoint.startswith("payroll."))


def admin_required():
    if not g.user or g.user["role"] != "admin":
        abort(403)
