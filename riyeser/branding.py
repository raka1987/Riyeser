"""Business details & branding: the customer's own logo, names, tax number and contact details on every document.

One set of details for every Riyeser program on the company file (Accounting, Invoices, Bookings, POS, Estimate):
invoices, quotes, credit notes, statements, receipts, purchase orders, booking confirmations, payslips and the emails
sent from the apps all use business_brand().

Where it lives (all inside the company file, so it travels with backups and restores):
- company.name, abn (the tax number), address, phone, email, bank_* and payment_instructions: the existing columns.
- company.legal_name, website, accent_colour, brand_footers (JSON: one note per document type), logo_removed: new.
- brand_logo (one row): the logo as a trimmed PNG (or a cleaned SVG), a black-and-white copy for receipt printers,
  its size and where it came from.

Riyeser Central's "Your business" step saves a logo next to company.json (%APPDATA%\\Riyeser\\logo.png). A company file
without a logo of its own uses that one (until someone removes the logo in this file), so a logo chosen in Central
shows on documents straight away; "Use the logo from Riyeser Central" copies it into the company file.
"""
import base64
import hashlib
import io
import json
import os
import re

from . import countries as C

MAX_UPLOAD = 2 * 1024 * 1024        # the same limit as Central's "Your business" step
MAX_SVG = 512 * 1024
MAX_SIDE = 1200                     # px: plenty for print at the sizes documents use (60 mm wide at 500 dpi)
MONO_WIDTH = 576                    # px: an 80 mm receipt printer's full width at 203 dpi (58 mm is 384)
DEFAULT_ACCENT = "#102344"          # navy
FOOTER_KINDS = (("invoice", "Invoices"), ("quote", "Quotes and estimates"), ("credit", "Credit notes"),
                ("statement", "Statements"), ("receipt", "Receipts (payments and the till)"),
                ("purchase", "Purchase orders"), ("booking", "Booking confirmations and reminders"),
                ("payslip", "Payslips"))
COLUMNS = (("legal_name", "TEXT"), ("website", "TEXT"), ("accent_colour", "TEXT"), ("brand_footers", "TEXT"),
           ("logo_removed", "INTEGER NOT NULL DEFAULT 0"))


class LogoError(ValueError):
    """A picture that can't be used as a logo (the message says why, in plain English)."""


