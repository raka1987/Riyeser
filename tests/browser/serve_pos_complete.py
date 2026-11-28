"""Riyeser POS with synthetic data for the browser checks of the 2.11 screens (variants, locations and transfers,
tables, cash drawer, kitchen screen). The cash drawer uses a fake printer, so nothing is printed.

    python tests/browser/serve_pos_complete.py 8301 retail &
    python tests/browser/serve_pos_complete.py 8302 restaurant &
    node tests/browser/pos_complete.e2e.js
"""
import os
import sys
import json
import tempfile

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8301
mode = sys.argv[2] if len(sys.argv) > 2 else "retail"
wt = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(prefix=f"riyeser-pos-{mode}-")
os.environ["RIYESER_APP_EDITION"] = "pos"
os.makedirs(data, exist_ok=True)
os.environ.update(APPDATA=data, RIYESER_HOME=os.path.join(data, "home"), RIYESER_DEMO_FILE=os.path.join(data, "no.json"),
                  USERPROFILE=data, HOME=data)
sys.path.insert(0, wt)
from datetime import date  # noqa: E402
from riyeser import create_app  # noqa: E402
from riyeser.db import get_db, init_db  # noqa: E402
from riyeser import ledger as L  # noqa: E402
from riyeser import drawer as D  # noqa: E402
AFTER = True

db_path = os.path.join(data, "pos.db")
cfg = {"DATABASE": db_path, "SECRET_KEY": "shots"}
if AFTER:
    cfg["RAW_PRINTER"] = D.FakePrinter(printers=("EPSON TM-T82III Receipt", "Microsoft Print to PDF"))
app = create_app(cfg)
today = date.today().isoformat()
with app.app_context():
    init_db("Synthetic Surf & Cafe")
    db = get_db()
    db.execute("UPDATE company SET abn='00 000 000 000', address='1 Example Esplanade, Sampletown', phone='000 000 000',"
               " pos_mode=?", (mode,))
    acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
    tc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM tax_codes")}
    sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Synthetic Wholesale')").lastrowid
    items = {}
    menu = ([("TEE", "Classic Tee", "Clothing", 3000, 1200, 0), ("HOOD", "Surf Hoodie", "Clothing", 6000, 2500, 12),
             ("CAP", "Surf Cap", "Accessories", 2000, 800, 15), ("WAX", "Board Wax", "Accessories", 500, 150, 40),
             ("SUN", "Sunscreen SPF50", "Accessories", 1500, 600, 3), ("LEASH", "Leg Rope", "Hardware", 3500, 1400, 8)]
            if mode == "retail" else
            [("FW", "Flat White", "Coffee", 455, 90, 0), ("LAT", "Latte", "Coffee", 455, 90, 0),
             ("TEA", "English Breakfast Tea", "Tea", 400, 50, 60), ("BURG", "Beef Burger", "Mains", 1818, 600, 0),
             ("FISH", "Fish & Chips", "Mains", 2045, 700, 0), ("SAL", "Caesar Salad", "Mains", 1636, 500, 0),
             ("BEER", "Pale Ale", "Drinks", 909, 300, 48), ("OJ", "Orange Juice", "Drinks", 545, 150, 30)])
    for sku, name, cat, sell, cost, qty in menu:
        iid = db.execute("INSERT INTO items (sku, name, is_inventoried, is_sold, is_bought, income_account_id,"
                         " expense_account_id, asset_account_id, sell_price, buy_price, sale_tax_code_id,"
                         " purchase_tax_code_id, active, pos_favourite, category) VALUES (?,?,?,1,1,?,?,?,?,?,?,?,1,1,?)",
                         (sku, name, 1 if (qty or sku == "TEE") else 0, acc["4-1000"], acc["5-1000"], acc["1-1300"], sell,
                          cost, tc["GST"], tc["GST"], cat)).lastrowid
        items[sku] = iid
        if qty:
            L.save_document(db, "purchase", dict(contact_id=sup, date=today),
                            [dict(item_id=iid, qty=qty, unit_price=cost, tax_code_id=tc["GST"])], "open")
    db.commit()
