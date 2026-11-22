"""Riyeser licence status, read from the file Riyeser Central keeps for the whole suite.

%APPDATA%\\Riyeser\\licence.json on Windows (~/.config/Riyeser/licence.json elsewhere).
Accounting only READS it to show where the free trial or licence stands; licences are entered in Riyeser Central.
Same rules as Central (desktop/src/core/licence.js): a 90-day trial, and a licence checked online stays valid
for 30 days offline. Nothing here locks or deletes anything.
"""
import json
import os
from datetime import datetime, timezone

TRIAL_DAYS = 90
OFFLINE_GRACE_DAYS = 30
BUY_URL = "https://riyeser.com/pricing.html"


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
            return {"mode": "licensed", "plan": lic.get("plan")}
        return {"mode": "expired", "buy_url": BUY_URL}
    start = _when(d.get("trialStart"))
    if not start:
        # Riyeser Central starts the trial; without it, just don't show anything.
        return {"mode": "unknown"}
    left = TRIAL_DAYS - (now - start).days
    if left > 0:
        return {"mode": "trial", "days_left": left, "buy_url": BUY_URL}
    return {"mode": "expired", "buy_url": BUY_URL}
