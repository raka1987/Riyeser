"""Country and tax settings: the business's country fills in its tax name, tax number label, rate and codes,
currency and its format, financial year, date format, time zone, prices including or excluding tax and the tax report.

The presets live in countries.json next to this file (one entry per ISO 3166 country, with an "as of" date and a
source note), so a country is added or corrected there without any code change. A preset is only a starting point:
the person reviews every value and presses "Confirm these settings"; nothing is saved before that, and who confirmed
it and when is recorded. Every value stays editable afterwards, and tax codes can still be added by hand.

Changing the country never touches what's already in the books: documents keep the tax they were saved with, tax codes
already in the file are kept as they are, and a preset's codes are only added when that code isn't there yet.
A company file that never chose a country keeps working exactly as before (Australian labels and the BAS layout).
"""
import json
from datetime import datetime
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).with_name("countries.json")
OTHER = "OTHER"   # "Other / set up myself": every field blank

# What a company file that never chose a country shows (Riyeser's Australian set-up, unchanged)
LEGACY = {"tax_name": "GST", "tax_id_label": "ABN", "tax_report_name": "BAS / GST Summary", "tax_report_layout": "bas",
          "tax_office": "ATO"}
LEGACY_FORMAT = {"symbol": "$", "position": "before", "space": False, "decimals": 2, "decimal": ".", "group": ","}
# Symbols Riyeser Estimate already used for a currency typed in by hand (kept so those files look the same)
LEGACY_SYMBOLS = {"AUD": "$", "NZD": "$", "USD": "$", "CAD": "$", "FJD": "$", "SGD": "$", "HKD": "$", "SBD": "$",
                  "WST": "WS$", "TOP": "T$", "VUV": "VT ", "PGK": "K", "EUR": "€", "GBP": "£", "INR": "₹", "JPY": "¥",
                  "CNY": "¥", "ZAR": "R", "PHP": "₱", "NGN": "₦", "KES": "KSh ", "AED": "AED ", "MYR": "RM",
                  "IDR": "Rp", "THB": "฿"}
KINDS = ("gst", "capital", "gst_free", "export", "input_taxed", "not_reportable")
DATE_FORMATS = {"dmy": "Day/month/year (27/11/2026)", "mdy": "Month/day/year (11/27/2026)",
                "iso": "Year-month-day (2026-11-27)"}
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
NOTE = ("We've filled these in as a starting point. Please check them — you're responsible for your tax settings; "
        "ask your accountant or tax office if unsure.")
RATES_NOTE = "Rates are a starting point — check with your accountant or tax office."
NO_TAX = ("", "none")


# ---------------------------------------------------------------- the data file
@lru_cache(maxsize=1)
def data():
    with open(DATA, encoding="utf-8") as f:
        return json.load(f)


def countries():
    """[(code, name)] sorted by name."""
    return sorted(((cc, e["name"]) for cc, e in data()["countries"].items()), key=lambda x: x[1])


def name_of(cc):
    if not cc:
        return None
    if cc == OTHER:
        return "Other / set up myself"
    e = data()["countries"].get(cc)
    return e["name"] if e else cc


def all_timezones():
    zs = sorted({z for e in data()["countries"].values() for z in e["timezones"]})
    return ["UTC"] + zs


def preset(cc):
    """The country's preset, every key present (None = not filled in). OTHER (or an unknown code) = all blank."""
    blank = {"name": "Other / set up myself", "currency": None, "currency_format": None, "date_format": None,
             "timezones": [], "fy_start_month": None, "prices_include_tax": None, "tax_name": None,
             "tax_id_label": None, "standard_rate": None, "standard_code": None, "tax_codes": [], "report_name": None,
             "report_layout": "generic", "tax_office": None, "note": None, "source": None}
    e = data()["countries"].get(cc or "")
    if not e:
        return dict(blank, code=OTHER)
    return dict(blank, **e, code=cc)


