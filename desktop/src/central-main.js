// Riyeser Central: the Riyeser Group home screen. Opens every Riyeser program and shows, like a PA would, what needs
// attention today: meetings, to-dos, money owed and owing, and recent documents, plus one search for every file.
// It only READS the other programs' data, so it can never damage their files.
const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, net, session, clipboard } = require('electron');
const { execFile, spawn } = require('child_process');
const updates = require('./central/updates');
const installerCheck = require('./central/installer-check');
const installRun = require('./central/install-run');
const licence = require('./core/licence');
const trialGuard = require('./core/trial-guard');
const prices = require('./core/prices');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Store } = require('./core/store');
const { Index } = require('./core/indexer');
const { upcomingMeetings } = require('./core/calendar');
const sources = require('./central/sources');
const online = require('./core/online');
const demo = require('./central/demo');
const demoUi = require('./renderer/demo-ui');
const checklist = require('./central/checklist');
const freshstart = require('./central/freshstart');
const diagnostics = require('./central/diagnostics');
const programReports = require('./central/program-reports');
const usageCounts = require('./central/usage-counts');
const firstRun = require('./central/first-run');
const { LocalApp } = require('./central/local-app');
const { createSync } = require('./central/online-sync');
const { AdminLock } = require('./central/admin');
const { memoryStore } = require('./link/relaychecks');
const crypto = require('crypto');

app.setName('Riyeser Central');
// Central's data folder. Versions before 1.2 used "Riyser Central": move it across once so nothing is lost.
{
  const dataNew = path.join(app.getPath('appData'), 'Riyeser Central');
  const dataOld = path.join(app.getPath('appData'), 'Riyser Central');
  // A fresh start (Settings) left for this start: put Central's own folder away before anything opens it.
  try { freshstart.finishOnStart({ dir: dataNew }); } catch { /* tried again next start */ }
  try { if (!fs.existsSync(dataNew) && fs.existsSync(dataOld)) fs.renameSync(dataOld, dataNew); } catch { /* keep going with a fresh folder */ }
  app.setPath('userData', dataNew);
}
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null; let store = null;
let localApp = null; let onlineSync = null;   // online connections (set up in registerIpc)
// A new online booking or order: a Windows notification; clicking it brings Central forward.
function showOnlineNotification(n) {
  try {
    if (store && (store.get('prefs', {}) || {}).notify === false) return;   // Settings → Notifications: off
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body || '' });
    note.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); send('online-sync:open', n); } });
    note.show();
  } catch { /* a notification is a nice extra */ }
}
const deskData = () => path.join(app.getPath('appData'), 'Desk Assistant', 'data');
const localPrograms = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs');

// ---------- the programs ----------
const PROGRAMS = [
  // Free invoicing on its own (free forever). Opens the same company files as Accounting and installs next to it.
  // Riyeser Link (formerly Riyeser Team) as its own desktop app (chat and calls, a paid program). When it's installed,
  // the Link button opens it. Its folder and program file kept the old names (riyeser-team, Riyeser Team.exe) so it
  // updates in place; the Start menu and desktop shortcuts are called Riyeser Link now (Riyeser Team before 1.1).
  { id: 'team', name: 'Link', full: 'Riyeser Link', icon: '💬', desc: 'Chat, calls and desk phones for your business. Free for 90 days.',
    dirs: ['riyeser-team', 'Riyeser Team'], exes: ['Riyeser Team.exe'], links: ['Riyeser Link', 'Riyeser Team'], quitArg: true },   // quitArg: --quit closes it (Fresh start)
  // Riyeser Link Office: the office phone system, with Riyeser Link. Installs for the whole PC (Program Files).
  { id: 'linkoffice', name: 'Link Office', full: 'Riyeser Link Office', icon: '☎', desc: 'Your business\'s phone lines: the office phone system, with desk phones, extensions and ring groups. Comes with Riyeser Link.',
    dirs: ['Riyeser Link Office', 'riyeser-linkoffice'], exes: ['Riyeser Link Office.exe'], links: ['Riyeser Link Office'], machine: true, quitArg: true },
  { id: 'invoices', name: 'Invoices', full: 'Riyeser Invoices', icon: '🧾', desc: 'Quotes, invoices, customers and getting paid. Free forever.',
    dirs: ['Riyeser Invoices'], exes: ['Riyeser Invoices.exe'], links: ['Riyeser Invoices'], pages: ['invoice'] },
  // Bookings and scheduling (jobs, appointments, tables). Same company files as Accounting; installs next to it.
  { id: 'bookings', name: 'Bookings', full: 'Riyeser Bookings', icon: '📅', desc: 'Jobs, appointments and table bookings on one calendar. Free for 90 days.',
    dirs: ['Riyeser Bookings'], exes: ['Riyeser Bookings.exe'], links: ['Riyeser Bookings'] },
  // Riyeser Estimate: measure jobs (plan, photo, map) and quote them. Same company files as Accounting; installs next to it.
  { id: 'estimate', name: 'Estimate', full: 'Riyeser Estimate', icon: '📐', desc: `Measure jobs on a plan, a photo or the map, and turn them into quotes. Free for 90 days, then ${prices.usd(prices.PRICE.estimate)} a month.`,
    dirs: ['Riyeser Estimate'], exes: ['Riyeser Estimate.exe'], links: ['Riyeser Estimate'], pages: ['estimate'] },
  // Two separate apps that share the same books. The old single "Riyeser Accounting" 1.x counts as Plus.
  { id: 'accounting-basics', name: 'Accounting Basics', full: 'Riyeser Accounting Basics', icon: '📗', desc: 'Invoicing, quotes, customers and stock. Free for 90 days.',
    dirs: ['Riyeser Accounting Basics'], exes: ['Riyeser Accounting Basics.exe'], links: ['Riyeser Accounting Basics'], pages: ['invoice'] },
  { id: 'accounting', name: 'Accounting Plus', full: 'Riyeser Accounting Plus', icon: '📒', desc: 'Full books: banking, payroll, journals, jobs and budgets. Free for 90 days.',
    dirs: ['Riyeser Accounting Plus', 'Riyeser Accounting'], exes: ['Riyeser Accounting Plus.exe', 'Riyeser Accounting.exe'], links: ['Riyeser Accounting Plus', 'Riyeser Accounting'], pages: ['invoice'] },
  // The till on its own. It opens the same company files as Accounting and installs next to it.
  { id: 'pos', name: 'POS', full: 'Riyeser POS', icon: '🧾', desc: 'The till for shops, cafes and restaurants. Free for 90 days.',
    dirs: ['Riyeser POS'], exes: ['Riyeser POS.exe'], links: ['Riyeser POS'], pages: ['pos'] },
  { id: 'payroll', name: 'Payroll', full: 'Riyeser Payroll', icon: '🕒', desc: 'Time clock, timesheets, pay runs, payslips and leave.',
    dirs: ['riyeser-payroll', 'Riyeser Payroll', 'riyeser', 'Riyeser', 'riyser', 'Riyser'], exes: ['Riyeser Payroll.exe', 'Riyeser.exe', 'Riyser.exe'],
    links: ['Riyeser Payroll', 'Riyeser', 'Riyser'], // Riyeser Payroll 2.0+; older builds were a hub called Riyser
    portable: /^RiyeserPayroll-Portable(?:-\d+(?:\.\d+){1,3})?\.exe$/i }, // the portable copy (no installer), on the desktop or in Downloads
  // Riyeser Documents was Riyeser Desk Assistant (same app id, install folder and program file): found under either name.
  { id: 'desk', name: 'Documents', full: 'Riyeser Documents', icon: '🗂', desc: 'Scan, file and find the office\'s documents.',
    dirs: ['desk-assistant'], exes: ['Riyeser Documents.exe', 'Riyeser Desk Assistant.exe', 'Desk Assistant.exe'], links: ['Riyeser Documents', 'Riyeser Desk Assistant', 'Desk Assistant'] },
  { id: 'pdf', name: 'PDF', full: 'Riyeser PDF', icon: '📕', desc: 'Open, fill in, sign, combine and edit PDFs.',
    dirs: ['desk-pdf'], exes: ['Riyeser PDF.exe', 'Desk PDF.exe'], links: ['Riyeser PDF', 'Desk PDF'] },
  { id: 'services', name: 'As Built', full: 'As Built', icon: '🏗', desc: 'Building services on your drawings, with photos, tests and QA.',
    dirs: ['riyeser-services'], exes: ['Riyeser Services.exe', 'As Built.exe'], links: ['As Built', 'Riyeser Services'], // was Riyeser Services
    url: 'https://riyeser.com/app/' }, // opens the Windows app when it's installed, else the website
];

/** Start a program with arguments, separate from Central (it keeps running if Central closes). */
// In demo mode the program is also told so in its environment (RIYESER_DEMO=1); it reads demo.json itself as well.
const demoOn = () => { try { return demo.isOn(app.getPath('appData')); } catch { return false; } };
function launchEnv() {
  const env = { ...process.env }; delete env.RIYESER_DEMO;
  if (demoOn()) env.RIYESER_DEMO = '1';
  return env;
}
function launch(exe, args) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exe), env: launchEnv() });
  child.on('error', () => { /* reported by the program itself */ });
  child.unref();
}

