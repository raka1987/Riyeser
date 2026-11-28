"""Riyeser POS 2.11.1: POS setup › Hardware (receipt and kitchen printers, print layout, cash drawer, scanner) and
printing inside the app. A fake printer stands in for Windows' print spooler; nothing is printed. Synthetic data."""
import re
import glob
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from riyeser import pos_print as PP
from riyeser import drawer as D
from riyeser.db import get_db
from tests.test_pos_pins import shop, sale, books_ok, add_user, unlock  # noqa: F401  (the fixture)

PRN = "Receipt printer (test)"
ROOT = Path(__file__).resolve().parent.parent


def strip_escpos(job):
    """The printed characters only: ESC/POS commands taken out (by their known lengths)."""
    out, i, n = bytearray(), 0, len(job)
    arg = {b"\x1b@": 0, b"\x1bE": 1, b"\x1ba": 1, b"\x1bM": 1, b"\x1bJ": 1, b"\x1bd": 1, b"\x1bp": 3, b"\x1d!": 1,
           b"\x1dL": 2, b"\x1dW": 2}
    while i < n:
        two = job[i:i + 2]
        if two in arg:
            i += 2 + arg[two]
        elif two == b"\x1dV":
            i += 3 + (1 if job[i + 2] in (0x41, 0x42) else 0)
        else:
            out.append(job[i])
            i += 1
    return bytes(out)


def setup_receipt(c, till=1, printer=PRN, after="ask", copies=1):
    return c.post("/pos/hardware/save", data={"what": "receipt", "till_id": till, "receipt_printer": printer,
                                              "print_after": after, "copies": copies}, follow_redirects=True)


def new_till(c, name="Kiosk till"):
    return c.post("/pos/setup", data={"mode": "retail", "till_name_1": "Till 1", "new_till": name})


def test_settings_persist_per_till_and_a_new_till_walks_through(shop):
    c = shop["admin"]
    r = new_till(c)
    assert r.status_code == 302 and "/pos/hardware/start?till=2" in r.headers["Location"]
    setup_receipt(c, 1, PRN, "always", 2)
    setup_receipt(c, 2, "", "never", 1)
    c.post("/pos/hardware/save", data={"what": "drawer", "till_id": 2, "drawer_mode": "printer",
                                       "drawer_printer": PRN, "cash_sale": "1", "no_sale": "1"})
    with shop["app"].app_context():
        t1, t2 = get_db().execute("SELECT * FROM pos_tills ORDER BY id").fetchall()
    assert (t1["receipt_printer"], t1["print_after"], t1["receipt_copies"]) == (PRN, "always", 2)
    assert (t2["receipt_printer"], t2["print_after"]) == (None, "never")
    assert t1["drawer_mode"] == "none" and t2["drawer_mode"] == "printer"
    assert PP.drawer_on(t2) == {"cash_sale": True, "cash_refund": False, "no_sale": True}
    # the walkthrough: each step, skippable, and the till is marked set up at the end
    for step in ("receipt", "layout", "adjust", "drawer", "scanner", "card"):
        page = c.get(f"/pos/hardware/start?till=2&step={step}").get_data(as_text=True)
        assert "Set up Kiosk till" in page and "hw-steps" in page
    assert "Skip this step" in c.get("/pos/hardware/start?till=2&step=receipt").get_data(as_text=True)
    assert "Kiosk till is ready" in c.get("/pos/hardware/start?till=2&step=done").get_data(as_text=True)
    with shop["app"].app_context():
        assert get_db().execute("SELECT hw_setup_at FROM pos_tills WHERE id=2").fetchone()[0]


def test_device_status_cards(shop):
    c = shop["admin"]
    page = c.get("/pos/hardware").get_data(as_text=True)
    for card in ("Receipt printer", "Cash drawer", "Barcode scanner", "Card machine", "Customer display"):
        assert card in page
    assert "Not set up: receipts use the Windows print box" in page and "Planned" in page
    assert "Works with most 80 mm and 58 mm receipt printers installed in Windows (ESC/POS)" in page and "Beta" in page
    setup_receipt(c, 1, "Gone printer")
    assert "Problem: “Gone printer” isn&#39;t installed on this PC" in c.get("/pos/hardware").get_data(as_text=True)
    setup_receipt(c, 1, PRN)
    c.post("/pos/hardware/scanner-tested", json={"enter": True})
    page = c.get("/pos/hardware").get_data(as_text=True)
    assert page.count("st-ok") >= 2 and "tested" in page
    c.post("/pos/hardware/scanner-tested", json={"enter": False})
    assert "doesn&#39;t press Enter" in c.get("/pos/hardware").get_data(as_text=True)


