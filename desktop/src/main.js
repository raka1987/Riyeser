// Riyeser Documents (formerly Riyeser Desk Assistant): the office's documents in one library. Scans from the office
// printers and this PC's scanner, uploads and drag-and-drop arrive in the Inbox, get read (OCR for scans) and get a
// suggested folder; one click files them. Browse, search the text inside scans, print, move, recycle and restore,
// with folder access per person and a history of who did what.
//
// The same app id, install folder and program file as Desk Assistant, so installed copies update in place. Its data
// stays in %APPDATA%\Desk Assistant (settings, backups); the library itself lives in a normal folder, by default
// Documents\Riyeser Documents, or a shared office folder chosen in Settings.
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, shell, dialog, nativeImage, nativeTheme, clipboard } = require('electron');
const { registerInstalledApp, runUninstall } = require('./uninstall');
const APP_INFO = { id: 'DeskAssistant', name: 'Riyeser Documents', publisher: 'Riyeser', pdfProgId: 'DeskAssistant.PDF', description: 'Scan, file and find the office\'s documents' };
const NAME = APP_INFO.name;
const path = require('path');
// Keep the data folder from the Desk Assistant days (settings, backups), so nothing is lost by the update.
app.setPath('userData', path.join(app.getPath('appData'), 'Desk Assistant'));
const fs = require('fs');
const os = require('os');
const { Store } = require('./core/store');
const { registerPdfIpc, createEditorWindow, pdfArg } = require('./pdf-ipc');
const { setOcrProvider, setRawExtractor, extractText } = require('./core/extract');
const { createTextPool } = require('./text-pool');
const ocr = require('./core/ocr');
const { readCompany } = require('./core/online');
const demoMode = require('./central/demo');
const { Library } = require('./documents/library');
const { createService } = require('./documents/service');
const { scanFolders, watchScanFolders } = require('./documents/scanfolders');
const scanner = require('./documents/scanner');
const { seedDemo, DEMO_ME } = require('./documents/demo');

let store; let mainWin; let tray; let textPool = null; let library = null; let service = null; let watcher = null; let backups = null;
const demo = (() => { try { return demoMode.isOn(app.getPath('appData')); } catch { return false; } })() || process.env.RIYESER_DEMO === '1';
const dataDir = () => path.join(app.getPath('userData'), 'data');

