"""Country and tax settings (APP-023): choosing a country fills in a starting point that the person checks and
confirms; nothing changes before "Confirm these settings", past documents never change, existing tax codes are kept,
the books still balance, and a company file that never chose a country keeps Riyeser's Australian behaviour."""
import io
import json

import pytest
from pypdf import PdfReader

from riyeser import create_app, countries as C
from riyeser.db import get_db, init_db, migrate
from riyeser import ledger as L
from tests.test_qa_apps import books_consistent, ids, TODAY


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.delenv("RIYESER_APP_EDITION", raising=False)
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "co.db")})
    with app.app_context():
        init_db("Country Test Co")
    return app


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return c


def review_form(cc, db=None, **over):
    """The review screen's form exactly as it comes pre-filled (the person presses Confirm without changing it)."""
    r = C.review(db, cc)
    p = r["p"]
    f = {"country": r["cc"], "add_standard": "1", "report_layout": p["report_layout"] or "generic",
         "tax_name": "" if p["tax_name"] == "None" else (p["tax_name"] or ""),
         "standard_rate": "" if p["standard_rate"] is None else f"{p['standard_rate']:g}",
         "tax_id_label": p["tax_id_label"] or "", "report_name": p["report_name"] or "",
         "tax_office": p["tax_office"] or "", "prices_include_tax": "1" if p["prices_include_tax"] else "0",
         "currency": p["currency"] or "", "currency_symbol": (p["currency_format"] or {}).get("symbol", ""),
         "currency_position": (p["currency_format"] or {}).get("position", "before"),
         "fy_start_month": str(p["fy_start_month"] or ""), "date_format": p["date_format"] or "iso",
         "timezone": r["timezone"] or (r["timezones"][0] if p["timezones"] else "")}
    if p["tax_name"] == "None":
        f["no_tax"] = "1"
    for t in r["codes"]:
        if t["status"] == "add":
            f[f"add_{t['code']}"] = "1"
    f.update(over)
    return f


def company(db):
    return dict(db.execute("SELECT * FROM company WHERE id=1").fetchone())


def codes(db):
    return {r["code"]: (r["rate"], r["kind"]) for r in db.execute("SELECT code, rate, kind FROM tax_codes")}


def sell(db, cust, code, price=10000):
    acc, tc = ids(db)
    return L.save_document(db, "sale", dict(contact_id=cust, date=TODAY),
                           [dict(description="Consulting", qty=1, unit_price=price, account_id=acc["4-2000"],
                                 tax_code_id=tc[code])], "open")


def pdf_text(client, doc):
    r = client.get(f"/document/{doc}?pdf=1")
    assert r.status_code == 200 and r.mimetype == "application/pdf"
    return PdfReader(io.BytesIO(r.data)).pages[0].extract_text()


# ---------------------------------------------------------------- the data file
def test_data_file_lists_every_country_with_an_as_of_date_and_a_source():
    d = C.data()
    assert d["as_of"] and d["sources"]["tax"].startswith("https://")
    cs = d["countries"]
    assert len(cs) >= 249 and {"AU", "NZ", "FJ", "US", "GB", "HK", "DE", "PG"} <= set(cs)
    for cc, e in cs.items():
        assert e["name"] and e["source"], cc
        assert e["currency"] or cc == "AQ", cc
        assert e["date_format"] in ("dmy", "mdy", "iso"), cc
        for t in e["tax_codes"]:
            assert t["kind"] in C.KINDS and 0 <= t["rate"] < 100, (cc, t)
    names = [n for _, n in C.countries()]
    assert names == sorted(names)


