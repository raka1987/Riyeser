"""Smoke test a built program: start it, set up a company in Fiji the way a new owner does, sign in as the admin and
open every screen (every GET address, the same list tests/route_smoke.py uses). Fails if any screen shows
"Sorry, something went wrong" (HTTP 500), if Setup → Online orders & bookings doesn't open, if the build has no
time-zone data (Windows has none of its own: tzdata must be bundled), or if it isn't the optimised (-OO) build.

    pip install .            # the route list comes from the source (the same code that was built)
    python packaging/smoke_packaged.py --exe "dist/Riyeser POS.exe" --edition pos

The program runs with its own empty data folders (nothing on this PC is touched) and Riyeser Central's company
profile saying the business is in Fiji, as on the owner's PC.
"""
import argparse
import http.cookiejar
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, base):
        self.base = base
        self.op = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                              urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def req(self, path, data=None, headers=None, timeout=90):
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        r = urllib.request.Request(self.base + path, data=body, headers=headers or {})
        try:
            with self.op.open(r, timeout=timeout) as resp:
                return resp.status, resp.geturl(), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.geturl(), e.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--edition", required=True)
    ap.add_argument("--allow-optimize", type=int, default=2, help="the optimisation level the build must have")
    a = ap.parse_args()

    work = Path(tempfile.mkdtemp(prefix="riyeser-smoke-"))
    home, appdata = work / "home", work / "appdata"
    (appdata / "Riyeser").mkdir(parents=True)
    (appdata / "Riyeser" / "company.json").write_text(json.dumps({"name": "Test Fiji", "country": "Fiji"}), "utf-8")
    env = {k: v for k, v in os.environ.items() if not k.startswith("RIYESER_")}
    env.update(RIYESER_HOME=str(home), APPDATA=str(appdata), RIYESER_DEMO_FILE=str(work / "no-demo.json"),
               HOME=str(work), USERPROFILE=str(work), PYTHONTZPATH="")   # PYTHONTZPATH: no system time zones
    port = free_port()
    proc = subprocess.Popen([str(Path(a.exe).resolve()), "--no-window", "--port", str(port)], env=env, cwd=str(work),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    failures = []
    try:
        c = Client(f"http://127.0.0.1:{port}")
        for _ in range(180):
            try:
                if c.req("/setup", timeout=2)[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(1)
        else:
            sys.exit("The program didn't start (no answer on /setup in 3 minutes).")

        # the route list and the set-up form, from the same source
        os.environ.update(APPDATA=str(work / "src-appdata"), RIYESER_HOME=str(work / "src-home"),
                          RIYESER_DEMO_FILE=str(work / "no-demo.json"), RIYESER_APP_EDITION=a.edition)
        from tests import route_smoke as R
        from riyeser import create_app
        urls = R.urls(create_app({"TESTING": True, "DATABASE": str(work / "routes.db")}))

        st, _, page = c.req("/setup?country=FJ")
        if st != 200:
            sys.exit(f"The set-up screen didn't open (HTTP {st}).")
        if b"Confirm these settings" not in page:
            print("(This build's set-up has no country step: setting up with the company name and password only.)")
        st, where, _ = c.req("/setup", R.fiji_setup_form())
        st, where, _ = c.req("/login", {"username": "admin", "password": R.PASSWORD})
        if "/login" in where:
            sys.exit("Couldn't sign in as admin after setting up the company.")
        api = json.loads((home / "local-api.json").read_text("utf-8"))   # Riyeser Central's local API key
        token = api.get("token")

        for url in urls:
            hdr = {"X-Riyeser-Token": token} if url.startswith("/online/api/") and token else {}
            try:
                st, where, body = c.req(url, headers=hdr)
            except Exception as e:   # a dropped connection is a failure too
                failures.append((url, f"{type(e).__name__}: {e}"))
                continue
            if st >= 500 or b"Nothing was saved from that last step" in body:
                ref = re.search(rb"Reference (ER-[0-9A-F]{6})", body)
                failures.append((url, f"HTTP {st}" + (f" {ref.group(1).decode()}" if ref else "")))
            elif "/login" in where and not url.startswith(("/login", "/forgot", "/setup")):
                sys.exit(f"{url} signed the admin out: the screens after it weren't checked.")
        print(f"Opened {len(urls)} addresses.")

        st, _, page = c.req("/online/")
        if st != 200 or b"Online orders &amp; bookings" not in page:
            failures.append(("/online/", f"Setup -> Online orders & bookings didn't open (HTTP {st})"))
        st, _, body = c.req("/help/diagnostics?download=1")
        d = json.loads(body)
        print("Diagnostics:", json.dumps({k: d.get(k) for k in ("version", "frozen_desktop_build", "python",
                                                                "python_optimize", "os", "online")}))
        if not d.get("frozen_desktop_build"):
            failures.append(("diagnostics", "this isn't the packaged program"))
        if d.get("python_optimize") != a.allow_optimize:
            failures.append(("diagnostics", f"built at optimisation level {d.get('python_optimize')}, "
                                            f"expected {a.allow_optimize}"))
        if (d.get("online") or {}).get("timezone") != "Pacific/Fiji":
            failures.append(("diagnostics", f"online time zone is {(d.get('online') or {}).get('timezone')}"))
        if not (d.get("online") or {}).get("timezone_data_on_pc"):
            failures.append(("diagnostics", "no time-zone data in the build (tzdata isn't bundled)"))
        log = home / "riyeser-errors.log"
        if log.exists():
            print("riyeser-errors.log:\n" + log.read_text("utf-8", errors="replace")[-6000:])
    finally:
        if os.name == "nt":   # a one-file build starts a second copy of itself: stop both
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        else:
            proc.terminate()
        try:
            proc.wait(20)
        except subprocess.TimeoutExpired:
            proc.kill()
    if failures:
        print("FAILED:")
        for u, e in failures:
            print(" ", u, "-", e)
        sys.exit(1)
    print("OK: every screen opened, including Setup -> Online orders & bookings")


if __name__ == "__main__":
    main()
