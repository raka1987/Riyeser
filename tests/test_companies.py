"""Several companies: add, switch, separate books, one sign-in, per-company access, overview, archive, import."""
import io
import re
import shutil

import pytest

from riyeser import create_app
from riyeser.db import get_db, init_db


@pytest.fixture
def app(tmp_path):
    from riyeser.demo import seed_demo
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "company.db")})
    with app.app_context():
        init_db("Group Holdings Pty Ltd")
        seed_demo(get_db())
    return app


def login(app, user="admin", pw="admin", company=None):
    c = app.test_client()
    data = {"username": user, "password": pw}
    if company:
        data["company"] = company
    r = c.post("/login", data=data)
    assert r.status_code == 302 and "/login" not in r.location, r.location
    return c


def company_ids(c):
    return re.findall(r"/companies/switch/([a-z0-9-]+)", c.get("/companies/").get_data(as_text=True))


def test_add_switch_and_books_stay_separate(app):
    c = login(app)
    r = c.post("/companies/add", data={"name": "Harbourview Trading Pty Ltd", "abn": "12 345 678 901"})
    assert r.status_code == 302
    c.get(r.location)  # switch to the new company
    home = c.get("/").get_data(as_text=True)
    assert "Harbourview Trading Pty Ltd" in home
    # brand-new company: empty books
    assert "$0.00" in home
    c.post("/cards/customer/new", data={"name": "Only In Trading", "active": "1"})
    # switch back: the customer isn't in the first company
    c.get("/companies/switch/main")
    assert "Group Holdings Pty Ltd" in c.get("/").get_data(as_text=True)
    assert "Only In Trading" not in c.get("/cards/customer").get_data(as_text=True)
    # overview lists both, with totals across both
    page = c.get("/companies/").get_data(as_text=True)
    assert "Group Holdings Pty Ltd" in page and "Harbourview Trading Pty Ltd" in page and "Cash at bank · all" in page


def test_one_sign_in_reaches_every_company_with_same_password(app):
    c = login(app)
    c.post("/companies/add", data={"name": "Second Co"})
    c2 = login(app)  # a fresh sign-in at the first company
    ids = [i for i in company_ids(c2) if i != "main"]
    assert ids, "second company should be listed"
    r = c2.get(f"/companies/switch/{ids[0]}")
    assert r.status_code == 302 and r.location.endswith("/")
    assert "Second Co" in c2.get("/").get_data(as_text=True)
    # sign in straight into the second company from the login screen
    c3 = login(app, company=ids[0])
    assert "Second Co" in c3.get("/").get_data(as_text=True)


def test_access_is_per_company(app):
    a = login(app)
    a.post("/companies/add", data={"name": "Payroll Co"})
    pid = [i for i in company_ids(a) if i != "main"][0]
    # Sam: sales staff, given the same sign-in and access in Payroll Co too
    a.post("/users/save", data={"username": "sam", "password": "pw", "preset": "sales", "also": pid})
    a.get(f"/companies/switch/{pid}")
    users = a.get("/users").get_data(as_text=True)
    assert "sam" in users
    s = login(app, "sam", "pw")
    assert s.get("/payroll/").status_code == 302          # first company: no payroll
    assert s.get(f"/companies/switch/{pid}").status_code == 302
    assert "Payroll Co" in s.get("/").get_data(as_text=True)
    # sam isn't an administrator: can't add companies
    assert s.post("/companies/add", data={"name": "Nope"}).status_code in (302, 403)
    assert "Nope" not in s.get("/companies/").get_data(as_text=True)


def test_different_password_asks_once(app):
    a = login(app)
    a.post("/companies/add", data={"name": "Other Pw Co"})
    oid = [i for i in company_ids(a) if i != "main"][0]
    a.get(f"/companies/switch/{oid}")
    me = re.search(r'name="id" value="(\d+)"', a.get("/users").get_data(as_text=True)).group(1)
    a.post("/users/save", data={"id": me, "role": "admin", "active": "1", "full_name": "Admin", "password": "different"})
    b = login(app)
    page = b.get(f"/companies/switch/{oid}").get_data(as_text=True)
    assert "different password" in page
    b.post(f"/companies/switch/{oid}", data={"password": "wrong"})
    assert "Other Pw Co" not in b.get("/").get_data(as_text=True)
    b.post(f"/companies/switch/{oid}", data={"password": "different"})
    assert "Other Pw Co" in b.get("/").get_data(as_text=True)


def test_archive_restore_and_import(app, tmp_path):
    a = login(app)
    a.post("/companies/add", data={"name": "Old Co"})
    oid = [i for i in company_ids(a) if i != "main"][0]
    a.post(f"/companies/{oid}/archive")
    page = a.get("/companies/").get_data(as_text=True)
    assert "Archived companies" in page and f"/companies/switch/{oid}" not in page
    a.post(f"/companies/{oid}/archive", data={"restore": "1"})
    assert f"/companies/switch/{oid}" in a.get("/companies/").get_data(as_text=True)
    # bring in a copy of a company file from elsewhere
    src = tmp_path / "client.db"
    shutil.copyfile(app.config["DATABASE"], src)
    with open(src, "rb") as f:
        r = a.post("/companies/import", data={"file": (io.BytesIO(f.read()), "client.db")}, content_type="multipart/form-data")
    assert r.status_code == 302
    assert a.get("/companies/").get_data(as_text=True).count("Group Holdings Pty Ltd") >= 2
    bad = a.post("/companies/import", data={"file": (io.BytesIO(b"not a db"), "x.db")}, content_type="multipart/form-data", follow_redirects=True)
    assert "isn&#39;t a Riyeser Accounting company file" in bad.get_data(as_text=True)


def test_new_company_keeps_its_own_abn_with_demo_data(app):
    a = login(app)
    a.post("/companies/add", data={"name": "Demo Two", "abn": "99 999 999 999", "demo": "1"})
    page = a.get("/companies/").get_data(as_text=True)
    assert "ABN 99 999 999 999" in page and "Demo Two" in page
