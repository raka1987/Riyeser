"""Riyeser POS as its own app: the till on its own, Accounting without the till, and the 90-day free trial."""
import json
from datetime import datetime, timezone

import pytest

from riyeser import create_app
from riyeser.db import get_db, init_db
from riyeser import plan


def make(tmp_path, monkeypatch, edition):
    if edition:
        monkeypatch.setenv("RIYESER_APP_EDITION", edition)
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))  # no licence file unless a test writes one
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "t.db")})
    with app.app_context():
        init_db("Corner Shop")
        db = get_db()
        tc = db.execute("SELECT id FROM tax_codes WHERE code='GST'").fetchone()[0]
        acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
        db.execute("INSERT INTO items (sku, name, is_sold, sell_price, income_account_id, sale_tax_code_id)"
                   " VALUES ('C1','Coffee',1,400,?,?)", (acc["4-1000"], tc))
        db.commit()
        item = db.execute("SELECT id FROM items").fetchone()[0]
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return app, c, item


def sell(c, item):
    return c.post("/pos/sale", json={"method": "card", "lines": [{"item_id": item, "qty": 1}]})


def test_pos_app_shows_only_the_till(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "pos")
    r = c.get("/")
    assert r.status_code == 302 and r.headers["Location"].endswith("/pos/")
    page = c.get("/pos/setup").get_data(as_text=True)
    assert "Riyeser POS" in page and "ed-pos" in page
    assert "General journal" not in page and "Bank accounts" not in page and "Search transactions" not in page
    # Accounting's screens send you back to the till
    r = c.get("/banking/")
    assert r.status_code == 302 and r.headers["Location"].endswith("/pos/")
    # Products, customers and help are part of POS
    assert c.get("/inventory/").status_code == 200
    assert c.get("/cards/customer").status_code == 200
    assert "Riyeser POS help" in c.get("/help/").get_data(as_text=True)
    assert sell(c, item).get_json()["ok"]


def test_pos_app_login_and_setup_say_riyeser_pos(tmp_path, monkeypatch):
    monkeypatch.setenv("RIYESER_APP_EDITION", "pos")
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "new.db")})
    page = app.test_client().get("/setup").get_data(as_text=True)
    assert "Riyeser POS" in page and "Basics" not in page


@pytest.mark.parametrize("edition", ["basics", "plus"])
def test_accounting_apps_send_the_till_to_riyeser_pos(tmp_path, monkeypatch, edition):
    app, c, item = make(tmp_path, monkeypatch, edition)
    home = c.get("/").get_data(as_text=True)
    assert "Riyeser POS" in home and "Open register" not in home
    for url in ("/pos/", "/pos/sales", "/pos/setup"):
        r = c.get(url)
        assert r.status_code == 302 and r.headers["Location"].endswith("/links/pos"), url
    assert sell(c, item).status_code == 302          # no selling from Accounting
    page = c.get("/links/pos").get_data(as_text=True)
    assert "/download/pos.html" in page and "same company file" in page


def test_pos_sales_show_in_accounting_as_paid_invoices(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "pos")
    assert sell(c, item).get_json()["ok"]
    monkeypatch.setenv("RIYESER_APP_EDITION", "basics")    # same company file, opened in Accounting Basics
    with app.app_context():
        doc = get_db().execute("SELECT status, total FROM documents WHERE side='sale'").fetchone()
    assert doc["status"] == "paid" and doc["total"] == 440


def _trial(tmp_path, days_ago, licensed=False):
    from datetime import timedelta
    f = tmp_path / "appdata" / "Riyeser" / "licence.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    d = {"trialStart": (now - timedelta(days=days_ago)).isoformat()}
    if licensed:
        d.update({"key": "K", "licence": {"status": "active", "checkedAt": now.isoformat()}})
    f.write_text(json.dumps(d))


def test_pos_is_free_for_90_days_then_a_licence(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "pos")
    _trial(tmp_path, 10)
    assert sell(c, item).get_json()["ok"]
    page = c.get("/pos/").get_data(as_text=True)
    assert "left in your free trial" not in page and "trial has ended" not in page   # no nagging early on
    _trial(tmp_path, 80)                               # last two weeks: a reminder on the till
    assert "10 days left in your free trial" in c.get("/pos/").get_data(as_text=True)
    assert sell(c, item).get_json()["ok"]
    _trial(tmp_path, 91)                               # trial over, no licence: new sales stop
    r = sell(c, item)
    assert r.status_code == 402 and "90-day free trial has ended" in r.get_json()["error"]
    page = c.get("/pos/").get_data(as_text=True)
    assert "free trial has ended" in page and "Nothing has been deleted" in page
    assert c.get("/pos/sales").status_code == 200   # past sales stay viewable
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM pos_sales").fetchone()[0] == 2
    _trial(tmp_path, 91, licensed=True)                # a licence from Riyeser Central: selling again
    assert sell(c, item).get_json()["ok"]
    assert "free trial" not in c.get("/pos/").get_data(as_text=True).lower()


def test_accounting_basics_is_free_for_90_days(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "basics")
    with app.app_context():
        cust = get_db().execute("INSERT INTO contacts (kind, name) VALUES ('customer','Jo')").lastrowid
        get_db().commit()

    def invoice(status="open"):
        return c.post("/sale/new", data={"contact_id": cust, "date": "2026-11-20", "status": status,
                                         "line_item": item, "line_description": "Coffee", "line_qty": "1",
                                         "line_price": "4", "line_discount": "", "line_account": "", "line_tax": "",
                                         "line_job": ""}, follow_redirects=True)

    _trial(tmp_path, 30)
    assert "saved" in invoice().get_data(as_text=True)
    assert "Free trial · 60 days left" in c.get("/").get_data(as_text=True)
    _trial(tmp_path, 95)
    page = invoice().get_data(as_text=True)
    assert "90-day free trial has ended" in page
    assert "saved" in invoice("quote").get_data(as_text=True)       # quotes are still allowed
    with app.app_context():
        n = get_db().execute("SELECT COUNT(*) FROM documents WHERE side='sale' AND status!='quote'").fetchone()[0]
    assert n == 1
