"""Reports.  Each report builds a generic table: columns + rows; ints in cells are cents."""
import csv
import io
from datetime import date

from flask import Blueprint, render_template, request, Response, url_for, abort, g

from ..db import get_db, linked, fmt_money
from ..ledger import balances, fy_start, add_days
from . import opt_int
from ..perms import collapse_pay

bp = Blueprint("reports", __name__, url_prefix="/reports")

INCOME = ("income", "other_income")
EXPENSE = ("cost_of_sales", "expense", "other_expense")
SECTIONS_PL = [("income", "Income"), ("cost_of_sales", "Cost of Sales"), ("expense", "Expenses"),
               ("other_income", "Other Income"), ("other_expense", "Other Expenses")]

CATALOG = [
    ("Accounts", [("pnl", "Profit & Loss"), ("balance_sheet", "Balance Sheet"), ("trial_balance", "Trial Balance"),
                  ("gl_detail", "General Ledger Detail"), ("budget", "Budget vs Actual"),
                  ("cashflow", "Cash Movement by Account")]),
    ("GST / BAS", [("gst", "BAS / GST Summary"), ("gst_detail", "GST Detail by Tax Code")]),
    ("Sales", [("aged_receivables", "Aged Receivables"), ("sales_customer", "Sales by Customer"),
               ("sales_item", "Sales by Item")]),
    ("Purchases", [("aged_payables", "Aged Payables"), ("purchases_supplier", "Purchases by Supplier")]),
    ("Inventory", [("inventory_valuation", "Inventory Valuation"), ("reorder", "Items to Reorder")]),
    ("Payroll", [("payroll_summary", "Payroll Activity Summary")]),
    ("Jobs", [("jobs", "Job Profit & Loss")]),
]


BASIC_REPORTS = {"pnl", "gst", "aged_receivables", "sales_customer", "sales_item", "aged_payables",
                 "purchases_supplier", "inventory_valuation", "reorder"}


def _catalog():
    if g.company and g.company["edition"] == "basic":
        return [(grp, [(k, t) for k, t in items if k in BASIC_REPORTS]) for grp, items in CATALOG
                if any(k in BASIC_REPORTS for k, _ in items)]
    return CATALOG


def R(cells, kind="row", link=None, indent=0):
    return dict(cells=cells, kind=kind, link=link, indent=indent)


def _params(db):
    today = date.today().isoformat()
    a = request.args
    return dict(start=a.get("start") or fy_start(db, today), end=a.get("end") or today,
                job=opt_int(a.get("job")), asof=a.get("asof") or today)


def _accounts(db):
    return db.execute("SELECT * FROM accounts ORDER BY code").fetchall()


# ------------------------------------------------------------------ accounts reports
def rpt_pnl(db, p):
    bal = balances(db, start=p["start"], end=p["end"], job_id=p["job"])
    prior_start = add_days(p["start"], -365)
    prior = balances(db, start=prior_start, end=add_days(p["end"], -365), job_id=p["job"])
    rows, totals, ptotals = [], {}, {}
    for typ, label in SECTIONS_PL:
        accts = [a for a in _accounts(db) if a["type"] == typ and (bal.get(a["id"]) or prior.get(a["id"]))]
        sign = -1 if typ in INCOME else 1
        if not accts:
            totals[typ] = ptotals[typ] = 0
            continue
        rows.append(R([label, "", ""], "header"))
        t = pt = 0
        for a in accts:
            v, pv = sign * bal.get(a["id"], 0), sign * prior.get(a["id"], 0)
            t += v; pt += pv
            rows.append(R([f"{a['code']} {a['name']}", v, pv], indent=1,
                          link=url_for("core.account_ledger", aid=a["id"], start=p["start"], end=p["end"])))
        rows.append(R([f"Total {label}", t, pt], "total"))
        totals[typ], ptotals[typ] = t, pt
        if typ == "cost_of_sales":
            rows.append(R(["Gross Profit", totals["income"] - t, ptotals["income"] - pt], "grand"))
        if typ == "expense":
            rows.append(R(["Operating Profit", totals["income"] - totals["cost_of_sales"] - t,
                           ptotals["income"] - ptotals["cost_of_sales"] - pt], "grand"))
    net = totals.get("income", 0) + totals.get("other_income", 0) - sum(totals.get(t, 0) for t in EXPENSE)
    pnet = ptotals.get("income", 0) + ptotals.get("other_income", 0) - sum(ptotals.get(t, 0) for t in EXPENSE)
    rows.append(R(["Net Profit / (Loss)", net, pnet], "grand"))
    return dict(columns=["Account", f"{p['start']} – {p['end']}", "Same period last year"], rows=rows,
                subtitle=f"{p['start']} to {p['end']}", filters=["start", "end", "job"])


