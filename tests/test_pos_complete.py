"""Riyeser POS 2.11 (feat/pos-complete): product variants, stock locations and transfers, table moves and split
bills, the cash drawer and the kitchen display screen. Synthetic data only. Every test that posts anything ends with
the full books check from the QA pass (tests/test_qa_apps.py: books_consistent)."""
import io
import json
from datetime import date

import pytest

from riyeser import create_app
from riyeser.db import get_db, init_db
from riyeser import ledger as L
from riyeser import locations as LOC
from riyeser import drawer as D
from tests.test_qa_apps import books_consistent, ids

TODAY = date.today().isoformat()


@pytest.fixture
def shop(tmp_path, monkeypatch):
    monkeypatch.setenv("RIYESER_APP_EDITION", "pos")
    printer = D.FakePrinter()
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "shop.db"), "RAW_PRINTER": printer})
    with app.app_context():
        init_db("Synthetic Surf Shop")
        db = get_db()
        acc, tc = ids(db)
        sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Synthetic Supplier')").lastrowid
        tee = db.execute("INSERT INTO items (sku, name, is_inventoried, is_sold, is_bought, income_account_id,"
                         " expense_account_id, asset_account_id, sell_price, buy_price, sale_tax_code_id,"
                         " purchase_tax_code_id, category, active) VALUES ('TEE','Classic Tee',1,1,1,?,?,?,3000,1200,"
                         "?,?,'Clothing',1)", (acc["4-1000"], acc["5-1000"], acc["1-1300"], tc["GST"], tc["GST"])).lastrowid
        tea = db.execute("INSERT INTO items (sku, name, is_inventoried, is_sold, is_bought, income_account_id,"
                         " expense_account_id, asset_account_id, sell_price, buy_price, sale_tax_code_id, category,"
                         " active) VALUES ('T1','Tea',1,1,1,?,?,?,302,117,?,'Drinks',1)",
                         (acc["4-1000"], acc["5-1000"], acc["1-1300"], tc["GST"])).lastrowid
        L.save_document(db, "purchase", dict(contact_id=sup, date=TODAY),
                        [dict(item_id=tea, qty=20, unit_price=117, tax_code_id=tc["GST"])], "open")
        db.commit()
    c = app.test_client()
    c.post("/login", data={"username": "admin", "password": "admin"})
    return dict(app=app, c=c, tee=tee, tea=tea, sup=sup, printer=printer, acc=acc, tc=tc)


def ok(db):
    bad = books_consistent(db)
    assert bad == [], bad
    # every location (and what's in transit) adds up to the total on hand, for every item
    for i in db.execute("SELECT id, qty_on_hand FROM items WHERE is_inventoried=1"):
        locs = [l["id"] for l in LOC.stores(db, active_only=False)] + [LOC.transit_id(db)]
        assert abs(sum(LOC.qty_at(db, i["id"], l) for l in locs) - i["qty_on_hand"]) < 1e-9


def gen_variants(s, sizes="S, M, L", colours="Navy, White"):
    return s["c"].post(f"/inventory/{s['tee']}/variants", data={
        "what": "generate", "opt_name_1": "Colour", "opt_values_1": colours, "opt_name_2": "Size",
        "opt_values_2": sizes})


def variant(db, pid, *vals):
    for r in db.execute("SELECT * FROM items WHERE parent_id=?", (pid,)):
        if json.loads(r["variant_values"]) == list(vals):
            return r
    raise AssertionError(vals)


def buy(s, item, qty, cost, location_id=None):
    with s["app"].app_context():
        db = get_db()
        L.save_document(db, "purchase", dict(contact_id=s["sup"], date=TODAY, location_id=location_id),
                        [dict(item_id=item, qty=qty, unit_price=cost, tax_code_id=s["tc"]["GST"])], "open")
        db.commit()


def add_location(s, name):
    s["c"].post("/inventory/locations", data={"new_name": name})
    with s["app"].app_context():
        return get_db().execute("SELECT id FROM stock_locations WHERE name=?", (name,)).fetchone()[0]


def restaurant(s):
    with s["app"].app_context():
        db = get_db()
        db.execute("UPDATE company SET pos_mode='restaurant'")
        db.commit()


def till_id(s):
    with s["app"].app_context():
        return get_db().execute("SELECT id FROM pos_tills ORDER BY id LIMIT 1").fetchone()[0]


# ================================================================ variants
def test_variants_generate_each_combination_with_its_own_sku_price_and_stock(shop):
    s = shop
    r = gen_variants(s)
    assert r.status_code == 302
    with s["app"].app_context():
        db = get_db()
        kids = db.execute("SELECT * FROM items WHERE parent_id=? ORDER BY id", (s["tee"],)).fetchall()
        assert len(kids) == 6 and len({k["sku"] for k in kids}) == 6
        assert {tuple(json.loads(k["variant_values"])) for k in kids} == {
            (c, z) for c in ("Navy", "White") for z in ("S", "M", "L")}
        assert all(k["is_inventoried"] and k["is_sold"] and k["sell_price"] == 3000 for k in kids)
        p = db.execute("SELECT * FROM items WHERE id=?", (s["tee"],)).fetchone()
        assert p["has_variants"] and not p["is_sold"] and not p["is_inventoried"]  # the product holds no stock
        nm = variant(db, s["tee"], "Navy", "M")
        assert nm["name"] == "Classic Tee (Navy / M)" and nm["sku"] == "TEE-NAVY-M"
    # generating again makes nothing new; adding a size makes only the new combinations
    gen_variants(s)
    gen_variants(s, sizes="S, M, L, XL")
    with s["app"].app_context():
        assert get_db().execute("SELECT COUNT(*) FROM items WHERE parent_id=?", (s["tee"],)).fetchone()[0] == 8
    # a choice already used can't be taken away
    r = gen_variants(s, sizes="S, M")
    with s["app"].app_context():
        assert get_db().execute("SELECT COUNT(*) FROM items WHERE parent_id=?", (s["tee"],)).fetchone()[0] == 8


