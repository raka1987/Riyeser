import json
import os

from flask import Blueprint, render_template, request, redirect, url_for, session, flash, current_app, g
from werkzeug.security import check_password_hash, generate_password_hash

from ..db import get_db, init_db, audit
from . import admin_only, guarded
from .. import perms

bp = Blueprint("auth", __name__)


@bp.route("/setup", methods=["GET", "POST"])
def setup_company():
    if os.path.exists(current_app.config["DATABASE"]):
        return redirect(url_for("auth.login"))
    if request.method == "POST":
        name = request.form.get("name", "").strip() or "My Company Pty Ltd"
        pw = request.form.get("password") or ""
        if len(pw) < MIN_PASSWORD:
            flash(f"Choose an admin password of at least {MIN_PASSWORD} characters.", "error")
            return redirect(url_for("auth.setup_company"))
        init_db(name, pw, request.form.get("edition"))
        from .. import company_profile
        prof = company_profile.read()
        if prof and request.form.get("use_profile", "1") == "1":
            company_profile.apply_to_new_file(get_db(), prof)
        if request.form.get("start") == "demo" or request.form.get("demo"):
            from ..demo import seed_demo
            seed_demo(get_db())
        from .. import archive
        archive.copy_head_into(current_app.config["DATABASE"], os.path.dirname(os.path.abspath(current_app.config["DATABASE"])))
        flash("Company file created. Sign in as 'admin'.", "ok")
        return redirect(url_for("auth.login"))
    from .. import company_profile
    return render_template("auth/setup.html", profile=company_profile.read())


MIN_PASSWORD = 8          # S37
FREE_TRIES = 5            # wrong passwords in a row before sign-in waits
FIRST_WAIT = 30           # seconds after the 5th; doubles each time after, up to 15 minutes


def check_password_rules(pw):
    if len(pw or "") < MIN_PASSWORD:
        raise ValueError(f"Choose a password of at least {MIN_PASSWORD} characters.")


def _fails():
    return current_app.config.setdefault("_login_fails", {})


def _wait_left(key, now):
    n, until = _fails().get(key, (0, 0))
    return max(0, int(until - now + 0.999)) if n >= FREE_TRIES else 0


def _failed(key, now):
    n, _until = _fails().get(key, (0, 0))
    n += 1
    wait = min(FIRST_WAIT * 2 ** (n - FREE_TRIES), 900) if n >= FREE_TRIES else 0
    _fails()[key] = (n, now + wait)


@bp.route("/login", methods=["GET", "POST"])
def login():
    from .. import companies as co
    choices = co.all_companies()
    if request.method == "POST":
        cid = request.form.get("company") or co.MAIN
        path = co.path_of(cid) if any(c["id"] == cid for c in choices) else None
        if not path:
            cid, path = co.MAIN, co.path_of(co.MAIN)
        import time
        uname = request.form.get("username", "").strip()
        key, now = (path, uname.lower()), time.time()
        left = _wait_left(key, now)
        if left:
            flash(f"Too many wrong passwords for {uname}. Try again in {left} seconds.", "error")
            return render_template("auth/login.html", choices=choices), 429
        with co.using(path):
            db = get_db()
            u = db.execute("SELECT * FROM users WHERE username=? AND active=1", (uname,)).fetchone()
            ok = bool(u and check_password_hash(u["password_hash"], request.form.get("password", "")))
            if ok:
                audit(db, "login", u["username"])
            else:
                audit(db, "login_failed", uname[:60])
            db.commit()
        if ok:
            _fails().pop(key, None)
        else:
            _failed(key, now)
        if ok:
            session.clear()
            access = co.access_after_login(u["username"], u["password_hash"])
            access[cid] = u["id"]
            session["access"] = access
            session["co"] = cid
            session["uid"] = u["id"]
            session["pwv"] = {c: pw_mark(u["password_hash"]) for c in access}  # the same password in each of them
            g.user = u
            nxt = request.args.get("next") or ""
            return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("core.dashboard"))
        flash("Invalid username or password.", "error")
    return render_template("auth/login.html", choices=choices)


