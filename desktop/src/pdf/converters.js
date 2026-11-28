// Riyeser PDF 0.26.0: converting to and from PDF on this PC (no internet, nothing to pay).
//   - pictures -> PDF: page size, orientation, and photos turned the right way up from the camera's information (EXIF)
//   - PDF -> plain text
//   - PDF -> Excel (.xlsx) / CSV, basic: finds simple tables (rows of text lined up in columns)
//   - PDF -> Word (.docx), basic: the text and paragraphs of each page (layout may change)
// PDF pages -> pictures needs a page drawn, so that one stays in convert.js (its hidden helper window).
// Nothing here needs Electron, so the tests run it as it is.
const fs = require('fs');
const path = require('path');

const HEIC = /\.(heic|heif)$/i;
const HEIC_MESSAGE = 'iPhone HEIC photos can\'t be converted yet. On the iPhone, choose Settings › Camera › Formats › Most Compatible (new photos are then JPEG), or open the photo on this PC and save it as JPEG first.';

function uniquePath(p, exists = fs.existsSync) {
  if (!exists(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; i < 1000; i++) { const c = path.join(dir, `${name} (${i})${ext}`); if (!exists(c)) return c; }
  return path.join(dir, `${name}-${Date.now()}${ext}`);
}

// ---------------------------------------------------------------- reading a PDF's words
let pdfjsPromise = null;
async function openPdf(bytes, password) {
  pdfjsPromise = pdfjsPromise || import('unpdf');
  const { getDocumentProxy } = await pdfjsPromise;
  return getDocumentProxy(new Uint8Array(bytes), password != null ? { password } : {});
}

/** Text pieces of a page -> lines (top to bottom), each with its pieces left to right. */
function linesFromItems(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = it.y; const size = it.h || 10;
    let row = rows.find((r) => Math.abs(r.y - y) < Math.min(r.size, size) * 0.45);
    if (!row) { row = { y, size, parts: [] }; rows.push(row); }
    row.parts.push({ x: it.x, str: it.str, w: it.w }); row.size = Math.max(row.size, size);
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let t = ''; let end = null;
    for (const part of r.parts) { if (end !== null && part.x - end > r.size * 0.25 && !t.endsWith(' ')) t += ' '; t += part.str; end = part.x + part.w; }
    return { text: t.replace(/\s+/g, ' ').trim(), y: r.y, size: r.size, parts: r.parts };
  });
}

/** Every page's words: [{ width, height, items: [{str,x,y,w,h}], lines }] */
async function readPages(bytes, { password } = {}) {
  const pdf = await openPdf(bytes, password);
  const pages = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.hypot(it.transform[2], it.transform[3]) || 10 }));
      pages.push({ width: vp.width, height: vp.height, items, lines: linesFromItems(items) });
    }
  } finally { try { await pdf.destroy(); } catch { /* gone */ } }
  return pages;
}

// ---------------------------------------------------------------- PDF -> text
function pagesToText(pages) {
  return pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
async function pdfToText(file, { outFile = null, password } = {}) {
  const pages = await readPages(fs.readFileSync(file), { password });
  const text = pagesToText(pages);
  const dest = outFile || uniquePath(path.join(path.dirname(file), `${path.parse(file).name}.txt`));
  fs.writeFileSync(dest, text, 'utf8');
  const empty = pages.filter((p) => !p.items.length).length;
  return { output: dest, pages: pages.length, emptyPages: empty, chars: text.trim().length };
}

// ---------------------------------------------------------------- PDF -> tables (Excel / CSV)
/** A line's pieces -> cells: pieces close together are one cell, a wide gap starts the next. */
function cellsOf(line) {
  const cells = [];
  for (const p of line.parts) {
    const last = cells[cells.length - 1];
    const gap = last ? p.x - last.x1 : Infinity;
    if (last && gap < line.size * 1.1) { last.text += (gap > line.size * 0.15 && !last.text.endsWith(' ') ? ' ' : '') + p.str; last.x1 = Math.max(last.x1, p.x + p.w); }
    else cells.push({ text: p.str, x0: p.x, x1: p.x + p.w });
  }
  return cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text);
}

