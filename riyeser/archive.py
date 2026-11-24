"""Locked archive copies of company files, and a chained log of them, for a forensic check later.

Before a company is started again, its file is copied to
    <data folder>/archive/<company id>-<UTC YYYYMMDD-HHMMSS>.db     read-only, never overwritten
and one JSON line is added to
    <data folder>/archive/ledger.jsonl                             append only
with the copy's SHA-256 and size. Each line carries "prev", the SHA-256 of the previous line's exact text
("genesis" for the first), so a changed or removed line breaks the chain. The newest line has no later line to
vouch for it, so its hash (the "ledger head") is also kept in archive/head.json and in the main company file
(table archive_meta).

Nothing here deletes or rewrites an archive copy or a log line. There is deliberately no function to do so.
"""
import hashlib
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

PROGRAM = "accounting"
ARCHIVE_DIR = "archive"
LEDGER = "ledger.jsonl"
HEAD = "head.json"
HEAD_KEY = "ledger_head"

UNCHANGED = "Unchanged"
CHANGED = "File changed since it was archived"
MISSING = "File missing"
ALTERED = "Log entry altered"

_LOCK = threading.Lock()


def archive_dir(data_folder):
    return os.path.join(data_folder, ARCHIVE_DIR)


def fingerprint(path):
    """SHA-256 (hex) and size in bytes of a file."""
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def line_hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _ledger_lines(data_folder):
    """The log's lines as exact bytes, without their newlines."""
    try:
        with open(os.path.join(archive_dir(data_folder), LEDGER), "rb") as f:
            data = f.read()
    except FileNotFoundError:
        return []
    lines = data.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    return lines


def _reserve(adir, company_id):
    """A new, empty file for the copy. An existing file is never reused or overwritten."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    safe = "".join(ch for ch in str(company_id) if ch.isalnum() or ch in "-_") or "company"
    n = 1
    while True:
        name = f"{safe}-{stamp}.db" if n == 1 else f"{safe}-{stamp}-{n}.db"
        path = os.path.join(adir, name)
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            n += 1
            continue
        os.close(fd)
        return path


def _name_in(path):
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            r = con.execute("SELECT name FROM company WHERE id=1").fetchone()
        finally:
            con.close()
        return r[0] if r else None
    except sqlite3.Error:
        return None


def archive_company(src_path, data_folder, company_id, company_name=None, by="", reason="", main_db=None):
    """Make a consistent, read-only copy of a company file and log it. Returns the log entry (a dict)."""
    adir = archive_dir(data_folder)
    os.makedirs(adir, exist_ok=True)
    with _LOCK:
        dest = _reserve(adir, company_id)
        src = sqlite3.connect(src_path, timeout=30)
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)  # a consistent copy, even while the company is open elsewhere
        finally:
            dst.close()
            src.close()
        os.chmod(dest, 0o444)
        digest, size = fingerprint(dest)
        entry = {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "program": PROGRAM,
                 "company_id": company_id, "company_name": company_name or _name_in(dest) or "",
                 "file": os.path.basename(dest), "sha256": digest, "bytes": size, "by": by or "",
                 "reason": reason or "", "prev": None}
        _append(data_folder, entry, main_db)
    return entry


def _append(data_folder, entry, main_db):
    lines = _ledger_lines(data_folder)
    entry["prev"] = line_hash(lines[-1]) if lines else "genesis"
    raw = json.dumps(entry, ensure_ascii=False).encode("utf-8")
    path = os.path.join(archive_dir(data_folder), LEDGER)
    with open(path, "ab") as f:  # append only
        if f.tell() and not _ends_with_newline(path):
            f.write(b"\n")
        f.write(raw + b"\n")
        f.flush()
        os.fsync(f.fileno())
    head = line_hash(raw)
    _write_head(data_folder, head, len(lines) + 1)
    if main_db:
        store_head_in(main_db, head)


def _ends_with_newline(path):
    with open(path, "rb") as f:
        f.seek(-1, os.SEEK_END)
        return f.read(1) == b"\n"


def _write_head(data_folder, head, count):
    path = os.path.join(archive_dir(data_folder), HEAD)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"head": head, "lines": count}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_head_file(data_folder):
    try:
        with open(os.path.join(archive_dir(data_folder), HEAD), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def store_head_in(db_path, head):
    con = sqlite3.connect(db_path, timeout=30)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS archive_meta (key TEXT PRIMARY KEY, value TEXT)")
        con.execute("INSERT OR REPLACE INTO archive_meta (key, value) VALUES (?, ?)", (HEAD_KEY, head))
        con.commit()
    finally:
        con.close()


def read_head_in(db_path):
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            r = con.execute("SELECT value FROM archive_meta WHERE key=?", (HEAD_KEY,)).fetchone()
        finally:
            con.close()
        return r[0] if r else None
    except sqlite3.Error:
        return None


def copy_head_into(db_path, data_folder):
    """A brand-new main company file (made from the command line) carries on the existing log's head."""
    h = read_head_file(data_folder)
    if h and h.get("head"):
        store_head_in(db_path, h["head"])


