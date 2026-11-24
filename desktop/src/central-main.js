// Riyeser Central: the Riyeser Group home screen. Opens every Riyeser program and shows, like a PA would, what needs
// attention today: meetings, to-dos, money owed and owing, and recent documents, plus one search for every file.
// It only READS the other programs' data, so it can never damage their files.
const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, net, session, clipboard } = require('electron');
const { execFile, spawn } = require('child_process');
const updates = require('./central/updates');
const licence = require('./core/licence');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Store } = require('./core/store');
const { Index } = require('./core/indexer');
const { upcomingMeetings } = require('./core/calendar');
const sources = require('./central/sources');
const online = require('./core/online');
const demo = require('./central/demo');
const checklist = require('./central/checklist');

app.setName('Riyeser Central');
// Central's data folder. Versions before 1.2 used "Riyser Central": move it across once so nothing is lost.
{
  const dataNew = path.join(app.getPath('appData'), 'Riyeser Central');
  const dataOld = path.join(app.getPath('appData'), 'Riyser Central');
  try { if (!fs.existsSync(dataNew) && fs.existsSync(dataOld)) fs.renameSync(dataOld, dataNew); } catch { /* keep going with a fresh folder */ }
  app.setPath('userData', dataNew);
}
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null; let store = null;
const deskData = () => path.join(app.getPath('appData'), 'Desk Assistant', 'data');
const localPrograms = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs');

