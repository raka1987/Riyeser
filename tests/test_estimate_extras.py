"""Riyeser Estimate extras: Good / Better / Best options on one estimate and its quote (each option's totals, tax and
profit; the customer's choice recorded when the quote is accepted, in the app or online; the invoice and the Bookings
job are the chosen option), and photos with markup (stored with the estimate, size limits, big ones shrunk, the
markup JSON kept as sent, the flattened picture on the quote PDF)."""
import io
import json

import pytest

from riyeser.db import get_db
from riyeser.ledger import calc_line
from riyeser import quote_options as QO
from riyeser.measure import photos as P
from tests.test_estimate import est, _one, _new_estimate, _template_id

ROOM = {"kind": "room", "label": "Lounge", "length": "5", "width": "4", "height": "2.4", "op_kind": ["door"],
        "op_w": ["0.82"], "op_h": ["2.04"], "op_n": ["1"]}


def _line_id(app, tpl, desc):
    return _one(app, "SELECT id FROM measure_template_lines WHERE template_id=? AND description=?", (tpl, desc))[0]


def _painting(tmp_path, monkeypatch):
    """An estimate for a lounge (walls 41.53 m², ceiling 20 m²) on the painting template, walls at $15/m²."""
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c)
    c.post(f"/estimate/{tid}/items/manual", data=ROOM)
    paint = _template_id(app, "painting")
    c.post(f"/estimate/{tid}/template", data={"template_id": str(paint)})
    walls = _line_id(app, paint, "Paint walls (2 coats)")
    ceil = _line_id(app, paint, "Paint ceilings (2 coats)")
    c.post(f"/estimate/{tid}/price", data={f"rate_{walls}": "15", "markup_pct": "0", "go": "save"})
    return app, c, tid, paint, walls, ceil


def _takeoff(app, tid):
    return _one(app, "SELECT * FROM takeoffs WHERE id=?", (tid,))


def _three_options(app, c, tid, walls, ceil):
    """Good: walls only at $15. Better (recommended): walls + ceilings at $15 and $12. Best: as Better, 20% markup."""
    r = c.post(f"/estimate/{tid}/options/start")
    assert r.status_code == 302 and "opt=1" in r.headers["Location"]
    assert c.post(f"/estimate/{tid}/price", data={"opt": "1", "option_name": "Better", f"rate_{walls}": "15",
                                                 f"rate_{ceil}": "12", "markup_pct": "0", "go": "save"}).status_code == 302
    c.post(f"/estimate/{tid}/price", data={"opt": "2", "option_name": "Best", f"rate_{walls}": "15", f"rate_{ceil}": "12",
                                          "markup_pct": "20", "go": "save"})
    c.post(f"/estimate/{tid}/price", data={"opt": "0", "option_name": "Good", f"rate_{walls}": "15", "markup_pct": "0",
                                          "go": "save"})


