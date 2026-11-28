"""The cash drawer, and ESC/POS (raw) receipts.

Most cash drawers plug into the receipt printer's drawer port (RJ11/RJ12, "DK port"). The printer opens the drawer
when it receives the ESC/POS pulse command ESC p 0 25 250 (pin 2, 50 ms on, 500 ms off). Riyeser sends those bytes
to the printer as a raw print job through Windows' print spooler (winspool: OpenPrinter, StartDocPrinter with the
"RAW" data type, WritePrinter), using pywin32 when it's there and the same Windows functions through ctypes when it
isn't (ctypes is part of Python, so the PyInstaller build needs nothing extra).

Riyeser runs on the PC the POS program is installed on, so the printer must be installed on that PC (a USB printer,
or a network printer added in Windows). Other operating systems have no Windows spooler: there the raw printer says
so plainly, and normal receipt printing (through the browser) still works.

Tests swap in a fake printer (FakePrinter) through the app config key RAW_PRINTER.
"""
import sys
from datetime import datetime

PULSE = b"\x1bp\x00\x19\xfa"          # ESC p 0 25 250: kick the drawer on pin 2
INIT = b"\x1b@"                        # ESC @: reset the printer
CUT = b"\x1dV\x42\x03"                 # GS V 66 3: feed 3 lines and cut (partial cut where the printer has one)
BOLD_ON, BOLD_OFF = b"\x1bE\x01", b"\x1bE\x00"
CENTRE, LEFT = b"\x1ba\x01", b"\x1ba\x00"
DOUBLE, NORMAL = b"\x1d!\x11", b"\x1d!\x00"
WIDTH = 42                              # characters on an 80 mm printer with the standard font (48 on some)


class DrawerError(Exception):
    """The printer couldn't be reached, or isn't a raw-capable printer on this computer."""


class RawPrinter:
    """Sends bytes, unchanged, to a printer installed on this computer."""
    name = "none"

    def available(self):
        return False

    def printers(self):
        return []

    def send(self, printer, data, job="Riyeser POS"):
        raise DrawerError("Raw printing isn't available on this computer.")


class WindowsRawPrinter(RawPrinter):
    """Windows' print spooler, RAW data type. pywin32 when installed, otherwise ctypes and winspool.drv."""
    name = "windows"

    def available(self):
        return sys.platform == "win32"

    def printers(self):
        try:
            import win32print  # type: ignore
            flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
            return sorted(p[2] for p in win32print.EnumPrinters(flags))
        except ImportError:
            return self._ct_printers()

    def send(self, printer, data, job="Riyeser POS"):
        if not printer:
            raise DrawerError("Choose the receipt printer first.")
        try:
            import win32print  # type: ignore
        except ImportError:
            return self._ct_send(printer, data, job)
        try:
            h = win32print.OpenPrinter(printer)
        except Exception as e:  # pywintypes.error
            raise DrawerError(f"Couldn't open the printer “{printer}”: {e}")
        try:
            win32print.StartDocPrinter(h, 1, (job, None, "RAW"))
            try:
                win32print.StartPagePrinter(h)
                win32print.WritePrinter(h, bytes(data))
                win32print.EndPagePrinter(h)
            finally:
                win32print.EndDocPrinter(h)
        except Exception as e:
            raise DrawerError(f"The printer “{printer}” didn't take the job: {e}")
        finally:
            win32print.ClosePrinter(h)

    # ---- the same through ctypes (no pywin32 in the build)
    def _ct(self):
        import ctypes
        from ctypes import wintypes
        ws = ctypes.WinDLL("winspool.drv", use_last_error=True)

        class DOC_INFO_1(ctypes.Structure):
            _fields_ = [("pDocName", wintypes.LPWSTR), ("pOutputFile", wintypes.LPWSTR),
                        ("pDatatype", wintypes.LPWSTR)]
        return ctypes, wintypes, ws, DOC_INFO_1

    def _ct_printers(self):
        ctypes, wintypes, ws, _ = self._ct()

        class PRINTER_INFO_4(ctypes.Structure):
            _fields_ = [("pPrinterName", wintypes.LPWSTR), ("pServerName", wintypes.LPWSTR),
                        ("Attributes", wintypes.DWORD)]
        flags = 0x2 | 0x4  # PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS
        need, count = wintypes.DWORD(), wintypes.DWORD()
        ws.EnumPrintersW(flags, None, 4, None, 0, ctypes.byref(need), ctypes.byref(count))
        if not need.value:
            return []
        buf = (ctypes.c_byte * need.value)()
        if not ws.EnumPrintersW(flags, None, 4, buf, need, ctypes.byref(need), ctypes.byref(count)):
            return []
        arr = ctypes.cast(buf, ctypes.POINTER(PRINTER_INFO_4))
        return sorted(arr[i].pPrinterName for i in range(count.value))

    def _ct_send(self, printer, data, job):
        ctypes, wintypes, ws, DOC_INFO_1 = self._ct()
        h = wintypes.HANDLE()
        if not ws.OpenPrinterW(printer, ctypes.byref(h), None):
            raise DrawerError(f"Couldn't open the printer “{printer}” (Windows error {ctypes.get_last_error()}).")
        try:
            info = DOC_INFO_1(job, None, "RAW")
            if not ws.StartDocPrinterW(h, 1, ctypes.byref(info)):
                raise DrawerError(f"The printer “{printer}” didn't start the job (Windows error "
                                  f"{ctypes.get_last_error()}).")
            try:
                ws.StartPagePrinter(h)
                raw = bytes(data)
                written = wintypes.DWORD()
                ok = ws.WritePrinter(h, raw, len(raw), ctypes.byref(written))
                ws.EndPagePrinter(h)
                if not ok or written.value != len(raw):
                    raise DrawerError(f"The printer “{printer}” didn't take all of the job.")
            finally:
                ws.EndDocPrinter(h)
        finally:
            ws.ClosePrinter(h)


