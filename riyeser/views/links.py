"""Links to the other Riyeser Group modules.

Riyeser Payroll -> Accounting: Payroll writes one JSON file per pay run into
Documents\\Riyeser\\Inbox\\Payroll (format: see INTEGRATION.md). Accounting lists them
here and posts each one once as a summary journal.
"""
import json
import shutil
from datetime import date

from flask import Blueprint, render_template, request, redirect, url_for, flash

from ..db import get_db, linked, to_cents, audit, fmt_money
from ..ledger import post_entry, PostingError
from ..pdf import docs_root, safe_name
from . import lookups, opt_int, guarded

bp = Blueprint("links", __name__, url_prefix="/links")
FORMAT = "riyeser.payrun.v1"


def inbox():
    p = docs_root() / "Inbox" / "Payroll"
    p.mkdir(parents=True, exist_ok=True)
    return p


def ensure_table(db):
    db.execute("""CREATE TABLE IF NOT EXISTS imported_payruns (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, payrun_id TEXT NOT NULL, pay_date TEXT,
        employees INTEGER, gross INTEGER, entry_id INTEGER REFERENCES journal_entries(id),
        file_name TEXT, imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE(source, payrun_id))""")


def parse_payrun(raw):
    """Validate a pay-run file and return totals in cents."""
    try:
        d = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise PostingError("This isn't a Riyeser pay run file (not valid JSON).")
    if d.get("format") != FORMAT:
        raise PostingError(f"Unknown file format; expected \"{FORMAT}\".")
    for key in ("payrun_id", "pay_date", "employees"):
        if not d.get(key):
            raise PostingError(f"The pay run file is missing \"{key}\".")
    date.fromisoformat(d["pay_date"])
    emps = []
    for e in d["employees"]:
        gross, tax = to_cents(e.get("gross")), to_cents(e.get("tax_withheld"))
        emp_contrib, deductions = to_cents(e.get("employer_contribution")), to_cents(e.get("other_deductions"))
        net = to_cents(e.get("net")) if e.get("net") is not None else gross - tax - deductions
        if gross - tax - deductions != net:
            raise PostingError(f"{e.get('name', 'An employee')}: gross minus tax and deductions doesn't equal net pay.")
        emps.append(dict(name=e.get("name") or "Employee", gross=gross, tax=tax, contrib=emp_contrib,
                         deductions=deductions, net=net))
    tot = {k: sum(e[k] for e in emps) for k in ("gross", "tax", "contrib", "deductions", "net")}
    return dict(source=d.get("source") or "Riyeser Payroll", payrun_id=str(d["payrun_id"]), pay_date=d["pay_date"],
                period=f"{d.get('period_start', '')} to {d.get('period_end', '')}".strip(" to"),
                currency=d.get("currency") or "", employees=emps, totals=tot)


# Where each part of an imported pay run is posted (S30). Chosen on the first import and kept for the next ones.
ROLES = [("wages", "Gross wages (expense)"),
         ("contrib_expense", "Employer contributions: super or employer FNPF (expense)"),
         ("tax_payable", "Tax withheld: PAYG or PAYE (payable)"),
         ("contrib_payable", "Employer contributions (payable)"),
         ("deductions_payable", "Employee deductions: their own FNPF, loans (payable)")]
DEDUCTIONS_ACCOUNT = ("2-1430", "Payroll Deductions Payable")


def _deductions_default(db):
    row = db.execute("SELECT id FROM accounts WHERE code=?", (DEDUCTIONS_ACCOUNT[0],)).fetchone()
    if row:
        return row["id"]
    ntc = db.execute("SELECT id FROM tax_codes WHERE code='N-T'").fetchone()
    return db.execute("INSERT INTO accounts (code, name, type, is_bank, tax_code_id) VALUES (?,?,'liability',0,?)",
                      DEDUCTIONS_ACCOUNT + (ntc["id"] if ntc else None,)).lastrowid


def import_accounts(db, create=False):
    """{role: account_id}: the saved choice, else the defaults (the deductions account is made when needed)."""
    saved = {r["role"]: r["account_id"] for r in db.execute("SELECT role, account_id FROM payroll_import_accounts")}
    dflt = dict(wages=linked(db, "wages"), contrib_expense=linked(db, "super_expense"),
                tax_payable=linked(db, "payg_payable"), contrib_payable=linked(db, "super_payable"))
    if "deductions_payable" not in saved:
        row = db.execute("SELECT id FROM accounts WHERE code=?", (DEDUCTIONS_ACCOUNT[0],)).fetchone()
        dflt["deductions_payable"] = row["id"] if row else (_deductions_default(db) if create else None)
    return {**dflt, **saved}


def save_import_accounts(db, chosen):
    valid = {r["id"] for r in db.execute("SELECT id FROM accounts WHERE active=1")}
    for role, _label in ROLES:
        aid = chosen.get(role)
        if aid:
            if aid not in valid:
                raise PostingError("Choose an account for each part of the pay run.")
            db.execute("INSERT OR REPLACE INTO payroll_import_accounts (role, account_id) VALUES (?,?)", (role, aid))


def check_currency(db, pr):
    """An FJD pay run can't go into AUD books as if FJ$1 were A$1 (S30)."""
    books = (db.execute("SELECT currency FROM company WHERE id=1").fetchone()["currency"] or "AUD").upper()
    cur = (pr.get("currency") or "").strip().upper()
    if cur and cur != books:
        raise PostingError(f"This pay run is in {cur}, but this company keeps its books in {books}. Import it into "
                           f"the company that pays in {cur}, or set the currency in Setup, Company details.")


