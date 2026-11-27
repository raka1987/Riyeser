"""Apple RoomPlan: full rooms (walls, doors, windows and openings with their real sizes).

Two ways in:
  * the USDZ RoomPlan exports (CapturedRoom.export, and apps built on RoomPlan): each element is a named prim (Wall0,
    Door0, Window0, Opening0, Floor0) holding a box, so its size is the box's size. The same naming is recognised in
    GLB/OBJ/DAE files converted from a RoomPlan scan.
  * the CapturedRoom (or CapturedStructure) JSON that RoomPlan apps can save (Swift's Codable): walls / doors /
    windows / openings / floors with `dimensions` [width, height, depth] in metres and `transform`, a 4x4 matrix as
    16 numbers, column by column (the position is numbers 13 to 15). Y is up.
"""
import math
import re

from .meshes import ScanError
from . import rooms as R

KINDS = (("window", "window"), ("door", "door"), ("opening", "other"), ("wall", "wall"), ("floor", "floor"))
GROUPS = ("_grp", "grp", "_group", "group", "s", "_s")


def _category(seg):
    """'Wall3' -> 'wall', 'Door_1' -> 'door'; groups ('Wall_grp', 'Walls') are not elements."""
    s = seg.lower()
    for word, kind in KINDS:
        if s.startswith(word):
            return None if s[len(word):] in GROUPS else kind
    return None


def element_of(path):
    """('wall', 'Wall3' element path) for a part path inside a RoomPlan-style element, else None."""
    segs = [s for s in path.split("/") if s]
    hit = None
    for i, s in enumerate(segs):
        k = _category(s)
        if k:
            hit = (k, "/".join(segs[: i + 1]))
    return hit


def room_key(path):
    m = re.search(r"(?:^|/)(room|structure|section)[_ ]?(\d+)(?:/|$)", path, re.I)
    return m.group(0).strip("/") if m else ""


def is_parametric(scene):
    walls = {element_of(p.name)[1] for p in scene.parts if element_of(p.name) and element_of(p.name)[0] == "wall"}
    return len(walls) >= 3


def from_scene(scene, default_name="Scanned room"):
    """Rooms from a RoomPlan-style scene (Y-up metres)."""
    groups = {}
    for p in scene.parts:
        e = element_of(p.name)
        if not e:
            continue
        key = room_key(p.name)
        el = groups.setdefault(key, {}).setdefault(e[1], {"kind": e[0], "pts": []})
        el["pts"].extend((p.pos[i], p.pos[i + 1], p.pos[i + 2]) for i in range(0, len(p.pos), 3))
    out = []
    for n, (key, els) in enumerate(sorted(groups.items())):
        walls, ops, floors = [], [], []
        for el in els.values():
            if len(el["pts"]) < 3:
                continue
            box = R.oriented_box(el["pts"])
            if el["kind"] == "wall":
                walls.append(box)
            elif el["kind"] == "floor":
                floors.append(el["pts"])    # the floor box is the room's footprint: the outline gives the same area
            else:
                ops.append((el["kind"], box))
        if len(walls) < 3:
            continue
        floor_y = min(w["bottom"] for w in walls)
        height = max(w["top"] for w in walls) - floor_y
        segs = []
        for w in walls:
            c, u, L = w["centre"], w["dir"], w["length"]
            segs.append(((c[0] - u[0] * L / 2, c[1] - u[1] * L / 2), (c[0] + u[0] * L / 2, c[1] + u[1] * L / 2),
                         w["top"] - w["bottom"]))
        corners, heights, closed, extra = R.chain_walls(segs)
        openings = [{"kind": k, "width": b["length"], "height": b["top"] - b["bottom"], "sill": b["bottom"] - floor_y,
                     "centre": b["centre"], "direction": b["dir"]} for k, b in ops]
        name = _name(key, n, len(groups), default_name)
        out.append(R.make_room(name, corners, heights, height, openings, closed=closed, extra_walls=extra))
    return out


def _name(key, n, total, default):
    if key and total > 1:
        return key.replace("_", " ").title()
    return default if total == 1 else f"{default} {n + 1}"


