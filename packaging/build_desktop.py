"""Build the Riyser Accounting desktop app for the current OS.

    pip install ".[desktop]" pyinstaller
    python packaging/build_desktop.py

Output: dist/Riyser Accounting.exe (Windows), dist/Riyser Accounting.app (macOS),
        dist/riyser-accounting (Linux)
"""
import os
import platform
import sys
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "riyser"
sep = os.pathsep
system = platform.system()

args = [
    str(ROOT / "packaging" / "riyser_desktop.py"),
    "--noconfirm", "--clean",
    "--name", "riyser-accounting" if system == "Linux" else "Riyser Accounting",
    "--paths", str(ROOT),
    "--add-data", f"{PKG / 'templates'}{sep}riyser/templates",
    "--add-data", f"{PKG / 'static'}{sep}riyser/static",
    "--add-data", f"{PKG / 'schema.sql'}{sep}riyser",
    "--hidden-import", "riyser.demo",
    "--collect-submodules", "riyser",
    "--distpath", str(ROOT / "dist"),
    "--workpath", str(ROOT / "build"),
    "--specpath", str(ROOT / "build"),
]
if system == "Darwin":
    args += ["--windowed", "--osx-bundle-identifier", "com.riyser.accounting"]
elif system == "Windows":
    args += ["--windowed", "--onefile"]
else:
    args += ["--onefile"]
PyInstaller.__main__.run(args)
print("Built into", ROOT / "dist")
