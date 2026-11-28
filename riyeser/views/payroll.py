"""Payroll: employees, pay runs, payslips."""
from datetime import date, timedelta

from flask import Blueprint, render_template, request, redirect, url_for, flash, abort

from ..db import get_db, to_cents, audit, linked, fmt_money, write_txn
from ..ledger import post_entry, reverse_entry, PostingError
from ..payroll_calc import compute_pay, PERIODS
from . import lookups, opt_int, opt_float, guarded, once

bp = Blueprint("payroll", __name__, url_prefix="/payroll")


@bp.route("/")
def index():
    db = get_db()
    from ..listing import ListSpec, Col, Choice, from_request
    el = from_request(ListSpec("payroll:employees", [
        Col("name", "Name", sql="last_name || ' ' || first_name"), Col("pay_basis", "Basis"),
        Col("pay_frequency", "Frequency"), Col("rate", "Rate", "num"), Col("super_rate", "Super %", "num"),
        Col("leave_hours", "Leave hrs", "num")],
        sort="name", prefix="e_", per_page=None, lead="active DESC", tiebreak="id",
        search=("first_name", "last_name", "email"), search_hint="Name or email", noun="employees", choices=[
            Choice("st", "Status", [("active", "Active"), ("inactive", "Inactive")],
                   where={"active": (" AND active=1", []), "inactive": (" AND active=0", [])}),
            Choice("basis", "Basis", [("hourly", "Hourly"), ("salary", "Salary")], col="pay_basis"),
            Choice("freq", "Frequency", [("weekly", "Weekly"), ("fortnightly", "Fortnightly"), ("monthly", "Monthly")],
                   col="pay_frequency")]))
    emps = el.fetch(db, "SELECT *, CASE pay_basis WHEN 'salary' THEN annual_salary ELSE hourly_rate END rate"
                        " FROM employees")
    rl = from_request(ListSpec("payroll:runs", [
        Col("pay_date", "Pay date", "date"), Col("period_start", "Period", "date"), Col("frequency", "Frequency"),
        Col("n", "Employees", "num"), Col("gross", "Gross", "num"), Col("net", "Net", "num")],
        sort="pay_date", dir="desc", prefix="r_", date_col="pay_date", date_label="Pay date", noun="pay runs",
        choices=[Choice("freq", "Frequency", [("weekly", "Weekly"), ("fortnightly", "Fortnightly"),
                                              ("monthly", "Monthly")], col="frequency"),
                 Choice("st", "Status", [("posted", "Not reversed"), ("reversed", "Reversed")],
                        where={"posted": (" AND COALESCE(voided,0)=0", []), "reversed": (" AND voided=1", [])})]))
    runs = rl.fetch(db, "SELECT r.*, (SELECT SUM(gross) FROM payslips WHERE payrun_id=r.id) gross,"
                        " (SELECT SUM(net) FROM payslips WHERE payrun_id=r.id) net,"
                        " (SELECT COUNT(*) FROM payslips WHERE payrun_id=r.id) n,"
                        " e.voided FROM payruns r LEFT JOIN journal_entries e ON e.id=r.entry_id",
                    sums=("CASE WHEN COALESCE(voided,0)=0 THEN gross ELSE 0 END",
                          "CASE WHEN COALESCE(voided,0)=0 THEN net ELSE 0 END"))
    return render_template("payroll/index.html", emps=emps, runs=runs, el=el, rl=rl,
                           run_gross=rl.sums["CASE WHEN COALESCE(voided,0)=0 THEN gross ELSE 0 END"],
                           run_net=rl.sums["CASE WHEN COALESCE(voided,0)=0 THEN net ELSE 0 END"])


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


# S22: hours a person can work in one pay period (more is a typing mistake)
MAX_HOURS = {"weekly": 60, "fortnightly": 120, "monthly": 260}
DAYS = {"weekly": 7, "fortnightly": 14, "monthly": 30}


def parse_hours(e, freq, raw, confirmed=False):
    """Hours typed for one person: None (their standard hours), or a number from 0 to the period's maximum.
    Above their normal hours needs the "hours checked" tick."""
    if raw in (None, "") or not str(raw).strip():
        return None
    name = f"{e['first_name']} {e['last_name']}"
    try:
        h = float(str(raw).replace(",", "").strip())
    except ValueError:
        raise PostingError(f"{name}: hours must be a number (you typed \"{raw}\").")
    if h < 0:
        raise PostingError(f"{name}: hours can't be below 0.")
    if h > MAX_HOURS[freq]:
        raise PostingError(f"{name}: {h:g} hours is more than anyone can work in a {freq[:-2] if freq != 'monthly' else 'month'}"
                           f" period (up to {MAX_HOURS[freq]}). Check the hours.")
    normal = e["std_hours"] or 0
    if normal and h > normal * 1.25 and not confirmed:
        raise PostingError(f"{name}: {h:g} hours is more than their normal {normal:g}. Tick \"Hours checked\" if "
                           f"that's right.")
    return h


