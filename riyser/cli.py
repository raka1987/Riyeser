"""`riyser` command - installed by `pip install riyser-accounting`.

    riyser serve                 # run the web app on http://127.0.0.1:8080
    riyser serve --host 0.0.0.0  # share on your network (multi-user)
    riyser init --name "Acme Pty Ltd" [--demo] [--force]
    riyser backup [path]
"""
import argparse
import os
import secrets
import shutil
import sys
import webbrowser
from datetime import datetime
from pathlib import Path


def data_dir(arg=None) -> Path:
    d = Path(arg or os.environ.get("RIYSER_HOME") or Path.home() / ".riyser")
    d.mkdir(parents=True, exist_ok=True)
    return d


def _configure(args):
    d = data_dir(args.data_dir)
    os.environ.setdefault("RIYSER_DB", str(Path(args.db) if args.db else d / "company.db"))
    key_file = d / "secret.key"
    if not key_file.exists():
        key_file.write_text(secrets.token_hex(32))
        try:
            key_file.chmod(0o600)
        except OSError:
            pass
    os.environ.setdefault("RIYSER_SECRET", key_file.read_text().strip())
    return os.environ["RIYSER_DB"]


def cmd_serve(args):
    db_path = _configure(args)
    from . import create_app
    app = create_app()
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '') else args.host}:{args.port}"
    print(f"Riyser Accounting\n  company file: {db_path}\n  open: {url}\n  (Ctrl+C to stop)")
    if not os.path.exists(db_path):
        print("  No company file yet - the browser will show the setup screen.")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        from waitress import serve
        serve(app, host=args.host, port=args.port, threads=8)
    except ImportError:
        app.run(host=args.host, port=args.port)


def cmd_init(args):
    db_path = _configure(args)
    if os.path.exists(db_path):
        if not args.force:
            sys.exit(f"{db_path} already exists. Use --force to replace it (a backup is made first).")
        shutil.copy2(db_path, f"{db_path}.{datetime.now():%Y%m%d-%H%M%S}.bak")
        os.remove(db_path)
    from . import create_app
    from .db import init_db, get_db
    app = create_app()
    with app.app_context():
        init_db(args.name, args.password)
        if args.demo:
            from .demo import seed_demo
            seed_demo(get_db())
    print(f"Created {db_path}  (login: admin / {'<your password>' if args.password != 'admin' else 'admin'})")


def cmd_backup(args):
    db_path = _configure(args)
    if not os.path.exists(db_path):
        sys.exit("No company file to back up.")
    import sqlite3
    dest = Path(args.path or f"{db_path}.{datetime.now():%Y%m%d-%H%M%S}.bak")
    src = sqlite3.connect(db_path)
    out = sqlite3.connect(dest)
    with out:
        src.backup(out)  # safe online backup, even while the server is running
    src.close(); out.close()
    print(f"Backed up to {dest}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="riyser", description="Riyser Accounting")
    p.add_argument("--data-dir", help="folder for the company file (default ~/.riyser)")
    p.add_argument("--db", help="path to a specific company file (.db)")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="run the web application")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8080)
    s.add_argument("--no-browser", action="store_true")
    s.set_defaults(fn=cmd_serve)
    i = sub.add_parser("init", help="create a new company file")
    i.add_argument("--name", default="My Company Pty Ltd")
    i.add_argument("--password", default="admin")
    i.add_argument("--demo", action="store_true", help="load demo data")
    i.add_argument("--force", action="store_true")
    i.set_defaults(fn=cmd_init)
    b = sub.add_parser("backup", help="back up the company file")
    b.add_argument("path", nargs="?")
    b.set_defaults(fn=cmd_backup)
    argv = list(sys.argv[1:] if argv is None else argv)
    args = p.parse_args(argv)
    if not args.cmd:  # plain `riyser` = serve with defaults
        args = p.parse_args(argv + ["serve"])
    args.fn(args)


if __name__ == "__main__":
    main()