def test_always_prints_once_silently_with_the_copies(shop):
    s, c, pr = shop, shop["admin"], shop["printer"]
    setup_receipt(c, 1, PRN, "always", 2)
    c.post("/pos/shift/open", json={"till_id": 1, "float": "0"})
    sid = sale(c, s).get_json()["sale_id"]
    page = c.get("/pos/").get_data(as_text=True)
    assert '"after": "always"' in page and "printReceipt(true)" in page              # the till prints after a sale
    before = len(pr.jobs)
    r = c.post(f"/pos/receipt/{sid}/raw", json={"till_id": 1, "auto": True}).get_json()
    assert r["ok"] and len(pr.jobs) == before + 1                                     # one job to the printer ...
    job = pr.jobs[-1][1]
    assert job.count(b"TOTAL") == 2 and pr.jobs[-1][0] == PRN                         # ... with two copies
    r = c.post(f"/pos/receipt/{sid}/raw", json={"till_id": 1}).get_json()             # a reprint: one copy
    assert pr.jobs[-1][1].count(b"TOTAL") == 1
    books_ok(s)


def test_missing_printer_falls_back_to_the_windows_print_box(shop):
    s, c, pr = shop, shop["admin"], shop["printer"]
    setup_receipt(c, 1, "Unplugged printer")
    c.post("/pos/shift/open", json={"till_id": 1, "float": "0"})
    sid = sale(c, s).get_json()["sale_id"]
    r = c.post(f"/pos/receipt/{sid}/raw", json={"till_id": 1})
    assert r.status_code == 502 and r.get_json()["fallback"] and "Windows print box" in r.get_json()["error"]
    t = c.post("/pos/hardware/test-print", json={"till_id": 1})
    assert t.status_code == 502 and "/pos/hardware/preview" in t.get_json()["fallback"]
    setup_receipt(c, 1, "")
    t = c.post("/pos/hardware/test-print", json={"till_id": 1}).get_json()
    assert not t["ok"] and t["fallback"]
    assert c.get(t["fallback"]).status_code == 200
    books_ok(s)


def test_test_print_and_alignment_slip_use_the_fake_printer(shop):
    c, pr = shop["admin"], shop["printer"]
    setup_receipt(c, 1, PRN)
    assert c.post("/pos/hardware/test-print", json={"till_id": 1}).get_json()["ok"]
    assert b"TEST" in pr.jobs[-1][1] and pr.jobs[-1][2] == "Riyeser POS test receipt"
    assert c.post("/pos/hardware/test-print", json={"target": "till:1", "kind": "align"}).get_json()["ok"]
    job = pr.jobs[-1][1]
    assert b"TOP" in job and b"BOTTOM" in job and b"L " in job and b" R\n" in job
    page = c.get("/pos/hardware/align?target=till:1").get_data(as_text=True)
    assert all(x in page for x in ('class="l">L<', 'class="rr">R<', ">TOP<", ">BOTTOM<", "class=\"ruler\""))
    hw = c.get("/pos/hardware").get_data(as_text=True)
    assert "if the <b>L</b> marker is cut off, make the left margin bigger (+1 mm)" in hw


def test_print_layout_persists_and_applies_to_both_print_paths(shop):
    s, c, pr = shop, shop["admin"], shop["printer"]
    setup_receipt(c, 1, PRN)
    r = c.post("/pos/hardware/save", data={"what": "adjust", "target": "till:1", "paper": "58", "chars": "auto",
                                           "left": "1.5", "right": "0.5", "top": "2", "bottom": "1", "scale": "110",
                                           "font": "small", "logo_mm": "30", "feed": "5"})   # cut unticked
    assert r.status_code == 302
    with s["app"].app_context():
        t = get_db().execute("SELECT * FROM pos_tills WHERE id=1").fetchone()
    lay = PP.layout_of(t)
    assert (lay["mm"], lay["left"], lay["top"], lay["feed"], lay["cut"], lay["font"]) == (58, 1.5, 2.0, 5, False, "small")
    assert t["paper_mm"] == 58
    c.post("/pos/shift/open", json={"till_id": 1, "float": "0"})
    sid = sale(c, s).get_json()["sale_id"]
    c.post(f"/pos/receipt/{sid}/raw", json={"till_id": 1})
    job = pr.jobs[-1][1]
    assert job.startswith(D.INIT + b"\x1bM\x01")                                        # small font (font B)
    assert b"\x1dL" + (12).to_bytes(2, "little") in job                                 # left margin 1.5 mm = 12 dots
    assert b"\x1dW" + int((48 - 1.5 - 0.5) * 8).to_bytes(2, "little") in job           # print width
    assert b"\x1bJ" + bytes([16]) in job                                                # top 2 mm
    assert job.endswith(b"\x1bd\x05") and b"\x1dV" not in job                           # 5 lines, no cut
    html = c.get(f"/pos/receipt/{sid}").get_data(as_text=True)                          # the Windows print path
    assert "width:46mm" in html and "@page{size:58mm auto" in html and "margin:0 0 0 6.5mm" in html
    c.post("/pos/hardware/save", data={"what": "adjust_reset", "target": "till:1"})
    with s["app"].app_context():
        lay = PP.layout_of(get_db().execute("SELECT * FROM pos_tills WHERE id=1").fetchone())
    assert (lay["mm"], lay["left"], lay["cut"], lay["feed"]) == (80, 0.0, True, 3)
    sid = sale(c, s).get_json()["sale_id"]
    c.post(f"/pos/receipt/{sid}/raw", json={"till_id": 1})
    assert pr.jobs[-1][1].endswith(D.CUT)                                               # the usual cut again
    books_ok(s)