# ---------------------------------------------------------------- options: the maths
def test_options_start_as_copies_and_each_has_its_own_total_profit_and_margin(tmp_path, monkeypatch):
    from riyeser.measure import quote as Q
    app, c, tid, paint, walls, ceil = _painting(tmp_path, monkeypatch)
    single = c.get(f"/estimate/{tid}/price").get_data(as_text=True)
    assert "Add options" in single and "opt-card" not in single          # one price until options are added
    _three_options(app, c, tid, walls, ceil)
    t = _takeoff(app, tid)
    opts = Q.options(t)
    assert [o["name"] for o in opts["list"]] == ["Good", "Better", "Best"] and opts["recommended"] == 1
    with app.app_context():
        priced = Q.price_options(get_db(), t)
    tot = {o["name"]: p["total"] for o, p in priced}
    assert tot["Good"] == round(41.53 * 1500)
    assert tot["Better"] == round(41.53 * 1500) + 20 * 1200
    best_lines = priced[2][1]["lines"]
    assert all(l["unit_price"] in (0, 1800, 1440) for l in best_lines)   # 20% markup on every line
    assert tot["Best"] == sum(int(round(l["qty"] * l["unit_price"])) for l in best_lines) > tot["Better"]
    for _o, p in priced:   # no costs in the shipped template: all profit, 100% margin
        assert p["profit"]["profit"] == p["total"] and p["profit"]["margin_pct"] == (100.0 if p["total"] else 0.0)
    page = c.get(f"/estimate/{tid}/price?opt=2").get_data(as_text=True)
    assert page.count(' data-opt="') == 3 and "★ Recommended" in page and 'value="Best"' in page
    assert "Profit: only you see it" in page
    # a cost on the template line: profit and margin follow it, option by option
    with app.app_context():
        get_db().execute("UPDATE measure_template_lines SET cost=900 WHERE id=?", (walls,))
        get_db().commit()
        priced = Q.price_options(get_db(), _takeoff(app, tid))
    good = priced[0][1]["profit"]
    assert good["cost"] == round(41.53 * 900) and good["profit"] == round(41.53 * 1500) - round(41.53 * 900)
    assert good["margin_pct"] == round(100.0 * good["profit"] / good["sell"], 1)


def test_options_rename_recommend_add_remove_and_back_to_one_price(tmp_path, monkeypatch):
    from riyeser.measure import quote as Q
    app, c, tid, paint, walls, ceil = _painting(tmp_path, monkeypatch)
    c.post(f"/estimate/{tid}/options/start")
    r = c.post(f"/estimate/{tid}/price", data={"opt": "0", "option_name": "Better", "go": "save"}, follow_redirects=True)
    assert "Another option is already called Better" in r.get_data(as_text=True)
    c.post(f"/estimate/{tid}/price", data={"opt": "0", "option_name": "Basic", "go": "save"})
    c.post(f"/estimate/{tid}/options/2/recommend")
    o = Q.options(_takeoff(app, tid))
    assert o["list"][0]["name"] == "Basic" and o["recommended"] == 2
    assert "up to 3 options" in c.post(f"/estimate/{tid}/options/add", follow_redirects=True).get_data(as_text=True)
    c.post(f"/estimate/{tid}/options/1/remove")
    o = Q.options(_takeoff(app, tid))
    assert [x["name"] for x in o["list"]] == ["Basic", "Best"] and o["recommended"] == 1
    assert "at least 2" in c.post(f"/estimate/{tid}/options/0/remove", follow_redirects=True).get_data(as_text=True)
    c.post(f"/estimate/{tid}/options/add", data={"from": "0"})
    assert [x["name"] for x in Q.options(_takeoff(app, tid))["list"]] == ["Basic", "Best", "Good"]
    # each option has its own templates; none is refused
    flooring = _template_id(app, "flooring")
    c.post(f"/estimate/{tid}/price", data={"opt": "2", "templates_shown": "1", "template_id": [str(paint), str(flooring)],
                                          "go": "save"})
    assert Q.options(_takeoff(app, tid))["list"][2]["templates"] == [paint, flooring]
    assert "Choose at least one template" in c.post(f"/estimate/{tid}/price", data={
        "opt": "2", "templates_shown": "1", "go": "save"}, follow_redirects=True).get_data(as_text=True)
    c.post(f"/estimate/{tid}/options/off")
    t = _takeoff(app, tid)
    assert t["options"] is None and json.loads(t["templates"]) == [paint]          # the recommended option's price kept


# ---------------------------------------------------------------- options on the quote
def _quoted(tmp_path, monkeypatch):
    app, c, tid, paint, walls, ceil = _painting(tmp_path, monkeypatch)
    _three_options(app, c, tid, walls, ceil)
    r = c.post(f"/estimate/{tid}/price", data={"opt": "1", "go": "quote"})
    assert r.status_code == 302 and r.headers["Location"].endswith("/send"), r.headers["Location"]
    did = _takeoff(app, tid)["document_id"]
    return app, c, tid, did


