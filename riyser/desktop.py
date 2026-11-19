"""Riyser Accounting desktop app.

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


def main(argv=None):
    p = argparse.ArgumentParser(prog="Riyser Accounting")
    p.add_argument("--data-dir", help="folder for the company file (default ~/.riyser)")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--no-window", action="store_true", help="run the server only (for testing)")
    args = p.parse_args(argv)

    from .cli import data_dir, _configure
    ns = argparse.Namespace(data_dir=args.data_dir, db=None)
    _configure(ns)
    from . import create_app
    app = create_app()

    port = args.port or _free_port()
    url = f"http://127.0.0.1:{port}"
    from waitress import serve
    t = threading.Thread(target=serve, args=(app,), kwargs=dict(host="127.0.0.1", port=port, threads=8,
                                                                _quiet=True), daemon=True)
    t.start()
    if not _wait_until_up(url):
        print("Riyser Accounting failed to start.", file=sys.stderr)
        sys.exit(1)
    print(f"Riyser Accounting running at {url}  (company file: {os.environ['RIYSER_DB']})", flush=True)

    if args.no_window:
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return
    try:
        import webview
        webview.create_window("Riyser Accounting", url, width=1360, height=860, min_size=(1000, 650))
        webview.start()
    except Exception as e:  # no GUI toolkit - use the browser instead
        print(f"(No app window available: {e}; opening your browser instead. Close this window to quit.)")
        webbrowser.open(url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
