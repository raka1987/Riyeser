"""Signed licences in Riyeser Accounting (every edition, POS and Bookings): every way of cheating the licence file
leaves the paid program locked. tests/licence-vectors.json is shared with Central, Payroll and the licence function."""
import base64
import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from riyeser import ed25519, licence, plan as P
from riyeser import signed_licence as S

V = json.load(open(os.path.join(os.path.dirname(__file__), "licence-vectors.json"), encoding="utf-8"))
NOW = datetime(2026, 11, 24, 12, tzinfo=timezone.utc)
WS = "11111111-1111-4111-8111-111111111111"
DEV = "22222222-2222-4222-8222-222222222222"
K1 = bytes.fromhex(V["rfc8032"][0]["secret"])   # RFC 8032 test key 1: published, only for tests
PUB = V["sample"]["public_key"]
OTHER = bytes.fromhex(V["rfc8032"][1]["secret"])
PLAN = {"workspace_id": WS, "company_code": "RIY-TEST-01", "checked_at": "2026-11-24T12:00:00.000Z", "business_status": "active",
        "modules": {"basic": {"status": "active", "active": True, "trial_ends": None, "paid_until": "2027-06-30", "days_left": 218},
                    "pos": {"status": "ended", "active": False, "trial_ends": "2026-11-01", "paid_until": None, "days_left": 0},
                    "bookings": {"status": "trial", "active": True, "trial_ends": "2027-01-03", "paid_until": None, "days_left": 40}},
        "seats": {"included": 3, "extra": 0, "used": 2}, "extra_companies": 1, "billing": "monthly", "early_bird": False}
iso = lambda t: t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sign(plan=PLAN, key=K1, issued=NOW, device=DEV, ws=WS):
    env = {"licence": plan, "issued_at": iso(issued), "expires_at": iso(issued + timedelta(days=30)), "workspace_id": ws, "device_id": device}
    return dict(env, sig=base64.b64encode(ed25519.sign(key, S.signed_bytes(env))).decode())


@pytest.fixture
def key():
    S.use_key_for_tests(PUB)
    yield PUB
    S.use_key_for_tests(None)


@pytest.fixture
def pc(tmp_path, monkeypatch):
    """A PC linked to the business: company.json, device.json, and licence.json as Central saves it."""
    monkeypatch.setenv("RIYESER_HOME", str(tmp_path / "home"))
    rd = tmp_path / "appdata" / "Riyeser"
    rd.mkdir(parents=True)

    def make(signed="default", ws=WS, device=DEV, checked=NOW, trial_start="2026-01-01T00:00:00Z"):
        signed = sign() if signed == "default" else signed
        (rd / "company.json").write_text(json.dumps({"mode": "online", "name": "Sample Plumbing", "workspace_id": ws}))
        if device:
            (rd / "device.json").write_text(json.dumps({"id": device}))
        online = dict((signed or {}).get("licence") or PLAN, checkedAt=iso(checked))
        if signed:
            online["signed"] = signed
        (rd / "licence.json").write_text(json.dumps({"trialStart": trial_start, "online": online}))
        return str(rd / "licence.json")
    return make


def edit(path, fn):
    d = json.load(open(path))
    fn(d)
    open(path, "w").write(json.dumps(d))


# ---------- the shared vectors ----------
def test_canonical_json_matches_the_shared_vectors_byte_for_byte():
    for c in V["canonical"]:
        assert S.canonical(c["input"]) == c["expected"]
    env = dict(V["sample"]["envelope"])
    env.pop("sig")
    assert S.canonical(env) == V["sample"]["canonical"]
    with pytest.raises(ValueError):
        S.canonical({"a": 1.5})


def test_ed25519_rfc8032_vectors():
    for t in V["rfc8032"]:
        sk, pk, msg, sig = (bytes.fromhex(t[k]) for k in ("secret", "public", "message", "signature"))
        assert ed25519.public_key(sk) == pk
        assert ed25519.sign(sk, msg) == sig
        assert ed25519.verify(pk, msg, sig)
        assert not ed25519.verify(pk, msg + b"\0", sig)
        assert not ed25519.verify(pk, msg, sig[:63] + bytes([sig[63] ^ 1]))
    assert not ed25519.verify(b"\0" * 31, b"", b"\0" * 64)
    assert S.verify_signature(V["sample"]["envelope"], PUB)
    # the same signature Node and Deno made: Ed25519 is deterministic, so the bytes signed are the same everywhere
    assert sign(V["sample"]["envelope"]["licence"], issued=datetime(2026, 11, 24, 12, tzinfo=timezone.utc))["sig"] == V["sample"]["envelope"]["sig"]


