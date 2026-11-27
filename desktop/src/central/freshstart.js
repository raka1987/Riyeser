// "Fresh start on this PC" (Riyeser Central → Settings): puts away everything Riyeser has saved on this PC so every
// program starts like it's brand new. Nothing is ever deleted: each data folder is renamed to a sibling called
// "<name> (before fresh start 2026-11-24 0912)", and a fresh-start-log.json in the first one lists what went where,
// so it can all be brought back ("Bring back a fresh start…").
//
// Where each Riyeser program keeps its data on Windows (from each program's own code):
//   - Riyeser Accounting (Basics, Plus), Invoices, POS, Bookings: RIYESER_HOME, else %USERPROFILE%\.riyeser
//     (company.db, companies\, archive\, demo\). Same rule as riyeser/cli.py and Central's sources.accountingDbPath.
//   - Riyeser Payroll: %APPDATA%\Riyeser Payroll (its Electron userData; records in payroll\, demo in payroll\demo).
//   - Riyser (Payroll's earlier name): %APPDATA%\Riyser. Payroll brings its records in when its own are empty, so it
//     has to go too, or a fresh Payroll would pull the old records straight back.
//   - Riyeser Desk Assistant: %APPDATA%\Desk Assistant (main.js). Riyeser PDF: %APPDATA%\Desk PDF (pdf-main.js).
//   - Riyeser Link (formerly Team, the chat app): %APPDATA%\Riyeser Team (team-main.js; its sign-in and chats).
//   - Riyeser Link Office: %APPDATA%\Riyeser Link Office (link-main.js; settings, desk phones, logs).
//   - As Built: %APPDATA%\Riyeser Services (services-main.js; its projects).
//   - Shared Riyeser files: %APPDATA%\Riyeser (company.json, licence.json, demo.json, ...).
//   - Riyeser Central: %APPDATA%\Riyeser Central (settings, checklist, set-up, sign-in, device id, Link window), and
//     %APPDATA%\Riyser Central from before 1.2 (Central would move that one across again on its next start).
// Documents\Riyeser (payslips, backups, PDFs) is the person's own documents and is left where it is.
//
// Central's own folder is open while it runs, so it's done last, on Central's next start: a marker
// (fresh-start.json) is written into it, Central restarts, and before it loads anything finishOnStart() renames the
// folder (trying again for a few seconds while the old copy closes). When the person keeps their Riyeser sign-in,
// only that (online.json's session) is copied into the new, empty folder.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const LABEL = 'before fresh start';
const BACK_LABEL = 'before bringing back';
const LOG = 'fresh-start-log.json';
const MARKER = 'fresh-start.json';
const CONFIRM = 'START FRESH';

const accountingHome = (env = process.env, home = os.homedir()) => env.RIYESER_HOME || path.join(home, '.riyeser');

/** Every folder a fresh start puts away, in order. Central's own folder is last and marked `central` (done on restart). */
function folders({ appData, env = process.env, home = os.homedir(), centralDir = path.join(appData, 'Riyeser Central') }) {
  return [
    { id: 'accounting', name: 'Riyeser Accounting, Invoices, POS, Bookings and Estimate', dir: accountingHome(env, home) },
    { id: 'payroll', name: 'Riyeser Payroll', dir: path.join(appData, 'Riyeser Payroll') },
    { id: 'payroll-old', name: 'Riyser (Payroll’s earlier name)', dir: path.join(appData, 'Riyser') },
    { id: 'desk', name: 'Riyeser Desk Assistant', dir: path.join(appData, 'Desk Assistant') },
    { id: 'pdf', name: 'Riyeser PDF', dir: path.join(appData, 'Desk PDF') },
    { id: 'team', name: 'Riyeser Link', dir: path.join(appData, 'Riyeser Team') },
    { id: 'linkoffice', name: 'Riyeser Link Office', dir: path.join(appData, 'Riyeser Link Office') },
    { id: 'services', name: 'As Built', dir: path.join(appData, 'Riyeser Services') },
    { id: 'shared', name: 'Shared Riyeser files (company, licence, demo)', dir: path.join(appData, 'Riyeser') },
    { id: 'central-old', name: 'Riyeser Central (before 1.2)', dir: path.join(appData, 'Riyser Central') },
    { id: 'central', name: 'Riyeser Central', dir: centralDir, central: true },
  ];
}

const pad = (n) => String(n).padStart(2, '0');
/** 2026-11-24 0912 (local time): safe in a Windows folder name. */
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** A sibling name nobody has used yet: "<name> (before fresh start <stamp>)", then "... <stamp>-2)" and so on. */
function awayName(dir, label, when, taken = new Set()) {
  for (let i = 1; ; i++) {
    const to = path.join(path.dirname(dir), `${path.basename(dir)} (${label} ${when}${i > 1 ? `-${i}` : ''})`);
    if (!fs.existsSync(to) && !taken.has(to.toLowerCase())) return to;
  }
}

