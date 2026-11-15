// Pulls plain text out of common document types so they can be classified and searched.
const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log', '.rtf', '.xml', '.tsv', '.ics']);
const HTML_EXT = new Set(['.html', '.htm']);
const MAX_BYTES = 25 * 1024 * 1024; // skip giant files
const MAX_CHARS = 20000;            // only keep the start of the text

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.bmp', '.tif', '.tiff']);

// OCR is plugged in by the app (it needs a window to draw PDF pages). Without it, scans simply have no text.
// provider = { pdf: async (file) => text, image: async (file) => text | null }
let ocr = null;
function setOcrProvider(provider) { ocr = provider; }
// Optional: text already read before (e.g. by the search index), keyed by file + modified time - avoids reading it twice.
let textCache = null;
function setTextCache(fn) { textCache = fn; }

function clip(s) {
  return (s || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').slice(0, MAX_CHARS);
}

// Office files are zip archives of XML: Excel (.xlsx), PowerPoint (.pptx), OpenDocument (.ods/.odt/.odp)
const OFFICE_ZIP = new Set(['.xlsx', '.xlsm', '.pptx', '.ods', '.odt', '.odp']);
const xmlText = (xml) => xml.replace(/<\/(a:p|w:p|text:p|row|si|c|text:h)>/g, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

async function officeText(file, ext) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const read = async (name) => (zip.file(name) ? zip.file(name).async('string') : '');
  if (ext === '.xlsx' || ext === '.xlsm') {
    // Sheet names, shared strings (the text in cells) and the cells of the first few sheets, row by row.
    const parts = [];
    const wb = await read('xl/workbook.xml');
    parts.push([...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => `Sheet: ${m[1]}`).join('\n'));
    const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]).replace(/\s+/g, ' ').trim());
    const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort().slice(0, 3);
    for (const sh of sheets) {
      const xml = await read(sh);
      for (const row of xml.match(/<row[\s\S]*?<\/row>/g) || []) {
        const cells = [...row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
          const v = (c[2] || '').match(/<v>([\s\S]*?)<\/v>/); const inline = (c[2] || '').match(/<is>([\s\S]*?)<\/is>/);
          if (/t="s"/.test(c[1]) && v) return shared[+v[1]] || '';
          if (inline) return xmlText(inline[1]).trim();
          return v ? v[1] : '';
        }).filter(Boolean);
        if (cells.length) parts.push(cells.join(' | '));
        if (parts.length > 400) break;
      }
    }
    return parts.join('\n');
  }
  if (ext === '.pptx') {
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).slice(0, 15);
    return (await Promise.all(slides.map(read))).map(xmlText).join('\n');
  }
  return xmlText(await read('content.xml')); // OpenDocument
}

function canExtract(file) {
  const ext = path.extname(file).toLowerCase();
  return TEXT_EXT.has(ext) || HTML_EXT.has(ext) || OFFICE_ZIP.has(ext) || ['.pdf', '.docx', '.eml'].includes(ext) || (IMAGE_EXT.has(ext) && !!ocr?.image);
}

async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  let stat;
  try { stat = fs.statSync(file); } catch { return ''; }
  if (!stat.isFile() || stat.size > MAX_BYTES) return '';
  if (textCache) { const cached = textCache(file, stat.mtimeMs); if (typeof cached === 'string') return cached; }
  try {
    if (TEXT_EXT.has(ext)) return clip(fs.readFileSync(file, 'utf8'));
    if (HTML_EXT.has(ext)) return clip(fs.readFileSync(file, 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
    if (ext === '.pdf') {
      const { getDocumentProxy } = await import('unpdf');
      const doc = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
      const parts = [];
      for (let i = 1; i <= Math.min(doc.numPages, 5); i++) { // first 5 pages is plenty to classify
        const content = await (await doc.getPage(i)).getTextContent();
        parts.push(content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
      }
      const pages = doc.numPages;
      try { await (doc.destroy || doc.cleanup)?.call(doc); } catch { /* ignore */ }
      const text = parts.join('\n');
      // Hardly any text? It's probably a scan - read it with OCR instead.
      if (ocr?.pdf && text.replace(/\s/g, '').length < 25 * Math.min(pages, 5)) {
        const scanned = await ocr.pdf(file).catch(() => '');
        if (scanned && scanned.trim()) return clip(scanned);
      }
      return clip(text);
    }
    if (OFFICE_ZIP.has(ext)) return clip((await officeText(file, ext)).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n'));
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ path: file });
      return clip(r.value);
    }
    if (IMAGE_EXT.has(ext) && ocr?.image) return clip((await ocr.image(file).catch(() => '')) || '');
    if (ext === '.eml') {
      const { simpleParser } = require('mailparser');
      const m = await simpleParser(fs.readFileSync(file));
      return clip(`From: ${m.from?.text || ''}\nSubject: ${m.subject || ''}\n\n${m.text || ''}`);
    }
  } catch {
    return '';
  }
  return '';
}

module.exports = { extractText, canExtract, setOcrProvider, setTextCache, IMAGE_EXT };
