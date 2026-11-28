"""Trial guard: the 90-day free trial keeps its start date when Riyeser is reinstalled or its data folders are wiped.

The trial's start is the EARLIEST valid date found in any of these (per program: "suite" is the trial every Riyeser
program shares, "estimate" is Riyeser Estimate's own first-use trial):
  1. licence.json trialStart and the hidden markers (signed_licence.py), and Estimate's first-use markers (licence.py)
  2. the Windows registry: HKCU\\Software\\Riyeser\\Trial (uninstalling doesn't remove it; Riyeser Central and Payroll
     read and write the same values: desktop/src/core/trial-guard.js on module/desk-assistant)
  3. a stamp inside each company file (the trial_stamp table), written when a trial starts or is first seen and read
     when a company is opened, so restoring an old company file into a fresh install keeps the older date
  4. Riyeser online's anonymous PC record, which Riyeser Central fetches (only when online) and keeps in the registry and
     licence.json ("trialGuard"); this app never goes online for it.
A signed licence from Riyeser online (a signed-in business) still decides over all of these (licence.py). Demo mode and
demo companies never stamp or change anything. Nothing here ever locks, deletes or blocks: a registry or company file
that can't be read or written just counts as "no date from there".
"""
import json
import os
import sys
from datetime import datetime, timezone

PROGRAMS = ("suite", "estimate")
REG_PATH = r"Software\Riyeser\Trial"
MIN_DATE = datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp()   # anything earlier isn't a real Riyeser trial date
CLOCK_SLACK = 48 * 3600.0
DAY = 86400.0


def _parse(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        t = float(v)
    else:
        try:
            d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        t = d.timestamp()
    return t if t >= MIN_DATE else None


def iso(t):
    return None if t is None else datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def earliest(values):
    xs = [x for x in (_parse(v) for v in values) if x is not None]
    return min(xs) if xs else None


# ---------------------------------------------------------------- the registry (an injectable shim)
class WindowsRegistry:
    """HKCU\\Software\\Riyeser\\Trial through winreg. Never raises."""
    kind = "windows"

    def read(self):
        out = {}
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH) as k:
                i = 0
                while True:
                    try:
                        name, value, _type = winreg.EnumValue(k, i)
                    except OSError:
                        break
                    out[name] = value
                    i += 1
        except Exception:
            pass
        return out

    def write(self, values):
        try:
            import winreg
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_PATH) as k:
                for name, v in values.items():
                    if isinstance(v, int) and not isinstance(v, bool):
                        winreg.SetValueEx(k, name, 0, winreg.REG_DWORD, v)
                    else:
                        winreg.SetValueEx(k, name, 0, winreg.REG_SZ, str(v))
        except Exception:
            pass   # can't write: the other places still count


class MemoryRegistry:
    """For tests: the same interface, in memory."""
    kind = "memory"

    def __init__(self, data=None):
        self.data = dict(data or {})

    def read(self):
        return dict(self.data)

    def write(self, values):
        self.data.update(values)


# None until the desktop launcher turns it on (riyeser/desktop.py), so tests never touch the real registry.
_config = {"registry": None}


def configure(registry):
    _config["registry"] = registry


def use_windows_defaults():
    if sys.platform != "win32" or os.environ.get("RIYESER_NO_TRIAL_REGISTRY") == "1":
        return False
    configure(WindowsRegistry())
    return True


def _reg_read():
    r = _config["registry"]
    try:
        return (r.read() or {}) if r else {}
    except Exception:
        return {}


def _reg_write(values):
    r = _config["registry"]
    if r and values:
        try:
            r.write(values)
        except Exception:
            pass


# ---------------------------------------------------------------- licence.json's "trialGuard" copy
def _licence_file(riyeser_dir):
    return os.path.join(riyeser_dir, "licence.json")


