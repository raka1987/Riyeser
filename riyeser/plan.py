"""Free allowances, then a subscription.

Every Riyeser program is free up to a cap, then needs a subscription (a Riyeser licence, entered in Riyeser Central):
  * Riyeser POS:               the first 500 till sales in each company file
  * Riyeser Accounting Basics: the first 50 invoices in each company file
Reaching the cap never deletes or hides anything. Only the one action that's capped (a new sale, a new invoice) stops
until a licence is entered; everything else keeps working and every record stays.

This is the one place that decides it, so the caps can change, or a subscription/billing backend can take over
`subscribed()`, without touching the screens.
"""
FREE_LIMITS = {"pos": 500, "basic": 50}
WARN_AT = 0.8       # warn once 80% of the free allowance is used
WHAT = {"pos": ("sale", "sales"), "basic": ("invoice", "invoices")}


# licence.json (written by Riyeser Central from Riyeser's server) can carry, per product:
#   "products": {"basics"|"plus"|"pos"|...: {"paid": bool, "until": ISO date, "warning": str}}
#   "caps":     {"basic": 50, "pos": 500, ..., "warnAt": 0.8}
PRODUCT_KEYS = {"basic": ("basics", "plus"),   # Plus includes everything in Basics
                "pos": ("pos",)}


def _licence_json():
    import json
    from .licence import licence_file
    try:
        with open(licence_file(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _paid(entry, now):
    from .licence import _when
    if not isinstance(entry, dict) or not entry.get("paid"):
        return False
    until = _when(entry.get("until")) if entry.get("until") else None
    if until is not None and until.tzinfo is None:
        from datetime import timezone
        until = until.replace(tzinfo=timezone.utc)
    return until is None or until > now


def subscribed(product=None, now=None):
    """True when this product is paid for on this computer.
    With per-product subscriptions in the licence file, only that product's own subscription counts (a POS-only
    subscription doesn't unlock Basics). Older licence files without "products" fall back to the suite licence."""
    from datetime import datetime, timezone
    now = now or datetime.now(timezone.utc)
    products = _licence_json().get("products")
    if isinstance(products, dict) and product in PRODUCT_KEYS:
        return any(_paid(products.get(k), now) for k in PRODUCT_KEYS[product])
    from .licence import status
    return status(now)["mode"] == "licensed"


def warn_at():
    caps = _licence_json().get("caps")
    v = caps.get("warnAt") if isinstance(caps, dict) else None
    return v if isinstance(v, (int, float)) and 0 < v <= 1 else WARN_AT


def used(db, product):
    if product == "pos":
        # every till sale that wasn't voided (refunds aren't sales)
        return db.execute("SELECT COUNT(*) FROM pos_sales WHERE voided=0").fetchone()[0]
    # posted customer invoices that weren't voided; quotes and orders are free, and till sales count toward POS
    return db.execute("SELECT COUNT(*) FROM documents d WHERE d.side='sale' AND d.status IN ('open','paid')"
                      " AND NOT EXISTS (SELECT 1 FROM pos_sales p WHERE p.document_id=d.id)").fetchone()[0]


def limit_for(product):
    """The free cap: from the licence file if Riyeser's server has set one ("caps"), else FREE_LIMITS."""
    caps = _licence_json().get("caps")
    if isinstance(caps, dict):
        key = {"basic": "accounting-basics"}.get(product, product)
        v = caps.get(product, caps.get(key))
        if isinstance(v, int) and not isinstance(v, bool) and v >= 0:
            return v
    return FREE_LIMITS[product]


def plan(db, product):
    """{'product', 'licensed', 'used', 'left', 'limit', 'locked', 'warn', 'one', 'many'}"""
    limit = limit_for(product)
    licensed = subscribed(product)
    n = used(db, product)
    left = max(limit - n, 0)
    one, many = WHAT[product]
    return dict(product=product, licensed=licensed, used=n, left=left, limit=limit, one=one, many=many,
                locked=not licensed and left == 0, warn=not licensed and left > 0 and n >= limit * warn_at())


def capped_message(product):
    limit, (_, many) = limit_for(product), WHAT[product]
    return (f"You've used your {limit} free {many}. Enter a Riyeser licence in Riyeser Central to keep going. "
            "Nothing has been deleted.")