// ---------- the programs ----------
const PROGRAMS = [
  // Free invoicing on its own (free forever). Opens the same company files as Accounting and installs next to it.
  // Riyeser Team as its own desktop app (chat free; Team Chat Plus calls). When it's installed, Team chat opens it.
  { id: 'team', name: 'Team', full: 'Riyeser Team', icon: '💬', desc: 'Team chat for your business, and Team Chat Plus calls. Chat is free.',
    dirs: ['riyeser-team', 'Riyeser Team'], exes: ['Riyeser Team.exe'], links: ['Riyeser Team'] },
  { id: 'invoices', name: 'Invoices', full: 'Riyeser Invoices', icon: '🧾', desc: 'Quotes, invoices, customers and getting paid. Free forever.',
    dirs: ['Riyeser Invoices'], exes: ['Riyeser Invoices.exe'], links: ['Riyeser Invoices'], pages: ['invoice'] },
  // Bookings and scheduling (jobs, appointments, tables). Same company files as Accounting; installs next to it.
  { id: 'bookings', name: 'Bookings', full: 'Riyeser Bookings', icon: '📅', desc: 'Jobs, appointments and table bookings on one calendar. Free for 90 days.',
    dirs: ['Riyeser Bookings'], exes: ['Riyeser Bookings.exe'], links: ['Riyeser Bookings'] },
  // Two separate apps that share the same books. The old single "Riyeser Accounting" 1.x counts as Plus.
  { id: 'accounting-basics', name: 'Accounting Basics', full: 'Riyeser Accounting Basics', icon: '📗', desc: 'Invoicing, quotes, customers and stock. Free for 90 days.',
    dirs: ['Riyeser Accounting Basics'], exes: ['Riyeser Accounting Basics.exe'], links: ['Riyeser Accounting Basics'], pages: ['invoice'] },
  { id: 'accounting', name: 'Accounting Plus', full: 'Riyeser Accounting Plus', icon: '📒', desc: 'Full books: banking, payroll, journals, jobs and budgets. Included in your licence.',
    dirs: ['Riyeser Accounting Plus', 'Riyeser Accounting'], exes: ['Riyeser Accounting Plus.exe', 'Riyeser Accounting.exe'], links: ['Riyeser Accounting Plus', 'Riyeser Accounting'], pages: ['invoice'] },
  // The till on its own. It opens the same company files as Accounting and installs next to it.
  { id: 'pos', name: 'POS', full: 'Riyeser POS', icon: '🧾', desc: 'The till for shops, cafes and restaurants. Free for 90 days.',
    dirs: ['Riyeser POS'], exes: ['Riyeser POS.exe'], links: ['Riyeser POS'], pages: ['pos'] },
  { id: 'payroll', name: 'Payroll', full: 'Riyeser Payroll', icon: '🕒', desc: 'Time clock, timesheets, pay runs, payslips and leave.',
    dirs: ['riyeser-payroll', 'Riyeser Payroll', 'riyeser', 'Riyeser', 'riyser', 'Riyser'], exes: ['Riyeser Payroll.exe', 'Riyeser.exe', 'Riyser.exe'],
    links: ['Riyeser Payroll', 'Riyeser', 'Riyser'] }, // Riyeser Payroll 2.0+; older builds were a hub called Riyser
  { id: 'desk', name: 'Desk Assistant', full: 'Riyeser Desk Assistant', icon: '🗂', desc: 'Sort files by type, find anything, meetings and to-dos.',
    dirs: ['desk-assistant'], exes: ['Riyeser Desk Assistant.exe', 'Desk Assistant.exe'], links: ['Riyeser Desk Assistant', 'Desk Assistant'] },
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
  const saved = (store.get('locations', {}))[p.id];
  if (saved && exists(saved)) return saved;
  for (const d of p.dirs || []) for (const e of p.exes || []) { const f = path.join(localPrograms(), d, e); if (exists(f)) return f; }
  if (process.platform === 'win32') {
    for (const dir of shortcutDirs()) for (const l of p.links || []) {
      const lnk = path.join(dir, `${l}.lnk`);
      if (!exists(lnk)) continue;
      try { const t = shell.readShortcutLink(lnk).target; if (t && exists(t)) return t; } catch { /* broken shortcut */ }
    }
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
function installedVersions() {
  if (process.platform !== 'win32') return Promise.resolve(app.isPackaged ? { central: app.getVersion() } : {});
  return new Promise((resolve) => execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    (err, out) => { const v = updates.installedFromRegistry(out || ''); if (app.isPackaged) v.central = app.getVersion(); resolve(v); }));
}
async function checkUpdates(force) {
  const cached = store.get('updateCheck', null);
  if (!force && cached && Date.now() - cached.at < 6 * 3600 * 1000) return { ...cached.result, installed: await installedVersions(), cached: true };
  const res = await net.fetch(updates.RELEASE_API, { headers: { 'User-Agent': 'Riyeser-Central', Accept: 'application/vnd.github+json' } });
  if (res.status === 404) return { latest: null, updates: [], note: 'No release published yet.' };
  if (!res.ok) throw new Error(`Couldn't check for updates (${res.status}). Try again later.`);
  const release = await res.json();
  let versionsJson = null;
  const vj = (release.assets || []).find((a) => a.name === 'versions.json');
  if (vj) { try { versionsJson = await (await net.fetch(vj.browser_download_url, { headers: { 'User-Agent': 'Riyeser-Central' } })).json(); } catch { /* use the release notes */ } }
  const latest = updates.latestFromRelease(release, versionsJson);
  store.set('updateCheck', { at: Date.now(), result: { latest } });
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
/** Run a downloaded installer quietly and wait for it to finish. */
function runInstaller(file, args, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error(`${name} took too long to install.`)); }, 10 * 60 * 1000);
    child.on('exit', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`${name} installer stopped (code ${code}).`)); });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/** Install a program that isn't on this PC yet, straight from the latest Riyeser release (no trip to the website). */
