"""Riyeser Estimate (Measure & Quote): geometry and units, trade templates -> quote lines, the quote it makes and
updates, the "estimate" licence module (90 days from first use, then read-only), the separate app and the demo."""
import json
import math
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from riyeser import licence
from riyeser.db import get_db
from riyeser.measure import geometry as G, units as U, engine, seeds, store
from tests.test_pos_app import make

ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------- units
def test_unit_conversions_metric_and_imperial():
    assert U.from_si(1, "ft") == pytest.approx(3.28084, rel=1e-5)
    assert U.from_si(1, "ft2") == pytest.approx(10.7639, rel=1e-5)
    assert U.from_si(U.SQUARE, "square") == pytest.approx(1)
    assert U.to_si(1, "square") == pytest.approx(9.290304)
    assert U.from_si(1, "yd3") == pytest.approx(1.30795, rel=1e-5)
    assert U.fmt(10, "area", "metric") == "10 m²"
    assert U.fmt(10, "area", "imperial") == "107.64 sq ft"
    assert U.fmt(1, "volume", "imperial") == "1.31 cu yd"
    assert U.fmt(3, "length", "imperial") == "9.84 ft"


@pytest.mark.parametrize("typed,sys_,metres", [
    ("3.6", "metric", 3.6), ("2400mm", "metric", 2.4), ("240 cm", "metric", 2.4), ("3,25", "metric", 3.25),
    ("12", "imperial", 12 * 0.3048), ("12' 6\"", "imperial", 12 * 0.3048 + 6 * 0.0254), ("12'6", "imperial", 3.81),
    ("6in", "imperial", 0.1524), ("10 1/2\"", "imperial", 10.5 * 0.0254), ("3.2 m", "imperial", 3.2), ("", "metric", None)])
def test_parse_what_people_type(typed, sys_, metres):
    v = U.parse_length(typed, sys_)
    assert v == pytest.approx(metres) if metres is not None else v is None


def test_parse_rejects_nonsense():
    with pytest.raises(ValueError):
        U.parse_length("abc")


# ---------------------------------------------------------------- geometry
def test_polygon_area_with_holes_and_scale():
    sq = [(0, 0), (10, 0), (10, 10), (0, 10)]
    assert G.ring_area(sq) == 100
    assert G.polygon_area(sq, [[(2, 2), (4, 2), (4, 4), (2, 4)]]) == 96
    # a plan drawn at 0.02 m per unit: a 500 x 250 unit room is 10 m x 5 m
    q = G.item_quantities("shape", {"points": [[0, 0], [500, 0], [500, 250], [0, 250]], "scale": 0.02,
                                    "holes": [[[0, 0], [50, 0], [50, 50], [0, 50]]]})
    assert q["area"] == pytest.approx(50 - 1)
    assert q["perimeter"] == pytest.approx(30)
    assert G.item_quantities("line", {"points": [[0, 0], [300, 400]], "scale": 0.01})["length"] == pytest.approx(5)


def test_map_area_and_length_from_latlng():
    # 0.0001° of latitude is ~11.06 m at -18°; 0.0001° of longitude is ~10.59 m there
    ll = [[-18.1, 178.4], [-18.1, 178.4001], [-18.1001, 178.4001], [-18.1001, 178.4]]
    q = G.item_quantities("shape", {"latlngs": ll})
    assert q["area"] == pytest.approx(10.585 * 11.064, rel=0.003)
    assert G.item_quantities("line", {"latlngs": ll[:2]})["length"] == pytest.approx(10.585, rel=0.003)


def test_roof_pitch_factor_and_edges():
    assert G.pitch_factor(0) == 1
    for deg, k in ((15, 1.035), (22.5, 1.082), (25, 1.103), (30, 1.155), (35, 1.221), (45, 1.414)):
        assert G.pitch_factor(deg) == pytest.approx(k, abs=0.001)
    assert G.pitch_degrees({"rise": 6, "run": 12}) == pytest.approx(26.565, abs=0.001)    # US 6/12
    assert G.pitch_degrees({"deg": 30}) == 30
    with pytest.raises(ValueError):
        G.pitch_factor(90)
    q = G.item_quantities("roof", {"points": [[0, 0], [10, 0], [10, 5], [0, 5]], "scale": 1, "pitch": {"deg": 30},
                                   "edges": ["eave", "rake", "ridge", "rake"]})
    assert q["roof_plan_area"] == 50 and q["roof_area"] == pytest.approx(50 / math.cos(math.radians(30)))
    tot = G.takeoff_quantities([{"kind": "roof", "data": {"points": [[0, 0], [10, 0], [10, 5], [0, 5]], "scale": 1,
                                                          "pitch": {"deg": 30}, "edges": ["eave", "rake", "ridge", "rake"]}}])
    assert tot["eave"] == 10 and tot["ridge"] == 10 and tot["rake"] == pytest.approx(2 * 5 / math.cos(math.radians(30)))
    assert G.edge_true_length("hip", 10, 30) == pytest.approx(10 * math.sqrt(1 + math.tan(math.radians(30)) ** 2 / 2))
    # typed in: plan area and plan lengths
    q = G.item_quantities("roof", {"plan_area": 100, "pitch": {"rise": 4, "run": 12}, "valley": 6})
    assert q["roof_area"] == pytest.approx(100 * math.sqrt(1 + (4 / 12) ** 2))
    assert q["valley"] > 6


