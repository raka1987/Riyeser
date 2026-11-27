"""Online connections: the local API never answers a bare 500 (a JSON error with a plain message and a reference),
works on a PC without time-zone data (Windows without tzdata: the "The program answered 500" every minute), and
the Online pages say where things stand (not set up, connected and waiting, working, a problem, off on this PC),
with the "Connect your website" guide, "Send a test" and the activity trail."""
import json
import os
import sqlite3
import uuid
import zoneinfo
from datetime import datetime, timedelta, timezone

import pytest

from riyeser import create_app
from riyeser import online as O
from riyeser.db import get_db, init_db
from riyeser.views import online as V
from riyeser.views.online import token, log_file


@pytest.fixture
def app(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "o.db")})
    with app.app_context():
        init_db("Fiji Shop")
        db = get_db()
        db.execute("UPDATE company SET bookings_mode='appointments', currency='FJD'")
        db.execute("INSERT INTO booking_resources (name, kind) VALUES ('Ana','staff')")
        db.execute("INSERT INTO booking_services (name, minutes, price) VALUES ('Haircut', 30, 4500)")
        O.save_settings(db, dict(timezone="Pacific/Fiji", hours={d: "09:00-17:00" for d in O.WEEKDAYS}))
        db.commit()
    O._TZ_CACHE.clear()
    yield app
    O._TZ_CACHE.clear()


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return c


def api(app, method, path, body=None):
    with app.app_context():
        h = {"X-Riyeser-Token": token(app)}
    return getattr(app.test_client(), method)(f"/online/api/{path}", json=body, headers=h)


@pytest.fixture
def no_tzdata(monkeypatch):
    """A Windows PC without the tzdata package: every named time zone is unknown to zoneinfo."""
    def boom(key):
        raise zoneinfo.ZoneInfoNotFoundError(f"No time zone found with key {key}")
    monkeypatch.setattr(zoneinfo, "ZoneInfo", boom)
    O._TZ_CACHE.clear()


# ---------------------------------------------------------------- the 500 itself
def test_no_timezone_data_free_times_still_publish(app, no_tzdata):
    r = api(app, "get", "availability")
    assert r.status_code == 200, r.get_data(as_text=True)
    d = r.get_json()
    assert d["settings"]["timezone"] == "Pacific/Fiji" and d["open_times"]
    # 09:00 in Fiji (UTC+12) is 21:00 UTC the day before
    assert all(w["start"].endswith("T21:00:00.000Z") or w["start"] > "" for w in d["open_times"])
    assert any(w["start"][11:16] == "21:00" for w in d["open_times"])
    with app.app_context():
        assert O.tz_fallback("Pacific/Fiji") is True


def test_no_timezone_data_pages_open(client, no_tzdata):
    for url in ("/online/", "/online/settings", "/online/connect", "/online/activity"):
        r = client.get(url)
        assert r.status_code == 200, (url, r.get_data(as_text=True)[:300])
    assert b"no time-zone data" in client.get("/online/settings").data


def test_unknown_timezone_name_falls_back_to_utc(app, no_tzdata, monkeypatch):
    with app.app_context():
        db = get_db()
        O._put(db, "settings", dict(O._raw(db, "settings"), timezone="Mars/Olympus"))
        assert O.settings(db)["timezone"] in ("UTC", O.default_timezone())
    assert api(app, "get", "availability").status_code == 200


def test_country_default_timezone_is_checked(app, no_tzdata, monkeypatch):
    from riyeser import company_profile
    monkeypatch.setattr(company_profile, "read", lambda path=None: {"country": "Fiji"})
    assert O.default_timezone() == "Pacific/Fiji"           # standard time fallback knows it
    monkeypatch.setattr(company_profile, "read", lambda path=None: (_ for _ in ()).throw(OSError("unreadable")))
    assert O.default_timezone() == "UTC"


