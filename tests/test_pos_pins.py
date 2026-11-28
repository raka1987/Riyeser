"""Riyeser POS 2.11.1: Till PINs (who's selling), the POS starting-access presets, and the keypads' Clear key.
Synthetic data only. Every test that moves money ends with the books check (tests/test_qa_apps.py: books_consistent)."""
import json
import re
import socket
from datetime import date

import pytest

from riyeser import create_app, perms, pos_pins
from riyeser.db import get_db, init_db
from riyeser import ledger as L
from riyeser import drawer as D
from tests.test_qa_apps import books_consistent, ids

TODAY = date.today().isoformat()
TAKEN = "That PIN is already used — choose another"


@pytest.fixture
def shop(tmp_path, monkeypatch):
    monkeypatch.setenv("RIYESER_APP_EDITION", "pos")
    printer = D.FakePrinter()
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "shop.db"), "RAW_PRINTER": printer})
    with app.app_context():
        init_db("Synthetic Surf Shop")
        db = get_db()
        acc, tc = ids(db)
        sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Synthetic Supplier')").lastrowid
        tea = db.execute("INSERT INTO items (sku, name, is_inventoried, is_sold, is_bought, income_account_id,"
                         " expense_account_id, asset_account_id, sell_price, buy_price, sale_tax_code_id, category,"
                         " active, barcodes) VALUES ('T1','Tea',1,1,1,?,?,?,302,117,?,'Drinks',1,'9300000000017')",
                         (acc["4-1000"], acc["5-1000"], acc["1-1300"], tc["GST"])).lastrowid
        L.save_document(db, "purchase", dict(contact_id=sup, date=TODAY),
                        [dict(item_id=tea, qty=50, unit_price=117, tax_code_id=tc["GST"])], "open")
        db.commit()
    admin = app.test_client()
    admin.post("/login", data={"username": "admin", "password": "admin"})
    return dict(app=app, admin=admin, tea=tea, printer=printer)


def add_user(s, name, preset="cashier", pin=None, full=None):
    data = {"username": name, "password": "pw-synthetic1", "preset": preset, "full_name": full or name.title()}
    if pin:
        data["till_pin"] = pin
    r = s["admin"].post("/users/save", data=data, follow_redirects=True)
    with s["app"].app_context():
        row = get_db().execute("SELECT id FROM users WHERE username=?", (name,)).fetchone()
        return (row[0] if row else None), r


def books_ok(s):
    with s["app"].app_context():
        bad = books_consistent(get_db())
        assert bad == [], bad


def unlock(c, pin, uid=None, purpose=None):
    return c.post("/pos/cashier/unlock", json={"pin": pin, "user_id": uid, "till_id": 1, "purpose": purpose})


def sale(c, s, n=1, ref=None):
    """A cash sale of n teas, with change."""
    return c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": 1000 * n}], "till_id": 1,
                                     "lines": [{"item_id": s["tea"], "qty": n}], "checkout_ref": ref})


def till_pc(s):
    """The till PC: signed in as the owner (admin), with two cashiers and a supervisor who have Till PINs."""
    maria, _ = add_user(s, "maria", "cashier", "1111", "Maria Synthetic")
    jo, _ = add_user(s, "jo", "cashier", "2222", "Jo Example")
    sup, _ = add_user(s, "sam", "supervisor", "9999", "Sam Supervisor")
    return dict(maria=maria, jo=jo, sup=sup, c=s["admin"])


