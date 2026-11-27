"""Sample estimates for the demo company: a roof and a fence measured on the map, a painted room typed in, a
tiled bathroom drawn on a sample plan, and a living room imported from a sample room scan. Made-up prices (the shipped templates have none), in the demo's currency.
The map shapes sit over a public park precinct, labelled as samples; no real customer's property is used."""
import io
import json

from . import store
from ..db import to_cents

# demo rates per template line description: (rate, cost) in the company's currency
RATES = {
    "Remove old roofing and dispose": (12, 7), "Supply and fix roof sheeting": (28, 16), "Roof sheeting": (32, 22),
    "Sarking / roof underlay": (180, 120), "Ridge capping": (38, 22), "Hip capping": (38, 22), "Valley flashing": (45, 26),
    "Barge / rake flashing": (35, 20), "Scaffold and edge protection": (950, 700),
    "Remove old fence": (18, 10), "Install fence": (45, 25), "Fence panels": (95, 65), "Posts": (42, 28),
    "Concrete for posts (2 bags a post)": (12, 8), "Gate supply and hang": (480, 320),
    "Paint walls (2 coats)": (14, 7), "Paint ceilings (2 coats)": (16, 8), "Paint doors (both sides)": (95, 40),
    "Paint skirting and trims": (9, 4), "Wall paint": (89, 58), "Ceiling paint": (79, 50),
    "Preparation, filling and sundries": (120, 60),
    "Remove old tiles": (35, 20), "Waterproof floor": (55, 30), "Lay floor tiles": (75, 40), "Lay wall tiles": (85, 45),
    "Floor tiles": (65, 42), "Wall tiles": (55, 35), "Waterproofing membrane": (18, 11), "Tile adhesive (floor)": (32, 21),
    "Tile adhesive (walls)": (32, 21), "Grout": (24, 15),
}
# a public park precinct (no private property): the sample roof is a pavilion, the fence runs along a lawn
ROOF = [[-33.84720, 151.06700], [-33.84720, 151.06730], [-33.84740, 151.06730], [-33.84740, 151.06700]]
FENCE = [[-33.84760, 151.06690], [-33.84760, 151.06745], [-33.84800, 151.06745]]


