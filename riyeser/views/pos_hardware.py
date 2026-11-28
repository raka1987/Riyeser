"""POS setup › Hardware (2.11.1): one page for each till's devices, with a status and a Test button on every card.

  * Receipt printer: a Windows printer (ESC/POS, printed silently) or "Ask each time" (the Windows print box), print
    after a sale (always / ask / never), copies; what the receipt says, with a live preview.
  * Adjust print layout: per printer (each till's receipt printer, each kitchen station's printer): paper width,
    characters per line, margins, scale, font size, logo width, feed lines and the cut, an alignment test slip.
  * Kitchen and bar printers: each kitchen station's dockets to its own printer.
  * Cash drawer (moved here from its own 2.11.0 page): through the receipt printer, and when it opens.
  * Barcode scanner: a "Scan something now" test, prefix / suffix to strip, scans always go to the sale, beep, and
    what happens with a barcode nobody knows.
  * Card machine and kitchen screens: their status, linking to their own set-up pages.
  * Customer-facing display: planned (not built).
A new till walks through the same cards in order (/pos/hardware/start); each step can be skipped.
"""
import json
from datetime import datetime

from flask import render_template, request, redirect, url_for, flash, jsonify, g, abort

from ..db import get_db, audit
from ..ledger import PostingError
from .. import perms
from .. import drawer as D
from .. import pos_print as PP
from . import guarded, once, opt_int
from .pos import bp, _tills, pos_config, METHOD_LABELS

STEPS = [("receipt", "Receipt printer"), ("layout", "What the receipt says"), ("adjust", "Print layout"),
         ("drawer", "Cash drawer"), ("scanner", "Barcode scanner"), ("card", "Card machine"),
         ("kitchen", "Kitchen and bar printers")]


def _printers():
    be = D.backend()
    try:
        return (be.printers() if be.available() else []), be.available()
    except Exception:
        return [], be.available()


def receipt_ctx(db, till_id=None, rs=None, lay=None, preview=False):
    """What pos/receipt.html needs: the business details, the till's print layout (lc), the logo and the footer."""
    from ..countries import labels
    co = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    rs = rs or PP.receipt_settings(db)
    t = db.execute("SELECT * FROM pos_tills WHERE id=?", (till_id,)).fetchone() if till_id else None
    lay = lay or PP.layout_of(t)
    logo, logo_url = PP.brand_logo(db)
    return dict(rs=rs, lc=PP.css_vars(lay), header=PP.header_lines(co, rs, labels(co)),
                footer=PP.footer_lines(rs), show_logo=bool(rs["logo"] and logo_url), preview=preview,
                logo_url=logo_url)


def _target(db, key):
    """'till:3' or 'station:2' -> (kind, row) for "Adjust print layout"."""
    kind, _, n = (key or "").partition(":")
    if kind == "station":
        r = db.execute("SELECT * FROM pos_stations WHERE id=?", (opt_int(n),)).fetchone()
    else:
        kind, r = "till", db.execute("SELECT * FROM pos_tills WHERE id=? AND active=1", (opt_int(n),)).fetchone()
    return kind, r


