// Electron main process: windows, tray icon, global search shortcut, background jobs and reminders.
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, Notification, shell, dialog, safeStorage, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Store } = require('./core/store');
const { Index } = require('./core/indexer');
const organizer = require('./core/organizer');
const { upcomingMeetings, companiesInMeeting } = require('./core/calendar');
const { fetchAndSort } = require('./core/email');
const { extractActionItems } = require('./core/actions');
const { createAI } = require('./core/ai');
const { analyseFolder } = require('./core/cleanup');

const HOTKEY = 'CommandOrControl+Shift+Space';
let store, index, mainWin, searchWin, tray;
const state = { meetings: [], meetingErrors: [], emails: [], lastPlan: null, notified: new Set(), busy: {} };

// ---------- settings ----------
function defaults() {
  const home = os.homedir();
  const existing = (p) => fs.existsSync(p) ? [p] : [];
  return {
    ownCompanyNames: [],
    companies: [],
    companyTypes: ['Clients', 'Suppliers', 'Government', 'Banks', 'Utilities', 'Personal'],
    watchFolders: [...existing(path.join(home, 'Downloads')), ...existing(path.join(home, 'Desktop'))],
    organisedRoot: path.join(home, 'Documents', 'Organised'),
    searchFolders: [...existing(path.join(home, 'Documents')), ...existing(path.join(home, 'Downloads')), ...existing(path.join(home, 'Desktop'))],
    recursiveScan: false,
    renameFiles: true,
    groupByYear: false,
    dayFirstDates: true,
    staleDays: 90,
    autoOrganise: false,
    calendars: [],
    reminderMinutes: 10,
    email: { host: '', port: 993, secure: true, user: '', mailbox: 'INBOX', saveAttachments: true },
    aiModel: 'claude-opus-5-5',
    onboarded: false,
  };
}
const getSettings = () => ({ ...defaults(), ...store.get('settings', {}) });
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