def _default_frequency(db):
    """S23: the last pay run's frequency, else the one most active staff are paid on."""
    last = db.execute("SELECT frequency FROM payruns ORDER BY pay_date DESC, id DESC LIMIT 1").fetchone()
    if last and db.execute("SELECT 1 FROM employees WHERE active=1 AND pay_frequency=?", (last[0],)).fetchone():
        return last[0]
    row = db.execute("SELECT pay_frequency, COUNT(*) n FROM employees WHERE active=1 GROUP BY pay_frequency"
                     " ORDER BY n DESC LIMIT 1").fetchone()
    return row[0] if row else "weekly"


def _next_period(db, freq):
    """The period after the last one paid on this frequency, else the one ending today."""
    last = db.execute("SELECT r.period_end FROM payruns r JOIN journal_entries je ON je.id=r.entry_id"
                      " WHERE r.frequency=? AND je.voided=0 AND COALESCE(r.kind,'regular')='regular'"
                      " ORDER BY r.period_end DESC LIMIT 1", (freq,)).fetchone()
    if last:
        start = date.fromisoformat(last[0]) + timedelta(days=1)
        if freq == "monthly":
            nxt = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
            end = nxt - timedelta(days=1) if start.day == 1 else start + timedelta(days=29)
        else:
            end = start + timedelta(days=DAYS[freq] - 1)
        return start.isoformat(), end.isoformat()
    end = date.today()
    return (end - timedelta(days=DAYS[freq] - 1)).isoformat(), end.isoformat()


@bp.route("/run", methods=["GET", "POST"])
def run():
    db = get_db()
    freq = request.values.get("frequency") or _default_frequency(db)
    if freq not in PERIODS:
        abort(400)
    emps = db.execute("SELECT * FROM employees WHERE active=1 AND pay_frequency=? ORDER BY last_name",
                      (freq,)).fetchall()
    if request.method == "POST" and request.form.get("action") == "process":
        return _process(freq, emps)
    nstart, nend = _next_period(db, freq)
    end = request.values.get("period_end") or nend
    start = request.values.get("period_start") or nstart
    pay_date = request.values.get("pay_date") or end
    previews = []
    for e in emps:
        try:
            hrs = parse_hours(e, freq, request.form.get(f"hours_{e['id']}"), True)
        except PostingError as err:
            flash(str(err), "error")
            hrs = None
        p = compute_pay(e, freq, hrs)
        previews.append((e, p, request.method == "GET" or request.form.get(f"inc_{e['id']}")))
    return render_template("payroll/run.html", freq=freq, previews=previews, start=start, end=end,
                           pay_date=pay_date, frequencies=list(PERIODS), default_bank=linked(db, "default_bank"),
                           **lookups(db))


@guarded
@once
def _process(freq, emps):
    db = get_db()
    write_txn(db)  # checking who's already paid and paying them happen in one go (F15)
    f = request.form
    slips = []
    for e in emps:
        if not f.get(f"inc_{e['id']}"):
            continue
        hrs = parse_hours(e, freq, f.get(f"hours_{e['id']}"), bool(f.get("hours_checked")))
        p = compute_pay(e, freq, hrs)
        slips.append((e, p))
    if not slips:
        raise PostingError("Select at least one employee.")
    start, end = f.get("period_start") or "", f.get("period_end") or ""
    if not start or not end or start > end:
        raise PostingError("Choose a pay period (the start on or before the end).")
    extra = bool(f.get("extra_run"))
    if not extra:
        _refuse_paid_twice(db, [e for e, _p in slips], start, end)
    bank = int(f["bank_account_id"])
    rid = db.execute("INSERT INTO payruns (pay_date, period_start, period_end, frequency, bank_account_id, kind)"
                     " VALUES (?,?,?,?,?,?)", (f["pay_date"], start, end, freq, bank,
                                               "extra" if extra else "regular")).lastrowid
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
    memo = f"{'Extra pay run (bonus)' if extra else 'Pay run'} {start} to {end}"
    eid = post_entry(db, f["pay_date"], memo, "payrun", lines, source_id=rid)
    db.execute("UPDATE payruns SET entry_id=? WHERE id=?", (eid, rid))
    total = sum(p["gross"] for _, p in slips)
    audit(db, "payrun", f"{len(slips)} employees, gross {fmt_money(total)}")
    flash(f"Pay run processed for {len(slips)} employees.", "ok")
    return redirect(url_for("payroll.payrun", rid=rid))


def _refuse_paid_twice(db, emps, start, end):
    """The same dates can't be paid twice (F11): a pay run (not reversed) that overlaps them for anyone included
    stops this one. A deliberate extra run (a bonus) goes through the labelled "Extra run" option instead."""
    for e in emps:
        r = db.execute("SELECT r.id, r.pay_date, r.period_start, r.period_end FROM payslips s"
                       " JOIN payruns r ON r.id=s.payrun_id JOIN journal_entries je ON je.id=r.entry_id"
                       " WHERE s.employee_id=? AND je.voided=0 AND COALESCE(r.kind,'regular')='regular'"
                       " AND r.period_start<=? AND r.period_end>=? ORDER BY r.pay_date LIMIT 1",
                       (e["id"], end, start)).fetchone()
        if r:
            raise PostingError(
                f"{e['first_name']} {e['last_name']}: these dates were already paid on {r['pay_date']} (pay run "
                f"#{r['id']}, {r['period_start']} to {r['period_end']}). Void that run first, or tick "
                f"\"Extra run (bonus)\" to pay extra on purpose.")


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
