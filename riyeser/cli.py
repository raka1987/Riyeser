"""`riyeser` command - installed by `pip install riyeser-accounting`.

    riyeser                       # open Riyeser Accounting in its own desktop window
    riyeser serve                 # run it in the browser on http://127.0.0.1:8080
    riyeser serve --host 0.0.0.0  # share on your network (multi-user)
    riyeser init --name "Acme Pty Ltd" [--demo] [--force]
    riyeser backup [path]
"""
import argparse
import os
import secrets
import sys
import webbrowser
from datetime import datetime
from pathlib import Path


def data_dir(arg=None) -> Path:
    d = Path(arg or os.environ.get("RIYESER_HOME") or Path.home() / ".riyeser")
    d.mkdir(parents=True, exist_ok=True)
    return d


def _configure(args):
    d = data_dir(args.data_dir)
    if args.db:
        os.environ["RIYESER_DB"] = str(Path(args.db))
    else:
        os.environ.setdefault("RIYESER_DB", str(d / "company.db"))
    key_file = d / "secret.key"
    if not key_file.exists():
        key_file.write_text(secrets.token_hex(32))
        try:
            key_file.chmod(0o600)
        except OSError:
            pass
    os.environ.setdefault("RIYESER_SECRET", key_file.read_text().strip())
    return os.environ["RIYESER_DB"]


def cmd_serve(args):
    db_path = _configure(args)
    from . import create_app
    app = create_app()
    db_path = app.config["DATABASE"]  # the demo folder's file while Riyeser Central's demo mode is on
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '') else args.host}:{args.port}"
    print(f"Riyeser Accounting\n  company file: {db_path}\n  open: {url}\n  (Ctrl+C to stop)")
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
            sys.exit(f"{db_path} already exists. Use --force to replace it (a locked archive copy is made first).")
        from .db import _archive_before_replacing
        _archive_before_replacing(db_path, "init --force from the command line")
    from . import create_app
    from .db import init_db, get_db, _keep_ledger_head
    app = create_app({"DEMO_MODE": False})  # init always makes the real company file it was asked for
    with app.app_context():
        init_db(args.name, args.password, args.edition)
        if args.demo:
            from .demo import seed_demo
            seed_demo(get_db())
    _keep_ledger_head(db_path)
    print(f"Created {db_path}  (login: admin / {'<your password>' if args.password != 'admin' else 'admin'})")


def cmd_backup(args):
    db_path = _configure(args)
    if not os.path.exists(db_path):
        sys.exit("No company file to back up.")
    from . import backups
    # safe online backup, even while the server is running; by default into Documents\Riyeser\Accounting\Backups
    dest = backups.copy_db(db_path, Path(args.path)) if args.path else backups.backup_now(db_path)
    print(f"Backed up to {dest}")


RESET_GONE = ("There's no command-line password reset: anyone at this computer could have used it.\n"
              "Ask an administrator to set a new password under Setup > Users & Roles, or click 'Forgot password?'\n"
              "on the sign-in screen of the desktop app: you'll need a code emailed to you, or the business owner's\n"
              "Riyeser account.")


def cmd_reset_password(args):
    sys.exit(RESET_GONE)


def cmd_desktop(args):
    from .desktop import main as desktop_main
    extra = []
    if args.data_dir:
        extra += ["--data-dir", args.data_dir]
    if args.db:
        os.environ["RIYESER_DB"] = args.db
    if getattr(args, "no_window", False):
        extra.append("--no-window")
    desktop_main(extra)


def main(argv=None):
    p = argparse.ArgumentParser(prog="riyeser", description="Riyeser Accounting")
    p.add_argument("--data-dir", help="folder for the company file (default ~/.riyeser)")
    p.add_argument("--db", help="path to a specific company file (.db)")
    sub = p.add_subparsers(dest="cmd")
    w = sub.add_parser("desktop", help="open in a desktop window (default)")
    w.add_argument("--no-window", action="store_true")
    w.set_defaults(fn=cmd_desktop)
    s = sub.add_parser("serve", help="run the web application")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8080)
    s.add_argument("--no-browser", action="store_true")
    s.set_defaults(fn=cmd_serve)
    i = sub.add_parser("init", help="create a new company file")
    i.add_argument("--name", default="My Company Pty Ltd")
    i.add_argument("--password", default="admin")
    i.add_argument("--demo", action="store_true", help="load demo data")
    i.add_argument("--edition", choices=["basic", "enterprise"], default=None)
    i.add_argument("--force", action="store_true")
    i.set_defaults(fn=cmd_init)
    r = sub.add_parser("reset-password", help=argparse.SUPPRESS)  # removed: explains what to do instead
    r.add_argument("rest", nargs=argparse.REMAINDER)
    r.set_defaults(fn=cmd_reset_password)
    b = sub.add_parser("backup", help="back up the company file")
    b.add_argument("path", nargs="?")
    b.set_defaults(fn=cmd_backup)
    argv = list(sys.argv[1:] if argv is None else argv)
    args = p.parse_args(argv)
    if not args.cmd:  # plain `riyeser` = the desktop app
        args = p.parse_args(argv + ["desktop"])
    args.fn(args)


if __name__ == "__main__":
    main()
