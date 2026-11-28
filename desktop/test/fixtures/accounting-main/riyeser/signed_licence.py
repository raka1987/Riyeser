"""Signed licences: can this PC trust the company's Riyeser plan in licence.json?

Riyeser online signs each licence with Ed25519 (the "licence" Edge Function, supabase/functions/licence). Only Riyeser
holds the private key; the public key is built into each program when it's built (riyeser/_licence_key.py, written by
packaging/build_desktop.py). A licence is trusted only when the signature verifies, it's for the business in
company.json, it's for this PC (device.json, written by Riyeser Central) when it names one, it hasn't expired, and the
PC clock hasn't been put back. An untrusted licence counts as no licence. Nothing here deletes anything.

The same rules as desktop/src/core/signed-licence.js (Central, Link Office, Payroll): keep them in step.
tests/licence-vectors.json is the shared test data; canonical JSON must come out byte for byte the same everywhere.
Without a built-in public key (a build made before licence signing was switched on) everything works as before.
"""
import base64
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

from . import ed25519

DAY = 86400.0
CLOCK_SLACK = 48 * 3600.0
UNSIGNED_GRACE_DAYS = 14
TRIAL_DAYS = 90
OFFLINE_GRACE_DAYS = 30
MARKER = ".riyeser-licence.json"

MESSAGES = {
    "update": "Update Riyeser Central to keep your plan up to date.",
    "invalid": "Your Riyeser plan on this PC couldn't be checked. Open Riyeser Central and sign in to check it again.",
    "expired": "Riyeser couldn't check your plan for 30 days: connect to the internet and open Riyeser Central.",
    "clock": "This PC's date or time looks wrong. Set the clock right, then open Riyeser Central to check your plan.",
}


# ---------- canonical JSON: keys sorted (UTF-16 order), no spaces, whole numbers only ----------
def _quote(s):
    out = ['"']
    for ch in s:
        c = ord(ch)
        if c == 0x22:
            out.append('\\"')
        elif c == 0x5C:
            out.append("\\\\")
        elif c == 0x08:
            out.append("\\b")
        elif c == 0x0C:
            out.append("\\f")
        elif c == 0x0A:
            out.append("\\n")
        elif c == 0x0D:
            out.append("\\r")
        elif c == 0x09:
            out.append("\\t")
        elif c < 0x20:
            out.append("\\u%04x" % c)
        elif 0xD800 <= c <= 0xDFFF:  # a lone surrogate
            out.append("\\u%04x" % c)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16(k):
    return k.encode("utf-16-be", "surrogatepass")


def canonical(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")) or not v.is_integer():
            raise ValueError("Canonical JSON takes whole numbers only.")
        v = int(v)
    if isinstance(v, int):
        if abs(v) > 2 ** 53 - 1:
            raise ValueError("Canonical JSON takes whole numbers only.")
        return str(v)
    if isinstance(v, str):
        return _quote(v)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=_utf16)
        return "{" + ",".join(_quote(k) + ":" + canonical(v[k]) for k in keys) + "}"
    raise ValueError("Canonical JSON can't hold that value.")


def signed_bytes(env):
    return canonical({k: v for k, v in env.items() if k != "sig"}).encode("utf-8")


_seen = {}


def verify_signature(env, public_key):
    try:
        if not isinstance(env, dict) or not isinstance(env.get("sig"), str):
            return False
        pub = base64.b64decode(str(public_key or "").strip(), validate=True)
        sig = base64.b64decode(env["sig"], validate=True)
        msg = signed_bytes(env)
    except (ValueError, TypeError):
        return False
    if len(pub) != 32 or len(sig) != 64:
        return False
    k = hashlib.sha256(pub + sig + msg).digest()   # the same licence is checked on every page: work it out once
    if k not in _seen:
        _seen.clear() if len(_seen) > 64 else None
        _seen[k] = ed25519.verify(pub, msg, sig)
    return _seen[k]


_key_for_tests = None


def use_key_for_tests(k):
    global _key_for_tests
    _key_for_tests = k


def built_in_key():
    """The public key built into this program ('' before licence signing was switched on)."""
    if _key_for_tests is not None:
        return _key_for_tests
    try:
        from ._licence_key import PUBLIC_KEY
    except ImportError:
        return ""
    try:
        return PUBLIC_KEY if len(base64.b64decode(PUBLIC_KEY, validate=True)) == 32 else ""
    except ValueError:
        return ""


# ---------- files ----------
def _read(f):
    try:
        with open(f, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def _write(f, data):
    os.makedirs(os.path.dirname(f), exist_ok=True)
    tmp = f + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, f)


def _hide(f):
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.kernel32.SetFileAttributesW(str(f), 0x02)
        except Exception:  # pragma: no cover - only on Windows
            pass


def _ms(s):
    try:
        t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return t.timestamp()
    except (TypeError, ValueError):
        return None


def _iso(t):
    return None if t is None else datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def device_id(riyeser_dir):
    d = _read(os.path.join(riyeser_dir, "device.json")) or {}
    return d.get("id") if isinstance(d.get("id"), str) and d.get("id") else None