c = app.test_client()
c.post("/login", data={"username": "admin", "password": "admin"})
c.post("/pos/shift/open", json={"till_id": 1, "float": "200.00"})
if AFTER and mode == "retail":
    tee = items["TEE"]
    c.post(f"/inventory/{tee}/variants", data={"what": "generate", "opt_name_1": "Colour", "opt_values_1": "Navy, White, Sand",
                                               "opt_name_2": "Size", "opt_values_2": "S, M, L, XL"})
    with app.app_context():
        db = get_db()
        kids = db.execute("SELECT * FROM items WHERE parent_id=? ORDER BY id", (tee,)).fetchall()
    form = {"what": "save"}
    for n, k in enumerate(kids):
        vals = json.loads(k["variant_values"])
        form.update({f"sku_{k['id']}": k["sku"], f"price_{k['id']}": "32.00" if vals[1] == "XL" else "30.00",
                     f"cost_{k['id']}": "12.00", f"reorder_{k['id']}": "2", f"active_{k['id']}": "1",
                     f"barcodes_{k['id']}": f"93000000{1000 + n:04d}",
                     f"opening_{k['id']}": "" if vals == ["Sand", "XL"] else str(2 + (n * 3) % 7)})
    c.post(f"/inventory/{tee}/variants", data=form)
    c.post("/inventory/locations", data={"new_name": "Beach Kiosk", "new_address": "Surf Club car park"})
    c.post("/inventory/locations", data={"new_name": "Storeroom"})
    with app.app_context():
        db = get_db()
        locs = {r["name"]: r["id"] for r in db.execute("SELECT id, name FROM stock_locations")}
        nm = db.execute("SELECT id FROM items WHERE sku='TEE-NAVY-M'").fetchone()[0]
    c.post("/inventory/transfers/new", data={"from_id": locs["Main"], "to_id": locs["Beach Kiosk"],
                                             "line_item": [nm, items["WAX"], items["SUN"]], "line_qty": ["2", "10", "2"],
                                             "then": "send", "note": "Saturday market stock"})
    with app.app_context():
        db = get_db()
        lines = db.execute("SELECT id, item_id FROM stock_transfer_lines").fetchall()
    c.post("/inventory/transfers/1/receive", data={f"recv_{lines[0]['id']}": "2", f"recv_{lines[1]['id']}": "6",
                                                   f"recv_{lines[2]['id']}": "0"})
    c.post("/inventory/transfers/new", data={"from_id": locs["Storeroom"], "to_id": locs["Main"],
                                             "line_item": [items["HOOD"]], "line_qty": ["4"], "then": "draft"})
    c.post("/pos/setup", data={"mode": "retail", "feature": ["scan", "stock", "sku", "hold", "customer", "discount", "notes"],
                               "till_name_1": "Till 1", "till_loc_1": "Front counter", "till_stock_1": str(locs["Main"]),
                               "new_till": "Kiosk till", "new_till_loc": "Beach kiosk", "new_till_stock": str(locs["Beach Kiosk"])})
    c.post("/pos/drawer", data={"mode_1": "printer", "printer_1": "EPSON TM-T82III Receipt", "raw_1": "1", "mode_2": "none"})
    c.post("/pos/drawer/test", json={"till_id": 1})
    c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": 5000}], "till_id": 1,
                              "lines": [{"item_id": nm, "qty": 1}], "checkout_ref": "shot-1"})
    c.post("/pos/drawer/open", json={"till_id": 1, "reason": "Swap notes for coins"})
if mode == "restaurant":
    c.post("/pos/tables", data={"new_area": "Inside", "new_area_tables": "1-20"})   # POS setup › Tables
    if AFTER:
        c.post("/pos/kitchen", data={"what": "stations", "name_1": "Kitchen", "output_1": "both", "new_name": "Bar",
                                     "new_output": "screen", "amber": "8", "red": "15"})
        c.post("/pos/kitchen", data={"what": "stations", "name_1": "Kitchen", "output_1": "both", "name_2": "Bar",
                                     "output_2": "screen", "active_2": "1", "cat::Coffee": "2", "cat::Drinks": "2",
                                     "cat::Tea": "2", "amber": "8", "red": "15"})
    def order(table, lines, kitchen=True):
        return c.post("/pos/order", json={"order_type": "dine_in", "table_no": table, "kitchen": kitchen,
                                          "lines": lines}).get_json()
    o4 = order("4", [{"item_id": items["BURG"], "qty": 2, "note": "no onion"}, {"item_id": items["FISH"], "qty": 1},
                     {"item_id": items["BEER"], "qty": 2}, {"item_id": items["FW"], "qty": 1, "note": "oat milk"}])
    order("2", [{"item_id": items["SAL"], "qty": 1, "note": "dressing on the side"}, {"item_id": items["OJ"], "qty": 1}])
    order("9", [{"item_id": items["LAT"], "qty": 3}, {"item_id": items["TEA"], "qty": 1}])
    order("12", [{"item_id": items["FISH"], "qty": 2}, {"item_id": items["BURG"], "qty": 1}, {"item_id": items["BEER"], "qty": 3}])
    if AFTER:
        o = o4["order"]
        burger = next(l for l in o["lines"] if l["item_id"] == items["BURG"])
        c.post(f"/pos/order/{o['id']}/move-items", json={"lines": {burger["uid"]: 1}, "table_no": "7"})
        with app.app_context():
            db = get_db()
            db.execute("UPDATE kds_tickets SET created_at=datetime('now','localtime','-11 minutes') WHERE order_id IN"
                       " (SELECT id FROM pos_orders WHERE table_no IN ('4','7'))")
            db.execute("UPDATE kds_tickets SET created_at=datetime('now','localtime','-17 minutes') WHERE order_id IN"
                       " (SELECT id FROM pos_orders WHERE table_no='2')")
            db.commit()
        o12 = next(x for x in c.get("/pos/orders").get_json() if x["table_no"] == "12")
        lines = o12["lines"]
        lines[2]["qty"] = 2   # one pale ale voided after it was sent
        c.post("/pos/order", json={"id": o12["id"], "order_type": "dine_in", "table_no": "12", "lines": lines})
print(f"Riyeser POS ({mode}) on http://127.0.0.1:{port} (admin / admin)", flush=True)
app.run(port=port, threaded=True, use_reloader=False)
