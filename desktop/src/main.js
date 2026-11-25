// Electron main process: windows, tray icon, global search shortcut, background jobs and reminders.
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, Notification, shell, dialog, safeStorage, nativeImage, nativeTheme } = require('electron');
const { registerInstalledApp, runUninstall } = require('./uninstall');
const APP_INFO = { id: 'DeskAssistant', name: 'Riyeser Desk Assistant', publisher: 'Riyeser Group', pdfProgId: 'DeskAssistant.PDF', description: 'Riyeser Group: your files, folders, meetings and PDFs' };
const path = require('path');
// Keep using the data folder from before the Riyeser name (settings, move history, learned folders), so nothing is lost.
app.setPath('userData', path.join(app.getPath('appData'), 'Desk Assistant'));
const fs = require('fs');
const os = require('os');
const { Store } = require('./core/store');
const { Index } = require('./core/indexer');
const organizer = require('./core/organizer');
const { upcomingMeetings, companiesInMeeting } = require('./core/calendar');
const { fetchAndSort } = require('./core/email');
const { extractActionItems } = require('./core/actions');
const { createAI, MODELS: AI_MODELS, DEFAULT_MODEL: AI_DEFAULT } = require('./core/ai');
const { analyseFolder } = require('./core/cleanup');
const safety = require('./core/safety');
const { planEverything, removeEmptiedFolders } = require('./core/everything');
const learn = require('./core/learn');
const { reviewFiles } = require('./core/review');
const rules = require('./core/rules');
const { extractDetails } = require('./core/details');
const { registerPdfIpc, createEditorWindow, pdfArg } = require('./pdf-ipc');
const { setOcrProvider, setTextCache, setRawExtractor } = require('./core/extract');
const { createTextPool } = require('./text-pool');
let textPool = null;
const ocr = require('./core/ocr');

const HOTKEY = 'CommandOrControl+Shift+Space';
let store, index, mainWin, searchWin, tray;
const state = { meetings: [], meetingErrors: [], emails: [], lastPlan: null, notified: new Set(), busy: {} };

// ---------- settings ----------
// Windows often moves Desktop/Documents into OneDrive (C:\Users\you\OneDrive\Desktop). Ask Windows for the real locations.
function knownFolder(name) {
  const fallback = path.join(os.homedir(), name[0].toUpperCase() + name.slice(1));
  let real;
  try { real = app.getPath(name); } catch { return fallback; }
  // Never treat the whole home folder (or a missing folder) as Desktop/Downloads/Documents.
  if (!real || path.resolve(real) === path.resolve(os.homedir()) || !fs.existsSync(real)) return fallback;
  return real;
}
function defaults() {
  const existing = (p) => fs.existsSync(p) ? [p] : [];
  const desktop = knownFolder('desktop'); const downloads = knownFolder('downloads'); const documents = knownFolder('documents');
  return {
    ownCompanyNames: [],
    companies: [],
    companyTypes: ['Clients', 'Suppliers', 'Government', 'Banks', 'Utilities', 'Personal'],
    watchFolders: [...existing(downloads), ...existing(desktop)],
    organisedRoot: path.join(documents, 'Organised'),
    searchFolders: [...existing(documents), ...existing(downloads), ...existing(desktop)],
    sortEverything: true,
    libraryFolders: [desktop, downloads, documents, knownFolder('pictures'), knownFolder('videos'), knownFolder('music')].filter((f, i, a) => fs.existsSync(f) && a.indexOf(f) === i),
    neverTouch: [],
    recursiveScan: false,
    renameFiles: false,
    groupByYear: false,
    filingLayout: 'typeYear', // 'typeYear': Invoices\2026 · 'company': Clients\Acme\Invoices
    nameStyle: 'keep',        // 'keep' | 'date' | 'full'
    dayFirstDates: true,
    staleDays: 90,
    groupRelated: true,
    ocrPdfs: true,
    ocrImages: false,
    autoOrganise: false,
    calendars: [],
    reminderMinutes: 10,
    email: { host: '', port: 993, secure: true, user: '', mailbox: 'INBOX', saveAttachments: true },
    aiModel: AI_DEFAULT,   // M26: the cheapest model; Settings -> AI lets people choose
    onboarded: false,
  };
}
/** Earlier versions assumed C:\Users\you\Desktop etc. If Windows keeps them elsewhere (OneDrive), switch to the real ones. */
function fixFolderLocations() {
  const saved = store.get('settings', null);
  if (!saved) return;
  const home = os.homedir();
  const swap = {};
  for (const name of ['desktop', 'downloads', 'documents']) {
    const naive = path.join(home, name[0].toUpperCase() + name.slice(1));
    const real = knownFolder(name);
    if (real && real !== naive) swap[naive] = real;
  }
  if (!Object.keys(swap).length) return;
  const fix = (p) => {
    for (const [from, to] of Object.entries(swap)) if (p === from || p.startsWith(from + path.sep)) return to + p.slice(from.length);
    return p;
  };
  const uniq = (a) => [...new Set(a)];
  store.set('settings', {
    ...saved,
    watchFolders: uniq((saved.watchFolders || []).map(fix)),
    searchFolders: uniq((saved.searchFolders || []).map(fix)),
    // keep the Organised folder where it is if files were already filed there
    organisedRoot: saved.organisedRoot && fs.existsSync(saved.organisedRoot) ? saved.organisedRoot : fix(saved.organisedRoot || ''),
  });
}

const getSettings = () => {
  const s = { ...defaults(), ...store.get('settings', {}) };
  // M26: earlier versions saved the most expensive model as the default without anyone choosing it
  if (!s.aiModelChosen) s.aiModel = AI_DEFAULT;
  return s;
};
function setSettings(s) {
  const clean = { ...s };
  delete clean.emailPassword; delete clean.aiKey; // secrets are stored separately, encrypted
  return store.set('settings', clean);
}

// Secrets (email password, AI key) are encrypted with the OS keychain via safeStorage.
function setSecret(name, value) {
  const secrets = store.get('secrets', {});
  if (!value) delete secrets[name];
  else secrets[name] = safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(value).toString('base64') } : { plain: value };
  store.set('secrets', secrets);
}
function getSecret(name) {
  const s = store.get('secrets', {})[name];
  if (!s) return '';
  try { return s.enc ? safeStorage.decryptString(Buffer.from(s.enc, 'base64')) : s.plain; } catch { return ''; }
}
const ai = () => createAI(getSecret('aiKey'), getSettings().aiModel);

// ---------- tasks / needs-attention ----------
function addTasks(items) {
  if (!items.length) return;
  store.update('tasks', [], (tasks) => {
    const keys = new Set(tasks.map((t) => t.text.toLowerCase()));
    for (const it of items) {
      if (keys.has(it.text.toLowerCase())) continue;
      keys.add(it.text.toLowerCase());
      tasks.push({ id: Math.random().toString(36).slice(2), done: false, created: new Date().toISOString(), ...it });
    }
    return tasks;
  });
  send('tasks-changed');
}

