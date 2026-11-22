// Keeps a searchable index of file names AND their contents, so "acme invoice march" finds the right PDF.
const fs = require('fs');
const path = require('path');
const { extractText, canExtract } = require('./extract');
const { classify } = require('./classifier');
const { extractDetails } = require('./details');

/** Kind of file, for the search filters. */
function kindFor(ext) {
  const e = (ext || '').toLowerCase();
  if (e === '.pdf') return 'PDFs';
  if (/^\.(docx?|odt|rtf|pages)$/.test(e)) return 'Word';
  if (/^\.(xlsx?|xlsm|ods|csv|numbers)$/.test(e)) return 'Excel';
  if (/^\.(pptx?|odp|key)$/.test(e)) return 'PowerPoint';
  if (/^\.(jpe?g|png|gif|heic|webp|bmp|tiff?|svg)$/.test(e)) return 'Pictures';
  if (/^\.(mp4|mov|avi|mkv|webm|m4v)$/.test(e)) return 'Videos';
  if (/^\.(eml|msg)$/.test(e)) return 'Emails';
  if (/^\.(zip|rar|7z|gz)$/.test(e)) return 'Zip files';
  if (/^\.(txt|md|log)$/.test(e)) return 'Text';
  return 'Other';
}
const yearIn = (p) => { const m = String(p).split(/[\\/]/).reverse().find((x) => /^(19|20)\d{2}$/.test(x)); return m || null; };
const TYPE_LABEL = { 'Plans & Drawings': 'Drawings' };

const SKIP_DIRS = new Set(['node_modules', '.git', 'AppData', 'Library', '$RECYCLE.BIN', 'System Volume Information', '.cache', '.Trash', 'venv', '__pycache__']);

class Index {
  constructor(store) {
    this.store = store;
    this.docs = store.get('index', {}); // path -> { name, dir, ext, mtime, size, text, company, docType }
  }

  save() { this.store.set('index', this.docs); }

  async indexFile(file, settings) {
    let st;
    try { st = fs.statSync(file); } catch { delete this.docs[file]; return; }
    const prev = this.docs[file];
    if (prev && prev.mtime === st.mtimeMs) return; // unchanged
    const ext = path.extname(file).toLowerCase();
    const text = canExtract(file) && st.size < 15 * 1024 * 1024 ? await extractText(file) : '';
    const c = classify({ fileName: path.basename(file), ext, text }, settings);
    this.docs[file] = {
      name: path.basename(file), dir: path.dirname(file), ext, mtime: st.mtimeMs, size: st.size,
      text: text.slice(0, 6000), company: c.company, docType: c.docType,
      year: (() => { const d = extractDetails(text, path.basename(file)); return (d.date || d.month || '').slice(0, 4) || yearIn(file) || String(new Date(st.mtimeMs).getFullYear()); })(),
      ...(prev && prev.formerNames ? { formerNames: prev.formerNames } : {}),
    };
  }