def test_a_ridge_shared_by_two_faces_counts_once():
    north = {"latlngs": [[-33.8472, 151.067], [-33.8472, 151.0673], [-33.8473, 151.0673], [-33.8473, 151.067]],
             "pitch": {"deg": 22.5}, "edges": ["eave", "rake", "ridge", "rake"]}
    south = {"latlngs": [[-33.8473, 151.067], [-33.8473, 151.0673], [-33.8474, 151.0673], [-33.8474, 151.067]],
             "pitch": {"deg": 22.5}, "edges": ["ridge", "rake", "eave", "rake"]}
    one = G.takeoff_quantities([{"kind": "roof", "data": north}])
    both = G.takeoff_quantities([{"kind": "roof", "data": north}, {"kind": "roof", "data": south}])
    assert both["ridge"] == pytest.approx(one["ridge"])             # shared: once
    assert both["eave"] == pytest.approx(2 * one["eave"], rel=1e-3)   # two different eaves
    assert both["roof_area"] == pytest.approx(2 * one["roof_area"], rel=1e-3)


def test_room_walls_less_openings():
    r = G.room(4, 3, 2.4, [{"kind": "door", "width": 0.82, "height": 2.04, "count": 1},
                           {"kind": "window", "width": 1.2, "height": 1.0, "count": 2}])
    assert r["floor_area"] == 12 and r["ceiling_area"] == 12 and r["perimeter"] == 14
    assert r["wall_area_gross"] == pytest.approx(33.6)
    assert r["wall_area"] == pytest.approx(33.6 - 0.82 * 2.04 - 2.4)
    assert r["skirting"] == pytest.approx(14 - 0.82)
    assert (r["doors"], r["windows"]) == (1, 2)


def test_fence_post_counts():
    assert G.fence_posts([24], 2.4) == 11                 # 10 bays, 11 posts
    assert G.fence_posts([25], 2.4) == 12                 # a part bay is still a bay
    assert G.fence_posts([10, 10], 2.5) == 9              # the corner post is shared
    assert G.fence_posts([10, 10, 10, 10], 2.5, closed=True) == 16
    assert G.fence_posts([24], 2.4, gates=2) == 13        # a post per gate
    q = G.item_quantities("fence", {"length": 30, "spacing": 2.4, "gates": [{"width": 1, "count": 1}], "height": 1.8})
    assert q["posts"] == 15 and q["gates"] == 1 and q["panel_length"] == 29 and q["face_area"] == pytest.approx(29 * 1.8)


def test_other_shapes_volume_and_measure_as():
    assert G.item_quantities("circle", {"diameter": 2})["area"] == pytest.approx(math.pi)
    assert G.item_quantities("triangle", {"a": 3, "b": 4, "c": 5})["area"] == pytest.approx(6)
    assert G.item_quantities("triangle", {"base": 4, "height": 3})["area"] == 6
    q = G.item_quantities("rect", {"length": 10, "width": 4, "depth": 0.1})
    assert q["area"] == 40 and q["volume"] == pytest.approx(4)
    assert G.item_quantities("volume", {"length": 2, "width": 3, "depth": 0.5})["volume"] == 3
    assert G.item_quantities("length", {"length": 10, "spacing": 0.45})["count"] == 24
    assert G.item_quantities("shape", {"points": [[0, 0], [2, 0], [2, 2], [0, 2]], "scale": 1, "as": "floor"})["floor_area"] == 4
    assert G.item_quantities("line", {"points": [[0, 0], [3, 0]], "scale": 1, "height": 2, "as": "wall"})["wall_area"] == 6
    assert G.item_quantities("line", {"points": [[0, 0], [3, 0]], "scale": 1, "as": "eave"})["eave"] == 3


