"""2D floor plans and room lists -> rooms.

DXF (ASCII; Polycam's floor plan DXF, Magicplan's DXF, any CAD floor plan):
  * units from the header's $INSUNITS (inches, feet, mm, cm, m); with none, guessed from the drawing's size
  * rooms: closed polylines (LWPOLYLINE / POLYLINE), or LINEs that join up into closed loops. Where a wall is drawn
    with two lines (inside and outside faces), the inner loop is the room: loops that hold another room are dropped.
  * names: a TEXT / MTEXT inside the room (numbers and areas are skipped)
  * doors: door blocks (INSERT of a block named ...door...) and door swings (ARCs: the radius is the door's width);
    windows: blocks or lines on a layer named ...window... ("opening" layers: a door when there's a swing next to it)
  * a plan has no heights: walls take the height you give (2.4 m / 8 ft unless changed), doors 2.04 m, windows
    1.2 m high with a 0.9 m sill. Check them.
  Binary DXF and DWG can't be read: save the plan as an ASCII DXF.

CSV (Magicplan's statistics export, or any room list): a header row naming the room and its area, and optionally
perimeter, height and wall area. Units from the header (m², sq ft, ...) or the cells. These rooms have no shape, so
the floor plan draws a stand-in rectangle of the same area and perimeter, marked "shape not known".
"""
import csv
import io
import math
import re

from .meshes import ScanError
from . import rooms as R

INSUNITS = {1: (0.0254, "inches"), 2: (0.3048, "feet"), 4: (0.001, "millimetres"), 5: (0.01, "centimetres"),
            6: (1.0, "metres"), 14: (0.1, "decimetres")}


def _pairs(text):
    lines = text.splitlines()
    for i in range(0, len(lines) - 1, 2):
        try:
            yield int(lines[i].strip()), lines[i + 1].strip()
        except ValueError:
            continue


def parse_dxf(data):
    """{'units': (scale, name) or None, 'entities': [...], 'blocks': {name: [entities]}}"""
    if data[:22] == b"AutoCAD Binary DXF\r\n\x1a\x00":
        raise ScanError("That's a binary DXF. Save it from your CAD app as an ASCII (text) DXF and import that.")
    if data[:6] in (b"AC1015", b"AC1018", b"AC1021", b"AC1024", b"AC1027", b"AC1032") or data[:4] == b"AC10":
        raise ScanError("That's a DWG file, which can't be read without AutoCAD's own software. Save it as DXF "
                        "(File > Save As > DXF in AutoCAD, or use the free ODA File Converter) and import that.")
    text = data.decode("utf-8", "replace") if b"\0" not in data[:2000] else ""
    if "SECTION" not in text[:5000] and "ENTITIES" not in text:
        raise ScanError("That doesn't look like a DXF floor plan.")
    units = None
    ents, blocks = [], {}
    section, cur, block, prev = None, None, None, None
    target = ents

    def close():
        if cur is not None:
            target.append(cur)

    pairs = list(_pairs(text))
    i = 0
    while i < len(pairs):
        code, val = pairs[i]
        if code == 0:
            close()
            cur = None
            if val == "SECTION":
                section = pairs[i + 1][1] if i + 1 < len(pairs) else None
                i += 2
                continue
            if val == "ENDSEC":
                section = None
            elif section == "BLOCKS" and val == "BLOCK":
                block = {"name": "", "ents": [], "base": (0.0, 0.0)}
                target = block["ents"]
                cur = {"type": "BLOCK_HEAD", "_block": block}
            elif section == "BLOCKS" and val == "ENDBLK":
                if block:
                    blocks[block["name"].lower()] = block
                block, target = None, ents
            elif section in ("ENTITIES", "BLOCKS"):
                if val == "VERTEX" and prev is not None and prev.get("type") == "POLYLINE":
                    cur = {"type": "VERTEX", "_poly": prev}
                elif val == "SEQEND":
                    prev = None
                else:
                    cur = {"type": val, "layer": "", "pts": [], "codes": {}}
                    if val == "POLYLINE":
                        prev = cur
        elif section == "HEADER" and code == 9 and val == "$INSUNITS":
            if i + 1 < len(pairs):
                try:
                    units = INSUNITS.get(int(pairs[i + 1][1]))
                except ValueError:
                    pass
        elif cur is not None:
            if cur["type"] == "BLOCK_HEAD":
                if code == 2:
                    cur["_block"]["name"] = val
                elif code == 10:
                    cur["_block"]["base"] = (float(val), cur["_block"]["base"][1])
                elif code == 20:
                    cur["_block"]["base"] = (cur["_block"]["base"][0], float(val))
            elif cur["type"] == "VERTEX":
                if code == 10:
                    cur["_poly"]["pts"].append([float(val), 0.0])
                elif code == 20 and cur["_poly"]["pts"]:
                    cur["_poly"]["pts"][-1][1] = float(val)
            else:
                if code == 8:
                    cur["layer"] = val
                elif cur["type"] == "LWPOLYLINE" and code == 10:
                    cur["pts"].append([float(val), 0.0])
                elif cur["type"] == "LWPOLYLINE" and code == 20 and cur["pts"]:
                    cur["pts"][-1][1] = float(val)
                elif code == 1 and cur["type"] in ("TEXT", "MTEXT"):
                    cur["codes"][1] = cur["codes"].get(1, "") + val
                elif code == 3 and cur["type"] == "MTEXT":
                    cur["codes"][1] = val + cur["codes"].get(1, "")
                else:
                    cur["codes"].setdefault(code, val)
        i += 1
    close()
    # polylines finished by SEQEND are already in the list (their VERTEX entities filled pts)
    ents = [e for e in ents if e.get("type") not in ("VERTEX", "BLOCK_HEAD")]
    return {"units": units, "entities": ents, "blocks": blocks}


