"""A raw scanned mesh (Polycam, Canvas, 3D Scanner apps ...) -> an estimated room, by finding its flat surfaces.

1. Every triangle gives a point (its middle), a normal and an area. Level triangles (within 15 degrees) can be floor
   or ceiling; upright ones (within 15 degrees of vertical) can be walls; the rest (furniture tops at an angle,
   clutter) is ignored.
2. RANSAC finds the planes: pick a random triangle, take its plane (snapped exactly level, or exactly upright), count
   the area of triangles within 4 cm of it that face the same way, keep the plane with the most area out of a few
   hundred tries, refine it from those triangles, take them away and go again. Random choices are seeded, so the
   same file always gives the same answer.
3. The floor is the lowest large level plane, the ceiling the highest. Walls are upright planes that are big and
   tall (at least 60% of the floor-to-ceiling height, so cupboard doors and tables aren't walls) and sit on the
   outside of the room; their lengths come from how far their triangles reach along them.
4. The walls are joined where their lines cross, giving the room's outline (floor area, perimeter, wall lengths).
   When they don't make a closed loop, the room is the box around the floor, lined up with the main wall.

Doors and windows can't be told apart from a mesh reliably, so none are added: add them by hand. Everything here is
an estimate from a 3D mesh, to be checked on site.
"""
import math
import random

from . import rooms as R

LEVEL = math.cos(math.radians(15))      # |n.y| above this: level
UPRIGHT = math.sin(math.radians(15))    # |n.y| below this: upright