// ---------- this PC's settings ----------
function knownFolder(name) {
  const fallback = path.join(os.homedir(), name[0].toUpperCase() + name.slice(1));
  try { const real = app.getPath(name); return real && path.resolve(real) !== path.resolve(os.homedir()) && fs.existsSync(real) ? real : fallback; } catch { return fallback; }
}
const defaultRoot = () => path.join(knownFolder('documents'), 'Riyeser Documents');
const settings = () => ({ root: defaultRoot(), theme: 'system', startWithWindows: true, ...store.get('documents', {}) });
const saveSettings = (s) => store.set('documents', s);
function applyTheme(theme) { nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system'; }

/** Who is using this PC: the Riyeser account Central is signed in to, else this Windows user. */
function me() {
  if (demo) return DEMO_ME;
  const c = readCompany(app.getPath('appData'));
  const email = c && String(c.email_signed_in || '').trim().toLowerCase();
  if (email) return { id: `u:${email}`, name: (c.your_name || email).trim(), email, company: c.name };
  let user = 'me'; try { user = os.userInfo().username || 'me'; } catch { /* default */ }
  return { id: `local:${user.toLowerCase()}@${os.hostname().toLowerCase()}`, name: (c && c.your_name) || user, email: '', company: c ? c.name : '' };
}

// ---------- the library ----------
async function openLibrary(root) {
  const cacheDir = path.join(dataDir(), demo ? 'demo-library-cache' : 'library-cache');
  if (demo) { library = await seedDemo(path.join(dataDir(), 'demo', 'Riyeser Documents'), { cacheDir }); return library; }
  const lib = new Library({ root, cacheDir, me: me(), settings: {} });
  // A folder on this PC is made if needed; a network folder must already be there (we never guess at servers)
  const network = /^\\\\/.test(root);
  if (!network || lib.online()) { try { lib.ensureLayout(); } catch (e) { console.warn('library layout', e.message); } }
  library = lib;
  return lib;
}
/** Settings › Library: switch to another folder (e.g. \\OFFICE-PC\Riyeser Documents). */
async function reopen(root) {
  if (!root) throw new Error('Choose or type the folder.');
  const network = /^\\\\/.test(root);
  if (network && !fs.existsSync(root)) throw new Error(`Can't reach ${root}. Check the PC name and the share name, and that this Windows user can open it in File Explorer.`);
  if (!network && !path.isAbsolute(root)) throw new Error('Type the full folder path, for example C:\\Users\\you\\Documents\\Riyeser Documents.');
  saveSettings({ ...settings(), root });
  await openLibrary(root);
  startWatching();
  return { root: library.root, online: library.online() };
}

// ---------- reading documents (OCR for scans) ----------
let ocrWin = null;
async function ocrRenderer() {
  if (ocrWin && !ocrWin.isDestroyed()) return ocrWin;
  ocrWin = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await ocrWin.loadFile(path.join(__dirname, 'renderer', 'ocr-render.html'));
  for (let i = 0; i < 50 && !(await ocrWin.webContents.executeJavaScript('!!window.ocrReady')); i++) await new Promise((r) => setTimeout(r, 100));
  return ocrWin;
}
setOcrProvider({
  pdf: async (file) => {
    const win = await ocrRenderer();
    const pages = await win.webContents.executeJavaScript(`window.renderPdf(${JSON.stringify(file)}, 3)`);
    const texts = [];
    for (const dataUrl of pages) texts.push((await ocr.recognize(Buffer.from(dataUrl.split(',')[1], 'base64'))).text);
    return texts.join('\n');
  },
  image: async (file) => (/\.(heic|webp)$/i.test(file) ? '' : (await ocr.recognize(await fs.promises.readFile(file))).text),
});

// ---------- printing ----------
async function printFiles(files, { printer = '', copies = 1 } = {}) {
  const pages = [];
  for (const f of files) {
    if (/\.pdf$/i.test(f)) pages.push(...await (await ocrRenderer()).webContents.executeJavaScript(`window.renderPdf(${JSON.stringify(f)}, 200, { dpi: 150, format: 'jpeg', quality: 0.9 })`));
    else if (/\.(jpe?g|png|gif|bmp|webp)$/i.test(f)) pages.push(`data:image/${/\.png$/i.test(f) ? 'png' : 'jpeg'};base64,${(await fs.promises.readFile(f)).toString('base64')}`);
    else { await shell.openPath(f); throw new Error(`${path.basename(f)} opened in its own program: print it from there.`); }
  }
  const html = `<!doctype html><meta charset="utf-8"><style>@page{margin:0}body{margin:0}img{display:block;width:100%;page-break-after:always}img:last-child{page-break-after:auto}</style>${pages.map((p) => `<img src="${p}">`).join('')}`;
  const tmp = path.join(os.tmpdir(), `riyeser-documents-print-${Date.now()}.html`);
  fs.writeFileSync(tmp, html);
  const w = new BrowserWindow({ show: false });
  try {
    await w.loadFile(tmp);
    await new Promise((resolve, reject) => w.webContents.print({ silent: !!printer, deviceName: printer || undefined, copies: Math.max(1, Math.min(99, +copies || 1)), printBackground: true },
      (ok, reason) => (ok ? resolve() : reject(new Error(reason === 'cancelled' ? 'Printing cancelled.' : `The printer didn't take it (${reason}).`)))));
  } finally { setTimeout(() => { try { w.destroy(); } catch { /* gone */ } fs.rmSync(tmp, { force: true }); }, 1500); }
}

// ---------- scanning from this PC ----------
async function scanFromPc({ dept = null } = {}) {
  const dir = path.join(app.getPath('temp'), 'riyeser-documents-scans');
  fs.mkdirSync(dir, { recursive: true });
  const r = await scanner.scanWithWia({ outDir: dir });
  if (r.ok) { const pdf = r.file.replace(/\.jpg$/i, '.pdf'); await scanner.imageToPdf(r.file, pdf); fs.rmSync(r.file, { force: true }); return { ok: true, file: pdf }; }
  if (r.reason === 'cancelled') return r;
  // No WIA scanner: Windows Fax and Scan, saving into the scan folder (it lands in the Inbox from there)
  const saveTo = library ? path.join(library.root, '_Scans', dept || (library.departments()[0] || 'Admin')) : '';
  const opened = scanner.openFaxAndScan();
  return { ...r, fallback: opened ? 'wfs' : 'none', saveTo };
}

// ---------- other Riyeser programs (phase 1: open them; linking documents to records comes later) ----------
const PROGRAMS = {
  accounting: { name: 'Riyeser Accounting', dirs: ['Riyeser Accounting Plus', 'Riyeser Accounting Basics', 'Riyeser Accounting'], exes: ['Riyeser Accounting Plus.exe', 'Riyeser Accounting Basics.exe', 'Riyeser Accounting.exe'] },
  payroll: { name: 'Riyeser Payroll', dirs: ['riyeser-payroll', 'Riyeser Payroll'], exes: ['Riyeser Payroll.exe'] },
  bookings: { name: 'Riyeser Bookings', dirs: ['Riyeser Bookings'], exes: ['Riyeser Bookings.exe'] },
};
function openProgram(id) {
  const p = PROGRAMS[id]; if (!p) return { opened: false };
  const roots = [path.join(process.env.LOCALAPPDATA || '', 'Programs'), process.env.ProgramW6432, process.env.ProgramFiles].filter(Boolean);
  for (const r of roots) for (const d of p.dirs) for (const e of p.exes) {
    const f = path.join(r, d, e);
    if (fs.existsSync(f)) { require('child_process').spawn(f, [], { detached: true, stdio: 'ignore', cwd: path.dirname(f) }).unref(); return { opened: true, name: p.name }; }
  }
  return { opened: false, name: p.name };
}

// ---------- Central's search (it reads this file; same shape as Desk Assistant's search list) ----------
let mirrorTimer = null;
function mirrorSoon() {
  if (demo) return;
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    try {
      const out = {};
      for (const d of library.docs()) {
        if (d.status === 'deleted' || d.private) continue;
        const p = library.docPath(d);
        out[p] = { name: d.name, dir: path.dirname(p), ext: d.ext, mtime: Date.parse(d.added) || 0, size: d.size, text: String(d.text || '').slice(0, 6000), company: d.company || null, docType: d.docType || null, year: String(d.added || '').slice(0, 4) };
      }
      store.set('index', out);
    } catch { /* offline: try again next time */ }
  }, 3000);
}

