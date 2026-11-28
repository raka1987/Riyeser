"""Riyeser online connections, on the PC: what websites send (through Riyeser Online's post box) filed in this company
file, and what websites read (catalogue, prices, stock, free times) worked out from it.

Riyeser Central on the business's sync PC claims items from the post box and hands each one to this module through
the local-only API (riyeser/views/online.py, 127.0.0.1 with a per-start token). Each item is filed here once:
online_inbox keeps the post-box id, so the same item handed over again (the 10-minute lease ran out, or Central
stopped before it marked the item done) gives the first answer again and changes nothing.

  booking         a Bookings booking (customer found by email, then phone, or added), checked against the hours
                  and the staff member's other bookings; a clash is refused with the reason
  order           an invoice, a POS sale or a sales order (Online connections settings), lines by SKU, stock taken
                  off, the online payment recorded with the provider's reference (and fee)
  enquiry         a note on the customer's page with a follow-up today (it shows on the Today screen)
  customer        a customer card added or brought up to date (website id, then email, then phone)
  quote_accept    the quote marked accepted online (quotes.record_online_acceptance), then optionally the invoice
                  or the Bookings job
  invoice_payment a payment on the invoice; an unknown invoice or the part over the balance is kept as the
                  customer's credit (never dropped)

Test items (sent with a test key) go through exactly the same checks inside a savepoint that is rolled back: the
website sees a realistic answer, the Online list shows them under Test, and the books never change.
"""
import json
import re
from datetime import date, datetime, time, timedelta, timezone

from .db import audit, fmt_money, linked, round_cents, to_cents, write_txn
from .ledger import PostingError

KINDS = ("booking", "order", "enquiry", "customer", "quote_accept", "invoice_payment")
KIND_LABELS = {"booking": "Booking", "order": "Order", "enquiry": "Enquiry", "customer": "Customer",
               "quote_accept": "Quote accepted", "invoice_payment": "Payment"}
NOTIFY_EVENTS = ("booking.confirmed", "booking.cancelled", "order.ready", "order.completed")
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
SKU_RE = re.compile(r"^[A-Za-z0-9._/-]{1,64}$")

# Country (company.json, from Riyeser Online) -> the time zone a new business most likely works in.
COUNTRY_TZ = {"fj": "Pacific/Fiji", "fiji": "Pacific/Fiji", "au": "Australia/Sydney", "australia": "Australia/Sydney",
              "nz": "Pacific/Auckland", "new zealand": "Pacific/Auckland", "ws": "Pacific/Apia", "samoa": "Pacific/Apia",
              "to": "Pacific/Tongatapu", "tonga": "Pacific/Tongatapu", "vu": "Pacific/Efate", "vanuatu": "Pacific/Efate",
              "pg": "Pacific/Port_Moresby", "papua new guinea": "Pacific/Port_Moresby", "sb": "Pacific/Guadalcanal",
              "solomon islands": "Pacific/Guadalcanal", "gb": "Europe/London", "uk": "Europe/London",
              "united kingdom": "Europe/London", "us": "America/New_York", "united states": "America/New_York"}

DEFAULTS = {
    "order_as": "invoice",          # invoice | pos_sale | sales_order
    "order_prices": "website",      # website (the price the customer saw) | riyeser (this company file's price)
    "booking_status": "pending",    # pending (booked, to confirm) | confirmed; widget bookings always wait
    "quote_after": "nothing",       # nothing | invoice | job
    "payment_account_id": None,     # the bank account online payments go into (None = the default bank account)
    "publish_items": "all",         # all | chosen | none
    "chosen_items": [],
    "publish_services": "all",      # all | chosen | none
    "chosen_services": [],
    "publish_stock": True,
    "timezone": None,               # None = from the business's country, else UTC
    "days_ahead": 30,
    "slot_minutes": 15,
    "min_notice_minutes": 60,
    "hours": None,                  # {"mon": "09:00-17:00", ...}; None = Bookings' hours, Monday to Friday
}
CHOICES = {"order_as": ("invoice", "pos_sale", "sales_order"), "order_prices": ("website", "riyeser"),
           "booking_status": ("pending", "confirmed"), "quote_after": ("nothing", "invoice", "job"),
           "publish_items": ("all", "chosen", "none"), "publish_services": ("all", "chosen", "none")}


class Reject(Exception):
    """The business can't take this (the time is taken, unknown quote...): the website is told why (state, message);
    reason is for the owner only."""
    def __init__(self, state, message, reason=None):
        super().__init__(reason or message)
        self.state, self.message, self.reason = state, message, reason or message


