"""Payroll: employees, pay runs, payslips."""
from datetime import date, timedelta

from flask import Blueprint, render_template, request, redirect, url_for, flash, abort

from ..db import get_db, to_cents, audit, linked, fmt_money
from ..ledger import post_entry, reverse_entry, PostingError
from ..payroll_calc import compute_pay, PERIODS
from . import lookups, opt_int, opt_float, guarded

bp = Blueprint("payroll", __name__, url_prefix="/payroll")


@bp.route("/")
def index():
    db = get_db()
    emps = db.execute("SELECT * FROM employees ORDER BY active DESC, last_name").fetchall()
    runs = db.execute("SELECT r.*, (SELECT SUM(gross) FROM payslips WHERE payrun_id=r.id) gross,"
                      " (SELECT SUM(net) FROM payslips WHERE payrun_id=r.id) net,"
                      " (SELECT COUNT(*) FROM payslips WHERE payrun_id=r.id) n,"
                      " e.voided FROM payruns r LEFT JOIN journal_entries e ON e.id=r.entry_id"
                      " ORDER BY r.pay_date DESC").fetchall()
    return render_template("payroll/index.html", emps=emps, runs=runs)


@bp.route("/employee/new", methods=["GET", "POST"])
@bp.route("/employee/<int:eid>", methods=["GET", "POST"])
def employee(eid=None):
    db = get_db()
    if request.method == "POST":
        return _save_employee(eid)
    e = db.execute("SELECT * FROM employees WHERE id=?", (eid,)).fetchone() if eid else None
    slips = db.execute("SELECT s.*, r.pay_date FROM payslips s JOIN payruns r ON r.id=s.payrun_id"
                       " WHERE s.employee_id=? ORDER BY r.pay_date DESC", (eid,)).fetchall() if eid else []
    return render_template("payroll/employee.html", e=e, slips=slips, **lookups(db))


@guarded
def _save_employee(eid):
    db = get_db()
    f = request.form
    if not f.get("first_name") or not f.get("last_name"):
        raise ValueError("First and last name are required.")
    vals = (f["first_name"].strip(), f["last_name"].strip(), f.get("email"), f.get("tfn"), f.get("start_date"),
            f.get("pay_basis", "hourly"), to_cents(f.get("hourly_rate")), to_cents(f.get("annual_salary")),
            opt_float(f.get("std_hours"), 38), f.get("pay_frequency", "weekly"),
            1 if f.get("tax_free_threshold") else 0, opt_float(f.get("super_rate"), 12.0), f.get("super_fund"),
            f.get("bank_bsb"), f.get("bank_account"), opt_int(f.get("job_id")), 1 if f.get("active") else 0)
    if f.get("pay_frequency") not in PERIODS:
        raise ValueError("Invalid pay frequency.")
    if eid:
        db.execute("UPDATE employees SET first_name=?, last_name=?, email=?, tfn=?, start_date=?, pay_basis=?,"
                   " hourly_rate=?, annual_salary=?, std_hours=?, pay_frequency=?, tax_free_threshold=?,"
                   " super_rate=?, super_fund=?, bank_bsb=?, bank_account=?, job_id=?, active=? WHERE id=?",
                   vals + (eid,))
    else:
        eid = db.execute("INSERT INTO employees (first_name, last_name, email, tfn, start_date, pay_basis,"
                         " hourly_rate, annual_salary, std_hours, pay_frequency, tax_free_threshold, super_rate,"
                         " super_fund, bank_bsb, bank_account, job_id, active) VALUES"
                         " (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", vals).lastrowid
    audit(db, "save_employee", f"{vals[0]} {vals[1]}")
    flash("Employee saved.", "ok")
    return redirect(url_for("payroll.employee", eid=eid))


@bp.route("/run", methods=["GET", "POST"])
def run():
    db = get_db()
    freq = request.values.get("frequency", "weekly")
    if freq not in PERIODS:
        abort(400)
    emps = db.execute("SELECT * FROM employees WHERE active=1 AND pay_frequency=? ORDER BY last_name",
                      (freq,)).fetchall()
    if request.method == "POST" and request.form.get("action") == "process":
        return _process(freq, emps)
    days = {"weekly": 7, "fortnightly": 14, "monthly": 30}[freq]
    end = request.values.get("period_end") or date.today().isoformat()
    start = request.values.get("period_start") or (date.fromisoformat(end) - timedelta(days=days - 1)).isoformat()
    pay_date = request.values.get("pay_date") or end
    previews = []
    for e in emps:
        hrs = request.form.get(f"hours_{e['id']}")
        hrs = opt_float(hrs, None) if hrs not in (None, "") else None
        p = compute_pay(e, freq, hrs)
        previews.append((e, p, request.method == "GET" or request.form.get(f"inc_{e['id']}")))
    return render_template("payroll/run.html", freq=freq, previews=previews, start=start, end=end,
                           pay_date=pay_date, frequencies=list(PERIODS), default_bank=linked(db, "default_bank"),
                           **lookups(db))


