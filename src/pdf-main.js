// Desk PDF: the stand-alone PDF viewer/editor. Same editor as inside Desk Assistant, without the rest of the app.
const { app, ipcMain } = require('electron');
const path = require('path');
const { Store } = require('./core/store');
const { registerPdfIpc, createEditorWindow, pdfArg } = require('./pdf-ipc');

app.setName('Desk PDF');
let store;
const icon = path.join(__dirname, 'renderer', 'icon.png');
const openEditor = (file) => createEditorWindow(file, { store, icon });

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
// Opening another PDF while Desk PDF is running opens it in a new window.
app.on('second-instance', (_e, argv) => openEditor(pdfArg(argv) || null));

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'data'));
  require('./core/ocr').configure({ cacheDir: path.join(app.getPath('userData'), 'ocr') });
  registerPdfIpc({ handle, store, openEditor });
  handle('app:info', () => ({ standalone: true }));
  openEditor(pdfArg(process.argv) || null);
});

app.on('window-all-closed', () => app.quit());