def _local_reset_allowed():
    """"Forgot password?" is only offered in the desktop app, from this computer itself (the desktop server only
    listens on 127.0.0.1). Even there it needs proof: an emailed code or the business owner's Riyeser account."""
    return bool(current_app.config.get("LOCAL_RESET")) and request.remote_addr in ("127.0.0.1", "::1")


def pw_mark(password_hash):
    """A short fingerprint of the stored password, kept in the session: a new password signs out the old sessions."""
    import hashlib
    return hashlib.sha256((password_hash or "").encode()).hexdigest()[:20]


# Limits per address on every "Forgot password?" step: (requests, seconds).
FORGOT_LIMITS = {"email": (10, 3600), "email_reset": (20, 900), "owner": (10, 900), "owner_code": (20, 900),
                 "owner_reset": (20, 900)}


class _Refused(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def _rate_limit(step):
    import time
    limit, window = FORGOT_LIMITS[step]
    hits = current_app.config.setdefault("_forgot_hits", {})
    key, now = (step, request.remote_addr), time.time()
    hits[key] = [t for t in hits.get(key, []) if now - t < window] + [now]
    if len(hits[key]) > limit:
        raise _Refused(429, "Too many tries. Wait a few minutes, then try again.")


def _recent_fails(key, window=600):
    """Wrong tries for this key in the last 10 minutes (a list: append to count one more)."""
    import time
    fails = current_app.config.setdefault("_reset_fails", {})
    now = time.time()
    fails[key] = [t for t in fails.get(key, []) if now - t < window]
    return fails[key]


def _forgot_company():
    """The company the person picked (like the sign-in screen), as (id, path)."""
    from .. import companies as co
    cid = request.form.get("company") or co.MAIN
    path = co.path_of(cid) if any(c["id"] == cid for c in co.all_companies()) else None
    return (cid, path) if path else (co.MAIN, co.path_of(co.MAIN))


def _email_ready_anywhere():
    from .. import companies as co
    from .. import mailer
    for c in co.all_companies():
        with co.using(c["path"]):
            if mailer.settings(get_db()):
                return True
    return False


def _forgot_page(step, status=200, **kw):
    from .. import companies as co
    from .. import password_reset as pr
    kw.setdefault("business", pr.linked_business())
    return render_template("auth/forgot.html", step=step, allowed=_local_reset_allowed(), choices=co.all_companies(),
                           email_ready=_email_ready_anywhere() if step == "start" else None,
                           not_linked=pr.NOT_LINKED, **kw), status


def _new_password():
    pw = request.form.get("password", "")
    if len(pw) < MIN_PASSWORD:
        raise _Refused(400, f"The new password needs at least {MIN_PASSWORD} characters.")
    if pw != request.form.get("confirm", ""):
        raise _Refused(400, "The two passwords don't match. Type the same new password twice.")
    return pw


def _set_password(path, u, pw, action, details):
    """The same for both ways: the new password, codes cancelled, wrong-password counter cleared, an audit entry.
    The person's other sessions end by themselves: they carry the old password's fingerprint (see load_user)."""
    from .. import companies as co
    from .. import password_reset as pr
    with co.using(path):
        db = get_db()
        db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(pw), u["id"]))
        pr.cancel_codes(db, u["id"])
        db.execute("INSERT INTO audit_log (user_id, action, details) VALUES (NULL,?,?)", (action, details))
        db.commit()
    for key in [k for k in _fails() if k[0] == path and k[1] == u["username"].lower()]:
        _fails().pop(key, None)


def _forgot_guard(step):
    if not _local_reset_allowed():
        return redirect(url_for("auth.forgot"))
    _rate_limit(step)
    return None


