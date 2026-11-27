"""Measurement geometry. All inputs and outputs are SI (metres, m², m³) unless said otherwise.

A measurement ("item") has a kind and its data. item_quantities() turns one into named quantities, and
takeoff_quantities() adds up a whole takeoff (sharing roof edges between faces so a hip is counted once).

Kinds:
  room      length, width, height, openings [{kind: door|window|other, width, height, count}]; or, for a room of
            any shape (an imported scan or plan): walls [{length, height?, open?, extra?}], outline [[x, y]...],
            floor_area? (else the outline's area), height, openings (each may name its wall and offset)
  rect      length, width (depth -> volume)          circle    diameter (depth -> volume)
  triangle  base + height, or sides a, b, c          area      area typed in (depth -> volume)
  length    length (height -> face area, spacing -> count of posts/joists)
  count     count                                    hours     hours
  volume    length, width, depth (or area, depth)
  shape     drawn area: points (plan, with scale) or latlngs (map); holes are cut out; depth -> volume
  line      drawn length: points or latlngs
  markers   clicked counts: points
  roof      a roof face: points/latlngs or plan_area; pitch (deg, or rise/run); edges [ridge|hip|valley|eave|rake|...]
  fence     a fence run: points/latlngs or length; spacing (post spacing), gates [{width, count}], height, closed
The same maths is in riyeser/static/measure/geometry.js for the live figures while drawing (kept in step).
"""
import math

from .units import round_up

# ---------------------------------------------------------------- plane geometry
def ring_area(pts):
    """Shoelace area of a closed ring [(x, y), ...] (always positive)."""
    n = len(pts)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def path_lengths(pts, closed=False):
    """Each segment's length along [(x, y), ...]."""
    out = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    if closed and len(pts) > 2:
        out.append(math.dist(pts[-1], pts[0]))
    return out


def polygon_area(outer, holes=()):
    """Area of a polygon with cut-outs (holes): outer minus each hole, never below 0."""
    return max(0.0, ring_area(outer) - sum(ring_area(h) for h in holes or ()))


# ---------------------------------------------------------------- map (latitude / longitude)
WGS84_A = 6378137.0
WGS84_E2 = 0.00669437999014


def local_xy(latlngs, origin=None):
    """Latitude/longitude -> metres on a flat plane touching the earth at `origin` (default: the points' centre).
    Uses the WGS84 ellipsoid's radii at that latitude: well within 0.1% for a job-sized area (a few km across)."""
    if not latlngs:
        return []
    lat0, lng0 = origin or (sum(p[0] for p in latlngs) / len(latlngs), sum(p[1] for p in latlngs) / len(latlngs))
    phi = math.radians(lat0)
    w = 1 - WGS84_E2 * math.sin(phi) ** 2
    m_radius = WGS84_A * (1 - WGS84_E2) / w ** 1.5      # north-south
    n_radius = WGS84_A / math.sqrt(w)                     # east-west
    return [(math.radians(lng - lng0) * n_radius * math.cos(phi), math.radians(lat - lat0) * m_radius)
            for lat, lng in latlngs]


def _plane(data):
    """(outer ring, holes, scale) in metres-on-the-ground for a drawn shape, from map or plan coordinates."""
    if data.get("latlngs"):
        ll = [tuple(p) for p in data["latlngs"]]
        allp = ll + [tuple(p) for h in data.get("holes") or () for p in h]
        n = len(allp)
        origin = (sum(p[0] for p in allp) / n, sum(p[1] for p in allp) / n)
        return local_xy(ll, origin), [local_xy([tuple(p) for p in h], origin) for h in data.get("holes") or ()]
    s = float(data.get("scale") or 0)    # metres per drawing unit (set by "Set scale")
    outer = [(p[0] * s, p[1] * s) for p in data.get("points") or ()]
    holes = [[(p[0] * s, p[1] * s) for p in h] for h in data.get("holes") or ()]
    return outer, holes


# ---------------------------------------------------------------- roofs
EDGE_TYPES = ("ridge", "hip", "valley", "eave", "rake", "flashing")
EDGE_LABELS = {"ridge": "Ridge", "hip": "Hip", "valley": "Valley", "eave": "Eave / gutter", "rake": "Rake / barge",
               "flashing": "Wall flashing"}