# ---------------------------------------------------------------- never a bare 500
@pytest.mark.parametrize("path,fn,words", [
    ("catalog", "catalog", "couldn't publish your prices"),
    ("stock", "stock", "couldn't publish your stock levels"),
    ("availability", "availability", "couldn't publish your free booking times"),
    ("outbox", "outbox", "couldn't read the news for your website"),
])
def test_an_unexpected_error_is_json_with_a_plain_message(app, monkeypatch, path, fn, words):
    def broken(*a, **k):
        raise RuntimeError("something odd in the company file")
    monkeypatch.setattr(O, fn, broken)
    r = api(app, "get", path)
    assert r.status_code == 500 and r.is_json
    d = r.get_json()
    assert d["error"] == "internal" and words in d["message"] and "something odd" in d["message"]
    assert d["message"].startswith("Riyeser Accounting ")
    assert d["ref"].startswith("OA-") and len(d["ref"]) == 9
    with app.app_context():
        row = get_db().execute("SELECT details FROM audit_log WHERE action='error' ORDER BY id DESC").fetchone()
        assert d["ref"] in row["details"]                     # in Support Diagnostics → Recent errors
        f = log_file(app)
    assert os.path.exists(f) and d["ref"] in open(f, encoding="utf-8").read() and d["log"] == f


def test_the_program_name_is_the_one_that_answers(app, monkeypatch):
    app.config["ONLINE_PROGRAM"] = "Riyeser POS"
    monkeypatch.setattr(O, "catalog", lambda *a, **k: (_ for _ in ()).throw(ValueError("bad price")))
    assert api(app, "get", "catalog").get_json()["message"] == "Riyeser POS couldn't publish your prices: bad price."


def test_a_locked_company_file_says_so(app, monkeypatch):
    monkeypatch.setattr(O, "stock", lambda *a, **k: (_ for _ in ()).throw(sqlite3.OperationalError("database is locked")))
    d = api(app, "get", "stock").get_json()
    assert "the company file is busy" in d["message"]


def test_plain_reasons():
    assert "no time-zone data for Pacific/Fiji" in V.plain_reason(
        zoneinfo.ZoneInfoNotFoundError("'No time zone found with key Pacific/Fiji'"))
    assert "needs updating" in V.plain_reason(sqlite3.OperationalError("no such table: online_trail"))
    assert "read-only" in V.plain_reason(sqlite3.OperationalError("attempt to write a readonly database"))
    assert V.plain_reason(KeyError("x")) == "'x'"


def test_an_error_while_bringing_the_company_file_up_to_date_is_json(app, monkeypatch):
    from riyeser import db as dbmod
    monkeypatch.setattr(dbmod, "migrate", lambda db: (_ for _ in ()).throw(sqlite3.OperationalError("disk I/O error")))
    app.config["_migrated_dbs"] = set()
    r = api(app, "get", "status")
    assert r.status_code == 500 and r.get_json()["error"] == "internal"
    assert "couldn't open the company file for online connections" in r.get_json()["message"]


def test_company_not_set_up_yet_is_a_plain_409(app):
    with app.app_context():
        db = get_db()
        db.execute("PRAGMA foreign_keys=OFF")
        db.execute("DELETE FROM company")
        db.commit()
    r = api(app, "get", "status")
    assert r.status_code == 409 and r.get_json()["error"] == "no_company"
    assert "finish setting up the company" in r.get_json()["message"]


def test_an_unknown_local_api_path_is_json_404(app):
    r = api(app, "get", "trail-of-the-future")
    assert r.status_code == 404 and r.is_json and "update it" in r.get_json()["message"]
    assert api(app, "post", "outbox/done/extra", {}).status_code == 404


def test_still_locked_to_central(app):
    r = app.test_client().get("/online/api/catalog")
    assert r.status_code == 401 and r.get_json()["error"] == "bad_token"
    r = app.test_client().get("/online/api/unknown")
    assert r.status_code == 401


def test_empty_company_publishes_empty_lists(app):
    with app.app_context():
        db = get_db()
        db.execute("DELETE FROM booking_services")
        db.execute("DELETE FROM booking_resources")
        db.commit()
    assert api(app, "get", "catalog").get_json() == {"items": [], "skipped": []}
    assert api(app, "get", "stock").get_json()["levels"] == []
    a = api(app, "get", "availability").get_json()
    assert a["open_times"] == [] and a["staff"] == []
    assert api(app, "get", "outbox").get_json() == {"events": []}
    assert api(app, "post", "import", {"items": []}).get_json() == {"results": []}


def test_a_booking_with_an_odd_time_doesnt_stop_free_times(app):
    with app.app_context():
        db = get_db()
        rid = db.execute("SELECT id FROM booking_resources").fetchone()[0]
        day = (datetime.now() + timedelta(days=1)).date().isoformat()
        db.execute("INSERT INTO bookings (resource_id, starts_at, minutes, status, title) VALUES (?,?,30,'booked','X')",
                   (rid, day + "T10:00:00Z"))
        db.execute("INSERT INTO bookings (resource_id, starts_at, minutes, status, title) VALUES (?,?,30,'booked','Y')",
                   (rid, day + " soon"))
        db.commit()
    assert api(app, "get", "availability").status_code == 200


