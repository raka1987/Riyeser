"""Sorting and filtering for every list screen, in one place.

A list screen describes itself once with a ListSpec (its columns, its date column, what it can be searched and
narrowed by). ListState then reads the query string (?sort=&dir=&q=&year=&period=&from=&to=&page= and any choices
such as ?st=overdue), fills in what the person chose last time on this list, and gives the view:

  * fetch(db, base_sql, params): the rows for this page, sorted and filtered in SQL (so it copes with big files and
    paging), with how many there are before and after filtering ("23 of 140");
  * apply(rows): the same in Python, for lists worked out in code (balances, low stock);
  * links for the column headers, the pager and "Clear filters" that keep everything else as it is.

Years and periods follow the company's financial year (company.fy_start_month), so "FY 2025-26" is July to June for
an Australian company and January to December for a company whose year starts in January.

What someone chose on a list (sort, year, period, choices; not the search words) is kept per person per list in the
company file's user_prefs table, and comes back the next time they open that list.
"""
import json
import math
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import date, timedelta

PERIODS = [("this_month", "This month"), ("last_month", "Last month"), ("this_quarter", "This quarter"),
           ("this_fy", "This financial year"), ("last_fy", "Last financial year"), ("custom", "Custom dates")]
PERIOD_KEYS = {k for k, _ in PERIODS}
_YEAR = re.compile(r"^(fy|cy)(\d{4})$")
_MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ------------------------------------------------------------------ dates
def _iso(v):
    try:
        return date.fromisoformat(str(v)[:10]).isoformat() if v else None
    except ValueError:
        return None


def _month_end(y, m):
    return (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))


def fy_bounds(start_year, fy_month):
    """(first day, last day) of the financial year that starts in fy_month of start_year."""
    s = date(start_year, fy_month, 1)
    e = date(start_year + 1, fy_month, 1) - timedelta(days=1) if fy_month != 1 else date(start_year, 12, 31)
    return s.isoformat(), e.isoformat()


def fy_start_year(on, fy_month):
    """The calendar year in which the financial year holding `on` started."""
    on = date.fromisoformat(on) if isinstance(on, str) else on
    return on.year if on.month >= fy_month else on.year - 1


def fy_label(start_year, fy_month):
    if fy_month == 1:
        return str(start_year)
    return f"FY {start_year}–{str(start_year + 1)[2:]}"


def year_range(value, fy_month):
    """'fy2025' -> that financial year, 'cy2025' -> 1 Jan to 31 Dec 2025. (None, None) for anything else."""
    m = _YEAR.match(value or "")
    if not m:
        return None, None
    y = int(m.group(2))
    if m.group(1) == "cy":
        return f"{y}-01-01", f"{y}-12-31"
    return fy_bounds(y, fy_month)


def period_range(period, fy_month, today, start=None, end=None):
    """(from, to) for a quick pick. Quarters are counted from the start of the financial year."""
    t = date.fromisoformat(today) if isinstance(today, str) else today
    if period == "this_month":
        return date(t.year, t.month, 1).isoformat(), _month_end(t.year, t.month).isoformat()
    if period == "last_month":
        y, m = (t.year, t.month - 1) if t.month > 1 else (t.year - 1, 12)
        return date(y, m, 1).isoformat(), _month_end(y, m).isoformat()
    if period == "this_quarter":
        k = (t.month - fy_month) % 12 // 3  # 0..3: which quarter of the financial year
        m0 = (fy_month - 1 + 3 * k) % 12 + 1
        y0 = t.year if m0 <= t.month else t.year - 1
        m2 = (m0 + 1) % 12 + 1
        y2 = y0 + (m2 < m0)
        return date(y0, m0, 1).isoformat(), _month_end(y2, m2).isoformat()
    if period == "this_fy":
        return fy_bounds(fy_start_year(t, fy_month), fy_month)
    if period == "last_fy":
        return fy_bounds(fy_start_year(t, fy_month) - 1, fy_month)
    if period == "custom":
        return _iso(start), _iso(end)
    return None, None