/** Never rename a folder that isn't clearly Riyeser's own (e.g. RIYESER_HOME pointed at the home folder or a drive). */
function tooBroad(dir, { appData, home }) {
  const r = path.resolve(dir);
  return [appData, home, path.parse(r).root, path.dirname(appData)].filter(Boolean).some((p) => same(p, r));
}

/** What a fresh start would put away right now (folders that exist). */
function plan(opts) {
  const { appData, home = os.homedir() } = opts;
  return folders(opts).filter((f) => isDir(f.dir) && !tooBroad(f.dir, { appData, home }));
}

// ---------- which Riyeser programs are open ----------
/** Program names whose .exe is in the running list (image names, any case). Central itself isn't counted. */
function openPrograms(programs, running) {
  const live = new Set((running || []).map((n) => String(n).toLowerCase()));
  return programs.filter((p) => (p.exes || []).some((e) => live.has(e.toLowerCase()))).map((p) => p.full || p.name);
}
/** The programs running on this PC, from Windows' own list (tasklist). Elsewhere: none. */
function runningImages({ platform = process.platform, exec = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => exec('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
    if (err) return resolve(null);   // couldn't tell
    resolve(String(out || '').split(/\r?\n/).map((l) => (/^"([^"]+)"/.exec(l) || [])[1]).filter(Boolean));
  }));
}
const closeFirst = (names) => (names.length ? `Close these first: ${names.join(', ')}.` : '');

/** The programs running on this PC with their process ids: [{ image, pid }] (tasklist), or null when it can't tell. */
function runningProcesses({ platform = process.platform, exec = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => exec('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
    if (err) return resolve(null);
    resolve(String(out || '').split(/\r?\n/).map((l) => /^"([^"]+)","(\d+)"/.exec(l)).filter(Boolean).map((m) => ({ image: m[1], pid: Number(m[2]) })));
  }));
}
const cantClose = (name) => `Couldn't close ${name}. Close it yourself, then press Check again.`;
/**
 * "Close them for me": close each open Riyeser program properly, then look again. Never forced, because a program
 * might be saving. Riyeser Link and Link Office (quitArg) are asked to quit by starting them with --quit (they stay
 * by the clock when their window is closed); every other program gets a normal close (taskkill /PID, never /F),
 * the same as clicking its X. Waits up to timeoutMs for them to go.
 * opts: { programs, list: () => [{image,pid}]|null, locate: (program) => exe|null, launch: (exe, args), exec, wait, timeoutMs, pollMs }
 * -> { closed: [names], stillOpen: [names], message }
 */
async function closePrograms({ programs, list = () => runningProcesses(), locate = () => null, launch = () => {}, exec = execFile,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 10000, pollMs = 500 }) {
  const mine = (procs, p) => (procs || []).filter((x) => (p.exes || []).some((e) => e.toLowerCase() === String(x.image).toLowerCase()));
  const first = await list();
  if (!first) return { closed: [], stillOpen: [], message: 'Couldn\'t see which programs are open. Close them yourself, then press Check again.' };
  const targets = programs.filter((p) => mine(first, p).length);
  for (const p of targets) {
    const exe = p.quitArg ? locate(p) : null;
    if (exe) { try { launch(exe, ['--quit']); continue; } catch { /* fall back to a normal close */ } }
    for (const x of mine(first, p)) {
      // a normal close, like clicking the window's X: never /F (it could be part-way through saving)
      await new Promise((r) => { try { exec('taskkill', ['/PID', String(x.pid)], { windowsHide: true }, () => r()); } catch { r(); } });
    }
  }
  let left = targets;
  for (let t = 0; left.length && t < timeoutMs; t += pollMs) {
    await wait(pollMs);
    const now = await list();
    if (now) left = targets.filter((p) => mine(now, p).length);
  }
  const name = (p) => p.full || p.name;
  return { closed: targets.filter((p) => !left.includes(p)).map(name), stillOpen: left.map(name), message: left.map((p) => cantClose(name(p))).join(' ') };
}

// ---------- putting it away ----------
const writeJson = (file, data) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file); };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * Put away every Riyeser folder except Central's own, then leave the marker that finishes Central's on its next start.
 * All or nothing: if a folder can't be renamed (a program has it open), the ones already moved are put back.
 * Returns { ok, moved: [{id,name,from,to}], central: {from,to}|null, log } or { ok:false, failed:{id,name,dir,error}, rolledBack, notRolledBack }.
 */
