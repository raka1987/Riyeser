"""Build the Riyeser Accounting desktop app for the current OS.

    pip install . pyinstaller
    python packaging/build_desktop.py

Output: dist/Riyeser Accounting.exe (Windows), dist/Riyeser Accounting.app (macOS),
        dist/riyeser-accounting (Linux)
"""
import os
import platform
import sys
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "riyeser"
sep = os.pathsep
system = platform.system()

args = [
    str(ROOT / "packaging" / "riyeser_desktop.py"),
    "--noconfirm", "--clean",
    "--name", "riyeser-accounting" if system == "Linux" else "Riyeser Accounting",
    "--paths", str(ROOT),
    "--add-data", f"{PKG / 'templates'}{sep}riyeser/templates",
    "--add-data", f"{PKG / 'static'}{sep}riyeser/static",
    "--add-data", f"{PKG / 'schema.sql'}{sep}riyeser",
    "--hidden-import", "riyeser.demo",
    "--collect-submodules", "riyeser",
    "--collect-data", "fpdf",
    "--distpath", str(ROOT / "dist"),
    "--workpath", str(ROOT / "build"),
    "--specpath", str(ROOT / "build"),
]
if system == "Darwin":
    args += ["--windowed", "--osx-bundle-identifier", "com.riyeser.accounting"]
elif system == "Windows":
    # Its own app window (pywebview on Microsoft Edge WebView2, which Windows 10/11 already has) - never the web browser.
    args += ["--windowed", "--onefile", "--icon", str(ROOT / "packaging" / "riyeser.ico"),
             "--collect-all", "webview", "--collect-all", "clr_loader", "--collect-all", "pythonnet", "--hidden-import", "clr"]
else:
    args += ["--onefile"]
PyInstaller.__main__.run(args)
print("Built into", ROOT / "dist")