def _f(e, code, default=0.0):
    try:
        return float(e["codes"].get(code, default))
    except (TypeError, ValueError):
        return default


def _segments(e):
    t = e["type"]
    if t == "LINE":
        return [((_f(e, 10), _f(e, 20)), (_f(e, 11), _f(e, 21)))]
    if t in ("LWPOLYLINE", "POLYLINE"):
        pts = [tuple(p) for p in e["pts"]]
        closed = int(_f(e, 70)) & 1
        segs = [(pts[k], pts[k + 1]) for k in range(len(pts) - 1)]
        if closed and len(pts) > 2:
            segs.append((pts[-1], pts[0]))
        return segs
    return []


def _loops(segs, tol):
    """Join segments into closed loops (each end meeting exactly one other end)."""
    key = lambda p: (round(p[0] / tol), round(p[1] / tol))  # noqa: E731
    ends = {}
    for i, (a, b) in enumerate(segs):
        ends.setdefault(key(a), []).append((i, 0))
        ends.setdefault(key(b), []).append((i, 1))
    used, loops = set(), []
    for i in range(len(segs)):
        if i in used:
            continue
        loop, cur, at = [segs[i][0]], i, 1
        used.add(i)
        ok = False
        for _ in range(len(segs)):
            p = segs[cur][at]
            if key(p) == key(loop[0]) and len(loop) > 2:
                ok = True
                break
            loop.append(p)
            nxt = [(j, s) for j, s in ends.get(key(p), []) if j not in used]
            if not nxt:
                break
            cur, side = nxt[0]
            at = 1 - side
            used.add(cur)
        if ok:
            loops.append(loop)
    return loops


def _inside(pt, poly):
    x, y = pt
    c = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            c = not c
    return c


KIND_WORDS = (("door", "door"), ("dr", "door"), ("window", "window"), ("wind", "window"), ("win", "window"),
              ("glaz", "window"), ("opening", "opening"))


def _layer_kind(name):
    s = (name or "").lower()
    for w, k in KIND_WORDS:
        if w in s and not (w in ("dr", "win") and not re.search(rf"(^|[^a-z]){w}([^a-z]|$)", s)):
            return k
    return None


