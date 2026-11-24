"""The company's licence from Riyeser online (saved by Riyeser Central in licence.json "online"): each paid program
(module) is unlocked on its own; it stays good for 30 days without the internet; without it, nothing changes."""
import json
from datetime import datetime, timedelta, timezone

from riyeser import licence, plan as P
from riyeser.db import get_db
from tests.test_pos_app import make, sell, _trial

NOW = datetime(2026, 11, 24, 12, tzinfo=timezone.utc)


def online(modules, checked_days_ago=0, extra_companies=0):
    return {"workspace_id": "w1", "company_code": "RIY-7K3M-Q2", "checked_at": NOW.isoformat(),
            "checkedAt": (NOW - timedelta(days=checked_days_ago)).isoformat(),
            "modules": modules, "seats": {"included": 3, "extra": 0, "used": 2}, "extra_companies": extra_companies,
            "billing": "monthly", "early_bird": False}


def write(tmp_path, data):
    f = tmp_path / "licence.json"
    f.write_text(json.dumps(data))
    return str(f)


PAID = {"status": "active", "active": True, "trial_ends": None, "paid_until": "2027-06-30", "days_left": 218}
TRIAL = {"status": "trial", "active": True, "trial_ends": "2027-01-03", "paid_until": None, "days_left": 40}
ENDED = {"status": "ended", "active": False, "trial_ends": "2026-11-01", "paid_until": None, "days_left": 0}


def test_each_module_on_its_own(tmp_path):
    p = write(tmp_path, {"trialStart": "2020-01-01T00:00:00Z", "online": online({"basic": PAID, "pos": TRIAL, "plus": ENDED})})
    assert licence.status(NOW, p, product="basic")["mode"] == "licensed"
    st = licence.status(NOW, p, product="pos")
    assert st["mode"] == "trial" and st["days_left"] == 40
    assert licence.status(NOW, p, product="plus")["mode"] == "expired"
    assert licence.status(NOW, p, product="enterprise")["mode"] == "expired"      # Plus app's edition name
    assert not licence.enterprise_allowed(NOW, p)
    assert licence.status(NOW, p, product="bookings")["mode"] == "expired"        # not in the plan at all


def test_trial_days_from_trial_end_when_not_given(tmp_path):
    t = dict(TRIAL, days_left=None, trial_ends="2026-12-04")
    p = write(tmp_path, {"online": online({"basic": t})})
    assert licence.status(NOW, p, product="basic")["days_left"] == 10


def test_stale_online_licence_stops_paid_work(tmp_path):
    p = write(tmp_path, {"online": online({"basic": PAID}, checked_days_ago=31)})
    st = licence.status(NOW, p, product="basic")
    assert st["mode"] == "expired" and st["stale"] and "couldn't check your licence for 30 days" in st["message"]
    p = write(tmp_path, {"online": online({"basic": PAID}, checked_days_ago=29)})
    assert licence.status(NOW, p, product="basic")["mode"] == "licensed"


def test_without_an_online_section_nothing_changes(tmp_path, monkeypatch):
    start = (NOW - timedelta(days=10)).isoformat()
    p = write(tmp_path, {"trialStart": start})
    st = licence.status(NOW, p, product="pos")
    assert st == {"mode": "trial", "days_left": 80, "buy_url": licence.BUY_URL}
    assert licence.status(NOW, p) == st                                   # the old call still works
    # licence.json gone: the hidden marker in Accounting's own folder still knows when the trial started
    assert licence.status(NOW, str(tmp_path / "missing.json")) == st
    # a PC where no Riyeser program has ever started a trial (before licences are signed): nothing to show
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    monkeypatch.setenv("RIYESER_HOME", str(fresh / "home"))
    assert licence.status(NOW, str(fresh / "missing.json")) == {"mode": "unknown"}
    p = write(tmp_path, {"trialStart": start, "key": "K", "licence": {"status": "active", "checkedAt": NOW.isoformat(), "extraCompanies": 2}})
    assert licence.status(NOW, p, product="basic")["mode"] == "licensed" and licence.company_allowance(NOW, p, product="basic") == 3


def test_extra_companies_from_online(tmp_path):
    p = write(tmp_path, {"online": online({"basic": PAID, "pos": TRIAL}, extra_companies=2)})
    assert licence.company_allowance(NOW, p, product="basic") == 3        # paid: 1 + 2 extra
    assert licence.company_allowance(NOW, p, product="pos") is None       # still on its trial: no limit
    p = write(tmp_path, {"online": online({"basic": ENDED}, extra_companies=2)})
    assert licence.company_allowance(NOW, p, product="basic") == 1


def _online_file(tmp_path, modules, **kw):
    f = tmp_path / "appdata" / "Riyeser" / "licence.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    o = online(modules, **kw)
    o["checkedAt"] = (datetime.now(timezone.utc) - timedelta(days=kw.get("checked_days_ago", 0))).isoformat()
    f.write_text(json.dumps({"trialStart": "2020-01-01T00:00:00Z", "online": o}))


def test_pos_and_basics_use_their_own_modules(tmp_path, monkeypatch):
    # POS paid, Basics ended: the till sells; Basics stops new invoices (and says why)
    app, c, item = make(tmp_path, monkeypatch, "pos")
    _online_file(tmp_path, {"pos": PAID, "basic": ENDED})
    assert sell(c, item).get_json()["ok"]
    with app.app_context():
        assert not P.plan(get_db(), "pos")["locked"] and P.plan(get_db(), "basic")["locked"]
        assert "isn't part of your Riyeser plan" in P.capped_message("basic")


def test_basics_app_follows_the_basic_module(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "basics")
    _online_file(tmp_path, {"basic": TRIAL, "pos": ENDED})
    page = c.get("/").get_data(as_text=True)
    assert "Free trial · 40 days left" in page
    _online_file(tmp_path, {"basic": PAID})
    assert "Free trial" not in c.get("/").get_data(as_text=True)


def test_stale_licence_message_when_adding_work(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "pos")
    _online_file(tmp_path, {"pos": PAID}, checked_days_ago=31)
    r = sell(c, item)
    assert r.status_code == 402 and "couldn't check your licence for 30 days" in r.get_json()["error"]


def test_invoices_stays_free_whatever_the_licence(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "invoices")
    _online_file(tmp_path, {"basic": ENDED, "plus": ENDED})
    with app.app_context():
        cid = get_db().execute("INSERT INTO contacts (kind, name) VALUES ('customer','Jo')").lastrowid
        get_db().commit()
    r = c.post("/sale/new", data={"contact_id": cid, "date": "2026-11-20", "status": "open", "line_item": item,
                                  "line_description": "Coffee", "line_qty": "1", "line_price": "4", "line_discount": "",
                                  "line_account": "", "line_tax": "", "line_job": ""}, follow_redirects=True)
    assert "saved" in r.get_data(as_text=True)


def test_plus_app_locks_its_screens_when_plus_ended(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "plus")
    _online_file(tmp_path, {"plus": ENDED, "basic": PAID})
    r = c.get("/payroll/")
    assert r.status_code == 302                                     # Plus-only screens wait for a licence
    assert c.get("/sale/list").status_code == 200                   # invoices and the rest keep working
    _online_file(tmp_path, {"plus": PAID})
    assert c.get("/payroll/").status_code == 200
