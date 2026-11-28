import os
import traceback
from datetime import date

from flask import Flask, g, session, redirect, url_for, request, abort, flash, render_template

from . import db as dbmod
from .db import fmt_money, cents_str, get_db

__version__ = "2.11.1"


def create_app(test_config=None):
    import mimetypes
    mimetypes.add_type("text/javascript", ".mjs")   # pdf.js (Riyeser Estimate's plans) is an ES module; Windows may not know .mjs
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

    from . import countries as _countries
    app.jinja_env.filters["money"] = _countries.request_money   # the company's currency (S30, APP-023)
    app.jinja_env.filters["money0"] = lambda c: _countries.request_money(c, blank_zero=True)
    app.jinja_env.filters["ddate"] = _countries.request_date     # a date in the company's date format
    app.jinja_env.filters["cents"] = cents_str
    app.jinja_env.globals["money_js"] = _countries.request_money_js   # the same format in screens' scripts
    app.jinja_env.filters["money_whole"] = lambda c: _countries.format_money(c, dict(_countries.request_money_format(), decimals=0))
    app.jinja_env.globals["money_symbol"] = lambda: _countries.request_money_format()["symbol"]
    app.jinja_env.globals["today"] = lambda: date.today().isoformat()

    TYPE_LABELS = {"asset": "Asset", "liability": "Liability", "equity": "Equity", "income": "Income",
                   "cost_of_sales": "Cost of Sales", "expense": "Expense", "other_income": "Other Income",
                   "other_expense": "Other Expense"}
    app.jinja_env.globals["TYPE_LABELS"] = TYPE_LABELS
    from .payroll_calc import NOT_FOR_REAL_PAY
    app.jinja_env.globals["payroll_warning"] = NOT_FOR_REAL_PAY  # F12

    @app.before_request
    def load_user():
        g.user = None
        g.company = None
        if (request.endpoint or "").startswith("online_api."):  # Riyeser Central's local API: its own check
            from .views.online import api_guard
            return api_guard()
        if (request.endpoint or "").startswith("kds.") and os.path.exists(app.config["DATABASE"]):
            from .views.kds import kds_guard   # the kitchen screen: a paired device, or a signed-in user (below)
            if kds_guard(app) is None:
                return None
            if not session.get("uid"):  # not paired and not signed in: pair this screen
                return redirect(url_for("kds.pair"))
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
            if request.endpoint not in ("auth.setup_company", "static", "backups.restore_upload", "backups.restore"):
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
            marks = session.get("pwv")
            if g.user is not None and isinstance(marks, dict):
                from .views.auth import pw_mark
                here_id, mark = session.get("co") or co.MAIN, pw_mark(g.user["password_hash"])
                if marks.get(here_id, mark) != mark:  # the password was changed or reset since: sign in again
                    session.clear()
                    g.user = None
                elif here_id not in marks:
                    session["pwv"] = {**marks, here_id: mark}
        g.company = db.execute("SELECT * FROM company WHERE id=1").fetchone()
        stamped = app.config.setdefault("_trial_stamped_dbs", set())
        if g.company is not None and here not in stamped:
            # The free trial's stamp in this company file (riyeser/trial_guard.py): an older one (a restored file) is passed
            # on to this PC, and the trial's start is stamped in. Once per company file per run; never for demo companies.
            stamped.add(here)
            try:
                from .trial_guard import sync_company
                from .licence import licence_file
                sync_company(db, os.path.dirname(licence_file()),
                             demo=bool(g.company["is_demo"]) or bool(app.config.get("DEMO_MODE")) or demo_mode.demo_on())
            except Exception:  # pragma: no cover - the trial's other places still count
                pass
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
                from .views.auth import pw_mark
                session["pwv"] = {co.MAIN: pw_mark(u["password_hash"])}
                g.user = u
        public = ("auth.login", "auth.setup_company", "static", "auth.forgot", "auth.forgot_email", "auth.forgot_email_reset", "auth.forgot_owner", "auth.forgot_owner_code", "auth.forgot_owner_reset")
        if g.user is None and request.endpoint not in public:
            return redirect(url_for("auth.login", next=request.path))
        if g.user is not None and request.method == "POST" and g.user["role"] == "viewer" \
                and request.endpoint not in ("auth.logout", "auth.login", "auth.forgot", "auth.forgot_email", "auth.forgot_email_reset", "auth.forgot_owner", "auth.forgot_owner_code", "auth.forgot_owner_reset"):
            abort(403)
        if g.user is not None:
            from .views.backups import auto_backup, send_due_email
            auto_backup(app)  # once a day per company (S38)
            send_due_email(app)  # booking reminders when they're due (S51)
            g.over_allowance = not co.within_allowance(co.current_id())
            if (request.endpoint or "").startswith("pos."):   # who's selling at the till (Till PINs, POS 2.11.1)
                from .views.pos_cashier import till_user
                stop = till_user(db)
                if stop is not None:
                    return stop
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
                from .plan import PRICES
                flash(f"Your free trial has ended, so this {ent} screen is locked. Nothing has been removed: it's kept "
                      f"safe, and invoices, customers, stock and reports still work. To unlock it, add {ent} from your "
                      f"Riyeser home page ({PRICES['plus']}), or switch to the free {basic} under Setup.", "error")
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
        from .edition import app_edition, is_pos_app, is_accounting_app, is_invoices_app, is_bookings_app, is_estimate_app
        if is_estimate_app():
            product = {"key": "estimate", "app": dbmod.ESTIMATE_APP["app"], "title": dbmod.ESTIMATE_APP["title"],
                       "letter": "Es", "cls": "ed-est", "separate": True}
        elif is_bookings_app():
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
        product["pos_separate"] = is_accounting_app() or is_invoices_app() or is_bookings_app() or is_estimate_app()
        product["bookings_separate"] = is_accounting_app() or is_invoices_app() or is_pos_app() or is_estimate_app()  # Accounting builds: the till is in Riyeser POS
        product["estimate_separate"] = app_edition() is not None or is_invoices_app() or is_bookings_app() or is_pos_app()
        return dict(product=product, user=g.get("user"), company=g.get("company"), licence=licence_status() if g.get("user") else None,
                    my_companies=mine, current_company=co.current_id() if g.get("user") else None,
                    over_allowance=g.get("over_allowance"), company_allowance=co.allowance() if g.get("user") else None,
                    can=lambda area, need=1: perms.can(area, need), lv=lambda area: perms.level(area),
                    report_area=perms.report_area, prices=dbmod.PRICES, tl=_countries.request_labels(),
                    bank_labels=_countries.request_bank())

    @app.errorhandler(403)
    def forbidden(_e):
        if request.endpoint in ("companies.start_again", "companies.start_everything", "companies.check_archives"):
            return render_template("companies/refused.html"), 403
        flash("Your user doesn't have permission to do that. Ask an administrator.", "error")
        return redirect(request.referrer or url_for("core.dashboard"))

    from .views import auth, core, contacts, documents, banking, inventory, payroll, reports, pos, links, help, companies
    from .views import bookings, backups, email, expenses, online, estimate
    app.register_blueprint(online.bp)
    app.register_blueprint(online.api)
    app.register_blueprint(estimate.bp)
    estimate.register_filters(app)
    app.register_blueprint(expenses.bp)
    app.register_blueprint(auth.bp)
    app.register_blueprint(backups.bp)
    app.register_blueprint(email.bp)
    app.register_blueprint(companies.bp)
    app.register_blueprint(core.bp)
    app.register_blueprint(contacts.bp)
    app.register_blueprint(documents.bp)
    app.register_blueprint(banking.bp)
    app.register_blueprint(inventory.bp)
    app.register_blueprint(payroll.bp)
    app.register_blueprint(reports.bp)
    app.register_blueprint(pos.bp)
    from .views import kds
    app.register_blueprint(kds.bp)
    app.register_blueprint(bookings.bp)
    app.register_blueprint(links.bp)
    app.register_blueprint(help.bp)
    from .views import branding as branding_view
    app.register_blueprint(branding_view.bp)
    app.jinja_env.globals["help_section"] = help.section_for
    app.jinja_env.globals["riyeser_version"] = __version__
    from .branding import request_brand
    app.jinja_env.globals["business_brand"] = request_brand   # the business's logo and details on documents
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

    def locked_notice(product):
        """For the "trial ended" banners: what's locked, what still works, the price and the Riyeser home button."""
        from . import plan as P
        try:
            return P.locked_notice(product)
        except Exception:
            return None
    app.jinja_env.globals["locked_notice"] = locked_notice
    from .edition import app_edition, download_url
    app.jinja_env.globals["app_edition"] = app_edition
    app.jinja_env.globals["edition_download"] = download_url

    @app.errorhandler(500)
    def server_error(e):
        """Record the error (for diagnostics / support) and show a friendly page with a reference. It goes in the
        company file's audit log (Support Diagnostics → Recent errors) and, with where in the code it happened, in
        riyeser-errors.log next to the company file (a desktop build has no console to print it to)."""
        import secrets
        err = getattr(e, "original_exception", e)
        ref = "ER-" + secrets.token_hex(3).upper()
        try:
            db = get_db()
            db.rollback()
            db.execute("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)",
                       (g.user["id"] if g.get("user") else None, "error",
                        f"{ref} {request.method} {request.path}: {type(err).__name__}: {err}"[:500]))
            db.commit()
        except Exception:
            pass
        text = "".join(traceback.format_exception(type(err), err, err.__traceback__))
        app.logger.error(text)
        write_error_log(app, ref, f"{request.method} {request.path}", err, text)
        return render_template("help/error.html", ref=ref), 500
    return app


