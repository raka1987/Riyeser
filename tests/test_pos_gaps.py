"""Riyeser POS, the owner's 2.11.0 reports: nothing of ours opens in the web browser, the Hardware page is the one
place for printers and the cash drawer, a past receipt can be looked at / printed again / emailed, promotions,
switching Retail <-> Restaurant, and setting up tables. Synthetic data only; a fake printer, nothing is printed.
Every test that moves money ends with the books check."""
import json
import re
import webbrowser
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from riyeser import desktop, pos_promos as PR, pos_schema
from riyeser.db import get_db
from tests.test_pos_pins import shop, books_ok, add_user, unlock  # noqa: F401  (the fixture)
from tests import route_smoke

ROOT = Path(__file__).resolve().parent.parent
PRN = "Receipt printer (test)"
TEA = 332          # the fixture's Tea: 3.02 + 10% GST


def q(s, sql, *a):
    with s["app"].app_context():
        return get_db().execute(sql, a).fetchall()


def promo(c, **kw):
    data = {"what": "save", "name": "Promo", "kind": "percent", "value": "10", "scope": "sale"}
    data.update(kw)
    return c.post("/pos/promotions", data=data, follow_redirects=True)


def sell(c, lines, tendered=10000, **kw):
    return c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": tendered}], "till_id": 1,
                                     "lines": lines, **kw})


def second_item(s, name="Scone", price=500, category="Food"):
    with s["app"].app_context():
        db = get_db()
        tea = db.execute("SELECT * FROM items WHERE id=?", (s["tea"],)).fetchone()
        iid = db.execute("INSERT INTO items (sku, name, is_inventoried, is_sold, is_bought, income_account_id,"
                         " expense_account_id, asset_account_id, sell_price, buy_price, sale_tax_code_id, category,"
                         " active) VALUES (?,?,0,1,0,?,?,?,?,0,?,?,1)",
                         (name[:3].upper(), name, tea["income_account_id"], tea["expense_account_id"],
                          tea["asset_account_id"], price, tea["sale_tax_code_id"], category)).lastrowid
        db.commit()
    return iid


# ================================================================ 1. nothing of ours opens in the web browser
def test_the_app_window_never_hands_its_own_pages_to_the_web_browser(monkeypatch):
    base = "http://127.0.0.1:53124"
    assert desktop.is_internal(base + "/login?next=/pos/receipt/3", base)       # what the owner saw in Chrome
    assert desktop.is_internal("http://localhost:53124/pos/receipt/3", base)
    assert not desktop.is_internal("https://riyeser.com/link/", base)
    assert not desktop.is_internal("https://www.paypal.com/checkout", base)
    assert not desktop.is_internal("http://127.0.0.1:8080/other-program", base)   # another program on this PC
    assert not desktop.is_internal("mailto:someone@example.com", base)
    opened, shown = [], []
    monkeypatch.setattr(webbrowser, "open", lambda url, new=0, autoraise=True: opened.append(url) or True)
    monkeypatch.setattr(webbrowser, "open_new", webbrowser.open_new)       # put back after the test
    monkeypatch.setattr(webbrowser, "open_new_tab", webbrowser.open_new_tab)
    real = desktop.keep_own_pages_in_app(base, shown.append)
    for fn in (webbrowser.open, webbrowser.open_new, webbrowser.open_new_tab):
        assert fn(base + "/login?next=/pos/receipt/3") is True
        fn("https://riyeser.com/pricing.html")
    assert opened == ["https://riyeser.com/pricing.html"] * 3                   # other websites still open
    assert shown == [base + "/login?next=/pos/receipt/3"] * 3                   # ours: shown in the app window
    real(base + "/pos/")                      # the no-window fallback (the browser is the app) still works
    assert opened[-1] == base + "/pos/"


def test_no_template_or_script_opens_a_new_window_for_our_own_pages():
    """Every link or form with a target, in every program that shares these templates, goes to another website
    (https://...), or to an address a view hands in that is checked below; scripts never call window.open."""
    outside = re.compile(r"""^(https://|\{\{\s*(page|download|basics_url|licence\.buy_url|n\.home_url|"""
                         r"""edition_download\('[a-z]+'\))\s*\}\})""")
    bad = []
    for f in sorted((ROOT / "riyeser" / "templates").rglob("*.html")):
        text = f.read_text(encoding="utf-8")
        for m in re.finditer(r"<(a|form|area|base)\b[^>]*\btarget\s*=\s*[\"']?(_blank|_new|[a-z]\w*)[^>]*>", text, re.I):
            href = re.search(r"\b(?:href|action)\s*=\s*\"([^\"]*)\"", m.group(0))
            if not href or not outside.match(href.group(1)):
                bad.append(f"{f.relative_to(ROOT)}: {m.group(0)[:140]}")
        if "window.open(" in text or "webbrowser" in text:
            bad.append(f"{f.relative_to(ROOT)}: window.open")
    for f in sorted((ROOT / "riyeser" / "static").glob("*.js")):
        if f.name != "inapp.js" and "window.open(" in f.read_text(encoding="utf-8"):
            bad.append(f"{f.name}: window.open")
    assert bad == [], "\n".join(bad)
    guard = (ROOT / "riyeser" / "static" / "inapp.js").read_text(encoding="utf-8")
    assert "window.open = function" in guard and "addEventListener('submit'" in guard
    for shell in ("base.html", "pos/_pos.html"):    # every screen is built on one of these two
        assert "inapp.js" in (ROOT / "riyeser" / "templates" / shell).read_text(encoding="utf-8")
    # the addresses views hand to those links are other websites, never this PC
    from riyeser import edition, licence, plan
    for url in (edition.POS_PAGE, licence.BUY_URL, plan.HOME_URL, *(edition.download_url(e) for e in ("basic", "enterprise", "pos"))):
        assert url.startswith("https://") and "127.0.0.1" not in url and "localhost" not in url, url
    src = (ROOT / "riyeser" / "desktop.py").read_text(encoding="utf-8")
    assert "keep_own_pages_in_app(url, show_in_app)" in src