def pitch_degrees(pitch):
    """pitch: {'deg': 22.5} or {'rise': 6, 'run': 12} (US "6/12") or a plain number of degrees."""
    if pitch is None or pitch == "":
        return 0.0
    if isinstance(pitch, (int, float)):
        return float(pitch)
    if pitch.get("rise") not in (None, "") and float(pitch.get("run") or 0) > 0:
        return math.degrees(math.atan(float(pitch["rise"]) / float(pitch["run"])))
    return float(pitch.get("deg") or 0)


def pitch_factor(deg):
    """True (sloped) area = plan area x this. 1/cos(pitch): 15° 1.035, 22.5° 1.082, 30° 1.155, 45° 1.414."""
    if deg >= 89.9 or deg < 0:
        raise ValueError("A roof pitch must be between 0° and 89°.")
    return 1.0 / math.cos(math.radians(deg))


def hip_factor(deg):
    """A hip or valley between two faces of the same pitch: plan length x sqrt(1 + tan²(pitch) / 2)."""
    return math.sqrt(1 + math.tan(math.radians(deg)) ** 2 / 2)


def edge_true_length(kind, plan_len, deg):
    if kind == "rake":
        return plan_len * pitch_factor(deg)
    if kind in ("hip", "valley"):
        return plan_len * hip_factor(deg)
    return plan_len    # ridges, eaves (gutters) and flashings are level in plan


# ---------------------------------------------------------------- rooms
def room(length, width, height=0.0, openings=()):
    """Floor, ceiling, walls (gross and less doors and windows), perimeter and skirting for a rectangular room."""
    L, W, H = float(length or 0), float(width or 0), float(height or 0)
    floor = L * W
    perim = 2 * (L + W)
    gross = perim * H
    opening_area = door_width = 0.0
    doors = windows = 0
    for o in openings or ():
        n = int(float(o.get("count") or 1))
        ow, oh = float(o.get("width") or 0), float(o.get("height") or 0)
        opening_area += ow * oh * n
        if o.get("kind") == "door":
            doors += n
            door_width += ow * n
        elif o.get("kind") == "window":
            windows += n
    return {"floor_area": floor, "ceiling_area": floor, "perimeter": perim, "wall_area_gross": gross,
            "openings_area": min(opening_area, gross), "wall_area": max(0.0, gross - opening_area),
            "skirting": max(0.0, perim - door_width), "doors": doors, "windows": windows}


def room_of_walls(walls, height=0.0, openings=(), floor_area=None, outline=None):
    """A room of any shape: each wall's length (and its own height, when it differs from the room's). Walls marked
    open (a side with no wall) don't count; extra walls (standing inside the room) count for wall area only.
    Floor = floor_area when given, else the outline's area."""
    H = float(height or 0)
    perim = gross = 0.0
    for w in walls or ():
        if w.get("open"):
            continue
        L = float(w.get("length") or 0)
        h = float(w.get("height") or H)
        gross += L * h
        if not w.get("extra"):
            perim += L
    if floor_area not in (None, ""):
        floor = float(floor_area)
    else:
        floor = ring_area([tuple(p) for p in outline or ()])
    q = room(0, 0, 0, openings)
    ops = sum(float(o.get("width") or 0) * float(o.get("height") or 0) * int(float(o.get("count") or 1))
              for o in openings or ())
    q.update(floor_area=floor, ceiling_area=floor, perimeter=perim, wall_area_gross=gross,
             openings_area=min(ops, gross), wall_area=max(0.0, gross - ops),
             skirting=max(0.0, perim - sum(float(o.get("width") or 0) * int(float(o.get("count") or 1))
                                           for o in openings or () if o.get("kind") == "door")))
    return q


# ---------------------------------------------------------------- fences
def fence_posts(segments, spacing, gates=0, closed=False):
    """Posts for a fence along these runs: each straight run needs ceil(run / spacing) bays, a post at every bay end
    (corner posts shared), plus one extra post per gate (the gate's hanging post). An editable rule of thumb."""
    spacing = float(spacing or 0)
    segs = [s for s in segments if s > 0]
    if spacing <= 0 or not segs:
        return 0
    bays = sum(round_up(s / spacing) for s in segs)
    return bays + (0 if closed else 1) + int(gates or 0)


