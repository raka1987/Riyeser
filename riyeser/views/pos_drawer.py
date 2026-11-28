"""Cash drawer: setup (per till), opening it on cash sales and cash refunds, "No sale", and ESC/POS receipts.

The drawer opens from the server (this PC): a raw print job with the pulse command goes to the till's receipt
printer (riyeser/drawer.py). A sale sent twice (double tap) opens it once: it only opens when the sale is new.
"""
from flask import render_template, request, redirect, url_for, flash, jsonify, g

from ..db import get_db, audit
from ..ledger import PostingError
from .. import perms
from .. import drawer as D
from . import opt_int
from .pos import bp, _tills, use_approval, self_approves, self_approval, REASONS, METHOD_LABELS, _sale

MODES = {"none": "None (open it with the key)", "printer": "Through the receipt printer"}
REASONS["nosale"] = ["Give change", "Swap notes for coins", "Check the float", "Put in a cash payment", "Other"]


def till_row(db, till_id):
    return db.execute("SELECT * FROM pos_tills WHERE id=? AND active=1", (till_id,)).fetchone() if till_id else None


def open_drawer(db, till_id, kind, ref=None, reason=None, approval_id=None, force=False):
    """Send the pulse to the till's printer and record it. Never raises: returns {opened, error}.
    Called after the sale (refund, no sale) is saved, so a printer problem never loses a sale."""
    t = till_row(db, till_id)
    if not t or (t["drawer_mode"] != "printer" and not force) or (not force and not drawer_opens_on(t, kind)):
        return dict(opened=False, error=None, mode="none")
    err = None
    try:
        D.backend().send(t["drawer_printer"], D.PULSE, job=f"Riyeser POS drawer ({kind})")
    except D.DrawerError as e:
        err = str(e)
    except Exception as e:  # a printer driver can fail in odd ways: the sale is already safe
        err = f"The drawer didn't open: {e}"
    db.execute("INSERT INTO pos_drawer_events (till_id, kind, ref, reason, user_id, approval_id, ok, error)"
               " VALUES (?,?,?,?,?,?,?,?)", (t["id"], kind, str(ref or ""), reason, g.user["id"] if g.user else None,
                                             approval_id, 0 if err else 1, err))
    db.commit()
    return dict(opened=not err, error=err, mode="printer")


def drawer_opened_for(db, kind, ref):
    return bool(db.execute("SELECT 1 FROM pos_drawer_events WHERE kind=? AND ref=? AND ok=1", (kind, str(ref))).fetchone())


@bp.route("/drawer", methods=["GET", "POST"])
def drawer_setup():
    """2.11.0's Cash drawer page: saving still works (older links and scripts); opening it goes to Hardware."""
    db = get_db()
    can_change = perms.can("setup", perms.FULL)
    if request.method == "POST":
        if not can_change:
            flash("Only an owner or administrator can change the cash drawer settings.", "error")
            return redirect(url_for("pos.drawer_setup"))
        f = request.form
        for t in _tills(db):
            mode = f.get(f"mode_{t['id']}") if f.get(f"mode_{t['id']}") in MODES else "none"
            printer = (f.get(f"printer_{t['id']}") or "").strip()[:200] or None
            if mode == "printer" and not printer:
                flash(f"Choose the receipt printer for {t['name']}, or set its drawer to None.", "error")
                return redirect(url_for("pos.drawer_setup"))
            raw = 1 if f.get(f"raw_{t['id']}") and mode == "printer" else 0
            db.execute("UPDATE pos_tills SET drawer_mode=?, drawer_printer=?, raw_receipts=?, receipt_printer=? WHERE id=?",
                       (mode, printer, raw, printer if raw else None, t["id"]))
            audit(db, "pos_drawer_setup", f"{t['name']}: {mode} {printer or ''}")
        db.commit()
        flash("Cash drawer settings saved.", "ok")
        return redirect(url_for("pos.hardware") + "#drawer")
    # 2.11.1: the cash drawer is on POS setup › Hardware now, with the printers and the scanner
    return redirect(url_for("pos.hardware", till=opt_int(request.args.get("till"))) + "#drawer")


@bp.route("/drawer/test", methods=["POST"])
def drawer_test():
    db = get_db()
    if not perms.can("setup", perms.FULL):
        return jsonify(ok=False, error="Only an owner or administrator can test the drawer."), 403
    d = request.get_json(silent=True) or request.form
    t = till_row(db, opt_int(d.get("till_id")))
    if not t:
        return jsonify(ok=False, error="Choose a till."), 400
    printer = (d.get("printer") or t["drawer_printer"] or "").strip()
    if not printer:
        return jsonify(ok=False, error="Choose the receipt printer first."), 400
    err = None
    try:
        D.backend().send(printer, D.PULSE, job="Riyeser POS drawer test")
    except D.DrawerError as e:
        err = str(e)
    db.execute("INSERT INTO pos_drawer_events (till_id, kind, ref, user_id, ok, error) VALUES (?,?,?,?,?,?)",
               (t["id"], "test", printer, g.user["id"], 0 if err else 1, err))
    audit(db, "pos_drawer_test", f"{t['name']} {printer}: {'ok' if not err else err}")
    db.commit()
    if err:
        return jsonify(ok=False, error=err), 400
    return jsonify(ok=True)


