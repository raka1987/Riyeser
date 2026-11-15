// Keeps a searchable index of file names AND their contents, so "acme invoice march" finds the right PDF.
const fs = require('fs');
const path = require('path');
const { extractText, canExtract } = require('./extract');
const { classify } = require('./classifier');

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
    const results = [];
    for (const [p, d] of Object.entries(this.docs)) {
      const name = d.name.toLowerCase();
      const meta = `${d.company || ''} ${d.docType || ''} ${d.dir}`.toLowerCase();
      const text = (d.text || '').toLowerCase();
      let score = 0;
      let ok = true;
      let snippetAt = -1;
      for (const t of terms) {
        if (name.includes(t)) score += name.startsWith(t) ? 12 : 8;
        else if (meta.includes(t)) score += 5;
        else {
          const at = text.indexOf(t);
          if (at < 0) { ok = false; break; }
          score += 2;
          if (snippetAt < 0) snippetAt = at;
        }
      }
      if (!ok) continue;
      score += Math.max(0, 3 - (Date.now() - d.mtime) / (1000 * 60 * 60 * 24 * 60)); // slight boost for recent files
      const snippet = snippetAt >= 0 ? d.text.slice(Math.max(0, snippetAt - 60), snippetAt + 100).replace(/\s+/g, ' ') : '';
      results.push({ path: p, name: d.name, dir: d.dir, company: d.company, docType: d.docType, mtime: d.mtime, size: d.size, score, snippet });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
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

module.exports = { Index };