def rpt_balance_sheet(db, p):
    bal = balances(db, end=p["asof"])
    fys = fy_start(db, p["asof"])
    accts = _accounts(db)
    rows = []
    cur_earn_id, ret_id = linked(db, "current_earnings"), linked(db, "retained_earnings")
    pl_before = sum(-bal_v for k, bal_v in balances(db, end=add_days(fys, -1)).items()
                    if _type(accts, k) in INCOME + EXPENSE)
    pl_cur = sum(-v for k, v in balances(db, start=fys, end=p["asof"]).items() if _type(accts, k) in INCOME + EXPENSE)
    sums = {}
    for typ, label, sign in (("asset", "Assets", 1), ("liability", "Liabilities", -1), ("equity", "Equity", -1)):
        rows.append(R([label, ""], "header"))
        t = 0
        for a in accts:
            if a["type"] != typ:
                continue
            v = sign * bal.get(a["id"], 0)
            if a["id"] == ret_id:
                v += pl_before
            if a["id"] == cur_earn_id:
                v += pl_cur
            if not v:
                continue
            t += v
            rows.append(R([f"{a['code']} {a['name']}", v], indent=1,
                          link=url_for("core.account_ledger", aid=a["id"], start="1900-01-01", end=p["asof"])))
        rows.append(R([f"Total {label}", t], "total"))
        sums[typ] = t
        if typ == "liability":
            rows.append(R(["Net Assets", sums["asset"] - t], "grand"))
    rows.append(R(["Total Liabilities & Equity", sums["liability"] + sums["equity"]], "grand"))
    ok = sums["asset"] == sums["liability"] + sums["equity"]
    return dict(columns=["Account", f"As at {p['asof']}"], rows=rows, filters=["asof"],
                subtitle=f"As at {p['asof']}" + ("" if ok else "  ⚠ OUT OF BALANCE"))


def _type(accts, aid):
    for a in accts:
        if a["id"] == aid:
            return a["type"]


def rpt_trial_balance(db, p):
    bal = balances(db, end=p["asof"])
    rows, td, tc = [], 0, 0
    for a in _accounts(db):
        v = bal.get(a["id"], 0)
        if not v:
            continue
        d, c = (v, 0) if v > 0 else (0, -v)
        td += d; tc += c
        rows.append(R([a["code"], a["name"], d or "", c or ""],
                      link=url_for("core.account_ledger", aid=a["id"], start="1900-01-01", end=p["asof"])))
    rows.append(R(["", "Total", td, tc], "grand"))
    return dict(columns=["Code", "Account", "Debit", "Credit"], rows=rows, filters=["asof"],
                subtitle=f"As at {p['asof']}" + ("" if td == tc else " ⚠ OUT OF BALANCE"))


def rpt_gl_detail(db, p):
    rows = []
    for a in _accounts(db):
        opening = db.execute("SELECT COALESCE(SUM(l.debit-l.credit),0) b FROM journal_lines l JOIN journal_entries e"
                             " ON e.id=l.entry_id WHERE l.account_id=? AND e.date<?", (a["id"], p["start"])
                             ).fetchone()["b"]
        lines = collapse_pay(db.execute(
            "SELECT l.*, e.date, e.memo emo, e.reference, e.id eid, e.source_type, e.source_id FROM journal_lines l"
            " JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_id=? AND e.date BETWEEN ? AND ?"
            + (" AND l.job_id=?" if p["job"] else "") + " ORDER BY e.date, e.id",
            (a["id"], p["start"], p["end"]) + ((p["job"],) if p["job"] else ())).fetchall())
        if not lines:
            continue
        rows.append(R([f"{a['code']} {a['name']}", "", "", "", "", opening], "header"))
        run = opening
        for l in lines:
            run += l["debit"] - l["credit"]
            rows.append(R([l["date"], f"#{l['eid']}", l["memo"] or l["emo"] or "", l["debit"] or "",
                           l["credit"] or "", run], link=None if l["masked"] else url_for("core.entry", eid=l["eid"]),
                         indent=1))
        rows.append(R(["", "", "Closing balance", "", "", run], "total"))
    return dict(columns=["Date", "ID", "Memo", "Debit", "Credit", "Balance"], rows=rows,
                subtitle=f"{p['start']} to {p['end']}", filters=["start", "end", "job"])


