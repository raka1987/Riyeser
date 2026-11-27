"""Screens fit and line up: the shared design tokens, one-line table rows and pills, and (with Node and Playwright
installed) every app's main screens in a real browser at 1280 wide with Windows 125% scaling: no sideways page
scroll, and pills and buttons in table cells on one line (tests/browser/layout.e2e.js)."""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "riyeser", "static")


def _css(name):
    with open(os.path.join(STATIC, name), encoding="utf-8") as f:
        return f.read()


def _rule(css, selector):
    """The declarations of the first rule whose selector list is exactly `selector`."""
    m = re.search(r"(?:^|[}\n])" + re.escape(selector) + r"\{([^}]*)\}", css)
    assert m, f"no rule for {selector}"
    return m.group(1)


def test_design_tokens_are_defined():
    root = _rule(_css("app.css"), ":root")
    for token in ("--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-6", "--ctl-h:36px", "--ctl-h-sm", "--ctl-h-lg",
                  "--fs-sm", "--fs-base", "--radius", "--brand", "--line-2"):
        assert token in root, token


def test_tables_scroll_in_their_box_and_pills_stay_on_one_line():
    css = _css("app.css")
    tbl = _rule(css, ".tbl")
    assert "overflow:auto" in tbl and "scrollbar-width:thin" in tbl
    assert "white-space:nowrap" in _rule(css, ".tbl td")
    assert "position:sticky" in _rule(css, ".tbl th")
    for sel in (".badge", ".lic-pill"):
        assert "white-space:nowrap" in _rule(css, sel), sel
    assert "white-space:nowrap" in css[css.index(".pill{"):].split("}")[0]
    assert "white-space:nowrap" in css[css.index(".bk-st{"):].split("}")[0]
    assert "min-height:var(--ctl-h)" in _rule(css, ".btn")


def test_filter_bar_controls_share_one_height():
    css = _css("lists.css")
    assert "height:var(--lh)" in _rule(css, ".lbar input,.lbar select")
    assert "width:auto" in _rule(css, ".lbar select")   # a drop-down is as wide as its text: never cut off
    assert "margin-left:auto" in _rule(css, ".lbar .lend")


def _have_node_playwright():
    node = shutil.which("node")
    if not node:
        return False
    try:
        return subprocess.run([node, "-e", "require('playwright')"], cwd=ROOT, capture_output=True, timeout=30).returncode == 0
    except Exception:
        return False


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(url, secs=60):
    end = time.time() + secs
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=2)
            return True
        except Exception:
            time.sleep(0.3)
    return False


@pytest.mark.skipif(os.environ.get("RIYESER_SKIP_BROWSER") == "1" or not _have_node_playwright(),
                    reason="needs Node with Playwright (and its Chromium)")
def test_main_screens_fit_at_1280_in_every_app():
    apps, procs = {}, []
    try:
        for app in ("basics", "plus", "invoices", "bookings", "pos", "estimate"):
            port = _free_port()
            procs.append(subprocess.Popen([sys.executable, os.path.join(ROOT, "tests", "browser", "serve_demo.py"), str(port), app],
                                          cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            apps[app] = f"http://127.0.0.1:{port}"
        for base in apps.values():
            assert _wait(base + "/login"), f"{base} did not start"
        r = subprocess.run(["node", os.path.join(ROOT, "tests", "browser", "layout.e2e.js")], cwd=ROOT,
                           env=dict(os.environ, APPS=json.dumps(apps)), capture_output=True, text=True, timeout=600)
        if r.returncode == 2 and "Executable doesn't exist" in (r.stderr + r.stdout):
            pytest.skip("Playwright's Chromium isn't installed")
        assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except Exception:
                p.kill()