def test_one_quote_has_every_option_and_its_total_is_the_recommended_one_with_tax(tmp_path, monkeypatch):
    app, c, tid, did = _quoted(tmp_path, monkeypatch)
    assert _one(app, "SELECT COUNT(*) FROM documents")[0] == 1
    with app.app_context():
        db = get_db()
        opts = QO.of(db, did)
        doc = db.execute("SELECT * FROM documents WHERE id=?", (did,)).fetchone()
        lines = db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (did,)).fetchall()
        rate = db.execute("SELECT rate FROM tax_codes WHERE code='GST'").fetchone()[0]
    assert [o["name"] for o in opts] == ["Good", "Better", "Best"] and [o["recommended"] for o in opts] == [False, True, False]
    for o in opts:   # each option's tax line by line, the same way the ledger works it out
        sub = sum(calc_line(l["qty"], l["unit_price"], 0, rate if l["tax_code_id"] else 0, False)[0] for l in o["lines"])
        tax = sum(calc_line(l["qty"], l["unit_price"], 0, rate if l["tax_code_id"] else 0, False)[1] for l in o["lines"])
        assert (o["subtotal"], o["tax_total"], o["total"]) == (sub, tax, sub + tax) and tax > 0
    better = opts[1]
    assert (doc["subtotal"], doc["tax_total"], doc["total"]) == (better["subtotal"], better["tax_total"], better["total"])
    assert doc["chosen_option"] is None and len(lines) == len(better["lines"]) and all(l["measure_line"] == 1 for l in lines)
    assert opts[0]["subtotal"] == round(41.53 * 1500) and opts[1]["subtotal"] == round(41.53 * 1500) + 20 * 1200
    page = c.get(f"/document/{did}").get_data(as_text=True)
    assert page.count('class="qopt') >= 3 and "the customer chooses one" in page and "Recommended" in page
    assert "Which option did they choose?" in page and page.count('name="option"') == 3
    send = c.get(f"/estimate/{tid}/send").get_data(as_text=True)
    assert "3 options from" in send and "Better (recommended)" in send


def test_updating_the_quote_keeps_hand_typed_lines_in_every_option(tmp_path, monkeypatch):
    app, c, tid, did = _quoted(tmp_path, monkeypatch)
    with app.app_context():
        db = get_db()
        acct = db.execute("SELECT account_id FROM document_lines WHERE document_id=? LIMIT 1", (did,)).fetchone()[0]
        db.execute("INSERT INTO document_lines (document_id, description, qty, unit_price, account_id, net_amount)"
                   " VALUES (?, 'Move furniture', 1, 5000, ?, 5000)", (did, acct))
        db.commit()
    c.post(f"/estimate/{tid}/quote")
    with app.app_context():
        opts = QO.of(get_db(), did)
    assert all(any(l["description"] == "Move furniture" for l in o["lines"]) for o in opts)
    assert opts[0]["subtotal"] == round(41.53 * 1500) + 5000
    assert _one(app, "SELECT COUNT(*) FROM documents")[0] == 1


def test_accepting_records_the_chosen_option_and_the_invoice_is_only_that_option(tmp_path, monkeypatch):
    app, c, tid, did = _quoted(tmp_path, monkeypatch)
    with app.app_context():
        best = QO.of(get_db(), did)[2]
    # without the customer's choice, the quote isn't invoiced (it would be the wrong option)
    monkeypatch.setenv("RIYESER_APP_EDITION", "invoices")
    r = c.post(f"/document/{did}/convert", data={"to": "open"}, follow_redirects=True)
    assert "Mark it accepted with the option" in r.get_data(as_text=True)
    assert _one(app, "SELECT COUNT(*) FROM documents WHERE status='open'")[0] == 0
    r = c.post(f"/document/{did}/quote/accept", data={"accepted_name": "Sam", "source": "phone"}, follow_redirects=True)
    assert "choose the one the customer accepted" in r.get_data(as_text=True)
    r = c.post(f"/document/{did}/quote/accept", data={"accepted_name": "Sam", "source": "phone", "option": "3"},
               follow_redirects=True)
    assert "marked as accepted (Best)" in r.get_data(as_text=True)
    doc = _one(app, "SELECT * FROM documents WHERE id=?", (did,))
    assert doc["quote_status"] == "accepted" and doc["chosen_option"] == 3 and doc["total"] == best["total"]
    page = c.get(f"/document/{did}").get_data(as_text=True)
    assert "Option chosen: <b>Best</b>" in page and "Chosen" in page
    c.post(f"/document/{did}/convert", data={"to": "open"})
    inv = _one(app, "SELECT * FROM documents WHERE status='open'")
    assert inv["total"] == best["total"] and inv["tax_total"] == best["tax_total"]
    with app.app_context():
        descs = [r["description"] for r in get_db().execute("SELECT description FROM document_lines WHERE document_id=?",
                                                             (inv["id"],))]
    assert descs == [l["description"] for l in best["lines"]]