def rpt_budget(db, p):
    actual = balances(db, start=p["start"], end=p["end"])
    bud = {r["account_id"]: r["amt"] for r in db.execute(
        "SELECT account_id, SUM(amount) amt FROM budgets WHERE month BETWEEN ? AND ? GROUP BY account_id",
        (p["start"][:7], p["end"][:7]))}
    rows = []
    for typ, label in SECTIONS_PL:
        accts = [a for a in _accounts(db) if a["type"] == typ and (actual.get(a["id"]) or bud.get(a["id"]))]
        if not accts:
            continue
        sign = -1 if typ in INCOME else 1
        rows.append(R([label, "", "", "", ""], "header"))
        for a in accts:
            v, b = sign * actual.get(a["id"], 0), bud.get(a["id"], 0)
            pct = f"{(v / b * 100):.0f}%" if b else "–"
            rows.append(R([f"{a['code']} {a['name']}", v, b, v - b, pct], indent=1))
    return dict(columns=["Account", "Actual", "Budget", "Variance", "% of Budget"], rows=rows,
                subtitle=f"{p['start']} to {p['end']}", filters=["start", "end"])


def rpt_cashflow(db, p):
    rows = []
    for a in db.execute("SELECT * FROM accounts WHERE is_bank=1 ORDER BY code").fetchall():
        op = balances(db, end=add_days(p["start"], -1)).get(a["id"], 0)
        r = db.execute("SELECT COALESCE(SUM(l.debit),0) i, COALESCE(SUM(l.credit),0) o FROM journal_lines l"
                       " JOIN journal_entries e ON e.id=l.entry_id WHERE l.account_id=? AND e.date BETWEEN ? AND ?",
                       (a["id"], p["start"], p["end"])).fetchone()
        rows.append(R([f"{a['code']} {a['name']}", op, r["i"], r["o"], op + r["i"] - r["o"]]))
    return dict(columns=["Account", "Opening", "Money in", "Money out", "Closing"], rows=rows,
                subtitle=f"{p['start']} to {p['end']}", filters=["start", "end"])


# ------------------------------------------------------------------ GST
def gst_figures(db, start, end):
    q = ("SELECT t.kind, a.type, SUM(l.debit) dr, SUM(l.credit) cr FROM journal_lines l"
         " JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id"
         " JOIN tax_codes t ON t.id=l.tax_code_id WHERE e.date BETWEEN ? AND ? GROUP BY t.kind, a.type")
    sales = {"gst": 0, "export": 0, "gst_free": 0, "input_taxed": 0}
    purch = {"capital": 0, "gst": 0, "gst_free": 0, "input_taxed": 0}
    for r in db.execute(q, (start, end)):
        net_cr = (r["cr"] or 0) - (r["dr"] or 0)
        if r["kind"] == "not_reportable":
            continue
        if r["type"] in INCOME:
            sales[r["kind"] if r["kind"] in sales else "gst"] += net_cr
        else:
            purch[r["kind"] if r["kind"] in purch else "gst"] += -net_cr
    b = balances(db, start=start, end=end)
    a1 = -b.get(linked(db, "gst_collected"), 0)
    b1 = b.get(linked(db, "gst_paid"), 0)
    w = db.execute("SELECT COALESCE(SUM(s.gross),0) g, COALESCE(SUM(s.tax),0) t FROM payslips s JOIN payruns r"
                   " ON r.id=s.payrun_id JOIN journal_entries e ON e.id=r.entry_id WHERE e.voided=0 AND"
                   " r.pay_date BETWEEN ? AND ?", (start, end)).fetchone()
    cap_gst = round(purch["capital"] * 0.1)
    return dict(
        G1=sum(sales.values()) + a1, G2=sales["export"], G3=sales["gst_free"] + sales["input_taxed"],
        G10=purch["capital"] + cap_gst, G11=purch["gst"] + purch["gst_free"] + purch["input_taxed"] + b1 - cap_gst,
        A1=a1, B1=b1, W1=w["g"], W2=w["t"])


