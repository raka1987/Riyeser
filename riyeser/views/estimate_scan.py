"""Riyeser Estimate: Import a scan (step 2's fourth card), the rooms it gives, the 3D mock-up and the floor plan.

  POST /estimate/<tid>/scans                    upload a scan or plan file: kept with the estimate, read into rooms
  GET  /estimate/<tid>/scans/<sid>              what was read (the rooms before editing, notes, what kind of result)
  POST /estimate/<tid>/scans/<sid>/rooms        the rooms as edited: they replace that scan's room measurements
  GET  /estimate/<tid>/scans/<sid>/file         the original file;  .../mesh.bin  the mesh for the 3D view
  POST /estimate/<tid>/scans/<sid>/delete       remove the scan and its rooms
  GET  /estimate/<tid>/model.json               every room, laid out as on the floor plan, for the 3D view
  GET  /estimate/<tid>/floorplan.svg            the automatic floor plan
  GET  /estimate/scan-sample.glb                a sample RoomPlan-style scan to try it with
"""
import json
import math

from flask import request, jsonify, url_for, Response, abort

from ..db import get_db, audit
from ..measure import floorplan, scan as S, geometry as G
from ..measure.scan import sample as SAMPLE
from .estimate import bp, _t, _units, _touch, _api_error, item_view, totals_view, COLORS, MAX_PLAN_BYTES
from ..measure import store

KINDS = ("door", "window", "other")


def _scan(tid, sid):
    r = get_db().execute("SELECT * FROM takeoff_scans WHERE id=? AND takeoff_id=?", (sid, tid)).fetchone()
    if not r:
        abort(404)
    return r


def scan_view(r):
    res = json.loads(r["result"] or "{}")
    return {"id": r["id"], "name": r["name"], "format": r["format"], "quality": r["quality"], "size": r["size"],
            "quality_text": S.QUALITY.get(r["quality"], ""), "notes": res.get("notes") or [], "rooms": res.get("rooms") or [],
            "created_at": r["created_at"], "has_mesh": r["preview"] is not None,
            "urls": {"self": url_for("estimate.scan_get", tid=r["takeoff_id"], sid=r["id"]),
                     "rooms": url_for("estimate.scan_rooms", tid=r["takeoff_id"], sid=r["id"]),
                     "file": url_for("estimate.scan_file", tid=r["takeoff_id"], sid=r["id"]),
                     "mesh": url_for("estimate.scan_mesh", tid=r["takeoff_id"], sid=r["id"]),
                     "delete": url_for("estimate.scan_delete", tid=r["takeoff_id"], sid=r["id"])}}


def scans_of(db, tid):
    return [scan_view(r) for r in db.execute("SELECT * FROM takeoff_scans WHERE takeoff_id=? ORDER BY id", (tid,))]


@bp.route("/<int:tid>/scans", methods=["POST"])
def scan_upload(tid):
    db = get_db()
    t = _t(tid)
    f = request.files.get("file")
    if not f or not f.filename:
        return _api_error("Choose a scan or floor plan file.")
    data = f.read(S.MAX_BYTES + 1)
    if len(data) > S.MAX_BYTES:
        return _api_error("That file is over 100 MB, the most an estimate keeps. Export the scan at a lower detail "
                          "(in Polycam: Medium or Reduced), or export the floor plan (DXF) instead.", 413)
    name = f.filename.replace("\\", "/").rsplit("/", 1)[-1][:120]
    try:
        res = S.read(name, data, system=_units(t))
    except S.ScanError as e:
        return _api_error(str(e))
    except (ValueError, KeyError, IndexError, TypeError, OverflowError, MemoryError, RecursionError) as e:
        return _api_error(f"Riyeser couldn't read that file ({type(e).__name__}). Export it again from the app, or in "
                          "another format (the help page lists them).")
    if res["pdf"]:    # a PDF plan: open it on the plan tool to set its scale and draw
        if len(data) > MAX_PLAN_BYTES:
            return _api_error("That PDF is over 40 MB. Save a smaller copy and try again.", 413)
        pid = db.execute("INSERT INTO takeoff_plans (takeoff_id, name, mime, data, pages) VALUES (?,?,?,?,1)",
                         (tid, name, "application/pdf", data)).lastrowid
        _touch(tid)
        db.commit()
        return jsonify({"ok": True, "pdf": True, "plan_id": pid, "message": res["notes"][0],
                        "redirect": url_for("estimate.measure", tid=tid, m="plan")})
    sid = db.execute("INSERT INTO takeoff_scans (takeoff_id, name, format, quality, size, data, preview, result)"
                     " VALUES (?,?,?,?,?,?,?,?)", (tid, name, res["format"], res["quality"], len(data), data,
                                                   res["preview"], json.dumps({"rooms": res["rooms"], "notes": res["notes"]}))).lastrowid
    audit(db, "estimate_scan_imported", f"{t['title']}: {name} ({res['format']}, {len(res['rooms'])} rooms)")
    _touch(tid)
    db.commit()
    return jsonify({"ok": True, "scan": scan_view(_scan(tid, sid))})