def devices(db, t, mode, printers, available):
    """The checklist for one till: [{key, name, state ('ok', 'none', 'problem', 'info', 'planned'), text}]."""
    from ..terminals import store as T, PROVIDERS
    out = []
    st, txt = PP.printer_status(t["receipt_printer"], printers, available)
    out.append(dict(key="receipt", name="Receipt printer", state={"ok": "ok", "none": "none"}.get(st, "problem"),
                    text=txt if st != "none" else "Not set up: receipts use the Windows print box"))
    if t["drawer_mode"] != "printer":
        out.append(dict(key="drawer", name="Cash drawer", state="none", text="Not set up: open it with the key"))
    else:
        st, txt = PP.printer_status(t["drawer_printer"], printers, available)
        last = db.execute("SELECT ok, error FROM pos_drawer_events WHERE till_id=? ORDER BY id DESC LIMIT 1",
                          (t["id"],)).fetchone()
        if st == "ok" and last and not last["ok"]:
            st, txt = "missing", f"Problem: {last['error'] or 'the last try did not open it'}"
        out.append(dict(key="drawer", name="Cash drawer", state="ok" if st == "ok" else "problem", text=txt))
    sc = PP.scanner_settings(db)
    if sc["tested_at"]:
        out.append(dict(key="scanner", name="Barcode scanner",
                        state="ok" if sc["enter"] is not False else "problem",
                        text=f"Set up · tested {sc['tested_at'][:10]}" if sc["enter"] is not False else
                        "Problem: the scanner doesn't press Enter after a code"))
    else:
        out.append(dict(key="scanner", name="Barcode scanner", state="none", text="Not tested yet"))
    key = T.provider_for(db, t["id"])
    out.append(dict(key="card", name="Card machine", state="none" if key == "none" else "ok",
                    text="Not set up: card payments are keyed in by hand" if key == "none" else
                    f"Set up · {PROVIDERS[key].name if key in PROVIDERS else key}"))
    if mode == "restaurant":
        from .pos_kitchen import stations
        st_rows = [s for s in stations(db) if s["output"] in ("print", "both")]
        missing = [s["name"] for s in st_rows if s["printer"] and PP.printer_status(s["printer"], printers,
                                                                                     available)[0] == "missing"]
        unset = [s["name"] for s in st_rows if not s["printer"]]
        out.append(dict(key="kitchen", name="Kitchen and bar printers",
                        state="problem" if missing else "none" if unset else "ok" if st_rows else "info",
                        text=f"Problem: {', '.join(missing)} printer not found" if missing else
                        f"Not set up: {', '.join(unset)} use the Windows print box" if unset else
                        "Set up" if st_rows else "No station prints dockets"))
        n = db.execute("SELECT COUNT(*) FROM kds_devices WHERE revoked_at IS NULL").fetchone()[0]
        out.append(dict(key="kds", name="Kitchen screens", state="ok" if n else "none",
                        text=f"{n} screen{'' if n == 1 else 's'} paired" if n else "None paired"))
    out.append(dict(key="display", name="Customer display", state="planned", text="Planned"))
    return out


def _ctx(db, till_id, wizard=None):
    tills = _tills(db)
    t = next((x for x in tills if x["id"] == till_id), tills[0] if tills else None)
    if t is None:
        abort(404)
    mode, _ = pos_config(db)
    printers, available = _printers()
    from .pos_kitchen import stations
    from ..terminals import store as T, PROVIDERS
    from ..countries import labels
    co = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    events = db.execute("SELECT e.*, COALESCE(u.full_name, u.username) who FROM pos_drawer_events e LEFT JOIN users u"
                        " ON u.id=e.user_id WHERE e.till_id=? ORDER BY e.id DESC LIMIT 5", (t["id"],)).fetchall()
    key = T.provider_for(db, t["id"])
    steps = [s for s in STEPS if s[0] != "kitchen" or mode == "restaurant"]
    sts = stations(db, False)
    targets = [(f"till:{t['id']}", f"{t['name']} receipt printer")] + \
        ([(f"station:{s['id']}", f"{s['name']} docket printer") for s in sts if s["output"] in ("print", "both")]
         if mode == "restaurant" else [])
    adj = request.args.get("adj") if request.args.get("adj") in dict(targets) else targets[0][0]
    _kind, adj_row = _target(db, adj)
    return dict(tills=tills, t=t, mode=mode, printers=printers, raw_ok=available, stations=sts,
                rs=PP.receipt_settings(db), sc=PP.scanner_settings(db), don=PP.drawer_on(t),
                print_after=PP.PRINT_AFTER, has_logo=bool(PP.brand_logo(db)[0]), tl_tax_id=labels(co)["tax_id"],
                devices=devices(db, t, mode, printers, available), events=events, lay_t=PP.layout_of(t),
                card_name=PROVIDERS[key].name if key in PROVIDERS else None,
                kds_count=db.execute("SELECT COUNT(*) FROM kds_devices WHERE revoked_at IS NULL").fetchone()[0],
                can_change=perms.can("setup", perms.FULL), wizard=wizard, steps=steps,
                targets=targets, adj=adj, adj_lay=PP.layout_of(adj_row), fonts=PP.FONTS,
                station_lay={s["id"]: PP.layout_of(s) for s in sts})


@bp.route("/hardware")
def hardware():
    db = get_db()
    return render_template("pos/hardware.html", **_ctx(db, opt_int(request.args.get("till"))))


