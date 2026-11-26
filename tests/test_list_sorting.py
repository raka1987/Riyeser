"""Sorting and filtering on the list screens (riyeser/listing.py): the helper, then a few screens' query strings."""
import re
import sqlite3

import pytest
from werkzeug.datastructures import MultiDict

from riyeser import create_app
from riyeser import listing as LS
from riyeser.listing import ListSpec, ListState, Col, Choice
from riyeser.db import get_db, init_db


# ------------------------------------------------------------------ financial years and periods
def test_financial_year_july_to_june():
    assert LS.fy_bounds(2025, 7) == ("2025-07-01", "2026-06-30")
    assert LS.fy_start_year("2026-06-30", 7) == 2025
    assert LS.fy_start_year("2026-07-01", 7) == 2026
    assert LS.year_range("fy2025", 7) == ("2025-07-01", "2026-06-30")
    assert LS.fy_label(2025, 7) == "FY 2025–26"


def test_financial_year_january_to_december():
    assert LS.fy_bounds(2026, 1) == ("2026-01-01", "2026-12-31")
    assert LS.fy_start_year("2026-01-01", 1) == 2026 and LS.fy_start_year("2025-12-31", 1) == 2025
    assert LS.year_range("fy2026", 1) == ("2026-01-01", "2026-12-31")
    # the year is the calendar year: no separate financial-year list
    opts = LS.year_options(1, "2024-03-01", "2026-05-01", today="2026-11-26")
    assert opts == [("Year", [("cy2026", "2026"), ("cy2025", "2025"), ("cy2024", "2024")])]


def test_calendar_year_and_options_for_a_july_year():
    assert LS.year_range("cy2025", 7) == ("2025-01-01", "2025-12-31")
    assert LS.year_range("nonsense", 7) == (None, None)
    groups = dict(LS.year_options(7, "2024-08-15", "2026-02-01", today="2026-11-26"))
    fy = groups["Financial year (Jul–Jun)"]
    assert fy == [("fy2026", "FY 2026–27"), ("fy2025", "FY 2025–26"), ("fy2024", "FY 2024–25")]
    assert [v for v, _ in groups["Calendar year"]] == ["cy2026", "cy2025", "cy2024"]


def test_other_financial_year_starts():
    assert LS.fy_bounds(2025, 4) == ("2025-04-01", "2026-03-31")  # April to March
    assert LS.period_range("this_fy", 4, "2026-03-31") == ("2025-04-01", "2026-03-31")
    assert LS.period_range("this_fy", 4, "2026-04-01") == ("2026-04-01", "2027-03-31")


@pytest.mark.parametrize("period,today,fy,expected", [
    ("this_month", "2026-11-26", 7, ("2026-11-01", "2026-11-30")),
    ("this_month", "2024-02-10", 7, ("2024-02-01", "2024-02-29")),
    ("last_month", "2026-01-15", 7, ("2025-12-01", "2025-12-31")),
    ("last_month", "2026-03-31", 7, ("2026-02-01", "2026-02-28")),
    ("this_quarter", "2026-11-26", 7, ("2026-10-01", "2026-12-31")),
    ("this_quarter", "2026-07-01", 7, ("2026-07-01", "2026-09-30")),
    ("this_quarter", "2026-02-14", 1, ("2026-01-01", "2026-03-31")),
    ("this_quarter", "2026-02-14", 4, ("2026-01-01", "2026-03-31")),  # Q4 of an April year
    ("this_quarter", "2026-12-05", 11, ("2026-11-01", "2027-01-31")),  # a quarter across New Year
    ("this_fy", "2026-11-26", 7, ("2026-07-01", "2027-06-30")),
    ("this_fy", "2026-06-30", 7, ("2025-07-01", "2026-06-30")),
    ("last_fy", "2026-11-26", 7, ("2025-07-01", "2026-06-30")),
    ("this_fy", "2026-11-26", 1, ("2026-01-01", "2026-12-31")),
    ("last_fy", "2026-11-26", 1, ("2025-01-01", "2025-12-31")),
    ("", "2026-11-26", 7, (None, None)),
])
def test_period_quick_picks(period, today, fy, expected):
    assert LS.period_range(period, fy, today) == expected