def test_route_smoke_spots_a_page_that_would_open_the_browser():
    ok = '<script src="/static/inapp.js"></script><a href="/pos/receipt/3" target="_blank">Receipt</a>'
    assert route_smoke.browser_leaks(ok) == []                      # inapp.js keeps it in the app
    assert route_smoke.browser_leaks('<a href="/pos/receipt/3" target="_blank">Receipt</a>')
    assert route_smoke.browser_leaks('<form action="/reports/x.pdf" target="_blank">')
    assert route_smoke.browser_leaks('<a href="http://127.0.0.1:5000/pos/" target="_blank">x</a>')
    assert route_smoke.browser_leaks("<script>window.open('/pos/receipt/3')</script>")
    assert route_smoke.browser_leaks('<a href="https://riyeser.com/link/" target="_blank" rel="noopener">x</a>') == []
    assert route_smoke.browser_leaks('<a href="/pos/" target="_top">x</a>') == []


# ================================================================ 2. Hardware: one place
def test_hardware_page_has_every_printer_option_and_the_cash_drawer(shop):
    c = shop["admin"]
    page = c.get("/pos/hardware").get_data(as_text=True)
    for bit in ('name="receipt_printer"', "Ask each time (Windows print box)", 'name="paper" value="58"',
                'name="paper" value="80"', 'name="left"', 'name="right"', 'name="top"', 'name="bottom"',
                'name="logo"', 'name="logo_mm"', "data-testprint", "Print alignment test", "<h2>Barcode scanner",
                "<h2>Cash drawer", "data-testdrawer", 'name="drawer_mode"'):
        assert bit in page, bit
    # no receipt printer yet: the page says so plainly (an A4 office printer prints a narrow strip)
    assert 'id="noPrinterNote"' in page and "office (A4) printer" in page and "narrow strip" in page
    # the cash drawer is found from Hardware: the old page goes there, and the menus have no separate entry
    r = c.get("/pos/drawer")
    assert r.status_code == 302 and r.headers["Location"].endswith("/pos/hardware#drawer")
    setup = c.get("/pos/setup").get_data(as_text=True)
    assert "/pos/hardware" in setup and "/pos/drawer" not in setup and ">Cash drawer<" not in setup
    c.post("/pos/hardware/save", data={"what": "receipt", "till_id": 1, "receipt_printer": PRN, "print_after": "ask",
                                       "copies": 1})
    assert 'id="noPrinterNote"' not in c.get("/pos/hardware").get_data(as_text=True)
    # kitchen printers are on the same page for a restaurant
    c.post("/pos/setup", data={"mode": "restaurant", "mode_changed": "1"})
    assert "<h2>Kitchen and bar printers" in c.get("/pos/hardware").get_data(as_text=True)


def test_a_receipt_on_an_a4_printer_is_still_receipt_sized(shop):
    c = shop["admin"]
    sid = sell(c, [{"item_id": shop["tea"], "qty": 1}]).get_json()["sale_id"]
    html = c.get(f"/pos/receipt/{sid}").get_data(as_text=True)
    m = re.search(r"\.r\{width:([0-9.]+)mm;max-width:100%", html)   # the receipt is its own width, whatever the paper
    assert m and 40 <= float(m.group(1)) <= 80
    assert "@media print{.r{margin:0 0 0 " in html               # printed from the left edge: a narrow strip on A4
    books_ok(shop)


