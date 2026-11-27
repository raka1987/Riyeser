"""Wall segments, doors and windows -> a room in Estimate's room model.

Plan coordinates are metres on the floor: x = the scan's X, y = the scan's Z (Y is up in every scan once it's
normalised), so the plan is seen from above. A room:

    {"name", "outline": [[x, y], ...],               corners, in order (wall i runs from corner i to corner i+1)
     "walls": [{"length", "height", "open"?}],         one per outline edge ("open": no wall there, e.g. an open side)
     "height",                                         ceiling height
     "floor_area"?,                                    when the scan measured the floor itself
     "openings": [{"kind": door|window|other, "width", "height", "sill", "wall", "offset", "count": 1}],
     "estimated": bool, "note"}

`offset` is from the wall's first corner to the opening's middle, along the wall.
"""
import math

from ..geometry import ring_area


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def _len(a):
    return math.hypot(a[0], a[1])


def line_intersection(p1, d1, p2, d2):
    """Where two lines (point, direction) cross, or None when they're (nearly) parallel."""
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 0.17 * _len(d1) * _len(d2):     # closer than ~10 degrees: treat as parallel
        return None
    t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den
    return (p1[0] + d1[0] * t, p1[1] + d1[1] * t)


def chain_walls(segs, tol=0.35):
    """[(a, b, height)] wall segments (in any order and direction) -> (corners, heights, closed, unused).

    Follows wall ends that meet (within tol metres), putting each corner where the two walls' lines cross."""
    if not segs:
        return [], [], False, []
    segs = [(tuple(a), tuple(b), h) for a, b, h in segs]
    used = {0}
    order = [(segs[0][0], segs[0][1], segs[0][2])]
    closed = False
    while True:
        end = order[-1][1]
        best, bi, flip = None, None, False
        for i, (a, b, _h) in enumerate(segs):
            if i in used:
                continue
            for p, fl in ((a, False), (b, True)):
                d = _len(_sub(p, end))
                if d < tol and (best is None or d < best):
                    best, bi, flip = d, i, fl
        if bi is None:
            if len(order) > 2 and _len(_sub(order[0][0], end)) < tol:
                closed = True
            break
        a, b, h = segs[bi]
        order.append((b, a, h) if flip else (a, b, h))
        used.add(bi)
    # corners: where consecutive walls cross
    n = len(order)
    corners = []
    for i in range(n):
        if i == 0 and not closed:
            corners.append(order[0][0])
            continue
        prev = order[i - 1]
        cur = order[i]
        x = line_intersection(prev[0], _sub(prev[1], prev[0]), cur[0], _sub(cur[1], cur[0]))
        corners.append(x if x else ((prev[1][0] + cur[0][0]) / 2, (prev[1][1] + cur[0][1]) / 2))
    heights = [w[2] for w in order]
    if not closed:
        corners.append(order[-1][1])     # the open end: the closing edge has no wall
        heights.append(None)
    unused = [segs[i] for i in range(len(segs)) if i not in used]
    return [list(map(float, c)) for c in corners], heights, closed, unused


def nearest_wall(outline, centre, direction=None, max_dist=0.6):
    """(wall index, offset along it, distance) of the outline edge nearest a point, or None."""
    best = None
    n = len(outline)
    for i in range(n):
        a, b = outline[i], outline[(i + 1) % n]
        ab = _sub(b, a)
        L = _len(ab)
        if L < 1e-6:
            continue
        u = (ab[0] / L, ab[1] / L)
        t = _dot(_sub(centre, a), u)
        tt = min(max(t, 0.0), L)
        d = _len(_sub(centre, (a[0] + u[0] * tt, a[1] + u[1] * tt)))
        if direction is not None:
            dl = _len(direction)
            if dl > 1e-9 and abs(_dot(direction, u)) / dl < 0.7:     # an opening runs along its wall
                d += 0.5
        if d <= max_dist and (best is None or d < best[2]):
            best = (i, min(max(t, 0.0), L), d)
    return best


def make_room(name, corners, heights, height, openings=(), floor_area=None, estimated=False, note="", closed=True,
              extra_walls=()):
    """Build the room dict. `heights` per edge (None: no wall on that edge). Openings: [{kind, width, height,
    sill, centre (plan xy), direction?}] are put on the nearest wall."""
    n = len(corners)
    walls = []
    for i in range(n):
        a, b = corners[i], corners[(i + 1) % n]
        h = heights[i] if i < len(heights) else height
        w = {"length": round(_len(_sub(b, a)), 4)}
        if h is None:
            w["open"] = True
        elif height and abs(h - height) > 0.05:
            w["height"] = round(h, 4)
        walls.append(w)
    for a, b, h in extra_walls:     # walls inside the room that aren't part of its outline (e.g. a nib wall)
        walls.append({"length": round(_len(_sub(b, a)), 4), "extra": True, "a": list(a), "b": list(b),
                      **({"height": round(h, 4)} if h and height and abs(h - height) > 0.05 else {})})
    ops = []
    for o in openings or ():
        hit = nearest_wall(corners, o["centre"], o.get("direction"))
        op = {"kind": o.get("kind") or "other", "width": round(float(o["width"]), 4),
              "height": round(float(o["height"]), 4), "count": 1}
        if o.get("sill") is not None:
            op["sill"] = round(max(0.0, float(o["sill"])), 4)
        if hit:
            op["wall"], op["offset"] = hit[0], round(hit[1], 4)
        ops.append(op)
    room = {"name": name, "outline": [[round(x, 4) + 0.0, round(y, 4) + 0.0] for x, y in corners], "walls": walls,
            "height": round(float(height or 0), 4), "openings": ops, "estimated": bool(estimated)}
    if floor_area:
        room["floor_area"] = round(float(floor_area), 4)
    if note:
        room["note"] = note
    if not closed:
        room["note"] = (room.get("note", "") + " The walls didn't close: the open side has no wall.").strip()
    return room


def oriented_box(points):
    """Points (x, y, z) of one element (a wall's or a door's box) -> its size and place on the plan:
    {centre (x, z), dir (unit, along its longest horizontal side), length, thickness, bottom, top}."""
    n = len(points)
    cx = sum(p[0] for p in points) / n
    cz = sum(p[2] for p in points) / n
    sxx = sum((p[0] - cx) ** 2 for p in points)
    szz = sum((p[2] - cz) ** 2 for p in points)
    sxz = sum((p[0] - cx) * (p[2] - cz) for p in points)
    ang = 0.5 * math.atan2(2 * sxz, sxx - szz)
    u = (math.cos(ang), math.sin(ang))
    v = (-u[1], u[0])
    ts = [(p[0] - cx) * u[0] + (p[2] - cz) * u[1] for p in points]
    ss = [(p[0] - cx) * v[0] + (p[2] - cz) * v[1] for p in points]
    t0, t1, s0, s1 = min(ts), max(ts), min(ss), max(ss)
    if (s1 - s0) > (t1 - t0):
        u, v, t0, t1, s0, s1 = v, (-v[0], -v[1]), s0, s1, -t1, -t0
    tm, sm = (t0 + t1) / 2, (s0 + s1) / 2
    centre = (cx + u[0] * tm + v[0] * sm, cz + u[1] * tm + v[1] * sm)
    ys = [p[1] for p in points]
    return {"centre": centre, "dir": u, "length": t1 - t0, "thickness": s1 - s0, "bottom": min(ys), "top": max(ys)}


def polygon_area(outline):
    return ring_area([tuple(p) for p in outline])