def test_presets_populate_correctly():
    au, nz, fj = C.preset("AU"), C.preset("NZ"), C.preset("FJ")
    assert (au["tax_name"], au["tax_id_label"], au["standard_rate"], au["currency"], au["fy_start_month"],
            au["report_name"], au["report_layout"]) == ("GST", "ABN", 10, "AUD", 7, "BAS / GST Summary", "bas")
    assert [c for c, *_ in C.seed_codes("AU")] == ["GST", "CAP", "FRE", "EXP", "INP", "N-T"]
    assert "Australia/Perth" in au["timezones"] and C.review(None, "AU")["timezone"] is None   # asked, not assumed
    assert (nz["tax_name"], nz["tax_id_label"], nz["standard_rate"], nz["currency"], nz["fy_start_month"],
            nz["report_name"]) == ("GST", "IRD / GST number", 15, "NZD", 4, "GST return summary")
    assert {t["code"]: t["rate"] for t in nz["tax_codes"]} == {"GST": 15, "ZER": 0, "EXE": 0}
    assert (fj["tax_name"], fj["tax_id_label"], fj["standard_rate"], fj["currency"], fj["report_name"]) == \
        ("VAT", "TIN", 12.5, "FJD", "VAT return summary")
    assert C.review(None, "FJ")["timezone"] == "Pacific/Fiji" and fj["fy_start_month"] is None   # unsure: blank
    other = C.preset(C.OTHER)
    assert other["tax_name"] is None and other["currency"] is None and other["tax_codes"] == []


def test_us_has_no_national_rate_and_hong_kong_has_no_tax():
    us = C.preset("US")
    assert us["tax_name"] == "Sales tax" and us["standard_rate"] is None and "state" in us["note"]
    assert [t["code"] for t in us["tax_codes"]] == ["EXE"] and us["date_format"] == "mdy"
    hk = C.preset("HK")
    assert hk["tax_name"] == "None" and hk["tax_codes"] == [] and hk["currency"] == "HKD"


# ---------------------------------------------------------------- confirm step
def test_review_saves_nothing_until_confirmed_and_records_who_confirmed(app, client):
    with app.app_context():
        before = company(get_db()), codes(get_db())
    r = client.get("/setup/country/review?country=NZ")
    page = r.get_data(as_text=True)
    assert r.status_code == 200 and "Confirm these settings" in page and "IRD / GST number" in page
    assert "responsible for your tax settings" in page and "Choose your time zone" in page
    assert client.get("/setup/country").status_code == 200
    with app.app_context():
        assert (company(get_db()), codes(get_db())) == before   # looking is not saving
        form = review_form("NZ", get_db(), timezone="Pacific/Auckland")
    r = client.post("/setup/country/review", data=form, follow_redirects=True)
    assert "Country and tax settings saved" in r.get_data(as_text=True)
    with app.app_context():
        db = get_db()
        co = company(db)
        assert (co["country"], co["tax_name"], co["tax_id_label"], co["currency"], co["fy_start_month"],
                co["timezone"], co["date_format"]) == ("NZ", "GST", "IRD / GST number", "NZD", 4, "Pacific/Auckland", "dmy")
        assert co["country_confirmed_by"] == "admin" and co["country_confirmed_at"][:10] == TODAY
        assert db.execute("SELECT 1 FROM audit_log WHERE action='country_settings'").fetchone()


def test_a_viewer_cannot_confirm(app, client):
    with app.app_context():
        db = get_db()
        from werkzeug.security import generate_password_hash
        db.execute("INSERT INTO users (username, password_hash, role) VALUES ('val', ?, 'viewer')",
                   (generate_password_hash("viewer-pass-1"),))
        db.commit()
        form = review_form("NZ", db, timezone="Pacific/Auckland")
    v = app.test_client()
    v.post("/login", data={"username": "val", "password": "viewer-pass-1"})
    v.post("/setup/country/review", data=form)
    with app.app_context():
        assert company(get_db())["country"] is None


def test_manual_overrides_persist(app, client):
    with app.app_context():
        form = review_form("FJ", get_db(), tax_id_label="TIN (FRCS)", standard_rate="12.5", currency_symbol="FJ$",
                           report_name="VAT return", prices_include_tax="1", fy_start_month="8")
    client.post("/setup/country/review", data=form)
    with app.app_context():
        db = get_db()
        co = company(db)
        assert (co["tax_id_label"], co["tax_report_name"], co["prices_include_tax"], co["fy_start_month"]) == \
            ("TIN (FRCS)", "VAT return", 1, 8)
        assert json.loads(co["currency_format"])["symbol"] == "FJ$" and codes(db)["VAT"] == (12.5, "gst")
    # and the single values stay editable afterwards (Company details, Tax codes)
    page = client.get("/setup/company").get_data(as_text=True)
    assert "TIN (FRCS)" in page and "Registered for VAT" in page
    with app.app_context():
        vid = get_db().execute("SELECT id FROM tax_codes WHERE code='VAT'").fetchone()["id"]
    client.post("/setup/tax-codes", data={"id": vid, "code": "VAT", "name": "VAT", "rate": "12.5", "kind": "gst",
                                          "active_shown": "1"})   # "In use" unticked: no longer offered
    with app.app_context():
        assert get_db().execute("SELECT active FROM tax_codes WHERE code='VAT'").fetchone()["active"] == 0
    assert '>VAT</option>' not in client.get("/sale/new").get_data(as_text=True)
    with app.app_context():
        assert company(get_db())["tax_id_label"] == "TIN (FRCS)"   # still as typed


