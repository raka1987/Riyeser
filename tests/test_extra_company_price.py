"""The extra-company price on screens and messages comes from the one price list (riyeser/db.py PRICE_USD, the same
as website/prices.mjs), never typed into a screen."""
import re
from pathlib import Path

from riyeser import db as D
from tests.test_pos_app import make

ROOT = Path(__file__).resolve().parent.parent


def test_no_hard_coded_extra_company_price():
    for f in list((ROOT / "riyeser").rglob("*.py")) + list((ROOT / "riyeser" / "templates").rglob("*.html")):
        s = f.read_text(encoding="utf-8")
        assert not re.search(r"(?i)extra compan[^\n]{0,40}\$\d", s), f


def test_add_company_message_uses_the_price_list(tmp_path, monkeypatch):
    app, c, _item = make(tmp_path, monkeypatch, None)
    monkeypatch.setitem(D.PRICES, "extra_company", "US$123")
    monkeypatch.setattr("riyeser.companies.can_add_another", lambda: False)
    r = c.post("/companies/add", data={"name": "Synthetic Two"}, follow_redirects=True)
    assert "Extra companies are US$123 a month each" in r.get_data(as_text=True)
    assert D.PRICE_USD["extra_company"] == 10    # unchanged (website/prices.mjs: extra_company: 10)
