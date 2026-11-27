"""Riyeser Estimate, Import a scan: every reader (on sample files the tests make), the RoomPlan room reader, plane
fitting on a synthetic room mesh (known sizes -> within tolerance), rooms -> template quote lines, the floor plan
(SVG and PDF), the 3D model data and the screens."""
import io
import json
import math
import struct
import zipfile
from pathlib import Path

import pytest

from riyeser.db import get_db
from riyeser.measure import geometry as G, floorplan, scan
from riyeser.measure.scan import sample, planes, usd, rooms as R
from tests.test_estimate import est, _new_estimate, _template_id, _one

HERE = Path(__file__).resolve().parent
L, W, H = 4.2, 3.6, 2.4


def _walls(room):
    return sorted(round(w["length"], 2) for w in room["walls"] if not w.get("open"))


def _full_room(room, L=L, W=W, H=H, tol=0.01):
    assert _walls(room) == pytest.approx(sorted([L, L, W, W]), abs=tol)
    assert room["height"] == pytest.approx(H, abs=tol)
    q = G.item_quantities("room", room)
    assert q["floor_area"] == pytest.approx(L * W, rel=0.01)
    return q


# ---------------------------------------------------------------- the low-level pieces
def test_lz4_and_usd_integer_coding():
    # an LZ4 block: 4 literals "abcd", then a match 8 long at offset 4 -> "abcdabcdabcd"
    assert usd.lz4_block(bytes([0x44]) + b"abcd" + bytes([4, 0])) == b"abcdabcdabcd"
    # literal-only TfFastCompression (one block, chunk count 0)
    assert usd.fast_decompress(b"\x00" + bytes([0x50]) + b"hello") == b"hello"
    # Usd_IntegerCompression: common delta 1, codes [common, small(int8 -3), medium(int16 300), common]
    data = struct.pack("<i", 1) + bytes([0b00_10_01_00]) + struct.pack("<b", -3) + struct.pack("<h", 300)
    assert usd.decode_ints(data, 4) == [1, -2, 298, 299]


def test_usd_crate_written_by_pixar_usd():
    """tests/data/roomplan_room.usdc was written by Pixar's own USD library (usd-core) as a RoomPlan-style room:
    4.5 x 3.2 x 2.6 m, a 0.82 m door and a 1.5 m window, and a table (an object, not part of the room)."""
    data = (HERE / "data" / "roomplan_room.usdc").read_bytes()
    c = usd.Crate(data)
    layer = c.layer()
    assert layer["meta"] == {"upAxis": "Y", "metersPerUnit": 1.0}
    assert "/Room/Parametric_grp/Arch_grp/Wall_grp/Wall3/Wall3" in layer["prims"]
    res = scan.read("room.usdz", sample.write_usdz(data, "room.usdc"))
    assert res["format"] == "RoomPlan USDZ" and res["quality"] == "rooms"
    room = res["rooms"][0]
    _full_room(room, 4.5, 3.2, 2.6)
    doors = [o for o in room["openings"] if o["kind"] == "door"]
    wins = [o for o in room["openings"] if o["kind"] == "window"]
    assert doors[0]["width"] == pytest.approx(0.82, abs=0.005) and doors[0]["height"] == pytest.approx(2.04, abs=0.005)
    assert wins[0]["width"] == pytest.approx(1.5, abs=0.005) and wins[0]["sill"] == pytest.approx(0.9, abs=0.005)
    assert res["preview"] and len(res["preview"]) % 36 == 0     # float32 triangles for the 3D view


def test_usda_in_usdz_with_centimetres():
    parts = sample.room_parts(L, W, H)
    res = scan.read("room.usdz", sample.write_usdz(sample.write_usda(parts, meters_per_unit=0.01)))
    assert res["quality"] == "rooms"
    q = _full_room(res["rooms"][0])
    assert q["doors"] == 1 and q["windows"] == 1
    assert q["wall_area"] == pytest.approx(2 * (L + W) * H - 0.82 * 2.04 - 1.8 * 1.2, abs=0.05)