# ---------------------------------------------------------------- one measurement
def _f(d, k, default=0.0):
    v = d.get(k)
    try:
        return float(v) if v not in (None, "") else default
    except (TypeError, ValueError):
        return default


def item_quantities(kind, data):
    """{quantity name: SI amount} for one measurement. Roof faces also return '_edges' for takeoff_quantities()."""
    d = data or {}
    q = {}
    depth = _f(d, "depth")
    if kind == "room" and d.get("walls"):
        q.update(room_of_walls(d["walls"], _f(d, "height"), d.get("openings") or (), d.get("floor_area"), d.get("outline")))
    elif kind == "room":
        q.update(room(_f(d, "length"), _f(d, "width"), _f(d, "height"), d.get("openings") or ()))
    elif kind in ("rect", "circle", "triangle", "area"):
        if kind == "rect":
            a, p = _f(d, "length") * _f(d, "width"), 2 * (_f(d, "length") + _f(d, "width"))
        elif kind == "circle":
            dia = _f(d, "diameter") or 2 * _f(d, "radius")
            a, p = math.pi * dia * dia / 4, math.pi * dia
        elif kind == "triangle":
            if d.get("a") not in (None, ""):
                x, y, z = _f(d, "a"), _f(d, "b"), _f(d, "c")
                s = (x + y + z) / 2
                a, p = math.sqrt(max(0.0, s * (s - x) * (s - y) * (s - z))), x + y + z
            else:
                a, p = _f(d, "base") * _f(d, "height") / 2, 0.0
        else:
            a, p = _f(d, "area"), _f(d, "perimeter")
        q["area"] = a
        if p:
            q["perimeter"] = p
    elif kind == "length":
        L = _f(d, "length")
        q["length"] = L
        if _f(d, "height"):
            q["face_area"] = L * _f(d, "height")
        if _f(d, "spacing"):
            q["count"] = round_up(L / _f(d, "spacing")) + 1
    elif kind == "count":
        q["count"] = _f(d, "count")
    elif kind == "hours":
        q["hours"] = _f(d, "hours")
    elif kind == "volume":
        base = _f(d, "area") or _f(d, "length") * _f(d, "width")
        q["volume"] = base * depth
        q["area"] = base
        depth = 0.0
    elif kind == "shape":
        outer, holes = _plane(d)
        q["area"] = polygon_area(outer, holes)
        q["perimeter"] = sum(path_lengths(outer, closed=True))
    elif kind == "line":
        pts, _h = _plane(d)
        q["length"] = sum(path_lengths(pts, closed=bool(d.get("closed"))))
        if _f(d, "height"):
            q["face_area"] = q["length"] * _f(d, "height")
    elif kind == "markers":
        q["count"] = float(len(d.get("points") or d.get("latlngs") or ()))
    elif kind == "roof":
        deg = pitch_degrees(d.get("pitch"))
        k = pitch_factor(deg)
        if d.get("points") or d.get("latlngs"):
            outer, holes = _plane(d)
            plan = polygon_area(outer, holes)
            segs = path_lengths(outer, closed=True)
            raw = d.get("latlngs") or d.get("points")
            edges = []
            types = d.get("edges") or []
            for i, L in enumerate(segs):
                t = types[i] if i < len(types) else None
                if t in EDGE_TYPES:
                    a, b = raw[i], raw[(i + 1) % len(raw)]
                    key = (d.get("page"),) + tuple(sorted([tuple(round(v, 7) for v in a), tuple(round(v, 7) for v in b)]))
                    edges.append((key, t, edge_true_length(t, L, deg)))
            q["_edges"] = edges
        else:
            plan = _f(d, "plan_area")
            for t in EDGE_TYPES:   # typed-in edge lengths are plan lengths too
                if _f(d, t):
                    q[t] = edge_true_length(t, _f(d, t), deg)
        q["roof_plan_area"] = plan
        q["roof_area"] = plan * k
        q["pitch_deg"] = deg
        q["pitch_factor"] = k
    elif kind == "fence":
        if d.get("points") or d.get("latlngs"):
            pts, _h = _plane(d)
            segs = path_lengths(pts, closed=bool(d.get("closed")))
        else:
            segs = [_f(d, "length")]
        total = sum(segs)
        gates = d.get("gates") or []
        n_gates = sum(int(float(g.get("count") or 1)) for g in gates)
        gate_width = sum(_f(g, "width") * int(float(g.get("count") or 1)) for g in gates)
        q["fence_length"] = total
        q["panel_length"] = max(0.0, total - gate_width)
        q["gates"] = n_gates
        q["posts"] = fence_posts(segs, _f(d, "spacing"), n_gates, bool(d.get("closed"))) + int(_f(d, "corners"))
        if _f(d, "height"):
            q["face_area"] = q["panel_length"] * _f(d, "height")
    else:
        raise ValueError(f"Unknown measurement kind: {kind}")
    if depth and "area" in q:
        q["volume"] = q["area"] * depth
    alias = AS.get(d.get("as") or "")
    if alias:   # "measure as": a drawn area counted as floor (or wall, ceiling), a line as gutter (eave), skirting...
        src = QUANTITIES[alias][1]   # area, length or count
        if src == "area" and "area" not in q:
            src = "face_area"         # a wall drawn as a length with a height
        if src in q and alias not in q:
            q[alias] = q[src]
    return q


