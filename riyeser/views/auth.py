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
            g.user = u
            nxt = request.args.get("next") or ""
            return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("core.dashboard"))
        flash("Invalid username or password.", "error")
    return render_template("auth/login.html", choices=choices)


def _local_reset_allowed():
    """Password reset without signing in is only allowed in the desktop app, from this
    computer itself (the desktop server only listens on 127.0.0.1)."""
    return bool(current_app.config.get("LOCAL_RESET")) and request.remote_addr in ("127.0.0.1", "::1")


@bp.route("/forgot", methods=["GET", "POST"])
def forgot():
    db = get_db()
    allowed = _local_reset_allowed()
    if request.method == "POST":
        if not allowed:
            flash("Password reset is only available in the Riyeser desktop app on the computer "
                  "that holds the company file.", "error")
            return redirect(url_for("auth.forgot"))
        username = request.form.get("username", "").strip()
        pw = request.form.get("password", "")
        u = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if not u:
            flash("No user with that username.", "error")
        elif len(pw) < MIN_PASSWORD:
            flash(f"Choose a password of at least {MIN_PASSWORD} characters.", "error")
        elif pw != request.form.get("confirm", ""):
            flash("The two passwords don't match.", "error")
        else:
            db.execute("UPDATE users SET password_hash=?, active=1 WHERE id=?", (generate_password_hash(pw), u["id"]))
            db.execute("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)",
                       (u["id"], "password_reset", f"{username} reset on this computer"))
            db.commit()
            flash(f"Password for '{username}' has been changed. You can sign in now.", "ok")
            return redirect(url_for("auth.login"))
    users = db.execute("SELECT username, full_name, role FROM users ORDER BY role='admin' DESC, username").fetchall() \
        if allowed else []
    return render_template("auth/forgot.html", allowed=allowed, users=users)


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
    rows = get_db().execute("SELECT * FROM users ORDER BY username").fetchall()
    here = co.current_id()
    others = []  # other companies where you're an administrator: you can give people access there too
    for c in co.all_companies():
        if c["id"] == here:
            continue
        me = co.user_row(c["path"], g.user["username"])
        if me and me["role"] == "admin":
            others.append({**c, "has": {r["username"] for r in _users_in(c["path"])}})
    return render_template("auth/users.html", users=rows, others=others, areas=perms.AREAS, level_names=perms.LEVELS,
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
        db.execute("UPDATE users SET full_name=?, role=?, active=?, perms=? WHERE id=?",
                   (f.get("full_name"), role, active, None if role == "admin" else json.dumps(levels), uid))
        if f.get("password"):
            check_password_rules(f["password"])
            db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(f["password"]), uid))
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
        db.execute("INSERT INTO users (username, password_hash, full_name, role, perms) VALUES (?,?,?,?,?)",
                   (f["username"].strip(), generate_password_hash(f["password"]), f.get("full_name"), role,
                    json.dumps(levels) if levels else None))
        audit(db, "add_user", f"{f['username'].strip()}: {preset}")
    _copy_to_other_companies(db, f)
    flash("User saved.", "ok")
    return redirect(url_for("auth.users"))


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
