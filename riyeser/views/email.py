"""Setup, Email: the SMTP server Accounting sends from, a test email, and the outbox (S18)."""
from flask import Blueprint, render_template, request, redirect, url_for, flash, g

from .. import mailer
from ..db import get_db, audit
from . import guarded, admin_only

bp = Blueprint("email", __name__, url_prefix="/setup/email")


@bp.route("/", methods=["GET", "POST"])
def index():
    db = get_db()
    if request.method == "POST":
        return _save()
    rows = db.execute("SELECT id, to_addr, subject, kind, status, attempts, error, created_at, sent_at FROM email_queue"
                      " ORDER BY id DESC LIMIT 100").fetchall()
    c = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    return render_template("email/index.html", c=c, rows=rows, ready=bool(mailer.settings(db)))


@admin_only
@guarded
def _save():
    db = get_db()
    f = request.form
    vals = [(f.get(k) or "").strip() or None for k in mailer.FIELDS]
    if not f.get("smtp_password"):
        vals[3] = db.execute("SELECT smtp_password FROM company WHERE id=1").fetchone()[0]  # blank keeps the old one
    if vals[1] and not vals[1].isdigit():
        raise ValueError("The port is a number, like 587.")
    if vals[4] and "@" not in vals[4]:
        raise ValueError("The From address must be an email address.")
    db.execute("UPDATE company SET smtp_host=?, smtp_port=?, smtp_user=?, smtp_password=?, smtp_from=?, smtp_security=?"
               " WHERE id=1", vals)
    audit(db, "email_settings", vals[0] or "off")
    flash("Email settings saved.", "ok")
    return redirect(url_for("email.index"))


@bp.route("/test", methods=["POST"])
@guarded
def test():
    db = get_db()
    to = request.form.get("to") or (g.company or {}).get("email") or ""
    mailer.queue(db, to, "Riyeser Accounting test email", "This is a test email from Riyeser Accounting.", kind="test")
    db.commit()
    sent, failed = mailer.send_pending(db)
    flash("Test email sent." if sent else "The test email couldn't be sent: see the outbox below.",
          "ok" if sent else "error")
    return redirect(url_for("email.index"))


@bp.route("/send", methods=["POST"])
def send_now():
    db = get_db()
    sent, failed = mailer.send_pending(db)
    flash(f"{sent} sent, {failed} not sent.", "ok" if not failed else "error")
    return redirect(url_for("email.index"))


def send_or_queue(db, to, subject, body, attachment=None, kind=None, ref_id=None):
    """Queue one email and try to send it now. Returns a message for the person."""
    if not mailer.settings(db):
        raise ValueError("Email isn't set up yet: add your email server in Setup, Email.")
    mailer.queue(db, to, subject, body, attachment, kind, ref_id)
    db.commit()
    sent, _failed = mailer.send_pending(db)
    return f"Emailed to {to}." if sent else f"Queued for {to}; it couldn't be sent yet (see Setup, Email outbox)."
