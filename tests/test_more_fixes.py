"""Accounting fix list items after batch 2 (S, M and F12 items): each test proves the item's "Done when"."""
import io
import json

import pytest

from riyeser import create_app
from riyeser import ledger as L
from riyeser.db import get_db, init_db
from tests.test_batch2 import ids, _contacts, _employee


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("RIYESER_DOCS", str(tmp_path / "Riyeser"))
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "t.db")})
    with app.app_context():
        init_db("Test Co")
    return app


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return c


def page(r):
    return r.get_data(as_text=True)


# ------------------------------------------------------------------ S29
def test_s29_manual_pay_run_upload_works(client, app):
    html = page(client.get("/links/payroll"))
    assert '<form method="post" id="imp" enctype="multipart/form-data">' in html
    run = {"format": "riyeser.payrun.v1", "payrun_id": "U1", "pay_date": "2026-11-14",
           "employees": [{"name": "Ben", "gross": 500, "tax_withheld": 20, "employer_contribution": 50}]}
    with app.app_context():
        bank = get_db().execute("SELECT id FROM accounts WHERE code='1-1110'").fetchone()[0]
    r = client.post("/links/payroll", data={"bank_account_id": bank, "upload": "1",
                                            "file": (io.BytesIO(json.dumps(run).encode()), "U1.json")},
                    content_type="multipart/form-data", follow_redirects=True)
    assert "Pay run U1 imported" in page(r)