@bp.route("/<int:tid>/scans/<int:sid>")
def scan_get(tid, sid):
    _t(tid)
    return jsonify({"ok": True, "scan": scan_view(_scan(tid, sid))})


@bp.route("/<int:tid>/scans/<int:sid>/file")
def scan_file(tid, sid):
    _t(tid)
    r = _scan(tid, sid)
    safe = "".join(c for c in (r["name"] or "scan") if c.isalnum() or c in "._- ") or "scan"
    return Response(r["data"], mimetype="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{safe}"', "X-Content-Type-Options": "nosniff"})


@bp.route("/<int:tid>/scans/<int:sid>/mesh.bin")
def scan_mesh(tid, sid):
    _t(tid)
    r = _scan(tid, sid)
    if r["preview"] is None:
        abort(404)
    return Response(r["preview"], mimetype="application/octet-stream", headers={"Cache-Control": "private, max-age=3600"})


def _num(v, what, lo=0.0, hi=1000.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} isn't a number.")
    if not (lo <= x <= hi) or math.isnan(x):
        raise ValueError(f"{what} doesn't look right ({x:g}).")
    return x


def clean_room(r, n):
    """A room from the editor -> safe data for a room measurement (SI)."""
    name = str(r.get("name") or f"Room {n}").strip()[:80] or f"Room {n}"
    h = _num(r.get("height"), f"{name}: the ceiling height", 0.5, 30)
    outline = [[_num(p[0], "A corner", -1e5, 1e5), _num(p[1], "A corner", -1e5, 1e5)] for p in (r.get("outline") or [])[:400]]
    walls = []
    for i, w in enumerate((r.get("walls") or [])[:400], 1):
        x = {"length": _num(w.get("length"), f"{name}: wall {i}'s length", 0, 500)}
        if w.get("height") not in (None, ""):
            x["height"] = _num(w.get("height"), f"{name}: wall {i}'s height", 0, 30)
        for flag in ("open", "extra"):
            if w.get(flag):
                x[flag] = True
        for k in ("a", "b"):
            if isinstance(w.get(k), list) and len(w[k]) == 2:
                x[k] = [_num(w[k][0], "A wall end", -1e5, 1e5), _num(w[k][1], "A wall end", -1e5, 1e5)]
        walls.append(x)
    if not walls:
        raise ValueError(f"{name} has no walls.")
    ops = []
    for o in (r.get("openings") or [])[:200]:
        kind = o.get("kind") if o.get("kind") in KINDS else "other"
        x = {"kind": kind, "width": _num(o.get("width"), f"{name}: a {kind}'s width", 0.05, 30),
             "height": _num(o.get("height"), f"{name}: a {kind}'s height", 0.05, 30),
             "count": int(_num(o.get("count") or 1, "How many", 1, 100))}
        if o.get("sill") not in (None, ""):
            x["sill"] = _num(o.get("sill"), f"{name}: a {kind}'s sill", 0, 30)
        if o.get("wall") not in (None, ""):
            x["wall"] = int(_num(o.get("wall"), "The wall", 0, 400))
            x["offset"] = _num(o.get("offset") or 0, "Where it is on the wall", 0, 500)
        ops.append(x)
    d = {"name": name, "height": h, "walls": walls, "openings": ops, "outline": outline,
         "estimated": bool(r.get("estimated"))}
    if r.get("floor_area") not in (None, ""):
        d["floor_area"] = _num(r.get("floor_area"), f"{name}: the floor area", 0, 1e5)
    if r.get("shape_known") is False:
        d["shape_known"] = False
    if r.get("note"):
        d["note"] = str(r["note"])[:300]
    q = G.item_quantities("room", d)
    if not q.get("floor_area") and not q.get("wall_area_gross"):
        raise ValueError(f"{name} has no size: check its walls and floor area.")
    return d


@bp.route("/<int:tid>/scans/<int:sid>/rooms", methods=["POST"])
def scan_rooms(tid, sid):
    """Use the (edited) rooms: they replace this scan's room measurements, so importing again doesn't double up."""
    db = get_db()
    t = _t(tid)
    r = _scan(tid, sid)
    body = request.get_json(silent=True) or {}
    try:
        rooms = [clean_room(x, n) for n, x in enumerate(body.get("rooms") or [], 1)]
    except ValueError as e:
        return _api_error(str(e))
    if not rooms:
        return _api_error("There are no rooms to add. Keep at least one.")
    for it in store.items_of(db, tid):
        if it["source"] == "scan" and (it["data"] or {}).get("scan_id") == sid:
            db.execute("DELETE FROM takeoff_items WHERE id=?", (it["id"],))
    n0 = db.execute("SELECT COALESCE(MAX(sort),0) FROM takeoff_items WHERE takeoff_id=?", (tid,)).fetchone()[0]
    for k, d in enumerate(rooms, 1):
        d["scan_id"] = sid
        d["scan_format"] = r["format"]
        db.execute("INSERT INTO takeoff_items (takeoff_id, kind, source, label, grp, color, data, verified, sort)"
                   " VALUES (?, 'room', 'scan', ?, NULL, ?, ?, 0, ?)",
                   (tid, d["name"], COLORS[(n0 + k - 1) % len(COLORS)], json.dumps(d), n0 + k))
    if not t["method"]:
        db.execute("UPDATE takeoffs SET method='scan' WHERE id=?", (tid,))
    _touch(tid)
    db.commit()
    items = store.items_of(db, tid)
    sys_ = _units(t)
    return jsonify({"ok": True, "items": [item_view(i, sys_) for i in items], "totals": totals_view(items, sys_),
                    "floorplan": floorplan.svg(items, sys_) or ""})


@bp.route("/<int:tid>/scans/<int:sid>/delete", methods=["POST"])
def scan_delete(tid, sid):
    db = get_db()
    _t(tid)
    _scan(tid, sid)
    for it in store.items_of(db, tid):
        if it["source"] == "scan" and (it["data"] or {}).get("scan_id") == sid:
            db.execute("DELETE FROM takeoff_items WHERE id=?", (it["id"],))
    db.execute("DELETE FROM takeoff_scans WHERE id=?", (sid,))
    _touch(tid)
    db.commit()
    return jsonify({"ok": True})


@bp.route("/<int:tid>/model.json")
def model(tid):
    """The rooms for the 3D mock-up, placed as on the floor plan (plan x, y -> 3D x, z; up is y)."""
    db = get_db()
    t = _t(tid)
    sys_ = _units(t)
    items = store.items_of(db, tid)
    lay = floorplan.layout(items, sys_)
    by_id = {i["id"]: i for i in items}
    rooms = []
    for r in lay["rooms"]:
        d = (by_id.get(r["id"]) or {}).get("data") or {}
        h = float(d.get("height") or 2.4)
        rooms.append({"id": r["id"], "label": r["label"], "color": r["color"], "outline": r["outline"], "height": h,
                      "walls": [{"length": float(w.get("length") or 0), "height": float(w.get("height") or h),
                                 "open": bool(w.get("open")), "text": None} for w in r["walls"][:len(r["outline"])]],
                      "openings": r.get("ops") or [], "area": r["area"], "estimated": r["estimated"],
                      "scan_id": d.get("scan_id"), "shift": r.get("shift") or (0, 0)})
    from ..measure import units as U
    for r in rooms:
        for w in r["walls"]:
            w["text"] = U.fmt(w["length"], "length", sys_)
        r["area_text"] = U.fmt(r["area"], "area", sys_)
    meshes = {}
    for r in rooms:
        if r["scan_id"] and r["scan_id"] not in meshes:
            row = db.execute("SELECT id FROM takeoff_scans WHERE id=? AND takeoff_id=? AND preview IS NOT NULL",
                             (r["scan_id"], tid)).fetchone()
            if row:
                meshes[r["scan_id"]] = {"url": url_for("estimate.scan_mesh", tid=tid, sid=row["id"]), "shift": r["shift"]}
    return jsonify({"ok": True, "rooms": rooms, "meshes": list(meshes.values()), "units": sys_})


@bp.route("/<int:tid>/floorplan.svg")
def floorplan_svg(tid):
    t = _t(tid)
    s = floorplan.svg(store.items_of(get_db(), tid), _units(t), title=f"Floor plan: {t['title']}")
    if not s:
        abort(404)
    return Response(s, mimetype="image/svg+xml", headers={"X-Content-Type-Options": "nosniff",
                                                           "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"})


@bp.route("/scan-sample.glb")
def scan_sample():
    """A sample room scan (made by Riyeser, RoomPlan-style) to try Import a scan with."""
    return Response(SAMPLE.write_glb(SAMPLE.room_parts()), mimetype="model/gltf-binary",
                    headers={"Content-Disposition": 'attachment; filename="riyeser-sample-room.glb"'})


__all__ = ["scans_of", "clean_room"]
