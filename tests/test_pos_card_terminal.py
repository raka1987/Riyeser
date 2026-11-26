"""Card payments (EFTPOS) on the till: the practice terminal, manual machines, split tenders, refunds through the
terminal, crash recovery, double-charge protection and close-of-day card totals."""
import json

import pytest

from riyeser import create_app
from riyeser.db import get_db, init_db, linked
from riyeser import terminals
from riyeser.terminals import store as T


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("RIYESER_APP_EDITION", "pos")
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "t.db")})
    with app.app_context():
        init_db("Corner Shop")
        db = get_db()
        tc = db.execute("SELECT id FROM tax_codes WHERE code='GST'").fetchone()[0]
        acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
        db.execute("INSERT INTO items (sku, name, is_sold, sell_price, income_account_id, sale_tax_code_id)"
                   " VALUES ('C1','Coffee',1,400,?,?)", (acc["4-1000"], tc))   # $4.40 inc GST
        db.commit()
        item = db.execute("SELECT id FROM items").fetchone()[0]
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return app, c, item


def use(c, provider, till=1):
    r = c.post("/pos/card-payments", data={f"provider_{till}": provider}, follow_redirects=True)
    assert "Card payments saved" in r.get_data(as_text=True)


def start(c, amount, ref="co-1", till=1, kind="payment", **kw):
    return c.post("/pos/terminal/start", json={"kind": kind, "amount": amount, "till_id": till, "checkout_ref": ref,
                                               "payload": {"lines": []}, **kw})


def sim(c, tid, action="approve", **kw):
    return c.post(f"/pos/terminal/{tid}/practice", json={"action": action, **kw}).get_json()["txn"]


def sale(c, item, tenders, ref="co-1", qty=1, till=1):
    return c.post("/pos/sale", json={"lines": [{"item_id": item, "qty": qty}], "till_id": till, "tenders": tenders,
                                     "checkout_ref": ref})


def balanced(app):
    with app.app_context():
        d, cr = get_db().execute("SELECT SUM(debit), SUM(credit) FROM journal_lines").fetchone()
        return d == cr


def q(app, sql, *a):
    with app.app_context():
        return get_db().execute(sql, a).fetchall()


def test_practice_terminal_approves_and_the_receipt_shows_the_card(env):
    app, c, item = env
    use(c, "practice")
    c.post("/pos/shift/open", json={"till_id": 1, "float": "100"})
    x = start(c, 440).get_json()["txn"]
    assert x["status"] == "pending" and x["provider"] == "practice" and x["reference"].startswith("RIY")
    assert c.get(f"/pos/terminal/{x['id']}").get_json()["txn"]["status"] == "pending"   # still waiting
    x = sim(c, x["id"], "approve", scheme="Mastercard", entry="tap", last4="4242")
    assert x["status"] == "approved" and x["card_last4"] == "4242" and x["auth_code"] and x["approved_amount"] == 440
    d = sale(c, item, [{"method": "card", "amount": 440, "txn_id": x["id"]}]).get_json()
    assert d["ok"] and d["method"] == "card" and d["drawer"] is False and d["cards"][0]["last4"] == "4242"
    rc = c.get(d["receipt_url"]).get_data(as_text=True)
    assert "Mastercard" in rc and "&bull;&bull;4242" in rc and "Auth " + x["auth_code"] in rc and "(tap)" in rc
    assert "PRACTICE TERMINAL" in rc                      # the machine's own receipt lines
    assert q(app, "SELECT sale_id FROM pos_terminal_txns WHERE id=?", x["id"])[0][0] == d["sale_id"]
    hist = [e["status"] for e in c.get(f"/pos/terminal/{x['id']}").get_json()["txn"]["history"]]
    assert hist[0] == "pending" and "approved" in hist      # full status history kept
    assert balanced(app)