def test_custom_period_ignores_bad_dates():
    assert LS.period_range("custom", 7, "2026-11-26", "2026-01-05", "2026-02-01") == ("2026-01-05", "2026-02-01")
    assert LS.period_range("custom", 7, "2026-11-26", "5/1/2026", "") == (None, None)


# ------------------------------------------------------------------ sorting
def test_numbers_and_dates_sort_as_numbers_and_dates_not_text():
    rows = [{"amt": "900"}, {"amt": 10000}, {"amt": "25.5"}, {"amt": None}, {"amt": 3}]
    assert [r["amt"] for r in LS.sort_rows(rows, "amt", "num")] == [3, "25.5", "900", 10000, None]
    assert [r["amt"] for r in LS.sort_rows(rows, "amt", "num", desc=True)] == [10000, "900", "25.5", 3, None]
    d = [{"d": "2026-01-02"}, {"d": "2025-12-31"}, {"d": ""}, {"d": "2026-01-10"}]
    assert [r["d"] for r in LS.sort_rows(d, "d", "date", desc=True)] == ["2026-01-10", "2026-01-02", "2025-12-31", ""]
    codes = [{"n": "INV00010"}, {"n": "INV9"}, {"n": "CN00002"}, {"n": "inv00100"}]
    assert [r["n"] for r in LS.sort_rows(codes, "n", "code")] == ["CN00002", "INV9", "INV00010", "inv00100"]
    names = [{"n": "bob"}, {"n": "Alice"}, {"n": "carol"}]
    assert [r["n"] for r in LS.sort_rows(names, "n")] == ["Alice", "bob", "carol"]


SPEC = ListSpec("t", [Col("number", "Number", "code"), Col("name", "Name"), Col("date", "Date", "date"),
                      Col("amount", "Amount", "num")],
                sort="date", dir="desc", date_col="date", search=("name", "number"), per_page=3,
                choices=[Choice("st", "Status", [("open", "Open"), ("overdue", "Overdue"), ("paid", "Paid")],
                                where={"open": (" AND status='open'", []),
                                       "overdue": (" AND status='open' AND due < ?", ["2026-11-26"]),
                                       "paid": (" AND status='paid'", [])})])


@pytest.fixture
def mem():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE d (id INTEGER PRIMARY KEY, number TEXT, name TEXT, date TEXT, due TEXT, amount INTEGER,"
               " status TEXT)")
    data = [("INV00009", "Zed", "2025-06-30", "2025-07-30", 900, "paid"),
            ("INV00010", "amy", "2025-07-01", "2025-07-31", 10000, "open"),
            ("INV00100", "Bob", "2026-06-30", "2026-12-31", 2550, "open"),
            ("INV00011", "Cat", "2026-07-01", "2026-08-01", 300, "open"),
            ("INV00012", "Dan", "2026-11-02", "2026-12-02", 70000, "paid")]
    db.executemany("INSERT INTO d (number, name, date, due, amount, status) VALUES (?,?,?,?,?,?)", data)
    return db


def st(args, prefs=None, fy=7, today="2026-11-26"):
    return ListState(SPEC, MultiDict(args), fy_month=fy, today=today, prefs=prefs)


def test_sql_sorting_numbers_dates_and_codes(mem):
    s = st({"sort": "amount", "dir": "desc"})
    s.spec = ListSpec(**{**SPEC.__dict__, "per_page": None})
    assert [r["amount"] for r in s.fetch(mem, "SELECT * FROM d")] == [70000, 10000, 2550, 900, 300]
    s = st({"sort": "number", "dir": "asc"})
    s.spec = ListSpec(**{**SPEC.__dict__, "per_page": None})
    assert [r["number"] for r in s.fetch(mem, "SELECT * FROM d")] == ["INV00009", "INV00010", "INV00011", "INV00012",
                                                                      "INV00100"]
    s = st({"sort": "name"})  # text: A to Z, ignoring case
    s.spec = ListSpec(**{**SPEC.__dict__, "per_page": None})
    assert [r["name"] for r in s.fetch(mem, "SELECT * FROM d")] == ["amy", "Bob", "Cat", "Dan", "Zed"]