async function scanInbox({ quiet = false } = {}) {
  const s = getSettings();
  const result = await organizer.planOrganise(s, { ai: ai(), onProgress: (i, n) => send('scan-progress', { i, n }) });
  state.lastPlan = result;
  if (s.autoOrganise) {
    const sure = result.plan.filter((p) => p.confidence === 'high' || p.category === 'Media');
    if (sure.length) {
      const batch = organizer.applyPlan(sure);
      store.update('history', [], (h) => [batch, ...h].slice(0, 50));
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

function createMain() {
  mainWin = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600, title: 'Desk Assistant', icon: iconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.removeMenu();
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

// ---------- PDF editor ----------
const editors = new Set();
function openEditor(file) {
  const w = new BrowserWindow({
    width: 1400, height: 920, minWidth: 900, minHeight: 600, title: 'PDF Editor', icon: iconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  w.removeMenu();
  w.loadFile(path.join(__dirname, 'renderer', 'editor.html'), { query: file ? { file } : {} });
  editors.add(w);
  w.on('closed', () => editors.delete(w));
  if (file) store.update('recentPdfs', [], (r) => [file, ...r.filter((x) => x !== file)].slice(0, 12));
  return w;
}
const pdfArg = (argv) => argv.slice(1).find((a) => /\.pdf$/i.test(a) && fs.existsSync(a));

function iconPath() { return path.join(__dirname, 'renderer', 'icon.png'); }

// ---------- IPC ----------
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

function registerIpc() {
  handle('settings:get', () => ({ ...getSettings(), hasEmailPassword: !!getSecret('emailPassword'), hasAiKey: !!getSecret('aiKey'), hotkey: HOTKEY }));
  handle('settings:set', (s) => {
    if (typeof s.emailPassword === 'string' && s.emailPassword) setSecret('emailPassword', s.emailPassword);
    if (typeof s.aiKey === 'string') { if (s.aiKey === '__clear__') setSecret('aiKey', ''); else if (s.aiKey) setSecret('aiKey', s.aiKey); }
    const saved = setSettings({ ...getSettings(), ...s });
    app.setLoginItemSettings({ openAtLogin: !!saved.openAtLogin, args: ['--hidden'] });
    return saved;
  });
  handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:ics', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: [{ name: 'Calendar', extensions: ['ics'] }] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('organise:scan', () => scanInbox());
  handle('organise:last', () => state.lastPlan);
  handle('organise:recheck', async () => {
    state.lastPlan = await organizer.planRecheck(getSettings(), { ai: ai(), onProgress: (i, n) => send('scan-progress', { i, n }) });
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
      try { await shell.trashItem(p); done.push(p); index.remove(p); } catch (e) { failed.push({ path: p, error: e.message }); }
    }
    store.update('cleanupLog', [], (l) => [{ at: new Date().toISOString(), binned: done }, ...l].slice(0, 50));
    return { done, failed };
  });
  handle('cleanup:keep', (p) => { store.update('cleanupKeep', [], (k) => [...new Set([...k, p])]); return true; });
  handle('cleanup:resetKept', () => { store.set('cleanupKeep', []); return true; });
  handle('organise:apply', (items) => {
    const batch = organizer.applyPlan(items);
    if (state.lastPlan?.mode === 'recheck') organizer.removeEmptyDirs(getSettings().organisedRoot);
    store.update('history', [], (h) => [batch, ...h].slice(0, 50));
    refreshIndex().catch(() => {});
    return batch;
  });
  handle('organise:history', () => store.get('history', []));
  handle('organise:undo', (id) => {
    const hist = store.get('history', []);
    const batch = hist.find((b) => b.id === id);
    if (!batch) throw new Error('Nothing to undo');
    const errors = organizer.undoBatch(batch);
    store.set('history', hist.filter((b) => b.id !== id));
    return { errors };
  });
  handle('organise:duplicates', () => { const s = getSettings(); return organizer.findDuplicates([...new Set([...s.watchFolders, s.organisedRoot])].filter((f) => fs.existsSync(f))); });
  handle('file:trash', async (p) => { await shell.trashItem(p); index.remove(p); return true; });

  handle('search', (q) => index.search(q));
  handle('index:rebuild', () => refreshIndex());
  handle('index:stats', () => ({ size: index.size, busy: !!state.busy.index }));
  handle('file:open', (p) => shell.openPath(p));
  handle('file:reveal', (p) => shell.showItemInFolder(p));
  handle('search:hide', () => searchWin && searchWin.hide());

  handle('meetings:get', async (force) => { if (force || !state.meetings.length) await refreshMeetings(); return { meetings: state.meetings, errors: state.meetingErrors }; });
  handle('email:refresh', () => refreshEmail());
  handle('email:get', () => state.emails);
  handle('link:open', (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });

  // PDF editor
  handle('pdf:edit', (file) => { openEditor(file || null); return true; });
  handle('pdf:recent', () => store.get('recentPdfs', []).filter((f) => fs.existsSync(f)));
  handle('pdf:openDialog', async (multi) => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    return r.canceled ? null : (multi ? r.filePaths : r.filePaths[0]);
  });
  handle('image:openDialog', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (r.canceled) return null;
    const f = r.filePaths[0];
    const mime = /\.png$/i.test(f) ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(f).toString('base64')}`;
  });
  handle('pdf:read', (file) => {
    store.update('recentPdfs', [], (r) => [file, ...r.filter((x) => x !== file)].slice(0, 12));
    return new Uint8Array(fs.readFileSync(file));
  });
  handle('pdf:save', async (file, bytes, saveAs) => {
    let target = file;
    if (saveAs || !file) {
      const r = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), { defaultPath: file || 'document.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (r.canceled) return null;
      target = r.filePath.toLowerCase().endsWith('.pdf') ? r.filePath : r.filePath + '.pdf';
    }
    if (fs.existsSync(target)) {
      // Keep a backup of what we're about to overwrite, just in case.
      const dir = path.join(app.getPath('userData'), 'pdf-backups');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(target, path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')} ${path.basename(target)}`));
      const backups = fs.readdirSync(dir).sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - 100))) fs.unlinkSync(path.join(dir, old));
    }
    const tmp = target + '.saving';
    fs.writeFileSync(tmp, Buffer.from(bytes));
    fs.renameSync(tmp, target);
    store.update('recentPdfs', [], (r) => [target, ...r.filter((x) => x !== target)].slice(0, 12));
    return target;
  });
  handle('pdf:backups', () => shell.openPath(path.join(app.getPath('userData'), 'pdf-backups')));
  handle('pdf:combine', async (files) => {
    const { PDFDocument } = require('pdf-lib');
    const out = await PDFDocument.create();
    for (const f of files) {
      const src = await PDFDocument.load(fs.readFileSync(f), { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((pg) => out.addPage(pg));
    }
    const r = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), { defaultPath: path.join(path.dirname(files[0]), 'Combined.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, await out.save());
    return r.filePath;
  });
  handle('sig:list', () => store.get('signatures', []));
  handle('sig:save', (sig) => store.update('signatures', [], (l) => [{ id: Date.now().toString(36), ...sig }, ...l].slice(0, 10)));
  handle('sig:delete', (id) => store.update('signatures', [], (l) => l.filter((x) => x.id !== id)));
  handle('confirm', async (message, detail) => {
    const r = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), { type: 'question', buttons: ['Cancel', 'OK'], defaultId: 1, cancelId: 0, message, detail });
    return r.response === 1;
  });

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
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => { const pdf = pdfArg(argv); if (pdf) openEditor(pdf); else showMain(); });

app.whenReady().then(async () => {
  store = new Store(path.join(app.getPath('userData'), 'data'));
  index = new Index(store);
  registerIpc();
  const startPdf = pdfArg(process.argv);
  if (startPdf) openEditor(startPdf);
  else if (!process.argv.includes('--hidden')) createMain();

  if (!globalShortcut.register(HOTKEY, toggleSearch)) console.warn(`Could not register ${HOTKEY}`);

  const img = nativeImage.createFromPath(iconPath());
  tray = new Tray(img.isEmpty() ? img : img.resize({ width: 18, height: 18 }));
  tray.setToolTip('Desk Assistant');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Desk Assistant', click: () => showMain() },
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
app.on('will-quit', () => globalShortcut.unregisterAll());
