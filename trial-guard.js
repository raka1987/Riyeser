// Trial guard: keeps the 90-day free trial's start date when Riyeser is reinstalled or its data folders are wiped.
//
// The trial's start is the EARLIEST valid date found in any of these (per program: 'suite' is the trial every Riyeser
// program shares, 'estimate' is Riyeser Estimate's own first-use trial):
//   1. licence.json trialStart and the hidden markers (signed-licence.js), as before
//   2. the Windows registry: HKCU\Software\Riyeser\Trial (uninstalling doesn't remove it; Accounting, Payroll and
//      Central all read and write it)
//   3. a stamp inside each company file (Accounting's books, Payroll's database), passed on to the registry when a company
//      is opened, so restoring an old company file into a fresh install keeps the older date (riyeser/trial_guard.py)
//   4. Riyeser online's anonymous PC record (only when online): pcId = HMAC-SHA256(Windows MachineGuid, APP_KEY), so the
//      PC's own id never leaves it. The server keeps the earliest date for each pcId and program and never moves it later.
// A signed licence from Riyeser online (a signed-in business) still decides over all of these (signed-licence.js check).
// Nothing here ever locks or deletes anything, and nothing here blocks: an unreachable server or registry just counts as
// "no date from there". Demo mode never writes any of it.
//
// The same file is in Riyeser Central (desktop/src/core/trial-guard.js, branch module/desk-assistant); riyeser/trial_guard.py
// follows the same rules. Keep them in step.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 86400000;
const CLOCK_SLACK_MS = 48 * 3600 * 1000;      // the clock may be this far behind the latest time seen (as signed-licence.js)
const PROGRAMS = ['suite', 'estimate'];
const REG_KEY = 'HKCU\\Software\\Riyeser\\Trial';
// A fixed key for the one-way PC code. It isn't a secret (it's in every copy of Riyeser): it only makes sure the code is
// Riyeser's own, so it can't be matched against the MachineGuid other software may send.
const APP_KEY = 'riyeser-trial-pc-v1:7d1f0c2a9b4e4f63a8e5c6d2b1a09f37';
const MIN_DATE = Date.parse('2024-01-01T00:00:00Z');   // anything earlier isn't a real Riyeser trial date
const ONLINE_EVERY_MS = 20 * 3600 * 1000;
const ONLINE_TIMEOUT_MS = 8000;

const valid = (ms) => Number.isFinite(ms) && ms >= MIN_DATE;
const parse = (s) => { const v = typeof s === 'number' ? s : Date.parse(s); return valid(v) ? v : null; };
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const earliest = (xs) => { const v = xs.map(parse).filter((x) => x != null); return v.length ? Math.min(...v) : null; };

// ---------- the one-way PC code ----------
/** pcId: HMAC-SHA256 of the MachineGuid (lower case, trimmed) with APP_KEY, as 64 hex characters. null without one. */
function pcIdFrom(machineGuid) {
  const g = String(machineGuid || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{16,64}$/.test(g)) return null;
  return crypto.createHmac('sha256', APP_KEY).update(g).digest('hex');
}
/** Windows: HKLM\SOFTWARE\Microsoft\Cryptography MachineGuid (any Windows user can read it). null elsewhere. */
function readMachineGuid({ platform = process.platform, run = require('child_process').execFileSync } = {}) {
  if (platform !== 'win32') return null;
  try {
    const out = String(run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { windowsHide: true, timeout: 5000 }));
    const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(out);
    return m ? m[1] : null;
  } catch { return null; }
}