function send(channel, payload) {
  for (const w of [mainWin, searchWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
}

// ---------- background jobs ----------
async function refreshIndex() {
  if (state.busy.index) return;
  state.busy.index = true;
  try {
    const s = getSettings();
    const folders = [...new Set([...s.searchFolders, ...s.watchFolders, s.organisedRoot])].filter((f) => fs.existsSync(f));
    await index.rebuild(folders, s, (done, total) => send('index-progress', { done, total }));
    // Meeting notes in organised folders feed the to-do list
    for (const [p, d] of Object.entries(index.docs)) {
      if (d.docType === 'Meeting Notes' && d.text) addTasks(extractActionItems(d.text, { source: 'notes', file: p }));
    }
  } finally { state.busy.index = false; send('index-progress', { done: 1, total: 1, finished: true, size: index.size }); }
}

async function refreshMeetings() {
  const s = getSettings();
  if (!s.calendars.length) { state.meetings = []; return; }
  const { meetings, errors } = await upcomingMeetings(s.calendars, { days: 14 });
  for (const m of meetings) {
    m.companies = companiesInMeeting(m, s.companies).map((c) => c.name);
    m.relatedFiles = m.companies.flatMap((c) => index.byCompany(c, 5));
    m.openTasks = store.get('tasks', []).filter((t) => !t.done && m.companies.some((c) => t.text.toLowerCase().includes(c.toLowerCase())));
  }
  state.meetings = meetings;
  state.meetingErrors = errors;
  send('meetings-changed');
}

function checkReminders() {
  const mins = getSettings().reminderMinutes || 10;
  const now = Date.now();
  for (const m of state.meetings) {
    const until = (new Date(m.start) - now) / 60000;
    if (m.allDay || until < 0 || until > mins || state.notified.has(m.id)) continue;
    state.notified.add(m.id);
    const extra = [];
    if (m.actionItems.length) extra.push(`${m.actionItems.length} item(s) to check`);
    if (m.relatedFiles?.length) extra.push(`${m.relatedFiles.length} related file(s)`);
    notify(`In ${Math.round(until)} min: ${m.title}`, extra.join(' · ') || m.location || 'Starting soon', () => showMain('meetings'));
  }
}

// ---------- learning where you file things ----------
// Paths the app itself moved files to. Anything else in your Organised folder, you put there yourself.
function placedByApp() {
  let placed = store.get('placedByApp', null);
  if (!placed) placed = store.set('placedByApp', store.get('history', []).flatMap((b) => b.moves.map((m) => m.to)));
  return new Set(placed);
}
/**
 * Remember every move the app makes (old address -> new address), so a file can always be found from its old address:
 * from a list that's out of date, or by searching its old name.
 */
function recordMoves(batch, { byApp = true } = {}) {
  const moves = (batch && batch.moves) || [];
  if (!moves.length) return;
  store.update('movedLog', {}, (log) => {
    for (const m of moves) log[m.from] = m.to;
    const keys = Object.keys(log);
    for (const k of keys.slice(0, Math.max(0, keys.length - 30000))) delete log[k];
    return log;
  });
  if (byApp) store.set('placedByApp', [...placedByApp(), ...moves.map((m) => m.to)].slice(-50000));
  if (index) {
    for (const m of moves) {
      const d = index.docs[m.from];
      if (!d) continue;
      delete index.docs[m.from];
      const formerNames = [...new Set([...(d.formerNames || []), d.name])].filter((n) => n !== path.basename(m.to)).slice(-5);
      index.docs[m.to] = { ...d, name: path.basename(m.to), dir: path.dirname(m.to), formerNames };
    }
    index.save();
  }
}
/** Where is this file now? Follows the app's own moves (including whole folders that were moved). */
function whereNow(p) {
  if (!p || fs.existsSync(p)) return p;
  // Undo history (oldest first, so the latest move wins), then the full move log on top.
  const log = {};
  for (const b of [...store.get('history', [])].reverse()) for (const m of b.moves) log[m.from] = m.to;
  Object.assign(log, store.get('movedLog', {}));
  let cur = p;
  for (let hop = 0; hop < 25 && !fs.existsSync(cur); hop++) {
    if (log[cur]) { cur = log[cur]; continue; }
    // the file may have been inside a folder that moved
    let dir = path.dirname(cur); let rest = path.basename(cur); let found = false;
    while (dir && dir !== path.dirname(dir)) {
      if (log[dir]) { cur = path.join(log[dir], rest); found = true; break; }
      rest = path.join(path.basename(dir), rest); dir = path.dirname(dir);
    }
    if (!found) break;
  }
  return fs.existsSync(cur) ? cur : null;
}
const movedMessage = (p) => `“${path.basename(p)}” isn't at that address any more and I couldn't find where it went. Try searching for it (Ctrl+Shift+Space) - old names work too.`;

/** Examples of where you like things: folders you chose + files you put in Organised yourself (read from the search index). */
function buildExamples(s) {
  const examples = [...store.get('learned', [])];
  const root = s.organisedRoot;
  const placed = placedByApp();
  let n = 0;
  for (const [p, d] of Object.entries(index.docs)) {
    if (!p.startsWith(root + path.sep) || placed.has(p) || organizer.inArchive(p, root) || n > 4000) continue;
    examples.push(learn.makeExample({ name: d.name, text: d.text, company: d.company, docType: d.docType, ext: d.ext }, path.dirname(p), root));
    n++;
  }
  return examples;
}
const planSettings = () => { const s = getSettings(); return { ...s, _examples: buildExamples(s), _placedByApp: placedByApp(), _rules: store.get('rules', []).filter((r) => r.enabled !== false) }; };

/** Remove folders left empty by a move (never your main folders themselves; Undo recreates them). */
function tidyEmptied(batch) {
  const s = getSettings();
  removeEmptiedFolders(batch, [s.organisedRoot, ...s.watchFolders, ...(s.libraryFolders || []), ...s.searchFolders]);
}

/** Files (from the search index) that match a rule but aren't in its folder yet. */
function filesMatchingRule(rule) {
  const s = getSettings();
  const out = [];
  for (const [p, d] of Object.entries(index.docs)) {
    if (!fs.existsSync(p) || safety.isProtectedFile(p)) continue;
    const item = { name: d.name, text: d.text, company: d.company, docType: d.docType, ext: d.ext,
      details: extractDetails(d.text || '', d.name, { dayFirst: s.dayFirstDates !== false }), fileDate: new Date(d.mtime).toISOString().slice(0, 10) };
    if (!rules.ruleMatches(rule, item)) continue;
    const dir = rules.ruleFolder(rule, item, s.organisedRoot);
    if (path.resolve(dir).toLowerCase() === path.resolve(path.dirname(p)).toLowerCase()) continue;
    out.push({ from: p, name: d.name, currentDir: path.dirname(p), dir, to: path.join(dir, d.name) });
    if (out.length >= 2000) break;
  }
  return out;
}

async function scanInbox({ quiet = false } = {}) {
  const s = planSettings();
  const result = await organizer.planOrganise(s, { ai: ai(), onProgress: (i, n) => send('scan-progress', { i, n }) });
  state.lastPlan = result;
  if (s.autoOrganise) {
    const sure = result.plan.filter((p) => p.confidence === 'high' || p.category === 'Media');
    if (sure.length) {
      const batch = organizer.applyPlan(sure);
      store.update('history', [], (h) => [batch, ...h].slice(0, 2000));
      recordMoves(batch);
      if (!quiet || batch.moves.length) notify('Files tidied', `Filed ${batch.moves.length} file(s). Open the app to review or undo.`, () => showMain('organise'));
      state.lastPlan = { ...result, plan: result.plan.filter((p) => !sure.includes(p)) };
    }
  } else if (quiet && result.plan.length + result.review.length >= 5) {
    notify('Time for a tidy-up?', `${result.plan.length + result.review.length} files are waiting in your folders.`, () => showMain('organise'));
  }
  send('plan-changed');
  return state.lastPlan;
}

async function refreshEmail() {
  const s = getSettings();
  const password = getSecret('emailPassword');
  if (!s.email.host || !s.email.user || !password) throw new Error('Email is not set up yet (Settings → Email).');
  const saved = [];
  state.emails = await fetchAndSort({ ...s.email, password }, s, {
    onAttachment: async (att, msg, sorted) => {
      if (!s.email.saveAttachments || !sorted.company || !['Invoices & Bills', 'Receipts'].includes(sorted.category)) return;
      const dir = organizer.targetDir(s.organisedRoot, { category: 'Company', company: sorted.company, companyType: (s.companies.find((c) => c.name === sorted.company) || {}).type || 'Companies', docType: sorted.docType || 'Invoices' });
      const dest = path.join(dir, att.filename.replace(/[<>:"/\\|?*]/g, '_'));
      if (fs.existsSync(dest)) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, att.content);
      saved.push(dest);
    },
  });
  addTasks(state.emails.filter((e) => e.actionItems.length).flatMap((e) => e.actionItems.map((a) => ({ ...a, from: e.from, subject: e.subject }))));
  if (saved.length) notify('Attachments filed', `Saved ${saved.length} invoice/receipt attachment(s) into company folders.`);
  send('emails-changed');
  return { emails: state.emails, saved };
}

// ---------- windows ----------
function showMain(page) {
  if (!mainWin || mainWin.isDestroyed()) createMain();
  mainWin.show(); mainWin.focus();
  if (page) mainWin.webContents.send('navigate', page);
}

// M8: the first start on a new PC can take several seconds (Windows checks every new file). A small "Getting things
// ready…" window shows straight away, and closes when the main window is ready.
let splashWin = null;
function showSplash() {
  try {
    splashWin = new BrowserWindow({ width: 420, height: 220, frame: false, resizable: false, show: true, center: true, skipTaskbar: false,
      title: 'Riyeser Desk Assistant', icon: iconPath(), webPreferences: { contextIsolation: true, nodeIntegration: false } });
    splashWin.removeMenu();
    splashWin.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  } catch { splashWin = null; }
}
function closeSplash() { if (splashWin && !splashWin.isDestroyed()) splashWin.close(); splashWin = null; }

function createMain() {
  mainWin = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600, title: 'Riyeser Desk Assistant', icon: iconPath(), show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.removeMenu();
  mainWin.once('ready-to-show', () => { mainWin.show(); closeSplash(); });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); } });
}