# ------------------------------------------------------------ the PIN itself
def test_pin_is_hashed_never_shown_and_unique_among_active_users(shop):
    s = shop
    maria, r = add_user(s, "maria", "cashier", "4321")
    page = s["admin"].get("/users").get_data(as_text=True)
    assert "4321" not in page and "PIN set" in page and "No PIN" in page        # admin sees only set / not set
    with s["app"].app_context():
        h = get_db().execute("SELECT pos_pin_hash FROM users WHERE id=?", (maria,)).fetchone()[0]
    assert h.startswith("pbkdf2:sha256:") and "4321" not in h
    jo, r = add_user(s, "jo", "cashier", "4321")                                 # the same PIN again: refused
    assert TAKEN in r.get_data(as_text=True)
    with s["app"].app_context():
        assert get_db().execute("SELECT COUNT(*) FROM users WHERE username='jo'").fetchone()[0] == 0
    jo, _ = add_user(s, "jo", "cashier")
    r = s["admin"].post("/users/save", data={"id": jo, "role": "accountant", "active": "1", "till_pin": "4321",
                                             "perm_sales": "2"}, follow_redirects=True)
    assert TAKEN in r.get_data(as_text=True)
    for bad in ("12", "1234567", "12a4"):
        r = s["admin"].post("/users/save", data={"id": jo, "role": "accountant", "active": "1", "till_pin": bad,
                                                 "perm_sales": "2"}, follow_redirects=True)
        assert "A Till PIN is 4 to 6 numbers." in r.get_data(as_text=True)
    # reset, then remove; a person made inactive loses their PIN (so it can be given to someone else)
    s["admin"].post("/users/save", data={"id": jo, "role": "accountant", "active": "1", "till_pin": "5555", "perm_sales": "2"})
    with s["app"].app_context():
        db = get_db()
        assert pos_pins.matches(db.execute("SELECT * FROM users WHERE id=?", (jo,)).fetchone(), "5555")
    s["admin"].post("/users/save", data={"id": maria, "role": "accountant", "perm_sales": "2"})   # not active
    with s["app"].app_context():
        assert get_db().execute("SELECT pos_pin_hash FROM users WHERE id=?", (maria,)).fetchone()[0] is None
    r = s["admin"].post("/users/save", data={"id": jo, "role": "accountant", "active": "1", "till_pin": "4321",
                                             "perm_sales": "2"}, follow_redirects=True)
    assert TAKEN not in r.get_data(as_text=True)
    s["admin"].post("/users/save", data={"id": jo, "role": "accountant", "active": "1", "till_pin_remove": "1", "perm_sales": "2"})
    with s["app"].app_context():
        assert get_db().execute("SELECT pos_pin_hash FROM users WHERE id=?", (jo,)).fetchone()[0] is None
        log = [r[0] for r in get_db().execute("SELECT details FROM audit_log WHERE action LIKE 'pos_pin%'")]
    assert not any(re.search(r"\b(4321|5555)\b", x or "") for x in log)           # PINs never in the audit trail


def test_manager_approval_pin_is_the_same_unique_till_pin(shop):
    s = shop
    p = till_pc(s)
    r = s["admin"].post("/pos/approvals", data={"what": "pin", "user_id": 1, "pin": "1111"}, follow_redirects=True)
    assert TAKEN in r.get_data(as_text=True)                                      # Maria's PIN
    r = s["admin"].post("/pos/approvals", data={"what": "pin", "user_id": 1, "pin": "8080"}, follow_redirects=True)
    assert "PIN saved" in r.get_data(as_text=True)


# ------------------------------------------------------------ presets
def test_pos_shows_only_its_presets_and_accounting_keeps_bookkeeper(shop, tmp_path, monkeypatch):
    page = shop["admin"].get("/users").get_data(as_text=True)
    sel = re.search(r'<select name="preset" id="newPreset">(.*?)</select>', page, re.S).group(1)
    names = re.findall(r'>([^<]+)</option>', sel)
    assert names == ["Cashier", "Supervisor / shift manager", "Stock &amp; products", "Kitchen staff (kitchen screen only)",
                     "Manager", "Read-only", "Administrator"]
    assert re.search(r'<option value="cashier" selected>', sel)                    # Add a user starts at Cashier
    assert 'name="till_pin"' in page and "need a manager's PIN" in page             # the hint text
    monkeypatch.setenv("RIYESER_APP_EDITION", "basics")
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "acct.db")})
    with app.app_context():
        init_db("Synthetic Books")
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    page = c.get("/users").get_data(as_text=True)
    sel = re.search(r'<select name="preset" id="newPreset">(.*?)</select>', page, re.S).group(1)
    assert "Bookkeeper" in sel and "Payroll officer" in sel and "Cashier" not in sel and "Kitchen" not in sel
    assert 'name="till_pin"' not in page                                          # no till in Accounting
    for key, apps in (("invoices", ["owner", "bookkeeper", "sales", "readonly"]),
                      ("estimate", ["owner", "sales", "readonly"])):
        assert list(perms.presets_for_app(key)) == apps


