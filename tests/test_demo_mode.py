"""Riyeser Central's demo mode: a separate demo folder with a ready-made demo company, shared by every program."""
import json
import os
import sqlite3

import pytest

from riyeser import create_app, demo_mode
from riyeser.db import get_db
from riyeser.demo import DEMO_STAFF

BANNER = "Leave demo mode from Riyeser Central."


def set_demo(tmp_path, on):
    p = tmp_path / "appdata" / "Riyeser" / "demo.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"on": on, "since": "2026-11-24T09:00:00Z", "business": "Sample Trading Co"}))
    return p


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))  # no licence file, no company profile
    monkeypatch.setenv("RIYESER_DEMO_FILE", str(tmp_path / "appdata" / "Riyeser" / "demo.json"))
    monkeypatch.delenv("RIYESER_APP_EDITION", raising=False)
    (tmp_path / "data").mkdir()
    return tmp_path


def app_for(tmp_path, monkeypatch, edition=None):
    if edition:
        monkeypatch.setenv("RIYESER_APP_EDITION", edition)
    else:
        monkeypatch.delenv("RIYESER_APP_EDITION", raising=False)
    return create_app({"TESTING": True, "DATABASE": str(tmp_path / "data" / "company.db")})


def q(path, sql, args=()):
    con = sqlite3.connect(path)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


# ---------------------------------------------------------------- the small helper module

def test_demo_json_decides(tmp_path, monkeypatch):
    f = tmp_path / "demo.json"
    monkeypatch.setenv("RIYESER_DEMO_FILE", str(f))
    normal = str(tmp_path / "data")
    assert not demo_mode.demo_on() and demo_mode.data_dir(normal) == normal           # no file: normal mode
    f.write_text("{not json")
    assert not demo_mode.demo_on() and demo_mode.data_dir(normal) == normal           # damaged: normal mode
    f.write_text(json.dumps({"on": False}))
    assert not demo_mode.demo_on()
    assert demo_mode.db_path(os.path.join(normal, "company.db")) == os.path.join(normal, "company.db")
    f.write_text(json.dumps({"on": True, "since": "2026-11-24T09:00:00Z", "business": "Sample Trading Co"}))
    assert demo_mode.demo_on()
    assert demo_mode.data_dir(normal) == os.path.join(normal, "demo")
    assert demo_mode.db_path(os.path.join(normal, "company.db")) == os.path.join(normal, "demo", "company.db")


def test_demo_json_lives_with_company_and_licence(monkeypatch, tmp_path):
    from riyeser import company_profile, licence
    monkeypatch.delenv("RIYESER_DEMO_FILE")
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert demo_mode.demo_file() == os.path.join(str(tmp_path), "Riyeser", "demo.json")
    assert os.path.dirname(demo_mode.demo_file()) == os.path.dirname(company_profile.profile_file()) \
        == os.path.dirname(licence.licence_file())


# ---------------------------------------------------------------- normal mode is as before

def test_no_demo_json_uses_the_normal_folder(env, monkeypatch):
    app = app_for(env, monkeypatch)
    c = app.test_client()
    assert app.config["DATABASE"] == str(env / "data" / "company.db") and not app.config["DEMO_MODE"]
    page = c.get("/login", follow_redirects=True).get_data(as_text=True)
    assert "Demo mode: sign in" not in page
    c.post("/setup", data={"name": "My Real Books", "password": "secret12"})
    assert q(env / "data" / "company.db", "SELECT name, is_demo FROM company") == [("My Real Books", 0)]
    assert not (env / "data" / "demo").exists()
    assert c.get("/").status_code == 302                       # no automatic sign-in for real books
    c.post("/login", data={"username": "admin", "password": "secret12"})
    assert BANNER not in c.get("/").get_data(as_text=True)


# ---------------------------------------------------------------- demo mode

