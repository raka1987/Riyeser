"""The "Measurements" page on a quote PDF made by Riyeser Estimate.

A table of what was measured, then the drawings: for a plan or photo, the business's own page with its lines on it
(the picture the measuring screen saved), or just the lines when there's no picture; for the map, ONLY the lines,
drawn to scale on a plain background with a scale bar and north arrow. Map imagery is never put in the PDF.
"""
import io
import json

from . import geometry as G, store, units as U

INK = (28, 36, 48)
MUTED = (102, 112, 133)
LINE = (228, 231, 236)


def _rgb(h, default=(37, 99, 235)):
    try:
        h = (h or "").lstrip("#")
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) if len(h) == 6 else default
    except ValueError:
        return default


def takeoff_for(db, doc_id):
    try:
        return db.execute("SELECT * FROM takeoffs WHERE document_id=? ORDER BY id DESC LIMIT 1", (doc_id,)).fetchone()
    except Exception:   # an older company file without the tables
        return None


def summary_rows(items, sys_):
    rows = []
    for it in items:
        q = G.item_quantities(it["kind"], it["data"])
        q.pop("_edges", None)
        bits = [f"{G.QUANTITIES[k][0]}: {U.fmt(v, G.QUANTITIES[k][1], sys_)}" for k, v in q.items() if k in G.QUANTITIES and v]
        if "pitch_deg" in q and q.get("roof_area"):
            bits.append(f"pitch {q['pitch_deg']:.1f}°")
        src = {"map": "Map (estimate)", "plan": "Plan", "laser": "Laser", "manual": "Measured", "scan": "Scan"}.get(it["source"], it["source"])
        if it["source"] == "scan" and (it["data"] or {}).get("estimated"):
            src = "3D scan (estimate)"
        rows.append([it["label"] or it["kind"], src + (" · checked on site" if it["verified"] else ""), "; ".join(bits)])
    return rows


