""""Forgot password?": no reset without proof; the emailed code; the business owner's Riyeser account (a pretend
Riyeser Online / Supabase Auth on this computer)."""
import base64
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

from riyeser import create_app
from riyeser import password_reset as pr
from riyeser.db import get_db, init_db
from riyeser.views import auth as auth_view

WS = "11111111-2222-3333-4444-555555555555"


# ---------------------------------------------------------------- a pretend Riyeser Online
def jwt(o):
    return "h." + base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=") + ".s"


ACCOUNTS = {
    "owner@biz.test": {"pw": "ownerpass1", "id": "u-owner", "members": [{"workspace_id": WS, "role": "owner"}]},
    "mfa@biz.test": {"pw": "mfapass123", "id": "u-mfa", "factor": "f-1", "members": [{"workspace_id": WS, "role": "owner"}]},
    "admin@biz.test": {"pw": "adminpass1", "id": "u-admin", "members": [{"workspace_id": WS, "role": "admin"}]},
    "other@biz.test": {"pw": "otherpass1", "id": "u-other", "members": [{"workspace_id": "another-business", "role": "owner"}]},
}
CALLS = []


class FakeOnline(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, o):
        body = json.dumps(o).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _who(self):
        tok = (self.headers.get("Authorization") or "").replace("Bearer ", "")
        try:
            p = tok.split(".")[1]
            return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
        except (IndexError, ValueError):
            return None

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def _handle(self):
        n = int(self.headers.get("Content-Length") or 0)
        b = json.loads(self.rfile.read(n) or b"{}") if n else {}
        u = urlparse(self.path)
        q = parse_qs(u.query)
        CALLS.append(u.path)
        if self.headers.get("apikey") != "test-key":
            return self._send(401, {"message": "No API key found in request"})
        who = self._who()
        if u.path == "/auth/v1/token" and q.get("grant_type") == ["password"]:
            a = ACCOUNTS.get(b.get("email"))
            if not a or a["pw"] != b.get("password"):
                return self._send(400, {"error": "invalid_grant", "error_description": "Invalid login credentials"})
            factors = [{"id": a["factor"], "factor_type": "totp", "status": "verified"}] if a.get("factor") else []
            return self._send(200, {"access_token": jwt({"sub": a["id"], "aal": "aal1"}),
                                    "user": {"id": a["id"], "email": b["email"], "factors": factors}})
        m = re.match(r"^/auth/v1/factors/([^/]+)/(challenge|verify)$", u.path)
        if m and who:
            if m.group(2) == "challenge":
                return self._send(200, {"id": "ch-1"})
            if b.get("challenge_id") != "ch-1" or b.get("code") != "246810":
                return self._send(422, {"code": "mfa_verification_failed", "msg": "Invalid TOTP code entered"})
            return self._send(200, {"access_token": jwt({"sub": who["sub"], "aal": "aal2"})})
        if u.path == "/rest/v1/members" and who:
            ws = (q.get("workspace_id") or [""])[0].replace("eq.", "", 1)
            uid = (q.get("user_id") or [""])[0].replace("eq.", "", 1)
            if uid != who["sub"]:
                return self._send(200, [])
            a = next((x for x in ACCOUNTS.values() if x["id"] == who["sub"]), None)
            return self._send(200, [r for r in (a["members"] if a else []) if r["workspace_id"] == ws])
        self._send(404, {"message": "not found"})


@pytest.fixture(scope="module")
def online_url():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeOnline)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture
def mails(monkeypatch):
    sent = []
    monkeypatch.setattr(auth_view, "_deliver", lambda s, to, subject, body: sent.append((to, subject, body)))
    return sent


def make_app(tmp_path, email=True, local=True):
    tmp_path.mkdir(parents=True, exist_ok=True)
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "c.db"), "LOCAL_RESET": local})
    with app.app_context():
        init_db("Co", "admin-pass1")
        from riyeser.db import migrate
        from riyeser import mailer
        db = get_db()
        migrate(db)
        mailer.ensure(db)
        if email:
            db.execute("UPDATE company SET smtp_host='127.0.0.1', smtp_port='2525', smtp_from='books@co.test',"
                       " smtp_security='none' WHERE id=1")
        db.execute("UPDATE users SET email='boss@co.test' WHERE username='admin'")
        from werkzeug.security import generate_password_hash
        db.execute("INSERT INTO users (username, password_hash, full_name, role, email) VALUES"
                   " ('jo', ?, 'Jo Bloggs', 'accountant', 'jo@co.test')", (generate_password_hash("jo-pass-1"),))
        db.execute("INSERT INTO users (username, password_hash, role) VALUES ('noemail', ?, 'accountant')",
                   (generate_password_hash("noemail-1"),))
        db.commit()
    return app


