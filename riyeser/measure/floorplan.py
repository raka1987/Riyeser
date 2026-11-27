"""The automatic 2D floor plan: an estimate's rooms drawn to scale, from above.

Walls, doors (gap, leaf and swing), windows, each wall's length, and each room's name and floor area. Rooms imported
from one scan or plan keep their places relative to each other; rooms typed in (length x width) are drawn as
rectangles beside them. A room from a room list (no shape known) is drawn dashed and says so.

layout() makes the drawing once, in metres; svg() draws it for the screen and draw_pdf() for the quote's
measurements page (vector lines and text only: no pictures).
"""
import math

from . import geometry as G, units as U

PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4b5563"]


def _rect_outline(L, W):
    return [[0.0, 0.0], [L, 0.0], [L, W], [0.0, W]]


def rooms_of(items):
    """Room measurements -> drawable rooms (outline in metres, walls, openings, label, area)."""
    out = []
    for it in items:
        if it["kind"] != "room":
            continue
        d = it.get("data") or {}
        q = G.item_quantities("room", d)
        outline = [tuple(map(float, p)) for p in d.get("outline") or []]
        walls = list(d.get("walls") or [])
        if len(outline) < 3:
            L, W = float(d.get("length") or 0), float(d.get("width") or 0)
            if L <= 0 or W <= 0:
                continue
            outline = [tuple(p) for p in _rect_outline(L, W)]
            walls = [{"length": L}, {"length": W}, {"length": L}, {"length": W}]
        out.append({"id": it.get("id"), "label": it.get("label") or d.get("name") or "Room",
                    "color": it.get("color") or PALETTE[len(out) % len(PALETTE)], "outline": outline, "walls": walls,
                    "openings": list(d.get("openings") or []), "area": q.get("floor_area", 0.0),
                    "group": d.get("scan_id") or f"room-{it.get('id') or len(out)}",
                    "shape_known": d.get("shape_known", True) is not False, "estimated": bool(d.get("estimated"))})
    return out


def _place(rooms, gap=1.0, row_width=24.0):
    """Lay out the groups (one scan's rooms together) left to right, wrapping into rows."""
    groups = {}
    for r in rooms:
        groups.setdefault(r["group"], []).append(r)
    x = y = row_h = 0.0
    for rs in groups.values():
        pts = [p for r in rs for p in r["outline"]]
        minx, miny = min(p[0] for p in pts), min(p[1] for p in pts)
        w = max(p[0] for p in pts) - minx
        h = max(p[1] for p in pts) - miny
        if x > 0 and x + w > row_width:
            x, y, row_h = 0.0, y + row_h + gap * 1.6, 0.0
        for r in rs:
            r["outline"] = [(p[0] - minx + x, p[1] - miny + y) for p in r["outline"]]
            r["shift"] = (x - minx, y - miny)      # scan coordinates -> the plan's (the 3D view moves the mesh too)
        x += w + gap * 1.6
        row_h = max(row_h, h)
    return rooms