def test_variant_prices_barcodes_opening_stock_and_sale_cost_per_variant(shop):
    s, c = shop, shop["c"]
    gen_variants(s)
    with s["app"].app_context():
        db = get_db()
        kids = db.execute("SELECT * FROM items WHERE parent_id=? ORDER BY id", (s["tee"],)).fetchall()
        nm, ws = variant(db, s["tee"], "Navy", "M"), variant(db, s["tee"], "White", "S")
    form = {"what": "save"}
    for k in kids:
        form.update({f"sku_{k['id']}": k["sku"], f"price_{k['id']}": "30.00", f"cost_{k['id']}": "12.00",
                     f"reorder_{k['id']}": "1", f"active_{k['id']}": "1"})
    form.update({f"price_{nm['id']}": "32.00", f"cost_{nm['id']}": "13.00", f"barcodes_{nm['id']}": "9300000000011",
                 f"opening_{nm['id']}": "5", f"opening_{ws['id']}": "2", f"barcodes_{ws['id']}": "9300000000028"})
    assert c.post(f"/inventory/{s['tee']}/variants", data=form).status_code == 302
    with s["app"].app_context():
        db = get_db()
        nm = db.execute("SELECT * FROM items WHERE id=?", (nm["id"],)).fetchone()
        assert (nm["sell_price"], nm["buy_price"], nm["qty_on_hand"], nm["barcodes"]) == (3200, 1300, 5, "9300000000011")
        ok(db)
    # the same barcode on two variants is refused
    bad = dict(form, **{f"barcodes_{ws['id']}": "9300000000011", f"opening_{nm['id']}": "", f"opening_{ws['id']}": ""})
    c.post(f"/inventory/{s['tee']}/variants", data=bad)
    with s["app"].app_context():
        assert get_db().execute("SELECT barcodes FROM items WHERE id=?", (ws["id"],)).fetchone()[0] == "9300000000028"
    # sell 2 Navy/M at the till: its own price (inc GST), its own stock and its own cost of sales
    r = c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": 10000}],
                                  "lines": [{"item_id": nm["id"], "qty": 2}], "checkout_ref": "v-1"}).get_json()
    assert r["ok"] and r["total"] == 2 * 3520
    # the product itself can't be sold
    assert not c.post("/pos/sale", json={"method": "card", "lines": [{"item_id": s["tee"], "qty": 1}]}).get_json()["ok"]
    with s["app"].app_context():
        db = get_db()
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (nm["id"],)).fetchone()[0] == 3
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (ws["id"],)).fetchone()[0] == 2
        cogs = db.execute("SELECT SUM(-qty*unit_cost) FROM stock_movements WHERE item_id=? AND source_type='invoice'",
                          (nm["id"],)).fetchone()[0]
        assert round(cogs) == 2600
        from riyeser.views import reports as R
        from flask import current_app
        with current_app.test_request_context(f"/reports/x?start={TODAY}&end={TODAY}"):
            p = R._params(db)
            val = R.rpt_inventory_valuation(db, p)
            rows = {r["cells"][0]: r["cells"] for r in val["rows"] if r["cells"][0]}
            assert rows[nm["sku"]][2] == "3" and rows[nm["sku"]][4] == 3900 and "TEE" not in rows
            sales = {r["cells"][0]: r["cells"] for r in R.rpt_sales_item(db, p)["rows"]}
            assert sales[nm["sku"]][2] == "2" and sales[nm["sku"]][4] == 2600
        ok(db)


def test_till_shows_one_tile_per_product_with_its_variants_and_barcodes(shop):
    s, c = shop, shop["c"]
    gen_variants(s)
    with s["app"].app_context():
        db = get_db()
        nm = variant(db, s["tee"], "Navy", "M")
        db.execute("UPDATE items SET barcodes='9300000000011' WHERE id=?", (nm["id"],))
        db.commit()
    page = c.get("/pos/").get_data(as_text=True)
    items = json.loads(page.split("ITEMS=", 1)[1].split(", CATS=", 1)[0])
    prod = next(i for i in items if i["id"] == s["tee"])
    assert prod["kind"] == "product" and len(prod["kids"]) == 6 and prod["options"][0]["name"] == "Colour"
    v = next(i for i in items if i["id"] == nm["id"])
    assert v["parent"] == s["tee"] and v["vals"] == ["Navy", "M"] and v["barcodes"] == ["9300000000011"]
    tea = next(i for i in items if i["id"] == s["tea"])
    assert "kind" not in tea and tea["parent"] is None          # an item without variants is as before
    assert "Choose" in page and 'id="mVar"' in page             # the quick picker


def test_stock_on_hand_moves_to_the_chosen_variant(shop):
    s = shop
    buy(s, s["tee"], 4, 1200)
    with s["app"].app_context():
        before = L.balances(get_db()).get(s["acc"]["1-1300"])
    r = gen_variants(s)        # no variant chosen for the 4 on hand: refused, nothing made
    with s["app"].app_context():
        assert get_db().execute("SELECT COUNT(*) FROM items WHERE parent_id=?", (s["tee"],)).fetchone()[0] == 0
    s["c"].post(f"/inventory/{s['tee']}/variants", data={
        "what": "generate", "opt_name_1": "Colour", "opt_values_1": "Navy, White", "stock_to": "Navy"})
    with s["app"].app_context():
        db = get_db()
        navy = variant(db, s["tee"], "Navy")
        assert navy["qty_on_hand"] == 4 and navy["avg_cost"] == 1200
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (s["tee"],)).fetchone()[0] == 0
        assert L.balances(db).get(s["acc"]["1-1300"]) == before   # same stock, same value: no journal needed
        ok(db)


def test_variants_csv_export_and_import(shop):
    s, c = shop, shop["c"]
    gen_variants(s, sizes="S, M", colours="Navy")
    csv_out = c.get("/inventory/variants.csv").get_data(as_text=True)
    lines = csv_out.strip().splitlines()
    assert lines[0].startswith("product_sku,product,option1,value1") and len(lines) == 3
    assert "TEE-NAVY-M" in csv_out
    # update a price and a barcode, add a new size with opening stock, and a brand-new product
    imp = ("product_sku,product,option1,value1,option2,value2,option3,value3,sku,barcodes,sell_price_ex_tax,"
           "buy_price,reorder_level,on_hand,active\n"
           "TEE,Classic Tee,Colour,Navy,Size,M,,,TEE-NAVY-M,9300000000099,33.00,,,,yes\n"
           "TEE,Classic Tee,Colour,Navy,Size,L,,,TEE-NAVY-L,,30.00,12.00,2,3,yes\n"
           "CAP,Surf Cap,Colour,Black,,,,,CAP-BLK,9300000000105,20.00,8.00,,4,yes\n")
    r = c.post("/inventory/variants/import", data={"file": (io.BytesIO(imp.encode()), "v.csv")},
               content_type="multipart/form-data")
    assert r.status_code == 302
    with s["app"].app_context():
        db = get_db()
        m = db.execute("SELECT * FROM items WHERE sku='TEE-NAVY-M'").fetchone()
        assert m["sell_price"] == 3300 and m["barcodes"] == "9300000000099"
        l_ = db.execute("SELECT * FROM items WHERE sku='TEE-NAVY-L'").fetchone()
        assert l_["parent_id"] == s["tee"] and l_["qty_on_hand"] == 3 and l_["reorder_level"] == 2
        cap = db.execute("SELECT * FROM items WHERE sku='CAP-BLK'").fetchone()
        assert cap["qty_on_hand"] == 4 and db.execute("SELECT has_variants FROM items WHERE id=?",
                                                      (cap["parent_id"],)).fetchone()[0] == 1
        n = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        ok(db)
    # a file with a problem imports nothing
    bad = imp.replace("TEE-NAVY-L,,30.00", "TEE-NAVY-M,,30.00").replace("CAP-BLK,9300000000105", "CAP-RED,1")
    bad += "XX,,Colour,Red,,,,,XX-R,,1.00,,,,yes\n"
    c.post("/inventory/variants/import", data={"file": (io.BytesIO(bad.encode()), "v.csv")},
           content_type="multipart/form-data")
    with s["app"].app_context():
        assert get_db().execute("SELECT COUNT(*) FROM items").fetchone()[0] == n