def test_bad_values_are_refused_and_nothing_is_saved(app, client):
    with app.app_context():
        form = review_form("NZ", get_db(), timezone="Mars/Olympus")
    r = client.post("/setup/country/review", data=form, follow_redirects=True)
    assert "time zone" in r.get_data(as_text=True)
    with app.app_context():
        assert company(get_db())["country"] is None


# ---------------------------------------------------------------- past documents and existing codes
def test_changing_country_never_changes_past_documents_and_keeps_existing_codes(app, client):
    with app.app_context():
        db = get_db()
        cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','Synthetic Customer')").lastrowid
        db.commit()
        old = sell(db, cust, "GST", 10000)   # $100 + 10% GST
        db.commit()
        snap = lambda: ([tuple(r) for r in db.execute("SELECT * FROM documents ORDER BY id")],
                        [tuple(r) for r in db.execute("SELECT * FROM document_lines ORDER BY id")],
                        [tuple(r) for r in db.execute("SELECT * FROM journal_lines ORDER BY id")])
        before = snap()
        form = review_form("NZ", db, timezone="Pacific/Auckland")
        r = C.review(db, "NZ")
        assert {t["code"]: t["status"] for t in r["codes"]} == {"GST": "different", "ZER": "add", "EXE": "add"}
    page = client.get("/setup/country/review?country=NZ").get_data(as_text=True)
    assert "Already there at 10%: kept as it is." in page
    client.post("/setup/country/review", data=form)
    with app.app_context():
        db = get_db()
        assert snap() == before                       # nothing already saved has changed
        c = codes(db)
        assert c["GST"] == (10.0, "gst") and c["CAP"] == (10.0, "capital")   # kept as they were
        assert c["ZER"] == (0.0, "export") and c["EXE"] == (0.0, "input_taxed")  # only missing ones added
        assert not books_consistent(db)
        # a second time adds nothing more
    client.post("/setup/country/review", data=form)
    with app.app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM tax_codes").fetchone()[0] == 8
        # the old invoice still prints the tax it was saved with, now with the New Zealand labels
    text = pdf_text(client, old)
    assert "$110.00" in text and "$10.00" in text and "GST" in text
    with app.app_context():
        db = get_db()
        sell(db, cust, "ZER", 5000)
        db.commit()
        assert not books_consistent(db)


# ---------------------------------------------------------------- no tax, US, other currencies
def test_a_country_with_no_tax(app, client):
    with app.app_context():
        db = get_db()
        cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','Synthetic Customer')").lastrowid
        db.commit()
        n = len(codes(db))
        form = review_form("HK", db)
    assert form["no_tax"] == "1"
    client.post("/setup/country/review", data=form)
    with app.app_context():
        db = get_db()
        co = company(db)
        assert co["tax_name"] == "None" and co["gst_registered"] == 0 and co["currency"] == "HKD"
        assert len(codes(db)) == n                    # nothing added (and nothing removed)
        lab = C.labels(co)
        assert (lab["tax"], lab["has_tax"], lab["invoice"], lab["tax_id"]) == \
            ("Tax", False, "Invoice", "Business registration number")
        doc = sell(db, cust, "N-T", 20000)
        db.commit()
        assert not books_consistent(db)
    text = pdf_text(client, doc)
    assert "Invoice" in text and "Tax Invoice" not in text and "HK$200.00" in text
    page = client.get("/reports/gst").get_data(as_text=True)
    assert "Tax summary" in page


