"""Open every screen (every GET route) as the admin, in every app, and collect any that break.

Used by tests/test_route_smoke.py, in this process and in a separate `python -OO` process with no internet and no
time-zone database (as the packaged Windows programs run: built at optimisation level 2, Windows has no time-zone
data of its own, and a shop PC is often offline). Run directly it prints the failures as JSON:

    python -OO tests/route_smoke.py <work folder> <edition|source> fresh-fj fresh demo [--offline] [--no-tz]
"""
import json
import os
import re
import sys
import traceback

PASSWORD = "long-enough-1"
SKIP = {"static", "auth.logout", "online_api.api_unknown", "companies.switch"}
TEXT_ARGS = {"side": ("sale", "purchase"), "kind": ("customer", "supplier", "spend", "receive"),
             "token": ("x",), "iid": ("1",), "filename": ("app.css",)}
ERROR_PAGE = "Nothing was saved from that last step"


_TARGETED = re.compile(r"<(?:a|form|area|base)\b[^>]*>", re.I)
_OURS = re.compile(r"^(?:https?:)?//(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:/|$)", re.I)


def browser_leaks(html):
    """What on this page could hand one of Riyeser's own pages to the computer's web browser (which isn't signed in:
    a receipt opened there at the sign-in page, POS 2.11.0). A link or form that opens a new window, or a script
    calling window.open, is only fine when it goes to another website, or the page loads static/inapp.js, which
    keeps our own pages inside the app window."""
    if "inapp.js" in html:
        return []
    out = []
    for m in _TARGETED.finditer(html):
        tag = m.group(0)
        t = re.search(r"\btarget\s*=\s*[\"']?([^\"'\s>]+)", tag, re.I)
        if not t or t.group(1).lower() in ("_self", "_top", "_parent"):
            continue
        h = re.search(r"\b(?:href|action)\s*=\s*[\"']([^\"']*)", tag, re.I)
        href = h.group(1) if h else ""
        outside = re.match(r"(?:https?:)?//", href, re.I) and not _OURS.match(href)
        if not (outside or href.startswith(("mailto:", "tel:"))):
            out.append(tag[:160])
    if "window.open(" in html:
        out.append("window.open(...) in a script")
    return out


def no_internet():
    """Any connection that isn't to this PC fails, as it does on a PC with no internet."""
    import socket
    real_connect, real_getaddrinfo = socket.socket.connect, socket.getaddrinfo

    def local(host):
        return str(host) in ("127.0.0.1", "::1", "localhost", "")

    def connect(self, address):
        if isinstance(address, tuple) and not local(address[0]):
            raise OSError(101, "Network is unreachable (route smoke test: offline)")
        return real_connect(self, address)

    def getaddrinfo(host, *a, **kw):
        if not local(host):
            raise socket.gaierror(-3, "Temporary failure in name resolution (route smoke test: offline)")
        return real_getaddrinfo(host, *a, **kw)
    socket.socket.connect = connect
    socket.getaddrinfo = getaddrinfo


def no_time_zone_data():
    """No IANA time-zone database at all (a Windows PC without the tzdata package): ZoneInfo('Pacific/Fiji') fails."""
    os.environ["PYTHONTZPATH"] = ""
    sys.modules["tzdata"] = None
    import zoneinfo
    zoneinfo.reset_tzpath(to=[])
    zoneinfo.ZoneInfo.clear_cache()


def fiji_setup_form(name="Test Fiji", password=PASSWORD):
    """First-run setup with Fiji chosen, every value as the review screen fills it in (Confirm pressed unchanged)."""
    from riyeser import countries as C
    r = C.review(None, "FJ")
    p = r["p"]
    form = {"country": r["cc"], "add_standard": "1", "report_layout": p["report_layout"] or "generic",
            "tax_name": "" if p["tax_name"] == "None" else (p["tax_name"] or ""),
            "standard_rate": "" if p["standard_rate"] is None else f"{p['standard_rate']:g}",
            "tax_id_label": p["tax_id_label"] or "", "report_name": p["report_name"] or "",
            "tax_office": p["tax_office"] or "", "prices_include_tax": "1" if p["prices_include_tax"] else "0",
            "currency": p["currency"] or "", "currency_symbol": (p["currency_format"] or {}).get("symbol", ""),
            "currency_position": (p["currency_format"] or {}).get("position", "before"),
            "fy_start_month": str(p["fy_start_month"] or ""), "date_format": p["date_format"] or "iso",
            "timezone": r["timezone"] or (r["timezones"][0] if p["timezones"] else ""),
            "name": name, "password": password, "start": "blank"}
    for t in r["codes"]:
        if t["status"] == "add":
            form[f"add_{t['code']}"] = "1"
    return form


