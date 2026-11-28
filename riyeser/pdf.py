"""Real PDF files for invoices, quotes, bills, statements and payslips (no browser needed),
and the shared Riyeser documents folder other Riyeser modules (Desk Assistant, Payroll) use."""
import io
import os
import re
from datetime import date
from pathlib import Path

from fpdf import FPDF

import contextvars

from . import countries as C

_MONEY = contextvars.ContextVar("riyeser_pdf_money", default=None)


def fmt_money(cents, blank_zero=False):
    """Money in the currency and format of the company whose PDF is being made (set by _PDF)."""
    return C.format_money(cents, _MONEY.get(), blank_zero)

BRAND = (14, 107, 99)
INK = (28, 36, 48)
MUTED = (102, 112, 133)
LINE = (228, 231, 236)


def docs_root() -> Path:
    """Documents\\Riyeser (shared by all Riyeser modules). Override with RIYESER_DOCS."""
    if os.environ.get("RIYESER_DOCS"):
        return Path(os.environ["RIYESER_DOCS"])
    home = Path.home()
    docs = home / "Documents"
    return (docs if docs.is_dir() else home) / "Riyeser"


def safe_name(s):
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", s or "").strip().rstrip(".")
    return re.sub(r"\s+", " ", s)[:80] or "document"


# A Unicode font is embedded (S45), so names like "Nguyễn Văn An", "Nadī" or "तानोआ" print as typed, not as "?".
# DejaVu Sans (Bitstream Vera licence) covers Latin, Greek, Cyrillic and more; Noto Sans Devanagari (SIL OFL 1.1)
# is the fallback for Hindi. Both licences allow bundling (riyeser/fonts/LICENSE-*.txt). Chinese, Japanese and
# Korean aren't covered (those fonts are 10-20 MB).
FONTS = Path(__file__).with_name("fonts")
FONT = "RiyeserSans"


def _t(s):
    return str(s if s is not None else "")


# The Riyeser wordmark for the "produced with" line (the same file as the website's assets/logo-wordmark.svg).
WORDMARK = Path(__file__).with_name("static") / "logo-wordmark.svg"
WORDMARK_RATIO = 388 / 121          # its viewBox: width / height
_WM_CACHE = {}


def _wordmark():
    """The wordmark's SVG as bytes (its <title> left out: fpdf only draws the shapes), or None if it's missing."""
    if "svg" not in _WM_CACHE:
        try:
            _WM_CACHE["svg"] = re.sub(r"<title>.*?</title>", "", WORDMARK.read_text(encoding="utf-8")).encode("utf-8")
        except OSError:
            _WM_CACHE["svg"] = None
    svg = _WM_CACHE["svg"]
    return None if svg is None else io.BytesIO(svg)