# ================================================================ locations and transfers
def test_existing_stock_is_at_main_and_tills_belong_to_it(shop):
    s = shop
    with s["app"].app_context():
        db = get_db()
        main = LOC.default_id(db)
        assert db.execute("SELECT name FROM stock_locations WHERE id=?", (main,)).fetchone()[0] == "Main"
        assert LOC.qty_at(db, s["tea"], main) == 20
        assert db.execute("SELECT COUNT(*) FROM stock_movements WHERE location_id IS NULL").fetchone()[0] == 0
        assert db.execute("SELECT location_id FROM pos_tills").fetchone()[0] == main
        assert not LOC.several(db)


def test_an_older_company_file_gets_main_with_its_stock(tmp_path, monkeypatch):
    """A file from before locations (stock_movements without a location column) opens with everything at Main."""
    monkeypatch.setenv("RIYESER_APP_EDITION", "pos")
    app = create_app({"TESTING": True, "DATABASE": str(tmp_path / "old.db")})
    with app.app_context():
        init_db("Older Shop")
        db = get_db()
        db.execute("PRAGMA foreign_keys = OFF")
        for t in ("stock_levels", "location_levels", "stock_transfer_lines", "stock_transfers", "stock_locations"):
            db.execute(f"DROP TABLE {t}")
        db.execute("ALTER TABLE stock_movements DROP COLUMN location_id")
        db.execute("ALTER TABLE pos_tills DROP COLUMN location_id")
        db.execute("INSERT INTO items (sku, name, is_inventoried, qty_on_hand, avg_cost) VALUES ('OLD','Old',1,7,100)")
        db.execute("INSERT INTO stock_movements (item_id, date, qty, unit_cost, source_type) VALUES (1,?,7,100,'bill')",
                   (TODAY,))
        db.commit()
        from riyeser.db import migrate
        migrate(db)
        main = LOC.default_id(db)
        assert LOC.qty_at(db, 1, main) == 7
        assert db.execute("SELECT location_id FROM stock_movements").fetchone()[0] == main
        assert db.execute("SELECT location_id FROM pos_tills").fetchone()[0] == main


def test_sales_take_stock_from_the_tills_location_and_a_variant_sold_out_there_is_short(shop):
    s, c = shop, shop["c"]
    gen_variants(s, sizes="M", colours="Navy")
    with s["app"].app_context():
        db = get_db()
        nm = variant(db, s["tee"], "Navy", "M")
        db.execute("UPDATE items SET block_oversell=1 WHERE id=?", (nm["id"],))
        db.commit()
    buy(s, nm["id"], 5, 1200)                      # 5 at Main
    branch = add_location(s, "Beach Kiosk")
    c.post("/pos/setup", data={"mode": "retail", "new_till": "Kiosk till", "new_till_stock": str(branch)})
    with s["app"].app_context():
        db = get_db()
        kiosk = db.execute("SELECT id FROM pos_tills WHERE name='Kiosk till'").fetchone()["id"]
        assert db.execute("SELECT location_id FROM pos_tills WHERE id=?", (kiosk,)).fetchone()[0] == branch
    # sold out at the kiosk (all 5 are at Main): refused there, even though the shop has 5
    r = c.post("/pos/sale", json={"method": "card", "till_id": kiosk, "lines": [{"item_id": nm["id"], "qty": 1}]})
    assert r.status_code == 409 and "Beach Kiosk" in r.get_json()["error"] and not r.get_json()["confirm_stock"]
    # tea isn't blocked: the till asks first, and selling anyway takes it below 0 at the kiosk only
    r = c.post("/pos/sale", json={"method": "card", "till_id": kiosk, "lines": [{"item_id": s["tea"], "qty": 2}]})
    assert r.status_code == 409 and r.get_json()["confirm_key"] == "sell_anyway"
    r = c.post("/pos/sale", json={"method": "card", "till_id": kiosk, "sell_anyway": True,
                                  "lines": [{"item_id": s["tea"], "qty": 2}]}).get_json()
    assert r["ok"]
    # at the main till it sells, from Main
    r = c.post("/pos/sale", json={"method": "card", "till_id": till_id(s), "lines": [{"item_id": nm["id"], "qty": 1}]})
    assert r.get_json()["ok"]
    with s["app"].app_context():
        db = get_db()
        assert LOC.qty_at(db, nm["id"], None) == 4 and LOC.qty_at(db, nm["id"], branch) == 0
        assert LOC.qty_at(db, s["tea"], branch) == -2 and LOC.qty_at(db, s["tea"], None) == 20
        ok(db)
    # the till's tiles carry stock per location
    page = c.get("/pos/").get_data(as_text=True)
    items = json.loads(page.split("ITEMS=", 1)[1].split(", CATS=", 1)[0])
    v = next(i for i in items if i["id"] == nm["id"])
    with s["app"].app_context():
        main = LOC.default_id(get_db())
    assert v["stocks"][str(branch)] == 0 and v["stocks"][str(main)] == 4