def rpt_gst(db, p):
    f = gst_figures(db, p["start"], p["end"])
    rows = [R(["GST on sales", ""], "header"),
            R(["G1  Total sales (including GST)", f["G1"]], indent=1),
            R(["G2  Export sales", f["G2"]], indent=1),
            R(["G3  Other GST-free / input-taxed sales", f["G3"]], indent=1),
            R(["1A  GST on sales", f["A1"]], "total"),
            R(["GST on purchases", ""], "header"),
            R(["G10 Capital purchases (including GST)", f["G10"]], indent=1),
            R(["G11 Non-capital purchases (including GST)", f["G11"]], indent=1),
            R(["1B  GST on purchases", f["B1"]], "total"),
            R(["PAYG withholding", ""], "header"),
            R(["W1  Total salary, wages and other payments", f["W1"]], indent=1),
            R(["W2  Amounts withheld from W1", f["W2"]], indent=1),
            R(["Net amount payable / (refundable) to ATO  (1A − 1B + W2)", f["A1"] - f["B1"] + f["W2"]], "grand")]
    return dict(columns=["BAS label", "Amount"], rows=rows, subtitle=f"{p['start']} to {p['end']} (accrual basis)",
                filters=["start", "end"])


def rpt_gst_detail(db, p):
    rows = []
    for t in db.execute("SELECT * FROM tax_codes ORDER BY code").fetchall():
        r = db.execute("SELECT COALESCE(SUM(CASE WHEN a.type IN ('income','other_income') THEN l.credit-l.debit END),0) s,"
                       " COALESCE(SUM(CASE WHEN a.type NOT IN ('income','other_income') THEN l.debit-l.credit END),0) pu"
                       " FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a"
                       " ON a.id=l.account_id WHERE l.tax_code_id=? AND e.date BETWEEN ? AND ?",
                       (t["id"], p["start"], p["end"])).fetchone()
        rate = t["rate"] / 100
        rows.append(R([t["code"], t["name"], f"{t['rate']:g}%", r["s"], round(r["s"] * rate), r["pu"],
                       round(r["pu"] * rate)]))
    return dict(columns=["Code", "Description", "Rate", "Sales (ex)", "Tax collected", "Purchases (ex)", "Tax paid"],
                rows=rows, subtitle=f"{p['start']} to {p['end']} (tax estimated from net amounts)",
                filters=["start", "end"])


# ------------------------------------------------------------------ sales / purchases
def _aged(db, p, side):
    buckets = ["Current", "1–30", "31–60", "61–90", "90+"]
    rows, totals = [], [0] * 6
    docs = db.execute("SELECT d.*, c.name cname FROM documents d JOIN contacts c ON c.id=d.contact_id"
                      " WHERE d.side=? AND d.status IN ('open','paid') AND d.date<=? ORDER BY c.name, d.due_date",
                      (side, p["asof"])).fetchall()
    # outstanding as at date = total - payments made on/before asof
    paid = {r["document_id"]: r["amt"] for r in db.execute(
        "SELECT a.document_id, SUM(a.amount) amt FROM payment_allocations a JOIN payments pm ON pm.id=a.payment_id"
        " WHERE pm.voided=0 AND pm.date<=? GROUP BY a.document_id", (p["asof"],))}
    by_contact = {}
    for d in docs:
        due = d["total"] - paid.get(d["id"], 0)
        if due <= 0:
            continue
        days = (date.fromisoformat(p["asof"]) - date.fromisoformat(d["due_date"] or d["date"])).days
        idx = 0 if days <= 0 else 1 if days <= 30 else 2 if days <= 60 else 3 if days <= 90 else 4
        by_contact.setdefault((d["contact_id"], d["cname"]), []).append((d, due, idx))
    for (cid, name), items in by_contact.items():
        rows.append(R([name] + [""] * 6, "header", link=url_for("contacts.view", cid=cid)))
        ct = [0] * 6
        for d, due, idx in items:
            cells = [""] * 5
            cells[idx] = due
            ct[idx] += due; ct[5] += due
            rows.append(R([f"{d['number']}  due {d['due_date']}"] + cells + [due], indent=1,
                          link=url_for("documents.view", doc_id=d["id"])))
        rows.append(R([f"Total {name}"] + ct, "total"))
        totals = [a + b for a, b in zip(totals, ct)]
    rows.append(R(["Grand total"] + totals, "grand"))
    return dict(columns=["Contact / Document"] + buckets + ["Total"], rows=rows, subtitle=f"As at {p['asof']}",
                filters=["asof"])