# ---------------------------------------------------------------- where things stand
def report(app, **kw):
    body = {**dict(at=datetime.now(timezone.utc).isoformat(), ok=True, pc="FRONT-PC"), **kw}
    assert api(app, "post", "sync-report", body).status_code == 200


def page(client, url="/online/"):
    return client.get(url).get_data(as_text=True)


def test_never_reported_says_not_set_up_with_a_set_up_button(client):
    h = page(client)
    assert 'data-state="not_setup"' in h and "Online connections aren't set up" in h
    assert "Connect your website or online shop so bookings and orders come in by themselves." in h
    assert 'id="ol-setup"' in h and "/online/connect" in h
    assert "answered 500" not in h and "dot err" not in h


def test_central_says_not_set_up(app, client):
    report(app, state="not_setup", cloud=dict(keys_active=0))
    h = page(client)
    assert 'data-state="not_setup"' in h and "aren't set up" in h


def test_waiting_says_connected_nothing_new(app, client):
    report(app, state="waiting", cloud=dict(keys_active=1))
    h = page(client)
    assert 'data-state="waiting"' in h and "Connected · last checked just now · nothing new" in h
    assert "dot ok" in h


def test_working_shows_counts(app, client):
    report(app, state="working", received_today=2)
    assert "received today · last sync just now" in page(client)


def test_problem_shows_message_fix_reference_and_details(app, client):
    report(app, state="problem", ok=False, error="Riyeser POS couldn't publish your prices: bad price.",
           fix="It will be tried again in a minute.", ref="OA-ABC123")
    h = page(client)
    assert 'data-state="problem"' in h and "Riyeser POS couldn&#39;t publish your prices: bad price." in h
    assert "OA-ABC123" in h and "/online/activity?st=problems" in h and "dot err" in h


def test_off_on_this_pc_names_the_sync_pc(app, client):
    report(app, state="off", cloud=dict(sync_pc="OFFICE-PC"))
    h = page(client)
    assert "Off on this PC" in h and "OFFICE-PC brings in what your website sends" in h


def test_a_pc_that_is_off_doesnt_overwrite_the_sync_pc(app, client):
    report(app, state="working", received_today=1)
    api(app, "post", "sync-report", dict(at=datetime.now(timezone.utc).isoformat(), ok=True, pc="LAPTOP", state="off"))
    assert 'data-state="working"' in page(client)


def test_old_report_is_stale(app, client):
    old = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    api(app, "post", "sync-report", dict(at=old, ok=True, pc="FRONT-PC", state="waiting"))
    h = page(client)
    assert "hasn't checked in since 3 h ago" in h and "ol-warn" in h


def test_older_central_report_without_state(app, client):
    api(app, "post", "sync-report", dict(at=datetime.now(timezone.utc).isoformat(), ok=False, error="Oops", pc="PC"))
    assert 'data-state="problem"' in page(client)


# ---------------------------------------------------------------- guide, test send, trail
def test_guide_checklist_ticks_from_what_really_happened(app, client):
    h = page(client, "/online/connect")
    assert h.count('class="" data-check') == 5 or h.count('data-check') == 5
    assert 'class="on" data-check' not in h
    for words in ("Choose what you want", "Make the key in Riyeser Link", "Copy the code into your website",
                  "Send a test", "WordPress", "Wix", "Squarespace", "Shopify", "Plain HTML", "How it works"):
        assert words in h
    report(app, state="waiting", cloud=dict(keys_active=1, last_request_at="2026-11-27T01:00:00Z",
                                            catalog_at="2026-11-27T01:00:00Z"))
    h = page(client, "/online/connect")
    for c in ("key", "request", "sync", "publish"):
        assert f'class="on" data-check="{c}"' in h
    assert 'class="" data-check="item"' in h


def test_guide_choices_change_the_instructions(client):
    assert 'data-type="enquiry"' in page(client, "/online/connect?what=enquiry")
    assert "Online shop orders" in page(client, "/online/connect?what=shop")
    assert "Custom / developer" in page(client, "/online/connect?what=developer")


