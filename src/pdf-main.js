// Desk PDF: the stand-alone PDF viewer/editor. Same editor as inside Desk Assistant, without the rest of the app.
const { app, ipcMain, nativeTheme } = require('electron');
const { registerInstalledApp, runUninstall } = require('./uninstall');
const APP_INFO = { id: 'DeskPDF', name: 'Desk PDF', pdfProgId: 'DeskPDF.PDF', description: 'View, edit, fill in and sign PDFs' };
const path = require('path');
const { Store } = require('./core/store');
const { registerPdfIpc, createEditorWindow, pdfArg } = require('./pdf-ipc');

app.setName('Desk PDF');
let store;
const icon = path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon-pdf.ico' : 'icon-pdf.png');
const openEditor = (file) => createEditorWindow(file, { store, icon });

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

const applyTheme = (t) => { nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system'; };
const uninstalling = process.argv.includes('--uninstall');
if (!app.requestSingleInstanceLock()) app.quit();
// Opening another PDF while Desk PDF is running opens it in a new window.
app.on('second-instance', (_e, argv) => { if (argv.includes('--uninstall')) runUninstall(APP_INFO); else openEditor(pdfArg(argv) || null); });

app.whenReady().then(async () => {
  if (uninstalling) { await runUninstall(APP_INFO); app.quit(); return; }
  store = new Store(path.join(app.getPath('userData'), 'data'));
  applyTheme(store.get('theme', 'system'));
  registerInstalledApp(APP_INFO).catch(() => {});
  require('./core/ocr').configure({ cacheDir: path.join(app.getPath('userData'), 'ocr') });
  registerPdfIpc({ handle, store, openEditor, getTheme: () => store.get('theme', 'system'), setTheme: (t) => { store.set('theme', t); applyTheme(t); } });
  handle('app:info', () => ({ standalone: true }));
  handle('app:uninstall', () => runUninstall(APP_INFO));
  openEditor(pdfArg(process.argv) || null);
});

app.on('window-all-closed', () => app.quit());