def _signed(outline):
    s = 0.0
    n = len(outline)
    for i in range(n):
        x1, y1 = outline[i]
        x2, y2 = outline[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return s / 2


def layout(items, sys_="metric"):
    """{'rooms': [...], 'walls', 'doors', 'windows', 'dims', 'labels', 'bounds'} in metres (y down the page)."""
    rooms = _place(rooms_of(items))
    walls, doors, windows, dims, labels = [], [], [], [], []
    for r in rooms:
        o = r["outline"]
        n = len(o)
        sign = 1.0 if _signed(o) > 0 else -1.0
        for i in range(n):
            a, b = o[i], o[(i + 1) % n]
            L = math.dist(a, b)
            if L < 1e-6:
                continue
            u = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
            inward = (-u[1] * sign, u[0] * sign)     # y is down, so the inside is on this side
            w = r["walls"][i] if i < len(r["walls"]) else {"length": L}
            walls.append({"a": a, "b": b, "open": bool(w.get("open")), "color": r["color"], "dashed": not r["shape_known"]})
            if not w.get("open"):
                shown = float(w.get("length") or L)
                dims.append({"a": a, "b": b, "out": inward, "text": U.fmt(shown, "length", sys_)})   # inside the room
        # openings: placed where the scan or plan put them; typed-in rooms get theirs spread along the walls
        placed = [op for op in r["openings"] if op.get("wall") is not None and op.get("offset") is not None]
        loose = [op for op in r["openings"] if op not in placed]
        spots = {}
        for op in loose:
            for _k in range(max(1, int(float(op.get("count") or 1)))):
                wi = 0 if op.get("kind") == "door" else (2 if n > 2 else 0)
                if op.get("kind") == "window":
                    wi = [2, 1, 3, 0][spots.get("w", 0) % 4] if n >= 4 else wi
                    spots["w"] = spots.get("w", 0) + 1
                else:
                    wi = [0, 1, 3, 2][spots.get("d", 0) % 4] if n >= 4 else wi
                    spots["d"] = spots.get("d", 0) + 1
                L = math.dist(o[wi % n], o[(wi + 1) % n])
                placed.append(dict(op, wall=wi % n, offset=L / 2))
        r["ops"] = []
        for op in placed:
            wi = int(op["wall"]) % n
            a, b = o[wi], o[(wi + 1) % n]
            L = math.dist(a, b) or 1.0
            u = ((b[0] - a[0]) / L, (b[1] - a[1]) / L)
            inward = (-u[1] * sign, u[0] * sign)
            width = min(float(op.get("width") or 0.8), L)
            t = min(max(float(op["offset"]), width / 2), L - width / 2)
            kind = op.get("kind") or "other"
            r["ops"].append({"kind": kind, "wall": wi, "offset": t, "width": width,
                             "height": float(op.get("height") or (2.04 if kind == "door" else 1.2)),
                             "sill": float(op.get("sill") if op.get("sill") is not None else (0.9 if kind == "window" else 0.0))})
            p0 = (a[0] + u[0] * (t - width / 2), a[1] + u[1] * (t - width / 2))
            p1 = (a[0] + u[0] * (t + width / 2), a[1] + u[1] * (t + width / 2))
            if op.get("kind") == "door":
                doors.append({"a": p0, "b": p1, "in": inward, "width": width})
            else:
                windows.append({"a": p0, "b": p1, "in": inward, "other": op.get("kind") == "other"})
        cx = sum(p[0] for p in o) / n
        cy = sum(p[1] for p in o) / n
        area = U.fmt(r["area"], "area", sys_)
        xs = [p[0] for p in o]
        labels.append({"x": cx, "y": cy, "w": max(xs) - min(xs), "name": r["label"], "area": area + ("" if r["shape_known"] else " (shape not known)")
                       + (" · estimate" if r["estimated"] else ""), "color": r["color"]})
    pts = [p for r in rooms for p in r["outline"]]
    bounds = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)) if pts else (0, 0, 1, 1)
    return {"rooms": rooms, "walls": walls, "doors": doors, "windows": windows, "dims": dims, "labels": labels,
            "bounds": bounds}


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def svg(items, sys_="metric", title="Floor plan"):
    """The plan as an SVG document (1 unit = 1 cm). None when there are no rooms."""
    lay = layout(items, sys_)
    if not lay["rooms"]:
        return None
    k = 100.0
    x0, y0, x1, y1 = lay["bounds"]
    pad = 0.9
    vb = (x0 - pad) * k, (y0 - pad) * k, (x1 - x0 + 2 * pad) * k, (y1 - y0 + 2 * pad) * k
    span = max(x1 - x0, y1 - y0, 3.0)
    fs = max(12.0, span * 3.2)          # text size grows with the plan, so it stays readable when it's shrunk
    P = lambda p: f"{p[0] * k:.1f},{p[1] * k:.1f}"  # noqa: E731
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb[0]:.1f} {vb[1]:.1f} {vb[2]:.1f} {vb[3]:.1f}" '
           f'role="img" aria-label="{_esc(title)}" class="floorplan" font-family="system-ui, -apple-system, Segoe UI, sans-serif">',
           f"<title>{_esc(title)}</title>",
           '<rect x="{:.1f}" y="{:.1f}" width="{:.1f}" height="{:.1f}" fill="#fff"/>'.format(*vb)]
    for r in lay["rooms"]:
        out.append(f'<polygon points="{" ".join(P(p) for p in r["outline"])}" fill="{r["color"]}" fill-opacity="0.10" '
                   f'stroke="none" data-room="{_esc(r["label"])}"/>')
    for w in lay["walls"]:
        if w["open"]:
            out.append(f'<line x1="{w["a"][0] * k:.1f}" y1="{w["a"][1] * k:.1f}" x2="{w["b"][0] * k:.1f}" y2="{w["b"][1] * k:.1f}" '
                       'stroke="#98a2b3" stroke-width="3" stroke-dasharray="10 8"/>')
        else:
            dash = ' stroke-dasharray="22 12"' if w["dashed"] else ""
            out.append(f'<line x1="{w["a"][0] * k:.1f}" y1="{w["a"][1] * k:.1f}" x2="{w["b"][0] * k:.1f}" y2="{w["b"][1] * k:.1f}" '
                       f'stroke="#1c2430" stroke-width="10" stroke-linecap="square"{dash} class="wall"/>')
    for d in lay["doors"]:      # a gap in the wall, the leaf standing open, and its swing
        a, b, n, wd = d["a"], d["b"], d["in"], d["width"]
        tip = (a[0] + n[0] * wd, a[1] + n[1] * wd)
        out.append(f'<line x1="{a[0] * k:.1f}" y1="{a[1] * k:.1f}" x2="{b[0] * k:.1f}" y2="{b[1] * k:.1f}" stroke="#fff" stroke-width="14"/>')
        out.append(f'<line x1="{a[0] * k:.1f}" y1="{a[1] * k:.1f}" x2="{tip[0] * k:.1f}" y2="{tip[1] * k:.1f}" stroke="#1c2430" stroke-width="3" class="door"/>')
        cross = (b[0] - a[0]) * n[1] - (b[1] - a[1]) * n[0]
        out.append(f'<path d="M{P(tip)} A{wd * k:.1f},{wd * k:.1f} 0 0 {1 if cross < 0 else 0} {P(b)}" fill="none" '
                   'stroke="#667085" stroke-width="2" stroke-dasharray="6 5"/>')
    for w in lay["windows"]:
        a, b, n = w["a"], w["b"], w["in"]
        out.append(f'<line x1="{a[0] * k:.1f}" y1="{a[1] * k:.1f}" x2="{b[0] * k:.1f}" y2="{b[1] * k:.1f}" stroke="#fff" stroke-width="14"/>')
        if w["other"]:
            continue
        for s in (-4, 0, 4):
            off = (n[0] * s / k, n[1] * s / k)
            out.append(f'<line x1="{(a[0] + off[0]) * k:.1f}" y1="{(a[1] + off[1]) * k:.1f}" x2="{(b[0] + off[0]) * k:.1f}" '
                       f'y2="{(b[1] + off[1]) * k:.1f}" stroke="#0891b2" stroke-width="{3 if s == 0 else 2}" class="window"/>')
    for d in lay["dims"]:
        a, b, o = d["a"], d["b"], d["out"]
        m = ((a[0] + b[0]) / 2 + o[0] * 0.26, (a[1] + b[1]) / 2 + o[1] * 0.26)
        ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        ang = ang - 180 if ang >= 90 else ang + 180 if ang < -90 else ang     # upright: verticals read upwards
        out.append(f'<text x="{m[0] * k:.1f}" y="{m[1] * k:.1f}" font-size="{fs * 0.85:.1f}" fill="#475467" text-anchor="middle" '
                   f'dominant-baseline="middle" transform="rotate({ang:.1f} {m[0] * k:.1f} {m[1] * k:.1f})" class="dim">{_esc(d["text"])}</text>')
    for lb in lay["labels"]:
        room_fs = min(fs, lb["w"] * k * 0.62 / max(4, len(lb["name"])) / 0.58 / 1.1)   # names fit their room
        out.append(f'<text x="{lb["x"] * k:.1f}" y="{lb["y"] * k - fs * 0.35:.1f}" font-size="{room_fs * 1.1:.1f}" font-weight="700" '
                   f'fill="#1c2430" text-anchor="middle" class="room-name">{_esc(lb["name"])}</text>')
        out.append(f'<text x="{lb["x"] * k:.1f}" y="{lb["y"] * k + fs * 0.95:.1f}" font-size="{fs * 0.9:.1f}" fill="#475467" '
                   f'text-anchor="middle" class="room-area">{_esc(lb["area"])}</text>')
    # a scale bar: 1 m (or 5 ft)
    bar = 1.0 if sys_ != "imperial" else 5 * U.FT
    bx, by = (x0 - pad * 0.6) * k, (y1 + pad * 0.6) * k
    out.append(f'<line x1="{bx:.1f}" y1="{by:.1f}" x2="{bx + bar * k:.1f}" y2="{by:.1f}" stroke="#1c2430" stroke-width="4"/>')
    out.append(f'<text x="{bx:.1f}" y="{by - 8:.1f}" font-size="{fs * 0.8:.1f}" fill="#1c2430">{"1 m" if sys_ != "imperial" else "5 ft"}</text>')
    out.append("</svg>")
    return "\n".join(out)


