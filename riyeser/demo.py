"""Populate a company file with realistic demo data."""
from datetime import date, timedelta

from .db import linked, to_cents
from . import ledger as L


# The demo's made-up staff. Riyeser Payroll's demo seeds the same people, so both programs show the same team.
# Keep the two in step: change one, change the other.
DEMO_STAFF = [
    dict(first_name="Alex", last_name="Sample", role="Store manager", pay_basis="salary", hourly_rate=0,
         annual_salary=78000, std_hours=38, email="alex.sample@sampletrading.example"),
    dict(first_name="Jamie", last_name="Example", role="Service technician", pay_basis="hourly", hourly_rate=34.5,
         annual_salary=0, std_hours=38, email="jamie.example@sampletrading.example"),
    dict(first_name="Robin", last_name="Demo", role="Service technician", pay_basis="hourly", hourly_rate=33,
         annual_salary=0, std_hours=38, email="robin.demo@sampletrading.example"),
    dict(first_name="Casey", last_name="Placeholder", role="Shop assistant", pay_basis="hourly", hourly_rate=31,
         annual_salary=0, std_hours=20, email="casey.placeholder@sampletrading.example"),
    dict(first_name="Morgan", last_name="Testwell", role="Cafe barista", pay_basis="hourly", hourly_rate=30,
         annual_salary=0, std_hours=25, email="morgan.testwell@sampletrading.example"),
]

# Made-up details the demo fills in. Start again doesn't carry these over to the blank company.
DEMO_DETAILS = {"abn": "51 824 753 556", "address": "12 Harbour St, Sydney NSW 2000", "phone": "02 9000 1234",
                "email": "accounts@sampletrading.example"}