// ---------- windows ----------
function iconPath() { return path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon.ico' : 'icon.png'); }
const send = (ch, data) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, data); };
let changedTimer = null;
const changed = () => { clearTimeout(changedTimer); changedTimer = setTimeout(() => send('docs-changed'), 150); mirrorSoon(); };
let splashWin = null;
function showSplash() {
  try {
    splashWin = new BrowserWindow({ width: 420, height: 220, frame: false, resizable: false, show: true, center: true, title: NAME, icon: iconPath(), webPreferences: { contextIsolation: true, nodeIntegration: false } });
    splashWin.removeMenu(); splashWin.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  } catch { splashWin = null; }
}
const closeSplash = () => { if (splashWin && !splashWin.isDestroyed()) splashWin.close(); splashWin = null; };
function createMain() {
  mainWin = new BrowserWindow({ width: 1360, height: 860, minWidth: 360, minHeight: 560, title: NAME, icon: iconPath(), show: false, backgroundColor: '#f3f5fa',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWin.removeMenu();
  mainWin.once('ready-to-show', () => { mainWin.show(); closeSplash(); });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'documents.html'));
  mainWin.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); } });
}
function showMain() { if (!mainWin || mainWin.isDestroyed()) createMain(); mainWin.show(); mainWin.focus(); }
const openEditor = (file, task = null) => createEditorWindow(file, { store, task, icon: path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon-pdf.ico' : 'icon-pdf.png') });

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message }; }
  });
}