def year_options(fy_month, first=None, last=None, today=None):
    """[(group label, [(value, label)])]: financial years and calendar years from the oldest record to now."""
    today = today or date.today().isoformat()
    lo = _iso(first) or today
    hi = max(_iso(last) or today, today)
    fy0, fy1 = fy_start_year(lo, fy_month), fy_start_year(hi, fy_month)
    cy = [(f"cy{y}", str(y)) for y in range(int(hi[:4]), int(lo[:4]) - 1, -1)]
    if fy_month == 1:
        return [("Year", cy)]  # the financial year is the calendar year
    fys = [(f"fy{y}", fy_label(y, fy_month)) for y in range(fy1, fy0 - 1, -1)]
    return [(f"Financial year ({_MONTHS[fy_month]}–{_MONTHS[(fy_month + 10) % 12 + 1]})", fys),
            ("Calendar year", cy)]


# ------------------------------------------------------------------ the description of a list
@dataclass
class Col:
    """A sortable column. key is the column name in the list's query (or in each row for apply())."""
    key: str
    label: str
    kind: str = "text"   # text, num, date, code (INV00012: sorted by its letters, then its number)
    sql: str = None      # an expression to sort by, instead of the column itself

    @property
    def first_dir(self):
        return "desc" if self.kind in ("num", "date") else "asc"  # biggest / newest first on the first click


@dataclass
class Choice:
    """A drop-down that narrows the list: Status, Type, Category, Bank account...

    where: {value: (sql, params)} or a function(value, today) -> (sql, params), using the query's column names.
    test:  the same for apply(): a function(row, value, today) -> bool. Without it, row[param_col] == value."""
    param: str
    label: str
    options: list
    where: object = None
    test: object = None
    col: str = None
    all_label: str = "All"
    remember: bool = True

    def sql(self, value, today):
        if callable(self.where):
            return self.where(value, today)
        if isinstance(self.where, dict):
            return self.where.get(value, ("", []))
        return f" AND {self.col or self.param}=?", [value]

    def ok(self, row, value, today):
        if self.test:
            return self.test(row, value, today)
        return str(_get(row, self.col or self.param)) == value


@dataclass
class ListSpec:
    key: str                 # remembered under this name
    cols: list
    sort: str                # default column
    dir: str = None          # default direction (the column's first direction when None)
    date_col: str = None     # Year and Period narrow by this column
    date_label: str = "Date"
    search: tuple = ()       # columns searched by the search box
    search_hint: str = "Search"
    own_search: bool = False  # the screen searches itself (deeper than these columns); the box is still shown
    choices: list = field(default_factory=list)
    prefix: str = ""         # two lists on one page: e_sort, r_sort...
    per_page: int = 100      # None: everything (up to cap) on one page
    cap: int = 2000
    tiebreak: str = "id DESC"
    lead: str = None         # always sorted by this first (inactive cards at the bottom: "active DESC")
    from_param: str = "from"
    to_param: str = "to"
    noun: str = "items"

    def col(self, key):
        return next((c for c in self.cols if c.key == key), None)

    def p(self, name):
        if name == "from":
            return self.prefix + self.from_param
        if name == "to":
            return self.prefix + self.to_param
        return self.prefix + name


def _get(row, key):
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return getattr(row, key, None)


def sort_key(kind):
    """A key function for one column kind that never compares numbers as text; empties always go last."""
    def k(v):
        if v is None or v == "":
            return (1, 0)
        if kind == "num":
            try:
                return (0, float(str(v).replace(",", "")))
            except ValueError:
                return (1, 0)
        if kind == "code":
            s = str(v)
            m = re.match(r"^(.*?)(\d+)$", s)
            return (0, (m.group(1).casefold(), int(m.group(2)), s)) if m else (0, (s.casefold(), -1, s))
        return (0, str(v).casefold())
    return k


def sort_rows(rows, key, kind="text", desc=False):
    """Sort Python rows by one column, type-aware, empties last whichever way."""
    rows = list(rows)
    full = [r for r in rows if _get(r, key) not in (None, "")]
    empty = [r for r in rows if _get(r, key) in (None, "")]
    kf = sort_key(kind)
    full.sort(key=lambda r: kf(_get(r, key)), reverse=desc)
    return full + empty


