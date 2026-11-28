"""Business details & branding: the business's logo, names, tax number and contact details on every document."""
import io
import json
import sqlite3

import pytest
from PIL import Image, ImageDraw
from pypdf import PdfReader

from riyeser import create_app
from riyeser import branding as B
from riyeser import ledger as L
from riyeser.db import get_db, init_db


def logo_png(size=(800, 400), box=(300, 150, 500, 250), fmt="PNG", colour=(232, 93, 74)):
    """A made-up logo: a coloured block in the middle of a wide white margin."""
    im = Image.new("RGB", size, "white")
    ImageDraw.Draw(im).rectangle(box, fill=colour)
    out = io.BytesIO()
    im.save(out, fmt)
    return out.getvalue()


SVG = (b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><circle cx="50" cy="50" r="40" fill="#e85d4a"/>'
       b'<rect x="100" y="30" width="180" height="40" fill="#102344"/></svg>')


def _pdf(data):
    r = PdfReader(io.BytesIO(data))
    return r, "".join(p.extract_text() for p in r.pages)


def _images(reader):
    return sum(len(p.images) for p in reader.pages)


@pytest.fixture
def app(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "t.db")})
    with app.app_context():
        init_db("Coral Coast Bakehouse")
    return app


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return c


def _details(client, **extra):
    data = {"name": "Coral Coast Bakehouse", "legal_name": "Coral Coast Holdings Pty Ltd", "abn": "51 824 753 556",
            "address": "14 Beach Road\nSuva", "phone": "+679 330 0000", "email": "hello@coral.example",
            "website": "coral.example", "footer_invoice": "Thank you for your business.",
            "footer_receipt": "Thank you! Returns within 14 days.", "footer_quote": "Valid for 30 days.",
            "footer_statement": "Questions? Just call us.", "footer_purchase": "Deliver to the back door.",
            "footer_booking": "Running late? Call us.", "footer_payslip": "Payroll questions: ask Mere.",
            "footer_credit": "Credited to your account.", "accent_colour": "#7a1f5c"}
    data.update(extra)
    return client.post("/setup/branding/", data=data, content_type="multipart/form-data", follow_redirects=True)


def _upload(client, data, name="logo.png"):
    return _details(client, logo=(io.BytesIO(data), name))


def _setup_docs(app):
    """An invoice, a quote, a credit note, a purchase order, a payment and a customer: their ids."""
    with app.app_context():
        db = get_db()
        acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
        tc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM tax_codes")}
        cust = db.execute("INSERT INTO contacts (kind, name, address, email) VALUES ('customer','Tanoa Café',"
                          "'2 Main St','tanoa@example.com')").lastrowid
        sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Flour Mill Ltd')").lastrowid
        line = lambda: [dict(description="Sourdough loaf", qty=2, unit_price=1500, account_id=acc["4-1000"],
                             tax_code_id=tc["GST"])]
        inv = L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-02", due_date="2026-11-16"), line(), "open")
        quote = L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-02"), line(), "quote")
        credit = L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-03", kind="credit"), line(), "open")
        po = L.save_document(db, "purchase", dict(contact_id=sup, date="2026-11-02"),
                             [dict(description="Flour 25 kg", qty=1, unit_price=4000, account_id=acc["5-1000"],
                                   tax_code_id=tc["GST"])], "order")
        pay = L.record_payment(db, "in", cust, acc["1-1110"], "2026-11-05", [(inv, 1000)], reference="EFT 889")
        db.commit()
    return dict(cust=cust, inv=inv, quote=quote, credit=credit, po=po, pay=pay)


# ---------------------------------------------------------------- logo checks
def test_png_is_trimmed_and_kept_in_proportion():
    lg = B.process_logo(logo_png())
    assert lg["mime"] == "image/png"
    # the 200 x 100 block plus a small margin: the white margin around it is gone
    assert 200 <= lg["width"] <= 215 and 100 <= lg["height"] <= 112
    assert abs(lg["width"] / lg["height"] - 2) < 0.15
    mono = Image.open(io.BytesIO(lg["mono"]))
    assert mono.mode == "1" and mono.width <= B.MONO_WIDTH


