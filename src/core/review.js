// "Smart review": reads every file in the chosen folders and, for each one, suggests
//  - a label (what it is, who it's for/from, its date)
//  - a clear new name that starts with the document's own date
//  - the folder it belongs in
// and finds duplicates (even with different names or formats). Nothing changes until the user approves.
const fs = require('fs');
const path = require('path');
const { analyseFile, placeItem, listFiles } = require('./organizer');
const { linkRelated } = require('./related');
const { smartName } = require('./details');
const { findDuplicateGroups } = require('./dupes');
const { isSystemPath, isTooBroad } = require('./safety');

const inside = (p, root) => !!root && (p === root || p.startsWith(root + path.sep));

async function reviewFiles(folders, settings, { ai = null, onProgress = () => {}, isCancelled = () => false, maxFiles = 5000 } = {}) {
  const root = settings.organisedRoot;
  const placed = new Set(settings._placedByApp || []);
  const files = [];
  for (const f of folders) {
    if (!f || !fs.existsSync(f) || isSystemPath(f) || isTooBroad(f)) continue;
    for (const file of listFiles(f, { recursive: true, maxDepth: 8, maxFiles })) if (!files.includes(file)) files.push(file);
  }
  // With AI switched on, every document gets a second opinion (not only the unsure ones).
  const s = { ...settings, groupByYear: true, renameFiles: true, aiCheckAll: !!ai || settings.aiCheckAll };
  const items = [];
  let i = 0;
  for (const file of files.slice(0, maxFiles)) {
    if (isCancelled()) break;
    onProgress(++i, files.length, file);
    let st; try { st = fs.statSync(file); } catch { continue; }
    try { items.push({ ...(await analyseFile(file, st, s, ai, { keepText: true })), mtime: st.mtimeMs }); } catch { /* unreadable: skip */ }
  }
  const dupes = findDuplicateGroups(items, { organisedRoot: root });
  if (s.groupRelated !== false) linkRelated(items);

  const plan = []; let fine = 0;
  for (const item of items) {
    const { dir } = placeItem(item, s);
    // A file you filed yourself inside Organised stays in its folder - only its name is reviewed.
    const keepFolder = inside(item.from, root) && !placed.has(item.from);
    const destDir = keepFolder || !dir ? path.dirname(item.from) : dir;
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
  return { mode: 'review', plan, review: [], dupes, scanned: items.length, fine, stopped: isCancelled() };
}

module.exports = { reviewFiles };