class FakePrinter(RawPrinter):
    """For tests and the browser checks: remembers every job instead of printing it."""
    name = "fake"

    def __init__(self, printers=("Receipt printer (test)",), fail=False):
        self._printers = list(printers)
        self.jobs = []
        self.fail = fail

    def available(self):
        return True

    def printers(self):
        return list(self._printers)

    def send(self, printer, data, job="Riyeser POS"):
        if self.fail:
            raise DrawerError("The printer is switched off (test).")
        if printer not in self._printers:
            raise DrawerError(f"There's no printer called “{printer}” on this computer.")
        self.jobs.append((printer, bytes(data), job))

    def pulses(self):
        return sum(d.count(PULSE) for _, d, _ in self.jobs)


def backend(app=None):
    """The raw printer to use: the app's (tests), else Windows' spooler, else none."""
    if app is None:
        from flask import current_app
        app = current_app
    fake = app.config.get("RAW_PRINTER")
    if fake is not None:
        return fake
    return WindowsRawPrinter() if sys.platform == "win32" else RawPrinter()


# ------------------------------------------------------------ ESC/POS receipt text
def _enc(text):
    """ESC/POS printers' default code page is PC437: keep plain characters, swap the rest for close ones."""
    swap = {"’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-", "•": "*", "…": "...", "×": "x", "·": "-", "€": "EUR", "₹": "Rs"}
    out = "".join(swap.get(c, c) for c in str(text))
    return out.encode("cp437", "replace")


def _row(left, right, width=WIDTH):
    left, right = str(left), str(right)
    room = width - len(right) - 1
    if len(left) > room:
        left = left[:max(room, 1)]
    return left + " " * (width - len(left) - len(right)) + right + "\n"


def money(cents, fmt=None):
    """$1,234.56, or in the company's own money format when the receipt carries it (money_fmt)."""
    if fmt:
        from .countries import format_money
        return format_money(cents, fmt)
    sign = "-" if cents < 0 else ""
    cents = abs(int(cents))
    return f"{sign}${cents // 100:,}.{cents % 100:02d}"


def _wrap(text, width):
    """A header or footer line broken at spaces to fit the paper (never cut off); at most 3 lines."""
    import textwrap
    return (textwrap.wrap(str(text or ""), max(width, 1), break_long_words=True) or [""])[:3]


def receipt_bytes(r, kick=False, width=WIDTH):
    """An ESC/POS receipt from a plain dict: company, number, date, lines [(qty, description, amount)], total, tax,
    tax_name, tenders [(label, amount)], change, footer, promos [(name, amount)], saved. kick: the drawer pulse first, so the drawer opens as the
    receipt starts printing."""
    b = bytearray()
    fm = r.get("money_fmt")
    if kick:
        b += PULSE
    b += INIT + CENTRE + BOLD_ON + DOUBLE + _enc("\n".join(_wrap(r.get("company", ""), width // 2))) + b"\n" + NORMAL + BOLD_OFF
    for line in r.get("header", []):
        b += _enc("\n".join(_wrap(line, width))) + b"\n"
    b += LEFT + _enc("-" * width + "\n")
    b += _enc(_row(f"Receipt {r.get('number', '')}", r.get("date", ""), width))
    if r.get("label"):
        b += _enc(r["label"][:width] + "\n")
    b += _enc("-" * width + "\n")
    for qty, desc, amt in r.get("lines", []):
        b += _enc(_row(f"{qty:g} x {desc}", money(amt, fm), width))
    for name, amt in r.get("promos", []):   # promotions already taken off the prices above
        b += _enc(_row(f"  {name}", "-" + money(amt, fm), width))
    if r.get("saved"):
        b += _enc(_row("You saved", money(r["saved"], fm), width))
    b += _enc("-" * width + "\n") + BOLD_ON + _enc(_row("TOTAL", money(r.get("total", 0), fm), width)) + BOLD_OFF
    if r.get("tax"):
        b += _enc(_row(f"Includes {r.get('tax_name') or 'GST'}", money(r["tax"], fm), width))
    for label, amt in r.get("tenders", []):
        b += _enc(_row(label, money(amt, fm), width))
    if r.get("change"):
        b += _enc(_row("Change", money(r["change"], fm), width))
    b += _enc("-" * width + "\n") + CENTRE
    for line in r.get("footer", ["Thank you!"]):
        b += _enc("\n".join(_wrap(line, width)) + "\n")
    b += _enc(datetime.now().strftime("%d/%m/%Y %H:%M") + "\n") + LEFT + CUT
    return bytes(b)
