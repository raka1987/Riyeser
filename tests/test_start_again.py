"""Blank by default, demo only by choice, and "Start again" with a locked archive copy and a chained log."""
import hashlib
import json
import os
import re
import sqlite3
import stat

import pytest
from werkzeug.security import generate_password_hash

from riyeser import create_app
from riyeser import archive as ar
from riyeser.db import get_db, init_db
from riyeser.demo import seed_demo

WARNING = "⚠ Something has changed. Don't start again or delete anything. Keep this computer and its files as they are, and get advice."


@pytest.fixture(autouse=True)
def _writable_archives(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))  # no company profile or licence from this computer
    yield
    for root, _dirs, files in os.walk(tmp_path):  # archive copies are read-only: let pytest tidy up the temp folder
        for f in files:
            p = os.path.join(root, f)
            os.chmod(p, os.stat(p).st_mode | stat.S_IWUSR)


@pytest.fixture
def app(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "company.db")})
    with app.app_context():
        init_db("Sample Plumbing Pty Ltd")
        db = get_db()
        seed_demo(db)
        # real details typed in by the owner, and a second user who must still be able to sign in afterwards
        db.execute("UPDATE company SET is_demo=0, abn='11 222 333 444', address='1 Test Lane, Exampleton NSW 2999',"
                   " phone='02 5550 0000', email='office@sample-plumbing.example', fy_start_month=7, invoice_prefix='SP'")
        db.execute("INSERT INTO users (username, password_hash, full_name, role, perms) VALUES (?,?,?,?,?)",
                   ("casey", generate_password_hash("casey-pass"), "Casey Example", "accountant", '{"sales": 2}'))
        db.execute("INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)",
                   ("vic", generate_password_hash("vic-pass"), "Vic Viewer", "viewer"))
        db.commit()
    return app


def login(app, user="admin", pw="admin"):
    c = app.test_client()
    r = c.post("/login", data={"username": user, "password": pw})
    assert r.status_code == 302 and "/login" not in r.location, r.location
    return c


def q(path, sql, args=()):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def folder(tmp_path):
    return tmp_path / "archive"


def ledger_lines(tmp_path):
    p = folder(tmp_path) / "ledger.jsonl"
    return p.read_bytes().split(b"\n")[:-1] if p.exists() else []


def reset(c, name="Sample Plumbing Pty Ltd", pw="admin", reason="Testing"):
    return c.post("/companies/start-again", data={"password": pw, "confirm_name": name, "reason": reason},
                  follow_redirects=True)


# ---------------------------------------------------------------- blank by default, demo by choice

def test_setup_starts_blank_by_default(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "company.db")})
    c = app.test_client()
    page = c.get("/setup").get_data(as_text=True)
    assert "Start blank (recommended)" in page and "Explore with demo data" in page
    assert re.search(r'name="start" value="blank" checked', page) and 'type="checkbox" name="demo"' not in page
    c.post("/setup", data={"name": "Blank Test Pty Ltd", "password": "pass1234", "start": "blank"})
    db = str(tmp_path / "company.db")
    assert q(db, "SELECT COUNT(*) FROM contacts")[0][0] == 0
    assert q(db, "SELECT COUNT(*) FROM documents")[0][0] == 0
    assert q(db, "SELECT is_demo FROM company")[0][0] == 0
    assert q(db, "SELECT COUNT(*) FROM accounts")[0][0] > 20 and q(db, "SELECT COUNT(*) FROM tax_codes")[0][0] > 3
    home = login(app, pw="pass1234").get("/").get_data(as_text=True)
    assert "Demo company" not in home


