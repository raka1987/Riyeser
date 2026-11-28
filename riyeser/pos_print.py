"""Receipt and docket printing for Riyeser POS 2.11.1: settings, ESC/POS text with an optional logo, and the
scanner's settings.

Printing a receipt or docket on a till that has a printer chosen goes straight to that printer as ESC/POS through the
Windows print spooler (riyeser/drawer.py, the same path as the cash drawer): no Windows print box. Anything that
fails falls back to the Windows print box inside the app, with a plain message. Most 80 mm and 58 mm receipt
printers installed in Windows understand ESC/POS; real printers haven't been tested by Riyeser yet (Beta).

The receipt's logo, name, address, tax number, contacts and footer note come from "Business details & branding"
(riyeser/branding.py business_brand(), see brand_logo and receipt_brand below); the settings here choose what shows. It prints as an ESC/POS
raster image (GS v 0), decoded here without extra libraries (8-bit PNG, not interlaced: what most tools save).
"""
import json
import struct
import zlib
from datetime import datetime

from . import drawer as D

PAPER = {80: dict(chars=42, dots=512, css="72mm"), 58: dict(chars=32, dots=384, css="48mm")}
PRINT_AFTER = {"ask": "Ask each time", "always": "Always print", "never": "Never (email or no receipt)"}
RECEIPT_DEFAULTS = {"logo": True, "show_name": True, "show_address": True, "show_tax_id": True, "show_phone": True,
                    "footer": "Thank you!"}
SCANNER_DEFAULTS = {"prefix": "", "suffix": "", "capture": True, "beep": True, "unknown": "offer", "tested_at": None,
                    "enter": None}
DRAWER_ON_DEFAULTS = {"cash_sale": True, "cash_refund": True, "no_sale": True}
LOGO_MAX_BYTES = 200_000
DOTS_PER_MM = 8          # 203 dpi, what nearly every thermal receipt printer uses
# "Adjust print layout" (per till's receipt printer, per kitchen station's printer)
LAYOUT_DEFAULTS = {"paper": "80", "custom_mm": 70, "chars": "auto", "chars_custom": 42, "left": 0.0, "right": 0.0,
                   "top": 0.0, "bottom": 0.0, "scale": 100, "font": "normal", "logo_mm": 40, "feed": 3, "cut": True}
CHAR_CHOICES = ("auto", "32", "42", "48", "custom")
FONTS = {"small": "Small", "normal": "Normal", "large": "Large"}


def _json(raw, defaults):
    out = dict(defaults)
    try:
        v = json.loads(raw) if raw else {}
        if isinstance(v, dict):
            out.update({k: v[k] for k in defaults if k in v})
    except (ValueError, TypeError):
        pass
    return out


def receipt_settings(db):
    return _json(db.execute("SELECT pos_receipt_settings FROM company WHERE id=1").fetchone()[0], RECEIPT_DEFAULTS)


def scanner_settings(db):
    return _json(db.execute("SELECT pos_scanner_settings FROM company WHERE id=1").fetchone()[0], SCANNER_DEFAULTS)


def drawer_on(till):
    return _json(till["drawer_on"] if till and "drawer_on" in till.keys() else None, DRAWER_ON_DEFAULTS)


def paper(till_or_mm):
    """The paper width in mm (80, 58, or a custom width) for a till / station row, a layout dict, or a number."""
    if isinstance(till_or_mm, (int, float)):
        return int(till_or_mm) if int(till_or_mm) in PAPER else 80
    if isinstance(till_or_mm, dict):
        return till_or_mm["mm"]
    return layout_of(till_or_mm)["mm"] if till_or_mm is not None else 80


def _num(v, lo, hi, step, default):
    try:
        x = round(float(v) / step) * step
    except (TypeError, ValueError):
        return default
    return min(max(x, lo), hi)


def clean_layout(d):
    """Settings from the form (or saved JSON), every value kept in range."""
    d = d or {}
    out = dict(LAYOUT_DEFAULTS)
    out["paper"] = str(d.get("paper")) if str(d.get("paper")) in ("80", "58", "custom") else "80"
    out["custom_mm"] = int(_num(d.get("custom_mm"), 40, 112, 1, 70))
    out["chars"] = str(d.get("chars")) if str(d.get("chars")) in CHAR_CHOICES else "auto"
    out["chars_custom"] = int(_num(d.get("chars_custom"), 16, 80, 1, 42))
    for k in ("left", "right", "top", "bottom"):
        out[k] = float(_num(d.get(k), -10, 10, 0.5, 0.0))
    out["scale"] = int(_num(d.get("scale"), 80, 120, 5, 100))
    out["font"] = d.get("font") if d.get("font") in FONTS else "normal"
    out["logo_mm"] = int(_num(d.get("logo_mm"), 10, 72, 1, 40))
    out["feed"] = int(_num(d.get("feed"), 0, 10, 1, 3))
    out["cut"] = d.get("cut") not in (False, 0, "0", "", None, "off") if "cut" in d else True
    return out


