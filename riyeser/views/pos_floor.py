"""Riyeser POS, restaurants: tables and areas (POS setup › Tables).

An area is a part of the venue ("Inside", "Outside", "Bar"); each table has a name or number, the area it is in and
how many it seats. The till's Tables screen shows them by area. An order remembers its table by name
(pos_orders.table_no), so renaming a table renames it on its open order too, and a table with an open order can't
be removed.
"""
import re

from flask import render_template, request, redirect, url_for, flash

from ..db import get_db, audit
from ..ledger import PostingError
from .. import perms
from . import guarded, once, opt_int
from .pos import bp, pos_config

NAME_MAX = 10   # pos_orders.table_no holds 10 characters
MAX_TABLES = 300


def areas(db):
    return db.execute("SELECT * FROM pos_areas ORDER BY sort, id").fetchall()


def tables(db):
    return db.execute("SELECT t.*, a.name area FROM pos_tables t LEFT JOIN pos_areas a ON a.id=t.area_id"
                      " WHERE t.active=1 ORDER BY a.sort, a.id, t.sort, t.id").fetchall()


def floor(db):
    """[{area, tables: [{name, seats}]}] for the till's Tables screen."""
    out, by = [], {}
    for a in areas(db):
        by[a["id"]] = dict(area=a["name"], tables=[])
        out.append(by[a["id"]])
    for t in tables(db):
        if t["area_id"] not in by:
            by[t["area_id"]] = dict(area="", tables=[])
            out.append(by[t["area_id"]])
        by[t["area_id"]]["tables"].append(dict(name=t["name"], seats=t["seats"]))
    return [a for a in out if a["tables"]]


def busy_tables(db):
    return {r["table_no"] for r in db.execute("SELECT table_no FROM pos_orders WHERE status IN ('open','billing')"
                                              " AND order_type='dine_in' AND table_no IS NOT NULL")}


def parse_names(text):
    """"1-10" or "A1, A2, Bar 1" -> the table names, in order ("1-10" is ten tables)."""
    out = []
    for bit in re.split(r"[,;\n]+", text or ""):
        bit = " ".join(bit.split())
        if not bit:
            continue
        m = re.fullmatch(r"(\d{1,4})\s*(?:-|to)\s*(\d{1,4})", bit)
        if m and int(m.group(1)) <= int(m.group(2)):
            if int(m.group(2)) - int(m.group(1)) >= MAX_TABLES:
                raise PostingError(f"That's a lot of tables. Add up to {MAX_TABLES} at a time.")
            out += [str(n) for n in range(int(m.group(1)), int(m.group(2)) + 1)]
        elif len(bit) > NAME_MAX:
            raise PostingError(f"“{bit}” is too long for a table name. Keep it to {NAME_MAX} characters, "
                               "for example 12, A3 or Deck 4.")
        else:
            out.append(bit)
    return out


def _seats(v, default=4):
    n = opt_int(v)
    return min(max(n, 1), 99) if n else default


def add_tables(db, area_id, text, seats=4):
    names = parse_names(text)
    have = {t["name"].lower() for t in tables(db)}
    added = []
    nxt = (db.execute("SELECT COALESCE(MAX(sort),0) FROM pos_tables").fetchone()[0] or 0) + 1
    for n in names:
        if n.lower() in have:
            raise PostingError(f"There's already a table called {n}. Each table needs its own name or number.")
        have.add(n.lower())
        db.execute("INSERT INTO pos_tables (area_id, name, seats, sort) VALUES (?,?,?,?)", (area_id, n, seats, nxt))
        nxt += 1
        added.append(n)
    if len(have) > MAX_TABLES:
        raise PostingError(f"Riyeser POS holds up to {MAX_TABLES} tables.")
    return added


def add_area(db, name):
    name = " ".join((name or "").split())[:30]
    if not name:
        raise PostingError("Give the area a name, for example Inside or Outside.")
    if any(a["name"].lower() == name.lower() for a in areas(db)):
        raise PostingError(f"There's already an area called {name}.")
    nxt = (db.execute("SELECT COALESCE(MAX(sort),0) FROM pos_areas").fetchone()[0] or 0) + 1
    return db.execute("INSERT INTO pos_areas (name, sort) VALUES (?,?)", (name, nxt)).lastrowid