# What a drawn or typed area, length or count can also count as (so one template works for rooms and plan drawings)
AS = {"floor": "floor_area", "wall": "wall_area", "ceiling": "ceiling_area",
      "eave": "eave", "ridge": "ridge", "hip": "hip", "valley": "valley", "rake": "rake", "flashing": "flashing",
      "skirting": "skirting", "perimeter": "perimeter", "doors": "doors", "windows": "windows"}
AS_LABELS = {"": "Just itself", "floor": "Floor area", "wall": "Wall area", "ceiling": "Ceiling area",
             "eave": "Eaves / gutters", "ridge": "Ridge", "hip": "Hip", "valley": "Valley", "rake": "Rake / barge",
             "flashing": "Wall flashing", "skirting": "Skirting / trim", "perimeter": "Perimeter (edging, formwork)",
             "doors": "Doors", "windows": "Windows"}


# what each quantity is, for screens, templates and the PDF summary: name -> (label, dimension)
QUANTITIES = {
    "area": ("Area", "area"), "perimeter": ("Perimeter", "length"), "length": ("Length", "length"),
    "count": ("Count", "count"), "volume": ("Volume", "volume"), "hours": ("Hours", "hours"),
    "face_area": ("Face area (length x height)", "area"),
    "floor_area": ("Floor area", "area"), "ceiling_area": ("Ceiling area", "area"),
    "wall_area": ("Wall area (less doors and windows)", "area"), "wall_area_gross": ("Wall area (gross)", "area"),
    "openings_area": ("Doors and windows area", "area"), "skirting": ("Skirting / trim", "length"),
    "doors": ("Doors", "count"), "windows": ("Windows", "count"),
    "roof_area": ("Roof area (true, pitch applied)", "area"), "roof_plan_area": ("Roof plan area", "area"),
    "ridge": ("Ridge", "length"), "hip": ("Hips", "length"), "valley": ("Valleys", "length"),
    "eave": ("Eaves / gutters", "length"), "rake": ("Rakes / barges", "length"), "flashing": ("Wall flashing", "length"),
    "fence_length": ("Fence length", "length"), "panel_length": ("Fence length less gates", "length"),
    "posts": ("Posts", "count"), "gates": ("Gates", "count"),
}
SUMMED = tuple(QUANTITIES)


def takeoff_quantities(items):
    """Add up measurements: [{'kind', 'data', 'group'?}] -> {quantity: total}. Roof edges drawn on two faces (a hip
    between them) count once. Items can be filtered by group before calling."""
    tot = {k: 0.0 for k in SUMMED}
    seen = {}
    for it in items:
        q = item_quantities(it["kind"], it.get("data") or {})
        for key, t, L in q.pop("_edges", ()):
            if (key, t) not in seen or seen[(key, t)] < L:
                seen[(key, t)] = L
        for k, v in q.items():
            if k in tot:
                tot[k] += v
    for (key, t), L in seen.items():
        tot[t] += L
    return {k: v for k, v in tot.items() if v}