def test_transfer_draft_sent_part_received_then_closed_keeps_inventory_value(shop):
    s, c = shop, shop["c"]
    branch = add_location(s, "Warehouse")
    with s["app"].app_context():
        db = get_db()
        main = LOC.default_id(db)
        inv_before = L.balances(db).get(s["acc"]["1-1300"])
        entries_before = db.execute("SELECT COUNT(*) FROM journal_entries").fetchone()[0]
    r = c.post("/inventory/transfers/new", data={"from_id": main, "to_id": branch, "line_item": [s["tea"]],
                                                 "line_qty": ["8"], "then": "draft", "note": "Restock"})
    assert r.status_code == 302
    with s["app"].app_context():
        db = get_db()
        t = db.execute("SELECT * FROM stock_transfers").fetchone()
        assert t["status"] == "draft" and t["number"] == "TR00001"
        assert LOC.qty_at(db, s["tea"], main) == 20                   # a draft moves nothing
    # more than there is can't be sent
    c.post(f"/inventory/transfers/{t['id']}/edit", data={"from_id": main, "to_id": branch, "line_item": [s["tea"]],
                                                         "line_qty": ["25"], "then": "send"})
    with s["app"].app_context():
        assert get_db().execute("SELECT status FROM stock_transfers").fetchone()[0] == "draft"
    c.post(f"/inventory/transfers/{t['id']}/edit", data={"from_id": main, "to_id": branch, "line_item": [s["tea"]],
                                                         "line_qty": ["8"], "then": "draft"})
    c.post(f"/inventory/transfers/{t['id']}/send", data={"_once": "send-1"})
    c.post(f"/inventory/transfers/{t['id']}/send", data={"_once": "send-1"})   # sent twice: once
    with s["app"].app_context():
        db = get_db()
        assert db.execute("SELECT status FROM stock_transfers").fetchone()[0] == "sent"
        assert LOC.qty_at(db, s["tea"], main) == 12 and LOC.qty_at(db, s["tea"], LOC.transit_id(db)) == 8
        assert LOC.qty_at(db, s["tea"], branch) == 0
        line = db.execute("SELECT id FROM stock_transfer_lines").fetchone()[0]
        ok(db)
    # part received: 5 of 8 arrive
    c.post(f"/inventory/transfers/{t['id']}/receive", data={f"recv_{line}": "5"})
    assert "can receive at most" not in c.get(f"/inventory/transfers/{t['id']}").get_data(as_text=True)
    with s["app"].app_context():
        db = get_db()
        assert db.execute("SELECT status FROM stock_transfers").fetchone()[0] == "partial"
        assert LOC.qty_at(db, s["tea"], branch) == 5 and LOC.qty_at(db, s["tea"], LOC.transit_id(db)) == 3
        ok(db)
    # more than what's still in transit is refused
    c.post(f"/inventory/transfers/{t['id']}/receive", data={f"recv_{line}": "4"})
    with s["app"].app_context():
        assert LOC.qty_at(get_db(), s["tea"], branch) == 5
    # close it: the 3 that didn't arrive go back to Main
    c.post(f"/inventory/transfers/{t['id']}/return")
    with s["app"].app_context():
        db = get_db()
        assert db.execute("SELECT status FROM stock_transfers").fetchone()[0] == "received"
        assert (LOC.qty_at(db, s["tea"], main), LOC.qty_at(db, s["tea"], branch)) == (15, 5)
        assert LOC.qty_at(db, s["tea"], LOC.transit_id(db)) == 0
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (s["tea"],)).fetchone()[0] == 20
        assert L.balances(db).get(s["acc"]["1-1300"]) == inv_before   # Inventory value unchanged
        assert db.execute("SELECT COUNT(*) FROM journal_entries").fetchone()[0] == entries_before
        ok(db)
    page = c.get(f"/inventory/transfers/{t['id']}/docket").get_data(as_text=True)
    assert "TR00001" in page and "Warehouse" in page and "Received by" in page


def test_stocktake_at_one_location_and_reorder_per_location(shop):
    s, c = shop, shop["c"]
    branch = add_location(s, "Market Stall")
    with s["app"].app_context():
        db = get_db()
        main = LOC.default_id(db)
        db.execute("UPDATE items SET reorder_level=5 WHERE id=?", (s["tea"],))
        db.commit()
    c.post("/inventory/transfers/new", data={"from_id": main, "to_id": branch, "line_item": [s["tea"]],
                                             "line_qty": ["6"], "then": "send"})
    with s["app"].app_context():
        line = get_db().execute("SELECT id, transfer_id FROM stock_transfer_lines").fetchone()
    c.post(f"/inventory/transfers/{line['transfer_id']}/receive", data={f"recv_{line['id']}": "6"})
    # count 4 at the stall: 2 missing there, Main untouched
    page = c.get(f"/inventory/count?loc={branch}").get_data(as_text=True)
    assert "Stocktake at Market Stall" in page
    c.post(f"/inventory/count?loc={branch}", data={"date": TODAY, "loc": branch, f"count_{s['tea']}": "4"})
    with s["app"].app_context():
        db = get_db()
        assert LOC.qty_at(db, s["tea"], branch) == 4 and LOC.qty_at(db, s["tea"], main) == 14
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (s["tea"],)).fetchone()[0] == 18
        from riyeser.views.reorder import low_stock
        low = lambda **kw: {r["id"] for r in low_stock(db, **kw)}
        assert s["tea"] in low(location_id=branch)                                 # 4 <= 5 at the stall
        assert s["tea"] not in low(location_id=main)                               # 14 at Main
        assert s["tea"] not in low()                                               # 18 in total
        ok(db)
    # the stall's own level
    c.post(f"/inventory/locations/{branch}", data={f"level_{s['tea']}": "2"})
    with s["app"].app_context():
        from riyeser.views.reorder import low_stock
        assert s["tea"] not in {r["id"] for r in low_stock(get_db(), location_id=branch)}
    assert "Market Stall" in c.get(f"/inventory/low-stock?loc={branch}").get_data(as_text=True)


def test_refund_and_void_put_stock_back_where_it_was_sold(shop):
    s, c = shop, shop["c"]
    branch = add_location(s, "Kiosk")
    c.post("/pos/setup", data={"mode": "retail", "new_till": "Kiosk till", "new_till_stock": str(branch)})
    with s["app"].app_context():
        db = get_db()
        kiosk = db.execute("SELECT id FROM pos_tills WHERE name='Kiosk till'").fetchone()["id"]
    r = c.post("/pos/sale", json={"method": "card", "till_id": kiosk, "sell_anyway": True,
                                  "lines": [{"item_id": s["tea"], "qty": 3}]}).get_json()
    with s["app"].app_context():
        db = get_db()
        lid = db.execute("SELECT id FROM document_lines WHERE document_id=(SELECT document_id FROM pos_sales WHERE"
                         " id=?)", (r["sale_id"],)).fetchone()[0]
    assert c.post(f"/pos/sale/{r['sale_id']}/refund", json={"lines": {str(lid): 1}, "method": "card"}).get_json()["ok"]
    r2 = c.post("/pos/sale", json={"method": "card", "till_id": kiosk, "sell_anyway": True,
                                   "lines": [{"item_id": s["tea"], "qty": 1}]}).get_json()
    c.post(f"/pos/sale/{r2['sale_id']}/void", data={"reason": "test"})
    with s["app"].app_context():
        db = get_db()
        assert LOC.qty_at(db, s["tea"], branch) == -2 and LOC.qty_at(db, s["tea"], None) == 20
        ok(db)


# ================================================================ restaurant tables
def order(c, table, lines, kitchen=False, oid=None):
    return c.post("/pos/order", json={"id": oid, "order_type": "dine_in", "table_no": table, "kitchen": kitchen,
                                      "lines": lines}).get_json()


