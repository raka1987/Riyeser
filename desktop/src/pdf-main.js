// Riyeser PDF (formerly Desk PDF): the stand-alone PDF viewer/editor. Same editor as inside Riyeser Desk Assistant, without the rest of the app.
// 0.26.0: several PDFs in tabs in one window; File Explorer's right-click menu ("Riyeser PDF ▸ Compress / Combine
// selected / Sign / Convert to images / Open") starts it with --task=... and the files (src/pdf/args.js); with several
// files selected, every copy Windows starts hands its file to the first one, which gathers them into one job.
const { app, ipcMain, nativeTheme } = require('electron');
const { registerInstalledApp, runUninstall } = require('./uninstall');
const APP_INFO = { id: 'DeskPDF', name: 'Riyeser PDF', publisher: 'Riyeser', pdfProgId: 'DeskPDF.PDF', description: 'View, edit, fill in and sign PDFs' };
const path = require('path');
const { Store } = require('./core/store');
const { registerPdfIpc, createEditorWindow, sendTask, latestEditor } = require('./pdf-ipc');
const { parseArgs, createGatherer } = require('./pdf/args');

app.setName('Riyeser PDF');
// Keep the data folder from before the rename (recent files, saved signatures).
app.setPath('userData', require('path').join(app.getPath('appData'), 'Desk PDF'));
let store;
const icon = path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon-pdf.ico' : 'icon-pdf.png');
const openEditor = (file, task = null) => createEditorWindow(file, { store, icon, task });
const selfTest = (process.argv.find((a) => a.startsWith('--self-test=')) || '').slice('--self-test='.length);

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

const applyTheme = (t) => { nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system'; };
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
if (!selfTest && !app.requestSingleInstanceLock(instanceData)) app.exit(0);

// Files from the right-click menu, "Open with" and the Print to PDF inbox go to the window used last (a new tab).
let ready = false;
const early = [];
function deliver(task) {
  if (!ready) { early.push(task); return; }
  const w = latestEditor();
  if (w) sendTask(w, task); else openEditor(null, task);
}
const gatherer = createGatherer({ run: deliver });
// "Open" opens each file in its own tab straight away; the other tasks wait a moment for the rest of the selection.
const take = (job) => (job.task === 'open' ? deliver(job) : gatherer.add(job));
app.on('second-instance', (_e, argv, _cwd, data) => {
  if (argv.includes('--uninstall')) { runUninstall(APP_INFO); return; }
  if (app.isPackaged && handOverTo(data)) return;
  const job = parseArgs(argv);
  if (job.files.length) { take(job); return; }
  const w = latestEditor();
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); } else openEditor(null);
});

app.whenReady().then(async () => {
  if (selfTest) { await require('./pdf/self-test').run(selfTest, { app }); app.exit(0); return; }
  if (uninstalling) { await runUninstall(APP_INFO); app.quit(); return; }
  // OWNER-BACKUP: saved signatures and recent files, backed up daily to Documents\Riyeser\PDF\Backups
  const backups = require('./core/backup-ui').backupUi({ app, dialog: require('electron').dialog, shell: require('electron').shell, name: 'Riyeser PDF',
    win: () => require('electron').BrowserWindow.getFocusedWindow(), spec: require('./core/backup-specs').programSpec('pdf', { appData: app.getPath('appData') }) });
  await backups.applyPending().catch(() => null);
  store = new Store(path.join(app.getPath('userData'), 'data'));
  backups.startDaily();
  handle('backup:now', async () => (await backups.backUpNow({ quiet: true })).file);
  handle('backup:restore', () => backups.restoreFromBackup());
  handle('backup:folder', () => backups.openFolder().then(() => true));
  if (backups.pendingResult) setTimeout(() => backups.showPendingResult(), 2000);
  applyTheme(store.get('theme', 'system'));
  registerInstalledApp(APP_INFO).catch(() => {});
  require('./core/ocr').configure({ cacheDir: path.join(app.getPath('userData'), 'ocr') });
  registerPdfIpc({ handle, store, openEditor, deliver, getTheme: () => store.get('theme', 'system'), setTheme: (t) => { store.set('theme', t); applyTheme(t); } });
  require('./sign-request-ipc').registerSignRequest({ handle, store, electron: require('electron'), openEditor });   // Ask someone to sign
  handle('app:info', () => ({ standalone: true }));
  handle('app:uninstall', () => runUninstall(APP_INFO));
  const job = parseArgs(process.argv);
  openEditor(null);
  ready = true;
  for (const t of early.splice(0)) deliver(t);
  // this copy's own files join any that other copies hand over in the next moment (several files selected)
  if (job.files.length) take(job);
});

app.on('window-all-closed', () => app.quit());
