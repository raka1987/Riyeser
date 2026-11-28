"""Screen labels follow the company's country and tax settings (riyeser/countries.py labels and bank_labels):
the tax name (GST, VAT, Sales tax or none), the tax number label, prices including / excluding tax, and the bank
fields (BSB in Australia, one account number in New Zealand, bank / branch / SWIFT / IBAN elsewhere).

A company file that never chose a country keeps the Australian wording exactly as before."""
import re

import pytest

from riyeser import create_app, countries as C
from riyeser.db import get_db, init_db
from tests.test_bookings_app import _book, _one
from tests.test_country_tax import review_form

TAG = re.compile(r"<script\b.*?</script>|<style\b.*?</style>|<[^>]+>", re.S)


def visible(html):
    """The words a person sees (no markup, scripts, styles, field names or ids)."""
    return re.sub(r"\s+", " ", TAG.sub(" ", html)).replace("&amp;", "&").replace("&#39;", "'")


def choose(app, c, cc):
    with app.app_context():
        form = review_form(cc, get_db())
    r = c.post("/setup/country/review", data=form, follow_redirects=True)
    assert r.status_code == 200
    with app.app_context():
        assert get_db().execute("SELECT country FROM company").fetchone()[0] == cc


def company_file(tmp_path, monkeypatch, cc, edition=None):
    """A company file made for this country, as first-run set-up makes it (its own tax codes and tax account
    names), with the country's settings confirmed. cc None: a file that never chose a country (Australian)."""
    tmp_path.mkdir(exist_ok=True)
    if edition:
        monkeypatch.setenv("RIYESER_APP_EDITION", edition)
    else:
        monkeypatch.delenv("RIYESER_APP_EDITION", raising=False)
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "t.db")})
    with app.app_context():
        p = C.preset(cc) if cc else None
        init_db("Synthetic Traders", tax_codes=C.seed_codes(cc) if cc else None,
                tax_name=(p["tax_name"] or "Tax") if p else None)
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    if cc:
        choose(app, c, cc)
    return app, c


def accounting_pages(tmp_path, monkeypatch, cc):
    app, c = company_file(tmp_path / "acc", monkeypatch, cc)
    pages = {}
    for name, url in (("product", "/inventory/new"), ("reports", "/reports/"), ("invoice", "/sale/new"),
                      ("branding", "/setup/branding/"), ("journal", "/journal/new"), ("employee", "/payroll/employee/new"),
                      ("expense", "/expenses/new"), ("upgrade", "/editions"), ("invoices_upgrade", "/setup/accounting-basics"), ("users", "/users"),
                      ("company", "/setup/company"), ("help", "/help/")):
        r = c.get(url)
        if r.status_code == 200:
            pages[name] = r.get_data(as_text=True)
    return app, c, pages


def booking_pages(tmp_path, monkeypatch, cc):
    app, c = company_file(tmp_path / "bk", monkeypatch, cc, edition="bookings")
    c.post("/bookings/setup/starters")                  # the suggested staff and job types
    with app.app_context():
        db = get_db()
        cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','Synthetic Customer')").lastrowid
        db.commit()
    staff = _one(app, "SELECT id FROM booking_resources")["id"]
    svc = _one(app, "SELECT id FROM booking_services WHERE name='Call-out'")["id"]
    _book(c, contact_id=cust, resource_id=staff, service_id=svc, address="1 Main St")
    bid = _one(app, "SELECT id FROM bookings ORDER BY id DESC")["id"]
    jid = _one(app, "SELECT job_id FROM bookings WHERE id=?", (bid,))["job_id"]
    c.post(f"/bookings/job/{jid}", data={"contact_id": cust, "billing": "fixed", "address": "1 Main St",
                                         "service_id": svc, "price": "150"})
    pages = {"setup": c.get("/bookings/setup").get_data(as_text=True),
             "job": c.get(f"/bookings/job/{jid}").get_data(as_text=True),
             "site": c.get(f"/bookings/{bid}/site").get_data(as_text=True)}
    return pages