def test_declined_cancelled_and_timed_out_keep_the_sale_open(env, monkeypatch):
    app, c, item = env
    use(c, "practice")
    x = start(c, 440).get_json()["txn"]
    assert sim(c, x["id"], "decline")["status"] == "declined"
    r = sale(c, item, [{"method": "card", "amount": 440, "txn_id": x["id"]}])
    assert r.status_code == 400 and "wasn't approved" in r.get_json()["error"]
    # try again on the same sale: a new attempt is allowed once the last one has finished
    y = start(c, 440).get_json()["txn"]
    assert y["id"] != x["id"]
    assert c.post(f"/pos/terminal/{y['id']}/cancel").get_json()["txn"]["status"] == "cancelled"
    z = start(c, 440).get_json()["txn"]
    assert sim(c, z["id"], "timeout")["status"] == "timeout"
    # a machine that never answers times out by itself
    w = start(c, 440).get_json()["txn"]
    with app.app_context():
        db = get_db()
        st = json.loads(T.get(db, w["id"])["provider_state"])
        st["started"] -= 999
        db.execute("UPDATE pos_terminal_txns SET provider_state=? WHERE id=?", (json.dumps(st), w["id"]))
        db.commit()
    assert c.get(f"/pos/terminal/{w['id']}").get_json()["txn"]["status"] == "timeout"
    # nothing was sold; then cash finishes the same sale
    assert not q(app, "SELECT 1 FROM pos_sales")
    d = sale(c, item, [{"method": "cash", "tendered": 500}]).get_json()
    assert d["ok"] and d["change"] == 60


def test_one_active_attempt_per_till_and_never_finalise_twice(env):
    app, c, item = env
    use(c, "practice")
    x = start(c, 440).get_json()["txn"]
    assert start(c, 440).get_json()["txn"]["id"] == x["id"]          # same request again: same attempt
    r = start(c, 999, ref="co-other")
    assert r.status_code == 409 and r.get_json()["busy"]["id"] == x["id"]
    sim(c, x["id"], "approve")
    sim(c, x["id"], "decline")                                         # a finished answer never changes
    assert c.get(f"/pos/terminal/{x['id']}").get_json()["txn"]["status"] == "approved"
    t = [{"method": "card", "amount": 440, "txn_id": x["id"]}]
    a = sale(c, item, t).get_json()
    b = sale(c, item, t).get_json()                                    # double tap / lost reply
    assert a["ok"] and b["ok"] and b["repeat"] and b["sale_id"] == a["sale_id"]
    r = sale(c, item, t, ref="co-2")                                   # the same card payment on another sale
    assert r.status_code == 400
    assert len(q(app, "SELECT 1 FROM pos_sales")) == 1 and len(q(app, "SELECT 1 FROM payments")) == 1
    # an amount that doesn't match what the machine approved is refused
    y = start(c, 440, ref="co-3").get_json()["txn"]
    sim(c, y["id"], "approve")
    assert sale(c, item, [{"method": "card", "amount": 880, "txn_id": y["id"]}], ref="co-3", qty=2).status_code == 400
    # a linked till doesn't accept a card sale that skipped the machine
    r = c.post("/pos/sale", json={"method": "card", "till_id": 1, "lines": [{"item_id": item, "qty": 1}]})
    assert r.status_code == 400 and "card machine" in r.get_json()["error"]


def test_crash_mid_payment_is_resolved_after_restart(env):
    app, c, item = env
    use(c, "practice")
    x = start(c, 440, payload={"lines": [{"item_id": item, "qty": 1}]}).get_json()["txn"]
    # the PC crashes: a new app on the same company file, a new browser session
    app2 = create_app({"TESTING": True, "DATABASE": app.config["DATABASE"]})
    c2 = app2.test_client()
    c2.post("/login", data={"username": "admin", "password": "admin"})
    page = c2.get("/pos/").get_data(as_text=True)
    assert "Card payment not finished" in page and f'"id": {x["id"]}' in page
    un = c2.get("/pos/terminal/unresolved").get_json()
    assert [u["id"] for u in un] == [x["id"]] and un[0]["payload"]["lines"][0]["item_id"] == item
    # the cashier checks the machine: it shows approved
    r = c2.post(f"/pos/terminal/{x['id']}/resolve", json={"action": "approved", "last4": "1111"}).get_json()["txn"]
    assert r["status"] == "approved" and r["resolution"] == "cashier_confirmed"
    un = c2.get("/pos/terminal/unresolved").get_json()
    assert un and un[0]["status"] == "approved"                        # still listed: the sale isn't finished
    d = sale(c2, item, [{"method": "card", "amount": 440, "txn_id": x["id"]}]).get_json()
    assert d["ok"] and not c2.get("/pos/terminal/unresolved").get_json()
    # another pending attempt: the machine shows not charged
    y = start(c2, 440, ref="co-9").get_json()["txn"]
    assert c2.post(f"/pos/terminal/{y['id']}/resolve", json={"action": "not_charged"}).get_json()["txn"]["status"] \
        == "cancelled"
    assert not c2.get("/pos/terminal/unresolved").get_json()