def test_js_geometry_matches_python():
    node = shutil.which("node")
    if not node:
        pytest.skip("node isn't installed")
    js = ROOT / "riyeser" / "static" / "measure"
    code = (f"const G=require({json.dumps(str(js / 'geometry.js'))}),U=require({json.dumps(str(js / 'units.js'))});"
            "console.log(JSON.stringify({s:G.quantities('shape',{latlngs:[[-18.1,178.4],[-18.1,178.4001],[-18.1001,178.4001],[-18.1001,178.4]]}),"
            "r:G.quantities('roof',{points:[[0,0],[10,0],[10,5],[0,5]],scale:1,pitch:{rise:6,run:12},edges:['eave','rake','ridge','rake']}),"
            "f:G.quantities('fence',{points:[[0,0],[10,0],[10,10]],scale:1,spacing:2.5,gates:[{count:1,width:1}]}),"
            "p:U.parseLength(\"12' 6\\\"\",'imperial')}))")
    out = json.loads(subprocess.run([node, "-e", code], capture_output=True, text=True, check=True).stdout)
    py_s = G.item_quantities("shape", {"latlngs": [[-18.1, 178.4], [-18.1, 178.4001], [-18.1001, 178.4001], [-18.1001, 178.4]]})
    assert out["s"]["area"] == pytest.approx(py_s["area"], rel=1e-9)
    py_r = G.takeoff_quantities([{"kind": "roof", "data": {"points": [[0, 0], [10, 0], [10, 5], [0, 5]], "scale": 1,
                                                           "pitch": {"rise": 6, "run": 12}, "edges": ["eave", "rake", "ridge", "rake"]}}])
    assert out["r"]["roof_area"] == pytest.approx(py_r["roof_area"]) and out["r"]["rake"] == pytest.approx(py_r["rake"])
    py_f = G.item_quantities("fence", {"points": [[0, 0], [10, 0], [10, 10]], "scale": 1, "spacing": 2.5, "gates": [{"count": 1, "width": 1}]})
    assert out["f"]["posts"] == py_f["posts"] == 10
    assert out["p"] == pytest.approx(U.parse_length("12' 6\"", "imperial"))


# ---------------------------------------------------------------- templates -> lines
def test_pack_rounding_waste_factor_and_minimum():
    ln = {"unit": "m2", "factor": 1, "waste_pct": 10, "pack_size": 1.44, "unit_label": "boxes"}
    qty, label, why = engine.line_amount(ln, 10)          # 10 m² + 10% = 11 m² = 7.64 boxes -> 8
    assert (qty, label) == (8, "boxes") and "10% waste" in why
    assert engine.line_amount({"unit": "m2", "pack_size": 2}, 4)[0] == 2   # exactly 2 packs: not 3
    assert engine.line_amount({"unit": "ft2", "waste_pct": 0}, 1)[0] == pytest.approx(10.76)
    assert engine.line_amount({"unit": "square"}, 92.90304)[0] == 10        # roofing squares
    assert engine.line_amount({"unit": "each", "factor": 2}, 7)[0] == 14     # bags of concrete per post
    # paint: 2 coats at 12 m²/L, 4 L tins
    assert engine.line_amount({"unit": "m2", "factor": 2 / 12, "pack_size": 4}, 50)[0] == 3
    items = [{"kind": "rect", "data": {"length": 2, "width": 2}, "group": "", "label": "Pad"}]
    lines = engine.build_lines({"name": "Small", "min_charge": 30000},
                               [{"id": 1, "section": "Labour", "description": "Lay", "basis": "area", "unit": "m2", "rate": 2000},
                                {"id": 2, "section": "Labour", "description": "Gates", "basis": "gates", "unit": "each", "rate": 5000},
                                {"id": 3, "section": "Other", "description": "Call-out", "basis": "fixed", "unit": "item",
                                 "rate": 1000, "min_charge": 5000}], items)
    assert [l["description"].split(" (")[0] for l in lines] == ["Lay", "Call-out", "Minimum charge for Small"]   # no gates: no line
    assert lines[1]["unit_price"] == 5000                                                       # the line's minimum
    assert engine.lines_total(lines) == 30000                                                  # topped up to the job's minimum


def test_group_filter_and_profit():
    items = [{"kind": "count", "data": {"count": 6}, "group": "power", "label": "GPOs"},
             {"kind": "count", "data": {"count": 10}, "group": "light", "label": "Downlights"}]
    lines = engine.build_lines({"name": "Elec"}, [
        {"id": 1, "section": "Labour", "description": "Power points", "basis": "count", "unit": "each", "group_filter": "power", "rate": 9000, "cost": 4000},
        {"id": 2, "section": "Labour", "description": "Lights", "basis": "count", "unit": "each", "group_filter": "light", "rate": 7000}], items)
    assert [l["qty"] for l in lines] == [6, 10]
    p = engine.profit(lines)
    assert p["sell"] == 6 * 9000 + 10 * 7000 and p["cost"] == 6 * 4000 and len(p["unknown"]) == 1
    assert p["margin_pct"] == pytest.approx(round(100 * (p["sell"] - p["cost"]) / p["sell"], 1))


