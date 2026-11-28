// Riyeser PDF's own check, run by the Windows build (desk-assistant-windows.yml) on the installed program:
//   "Riyeser PDF.exe" --self-test=C:\path\report.json
// In a throw-away data folder it converts real files (pictures with a sideways photo, PDF to pictures through the
// program's own page drawing, text, Excel, Word), saves a signature the way the program does (Windows' DPAPI through
// safeStorage) and checks nothing readable is left on disk, reads back the right-click menu the installer wrote and
// checks each command starts this program with the right task, and opens the window: the start screen's tiles and the
// Settings page, with no page errors (pictures of both are saved next to the report).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// a 120x80 JPEG stored sideways, with EXIF orientation 6 ("turn 90° clockwise"), as phones save portrait photos
const SIDEWAYS_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABQAHgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiKKKK+aP20K3PAv8AyO/h7/sI2/8A6NWsOtzwL/yO/h7/ALCNv/6NWrh8SMMT/Bn6P8j7Eooor6I/GQooooAKKKKACiiigAooooAKKKKAPh+iiivmj9tCtzwL/wAjv4e/7CNv/wCjVrDrc8C/8jv4e/7CNv8A+jVq4fEjDE/wZ+j/ACPsSiiivoj8ZCiiigAooooAKKKKACiiigAooooA+H6KKK+aP20K3PAv/I7+Hv8AsI2//o1aw63PAv8AyO/h7/sI2/8A6NWrh8SMMT/Bn6P8j7Eooor6I/GQooooAKKKKACiiigAooooAKKKKAPh+iiivmj9tCtzwL/yO/h7/sI2/wD6NWsOtzwL/wAjv4e/7CNv/wCjVq4fEjDE/wAGfo/yPsSiiivoj8ZCiiigAooooAKKKKACiiigAooooA+H6KKK+aP20K3PAv8AyO/h7/sI2/8A6NWsOtzwL/yO/h7/ALCNv/6NWrh8SMMT/Bn6P8j7Eooor6I/GQooooAKKKKACiiigAooooAKKKKAP//Z';

function regQuery(key) {
  return new Promise((resolve) => execFile('reg.exe', ['query', key, '/ve'], { windowsHide: true }, (err, out) => {
    if (err) return resolve(null);
    const m = /REG_SZ\s+(.+)\s*$/m.exec(String(out)); resolve(m ? m[1].trim() : '');
  }));
}

