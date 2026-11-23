"""Riyeser Accounting / Riyeser POS desktop app.

Runs the accounting server privately on this computer and shows it in its
own application window (via pywebview).  If no window toolkit is available
it falls back to opening the default web browser.
"""
import argparse
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_until_up(url, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(url + "/login", timeout=1)
            return True
        except Exception:
            time.sleep(0.2)
    return False


# Screens Riyeser Central can open the app on (quick access): --page=pos opens the Shop counter.
START_PAGES = {"pos": "/pos/", "invoice": "/sale/new"}


def start_path(page):
    """The address to open for --page (anything unknown opens the usual home screen)."""
    return START_PAGES.get((page or "").strip().lower(), "")


def main(argv=None):
    from .db import EDITIONS, POS_APP
    from .edition import app_edition, is_pos_app
    ed = app_edition()
    app_name = POS_APP["app"] if is_pos_app() else EDITIONS[ed]["app"] if ed else "Riyeser Accounting"
    if is_pos_app() and not any(a.startswith("--page") for a in (argv if argv is not None else sys.argv[1:])):
        argv = list(argv if argv is not None else sys.argv[1:]) + ["--page=pos"]  # Riyeser POS opens on the till
    p = argparse.ArgumentParser(prog=app_name)
    p.add_argument("--data-dir", help="folder for the company file (default ~/.riyeser)")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--no-window", action="store_true", help="run the server only (for testing)")
    p.add_argument("--page", help="open on this screen: pos (Shop counter) or invoice (New invoice)")
    p.add_argument("command", nargs="?", help="init / serve / backup - same as the riyeser command")
    args, rest = p.parse_known_args(argv)
    if args.command:  # the desktop build doubles as the full riyeser command
        from .cli import main as cli_main
        return cli_main(([] if not args.data_dir else ["--data-dir", args.data_dir]) + [args.command] + rest)

    from .cli import data_dir, _configure
    ns = argparse.Namespace(data_dir=args.data_dir, db=None)
    _configure(ns)
    from . import create_app
    app = create_app({"LOCAL_RESET": True})

    port = args.port or _free_port()
    url = f"http://127.0.0.1:{port}"
    from waitress import serve
    t = threading.Thread(target=serve, args=(app,), kwargs=dict(host="127.0.0.1", port=port, threads=8,
                                                                _quiet=True), daemon=True)
    t.start()
    if not _wait_until_up(url):
        print(f"{app_name} failed to start.", file=sys.stderr)
        sys.exit(1)
    print(f"{app_name} running at {url}  (company file: {os.environ['RIYESER_DB']})", flush=True)

    if args.no_window:
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return
    try:
        import webview
        try:
            webview.settings["ALLOW_DOWNLOADS"] = True  # PDFs, CSV exports
        except Exception:
            pass
        webview.create_window(app_name, url + start_path(args.page), width=1360, height=860, min_size=(1000, 650))
        webview.start()
    except Exception as e:  # no GUI toolkit - use the browser instead
        print(f"(No app window available: {e}; opening your browser instead. Close this window to quit.)")
        webbrowser.open(url + start_path(args.page))
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