def test_demo_on_makes_a_ready_demo_company(env, monkeypatch):
    set_demo(env, True)
    app = app_for(env, monkeypatch)
    demo_db = env / "data" / "demo" / "company.db"
    assert app.config["DATABASE"] == str(demo_db) and demo_db.exists()
    assert q(demo_db, "SELECT name, is_demo FROM company") == [("Sample Trading Co (demo)", 1)]
    assert q(demo_db, "SELECT role FROM users WHERE username='demo'") == [("admin",)]
    c = app.test_client()
    page = c.get("/", follow_redirects=True).get_data(as_text=True)   # signed in as demo straight away
    assert "Demo company: practice data, not real books." in page and BANNER in page
    assert "Start again with a blank company" not in page            # the way out is Central
    assert c.get("/setup").status_code == 302
    r = c.post("/companies/start-again", data={"confirm_name": "Sample Trading Co (demo)", "reason": "test"})
    assert r.status_code == 302 and q(demo_db, "SELECT is_demo FROM company") == [(1,)]
    # signing out shows the demo sign-in, which works
    c.get("/logout")
    page = c.get("/login").get_data(as_text=True)
    assert "Demo mode: sign in with <b>demo</b> / <b>demo</b>" in page
    assert c.get("/").status_code == 302                              # not signed straight back in
    c.post("/login", data={"username": "demo", "password": "demo"})
    assert BANNER in c.get("/").get_data(as_text=True)
    # nothing at all was written to the normal folder
    assert sorted(os.listdir(env / "data")) == ["demo"]


def test_demo_staff_match_payroll(env, monkeypatch):
    set_demo(env, True)
    app_for(env, monkeypatch)
    names = q(env / "data" / "demo" / "company.db", "SELECT first_name, last_name, email FROM employees ORDER BY id")
    assert names == [(s["first_name"], s["last_name"], s["email"]) for s in DEMO_STAFF]
    assert all(e.endswith(".example") for _, _, e in names)


def test_one_shared_demo_folder_seeded_once(env, monkeypatch):
    set_demo(env, True)
    app_for(env, monkeypatch, "bookings")                            # whichever opens first makes it
    demo_db = env / "data" / "demo" / "company.db"
    before = q(demo_db, "SELECT COUNT(*) FROM contacts")[0][0], q(demo_db, "SELECT COUNT(*) FROM bookings")[0][0]
    for ed in ("pos", "invoices", "basics", "plus"):
        app = app_for(env, monkeypatch, ed)
        assert app.config["DATABASE"] == str(demo_db)
    assert (q(demo_db, "SELECT COUNT(*) FROM contacts")[0][0], q(demo_db, "SELECT COUNT(*) FROM bookings")[0][0]) == before
    assert sorted(os.listdir(env / "data")) == ["demo"]


def test_bookings_demo_has_staff_services_and_bookings(env, monkeypatch):
    set_demo(env, True)
    app = app_for(env, monkeypatch, "bookings")
    c = app.test_client()
    demo_db = env / "data" / "demo" / "company.db"
    staff = [r[0] for r in q(demo_db, "SELECT name FROM booking_resources ORDER BY id")]
    assert staff[0] == "Staff 1" and "Jamie Example" in staff                # the suggested staff, and two technicians
    assert {r[0] for r in q(demo_db, "SELECT name FROM booking_services")} >= {"Call-out", "Half day", "Full day"}
    assert q(demo_db, "SELECT COUNT(*) FROM bookings")[0][0] >= 5
    page = c.get("/bookings/week", follow_redirects=True).get_data(as_text=True)
    assert "Riyeser Bookings" in page and BANNER in page and "Jamie Example" in page


def test_bookings_job_invoice_shows_in_accounting(env, monkeypatch):
    set_demo(env, True)
    app = app_for(env, monkeypatch, "bookings")
    c = app.test_client()
    c.get("/")
    demo_db = env / "data" / "demo" / "company.db"
    bid = q(demo_db, "SELECT id FROM bookings ORDER BY starts_at")[0][0]
    assert "Invoice made" in c.post(f"/bookings/{bid}/invoice", follow_redirects=True).get_data(as_text=True)
    doc = q(demo_db, "SELECT j.document_id FROM bookings b JOIN booking_jobs j ON j.id=b.job_id WHERE b.id=?", (bid,))[0][0]
    number, ref = q(demo_db, "SELECT number, reference FROM documents WHERE id=?", (doc,))[0]
    acc = app_for(env, monkeypatch, "plus").test_client()
    page = acc.get(f"/document/{doc}", follow_redirects=True).get_data(as_text=True)
    assert number in page and ref in page and BANNER in page
    assert number in acc.get("/sale/list?status=all").get_data(as_text=True) \
        or number in acc.get("/sale/list").get_data(as_text=True)