async function run(out, { app }) {
  const report = { name: 'Riyeser PDF', version: app.getVersion(), platform: process.platform, ok: false, checks: {}, errors: [] };
  const check = (k, v) => { report.checks[k] = v; return v; };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-pdf-selftest-'));
  try {
    app.setPath('userData', path.join(work, 'userdata'));
    const openEditor = registerIpc(app);
    const L = require('pdf-lib');
    const C = require('./converters');
    // an invoice with a small table
    const d = await L.PDFDocument.create(); const f = await d.embedFont(L.StandardFonts.Helvetica);
    const p = d.addPage([595, 842]);
    p.drawText('Sample Plumbing Ltd', { x: 50, y: 780, size: 20, font: f });
    [['Item', 'Qty', 'Price'], ['Copper pipe', '4', '$32.00'], ['Labour', '3', '$270.00']].forEach((r, i) => { const y = 700 - i * 18; p.drawText(r[0], { x: 50, y, size: 11, font: f }); p.drawText(r[1], { x: 300, y, size: 11, font: f }); p.drawText(r[2], { x: 480 - f.widthOfTextAtSize(r[2], 11), y, size: 11, font: f }); });
    const pdf = path.join(work, 'Invoice INV-1001.pdf'); fs.writeFileSync(pdf, await d.save());
    const txt = await C.pdfToText(pdf);
    check('pdfToText', /Copper pipe 4 \$32\.00/.test(fs.readFileSync(txt.output, 'utf8')));
    const csv = await C.pdfToTable(pdf, { format: 'csv' });
    check('pdfToCsv', fs.readFileSync(csv.output, 'utf8').includes('Copper pipe,4,$32.00'));
    const xlsx = await C.pdfToTable(pdf, { format: 'xlsx' });
    check('pdfToXlsx', fs.statSync(xlsx.output).size > 500);
    const docx = await C.pdfToDocx(pdf);
    check('pdfToDocx', fs.statSync(docx.output).size > 2000);
    // a sideways phone photo becomes an upright page
    const jpg = path.join(work, 'photo.jpg'); fs.writeFileSync(jpg, Buffer.from(SIDEWAYS_JPEG, 'base64'));
    const img = await C.imagesToPdf([jpg], { pageSize: 'a4' });
    const page = (await L.PDFDocument.load(fs.readFileSync(img.outputs[0]))).getPage(0).getSize();
    check('picturesToPdf', img.rotated === 1 && page.height > page.width);
    // PDF pages to pictures: drawn by the program's own hidden page-drawing window
    const pics = await require('../convert').pdfToImages(pdf, { dpi: 72, format: 'png' });
    const png = fs.readdirSync(pics.folder).map((n) => fs.readFileSync(path.join(pics.folder, n)));
    check('pdfToPictures', pics.count === 1 && png[0].slice(1, 4).toString() === 'PNG');
    // a signature, saved the way the program saves it
    const { safeStorage } = require('electron');
    const { Store } = require('../core/store');
    const { createSignatureStore, makeSealer } = require('./signatures');
    const sigDir = path.join(work, 'sig'); const S = createSignatureStore({ store: new Store(sigDir), ...makeSealer(safeStorage) });
    S.save({ kind: 'signature', data: 'data:image/png;base64,SELFTESTSIGNATURE' });
    const onDisk = fs.readFileSync(path.join(sigDir, 'signatures.json'), 'utf8');
    report.signatureProtected = S.status().protected; // Windows: DPAPI; some Linux desktops have no keyring
    check('signatureSaved', S.getDefault().data.endsWith('SELFTESTSIGNATURE') && (process.platform !== 'win32' || (S.status().protected && !onDisk.includes('SELFTESTSIGNATURE'))));
    // the right-click menu the installer wrote (this Windows user)
    if (process.platform === 'win32') {
      const { MENU, MENU_EXTS, splitCommandLine, parseArgs } = require('./args');
      const menu = [];
      for (const m of MENU) for (const t of m.types) for (const ext of MENU_EXTS[t]) {
        const cmd = await regQuery(`HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\RiyeserPDF\\shell\\${m.key}\\command`);
        const argv = cmd ? splitCommandLine(cmd.replace('%1', ext === '.pdf' ? pdf : jpg)) : [];
        const job = argv.length ? parseArgs(argv) : null;
        menu.push({ ext, entry: m.label, ok: !!(job && path.resolve(argv[0]).toLowerCase() === path.resolve(process.execPath).toLowerCase() && job.task === m.task && job.files.length === 1) });
      }
      report.menu = menu;
      check('rightClickMenu', menu.every((x) => x.ok));
    }
    // the window: start screen tiles, Settings, no page errors
    const ui = await uiCheck(openEditor, path.dirname(out));
    report.ui = ui;
    check('startScreen', ui.tiles === 10 && !ui.hscroll);
    check('settingsPage', ui.settings);
    check('noPageErrors', !ui.errors.length);
    report.ok = Object.values(report.checks).every(Boolean);
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
}

/** The program's main-process side, as Riyeser PDF registers it (in the throw-away data folder). */
function registerIpc(app) {
  const { ipcMain } = require('electron');
  const { Store } = require('../core/store');
  const { registerPdfIpc, createEditorWindow } = require('../pdf-ipc');
  const store = new Store(path.join(app.getPath('userData'), 'data'));
  const handle = (name, fn) => ipcMain.handle(name, async (_e, ...args) => { try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message }; } });
  const openEditor = (file, task) => createEditorWindow(file, { store, task, size: [1366, 800] });
  registerPdfIpc({ handle, store, openEditor, deliver: () => {} });
  handle('app:info', () => ({ standalone: true }));
  for (const n of ['backup:now', 'backup:restore', 'backup:folder']) handle(n, () => null);
  return openEditor;
}

async function uiCheck(openEditor, dir) {
  const errors = [];
  const w = openEditor(null);
  w.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  w.webContents.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`));
  await new Promise((r) => w.webContents.once('did-finish-load', r));
  const js = (s) => w.webContents.executeJavaScript(s);
  for (let i = 0; i < 60 && !(await js('!!(window.__editor && document.querySelectorAll("#tiles .tile").length)')); i++) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 800));
  const tiles = await js('document.querySelectorAll("#tiles .tile").length');
  const hscroll = await js('document.documentElement.scrollWidth > innerWidth');
  try { fs.writeFileSync(path.join(dir, 'pdf-start.png'), (await w.webContents.capturePage()).toPNG()); } catch { /* picture only */ }
  await js('window.__editor.commands.settings()');
  for (let i = 0; i < 40 && !(await js('!!document.querySelector("#set-details")')); i++) await new Promise((r) => setTimeout(r, 250));
  const settings = await js('!!document.querySelector("#set-details") && !!document.querySelector("#set-windows")');
  const defaultButton = await js('!!document.querySelector("[data-hcmd=makedefault]")');
  await new Promise((r) => setTimeout(r, 500));
  try { fs.writeFileSync(path.join(dir, 'pdf-settings.png'), (await w.webContents.capturePage()).toPNG()); } catch { /* picture only */ }
  w.destroy();
  return { tiles, hscroll, settings, defaultButton, errors };
}

module.exports = { run };