def _read_json(f):
    try:
        with open(f, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def sources(riyeser_dir, program="suite"):
    """{registry, company_file, online, extra_days, latest, clock_back_at} (seconds) for one program."""
    r = _reg_read()
    g = _read_json(_licence_file(riyeser_dir)).get("trialGuard") or {}
    p = g.get(program) or {}
    reg_at, file_at = _parse(r.get("OnlineCheckedAt")), _parse(g.get("onlineCheckedAt"))
    try:
        extra = int(r.get(f"{program}.OnlineExtra")) if reg_at is not None and (file_at is None or reg_at >= file_at) else int(p.get("onlineExtra") or 0)
    except (TypeError, ValueError):
        extra = 0
    latest = [x for x in (_parse(r.get("LatestSeen")), _parse(g.get("latestSeen"))) if x is not None]
    return {
        "registry": _parse(r.get(program)),
        "company_file": earliest([r.get(f"{program}.CompanyFile"), p.get("companyFile")]),
        "online": earliest([r.get(f"{program}.Online"), p.get("online")]),
        "extra_days": max(0, min(365, extra)),
        "latest": max(latest) if latest else None,
        "clock_back_at": _parse(r.get("ClockBack")) or _parse(g.get("clockBack")),
    }


def extra_for(riyeser_dir, program="suite"):
    """The extra input for signed_licence.local_trial: earlier starts, the latest time seen, goodwill days."""
    s = sources(riyeser_dir, program)
    return {"starts": [x for x in (s["registry"], s["company_file"], s["online"]) if x is not None],
            "latest": s["latest"], "extra_days": s["extra_days"]}


def record(riyeser_dir, program, start=None, latest=None, company_file=None, now=None):
    """Keep what's known now in the registry and licence.json's "trialGuard" (only what changed)."""
    if program not in PROGRAMS:
        return False
    now = float(now if now is not None else datetime.now(timezone.utc).timestamp())
    r = _reg_read()
    before = sources(riyeser_dir, program)
    reg = {}
    s = earliest([start, r.get(program)])
    if s is not None and _parse(r.get(program)) != s:
        reg[program] = iso(s)
    cf = earliest([company_file, before["company_file"]])
    if cf is not None and _parse(r.get(f"{program}.CompanyFile")) != cf:
        reg[f"{program}.CompanyFile"] = iso(cf)
    seen = max(_parse(latest) or 0, now)
    if before["latest"] is not None and now < before["latest"] - CLOCK_SLACK and not (
            before["clock_back_at"] and abs(now - before["clock_back_at"]) < 3600):
        reg["ClockBack"] = iso(now)
    if not (before["latest"] is not None and seen - before["latest"] < 3600) and seen >= (before["latest"] or 0):
        reg["LatestSeen"] = iso(seen)
    _reg_write(reg)
    # the copy in licence.json (also where it's kept on PCs without a registry)
    f = _licence_file(riyeser_dir)
    try:
        d = _read_json(f)
        g = dict(d.get("trialGuard") or {})
        p = dict(g.get(program) or {})
        was = json.dumps(p, sort_keys=True)
        if cf is not None:
            p["companyFile"] = iso(cf)
        changed = json.dumps(p, sort_keys=True) != was or "ClockBack" in reg or "LatestSeen" in reg
        if changed and os.path.isdir(riyeser_dir):
            g[program] = p
            if "ClockBack" in reg:
                g["clockBack"] = reg["ClockBack"]
            if "LatestSeen" in reg:
                g["latestSeen"] = reg["LatestSeen"]
            d["trialGuard"] = g
            tmp = f"{f}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(d, fh, indent=2)
            os.replace(tmp, f)
    except OSError:
        pass   # read-only: the registry keeps it
    return True


# ---------------------------------------------------------------- the stamp inside each company file
_TABLE = ("CREATE TABLE IF NOT EXISTS trial_stamp (program TEXT PRIMARY KEY, trial_start TEXT NOT NULL, "
          "stamped_at TEXT NOT NULL)")


def read_stamp(db, program):
    """The trial start stamped in this company file (seconds), or None."""
    try:
        row = db.execute("SELECT trial_start FROM trial_stamp WHERE program=?", (program,)).fetchone()
    except Exception:
        return None
    return _parse(row[0]) if row else None


def write_stamp(db, program, start, now=None):
    """Stamp the trial start into the company file; an earlier stamp is never moved later."""
    if program not in PROGRAMS or _parse(start) is None:
        return False
    old = read_stamp(db, program)
    new = earliest([start, old])
    if old is not None and new == old:
        return False
    now = float(now if now is not None else datetime.now(timezone.utc).timestamp())
    try:
        db.execute(_TABLE)
        db.execute("INSERT INTO trial_stamp (program, trial_start, stamped_at) VALUES (?,?,?) "
                   "ON CONFLICT(program) DO UPDATE SET trial_start=excluded.trial_start, stamped_at=excluded.stamped_at",
                   (program, iso(new), iso(now)))
        db.commit()
        return True
    except Exception:
        return False   # a read-only or locked company file: the other places still count


def sync_company(db, riyeser_dir, now=None, demo=False):
    """A company file is open: pass its older stamps on (registry, licence.json), and stamp it with the trial's start.
    Demo companies and demo mode: nothing at all."""
    if demo:
        return {}
    from . import licence as L
    from . import signed_licence as S
    now_dt = now if isinstance(now, datetime) else (datetime.fromtimestamp(now, timezone.utc) if now else datetime.now(timezone.utc))
    t = now_dt.timestamp()
    out = {}
    for program in PROGRAMS:
        stamp = read_stamp(db, program)
        if stamp is not None:
            record(riyeser_dir, program, company_file=stamp, now=t)
        if program == "suite":
            lt = S.local_trial(riyeser_dir, L.own_dir(), now_dt, start_now=False, extra=extra_for(riyeser_dir, "suite"))
            start = lt["start"] if lt else None
        else:
            fu = L.first_use_status(program, now_dt, riyeser_dir)
            start = fu.get("start") if fu.get("started") else None
        if start is not None:
            record(riyeser_dir, program, start=start, now=t)
            write_stamp(db, program, start, t)
            out[program] = earliest([start, stamp])
        elif stamp is not None:
            out[program] = stamp
    return out