@bp.route("/tables", methods=["GET", "POST"])
def tables_setup():
    db = get_db()
    can_change = perms.can("setup", perms.FULL)
    if request.method == "POST":
        if not can_change:
            flash("Only an owner or administrator can change the tables.", "error")
            return redirect(url_for("pos.tables_setup"))
        return _save()
    mode, features = pos_config(db)
    rows = tables(db)
    return render_template("pos/tables.html", areas=areas(db), tables=rows, busy=busy_tables(db), mode=mode,
                           tables_on="tables" in features, can_change=can_change, name_max=NAME_MAX,
                           by_area={a["id"]: [t for t in rows if t["area_id"] == a["id"]] for a in areas(db)},
                           loose=[t for t in rows if t["area_id"] not in {a["id"] for a in areas(db)}])


@guarded
@once
def _save():
    db = get_db()
    f = request.form
    busy = busy_tables(db)
    area_ids = {a["id"] for a in areas(db)}
    done = []
    # ---- tables: rename, seats, move to another area, remove
    removed = renamed = 0
    current = tables(db)
    for t in current:
        tid = t["id"]
        if f.get(f"table_remove_{tid}"):
            if t["name"] in busy:
                raise PostingError(f"Table {t['name']} has an open order. Finish or move the order, then remove it.")
            db.execute("DELETE FROM pos_tables WHERE id=?", (tid,))
            removed += 1
            continue
        if f.get(f"table_name_{tid}") is None:
            continue
        name = " ".join(f.get(f"table_name_{tid}").split())
        if not name:
            raise PostingError("A table needs a name or number. To take one away, tick Remove.")
        if len(name) > NAME_MAX:
            raise PostingError(f"“{name}” is too long for a table name. Keep it to {NAME_MAX} characters.")
        area = opt_int(f.get(f"table_area_{tid}"))
        area = area if area in area_ids else t["area_id"]
        db.execute("UPDATE pos_tables SET name=?, seats=?, area_id=? WHERE id=?",
                   (name, _seats(f.get(f"table_seats_{tid}"), t["seats"]), area, tid))
        if name != t["name"]:
            renamed += 1
            # the open order at that table follows the new name
            db.execute("UPDATE pos_orders SET table_no=? WHERE table_no=? AND order_type='dine_in' AND status IN"
                       " ('open','billing')", (name, t["name"]))
    names = [t["name"].lower() for t in tables(db)]
    twice = next((n for n in names if names.count(n) > 1), None)
    if twice:
        raise PostingError(f"Two tables are called {twice}. Each table needs its own name or number.")
    # ---- areas: rename, remove (with its tables), new tables in the area
    for a in areas(db):
        aid = a["id"]
        if f.get(f"area_remove_{aid}"):
            stuck = [t["name"] for t in tables(db) if t["area_id"] == aid and t["name"] in busy]
            if stuck:
                raise PostingError(f"{a['name']} has an open order on table {stuck[0]}. Finish or move the order, "
                                   "then remove the area.")
            removed += db.execute("DELETE FROM pos_tables WHERE area_id=?", (aid,)).rowcount
            db.execute("DELETE FROM pos_areas WHERE id=?", (aid,))
            done.append(f"{a['name']} removed")
            continue
        name = " ".join((f.get(f"area_name_{aid}") or a["name"]).split())[:30]
        if name != a["name"]:
            if any(x["name"].lower() == name.lower() and x["id"] != aid for x in areas(db)):
                raise PostingError(f"There's already an area called {name}.")
            db.execute("UPDATE pos_areas SET name=? WHERE id=?", (name, aid))
        new = add_tables(db, aid, f.get(f"new_tables_{aid}"), _seats(f.get(f"new_seats_{aid}")))
        if new:
            done.append(f"{len(new)} table{'' if len(new) == 1 else 's'} added to {name}")
    # ---- a new area (with its first tables)
    if (f.get("new_area") or "").strip() or (f.get("new_area_tables") or "").strip():
        aid = add_area(db, f.get("new_area") or ("Inside" if not areas(db) else ""))
        new = add_tables(db, aid, f.get("new_area_tables"), _seats(f.get("new_area_seats")))
        nm = db.execute("SELECT name FROM pos_areas WHERE id=?", (aid,)).fetchone()[0]
        done.append(f"{nm} added" + (f" with {len(new)} table{'' if len(new) == 1 else 's'}" if new else ""))
    if removed:
        done.append(f"{removed} table{'' if removed == 1 else 's'} removed")
    if renamed:
        done.append(f"{renamed} renamed")
    audit(db, "pos_tables", "; ".join(done) or "saved")
    flash("Tables saved" + (": " + ", ".join(done) + "." if done else "."), "ok")
    return redirect(url_for("pos.tables_setup"))
