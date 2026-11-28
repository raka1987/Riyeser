"""Riyeser POS with synthetic data for tests/browser/pos_gaps.e2e.js (receipts on screen, promotions, tables and
areas, switching Retail <-> Restaurant, nothing of ours in the web browser). A fake printer; nothing is printed.

    python tests/browser/serve_pos_gaps.py 8321 retail &
    python tests/browser/serve_pos_gaps.py 8322 restaurant &      # a restaurant with no tables yet
    node tests/browser/pos_gaps.e2e.js
"""
import os
import sys
import tempfile

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8321
mode = sys.argv[2] if len(sys.argv) > 2 else "retail"
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(prefix=f"riyeser-posgaps-{mode}-")
os.environ.update(RIYESER_APP_EDITION="pos", APPDATA=data, RIYESER_HOME=os.path.join(data, "home"),
                  RIYESER_DEMO_FILE=os.path.join(data, "no.json"), USERPROFILE=data, HOME=data)
sys.path.insert(0, root)
from datetime import date  # noqa: E402
from riyeser import create_app  # noqa: E402
from riyeser.db import get_db, init_db  # noqa: E402
from riyeser import ledger as L  # noqa: E402
from riyeser import drawer as D  # noqa: E402

app = create_app({"DATABASE": os.path.join(data, "pos.db"), "SECRET_KEY": "browser-test",
                  "RAW_PRINTER": D.FakePrinter(printers=("EPSON TM-T82III Receipt", "Office LaserJet (A4)"))})
today = date.today().isoformat()
with app.app_context():
    init_db("Synthetic Surf & Cafe")
    db = get_db()
    db.execute("UPDATE company SET abn='00 000 000 000', address='1 Example Esplanade, Sampletown', phone='000 000 000',"
               " pos_mode=?", (mode,))
    acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
    tc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM tax_codes")}
    sup = db.execute("INSERT INTO contacts (kind, name) VALUES ('supplier','Synthetic Wholesale')").lastrowid
    db.execute("INSERT INTO contacts (kind, name, email) VALUES ('customer','Sample Customer','sample.customer@example.com')")
    items = {}
    menu = ([("HOOD", "Surf Hoodie", "Clothing", 6000, 2500, 12), ("CAP", "Surf Cap", "Accessories", 2000, 800, 15),
             ("WAX", "Board Wax", "Accessories", 500, 150, 40), ("LEASH", "Leg Rope", "Hardware", 3500, 1400, 8)]
            if mode == "retail" else
            [("FW", "Flat White", "Coffee", 500, 90, 0), ("LAT", "Latte", "Coffee", 500, 90, 0),
             ("BURG", "Beef Burger", "Mains", 1818, 600, 0), ("FISH", "Fish & Chips", "Mains", 2045, 700, 0),
             ("OJ", "Orange Juice", "Drinks", 545, 150, 30)])
    for sku, name, cat, sell, cost, qty in menu:
        iid = db.execute("INSERT INTO items (sku, name, is_inventoried, is_sold, is_bought, income_account_id,"
                         " expense_account_id, asset_account_id, sell_price, buy_price, sale_tax_code_id,"
                         " purchase_tax_code_id, active, pos_favourite, category) VALUES (?,?,?,1,1,?,?,?,?,?,?,?,1,1,?)",
                         (sku, name, 1 if qty else 0, acc["4-1000"], acc["5-1000"], acc["1-1300"], sell, cost,
                          tc["GST"], tc["GST"], cat)).lastrowid
        items[sku] = iid
        if qty:
            L.save_document(db, "purchase", dict(contact_id=sup, date=today),
                            [dict(item_id=iid, qty=qty, unit_price=cost, tax_code_id=tc["GST"])], "open")
    db.commit()
c = app.test_client()
c.post("/login", data={"username": "admin", "password": "admin"})
c.post("/pos/shift/open", json={"till_id": 1, "float": "200.00"})
first = next(iter(items.values()))
c.post("/pos/sale", json={"tenders": [{"method": "cash", "tendered": 20000}], "till_id": 1,
                          "lines": [{"item_id": first, "qty": 2}], "checkout_ref": "seed-1"})   # a past sale to look at
print(f"Riyeser POS ({mode}) on http://127.0.0.1:{port} (admin / admin)", flush=True)
app.run(port=port, threaded=True, use_reloader=False)
