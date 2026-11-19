"""Prepare the private Windows Python that runs Riyeser Accounting inside Riyeser Desk Assistant.

    python scripts/prepare_python.py

Downloads the official embeddable Python for Windows (64-bit) and the Windows wheels the
accounting app needs, then copies the `riyeser` package next to it. Output (bundled by the
installer, see scripts/builder.config.js):

    build/python-win/   python.exe + standard library + site-packages
    build/accounting/   the riyeser package (from the repository root)

Nothing here is installed on the user's PC system-wide; it lives inside the app's folder.
"""
import io
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

PY_VERSION = "3.12.8"
DESKTOP = Path(__file__).resolve().parent.parent
REPO = DESKTOP.parent
OUT = DESKTOP / "build" / "python-win"
APP = DESKTOP / "build" / "accounting"
CACHE = DESKTOP / "build" / "cache"


def requirements():
    """Runtime dependencies of riyeser-accounting, minus the window toolkit (the desktop app is the window)."""
    import tomllib
    deps = tomllib.loads((REPO / "pyproject.toml").read_text())["project"]["dependencies"]
    return [d for d in deps if not d.lower().startswith("pywebview")]


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    embed = CACHE / f"python-{PY_VERSION}-embed-amd64.zip"
    if not embed.exists():
        url = f"https://www.python.org/ftp/python/{PY_VERSION}/{embed.name}"
        print("Downloading", url)
        embed.write_bytes(urllib.request.urlopen(url, timeout=120).read())
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    zipfile.ZipFile(embed).extractall(OUT)

    site = OUT / "Lib" / "site-packages"
    site.mkdir(parents=True)
    with tempfile.TemporaryDirectory() as wheels:
        subprocess.check_call([sys.executable, "-m", "pip", "download", "--quiet", "--dest", wheels,
                               "--only-binary=:all:", "--platform", "win_amd64", "--implementation", "cp",
                               "--python-version", PY_VERSION.rsplit(".", 1)[0], *requirements()])
        for whl in sorted(Path(wheels).glob("*.whl")):
            print("  +", whl.name)
            zipfile.ZipFile(whl).extractall(site)

    # The embeddable Python only looks where its ._pth file says: add site-packages and the app folder.
    tag = "".join(PY_VERSION.split(".")[:2])
    (OUT / f"python{tag}._pth").write_text(f"python{tag}.zip\n.\nLib\\site-packages\n..\\accounting\nimport site\n")

    shutil.rmtree(APP, ignore_errors=True)
    shutil.copytree(REPO / "riyeser", APP / "riyeser", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    print("Ready:", OUT, "and", APP)


if __name__ == "__main__":
    main()