def import_payrun(db, pr, bank_account_id, file_name=None, accounts=None):
    ensure_table(db)
    if db.execute("SELECT 1 FROM imported_payruns WHERE source=? AND payrun_id=?",
                  (pr["source"], pr["payrun_id"])).fetchone():
        raise PostingError(f"Pay run {pr['payrun_id']} has already been imported.")
    check_currency(db, pr)
    if accounts:
        save_import_accounts(db, accounts)
    a = import_accounts(db, create=True)
    t = pr["totals"]
    lines = [dict(account_id=a["wages"], debit=t["gross"], memo="Gross wages"),
             dict(account_id=a["contrib_expense"], debit=t["contrib"], memo="Employer contributions"),
             dict(account_id=a["tax_payable"], credit=t["tax"], memo="Tax withheld"),
             dict(account_id=a["contrib_payable"], credit=t["contrib"], memo="Employer contributions payable"),
             dict(account_id=bank_account_id, credit=t["net"], memo="Net wages paid")]
    if t["deductions"]:
        lines.append(dict(account_id=a["deductions_payable"], credit=t["deductions"],
                          memo="Employee deductions (own FNPF, loans)"))
    eid = post_entry(db, pr["pay_date"], f"{pr['source']} pay run {pr['payrun_id']} ({len(pr['employees'])} staff)",
                     "payroll_import", lines, reference=pr["payrun_id"])
    db.execute("UPDATE journal_entries SET source_id=? WHERE id=?", (eid, eid))
    db.execute("INSERT INTO imported_payruns (source, payrun_id, pay_date, employees, gross, entry_id, file_name)"
               " VALUES (?,?,?,?,?,?,?)", (pr["source"], pr["payrun_id"], pr["pay_date"], len(pr["employees"]),
                                           t["gross"], eid, file_name))
    audit(db, "payroll_import", f"{pr['payrun_id']} gross {fmt_money(t['gross'])}")
    return eid


@bp.route("/payroll", methods=["GET", "POST"])
def payroll():
    db = get_db()
    ensure_table(db)
    if request.method == "POST":
        return _do_import()
    files = []
    for f in sorted(inbox().glob("*.json")):
        try:
            pr = parse_payrun(f.read_text(encoding="utf-8"))
            done = db.execute("SELECT entry_id FROM imported_payruns WHERE source=? AND payrun_id=?",
                              (pr["source"], pr["payrun_id"])).fetchone()
            files.append(dict(name=f.name, pr=pr, done=done, error=None))
        except (PostingError, ValueError, OSError) as e:
            files.append(dict(name=f.name, pr=None, done=None, error=str(e)))
    history = db.execute("SELECT * FROM imported_payruns ORDER BY id DESC LIMIT 50").fetchall()
    first = not db.execute("SELECT 1 FROM payroll_import_accounts").fetchone()
    books = db.execute("SELECT currency FROM company WHERE id=1").fetchone()["currency"] or "AUD"
    return render_template("links/payroll.html", files=files, history=history, inbox=inbox(),
                           default_bank=linked(db, "default_bank"), roles=ROLES, mapping=import_accounts(db),
                           first=first, books_currency=books, deductions_account=DEDUCTIONS_ACCOUNT, **lookups(db))


@guarded
def _do_import():
    db = get_db()
    bank = int(request.form["bank_account_id"])
    chosen = {role: opt_int(request.form.get(f"map_{role}")) for role, _l in ROLES}
    if not any(chosen.values()):
        chosen = None
    up = request.files.get("file")
    if up and up.filename:
        pr = parse_payrun(up.read().decode("utf-8-sig"))
        eid = import_payrun(db, pr, bank, safe_name(up.filename), chosen)
    else:
        name = request.form.get("name", "")
        path = inbox() / safe_name(name)
        if not name or not path.is_file():
            raise PostingError("That pay run file is no longer in the inbox.")
        pr = parse_payrun(path.read_text(encoding="utf-8"))
        eid = import_payrun(db, pr, bank, path.name, chosen)
        done = inbox() / "Imported"
        done.mkdir(exist_ok=True)
        try:
            shutil.move(str(path), str(done / path.name))
        except OSError:
            pass
    flash(f"Pay run {pr['payrun_id']} imported: {len(pr['employees'])} staff, gross {fmt_money(pr['totals']['gross'])}.",
          "ok")
    return redirect(url_for("core.entry", eid=eid))


# ------------------------------------------------------------ Riyeser POS (the till is its own app)
def pos_exe():
    """Where the Riyeser POS installer puts the app for this Windows user (None if it isn't installed)."""
    import os
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        return None
    exe = os.path.join(base, "Programs", "Riyeser POS", "Riyeser POS.exe")
    return exe if os.path.exists(exe) else None


def _local_desktop():
    from flask import current_app
    return bool(current_app.config.get("LOCAL_RESET")) and request.remote_addr in ("127.0.0.1", "::1")


@bp.route("/pos", methods=["GET", "POST"])
def pos_app():
    """The till moved to Riyeser POS. It uses this same company file, and its sales show here as paid invoices."""
    from ..edition import download_url, POS_PAGE
    db = get_db()
    exe = pos_exe() if _local_desktop() else None
    if request.method == "POST" and exe:
        import os
        import subprocess
        env = dict(os.environ)  # same company files (RIYESER_HOME / RIYESER_DB) as this app
        subprocess.Popen([exe], env=env, cwd=os.path.dirname(exe), close_fds=True,
                         creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
        flash("Opening Riyeser POS…", "ok")
        return redirect(url_for("links.pos_app"))
    sales = db.execute("SELECT COUNT(*) n, COALESCE(SUM(d.total),0) t FROM pos_sales p JOIN documents d"
                       " ON d.id=p.document_id WHERE p.voided=0 AND d.date=date('now','localtime')").fetchone()
    return render_template("links/pos.html", installed=bool(exe), download=download_url("pos"), page=POS_PAGE,
                           today=sales)