# ---------- cheating ----------
def test_valid_signed_licence_unlocks(key, pc):
    p = pc()
    assert licence.status(NOW, p, product="basic")["mode"] == "licensed"
    st = licence.status(NOW, p, product="bookings")
    assert st["mode"] == "trial" and st["days_left"] == 40
    assert licence.status(NOW, p, product="pos")["mode"] == "expired"
    assert licence.company_allowance(NOW, p, product="basic") == 2


def test_edited_licence_is_locked(key, pc):
    p = pc()
    def flip(d):
        d["online"]["signed"]["licence"]["modules"]["pos"] = {"status": "active", "active": True, "paid_until": "2099-12-31"}
        d["online"]["modules"]["pos"] = d["online"]["signed"]["licence"]["modules"]["pos"]
    edit(p, flip)
    st = licence.status(NOW, p, product="pos")
    assert st["mode"] == "expired" and st["untrusted"] == "signature" and "couldn't be checked" in st["message"]
    assert licence.status(NOW, p, product="basic")["mode"] == "expired"     # nothing in an edited licence counts
    # only the unsigned copy (for older programs) edited: ignored, the signed one decides
    p = pc()
    edit(p, lambda d: d["online"]["modules"].update(pos={"status": "active", "active": True}))
    assert licence.status(NOW, p, product="pos")["mode"] == "expired"


def test_signed_with_a_different_key_is_locked(key, pc):
    p = pc(signed=sign(key=OTHER))
    assert licence.status(NOW, p, product="basic")["untrusted"] == "signature"


def test_copied_to_another_pc_is_locked(key, pc):
    p = pc(device="33333333-3333-4333-8333-333333333333")
    assert licence.status(NOW, p, product="basic")["untrusted"] == "device"
    p = pc(ws="44444444-4444-4444-8444-444444444444")
    assert licence.status(NOW, p, product="basic")["untrusted"] == "business"


def test_expired_is_locked(key, pc):
    p = pc()
    assert licence.status(NOW + timedelta(days=29), p, product="basic")["mode"] == "licensed"
    st = licence.status(NOW + timedelta(days=31), p, product="basic")
    assert st["mode"] == "expired" and st["untrusted"] == "expired"


def test_clock_moved_back_is_locked(key, pc, tmp_path):
    p = pc()
    assert licence.status(NOW + timedelta(days=20), p, product="basic")["mode"] == "licensed"
    assert licence.status(NOW + timedelta(days=19), p, product="basic")["mode"] == "licensed"   # within 48 hours
    st = licence.status(NOW + timedelta(days=5), p, product="basic")
    assert st["untrusted"] == "clock" and "clock" in st["message"]
    os.remove(os.path.join(os.path.dirname(p), S.MARKER))      # the marker in Accounting's own folder still remembers
    assert licence.status(NOW + timedelta(days=5), p, product="basic")["untrusted"] == "clock"
    assert licence.status(NOW - timedelta(days=3), pc(), product="basic")["untrusted"] == "clock"   # before it was issued


def test_untrusted_licence_on_a_pc_that_had_a_real_one_gets_no_new_trial(key, pc):
    p = pc()
    licence.status(NOW, p, product="basic")
    edit(p, lambda d: d["online"]["signed"].update(expires_at="2099-01-01T00:00:00.000Z"))
    assert licence.status(NOW, p, product="basic")["mode"] == "expired"


def test_transition_no_key_built_in_works_as_before(pc):
    p = pc(signed=None)
    assert licence.status(NOW, p, product="basic")["mode"] == "licensed"


def test_transition_older_central_gets_14_days_then_locked(key, pc):
    p = pc(signed=None)
    st = licence.status(NOW, p, product="basic")
    assert st["mode"] == "licensed" and st["message"] == "Update Riyeser Central to keep your plan up to date."
    edit(p, lambda d: d["online"].update(checkedAt=iso(NOW + timedelta(days=13))))
    assert licence.status(NOW + timedelta(days=13), p, product="basic")["mode"] == "licensed"
    st = licence.status(NOW + timedelta(days=15), p, product="basic")
    assert st["mode"] == "expired" and st["untrusted"] == "unsigned" and "Update Riyeser Central" in st["message"]


def test_key_licence_file_no_longer_unlocks_once_signed(key, tmp_path):
    f = tmp_path / "licence.json"
    f.write_text(json.dumps({"trialStart": "2020-01-01T00:00:00Z", "key": "ABCD-EFGH", "licence": {"status": "active", "checkedAt": iso(NOW)}}))
    assert licence.status(NOW, str(f), product="basic")["mode"] == "expired"
    S.use_key_for_tests("")
    assert licence.status(NOW, str(f), product="basic")["mode"] == "licensed"   # before signing: as it was