def test_move_order_items_and_merge_keep_kitchen_sends_and_are_audited(shop):
    s, c = shop, shop["c"]
    restaurant(s)
    with s["app"].app_context():
        db = get_db()
        db.execute("UPDATE pos_stations SET output='both'")
        db.commit()
    o = order(c, "4", [{"item_id": s["tea"], "qty": 3, "note": "oat milk"}], kitchen=True)
    assert o["ok"] and o["docket_url"] and o["order"]["lines"][0]["sent"]
    uid = o["order"]["lines"][0]["uid"]
    # add a second item and send again: only the new item goes
    lines = o["order"]["lines"] + [{"item_id": s["tea"], "qty": 1, "note": "no sugar"}]
    o = order(c, "4", lines, kitchen=True, oid=o["id"])
    with s["app"].app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM kds_tickets").fetchone()[0] == 2
        assert db.execute("SELECT COUNT(*) FROM kds_items").fetchone()[0] == 2
    # move 1 of the 3 oat-milk teas to table 7
    r = c.post(f"/pos/order/{o['id']}/move-items", json={"lines": {uid: 1}, "table_no": "7"}).get_json()
    assert r["ok"], r
    t7 = r["moved_to"]
    o7 = next(x for x in c.get("/pos/orders").get_json() if x["id"] == t7)
    assert o7["table_no"] == "7" and o7["lines"][0]["qty"] == 1 and o7["lines"][0]["sent"]
    assert o7["lines"][0]["moved_from"] == "Table 4"
    # the moved item is not sent to the kitchen again from table 7
    o7b = order(c, "7", o7["lines"], kitchen=True, oid=t7)
    assert o7b["nothing_new"] and not o7b["docket_url"]
    with s["app"].app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM kds_items").fetchone()[0] == 3      # split, not re-sent
        k = db.execute("SELECT k.* FROM kds_items k JOIN kds_tickets t ON t.id=k.ticket_id WHERE t.order_id=?",
                       (t7,)).fetchone()
        assert k["moved_from"] == "Table 4" and k["qty"] == 1
    # move the whole of table 7 to table 9, then merge table 9 into table 4
    r = c.post(f"/pos/order/{t7}/move", json={"table_no": "9"}).get_json()
    assert r["ok"] and r["order"]["table_no"] == "9"
    r = c.post(f"/pos/order/{t7}/merge", json={"into": o["id"]}).get_json()
    assert r["ok"] and r["merged_into"] == o["id"]
    assert sum(l["qty"] for l in r["order"]["lines"]) == 4
    with s["app"].app_context():
        db = get_db()
        assert db.execute("SELECT status FROM pos_orders WHERE id=?", (t7,)).fetchone()[0] == "merged"
        kinds = [r[0] for r in db.execute("SELECT kind FROM pos_order_events ORDER BY id")]
        assert {"move_items", "items_in", "move", "merge", "merged"} <= set(kinds)
        assert db.execute("SELECT COUNT(*) FROM audit_log WHERE action LIKE 'pos_order_%'").fetchone()[0] >= 5
    hist = c.get(f"/pos/order/{o['id']}/history").get_json()
    assert any(h["kind"] == "merge" for h in hist)
    # a table that's already taken can't get a second order
    assert not order(c, "4", [{"item_id": s["tea"], "qty": 1}])["ok"]


def bill_order(s, qty=3, price=None):
    restaurant(s)
    if price is not None:
        with s["app"].app_context():
            db = get_db()
            db.execute("UPDATE items SET sell_price=? WHERE id=?", (price, s["tea"]))
            db.commit()
    return order(s["c"], "5", [{"item_id": s["tea"], "qty": qty}])


def test_split_evenly_rounds_to_the_cent_and_each_part_is_paid_separately(shop):
    s, c = shop, shop["c"]
    o = bill_order(s, qty=1, price=9091)                     # $90.91 ex GST -> $100.00 inc GST
    r = c.post(f"/pos/order/{o['id']}/split", json={"mode": "even", "guests": 3, "till_id": till_id(s)}).get_json()
    assert r["ok"], r
    b = r["order"]["bill"]
    assert [p["amount"] for p in b["parts"]] == [3334, 3333, 3333] and sum(p["amount"] for p in b["parts"]) == 10000
    assert r["order"]["status"] == "billing"
    # the order can't be changed while it's being paid
    assert not order(c, "5", [{"item_id": s["tea"], "qty": 9}], oid=o["id"])["ok"]
    p1, p2, p3 = [p["id"] for p in b["parts"]]
    r1 = c.post(f"/pos/bill/{b['id']}/pay", json={"part_id": p1, "tenders": [{"method": "cash", "tendered": 5000}],
                                                   "checkout_ref": "part-1", "till_id": till_id(s)}).get_json()
    assert r1["ok"] and r1["change"] == 1666 and not r1["closed"]
    again = c.post(f"/pos/bill/{b['id']}/pay", json={"part_id": p1, "tenders": [{"method": "cash", "tendered": 5000}],
                                                      "checkout_ref": "part-1"}).get_json()
    assert again["repeat"]                                    # sent twice: paid once
    with s["app"].app_context():
        ok(get_db())                                          # part paid: the rest is still owed (Debtors)
    r2 = c.post(f"/pos/bill/{b['id']}/pay", json={"part_id": p2, "tenders": [{"method": "card", "amount": 3333}],
                                                   "checkout_ref": "part-2"}).get_json()
    assert r2["ok"]
    r3 = c.post(f"/pos/bill/{b['id']}/pay", json={"part_id": p3, "checkout_ref": "part-3", "tenders": [
        {"method": "card", "amount": 1000}, {"method": "cash", "tendered": 2333}]}).get_json()
    assert r3["ok"] and r3["closed"] and r3["method"] == "split"
    assert not c.post(f"/pos/bill/{b['id']}/pay", json={"part_id": p3, "tenders": [{"method": "card", "amount": 3333}],
                                                         "checkout_ref": "part-3b"}).get_json()["ok"]
    with s["app"].app_context():
        db = get_db()
        doc = db.execute("SELECT d.* FROM documents d JOIN pos_sales p ON p.document_id=d.id WHERE p.id=?",
                         (b["sale_id"],)).fetchone()
        assert doc["status"] == "paid" and doc["amount_paid"] == 10000
        assert db.execute("SELECT status FROM pos_orders WHERE id=?", (o["id"],)).fetchone()[0] == "paid"
        cash = db.execute("SELECT SUM(amount) FROM pos_tenders WHERE sale_id=? AND method='cash'",
                          (b["sale_id"],)).fetchone()[0]
        assert cash == 3334 + 2333
        ok(db)
    rc = c.get(f"/pos/receipt/{b['sale_id']}?part={p2}").get_data(as_text=True)
    assert "GUEST 2 PAID" in rc and "$33.33" in rc


