"""Build a Riyeser Accounting desktop app for the current OS.

    pip install . pyinstaller
    python packaging/build_desktop.py --edition basics   # Riyeser Accounting Basics (90 days free)
    python packaging/build_desktop.py --edition plus     # Riyeser Accounting Plus (licence)
    python packaging/build_desktop.py --edition pos      # Riyeser POS (90 days free, then a licence)
    python packaging/build_desktop.py --edition invoices # Riyeser Invoices (free forever)
    python packaging/build_desktop.py --edition bookings # Riyeser Bookings (90 days free, then a licence)
    python packaging/build_desktop.py --edition estimate # Riyeser Estimate (90 days free from first use)

Six separate apps from one code base: the edition is baked into the build (riyeser/_built_edition.py), with its own
name, icon and colours. Output: dist/Riyeser Accounting Basics.exe / dist/Riyeser Accounting Plus.exe (Windows),
dist/Riyeser POS.exe, .app bundles on macOS, riyeser-accounting-basics / -plus / riyeser-pos on Linux.
"""
import argparse
import os
import platform
import sys
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "riyeser"
sep = os.pathsep
system = platform.system()

ap = argparse.ArgumentParser()
ap.add_argument("--edition", choices=["basics", "plus", "pos", "invoices", "bookings", "estimate"], required=True)
EDITION = ap.parse_args().edition
APP_NAME = {"basics": "Riyeser Accounting Basics", "plus": "Riyeser Accounting Plus", "pos": "Riyeser POS",
            "invoices": "Riyeser Invoices", "bookings": "Riyeser Bookings", "estimate": "Riyeser Estimate"}[EDITION]
ICON = ROOT / "packaging" / f"{EDITION}.ico"
built = PKG / "_built_edition.py"
built.write_text(f'APP_EDITION = "{EDITION}"\n', encoding="utf-8")
# The licence public key (Ed25519), so the app only trusts licences Riyeser signed (riyeser/signed_licence.py).
# The release workflow fetches it from the licence function's /public-key. Without it (licence signing not switched on
# yet) the app accepts unsigned licences, as before. It's a public key: nothing secret goes into the build.
key_file = PKG / "_licence_key.py"
LICENCE_KEY = os.environ.get("RIYESER_LICENCE_PUBLIC_KEY", "").strip()
if LICENCE_KEY:
    import base64
    if len(base64.b64decode(LICENCE_KEY, validate=True)) != 32:
        sys.exit("RIYESER_LICENCE_PUBLIC_KEY isn't an Ed25519 public key (32 bytes, base64).")
    key_file.write_text(f'PUBLIC_KEY = "{LICENCE_KEY}"\n', encoding="utf-8")
    print("Licence public key built in:", LICENCE_KEY)
else:
    key_file.unlink(missing_ok=True)
    print("No licence public key: this build accepts unsigned licences (licence signing not switched on yet).")

# Riyeser Estimate's map: Riyeser's ArcGIS Location Platform API key (imagery tiles and address search), from the
# RIYESER_ESRI_KEY secret. It's used in the browser, so it's not secret from the user: restrict it in the ArcGIS
# dashboard to the basemap and geocoding (not stored) privileges, with pay-as-you-go off as a cost ceiling.
map_key_file = PKG / "_map_key.py"
ESRI_KEY = os.environ.get("RIYESER_ESRI_KEY", "").strip()
if ESRI_KEY:
    map_key_file.write_text(f'ESRI_KEY = "{ESRI_KEY}"\n', encoding="utf-8")
else:
    map_key_file.unlink(missing_ok=True)

args = [
    str(ROOT / "packaging" / "riyeser_desktop.py"),
    "--noconfirm", "--clean",
    # Build at optimisation level 2 (same as python -OO): the bundled modules are compiled to .pyc with docstrings
    # and asserts stripped, so the app carries no readable source or developer notes once the code repository goes
    # private. PyInstaller only ever bundles bytecode (.pyc) in its archive, never the .py sources (checked: nothing
    # in riyeser/ relies on asserts, docstrings or __debug__ at runtime, so stripping them is safe). PyInstaller 6+.
    "--optimize", "2",
    # Tests and docs live outside the riyeser package (top-level tests/ and docs/), so they are never collected; this
    # keeps it so even if a test module is ever added next to the code.
    "--exclude-module", "tests",
    "--exclude-module", "pytest",
    "--name", APP_NAME.lower().replace(" ", "-") if system == "Linux" else APP_NAME,
    "--paths", str(ROOT),
    "--add-data", f"{PKG / 'templates'}{sep}riyeser/templates",
    "--add-data", f"{PKG / 'static'}{sep}riyeser/static",
    "--add-data", f"{PKG / 'schema.sql'}{sep}riyeser",
    "--add-data", f"{PKG / 'countries.json'}{sep}riyeser",   # Country and tax presets (riyeser/countries.py)
    "--add-data", f"{PKG / 'fonts'}{sep}riyeser/fonts",   # the Unicode fonts embedded in PDFs (and their licences)
    "--hidden-import", "uharfbuzz",
    "--hidden-import", "riyeser.demo",
    "--hidden-import", "riyeser.demo_mode",
    "--hidden-import", "riyeser.demo_site",
    "--hidden-import", "riyeser.jobsite",
    "--hidden-import", "riyeser._built_edition",
    "--hidden-import", "riyeser.licence",
    "--hidden-import", "riyeser.signed_licence",
    "--hidden-import", "riyeser.ed25519",
    *(["--hidden-import", "riyeser._licence_key"] if LICENCE_KEY else []),
    *(["--hidden-import", "riyeser._map_key"] if ESRI_KEY else []),
    "--hidden-import", "riyeser.companies",
    "--hidden-import", "riyeser.archive",
    "--hidden-import", "riyeser.perms",
    "--hidden-import", "riyeser.views.companies",
    "--collect-submodules", "riyeser",
    "--collect-data", "fpdf",
    "--collect-data", "tzdata",   # time zones for online free times (Windows has none of its own; zoneinfo reads these)
    "--hidden-import", "tzdata",
    "--distpath", str(ROOT / "dist"),
    "--workpath", str(ROOT / "build"),
    "--specpath", str(ROOT / "build"),
]
if system == "Darwin":
    args += ["--windowed", "--osx-bundle-identifier", {"pos": "com.riyeser.pos", "invoices": "com.riyeser.invoices", "bookings": "com.riyeser.bookings", "estimate": "com.riyeser.estimate"}.get(EDITION, f"com.riyeser.accounting.{EDITION}")]
elif system == "Windows":
    # Its own app window (pywebview on Microsoft Edge WebView2, which Windows 10/11 already has) - never the web browser.
    args += ["--windowed", "--onefile", "--icon", str(ICON),
             "--collect-all", "webview", "--collect-all", "clr_loader", "--collect-all", "pythonnet", "--hidden-import", "clr"]
else:
    args += ["--onefile"]
try:
    PyInstaller.__main__.run(args)
finally:
    built.unlink(missing_ok=True)  # running from source stays "pick per company"
    key_file.unlink(missing_ok=True)  # and accepts unsigned licences
    map_key_file.unlink(missing_ok=True)
print("Built", APP_NAME, "into", ROOT / "dist")
