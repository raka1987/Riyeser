"""Photos on an estimate, with markup drawn on them (arrows, circles, boxes, freehand, text labels and measurement
callouts: a line with its length typed on it).

Non-destructive: the photo itself is kept as it came (big ones shrunk to MAX_EDGE on the long side, turned the right
way up), and the markup is kept separately as JSON (below). A flattened JPEG (the photo with the markup drawn on it)
is made here on the PC whenever the markup changes, for the quote PDF. Photos ticked "On the quote" go on a Photos
page with their captions.

Markup JSON: {"v": 1, "shapes": [shape, ...]}, every point in fractions of the photo's width and height (so it fits
the photo at any size), a shape:
    {"t": "arrow" | "circle" | "rect" | "pen" | "text" | "measure",
     "c": "#rrggbb",                 colour
     "w": 0.006,                     line width, a fraction of the photo's long side
     "p": [[x, y], ...],             2 points (arrow: tail, head; circle and rect: corners; measure: ends), 1 for text,
                                     2 or more for pen
     "s": "Rot here" | "3.2 m",      text: the label; measure: the length typed in
     "fs": 0.035}                    text size, a fraction of the photo's long side
"""
import io
import json
import re

MAX_UPLOAD = 25 * 1024 * 1024       # a photo file as it comes off the phone
MAX_EDGE = 2400                      # px on the long side kept (plenty for an A4 page)
MAX_PHOTOS = 40                      # on one estimate
MAX_SHAPES = 300
MAX_PEN_POINTS = 2000
TOOLS = ("arrow", "circle", "rect", "pen", "text", "measure")
COLOURS = ("#dc2626", "#f97316", "#facc15", "#16a34a", "#2563eb", "#ffffff", "#111827")
DEFAULT_W, DEFAULT_FS = 0.006, 0.035
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class PhotoError(ValueError):
    pass


def prepare(data, name=""):
    """The uploaded file -> (mime, bytes kept, width, height). A photo over MAX_EDGE is shrunk (JPEG); the phone's
    rotation is applied so it shows the right way up everywhere. Raises PhotoError with what to do."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    if not data:
        raise PhotoError("That file is empty.")
    if len(data) > MAX_UPLOAD:
        raise PhotoError(f"{name or 'That photo'} is over {MAX_UPLOAD // (1024 * 1024)} MB. Take it at a lower "
                         "resolution, or send it as a smaller copy, and add it again.")
    if data[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1", b"ftyphevc"):
        raise PhotoError(f"{name or 'That photo'} is a HEIC photo, which this PC can't open. On an iPhone, choose "
                         "Settings > Camera > Formats > Most Compatible, or share it as a JPEG.")
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except (UnidentifiedImageError, OSError, ValueError):
        raise PhotoError(f"{name or 'That file'} isn't a photo this can read (use JPG, PNG or WebP).")
    if im.width * im.height > 120_000_000:
        raise PhotoError(f"{name or 'That photo'} is too large ({im.width} x {im.height}). Use a smaller copy.")
    fmt = (im.format or "").upper()
    try:
        rotated = (im.getexif() or {}).get(0x0112, 1) not in (1, None)   # the phone's "which way up"
    except Exception:
        rotated = False
    if rotated:
        im = ImageOps.exif_transpose(im)
    big = max(im.size) > MAX_EDGE
    if fmt == "JPEG" and not big and not rotated and len(data) <= 6 * 1024 * 1024:
        return "image/jpeg", data, im.width, im.height
    if fmt == "PNG" and not big and len(data) <= 4 * 1024 * 1024 and im.mode in ("RGB", "RGBA", "L", "P"):
        return "image/png", data, im.width, im.height
    if big:
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    if im.mode not in ("RGB", "L"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        rgba = im.convert("RGBA")
        bg.paste(rgba, mask=rgba.split()[3])
        im = bg
    out = io.BytesIO()
    im.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
    return "image/jpeg", out.getvalue(), im.width, im.height


def _num(v, lo, hi, default=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:
        return default
    return round(min(hi, max(lo, f)), 4)


def clean_markup(m):
    """Markup from the browser -> the JSON kept (checked, rounded, limited). clean_markup(clean_markup(m)) is the same.
    Raises PhotoError for something that isn't markup at all."""
    if m in (None, "", {}):
        return {"v": 1, "shapes": []}
    if isinstance(m, str):
        try:
            m = json.loads(m)
        except ValueError:
            raise PhotoError("The markup couldn't be read.")
    if not isinstance(m, dict) or not isinstance(m.get("shapes", []), list):
        raise PhotoError("The markup couldn't be read.")
    shapes = m.get("shapes") or []
    if len(shapes) > MAX_SHAPES:
        raise PhotoError(f"That's more than {MAX_SHAPES} marks on one photo. Undo a few, or use another photo.")
    out = []
    for sh in shapes:
        if not isinstance(sh, dict) or sh.get("t") not in TOOLS:
            continue
        t = sh["t"]
        pts = []
        for p in (sh.get("p") or [])[:MAX_PEN_POINTS]:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                x, y = _num(p[0], -0.5, 1.5), _num(p[1], -0.5, 1.5)
                if x is not None and y is not None:
                    pts.append([x, y])
        need = {"text": 1, "pen": 2}.get(t, 2)
        if len(pts) < need:
            continue
        if t in ("arrow", "circle", "rect", "measure"):
            pts = pts[:2]
        elif t == "text":
            pts = pts[:1]
        c = sh.get("c") if isinstance(sh.get("c"), str) and HEX.match(sh.get("c") or "") else COLOURS[0]
        d = {"t": t, "c": c.lower(), "w": _num(sh.get("w"), 0.001, 0.05, DEFAULT_W), "p": pts}
        if t in ("text", "measure"):
            s = re.sub(r"[\x00-\x1f\x7f]", " ", str(sh.get("s") or "")).strip()[:80 if t == "text" else 30]
            if t == "text" and not s:
                continue
            d["s"] = s
            d["fs"] = _num(sh.get("fs"), 0.01, 0.15, DEFAULT_FS)
        out.append(d)
    return {"v": 1, "shapes": out}


