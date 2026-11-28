"""The free trial survives reinstalls and wiped data folders (riyeser/trial_guard.py): the earliest valid date in
licence.json, the markers, the registry (an in-memory stand-in here), the company file's stamp and Riyeser online's PC
record (which Riyeser Central keeps in the registry) counts. Synthetic data only."""
import json
import os
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from riyeser import create_app, licence as L, signed_licence as S, trial_guard as G
from riyeser.db import init_db

T0 = datetime(2026, 9, 3, 9, tzinfo=timezone.utc)
iso = G.iso


@pytest.fixture
def reg():
    r = G.MemoryRegistry()
    G.configure(r)
    yield r
    G.configure(None)


def rdir():
    return os.path.join(os.environ["APPDATA"], "Riyeser")


def central_started(when=T0):
    """Riyeser Central started the shared trial (licence.json trialStart), as on a real PC."""
    os.makedirs(rdir(), exist_ok=True)
    with open(os.path.join(rdir(), "licence.json"), "w") as f:
        json.dump({"trialStart": iso(when.timestamp())}, f)


def wipe_appdata():
    for d in (os.environ["APPDATA"], os.environ["RIYESER_HOME"]):
        shutil.rmtree(d, ignore_errors=True)


def test_registry_shim_and_iso_dates(reg):
    assert G.use_windows_defaults() is False or os.name == "nt"   # nothing on other systems
    G.configure(reg)
    G.record(rdir(), "suite", start=T0.timestamp(), now=T0.timestamp())
    assert reg.data["suite"] == "2026-09-03T09:00:00.000Z"
    assert reg.data["LatestSeen"] == "2026-09-03T09:00:00.000Z"
    assert G.record(rdir(), "payroll; rm", start=1) is False
    assert G._parse("1999-01-01T00:00:00Z") is None, "dates before Riyeser's trials aren't believed"
    assert G._parse("not a date") is None


def test_reinstall_keeps_the_trial(reg):
    central_started()
    st = L.status(now=T0 + timedelta(days=10), product="basic")
    assert st["mode"] == "trial" and st["days_left"] == 80
    assert reg.data["suite"] == iso(T0.timestamp())
    # uninstall + reinstall: the program's own folder goes; licence.json and the registry stay
    shutil.rmtree(os.environ["RIYESER_HOME"], ignore_errors=True)
    assert L.status(now=T0 + timedelta(days=30), product="basic")["days_left"] == 60


def test_deleted_appdata_the_registry_brings_it_back(reg):
    central_started()
    L.status(now=T0 + timedelta(days=1), product="pos")
    wipe_appdata()
    st = L.status(now=T0 + timedelta(days=95), product="pos")
    assert st["mode"] == "expired", st
    assert json.load(open(os.path.join(rdir(), "licence.json")))["trialStart"].startswith("2026-09-03T09:00:00")


def test_new_windows_user_same_pc_gets_the_online_date_from_central(reg):
    # Riyeser Central (desktop/src/core/trial-guard.js) fetched the PC record with the machine-level PC code and kept it
    # in this Windows user's registry: Accounting adopts the earliest
    reg.data.update({"suite.Online": iso(T0.timestamp()), "OnlineCheckedAt": iso((T0 + timedelta(days=40)).timestamp()), "suite.OnlineExtra": "0"})
    central_started(T0 + timedelta(days=40))   # this Windows user's own (later) start
    st = L.status(now=T0 + timedelta(days=40), product="basic")
    assert st["days_left"] == 50


def test_goodwill_extension_from_riyeser_online(reg):
    central_started()
    reg.data.update({"suite.Online": iso(T0.timestamp()), "OnlineCheckedAt": iso(T0.timestamp()), "suite.OnlineExtra": "14"})
    st = L.status(now=T0 + timedelta(days=95), product="basic")
    assert st["mode"] == "trial" and st["days_left"] == 9


def test_clock_rolled_back_gives_no_days(reg):
    central_started()
    L.status(now=T0 + timedelta(days=80), product="basic")
    wipe_appdata()   # even with the markers gone, the registry has the latest time seen
    central_started()
    st = L.status(now=T0 + timedelta(days=5), product="basic")
    assert st["days_left"] == 10, st
    assert "ClockBack" in reg.data


def test_restored_old_company_file_its_older_date_wins(reg, tmp_path):
    # an old company file, stamped when its trial started (long ago), restored into a fresh install
    db = tmp_path / "old.db"
    app = create_app({"TESTING": True, "DATABASE": str(db)})
    with app.app_context():
        init_db("Restored Co")
    old = datetime.now(timezone.utc) - timedelta(days=200)
    con = sqlite3.connect(db)
    assert G.write_stamp(con, "suite", old.timestamp())
    assert not G.write_stamp(con, "suite", (old + timedelta(days=5)).timestamp()), "a stamp never moves later"
    con.close()
    central_started(datetime.now(timezone.utc))   # the fresh install's new trial
    c = app.test_client()
    c.get("/login")
    assert reg.data["suite.CompanyFile"] == iso(G._parse(iso(old.timestamp())))
    st = L.status(product="basic")
    assert st["mode"] == "expired", st
    assert json.load(open(os.path.join(rdir(), "licence.json")))["trialStart"][:10] == old.date().isoformat()