async function installProgram(id) {
  const product = updates.PRODUCTS.find((x) => x.id === id && !x.self);
  if (!product) throw new Error('Unknown program');
  if (process.platform !== 'win32') throw new Error('Programs install on Windows only.');
  let r = await checkUpdates(false);
  if (!r.latest || !r.latest.products[id]) r = await checkUpdates(true); // a newer release may have added it
  const item = r.latest && r.latest.products[id];
  if (!item) throw new Error(`${product.display} isn't in the latest release yet. Use “Download page” instead.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-install-'));
  const file = path.join(dir, path.basename(new URL(item.url).pathname));
  send('install-progress', { id, stage: 'downloading', pct: 0 });
  await download(item.url, file, (pct) => send('install-progress', { id, stage: 'downloading', pct }));
  send('install-progress', { id, stage: 'installing', pct: 1 });
  await runInstaller(file, product.args, product.display);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ }
  send('install-progress', { id, stage: 'done', pct: 1 });
  return { id, version: item.version };
}

async function installUpdates(ids) {
  const st = await updateStatus(false);
  const todo = st.updates.filter((u) => !ids || ids.includes(u.id)).sort((a, b) => a.self - b.self); // Central last
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyser-update-'));
  const done = [];
  for (const u of todo) {
    const file = path.join(dir, path.basename(new URL(u.url).pathname));
    send('update-progress', { id: u.id, name: u.name, stage: 'downloading', pct: 0 });
    await download(u.url, file, (pct) => send('update-progress', { id: u.id, name: u.name, stage: 'downloading', pct }));
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
    send('update-progress', { id: u.id, name: u.name, stage: 'installing', pct: 1 });
    await runInstaller(file, u.args, u.name);
    done.push(u.id);
  }
  store.set('updateCheck', null);
  return { done, restarting: false };
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
  handle('central:programs', () => programList());
  handle('central:open', async (id, page) => {
    const p = PROGRAMS.find((x) => x.id === id);
    if (!p) throw new Error('Unknown program');
    const exe = locate(p);
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
    const page = { team: 'team', invoices: 'invoices', bookings: 'bookings', 'accounting-basics': 'accounting-basics', accounting: 'accounting', pos: 'pos', payroll: 'payroll', desk: 'desk-assistant', pdf: 'pdf', services: 'services' }[id];
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
    store.update('locations', {}, (l) => ({ ...l, [id]: f }));
    return f;
  });
  handle('central:today', async () => {
    // Each program's information is read only while that program is installed, so a fresh install (or one where a
    // program was removed) never shows old to-dos, balances or documents left behind on the PC.
    const installed = (id) => !!locate(PROGRAMS.find((x) => x.id === id));
    const deskInstalled = installed('desk'); const pdfInstalled = installed('pdf');
    // Demo mode: practice figures only. Money and pay runs come from Accounting's and Payroll's demo records (so the
    // numbers match what those programs show); to-dos and meetings are made up here; real recent files aren't shown.
    const inDemo = demoOn(); const appDataDir = app.getPath('appData');
    if (inDemo) {
      const sample = demo.sampleToday();
      let money = { found: false }; let payroll = { found: false, lastRun: null };
      if (installed('accounting') || installed('accounting-basics')) { try { money = await sources.pendingPayments(demo.demoAccountingDb()); } catch (e) { money = { found: false, error: e.message }; } }
      if (installed('payroll')) { try { payroll = await sources.lastPayRun(demo.demoPayrollDb(appDataDir)); } catch (e) { payroll = { found: false, lastRun: null, error: e.message }; } }
      const tasks = deskInstalled ? sample.tasks : [];
      return { demo: true, deskFound: deskInstalled, calendars: deskInstalled ? 1 : 0, meetings: deskInstalled ? sample.meetings : [], meetingErrors: [], tasks, taskCount: tasks.length, money, recent: [], payroll, organisedRoot: '' };
    }
    const da = deskInstalled ? sources.deskAssistant(deskData()) : { found: false, settings: {}, tasks: [] };
    const open = (da.tasks || []).filter((t) => !t.done);
    const tasks = open.sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9'))).slice(0, 12);
    let meetings = []; let meetingErrors = [];
    const cals = (da.settings && da.settings.calendars) || [];
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
    return { deskFound: da.found, calendars: cals.length, meetings, meetingErrors, tasks, taskCount: open.length, money, recent, payroll, organisedRoot };
  });
  // ---------- licence (one for the whole Riyeser suite; %APPDATA%\Riyeser\licence.json) ----------
  const appData = app.getPath('appData'); const lfetch = (u, o) => net.fetch(u, o);
  handle('central:licence', async () => { const s = licence.status(appData); return s.needsCheck ? licence.recheck(appData, { fetchFn: lfetch }) : s; });
  // The company's plan from Riyeser online: when Central starts, once a day, and on "Check now".
  handle('central:licenceRefresh', async () => { await refreshOnlineLicence(true); return licence.status(appData); });
  handle('central:licenceActivate', (key) => licence.activate(appData, key, { fetchFn: lfetch }));
  handle('central:licenceRemove', () => licence.remove(appData, { fetchFn: lfetch }));
  handle('central:buy', () => shell.openExternal(licence.BUY_URL));
  // ---------- the company this PC belongs to (%APPDATA%\Riyeser\company.json; set up or join online) ----------
  const on = new online.Online({ store, fetchFn: (u, o) => net.fetch(u, o), appData, appVersion: app.getVersion(), deviceName: os.hostname() });
  const companyState = async () => {
    const setup = store.get('company-setup', {}) || {};
    const s = on.session;
    return { company: online.readCompany(appData), onlineReady: await on.ready(), signedIn: s ? s.user.email : null,
      pendingJoin: setup.pendingJoin || null, skipped: !!setup.skipped, unlinked: !!setup.unlinked };
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
  handle('company:get', () => companyState());
  handle('company:signIn', (email, password, create) => on.signIn(String(email || '').trim(), String(password || ''), !!create));
  handle('company:signOut', () => { on.signOut(); return true; });
  handle('company:create', (profile, yourName) => on.createCompany(profile || {}, yourName));
  // After signing in with a Riyeser account: link to its business (one), let them pick (several), or the details form (none)
  const linked = (r) => { if (r && r.company && win && !win.isDestroyed()) win.webContents.send('licence-changed', true); return r; };
  handle('company:afterSignIn', async () => linked(await on.afterSignIn()));
  handle('company:link', async (ws) => linked({ status: 'linked', ...(await on.linkBusiness(String(ws || ''))) }));
  handle('company:details', (f) => { const profile = online.detailsToProfile(f || {}); return on.createCompany(profile, String((f || {}).your_name || '').trim()); });
  handle('company:join', (code, yourName, note) => on.requestJoin(code, yourName, note));
  handle('company:checkJoin', () => on.checkJoin());
  handle('company:cancelJoin', () => { store.update('company-setup', {}, (o) => ({ ...(o || {}), pendingJoin: null })); return true; });
  handle('company:local', (profile, yourName) => on.setupLocal(profile || {}, yourName));
  handle('company:skip', () => { store.update('company-setup', {}, (o) => ({ ...(o || {}), skipped: true })); return true; });
  handle('company:copy', (text) => { clipboard.writeText(String(text || '')); return true; });
  // ---------- demo mode (%APPDATA%\Riyeser\demo.json; every program reads it when it starts) ----------
  const neverSetUp = () => { const setup = store.get('company-setup', {}) || {}; return !online.readCompany(appData) && !setup.skipped; };
  handle('demo:get', () => ({ on: demo.isOn(appData), business: demo.BUSINESS, neverSetUp: neverSetUp() }));
  handle('demo:start', () => { demo.start(appData); return { on: true, business: demo.BUSINESS }; });
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
    return checklist.build({ company, lic, installed, known, names, acc, payroll, kind: businessKind(company),
      members: seats && seats.used != null ? Number(seats.used) : null, skipped: checklist.skippedIds(store), hidden: checklistHidden() });
  });
  // Hide or show the card. Kept on this PC, and with the Riyeser account when signed in (so riyeser.com can follow it).
  handle('central:checklistHide', (hidden) => checklist.setHidden(store, on, !!hidden));
  handle('central:checklistSkip', (id, skip) => checklist.setSkipped(store, id, skip !== false));
  handle('central:updates', (force) => updateStatus(!!force));
  handle('central:installUpdates', (ids) => installUpdates(ids));
  handle('central:install', (id) => installProgram(id));
  // Help: each program's guide in the Riyeser Help Centre.
  handle('central:help', (id) => {
    const guide = { central: 'central', team: 'team', invoices: 'invoices', bookings: 'bookings', 'accounting-basics': 'accounting-basics', accounting: 'accounting', pos: 'pos', payroll: 'payroll', desk: 'desk-assistant', pdf: 'pdf', services: 'services' }[id];
    return shell.openExternal(guide ? `https://riyeser.com/help/${guide}.html` : 'https://riyeser.com/help.html').then(() => true);
  });
  // Team chat: the Riyeser Team app when it's installed (it rings by itself), otherwise Central's own Team window.
  handle('central:team', async () => { const exe = teamApp(); if (exe) { const err = await shell.openPath(exe); if (err) throw new Error(err); return true; } return openTeam(); });
  handle('search:find', (opts) => {
    // Search uses Desk Assistant's file list: nothing (not an old list) when it isn't installed.
    if (!locate(PROGRAMS.find((x) => x.id === 'desk'))) return { total: 0, results: [], facets: { type: {}, year: {}, kind: {} } };
    const da = sources.deskAssistant(deskData());
    return searchIndex().find(opts || {}, { organisedRoot: (da.settings && da.settings.organisedRoot) || '' });
  });
  handle('file:open', async (p) => { if (!fs.existsSync(p)) throw new Error('That file has moved or been deleted. Try searching for it.'); const err = await shell.openPath(p); if (err) throw new Error(err); return true; });
  handle('file:reveal', (p) => { shell.showItemInFolder(p); return true; });
}

