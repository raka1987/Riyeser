"""Which product this copy of the app is.

Three separate apps are built from this one code base. All of them open the same company files:
  * Riyeser Accounting Basics (500 free invoices) -> APP_EDITION = "basic"
  * Riyeser Accounting Plus (licence)             -> APP_EDITION = "enterprise"
  * Riyeser POS (500 free sales)                  -> APP_EDITION = "pos"
packaging/build_desktop.py --edition basics|plus|pos writes riyeser/_built_edition.py into the build. Run from source
(or `pip install`) there is no built edition, so APP_EDITION is None: each company picks Basic or Plus under Setup
and the till is there too. RIYESER_APP_EDITION=basics|plus|pos overrides it (handy for testing). Switching app never
changes any data: Basics just doesn't show the Plus screens, and Accounting doesn't show the till.
"""
import os

DOWNLOADS = "https://github.com/raka1987/Riyeser/releases/latest/download"
SETUP_FILES = {"basic": "RiyeserAccountingBasics-Setup.exe", "enterprise": "RiyeserAccountingPlus-Setup.exe",
               "pos": "RiyeserPOS-Setup.exe"}
POS_PAGE = "https://riyeser.com/programs/pos.html"


def _norm(v):
    v = (v or "").strip().lower()
    return {"basic": "basic", "basics": "basic", "plus": "enterprise", "enterprise": "enterprise",
            "pos": "pos"}.get(v)


def app_product():
    """'basic', 'enterprise', 'pos' or None (run from source)."""
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


def is_accounting_app():
    """A built Accounting Basics or Plus: the till lives in Riyeser POS, not here."""
    return app_edition() is not None


def download_url(edition):
    return f"{DOWNLOADS}/{SETUP_FILES[edition]}"