def _workspace(riyeser_dir):
    c = _read(os.path.join(riyeser_dir, "company.json")) or {}
    return str(c["workspace_id"]) if c.get("mode") == "online" and c.get("workspace_id") else None


def _dirs(riyeser_dir, own_dir):
    out = []
    for x in (own_dir, riyeser_dir):
        if x and x not in out:
            out.append(x)
    return out


def _markers(dirs):
    return [_read(os.path.join(x, MARKER)) or {} for x in dirs]


def _merge(lst):
    def mn(xs):
        xs = [x for x in xs if x is not None]
        return min(xs) if xs else None
    out = {"firstRun": mn(_ms(m.get("firstRun")) for m in lst), "linked": any(m.get("linked") is True for m in lst),
           "unsignedSince": mn(_ms(m.get("unsignedSince")) for m in lst), "clock": None}
    for m in lst:
        c = m.get("clock")
        if not isinstance(c, dict):
            continue
        try:
            latest = float(c.get("latest")) / 1000.0   # kept in milliseconds, like the JavaScript programs
        except (TypeError, ValueError):
            continue
        issued = str(c.get("issued") or "")
        cur = out["clock"]
        if not cur or issued > cur["issued"] or (issued == cur["issued"] and latest > cur["latest"]):
            out["clock"] = {"issued": issued, "latest": latest}
    return out


def _save(dirs, before, m):
    clock = {"issued": m["clock"]["issued"], "latest": int(round(m["clock"]["latest"] * 1000))} if m.get("clock") else None
    data = {"firstRun": _iso(m["firstRun"]), "linked": bool(m["linked"]), "unsignedSince": _iso(m["unsignedSince"]), "clock": clock}
    for x, old in zip(dirs, before):
        oc = old.get("clock") if isinstance(old.get("clock"), dict) else None
        same = (old.get("firstRun") == data["firstRun"] and bool(old.get("linked")) == data["linked"]
                and (old.get("unsignedSince") or None) == data["unsignedSince"] and oc and clock
                and oc.get("issued") == clock["issued"] and clock["latest"] - float(oc.get("latest") or 0) < 3600 * 1000)
        if same:
            continue   # nothing new (the latest time is written at most once an hour)
        f = os.path.join(x, MARKER)
        try:
            new = not os.path.exists(f)
            _write(f, data)
            if new:
                _hide(f)
        except OSError:
            pass   # a folder we can't write: the other markers still count


def _now_s(now):
    return now.timestamp() if isinstance(now, datetime) else float(now)


def _end_of_day(ymd):
    return _ms(str(ymd)[:10] + "T23:59:59+00:00")


def module_state(plan, mod, now):
    """{'active', 'status', 'days_left', 'trial_ends', 'paid_until'}: the plan's dates hold even with no internet."""
    t = _now_s(now)
    m = ((plan or {}).get("modules") or {}).get(mod)
    if not isinstance(m, dict):
        return {"active": False, "status": "none", "days_left": None}
    base = {"trial_ends": m.get("trial_ends"), "paid_until": m.get("paid_until")}
    if not m.get("active"):
        return {"active": False, "status": m.get("status") or "ended", "days_left": 0, **base}
    trial = m.get("status") == "trial"
    day = m.get("trial_ends") if trial else m.get("paid_until")
    end = _end_of_day(day) if day else None
    if end is not None and t > end:
        return {"active": False, "status": "ended", "days_left": 0, **base}
    if end is not None:
        today = datetime.fromtimestamp(t, timezone.utc).date()
        left = max(0, (datetime.fromisoformat(str(day)[:10]).date() - today).days)
    else:
        left = m.get("days_left")
    return {"active": True, "status": "trial" if trial else (m.get("status") or "active"), "days_left": left, **base}