def test_us_sales_tax_rate_is_left_blank_and_a_typed_rate_adds_a_code(app, client):
    with app.app_context():
        db = get_db()
        form = review_form("US", db, timezone="America/Chicago")
        assert form["standard_rate"] == ""
        assert C.review(db, "US")["timezone"] is None    # several zones: asked
    client.post("/setup/country/review", data=form)
    with app.app_context():
        db = get_db()
        c = codes(db)
        assert "ST" not in c and c["EXE"] == (0.0, "input_taxed")
        co = company(db)
        assert (co["tax_name"], co["tax_id_label"], co["date_format"], co["currency"]) == ("Sales tax", "EIN", "mdy", "USD")
    client.post("/setup/country/review", data=dict(form, standard_rate="8.25"))
    with app.app_context():
        assert codes(get_db())["ST"] == (8.25, "gst")


def test_a_non_australian_currency_and_labels_on_the_invoice_pdf(app, client):
    with app.app_context():
        db = get_db()
        db.execute("UPDATE company SET abn='DE123456789'")
        cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','Synthetic Kunde')").lastrowid
        db.commit()
        form = review_form("DE", db, timezone="Europe/Berlin")
    client.post("/setup/country/review", data=form)
    with app.app_context():
        db = get_db()
        assert codes(db)["VAT"] == (19.0, "gst") and codes(db)["RED"] == (7.0, "gst")
        doc = sell(db, cust, "VAT", 123456)            # 1.234,56 € + 19% VAT
        db.commit()
        assert not books_consistent(db)
    text = pdf_text(client, doc)
    assert "1.234,56 €" in text and "234,57 €" in text and "1.469,13 €" in text
    assert "VAT number DE123456789" in text and "VAT" in text and "ABN" not in text
    assert "/" in text.split("Date")[1][:14]          # dd/mm/yyyy, not ISO
    page = client.get(f"/document/{doc}").get_data(as_text=True)
    assert "1.469,13 €" in page


def test_generic_tax_report_is_titled_per_country_and_bas_stays_for_australia(app, client):
    page = client.get("/reports/gst").get_data(as_text=True)
    assert "BAS / GST Summary" in page and "G1" in page and "1A" in page
    with app.app_context():
        db = get_db()
        cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','Synthetic Customer')").lastrowid
        db.commit()
        sell(db, cust, "GST", 10000)
        db.commit()
        form = review_form("FJ", db)
    client.post("/setup/country/review", data=form)
    page = client.get("/reports/gst").get_data(as_text=True)
    assert "VAT return summary" in page and "G1" not in page and "Net VAT payable / (refundable) to FRCS" in page
    assert "VAT return summary" in client.get("/reports/").get_data(as_text=True)


# ---------------------------------------------------------------- existing files and first-run setup
def test_existing_company_file_keeps_the_australian_behaviour(app, client):
    with app.app_context():
        db = get_db()
        cust = db.execute("INSERT INTO contacts (kind, name, abn) VALUES ('customer','Synthetic Customer','11 222')").lastrowid
        db.execute("UPDATE company SET abn='00 000 000 000'")
        db.commit()
        doc = sell(db, cust, "GST", 10000)
        db.commit()
        # an older file, from before Country and tax settings (the columns didn't exist)
        for col, _ddl in C.COLUMNS:
            db.execute(f"ALTER TABLE company DROP COLUMN {col}")
        db.execute("ALTER TABLE tax_codes DROP COLUMN active")
        db.commit()
        migrate(db)
        co = company(db)
        assert co["country"] is None and co["prices_include_tax"] == 0 and co["currency_format"] is None
        lab = C.labels(co)
        assert (lab["tax"], lab["tax_id"], lab["report"], lab["layout"], lab["invoice"], lab["credit"]) == \
            ("GST", "ABN", "BAS / GST Summary", "bas", "Tax Invoice", "Adjustment Note")
        assert C.format_money(123456, C.money_format(co)) == "$1,234.56"
        assert [c for c in codes(db)] == ["GST", "CAP", "FRE", "EXP", "INP", "N-T"]
    text = pdf_text(client, doc)
    assert "Tax Invoice" in text and "ABN 00 000 000 000" in text and "$110.00" in text and "ABN 11 222" in text
    print_page = client.get(f"/document/{doc}?print=1").get_data(as_text=True)
    assert "ABN 00 000 000 000" in print_page and "Subtotal (ex GST)" in print_page and TODAY in print_page
    assert "BAS / GST Summary" in client.get("/reports/gst").get_data(as_text=True)
    assert "Prices include GST" in client.get("/sale/new").get_data(as_text=True)


