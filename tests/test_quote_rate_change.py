"""A quote made before a tax rate change (Country and tax: "Change my GST code to 15% for new transactions"):
converting it asks first, the three choices give the right invoice, the quote never changes, and the books balance."""
import pytest

from riyeser import create_app, countries as C, quote_options as QO
from riyeser.db import get_db, init_db
from riyeser import ledger as L
from tests.test_qa_apps import books_consistent, ids, TODAY


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.delenv("RIYESER_APP_EDITION", raising=False)
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "q.db")})
    with app.app_context():
        init_db("Rate Change Co")
    return app


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return c


# awkward amounts on purpose: 3 x $3.33, 7 x $9.99 less 12.5%, and a plain $850 line
LINES = [dict(description="Consulting", qty=3, unit_price=333), dict(description="Widgets", qty=7, unit_price=999,
                                                                   discount_pct=12.5),
         dict(description="Fit-out labour", qty=1, unit_price=85000)]


def make_quote(db, incl=False, lines=LINES):
    acc, tc = ids(db)
    cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','Synthetic Customer')").lastrowid
    q = L.save_document(db, "sale", dict(contact_id=cust, date=TODAY, tax_inclusive=incl),
                        [dict(l, account_id=acc["4-2000"], tax_code_id=tc["GST"]) for l in lines], "quote")
    db.commit()
    return q


def raise_rate(db):
    C.change_rate(db, "GST", 15.0, "admin")   # GST 10% becomes GST10 (not in use), new GST 15%
    db.commit()


def snap(db, q):
    return ([tuple(r) for r in db.execute("SELECT * FROM documents WHERE id=?", (q,))],
            [tuple(r) for r in db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (q,))],
            [tuple(r) for r in db.execute("SELECT * FROM document_options WHERE document_id=? ORDER BY n", (q,))])


def invoices(db):
    return [dict(r) for r in db.execute("SELECT * FROM documents WHERE side='sale' AND status='open' ORDER BY id")]


def codes_on(db, doc):
    return {r[0] for r in db.execute("SELECT t.code FROM document_lines l JOIN tax_codes t ON t.id=l.tax_code_id"
                                     " WHERE l.document_id=?", (doc,))}


def ask(client, q):
    r = client.post(f"/document/{q}/convert", data={"to": "open"})
    return r.status_code, r.get_data(as_text=True)


def test_no_panel_when_the_quotes_codes_are_unchanged(app, client):
    with app.app_context():
        q = make_quote(get_db())
    r = client.post(f"/document/{q}/convert", data={"to": "open"})
    assert r.status_code == 302                                   # straight to the new invoice, as before
    with app.app_context():
        db = get_db()
        inv = invoices(db)
        assert len(inv) == 1 and codes_on(db, inv[0]["id"]) == {"GST"}
        assert not db.execute("SELECT 1 FROM audit_log WHERE action='quote_rate_choice'").fetchone()
        assert not books_consistent(db)


def test_current_rate_adding_the_extra_tax(app, client):
    with app.app_context():
        db = get_db()
        q = make_quote(db)
        raise_rate(db)
        before = snap(db, q)
        quote = dict(db.execute("SELECT * FROM documents WHERE id=?", (q,)).fetchone())
    status, page = ask(client, q)
    assert status == 200 and "The GST rate has changed since this quote." in page
    assert "Use the current rate (15%)" in page and "Keep the quoted rate (10%)" in page
    with app.app_context():
        db = get_db()
        assert invoices(db) == [] and snap(db, q) == before       # the panel created nothing
        sub = quote["subtotal"]
        expect_tax = sum(round(l * 0.15) for l in [r[0] for r in db.execute(
            "SELECT net_amount FROM document_lines WHERE document_id=?", (q,))])
    assert C.format_money(sub + expect_tax) in page               # the total shown next to the option
    client.post(f"/document/{q}/convert", data={"to": "open", "rate_choice": "current", "rate_how": "add"})
    with app.app_context():
        db = get_db()
        inv = invoices(db)[0]
        assert inv["subtotal"] == sub and inv["tax_total"] == expect_tax and inv["total"] == sub + expect_tax
        assert codes_on(db, inv["id"]) == {"GST"} and not inv["tax_inclusive"]
        assert snap(db, q)[1:] == before[1:]                       # the quote's lines never change
        a = db.execute("SELECT details FROM audit_log WHERE action='quote_rate_choice'").fetchone()[0]
        assert "added the extra GST" in a and inv["number"] in a
        assert not books_consistent(db)


