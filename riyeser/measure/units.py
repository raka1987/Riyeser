"""Metric and imperial units. Everything is kept in SI (m, m², m³); these convert for screens, typing and quotes.

The same rules are in riyeser/static/measure/units.js (keep them in step; tests/test_measure_geometry.py checks both).
"""
import math
import re

FT = 0.3048                 # metres in a foot (exact)
IN = 0.0254                 # metres in an inch (exact)
YD = 0.9144
SQFT = FT * FT              # 0.09290304 m²
SQUARE = 100 * SQFT         # a roofing "square": 100 sq ft = 9.290304 m²
SQYD = YD * YD
CUFT = FT ** 3
CUYD = YD ** 3              # 0.764554857984 m³
LITRE = 0.001
US_GALLON = 0.003785411784

SYSTEMS = ("metric", "imperial")

# unit code -> (dimension, SI per unit, short label)
UNITS = {
    "m": ("length", 1.0, "m"), "mm": ("length", 0.001, "mm"), "cm": ("length", 0.01, "cm"),
    "ft": ("length", FT, "ft"), "in": ("length", IN, "in"), "yd": ("length", YD, "yd"),
    "lm": ("length", 1.0, "lm"), "lft": ("length", FT, "lin ft"),
    "m2": ("area", 1.0, "m²"), "ft2": ("area", SQFT, "sq ft"), "yd2": ("area", SQYD, "sq yd"),
    "square": ("area", SQUARE, "squares"),
    "m3": ("volume", 1.0, "m³"), "ft3": ("volume", CUFT, "cu ft"), "yd3": ("volume", CUYD, "cu yd"),
    "L": ("volume", LITRE, "L"), "gal": ("volume", US_GALLON, "gal"),
    "each": ("count", 1.0, "each"), "hour": ("hours", 1.0, "hrs"), "item": ("fixed", 1.0, "item"),
}

# what each dimension shows in, per system
DISPLAY = {
    "metric": {"length": "m", "area": "m2", "volume": "m3", "count": "each", "hours": "hour", "fixed": "item"},
    "imperial": {"length": "ft", "area": "ft2", "volume": "yd3", "count": "each", "hours": "hour", "fixed": "item"},
}


def system(v):
    return v if v in SYSTEMS else "metric"


def dimension(unit):
    return UNITS[unit][0] if unit in UNITS else "count"


def to_si(value, unit):
    """A value in `unit` -> SI."""
    return float(value) * UNITS[unit][1]


def from_si(value, unit):
    """An SI value -> `unit`."""
    return float(value) / UNITS[unit][1]


def label(unit):
    return UNITS[unit][2] if unit in UNITS else unit


def display_unit(dim, sys_):
    return DISPLAY[system(sys_)].get(dim, "each")


def fmt(value_si, dim, sys_, places=2):
    """'12.50 m²' / '134.55 sq ft' for an SI amount of this dimension."""
    u = display_unit(dim, sys_)
    v = from_si(value_si, u) if dim in ("length", "area", "volume") else float(value_si)
    s = f"{v:,.{places}f}".rstrip("0").rstrip(".") if places else f"{v:,.0f}"
    return f"{s} {label(u)}"


_NUM = r"[-+]?(?:\d+(?:[.,]\d*)?|[.,]\d+)"
_FT_IN = re.compile(rf"^\s*(?:({_NUM})\s*(?:'|ft|feet|foot))?\s*(?:({_NUM})\s*(?:\"|''|in|inch|inches))?\s*$", re.I)
_WITH_UNIT = re.compile(rf"^\s*({_NUM})\s*(mm|cm|m|ft|in|yd)?\s*$", re.I)
_FRACTION = re.compile(r"(\d+)\s+(\d+)/(\d+)")


def _num(s):
    s = s.strip()
    if s.count(",") == 1 and "." not in s and len(s.split(",")[1]) != 3:
        s = s.replace(",", ".")       # "3,25" typed with a decimal comma
    return float(s.replace(",", ""))


def parse_length(text, sys_="metric"):
    """What someone typed (or a laser measurer typed in keyboard mode) -> metres. None when it's empty.

    Plain numbers are in the takeoff's units (m, or ft for imperial). Units can be typed: "2400mm", "3.2 m",
    "12ft", "12' 6\"", "12'6", "6in", "10 1/2\"". Raises ValueError for anything else.
    """
    if text is None:
        return None
    s = str(text).strip().replace("′", "'").replace("″", '"').replace("’", "'").replace("”", '"')
    if not s:
        return None
    s = _FRACTION.sub(lambda m: str(int(m.group(1)) + int(m.group(2)) / int(m.group(3))), s)
    m = _WITH_UNIT.match(s)
    if m:
        v = _num(m.group(1))
        u = (m.group(2) or "").lower() or ("ft" if system(sys_) == "imperial" else "m")
        return v * UNITS[u][1]
    m = re.match(rf"^\s*({_NUM})\s*'\s*({_NUM})\s*$", s)   # 12'6 (inches without the mark)
    if m:
        return _num(m.group(1)) * FT + _num(m.group(2)) * IN
    m = _FT_IN.match(s)
    if m and (m.group(1) or m.group(2)):
        return (_num(m.group(1)) if m.group(1) else 0) * FT + (_num(m.group(2)) if m.group(2) else 0) * IN
    raise ValueError(f"\"{text}\" isn't a length. Type a number, like 3.6 or 12' 6\".")


def parse_number(text, default=None):
    if text is None or str(text).strip() == "":
        return default
    try:
        return _num(str(text))
    except ValueError:
        raise ValueError(f"\"{text}\" isn't a number.")


def length_input(value_si, sys_="metric"):
    """An SI length shown back in an input box, in the takeoff's units (blank for None)."""
    if value_si is None:
        return ""
    v = from_si(value_si, "ft" if system(sys_) == "imperial" else "m")
    return f"{v:.3f}".rstrip("0").rstrip(".")


def round_up(x, eps=1e-9):
    """Whole packs: 3.0000000001 -> 3, 3.01 -> 4."""
    return int(math.ceil(x - eps)) if x > 0 else 0