function makeService() {
  return createService({
    lib: () => library, me, demo, version: app.getVersion(), computer: os.hostname(), defaultRoot: defaultRoot(),
    settings, saveSettings, applyTheme, changed, reopen,
    processSoon: () => setTimeout(() => processNow(), 300),
    pickFiles: async () => (await dialog.showOpenDialog(mainWin, { title: 'Upload documents', properties: ['openFile', 'multiSelections'] })).filePaths,
    pickFolder: async () => (await dialog.showOpenDialog(mainWin, { title: 'Choose the library folder', properties: ['openDirectory', 'createDirectory'] })).filePaths[0],
    openPath: async (p) => { const err = await shell.openPath(p); if (err) throw new Error(err); return true; },
    reveal: (p) => { shell.showItemInFolder(p); return true; },
    openPdf: (p) => { openEditor(p); return true; },
    printers: async () => (mainWin ? (await mainWin.webContents.getPrintersAsync()).map((p) => ({ name: p.name, label: p.displayName || p.name, isDefault: !!p.isDefault })) : []),
    print: printFiles,
    scan: scanFromPc,
    openScanFolder: async (dir) => { fs.mkdirSync(dir, { recursive: true }); await shell.openPath(dir); return true; },
    openProgram, openUrl: (u) => shell.openExternal(u), copy: (t) => { clipboard.writeText(t); return true; },
    extractText,
  });
}

// ---------- background work ----------
let processing = false;
async function processNow() {
  if (processing || !service) return;
  processing = true;
  try { while ((await service.processPending({ limit: 5 })) > 0) { /* keep going while there's more */ } }
  catch (e) { console.warn('reading documents', e.message); } finally { processing = false; }
}
function startWatching() {
  if (watcher) watcher.stop();
  watcher = watchScanFolders({
    getFolders: () => (library && library.online() ? scanFolders(library.root, library.departments()) : []),
    onFile: async (file, f) => {
      library.addFile(file, { move: true, trusted: true, source: f.source, sourceLabel: f.source === 'email' ? 'Email' : 'Office printer', deptHint: f.dept }, me());
      changed(); processNow();
      if (Notification.isSupported() && (!mainWin || !mainWin.isVisible())) {
        const n = new Notification({ title: 'New scan in the Inbox', body: `${path.basename(file)}${f.dept ? ` (for ${f.dept})` : ''}`, icon: iconPath() });
        n.on('click', showMain); n.show();
      }
    },
  });
}
let wasOnline = null;
function housekeeping() {
  if (!library) return;
  const on = library.online();
  if (on !== wasOnline) { wasOnline = on; send('docs-changed'); }
  if (!on) return;
  try { const r = library.reconcile(); if (r.added.length || r.removed.length) { changed(); processNow(); } } catch (e) { console.warn('reconcile', e.message); }
  try { if (library.purge().length) changed(); } catch { /* next time */ }
}

// ---------- start ----------
// A check for the Windows build workflow: makes a library in a temp folder, adds and files a document, and writes the
// result (and that the scanner script is there) to the given file, then quits.
const selfTest = (process.argv.find((a) => a.startsWith('--self-test=')) || '').slice('--self-test='.length);
async function runSelfTest(file) {
  const out = { name: NAME, version: app.getVersion(), ok: false };
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-documents-test-'));
    const lib = new Library({ root, cacheDir: path.join(root, '.cache'), me: { id: 'local:test', name: 'Test' } });
    lib.ensureLayout();
    const src = path.join(root, 'BSP statement.txt'); fs.writeFileSync(src, 'Bank South Pacific statement of account. Opening balance 100.');
    const doc = lib.addFile(src, { source: 'upload' });
    lib.setText(doc.id, await extractText(lib.docPath(lib.doc(doc.id))));
    const s = lib.doc(doc.id).suggestion;
    const filed = lib.fileDoc(doc.id, s.folder);
    out.suggestion = s.folder; out.filed = fs.existsSync(lib.docPath(filed));
    out.scannerScriptPath = scanner.scriptFile(root); out.scannerScript = fs.existsSync(out.scannerScriptPath);
    out.departments = lib.departments();
    out.ok = out.filed && /^Accounts\/Bank statements\/\d{4}$/.test(s.folder) && out.scannerScript;
  } catch (e) { out.error = e.message; }
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
}