def test_current_rate_keeping_the_customers_total_exactly(app, client):
    with app.app_context():
        db = get_db()
        q = make_quote(db)
        quote_total = db.execute("SELECT total FROM documents WHERE id=?", (q,)).fetchone()[0]
        raise_rate(db)
        before = snap(db, q)
    status, page = ask(client, q)
    assert "total the same" in page and C.format_money(quote_total) in page
    client.post(f"/document/{q}/convert", data={"to": "open", "rate_choice": "current", "rate_how": "same_total"})
    with app.app_context():
        db = get_db()
        inv = invoices(db)[0]
        assert inv["total"] == quote_total                        # exact, to the cent
        assert inv["tax_inclusive"] == 1 and codes_on(db, inv["id"]) == {"GST"}
        assert inv["tax_total"] == sum(round(g * 15 / 115) for g in [r[0] for r in db.execute(
            "SELECT net_amount + tax_amount FROM document_lines WHERE document_id=?", (inv["id"],))])
        assert inv["subtotal"] + inv["tax_total"] == quote_total
        assert snap(db, q)[1:] == before[1:]
        assert "kept the customer's total the same" in db.execute(
            "SELECT details FROM audit_log WHERE action='quote_rate_choice'").fetchone()[0]
        assert not books_consistent(db)


@pytest.mark.parametrize("lines", [
    [dict(description="A", qty=3, unit_price=333), dict(description="B", qty=7, unit_price=999, discount_pct=12.5)],
    [dict(description="A", qty=0.333, unit_price=10001)],
    [dict(description="A", qty=1, unit_price=1), dict(description="B", qty=2.5, unit_price=4999, discount_pct=3)],
])
def test_keeping_the_total_is_exact_even_without_an_easy_line(app, client, lines):
    with app.app_context():
        db = get_db()
        q = make_quote(db, lines=lines)
        total = db.execute("SELECT total FROM documents WHERE id=?", (q,)).fetchone()[0]
        raise_rate(db)
    client.post(f"/document/{q}/convert", data={"to": "open", "rate_choice": "current", "rate_how": "same_total"})
    with app.app_context():
        db = get_db()
        assert invoices(db)[0]["total"] == total
        assert not books_consistent(db)


def test_keeping_the_quoted_rate(app, client):
    with app.app_context():
        db = get_db()
        q = make_quote(db)
        quote = dict(db.execute("SELECT * FROM documents WHERE id=?", (q,)).fetchone())
        raise_rate(db)
    client.post(f"/document/{q}/convert", data={"to": "open", "rate_choice": "quoted", "rate_how": "add"})
    with app.app_context():
        db = get_db()
        inv = invoices(db)[0]
        assert (inv["subtotal"], inv["tax_total"], inv["total"]) == (quote["subtotal"], quote["tax_total"], quote["total"])
        assert codes_on(db, inv["id"]) == {"GST10"}
        assert "kept the quoted rate" in db.execute(
            "SELECT details FROM audit_log WHERE action='quote_rate_choice'").fetchone()[0]
        assert not books_consistent(db)


def test_prices_including_tax_add_keeps_the_net(app, client):
    with app.app_context():
        db = get_db()
        q = make_quote(db, incl=True, lines=[dict(description="Job", qty=1, unit_price=11000)])   # $100 + $10
        raise_rate(db)
    client.post(f"/document/{q}/convert", data={"to": "open", "rate_choice": "current", "rate_how": "add"})
    with app.app_context():
        db = get_db()
        inv = invoices(db)[0]
        assert (inv["subtotal"], inv["tax_total"], inv["total"]) == (10000, 1500, 11500)
        assert not books_consistent(db)