def test_existing_users_keep_their_access_and_show_custom(shop):
    s = shop
    with s["app"].app_context():
        db = get_db()
        from werkzeug.security import generate_password_hash
        levels = json.dumps(perms.PRESETS["payroll"][1])      # Payroll officer: not offered in POS
        db.execute("INSERT INTO users (username, password_hash, role, perms) VALUES ('old','x','accountant',?)", (levels,))
        db.commit()
    page = s["admin"].get("/users").get_data(as_text=True)
    card = page[page.index("<b>old</b>"):][:600]
    assert "Custom" in card
    with s["app"].app_context():
        assert get_db().execute("SELECT perms FROM users WHERE username='old'").fetchone()[0] == levels


def test_add_a_user_shows_the_role_and_can_be_changed_before_adding(shop):
    s = shop
    page = s["admin"].get("/users").get_data(as_text=True)
    add = page[page.index('id="addUser"'):]
    assert 'id="newPerms"' in add and 'name="perm_sales"' in add and "Reset to <span id=\"newResetName\"></span> standard" in add
    assert "(customised)" in page                                                   # the live label (script)
    # Cashier, plus Stock: View ticked before adding
    form = {"username": "kim", "password": "pw-synthetic1", "preset": "cashier",
            **{f"perm_{a}": str(v) for a, v in perms.PRESETS["cashier"][1].items()}, "perm_stock": "1"}
    s["admin"].post("/users/save", data=form)
    with s["app"].app_context():
        db = get_db()
        u = db.execute("SELECT * FROM users WHERE username='kim'").fetchone()
        lv = json.loads(u["perms"])
        assert u["role"] == "accountant" and lv["sales"] == perms.EDIT and lv["stock"] == perms.VIEW and lv["setup"] == 0
        assert "cashier (customised: stock=1)" in db.execute("SELECT details FROM audit_log WHERE action='add_user'"
                                                             " ORDER BY id DESC").fetchone()[0]
    page = s["admin"].get("/users").get_data(as_text=True)
    assert "Cashier (customised)" in page[page.index("<b>kim</b>"):][:700]
    # the standard Cashier, untouched: just "Cashier"
    s["admin"].post("/users/save", data={**form, "username": "lee", "perm_stock": "0"})
    page = s["admin"].get("/users").get_data(as_text=True)
    assert ">Cashier<" in page[page.index("<b>lee</b>"):][:700]
    # only an administrator manages users: a supervisor can't give themselves more
    sam = s["app"].test_client()
    add_user(s, "sam", "supervisor")
    sam.post("/login", data={"username": "sam", "password": "pw-synthetic1"})
    assert sam.get("/users").status_code in (302, 403)
    sam.post("/users/save", data={**form, "username": "sneaky", "perm_setup": "3"})
    with s["app"].app_context():
        assert get_db().execute("SELECT COUNT(*) FROM users WHERE username='sneaky'").fetchone()[0] == 0


def test_pos_presets_have_the_right_levels():
    P = perms.PRESETS
    assert P["cashier"][1]["sales"] == perms.EDIT and all(v == perms.HIDDEN for a, v in P["cashier"][1].items() if a != "sales")
    assert P["supervisor"][1]["sales"] == perms.FULL and P["supervisor"][1]["setup"] == perms.HIDDEN
    assert P["stock_staff"][1]["stock"] == perms.FULL and P["stock_staff"][1]["sales"] == perms.HIDDEN
    assert P["manager"][1]["setup"] == perms.FULL and P["manager"][1]["sales"] == perms.FULL
    assert P["kitchen"][1]["kitchen"] == perms.EDIT and P["kitchen"][1]["sales"] == perms.HIDDEN


