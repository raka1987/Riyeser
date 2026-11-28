// Converting files to and from PDF.
// - Office files (Word/Excel/PowerPoint): uses Microsoft Office when it's installed (exact layout), otherwise a built-in converter.
// - Pictures: placed one per page.
// - PDF -> Word: Word's own PDF converter if installed, otherwise rebuilt from the PDF's text (OCR for scans).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IMAGE = /\.(jpe?g|png|webp|bmp|gif)$/i;
const HEIC = /\.(heic|heif)$/i;
const WORD = /\.(docx?|rtf|odt)$/i;
const EXCEL = /\.(xlsx?|xlsm|ods|csv)$/i;
const POWERPOINT = /\.(pptx?|odp)$/i;
const TEXTISH = /\.(txt|md|html?|log)$/i;
const CONVERTIBLE = /\.(jpe?g|png|webp|bmp|gif|docx?|rtf|odt|xlsx?|xlsm|ods|csv|pptx?|odp|txt|md|html?|log)$/i;

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; i < 1000; i++) { const c = path.join(dir, `${name} (${i})${ext}`); if (!fs.existsSync(c)) return c; }
  return path.join(dir, `${name}-${Date.now()}${ext}`);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- hidden helper window (renders PDFs/pictures/HTML) ----------
let helper = null;
async function helperWindow() {
  if (helper && !helper.isDestroyed()) return helper;
  helper = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await helper.loadFile(path.join(__dirname, 'renderer', 'ocr-render.html'));
  for (let i = 0; i < 50 && !(await helper.webContents.executeJavaScript('!!window.ocrReady')); i++) await new Promise((r) => setTimeout(r, 100));
  return helper;
}
/** Render PDF pages to images (data URLs). */
async function renderPdfPages(file, { maxPages = 500, dpi = 150, format = 'png', quality = 0.85, startPage = 1 } = {}) {
  const w = await helperWindow();
  return w.webContents.executeJavaScript(`window.renderPdf(${JSON.stringify(file)}, ${maxPages}, ${JSON.stringify({ dpi, format, quality, startPage })})`);
}

// ---------- Microsoft Office (Windows, when installed) ----------
function powershell(script, env) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 180_000, env: { ...process.env, ...env } }, (err) => resolve(!err));
  });
}
async function officeToPdf(input, output) {
  if (process.platform !== 'win32') return false;
  const env = { DA_IN: input, DA_OUT: output };
  let script;
  if (WORD.test(input)) script = "$a=New-Object -ComObject Word.Application; $a.Visible=$false; $a.DisplayAlerts=0; try { $d=$a.Documents.Open($env:DA_IN,$false,$true); $d.ExportAsFixedFormat($env:DA_OUT,17); $d.Close($false) } finally { $a.Quit() }";
  else if (EXCEL.test(input) && !/\.csv$/i.test(input)) script = "$a=New-Object -ComObject Excel.Application; $a.Visible=$false; $a.DisplayAlerts=$false; try { $w=$a.Workbooks.Open($env:DA_IN,0,$true); $w.ExportAsFixedFormat(0,$env:DA_OUT); $w.Close($false) } finally { $a.Quit() }";
  else if (POWERPOINT.test(input)) script = "$a=New-Object -ComObject PowerPoint.Application; try { $p=$a.Presentations.Open($env:DA_IN,$true,$false,$false); $p.SaveAs($env:DA_OUT,32); $p.Close() } finally { $a.Quit() }";
  else return false;
  const ok = await powershell(script, env);
  return ok && fs.existsSync(output) && fs.statSync(output).size > 0;
}
async function wordFromPdf(input, output) {
  if (process.platform !== 'win32') return false;
  const ok = await powershell("$a=New-Object -ComObject Word.Application; $a.Visible=$false; $a.DisplayAlerts=0; try { $d=$a.Documents.Open($env:DA_IN,$false); $d.SaveAs2($env:DA_OUT,16); $d.Close($false) } finally { $a.Quit() }", { DA_IN: input, DA_OUT: output });
  return ok && fs.existsSync(output) && fs.statSync(output).size > 0;
}

