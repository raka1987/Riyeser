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


# ------------------------------------------------------------------ S38, S39 (OWNER-BACKUP)
def _sale(app, amount=10000):
    with app.app_context():
        db = get_db()
        acc, tc = ids(db)
        cust = db.execute("SELECT id FROM contacts WHERE kind='customer'").fetchone()
        cust = cust[0] if cust else _contacts(db)[0]
        L.save_document(db, "sale", dict(contact_id=cust, date="2026-11-20"),
                        [dict(description="Work", qty=1, unit_price=amount, account_id=acc["4-2000"])], "open")
        db.commit()


def test_s38_back_up_now_daily_automatic_keep_30_and_reminder(client, app, tmp_path):
    from datetime import datetime, timedelta
    from riyeser import backups as bk
    folder = tmp_path / "Riyeser" / "Accounting" / "Backups" / "t"
    assert "Back up now" in page(client.get("/setup/backups/")) and "Open the backups folder" in page(client.get("/setup/backups/"))
    assert "no backup of this company in the last 7 days" in page(client.get("/setup/backups/"))
    r = client.post("/setup/backups/now", follow_redirects=True)
    files = list(folder.glob("*.db"))
    assert len(files) == 1 and files[0].name.endswith(" Test Co.db") and "Backed up to" in page(r)
    assert bk.describe(files[0])["name"] == "Test Co"
    assert "no backup of this company" not in page(client.get("/setup/backups/"))
    # the open-folder button works (on a server it says where the folder is)
    assert str(folder) in page(client.post("/setup/backups/open", follow_redirects=True))
    # downloading a copy
    r = client.post("/setup/backups/download")
    assert r.status_code == 200 and r.data[:15] == b"SQLite format 3"
    # automatic: one a day per company, the first time it's used that day
    app.config["AUTO_BACKUP"] = True
    for f in folder.glob("*.db"):
        f.unlink()
    client.get("/")
    client.get("/")
    assert len(list(folder.glob("*.db"))) == 1
    assert bk.daily_backup(str(tmp_path / "t.db")) is None                       # already done today
    # the last 30 are kept
    start = datetime(2026, 10, 1, 9)
    for i in range(33):
        p = bk.backup_now(str(tmp_path / "t.db"), now=start + timedelta(days=i))
        t = (start + timedelta(days=i)).timestamp()
        import os
        os.utime(p, (t, t))
    names = sorted(f.name for f in folder.glob("*.db"))
    assert len(names) == 30 and names[0].startswith("2026-10-05")  # 33 dated + today's automatic one: the oldest 4 go
    assert bk.needs_reminder(str(tmp_path / "t.db"), now=datetime.now() + timedelta(days=8))
    # Settings lists Backups
    assert 'href="/setup/backups/"' in page(client.get("/setup/company"))


def test_s39_restore_over_this_company_or_as_a_named_copy(client, app, tmp_path):
    from riyeser import backups as bk
    _sale(app)
    snap = bk.backup_now(str(tmp_path / "t.db"))
    _sale(app, 5000)                                         # after the backup
    with open(snap, "rb") as f:
        r = client.post("/setup/backups/restore", data={"file": (io.BytesIO(f.read()), "my backup.db")},
                        content_type="multipart/form-data", follow_redirects=True)
    html = page(r)
    assert "Test Co" in html and "Restore over this company" in html and "(restored " in html
    token = r.request.path.rsplit("/", 1)[1]
    # 1. restore over: the company as it was is saved first, then replaced
    r = client.post(f"/setup/backups/restore/{token}", data={"action": "over"}, follow_redirects=True)
    assert "Test Co restored" in page(r)
    before = list((tmp_path / "Riyeser" / "Accounting" / "Backups" / "t").glob("*(before restore).db"))
    assert len(before) == 1 and bk.describe(before[0])["counts"]["invoices"] == 2
    assert bk.describe(tmp_path / "t.db")["counts"]["invoices"] == 1
    # 2. bring it in as a copy named "... (restored <date>)", not a second "Test Co"
    client.post("/login", data={"username": "admin", "password": "admin"})
    with open(snap, "rb") as f:
        r = client.post("/setup/backups/restore", data={"file": (io.BytesIO(f.read()), "b.db")},
                        content_type="multipart/form-data", follow_redirects=True)
    token = r.request.path.rsplit("/", 1)[1]
    client.post(f"/setup/backups/restore/{token}", data={"action": "copy"})
    with app.test_request_context():
        from riyeser import companies as co
        names = [c["name"] for c in co.all_companies()]
    assert names[0] == "Test Co" and len(names) == 2 and names[1].startswith("Test Co (restored ")
    # not a company file: refused
    r = client.post("/setup/backups/restore", data={"file": (io.BytesIO(b"hello"), "x.db")},
                    content_type="multipart/form-data", follow_redirects=True)
    assert "isn&#39;t a Riyeser Accounting company file" in page(r)


def test_owner_backup_first_run_offers_restore(tmp_path, monkeypatch):
    from riyeser import backups as bk
    monkeypatch.setenv("RIYESER_DOCS", str(tmp_path / "Riyeser"))
    old = create_app({"TESTING": True, "DATABASE": str(tmp_path / "old" / "company.db")})
    (tmp_path / "old").mkdir()
    with old.app_context():
        init_db("Moved PC Pty Ltd")
    snap = bk.backup_now(str(tmp_path / "old" / "company.db"))
    new = create_app({"TESTING": True, "DATABASE": str(tmp_path / "new" / "company.db")})
    (tmp_path / "new").mkdir()
    c = new.test_client()
    html = page(c.get("/setup"))
    assert "Restore from a backup…" in html and "Create company file" in html
    with open(snap, "rb") as f:
        r = c.post("/setup/backups/restore", data={"file": (io.BytesIO(f.read()), snap.name)},
                   content_type="multipart/form-data", follow_redirects=True)
    assert "Moved PC Pty Ltd" in page(r)
    token = r.request.path.rsplit("/", 1)[1]
    r = c.post(f"/setup/backups/restore/{token}", data={"action": "over"}, follow_redirects=True)
    assert "Moved PC Pty Ltd restored" in page(r)
    assert bk.describe(tmp_path / "new" / "company.db")["name"] == "Moved PC Pty Ltd"
    c.post("/login", data={"username": "admin", "password": "admin"})
    assert c.get("/").status_code == 200