def _refused_page(step, e, **kw):
    flash(e.message, "error")
    return _forgot_page(step, e.status, **kw)


@bp.route("/forgot")
def forgot():
    return _forgot_page("start")


def _deliver(settings, to_addr, subject, body):
    """Send the code straight away, in the background (so the answer takes the same time whoever was typed). Not
    through the outbox: a reset code shouldn't sit in the company file for anyone to read."""
    import threading

    def run():
        from email.message import EmailMessage
        from email.utils import formataddr, make_msgid
        from .. import mailer
        try:
            server = mailer._connect(settings)
            try:
                m = EmailMessage()
                m["From"] = formataddr((settings["company"], settings["smtp_from"]))
                m["To"], m["Subject"] = to_addr, subject
                m["Message-ID"] = make_msgid(domain=settings["smtp_from"].split("@")[-1])
                m.set_content(body)
                server.send_message(m)
            finally:
                server.quit()
        except Exception:  # noqa: BLE001 - nothing to tell the person: the answer is the same either way
            pass
    threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------- 1. an emailed code
@bp.route("/forgot/email", methods=["POST"])
def forgot_email():
    from .. import companies as co
    from .. import mailer
    from .. import password_reset as pr
    try:
        stop = _forgot_guard("email")
        if stop:
            return stop
        cid, path = _forgot_company()
        who = request.form.get("who", "").strip()[:200]
        if not who:
            raise _Refused(400, "Type your username or email address.")
        with co.using(path):
            db = get_db()
            settings = mailer.settings(db)
            if not settings:
                raise _Refused(400, "Email isn't set up for this company, so a code can't be sent. If you're the "
                                    "business owner, use your Riyeser account instead, or ask your administrator.")
            for u in pr.matching(db, who):
                if not pr.is_email(u["email"]):
                    continue
                code = pr.new_code(db, u["id"])
                if not code:
                    continue  # the same answer: nobody learns about the limit or the person
                db.commit()
                _deliver(settings, u["email"].strip(), f"Your {settings['company'] or 'Riyeser'} password reset code: {code}",
                         f"Hello {u['full_name'] or u['username']},\n\nSomeone asked to reset the Riyeser password for "
                         f"the login {u['username']}.\n\nYour code: {code}\n\nType this code on the sign-in screen "
                         f"(Forgot password?). It works once, for {pr.CODE_MINUTES} minutes.\n\nIf you didn't ask for "
                         "this, you can ignore this email: your password hasn't changed.\n")
    except _Refused as e:
        return _refused_page("start", e)
    flash(pr.SENT, "ok")
    return _forgot_page("code", who=who, company_id=cid)


@bp.route("/forgot/email/reset", methods=["POST"])
def forgot_email_reset():
    import time
    from .. import companies as co
    from .. import password_reset as pr
    cid, path = _forgot_company()
    who = request.form.get("who", "").strip()[:200]
    try:
        stop = _forgot_guard("email_reset")
        if stop:
            return stop
        code = "".join(request.form.get("code", "").split())
        if not who:
            raise _Refused(400, "Type your username or email address.")
        if not (len(code) == 6 and code.isdigit()):
            raise _Refused(400, "Type the 6-digit code from the email.")
        pw = _new_password()
        tries = _recent_fails(("code", path, who.lower()))  # per username / email typed, whether or not it exists
        if len(tries) >= pr.CODE_TRIES:
            raise _Refused(429, "Too many wrong codes. Wait 10 minutes, then ask for a new code.")
        with co.using(path):
            db = get_db()
            for u in pr.matching(db, who):
                if pr.use_code(db, u["id"], code):
                    db.commit()
                    _set_password(path, u, pw, "password_reset",
                                  f"{u['username']} reset their own password with a code emailed to them")
                    flash(f"Your password has been changed. Sign in as {u['username']} with the new password.", "ok")
                    return redirect(url_for("auth.login"))
            db.commit()
        tries.append(time.time())
        raise _Refused(400, pr.WRONG_CODE)
    except _Refused as e:
        return _refused_page("code", e, who=who, company_id=cid)


