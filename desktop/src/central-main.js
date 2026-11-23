// Riyeser Central: the Riyeser Group home screen. Opens every Riyeser program and shows, like a PA would, what needs
// attention today: meetings, to-dos, money owed and owing, and recent documents, plus one search for every file.
// It only READS the other programs' data, so it can never damage their files.
const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, net } = require('electron');
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
  // Two separate apps that share the same books. The old single "Riyeser Accounting" 1.x counts as Plus.
  { id: 'accounting-basics', name: 'Accounting Basics', full: 'Riyeser Accounting Basics', icon: '📗', desc: 'Invoicing, quotes, customers and stock. Free for your first 500 invoices.',
    dirs: ['Riyeser Accounting Basics'], exes: ['Riyeser Accounting Basics.exe'], links: ['Riyeser Accounting Basics'], pages: ['invoice'] },
  { id: 'accounting', name: 'Accounting Plus', full: 'Riyeser Accounting Plus', icon: '📒', desc: 'Full books: banking, payroll, journals, jobs and budgets. Included in your licence.',
    dirs: ['Riyeser Accounting Plus', 'Riyeser Accounting'], exes: ['Riyeser Accounting Plus.exe', 'Riyeser Accounting.exe'], links: ['Riyeser Accounting Plus', 'Riyeser Accounting'], pages: ['invoice'] },
  // The till on its own. It opens the same company files as Accounting and installs next to it.
  { id: 'pos', name: 'POS', full: 'Riyeser POS', icon: '🧾', desc: 'The till for shops, cafes and restaurants. Free for your first 500 sales.',
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
function launch(exe, args) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
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
    const err = await shell.openPath(exe);
    if (err) throw new Error(err);
    return true;
  });
  // A program that isn't installed yet: its page on riyeser.com, with the download.
  handle('central:get', async (id) => {
    const page = { 'accounting-basics': 'accounting-basics', accounting: 'accounting', pos: 'pos', payroll: 'payroll', desk: 'desk-assistant', pdf: 'pdf', services: 'services' }[id];
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
  handle('central:licenceActivate', (key) => licence.activate(appData, key, { fetchFn: lfetch }));
  handle('central:licenceRemove', () => licence.remove(appData, { fetchFn: lfetch }));
  handle('central:buy', () => shell.openExternal(licence.BUY_URL));
  handle('central:updates', (force) => updateStatus(!!force));
  handle('central:installUpdates', (ids) => installUpdates(ids));
  handle('central:install', (id) => installProgram(id));
  // Help: each program's guide in the Riyeser Help Centre.
  handle('central:help', (id) => {
    const guide = { central: 'central', 'accounting-basics': 'accounting-basics', accounting: 'accounting', pos: 'pos', payroll: 'payroll', desk: 'desk-assistant', pdf: 'pdf', services: 'services' }[id];
    return shell.openExternal(guide ? `https://riyeser.com/help/${guide}.html` : 'https://riyeser.com/help.html').then(() => true);
  });
  handle('search:find', (opts) => {
    // Search uses Desk Assistant's file list: nothing (not an old list) when it isn't installed.
    if (!locate(PROGRAMS.find((x) => x.id === 'desk'))) return { total: 0, results: [], facets: { type: {}, year: {}, kind: {} } };
    const da = sources.deskAssistant(deskData());
    return searchIndex().find(opts || {}, { organisedRoot: (da.settings && da.settings.organisedRoot) || '' });
  });
  handle('file:open', async (p) => { if (!fs.existsSync(p)) throw new Error('That file has moved or been deleted. Try searching for it.'); const err = await shell.openPath(p); if (err) throw new Error(err); return true; });
  handle('file:reveal', (p) => { shell.showItemInFolder(p); return true; });
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
    fs.writeFileSync(out, JSON.stringify({ version: app.getVersion(), programs: programList(), money: { found: money.found, error: money.error || null }, installed: await installedVersions(), updates: upd, licence: licence.status(app.getPath('appData')) }, null, 2));
    app.exit(0);
    return;
  }
  registerIpc();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
