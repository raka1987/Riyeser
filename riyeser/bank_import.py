"""Reading bank statement CSV files (S24): any bank's column layout (found from the header row, or chosen once
and remembered per bank account), Australian, US or ISO dates, amounts like "(40.00)", "40.00 DR" or separate
Debit and Credit columns; lines already imported are skipped, and every skipped row says why."""
import csv
import io
import re
from datetime import datetime

from .db import to_cents

ROLES = ("date", "description", "amount", "debit", "credit")
HEADER_WORDS = {
    "date": ("date", "transaction date", "posted", "posting date", "value date"),
    "description": ("description", "narrative", "details", "memo", "payee", "transaction details", "particulars",
                    "reference"),
    "amount": ("amount", "value", "amount (aud)", "amount (fjd)"),
    "debit": ("debit", "withdrawal", "withdrawals", "debit amount", "money out", "paid out"),
    "credit": ("credit", "deposit", "deposits", "credit amount", "money in", "paid in"),
}
DATE_FORMATS = {"dmy": ("%d/%m/%Y", "%d/%m/%y", "%d-%m-%Y", "%d.%m.%Y", "%d %b %Y", "%d-%b-%Y", "%d %B %Y"),
                "mdy": ("%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%b %d %Y", "%B %d %Y", "%b %d, %Y")}


def parse_date(s, order="dmy"):
    s = (s or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d") + DATE_FORMATS.get(order, DATE_FORMATS["dmy"]):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def parse_amount(s):
    """'1,234.50' '-40' '(40.00)' '$40.00' '40.00 DR' '40.00 CR' -> cents; None if it isn't an amount."""
    s = (s or "").strip().replace("$", "").replace(",", "").replace(" ", "")
    if not s:
        return None
    sign = 1
    if s.startswith("(") and s.endswith(")"):
        s, sign = s[1:-1], -1
    up = s.upper()
    if up.endswith("DR"):
        s, sign = s[:-2], -sign
    elif up.endswith("CR"):
        s = s[:-2]
    if not re.fullmatch(r"[-+]?\d+(\.\d+)?", s):
        return None
    try:
        return sign * to_cents(s)
    except ValueError:
        return None


def _header_map(row):
    m = {}
    for i, cell in enumerate(row):
        c = cell.strip().lower()
        for role, words in HEADER_WORDS.items():
            if role not in m and c in words:
                m[role] = i
    return m if "date" in m and ("amount" in m or "debit" in m or "credit" in m) else None


def _guess_map(rows, order):
    """No header row (CommBank: date, amount, description, balance): the date column, the first amount column
    after it, and the longest text column."""
    sample = [r for r in rows[:20] if r]
    if not sample:
        return None
    n = max(len(r) for r in sample)
    def share(i, fn):
        vals = [r[i] for r in sample if i < len(r) and r[i].strip()]
        return sum(1 for v in vals if fn(v)) / len(vals) if vals else 0
    date_col = next((i for i in range(n) if share(i, lambda v: parse_date(v, order)) > 0.8), None)
    if date_col is None:
        return None
    amt_cols = [i for i in range(n) if i != date_col and share(i, lambda v: parse_amount(v) is not None) > 0.8]
    if not amt_cols:
        return None
    texts = [i for i in range(n) if i != date_col and i not in amt_cols]
    desc = max(texts, key=lambda i: sum(len(r[i]) for r in sample if i < len(r)), default=None)
    return {"date": date_col, "amount": amt_cols[0], **({"description": desc} if desc is not None else {})}


def read(text, mapping=None, order="dmy", saved=None):
    """Returns (lines, skipped, mapping): lines [{'row', 'date', 'description', 'amount'}], skipped
    [(row number, reason)], and the column mapping used. Columns: those chosen (mapping), else the header row's,
    else the ones remembered for the account (saved), else worked out from the values."""
    rows = list(csv.reader(io.StringIO(text)))
    clean = lambda d: {k: v for k, v in (d or {}).items() if v is not None and k in ROLES}
    header = _header_map(rows[0]) if rows else None
    start = 1 if header else 0
    m = clean(mapping) or header or clean(saved) or (_guess_map(rows, order) if rows else None) or {}
    if "date" not in m or not ({"amount", "debit", "credit"} & set(m)):
        return [], [(0, "The columns couldn't be worked out: choose which column is the date and which the amount.")], m
    out, skipped = [], []
    for n, r in enumerate(rows[start:], start + 1):
        if not any(c.strip() for c in r):
            continue
        cell = lambda role: r[m[role]] if role in m and m[role] < len(r) else ""
        d = parse_date(cell("date"), order)
        if not d:
            skipped.append((n, f"the date \"{cell('date')}\" couldn't be read"))
            continue
        if "amount" in m:
            amt = parse_amount(cell("amount"))
        else:
            dr, cr = parse_amount(cell("debit")), parse_amount(cell("credit"))
            amt = None if dr is None and cr is None else (cr or 0) - abs(dr or 0)
        if amt is None:
            skipped.append((n, f"the amount \"{cell('amount') or cell('debit') or cell('credit')}\" couldn't be read"))
            continue
        if amt == 0:
            skipped.append((n, "the amount is $0.00"))
            continue
        out.append(dict(row=n, date=d, description=cell("description").strip(), amount=amt))
    return out, skipped, m
