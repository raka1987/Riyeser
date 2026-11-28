// Everything the PDF editor window needs from the main process. Shared by Desk Assistant and the stand-alone Desk PDF app.
// 0.26.0 adds: tasks handed to a window (right-click menu, Print to PDF inbox), recent and pinned files, saved
// signatures and initials sealed with safeStorage, My details, stamps' date format, the Convert / Batch / Combine pages,
// Send to Riyeser Documents, scanning, and the "Ask someone to sign" hook.
const { app, BrowserWindow, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { createSignatureStore, makeSealer } = require('./pdf/signatures');

const reg = (...args) => new Promise((resolve, reject) => execFile('reg.exe', args, { windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));

/**
 * Register this app with Windows as a program that can open PDFs, so it appears in "Open with" and
 * Settings > Default apps for every program (Outlook, Chrome, File Explorer...). Windows only lets the
 * user pick the actual default, so we open that Settings page for them afterwards.
 */
async function registerAsPdfApp() {
  if (process.platform !== 'win32') throw new Error('This is only needed on Windows. On a Mac, right-click a PDF > Get Info > Open with > Change All.');
  const name = app.getName();
  const progId = `${name.replace(/\s+/g, '')}.PDF`;
  const exe = process.execPath;
  const command = app.isPackaged ? `"${exe}" "%1"` : `"${exe}" "${app.getAppPath()}" "%1"`;
  const C = 'HKCU\\Software\\Classes';
  await reg('add', `${C}\\${progId}`, '/ve', '/d', 'PDF Document', '/f');
  await reg('add', `${C}\\${progId}\\DefaultIcon`, '/ve', '/d', `"${exe}",0`, '/f');
  await reg('add', `${C}\\${progId}\\shell\\open\\command`, '/ve', '/d', command, '/f');
  await reg('add', `${C}\\.pdf\\OpenWithProgids`, '/v', progId, '/t', 'REG_NONE', '/f');
  await reg('add', `${C}\\Applications\\${path.basename(exe)}\\SupportedTypes`, '/v', '.pdf', '/d', '', '/f');
  await reg('add', `HKCU\\Software\\${name}\\Capabilities`, '/v', 'ApplicationName', '/d', name, '/f');
  await reg('add', `HKCU\\Software\\${name}\\Capabilities`, '/v', 'ApplicationDescription', '/d', 'View, edit, fill in and sign PDFs', '/f');
  await reg('add', `HKCU\\Software\\${name}\\Capabilities\\FileAssociations`, '/v', '.pdf', '/d', progId, '/f');
  await reg('add', 'HKCU\\Software\\RegisteredApplications', '/v', name, '/d', `Software\\${name}\\Capabilities`, '/f');
  await shell.openExternal(`ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(name)}`);
  return name;
}

const pdfArg = (argv) => argv.slice(1).find((a) => /\.pdf$/i.test(a) && fs.existsSync(a));

// ----- tasks handed to an editor window: { task: 'open'|'sign'|'compress'|'combine'|'toimages'|'topdf', files } -----
// A window that is still starting keeps them until its page asks (pdf:pendingTask); after that they're sent straight away.
const pendingTasks = new Map(); // webContents id -> [task]
const readyWindows = new Set();
function sendTask(w, task) {
  if (!w || w.isDestroyed()) return false;
  const id = w.webContents.id;
  if (readyWindows.has(id)) w.webContents.send('pdf:task', task);
  else pendingTasks.set(id, [...(pendingTasks.get(id) || []), task]);
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
  return true;
}
const editorWindows = new Set();
/** The editor window to hand new files to: the one used last. */
const latestEditor = () => [...editorWindows].filter((w) => !w.isDestroyed()).pop() || null;
const remember = (store, file) => store.update('recentPdfs', [], (r) => [file, ...r.filter((x) => x !== file)].slice(0, 30));

function createEditorWindow(file, { store, icon, task = null, size = null }) {
  const w = new BrowserWindow({
    width: size ? size[0] : 1400, height: size ? size[1] : 920, minWidth: 900, minHeight: 600, title: 'PDF Editor', icon,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  w.removeMenu();
  const id = w.webContents.id;
  editorWindows.add(w);
  w.on('focus', () => { editorWindows.delete(w); editorWindows.add(w); });
  w.on('closed', () => { editorWindows.delete(w); readyWindows.delete(id); pendingTasks.delete(id); });
  if (task) pendingTasks.set(id, [task]);
  w.loadFile(path.join(__dirname, 'renderer', 'editor.html'), { query: file ? { file } : {} });
  if (file) remember(store, file);
  return w;
}

function registerPdfIpc({ handle, store, openEditor, getTheme = () => 'system', setTheme = () => {}, deliver = null }) {
  // A window's page asks once it's ready: the tasks waiting for it (and from then on they're sent straight away)
  require('electron').ipcMain.handle('pdf:pendingTask', (e) => {
    const id = e.sender.id; readyWindows.add(id);
    const list = pendingTasks.get(id) || []; pendingTasks.delete(id);
    return { ok: true, data: list };
  });
  // where new files go (right-click menu, Print to PDF inbox): the editor window used last, else a new one
  const deliverTask = deliver || ((task) => { const w = latestEditor(); if (w) sendTask(w, task); else openEditor(null, task); });
  handle('app:platform', () => process.platform);
  handle('app:version', () => app.getVersion());
  handle('pdf:help', () => shell.openExternal('https://riyeser.com/help/pdf.html').then(() => true));
  handle('theme:get', () => getTheme());
  handle('ocr:readFile', async (file) => new Uint8Array(await fs.promises.readFile(file)));

  // ----- conversions -----
  const convert = require('./convert');
  const ocrLines = (img) => require('./core/ocr').recognize(img);
  handle('files:pick', async (kind) => {
    const filters = kind === 'convert'
      ? [{ name: 'Pictures, Word, Excel, PowerPoint, text', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'docx', 'doc', 'rtf', 'odt', 'xlsx', 'xls', 'xlsm', 'ods', 'csv', 'pptx', 'ppt', 'odp', 'txt', 'md', 'html', 'htm'] }]
      : kind === 'images' ? [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }] : [{ name: 'PDF', extensions: ['pdf'] }];
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { properties: ['openFile', 'multiSelections'], filters });
    return r.canceled ? null : r.filePaths;
  });
  handle('convert:toPdf', (files, opts) => convert.convertToPdf(files, opts || {}));
  handle('convert:pdfToWord', (file) => convert.pdfToWord(file, { ocr: ocrLines }));
  handle('convert:pdfToImages', (file, opts) => convert.pdfToImages(file, opts || {}));
  handle('file:openPath', (p) => shell.openPath(p));
  handle('file:showPath', (p) => shell.showItemInFolder(p));
  // Save several PDFs (e.g. "split into separate files") into a folder you choose.
  handle('pdf:saveMany', async (suggestedFolder, items) => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { title: 'Choose where to save the files', defaultPath: suggestedFolder, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    const dir = r.filePaths[0];
    const saved = items.map((it) => { const dest = convert.uniquePath(path.join(dir, it.name)); fs.writeFileSync(dest, Buffer.from(it.bytes)); return dest; });
    return { folder: dir, saved };
  });
  handle('theme:set', (t) => { setTheme(t); return t; });
  // OCR one page image (PNG data URL) for the editor's "Recognise text".
  handle('ocr:image', async (dataUrl) => require('./core/ocr').recognize(Buffer.from(dataUrl.split(',')[1], 'base64')));
  handle('pdf:makeDefault', registerAsPdfApp);
  handle('pdf:edit', (file) => { openEditor(file || null); return true; });
  handle('pdf:recent', () => store.get('recentPdfs', []).filter((f) => fs.existsSync(f)).slice(0, 12));
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
  // S46: a font from this PC for text the standard PDF fonts can't write ('latin', 'devanagari' or 'cjk'); null if none
  handle('pdf:font', (script) => { const f = require('./core/pdf-fonts').findFont(String(script || '')); return f ? new Uint8Array(f.bytes) : null; });
  handle('pdf:read', (file) => {
    remember(store, file);
    return new Uint8Array(fs.readFileSync(file));
  });
  // Backup viewer: the PDF engine built into Windows' web view (the same one Edge uses). View-only, but it copes with
  // unusual PDFs that the editor's engine can't draw.
  handle('pdf:basicView', (file) => {
    if (!file || !fs.existsSync(file)) throw new Error('That PDF could not be found.');
    const w = new BrowserWindow({ width: 1000, height: 1000, title: `${path.basename(file)} (basic viewer)`, autoHideMenuBar: true,
      webPreferences: { plugins: true, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    w.on('page-title-updated', (e) => e.preventDefault()); // keep "(basic viewer)" in the title
    w.loadURL(require('url').pathToFileURL(file).href);
    return true;
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
    remember(store, target);
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
  // Saved signatures and initials: sealed with safeStorage (Windows: locked to this Windows user), src/pdf/signatures.js
  const sigs = createSignatureStore({ store, ...makeSealer(safeStorage) });
  handle('sig:list', (kind) => sigs.list(kind || null));
  handle('sig:save', (sig) => sigs.save({ kind: sig.kind || 'signature', data: sig.data, makeDefault: sig.makeDefault !== false }));
  handle('sig:delete', (id) => sigs.remove(id));
  handle('sig:default', (kind) => sigs.getDefault(kind || 'signature'));
  handle('sig:setDefault', (id) => sigs.setDefault(id));
  handle('sig:status', () => sigs.status());
  require('./pdf/handy-ipc').registerHandyIpc({ handle, store, deliver: deliverTask, convert });
  handle('confirm', async (message, detail) => {
    const r = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), { type: 'question', buttons: ['Cancel', 'OK'], defaultId: 1, cancelId: 0, message, detail });
    return r.response === 1;
  });
}

module.exports = { registerPdfIpc, createEditorWindow, pdfArg, sendTask, latestEditor };