def test_undo_puts_the_recommended_option_back_and_a_hand_edit_changes_only_that_option(tmp_path, monkeypatch):
    app, c, tid, did = _quoted(tmp_path, monkeypatch)
    with app.app_context():
        before = QO.of(get_db(), did)
    c.post(f"/document/{did}/quote/accept", data={"source": "in_person", "option": "Good"})
    assert _one(app, "SELECT total FROM documents WHERE id=?", (did,))[0] == before[0]["total"]
    c.post(f"/document/{did}/quote/undo")
    doc = _one(app, "SELECT * FROM documents WHERE id=?", (did,))
    assert doc["chosen_option"] is None and doc["total"] == before[1]["total"] and doc["quote_status"] is None
    # edit the quote by hand: the option on it (Better) takes the change, Good and Best keep theirs
    monkeypatch.setenv("RIYESER_APP_EDITION", "invoices")
    with app.app_context():
        lines = get_db().execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (did,)).fetchall()
    form = {"contact_id": str(doc["contact_id"]), "date": doc["date"], "status": "quote", "valid_until": doc["valid_until"]}
    for k, col in (("item", "item_id"), ("description", "description"), ("qty", "qty"), ("price", "unit_price"),
                   ("discount", "discount_pct"), ("account", "account_id"), ("tax", "tax_code_id"), ("job", "job_id")):
        vals = []
        for l in lines:
            v = l[col]
            vals.append("" if v is None else (f"{v / 100:.2f}" if col == "unit_price" else str(v)))
        vals.append("Extra coat" if k == "description" else "1" if k == "qty" else "100.00" if k == "price"
                    else str(lines[0]["account_id"]) if k == "account" else str(lines[0]["tax_code_id"] or "") if k == "tax" else "")
        form[f"line_{k}"] = vals
    r = c.post(f"/sale/{did}/edit", data=form)
    assert r.status_code == 302, r.get_data(as_text=True)[:400]
    with app.app_context():
        after = QO.of(get_db(), did)
    assert after[1]["subtotal"] == before[1]["subtotal"] + 10000
    assert after[0]["total"] == before[0]["total"] and after[2]["total"] == before[2]["total"]


