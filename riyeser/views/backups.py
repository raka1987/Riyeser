"""Setup, Backups: back up now, open the backups folder, restore from a backup (S38, S39, OWNER-BACKUP)."""
import os
import sqlite3
import subprocess
import sys
from datetime import datetime

from flask import (Blueprint, render_template, request, redirect, url_for, flash, abort, g, session, current_app,
                   send_file)

from .. import backups as bk
from .. import companies as co
from ..db import get_db, audit

bp = Blueprint("backups", __name__, url_prefix="/setup/backups")


def _here():
    return g.get("db_path") or current_app.config["DATABASE"]


def _first_run():
    return not os.path.exists(current_app.config["DATABASE"])


def _admin():
    return bool(g.user) and g.user["role"] == "admin"


@bp.route("/")
def index():
    path = _here()
    return render_template("backups/index.html", backups=bk.list_backups(path)[:bk.KEEP], folder=bk.folder_for(path),
                           root=bk.root(), remind=bk.needs_reminder(path), keep=bk.KEEP, is_admin=_admin(),
                           local=_local_desktop())


@bp.route("/now", methods=["POST"])
def now():
    dest = bk.backup_now(_here())
    audit(get_db(), "backup", dest.name)
    get_db().commit()
    flash(f"Backed up to {dest}.", "ok")
    return redirect(url_for("backups.index"))


@bp.route("/download", methods=["POST"])
def download():
    """A backup to keep somewhere else too (a USB stick, OneDrive): the browser asks where to save it."""
    dest = bk.backup_now(_here())
    return send_file(str(dest), as_attachment=True, download_name=dest.name, mimetype="application/octet-stream")


def _local_desktop():
    return bool(current_app.config.get("LOCAL_RESET")) and request.remote_addr in ("127.0.0.1", "::1")


@bp.route("/open", methods=["POST"])
def open_folder():
    folder = bk.folder_for(_here())
    folder.mkdir(parents=True, exist_ok=True)
    if not _local_desktop():
        flash(f"The backups are in {folder} on the computer that runs Riyeser Accounting.", "ok")
        return redirect(url_for("backups.index"))
    try:
        if sys.platform.startswith("win"):
            os.startfile(str(folder))  # noqa: S606 - our own folder, on this PC
        else:
            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(folder)])
    except OSError:
        flash(f"The backups are in {folder}.", "ok")
    return redirect(url_for("backups.index"))


# ---------------------------------------------------------------- restore
def _can_restore():
    return _first_run() or _admin()


@bp.route("/restore", methods=["POST"])
def restore_upload():
    if not _can_restore():
        abort(403)
    up = request.files.get("file")
    back = url_for("auth.setup_company") if _first_run() else url_for("backups.index")
    if not up or not up.filename:
        flash("Choose the backup file to restore (a .db file).", "error")
        return redirect(back)
    try:
        token = bk.take_upload(up, up.filename)
    except ValueError as e:
        flash(str(e), "error")
        return redirect(back)
    return redirect(url_for("backups.restore", token=token))


@bp.route("/restore/<token>", methods=["GET", "POST"])
def restore(token):
    if not _can_restore():
        abort(403)
    src = bk.incoming(token)
    if not src:
        flash("That backup is no longer waiting. Choose it again.", "error")
        return redirect(url_for("auth.setup_company") if _first_run() else url_for("backups.index"))
    info = bk.describe(src)
    first = _first_run()
    if request.method == "GET":
        current = None if first else bk.describe(_here())
        return render_template("backups/restore.html", info=info, token=token, first=first, current=current,
                               copy_name=bk.restored_name(info["name"]), can_copy=not first and co.can_add_another())
    action = request.form.get("action")
    if action == "cancel":
        bk.discard(token)
        return redirect(url_for("auth.setup_company") if first else url_for("backups.index"))
    if first or action == "over":
        live = current_app.config["DATABASE"] if first else _here()
        before = bk.restore_over(src, live)
        bk.discard(token)
        current_app.config.setdefault("_migrated_dbs", set()).discard(live)  # bring the restored file up to date
        _audit_into(live, f"restored from a backup ({info['name']})" + (f"; before-restore copy {before.name}"
                                                                        if before else ""))
        session.clear()  # the restored file has its own users
        flash(f"{info['name']} restored." + (f" The company as it was is kept in {before}." if before else "")
              + " Sign in with a user from the backup.", "ok")
        return redirect(url_for("auth.login"))
    if action == "copy":
        if not co.can_add_another():
            flash("Your plan has no room for another company. Restore over this company instead.", "error")
            return redirect(url_for("backups.restore", token=token))
        cid, _name = co.import_company(str(src))
        new = co.path_of(cid)
        name = bk.restored_name(info["name"])
        con = sqlite3.connect(new)
        try:
            con.execute("UPDATE company SET name=? WHERE id=1", (name,))
            con.commit()
        finally:
            con.close()
        bk.discard(token)
        audit(get_db(), "restore_copy", name)
        get_db().commit()
        flash(f"{name} added. Sign in with a user from that backup to open it.", "ok")
        return redirect(url_for("companies.index"))
    abort(400)


def _audit_into(path, details):
    con = sqlite3.connect(path)
    try:
        con.execute("INSERT INTO audit_log (user_id, action, details) VALUES (NULL, 'restore_backup', ?)", (details,))
        con.commit()
    except sqlite3.Error:
        pass
    finally:
        con.close()


def auto_backup(app):
    """Once a day per company file, the first time it's used that day (S38). Never stops the page loading."""
    if not app.config.get("AUTO_BACKUP", not app.config.get("TESTING")):
        return
    path = _here()
    done = app.config.setdefault("_backed_up_today", {})
    today = datetime.now().date()
    if done.get(path) == today or not os.path.exists(path):
        return
    try:
        bk.daily_backup(path)
        done[path] = today
    except (OSError, sqlite3.Error) as e:
        app.logger.warning("Automatic backup of %s failed: %s", path, e)