def test_every_shipped_template_makes_lines_in_both_unit_systems():
    trades = {t for _n, t, _x, _l in seeds.TEMPLATES}
    for need in ("roofing", "fencing", "decking", "painting", "flooring", "tiling", "plastering", "concreting", "paving",
                 "landscaping", "cleaning", "gutters", "insulation", "electrical", "plumbing"):
        assert need in trades, need
    items = [{"kind": "room", "data": {"length": 4, "width": 3, "height": 2.4}, "group": "", "label": "R"},
             {"kind": "rect", "data": {"length": 5, "width": 4, "depth": 0.1}, "group": "", "label": "Slab"},
             {"kind": "roof", "data": {"plan_area": 100, "pitch": {"deg": 20}, "ridge": 10, "eave": 20}, "group": "", "label": "Roof"},
             {"kind": "fence", "data": {"length": 20, "spacing": 2.4, "gates": [{"width": 1, "count": 1}]}, "group": "", "label": "F"},
             {"kind": "count", "data": {"count": 4}, "group": "power fixture downpipe", "label": "C"},
             {"kind": "length", "data": {"length": 8}, "group": "pipe trench", "label": "L"},
             {"kind": "hours", "data": {"hours": 3}, "group": "", "label": "H"}]
    for sys_ in ("metric", "imperial"):
        for name, trade, notes, rows in seeds.template_rows(sys_):
            lines = engine.build_lines({"name": name}, [dict(r, id=i) for i, r in enumerate(rows, 1)], items)
            assert lines, (sys_, name)
            assert all(l["unit_price"] == 0 for l in lines)     # no prices shipped: every business sets its own
            if sys_ == "imperial":
                assert all(r["unit"] not in ("m2", "m", "m3") for r in rows), name


# ---------------------------------------------------------------- the app
def est(tmp_path, monkeypatch, edition="estimate"):
    app, c, _item = make(tmp_path, monkeypatch, edition)
    return app, c


def _one(app, sql, args=()):
    with app.app_context():
        return get_db().execute(sql, args).fetchone()


def _new_estimate(c, **kw):
    data = {"new_name": "Sam Rivera", "new_email": "sam@example.com", "title": "Paint the lounge", "address": "1 Main St"}
    data.update(kw)
    r = c.post("/estimate/new", data=data)
    assert r.status_code == 302, r.get_data(as_text=True)[:500]
    return int(r.headers["Location"].split("/")[2])


def _template_id(app, trade, units="metric"):
    c = app.test_client()
    with app.app_context():
        store.seed_templates(get_db(), units)
        get_db().commit()
        return get_db().execute("SELECT id FROM measure_templates WHERE trade=? AND units=?", (trade, units)).fetchone()[0]


