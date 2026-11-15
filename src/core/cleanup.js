// Looks through a folder (normally Downloads) for things you probably don't need any more,
// and explains why. Nothing is deleted here: the app only ever moves approved items to the Recycle Bin.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractText, canExtract } = require('./extract');
const { classify } = require('./classifier');

const DAY = 86400_000;
const INSTALLER = new Set(['.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.apk', '.msix']);
const ARCHIVE = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz']);
const PARTIAL = new Set(['.crdownload', '.part', '.partial', '.download', '.tmp']);
const IMPORTANT_TYPES = new Set(['Invoices', 'Receipts', 'Contracts', 'Statements', 'Payslips', 'Tax', 'Insurance', 'Purchase Orders', 'Quotes']);

const hashCache = new Map();
function hashFile(file) {
  try {
    const st = fs.statSync(file);
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    if (hashCache.has(key)) return hashCache.get(key);
    const h = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    hashCache.set(key, h);
    return h;
  } catch { return null; }
}

/** Size, and when anything inside a folder was last touched (stops after `limit` files). */
function folderInfo(dir, limit = 3000) {
  let size = 0; let last = 0; let count = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count > limit) return;
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else { const st = fs.statSync(full); size += st.size; last = Math.max(last, st.mtimeMs, st.birthtimeMs || 0); count++; }
      } catch { /* ignore */ }
    }
  };
  walk(dir);
  return { size, last, count };
}

/** Build a map of size -> [hash] for files already in the Organised folder, to spot copies that are already filed. */
function organisedFingerprints(root) {
  const bySize = new Map();
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        try { const s = fs.statSync(full).size; if (!bySize.has(s)) bySize.set(s, []); bySize.get(s).push(full); } catch { /* ignore */ }
      }
    }
  };
  if (root && fs.existsSync(root)) walk(root, 0);
  return bySize;
}

/**
 * Review every item in `folder`.
 * Returns [{ path, name, isDir, size, lastUsed, ageDays, verdict: 'delete'|'review'|'keep', reason, copyOf? }]
 * - delete: very likely safe to remove (installer already run, extracted zip, unfinished download, copy already filed)
 * - review: not used for a long time; your call
 * - keep:   looks important (invoice, contract...) or recently used
 */
async function analyseFolder(folder, { organisedRoot, staleDays = 90, ignore = [], settings = {}, now = Date.now(), onProgress = () => {} } = {}) {
  let entries;
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
  entries = entries.filter((e) => !e.name.startsWith('.') && e.name !== 'desktop.ini' && !ignore.includes(path.join(folder, e.name)));
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  const filed = organisedFingerprints(organisedRoot);
  const out = [];
  let i = 0;

  for (const e of entries) {
    onProgress(++i, entries.length);
    const full = path.join(folder, e.name);
    const ext = path.extname(e.name).toLowerCase();
    let st;
    try { st = fs.statSync(full); } catch { continue; }

    if (e.isDirectory()) {
      const info = folderInfo(full);
      const lastUsed = Math.max(info.last, st.mtimeMs);
      const ageDays = Math.floor((now - lastUsed) / DAY);
      const fromZip = [...ARCHIVE].some((x) => names.has(e.name.toLowerCase() + x));
      out.push({
        path: full, name: e.name, isDir: true, size: info.size, files: info.count, lastUsed, ageDays,
        verdict: ageDays >= staleDays ? 'review' : 'keep',
        reason: ageDays >= staleDays ? `Folder with ${info.count} file(s), nothing in it used for ${ageDays} days${fromZip ? ' (unzipped from a download)' : ''}` : `Used in the last ${staleDays} days`,
      });
      continue;
    }
    if (!e.isFile()) continue;

    // "Last used" = when it was downloaded or last changed. (Windows' "last opened" time is unreliable -
    // antivirus and search indexing touch it - so we don't rely on it.)
    const lastUsed = Math.max(st.mtimeMs, st.birthtimeMs || 0);
    const ageDays = Math.floor((now - lastUsed) / DAY);
    const item = { path: full, name: e.name, isDir: false, size: st.size, lastUsed, ageDays };

    if (PARTIAL.has(ext) && now - st.mtimeMs > DAY) {
      out.push({ ...item, verdict: 'delete', reason: 'Unfinished download that never completed' });
      continue;
    }

    // Already filed? (exact same contents in the Organised folder)
    const sameSize = filed.get(st.size);
    if (sameSize && st.size > 0) {
      const h = hashFile(full);
      const match = h && sameSize.find((f) => hashFile(f) === h);
      if (match) { out.push({ ...item, verdict: 'delete', reason: 'An identical copy is already filed', copyOf: match }); continue; }
    }

    if (INSTALLER.has(ext) && ageDays >= 7) {
      out.push({ ...item, verdict: 'delete', reason: `Installer downloaded ${ageDays} days ago - once a program is installed the installer isn't needed (you can download it again)` });
      continue;
    }
    if (ARCHIVE.has(ext)) {
      const base = e.name.slice(0, -ext.length).toLowerCase();
      if (names.has(base)) { out.push({ ...item, verdict: 'delete', reason: `Already unzipped into the “${e.name.slice(0, -ext.length)}” folder` }); continue; }
    }

    // Does it look important? Read it to find out.
    let important = null;
    if (canExtract(full) || ['.pdf', '.docx'].includes(ext)) {
      const text = await extractText(full);
      const c = classify({ fileName: e.name, ext, text }, settings);
      if (IMPORTANT_TYPES.has(c.docType) && c.confidence !== 'low') important = `${c.docType.replace(/s$/, '')}${c.company ? ` for ${c.company}` : ''} - file it rather than delete it`;
    }
    if (important) { out.push({ ...item, verdict: 'keep', reason: important }); continue; }

    if (ageDays >= staleDays) out.push({ ...item, verdict: 'review', reason: `Downloaded or last changed ${ageDays} days ago` });
    else out.push({ ...item, verdict: 'keep', reason: `Used in the last ${staleDays} days` });
  }

  const order = { delete: 0, review: 1, keep: 2 };
  return out.sort((a, b) => order[a.verdict] - order[b.verdict] || b.size - a.size);
}

module.exports = { analyseFolder };