// Riyeser Team (team chat) in its own window. It's the online chat at riyeser.com/team, with its sign-in kept
// in its own storage so it stays signed in. Links people send open in the normal web browser.
const TEAM_URL = 'https://riyeser.com/team/';
let teamWin = null; let quitting = false;
// Microphone and camera (for Riyeser Team Calls) and notifications, only for riyeser.com, only in the Team window.
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
// After the first time Team is opened, it keeps running (hidden) while Central is open, so calls can ring.
function teamApp() { try { return locate(PROGRAMS.find((x) => x.id === 'team')); } catch { return null; } }
function openTeam(opts = {}) {
  if (teamWin && !teamWin.isDestroyed()) {
    if (!opts.background) { if (teamWin.isMinimized()) teamWin.restore(); teamWin.show(); teamWin.focus(); }
    return true;
  }
  teamWin = new BrowserWindow({
    width: 1100, height: 760, minWidth: 380, minHeight: 500, title: 'Riyeser Team', show: !opts.background,
    icon: path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon-central.ico' : 'icon-central.png'),
    webPreferences: { session: teamSession(), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  teamWin.removeMenu();
  teamWin.loadURL(TEAM_URL);
  const outside = (url) => { try { const u = new URL(url); return !(u.origin === new URL(TEAM_URL).origin && u.pathname.startsWith('/team/')); } catch { return true; } };
  teamWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  teamWin.webContents.on('will-navigate', (e, url) => { if (outside(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  teamWin.webContents.on('page-title-updated', (_e, title) => {
    if (win && !win.isDestroyed()) win.webContents.send('team:title', title);
    if (/^📞/.test(title) && teamWin && !teamWin.isDestroyed()) {   // an incoming call: bring Team forward
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
  // Closing Central closes the hidden Team window too, so Central really quits.
  win.on('closed', () => { win = null; quitting = true; if (teamWin && !teamWin.isDestroyed()) teamWin.destroy(); });
  // Team was used before: start it quietly in the background so calls can ring.
  let t = null; try { t = store.get('team', null); } catch { /* none yet */ }
  // (not when the Riyeser Team app is installed: it rings by itself, and two windows would ring twice)
  if (t && t.background && !teamApp()) setTimeout(() => openTeam({ background: true }), 4000);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'system';
  store = new Store(path.join(app.getPath('userData'), 'data'));
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
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