def test_estimate_is_its_own_app(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    r = c.get("/")
    assert r.status_code == 302 and r.headers["Location"].endswith("/estimate/")
    page = c.get("/estimate/").get_data(as_text=True)
    assert "Riyeser Estimate" in page and "ed-est" in page and "Your first estimate in three steps" in page
    for menu in ("Estimates", "Templates", "Quotes", "Customers", "Settings", "Help"):
        assert f"<span>{menu}</span>" in page, menu
    for gone in ("Bank accounts", "General journal", "Enter bill", "Payroll", "Stock items"):
        assert gone not in page
    for url in ("/banking/", "/purchase/new", "/inventory/", "/pos/", "/bookings/", "/sale/list"):
        r = c.get(url)
        assert r.status_code == 302 and "/estimate" in r.headers["Location"], url
    assert c.get("/estimate/templates").status_code == 200 and c.get("/estimate/settings").status_code == 200
    assert "Free trial · 90 days left" in page


def test_other_apps_dont_show_estimate_menus(tmp_path, monkeypatch):
    for edition in ("invoices", "bookings", "basics"):
        (tmp_path / edition).mkdir()
        app, c = est(tmp_path / edition, monkeypatch, edition)
        page = c.get("/sale/list").get_data(as_text=True) if edition != "bookings" else c.get("/bookings/").get_data(as_text=True)
        assert "New estimate" not in page and "/estimate/" not in page
        r = c.get("/estimate/")
        assert r.status_code == 302 and r.headers["Location"].endswith("/setup/estimate-app"), edition
        assert "Download Riyeser Estimate" in c.get("/setup/estimate-app").get_data(as_text=True)


def test_measure_price_quote_and_remeasure(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c)
    assert c.post(f"/estimate/{tid}/how", data={"method": "manual"}).status_code == 302
    r = c.post(f"/estimate/{tid}/items/manual", data={"kind": "room", "label": "Lounge", "length": "5", "width": "4",
                                                     "height": "2.4", "op_kind": ["door"], "op_w": ["0.82"], "op_h": ["2.04"], "op_n": ["1"]})
    assert r.status_code == 302
    tot = {t["key"]: t["text"] for t in c.get(f"/estimate/{tid}/items").get_json()["totals"]}
    assert tot["floor_area"] == "20 m²" and tot["wall_area"] == "41.53 m²"
    paint = _template_id(app, "painting")
    assert c.post(f"/estimate/{tid}/template", data={"template_id": str(paint)}).status_code == 302
    page = c.get(f"/estimate/{tid}/price").get_data(as_text=True)
    assert "Paint walls (2 coats)" in page and "without a price" not in page and "no price yet" in page
    walls = _one(app, "SELECT id FROM measure_template_lines WHERE template_id=? AND description='Paint walls (2 coats)'", (paint,))[0]
    r = c.post(f"/estimate/{tid}/price", data={f"rate_{walls}": "15", "markup_pct": "0", "go": "quote"})
    assert r.status_code == 302 and r.headers["Location"].endswith(f"/estimate/{tid}/send")
    t = _one(app, "SELECT * FROM takeoffs WHERE id=?", (tid,))
    doc = _one(app, "SELECT * FROM documents WHERE id=?", (t["document_id"],))
    assert doc["status"] == "quote" and doc["valid_until"] and doc["subtotal"] == round(41.53 * 1500)
    with app.app_context():
        lines = get_db().execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (doc["id"],)).fetchall()
    assert all(l["measure_line"] == 1 for l in lines) and lines[0]["description"].startswith("Labour: Paint walls")
    send = c.get(f"/estimate/{tid}/send").get_data(as_text=True)
    assert doc["number"] in send and "Send by email" in send and "Draft" in send
    # a line typed into the quote by hand stays when it's measured again
    with app.app_context():
        db = get_db()
        db.execute("INSERT INTO document_lines (document_id, description, qty, unit_price, account_id, net_amount)"
                   " VALUES (?, 'Move furniture', 1, 5000, ?, 5000)", (doc["id"], lines[0]["account_id"]))
        db.commit()
    c.post(f"/estimate/{tid}/items/manual", data={"kind": "room", "label": "Hall", "length": "3", "width": "1",
                                                 "height": "2.4"})
    r = c.post(f"/estimate/{tid}/quote")
    assert r.status_code == 302
    with app.app_context():
        lines2 = get_db().execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (doc["id"],)).fetchall()
    assert any(l["description"] == "Move furniture" and l["measure_line"] is None for l in lines2)
    walls_line = next(l for l in lines2 if l["description"].startswith("Labour: Paint walls"))
    assert walls_line["qty"] == pytest.approx(41.53 + 19.2)
    assert _one(app, "SELECT COUNT(*) FROM documents")[0] == 1          # the same quote, updated
    # the PDF has the measurements page, and the quote shows in the shared quote system
    pdf = c.get(f"/estimate/{tid}/quote.pdf")
    assert pdf.status_code == 200 and pdf.data[:5] == b"%PDF-"
    assert c.get(f"/document/{doc['id']}").status_code == 200
    # accepted: never changed again
    c.post(f"/document/{doc['id']}/quote/accept", data={"accepted_name": "Sam", "source": "phone"})
    assert "Accepted" in c.get("/estimate/").get_data(as_text=True)
    assert "has been accepted" in c.post(f"/estimate/{tid}/quote", follow_redirects=True).get_data(as_text=True)
    # in the Estimate app the quote can't be invoiced here: that's done in Invoices, Bookings or Accounting
    r = c.post(f"/document/{doc['id']}/convert", data={"to": "open"})
    assert r.status_code == 302 and "/estimate" in r.headers["Location"]
    assert _one(app, "SELECT COUNT(*) FROM documents WHERE status='open'")[0] == 0


