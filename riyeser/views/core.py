"""Dashboard, setup, chart of accounts, general journal, transaction search, audit."""
from flask import Blueprint, render_template, request, redirect, url_for, flash, g, abort

from ..db import get_db, audit, to_cents, linked
from ..ledger import general_journal, reverse_entry, balances, fy_start, PostingError, check_journal_lines
from . import lookups, opt_int, form_lines, guarded, admin_only
from ..perms import can, PAYROLL_SOURCES, collapse_pay

bp = Blueprint("core", __name__)

SOURCE_LINKS = {"invoice": "documents.view", "bill": "documents.view"}


# ------------------------------------------------------------------ dashboard

def _hide_payroll_sql():
    """Wages entries are left out for users who can't see payroll."""
    return "" if can("payroll") else " AND e.source_type NOT IN ('payrun','payroll_import')"


@bp.route("/")
def dashboard():
    """Today: the home screen. One look at the day: sales, money in, who owes, bills due, stock, bookings, follow-ups."""
    from .today import today_data
    return render_template("core/today.html", **today_data(get_db()))


@bp.route("/today")
def today():
    """The same Today screen, for Riyeser POS (where the till is the home screen)."""
    return dashboard()


@bp.route("/overview")
def overview():
    """The business at a glance: the year's figures, bank balances and recent transactions."""
    db = get_db()
    today = g.get("today") or __import__("datetime").date.today().isoformat()
    start = fy_start(db, today)
    bal = balances(db, end=today)
    ytd = balances(db, start=start, end=today)
    accts = {a["id"]: a for a in db.execute("SELECT * FROM accounts")}
    banks = [(a, bal.get(a["id"], 0)) for a in accts.values() if a["is_bank"] and a["active"]]
    income = -sum(v for k, v in ytd.items() if accts[k]["type"] in ("income", "other_income"))
    expenses = sum(v for k, v in ytd.items() if accts[k]["type"] in ("cost_of_sales", "expense", "other_expense"))
    ar = db.execute("SELECT COALESCE(SUM(total-amount_paid),0) s, COUNT(*) n FROM documents"
                    " WHERE side='sale' AND status='open'").fetchone()
    ap = db.execute("SELECT COALESCE(SUM(total-amount_paid),0) s, COUNT(*) n FROM documents"
                    " WHERE side='purchase' AND status='open'").fetchone()
    overdue = db.execute("SELECT d.*, c.name cname FROM documents d JOIN contacts c ON c.id=d.contact_id"
                         " WHERE d.side='sale' AND d.status='open' AND d.kind='invoice' AND d.due_date < ?"
                         " ORDER BY d.due_date LIMIT 8",
                         (today,)).fetchall()
    bills_due = db.execute("SELECT d.*, c.name cname FROM documents d JOIN contacts c ON c.id=d.contact_id"
                           " WHERE d.side='purchase' AND d.status='open' AND d.kind='invoice' ORDER BY d.due_date LIMIT 8").fetchall()
    low_stock = db.execute("SELECT * FROM items WHERE is_inventoried=1 AND active=1 AND qty_on_hand<=reorder_level"
                           " ORDER BY sku LIMIT 8").fetchall()
    # monthly income vs expense for last 6 months of FY
    months = db.execute(
        "SELECT substr(e.date,1,7) m,"
        " SUM(CASE WHEN a.type IN ('income','other_income') THEN l.credit-l.debit ELSE 0 END) inc,"
        " SUM(CASE WHEN a.type IN ('cost_of_sales','expense','other_expense') THEN l.debit-l.credit ELSE 0 END) exp"
        " FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id"
        " WHERE e.date <= ? GROUP BY m ORDER BY m DESC LIMIT 6", (today,)).fetchall()[::-1]
    recent = db.execute("SELECT * FROM journal_entries e WHERE 1=1" + _hide_payroll_sql() + " ORDER BY id DESC LIMIT 8").fetchall()
    return render_template("core/dashboard.html", banks=banks, income=income, expenses=expenses, ar=ar, ap=ap,
                           overdue=overdue, bills_due=bills_due, low_stock=low_stock, months=months,
                           recent=recent, fy_start=start, today=today)


