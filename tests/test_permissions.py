"""Per-area access: who can see and change what."""
import json
import re

import pytest

from riyeser import create_app
from riyeser.db import get_db, init_db


@pytest.fixture
def app(tmp_path):
    from riyeser.demo import seed_demo
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "p.db")})
    with app.app_context():
        init_db("Perm Co")
        seed_demo(get_db())
    return app


def admin(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return c


def add_user(app, name, preset):
    r = admin(app).post("/users/save", data={"username": name, "password": "pw", "preset": preset})
    assert r.status_code == 302
    c = app.test_client()
    c.post("/login", data={"username": name, "password": "pw"})
    return c


def count(app, sql, *args):
    with app.app_context():
        return get_db().execute(sql, args).fetchone()[0]


def a_doc(app, side):
    with app.app_context():
        return get_db().execute("SELECT id FROM documents WHERE side=? ORDER BY id LIMIT 1", (side,)).fetchone()["id"]


def test_sales_staff_see_sales_only(app):
    c = add_user(app, "sam", "sales")
    home = c.get("/").get_data(as_text=True)
    assert "All invoices" in home and "Payroll" not in home and "All bills" not in home and "Bank accounts" not in home
    assert "Customers owe you" in home and "You owe suppliers" not in home and "Income YTD" not in home
    # payroll, bills, banking and financial reports are refused, not just hidden
    for url in ["/payroll/", "/purchase/list", "/banking/", "/reports/pnl", "/reports/payroll_summary", "/journal",
                f"/document/{a_doc(app, 'purchase')}"]:
        r = c.get(url)
        assert r.status_code == 302, url
    # can read and add sales
    assert c.get("/sale/list").status_code == 200
    assert c.get(f"/document/{a_doc(app, 'sale')}").status_code == 200
    r = c.post("/cards/customer/new", data={"name": "Walk-in Ltd", "active": "1"})
    assert count(app, "SELECT COUNT(*) FROM contacts WHERE name='Walk-in Ltd'") == 1
    # ... but not delete or void
    doc = a_doc(app, "sale")
    c.post(f"/document/{doc}/void")
    c.post(f"/document/{doc}/delete")
    assert count(app, "SELECT COUNT(*) FROM documents WHERE id=?", doc) == 1
    assert count(app, "SELECT COUNT(*) FROM documents WHERE id=? AND status='void'", doc) == 0
    page = c.get(f"/document/{doc}").get_data(as_text=True)
    assert ">Delete<" not in page and ">Void<" not in page
    reports = c.get("/reports/").get_data(as_text=True)
    assert "Aged Receivables" in reports and "Payroll Activity" not in reports and "Profit &amp; Loss" not in reports


def test_payroll_hidden_everywhere_for_readonly(app):
    c = add_user(app, "rita", "readonly")
    assert c.get("/payroll/").status_code == 302
    # wages entries are left out of transaction lists, and can't be opened directly
    with app.app_context():
        pay = get_db().execute("SELECT id FROM journal_entries WHERE source_type IN ('payrun','payroll_import') LIMIT 1").fetchone()
    if pay:
        assert f"/entry/{pay['id']}\"" not in c.get("/journal").get_data(as_text=True)
        assert c.get(f"/entry/{pay['id']}").status_code == 302
    # read-only: nothing can be added
    c.post("/cards/customer/new", data={"name": "Nope", "active": "1"})
    assert count(app, "SELECT COUNT(*) FROM contacts WHERE name='Nope'") == 0


def test_payroll_officer(app):
    c = add_user(app, "pat", "payroll")
    assert c.get("/payroll/").status_code == 200
    assert c.get("/sale/list").status_code == 302
    assert "Employees" in c.get("/").get_data(as_text=True)


def test_admin_sets_levels_and_last_admin_is_protected(app):
    a = admin(app)
    add_user(app, "bob", "readonly")
    uid = count(app, "SELECT id FROM users WHERE username='bob'")
    levels = {f"perm_{k}": "0" for k in ["sales", "purchases", "banking", "stock", "payroll", "accounts", "setup"]}
    levels["perm_purchases"] = "3"
    a.post("/users/save", data={"id": uid, "full_name": "Bob", "role": "accountant", "active": "1", **levels})
    with app.app_context():
        saved = json.loads(get_db().execute("SELECT perms FROM users WHERE id=?", (uid,)).fetchone()["perms"])
    assert saved["purchases"] == 3 and saved["sales"] == 0
    b = app.test_client(); b.post("/login", data={"username": "bob", "password": "pw"})
    assert b.get("/purchase/list").status_code == 200 and b.get("/sale/list").status_code == 302
    # the only administrator can't take away their own admin rights
    me = count(app, "SELECT id FROM users WHERE username='admin'")
    a.post("/users/save", data={"id": me, "role": "viewer", "active": "1"})
    assert count(app, "SELECT role='admin' FROM users WHERE id=?", me) == 1
    # only administrators manage users
    assert b.get("/users").status_code == 302


def test_existing_users_keep_working(app):
    # users made before this change follow their role
    a = admin(app)
    a.post("/users/save", data={"username": "acc", "password": "pw", "role": "accountant"})
    c = app.test_client(); c.post("/login", data={"username": "acc", "password": "pw"})
    for url in ["/payroll/", "/sale/list", "/purchase/list", "/banking/", "/reports/pnl"]:
        assert c.get(url).status_code == 200, url