def test_default_sort_and_bad_values_are_ignored(mem):
    s = st({"sort": "drop table", "dir": "sideways", "year": "fy20x", "period": "forever", "st": "lost"})
    assert (s.sort, s.dir, s.year, s.period, s.choice["st"]) == ("date", "desc", "", "", "")
    assert "drop" not in s.order_by()


def test_july_june_financial_year_filter(mem):
    s = st({"year": "fy2025"})
    rows = s.fetch(mem, "SELECT * FROM d")
    assert sorted(r["date"] for r in rows) == ["2025-07-01", "2026-06-30"]  # 30 June 2025 and 1 July 2026 left out
    assert (s.shown, s.total) == (2, 5)


def test_january_december_financial_year_filter(mem):
    s = st({"year": "fy2026"}, fy=1)
    s.fetch(mem, "SELECT * FROM d")
    assert s.shown == 3  # 30 Jun, 1 Jul and 2 Nov 2026
    s = st({"year": "cy2025"}, fy=7)
    s.fetch(mem, "SELECT * FROM d")
    assert s.shown == 2


def test_period_and_year_narrow_together(mem):
    s = st({"period": "this_fy"})  # 1 Jul 2026 to 30 Jun 2027
    s.fetch(mem, "SELECT * FROM d")
    assert s.shown == 2
    s = st({"period": "last_fy", "year": "cy2026"})  # Jul 2025-Jun 2026 and 2026: Jan-Jun 2026
    rows = s.fetch(mem, "SELECT * FROM d")
    assert [r["date"] for r in rows] == ["2026-06-30"]
    s = st({"period": "custom", "from": "2026-06-30", "to": "2026-07-01"})
    s.fetch(mem, "SELECT * FROM d")
    assert s.shown == 2


def test_status_filter_and_search(mem):
    s = st({"st": "open"})
    s.fetch(mem, "SELECT * FROM d")
    assert (s.shown, s.total) == (3, 5)
    s = st({"st": "overdue"})
    assert [r["number"] for r in s.fetch(mem, "SELECT * FROM d")] == ["INV00011", "INV00010"]
    s = st({"q": "inv0001"})
    s.fetch(mem, "SELECT * FROM d")
    assert s.shown == 3 and s.filtered  # INV00010, INV00011, INV00012
    s = st({"q": "BOB"})
    assert [r["name"] for r in s.fetch(mem, "SELECT * FROM d")] == ["Bob"]


def test_paging_and_sums_cover_every_page(mem):
    s = st({"page": "2"})
    rows = s.fetch(mem, "SELECT * FROM d", sums=("amount",))
    assert [r["number"] for r in rows] == ["INV00010", "INV00009"]
    assert (s.pages, s.page_from, s.page_to, s.sums["amount"]) == (2, 4, 5, 83750)
    s = st({"page": "99"})
    s.fetch(mem, "SELECT * FROM d")
    assert s.page == 2


def test_python_lists_filter_and_sort_the_same_way():
    rows = [dict(number="INV00010", name="amy", date="2025-07-01", amount=10000, status="open"),
            dict(number="INV00009", name="Zed", date="2025-06-30", amount=900, status="paid"),
            dict(number="INV00012", name="Dan", date="2026-11-02", amount=70000, status="paid")]
    spec = ListSpec("p", SPEC.cols, sort="date", dir="desc", date_col="date", search=("name",), per_page=None,
                    choices=[Choice("st", "Status", [("open", "Open"), ("paid", "Paid")], col="status")])
    s = ListState(spec, MultiDict({"sort": "amount", "dir": "asc", "st": "paid"}), fy_month=7, today="2026-11-26")
    assert [r["amount"] for r in s.apply(rows)] == [900, 70000] and (s.shown, s.total) == (2, 3)
    s = ListState(spec, MultiDict({"year": "fy2025"}), fy_month=7, today="2026-11-26")
    assert [r["name"] for r in s.apply(rows)] == ["amy"]