# ---------------------------------------------------------------- 2. the business owner's Riyeser account
def _tickets():
    from .. import password_reset as pr
    return current_app.config.setdefault("_owner_tickets", pr.Tickets())


def _business():
    from .. import password_reset as pr
    biz = pr.linked_business()
    if not biz:
        raise _Refused(409, pr.NOT_LINKED)
    return biz


def _users_to_choose():
    from .. import companies as co
    out = []
    for c in co.all_companies():
        with co.using(c["path"]):
            rows = get_db().execute("SELECT id, username, full_name, role FROM users WHERE active=1"
                                    " ORDER BY role='admin' DESC, username").fetchall()
        out.append({"id": c["id"], "name": c["name"], "users": rows})
    return out


def _owner_ok(x, biz):
    from .. import password_reset as pr
    pr.confirm_owner(x, biz)
    x["stage"] = "owner"
    import time
    x["at"] = time.time()
    return _forgot_page("owner_pick", business=biz, companies=_users_to_choose())


def _as_refused(e):
    return _Refused(e.status, e.message)


@bp.route("/forgot/owner", methods=["POST"])
def forgot_owner():
    import time
    from .. import password_reset as pr
    try:
        stop = _forgot_guard("owner")
        if stop:
            return stop
        biz = _business()  # before anything is sent to Riyeser
        email, password = request.form.get("email", "").strip()[:200], request.form.get("password", "")
        if not pr.is_email(email) or not password:
            raise _Refused(400, "Type the email and password of your Riyeser account (the one you sign in to Riyeser "
                                "Central with).")
        fails = _recent_fails(("owner", email.lower()))
        if len(fails) >= 5:
            raise _Refused(429, "Too many tries for that account. Wait 10 minutes, then try again.")
        try:
            r = pr.owner_sign_in(email, password)
        except pr.ResetError as e:
            if e.status == 401:
                fails.append(time.time())
            raise _as_refused(e)
        x = {"stage": "code" if r["factor_id"] else "signed-in", "email": email, **r}
        t = _tickets().new(**x)
        session["forgot_ticket"] = t
        if r["factor_id"]:
            return _forgot_page("owner_code", business=biz)
        try:
            return _owner_ok(_tickets().get(t), biz)
        except pr.ResetError as e:
            _tickets().drop(t)
            raise _as_refused(e)
    except _Refused as e:
        return _refused_page("start", e)


@bp.route("/forgot/owner/code", methods=["POST"])
def forgot_owner_code():
    from .. import password_reset as pr
    try:
        stop = _forgot_guard("owner_code")
        if stop:
            return stop
        t = session.get("forgot_ticket")
        try:
            x = _tickets().get(t)
        except pr.ResetError as e:
            raise _Refused(e.status, e.message)
        biz = _business()
        if x["stage"] != "code":
            raise _Refused(400, "Start again: sign in with your Riyeser account.")
        code = "".join(request.form.get("code", "").split())
        if not (len(code) == 6 and code.isdigit()):
            return _refused_page("owner_code", _Refused(400, "Type the 6-digit code from your authenticator app."),
                                 business=biz)
        x["tries"] += 1
        if x["tries"] > pr.CODE_TRIES:
            _tickets().drop(t)
            raise _Refused(429, "Too many wrong codes. Start again in a few minutes.")
        try:
            x["token"] = pr.owner_two_step(x, code)
        except pr.ResetError as e:
            return _refused_page("owner_code", _as_refused(e), business=biz)
        x["stage"] = "signed-in"
        try:
            return _owner_ok(x, biz)
        except pr.ResetError as e:
            _tickets().drop(t)
            raise _as_refused(e)
    except _Refused as e:
        return _refused_page("start", e)


