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


def subscribed(product=None):
    """True when this computer has an active Riyeser licence (kept up to date by Riyeser Central)."""
    from .licence import status
    return status()["mode"] == "licensed"


def used(db, product):
    if product == "pos":
        # every till sale that wasn't voided (refunds aren't sales)
        return db.execute("SELECT COUNT(*) FROM pos_sales WHERE voided=0").fetchone()[0]
    # posted customer invoices that weren't voided; quotes and orders are free, and till sales count toward POS
    return db.execute("SELECT COUNT(*) FROM documents d WHERE d.side='sale' AND d.status IN ('open','paid')"
                      " AND NOT EXISTS (SELECT 1 FROM pos_sales p WHERE p.document_id=d.id)").fetchone()[0]


def limit_for(product):
    """The free cap: from the licence file if Riyeser's server has set one ("caps"), else FREE_LIMITS."""
    import json
    from .licence import licence_file
    try:
        with open(licence_file(), encoding="utf-8") as f:
            caps = json.load(f).get("caps") or {}
        key = {"basic": "accounting-basics"}.get(product, product)
        v = caps.get(key, caps.get(product))
        if isinstance(v, int) and v >= 0:
            return v
    except (OSError, ValueError, AttributeError):
        pass
    return FREE_LIMITS[product]


def plan(db, product):
    """{'product', 'licensed', 'used', 'left', 'limit', 'locked', 'warn', 'one', 'many'}"""
    limit = limit_for(product)
    licensed = subscribed(product)
    n = used(db, product)
    left = max(limit - n, 0)
    one, many = WHAT[product]
    return dict(product=product, licensed=licensed, used=n, left=left, limit=limit, one=one, many=many,
                locked=not licensed and left == 0, warn=not licensed and left > 0 and n >= limit * WARN_AT)


def capped_message(product):
    limit, (_, many) = limit_for(product), WHAT[product]
    return (f"You've used your {limit} free {many}. Enter a Riyeser licence in Riyeser Central to keep going. "
            "Nothing has been deleted.")
