"""Free for 90 days, then a subscription.

Riyeser pricing (riyeser.com/pricing.html): every paid program — Riyeser Accounting Basics, Accounting Plus, Riyeser POS,
Payroll and As Built — is free for 90 days with no card, then $20 a month per business (Basics) or +$20 a month each.
The trial and the licence are kept by Riyeser Central in licence.json (see riyeser/licence.py).

When the trial ends without a licence, nothing is deleted or hidden. Only the paid actions stop (a new till sale, a new
invoice) until a licence is entered; everything else keeps working and every record stays.

This is the one place that decides it, so a billing backend can take over `subscribed()` without touching the screens.
"""
from .licence import TRIAL_DAYS

WARN_DAYS = 14      # remind people in the last two weeks of the trial
WHAT = {"pos": ("sale", "sales"), "basic": ("invoice", "invoices"), "bookings": ("booking", "bookings")}


def _status():
    from .licence import status
    return status()


def subscribed(product=None):
    """True when this computer has an active Riyeser licence (kept up to date by Riyeser Central)."""
    return _status()["mode"] == "licensed"


def used(db, product):
    if product == "bookings":
        return db.execute("SELECT COUNT(*) FROM bookings").fetchone()[0]
    if product == "pos":
        # every till sale that wasn't voided (refunds aren't sales)
        return db.execute("SELECT COUNT(*) FROM pos_sales WHERE voided=0").fetchone()[0]
    # posted customer invoices that weren't voided; quotes and orders are free, and till sales count toward POS
    return db.execute("SELECT COUNT(*) FROM documents d WHERE d.side='sale' AND d.status IN ('open','paid')"
                      " AND NOT EXISTS (SELECT 1 FROM pos_sales p WHERE p.document_id=d.id)").fetchone()[0]


def plan(db, product):
    """{'product', 'licensed', 'trial', 'left' (trial days left), 'limit' (trial length), 'used', 'locked', 'warn', 'one', 'many'}"""
    st = _status()
    licensed = st["mode"] == "licensed"
    # No licence file yet (Riyeser Central not installed or not opened): treat it as the start of the trial.
    trial = st["mode"] in ("trial", "unknown")
    left = st.get("days_left", TRIAL_DAYS) if trial else 0
    one, many = WHAT[product]
    return dict(product=product, licensed=licensed, trial=trial and not licensed, used=used(db, product),
                left=left, limit=TRIAL_DAYS, one=one, many=many,
                locked=not licensed and not trial, warn=not licensed and trial and left <= WARN_DAYS)


def capped_message(product):
    _, many = WHAT[product]
    return (f"Your {TRIAL_DAYS}-day free trial has ended. Enter a Riyeser licence in Riyeser Central to keep adding "
            f"{many}. Nothing has been deleted.")