def test_quote_from_estimate_is_invoiced_in_invoices(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c)
    c.post(f"/estimate/{tid}/items", json={"kind": "rect", "label": "Slab", "data": {"length": "6", "width": "4", "depth": "0.1"}})
    tpl = _template_id(app, "concreting")
    c.post(f"/estimate/{tid}/template", data={"template_id": str(tpl)})
    c.post(f"/estimate/{tid}/quote")
    did = _one(app, "SELECT document_id FROM takeoffs WHERE id=?", (tid,))[0]
    monkeypatch.setenv("RIYESER_APP_EDITION", "invoices")       # the same company file, opened in Riyeser Invoices
    page = c.get(f"/document/{did}").get_data(as_text=True)
    assert "Quote" in page
    assert c.post(f"/document/{did}/convert", data={"to": "open"}).status_code == 302
    assert _one(app, "SELECT COUNT(*) FROM documents WHERE status='open'")[0] == 1
    with app.app_context():
        lines = [r["description"] for r in get_db().execute(
            "SELECT description FROM document_lines WHERE document_id=(SELECT id FROM documents WHERE status='open')")]
    assert any("Concrete" in l for l in lines)


def test_plan_upload_scale_and_drawn_area(tmp_path, monkeypatch):
    from riyeser.measure.demo import sample_plan_png
    import io
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c, title="Bathroom")
    r = c.post(f"/estimate/{tid}/plans", data={"file": (io.BytesIO(sample_plan_png()), "plan.png")}, content_type="multipart/form-data")
    pid = r.get_json()["plan"]["id"]
    assert c.get(f"/estimate/{tid}/plans/{pid}/file").data[:8] == b"\x89PNG\r\n\x1a\n"
    bad = c.post(f"/estimate/{tid}/plans", data={"file": (io.BytesIO(b"MZ not a plan"), "x.exe")}, content_type="multipart/form-data")
    assert bad.status_code == 400
    r = c.post(f"/estimate/{tid}/items", json={"kind": "shape", "source": "plan", "plan_id": pid, "page": 1, "label": "Floor",
                                              "data": {"points": [[70, 60], [310, 60], [310, 360], [70, 360]], "scale": 1, "page": 1, "as": "floor"}})
    assert r.get_json()["ok"]
    # setting the scale (100 px = 1 m) rescales what's already drawn on that page
    assert c.post(f"/estimate/{tid}/plans/{pid}/page", json={"page": 1, "scale": 0.01, "note": "line of 1 m"}).get_json()["ok"]
    tot = {t["key"]: t["text"] for t in c.get(f"/estimate/{tid}/items").get_json()["totals"]}
    assert tot["area"] == "7.2 m²" and tot["floor_area"] == "7.2 m²"
    assert c.post(f"/estimate/{tid}/items", json={"kind": "roof", "data": {"plan_area": "10", "pitch": {"deg": 95}}}).status_code == 400


def test_map_roof_face_with_pitch_and_imperial_units(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c, title="Re-roof")
    c.post(f"/estimate/{tid}/units", data={"units": "imperial"})
    ll = [[40.0, -75.0], [40.0, -74.9999], [39.9999, -74.9999], [39.9999, -75.0]]
    r = c.post(f"/estimate/{tid}/items", json={"kind": "roof", "source": "map", "label": "Front", "data": {
        "latlngs": ll, "pitch": {"rise": 6, "run": 12}, "edges": ["eave", "rake", "ridge", "rake"]}}).get_json()
    tot = {t["key"]: t["text"] for t in r["totals"]}
    plan = G.item_quantities("roof", {"latlngs": ll, "pitch": {"rise": 6, "run": 12}})
    assert tot["roof_area"].endswith("sq ft") and plan["roof_area"] == pytest.approx(plan["roof_plan_area"] * math.sqrt(1.25))
    page = c.get(f"/estimate/{tid}/measure?m=map").get_data(as_text=True)
    assert "Estimate from satellite imagery: verify on site" in page and "vendor/leaflet/leaflet.js" in page
    assert "server.arcgisonline.com" in page    # Esri World Imagery tiles, with their attribution
    roof = _template_id(app, "roofing", "imperial")
    assert _one(app, "SELECT unit FROM measure_template_lines WHERE template_id=? AND description='Roof sheeting'", (roof,))[0] == "square"


def test_pdf_measurements_page_has_no_map_imagery(tmp_path, monkeypatch):
    from riyeser import pdf as pdfmod
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c, title="Fence")
    c.post(f"/estimate/{tid}/items", json={"kind": "fence", "source": "map", "label": "Back fence", "data": {
        "latlngs": [[-33.8476, 151.0669], [-33.8476, 151.06745]], "spacing": "2.4"}})
    c.post(f"/estimate/{tid}/template", data={"template_id": str(_template_id(app, "fencing"))})
    c.post(f"/estimate/{tid}/quote")
    with app.app_context():
        db = get_db()
        did = db.execute("SELECT document_id FROM takeoffs WHERE id=?", (tid,)).fetchone()[0]
        data = pdfmod.document_pdf(db, did)
    assert b"/Subtype /Image" not in data and b"/Subtype/Image" not in data     # lines only: no picture in it
    assert len(data) > 2000
    c.post(f"/estimate/{tid}/summary", data={})                                 # turned off: no measurements page
    with app.app_context():
        assert len(pdfmod.document_pdf(get_db(), did)) < len(data)