@bp.route("/forgot/owner/reset", methods=["POST"])
def forgot_owner_reset():
    from .. import companies as co
    from .. import password_reset as pr
    try:
        stop = _forgot_guard("owner_reset")
        if stop:
            return stop
        t = session.get("forgot_ticket")
        try:
            x = _tickets().get(t)
        except pr.ResetError as e:
            raise _Refused(e.status, e.message)
        if x["stage"] == "code":
            raise _Refused(403, "Type the two-step code from your authenticator app first.")
        if x["stage"] != "owner":
            raise _Refused(403, "Start again: sign in with your Riyeser account.")
        cid, _, uid = (request.form.get("user") or "").partition(":")
        path = co.path_of(cid) if any(c["id"] == cid for c in co.all_companies()) else None
        u = None
        if path and uid.isdigit():
            with co.using(path):
                u = get_db().execute("SELECT * FROM users WHERE id=? AND active=1", (int(uid),)).fetchone()
        try:
            if not u:
                raise _Refused(400, "Choose the user whose password you're resetting.")
            pw = _new_password()
        except _Refused as e:
            return _refused_page("owner_pick", e, business=pr.linked_business(), companies=_users_to_choose())
        _tickets().drop(t)  # good once
        session.pop("forgot_ticket", None)
        _set_password(path, u, pw, "password_reset",
                      f"{u['username']}: new password set by the business owner, signed in to Riyeser as {x['email']}")
        flash(f"The password for {u['username']} has been changed. Sign in with it now.", "ok")
        return redirect(url_for("auth.login"))
    except _Refused as e:
        return _refused_page("start", e)


@bp.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    if current_app.config.get("DEMO_MODE"):
        session["demo_signed_out"] = True  # demo mode signs you in on its own; not straight after signing out
    return redirect(url_for("auth.login"))


@bp.route("/users")
@admin_only
def users():
    from .. import companies as co
    from ..listing import ListSpec, Col, Choice, from_request
    lst = from_request(ListSpec("users", [
        Col("username", "User name"), Col("full_name", "Full name"), Col("role", "Type"), Col("email", "Email")],
        sort="username", per_page=None, search=("username", "full_name", "email"), search_hint="Name or email",
        noun="users", choices=[
            Choice("role", "Type", [("admin", "Administrator"), ("accountant", "Staff"), ("viewer", "Read-only")]),
            Choice("st", "Status", [("1", "Active"), ("0", "Inactive")], col="active")]))
    rows = lst.apply([dict(r) for r in get_db().execute("SELECT * FROM users ORDER BY username")])
    here = co.current_id()
    others = []  # other companies where you're an administrator: you can give people access there too
    for c in co.all_companies():
        if c["id"] == here:
            continue
        me = co.user_row(c["path"], g.user["username"])
        if me and me["role"] == "admin":
            others.append({**c, "has": {r["username"] for r in _users_in(c["path"])}})
    return render_template("auth/users.html", users=rows, others=others, lst=lst, areas=perms.AREAS, level_names=perms.LEVELS,
                           presets=perms.PRESETS, presets_json=json.dumps({k: v for k, (_, v) in perms.PRESETS.items()}),
                           levels=perms.levels_for)