def test_demo_setup_has_data_and_the_banner(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "company.db")})
    app.test_client().post("/setup", data={"name": "Demo Test Pty Ltd", "password": "pass1234", "start": "demo"})
    db = str(tmp_path / "company.db")
    assert q(db, "SELECT COUNT(*) FROM contacts")[0][0] > 0 and q(db, "SELECT COUNT(*) FROM documents")[0][0] > 0
    assert q(db, "SELECT is_demo FROM company")[0][0] == 1
    c = login(app, pw="pass1234")
    for url in ("/", "/companies/", "/cards/customer"):
        page = c.get(url).get_data(as_text=True)
        assert "Demo company: practice data, not real books." in page, url
        assert "Start again with a blank company" in page
    # a blank start again clears the banner and the demo's made-up details
    assert "Started again" in reset(c, "Demo Test Pty Ltd", "pass1234").get_data(as_text=True)
    assert "Demo company" not in c.get("/").get_data(as_text=True)
    assert q(db, "SELECT is_demo, abn, email FROM company")[0] == (0, None, None)


def test_added_company_is_blank_unless_demo_is_picked(app, tmp_path):
    c = login(app)
    assert "Explore with demo data" in c.get("/companies/").get_data(as_text=True)
    c.post("/companies/add", data={"name": "Blank Two Pty Ltd", "start": "blank"})
    c.post("/companies/add", data={"name": "Demo Two Pty Ltd", "start": "demo"})
    reg = json.loads((tmp_path / "companies.json").read_text())
    files = {q(str(tmp_path / r["file"]), "SELECT name FROM company")[0][0]: str(tmp_path / r["file"]) for r in reg}
    assert q(files["Blank Two Pty Ltd"], "SELECT COUNT(*), (SELECT is_demo FROM company) FROM documents")[0] == (0, 0)
    n, demo = q(files["Demo Two Pty Ltd"], "SELECT COUNT(*), (SELECT is_demo FROM company) FROM documents")[0]
    assert n > 0 and demo == 1


def test_bookings_start_with_nothing_and_suggestions_on_request(tmp_path, monkeypatch):
    from tests.test_pos_app import make
    app, c, item = make(tmp_path, monkeypatch, "bookings")
    for url in ("/bookings/", "/bookings/week", "/bookings/list", "/bookings/jobs", "/bookings/new", "/bookings/job/new",
                "/bookings/setup"):
        r = c.get(url)
        assert r.status_code == 200, url
    page = c.get("/bookings/setup").get_data(as_text=True)
    assert "Add suggested staff and services for trades &amp; site jobs" in page
    assert "No staff yet" in c.get("/bookings/").get_data(as_text=True)
    assert "Add them in Bookings setup" in c.get("/bookings/new").get_data(as_text=True)
    db = str(tmp_path / "t.db")
    assert q(db, "SELECT (SELECT COUNT(*) FROM booking_resources), (SELECT COUNT(*) FROM booking_services)")[0] == (0, 0)
    r = c.post("/bookings/setup/starters", follow_redirects=True)
    assert "Added 4 suggestions" in r.get_data(as_text=True)
    assert [x[0] for x in q(db, "SELECT name FROM booking_resources")] == ["Staff 1"]
    assert {x[0] for x in q(db, "SELECT name FROM booking_services")} == {"Call-out", "Half day", "Full day"}
    c.post("/bookings/setup/starters")  # pressing again adds nothing more
    assert q(db, "SELECT COUNT(*) FROM booking_services")[0][0] == 3
    assert "Add suggested" not in c.get("/bookings/setup").get_data(as_text=True)


# ---------------------------------------------------------------- who may start again

@pytest.mark.parametrize("user,pw", [("casey", "casey-pass"), ("vic", "vic-pass")])
def test_only_an_administrator(app, tmp_path, user, pw):
    c = login(app, user, pw)
    data = {"password": pw, "confirm_name": "Sample Plumbing Pty Ltd"}
    assert c.post("/companies/start-again", data=data).status_code == 403
    assert c.post("/companies/start-everything-again", data=data).status_code == 403
    assert c.get("/companies/archives").status_code == 403
    assert "Start again" not in c.get("/companies/").get_data(as_text=True)
    assert not folder(tmp_path).exists()
    assert q(str(tmp_path / "company.db"), "SELECT COUNT(*) FROM documents")[0][0] > 0