function toggleSearch() {
  if (!searchWin || searchWin.isDestroyed()) {
    searchWin = new BrowserWindow({
      width: 720, height: 460, frame: false, resizable: false, show: false, alwaysOnTop: true, skipTaskbar: true, transparent: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    searchWin.loadFile(path.join(__dirname, 'renderer', 'search.html'));
    searchWin.on('blur', () => searchWin.hide());
    searchWin.once('ready-to-show', () => { searchWin.center(); searchWin.show(); });
    return;
  }
  if (searchWin.isVisible()) searchWin.hide();
  else { searchWin.center(); searchWin.show(); searchWin.focus(); searchWin.webContents.send('search-focus'); }
}

function folderRoots() {
  const s = getSettings();
  const list = [
    { path: s.organisedRoot, name: 'Organised', icon: '🗂' },
    ...s.watchFolders.map((f) => ({ path: f, name: path.basename(f), icon: /desktop$/i.test(f) ? '🖥' : /downloads$/i.test(f) ? '⬇' : '📁' })),
    ...(s.libraryFolders || []).map((f) => ({ path: f, name: path.basename(f), icon: /documents$/i.test(f) ? '📄' : /pictures$/i.test(f) ? '🖼' : /videos$/i.test(f) ? '🎞' : /music$/i.test(f) ? '🎵' : '📁' })),
    ...s.searchFolders.map((f) => ({ path: f, name: path.basename(f), icon: '📁' })),
  ];
  const seen = new Set();
  return list.filter((r) => r.path && fs.existsSync(r.path) && !safety.isSystemPath(r.path) && !seen.has(r.path) && seen.add(r.path))
    .map((r) => ({ ...r, hasDirs: hasSubfolders(r.path) }));
}
/** Every folder under the roots (cached for a minute so typing in the search box stays fast). */
let folderCache = { at: 0, key: '', list: [] };
function allFolders(roots) {
  const key = roots.map((r) => r.path).join('|');
  if (folderCache.key === key && Date.now() - folderCache.at < 60_000) return folderCache.list;
  const list = [];
  const seen = new Set(roots.map((r) => path.resolve(r.path).toLowerCase())); // a root inside another root (Organised in Documents) is listed once
  for (const r of roots) {
    const walk = (dir, depth, rel) => {
      if (depth > 10 || list.length > 40000) return;
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$')) continue;
        const full = path.join(dir, e.name);
        if (safety.isSystemPath(full)) continue;
        const key = path.resolve(full).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const r2 = `${rel} › ${e.name}`;
        list.push({ name: e.name, path: full, rel: r2, parent: rel, depth, root: r.name });
        walk(full, depth + 1, r2);
      }
    };
    walk(r.path, 0, r.name);
  }
  folderCache = { at: Date.now(), key, list };
  return list;
}

function hasSubfolders(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')); } catch { return false; }
}

// ---------- OCR for scanned documents ----------
let ocrWin = null;
const dbg = process.env.DA_DEBUG ? (...a) => console.log('[ocr]', ...a) : () => {};
async function ocrRenderer() {
  if (ocrWin && !ocrWin.isDestroyed()) return ocrWin;
  ocrWin = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await ocrWin.loadFile(path.join(__dirname, 'renderer', 'ocr-render.html'));
  for (let i = 0; i < 50 && !(await ocrWin.webContents.executeJavaScript('!!window.ocrReady')); i++) await new Promise((r) => setTimeout(r, 100));
  return ocrWin;
}
function ocrCacheKey(file) { const st = fs.statSync(file); return `${file}|${st.size}|${st.mtimeMs}`; }
async function cachedOcr(file, run) {
  const key = ocrCacheKey(file);
  const cache = store.get('ocrCache', {});
  if (key in cache) return cache[key];
  const text = await run();
  store.update('ocrCache', {}, (c) => {
    c[key] = text;
    const keys = Object.keys(c);
    for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete c[k];
    return c;
  });
  return text;
}
/**
 * Files OneDrive keeps online only (not downloaded to this PC). Reading them would make Windows download them,
 * so the Smart review leaves their contents alone. Windows only; elsewhere returns an empty list.
 */
function cloudOnlyFiles(folders) {
  if (process.platform !== 'win32' || !folders.length) return Promise.resolve(new Set());
  const script = "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
    "foreach ($f in ($env:DA_PATHS | ConvertFrom-Json)) { Get-ChildItem -LiteralPath $f -Recurse -File -Force | " +
    "Where-Object { ($_.Attributes -band 0x400000) -or ($_.Attributes -band 0x1000) } | ForEach-Object { $_.FullName } }";
  return new Promise((resolve) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120_000, env: { ...process.env, DA_PATHS: JSON.stringify(folders) } },
    (err, out) => resolve(new Set(String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)))));
}