@bp.route("/hardware/start")
def hardware_start():
    """The first-time walkthrough for a till: the cards one at a time, in order. Every step can be skipped."""
    db = get_db()
    ctx = _ctx(db, opt_int(request.args.get("till")))
    keys = [k for k, _ in ctx["steps"]]
    step = request.args.get("step") if request.args.get("step") in keys + ["done"] else keys[0]
    if step == "done" and ctx["can_change"] and not ctx["t"]["hw_setup_at"]:
        db.execute("UPDATE pos_tills SET hw_setup_at=datetime('now','localtime') WHERE id=?", (ctx["t"]["id"],))
        audit(db, "pos_hardware_walkthrough", ctx["t"]["name"])
        db.commit()
    nxt = keys[keys.index(step) + 1] if step in keys and keys.index(step) + 1 < len(keys) else "done"
    ctx.update(wizard=step, next_url=url_for("pos.hardware_start", till=ctx["t"]["id"], step=nxt),
               step_no=keys.index(step) + 1 if step in keys else len(keys) + 1)
    return render_template("pos/hardware.html", **ctx)


@bp.route("/hardware/save", methods=["POST"])
@guarded
@once
def hardware_save():
    db = get_db()
    f = request.form
    if not perms.can("setup", perms.FULL):
        raise PostingError("Only an owner or administrator can change the till's hardware.")
    t = db.execute("SELECT * FROM pos_tills WHERE id=? AND active=1", (opt_int(f.get("till_id")),)).fetchone()
    what = f.get("what")
    if what in ("receipt", "drawer") and not t:
        raise PostingError("Choose a till.")
    if what == "receipt":
        printer = (f.get("receipt_printer") or "").strip()[:200] or None
        after = f.get("print_after") if f.get("print_after") in PP.PRINT_AFTER else "ask"
        copies = 2 if f.get("copies") == "2" else 1
        db.execute("UPDATE pos_tills SET receipt_printer=?, print_after=?, receipt_copies=?, raw_receipts=?"
                   " WHERE id=?", (printer, after, copies, 1 if printer else 0, t["id"]))
        audit(db, "pos_hw_receipt", f"{t['name']}: {printer or 'Windows print box'}, {after}, x{copies}")
        msg = f"Receipt printer saved for {t['name']}."
    elif what == "layout":
        rs = PP.receipt_settings(db)
        rs.update(logo=bool(f.get("logo")), show_name=bool(f.get("show_name")), show_address=bool(f.get("show_address")),
                  show_tax_id=bool(f.get("show_tax_id")), show_phone=bool(f.get("show_phone")),
                  footer=(f.get("footer") or "").replace("\r", "")[:300])
        db.execute("UPDATE company SET pos_receipt_settings=? WHERE id=1", (json.dumps(rs),))
        audit(db, "pos_hw_layout", "receipt layout")
        msg = "Receipt layout saved."
    elif what in ("adjust", "adjust_reset"):
        kind, row = _target(db, f.get("target"))
        if row is None:
            raise PostingError("Choose the printer to adjust.")
        lay = PP.clean_layout({} if what == "adjust_reset" else {**f.to_dict(), "cut": f.get("cut") or "0"})
        mm = PP.computed(lay)["mm"]
        table = "pos_stations" if kind == "station" else "pos_tills"
        db.execute(f"UPDATE {table} SET print_layout=?, paper_mm=? WHERE id=?",
                   (json.dumps(lay), mm if mm in (58, 80) else 80, row["id"]))
        audit(db, "pos_hw_layout_adjust", f"{kind} {row['name']}: {json.dumps(lay)}")
        flash(f"Print layout for {row['name']} is back to the usual settings." if what == "adjust_reset" else
              f"Print layout saved for {row['name']}.", "ok")
        nxt = f.get("next") or ""
        if nxt.startswith("/") and not nxt.startswith("//"):
            return redirect(nxt)
        return redirect(url_for("pos.hardware", till=t["id"] if t else None, adj=f.get("target")) + "#adjust")
    elif what == "drawer":
        mode = "printer" if f.get("drawer_mode") == "printer" else "none"
        printer = (f.get("drawer_printer") or "").strip()[:200] or t["receipt_printer"]
        if mode == "printer" and not printer:
            raise PostingError(f"Choose the receipt printer the drawer plugs into, or set {t['name']}'s drawer to None.")
        don = {k: bool(f.get(k)) for k in PP.DRAWER_ON_DEFAULTS}
        db.execute("UPDATE pos_tills SET drawer_mode=?, drawer_printer=?, drawer_on=? WHERE id=?",
                   (mode, printer if mode == "printer" else t["drawer_printer"], json.dumps(don), t["id"]))
        audit(db, "pos_drawer_setup", f"{t['name']}: {mode} {printer or ''} {json.dumps(don)}")
        msg = f"Cash drawer saved for {t['name']}."
    elif what == "scanner":
        sc = PP.scanner_settings(db)
        sc.update(prefix=(f.get("prefix") or "")[:10], suffix=(f.get("suffix") or "")[:10],
                  capture=bool(f.get("capture")), beep=bool(f.get("beep")),
                  unknown="offer" if f.get("unknown") == "offer" else "say")
        db.execute("UPDATE company SET pos_scanner_settings=? WHERE id=1", (json.dumps(sc),))
        audit(db, "pos_hw_scanner", json.dumps({k: sc[k] for k in ("prefix", "suffix", "capture", "beep", "unknown")}))
        msg = "Barcode scanner settings saved."
    elif what == "kitchen":
        from .pos_kitchen import stations
        for s in stations(db, False):
            if f"printer_{s['id']}" in f:
                db.execute("UPDATE pos_stations SET printer=? WHERE id=?",
                           ((f.get(f"printer_{s['id']}") or "").strip()[:200] or None, s["id"]))
        audit(db, "pos_hw_kitchen", ", ".join(f"{s['name']}={s['printer'] or 'print box'}" for s in stations(db, False)))
        msg = "Kitchen and bar printers saved."
    else:
        raise PostingError("Nothing to save.")
    flash(msg, "ok")
    nxt = f.get("next") or ""
    if nxt.startswith("/") and not nxt.startswith("//"):
        return redirect(nxt)
    return redirect(url_for("pos.hardware", till=t["id"] if t else None) + f"#{what}")