def check(riyeser_dir, own_dir=None, now=None, public_key=None, write=True, lic_file=None):
    """Where this PC's online plan stands, after checking it can be trusted.

    riyeser_dir: the folder with licence.json, company.json and device.json (%APPDATA%\\Riyeser).
    own_dir: this program's own data folder (a second marker). Returns a dict:
      state 'trusted' (a good signed licence: use plan), 'unsigned' (no key built in yet, or an older Central within
      its 14 days: use plan as before), 'none' (no online plan), or 'invalid' (edited, copied, another business or
      PC, expired, clock put back, or unsigned for too long: no licence; problem says which, message what to do).
    """
    t = _now_s(now if now is not None else datetime.now(timezone.utc))
    key = built_in_key() if public_key is None else public_key
    lic = _read(lic_file or os.path.join(riyeser_dir, "licence.json")) or {}
    o = lic.get("online") if isinstance(lic.get("online"), dict) else None
    dirs = _dirs(riyeser_dir, own_dir)
    before = _markers(dirs)
    m = _merge(before)

    def done(r):
        if write:
            _save(dirs, before, m)
        return r

    if not o:
        return done({"state": "none", "plan": None, "problem": None, "message": None})
    checked = _ms(o.get("checkedAt") or o.get("checked_at")) or 0
    unsigned_plan = {k: v for k, v in o.items() if k != "signed"}
    if not key:
        return done({"state": "unsigned", "plan": unsigned_plan, "checked_at": checked, "expires_at": checked + OFFLINE_GRACE_DAYS * DAY,
                     "problem": None, "message": None})
    s = o.get("signed")
    if not isinstance(s, dict):
        # An unsigned plan is only a file anyone can write (S13). It counts for 14 days (an older Riyeser Central on a
        # PC that has already had a signed plan from Riyeser), and not at all on a PC that has never had one.
        if not m["linked"]:
            return done({"state": "invalid", "plan": None, "problem": "unsigned", "message": MESSAGES["update"]})
        if m["unsignedSince"] is None:
            m["unsignedSince"] = t
        until = m["unsignedSince"] + UNSIGNED_GRACE_DAYS * DAY
        if t < until:
            return done({"state": "unsigned", "plan": unsigned_plan, "checked_at": checked, "expires_at": min(until, checked + OFFLINE_GRACE_DAYS * DAY),
                         "problem": "unsigned", "message": MESSAGES["update"]})
        return done({"state": "invalid", "plan": None, "problem": "unsigned", "message": MESSAGES["update"]})

    def bad(problem, message=MESSAGES["invalid"]):
        return done({"state": "invalid", "plan": None, "problem": problem, "message": message})

    if not verify_signature(s, key):
        return bad("signature")
    L = s.get("licence") if isinstance(s.get("licence"), dict) else None
    issued, expires = _ms(s.get("issued_at")), _ms(s.get("expires_at"))
    if not L or issued is None or expires is None:
        return bad("signature")
    ws = _workspace(riyeser_dir)
    if not ws or ws != str(s.get("workspace_id") or "") or (L.get("workspace_id") and str(L["workspace_id"]) != ws):
        return bad("business")
    if s.get("device_id") and s["device_id"] != device_id(riyeser_dir):
        return bad("device")
    issued_iso = _iso(issued)
    if not m["clock"] or m["clock"]["issued"] < issued_iso:
        m["clock"] = {"issued": issued_iso, "latest": issued}
    latest = max(m["clock"]["latest"], issued)
    if t < latest - CLOCK_SLACK:
        return bad("clock", MESSAGES["clock"])
    m["clock"]["latest"] = max(latest, t)
    m["linked"] = True
    m["unsignedSince"] = None
    if t >= expires:
        return bad("expired", MESSAGES["expired"])
    return done({"state": "trusted", "plan": dict(L, checkedAt=o.get("checkedAt") or s.get("issued_at")), "checked_at": issued,
                 "expires_at": expires, "problem": None, "message": None})


def local_trial(riyeser_dir, own_dir=None, now=None, write=True, start_now=True, days=TRIAL_DAYS, lic_file=None, extra=None):
    """The local 90-day trial: from the earlier of licence.json's trialStart and the hidden markers, so deleting one
    doesn't restart it, and counted from the latest time seen, so winding the clock back gives no days back.
    A PC that has never been online can't be fully protected. start_now=False: don't start one (returns None).
    extra (trial_guard.py): {"starts": [seconds] from the registry, company files and Riyeser online's PC record (the
    earliest counts), "latest": the latest time seen there, "extra_days": a goodwill extension from Riyeser online}."""
    t = _now_s(now if now is not None else datetime.now(timezone.utc))
    lf = lic_file or os.path.join(riyeser_dir, "licence.json")
    lic = _read(lf) or {}
    dirs = _dirs(riyeser_dir, own_dir)
    before = _markers(dirs)
    m = _merge(before)
    from_file = _ms(lic.get("trialStart"))
    extra = extra or {}
    more = [float(x) for x in (extra.get("starts") or []) if isinstance(x, (int, float))]
    known = [x for x in (from_file, m["firstRun"]) if x is not None] + more
    if not known and not start_now:
        return None
    start = min(known + [t])
    m["firstRun"] = start
    latest_seen = max(m["clock"]["latest"] if m["clock"] else 0, float(extra.get("latest") or 0))
    seen = max(t, latest_seen)
    if not m["clock"] or m["clock"]["issued"] == "":
        m["clock"] = {"issued": "", "latest": seen}
    if write:
        _save(dirs, before, m)
        if from_file is None or from_file > start:
            try:
                _write(lf, dict(lic, trialStart=_iso(start)))
            except OSError:
                pass
    try:
        bonus = max(0, min(365, int(extra.get("extra_days") or 0)))
    except (TypeError, ValueError):
        bonus = 0
    ends = start + (days + bonus) * DAY
    import math
    return {"start": start, "ends": ends, "days_left": max(0, math.ceil((ends - seen) / DAY)), "active": seen < ends, "linked": m["linked"],
            "seen": seen, "clock_back": t < latest_seen - CLOCK_SLACK}
