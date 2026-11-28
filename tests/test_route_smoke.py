"""Every screen opens, in every app, for a new company in Fiji, an older file with no country chosen and the demo
company, and also the way the packaged Windows programs run: built with -OO, on a PC with no internet and no
time-zone database. Plus the Online orders & bookings crash a Fiji owner saw in Riyeser POS (Setup → Online orders &
bookings: "Sorry, something went wrong"), and where the details of such an error are kept."""
import json
import os
import subprocess
import sys
import zoneinfo
from pathlib import Path

import pytest

from riyeser import create_app
from riyeser import online as O

from . import route_smoke

ROOT = Path(__file__).resolve().parent.parent
EDITIONS = ["source", "basics", "plus", "invoices", "bookings", "pos", "estimate"]
KINDS = ["fresh-fj", "fresh", "demo"]


def _keep_env(monkeypatch):
    for k in ("APPDATA", "RIYESER_HOME", "RIYESER_DEMO_FILE", "RIYESER_APP_EDITION"):
        if k in os.environ:
            monkeypatch.setenv(k, os.environ[k])
        else:   # set then removed, so monkeypatch removes it again afterwards (delenv alone records nothing)
            monkeypatch.setenv(k, "")
            monkeypatch.delenv(k)


@pytest.mark.parametrize("edition", EDITIONS)
def test_every_screen_opens_as_admin(tmp_path, monkeypatch, edition):
    _keep_env(monkeypatch)   # route_smoke sets these: put them back afterwards
    failures = route_smoke.run(str(tmp_path), edition, KINDS)
    assert failures == [], "\n".join(f"{k} {u}: {e}" for k, u, e in failures)


