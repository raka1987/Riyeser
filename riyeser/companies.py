"""Several companies in one Riyeser Accounting.

Each company keeps its own company file (its own books, users and permissions). A small list next to the main
company file - companies.json - records the others:
    <data folder>/company.db              the first company (as before)
    <data folder>/companies/<slug>.db     companies added later
    <data folder>/companies.json          [{"id", "file", "archived"}]   names and ABNs are read from each file
Nothing is ever deleted here: a company can be archived (hidden from the switcher) and brought back.
"""
import json
import os
import re
import secrets
import sqlite3
from contextlib import contextmanager

from flask import current_app, g, session

MAIN = "main"


def _folder():
    return os.path.dirname(os.path.abspath(current_app.config["DATABASE"]))


def _registry_file():
    return os.path.join(_folder(), "companies.json")


def _read_registry():
    try:
        with open(_registry_file(), encoding="utf-8") as f:
            data = json.load(f)
        return [c for c in data if isinstance(c, dict) and c.get("id") and c.get("file")]
    except (OSError, ValueError):
        return []


def _write_registry(items):
    path = _registry_file()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=2)
    os.replace(tmp, path)


def path_of(cid):
    if not cid or cid == MAIN:
        return current_app.config["DATABASE"]
    for c in _read_registry():
        if c["id"] == cid:
            p = c["file"] if os.path.isabs(c["file"]) else os.path.join(_folder(), c["file"])
            return p if os.path.exists(p) else None
    return None


def _details(path):
    """Name and ABN straight from a company file (read-only, quick)."""
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            r = con.execute("SELECT name, abn FROM company WHERE id=1").fetchone()
        finally:
            con.close()
        return {"name": r[0], "abn": r[1]} if r else None
    except sqlite3.Error:
        return None


def all_companies(include_archived=False):
    out = []
    main = current_app.config["DATABASE"]
    if os.path.exists(main):
        d = _details(main) or {"name": "Main company", "abn": None}
        out.append({"id": MAIN, "path": main, "archived": False, **d})
    for c in _read_registry():
        if c.get("archived") and not include_archived:
            continue
        p = path_of(c["id"])
        if not p:
            continue
        d = _details(p)
        if d:
            out.append({"id": c["id"], "path": p, "archived": bool(c.get("archived")), **d})
    return out


def current_id():
    cid = session.get("co") or MAIN
    return cid if path_of(cid) else MAIN


@contextmanager
def using(path):
    """Run code against another company file (get_db() follows it), then switch back."""
    saved_path, saved_db = g.get("db_path"), g.pop("db", None)
    g.db_path = path
    try:
        yield
    finally:
        db = g.pop("db", None)
        if db is not None:
            db.close()
        g.db_path = saved_path
        if saved_db is not None:
            g.db = saved_db


def _slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "company"
    return f"{s}-{secrets.token_hex(3)}"


def add_company(name, abn=None, edition=None, owner=None, demo=False):
    """Create a new company file. owner = users row of the person creating it: they become its administrator
    with the same username and password, so one sign-in reaches both companies."""
    from .db import init_db, get_db
    name = (name or "").strip()
    if not name:
        raise ValueError("Enter the company's name.")
    os.makedirs(os.path.join(_folder(), "companies"), exist_ok=True)
    cid = _slug(name)
    rel = os.path.join("companies", f"{cid}.db")
    path = os.path.join(_folder(), rel)
    with using(path):
        init_db(name, secrets.token_urlsafe(16), edition)
        db = get_db()
        if owner is not None:
            db.execute("UPDATE users SET username=?, password_hash=?, full_name=? WHERE username='admin'",
                       (owner["username"], owner["password_hash"], owner["full_name"]))
        if demo:
            from .demo import seed_demo
            seed_demo(db)
        db.execute("UPDATE company SET name=?, abn=? WHERE id=1", (name, (abn or "").strip() or None))
        db.commit()
    items = _read_registry()
    items.append({"id": cid, "file": rel, "archived": False})
    _write_registry(items)
    return cid


def import_company(src_path, original_name="company.db"):
    """Bring in an existing Riyeser company file (copied in; the original is left alone)."""
    import shutil
    d = _details(src_path)
    if not d:
        raise ValueError("That isn't a Riyeser Accounting company file.")
    os.makedirs(os.path.join(_folder(), "companies"), exist_ok=True)
    cid = _slug(d["name"])
    rel = os.path.join("companies", f"{cid}.db")
    shutil.copyfile(src_path, os.path.join(_folder(), rel))
    items = _read_registry()
    items.append({"id": cid, "file": rel, "archived": False})
    _write_registry(items)
    return cid, d["name"]


def set_archived(cid, archived):
    if cid == MAIN:
        raise ValueError("The first company can't be archived.")
    items = _read_registry()
    for c in items:
        if c["id"] == cid:
            c["archived"] = bool(archived)
    _write_registry(items)


# ------------------------------------------------------------------ who can open which company
def user_row(path, username):
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            return con.execute("SELECT * FROM users WHERE username=? AND active=1", (username,)).fetchone()
        finally:
            con.close()
    except sqlite3.Error:
        return None


def access_after_login(username, password_hash_used):
    """Companies this person reaches with one sign-in: the same username with the same password
    (the same stored password, as set up from the Users screen)."""
    out = {}
    for c in all_companies():
        u = user_row(c["path"], username)
        if u and u["password_hash"] == password_hash_used:
            out[c["id"]] = u["id"]
    return out



# ------------------------------------------------------------------ extra companies are an add-on
def allowance():
    from .licence import company_allowance
    return company_allowance()


def active_ids():
    return [c["id"] for c in all_companies()]


