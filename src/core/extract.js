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

function canExtract(file) {
  const ext = path.extname(file).toLowerCase();
  return TEXT_EXT.has(ext) || HTML_EXT.has(ext) || ['.pdf', '.docx', '.eml'].includes(ext) || (IMAGE_EXT.has(ext) && !!ocr?.image);
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
