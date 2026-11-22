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


def add_company(name, abn=None, edition="enterprise", owner=None, demo=False):
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