@pytest.mark.parametrize("pw,name", [("wrong", "Sample Plumbing Pty Ltd"), ("admin", "sample plumbing"), ("admin", "")])
def test_wrong_password_or_name_changes_nothing(app, tmp_path, pw, name):
    db = str(tmp_path / "company.db")
    before = q(db, "SELECT COUNT(*) FROM documents")[0][0]
    c = login(app)
    page = reset(c, name, pw).get_data(as_text=True)
    assert "Nothing has been changed" in page
    page = c.post("/companies/start-everything-again", data={"password": pw, "confirm_name": name},
                  follow_redirects=True).get_data(as_text=True)
    assert "Nothing has been changed" in page
    assert q(db, "SELECT COUNT(*) FROM documents")[0][0] == before
    assert not folder(tmp_path).exists()


# ---------------------------------------------------------------- start again

def test_start_again_archives_then_blanks_in_place(app, tmp_path):
    db = str(tmp_path / "company.db")
    users = q(db, "SELECT * FROM users ORDER BY id")
    audits = q(db, "SELECT id, at, user_id, action, details FROM audit_log ORDER BY id")
    invoices = q(db, "SELECT COUNT(*) FROM documents")[0][0]
    assert invoices > 0
    ino = os.stat(db).st_ino
    other = sqlite3.connect(db)  # someone else has the file open (on Windows it can't be replaced)
    assert other.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == invoices
    c = login(app)
    page = c.get("/companies/").get_data(as_text=True)
    assert "Your current records are saved as a locked archive copy first. Nothing is deleted." in page
    assert "Type Sample Plumbing Pty Ltd to confirm" in page and "Your password" in page and "Reason (optional)" in page
    assert "data-confirm=\"Start Sample Plumbing Pty Ltd again?" in page
    page = reset(c, reason="Starting the real books").get_data(as_text=True)
    assert "Your old records are saved as a locked archive copy" in page
    # the archive copy: read-only, fingerprint in the log, still holds the old invoices
    copies = sorted(folder(tmp_path).glob("*.db"))
    assert len(copies) == 1 and re.fullmatch(r"main-\d{8}-\d{6}\.db", copies[0].name)
    assert stat.S_IMODE(os.stat(copies[0]).st_mode) == 0o444
    [line] = ledger_lines(tmp_path)
    e = json.loads(line)
    assert set(e) == {"at", "program", "company_id", "company_name", "file", "sha256", "bytes", "by", "reason", "prev"}
    assert e["program"] == "accounting" and e["company_id"] == "main" and e["company_name"] == "Sample Plumbing Pty Ltd"
    assert e["by"] == "admin" and e["reason"] == "Starting the real books" and e["prev"] == "genesis"
    assert e["file"] == copies[0].name and e["bytes"] == os.path.getsize(copies[0])
    assert e["sha256"] == hashlib.sha256(copies[0].read_bytes()).hexdigest()
    assert q(str(copies[0]), "SELECT COUNT(*) FROM documents")[0][0] == invoices
    head = hashlib.sha256(line).hexdigest()
    assert json.loads((folder(tmp_path) / "head.json").read_text())["head"] == head
    assert q(db, "SELECT value FROM archive_meta WHERE key='ledger_head'")[0][0] == head
    # the live company: same file, blank, details and users kept, history kept plus the new row
    assert os.stat(db).st_ino == ino and not list(tmp_path.glob("*.fresh-*"))
    assert other.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
    other.close()
    for table in ("documents", "contacts", "journal_lines", "items", "payments", "employees"):
        assert q(db, f"SELECT COUNT(*) FROM {table}")[0][0] == 0, table
    assert q(db, "SELECT COUNT(*) FROM accounts")[0][0] > 20
    comp = q(db, "SELECT name, abn, address, phone, email, invoice_prefix, next_invoice_no, is_demo FROM company")[0]
    assert comp == ("Sample Plumbing Pty Ltd", "11 222 333 444", "1 Test Lane, Exampleton NSW 2999", "02 5550 0000",
                    "office@sample-plumbing.example", "SP", 1, 0)
    assert q(db, "SELECT * FROM users ORDER BY id") == users
    after = q(db, "SELECT id, at, user_id, action, details FROM audit_log ORDER BY id")
    assert after[:len(audits)] == audits
    new = after[len(audits):]
    assert new[-1][3] == "start_again" and e["file"] in new[-1][4] and e["sha256"] in new[-1][4]
    assert [r[3] for r in new[:-1]] == ["login"]  # only the sign-in above happened in between
    # everyone can still sign in, and the admin carries on
    assert "$0.00" in c.get("/").get_data(as_text=True)
    login(app, "casey", "casey-pass")
    login(app, "vic", "vic-pass")
    # the check finds it unchanged
    page = c.get("/companies/archives").get_data(as_text=True)
    assert "All 1 archived copy is unchanged." in page and "Unchanged" in page and WARNING not in page
    assert "Starting the real books" in c.get("/companies/").get_data(as_text=True)


