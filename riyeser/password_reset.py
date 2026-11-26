""""Forgot password?" on the sign-in screen: the same two safe ways back in as Riyeser Payroll (forgot.js).

1. An emailed reset code (only when email sending is set up under Setup, Company details, Email): a 6-digit code to
   the person's own email address on file (Setup, Users & Roles), good once, for 15 minutes. At most 3 codes an hour
   per person, 5 wrong tries cancel the code, and the answer is the same whether or not the username or email exists.
2. The business owner's Riyeser account (works without email): the owner signs in with their Riyeser email and
   password (and the two-step code, when their account has one) against Riyeser Online (Supabase Auth, by REST, as
   Riyeser Central does). The app then checks, as that person, that they are the 'owner' of the business this PC is
   linked to (%APPDATA%\\Riyeser\\company.json, written by Central): their row in members for that workspace. Only
   then can they choose a user and set its new password.

There is deliberately no "local only" reset (no email, no Riyeser account): on a shared till PC anyone could use it.
Both ways are only offered in the desktop app, on this computer; over the network it's "ask your administrator".
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Riyeser Online (the Supabase project Riyeser Central signs in to). Built in on purpose: this decides who may reset
# a password. Both values are safe to publish (the publishable key only allows what the row rules allow).
ONLINE = {"url": "https://goaugynxeatzqzifpoes.supabase.co", "key": "sb_publishable_-hYqz3gbSvsH-1rX_HLV4A_eSTp3XXL"}
CODE_MINUTES, CODES_PER_HOUR, CODE_TRIES, TICKET_MINUTES = 15, 3, 5, 10

SENT = ("If that matches a person with an email address, we've sent them a 6-digit code. It works once, for "
        "15 minutes. Check the inbox (and the junk folder).")
WRONG_CODE = "That code isn't right, or it has expired. Check the newest email, or ask for a new code."
NOT_LINKED = ("This PC isn't linked to your business on Riyeser yet. Sign in to Riyeser Central on this PC first, "
              "then try again.")


class ResetError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- where things are
def linked_business():
    """The business this PC is linked to (Central's company.json): {'workspace_id', 'name'} or None."""
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    try:
        with open(os.path.join(base, "Riyeser", "company.json"), encoding="utf-8") as f:
            c = json.load(f)
    except (OSError, ValueError):
        return None
    if isinstance(c, dict) and c.get("mode") == "online" and c.get("workspace_id"):
        return {"workspace_id": str(c["workspace_id"]), "name": str(c.get("name") or "")}
    return None


def online():
    """Riyeser Online's address: built in. Tests (never the packaged desktop program) can point it elsewhere."""
    if not getattr(sys, "frozen", False) and os.environ.get("RIYESER_ONLINE_URL"):
        return {"url": os.environ["RIYESER_ONLINE_URL"].rstrip("/"), "key": os.environ.get("RIYESER_ONLINE_KEY") or "test"}
    return ONLINE


def mfa_factor(user):
    """The account's verified authenticator-app factor, or None."""
    for f in (user or {}).get("factors") or []:
        if isinstance(f, dict) and f.get("status") == "verified" and (f.get("factor_type") or "totp") == "totp" and f.get("id"):
            return f
    return None


def aal_of(token):
    """'aal1' (password only) or 'aal2' (with the two-step code) from a Supabase access token; '' if unreadable."""
    try:
        part = str(token).split(".")[1]
        return str(json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("aal") or "")
    except (IndexError, ValueError, AttributeError):
        return ""


def _plain(status, body):
    m = ""
    if isinstance(body, dict):
        m = str(body.get("msg") or body.get("message") or body.get("error_description") or body.get("error") or "")
    low = m.lower()
    if "invalid login" in low or "invalid_grant" in low or "invalid credentials" in low:
        return "That email or password isn't right."
    if "email not confirmed" in low:
        return "Please confirm your Riyeser account's email first (open the link we emailed you), then try again."
    if status == 429:
        return "Too many tries. Wait a few minutes, then try again."
    if status:
        return f"Riyeser couldn't check that right now (error {status}). Please try again."
    return "Can't reach Riyeser. Check the internet connection and try again."


def call(path, method="GET", body=None, token=None):
    """One request to Riyeser Online. Raises ResetError with a plain-English message."""
    c = online()
    headers = {"apikey": c["key"], "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(c["url"] + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            text = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            out = json.loads(e.read().decode("utf-8", "replace") or "null")
        except ValueError:
            out = None
        code = 401 if e.code in (400, 401, 422) else 429 if e.code == 429 else 503
        err = ResetError(code, _plain(e.code, out))
        err.upstream = e.code
        raise err
    except (OSError, ValueError):
        raise ResetError(503, _plain(0, None))
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None


# ---------------------------------------------------------------- emailed codes
def ensure_table(db):
    if "email" not in {r["name"] for r in db.execute("PRAGMA table_info(users)")}:
        db.execute("ALTER TABLE users ADD COLUMN email TEXT")
    db.execute("""CREATE TABLE IF NOT EXISTS password_reset_codes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
        code_hash TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL, used_at REAL,
        tries INTEGER NOT NULL DEFAULT 0)""")


def _hash(uid, code):
    return hashlib.sha256(f"{uid}:{code}".encode()).hexdigest()


def matching(db, who):
    """Active users whose username or email address on file is `who` (any case)."""
    who = (who or "").strip()[:200]
    if not who:
        return []
    ensure_table(db)
    return db.execute("SELECT * FROM users WHERE active=1 AND (lower(username)=lower(?) OR"
                      " (COALESCE(email,'')<>'' AND lower(trim(email))=lower(?))) LIMIT 5", (who, who)).fetchall()


def is_email(e):
    e = (e or "").strip()
    return "@" in e and " " not in e and "." in e.split("@")[-1] and len(e) <= 200


def new_code(db, uid, now=None):
    """A new code for this person, or None when they've had 3 in the last hour. Only the newest code works."""
    ensure_table(db)
    now = time.time() if now is None else now
    n = db.execute("SELECT COUNT(*) n FROM password_reset_codes WHERE user_id=? AND created_at>?",
                   (uid, now - 3600)).fetchone()["n"]
    if n >= CODES_PER_HOUR:
        return None
    code = f"{secrets.randbelow(1000000):06d}"
    db.execute("UPDATE password_reset_codes SET used_at=? WHERE user_id=? AND used_at IS NULL", (now, uid))
    db.execute("INSERT INTO password_reset_codes (user_id, code_hash, created_at, expires_at) VALUES (?,?,?,?)",
               (uid, _hash(uid, code), now, now + CODE_MINUTES * 60))
    return code


def use_code(db, uid, code, now=None):
    """True (and the code is used up) when it's this person's newest live code. A wrong one counts; 5 cancel it."""
    ensure_table(db)
    now = time.time() if now is None else now
    row = db.execute("SELECT * FROM password_reset_codes WHERE user_id=? AND used_at IS NULL AND expires_at>?"
                     " ORDER BY id DESC LIMIT 1", (uid, now)).fetchone()
    if not row:
        return False
    if hmac.compare_digest(row["code_hash"], _hash(uid, code)):
        db.execute("UPDATE password_reset_codes SET used_at=? WHERE id=?", (now, row["id"]))
        return True
    tries = row["tries"] + 1
    db.execute("UPDATE password_reset_codes SET tries=?, used_at=? WHERE id=?",
               (tries, now if tries >= CODE_TRIES else None, row["id"]))
    return False


def cancel_codes(db, uid, now=None):
    ensure_table(db)
    db.execute("UPDATE password_reset_codes SET used_at=? WHERE user_id=? AND used_at IS NULL",
               (time.time() if now is None else now, uid))


# ---------------------------------------------------------------- owner sign-in tickets (kept on the server)
class Tickets:
    def __init__(self):
        self._t = {}

    def new(self, **o):
        now = time.time()
        for k in [k for k, v in self._t.items() if now - v["at"] > TICKET_MINUTES * 60]:
            del self._t[k]
        while len(self._t) > 200:
            del self._t[next(iter(self._t))]
        t = secrets.token_hex(24)
        self._t[t] = {**o, "at": now, "tries": 0}
        return t

    def get(self, t):
        x = self._t.get(str(t or ""))
        if not x or time.time() - x["at"] > TICKET_MINUTES * 60:
            self._t.pop(str(t or ""), None)
            raise ResetError(401, "That took too long. Start again: sign in with your Riyeser account.")
        return x

    def drop(self, t):
        self._t.pop(str(t or ""), None)


def owner_sign_in(email, password):
    """Riyeser email + password. Returns {'uid', 'token', 'factor_id'} (factor_id set when a two-step code is needed)."""
    r = call("/auth/v1/token?grant_type=password", "POST", {"email": email, "password": password})
    if not isinstance(r, dict) or not r.get("access_token") or not (r.get("user") or {}).get("id"):
        raise ResetError(503, _plain(500, None))
    f = mfa_factor(r["user"])
    return {"uid": str(r["user"]["id"]), "token": r["access_token"], "factor_id": f["id"] if f else None}


def owner_two_step(x, code):
    """The authenticator-app code: returns the aal2 token or raises."""
    fid = urllib.parse.quote(str(x["factor_id"]), safe="")
    ch = call(f"/auth/v1/factors/{fid}/challenge", "POST", {}, token=x["token"])
    wrong = ResetError(401, "That code isn't right. Type the newest code from your authenticator app.")
    try:
        v = call(f"/auth/v1/factors/{fid}/verify", "POST",
                 {"challenge_id": (ch or {}).get("id"), "code": code}, token=x["token"])
    except ResetError as e:
        if e.status == 401:
            raise wrong
        raise
    if not isinstance(v, dict) or not v.get("access_token") or aal_of(v["access_token"]) != "aal2":
        raise wrong
    return v["access_token"]


def confirm_owner(x, biz):
    """As that person: their members row for the linked business says 'owner' (and the token is aal2 if they have MFA)."""
    if x.get("factor_id") and aal_of(x["token"]) != "aal2":
        raise ResetError(403, "Type the two-step code from your authenticator app first.")
    q = urllib.parse.urlencode({"select": "role,workspace_id", "workspace_id": "eq." + biz["workspace_id"],
                                "user_id": "eq." + x["uid"]})
    rows = call(f"/rest/v1/members?{q}", token=x["token"])
    ok = isinstance(rows, list) and any(isinstance(r, dict) and r.get("role") == "owner"
                                        and str(r.get("workspace_id")) == biz["workspace_id"] for r in rows)
    if not ok:
        raise ResetError(403, f"That Riyeser account isn't the owner of {biz['name'] or 'the business this PC is linked to'}. "
                              "Only the business owner can reset a password this way. Ask the owner, or your administrator.")