# ------------------------------------------------------------------ remembered choices
def _ensure_prefs(db):
    db.execute("CREATE TABLE IF NOT EXISTS user_prefs (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT,"
               " PRIMARY KEY (user_id, key))")


def load_pref(db, user_id, key):
    if not user_id:
        return {}
    try:
        r = db.execute("SELECT value FROM user_prefs WHERE user_id=? AND key=?", (user_id, key)).fetchone()
        return json.loads(r[0]) if r and r[0] else {}
    except (sqlite3.Error, ValueError, TypeError):
        return {}


def save_pref(db, user_id, key, value):
    """Remember a list's choices. Never stops the list from showing (a busy or read-only file just isn't written)."""
    if not user_id:
        return
    try:
        if load_pref(db, user_id, key) == value:
            return
        if db.in_transaction:
            return  # this request is in the middle of its own writes: leave them to it
        _ensure_prefs(db)
        db.execute("INSERT OR REPLACE INTO user_prefs (user_id, key, value) VALUES (?,?,?)",
                   (user_id, key, json.dumps(value, sort_keys=True)))
        db.commit()
    except sqlite3.Error:
        try:
            db.rollback()
        except sqlite3.Error:
            pass


# ------------------------------------------------------------------ one list as someone is looking at it
class ListState:
    REMEMBERED = ("sort", "dir", "year", "period", "from", "to")

    def __init__(self, spec, args, fy_month=7, today=None, prefs=None, keep=None, endpoint=None, view_args=None):
        """args: the request's query string (a dict or MultiDict). keep: the screen's own parameters (tabs and
        the like) to carry on every link. prefs: what was remembered for this list."""
        self.spec = spec
        self.fy_month = int(fy_month or 7)
        self.today = today or date.today().isoformat()
        self.keep = {k: v for k, v in (keep or {}).items() if v not in (None, "")}
        self.endpoint, self.view_args = endpoint, dict(view_args or {})
        prefs = dict(prefs or {})
        # A link or form that says anything about the filters says everything: what it leaves out is "All".
        # Only a plain visit (the menu, a tab) brings back what was chosen last time. Sort is always remembered.
        filter_keys = ["q", "year", "period", "from", "to", *[c.param for c in spec.choices]]
        explicit = bool(args.get(spec.p("clear"))) or any(spec.p(k) in args for k in filter_keys)

        def pick(name, default=""):
            pn = spec.p(name)
            if pn in args:
                return (args.get(pn) or "").strip()
            if explicit and name not in ("sort", "dir"):
                return default
            return prefs.get(name, default)

        sort = pick("sort")
        c = spec.col(sort)
        self.sort = c.key if c else spec.sort
        dc = spec.col(self.sort)
        d = pick("dir")
        default_dir = (spec.dir if self.sort == spec.sort and spec.dir else dc.first_dir) if dc else "asc"
        self.dir = d if d in ("asc", "desc") else default_dir
        self.q = (args.get(spec.p("q")) or "").strip() if spec.search else ""
        y = pick("year") if spec.date_col else ""
        self.year = y if _YEAR.match(y or "") else ""
        per = pick("period") if spec.date_col else ""
        self.period = per if per in PERIOD_KEYS else ""
        self.dfrom = _iso(pick("from")) if spec.date_col else None
        self.dto = _iso(pick("to")) if spec.date_col else None
        if spec.p("period") not in args and (spec.p("from") in args or spec.p("to") in args) and (self.dfrom or self.dto):
            self.period = "custom"  # an older link with only from / to (Search Transactions ?start=&end=)
        self.choice = {}
        for ch in spec.choices:
            v = pick(ch.param) if ch.remember else (args.get(spec.p(ch.param)) or "").strip()
            self.choice[ch.param] = v if v in {str(o[0]) for o in ch.options} else ""
        try:
            self.page = max(1, int(args.get(spec.p("page")) or 1))
        except ValueError:
            self.page = 1
        self.total = self.shown = 0
        self.sums = {}
        self.first = self.last = None

    # -- what to remember
    def remembered(self):
        out = {"sort": self.sort, "dir": self.dir, "year": self.year, "period": self.period,
               "from": self.dfrom or "" if self.period == "custom" else "",
               "to": self.dto or "" if self.period == "custom" else ""}
        out.update({ch.param: self.choice[ch.param] for ch in self.spec.choices if ch.remember})
        return out

    # -- date range from Year and Period together (both narrow it)
    def date_range(self):
        lo = hi = None
        for a, b in (year_range(self.year, self.fy_month),
                     period_range(self.period, self.fy_month, self.today, self.dfrom, self.dto)):
            if a and (lo is None or a > lo):
                lo = a
            if b and (hi is None or b < hi):
                hi = b
        return lo, hi

    @property
    def filtered(self):
        return bool(self.q or self.year or self.period or any(self.choice.values()))

    # -- SQL
    def where(self):
        sql, args = "", []
        s = self.spec
        if self.q and s.search and not s.own_search:
            sql += " AND (" + " OR ".join(f"COALESCE({c},'') LIKE ?" for c in s.search) + ")"
            args += [f"%{self.q}%"] * len(s.search)
        lo, hi = self.date_range()
        if s.date_col and lo:
            sql += f" AND substr({s.date_col},1,10) >= ?"; args.append(lo)
        if s.date_col and hi:
            sql += f" AND substr({s.date_col},1,10) <= ?"; args.append(hi)
        for ch in s.choices:
            v = self.choice[ch.param]
            if v:
                more, a = ch.sql(v, self.today)
                sql += more; args += list(a)
        return sql, args

    def order_by(self):
        c = self.spec.col(self.sort)
        d = "DESC" if self.dir == "desc" else "ASC"
        e = c.sql or c.key
        if c.kind == "code":
            pre = f"rtrim({e},'0123456789')"
            num = f"CAST(substr({e}, length({pre})+1) AS INTEGER)"
            order = f"({e} IS NULL OR {e}=''), {pre} COLLATE NOCASE {d}, {num} {d}, {e} {d}"
        elif c.kind == "text":
            order = f"({e} IS NULL OR {e}=''), {e} COLLATE NOCASE {d}"
        else:
            order = f"({e} IS NULL), {e} {d}"
        lead = f"{self.spec.lead}, " if self.spec.lead else ""
        return lead + order + (f", {self.spec.tiebreak}" if self.spec.tiebreak else "")

    def fetch(self, db, base_sql, params=(), sums=(), total_sql=None):
        """Run the list's query (a SELECT with no ORDER BY / LIMIT): this page of rows, sorted and filtered.
        total_sql: how to count "of N" when the query itself already narrows (a screen with its own search)."""
        params = list(params)
        inner = f"({base_sql}) t"
        self.total = db.execute(total_sql or f"SELECT COUNT(*) FROM {inner}", [] if total_sql else params).fetchone()[0]
        if self.spec.date_col:
            r = db.execute(f"SELECT MIN(substr({self.spec.date_col},1,10)), MAX(substr({self.spec.date_col},1,10))"
                           f" FROM {inner}", params).fetchone()
            self.first, self.last = r[0], r[1]
        w, wa = self.where()
        agg = "".join(f", SUM({s})" for s in sums)
        r = db.execute(f"SELECT COUNT(*){agg} FROM {inner} WHERE 1=1{w}", params + wa).fetchone()
        self.shown = r[0]
        self.sums = {s: (r[i + 1] or 0) for i, s in enumerate(sums)}
        per = self.spec.per_page or self.spec.cap
        self.page = min(self.page, self.pages)
        return db.execute(f"SELECT * FROM {inner} WHERE 1=1{w} ORDER BY {self.order_by()} LIMIT ? OFFSET ?",
                          params + wa + [per, (self.page - 1) * per]).fetchall()

    def apply(self, rows, sums=()):
        """The same filters and sort for rows already in Python (a list of dicts or sqlite rows)."""
        rows = list(rows)
        s = self.spec
        self.total = len(rows)
        if s.date_col:
            ds = sorted(d for d in (_iso(_get(r, s.date_col)) for r in rows) if d)
            self.first, self.last = (ds[0], ds[-1]) if ds else (None, None)
        if self.q and s.search and not s.own_search:
            q = self.q.casefold()
            rows = [r for r in rows if any(q in str(_get(r, c) or "").casefold() for c in s.search)]
        lo, hi = self.date_range()
        if s.date_col and (lo or hi):
            rows = [r for r in rows if (d := _iso(_get(r, s.date_col))) and (not lo or d >= lo) and (not hi or d <= hi)]
        for ch in s.choices:
            v = self.choice[ch.param]
            if v:
                rows = [r for r in rows if ch.ok(r, v, self.today)]
        c = s.col(self.sort)
        rows = sort_rows(rows, c.key, c.kind, self.dir == "desc")
        self.shown = len(rows)
        self.sums = {k: sum((_get(r, k) or 0) for r in rows) for k in sums}
        if s.per_page:
            self.page = min(self.page, self.pages)
            rows = rows[(self.page - 1) * s.per_page:self.page * s.per_page]
        return rows

    # -- paging
    @property
    def pages(self):
        per = self.spec.per_page
        return max(1, math.ceil(self.shown / per)) if per else 1

    @property
    def page_from(self):
        return (self.page - 1) * (self.spec.per_page or 0) + 1 if self.shown else 0

    @property
    def page_to(self):
        per = self.spec.per_page
        return min(self.shown, self.page * per) if per else min(self.shown, self.spec.cap)

    # -- links
    def params(self, **change):
        """The query string for this list as it is now, with some things changed."""
        s = self.spec
        cur = {"sort": self.sort, "dir": self.dir, "q": self.q, "year": self.year, "period": self.period,
               "from": self.dfrom if self.period == "custom" else "", "to": self.dto if self.period == "custom" else "",
               "page": self.page if self.page > 1 else ""}
        cur.update(self.choice)
        cur.update(change)
        out = dict(self.keep)
        for k, v in cur.items():
            if v not in (None, ""):
                out[s.p(k)] = v
        return out

    def url(self, **change):
        from flask import url_for, request
        ep = self.endpoint or request.endpoint
        va = self.view_args if self.endpoint else dict(request.view_args or {})
        return url_for(ep, **va, **self.params(**change))

    def sort_url(self, key):
        c = self.spec.col(key)
        d = ("asc" if self.dir == "desc" else "desc") if key == self.sort else c.first_dir
        return self.url(sort=key, dir=d, page="")

    def aria_sort(self, key):
        if key != self.sort:
            return "none"
        return "descending" if self.dir == "desc" else "ascending"

    def clear_url(self):
        from flask import url_for, request
        ep = self.endpoint or request.endpoint
        va = self.view_args if self.endpoint else dict(request.view_args or {})
        args = dict(self.keep)
        args[self.spec.p("clear")] = "1"
        return url_for(ep, **va, **args)

    def hidden(self):
        """Fields the filter form must carry: the screen's own (tabs) and the sort."""
        h = dict(self.keep)
        h[self.spec.p("sort")] = self.sort
        h[self.spec.p("dir")] = self.dir
        return h

    def years(self):
        lo, hi = self.first, self.last
        y = year_range(self.year, self.fy_month)  # the chosen year is always on the list, even with nothing in it
        if y[0]:
            lo = min(lo, y[0]) if lo else y[0]
            hi = max(hi, y[1]) if hi else y[1]
        return year_options(self.fy_month, lo, hi, self.today)

    @property
    def periods(self):
        return PERIODS

    @property
    def sort_options(self):
        return [(c.key, c.label) for c in self.spec.cols]


def from_request(spec, keep=None, endpoint=None, view_args=None, remember=True):
    """A ListState for the current request: the company's financial year, today's date and what this person chose
    last time on this list. What they choose now is remembered for next time."""
    from flask import request, g
    from .db import get_db
    db = get_db()
    uid = g.user["id"] if getattr(g, "user", None) else None
    co = getattr(g, "company", None) or {}
    fy = co.get("fy_start_month", 7) if hasattr(co, "get") else co["fy_start_month"]
    pkey = "list:" + spec.key
    st = ListState(spec, request.args, fy_month=fy, prefs=load_pref(db, uid, pkey) if remember else {},
                   keep=keep, endpoint=endpoint, view_args=view_args)
    if remember:
        save_pref(db, uid, pkey, st.remembered())
    return st