def test_jpeg_and_transparent_png_and_big_logo_shrunk():
    assert B.process_logo(logo_png(fmt="JPEG"))["mime"] == "image/jpeg"
    im = Image.new("RGBA", (600, 600), (0, 0, 0, 0))
    ImageDraw.Draw(im).ellipse((100, 200, 300, 300), fill=(10, 20, 30, 255))
    out = io.BytesIO()
    im.save(out, "PNG")
    lg = B.process_logo(out.getvalue())
    assert lg["width"] < 230 and lg["height"] < 120   # trimmed to the transparent edges
    big = B.process_logo(logo_png(size=(3000, 1500), box=(0, 0, 2999, 700)))
    assert max(big["width"], big["height"]) <= B.MAX_SIDE


def test_svg_accepted_and_unsafe_svg_refused():
    lg = B.process_logo(SVG)
    assert lg["mime"] == "image/svg+xml" and (lg["width"], lg["height"]) == (300, 100) and lg["mono"] is None
    for bad in (b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9"><script>alert(1)</script></svg>',
                b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9" onload="x()"></svg>',
                b'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 9 9">'
                b'<image xlink:href="http://example.com/a.png"/></svg>',
                b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>'):   # no size
        with pytest.raises(B.LogoError):
            B.process_logo(bad)


@pytest.mark.parametrize("data, words", [
    (b"", "Choose a picture"),
    (b"GIF89a" + b"\0" * 100, "isn't a PNG, JPG or SVG"),
    (b"%PDF-1.7 not a picture", "isn't a PNG, JPG or SVG"),
    (b"\x89PNG\r\n\x1a\n" + b"\0" * 50, "couldn't be opened"),
    (b"\x89PNG\r\n\x1a\n" + b"\0" * (B.MAX_UPLOAD + 10), "under 2 MB"),
])
def test_bad_uploads_are_explained(data, words):
    with pytest.raises(B.LogoError) as e:
        B.process_logo(data)
    assert words in str(e.value)


def test_a_blank_picture_is_refused():
    with pytest.raises(B.LogoError, match="empty"):
        B.process_logo(logo_png(box=(0, 0, 0, 0), colour=(255, 255, 255)))


# ---------------------------------------------------------------- the setup page and the company file
def test_setup_page_saves_details_and_logo_in_the_company_file(client, app, tmp_path):
    page = client.get("/setup/branding/").get_data(as_text=True)
    assert "Business details &amp; branding" in page and "ABN" in page
    r = _upload(client, logo_png())
    assert "Logo saved" in r.get_data(as_text=True)
    con = sqlite3.connect(tmp_path / "t.db")
    row = con.execute("SELECT mime, width, height, source FROM brand_logo").fetchone()
    co = con.execute("SELECT name, legal_name, abn, website, accent_colour, brand_footers FROM company").fetchone()
    con.close()
    assert row[0] == "image/png" and row[3] == "upload"
    assert co[:5] == ("Coral Coast Bakehouse", "Coral Coast Holdings Pty Ltd", "51 824 753 556", "coral.example", "#7a1f5c")
    assert json.loads(co[5])["receipt"] == "Thank you! Returns within 14 days."
    page = client.get("/setup/branding/").get_data(as_text=True)
    assert "data:image/png;base64," in page and "Remove logo" in page and "Replace the logo" in page
    # a bad picture changes nothing, and says why
    r = _upload(client, b"not a picture", "logo.png")
    assert "isn&#39;t a PNG, JPG or SVG" in r.get_data(as_text=True)
    with app.app_context():
        assert B.stored_logo(get_db())["mime"] == "image/png"
    # remove
    _details(client, logo_action="remove")
    with app.app_context():
        assert B.stored_logo(get_db()) is None and not B.business_brand(get_db())["has_logo"]


def test_logo_survives_backup_and_restore(client, app, tmp_path, monkeypatch):
    from riyeser import backups
    monkeypatch.setenv("RIYESER_DOCS", str(tmp_path / "docs"))
    _upload(client, logo_png())
    with app.app_context():
        before = B.stored_logo(get_db())["image"]
    dest = backups.backup_now(str(tmp_path / "t.db"))
    _details(client, logo_action="remove")
    with app.app_context():
        assert B.stored_logo(get_db()) is None
    backups.restore_over(dest, str(tmp_path / "t.db"))
    with app.app_context():
        assert B.stored_logo(get_db())["image"] == before


def test_setup_link_is_in_every_programs_setup(tmp_path, monkeypatch):
    for edition in ("basics", "plus", "pos", "invoices", "bookings", "estimate"):
        monkeypatch.setenv("RIYESER_APP_EDITION", edition)
        app = create_app({"TESTING": True, "DATABASE": str(tmp_path / f"{edition}.db")})
        with app.app_context():
            init_db("Corner Shop")
        c = app.test_client()
        c.post("/login", data={"username": "admin", "password": "admin"})
        page = c.get("/setup/branding/", follow_redirects=True)
        text = page.get_data(as_text=True)
        assert page.status_code == 200 and "Business details &amp; branding" in text, edition
        assert 'href="/setup/branding/"' in text, edition


def test_company_page_keeps_working_without_the_moved_fields(client, app):
    _details(client)
    page = client.get("/setup/company").get_data(as_text=True)
    assert "Edit business details &amp; branding" in page and "Coral Coast Holdings Pty Ltd" in page
    client.post("/setup/company", data={"fy_start_month": "7", "default_terms_days": "14", "invoice_prefix": "INV",
                                        "bill_prefix": "BILL", "next_invoice_no": "1", "next_bill_no": "1"})
    with app.app_context():
        co = get_db().execute("SELECT name, abn, phone, default_terms_days FROM company").fetchone()
    assert tuple(co) == ("Coral Coast Bakehouse", "51 824 753 556", "+679 330 0000", 14)


# ---------------------------------------------------------------- every document
def test_every_pdf_carries_the_logo_name_tax_number_and_footer(client, app):
    _upload(client, logo_png())
    ids = _setup_docs(app)
    checks = {
        f"/document/{ids['inv']}?pdf=1": ("Tax Invoice", "Thank you for your business."),
        f"/document/{ids['quote']}?pdf=1": ("Quote", "Valid for 30 days."),
        f"/document/{ids['credit']}?pdf=1": ("Adjustment Note", "Credited to your account."),
        f"/document/{ids['po']}?pdf=1": ("Purchase Order", "Deliver to the back door."),
        f"/cards/statement/{ids['cust']}?pdf=1": ("Statement", "Questions? Just call us."),
        f"/payment/{ids['pay']}/receipt": ("Receipt", "Thank you! Returns within 14 days."),
    }
    for url, (title, footer) in checks.items():
        r = client.get(url)
        assert r.status_code == 200 and r.mimetype == "application/pdf", url
        reader, text = _pdf(r.data)
        flat = " ".join(text.split())
        assert _images(reader) >= 1, url
        for want in (title, "Coral Coast Bakehouse", "Coral Coast Holdings Pty Ltd", "ABN 51 824 753 556",
                     "+679 330 0000", "hello@coral.example", footer, "produced with"):
            assert want in flat, (url, want)


def test_payslip_and_job_sheet_pdfs_are_branded(client, app):
    from tests.test_batch2 import _employee, _pay
    _upload(client, logo_png())
    with app.app_context():
        emp = _employee(get_db(), "Mere", "Tuilagi")
        get_db().commit()
    _pay(client, emp)
    with app.app_context():
        sid = get_db().execute("SELECT id FROM payslips").fetchone()[0]
    reader, text = _pdf(client.get(f"/payroll/payslip/{sid}?pdf=1").data)
    assert _images(reader) == 1 and "ABN 51 824 753 556" in text and "Payroll questions: ask Mere." in text
    html = client.get(f"/payroll/payslip/{sid}").get_data(as_text=True)
    assert 'class="bh-logo"' in html and "ABN 51 824 753 556" in html and "Payroll questions" in html
    from riyeser.jobsite import job_sheet_pdf
    with app.app_context():
        db = get_db()
        jid = db.execute("INSERT INTO booking_jobs (title) VALUES ('Oven service')").lastrowid
        reader, text = _pdf(job_sheet_pdf(db, jid))
    assert _images(reader) == 1 and "Coral Coast Bakehouse" in text and "Running late? Call us." in text


def test_html_documents_carry_the_branding(client, app):
    _upload(client, logo_png())
    ids = _setup_docs(app)
    for url, footer in ((f"/document/{ids['inv']}?print=1", "Thank you for your business."),
                        (f"/document/{ids['quote']}?print=1", "Valid for 30 days."),
                        (f"/cards/statement/{ids['cust']}", "Questions? Just call us.")):
        html = client.get(url).get_data(as_text=True)
        for want in ('class="bh-logo"', "data:image/png;base64,", "Coral Coast Bakehouse", "ABN 51 824 753 556",
                     "coral.example", footer, "--doc-accent:#7a1f5c"):
            assert want in html, (url, want)


def test_pos_receipt_80_and_58mm(tmp_path, monkeypatch):
    from tests.test_pos_app import make, sell
    app, c, item = make(tmp_path, monkeypatch, "pos")
    _upload(c, logo_png())
    sid = sell(c, item).get_json()["sale_id"]
    r80 = c.get(f"/pos/receipt/{sid}").get_data(as_text=True)
    r58 = c.get(f"/pos/receipt/{sid}?paper=58").get_data(as_text=True)
    for html in (r80, r58):
        assert 'class="rb-logo"' in html and "ABN 51 824 753 556" in html and "Coral Coast Holdings" in html
        assert "Thank you! Returns within 14 days." in html and "TAX INVOICE" in html
    assert "size:80mm auto" in r80 and 'class="r"' in r80
    assert "size:58mm auto" in r58 and 'class="r p58"' in r58
    # the receipt's logo is the black-and-white copy
    with app.app_context():
        mono = B.business_brand(get_db())["logo_mono_uri"]
    assert mono in r80


def test_booking_confirmation_page_and_email(client, app, monkeypatch):
    _upload(client, logo_png())
    with app.app_context():
        db = get_db()
        cid = db.execute("INSERT INTO contacts (kind, name, email) VALUES ('customer','Ana Vula','ana@example.com')").lastrowid
        bid = db.execute("INSERT INTO bookings (contact_id, starts_at, minutes, title) VALUES (?,?,60,'Cake tasting')",
                         (cid, "2099-03-04 10:00")).lastrowid
        db.execute("UPDATE company SET smtp_host='smtp.example.com', smtp_from='hello@coral.example'")
        db.commit()
    html = client.get(f"/bookings/{bid}/confirmation").get_data(as_text=True)
    assert "Booking confirmation" in html and 'class="bh-logo"' in html and "Running late? Call us." in html
    sent = _fake_smtp(monkeypatch)
    client.post(f"/bookings/{bid}/confirm-email")
    assert len(sent) == 1
    m = sent[0]
    assert m["Subject"].startswith("Booking confirmed: Cake tasting")
    _assert_branded_email(m, "Running late? Call us.")


def _fake_smtp(monkeypatch):
    import smtplib
    sent = []

    class Fake:
        def __init__(self, *a, **k):
            pass

        def starttls(self, **k):
            pass

        def login(self, *a):
            pass

        def send_message(self, m):
            sent.append(m)

        def quit(self):
            pass
    monkeypatch.setattr(smtplib, "SMTP", Fake)
    return sent


def _assert_branded_email(m, footer):
    text = m.get_body(("plain",)).get_content()
    html = m.get_body(("html",)).get_content()
    assert footer in text and "ABN 51 824 753 556" in text
    assert "Coral Coast Bakehouse" in html and "ABN 51 824 753 556" in html and footer in html
    assert 'src="cid:' in html and "Sent with Riyeser" in html
    imgs = [p for p in m.walk() if p.get_content_type() == "image/png"]
    assert len(imgs) == 1 and imgs[0]["Content-ID"]


def test_invoice_email_is_branded(client, app, monkeypatch):
    _upload(client, logo_png())
    ids = _setup_docs(app)
    with app.app_context():
        get_db().execute("UPDATE company SET smtp_host='smtp.example.com', smtp_from='hello@coral.example'")
        get_db().commit()
    sent = _fake_smtp(monkeypatch)
    client.post(f"/document/{ids['inv']}/email", data={})
    assert len(sent) == 1
    _assert_branded_email(sent[0], "Thank you for your business.")
    assert any(p.get_content_type() == "application/pdf" for p in sent[0].walk())


# ---------------------------------------------------------------- country rules and no logo
def test_tax_label_follows_the_country_and_tax_invoice_rules_still_apply(client, app):
    _details(client)
    ids = _setup_docs(app)
    with app.app_context():
        db = get_db()
        db.execute("UPDATE company SET country='NZ', tax_name='GST', tax_id_label='IRD number'")
        db.commit()
    _, text = _pdf(client.get(f"/document/{ids['inv']}?pdf=1").data)
    assert "IRD number 51 824 753 556" in text and "Tax Invoice" in text and "ABN" not in text
    _, text = _pdf(client.get(f"/document/{ids['credit']}?pdf=1").data)
    assert "Credit Note" in text   # Adjustment Note is Australia's word
    with app.app_context():
        db = get_db()
        db.execute("UPDATE company SET country='US', tax_name='None', tax_id_label='EIN'")
        db.commit()
    _, text = _pdf(client.get(f"/document/{ids['inv']}?pdf=1").data)
    assert "EIN 51 824 753 556" in text and "Tax Invoice" not in text and "Invoice" in text
    page = client.get("/setup/branding/").get_data(as_text=True)
    assert '<label for="b-tax">EIN</label>' in page


def test_no_logo_means_a_clean_layout(client, app):
    _details(client, legal_name="", website="")
    ids = _setup_docs(app)
    reader, text = _pdf(client.get(f"/document/{ids['inv']}?pdf=1").data)
    assert _images(reader) == 0 and "Coral Coast Bakehouse" in text and "ABN 51 824 753 556" in text
    html = client.get(f"/document/{ids['inv']}?print=1").get_data(as_text=True)
    assert "bh-logo" not in html and "Coral Coast Bakehouse" in html
    with app.app_context():
        assert B.business_brand(get_db())["legal_name"] == ""


def test_long_names_wrap_inside_the_page(client, app):
    long = "The Extraordinarily Long-Named Coral Coast Artisan Sourdough Bakehouse and Pastry Kitchen of the South Pacific"
    _details(client, name=long, logo=(io.BytesIO(logo_png(size=(2000, 200), box=(0, 0, 1999, 199), colour=(16, 35, 68))), "wide.png"))
    ids = _setup_docs(app)
    reader, text = _pdf(client.get(f"/document/{ids['inv']}?pdf=1").data)
    assert "Pastry Kitchen" in text and "Tax Invoice" in text and len(reader.pages) == 1


def test_svg_logo_on_pdf(client, app):
    _upload(client, SVG, "logo.svg")
    ids = _setup_docs(app)
    r = client.get(f"/document/{ids['inv']}?pdf=1")
    assert r.status_code == 200 and "Coral Coast Bakehouse" in _pdf(r.data)[1]


# ---------------------------------------------------------------- Riyeser Central's logo and details
def _central(tmp_path, monkeypatch, logo=True):
    folder = tmp_path / "_appdata" / "Riyeser"
    folder.mkdir(parents=True, exist_ok=True)
    prof = {"name": "Coral Coast Bakehouse", "legal_name": "Coral Coast Holdings Pty Ltd", "tax_number": "98 765",
            "address": "1 Central Way", "phone": "+679 111", "email": "central@coral.example"}
    if logo:
        (folder / "logo.png").write_bytes(logo_png())
        prof["logo"] = str(folder / "logo.png")
    (folder / "company.json").write_text(json.dumps(prof))


def test_centrals_logo_and_details_flow_to_the_apps(client, app, tmp_path, monkeypatch):
    _central(tmp_path, monkeypatch)
    with app.app_context():
        b = B.business_brand(get_db())
    assert b["has_logo"] and b["logo_from_central"]
    page = client.get("/setup/branding/").get_data(as_text=True)
    assert "From Riyeser Central" in page and "1 Central Way" in page and "Coral Coast Holdings Pty Ltd" in page
    assert "Keep it in this company file" in page
    ids = _setup_docs(app)
    reader, _ = _pdf(client.get(f"/document/{ids['inv']}?pdf=1").data)
    assert _images(reader) == 1
    # copy it into the company file (so it's in backups), then removing it stops Central's showing too
    _details(client, logo_action="central")
    with app.app_context():
        assert B.stored_logo(get_db())["source"] == "central"
    _details(client, logo_action="remove")
    with app.app_context():
        assert not B.business_brand(get_db())["has_logo"]


def test_new_company_file_takes_centrals_legal_name(tmp_path, monkeypatch):
    from riyeser import company_profile
    _central(tmp_path, monkeypatch, logo=False)
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "n.db")})
    with app.app_context():
        init_db("Coral Coast Bakehouse")
        db = get_db()
        company_profile.apply_to_new_file(db)
        assert db.execute("SELECT legal_name, abn FROM company").fetchone()[:] == ("Coral Coast Holdings Pty Ltd", "98 765")