def test_accepted_online_records_the_option_named_or_the_recommended_one(tmp_path, monkeypatch):
    from tests.test_online_sync import item, file
    app, c, tid, did = _quoted(tmp_path, monkeypatch)
    num = _one(app, "SELECT number FROM documents WHERE id=?", (did,))[0]
    r = file(app, item("quote_accept", {"quote_ref": num, "accepted_by": {"name": "Sam"}, "option": "Platinum"}))
    assert r["result"]["state"] == "invalid" and "Good, Better, Best" in r["result"]["message"]
    r = file(app, item("quote_accept", {"quote_ref": num, "accepted_by": {"name": "Sam"}, "option": "best"}))
    assert r["result"]["state"] == "accepted"
    doc = _one(app, "SELECT * FROM documents WHERE id=?", (did,))
    assert doc["accepted_source"] == "accepted_online" and doc["chosen_option"] == 3
    assert "Option chosen: Best" in doc["quote_status_note"]
    with app.app_context():
        assert doc["total"] == QO.of(get_db(), did)[2]["total"]
    # a second quote, accepted from a website that doesn't know about options: the recommended one, said so
    c.post(f"/estimate/{tid}/duplicate")
    nid = _one(app, "SELECT MAX(id) FROM takeoffs")[0]
    c.post(f"/estimate/{nid}/quote")
    did2 = _takeoff(app, nid)["document_id"]
    num2 = _one(app, "SELECT number FROM documents WHERE id=?", (did2,))[0]
    file(app, item("quote_accept", {"quote_ref": num2, "accepted_by": {"name": "Sam"}, "options": ["Gift wrap"]}))
    d2 = _one(app, "SELECT * FROM documents WHERE id=?", (did2,))
    assert d2["chosen_option"] == 2 and "(none named, so the recommended one)" in d2["quote_status_note"]
    # one of the ticked "options" that is an option's name counts as the choice
    c.post(f"/estimate/{tid}/duplicate")
    nid3 = _one(app, "SELECT MAX(id) FROM takeoffs")[0]
    c.post(f"/estimate/{nid3}/quote")
    did3 = _takeoff(app, nid3)["document_id"]
    num3 = _one(app, "SELECT number FROM documents WHERE id=?", (did3,))[0]
    file(app, item("quote_accept", {"quote_ref": num3, "accepted_by": {"name": "Sam"}, "options": ["Good"]}))
    assert _one(app, "SELECT chosen_option FROM documents WHERE id=?", (did3,))[0] == 1


def test_bookings_job_from_the_quote_is_the_chosen_option(tmp_path, monkeypatch):
    app, c, tid, did = _quoted(tmp_path, monkeypatch)
    c.post(f"/document/{did}/quote/accept", data={"source": "email", "option": "1"})
    with app.app_context():
        good = QO.of(get_db(), did)[0]
    monkeypatch.setenv("RIYESER_APP_EDITION", "bookings")
    r = c.post(f"/document/{did}/quote/job")
    assert r.status_code == 302
    job = _one(app, "SELECT * FROM booking_jobs")
    assert job is not None, "the job wasn't made"
    assert job["price"] == good["total"] and "option Good" in job["notes"]
    with app.app_context():
        assert job["notes"].count("\n- ") == len(good["lines"])   # Good's lines, not every option's


def test_single_option_estimates_are_unchanged(tmp_path, monkeypatch):
    app, c, tid, paint, walls, ceil = _painting(tmp_path, monkeypatch)
    c.post(f"/estimate/{tid}/quote")
    did = _takeoff(app, tid)["document_id"]
    with app.app_context():
        assert QO.of(get_db(), did) == []
    page = c.get(f"/document/{did}").get_data(as_text=True)
    assert "qopt" not in page and 'name="option"' not in page
    c.post(f"/document/{did}/quote/accept", data={"source": "phone"})
    assert _one(app, "SELECT quote_status, chosen_option FROM documents WHERE id=?", (did,))[:] == ("accepted", None)
    # turning options on then off again takes them off the quote when it's updated
    c.post(f"/document/{did}/quote/undo")
    c.post(f"/estimate/{tid}/options/start")
    c.post(f"/estimate/{tid}/quote")
    with app.app_context():
        assert len(QO.of(get_db(), did)) == 3
    c.post(f"/estimate/{tid}/options/off")
    c.post(f"/estimate/{tid}/quote")
    with app.app_context():
        assert QO.of(get_db(), did) == []