@pytest.mark.parametrize("fmt", ["glb", "gltf", "obj", "dae", "stl"])
def test_mesh_readers_give_the_same_room(fmt):
    parts = sample.room_parts(L, W, H)
    data = {"glb": lambda: sample.write_glb(parts), "obj": lambda: sample.write_obj(parts),
            "dae": lambda: sample.write_dae(parts, z_up=True), "stl": lambda: sample.write_stl(parts)}.get(fmt)
    if fmt == "gltf":     # .gltf JSON with the buffer embedded as a data: URI
        import base64
        glb = sample.write_glb(parts)
        jlen = struct.unpack_from("<I", glb, 12)[0]
        js = json.loads(glb[20:20 + jlen])
        blen = struct.unpack_from("<I", glb, 20 + jlen)[0]
        js["buffers"][0]["uri"] = "data:application/octet-stream;base64," + base64.b64encode(glb[28 + jlen: 28 + jlen + blen]).decode()
        data = lambda: json.dumps(js).encode()  # noqa: E731
    res = scan.read(f"room.{fmt}", data())
    if fmt == "stl":     # STL has no part names: it's a plain mesh, so the room is estimated by plane fitting
        assert res["quality"] == "mesh"
        return
    assert res["quality"] == "rooms", res
    _full_room(res["rooms"][0])


def test_capturedroom_json():
    res = scan.read("Room.json", json.dumps(sample.capturedroom_json(L, W, H)).encode())
    assert res["format"] == "RoomPlan JSON" and res["quality"] == "rooms"
    room = res["rooms"][0]
    assert room["name"] == "Living room"
    _full_room(room)
    d = next(o for o in room["openings"] if o["kind"] == "door")
    w = next(o for o in room["openings"] if o["kind"] == "window")
    assert (d["width"], d["height"], d["sill"]) == pytest.approx((0.82, 2.04, 0.0), abs=0.001)
    assert (w["width"], w["height"], w["sill"]) == pytest.approx((1.8, 1.2, 0.9), abs=0.001)
    # the door is on the wall it's in, at the right place along it
    a, b = room["outline"][d["wall"]], room["outline"][(d["wall"] + 1) % 4]
    assert abs(a[1] - b[1]) < 1e-6 and a[1] == pytest.approx(-W / 2)
    # a CapturedStructure (several rooms) gives one room each
    two = scan.read("s.json", json.dumps({"rooms": [sample.capturedroom_json(), sample.capturedroom_json(3, 3, 2.5)]}).encode())
    assert len(two["rooms"]) == 2 and _walls(two["rooms"][1]) == [3, 3, 3, 3]


def test_dxf_floor_plan_rooms_doors_windows():
    for lines_only in (False, True):
        res = scan.read("plan.dxf", sample.write_dxf(lines_only=lines_only))
        assert res["quality"] == "plan"
        by = {r["name"]: r for r in res["rooms"]}
        assert set(by) == {"Bedroom", "Bathroom"}               # the outside face of the walls isn't a room
        assert _walls(by["Bedroom"]) == [3.6, 3.6, 4.2, 4.2] and _walls(by["Bathroom"]) == [2.4, 2.4, 3.6, 3.6]
        ops = {o["kind"]: o for o in by["Bedroom"]["openings"]}
        assert ops["door"]["width"] == pytest.approx(0.82) and ops["window"]["width"] == pytest.approx(1.8)
        assert ops["door"]["offset"] == pytest.approx(0.5 + 0.41)      # hinge at 0.5 m, so its middle is at 0.91 m
        assert by["Bedroom"]["height"] == pytest.approx(2.4)
    # in metres, and with feet for an imperial estimate's default height
    res = scan.read("plan.dxf", sample.write_dxf(units_mm=False), system="imperial")
    assert res["rooms"][0]["height"] == pytest.approx(8 * 0.3048)
    with pytest.raises(scan.ScanError, match="DXF"):
        scan.read("plan.dwg", b"AC1032\x00\x00binary")
    with pytest.raises(scan.ScanError, match="binary DXF"):
        scan.read("plan.dxf", b"AutoCAD Binary DXF\r\n\x1a\x00...")


def test_csv_room_list_like_magicplan():
    res = scan.read("stats.csv", sample.write_csv())
    assert res["quality"] == "list"
    by = {r["name"]: r for r in res["rooms"]}
    assert set(by) == {"Living room", "Kitchen"}            # the Total row is skipped
    q = G.item_quantities("room", by["Living room"])
    assert q["floor_area"] == pytest.approx(20) and q["perimeter"] == pytest.approx(18)
    assert q["wall_area"] == pytest.approx(43.2)
    assert by["Kitchen"]["shape_known"] is False
    imp = scan.read("s.csv", b"Room,Area (sq ft),Perimeter (ft)\nDen,120,44\n", system="imperial")
    assert G.item_quantities("room", imp["rooms"][0])["floor_area"] == pytest.approx(120 * 0.09290304, rel=1e-4)