# ================================================================ 3. view, reprint and email a past receipt
def test_view_a_past_receipt_print_it_again_and_email_it(shop, monkeypatch):
    c = shop["admin"]
    d = sell(c, [{"item_id": shop["tea"], "qty": 2}]).get_json()
    sid = d["sale_id"]
    assert d["view_url"] == f"/pos/receipt/{sid}/view?new=1"       # right after a sale
    for url in ("/pos/sales", "/pos/sales/all"):                     # and from the sales lists
        page = c.get(url).get_data(as_text=True)
        assert f'href="/pos/receipt/{sid}/view' in page and "View receipt" in page
    view = c.get(f"/pos/receipt/{sid}/view").get_data(as_text=True)
    assert f'src="/pos/receipt/{sid}?view=1"' in view and "Print it again" in view and "inapp.js" in view
    assert "target=" not in view                                     # nothing here leaves the app window
    # on the screen it does not print by itself; the print copy does
    assert "window.print()" not in c.get(f"/pos/receipt/{sid}?view=1").get_data(as_text=True).split("<body")[1].split(">")[0]
    assert 'onload="setTimeout(()=>window.print(),300)"' in c.get(f"/pos/receipt/{sid}").get_data(as_text=True)
    # no receipt printer: say plainly where to choose one
    assert 'id="rvHint"' in view and "choose your receipt printer in Hardware" in view and "/pos/hardware" in view
    # email isn't set up: say so (no dead button)
    assert 'id="rvNoMail"' in view and 'id="rvSend"' not in view
    r = c.post(f"/pos/receipt/{sid}/email", json={"to": "customer@example.com"})
    assert r.status_code == 400 and "Email isn't set up yet" in r.get_json()["error"]
    # with a receipt printer the reprint goes straight to it
    c.post("/pos/hardware/save", data={"what": "receipt", "till_id": 1, "receipt_printer": PRN, "print_after": "ask",
                                       "copies": 1})
    view = c.get(f"/pos/receipt/{sid}/view").get_data(as_text=True)
    assert 'id="rvHint"' not in view and f"Prints on {PRN}" in view
    before = len(shop["printer"].jobs)
    assert c.post(f"/pos/receipt/{sid}/raw", json={"till_id": 1}).get_json()["ok"]
    assert len(shop["printer"].jobs) == before + 1
    # with email set up: the receipt goes out with the tax invoice attached
    with shop["app"].app_context():
        db = get_db()
        db.execute("UPDATE company SET smtp_host='smtp.example.com', smtp_from='shop@example.com' WHERE id=1")
        db.commit()
    sent = []
    from riyeser import mailer

    def fake_send(db, limit=50, now=None):
        rows = db.execute("SELECT * FROM email_queue WHERE status='queued'").fetchall()
        sent.extend(rows)
        db.execute("UPDATE email_queue SET status='sent' WHERE status='queued'")
        db.commit()
        return len(rows), 0
    monkeypatch.setattr(mailer, "send_pending", fake_send)
    view = c.get(f"/pos/receipt/{sid}/view").get_data(as_text=True)
    assert 'id="rvSend"' in view and 'id="rvNoMail"' not in view
    assert c.post(f"/pos/receipt/{sid}/email", json={"to": "not an address"}).status_code == 400
    r = c.post(f"/pos/receipt/{sid}/email", json={"to": "customer@example.com"}).get_json()
    assert r["ok"] and "Emailed to customer@example.com" in r["message"]
    m = sent[-1]
    assert m["to_addr"] == "customer@example.com" and "Your receipt" in m["subject"]
    assert "2 x Tea" in m["body"] and "$6.64" in m["body"] and m["attachment"][:4] == b"%PDF"
    books_ok(shop)


def test_a_cashier_can_view_a_receipt_but_not_another_shops_setup(shop):
    sid = sell(shop["admin"], [{"item_id": shop["tea"], "qty": 1}]).get_json()["sale_id"]
    add_user(shop, "maria", "cashier", "1111", "Maria Synthetic")
    m = shop["app"].test_client()
    m.post("/login", data={"username": "maria", "password": "pw-synthetic1"})
    unlock(m, "1111")
    view = m.get(f"/pos/receipt/{sid}/view")
    assert view.status_code == 200
    html = view.get_data(as_text=True)
    assert "Print it again" in html and "Ask an owner or manager to choose the receipt printer" in html
    assert m.get("/pos/promotions").status_code == 302 and m.get("/pos/tables").status_code == 302   # setup pages


# ================================================================ 4. promotions
def test_engine_days_times_dates_and_codes():
    base = dict(id=1, name="P", kind="percent", value=10, scope="sale", category=None, item_id=None, start=None,
                end=None, days=[], time_from=None, time_to=None, code=None)
    fri3pm = datetime(2026, 11, 27, 15, 30)       # a Friday
    assert PR.is_on(base, fri3pm)
    assert PR.is_on(dict(base, days=[4]), fri3pm) and not PR.is_on(dict(base, days=[5, 6]), fri3pm)
    hh = dict(base, time_from="15:00", time_to="17:00")
    assert PR.is_on(hh, fri3pm) and not PR.is_on(hh, fri3pm.replace(hour=17, minute=0)) \
        and not PR.is_on(hh, fri3pm.replace(hour=14, minute=59))
    late = dict(base, time_from="22:00", time_to="02:00")           # over midnight
    assert PR.is_on(late, fri3pm.replace(hour=23)) and PR.is_on(late, fri3pm.replace(hour=1)) \
        and not PR.is_on(late, fri3pm)
    assert not PR.is_on(dict(base, start="2026-11-28"), fri3pm) and PR.is_on(dict(base, start="2026-11-27"), fri3pm)
    assert not PR.is_on(dict(base, end="2026-11-26"), fri3pm) and PR.is_on(dict(base, end="2026-11-27"), fri3pm)
    coded = dict(base, code="WELCOME")
    assert not PR.is_on(coded, fri3pm) and PR.is_on(coded, fri3pm, ["welcome "]) and not PR.is_on(coded, fri3pm, ["X"])
    assert PR.when_text(dict(base, days=[0, 1, 2, 3, 4], time_from="15:00", time_to="17:00")) == "Mon to Fri, 3 pm to 5 pm"
    assert PR.when_text(base) == "Always"


