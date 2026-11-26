"""Build a Riyeser Accounting desktop app for the current OS.

    pip install . pyinstaller
    python packaging/build_desktop.py --edition basics   # Riyeser Accounting Basics (90 days free)
    python packaging/build_desktop.py --edition plus     # Riyeser Accounting Plus (licence)
    python packaging/build_desktop.py --edition pos      # Riyeser POS (90 days free, then a licence)
    python packaging/build_desktop.py --edition invoices # Riyeser Invoices (free forever)
    python packaging/build_desktop.py --edition bookings # Riyeser Bookings (90 days free, then a licence)

Five separate apps from one code base: the edition is baked into the build (riyeser/_built_edition.py), with its own
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
ap.add_argument("--edition", choices=["basics", "plus", "pos", "invoices", "bookings"], required=True)
EDITION = ap.parse_args().edition
APP_NAME = {"basics": "Riyeser Accounting Basics", "plus": "Riyeser Accounting Plus", "pos": "Riyeser POS",
            "invoices": "Riyeser Invoices", "bookings": "Riyeser Bookings"}[EDITION]
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

args = [
    str(ROOT / "packaging" / "riyeser_desktop.py"),
    "--noconfirm", "--clean",
    "--name", APP_NAME.lower().replace(" ", "-") if system == "Linux" else APP_NAME,
    "--paths", str(ROOT),
    "--add-data", f"{PKG / 'templates'}{sep}riyeser/templates",
    "--add-data", f"{PKG / 'static'}{sep}riyeser/static",
    "--add-data", f"{PKG / 'schema.sql'}{sep}riyeser",
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
    "--hidden-import", "riyeser.companies",
    "--hidden-import", "riyeser.archive",
    "--hidden-import", "riyeser.perms",
    "--hidden-import", "riyeser.views.companies",
    "--collect-submodules", "riyeser",
    "--collect-data", "fpdf",
    "--distpath", str(ROOT / "dist"),
    "--workpath", str(ROOT / "build"),
    "--specpath", str(ROOT / "build"),
]
if system == "Darwin":
    args += ["--windowed", "--osx-bundle-identifier", {"pos": "com.riyeser.pos", "invoices": "com.riyeser.invoices", "bookings": "com.riyeser.bookings"}.get(EDITION, f"com.riyeser.accounting.{EDITION}")]
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
print("Built", APP_NAME, "into", ROOT / "dist")