// ---------- the registry (an injectable shim: tests and other systems use none, or one in memory) ----------
/** HKCU\Software\Riyeser\Trial through reg.exe. read() -> { name: value }, write({ name: value }). Never throws. */
function windowsRegistry({ run = require('child_process').execFileSync, key = REG_KEY } = {}) {
  let cache = null; let at = 0;
  return {
    kind: 'windows',
    read() {
      if (cache && Date.now() - at < 30000) return { ...cache };
      const out = {};
      try {
        const text = String(run('reg', ['query', key], { windowsHide: true, timeout: 5000 }));
        for (const line of text.split(/\r?\n/)) {
          const m = /^\s{2,}(\S.*?)\s{2,}(REG_SZ|REG_DWORD)\s{2,}(.*)$/.exec(line);
          if (m) out[m[1]] = m[2] === 'REG_DWORD' ? Number(m[3]) : m[3].trim();
        }
      } catch { /* no key yet */ }
      cache = out; at = Date.now();
      return { ...out };
    },
    write(values) {
      for (const [name, v] of Object.entries(values)) {
        try {
          const dword = Number.isInteger(v);
          run('reg', ['add', key, '/v', name, '/t', dword ? 'REG_DWORD' : 'REG_SZ', '/d', String(v), '/f'], { windowsHide: true, timeout: 5000 });
          if (cache) cache[name] = v;
        } catch { /* can't write: the other places still count */ }
      }
    },
  };
}
/** For tests (and to show what's kept): the same interface, in memory. */
function memoryRegistry(init = {}) {
  const data = { ...init };
  return { kind: 'memory', data, read: () => ({ ...data }), write: (values) => { Object.assign(data, values); } };
}

// What this process uses. Nothing until a program's launcher turns it on (Central, Payroll), so unit tests never touch
// the real registry; configure({ registry: null }) turns it off again.
const config = { registry: null, machineGuid: undefined };
function configure({ registry, machineGuid } = {}) {
  if (registry !== undefined) config.registry = registry;
  if (machineGuid !== undefined) config.machineGuid = machineGuid;
  return config;
}
/** For a program's launcher on Windows: the real registry and MachineGuid. Does nothing elsewhere. */
function useWindowsDefaults({ platform = process.platform } = {}) {
  if (platform !== 'win32' || process.env.RIYESER_NO_TRIAL_REGISTRY === '1') return false;
  configure({ registry: windowsRegistry(), machineGuid: () => readMachineGuid() });
  return true;
}
function pcId() {
  const g = typeof config.machineGuid === 'function' ? config.machineGuid() : config.machineGuid;
  return pcIdFrom(g);
}

// ---------- the copy in licence.json ("trialGuard"): what came from company files and Riyeser online ----------
const licenceFile = (appData) => path.join(appData, 'Riyeser', 'licence.json');
function readJson(f) { try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d && typeof d === 'object' ? d : null; } catch { return null; } }
function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}
function regRead() { try { return config.registry ? config.registry.read() || {} : {}; } catch { return {}; } }

/** Riyeser Estimate's first-use markers in %APPDATA%\Riyeser (riyeser/licence.py writes them). */
function firstUseMarker(appData, program) {
  const d = readJson(path.join(appData, 'Riyeser', `.riyeser-trial-${program}.json`)) || {};
  return { start: parse(d.firstUse), latest: Number.isFinite(Number(d.latest)) ? Number(d.latest) * 1000 : null };
}

/**
 * The dates the guard knows for one program, besides licence.json and the markers (signed-licence.js reads those):
 * { registry, companyFile, online, extraDays, latest, clockBackAt, installs, checkedAt }
 */
function sources(appData, program = 'suite') {
  const r = regRead();
  const g = ((readJson(licenceFile(appData)) || {}).trialGuard) || {};
  const p = g[program] || {};
  const regAt = parse(r.OnlineCheckedAt); const fileAt = parse(g.onlineCheckedAt);
  // a goodwill extension is whatever Riyeser online said last (the newest answer wins, not the biggest)
  const extra = regAt != null && (fileAt == null || regAt >= fileAt) ? Number(r[`${program}.OnlineExtra`]) : Number(p.onlineExtra);
  return {
    registry: parse(r[program]),
    companyFile: earliest([r[`${program}.CompanyFile`], p.companyFile]),
    online: earliest([r[`${program}.Online`], p.online]),
    extraDays: Number.isInteger(extra) && extra > 0 ? Math.min(extra, 365) : 0,
    latest: Math.max(parse(r.LatestSeen) || 0, parse(g.latestSeen) || 0) || null,
    clockBackAt: parse(r.ClockBack) || parse(g.clockBack),
    installs: Number.isInteger(Number(r.Installs)) ? Number(r.Installs) : null,
    checkedAt: Math.max(regAt || 0, fileAt || 0) || null,
  };
}
/** The earliest start known for a program from every place here (Estimate: also its first-use marker). null: none yet. */
function knownStart(appData, program = 'suite') {
  const s = sources(appData, program);
  const lic = readJson(licenceFile(appData)) || {};
  return earliest([s.registry, s.companyFile, s.online, program === 'suite' ? lic.trialStart : firstUseMarker(appData, program).start]);
}
/** The extra input for signed-licence.js localTrial: earlier starts, the latest time seen, extra days. */
function extraFor(appData, program = 'suite') {
  const s = sources(appData, program);
  return { starts: [s.registry, s.companyFile, s.online].filter((x) => x != null), latest: s.latest, extraDays: s.extraDays };
}