@guarded
def _process(freq, emps):
    db = get_db()
    f = request.form
    slips = []
    for e in emps:
        if not f.get(f"inc_{e['id']}"):
            continue
        hrs = f.get(f"hours_{e['id']}")
        p = compute_pay(e, freq, opt_float(hrs, None) if hrs not in (None, "") else None)
        slips.append((e, p))
    if not slips:
        raise PostingError("Select at least one employee.")
    bank = int(f["bank_account_id"])
    rid = db.execute("INSERT INTO payruns (pay_date, period_start, period_end, frequency, bank_account_id)"
                     " VALUES (?,?,?,?,?)", (f["pay_date"], f["period_start"], f["period_end"], freq, bank)).lastrowid
    wages, sup_exp = linked(db, "wages"), linked(db, "super_expense")
    payg, sup_pay = linked(db, "payg_payable"), linked(db, "super_payable")
    lines = []
    for e, p in slips:
        name = f"{e['first_name']} {e['last_name']}"
        lines += [dict(account_id=wages, debit=p["gross"], job_id=e["job_id"], memo=f"Gross wages {name}"),
                  dict(account_id=sup_exp, debit=p["super"], job_id=e["job_id"], memo=f"Super {name}"),
                  dict(account_id=payg, credit=p["tax"], memo=f"PAYG {name}"),
                  dict(account_id=sup_pay, credit=p["super"], memo=f"Super payable {name}"),
                  dict(account_id=bank, credit=p["net"], memo=f"Net pay {name}")]
        db.execute("INSERT INTO payslips (payrun_id, employee_id, hours, gross, tax, super, net, leave_accrued)"
                   " VALUES (?,?,?,?,?,?,?,?)",
                   (rid, e["id"], p["hours"], p["gross"], p["tax"], p["super"], p["net"], p["leave"]))
        db.execute("UPDATE employees SET leave_hours=leave_hours+? WHERE id=?", (p["leave"], e["id"]))
    eid = post_entry(db, f["pay_date"], f"Pay run {f['period_start']} to {f['period_end']}", "payrun", lines,
                     source_id=rid)
    db.execute("UPDATE payruns SET entry_id=? WHERE id=?", (eid, rid))
    total = sum(p["gross"] for _, p in slips)
    audit(db, "payrun", f"{len(slips)} employees, gross {fmt_money(total)}")
    flash(f"Pay run processed for {len(slips)} employees.", "ok")
    return redirect(url_for("payroll.payrun", rid=rid))


@bp.route("/payrun/<int:rid>")
def payrun(rid):
    db = get_db()
    r = db.execute("SELECT r.*, e.voided FROM payruns r LEFT JOIN journal_entries e ON e.id=r.entry_id"
                   " WHERE r.id=?", (rid,)).fetchone()
    slips = db.execute("SELECT s.*, e.first_name, e.last_name FROM payslips s JOIN employees e ON e.id=s.employee_id"
                       " WHERE s.payrun_id=? ORDER BY e.last_name", (rid,)).fetchall()
    return render_template("payroll/payrun.html", r=r, slips=slips)


@bp.route("/payslip/<int:sid>")
def payslip(sid):
    db = get_db()
    s = db.execute("SELECT s.*, e.*, s.id sid, r.pay_date, r.period_start, r.period_end FROM payslips s"
                   " JOIN employees e ON e.id=s.employee_id JOIN payruns r ON r.id=s.payrun_id WHERE s.id=?",
                   (sid,)).fetchone()
    ytd = db.execute("SELECT SUM(gross) g, SUM(tax) t, SUM(super) s, SUM(net) n FROM payslips p"
                     " JOIN payruns r ON r.id=p.payrun_id JOIN journal_entries je ON je.id=r.entry_id"
                     " WHERE p.employee_id=? AND r.pay_date<=? AND je.voided=0",
                     (s["employee_id"], s["pay_date"])).fetchone()
    if request.args.get("pdf"):
        from flask import Response
        from .. import pdf as pdfmod
        name = pdfmod.safe_name(f"{s['pay_date']} Payslip {s['first_name']} {s['last_name']}") + ".pdf"
        return Response(pdfmod.payslip_pdf(db, sid), mimetype="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})
    return render_template("payroll/payslip.html", s=s, ytd=ytd)


@bp.route("/payrun/<int:rid>/void", methods=["POST"])
@guarded
def void_run(rid):
    db = get_db()
    r = db.execute("SELECT * FROM payruns WHERE id=?", (rid,)).fetchone()
    reverse_entry(db, r["entry_id"])
    for s in db.execute("SELECT * FROM payslips WHERE payrun_id=?", (rid,)).fetchall():
        db.execute("UPDATE employees SET leave_hours=leave_hours-? WHERE id=?", (s["leave_accrued"], s["employee_id"]))
    audit(db, "void_payrun", str(rid))
    flash("Pay run reversed.", "ok")
    return redirect(url_for("payroll.payrun", rid=rid))