# country: (must appear, per screen) — and nothing Australian ("GST", "BSB", "ABN", "BAS") outside Australia
EXPECT = {
    "AU": {"product": ["Selling price (ex GST)", "Buying price (ex GST)"],
           "job": ["(fixed price jobs, inc GST)", "Total (including GST)"],
           "site": ["(inc GST, optional)", "Total (including GST)"],
           "setup": ["Hourly labour rate (including GST)"],
           "reports": ["BAS / GST Summary"], "branding": ["ABN", "BSB", "Account number"],
           "journal": ["This is a GST adjustment (lets the journal use the GST accounts)"],
           "invoice": ["Prices include GST"], "employee": ["BSB"]},
    "NZ": {"product": ["Selling price (excl. GST)"], "job": ["(fixed price jobs, incl. GST)", "Total (including GST)"],
           "site": ["(incl. GST, optional)"], "setup": ["Hourly labour rate (including GST)"],
           "reports": ["GST return summary"], "branding": ["IRD / GST number", "Account number"],
           "journal": ["This is a GST adjustment"], "invoice": ["Prices include GST"]},
    "FJ": {"product": ["Selling price (excl. VAT)", "Buying price (excl. VAT)"],
           "job": ["(fixed price jobs, incl. VAT)", "Total (including VAT)"],
           "site": ["(incl. VAT, optional)", "Total (including VAT)"], "setup": ["Hourly labour rate (including VAT)"],
           "reports": ["VAT return summary", "VAT Detail by Tax Code"], "upgrade": ["Profit & Loss, VAT summary"],
           "invoices_upgrade": ["Profit & Loss, VAT summary, sales"],
           "branding": ["TIN", "Bank name", "Branch / sort code", "Account number", "SWIFT / BIC"],
           "journal": ["This is a VAT adjustment (lets the journal use the VAT accounts)"],
           "invoice": ["Prices include VAT"], "employee": ["Branch / sort code"]},
    "US": {"product": ["Selling price (excl. sales tax)"], "job": ["(fixed price jobs, incl. sales tax)",
                                                                  "Total (including sales tax)"],
           "site": ["(incl. sales tax, optional)"], "setup": ["Hourly labour rate (including sales tax)"],
           "reports": ["Sales tax summary"], "branding": ["EIN", "Routing number (ABA)", "SWIFT / BIC"],
           "journal": ["This is a sales tax adjustment"], "invoice": ["Prices include sales tax"]},
    "HK": {"product": ["Selling price", "Buying price"], "job": ["(fixed price jobs)", "Total"],
           "site": ["(optional)"], "setup": ["Hourly labour rate"], "reports": ["Tax summary"],
           "branding": ["Business registration number", "Bank name", "SWIFT / BIC"],
           "journal": ["This is a tax adjustment"], "invoices_upgrade": ["Profit & Loss, sales"]},
}
# no tax: never "including None", "incl. tax", "(ex tax)"...
NO_TAX_WORDING = ["(including", "incl.", "excl.", "inc GST", "ex GST", "None"]
AU_WORDS = re.compile(r"\b(GST|BSB|ABN|BAS)\b")


@pytest.mark.parametrize("cc", ["AU", "NZ", "FJ", "US", "HK"])
def test_key_screens_follow_the_country(tmp_path, monkeypatch, cc):
    _, _, acc = accounting_pages(tmp_path, monkeypatch, cc)
    bk = booking_pages(tmp_path, monkeypatch, cc)
    pages = {**acc, **bk}
    for need in ("product", "reports", "invoice", "branding", "journal", "employee", "expense", "users", "help",
                 "company", "upgrade", "invoices_upgrade", "setup", "job", "site"):
        assert need in pages, need
    for screen, wanted in EXPECT[cc].items():
        text = visible(pages[screen])
        for w in wanted:
            assert w in text, (cc, screen, w)
    for screen, html in pages.items():
        text = visible(html)
        if cc not in ("AU", "NZ"):     # NZ's tax is GST too; its tax number and bank fields aren't Australian
            hits = sorted(set(AU_WORDS.findall(text)))
            assert not hits, (cc, screen, hits, [text[max(0, m.start() - 60):m.end() + 60]
                                                 for m in AU_WORDS.finditer(text)][:3])
        elif cc == "NZ":
            for w in ("BSB", "ABN", "BAS"):
                assert not re.search(rf"\b{w}\b", text), (cc, screen, w)
        if cc == "HK":
            for w in NO_TAX_WORDING:
                assert w not in text, (screen, w)
    if cc == "FJ":       # Fiji doesn't use an IBAN
        assert "IBAN" not in visible(pages["branding"])


def test_no_country_keeps_the_australian_wording_exactly(tmp_path, monkeypatch):
    _, _, acc = accounting_pages(tmp_path, monkeypatch, None)
    bk = booking_pages(tmp_path, monkeypatch, None)
    for screen, wanted in EXPECT["AU"].items():
        text = visible({**acc, **bk}[screen])
        for w in wanted:
            assert w in text, (screen, w)
    assert "Profit & Loss, GST summary, who owes you" in visible(acc["upgrade"])
    assert "Profit & Loss, GST summary, sales" in visible(acc["invoices_upgrade"])