def draw_pdf(pdf, font, items, sys_="metric", max_h=150.0):
    """Draw the plan on the PDF at the current position, fitted to the page width. Returns True when drawn."""
    lay = layout(items, sys_)
    if not lay["rooms"]:
        return False
    x0, y0, x1, y1 = lay["bounds"]
    pad = 0.8
    if pdf.get_y() > 180:
        pdf.add_page()
    top = pdf.get_y() + 2
    bw = pdf.w - pdf.l_margin - pdf.r_margin
    bh = min(max_h, 272 - top)
    k = min(bw / (x1 - x0 + 2 * pad), bh / (y1 - y0 + 2 * pad))       # mm per metre
    ox = pdf.l_margin + (bw - (x1 - x0 + 2 * pad) * k) / 2 + pad * k - x0 * k
    oy = top + pad * k - y0 * k
    P = lambda p: (ox + p[0] * k, oy + p[1] * k)  # noqa: E731
    used_h = (y1 - y0 + 2 * pad) * k
    pdf.set_draw_color(228, 231, 236)
    pdf.set_line_width(0.2)
    pdf.rect(pdf.l_margin, top, bw, used_h)
    for r in lay["rooms"]:
        c = _rgb(r["color"])
        pdf.set_fill_color(*[int(v + (255 - v) * 0.88) for v in c])
        pdf.polygon([P(p) for p in r["outline"]], style="F")
    pdf.set_draw_color(28, 36, 48)
    for w in lay["walls"]:
        if w["open"]:
            pdf.set_line_width(0.2)
            pdf.set_dash_pattern(dash=1.2, gap=1.0)
        else:
            pdf.set_line_width(max(0.6, 0.1 * k))
            pdf.set_dash_pattern(dash=2.0, gap=1.2) if w["dashed"] else pdf.set_dash_pattern()
        pdf.line(*P(w["a"]), *P(w["b"]))
        pdf.set_dash_pattern()
    for d in lay["doors"]:
        a, b, n, wd = d["a"], d["b"], d["in"], d["width"]
        pdf.set_draw_color(255, 255, 255)
        pdf.set_line_width(max(0.8, 0.14 * k))
        pdf.line(*P(a), *P(b))
        pdf.set_draw_color(28, 36, 48)
        pdf.set_line_width(0.35)
        tip = (a[0] + n[0] * wd, a[1] + n[1] * wd)
        pdf.line(*P(a), *P(tip))
        u = ((b[0] - a[0]) / wd, (b[1] - a[1]) / wd)
        pts = [P((a[0] + wd * (u[0] * math.cos(t) + n[0] * math.sin(t)), a[1] + wd * (u[1] * math.cos(t) + n[1] * math.sin(t))))
               for t in [math.pi / 2 * s / 12 for s in range(13)]]
        pdf.set_draw_color(102, 112, 133)
        pdf.set_line_width(0.2)
        pdf.polyline(pts)
    for w in lay["windows"]:
        a, b, n = w["a"], w["b"], w["in"]
        pdf.set_draw_color(255, 255, 255)
        pdf.set_line_width(max(0.8, 0.14 * k))
        pdf.line(*P(a), *P(b))
        if w["other"]:
            continue
        pdf.set_draw_color(8, 145, 178)
        pdf.set_line_width(0.25)
        for s in (-0.04, 0.0, 0.04):
            pdf.line(*P((a[0] + n[0] * s, a[1] + n[1] * s)), *P((b[0] + n[0] * s, b[1] + n[1] * s)))
    pdf.set_text_color(71, 84, 103)
    fs = max(5.0, min(7.5, k * 0.16 * 2.2))
    pdf.set_font(font, "", fs)
    for d in lay["dims"]:
        a, b, o = d["a"], d["b"], d["out"]
        m = P(((a[0] + b[0]) / 2 + o[0] * 0.26, (a[1] + b[1]) / 2 + o[1] * 0.26))
        ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        ang = ang - 180 if ang >= 90 else ang + 180 if ang < -90 else ang     # upright: verticals read upwards
        tw = pdf.get_string_width(d["text"])
        with pdf.rotation(-ang, m[0], m[1]):
            pdf.text(m[0] - tw / 2, m[1] + fs * 0.12, d["text"])
    for lb in lay["labels"]:
        x, y = P((lb["x"], lb["y"]))
        pdf.set_text_color(28, 36, 48)
        pdf.set_font(font, "B", fs + 1.5)
        pdf.text(x - pdf.get_string_width(lb["name"]) / 2, y - 0.6, lb["name"])
        pdf.set_text_color(71, 84, 103)
        pdf.set_font(font, "", fs)
        pdf.text(x - pdf.get_string_width(lb["area"]) / 2, y + fs * 0.45, lb["area"])
    # scale bar
    bar = 1.0 if sys_ != "imperial" else 5 * U.FT
    bx, by = pdf.l_margin + 3, top + used_h - 3
    pdf.set_draw_color(28, 36, 48)
    pdf.set_line_width(0.6)
    pdf.line(bx, by, bx + bar * k, by)
    pdf.set_font(font, "", 7)
    pdf.set_text_color(28, 36, 48)
    pdf.text(bx, by - 1.2, "1 m" if sys_ != "imperial" else "5 ft")
    pdf.set_line_width(0.2)
    pdf.set_y(top + used_h + 3)
    return True


def _rgb(h):
    h = (h or "").lstrip("#")
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) if len(h) == 6 else (37, 99, 235)
    except ValueError:
        return (37, 99, 235)