def test_files_that_cant_be_read_say_why():
    for name, data, words in (("a.fbx", b"Kaydara FBX Binary", "GLB"), ("a.ply", b"ply\n", "point cloud"),
                              ("a.e57", b"ASTM-E57", "point cloud"), ("a.json", b'{"foo": 1}', "RoomPlan"),
                              ("a.glb", b"", "empty"), ("a.png", b"\x89PNG", "photo"),
                              ("a.txt", b"hello", "can't read")):
        with pytest.raises(scan.ScanError, match=words):
            scan.read(name, data)
    draco = {"asset": {"version": "2.0"}, "extensionsRequired": ["KHR_draco_mesh_compression"]}
    with pytest.raises(scan.ScanError, match="compressed"):
        scan.read("a.gltf", json.dumps(draco).encode())
    assert scan.read("plan.pdf", b"%PDF-1.7 ...")["pdf"]
    # a zip of an OBJ export (with its textures) reads the OBJ in it
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("export/textured.obj", sample.write_obj(sample.room_parts()))
        z.writestr("export/textured.mtl", "newmtl x")
    res = scan.read("polycam.zip", b.getvalue())
    assert res["quality"] == "rooms" and "textured.obj" in res["notes"][0]


def test_file_size_limit():
    with pytest.raises(scan.ScanError, match="100 MB"):
        scan.read("big.glb", b"glTF" + b"\0" * (scan.MAX_BYTES + 1))


# ---------------------------------------------------------------- plane fitting on a raw mesh
@pytest.mark.parametrize("kw", [{}, {"yaw": 27}, {"L": 6.0, "W": 5.0, "H": 2.7, "yaw": -12, "seed": 9},
                                {"cell": 0.05, "noise": 0.015}])
def test_plane_fitting_finds_a_rooms_size(kw):
    Lr, Wr, Hr = kw.get("L", 4.0), kw.get("W", 3.0), kw.get("H", 2.5)
    res = scan.read("scan.glb", sample.write_glb(sample.room_mesh(**kw)))
    assert res["quality"] == "mesh" and res["format"] == "GLB mesh"
    room = res["rooms"][0]
    assert room["estimated"] and "check on site" in room["note"]
    assert _walls(room) == pytest.approx(sorted([Lr, Lr, Wr, Wr]), abs=0.03)   # walls within 3 cm
    assert room["height"] == pytest.approx(Hr, abs=0.02)                         # ceiling within 2 cm
    q = G.item_quantities("room", room)
    assert q["floor_area"] == pytest.approx(Lr * Wr, rel=0.02)
    assert q["perimeter"] == pytest.approx(2 * (Lr + Wr), abs=0.08)
    assert room["openings"] == []                                                # a mesh doesn't say where doors are


def test_plane_fitting_without_a_ceiling_and_z_up_centimetre_obj():
    res = scan.read("scan.obj", sample.write_obj(sample.room_mesh(ceiling=False), scale=100, z_up=True))
    room = res["rooms"][0]
    assert _walls(room) == pytest.approx([3, 3, 4, 4], abs=0.03)
    assert any("Z-up" in n for n in res["notes"]) and any("centimetres" in n for n in res["notes"])
    assert any("No ceiling" in n for n in res["notes"]) and room["height"] == pytest.approx(2.5, abs=0.03)


def test_ransac_planes_are_level_and_upright():
    tris = sample.room_mesh(furniture=False)[0][1]
    data = planes.triangle_data(tris)
    import random
    lv = planes.ransac(data, "level", random.Random(1))
    assert sorted(round(p["d"], 2) for p in lv[:2]) == pytest.approx([0.0, 2.5], abs=0.01)
    up = planes.ransac(data, "upright", random.Random(1))
    offs = sorted(round(abs(p["d"]), 2) for p in up[:4])
    assert offs == pytest.approx([1.5, 1.5, 2.0, 2.0], abs=0.01)