# ---------- the local trial ----------
def test_local_trial_earlier_date_wins_and_deleting_licence_json_does_not_restart_it(tmp_path):
    f = tmp_path / "licence.json"
    f.write_text(json.dumps({"trialStart": iso(NOW - timedelta(days=100))}))
    assert licence.status(NOW, str(f))["mode"] == "expired"
    f.unlink()
    assert licence.status(NOW, str(f))["mode"] == "expired"
    assert json.load(open(f))["trialStart"].startswith("2026-08-16")     # put back from the marker
    f.write_text(json.dumps({"trialStart": iso(NOW)}))                    # a later date written in
    assert licence.status(NOW, str(f))["mode"] == "expired"


def test_local_trial_clock_back_gives_no_days_back(tmp_path):
    f = tmp_path / "licence.json"
    f.write_text(json.dumps({"trialStart": iso(NOW)}))
    assert licence.status(NOW + timedelta(days=80), str(f))["days_left"] == 10
    assert licence.status(NOW + timedelta(days=10), str(f))["days_left"] == 10


def test_markers_are_shared_with_the_javascript_programs(tmp_path):
    """A marker Central wrote (milliseconds, ISO dates) reads the same here, and the other way round."""
    rd = tmp_path / "Riyeser"
    rd.mkdir()
    (rd / S.MARKER).write_text(json.dumps({"firstRun": "2026-01-01T00:00:00.000Z", "linked": False, "unsignedSince": None,
                                           "clock": {"issued": "", "latest": int((NOW + timedelta(days=3)).timestamp() * 1000)}}))
    t = S.local_trial(str(rd), None, NOW)
    assert datetime.fromtimestamp(t["start"], timezone.utc) == datetime(2026, 1, 1, tzinfo=timezone.utc)
    m = json.load(open(rd / S.MARKER))
    assert m["firstRun"] == "2026-01-01T00:00:00.000Z" and isinstance(m["clock"]["latest"], int)


# ---------- in the apps: the locked banner, and new work refused ----------
def test_pos_app_locked_banner_says_what_is_locked_what_works_the_price_and_the_button(tmp_path, monkeypatch):
    from tests.test_pos_app import make, sell
    app, c, item = make(tmp_path, monkeypatch, "pos")
    (tmp_path / "appdata" / "Riyeser").mkdir(parents=True, exist_ok=True)
    (tmp_path / "appdata" / "Riyeser" / "licence.json").write_text(json.dumps({"trialStart": iso(datetime.now(timezone.utc) - timedelta(days=95))}))
    r = sell(c, item)
    assert r.status_code == 402 and "new sales are paused" in r.get_json()["error"] and "US$29/month" in r.get_json()["error"]
    page = c.get("/pos/").get_data(as_text=True)
    assert "New sales are paused." in page and "are all still here" in page and "US$29/month" in page
    assert 'href="https://riyeser.com/link/"' in page and "Open Riyeser home" in page
    assert c.get("/pos/sales").status_code == 200   # past sales stay viewable


def test_basics_app_with_an_edited_licence_stops_new_invoices(tmp_path, monkeypatch, key):
    from tests.test_pos_app import make
    app, c, item = make(tmp_path, monkeypatch, "basics")
    rd = tmp_path / "appdata" / "Riyeser"
    rd.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    s = sign(dict(PLAN, modules={"basic": {"status": "ended", "active": False, "trial_ends": "2026-01-01", "paid_until": None, "days_left": 0}}), issued=now)
    s["licence"]["modules"]["basic"] = {"status": "active", "active": True, "paid_until": "2099-01-01"}   # switched on by hand
    (rd / "company.json").write_text(json.dumps({"mode": "online", "name": "Corner Shop", "workspace_id": WS}))
    (rd / "device.json").write_text(json.dumps({"id": DEV}))
    (rd / "licence.json").write_text(json.dumps({"trialStart": iso(now - timedelta(days=200)), "online": dict(s["licence"], checkedAt=iso(now), signed=s)}))
    with app.app_context():
        assert licence.status(product="basic")["untrusted"] == "signature"
        assert P.plan(get_db_(), "basic")["locked"]
    page = c.get("/", follow_redirects=True).get_data(as_text=True)
    assert "couldn&#39;t be checked" in page and "New invoices are paused." in page and "Open Riyeser home" in page


def get_db_():
    from riyeser.db import get_db
    return get_db()