def test_remembered_choice_comes_back_on_a_plain_visit_only():
    prefs = {"sort": "amount", "dir": "asc", "year": "fy2025", "period": "", "st": "open"}
    s = st({}, prefs=prefs)  # opened from the menu
    assert (s.sort, s.dir, s.year, s.choice["st"]) == ("amount", "asc", "fy2025", "open")
    s = st({"status": "open"}, prefs=prefs)  # a tab is not a filter: still remembered
    assert s.year == "fy2025"
    s = st({"st": "paid"}, prefs=prefs)  # a link that says something about the filters says it all
    assert (s.choice["st"], s.year, s.sort) == ("paid", "", "amount")
    s = st({"clear": "1"}, prefs=prefs)  # Clear filters keeps the sort
    assert (s.year, s.choice["st"], s.sort) == ("", "", "amount") and not s.filtered
    assert st({"year": "cy2026", "q": "x"}).remembered() == {
        "sort": "date", "dir": "desc", "year": "cy2026", "period": "", "from": "", "to": "", "st": ""}  # not the search


def test_old_from_to_links_still_work():
    spec = ListSpec("j", SPEC.cols, sort="date", date_col="date", from_param="start", to_param="end")
    s = ListState(spec, MultiDict({"start": "2026-01-01", "end": "2026-03-31"}), today="2026-11-26",
                  prefs={"period": "this_month"})
    assert s.period == "custom" and s.date_range() == ("2026-01-01", "2026-03-31")


def test_prefs_are_kept_per_user_and_list():
    db = sqlite3.connect(":memory:")
    LS.save_pref(db, 1, "list:a", {"sort": "name"})
    LS.save_pref(db, 2, "list:a", {"sort": "date"})
    LS.save_pref(db, 1, "list:b", {"sort": "amount"})
    assert LS.load_pref(db, 1, "list:a") == {"sort": "name"} and LS.load_pref(db, 2, "list:a") == {"sort": "date"}
    assert LS.load_pref(db, 1, "list:b") == {"sort": "amount"} and LS.load_pref(db, 3, "list:a") == {}
    assert LS.load_pref(db, None, "list:a") == {}


# ------------------------------------------------------------------ screens
@pytest.fixture
def app(tmp_path):
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "t.db")})
    with app.app_context():
        init_db("Test Co")
        db = get_db()
        c1 = db.execute("INSERT INTO contacts (kind, name, email) VALUES ('customer','Zebra Co','z@x.com')").lastrowid
        c2 = db.execute("INSERT INTO contacts (kind, name) VALUES ('customer','apple pty')").lastrowid
        c3 = db.execute("INSERT INTO contacts (kind, name, active) VALUES ('customer','Old Mate',0)").lastrowid
        db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Supplies R Us')")
        for n, cid, d, due, total, paid, status in [
                ("INV00001", c1, "2025-06-30", "2025-07-30", 90000, 0, "open"),
                ("INV00002", c2, "2025-07-01", "2025-07-31", 1500, 1500, "paid"),
                ("INV00010", c1, "2026-03-15", "2026-04-14", 25000, 0, "open"),
                ("INV00009", c2, "2026-07-02", "2099-01-01", 300, 0, "open"),
                ("INV00011", c3, "2026-08-02", "2026-09-01", 7700, 0, "void")]:
            db.execute("INSERT INTO documents (side, status, number, contact_id, date, due_date, total, amount_paid)"
                       " VALUES ('sale',?,?,?,?,?,?,?)", (status, n, cid, d, due, total, paid))
        for sku, name, cat, inv in [("B2", "Bolt", "Hardware", 1), ("A10", "Apron", "Clothing", 0),
                                    ("A9", "Anvil", "Hardware", 1), ("C1", "Cap", None, 0)]:
            db.execute("INSERT INTO items (sku, name, category, is_inventoried) VALUES (?,?,?,?)", (sku, name, cat, inv))
        db.commit()
    return app


@pytest.fixture
def client(app):
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return c


def body(r):
    assert r.status_code == 200
    return r.get_data(as_text=True)


def numbers(html):
    return re.findall(r"<td><b>(INV\d+)</b></td>", html)


def count(html):
    m = re.search(r'class="lcount"[^>]*><b>(\d+)</b> of (\d+)', html)
    return tuple(int(x) for x in m.groups())