def test_split_by_item_shares_lines_to_the_cent_and_custom_amounts_must_add_up(shop):
    s, c = shop, shop["c"]
    o = bill_order(s, qty=3)                                  # 3 x $3.32 = $9.96
    uid = o["order"]["lines"][0]["uid"]
    # not every item on someone's part
    r = c.post(f"/pos/order/{o['id']}/split", json={"mode": "items", "guests": [{uid: 1}, {uid: 1}]}).get_json()
    assert not r["ok"] and "every item" in r["error"]
    # one guest has 1, the other 2; and a shared split three ways of one line
    r = c.post(f"/pos/order/{o['id']}/split", json={"mode": "items", "guests": [{uid: 1}, {uid: 2}]}).get_json()
    assert r["ok"] and [p["amount"] for p in r["order"]["bill"]["parts"]] == [332, 664]
    b = r["order"]["bill"]
    assert c.post(f"/pos/bill/{b['id']}/undo").get_json()["ok"]                # nobody paid: undo is fine
    r = c.post(f"/pos/order/{o['id']}/split", json={"mode": "items", "guests": [{uid: 1.5}, {uid: 1.5}]}).get_json()
    assert [p["amount"] for p in r["order"]["bill"]["parts"]] == [498, 498]
    c.post(f"/pos/bill/{r['order']['bill']['id']}/undo")
    # custom amounts that don't add up are refused; ones that do are fine
    r = c.post(f"/pos/order/{o['id']}/split", json={"mode": "amounts", "guests": [500, 400]}).get_json()
    assert not r["ok"] and "$9.96" in r["error"]
    r = c.post(f"/pos/order/{o['id']}/split", json={"mode": "amounts", "guests": [500, 496]}).get_json()
    assert r["ok"]
    b = r["order"]["bill"]
    c.post(f"/pos/bill/{b['id']}/pay", json={"part_id": b["parts"][0]["id"], "checkout_ref": "c-1",
                                             "tenders": [{"method": "card", "amount": 500}]})
    assert not c.post(f"/pos/bill/{b['id']}/undo").get_json()["ok"]            # someone paid: no undo
    with s["app"].app_context():
        db = get_db()
        voided = db.execute("SELECT COUNT(*) FROM pos_sales WHERE voided=1").fetchone()[0]
        assert voided == 2                                                    # the two undone splits
        assert db.execute("SELECT qty_on_hand FROM items WHERE id=?", (s["tea"],)).fetchone()[0] == 17
        assert db.execute("SELECT COUNT(*) FROM pos_order_events WHERE kind='split'").fetchone()[0] == 3
        ok(db)


def test_item_parts_rounding_unit():
    from riyeser.views.pos_tables import even_parts, item_parts
    assert even_parts(1001, 4) == [251, 250, 250, 250] and sum(even_parts(1, 3)) == 1
    dl = [dict(description="Pizza", net_amount=1818, tax_amount=182)]
    ol = [dict(uid="a", qty=1)]
    parts = item_parts(dl, ol, [{"a": 1 / 3}, {"a": 1 / 3}, {"a": 1 / 3}])
    assert sum(parts) == 2000 and max(parts) - min(parts) <= 1


# ================================================================ cash drawer
def drawer_on(s, raw=False):
    t = till_id(s)
    s["c"].post("/pos/drawer", data={f"mode_{t}": "printer", f"printer_{t}": "Receipt printer (test)",
                                     **({f"raw_{t}": "1"} if raw else {})})
    return t


def test_drawer_pulse_is_sent_once_per_cash_sale(shop):
    s, c, pr = shop, shop["c"], shop["printer"]
    t = drawer_on(s)
    body = {"tenders": [{"method": "cash", "tendered": 1000}], "lines": [{"item_id": s["tea"], "qty": 1}],
            "checkout_ref": "cash-1", "till_id": t}
    r = c.post("/pos/sale", json=body).get_json()
    assert r["ok"] and r["drawer_opened"] and pr.pulses() == 1
    assert pr.jobs[0][1] == b"\x1bp\x00\x19\xfa"                     # ESC p 0 25 250
    assert c.post("/pos/sale", json=body).get_json()["repeat"] and pr.pulses() == 1   # double tap: no second pulse
    r = c.post("/pos/sale", json={"method": "card", "lines": [{"item_id": s["tea"], "qty": 1}], "till_id": t}).get_json()
    assert r["ok"] and not r["drawer_opened"] and pr.pulses() == 1  # card only: the drawer stays shut
    # a cash refund opens it
    with s["app"].app_context():
        db = get_db()
        sid = db.execute("SELECT id FROM pos_sales ORDER BY id LIMIT 1").fetchone()[0]
        lid = db.execute("SELECT id FROM document_lines WHERE document_id=(SELECT document_id FROM pos_sales WHERE"
                         " id=?)", (sid,)).fetchone()[0]
    rf = c.post(f"/pos/sale/{sid}/refund", json={"lines": {str(lid): 1}, "method": "cash", "till_id": t}).get_json()
    assert rf["ok"] and rf["drawer_opened"] and pr.pulses() == 2
    with s["app"].app_context():
        db = get_db()
        assert [r[0] for r in db.execute("SELECT kind FROM pos_drawer_events ORDER BY id")] == ["sale", "refund"]
        ok(db)


def test_no_sale_needs_a_reason_and_is_audited_and_staff_need_a_manager(shop):
    s, c, pr = shop, shop["c"], shop["printer"]
    t = drawer_on(s)
    assert not c.post("/pos/drawer/open", json={"till_id": t}).get_json()["ok"]          # no reason
    r = c.post("/pos/drawer/open", json={"till_id": t, "reason": "Give change"}).get_json()
    assert r["ok"] and pr.pulses() == 1
    with s["app"].app_context():
        db = get_db()
        e = db.execute("SELECT * FROM pos_drawer_events").fetchone()
        assert e["kind"] == "no_sale" and e["reason"] == "Give change" and e["approval_id"]
        assert db.execute("SELECT 1 FROM audit_log WHERE action='pos_no_sale'").fetchone()
        assert db.execute("SELECT action FROM pos_approvals WHERE id=?", (e["approval_id"],)).fetchone()[0] == "nosale"
        from werkzeug.security import generate_password_hash
        db.execute("INSERT INTO users (username, password_hash, full_name, role, perms) VALUES ('casey',?,"
                   "'Casey Cashier','accountant',?)", (generate_password_hash("pw"), json.dumps({"sales": 2})))
        db.commit()
    staff = s["app"].test_client()
    staff.post("/login", data={"username": "casey", "password": "pw"})
    r = staff.post("/pos/drawer/open", json={"till_id": t, "reason": "Give change"}).get_json()
    assert not r["ok"] and "manager" in r["error"] and pr.pulses() == 1