def from_dxf(data, default_height=2.4, name="Plan"):
    dx = parse_dxf(data)
    ents = dx["entities"]
    # what's on the plan: room outlines (walls), doors and windows, names
    wall_segs, door_marks, window_marks, texts = [], [], [], []
    for e in ents:
        lk = _layer_kind(e["layer"])
        t = e["type"]
        if t in ("TEXT", "MTEXT"):
            txt = re.sub(r"\\[A-Za-z][^;]*;|\\P|[{}]", " ", e["codes"].get(1, "")).strip()
            if txt:
                texts.append(((_f(e, 10), _f(e, 20)), txt))
            continue
        if t == "INSERT":
            bname = e["codes"].get(2, "")
            bk = _layer_kind(bname) or lk
            blk = dx["blocks"].get(bname.lower())
            w = _block_width(blk, dx["blocks"]) * abs(_f(e, 41, 1.0) or 1.0) if blk else 0.0
            if bk in ("door", "window", "opening") and w > 0:
                ang = math.radians(_f(e, 50))
                mark = {"centre": _block_centre(e, blk), "width": w, "direction": (math.cos(ang), math.sin(ang))}
                (door_marks if bk == "door" else window_marks).append(mark)
            continue
        if t == "ARC":
            door_marks.append({"centre": (_f(e, 10), _f(e, 20)), "width": _f(e, 40), "arc": True})
            continue
        segs = _segments(e)
        if not segs:
            continue
        if lk in ("door", "window", "opening"):
            pts = [p for s in segs for p in s]
            L = max((math.dist(a, b) for a, b in segs), default=0)
            cx, cy = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
            long_seg = max(segs, key=lambda s: math.dist(*s))
            d = (long_seg[1][0] - long_seg[0][0], long_seg[1][1] - long_seg[0][1])
            (window_marks if lk == "window" else door_marks if lk == "door" else window_marks).append(
                {"centre": (cx, cy), "width": L, "direction": d, "opening": lk == "opening"})
            continue
        if re.search(r"dim|furn|fixt|text|label|hatch|grid|axis", (e["layer"] or "").lower()):
            continue
        wall_segs += segs
    if not wall_segs:
        raise ScanError("No walls or room outlines were found in that DXF.")
    # units
    xs = [p[0] for s in wall_segs for p in s]
    ys = [p[1] for s in wall_segs for p in s]
    ext = max(max(xs) - min(xs), max(ys) - min(ys))
    notes = []
    if dx["units"]:
        k, uname = dx["units"]
    else:
        k, uname = (0.001, "millimetres") if ext > 300 else (0.01, "centimetres") if ext > 60 else (1.0, "metres")
        notes.append(f"The DXF doesn't say its units; it was read as {uname} from its size. Check the sizes.")
    S = lambda p: (p[0] * k, -p[1] * k)  # noqa: E731   (DXF y is up the page; the plan's y is down)
    segs_m = [(S(a), S(b)) for a, b in wall_segs]
    loops = [_dedupe(lp) for lp in _loops(segs_m, tol=0.02)]
    loops = [lp for lp in loops if len(lp) >= 3 and R.polygon_area(lp) >= 1.0]
    # an "opening" layer item with a door swing nearby is a door
    for m in list(window_marks):
        if m.get("opening") and any(math.dist(m["centre"], a["centre"]) < a["width"] * 1.2 for a in door_marks if a.get("arc")):
            window_marks.remove(m)
            door_marks.append(m)
    # innermost loops are rooms (a double-line wall's outside face holds the room: drop it)
    rooms_ = []
    for lp in sorted(loops, key=R.polygon_area):
        if any(_inside(_centroid(q), lp) and R.polygon_area(q) > 0.5 for q in rooms_):
            continue
        rooms_.append(lp)
    if not rooms_:
        raise ScanError("The DXF's lines don't make any closed rooms. Check the plan's walls join up, or measure "
                        "it on the plan instead (step 2: On a plan or photo).")
    out = []
    used_names = set()
    for n, lp in enumerate(rooms_, 1):
        nm = None
        for p, txt in texts:
            if _inside(S(p), lp) and not re.fullmatch(r"[\d\s.,'\"x×m²ft2sq-]+", txt.lower()) and txt not in used_names:
                nm = txt.split("\n")[0][:60]
                used_names.add(txt)
                break
        ops = []
        for marks, kind, h, sill in ((door_marks, "door", 2.04, 0.0), (window_marks, "window", 1.2, 0.9)):
            for m in marks:
                c = S(m["centre"])
                w = m["width"] * k
                if not 0.3 <= w <= 4.0:
                    continue
                if m.get("arc"):
                    # a swing's centre is the hinge: the door's middle is half a width along the nearest wall
                    hit = R.nearest_wall(lp, c, max_dist=0.4)
                    if not hit:
                        continue
                    a, b = lp[hit[0]], lp[(hit[0] + 1) % len(lp)]
                    L = math.dist(a, b) or 1
                    u = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
                    t = hit[1] + (w / 2 if hit[1] + w <= L else -w / 2)
                    c = (a[0] + u[0] * t, a[1] + u[1] * t)
                d = m.get("direction")
                if R.nearest_wall(lp, c, (d[0], -d[1]) if d else None, max_dist=0.4):
                    if any(o["kind"] == kind and math.dist(o["centre"], c) < 0.3 for o in ops):
                        continue      # the same door drawn twice (its leaf and its swing)
                    ops.append({"kind": kind, "width": w, "height": h, "sill": sill, "centre": c,
                                "direction": (d[0], -d[1]) if d else None})
        out.append(R.make_room(nm or (f"{name} room {n}" if len(rooms_) > 1 else name), lp, [default_height] * len(lp),
                               default_height, ops, note="From a 2D plan: the wall height and door and window "
                               "heights are typical sizes. Check them."))
    notes.append(f"Read {len(out)} room{'s' if len(out) != 1 else ''} from the plan ({uname}).")
    return out, notes