function putAway({ appData, env = process.env, home = os.homedir(), centralDir, keepSignIn = false, now = new Date(), rename = fs.renameSync, version = '' }) {
  const list = plan({ appData, env, home, centralDir });
  const when = stamp(now); const taken = new Set();
  const steps = list.map((f) => { const to = awayName(f.dir, LABEL, when, taken); taken.add(to.toLowerCase()); return { ...f, from: f.dir, to }; });
  const now_ = steps.filter((s) => !s.central); const central = steps.find((s) => s.central) || null;
  const moved = [];
  for (const s of now_) {
    try { rename(s.from, s.to); moved.push(s); } catch (e) {
      const back = rollBack(moved, rename);
      return { ok: false, failed: { id: s.id, name: s.name, dir: s.from, error: e.code || e.message }, ...back };
    }
  }
  // The licence marker (first-run date of the free trial, signed-licence.js) carries over, so a fresh start doesn't
  // give a new 90-day trial. It's a copy: the one put away stays with everything else.
  const shared = moved.find((s) => s.id === 'shared');
  if (shared) {
    try {
      const m = path.join(shared.to, '.riyeser-licence.json');
      if (fs.existsSync(m)) { fs.mkdirSync(shared.from, { recursive: true }); fs.copyFileSync(m, path.join(shared.from, '.riyeser-licence.json')); }
    } catch { /* the trial date is also kept by each program's own marker */ }
  }
  const items = [...moved.map(({ id, name, from, to }) => ({ id, name, from, to, status: 'moved' })),
    ...(central ? [{ id: central.id, name: central.name, from: central.from, to: central.to, status: 'moves when Riyeser Central restarts' }] : [])];
  const log = { kind: 'riyeser-fresh-start', at: now.toISOString(), stamp: when, keptSignIn: !!keepSignIn, version, items };
  const logFile = moved.length ? path.join(moved[0].to, LOG) : (central ? path.join(central.to, LOG) : null);
  if (moved.length) writeJson(logFile, log);
  if (central) writeJson(path.join(central.from, MARKER), { action: 'put-away', to: central.to, keepSignIn: !!keepSignIn, log: logFile, logData: log });
  return { ok: true, moved: items.filter((i) => i.status === 'moved'), central: central ? { from: central.from, to: central.to } : null, log: logFile };
}
function rollBack(moved, rename) {
  const rolledBack = []; const notRolledBack = [];
  for (const s of [...moved].reverse()) { try { rename(s.to, s.from); rolledBack.push(s.name); } catch (e) { notRolledBack.push({ name: s.name, from: s.from, to: s.to, error: e.code || e.message }); } }
  return { rolledBack, notRolledBack };
}
/** Plain words for a failed fresh start. */
function failMessage(r) {
  if (!r || r.ok) return '';
  const lead = `Nothing was put away: ${r.failed.name} is still in use (${r.failed.dir}). Close it, or restart the PC, and try again.`;
  if (!r.notRolledBack || !r.notRolledBack.length) return lead;
  return `${r.failed.name} is still in use (${r.failed.dir}), and these couldn't be put back yet: ${r.notRolledBack.map((n) => `${n.to} → ${n.from}`).join('; ')}. Nothing was deleted.`;
}

const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };
function retry(fn, tries, wait) { for (let i = 1; ; i++) { try { return fn(); } catch (e) { if (i >= tries) throw e; wait(); } } }

/**
 * Central's next start, before anything is loaded: finish a fresh start (or a bring-back) left in fresh-start.json.
 * Returns what was done, or null when there was nothing to do.
 */