@pytest.mark.parametrize("paper,custom,chars", [("58", 70, "auto"), ("custom", 50, "auto"), ("custom", 44, "custom"),
                                                ("80", 70, "48")])
def test_narrow_and_custom_widths_never_overflow(paper, custom, chars):
    lay = PP.computed(PP.clean_layout({"paper": paper, "custom_mm": custom, "chars": chars, "chars_custom": 30}))
    data = dict(company="Synthetic Surf & Cafe With A Long Name", header=["1 Example Esplanade, Sampletown 0000",
                                                                         "ABN 00 000 000 000"],
                number="INV-000123", date="2026-11-28", lines=[(12, "Extra long product name that goes on and on", 123456)],
                total=123456, tax=11223, tax_name="GST", tenders=[("Card / EFTPOS", 123456)], change=0,
                footer=["Thank you! Returns within 14 days with your receipt please"])
    for job in (PP.receipt_job(data, lay), PP.docket_job("Kitchen", "Table 12", 7, "Synthetic Cashier",
                                                         [(2, "A very long burger name with extras", "no onion please")],
                                                         lay), PP.alignment_job(lay, "Till 1")):
        text = strip_escpos(job)
        for line in text.split(b"\n"):
            assert len(line) <= lay["cpl"], (lay["cpl"], line)


def test_58mm_html_receipt_fits(shop):
    c = shop["admin"]
    page = c.get("/pos/hardware/preview?lay=1&paper=58&target=till:1").get_data(as_text=True)
    assert ".r{width:48mm;max-width:100%" in page and "overflow-wrap:anywhere" in page and "@page{size:58mm" in page
    page = c.get("/pos/hardware/preview?lay=1&paper=custom&custom_mm=50&target=till:1").get_data(as_text=True)
    assert ".r{width:42mm" in page


def test_kitchen_station_routes_to_its_own_printer(shop):
    s, c, pr = shop, shop["admin"], shop["printer"]
    pr._printers.append("Bar printer (test)")
    c.post("/pos/setup", data={"mode": "restaurant", "mode_changed": "1"})
    c.post("/pos/kitchen", data={"what": "stations", "name_1": "Kitchen", "output_1": "print", "new_name": "Bar",
                                 "new_output": "print", "amber": "8", "red": "15"})
    c.post("/pos/kitchen", data={"what": "stations", "name_1": "Kitchen", "output_1": "print", "name_2": "Bar",
                                 "output_2": "print", "active_2": "1", "cat::Drinks": "2", "amber": "8", "red": "15"})
    c.post("/pos/hardware/save", data={"what": "kitchen", "printer_1": "", "printer_2": "Bar printer (test)"})
    c.post("/pos/hardware/save", data={"what": "adjust", "target": "station:2", "paper": "58", "feed": "2", "cut": "1"})
    n = len(pr.jobs)
    d = c.post("/pos/order", json={"order_type": "takeaway", "kitchen": True,
                                   "lines": [{"item_id": s["tea"], "qty": 2, "note": "extra hot"}]}).get_json()
    assert d["ok"] and d["printed"] == ["Bar"] and d["docket_url"] is None
    printer, job, name = pr.jobs[n]
    assert printer == "Bar printer (test)" and b"2 x Tea" in job and b"extra hot" in job and b"** BAR **" in job
    assert job.endswith(b"\x1dV\x42\x02")                                               # its own feed + cut
    assert c.post("/pos/hardware/test-docket", json={"station_id": 2}).get_json()["ok"]
    assert b"Test docket".upper() in pr.jobs[-1][1]
    # a station without a printer: the docket prints with the Windows print box, for that station only
    c.post("/pos/hardware/save", data={"what": "kitchen", "printer_1": "", "printer_2": ""})
    d = c.post("/pos/order", json={"order_type": "takeaway", "kitchen": True,
                                   "lines": [{"item_id": s["tea"], "qty": 1}]}).get_json()
    assert "only=2" in d["docket_url"]
    assert c.get(d["docket_url"]).status_code == 200