def test_quote_pdf_lays_out_the_options_with_choose_one(tmp_path, monkeypatch):
    from pypdf import PdfReader
    app, c, tid, did = _quoted(tmp_path, monkeypatch)
    r = c.get(f"/estimate/{tid}/quote.pdf")
    assert r.status_code == 200 and r.data[:5] == b"%PDF-"
    text = PdfReader(io.BytesIO(r.data)).pages[0].extract_text()
    for want in ("Choose one option", "Good", "Better", "Best", "RECOMMENDED", "Recommended: Better"):
        assert want in text, (want, text)
    with app.app_context():
        opts = QO.of(get_db(), did)
    from riyeser.db import fmt_money
    assert all(fmt_money(o["total"]) in text for o in opts)
    c.post(f"/document/{did}/quote/accept", data={"source": "phone", "option": "2"})
    text = PdfReader(io.BytesIO(c.get(f"/estimate/{tid}/quote.pdf").data)).pages[0].extract_text()
    assert "You chose Better" in text and "CHOSEN" in text and "Total: Better" in text


def test_options_with_many_lines_stack_in_the_pdf(tmp_path, monkeypatch):
    """More lines than fit side by side: the options go one under another, each with its own table and total."""
    from riyeser import pdf as pdfmod
    from pypdf import PdfReader
    app, c, tid, did = _quoted(tmp_path, monkeypatch)
    with app.app_context():
        db = get_db()
        opts = QO.of(db, did)
        many = [dict(l, description=f"{l['description']} part {i}") for i in range(14) for l in opts[0]["lines"]]
        QO.save(db, did, [{"name": "Good", "lines": many}, {"name": "Better", "lines": opts[1]["lines"], "recommended": True}])
        db.commit()
        data = pdfmod.document_pdf(db, did)
    text = "".join(p.extract_text() for p in PdfReader(io.BytesIO(data)).pages)
    assert "Total: Good" in text and "Total: Better" in text and "Choose one option" in text


# ---------------------------------------------------------------- photos
def _jpeg(w=800, h=600, colour=(120, 140, 160)):
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (w, h), colour).save(b, "JPEG", quality=90)
    return b.getvalue()


def _upload(c, tid, data, name="site.jpg"):
    return c.post(f"/estimate/{tid}/photos", data={"file": (io.BytesIO(data), name)}, content_type="multipart/form-data")


MARKUP = {"v": 1, "shapes": [
    {"t": "arrow", "c": "#dc2626", "w": 0.006, "p": [[0.1, 0.1], [0.4, 0.35]]},
    {"t": "circle", "c": "#2563eb", "w": 0.008, "p": [[0.5, 0.5], [0.7, 0.8]]},
    {"t": "rect", "c": "#16a34a", "w": 0.006, "p": [[0.05, 0.6], [0.3, 0.9]]},
    {"t": "pen", "c": "#f97316", "w": 0.006, "p": [[0.6, 0.1], [0.62, 0.12], [0.65, 0.18], [0.7, 0.2]]},
    {"t": "text", "c": "#ffffff", "w": 0.006, "p": [[0.2, 0.45]], "s": "Rot here", "fs": 0.04},
    {"t": "measure", "c": "#dc2626", "w": 0.006, "p": [[0.1, 0.95], [0.9, 0.95]], "s": "3.2 m", "fs": 0.035}]}


def test_markup_json_round_trips_and_is_checked():
    m = P.clean_markup(MARKUP)
    assert m == MARKUP and P.clean_markup(json.loads(json.dumps(m))) == m
    dirty = {"shapes": [{"t": "arrow", "c": "red", "w": 9, "p": [[0.123456789, 2.5], [0.2, 0.2]]},
                        {"t": "bomb", "p": [[0, 0]]}, {"t": "text", "p": [[0.5, 0.5]], "s": "  "},
                        {"t": "measure", "p": [[0, 0], [1, 1], [2, 2]], "s": "x" * 99}, "junk"]}
    m = P.clean_markup(dirty)
    assert [s["t"] for s in m["shapes"]] == ["arrow", "measure"]
    a, ms = m["shapes"]
    assert a["c"] == P.COLOURS[0] and a["w"] == 0.05 and a["p"] == [[0.1235, 1.5], [0.2, 0.2]]
    assert len(ms["p"]) == 2 and len(ms["s"]) == 30
    with pytest.raises(P.PhotoError):
        P.clean_markup("not json")
    with pytest.raises(P.PhotoError):
        P.clean_markup({"shapes": [MARKUP["shapes"][0]] * (P.MAX_SHAPES + 1)})