class _PDF(FPDF):
    def __init__(self, company):
        super().__init__(format="A4")
        self.add_font(FONT, "", str(FONTS / "DejaVuSans.ttf"))
        self.add_font(FONT, "B", str(FONTS / "DejaVuSans-Bold.ttf"))
        self.add_font("RiyeserDevanagari", "", str(FONTS / "NotoSansDevanagari-Regular.ttf"))
        self.add_font("RiyeserDevanagari", "B", str(FONTS / "NotoSansDevanagari-Bold.ttf"))
        self.set_fallback_fonts(["RiyeserDevanagari"])
        try:  # joins Devanagari letters properly when HarfBuzz is installed
            import uharfbuzz  # noqa: F401
            self.set_text_shaping(True)
        except ImportError:
            pass
        self.company = company
        self.tl = C.labels(company)          # GST / VAT / Tax, ABN / TIN / VAT number (riyeser/countries.py)
        _MONEY.set(C.money_format(company))
        self.set_auto_page_break(True, 18)
        self.set_margins(16, 16, 16)
        self.set_title(company["name"])
        self.set_creator("Riyeser Accounting")

    def footer(self):
        self.set_y(-12)
        self.set_font(FONT, "", 7.5)
        self.set_text_color(*MUTED)
        text = _t(f"{self.company['name']}  -  page {self.page_no()}  -  produced with ")
        logo = _wordmark()
        if logo is None:
            self.cell(0, 5, text + "Riyeser", align="C")
            return
        # "... produced with" and the Riyeser wordmark (static/logo-wordmark.svg), centred together on the line
        # (3.4 mm high: its capitals match the 7.5 pt text; its baseline, 78/121 of the way down, sits on the text's)
        h, gap = 3.4, 0.6
        w = h * WORDMARK_RATIO
        tw = self.get_string_width(text)
        x = (self.w - tw - gap - w) / 2
        y = self.get_y()
        self.set_x(x)
        self.cell(tw, 5, text)
        self.image(logo, x=x + tw + gap, y=y + 1.2, h=h, alt_text="Riyeser")

    def header_block(self, title, number, rows):
        c = self.company
        self.set_font(FONT, "B", 22)
        self.set_text_color(*BRAND)
        self.cell(100, 10, _t(title))
        self.set_font(FONT, "B", 11)
        self.set_text_color(*INK)
        self.cell(0, 6, _t(c["name"]), align="R", new_x="LMARGIN", new_y="NEXT")
        self.set_font(FONT, "", 9)
        self.set_text_color(*MUTED)
        right = [c["address"] or "", f"{self.tl['tax_id']} {c['abn']}" if c["abn"] else "", c["phone"] or "", c["email"] or ""]
        y = self.get_y()
        self.set_xy(16, y + 2)
        self.set_font(FONT, "B", 11)
        self.set_text_color(*INK)
        self.cell(100, 6, _t(number))
        self.set_font(FONT, "", 9)
        self.set_text_color(*MUTED)
        for i, line in enumerate([r for r in right if r]):
            self.set_xy(110, y + i * 4.6)
            self.cell(0, 4.6, _t(line), align="R")
        self.set_xy(16, y + 9)
        for label, val in rows:
            self.set_x(16)
            self.cell(24, 5, _t(label))
            self.set_text_color(*INK)
            self.cell(70, 5, _t(val), new_x="LMARGIN", new_y="NEXT")
            self.set_text_color(*MUTED)
        self.ln(4)

    def party(self, label, name, address=None, abn=None):
        self.set_font(FONT, "", 8.5)
        self.set_text_color(*MUTED)
        self.cell(0, 5, _t(label.upper()), new_x="LMARGIN", new_y="NEXT")
        self.set_font(FONT, "B", 11)
        self.set_text_color(*INK)
        self.cell(0, 6, _t(name), new_x="LMARGIN", new_y="NEXT")
        self.set_font(FONT, "", 9.5)
        for line in [address or "", f"{self.tl['tax_id']} {abn}" if abn else ""]:
            if line:
                self.multi_cell(90, 4.8, _t(line), new_x="LMARGIN", new_y="NEXT")
        self.ln(5)

    def table(self, cols, rows, widths, aligns):
        self.set_font(FONT, "B", 8.5)
        self.set_fill_color(245, 247, 249)
        self.set_text_color(*MUTED)
        for c, w, a in zip(cols, widths, aligns):
            self.cell(w, 7, _t(c.upper()), fill=True, align=a)
        self.ln()
        self.set_font(FONT, "", 9.5)
        self.set_text_color(*INK)
        self.set_draw_color(*LINE)
        for r in rows:
            cells = [_t(v) for v in r]
            tallest = max(len(self.multi_cell(w, 5.5, v, dry_run=True, output="LINES")) for v, w in zip(cells, widths))
            if self.get_y() + tallest * 5.5 > 270:
                self.add_page()
            y0, x = self.get_y(), self.l_margin
            for v, w, a in zip(cells, widths, aligns):
                self.set_xy(x, y0)
                self.multi_cell(w, 5.5, v, align=a)
                x += w
            self.set_y(y0 + tallest * 5.5 + 1.5)
            self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
            self.ln(1)

    def totals(self, rows):
        self.ln(2)
        for i, (label, val) in enumerate(rows):
            last = i == len(rows) - 1
            self.set_font(FONT, "B" if last else "", 12 if last else 10)
            self.set_x(110)
            self.cell(50, 7, _t(label))
            self.cell(0, 7, _t(val), align="R", new_x="LMARGIN", new_y="NEXT")

    def how_to_pay(self, db):
        from .statements import payment_details
        lines = payment_details(self.company)
        if lines:
            self.ln(5)
            self.set_font(FONT, "B", 10)
            self.set_text_color(*INK)
            self.cell(0, 6, "How to pay", new_x="LMARGIN", new_y="NEXT")
            self.set_font(FONT, "", 9.5)
            for line in lines:
                self.multi_cell(0, 5, _t(line), new_x="LMARGIN", new_y="NEXT")

    def notes(self, text):
        if text:
            self.ln(6)
            self.set_font(FONT, "", 9.5)
            self.set_text_color(*MUTED)
            self.multi_cell(0, 5, _t(text))


