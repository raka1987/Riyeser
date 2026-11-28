// Riyeser PDF 0.26.0: the main-process side of the start screen, Convert, Batch, Combine, Scan, Settings and
// Send to Riyeser Documents. Registered by pdf-ipc.js, so Riyeser PDF and Riyeser Documents' PDF window both have it.
const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const C = require('./converters');
const P = require('./profile');
const { readCompany } = require('../core/online');

const PDF = /\.pdf$/i;
const PICTURE = /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i;
const win = () => BrowserWindow.getFocusedWindow();
const documentsDir = () => { try { const d = app.getPath('documents'); if (d && fs.existsSync(d)) return d; } catch { /* below */ } return path.join(os.homedir(), 'Documents'); };
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

/** deps: { handle, store, deliver(task) (hand files to an editor window), convert (../convert.js) } */
function registerHandyIpc({ handle, store, deliver, convert }) {
  const appData = app.getPath('appData');
  const company = () => readCompany(appData);
  const settings = () => ({ dateFormat: 'system', inbox: false, stamps: [], stampDate: true, ...store.get('pdfSettings', {}) });
  const saveSettings = (patch) => store.set('pdfSettings', { ...settings(), ...patch });

  // ----- start screen: recent and pinned files -----
  handle('pdf:recentList', () => {
    const pinned = store.get('pinnedPdfs', []).filter((f) => fs.existsSync(f));
    const recent = store.get('recentPdfs', []).filter((f) => fs.existsSync(f) && !pinned.includes(f)).slice(0, 12);
    const info = (f) => ({ file: f, name: path.basename(f), folder: path.dirname(f), size: sizeOf(f), modified: (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })() });
    return { pinned: pinned.map(info), recent: recent.map(info) };
  });
  handle('pdf:pin', (file, on) => store.update('pinnedPdfs', [], (l) => (on ? [file, ...l.filter((x) => x !== file)].slice(0, 30) : l.filter((x) => x !== file))));
  handle('pdf:forget', (file) => { store.update('recentPdfs', [], (l) => l.filter((x) => x !== file)); store.update('pinnedPdfs', [], (l) => l.filter((x) => x !== file)); return true; });
  handle('pdf:fileInfo', (files) => (files || []).map((f) => ({ file: f, name: path.basename(f), size: sizeOf(f), exists: fs.existsSync(f), pdf: PDF.test(f), picture: PICTURE.test(f) })));
  // reading without adding to Recent files (Compare, Batch)
  handle('pdf:readQuiet', (file) => new Uint8Array(fs.readFileSync(file)));

  // ----- choosing files and folders -----
  const FILTERS = {
    pdf: [{ name: 'PDF', extensions: ['pdf'] }],
    images: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'heic', 'heif'] }],
    pdfOrImages: [{ name: 'PDFs and pictures', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }],
  };
  handle('pdf:pickFiles', async (kind = 'pdf', multi = true, title = undefined) => {
    const r = await dialog.showOpenDialog(win(), { title, properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: FILTERS[kind] || FILTERS.pdf });
    return r.canceled ? null : r.filePaths;
  });
  /** Every PDF (or picture) directly in a folder you choose, in name order. */
  handle('pdf:pickFolder', async (kind = 'pdf') => {
    const r = await dialog.showOpenDialog(win(), { title: kind === 'images' ? 'Choose the folder with the pictures' : 'Choose a folder of PDFs', properties: ['openDirectory'] });
    if (r.canceled) return null;
    const dir = r.filePaths[0]; const re = kind === 'images' ? PICTURE : PDF;
    return fs.readdirSync(dir).filter((n) => re.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((n) => path.join(dir, n));
  });
  handle('pdf:chooseFolder', async (suggested) => {
    const r = await dialog.showOpenDialog(win(), { title: 'Choose where to save the new files', defaultPath: suggested || undefined, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // ----- Convert -----
  handle('convert:images', (files, opts = {}) => C.imagesToPdf(files, { ...opts, outDir: null, outFile: opts.temp ? path.join(app.getPath('temp'), `riyeser-scan-${Date.now()}.pdf`) : null }, { decode: (f) => convert.decodeToPng(f) }));
  handle('convert:pdfToText', (file) => C.pdfToText(file));
  handle('convert:pdfToTable', (file, format) => C.pdfToTable(file, { format: format === 'csv' ? 'csv' : 'xlsx' }));
  // Combine: PDFs and pictures, in the order given; you choose where the new PDF goes
  handle('pdf:combineFiles', async (files) => {
    const { PDFDocument } = require('pdf-lib');
    const out = await PDFDocument.create();
    for (const f of files) {
      let bytes;
      if (PDF.test(f)) bytes = fs.readFileSync(f);
      else { const tmp = path.join(app.getPath('temp'), `riyeser-pdf-${Date.now()}.pdf`); await C.imagesToPdf([f], { outFile: tmp }, { decode: (x) => convert.decodeToPng(x) }); bytes = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true }); }
      let src;
      try { src = await PDFDocument.load(bytes); } catch (e) { throw new Error(/encrypt/i.test(e.message) ? `${path.basename(f)} has a password. Open it in Riyeser PDF with its password, save a copy without one, then combine.` : `${path.basename(f)}: ${e.message}`); }
      (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
    }
    const r = await dialog.showSaveDialog(win(), { defaultPath: C.uniquePath(path.join(path.dirname(files[0]), 'Combined.pdf')), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled) return null;
    const target = /\.pdf$/i.test(r.filePath) ? r.filePath : `${r.filePath}.pdf`;
    fs.writeFileSync(target, await out.save());
    return { output: target, pages: out.getPageCount() };
  });

  // ----- Batch: new files go into the folder chosen; an original is only replaced when that was ticked -----
  handle('batch:write', (dir, name, bytes, replaceOriginal) => {
    const clean = path.basename(String(name || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
    if (!PDF.test(clean)) throw new Error('Only PDFs are saved here.');
    if (replaceOriginal) {
      const orig = path.resolve(String(replaceOriginal));
      if (!PDF.test(orig) || !fs.existsSync(orig)) throw new Error('The original isn\'t there any more.');
      // the copy kept when saving over a file (Tools › Copies kept when saving over a file)
      const keep = path.join(app.getPath('userData'), 'pdf-backups'); fs.mkdirSync(keep, { recursive: true });
      fs.copyFileSync(orig, path.join(keep, `${new Date().toISOString().replace(/[:.]/g, '-')} ${path.basename(orig)}`));
      const target = path.join(path.dirname(orig), clean);
      const tmp = `${target}.saving`; fs.writeFileSync(tmp, Buffer.from(bytes)); fs.renameSync(tmp, target);
      if (target.toLowerCase() !== orig.toLowerCase()) fs.rmSync(orig, { force: true }); // renamed: the old name goes
      return target;
    }
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Choose a folder for the new files.');
    const target = C.uniquePath(path.join(dir, clean));
    fs.writeFileSync(target, Buffer.from(bytes));
    return target;
  });

  // ----- Scan (Windows' own scanning, WIA), else pictures from a folder -----
  handle('scan:page', async () => {
    const scanner = require('../documents/scanner');
    const r = await scanner.scanWithWia({ outDir: app.getPath('temp') });
    if (!r.ok && r.reason === 'no-scanner') scanner.openFaxAndScan();
    return r;
  });

  // ----- My details, stamps' date format, custom stamps -----
  handle('profile:get', () => ({ ...P.mergeProfile(store.get('profile', {}), company()), hasCompany: !!company() }));
  handle('profile:save', (data) => P.saveProfile(store, data));
  handle('pdfset:get', () => {
    const s = settings();
    let locale = ''; try { locale = (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale(); } catch { /* default */ }
    return { ...s, dateFormatUsed: P.dateFormatFor(s.dateFormat, company()), companyDateFormat: (company() || {}).date_format || '', locale, platform: process.platform, version: app.getVersion() };
  });
  handle('pdfset:set', (patch) => {
    const allowed = {};
    if (patch && P.DATE_FORMATS.includes(patch.dateFormat)) allowed.dateFormat = patch.dateFormat;
    if (patch && typeof patch.stampDate === 'boolean') allowed.stampDate = patch.stampDate;
    if (patch && Array.isArray(patch.stamps)) allowed.stamps = patch.stamps.slice(0, 30).map((x) => ({ text: String(x.text || '').slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#1d4ed8', date: x.date !== false })).filter((x) => x.text.trim());
    saveSettings(allowed);
    return settings();
  });

  // ----- Windows: the right-click menu (written by the installer), and the default PDF program -----
  handle('pdf:contextMenuStatus', () => new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ platform: process.platform, installed: false });
    execFile('reg.exe', ['query', 'HKCU\\Software\\Classes\\SystemFileAssociations\\.pdf\\shell\\RiyeserPDF\\shell'], { windowsHide: true }, (err, out) => resolve({ platform: 'win32', installed: !err, entries: String(out || '').split(/\r?\n/).filter((l) => /\\shell\\[0-9]/.test(l)).length }));
  }));
  handle('pdf:defaultAppsPage', () => shell.openExternal('ms-settings:defaultapps').then(() => true));

  // ----- Print to PDF: the watched "Riyeser PDF inbox" folder -----
  const { watchInbox, defaultInboxDir } = require('./inbox');
  const inboxDir = () => settings().inboxDir || defaultInboxDir(documentsDir());
  let watcher = null;
  const startInbox = () => { if (watcher) return; try { watcher = watchInbox(inboxDir(), (f) => deliver({ task: 'open', files: [f], from: 'inbox' })); } catch (e) { console.warn('inbox', e.message); } };
  const stopInbox = () => { if (watcher) watcher.stop(); watcher = null; };
  if (settings().inbox) startInbox();
  handle('inbox:get', () => ({ on: !!settings().inbox, dir: inboxDir(), exists: fs.existsSync(inboxDir()), watching: !!watcher }));
  handle('inbox:set', (on) => { saveSettings({ inbox: !!on }); if (on) startInbox(); else stopInbox(); return { on: !!on, dir: inboxDir() }; });
  handle('inbox:open', async () => { fs.mkdirSync(inboxDir(), { recursive: true }); await shell.openPath(inboxDir()); return true; });

  // ----- Send to Riyeser Documents -----
  const sender = require('./send-to-documents').createSender({
    appData, documentsDir: documentsDir(), readCompany,
    isDemo: () => { try { return require('../central/demo').isOn(appData); } catch { return false; } },
    cacheDir: null,
  });
  handle('docs:target', () => sender.target());
  handle('docs:send', (files, opts) => sender.send(files, opts || {}));

  // ----- "Ask someone to sign" (online): built separately; its menu entry shows only when its module is there -----
  handle('pdf:hasModule', (name) => (name === 'sign-request.js' ? fs.existsSync(path.join(__dirname, '..', 'renderer', 'sign-request.js')) : false));
}

module.exports = { registerHandyIpc };