def test_cashier_preset_sells_but_refund_void_and_no_sale_need_a_manager_pin(shop):
    s = shop
    p = till_pc(s)
    c = p["c"]
    assert unlock(c, "1111").get_json()["ok"]                                       # Maria at the till
    c.post("/pos/shift/open", json={"till_id": 1, "float": "100.00"})
    sid = sale(c, s, 2).get_json()["sale_id"]
    with s["app"].app_context():
        line = get_db().execute("SELECT l.id FROM document_lines l JOIN pos_sales p ON p.document_id=l.document_id"
                                " WHERE p.id=?", (sid,)).fetchone()[0]
    r = c.post(f"/pos/sale/{sid}/refund", json={"lines": {str(line): 1}, "till_id": 1, "method": "cash"}).get_json()
    assert not r["ok"] and "manager" in r["error"]
    c.post(f"/pos/sale/{sid}/void")
    with s["app"].app_context():
        assert get_db().execute("SELECT voided FROM pos_sales WHERE id=?", (sid,)).fetchone()[0] == 0
    till = c.get("/pos/").get_data(as_text=True)                                   # the till's menu: no setup links
    assert "POS setup</a>" not in till and "Products &amp; setup</a>" not in till
    # the supervisor approves with THEIR PIN on the same screen; Maria stays signed in
    a = c.post("/pos/approve", json={"action": "refund", "ref": sid, "amount": 302, "reason": "Faulty item",
                                     "pin": "9999", "till_id": 1}).get_json()
    assert a["ok"] and a["approver"] == "Sam Supervisor"
    r = c.post(f"/pos/sale/{sid}/refund", json={"lines": {str(line): 1}, "till_id": 1, "method": "cash",
                                                "approval_id": a["approval_id"]}).get_json()
    assert r["ok"]
    assert c.get("/pos/cashier/state").get_json()["cashier"]["name"] == "Maria Synthetic"
    with s["app"].app_context():
        db = get_db()
        ref = db.execute("SELECT * FROM pos_refunds").fetchone()
        assert ref["user_id"] == p["maria"]
        ap = db.execute("SELECT * FROM pos_approvals WHERE id=?", (a["approval_id"],)).fetchone()
        assert ap["requested_by"] == p["maria"] and ap["approved_by"] == p["sup"]
    # a wrong manager PIN is refused and audited
    bad = c.post("/pos/approve", json={"action": "void", "ref": sid, "reason": "Wrong item", "pin": "0000"}).get_json()
    assert not bad["ok"]
    with s["app"].app_context():
        assert get_db().execute("SELECT COUNT(*) FROM audit_log WHERE action='pos_pin_failed'").fetchone()[0] == 1
    books_ok(s)


def test_cashier_no_sale_needs_a_manager(shop):
    s = shop
    p = till_pc(s)
    c = p["c"]
    c.post("/pos/drawer", data={"mode_1": "printer", "printer_1": "Receipt printer (test)"})
    unlock(c, "2222")
    r = c.post("/pos/drawer/open", json={"till_id": 1, "reason": "Give change"}).get_json()
    assert not r["ok"] and "manager" in r["error"]
    a = c.post("/pos/approve", json={"action": "nosale", "ref": 1, "reason": "Give change", "pin": "9999"}).get_json()
    assert c.post("/pos/drawer/open", json={"till_id": 1, "approval_id": a["approval_id"]}).get_json()["ok"]
    with s["app"].app_context():
        assert get_db().execute("SELECT user_id FROM pos_drawer_events WHERE kind='no_sale'").fetchone()[0] == p["jo"]


# ------------------------------------------------------------ at the till
def test_till_locks_and_opening_records_who_counted_the_float(shop):
    s = shop
    p = till_pc(s)
    c = p["c"]
    page = c.get("/pos/").get_data(as_text=True)
    assert "Who's selling?" in page and 'class="lock show"' in page and "Maria Synthetic" in page
    assert sale(c, s).status_code == 423                                             # locked: nothing sells
    assert c.post("/pos/shift/open", json={"till_id": 1, "float": "50"}).status_code == 423
    d = unlock(c, "2222", purpose="open").get_json()
    assert d["ok"] and d["cashier"]["name"] == "Jo Example"
    assert c.post("/pos/shift/open", json={"till_id": 1, "float": "150.00"}).get_json()["ok"]
    with s["app"].app_context():
        db = get_db()
        sh = db.execute("SELECT * FROM pos_shifts").fetchone()
        assert sh["opened_by"] == p["jo"] and sh["float_amount"] == 15000
        assert db.execute("SELECT kind, user_id, signed_in_id FROM pos_cashier_events").fetchone()[:] == ("open_till", p["jo"], 1)


