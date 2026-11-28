"""Riyeser POS 2.11.1 with synthetic data for the browser checks of Till PINs, the keypads' Clear key, printing in the
app and POS setup › Hardware. A fake printer stands in for Windows' print spooler, so nothing is printed.

    python tests/browser/serve_pos_pins.py 8311 retail &
    python tests/browser/serve_pos_pins.py 8312 restaurant &
    node tests/browser/pos_pins.e2e.js

Sign-in on the PC: admin / admin. Till PINs: Maria 1111, Jo 2222 (cashiers), Sam 9999 (supervisor).
"""
import os
import sys
import tempfile

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8311
mode = sys.argv[2] if len(sys.argv) > 2 else "retail"
pins = (sys.argv[3] if len(sys.argv) > 3 else "pins") == "pins"
wt = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(prefix=f"riyeser-pins-{mode}-")
os.environ["RIYESER_APP_EDITION"] = "pos"
os.environ.update(APPDATA=data, RIYESER_HOME=os.path.join(data, "home"), RIYESER_DEMO_FILE=os.path.join(data, "no.json"),
                  USERPROFILE=data, HOME=data)
sys.path.insert(0, wt)
from datetime import date  # noqa: E402
from riyeser import create_app  # noqa: E402
from riyeser.db import get_db, init_db  # noqa: E402
from riyeser import ledger as L  # noqa: E402
from riyeser import drawer as D  # noqa: E402

app = create_app({"DATABASE": os.path.join(data, "pos.db"), "SECRET_KEY": "pins-shots",
                  "RAW_PRINTER": D.FakePrinter(printers=("EPSON TM-T82III Receipt", "Bar printer (58 mm)",
                                                         "Microsoft Print to PDF"))})
today = date.today().isoformat()
with app.app_context():
    init_db("Synthetic Surf & Cafe")
    db = get_db()
    db.execute("UPDATE company SET abn='00 000 000 000', address='1 Example Esplanade, Sampletown', phone='000 000 000',"
               " pos_mode=?", (mode,))
    acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
    tc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM tax_codes")}
    sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Synthetic Wholesale')").lastrowid
    menu = ([("TEE", "Classic Tee", "Clothing", 3000, 1200, 20, "9300000001001"),
             ("CAP", "Surf Cap", "Accessories", 2000, 800, 15, "9300000001002"),
             ("WAX", "Board Wax", "Accessories", 500, 150, 40, "9300000001003"),
             ("SUN", "Sunscreen SPF50", "Accessories", 1500, 600, 12, "9300000001004")]
            if mode == "retail" else
            [("FW", "Flat White", "Coffee", 455, 90, 0, None), ("BURG", "Beef Burger", "Mains", 1818, 600, 0, None),
             ("BEER", "Pale Ale", "Drinks", 909, 300, 48, None)])
    for sku, name, cat, sell, cost, qty, bc in menu:
        iid = db.execute("INSERT INTO items (sku, name, is_inventoried, is_sold, is_bought, income_account_id,"
                         " expense_account_id, asset_account_id, sell_price, buy_price, sale_tax_code_id,"
                         " purchase_tax_code_id, active, pos_favourite, category, barcodes) VALUES (?,?,?,1,1,?,?,?,?,?,?,?,1,1,?,?)",
                         (sku, name, 1 if qty else 0, acc["4-1000"], acc["5-1000"], acc["1-1300"], sell, cost, tc["GST"],
                          tc["GST"], cat, bc)).lastrowid
        if qty:
            L.save_document(db, "purchase", dict(contact_id=sup, date=today),
                            [dict(item_id=iid, qty=qty, unit_price=cost, tax_code_id=tc["GST"])], "open")
    db.commit()
c = app.test_client()
c.post("/login", data={"username": "admin", "password": "admin"})
c.post("/pos/setup", data={"mode": mode, "till_name_1": "Till 1", "till_loc_1": "Front counter", "new_till": "Kiosk till",
                           "pins": "auto", "lock_minutes": "5",
                           "feature": ["scan", "stock", "sku", "hold", "customer", "discount", "notes"] if mode == "retail"
                           else ["tables", "kitchen", "takeaway", "notes", "customer", "discount"]})
c.post("/pos/hardware/save", data={"what": "receipt", "till_id": 1, "receipt_printer": "EPSON TM-T82III Receipt",
                                   "print_after": "ask", "copies": "1"})
c.post("/pos/hardware/save", data={"what": "drawer", "till_id": 1, "drawer_mode": "printer",
                                   "drawer_printer": "EPSON TM-T82III Receipt", "cash_sale": "1", "cash_refund": "1",
                                   "no_sale": "1"})
c.post("/pos/hardware/save", data={"what": "layout", "logo": "1", "show_name": "1", "show_address": "1", "show_tax_id": "1",
                                   "show_phone": "1", "footer": "Thank you! Returns within 14 days with your receipt."})
if pins:
    for u, full, preset, pin in (("maria", "Maria Synthetic", "cashier", "1111"), ("jo", "Jo Example", "cashier", "2222"),
                                 ("sam", "Sam Supervisor", "supervisor", "9999")):
        c.post("/users/save", data={"username": u, "password": "pw-synthetic1", "full_name": full, "preset": preset,
                                    "till_pin": pin})
    # a morning's trade: Maria opens and sells, Jo sells and refunds (Sam approves), Sam is the supervisor
    c.post("/pos/cashier/unlock", json={"pin": "1111", "till_id": 1, "purpose": "open"})
    c.post("/pos/shift/open", json={"till_id": 1, "float": "200.00"})
    with app.app_context():
        ids = [r[0] for r in get_db().execute("SELECT id FROM items WHERE is_sold=1 ORDER BY id")]
    for n, (who, item, qty) in enumerate([("1111", 0, 2), ("1111", 1, 1), ("2222", 2, 3), ("2222", 0, 1), ("1111", 2, 1)]):
        c.post("/pos/cashier/unlock", json={"pin": who, "till_id": 1})
        c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": 20000}], "till_id": 1,
                                  "lines": [{"item_id": ids[item % len(ids)], "qty": qty}], "checkout_ref": f"shot-{n}"})
    c.post("/pos/cashier/lock")
else:
    c.post("/pos/shift/open", json={"till_id": 1, "float": "200.00"})
if mode == "restaurant":
    c.post("/pos/kitchen", data={"what": "stations", "name_1": "Kitchen", "output_1": "both", "new_name": "Bar",
                                 "new_output": "print", "amber": "8", "red": "15"})
    c.post("/pos/kitchen", data={"what": "stations", "name_1": "Kitchen", "output_1": "both", "name_2": "Bar",
                                 "output_2": "print", "active_2": "1", "cat::Drinks": "2", "cat::Coffee": "2",
                                 "amber": "8", "red": "15"})
    c.post("/pos/hardware/save", data={"what": "kitchen", "printer_1": "EPSON TM-T82III Receipt",
                                       "printer_2": "Bar printer (58 mm)"})
    c.post("/pos/hardware/save", data={"what": "adjust", "target": "station:2", "paper": "58", "feed": "3", "cut": "1"})
print(f"Riyeser POS ({mode}, {'PINs' if pins else 'no PINs'}) on http://127.0.0.1:{port} (admin / admin)", flush=True)
app.run(port=port, threaded=True, use_reloader=False)
