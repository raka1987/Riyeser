"""Backups of company files (S38, S39 and the owner's standard OWNER-BACKUP, the same in every Riyeser program).

Where: Documents\\Riyeser\\Accounting\\Backups\\<company>\\ (outside the install folder, so backups survive
uninstalling, reinstalling and moving PCs; RIYESER_DOCS moves the Documents\\Riyeser part). <company> is the company
file's own name without ".db": "company" for the first company, the file name under companies\\ for the others.

Each backup is a plain SQLite copy of the company file named "<YYYY-MM-DD HHMMSS> <company name>.db", taken with
SQLite's online backup (safe while people are working). One automatic backup a day per company; the last 30 are kept
per company. Riyeser Central's "Back up everything / Restore everything" reads and writes these same folders.
"""
import os
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

KEEP = 30
REMIND_DAYS = 7
SUFFIX = ".db"


def root() -> Path:
    from .pdf import docs_root
    return docs_root() / "Accounting" / "Backups"


def folder_for(db_path) -> Path:
    return root() / Path(db_path).stem


def company_name(db_path):
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            r = con.execute("SELECT name FROM company WHERE id=1").fetchone()
        finally:
            con.close()
        return r[0] if r else None
    except sqlite3.Error:
        return None


def _clean(s):
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", s or "").strip().rstrip(".")
    return re.sub(r"\s+", " ", s)[:60] or "company"


def copy_db(src, dest):
    """A consistent copy of a live SQLite file (SQLite's online backup)."""
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    s = sqlite3.connect(str(src), timeout=30)
    d = sqlite3.connect(str(dest))
    try:
        with d:
            s.backup(d)
    finally:
        d.close()
        s.close()
    return Path(dest)


def backup_now(db_path, now=None, folder=None, keep=KEEP):
    """Back up one company file into its backups folder (or `folder`); keeps the newest `keep` there."""
    now = now or datetime.now()
    dest_dir = Path(folder) if folder else folder_for(db_path)
    name = _clean(company_name(db_path) or Path(db_path).stem)
    dest = dest_dir / f"{now:%Y-%m-%d %H%M%S} {name}{SUFFIX}"
    n = 1
    while dest.exists():
        n += 1
        dest = dest_dir / f"{now:%Y-%m-%d %H%M%S} {name} ({n}){SUFFIX}"
    copy_db(db_path, dest)
    if keep:
        prune(dest_dir, keep)
    return dest


def list_backups(db_path):
    """Newest first: [{'path', 'name', 'when', 'size'}]."""
    d = folder_for(db_path)
    if not d.is_dir():
        return []
    out = []
    for p in d.glob(f"*{SUFFIX}"):
        try:
            st = p.stat()
        except OSError:
            continue
        out.append(dict(path=p, name=p.name, when=datetime.fromtimestamp(st.st_mtime), size=st.st_size))
    return sorted(out, key=lambda b: (b["when"], b["name"]), reverse=True)


def prune(dest_dir, keep=KEEP):
    files = sorted(Path(dest_dir).glob(f"*{SUFFIX}"), key=lambda p: (p.stat().st_mtime, p.name), reverse=True)
    for p in files[keep:]:
        try:
            p.unlink()
        except OSError:
            pass


def last_backup(db_path):
    b = list_backups(db_path)
    return b[0]["when"] if b else None


def daily_backup(db_path, now=None):
    """The automatic backup: at most one a day per company. Returns the new file, or None."""
    now = now or datetime.now()
    last = last_backup(db_path)
    if last and last.date() == now.date():
        return None
    return backup_now(db_path, now)


def needs_reminder(db_path, now=None):
    last = last_backup(db_path)
    return last is None or (now or datetime.now()) - last > timedelta(days=REMIND_DAYS)


# ---------------------------------------------------------------- restoring
def describe(path):
    """What a backup holds: {'name', 'counts': {...}, 'last_date'}; ValueError when it isn't a company file."""
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            r = con.execute("SELECT name FROM company WHERE id=1").fetchone()
            if not r:
                raise ValueError
            q = lambda sql: con.execute(sql).fetchone()[0]
            counts = {"invoices": q("SELECT COUNT(*) FROM documents WHERE side='sale' AND status<>'quote'"),
                      "bills": q("SELECT COUNT(*) FROM documents WHERE side='purchase'"),
                      "customers and suppliers": q("SELECT COUNT(*) FROM contacts"),
                      "transactions": q("SELECT COUNT(*) FROM journal_entries"),
                      "users": q("SELECT COUNT(*) FROM users")}
            last = q("SELECT MAX(date) FROM journal_entries")
        finally:
            con.close()
    except (sqlite3.Error, ValueError, TypeError):
        raise ValueError("That file isn't a Riyeser Accounting company file or backup.")
    return dict(name=r[0], counts=counts, last_date=last)


def restore_over(backup_path, live_path, now=None):
    """Put a backup in place of a company file, after saving a before-restore copy of the current one.
    Returns the before-restore copy's path."""
    describe(backup_path)
    now = now or datetime.now()
    before = None
    if os.path.exists(live_path):
        name = _clean(company_name(live_path) or Path(live_path).stem)
        before = folder_for(live_path) / f"{now:%Y-%m-%d %H%M%S} {name} (before restore){SUFFIX}"
        copy_db(live_path, before)
    # copy in place (the file may be held open elsewhere, so its contents are replaced, not the file)
    src = sqlite3.connect(str(backup_path))
    dst = sqlite3.connect(str(live_path), timeout=30)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return before


def restored_name(name, now=None):
    now = now or datetime.now()
    return f"{name} (restored {now.day} {now:%b %Y})"


def incoming_dir() -> Path:
    d = root() / "_incoming"
    d.mkdir(parents=True, exist_ok=True)
    return d


def take_upload(fileobj, filename):
    """Save an uploaded backup to look at before restoring. Returns its token (file name)."""
    import secrets
    token = f"{secrets.token_hex(8)}.db"
    dest = incoming_dir() / token
    fileobj.save(str(dest))
    try:
        describe(dest)
    except ValueError:
        dest.unlink(missing_ok=True)
        raise
    return token


def incoming(token):
    if not re.fullmatch(r"[0-9a-f]{16}\.db", token or ""):
        return None
    p = incoming_dir() / token
    return p if p.is_file() else None


def discard(token):
    p = incoming(token)
    if p:
        p.unlink(missing_ok=True)