// ---------- built-in converters (no Office needed) ----------
const PAGE_CSS = `@page { size: A4; margin: 18mm 16mm; } * { font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0; } body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.4; color: #111; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; margin-bottom: 14pt; } td, th { border: 1px solid #bbb; padding: 3px 5px; vertical-align: top; }
  h1, h2, h3 { margin: 10pt 0 6pt; } img { max-width: 100%; } .slide { page-break-after: always; border: 1px solid #ddd; padding: 24pt; min-height: 200mm; } pre { white-space: pre-wrap; font-family: Consolas, monospace; font-size: 9.5pt; }`;

async function xlsxToHtml(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const read = async (n) => (zip.file(n) ? zip.file(n).async('string') : '');
  const text = (x) => x.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => text(m[1]));
  const names = [...(await read('xl/workbook.xml')).matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1]);
  const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const colIndex = (ref) => { const l = ref.replace(/\d+/g, ''); let n = 0; for (const ch of l) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  let html = '';
  for (const [i, sh] of sheets.entries()) {
    const xml = await read(sh);
    const rows = [];
    for (const row of xml.match(/<row[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const c of row.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const v = (c[3] || '').match(/<v>([\s\S]*?)<\/v>/); const inline = (c[3] || '').match(/<is>([\s\S]*?)<\/is>/);
        cells[colIndex(c[1])] = /t="s"/.test(c[2]) && v ? shared[+v[1]] : inline ? text(inline[1]) : v ? v[1] : '';
      }
      rows.push(cells);
    }
    const width = Math.max(0, ...rows.map((r) => r.length));
    html += `<h2>${esc(names[i] || `Sheet ${i + 1}`)}</h2><table>${rows.map((r) => `<tr>${Array.from({ length: width }, (_, k) => `<td>${esc(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</table>`;
  }
  return html;
}
async function pptxToHtml(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  let html = '';
  for (const s of slides) {
    const xml = await zip.file(s).async('string');
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join('')).filter(Boolean);
    html += `<div class="slide">${paras.map((p, i) => (i === 0 ? `<h1>${esc(p)}</h1>` : `<p>${esc(p)}</p>`)).join('')}</div>`;
  }
  return html;
}
async function toHtml(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return (await require('mammoth').convertToHtml({ path: file })).value;
  if (ext === '.xlsx' || ext === '.xlsm') return xlsxToHtml(file);
  if (ext === '.pptx') return pptxToHtml(file);
  if (ext === '.csv') return `<table>${fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => `<tr>${l.split(',').map((c) => `<td>${esc(c.replace(/^"|"$/g, ''))}</td>`).join('')}</tr>`).join('')}</table>`;
  if (/\.html?$/i.test(ext)) return fs.readFileSync(file, 'utf8');
  if (/\.(txt|md|log)$/i.test(ext)) return `<pre>${esc(fs.readFileSync(file, 'utf8'))}</pre>`;
  throw new Error(`${path.basename(file)}: this kind of file needs Microsoft Office installed to convert.`);
}
async function htmlToPdf(html, output) {
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body>${html}</body></html>`;
    const tmp = path.join(app.getPath('temp'), `da-convert-${Date.now()}.html`);
    fs.writeFileSync(tmp, doc);
    await w.loadFile(tmp);
    const pdf = await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(output, pdf);
    fs.rmSync(tmp, { force: true });
  } finally { w.destroy(); }
}

/** Pictures -> PDF pages (each page the size of the picture, at 150 dpi), photos turned the right way up (0.26.0). */
async function addImagesToPdf(doc, files) {
  const C = require('./pdf/converters');
  const { degrees } = require('pdf-lib');
  for (const f of files) {
    let bytes = new Uint8Array(fs.readFileSync(f)); // a copy (see converters.js)
    const jpeg = /\.jpe?g$/i.test(f);
    const rot = jpeg ? await C.orientationOf(bytes) : 0;
    if (!/\.(jpe?g|png)$/i.test(f)) bytes = new Uint8Array(await decodeToPng(f));
    const img = jpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const { page, box } = C.layoutImage(img.width, img.height, rot);
    const s = C.drawSpec(box, rot);
    doc.addPage(page).drawImage(img, { x: s.x, y: s.y, width: s.width, height: s.height, rotate: degrees(s.rotate) });
  }
}

/**
 * Convert files to PDF. combine=true puts everything into one PDF (named after the first file).
 * Returns { outputs: [paths], usedOffice: bool }
 */
async function convertToPdf(files, { combine = false, outDir = null } = {}) {
  const { PDFDocument } = require('pdf-lib');
  if (files.some((f) => HEIC.test(f))) throw new Error(require('./pdf/converters').HEIC_MESSAGE);
  const bad = files.filter((f) => !CONVERTIBLE.test(f));
  if (bad.length) throw new Error(`Can't convert: ${bad.map((b) => path.basename(b)).join(', ')}`);
  const outputs = [];
  let usedOffice = false;
  const one = async (f) => { // single file -> PDF bytes
    if (IMAGE.test(f)) { const d = await PDFDocument.create(); await addImagesToPdf(d, [f]); return d.save(); }
    const tmp = path.join(app.getPath('temp'), `da-office-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    if (await officeToPdf(f, tmp)) { usedOffice = true; const b = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true }); return b; }
    await htmlToPdf(await toHtml(f), tmp);
    const b = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true });
    return b;
  };
  if (combine) {
    const out = await PDFDocument.create();
    for (const f of files) {
      const src = await PDFDocument.load(await one(f));
      (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
    }
    const dest = uniquePath(path.join(outDir || path.dirname(files[0]), `${path.parse(files[0]).name}${files.length > 1 ? ' (combined)' : ''}.pdf`));
    fs.writeFileSync(dest, await out.save());
    outputs.push(dest);
  } else {
    for (const f of files) {
      const dest = uniquePath(path.join(outDir || path.dirname(f), `${path.parse(f).name}.pdf`));
      fs.writeFileSync(dest, await one(f));
      outputs.push(dest);
    }
  }
  return { outputs, usedOffice };
}

/**
 * PDF -> editable Word document. Uses Word if installed, else rebuilds the text and paragraphs (basic: the layout may
 * change), reading scanned pages with text recognition (src/pdf/converters.js).
 */
async function pdfToWord(pdfFile, { ocr = null } = {}) {
  const dest = uniquePath(path.join(path.dirname(pdfFile), `${path.parse(pdfFile).name}.docx`));
  if (await wordFromPdf(pdfFile, dest)) return { output: dest, usedOffice: true };
  const ocrLines = ocr ? async (p) => {
    const [img] = await renderPdfPages(pdfFile, { maxPages: 1, dpi: 200, startPage: p });
    const r = await ocr(Buffer.from(img.split(',')[1], 'base64'));
    return r.lines.map((l) => ({ text: l.text, y: -l.y0, size: (l.y1 - l.y0) * 0.36 }));
  } : null;
  const r = await require('./pdf/converters').pdfToDocx(pdfFile, { outFile: dest, ocrLines });
  return { output: r.output, usedOffice: false, scannedPages: r.scannedPages };
}

/** Decode a picture the PDF library can't read (WebP, BMP, GIF) into PNG bytes, drawn by the helper window. */
async function decodeToPng(f) {
  const w = await helperWindow();
  const dataUrl = `data:image/${path.extname(f).slice(1).toLowerCase()};base64,${fs.readFileSync(f).toString('base64')}`;
  const png = await w.webContents.executeJavaScript(`window.imageToPng(${JSON.stringify(dataUrl)})`);
  return Buffer.from(png.split(',')[1], 'base64');
}

/** Save each page of a PDF as a picture in a folder next to it. */
async function pdfToImages(pdfFile, { dpi = 150, format = 'png', quality = 0.88 } = {}) {
  const dir = uniquePath(path.join(path.dirname(pdfFile), `${path.parse(pdfFile).name} (pages)`));
  fs.mkdirSync(dir, { recursive: true });
  const pages = await renderPdfPages(pdfFile, { dpi: Math.max(36, Math.min(600, +dpi || 150)), format: format === 'jpg' ? 'jpeg' : 'png', quality });
  pages.forEach((d, i) => fs.writeFileSync(path.join(dir, `Page ${String(i + 1).padStart(2, '0')}.${format === 'jpg' ? 'jpg' : 'png'}`), Buffer.from(d.split(',')[1], 'base64')));
  return { folder: dir, count: pages.length };
}

module.exports = { convertToPdf, pdfToWord, pdfToImages, renderPdfPages, decodeToPng, CONVERTIBLE, uniquePath };