def test_the_answer_sent_twice_makes_one_invoice(app, client):
    with app.app_context():
        db = get_db()
        q = make_quote(db)
        raise_rate(db)
    form = {"to": "open", "rate_choice": "current", "rate_how": "add", "_once": "tok-1"}
    for _ in range(2):
        client.post(f"/document/{q}/convert", data=form)
    client.post(f"/document/{q}/convert", data=dict(form, _once="tok-2"))   # even with a new token
    with app.app_context():
        db = get_db()
        assert len(invoices(db)) == 1
        assert db.execute("SELECT COUNT(*) FROM audit_log WHERE action='quote_rate_choice'").fetchone()[0] == 1
        assert not books_consistent(db)


def test_good_better_best_quote(app, client):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        q = make_quote(db, lines=[dict(description="Basic", qty=1, unit_price=50000)])
        line = lambda d, p: dict(description=d, qty=1, unit_price=p, discount_pct=0, account_id=acc["4-2000"],
                                 tax_code_id=tc["GST"])
        QO.save(db, q, [{"name": "Good", "lines": [line("Basic", 50000)]},
                        {"name": "Better", "lines": [line("Better", 80000), line("Extras", 12345)], "recommended": True},
                        {"name": "Best", "lines": [line("Best", 120000)]}])
        QO.choose(db, q, 2)                                       # the customer chose Better: $923.45 + 10%
        db.execute("UPDATE documents SET quote_status='accepted' WHERE id=?", (q,))
        db.commit()
        opts_before = [(o["name"], o["subtotal"], o["tax_total"], o["total"]) for o in QO.of(db, q)]
        raise_rate(db)
        before = snap(db, q)
    status, page = ask(client, q)
    assert status == 200 and "has changed since this quote" in page
    client.post(f"/document/{q}/convert", data={"to": "open", "rate_choice": "current", "rate_how": "add"})
    with app.app_context():
        db = get_db()
        inv = invoices(db)[0]
        assert inv["subtotal"] == 92345 and inv["tax_total"] == 12000 + 1852 and inv["total"] == 92345 + 13852
        assert [r[0] for r in db.execute("SELECT description FROM document_lines WHERE document_id=? ORDER BY id",
                                          (inv["id"],))] == ["Better", "Extras"]
        assert snap(db, q)[1:] == before[1:]                       # the quote and its options are untouched
        assert [(o["name"], o["subtotal"], o["tax_total"], o["total"]) for o in QO.of(db, q)] == opts_before
        assert not books_consistent(db)


def test_bookings_invoicing_a_job_made_from_the_quote_asks_too(app, client):
    with app.app_context():
        db = get_db()
        q = make_quote(db)
        db.execute("INSERT INTO booking_resources (name) VALUES ('Synthetic Staff')")
        db.execute("UPDATE documents SET quote_status='accepted' WHERE id=?", (q,))
        db.commit()
    client.post(f"/document/{q}/quote/job")
    with app.app_context():
        db = get_db()
        jid = db.execute("SELECT booking_job_id FROM documents WHERE id=?", (q,)).fetchone()[0]
        assert jid
        quote_total = db.execute("SELECT total FROM documents WHERE id=?", (q,)).fetchone()[0]
        raise_rate(db)
    r = client.post(f"/bookings/job/{jid}/invoice")
    assert r.status_code == 200 and "has changed since this quote" in r.get_data(as_text=True)
    with app.app_context():
        assert invoices(get_db()) == []
    client.post(f"/bookings/job/{jid}/invoice", data={"rate_choice": "current", "rate_how": "same_total"})
    with app.app_context():
        db = get_db()
        inv = invoices(db)
        assert len(inv) == 1 and inv[0]["total"] == quote_total and codes_on(db, inv[0]["id"]) == {"GST"}
        assert db.execute("SELECT document_id FROM booking_jobs WHERE id=?", (jid,)).fetchone()[0] == inv[0]["id"]
        assert not books_consistent(db)