def rpt_aged_receivables(db, p):
    return _aged(db, p, "sale")


def rpt_aged_payables(db, p):
    return _aged(db, p, "purchase")


def _by_contact(db, p, side):
    rows = []
    t = [0, 0, 0]
    for r in db.execute("SELECT c.id, c.name, COUNT(*) n, SUM(d.subtotal) s, SUM(d.tax_total) tx, SUM(d.total) tot"
                        " FROM documents d JOIN contacts c ON c.id=d.contact_id WHERE d.side=? AND d.status IN"
                        " ('open','paid') AND d.date BETWEEN ? AND ? GROUP BY c.id ORDER BY tot DESC",
                        (side, p["start"], p["end"])):
        rows.append(R([r["name"], str(r["n"]), r["s"], r["tx"], r["tot"]], link=url_for("contacts.view", cid=r["id"])))
        t = [t[0] + r["s"], t[1] + r["tx"], t[2] + r["tot"]]
    rows.append(R(["Total", ""] + t, "grand"))
    return dict(columns=["Contact", "Documents", "Ex tax", "Tax", "Total"], rows=rows,
                subtitle=f"{p['start']} to {p['end']}", filters=["start", "end"])


def rpt_sales_customer(db, p):
    return _by_contact(db, p, "sale")


def rpt_purchases_supplier(db, p):
    return _by_contact(db, p, "purchase")


def rpt_sales_item(db, p):
    rows = []
    for r in db.execute("SELECT i.id, i.sku, i.name, SUM(l.qty) q, SUM(l.net_amount) v FROM document_lines l"
                        " JOIN documents d ON d.id=l.document_id JOIN items i ON i.id=l.item_id WHERE d.side='sale'"
                        " AND d.status IN ('open','paid') AND d.date BETWEEN ? AND ? GROUP BY i.id ORDER BY v DESC",
                        (p["start"], p["end"])):
        cogs = db.execute("SELECT COALESCE(SUM(-qty*unit_cost),0) c FROM stock_movements WHERE item_id=? AND"
                          " source_type='invoice' AND date BETWEEN ? AND ?", (r["id"], p["start"], p["end"])
                          ).fetchone()["c"]
        cogs = round(cogs)
        rows.append(R([r["sku"], r["name"], f"{r['q']:g}", r["v"], cogs, r["v"] - cogs],
                      link=url_for("inventory.view", iid=r["id"])))
    return dict(columns=["SKU", "Item", "Qty sold", "Sales (ex)", "Cost of sales", "Gross profit"], rows=rows,
                subtitle=f"{p['start']} to {p['end']}", filters=["start", "end"])


# ------------------------------------------------------------------ inventory / payroll / jobs
def rpt_inventory_valuation(db, p):
    rows, tot = [], 0
    for i in db.execute("SELECT * FROM items WHERE is_inventoried=1 ORDER BY sku"):
        v = round(i["qty_on_hand"] * i["avg_cost"])
        tot += v
        rows.append(R([i["sku"], i["name"], f"{i['qty_on_hand']:g}", round(i["avg_cost"]), v],
                      link=url_for("inventory.view", iid=i["id"])))
    accts = {linked(db, "inventory")} | {r[0] for r in db.execute(
        "SELECT DISTINCT asset_account_id FROM items WHERE is_inventoried=1 AND asset_account_id IS NOT NULL")}
    b = balances(db)
    gl = sum(b.get(a, 0) for a in accts)
    rows.append(R(["", "Total inventory value", "", "", tot], "grand"))
    rows.append(R(["", "Inventory GL account balance", "", "", gl], "total"))
    rep = dict(columns=["SKU", "Item", "On hand", "Avg cost", "Value"], rows=rows, subtitle="Current", filters=[])
    if gl != tot:
        rep["warning"] = (f"The stock value ({fmt_money(tot)}) doesn't match the Inventory account ({fmt_money(gl)}): "
                          f"{fmt_money(gl - tot)} out. Check journals or bills posted to the Inventory account.")
    return rep


