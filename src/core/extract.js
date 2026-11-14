// Pulls plain text out of common document types so they can be classified and searched.
const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log', '.rtf', '.xml', '.tsv', '.ics']);
const HTML_EXT = new Set(['.html', '.htm']);
const MAX_BYTES = 25 * 1024 * 1024; // skip giant files
const MAX_CHARS = 20000;            // only keep the start of the text

function clip(s) {
  return (s || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').slice(0, MAX_CHARS);
}

function canExtract(file) {
  const ext = path.extname(file).toLowerCase();
  return TEXT_EXT.has(ext) || HTML_EXT.has(ext) || ['.pdf', '.docx', '.eml'].includes(ext);
}

async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  let stat;
  try { stat = fs.statSync(file); } catch { return ''; }
  if (!stat.isFile() || stat.size > MAX_BYTES) return '';
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
      try { await (doc.destroy || doc.cleanup)?.call(doc); } catch { /* ignore */ }
      return clip(parts.join('\n'));
    }
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ path: file });
      return clip(r.value);
    }
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

module.exports = { extractText, canExtract };
