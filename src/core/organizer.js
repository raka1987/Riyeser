// Scans messy folders (Downloads, Desktop, a synced phone folder...) and proposes where each file should go.
// Nothing moves until the user approves a plan, and every move can be undone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractText } = require('./extract');
const { classify } = require('./classifier');
const { extractDetails, suggestName, typeMismatch } = require('./details');
const { extractKeys, linkRelated } = require('./related');

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

function listFiles(folder, { recursive = false, maxFiles = 2000, maxDepth = 4 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (recursive && depth < maxDepth) walk(full, depth + 1); continue; }
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

/** Read and classify one file (no decision yet about where it goes). */
async function analyseFile(file, stat, settings, ai) {
  const { c, text } = await classifyFile(file, settings, ai);
  const name = path.basename(file);
  return {
    from: file, name, ext: path.extname(file), size: stat.size, ...c,
    details: extractDetails(text, name, { dayFirst: settings.dayFirstDates !== false }),
    fileDate: new Date(stat.mtimeMs).toISOString().slice(0, 10),
    warning: c.category === 'Media' ? null : typeMismatch(name, text),
    keys: c.category === 'Media' ? [] : extractKeys(text, name),
    preview: (text || '').replace(/\s+/g, ' ').trim().slice(0, 400),
  };
}

/** Decide the folder and name for an analysed file. Related documents get their own project folder. */
function placeItem(item, settings) {
  const root = settings.organisedRoot;
  if (item.company && !item.companyType) {
    const known = (settings.companies || []).find((c) => c.name.toLowerCase() === item.company.toLowerCase());
    item.companyType = known ? (known.type || 'Companies') : 'Companies';
  }
  if (item.company && item.category !== 'Media') item.category = 'Company';
  if (item.companyFromGroup && item.confidence === 'low') {
    item.confidence = 'medium';
    item.reasons = [...(item.reasons || []), `linked to other ${item.company} documents`];
  }
  const grouped = item.group && item.company && settings.groupRelated !== false;
  let dir;
  if (grouped) dir = path.join(root, safeName(item.companyType), safeName(item.company), 'Projects', safeName(item.group.name));
  else {
    dir = targetDir(root, item);
    if (dir && settings.groupByYear) dir = path.join(dir, (item.details.date || item.fileDate).slice(0, 4));
  }
  item.newName = settings.renameFiles === false ? null
    : suggestName({ fileName: item.name, ext: item.ext, classification: item, details: item.details, fallbackDate: item.fileDate });
  const unsure = !dir || (!grouped && item.confidence === 'low' && item.category !== 'Media');
  return { dir, unsure, to: dir ? path.join(dir, item.newName || item.name) : null };
}

/** The folders the user can tick: each watched folder (its loose files) and the sub-folders inside it. */
function scanFolders(settings) {
  const sel = settings.scanSelection || {};
  const out = [];
  for (const root of settings.watchFolders || []) {
    if (!fs.existsSync(root)) continue;
    const loose = listFiles(root).length;
    out.push({ path: root, name: path.basename(root), isRoot: true, files: loose, checked: sel[root] !== false });
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const full = path.join(root, e.name);
      if (settings.organisedRoot && (full === settings.organisedRoot || settings.organisedRoot.startsWith(full + path.sep))) continue;
      out.push({ path: full, name: e.name, parent: root, isRoot: false, files: listFiles(full, { recursive: true, maxDepth: 6, maxFiles: 500 }).length, checked: full in sel ? !!sel[full] : !!settings.recursiveScan });
    }
  }
  return out;
}

/** Build a plan of proposed moves. Files younger than `minAgeMs` are skipped (probably still downloading/in use). */
async function planOrganise(settings, { ai = null, onProgress = () => {}, minAgeMs = 60_000 } = {}) {
  const root = settings.organisedRoot;
  const plan = [];
  const review = [];
  const chosen = scanFolders(settings).filter((f) => f.checked);
  const files = [...new Set(chosen.flatMap((f) => listFiles(f.path, f.isRoot ? {} : { recursive: true, maxDepth: 6 })))]
    .filter((f) => !f.startsWith(root + path.sep));
  const items = [];
  let i = 0;
  for (const file of files) {
    onProgress(++i, files.length, file);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (Date.now() - stat.mtimeMs < minAgeMs) continue;
    items.push(await analyseFile(file, stat, settings, ai));
  }
  // Keep related documents (quote + invoice + receipt for the same job...) together.
  if (settings.groupRelated !== false) linkRelated(items);
  for (const item of items) {
    const { dir, unsure, to } = placeItem(item, settings);
    if (unsure) review.push({ ...item, suggestedDir: dir });
    else plan.push({ ...item, dir, to });
  }
  return { mode: 'tidy', plan, review, scanned: files.length, emptyFolderCleanup: chosen.filter((f) => !f.isRoot).map((f) => f.path) };
}

/**
 * Re-check files that are already in the Organised folder: suggest better names, fix anything in the wrong place,
 * and bring related documents together. Files we're unsure about are left alone - you may have put them there on purpose.
 */
async function planRecheck(settings, { ai = null, onProgress = () => {} } = {}) {
  const root = settings.organisedRoot;
  const plan = [];
  const files = fs.existsSync(root) ? listFiles(root, { recursive: true, maxDepth: 8, maxFiles: 20000 }) : [];
  const items = [];
  let i = 0;
  for (const file of files) {
    onProgress(++i, files.length, file);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    items.push(await analyseFile(file, stat, settings, ai));
  }
  if (settings.groupRelated !== false) linkRelated(items);
  for (const item of items) {
    const { dir, unsure, to } = placeItem(item, settings);
    if (unsure || !to) continue;
    if (path.resolve(to).toLowerCase() === path.resolve(item.from).toLowerCase()) continue;
    const sameFolder = path.resolve(dir).toLowerCase() === path.resolve(path.dirname(item.from)).toLowerCase();
    plan.push({ ...item, dir, to, change: sameFolder ? 'rename' : (item.newName ? 'move + rename' : 'move'), currentDir: path.dirname(item.from) });
  }
  return { mode: 'recheck', plan, review: [], scanned: files.length };
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

/** Delete folders left empty after files were moved out (never the root itself). */
function removeEmptyDirs(root, { includeRoot = false } = {}) {
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    let empty = true;
    for (const e of entries) {
      if (e.isDirectory()) { if (!walk(path.join(dir, e.name))) empty = false; }
      else empty = false;
    }
    if (empty && (dir !== root || includeRoot)) { try { fs.rmdirSync(dir); } catch { return false; } }
    return empty;
  };
  if (fs.existsSync(root)) walk(root);
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

module.exports = { planOrganise, planRecheck, scanFolders, removeEmptyDirs, applyPlan, undoBatch, findDuplicates, listFiles, targetDir, classifyFile, moveFile };