def _company(db):
    return db.execute("SELECT * FROM company WHERE id=1").fetchone()


DOC_TITLES = {("sale", "quote"): "Quote", ("sale", "order"): "Sales Order",
              ("purchase", "quote"): "Request for Quote", ("purchase", "order"): "Purchase Order"}


def doc_title(doc, company=None):
    """Quote, Tax Invoice (Invoice where there's no sales tax), Adjustment Note (Credit Note outside Australia)..."""
    tl = C.labels(company) if company is not None else None
    kind = doc["kind"] if "kind" in doc.keys() else "invoice"
    if kind == "credit":
        return (tl["credit"] if tl else "Adjustment Note") if doc["side"] == "sale" else "Supplier Credit"
    if kind == "payment_credit":
        return "Account Credit"
    return DOC_TITLES.get((doc["side"], doc["status"]),
                          (tl["invoice"] if tl else "Tax Invoice") if doc["side"] == "sale" else "Bill")


def document_pdf(db, doc_id) -> bytes:
    doc = db.execute("SELECT d.*, c.name cname, c.address caddress, c.abn cabn FROM documents d"
                     " JOIN contacts c ON c.id=d.contact_id WHERE d.id=?", (doc_id,)).fetchone()
    lines = db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (doc_id,)).fetchall()
    pdf = _PDF(_company(db))
    pdf.add_page()
    title = doc_title(doc, pdf.company) + (" (VOID)" if doc["status"] == "void" else "")
    day = lambda v: C.show_date(v, pdf.company)   # the company's date format (ISO unless chosen)
    meta = [("Date", day(doc["date"]))]
    if doc["due_date"] and doc["status"] not in ("quote",):
        meta.append(("Due", day(doc["due_date"])))
    if doc["status"] == "quote" and doc["valid_until"]:
        meta.append(("Valid until", day(doc["valid_until"])))
    if doc["status"] == "quote" and doc["quote_status"] == "accepted":
        meta.append(("Accepted", (doc["quote_status_at"] or "")[:10]
                     + (f" by {doc['accepted_name']}" if doc["accepted_name"] else "")))
    if doc["reference"]:
        meta.append(("Reference", doc["reference"]))
    opts = []
    if doc["side"] == "sale" and doc["status"] == "quote":
        from .quote_options import of as options_of
        opts = options_of(db, doc_id)   # Good / Better / Best: the customer chooses one
    if opts:
        picked = next((o for o in opts if o["chosen"]), None)
        meta.append(("Options", f"{picked['name']} chosen" if picked else
                     f"{len(opts)}, from {fmt_money(min(o['total'] for o in opts))}"))
    pdf.header_block(title, doc["number"], meta)
    pdf.party("Bill to" if doc["side"] == "sale" else "Supplier", doc["cname"], doc["caddress"], doc["cabn"])
    incl = bool(doc["tax_inclusive"])
    rows = [[l["description"] or "", f"{l['qty']:g}", fmt_money(l["unit_price"]),
             f"{l['discount_pct']:g}%" if l["discount_pct"] else "", fmt_money(l["tax_amount"]),
             fmt_money(l["net_amount"] + (l["tax_amount"] if incl else 0))] for l in lines]
    co = pdf.company
    taxn = pdf.tl["tax"]   # GST, VAT, Sales tax... (Country and tax settings; "Tax" where there's none)
    if opts:
        _options(pdf, opts, taxn, bool(doc["tax_inclusive"]))
        pdf.notes(doc["notes"])
        from .measure.drawing import add_page
        add_page(pdf, db, doc_id, FONT)
        from .measure.photos import add_pdf_pages
        add_pdf_pages(pdf, db, doc_id, FONT)
        return bytes(pdf.output())
    pdf.table(["Description", "Qty", "Unit price", "Disc", taxn, "Amount"], rows,
              [74, 14, 26, 14, 22, 28], ["L", "R", "R", "R", "R", "R"])
    tot = [(f"Subtotal (ex {taxn})", fmt_money(doc["subtotal"])), (taxn, fmt_money(doc["tax_total"]))]
    if doc["amount_paid"]:
        tot += [("Total", fmt_money(doc["total"])), ("Paid", fmt_money(doc["amount_paid"]))]
    tot.append(("Balance due" if doc["side"] == "sale" and doc["status"] in ("open", "paid") else "Total",
                fmt_money(doc["total"] - doc["amount_paid"] if doc["status"] in ("open", "paid") else doc["total"])))
    pdf.totals(tot)
    pdf.notes(doc["notes"])
    if doc["side"] == "sale" and doc["status"] in ("open", "paid") and (doc["kind"] or "invoice") == "invoice":
        pdf.how_to_pay(db)
    if doc["side"] == "sale" and doc["status"] == "quote":
        from .measure.drawing import add_page
        add_page(pdf, db, doc_id, FONT)   # Riyeser Estimate: what was measured, and the drawing (never map imagery)
        from .measure.photos import add_pdf_pages
        add_pdf_pages(pdf, db, doc_id, FONT)   # and the photos chosen for the quote (with their markup)
    return bytes(pdf.output())