def test_engine_best_promotion_per_item_and_amount_off_the_sale_adds_up():
    P = lambda **kw: dict(dict(id=kw.pop("id", 1), name="P", kind="percent", value=10, scope="sale", category=None,
                               item_id=None, start=None, end=None, days=[], time_from=None, time_to=None, code=None), **kw)
    lines = [dict(item_id=1, parent_id=None, category="Coffee", qty=3, price=455, manual_pct=0),
             dict(item_id=2, parent_id=9, category="Food", qty=1, price=1000, manual_pct=20),
             dict(item_id=3, parent_id=None, category=None, qty=2, price=333, manual_pct=0)]
    promos = [P(id=1, name="Ten", value=10), P(id=2, name="Coffee dollar", kind="amount", value=100, scope="category",
                                               category="Coffee"),
              P(id=3, name="Product 9", value=15, scope="item", item_id=9), P(id=4, name="Five off", kind="amount", value=500),
              P(id=5, name="Three off", kind="amount", value=300)]
    out, whole = PR.price(promos, lines)
    # coffee: 1.00 off each (3.00) beats 10% (1.37); the variant of product 9: the cashier's 20% beats 15%;
    # the third: 10% of 6.66 -> 5.99
    assert [(x["promo"] or {}).get("name") for x in out] == ["Coffee dollar", None, "Ten"]
    before = [3 * 355, 800, 599]
    assert whole == dict(id=4, name="Five off", saved=500)                 # the bigger "amount off the sale", once
    assert sum(x["sale_share"] for x in out) == 500 and all(x["sale_share"] > 0 for x in out)
    assert [x["total"] + x["sale_share"] for x in out] == before
    assert sum(x["total"] for x in out) == sum(before) - 500
    # an amount off never takes a sale below zero
    out, whole = PR.price([P(id=1, kind="amount", value=99999)], lines[:1])
    assert out[0]["total"] == 0 and whole["saved"] == 3 * 455
    # the discount that makes an invoice line come to exactly that many cents
    from riyeser.ledger import calc_line
    for qty, each, total in ((3, 455, 1065), (1, 1000, 667), (2, 333, 1), (7, 999, 6990), (1.5, 455, 600)):
        net, tax = calc_line(qty, each, PR.discount_pct(qty, each, total), 10, True)
        assert net + tax == total


def test_promotions_screen_make_change_turn_off_remove(shop):
    c = shop["admin"]
    page = c.get("/pos/promotions").get_data(as_text=True)
    assert "No promotions yet" in page and "New promotion" in page       # the first one: the form is ready
    for bad, why in ((dict(name=""), "Give the promotion a name"), (dict(value="150"), "between 1 and 100"),
                     (dict(value="abc"), "as a number"), (dict(scope="category"), "Choose the category"),
                     (dict(scope="item"), "Choose the product"), (dict(kind="amount", value="0"), "Type the amount"),
                     (dict(start_date="2026-12-10", end_date="2026-12-01"), "end date is before"),
                     (dict(time_from="25:00"), "Times look like")):
        assert why in promo(c, **bad).get_data(as_text=True), why
    assert q(shop, "SELECT COUNT(*) FROM pos_promotions")[0][0] == 0
    r = promo(c, name="Happy hour", kind="amount", value="1.00", scope="category", category="Drinks",
              days=["0", "1", "2", "3", "4"], time_from="15:00", time_to="17:00").get_data(as_text=True)
    assert "Happy hour saved. The till applies it by itself." in r
    assert "$1.00 off" in r and "Drinks" in r and "Mon to Fri, 3 pm to 5 pm" in r
    r = promo(c, name="Welcome", value="10", code=" welcome 10 ").get_data(as_text=True)
    assert "types the code WELCOME10 at the till" in r and "10% off" in r and "Running with its code" in r
    assert "already uses the code WELCOME10" in promo(c, name="Again", code="welcome10").get_data(as_text=True)
    hh, wel = q(shop, "SELECT * FROM pos_promotions ORDER BY id")
    assert (hh["kind"], hh["value"], hh["scope"], hh["category"], json.loads(hh["days"])) == \
        ("amount", 100, "category", "Drinks", [0, 1, 2, 3, 4])
    # change it, turn it off, remove it
    edit = c.get(f"/pos/promotions?edit={hh['id']}").get_data(as_text=True)
    assert "Change Happy hour" in edit and 'value="1.00"' in edit
    promo(c, id=hh["id"], name="Happier hour", kind="amount", value="1.50", scope="category", category="Drinks")
    assert q(shop, "SELECT name, value, days FROM pos_promotions WHERE id=?", hh["id"])[0][:] == ("Happier hour", 150, None)
    r = c.post("/pos/promotions", data={"what": "off", "id": wel["id"]}, follow_redirects=True).get_data(as_text=True)
    assert "Welcome is off." in r and q(shop, "SELECT active FROM pos_promotions WHERE id=?", wel["id"])[0][0] == 0
    c.post("/pos/promotions", data={"what": "delete", "id": wel["id"]})
    assert q(shop, "SELECT COUNT(*) FROM pos_promotions")[0][0] == 1
    # it is in the menus: Setup (back office), POS setup and the till's own menu
    assert "/pos/promotions" in c.get("/pos/setup").get_data(as_text=True)
    assert ">Promotions</a>" in c.get("/inventory/").get_data(as_text=True)
    assert 'href="/pos/promotions"' in c.get("/pos/").get_data(as_text=True)