# ------------------------------------------------------------------ chart of accounts
@bp.route("/accounts")
def accounts():
    db = get_db()
    bal = balances(db)
    rows = db.execute("SELECT a.*, t.code tcode FROM accounts a LEFT JOIN tax_codes t ON t.id=a.tax_code_id"
                      " ORDER BY a.code").fetchall()
    return render_template("core/accounts.html", rows=rows, bal=bal, **lookups(db))


@bp.route("/accounts/save", methods=["POST"])
@guarded
def save_account():
    db = get_db()
    f = request.form
    aid = opt_int(f.get("id"))
    vals = (f["code"].strip(), f["name"].strip(), f["type"], 1 if f.get("is_bank") else 0,
            opt_int(f.get("tax_code_id")), f.get("description"), 1 if f.get("active", "1") else 0)
    if not vals[0] or not vals[1]:
        raise ValueError("Code and name are required.")
    other = db.execute("SELECT name FROM accounts WHERE code=? AND id IS NOT ?", (vals[0], aid)).fetchone()
    if other:
        raise ValueError(f"Code {vals[0]} is already used by {other['name']}.")  # M23
    if aid:
        was = db.execute("SELECT is_bank FROM accounts WHERE id=?", (aid,)).fetchone()
        bal = balances(db).get(aid, 0)
        if was and was["is_bank"] and not vals[3] and bal and not f.get("confirm_unbank"):
            raise ValueError(f"This bank account has {__import__('riyeser.db', fromlist=['x']).fmt_money(bal)} in it. "
                             "Unticking 'bank account' hides it from Banking: tick 'Hide it anyway' to go ahead.")  # M24
        old = db.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
        used = db.execute("SELECT key FROM linked_accounts WHERE account_id=? UNION SELECT 'tax' FROM tax_codes"
                          " WHERE collected_account_id=? OR paid_account_id=?", (aid, aid, aid)).fetchone()
        if old and used and old["type"] != vals[2]:
            # S55: a linked account (Trade Debtors, GST, Wages...) keeps its type, or the reports put it in the wrong place
            raise ValueError(f"{old['code']} {old['name']} is used automatically by Riyeser, so its type can't be "
                             f"changed. Link another account first (Setup, Linked accounts).")
        db.execute("UPDATE accounts SET code=?, name=?, type=?, is_bank=?, tax_code_id=?, description=?, active=?"
                   " WHERE id=?", vals + (aid,))
    else:
        aid = db.execute("INSERT INTO accounts (code, name, type, is_bank, tax_code_id, description, active)"
                         " VALUES (?,?,?,?,?,?,?)", vals).lastrowid
        ob = to_cents(f.get("opening_balance"))
        if ob:
            # natural-side opening balance against historical balancing
            debit_nature = f["type"] in ("asset", "expense", "cost_of_sales", "other_expense")
            signed = ob if debit_nature else -ob
            hb = linked(db, "historical_balancing")
            general_journal(db, f.get("opening_date") or fy_start(db), f"Opening balance {vals[0]}",
                            [dict(account_id=aid, debit=max(signed, 0), credit=max(-signed, 0)),
                             dict(account_id=hb, debit=max(-signed, 0), credit=max(signed, 0))])
    audit(db, "save_account", vals[0])
    flash(f"Account {vals[0]} saved.", "ok")
    return redirect(url_for("core.accounts"))


@bp.route("/accounts/<int:aid>")
def account_ledger(aid):
    db = get_db()
    acct = db.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
    start = request.args.get("start") or fy_start(db)
    end = request.args.get("end") or __import__("datetime").date.today().isoformat()
    opening = db.execute("SELECT COALESCE(SUM(l.debit-l.credit),0) b FROM journal_lines l JOIN journal_entries e"
                         " ON e.id=l.entry_id WHERE l.account_id=? AND e.date<?", (aid, start)).fetchone()["b"]
    # pay runs stay in the register (so it adds up), as one "Wages (pay run n)" line for people without payroll
    rows = collapse_pay(db.execute("SELECT l.*, e.date, e.memo emo, e.reference, e.source_type, e.source_id, e.id eid"
                                   " FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id"
                                   " WHERE l.account_id=? AND e.date BETWEEN ? AND ? ORDER BY e.date, e.id",
                                   (aid, start, end)).fetchall())
    return render_template("core/account_ledger.html", acct=acct, rows=rows, opening=opening, start=start, end=end)