BRAND_L = (231, 243, 241)
REC = (51, 70, 179)


def _options(pdf, opts, taxn, incl):
    """A quote with options: a "Choose one" note, then the options side by side (each with its lines and totals),
    or one under another when there are too many lines to fit side by side; then each option's total."""
    picked = next((o for o in opts if o["chosen"]), None)
    W = pdf.w - pdf.l_margin - pdf.r_margin
    pdf.set_fill_color(*BRAND_L)
    pdf.set_text_color(*INK)
    pdf.set_font(FONT, "B", 10.5)
    y0 = pdf.get_y()
    note = (f"You chose {picked['name']}. The other options are shown for your records." if picked else
            f"{len(opts)} options below, each a complete price for the job. Tell us which one you'd like (or "
            "choose it when you accept online) and we'll go ahead with that one.")
    head = "Choose one option" if not picked else "Your choice"
    pdf.set_font(FONT, "", 9.5)
    nl = len(pdf.multi_cell(W - 6, 4.8, _t(note), dry_run=True, output="LINES"))
    box_h = 6.5 + nl * 4.8 + 4.4
    pdf.rect(pdf.l_margin, y0, W, box_h, style="F")
    pdf.set_xy(pdf.l_margin + 3, y0 + 2.2)
    pdf.set_font(FONT, "B", 10.5)
    pdf.cell(W - 6, 6, head, new_x="LMARGIN", new_y="NEXT")
    pdf.set_font(FONT, "", 9.5)
    pdf.set_x(pdf.l_margin + 3)
    pdf.multi_cell(W - 6, 4.8, _t(note), align="L", new_x="LMARGIN", new_y="NEXT")
    pdf.set_y(y0 + box_h + 3)
    n, gap = len(opts), 4.0
    cw = (W - gap * (n - 1)) / n
    amt_w, pad, lh = 18.0, 3.0, 4.0
    desc_w = cw - 2 * pad - amt_w - 1

    def line_text(l):
        d, q = _t(l.get("description") or ""), l.get("qty")
        return d if q in (1, 1.0, None) or f"{q:g}" in d else f"{d}  × {q:g}"

    def col_height(o):
        pdf.set_font(FONT, "", 8)
        h = 11.0
        for l in o["lines"]:
            h += len(pdf.multi_cell(desc_w, lh, line_text(l), dry_run=True, output="LINES")) * lh + 1.6
        return h + 22.0

    heights = [col_height(o) for o in opts]
    tallest = max(heights)
    side = cw >= 52 and tallest <= 250
    if side and pdf.get_y() + tallest > 272:
        pdf.add_page()
    if side:
        top = pdf.get_y()
        for i, o in enumerate(opts):
            x = pdf.l_margin + i * (cw + gap)
            hl = o["chosen"] or (o["recommended"] and not picked)
            pdf.set_draw_color(*((19, 122, 61) if o["chosen"] else REC if hl else LINE))
            pdf.set_line_width(0.6 if hl else 0.25)
            try:
                pdf.rect(x, top, cw, tallest, round_corners=True, corner_radius=2.2)
            except TypeError:   # an older fpdf2
                pdf.rect(x, top, cw, tallest)
            pdf.set_line_width(0.2)
            # the option's name and its badge
            pdf.set_xy(x + pad, top + 3)
            pdf.set_font(FONT, "B", 11.5)
            pdf.set_text_color(*INK)
            badge = "CHOSEN" if o["chosen"] else ("RECOMMENDED" if o["recommended"] and not picked else "")
            name_w = cw - 2 * pad - (pdf.get_string_width(badge) * 0.7 + 6 if badge else 0)
            name = _t(o["name"])
            while name and pdf.get_string_width(name) > name_w:
                name = name[:-1]
            pdf.cell(name_w, 6, name)
            if badge:
                pdf.set_font(FONT, "B", 6.5)
                bw = pdf.get_string_width(badge) + 4
                pdf.set_fill_color(*((19, 122, 61) if o["chosen"] else REC))
                pdf.set_text_color(255, 255, 255)
                pdf.set_xy(x + cw - pad - bw, top + 3.8)
                pdf.cell(bw, 4.4, badge, align="C", fill=True)
            y = top + 11.0
            pdf.set_draw_color(*LINE)
            for l in o["lines"]:
                pdf.set_font(FONT, "", 8)
                pdf.set_text_color(*INK)
                text = line_text(l)
                rows = len(pdf.multi_cell(desc_w, lh, text, dry_run=True, output="LINES"))
                pdf.set_xy(x + pad, y)
                pdf.multi_cell(desc_w, lh, text, align="L")
                pdf.set_xy(x + cw - pad - amt_w, y)
                pdf.cell(amt_w, lh, fmt_money(l.get("amount", l.get("net_amount", 0))), align="R")
                y += rows * lh + 0.8
                pdf.line(x + pad, y, x + cw - pad, y)
                y += 0.8
            # its totals, lined up at the bottom of every column
            y = top + tallest - 21.0
            for label, val, big in ((f"Subtotal (ex {taxn})", o["subtotal"], False), (taxn, o["tax_total"], False),
                                    ("Total", o["total"], True)):
                pdf.set_font(FONT, "B" if big else "", 11 if big else 8.5)
                pdf.set_text_color(*(INK if big else MUTED))
                pdf.set_xy(x + pad, y)
                pdf.cell(cw - 2 * pad - 26, 6 if big else 5, _t(label))
                pdf.cell(26, 6 if big else 5, fmt_money(val), align="R")
                y += 6.5 if big else 5
        pdf.set_y(top + tallest + 4)
    else:   # one under another
        for o in opts:
            if pdf.get_y() > 240:
                pdf.add_page()
            pdf.set_font(FONT, "B", 12)
            pdf.set_text_color(*INK)
            badge = " · chosen" if o["chosen"] else (" · recommended" if o["recommended"] and not picked else "")
            pdf.cell(0, 7, _t(f"{o['name']}{badge}"), new_x="LMARGIN", new_y="NEXT")
            rows = [[l.get("description") or "", f"{l['qty']:g}", fmt_money(l.get("unit_price") or 0),
                     fmt_money(l.get("tax_amount", 0)), fmt_money(l.get("amount", l.get("net_amount", 0)))]
                    for l in o["lines"]]
            pdf.table(["Description", "Qty", "Unit price", taxn, "Amount"], rows, [88, 14, 26, 22, 28],
                      ["L", "R", "R", "R", "R"])
            pdf.set_font(FONT, "", 9.5)
            pdf.set_text_color(*MUTED)
            pdf.set_x(110)
            pdf.cell(50, 5.5, _t(f"Subtotal (ex {taxn})"))
            pdf.cell(0, 5.5, fmt_money(o["subtotal"]), align="R", new_x="LMARGIN", new_y="NEXT")
            pdf.set_x(110)
            pdf.cell(50, 5.5, _t(taxn))
            pdf.cell(0, 5.5, fmt_money(o["tax_total"]), align="R", new_x="LMARGIN", new_y="NEXT")
            pdf.set_font(FONT, "B", 11)
            pdf.set_text_color(*INK)
            pdf.set_x(110)
            pdf.cell(50, 7, _t(f"Total: {o['name']}"[:30]))
            pdf.cell(0, 7, fmt_money(o["total"]), align="R", new_x="LMARGIN", new_y="NEXT")
            pdf.ln(4)
    # the headline: the option that counts (each option's own total is in its column above)
    if pdf.get_y() > 258:
        pdf.add_page()
    lead = picked or next((o for o in opts if o["recommended"]), opts[0])
    rows = [] if side else [(o["name"][:30], fmt_money(o["total"])) for o in opts]
    rows.append((("Total: " if picked else "Recommended: ") + lead["name"][:22], fmt_money(lead["total"])))
    pdf.set_text_color(*INK)
    pdf.totals(rows)
    pdf.set_font(FONT, "", 8.5)
    pdf.set_text_color(*MUTED)
    pdf.set_x(110)
    pdf.multi_cell(0, 4.4, _t(f"Totals include {taxn}." if not incl else f"Prices include {taxn}."),
                   new_x="LMARGIN", new_y="NEXT")