def test_photos_stored_with_the_estimate_limits_and_big_ones_shrunk(tmp_path, monkeypatch):
    from PIL import Image
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c)
    assert c.get(f"/estimate/{tid}/photos").status_code == 200
    r = _upload(c, tid, _jpeg())
    j = r.get_json()
    assert r.status_code == 200 and j["ok"] and len(j["photos"]) == 1
    pid = j["added"][0]
    row = _one(app, "SELECT * FROM takeoff_photos WHERE id=?", (pid,))
    assert row["takeoff_id"] == tid and row["mime"] == "image/jpeg" and (row["width"], row["height"]) == (800, 600)
    assert row["on_pdf"] == 1 and row["data"] == _jpeg()          # a small JPEG is kept exactly as it came
    # a big photo is made smaller (the long side 2400 px), a PNG screenshot too
    big = _upload(c, tid, _jpeg(5000, 3000), "big.jpg").get_json()
    b = _one(app, "SELECT * FROM takeoff_photos WHERE id=?", (big["added"][0],))
    assert (b["width"], b["height"]) == (2400, 1440) and Image.open(io.BytesIO(b["data"])).size == (2400, 1440)
    # what isn't a photo, an empty file, a HEIC, and one over the size limit: refused, saying why
    bad = _upload(c, tid, b"MZ not a photo", "x.exe")
    assert bad.status_code == 400 and "isn't a photo" in bad.get_json()["error"]
    heic = _upload(c, tid, b"\x00\x00\x00\x18ftypheic" + b"\x00" * 64, "IMG_1.HEIC")
    assert "HEIC" in heic.get_json()["error"] and "Most Compatible" in heic.get_json()["error"]
    monkeypatch.setattr(P, "MAX_UPLOAD", 1024 * 1024)
    huge = _upload(c, tid, b"\xff\xd8\xff" + b"\x00" * (1024 * 1024 + 10), "huge.jpg")
    assert huge.status_code == 413 and "huge.jpg is over 1 MB" in huge.get_json()["error"]
    monkeypatch.setattr(P, "MAX_PHOTOS", 2)
    full = _upload(c, tid, _jpeg(), "third.jpg").get_json()
    assert not full["ok"] and "up to 2 photos" in full["error"]
    assert _one(app, "SELECT COUNT(*) FROM takeoff_photos WHERE takeoff_id=?", (tid,))[0] == 2
    # caption and "On the quote", then delete
    assert c.post(f"/estimate/{tid}/photos/{pid}", json={"caption": "Front step", "on_pdf": False}).get_json()["ok"]
    row = _one(app, "SELECT caption, on_pdf FROM takeoff_photos WHERE id=?", (pid,))
    assert tuple(row) == ("Front step", 0)
    assert c.post(f"/estimate/{tid}/photos/{big['added'][0]}/delete", json={}).get_json()["ok"]
    assert _one(app, "SELECT COUNT(*) FROM takeoff_photos WHERE takeoff_id=?", (tid,))[0] == 1
    # another estimate's photo isn't reachable from this one
    other = _new_estimate(c, title="Other job")
    assert c.get(f"/estimate/{other}/photos/{pid}/img").status_code == 404


