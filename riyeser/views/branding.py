"""Setup, Business details & branding: the same page in every Riyeser program on the company file.

The business's name, legal name, tax number (with its country's label), address, phone, email, website, logo, how
customers pay, a footer note for each kind of document and an accent colour. Every invoice, quote, credit note,
statement, receipt, purchase order, booking confirmation, payslip and email uses them (riyeser/branding.py).
"""
from flask import Blueprint, render_template, request, redirect, url_for, flash, g

from .. import branding as B
from ..db import get_db, audit
from . import guarded

bp = Blueprint("branding", __name__, url_prefix="/setup/branding")

TEXT = ("name", "legal_name", "abn", "address", "phone", "email", "website")
PAY = ("bank_account_name", "bank_name", "bank_bsb", "bank_account_no", "payment_instructions")
FOOTER_HINTS = {"invoice": "e.g. Thank you for your business. Payment within 14 days, please.",
                "quote": "e.g. This quote is valid for 30 days.", "credit": "", "statement": "",
                "receipt": "e.g. Thank you! Returns within 14 days with your receipt.", "purchase": "",
                "booking": "e.g. Need to change your time? Just reply or call us.", "payslip": ""}


@bp.route("/", methods=["GET"])
def index():
    db = get_db()
    co = dict(db.execute("SELECT * FROM company WHERE id=1").fetchone())
    central = B.central_profile()
    # Prefill blanks from Riyeser Central's "Your business" details (shown, saved when the person saves)
    prefill = {}
    for field, key in (("legal_name", "legal_name"), ("abn", "tax_number"), ("address", "address"),
                       ("phone", "phone"), ("email", "email")):
        if not (co.get(field) or "").strip() and central.get(key):
            co[field] = central[key]
            prefill[field] = True
    stored = B.stored_logo(db)
    cl = B.central_logo()
    brand = B.business_brand(db)
    return render_template("core/branding.html", co=co, prefill=prefill, brand=brand, stored=stored,
                           central_logo=cl, central_logo_uri=B._uri(cl["mime"], cl["image"]) if cl else None,
                           central_differs=bool(cl and (not stored or stored.get("sha") != cl["sha"])),
                           footers=B.footers(co), footer_kinds=B.FOOTER_KINDS, hints=FOOTER_HINTS,
                           default_accent=B.DEFAULT_ACCENT, max_mb=B.MAX_UPLOAD // 1048576)


@bp.route("/", methods=["POST"])
@guarded
def save():
    db = get_db()
    f = request.form
    name = (f.get("name") or "").strip()
    if not name:
        raise ValueError("Enter your business name.")
    vals = {k: (f.get(k) or "").strip()[:500] or None for k in TEXT + PAY}
    vals["name"] = name[:200]
    email = vals["email"]
    if email and ("@" not in email or " " in email):
        raise ValueError(f"\"{email}\" isn't an email address.")
    colour = B.clean_colour(f.get("accent_colour"))
    if f.get("accent_default") or colour == B.DEFAULT_ACCENT:
        colour = None
    upload = request.files.get("logo")
    new_logo = None
    if upload and upload.filename and (f.get("logo_action") or "") not in ("remove", "central"):
        # checked first: a picture that can't be used changes nothing (the message says why)
        new_logo = B.process_logo(upload.read(B.MAX_UPLOAD + 1), upload.filename)
    import json
    notes = {k: (f.get(f"footer_{k}") or "").strip()[:300] for k, _ in B.FOOTER_KINDS}
    sets = ", ".join(f"{k}=?" for k in vals) + ", accent_colour=?, brand_footers=?"
    db.execute(f"UPDATE company SET {sets} WHERE id=1",
               (*vals.values(), colour, json.dumps({k: v for k, v in notes.items() if v})))
    action = f.get("logo_action") or ""
    msg = "Business details saved."
    if action == "remove":
        B.remove_logo(db)
        msg = "Logo removed. Your documents show your business name instead."
    elif action == "central":
        cl = B.central_logo()
        if not cl:
            raise ValueError("Riyeser Central doesn't have a logo saved on this computer.")
        B.save_logo(db, cl, source="central")
        msg = "Logo from Riyeser Central saved in your company file."
    elif new_logo:
        B.save_logo(db, new_logo)
        msg = "Logo saved. It's on your documents now, and in your backups."
    audit(db, "branding", "Business details & branding updated")
    flash(msg, "ok")
    return redirect(url_for("branding.index"))