def statement_pdf(db, contact_id, start=None, end=None, pdf=None) -> bytes:
    """An activity statement (S44); with pdf=, adds its pages to that PDF (statements for everyone at once)."""
    from .statements import statement
    end = end or date.today().isoformat()
    start = start or date.fromisoformat(end).replace(day=1).isoformat()
    st = statement(db, contact_id, start, end)
    c = st["contact"]
    own = pdf is None
    pdf = pdf or _PDF(_company(db))
    pdf.add_page()
    pdf.header_block("Statement", f"{start} to {end}", [("Balance", fmt_money(st["closing"]))])
    pdf.party(st["label"], c["name"], c["address"], c["abn"])
    rows = [[start, "Opening balance", "", "", fmt_money(st["opening"])]]
    rows += [[a["date"], a["what"], a["ref"], fmt_money(a["amount"]), fmt_money(a["balance"])] for a in st["activity"]]
    pdf.table(["Date", "Transaction", "Reference", "Amount", "Balance"], rows, [24, 58, 36, 30, 30],
              ["L", "L", "L", "R", "R"])
    pdf.ln(3)
    pdf.table(st["buckets"], [[fmt_money(v) for v in st["ages"]]], [35.6] * 5, ["R"] * 5)
    if st["overdue"]:
        pdf.set_font(FONT, "B", 9.5)
        pdf.set_text_color(180, 35, 24)
        pdf.multi_cell(0, 5, "Overdue: " + ", ".join(f"{o['number']} ({o['days']} days, {fmt_money(o['due'])})"
                                                   for o in st["overdue"]))
        pdf.set_text_color(*INK)
    pdf.totals([("Balance " + ("due" if st["closing"] >= 0 else "in credit"), fmt_money(st["closing"]))])
    if st["side"] == "sale":
        pdf.how_to_pay(db)
    return bytes(pdf.output()) if own else b""


