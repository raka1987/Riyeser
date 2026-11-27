"""Free for 90 days, then a subscription.

Riyeser pricing (riyeser.com/pricing.html): every paid program — Riyeser Accounting Basics, Accounting Plus, Riyeser POS,
Payroll and As Built — is free for 90 days with no card, then one price per business per month in US dollars, with 3 users
included (Basics US$25, Plus US$39, POS US$29, Bookings US$25, Payroll US$25; see PRICE_USD in riyeser/db.py).
The trial and the licence are kept by Riyeser Central in licence.json (see riyeser/licence.py).

When the trial ends without a licence, nothing is deleted or hidden. Only the paid actions stop (a new till sale, a new
invoice) until a licence is entered; everything else keeps working and every record stays.

This is the one place that decides it, so a billing backend can take over `subscribed()` without touching the screens.
"""
from .licence import TRIAL_DAYS

WARN_DAYS = 14      # remind people in the last two weeks of the trial
WHAT = {"pos": ("sale", "sales"), "basic": ("invoice", "invoices"), "bookings": ("booking", "bookings"),
        "estimate": ("estimate", "estimates")}


# Each app's paid actions and the licence module that unlocks them (riyeser/licence.py MODULES).
MODULE = {"pos": "pos", "basic": "basic", "bookings": "bookings", "estimate": "estimate"}


def _status(product=None):
    from .licence import status
    return status(product=MODULE.get(product, product)) if product else status()


def subscribed(product=None):
    """True when this computer has an active Riyeser licence (kept up to date by Riyeser Central)."""
    return _status(product)["mode"] == "licensed"


def used(db, product):
    if product == "bookings":
        return db.execute("SELECT COUNT(*) FROM bookings").fetchone()[0]
    if product == "estimate":
        return db.execute("SELECT COUNT(*) FROM takeoffs").fetchone()[0]
    if product == "pos":
        # every till sale that wasn't voided (refunds aren't sales)
        return db.execute("SELECT COUNT(*) FROM pos_sales WHERE voided=0").fetchone()[0]
    # posted customer invoices that weren't voided; quotes and orders are free, and till sales count toward POS
    return db.execute("SELECT COUNT(*) FROM documents d WHERE d.side='sale' AND d.status IN ('open','paid')"
                      " AND NOT EXISTS (SELECT 1 FROM pos_sales p WHERE p.document_id=d.id)").fetchone()[0]


def plan(db, product):
    """{'product', 'licensed', 'trial', 'left' (trial days left), 'limit' (trial length), 'used', 'locked', 'warn', 'one', 'many'}"""
    st = _status(product)
    licensed = st["mode"] == "licensed"
    # No licence file yet (Riyeser Central not installed or not opened): treat it as the start of the trial.
    trial = st["mode"] in ("trial", "unknown")
    left = st.get("days_left", TRIAL_DAYS) if trial else 0
    one, many = WHAT[product]
    return dict(product=product, licensed=licensed, trial=trial and not licensed, used=used(db, product),
                left=left, limit=TRIAL_DAYS, one=one, many=many,
                locked=not licensed and not trial, warn=not licensed and trial and left <= WARN_DAYS)


# What's locked, what still works, the price and where to add it: the same pattern in every Riyeser program.
HOME_URL = "https://riyeser.com/link/"   # the Riyeser home page, where paid programs are added
from .db import PRICES as _USD   # the one price list (riyeser/db.py PRICE_USD)
PRICES = {k: f"{_USD[k]}/month" for k in ("basic", "plus", "pos", "bookings")}
PRICES["estimate"] = "price to be announced"   # Riyeser Estimate: 90 days free; the price after that isn't set yet
NAMES = {"basic": "Accounting Basics", "plus": "Accounting Plus", "pos": "Riyeser POS", "bookings": "Riyeser Bookings",
         "estimate": "Riyeser Estimate"}
STILL_WORKS = {
    "basic": "Quotes, customers, stock, payments and reports all still work.",
    "pos": "Your sales, receipts, close-till reports, products and stock are all still here.",
    "bookings": "Your calendar and every booking are still here to see and print.",
    "estimate": "Your estimates, measurements, plans and quotes are all still here to view, print and send.",
    "plus": "Invoices, customers, stock and reports still work; banking, payroll, journals, jobs and budgets are kept safe.",
}


def locked_notice(product):
    """{'title', 'text', 'home_url', 'price'} for a paid program that isn't on, or None when it is (or still on trial)."""
    st = _status(product)
    if st["mode"] != "expired":
        return None
    name, price = NAMES.get(product, "This program"), PRICES.get(product, "")
    many = WHAT[product][1] if product in WHAT else "work"
    paused = f"New {many} are paused." if product in WHAT else "Banking, payroll, journals, jobs and budgets are locked."
    if st.get("message"):   # not checked for 30 days, couldn't be checked, the clock, or an older Central
        title = st["message"]
    elif st.get("source") == "online":
        title = f"{name} isn't part of your Riyeser plan right now."
    else:
        title = f"Your {TRIAL_DAYS}-day free trial has ended."
    return {"title": title, "home_url": HOME_URL, "price": price,
            "text": f"{paused} {STILL_WORKS.get(product, '')} Nothing has been deleted. "
                    f"To carry on, add {name} from your Riyeser home page ({price})."}


def capped_message(product):
    _, many = WHAT[product]
    st = _status(product)
    n = locked_notice(product)
    if st.get("message") and n:
        return f"{n['title']} New {many} are paused until then. Nothing has been deleted."
    if st.get("source") == "online":
        return (f"This program isn't part of your Riyeser plan right now, so new {many} are paused. "
                f"{STILL_WORKS[product]} Nothing has been deleted. To carry on, add {NAMES[product]} from your Riyeser home page "
                f"({PRICES[product]}).")
    return (f"Your {TRIAL_DAYS}-day free trial has ended, so new {many} are paused. {STILL_WORKS[product]} Nothing has been "
            f"deleted. To carry on, add {NAMES[product]} from your Riyeser home page ({PRICES[product]}).")
