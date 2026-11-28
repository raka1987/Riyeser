"""Companies: switch between companies, see them all at a glance, add, import and archive."""
import os
import tempfile
from datetime import date

from flask import Blueprint, render_template, request, redirect, url_for, session, flash, g, abort
from werkzeug.security import check_password_hash

from .. import companies as co
from .. import perms
from ..db import get_db, audit, close_db, PRICES
from ..ledger import fy_start

bp = Blueprint("companies", __name__, url_prefix="/companies")


def _access():
    acc = dict(session.get("access") or {})
    if session.get("uid") and co.current_id() not in acc:
        acc[co.current_id()] = session["uid"]
    return acc


def _is_admin_here():
    return bool(g.user) and g.user["role"] == "admin"


def _figures(path, user):
    """One company's key numbers, only those this person may see there."""
    lv = perms.levels_for(user)
    today = date.today().isoformat()
    with co.using(path):
        db = get_db()
        out = {"levels": lv}
        c = db.execute("SELECT lock_date FROM company WHERE id=1").fetchone()
        out["lock_date"] = c["lock_date"] if c else None
        if lv["banking"]:
            out["cash"] = db.execute("SELECT COALESCE(SUM(l.debit-l.credit),0) FROM journal_lines l JOIN accounts a"
                                     " ON a.id=l.account_id JOIN journal_entries e ON e.id=l.entry_id"
                                     " WHERE a.is_bank=1 AND e.date<=?", (today,)).fetchone()[0]
        if lv["sales"]:
            r = db.execute("SELECT COALESCE(SUM(total-amount_paid),0), COALESCE(SUM(CASE WHEN due_date<? THEN total-amount_paid END),0),"
                           " COUNT(*) FROM documents WHERE side='sale' AND status='open'", (today,)).fetchone()
            out["owed"], out["overdue"], out["owed_n"] = r[0], r[1], r[2]
        if lv["purchases"]:
            r = db.execute("SELECT COALESCE(SUM(total-amount_paid),0), COUNT(*) FROM documents"
                           " WHERE side='purchase' AND status='open'").fetchone()
            out["owe"], out["owe_n"] = r[0], r[1]
        if lv["accounts"]:
            start = fy_start(db, today)
            r = db.execute("SELECT COALESCE(SUM(CASE WHEN a.type IN ('income','other_income') THEN l.credit-l.debit"
                           " WHEN a.type IN ('cost_of_sales','expense','other_expense') THEN l.debit-l.credit END),0),"
                           " COALESCE(SUM(CASE WHEN a.type IN ('income','other_income') THEN l.credit-l.debit END),0)"
                           " FROM journal_lines l JOIN accounts a ON a.id=l.account_id JOIN journal_entries e ON e.id=l.entry_id"
                           " WHERE e.date BETWEEN ? AND ?", (start, today)).fetchone()
            out["income"] = r[1]
            out["profit"] = r[1] - (r[0] - r[1])
    return out


@bp.route("/")
def index():
    acc = _access()
    rows, totals = [], {"cash": 0, "owed": 0, "overdue": 0, "owe": 0, "profit": 0}
    shown = set()
    username = g.user["username"]
    for c in co.all_companies():
        if c["id"] in acc:
            u = co.user_row(c["path"], username)
            if not u:
                continue
            f = _figures(c["path"], u)
            for k in totals:
                if k in f:
                    totals[k] += f[k]
                    shown.add(k)
            rows.append({**c, "f": f, "open": True, "current": c["id"] == co.current_id()})
        elif co.user_row(c["path"], username):
            rows.append({**c, "f": None, "open": False, "current": False})  # same username: can sign in
    archived = []
    if _is_admin_here():
        for c in co.all_companies(include_archived=True):
            u = co.user_row(c["path"], username) if c["archived"] else None
            if u and u["role"] == "admin":
                archived.append(c)
    from .. import archive as ar
    copies = list(reversed(ar.entries(co.data_folder())))[:8] if _is_admin_here() else []
    return render_template("companies/index.html", rows=rows, totals=totals, shown=shown, archived=archived,
                           can_add=_is_admin_here(), allowance=co.allowance(), in_use=len(co.active_ids()),
                           room=co.can_add_another(), copies=copies,
                           here_name=(co._details(co.path_of(co.current_id())) or {}).get("name", ""))


@bp.route("/switch/<cid>", methods=["GET", "POST"])
def switch(cid):
    path = co.path_of(cid)
    if not path:
        abort(404)
    acc = _access()
    if cid not in acc:
        # A different password in that company: ask for it once.
        if request.method == "POST":
            u = co.user_row(path, g.user["username"])
            if u and check_password_hash(u["password_hash"], request.form.get("password", "")):
                acc[cid] = u["id"]
                from .auth import pw_mark
                session["pwv"] = {**(session.get("pwv") or {}), cid: pw_mark(u["password_hash"])}
            else:
                flash("That password isn't right for this company.", "error")
        if cid not in acc:
            name = (co._details(path) or {}).get("name", "this company")
            return render_template("companies/signin.html", cid=cid, name=name, username=g.user["username"])
    session["access"] = acc
    session["co"] = cid
    session["uid"] = acc[cid]
    with co.using(path):
        db = get_db()
        audit(db, "open_company", g.user["username"])
        db.commit()
    return redirect(url_for("core.dashboard"))