def error_log_file(app):
    """riyeser-errors.log in the company file's folder (%USERPROFILE%\\.riyeser on Windows unless moved)."""
    return os.path.join(os.path.dirname(os.path.abspath(app.config["DATABASE"])), "riyeser-errors.log")


def write_error_log(app, ref, where, err, text):
    """One entry per error page: when, the reference shown on the page, the program and version, and the last lines
    of the traceback (file names and line numbers only: no customer details). Kept under 512 KB (one old copy)."""
    from datetime import datetime
    import platform
    import sys
    try:
        f = error_log_file(app)
        if os.path.exists(f) and os.path.getsize(f) > 512 * 1024:
            os.replace(f, f + ".1")
        from .edition import app_product
        tail = "\n".join(text.rstrip().splitlines()[-14:])
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {ref} {app_product() or 'source'} {__version__} "
                     f"({platform.system()} {platform.release()}, Python {platform.python_version()}, "
                     f"optimize={sys.flags.optimize}) {where}: {type(err).__name__}: {str(err)[:300]}\n{tail}\n\n")
    except Exception:
        pass   # the page must still show


# Riyeser POS is the till plus what a shop needs to run it: products and stock, customers, users, help.
# Everything else is Riyeser Accounting's, so POS sends people back to the till.
POS_APP_AREAS = ("pos.", "inventory.", "contacts.", "companies.", "help.", "auth.", "backups.", "email.", "kds.")


