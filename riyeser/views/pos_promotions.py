"""Riyeser POS › Promotions: the screen where promotions are made and switched on or off. The rules that work a
sale out are in riyeser/pos_promos.py."""
import json
import re
from datetime import date, datetime

from flask import render_template, request, redirect, url_for, flash

from ..db import get_db, audit, to_cents
from ..ledger import PostingError
from .. import perms
from .. import pos_promos as PR
from . import guarded, once, opt_int
from .pos import bp, pos_config


def _clock(v):
    v = (v or "").strip()
    if not v:
        return None
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v):
        raise PostingError("Times look like 15:00 (3 pm).")
    return v


def _day(v, what):
    v = (v or "").strip()
    if not v:
        return None
    try:
        return date.fromisoformat(v).isoformat()
    except ValueError:
        raise PostingError(f"The {what} date isn't a date.")


def clean(db, f):
    """A promotion from the form, checked. Raises PostingError with a plain message."""
    name = " ".join((f.get("name") or "").split())[:40]
    if not name:
        raise PostingError("Give the promotion a name. It prints on the receipt, for example Happy hour.")
    kind = f.get("kind") if f.get("kind") in PR.KINDS else "percent"
    raw = (f.get("value") or "").strip().replace("%", "")
    try:
        value = float(raw) if kind == "percent" else to_cents(raw)
    except (ValueError, TypeError, ArithmeticError):
        raise PostingError("Type how much comes off, as a number.")
    if kind == "percent" and not 0 < value <= 100:
        raise PostingError("A percentage off is between 1 and 100.")
    if kind == "amount" and value <= 0:
        raise PostingError("Type the amount to take off.")
    scope = f.get("scope") if f.get("scope") in PR.SCOPES else "sale"
    category = item_id = None
    if scope == "category":
        category = (f.get("category") or "").strip()
        if not category:
            raise PostingError("Choose the category this promotion is for.")
    elif scope == "item":
        item_id = opt_int(f.get("item_id"))
        if not item_id or not db.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone():
            raise PostingError("Choose the product this promotion is for.")
    start, end = _day(f.get("start_date"), "start"), _day(f.get("end_date"), "end")
    if start and end and end < start:
        raise PostingError("The end date is before the start date.")
    days = sorted({int(d) for d in f.getlist("days") if d.isdigit() and 0 <= int(d) <= 6})
    code = re.sub(r"\s+", "", (f.get("code") or "")).upper()[:20] or None
    if code:
        other = db.execute("SELECT id FROM pos_promotions WHERE UPPER(code)=? AND id IS NOT ?",
                           (code, opt_int(f.get("id")))).fetchone()
        if other:
            raise PostingError(f"Another promotion already uses the code {code}.")
    return dict(name=name, kind=kind, value=value, scope=scope, category=category, item_id=item_id, start_date=start,
                end_date=end, days=json.dumps(days) if days and len(days) < 7 else None,
                time_from=_clock(f.get("time_from")), time_to=_clock(f.get("time_to")), code=code)


def can_change():
    return perms.can("setup", perms.FULL)


@bp.route("/promotions", methods=["GET", "POST"])
def promotions():
    db = get_db()
    if request.method == "POST":
        if not can_change():
            flash("Only an owner or administrator can change promotions.", "error")
            return redirect(url_for("pos.promotions"))
        return _save()
    rows = db.execute("SELECT p.*, i.name item_name FROM pos_promotions p LEFT JOIN items i ON i.id=p.item_id"
                      " ORDER BY p.active DESC, p.id DESC").fetchall()
    now = datetime.now()
    listed = []
    for r in rows:
        j = PR.as_json(r)
        ended = bool(j["end"] and j["end"] < now.strftime("%Y-%m-%d"))
        state = "off" if not r["active"] else "ended" if ended else \
            "code" if j["code"] and PR.is_on(j, now, [j["code"]]) else "on" if PR.is_on(j, now) else "later"
        listed.append(dict(row=r, j=j, when=PR.when_text(j), state=state,
                           what=r["item_name"] if r["scope"] == "item" else r["category"] if r["scope"] == "category"
                           else "Everything"))
    edit = next((x for x in listed if x["row"]["id"] == opt_int(request.args.get("edit"))), None)
    items = db.execute("SELECT id, name, sku FROM items WHERE active=1 AND parent_id IS NULL AND (is_sold=1 OR"
                       " has_variants=1) ORDER BY name").fetchall()
    cats = [r[0] for r in db.execute("SELECT DISTINCT category FROM items WHERE active=1 AND category IS NOT NULL"
                                     " AND category<>'' ORDER BY category")]
    mode, _features = pos_config(db)
    return render_template("pos/promotions.html", promos=listed, edit=edit, items=items, cats=cats, kinds=PR.KINDS,
                           scopes=PR.SCOPES, day_names=PR.DAY_NAMES, can_change=can_change(), mode=mode,
                           new=bool(request.args.get("new")) or (not listed and can_change()))


@guarded
@once
def _save():
    db = get_db()
    f = request.form
    pid = opt_int(f.get("id"))
    row = db.execute("SELECT * FROM pos_promotions WHERE id=?", (pid,)).fetchone() if pid else None
    what = f.get("what")
    if what in ("on", "off", "delete"):
        if not row:
            raise PostingError("That promotion is no longer there.")
        if what == "delete":
            db.execute("DELETE FROM pos_promotions WHERE id=?", (pid,))   # past receipts keep its name
            db.execute("UPDATE pos_sale_promos SET promo_id=NULL WHERE promo_id=?", (pid,))
            flash(f"{row['name']} removed. Receipts already printed keep it.", "ok")
        else:
            db.execute("UPDATE pos_promotions SET active=? WHERE id=?", (1 if what == "on" else 0, pid))
            flash(f"{row['name']} is {'on' if what == 'on' else 'off'}.", "ok")
        audit(db, "pos_promotion", f"{what}: {row['name']}")
        return redirect(url_for("pos.promotions"))
    p = clean(db, f)
    cols = list(p)
    if row:
        db.execute(f"UPDATE pos_promotions SET {', '.join(c + '=?' for c in cols)} WHERE id=?",
                   [p[c] for c in cols] + [pid])
    else:
        db.execute(f"INSERT INTO pos_promotions ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                   [p[c] for c in cols])
    audit(db, "pos_promotion", f"{'changed' if row else 'new'}: {json.dumps(p)}")
    flash(f"{p['name']} saved. " + ("The cashier types the code " + p["code"] + " at the till to use it." if p["code"]
                                    else "The till applies it by itself."), "ok")
    return redirect(url_for("pos.promotions"))