def markup_of(row):
    try:
        return clean_markup(json.loads(row["markup"])) if row["markup"] else {"v": 1, "shapes": []}
    except (ValueError, PhotoError):
        return {"v": 1, "shapes": []}


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _font(px):
    from PIL import ImageFont
    from pathlib import Path
    f = Path(__file__).resolve().parent.parent / "fonts" / "DejaVuSans-Bold.ttf"
    try:
        return ImageFont.truetype(str(f), max(8, int(px)))
    except OSError:
        return ImageFont.load_default()


def render(data, markup, max_edge=MAX_EDGE):
    """The photo with its markup drawn on it, as JPEG bytes (for the PDF). Drawn at twice the size, then shrunk, so
    the lines are smooth."""
    import math
    from PIL import Image, ImageDraw
    base = Image.open(io.BytesIO(data))
    base.load()
    base = base.convert("RGB")
    if max(base.size) > max_edge:
        base.thumbnail((max_edge, max_edge), Image.LANCZOS)
    W, H = base.size
    k = 2
    over = Image.new("RGBA", (W * k, H * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    L = max(W, H) * k

    def P(p):
        return (p[0] * W * k, p[1] * H * k)

    def label(cx, cy, text, colour, fs, boxed):
        font = _font(fs * L)
        x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font)
        tw, th = x1 - x0, y1 - y0
        pad = max(4, fs * L * 0.28)
        if boxed:   # a measurement: dark text on a white tag with a coloured edge
            box = [cx - tw / 2 - pad, cy - th / 2 - pad, cx + tw / 2 + pad, cy + th / 2 + pad]
            d.rounded_rectangle(box, radius=pad, fill=(255, 255, 255, 235), outline=colour, width=max(2, int(pad / 2.5)))
            d.text((cx - tw / 2 - x0, cy - th / 2 - y0), text, font=font, fill=(17, 24, 39, 255))
        else:       # a label: the colour with a contrasting edge, so it reads on any photo
            dark = sum(colour[:3]) < 380
            edge = (255, 255, 255, 255) if dark else (17, 24, 39, 255)
            d.text((cx - x0, cy - th - y0), text, font=font, fill=colour, stroke_width=max(2, int(fs * L * 0.09)),
                   stroke_fill=edge)

    for sh in clean_markup(markup)["shapes"]:
        colour = _rgb(sh["c"]) + (255,)
        w = max(2, int(round(sh["w"] * L)))
        pts = [P(p) for p in sh["p"]]
        t = sh["t"]
        if t == "pen":
            d.line(pts, fill=colour, width=w, joint="curve")
            r = w / 2
            for x, y in (pts[0], pts[-1]):
                d.ellipse([x - r, y - r, x + r, y + r], fill=colour)
        elif t in ("rect", "circle"):
            (x0, y0), (x1, y1) = pts
            box = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
            if box[2] - box[0] < 1 or box[3] - box[1] < 1:
                continue
            (d.rectangle if t == "rect" else d.ellipse)(box, outline=colour, width=w)
        elif t in ("arrow", "measure"):
            (x0, y0), (x1, y1) = pts
            ang = math.atan2(y1 - y0, x1 - x0)
            if t == "arrow":
                head = max(w * 3.6, L * 0.022)
                bx, by = x1 - head * 0.8 * math.cos(ang), y1 - head * 0.8 * math.sin(ang)
                d.line([(x0, y0), (bx, by)], fill=colour, width=w)
                left = (x1 - head * math.cos(ang - 0.45), y1 - head * math.sin(ang - 0.45))
                right = (x1 - head * math.cos(ang + 0.45), y1 - head * math.sin(ang + 0.45))
                d.polygon([(x1, y1), left, right], fill=colour)
            else:
                d.line([(x0, y0), (x1, y1)], fill=colour, width=w)
                tick = max(w * 3, L * 0.012)
                nx, ny = -math.sin(ang) * tick, math.cos(ang) * tick
                for x, y in ((x0, y0), (x1, y1)):
                    d.line([(x - nx, y - ny), (x + nx, y + ny)], fill=colour, width=w)
                if sh.get("s"):
                    label((x0 + x1) / 2, (y0 + y1) / 2, sh["s"], colour, sh.get("fs") or DEFAULT_FS, True)
        elif t == "text":
            x, y = pts[0]
            label(x, y, sh["s"], colour, sh.get("fs") or DEFAULT_FS, False)
    over = over.resize((W, H), Image.LANCZOS)
    img = base.convert("RGBA")
    img.alpha_composite(over)
    out = io.BytesIO()
    img.convert("RGB").save(out, "JPEG", quality=88, optimize=True)
    return out.getvalue()


def thumb(data, width):
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    im.load()
    im = im.convert("RGB")
    im.thumbnail((width, width * 4), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=82)
    return out.getvalue()


def photos_for_pdf(db, takeoff_id):
    try:
        return db.execute("SELECT * FROM takeoff_photos WHERE takeoff_id=? AND on_pdf=1 ORDER BY sort, id",
                          (takeoff_id,)).fetchall()
    except Exception:
        return []


def add_pdf_pages(pdf, db, doc_id, font):
    """A Photos page on a quote that came from an estimate: the photos ticked "On the quote", with their markup,
    two to a row with their captions."""
    from .drawing import takeoff_for
    t = takeoff_for(db, doc_id)
    if not t:
        return False
    rows = photos_for_pdf(db, t["id"])
    if not rows:
        return False
    pdf.add_page()
    pdf.set_font(font, "B", 16)
    pdf.set_text_color(28, 36, 48)
    pdf.cell(0, 9, "Photos", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font(font, "", 9.5)
    pdf.set_text_color(102, 112, 133)
    pdf.multi_cell(0, 5, f"{t['title']}" + (f" · {t['address']}" if t["address"] else ""), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)
    W = pdf.w - pdf.l_margin - pdf.r_margin
    gap = 6.0
    cw = (W - gap) / 2
    box_h = 70.0
    for i in range(0, len(rows), 2):
        pair = rows[i:i + 2]
        cap_h = 0.0
        pdf.set_font(font, "", 9)
        for r in pair:
            if r["caption"]:
                cap_h = max(cap_h, min(3, len(pdf.multi_cell(cw, 4.6, r["caption"], dry_run=True, output="LINES"))) * 4.6)
        if pdf.get_y() + box_h + cap_h + 4 > 275:
            pdf.add_page()
        y = pdf.get_y()
        for j, r in enumerate(pair):
            x = pdf.l_margin + j * (cw + gap)
            img = r["flat"] or r["data"]
            w, h = r["width"] or 4, r["height"] or 3
            k = min(cw / w, box_h / h)
            iw, ih = w * k, h * k
            pdf.image(io.BytesIO(img), x=x + (cw - iw) / 2, y=y + (box_h - ih) / 2, w=iw, h=ih)
            if r["caption"]:
                pdf.set_xy(x, y + box_h + 1.5)
                pdf.set_font(font, "", 9)
                pdf.set_text_color(28, 36, 48)
                text = r["caption"]
                lines = pdf.multi_cell(cw, 4.6, text, dry_run=True, output="LINES")
                if len(lines) > 3:
                    text = " ".join(lines[:3])[:-1] + "…"
                pdf.multi_cell(cw, 4.6, text, align="C", max_line_height=4.6)
        pdf.set_y(y + box_h + cap_h + 6)
    return True


__all__ = ["prepare", "clean_markup", "render", "add_pdf_pages", "markup_of", "thumb", "PhotoError", "MAX_UPLOAD",
           "MAX_PHOTOS", "MAX_EDGE"]
