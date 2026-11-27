"""The trade templates Riyeser ships. They're starting points, not advice: every waste %, coverage, pack size and
post spacing below is a common rule of thumb that the business should check and change for its own materials and
methods. No rates are filled in: prices differ by country, currency and business, so each business types its own.

Each line: (section, description, basis, metric unit, imperial unit, options). Options:
  waste       waste %                     factor / factor_i   multiplier (e.g. litres of paint per m² / per sq ft)
  pack / pack_i   units per pack (tiles per box in m² / sq ft, sheet sizes, tins)   label / label_i   what a pack is
  group       only measurements in this group (e.g. "power" for power points)
Sources for the rules of thumb: Riyeser's trade research (Nov 2026) and common trade practice ([K] in that report).
"""

L, M, O = "Labour", "Materials", "Other"

# litres of paint per m² for 2 coats at 12 m²/L, and US gallons per sq ft for 2 coats at 350 sq ft/gal
PAINT_M, PAINT_I = 2 / 12, 2 / 350

TEMPLATES = [
    ("Roofing", "roofing", "Re-roof or new roof: true roof area from each face's pitch, plus ridges, hips, valleys and barges.", [
        (L, "Remove old roofing and dispose", "roof_area", "m2", "square", {}),
        (L, "Supply and fix roof sheeting", "roof_area", "m2", "square", {"waste": 10}),
        (M, "Roof sheeting", "roof_area", "m2", "square", {"waste": 10}),
        (M, "Sarking / roof underlay", "roof_area", "m2", "ft2", {"waste": 10, "pack": 30, "pack_i": 300, "label": "rolls"}),
        (M, "Ridge capping", "ridge", "m", "ft", {"waste": 5}),
        (M, "Hip capping", "hip", "m", "ft", {"waste": 5}),
        (M, "Valley flashing", "valley", "m", "ft", {"waste": 5}),
        (M, "Barge / rake flashing", "rake", "m", "ft", {"waste": 5}),
        (M, "Wall flashing", "flashing", "m", "ft", {"waste": 5}),
        (O, "Scaffold and edge protection", "fixed", "item", "item", {}),
    ]),
    ("Fencing", "fencing", "Fence runs with gates: posts from the post spacing (2.4 m / 8 ft bays), plus a post per gate.", [
        (L, "Remove old fence", "fence_length", "m", "ft", {}),
        (L, "Install fence", "panel_length", "m", "ft", {}),
        (M, "Fence panels", "panel_length", "m", "ft", {"pack": 2.4, "pack_i": 8, "label": "panels"}),
        (M, "Posts", "posts", "each", "each", {}),
        (M, "Concrete for posts (2 bags a post)", "posts", "each", "each", {"factor": 2, "label": "bags"}),
        (M, "Gate supply and hang", "gates", "each", "each", {}),
    ]),
    ("Decking", "decking", "Deck area: boards by the metre (90 mm boards, 5 mm gaps), joists at 450 mm centres.", [
        (L, "Build deck (frame and boards)", "area", "m2", "ft2", {}),
        (M, "Decking boards", "area", "m2", "ft2", {"factor": 10.53, "factor_i": 2.11, "waste": 10, "label": "lm", "label_i": "lin ft"}),
        (M, "Joists", "area", "m2", "ft2", {"factor": 2.22, "factor_i": 0.68, "waste": 5, "label": "lm", "label_i": "lin ft"}),
        (M, "Deck screws", "area", "m2", "ft2", {"pack": 10, "pack_i": 100, "label": "boxes"}),
        (M, "Deck oil (2 coats)", "area", "m2", "ft2", {"factor": 0.2, "factor_i": 0.0049, "pack": 4, "pack_i": 1, "label": "4 L tins", "label_i": "gal"}),
    ]),
    ("Painting", "painting", "Rooms: walls less doors and windows, ceilings, doors and trims. Paint at 12 m²/L (350 sq ft/gal), 2 coats.", [
        (L, "Paint walls (2 coats)", "wall_area", "m2", "ft2", {}),
        (L, "Paint ceilings (2 coats)", "ceiling_area", "m2", "ft2", {}),
        (L, "Paint doors (both sides)", "doors", "each", "each", {}),
        (L, "Paint skirting and trims", "skirting", "m", "ft", {}),
        (M, "Wall paint", "wall_area", "m2", "ft2", {"factor": PAINT_M, "factor_i": PAINT_I, "waste": 10, "pack": 4, "pack_i": 1, "label": "4 L tins", "label_i": "gal"}),
        (M, "Ceiling paint", "ceiling_area", "m2", "ft2", {"factor": PAINT_M, "factor_i": PAINT_I, "waste": 10, "pack": 4, "pack_i": 1, "label": "4 L tins", "label_i": "gal"}),
        (O, "Preparation, filling and sundries", "fixed", "item", "item", {}),
    ]),
    ("Flooring", "flooring", "Floor area per room; boards or vinyl by the pack (2.2 m² / 24 sq ft); skirting by the length.", [
        (L, "Remove old floor covering", "floor_area", "m2", "ft2", {}),
        (L, "Lay flooring", "floor_area", "m2", "ft2", {}),
        (M, "Flooring", "floor_area", "m2", "ft2", {"waste": 8, "pack": 2.2, "pack_i": 24, "label": "packs"}),
        (M, "Underlay", "floor_area", "m2", "ft2", {"waste": 5}),
        (M, "Skirting / scotia", "skirting", "m", "ft", {"waste": 10, "pack": 5.4, "pack_i": 16, "label": "lengths"}),
    ]),
    ("Tiling", "tiling", "Floor and wall tiles by the box (1.44 m² / 15.5 sq ft), waterproofing, adhesive and grout. Use 15-20% waste for diagonal or herringbone.", [
        (L, "Remove old tiles", "floor_area", "m2", "ft2", {}),
        (L, "Waterproof floor", "floor_area", "m2", "ft2", {}),
        (L, "Lay floor tiles", "floor_area", "m2", "ft2", {}),
        (L, "Lay wall tiles", "wall_area", "m2", "ft2", {}),
        (M, "Floor tiles", "floor_area", "m2", "ft2", {"waste": 10, "pack": 1.44, "pack_i": 15.5, "label": "boxes"}),
        (M, "Wall tiles", "wall_area", "m2", "ft2", {"waste": 10, "pack": 1.44, "pack_i": 15.5, "label": "boxes"}),
        (M, "Waterproofing membrane", "floor_area", "m2", "ft2", {"waste": 10}),
        (M, "Tile adhesive (floor)", "floor_area", "m2", "ft2", {"pack": 5, "pack_i": 50, "label": "bags"}),
        (M, "Tile adhesive (walls)", "wall_area", "m2", "ft2", {"pack": 5, "pack_i": 50, "label": "bags"}),
        (M, "Grout", "floor_area", "m2", "ft2", {"pack": 10, "pack_i": 100, "label": "bags"}),
    ]),
    ("Plastering and drywall", "plastering", "Walls and ceilings in sheets (1200 x 2400 mm / 4 x 8 ft), cornice and jointing compound.", [
        (L, "Hang and set walls", "wall_area", "m2", "ft2", {}),
        (L, "Hang and set ceilings", "ceiling_area", "m2", "ft2", {}),
        (M, "Plasterboard (walls)", "wall_area", "m2", "ft2", {"waste": 10, "pack": 2.88, "pack_i": 32, "label": "sheets"}),
        (M, "Plasterboard (ceilings)", "ceiling_area", "m2", "ft2", {"waste": 10, "pack": 2.88, "pack_i": 32, "label": "sheets"}),
        (M, "Cornice", "perimeter", "m", "ft", {"waste": 10, "pack": 4.8, "pack_i": 16, "label": "lengths"}),
        (M, "Jointing compound", "wall_area", "m2", "ft2", {"pack": 25, "pack_i": 270, "label": "bags"}),
    ]),
    ("Concreting", "concreting", "Slabs, paths and driveways: volume from area x depth (+8% over-order), mesh sheets, formwork around the edge.", [
        (L, "Prepare, pour and finish concrete", "area", "m2", "ft2", {}),
        (L, "Formwork", "perimeter", "m", "ft", {}),
        (M, "Concrete", "volume", "m3", "yd3", {"waste": 8}),
        (M, "Reinforcing mesh", "area", "m2", "ft2", {"pack": 12.6, "pack_i": 135, "label": "sheets"}),
        (M, "Plastic membrane", "area", "m2", "ft2", {"waste": 10}),
        (O, "Concrete pump hire", "fixed", "item", "item", {}),
    ]),
    ("Paving", "paving", "Pavers with 100 mm (4 in) road base and 30 mm (1 in) bedding sand; edging around the outside.", [
        (L, "Excavate and lay pavers", "area", "m2", "ft2", {}),
        (M, "Pavers", "area", "m2", "ft2", {"waste": 7}),
        (M, "Road base (100 mm, compacted)", "area", "m2", "ft2", {"factor": 0.1, "factor_i": 1 / 81, "waste": 15, "label": "m³", "label_i": "cu yd"}),
        (M, "Bedding sand (30 mm)", "area", "m2", "ft2", {"factor": 0.03, "factor_i": 1 / 324, "waste": 10, "label": "m³", "label_i": "cu yd"}),
        (M, "Edging", "perimeter", "m", "ft", {"waste": 5}),
    ]),
    ("Turf and landscaping", "landscaping", "Turf on 75 mm (3 in) underlay soil; garden edging.", [
        (L, "Prepare ground and lay turf", "area", "m2", "ft2", {}),
        (M, "Turf", "area", "m2", "ft2", {"waste": 5}),
        (M, "Underlay soil (75 mm)", "area", "m2", "ft2", {"factor": 0.075, "factor_i": 1 / 108, "waste": 10, "label": "m³", "label_i": "cu yd"}),
        (M, "Garden edging", "length", "m", "ft", {"waste": 5}),
        (O, "Green waste removal", "fixed", "item", "item", {}),
    ]),
    ("Cleaning and pressure washing", "cleaning", "Surfaces by area (driveways, decks, walls), roofs by true roof area, windows by count.", [
        (L, "Pressure clean surfaces", "area", "m2", "ft2", {}),
        (L, "Roof clean", "roof_area", "m2", "ft2", {}),
        (L, "Window cleaning", "windows", "each", "each", {}),
        (O, "Chemicals and call-out", "fixed", "item", "item", {}),
    ]),
    ("Gutters", "gutters", "Gutters along the eaves (5.8 m / 19 ft lengths), downpipes by count, gutter guard.", [
        (L, "Remove and replace gutter", "eave", "m", "ft", {}),
        (M, "Gutter", "eave", "m", "ft", {"waste": 5, "pack": 5.8, "pack_i": 19, "label": "lengths"}),
        (M, "Gutter guard", "eave", "m", "ft", {"waste": 5}),
        (L, "Downpipes", "count", "each", "each", {"group": "downpipe"}),
    ]),
    ("Insulation", "insulation", "Ceiling and wall batts by the pack (8.6 m² / 88 sq ft a pack; check the product).", [
        (L, "Install ceiling insulation", "ceiling_area", "m2", "ft2", {}),
        (L, "Install wall insulation", "wall_area", "m2", "ft2", {}),
        (M, "Ceiling batts", "ceiling_area", "m2", "ft2", {"waste": 5, "pack": 8.6, "pack_i": 88, "label": "packs"}),
        (M, "Wall batts", "wall_area", "m2", "ft2", {"waste": 5, "pack": 8.6, "pack_i": 88, "label": "packs"}),
    ]),
    ("Electrical", "electrical", "Points by count (group your counts as power, light, data), cable allowance per point, labour hours.", [
        (L, "Power points", "count", "each", "each", {"group": "power"}),
        (L, "Light points / downlights", "count", "each", "each", {"group": "light"}),
        (L, "Data points", "count", "each", "each", {"group": "data"}),
        (L, "Labour", "hours", "hour", "hour", {}),
        (M, "Cable allowance (8 m / 26 ft a point)", "count", "each", "each", {"factor": 8, "factor_i": 26, "label": "m", "label_i": "ft"}),
        (O, "Testing and certificate", "fixed", "item", "item", {}),
    ]),
    ("Plumbing", "plumbing", "Fixtures by count (group: fixture), pipe and trench runs by length (groups: pipe, trench), labour hours.", [
        (L, "Fit fixtures (taps, basins, toilets)", "count", "each", "each", {"group": "fixture"}),
        (L, "Trenching", "length", "m", "ft", {"group": "trench"}),
        (L, "Labour", "hours", "hour", "hour", {}),
        (M, "Pipe", "length", "m", "ft", {"waste": 10, "group": "pipe"}),
        (O, "Call-out", "fixed", "item", "item", {}),
    ]),
]

ASSUMPTIONS = ("Starting points, not advice: check the waste %, coverage, pack sizes and spacings for your own "
               "materials, and type in your own rates.")


def template_rows(system="metric"):
    """[(name, trade, notes, [line dicts])] for this unit system."""
    imp = system == "imperial"
    out = []
    for name, trade, notes, lines in TEMPLATES:
        rows = []
        for n, (section, desc, basis, um, ui, o) in enumerate(lines, 1):
            unit = ui if imp else um
            factor = o.get("factor_i", o.get("factor", 1)) if imp else o.get("factor", 1)
            pack = o.get("pack_i", o.get("pack", 0)) if imp else o.get("pack", 0)
            lab = o.get("label_i", o.get("label", "")) if imp else o.get("label", "")
            rows.append({"sort": n, "section": section, "description": desc, "basis": basis, "unit": unit,
                         "factor": factor, "waste_pct": o.get("waste", 0), "pack_size": pack, "unit_label": lab,
                         "group_filter": o.get("group", ""), "rate": None, "min_charge": 0, "item_id": None})
        out.append((name, trade, notes, rows))
    return out