/**
 * Keep what's known now, in the registry and licence.json's "trialGuard" (only what changed).
 * fields: { start, latest, companyFile, online, onlineExtra, checkedAt, now }
 */
function record(appData, program, { start, latest, companyFile, online, onlineExtra, checkedAt, now = Date.now() } = {}) {
  if (!PROGRAMS.includes(program)) return false;
  const r = regRead();
  const before = sources(appData, program);
  const reg = {};
  const s = earliest([start, r[program]]);
  if (s != null && parse(r[program]) !== s) reg[program] = iso(s);
  const cf = earliest([companyFile, before.companyFile]);
  if (cf != null && parse(r[`${program}.CompanyFile`]) !== cf) reg[`${program}.CompanyFile`] = iso(cf);
  if (online !== undefined && parse(online) != null) {
    const o = earliest([online, before.online]);
    if (parse(r[`${program}.Online`]) !== o) reg[`${program}.Online`] = iso(o);
  }
  if (onlineExtra !== undefined) reg[`${program}.OnlineExtra`] = String(Math.max(0, Math.min(365, Number(onlineExtra) || 0)));
  if (checkedAt) reg.OnlineCheckedAt = iso(checkedAt);
  // the latest time seen: kept at most once an hour; a clock seen going backwards is noted (for support), never punished here
  const seen = Math.max(parse(latest) || 0, now);
  if (before.latest != null && now < before.latest - CLOCK_SLACK_MS && !(before.clockBackAt && Math.abs(now - before.clockBackAt) < 3600 * 1000)) reg.ClockBack = iso(now);
  if (!(before.latest != null && seen - before.latest < 3600 * 1000) && seen >= (before.latest || 0)) reg.LatestSeen = iso(seen);
  if (Object.keys(reg).length && config.registry) { try { config.registry.write(reg); } catch { /* the other places still count */ } }
  // the copy in licence.json (also where it's kept on PCs without a registry)
  try {
    const f = licenceFile(appData);
    const d = readJson(f) || {};
    const g = { ...(d.trialGuard || {}) };
    const p = { ...(g[program] || {}) };
    const was = JSON.stringify(g[program] || {});
    if (cf != null) p.companyFile = iso(cf);
    if (online !== undefined && parse(online) != null) p.online = iso(earliest([online, p.online]));
    if (onlineExtra !== undefined) p.onlineExtra = Math.max(0, Math.min(365, Number(onlineExtra) || 0));
    const changed = JSON.stringify(p) !== was || (checkedAt && g.onlineCheckedAt !== iso(checkedAt)) || reg.ClockBack || reg.LatestSeen;
    if (changed && fs.existsSync(path.dirname(f))) {
      g[program] = p;
      if (checkedAt) g.onlineCheckedAt = iso(checkedAt);
      if (reg.ClockBack) g.clockBack = reg.ClockBack;
      if (reg.LatestSeen) g.latestSeen = reg.LatestSeen;
      writeJson(f, { ...d, trialGuard: g });
    }
  } catch { /* read-only: the registry keeps it */ }
  return true;
}

// ---------- Riyeser online's anonymous PC record ----------
/**
 * Register (or just look up) this PC's trial for each program with Riyeser online, then keep the server's (earliest) date.
 * rpc(name, args) is the anonymous call (no account: online.js call with auth false). starts: { program: ms | null }
 * (null: only look it up, e.g. Estimate not used on this Windows account yet). Never throws, never blocks for long.
 * -> { sent: n, results: { program: { trial_start, extra_days } }, skipped?: why }
 */