def test_duplicate_and_list_filters(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c, title="Deck")
    c.post(f"/estimate/{tid}/items", json={"kind": "rect", "label": "Deck", "data": {"length": "5", "width": "3"}})
    r = c.post(f"/estimate/{tid}/duplicate")
    nid = int(r.headers["Location"].split("/")[2])
    assert nid != tid and _one(app, "SELECT COUNT(*) FROM takeoff_items WHERE takeoff_id=?", (nid,))[0] == 1
    page = c.get("/estimate/?q=Deck%20(copy)").get_data(as_text=True)
    assert "Deck (copy)" in page
    assert "Deck (copy)" not in c.get("/estimate/?st=accepted").get_data(as_text=True)


def test_supplier_price_list_updates_rates(tmp_path, monkeypatch):
    import io
    app, c = est(tmp_path, monkeypatch)
    _template_id(app, "tiling")
    csv_ = "Name,Price\nFloor tiles,40.00\nGrout,12\nUnknown thing,1\n"
    r = c.post("/estimate/templates/prices", data={"file": (io.BytesIO(csv_.encode()), "p.csv"), "markup": "25", "check": "1"},
               content_type="multipart/form-data")
    assert "2 lines matched" in r.get_data(as_text=True)
    assert _one(app, "SELECT rate FROM measure_template_lines WHERE description='Floor tiles'")[0] is None   # only checked
    c.post("/estimate/templates/prices", data={"file": (io.BytesIO(csv_.encode()), "p.csv"), "markup": "25", "apply": "1"},
           content_type="multipart/form-data")
    assert tuple(_one(app, "SELECT rate, cost FROM measure_template_lines WHERE description='Floor tiles'")) == (5000, 4000)