def test_drawer_problems_never_lose_the_sale_and_the_test_button(shop):
    s, c, pr = shop, shop["c"], shop["printer"]
    t = drawer_on(s)
    assert c.post("/pos/drawer/test", json={"till_id": t}).get_json()["ok"] and pr.pulses() == 1
    pr.fail = True
    r = c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": 500}], "till_id": t,
                                  "lines": [{"item_id": s["tea"], "qty": 1}]}).get_json()
    assert r["ok"] and not r["drawer_opened"] and "switched off" in r["drawer_error"]
    with s["app"].app_context():
        db = get_db()
        assert db.execute("SELECT ok FROM pos_drawer_events WHERE kind='sale'").fetchone()[0] == 0
        ok(db)
    page = c.get("/pos/drawer", follow_redirects=True).get_data(as_text=True)
    assert "Works with drawers that plug into an ESC/POS receipt printer" in page and "Receipt printer (test)" in page


def test_escpos_receipt_starts_with_the_pulse_only_if_the_drawer_did_not_open(shop):
    s, c, pr = shop, shop["c"], shop["printer"]
    t = drawer_on(s, raw=True)
    pr.fail = True              # the sale's own pulse fails...
    r = c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": 500}], "till_id": t,
                                  "lines": [{"item_id": s["tea"], "qty": 1}]}).get_json()
    pr.fail = False
    x = c.post(f"/pos/receipt/{r['sale_id']}/raw", json={"till_id": t}).get_json()
    assert x["ok"] and x["kicked"]                     # ...so the receipt opens it
    job = pr.jobs[-1][1]
    assert job.startswith(D.PULSE + D.INIT) and b"Tea" in job and b"TOTAL" in job and job.endswith(D.CUT)
    x = c.post(f"/pos/receipt/{r['sale_id']}/raw", json={"till_id": t}).get_json()   # a reprint: no pulse
    assert x["ok"] and not x["kicked"] and pr.pulses() == 1
    # a till without raw receipts falls back to normal printing
    t2 = drawer_on(s)
    assert c.post(f"/pos/receipt/{r['sale_id']}/raw", json={"till_id": t2}).get_json()["fallback"]


def test_windows_raw_printer_is_behind_an_interface():
    """Off Windows there's no spooler: the default backend says so instead of pretending."""
    import sys
    be = D.WindowsRawPrinter()
    assert be.available() == (sys.platform == "win32")
    if sys.platform != "win32":
        with pytest.raises(D.DrawerError):
            D.RawPrinter().send("x", D.PULSE)


# ================================================================ kitchen display screen
def kitchen_screen(s):
    restaurant(s)
    with s["app"].app_context():
        db = get_db()
        db.execute("UPDATE pos_stations SET output='screen'")
        db.execute("INSERT INTO pos_stations (name, output) VALUES ('Bar', 'both')")
        db.execute("INSERT INTO pos_station_categories VALUES ('Drinks', (SELECT id FROM pos_stations WHERE name='Bar'))")
        db.commit()


def test_kds_tickets_by_station_bump_and_recall(shop):
    s, c = shop, shop["c"]
    kitchen_screen(s)
    o = order(c, "3", [{"item_id": s["tea"], "qty": 2, "note": "extra hot"}], kitchen=True)
    assert o["ok"] and o["docket_url"]                                  # the Bar prints as well
    j = c.get("/kds/tickets.json").get_json()
    assert len(j["tickets"]) == 1
    t = j["tickets"][0]
    assert t["label"] == "Table 3" and t["station"] == "Bar" and t["items"][0]["note"] == "extra hot"
    assert "price" not in json.dumps(j) and "total" not in json.dumps(j)  # no prices on the kitchen screen
    # bump the item: the ticket goes (all its items are done); recall brings it back
    assert c.post("/kds/bump", json={"item_id": t["items"][0]["id"]}).get_json()["ok"]
    assert c.get("/kds/tickets.json").get_json()["tickets"] == []
    j = c.get("/kds/tickets.json").get_json()
    assert j["recall"]["label"] == "Table 3"
    assert c.post("/kds/recall", json={}).get_json()["ok"]
    t = c.get("/kds/tickets.json").get_json()["tickets"][0]
    assert t["recalled"] and not t["items"][0]["bumped"]
    # bump the whole order
    assert c.post("/kds/bump", json={"ticket_id": t["id"]}).get_json()["ok"]
    assert c.get("/kds/tickets.json").get_json()["tickets"] == []
    # a station set to print only isn't on the screen
    kitchen_only = c.get(f"/kds/tickets.json?station={t['station_id']}").get_json()
    assert kitchen_only["tickets"] == []


def test_kds_shows_voided_and_moved_items(shop):
    s, c = shop, shop["c"]
    kitchen_screen(s)
    o = order(c, "4", [{"item_id": s["tea"], "qty": 3}], kitchen=True)
    lines = o["order"]["lines"]
    lines[0]["qty"] = 2                                      # one taken off after it was sent
    o = order(c, "4", lines, oid=o["id"])
    it = c.get("/kds/tickets.json").get_json()["tickets"][0]["items"][0]
    assert it["voided_qty"] == 1 and not it["voided"]
    c.post(f"/pos/order/{o['id']}/move", json={"table_no": "8"})
    t = c.get("/kds/tickets.json").get_json()["tickets"][0]
    assert t["label"] == "Table 8" and t["items"][0]["moved_from"] == "Table 4"
    c.post(f"/pos/order/{o['id']}/cancel")
    assert c.get("/kds/tickets.json").get_json()["tickets"][0]["items"][0]["voided"]
    with s["app"].app_context():
        assert get_db().execute("SELECT COUNT(*) FROM pos_order_events WHERE kind='void'").fetchone()[0] == 1


