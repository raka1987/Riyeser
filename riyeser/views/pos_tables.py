"""Restaurant tables: move an order to another table, move some items, merge two tables, and split the bill.

A split bill makes the table's sale (one tax invoice, so stock, income and GST are posted once) and then takes each
guest's part as its own payment against it: cash, card or both. The order closes when every part is paid. Parts add
up to the bill exactly: an even split gives the spare cents to the first guests; a split by item shares each line
the same way a refund does (each share rounded so the shares add up to the line).

Every move, merge and split is recorded (pos_order_events and the audit trail). Items already sent to the kitchen
keep their "sent" mark when they move, so they're never sent twice; the kitchen screen shows "moved from Table 4".
"""
import json
import sqlite3
from datetime import date

from flask import request, jsonify, g, url_for

from ..countries import request_money
from ..db import get_db, audit, write_txn, round_cents
from ..ledger import save_document, PostingError, void_document
from ..terminals import store as T
from . import opt_int
from .pos import bp, build_sale_lines, discount_approval, valid_till, sale_reference, check_card_txns, record_tenders, \
    walk_in_customer, open_shift, _tenders_from, _sale, BIG_CHANGE, plan
from .pos_kitchen import lines_of, label, event, new_uid


def _open(db, oid, status="open"):
    o = db.execute("SELECT * FROM pos_orders WHERE id=?", (oid,)).fetchone()
    if not o or o["status"] != status:
        raise PostingError("That order is no longer open." if status == "open" else "That bill isn't open.")
    return o


def _at_table(db, table, not_id=None):
    return db.execute("SELECT * FROM pos_orders WHERE status IN ('open','billing') AND order_type='dine_in' AND"
                      " table_no=? AND id IS NOT ?", (table, not_id)).fetchone()


def _table_no(d):
    t = str(d.get("table_no") or "").strip()[:10]
    if not t:
        raise PostingError("Choose a table.")
    return t


def _move_screen_items(db, src, dst, uids, from_label):
    """Kitchen screen: these lines' tickets now belong to the other table, marked "moved from …"."""
    if not uids:
        return
    made = {}
    for k in db.execute(f"SELECT k.*, t.station_id, t.send_no, t.created_at tc, t.bumped_at tb FROM kds_items k"
                        f" JOIN kds_tickets t ON t.id=k.ticket_id WHERE t.order_id=? AND k.line_uid IN"
                        f" ({','.join('?' * len(uids))})", [src["id"]] + list(uids)).fetchall():
        key = k["ticket_id"]
        if key not in made:  # the same ticket (station, time waited) for the new table
            made[key] = db.execute("INSERT INTO kds_tickets (order_id, station_id, send_no, created_at, bumped_at)"
                                   " VALUES (?,?,?,?,?)", (dst["id"], k["station_id"], k["send_no"], k["tc"],
                                                           k["tb"])).lastrowid
        db.execute("UPDATE kds_items SET ticket_id=?, moved_from=? WHERE id=?", (made[key], from_label, k["id"]))
    db.execute("DELETE FROM kds_tickets WHERE order_id=? AND id NOT IN (SELECT ticket_id FROM kds_items)", (src["id"],))


def _split_screen_item(db, uid, new_uid_, qty):
    """Part of a sent line moves: the kitchen screen gets a row for the part that moved."""
    k = db.execute("SELECT * FROM kds_items WHERE line_uid=? ORDER BY id DESC LIMIT 1", (uid,)).fetchone()
    if not k:
        return
    db.execute("UPDATE kds_items SET qty=qty-? WHERE id=?", (qty, k["id"]))
    db.execute("INSERT INTO kds_items (ticket_id, line_uid, name, qty, note, status, moved_from, bumped_at) VALUES"
               " (?,?,?,?,?,?,?,?)", (k["ticket_id"], new_uid_, k["name"], qty, k["note"], k["status"],
                                      k["moved_from"], k["bumped_at"]))