def login(c, user, pw):
    return c.post("/login", data={"username": user, "password": pw}).status_code == 302


def code_in(mail):
    return re.search(r"password reset code: (\d{6})", mail[1]).group(1)


def audit_rows(app, action="password_reset"):
    with app.app_context():
        return [dict(r) for r in get_db().execute("SELECT * FROM audit_log WHERE action=?", (action,))]


def link_pc(tmp_path, ws=WS, name="Biz Pty Ltd", mode="online"):
    d = tmp_path / "_appdata" / "Riyeser"
    d.mkdir(parents=True, exist_ok=True)
    (d / "company.json").write_text(json.dumps({"mode": mode, "workspace_id": ws, "name": name}))


# ---------------------------------------------------------------- no proof, no reset
def test_start_page_has_no_user_list_and_no_local_reset(tmp_path):
    app = make_app(tmp_path)
    c = app.test_client()
    page = c.get("/forgot").get_data(as_text=True)
    assert "Email me a code" in page and "I'm the business owner" in page
    assert "<select" not in page and "jo" not in re.sub(r"<[^>]+>", " ", page).split()
    assert "Sign in to Riyeser Central on this PC first" in page  # not linked yet
    # the old "choose a user, type a password" post does nothing
    c.post("/forgot", data={"username": "admin", "password": "taken-over", "confirm": "taken-over"})
    assert not login(c, "admin", "taken-over") and login(app.test_client(), "admin", "admin-pass1")
    # and an owner reset without a Riyeser sign-in is refused
    r = c.post("/forgot/owner/reset", data={"user": "main:1", "password": "taken-over", "confirm": "taken-over"})
    assert r.status_code == 401 and not login(app.test_client(), "admin", "taken-over")


