"""Riyeser licence status, read from the file Riyeser Central keeps for the whole suite.

%APPDATA%\\Riyeser\\licence.json on Windows (~/.config/Riyeser/licence.json elsewhere).
Accounting only READS it to show where the free trial or licence stands; licences are entered in Riyeser Central.
Same rules as Central (desktop/src/core/licence.js): a 90-day trial, and a licence checked online stays valid
for 30 days offline. Riyeser Accounting Basic is free; once the trial ends without a licence, companies open in
Basic (their Enterprise records stay, and come back with a licence). Nothing here deletes anything.
"""
import json
import os
from datetime import datetime, timezone

TRIAL_DAYS = 90
OFFLINE_GRACE_DAYS = 30
BUY_URL = "https://riyeser.com/pricing.html"
EXTRA_COMPANY_PRICE = 10  # dollars a month for each company after the first


def licence_file():
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "Riyeser", "licence.json")


def _when(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def status(now=None, path=None):
    """{'mode': 'trial'|'licensed'|'expired'|'unknown', 'days_left': n, 'plan': ...}"""
    now = now or datetime.now(timezone.utc)
    path = path or licence_file()
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    lic = d.get("licence") or {}
    if d.get("key") and lic:
        checked = _when(lic.get("checkedAt"))
        expires = _when(lic.get("expiresAt")) if lic.get("expiresAt") else None
        fresh = checked and (now - checked).total_seconds() < OFFLINE_GRACE_DAYS * 86400
        if lic.get("status") == "active" and (not expires or expires > now) and fresh:
            return {"mode": "licensed", "plan": lic.get("plan"), "extra_companies": int(lic.get("extraCompanies") or 0)}
        return {"mode": "expired", "buy_url": BUY_URL}
    start = _when(d.get("trialStart"))
    if not start:
        # Riyeser Central starts the trial; without it, just don't show anything.
        return {"mode": "unknown"}
    left = TRIAL_DAYS - (now - start).days
    if left > 0:
        return {"mode": "trial", "days_left": left, "buy_url": BUY_URL}
    return {"mode": "expired", "buy_url": BUY_URL}


def enterprise_allowed(now=None, path=None):
    """Basic is free for everyone. Enterprise needs the free trial or a licence from Riyeser Central.
    'unknown' (Central not set up, e.g. a pip install) keeps everything open, like the trial."""
    return status(now, path)["mode"] != "expired"


def company_allowance(now=None, path=None):
    """How many companies can be worked in: None = no limit (free trial, or Riyeser Central not set up yet).
    A licence includes one company; each extra company is an add-on. After the trial without a licence: one."""
    st = status(now, path)
    if st["mode"] in ("trial", "unknown"):
        return None
    if st["mode"] == "licensed":
        return 1 + st.get("extra_companies", 0)
    return 1