def test_every_sale_refund_records_the_cashier_and_switching(shop):
    s = shop
    p = till_pc(s)
    c = p["c"]
    unlock(c, "1111", uid=p["maria"])
    c.post("/pos/shift/open", json={"till_id": 1, "float": "100"})
    s1 = sale(c, s, 1, ref="co-a").get_json()["sale_id"]
    assert c.post("/pos/cashier/lock").get_json()["ok"]                              # Switch cashier
    assert sale(c, s, 1).status_code == 423
    assert c.get("/pos/sales").status_code == 302                                   # locked pages go to the lock screen
    tiles = c.get("/pos/cashier/state").get_json()["cashier_tiles"]
    assert [t["name"] for t in tiles] == ["Maria Synthetic"]                          # today's cashiers only
    unlock(c, "2222", uid=p["jo"])
    s2 = sale(c, s, 3, ref="co-b").get_json()["sale_id"]
    with s["app"].app_context():
        db = get_db()
        users = dict(db.execute("SELECT id, user_id FROM pos_sales").fetchall())
    assert users[s1] == p["maria"] and users[s2] == p["jo"]
    # sales by cashier on Today and on the X-read / Z-report
    unlock(c, "9999")
    page = c.get("/pos/sales").get_data(as_text=True)
    assert "Sales by cashier" in page and "Maria Synthetic" in page and "Jo Example" in page
    by = re.search(r"Sales by cashier.*?</table>", page, re.S).group(0)
    assert by.index("Jo Example") < by.index("Maria Synthetic")                      # biggest first
    z = c.get("/pos/shift/1").get_data(as_text=True)
    assert "SALES BY CASHIER" in z and "Jo Example (1)" in z and "Maria Synthetic (1)" in z
    close = c.get("/pos/close?till=1").get_data(as_text=True)
    assert "Sales by cashier" in close and "Jo Example" in close
    books_ok(s)


def test_wrong_pins_lock_the_pad_for_a_minute_and_are_audited(shop, monkeypatch):
    s = shop
    p = till_pc(s)
    c = p["c"]
    t = [1_000_000.0]
    monkeypatch.setattr(pos_pins, "now", lambda: t[0])
    for i in range(4):
        r = unlock(c, "0000", uid=p["maria"])
        assert r.status_code == 400 and "isn't right" in r.get_json()["error"]
    r = unlock(c, "0000", uid=p["maria"])
    assert r.status_code == 429 and "Too many wrong PINs" in r.get_json()["error"]
    assert unlock(c, "1111", uid=p["maria"]).status_code == 429                    # even the right PIN waits
    other = s["app"].test_client()                                                   # another device, same person
    other.post("/login", data={"username": "admin", "password": "admin"})
    assert unlock(other, "1111", uid=p["maria"]).status_code == 429
    with s["app"].app_context():
        assert get_db().execute("SELECT COUNT(*) FROM audit_log WHERE action='pos_pin_failed'").fetchone()[0] == 5
    t[0] += pos_pins.LOCKOUT + 1
    assert unlock(c, "1111", uid=p["maria"]).get_json()["ok"]


