"""Till PINs (POS 2.11.1): who is selling at the till, without signing Windows / Riyeser out.

Each user can have one Till PIN (4 to 6 numbers). It is the same PIN a manager types to approve a refund, void,
"No sale" or a big discount (users.pos_pin_hash, which 2.10 already used for manager approvals). It is stored as a
salted hash only, never shown again, and is unique among active users, so a PIN alone tells who it is.

How the till uses it:
  * The PC is signed in as usual (username and password). That person must have till access (Sales: Add & edit).
  * Once a member of staff (not only managers) has a Till PIN, and POS setup doesn't turn PINs off, the till asks
    "Who's selling?":
    the cashier taps their name and types their PIN. Every sale, refund, "No sale", opening and closing of the till
    is then recorded against that cashier, and the till's permission checks use the cashier's own access.
  * The till locks after a few minutes of no use (POS setup: default 5 minutes, or never), or with "Switch cashier".
  * Five wrong PINs in a row lock the PIN pad for a minute. Every wrong PIN is in the audit trail.
  * PINs are checked on this PC against the company file, so they work with no internet connection.

The back office (products, setup, reports outside the till) stays with the person signed in on the PC.
"""
import json
import time

from werkzeug.security import check_password_hash, generate_password_hash

from . import perms

PIN_METHOD = "pbkdf2:sha256:60000"   # salted; fast enough to check every active user when only a PIN is typed
LOCK_CHOICES = [(0, "Never"), (1, "1 minute"), (2, "2 minutes"), (5, "5 minutes"), (10, "10 minutes"),
                (15, "15 minutes"), (30, "30 minutes")]
DEFAULTS = {"pins": "auto", "lock_minutes": 5}
MAX_WRONG = 5          # wrong PINs in a row ...
WRONG_WINDOW = 300     # ... within 5 minutes ...
LOCKOUT = 60           # ... lock the PIN pad for a minute
GRACE = 60             # the till's own timer locks on time; the server allows a minute more before it refuses


def now():
    return time.time()


class PinError(ValueError):
    pass


def check_format(pin):
    pin = (pin or "").strip()
    if not (pin.isdigit() and 4 <= len(pin) <= 6):
        raise PinError("A Till PIN is 4 to 6 numbers.")
    return pin


def hash_pin(pin):
    return generate_password_hash(pin, method=PIN_METHOD)


def matches(user, pin):
    h = user["pos_pin_hash"] if "pos_pin_hash" in user.keys() else None
    return bool(h and pin and check_password_hash(h, pin))


def taken(db, pin, uid=None):
    """Is this PIN already someone else's (an active user)?"""
    for u in db.execute("SELECT id, pos_pin_hash FROM users WHERE active=1 AND pos_pin_hash IS NOT NULL"):
        if str(u["id"]) != str(uid) and matches(u, pin):
            return True
    return False


TAKEN = "That PIN is already used — choose another."


def set_pin(db, uid, pin):
    pin = check_format(pin)
    if taken(db, pin, uid):
        raise PinError(TAKEN)
    db.execute("UPDATE users SET pos_pin_hash=? WHERE id=?", (hash_pin(pin), uid))


# ------------------------------------------------------------ settings
def settings(db):
    raw = db.execute("SELECT pos_cashier_settings FROM company WHERE id=1").fetchone()[0]
    s = dict(DEFAULTS)
    try:
        s.update(json.loads(raw) if raw else {})
    except ValueError:
        pass
    if s.get("pins") not in ("auto", "off"):
        s["pins"] = "auto"
    try:
        s["lock_minutes"] = int(s.get("lock_minutes"))
    except (TypeError, ValueError):
        s["lock_minutes"] = DEFAULTS["lock_minutes"]
    if s["lock_minutes"] not in dict(LOCK_CHOICES):
        s["lock_minutes"] = DEFAULTS["lock_minutes"]
    return s


def save_settings(db, pins, lock_minutes):
    s = settings(db)
    s["pins"] = "off" if pins == "off" else "auto"
    try:
        lm = int(lock_minutes)
    except (TypeError, ValueError):
        lm = DEFAULTS["lock_minutes"]
    s["lock_minutes"] = lm if lm in dict(LOCK_CHOICES) else DEFAULTS["lock_minutes"]
    db.execute("UPDATE company SET pos_cashier_settings=? WHERE id=1", (json.dumps(s),))
    return s


def can_sell(user):
    """Till access: Sales at Add & edit or more."""
    return perms.level("sales", user) >= perms.EDIT


def cashiers(db):
    """Everyone who can sign in at the till by PIN: active, a Till PIN, and till access."""
    return [u for u in db.execute("SELECT * FROM users WHERE active=1 AND pos_pin_hash IS NOT NULL"
                                  " ORDER BY COALESCE(NULLIF(full_name,''), username)") if can_sell(u)]


def active(db):
    """Does this till ask who's selling? PINs aren't turned off, and at least one member of staff who isn't a manager
    (till access, but not Full on Sales) has a Till PIN. Managers' PINs on their own (2.10's approval PINs) don't
    lock the till, so a till that only used manager PINs for approvals works as before."""
    return settings(db)["pins"] != "off" and any(perms.level("sales", u) < perms.FULL for u in cashiers(db))


def name_of(u):
    return (u["full_name"] or u["username"]) if u else ""


def todays(db, day):
    """Today's cashiers for the lock screen: anyone who opened a till, sold, refunded or signed in at the till today.
    With nobody yet today, everyone who can sign in by PIN."""
    ids = set()
    for q in ("SELECT opened_by FROM pos_shifts WHERE substr(opened_at,1,10)=?",
              "SELECT user_id FROM pos_sales WHERE substr(created_at,1,10)=?",
              "SELECT user_id FROM pos_refunds WHERE substr(created_at,1,10)=?",
              "SELECT user_id FROM pos_cashier_events WHERE kind='unlock' AND substr(created_at,1,10)=?"):
        ids.update(r[0] for r in db.execute(q, (day,)) if r[0])
    everyone = cashiers(db)
    today = [u for u in everyone if u["id"] in ids]
    return today or everyone


# ------------------------------------------------------------ wrong PINs
def wrong_left(db, device, uid=None):
    """Seconds until the PIN pad can be used again (0 = now). Counted per till device, and per person tapped."""
    since = now() - WRONG_WINDOW
    for col, val in (("device", device), ("target_id", uid)):
        if not val:
            continue
        rows = [r[0] for r in db.execute(f"SELECT at_epoch FROM pos_pin_fails WHERE {col}=? AND at_epoch>=?"
                                         " ORDER BY at_epoch DESC", (val, since))]
        if len(rows) >= MAX_WRONG:
            wait = rows[0] + LOCKOUT - now()
            if wait > 0:
                return int(wait + 0.999)
    return 0


def record_wrong(db, device, uid, till_id, why):
    db.execute("INSERT INTO pos_pin_fails (device, target_id, till_id, why, at_epoch) VALUES (?,?,?,?,?)",
               (device, uid, till_id, why, now()))


def clear_wrong(db, device, uid):
    db.execute("DELETE FROM pos_pin_fails WHERE device=? OR target_id=?", (device, uid))