def test_markup_saved_non_destructively_and_rendered_flat(tmp_path, monkeypatch):
    from PIL import Image
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c)
    orig = _jpeg(800, 600, (200, 200, 200))
    pid = _upload(c, tid, orig).get_json()["added"][0]
    r = c.post(f"/estimate/{tid}/photos/{pid}/markup", json={"markup": MARKUP}).get_json()
    assert r["ok"] and r["markup"] == MARKUP and r["photo"]["marks"] == 6
    assert c.get(f"/estimate/{tid}/photos/{pid}/markup").get_json()["markup"] == MARKUP     # round trip
    row = _one(app, "SELECT * FROM takeoff_photos WHERE id=?", (pid,))
    assert row["data"] == orig and json.loads(row["markup"]) == MARKUP                       # the photo itself unchanged
    flat = Image.open(io.BytesIO(row["flat"])).convert("RGB")
    assert flat.size == (800, 600)
    px = flat.getpixel((int(0.25 * 800), int(0.225 * 600)))                                 # on the red arrow
    assert px[0] > 150 and px[1] < 110 and px[2] < 110
    assert flat.getpixel((790, 10)) == pytest.approx((200, 200, 200), abs=6)                 # untouched corner
    assert c.get(f"/estimate/{tid}/photos/{pid}/img").data == row["flat"]
    assert c.get(f"/estimate/{tid}/photos/{pid}/img?v=orig").data == orig
    assert Image.open(io.BytesIO(c.get(f"/estimate/{tid}/photos/{pid}/img?w=200").data)).size[0] == 200
    # cleared: no flat picture, the photo as it was
    c.post(f"/estimate/{tid}/photos/{pid}/markup", json={"markup": {"v": 1, "shapes": []}})
    row = _one(app, "SELECT markup, flat FROM takeoff_photos WHERE id=?", (pid,))
    assert row["markup"] is None and row["flat"] is None
    assert c.post(f"/estimate/{tid}/photos/{pid}/markup", json={"markup": "{bad"}).status_code == 400


def test_quote_pdf_has_the_chosen_photos_with_captions(tmp_path, monkeypatch):
    from pypdf import PdfReader
    app, c, tid, paint, walls, ceil = _painting(tmp_path, monkeypatch)
    a = _upload(c, tid, _jpeg(800, 600), "a.jpg").get_json()["added"][0]
    b = _upload(c, tid, _jpeg(600, 900), "b.jpg").get_json()["added"][0]
    c.post(f"/estimate/{tid}/photos/{a}", json={"caption": "Water damage by the window"})
    c.post(f"/estimate/{tid}/photos/{a}/markup", json={"markup": MARKUP})
    c.post(f"/estimate/{tid}/photos/{b}", json={"caption": "Left off the quote"})
    c.post(f"/estimate/{tid}/quote")
    send = c.get(f"/estimate/{tid}/send").get_data(as_text=True)
    assert "Photos on the quote" in send and "Water damage by the window" in send
    c.post(f"/estimate/{tid}/photos/pdf", data={"on": [str(a)]})        # the Send step: only the first
    assert _one(app, "SELECT on_pdf FROM takeoff_photos WHERE id=?", (b,))[0] == 0
    data = c.get(f"/estimate/{tid}/quote.pdf").data
    pages = PdfReader(io.BytesIO(data)).pages
    text = "".join(p.extract_text() for p in pages)
    assert "Photos" in text and "Water damage by the window" in text and "Left off the quote" not in text
    photo_page = next(p for p in pages if "Water damage" in p.extract_text())
    assert len(photo_page.images) == 1
    # duplicating the estimate copies its photos and markup
    c.post(f"/estimate/{tid}/duplicate")
    nid = _one(app, "SELECT MAX(id) FROM takeoffs")[0]
    assert _one(app, "SELECT COUNT(*) FROM takeoff_photos WHERE takeoff_id=? AND markup IS NOT NULL", (nid,))[0] == 1


def test_photos_read_only_after_the_trial(tmp_path, monkeypatch):
    from tests.test_estimate import _marker
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c)
    pid = _upload(c, tid, _jpeg()).get_json()["added"][0]
    _marker(tmp_path, 120)
    r = _upload(c, tid, _jpeg())
    assert r.status_code == 402
    assert c.post(f"/estimate/{tid}/photos/{pid}/markup", json={"markup": MARKUP}).status_code == 402
    page = c.get(f"/estimate/{tid}/photos").get_data(as_text=True)
    assert "data-del=" not in page and 'id="ph-file"' not in page