def test_second_start_again_chains_the_log(app, tmp_path):
    c = login(app)
    reset(c, reason="first")
    c.post("/cards/customer/new", data={"name": "Second Round Customer", "active": "1"})
    reset(c, reason="second")
    lines = ledger_lines(tmp_path)
    assert len(lines) == 2
    first, second = (json.loads(x) for x in lines)
    assert first["prev"] == "genesis" and second["prev"] == hashlib.sha256(lines[0]).hexdigest()
    assert first["file"] != second["file"] and len(list(folder(tmp_path).glob("*.db"))) == 2
    assert q(str(folder(tmp_path) / second["file"]), "SELECT name FROM contacts")[0][0] == "Second Round Customer"
    assert "All 2 archived copies are unchanged." in c.get("/companies/archives").get_data(as_text=True)


def _move_out(p, tmp_path):
    os.replace(p, tmp_path / ("moved-" + p.name))  # an intruder moves it away (the test doesn't delete it either)


@pytest.mark.parametrize("how", ["archive_byte", "missing_file", "middle_line", "newest_line", "head_file"])
def test_tampering_is_found(app, tmp_path, how):
    c = login(app)
    for reason in ("one", "two", "three"):
        reset(c, reason=reason)
    lines = ledger_lines(tmp_path)
    entries = [json.loads(x) for x in lines]
    led = folder(tmp_path) / "ledger.jsonl"
    if how == "archive_byte":
        p = folder(tmp_path) / entries[0]["file"]
        os.chmod(p, 0o644)
        data = bytearray(p.read_bytes())
        data[-1] ^= 1
        p.write_bytes(bytes(data))
        want, row = ar.CHANGED, 0
    elif how == "missing_file":
        _move_out(folder(tmp_path) / entries[1]["file"], tmp_path)
        want, row = ar.MISSING, 1
    elif how == "middle_line":
        lines[1] = lines[1].replace(b'"reason": "two"', b'"reason": "tw0"')
        led.write_bytes(b"\n".join(lines) + b"\n")
        want, row = ar.ALTERED, 1
    elif how == "newest_line":
        lines[2] = lines[2].replace(b'"reason": "three"', b'"reason": "thr3e"')
        led.write_bytes(b"\n".join(lines) + b"\n")
        want, row = ar.ALTERED, 2
    else:  # the newest line and head.json changed together: the copy of the head in company.db still tells
        lines[2] = lines[2].replace(b'"reason": "three"', b'"reason": "thr3e"')
        led.write_bytes(b"\n".join(lines) + b"\n")
        (folder(tmp_path) / "head.json").write_text(json.dumps({"head": hashlib.sha256(lines[2]).hexdigest(), "lines": 3}))
        want, row = ar.ALTERED, 2
    res = ar.check(str(tmp_path), str(tmp_path / "company.db"))
    statuses = [r["status"] for r in reversed(res["rows"])]  # oldest first
    assert statuses[row] == want, statuses
    assert [s for i, s in enumerate(statuses) if i != row] == [ar.UNCHANGED, ar.UNCHANGED]
    assert not res["ok"]
    page = c.get("/companies/archives").get_data(as_text=True)
    assert WARNING in page and want in page and "1 of 3 archived copies need attention." in page