@bp.route("/drawer/open", methods=["POST"])
def no_sale():
    """"No sale": open the drawer without a sale. Needs a reason; staff need a manager's approval. Audited."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    try:
        t = till_row(db, opt_int(d.get("till_id")))
        if not t:
            raise PostingError("Choose a till.")
        if t["drawer_mode"] != "printer":
            raise PostingError("This till's drawer isn't set to open from Riyeser. Open it with the key.")
        if not drawer_opens_on(t, "no_sale"):
            raise PostingError("No sale is turned off for this till (POS setup › Hardware › Cash drawer).")
        reason = str(d.get("reason") or "").strip()[:120]
        if self_approves():
            if not reason:
                raise PostingError("Choose a reason.")
            aid = self_approval(db, "nosale", t["id"], 0, reason)
        else:
            a = use_approval(db, d.get("approval_id"), "nosale", ref=t["id"])
            aid, reason = a["id"], a["reason"]
        audit(db, "pos_no_sale", f"{t['name']}: {reason}")
        db.commit()
    except PostingError as e:
        db.rollback()
        return jsonify(ok=False, error=str(e)), 400
    res = open_drawer(db, t["id"], "no_sale", ref=aid, reason=reason, approval_id=aid)
    if res["error"]:
        return jsonify(ok=False, error=res["error"], recorded=True), 502
    return jsonify(ok=True)


# ------------------------------------------------------------ ESC/POS receipts (when the till's printer takes them)
def receipt_printer_of(t):
    """The till's receipt printer (Hardware page), or 2.11.0's "print receipts straight to the drawer's printer"."""
    if not t:
        return None
    return t["receipt_printer"] or (t["drawer_printer"] if t["raw_receipts"] else None)


def send_receipt(db, t, printer, data, kick=False, copies=1):
    from .. import pos_print as PP
    rs = PP.receipt_settings(db)
    logo = PP.brand_logo(db)[0] if rs["logo"] else None
    D.backend().send(printer, PP.receipt_job(data, PP.layout_of(t), logo=logo, copies=copies, kick=kick),
                     job=f"Riyeser POS receipt {data['number']}")


def drawer_opens_on(t, kind):
    """The Hardware page's "open the drawer on": cash sales, cash refunds and No sale (all on unless turned off)."""
    from .. import pos_print as PP
    key = {"sale": "cash_sale", "part": "cash_sale", "refund": "cash_refund", "no_sale": "no_sale"}.get(kind)
    return PP.drawer_on(t).get(key, True) if key else True


def receipt_data(db, sid, part=None):
    s = _sale(db, sid)
    co = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    lines = db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (s["document_id"],)).fetchall()
    q = "SELECT * FROM pos_tenders WHERE sale_id=?" + (" AND part_id=?" if part else "") + " ORDER BY id"
    tenders = db.execute(q, (sid, part) if part else (sid,)).fetchall()
    from ..countries import labels
    tl = labels(co)
    tax_name = tl["tax"] if tl["has_tax"] else None
    label = None
    total = s["total"]
    if part:
        p = db.execute("SELECT * FROM pos_bill_parts WHERE id=?", (part,)).fetchone()
        n = db.execute("SELECT COUNT(*) FROM pos_bill_parts WHERE bill_id=?", (p["bill_id"],)).fetchone()[0]
        label, total = f"Split bill: {p['label'] or 'part ' + str(p['n'])} ({p['n']} of {n})", p["amount"]
    from .. import pos_print as PP
    rs = PP.receipt_settings(db)
    head = PP.header_lines(co, rs, tl)
    return dict(company=(co["name"] or "") if rs["show_name"] else "", header=head,
                number=s["number"], date=s["date"], label=label,
                lines=[(l["qty"], l["description"], l["net_amount"] + l["tax_amount"]) for l in lines],
                total=total, tax=0 if part or not tax_name else s["tax_total"], tax_name=tax_name,
                tenders=[(METHOD_LABELS.get(t["method"], t["method"]), t["amount"]) for t in tenders],
                change=sum(t["change_given"] for t in tenders),
                footer=PP.footer_lines(rs) + [f"Served by {s['full_name'] or s['username']}"]), \
        any(t["method"] == "cash" for t in tenders)


@bp.route("/receipt/<int:sid>/raw", methods=["POST"])
def receipt_raw(sid):
    """Print the receipt as ESC/POS on the till's printer. The drawer pulse goes first when this cash sale's drawer
    hasn't opened yet (it opens once per cash sale). On any problem the till falls back to normal printing."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    t = till_row(db, opt_int(d.get("till_id")))
    printer = receipt_printer_of(t)
    if not printer:
        return jsonify(ok=False, fallback=True, error="This till prints receipts through the Windows print box."), 400
    part = opt_int(d.get("part_id"))
    data, cash = receipt_data(db, sid, part)
    ref = f"part {part}" if part else sid
    kind = "part" if part else "sale"
    kick = cash and t["drawer_mode"] == "printer" and drawer_opens_on(t, "sale") \
        and not drawer_opened_for(db, kind, ref)
    try:
        send_receipt(db, t, printer, data, kick=kick, copies=t["receipt_copies"] if d.get("auto") else 1)
    except D.DrawerError as e:
        return jsonify(ok=False, fallback=True, error=f"{e} Printing with the Windows print box instead."), 502
    if kick:
        db.execute("INSERT INTO pos_drawer_events (till_id, kind, ref, user_id, ok) VALUES (?,?,?,?,1)",
                   (t["id"], kind, str(ref), g.user["id"]))
        db.commit()
    return jsonify(ok=True, kicked=bool(kick))