def triangle_data(tris):
    """[(centre, unit normal, area, (a, b, c))] for triangles with some area."""
    out = []
    for a, b, c in tris:
        ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        L = math.sqrt(nx * nx + ny * ny + nz * nz)
        if L < 1e-12:
            continue
        out.append((((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3),
                    (nx / L, ny / L, nz / L), L / 2, (a, b, c)))
    return out


def ransac(tris, kind, rng, dist=0.04, angle=20, iters=90, min_area=0.25, max_planes=20, probe=1500):
    """Planes of one kind ('level' or 'upright') among tris: [{'n': (nx, ny, nz), 'd': n.p, 'area', 'tris'}].
    Normals are taken without their sign: scans don't agree on which way a triangle faces."""
    cos_a = math.cos(math.radians(angle))
    pool = [t for t in tris if (abs(t[1][1]) >= LEVEL if kind == "level" else abs(t[1][1]) <= UPRIGHT)]
    planes = []
    while pool and len(planes) < max_planes:
        best, best_score = None, 0.0
        weights = [t[2] for t in pool]
        # hypotheses are scored on a random sample of the triangles (fast), the winner on all of them
        sample = pool if len(pool) <= probe else rng.sample(pool, probe)
        scale = sum(weights) / (sum(t[2] for t in sample) or 1.0)
        for t in rng.choices(pool, weights, k=iters):
            n = _snap(t[1], kind)
            d = n[0] * t[0][0] + n[1] * t[0][1] + n[2] * t[0][2]
            score = 0.0
            for c, tn, area, _abc in sample:
                if abs(n[0] * c[0] + n[1] * c[1] + n[2] * c[2] - d) <= dist and abs(n[0] * tn[0] + n[1] * tn[1] + n[2] * tn[2]) >= cos_a:
                    score += area
            if score > best_score:
                best, best_score = (n, d), score
        if best is None or best_score * scale < min_area:
            break
        n, d = best
        for band in (dist, dist * 0.6, dist * 0.45):     # refine: least squares through its own triangles,
            inl = [t for t in pool if _inlier(t, n, d, band, cos_a)]   # closing in (things standing near a wall)
            if len(inl) < 3:
                break
            n, d = _fit(inl, kind, n)
        inl = [t for t in pool if _inlier(t, n, d, dist, cos_a)]
        keep = [t for t in pool if not _inlier(t, n, d, dist, cos_a)]
        if not inl:
            break
        planes.append({"n": n, "d": d, "area": sum(t[2] for t in inl), "tris": inl})
        pool = keep
    return planes


def _fit(inl, kind, n0):
    """The best plane through these triangles' middles: level (height = mean) or upright (the line of best fit
    on the plan, by principal axes)."""
    sa = sum(t[2] for t in inl)
    if kind == "level":
        return (0.0, 1.0, 0.0), sum(t[0][1] * t[2] for t in inl) / sa
    mx = sum(t[0][0] * t[2] for t in inl) / sa
    mz = sum(t[0][2] * t[2] for t in inl) / sa
    sxx = sum((t[0][0] - mx) ** 2 * t[2] for t in inl)
    szz = sum((t[0][2] - mz) ** 2 * t[2] for t in inl)
    sxz = sum((t[0][0] - mx) * (t[0][2] - mz) * t[2] for t in inl)
    ang = 0.5 * math.atan2(2 * sxz, sxx - szz)            # along the wall
    n = _snap((-math.sin(ang), 0.0, math.cos(ang)), kind)
    return n, n[0] * mx + n[2] * mz


def _inlier(t, n, d, dist, cos_a):
    c, tn = t[0], t[1]
    return abs(n[0] * c[0] + n[1] * c[1] + n[2] * c[2] - d) <= dist and abs(n[0] * tn[0] + n[1] * tn[1] + n[2] * tn[2]) >= cos_a


def _snap(n, kind):
    if kind == "level":
        return (0.0, 1.0, 0.0)
    L = math.hypot(n[0], n[2]) or 1.0
    x, z = n[0] / L, n[2] / L
    if x < -1e-9 or (abs(x) <= 1e-9 and z < 0):
        x, z = -x, -z
    return (x, 0.0, z)


def _merge_upright(planes, dist=0.12, angle=10):
    """Join pieces of the same wall (RANSAC can split a wall behind furniture into two planes)."""
    cos_a = math.cos(math.radians(angle))
    out = []
    for p in sorted(planes, key=lambda p: -p["area"]):
        for q in out:
            dot = p["n"][0] * q["n"][0] + p["n"][2] * q["n"][2]
            if abs(dot) >= cos_a and abs(p["d"] - (q["d"] if dot > 0 else -q["d"])) <= dist:
                q["tris"] += p["tris"]
                q["area"] += p["area"]
                break
        else:
            out.append(dict(p, tris=list(p["tris"])))
    return out


def estimate_room(scene, name="Scanned room", seed=7, limit=40000):
    """(room dict, notes) from a Y-up metres Scene, or (None, notes) when no room can be found."""
    tris, step = scene.sample_triangles(limit)
    # areas are scaled back up by the sampling step, so they're the model's real areas
    data = [(c, n, a * step, abc) for c, n, a, abc in triangle_data(tris)]
    notes = []
    if len(data) < 12:
        return None, ["The model has too few triangles to find a room in."]
    rng = random.Random(seed)
    level = ransac(data, "level", rng, max_planes=8)
    if not level:
        return None, ["No floor was found in the model. Scan the floor too, or type the sizes in."]
    total_level = sum(p["area"] for p in level)
    big = [p for p in level if p["area"] >= 0.15 * total_level]
    floor = min(big, key=lambda p: p["d"])
    ceil_ = max(big, key=lambda p: p["d"])
    upright = _merge_upright(ransac(data, "upright", rng))
    top_seen = max(max(v[1] for v in t[3]) for t in data)
    if ceil_ is floor or ceil_["d"] - floor["d"] < 1.8:
        h = top_seen - floor["d"]
        notes.append("No ceiling was found in the scan: the height is up to the highest point scanned.")
    else:
        h = ceil_["d"] - floor["d"]
    walls = []
    for p in upright:
        n = p["n"]
        u = (-n[2], n[0])                        # along the wall, on the plan (x, z)
        ts, ys = [], []
        for _c, _tn, _a, abc in p["tris"]:
            for v in abc:
                ts.append(v[0] * u[0] + v[2] * u[1])
                ys.append(v[1])
        ts.sort()
        k = max(0, len(ts) // 100)               # ignore the furthest 1% at each end (stray triangles)
        t0, t1 = ts[k], ts[-1 - k]
        span = max(ys) - min(ys)
        if span < 0.6 * h or t1 - t0 < 0.4 or p["area"] < 0.4:
            continue
        base = (n[0] * p["d"], n[2] * p["d"])   # the point of the line nearest the origin
        a = (base[0] + u[0] * t0, base[1] + u[1] * t0)
        b = (base[0] + u[0] * t1, base[1] + u[1] * t1)
        walls.append({"a": a, "b": b, "len": t1 - t0, "area": p["area"], "n": (n[0], n[2]), "d": p["d"]})
    # the floor's footprint, to tell the room's own walls (on the outside) from planes in the middle of it
    fx = [v[0] for t in floor["tris"] for v in t[3]]
    fz = [v[2] for t in floor["tris"] for v in t[3]]
    outer = []
    for w in walls:
        # most floor lies on one side of a real wall
        side = [(x - w["a"][0]) * w["n"][0] + (z - w["a"][1]) * w["n"][1] for x, z in zip(fx[::7], fz[::7])]
        pos = sum(1 for s in side if s > 0.05)
        neg = sum(1 for s in side if s < -0.05)
        if min(pos, neg) <= 0.08 * max(1, pos + neg):
            outer.append(w)
    corners, heights, closed = None, None, False
    if len(outer) >= 3:
        segs = [(w["a"], w["b"], h) for w in outer]
        c, hs, closed, _extra = R.chain_walls(segs, tol=0.6)
        if closed and len(c) >= 3 and R.polygon_area(c) > 1.0:
            corners, heights = c, [h] * len(c)
    floor_area = None
    if corners is None:
        main = max(outer or walls, key=lambda w: w["len"], default=None)
        u = (main["b"][0] - main["a"][0], main["b"][1] - main["a"][1]) if main else (1.0, 0.0)
        L = math.hypot(*u) or 1.0
        u = (u[0] / L, u[1] / L)
        v = (-u[1], u[0])
        ts = [x * u[0] + z * u[1] for x, z in zip(fx, fz)]
        ss = [x * v[0] + z * v[1] for x, z in zip(fx, fz)]
        t0, t1, s0, s1 = min(ts), max(ts), min(ss), max(ss)
        corners = [[u[0] * t + v[0] * s, u[1] * t + v[1] * s] for t, s in ((t0, s0), (t1, s0), (t1, s1), (t0, s1))]
        heights = [h] * 4
        floor_area = floor["area"]
        notes.append("The walls didn't make a closed shape, so the room is the box around the scanned floor, and "
                     "the floor area is the floor that was scanned.")
    room = R.make_room(name, corners, heights, h, (), floor_area=floor_area, estimated=True,
                       note="Estimated from a 3D mesh: check on site. Add doors and windows by hand.")
    notes.append(f"Found the floor, {'the ceiling and ' if ceil_ is not floor else 'and '}{len(outer)} wall"
                 f"{'s' if len(outer) != 1 else ''} in the mesh ({len(data):,} triangles looked at).")
    return room, notes
