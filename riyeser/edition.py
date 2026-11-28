"""Which product this copy of the app is.

Six separate apps are built from this one code base. All of them open the same company files:
  * Riyeser Invoices (free forever)                 -> APP_EDITION = "invoices"
  * Riyeser Bookings (90 days free, then US$25 a month)-> APP_EDITION = "bookings"
  * Riyeser Accounting Basics (US$25 a month)    -> APP_EDITION = "basic"
  * Riyeser Accounting Plus (US$39 a month)       -> APP_EDITION = "enterprise"
  * Riyeser POS (90 days free, then US$29 a month)-> APP_EDITION = "pos"
  * Riyeser Estimate (90 days free from first use, then US$20 a month) -> APP_EDITION = "estimate":
    measure a job (by hand, on a plan or photo, on the map) and turn it into a quote (riyeser/measure/)
packaging/build_desktop.py --edition basics|plus|pos|invoices|bookings|estimate writes riyeser/_built_edition.py into the build. Run from source
(or `pip install`) there is no built edition, so APP_EDITION is None: each company picks Basic or Plus under Setup
and the till is there too. RIYESER_APP_EDITION=basics|plus|pos|invoices|bookings|estimate overrides it (handy for testing). Switching app never
changes any data: Basics just doesn't show the Plus screens, and Accounting doesn't show the till.
"""
import os

# Releases are published in the public downloads repository (docs/GOING-PRIVATE.md): change its name here only.
DOWNLOADS_REPO = "raka1987/riyeser-downloads"
SETUP_FILES = {"basic": "RiyeserAccountingBasics-Setup.exe", "enterprise": "RiyeserAccountingPlus-Setup.exe",
               "pos": "RiyeserPOS-Setup.exe", "invoices": "RiyeserInvoices-Setup.exe",
               "bookings": "RiyeserBookings-Setup.exe", "estimate": "RiyeserEstimate-Setup.exe"}
# The in-app "Download" buttons send people to riyeser.com's download hand-off page (the download counter), which
# redirects to the newest installer. Going through riyeser.com means the app never shows a github.com link, and the
# download is counted. The page ids match the website (website/build.mjs). The code repository can stay private.
SITE = "https://riyeser.com"
DOWNLOAD_PAGE = {"basic": "accounting-basics", "enterprise": "accounting", "pos": "pos",
                 "invoices": "invoices", "bookings": "bookings", "estimate": "estimate"}
POS_PAGE = f"{SITE}/programs/pos.html"


def _norm(v):
    v = (v or "").strip().lower()
    return {"basic": "basic", "basics": "basic", "plus": "enterprise", "enterprise": "enterprise",
            "pos": "pos", "invoices": "invoices", "invoice": "invoices",
            "bookings": "bookings", "booking": "bookings", "estimate": "estimate", "estimates": "estimate"}.get(v)


def app_product():
    """'basic', 'enterprise', 'pos', 'invoices', 'bookings', 'estimate' or None (run from source)."""
    env = _norm(os.environ.get("RIYESER_APP_EDITION"))
    if env:
        return env
    try:
        from ._built_edition import APP_EDITION
        return _norm(APP_EDITION)
    except ImportError:
        return None


def app_edition():
    """The Accounting edition this app is: 'basic', 'enterprise', or None (run from source, or Riyeser POS)."""
    p = app_product()
    return p if p in ("basic", "enterprise") else None


def is_pos_app():
    return app_product() == "pos"


def is_bookings_app():
    """Riyeser Bookings: jobs, appointments and table bookings."""
    return app_product() == "bookings"


def is_invoices_app():
    """Riyeser Invoices: the free app for quotes, invoices, customers and getting paid."""
    return app_product() == "invoices"


def is_estimate_app():
    """Riyeser Estimate: measure jobs and turn them into quotes (Measure & Quote)."""
    return app_product() == "estimate"


def is_accounting_app():
    """A built Accounting Basics or Plus: the till lives in Riyeser POS, not here."""
    return app_edition() is not None


def download_url(edition):
    """The riyeser.com download hand-off page for a program (counts the download, then redirects to the newest
    installer). Going through riyeser.com keeps github.com out of the app's own buttons."""
    return f"{SITE}/download/{DOWNLOAD_PAGE[edition]}.html"