def test_pos_demo_has_items_and_a_sale_shows_in_accounting(env, monkeypatch):
    set_demo(env, True)
    app = app_for(env, monkeypatch, "pos")
    c = app.test_client()
    page = c.get("/", follow_redirects=True).get_data(as_text=True)
    assert "Flat White" in page and BANNER in page and "Start again with a blank company" not in page
    demo_db = env / "data" / "demo" / "company.db"
    item = q(demo_db, "SELECT id FROM items WHERE sku='CAF-FW'")[0][0]
    assert q(demo_db, "SELECT COUNT(*) FROM items WHERE is_sold=1 AND active=1")[0][0] >= 10
    r = c.post("/pos/sale", json={"method": "card", "lines": [{"item_id": item, "qty": 2}]}).get_json()
    assert r["ok"]
    doc, number = q(demo_db, "SELECT d.id, d.number FROM pos_sales p JOIN documents d ON d.id=p.document_id"
                             " WHERE p.id=?", (r["sale_id"],))[0]
    acc = app_for(env, monkeypatch, "basics").test_client()
    page = acc.get(f"/document/{doc}", follow_redirects=True).get_data(as_text=True)
    assert number in page and "Flat White" in page


# ---------------------------------------------------------------- leaving demo mode

def test_demo_off_goes_back_to_the_real_books(env, monkeypatch):
    real = env / "data" / "company.db"
    app = app_for(env, monkeypatch)                                    # real books made first, in normal mode
    app.test_client().post("/setup", data={"name": "My Real Books", "password": "secret12"})
    before = real.read_bytes()
    set_demo(env, True)
    demo = app_for(env, monkeypatch, "plus")
    c = demo.test_client()
    c.get("/")
    assert real.read_bytes() == before                                 # demo never opened the real file
    set_demo(env, False)
    page = c.get("/").get_data(as_text=True)                           # still open when demo turns off
    assert "Demo mode has ended" in page and "open it again" in page
    # Central sets the demo folder aside, then the program is opened again
    os.replace(env / "data" / "demo", env / "data" / "demo-ended-20261124T090000Z")
    app = app_for(env, monkeypatch, "plus")
    assert app.config["DATABASE"] == str(real) and not app.config["DEMO_MODE"]
    c = app.test_client()
    assert c.get("/").status_code == 302                               # real books: sign in as usual
    c.post("/login", data={"username": "admin", "password": "secret12"})
    page = c.get("/").get_data(as_text=True)
    assert "Demo company" not in page and BANNER not in page
    assert q(real, "SELECT name, is_demo FROM company") == [("My Real Books", 0)]
    assert q(env / "data" / "demo-ended-20261124T090000Z" / "company.db", "SELECT is_demo FROM company") == [(1,)]


def test_demo_folder_moved_aside_while_closed_starts_a_fresh_demo(env, monkeypatch):
    set_demo(env, True)
    app_for(env, monkeypatch)
    os.replace(env / "data" / "demo", env / "data" / "demo-ended-1")
    app = app_for(env, monkeypatch)
    assert (env / "data" / "demo" / "company.db").exists()
    assert BANNER in app.test_client().get("/", follow_redirects=True).get_data(as_text=True)
    assert (env / "data" / "demo-ended-1" / "company.db").exists()     # the old one is kept


def test_cli_init_ignores_demo_mode(env, monkeypatch):
    from riyeser.cli import main
    set_demo(env, True)
    monkeypatch.setenv("RIYESER_DB", str(env / "data" / "company.db"))  # restored after the test
    monkeypatch.setenv("RIYESER_SECRET", "x")
    main(["--data-dir", str(env / "data"), "--db", str(env / "data" / "company.db"), "init", "--name", "Real Co"])
    assert q(env / "data" / "company.db", "SELECT name, is_demo FROM company") == [("Real Co", 0)]
    assert not (env / "data" / "demo").exists()