async function syncOnline({ appData, rpc, starts = {}, appVersion = null, now = Date.now(), demo = false, timeoutMs = ONLINE_TIMEOUT_MS } = {}) {
  if (demo) return { sent: 0, results: {}, skipped: 'demo' };
  const id = pcId();
  if (!id || typeof rpc !== 'function') return { sent: 0, results: {}, skipped: id ? 'offline' : 'no-pc-id' };
  const results = {}; let sent = 0;
  for (const program of PROGRAMS) {
    if (!(program in starts)) continue;
    const local = parse(starts[program]);
    let r; let timer = null;
    try {
      r = await Promise.race([
        Promise.resolve().then(() => rpc('pc_trial_seen', { pc: id, program, trial_start: iso(local), app_version: appVersion ? String(appVersion).slice(0, 40) : null })),
        new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), timeoutMs); }),
      ]);
    } catch { continue; }   // offline, rate limited, or the database hasn't had this release's team-chat.sql: local dates stand
    finally { clearTimeout(timer); }
    sent += 1;
    if (!r || typeof r !== 'object' || parse(r.trial_start) == null) continue;
    results[program] = { trial_start: r.trial_start, extra_days: Number(r.extra_days) || 0 };
    record(appData, program, { online: parse(r.trial_start), onlineExtra: Number(r.extra_days) || 0, checkedAt: now, now });
  }
  return { sent, results };
}
/** Due for the online check (at most once every 20 hours)? last: ms of the last one. */
const onlineDue = (last, now = Date.now()) => !(last > 0 && now - last < ONLINE_EVERY_MS && now >= last);

// ---------- for "Report an issue": the trial's history on this PC (licence data only: no names, paths or business data) ----------
/**
 * trials: { program: { start, ends, daysLeft, sources: { licence_json, marker } } } (computed by the program's licence code).
 * -> { pc_id, latest_seen, clock_back, clock_back_at, installs, programs: [{ program, start, ends, days_left, extra_days, sources }] }
 */
function report(appData, trials = {}, now = Date.now()) {
  const out = { pc_id: pcId(), latest_seen: null, clock_back: false, clock_back_at: null, installs: null, programs: [] };
  let latest = null;
  for (const program of PROGRAMS) {
    const t = trials[program];
    const s = sources(appData, program);
    latest = Math.max(latest || 0, s.latest || 0) || null;
    if (s.clockBackAt) { out.clock_back = true; out.clock_back_at = iso(Math.max(parse(out.clock_back_at) || 0, s.clockBackAt)); }
    if (s.installs != null) out.installs = s.installs;
    if (!t) continue;
    const src = { ...(t.sources || {}), registry: iso(s.registry), company_file: iso(s.companyFile), online: iso(s.online) };
    Object.keys(src).forEach((k) => { src[k] = src[k] ? iso(parse(src[k])) : null; });
    out.programs.push({ program, start: iso(t.start), ends: iso(t.ends), days_left: Math.max(0, Number(t.daysLeft) || 0), extra_days: s.extraDays, sources: src });
  }
  out.latest_seen = iso(Math.max(latest || 0, now));
  return out;
}
/** A short line for the Report an issue preview. */
function previewLine(r) {
  if (!r) return 'Not included';
  const days = r.programs.map((p) => `${p.program === 'suite' ? 'Riyeser trial' : 'Estimate trial'} from ${String(p.start || '').slice(0, 10)}, ${p.days_left} day(s) left`).join('; ');
  return `${days || 'No trial on this PC'} · PC code ${r.pc_id ? `${r.pc_id.slice(0, 8)}…` : 'none'} (one-way: it can't identify you)`;
}

module.exports = { PROGRAMS, REG_KEY, APP_KEY, CLOCK_SLACK_MS, MIN_DATE, pcIdFrom, readMachineGuid, windowsRegistry, memoryRegistry, configure, useWindowsDefaults,
  pcId, sources, knownStart, extraFor, record, syncOnline, onlineDue, report, previewLine, firstUseMarker, earliest };