def layout_of(row):
    """A till's (receipt printer) or kitchen station's layout, with the figures the two print paths need:
    mm (paper), printable (mm the printer can reach), chars (per line, straight-to-printer), content_mm and
    offset_mm (the Windows print path)."""
    raw = row["print_layout"] if row is not None and "print_layout" in row.keys() else None
    try:
        saved = json.loads(raw) if raw else None
    except ValueError:
        saved = None
    if not saved and row is not None and "paper_mm" in row.keys():   # 2.11.1's plain 80 / 58 setting
        saved = {"paper": "58" if row["paper_mm"] == 58 else "80"}
    return computed(clean_layout(saved))


def computed(lay):
    lay = dict(lay)
    mm = 58 if lay["paper"] == "58" else lay["custom_mm"] if lay["paper"] == "custom" else 80
    printable = {80: 72, 58: 48}.get(mm, max(mm - 8, 30))
    if lay["chars"] == "custom":
        chars = lay["chars_custom"]
    elif lay["chars"] != "auto":
        chars = int(lay["chars"])
    else:   # font A is 12 dots wide, font B (small) 9
        chars = int(printable * DOTS_PER_MM // (9 if lay["font"] == "small" else 12))
    content = max(printable - max(lay["left"], 0) - max(lay["right"], 0), 20)
    lay.update(mm=mm, printable=printable, cpl=chars, content_mm=content,
               offset_mm=max((mm - printable) / 2 + lay["left"], 0), dots=int(printable * DOTS_PER_MM))
    return lay


def css_vars(lay):
    """The Windows print path (HTML receipts and dockets): the same layout as CSS."""
    fs = {"small": 0.88, "normal": 1.0, "large": 1.18}[lay["font"]] * lay["scale"] / 100
    return dict(page_mm=lay["mm"], width=f"{lay['content_mm']:g}mm", left=f"{lay['offset_mm']:g}mm",
                top=f"{max(lay['top'], 0):g}mm", bottom=f"{max(lay['bottom'], 0):g}mm", font=round(fs, 3),
                logo=f"{lay['logo_mm']}mm")


def _brand(db):
    from .branding import business_brand
    try:
        return business_brand(db)
    except Exception:  # noqa: BLE001 - no company row yet (a brand-new file): print without branding
        return None


def brand_logo(db):
    """The business logo from "Business details & branding" (business_brand()) as (PNG bytes for ESC/POS, data URI for
    the on-screen/Windows-print receipt), or (None, None) when there's no logo. Both are the black-and-white copy made
    for receipt printers. An SVG logo shows on the HTML receipt (greyscale) but isn't sent to the printer as a picture."""
    b = _brand(db)
    if not b or not b["has_logo"]:
        return None, None
    mono, png = (b["logo"] or {}).get("mono"), None
    if mono:
        try:   # the stored copy is a 1-bit PNG; the ESC/POS raster reader takes an ordinary 8-bit one
            import io
            from PIL import Image
            out = io.BytesIO()
            Image.open(io.BytesIO(mono)).convert("L").save(out, "PNG")
            png = out.getvalue()
            check_logo(png)
        except Exception:  # noqa: BLE001 - a logo the printer can't take: the receipt prints without it
            png = None
    return png, b["logo_mono_uri"]


def header_lines(co, rs, labels, brand=None):
    """The lines under the business name, as the settings say: the legal name (with the name), the address, the tax
    number with the country's label, the phone (and the email and website from the business details with it)."""
    b = brand or {}
    out = []
    if rs["show_name"] and b.get("legal_name"):
        out.append(b["legal_name"])
    address = b.get("address_lines") if brand else [x.strip() for x in str(co["address"] or "").replace("\r", "").split("\n") if x.strip()]
    if rs["show_address"] and address:
        out += address
    tax_no = b.get("tax_number") if brand else co["abn"]
    if rs["show_tax_id"] and tax_no:
        out.append(f"{labels['tax_id']} {tax_no}")
    if rs["show_phone"]:
        out += [x for x in ((b.get("phone"), b.get("email"), b.get("website")) if brand else (co["phone"],)) if x]
    return [str(x) for x in out]


def footer_lines(rs, brand=None):
    """The receipt's footer. Left at the standard "Thank you!", it uses the receipt note from the business details."""
    text = (rs.get("footer") or "").replace("\r", "")
    note = ((brand or {}).get("footers") or {}).get("receipt")
    if note and text.strip() == RECEIPT_DEFAULTS["footer"]:
        text = str(note).replace("\r", "")
    return [x for x in text.split("\n") if x.strip()][:4]


def receipt_brand(db, co, rs, labels):
    """(name, header lines, footer lines) for a receipt, from the business details and the receipt settings."""
    b = _brand(db)
    name = ((b["name"] if b else co["name"]) or "") if rs["show_name"] else ""
    return name, header_lines(co, rs, labels, b), footer_lines(rs, b)


# ------------------------------------------------------------ the logo: PNG -> 1-bit raster
def _png_pixels(data):
    """(width, height, rows of grey 0-255) from an 8-bit, non-interlaced PNG. Raises ValueError otherwise."""
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("The logo must be a PNG picture.")
    pos, idat, w = 8, b"", None
    while pos < len(data):
        ln, = struct.unpack(">I", data[pos:pos + 4])
        kind, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if kind == b"IHDR":
            w, h, depth, ctype, _c, _f, inter = struct.unpack(">IIBBBBB", body)
            if depth != 8 or inter or ctype not in (0, 2, 4, 6):
                raise ValueError("Save the logo as an ordinary PNG (8-bit colour, not interlaced).")
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    if w is None or w * h > 4_000_000:
        raise ValueError("The logo picture is too big.")
    bpp = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride, rows, prev, i = w * bpp, [], bytearray(w * bpp), 0
    for _ in range(h):
        f, line = raw[i], bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b, c = prev[x], prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        grey = []
        for x in range(w):
            px = line[x * bpp:(x + 1) * bpp]
            if ctype in (0, 4):
                g, al = px[0], px[1] if ctype == 4 else 255
            else:
                g, al = (px[0] * 299 + px[1] * 587 + px[2] * 114) // 1000, px[3] if ctype == 6 else 255
            grey.append(255 - (255 - g) * al // 255)   # transparent counts as white paper
        rows.append(grey)
    return w, h, rows


def check_logo(data):
    if len(data) > LOGO_MAX_BYTES:
        raise ValueError("The logo file is too big (200 KB at most).")
    _png_pixels(data)


def logo_raster(data, max_dots):
    """ESC/POS GS v 0 raster bytes for the logo, scaled to fit the paper (at most half its width, 120 dots high)."""
    w, h, rows = _png_pixels(data)
    scale = min(1.0, (max_dots * 0.6) / w, 120 / h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    bw = (nw + 7) // 8
    out = bytearray()
    for y in range(nh):
        src = rows[min(h - 1, int(y / scale))]
        for bx in range(bw):
            byte = 0
            for bit in range(8):
                x = bx * 8 + bit
                if x < nw and src[min(w - 1, int(x / scale))] < 128:
                    byte |= 0x80 >> bit
            out.append(byte)
    return b"\x1dv0\x00" + struct.pack("<HH", bw, nh) + bytes(out)


# ------------------------------------------------------------ ESC/POS jobs
def _head(lay):
    """ESC/POS set-up after the reset: font, left margin and print width (GS L / GS W), and the top offset."""
    b = bytearray(D.INIT)
    b += b"\x1bM\x01" if lay["font"] == "small" else b"\x1bM\x00"
    left = int(max(lay["left"], 0) * DOTS_PER_MM)
    width = int(lay["content_mm"] * DOTS_PER_MM)
    if left or lay["right"] > 0 or lay["mm"] != 80:
        b += b"\x1dL" + struct.pack("<H", left) + b"\x1dW" + struct.pack("<H", width)
    if lay["top"] > 0:
        b += b"\x1bJ" + bytes([min(int(lay["top"] * DOTS_PER_MM), 255)])
    return bytes(b)


def _tail(lay):
    """The bottom offset, the feed lines and the cut (GS V 66 n: feed n lines, then cut)."""
    b = bytearray()
    if lay["bottom"] > 0:
        b += b"\x1bJ" + bytes([min(int(lay["bottom"] * DOTS_PER_MM), 255)])
    b += (b"\x1dV\x42" + bytes([lay["feed"]])) if lay["cut"] else (b"\x1bd" + bytes([lay["feed"]]))
    return bytes(b)


def _body(job, lay):
    """A drawer.py job with this layout's start and end, and Large text kept large after each title."""
    if job.startswith(D.INIT):
        job = job[len(D.INIT):]
    if job.endswith(D.CUT):
        job = job[:-len(D.CUT)]
    if lay["font"] == "large":
        job = job.replace(D.NORMAL, b"\x1d!\x01")
        job = b"\x1d!\x01" + job
    return _head(lay) + job + _tail(lay)


def receipt_job(data, lay=None, logo=None, copies=1, kick=False):
    """A receipt (riyeser/drawer.receipt_bytes) laid out for this printer, with the logo on top, copies times. The
    drawer pulse (kick) goes once, at the start."""
    lay = lay if isinstance(lay, dict) else computed(clean_layout({"paper": str(lay or 80)}))
    one = D.receipt_bytes(data, kick=False, width=lay["cpl"])
    pic = b""
    if logo:
        try:
            pic = D.CENTRE + logo_raster(logo, min(lay["logo_mm"], lay["printable"]) * DOTS_PER_MM / 0.6) + b"\n"
        except (ValueError, zlib.error, struct.error):
            pic = b""   # a logo that can't be read never stops the receipt
    one = _body(one, lay)
    if pic:
        one = one[:len(_head(lay))] + pic + one[len(_head(lay)):]
    return (D.PULSE if kick else b"") + one * max(1, min(int(copies or 1), 2))


def docket_job(station, label, order_id, who, items, lay=None, note=None):
    """A kitchen / bar docket: big table or order name, then each item and its note."""
    lay = lay if isinstance(lay, dict) else computed(clean_layout({"paper": str(lay or 80)}))
    width = lay["cpl"]
    b = bytearray(D.CENTRE)
    if station:
        b += D._enc(f"** {station.upper()} **"[:width] + "\n")
    b += D.BOLD_ON + D.DOUBLE + D._enc(str(label).upper()[:width // 2] + "\n") + D.NORMAL + D.BOLD_OFF
    b += D._enc(f"Order #{order_id} - {datetime.now():%H:%M} - {who}"[:width] + "\n") + D.LEFT
    b += D._enc("-" * width + "\n")
    for qty, name, item_note in items:
        b += D.BOLD_ON + D._enc(f"{qty:g} x {name}"[:width] + "\n") + D.BOLD_OFF
        if item_note:
            b += D._enc(f"   ** {item_note}"[:width] + "\n")
    if note:
        b += D._enc("-" * width + "\n" + str(note)[:width * 3] + "\n")
    b += D._enc("-" * width + "\n")
    return _body(bytes(b), lay)


def alignment_job(lay, name=""):
    """The "Print alignment test" slip: a ruler, L / R edge markers on every line edge, TOP and BOTTOM."""
    w = lay["cpl"]
    ruler = "".join(str(i % 10) for i in range(1, w + 1))
    b = bytearray(D.CENTRE + D.BOLD_ON + D._enc("TOP\n") + D.BOLD_OFF + D.LEFT)
    b += D._enc("+" + "-" * (w - 2) + "+\n")
    b += D._enc(ruler + "\n")
    b += D._enc(("L" + " " * (w - 2) + "R\n") * 3)
    mid = f"{lay['mm']:g} mm paper, {w} characters"[:w - 4]
    b += D._enc("L " + mid.center(w - 4) + " R\n")
    b += D._enc(("L" + " " * (w - 2) + "R\n") * 2)
    b += D._enc(ruler + "\n")
    b += D._enc("+" + "-" * (w - 2) + "+\n")
    if name:
        b += D.CENTRE + D._enc(str(name)[:w] + "\n")
    b += D.CENTRE + D.BOLD_ON + D._enc("BOTTOM\n") + D.BOLD_OFF + D.LEFT
    return _body(bytes(b), lay)


def sample_receipt(co, rs, labels, db=None):
    """What the preview and a test print show."""
    name, head, foot = receipt_brand(db, co, rs, labels) if db is not None else (
        co["name"] if rs["show_name"] else "", header_lines(co, rs, labels), footer_lines(rs))
    from .countries import money_format
    return dict(company=name, header=head, money_fmt=money_format(co),
                number="TEST", date=datetime.now().strftime("%Y-%m-%d"), label="Test print",
                lines=[(2, "Flat White", 910), (1, "Banana Bread", 650)], total=1560,
                tax=142 if labels.get("has_tax") else 0, tax_name=labels.get("tax"),
                tenders=[("Cash", 2000)], change=440, footer=foot or [""])


def printer_status(name, printers, available):
    """('ok' | 'missing' | 'none' | 'unknown', message) for a chosen printer on this PC."""
    if not name:
        return "none", "Not set up"
    if not available:
        return "unknown", "Can't check printers on this computer (not Windows)"
    if name not in printers:
        return "missing", f"Problem: “{name}” isn't installed on this PC"
    return "ok", "Set up"