def entries(data_folder):
    """The log as dicts, oldest first (unchecked). A line that can't be read comes back as {}."""
    out = []
    for raw in _ledger_lines(data_folder):
        try:
            e = json.loads(raw.decode("utf-8"))
            out.append(e if isinstance(e, dict) else {})
        except ValueError:
            out.append({})
    return out


def check(data_folder, main_db):
    """Check every archived copy and the log itself.
    Returns {"rows": [...newest first], "ok": bool, "count": n, "bad": n, "problems": [str], "summary": str}."""
    lines = _ledger_lines(data_folder)
    adir = archive_dir(data_folder)
    parsed, altered = [], set()
    for i, raw in enumerate(lines):
        try:
            e = json.loads(raw.decode("utf-8"))
            if not isinstance(e, dict):
                raise ValueError
        except ValueError:
            e = None
            altered.add(i)
        parsed.append(e)
        expect = line_hash(lines[i - 1]) if i else "genesis"
        if e is not None and e.get("prev") != expect:
            altered.add(i - 1 if i else 0)  # the line before was changed or removed (or this one's link was)
    problems = []
    head_file = read_head_file(data_folder)
    head_db = read_head_in(main_db) if main_db and os.path.exists(main_db) else None
    if lines:
        last = line_hash(lines[-1])
        if not head_file or head_file.get("head") != last or head_db != last:
            altered.add(len(lines) - 1)
        if head_file and isinstance(head_file.get("lines"), int) and head_file["lines"] > len(lines):
            problems.append(f"The log should have {head_file['lines']} entries but has {len(lines)}.")
    elif (head_file and head_file.get("head")) or head_db:
        problems.append("The log of archived copies is missing or empty, but copies were made before.")
    rows = []
    for i, e in enumerate(parsed):
        e = e or {}
        if i in altered:
            status = ALTERED
        else:
            path = os.path.join(adir, os.path.basename(str(e.get("file") or "")))
            if not e.get("file") or not os.path.isfile(path):
                status = MISSING
            else:
                digest, size = fingerprint(path)
                status = UNCHANGED if (digest == e.get("sha256") and size == e.get("bytes")) else CHANGED
        rows.append({"at": e.get("at", ""), "company_name": e.get("company_name", ""), "company_id": e.get("company_id", ""),
                     "by": e.get("by", ""), "reason": e.get("reason", ""), "file": e.get("file", ""),
                     "sha256": e.get("sha256", ""), "bytes": e.get("bytes"), "status": status})
    bad = sum(1 for r in rows if r["status"] != UNCHANGED)
    ok = not bad and not problems
    n = len(rows)
    if not n and ok:
        summary = "No archived copies yet."
    elif ok:
        summary = f"All {n} archived cop{'y is' if n == 1 else 'ies are'} unchanged."
    else:
        summary = (f"{bad} of {n} archived cop{'y needs' if n == 1 else 'ies need'} attention." if bad
                   else "The archived copies look unchanged, but the log has a problem.")
    rows.reverse()
    return {"rows": rows, "ok": ok, "count": n, "bad": bad, "problems": problems, "summary": summary}