function finishOnStart({ dir, rename = fs.renameSync, tries = 40, wait = () => sleep(250), now = new Date() }) {
  const markerFile = path.join(dir, MARKER);
  const m = readJson(markerFile);
  if (!m) return null;
  if (m.action === 'bring-back') return finishBringBack({ dir, m, rename, tries, wait, now });
  const to = fs.existsSync(m.to) ? awayName(dir, LABEL, stamp(now)) : m.to;
  let whole = true;
  try { retry(() => rename(dir, to), tries, wait); } catch {
    // Still held open: put away just its settings (the "data" store, which nothing has open yet).
    whole = false;
    fs.mkdirSync(to, { recursive: true });
    if (isDir(path.join(dir, 'data'))) rename(path.join(dir, 'data'), path.join(to, 'data'));
    try { rename(markerFile, path.join(to, MARKER)); } catch { /* moved below */ }
  }
  // The marker stays with the put-away folder, renamed so it never runs again (even after bringing the folder back).
  const oldMarker = path.join(to, MARKER);
  if (fs.existsSync(oldMarker)) rename(oldMarker, path.join(to, 'fresh-start-done.json'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  if (m.keepSignIn) {
    const o = readJson(path.join(to, 'data', 'online.json'));
    if (o && o.session) writeJson(path.join(dir, 'data', 'online.json'), { session: o.session });
    writeJson(path.join(dir, 'data', 'checklist.json'), { hidden: false });   // a fresh checklist, whatever the account says
  }
  const logFile = m.log || path.join(to, LOG);
  const log = readJson(logFile) || m.logData || { kind: 'riyeser-fresh-start', items: [] };
  for (const it of log.items || []) if (it.id === 'central') Object.assign(it, { to, status: whole ? 'moved' : 'settings moved (the rest was still open)' });
  try { writeJson(logFile, log); } catch { /* the folders are still moved */ }
  return { action: 'put-away', from: dir, to, whole, keptSignIn: !!m.keepSignIn };
}

// ---------- bringing a fresh start back ----------
/** Earlier fresh starts on this PC, newest first, from the logs in the put-away folders. */
function sets({ appData, env = process.env, home = os.homedir() }) {
  const roots = [...new Set([appData, path.dirname(accountingHome(env, home))].map((r) => path.resolve(r)))];
  const found = new Map();
  for (const root of roots) {
    let names = []; try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (!n.includes(`(${LABEL} `)) continue;
      const log = readJson(path.join(root, n, LOG));
      if (!log || log.kind !== 'riyeser-fresh-start' || found.has(log.at)) continue;
      found.set(log.at, { id: log.at, at: log.at, stamp: log.stamp, log: path.join(root, n, LOG),
        items: (log.items || []).filter((i) => isDir(i.to)) });
    }
  }
  return [...found.values()].filter((s) => s.items.length).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * Bring a fresh start back. Folders there now are renamed "(before bringing back <stamp>)" first; Central's own
 * folder is swapped on its next start. All or nothing, like putting away.
 */
function bringBack({ set, centralDir, now = new Date(), rename = fs.renameSync }) {
  const when = stamp(now); const done = [];
  const items = set.items.filter((i) => !(centralDir && same(i.from, centralDir)));
  const central = set.items.find((i) => centralDir && same(i.from, centralDir)) || null;
  const undo = () => { const left = []; for (const d of [...done].reverse()) { try { rename(d.now, d.was); } catch (e) { left.push({ from: d.now, to: d.was, error: e.code || e.message }); } } return left; };
  for (const it of items) {
    if (fs.existsSync(it.from)) {
      const aside = awayName(it.from, BACK_LABEL, when);
      try { rename(it.from, aside); done.push({ now: aside, was: it.from }); } catch (e) { const left = undo(); return { ok: false, failed: { name: it.name, dir: it.from, error: e.code || e.message }, notRolledBack: left }; }
    }
    try { rename(it.to, it.from); done.push({ now: it.from, was: it.to }); } catch (e) { const left = undo(); return { ok: false, failed: { name: it.name, dir: it.to, error: e.code || e.message }, notRolledBack: left }; }
  }
  // The log came back with its folder: renamed so this set isn't offered again (never deleted).
  const logNow = items.reduce((f, it) => (f && f.startsWith(it.to + path.sep) ? path.join(it.from, f.slice(it.to.length + 1)) : f), set.log);
  if (central) writeJson(path.join(central.from, MARKER), { action: 'bring-back', from: central.to, log: logNow });
  else retireLog(logNow, when, rename);
  return { ok: true, brought: items.map((i) => ({ name: i.name, to: i.from })), central: central ? { from: central.to, to: central.from } : null };
}
function retireLog(file, when, rename) {
  if (!file || !fs.existsSync(file)) return;
  try { rename(file, path.join(path.dirname(file), `fresh-start-log (brought back ${when}).json`)); } catch { /* it's only the list */ }
}
function finishBringBack({ dir, m, rename, tries, wait, now }) {
  const when = stamp(now);
  if (!isDir(m.from)) { const done = path.join(dir, 'fresh-start-done.json'); try { rename(path.join(dir, MARKER), done); } catch { /* */ } return { action: 'bring-back', ok: false, error: 'missing' }; }
  const aside = awayName(dir, BACK_LABEL, when);
  try { retry(() => rename(dir, aside), tries, wait); } catch (e) { return { action: 'bring-back', ok: false, error: e.code || e.message }; }
  try { rename(m.from, dir); } catch (e) { try { rename(aside, dir); } catch { /* */ } return { action: 'bring-back', ok: false, error: e.code || e.message }; }
  try { rename(path.join(aside, MARKER), path.join(aside, 'fresh-start-done.json')); } catch { /* */ }
  const logNow = m.log && m.log.startsWith(m.from + path.sep) ? path.join(dir, m.log.slice(m.from.length + 1)) : m.log;
  retireLog(logNow, when, rename);
  return { action: 'bring-back', ok: true, from: m.from, to: dir, aside };
}

module.exports = { LABEL, LOG, MARKER, CONFIRM, folders, plan, stamp, awayName, openPrograms, runningImages, runningProcesses, closePrograms, cantClose, closeFirst,
  putAway, failMessage, finishOnStart, sets, bringBack };