# ---------------------------------------------------------------- tables and settings
def ensure_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS online_inbox (
        id TEXT PRIMARY KEY,                       -- the post box's id (api_inbox.id)
        kind TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0, source TEXT, key_name TEXT,
        received_at TEXT,                          -- when the website sent it (UTC)
        payload TEXT NOT NULL,                     -- what was sent, as JSON (untrusted: always shown escaped)
        status TEXT NOT NULL,                      -- done, rejected, failed (a problem on this PC; tried again)
        state TEXT, reference TEXT, message TEXT,  -- what the website sees
        reason TEXT,                               -- for the business only
        record_type TEXT, record_id INTEGER,       -- booking, document, pos_sale, contact, payment, note
        contact_id INTEGER, customer_name TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        seen_at TEXT,
        filed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    have = {r["name"] for r in db.execute("PRAGMA table_info(online_inbox)")}
    for col, ddl in (("order_request", "INTEGER NOT NULL DEFAULT 0"),   # an enquiry from the website's order button
                     ("converted_type", "TEXT"), ("converted_id", "INTEGER")):   # what the business turned it into
        if col not in have:
            db.execute(f"ALTER TABLE online_inbox ADD COLUMN {col} {ddl}")
    db.execute("CREATE INDEX IF NOT EXISTS online_inbox_filed ON online_inbox(filed_at)")
    db.execute("CREATE INDEX IF NOT EXISTS online_inbox_record ON online_inbox(record_type, record_id)")
    db.execute("""CREATE TABLE IF NOT EXISTS online_outbox (
        id INTEGER PRIMARY KEY, event TEXT NOT NULL, event_id TEXT, data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), sent_at TEXT, error TEXT,
        tries INTEGER NOT NULL DEFAULT 0, test INTEGER NOT NULL DEFAULT 0)""")
    db.execute("""CREATE TABLE IF NOT EXISTS online_customer_refs (
        external_id TEXT PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id),
        marketing_consent INTEGER, tags TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    db.execute("CREATE TABLE IF NOT EXISTS online_settings (key TEXT PRIMARY KEY, value TEXT)")
    # The activity trail (Online → Activity): every sync run that did something, every item, every publish and test,
    # as Riyeser Central on the sync PC reported it. Kept 90 days.
    db.execute("""CREATE TABLE IF NOT EXISTS online_trail (
        id INTEGER PRIMARY KEY, at TEXT NOT NULL,       -- when (UTC, ISO)
        type TEXT NOT NULL,                             -- run, item, publish, test, problem, setup
        status TEXT NOT NULL,                           -- ok, done, rejected, retry, waiting, error, info
        source TEXT, what TEXT NOT NULL, detail TEXT, ref TEXT, pc TEXT, n INTEGER NOT NULL DEFAULT 1,
        uid TEXT UNIQUE)""")
    db.execute("CREATE INDEX IF NOT EXISTS online_trail_at ON online_trail(at)")


def _raw(db, key, default=None):
    r = db.execute("SELECT value FROM online_settings WHERE key=?", (key,)).fetchone()
    if not r:
        return default
    try:
        return json.loads(r["value"])
    except ValueError:
        return default


def _put(db, key, value):
    db.execute("INSERT OR REPLACE INTO online_settings (key, value) VALUES (?,?)", (key, json.dumps(value)))


def default_timezone():
    from . import company_profile
    try:
        c = (company_profile.read().get("country") or "").strip().lower()
    except Exception:
        c = ""
    tz = COUNTRY_TZ.get(c, "UTC")
    return tz if tz_ok(tz) else "UTC"


def default_hours(db):
    r = db.execute("SELECT bookings_hours FROM company WHERE id=1").fetchone()
    h = (r["bookings_hours"] if r and r["bookings_hours"] else "07:00-18:00")
    if not parse_hours(h):
        h = "07:00-18:00"
    return {d: (h if d not in ("sat", "sun") else "") for d in WEEKDAYS}


def settings(db):
    s = dict(DEFAULTS)
    saved = _raw(db, "settings", {}) or {}
    for k in DEFAULTS:
        if k in saved:
            s[k] = saved[k]
    for k, opts in CHOICES.items():
        if s[k] not in opts:
            s[k] = DEFAULTS[k]
    if not s["timezone"] or not tz_ok(s["timezone"]):
        s["timezone"] = default_timezone()
    if not isinstance(s["hours"], dict):
        s["hours"] = default_hours(db)
    s["hours"] = {d: (s["hours"].get(d) or "") if parse_hours(s["hours"].get(d) or "") else "" for d in WEEKDAYS}
    s["days_ahead"] = min(max(int(s["days_ahead"] or 30), 1), 365)
    s["slot_minutes"] = min(max(int(s["slot_minutes"] or 15), 5), 240)
    s["min_notice_minutes"] = min(max(int(s["min_notice_minutes"] or 0), 0), 43200)
    s["chosen_items"] = [int(x) for x in s["chosen_items"] or [] if str(x).isdigit()]
    s["chosen_services"] = [int(x) for x in s["chosen_services"] or [] if str(x).isdigit()]
    return s


def save_settings(db, new):
    cur = settings(db)
    cur.update({k: v for k, v in new.items() if k in DEFAULTS})
    if not tz_ok(cur["timezone"]):
        raise PostingError("Choose a time zone from the list, for example Pacific/Fiji.")
    if cur["payment_account_id"]:
        a = db.execute("SELECT is_bank FROM accounts WHERE id=?", (cur["payment_account_id"],)).fetchone()
        if not a or not a["is_bank"]:
            raise PostingError("Choose a bank account for online payments.")
    for d, h in (cur["hours"] or {}).items():
        if h and not parse_hours(h):
            raise PostingError(f"The hours for {d.capitalize()} should look like 09:00-17:00.")
    _put(db, "settings", cur)
    audit(db, "online_settings", "Online connections settings saved")
    return settings(db)


def tz_ok(name):
    try:
        _tz(name)
        return True
    except Exception:
        return False


# Standard-time offsets (minutes) for the time zones on the settings list. Only used when this PC has no time-zone
# database: Windows has none of its own, and Python's zoneinfo then needs the tzdata package (now bundled in the
# builds). Without either, ZoneInfo("Pacific/Fiji") raised and every minute Riyeser Central's sync got a bare
# "The program answered 500" while publishing free times. Daylight saving isn't followed in this fallback.
FIXED_OFFSETS = {"Pacific/Fiji": 720, "Pacific/Auckland": 720, "Australia/Sydney": 600, "Australia/Melbourne": 600,
                 "Australia/Brisbane": 600, "Australia/Adelaide": 570, "Australia/Darwin": 570, "Australia/Perth": 480,
                 "Australia/Hobart": 600, "Pacific/Apia": 780, "Pacific/Tongatapu": 780, "Pacific/Efate": 660,
                 "Pacific/Port_Moresby": 600, "Pacific/Guadalcanal": 660, "Pacific/Noumea": 660, "Pacific/Tarawa": 720,
                 "Pacific/Honolulu": -600, "Asia/Singapore": 480, "Asia/Kolkata": 330, "Europe/London": 0,
                 "America/New_York": -300, "America/Los_Angeles": -480}
_TZ_CACHE = {}


def _tz(name):
    if not name or name.upper() == "UTC":
        return timezone.utc
    if name in _TZ_CACHE:
        return _TZ_CACHE[name]
    try:
        from zoneinfo import ZoneInfo
        z = ZoneInfo(name)
    except Exception:
        if name not in FIXED_OFFSETS:
            raise ValueError(f"This PC doesn't know the time zone {name}.")
        import logging
        logging.getLogger("riyeser").warning("No time-zone data on this PC for %s: using standard time.", name)
        z = timezone(timedelta(minutes=FIXED_OFFSETS[name]), name)
    _TZ_CACHE[name] = z
    return z


def tz_fallback(name):
    """True when this PC has no time-zone data for name and standard time is used instead (no daylight saving)."""
    z = _tz(name) if tz_ok(name) else None
    return z is not None and z is not timezone.utc and not hasattr(z, "key")


def parse_hours(h):
    """'09:00-17:00' -> (time(9), time(17)); None when it isn't a day's hours."""
    m = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*", h or "")
    if not m:
        return None
    a, b = (int(m.group(1)), int(m.group(2))), (int(m.group(3)), int(m.group(4)))
    if not (0 <= a[0] <= 23 and 0 <= a[1] <= 59 and 0 <= b[0] <= 24 and 0 <= b[1] <= 59):
        return None
    if b == (24, 0):
        b = (23, 59)
    if b[0] > 23 or b <= a:
        return None
    return time(*a), time(*b)


def sync_status(db):
    return _raw(db, "sync_status", {}) or {}


SYNC_STATES = ("not_setup", "waiting", "working", "problem", "off", "offline", "paused")
CLOUD_KEYS = ("keys_active", "widget_keys", "test_keys", "webhooks_active", "webhooks_failing", "last_request_at",
              "requests_24h", "done_total", "catalog_at", "stock_at", "availability_at", "catalog_items", "sync_pc")


def set_sync_status(db, report):
    old = sync_status(db)
    if report.get("state") in ("off", "paused") and old.get("pc") and old.get("pc") != report.get("pc") \
            and old.get("state") not in ("off", "paused") and not sync_view(old).get("stale"):
        return  # a PC that doesn't sync doesn't overwrite what the sync PC (sharing this company file) said
    keep = {k: report.get(k) for k in ("at", "ok", "error", "fix", "pc", "received_today", "last_publish",
                                       "waiting", "failed", "offline", "ref", "checked_at") if k in report}
    if report.get("state") in SYNC_STATES:
        keep["state"] = report["state"]
    if isinstance(report.get("cloud"), dict):
        keep["cloud"] = {k: report["cloud"].get(k) for k in CLOUD_KEYS if k in report["cloud"]}
    _put(db, "sync_status", keep)


def sync_view(sync, now=None):
    """What the Online page's status box says: {state, tone, title, line, fix}. state is what Riyeser Central
    reported (older Centrals: worked out from ok/error); not_setup when nothing has ever been reported."""
    now = now or datetime.now(timezone.utc)
    if not sync.get("at"):
        return dict(state="not_setup", tone="idle")
    st = sync.get("state") or ("problem" if sync.get("ok") is False and not sync.get("offline") else
                               "offline" if sync.get("offline") else "working")
    try:
        at = datetime.fromisoformat(str(sync["at"]).replace("Z", "+00:00"))
        at = at if at.tzinfo else at.replace(tzinfo=timezone.utc)
        stale = (now - at) > timedelta(minutes=15) and st not in ("off", "not_setup", "paused")
    except ValueError:
        stale = False
    tone = {"not_setup": "idle", "waiting": "ok", "working": "ok", "off": "idle", "paused": "idle",
            "offline": "warn", "problem": "err"}[st]
    return dict(state=st, tone="warn" if stale else tone, stale=stale)


# ---------------------------------------------------------------- the activity trail
TRAIL_TYPES = ("run", "item", "publish", "test", "problem", "setup")
TRAIL_STATUS = ("ok", "done", "rejected", "retry", "waiting", "error", "info")
TRAIL_DAYS = 90


def add_trail(db, entries):
    """Entries from Riyeser Central's sync-report. Each one once (uid); quiet runs come merged (n = how many)."""
    for e in (entries or [])[:500]:
        if not isinstance(e, dict) or e.get("type") not in TRAIL_TYPES:
            continue
        at = _utc(e.get("at"))
        if not at:
            continue
        n = e.get("n") if isinstance(e.get("n"), int) and 0 < e.get("n") < 100000 else 1
        db.execute("""INSERT INTO online_trail (at, type, status, source, what, detail, ref, pc, n, uid)
                      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET at=excluded.at, n=excluded.n,
                      status=excluded.status, what=excluded.what, detail=excluded.detail""",
                   (_iso_z(at), e["type"], e.get("status") if e.get("status") in TRAIL_STATUS else "info",
                    _s(e.get("source"), 120) or None, _s(e.get("what"), 300) or "-", _s(e.get("detail"), 500) or None,
                    _s(e.get("ref"), 64) or None, _s(e.get("pc"), 80) or None, n, _s(e.get("uid"), 80) or None))
    db.execute("DELETE FROM online_trail WHERE at < ?", (_iso_z(datetime.now(timezone.utc) - timedelta(days=TRAIL_DAYS)),))


def trail(db, day=None, status=None, kind=None, limit=500):
    where, args = ["1=1"], []
    if day:
        where.append("substr(at,1,10)=?")
        args.append(day)
    if status == "problems":
        where.append("status IN ('error','rejected','retry')")
    elif status in TRAIL_STATUS:
        where.append("status=?")
        args.append(status)
    if kind in TRAIL_TYPES:
        where.append("type=?")
        args.append(kind)
    return db.execute(f"SELECT * FROM online_trail WHERE {' AND '.join(where)} ORDER BY at DESC, id DESC LIMIT ?",
                      (*args, limit)).fetchall()


# ---------------------------------------------------------------- "Send a test" from the Online page
# The Online page can't reach Riyeser Online itself: it asks Riyeser Central (test_request in /online/api/status),
# Central sends a test through the post box (api_send_test) and brings it in like any other item, as a test.
def test_request(db):
    r = _raw(db, "test_request")
    if not isinstance(r, dict) or r.get("sent_at") or r.get("error"):
        return None
    try:
        if datetime.now(timezone.utc) - datetime.fromisoformat(r["at"]) > timedelta(minutes=30):
            return None
    except (KeyError, ValueError, TypeError):
        return None
    return {k: r.get(k) for k in ("id", "kind", "at")}


def ask_for_test(db, kind):
    import secrets
    kind = kind if kind in ("booking", "enquiry", "order") else "enquiry"
    r = dict(id=secrets.token_hex(8), kind=kind, at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    _put(db, "test_request", r)
    return r


def test_sent(db, report):
    r = _raw(db, "test_request")
    if isinstance(r, dict) and r.get("id") == report.get("request_id"):
        r.update(sent_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 event_id=_s(report.get("event_id"), 64) or None, error=_s(report.get("error"), 300) or None)
        _put(db, "test_request", r)


def test_progress(db):
    """Where the last "Send a test" is: asked → sent (in the post box) → arrived here (filed as a test)."""
    r = _raw(db, "test_request")
    if not isinstance(r, dict):
        return dict(step="none")
    out = dict(id=r.get("id"), kind=r.get("kind"), at=r.get("at"), error=r.get("error"))
    if r.get("error"):
        return dict(out, step="error")
    if r.get("event_id"):
        row = db.execute("SELECT id, status, reference, message, filed_at FROM online_inbox WHERE id=?",
                         (r["event_id"],)).fetchone()
        if row:
            return dict(out, step="arrived", status=row["status"], reference=row["reference"], message=row["message"])
        return dict(out, step="sent")
    return dict(out, step="asked")


# ---------------------------------------------------------------- small helpers
def _s(v, n=300):
    return re.sub(r"[\x00-\x1f\x7f]", " ", str(v if v is not None else "")).strip()[:n]


def _digits(v):
    return re.sub(r"\D", "", str(v or ""))


def _money(v):
    """Dollars from the website -> cents (None when not given)."""
    if v is None or v == "":
        return None
    try:
        c = to_cents(str(v))
    except ValueError:
        return None
    return c if c >= 0 else None


def _utc(v):
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _iso_z(d):
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _company(db):
    return db.execute("SELECT * FROM company WHERE id=1").fetchone()


def _gst_code(db):
    c = _company(db)
    code = "GST" if (c is None or c["gst_registered"]) else "FRE"
    r = db.execute("SELECT id FROM tax_codes WHERE code=?", (code,)).fetchone()
    return r["id"] if r else None


def _rate(db, tax_code_id):
    r = db.execute("SELECT rate FROM tax_codes WHERE id=?", (tax_code_id,)).fetchone() if tax_code_id else None
    return (r["rate"] or 0) if r else 0


def _income_account(db):
    r = db.execute("SELECT account_id id FROM linked_accounts WHERE key='default_income'").fetchone() or \
        db.execute("SELECT id FROM accounts WHERE type='income' AND active=1 ORDER BY code").fetchone()
    return r["id"] if r else None


def payment_account(db, s=None):
    s = s or settings(db)
    if s["payment_account_id"]:
        a = db.execute("SELECT id FROM accounts WHERE id=? AND is_bank=1 AND active=1", (s["payment_account_id"],)).fetchone()
        if a:
            return a["id"]
    return linked(db, "default_bank")


def _fees_account(db):
    r = db.execute("SELECT id FROM accounts WHERE code='6-1100'").fetchone() or \
        db.execute("SELECT id FROM accounts WHERE type='expense' AND name LIKE '%Bank Fee%' ORDER BY code").fetchone()
    if r:
        return r["id"]
    tc = db.execute("SELECT id FROM tax_codes WHERE code='FRE'").fetchone()
    return db.execute("INSERT INTO accounts (code, name, type, is_bank, tax_code_id) VALUES ('6-1100','Bank Fees',"
                      "'expense',0,?)", (tc["id"] if tc else None,)).lastrowid


def _address(a):
    if isinstance(a, str):
        return _s(a, 500) or None
    if not isinstance(a, dict):
        return None
    tail = " ".join(x for x in (_s(a.get("city"), 80), _s(a.get("region"), 80), _s(a.get("postcode"), 20)) if x)
    parts = [_s(a.get("line1"), 200), _s(a.get("line2"), 200), tail, _s(a.get("country"), 80)]
    return ", ".join(p for p in parts if p) or None


def person_name(p):
    p = p if isinstance(p, dict) else {}
    return _s(p.get("company") or p.get("name"), 120) or _s(p.get("email"), 120) or _s(p.get("phone"), 40)


def find_customer(db, person, external_id=None):
    """A customer card for this person: the website's id, then the email, then the phone. None when there's none."""
    p = person if isinstance(person, dict) else {}
    if external_id:
        r = db.execute("SELECT r.contact_id FROM online_customer_refs r JOIN contacts c ON c.id=r.contact_id"
                       " WHERE r.external_id=?", (_s(external_id, 64),)).fetchone()
        if r:
            return r["contact_id"]
    email = _s(p.get("email"), 200).lower()
    if email:
        r = db.execute("SELECT id FROM contacts WHERE kind='customer' AND LOWER(TRIM(email))=? ORDER BY active DESC, id"
                       " LIMIT 1", (email,)).fetchone()
        if r:
            return r["id"]
    ph = _digits(p.get("phone"))
    if len(ph) >= 6:
        for r in db.execute("SELECT id, phone FROM contacts WHERE kind='customer' AND phone IS NOT NULL AND phone<>''"
                            " ORDER BY active DESC, id"):
            if _digits(r["phone"]).endswith(ph[-9:]) or ph.endswith(_digits(r["phone"])[-9:] or "x"):
                if len(_digits(r["phone"])) >= 6:
                    return r["id"]
    return None


def customer_for(db, person, external_id=None, update=False):
    """(contact_id, created). A new card is made from what was sent; an existing one only has its blanks filled in,
    unless update (a customer sent on its own: what's given replaces what's there)."""
    p = person if isinstance(person, dict) else {}
    cid = find_customer(db, p, external_id)
    name, company = _s(p.get("name"), 120), _s(p.get("company"), 120)
    vals = {"name": company or name, "contact_person": name if company else None,
            "email": _s(p.get("email"), 200).lower() or None, "phone": _s(p.get("phone"), 40) or None,
            "address": _address(p.get("address"))}
    if not vals["name"]:
        vals["name"] = vals["email"] or vals["phone"]
    if not vals["name"]:
        raise Reject("invalid", "We need a name, email or phone number.")
    if cid is None:
        cid = db.execute("INSERT INTO contacts (kind, name, contact_person, email, phone, address, notes) VALUES"
                         " ('customer',?,?,?,?,?,?)", (vals["name"], vals["contact_person"], vals["email"], vals["phone"],
                                                       vals["address"], _s(p.get("notes"), 1000) or None)).lastrowid
        created = True
    else:
        created = False
        for col, v in vals.items():
            if v is None:
                continue
            if update:
                db.execute(f"UPDATE contacts SET {col}=? WHERE id=?", (v, cid))
            else:
                db.execute(f"UPDATE contacts SET {col}=? WHERE id=? AND ({col} IS NULL OR TRIM({col})='')", (v, cid))
        if update and _s(p.get("notes"), 1000):
            db.execute("UPDATE contacts SET notes=TRIM(COALESCE(notes,'') || char(10) || ?) WHERE id=?",
                       (_s(p.get("notes"), 1000), cid))
        if update:
            db.execute("UPDATE contacts SET active=1 WHERE id=?", (cid,))
    return cid, created


def _first(name):
    return (name or "").split(" ")[0] or "there"


# ---------------------------------------------------------------- filing one item
def import_item(db, item):
    """File one post-box item. Returns {id, outcome: done|rejected|retry, result: {reference, state, message},
    reason, kind, test, replay}. Never raises for a bad item; a problem on this PC (database busy, a setting
    missing) is outcome 'retry' so Central puts it back in the post box to be tried again."""
    eid = _s(item.get("id"), 64)
    kind = item.get("kind")
    test = bool(item.get("test"))
    if not eid or kind not in KINDS or not isinstance(item.get("payload"), dict):
        return dict(id=eid, outcome="rejected", kind=kind, test=test, reason="Not an item this program understands.",
                    result=dict(state="invalid", message="We couldn't read this request."))
    write_txn(db)
    have = db.execute("SELECT * FROM online_inbox WHERE id=?", (eid,)).fetchone()
    if have and have["status"] in ("done", "rejected"):  # handed over again: the first answer, nothing filed twice
        db.rollback()
        return _answer(have, replay=True)
    attempts = (have["attempts"] if have else 0) + 1
    payload = item["payload"]
    db.execute("SAVEPOINT online_item")
    try:
        out = HANDLERS[kind](db, payload, item)
        status, state, ref, msg, reason = "done", out["state"], out.get("reference"), out.get("message"), out.get("reason")
    except Reject as e:
        db.execute("ROLLBACK TO online_item")
        out = {}
        status, state, ref, msg, reason = "rejected", e.state, None, e.message, e.reason
    except Exception as e:  # PostingError and anything unexpected: not the customer's fault, try again later
        db.execute("ROLLBACK TO online_item")
        db.execute("RELEASE online_item")
        reason = str(e) or type(e).__name__
        _record(db, eid, item, "failed", None, None, None, reason, {}, attempts)
        db.commit()
        return dict(id=eid, outcome="retry", kind=kind, test=test, reason=reason[:500], result=None)
    if test:  # a test: every check ran, nothing is kept
        db.execute("ROLLBACK TO online_item")
        db.execute("RELEASE online_item")
        out = {}
        ref = f"TEST-{ref}" if ref else None
        msg = msg and (msg + " (test)")[:300]
        reason = ("Test only: nothing was added to the books. " + (reason or "")).strip()
    else:
        db.execute("RELEASE online_item")
        for ev in out.get("notify") or ():
            notify(db, ev, eid, out.get("notify_data") or {}, test=False)
    _record(db, eid, item, status, state, ref, msg, reason, out, attempts)
    if item["kind"] == "enquiry" and order_request_lines(payload):
        db.execute("UPDATE online_inbox SET order_request=1 WHERE id=?", (eid,))
    if not test and status == "done":
        audit(db, "online_" + kind, f"{eid[:8]} {ref or ''} {person_name(payload.get('customer') or payload)}".strip())
    db.commit()
    return _answer(db.execute("SELECT * FROM online_inbox WHERE id=?", (eid,)).fetchone())


def _record(db, eid, item, status, state, ref, msg, reason, out, attempts):
    p = item["payload"]
    cust = person_name(p.get("customer") if isinstance(p.get("customer"), dict) else
                       p.get("accepted_by") if isinstance(p.get("accepted_by"), dict) else
                       p.get("payer") if isinstance(p.get("payer"), dict) else p)
    db.execute("""INSERT INTO online_inbox (id, kind, test, source, key_name, received_at, payload, status, state,
                  reference, message, reason, record_type, record_id, contact_id, customer_name, attempts)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(id) DO UPDATE SET status=excluded.status, state=excluded.state,
                  reference=excluded.reference, message=excluded.message, reason=excluded.reason,
                  record_type=excluded.record_type, record_id=excluded.record_id, contact_id=excluded.contact_id,
                  attempts=excluded.attempts, updated_at=datetime('now','localtime')""",
               (item["id"], item["kind"], 1 if item.get("test") else 0, _s(item.get("source"), 20) or None,
                _s(item.get("key_name"), 80) or None, _s(item.get("created_at"), 40) or None,
                json.dumps(p, ensure_ascii=False)[:200000], status, state, _s(ref, 60) or None, _s(msg, 300) or None,
                _s(reason, 500) or None, out.get("record_type"), out.get("record_id"), out.get("contact_id"),
                cust or None, attempts))


def _answer(row, replay=False):
    outcome = {"done": "done", "rejected": "rejected"}.get(row["status"], "retry")
    res = {k: row[k] for k in ("reference", "state", "message") if row[k]}
    return dict(id=row["id"], outcome=outcome, kind=row["kind"], test=bool(row["test"]), replay=replay,
                result=res if outcome != "retry" else None, reason=row["reason"],
                record_type=row["record_type"], record_id=row["record_id"], customer=row["customer_name"],
                order_request=bool(row["order_request"]))


def import_batch(db, items):
    out = []
    for it in items or []:
        try:
            out.append(import_item(db, it if isinstance(it, dict) else {}))
        except Exception as e:  # the database itself is busy or locked: give it back, tried again soon
            try:
                db.rollback()
            except Exception:
                pass
            out.append(dict(id=(it or {}).get("id") if isinstance(it, dict) else None, outcome="retry",
                            reason=f"This PC couldn't file it just now ({e}).", result=None))
    return out


# ---------------------------------------------------------------- bookings
def service_sku(svc, item_sku=None):
    return item_sku if item_sku and SKU_RE.match(item_sku) else f"SVC-{svc['id']}"


def staff_ref(rid):
    return f"S{rid}"


def _services_by_sku(db):
    out = {}
    for s in db.execute("SELECT s.*, i.sku item_sku FROM booking_services s LEFT JOIN items i ON i.id=s.item_id"
                        " ORDER BY s.active DESC, s.id"):
        out.setdefault(service_sku(s, s["item_sku"]).lower(), s)
        out.setdefault(f"svc-{s['id']}", s)
    return out


def _bookings_mode(db):
    c = _company(db)
    return c["bookings_mode"] if c and c["bookings_mode"] in ("jobs", "appointments", "tables") else "jobs"


LONGEST_BOOKING_DAYS = 14  # a booking can last up to 14 days: one that started that long ago may still be on


def _clash(db, rid, start, minutes):
    end = start + timedelta(minutes=minutes)
    for r in db.execute("SELECT starts_at, minutes FROM bookings WHERE resource_id=? AND status IN"
                        " ('booked','confirmed','started') AND starts_at < ? AND starts_at >= ?",
                        (rid, end.isoformat(timespec="minutes"),
                         (start - timedelta(days=LONGEST_BOOKING_DAYS)).isoformat(timespec="minutes"))):
        if datetime.fromisoformat(r["starts_at"]) + timedelta(minutes=r["minutes"] or 0) > start:
            return True
    return False


def _within_hours(s, local_start, local_end):
    h = parse_hours(s["hours"].get(WEEKDAYS[local_start.weekday()]) or "")
    if not h or local_end.date() != local_start.date():
        return False
    return h[0] <= local_start.time() and local_end.time() <= h[1]


def file_booking(db, p, item):
    from .views.bookings import plan_check
    s = settings(db)
    tz = _tz(s["timezone"])
    svc = _services_by_sku(db).get(_s(p.get("service"), 64).lower())
    if not svc or not svc["active"]:
        raise Reject("unknown_service", "Sorry, that service can't be booked online any more.",
                     f"No active Bookings service with the code {_s(p.get('service'), 64)!r}.")
    start = _utc(p.get("start"))
    if not start:
        raise Reject("invalid", "We couldn't read the booking time.")
    end = _utc(p.get("end"))
    minutes = int(round((end - start).total_seconds() / 60)) if end and end > start else (svc["minutes"] or 60)
    if minutes <= 0 or minutes > 24 * 60:
        raise Reject("invalid", "We couldn't read how long the booking is.")
    if start < datetime.now(timezone.utc) - timedelta(minutes=5):
        raise Reject("in_the_past", "That time has already passed. Please choose another time.")
    ls = start.astimezone(tz).replace(tzinfo=None)
    le = ls + timedelta(minutes=minutes)
    if not _within_hours(s, ls, le):
        raise Reject("outside_hours", "Sorry, we're not open then. Please choose another time.",
                     f"{ls:%a %d %b %H:%M}-{le:%H:%M} is outside the online booking hours.")
    mode = _bookings_mode(db)
    party = p.get("party_size")
    party = int(party) if isinstance(party, (int, float)) and party > 0 else None
    want = _s(p.get("staff"), 64)
    if want:
        m = re.fullmatch(r"[sS](\d+)", want)
        r = db.execute("SELECT * FROM booking_resources WHERE id=? AND active=1", (int(m.group(1)),)).fetchone() if m else None
        if not r:
            raise Reject("unknown_staff", "Sorry, that person can't be booked online any more.",
                         f"No active staff member {want!r}.")
        pool = [r]
    else:
        pool = db.execute("SELECT * FROM booking_resources WHERE active=1 ORDER BY id").fetchall()
    rid = None
    too_small = False
    for r in pool:
        if party and r["capacity"] and party > r["capacity"]:
            too_small = True
            continue
        if not _clash(db, r["id"], ls, minutes):
            rid = r["id"]
            break
    if pool and rid is None:
        if too_small and not any(not (r["capacity"] and party > r["capacity"]) for r in pool):
            raise Reject("too_many_people", "Sorry, we can't seat that many people at once online. Please call us.")
        raise Reject("slot_taken", "Sorry, that time has just been taken. Please choose another time.",
                     f"{ls:%a %d %b %H:%M} clashes with another booking" + (f" for {pool[0]['name']}." if want else "."))
    plan_check(db)
    cid, _new = customer_for(db, p.get("customer"))
    confirmed = s["booking_status"] == "confirmed" and item.get("source") != "widget"
    status = "confirmed" if confirmed else "booked"
    cust = p.get("customer") or {}
    notes = [f"Booked online{' (website booking form)' if item.get('source') == 'widget' else ''}"
             + (f", their reference {_s(p.get('reference'), 64)}" if p.get("reference") else "") + "."]
    if p.get("notes"):
        notes.append(_s(p.get("notes"), 2000))
    if isinstance(p.get("metadata"), dict) and p["metadata"]:
        notes.append("Details: " + ", ".join(f"{_s(k, 40)}: {_s(v, 100)}" for k, v in list(p["metadata"].items())[:20]))
    title = None if cid else person_name(cust)
    location = _s(p.get("location"), 200) or None
    jid = db.execute("INSERT INTO booking_jobs (contact_id, service_id, title, address, phone, notes)"
                     " VALUES (?,?,?,?,?,?)", (cid, svc["id"], title, location, _s(cust.get("phone"), 40) or None,
                                               "\n".join(notes))).lastrowid
    bid = db.execute("INSERT INTO bookings (contact_id, resource_id, service_id, starts_at, minutes, title, address,"
                     " party, phone, notes, status, job_id, mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (cid, rid, svc["id"], ls.isoformat(timespec="minutes"), minutes, title, location,
                      party if mode == "tables" else None, _s(cust.get("phone"), 40) or None, "\n".join(notes), status,
                      jid, mode)).lastrowid
    from .views.bookings import refresh_job
    refresh_job(db, jid)
    try:
        from .views.bookings import schedule_reminder
        schedule_reminder(db, bid)
    except Exception:
        pass  # a reminder email is a nice extra; it never stops the booking
    when = f"{ls:%a} {ls.day} {ls:%b} at {ls:%H:%M}"
    ref = f"BK-{bid}"
    data = dict(reference=ref, state="confirmed", start=_iso_z(start), end=_iso_z(start + timedelta(minutes=minutes)))
    return dict(state="confirmed" if confirmed else "pending", reference=ref, record_type="booking", record_id=bid,
                contact_id=cid,
                message=(f"Thanks {_first(_s(cust.get('name'), 120))}, your {svc['name']} on {when} is confirmed." if confirmed else
                         f"Thanks {_first(_s(cust.get('name'), 120))}, we've got your request for {svc['name']} on {when}. "
                         "We'll confirm it soon.")[:300],
                notify=["booking.confirmed"] if confirmed else [], notify_data=data)


# ---------------------------------------------------------------- orders
def _item_by_sku(db, sku):
    if not sku:
        return None
    return db.execute("SELECT * FROM items WHERE sku=?", (sku,)).fetchone() or \
        db.execute("SELECT * FROM items WHERE sku=? COLLATE NOCASE", (sku,)).fetchone()


def _check_currency(db, cur, what):
    cur = _s(cur, 3).upper()
    books = (_company(db)["currency"] or "AUD").upper()
    if cur and cur != books:
        raise Reject("wrong_currency", f"Sorry, we couldn't take this {what}: it's in {cur} and we work in {books}. "
                     "Please contact us.", f"Sent in {cur}; the books are in {books}.")


def _order_lines(db, p, s):
    lines, notes = [], []
    tax_default = _gst_code(db)
    gst_on = bool(_company(db)["gst_registered"])
    for n, l in enumerate(p.get("items") or [], 1):
        if not isinstance(l, dict):
            continue
        qty = l.get("quantity")
        if not isinstance(qty, (int, float)) or qty <= 0:
            raise Reject("invalid", f"Line {n} needs a quantity.")
        sku = _s(l.get("sku"), 64)
        it = _item_by_sku(db, sku)
        extra = "; ".join(x for x in [_s(l.get("notes"), 300)] + [_s(o, 100) for o in (l.get("options") or [])[:20]] if x)
        web_price = _money(l.get("unit_price"))
        if it:
            if not it["active"] or not it["is_sold"]:
                raise Reject("not_sold", f"Sorry, {it['name']} isn't for sale any more.", f"{it['sku']} is no longer sold.")
            tax = it["sale_tax_code_id"] or tax_default
            own = round_cents((it["sell_price"] or 0) * (1 + (_rate(db, tax) if gst_on else 0) / 100.0))
            price = web_price if (s["order_prices"] == "website" and web_price is not None) else own
            line = dict(item_id=it["id"], qty=float(qty), unit_price=price, tax_code_id=tax,
                        description=f"{it['name']} ({extra})" if extra else it["name"])
            if not it["income_account_id"]:
                line["account_id"] = _income_account(db)
            lines.append(line)
        else:
            name = _s(l.get("name"), 200)
            if not name:
                raise Reject("unknown_item", "Sorry, something in your order isn't on our list any more.",
                             f"Unknown SKU {sku!r} and no name.")
            if web_price is None:
                raise Reject("unknown_item", f"Sorry, we couldn't price {name}. Please contact us.",
                             f"{name}: no SKU we know and no price.")
            rate = l.get("tax_rate")
            tax = tax_default
            if isinstance(rate, (int, float)) and rate == 0:
                r = db.execute("SELECT id FROM tax_codes WHERE code='FRE'").fetchone()
                tax = r["id"] if r else tax_default
            lines.append(dict(qty=float(qty), unit_price=web_price, tax_code_id=tax, account_id=_income_account(db),
                              description=f"{name} ({extra})" if extra else name))
            if sku:
                notes.append(f"{name}: the website's code {sku} isn't one of our items.")
    if not lines:
        raise Reject("invalid", "The order has no items.")
    t = p.get("totals") if isinstance(p.get("totals"), dict) else {}
    ship, disc = _money(t.get("shipping")), _money(t.get("discount"))
    if ship:
        lines.append(dict(qty=1, unit_price=ship, tax_code_id=tax_default, account_id=_income_account(db),
                          description="Shipping"))
    if disc:
        lines.append(dict(qty=1, unit_price=-disc, tax_code_id=tax_default, account_id=_income_account(db),
                          description="Discount"))
    return lines, notes


def _record_online_payment(db, s, cid, amount, allocations, ref, memo, fee, provider, day):
    from .ledger import record_payment, bank_transaction
    acct = payment_account(db, s)
    pid = record_payment(db, "in", cid, acct, day, allocations, reference=ref or "Online", memo=memo, amount=amount)
    if fee:
        fees = _fees_account(db)
        tax = db.execute("SELECT tax_code_id FROM accounts WHERE id=?", (fees,)).fetchone()["tax_code_id"]
        bank_transaction(db, "spend", acct, day, [dict(account_id=fees, amount=fee, tax_code_id=tax,
                                                       memo=f"{provider or 'Online'} fee")],
                         payee=provider or "Online payments", reference=ref, memo=f"{provider or 'Online'} fee: {memo}",
                         contact_id=None)
    return pid


def _fee(p, pay=None):
    md = p.get("metadata") if isinstance(p.get("metadata"), dict) else {}
    for v in ((pay or {}).get("fee"), p.get("fee"), md.get("fee"), md.get("payment_fee"), md.get("provider_fee")):
        c = _money(v)
        if c:
            return c
    return 0


def _pay_ref(pay):
    return " ".join(x for x in (_s(pay.get("provider"), 40), _s(pay.get("transaction_id"), 100)) if x)[:100] or None


def file_order(db, p, item, order_as=None):
    from .ledger import save_document, check_stock, StockShort
    s = dict(settings(db))
    if order_as:
        s["order_as"] = order_as
    _check_currency(db, p.get("currency"), "order")
    pay = p.get("payment") if isinstance(p.get("payment"), dict) else {}
    if pay.get("currency"):
        _check_currency(db, pay.get("currency"), "order")
    lines, extra_notes = _order_lines(db, p, s)
    try:
        check_stock(db, lines, sell_anyway=True)
    except StockShort as e:
        raise Reject("out_of_stock", "Sorry, something in your order has just sold out. Please contact us.", str(e))
    cid, _ = customer_for(db, p.get("customer"))
    day = date.today().isoformat()
    ful = p.get("fulfilment") if isinstance(p.get("fulfilment"), dict) else {}
    notes = [f"Online order{(' ' + _s(p.get('reference'), 64)) if p.get('reference') else ''}"
             + (f", {_s(ful.get('type'), 20).replace('_', ' ')}" if ful.get("type") else "")
             + (f" at {_s(ful.get('time'), 40)}" if ful.get("time") else "")
             + (f", table {_s(ful.get('table'), 20)}" if ful.get("table") else "") + "."]
    if ful.get("address"):
        notes.append("Deliver to: " + (_address(ful.get("address")) or ""))
    for k in ("notes",):
        if p.get(k):
            notes.append(_s(p.get(k), 2000))
    if ful.get("notes"):
        notes.append(_s(ful.get("notes"), 500))
    notes += extra_notes
    ref = ("Online " + _s(p.get("reference"), 50)).strip()
    status = "order" if s["order_as"] == "sales_order" else "open"
    header = dict(contact_id=cid, date=day, due_date=day, tax_inclusive=True, reference=ref,
                  notes="\n".join(notes)[:2000])
    doc_id = save_document(db, "sale", header, lines, status)
    doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    web_total = _money((p.get("totals") or {}).get("total")) if isinstance(p.get("totals"), dict) else None
    if web_total is not None and abs(web_total - doc["total"]) > 1:
        db.execute("UPDATE documents SET notes=TRIM(COALESCE(notes,'') || char(10) || ?) WHERE id=?",
                   (f"The website's total was {fmt_money(web_total)}.", doc_id))
    paid = pay.get("status") in ("paid", "part_paid")
    amount = _money(pay.get("amount"))
    if paid and amount is None:
        amount = doc["total"] if pay.get("status") == "paid" else 0
    amount = amount or 0
    pid = None
    record_type, record_id = "document", doc_id
    if paid and amount > 0:
        alloc = [] if status == "order" else [(doc_id, min(amount, doc["total"]))]
        pid = _record_online_payment(db, s, cid, amount, alloc, _pay_ref(pay),
                                     f"Online payment {doc['number']}; {person_name(p.get('customer'))}",
                                     _fee(p, pay), _s(pay.get("provider"), 40), day)
    if s["order_as"] == "pos_sale" and status == "open" and pid and amount >= doc["total"]:
        sid = db.execute("INSERT INTO pos_sales (document_id, payment_id, method, tendered, change_given, checkout_ref)"
                         " VALUES (?,?,?,?,0,?)", (doc_id, pid, "online", amount, f"online:{item['id']}")).lastrowid
        record_type, record_id = "pos_sale", sid
    state = "accepted"
    msg = f"Thanks {_first(_s((p.get('customer') or {}).get('name'), 120))}, we've got your order ({doc['number']})."
    if status == "open" and not paid:
        msg += " We'll send the invoice."
    return dict(state=state, reference=doc["number"], message=msg, record_type=record_type, record_id=record_id,
                contact_id=cid)


# ---------------------------------------------------------------- enquiries, customers
def order_request_lines(p):
    """The items of an order request (the website's order button sends an enquiry with order_* metadata):
    [{sku, quantity, unit_price}], or [] when it's an ordinary enquiry. order_sku, order_sku_2, ... are understood."""
    md = p.get("metadata") if isinstance(p, dict) and isinstance(p.get("metadata"), dict) else {}
    out = []
    for n in [""] + [f"_{i}" for i in range(2, 6)]:
        sku = _s(md.get(f"order_sku{n}"), 64)
        if not sku:
            continue
        try:
            q = float(md.get(f"order_quantity{n}") or 1)
        except (TypeError, ValueError):
            q = 1
        price = md.get(f"order_unit_price{n}")
        out.append(dict(sku=sku, quantity=q if q > 0 else 1,
                        unit_price=price if isinstance(price, (int, float)) and price >= 0 else None))
    return out


def file_enquiry(db, p, item):
    lines = order_request_lines(p)
    cid, _ = customer_for(db, p.get("customer"))
    parts = ["Online enquiry" + (f": {_s(p.get('subject'), 200)}" if p.get("subject") else "")]
    parts.append(_s(p.get("message"), 5000))
    extra = []
    if p.get("service"):
        extra.append(f"about {_s(p.get('service'), 64)}")
    if p.get("preferred_contact"):
        extra.append(f"prefers {_s(p.get('preferred_contact'), 10)}")
    if p.get("preferred_time"):
        extra.append(f"best time {_s(p.get('preferred_time'), 120)}")
    if p.get("source_page"):
        extra.append(f"from {_s(p.get('source_page'), 300)}")
    if extra:
        parts.append("(" + ", ".join(extra) + ")")
    today = date.today().isoformat()
    nid = db.execute("INSERT INTO contact_notes (contact_id, date, note, follow_up_on) VALUES (?,?,?,?)",
                     (cid, today, "\n".join(x for x in parts if x)[:6000], today)).lastrowid
    first = _first(_s((p.get('customer') or {}).get('name'), 120))
    if lines:
        db.execute("UPDATE contact_notes SET note='Order request (confirm it in Online orders & bookings). ' || note"
                   " WHERE id=?", (nid,))
        return dict(state="received", reference=f"EQ-{nid}", record_type="note", record_id=nid, contact_id=cid,
                    order_request=True,
                    message=f"Thanks {first}, we've got your order request. We'll confirm it with you soon.")
    return dict(state="received", reference=f"EQ-{nid}", record_type="note", record_id=nid, contact_id=cid,
                message=f"Thanks {first}, we've got your message and will get back to you.")


def file_customer(db, p, item):
    ext = _s(p.get("external_id"), 64) or None
    cid, created = customer_for(db, p, ext, update=True)
    tags = [_s(t, 40) for t in (p.get("tags") or [])[:20] if _s(t, 40)]
    consent = p.get("marketing_consent")
    if ext:
        db.execute("INSERT INTO online_customer_refs (external_id, contact_id, marketing_consent, tags) VALUES (?,?,?,?)"
                   " ON CONFLICT(external_id) DO UPDATE SET contact_id=excluded.contact_id,"
                   " marketing_consent=COALESCE(excluded.marketing_consent, marketing_consent),"
                   " tags=COALESCE(excluded.tags, tags), updated_at=datetime('now','localtime')",
                   (ext, cid, None if consent is None else (1 if consent else 0), json.dumps(tags) if tags else None))
    if consent is not None or tags:
        bits = []
        if consent is not None:
            bits.append("happy to get marketing emails" if consent else "doesn't want marketing emails")
        if tags:
            bits.append("tags: " + ", ".join(tags))
        db.execute("INSERT INTO contact_notes (contact_id, date, note) VALUES (?,?,?)",
                   (cid, date.today().isoformat(), "From the website: " + "; ".join(bits) + "."))
    return dict(state="created" if created else "updated", reference=f"C-{cid}", record_type="contact",
                record_id=cid, contact_id=cid, message="Thanks, your details are saved.")


# ---------------------------------------------------------------- quotes and payments
def _quote_by_ref(db, ref):
    ref = _s(ref, 64)
    return db.execute("SELECT * FROM documents WHERE side='sale' AND status='quote' AND number=?", (ref,)).fetchone() or \
        db.execute("SELECT * FROM documents WHERE side='sale' AND status='quote' AND number=? COLLATE NOCASE",
                   (ref,)).fetchone() if ref else None


def file_quote_accept(db, p, item):
    from .views import quotes as Q
    s = settings(db)
    q = _quote_by_ref(db, p.get("quote_ref"))
    if not q:
        raise Reject("not_found", "Sorry, we couldn't find that quote. Please contact us.",
                     f"No quote numbered {_s(p.get('quote_ref'), 64)!r}.")
    if q["quote_status"] == "declined":
        raise Reject("declined", "This quote was declined. Please contact us for a new one.",
                     f"{q['number']} was marked declined.")
    st = Q.state(q)
    if st == "expired":
        raise Reject("expired", "Sorry, this quote has expired. Please contact us for a new one.",
                     f"{q['number']} was valid until {q['valid_until']}.")
    by = p.get("accepted_by") if isinstance(p.get("accepted_by"), dict) else {}
    name = _s(p.get("signature"), 200) or _s(by.get("name"), 120)
    at = _utc(p.get("accepted_at")) or datetime.now(timezone.utc)
    # a quote with options (Good / Better / Best): the one the customer picked ("option": its name or number, or
    # one of the ticked "options" that is an option's name); none named: the recommended one
    from . import quote_options as QO
    opts = QO.of(db, q["id"])
    picked = None
    if opts:
        if p.get("option") not in (None, ""):
            picked = QO.find(opts, _s(p.get("option"), 64))
            if not picked:
                raise Reject("invalid", "Please choose one of the quote's options: "
                             + ", ".join(o["name"] for o in opts) + ".",
                             f"{q['number']} has no option {_s(p.get('option'), 64)!r}.")
        else:
            picked = next((QO.find(opts, _s(o, 64)) for o in (p.get("options") or [])[:50]
                           if QO.find(opts, _s(o, 64))), None)
    if st != "accepted":
        Q.record_online_acceptance(db, q["id"], name, at=at.astimezone(_tz(s["timezone"])).strftime("%Y-%m-%d %H:%M"),
                                   option=picked["n"] if picked else None)
    note = []
    if opts and st != "accepted":
        chosen = next((o for o in QO.of(db, q["id"]) if o["chosen"]), None)
        if chosen:
            note.append(f"Option chosen: {chosen['name']}" + ("" if picked else " (none named, so the recommended one)"))
    if by.get("name") and _s(by.get("name"), 120) != name:
        note.append(f"Accepted by {_s(by.get('name'), 120)}" + (f" ({_s(by.get('position'), 80)})" if by.get("position") else ""))
    elif by.get("position"):
        note.append(f"Position: {_s(by.get('position'), 80)}")
    for k, label in (("email", "Email"), ("phone", "Phone")):
        if by.get(k):
            note.append(f"{label}: {_s(by.get(k), 120)}")
    if p.get("po_number"):
        note.append(f"Their PO number: {_s(p.get('po_number'), 64)}")
        db.execute("UPDATE documents SET reference=? WHERE id=? AND (reference IS NULL OR reference='')",
                   (_s(p.get("po_number"), 64), q["id"]))
    if p.get("options"):
        note.append("Options chosen: " + ", ".join(_s(o, 64) for o in p["options"][:50]))
    if p.get("note"):
        note.append(_s(p.get("note"), 1000))
    if note:
        db.execute("UPDATE documents SET quote_status_note=TRIM(COALESCE(quote_status_note,'') || char(10) || ?) WHERE id=?",
                   ("Accepted online. " + "; ".join(note), q["id"]))
    ref, rtype, rid = q["number"], "document", q["id"]
    extra = ""
    q = db.execute("SELECT * FROM documents WHERE id=?", (q["id"],)).fetchone()
    if s["quote_after"] == "invoice" and not q["converted_to"]:
        from .ledger import convert_document
        Q.check_convertible(db, q["id"])
        new = convert_document(db, q["id"], "open")
        Q.after_convert(db, q["id"], new)
        rid = new
        ref = db.execute("SELECT number FROM documents WHERE id=?", (new,)).fetchone()[0]
        extra = f" Invoice {ref} is on its way."
    why = None
    if s["quote_after"] == "job" and not q["booking_job_id"]:
        db.execute("SAVEPOINT online_job")
        try:
            jid = Q.make_job(db, q["id"])
            db.execute("RELEASE online_job")
            from .views.bookings import job_no
            rtype, rid, extra = "job", jid, " We'll be in touch to book a time."
            ref = f"{q['number']} / {job_no(jid)}"
        except PostingError as e:  # e.g. the Bookings trial has ended: the quote is still accepted
            db.execute("ROLLBACK TO online_job")
            db.execute("RELEASE online_job")
            why = f"The quote is accepted, but the Bookings job wasn't made: {e}"
    return dict(state="accepted", reference=ref, record_type=rtype, record_id=rid, contact_id=q["contact_id"],
                reason=why, message=f"Thanks, quote {q['number']} is accepted.{extra}")


def file_invoice_payment(db, p, item):
    s = settings(db)
    amount = _money(p.get("amount"))
    if not amount:
        raise Reject("invalid", "We couldn't read the amount.")
    payer = p.get("payer") if isinstance(p.get("payer"), dict) else {}
    ref_no = _s(p.get("invoice_ref"), 64)
    inv = db.execute("SELECT * FROM documents WHERE side='sale' AND kind='invoice' AND number=? AND status<>'void'",
                     (ref_no,)).fetchone() or \
        db.execute("SELECT * FROM documents WHERE side='sale' AND kind='invoice' AND number=? COLLATE NOCASE"
                   " AND status<>'void'", (ref_no,)).fetchone()
    cur = _s(p.get("currency"), 3).upper()
    books = (_company(db)["currency"] or "AUD").upper()
    if cur and cur != books:
        raise Reject("needs_review", "Thanks, we've got your payment details and will check them.",
                     f"A payment of {cur} {p.get('amount')} for {ref_no}: the books are in {books}, so it wasn't "
                     "recorded. Record it by hand once you know what arrived.")
    paid_at = _utc(p.get("paid_at"))
    day = paid_at.astimezone(_tz(s["timezone"])).date().isoformat() if paid_at else date.today().isoformat()
    if day > date.today().isoformat():
        day = date.today().isoformat()
    method = _s(p.get("method"), 20).replace("_", " ")
    ref = " ".join(x for x in (_s(p.get("provider"), 40) or method, _s(p.get("transaction_id"), 100)) if x)[:100]
    unallocated = False
    if inv:
        cid = inv["contact_id"]
        due = inv["total"] - inv["amount_paid"] if inv["status"] == "open" else 0
        alloc = [(inv["id"], min(due, amount))] if due > 0 else []
        unallocated = amount > due
    else:
        unallocated = True
        cid = find_customer(db, payer) if (payer.get("email") or payer.get("name")) else None
        if cid is None and (payer.get("email") or payer.get("name")):
            cid, _ = customer_for(db, payer)
        if cid is None:
            r = db.execute("SELECT id FROM contacts WHERE kind='customer' AND name='Unallocated online payments'").fetchone()
            cid = r["id"] if r else db.execute("INSERT INTO contacts (kind, name, notes) VALUES ('customer',"
                                               " 'Unallocated online payments', 'Payments that came in online for an"
                                               " invoice we couldn''t find.')").lastrowid
        alloc = []
    memo = f"Online payment {ref_no}".strip() + (f"; {_s(payer.get('name'), 120)}" if payer.get("name") else "")
    if p.get("note"):
        memo += f" ({_s(p.get('note'), 200)})"
    pid = _record_online_payment(db, s, cid, amount, alloc, ref or "Online", memo[:300], _fee(p),
                                 _s(p.get("provider"), 40) or method, day)
    why = None
    if unallocated:
        why = (f"{fmt_money(amount)} came in for {ref_no or 'an invoice'}: " +
               ("we couldn't find that invoice, " if not inv else f"{fmt_money(amount - sum(a for _, a in alloc))} more than "
                f"{inv['number']} still owed, ") + "so it's kept as the customer's credit to use or refund.")
    return dict(state="recorded", reference=f"PAY-{pid}", record_type="payment", record_id=pid, contact_id=cid,
                reason=why, message="Thanks, we've received your payment.")


HANDLERS = {"booking": file_booking, "order": file_order, "enquiry": file_enquiry, "customer": file_customer,
            "quote_accept": file_quote_accept, "invoice_payment": file_invoice_payment}


CONVERT_AS = {"sales_order": "Sales order", "invoice": "Invoice", "pos_order": "Order on the till"}


def label(row):
    return "Order request" if row["kind"] == "enquiry" and row["order_request"] else KIND_LABELS.get(row["kind"], row["kind"])


def convert_order_request(db, inbox_id, how):
    """The business confirms an order request: a sales order, an invoice (stock off now, unpaid) or an open order
    on the POS till (paid there). Once only. Returns (type, id)."""
    write_txn(db)
    r = db.execute("SELECT * FROM online_inbox WHERE id=?", (inbox_id,)).fetchone()
    if not r or not r["order_request"] or r["status"] != "done":
        raise PostingError("Only an order request from your website can be turned into an order.")
    if r["test"]:
        raise PostingError("This came from a test key, so it isn't added to your books.")
    if r["converted_id"]:
        raise PostingError("This order request has already been turned into an order.")
    if how not in CONVERT_AS:
        raise PostingError("Choose what to make.")
    p = json.loads(r["payload"])
    req = order_request_lines(p)
    md = p.get("metadata") if isinstance(p.get("metadata"), dict) else {}
    try:
        if how == "pos_order":
            s = settings(db)
            lines, _notes = _order_lines(db, dict(items=req), dict(s, order_prices="riyeser"))
            pos_lines = [dict(item_id=l["item_id"], qty=l["qty"], discount_pct=0, note="Online order request")
                         for l in lines if l.get("item_id")]
            if not pos_lines:
                raise Reject("unknown_item", "", "None of the items are on the till.")
            cid = r["contact_id"] or customer_for(db, p.get("customer"))[0]
            oid = db.execute("INSERT INTO pos_orders (order_type, customer_id, lines, note) VALUES ('retail',?,?,?)",
                             (cid, json.dumps(pos_lines), f"Online order request {r['reference'] or ''}"
                              + (f", {_s(p.get('preferred_time'), 80)}" if p.get("preferred_time") else ""))).lastrowid
            ctype, cid_ = "pos_order", oid
        else:
            out = file_order(db, dict(customer=p.get("customer"), items=req, currency=md.get("order_currency"),
                                      notes="From an order request on your website"
                                      + (f" ({_s(p.get('source_page'), 300)})" if p.get("source_page") else "")
                                      + (f". Wanted: {_s(p.get('preferred_time'), 120)}" if p.get("preferred_time") else ""),
                                      reference=r["reference"]),
                             {"id": inbox_id}, order_as=how)
            ctype, cid_ = "document", out["record_id"]
    except Reject as e:
        raise PostingError(e.reason or e.message)
    db.execute("UPDATE online_inbox SET converted_type=?, converted_id=?, seen_at=COALESCE(seen_at, datetime('now','localtime')),"
               " updated_at=datetime('now','localtime') WHERE id=?", (ctype, cid_, inbox_id))
    audit(db, "online_order_request", f"{inbox_id[:8]} -> {ctype} {cid_}")
    return ctype, cid_


# ---------------------------------------------------------------- later news (api_notify) for Central to send
def notify(db, event, event_id, data, test=False):
    if event not in NOTIFY_EVENTS:
        raise ValueError(event)
    db.execute("INSERT INTO online_outbox (event, event_id, data, test) VALUES (?,?,?,?)",
               (event, event_id, json.dumps(data or {}), 1 if test else 0))


def booking_changed(db, bid, old_status, new_status):
    """A booking that came in online was confirmed or cancelled in Bookings: the website hears about it."""
    if old_status == new_status or new_status not in ("confirmed", "cancelled"):
        return False
    r = db.execute("SELECT id, test FROM online_inbox WHERE record_type='booking' AND record_id=? AND status='done'",
                   (bid,)).fetchone()
    if not r or r["test"]:
        return False
    b = db.execute("SELECT starts_at, minutes FROM bookings WHERE id=?", (bid,)).fetchone()
    s = settings(db)
    tz = _tz(s["timezone"])
    start = datetime.fromisoformat(b["starts_at"]).replace(tzinfo=tz)
    data = dict(reference=f"BK-{bid}", state=new_status, start=_iso_z(start),
                end=_iso_z(start + timedelta(minutes=b["minutes"] or 0)),
                message="Your booking is confirmed." if new_status == "confirmed" else "Your booking has been cancelled.")
    notify(db, f"booking.{new_status}", r["id"], data)
    return True


def order_news(db, inbox_id, what):
    """'ready' or 'completed' for an order that came in online (pressed on its page in the Online list)."""
    r = db.execute("SELECT * FROM online_inbox WHERE id=?", (inbox_id,)).fetchone()
    if not r or r["kind"] != "order" or r["status"] != "done" or what not in ("ready", "completed"):
        raise PostingError("Only an online order can be marked ready or completed.")
    msg = {"ready": "Your order is ready.", "completed": "Your order is complete. Thank you!"}[what]
    notify(db, f"order.{what}", r["id"], dict(reference=r["reference"], state=what, message=msg), test=bool(r["test"]))
    db.execute("UPDATE online_inbox SET state=?, updated_at=datetime('now','localtime') WHERE id=?", (what, r["id"]))


def outbox(db, limit=100):
    return [dict(id=r["id"], event=r["event"], event_id=r["event_id"], data=json.loads(r["data"] or "{}"),
                 test=bool(r["test"]))
            for r in db.execute("SELECT * FROM online_outbox WHERE sent_at IS NULL AND tries < 20 ORDER BY id LIMIT ?",
                                (limit,))]


def outbox_done(db, sent, errors=None):
    for i in sent or []:
        db.execute("UPDATE online_outbox SET sent_at=datetime('now','localtime'), error=NULL WHERE id=?", (int(i),))
    for i, e in (errors or {}).items():
        db.execute("UPDATE online_outbox SET tries=tries+1, error=? WHERE id=?", (_s(e, 300), int(i)))


# ---------------------------------------------------------------- what websites read
def _chosen(rows, how, ids):
    if how == "none":
        return []
    if how == "chosen":
        keep = set(ids)
        return [r for r in rows if r["id"] in keep]
    return rows


def catalog(db, s=None):
    """{items, skipped}: what may be shown on the website (never cost prices), ready for api_publish_catalog."""
    s = s or settings(db)
    c = _company(db)
    cur = (c["currency"] or "AUD").upper()
    gst_on = bool(c["gst_registered"])
    tax_default = _gst_code(db)
    out, skipped, seen = [], [], set()
    svcs = db.execute("SELECT s.*, i.sku item_sku FROM booking_services s LEFT JOIN items i ON i.id=s.item_id"
                      " WHERE s.active=1 ORDER BY s.id").fetchall()
    for sv in _chosen(svcs, s["publish_services"], s["chosen_services"]):
        sku = service_sku(sv, sv["item_sku"])
        if not (1 <= (sv["minutes"] or 0) <= 1440):
            skipped.append(dict(sku=sku, name=sv["name"], reason="Takes longer than a day, so it can't be booked online."))
            continue
        seen.add(sku.lower())
        out.append(dict(sku=sku, type="service", name=_s(sv["name"], 200), description=_s(sv["description"], 2000) or None,
                        price=(sv["price"] or 0) / 100, currency=cur, tax_rate=_rate(db, tax_default) if gst_on else 0,
                        tax_included=True, duration_minutes=sv["minutes"], active=True))
    items = db.execute("SELECT * FROM items WHERE active=1 AND is_sold=1 ORDER BY sku").fetchall()
    for it in _chosen(items, s["publish_items"], s["chosen_items"]):
        if not SKU_RE.match(it["sku"] or ""):
            skipped.append(dict(sku=it["sku"], name=it["name"],
                                reason="Its code has spaces or other characters a website can't use (letters, numbers, "
                                       ". _ / - only)."))
            continue
        if it["sku"].lower() in seen:
            continue  # a service invoiced as this item is published once, as the service
        seen.add(it["sku"].lower())
        tax = it["sale_tax_code_id"] or tax_default
        rate = _rate(db, tax) if gst_on else 0
        out.append(dict(sku=it["sku"], type="product", name=_s(it["name"], 200),
                        description=_s(it["description"], 2000) or None, category=_s(it["category"], 80) or None,
                        price=round_cents((it["sell_price"] or 0) * (1 + rate / 100.0)) / 100, currency=cur,
                        tax_rate=rate, tax_included=True, active=True))
    return dict(items=out, skipped=skipped)


def stock(db, s=None):
    s = s or settings(db)
    if not s["publish_stock"]:
        return dict(levels=[], enabled=False)
    items = db.execute("SELECT * FROM items WHERE active=1 AND is_sold=1 AND is_inventoried=1 ORDER BY sku").fetchall()
    return dict(enabled=True, levels=[dict(sku=i["sku"], quantity=round(i["qty_on_hand"] or 0, 3))
                                      for i in _chosen(items, s["publish_items"], s["chosen_items"])
                                      if SKU_RE.match(i["sku"] or "")])


def _subtract(win, busy):
    """[(start, end)] free parts of win once the busy (start, end) times are taken out."""
    free = [win]
    for b0, b1 in sorted(busy):
        nxt = []
        for f0, f1 in free:
            if b1 <= f0 or b0 >= f1:
                nxt.append((f0, f1))
                continue
            if b0 > f0:
                nxt.append((f0, b0))
            if b1 < f1:
                nxt.append((b1, f1))
        free = nxt
    return [(a, b) for a, b in free if b > a]


def availability(db, s=None, now=None):
    """Bookings' services, staff and FREE windows (working hours less existing bookings) for the next days_ahead
    days, in UTC, for api_publish_availability. Working hours are local to the business's time zone, so daylight
    saving changes are followed."""
    s = s or settings(db)
    tz = _tz(s["timezone"])
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(tz).date()
    days = s["days_ahead"]
    mode = _bookings_mode(db)
    res = db.execute("SELECT * FROM booking_resources WHERE active=1 ORDER BY id").fetchall()
    tables = mode == "tables"
    staff = [] if tables else [dict(ref=staff_ref(r["id"]), name=_s(r["name"], 60), services=[], active=True)
                               for r in res if (r["kind"] or "staff") != "table"]
    from_at = datetime.combine(today, time(0), tzinfo=tz)
    to_at = datetime.combine(today + timedelta(days=days), time(0), tzinfo=tz)
    last = (today + timedelta(days=days + 1)).isoformat()
    busy = {}
    for b in db.execute("SELECT resource_id, starts_at, minutes FROM bookings WHERE resource_id IS NOT NULL AND status IN"
                        " ('booked','confirmed','started') AND starts_at >= ? AND starts_at < ?",
                        ((today - timedelta(days=LONGEST_BOOKING_DAYS)).isoformat(), last)):
        try:
            st = datetime.fromisoformat(str(b["starts_at"]).strip().replace("Z", "")).replace(tzinfo=tz)
        except (TypeError, ValueError):
            continue  # a booking with a time this can't read: it can't block a time it doesn't have
        busy.setdefault(b["resource_id"], []).append((st, st + timedelta(minutes=b["minutes"] or 0)))
    windows = []
    for n in range(days):
        d = today + timedelta(days=n)
        h = parse_hours(s["hours"].get(WEEKDAYS[d.weekday()]) or "")
        if not h:
            continue
        w0 = datetime.combine(d, h[0], tzinfo=tz)
        w1 = datetime.combine(d, h[1], tzinfo=tz)
        for r in res:
            is_table = (r["kind"] or "staff") == "table" or tables
            for a, b in _subtract((w0, w1), busy.get(r["id"], [])):
                a_utc, b_utc = a.astimezone(timezone.utc), b.astimezone(timezone.utc)
                if b_utc <= now:
                    continue
                windows.append(dict(staff_ref=None if is_table else staff_ref(r["id"]), start=_iso_z(a_utc),
                                    end=_iso_z(b_utc), capacity=(r["capacity"] or 1) if is_table else 1))
    return dict(settings=dict(timezone=s["timezone"] if s["timezone"] != "UTC" else "UTC", slot_minutes=s["slot_minutes"],
                              min_notice_minutes=s["min_notice_minutes"], days_ahead=days),
                staff=staff, open_times=windows, from_at=_iso_z(from_at), to_at=_iso_z(to_at),
                enabled=s["publish_services"] != "none")


# ---------------------------------------------------------------- for screens
def counts(db):
    today = date.today().isoformat()
    r = db.execute("SELECT COUNT(*) n, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,"
                   " SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) rejected FROM online_inbox"
                   " WHERE test=0 AND filed_at >= ?", (today,)).fetchone()
    return dict(today=r["n"] or 0, failed_today=r["failed"] or 0, rejected_today=r["rejected"] or 0,
                unseen=db.execute("SELECT COUNT(*) FROM online_inbox WHERE test=0 AND status='done' AND seen_at IS NULL"
                                  " AND kind IN ('booking','order','enquiry','quote_accept','invoice_payment')").fetchone()[0],
                failed=db.execute("SELECT COUNT(*) FROM online_inbox WHERE status='failed'").fetchone()[0])


def new_for_today(db, limit=8):
    return db.execute("SELECT * FROM online_inbox WHERE test=0 AND status='done' AND seen_at IS NULL AND kind IN"
                      " ('booking','order','enquiry','quote_accept','invoice_payment') ORDER BY filed_at DESC LIMIT ?",
                      (limit,)).fetchall()


NEWS_KINDS = ("booking", "order", "enquiry", "quote_accept", "invoice_payment")


def summarizer(db):
    """summary(row) for the Online list: one line from the payload, times in the business's own time zone."""
    tz = _tz(settings(db)["timezone"])
    names = {k: v["name"] for k, v in _services_by_sku(db).items()}

    def summary(row):
        try:
            p = json.loads(row["payload"])
        except (ValueError, TypeError):
            return ""
        k = row["kind"]
        if k == "booking":
            st = _utc(p.get("start"))
            what = names.get(_s(p.get("service"), 64).lower()) or _s(p.get("service"), 64)
            return what + (f", {st.astimezone(tz):%a %d %b %H:%M}" if st else "")
        if k == "order":
            n = len(p.get("items") or [])
            t = _money((p.get("totals") or {}).get("total")) if isinstance(p.get("totals"), dict) else None
            pay = (p.get("payment") or {}).get("status") if isinstance(p.get("payment"), dict) else None
            return (f"{n} item{'s' if n != 1 else ''}" + (f", {fmt_money(t)}" if t is not None else "")
                    + (f", {pay.replace('_', ' ')}" if pay else ""))
        if k == "enquiry":
            req = order_request_lines(p)
            if req:
                return ", ".join(f"{l['quantity']:g} × {l['sku']}" for l in req)
            return _s(p.get("subject") or p.get("message"), 80)
        if k == "quote_accept":
            return f"Quote {_s(p.get('quote_ref'), 64)}"
        if k == "invoice_payment":
            a = _money(p.get("amount"))
            return f"{fmt_money(a) if a is not None else ''} for {_s(p.get('invoice_ref'), 64)}"
        if k == "customer":
            return _s(p.get("email") or p.get("phone"), 120)
        return ""
    return summary