def _seen(db, d):
    """The same move / merge / split sent twice (a double tap, a lost reply): done once. The till sends a one-off
    op_ref with each; the first keeps it (the same table as the form tokens, riyeser/views/__init__.py: once)."""
    token = str(d.get("op_ref") or "").strip()[:64]
    if not token:
        return None
    db.execute("CREATE TABLE IF NOT EXISTS form_submits (token TEXT PRIMARY KEY, location TEXT,"
               " created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    row = db.execute("SELECT location FROM form_submits WHERE token=?", ("pos:" + token,)).fetchone()
    if row:
        return int(row["location"] or 0)
    db.execute("INSERT INTO form_submits (token, location) VALUES (?, '0')", ("pos:" + token,))
    return None


def _done(db, d, oid):
    token = str(d.get("op_ref") or "").strip()[:64]
    if token:
        db.execute("UPDATE form_submits SET location=? WHERE token=?", (str(oid), "pos:" + token))


def _reply(db, oid, **kw):
    from .pos import _order_json
    o = db.execute("SELECT * FROM pos_orders WHERE id=?", (oid,)).fetchone()
    return jsonify(ok=True, order=_order_json(db, o), **kw)


def _fail(e):
    get_db().rollback()
    return jsonify(ok=False, error=str(e)), 400


@bp.route("/order/<int:oid>/move", methods=["POST"])
def move_order(oid):
    """The whole order to another table. A table that already has an order: the two are merged."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    try:
        write_txn(db)
        again = _seen(db, d)
        if again is not None:
            db.rollback()
            return _reply(db, again or oid, repeat=True, message="That was already done.")
        o = _open(db, oid)
        table = _table_no(d)
        if o["order_type"] == "dine_in" and o["table_no"] == table:
            raise PostingError(f"This order is already on Table {table}.")
        other = _at_table(db, table, oid)
        if other:
            return _merge(db, o, other, d)
        before = label(o)
        db.execute("UPDATE pos_orders SET order_type='dine_in', table_no=?, updated_at=datetime('now','localtime')"
                   " WHERE id=?", (table, oid))
        lines = lines_of(o)
        for l in lines:
            if l.get("sent"):
                l["moved_from"] = before
        db.execute("UPDATE pos_orders SET lines=? WHERE id=?", (json.dumps(lines), oid))
        db.execute("UPDATE kds_items SET moved_from=? WHERE ticket_id IN (SELECT id FROM kds_tickets WHERE"
                   " order_id=?)", (before, oid))
        event(db, oid, "move", {"from": before, "to": f"Table {table}"})
        _done(db, d, oid)
        db.commit()
    except PostingError as e:
        return _fail(e)
    return _reply(db, oid, message=f"Moved to Table {table}.")


@bp.route("/order/<int:oid>/merge", methods=["POST"])
def merge_order(oid):
    """Merge this order into another open order (another table): everything ends up on the other one."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    try:
        write_txn(db)
        again = _seen(db, d)
        if again is not None:
            db.rollback()
            return _reply(db, again or oid, repeat=True, message="That was already done.")
        o = _open(db, oid)
        into = opt_int(d.get("into"))
        other = _open(db, into) if into else _at_table(db, _table_no(d), oid)
        if not other or other["id"] == oid:
            raise PostingError("Choose the other table's order.")
        if other["status"] != "open":
            raise PostingError("That table is being paid as a split bill. Finish or undo that first.")
        return _merge(db, o, other, d)
    except PostingError as e:
        return _fail(e)


def _merge(db, o, other, d=None):
    if other["status"] != "open":
        raise PostingError("That table is being paid as a split bill. Finish or undo that first.")
    before = label(o)
    moved = lines_of(o)
    for l in moved:
        if l.get("sent"):
            l["moved_from"] = before
    db.execute("UPDATE pos_orders SET lines=?, updated_at=datetime('now','localtime'),"
               " kitchen_sent_at=COALESCE(kitchen_sent_at, ?) WHERE id=?",
               (json.dumps(lines_of(other) + moved), o["kitchen_sent_at"], other["id"]))
    db.execute("UPDATE pos_orders SET status='merged', lines='[]', updated_at=datetime('now','localtime') WHERE id=?",
               (o["id"],))
    db.execute("UPDATE kds_tickets SET order_id=? WHERE order_id=?", (other["id"], o["id"]))
    sent = [l["uid"] for l in moved if l.get("sent")]
    if sent:
        db.execute(f"UPDATE kds_items SET moved_from=? WHERE line_uid IN ({','.join('?' * len(sent))})",
                   [before] + sent)
    event(db, other["id"], "merge", {"from": before, "into": label(other), "from_order": o["id"]})
    event(db, o["id"], "merged", {"into": label(other), "into_order": other["id"]})
    _done(db, d or {}, other["id"])
    db.commit()
    return _reply(db, other["id"], merged_into=other["id"], message=f"{before} merged into {label(other)}.")


@bp.route("/order/<int:oid>/move-items", methods=["POST"])
def move_items(oid):
    """Move some items (or some of an item's quantity) to another table. {lines: {uid: qty}, table_no}"""
    db = get_db()
    d = request.get_json(silent=True) or {}
    try:
        write_txn(db)
        again = _seen(db, d)
        if again is not None:
            db.rollback()
            return _reply(db, again or oid, repeat=True, message="That was already done.")
        o = _open(db, oid)
        table = _table_no(d)
        if o["order_type"] == "dine_in" and o["table_no"] == table:
            raise PostingError("Choose a different table.")
        want = {str(k): float(v) for k, v in (d.get("lines") or {}).items() if float(v or 0) > 0}
        if not want:
            raise PostingError("Choose the items to move.")
        src_lines = lines_of(o)
        by = {l["uid"]: l for l in src_lines}
        stay, go, screen, before = [], [], [], label(o)
        for l in src_lines:
            q = want.get(l["uid"], 0)
            if q > l["qty"] + 1e-9:
                raise PostingError(f"There are only {l['qty']:g} of that item to move.")
            if not q:
                stay.append(l)
                continue
            if q < l["qty"] - 1e-9:  # part of the line moves: it becomes a line of its own
                part = dict(l, uid=new_uid(), qty=q)
                stay.append(dict(l, qty=round(l["qty"] - q, 6)))
                if l.get("sent"):
                    _split_screen_item(db, l["uid"], part["uid"], q)
                l = part
            if l.get("sent"):
                l = dict(l, moved_from=before)
                screen.append(l["uid"])
            go.append(l)
        if any(u not in by for u in want):
            raise PostingError("Some of those items aren't on this order any more. Open it again.")
        if not stay:
            raise PostingError("That's everything on the order: use Move table instead.")
        dst = _at_table(db, table, oid)
        if dst and dst["status"] != "open":
            raise PostingError(f"Table {table} is being paid as a split bill.")
        if dst:
            db.execute("UPDATE pos_orders SET lines=?, updated_at=datetime('now','localtime') WHERE id=?",
                       (json.dumps(lines_of(dst) + go), dst["id"]))
        else:
            did = db.execute("INSERT INTO pos_orders (order_type, table_no, lines, user_id, kitchen_sent_at) VALUES"
                             " ('dine_in',?,?,?,?)", (table, json.dumps(go), g.user["id"],
                                                      o["kitchen_sent_at"] if screen else None)).lastrowid
            dst = db.execute("SELECT * FROM pos_orders WHERE id=?", (did,)).fetchone()
        db.execute("UPDATE pos_orders SET lines=?, updated_at=datetime('now','localtime') WHERE id=?",
                   (json.dumps(stay), oid))
        _move_screen_items(db, o, dst, screen, before)
        detail = {"from": before, "to": f"Table {table}", "to_order": dst["id"],
                  "items": [dict(item_id=l["item_id"], qty=l["qty"], sent=bool(l.get("sent"))) for l in go]}
        event(db, oid, "move_items", detail)
        event(db, dst["id"], "items_in", detail)
        _done(db, d, oid)
        db.commit()
    except PostingError as e:
        return _fail(e)
    n = sum(l["qty"] for l in go)
    return _reply(db, oid, moved_to=dst["id"], message=f"{n:g} item{'s' if n != 1 else ''} moved to Table {table}.")


# ------------------------------------------------------------ split bills
def even_parts(total, n):
    """total cents into n parts that add up exactly: the first parts get the spare cents."""
    base, extra = divmod(total, n)
    return [base + (1 if i < extra else 0) for i in range(n)]


def item_parts(doc_lines, order_lines, guests):
    """Each guest's amount from the items on their part ({uid: qty} each). Every item must be on someone's part;
    a shared item (a pizza between two) can be split by quantity. Shares of a line add up to the line exactly."""
    totals = [0] * len(guests)
    for dl, ol in zip(doc_lines, order_lines):
        qs = [float(gp.get(ol["uid"], 0) or 0) for gp in guests]
        if abs(sum(qs) - ol["qty"]) > 1e-6:
            raise PostingError(f"{dl['description']}: {ol['qty']:g} on the bill, {sum(qs):g} given to guests. Put "
                               "every item on someone's part.")
        amt, done = dl["net_amount"] + dl["tax_amount"], 0.0
        for i, q in enumerate(qs):
            if q < 0:
                raise PostingError("Quantities can't be below 0.")
            share = round_cents(amt * (done + q) / ol["qty"]) - round_cents(amt * done / ol["qty"])
            totals[i] += share
            done += q
    return totals


def bill_json(db, b):
    parts = db.execute("SELECT * FROM pos_bill_parts WHERE bill_id=? ORDER BY n", (b["id"],)).fetchall()
    s = db.execute("SELECT p.*, d.total, d.number FROM pos_sales p JOIN documents d ON d.id=p.document_id WHERE"
                   " p.id=?", (b["sale_id"],)).fetchone()
    return dict(id=b["id"], mode=b["mode"], status=b["status"], sale_id=b["sale_id"], number=s["number"] if s else "",
                total=s["total"] if s else 0, receipt_url=url_for("pos.receipt", sid=b["sale_id"]),
                parts=[dict(id=p["id"], n=p["n"], label=p["label"], amount=p["amount"], paid=bool(p["paid_at"]),
                            method=p["method"], lines=json.loads(p["lines"]) if p["lines"] else None,
                            change=p["change_given"]) for p in parts],
                left=sum(p["amount"] for p in parts if not p["paid_at"]))


@bp.route("/order/<int:oid>/split", methods=["POST"])
def split_bill(oid):
    """Start a split bill: {mode: even|items|amounts, guests: n | [{uid: qty}] | [cents], labels: [..]}."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    if plan(db)["locked"]:
        from ..plan import capped_message
        return jsonify(ok=False, error=capped_message("pos")), 402
    try:
        write_txn(db)
        again = _seen(db, d)
        if again is not None:
            db.rollback()
            return _reply(db, again or oid, repeat=True, message="That was already done.")
        o = _open(db, oid)
        olines = lines_of(o)
        if not olines:
            raise PostingError("There's nothing on this order to pay.")
        mode = d.get("mode")
        if mode not in ("even", "items", "amounts"):
            raise PostingError("Choose how to split the bill.")
        lines = build_sale_lines(db, olines)
        till = valid_till(db, d.get("till_id"))
        from ..locations import till_location
        loc = till_location(db, till)
        from ..ledger import check_stock, StockShort
        try:
            check_stock(db, lines, bool(d.get("sell_anyway")), location_id=loc)
        except StockShort as e:
            db.rollback()
            return jsonify(ok=False, error=str(e), confirm_stock=e.confirm,
                           confirm_key="sell_anyway" if e.confirm else None), 409
        disc = discount_approval(db, lines, d)
        cid = opt_int(o["customer_id"]) or walk_in_customer(db)
        today = date.today().isoformat()
        info = dict(order_type=o["order_type"], table_no=o["table_no"])
        doc_id = save_document(db, "sale", dict(contact_id=cid, date=today, due_date=today, tax_inclusive=True,
                                                reference=sale_reference(info) + " (split bill)",
                                                notes=(o["note"] or "")[:200], location_id=loc), lines, "open")
        doc = db.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        total = doc["total"]
        if total <= 0:
            raise PostingError(f"A {request_money(0)} bill has nothing to split.")
        dls = db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (doc_id,)).fetchall()
        labels = [str(x)[:30] for x in (d.get("labels") or [])]
        part_lines = None
        if mode == "even":
            n = opt_int(d.get("guests")) or 0
            if not 2 <= n <= 30:
                raise PostingError("Split between 2 and 30 guests.")
            amounts = even_parts(total, n)
        elif mode == "items":
            guests = [{str(k): v for k, v in (gp or {}).items()} for gp in (d.get("guests") or [])]
            guests = [gp for gp in guests if any(float(v or 0) > 0 for v in gp.values())]
            if len(guests) < 2:
                raise PostingError("Put items on at least two guests' parts.")
            amounts = item_parts(dls, olines, guests)
            part_lines = guests
        else:
            amounts = [int(a) for a in (d.get("guests") or [])]
            if len(amounts) < 2 or any(a <= 0 for a in amounts):
                raise PostingError(f"Give at least two amounts, each more than {request_money(0)}.")
            if sum(amounts) != total:
                raise PostingError(f"The amounts add up to {request_money(sum(amounts))}, but the bill is "
                                   f"{request_money(total)}.")
        if any(a <= 0 for a in amounts):
            raise PostingError(f"Every guest's part must be more than {request_money(0)}.")
        shift = open_shift(db, till) if till else None
        sid = db.execute("INSERT INTO pos_sales (document_id, method, tendered, change_given, user_id, till_id,"
                         " shift_id) VALUES (?,?,0,0,?,?,?)", (doc_id, "bill", g.user["id"], till,
                                                               shift["id"] if shift else None)).lastrowid
        if disc:
            db.execute("UPDATE pos_approvals SET ref=? WHERE id=?", (f"sale {sid}", disc))
        bid = db.execute("INSERT INTO pos_bills (order_id, sale_id, mode, created_by) VALUES (?,?,?,?)",
                         (oid, sid, mode, g.user["id"])).lastrowid
        for n, amt in enumerate(amounts, 1):
            db.execute("INSERT INTO pos_bill_parts (bill_id, n, label, amount, lines) VALUES (?,?,?,?,?)",
                       (bid, n, labels[n - 1] if n <= len(labels) and labels[n - 1] else f"Guest {n}", amt,
                        json.dumps(part_lines[n - 1]) if part_lines else None))
        db.execute("UPDATE pos_orders SET status='billing', sale_id=?, updated_at=datetime('now','localtime') WHERE"
                   " id=?", (sid, oid))
        event(db, oid, "split", dict(mode=mode, parts=amounts, sale=sid, number=doc["number"]))
        _done(db, d, oid)
        db.commit()
    except (PostingError, ValueError, TypeError, KeyError) as e:
        return _fail(e)
    return _reply(db, oid, message=f"Bill split {len(amounts)} ways.")


@bp.route("/bill/<int:bid>/pay", methods=["POST"])
def pay_part(bid):
    """Pay one guest's part: {part_id, tenders (cash / card / both), checkout_ref, till_id}. Sent twice, paid once."""
    db = get_db()
    d = request.get_json(silent=True) or {}
    checkout = str(d.get("checkout_ref") or "").strip()[:64] or None
    if not checkout:
        return jsonify(ok=False, error="Missing checkout reference."), 400
    done = db.execute("SELECT * FROM pos_bill_parts WHERE checkout_ref=?", (checkout,)).fetchone()
    if done:
        return _part_reply(db, bid, done["id"], repeat=True)
    cash_t, till = None, None
    try:
        write_txn(db)
        b = db.execute("SELECT * FROM pos_bills WHERE id=?", (bid,)).fetchone()
        if not b or b["status"] != "open":
            raise PostingError("This bill is already paid (or was undone).")
        p = db.execute("SELECT * FROM pos_bill_parts WHERE id=? AND bill_id=?", (opt_int(d.get("part_id")), bid)).fetchone()
        if not p:
            raise PostingError("Choose whose part to pay.")
        if p["paid_at"]:
            raise PostingError(f"{p['label']}'s part is already paid.")
        s = _sale(db, b["sale_id"])
        till = valid_till(db, d.get("till_id")) or s["till_id"]
        tenders = _tenders_from(d, p["amount"], T.provider_for(db, till))
        cash_t = next((t for t in tenders if t["method"] == "cash"), None)
        if cash_t and cash_t["change"] > BIG_CHANGE and not d.get("confirm_big"):
            db.rollback()
            return jsonify(ok=False, error=f"Change of {request_money(cash_t['change'])}? Check the cash tendered.",
                           confirm_key="confirm_big"), 409
        check_card_txns(db, tenders)
        doc = db.execute("SELECT contact_id FROM documents WHERE id=?", (s["document_id"],)).fetchone()
        record_tenders(db, s["id"], s["document_id"], doc["contact_id"], tenders, date.today().isoformat(),
                       s["number"], checkout, part_id=p["id"])
        methods = {t["method"] for t in tenders}
        tendered = sum(t["tendered"] for t in tenders)
        change = cash_t["change"] if cash_t else 0
        db.execute("UPDATE pos_bill_parts SET method=?, checkout_ref=?, tendered=?, change_given=?, paid_at="
                   "datetime('now','localtime'), paid_by=? WHERE id=?",
                   (methods.pop() if len(methods) == 1 else "split", checkout, tendered, change, g.user["id"], p["id"]))
        db.execute("UPDATE pos_sales SET tendered=tendered+?, change_given=change_given+?,"
                   " payment_id=COALESCE(payment_id, (SELECT payment_id FROM pos_tenders WHERE sale_id=? AND"
                   " payment_id IS NOT NULL ORDER BY id LIMIT 1)) WHERE id=?", (tendered, change, s["id"], s["id"]))
        left = db.execute("SELECT COUNT(*) FROM pos_bill_parts WHERE bill_id=? AND paid_at IS NULL", (bid,)).fetchone()[0]
        if not left:
            db.execute("UPDATE pos_bills SET status='paid' WHERE id=?", (bid,))
            db.execute("UPDATE pos_orders SET status='paid', updated_at=datetime('now','localtime') WHERE id=?",
                       (b["order_id"],))
        event(db, b["order_id"], "part_paid", dict(part=p["n"], label=p["label"], amount=p["amount"],
                                                  method=sorted({t["method"] for t in tenders})))
        audit(db, "pos_bill_part", f"sale #{s['id']} part {p['n']} {p['amount'] / 100:.2f}")
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        done = db.execute("SELECT * FROM pos_bill_parts WHERE checkout_ref=?", (checkout,)).fetchone()
        if done:
            return _part_reply(db, bid, done["id"], repeat=True)
        return jsonify(ok=False, error="Could not take this payment."), 400
    except (PostingError, ValueError, TypeError, KeyError) as e:
        return _fail(e)
    drawer = None
    if cash_t or any(t["txn_id"] and (T.get(db, t["txn_id"])["cashout"] or 0) for t in tenders):
        from .pos_drawer import open_drawer
        drawer = open_drawer(db, till, "part", f"part {p['id']}")
    return _part_reply(db, bid, p["id"], drawer=drawer)


def _part_reply(db, bid, part_id, repeat=False, drawer=None):
    b = db.execute("SELECT * FROM pos_bills WHERE id=?", (bid,)).fetchone()
    p = db.execute("SELECT * FROM pos_bill_parts WHERE id=?", (part_id,)).fetchone()
    tenders = db.execute("SELECT * FROM pos_tenders WHERE part_id=? ORDER BY id", (part_id,)).fetchall()
    txns = [T.get(db, t["terminal_txn_id"]) for t in tenders if t["terminal_txn_id"]]
    return jsonify(ok=True, repeat=repeat, bill=bill_json(db, b), part_id=part_id, total=p["amount"],
                   change=p["change_given"], method=p["method"], closed=b["status"] == "paid",
                   sale_id=b["sale_id"], drawer=any(t["method"] == "cash" for t in tenders),
                   drawer_opened=bool(drawer and drawer["opened"]), drawer_error=drawer["error"] if drawer else None,
                   cashout=sum(x["cashout"] or 0 for x in txns),
                   cards=[dict(scheme=x["card_scheme"], last4=x["card_last4"], auth=x["auth_code"],
                               amount=x["amount"]) for x in txns],
                   receipt_url=url_for("pos.receipt", sid=b["sale_id"], part=part_id))


@bp.route("/bill/<int:bid>/undo", methods=["POST"])
def undo_split(bid):
    """Undo a split bill before anyone has paid: the sale is voided (stock back) and the order is open again."""
    db = get_db()
    try:
        write_txn(db)
        b = db.execute("SELECT * FROM pos_bills WHERE id=?", (bid,)).fetchone()
        if not b or b["status"] != "open":
            raise PostingError("This bill can't be undone now.")
        if db.execute("SELECT 1 FROM pos_bill_parts WHERE bill_id=? AND paid_at IS NOT NULL", (bid,)).fetchone():
            raise PostingError("Someone has already paid their part, so the split can't be undone. Take the other "
                               "parts, or refund the paid part from the Sales screen.")
        s = _sale(db, b["sale_id"])
        void_document(db, s["document_id"])
        db.execute("UPDATE pos_sales SET voided=1 WHERE id=?", (s["id"],))
        db.execute("UPDATE pos_bills SET status='cancelled' WHERE id=?", (bid,))
        db.execute("UPDATE pos_orders SET status='open', sale_id=NULL, updated_at=datetime('now','localtime') WHERE"
                   " id=?", (b["order_id"],))
        event(db, b["order_id"], "split_undone", dict(sale=s["id"], number=s["number"]))
        db.commit()
    except PostingError as e:
        return _fail(e)
    return _reply(db, b["order_id"], message="Split undone. The order is open again.")


@bp.route("/order/<int:oid>/history")
def order_history(oid):
    """Moves, merges, splits and voids on this order, newest first."""
    db = get_db()
    rows = db.execute("SELECT e.*, COALESCE(u.full_name, u.username) who FROM pos_order_events e LEFT JOIN users u"
                      " ON u.id=e.user_id WHERE e.order_id=? ORDER BY e.id DESC", (oid,)).fetchall()
    return jsonify([dict(kind=r["kind"], details=json.loads(r["details"] or "{}"), who=r["who"], at=r["created_at"])
                    for r in rows])