def test_auto_lock_after_the_idle_time_and_never(shop, monkeypatch):
    s = shop
    p = till_pc(s)
    c = p["c"]
    t = [2_000_000.0]
    monkeypatch.setattr(pos_pins, "now", lambda: t[0])
    unlock(c, "1111")
    c.post("/pos/shift/open", json={"till_id": 1, "float": "0"})
    t[0] += 4 * 60
    assert sale(c, s).get_json()["ok"]                                               # 4 minutes: still Maria
    t[0] += 5 * 60 + pos_pins.GRACE + 1
    assert sale(c, s).status_code == 423                                             # default 5 minutes: locked
    with s["app"].app_context():
        assert get_db().execute("SELECT COUNT(*) FROM pos_cashier_events WHERE kind='auto_lock'").fetchone()[0] == 1
    assert c.get("/pos/setup").status_code == 200                                    # back office: the PC's user
    c.post("/pos/setup", data={"mode": "retail", "feature": ["scan"], "pins": "auto", "lock_minutes": "0",
                               "till_name_1": "Till 1"})
    with s["app"].app_context():
        assert pos_pins.settings(get_db())["lock_minutes"] == 0
    unlock(c, "1111")
    t[0] += 10 * 3600
    assert sale(c, s).get_json()["ok"]                                               # "Never" never locks
    books_ok(s)


def test_cashier_closes_own_till_supervisor_closes_any(shop):
    s = shop
    p = till_pc(s)
    c = p["c"]
    unlock(c, "1111")
    c.post("/pos/shift/open", json={"till_id": 1, "float": "0"})
    unlock(c, "2222")
    page = c.get("/pos/close?till=1").get_data(as_text=True)
    assert "Maria Synthetic opened this till" in page
    c.post("/pos/close", data={"till": 1})
    with s["app"].app_context():
        assert get_db().execute("SELECT status FROM pos_shifts").fetchone()[0] == "open"
    unlock(c, "9999")
    c.post("/pos/close", data={"till": 1})
    with s["app"].app_context():
        sh = get_db().execute("SELECT status, closed_by FROM pos_shifts").fetchone()
        assert sh["status"] == "closed" and sh["closed_by"] == p["sup"]
    books_ok(s)


def test_pins_work_offline_and_managers_only_pins_do_not_lock(shop, monkeypatch):
    s = shop
    c = s["admin"]
    s["admin"].post("/pos/approvals", data={"what": "pin", "user_id": 1, "pin": "8080"})
    assert 'id="lockScr"' not in c.get("/pos/").get_data(as_text=True)              # 2.10 manager PIN only
    till_pc(s)

    def no_network(*a, **k):
        raise OSError("no network (test)")
    monkeypatch.setattr(socket.socket, "connect", no_network)
    assert unlock(c, "1111").get_json()["ok"]                                        # checked on this PC
    c.post("/pos/setup", data={"mode": "retail", "pins": "off", "lock_minutes": "5", "till_name_1": "Till 1"})
    assert 'id="lockScr"' not in c.get("/pos/").get_data(as_text=True)              # turned off in POS setup


def test_till_without_pins_works_as_before(shop):
    s = shop
    c = s["admin"]
    assert 'id="lockScr"' not in c.get("/pos/").get_data(as_text=True)
    c.post("/pos/shift/open", json={"till_id": 1, "float": "20"})
    assert sale(c, s).get_json()["ok"]
    with s["app"].app_context():
        assert get_db().execute("SELECT user_id FROM pos_sales").fetchone()[0] == 1
    books_ok(s)


# ------------------------------------------------------------ the keypads' Clear key
def test_every_money_keypad_has_clear_and_delete(shop):
    page = shop["admin"].get("/pos/").get_data(as_text=True)
    for pad in ("fkeys", "keys", "ckeys"):
        body = re.search(rf'<div class="keys" id="{pad}"[^>]*>(.*?)</div>', page).group(1)
        assert 'data-k="clear"' in body and 'data-k="del"' in body and ">00<" in body and ">0<" in body
    assert "e.key==='Escape'||e.key==='Delete')?'clear'" in page                     # Esc / Delete clear
    assert re.search(r"function padKey\(c,b\)\{.*k==='clear'\)return '0'", page)
    till_pc(shop)
    page = shop["admin"].get("/pos/").get_data(as_text=True)
    assert 'data-k="clear" aria-label="Clear (C)">C<' in page                       # the PIN pad too
    kds = shop["app"].test_client().get("/kds/pair").get_data(as_text=True)
    assert 'data-k="clear"' in kds and 'data-k="del"' in kds
