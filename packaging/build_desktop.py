"""Build a Riyeser Accounting desktop app for the current OS.

    pip install . pyinstaller
    python packaging/build_desktop.py --edition basics   # Riyeser Accounting Basics (free)
    python packaging/build_desktop.py --edition plus     # Riyeser Accounting Plus (licence)

Two separate apps from one code base: the edition is baked into the build (riyeser/_built_edition.py), with its own
name, icon and colours. Output: dist/Riyeser Accounting Basics.exe / dist/Riyeser Accounting Plus.exe (Windows),
.app bundles on macOS, riyeser-accounting-basics / riyeser-accounting-plus on Linux.
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
ap.add_argument("--edition", choices=["basics", "plus"], required=True)
EDITION = ap.parse_args().edition
APP_NAME = {"basics": "Riyeser Accounting Basics", "plus": "Riyeser Accounting Plus"}[EDITION]
ICON = ROOT / "packaging" / ("basics.ico" if EDITION == "basics" else "plus.ico")
built = PKG / "_built_edition.py"
built.write_text(f'APP_EDITION = "{EDITION}"\n', encoding="utf-8")

args = [
    str(ROOT / "packaging" / "riyeser_desktop.py"),
    "--noconfirm", "--clean",
    "--name", APP_NAME.lower().replace(" ", "-") if system == "Linux" else APP_NAME,
    "--paths", str(ROOT),
    "--add-data", f"{PKG / 'templates'}{sep}riyeser/templates",
    "--add-data", f"{PKG / 'static'}{sep}riyeser/static",
    "--add-data", f"{PKG / 'schema.sql'}{sep}riyeser",
    "--hidden-import", "riyeser.demo",
    "--hidden-import", "riyeser._built_edition",
    "--hidden-import", "riyeser.licence",
    "--hidden-import", "riyeser.companies",
    "--hidden-import", "riyeser.perms",
    "--hidden-import", "riyeser.views.companies",
    "--collect-submodules", "riyeser",
    "--collect-data", "fpdf",
    "--distpath", str(ROOT / "dist"),
    "--workpath", str(ROOT / "build"),
    "--specpath", str(ROOT / "build"),
]
if system == "Darwin":
    args += ["--windowed", "--osx-bundle-identifier", f"com.riyeser.accounting.{EDITION}"]
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
print("Built", APP_NAME, "into", ROOT / "dist")
