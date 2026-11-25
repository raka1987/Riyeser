"""Email from Accounting (S18, S44, S51): the company's own SMTP server (Setup, Company details, Email), and an
outbox. Every email is queued first (table email_queue) and then sent; one that can't be sent stays in the outbox
with the reason, to send again later (Setup, Email outbox)."""
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

FIELDS = ("smtp_host", "smtp_port", "smtp_user", "smtp_password", "smtp_from", "smtp_security")


def ensure(db):
    cols = {r["name"] for r in db.execute("PRAGMA table_info(company)")}
    for col in FIELDS:
        if col not in cols:
            db.execute(f"ALTER TABLE company ADD COLUMN {col} TEXT")
    db.execute("""CREATE TABLE IF NOT EXISTS email_queue (
        id INTEGER PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
        attachment_name TEXT, attachment BLOB, kind TEXT, ref_id INTEGER,
        status TEXT NOT NULL DEFAULT 'queued',   -- queued, sent, failed
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, send_after TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), sent_at TEXT)""")


def settings(db):
    """The SMTP settings, or None when email isn't set up."""
    c = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    keys = c.keys()
    if "smtp_host" not in keys or not c["smtp_host"] or not c["smtp_from"]:
        return None
    return {k: c[k] for k in FIELDS} | {"company": c["name"]}


def queue(db, to_addr, subject, body, attachment=None, kind=None, ref_id=None, send_after=None):
    """attachment: (file name, bytes). Returns the queue id."""
    to_addr = (to_addr or "").strip()
    if "@" not in to_addr or " " in to_addr:
        raise ValueError(f"\"{to_addr}\" isn't an email address.")
    name, data = attachment if attachment else (None, None)
    return db.execute("INSERT INTO email_queue (to_addr, subject, body, attachment_name, attachment, kind, ref_id,"
                      " send_after) VALUES (?,?,?,?,?,?,?,?)",
                      (to_addr, subject, body, name, data, kind, ref_id, send_after)).lastrowid


def _connect(s):
    port = int(s["smtp_port"] or (465 if s["smtp_security"] == "ssl" else 587))
    if s["smtp_security"] == "ssl":
        server = smtplib.SMTP_SSL(s["smtp_host"], port, timeout=20, context=ssl.create_default_context())
    else:
        server = smtplib.SMTP(s["smtp_host"], port, timeout=20)
        if s["smtp_security"] != "none":
            server.starttls(context=ssl.create_default_context())
    if s["smtp_user"]:
        server.login(s["smtp_user"], s["smtp_password"] or "")
    return server


def send_pending(db, limit=50, now=None):
    """Send what's waiting. Returns (sent, failed)."""
    s = settings(db)
    if not s:
        return 0, 0
    rows = db.execute("SELECT * FROM email_queue WHERE status IN ('queued','failed') AND attempts<5 AND"
                      " (send_after IS NULL OR send_after<=COALESCE(?, datetime('now','localtime'))) ORDER BY id LIMIT ?",
                      (now, limit)).fetchall()
    if not rows:
        return 0, 0
    sent = failed = 0
    try:
        server = _connect(s)
    except (OSError, smtplib.SMTPException) as e:
        for r in rows:
            db.execute("UPDATE email_queue SET status='failed', attempts=attempts+1, error=? WHERE id=?",
                       (f"Couldn't connect to {s['smtp_host']}: {e}", r["id"]))
        db.commit()
        return 0, len(rows)
    try:
        for r in rows:
            m = EmailMessage()
            m["From"] = formataddr((s["company"], s["smtp_from"]))
            m["To"] = r["to_addr"]
            m["Subject"] = r["subject"]
            m["Message-ID"] = make_msgid(domain=s["smtp_from"].split("@")[-1])
            m.set_content(r["body"])
            if r["attachment"]:
                m.add_attachment(bytes(r["attachment"]), maintype="application", subtype="pdf",
                                 filename=r["attachment_name"])
            try:
                server.send_message(m)
                db.execute("UPDATE email_queue SET status='sent', attempts=attempts+1, error=NULL,"
                           " sent_at=datetime('now','localtime') WHERE id=?", (r["id"],))
                sent += 1
            except (OSError, smtplib.SMTPException) as e:
                db.execute("UPDATE email_queue SET status='failed', attempts=attempts+1, error=? WHERE id=?",
                           (str(e)[:300], r["id"]))
                failed += 1
            db.commit()
    finally:
        try:
            server.quit()
        except (OSError, smtplib.SMTPException):
            pass
    return sent, failed
