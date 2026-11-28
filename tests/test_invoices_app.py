"""Riyeser Invoices: the free app for quotes, invoices, customers and getting paid. Same company file as Accounting."""
from riyeser.db import get_db
from tests.test_pos_app import make, _trial


def _cust(app):
    with app.app_context():
        cid = get_db().execute("INSERT INTO contacts (kind, name) VALUES ('customer','Jo')").lastrowid
        get_db().commit()
    return cid


def _invoice(c, cust, item, status="open"):
    return c.post("/sale/new", data={"contact_id": cust, "date": "2026-11-20", "status": status, "line_item": item,
                                     "line_description": "Coffee", "line_qty": "1", "line_price": "4",
                                     "line_discount": "", "line_account": "", "line_tax": "", "line_job": ""},
                  follow_redirects=True)


def test_invoices_app_shows_only_invoicing(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "invoices")
    home = c.get("/").get_data(as_text=True)   # Today is the home screen, with the cards Invoices has
    assert "Unpaid invoices" in home and "Money in this week" in home
    for gone in ("Bills due", "Low stock", "Today's bookings", "Expense claims"):
        assert gone not in home, gone
    page = c.get("/sale/list").get_data(as_text=True)
    assert "Riyeser Invoices" in page and "ed-inv" in page and "Free forever" in page
    for gone in ("Bank accounts", "General journal", "Enter bill", "Stock items", "Payroll", "Search transactions"):
        assert gone not in page, gone
    assert c.get("/cards/customer").status_code == 200
    assert c.get("/sale/pay").status_code == 200
    assert c.get("/reports/aged_receivables").status_code == 200
    # everything else is Accounting's: it explains how to move up, and nothing is lost
    for url in ("/banking/", "/purchase/new", "/inventory/", "/cards/supplier", "/reports/pnl", "/pos/"):
        r = c.get(url)
        assert r.status_code == 302 and r.headers["Location"].endswith("/setup/accounting-basics"), url
    up = c.get("/setup/accounting-basics").get_data(as_text=True)
    assert "/download/accounting-basics.html" in up and "same company file" in up


def test_invoices_app_is_free_forever(tmp_path, monkeypatch):
    app, c, item = make(tmp_path, monkeypatch, "invoices")
    cust = _cust(app)
    _trial(tmp_path, 400)                       # long after the 90-day trial, with no licence
    assert "saved" in _invoice(c, cust, item).get_data(as_text=True)
    assert "trial has ended" not in c.get("/sale/list").get_data(as_text=True)
    with app.app_context():
        assert get_db().execute("SELECT edition FROM company").fetchone()[0] == "basic"  # Basics opens it as is


def test_invoices_app_setup_page_says_riyeser_invoices(tmp_path, monkeypatch):
    from riyeser import create_app
    monkeypatch.setenv("RIYESER_APP_EDITION", "invoices")
    page = create_app({"TESTING": True, "DATABASE": str(tmp_path / "new.db")}).test_client().get("/setup").get_data(as_text=True)
    assert "Riyeser Invoices" in page
