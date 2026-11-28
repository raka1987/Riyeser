"""Who's selling at the till: PIN sign-in, "Switch cashier", auto-lock and the wrong-PIN lockout (riyeser/pos_pins.py).

While a cashier is signed in at the till by PIN, every till screen and action (riyeser/views/pos*.py) runs as that
cashier: g.user is the cashier, so sales, refunds, "No sale", opening and closing the till are recorded against them,
and the usual permission checks (riyeser/perms.py) use the cashier's own access. g.signed_in is the person signed in
on the PC. Pages outside the till (the back office) stay with the person signed in on the PC.
"""
import secrets
from datetime import date

from flask import g, request, session, jsonify, redirect, url_for

from ..db import get_db, audit
from .. import pos_pins as P
from . import opt_int
from .pos import bp

# Till pages that still open while the till is locked: the till itself (it shows the lock screen), the PIN pad's own
# calls, product photos, and printing a receipt that was already made.
OPEN_WHEN_LOCKED = {"pos.register", "pos.cashier_state", "pos.cashier_unlock", "pos.cashier_lock", "pos.photo",
                    "pos.receipt"}
# The POS's set-up pages are back office (they open from the back office's Setup menu): they stay with the person
# signed in on the PC and never lock. The till's own menu only shows them to a cashier who may change setup.
BACK_OFFICE = {"pos.setup", "pos.set_mode", "pos.approvals", "pos.hardware", "pos.hardware_save", "pos.hardware_start",
               "pos.hardware_test_print", "pos.hardware_test_docket", "pos.hardware_scanner_tested",
               "pos.hardware_preview", "pos.hardware_align", "pos.card_setup", "pos.drawer_setup", "pos.drawer_test",
               "pos.kitchen_setup"}


def _company_key():
    from .. import companies as co
    return session.get("co") or co.MAIN


def device_id():
    d = session.get("pos_device")
    if not d:
        d = session["pos_device"] = secrets.token_hex(8)
    return d


def _entry():
    return (session.get("till_cashier") or {}).get(_company_key())


def _set(uid):
    tc = dict(session.get("till_cashier") or {})
    if uid:
        tc[_company_key()] = {"uid": uid, "at": P.now()}
    else:
        tc.pop(_company_key(), None)
    session["till_cashier"] = tc


def _event(db, kind, uid, till_id=None):
    signed = g.get("signed_in") or g.get("user")
    db.execute("INSERT INTO pos_cashier_events (kind, user_id, signed_in_id, till_id) VALUES (?,?,?,?)",
               (kind, uid, signed["id"] if signed else None, till_id))


def current(db):
    """The cashier signed in at this till (a users row), or None when the till is locked."""
    e = _entry()
    if not e:
        return None
    lock = P.settings(db)["lock_minutes"]
    if lock and P.now() - float(e.get("at") or 0) > lock * 60 + P.GRACE:
        _event(db, "auto_lock", e.get("uid"))
        db.commit()
        _set(None)
        return None
    u = db.execute("SELECT * FROM users WHERE id=? AND active=1", (e.get("uid"),)).fetchone()
    if not u or not u["pos_pin_hash"] or not P.can_sell(u):
        _set(None)
        return None
    return u


def till_user(db):
    """Called for every request before the permission check (riyeser/__init__.py). For the till's pages, act as the
    cashier who signed in by PIN; with nobody signed in, the till is locked. Returns a response to stop, else None."""
    ep = request.endpoint or ""
    if not ep.startswith("pos.") or ep in BACK_OFFICE or g.get("user") is None:
        return None
    if not P.active(db) or not P.can_sell(g.user):
        return None   # no PINs in use (or the PC user has no till access): the till works as before
    g.signed_in = g.user
    c = current(db)
    if c is not None:
        g.user = g.cashier = c
        e = _entry()
        e["at"] = P.now()
        _set(c["id"])
        return None
    g.till_locked = True
    if ep in OPEN_WHEN_LOCKED:
        return None
    if request.method == "GET" and not request.is_json and "application/json" not in (request.headers.get("Accept") or ""):
        return redirect(url_for("pos.register"))
    return jsonify(ok=False, locked=True, error="The till is locked. Tap your name and enter your PIN."), 423


def lock_ctx(db):
    """What the till screens need for the lock screen and the "Switch cashier" button."""
    if not P.active(db) or g.get("signed_in") is None:
        return dict(pins_on=False)
    s = P.settings(db)
    tiles = [dict(id=u["id"], name=P.name_of(u)) for u in P.todays(db, date.today().isoformat())]
    c = g.get("cashier")
    return dict(pins_on=True, lock_minutes=s["lock_minutes"], cashier_tiles=tiles,
                cashier=dict(id=c["id"], name=P.name_of(c)) if c is not None else None,
                till_locked=bool(g.get("till_locked")), signed_in_name=P.name_of(g.signed_in))


@bp.app_context_processor
def _till_lock():
    """The till screens (pos/_pos.html) show the lock screen and the cashier's name."""
    if not (request.endpoint or "").startswith("pos.") or g.get("user") is None:
        return {}
    try:
        return {"tl_lock": lock_ctx(get_db())}
    except Exception:
        return {}


@bp.route("/cashier/state")
def cashier_state():
    db = get_db()
    return jsonify(lock_ctx(db))


@bp.route("/cashier/unlock", methods=["POST"])
def cashier_unlock():
    """Tap your name and enter your PIN (or just a PIN: PINs are unique). Opens the till for that person."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    if not P.active(db):
        return jsonify(ok=False, error="Till PINs aren't in use. Add a Till PIN under Users & roles."), 400
    dev, uid, till = device_id(), opt_int(d.get("user_id")), opt_int(d.get("till_id"))
    wait = P.wrong_left(db, dev, uid)
    if wait:
        return jsonify(ok=False, error=f"Too many wrong PINs. Try again in {wait} seconds.", wait=wait), 429
    pin = str(d.get("pin") or "").strip()
    people = P.cashiers(db)
    if uid:
        who = next((u for u in people if u["id"] == uid), None)
        if who is not None and not P.matches(who, pin):
            who = None
    else:
        who = next((u for u in people if P.matches(u, pin)), None) if pin else None
    if who is None:
        target = db.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone() if uid else None
        P.record_wrong(db, dev, uid, till, "unlock")
        audit(db, "pos_pin_failed", f"till sign-in{' as ' + target['username'] if target else ''}"
                                    f"{' (till ' + str(till) + ')' if till else ''}")
        db.commit()
        wait = P.wrong_left(db, dev, uid)
        if wait:
            return jsonify(ok=False, error=f"Too many wrong PINs. Try again in {wait} seconds.", wait=wait), 429
        return jsonify(ok=False, error="That PIN isn't right. Try again."), 400
    P.clear_wrong(db, dev, who["id"])
    _set(who["id"])
    g.cashier = who
    _event(db, "open_till" if d.get("purpose") == "open" else "unlock", who["id"], till)
    audit(db, "pos_cashier", f"{who['username']} at the till" + (f" (till {till})" if till else ""))
    db.commit()
    return jsonify(ok=True, cashier=dict(id=who["id"], name=P.name_of(who)))


@bp.route("/cashier/lock", methods=["POST"])
def cashier_lock():
    """"Switch cashier" / lock: the till goes back to the "Who's selling?" screen. Auto-lock calls this too."""
    db = get_db()
    e = _entry()
    if e:
        _event(db, "auto_lock" if (request.get_json(silent=True) or {}).get("auto") else "lock", e.get("uid"))
        db.commit()
    _set(None)
    return jsonify(ok=True)
