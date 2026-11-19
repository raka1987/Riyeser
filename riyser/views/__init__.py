"""Shared view helpers."""
from functools import wraps

from flask import flash, redirect, request, g, abort

from ..db import get_db, to_cents
from ..ledger import PostingError


def lookups(db=None):
    db = db or get_db()
    return dict(
        accounts=db.execute("SELECT * FROM accounts WHERE active=1 ORDER BY code").fetchall(),
        bank_accounts=db.execute("SELECT * FROM accounts WHERE active=1 AND is_bank=1 ORDER BY code").fetchall(),
        tax_codes=db.execute("SELECT * FROM tax_codes ORDER BY code").fetchall(),
        jobs=db.execute("SELECT * FROM jobs WHERE active=1 ORDER BY code").fetchall(),
    )


def opt_int(v):
    try:
        return int(v) if v not in (None, "") else None
    except ValueError:
        return None


def opt_float(v, default=0.0):
    try:
        return float(str(v).replace(",", "")) if v not in (None, "") else default
    except ValueError:
        return default


def form_lines(fields):
    """Zip parallel request.form lists ('line_<field>') into a list of dicts."""
    cols = {f: request.form.getlist(f"line_{f}") for f in fields}
    n = max((len(v) for v in cols.values()), default=0)
    return [{f: (cols[f][i] if i < len(cols[f]) else "") for f in fields} for i in range(n)]


def guarded(fn):
    """Wrap a POST handler: commit on success, rollback + flash on PostingError/ValueError."""
    @wraps(fn)
    def wrapper(*a, **kw):
        db = get_db()
        try:
            resp = fn(*a, **kw)
            db.commit()
            return resp
        except (PostingError, ValueError) as e:
            db.rollback()
            flash(str(e), "error")
            return redirect(request.referrer or request.path)
    return wrapper


def admin_only(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if not g.user or g.user["role"] != "admin":
            abort(403)
        return fn(*a, **kw)
    return wrapper


__all__ = ["lookups", "opt_int", "opt_float", "form_lines", "guarded", "admin_only", "to_cents"]
