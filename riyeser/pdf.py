"""Real PDF files for invoices, quotes, bills, statements and payslips (no browser needed),
and the shared Riyeser documents folder other Riyeser modules (Desk Assistant, Payroll) use."""
import os
import re
from datetime import date
from pathlib import Path

from fpdf import FPDF

from .db import fmt_money

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
        self.set_auto_page_break(True, 18)
        self.set_margins(16, 16, 16)
        self.set_title(company["name"])
        self.set_creator("Riyeser Accounting - Riyeser Group")

    def footer(self):
        self.set_y(-12)
        self.set_font(FONT, "", 7.5)
        self.set_text_color(*MUTED)
        self.cell(0, 5, _t(f"{self.company['name']}  -  page {self.page_no()}  -  produced with Riyeser Accounting"),
                  align="C")

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
        right = [c["address"] or "", f"ABN {c['abn']}" if c["abn"] else "", c["phone"] or "", c["email"] or ""]
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
        for line in [address or "", f"ABN {abn}" if abn else ""]:
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


def doc_title(doc):
    kind = doc["kind"] if "kind" in doc.keys() else "invoice"
    if kind == "credit":
        return "Adjustment Note" if doc["side"] == "sale" else "Supplier Credit"
    if kind == "payment_credit":
        return "Account Credit"
    return DOC_TITLES.get((doc["side"], doc["status"]), "Tax Invoice" if doc["side"] == "sale" else "Bill")


def document_pdf(db, doc_id) -> bytes:
    doc = db.execute("SELECT d.*, c.name cname, c.address caddress, c.abn cabn FROM documents d"
                     " JOIN contacts c ON c.id=d.contact_id WHERE d.id=?", (doc_id,)).fetchone()
    lines = db.execute("SELECT * FROM document_lines WHERE document_id=? ORDER BY id", (doc_id,)).fetchall()
    pdf = _PDF(_company(db))
    pdf.add_page()
    title = doc_title(doc) + (" (VOID)" if doc["status"] == "void" else "")
    meta = [("Date", doc["date"])]
    if doc["due_date"] and doc["status"] not in ("quote",):
        meta.append(("Due", doc["due_date"]))
    if doc["reference"]:
        meta.append(("Reference", doc["reference"]))
    pdf.header_block(title, doc["number"], meta)
    pdf.party("Bill to" if doc["side"] == "sale" else "Supplier", doc["cname"], doc["caddress"], doc["cabn"])
    incl = bool(doc["tax_inclusive"])
    rows = [[l["description"] or "", f"{l['qty']:g}", fmt_money(l["unit_price"]),
             f"{l['discount_pct']:g}%" if l["discount_pct"] else "", fmt_money(l["tax_amount"]),
             fmt_money(l["net_amount"] + (l["tax_amount"] if incl else 0))] for l in lines]
    pdf.table(["Description", "Qty", "Unit price", "Disc", "GST", "Amount"], rows,
              [74, 14, 26, 14, 22, 28], ["L", "R", "R", "R", "R", "R"])
    tot = [("Subtotal (ex GST)", fmt_money(doc["subtotal"])), ("GST", fmt_money(doc["tax_total"]))]
    if doc["amount_paid"]:
        tot += [("Total", fmt_money(doc["total"])), ("Paid", fmt_money(doc["amount_paid"]))]
    tot.append(("Balance due" if doc["side"] == "sale" and doc["status"] in ("open", "paid") else "Total",
                fmt_money(doc["total"] - doc["amount_paid"] if doc["status"] in ("open", "paid") else doc["total"])))
    pdf.totals(tot)
    pdf.notes(doc["notes"])
    if doc["side"] == "sale" and doc["status"] in ("open", "paid") and (doc["kind"] or "invoice") == "invoice":
        pdf.how_to_pay(db)
    return bytes(pdf.output())


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
    return safe_name(f"{d['date']} {d['cname']} {doc_title(d)} {d['number']}") + ".pdf", d


def save_document_pdf(db, doc_id) -> Path:
    """Write the PDF into Documents\\Riyeser\\Accounting\\<Invoices|Quotes|Bills|...>\\<year>\\."""
    name, d = document_filename(db, doc_id)
    folder = {"Tax Invoice": "Invoices", "Quote": "Quotes", "Sales Order": "Sales Orders", "Bill": "Bills",
              "Purchase Order": "Purchase Orders", "Request for Quote": "Quotes"}[doc_title(d)]
    out = docs_root() / "Accounting" / folder / d["date"][:4]
    out.mkdir(parents=True, exist_ok=True)
    path = out / name
    path.write_bytes(document_pdf(db, doc_id))
    return path