# ------------------------------------------------------------------ general journal
@bp.route("/journal")
def journal_list():
    db = get_db()
    q = request.args.get("q", "").strip()
    src = request.args.get("source", "")
    sql = "SELECT e.*, (SELECT SUM(debit) FROM journal_lines WHERE entry_id=e.id) amt FROM journal_entries e WHERE 1=1" + _hide_payroll_sql()
    p = []
    if q:
        sql += " AND (e.memo LIKE ? OR e.reference LIKE ? OR e.id = ?)"
        p += [f"%{q}%", f"%{q}%", opt_int(q) or -1]
    if src:
        sql += " AND e.source_type=?"; p.append(src)
    if request.args.get("start"):
        sql += " AND e.date>=?"; p.append(request.args["start"])
    if request.args.get("end"):
        sql += " AND e.date<=?"; p.append(request.args["end"])
    sql += " ORDER BY e.date DESC, e.id DESC LIMIT 300"
    return render_template("core/journal_list.html", rows=db.execute(sql, p).fetchall(), q=q, src=src)


@bp.route("/journal/new", methods=["GET", "POST"])
def journal_new():
    db = get_db()
    if request.method == "POST":
        return _save_journal()
    return render_template("core/journal_form.html", **lookups(db))


@guarded
def _save_journal():
    db = get_db()
    lines = []
    for n, l in enumerate(form_lines(["account", "debit", "credit", "tax", "job", "memo"]), 1):
        if not l["account"]:
            continue
        dr, cr = to_cents(l["debit"]), to_cents(l["credit"])
        if dr < 0 or cr < 0:
            raise PostingError(f"Line {n}: enter positive amounts (a credit goes in the Credit column).")  # M24
        if dr and cr:
            raise PostingError(f"Line {n}: a line is either a debit or a credit, not both.")  # M24
        lines.append(dict(account_id=int(l["account"]), debit=dr, credit=cr,
                          tax_code_id=opt_int(l["tax"]), job_id=opt_int(l["job"]), memo=l["memo"]))
    check_journal_lines(db, lines, gst_ok=bool(request.form.get("gst_adjustment")))
    eid = general_journal(db, request.form["date"], request.form.get("memo"), lines, request.form.get("reference"))
    flash(f"Journal #{eid} recorded.", "ok")
    return redirect(url_for("core.entry", eid=eid))


@bp.route("/entry/<int:eid>")
def entry(eid):
    db = get_db()
    e = db.execute("SELECT e.*, u.username FROM journal_entries e LEFT JOIN users u ON u.id=e.created_by"
                   " WHERE e.id=?", (eid,)).fetchone()
    lines = db.execute("SELECT l.*, a.code, a.name, t.code tcode, j.code jcode FROM journal_lines l"
                       " JOIN accounts a ON a.id=l.account_id LEFT JOIN tax_codes t ON t.id=l.tax_code_id"
                       " LEFT JOIN jobs j ON j.id=l.job_id WHERE l.entry_id=? ORDER BY l.id", (eid,)).fetchall()
    if e and e["source_type"] in PAYROLL_SOURCES and not can("payroll"):
        abort(403)
    reversal = db.execute("SELECT id FROM journal_entries WHERE reverses_id=?", (eid,)).fetchone()
    return render_template("core/entry.html", e=e, lines=lines, reversal=reversal)


@bp.route("/entry/<int:eid>/reverse", methods=["POST"])
@guarded
def reverse(eid):
    db = get_db()
    e = db.execute("SELECT * FROM journal_entries WHERE id=?", (eid,)).fetchone()
    if e["source_type"] not in ("journal", "spend", "receive", "transfer", "stock_adj", "payroll_import"):
        raise PostingError("Reverse this transaction from its source document (invoice, bill, payment or pay run).")
    rid = reverse_entry(db, eid, request.form.get("date") or None)
    audit(db, "reverse_entry", f"#{eid} -> #{rid}")
    db.execute("UPDATE bank_feed_lines SET entry_id=NULL WHERE entry_id=?", (eid,))
    db.execute("DELETE FROM imported_payruns WHERE entry_id=?", (eid,))  # can be imported again
    flash(f"Entry #{eid} reversed by #{rid}.", "ok")
    return redirect(url_for("core.entry", eid=rid))