def seed_demo(db):
    today = date.today()

    def d(days_ago):
        return (today - timedelta(days=days_ago)).isoformat()

    acc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM accounts")}
    tc = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM tax_codes")}
    db.execute("UPDATE company SET abn=:abn, address=:address, phone=:phone, email=:email, is_demo=1 WHERE id=1",
               DEMO_DETAILS)

    def contact(kind, name, terms=30, account=None, email=None):
        return db.execute("INSERT INTO contacts (kind, name, terms_days, default_account_id, tax_code_id, email)"
                          " VALUES (?,?,?,?,?,?)", (kind, name, terms, acc.get(account), tc["GST"], email)).lastrowid

    cust = [contact("customer", n, t, "4-1000", e) for n, t, e in [
        ("Bayside Cafe Group", 14, "ap@bayside.example"), ("Northshore Fitness", 30, None),
        ("Greenleaf Landscaping", 30, None), ("Harper & Co Architects", 7, None)]]
    supp = [contact("supplier", n, t, a) for n, t, a in [
        ("Pacific Wholesale Supplies", 30, "5-1000"), ("Sample Power Co", 14, "6-1300"),
        ("Metro Office Leasing", 7, "6-1600"), ("Swift Freight Logistics", 30, "5-1100")]]

    jobs = []
    for code, name, c in [("J100", "Bayside fit-out", cust[0]), ("J200", "Northshore maintenance", cust[1])]:
        jobs.append(db.execute("INSERT INTO jobs (code, name, contact_id) VALUES (?,?,?)", (code, name, c)).lastrowid)

    def item(sku, name, sell, buy, inv=True, reorder=5):
        return db.execute(
            "INSERT INTO items (sku, name, sell_price, buy_price, is_inventoried, income_account_id,"
            " expense_account_id, asset_account_id, sale_tax_code_id, purchase_tax_code_id, reorder_level)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (sku, name, to_cents(sell), to_cents(buy), 1 if inv else 0,
             acc["4-1000"] if inv else acc["4-2000"], acc["5-1000"] if inv else acc["5-1300"],
             acc["1-1300"] if inv else None, tc["GST"], tc["GST"], reorder)).lastrowid

    items = [item("FLT-100", "Water filter cartridge", 89, 38), item("PMP-200", "Pressure pump 240V", 649, 310, reorder=2),
             item("TAP-300", "Filtered water tap", 199, 82), item("SVC-HR", "Service labour (hour)", 120, 0, inv=False)]

    for sku, cat in (("FLT-100", "Filters"), ("PMP-200", "Pumps"), ("TAP-300", "Taps"), ("SVC-HR", "Services")):
        db.execute("UPDATE items SET category=? WHERE sku=?", (cat, sku))

    # A small café menu so Riyeser POS restaurant mode has something to sell
    for sku, name, cat, price in [("CAF-FW", "Flat White", "Coffee", 4.5), ("CAF-LT", "Latte", "Coffee", 4.5),
                                  ("CAF-LB", "Long Black", "Coffee", 4.0), ("CAF-CH", "Hot Chocolate", "Coffee", 5.0),
                                  ("FD-BRK", "Big Breakfast", "Food", 19.0), ("FD-AVO", "Smashed Avo Toast", "Food", 16.5),
                                  ("FD-BUR", "Chicken Burger", "Food", 18.0), ("FD-CHP", "Bowl of Chips", "Food", 8.0),
                                  ("DR-OJ", "Orange Juice", "Drinks", 6.0), ("DR-WTR", "Sparkling Water", "Drinks", 4.0),
                                  ("DS-CAK", "Carrot Cake", "Desserts", 7.5)]:
        db.execute("INSERT INTO items (sku, name, category, is_bought, sell_price, income_account_id,"
                   " sale_tax_code_id) VALUES (?,?,?,0,?,?,?)",
                   (sku, name, cat, to_cents(price / 1.1), acc["4-1000"], tc["GST"]))

    # Opening capital and loan
    L.general_journal(db, d(140), "Owner capital contribution",
                      [dict(account_id=acc["1-1110"], debit=to_cents(60000)),
                       dict(account_id=acc["3-1000"], credit=to_cents(60000))])
    L.general_journal(db, d(138), "Business loan drawdown",
                      [dict(account_id=acc["1-1110"], debit=to_cents(25000)),
                       dict(account_id=acc["2-2100"], credit=to_cents(25000))])

    # Stock purchases (bills)
    hdr = lambda c, days, ref=None: dict(contact_id=c, date=d(days), due_date=d(days - 30), reference=ref)
    b1 = L.save_document(db, "purchase", hdr(supp[0], 135, "PW-8841"), [
        dict(item_id=items[0], qty=250, unit_price=to_cents(38), tax_code_id=tc["GST"]),
        dict(item_id=items[1], qty=40, unit_price=to_cents(310), tax_code_id=tc["GST"]),
        dict(item_id=items[2], qty=80, unit_price=to_cents(82), tax_code_id=tc["GST"])], "open")
    b2 = L.save_document(db, "purchase", hdr(supp[3], 118, "SF-221"), [
        dict(description="Freight inwards", qty=1, unit_price=to_cents(385), account_id=acc["5-1100"],
             tax_code_id=tc["GST"])], "open")
    L.record_payment(db, "out", supp[0], acc["1-1110"], d(95), [(b1, _total(db, b1))], "EFT 1001")
    L.record_payment(db, "out", supp[3], acc["1-1110"], d(90), [(b2, _total(db, b2))], "EFT 1002")
    L.save_document(db, "purchase", hdr(supp[0], 70, "PW-9120"), [
        dict(item_id=items[0], qty=200, unit_price=to_cents(39.5), tax_code_id=tc["GST"]),
        dict(item_id=items[1], qty=25, unit_price=to_cents(315), tax_code_id=tc["GST"])], "open")

    # Equipment (capital)
    L.bank_transaction(db, "spend", acc["1-1110"], d(110), [
        dict(account_id=acc["1-2100"], amount=to_cents(4290), tax_code_id=tc["CAP"], memo="Laptops x3")],
        payee="Sample Computer Store")

    # Sales invoices across months
    sales = [
        (cust[0], 100, jobs[0], [(items[1], 3), (items[2], 6), (items[3], 12)]),
        (cust[1], 85, jobs[1], [(items[0], 20), (items[3], 6)]),
        (cust[2], 70, None, [(items[0], 10), (items[2], 4)]),
        (cust[3], 55, None, [(items[3], 18)]),
        (cust[0], 40, jobs[0], [(items[1], 2), (items[0], 8)]),
        (cust[1], 25, jobs[1], [(items[3], 10), (items[0], 6)]),
        (cust[2], 10, None, [(items[2], 5), (items[3], 4)]),
        (cust[3], 3, None, [(items[1], 1), (items[3], 3)]),
    ]
    invs = []
    for c, days, job, lines in sales:
        invs.append(L.save_document(db, "sale", dict(contact_id=c, date=d(days), due_date=d(days - 14)),
                                    [dict(item_id=i, qty=q * 3, unit_price=_price(db, i), tax_code_id=tc["GST"],
                                          job_id=job) for i, q in lines], "open"))
    for inv, days in zip(invs[:5], (80, 60, 45, 50, 20)):
        L.record_payment(db, "in", _contact(db, inv), acc["1-1110"], d(days), [(inv, _total(db, inv))])
    L.record_payment(db, "in", _contact(db, invs[5]), acc["1-1110"], d(5), [(invs[5], to_cents(500))], "Part pmt")
    # Steady weekly trade
    for k in range(16):
        days = 125 - k * 8
        c = cust[k % len(cust)]
        inv = L.save_document(db, "sale", dict(contact_id=c, date=d(days), due_date=d(days - 14)), [
            dict(item_id=items[0], qty=15, unit_price=_price(db, items[0]), tax_code_id=tc["GST"]),
            dict(item_id=items[1], qty=2, unit_price=_price(db, items[1]), tax_code_id=tc["GST"]),
            dict(item_id=items[3], qty=10, unit_price=_price(db, items[3]), tax_code_id=tc["GST"],
                 job_id=jobs[k % 2] if k % 3 == 0 else None)], "open")
        if days > 35:
            L.record_payment(db, "in", c, acc["1-1110"], d(days - 12), [(inv, _total(db, inv))])
    L.save_document(db, "sale", dict(contact_id=cust[2], date=d(2), due_date=d(-28), notes="Valid 30 days"),
                    [dict(item_id=items[1], qty=2, unit_price=_price(db, items[1]), tax_code_id=tc["GST"])], "quote")
    seed_stock_and_quotes(db, cust, supp, items, tc, d)

    # Monthly overheads
    for m in (120, 90, 60, 30):
        r = L.save_document(db, "purchase", hdr(supp[2], m, f"RENT-{m}"), [
            dict(description="Warehouse rent", qty=1, unit_price=to_cents(3200), account_id=acc["6-1600"],
                 tax_code_id=tc["GST"])], "open")
        L.record_payment(db, "out", supp[2], acc["1-1110"], d(m - 2), [(r, _total(db, r))])
        e = L.save_document(db, "purchase", hdr(supp[1], m - 5, f"CP-{m}"), [
            dict(description="Electricity", qty=1, unit_price=to_cents(410 + m), account_id=acc["6-1300"],
                 tax_code_id=tc["GST"])], "open")
        if m > 30:
            L.record_payment(db, "out", supp[1], acc["1-1110"], d(m - 15), [(e, _total(db, e))])
        L.bank_transaction(db, "spend", acc["2-1100"], d(m - 3), [
            dict(account_id=acc["6-2100"], amount=to_cents(165), tax_code_id=tc["GST"], memo="Accounting software"),
            dict(account_id=acc["6-1700"], amount=to_cents(129), tax_code_id=tc["GST"], memo="Internet")],
            payee="Card purchases")
        L.bank_transaction(db, "spend", acc["1-1110"], d(m - 1), [
            dict(account_id=acc["6-1100"], amount=to_cents(22), tax_code_id=tc["FRE"])], payee="Bank fees")
    L.bank_transaction(db, "receive", acc["1-1120"], d(15), [
        dict(account_id=acc["8-1000"], amount=to_cents(212.40), tax_code_id=tc["INP"])], payee="Interest")
    L.transfer(db, acc["1-1110"], acc["1-1120"], d(60), to_cents(15000), "Move surplus to savings")

    # Employees and pay runs
    from .payroll_calc import compute_pay
    emps = []
    for st in DEMO_STAFF:
        emps.append(db.execute(
            "INSERT INTO employees (first_name, last_name, email, pay_basis, hourly_rate, annual_salary, pay_frequency,"
            " start_date, super_fund, std_hours) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (st["first_name"], st["last_name"], st["email"], st["pay_basis"], to_cents(st["hourly_rate"]),
             to_cents(st["annual_salary"]), "fortnightly", d(200), "Sample Super Fund", st["std_hours"])).lastrowid)
    for days in (84, 70, 56, 42, 28, 14):
        rid = db.execute("INSERT INTO payruns (pay_date, period_start, period_end, frequency, bank_account_id)"
                         " VALUES (?,?,?,?,?)", (d(days), d(days + 13), d(days), "fortnightly", acc["1-1110"])).lastrowid
        lines = []
        for eid in emps:
            e = db.execute("SELECT * FROM employees WHERE id=?", (eid,)).fetchone()
            p = compute_pay(e, "fortnightly")
            db.execute("INSERT INTO payslips (payrun_id, employee_id, hours, gross, tax, super, net, leave_accrued)"
                       " VALUES (?,?,?,?,?,?,?,?)", (rid, eid, p["hours"], p["gross"], p["tax"], p["super"], p["net"],
                                                     p["leave"]))
            db.execute("UPDATE employees SET leave_hours=leave_hours+? WHERE id=?", (p["leave"], eid))
            lines += [dict(account_id=linked(db, "wages"), debit=p["gross"]),
                      dict(account_id=linked(db, "super_expense"), debit=p["super"]),
                      dict(account_id=linked(db, "payg_payable"), credit=p["tax"]),
                      dict(account_id=linked(db, "super_payable"), credit=p["super"]),
                      dict(account_id=acc["1-1110"], credit=p["net"])]
        en = L.post_entry(db, d(days), f"Pay run to {d(days)}", "payrun", lines, source_id=rid)
        db.execute("UPDATE payruns SET entry_id=? WHERE id=?", (en, rid))

    # Budgets for the FY: modest monthly targets
    fys = date.fromisoformat(L.fy_start(db))
    for i in range(12):
        y, m = fys.year + (fys.month + i - 1) // 12, (fys.month + i - 1) % 12 + 1
        for code, amt in (("4-1000", 9000), ("4-2000", 3500), ("6-1600", 3200), ("6-1300", 450), ("6-5000", 14000)):
            db.execute("INSERT INTO budgets (account_id, month, amount) VALUES (?,?,?)",
                       (acc[code], f"{y}-{m:02d}", to_cents(amt)))

    # A few unallocated bank statement lines to demo the bank feed
    for days, desc, amt in ((1, "EFTPOS SETTLEMENT", 1240.00), (1, "OFFICE SUPPLIES STORE", -86.90),
                            (0, "FUEL STATION", -94.15)):
        db.execute("INSERT INTO bank_feed_lines (account_id, date, description, amount) VALUES (?,?,?,?)",
                   (acc["1-1110"], d(days), desc, to_cents(amt)))
    seed_bookings(db, cust)
    seed_crm(db, cust, items, acc, tc)
    from .measure.demo import seed as seed_estimates
    seed_estimates(db, cust)   # Riyeser Estimate: a roof, a fence, a painted room and a tiled bathroom
    db.commit()


