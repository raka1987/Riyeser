import os

from flask import Blueprint, render_template, request, redirect, url_for, session, flash, current_app, g
from werkzeug.security import check_password_hash, generate_password_hash

from ..db import get_db, init_db, audit
from . import admin_only, guarded

bp = Blueprint("auth", __name__)


@bp.route("/setup", methods=["GET", "POST"])
def setup_company():
    if os.path.exists(current_app.config["DATABASE"]):
        return redirect(url_for("auth.login"))
    if request.method == "POST":
        name = request.form.get("name", "").strip() or "My Company Pty Ltd"
        pw = request.form.get("password") or "admin"
        init_db(name, pw, request.form.get("edition", "enterprise"))
        if request.form.get("demo"):
            from ..demo import seed_demo
            seed_demo(get_db())
        flash("Company file created. Sign in as 'admin'.", "ok")
        return redirect(url_for("auth.login"))
    return render_template("auth/setup.html")


@bp.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        db = get_db()
        u = db.execute("SELECT * FROM users WHERE username=? AND active=1",
                       (request.form.get("username", "").strip(),)).fetchone()
        if u and check_password_hash(u["password_hash"], request.form.get("password", "")):
            session.clear()
            session["uid"] = u["id"]
            g.user = u
            audit(db, "login", u["username"])
            db.commit()
            nxt = request.args.get("next") or ""
            return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("core.dashboard"))
        flash("Invalid username or password.", "error")
    return render_template("auth/login.html")


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
        elif len(pw) < 4:
            flash("Choose a password of at least 4 characters.", "error")
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
    return redirect(url_for("auth.login"))


@bp.route("/users")
@admin_only
def users():
    rows = get_db().execute("SELECT * FROM users ORDER BY username").fetchall()
    return render_template("auth/users.html", users=rows)


@bp.route("/users/save", methods=["POST"])
@admin_only
@guarded
def save_user():
    db = get_db()
    f = request.form
    uid = f.get("id")
    if f.get("role") not in ("admin", "accountant", "viewer"):
        raise ValueError("Invalid role.")
    if uid:
        db.execute("UPDATE users SET full_name=?, role=?, active=? WHERE id=?",
                   (f.get("full_name"), f["role"], 1 if f.get("active") else 0, uid))
        if f.get("password"):
            db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(f["password"]), uid))
    else:
        if not f.get("username") or not f.get("password"):
            raise ValueError("Username and password are required.")
        db.execute("INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)",
                   (f["username"].strip(), generate_password_hash(f["password"]), f.get("full_name"), f["role"]))
    audit(db, "save_user", f.get("username") or uid)
    flash("User saved.", "ok")
    return redirect(url_for("auth.users"))