def add_page(pdf, db, doc_id, font):
    """Add the measurements page(s) to `pdf` (riyeser/pdf.py's _PDF) when the quote came from an estimate."""
    t = takeoff_for(db, doc_id)
    if not t or not t["summary_on_pdf"]:
        return False
    items = store.items_of(db, t["id"])
    if not items:
        return False
    co = db.execute("SELECT * FROM company WHERE id=1").fetchone()
    sys_ = store.takeoff_units(t, dict(co))
    pdf.add_page()
    pdf.set_font(font, "B", 16)
    pdf.set_text_color(*INK)
    pdf.cell(0, 9, "Measurements", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font(font, "", 9.5)
    pdf.set_text_color(*MUTED)
    pdf.multi_cell(0, 5, f"{t['title']}" + (f" · {t['address']}" if t["address"] else ""), new_x="LMARGIN", new_y="NEXT")
    if any(i["source"] == "map" for i in items):
        pdf.set_text_color(154, 52, 18)
        pdf.multi_cell(0, 5, "Sizes marked 'Map (estimate)' were measured on satellite imagery, which may be out of date. "
                             "They are estimates and will be checked on site.", new_x="LMARGIN", new_y="NEXT")
    if any(i["source"] == "scan" and (i["data"] or {}).get("estimated") for i in items):
        pdf.set_text_color(154, 52, 18)
        pdf.multi_cell(0, 5, "Sizes marked '3D scan (estimate)' were estimated from a 3D scan's mesh. They are estimates "
                             "and will be checked on site.", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)
    pdf.table(["Measurement", "How", "Sizes"], summary_rows(items, sys_), [46, 34, 98], ["L", "L", "L"])
    tot = G.takeoff_quantities(items)
    if tot:
        pdf.ln(2)
        pdf.set_font(font, "B", 10)
        pdf.set_text_color(*INK)
        pdf.cell(0, 6, "Totals", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font(font, "", 9.5)
        pdf.multi_cell(0, 5, "; ".join(f"{G.QUANTITIES[k][0]}: {U.fmt(v, G.QUANTITIES[k][1], sys_)}"
                                       for k, v in tot.items() if k in G.QUANTITIES), new_x="LMARGIN", new_y="NEXT")
    # the floor plan of the rooms (drawn from the sizes: lines and text, no pictures)
    if any(it["kind"] == "room" for it in items):
        from .floorplan import draw_pdf, layout
        if layout(items, sys_)["rooms"]:
            _heading(pdf, font, "Floor plan (drawn from the room sizes, not to an exact scale where a shape isn't known)"
                     if any((it["data"] or {}).get("shape_known") is False for it in items) else "Floor plan (to scale)")
            draw_pdf(pdf, font, items, sys_)
    # plan pages: the saved picture (the business's own plan with its lines), else the lines alone
    pages = {}
    for it in items:
        if it["source"] == "plan" and it["plan_id"]:
            pages.setdefault((it["plan_id"], it["page"] or 1), []).append(it)
    for (pid, page), its in pages.items():
        row = db.execute("SELECT p.*, x.name FROM takeoff_plan_pages p JOIN takeoff_plans x ON x.id=p.plan_id"
                         " WHERE p.plan_id=? AND p.page=?", (pid, page)).fetchone()
        title = f"{row['name'] if row else 'Plan'} (page {page})"
        if row and row["snapshot"]:
            _heading(pdf, font, title)
            _image(pdf, row["snapshot"])
        else:
            _heading(pdf, font, title + ": your lines")
            _vector(pdf, font, [(it, [tuple(p) for p in it["data"].get("points") or []],
                                 [[tuple(p) for p in h] for h in it["data"].get("holes") or []]) for it in its], flip=False)
    maps = [it for it in items if it["source"] == "map" and it["data"].get("latlngs")]
    if maps:
        allp = [tuple(p) for it in maps for p in it["data"]["latlngs"]]
        origin = (sum(p[0] for p in allp) / len(allp), sum(p[1] for p in allp) / len(allp))
        shapes = [(it, G.local_xy([tuple(p) for p in it["data"]["latlngs"]], origin),
                   [G.local_xy([tuple(p) for p in h], origin) for h in it["data"].get("holes") or []]) for it in maps]
        _heading(pdf, font, "Map drawing: your lines only (no imagery), to scale")
        _vector(pdf, font, shapes, flip=True, metres=True, sys_=sys_)
    return True


def _heading(pdf, font, text):
    if pdf.get_y() > 200:
        pdf.add_page()
    pdf.ln(4)
    pdf.set_font(font, "B", 11)
    pdf.set_text_color(*INK)
    pdf.cell(0, 7, text, new_x="LMARGIN", new_y="NEXT")


def _image(pdf, png):
    from PIL import Image
    im = Image.open(io.BytesIO(png))
    w, h = im.size
    box_w, box_h = pdf.w - pdf.l_margin - pdf.r_margin, max(60.0, 270 - pdf.get_y())
    k = min(box_w / w, box_h / h)
    if h * k < 60:
        pdf.add_page()
        box_h = 250
        k = min(box_w / w, box_h / h)
    pdf.image(io.BytesIO(png), x=pdf.l_margin, y=pdf.get_y(), w=w * k, h=h * k)
    pdf.set_y(pdf.get_y() + h * k + 2)


def _vector(pdf, font, shapes, flip, metres=False, sys_="metric"):
    """Draw [(item, outer points, holes)] fitted into the space left on the page (y flipped for map north-up)."""
    pts = [p for _it, o, hs in shapes for p in o + [q for h in hs for q in h]]
    if not pts:
        return
    minx, maxx = min(p[0] for p in pts), max(p[0] for p in pts)
    miny, maxy = min(p[1] for p in pts), max(p[1] for p in pts)
    if pdf.get_y() > 190:
        pdf.add_page()
    x0, y0 = pdf.l_margin + 4, pdf.get_y() + 4
    bw, bh = pdf.w - pdf.l_margin - pdf.r_margin - 8, min(150.0, 268 - y0)
    k = min(bw / max(maxx - minx, 1e-9), bh / max(maxy - miny, 1e-9))
    ox = x0 + (bw - (maxx - minx) * k) / 2

    def P(p):
        return (ox + (p[0] - minx) * k, y0 + ((maxy - p[1]) if flip else (p[1] - miny)) * k)
    pdf.set_draw_color(*LINE)
    pdf.rect(pdf.l_margin, y0 - 4, pdf.w - pdf.l_margin - pdf.r_margin, bh + 8)
    for it, outer, holes in shapes:
        c = _rgb(it.get("color"))
        pdf.set_draw_color(*c)
        pdf.set_line_width(0.5)
        light = tuple(int(v + (255 - v) * 0.78) for v in c)
        if it["kind"] == "markers":
            pdf.set_fill_color(*c)
            for p in outer:
                x, y = P(p)
                pdf.circle(x, y, 1.2, style="F")
            continue
        if it["kind"] in ("shape", "roof") and len(outer) > 2:
            pdf.set_fill_color(*light)
            pdf.polygon([P(p) for p in outer], style="DF")
            pdf.set_fill_color(255, 255, 255)
            for h in holes:
                if len(h) > 2:
                    pdf.polygon([P(p) for p in h], style="DF")
        elif len(outer) > 1:
            pdf.polyline([P(p) for p in outer], polygon=bool(it["data"].get("closed")))
        cx = sum(P(p)[0] for p in outer) / len(outer)
        cy = sum(P(p)[1] for p in outer) / len(outer)
        pdf.set_font(font, "B", 7.5)
        pdf.set_text_color(*INK)
        label = it["label"] or ""
        pdf.text(cx - pdf.get_string_width(label) / 2, cy, label)
    pdf.set_line_width(0.2)
    if metres:   # a scale bar and north arrow
        unit = "ft" if sys_ == "imperial" else "m"
        span = (maxx - minx) / 4 or 1
        nice = U.from_si(span, unit)
        step = max(1, int(10 ** len(str(int(nice))) / 10))
        bar = U.to_si(max(step, int(nice // step) * step), unit)
        ybar = y0 + bh + 1
        pdf.set_draw_color(*INK)
        pdf.set_line_width(0.6)
        pdf.line(x0, ybar, x0 + bar * k, ybar)
        pdf.set_font(font, "", 7.5)
        pdf.text(x0, ybar - 1.2, f"{U.from_si(bar, unit):g} {unit}")
        pdf.text(x0 + bw - 6, y0 + 2, "N ↑")
        pdf.set_line_width(0.2)
    pdf.set_y(y0 + bh + 6)


__all__ = ["add_page", "json"]