def _test_guard():
    if not perms.can("setup", perms.FULL):
        return jsonify(ok=False, error="Only an owner or administrator can send a test."), 403
    return None


def _live_layout(src, row):
    """The layout from unsaved boxes on the page (lay=1 and the boxes' values), else the saved one."""
    if src.get("lay"):   # the boxes sent override the saved layout
        saved = PP.layout_of(row)
        return PP.computed(PP.clean_layout({**{k: saved[k] for k in PP.LAYOUT_DEFAULTS},
                                            **{k: src[k] for k in PP.LAYOUT_DEFAULTS if k in src}}))
    return PP.layout_of(row)


@bp.route("/hardware/test-print", methods=["POST"])
def hardware_test_print():
    """Print a test receipt (or, with kind=align, the alignment slip) on a till's receipt printer or a kitchen
    station's printer. With no printer (or a problem) the page prints it with the Windows print box instead."""
    db = get_db()
    stop = _test_guard()
    if stop:
        return stop
    d = request.get_json(silent=True) or {}
    kind, row = _target(db, d.get("target") or f"till:{d.get('till_id')}")
    if row is None:
        return jsonify(ok=False, error="Choose a till."), 400
    field = "printer" if kind == "station" else "receipt_printer"
    printer = (d.get("printer") if d.get("printer") is not None else row[field]) or None
    lay = _live_layout(d, row)
    align = d.get("kind") == "align"
    q = {k: v for k, v in d.items() if k in PP.LAYOUT_DEFAULTS or k == "lay"}
    fallback = url_for("pos.hardware_align" if align else "pos.hardware_preview",
                       target=f"{kind}:{row['id']}", print=1, **q)
    if not printer:
        return jsonify(ok=False, fallback=fallback, error="No printer chosen: printing with the Windows print box."), 400
    from ..countries import labels
    co = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    rs = PP.receipt_settings(db)
    job = PP.alignment_job(lay, row["name"]) if align else \
        PP.receipt_job(PP.sample_receipt(co, rs, labels(co)), lay, logo=PP.brand_logo(db)[0] if rs["logo"] else None)
    err = None
    try:
        D.backend().send(printer, job, job="Riyeser POS alignment test" if align else "Riyeser POS test receipt")
    except D.DrawerError as e:
        err = str(e)
    audit(db, "pos_hw_test_print", f"{row['name']} {printer} {'alignment' if align else 'receipt'}: "
                                   f"{'ok' if not err else err}")
    db.commit()
    if err:
        return jsonify(ok=False, fallback=fallback, error=f"{err} Printing with the Windows print box instead."), 502
    return jsonify(ok=True, message=f"Sent to {printer}. Did it come out?")