def sample_plan_png():
    """A simple bathroom floor plan, drawn at 100 pixels a metre (2.4 m x 3.0 m), with a 1 m scale bar."""
    from PIL import Image, ImageDraw
    W, H, ox, oy, k = 520, 460, 70, 60, 100
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    d.rectangle([ox, oy, ox + 2.4 * k, oy + 3.0 * k], outline="black", width=6)
    d.rectangle([ox + 2.4 * k - 4, oy + 2.0 * k, ox + 2.4 * k + 4, oy + 2.8 * k], fill="white")   # the door
    d.arc([ox + 1.6 * k, oy + 2.0 * k, ox + 3.2 * k, oy + 3.6 * k], 180, 270, fill="gray", width=2)
    d.rectangle([ox + 10, oy + 10, ox + 0.9 * k, oy + 1.6 * k], outline="gray", width=2)            # shower
    d.text((ox + 20, oy + 70), "SHOWER", fill="gray")
    d.ellipse([ox + 1.5 * k, oy + 15, ox + 2.2 * k, oy + 65], outline="gray", width=2)               # basin
    d.text((ox + 60, oy + 3.0 * k + 18), "2400", fill="black")
    d.text((ox - 50, oy + 140), "3000", fill="black")
    d.line([ox, oy + 3.0 * k + 60, ox + k, oy + 3.0 * k + 60], fill="black", width=3)
    d.text((ox, oy + 3.0 * k + 66), "1 m", fill="black")
    d.text((ox, 20), "SAMPLE PLAN - BATHROOM 1:? (scale from the 1 m bar)", fill="black")
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def seed(db, customers):
    """Add the sample estimates (once)."""
    store.ensure(db)
    if db.execute("SELECT 1 FROM takeoffs LIMIT 1").fetchone():
        return
    store.seed_templates(db, "metric")
    for desc, (rate, cost) in RATES.items():
        db.execute("UPDATE measure_template_lines SET rate=?, cost=? WHERE description=? AND template_id IN"
                   " (SELECT id FROM measure_templates WHERE shipped=1 AND units='metric')",
                   (to_cents(rate), to_cents(cost), desc))
    tpl = {r["trade"]: r["id"] for r in db.execute("SELECT id, trade FROM measure_templates WHERE shipped=1 AND units='metric'")}
    c = (list(customers) + [None] * 4)[:4]

    def takeoff(title, cid, address, method, trade, items, note=None):
        tid = db.execute("INSERT INTO takeoffs (title, contact_id, address, method, templates, notes) VALUES (?,?,?,?,?,?)",
                         (title, cid, address, method, json.dumps([tpl[trade]]), note)).lastrowid
        for n, (kind, source, label, grp, color, data, extra) in enumerate(items, 1):
            db.execute("INSERT INTO takeoff_items (takeoff_id, kind, source, label, grp, color, data, plan_id, page, verified, sort)"
                       " VALUES (?,?,?,?,?,?,?,?,?,?,?)", (tid, kind, source, label, grp, color, json.dumps(data),
                                                           extra.get("plan_id"), extra.get("page"), extra.get("verified", 0), n))
        return tid

    roof = takeoff("Re-roof the park pavilion (sample)", c[0], "Sample pavilion, Olympic Park", "map", "roofing", [
        ("roof", "map", "Pavilion roof, north half", "roof", "#dc2626",
         {"latlngs": ROOF[:2] + [[-33.84730, 151.06730], [-33.84730, 151.06700]], "pitch": {"deg": 22.5},
          "edges": ["eave", "rake", "ridge", "rake"]}, {}),
        ("roof", "map", "Pavilion roof, south half", "roof", "#2563eb",
         {"latlngs": [[-33.84730, 151.06700], [-33.84730, 151.06730], ROOF[2], ROOF[3]], "pitch": {"deg": 22.5},
          "edges": ["ridge", "rake", "eave", "rake"]}, {}),
    ])
    takeoff("Back fence with a gate (sample)", c[1], "Sample lawn, Olympic Park", "map", "fencing", [
        ("fence", "map", "Back and side fence", "fence", "#16a34a",
         {"latlngs": FENCE, "spacing": 2.4, "gates": [{"width": 1.0, "count": 1}]}, {}),
    ])
    room = takeoff("Paint the main bedroom", c[2], None, "manual", "painting", [
        ("room", "manual", "Main bedroom", "", "#7c3aed",
         {"length": 4.2, "width": 3.6, "height": 2.4, "openings": [
             {"kind": "door", "width": 0.82, "height": 2.04, "count": 1}, {"kind": "window", "width": 1.8, "height": 1.2, "count": 1}]},
         {"verified": 1}),
    ])
    bath = takeoff("Retile the bathroom", c[3], None, "plan", "tiling", [])
    pid = db.execute("INSERT INTO takeoff_plans (takeoff_id, name, mime, data, pages) VALUES (?,?,?,?,1)",
                     (bath, "Sample bathroom plan.png", "image/png", sample_plan_png())).lastrowid
    s = 0.01   # 100 px a metre
    db.execute("INSERT INTO takeoff_plan_pages (plan_id, page, scale, scale_note, width, height) VALUES (?,?,?,?,520,460)",
               (pid, 1, s, "line of 1 m"))
    ox, oy = 70, 60
    floor = [[ox, oy], [ox + 240, oy], [ox + 240, oy + 300], [ox, oy + 300]]
    for n, (kind, label, color, data) in enumerate([
            ("shape", "Bathroom floor", "#0891b2", {"points": floor, "scale": s, "page": 1, "as": "floor"}),
            ("line", "Walls, tiled to 2.1 m", "#d97706", {"points": floor + [floor[0]], "scale": s, "page": 1,
                                                          "height": 2.1, "as": "wall"})], 1):
        db.execute("INSERT INTO takeoff_items (takeoff_id, kind, source, label, color, data, plan_id, page, sort)"
                   " VALUES (?,?, 'plan', ?,?,?,?,1,?)", (bath, kind, label, color, json.dumps(data), pid, n))
    # a living room imported from a room scan (a sample Riyeser makes itself, RoomPlan-style), ready to price
    try:
        from .scan import read as read_scan
        from .scan.sample import write_glb, room_parts
        glb = write_glb(room_parts(5.2, 4.1, 2.55))
        res = read_scan("Sample living room scan.glb", glb)
        living = takeoff("Repaint the living room (sample scan)", c[1], "Sample house", "scan", "painting", [])
        sid = db.execute("INSERT INTO takeoff_scans (takeoff_id, name, format, quality, size, data, preview, result)"
                         " VALUES (?,?,?,?,?,?,?,?)", (living, "Sample living room scan.glb", res["format"], res["quality"],
                                                       len(glb), glb, res["preview"],
                                                       json.dumps({"rooms": res["rooms"], "notes": res["notes"]}))).lastrowid
        for n, r in enumerate(res["rooms"], 1):
            r = dict(r, name="Living room", scan_id=sid, scan_format=res["format"])
            db.execute("INSERT INTO takeoff_items (takeoff_id, kind, source, label, color, data, sort) VALUES (?,?,?,?,?,?,?)",
                       (living, "room", "scan", "Living room", "#0891b2", json.dumps(r), n))
    except Exception:   # the demo still opens without the sample scan
        pass
    # the roof and the room have quotes (one sent, one accepted), the others are drafts
    from .quote import make_quote
    from ..views.quotes import mark_accepted
    try:
        if c[0]:
            make_quote(db, roof)
            db.execute("UPDATE takeoffs SET sent_at=datetime('now','localtime') WHERE id=?", (roof,))
        if c[2]:
            did, _ = make_quote(db, room)
            mark_accepted(db, did, name="Sample customer", source="in_person", by="demo")
    except Exception:   # the demo still opens without the sample quotes
        pass