setOcrProvider({
  pdf: (file) => (getSettings().ocrPdfs === false ? Promise.resolve('') : cachedOcr(file, async () => {
    dbg('start', file);
    const win = await ocrRenderer();
    dbg('renderer ready');
    const pages = await win.webContents.executeJavaScript(`window.renderPdf(${JSON.stringify(file)}, 3)`);
    dbg('rendered', pages.length);
    const texts = [];
    for (const dataUrl of pages) { texts.push((await ocr.recognize(Buffer.from(dataUrl.split(',')[1], 'base64'))).text); dbg('page done'); }
    return texts.join('\n');
  })),
  image: (file) => {
    if (!getSettings().ocrImages || /\.(heic|webp)$/i.test(file)) return Promise.resolve('');
    return cachedOcr(file, async () => (await ocr.recognize(await fs.promises.readFile(file))).text);
  },
});

// ---------- PDF editor ----------
const openEditor = (file) => createEditorWindow(file, { store, icon: path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon-pdf.ico' : 'icon-pdf.png') });

// Windows shows a multi-size .ico most crisply (taskbar, Alt+Tab); other systems use the PNG.
function iconPath() { return path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon.ico' : 'icon.png'); }

// ---------- IPC ----------
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

function registerIpc() {
  handle('settings:get', () => ({ ...getSettings(), hasEmailPassword: !!getSecret('emailPassword'), hasAiKey: !!getSecret('aiKey'), hotkey: HOTKEY, aiModels: AI_MODELS }));
  handle('settings:set', (s) => {
    if (typeof s.emailPassword === 'string' && s.emailPassword) setSecret('emailPassword', s.emailPassword);
    if (typeof s.aiKey === 'string') { if (s.aiKey === '__clear__') setSecret('aiKey', ''); else if (s.aiKey) setSecret('aiKey', s.aiKey); }
    // Only personal folders can be chosen - never Windows/program folders or a whole drive.
    for (const key of ['watchFolders', 'searchFolders', 'libraryFolders']) {
      for (const f of s[key] || []) { const why = safety.folderProblem(f); if (why) throw new Error(`${f}: ${why}`); }
    }
    for (const key of ['organisedRoot', 'cleanupFolder']) {
      if (s[key]) { const why = safety.folderProblem(s[key]); if (why) throw new Error(`${s[key]}: ${why}`); }
    }
    const saved = setSettings({ ...getSettings(), ...s });
    app.setLoginItemSettings({ openAtLogin: !!saved.openAtLogin, args: ['--hidden'] });
    applyTheme(saved.theme);
    return saved;
  });
  handle('app:uninstall', () => runUninstall(APP_INFO));
  handle('dialog:folder', async (startIn) => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: startIn && fs.existsSync(startIn) ? startIn : undefined });
    return r.canceled ? null : r.filePaths[0];
  });
  // You picked a different folder for a file: remember it, and move similar files in the current list there too.
  handle('learn:choose', (from, folder) => {
    const why = safety.folderProblem(folder);
    if (why) throw new Error(why);
    const s = getSettings();
    const item = state.lastPlan?.plan.find((p) => p.from === from);
    if (!item) throw new Error('That file is no longer in the list.');
    const example = learn.makeExample(item, folder, s.organisedRoot, true);
    // the chosen folder is used as-is (including its year folder) for this file
    item.dir = folder; item.to = path.join(folder, path.basename(item.to)); item.learned = 'you chose this folder'; item.fallback = false; item.confidence = 'high';
    store.update('learned', [], (l) => [example, ...l.filter((e) => !(e.template === example.template && e.nameTokens.join() === example.nameTokens.join()))].slice(0, 2000));
    let alsoMoved = 0;
    for (const other of state.lastPlan.plan) {
      if (other === item || other.isFolder) continue;
      const d = learn.learnedDestination(other, [example], s.organisedRoot); // only clearly similar files follow
      if (d && d.dir !== other.dir) {
        other.dir = d.dir; other.to = path.join(d.dir, path.basename(other.to)); other.learned = 'similar to a file you just placed'; other.fallback = false; other.confidence = 'high';
        alsoMoved++;
      }
    }
    return { plan: state.lastPlan, alsoMoved };
  });
  // ----- your filing rules -----
  handle('rules:suggest', async (file) => {
    const s = getSettings();
    const st = fs.statSync(file);
    const it = await organizer.analyseFile(file, st, s, null);
    const words = [...new Set(it.nameTokens || [])].filter((w) => w.length >= 4 && !(it.company || '').toLowerCase().includes(w) && !(it.docType || '').toLowerCase().includes(w)).slice(0, 3);
    return { name: it.name, company: it.company, docType: it.docType && it.docType !== 'Other' ? it.docType : null, kind: rules.kindOf(it.ext), words, currentDir: path.dirname(file), organisedRoot: s.organisedRoot };
  });
  handle('rules:list', () => store.get('rules', []).map((r) => ({ ...r, where: rules.describeDest(r) })));
  handle('rules:save', ({ folder, conditions, useYear, name }) => {
    const why = safety.folderProblem(folder);
    if (why) throw new Error(why);
    const c = Object.fromEntries(Object.entries(conditions || {}).filter(([, v]) => v && (!Array.isArray(v) || v.length)));
    if (!Object.keys(c).length) throw new Error('Tick at least one thing the rule should look for.');
    const rule = rules.makeRule({ folder, root: getSettings().organisedRoot, conditions: c, useYear, name });
    store.update('rules', [], (l) => [rule, ...l]);
    // re-file anything in the current Organise/Tidy list that this rule now covers
    let inList = 0;
    for (const item of state.lastPlan?.plan || []) {
      if (item.isFolder || !rules.ruleMatches(rule, item)) continue;
      const dir = rules.ruleFolder(rule, item, getSettings().organisedRoot);
      item.dir = dir; item.to = path.join(dir, path.basename(item.to)); item.learned = `your rule: ${rule.name}`; item.fallback = false; item.confidence = 'high';
      inList++;
    }
    return { rule: { ...rule, where: rules.describeDest(rule) }, inList };
  });
  handle('rules:delete', (id) => { store.update('rules', [], (l) => l.filter((r) => r.id !== id)); return true; });
  handle('rules:toggle', (id) => { store.update('rules', [], (l) => l.map((r) => (r.id === id ? { ...r, enabled: r.enabled === false } : r))); return true; });
  handle('rules:matches', (id) => {
    const rule = store.get('rules', []).find((r) => r.id === id);
    if (!rule) throw new Error('That rule no longer exists.');
    return filesMatchingRule({ ...rule, enabled: true });
  });
  // Move the files you selected into a folder (each into its own year's sub-folder when "by year" is ticked).
  handle('files:moveInto', (files, folder, useYear) => {
    const why = safety.folderProblem(folder);
    if (why) throw new Error(why);
    const s = getSettings();
    const isYear = /^(19|20)\d{2}$/.test(path.basename(folder));
    const items = files.map((f) => {
      let dir = folder;
      if (useYear) {
        const d = index.docs[f];
        const year = ((d && extractDetails(d.text || '', d.name, { dayFirst: s.dayFirstDates !== false }).date) || new Date(fs.statSync(f).mtimeMs).toISOString()).slice(0, 4);
        dir = isYear ? path.join(path.dirname(folder), year) : path.join(folder, year);
      }
      return { from: f, to: path.join(dir, path.basename(f)) };
    }).filter((i) => path.resolve(path.dirname(i.from)).toLowerCase() !== path.resolve(path.dirname(i.to)).toLowerCase());
    const batch = organizer.applyPlan(items);
    tidyEmptied(batch);
    store.update('history', [], (h) => [batch, ...h].slice(0, 2000));
    recordMoves(batch, { byApp: false }); // your own filing choices
    refreshIndex().catch(() => {});
    return batch;
  });
  // Move files you picked yourself (Folders page). Recorded for Undo; treated as YOUR filing (Re-check leaves them alone).
  handle('files:moveTo', (items) => {
    const batch = organizer.applyPlan(items.map((i) => ({ from: i.from, to: i.to })));
    tidyEmptied(batch);
    store.update('history', [], (h) => [batch, ...h].slice(0, 2000));
    recordMoves(batch, { byApp: false }); // your own filing choices
    refreshIndex().catch(() => {});
    return batch;
  });
  handle('learn:list', () => store.get('learned', []).map((e) => ({ template: e.template, inRoot: e.inRoot, docType: e.docType, company: e.company, words: e.nameTokens.slice(0, 5), at: e.at })));
  handle('learn:forget', (i) => { store.update('learned', [], (l) => l.filter((_, k) => k !== i)); return true; });
  handle('dialog:ics', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: [{ name: 'Calendar', extensions: ['ics'] }] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('organise:scan', () => scanInbox());
  handle('organise:last', () => {
    // Drop files that have been moved since the list was made (by you or another page), so nothing points at an old address.
    const lp = state.lastPlan;
    if (lp && lp.plan) {
      lp.plan = lp.plan.filter((p) => fs.existsSync(p.from));
      if (lp.review) lp.review = lp.review.filter((p) => fs.existsSync(p.from));
      if (lp.dupes) lp.dupes = lp.dupes.map((g) => ({ ...g, files: g.files.map((f) => ({ ...f, path: whereNow(f.path) || f.path })).filter((f) => fs.existsSync(f.path)) })).filter((g) => g.files.length > 1);
    }
    return lp;
  });

  // Folder browser in the side panel
  handle('folder:roots', () => folderRoots());
  // Deep search through every folder and file under the roots (folders by name; files by name and contents).
  handle('folder:find', (q) => {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { folders: [], files: [] };
    const roots = folderRoots();
    const dirs = allFolders(roots);
    // Each word must match the START of a word somewhere in the folder's path ("elm" finds "Elm project", not "Helm"),
    // and at least one word must match the folder's own name (so its sub-folders don't all show up too).
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const res = terms.map((t) => new RegExp(`(^|[^a-z0-9])${esc(t)}`, 'i'));
    const folders = [];
    for (const d of dirs) {
      if (!res.every((r) => r.test(d.rel))) continue;
      const inName = res.filter((r) => r.test(d.name)).length;
      if (!inName) continue;
      folders.push({ ...d, score: inName * 10 + (res[0].test(d.name) ? 3 : 0) - d.depth });
    }
    folders.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
    const files = index.search(q, 25).map((f) => ({ name: f.name, path: f.path, dir: f.dir, company: f.company, docType: f.docType }));
    return { folders: folders.slice(0, 40), files, total: folders.length };
  });
  handle('folder:list', (dir) => {
    const dirs = []; const files = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name.startsWith('~$') || /^(desktop\.ini|thumbs\.db|\$recycle\.bin)$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) dirs.push({ name: e.name, path: full, hasDirs: hasSubfolders(full), count: fs.readdirSync(full).filter((n) => !n.startsWith('.')).length });
        else if (e.isFile() && files.length < 3000) { const st = fs.statSync(full); files.push({ name: e.name, path: full, size: st.size, mtime: st.mtimeMs, ext: path.extname(e.name).toLowerCase() }); }
      } catch { /* no access */ }
    }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return { dir, dirs: dirs.sort(byName), files: files.sort(byName) };
  });
  handle('organise:folders', () => organizer.scanFolders(getSettings()));
  handle('everything:scan', async () => {
    state.cancel = false;
    state.lastPlan = await planEverything(planSettings(), { ai: ai(), onProgress: (i, n) => send('scan-progress', { i, n }), isCancelled: () => state.cancel });
    send('plan-changed');
    return state.lastPlan;
  });
  handle('everything:cancel', () => { state.cancel = true; return true; });
  // ----- Smart review: label, rename and date every file in a pool of folders; find duplicates -----
  handle('review:pool', () => {
    const s = getSettings();
    const saved = store.get('reviewPool', null);
    const pool = (saved || [s.organisedRoot, ...s.watchFolders]).filter((f) => f && fs.existsSync(f) && !safety.folderProblem(f));
    return { pool: [...new Set(pool)], hasAiKey: !!getSecret('aiKey') };
  });
  handle('review:setPool', (folders) => {
    const ok = [...new Set((folders || []).filter((f) => typeof f === 'string' && fs.existsSync(f)))];
    for (const f of ok) { const why = safety.folderProblem(f); if (why) throw new Error(`${f}: ${why}`); }
    store.set('reviewPool', ok); return ok;
  });
  handle('review:scan', async ({ folders, useAI } = {}) => {
    state.cancel = false;
    const s = planSettings();
    const pool = (folders || []).filter((f) => !safety.folderProblem(f));
    if (!pool.length) throw new Error('Choose at least one folder to review.');
    const brain = useAI ? ai() : null;
    if (useAI && !brain) throw new Error('Add your AI key in Settings → AI first, or turn off "Use AI".');
    const logFile = path.join(app.getPath('userData'), 'smart-review.log');
    const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ } };
    try { if (fs.statSync(logFile).size > 2e6) fs.unlinkSync(logFile); } catch { /* none yet */ }
    log(`--- review of ${pool.length} folder(s)${brain ? ' with AI' : ''}`);
    send('scan-progress', { i: 0, n: 0, file: 'checking which files are only in OneDrive online…' });
    const cloudOnly = await cloudOnlyFiles(pool);
    if (cloudOnly.size) log(`${cloudOnly.size} online-only OneDrive file(s) left alone`);
    state.lastPlan = await reviewFiles(pool, s, { ai: brain, log, cloudOnly, onProgress: (i, n, file) => send('scan-progress', { i, n, file: path.basename(file) }), isCancelled: () => state.cancel });
    log(`done: ${state.lastPlan.plan.length} suggestions`);
    send('plan-changed');
    return state.lastPlan;
  });
  handle('review:types', () => require('./core/classifier').DOC_TYPES.map((d) => d.type));
  // Correct the type of one file in the review list: its name and folder are worked out again.
  handle('review:setType', (from, docType) => {
    const item = ['review', 'sortall'].includes(state.lastPlan?.mode) && state.lastPlan.plan.find((p) => p.from === from);
    if (!item) throw new Error('That file is no longer in the list.');
    const { DOC_TYPES } = require('./core/classifier');
    if (!DOC_TYPES.some((d) => d.type === docType) && docType !== 'Other') throw new Error('Unknown type');
    const s = { ...planSettings(), groupByYear: true, renameFiles: true };
    item.docType = docType; item.confidence = 'high'; item.fallback = false; item.group = null;
    item.reasons = [`you set the type to ${docType}`, ...(item.reasons || []).filter((r) => !/^you set the type/.test(r))];
    if (!item.company && item.category !== 'Media') item.category = 'General';
    const { dir } = organizer.placeItem(item, s);
    const keep = item.keptFolder;
    item.dir = keep || !dir ? path.dirname(from) : dir;
    const { smartName } = require('./core/details');
    item.newName = smartName({ fileName: item.name, ext: item.ext, classification: item, details: item.details, aiTitle: item.aiTitle, aiDate: item.aiDate, fallbackDate: item.fileDate });
    item.renamed = !!item.newName;
    item.to = path.join(item.dir, item.newName || item.name);
    item.moved = path.resolve(item.dir) !== path.resolve(path.dirname(from));
    item.label = { ...item.label, type: docType === 'Other' ? null : docType };
    item.warning = null;
    return item;
  });
  // ----- Sort by type: everything into Organised › Type › Year (the one layout), with a preview first -----
  handle('sortall:pool', () => {
    const s = getSettings();
    const saved = store.get('sortallPool', null);
    const pool = (saved || [...s.watchFolders, s.organisedRoot]).filter((f) => f && fs.existsSync(f) && !safety.folderProblem(f));
    return [...new Set(pool)];
  });
  handle('sortall:setPool', (folders) => {
    const ok = [...new Set((folders || []).filter((f) => typeof f === 'string' && fs.existsSync(f)))];
    for (const f of ok) { const why = safety.folderProblem(f); if (why) throw new Error(`${f}: ${why}`); }
    store.set('sortallPool', ok); return ok;
  });
  handle('sortall:scan', async ({ folders, useAI } = {}) => {
    state.cancel = false;
    const s = { ...planSettings(), filingLayout: 'typeYear' };
    const pool = (folders || []).filter((f) => !safety.folderProblem(f));
    if (!pool.length) throw new Error('Choose at least one folder.');
    send('scan-progress', { i: 0, n: 0, file: 'checking which files are only in OneDrive online…' });
    const cloudOnly = await cloudOnlyFiles(pool);
    const logFile = path.join(app.getPath('userData'), 'smart-review.log');
    const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} [sort by type] ${m}\n`); } catch { /* ignore */ } };
    const brain = useAI ? ai() : null;
    if (useAI && !brain) throw new Error('Add your AI key in Settings → AI first, or turn off "Use AI".');
    state.lastPlan = await reviewFiles(pool, s, { ai: brain, refileAll: true, cloudOnly, log, onProgress: (i, n, file) => send('scan-progress', { i, n, file: path.basename(file) }), isCancelled: () => state.cancel });
    // Sorting by type is the chosen layout from now on, for every page.
    if (getSettings().filingLayout !== 'typeYear') setSettings({ ...getSettings(), filingLayout: 'typeYear' });
    send('plan-changed');
    return state.lastPlan;
  });
  // Decide what happens to duplicates: keep, archive (moved to Organised\Archive\Duplicates\<date>, can be undone) or Recycle Bin.
  handle('dupes:resolve', async (actions) => {
    const s = getSettings();
    const day = new Date().toISOString().slice(0, 10);
    const archiveDir = path.join(s.organisedRoot, 'Archive', 'Duplicates', day);
    const toArchive = []; const binned = []; const failed = [];
    for (const a of actions || []) {
      const p = a.path;
      if (!p || !fs.existsSync(p)) { failed.push({ path: p, error: 'file no longer exists' }); continue; }
      if (safety.isSystemPath(p) || safety.isTooBroad(p) || safety.isProtectedFile(p)) { failed.push({ path: p, error: 'protected system file' }); continue; }
      if (a.action === 'archive') toArchive.push({ from: p, to: path.join(archiveDir, path.basename(p)) });
      else if (a.action === 'bin') { try { await shell.trashItem(p); index.remove(p); binned.push(p); } catch (e) { failed.push({ path: p, error: e.message }); } }
    }
    let batch = null;
    if (toArchive.length) {
      batch = organizer.applyPlan(toArchive);
      batch.label = `Archived ${batch.moves.length} duplicate${batch.moves.length === 1 ? '' : 's'}`;
      store.update('history', [], (h) => [batch, ...h].slice(0, 2000));
      recordMoves(batch); // archived by the app - never learned from
      failed.push(...batch.errors.map((e) => ({ path: e.from, error: e.error })));
    }
    if (binned.length) store.update('cleanupLog', [], (l) => [{ at: new Date().toISOString(), binned }, ...l].slice(0, 50));
    // Files that were archived or binned drop out of the rename list.
    const gone = new Set([...binned, ...(batch ? batch.moves.map((m) => m.from) : [])]);
    if (state.lastPlan?.mode === 'review' || state.lastPlan?.mode === 'sortall') {
      state.lastPlan.plan = state.lastPlan.plan.filter((p) => !gone.has(p.from));
      state.lastPlan.dupes = (state.lastPlan.dupes || []).map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(f.path)) })).filter((g) => g.files.length > 1);
    }
    refreshIndex().catch(() => {});
    return { archived: batch ? batch.moves.length : 0, binned: binned.length, failed, archiveDir, batchId: batch && batch.id, plan: state.lastPlan };
  });
  // Line up the icons on the Windows desktop: turns on "Auto arrange" + "Align to grid" and refreshes the desktop.
  handle('desktop:arrange', async () => {
    if (process.platform !== 'win32') throw new Error('Arranging desktop icons is only available on Windows.');
    const script = [
      "$k = 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Bags\\1\\Desktop'",
      'if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }',
      "Set-ItemProperty -Path $k -Name FFlags -Value 1075839525 -Type DWord",  // auto-arrange + align to grid
      'Stop-Process -Name explorer -Force',
      'Start-Sleep -Seconds 3',
      'if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }',
    ].join('; ');
    await new Promise((resolve, reject) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err) => (err ? reject(err) : resolve())));
    return true;
  });
  handle('desktop:undoArrange', async () => {
    if (process.platform !== 'win32') return false;
    const script = "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Bags\\1\\Desktop' -Name FFlags -Value 1075839520 -Type DWord; Stop-Process -Name explorer -Force; Start-Sleep -Seconds 3; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }";
    await new Promise((resolve, reject) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err) => (err ? reject(err) : resolve())));
    return true;
  });
  handle('organise:setFolder', (p, checked) => {
    const s = getSettings();
    const value = typeof checked === 'string' ? checked : !!checked; // true/false for top folders, 'leave'|'sort'|'move' for sub-folders
    setSettings({ ...s, scanSelection: { ...(s.scanSelection || {}), [p]: value } });
    return true;
  });
  handle('organise:recheck', async () => {
    state.lastPlan = await organizer.planRecheck(planSettings(), { ai: ai(), onProgress: (i, n) => send('scan-progress', { i, n }) });
    return state.lastPlan;
  });

  // Downloads clean-up
  const cleanupFolder = () => {
    const s = getSettings();
    return s.cleanupFolder || s.watchFolders.find((f) => /downloads$/i.test(f)) || path.join(os.homedir(), 'Downloads');
  };
  handle('cleanup:scan', async (staleDays) => {
    const s = getSettings();
    const folder = cleanupFolder();
    const items = await analyseFolder(folder, {
      organisedRoot: s.organisedRoot, staleDays: staleDays || s.staleDays || 90, ignore: store.get('cleanupKeep', []), settings: s,
      onProgress: (i, n) => send('scan-progress', { i, n }),
    });
    return { folder, items };
  });
  handle('cleanup:trash', async (paths) => {
    const done = []; const failed = [];
    for (const p of paths) {
      try {
        if (safety.isSystemPath(p) || safety.isTooBroad(p) || (fs.statSync(p).isFile() && safety.isProtectedFile(p))) throw new Error('protected system file');
        await shell.trashItem(p); done.push(p); index.remove(p);
      } catch (e) { failed.push({ path: p, error: e.message }); }
    }
    store.update('cleanupLog', [], (l) => [{ at: new Date().toISOString(), binned: done }, ...l].slice(0, 50));
    return { done, failed };
  });
  handle('cleanup:keep', (p) => { store.update('cleanupKeep', [], (k) => [...new Set([...k, p])]); return true; });
  handle('cleanup:resetKept', () => { store.set('cleanupKeep', []); return true; });
  handle('organise:apply', (items) => {
    const batch = organizer.applyPlan(items);
    if (state.lastPlan?.mode === 'recheck') organizer.removeEmptyDirs(getSettings().organisedRoot);
    // Sub-folders that were ticked for clean-up and are now empty get removed (undo recreates them).
    for (const sub of state.lastPlan?.emptyFolderCleanup || []) organizer.removeEmptyDirs(sub, { includeRoot: true });
    if (state.lastPlan?.mode === 'everything') { removeEmptiedFolders(batch, state.lastPlan.libraries || []); state.lastPlan = null; }
    if (state.lastPlan?.mode === 'sortall') { tidyEmptied(batch); organizer.removeEmptyDirs(getSettings().organisedRoot); } // old company folders left empty
    if (state.lastPlan?.mode === 'review' || state.lastPlan?.mode === 'sortall') {
      // Moved/renamed files leave the list; duplicates follow their new location.
      const moved = new Map(batch.moves.map((m) => [m.from, m.to]));
      state.lastPlan.plan = state.lastPlan.plan.filter((p) => !moved.has(p.from));
      for (const g of state.lastPlan.dupes || []) for (const f of g.files) if (moved.has(f.path)) { f.path = moved.get(f.path); f.name = path.basename(f.path); }
    }
    store.update('history', [], (h) => [batch, ...h].slice(0, 2000));
    recordMoves(batch);
    refreshIndex().catch(() => {});
    return batch;
  });
  handle('organise:history', () => store.get('history', []));
  // ----- Where are my files? / Put everything back -----
  // Every file the app has moved or renamed: where it was, and where it is now.
  const chronological = (moves) => {
    const byBatch = new Map();
    for (const m of moves) { if (!byBatch.has(m.batch)) byBatch.set(m.batch, []); byBatch.get(m.batch).push(m); }
    return [...byBatch.values()].reverse().flat();
  };
  const allMoves = () => {
    const out = [];
    for (const b of store.get('history', [])) for (const m of b.moves) out.push({ from: m.from, to: m.to, at: b.at, batch: b.id, label: b.label || null });
    return out;
  };
  const fileJourneys = () => {
    const moves = allMoves();
    // One row per file: follow each file's moves (oldest first) from where it ORIGINALLY was to where it is now.
    const journeys = new Map();
    for (const m of chronological(moves)) {
      const j = journeys.get(m.from) || { was: m.from, steps: 0 };
      journeys.delete(m.from);
      journeys.set(m.to, { ...j, at: m.at, steps: j.steps + 1 });
    }
    return [...journeys].map(([last, j]) => {
      const now = whereNow(last);
      return { name: path.basename(j.was), was: j.was, now, at: j.at, steps: j.steps, back: !!(now && path.resolve(now) === path.resolve(j.was)) };
    }).filter((f) => !f.back || f.steps > 0);
  };
  handle('restore:summary', () => {
    const moves = allMoves();
    const traced = new Set(moves.map((m) => m.to));
    const untraceable = [...placedByApp()].filter((p) => !traced.has(p) && fs.existsSync(p));
    const binned = store.get('cleanupLog', []).flatMap((l) => l.binned.map((p) => ({ path: p, at: l.at })));
    const files = fileJourneys();
    return { files, batches: store.get('history', []).length, untraceable, binned };
  });
  // A spreadsheet of every move, saved in Documents, so there's always a record you can open.
  function writeMovesReport(rows, name) {
    const s = getSettings();
    const dir = fs.existsSync(path.dirname(s.organisedRoot)) ? path.dirname(s.organisedRoot) : app.getPath('documents');
    const file = path.join(dir, `${name} ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.csv`);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    fs.writeFileSync(file, '﻿' + ['File,Was in,Now at,When moved', ...rows.map((r) => [r.name, r.was, r.now || '(not found)', r.at].map(q).join(','))].join('\r\n'));
    return file;
  }
  handle('restore:report', () => {
    const file = writeMovesReport(fileJourneys(), 'Riyeser Desk Assistant - where my files went');
    shell.showItemInFolder(file);
    return file;
  });
  // Original names back, files stay where they are now. preview=true only lists what would change.
  handle('restore:names', (preview) => {
    const items = [];
    for (const j of fileJourneys()) {
      if (!j.now || !fs.existsSync(j.now)) continue;
      const original = path.basename(j.was); const current = path.basename(j.now);
      if (original === current) continue;
      if (safety.isSystemPath(j.now) || safety.isProtectedFile(j.now)) continue;
      items.push({ from: j.now, to: path.join(path.dirname(j.now), original), current, original, folder: path.dirname(j.now) });
    }
    if (preview) return { items };
    const batch = organizer.applyPlan(items.map(({ from, to }) => ({ from, to })));
    batch.label = `Changed ${batch.moves.length} name(s) back to the originals`;
    store.update('history', [], (h) => [batch, ...h].slice(0, 2000));
    recordMoves(batch, { byApp: false });
    refreshIndex().catch(() => {});
    return { renamed: batch.moves.length, errors: batch.errors, batchId: batch.id };
  });
  // Put every file back where it was before the app moved or renamed it (newest move first, so chains unwind correctly).
  handle('restore:all', async () => {
    const s = getSettings();
    const hist = store.get('history', []);
    const report = writeMovesReport(fileJourneys(), 'Riyeser Desk Assistant - before putting files back');
    let restored = 0; const problems = [];
    let i = 0;
    for (const batch of hist) { // newest first
      send('scan-progress', { i: ++i, n: hist.length, file: 'putting files back…' });
      for (const m of [...batch.moves].reverse()) {
        try {
          if (fs.existsSync(m.from) && !fs.existsSync(m.to)) continue; // already back
          if (!fs.existsSync(m.to)) { const now = whereNow(m.to); if (now && now !== m.to) { organizer.moveFile(now, m.from); restored++; continue; } problems.push({ file: m.from, error: 'not found where I left it' }); continue; }
          if (safety.isSystemPath(m.from)) { problems.push({ file: m.from, error: 'protected location' }); continue; }
          const dest = organizer.moveFile(m.to, m.from); // keeps both if something new now has that name
          if (path.resolve(dest) !== path.resolve(m.from)) problems.push({ file: m.from, error: `a different file now has that name, so it was put back as “${path.basename(dest)}”` });
          restored++;
        } catch (e) { problems.push({ file: m.from, error: e.message }); }
      }
      await new Promise((r) => setImmediate(r));
    }
    store.set('history', []);
    store.set('placedByApp', []);
    store.set('movedLog', {});
    state.lastPlan = null;
    if (s.organisedRoot && fs.existsSync(s.organisedRoot)) organizer.removeEmptyDirs(s.organisedRoot); // folders the app made and left empty
    setSettings({ ...getSettings(), autoOrganise: false });
    refreshIndex().catch(() => {});
    return { restored, problems, report };
  });
  handle('organise:undo', (id) => {
    const hist = store.get('history', []);
    const batch = hist.find((b) => b.id === id);
    if (!batch) throw new Error('Nothing to undo');
    const errors = organizer.undoBatch(batch);
    store.set('history', hist.filter((b) => b.id !== id));
    const undone = new Set(batch.moves.map((m) => m.to));
    store.set('placedByApp', [...placedByApp()].filter((p) => !undone.has(p)));
    recordMoves({ moves: batch.moves.filter((m) => fs.existsSync(m.from)).map((m) => ({ from: m.to, to: m.from })) }, { byApp: false });
    return { errors };
  });
  handle('organise:duplicates', () => { const s = getSettings(); return organizer.findDuplicates([...new Set([...s.watchFolders, s.organisedRoot])].filter((f) => fs.existsSync(f))); });
  handle('file:trash', async (p) => {
    if (safety.isSystemPath(p) || safety.isTooBroad(p) || safety.isProtectedFile(p)) throw new Error('That is a protected system file, so it was not deleted.');
    await shell.trashItem(p); index.remove(p); return true;
  });

  handle('search', (q) => index.search(q));
  handle('search:find', (opts) => index.find(opts || {}, { organisedRoot: getSettings().organisedRoot }));
  handle('index:status', () => ({ size: index.size, busy: !!state.busy.index }));
  handle('index:rebuild', () => refreshIndex());
  handle('index:stats', () => ({ size: index.size, busy: !!state.busy.index }));
  // Opening a file from a list that's out of date: follow it to where it was moved.
  handle('file:open', async (p) => {
    const now = whereNow(p);
    if (!now) throw new Error(movedMessage(p));
    const err = await shell.openPath(now);
    if (err) throw new Error(err);
    return now === p ? null : now;
  });
  handle('file:reveal', (p) => {
    const now = whereNow(p);
    if (!now) throw new Error(movedMessage(p));
    shell.showItemInFolder(now);
    return now === p ? null : now;
  });
  handle('file:whereNow', (p) => whereNow(p));
  handle('search:hide', () => searchWin && searchWin.hide());

  handle('meetings:get', async (force) => { if (force || !state.meetings.length) await refreshMeetings(); return { meetings: state.meetings, errors: state.meetingErrors }; });
  handle('email:refresh', () => refreshEmail());
  handle('email:get', () => state.emails);
  handle('link:open', (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });

  registerPdfIpc({ handle, store, openEditor, getTheme: () => getSettings().theme || 'system', setTheme: (t) => { setSettings({ ...getSettings(), theme: t }); applyTheme(t); } });

  handle('tasks:get', () => store.get('tasks', []));
  handle('tasks:add', (input) => {
    if (Array.isArray(input)) return addTasks(input.map((t) => ({ text: String(t.text), due: t.due || null, urgent: !!t.urgent, source: t.source || 'meeting', meeting: t.meeting || null })));
    const found = extractActionItems(`todo: ${input}`, { source: 'manual' });
    return addTasks(found.length ? found : [{ text: String(input), source: 'manual', due: null, urgent: false }]);
  });
  handle('tasks:toggle', (id) => { store.update('tasks', [], (t) => t.map((x) => x.id === id ? { ...x, done: !x.done, doneAt: new Date().toISOString() } : x)); send('tasks-changed'); });
  handle('tasks:clearDone', () => { store.update('tasks', [], (t) => t.filter((x) => !x.done)); send('tasks-changed'); });

  handle('today', () => {
    const now = new Date();
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    return {
      meetings: state.meetings.filter((m) => new Date(m.end) >= now && new Date(m.start) <= endOfDay),
      tasks: store.get('tasks', []).filter((t) => !t.done).sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0)),
      toSort: state.lastPlan ? state.lastPlan.plan.length + state.lastPlan.review.length : null,
      needsReply: state.emails.filter((e) => e.needsReply).slice(0, 10),
      indexSize: index.size,
    };
  });
}

// ---------- app lifecycle ----------
// Light / dark / follow Windows. Every window follows this (the pages use the system colour scheme).
function applyTheme(theme) { nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system'; }

// Only one copy runs at a time. If a *different* copy (e.g. a newer version you just downloaded) is started
// while this one is running, this one steps aside and starts that one instead - so updates always take effect.
function handOverTo(data) {
  if (!data || !data.exe || path.resolve(data.exe).toLowerCase() === path.resolve(process.execPath).toLowerCase()) return false;
  try { require('child_process').spawn(data.exe, data.args || [], { detached: true, stdio: 'ignore', cwd: path.dirname(data.exe) }).unref(); } catch { return false; }
  app.isQuitting = true;
  setTimeout(() => app.exit(0), 300);
  return true;
}
const instanceData = { exe: process.execPath, version: app.getVersion(), args: process.argv.slice(1).filter((a) => a !== '--hidden') };
const uninstalling = process.argv.includes('--uninstall');
if (!app.requestSingleInstanceLock(instanceData)) app.exit(0);
app.on('second-instance', (_e, argv, _cwd, data) => {
  if (argv.includes('--uninstall')) { runUninstall(APP_INFO); return; }
  if (app.isPackaged && handOverTo(data)) return;
  const pdf = pdfArg(argv); if (pdf) openEditor(pdf); else showMain();
});

app.whenReady().then(async () => {
  if (uninstalling) { await runUninstall(APP_INFO); app.quit(); return; }
  if (!pdfArg(process.argv) && !process.argv.includes('--hidden')) showSplash();   // M8: feedback before the set-up below
  store = new Store(path.join(app.getPath('userData'), 'data'));
  index = new Index(store);
  fixFolderLocations();
  // 0.22: files keep their own names unless the user picks a naming style (asked for after earlier renames caused confusion).
  if (!store.get('namesKeptByDefault', false)) { setSettings({ ...getSettings(), nameStyle: 'keep', renameFiles: false }); store.set('namesKeptByDefault', true); }
  applyTheme(getSettings().theme);
  registerInstalledApp(APP_INFO).catch(() => {});
  ocr.configure({ cacheDir: path.join(app.getPath('userData'), 'ocr') });
  // Read documents in a background process so a heavy file can never freeze the window.
  try { textPool = createTextPool({ log: (m) => console.warn(m) }); setRawExtractor(textPool.extract); } catch (e) { console.warn('file reader unavailable', e.message); }
  setTextCache((file, mtime) => { const d = index.docs[file]; return d && d.mtime === mtime && d.text ? d.text : undefined; });
  registerIpc();
  const startPdf = pdfArg(process.argv);
  if (startPdf) openEditor(startPdf);
  else if (!process.argv.includes('--hidden')) createMain();

  if (!globalShortcut.register(HOTKEY, toggleSearch)) console.warn(`Could not register ${HOTKEY}`);

  if (process.platform === 'win32') tray = new Tray(path.join(__dirname, 'renderer', 'icon.ico')); // Windows picks the right size from the .ico
  else { const img = nativeImage.createFromPath(path.join(__dirname, 'renderer', process.platform === 'darwin' ? 'tray.png' : 'icon.png')); tray = new Tray(img.isEmpty() ? img : img.resize({ width: 18, height: 18, quality: 'best' })); }
  tray.setToolTip('Riyeser Desk Assistant');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Riyeser Desk Assistant', click: () => showMain() },
    { label: `Quick search (${HOTKEY.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')})`, click: toggleSearch },
    { label: 'Tidy my folders now', click: () => showMain('organise') },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMain());

  // Background jobs
  const safe = (fn) => () => fn().catch((e) => console.error(e.message));
  setTimeout(safe(refreshIndex), 5_000);
  setTimeout(safe(refreshMeetings), 2_000);
  setTimeout(safe(() => scanInbox({ quiet: true })), 30_000);
  setInterval(safe(refreshIndex), 30 * 60_000);
  setInterval(safe(refreshMeetings), 10 * 60_000);
  setInterval(safe(() => scanInbox({ quiet: true })), 60 * 60_000);
  setInterval(checkReminders, 30_000);
  setInterval(safe(async () => { const s = getSettings(); if (s.email.host && s.email.autoCheck) await refreshEmail(); }), 20 * 60_000);
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep running in the tray
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (textPool) textPool.stop(); });