def seed_stock_and_quotes(db, cust, supp, items, tc, d):
    """Low stock to reorder (preferred suppliers, a part-received purchase order) and quotes in every state."""
    from .views.receiving import receive
    from .views.quotes import mark_accepted, mark_declined
    for i, up_to in zip(items[:3], (400, 30, 100)):
        db.execute("UPDATE items SET supplier_id=?, reorder_up_to=? WHERE id=?", (supp[0], up_to, i))
    aqua = db.execute("INSERT INTO contacts (kind, name, terms_days, tax_code_id, email) VALUES"
                      " ('supplier', 'Aqua Parts Direct', 30, ?, 'orders@aquaparts.example')", (tc["GST"],)).lastrowid
    inv_ids = db.execute("SELECT income_account_id, expense_account_id, asset_account_id FROM items WHERE id=?",
                         (items[0],)).fetchone()
    new = []
    for sku, name, sell, buy, level, up_to, sup in (("HSG-400", "Filter housing kit", 129, 54, 10, 40, supp[0]),
                                                    ("WSH-500", "Tap washer pack", 12, 4.5, 6, 30, None)):
        new.append(db.execute(
            "INSERT INTO items (sku, name, category, sell_price, buy_price, is_inventoried, income_account_id,"
            " expense_account_id, asset_account_id, sale_tax_code_id, purchase_tax_code_id, reorder_level,"
            " reorder_up_to, supplier_id) VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?)",
            (sku, name, "Filters" if sku.startswith("HSG") else "Taps", to_cents(sell), to_cents(buy),
             inv_ids["income_account_id"], inv_ids["expense_account_id"], inv_ids["asset_account_id"], tc["GST"],
             tc["GST"], level, up_to, sup)).lastrowid)
    L.save_document(db, "purchase", dict(contact_id=supp[0], date=d(60), due_date=d(30), reference="PW-9310"),
                    [dict(item_id=new[0], qty=12, unit_price=to_cents(54), tax_code_id=tc["GST"])], "open")
    L.save_document(db, "purchase", dict(contact_id=aqua, date=d(50), due_date=d(20), reference="APD-118"),
                    [dict(item_id=new[1], qty=20, unit_price=to_cents(4.5), tax_code_id=tc["GST"])], "open")
    L.save_document(db, "sale", dict(contact_id=cust[2], date=d(12), due_date=d(-2)),
                    [dict(item_id=new[0], qty=9, unit_price=_price(db, new[0]), tax_code_id=tc["GST"]),
                     dict(item_id=new[1], qty=16, unit_price=_price(db, new[1]), tax_code_id=tc["GST"])], "open")
    # a purchase order for pumps: 4 of the 10 have arrived so far
    po = L.save_document(db, "purchase", dict(contact_id=supp[0], date=d(9), due_date=d(-21), reference="PO for pumps"),
                         [dict(item_id=items[1], qty=10, unit_price=to_cents(315), tax_code_id=tc["GST"])], "order")
    line = db.execute("SELECT id FROM document_lines WHERE document_id=?", (po,)).fetchone()[0]
    receive(db, po, {line: 4}, d(4), "PW-9402")
    # quotes: waiting (the one above), accepted, declined and expired
    db.execute("UPDATE documents SET valid_until=? WHERE side='sale' AND status='quote'", (d(-28),))

    def quote(c, days, lines, valid, notes=None):
        q = L.save_document(db, "sale", dict(contact_id=c, date=d(days), due_date=d(days - 14), notes=notes),
                            [dict(item_id=i, qty=n, unit_price=_price(db, i), tax_code_id=tc["GST"]) for i, n in lines],
                            "quote")
        db.execute("UPDATE documents SET valid_until=? WHERE id=?", (d(valid), q))
        return q
    q = quote(cust[0], 6, [(items[2], 4), (items[3], 3)], -24, "Install four filtered taps in the staff kitchens.")
    mark_accepted(db, q, "Sam Bayside", "in_person", by="Alex Sample", at=d(1) + " 10:15")
    q = quote(cust[3], 20, [(items[1], 1), (items[3], 2)], -10)
    mark_declined(db, q, "Went with another quote")
    db.execute("UPDATE documents SET quote_status_by='Alex Sample', quote_status_at=? WHERE id=?", (d(8) + " 15:40", q))
    quote(cust[1], 45, [(items[0], 24)], 15)