def ensure_schema(db):
    have = {r["name"] for r in db.execute("PRAGMA table_info(company)")}
    for col, ddl in COLUMNS:
        if col not in have:
            db.execute(f"ALTER TABLE company ADD COLUMN {col} {ddl}")
    db.execute("""CREATE TABLE IF NOT EXISTS brand_logo (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        image BLOB NOT NULL,          -- the logo: a trimmed PNG (or JPEG photo), or a cleaned SVG
        mime TEXT NOT NULL,           -- image/png, image/jpeg, image/svg+xml
        mono BLOB,                    -- black and white PNG for receipt printers (NULL for SVG: printed greyscale)
        width INTEGER NOT NULL, height INTEGER NOT NULL,   -- px (SVG: its viewBox), so it's never stretched
        source TEXT,                  -- 'upload' or 'central'
        sha TEXT,                     -- of the picture it was made from (to tell whether Central's logo changed)
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")


# ---------------------------------------------------------------- logo checks and trimming
def sniff(data):
    """'png', 'jpeg', 'svg' or None, from the file's own bytes (never its name)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    head = data[:2048].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if (head.startswith(b"<?xml") or head.startswith(b"<svg") or head.startswith(b"<!--")) and b"<svg" in data[:8192].lower():
        return "svg"
    return None


def process_logo(data, filename=""):
    """Check an uploaded logo and get it ready: {image, mime, mono, width, height, sha}. Raises LogoError."""
    if not data:
        raise LogoError("Choose a picture of your logo first.")
    if len(data) > MAX_UPLOAD:
        raise LogoError(f"That picture is {len(data) / 1048576:.1f} MB. Choose one under 2 MB "
                        "(a PNG, JPG or SVG of your logo).")
    kind = sniff(data)
    if kind is None:
        raise LogoError("That file isn't a PNG, JPG or SVG picture. Save your logo as one of those and try again.")
    sha = hashlib.sha256(data).hexdigest()
    if kind == "svg":
        svg, w, h = clean_svg(data)
        return dict(image=svg, mime="image/svg+xml", mono=None, width=w, height=h, sha=sha)
    return dict(_raster(data, kind), sha=sha)


def _raster(data, kind):
    from PIL import Image, ImageChops, ImageOps, UnidentifiedImageError
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise LogoError("That picture couldn't be opened (it may be damaged). Save your logo again and try again.")
    if im.width * im.height > 40_000_000:
        raise LogoError("That picture is too big to use as a logo. Save a smaller copy (under 4000 pixels wide).")
    im = ImageOps.exif_transpose(im)
    rgba = im.convert("RGBA")
    # trim: transparent edges, or edges the same colour as the corner (a white or coloured margin)
    alpha = rgba.getchannel("A")
    if alpha.getextrema()[0] < 250:
        box = alpha.point(lambda a: 255 if a > 8 else 0).getbbox()
    else:
        rgb = rgba.convert("RGB")
        bg = Image.new("RGB", rgb.size, rgb.getpixel((0, 0)))
        diff = ImageChops.difference(rgb, bg).convert("L").point(lambda v: 255 if v > 24 else 0)
        box = diff.getbbox()
        if not box and min(rgb.getpixel((0, 0))) < 235:
            box = (0, 0, rgb.width, rgb.height)   # one solid colour block (not blank paper): keep it whole
    if not box:
        raise LogoError("That picture is empty (all one colour). Choose the picture of your logo.")
    l, t, r, b = box
    pad = max(2, round(max(r - l, b - t) * 0.02))
    rgba = rgba.crop((max(0, l - pad), max(0, t - pad), min(rgba.width, r + pad), min(rgba.height, b + pad)))
    if max(rgba.size) > MAX_SIDE:
        rgba.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    if rgba.width < 16 or rgba.height < 8:
        raise LogoError("That picture is too small to print clearly. Choose a larger copy of your logo.")
    out = io.BytesIO()
    transparent = rgba.getchannel("A").getextrema()[0] < 250
    if kind == "jpeg" and not transparent:
        rgba.convert("RGB").save(out, "JPEG", quality=90, optimize=True)
        mime = "image/jpeg"
    else:
        rgba.save(out, "PNG", optimize=True)
        mime = "image/png"
    return dict(image=out.getvalue(), mime=mime, mono=_mono(rgba), width=rgba.width, height=rgba.height)


def _mono(rgba):
    """Black on white, dithered, at most a receipt printer's width: prints crisply on thermal paper."""
    from PIL import Image, ImageOps
    flat = Image.new("RGB", rgba.size, (255, 255, 255))
    flat.paste(rgba, mask=rgba.getchannel("A"))
    grey = ImageOps.autocontrast(flat.convert("L"), cutoff=1)
    if grey.width > MONO_WIDTH:
        grey = grey.resize((MONO_WIDTH, max(1, round(grey.height * MONO_WIDTH / grey.width))), Image.LANCZOS)
    out = io.BytesIO()
    grey.convert("1").save(out, "PNG", optimize=True)
    return out.getvalue()


_SVG_BAD = re.compile(rb"<\s*(script|foreignObject|iframe|object|embed|audio|video)\b|\bon[a-z]+\s*=|javascript:|"
                      rb"<!ENTITY|<!DOCTYPE", re.I)
_SVG_HREF = re.compile(rb"""(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image/(?:png|jpe?g);base64,)""", re.I)


def clean_svg(data):
    """A safe SVG and its width/height (from the viewBox, else width/height). Raises LogoError."""
    if len(data) > MAX_SVG:
        raise LogoError("That SVG is over 512 KB. Export a simpler copy of your logo (or a PNG).")
    if _SVG_BAD.search(data) or _SVG_HREF.search(data):
        raise LogoError("That SVG has scripts or links to other files in it, so it can't be used. "
                        "Export it again as a plain SVG, or use a PNG.")
    text = data.decode("utf-8", "replace")
    m = re.search(r"<svg\b[^>]*>", text, re.I | re.S)
    if not m:
        raise LogoError("That SVG couldn't be read. Export it again, or use a PNG.")
    tag = m.group(0)
    vb = re.search(r"""viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)""", tag)

    def num(attr):
        x = re.search(attr + r"""\s*=\s*["']\s*([\d.]+)\s*(px)?\s*["']""", tag)
        return float(x.group(1)) if x else None
    if vb:
        w, h = float(vb.group(3)), float(vb.group(4))
    else:
        w, h = num(r"\bwidth"), num(r"\bheight")
    if not w or not h:
        raise LogoError("That SVG has no size. Export it again with its size (viewBox) set, or use a PNG.")
    if not vb:   # give it a viewBox so it scales without stretching
        tag2 = tag[:-1].rstrip("/") + f' viewBox="0 0 {w:g} {h:g}"' + ("/>" if tag.endswith("/>") else ">")
        text = text.replace(tag, tag2, 1)
    try:   # it must be well-formed XML (fpdf draws it on PDFs)
        from defusedxml import ElementTree as ET
        ET.fromstring(text.encode("utf-8"))
    except Exception:  # noqa: BLE001 - any parse problem means the same thing to the person
        raise LogoError("That SVG couldn't be read. Export it again, or use a PNG.")
    return text.encode("utf-8"), max(1, round(w)), max(1, round(h))


# ---------------------------------------------------------------- saving
def save_logo(db, logo, source="upload"):
    db.execute("DELETE FROM brand_logo")
    db.execute("INSERT INTO brand_logo (id, image, mime, mono, width, height, source, sha) VALUES (1,?,?,?,?,?,?,?)",
               (logo["image"], logo["mime"], logo["mono"], logo["width"], logo["height"], source, logo.get("sha")))
    db.execute("UPDATE company SET logo_removed=0 WHERE id=1")
    _CACHE.clear()


def remove_logo(db):
    """No logo on documents, not even Central's (until one is chosen again)."""
    db.execute("DELETE FROM brand_logo")
    db.execute("UPDATE company SET logo_removed=1 WHERE id=1")
    _CACHE.clear()


def footers(company):
    try:
        d = json.loads(_get(company, "brand_footers") or "{}")
    except ValueError:
        d = {}
    return {k: str(d.get(k) or "").strip()[:300] for k, _ in FOOTER_KINDS} if isinstance(d, dict) else \
        {k: "" for k, _ in FOOTER_KINDS}


def clean_colour(v):
    v = (v or "").strip()
    return v.lower() if re.fullmatch(r"#[0-9a-fA-F]{6}", v) else None


# ---------------------------------------------------------------- Riyeser Central's logo
_CACHE = {}


def central_logo_file():
    """The logo Central's "Your business" step saved (company.json's 'logo'), or None."""
    from .company_profile import profile_file
    f = profile_file()
    try:
        with open(f, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return None
    p = str((d or {}).get("logo") or "").strip() if isinstance(d, dict) else ""
    if not p:
        return None
    if not os.path.isabs(p):
        p = os.path.join(os.path.dirname(f), p)
    return p if os.path.isfile(p) else None


def central_logo():
    """Central's logo ready to use ({image, mime, mono, width, height, sha}), or None. Cached by file and time."""
    p = central_logo_file()
    if not p:
        return None
    try:
        st = os.stat(p)
        key = ("central", p, st.st_mtime_ns, st.st_size)
        if key not in _CACHE:
            with open(p, "rb") as fh:
                data = fh.read(MAX_UPLOAD + 1)
            try:
                _CACHE[key] = process_logo(data, p)
            except LogoError:
                _CACHE[key] = None
        return _CACHE[key]
    except OSError:
        return None


def central_profile():
    from .company_profile import read
    return read()


# ---------------------------------------------------------------- the brand every document uses
def _get(c, k):
    try:
        return c[k]
    except (KeyError, IndexError, TypeError):
        return None


def _uri(mime, data):
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}" if data else None


def stored_logo(db):
    try:
        r = db.execute("SELECT * FROM brand_logo WHERE id=1").fetchone()
    except Exception:  # noqa: BLE001 - an older file without the table: no logo
        return None
    return dict(image=bytes(r["image"]), mime=r["mime"], mono=bytes(r["mono"]) if r["mono"] else None,
                width=r["width"], height=r["height"], source=r["source"], sha=r["sha"]) if r else None


def business_brand(db, company=None):
    """Everything a document needs to carry the business's branding:
    name, legal_name (only when it differs), logo (bytes, mime, width, height), logo_uri and logo_mono_uri (data URIs
    for HTML), tax_label and tax_number (with the country's label: ABN, TIN, IRD number, GST no., VAT no.), tax_line,
    address, phone, email, website, contact_lines, pay_lines (how to pay), footers (one per document type), accent."""
    co = company if company is not None else db.execute("SELECT * FROM company WHERE id=1").fetchone()
    logo = stored_logo(db)
    from_central = False
    if logo is None and not _get(co, "logo_removed"):
        logo = central_logo()
        from_central = logo is not None
    tl = C.labels(co)
    name = (_get(co, "name") or "").strip()
    legal = (_get(co, "legal_name") or "").strip()
    tax_no = (_get(co, "abn") or "").strip()
    address = (_get(co, "address") or "").strip()
    phone, email, web = ((_get(co, k) or "").strip() for k in ("phone", "email", "website"))
    from .statements import payment_details
    accent = clean_colour(_get(co, "accent_colour")) or DEFAULT_ACCENT
    b = dict(
        name=name, legal_name=legal if legal and legal.lower() != name.lower() else "",
        logo=logo, has_logo=logo is not None, logo_from_central=from_central,
        logo_uri=_uri(logo["mime"], logo["image"]) if logo else None,
        logo_mono_uri=(_uri("image/png", logo["mono"]) if logo and logo["mono"] else
                       _uri(logo["mime"], logo["image"]) if logo else None),
        logo_mono_is_greyscale=bool(logo and not logo["mono"]),   # SVG: shown with a greyscale filter
        logo_ratio=(logo["width"] / logo["height"]) if logo else None,
        tax_label=tl["tax_id"], tax_number=tax_no, tax_line=f"{tl['tax_id']} {tax_no}" if tax_no else "",
        address=address, address_lines=[x.strip() for x in re.split(r"[\r\n]+", address) if x.strip()],
        phone=phone, email=email, website=web,
        contact_lines=[x for x in (phone, email, web) if x],
        pay_lines=payment_details(co) if co is not None else [],
        footers=footers(co), accent=accent, accent_rgb=tuple(int(accent[i:i + 2], 16) for i in (1, 3, 5)))
    return b


def fit(ratio, max_w, max_h):
    """(w, h) inside max_w x max_h with the logo's own proportions: never stretched."""
    if not ratio:
        return 0, 0
    w = min(max_w, max_h * ratio)
    return w, w / ratio


def request_brand():
    """business_brand() for this page, worked out once per request (the Jinja global business_brand())."""
    from flask import g
    if "_brand" not in g:
        from .db import get_db
        g._brand = business_brand(get_db(), g.get("company"))
    return g._brand