def make_company(app, kind):
    """kind: fresh-fj (first-run setup with Fiji chosen), fresh (an older file: no country chosen) or demo."""
    from riyeser.db import get_db, init_db
    c = app.test_client()
    if kind == "fresh-fj":
        form = fiji_setup_form()
        resp = c.post("/setup", data=form)
        if resp.status_code != 302:
            raise RuntimeError(f"first-run setup answered {resp.status_code}")
    else:
        with app.app_context():
            init_db("Smoke Test Co", PASSWORD)
            if kind == "demo":
                from riyeser.demo import seed_demo
                seed_demo(get_db())
                get_db().commit()
    r = c.post("/login", data={"username": "admin", "password": PASSWORD})
    if r.status_code != 302 or "/login" in r.headers.get("Location", ""):
        raise RuntimeError("couldn't sign in as admin")
    return c


def urls(app):
    """Every GET address, with sample values for its parts (ids that may not exist are fine: 404 isn't a failure)."""
    from riyeser.views.reports import CATALOG
    out = []
    for rule in sorted(app.url_map.iter_rules(), key=lambda r: r.rule):
        if "GET" not in rule.methods or rule.endpoint in SKIP:
            continue
        combos = [{}]
        for arg in sorted(rule.arguments):
            conv = type(rule._converters.get(arg)).__name__
            if arg == "name" and rule.endpoint == "reports.show":
                vals = [k for _, items in CATALOG for k, _t in items]
            elif conv == "IntegerConverter":
                vals = [1]
            else:
                vals = TEXT_ARGS.get(arg, ("1",))
            combos = [dict(c, **{arg: v}) for c in combos for v in vals]
        for values in combos:
            try:
                with app.test_request_context():
                    from flask import url_for
                    out.append(url_for(rule.endpoint, **values))
            except Exception:
                pass   # a value this route's converter refuses
    return out


def run(work, edition, kinds, offline=False, no_tz=False):
    """[(company kind, url, what went wrong)] for every screen that broke, for each kind of company file."""
    os.makedirs(work, exist_ok=True)
    os.environ["APPDATA"] = os.path.join(work, "appdata")
    os.environ["RIYESER_HOME"] = os.path.join(work, "home")
    os.environ["RIYESER_DEMO_FILE"] = os.path.join(work, "no-demo.json")
    if edition and edition != "source":
        os.environ["RIYESER_APP_EDITION"] = edition
    else:
        os.environ.pop("RIYESER_APP_EDITION", None)
    if offline:
        no_internet()
    if no_tz:
        no_time_zone_data()
    from riyeser import create_app
    from riyeser import online as O
    from riyeser.views.online import token
    failures = []
    for kind in ([kinds] if isinstance(kinds, str) else kinds):
        # Riyeser Central's company profile says where the business is (Fiji): the online pages' time zone comes
        # from it when the company file has none (an older file, or one made before Country and tax).
        prof = os.path.join(work, "appdata", "Riyeser", "company.json")
        os.makedirs(os.path.dirname(prof), exist_ok=True)
        with open(prof, "w", encoding="utf-8") as f:
            json.dump({"name": "Test Fiji", "country": "Fiji"} if kind != "demo" else {}, f)
        O._TZ_CACHE.clear()
        app = create_app({"TESTING": True, "DATABASE": os.path.join(work, f"{edition}-{kind}.db")})
        client = make_company(app, kind)
        api_headers = {"X-Riyeser-Token": token(app)}   # Riyeser Central's local API, as Central calls it
        for url in urls(app):
            try:
                r = client.get(url, headers=api_headers if url.startswith("/online/api/") else None)
                if r.status_code >= 500 or (r.mimetype == "text/html" and ERROR_PAGE in r.get_data(as_text=True)):
                    failures.append((kind, url, f"HTTP {r.status_code}"))
                elif r.mimetype == "text/html":
                    leaks = browser_leaks(r.get_data(as_text=True))
                    if leaks:
                        failures.append((kind, url, "would open the web browser for one of our own pages: "
                                         + "; ".join(leaks)))
            except Exception as e:
                failures.append((kind, url, "".join(traceback.format_exception(type(e), e, e.__traceback__)[-4:])))
    return failures


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    a = [x for x in sys.argv[1:] if not x.startswith("--")]
    print(json.dumps({"optimize": sys.flags.optimize,
                      "failures": run(a[0], a[1], a[2:], "--offline" in sys.argv, "--no-tz" in sys.argv)}))