def test_a_promotion_applies_by_itself_and_shows_on_the_receipt(shop):
    c = shop["admin"]
    promo(c, name="Winter sale", value="10")
    d = sell(c, [{"item_id": shop["tea"], "qty": 3}], expect_total=896).get_json()     # 9.96 less 10% = 8.96
    assert d["ok"] and d["total"] == 896 and d["change"] == 10000 - 896
    sid = d["sale_id"]
    html = c.get(f"/pos/receipt/{sid}").get_data(as_text=True)
    assert "Winter sale" in html and "-$1.00" in html and "You saved" in html and "$8.96" in html
    assert "-10%" not in html                               # the promotion's name, not a bare percentage
    saved = q(shop, "SELECT name, amount, line_id, whole FROM pos_sale_promos")
    assert [(r["name"], r["amount"], r["whole"]) for r in saved] == [("Winter sale", 100, 0)] and saved[0]["line_id"]
    # the item at its full price, then the promotion, then the total: it adds up
    assert re.search(r"3 x \$3\.32</td><td class=\"n\">\$9\.96</td>", html)
    # the receipt printer's copy too
    c.post("/pos/hardware/save", data={"what": "receipt", "till_id": 1, "receipt_printer": PRN, "print_after": "ask",
                                       "copies": 1})
    c.post(f"/pos/receipt/{sid}/raw", json={"till_id": 1})
    job = shop["printer"].jobs[-1][1]
    assert b"Winter sale" in job and b"You saved" in job and b"-$1.00" in job and b"$9.96" in job and b"$8.96" in job
    # the till is told about it, and the invoice carries it as the line's discount (stock, tax and reports follow)
    assert '"name": "Winter sale"' in c.get("/pos/").get_data(as_text=True)
    line = q(shop, "SELECT l.* FROM document_lines l JOIN pos_sales p ON p.document_id=l.document_id WHERE p.id=?", sid)[0]
    assert line["net_amount"] + line["tax_amount"] == 896 and line["discount_pct"] == 10
    books_ok(shop)


def test_amount_off_a_product_a_category_and_the_whole_sale(shop):
    c = shop["admin"]
    scone = second_item(shop)                                      # 5.50 with GST, category Food
    promo(c, name="Tea dollar", kind="amount", value="1.00", scope="item", item_id=shop["tea"])
    promo(c, name="Food 20", value="20", scope="category", category="Food")
    promo(c, name="Five off", kind="amount", value="5.00", scope="sale")
    d = sell(c, [{"item_id": shop["tea"], "qty": 2}, {"item_id": scone, "qty": 1}]).get_json()
    # tea 2 x (3.32 - 1.00) = 4.64; scone 5.50 less 20% = 4.40; then 5.00 off the sale
    assert d["ok"] and d["total"] == 464 + 440 - 500
    rows = q(shop, "SELECT * FROM pos_sale_promos")
    assert {(r["name"], r["amount"]) for r in rows if not r["whole"]} == {("Tea dollar", 200), ("Food 20", 110)}
    shares = [r["amount"] for r in rows if r["whole"]]              # 5.00 shared across the two items, to the cent
    assert len(shares) == 2 and sum(shares) == 500 and {r["name"] for r in rows if r["whole"]} == {"Five off"}
    html = c.get(f"/pos/receipt/{d['sale_id']}").get_data(as_text=True)
    # each item at its full price (6.64, 5.50), less each promotion, comes to the total
    for bit in ("$6.64", "$5.50", "Tea dollar", "-$2.00", "Food 20", "-$1.10", "Five off", "-$5.00", "You saved",
                "$8.10", "$4.04"):
        assert bit in html, bit
    assert not re.search(r"-\d+\.\d{3,}%", html)                   # no odd percentages on the receipt
    books_ok(shop)