const uninstalling = process.argv.includes('--uninstall');
if (!selfTest && !app.requestSingleInstanceLock({ exe: process.execPath })) app.exit(0);
app.on('second-instance', (_e, argv) => {
  if (argv.includes('--uninstall')) { runUninstall(APP_INFO); return; }
  const pdf = pdfArg(argv); if (pdf) openEditor(pdf); else showMain();
});

app.whenReady().then(async () => {
  if (selfTest) { await runSelfTest(selfTest); app.exit(0); return; }
  if (uninstalling) { await runUninstall(APP_INFO); app.quit(); return; }
  const hidden = process.argv.includes('--hidden');
  if (!pdfArg(process.argv) && !hidden) showSplash();
  // OWNER-BACKUP: a restore asked for before the restart is done now, before anything opens the data
  backups = require('./core/backup-ui').backupUi({ app, dialog, shell, name: NAME, win: () => mainWin,
    spec: require('./core/backup-specs').programSpec('desk', { appData: app.getPath('appData') }) });
  const freshPc = !fs.existsSync(path.join(dataDir(), 'settings.json')) && !fs.existsSync(path.join(dataDir(), 'documents.json'));
  await backups.applyPending().catch(() => null);
  store = new Store(dataDir());
  if (!store.get('documents', null)) saveSettings(settings()); // also tells Riyeser Central this is Documents now
  applyTheme(settings().theme);
  registerInstalledApp(APP_INFO).catch(() => {});
  ocr.configure({ cacheDir: path.join(app.getPath('userData'), 'ocr') });
  try { textPool = createTextPool({ log: (m) => console.warn(m) }); setRawExtractor(textPool.extract); } catch (e) { console.warn('file reader unavailable', e.message); }
  await openLibrary(settings().root);
  service = makeService();
  for (const [ch, fn] of Object.entries(service)) if (ch.includes(':')) handle(ch, fn);
  handle('docs:pathForFiles', (paths) => paths); // drag-and-drop paths come from the preload
  handle('backup:status', () => backups.status());
  handle('backup:now', async () => (await backups.backUpNow({ quiet: true })).file);
  handle('backup:restore', () => backups.restoreFromBackup());
  handle('backup:folder', () => backups.openFolder().then(() => true));
  handle('app:uninstall', () => runUninstall(APP_INFO));
  handle('help:open', () => shell.openExternal('https://riyeser.com/help/').then(() => true));
  registerPdfIpc({ handle, store, openEditor, getTheme: () => settings().theme || 'system', setTheme: (t) => { saveSettings({ ...settings(), theme: t }); applyTheme(t); } });

  const startPdf = pdfArg(process.argv);
  if (startPdf) openEditor(startPdf); else if (!hidden) createMain();
  // Keep running in the background so printer scans arrive in the Inbox; start with Windows (hidden) unless turned off
  if (app.isPackaged && process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: settings().startWithWindows !== false, args: ['--hidden'] });

  if (process.platform === 'win32') tray = new Tray(path.join(__dirname, 'renderer', 'icon.ico'));
  else { const img = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png')); tray = new Tray(img.isEmpty() ? img : img.resize({ width: 18, height: 18, quality: 'best' })); }
  tray.setToolTip(NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${NAME}`, click: () => showMain() },
    { type: 'separator' },
    ...backups.menuItems(),
    { type: 'separator' },
    { label: `Quit ${NAME}`, click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMain());

  backups.startDaily();
  if (backups.pendingResult) setTimeout(() => backups.showPendingResult(), 1500);
  else if (freshPc && !hidden && !startPdf && !demo) setTimeout(() => backups.firstRunOffer().catch(() => {}), 1500);

  startWatching();
  setTimeout(() => { housekeeping(); processNow(); mirrorSoon(); }, 1500);
  setInterval(housekeeping, 60_000);
  setInterval(() => processNow(), 20_000);
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep running in the tray (scans keep arriving)
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { if (textPool) textPool.stop(); if (watcher) watcher.stop(); });
