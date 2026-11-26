"""Riyeser Bookings, on site: the worker's job sheet for a visit.

What a worker records on a visit, all kept in the company file (like stock item photos, so a backup or a copy of
the company file carries everything with it):
  * Start / Finish times (bookings.arrived_at / left_at); Finish logs the time on site as labour (booking_time.site=1)
  * a checklist per job type (booking_services.checklist, one item a line), ticked per visit (booking_checks)
  * notes (bookings.site_notes) and parts (booking_materials, as before)
  * before / after photos with captions (booking_photos), shrunk to at most PHOTO_MAX px, with a thumbnail
  * the customer's sign-off: name, time and signature image (booking_signoffs). A signed visit is locked; a manager
    can unlock it, which is recorded (who, when, why) and keeps the old signature.
Labour can be charged per job type or per staff member (booking_services.labour_rate, booking_resources.labour_rate),
else at the company's hourly labour rate.
"""
import io
from datetime import datetime

PHOTO_MAX = 1600      # longest side, px
THUMB_MAX = 360
MAX_UPLOAD = 25_000_000   # bytes, one photo as sent (the browser shrinks it first when it can)
MAX_SIGNATURE = 600_000
PHOTO_KINDS = [("before", "Before"), ("after", "After"), ("other", "Other")]


def ensure_schema(db):
    """Additive only: new columns and tables. Safe to run repeatedly."""
    def cols(t):
        return {r["name"] for r in db.execute(f"PRAGMA table_info({t})")}
    for table, col, ddl in (("booking_services", "checklist", "TEXT"),        # one item a line
                            ("booking_services", "labour_rate", "INTEGER"),   # cents/hour inc GST; empty = staff/company
                            ("booking_resources", "labour_rate", "INTEGER"),  # cents/hour inc GST; empty = company
                            ("bookings", "arrived_at", "TEXT"), ("bookings", "left_at", "TEXT"),
                            ("bookings", "site_notes", "TEXT"),
                            ("booking_time", "site", "INTEGER NOT NULL DEFAULT 0")):  # 1 = from Start / Finish
        if col not in cols(table):
            db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
    db.execute("""CREATE TABLE IF NOT EXISTS booking_checks (
        id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id),
        job_id INTEGER REFERENCES booking_jobs(id), pos INTEGER NOT NULL DEFAULT 0, item TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0, done_at TEXT, user_id INTEGER REFERENCES users(id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS booking_photos (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES booking_jobs(id),
        booking_id INTEGER REFERENCES bookings(id), kind TEXT NOT NULL DEFAULT 'before', caption TEXT,
        mime TEXT NOT NULL, data BLOB NOT NULL, thumb BLOB, width INTEGER, height INTEGER,
        user_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS booking_signoffs (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES booking_jobs(id),
        booking_id INTEGER NOT NULL REFERENCES bookings(id), name TEXT NOT NULL, signed_at TEXT NOT NULL,
        image BLOB NOT NULL, user_id INTEGER REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'signed',   -- signed, unlocked (a manager reopened the sheet)
        unlocked_at TEXT, unlocked_by INTEGER REFERENCES users(id), unlock_reason TEXT)""")
    db.execute("CREATE INDEX IF NOT EXISTS booking_photos_job ON booking_photos(job_id)")
    db.execute("CREATE INDEX IF NOT EXISTS booking_checks_visit ON booking_checks(booking_id)")


def now():
    return datetime.now().replace(microsecond=0)


def checklist_items(text):
    return [line.strip(" -*\t") for line in (text or "").splitlines() if line.strip(" -*\t")]


def signoff(db, bid):
    """The visit's current signature (None when not signed, or a manager unlocked it)."""
    return db.execute("SELECT s.*, u.username who FROM booking_signoffs s LEFT JOIN users u ON u.id=s.user_id"
                      " WHERE s.booking_id=? AND s.status='signed' ORDER BY s.id DESC LIMIT 1", (bid,)).fetchone()


def is_signed(db, bid):
    return bool(bid and db.execute("SELECT 1 FROM booking_signoffs WHERE booking_id=? AND status='signed'",
                                   (bid,)).fetchone())


def signed_note(db, jid):
    """For the job's invoice: who signed the job sheet, and when (empty when nobody has)."""
    rows = db.execute("SELECT name, signed_at FROM booking_signoffs WHERE job_id=? AND status='signed' ORDER BY id",
                      (jid,)).fetchall()
    return " ".join(f"Job sheet signed by {r['name']} on {datetime.fromisoformat(r['signed_at']):%d %b %Y}."
                    for r in rows)