function shortcutDirs() {
  const appData = process.env.APPDATA || app.getPath('appData');
  const dirs = [app.getPath('desktop'), path.join(os.homedir(), 'Desktop'), process.env.PUBLIC && path.join(process.env.PUBLIC, 'Desktop'),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Riyeser Group'),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Riyeser Group')];
  return [...new Set(dirs.filter(Boolean))];
}
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Where a program is installed: a place you picked, the usual install folder, or a desktop / Start menu shortcut. */
function locate(p) {
  const saved = (store.get('locations', {}) || {})[p.id];
  if (saved && exists(saved)) return saved;
  const roots = [localPrograms(), ...(p.machine ? [process.env.ProgramW6432, process.env.ProgramFiles].filter(Boolean) : [])];
  for (const root of roots) for (const d of p.dirs || []) for (const e of p.exes || []) { const f = path.join(root, d, e); if (exists(f)) return f; }
  if (process.platform === 'win32') {
    for (const dir of shortcutDirs()) for (const l of p.links || []) {
      const lnk = path.join(dir, `${l}.lnk`);
      if (!exists(lnk)) continue;
      try { const t = shell.readShortcutLink(lnk).target; if (t && exists(t)) return t; } catch { /* broken shortcut */ }
    }
  }
  if (p.portable) {
    const f = updates.findPortable([app.getPath('desktop'), app.getPath('downloads')], p.portable, (d) => fs.readdirSync(d));
    if (f && exists(f)) return f;
  }
  return null;
}
const programList = () => PROGRAMS.map((p) => {
  const exe = locate(p);
  // Not installed: listed under "More Riyeser apps" (As Built can still be opened online from there).
  if (p.url && !exe) return { id: p.id, name: p.name, full: p.full, icon: p.icon, desc: p.desc, status: 'missing', online: p.url, where: p.url.replace(/^https?:\/\//, '') };
  return { id: p.id, name: p.name, full: p.full, icon: p.icon, desc: p.desc, status: exe ? 'installed' : 'missing', where: exe };
});

// ---------- search (Desk Assistant's index, read-only) ----------
let idx = null; let idxStamp = 0;
function searchIndex() {
  const file = sources.deskAssistant(deskData()).indexFile;
  let stamp = 0; try { stamp = fs.statSync(file).mtimeMs; } catch { /* no index yet */ }
  if (!idx || stamp !== idxStamp) {
    idx = new Index({ get: () => sources.readJson(file, {}), set: () => {} }); // never saved: Central only reads
    idxStamp = stamp;
  }
  return idx;
}

// ---------- updates ----------
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
// A program file's own version (Windows' file details), for a copy that isn't in the installed-apps list. Kept per file.
const fileVersions = new Map();
function fileVersion(exe) {
  const inName = updates.versionInFileName(exe);
  if (inName || process.platform !== 'win32') return Promise.resolve(inName);
  let stamp = 0; try { stamp = fs.statSync(exe).mtimeMs; } catch { return Promise.resolve(null); }
  const k = `${exe}|${stamp}`;
  if (fileVersions.has(k)) return Promise.resolve(fileVersions.get(k));
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $args[0]).VersionInfo.ProductVersion', exe],
    { windowsHide: true, timeout: 15000 }, (err, out) => {
      const v = (String(out || '').match(/\d+(?:\.\d+){1,3}/) || [])[0] || null;
      if (!err) fileVersions.set(k, v);
      resolve(v);
    }));
}
function installedVersions() {
  if (process.platform !== 'win32') return Promise.resolve(app.isPackaged ? { central: app.getVersion() } : {});
  const q = (key) => new Promise((resolve) => execFile('reg', ['query', key, '/s', '/reg:64'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(out || '')));
  // Most programs install for this Windows user (HKCU); Riyeser Link Office installs for the whole PC (HKLM).
  return Promise.all([q('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'), q('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')])
    .then(async ([user, machine]) => {
      const v = { ...updates.installedFromRegistry(machine), ...updates.installedFromRegistry(user) };
      // Not in Windows' list (a portable copy, a copy picked with Locate…, an entry the installer didn't write): the
      // same search the home screen's tiles use, so a program Central shows as installed is also reported as installed.
      const found = {};
      if (store) {
        for (const p of PROGRAMS) {
          if (p.id in v) continue;
          const exe = locate(p);
          if (exe && /\.exe$/i.test(exe)) found[p.id] = { exe, version: await fileVersion(exe).catch(() => null) };
        }
      }
      const out = updates.withFoundPrograms(v, found);
      if (app.isPackaged) out.central = app.getVersion();
      return out;
    });
}
// The programs on this PC go to Riyeser soon after they change (not only at the daily check-in): see program-reports.js.
let reportProgramsNow = async () => null;   // set up in registerIpc once the online helper exists
// Anonymous usage counts (central/usage-counts.js; Settings → "Send anonymous usage counts"): new install, adds, updates.
let usage = null; let usageFirst = 'new';
const usageTick = () => (usage ? installedVersions().then((v) => usage.tick(v)).catch(() => null) : Promise.resolve(null));
const programsReporter = programReports.createReporter({ report: () => reportProgramsNow() });
// Admin panel → Updates → channel: 'stable' (the latest release) or 'early' (pre-releases too).
const updateChannel = () => { const c = (store && store.get('prefs', {}) || {}).channel; return updates.CHANNELS.includes(c) ? c : 'stable'; };
async function checkUpdates(force) {
  const cached = store.get('updateCheck', null);
  const channel = updateChannel();
  if (!force && cached && (cached.channel || 'stable') === channel && Date.now() - cached.at < 6 * 3600 * 1000) return { ...cached.result, installed: await installedVersions(), cached: true };
  const res = await net.fetch(channel === 'early' ? updates.RELEASES_API : updates.RELEASE_API, { headers: { 'User-Agent': 'Riyeser-Central', Accept: 'application/vnd.github+json' } });
  if (res.status === 404) return { latest: null, updates: [], note: 'No release published yet.' };
  if (!res.ok) throw new Error(`Couldn't check for updates (${res.status}). Try again later.`);
  const release = channel === 'early' ? updates.pickRelease(await res.json(), 'early') : await res.json();
  if (!release) return { latest: null, updates: [], note: 'No release published yet.' };
  let versionsJson = null;
  const vj = (release.assets || []).find((a) => a.name === 'versions.json');
  if (vj) { try { versionsJson = await (await net.fetch(vj.browser_download_url, { headers: { 'User-Agent': 'Riyeser-Central' } })).json(); } catch { /* use the release notes */ } }
  const latest = updates.latestFromRelease(release, versionsJson);
  // S58: the release's signed list of installer hashes (checked before any installer runs)
  latest.manifest = null;
  if (latest.manifestUrl) { try { latest.manifest = await (await net.fetch(latest.manifestUrl, { headers: { 'User-Agent': 'Riyeser-Central' } })).json(); } catch { /* checked (and refused if needed) at install */ } }
  store.set('updateCheck', { at: Date.now(), channel, result: { latest } });
  return { latest, installed: await installedVersions() };
}
async function updateStatus(force) {
  const r = await checkUpdates(force);
  if (!r.latest) return { checkedAt: Date.now(), updates: [], note: r.note };
  return { checkedAt: Date.now(), release: r.latest.name, updates: updates.availableUpdates(r.installed || {}, r.latest) };
}
async function download(url, file, onProgress) {
  if (!updates.ALLOWED_DOWNLOAD.test(url)) throw new Error('Refusing to download from an unexpected address.');
  const res = await net.fetch(url, { headers: { 'User-Agent': 'Riyeser-Central' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
  const total = +res.headers.get('content-length') || 0; let got = 0;
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; out.write(Buffer.from(value)); onProgress(total ? got / total : 0); }
  await new Promise((r) => out.end(r));
  if (total && fs.statSync(file).size !== total) throw new Error('The download was incomplete. Please try again.');
}
/** S58: refuse to run an installer that isn't the one Riyeser published (installer-check.js has the rule). */
async function verifyDownload(file, name, digest, latest) {
  const r = await installerCheck.checkInstaller({ file, name, manifest: latest && latest.manifest, digest });
  if (!r.ok) { try { fs.rmSync(file, { force: true }); } catch { /* temp file */ } throw new Error(r.error); }
  return r;
}
// Central's install log (%APPDATA%\Riyeser Central\logs\install.log): one line per step that matters, sent with
// "Report an issue" (diagnostics.js) so Riyeser Support sees the codes. Kept to the last ~200 KB.
function installLog(entry) {
  try {
    const file = path.join(app.getPath('userData'), 'logs', 'install.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > 400 * 1024) { const t = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, t.slice(-200 * 1024).replace(/^[^\n]*\n/, '')); } } catch { /* new log */ }
    fs.appendFileSync(file, `${installRun.logEntry({ ...entry, at: Date.now() })}\n`);
  } catch { /* the log is a nice extra */ }
}
/** An install that didn't work: an Error carrying the plain message, the fix and the reason for the tile. */
function installError(f) { const e = new Error(f.fix ? `${f.message} ${f.fix}` : f.message); e.failure = f; return e; }
/**
 * Run a downloaded installer quietly and wait for it (install-run.js): programs that install for the whole PC go
 * through the Windows permission prompt. Throws an installError with a plain message when it didn't work.
 */
async function runInstaller(file, args, name, { id, version, elevate = false } = {}) {
  const r = await installRun.runInstaller({ file, args, elevate, spawn });
  const f = installRun.installFailure(r, { name, args });
  installLog({ id, version, file: path.basename(file), stage: f.ok ? 'ran' : 'failed', elevated: r.elevated, retried: r.retried, firstError: r.firstError,
    code: r.code, startError: r.startError, reason: f.reason, ms: r.ms, detail: r.detail });
  if (!f.ok) throw installError(f);
  return r;
}
/** After the installer: is the program really on this PC? Looks a few times (the last registry writes can lag). */
async function findAfterInstall(id) {
  const p = PROGRAMS.find((x) => x.id === id);
  for (let i = 0; i < 8; i++) {
    if (p && locate(p)) return true;
    const v = await installedVersions().catch(() => ({}));
    if (id in v) return true;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return false;
}

/**
 * Install a program that isn't on this PC yet, straight from the latest Riyeser release (no trip to the website).
 * Tells the home screen each step (install-progress: downloading, checking, installing, verifying, installed, failed)
 * and never just stops: a failure says what happened and how to fix it.
 */
async function installProgram(id) {
  const product = updates.PRODUCTS.find((x) => x.id === id && !x.self);
  if (!product) throw new Error('Unknown program');
  const progress = (x) => send('install-progress', { id, ...x });
  let item = null; let dir = null;
  try {
    if (process.platform !== 'win32') throw installError({ reason: 'failed', message: 'Programs install on Windows only.' });
    progress({ stage: 'downloading', pct: 0 });
    let r = await checkUpdates(false);
    if (!r.latest || !r.latest.products[id]) r = await checkUpdates(true); // a newer release may have added it
    item = r.latest && r.latest.products[id];
    if (!item) throw installError({ reason: 'not-in-release', message: `${product.display} isn't in the latest release yet.`, fix: 'Use “Download page” instead.' });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-install-'));
    const file = path.join(dir, path.basename(new URL(item.url).pathname));
    installLog({ id, version: item.version, file: path.basename(file), stage: 'downloading', elevated: !!product.elevate });
    try { await download(item.url, file, (pct) => progress({ stage: 'downloading', pct })); } catch (e) {
      throw installError({ reason: 'download', message: `Couldn't download ${product.display}: ${e.message}`, fix: 'Check the internet connection and try again.' });
    }
    progress({ stage: 'checking' });
    let how = null;
    try { how = (await verifyDownload(file, item.name || path.basename(file), item.digest, r.latest)).how; } catch (e) {
      // ENOENT/EPERM here: the antivirus took the file away (or locked it) as soon as it was saved
      if (/ENOENT|EPERM|EBUSY/.test(String(e.code || e.message))) throw installError(installRun.installFailure({ startError: 'missing' }, { name: product.display }));
      throw installError({ reason: 'check', message: e.message });
    }
    installLog({ id, version: item.version, stage: 'checked', how });
    progress({ stage: 'installing', elevate: !!product.elevate });
    await runInstaller(file, product.args, product.display, { id, version: item.version, elevate: !!product.elevate });
    progress({ stage: 'verifying' });
    const found = await findAfterInstall(id);
    installLog({ id, version: item.version, stage: found ? 'installed' : 'failed', reason: found ? 'installed' : 'not-found', detected: found });
    if (!found) throw installError(installRun.notFoundAfterInstall(product.display));
    progress({ stage: 'installed', version: item.version });
    programsReporter.soon();   // tell Riyeser it's installed now
    return { id, version: item.version };
  } catch (e) {
    const f = e.failure || { reason: 'failed', message: e.message, fix: 'Try again. If it happens again, click Get help.' };
    if (!e.failure) installLog({ id, version: item && item.version, stage: 'failed', reason: 'failed', detail: e.message });
    progress({ stage: 'failed', reason: f.reason, message: f.message, fix: f.fix || '', code: f.code ?? null });
    throw e;
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ } }
  }
}

async function installUpdates(ids) {
  const st = await updateStatus(false);
  const latest = (await checkUpdates(false)).latest;   // the cached release, with its signed list
  const todo = st.updates.filter((u) => !ids || ids.includes(u.id)).sort((a, b) => a.self - b.self); // Central last
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyser-update-'));
  const done = [];
  for (const u of todo) {
    const file = path.join(dir, path.basename(new URL(u.url).pathname));
    send('update-progress', { id: u.id, name: u.name, stage: 'downloading', pct: 0 });
    await download(u.url, file, (pct) => send('update-progress', { id: u.id, name: u.name, stage: 'downloading', pct }));
    await verifyDownload(file, u.file || path.basename(file), u.digest, latest);
    if (process.platform !== 'win32') throw new Error('Updates install on Windows only.');
    if (u.self) {
      // Central updates itself: close, install quietly, then open again.
      send('update-progress', { id: u.id, name: u.name, stage: 'restarting', pct: 1 });
      const cmd = `timeout /t 2 /nobreak >nul & "${file}" /S & start "" "${process.execPath}"`;
      spawn('cmd.exe', ['/d', '/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
      setTimeout(() => app.quit(), 300);
      done.push(u.id);
      return { done, restarting: true };
    }
    send('update-progress', { id: u.id, name: u.name, stage: 'installing', pct: 1, elevate: !!u.elevate });
    await runInstaller(file, u.args, u.name, { id: u.id, version: u.to, elevate: !!u.elevate });
    done.push(u.id);
    programsReporter.soon();   // the new version, soon after it's installed
  }
  store.set('updateCheck', null);
  return { done, restarting: false };
}

// ---------- first run, "One installer": the plan's programs, one after another (first-run.js has the rules) ----------
const offlineError = () => Object.assign(new Error(firstRun.OFFLINE.message), { offline: true, failure: { ...firstRun.OFFLINE } });
/** The first-run install driver: the same download, check and quiet install as the Install button. */
const firstRunDriver = {
  isOnline: () => { try { return net.isOnline(); } catch { return true; } },
  async fetch(it, onPct, onChecking) {
    if (process.platform !== 'win32') throw installError({ reason: 'failed', message: 'Programs install on Windows only.' });
    if (!firstRunDriver.isOnline()) throw offlineError();
    let r = await checkUpdates(false);
    if (!r.latest || !r.latest.products[it.id]) r = await checkUpdates(true);
    const item = r.latest && r.latest.products[it.id];
    if (!item) throw installError({ reason: 'not-in-release', message: `${it.name} isn't in the latest release yet.`, fix: 'Untick it with Choose programs instead, or try again later.' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-firstrun-'));
    const file = path.join(dir, path.basename(new URL(item.url).pathname));
    installLog({ id: it.id, version: item.version, file: path.basename(file), stage: 'downloading', elevated: !!it.elevate, how: 'first-run' });
    try { await download(item.url, file, onPct); } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (firstRun.isOffline(e) || !firstRunDriver.isOnline()) throw offlineError();
      throw installError({ reason: 'download', message: `Couldn't download ${it.name}: ${e.message}`, fix: 'Check the internet connection and click Try again.' });
    }
    onChecking();
    try { await verifyDownload(file, item.name || path.basename(file), item.digest, r.latest); } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (/ENOENT|EPERM|EBUSY/.test(String(e.code || e.message))) throw installError(installRun.installFailure({ startError: 'missing' }, { name: it.name }));
      throw installError({ reason: 'check', message: e.message });
    }
    return { file, dir, version: item.version };
  },
  async install(it, got) {
    const product = updates.PRODUCTS.find((x) => x.id === it.id);
    await runInstaller(got.file, product.args, it.name, { id: it.id, version: got.version, elevate: false });
  },
  // Every whole-PC installer together: one Windows permission prompt (install-run.js runElevatedBatch).
  async installBatch(list) {
    const items = list.map(({ item, got }) => ({ id: item.id, file: got.file, args: updates.PRODUCTS.find((x) => x.id === item.id).args }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-firstrun-batch-'));
    try {
      const { results } = await installRun.runElevatedBatch({ items, spawn, dir });
      const out = {};
      for (const { item, got } of list) {
        const r = results[item.id]; const args = updates.PRODUCTS.find((x) => x.id === item.id).args;
        const f = installRun.installFailure(r, { name: item.name, args });
        installLog({ id: item.id, version: got.version, file: path.basename(got.file), stage: f.ok ? 'ran' : 'failed', elevated: true, code: r.code, startError: r.startError, reason: f.reason, detail: r.detail, how: `first-run batch of ${list.length}` });
        out[item.id] = f.ok ? null : f;
      }
      return out;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
  verify: (it) => findAfterInstall(it.id),
  cleanup: (got) => { if (got && got.dir) fs.rmSync(got.dir, { recursive: true, force: true }); },
};
let firstRunBusy = null;
const firstRunState = () => store.get('first-run', null);
let firstRunSaved = '';
/** Saved when a program's step changes (not on every percent of a download); the window hears every change. */
function saveFirstRun(run) {
  const sig = (run.items || []).map((i) => `${i.id}:${i.stage}`).join(',') + run.step + run.finished;
  if (sig !== firstRunSaved) { store.set('first-run', run); firstRunSaved = sig; }
  send('firstrun-progress', { run, summary: firstRun.summary(run) });
}
/** Install what's left in the saved run (in the background; the window follows firstrun-progress). */
function runFirstRun() {
  if (firstRunBusy) return firstRunBusy;
  const run = firstRunState();
  if (!run || !run.items) return Promise.resolve(null);
  firstRunBusy = firstRun.runQueue(run, firstRunDriver, { onChange: (r) => saveFirstRun(r) })
    .then((s) => { if (s.installed.length) programsReporter.soon(); return s; })
    .finally(() => { firstRunBusy = null; });
  return firstRunBusy;
}

// ---------- IPC ----------
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: e.message }; }
  });
}
let refreshOnlineLicence = async () => null;   // set up in registerIpc once the online helper exists
function registerIpc() {
  handle('app:version', () => app.getVersion());
  handle('app:platform', () => process.platform);
  // The home screen's list. When what's installed changed since last time, the new list goes to Riyeser soon after.
  handle('central:programs', () => { const list = programList(); programsReporter.seen(list); return list; });
  handle('central:open', async (id, page) => {
    const p = PROGRAMS.find((x) => x.id === id);
    if (!p) throw new Error('Unknown program');
    const exe = locate(p);
    if (onlineSync && ['bookings', 'pos', 'accounting', 'accounting-basics', 'invoices'].includes(id)) setTimeout(() => onlineSync.tick(), 10 * 1000);
    if (p.url && !exe) { await shell.openExternal(p.url); return true; }
    if (!exe) throw new Error(`${p.full} isn't installed on this computer yet (or I can't find it). Use “Locate…” to point me to it.`);
    // Quick access: programs that can open on a given screen (e.g. Accounting's Shop counter) get --page=<name>.
    if (page && (p.pages || []).includes(page) && /\.exe$/i.test(exe)) { launch(exe, [`--page=${page}`]); return true; }
    if (demoOn() && /\.exe$/i.test(exe)) { launch(exe, []); return true; }   // demo mode: started with RIYESER_DEMO=1
    const err = await shell.openPath(exe);
    if (err) throw new Error(err);
    return true;
  });
  // A program that isn't installed yet: its page on riyeser.com, with the download.
  handle('central:get', async (id) => {
    const page = { team: 'link', linkoffice: 'link-office', invoices: 'invoices', bookings: 'bookings', estimate: 'estimate', 'accounting-basics': 'accounting-basics', accounting: 'accounting', pos: 'pos', payroll: 'payroll', desk: 'desk-assistant', pdf: 'pdf', services: 'services' }[id];
    await shell.openExternal(page ? `https://riyeser.com/programs/${page}.html` : 'https://riyeser.com/downloads.html');
    return true;
  });
  // Quick access "Open a PDF": choose one and open it in Riyeser PDF.
  handle('central:openPdf', async () => {
    const exe = locate(PROGRAMS.find((x) => x.id === 'pdf'));
    if (!exe) throw new Error("Riyeser PDF isn't installed on this computer yet.");
    const r = await dialog.showOpenDialog(win, { title: 'Open a PDF', properties: ['openFile'], filters: [{ name: 'PDF files', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePaths[0]) return false;
    launch(exe, [r.filePaths[0]]);
    return true;
  });
  handle('central:locate', async (id) => {
    const p = PROGRAMS.find((x) => x.id === id);
    const r = await dialog.showOpenDialog(win, { title: `Where is ${p.full}?`, properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe', 'lnk'] }] : [] });
    if (r.canceled || !r.filePaths[0]) return null;
    let f = r.filePaths[0];
    if (/\.lnk$/i.test(f)) { try { f = shell.readShortcutLink(f).target; } catch { /* keep the link */ } }
    store.update('locations', {}, (l) => ({ ...(l || {}), [id]: f }));
    return f;
  });
  handle('central:today', async () => {
    // Each program's information is read only while that program is installed, so a fresh install (or one where a
    // program was removed) never shows old to-dos, balances or documents left behind on the PC.
    const installed = (id) => !!locate(PROGRAMS.find((x) => x.id === id));
    const deskInstalled = installed('desk'); const pdfInstalled = installed('pdf');
    // Riyeser Documents (Desk Assistant 1.0 and later) has no to-dos or calendars: don't show the ones Desk Assistant left.
    const documents = deskInstalled && fs.existsSync(path.join(deskData(), 'documents.json'));
    // Demo mode: practice figures only. Money and pay runs come from Accounting's and Payroll's demo records (so the
    // numbers match what those programs show); to-dos and meetings are made up here; real recent files aren't shown.
    const inDemo = demoOn(); const appDataDir = app.getPath('appData');
    if (inDemo) {
      const sample = demo.sampleToday();
      let money = { found: false }; let payroll = { found: false, lastRun: null };
      if (installed('accounting') || installed('accounting-basics')) { try { money = await sources.pendingPayments(demo.demoAccountingDb()); } catch (e) { money = { found: false, error: e.message }; } }
      if (installed('payroll')) { try { payroll = await sources.lastPayRun(demo.demoPayrollDb(appDataDir)); } catch (e) { payroll = { found: false, lastRun: null, error: e.message }; } }
      const tasks = deskInstalled && !documents ? sample.tasks : [];
      return { demo: true, documents, inbox: documents ? 5 : null, deskFound: deskInstalled, calendars: deskInstalled && !documents ? 1 : 0, meetings: deskInstalled && !documents ? sample.meetings : [], meetingErrors: [], tasks, taskCount: tasks.length, money, recent: [], payroll, organisedRoot: '' };
    }
    const da = deskInstalled ? sources.deskAssistant(deskData()) : { found: false, settings: {}, tasks: [] };
    const open = documents ? [] : (da.tasks || []).filter((t) => !t.done);
    const tasks = open.sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9'))).slice(0, 12);
    let meetings = []; let meetingErrors = [];
    const cals = documents ? [] : (da.settings && da.settings.calendars) || [];
    if (cals.length) {
      try {
        const r = await Promise.race([upcomingMeetings(cals, { days: 2 }), new Promise((_, rej) => setTimeout(() => rej(new Error('calendar took too long')), 12000))]);
        meetings = r.meetings.slice(0, 10); meetingErrors = r.errors.map((e) => e.source);
      } catch (e) { meetingErrors = [e.message]; }
    }
    let money = { found: false };
    if (installed('accounting') || installed('accounting-basics')) {
      try { money = await sources.pendingPayments(); } catch (e) { money = { found: false, error: e.message }; }
    }
    // Recent documents (Windows' own Recent files list) belong to Riyeser Desk Assistant: only while it's installed.
    // With only Riyeser PDF installed, recent PDFs are shown (and nothing from Desk Assistant's file list).
    let recent = !deskInstalled && !pdfInstalled ? [] : sources.recentDocuments({
      recentDir: process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Recent') : null,
      readLink: (l) => shell.readShortcutLink(l).target,
      indexDocs: deskInstalled ? searchIndex().docs : {}, limit: deskInstalled ? 24 : 40,
    });
    if (!deskInstalled) recent = recent.filter((r) => /\.pdf$/i.test(r.name));
    // The last pay run, only while Riyeser Payroll is installed (records left after uninstalling aren't shown).
    let payroll = { found: false, lastRun: null };
    if (installed('payroll')) { try { payroll = await sources.lastPayRun(sources.payrollDbPath(app.getPath('appData'))); } catch (e) { payroll = { found: false, lastRun: null, error: e.message }; } }
    const organisedRoot = deskInstalled ? ((da.settings && da.settings.organisedRoot) || '') : '';
    // Riyeser Documents: how many documents wait in its Inbox (its library folder, from its settings)
    const inbox = documents ? sources.inboxCount((sources.readJson(path.join(deskData(), 'documents.json'), {}) || {}).root || path.join(app.getPath('documents'), 'Riyeser Documents')) : null;
    return { documents, inbox, deskFound: da.found, calendars: cals.length, meetings, meetingErrors, tasks, taskCount: open.length, money, recent, payroll, organisedRoot };
  });
  // ---------- licence (one for the whole Riyeser suite; %APPDATA%\Riyeser\licence.json) ----------
  const appData = app.getPath('appData'); const lfetch = (u, o) => net.fetch(u, o);
  handle('central:licence', async () => { const s = licence.status(appData); return s.needsCheck ? licence.recheck(appData, { fetchFn: lfetch }) : s; });
  // The company's plan from Riyeser online: when Central starts, once a day, and on "Check now".
  handle('central:licenceRefresh', async () => { await refreshOnlineLicence(true); return licence.status(appData); });
  // S12: no licence keys to type any more: the plan comes from the Riyeser account (Company page sign-in)
  handle('central:licenceRemove', () => { admin.require(); return licence.remove(appData, { fetchFn: lfetch }); });
  handle('central:buy', () => shell.openExternal(licence.BUY_URL));
  handle('central:home', () => shell.openExternal(licence.HOME_URL));   // Riyeser home page: add a paid program there
  // ---------- the company this PC belongs to (%APPDATA%\Riyeser\company.json; set up or join online) ----------
  // programsFn: the Riyeser programs installed on this PC, sent to Riyeser when the PC links, at the daily check-in
  const on = new online.Online({ store, fetchFn: (u, o) => net.fetch(u, o), appData, appVersion: app.getVersion(), deviceName: os.hostname(),
    programsFn: () => installedVersions(), shareDevice: true });
  // The 🔒 Admin panel (central/admin.js): an owner or admin, with two-step sign-in, held in memory for 15 minutes of use
  const admin = new AdminLock({ readCompany: () => online.readCompany(appData), isDemo: demoOn,
    makeOnline: () => new online.Online({ store: memoryStore(store), fetchFn: (u, o) => net.fetch(u, o), appData, appVersion: app.getVersion(), deviceName: os.hostname() }) });
  handle('admin:state', () => admin.state());
  handle('admin:unlock', (email, password) => admin.unlock(email, password));
  handle('admin:code', (code) => admin.unlockCode(code));
  handle('admin:lock', () => admin.lock());
  handle('admin:touch', () => admin.touch());
  handle('admin:business', () => admin.business());
  // ...and soon after the list changes (only when it's different from what this PC last sent)
  usage = usageCounts.createUsageCounts({ store, config: () => on.config(), fetchFn: (u, o) => net.fetch(u, o), isDemo: demoOn, packaged: app.isPackaged,
    appVersion: app.getVersion(), osVersion: process.platform === 'win32' ? `Windows ${os.release()}` : `${os.type()} ${os.release()}`,
    readCompany: () => online.readCompany(appData), firstKind: usageFirst,
    link: async (id, ws) => { if (!on.session) return false; await on.rpc('install_link', { install_id: id, ws }); return true; } });
  setTimeout(usageTick, 45 * 1000); setInterval(usageTick, 6 * 3600 * 1000);
  handle('central:usageGet', () => ({ on: usage.enabled() }));
  handle('central:usageSet', (onOff) => { const v = usage.setEnabled(!!onOff); if (v) usageTick(); return { on: v }; });
  reportProgramsNow = () => {
    usageTick();   // a program added or updated: counted too (only when it's new)
    const c = online.readCompany(appData);
    return c && c.mode === 'online' && c.workspace_id ? on.reportPrograms(c.workspace_id, { onlyIfChanged: true }) : null;
  };
  // device.json: this PC's id for the other Riyeser programs (a signed licence names the PC it's for)
  try { if (online.readCompany(appData)) on.deviceId(); } catch { /* tried again at the licence check */ }
  // ---------- online connections: website orders and bookings in, prices, stock and free times out ----------
  // Only on the business's sync PC (central/online-sync.js); the books are changed by the program that holds them,
  // through its local API (central/local-app.js), never by Central.
  localApp = new LocalApp({ dbPath: sources.accountingDbPath(), fetchFn: (u, o) => fetch(u, o),
    findExe: (id) => { const p = PROGRAMS.find((x) => x.id === id); return p ? locate(p) : null; },
    // started without a window; never in demo mode (the sync waits while demo mode is on)
    spawnFn: (exe, args) => { const env = { ...process.env }; delete env.RIYESER_DEMO; return spawn(exe, args, { stdio: 'ignore', cwd: path.dirname(exe), env, windowsHide: true }); } });
  onlineSync = createSync({ online: on, local: localApp, store, appData, readCompany: online.readCompany, isDemo: demoOn, pcName: os.hostname(),
    notify: showOnlineNotification, onChange: (st) => send('online-sync', st), trailFile: path.join(app.getPath('userData'), 'online-trail.json') });
  onlineSync.start(20 * 1000);
  handle('onlineSync:status', () => onlineSync.status());
  handle('onlineSync:setMode', async (mode) => { admin.require(); const st = onlineSync.setMode(String(mode || '')); onlineSync.tick(); return st; });
  handle('onlineSync:now', () => onlineSync.poke());
  // "Connect your website" guide: Send a test (through the real post box) and where it is
  handle('onlineSync:sendTest', (kind) => onlineSync.sendTest(String(kind || '')));
  handle('onlineSync:testStatus', () => onlineSync.testStatus());
  // the activity trail (90 days): the list, and a CSV saved where the person chooses
  const trailQuery = (q) => ({ day: /^\d{4}-\d{2}-\d{2}$/.test(String((q || {}).day || '')) ? q.day : '', status: String((q || {}).status || '').slice(0, 20), type: String((q || {}).type || '').slice(0, 20) });
  handle('onlineSync:trail', (q) => onlineSync.trail({ ...trailQuery(q), limit: 1000 }));
  handle('onlineSync:exportTrail', async (q) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save the online activity', defaultPath: path.join(app.getPath('documents'), `Riyeser online activity ${new Date().toISOString().slice(0, 10)}.csv`), filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, onlineSync.trailCsv(trailQuery(q)), 'utf8');
    return r.filePath;
  });
  // the guide's links: only these three places
  handle('onlineSync:open', (what) => {
    const url = { connections: 'https://riyeser.com/link/?connections', developers: 'https://riyeser.com/developers/', help: 'https://riyeser.com/help/online.html' }[String(what)];
    if (!url) throw new Error('Unknown page.');
    return shell.openExternal(url).then(() => true);
  });
  // The signed-in person's role in the linked business (owner, admin or member), asked of Riyeser online once a day.
  let roleBusy = null;
  const businessRole = async (company) => {
    if (!company || company.mode !== 'online' || !company.workspace_id || !on.session) return null;
    const c = store.get('online-role', null);
    const fresh = c && c.ws === company.workspace_id && c.email === on.session.user.email && Date.now() - c.at < 24 * 3600 * 1000;
    if (!fresh && !roleBusy) {
      roleBusy = on.myBusinesses().then((list) => { const b = list.find((x) => x.workspace_id === company.workspace_id); if (b) store.set('online-role', { ws: company.workspace_id, email: on.session && on.session.user.email, role: b.role || 'member', at: Date.now() }); })
        .catch(() => {}).finally(() => { roleBusy = null; });
    }
    if (!(c && c.ws === company.workspace_id) && roleBusy) await Promise.race([roleBusy, new Promise((ok) => setTimeout(ok, 3000))]);
    const now = store.get('online-role', null);
    return now && now.ws === company.workspace_id ? now.role : null;
  };
  const companyState = async () => {
    const setup = store.get('company-setup', {}) || {};
    const s = on.session;
    const company = online.readCompany(appData);
    return { company, role: await businessRole(company).catch(() => null), kind: company ? (company.kind || ((store.get('online-kind', null) || {}).ws === company.workspace_id ? store.get('online-kind', null).kind : null)) : null,
      onlineReady: await on.ready(), signedIn: s ? s.user.email : null,
      pendingJoin: setup.pendingJoin || null, skipped: !!setup.skipped, unlinked: !!setup.unlinked,
      // signed out on purpose (company.json put away): the Company page asks to sign in, and the first-run choice isn't shown
      signedOut: !!setup.signedOut && !s, lastEmail: on.lastEmail() };
  };
  refreshOnlineLicence = async (force) => {
    const last = store.get('licence-online-at', 0) || 0;
    if (!force && Date.now() - last < 20 * 3600 * 1000) return null;
    const r = await on.refreshLicence().catch(() => null);
    if (r) { store.set('licence-online-at', Date.now()); if (win && !win.isDestroyed()) win.webContents.send('licence-changed', true); }
    return r;
  };
  setTimeout(() => refreshOnlineLicence(false), 5000);
  setInterval(() => refreshOnlineLicence(false), 6 * 3600 * 1000);
  // The free trial's anonymous PC record (core/trial-guard.js): at most once every 20 hours, only when online, never in
  // demo mode, no account (only a one-way PC code and the trial dates). Offline or refused: the dates on this PC stand.
  const trialOnline = async () => {
    if (demoOn() || !trialGuard.onlineDue(store.get('pc-trial-at', 0) || 0)) return null;
    if (!(await on.ready().catch(() => false))) return null;
    const r = await licence.syncTrialOnline(appData, (n, a) => on.anonRpc(n, a), { appVersion: app.getVersion() }).catch(() => null);
    if (r && r.sent) { store.set('pc-trial-at', Date.now()); if (win && !win.isDestroyed()) win.webContents.send('licence-changed', true); }
    return r;
  };
  setTimeout(trialOnline, 15000);
  setInterval(trialOnline, 6 * 3600 * 1000);
  handle('company:get', () => companyState());
  handle('company:signIn', (email, password, create) => on.signIn(String(email || '').trim(), String(password || ''), !!create));
  handle('company:verifyCode', (code) => on.verifyCode(code));   // S11: two-step sign-in
  handle('company:recover', (email) => on.recover(email));
  // "Sign out" on the Company page: company.json and licence.json's online part are put away (renamed, never deleted)
  handle('company:signOut', () => {
    const r = on.signOutOfPC();
    if (win && !win.isDestroyed()) win.webContents.send('licence-changed', true);
    return r;
  });
  // first run: was this PC linked to a business that already exists (a second PC: "What is this PC for?") or a new one
  const origin = (o) => (r) => { if (r) store.update('first-run-pc', {}, (x) => ({ ...(x || {}), origin: o })); return r; };
  handle('company:create', async (profile, yourName) => origin('created')(await on.createCompany(profile || {}, yourName)));
  // After signing in with a Riyeser account: link to its business (one), let them pick (several), or the details form (none)
  const linked = (r) => { if (r && r.company && win && !win.isDestroyed()) win.webContents.send('licence-changed', true); return r; };
  handle('company:afterSignIn', async () => { const r = linked(await on.afterSignIn()); if (r && r.status === 'linked') origin('joined')(r); return r; });
  handle('company:link', async (ws) => origin('joined')(linked({ status: 'linked', ...(await on.linkBusiness(String(ws || ''))) })));
  handle('company:details', async (f) => { const profile = online.detailsToProfile(f || {}); return origin('created')(await on.createCompany(profile, String((f || {}).your_name || '').trim())); });
  handle('company:join', async (code, yourName, note) => { const r = await on.requestJoin(code, yourName, note); if (r && r.status === 'approved') origin('joined')(r); return r; });
  handle('company:checkJoin', async () => { const r = await on.checkJoin(); if (r && r.status === 'approved') { origin('joined')(r); refreshOnlineLicence(true).catch(() => null); } return r; });
  handle('company:cancelJoin', () => { store.update('company-setup', {}, (o) => ({ ...(o || {}), pendingJoin: null })); return true; });
  handle('company:local', (profile, yourName) => on.setupLocal(profile || {}, yourName));
  handle('company:skip', () => { store.update('company-setup', {}, (o) => ({ ...(o || {}), skipped: true })); return true; });
  handle('company:copy', (text) => { clipboard.writeText(String(text || '')); return true; });
  // ---------- demo mode (%APPDATA%\Riyeser\demo.json; every program reads it when it starts) ----------
  const neverSetUp = () => { const setup = store.get('company-setup', {}) || {}; return !online.readCompany(appData) && !setup.skipped && !setup.signedOut; };
  handle('demo:get', () => ({ on: demo.isOn(appData), business: demo.BUSINESS, neverSetUp: neverSetUp() }));
  // Only after the person said yes to "Turn on demo mode?" (the renderer sends { confirmed: true }).
  handle('demo:start', (opts) => {
    if (!demoUi.startAllowed(opts)) throw new Error('Demo mode wasn\'t turned on. Choose Try demo mode, then Turn on demo mode.');
    admin.require();   // a business PC: only from the unlocked Admin panel
    demo.start(appData); return { on: true, business: demo.BUSINESS };
  });
  handle('demo:leave', () => ({ ...demo.leave({ appData }), on: false, neverSetUp: neverSetUp() }));
  try { demo.tidy({ appData }); } catch { /* tried again next start */ }
  // Was this PC unlinked by an admin? Checked once a day; the company file and all data stay as they are.
  handle('company:checkLinked', async () => {
    const ok = await on.stillLinked();
    if (ok !== null) store.update('company-setup', {}, (o) => ({ ...(o || {}), unlinked: ok === false }));
    return ok;
  });
  // ---------- "Getting started with Riyeser": ticks itself from what's on this PC (read-only) ----------
  // Personal or business: company.json when it was set up on this PC, else asked of Riyeser online once a day.
  let kindBusy = null;
  const businessKind = (company) => {
    if (company && (company.kind === 'personal' || company.kind === 'business')) return company.kind;
    const c = store.get('online-kind', null);
    const fresh = c && company && c.ws === company.workspace_id && Date.now() - c.at < 24 * 3600 * 1000;
    if (!fresh && !kindBusy && company && company.mode === 'online') {
      kindBusy = on.workspaceKind().then((k) => { if (k) store.set('online-kind', { ws: company.workspace_id, kind: k, at: Date.now() }); })
        .catch(() => {}).finally(() => { kindBusy = null; });
    }
    return c && company && c.ws === company.workspace_id ? c.kind : null;
  };
  const checklistHidden = () => checklist.isHidden(store, on);
  handle('central:checklist', async () => {
    const list = programList();
    const installed = list.filter((p) => p.status === 'installed').map((p) => p.id);
    const known = PROGRAMS.map((p) => p.id).filter((id) => updates.PRODUCTS.some((x) => x.id === id && !x.self));
    const names = Object.fromEntries(PROGRAMS.map((p) => [p.id, p.id === 'team' ? p.full : p.name]));
    if (demoOn()) return checklist.build({ demo: true, hidden: checklistHidden() });
    const lic = licence.read(appData);
    const company = online.readCompany(appData);
    const soft = (p) => p.catch(() => ({ found: false }));
    const [acc, payroll] = await Promise.all([soft(checklist.accountingFacts(sources.accountingDbPath())), soft(checklist.payrollFacts(sources.payrollDbPath(appData)))]);
    const seats = lic.online && lic.online.seats;
    return checklist.build({ company, lic, installed, known, names, acc, payroll, link: checklist.linkFacts(appData), kind: businessKind(company),
      members: seats && seats.used != null ? Number(seats.used) : null, skipped: checklist.skippedIds(store), hidden: checklistHidden() });
  });
  // Hide or show the card. Kept on this PC, and with the Riyeser account when signed in (so riyeser.com can follow it).
  handle('central:checklistHide', (hidden) => checklist.setHidden(store, on, !!hidden));
  handle('central:checklistSkip', (id, skip) => checklist.setSkipped(store, id, skip !== false));
  // ---------- first run, "One installer": sign in -> install your plan -> your business -> done ----------
  const programIds = PROGRAMS.map((p) => p.id).filter((id) => updates.PRODUCTS.some((x) => x.id === id && !x.self));
  const installedNow = () => programList().filter((p) => p.status === 'installed').map((p) => p.id);
  const pcPrefs = () => store.get('first-run-pc', {}) || {};
  const soon = (p, ms) => Promise.race([p, new Promise((ok) => setTimeout(() => ok(null), ms))]).catch(() => null);
  const firstRunInfo = async () => {
    const company = online.readCompany(appData);
    const kind = company ? (company.kind || (company.mode === 'online' ? await soon(on.workspaceKind(), 4000) : null)) : null;
    const pathKind = firstRun.pathFor({ company, kind });
    let lic = licence.read(appData);
    if (pathKind === 'plan' && !(lic.online && lic.online.modules)) { await soon(refreshOnlineLicence(true), 8000); lic = licence.read(appData); }
    const pc = pcPrefs();
    let role = pc.role;
    if (!role) { try { role = ((on.prefs().pc_roles || {})[on.deviceId()]) || null; } catch { role = null; } }   // this PC, set up before
    const plan = pathKind === 'plan' ? firstRun.planPrograms(lic).filter((id) => programIds.includes(id)) : [];
    const run = firstRunState();
    return { path: pathKind, kind, company: company ? { name: company.name, company_code: company.company_code || '', mode: company.mode, country: company.country || '',
      currency: company.currency || '', tax_number: company.tax_number || '', logo: company.logo ? path.basename(company.logo) : '' } : null,
      planKnown: !!(lic.online && lic.online.modules), plan, role: role || 'everything', roleChosen: !!role, secondPc: pc.origin === 'joined',
      roles: firstRun.ROLES.map(({ id, title, sub }) => ({ id, title, sub, programs: firstRun.forRole(plan, id) })),
      individual: firstRun.INDIVIDUAL.filter((id) => programIds.includes(id)), individualDefault: firstRun.INDIVIDUAL_DEFAULT,
      programs: PROGRAMS.filter((p) => programIds.includes(p.id)).map((p) => ({ id: p.id, name: p.name, full: p.full, desc: p.desc, elevate: !!(updates.PRODUCTS.find((x) => x.id === p.id) || {}).elevate })),
      installed: installedNow(), run, summary: run ? firstRun.summary(run) : null, online: firstRunDriver.isOnline(),
      currencies: firstRun.CURRENCIES, countryCurrency: firstRun.COUNTRY_CURRENCY };
  };
  handle('firstrun:get', () => firstRunInfo());
  // "What is this PC for?": kept on this PC, and with the Riyeser account for this PC (so setting it up again remembers)
  handle('firstrun:role', async (role) => {
    const r = firstRun.roleOf(String(role || '')).id;
    store.update('first-run-pc', {}, (x) => ({ ...(x || {}), role: r }));
    try { const prev = on.prefs().pc_roles || {}; await soon(on.savePrefs({ pc_roles: { ...prev, [on.deviceId()]: r } }), 5000); } catch { /* kept on this PC */ }
    return r;
  });
  // Install these programs (the plan for this PC, or the ones ticked). What's already done is kept.
  handle('firstrun:start', async (ids, opts = {}) => {
    const info = await firstRunInfo();
    const want = (Array.isArray(ids) ? ids : info.path === 'plan' ? firstRun.forRole(info.plan, info.role) : info.individualDefault).filter((id) => programIds.includes(id));
    const names = Object.fromEntries(PROGRAMS.map((p) => [p.id, p.full]));
    const old = firstRunState();
    let run = old && old.items ? firstRun.choose(old, want, { installed: installedNow(), names }) : firstRun.newRun({ path: info.path, role: info.role, ids: want, installed: installedNow(), names });
    run = { ...run, path: info.path, role: info.role, step: (opts && opts.step) || run.step || 'install' };
    saveFirstRun(run);
    runFirstRun();
    return { run, summary: firstRun.summary(run) };
  });
  handle('firstrun:retry', (ids) => {
    const old = firstRunState(); if (!old) return null;
    const run = firstRun.retry(old, Array.isArray(ids) ? ids.map(String) : null);
    saveFirstRun(run); runFirstRun();
    return { run, summary: firstRun.summary(run) };
  });
  // Where the person is in the first run: install | business | done | background (Keep using Central) | closed
  handle('firstrun:step', (stepName) => {
    const s = String(stepName || '');
    if (!['install', 'business', 'done', 'background', 'closed'].includes(s)) throw new Error('Unknown step');
    const run = firstRunState() || { v: 1, items: [], ids: [], finished: true, startedAt: Date.now() };
    saveFirstRun({ ...run, step: s });
    return s;
  });
  // "Your business": name, country, currency, tax number, logo, saved in company.json for every Riyeser program
  handle('firstrun:profile', (f) => {
    const x = f || {};
    const cur = firstRun.CURRENCIES.some(([c]) => c === x.currency) ? x.currency : firstRun.currencyFor(x.country);
    const c = online.writeCompany(appData, { name: String(x.name || '').trim(), country: String(x.country || '').trim(), tax_number: String(x.tax_number || '').trim(), currency: cur });
    if (win && !win.isDestroyed()) win.webContents.send('licence-changed', true);
    return { name: c.name, country: c.country, currency: c.currency, tax_number: c.tax_number, logo: c.logo ? path.basename(c.logo) : '' };
  });
  handle('firstrun:logo', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose your logo', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0]; const size = fs.statSync(src).size;
    if (size > 2 * 1024 * 1024) throw new Error('That picture is over 2 MB. Choose a smaller one (a PNG or JPG of your logo).');
    const ext = /\.png$/i.test(src) ? '.png' : '.jpg';
    const dest = path.join(appData, 'Riyeser', `logo${ext}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    online.writeCompany(appData, { logo: dest });
    return { logo: path.basename(dest), dataUrl: `data:image/${ext === '.png' ? 'png' : 'jpeg'};base64,${fs.readFileSync(dest).toString('base64')}` };
  });
  // Back online: programs that were waiting for the internet carry on by themselves (checked every 2 minutes).
  const resumeIfOnline = () => {
    const run = firstRunState();
    if (!run || run.finished || firstRunBusy || !firstRunDriver.isOnline() || demoOn()) return;
    const s = firstRun.summary(run);
    if (!s.paused.length && !s.waiting.length) return;
    saveFirstRun(firstRun.retry(run, [...s.paused, ...s.waiting])); runFirstRun();
  };
  setTimeout(resumeIfOnline, 15 * 1000); setInterval(resumeIfOnline, 2 * 60 * 1000);
  handle('firstrun:resume', () => { resumeIfOnline(); return true; });
  handle('central:updates', (force) => updateStatus(!!force));
  handle('central:installUpdates', (ids) => installUpdates(ids));
  handle('central:install', (id) => installProgram(id));
  // Help: each program's guide in the Riyeser Help Centre.
  handle('central:help', (id) => {
    const guide = { central: 'central', team: 'link', linkoffice: 'link-office', invoices: 'invoices', bookings: 'bookings', estimate: 'estimate', 'accounting-basics': 'accounting-basics', accounting: 'accounting', pos: 'pos', payroll: 'payroll', desk: 'desk-assistant', pdf: 'pdf', services: 'services' }[id];
    return shell.openExternal(guide ? `https://riyeser.com/help/${guide}.html` : 'https://riyeser.com/help.html').then(() => true);
  });
  // Get help: ask Riyeser Support on riyeser.com (signs in, then opens the "Get help" form).
  handle('central:getHelp', () => shell.openExternal('https://riyeser.com/link/?help').then(() => true));
  // Report an issue: the diagnostic details are made here once (scrubbed), shown in the preview, and exactly those are
  // sent with what the person typed (diagnostics.js says what's collected). Needs the Riyeser account signed in here.
  let prepared = null;
  const progNames = { ...Object.fromEntries(PROGRAMS.map((p) => [p.id, p.full])), central: 'Riyeser Central' };
  handle('support:prepare', async (product) => {
    const known = diagnostics.PRODUCTS.map((p) => ({ id: p.id, name: p.name }));
    if (!on.canReport()) { prepared = null; return { signedIn: false, products: known }; }
    if (!diagnostics.PRODUCTS.some((p) => p.id === product)) return { signedIn: true, products: known, business: (online.readCompany(appData) || {}).name || '' };
    const programs = await installedVersions().catch(() => ({}));
    // online connections: the program's online-api.log (next to the company file), or Central's own online problems
    const extra = ['accounting', 'invoices', 'pos', 'bookings'].includes(product) && localApp ? [{ file: localApp.logFile(), label: 'online connections log' }]
      : product === 'central' && onlineSync ? [{ text: onlineSync.trail({ status: 'problems', limit: 60 }).rows.reverse().map((r) => `${new Date(r.at).toISOString()} ${r.ref || ''} ${r.what}${r.detail ? ` — ${r.detail}` : ''}`).join('\n'), label: 'Riyeser Central online connections activity' }] : [];
    let trial = null; try { trial = licence.trialReport(appData); } catch { /* left out */ }
    const diag = diagnostics.build({ product, programs, centralVersion: app.getVersion(), log: diagnostics.readLog(product, { extra }), trial,
      osName: diagnostics.windowsName(typeof os.version === 'function' ? os.version() : '', os.release(), process.platform) });
    prepared = { token: crypto.randomUUID(), diag };
    return { signedIn: true, products: known, business: (online.readCompany(appData) || {}).name || '', token: prepared.token, diag, preview: diagnostics.preview(diag, progNames) };
  });
  handle('support:send', async (token, form) => {
    if (!prepared || prepared.token !== token) throw new Error('The details changed. Check the preview again, then send.');
    const r = await on.reportIssue(diagnostics.payload(prepared.diag, form || {}));
    prepared = null;
    return { ref: r && r.ref, diag_ref: r && r.diag_ref };
  });
  handle('support:open', (ref) => {
    if (!/^T-\d{1,12}$/.test(String(ref || ''))) throw new Error('That request number doesn\'t look right.');
    return shell.openExternal(`https://riyeser.com/link/?help#${ref}`).then(() => true);
  });
  // Riyeser Link: its own app when it's installed (it rings by itself), otherwise Central's own Link window.
  handle('central:team', async () => { const exe = teamApp(); if (exe) { const err = await shell.openPath(exe); if (err) throw new Error(err); return true; } return openTeam(); });
  handle('search:find', (opts) => {
    // Search uses Desk Assistant's file list: nothing (not an old list) when it isn't installed.
    if (!locate(PROGRAMS.find((x) => x.id === 'desk'))) return { total: 0, results: [], facets: { type: {}, year: {}, kind: {} } };
    const da = sources.deskAssistant(deskData());
    return searchIndex().find(opts || {}, { organisedRoot: (da.settings && da.settings.organisedRoot) || '' });
  });
  // ---------- "Fresh start on this PC" (Settings): every Riyeser folder renamed away, never deleted ----------
  const freshOpts = () => ({ appData, centralDir: app.getPath('userData') });
  const openNow = async () => { const imgs = await freshstart.runningImages(); return imgs ? freshstart.openPrograms(PROGRAMS, imgs) : []; };
  const restartSoon = () => setTimeout(() => { quitting = true; app.relaunch(); app.exit(0); }, 1500);
  handle('fresh:check', async () => ({ open: await openNow(), folders: freshstart.plan(freshOpts()).map((f) => ({ name: f.name, dir: f.dir })), sets: freshstart.sets(freshOpts()) }));
  handle('fresh:start', async (typed, signOut) => {
    admin.require();
    if (String(typed || '').trim() !== freshstart.CONFIRM) throw new Error(`Type ${freshstart.CONFIRM} to go ahead.`);
    const open = await openNow();
    if (open.length) return { ok: false, open, message: freshstart.closeFirst(open) };
    const r = freshstart.putAway({ ...freshOpts(), keepSignIn: signOut === false, version: app.getVersion() });
    if (!r.ok) return { ...r, message: freshstart.failMessage(r) };
    restartSoon();
    return r;
  });
  // "Close them for me": each open Riyeser program is closed properly (never forced), then it looks again
  handle('fresh:close', async () => {
    const r = await freshstart.closePrograms({ programs: PROGRAMS, locate, launch });
    return { ...r, open: await openNow() };
  });
  handle('fresh:sets', () => freshstart.sets(freshOpts()));
  // ---------- OWNER-BACKUP: "Back up everything" and "Restore everything from a backup" ----------
  // One file, Documents\Riyeser\Central\Backups\Riyeser backup <date>.zip, with every installed Riyeser program's data
  // (backup-specs.js says which folders). A restore is done on Central's restart, before anything opens the data.
  const B = require('./core/backup'); const specs = require('./core/backup-specs');
  const docs = () => ({ documents: app.getPath('documents') });
  const installedIds = () => programList().filter((p) => p.status === 'installed').map((p) => p.id);
  handle('backup:status', () => ({ folder: B.backupsDir('Everything', docs()), backups: B.listBackups(B.backupsDir('Everything', docs())).slice(0, 5).map((b) => ({ name: b.name, when: b.when })) }));
  handle('backup:all', async () => { const r = await B.createBackup(specs.everythingSpec({ appData }, installedIds()), docs()); return { file: r.file, parts: r.parts }; });
  handle('backup:folder', () => { fs.mkdirSync(B.backupsDir('Everything', docs()), { recursive: true }); return shell.openPath(B.backupsDir('Everything', docs())).then(() => true); });
  handle('backup:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Restore from a Riyeser backup', defaultPath: B.backupsDir('Everything', docs()), properties: ['openFile'], filters: [{ name: 'Riyeser backups', extensions: ['zip'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const info = await B.describeBackup(r.filePaths[0]);
    return { file: r.filePaths[0], program: info.program, summary: B.summary(info) };
  });
  handle('backup:restoreAll', async (file) => {
    if (online.readCompany(appData)) admin.require();   // from the Admin panel (a new PC's first run has no business yet)
    const open = await openNow();
    if (open.length) return { ok: false, open, message: freshstart.closeFirst(open) };
    await B.describeBackup(file);
    B.scheduleRestore(app.getPath('userData'), file);
    restartSoon();
    return { ok: true };
  });
  handle('backup:result', () => { const r = backupResult; backupResult = null; return r; });
  handle('fresh:bringBack', async (id) => {
    admin.require();
    const set = freshstart.sets(freshOpts()).find((s) => s.id === id);
    if (!set) throw new Error('That fresh start isn’t on this PC any more.');
    const open = await openNow();
    if (open.length) return { ok: false, open, message: freshstart.closeFirst(open) };
    const r = freshstart.bringBack({ set, centralDir: app.getPath('userData') });
    if (!r.ok) return { ...r, message: `Nothing was brought back: ${r.failed.name} is in use (${r.failed.dir}). Close it and try again.` };
    restartSoon();
    return r;
  });
  // ---------- 1.9: the launcher's extras ----------
  // Admin panel → Updates: each program's version on this PC and in the release, and the channel.
  handle('central:versions', async (force) => {
    let r;
    try { r = await checkUpdates(!!force); } catch (e) {   // offline: what's on this PC, and why the latest isn't known
      return { installed: await installedVersions().catch(() => ({})), latest: {}, release: null, channel: updateChannel(), note: /^Couldn't check/.test(e.message) ? e.message : 'Couldn\'t check for the latest versions: no connection right now.' };
    }
    const latest = Object.fromEntries(Object.entries((r.latest && r.latest.products) || {}).map(([id, x]) => [id, x.version]));
    return { installed: r.installed || {}, latest, release: r.latest ? r.latest.name || r.latest.tag : null, channel: updateChannel(), note: r.note || null };
  });
  handle('central:setChannel', (ch) => {
    admin.require();
    if (!updates.CHANNELS.includes(ch)) throw new Error('Unknown update channel.');
    store.update('prefs', {}, (o) => ({ ...(o || {}), channel: ch })); store.set('updateCheck', null);
    return ch;
  });
  // A tile's ⋯ → Uninstall: Windows' own uninstaller for that program (asked first in Central).
  handle('central:uninstall', async (id) => {
    admin.require();
    const p = updates.PRODUCTS.find((x) => x.id === id && !x.self);
    if (!p) throw new Error('Unknown program');
    if (process.platform !== 'win32') throw new Error('Programs uninstall on Windows only.');
    const q = (key) => new Promise((resolve) => execFile('reg', ['query', key, '/s', '/reg:64'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(out || '')));
    const u = updates.uninstallFromRegistry(`${await q('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')}\n${await q('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')}`, id);
    if (!u) { await shell.openExternal('ms-settings:appsfeatures'); return { settings: true }; }   // not in Windows' list: Installed apps
    spawn('cmd.exe', ['/d', '/s', '/c', `"${u.command}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
    installLog({ id, stage: 'uninstall', detail: u.name });
    setTimeout(() => programsReporter.soon(), 60 * 1000);
    return { started: true, name: u.name };
  });
  // Settings (this person's): start with Windows, notifications. Theme and language are kept in the window.
  const prefs = () => store.get('prefs', {}) || {};
  const loginOn = () => { try { return !!app.getLoginItemSettings().openAtLogin; } catch { return false; } };
  handle('central:prefs', () => ({ startWithWindows: loginOn(), notify: prefs().notify !== false, canStart: app.isPackaged && process.platform === 'win32' }));
  handle('central:startWithWindows', (onOff) => {
    if (!(app.isPackaged && process.platform === 'win32')) throw new Error('Starting with Windows works in the installed Riyeser Central.');
    app.setLoginItemSettings({ openAtLogin: !!onOff }); return loginOn();
  });
  handle('central:notify', (onOff) => { store.update('prefs', {}, (o) => ({ ...(o || {}), notify: !!onOff })); return !!onOff; });
  // The search box: customers in the books (read-only copy), while Accounting or Invoices is installed.
  handle('central:customers', async (q) => {
    const ok = ['accounting', 'accounting-basics', 'invoices'].some((id) => !!locate(PROGRAMS.find((x) => x.id === id)));
    if (!ok) return [];
    return sources.findCustomers(demoOn() ? demo.demoAccountingDb() : sources.accountingDbPath(), String(q || '').slice(0, 80));
  });
  // The Admin panel's links to Riyeser Link (people, join requests, phones and branches): only these places.
  handle('central:openWeb', (what) => {
    const url = { people: 'https://riyeser.com/link/', requests: 'https://riyeser.com/link/?requests', phones: 'https://riyeser.com/link/?phones', requestsHelp: 'https://riyeser.com/link/?help' }[String(what)];
    if (!url) throw new Error('Unknown page.');
    return shell.openExternal(url).then(() => true);
  });
  handle('file:open', async (p) => { if (!fs.existsSync(p)) throw new Error('That file has moved or been deleted. Try searching for it.'); const err = await shell.openPath(p); if (err) throw new Error(err); return true; });
  handle('file:reveal', (p) => { shell.showItemInFolder(p); return true; });
}

// Riyeser Link (chat, formerly Riyeser Team) in its own window. It's the online chat at riyeser.com/link, with its
// sign-in kept in its own storage (still called riyeser-team) so it stays signed in. Links open in the web browser.
const TEAM_URL = 'https://riyeser.com/link/';
let teamWin = null; let quitting = false;
// Microphone and camera (for Riyeser Link calls) and notifications, only for riyeser.com, only in the Link window.
function teamSession() {
  const ses = session.fromPartition('persist:riyeser-team');
  if (!ses.__riyeserPerms) {
    const ours = (url) => { try { return new URL(url).origin === new URL(TEAM_URL).origin; } catch { return false; } };
    ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(['media', 'notifications', 'clipboard-sanitized-write'].includes(perm) && ours(details.requestingUrl || wc.getURL())));
    ses.setPermissionCheckHandler((_wc, perm, origin) => ['media', 'notifications', 'clipboard-sanitized-write'].includes(perm) && ours(origin));
    ses.__riyeserPerms = true;
  }
  return ses;
}
// After the first time Link is opened, it keeps running (hidden) while Central is open, so calls can ring.
function teamApp() { try { return locate(PROGRAMS.find((x) => x.id === 'team')); } catch { return null; } }
function openTeam(opts = {}) {
  if (teamWin && !teamWin.isDestroyed()) {
    if (!opts.background) { if (teamWin.isMinimized()) teamWin.restore(); teamWin.show(); teamWin.focus(); }
    return true;
  }
  teamWin = new BrowserWindow({
    width: 1100, height: 760, minWidth: 380, minHeight: 500, title: 'Riyeser Link', show: !opts.background,
    icon: path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon-central.ico' : 'icon-central.png'),
    webPreferences: { session: teamSession(), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  teamWin.removeMenu();
  teamWin.loadURL(TEAM_URL);
  // riyeser.com/link/ and its old address riyeser.com/team/ both stay in this window.
  const outside = (url) => { try { const u = new URL(url); return !(u.origin === new URL(TEAM_URL).origin && (u.pathname.startsWith('/link/') || u.pathname.startsWith('/team/'))); } catch { return true; } };
  teamWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  teamWin.webContents.on('will-navigate', (e, url) => { if (outside(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  teamWin.webContents.on('page-title-updated', (_e, title) => {
    if (win && !win.isDestroyed()) win.webContents.send('team:title', title);
    if (/^📞/.test(title) && teamWin && !teamWin.isDestroyed()) {   // an incoming call: bring Link forward
      if (teamWin.isMinimized()) teamWin.restore();
      teamWin.show(); teamWin.focus(); teamWin.flashFrame(true);
    }
  });
  teamWin.on('focus', () => { if (teamWin) teamWin.flashFrame(false); });
  teamWin.on('close', (e) => { if (!quitting) { e.preventDefault(); teamWin.hide(); } });   // keep running so calls can ring
  teamWin.on('closed', () => { teamWin = null; });
  try { store.set('team', { background: true }); } catch { /* settings are a nice-to-have */ }
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600, title: 'Riyeser Central',
    icon: path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon-central.ico' : 'icon-central.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'central.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // Closing Central closes the hidden Link window too, so Central really quits.
  win.on('closed', () => { win = null; quitting = true; if (teamWin && !teamWin.isDestroyed()) teamWin.destroy(); });
  // Link was used before: start it quietly in the background so calls can ring.
  let t = null; try { t = store.get('team', null); } catch { /* none yet */ }
  // (not when the Riyeser Link app is installed: it rings by itself, and two windows would ring twice)
  if (t && t.background && !teamApp()) setTimeout(() => openTeam({ background: true }), 4000);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
let backupResult = null;   // OWNER-BACKUP: what a restore on this start did (shown once the window is up)
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'system';
  // the free trial's registry copy (HKCU\Software\Riyeser\Trial) and the one-way PC code: Windows only
  try { trialGuard.useWindowsDefaults(); } catch { /* the other places still count */ }
  if (!process.argv.some((a) => a.startsWith('--self-test='))) {
    // a "Restore everything" asked for before the restart: done now, before Central (or anything) opens the data
    const B = require('./core/backup');
    backupResult = await B.applyPendingRestore(app.getPath('userData'), require('./core/backup-specs').everythingSpec({ appData: app.getPath('appData') }),
      { documents: app.getPath('documents') }).catch((e) => ({ ok: false, error: e.message }));
    // the automatic backup of everything: once a day, the last 30 kept
    const daily = () => B.dailyBackup(require('./core/backup-specs').everythingSpec({ appData: app.getPath('appData') }, programList().filter((p) => p.status === 'installed').map((p) => p.id)),
      { documents: app.getPath('documents') }).catch(() => null);
    setTimeout(daily, 90 * 1000); setInterval(daily, 6 * 3600 * 1000);
  }
  store = new Store(path.join(app.getPath('userData'), 'data'));
  // before anything is written on this start: a PC that had Central before usage counts is "existing", not "new"
  try { usageFirst = usageCounts.hadCentralBefore(store) ? 'existing' : 'new'; } catch { /* new */ }
  // Used by the Windows build check: write what Central can see, then quit.
  const selfTest = process.argv.find((a) => a.startsWith('--self-test='));
  if (selfTest) {
    const out = selfTest.slice('--self-test='.length);
    let money; try { money = await sources.pendingPayments(); } catch (e) { money = { error: e.message }; }
    let upd; try { upd = await updateStatus(true); } catch (e) { upd = { error: e.message }; }
    fs.writeFileSync(out, JSON.stringify({ version: app.getVersion(), programs: programList(), money: { found: money.found, error: money.error || null }, installed: await installedVersions(), updates: upd, licence: licence.status(app.getPath('appData')), demo: demo.isOn(app.getPath('appData')) }, null, 2));
    app.exit(0);
    return;
  }
  registerIpc();
  createWindow();
  // Used by the Windows build check: the home screen as people see it (the launcher's tiles, pill and chips, any page
  // errors, and a picture of the window), then quit.
  const uiTest = process.argv.find((a) => a.startsWith('--self-test-ui='));
  if (uiTest) {
    const out = uiTest.slice('--self-test-ui='.length); const errors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    win.webContents.once('did-finish-load', async () => {
      let r = null;
      for (let i = 0; i < 60 && !(r && r.tiles.length); i++) {
        await new Promise((ok) => setTimeout(ok, 500));
        r = await win.webContents.executeJavaScript(`({ tiles: [...document.querySelectorAll('#tiles .app')].map((a) => ({ name: a.querySelector('b').textContent, line: a.querySelector('.tl').textContent.trim() })),
          pill: document.querySelector('#pilltxt').textContent, chips: [...document.querySelectorAll('#chips .chip')].map((c) => c.textContent), admin: !document.querySelector('#adminbtn').hidden,
          hscroll: document.documentElement.scrollWidth > innerWidth + 1, wizard: !document.querySelector('#wizard').hidden })`).catch(() => null);
      }
      try { fs.writeFileSync(out.replace(/\.json$/i, '.png'), (await win.webContents.capturePage()).toPNG()); } catch { /* the report is what matters */ }
      fs.writeFileSync(out, JSON.stringify({ version: app.getVersion(), ...(r || { tiles: [] }), errors }, null, 2));
      app.exit(0);
    });
  }
});
app.on('before-quit', () => { quitting = true; if (onlineSync) onlineSync.stop(); if (localApp) localApp.stop(); });
app.on('window-all-closed', () => app.quit());
