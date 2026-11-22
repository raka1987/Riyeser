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


def import_payrun(db, pr, bank_account_id, file_name=None):
    ensure_table(db)
    if db.execute("SELECT 1 FROM imported_payruns WHERE source=? AND payrun_id=?",
                  (pr["source"], pr["payrun_id"])).fetchone():
        raise PostingError(f"Pay run {pr['payrun_id']} has already been imported.")
    t = pr["totals"]
    lines = [dict(account_id=linked(db, "wages"), debit=t["gross"], memo="Gross wages"),
             dict(account_id=linked(db, "super_expense"), debit=t["contrib"], memo="Employer contributions"),
             dict(account_id=linked(db, "payg_payable"), credit=t["tax"], memo="Tax withheld"),
             dict(account_id=linked(db, "super_payable"), credit=t["contrib"], memo="Employer contributions payable"),
             dict(account_id=bank_account_id, credit=t["net"], memo="Net wages paid")]
    if t["deductions"]:
        lines.append(dict(account_id=linked(db, "payg_payable"), credit=t["deductions"], memo="Other deductions"))
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
    return render_template("links/payroll.html", files=files, history=history, inbox=inbox(),
                           default_bank=linked(db, "default_bank"), **lookups(db))


@guarded
def _do_import():
    db = get_db()
    bank = int(request.form["bank_account_id"])
    up = request.files.get("file")
    if up and up.filename:
        pr = parse_payrun(up.read().decode("utf-8-sig"))
        eid = import_payrun(db, pr, bank, safe_name(up.filename))
    else:
        name = request.form.get("name", "")
        path = inbox() / safe_name(name)
        if not name or not path.is_file():
            raise PostingError("That pay run file is no longer in the inbox.")
        pr = parse_payrun(path.read_text(encoding="utf-8"))
        eid = import_payrun(db, pr, bank, path.name)
        done = inbox() / "Imported"
        done.mkdir(exist_ok=True)
        try:
            shutil.move(str(path), str(done / path.name))
        except OSError:
            pass
    flash(f"Pay run {pr['payrun_id']} imported: {len(pr['employees'])} staff, gross {fmt_money(pr['totals']['gross'])}.",
          "ok")
    return redirect(url_for("core.entry", eid=eid))