# ---------------------------------------------------------------- company file
COLUMNS = (("country", "TEXT"),                 # ISO code, OTHER, or NULL (never chosen: Australian labels as before)
           ("tax_id_label", "TEXT"),            # ABN, IRD / GST number, TIN, VAT number... (NULL: ABN)
           ("tax_report_name", "TEXT"),         # the tax report's title (NULL: BAS / GST Summary)
           ("tax_report_layout", "TEXT"),       # bas (Australian labels G1, 1A...) or generic (NULL: bas)
           ("tax_office", "TEXT"),              # who the tax is paid to (ATO, Inland Revenue, FRCS...)
           ("timezone", "TEXT"),                # the business's time zone (NULL: from Riyeser Central's country)
           ("prices_include_tax", "INTEGER NOT NULL DEFAULT 0"),  # new invoices start with "Prices include tax"
           ("currency_format", "TEXT"),         # JSON {symbol, position, space, decimals, decimal, group}
           ("country_confirmed_by", "TEXT"),    # who pressed "Confirm these settings"
           ("country_confirmed_at", "TEXT"))


def ensure_schema(db):
    if "active" not in {r["name"] for r in db.execute("PRAGMA table_info(tax_codes)")}:
        db.execute("ALTER TABLE tax_codes ADD COLUMN active INTEGER NOT NULL DEFAULT 1")  # 0 = no longer offered
    have = {r["name"] for r in db.execute("PRAGMA table_info(company)")}
    for col, ddl in COLUMNS + (("tax_name", "TEXT NOT NULL DEFAULT 'GST'"), ("date_format", "TEXT NOT NULL DEFAULT 'iso'")):
        if col not in have:
            db.execute(f"ALTER TABLE company ADD COLUMN {col} {ddl}")


def _get(c, key):
    try:
        return c[key]
    except (KeyError, IndexError, TypeError):
        return None


def has_tax(company):
    return (_get(company, "tax_name") or "GST").strip().lower() not in NO_TAX


def labels(company):
    """The words every screen, invoice, receipt and PDF uses for this company's tax."""
    chosen = bool(_get(company, "country"))
    raw = (_get(company, "tax_name") or "").strip()
    tax = "Tax" if chosen and raw.lower() in NO_TAX else (raw or "GST")
    taxed = not (chosen and raw.lower() in NO_TAX)
    tax_id = (_get(company, "tax_id_label") or "").strip() or ("ABN" if not chosen else "Tax ID")
    report = (_get(company, "tax_report_name") or "").strip() or (
        LEGACY["tax_report_name"] if not chosen else f"{tax} return summary" if taxed else "Tax summary")
    layout = _get(company, "tax_report_layout") or ("bas" if not chosen else "generic")
    office = (_get(company, "tax_office") or "").strip() or (LEGACY["tax_office"] if not chosen else "the tax office")
    return {"tax": tax, "has_tax": taxed, "tax_id": tax_id, "report": report, "layout": layout, "office": office,
            "invoice": "Tax Invoice" if taxed else "Invoice",
            "credit": "Adjustment Note" if not chosen or _get(company, "country") == "AU" else "Credit Note",
            "registered": f"Registered for {tax}" if taxed else "Registered for tax"}


def money_format(company):
    raw = _get(company, "currency_format")
    if raw:
        try:
            f = json.loads(raw)
            if isinstance(f, dict) and f.get("symbol") is not None:
                return dict(LEGACY_FORMAT, **f)
        except ValueError:
            pass
    cur = (_get(company, "currency") or "AUD").upper()
    sym = LEGACY_SYMBOLS.get(cur)
    if sym is None:
        sym = (data()["currencies"].get(cur) or {}).get("symbol") or cur
        sym = sym + " " if sym[-1:].isalpha() else sym   # "CHF 1,234.50", like Estimate showed it
    space = sym.endswith(" ")
    return dict(LEGACY_FORMAT, symbol=sym.strip(), space=space)