def test_opening_a_company_stamps_the_trial_start(reg, tmp_path):
    db = tmp_path / "c.db"
    app = create_app({"TESTING": True, "DATABASE": str(db)})
    with app.app_context():
        init_db("Stamp Co")
    started = datetime.now(timezone.utc) - timedelta(days=3)
    central_started(started)
    app.test_client().get("/login")
    con = sqlite3.connect(db)
    assert G.read_stamp(con, "suite") == G._parse(iso(started.timestamp()))
    con.close()


def test_demo_company_never_stamps_or_changes_the_trial(reg, tmp_path):
    db = tmp_path / "demo.db"
    app = create_app({"TESTING": True, "DATABASE": str(db), "DEMO_MODE": False})
    with app.app_context():
        init_db("Sample Trading Co (demo)")
    con = sqlite3.connect(db)
    con.execute("UPDATE company SET is_demo=1")
    con.execute("CREATE TABLE trial_stamp (program TEXT PRIMARY KEY, trial_start TEXT NOT NULL, stamped_at TEXT NOT NULL)")
    con.execute("INSERT INTO trial_stamp VALUES ('suite', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')")
    con.commit()
    con.close()
    real = datetime.now(timezone.utc)
    central_started(real)
    app.test_client().get("/login")
    assert "suite.CompanyFile" not in reg.data, reg.data
    assert G._parse(reg.data.get("suite")) in (None, G._parse(iso(real.timestamp()))), "the real trial, not the demo file's date"
    con = sqlite3.connect(db)
    assert con.execute("SELECT trial_start FROM trial_stamp").fetchall() == [("2025-01-01T00:00:00.000Z",)], "not stamped"
    con.close()


def test_demo_mode_never_touches_the_trial(reg, tmp_path, monkeypatch):
    p = tmp_path / "demo.json"
    p.write_text(json.dumps({"on": True}))
    monkeypatch.setenv("RIYESER_DEMO_FILE", str(p))
    central_started()
    L.status(now=T0, product="basic")
    assert reg.data == {}
    st = L.start_first_use("estimate", T0)
    assert st["started"] is False and reg.data == {}


def test_estimate_first_use_trial_per_program(reg, tmp_path):
    st = L.start_first_use("estimate", T0)
    assert st["started"] and reg.data["estimate"] == iso(T0.timestamp())
    assert "suite" not in reg.data, "Estimate's trial is its own"
    wipe_appdata()   # reinstall with everything wiped: the registry keeps Estimate's date
    st = L.first_use_status("estimate", T0 + timedelta(days=100))
    assert st["mode"] == "expired" and st["started"]
    # a restored company file's Estimate stamp counts too
    reg.data.clear()
    db = tmp_path / "e.db"
    con = sqlite3.connect(db)
    G.write_stamp(con, "estimate", (T0 - timedelta(days=10)).timestamp())
    G.sync_company(con, rdir(), now=T0)
    con.close()
    assert reg.data["estimate.CompanyFile"] == iso((T0 - timedelta(days=10)).timestamp())
    assert L.first_use_status("estimate", T0)["days_left"] == 80


def test_a_paid_licence_and_a_signed_in_business_are_unaffected(reg, tmp_path):
    """The plan from Riyeser online (unsigned here: before licence signing) decides, whatever the old local trial."""
    reg.data.update({"suite": "2024-06-01T00:00:00.000Z", "suite.CompanyFile": "2024-06-01T00:00:00.000Z"})
    os.makedirs(rdir(), exist_ok=True)
    plan = {"workspace_id": "w1", "checkedAt": iso(T0.timestamp()), "modules": {
        "basic": {"status": "active", "active": True, "paid_until": "2027-06-30"},
        "bookings": {"status": "trial", "active": True, "trial_ends": "2026-12-01"}}}
    with open(os.path.join(rdir(), "licence.json"), "w") as f:
        json.dump({"trialStart": "2024-06-01T00:00:00Z", "online": plan}, f)
    with open(os.path.join(rdir(), "company.json"), "w") as f:
        json.dump({"mode": "online", "workspace_id": "w1"}, f)
    S.use_key_for_tests("")
    try:
        assert L.status(now=T0, product="basic")["mode"] == "licensed"
        b = L.status(now=T0, product="bookings")
        assert b["mode"] == "trial" and b["source"] == "online" and b["days_left"] == 89, b
    finally:
        S.use_key_for_tests(None)