@bp.route("/users/save", methods=["POST"])
@admin_only
@guarded
def save_user():
    db = get_db()
    f = request.form
    uid = f.get("id")
    if uid:
        role = f.get("role")
        if role not in ("admin", "accountant", "viewer"):
            raise ValueError("Invalid user type.")
        active = 1 if f.get("active") else 0
        # Never lock everyone out: keep at least one active administrator.
        if role != "admin" or not active:
            others = db.execute("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id<>?", (uid,)).fetchone()["n"]
            if not others:
                raise ValueError("Keep at least one active administrator, or nobody could manage users.")
        levels = perms.parse_form(f)
        db.execute("UPDATE users SET full_name=?, role=?, active=?, perms=?, email=? WHERE id=?",
                   (f.get("full_name"), role, active, None if role == "admin" else json.dumps(levels),
                    _email_field(f), uid))
        if f.get("password"):
            check_password_rules(f["password"])
            new_hash = generate_password_hash(f["password"])
            db.execute("UPDATE users SET password_hash=? WHERE id=?", (new_hash, uid))
            if str(uid) == str(g.user["id"]):
                from .. import companies as co
                session["pwv"] = {**(session.get("pwv") or {}), co.current_id(): pw_mark(new_hash)}  # you stay signed in
        name = db.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()["username"]
        audit(db, "save_user", f"{name}: {role}" + ("" if role == "admin" else " " + ", ".join(f"{a}={v}" for a, v in levels.items())))
    else:
        if not f.get("username", "").strip() or not f.get("password"):
            raise ValueError("Username and password are required.")
        check_password_rules(f["password"])
        if db.execute("SELECT 1 FROM users WHERE username=? COLLATE NOCASE", (f["username"].strip(),)).fetchone():
            raise ValueError(f"That username is taken: {f['username'].strip()}. Choose another, or edit that user.")
        preset = f.get("preset") or ("role:" + f["role"] if f.get("role") else "readonly")
        if preset.startswith("role:") and preset[5:] in ("admin", "accountant", "viewer"):
            role, levels = preset[5:], None  # older forms / scripts: a plain role
        elif preset == "admin":
            role, levels = "admin", None
        elif preset in perms.PRESETS:
            role, levels = "accountant", perms.PRESETS[preset][1]
        else:
            raise ValueError("Choose what the new user can access.")
        db.execute("INSERT INTO users (username, password_hash, full_name, role, perms, email) VALUES (?,?,?,?,?,?)",
                   (f["username"].strip(), generate_password_hash(f["password"]), f.get("full_name"), role,
                    json.dumps(levels) if levels else None, _email_field(f)))
        audit(db, "add_user", f"{f['username'].strip()}: {preset}")
    _copy_to_other_companies(db, f)
    flash("User saved.", "ok")
    return redirect(url_for("auth.users"))


def _email_field(f):
    """The person's own email address, for "Forgot password?" codes (blank is fine)."""
    from ..password_reset import is_email
    e = (f.get("email") or "").strip()
    if e and not is_email(e):
        raise ValueError(f"\"{e}\" isn't an email address.")
    return e or None


def _users_in(path):
    import sqlite3
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            return con.execute("SELECT username FROM users WHERE active=1").fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return []


def _copy_to_other_companies(db, f):
    """Give this person the same sign-in and access in the other companies ticked (where you're an administrator)."""
    from .. import companies as co
    wanted = f.getlist("also")
    if not wanted:
        return
    username = (f.get("username") or "").strip()
    if not username and f.get("id"):
        username = db.execute("SELECT username FROM users WHERE id=?", (f["id"],)).fetchone()["username"]
    src = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    db.commit()
    done = []
    for cid in wanted:
        path = co.path_of(cid)
        me = co.user_row(path, g.user["username"]) if path else None
        if not me or me["role"] != "admin" or cid == co.current_id():
            continue
        with co.using(path):
            other = get_db()
            row = other.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
            if row:
                other.execute("UPDATE users SET password_hash=?, full_name=?, role=?, perms=?, active=1 WHERE id=?",
                              (src["password_hash"], src["full_name"], src["role"], src["perms"], row["id"]))
            else:
                other.execute("INSERT INTO users (username, password_hash, full_name, role, perms) VALUES (?,?,?,?,?)",
                              (username, src["password_hash"], src["full_name"], src["role"], src["perms"]))
            audit(other, "save_user", f"{username}: copied from another company by {g.user['username']}")
            other.commit()
        done.append(cid)
    if done:
        flash(f"{username} can now also open {len(done)} other compan{'y' if len(done) == 1 else 'ies'} with the same sign-in and access.", "ok")
