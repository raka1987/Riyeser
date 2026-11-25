"""A new company file starts with the company profile Riyeser Central saved (company.json)."""
import json

import pytest

from riyeser import create_app, company_profile
from riyeser.db import get_db

PROFILE = {"mode": "online", "company_code": "RIY-7K3M-Q2", "name": "Sample Plumbing", "legal_name": "Sample Plumbing Pty Ltd",
           "tax_number": "12 345 678 901", "address": "4 Elm St, Suva", "phone": "+679 330 0000", "email": "office@sample.test",
           "country": "Fiji"}


def _write(tmp_path, data):
    f = tmp_path / "appdata" / "Riyeser" / "company.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(data if isinstance(data, str) else json.dumps(data))
    return f


def test_reading_never_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    assert company_profile.read() == {}
    _write(tmp_path, "{broken")
    assert company_profile.read() == {}
    _write(tmp_path, {"name": "  "})
    assert company_profile.read() == {}
    _write(tmp_path, PROFILE)
    assert company_profile.read()["tax_number"] == "12 345 678 901"


@pytest.mark.parametrize("edition", [None, "basics", "plus", "pos", "invoices", "bookings"])
def test_new_company_file_uses_the_profile(tmp_path, monkeypatch, edition):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    if edition:
        monkeypatch.setenv("RIYESER_APP_EDITION", edition)
    _write(tmp_path, PROFILE)
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "new.db")})
    c = app.test_client()
    page = c.get("/setup").get_data(as_text=True)
    assert "Filled in from your Riyeser company profile" in page and 'value="Sample Plumbing"' in page and "RIY-7K3M-Q2" in page
    c.post("/setup", data={"name": "Sample Plumbing", "password": "admin123", "use_profile": "1"})
    with app.app_context():
        row = get_db().execute("SELECT name, abn, address, phone, email FROM company").fetchone()
    assert tuple(row) == ("Sample Plumbing", "12 345 678 901", "4 Elm St, Suva", "+679 330 0000", "office@sample.test")


def test_no_profile_works_as_before(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "new.db")})
    c = app.test_client()
    assert "Filled in from" not in c.get("/setup").get_data(as_text=True)
    c.post("/setup", data={"name": "Corner Cafe", "password": "admin123"})
    with app.app_context():
        assert get_db().execute("SELECT name, abn FROM company").fetchone()[0] == "Corner Cafe"