def test_invoices_register_sorts_by_amount_and_filters_by_year(client):
    h = body(client.get("/sale/list?status=all&sort=total&dir=desc"))
    assert numbers(h) == ["INV00001", "INV00010", "INV00011", "INV00002", "INV00009"]
    assert 'aria-sort="descending"' in h and "▼" in h
    h = body(client.get("/sale/list?status=all&sort=total&dir=asc&year=fy2025"))  # 1 Jul 2025 - 30 Jun 2026
    assert numbers(h) == ["INV00002", "INV00010"] and count(h) == (2, 5)
    h = body(client.get("/sale/list?status=all&year=cy2026&sort=number&dir=asc"))
    assert numbers(h) == ["INV00009", "INV00010", "INV00011"]  # INV00009 before INV00010: by number


def test_invoices_register_status_filter_and_old_urls(client):
    h = body(client.get("/sale/list?status=open&st=overdue"))
    assert numbers(h) == ["INV00010", "INV00001"]
    h = body(client.get("/sale/list?status=all&st=void"))
    assert numbers(h) == ["INV00011"]
    h = body(client.get("/sale/list?status=open&q=zebra"))  # the old search link still works
    assert set(numbers(h)) == {"INV00001", "INV00010"} and "Clear filters" in h
    h = body(client.get("/sale/list"))
    assert count(h) == (3, 3)


def test_register_remembers_the_choice_for_each_user(client, app):
    body(client.get("/sale/list?status=all&sort=total&dir=asc&year=fy2025"))
    h = body(client.get("/sale/list?status=all"))  # back again from the menu / tab
    assert numbers(h) == ["INV00002", "INV00010"]
    h = body(client.get("/sale/list?status=all&clear=1"))
    assert numbers(h) == ["INV00009", "INV00002", "INV00011", "INV00010", "INV00001"]  # still by amount, all years
    with app.app_context():
        assert get_db().execute("SELECT COUNT(*) FROM user_prefs WHERE key='list:docs:sale:all'").fetchone()[0] == 1


def test_contacts_by_name_and_status(client):
    h = body(client.get("/cards/customer?sort=name&dir=asc"))
    names = re.findall(r"<td><b>([^<]+)</b></td>", h)
    assert names == ["apple pty", "Zebra Co", "Old Mate"]  # inactive cards stay at the bottom
    h = body(client.get("/cards/customer?sort=name&dir=desc&st=active"))
    assert re.findall(r"<td><b>([^<]+)</b></td>", h) == ["Zebra Co", "apple pty"] and count(h) == (2, 3)
    h = body(client.get("/cards/customer?owing=owing"))
    assert re.findall(r"<td><b>([^<]+)</b></td>", h) == ["Zebra Co", "apple pty"]


def test_items_by_category_and_type(client):
    h = body(client.get("/inventory/?sort=category&dir=asc"))
    assert re.findall(r"<td><b>([^<]+)</b></td>", h) == ["A10", "A9", "B2", "C1"]  # Clothing, Hardware x2, none last
    h = body(client.get("/inventory/?cat=Hardware&sort=sku"))
    assert re.findall(r"<td><b>([^<]+)</b></td>", h) == ["A9", "B2"]
    h = body(client.get("/inventory/?type=Non-stock"))
    assert count(h) == (2, 4)


def test_other_lists_take_the_same_query_string(client):
    for url in ["/sale/payments?sort=amount&year=fy2025", "/purchase/list?status=all&period=last_fy",
                "/journal?start=2026-01-01&end=2026-06-30&sort=amt", "/journal?source=banking",
                "/setup/audit?sort=action&dir=asc", "/payroll/?e_sort=rate&r_year=fy2025",
                "/inventory/low-stock?sort=on_order", "/expenses/?show=all&period=this_month",
                "/accounts?type=asset&sort=balance", "/users?sort=role", "/reports/?q=gst",
                "/bookings/list?show=all&period=this_fy&sort=customer", "/bookings/jobs?sort=visits&st=requested",
                "/cards/supplier?sort=balance&dir=desc", "/pos/sales/all?sort=total&year=cy2026",
                "/pos/approvals?sort=amount", "/setup/email/?st=sent"]:
        r = client.get(url)
        assert r.status_code == 200, url