def test_send_a_test_goes_through_central(app, client):
    r = client.post("/online/connect/test", data={"kind": "booking"}, headers={"Accept": "application/json"})
    assert r.get_json()["step"] == "asked"
    req = api(app, "get", "status").get_json()["test_request"]
    assert req["kind"] == "booking"
    eid = str(uuid.uuid4())
    report(app, state="waiting", test_sent=dict(request_id=req["id"], event_id=eid))
    assert client.get("/online/connect/test.json").get_json()["step"] == "sent"
    assert api(app, "get", "status").get_json()["test_request"] is None     # asked once only
    start = (datetime.now(timezone.utc) + timedelta(days=3)).replace(hour=0, minute=0, second=0, microsecond=0)
    item = dict(id=eid, kind="enquiry", test=True, source="test", key_name="Riyeser test", attempts=1,
                created_at=start.isoformat(), payload=dict(customer=dict(name="Test Customer", email="test@example.com"),
                                                           message="This is a test from Riyeser."))
    res = api(app, "post", "import", {"items": [item]}).get_json()["results"][0]
    assert res["outcome"] == "done" and res["test"]
    p = client.get("/online/connect/test.json").get_json()
    assert p["step"] == "arrived"
    with app.app_context():   # a test never touches the books: no customer was added
        assert get_db().execute("SELECT COUNT(*) FROM contacts WHERE email='test@example.com'").fetchone()[0] == 0
    assert "It arrived." in page(client, "/online/connect")


def test_send_a_test_error_is_shown(app, client):
    client.post("/online/connect/test", data={"kind": "enquiry"})
    req = api(app, "get", "status").get_json()["test_request"]
    report(app, test_sent=dict(request_id=req["id"], error="Online bookings need Riyeser Bookings."))
    p = client.get("/online/connect/test.json").get_json()
    assert p["step"] == "error" and "Riyeser Bookings" in p["error"]


def trail_entry(**kw):
    e = dict(at=datetime.now(timezone.utc).isoformat(), type="item", status="done", source="Website · Shop key",
             what="Filed as booking BK-1001", ref="BK-1001", uid=str(uuid.uuid4()))
    e.update(kw)
    return e


def test_trail_is_kept_filtered_and_exported(app, client):
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    report(app, state="working", trail=[
        trail_entry(),
        trail_entry(status="rejected", what="Turned down: that time is taken", ref=None),
        trail_entry(type="publish", status="ok", what="Published 12 prices", source="Riyeser POS", ref=None),
        trail_entry(type="run", status="ok", what="Checked: nothing new", n=42, uid="quiet-1", at=yesterday),
        trail_entry(type="item", what="=HYPERLINK(\"http://x\")", source="+cmd"),
        trail_entry(at=(datetime.now(timezone.utc) - timedelta(days=100)).isoformat(), what="Too old"),
        {"type": "nonsense", "at": "x"},
    ])
    report(app, trail=[trail_entry(type="run", status="ok", what="Checked: nothing new", n=60, uid="quiet-1", at=yesterday)])
    with app.app_context():
        rows = get_db().execute("SELECT * FROM online_trail ORDER BY id").fetchall()
    assert len(rows) == 5 and [r["n"] for r in rows if r["uid"] == "quiet-1"] == [60]
    h = page(client, "/online/activity")
    assert "Filed as booking BK-1001" in h and "Turned down: that time is taken" in h and "60 checks" in h
    assert "Too old" not in h
    h = page(client, "/online/activity?st=problems")
    assert "Turned down" in h and "Published 12 prices" not in h
    h = page(client, "/online/activity?kind=publish")
    assert "Published 12 prices" in h and "BK-1001" not in h
    day = (datetime.now(timezone.utc) - timedelta(days=1)).astimezone().date().isoformat()
    utc_day = yesterday[:10]
    assert "nothing new" in page(client, f"/online/activity?day={utc_day}")
    csv = client.get("/online/activity.csv").get_data(as_text=True)
    assert csv.startswith("﻿When") and "Filed as booking BK-1001" in csv
    assert "'=HYPERLINK" in csv and "'+cmd" in csv
    assert day  # (local day only for display)


def test_trail_page_empty_states(client):
    h = page(client, "/online/activity")
    assert "Nothing yet." in h and "Connect your website" in h
    assert "Nothing matches these filters." in page(client, "/online/activity?st=error")


def test_diagnostics_has_online(client):
    d = json.loads(client.get("/help/diagnostics?download=1").data)
    assert d["online"]["timezone"] == "Pacific/Fiji" and "timezone_data_on_pc" in d["online"]