# ---------------------------------------------------------------- CapturedRoom JSON
def _matrix(t):
    """16 numbers (column by column) or 4 columns -> (x axis, position) on the plan, and the height of the middle."""
    if isinstance(t, dict):
        t = t.get("columns") or t.get("matrix") or []
    flat = [float(v) for col in t for v in (col if isinstance(col, (list, tuple)) else [col])]
    if len(flat) != 16:
        raise ScanError("A RoomPlan transform should have 16 numbers.")
    return (flat[0], flat[2]), (flat[12], flat[14]), flat[13]


def _dims(d):
    if isinstance(d, dict):
        d = [d.get("x", 0), d.get("y", 0), d.get("z", 0)]
    return [float(v) for v in d][:3]


def _surface(s):
    ax, pos, ymid = _matrix(s.get("transform"))
    w, h = _dims(s.get("dimensions"))[:2]
    L = math.hypot(*ax) or 1.0
    u = (ax[0] / L, ax[1] / L)
    return {"centre": pos, "dir": u, "length": w, "height": h, "bottom": ymid - h / 2, "top": ymid + h / 2,
            "curved": bool(s.get("curve")), "id": s.get("identifier"), "parent": s.get("parentIdentifier")}


def looks_like_capturedroom(js):
    if isinstance(js, dict):
        if isinstance(js.get("walls"), list):
            return True
        if isinstance(js.get("rooms"), list) and js["rooms"] and isinstance(js["rooms"][0], dict) and "walls" in js["rooms"][0]:
            return True
    return False


def from_json(js, default_name="Scanned room"):
    rooms = js.get("rooms") if isinstance(js.get("rooms"), list) and js.get("rooms") else [js]
    out = []
    for n, r in enumerate(rooms):
        walls = [_surface(w) for w in r.get("walls") or []]
        if len(walls) < 3:
            continue
        floor_y = min(w["bottom"] for w in walls)
        height = max(w["top"] for w in walls) - floor_y
        segs = [((w["centre"][0] - w["dir"][0] * w["length"] / 2, w["centre"][1] - w["dir"][1] * w["length"] / 2),
                 (w["centre"][0] + w["dir"][0] * w["length"] / 2, w["centre"][1] + w["dir"][1] * w["length"] / 2),
                 w["height"]) for w in walls]
        corners, heights, closed, extra = R.chain_walls(segs)
        ops = []
        for key, kind in (("doors", "door"), ("windows", "window"), ("openings", "other")):
            for o in r.get(key) or []:
                s = _surface(o)
                ops.append({"kind": kind, "width": s["length"], "height": s["height"], "sill": s["bottom"] - floor_y,
                            "centre": s["centre"], "direction": s["dir"]})
        area = None
        for f in r.get("floors") or []:    # iOS 17+: the floor's corners, in the floor's own space
            pc = f.get("polygonCorners") or []
            if len(pc) >= 3:
                t = f.get("transform")
                flat = [float(v) for col in t for v in (col if isinstance(col, (list, tuple)) else [col])]
                pts = []
                for c in pc:
                    x, y, z = (_dims(c) + [0, 0, 0])[:3]
                    wx = flat[0] * x + flat[4] * y + flat[8] * z + flat[12]
                    wz = flat[2] * x + flat[6] * y + flat[10] * z + flat[14]
                    pts.append((wx, wz))
                area = (area or 0) + R.polygon_area(pts)
        label = None
        secs = [s for s in r.get("sections") or [] if isinstance(s, dict)]
        if len(secs) == 1:
            lab = secs[0].get("label")
            label = next(iter(lab)) if isinstance(lab, dict) and lab else lab if isinstance(lab, str) else None
        name = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", label or "").replace("_", " ").capitalize() or (default_name if len(rooms) == 1 else f"{default_name} {n + 1}")
        note = "Curved walls are measured straight, end to end." if any(w["curved"] for w in walls) else ""
        out.append(R.make_room(name, corners, heights, height, ops, floor_area=area, note=note, closed=closed,
                               extra_walls=extra))
    if not out:
        raise ScanError("That RoomPlan file has no walls in it.")
    return out