  async rebuild(folders, settings, onProgress = () => {}) {
    const files = [];
    const walk = (dir, depth) => {
      if (depth > 7 || files.length > 50000) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        if (e.isDirectory() && require('./safety').isSystemPath(path.join(dir, e.name))) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile()) files.push(full);
      }
    };
    for (const f of folders) walk(f, 0);
    const live = new Set(files);
    for (const p of Object.keys(this.docs)) if (!live.has(p)) delete this.docs[p];
    let i = 0;
    for (const f of files) {
      await this.indexFile(f, settings);
      if (++i % 25 === 0) onProgress(i, files.length);
    }
    onProgress(files.length, files.length);
    this.save();
    return files.length;
  }

  remove(file) { delete this.docs[file]; }

  /** Ranked search. Every word must match somewhere; matches in the name count most. */
  search(query, limit = 30) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    // match the start of words: "ark" finds "Ark project" but not "Spark"
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const res = terms.map((t) => new RegExp(`(^|[^a-z0-9])${esc(t)}`));
    const results = [];
    for (const [p, d] of Object.entries(this.docs)) {
      const name = d.name.toLowerCase();
      const meta = `${d.company || ''} ${d.docType || ''} ${d.dir} ${(d.formerNames || []).join(' ')}`.toLowerCase(); // old names still find it
      const text = (d.text || '').toLowerCase();
      let score = 0;
      let ok = true;
      let snippetAt = -1;
      for (const [k, t] of terms.entries()) {
        const re = res[k];
        if (re.test(name)) score += name.startsWith(t) ? 12 : 8;
        else if (re.test(meta)) score += 5;
        else {
          const m = re.exec(text);
          const at = m ? m.index + m[1].length : -1;
          if (at < 0) { ok = false; break; }
          score += 2;
          if (snippetAt < 0) snippetAt = at;
        }
      }
      if (!ok) continue;
      score += Math.max(0, 3 - (Date.now() - d.mtime) / (1000 * 60 * 60 * 24 * 60)); // slight boost for recent files
      const snippet = snippetAt >= 0 ? d.text.slice(Math.max(0, snippetAt - 60), snippetAt + 100).replace(/\s+/g, ' ') : '';
      results.push({ path: p, name: d.name, formerNames: d.formerNames || [], dir: d.dir, company: d.company, docType: d.docType, mtime: d.mtime, size: d.size, score, snippet });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Search with filters. q may be empty (then it lists the newest files). type/year/kind narrow the results.
   * Returns { results, total, facets: { type: {label: n}, year: {...}, kind: {...} } } - facets count the files matching q.
   * Inside Organised, the folder a file is filed in (Invoices, Drawings...) is its type.
   */
  find({ q = '', type = null, year = null, kind = null, limit = 200 } = {}, { organisedRoot = '' } = {}) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const res = terms.map((t) => new RegExp(`(^|[^a-z0-9])${esc(t)}`));
    const root = organisedRoot ? path.resolve(organisedRoot) + path.sep : null;
    const facets = { type: {}, year: {}, kind: {} };
    const hits = [];
    for (const [p, d] of Object.entries(this.docs)) {
      let score = 0; let snippetAt = -1; let ok = true;
      if (terms.length) {
        const name = d.name.toLowerCase();
        const meta = `${d.company || ''} ${d.docType || ''} ${d.dir} ${(d.formerNames || []).join(' ')}`.toLowerCase();
        const text = (d.text || '').toLowerCase();
        for (const [k, t] of terms.entries()) {
          const re = res[k];
          if (re.test(name)) score += name.startsWith(t) ? 12 : 8;
          else if (re.test(meta)) score += 5;
          else { const m = re.exec(text); if (!m) { ok = false; break; } score += 2; if (snippetAt < 0) snippetAt = m.index + m[1].length; }
        }
        if (!ok) continue;
      }
      const filedAs = root && p.startsWith(root) ? p.slice(root.length).split(/[\\/]/)[0] : null;
      const t = filedAs && !/^(Archive|Other)$/i.test(filedAs) && !/^(19|20)\d{2}$/.test(filedAs) ? filedAs
        : (d.docType && d.docType !== 'Other' ? (TYPE_LABEL[d.docType] || d.docType) : 'Not sure');
      const y = d.year || yearIn(p) || String(new Date(d.mtime).getFullYear());
      const kd = kindFor(d.ext);
      facets.type[t] = (facets.type[t] || 0) + 1; facets.year[y] = (facets.year[y] || 0) + 1; facets.kind[kd] = (facets.kind[kd] || 0) + 1;
      if ((type && t !== type) || (year && y !== year) || (kind && kd !== kind)) continue;
      score += Math.max(0, 3 - (Date.now() - d.mtime) / (1000 * 60 * 60 * 24 * 60));
      const snippet = snippetAt >= 0 ? d.text.slice(Math.max(0, snippetAt - 60), snippetAt + 100).replace(/\s+/g, ' ') : '';
      hits.push({ path: p, name: d.name, formerNames: d.formerNames || [], dir: d.dir, company: d.company, type: t, year: y, kind: kd, mtime: d.mtime, size: d.size, score, snippet });
    }
    hits.sort((a, b) => (terms.length ? b.score - a.score : b.mtime - a.mtime));
    return { results: hits.slice(0, limit), total: hits.length, facets };
  }

  byCompany(company, limit = 8) {
    const c = company.toLowerCase();
    return Object.entries(this.docs)
      .filter(([, d]) => (d.company || '').toLowerCase() === c || d.dir.toLowerCase().includes(path.sep + c))
      .sort((a, b) => b[1].mtime - a[1].mtime).slice(0, limit)
      .map(([p, d]) => ({ path: p, name: d.name, docType: d.docType, mtime: d.mtime }));
  }

  get size() { return Object.keys(this.docs).length; }
}

module.exports = { Index, kindFor };