def payslip_pdf(db, slip_id) -> bytes:
    s = db.execute("SELECT s.*, e.first_name, e.last_name, e.pay_basis, e.pay_frequency, e.super_rate, e.super_fund,"
                   " r.pay_date, r.period_start, r.period_end FROM payslips s JOIN employees e ON e.id=s.employee_id"
                   " JOIN payruns r ON r.id=s.payrun_id WHERE s.id=?", (slip_id,)).fetchone()
    pdf = _PDF(_company(db))
    pdf.add_page()
    pdf.header_block("Payslip", f"{s['first_name']} {s['last_name']}",
                     [("Period", f"{s['period_start']} to {s['period_end']}"), ("Paid", s["pay_date"])])
    rows = [["Hours", f"{s['hours']:g}"], ["Gross earnings", fmt_money(s["gross"])],
            ["PAYG tax withheld", fmt_money(s["tax"])], ["Net pay", fmt_money(s["net"])],
            [f"Superannuation ({s['super_rate']:g}%) {s['super_fund'] or ''}", fmt_money(s["super"])],
            ["Annual leave accrued", f"{s['leave_accrued']:.2f} hrs"]]
    pdf.table(["", "This pay"], rows, [120, 58], ["L", "R"])
    from .payroll_calc import NOT_FOR_REAL_PAY
    pdf.ln(4)
    pdf.set_font(FONT, "", 8)
    pdf.set_text_color(150, 80, 0)
    pdf.multi_cell(0, 4, NOT_FOR_REAL_PAY)  # F12
    return bytes(pdf.output())


def document_filename(db, doc_id):
    d = db.execute("SELECT d.*, c.name cname FROM documents d JOIN contacts c ON c.id=d.contact_id WHERE d.id=?",
                   (doc_id,)).fetchone()
    return safe_name(f"{d['date']} {d['cname']} {doc_title(d, _company(db))} {d['number']}") + ".pdf", d


def save_document_pdf(db, doc_id) -> Path:
    """Write the PDF into Documents\\Riyeser\\Accounting\\<Invoices|Quotes|Bills|...>\\<year>\\."""
    name, d = document_filename(db, doc_id)
    folder = {"Tax Invoice": "Invoices", "Quote": "Quotes", "Sales Order": "Sales Orders", "Bill": "Bills",
              "Purchase Order": "Purchase Orders", "Request for Quote": "Quotes"}[doc_title(d)]   # Invoices either way
    out = docs_root() / "Accounting" / folder / d["date"][:4]
    out.mkdir(parents=True, exist_ok=True)
    path = out / name
    path.write_bytes(document_pdf(db, doc_id))
    return path
