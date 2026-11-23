"""Which product this copy of the app is.

Riyeser Accounting ships as two separate apps built from this one code base:
  * Riyeser Accounting Basics (free)    -> APP_EDITION = "basic"
  * Riyeser Accounting Plus (licence)   -> APP_EDITION = "enterprise"
packaging/build_desktop.py --edition basic|plus writes riyeser/_built_edition.py into the build. Run from source
(or `pip install`) there is no built edition, so APP_EDITION is None and each company picks Basic or Plus under Setup.
RIYESER_APP_EDITION=basic|plus overrides it (handy for testing). Both apps open the same company files, so switching
app never changes any data: Basics just doesn't show the Plus screens.
"""
import os

DOWNLOADS = "https://github.com/raka1987/Riyeser/releases/latest/download"
SETUP_FILES = {"basic": "RiyeserAccountingBasics-Setup.exe", "enterprise": "RiyeserAccountingPlus-Setup.exe"}


def _norm(v):
    v = (v or "").strip().lower()
    return {"basic": "basic", "basics": "basic", "plus": "enterprise", "enterprise": "enterprise"}.get(v)


def app_edition():
    env = _norm(os.environ.get("RIYESER_APP_EDITION"))
    if env:
        return env
    try:
        from ._built_edition import APP_EDITION
        return _norm(APP_EDITION)
    except ImportError:
        return None


def download_url(edition):
    return f"{DOWNLOADS}/{SETUP_FILES[edition]}"