def test_settings_units_currency_tax_and_dates(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    c.post("/estimate/settings", data={"units": "imperial", "currency": "eur", "tax_name": "VAT", "date_format": "dmy",
                                       "map_provider": "esri"})
    co = _one(app, "SELECT measure_units, currency, tax_name, date_format FROM company")
    assert tuple(co) == ("imperial", "EUR", "VAT", "dmy")
    tid = _new_estimate(c)
    c.post(f"/estimate/{tid}/items/manual", data={"kind": "rect", "label": "Patio", "length": "10", "width": "10'"})
    tot = {t["key"]: t["text"] for t in c.get(f"/estimate/{tid}/items").get_json()["totals"]}
    assert tot["area"] == "100 sq ft"
    tpl = _template_id(app, "paving", "imperial")
    c.post(f"/estimate/{tid}/template", data={"template_id": str(tpl)})
    line = _one(app, "SELECT id FROM measure_template_lines WHERE template_id=? AND description='Pavers'", (tpl,))[0]
    c.post(f"/estimate/{tid}/price", data={f"rate_{line}": "5", "go": "quote"})
    page = c.get(f"/estimate/{tid}/send").get_data(as_text=True)
    assert "€" in page and "VAT" in page
    d = _one(app, "SELECT date FROM documents")[0]
    assert f"{d[8:10]}/{d[5:7]}/{d[:4]}" in c.get("/estimate/quotes").get_data(as_text=True)


# ---------------------------------------------------------------- licence: 90 days from first use, then read-only
def _days_ago(n):
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()


def _marker(tmp_path, days):
    for d in (tmp_path / "appdata" / "Riyeser", tmp_path / "_riyeser_home"):
        d.mkdir(parents=True, exist_ok=True)
        (d / ".riyeser-trial-estimate.json").write_text(json.dumps({"firstUse": _days_ago(days), "latest": 0}))


def test_trial_starts_on_first_use_not_when_riyeser_was_installed(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    f = tmp_path / "appdata" / "Riyeser" / "licence.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"trialStart": _days_ago(400)}))    # Accounting has been on this PC for over a year
    st = licence.status(product="estimate")
    assert st["mode"] == "trial" and st["days_left"] == 90 and st["started"] is False
    c.get("/estimate/")                                            # first use
    st = licence.status(product="estimate")
    assert st["mode"] == "trial" and st["started"] and st["days_left"] == 90
    assert licence.status(product="pos")["mode"] == "expired"        # the other programs' trial is unchanged


def test_after_90_days_estimate_is_read_only(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c)
    c.post(f"/estimate/{tid}/items", json={"kind": "count", "label": "Points", "data": {"count": "3"}})
    _marker(tmp_path, 80)
    assert "Free trial · 10 days left" in c.get("/estimate/").get_data(as_text=True)
    _marker(tmp_path, 91)
    page = c.get("/estimate/").get_data(as_text=True)
    assert "Read-only." in page and "Nothing has been deleted" in page.replace("nothing has been deleted", "Nothing has been deleted")
    assert "price to be announced" in page
    r = c.post(f"/estimate/{tid}/items", json={"kind": "count", "label": "More", "data": {"count": "1"}})
    assert r.status_code == 402 and "read-only" in r.get_json()["error"]
    r = c.post("/estimate/new", data={"new_name": "X", "title": "Y"}, follow_redirects=True)
    assert "free trial of Riyeser Estimate has ended" in r.get_data(as_text=True)
    assert _one(app, "SELECT COUNT(*) FROM takeoffs")[0] == 1 and _one(app, "SELECT COUNT(*) FROM takeoff_items")[0] == 1
    for url in ("/estimate/", f"/estimate/{tid}/measure", f"/estimate/{tid}/price", "/estimate/templates"):
        assert c.get(url).status_code == 200, url                     # still there to look at
    assert c.post(f"/estimate/{tid}/sent").status_code == 302         # and to send


def test_online_plan_decides_once_estimate_is_on_it(tmp_path, monkeypatch):
    from tests.test_online_licence import online, PAID, ENDED
    now = datetime.now(timezone.utc)
    f = tmp_path / "licence.json"

    def st(modules):
        o = online(modules)
        o["checkedAt"] = now.isoformat()
        f.write_text(json.dumps({"online": o}))
        return licence.status(now, str(f), product="estimate")
    assert st({"basic": PAID})["mode"] == "trial"                          # not on the plan yet: this PC's trial
    not_started = {"status": "trial", "active": True, "trial_ends": None, "paid_until": None, "days_left": 90}
    assert st({"estimate": not_started})["source"] == "local"
    assert st({"estimate": dict(PAID, paid_until=(now + timedelta(days=30)).date().isoformat())})["mode"] == "licensed"
    assert st({"estimate": ENDED})["mode"] == "expired"


# ---------------------------------------------------------------- demo
def test_demo_has_sample_estimates(tmp_path, monkeypatch):
    from riyeser.demo import seed_demo
    app, c = est(tmp_path, monkeypatch)
    with app.app_context():
        db = get_db()
        db.execute("DELETE FROM items")
        seed_demo(db)
    with app.app_context():
        rows = {r["title"]: dict(r) for r in get_db().execute("SELECT * FROM takeoffs")}
    assert {"Re-roof the park pavilion (sample)", "Back fence with a gate (sample)", "Paint the main bedroom",
            "Retile the bathroom"} <= set(rows)
    page = c.get("/estimate/").get_data(as_text=True)
    assert "Accepted" in page and "Sent" in page and "Draft" in page
    bath = rows["Retile the bathroom"]["id"]
    tot = {t["key"]: t["text"] for t in c.get(f"/estimate/{bath}/items").get_json()["totals"]}
    assert tot["floor_area"] == "7.2 m²" and tot["wall_area"] == "22.68 m²"
    roof = rows["Re-roof the park pavilion (sample)"]
    assert roof["document_id"]
    with app.app_context():
        from riyeser.measure.quote import price
        p = price(get_db(), get_db().execute("SELECT * FROM takeoffs WHERE id=?", (roof["id"],)).fetchone())
    assert p["total"] > 0 and p["profit"]["margin_pct"] > 0
    assert c.get(f"/estimate/{bath}/measure?m=plan").status_code == 200


def test_quote_in_other_apps_links_to_estimate_only_when_on(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c)
    c.post(f"/estimate/{tid}/items", json={"kind": "rect", "label": "Slab", "data": {"length": "6", "width": "4"}})
    c.post(f"/estimate/{tid}/template", data={"template_id": str(_template_id(app, "concreting"))})
    c.post(f"/estimate/{tid}/quote")
    did = _one(app, "SELECT document_id FROM takeoffs WHERE id=?", (tid,))[0]
    page = c.get(f"/document/{did}").get_data(as_text=True)
    assert "Back to the estimate" in page and "Make the invoice in Riyeser Invoices" in page and "Convert to invoice" not in page
    monkeypatch.setenv("RIYESER_APP_EDITION", "invoices")
    page = c.get(f"/document/{did}").get_data(as_text=True)
    assert "Measured in Riyeser Estimate" in page and "Convert to invoice" in page      # its trial started on this PC
    _marker(tmp_path, 120)
    assert "Measured in Riyeser Estimate" not in c.get(f"/document/{did}").get_data(as_text=True)
