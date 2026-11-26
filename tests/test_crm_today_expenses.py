"""The customer page (one timeline, notes and follow-ups), the Today home screen, and staff expense claims."""
import io
import json
from datetime import date, timedelta

import pytest

from riyeser import create_app, ledger as L
from riyeser.db import get_db, init_db, to_cents
from tests.test_pos_app import make

TODAY = date.today()


def day(n):
    """n days from today (negative = in the past)."""
    return (TODAY + timedelta(days=n)).isoformat()


@pytest.fixture
def app(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "c.db")})
    with app.app_context():
        init_db("Crm Co")
    return app


def login(app, user="admin", pw="admin"):
    c = app.test_client()
    c.post("/login", data={"username": user, "password": pw})
    return c


def add_user(app, name, preset, full_name=None):
    r = login(app).post("/users/save", data={"username": name, "password": "pw-staff1", "preset": preset,
                                             "full_name": full_name or name.title()})
    assert r.status_code == 302
    return login(app, name, "pw-staff1")


def one(app, sql, *args):
    with app.app_context():
        return get_db().execute(sql, args).fetchone()


def ids(db):
    return ({r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")},
            {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM tax_codes")})


def books(app):
    """A customer with a quote, two invoices (one overdue), a payment and a credit note; a supplier with a bill."""
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust = db.execute("INSERT INTO contacts (kind, name, phone) VALUES ('customer','Bayside Cafe','02 9000 0000')").lastrowid
        sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Power Co')").lastrowid
        line = lambda amt: [dict(description="Service", qty=1, unit_price=to_cents(amt), account_id=acc["4-2000"],
                                 tax_code_id=tc["GST"])]
        L.save_document(db, "sale", dict(contact_id=cust, date=day(-1)), line(50), "quote")
        old = L.save_document(db, "sale", dict(contact_id=cust, date=day(-40), due_date=day(-10)), line(100), "open")
        new = L.save_document(db, "sale", dict(contact_id=cust, date=day(0), due_date=day(14)), line(200), "open")
        L.record_payment(db, "in", cust, acc["1-1110"], day(0), [(new, to_cents(120))], "EFT 1")
        L.save_document(db, "sale", dict(contact_id=cust, date=day(-2), kind="credit"), line(10), "open")
        L.save_document(db, "purchase", dict(contact_id=sup, date=day(-20), due_date=day(-1)),
                        [dict(description="Power", qty=1, unit_price=to_cents(300), account_id=acc["6-1300"],
                              tax_code_id=tc["GST"])], "open")
        db.commit()
        return cust, sup, old, new


# ------------------------------------------------------------------ the customer page

def test_customer_page_is_one_timeline_with_totals(app):
    cust, sup, old, new = books(app)
    c = login(app)
    page = c.get(f"/cards/view/{cust}").get_data(as_text=True)
    for what in ("Quote Q", "Invoice INV", "Credit note CN", "Payment received", "Everything with Bayside Cafe"):
        assert what in page, what
    # owed now: 110 + 220 - 120 paid - 11 credit; paid this year: the 120 payment; last contact today
    assert "Owes you now" in page and "$199.00" in page and "$110.00 overdue" in page
    assert "Paid you this year" in page and "$120.00" in page
    assert "Last contact" in page and TODAY.isoformat() in page
    # newest first: the payment and invoice of today come before the 40-day-old invoice
    assert page.index("Payment received") < page.index(f"{day(-40)}")
    # filter to payments only
    pays = c.get(f"/cards/view/{cust}?show=pay").get_data(as_text=True)
    assert "Payment received" in pays and "Invoice INV" not in pays
    # the supplier's page works the same way, from the other side
    sp = c.get(f"/cards/view/{sup}").get_data(as_text=True)
    assert "You owe now" in sp and "Bill BILL" in sp and "$330.00" in sp


def test_notes_and_follow_ups_show_on_today_until_done(app):
    cust, *_ = books(app)
    c = login(app)
    r = c.post(f"/cards/view/{cust}/note", data={"note": "", "date": day(0)}, follow_redirects=True,
               headers={"Referer": f"/cards/view/{cust}"})
    assert "Write the note first" in r.get_data(as_text=True)
    c.post(f"/cards/view/{cust}/note", data={"note": "Rang about the overdue invoice.", "date": day(-3)})
    c.post(f"/cards/view/{cust}/note", data={"note": "Call back about the quote", "date": day(0),
                                             "follow_up_on": day(0)})
    c.post(f"/cards/view/{cust}/note", data={"note": "Check in next month", "date": day(0), "follow_up_on": day(30)})
    page = c.get(f"/cards/view/{cust}").get_data(as_text=True)
    assert "Rang about the overdue invoice." in page and "Administrator" in page   # who wrote it
    assert "Call back on" in page and day(30) in page
    today = c.get("/").get_data(as_text=True)
    assert "Follow-ups due" in today and "Call back about the quote" in today
    assert "Check in next month" not in today                                      # not due yet
    nid = one(app, "SELECT id FROM contact_notes WHERE note LIKE 'Call back%'")["id"]
    c.post(f"/cards/view/{cust}/note/{nid}/done", data={"back": "today"})
    assert one(app, "SELECT done_at FROM contact_notes WHERE id=?", nid)["done_at"]
    assert "Call back about the quote" not in c.get("/").get_data(as_text=True)
    notes = c.get(f"/cards/view/{cust}?show=notes").get_data(as_text=True)
    assert "Follow-up done" in notes and "Invoice INV" not in notes
    # last contact follows the newest note (or anything else)
    assert one(app, "SELECT COUNT(*) n FROM contact_notes")["n"] == 3


def test_sales_staff_note_customers_not_suppliers(app):
    cust, sup, *_ = books(app)
    s = add_user(app, "sam", "sales")
    s.post(f"/cards/view/{cust}/note", data={"note": "Dropped in", "date": day(0), "follow_up_on": day(-1)})
    assert one(app, "SELECT COUNT(*) n FROM contact_notes WHERE contact_id=?", cust)["n"] == 1
    s.post(f"/cards/view/{sup}/note", data={"note": "Nope", "date": day(0)})
    assert one(app, "SELECT COUNT(*) n FROM contact_notes WHERE contact_id=?", sup)["n"] == 0  # purchases hidden
    # a note of someone else's can't be deleted by sales staff (no Full access)
    a = login(app)
    a.post(f"/cards/view/{cust}/note", data={"note": "Owner's note", "date": day(0)})
    nid = one(app, "SELECT id FROM contact_notes WHERE note=?", "Owner's note")["id"]
    s.post(f"/cards/view/{cust}/note/{nid}/delete")
    assert one(app, "SELECT COUNT(*) n FROM contact_notes WHERE id=?", nid)["n"] == 1
    mine = one(app, "SELECT id FROM contact_notes WHERE note='Dropped in'")["id"]
    s.post(f"/cards/view/{cust}/note/{mine}/delete")
    assert one(app, "SELECT COUNT(*) n FROM contact_notes WHERE id=?", mine)["n"] == 0


# ------------------------------------------------------------------ Today

def test_today_is_the_home_screen(app):
    cust, sup, old, new = books(app)
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        db.execute("INSERT INTO items (sku, name, is_inventoried, qty_on_hand, reorder_level, asset_account_id)"
                   " VALUES ('LOW','Water filter',1,1,5,?)", (acc["1-1300"],))
        db.commit()
    page = login(app).get("/").get_data(as_text=True)
    for card in ("<h1>Today</h1>", "Today's sales", "Money in this week", "Customers owe you", "Unpaid invoices",
                 "Bills due", "Low stock", "Water filter", "Follow-ups due", "Expense claims to approve"):
        assert card in page, card
    assert "$220.00" in page            # today's sale
    assert "$120.00" in page            # money in this week
    # overdue first in the unpaid list
    unpaid = page.split("Unpaid invoices")[1]
    assert unpaid.index("overdue, was due") < unpaid.index(f"due {day(14)}")
    assert "Business overview" in page
    assert "Income YTD" in login(app).get("/overview").get_data(as_text=True)   # the old dashboard is still there


def test_today_shows_only_what_each_user_and_app_has(app, tmp_path, monkeypatch):
    books(app)
    s = add_user(app, "sam", "sales")
    page = s.get("/").get_data(as_text=True)
    assert "Unpaid invoices" in page and "Customers owe you" in page
    for gone in ("Bills due", "You owe suppliers", "Expense claims to approve", "Income YTD"):
        assert gone not in page, gone
    # Riyeser POS keeps the till as the home screen; Today is one tap away, with the till's cards only
    (tmp_path / "pos").mkdir()
    pos_app, pc, _ = make(tmp_path / "pos", monkeypatch, "pos")
    assert pc.get("/").headers["Location"].endswith("/pos/")
    t = pc.get("/today").get_data(as_text=True)
    assert "Today's sales" in t and "Bills due" not in t and "Expense claims" not in t


# ------------------------------------------------------------------ expense claims

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def claim(c, **kw):
    data = {"date": day(-1), "supplier": "Fuel Station", "amount": "110.00", "gst": "10.00", "note": "Van fuel"}
    with c.application.app_context():
        data["account_id"] = str(get_db().execute("SELECT id FROM accounts WHERE code='6-1800'").fetchone()[0])
    data.update(kw)
    if "receipt" not in data:
        data["receipt"] = (io.BytesIO(PNG), "receipt.png", "image/png")
    return c.post("/expenses/new", data=data, content_type="multipart/form-data", follow_redirects=True)


def test_staff_claim_and_manager_approves_as_a_bill(app):
    s = add_user(app, "jamie", "sales", "Jamie Example")
    assert "Expense claims" in s.get("/").get_data(as_text=True)
    assert "sent" in claim(s).get_data(as_text=True)
    x = one(app, "SELECT * FROM expense_claims")
    assert x["claimant"] == "Jamie Example" and x["status"] == "waiting" and x["amount"] == 11000 and x["gst"] == 1000
    r = s.get(f"/expenses/{x['id']}/receipt")
    assert r.data == PNG and r.mimetype == "image/png"
    # staff can't approve
    s.post(f"/expenses/{x['id']}/decide", data={"action": "approve", "pay_how": "bill"})
    assert one(app, "SELECT status FROM expense_claims")["status"] == "waiting"
    # the manager sees it waiting, on Today too
    a = login(app)
    assert "Jamie Example" in a.get("/expenses/?show=waiting").get_data(as_text=True)
    assert "1 claim for $110.00 is waiting" in a.get("/").get_data(as_text=True)
    page = a.post(f"/expenses/{x['id']}/decide", data={"action": "approve", "pay_how": "bill"},
                  follow_redirects=True).get_data(as_text=True)
    assert "is owed to Jamie Example" in page
    x = one(app, "SELECT * FROM expense_claims")
    assert x["status"] == "approved" and x["pay_how"] == "bill"
    bill = one(app, "SELECT d.*, c.name, c.kind ckind FROM documents d JOIN contacts c ON c.id=d.contact_id WHERE d.id=?",
               x["document_id"])
    assert (bill["name"], bill["ckind"], bill["side"], bill["total"], bill["tax_total"]) == \
        ("Jamie Example", "supplier", "purchase", 11000, 1000)
    with app.app_context():
        db = get_db()
        acc, _ = ids(db)
        tb = db.execute("SELECT SUM(debit), SUM(credit) FROM journal_lines").fetchone()
        assert tb[0] == tb[1]
        gst = db.execute("SELECT SUM(debit-credit) FROM journal_lines WHERE account_id=?", (acc["2-1330"],)).fetchone()[0]
        exp = db.execute("SELECT SUM(debit-credit) FROM journal_lines WHERE account_id=?", (acc["6-1800"],)).fetchone()[0]
        assert (gst, exp) == (1000, 10000)
        # paying the bill under Pay bills makes the claim Paid
        L.record_payment(db, "out", bill["contact_id"], acc["1-1110"], day(0), [(bill["id"], 11000)])
        db.commit()
    assert "Fuel Station" in a.get("/expenses/?show=paid").get_data(as_text=True)
    assert one(app, "SELECT status FROM expense_claims")["status"] == "paid"
    # a second claim from the same person goes on the same supplier card
    claim(s, amount="22", gst="2")
    xid = one(app, "SELECT MAX(id) m FROM expense_claims")["m"]
    a.post(f"/expenses/{xid}/decide", data={"action": "approve", "pay_how": "bill"})
    assert one(app, "SELECT COUNT(*) n FROM contacts WHERE name='Jamie Example'")["n"] == 1


def test_paid_from_bank_part_gst_and_decline(app):
    s = add_user(app, "casey", "sales", "Casey Placeholder")
    a = login(app)
    # $86.90 with only $5.00 GST on it: $55 has GST, the rest is GST free, so the books get exactly $5.00
    claim(s, amount="86.90", gst="5.00")
    xid = one(app, "SELECT id FROM expense_claims")["id"]
    r = a.post(f"/expenses/{xid}/decide", data={"action": "approve", "pay_how": "bank"}, follow_redirects=True,
               headers={"Referer": f"/expenses/{xid}"})
    assert "Choose the bank account" in r.get_data(as_text=True)
    bank = one(app, "SELECT id FROM accounts WHERE code='1-1110'")["id"]
    a.post(f"/expenses/{xid}/decide", data={"action": "approve", "pay_how": "bank", "bank_account_id": bank,
                                            "paid_on": day(0)})
    x = one(app, "SELECT * FROM expense_claims WHERE id=?", xid)
    assert x["status"] == "paid" and x["entry_id"]
    with app.app_context():
        db = get_db()
        acc, _ = ids(db)
        lines = {r["account_id"]: r["debit"] - r["credit"] for r in
                 db.execute("SELECT account_id, SUM(debit) debit, SUM(credit) credit FROM journal_lines WHERE entry_id=?"
                            " GROUP BY account_id", (x["entry_id"],))}
        assert lines[acc["2-1330"]] == 500 and lines[acc["6-1800"]] == 8190 and lines[bank] == -8690
    # GST more than 1/11 is refused
    assert "GST can&#39;t be more than" in claim(s, amount="11", gst="5").get_data(as_text=True)
    # decline needs a reason, and the staff member sees it
    claim(s, amount="27", gst="2.45")
    xid = one(app, "SELECT MAX(id) m FROM expense_claims")["m"]
    assert "Say why" in a.post(f"/expenses/{xid}/decide", data={"action": "decline", "reason": ""}, follow_redirects=True,
               headers={"Referer": f"/expenses/{xid}"}).get_data(as_text=True)
    a.post(f"/expenses/{xid}/decide", data={"action": "decline", "reason": "No receipt for this one"})
    assert one(app, "SELECT status FROM expense_claims WHERE id=?", xid)["status"] == "declined"
    assert "No receipt for this one" in s.get("/expenses/?show=declined").get_data(as_text=True)
    assert "Waiting" in s.get("/expenses/").get_data(as_text=True)


def test_who_can_see_and_approve(app):
    s = add_user(app, "sam", "sales", "Sam Staff")
    t = add_user(app, "tia", "sales", "Tia Staff")
    b = add_user(app, "bea", "bookkeeper", "Bea Books")
    claim(s)
    xid = one(app, "SELECT id FROM expense_claims")["id"]
    # other staff can't see someone else's claim or its receipt
    assert "Fuel Station" not in t.get("/expenses/?show=all").get_data(as_text=True)
    assert t.get(f"/expenses/{xid}").status_code == 302 and t.get(f"/expenses/{xid}/receipt").status_code == 302
    # a bookkeeper (Full) approves others' claims, but not their own
    claim(b, supplier="Own Claim")
    own = one(app, "SELECT id FROM expense_claims WHERE supplier='Own Claim'")["id"]
    r = b.post(f"/expenses/{own}/decide", data={"action": "approve", "pay_how": "bill"}, follow_redirects=True,
               headers={"Referer": f"/expenses/{own}"})
    assert "Someone else needs to approve" in r.get_data(as_text=True)
    b.post(f"/expenses/{xid}/decide", data={"action": "approve", "pay_how": "bill"})
    assert one(app, "SELECT status FROM expense_claims WHERE id=?", xid)["status"] == "approved"
    # read-only users can look at their own list but not claim
    r = add_user(app, "rita", "readonly")
    assert r.get("/expenses/").status_code == 200
    claim(r)
    assert one(app, "SELECT COUNT(*) n FROM expense_claims")["n"] == 2
    # withdraw a claim that's still waiting
    claim(t, supplier="Withdraw me")
    w = one(app, "SELECT id FROM expense_claims WHERE supplier='Withdraw me'")["id"]
    t.post(f"/expenses/{w}/withdraw")
    assert one(app, "SELECT COUNT(*) n FROM expense_claims WHERE id=?", w)["n"] == 0


def test_older_saved_permissions_get_expense_levels(app):
    from riyeser import perms
    with app.app_context():
        u = {"role": "accountant", "perms": json.dumps({"sales": 2, "purchases": 0}), "id": 9}
        assert perms.levels_for(u)["expenses"] == perms.EDIT       # may claim their own
        u["perms"] = json.dumps({"sales": 3, "purchases": 3})
        assert perms.levels_for(u)["expenses"] == perms.FULL       # Full on bills: approves claims too


def test_receipt_must_be_a_photo_or_pdf(app):
    s = add_user(app, "sam", "sales")
    r = claim(s, receipt=(io.BytesIO(b"<html>"), "x.html", "text/html"))
    assert "photo (JPG, PNG, HEIC) or a PDF" in r.get_data(as_text=True)
    assert one(app, "SELECT COUNT(*) n FROM expense_claims")["n"] == 0


@pytest.mark.parametrize("edition,home", [("invoices", "/setup/accounting-basics"), ("bookings", "/bookings/"),
                                          ("pos", "/pos/")])
def test_expense_claims_are_basics_and_plus_only(tmp_path, monkeypatch, edition, home):
    app, c, _ = make(tmp_path, monkeypatch, edition)
    r = c.get("/expenses/")
    assert r.status_code == 302 and r.headers["Location"].endswith(home)


@pytest.mark.parametrize("edition", ["basics", "plus"])
def test_expense_claims_in_basics_and_plus(tmp_path, monkeypatch, edition):
    app, c, _ = make(tmp_path, monkeypatch, edition)
    assert c.get("/expenses/").status_code == 200
    assert "Expense claims" in c.get("/").get_data(as_text=True)


def test_demo_shows_the_new_screens(tmp_path):
    from riyeser.demo import seed_demo
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "d.db")})
    with app.app_context():
        init_db("Demo")
        seed_demo(get_db())
        db = get_db()
        assert {r[0] for r in db.execute("SELECT status FROM expense_claims")} == {"waiting", "approved", "paid",
                                                                                    "declined"}
        tb = db.execute("SELECT SUM(debit), SUM(credit) FROM journal_lines").fetchone()
        assert tb[0] == tb[1]
        cust = db.execute("SELECT id FROM contacts WHERE name='Bayside Cafe Group'").fetchone()[0]
    c = login(app)
    today = c.get("/").get_data(as_text=True)
    assert "Asked for a quote on two more" in today and "Today's bookings" in today and "2 claims for" in today
    page = c.get(f"/cards/view/{cust}").get_data(as_text=True)
    assert "Rang Sam about the overdue invoice" in page and "Booking" in page
    assert c.get("/expenses/1/receipt").mimetype == "application/pdf"