# ------------------------------------------------------------------ setup
@bp.route("/editions")
def upgrade():
    """Accounting Basics or Accounting Plus: what each has, and how to move between the two apps."""
    from ..edition import app_edition
    return render_template("core/upgrade.html", here=g.company["edition"], separate_apps=bool(app_edition()))


@bp.route("/setup/bookings-app")
def bookings_app():
    """In Accounting, Invoices and POS: Riyeser Bookings is its own app, on the same company file."""
    from ..edition import download_url
    return render_template("core/bookings_app.html", download=download_url("bookings"))


@bp.route("/setup/accounting-basics")
def invoices_upgrade():
    """Riyeser Invoices: what Accounting Basics adds, and where to get it."""
    from ..edition import download_url
    return render_template("core/invoices_upgrade.html", basics_url=download_url("basic"))


@bp.route("/setup/company", methods=["GET", "POST"])
def company():
    db = get_db()
    if request.method == "POST":
        return _save_company()
    linked_rows = db.execute("SELECT l.key, l.account_id FROM linked_accounts l ORDER BY l.key").fetchall()
    from ..pdf import docs_root
    return render_template("core/company.html", linked_rows=linked_rows, docs_root=docs_root(), **lookups(db))


@admin_only
@guarded
def _save_company():
    db = get_db()
    f = request.form
    old_lock = db.execute("SELECT lock_date FROM company WHERE id=1").fetchone()[0]
    if (f.get("lock_date") or None) != old_lock:
        fmt = lambda d: __import__("datetime").date.fromisoformat(d).strftime("%d/%m/%Y") if d else "(none)"
        audit(db, "lock_date", f"Lock date changed from {fmt(old_lock)} to {fmt(f.get('lock_date') or None)} by "
                               f"{g.user['username']}")  # M18
    db.execute("UPDATE company SET name=?, abn=?, address=?, phone=?, email=?, fy_start_month=?, lock_date=?,"
               " gst_registered=?, invoice_prefix=?, bill_prefix=?, next_invoice_no=?, next_bill_no=?,"
               " default_terms_days=? WHERE id=1",
               (f["name"], f.get("abn"), f.get("address"), f.get("phone"), f.get("email"),
                int(f.get("fy_start_month") or 7), f.get("lock_date") or None, 1 if f.get("gst_registered") else 0,
                f.get("invoice_prefix") or "INV", f.get("bill_prefix") or "PO", int(f.get("next_invoice_no") or 1),
                int(f.get("next_bill_no") or 1), int(f.get("default_terms_days") or 30)))
    db.execute("UPDATE company SET auto_pdf=? WHERE id=1", (1 if f.get("auto_pdf") else 0,))
    db.execute("UPDATE company SET bank_name=?, bank_account_name=?, bank_bsb=?, bank_account_no=?,"
               " payment_instructions=? WHERE id=1",
               tuple((f.get(k) or "").strip() or None for k in ("bank_name", "bank_account_name", "bank_bsb",
                                                                  "bank_account_no", "payment_instructions")))
    cur = (f.get("currency") or "").strip().upper()
    if cur:
        if len(cur) != 3 or not cur.isalpha():
            raise ValueError("Currency is a three-letter code, like AUD, FJD or NZD.")
        db.execute("UPDATE company SET currency=? WHERE id=1", (cur,))
    if f.get("edition") == "enterprise" and not g.company["enterprise_allowed"]:
        from ..db import EDITIONS, PRICES
        flash(f"{EDITIONS['enterprise']['name']} needs a Riyeser licence. Enter one in Riyeser Central, then switch "
              f"here. {EDITIONS['basic']['name']} is {PRICES['basic']} a month per business after the 90-day free trial.", "error")
    elif f.get("edition") in ("basic", "enterprise"):
        db.execute("UPDATE company SET edition=? WHERE id=1", (f["edition"],))
    for key in [r["key"] for r in db.execute("SELECT key FROM linked_accounts")]:
        v = opt_int(f.get(f"linked_{key}"))
        if v:
            db.execute("UPDATE linked_accounts SET account_id=? WHERE key=?", (v, key))
    audit(db, "company_settings", "updated")
    flash("Company settings saved.", "ok")
    return redirect(url_for("core.company"))