def _receipt_pdf(shop, lines, total):
    """A made-up receipt, so the demo's expense claims have something to look at."""
    from fpdf import FPDF
    p = FPDF(format=(80, 120))
    p.set_margins(6, 6)
    p.add_page()
    p.set_font("Helvetica", "B", 12)
    p.cell(0, 7, shop, new_x="LMARGIN", new_y="NEXT", align="C")
    p.set_font("Helvetica", "", 8)
    p.cell(0, 5, "TAX INVOICE  (sample receipt for the demo)", new_x="LMARGIN", new_y="NEXT", align="C")
    p.ln(3)
    for what, amt in lines:
        p.cell(48, 5, what)
        p.cell(0, 5, f"${amt:,.2f}", new_x="LMARGIN", new_y="NEXT", align="R")
    p.ln(2)
    p.set_font("Helvetica", "B", 10)
    p.cell(48, 6, "TOTAL inc GST")
    p.cell(0, 6, f"${total:,.2f}", new_x="LMARGIN", new_y="NEXT", align="R")
    p.set_font("Helvetica", "", 8)
    p.cell(0, 5, f"GST included ${total / 11:,.2f}", new_x="LMARGIN", new_y="NEXT", align="R")
    return bytes(p.output())


def seed_crm(db, cust, items, acc, tc):
    """The customer page, Today screen and expense claims: a sale today, notes and follow-ups on the customers, and
    staff expense claims in every state."""
    from .views.expenses import claim_lines, staff_contact
    today = date.today()

    def d(days_ago):
        return (today - timedelta(days=days_ago)).isoformat()

    admin = (db.execute("SELECT id FROM users WHERE role='admin' ORDER BY id").fetchone() or [None])[0]
    # pumps are running low, so Low stock on the Today screen has something to show
    db.execute("UPDATE items SET reorder_level=qty_on_hand+3 WHERE sku='PMP-200'")
    # a sale today, paid straight away, so Today's sales and Money in this week have something
    inv = L.save_document(db, "sale", dict(contact_id=cust[1], date=d(0), due_date=d(-14)), [
        dict(item_id=items[3], qty=3, unit_price=_price(db, items[3]), tax_code_id=tc["GST"])], "open")
    L.record_payment(db, "in", cust[1], acc["1-1110"], d(0), [(inv, _total(db, inv))], "EFT")
    notes = [  # (customer, days ago, note, follow up in n days (negative = overdue), done)
        (0, 12, "Rang Sam about the overdue invoice. Says the cheque is in the post.", None, False),
        (0, 4, "Asked for a quote on two more filtered water taps for the new cafe.", 0, False),
        (1, 20, "Met at their gym. Happy with the pump service; wants a yearly service plan.", -2, False),
        (2, 2, "Sent the pump quote. They want to think about it over the weekend.", 5, False),
        (3, 30, "Called to confirm the office install date.", -25, True),
    ]
    for c, ago, text, follow, done in notes:
        db.execute("INSERT INTO contact_notes (contact_id, date, note, follow_up_on, done_at, done_by, user_id)"
                   " VALUES (?,?,?,?,?,?,?)",
                   (cust[c], d(ago), text, d(-follow) if follow is not None else None,
                    d(ago - 5) + " 10:15:00" if done else None, admin if done else None, admin))
    acct = lambda code: acc[code]
    claims = [  # (who, days ago, shop, amount, gst, account, note, status, receipt lines)
        ("Jamie Example", 1, "Sample Fuel Station", 94.15, 8.56, "6-1800", "Fuel for the service van", "waiting",
         [("Unleaded 48.3 L", 94.15)]),
        ("Casey Placeholder", 3, "Sample Office Store", 86.90, 7.90, "6-1500", "Printer ink and paper for the counter",
         "waiting", [("Ink cartridge x2", 64.90), ("A4 paper", 22.00)]),
        ("Robin Demo", 9, "Sample Hardware", 42.50, 3.86, "6-1900", "Fittings for a customer job", "bill",
         [("Brass fittings", 42.50)]),
        ("Alex Sample", 16, "Sample Airlines", 389.00, 35.36, "6-2200", "Flight to the Brisbane trade show", "bank",
         [("SYD-BNE return", 389.00)]),
        ("Morgan Testwell", 6, "Corner Cafe", 27.00, 2.45, "6-1000", "Coffees for a client meeting", "declined", None),
    ]
    for who, ago, shop, amount, gst, code, note, status, receipt in claims:
        xid = db.execute("INSERT INTO expense_claims (user_id, claimant, date, supplier, amount, gst, account_id, note)"
                         " VALUES (?,?,?,?,?,?,?,?)",
                         (admin, who, d(ago), shop, to_cents(amount), to_cents(gst), acct(code), note)).lastrowid
        if receipt:
            db.execute("INSERT INTO expense_receipts (claim_id, filename, mime, data) VALUES (?,?,?,?)",
                       (xid, f"receipt-{xid}.pdf", "application/pdf", _receipt_pdf(shop, receipt, amount)))
        x = db.execute("SELECT * FROM expense_claims WHERE id=?", (xid,)).fetchone()
        lines = claim_lines(db, x)
        if status == "declined":
            db.execute("UPDATE expense_claims SET status='declined', reason=?, decided_by=?, decided_at=? WHERE id=?",
                       ("No receipt. Please ask the cafe for one and claim again.", admin, d(ago - 1) + " 09:00:00", xid))
        elif status == "bill":
            cid = staff_contact(db, who)
            doc = L.save_document(db, "purchase", dict(contact_id=cid, date=x["date"], due_date=d(ago - 14),
                                                       reference=f"Claim {xid}", notes=f"Expense claim {xid} from {who}",
                                                       tax_inclusive=True),
                                  [dict(description=l["description"], qty=1, unit_price=l["amount"],
                                        account_id=l["account_id"], tax_code_id=l["tax_code_id"]) for l in lines], "open")
            db.execute("UPDATE expense_claims SET status='approved', pay_how='bill', contact_id=?, document_id=?,"
                       " decided_by=?, decided_at=? WHERE id=?", (cid, doc, admin, d(ago - 1) + " 09:00:00", xid))
        elif status == "bank":
            eid = L.bank_transaction(db, "spend", acc["1-1110"], d(ago - 2),
                                     [dict(account_id=l["account_id"], amount=l["amount"], tax_code_id=l["tax_code_id"],
                                           memo=l["memo"]) for l in lines],
                                     payee=who, reference=f"Claim {xid}", memo=f"Expense claim {xid}: {who}")
            db.execute("UPDATE expense_claims SET status='paid', pay_how='bank', entry_id=?, decided_by=?, decided_at=?"
                       " WHERE id=?", (eid, admin, d(ago - 2) + " 09:00:00", xid))


