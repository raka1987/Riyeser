// Scans messy folders (Downloads, Desktop, a synced phone folder...) and proposes where each file should go.
// Nothing moves until the user approves a plan, and every move can be undone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractText } = require('./extract');
const { classify } = require('./classifier');
const { extractDetails, suggestName, typeMismatch } = require('./details');

const SKIP_EXT = new Set(['.crdownload', '.part', '.tmp', '.download', '.partial', '.lnk', '.ini']);

function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Unknown';
}

function targetDir(root, c) {
  if (c.category === 'Media') return path.join(root, 'Media', c.docType);
  if (c.company) return path.join(root, safeName(c.companyType || 'Companies'), safeName(c.company), safeName(c.docType));
  if (c.category === 'General') return path.join(root, 'General', safeName(c.docType));
  return null; // unsure -> leave it where it is and ask the user
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, `${name}-${Date.now()}${ext}`);
}

function listFiles(folder, { recursive = false, maxFiles = 2000 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (recursive && depth < 4) walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
      out.push(full);
    }
  };
  walk(folder, 0);
  return out;
}

async function classifyFile(file, settings, ai) {
  const ext = path.extname(file).toLowerCase();
  const text = await extractText(file);
  let c = classify({ fileName: path.basename(file), ext, text }, settings);
  if (ai && c.confidence !== 'high' && c.category !== 'Media' && text) {
    try {
      const better = await ai.classify(path.basename(file), text, settings);
      if (better) c = { ...c, ...better, reasons: [...(better.reasons || []), 'refined by AI'] };
    } catch (e) { c.reasons.push(`AI unavailable: ${e.message}`); }
  }
  return { c, text };
}

/** Build a plan of proposed moves. Files younger than `minAgeMs` are skipped (probably still downloading/in use). */
async function planOrganise(settings, { ai = null, onProgress = () => {}, minAgeMs = 60_000 } = {}) {
  const root = settings.organisedRoot;
  const plan = [];
  const review = [];
  const folders = settings.watchFolders || [];
  const files = folders.flatMap((f) => listFiles(f, { recursive: !!settings.recursiveScan }))
    .filter((f) => !f.startsWith(root + path.sep));
  let i = 0;
  for (const file of files) {
    onProgress(++i, files.length, file);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (Date.now() - stat.mtimeMs < minAgeMs) continue;
    const { c, text } = await classifyFile(file, settings, ai);
    const name = path.basename(file);
    const ext = path.extname(file);
    const details = extractDetails(text, name, { dayFirst: settings.dayFirstDates !== false });
    const fileDate = new Date(stat.mtimeMs).toISOString().slice(0, 10);
    const newName = settings.renameFiles === false ? null : suggestName({ fileName: name, ext, classification: c, details, fallbackDate: fileDate });
    const warning = c.category === 'Media' ? null : typeMismatch(name, text);
    let dir = targetDir(root, c);
    if (dir && settings.groupByYear) dir = path.join(dir, (details.date || fileDate).slice(0, 4));
    const item = {
      from: file, name, size: stat.size, ...c, details, newName, warning,
      preview: (text || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    };
    if (!dir || (c.confidence === 'low' && c.category !== 'Media')) review.push({ ...item, suggestedDir: dir });
    else plan.push({ ...item, dir, to: path.join(dir, newName || name) });
  }
  return { plan, review, scanned: files.length };
}

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const dest = uniquePath(to);
  try { fs.renameSync(from, dest); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e; // different drive: copy then delete
    fs.copyFileSync(from, dest);
    fs.unlinkSync(from);
  }
  return dest;
}

/** Carry out approved moves. Returns a batch record that can be passed to undo(). */
function applyPlan(items) {
  const batch = { id: Date.now().toString(36), at: new Date().toISOString(), moves: [], errors: [] };
  for (const it of items) {
    try {
      if (!fs.existsSync(it.from)) throw new Error('file no longer exists');
      const dest = moveFile(it.from, it.to);
      batch.moves.push({ from: it.from, to: dest });
    } catch (e) { batch.errors.push({ from: it.from, error: e.message }); }
  }
  return batch;
}

function undoBatch(batch) {
  const errors = [];
  for (const m of [...batch.moves].reverse()) {
    try { if (fs.existsSync(m.to)) moveFile(m.to, m.from); else errors.push({ file: m.to, error: 'missing' }); }
    catch (e) { errors.push({ file: m.to, error: e.message }); }
  }
  return errors;
}

/** Find exact duplicate files (same size + same content hash). */
function findDuplicates(folders) {
  const bySize = new Map();
  for (const f of folders.flatMap((d) => listFiles(d, { recursive: true, maxFiles: 20000 }))) {
    try {
      const s = fs.statSync(f).size;
      if (s < 1024) continue;
      if (!bySize.has(s)) bySize.set(s, []);
      bySize.get(s).push(f);
    } catch { /* ignore */ }
  }
  const groups = [];
  for (const [size, files] of bySize) {
    if (files.length < 2) continue;
    const byHash = new Map();
    for (const f of files) {
      try {
        const h = crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(f);
      } catch { /* ignore */ }
    }
    for (const g of byHash.values()) if (g.length > 1) groups.push({ size, files: g });
  }
  return groups.sort((a, b) => b.size * b.files.length - a.size * a.files.length);
}

module.exports = { planOrganise, applyPlan, undoBatch, findDuplicates, listFiles, targetDir, classifyFile, moveFile };