@bp.route("/setup/tax-codes", methods=["GET", "POST"])
def tax_codes():
    db = get_db()
    if request.method == "POST":
        return _save_tax()
    return render_template("core/tax_codes.html", **lookups(db))


@guarded
def _save_tax():
    db = get_db()
    f = request.form
    tid = opt_int(f.get("id"))
    vals = (f["code"].strip().upper(), f["name"], float(f.get("rate") or 0), f["kind"],
            opt_int(f.get("collected_account_id")), opt_int(f.get("paid_account_id")))
    if tid:
        db.execute("UPDATE tax_codes SET code=?, name=?, rate=?, kind=?, collected_account_id=?, paid_account_id=?"
                   " WHERE id=?", vals + (tid,))
    else:
        db.execute("INSERT INTO tax_codes (code, name, rate, kind, collected_account_id, paid_account_id)"
                   " VALUES (?,?,?,?,?,?)", vals)
    audit(db, "save_tax_code", vals[0])
    flash("Tax code saved.", "ok")
    return redirect(url_for("core.tax_codes"))


@bp.route("/setup/jobs", methods=["GET", "POST"])
def jobs():
    db = get_db()
    if request.method == "POST":
        return _save_job()
    rows = db.execute("SELECT j.*, c.name cname FROM jobs j LEFT JOIN contacts c ON c.id=j.contact_id"
                      " ORDER BY j.code").fetchall()
    customers = db.execute("SELECT id, name FROM contacts WHERE kind='customer' ORDER BY name").fetchall()
    return render_template("core/jobs.html", rows=rows, customers=customers)


@guarded
def _save_job():
    db = get_db()
    f = request.form
    jid = opt_int(f.get("id"))
    vals = (f["code"].strip(), f["name"], opt_int(f.get("contact_id")), 1 if f.get("active", "1") else 0)
    if jid:
        db.execute("UPDATE jobs SET code=?, name=?, contact_id=?, active=? WHERE id=?", vals + (jid,))
    else:
        db.execute("INSERT INTO jobs (code, name, contact_id, active) VALUES (?,?,?,?)", vals)
    audit(db, "save_job", vals[0])
    flash("Job saved.", "ok")
    return redirect(url_for("core.jobs"))


@bp.route("/setup/budgets", methods=["GET", "POST"])
def budgets():
    db = get_db()
    year = int(request.values.get("fy") or fy_start(db)[:4])
    m0 = g.company["fy_start_month"]
    months = [f"{year + (m0 + i - 1) // 12}-{(m0 + i - 1) % 12 + 1:02d}" for i in range(12)]
    if request.method == "POST":
        return _save_budgets(months, year)
    accts = db.execute("SELECT * FROM accounts WHERE active=1 AND type IN"
                       " ('income','cost_of_sales','expense','other_income','other_expense') ORDER BY code").fetchall()
    data = {(r["account_id"], r["month"]): r["amount"] for r in
            db.execute("SELECT * FROM budgets WHERE month BETWEEN ? AND ?", (months[0], months[-1]))}
    return render_template("core/budgets.html", accts=accts, months=months, data=data, year=year)


@guarded
def _save_budgets(months, year):
    db = get_db()
    for key, val in request.form.items():
        if not key.startswith("b_"):
            continue
        _, aid, month = key.split("_")
        amt = to_cents(val)
        db.execute("INSERT INTO budgets (account_id, month, amount) VALUES (?,?,?)"
                   " ON CONFLICT(account_id, month) DO UPDATE SET amount=excluded.amount", (int(aid), month, amt))
    audit(db, "save_budgets", str(year))
    flash("Budgets saved.", "ok")
    return redirect(url_for("core.budgets", fy=year))


@bp.route("/setup/audit")
def audit_log():
    hide = "" if can("payroll") else (" WHERE a.action NOT IN ('payrun','void_payrun','save_employee','payroll_import')")
    rows = get_db().execute("SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id=a.user_id" + hide +
                            " ORDER BY a.id DESC LIMIT 500").fetchall()
    return render_template("core/audit.html", rows=rows)