def _dedupe(lp):
    out = []
    for p in lp:
        if not out or math.dist(out[-1], p) > 1e-6:
            out.append(p)
    if len(out) > 1 and math.dist(out[0], out[-1]) < 1e-6:
        out.pop()
    # drop points on a straight run
    res = []
    n = len(out)
    for i in range(n):
        a, b, c = out[i - 1], out[i], out[(i + 1) % n]
        cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if abs(cross) > 1e-6 * max(1e-9, math.dist(a, b) + math.dist(b, c)):
            res.append(b)
    return res if len(res) >= 3 else out


def _centroid(lp):
    return (sum(p[0] for p in lp) / len(lp), sum(p[1] for p in lp) / len(lp))


def _block_width(blk, blocks, depth=0):
    pts = []
    for e in blk["ents"]:
        for a, b in _segments(e):
            pts += [a, b]
        if e["type"] == "ARC":
            r = _f(e, 40)
            pts += [(_f(e, 10) - r, _f(e, 20) - r), (_f(e, 10) + r, _f(e, 20) + r)]
    if not pts:
        return 0.0
    return max(max(p[0] for p in pts) - min(p[0] for p in pts), max(p[1] for p in pts) - min(p[1] for p in pts))


def _block_centre(ins, blk):
    """Where the block's middle lands on the plan."""
    pts = [p for e in blk["ents"] for s in _segments(e) for p in s]
    bx, by = blk.get("base", (0.0, 0.0))
    if pts:
        mx = (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2 - bx
        my = (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2 - by
    else:
        mx = my = 0.0
    sx, sy = _f(ins, 41, 1.0) or 1.0, _f(ins, 42, 1.0) or 1.0
    a = math.radians(_f(ins, 50))
    x, y = mx * sx, my * sy
    return (_f(ins, 10) + x * math.cos(a) - y * math.sin(a), _f(ins, 20) + x * math.sin(a) + y * math.cos(a))


# ---------------------------------------------------------------- CSV room lists
_AREA_UNITS = (("sq ft", 0.09290304), ("sqft", 0.09290304), ("ft²", 0.09290304), ("ft2", 0.09290304),
               ("sq m", 1.0), ("m²", 1.0), ("m2", 1.0), ("sqm", 1.0))
_LEN_UNITS = (("mm", 0.001), ("cm", 0.01), ("ft", 0.3048), ("in", 0.0254), ("'", 0.3048), ("m", 1.0))


def _num(s):
    s = (s or "").strip()
    m = re.search(r"-?\d[\d\s,.']*", s)
    if not m:
        return None
    t = m.group().strip().replace(" ", "").replace("'", "")
    if t.count(",") == 1 and t.count(".") == 0:
        t = t.replace(",", ".")
    else:
        t = t.replace(",", "")
    try:
        return float(t)
    except ValueError:
        return None


def _unit_of(text, table, default):
    t = (text or "").lower()
    for u, k in table:
        if u in t:
            return k
    return default


def from_csv(data, system="metric", default_height=2.4):
    text = data.decode("utf-8-sig", "replace")
    head = text[:4000]
    delim = max((";", ",", "\t"), key=head.count)      # Europe's spreadsheets use ; (the comma is the decimal mark)
    rows = [r for r in csv.reader(io.StringIO(text), delimiter=delim) if any(c.strip() for c in r)]
    hdr_i, cols = None, {}
    for i, r in enumerate(rows[:30]):
        low = [c.strip().lower() for c in r]
        name_c = next((j for j, c in enumerate(low) if re.search(r"\b(room|name|space|label)\b", c)), None)
        area_c = next((j for j, c in enumerate(low) if re.search(r"area|surface|size", c) and not re.search(r"wall", c)), None)
        if name_c is not None and area_c is not None:
            hdr_i = i
            cols = {"name": name_c, "area": area_c}
            for j, c in enumerate(low):
                if "perim" in c:
                    cols.setdefault("perimeter", j)
                elif re.search(r"height|ceiling", c):
                    cols.setdefault("height", j)
                elif "wall" in c and re.search(r"area|surface", c):
                    cols.setdefault("wall_area", j)
            break
    if hdr_i is None:
        raise ScanError("That CSV has no room list in it: Riyeser looks for columns named Room (or Name) and Area.")
    hdr = rows[hdr_i]
    imperial = system == "imperial"
    a_unit = _unit_of(hdr[cols["area"]], _AREA_UNITS, 0.09290304 if imperial else 1.0)
    l_default = 0.3048 if imperial else 1.0
    out = []
    for r in rows[hdr_i + 1:]:
        if len(r) <= cols["area"]:
            continue
        nm = r[cols["name"]].strip()
        if not nm or re.match(r"(total|sum|all rooms|floor total)", nm.lower()):
            continue
        area = _num(r[cols["area"]])
        if not area:
            continue
        area *= _unit_of(r[cols["area"]], _AREA_UNITS, a_unit)

        def length(key):
            if key not in cols or len(r) <= cols[key]:
                return None
            v = _num(r[cols[key]])
            if v is None:
                return None
            return v * _unit_of(r[cols[key]] or hdr[cols[key]], _LEN_UNITS, _unit_of(hdr[cols[key]], _LEN_UNITS, l_default))
        perim = length("perimeter")
        h = length("height")
        wall_area = None
        if "wall_area" in cols and len(r) > cols["wall_area"]:
            wa = _num(r[cols["wall_area"]])
            if wa:
                wall_area = wa * _unit_of(r[cols["wall_area"]], _AREA_UNITS, _unit_of(hdr[cols["wall_area"]], _AREA_UNITS, a_unit))
        if not perim:
            perim = 4 * math.sqrt(area)
        if not h and wall_area and perim:
            h = wall_area / perim
        h = h or default_height
        # a stand-in rectangle with the same area and perimeter (a square when they can't make one)
        s, p = perim / 2, area
        disc = s * s - 4 * p
        L = (s + math.sqrt(disc)) / 2 if disc >= 0 else math.sqrt(area)
        W = area / L
        lp = [[0.0, 0.0], [L, 0.0], [L, W], [0.0, W]]
        room = R.make_room(nm[:60], lp, [h] * 4, h, (), floor_area=area,
                           note="From a room list: the shape isn't known (the plan shows a rectangle of the same area).")
        room["shape_known"] = False
        k = perim / (2 * (L + W))          # the walls keep the real perimeter, whatever the stand-in's shape
        for w in room["walls"]:
            w["length"] = round(w["length"] * k, 4)
        out.append(room)
    if not out:
        raise ScanError("The CSV's room list has no rooms with an area.")
    # lay the stand-in rectangles out in a row so the plan doesn't stack them
    x = 0.0
    for room in out:
        w = max(p[0] for p in room["outline"])
        room["outline"] = [[p[0] + x, p[1]] for p in room["outline"]]
        x += w + 0.6
    return out, [f"Read {len(out)} room{'s' if len(out) != 1 else ''} from the list."]