def format_money(cents, fmt=None, blank_zero=False):
    """1234567 cents -> '$12,345.67' (or '12.345,67 €', 'CHF 12’345.67', '¥12,346'), like db.fmt_money."""
    from decimal import Decimal, ROUND_HALF_UP
    f = fmt or LEGACY_FORMAT
    c = int(Decimal(str(cents or 0)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if blank_zero and c == 0:
        return ""
    sign, c = ("-" if c < 0 else ""), abs(c)
    if int(f.get("decimals", 2)) == 0:
        body = f"{(c + 50) // 100:,}"
    else:
        body = f"{c // 100:,}" + "\0" + f"{c % 100:02d}"
    body = body.replace(",", "\1").replace("\1", f.get("group", ",")).replace("\0", f.get("decimal", "."))
    sym, sp = f.get("symbol", "$"), " " if f.get("space") else ""
    return sign + (f"{sym}{sp}{body}" if f.get("position", "before") == "before" else f"{body}{sp}{sym}")


def show_date(v, company):
    """A date in the company's format: iso (2026-11-27, the default), dmy (27/11/2026) or mdy (11/27/2026)."""
    if not v:
        return ""
    v = str(v)
    d10 = v[:10]
    try:
        y, m, d = d10.split("-")
    except ValueError:
        return v
    fmt = _get(company, "date_format") or "iso"
    return {"dmy": f"{d}/{m}/{y}", "mdy": f"{m}/{d}/{y}"}.get(fmt, d10) + v[10:]


# ---------------------------------------------------------------- review and confirm
def review(db, cc, company=None):
    """What choosing this country would set, for the review screen: every value plus each preset tax code with what
    would happen to it (added, already there, or already there with a different rate: kept)."""
    p = preset(cc)
    have = {r["code"]: r for r in db.execute("SELECT * FROM tax_codes")} if db is not None else {}
    codes = []
    for t in p["tax_codes"]:
        h = have.get(t["code"])
        if not h:
            status = "add"
        elif abs((h["rate"] or 0) - t["rate"]) < 1e-9 and h["kind"] == t["kind"]:
            status = "same"
        else:
            status = "different"
        # same purpose (kind), different rate: the review offers "Change my GST code to 15% for new transactions"
        can_change = status == "different" and h["kind"] == t["kind"] and t["kind"] in ("gst", "capital")
        codes.append(dict(t, status=status, yours=dict(h) if h else None, can_change=can_change,
                          retired_as=retired_code(db, t["code"], h["rate"]) if can_change else None))
    tzs = p["timezones"]
    return {"cc": p["code"], "p": p, "codes": codes,
            "timezone": tzs[0] if len(tzs) == 1 else None,
            "timezones": tzs or all_timezones(),
            "money_example": format_money(123456, p["currency_format"]) if p["currency_format"] else None}


def _clean(s, n=40):
    return (s or "").strip()[:n]


def confirm(db, form, who):
    """Save the reviewed settings (the person pressed "Confirm these settings"). form: the review screen's fields.
    Past documents and postings are never changed; tax codes already in the file are kept as they are, and the
    preset's codes the person kept ticked are added only when that code isn't there yet. Returns [codes added]."""
    from .db import audit
    cc, upd = settings_from_form(form)
    upd.update(country_confirmed_by=who, country_confirmed_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    db.execute("UPDATE company SET " + ", ".join(f"{k}=?" for k in upd) + " WHERE id=1", tuple(upd.values()))
    added = add_codes(db, wanted_codes(form))
    for code, rate in rate_changes(db, form):
        change_rate(db, code, rate, who)
    ensure_not_reportable(db)
    audit(db, "country_settings", f"Country and tax settings confirmed by {who}: {name_of(cc)}"
          + (f"; tax codes added: {', '.join(added)}" if added else ""))
    db.commit()
    return added


def rate_changes(db, form):
    """[(code, new rate)] the person ticked on the review screen ("Change my GST code to 15% for new transactions").
    Only offered (and only done) for a code already in the file with the same kind and a different rate."""
    cc = (form.get("country") or "").strip().upper()
    rate = _rate(form)
    p = preset(cc)
    std_code = p.get("standard_code")
    out = []
    for t in review(db, cc)["codes"]:
        if t["can_change"] and form.get(f"change_{t['code']}") == "1":
            out.append((t["code"], rate if t["code"] == std_code and rate is not None else t["rate"]))
    return out


def retired_code(db, code, old_rate):
    """The name the old code is kept under: GST -> GST10 (GST10-2, ... if taken)."""
    base = f"{code}{old_rate:g}".replace(".", "_")[:8]
    have = {r["code"] for r in db.execute("SELECT code FROM tax_codes")} if db is not None else set()
    name, n = base, 2
    while name in have:
        name, n = f"{base[:6]}-{n}", n + 1
    return name


def change_rate(db, code, new_rate, who):
    """A new rate for new transactions only. Document and journal lines keep their own net and tax amounts, but not
    the rate: quotes with options, unsent quotes converted later, credit notes copied from an invoice and the tax
    detail report all read the rate from the code. So the rate on the existing code is never changed. Instead:
      1. the existing code keeps its id and rate, is renamed (GST -> GST10) and is no longer offered (In use off),
         so everything already saved still points at it, at the old rate;
      2. a new code with the original name (GST) is added at the new rate, same kind and tax accounts;
      3. the defaults for new transactions (accounts, items, contacts) move to the new code.
    Audited."""
    old = db.execute("SELECT * FROM tax_codes WHERE code=?", (code,)).fetchone()
    if not old or abs((old["rate"] or 0) - new_rate) < 1e-9:
        return None
    today = datetime.now().strftime("%Y-%m-%d")
    keep_as = retired_code(db, code, old["rate"])
    db.execute("UPDATE tax_codes SET code=?, name=?, active=0 WHERE id=?",
               (keep_as, f"{old['name']} ({old['rate']:g}%, until {today})"[:80], old["id"]))
    tax = db.execute("SELECT tax_name FROM company WHERE id=1").fetchone()
    tax = (tax["tax_name"] if tax and tax["tax_name"] and tax["tax_name"].lower() not in NO_TAX else code)
    new_id = db.execute("INSERT INTO tax_codes (code, name, rate, kind, collected_account_id, paid_account_id, active)"
                        " VALUES (?,?,?,?,?,?,1)", (code, f"{tax} {new_rate:g}%", float(new_rate), old["kind"],
                                                    old["collected_account_id"], old["paid_account_id"])).lastrowid
    for table, col in (("accounts", "tax_code_id"), ("contacts", "tax_code_id"), ("items", "sale_tax_code_id"),
                       ("items", "purchase_tax_code_id")):
        db.execute(f"UPDATE {table} SET {col}=? WHERE {col}=?", (new_id, old["id"]))
    from .db import audit
    audit(db, "tax_rate_change", f"{code} changed from {old['rate']:g}% to {new_rate:g}% for new transactions by {who}. "
          f"The {old['rate']:g}% code is kept as {keep_as} (no longer offered), so past invoices, quotes and postings "
          f"keep {old['rate']:g}%.")
    return keep_as


def settings_from_form(form):
    """(country, {company column: value}) from the review screen, checked (ValueError says what to fix)."""
    cc = (form.get("country") or "").strip().upper()
    if cc != OTHER and cc not in data()["countries"]:
        raise ValueError("Choose your country from the list (or Other / set up myself).")
    cur = _clean(form.get("currency"), 3).upper()
    if cur and (len(cur) != 3 or not cur.isalpha()):
        raise ValueError("The currency is a 3-letter code, like AUD, NZD, FJD, USD or EUR.")
    tz = _clean(form.get("timezone"), 64)
    if tz:
        from .online import tz_ok
        if not tz_ok(tz):
            raise ValueError("Choose a time zone from the list.")
    fy = form.get("fy_start_month")
    fy = int(fy) if fy and str(fy).isdigit() and 1 <= int(fy) <= 12 else None
    datef = form.get("date_format") if form.get("date_format") in DATE_FORMATS else None
    tax = _clean(form.get("tax_name"), 20)
    no_tax = form.get("no_tax") == "1" or tax.lower() in NO_TAX
    _rate(form)  # checked before anything is saved
    sym = (form.get("currency_symbol") or "").strip()[:8]
    fmt = None
    if sym or cur:
        p = preset(cc)
        base = dict(LEGACY_FORMAT, **(p["currency_format"] or {})) if (p["currency"] or "") == cur or not cur else \
            dict(LEGACY_FORMAT, symbol=(data()["currencies"].get(cur) or {}).get("symbol") or cur, space=False)
        base["symbol"] = sym or base["symbol"]
        if form.get("currency_position") in ("before", "after"):
            base["position"] = form["currency_position"]
        fmt = json.dumps(base, ensure_ascii=False)

    upd = {"country": cc, "tax_name": "None" if no_tax else (tax or "Tax"),
           "tax_id_label": _clean(form.get("tax_id_label"), 40) or None,
           "tax_report_name": _clean(form.get("report_name"), 60) or None,
           "tax_report_layout": "bas" if form.get("report_layout") == "bas" else "generic",
           "tax_office": _clean(form.get("tax_office"), 40) or None,
           "prices_include_tax": 1 if form.get("prices_include_tax") == "1" else 0}
    if no_tax:
        upd["gst_registered"] = 0
    if cur:
        upd["currency"] = cur
    if fmt:
        upd["currency_format"] = fmt
    if fy:
        upd["fy_start_month"] = fy
    if datef:
        upd["date_format"] = datef
    if tz:
        upd["timezone"] = tz
    return cc, upd


def guess_country(text):
    """Riyeser Central's company profile says 'Fiji', 'fj', 'New Zealand'... -> 'FJ', 'NZ' (None if unsure)."""
    t = (text or "").strip()
    if not t:
        return None
    if t.upper() in data()["countries"]:
        return t.upper()
    low = t.lower()
    alias = {"uk": "GB", "england": "GB", "usa": "US", "united states of america": "US", "png": "PG"}
    if low in alias:
        return alias[low]
    for cc, e in data()["countries"].items():
        if e["name"].lower() == low:
            return cc
    return None


def _rate(form):
    rate = (form.get("standard_rate") or "").strip().rstrip("%").strip()
    try:
        rate = float(rate) if rate else None
    except ValueError:
        raise ValueError("The standard rate is a number, like 10 or 12.5.")
    if rate is not None and not 0 <= rate < 100:
        raise ValueError("The standard rate should be between 0 and 100.")
    return rate


def wanted_codes(form):
    """The tax codes the review screen asked for: the preset's codes the person kept ticked (the standard one at the
    rate they confirmed), or a standard code at the rate they typed when the preset has none (US sales tax, Other)."""
    cc = (form.get("country") or "").strip().upper()
    tax = _clean(form.get("tax_name"), 20)
    if form.get("no_tax") == "1" or tax.lower() in NO_TAX:
        return []
    rate = _rate(form)
    p = preset(cc)
    std_code = p.get("standard_code") or (tax.upper() if tax.isalpha() and len(tax) <= 5 else "STD")
    out = []
    for t in p["tax_codes"]:
        if form.get(f"add_{t['code']}") != "1":
            continue
        out.append(dict(t, rate=rate if t["code"] == std_code and rate is not None else t["rate"]))
    if rate is not None and not any(t["code"] == std_code for t in p["tax_codes"]) and form.get("add_standard") == "1":
        out.insert(0, {"code": std_code, "name": f"{tax or 'Tax'} {rate:g}%", "rate": rate, "kind": "gst"})
    return out


def add_codes(db, codes):
    """Add each tax code that isn't in the file yet (by its code). Existing codes are never changed."""
    have = {r["code"] for r in db.execute("SELECT code FROM tax_codes")}
    acc = {}
    for key in ("gst_collected", "gst_paid"):
        r = db.execute("SELECT account_id FROM linked_accounts WHERE key=?", (key,)).fetchone()
        acc[key] = r["account_id"] if r else None
    added = []
    for t in codes:
        code = (t.get("code") or "").strip().upper()[:8]
        if not code or code in have or t.get("kind") not in KINDS:
            continue
        taxed = t["kind"] in ("gst", "capital")
        db.execute("INSERT INTO tax_codes (code, name, rate, kind, collected_account_id, paid_account_id)"
                   " VALUES (?,?,?,?,?,?)", (code, (t.get("name") or code)[:60], float(t.get("rate") or 0), t["kind"],
                                             acc["gst_collected"] if taxed else None, acc["gst_paid"] if taxed else None))
        have.add(code)
        added.append(code)
    return added


def ensure_not_reportable(db):
    """Every company file keeps a not-reportable code (transfers, loans, owner's money)."""
    if not db.execute("SELECT 1 FROM tax_codes WHERE code='N-T'").fetchone():
        db.execute("INSERT INTO tax_codes (code, name, rate, kind) VALUES ('N-T','Not Reportable',0,'not_reportable')")


def seed_codes(cc):
    """The tax codes a brand-new company file in this country starts with: [(code, name, rate, kind)], always with
    N-T. Australia (and a file with no country) gets Riyeser's Australian set."""
    from .db import DEFAULT_TAX_CODES
    if not cc or cc == "AU":
        return list(DEFAULT_TAX_CODES)
    out = [(t["code"], t["name"], float(t["rate"]), t["kind"]) for t in preset(cc)["tax_codes"]]
    if not any(c == "N-T" for c, *_ in out):
        out.append(("N-T", "Not Reportable", 0.0, "not_reportable"))
    return out


def tax_code_id(db, role):
    """The tax code a screen uses when it needs "the" standard (taxable), free (zero-rated or exempt) or
    not-reportable code, whatever this file's codes are called (GST, VAT, FRE, ZER, N-T...)."""
    if role == "standard":
        q = ("SELECT id FROM tax_codes WHERE kind='gst' ORDER BY active DESC, code='GST' DESC, code='VAT' DESC, rate DESC,"
             " id LIMIT 1")
    elif role == "free":
        q = ("SELECT id FROM tax_codes WHERE kind IN ('gst_free','export','input_taxed') ORDER BY active DESC, code='FRE' DESC,"
             " kind='gst_free' DESC, kind='export' DESC, id LIMIT 1")
    else:
        q = "SELECT id FROM tax_codes WHERE kind='not_reportable' ORDER BY code='N-T' DESC, id LIMIT 1"
    r = db.execute(q).fetchone()
    if r is None and role != "none":
        return tax_code_id(db, "none")
    return r["id"] if r else None


# ---------------------------------------------------------------- for templates (the company that's open)
def _open_company():
    from flask import g, has_app_context
    if not has_app_context():
        return None
    return g.get("company")


def request_money(cents, blank_zero=False):
    """The |money filter: the open company's currency and format (no company: $1,234.56, as before)."""
    from flask import g, has_app_context
    co = _open_company()
    if co is None:
        return format_money(cents, None, blank_zero)
    f = g.get("_money_fmt")
    if f is None:
        f = money_format(co)
        g._money_fmt = f
    return format_money(cents, f, blank_zero)


def request_labels():
    return labels(_open_company() or {})


def request_date(v):
    return show_date(v, _open_company() or {})