def test_happy_hour_only_counts_during_its_hours_and_a_code_only_when_typed(shop):
    c = shop["admin"]
    now = datetime.now()
    later = (now + timedelta(hours=2)).strftime("%H:%M")
    much_later = (now + timedelta(hours=3)).strftime("%H:%M")
    if later < much_later:                                         # (not across midnight) a window that isn't now
        promo(c, name="Later", value="50", time_from=later, time_to=much_later)
    promo(c, name="Other day", value="50", days=[str((now.weekday() + 3) % 7)])
    promo(c, name="Ended", value="50", end_date=(now - timedelta(days=2)).strftime("%Y-%m-%d"))
    promo(c, name="Members", value="25", code="MEMBER")
    assert sell(c, [{"item_id": shop["tea"], "qty": 1}]).get_json()["total"] == TEA          # none of them
    assert sell(c, [{"item_id": shop["tea"], "qty": 1}], promo_codes=["NOPE"]).get_json()["total"] == TEA
    d = sell(c, [{"item_id": shop["tea"], "qty": 1}], promo_codes=["member"]).get_json()
    assert d["total"] == 249                                       # 3.32 less 25%
    # the happy hour was on when payment started (the till sends that minute): it still counts
    promo(c, name="Now", value="50", time_from=(now - timedelta(minutes=30)).strftime("%H:%M"),
          time_to=(now + timedelta(minutes=30)).strftime("%H:%M"))
    if now.hour not in (0, 23):
        assert sell(c, [{"item_id": shop["tea"], "qty": 1}]).get_json()["total"] == 166
    books_ok(shop)


def test_the_till_and_the_server_must_agree_on_the_total(shop):
    c = shop["admin"]
    promo(c, name="Winter sale", value="10")
    r = sell(c, [{"item_id": shop["tea"], "qty": 1}], expect_total=TEA)       # the till hadn't heard of the promotion
    d = r.get_json()
    assert r.status_code == 409 and d["reprice"] and d["total"] == 299 and "the total is now $2.99" in d["error"]
    assert q(shop, "SELECT COUNT(*) FROM pos_sales")[0][0] == 0 and q(shop, "SELECT COUNT(*) FROM pos_sale_promos")[0][0] == 0
    assert sell(c, [{"item_id": shop["tea"], "qty": 1}], expect_total=299).get_json()["ok"]
    books_ok(shop)


def test_a_promotion_never_needs_a_manager_but_a_cashiers_own_big_discount_still_does(shop):
    add_user(shop, "maria", "cashier", "1111", "Maria Synthetic")
    promo(shop["admin"], name="Half price", value="50")
    m = shop["app"].test_client()
    m.post("/login", data={"username": "maria", "password": "pw-synthetic1"})
    unlock(m, "1111")
    d = sell(m, [{"item_id": shop["tea"], "qty": 1}]).get_json()
    assert d["ok"] and d["total"] == 166                           # 50% by promotion: no approval asked
    r = sell(m, [{"item_id": shop["tea"], "qty": 1, "discount_pct": 60}])
    assert r.status_code == 400 and "manager" in r.get_json()["error"]
    # the cashier's 5% is smaller than the promotion: the promotion is used, not both
    assert sell(m, [{"item_id": shop["tea"], "qty": 1, "discount_pct": 5}]).get_json()["total"] == 166
    books_ok(shop)


def test_table_totals_and_split_bills_use_promotions(shop):
    c = shop["admin"]
    c.post("/pos/setup", data={"mode": "restaurant", "mode_changed": "1"})
    c.post("/pos/tables", data={"new_area": "Inside", "new_area_tables": "1-4"})
    promo(c, name="Winter sale", value="10")
    o = c.post("/pos/order", json={"order_type": "dine_in", "table_no": "2",
                                   "lines": [{"item_id": shop["tea"], "qty": 4}]}).get_json()
    assert o["order"]["total"] == 1195                             # 13.28 less 10%
    d = c.post(f"/pos/order/{o['id']}/split", json={"mode": "even", "guests": 2, "till_id": 1}).get_json()
    assert d["ok"] and d["order"]["bill"]["total"] == 1195
    assert [p["amount"] for p in d["order"]["bill"]["parts"]] == [598, 597]
    assert q(shop, "SELECT name, amount FROM pos_sale_promos")[0][:] == ("Winter sale", 133)