def test_chain_walls_closes_the_room_and_reports_an_open_side():
    segs = [((0, 0), (4, 0), 2.4), ((4, 3), (4, 0), 2.4), ((4, 3), (0, 3), 2.4), ((0, 3), (0, 0), 2.4)]
    c, h, closed, extra = R.chain_walls(segs)
    assert closed and len(c) == 4 and R.polygon_area(c) == pytest.approx(12) and not extra
    c, h, closed, _ = R.chain_walls(segs[:3])
    assert not closed and h[-1] is None
    room = R.make_room("U", c, h, 2.4, closed=False)
    assert room["walls"][-1]["open"] and G.item_quantities("room", room)["perimeter"] == pytest.approx(11)


# ---------------------------------------------------------------- rooms -> quote lines
def _import(c, name, data):
    tid = _new_estimate(c, title="Scanned flat")
    r = c.post(f"/estimate/{tid}/scans", data={"file": (io.BytesIO(data), name)}, content_type="multipart/form-data")
    j = r.get_json()
    assert r.status_code == 200 and j["ok"], j
    return tid, j["scan"]


def test_import_use_rooms_and_price_every_room_template(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    tid, s = _import(c, "bedroom.glb", sample.write_glb(sample.room_parts(L, W, H)))
    assert s["quality"] == "rooms" and len(s["rooms"]) == 1 and s["has_mesh"]
    rooms = s["rooms"]
    rooms[0]["name"] = "Main bedroom"
    rooms[0]["openings"].append({"kind": "window", "width": 1.0, "height": 1.0, "sill": 1.0, "wall": 1, "offset": 1.8})
    j = c.post(s["urls"]["rooms"], json={"rooms": rooms}).get_json()
    assert j["ok"] and "<svg" in j["floorplan"]
    tot = {t["key"]: t["text"] for t in j["totals"]}
    wall = 2 * (L + W) * H - 0.82 * 2.04 - 1.8 * 1.2 - 1.0
    assert tot["floor_area"] == "15.12 m²" and tot["wall_area"] == f"{wall:.2f} m²"
    assert tot["skirting"] == f"{2 * (L + W) - 0.82:.2f} m" and tot["doors"] == "1 each"
    # using the rooms again replaces them (no doubling up)
    c.post(s["urls"]["rooms"], json={"rooms": rooms})
    assert _one(app, "SELECT COUNT(*) FROM takeoff_items WHERE takeoff_id=? AND source='scan'", (tid,))[0] == 1
    item = _one(app, "SELECT label, verified FROM takeoff_items WHERE takeoff_id=?", (tid,))
    assert item["label"] == "Main bedroom" and item["verified"] == 0
    # every room trade prices it from the scan
    expect = {"painting": "Paint walls (2 coats)", "flooring": "Lay flooring", "tiling": "Lay floor tiles",
              "plastering": "Hang and set walls"}
    ids = [_template_id(app, k) for k in expect]
    c.post(f"/estimate/{tid}/template", data={"template_id": [str(i) for i in ids]})
    with app.app_context():
        from riyeser.measure.quote import price
        p = price(get_db(), get_db().execute("SELECT * FROM takeoffs WHERE id=?", (tid,)).fetchone())
    by = {l["description"].rsplit(" (", 1)[0]: l for l in p["lines"]}
    for desc in expect.values():
        assert desc in by
    assert by["Paint walls (2 coats)"]["qty"] == pytest.approx(round(wall, 2))
    assert by["Lay flooring"]["qty"] == pytest.approx(15.12)
    assert by["Skirting / scotia"]["qty"] == math.ceil((2 * (L + W) - 0.82) * 1.1 / 5.4)
    assert by["Paint doors (both sides)"]["qty"] == 1
    # the quote: made, its PDF has the measurements page with the floor plan, drawn (no pictures)
    r = c.post(f"/estimate/{tid}/quote")
    assert r.status_code == 302
    from riyeser import pdf as pdfmod
    with app.app_context():
        did = get_db().execute("SELECT document_id FROM takeoffs WHERE id=?", (tid,)).fetchone()[0]
        data = pdfmod.document_pdf(get_db(), did)
    assert data[:5] == b"%PDF-" and b"/Subtype /Image" not in data and b"/Subtype/Image" not in data
    with app.app_context():
        c.post(f"/estimate/{tid}/summary", data={})
        assert len(pdfmod.document_pdf(get_db(), did)) < len(data)


def test_mesh_rooms_are_marked_estimates_on_the_quote(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    tid, s = _import(c, "polycam.obj", sample.write_obj(sample.room_mesh()))
    assert s["quality"] == "mesh" and "check on site" in s["quality_text"]
    assert c.post(s["urls"]["rooms"], json={"rooms": s["rooms"]}).get_json()["ok"]
    page = c.get(f"/estimate/{tid}/measure?m=scan").get_data(as_text=True)
    assert "polycam.obj" in page
    c.post(f"/estimate/{tid}/template", data={"template_id": str(_template_id(app, "painting"))})
    c.post(f"/estimate/{tid}/quote")
    doc = _one(app, "SELECT d.notes FROM documents d JOIN takeoffs t ON t.document_id=d.id WHERE t.id=?", (tid,))
    assert "estimated from a 3D scan" in doc["notes"]
    from riyeser.measure.drawing import summary_rows
    with app.app_context():
        from riyeser.measure import store
        rows = summary_rows(store.items_of(get_db(), tid), "metric")
    assert rows[0][1] == "3D scan (estimate)"


def test_bad_rooms_are_refused_and_scans_removed(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    tid, s = _import(c, "room.json", json.dumps(sample.capturedroom_json()).encode())
    bad = json.loads(json.dumps(s["rooms"]))
    bad[0]["height"] = -1
    r = c.post(s["urls"]["rooms"], json={"rooms": bad})
    assert r.status_code == 400 and "ceiling height" in r.get_json()["error"]
    assert c.post(s["urls"]["rooms"], json={"rooms": []}).status_code == 400
    c.post(s["urls"]["rooms"], json={"rooms": s["rooms"]})
    assert c.get(s["urls"]["file"]).data == json.dumps(sample.capturedroom_json()).encode()
    r = c.post(f"/estimate/{tid}/scans", data={"file": (io.BytesIO(b"Kaydara FBX"), "x.fbx")}, content_type="multipart/form-data")
    assert r.status_code == 400 and "GLB" in r.get_json()["error"]
    # a PDF plan goes to the plan tool
    r = c.post(f"/estimate/{tid}/scans", data={"file": (io.BytesIO(b"%PDF-1.4 plan"), "plan.pdf")}, content_type="multipart/form-data")
    assert r.get_json()["pdf"] and r.get_json()["redirect"].endswith("m=plan")
    assert _one(app, "SELECT COUNT(*) FROM takeoff_plans WHERE takeoff_id=?", (tid,))[0] == 1
    # duplicate copies the scan and points the rooms at the copy
    nid = int(c.post(f"/estimate/{tid}/duplicate").headers["Location"].split("/")[2])
    new_scan = _one(app, "SELECT id FROM takeoff_scans WHERE takeoff_id=?", (nid,))[0]
    d = json.loads(_one(app, "SELECT data FROM takeoff_items WHERE takeoff_id=?", (nid,))[0])
    assert d["scan_id"] == new_scan != s["id"]
    assert c.post(s["urls"]["delete"]).get_json()["ok"]
    assert _one(app, "SELECT COUNT(*) FROM takeoff_items WHERE takeoff_id=?", (tid,))[0] == 0
    assert c.post(f"/estimate/{tid}/delete").status_code == 302


def test_scan_upload_is_read_only_after_the_trial(tmp_path, monkeypatch):
    from riyeser.measure import licence as ML
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c)
    monkeypatch.setattr(ML, "touch", lambda: {"mode": "expired"})
    r = c.post(f"/estimate/{tid}/scans", data={"file": (io.BytesIO(sample.write_glb(sample.room_parts())), "a.glb")},
               content_type="multipart/form-data")
    assert r.status_code == 402


# ---------------------------------------------------------------- the floor plan, the 3D model and the screens
def test_floor_plan_svg_has_walls_doors_windows_sizes_names():
    res = scan.read("plan.dxf", sample.write_dxf())
    items = [{"kind": "room", "id": i, "label": r["name"], "data": dict(r, scan_id=1)} for i, r in enumerate(res["rooms"])]
    items.append({"kind": "room", "id": 9, "label": "Hall", "data": {"length": 3, "width": 1.2, "height": 2.4,
                                                                    "openings": [{"kind": "door", "width": 0.82, "height": 2.04}]}})
    items.append({"kind": "rect", "id": 10, "label": "Deck", "data": {"length": 3, "width": 2}})   # not a room
    s = floorplan.svg(items, "metric")
    assert s.startswith("<svg") and s.count('class="wall"') == 12
    assert s.count('class="door"') == 2 and s.count('class="window"') == 3   # a window: 3 lines
    for text in ("Bedroom", "Bathroom", "Hall", "15.12 m²", "8.64 m²", "3.6 m", "4.2 m", "1 m"):
        assert text in s
    assert "Deck" not in s and "<image" not in s
    imp = floorplan.svg(items, "imperial")
    assert "sq ft" in imp and "ft" in imp and "5 ft" in imp
    lay = floorplan.layout(items)
    bed = next(r for r in lay["rooms"] if r["label"] == "Bedroom")
    bath = next(r for r in lay["rooms"] if r["label"] == "Bathroom")
    # rooms from one plan keep their places: the bathroom is 0.1 m (a wall) right of the bedroom
    assert min(p[0] for p in bath["outline"]) - max(p[0] for p in bed["outline"]) == pytest.approx(0.1)
    assert floorplan.svg([], "metric") is None


def test_measure_screen_3d_model_and_floor_plan(tmp_path, monkeypatch):
    app, c = est(tmp_path, monkeypatch)
    tid = _new_estimate(c)
    assert c.post(f"/estimate/{tid}/how", data={"method": "scan"}).headers["Location"].endswith(f"/estimate/{tid}/measure")
    how = c.get(f"/estimate/{tid}/how").get_data(as_text=True)
    assert 'value="scan"' in how and "Coming later" not in how
    page = c.get(f"/estimate/{tid}/measure").get_data(as_text=True)
    assert 'id="scanfile"' in page and "vendor/three/three.module.min.js" in page and "measure/scan.js" in page
    assert c.get(f"/estimate/{tid}/floorplan.svg").status_code == 404     # nothing measured yet
    _tid, s = tid, _import(c, "a.glb", sample.write_glb(sample.room_parts()))[1]
    tid2 = s["urls"]["rooms"].split("/")[2]
    c.post(s["urls"]["rooms"], json={"rooms": s["rooms"]})
    m = c.get(f"/estimate/{tid2}/model.json").get_json()
    assert len(m["rooms"]) == 1 and len(m["rooms"][0]["walls"]) == 4 and m["rooms"][0]["walls"][0]["text"] == "4.2 m"
    assert {o["kind"] for o in m["rooms"][0]["openings"]} == {"door", "window"} and m["meshes"]
    mesh = c.get(m["meshes"][0]["url"])
    assert mesh.status_code == 200 and len(mesh.data) % 36 == 0
    fp = c.get(f"/estimate/{tid2}/floorplan.svg")
    assert fp.status_code == 200 and fp.mimetype == "image/svg+xml"
    page = c.get(f"/estimate/{tid2}/measure?m=manual").get_data(as_text=True)
    assert 'id="floorplan"' in page and "Scanned room" in page and "<svg" in page    # the plan shows on every tab
    assert "Importing a scan" in c.get("/estimate/help").get_data(as_text=True)
    assert c.get("/estimate/scan-sample.glb").data[:4] == b"glTF"


def test_vendored_three_is_mit_and_offline():
    v = HERE.parent / "riyeser" / "static" / "vendor" / "three"
    assert "MIT License" in (v / "LICENSE").read_text()
    for f in ("three.module.min.js", "three.core.min.js", "addons/OrbitControls.js", "addons/CSS2DRenderer.js"):
        text = (v / f).read_text()
        assert "http://" not in text.replace("http://www.w3.org", "") or f.endswith("min.js")
    assert "three" in (HERE.parent / "riyeser" / "static" / "vendor" / "README.md").read_text()


def test_demo_has_a_scanned_room(tmp_path, monkeypatch):
    from riyeser.demo import seed_demo
    app, c = est(tmp_path, monkeypatch)
    with app.app_context():
        db = get_db()
        db.execute("DELETE FROM items")
        seed_demo(db)
        row = db.execute("SELECT * FROM takeoffs WHERE title LIKE '%sample scan%'").fetchone()
        assert row and row["method"] == "scan"
        assert db.execute("SELECT COUNT(*) FROM takeoff_scans WHERE takeoff_id=?", (row["id"],)).fetchone()[0] == 1
    tot = {t["key"]: t["text"] for t in c.get(f"/estimate/{row['id']}/items").get_json()["totals"]}
    assert tot["floor_area"] == f"{5.2 * 4.1:.2f} m²"
    assert c.get(f"/estimate/{row['id']}/measure?m=scan").status_code == 200