def test_unfinished_approved_payment_can_be_refunded_to_the_card(env):
    app, c, item = env
    use(c, "practice")
    x = start(c, 440).get_json()["txn"]
    sim(c, x["id"], "approve")
    r = c.post("/pos/terminal/start", json={"kind": "refund", "till_id": 1, "orphan_of": x["id"]}).get_json()["txn"]
    assert r["kind"] == "refund" and r["amount"] == 440
    sim(c, r["id"], "approve")
    assert not c.get("/pos/terminal/unresolved").get_json()
    assert q(app, "SELECT resolution FROM pos_terminal_txns WHERE id=?", x["id"])[0][0] == "refunded"
    assert sale(c, item, [{"method": "card", "amount": 440, "txn_id": x["id"]}]).status_code == 400


def test_split_card_and_cash(env):
    app, c, item = env
    use(c, "practice")
    c.post("/pos/shift/open", json={"till_id": 1, "float": "100"})
    x = start(c, 500).get_json()["txn"]                     # $5 of a $8.80 sale on the card
    sim(c, x["id"], "approve", scheme="Visa")
    d = sale(c, item, [{"method": "card", "amount": 500, "txn_id": x["id"]}, {"method": "cash", "tendered": 1000}],
             qty=2).get_json()
    assert d["ok"] and d["method"] == "split" and d["change"] == 620 and d["drawer"] is True
    tenders = q(app, "SELECT method, amount, tendered, change_given FROM pos_tenders ORDER BY id")
    assert [tuple(t) for t in tenders] == [("card", 500, 500, 0), ("cash", 380, 1000, 620)]
    rc = c.get(d["receipt_url"]).get_data(as_text=True)
    assert "Visa" in rc and "Change" in rc and "$6.20" in rc
    with app.app_context():
        db = get_db()
        from riyeser import ledger as L
        b = L.balances(db)
        assert b[linked(db, "pos_card")] == 500 and b[linked(db, "pos_cash")] == 380
        sh = db.execute("SELECT * FROM pos_shifts WHERE status='open'").fetchone()
        from riyeser.views.pos import shift_figures
        f = shift_figures(db, sh)
    assert f["cash"] == 380 and f["card"] == 500 and f["expected"] == 10000 + 380 and f["total"] == 880
    # not enough to cover the rest is refused
    y = start(c, 100, ref="co-2").get_json()["txn"]
    sim(c, y["id"], "approve")
    r = sale(c, item, [{"method": "card", "amount": 100, "txn_id": y["id"]}, {"method": "cash", "tendered": 100}],
             ref="co-2")
    assert r.status_code == 400 and "still to pay" in r.get_json()["error"]


