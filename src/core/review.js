// "Smart review": reads every file in the chosen folders and, for each one, suggests
//  - a label (what it is, who it's for/from, its date)
//  - a clear new name that starts with the document's own date
//  - the folder it belongs in
// and finds duplicates (even with different names or formats). Nothing changes until the user approves.
const fs = require('fs');
const path = require('path');
const { analyseFile, placeItem, listFiles, inArchive } = require('./organizer');
const { linkRelated } = require('./related');
const { smartName, drawingNumber } = require('./details');
const { findDuplicateGroups } = require('./dupes');
const { isSystemPath, isTooBroad } = require('./safety');

const PER_FILE_MS = 90_000; // a file that takes longer than this (e.g. a stuck AI call or scan) is skipped
const withLimit = (promise, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('took too long')), ms);
  promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const tick = () => new Promise((r) => setImmediate(r));
const inside = (p, root) => !!root && (p === root || p.startsWith(root + path.sep));

async function reviewFiles(folders, settings, { ai = null, onProgress = () => {}, isCancelled = () => false, maxFiles = 5000, perFileMs = PER_FILE_MS, log = () => {}, cloudOnly = new Set() } = {}) {
  const t0 = Date.now();
  const root = settings.organisedRoot;
  const placed = new Set(settings._placedByApp || []);
  const seen = new Set();
  for (const f of folders) {
    if (!f || !fs.existsSync(f) || isSystemPath(f) || isTooBroad(f)) continue;
    for (const file of listFiles(f, { recursive: true, maxDepth: 8, maxFiles })) if (!inArchive(file, settings.organisedRoot)) seen.add(file); // archived files are left alone
  }
  const files = [...seen];
  // With AI switched on, every document gets a second opinion (not only the unsure ones).
  const s = { ...settings, groupByYear: true, renameFiles: true, aiCheckAll: !!ai || settings.aiCheckAll };
  const items = []; const skipped = [];
  let i = 0;
  for (const file of files.slice(0, maxFiles)) {
    if (isCancelled()) break;
    onProgress(++i, files.length, file);
    if (cloudOnly.has(file)) { skipped.push({ path: file, name: path.basename(file), reason: 'online-only', cloud: true }); continue; }
    let st; try { st = fs.statSync(file); } catch { continue; }
    const t1 = Date.now();
    try { items.push({ ...(await withLimit(analyseFile(file, st, s, ai, { keepText: true }), perFileMs)), mtime: st.mtimeMs }); }
    catch (e) { skipped.push({ path: file, name: path.basename(file), reason: e.message }); log(`skipped ${file}: ${e.message}`); }
    if (Date.now() - t1 > 5000) log(`slow file (${Date.now() - t1} ms): ${file}`);
    await tick(); // let the window breathe between files
  }
  onProgress(i, files.length, 'checking for duplicates…');
  log(`read ${items.length} of ${files.length} files in ${Date.now() - t0} ms`);
  const t2 = Date.now();
  const dupes = await findDuplicateGroups(items, { organisedRoot: root, isCancelled });
  log(`duplicate check: ${dupes.length} sets in ${Date.now() - t2} ms`);
  if (s.groupRelated !== false) linkRelated(items);

  const plan = []; let fine = 0;
  for (const item of items) {
    const { dir } = placeItem(item, s);
    // A file you filed yourself inside Organised stays in its folder - only its name is reviewed.
    const keepFolder = inside(item.from, root) && !placed.has(item.from);
    const destDir = keepFolder || !dir ? path.dirname(item.from) : dir;
    item.details = { ...item.details, drawing: drawingNumber(item._text, item.name) };
    const suggested = smartName({ fileName: item.name, ext: item.ext, classification: item, details: item.details, aiTitle: item.aiTitle, aiDate: item.aiDate, fallbackDate: item.fileDate });
    const newName = suggested || item.name;
    const to = path.join(destDir, newName);
    const label = {
      type: item.docType && item.docType !== 'Other' ? item.docType : null,
      company: item.company || null,
      date: item.aiDate || item.details.date || item.details.month || null,
      dateFrom: item.aiDate ? 'AI' : item.details.date ? 'document' : item.details.month ? 'month in name/text' : null,
    };
    const { _text, nameTokens, textTokens, ...rest } = item; // don't keep whole documents in memory/IPC
    if (path.resolve(to) === path.resolve(item.from)) { fine++; continue; }
    plan.push({
      ...rest, nameTokens, textTokens, dir: destDir, to, newName: suggested, label,
      renamed: !!suggested, moved: path.resolve(destDir) !== path.resolve(path.dirname(item.from)), keptFolder: keepFolder,
    });
  }
  return { mode: 'review', plan, review: [], dupes, skipped, scanned: items.length, fine, stopped: isCancelled() };
}

module.exports = { reviewFiles };
