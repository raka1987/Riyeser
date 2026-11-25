"""Riyeser licence status, read from the file Riyeser Central keeps for the whole suite.

%APPDATA%\\Riyeser\\licence.json on Windows (~/.config/Riyeser/licence.json elsewhere).
Accounting only READS it to show where the free trial or licence stands; licences are entered in Riyeser Central.
Same rules as Central (desktop/src/core/licence.js): a 90-day trial, and a licence checked online stays valid
for 30 days offline. When the PC is linked to an online company, Central also saves the company's licence from
Riyeser online under "online": then each paid program (module) is unlocked on its own (status(product=...)). Every paid program is free for those 90 days, then needs a licence (riyeser/plan.py); once the trial ends without one, companies open in
Basic (their Enterprise records stay, and come back with a licence). Nothing here deletes anything.
Once licences are signed (a public key built in), only a licence Riyeser signed for this business and this PC counts:
riyeser/signed_licence.py checks it, and keeps the trial's first-run date in a second, hidden place.
"""
import json
import os
from datetime import datetime, timezone

TRIAL_DAYS = 90
OFFLINE_GRACE_DAYS = 30
BUY_URL = "https://riyeser.com/pricing.html"
EXTRA_COMPANY_PRICE = 10  # US dollars a month for each company after the first


def licence_file():
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "Riyeser", "licence.json")