def within_allowance(cid):
    """Companies beyond what the plan includes stay open read-only (nothing is ever locked away)."""
    n = allowance()
    if n is None:
        return True
    ids = active_ids()
    return cid not in ids or ids.index(cid) < n


def can_add_another():
    n = allowance()
    return n is None or len(active_ids()) < n


# ------------------------------------------------------------------ start again (an archive copy is kept first)
# Counters and the lock date belong to the old books, so a blank company starts them afresh.
_NOT_CARRIED = {"id", "next_invoice_no", "next_bill_no", "lock_date", "is_demo"}


def data_folder():
    return _folder()


def _rows(con, sql):
    try:
        return [dict(r) for r in con.execute(sql)]
    except sqlite3.Error:
        return []


def _insert(db, table, row, cols):
    keep = {k: v for k, v in row.items() if k in cols}
    if keep:
        db.execute(f"INSERT INTO {table} ({', '.join(keep)}) VALUES ({', '.join('?' for _ in keep)})",
                   tuple(keep.values()))


def reset_in_place(live_path):
    """Make the company file blank again without replacing the file (Windows may hold it open): build a fresh
    company file next to it, carry over the company details, every user (same sign-ins and access) and the audit
    history, then copy the fresh file's contents over the live one. Call archive.archive_company first."""
    from .db import init_db, get_db, EDITIONS
    from .demo import DEMO_DETAILS
    old = sqlite3.connect(live_path, timeout=30)
    old.row_factory = sqlite3.Row
    try:
        comp = dict(old.execute("SELECT * FROM company WHERE id=1").fetchone())
        users = _rows(old, "SELECT * FROM users ORDER BY id")
        audits = _rows(old, "SELECT * FROM audit_log ORDER BY id")
        meta = _rows(old, "SELECT * FROM archive_meta")
    finally:
        old.close()
    tmp = f"{live_path}.fresh-{secrets.token_hex(4)}.db"
    try:
        with using(tmp):
            init_db(comp["name"], secrets.token_urlsafe(16), comp.get("edition") if comp.get("edition") in EDITIONS else None)
            db = get_db()
            db.execute("PRAGMA foreign_keys = OFF")
            cols = {r["name"] for r in db.execute("PRAGMA table_info(company)")}
            keep = {k: v for k, v in comp.items() if k in cols and k not in _NOT_CARRIED}
            if comp.get("is_demo"):  # the demo's made-up address and ABN don't belong in the real books
                for k, v in DEMO_DETAILS.items():
                    if keep.get(k) == v:
                        keep[k] = None
            keep["is_demo"] = 0
            db.execute(f"UPDATE company SET {', '.join(f'{k}=?' for k in keep)} WHERE id=1", tuple(keep.values()))
            db.execute("DELETE FROM users")  # the fresh file's own admin: replaced by the real users just below
            ucols = {r["name"] for r in db.execute("PRAGMA table_info(users)")}
            for u in users:
                _insert(db, "users", u, ucols)
            acols = {r["name"] for r in db.execute("PRAGMA table_info(audit_log)")}
            for a in audits:
                _insert(db, "audit_log", a, acols)
            for m in meta:
                _insert(db, "archive_meta", m, {"key", "value"})
            db.commit()
        fresh = sqlite3.connect(tmp)
        live = sqlite3.connect(live_path, timeout=30)
        try:
            fresh.backup(live)
        finally:
            live.close()
            fresh.close()
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)  # the temporary fresh file only; the old records are in the archive copy


def _audit_into(path, user_id, details):
    con = sqlite3.connect(path, timeout=30)
    try:
        con.execute("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)", (user_id, "start_again", details))
        con.commit()
    finally:
        con.close()


def _describe(e):
    return f"{e['file']} (SHA-256 {e['sha256']}, {e['bytes']} bytes)"


def start_again(cid, username, reason=""):
    """Archive one company, then make it blank. Returns the archive log entry."""
    from . import archive
    path = path_of(cid)
    main = current_app.config["DATABASE"]
    name = (_details(path) or {}).get("name") or ""
    e = archive.archive_company(path, _folder(), cid, name, by=username, reason=reason, main_db=main)
    reset_in_place(path)
    archive.copy_head_into(main, _folder())
    u = user_row(path, username)
    _audit_into(path, u["id"] if u else None,
                f"Started again by {username}. Old records kept in archive/{_describe(e)}."
                + (f" Reason: {reason}" if reason else ""))
    return e


def admin_everywhere(username):
    """True when this person is an active administrator in every company, archived ones included."""
    for c in all_companies(include_archived=True):
        u = user_row(c["path"], username)
        if not u or u["role"] != "admin":
            return False
    return True


def start_everything_again(username, reason=""):
    """Archive every company file, make the main company blank, and archive (hide) every other company.
    Their files stay where they are. Returns the archive log entries."""
    from . import archive
    main = current_app.config["DATABASE"]
    companies = all_companies(include_archived=True)
    done = [archive.archive_company(c["path"], _folder(), c["id"], c["name"], by=username, reason=reason, main_db=main)
            for c in companies]
    reset_in_place(main)
    archive.copy_head_into(main, _folder())
    for c in companies:
        if c["id"] != MAIN:
            set_archived(c["id"], True)
    u = user_row(main, username)
    _audit_into(main, u["id"] if u else None,
                f"Started everything again by {username}. {len(done)} compan{'y' if len(done) == 1 else 'ies'} archived: "
                + "; ".join(f"{e['company_name']}: archive/{_describe(e)}" for e in done)
                + ". Other companies were archived (hidden); their files are kept."
                + (f" Reason: {reason}" if reason else ""))
    return done