def test_card_refund_goes_back_through_the_terminal(env):
    app, c, item = env
    use(c, "practice")
    x = start(c, 880).get_json()["txn"]
    sim(c, x["id"], "approve", scheme="Visa", last4="9999")
    sid = sale(c, item, [{"method": "card", "amount": 880, "txn_id": x["id"]}], qty=2).get_json()["sale_id"]
    info = c.get(f"/pos/sale/{sid}/lines").get_json()
    lid = info["lines"][0]["id"]
    assert info["card"]["last4"] == "9999"
    body = {"lines": {lid: 1}, "method": "card", "reason": "Faulty item", "till_id": 1}
    assert c.post(f"/pos/sale/{sid}/refund", json=body).status_code == 400   # must go through the machine
    pv = c.post(f"/pos/sale/{sid}/refund", json={**body, "preview": True}).get_json()
    assert pv["ok"] and pv["amount"] == 440 and not q(app, "SELECT 1 FROM pos_refunds")
    assert c.post("/pos/terminal/start", json={"kind": "refund", "till_id": 1, "sale_id": sid,
                                               "amount": 2000}).status_code == 400   # more than the card paid
    r = c.post("/pos/terminal/start", json={"kind": "refund", "till_id": 1, "sale_id": sid, "amount": 440}).get_json()
    rt = r["txn"]
    assert rt["original_txn_id"] == x["id"]
    assert c.post(f"/pos/sale/{sid}/refund", json={**body, "terminal_txn_id": rt["id"]}).status_code == 400  # pending
    sim(c, rt["id"], "approve", scheme="Visa", last4="9999")
    d = c.post(f"/pos/sale/{sid}/refund", json={**body, "terminal_txn_id": rt["id"]}).get_json()
    assert d["ok"] and d["amount"] == 440
    assert c.post(f"/pos/sale/{sid}/refund", json={**body, "terminal_txn_id": rt["id"]}).status_code == 400  # once
    assert q(app, "SELECT refund_id FROM pos_terminal_txns WHERE id=?", rt["id"])[0][0] == d["refund_id"]
    # a terminal card sale is refunded, never voided
    c.post(f"/pos/sale/{sid}/void", data={"reason": "x"})
    assert q(app, "SELECT voided FROM pos_sales WHERE id=?", sid)[0][0] == 0
    assert balanced(app)


def test_close_of_day_card_totals_by_scheme_tips_and_cash_out(env):
    app, c, item = env
    use(c, "practice")
    c.post("/pos/shift/open", json={"till_id": 1, "float": "200"})
    a = start(c, 440, ref="a").get_json()["txn"]
    sim(c, a["id"], "approve", scheme="Visa", tip="1.00")
    assert sale(c, item, [{"method": "card", "amount": 440, "txn_id": a["id"]}], ref="a").get_json()["ok"]
    b = start(c, 880, ref="b").get_json()["txn"]
    b = sim(c, b["id"], "approve", scheme="Mastercard", cashout="20.00")
    assert b["approved_amount"] == 2880
    d = sale(c, item, [{"method": "card", "amount": 880, "txn_id": b["id"]}], ref="b", qty=2).get_json()
    assert d["cashout"] == 2000 and d["drawer"] is True                # the drawer opens for cash out only
    e = start(c, 440, ref="c").get_json()["txn"]
    sim(c, e["id"], "decline", scheme="Visa")                          # declined: not in any total
    page = c.get("/pos/close?till=1").get_data(as_text=True)
    assert "Card terminal totals by card type" in page and "Mastercard" in page and "Visa" in page
    assert "$28.80" in page and "$5.40" in page and "Cash out on the card machine" in page
    assert "Should be in the drawer" in page and "$180.00" in page   # $200 float - $20 cash out
    with app.app_context():
        db = get_db()
        from riyeser.views.pos import shift_figures
        f = shift_figures(db, db.execute("SELECT * FROM pos_shifts WHERE status='open'").fetchone())
    t = f["terminal"]
    assert t["count"] == 2 and t["tips"] == 100 and t["cashout"] == 2000 and t["net"] == 3420
    assert {s["scheme"]: s["net"] for s in t["schemes"]} == {"Visa": 540, "Mastercard": 2880}
    assert f["card_machine"] == 3420 and f["expected"] == 18000
    with app.app_context():
        db = get_db()
        tips = db.execute("SELECT account_id FROM linked_accounts WHERE key='pos_tips'").fetchone()[0]
        from riyeser import ledger as L
        assert L.balances(db)[tips] == -100       # owed to staff
    assert balanced(app)
    z = c.post("/pos/close", data={"till": 1, "n10000": 1, "n5000": 1, "n2000": 1, "n1000": 1,
                                   "card_settlement": "34.20"}, follow_redirects=True).get_data(as_text=True)
    assert "Z-REPORT" in z and "CARD TERMINAL BY CARD TYPE" in z and "Mastercard (1)" in z