# ================================================================ 5. switching Retail <-> Restaurant
def test_switching_business_type_keeps_the_feature_switches_usable(shop):
    c = shop["admin"]
    page = c.get("/pos/setup").get_data(as_text=True)
    # both types' switches are on the page (the other type's hidden until chosen); nothing is greyed out any more
    assert 'data-feats="retail"' in page and 'data-feats="restaurant" hidden' in page
    assert "opacity" not in page.split("<script>")[-1] and 'name="feature_restaurant" value="tables"' in page
    from riyeser.views.pos import pos_config
    # retail -> restaurant, with the switches chosen on the way (no tables, no kitchen)
    r = c.post("/pos/setup", data={"mode": "restaurant", "mode_changed": "1", "features_for": "restaurant",
                                   "feature_restaurant": ["takeaway", "notes"], "feature_retail": ["scan"]})
    assert r.status_code == 302 and r.headers["Location"].endswith("/pos/setup")
    with shop["app"].app_context():
        assert pos_config(get_db()) == ("restaurant", {"takeaway", "notes"})
    till = c.get("/pos/").get_data(as_text=True)
    assert 'id="otype"' in till and 'id="tableBtn"' not in till and 'id="kitchen"' not in till
    # and back: retail's switches, as chosen
    c.post("/pos/setup", data={"mode": "retail", "mode_changed": "1", "features_for": "retail",
                               "feature_retail": ["scan", "hold"], "feature_restaurant": ["tables"]})
    with shop["app"].app_context():
        assert pos_config(get_db()) == ("retail", {"scan", "hold"})
    # restaurant again without touching its switches (no JavaScript): what it had last time
    c.post("/pos/setup", data={"mode": "restaurant", "mode_changed": "1", "features_for": "retail",
                               "feature_retail": ["scan", "hold"]})
    with shop["app"].app_context():
        assert pos_config(get_db()) == ("restaurant", {"takeaway", "notes"})
    # every menu page opens in both types
    for mode in ("retail", "restaurant"):
        c.post("/pos/setup", data={"mode": mode, "mode_changed": "1"})
        for url in ("/pos/", "/pos/sales", "/pos/sales/all", "/pos/close", "/pos/setup", "/pos/hardware",
                    "/pos/promotions", "/pos/tables", "/pos/kitchen", "/pos/approvals", "/inventory/", "/help/"):
            assert c.get(url, follow_redirects=True).status_code == 200, (mode, url)


def test_switching_to_restaurant_goes_on_to_add_tables(shop):
    c = shop["admin"]
    r = c.post("/pos/setup", data={"mode": "restaurant", "mode_changed": "1", "features_for": "restaurant",
                                   "feature_restaurant": ["tables", "kitchen"]})
    assert r.headers["Location"].endswith("/pos/tables")
    page = c.get("/pos/tables").get_data(as_text=True)
    assert "Next: add your tables and areas." in page and "No tables yet" in page
    c.post("/pos/tables", data={"new_area": "Inside", "new_area_tables": "1-3"})
    r = c.post("/pos/setup", data={"mode": "restaurant", "features_for": "restaurant",
                                   "feature_restaurant": ["tables", "kitchen"]})
    assert r.headers["Location"].endswith("/pos/setup")            # tables exist: straight back


# ================================================================ 6. tables and areas
def test_add_rename_and_remove_tables_and_areas(shop):
    c = shop["admin"]
    c.post("/pos/setup", data={"mode": "restaurant", "mode_changed": "1"})
    till = c.get("/pos/").get_data(as_text=True)
    assert "FLOOR=[]" in till and "No tables yet" in till and "Add tables" in till and "/pos/tables" in till
    assert ">Tables</a>" in c.get("/pos/setup").get_data(as_text=True)
    r = c.post("/pos/tables", data={"new_area": "Inside", "new_area_tables": "1-6", "new_area_seats": "4"},
               follow_redirects=True).get_data(as_text=True)
    assert "Inside added with 6 tables" in r
    inside = q(shop, "SELECT id FROM pos_areas")[0][0]
    r = c.post("/pos/tables", data={"new_area": "Outside", "new_area_tables": "P1, P2, Deck 1", "new_area_seats": "2",
                                    f"new_tables_{inside}": "7", f"new_seats_{inside}": "8"},
               follow_redirects=True).get_data(as_text=True)
    assert "1 table added to Inside" in r and "Outside added with 3 tables" in r
    with shop["app"].app_context():
        from riyeser.views.pos_floor import floor
        fl = floor(get_db())
    assert [a["area"] for a in fl] == ["Inside", "Outside"]
    assert [t["name"] for t in fl[0]["tables"]] == ["1", "2", "3", "4", "5", "6", "7"] and fl[0]["tables"][-1]["seats"] == 8
    assert fl[1]["tables"] == [dict(name="P1", seats=2), dict(name="P2", seats=2), dict(name="Deck 1", seats=2)]
    till = c.get("/pos/").get_data(as_text=True)
    assert '"area": "Outside"' in till and '"name": "Deck 1"' in till
    # an order at a table; rename the table and the order follows; a table with an open order can't be removed
    o = c.post("/pos/order", json={"order_type": "dine_in", "table_no": "P1",
                                   "lines": [{"item_id": shop["tea"], "qty": 1}]}).get_json()
    ids = {t["name"]: t["id"] for t in q(shop, "SELECT * FROM pos_tables")}
    form = lambda **kw: {**{f"table_name_{i}": n for n, i in ids.items()}, **kw}
    r = c.post("/pos/tables", data=form(**{f"table_remove_{ids['P1']}": "1"}), follow_redirects=True).get_data(as_text=True)
    assert "Table P1 has an open order" in r and len(q(shop, "SELECT 1 FROM pos_tables")) == 10
    r = c.post("/pos/tables", data=form(**{f"table_name_{ids['P1']}": "Patio 1", f"table_seats_{ids['P1']}": "6",
                                           f"table_area_{ids['2']}": str(q(shop, "SELECT id FROM pos_areas")[1][0]),
                                           f"table_remove_{ids['6']}": "1"}), follow_redirects=True).get_data(as_text=True)
    assert "1 table removed" in r and "1 renamed" in r
    assert q(shop, "SELECT table_no FROM pos_orders WHERE id=?", o["id"])[0][0] == "Patio 1"
    assert q(shop, "SELECT seats FROM pos_tables WHERE name='Patio 1'")[0][0] == 6
    assert q(shop, "SELECT a.name FROM pos_tables t JOIN pos_areas a ON a.id=t.area_id WHERE t.name='2'")[0][0] == "Outside"
    # names must be different, and short enough for the till
    for bad, why in (({f"new_tables_{inside}": "3"}, "already a table called 3"),
                     ({f"new_tables_{inside}": "The long table by the window"}, "too long for a table name"),
                     ({"new_area": "inside"}, "already an area called inside")):
        assert why in c.post("/pos/tables", data=bad, follow_redirects=True).get_data(as_text=True), why
    ids = {t["name"]: t["id"] for t in q(shop, "SELECT * FROM pos_tables")}
    r = c.post("/pos/tables", data={f"table_name_{ids['1']}": "3", f"table_name_{ids['3']}": "3"}, follow_redirects=True)
    assert "Two tables are called 3" in r.get_data(as_text=True)
    assert len(q(shop, "SELECT 1 FROM pos_tables WHERE name='3'")) == 1          # nothing half-saved
    # remove an area with its tables (not while one has an order)
    outside = q(shop, "SELECT id FROM pos_areas WHERE name='Outside'")[0][0]
    r = c.post("/pos/tables", data={f"area_remove_{outside}": "1"}, follow_redirects=True).get_data(as_text=True)
    assert "Outside has an open order on table Patio 1" in r
    c.post(f"/pos/order/{o['id']}/move", json={"table_no": "1"})
    r = c.post("/pos/tables", data={f"area_remove_{outside}": "1"}, follow_redirects=True).get_data(as_text=True)
    assert "Outside removed" in r and [a["name"] for a in q(shop, "SELECT name FROM pos_areas")] == ["Inside"]
    # then: open the table, add items, move it and split it (the till's own calls)
    o2 = c.post("/pos/order", json={"id": o["id"], "order_type": "dine_in", "table_no": "1", "lines": [
        {"item_id": shop["tea"], "qty": 1, "uid": o["order"]["lines"][0]["uid"]}, {"item_id": shop["tea"], "qty": 3}]}).get_json()
    assert o2["ok"] and c.post(f"/pos/order/{o['id']}/move", json={"table_no": "4"}).get_json()["order"]["table_no"] == "4"
    sp = c.post(f"/pos/order/{o['id']}/split", json={"mode": "even", "guests": 2, "till_id": 1}).get_json()
    assert sp["ok"] and len(sp["order"]["bill"]["parts"]) == 2


