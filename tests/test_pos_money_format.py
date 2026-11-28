"""POS screens show money in the company's own currency format (no hard-coded "$"): the till, closing the till, the
day's sales and refunds, manager approvals, card set-up, the practice terminal, the messages the till shows and the
printed receipt. Synthetic data."""
import json
import re
import shutil
import subprocess

import pytest

from riyeser import countries as C
from riyeser import drawer as D
from riyeser.db import get_db
from tests.test_pos_app import make, sell

EURO = {"symbol": "€", "position": "after", "space": True, "decimals": 2, "decimal": ",", "group": "."}


@pytest.fixture
def euro_shop(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "pos")
    with app.app_context():
        db = get_db()
        db.execute("UPDATE company SET currency='EUR', currency_format=? WHERE id=1", (json.dumps(EURO),))
        db.commit()
    return app, c, item


def test_pos_screens_use_the_company_money_format(euro_shop):
    app, c, item = euro_shop
    assert c.post("/pos/shift/open", json={"till_id": 1, "float": "0"}).get_json()["ok"]
    pages = {u: c.get(u).get_data(as_text=True) for u in ("/pos/", "/pos/close", "/pos/sales", "/pos/approvals",
                                                         "/pos/card-payments", "/pos/terminal/practice")}
    for url, html in pages.items():
        assert not re.search(r"(?<![\w$])\$[0-9]", html), (url, re.findall(r".{40}(?<![\w$])\$[0-9].{20}", html)[:3])
        assert "'-$':'$'" not in html, url
    assert "0,00 €" in pages["/pos/"] and "100 €" in pages["/pos/"] and '"symbol": "\\u20ac"' in pages["/pos/"]
    assert "0,00 €" in pages["/pos/close"] and "0,00 €" in pages["/pos/sales"]


def test_till_messages_use_the_company_money_format(euro_shop):
    app, c, item = euro_shop
    r = c.post("/pos/sale", json={"method": "cash", "tendered": "5000", "lines": [{"item_id": item, "qty": 1}]}).get_json()
    assert not r["ok"] and "4.995,60 €" in r["error"] and "$" not in r["error"], r


def test_printed_receipt_uses_the_company_money_format():
    data = dict(company="Synthetic Café", header=[], number="S-1", date="2026-11-28", lines=[(1, "Coffee", 123456)],
                total=123456, tax=0, tenders=[("Cash", 123456)], change=0, footer=["Danke"], money_fmt=EURO)
    text = D.receipt_bytes(data).decode("cp437")
    assert "1.234,56 EUR" in text and "$" not in text


@pytest.mark.skipif(not shutil.which("node"), reason="needs node")
@pytest.mark.parametrize("fmt", [C.LEGACY_FORMAT, EURO, dict(C.LEGACY_FORMAT, symbol="¥", decimals=0),
                                 dict(C.LEGACY_FORMAT, symbol="CHF", space=True, group="’")])
def test_the_screens_script_formats_like_the_money_filter(fmt):
    js = C.MONEY_JS + "(" + json.dumps(fmt) + ")"
    vals = [0, 5, 99, 100, 123456, -123456, 100000050, 1999.6]
    out = subprocess.run(["node", "-e", f"const f={js};console.log(JSON.stringify({json.dumps(vals)}.map(f)))"],
                         capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == [C.format_money(v, fmt) for v in vals]