def seed_bookings(db, customers=None):
    """Riyeser Bookings: the suggested staff and job types, two named technicians and a few visits this week.
    Done visits are left ready to invoice. Only runs on a file with no bookings yet."""
    if db.execute("SELECT 1 FROM bookings").fetchone():
        return
    from .views.bookings import add_starters, refresh_job, COLOURS
    db.execute("UPDATE company SET bookings_mode='jobs' WHERE id=1")
    add_starters(db, "jobs")
    for name, price in (("Call-out", 150), ("Half day", 480), ("Full day", 900)):
        db.execute("UPDATE booking_services SET price=? WHERE name=? AND price=0", (to_cents(price), name))
    n = db.execute("SELECT COUNT(*) FROM booking_resources").fetchone()[0]
    for i, st in enumerate(s for s in DEMO_STAFF if s["role"] == "Service technician"):
        db.execute("INSERT INTO booking_resources (name, kind, colour) VALUES (?,?,?)",
                   (f"{st['first_name']} {st['last_name']}", "staff", COLOURS[(n + i) % len(COLOURS)]))
    staff = [r[0] for r in db.execute("SELECT id FROM booking_resources ORDER BY id")]
    svc = {r["name"]: r["id"] for r in db.execute("SELECT id, name FROM booking_services")}
    customers = customers or [r[0] for r in db.execute("SELECT id FROM contacts WHERE kind='customer' ORDER BY id")]
    admin = (db.execute("SELECT id FROM users WHERE role='admin' ORDER BY id").fetchone() or [None])[0]
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    visits = [  # (day of the week, time, staff, job type, customer, what, address)
        (0, "09:00", 1, "Call-out", 0, "Filter not flowing", "1 Example Lane, Sampletown"),
        (1, "08:00", 2, "Half day", 1, "Pump service", "22 Demo Road, Sampletown"),
        (2, "13:00", 0, "Call-out", 2, "Leaking tap", "5 Placeholder Ave, Sampletown"),
        (3, "09:00", 1, "Full day", 3, "Office water system install", "8 Test Street, Sampletown"),
        (4, "10:30", 2, "Call-out", 0, "Follow-up check", "1 Example Lane, Sampletown"),
    ]
    for wd, at, who, what, c, title, addr in visits:
        day = monday + timedelta(days=wd)
        status = "done" if day < today else "confirmed" if day == today else "booked"
        cid = customers[c % len(customers)] if customers else None
        jid = db.execute("INSERT INTO booking_jobs (contact_id, service_id, title, address, created_by)"
                         " VALUES (?,?,?,?,?)", (cid, svc[what], title, addr, admin)).lastrowid
        mins = db.execute("SELECT minutes FROM booking_services WHERE id=?", (svc[what],)).fetchone()[0]
        db.execute("INSERT INTO bookings (contact_id, resource_id, service_id, starts_at, minutes, title, address,"
                   " status, outcome, job_id, mode, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                   (cid, staff[who % len(staff)], svc[what], f"{day.isoformat()}T{at}", mins, title, addr, status,
                    "finished" if status == "done" else None, jid, "jobs", admin))
        refresh_job(db, jid)
    # one job still waiting for a time
    db.execute("INSERT INTO booking_jobs (contact_id, service_id, title, address, created_by) VALUES (?,?,?,?,?)",
               (customers[1 % len(customers)] if customers else None, svc["Call-out"], "Quote for a new filter",
                "22 Demo Road, Sampletown", admin))
    from .demo_site import seed_job_sheets
    seed_job_sheets(db, staff, svc, customers, admin)


def _total(db, doc_id):
    return db.execute("SELECT total FROM documents WHERE id=?", (doc_id,)).fetchone()["total"]


def _contact(db, doc_id):
    return db.execute("SELECT contact_id FROM documents WHERE id=?", (doc_id,)).fetchone()["contact_id"]


def _price(db, item_id):
    return db.execute("SELECT sell_price FROM items WHERE id=?", (item_id,)).fetchone()["sell_price"]