def test_drawer_options_are_respected(shop):
    s, c, pr = shop, shop["admin"], shop["printer"]
    c.post("/pos/hardware/save", data={"what": "drawer", "till_id": 1, "drawer_mode": "printer",
                                       "drawer_printer": PRN, "cash_refund": "1"})          # not on cash sales / no sale
    c.post("/pos/shift/open", json={"till_id": 1, "float": "0"})
    r = sale(c, s).get_json()
    assert r["ok"] and pr.pulses() == 0
    r = c.post("/pos/drawer/open", json={"till_id": 1, "reason": "Give change"}).get_json()
    assert not r["ok"] and "No sale is turned off" in r["error"]
    assert c.get("/pos/drawer").headers["Location"].endswith("/pos/hardware#drawer")       # moved to Hardware
    books_ok(s)


def test_scanner_settings_and_unknown_barcode_permissions(shop):
    s, c = shop, shop["admin"]
    c.post("/pos/hardware/save", data={"what": "scanner", "prefix": "]C1", "suffix": "", "capture": "1", "beep": "1",
                                       "unknown": "offer"})
    page = c.get("/pos/").get_data(as_text=True)
    assert '"prefix": "]C1"' in page and "CAN_ADD=true" in page.replace(" ", "") and "pos-scanner.js" in page
    assert "Add a new product with this code" in page and "Ask a manager" in page
    assert 'value="9300000000017"' not in c.get("/inventory/new").get_data(as_text=True)
    assert 'value="9300000000017"' in c.get("/inventory/new?barcode=9300000000017").get_data(as_text=True)
    add_user(s, "maria", "cashier", "1111")
    add_user(s, "jo", "cashier", "2222")
    unlock(c, "1111")
    assert "CAN_ADD=false" in c.get("/pos/").get_data(as_text=True).replace(" ", "")      # a cashier: Ask a manager


@pytest.mark.skipif(not shutil.which("node"), reason="Node isn't installed")
def test_scanner_detection_logic_in_node():
    js = r"""
const S = require(process.argv[1]); let got = [];
const d = S.createDetector({prefix: ']C1', suffix: '#', onScan: c => got.push(c)});
const feed = (s, gap, t0) => { let t = t0; for (const ch of s) { d.key(ch, t += gap); } return d.key('Enter', t + gap); };
const out = {};
out.fast = feed(']C19300000000017#', 8, 0); out.code = got.pop();
out.slow = feed('flat white', 140, 10000); out.slowGot = got.length;
out.short = feed('12', 5, 20000);
out.pause = feed('93000', 8, 30000);
let t = 40000; for (const ch of 'tea') d.key(ch, t += 150); t += 300; for (const ch of '9300000000017') d.key(ch, t += 8);
out.mixed = d.key('Enter', t + 8); out.mixedCode = got.pop();
out.strip = S.strip(']C1ABC#', ']C1', '#');
console.log(JSON.stringify(out));
"""
    r = subprocess.run(["node", "-e", js, str(ROOT / "riyeser/static/pos-scanner.js")], capture_output=True, text=True,
                       timeout=60)
    o = json.loads(r.stdout)
    assert o["fast"] == "scan" and o["code"] == "9300000000017"         # fast + Enter: a scan, prefix/suffix gone
    assert o["slow"] == "pass" and o["slowGot"] == 0                    # someone typing: left alone
    assert o["short"] == "pass"
    assert o["pause"] == "scan"
    assert o["mixed"] == "scan" and o["mixedCode"] == "9300000000017"   # typing, then a scan: only the scan
    assert o["strip"] == "ABC"


def test_no_print_or_pdf_link_leaves_the_app():
    """Links to Riyeser's own pages never open a new window (the desktop app sends those to the web browser, which
    isn't signed in): they print or open inside the app (riyeser/static/inapp.js)."""
    bad = []
    for f in glob.glob(str(ROOT / "riyeser/templates/**/*.html"), recursive=True):
        s = Path(f).read_text(encoding="utf-8")
        for a in re.findall(r"<a\b[^>]*>", s):
            if re.search(r'target="?(_blank|receipt|docket)', a) and re.search(r'href="(\{\{ ?url_for|/|\$\{)', a):
                bad.append((Path(f).name, a[:120]))
        if re.search(r"window\.open\(", s):
            bad.append((Path(f).name, "window.open"))
    assert bad == []
    base = (ROOT / "riyeser/templates/base.html").read_text()
    pos = (ROOT / "riyeser/templates/pos/_pos.html").read_text()
    assert "inapp.js" in base and "inapp.js" in pos
