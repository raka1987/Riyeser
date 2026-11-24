"""Demo mode, switched on and off by Riyeser Central for the whole suite.

Central asks once, on first start: start blank, or explore with demo data. It records the choice in
%APPDATA%\\Riyeser\\demo.json (~/.config/Riyeser/demo.json elsewhere), next to company.json and licence.json:
    {"on": true, "since": "<ISO time>", "business": "Sample Trading Co"}
No file, a damaged file or "on": false means normal mode. RIYESER_DEMO_FILE points somewhere else (tests, dev).

While demo mode is on every program uses <normal data folder>/demo/ instead of the normal folder, so real books
are never touched. Accounting, Invoices, Bookings and POS share one data folder, so they share one demo folder
too: whichever opens first makes the demo company there, and the others open the same file.
Leaving demo mode is Central's job: it sets "on": false and renames <data>/demo to <data>/demo-ended-<UTC stamp>.
"""
import json
import os
import time

DEMO_FOLDER = "demo"
DEMO_COMPANY = "Sample Trading Co (demo)"
DEMO_USER = "demo"
DEMO_PASSWORD = "demo"


def demo_file():
    env = os.environ.get("RIYESER_DEMO_FILE")
    if env:
        return env
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "Riyeser", "demo.json")


def read(path=None):
    """demo.json as a dict ({} when there's none or it can't be read)."""
    try:
        with open(path or demo_file(), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def demo_on(path=None):
    return read(path).get("on") is True


def data_dir(normal, path=None):
    """The data folder to use: <normal>/demo while demo mode is on, otherwise <normal> itself."""
    return os.path.join(str(normal), DEMO_FOLDER) if demo_on(path) else str(normal)


def db_path(normal_db, path=None):
    """The company file to use, given the normal one: the same file name inside the demo folder in demo mode."""
    return demo_db(normal_db) if demo_on(path) else normal_db


def demo_db(normal_db):
    folder, name = os.path.split(os.path.abspath(normal_db))
    return os.path.join(folder, DEMO_FOLDER, name)


def ensure_company(app):
    """Make the demo company in the demo folder if it isn't there yet (first start, or after Central moved the
    old demo aside). Safe when several programs start at once: one builds it under a lock, the others wait and
    then open the same file. Returns True if this call made it."""
    path = app.config["DATABASE"]
    if os.path.exists(path):
        return False
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    lock = os.path.join(folder, ".making-demo.lock")
    for _ in range(2):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            end = time.time() + 60  # someone else is making it
            while time.time() < end and os.path.exists(lock) and not os.path.exists(path):
                time.sleep(0.2)
            if os.path.exists(path):
                return False
            try:  # a lock left behind by a program that stopped part way: take it over
                if time.time() - os.path.getmtime(lock) > 60:
                    os.replace(lock, lock + f".stale-{int(time.time())}")
            except OSError:
                pass
    else:
        return False
    try:
        os.close(fd)
        if os.path.exists(path):
            return False
        building = path + ".building"
        if os.path.exists(building):  # a half-made file from an earlier try: set it aside, never deleted
            os.replace(building, f"{building}.{int(time.time())}.unfinished")
        _build(app, building)
        os.replace(building, path)
        from . import archive
        archive.copy_head_into(path, folder)
        return True
    finally:
        try:
            os.replace(lock, lock + ".done")
        except OSError:
            pass


def _build(app, target):
    from flask import g
    from werkzeug.security import generate_password_hash
    from .db import init_db, get_db
    from .demo import seed_demo
    with app.app_context():
        g.db_path = target
        init_db(DEMO_COMPANY, DEMO_PASSWORD)
        db = get_db()
        seed_demo(db)
        # the demo sign-in: demo / demo, an administrator (the usual admin login stays too, with the same password)
        db.execute("INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)",
                   (DEMO_USER, generate_password_hash(DEMO_PASSWORD), "Demo user", "admin"))
        db.commit()