def test_manual_machine(env):
    app, c, item = env
    use(c, "manual")
    x = start(c, 440).get_json()["txn"]
    assert x["cashier_confirms"] and x["status"] == "pending"
    assert c.get(f"/pos/terminal/{x['id']}").get_json()["txn"]["status"] == "pending"
    d = c.post(f"/pos/terminal/{x['id']}/manual", json={"result": "declined"}).get_json()["txn"]
    assert d["status"] == "declined"
    y = start(c, 440).get_json()["txn"]
    y = c.post(f"/pos/terminal/{y['id']}/manual", json={"result": "approved", "last4": "**** 5678", "auth": "A1B2",
                                                       "scheme": "EFTPOS"}).get_json()["txn"]
    assert y["status"] == "approved" and y["card_last4"] == "5678" and y["auth_code"] == "A1B2"
    s = sale(c, item, [{"method": "card", "amount": 440, "txn_id": y["id"]}]).get_json()
    assert s["ok"]
    assert "EFTPOS" in c.get(s["receipt_url"]).get_data(as_text=True)
    with pytest.raises(Exception):
        sim(c, y["id"])                                                # no pretend buttons on a real machine


def test_setup_screen_test_payment_demo_default_and_coming_soon(env):
    app, c, item = env
    page = c.get("/pos/card-payments").get_data(as_text=True)
    assert "Practice terminal" in page and "Stripe Terminal" in page and "Windcave" in page and "Coming soon" in page
    assert "Test a $1.00 payment" in page
    assert "Card payments" in c.get("/pos/setup").get_data(as_text=True)
    # nothing chosen: card sales work as before (not linked)
    assert c.post("/pos/sale", json={"method": "card", "till_id": 1, "lines": [{"item_id": item, "qty": 1}]}).get_json()["ok"]
    assert start(c, 100, kind="test").status_code == 400
    # coming soon can't be chosen
    r = c.post("/pos/card-payments", data={"provider_1": "stripe_terminal"}, follow_redirects=True)
    assert "available yet" in r.get_data(as_text=True)
    with app.app_context():
        assert T.provider_for(get_db(), 1) == "none"
    use(c, "practice")
    t = start(c, 5000, kind="test").get_json()["txn"]
    assert t["kind"] == "test" and t["amount"] == 100
    sim(c, t["id"])
    assert not c.get("/pos/terminal/unresolved").get_json()            # a test is never a sale
    assert "RIY" in c.get("/pos/card-payments").get_data(as_text=True)
    # demo companies use the practice terminal unless told otherwise
    with app.app_context():
        db = get_db()
        db.execute("DELETE FROM pos_terminal_settings")
        db.execute("UPDATE company SET is_demo=1")
        db.commit()
        assert T.provider_for(db, 1) == "practice"


def test_stub_providers_make_no_network_calls():
    import inspect
    from riyeser.terminals import stripe_terminal, windcave
    for mod, cls in ((stripe_terminal, terminals.StripeTerminal), (windcave, terminals.WindcaveTerminal)):
        src = inspect.getsource(mod)
        for word in ("import requests", "import urllib", "import http", "import socket", "sk_live", "sk_test_"):
            assert word not in src
        assert not cls.available and cls.coming_soon
        with pytest.raises(terminals.TerminalUnavailable):
            cls().start_payment(100, "AUD", "R1")


def test_older_sales_become_tenders(env):
    app, c, item = env
    assert c.post("/pos/sale", json={"method": "cash", "tendered": "10", "lines": [{"item_id": item, "qty": 1}]}).get_json()["ok"]
    with app.app_context():
        db = get_db()
        db.execute("DELETE FROM pos_tenders")
        db.commit()
        from riyeser.db import migrate
        migrate(db)
        migrate(db)
        rows = db.execute("SELECT method, amount, tendered, change_given FROM pos_tenders").fetchall()
    assert [tuple(r) for r in rows] == [("cash", 440, 1000, 560)]