def test_over_the_network_it_is_ask_your_administrator(tmp_path, mails):
    app = make_app(tmp_path, local=False)
    c = app.test_client()
    page = c.get("/forgot").get_data(as_text=True)
    assert "Ask your Riyeser administrator" in page and "<form" not in page
    c.post("/forgot/email", data={"who": "jo"})
    assert mails == []
    # even in the desktop app, another computer gets the same
    app2 = make_app(tmp_path / "b")
    c2 = app2.test_client()
    page = c2.get("/forgot", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_data(as_text=True)
    assert "Ask your Riyeser administrator" in page
    c2.post("/forgot/email", data={"who": "jo"}, environ_base={"REMOTE_ADDR": "192.168.1.50"})
    assert mails == []


# ---------------------------------------------------------------- 1. the emailed code
def test_email_code_resets_once_signs_out_and_audits(tmp_path, mails):
    app = make_app(tmp_path)
    jo = app.test_client()
    assert login(jo, "jo", "jo-pass-1") and jo.get("/").status_code == 200
    # Jo's wrong passwords count up; a reset clears them
    other = app.test_client()
    for _ in range(5):
        other.post("/login", data={"username": "jo", "password": "nope-nope"})
    assert other.post("/login", data={"username": "jo", "password": "jo-pass-1"}).status_code == 429

    c = app.test_client()
    r = c.post("/forgot/email", data={"who": "JO"})
    assert r.status_code == 200 and "If that matches a person with an email address" in r.get_data(as_text=True)
    assert len(mails) == 1 and mails[0][0] == "jo@co.test"
    code = code_in(mails[0])
    with app.app_context():  # only a hash is kept, and nothing goes through the outbox
        assert code not in json.dumps([dict(x) for x in get_db().execute("SELECT * FROM password_reset_codes")])
        assert get_db().execute("SELECT COUNT(*) n FROM email_queue").fetchone()["n"] == 0
    wrong = f"{(int(code) + 1) % 1000000:06d}"
    r = c.post("/forgot/email/reset", data={"who": "jo", "code": wrong, "password": "new-jo-pass", "confirm": "new-jo-pass"})
    assert r.status_code == 400 and "isn&#39;t right, or it has expired" in r.get_data(as_text=True)
    r = c.post("/forgot/email/reset", data={"who": "jo", "code": code, "password": "short", "confirm": "short"})
    assert "at least 8 characters" in r.get_data(as_text=True)
    r = c.post("/forgot/email/reset", data={"who": "jo", "code": code, "password": "new-jo-pass", "confirm": "other-pass"})
    assert "don&#39;t match" in r.get_data(as_text=True)
    # by email address works too
    r = c.post("/forgot/email/reset", data={"who": "jo@co.test", "code": code, "password": "new-jo-pass", "confirm": "new-jo-pass"})
    assert r.status_code == 302
    # single use
    r = c.post("/forgot/email/reset", data={"who": "jo", "code": code, "password": "again-pass", "confirm": "again-pass"})
    assert r.status_code == 400
    # Jo's other session is signed out; the new password works (the wrong-password wait was cleared)
    assert jo.get("/").status_code == 302
    assert not login(app.test_client(), "jo", "jo-pass-1")
    assert login(other, "jo", "new-jo-pass")
    a = audit_rows(app)
    assert len(a) == 1 and "jo reset their own password with a code emailed to them" in a[0]["details"]


def test_email_code_expires_after_15_minutes(tmp_path, mails, monkeypatch):
    app = make_app(tmp_path)
    c = app.test_client()
    c.post("/forgot/email", data={"who": "jo"})
    code = code_in(mails[-1])
    real = time.time
    monkeypatch.setattr(pr.time, "time", lambda: real() + 15 * 60 + 5)
    r = c.post("/forgot/email/reset", data={"who": "jo", "code": code, "password": "new-jo-pass", "confirm": "new-jo-pass"})
    assert r.status_code == 400 and not login(app.test_client(), "jo", "new-jo-pass")


def test_email_code_no_enumeration_3_an_hour_5_tries(tmp_path, mails):
    app = make_app(tmp_path)
    c = app.test_client()
    yes = c.post("/forgot/email", data={"who": "jo"})
    no = c.post("/forgot/email", data={"who": "nobody-here"})
    no_mail = c.post("/forgot/email", data={"who": "noemail"})
    strip = lambda r: re.sub(r'value="[^"]*"', "", r.get_data(as_text=True))  # the typed name is shown back
    assert yes.status_code == no.status_code == no_mail.status_code == 200
    assert strip(yes) == strip(no) == strip(no_mail)
    assert [m[0] for m in mails] == ["jo@co.test"]
    # a wrong code reads the same for a real and an unknown username
    a = c.post("/forgot/email/reset", data={"who": "jo", "code": "000000", "password": "x-pass-123", "confirm": "x-pass-123"})
    b = c.post("/forgot/email/reset", data={"who": "ghost", "code": "000000", "password": "x-pass-123", "confirm": "x-pass-123"})
    assert a.status_code == b.status_code == 400 and strip(a).replace("jo", "") == strip(b).replace("ghost", "")
    # 3 codes an hour per person (the 4th request says the same, but sends nothing)
    c.post("/forgot/email", data={"who": "jo"})
    c.post("/forgot/email", data={"who": "jo@co.test"})
    assert len(mails) == 3
    r = c.post("/forgot/email", data={"who": "jo"})
    assert r.status_code == 200 and len(mails) == 3
    # 5 wrong tries cancel the code, even typed as username then email
    code = code_in(mails[-1])
    with app.app_context():
        get_db().execute("UPDATE password_reset_codes SET tries=0")  # count from here
        get_db().commit()
    app.config["_reset_fails"] = {}
    wrong = f"{(int(code) + 1) % 1000000:06d}"
    for who in ("jo", "jo@co.test", "jo", "jo@co.test", "jo"):
        c.post("/forgot/email/reset", data={"who": who, "code": wrong, "password": "x-pass-123", "confirm": "x-pass-123"})
    r = c.post("/forgot/email/reset", data={"who": "jo@co.test", "code": code, "password": "x-pass-123", "confirm": "x-pass-123"})
    assert r.status_code == 400 and not login(app.test_client(), "jo", "x-pass-123")
    # and per name typed: 5 wrong in 10 minutes and that name waits
    for _ in range(3):
        c.post("/forgot/email/reset", data={"who": "jo", "code": wrong, "password": "x-pass-123", "confirm": "x-pass-123"})
    r = c.post("/forgot/email/reset", data={"who": "jo", "code": wrong, "password": "x-pass-123", "confirm": "x-pass-123"})
    assert r.status_code == 429


def test_email_not_set_up_says_so(tmp_path, mails):
    app = make_app(tmp_path, email=False)
    c = app.test_client()
    assert "email sending isn't set up" in c.get("/forgot").get_data(as_text=True)
    r = c.post("/forgot/email", data={"who": "jo"})
    assert r.status_code == 400 and mails == []


def test_forgot_endpoints_are_rate_limited(tmp_path, mails):
    app = make_app(tmp_path)
    c = app.test_client()
    codes = [c.post("/forgot/email", data={"who": f"x{i}"}).status_code for i in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429


# ---------------------------------------------------------------- 2. the business owner's Riyeser account
@pytest.fixture
def owner_env(monkeypatch, online_url):
    monkeypatch.setenv("RIYESER_ONLINE_URL", online_url)
    monkeypatch.setenv("RIYESER_ONLINE_KEY", "test-key")


def test_online_address_is_built_in_for_the_packaged_app(monkeypatch):
    monkeypatch.setenv("RIYESER_ONLINE_URL", "http://evil.test")
    assert pr.online()["url"] == "http://evil.test"
    monkeypatch.setattr(pr.sys, "frozen", True, raising=False)
    assert pr.online() == pr.ONLINE == {"url": "https://goaugynxeatzqzifpoes.supabase.co",
                                        "key": "sb_publishable_-hYqz3gbSvsH-1rX_HLV4A_eSTp3XXL"}


def test_owner_needs_a_linked_pc(tmp_path, owner_env):
    app = make_app(tmp_path)
    c = app.test_client()
    CALLS.clear()
    r = c.post("/forgot/owner", data={"email": "owner@biz.test", "password": "ownerpass1"})
    assert r.status_code == 409 and "isn&#39;t linked to your business" in r.get_data(as_text=True)
    assert CALLS == []  # nothing sent to Riyeser
    link_pc(tmp_path, mode="offline")
    assert c.post("/forgot/owner", data={"email": "owner@biz.test", "password": "ownerpass1"}).status_code == 409


def test_owner_resets_any_user_and_it_is_audited(tmp_path, owner_env):
    link_pc(tmp_path)
    app = make_app(tmp_path)
    admin = app.test_client()
    assert login(admin, "admin", "admin-pass1")
    c = app.test_client()
    r = c.post("/forgot/owner", data={"email": "owner@biz.test", "password": "wrong-one"})
    assert r.status_code == 401 and "email or password isn&#39;t right" in r.get_data(as_text=True)
    r = c.post("/forgot/owner", data={"email": "owner@biz.test", "password": "ownerpass1"})
    page = r.get_data(as_text=True)
    assert r.status_code == 200 and "owner of <b>Biz Pty Ltd</b>" in page and 'value="main:1"' in page
    r = c.post("/forgot/owner/reset", data={"user": "main:1", "password": "owner-set-1", "confirm": "owner-set-1"})
    assert r.status_code == 302
    assert admin.get("/").status_code == 302  # the admin's session was signed out
    assert login(app.test_client(), "admin", "owner-set-1")
    a = audit_rows(app)
    assert "admin: new password set by the business owner, signed in to Riyeser as owner@biz.test" in a[-1]["details"]
    # good once
    r = c.post("/forgot/owner/reset", data={"user": "main:2", "password": "owner-set-2", "confirm": "owner-set-2"})
    assert r.status_code == 401 and not login(app.test_client(), "jo", "owner-set-2")


@pytest.mark.parametrize("email,pw", [("admin@biz.test", "adminpass1"), ("other@biz.test", "otherpass1")])
def test_not_the_owner_of_this_business_is_refused(tmp_path, owner_env, email, pw):
    link_pc(tmp_path)
    app = make_app(tmp_path)
    c = app.test_client()
    r = c.post("/forgot/owner", data={"email": email, "password": pw})
    assert r.status_code == 403 and "isn&#39;t the owner of Biz Pty Ltd" in r.get_data(as_text=True)
    r = c.post("/forgot/owner/reset", data={"user": "main:1", "password": "taken-over", "confirm": "taken-over"})
    assert r.status_code in (401, 403) and not login(app.test_client(), "admin", "taken-over")


def test_owner_linked_to_another_workspace_is_refused(tmp_path, owner_env):
    link_pc(tmp_path, ws="another-business", name="Someone Else")
    app = make_app(tmp_path)
    r = app.test_client().post("/forgot/owner", data={"email": "owner@biz.test", "password": "ownerpass1"})
    assert r.status_code == 403


def test_owner_with_two_step_must_type_the_code(tmp_path, owner_env):
    link_pc(tmp_path)
    app = make_app(tmp_path)
    c = app.test_client()
    r = c.post("/forgot/owner", data={"email": "mfa@biz.test", "password": "mfapass123"})
    assert "authenticator app" in r.get_data(as_text=True) and 'name="user"' not in r.get_data(as_text=True)
    CALLS.clear()
    # skipping the code: refused, and Riyeser's members list was never even asked
    r = c.post("/forgot/owner/reset", data={"user": "main:1", "password": "taken-over", "confirm": "taken-over"})
    assert r.status_code == 403 and not login(app.test_client(), "admin", "taken-over")
    assert "/rest/v1/members" not in CALLS
    r = c.post("/forgot/owner/code", data={"code": "111111"})
    assert r.status_code == 401 and "code isn&#39;t right" in r.get_data(as_text=True)
    r = c.post("/forgot/owner/code", data={"code": "246810"})
    assert r.status_code == 200 and 'value="main:2"' in r.get_data(as_text=True)
    r = c.post("/forgot/owner/reset", data={"user": "main:2", "password": "jo-owner-1", "confirm": "jo-owner-1"})
    assert r.status_code == 302 and login(app.test_client(), "jo", "jo-owner-1")
    assert "signed in to Riyeser as mfa@biz.test" in audit_rows(app)[-1]["details"]


def test_two_step_code_tries_are_limited(tmp_path, owner_env):
    link_pc(tmp_path)
    app = make_app(tmp_path)
    c = app.test_client()
    c.post("/forgot/owner", data={"email": "mfa@biz.test", "password": "mfapass123"})
    for _ in range(5):
        c.post("/forgot/owner/code", data={"code": "111111"})
    r = c.post("/forgot/owner/code", data={"code": "246810"})
    assert r.status_code == 429


def test_confirm_owner_wants_aal2_when_there_is_a_factor():
    x = {"uid": "u-mfa", "token": jwt({"sub": "u-mfa", "aal": "aal1"}), "factor_id": "f-1"}
    with pytest.raises(pr.ResetError) as e:
        pr.confirm_owner(x, {"workspace_id": WS, "name": ""})
    assert e.value.status == 403
    assert pr.aal_of(jwt({"aal": "aal2"})) == "aal2" and pr.aal_of("junk") == ""
    assert pr.mfa_factor({"factors": [{"id": "a", "status": "unverified", "factor_type": "totp"}]}) is None


def test_admin_can_still_reset_from_users_and_roles(tmp_path):
    app = make_app(tmp_path)
    admin = app.test_client()
    assert login(admin, "admin", "admin-pass1")
    jo = app.test_client()
    assert login(jo, "jo", "jo-pass-1")
    with app.app_context():
        jid = get_db().execute("SELECT id FROM users WHERE username='jo'").fetchone()["id"]
    r = admin.post("/users/save", data={"id": jid, "role": "accountant", "active": "1", "full_name": "Jo Bloggs",
                                        "email": "jo2@co.test", "password": "admin-set-1"})
    assert r.status_code == 302
    assert login(app.test_client(), "jo", "admin-set-1")
    assert jo.get("/").status_code == 302  # Jo's old session ends
    assert admin.get("/").status_code == 200
    with app.app_context():
        assert get_db().execute("SELECT email FROM users WHERE id=?", (jid,)).fetchone()["email"] == "jo2@co.test"