@bp.route("/add", methods=["POST"])
def add():
    if not _is_admin_here():
        abort(403)
    if not co.can_add_another():
        flash(f"Your plan includes {co.allowance()} compan{'y' if co.allowance() == 1 else 'ies'}. Extra companies are "
              f"{PRICES['extra_company']} a month each — add them in Riyeser Central (Licence), then come back here.", "error")
        return redirect(url_for("companies.index"))
    f = request.form
    try:
        cid = co.add_company(f.get("name"), f.get("abn"), f.get("edition") or None, owner=g.user,
                             demo=f.get("start") == "demo" or bool(f.get("demo")))
    except ValueError as e:
        flash(str(e), "error")
        return redirect(url_for("companies.index"))
    audit(get_db(), "add_company", f.get("name"))
    get_db().commit()
    u = co.user_row(co.path_of(cid), g.user["username"])
    acc = _access(); acc[cid] = u["id"]
    session["access"] = acc
    flash(f"{f.get('name')} added. You're its administrator, with the same sign-in.", "ok")
    return redirect(url_for("companies.switch", cid=cid))


@bp.route("/import", methods=["POST"])
def import_file():
    if not _is_admin_here():
        abort(403)
    if not co.can_add_another():
        flash(f"Your plan includes {co.allowance()} compan{'y' if co.allowance() == 1 else 'ies'}. Extra companies are "
              f"{PRICES['extra_company']} a month each — add them in Riyeser Central (Licence), then come back here.", "error")
        return redirect(url_for("companies.index"))
    up = request.files.get("file")
    if not up or not up.filename:
        flash("Choose a company file (.db) to bring in.", "error")
        return redirect(url_for("companies.index"))
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        up.save(tmp)
        cid, name = co.import_company(tmp)
    except ValueError as e:
        flash(str(e), "error")
        return redirect(url_for("companies.index"))
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    audit(get_db(), "import_company", name)
    get_db().commit()
    flash(f"{name} added. Sign in with a user from that company's file to open it.", "ok")
    return redirect(url_for("companies.index"))


@bp.route("/<cid>/archive", methods=["POST"])
def archive(cid):
    acc = _access()
    path = co.path_of(cid)
    if not path:
        abort(404)
    u = co.user_row(path, g.user["username"])
    if not u or u["role"] != "admin":
        flash("Only an administrator of that company can archive it.", "error")
        return redirect(url_for("companies.index"))
    restore = request.form.get("restore") == "1"
    try:
        co.set_archived(cid, not restore)
    except ValueError as e:
        flash(str(e), "error")
        return redirect(url_for("companies.index"))
    if not restore and co.current_id() == cid:
        other = next((c["id"] for c in co.all_companies() if c["id"] in acc), None)
        session["co"] = other or co.MAIN
        session["uid"] = acc.get(other)
    flash("Company restored." if restore else "Company archived. Its books are kept; restore it any time from Companies.", "ok")
    return redirect(url_for("companies.index"))


# ---------------------------------------------------------------- start again (administrators only)
def _confirmed(f):
    """The administrator's current password and the company's exact name. Returns an error message, or None."""
    if not check_password_hash(g.user["password_hash"], f.get("password") or ""):
        return "That password isn't right. Nothing has been changed."
    name = (co._details(co.path_of(co.current_id())) or {}).get("name", "")
    if (f.get("confirm_name") or "").strip() != name:
        return f"Type the company's name exactly as shown ({name}) to confirm. Nothing has been changed."
    return None


@bp.route("/start-again", methods=["POST"])
def start_again():
    if not _is_admin_here():
        abort(403)
    why = _confirmed(request.form)
    if why:
        flash(why, "error")
        return redirect(url_for("companies.index") + "#start-again")
    reason = (request.form.get("reason") or "").strip()[:500]
    username = g.user["username"]
    close_db()  # the company file is rewritten below: don't hold it open
    e = co.start_again(co.current_id(), username, reason)
    flash(f"Started again with a blank company. Your old records are saved as a locked archive copy "
          f"({e['file']}). Nothing was deleted.", "ok")
    return redirect(url_for("companies.index"))


@bp.route("/start-everything-again", methods=["POST"])
def start_everything():
    if not _is_admin_here():
        abort(403)
    username = g.user["username"]
    if not co.admin_everywhere(username):
        flash("Only someone who is an administrator in every company can start everything again. "
              "You can still start this company again on its own.", "error")
        return redirect(url_for("companies.index") + "#start-again")
    why = _confirmed(request.form)
    if why:
        flash(why, "error")
        return redirect(url_for("companies.index") + "#start-again")
    reason = (request.form.get("reason") or "").strip()[:500]
    acc = _access()
    close_db()
    done = co.start_everything_again(username, reason)
    u = co.user_row(co.path_of(co.MAIN), username)
    if u and co.MAIN in acc:
        session["access"] = {co.MAIN: acc[co.MAIN]}
        session["co"] = co.MAIN
        session["uid"] = acc[co.MAIN]
    else:
        session.clear()
        flash("Everything has started again. Sign in to the main company.", "ok")
        return redirect(url_for("auth.login"))
    flash(f"Everything has started again. {len(done)} compan{'y was' if len(done) == 1 else 'ies were'} saved as locked "
          "archive copies first, and the other companies are archived (hidden). Nothing was deleted.", "ok")
    return redirect(url_for("companies.index"))


@bp.route("/archives")
def check_archives():
    if not _is_admin_here():
        abort(403)
    from .. import archive as ar
    result = ar.check(co.data_folder(), co.path_of(co.MAIN))
    return render_template("companies/archives.html", result=result, ar=ar)