def test_labels_helper():
    legacy = C.labels({})
    assert (legacy["tax"], legacy["incl"], legacy["inc"], legacy["ex"], legacy["summary"]) == \
        ("GST", "including GST", "inc GST", "ex GST", "GST summary")
    fj = C.labels({"country": "FJ", "tax_name": "VAT", "tax_id_label": "TIN"})
    assert (fj["incl"], fj["inc"], fj["ex"], fj["tax_id"], fj["word"]) == \
        ("including VAT", "incl. VAT", "excl. VAT", "TIN", "VAT")
    us = C.labels({"country": "US", "tax_name": "Sales tax"})
    assert (us["tax"], us["word"], us["inc"]) == ("Sales tax", "sales tax", "incl. sales tax")
    hk = C.labels({"country": "HK", "tax_name": "None"})
    assert not hk["has_tax"] and hk["incl"] == hk["inc"] == hk["ex"] == hk["summary"] == ""
    assert C.bank_labels({})["branch"] == "BSB" and C.bank_labels({"country": "AU"})["scheme"] == "au"
    nz = C.bank_labels({"country": "NZ"})
    assert nz["branch"] is None and "suffix" in nz["account_hint"]
    assert C.bank_labels({"country": "FJ"})["iban"] is None and C.bank_labels({"country": "FJ"})["swift"]
    assert C.bank_labels({"country": "DE"})["iban"] == "IBAN" and C.bank_labels({"country": "GB"})["branch"] == "Sort code"


def test_bank_details_save_and_print_for_each_country(tmp_path, monkeypatch):
    from riyeser.statements import payment_details
    app, c = company_file(tmp_path, monkeypatch, None)
    base = {"name": "Synthetic Traders", "bank_account_name": "Synthetic Traders", "bank_name": "Example Bank",
            "bank_bsb": "062-000", "bank_account_no": "1234 5678"}
    c.post("/setup/branding/", data=base)
    with app.app_context():
        co = get_db().execute("SELECT * FROM company").fetchone()
        assert "BSB 062-000" in payment_details(co)[0]           # Australian, as before
    choose(app, c, "DE")
    page = visible(c.get("/setup/branding/").get_data(as_text=True))
    assert "IBAN" in page and "SWIFT / BIC" in page and "BSB" not in page
    c.post("/setup/branding/", data=dict(base, bank_swift="EXAMDEFFXXX", bank_iban="DE00 0000 0000 0000 0000 00"))
    with app.app_context():
        co = get_db().execute("SELECT * FROM company").fetchone()
        line = payment_details(co)[0]
        assert "BSB" not in line and "Branch / sort code 062-000" in line
        assert "SWIFT/BIC EXAMDEFFXXX" in line and "IBAN DE00" in line
    # New Zealand: one account number; a branch code already saved is still shown (never lost)
    choose(app, c, "NZ")
    page = visible(c.get("/setup/branding/").get_data(as_text=True))
    assert "Bank / branch code" in page and "BSB" not in page
    c.post("/setup/branding/", data=dict(base, bank_bsb="", bank_account_no="12-3456-0123456-00"))
    page = visible(c.get("/setup/branding/").get_data(as_text=True))
    assert "Bank / branch code" not in page and "Account number" in page
    with app.app_context():
        co = get_db().execute("SELECT * FROM company").fetchone()
        assert "Account 12-3456-0123456-00" in payment_details(co)[0]
        assert co["bank_swift"] == "EXAMDEFFXXX"      # kept, though New Zealand doesn't ask for it


def test_bank_columns_are_added_once(tmp_path, monkeypatch):
    app, c = company_file(tmp_path, monkeypatch, None)
    with app.app_context():
        db = get_db()
        C.ensure_bank_schema(db)
        C.ensure_bank_schema(db)
        cols = [r["name"] for r in db.execute("PRAGMA table_info(company)")]
        assert cols.count("bank_swift") == 1 and cols.count("bank_iban") == 1 and "bank_bsb" in cols


def test_tax_words_in_messages_and_the_books(tmp_path, monkeypatch):
    from riyeser import ledger as L
    app, c = company_file(tmp_path, monkeypatch, None)
    choose(app, c, "FJ")
    with app.app_context():
        db = get_db()
        assert L.tax_word(db) == "VAT"
        gst_acc = db.execute("SELECT account_id FROM linked_accounts WHERE key='gst_collected'").fetchone()[0]
        with pytest.raises(L.PostingError) as e:
            L.check_journal_lines(db, [dict(account_id=gst_acc, debit=100)])
        assert "VAT" in str(e.value) and "GST" not in str(e.value)
    page = visible(c.get("/expenses/new").get_data(as_text=True))
    assert "GST" not in page