def _separate_app_redirect(endpoint):
    """Keep each app to its own screens. Riyeser POS shows only the till (and products, customers, users, help);
    Accounting Basics and Plus send the till's screens to Riyeser POS. Both open the same company file."""
    from .edition import is_pos_app, is_accounting_app, is_invoices_app, is_bookings_app, is_estimate_app
    if endpoint in ("core.country", "core.country_review") or endpoint.startswith("branding."):
        return None   # every app sets the business's country and tax, and its details & branding (the same file)
    if is_estimate_app():
        return _estimate_app_redirect(endpoint)
    if endpoint.startswith("estimate.") and \
            (is_bookings_app() or is_invoices_app() or is_pos_app() or is_accounting_app()):
        return redirect(url_for("core.estimate_app"))
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
        if endpoint.startswith(POS_APP_AREAS + ("online.",)) or endpoint in ("static", "core.bookings_app", "core.today", "core.estimate_app"):
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
INVOICES_APP_ENDPOINTS = ("companies.", "help.", "auth.", "backups.", "email.", "online.")
INVOICES_APP_EXACT = {"static", "core.company", "core.invoices_upgrade", "core.bookings_app", "documents.save_pdf",
                      "core.dashboard", "core.today", "core.estimate_app"}   # Today is the home screen


def _invoices_app_redirect(endpoint):
    from . import perms
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
    if endpoint.startswith(("bookings.", "companies.", "help.", "auth.", "backups.", "email.", "online.")) or \
            endpoint in ("static", "core.company", "core.dashboard", "core.today", "core.estimate_app"):   # Today is the home screen
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

# Riyeser Estimate: estimates (measure -> template -> price -> send), its templates and settings, customers, and the
# quotes it makes (to check, send, print and mark accepted). Invoicing them happens in Invoices, Bookings or Accounting,
# which open the same company file.
ESTIMATE_QUOTE_ENDPOINTS = {"documents.view", "documents.email", "documents.save_pdf", "documents.quote_accept",
                            "documents.quote_decline", "documents.quote_undo", "documents.delete"}


def _estimate_app_redirect(endpoint):
    from . import perms
    if endpoint.startswith(("estimate.", "companies.", "help.", "auth.", "backups.", "email.")) or \
            endpoint in ("static", "core.bookings_app", "core.invoices_upgrade"):
        return None
    if endpoint in ("core.dashboard", "core.today"):
        return redirect(url_for("estimate.index"))   # the Estimates list is the home screen
    if endpoint == "core.company":
        return redirect(url_for("estimate.settings"))
    if endpoint in ESTIMATE_QUOTE_ENDPOINTS:
        return None
    if endpoint.startswith("contacts."):
        try:
            area = perms.area_of(endpoint, request.view_args, request.args, get_db())
        except Exception:
            area = None
        if area == "sales":
            return None
    if endpoint == "documents.edit" and (request.args.get("status") == "quote" or request.view_args.get("doc_id")):
        doc_id = (request.view_args or {}).get("doc_id")
        if not doc_id or (get_db().execute("SELECT status FROM documents WHERE id=?", (doc_id,)).fetchone() or {"status": ""})["status"] == "quote":
            if request.method == "GET" or request.form.get("status") == "quote":
                return None
    flash("Invoices and jobs are made in Riyeser Invoices, Riyeser Bookings or Riyeser Accounting. They open the same "
          "company file, so the quotes you make here are already there.", "error")
    return redirect(url_for("estimate.index"))


ENTERPRISE_ONLY = {"core.journal_new", "core.journal_list", "core.budgets", "core.jobs", "core.reverse",
                   "banking.reconcile", "banking.feed", "banking.allocate", "banking.feed_delete",
                   "banking.transfer_money"}


def _enterprise_only(endpoint):
    return bool(endpoint) and (endpoint in ENTERPRISE_ONLY or endpoint.startswith("payroll."))


def admin_required():
    if not g.user or g.user["role"] != "admin":
        abort(403)
