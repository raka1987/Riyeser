"""Riyeser Estimate's tables. Added to every company file by riyeser/db.py migrate() (only adds; safe to run again),
so Invoices, Bookings and Accounting open the same file and see the quotes Estimate makes.

Only the business's own measurements are kept: numbers typed in, lines drawn on its own plans and photos, and the
points it clicked on the map (latitude/longitude). Map imagery is never stored or exported.
"""
import json

from . import seeds


def ensure(db):
    db.execute("""CREATE TABLE IF NOT EXISTS takeoffs (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        contact_id INTEGER REFERENCES contacts(id),
        address TEXT,
        document_id INTEGER REFERENCES documents(id),      -- the quote it made (kept up to date when re-measured)
        booking_job_id INTEGER REFERENCES booking_jobs(id),
        units TEXT,                                        -- metric / imperial; NULL = the company's setting
        templates TEXT,                                    -- JSON list of measure_templates ids applied
        summary_on_pdf INTEGER NOT NULL DEFAULT 1,         -- add a measurements page to the quote PDF
        map_view TEXT,                                     -- JSON {lat, lng, zoom}: where the map was left
        notes TEXT,
        method TEXT,                                       -- how it's measured: manual, plan, map (step 2)
        adjust TEXT,                                       -- JSON quick changes on step 5: markup_pct, per-line rate/waste
        sent_at TEXT,                                      -- the quote was emailed or marked as sent
        created_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        quoted_at TEXT)""")
    db.execute("""CREATE TABLE IF NOT EXISTS takeoff_items (
        id INTEGER PRIMARY KEY,
        takeoff_id INTEGER NOT NULL REFERENCES takeoffs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,           -- room, rect, circle, triangle, area, length, count, volume, hours, shape, line,
                                      -- markers, roof, fence (riyeser/measure/geometry.py)
        source TEXT NOT NULL DEFAULT 'manual',   -- manual, plan, map, laser, scan (later: ar)
        label TEXT,
        grp TEXT,                     -- group: colours a set of measurements and lets template lines pick them
        color TEXT,
        data TEXT NOT NULL,           -- JSON, all lengths in metres
        plan_id INTEGER REFERENCES takeoff_plans(id) ON DELETE CASCADE,
        page INTEGER,
        verified INTEGER NOT NULL DEFAULT 0,     -- checked on site (map and plan figures are estimates until then)
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("CREATE INDEX IF NOT EXISTS takeoff_items_takeoff ON takeoff_items(takeoff_id)")
    db.execute("""CREATE TABLE IF NOT EXISTS takeoff_plans (
        id INTEGER PRIMARY KEY,
        takeoff_id INTEGER NOT NULL REFERENCES takeoffs(id) ON DELETE CASCADE,
        name TEXT, mime TEXT NOT NULL, data BLOB NOT NULL, pages INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS takeoff_plan_pages (
        plan_id INTEGER NOT NULL REFERENCES takeoff_plans(id) ON DELETE CASCADE,
        page INTEGER NOT NULL,
        scale REAL,                   -- metres per drawing unit (PDF points at 100%, or image pixels)
        scale_note TEXT,              -- how it was set: "1:100" or "line of 3.6 m"
        width REAL, height REAL,      -- the page's size in drawing units
        snapshot BLOB,                -- PNG of the page with the drawn lines (the business's own plan), for the PDF
        PRIMARY KEY (plan_id, page))""")
    db.execute("""CREATE TABLE IF NOT EXISTS takeoff_scans (
        id INTEGER PRIMARY KEY,
        takeoff_id INTEGER NOT NULL REFERENCES takeoffs(id) ON DELETE CASCADE,
        name TEXT,                    -- the file's name
        format TEXT,                  -- what it was read as: RoomPlan USDZ, GLB mesh, DXF floor plan ...
        quality TEXT,                 -- rooms (full rooms), plan, list, mesh (estimated from a 3D mesh)
        size INTEGER NOT NULL DEFAULT 0,
        data BLOB NOT NULL,           -- the file itself, kept with the estimate (up to 100 MB)
        preview BLOB,                 -- float32 triangles (Y up, metres) for the 3D view's "show the scan" layer
        result TEXT,                  -- JSON: the rooms read from it (before editing) and notes
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("CREATE INDEX IF NOT EXISTS takeoff_scans_takeoff ON takeoff_scans(takeoff_id)")
    db.execute("""CREATE TABLE IF NOT EXISTS measure_templates (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        trade TEXT,
        notes TEXT,
        units TEXT NOT NULL DEFAULT 'metric',
        min_charge INTEGER NOT NULL DEFAULT 0,      -- cents: the quote is topped up to this
        shipped INTEGER NOT NULL DEFAULT 0,         -- one of Riyeser's starting templates (still editable)
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("""CREATE TABLE IF NOT EXISTS measure_template_lines (
        id INTEGER PRIMARY KEY,
        template_id INTEGER NOT NULL REFERENCES measure_templates(id) ON DELETE CASCADE,
        sort INTEGER NOT NULL DEFAULT 0,
        section TEXT NOT NULL DEFAULT 'Labour',     -- Labour, Materials, Other
        description TEXT NOT NULL,
        basis TEXT NOT NULL,                        -- a quantity (geometry.QUANTITIES) or 'fixed'
        unit TEXT NOT NULL DEFAULT 'each',          -- the unit the rate is per (before factor and packs)
        factor REAL NOT NULL DEFAULT 1,
        waste_pct REAL NOT NULL DEFAULT 0,
        pack_size REAL NOT NULL DEFAULT 0,
        unit_label TEXT,
        group_filter TEXT,
        rate INTEGER,                               -- cents per unit (or per pack); NULL = the stock item's price
        cost INTEGER,                               -- what it costs the business per unit (for profit; never printed)
        min_charge INTEGER NOT NULL DEFAULT 0,
        item_id INTEGER REFERENCES items(id))""")
    have = {r["name"] for r in db.execute("PRAGMA table_info(company)")}
    for col, ddl in (("measure_units", "TEXT"),                          # metric / imperial (NULL: from the country)
                     ("tax_name", "TEXT NOT NULL DEFAULT 'GST'"),         # what the tax is called (GST, VAT, sales tax)
                     ("date_format", "TEXT NOT NULL DEFAULT 'iso'"),      # iso, dmy, mdy
                     ("map_provider", "TEXT NOT NULL DEFAULT 'esri'")):    # esri (Google, Nearmap later)
        if col not in have:
            db.execute(f"ALTER TABLE company ADD COLUMN {col} {ddl}")
    if "measure_line" not in {r["name"] for r in db.execute("PRAGMA table_info(document_lines)")}:
        db.execute("ALTER TABLE document_lines ADD COLUMN measure_line INTEGER")   # made by Estimate (re-measure updates these)
    if "options" not in {r["name"] for r in db.execute("PRAGMA table_info(takeoffs)")}:
        # JSON Good / Better / Best: {"list": [{"name", "templates", "adjust"}], "recommended": index} (NULL: one price)
        db.execute("ALTER TABLE takeoffs ADD COLUMN options TEXT")
    db.execute("""CREATE TABLE IF NOT EXISTS takeoff_photos (
        id INTEGER PRIMARY KEY,
        takeoff_id INTEGER NOT NULL REFERENCES takeoffs(id) ON DELETE CASCADE,
        name TEXT,                    -- the file's name
        mime TEXT NOT NULL,           -- image/jpeg or image/png
        size INTEGER NOT NULL DEFAULT 0,
        width INTEGER, height INTEGER,
        data BLOB NOT NULL,           -- the photo (big ones shrunk to 2400 px on the long side); never drawn on
        markup TEXT,                  -- JSON: the arrows, circles, boxes, lines and labels drawn on it (photos.py)
        flat BLOB,                    -- JPEG of the photo with its markup, for the quote PDF (NULL: no markup)
        caption TEXT,
        on_pdf INTEGER NOT NULL DEFAULT 1,       -- put it on the quote PDF
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("CREATE INDEX IF NOT EXISTS takeoff_photos_takeoff ON takeoff_photos(takeoff_id)")
    # Options on a quote (Good / Better / Best; riyeser/quote_options.py): every option's lines and totals. The
    # quote's own lines are the recommended option's, then the chosen one's once the customer accepts.
    db.execute("""CREATE TABLE IF NOT EXISTS document_options (
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        n INTEGER NOT NULL,           -- 1, 2, 3
        name TEXT NOT NULL,
        recommended INTEGER NOT NULL DEFAULT 0,
        lines TEXT NOT NULL,          -- JSON: the option's document lines (as save_document takes them)
        subtotal INTEGER NOT NULL DEFAULT 0, tax_total INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (document_id, n))""")
    if "chosen_option" not in {r["name"] for r in db.execute("PRAGMA table_info(documents)")}:
        db.execute("ALTER TABLE documents ADD COLUMN chosen_option INTEGER")   # the option the customer accepted


IMPERIAL_COUNTRIES = {"US", "USA", "UNITED STATES", "LR", "LIBERIA", "MM", "MYANMAR"}


def company_units(company):
    """The company's measuring units: its setting (Estimate's Settings), else imperial when the company's country is
    the US (or Liberia, Myanmar), else metric."""
    u = (company or {}).get("measure_units") if company else None
    if u in ("metric", "imperial"):
        return u
    country = str((company or {}).get("country") or "").strip().upper()
    if country in IMPERIAL_COUNTRIES:
        return "imperial"
    return "metric"   # the currency doesn't decide it: plenty of US-dollar countries measure in metres


def takeoff_units(takeoff, company):
    return takeoff["units"] if takeoff and takeoff["units"] in ("metric", "imperial") else company_units(company)


def seed_templates(db, system="metric"):
    """Riyeser's starting templates, once per company file (for its units). Returns how many were added."""
    if db.execute("SELECT 1 FROM measure_templates WHERE shipped=1 AND units=? LIMIT 1", (system,)).fetchone():
        return 0
    n = 0
    for name, trade, notes, lines in seeds.template_rows(system):
        tid = db.execute("INSERT INTO measure_templates (name, trade, notes, units, shipped) VALUES (?,?,?,?,1)",
                         (name, trade, notes, system)).lastrowid
        for ln in lines:
            save_line(db, tid, ln)
        n += 1
    return n


LINE_FIELDS = ("sort", "section", "description", "basis", "unit", "factor", "waste_pct", "pack_size", "unit_label",
               "group_filter", "rate", "cost", "min_charge", "item_id")


def save_line(db, template_id, ln, line_id=None):
    vals = [ln.get(k) for k in LINE_FIELDS]
    if line_id:
        db.execute(f"UPDATE measure_template_lines SET {', '.join(k + '=?' for k in LINE_FIELDS)} WHERE id=? AND template_id=?",
                   vals + [line_id, template_id])
        return line_id
    return db.execute(f"INSERT INTO measure_template_lines (template_id, {', '.join(LINE_FIELDS)}) VALUES (?, {', '.join('?' * len(LINE_FIELDS))})",
                      [template_id] + vals).lastrowid


def template(db, tid):
    t = db.execute("SELECT * FROM measure_templates WHERE id=?", (tid,)).fetchone()
    if not t:
        return None, []
    lines = [dict(r) for r in db.execute("SELECT * FROM measure_template_lines WHERE template_id=? ORDER BY sort, id", (tid,))]
    return dict(t), lines


def items_of(db, takeoff_id):
    out = []
    for r in db.execute("SELECT * FROM takeoff_items WHERE takeoff_id=? ORDER BY sort, id", (takeoff_id,)):
        d = dict(r)
        try:
            d["data"] = json.loads(r["data"] or "{}")
        except ValueError:
            d["data"] = {}
        d["group"] = d.get("grp") or ""
        out.append(d)
    return out


def template_ids(takeoff):
    try:
        v = json.loads(takeoff["templates"] or "[]")
        return [int(x) for x in v if str(x).isdigit() or isinstance(x, int)]
    except (ValueError, TypeError):
        return []