def _setup_client(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "new.db")})
    return app, app.test_client()


def test_first_run_setup_with_a_country(tmp_path, monkeypatch):
    monkeypatch.delenv("RIYESER_APP_EDITION", raising=False)
    app, c = _setup_client(tmp_path)
    page = c.get("/setup").get_data(as_text=True)
    assert "Where is your business?" in page and "Fiji" in page and "Other / set up myself" in page
    page = c.get("/setup?country=NZ").get_data(as_text=True)
    assert "Confirm these settings and create company file" in page and "IRD / GST number" in page
    assert not (tmp_path / "new.db").exists()        # looking created nothing
    form = review_form("NZ", None, timezone="Pacific/Auckland", name="Synthetic NZ Ltd", password="long-enough-1",
                       start="blank")
    c.post("/setup", data=form)
    with app.app_context():
        db = get_db()
        assert codes(db) == {"GST": (15.0, "gst"), "ZER": (0.0, "export"), "EXE": (0.0, "input_taxed"),
                             "N-T": (0.0, "not_reportable")}
        co = company(db)
        assert (co["country"], co["currency"], co["fy_start_month"], co["country_confirmed_by"]) == ("NZ", "NZD", 4, "admin")
        sales = db.execute("SELECT t.code FROM accounts a JOIN tax_codes t ON t.id=a.tax_code_id WHERE a.code='4-1000'").fetchone()
        assert sales["code"] == "GST"
        cust = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','Synthetic Customer')").lastrowid
        db.commit()
        doc = sell(db, cust, "GST", 10000)
        db.commit()
        assert db.execute("SELECT tax_total FROM documents WHERE id=?", (doc,)).fetchone()[0] == 1500
        assert not books_consistent(db)
    c.post("/login", data={"username": "admin", "password": "long-enough-1"})
    for url in ("/inventory/new", "/sale/new", "/setup/tax-codes", "/reports/gst", "/setup/country"):
        assert c.get(url).status_code == 200, url


def test_first_run_with_a_no_tax_country_and_with_the_demo(tmp_path, monkeypatch):
    monkeypatch.delenv("RIYESER_APP_EDITION", raising=False)
    app, c = _setup_client(tmp_path)
    c.post("/setup", data=review_form("HK", None, name="Synthetic HK Ltd", password="long-enough-1"))
    with app.app_context():
        db = get_db()
        assert codes(db) == {"N-T": (0.0, "not_reportable")}
        assert db.execute("SELECT name FROM accounts WHERE code='2-1310'").fetchone()[0] == "Tax Collected"
    app2 = create_app({"TESTING": True, "DATABASE": str(tmp_path / "demo.db")})
    app2.test_client().post("/setup", data=review_form("FJ", None, name="Demo", password="long-enough-1", start="demo"))
    with app2.app_context():
        db = get_db()
        assert company(db)["country"] == "FJ" and codes(db)["VAT"] == (12.5, "gst")
        assert not books_consistent(db)


def test_setup_without_a_country_is_unchanged(tmp_path, monkeypatch):
    monkeypatch.delenv("RIYESER_APP_EDITION", raising=False)
    app, c = _setup_client(tmp_path)
    c.post("/setup", data={"name": "Plain Co", "password": "long-enough-1"})
    with app.app_context():
        db = get_db()
        assert list(codes(db)) == ["GST", "CAP", "FRE", "EXP", "INP", "N-T"] and company(db)["country"] is None


def test_money_formats():
    f = C.preset("DE")["currency_format"]
    assert C.format_money(-123456, f) == "-1.234,56 €"
    assert C.format_money(123456, C.preset("JP")["currency_format"]) == "¥1,235"
    assert C.format_money(123456, C.preset("CH")["currency_format"]) == "CHF 1’234.56"
    assert C.format_money(0, None, blank_zero=True) == ""
    assert C.format_money(5, None) == "$0.05"