def rpt_reorder(db, p):
    rows = [R([i["sku"], i["name"], f"{i['qty_on_hand']:g}", f"{i['reorder_level']:g}", i["buy_price"]],
              link=url_for("inventory.view", iid=i["id"]))
            for i in db.execute("SELECT * FROM items WHERE is_inventoried=1 AND active=1 AND"
                                " qty_on_hand<=reorder_level ORDER BY sku")]
    return dict(columns=["SKU", "Item", "On hand", "Reorder level", "Buy price"], rows=rows, subtitle="Current",
                filters=[])


def rpt_payroll_summary(db, p):
    rows, t = [], [0, 0, 0, 0]
    for r in db.execute("SELECT e.id, e.first_name, e.last_name, SUM(s.hours) h, SUM(s.gross) g, SUM(s.tax) tx,"
                        " SUM(s.super) su, SUM(s.net) n FROM payslips s JOIN payruns r ON r.id=s.payrun_id"
                        " JOIN employees e ON e.id=s.employee_id JOIN journal_entries je ON je.id=r.entry_id"
                        " WHERE je.voided=0 AND r.pay_date BETWEEN ? AND ? GROUP BY e.id ORDER BY e.last_name",
                        (p["start"], p["end"])):
        rows.append(R([f"{r['first_name']} {r['last_name']}", f"{r['h']:g}", r["g"], r["tx"], r["su"], r["n"]],
                      link=url_for("payroll.employee", eid=r["id"])))
        t = [t[0] + r["g"], t[1] + r["tx"], t[2] + r["su"], t[3] + r["n"]]
    rows.append(R(["Total", ""] + t, "grand"))
    return dict(columns=["Employee", "Hours", "Gross", "PAYG", "Super", "Net"], rows=rows,
                subtitle=f"{p['start']} to {p['end']}", filters=["start", "end"])


def rpt_jobs(db, p):
    rows = []
    for j in db.execute("SELECT * FROM jobs ORDER BY code").fetchall():
        b = balances(db, start=p["start"], end=p["end"], job_id=j["id"])
        types = {a["id"]: a["type"] for a in _accounts(db)}
        inc = -sum(v for k, v in b.items() if types[k] in INCOME)
        exp = sum(v for k, v in b.items() if types[k] in EXPENSE)
        if inc or exp:
            margin = f"{(inc - exp) / inc * 100:.1f}%" if inc else "–"
            rows.append(R([j["code"], j["name"], inc, exp, inc - exp, margin],
                          link=url_for("reports.show", name="pnl", job=j["id"], start=p["start"], end=p["end"])))
    return dict(columns=["Job", "Name", "Income", "Expenses", "Profit", "Margin"], rows=rows,
                subtitle=f"{p['start']} to {p['end']}", filters=["start", "end"])


# ------------------------------------------------------------------ routes
@bp.route("/")
def index():
    from ..perms import can, report_area
    cat = [(grp, [(k, t) for k, t in items if can(report_area(k))]) for grp, items in _catalog()]
    return render_template("reports/index.html", catalog=[(grp, items) for grp, items in cat if items])


@bp.route("/<name>")
def show(name):
    fn = globals().get(f"rpt_{name}")
    title = next((t for _, items in _catalog() for k, t in items if k == name), None)
    if not fn or not title:
        abort(404)
    db = get_db()
    p = _params(db)
    rep = fn(db, p)
    rep["title"] = title
    if p["job"]:
        j = db.execute("SELECT code, name FROM jobs WHERE id=?", (p["job"],)).fetchone()
        if j:
            rep["subtitle"] += f" — Job {j['code']} {j['name']}"
    if request.args.get("format") == "csv":
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(rep["columns"])
        for r in rep["rows"]:
            w.writerow([fmt_money(c).replace("$", "").replace(",", "") if isinstance(c, (int, float)) else c
                        for c in r["cells"]])
        return Response(out.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": f"attachment; filename={name}_{date.today()}.csv"})
    jobs = db.execute("SELECT * FROM jobs ORDER BY code").fetchall()
    return render_template("reports/report.html", rep=rep, p=p, name=name, jobs=jobs)