/**
 * Simple tables on a page: two or more lines in a row, each split into 2+ cells, whose cells line up in the same
 * columns (left-, right- or centre-aligned all work: a column is where the cells overlap from line to line).
 * Returns [[cell, ...], ...] per table. Honest about its limits: no merged cells, no ruled-line reading, no rotated text.
 */
function detectTables(lines) {
  const rows = lines.map((l) => ({ line: l, cells: cellsOf(l) }));
  const tables = [];
  let block = [];
  const close = () => { const t = blockToTable(block); if (t) tables.push(t); block = []; };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = block[block.length - 1];
    const farBelow = prev && (prev.line.y - r.line.y) > Math.max(prev.line.size, r.line.size) * 3.2;
    if (r.cells.length >= 2 && !farBelow) block.push(r);
    else { close(); if (r.cells.length >= 2) block.push(r); }
  }
  close();
  return tables;
}
function blockToTable(block) {
  if (block.length < 2) return null;
  // columns: merge every cell's span; spans that overlap are the same column
  const spans = block.flatMap((r) => r.cells.map((c) => [c.x0, c.x1])).sort((a, b) => a[0] - b[0]);
  const cols = [];
  for (const [a, b] of spans) { const last = cols[cols.length - 1]; if (last && a <= last[1] + 2) last[1] = Math.max(last[1], b); else cols.push([a, b]); }
  if (cols.length < 2 || cols.length > 30) return null;
  const table = block.map((r) => {
    const out = new Array(cols.length).fill('');
    for (const c of r.cells) {
      let best = 0; let bestOverlap = -Infinity;
      cols.forEach(([a, b], k) => { const o = Math.min(b, c.x1) - Math.max(a, c.x0); if (o > bestOverlap) { bestOverlap = o; best = k; } });
      out[best] = out[best] ? `${out[best]} ${c.text}` : c.text;
    }
    return out;
  });
  // at least two lines with two or more filled columns, and most lines use several columns
  const multi = table.filter((r) => r.filter(Boolean).length >= 2).length;
  if (multi < 2 || multi < table.length * 0.6) return null;
  return table;
}

const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