# ---------------------------------------------------------------- start everything again

def test_start_everything_again_across_two_companies(app, tmp_path):
    c = login(app)
    r = c.post("/companies/add", data={"name": "Second Example Pty Ltd", "start": "demo"})
    c.get(r.location)
    reg = json.loads((tmp_path / "companies.json").read_text())
    second = str(tmp_path / reg[0]["file"])
    second_docs = q(second, "SELECT COUNT(*) FROM documents")[0][0]
    assert second_docs > 0
    page = c.post("/companies/start-everything-again",
                  data={"password": "admin", "confirm_name": "Second Example Pty Ltd", "reason": "everything"},
                  follow_redirects=True).get_data(as_text=True)
    assert "Everything has started again" in page
    entries = [json.loads(x) for x in ledger_lines(tmp_path)]
    assert sorted(e["company_id"] for e in entries) == sorted(["main", reg[0]["id"]])
    assert entries[1]["prev"] == hashlib.sha256(ledger_lines(tmp_path)[0]).hexdigest()
    by_id = {e["company_id"]: e for e in entries}
    assert q(str(folder(tmp_path) / by_id["main"]["file"]), "SELECT COUNT(*) FROM documents")[0][0] > 0
    assert q(str(folder(tmp_path) / by_id[reg[0]["id"]]["file"]), "SELECT COUNT(*) FROM documents")[0][0] == second_docs
    # main is blank (in place); the other is archived, its file kept as it was
    assert q(str(tmp_path / "company.db"), "SELECT COUNT(*) FROM documents")[0][0] == 0
    assert json.loads((tmp_path / "companies.json").read_text())[0]["archived"] is True
    assert q(second, "SELECT COUNT(*) FROM documents")[0][0] == second_docs
    assert "Sample Plumbing Pty Ltd" in c.get("/").get_data(as_text=True)
    assert "All 2 archived copies are unchanged." in c.get("/companies/archives").get_data(as_text=True)


def test_start_everything_needs_admin_in_every_company(app, tmp_path):
    c = login(app)
    c.post("/companies/add", data={"name": "Not Mine Pty Ltd"})
    reg = json.loads((tmp_path / "companies.json").read_text())
    con = sqlite3.connect(str(tmp_path / reg[0]["file"]))
    con.execute("UPDATE users SET role='accountant' WHERE username='admin'")
    con.commit()
    con.close()
    page = c.post("/companies/start-everything-again",
                  data={"password": "admin", "confirm_name": "Sample Plumbing Pty Ltd"},
                  follow_redirects=True).get_data(as_text=True)
    assert "administrator in every company" in page
    assert not folder(tmp_path).exists()


# ---------------------------------------------------------------- nothing is ever deleted

def test_archive_folder_only_grows(app, tmp_path):
    c = login(app)
    seen, log = set(), b""
    steps = [lambda: reset(c, reason="a"), lambda: c.get("/companies/archives"), lambda: reset(c, reason="b"),
             lambda: c.post("/companies/add", data={"name": "Grow Test Pty Ltd"}),
             lambda: c.post("/companies/start-everything-again",
                            data={"password": "admin", "confirm_name": "Sample Plumbing Pty Ltd"}),
             lambda: c.get("/companies/archives")]
    for step in steps:
        step()
        now = {p.name for p in folder(tmp_path).iterdir()} if folder(tmp_path).exists() else set()
        assert seen <= now, seen - now
        new_log = (folder(tmp_path) / "ledger.jsonl").read_bytes() if now else b""
        assert new_log.startswith(log)
        seen, log = now, new_log
    assert len(ledger_lines(tmp_path)) == 4


def test_archive_code_has_no_way_to_delete():
    src = open(ar.__file__, encoding="utf-8").read()
    for bad in ("os.remove", "os.unlink", "rmtree", ".unlink(", "truncate", '"w"', "'w'"):
        assert bad not in src.replace('open(tmp, "w"', ""), bad