def site_minutes(arrived, left):
    a, b = datetime.fromisoformat(arrived), datetime.fromisoformat(left)
    return max(1, round((b - a).total_seconds() / 60))


def nice_minutes(m):
    m = int(m or 0)
    h, mm = divmod(m, 60)
    return (f"{h} h " if h else "") + (f"{mm} min" if mm or not h else "").strip()


# ---------------------------------------------------------------- photos and signatures

def shrink(data, max_px=PHOTO_MAX):
    """(jpeg bytes, thumbnail bytes, width, height). The photo is turned the right way up, shrunk to max_px on its
    longest side and saved as JPEG. Raises ValueError for something that isn't a picture."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except (UnidentifiedImageError, OSError, ValueError):
        raise ValueError("That file isn't a photo the app can read. Use a JPG or PNG photo.")
    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "L"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[-1])
        im = bg
    im.thumbnail((max_px, max_px))
    out = io.BytesIO()
    im.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
    th = im.copy()
    th.thumbnail((THUMB_MAX, THUMB_MAX))
    tout = io.BytesIO()
    th.convert("RGB").save(tout, "JPEG", quality=80)
    return out.getvalue(), tout.getvalue(), im.width, im.height


def signature_png(data_url):
    """The PNG bytes from the signature pad's data URL. Raises ValueError when it's empty or not a PNG."""
    import base64
    import binascii
    raw = (data_url or "").strip()
    if not raw.startswith("data:image/png;base64,"):
        raise ValueError("Ask the customer to sign in the box first.")
    try:
        png = base64.b64decode(raw.split(",", 1)[1], validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("The signature couldn't be read. Clear it and sign again.")
    if not png.startswith(b"\x89PNG") or len(png) > MAX_SIGNATURE:
        raise ValueError("The signature couldn't be read. Clear it and sign again.")
    try:  # a blank box is refused: there must be some ink
        from PIL import Image
        im = Image.open(io.BytesIO(png))
        im.load()
        (lo, _hi), (_a0, alpha) = im.convert("LA").getextrema()
    except ImportError:
        return png
    except (OSError, ValueError):
        raise ValueError("The signature couldn't be read. Clear it and sign again.")
    if alpha == 0 or lo >= 250:
        raise ValueError("Ask the customer to sign in the box first.")
    return png


# ---------------------------------------------------------------- the job sheet PDF

def job_sheet_pdf(db, jid) -> bytes:
    """Customer, address, each visit's times, work done, checklist, parts, photos and signature."""
    from .pdf import _PDF, FONT, INK, MUTED, LINE, _t
    j = db.execute("SELECT j.*, c.name cname, c.address caddress, c.phone cphone, s.name service FROM booking_jobs j"
                   " LEFT JOIN contacts c ON c.id=j.contact_id LEFT JOIN booking_services s ON s.id=j.service_id"
                   " WHERE j.id=?", (jid,)).fetchone()
    visits = db.execute("SELECT b.*, r.name resource FROM bookings b LEFT JOIN booking_resources r ON r.id=b.resource_id"
                        " WHERE b.job_id=? AND b.status NOT IN ('cancelled','no_show') ORDER BY b.starts_at, b.id",
                        (jid,)).fetchall()
    co = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    pdf = _PDF(co)
    pdf.set_title(f"Job sheet J-{jid:04d}")
    pdf.add_page()
    total = db.execute("SELECT COALESCE(SUM(minutes),0) FROM booking_time WHERE job_id=?", (jid,)).fetchone()[0]
    meta = [("Job", j["title"] or j["service"] or ""), ("Type", j["service"] or "")]
    meta = [(k, v) for k, v in meta if v]
    if visits:
        meta.append(("Date", datetime.fromisoformat(visits[0]["starts_at"]).strftime("%d %b %Y")))
    meta.append(("Time", nice_minutes(total) if total else "-"))
    pdf.header_block("Job sheet", f"J-{jid:04d}", meta)
    addr = j["address"] or (j["caddress"] or "").replace("\n", ", ")
    pdf.party("Customer", j["cname"] or j["title"] or "", "\n".join(x for x in (addr, j["phone"] or j["cphone"]) if x))

    def heading(text):
        if pdf.get_y() > 250:
            pdf.add_page()
        pdf.set_font(FONT, "B", 10.5)
        pdf.set_text_color(*INK)
        pdf.cell(0, 6, _t(text), new_x="LMARGIN", new_y="NEXT")

    def para(text, muted=False):
        pdf.set_font(FONT, "", 9.5)
        pdf.set_text_color(*(MUTED if muted else INK))
        pdf.multi_cell(0, 5, _t(text), new_x="LMARGIN", new_y="NEXT")

    outcomes = {"finished": "Work finished", "return": "Return visit needed", "no_access": "Couldn't get in"}
    for n, v in enumerate(visits, 1):
        pdf.set_draw_color(*LINE)
        pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())
        pdf.ln(2)
        when = datetime.fromisoformat(v["starts_at"])
        heading(f"Visit {n}: {when:%A %d %B %Y}" + (f"  -  {v['resource']}" if v["resource"] else ""))
        times = []
        if v["arrived_at"]:
            times.append(f"Started {datetime.fromisoformat(v['arrived_at']):%H:%M}")
        if v["left_at"]:
            times.append(f"finished {datetime.fromisoformat(v['left_at']):%H:%M}")
        mins = db.execute("SELECT COALESCE(SUM(minutes),0) FROM booking_time WHERE booking_id=?", (v["id"],)).fetchone()[0]
        if mins:
            times.append(f"time on site {nice_minutes(mins)}")
        para(", ".join(times) + "." if times else "No start or finish time recorded.", muted=not times)
        if v["site_notes"] or v["outcome_note"]:
            heading("Work done")
            for t in (v["site_notes"], v["outcome_note"]):
                if t:
                    para(t)
        if v["outcome"]:
            para(outcomes.get(v["outcome"], v["outcome"]), muted=True)
        checks = db.execute("SELECT * FROM booking_checks WHERE booking_id=? ORDER BY pos, id", (v["id"],)).fetchall()
        if checks:
            heading("Checklist")
            pdf.set_font(FONT, "", 9.5)
            for ch in checks:
                pdf.set_text_color(*INK)
                pdf.cell(7, 5.2, "☑" if ch["done"] else "☐")
                pdf.multi_cell(0, 5.2, _t(ch["item"] + ("" if ch["done"] else "  (not done)")),
                               new_x="LMARGIN", new_y="NEXT")
        parts = db.execute("SELECT description, qty FROM booking_materials WHERE booking_id=? ORDER BY id",
                           (v["id"],)).fetchall()
        if parts:
            heading("Parts and materials used")
            pdf.table(["Part", "Qty"], [[p["description"] or "Part", f"{p['qty']:g}"] for p in parts], [150, 28],
                      ["L", "R"])
        photos = db.execute("SELECT id, kind, caption, data, width, height FROM booking_photos WHERE booking_id=?"
                            " ORDER BY CASE kind WHEN 'before' THEN 0 WHEN 'after' THEN 1 ELSE 2 END, id",
                            (v["id"],)).fetchall()
        if photos:
            heading("Photos")
            _photo_grid(pdf, photos)
        s = db.execute("SELECT * FROM booking_signoffs WHERE booking_id=? AND status='signed' ORDER BY id DESC LIMIT 1",
                       (v["id"],)).fetchone()
        if s and pdf.get_y() > 232:  # keep the heading with the signature
            pdf.add_page()
        heading("Customer sign-off")
        if s:
            y = pdf.get_y()
            pdf.image(io.BytesIO(s["image"]), x=pdf.l_margin, y=y, h=24)
            pdf.set_y(y + 25)
            para(f"Signed by {s['name']} on {datetime.fromisoformat(s['signed_at']):%d %b %Y at %H:%M}.")
        else:
            para("Not signed.", muted=True)
        pdf.ln(3)
    if not visits:
        para("No visits on this job yet.", muted=True)
    return bytes(pdf.output())


def _photo_grid(pdf, photos):
    from .pdf import FONT, MUTED, _t
    cols, gap = 3, 4
    w = (pdf.w - pdf.l_margin - pdf.r_margin - gap * (cols - 1)) / cols
    h = w * 0.75
    kinds = dict(PHOTO_KINDS)
    for i in range(0, len(photos), cols):
        row = photos[i:i + cols]
        if pdf.get_y() + h + 12 > 275:
            pdf.add_page()
        y = pdf.get_y()
        for k, p in enumerate(row):
            x = pdf.l_margin + k * (w + gap)
            pw, ph = p["width"] or 4, p["height"] or 3
            scale = min(w / pw, h / ph)
            iw, ih = pw * scale, ph * scale
            pdf.image(io.BytesIO(p["data"]), x=x + (w - iw) / 2, y=y + (h - ih) / 2, w=iw, h=ih)
            pdf.set_xy(x, y + h + 1)
            pdf.set_font(FONT, "", 8)
            pdf.set_text_color(*MUTED)
            pdf.multi_cell(w, 4, _t(kinds.get(p["kind"], "") + (f": {p['caption']}" if p["caption"] else "")))
        pdf.set_y(y + h + 11)