/** "1,234.50", "$1,234.50", "-12" -> a number for Excel; anything else stays text. */
function asNumber(v) {
  const t = String(v).trim();
  if (!/^\(?-?[$€£¥]?\s?\d{1,3}(,\d{3})*(\.\d+)?\)?$|^\(?-?[$€£¥]?\s?\d+(\.\d+)?\)?$/.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || t.includes('-');
  const n = Number(t.replace(/[()$€£¥,\s-]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/** A small .xlsx (one sheet per table) with plain cells: numbers as numbers, everything else as text. */
async function xlsxBytes(sheets) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  const names = sheets.map((s, i) => xmlEsc(String(s.name || `Table ${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)));
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((s, i) => {
    const rows = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (v === '' || v == null) return '';
      const ref = `${colName(ci)}${ri + 1}`; const n = asNumber(v);
      return n !== null ? `<c r="${ref}"><v>${n}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

class NoTablesError extends Error {}
/** PDF -> .xlsx or .csv with the simple tables found on its pages. format: 'xlsx' | 'csv' */
async function pdfToTable(file, { format = 'xlsx', outFile = null, password } = {}) {
  const pages = await readPages(fs.readFileSync(file), { password });
  const found = [];
  pages.forEach((p, pi) => detectTables(p.lines).forEach((rows, ti) => found.push({ page: pi + 1, name: `Page ${pi + 1}${ti ? ` table ${ti + 1}` : ''}`, rows })));
  if (!found.length) {
    const scanned = pages.length && pages.every((p) => !p.items.length);
    throw new NoTablesError(scanned
      ? 'This PDF is a scan (its words are a picture). Open it, use Recognise text and save, then try again.'
      : 'No simple tables were found in this PDF. Try PDF to Word or PDF to text instead.');
  }
  const ext = format === 'csv' ? 'csv' : 'xlsx';
  const dest = outFile || uniquePath(path.join(path.dirname(file), `${path.parse(file).name}.${ext}`));
  if (ext === 'csv') fs.writeFileSync(dest, `﻿${found.map((t) => toCsv(t.rows)).join('\r\n\r\n')}\r\n`, 'utf8');
  else fs.writeFileSync(dest, await xlsxBytes(found));
  return { output: dest, tables: found.length, rows: found.reduce((n, t) => n + t.rows.length, 0), pages: [...new Set(found.map((t) => t.page))] };
}

// ---------------------------------------------------------------- PDF -> Word (basic)
/** Lines -> paragraphs: a bigger gap starts a new paragraph; noticeably bigger text becomes a heading. */
function paragraphsFromLines(lines) {
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 11;
  const out = []; let para = null; let prev = null;
  for (const l of lines) {
    if (!l.text) continue;
    const heading = l.size >= body * 1.3;
    const gap = prev ? prev.y - l.y : 0;
    if (!para || heading || para.heading || gap > Math.max(prev.size, l.size) * 1.8) { if (para) out.push(para); para = { text: l.text, heading }; }
    else if (/[a-z]-$/i.test(para.text) && /^[a-z]/.test(l.text)) para.text = para.text.slice(0, -1) + l.text; // a word split over two lines
    else para.text += ' ' + l.text;
    prev = l;
  }
  if (para) out.push(para);
  return out;
}
/**
 * PDF -> .docx from its words (no Microsoft Word needed). ocrLines(pageNumber): lines for a scanned page (optional).
 * Returns { output, scannedPages }.
 */
async function pdfToDocx(file, { outFile = null, ocrLines = null, password } = {}) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak } = require('docx');
  const pages = await readPages(fs.readFileSync(file), { password });
  const children = []; let scannedPages = 0;
  for (const [i, p] of pages.entries()) {
    let lines = p.lines;
    if (!p.items.length && ocrLines) { scannedPages++; lines = await ocrLines(i + 1); }
    for (const para of paragraphsFromLines(lines)) {
      children.push(para.heading ? new Paragraph({ text: para.text, heading: HeadingLevel.HEADING_2 }) : new Paragraph({ children: [new TextRun(para.text)], spacing: { after: 120 } }));
    }
    if (i < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  }
  const doc = new Document({ sections: [{ children: children.length ? children : [new Paragraph('')] }] });
  const dest = outFile || uniquePath(path.join(path.dirname(file), `${path.parse(file).name}.docx`));
  fs.writeFileSync(dest, await Packer.toBuffer(doc));
  return { output: dest, scannedPages, pages: pages.length };
}

// ---------------------------------------------------------------- pictures -> PDF
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
/** EXIF orientation (1-8) -> how far the picture must be turned clockwise to stand the right way up (mirroring ignored). */
const ROTATION_FOR_ORIENTATION = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

/**
 * Where a picture goes on its page. imgW/imgH: the picture's own pixels; rot: clockwise turn (0/90/180/270).
 * pageSize: 'fit' (the page is the picture's size, 150 dpi) | 'a4' | 'letter'; orientation: 'auto' | 'portrait' | 'landscape'.
 * Returns { page: [w, h], box: { x, y, w, h } } in PDF points; box is the upright picture on the page.
 */
function layoutImage(imgW, imgH, rot = 0, { pageSize = 'fit', orientation = 'auto', margin = null } = {}) {
  const turned = rot === 90 || rot === 270;
  const dw = turned ? imgH : imgW; const dh = turned ? imgW : imgH;
  if (pageSize === 'fit' || !PAGE_SIZES[pageSize]) {
    let w = dw * (72 / 150); let h = dh * (72 / 150);
    const maxSide = 842 * 1.5; // keeps huge photos to a sensible page size
    if (Math.max(w, h) > maxSide) { const k = maxSide / Math.max(w, h); w *= k; h *= k; }
    return { page: [w, h], box: { x: 0, y: 0, w, h } };
  }
  let [pw, ph] = PAGE_SIZES[pageSize];
  const landscape = orientation === 'landscape' || (orientation === 'auto' && dw > dh);
  if (landscape) [pw, ph] = [ph, pw];
  const m = margin == null ? 18 : margin;
  const k = Math.min((pw - 2 * m) / dw, (ph - 2 * m) / dh);
  const w = dw * k; const h = dh * k;
  return { page: [pw, ph], box: { x: (pw - w) / 2, y: (ph - h) / 2, w, h } };
}
/** pdf-lib drawImage options that put a picture, turned rot degrees clockwise, exactly into box. */
function drawSpec(box, rot = 0) {
  const { x, y, w, h } = box;
  if (rot === 90) return { x, y: y + h, width: h, height: w, rotate: -90 };
  if (rot === 180) return { x: x + w, y: y + h, width: w, height: h, rotate: 180 };
  if (rot === 270) return { x: x + w, y, width: h, height: w, rotate: 90 };
  return { x, y, width: w, height: h, rotate: 0 };
}

async function orientationOf(bytes) {
  try { const o = await require('exifr').orientation(bytes); return ROTATION_FOR_ORIENTATION[o] || 0; } catch { return 0; }
}

/**
 * Pictures -> PDF. opts: { pageSize, orientation, autoRotate (default true), combine (default true), outDir, outFile }
 * decode(file): PNG bytes for formats other than JPEG/PNG (WebP, BMP, GIF: drawn by the helper window).
 * Returns { outputs, pages, rotated }.
 */
async function imagesToPdf(files, opts = {}, { decode = null } = {}) {
  const { PDFDocument, degrees } = require('pdf-lib');
  const { pageSize = 'fit', orientation = 'auto', autoRotate = true, combine = true, outDir = null, outFile = null } = opts;
  if (!files.length) throw new Error('Choose some pictures first.');
  const heic = files.filter((f) => HEIC.test(f));
  if (heic.length) throw new Error(`${heic.map((f) => path.basename(f)).join(', ')}: ${HEIC_MESSAGE}`);
  let rotated = 0;
  const addTo = async (doc, f) => {
    // a copy: small files read by Node share a bigger memory block, which the PDF library's JPEG reader trips over
    let bytes = new Uint8Array(fs.readFileSync(f));
    const jpeg = /\.jpe?g$/i.test(f) || (bytes[0] === 0xff && bytes[1] === 0xd8);
    const png = !jpeg && (/\.png$/i.test(f) || String.fromCharCode(bytes[1], bytes[2], bytes[3]) === 'PNG');
    let rot = 0;
    if (jpeg && autoRotate) { rot = await orientationOf(bytes); if (rot) rotated++; }
    if (!jpeg && !png) {
      if (!decode) throw new Error(`${path.basename(f)}: this kind of picture can't be converted here.`);
      bytes = new Uint8Array(await decode(f));
    }
    const img = jpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const { page, box } = layoutImage(img.width, img.height, rot, { pageSize, orientation });
    const pg = doc.addPage(page);
    const s = drawSpec(box, rot);
    pg.drawImage(img, { x: s.x, y: s.y, width: s.width, height: s.height, rotate: degrees(s.rotate) });
  };
  const outputs = [];
  if (combine) {
    const doc = await PDFDocument.create();
    for (const f of files) await addTo(doc, f);
    const dest = outFile || uniquePath(path.join(outDir || path.dirname(files[0]), `${path.parse(files[0]).name}${files.length > 1 ? ' (combined)' : ''}.pdf`));
    fs.writeFileSync(dest, await doc.save());
    outputs.push(dest);
  } else {
    for (const f of files) {
      const doc = await PDFDocument.create();
      await addTo(doc, f);
      const dest = uniquePath(path.join(outDir || path.dirname(f), `${path.parse(f).name}.pdf`));
      fs.writeFileSync(dest, await doc.save());
      outputs.push(dest);
    }
  }
  return { outputs, pages: files.length, rotated };
}

module.exports = {
  HEIC_MESSAGE, PAGE_SIZES, ROTATION_FOR_ORIENTATION, NoTablesError,
  uniquePath, readPages, linesFromItems, pagesToText, pdfToText, cellsOf, detectTables, toCsv, asNumber, xlsxBytes, pdfToTable,
  paragraphsFromLines, pdfToDocx, layoutImage, drawSpec, orientationOf, imagesToPdf,
};
