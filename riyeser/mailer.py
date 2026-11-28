"""Email from Accounting (S18, S44, S51): the company's own SMTP server (Setup, Company details, Email), and an
outbox. Every email is queued first (table email_queue) and then sent; one that can't be sent stays in the outbox
with the reason, to send again later (Setup, Email outbox)."""
import html
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
    try:   # Business details & branding: the business's logo, details and footer note on every email
        from .branding import business_brand
        brand = business_brand(db)
    except Exception:  # noqa: BLE001 - never let branding stop an email going out
        brand = None
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
            branded(m, r["body"], brand, _footer_kind(db, r))
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


EMAIL_FOOTER_KINDS = {"statement": "statement", "booking_reminder": "booking", "booking_confirmation": "booking",
                      "booking_reminder_now": "booking",
                      "receipt": "receipt", "payslip": "payslip"}


def _footer_kind(db, r):
    kind = r["kind"] or ""
    if kind == "document" and r["ref_id"]:
        try:
            from .pdf import footer_kind
            d = db.execute("SELECT side, status, kind FROM documents WHERE id=?", (r["ref_id"],)).fetchone()
            return footer_kind(d) if d else None
        except Exception:  # noqa: BLE001
            return None
    return EMAIL_FOOTER_KINDS.get(kind)


def signature(brand):
    """The plain-text lines under an email: the business's legal name, tax number and contact details."""
    if not brand:
        return ""
    lines = [brand["legal_name"], brand["tax_line"], ", ".join(brand["address_lines"]), *brand["contact_lines"]]
    lines = [x for x in lines if x]
    return ("\n\n--\n" + "\n".join(lines)) if lines else ""


def branded(m, body, brand, kind=None):
    """The message's plain text, plus an HTML copy with the business's logo, name, tax number, contact details and
    footer note (the logo travels inside the email, so it shows without downloading pictures)."""
    note = (brand or {}).get("footers", {}).get(kind) if kind else ""
    text = body + (f"\n\n{note}" if note else "") + signature(brand)
    m.set_content(text)
    if not brand:
        return m
    e = html.escape
    accent = brand["accent"]
    logo = brand["logo"] if brand["has_logo"] and brand["logo"]["mime"] in ("image/png", "image/jpeg") else None
    cid = make_msgid(domain="logo.riyeser")[1:-1] if logo else None
    w, h = 0, 0
    if logo:
        from .branding import fit
        w, h = (round(v) for v in fit(brand["logo_ratio"], 220, 64))
    head = (f'<img src="cid:{cid}" width="{w}" height="{h}" alt="{e(brand["name"])}" '
            f'style="display:block;border:0;width:{w}px;height:{h}px;margin:0 0 10px">' if logo else "")
    details = [brand["legal_name"], brand["tax_line"], ", ".join(brand["address_lines"]),
               " · ".join(brand["contact_lines"])]
    paras = "".join(f'<p style="margin:0 0 12px">{e(p).replace(chr(10), "<br>")}</p>'
                    for p in body.split("\n\n") if p.strip())
    out = (
        '<!doctype html><html><body style="margin:0;padding:0;background:#f4f6fa">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa">'
        '<tr><td align="center" style="padding:24px 12px">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;'
        f'background:#ffffff;border-top:4px solid {accent};border-radius:6px;font:15px/1.5 Arial,Helvetica,sans-serif;color:#1c2430">'
        f'<tr><td style="padding:24px 28px 8px">{head}'
        f'<div style="font-size:18px;font-weight:bold;color:{accent};word-break:break-word">{e(brand["name"])}</div></td></tr>'
        f'<tr><td style="padding:12px 28px 8px">{paras}'
        + (f'<p style="margin:16px 0 0;color:#475467;white-space:pre-line">{e(note)}</p>' if note else "")
        + '</td></tr>'
        '<tr><td style="padding:14px 28px 22px;border-top:1px solid #e4e7ec;font-size:12.5px;color:#667085;word-break:break-word">'
        + "<br>".join(e(x) for x in details if x)
        + '</td></tr></table>'
        '<div style="font:11px Arial,Helvetica,sans-serif;color:#98a2b3;padding-top:10px">Sent with Riyeser</div>'
        '</td></tr></table></body></html>')
    m.add_alternative(out, subtype="html")
    if logo:
        sub = logo["mime"].split("/")[1]
        m.get_payload()[1].add_related(logo["image"], maintype="image", subtype=sub, cid=f"<{cid}>",
                                       filename=f"logo.{'jpg' if sub == 'jpeg' else 'png'}", disposition="inline")
    return m