@pytest.mark.parametrize("edition", EDITIONS[1:])
def test_every_screen_opens_like_the_packaged_program(tmp_path, edition):
    """python -OO (docstrings and asserts stripped, as PyInstaller --optimize 2 builds), offline, no time-zone data."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("RIYESER_")}
    env["PYTHONPATH"] = str(ROOT)
    r = subprocess.run([sys.executable, "-OO", str(ROOT / "tests" / "route_smoke.py"), str(tmp_path), edition, *KINDS,
                        "--offline", "--no-tz"], capture_output=True, text=True, env=env, cwd=str(tmp_path), timeout=600)
    assert r.returncode == 0, r.stderr[-3000:]
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["optimize"] == 2
    assert out["failures"] == [], "\n".join(f"{k} {u}: {e}" for k, u, e in out["failures"])


# ---------------------------------------------------------------- the Fiji owner's crash
def _pos_company(tmp_path, monkeypatch, country=None):
    monkeypatch.setenv("RIYESER_APP_EDITION", "pos")
    prof = Path(os.environ["APPDATA"]) / "Riyeser" / "company.json"   # Riyeser Central's company profile
    prof.parent.mkdir(parents=True, exist_ok=True)
    prof.write_text(json.dumps({"name": "Test Fiji", "country": "Fiji"}), encoding="utf-8")
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "co.db")})
    return app, route_smoke.make_company(app, "fresh-fj" if country else "fresh")


@pytest.mark.parametrize("country", ["FJ", None])
def test_online_pages_open_on_a_pc_without_time_zone_data(tmp_path, monkeypatch, country):
    """Riyeser POS on Windows, company in Fiji: Windows has no time-zone database of its own, and builds before
    27 November 2026 didn't bundle one (tzdata) either, so ZoneInfo('Pacific/Fiji') raised and Setup → Online orders
    & bookings (and Online connections) showed "Sorry, something went wrong". Now standard time is used instead."""
    def no_data(key):
        raise zoneinfo.ZoneInfoNotFoundError(f"No time zone found with key {key}")
    monkeypatch.setattr(zoneinfo, "ZoneInfo", no_data)
    monkeypatch.setattr(O, "_TZ_CACHE", {}, raising=False)
    app, c = _pos_company(tmp_path, monkeypatch, country)
    for url in ("/online/", "/online/?t=booking", "/online/settings", "/online/connect", "/online/activity",
                "/online/activity.csv", "/help/diagnostics"):
        r = c.get(url)
        assert r.status_code == 200, url
    assert "Online orders &amp; bookings" in c.get("/online/").get_data(as_text=True)
    d = json.loads(c.get("/help/diagnostics?download=1").get_data(as_text=True))
    assert d["online"]["timezone"] == "Pacific/Fiji" and d["online"]["timezone_data_on_pc"] is False


def test_odd_values_in_what_central_reports_never_break_the_online_pages(tmp_path, monkeypatch):
    app, c = _pos_company(tmp_path, monkeypatch, "FJ")
    from riyeser.views.online import token
    report = {"at": "2026-11-28T08:00:00.000Z", "ok": "yes", "state": "working", "received_today": "3",
              "waiting": "lots", "failed": None, "pc": {"name": "FRONT"}, "last_publish": 5,
              "cloud": {"keys_active": "2", "sync_pc": ["x"], "requests_24h": "n/a", "unknown": 1}}
    r = c.post("/online/api/sync-report", json=report, headers={"X-Riyeser-Token": token(app)})
    assert r.status_code == 200
    with app.app_context():
        from riyeser.db import get_db
        s = O.sync_status(get_db())
    assert s["received_today"] == 3 and s["waiting"] is None and s["ok"] is True and s["pc"] is None
    assert s["cloud"] == {"keys_active": 2, "sync_pc": None, "requests_24h": None}
    for url in ("/online/", "/online/connect", "/online/activity", "/help/diagnostics"):
        assert c.get(url).status_code == 200, url
    with app.app_context():   # a value stored by an older version is cleaned when it's read, too
        db = get_db()
        O._put(db, "sync_status", {"at": "2026-11-28T08:00:00Z", "state": "waiting", "received_today": "2"})
        db.commit()
    assert c.get("/online/").status_code == 200


def test_an_error_page_has_a_reference_and_the_details_are_in_the_error_log(tmp_path, monkeypatch):
    monkeypatch.setenv("RIYESER_APP_EDITION", "pos")
    app = create_app({"TESTING": True, "PROPAGATE_EXCEPTIONS": False, "DATABASE": str(tmp_path / "co.db")})

    def boom():
        raise RuntimeError("synthetic failure for the test")
    app.add_url_rule("/pos/boom-test", "pos.boom_test", boom)
    c = route_smoke.make_company(app, "fresh")
    r = c.get("/pos/boom-test")
    page = r.get_data(as_text=True)
    assert r.status_code == 500 and "Sorry, something went wrong" in page
    ref = page.split("Reference ")[1][:9]
    assert ref.startswith("ER-")
    log = (tmp_path / "riyeser-errors.log").read_text(encoding="utf-8")
    assert ref in log and "RuntimeError: synthetic failure for the test" in log and "GET /pos/boom-test" in log
    assert "test_route_smoke.py" in log   # where in the code it happened
    d = json.loads(c.get("/help/diagnostics?download=1").get_data(as_text=True))
    assert d["error_log"]["file"] == str(tmp_path / "riyeser-errors.log")
    assert any(ref in line for line in d["error_log"]["last_lines"])
    assert any(ref in e["details"] for e in d["recent_errors"])
    assert "riyeser-errors.log" in c.get("/help/diagnostics").get_data(as_text=True)


def test_missing_records_are_not_found_not_an_error_page(tmp_path, monkeypatch):
    monkeypatch.delenv("RIYESER_APP_EDITION", raising=False)
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "co.db")})
    c = route_smoke.make_company(app, "fresh")
    for url in ("/sale/999/edit", "/purchase/999/edit", "/payroll/payrun/999", "/payroll/payslip/999"):
        assert c.get(url).status_code == 404, url


def test_the_windows_build_bundles_time_zone_data_and_has_no_code_that_needs_docstrings():
    spec = (ROOT / "packaging" / "build_desktop.py").read_text(encoding="utf-8")
    assert '"--collect-data", "tzdata"' in spec and '"--hidden-import", "tzdata"' in spec
    assert "tzdata" in (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    for f in (ROOT / "riyeser").rglob("*.py"):   # -OO strips docstrings and asserts: nothing may rely on them
        text = f.read_text(encoding="utf-8")
        assert "__doc__" not in text and "__debug__" not in text, f
        assert not any(line.lstrip().startswith("assert ") for line in text.splitlines()), f
