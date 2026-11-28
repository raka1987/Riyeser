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


def is_internal(url, base):
    """Is this address one of this program's own pages (the private server on this PC)?"""
    from urllib.parse import urlsplit
    try:
        u, b = urlsplit(str(url)), urlsplit(base)
    except ValueError:
        return False
    return u.scheme in ("http", "https") and (u.hostname or "").lower() in ("127.0.0.1", "localhost", "::1") \
        and (u.port or 80) == (b.port or 80)


def keep_own_pages_in_app(base, show=None):
    """The app window hands any link that opens a new window to the computer's web browser (through Python's
    webbrowser module). The browser isn't signed in, so one of Riyeser's own pages opened there shows the sign-in
    page (a receipt did, in POS 2.11.0). From here on the browser is only ever given other websites: one of our own
    pages is shown in the app window instead (show(url)), whatever asked for it. Returns the browser's real opener
    (for the no-window fallback, where the browser IS the app)."""
    real = webbrowser.open

    def guarded_open(url, new=0, autoraise=True):
        if is_internal(url, base):
            if show:
                try:
                    show(str(url))
                except Exception:
                    pass
            return True
        return real(url, new, autoraise)
    webbrowser.open = guarded_open
    webbrowser.open_new = lambda url: guarded_open(url, 1)
    webbrowser.open_new_tab = lambda url: guarded_open(url, 2)
    return real


# Screens Riyeser Central can open the app on (quick access): --page=pos opens the Shop counter.
START_PAGES = {"pos": "/pos/", "invoice": "/sale/new", "estimate": "/estimate/new"}


def start_path(page):
    """The address to open for --page (anything unknown opens the usual home screen)."""
    return START_PAGES.get((page or "").strip().lower(), "")


def main(argv=None):
    from .db import EDITIONS, POS_APP, INVOICES_APP, BOOKINGS_APP, ESTIMATE_APP
    from .edition import app_edition, is_pos_app, is_invoices_app, is_bookings_app, is_estimate_app
    ed = app_edition()
    app_name = (POS_APP["app"] if is_pos_app() else INVOICES_APP["app"] if is_invoices_app()
                else BOOKINGS_APP["app"] if is_bookings_app()
                else ESTIMATE_APP["app"] if is_estimate_app()
                else EDITIONS[ed]["app"] if ed else "Riyeser Accounting")
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
    # the free trial's registry copy (HKCU\Software\Riyeser\Trial, riyeser/trial_guard.py): Windows only, the app itself
    from .trial_guard import use_windows_defaults
    use_windows_defaults()
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
    try:  # Riyeser Central finds this program's local online-connections API here (riyeser/views/online.py)
        import atexit
        from .views.online import write_local_api, remove_local_api
        write_local_api(app, port, app_name)
        atexit.register(remove_local_api, app)
    except OSError:
        pass
    if is_pos_app():  # kitchen screens on the local network, when that was turned on (POS > Kitchen)
        from .views.kds import autostart
        autostart(app)
    print(f"{app_name} running at {url}  (company file: {app.config['DATABASE']}"
          f"{', demo mode' if app.config.get('DEMO_MODE') else ''})", flush=True)

    open_browser = webbrowser.open
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
        window = webview.create_window(app_name, url + start_path(args.page), width=1360, height=860,
                                       min_size=(1000, 650))

        def show_in_app(link):
            # not on the window's own thread (it is busy handing us the link): the in-app viewer, else the page itself
            import json
            js = ("(function(u){if(window.RiyeserInApp){RiyeserInApp.view(u);}else{location.href=u;}})(%s)"
                  % json.dumps(link))
            threading.Thread(target=lambda: window.evaluate_js(js), daemon=True).start()
        open_browser = keep_own_pages_in_app(url, show_in_app)
        webview.start()
    except Exception as e:  # no GUI toolkit - use the browser instead
        print(f"(No app window available: {e}; opening your browser instead. Close this window to quit.)")
        open_browser(url + start_path(args.page))
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