@bp.route("/hardware/test-docket", methods=["POST"])
def hardware_test_docket():
    db = get_db()
    stop = _test_guard()
    if stop:
        return stop
    d = request.get_json(silent=True) or {}
    s = db.execute("SELECT * FROM pos_stations WHERE id=?", (opt_int(d.get("station_id")),)).fetchone()
    if not s:
        return jsonify(ok=False, error="Choose a station."), 400
    printer = (d.get("printer") if d.get("printer") is not None else s["printer"]) or None
    if not printer:
        return jsonify(ok=False, error=f"Choose a printer for {s['name']} first."), 400
    try:
        D.backend().send(printer, PP.docket_job(s["name"], "Test docket", 0, g.user["full_name"] or g.user["username"],
                                                [(1, "Test item", "no onions")], PP.layout_of(s)),
                         job=f"Riyeser POS test docket {s['name']}")
    except D.DrawerError as e:
        audit(db, "pos_hw_test_docket", f"{s['name']} {printer}: {e}")
        db.commit()
        return jsonify(ok=False, error=str(e)), 502
    audit(db, "pos_hw_test_docket", f"{s['name']} {printer}: ok")
    db.commit()
    return jsonify(ok=True, message=f"Sent to {printer}. Did a test docket come out?")


@bp.route("/hardware/scanner-tested", methods=["POST"])
def hardware_scanner_tested():
    """The "Scan something now" box worked: remember it (and whether the scanner pressed Enter) for the status."""
    db = get_db()
    if not perms.can("setup", perms.FULL):
        return jsonify(ok=False), 403
    d = request.get_json(silent=True) or {}
    sc = PP.scanner_settings(db)
    sc.update(tested_at=datetime.now().strftime("%Y-%m-%d %H:%M"), enter=bool(d.get("enter")))
    db.execute("UPDATE company SET pos_scanner_settings=? WHERE id=1", (json.dumps(sc),))
    audit(db, "pos_hw_scanner_test", f"enter={'yes' if sc['enter'] else 'no'}")
    db.commit()
    return jsonify(ok=True)


@bp.route("/hardware/preview")
def hardware_preview():
    """A sample receipt (or docket, for a kitchen station) as it will print, for the live preview and the Windows
    print box fallback. The boxes on the page pass their unsaved values in the address, so the preview follows."""
    db = get_db()
    a = request.args
    rs = PP.receipt_settings(db)
    if a.get("live"):
        rs.update(logo=a.get("logo") == "1", show_name=a.get("show_name") == "1", show_address=a.get("show_address") == "1",
                  show_tax_id=a.get("show_tax_id") == "1", show_phone=a.get("show_phone") == "1",
                  footer=(a.get("footer") or "")[:300])
    kind, row = _target(db, a.get("target") or f"till:{a.get('till')}")
    lay = _live_layout(a, row)
    if kind == "station" and row is not None:
        o = dict(id=0, note=None, kitchen_sent_at=datetime.now().strftime("%Y-%m-%d %H:%M"), updated_at="", lines=[])
        items = [dict(qty=2, name="Beef Burger", note="no onion", moved_from=None),
                 dict(qty=1, name="Fish & Chips", note=None, moved_from=None)]
        return render_template("pos/docket.html", o=o, user=g.user, groups=[dict(station=row["name"], items=items)],
                               send=1, label="Table 4", several=True, lc=PP.css_vars(lay), preview=not a.get("print"))
    ctx = receipt_ctx(db, row["id"] if row is not None else None, rs=rs, lay=lay, preview=not a.get("print"))
    s = dict(number="TEST-0001", created_at="2026-11-28 10:42", voided=0, total=1560, tax_total=142, method="cash",
             tendered=2000, change_given=440, cname="Walk-in Customer", full_name="Sample Cashier", username="sample")
    lines = [dict(description="Flat White", qty=2, unit_price=455, discount_pct=0, net_amount=827, tax_amount=83),
             dict(description="Banana Bread", qty=1, unit_price=650, discount_pct=0, net_amount=591, tax_amount=59)]
    tenders = [dict(method="cash", tendered=2000, change_given=440, amount=1560, terminal_txn_id=None, receipt=[])]
    return render_template("pos/receipt.html", s=s, lines=lines, tenders=tenders, methods=METHOD_LABELS,
                           part=None, parts=[], **ctx)


@bp.route("/hardware/align")
def hardware_align():
    """The alignment test slip for the Windows print path (and the on-screen preview of the printed one)."""
    db = get_db()
    _kind, row = _target(db, request.args.get("target"))
    lay = _live_layout(request.args, row)
    return render_template("pos/align.html", lay=lay, lc=PP.css_vars(lay), name=row["name"] if row else "",
                           preview=not request.args.get("print"))