def test_only_an_owner_changes_tables_and_promotions(shop):
    add_user(shop, "sam", "supervisor", "9999", "Sam Supervisor")
    s = shop["app"].test_client()
    s.post("/login", data={"username": "sam", "password": "pw-synthetic1"})
    s.post("/pos/tables", data={"new_area": "Inside", "new_area_tables": "1-4"})
    s.post("/pos/promotions", data={"what": "save", "name": "Sneaky", "kind": "percent", "value": "90", "scope": "sale"})
    assert q(shop, "SELECT COUNT(*) FROM pos_tables")[0][0] == 0 and q(shop, "SELECT COUNT(*) FROM pos_promotions")[0][0] == 0


def test_a_restaurant_already_using_tables_keeps_tables_1_to_20(shop):
    """A 2.11.0 / 2.11.1 file (the till always showed tables 1 to 20) that is a restaurant: the same tables, now its
    own to rename or remove. A shop gets none."""
    with shop["app"].app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM pos_tables").fetchone()[0] == 0     # the fixture: a retail shop
        for t in ("pos_tables", "pos_areas"):
            db.execute(f"DROP TABLE {t}")
        db.execute("UPDATE company SET pos_mode='restaurant' WHERE id=1")
        pos_schema.ensure_schema(db)
        assert [r[0] for r in db.execute("SELECT name FROM pos_tables ORDER BY sort")] == [str(n) for n in range(1, 21)]
        assert db.execute("SELECT name FROM pos_areas").fetchone()[0] == "Inside"
        db.execute("DELETE FROM pos_tables")
        pos_schema.ensure_schema(db)                                                  # only the first time
        assert db.execute("SELECT COUNT(*) FROM pos_tables").fetchone()[0] == 0


def test_table_names():
    from riyeser.views.pos_floor import parse_names
    from riyeser.ledger import PostingError
    assert parse_names("1-4") == ["1", "2", "3", "4"] and parse_names("8 to 10") == ["8", "9", "10"]
    assert parse_names(" A1, A2 ;Bar  1\n12") == ["A1", "A2", "Bar 1", "12"]
    assert parse_names("") == [] and parse_names("T-1") == ["T-1"]
    with pytest.raises(PostingError):
        parse_names("1-5000")