def _when(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


STALE_MESSAGE = ("Riyeser couldn't check your licence for 30 days: connect to the internet and open Riyeser Central. "
                 "Nothing has been deleted.")
# Which online licence module each app is: Accounting Basics, Plus (which includes its payroll pages), POS, Bookings.
# Riyeser Invoices is free, so it has no module.
MODULES = {"basic": "basic", "enterprise": "plus", "plus": "plus", "pos": "pos", "bookings": "bookings"}
_AUTO = object()


def module_for_app():
    """The licence module for the app that's running (None for Riyeser Invoices or when it can't tell)."""
    try:
        from .edition import app_product
        prod = app_product()
    except Exception:  # pragma: no cover - only if the edition module can't load
        prod = None
    if prod is None:
        try:  # run from source: the company's chosen edition
            from flask import g
            c = g.get("company") or {}
            prod = c.get("chosen_edition") or c.get("edition")
        except Exception:
            prod = None
    return MODULES.get(prod)


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def own_dir():
    """Accounting's own data folder (RIYESER_HOME, else ~/.riyeser, as riyeser/cli.py): a second place the first-run
    date and the latest time seen are kept (signed_licence.py), so deleting licence.json doesn't start a new trial."""
    return os.environ.get("RIYESER_HOME") or os.path.join(os.path.expanduser("~"), ".riyeser")


def _online_status(online, module, now, ev=None):
    """Status for one module from the company's plan (the part of licence.json Riyeser Central saved, once checked)."""
    from . import signed_licence as S
    ev = ev or {}
    checked = _when(online.get("checkedAt") or online.get("checked_at"))
    extra = int(online.get("extra_companies") or 0)
    expires = ev.get("expires_at")
    if expires is None:
        expires = checked.timestamp() + OFFLINE_GRACE_DAYS * 86400 if checked else 0
    if not checked or now.timestamp() >= expires:
        return {"mode": "expired", "stale": True, "message": STALE_MESSAGE, "buy_url": BUY_URL, "extra_companies": extra,
                "source": "online"}
    note = {"message": ev["message"]} if ev.get("message") else {}   # e.g. "Update Riyeser Central to keep your plan up to date."
    m = (online.get("modules") or {}).get(module) or {}
    live = S.module_state(online, module, now)
    if live["active"]:
        if live["status"] == "trial":
            left = live["days_left"]
            return {"mode": "trial", "days_left": int(left if left is not None else TRIAL_DAYS), "buy_url": BUY_URL,
                    "extra_companies": extra, "module": module, "source": "online", **note}
        return {"mode": "licensed", "plan": module, "paid_until": m.get("paid_until"), "days_left": live["days_left"],
                "extra_companies": extra, "module": module, "source": "online", **note}
    ended = (m.get("status") if not m.get("active") else None) or "ended"
    return {"mode": "expired", "ended": ended, "buy_url": BUY_URL, "extra_companies": extra, "module": module, "source": "online", **note}


def status(now=None, path=None, product=_AUTO):
    """{'mode': 'trial'|'licensed'|'expired'|'unknown', 'days_left': n, 'plan': ...}

    `product` is the licence module to ask about (basic, plus, pos, bookings). Left out, it's the running app's.
    When Riyeser Central has fetched the company's licence from Riyeser online (licence.json "online"), that decides,
    module by module; it stays good for 30 days without the internet. Once licences are signed (a public key is
    built into this app), only a licence Riyeser signed for this business and this PC counts (signed_licence.py):
    an edited, copied or expired one counts as none. Without it, the local 90-day trial decides.
    """
    from . import signed_licence as S
    now = now or datetime.now(timezone.utc)
    path = path or licence_file()
    riyeser_dir = os.path.dirname(path)
    d = _read(path)
    module = module_for_app() if product is _AUTO else MODULES.get(product, product)
    online = d.get("online")
    if isinstance(online, dict) and module:
        ev = S.check(riyeser_dir, own_dir(), now, lic_file=path)
        if ev["state"] in ("trusted", "unsigned"):
            return _online_status(ev["plan"], module, now, ev)
        if ev["state"] == "invalid":
            # no licence: a PC that has had a real plan from Riyeser gets no new local trial
            t = S.local_trial(riyeser_dir, own_dir(), now, lic_file=path)
            if not t["linked"] and t["active"]:
                return {"mode": "trial", "days_left": t["days_left"], "buy_url": BUY_URL, "message": ev["message"], "source": "local"}
            return {"mode": "expired", "untrusted": ev["problem"], "message": ev["message"], "buy_url": BUY_URL, "extra_companies": 0,
                    "module": module, "source": "online"}
    lic = d.get("licence") or {}
    # a licence key (the older Lemon Squeezy keys) is only a local file, so once licences are signed it doesn't count
    if d.get("key") and lic and not S.built_in_key():
        checked = _when(lic.get("checkedAt"))
        expires = _when(lic.get("expiresAt")) if lic.get("expiresAt") else None
        fresh = checked and (now - checked).total_seconds() < OFFLINE_GRACE_DAYS * 86400
        if lic.get("status") == "active" and (not expires or expires > now) and fresh:
            return {"mode": "licensed", "plan": lic.get("plan"), "extra_companies": int(lic.get("extraCompanies") or 0)}
        return {"mode": "expired", "buy_url": BUY_URL}
    # The trial: the earlier of licence.json's trialStart and this app's own marker. Before licences are signed, a PC
    # where Riyeser Central never started one shows nothing, as before; after, the trial starts now.
    t = S.local_trial(riyeser_dir, own_dir(), now, start_now=bool(S.built_in_key()), lic_file=path)
    if not t:
        return {"mode": "unknown"}
    if t["active"]:
        return {"mode": "trial", "days_left": t["days_left"], "buy_url": BUY_URL}
    return {"mode": "expired", "buy_url": BUY_URL}


def enterprise_allowed(now=None, path=None):
    """Accounting Plus (and its payroll pages) needs its free trial or a licence from Riyeser Central.
    'unknown' (Central not set up, e.g. a pip install) keeps everything open, like the trial."""
    return status(now, path, product="plus")["mode"] != "expired"


def company_allowance(now=None, path=None, product=_AUTO):
    """How many companies can be worked in: None = no limit (free trial, or Riyeser Central not set up yet).
    A licence includes one company; each extra company is an add-on. After the trial without a licence: one."""
    st = status(now, path, product)
    if st["mode"] in ("trial", "unknown"):
        return None
    if st["mode"] == "licensed":
        return 1 + st.get("extra_companies", 0)
    return 1