def test_kds_pairing_gives_a_device_the_tickets_and_nothing_else(shop):
    s, c = shop, shop["c"]
    kitchen_screen(s)
    order(c, "2", [{"item_id": s["tea"], "qty": 1}], kitchen=True)
    tab = s["app"].test_client()
    assert tab.get("/kds/").headers["Location"].endswith("/kds/pair")      # not paired: pair first
    assert tab.get("/kds/tickets.json").status_code in (302, 401)
    c.post("/pos/kitchen", data={"what": "pair"})
    with s["app"].app_context():
        from riyeser.views.kds import settings
        code = settings(get_db())["pair_code"]
    bad = tab.post("/kds/pair", data={"code": "000000" if code != "000000" else "111111", "name": "Pass tablet"})
    assert "Check the code on the till" in bad.get_data(as_text=True)
    r = tab.post("/kds/pair", data={"code": code, "name": "Pass tablet"})
    assert r.status_code == 302 and r.headers["Location"].endswith("/kds/")
    j = tab.get("/kds/tickets.json").get_json()
    assert j["ok"] and j["tickets"][0]["label"] == "Table 2"
    assert tab.post("/kds/bump", json={"ticket_id": j["tickets"][0]["id"]}).get_json()["ok"]
    # the device can't open anything else
    for url in ("/pos/", "/pos/sales", "/inventory/", "/pos/orders", "/reports/"):
        assert tab.get(url).status_code == 302 and "/login" in tab.get(url).headers["Location"]
    # the code was used up; a second tablet needs a new one
    other = s["app"].test_client()
    assert "no pairing code" in other.post("/kds/pair", data={"code": code}).get_data(as_text=True)
    # signing the device out stops it
    with s["app"].app_context():
        did = get_db().execute("SELECT id FROM kds_devices").fetchone()[0]
    c.post("/pos/kitchen", data={"what": "revoke", "device_id": did})
    assert tab.get("/kds/tickets.json").status_code in (302, 401)


def test_kds_pairing_code_stops_after_wrong_tries(shop):
    s, c = shop, shop["c"]
    c.post("/pos/kitchen", data={"what": "pair"})
    with s["app"].app_context():
        from riyeser.views.kds import settings
        code = settings(get_db())["pair_code"]
    tab = s["app"].test_client()
    wrong = "123456" if code != "123456" else "654321"
    for _ in range(5):
        tab.post("/kds/pair", data={"code": wrong})
    assert "no pairing code" in tab.post("/kds/pair", data={"code": code}).get_data(as_text=True)


def test_kds_network_listener_serves_only_the_kitchen_screen(shop):
    from riyeser.views.kds import kds_only
    calls = []

    def inner(environ, start_response):
        calls.append(environ["PATH_INFO"])
        start_response("200 OK", [])
        return [b"ok"]
    app = kds_only(inner)
    seen = {}

    def sr(status, headers):
        seen["s"] = status
    for path, want in (("/kds/", "200"), ("/kds/tickets.json", "200"), ("/pos/", "404"), ("/login", "404"),
                       ("/static/app.css", "404"), ("/inventory/", "404"), ("/", "302")):
        app({"PATH_INFO": path}, sr)
        assert seen["s"].startswith(want), path
    assert calls == ["/kds/", "/kds/tickets.json"]


def test_kitchen_staff_permission_sees_only_the_kitchen_screen(shop):
    s, c = shop, shop["c"]
    kitchen_screen(s)
    order(c, "6", [{"item_id": s["tea"], "qty": 1}], kitchen=True)
    from riyeser import perms
    with s["app"].app_context():
        db = get_db()
        from werkzeug.security import generate_password_hash
        db.execute("INSERT INTO users (username, password_hash, full_name, role, perms) VALUES ('kit',?,'Kit Chen',"
                   "'accountant',?)", (generate_password_hash("pw"), json.dumps(perms.PRESETS["kitchen"][1])))
        db.commit()
    k = s["app"].test_client()
    k.post("/login", data={"username": "kit", "password": "pw"})
    assert k.get("/kds/").status_code == 200
    assert k.get("/kds/tickets.json").get_json()["tickets"][0]["label"] == "Table 6"
    assert k.get("/pos/sales").status_code == 302                   # no sales
    assert k.post("/pos/sale", json={"method": "card", "lines": [{"item_id": s["tea"], "qty": 1}]}).status_code == 302


def test_new_screens_render(shop):
    s, c = shop, shop["c"]
    restaurant(s)
    gen_variants(s)
    add_location(s, "Warehouse")
    for url in ("/pos/", "/pos/hardware", "/pos/kitchen", "/pos/setup", "/kds/", "/inventory/locations",
                "/inventory/transfers", "/inventory/transfers/new", f"/inventory/{s['tee']}/variants",
                "/inventory/variants/import", "/inventory/count", "/inventory/low-stock", f"/inventory/{s['tee']}/edit"):
        r = c.get(url)
        assert r.status_code == 200, url


def test_kds_network_listener_starts_and_serves_only_the_kitchen_screen(shop):
    """The real listener (waitress on the local network) for the desktop POS: /kds/ works, the rest is 404."""
    import socket
    import urllib.request
    import urllib.error
    from riyeser.views import kds
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        port = so.getsockname()[1]
    assert kds.start_lan(shop["app"], port=port) is None
    try:
        assert kds.lan_listener()["running"]
        page = urllib.request.urlopen(f"http://127.0.0.1:{port}/kds/pair", timeout=5).read().decode()
        assert "Pair this kitchen screen" in page
        for path in ("/pos/", "/login", "/inventory/", "/reports/"):
            with pytest.raises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5)
            assert e.value.code == 404
    finally:
        kds.stop_lan()
    assert not kds.lan_listener()["running"]


def test_table_moves_and_splits_sent_twice_happen_once(shop):
    s, c = shop, shop["c"]
    restaurant(s)
    o = order(c, "1", [{"item_id": s["tea"], "qty": 3}])
    uid = o["order"]["lines"][0]["uid"]
    body = {"lines": {uid: 1}, "table_no": "2", "op_ref": "op-1"}
    a = c.post(f"/pos/order/{o['id']}/move-items", json=body).get_json()
    b = c.post(f"/pos/order/{o['id']}/move-items", json=body).get_json()
    assert a["ok"] and b["ok"] and b["repeat"]
    assert sum(l["qty"] for l in b["order"]["lines"]) == 2                 # one moved, not two
    sp = {"mode": "even", "guests": 2, "op_ref": "op-2"}
    assert c.post(f"/pos/order/{o['id']}/split", json=sp).get_json()["ok"]
    assert c.post(f"/pos/order/{o['id']}/split", json=sp).get_json()["repeat"]
    with s["app"].app_context():
        db = get_db()
        assert db.execute("SELECT COUNT(*) FROM pos_bills").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM pos_order_events WHERE kind='move_items'").fetchone()[0] == 1
        ok(db)


def test_kitchen_screen_autostart_leaves_a_new_install_alone(tmp_path, monkeypatch):
    """A first start with no company file yet: the kitchen screen's start-up check makes no (empty) file, so setup opens."""
    monkeypatch.setenv("RIYESER_APP_EDITION", "pos")
    from riyeser.views.kds import autostart
    db = tmp_path / "company.db"
    app = create_app({"DATABASE": str(db), "SECRET_KEY": "t", "TESTING": True})
    autostart(app)
    assert not db.exists()
    r = app.test_client().get("/setup")
    assert r.status_code == 200 and b"Riyeser POS" in r.data
