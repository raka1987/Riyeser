"""The company profile Riyeser Central keeps for the whole suite.

%APPDATA%\\Riyeser\\company.json on Windows (~/.config/Riyeser/company.json elsewhere), written by Central's
"set up or join a company" wizard. A new company file in Accounting, Invoices, Bookings or POS starts with these
details, so nobody types them twice. Reading it never fails: a missing or damaged file just means no profile.
"""
import json
import os

FIELDS = ("name", "legal_name", "tax_number", "address", "phone", "email", "country", "company_code", "mode")


def profile_file():
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "Riyeser", "company.json")


def read(path=None):
    """The profile as a dict of strings (empty dict when there's none)."""
    try:
        with open(path or profile_file(), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(d, dict) or not str(d.get("name") or "").strip():
        return {}
    return {k: str(d.get(k) or "").strip()[:300] for k in FIELDS}


def apply_to_new_file(db, profile=None):
    """Fill a brand-new company file's details (ABN, address, phone, email) from the profile. Only fills blanks."""
    p = profile if profile is not None else read()
    if not p:
        return False
    row = db.execute("SELECT abn, address, phone, email FROM company WHERE id=1").fetchone()
    if not row:
        return False
    db.execute("UPDATE company SET abn=COALESCE(NULLIF(abn,''),?), address=COALESCE(NULLIF(address,''),?),"
               " phone=COALESCE(NULLIF(phone,''),?), email=COALESCE(NULLIF(email,''),?) WHERE id=1",
               (p.get("tax_number") or None, p.get("address") or None, p.get("phone") or None, p.get("email") or None))
    try:   # the legal name too (Business details & branding); Central's logo is used until the file has its own
        db.execute("UPDATE company SET legal_name=COALESCE(NULLIF(legal_name,''),?) WHERE id=1",
                   (p.get("legal_name") or None,))
    except Exception:  # noqa: BLE001 - a file from before branding: nothing to fill
        pass
    db.commit()
    return True
