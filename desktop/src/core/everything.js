// "Tidy everything": goes through all your personal folders (and every sub-folder) and files it all like an assistant would.
// - Folders that belong to programs (Outlook data, accounting files, game saves, code projects, installed programs) are left alone.
// - A named folder whose contents belong together ("Elm project", "Smith wedding") is kept together and moved as one.
// - Messy/generic folders ("New folder (3)", "Misc", "Camera Roll") are sorted file by file.
// - Everything is filed by year as well: Clients > Acme Plumbing > Invoices > 2026, Media > Images > 2024.
const fs = require('fs');
const path = require('path');
const { analyseFile, placeItem, safeName, usesTypeYear, typeFolder, MEDIA_FOLDER } = require('./organizer');
const { linkRelated } = require('./related');
const { isSystemPath, isTooBroad, isProtectedFile } = require('./safety');

// Folders created by programs - moving them breaks the program.
const APP_FOLDER = /^(\.?riyeser.*|\.?riyser.*|desk assistant|desk pdf|my games|outlook files|onenote notebooks|custom office templates|my shapes|my data sources|my received files|visual studio( \d+| code)?|windowspowershell|powershell|sql server management studio.*|rainmeter|paradox interactive|electronic arts|ea games|rockstar games|ubisoft.*|epic games|steam|battle\.net|blizzard.*|bioware|square enix|cd projekt red|avalanche studios|my cheat tables|zoom|adobe|autodesk|arduino|processing|unity|unreal projects|fiddler2|iisexpress|my web sites|python scripts|matlab|wechat files|tencent files|kakaotalk|garmin|quickbooks.*|myob.*|xero.*|sage.*|intuit|turbotax|h&r block|lightroom|capture one|itunes|music library|apple|ipod|amazon music|spotify|obs-studio|kindle|calibre library|keepass.*|bitwarden|1password|virtual machines|vmware|virtualbox vms|docker|wsl|android|xcode)$/i;
// Files that hold a program's data (email archives, accounting company files, catalogues, databases, virtual disks...)
const APP_DATA_EXT = new Set(['.pst', '.ost', '.nst', '.qbw', '.qbb', '.qbm', '.tlg', '.nd', '.myo', '.box', '.mdb', '.accdb', '.sqlite', '.sqlite3', '.db', '.db3',
  '.lrcat', '.lrdata', '.cocatalog', '.itl', '.musiclibrary', '.photoslibrary', '.one', '.onetoc2', '.onepkg', '.vhd', '.vhdx', '.vmdk', '.vdi', '.qcow2',
  '.kdbx', '.kdb', '.agilekeychain', '.opvault', '.sav', '.save', '.ldb', '.laccdb', '.mbox', '.msf', '.mailbox']);
// Signs that a folder is a code/software project.
const PROJECT_MARKER = /^(\.git|\.svn|\.hg|package\.json|node_modules|.*\.sln|.*\.csproj|.*\.vcxproj|pom\.xml|build\.gradle|cargo\.toml|go\.mod|requirements\.txt|pyproject\.toml|venv|\.venv|\.vscode|\.idea|.*\.xcodeproj|projectsettings|composer\.json|gemfile)$/i;
// Folder names that say nothing about the contents - sort what's inside instead of keeping them.
const GENERIC = /^(new folder( \(\d+\))?|folder\d*|untitled.*|misc(ellaneous)?|stuff|other|others|old|older|temp|tmp|backups?|scans?|scanned|downloads?|documents?|docs?|files|desktop|copy( \d+)?|archives?|unsorted|random|to ?sort|sort( me)?|camera roll|saved pictures|screenshots?|screen ?recordings?|captures|pictures|photos|images|videos|music|recordings|attachments|email attachments|from phone|phone|iphone|android|dcim|\d{3}[a-z]*|\d{4}(-\d{2})?|\d+|invoices?|receipts?|quotes?|quotations?|estimates?|contracts?|agreements?|statements?|payslips?|pay ?slips?|tax|taxes|bills?|insurance|reports?|proposals?|letters?|correspondence|meeting notes|minutes|purchase orders?)$/i;
// Folders that just hold other folders/areas of life - look inside them rather than moving them whole.
const CONTAINER = /^(work|business|personal|home|admin|office|company|projects|clients|customers|suppliers|jobs|accounts|finance|financial|household|family|school|university|uni|study|shared|onedrive|dropbox|google drive|icloud drive|my documents|my files|important|stuff to keep)$/i;

/** If this folder belongs to a program (or is a code project / installed program), say why; otherwise null. */
function appFolderReason(dir) {
  const name = path.basename(dir);
  if (APP_FOLDER.test(name)) return 'used by a program';
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 'can\'t be read'; }
  if (entries.some((e) => PROJECT_MARKER.test(e.name))) return 'a code/software project';
  if (entries.some((e) => e.isFile() && APP_DATA_EXT.has(path.extname(e.name).toLowerCase()))) return 'holds a program\'s data file (e.g. email, accounts or a library)';
  const exe = entries.filter((e) => e.isFile() && /\.(exe|dll)$/i.test(e.name)).length;
  if (exe >= 2 && entries.some((e) => /\.dll$/i.test(e.name))) return 'an installed/portable program';
  return null;
}

const isGeneric = (name) => GENERIC.test(name.trim());
const isContainer = (name) => CONTAINER.test(name.trim());

/** Photo/video date from the file's own information (when it was taken), if available. */
async function takenDate(file) {
  if (!/\.(jpe?g|heic|heif|tiff?|png|webp|dng|cr2|nef|arw|mov|mp4)$/i.test(file)) return null;
  try {
    const exifr = require('exifr');
    const d = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate', 'ModifyDate']);
    const when = d && (d.DateTimeOriginal || d.CreateDate || d.ModifyDate);
    if (when instanceof Date && !Number.isNaN(+when) && when.getFullYear() > 1990) return when.toISOString().slice(0, 10);
  } catch { /* no date inside */ }
  return null;
}

/** Walk one personal folder. Collects files and decides which folders are kept as they are. */
function survey(root, ctx) {
  const tree = { path: root, name: path.basename(root), files: [], dirs: [], isRoot: true };
  const walk = (node, depth) => {
    let entries;
    try { entries = fs.readdirSync(node.path, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(node.path, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
        if (ctx.isOrganised(full)) continue;
        if (isSystemPath(full) || isTooBroad(full)) continue;
        if (ctx.neverTouch(full)) { ctx.kept.push({ path: full, reason: 'you asked me not to touch it' }); continue; }
        const why = appFolderReason(full);
        if (why) { ctx.kept.push({ path: full, reason: why }); continue; }
        if (depth >= 12) continue;
        const child = { path: full, name: e.name, files: [], dirs: [] };
        node.dirs.push(child);
        walk(child, depth + 1);
      } else if (e.isFile()) {
        if (isProtectedFile(full)) continue;
        if (APP_DATA_EXT.has(path.extname(e.name).toLowerCase())) { ctx.kept.push({ path: full, reason: 'a program\'s data file' }); continue; }
        if (/\.(crdownload|part|partial|download|tmp)$/i.test(e.name)) continue;
        node.files.push(full);
        ctx.count++;
      }
    }
  };
  walk(tree, 0);
  return tree;
}

const allFiles = (node) => [...node.files, ...node.dirs.flatMap(allFiles)];
const majority = (values) => {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return top ? { value: top[0], share: top[1] / values.length, count: top[1] } : null;
};
const yearOf = (it) => (it.details?.date || it.fileDate || '').slice(0, 4);

/**
 * Decide where a named folder should go if it is kept together. Returns null when its contents don't belong together
 * (then it's sorted file by file).
 */
function folderDestination(node, items, settings) {
  if (items.length < 2) return null;
  // A folder named after a company you deal with is just a pile of their documents: sort it by type and year instead.
  const n = node.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const companyNames = (settings.companies || []).flatMap((c) => [c.name, ...(c.aliases || [])]).map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean);
  if (companyNames.some((c) => n === c || n.startsWith(c + ' ') && n.split(' ').length <= c.split(' ').length + 1)) return null;
  const root = settings.organisedRoot;
  if (usesTypeYear(settings)) {
    // Type › Year: a folder that belongs together goes inside its type and year, e.g. Drawings\2026\Elm project.
    const docsT = items.filter((i) => i.category !== 'Media');
    const mediaT = items.filter((i) => i.category === 'Media');
    const yr = (majority(items.map(yearOf)) || {}).value || 'Undated';
    const nm = safeName(node.name);
    if (mediaT.length / items.length >= 0.8) {
      const kind = MEDIA_FOLDER[(majority(mediaT.map((i) => i.docType)) || {}).value] || 'Pictures';
      return { dir: path.join(root, kind, yr), to: path.join(root, kind, yr, nm), why: `an album of ${mediaT.length} ${kind.toLowerCase()}` };
    }
    const t = majority(docsT.map((i) => (i.docType && i.docType !== 'Other' ? i.docType : null)));
    if (docsT.length >= 2 && t && t.share >= 0.6) {
      const tf = typeFolder({ docType: t.value }).map(safeName);
      return { dir: path.join(root, ...tf, yr), to: path.join(root, ...tf, yr, nm), why: `mostly ${t.value.toLowerCase()}` };
    }
    return null; // mixed contents: each file goes to its own type and year
  }
  const docs = items.filter((i) => i.category !== 'Media');
  const media = items.filter((i) => i.category === 'Media');
  const year = (majority(items.map(yearOf)) || {}).value || new Date().getFullYear().toString();
  const name = safeName(node.name);
  const co = majority(docs.map((i) => i.company));
  if (docs.length >= 2 && co && co.count >= 2 && co.share >= 0.6) {
    const sample = docs.find((i) => i.company === co.value);
    const known = (settings.companies || []).find((c) => c.name.toLowerCase() === co.value.toLowerCase());
    const type = known ? (known.type || 'Companies') : (sample.companyType || 'Companies');
    return { dir: path.join(root, safeName(type), safeName(co.value), 'Projects'), to: path.join(root, safeName(type), safeName(co.value), 'Projects', name), why: `${co.count} of the documents are for ${co.value}`, company: co.value, companyType: type };
  }
  if (media.length / items.length >= 0.8) {
    const kind = (majority(media.map((i) => i.docType)) || {}).value || 'Images';
    return { dir: path.join(root, 'Media', kind, year), to: path.join(root, 'Media', kind, year, name), why: `an album of ${media.length} ${kind.toLowerCase()}` };
  }
  const dt = majority(docs.map((i) => (i.docType && i.docType !== 'Other' ? i.docType : null)));
  if (docs.length >= 2 && dt && dt.share >= 0.6) {
    return { dir: path.join(root, 'General', safeName(dt.value), year), to: path.join(root, 'General', safeName(dt.value), year, name), why: `mostly ${dt.value.toLowerCase()}` };
  }
  return null;
}

/**
 * Build the plan for tidying everything.
 * settings.libraryFolders: the personal folders to go through; settings.neverTouch: folders to leave alone.
 */
async function planEverything(settings, { ai = null, onProgress = () => {}, isCancelled = () => false } = {}) {
  const root = settings.organisedRoot;
  const never = (settings.neverTouch || []).map((p) => path.resolve(p).toLowerCase());
  const ctx = {
    kept: [], count: 0,
    isOrganised: (p) => { const r = path.resolve(p).toLowerCase(); const o = path.resolve(root).toLowerCase(); return r === o || r.startsWith(o + path.sep); },
    neverTouch: (p) => { const r = path.resolve(p).toLowerCase(); return never.some((n) => r === n || r.startsWith(n + path.sep)); },
  };
  const libraries = (settings.libraryFolders || []).filter((f) => fs.existsSync(f) && !isSystemPath(f) && !isTooBroad(f) && !ctx.neverTouch(f));
  const trees = libraries.map((f) => survey(f, ctx));

  // 1. Read every file once.
  const analysed = new Map();
  let done = 0;
  for (const file of trees.flatMap(allFiles)) {
    if (isCancelled()) throw new Error('Cancelled');
    onProgress(++done, ctx.count, file);
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (Date.now() - st.mtimeMs < 60_000) continue; // still being written
    const it = await analyseFile(file, st, settings, ai);
    if (it.category === 'Media') { const t = await takenDate(file); if (t) it.fileDate = t; }
    analysed.set(file, it);
  }

  // 2. Decide folder by folder: keep named folders that belong together; sort the rest file by file.
  const folderItems = []; const loose = [];
  const decide = (node) => {
    if (!node.isRoot && !isGeneric(node.name) && !isContainer(node.name)) {
      const items = allFiles(node).map((f) => analysed.get(f)).filter(Boolean);
      const dest = folderDestination(node, items, settings);
      if (dest) {
        const size = items.reduce((n, i) => n + (i.size || 0), 0);
        folderItems.push({ from: node.path, name: node.name, isFolder: true, files: items.length, size, category: 'Folder', docType: 'Folder',
          company: dest.company || null, companyType: dest.companyType || null, confidence: 'high', reasons: [`kept together — ${dest.why}`],
          details: {}, keys: [], dir: dest.dir, to: dest.to });
        return;
      }
    }
    node.files.forEach((f) => { if (analysed.has(f)) loose.push(analysed.get(f)); });
    node.dirs.forEach(decide);
  };
  trees.forEach(decide);

  // 3. File the loose files (by company, type and year), keeping related documents together.
  const yearly = { ...settings, groupByYear: true };
  if (settings.groupRelated !== false) linkRelated(loose);
  const plan = [...folderItems];
  const review = [];
  for (const item of loose) {
    const { dir, unsure, to } = placeItem(item, yearly);
    if (!dir || unsure) { review.push({ ...item, suggestedDir: dir }); continue; }
    let finalDir = dir;
    if (item.fallback && !usesTypeYear(settings)) finalDir = path.join(dir, yearOf(item) || 'Undated');
    const dest = path.join(finalDir, path.basename(to));
    if (path.resolve(dest).toLowerCase() === path.resolve(item.from).toLowerCase()) continue;
    plan.push({ ...item, dir: finalDir, to: dest });
  }
  return { mode: 'everything', plan, review, kept: ctx.kept, scanned: ctx.count, libraries, emptyFolderCleanup: [] };
}

/** After moving, remove folders that were left empty - but never the personal folders themselves. */
function removeEmptiedFolders(batch, libraries) {
  const stops = new Set(libraries.map((l) => path.resolve(l).toLowerCase()));
  const dirs = new Set(batch.moves.map((m) => path.dirname(m.from)));
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    let cur = d;
    while (cur && !stops.has(path.resolve(cur).toLowerCase()) && !isSystemPath(cur) && !isTooBroad(cur)) {
      try { if (fs.readdirSync(cur).length) break; fs.rmdirSync(cur); } catch { break; }
      cur = path.dirname(cur);
    }
  }
}

/**
 * Every personal file in these folders, safely: program folders, program data files, Archive and never-touch folders
 * are left out (with the reason in `kept`). Used by "Sort by type", which re-files Organised too.
 */
function collectPersonalFiles(folders, settings) {
  const never = (settings.neverTouch || []).map((p) => path.resolve(p).toLowerCase());
  const archive = settings.organisedRoot ? path.resolve(settings.organisedRoot, 'Archive').toLowerCase() : null;
  const ctx = {
    kept: [], count: 0,
    isOrganised: (p) => !!archive && (path.resolve(p).toLowerCase() === archive || path.resolve(p).toLowerCase().startsWith(archive + path.sep)),
    neverTouch: (p) => { const r = path.resolve(p).toLowerCase(); return never.some((n) => r === n || r.startsWith(n + path.sep)); },
  };
  const files = new Set();
  for (const f of folders) {
    if (!f || !fs.existsSync(f) || isSystemPath(f) || isTooBroad(f) || ctx.neverTouch(f) || appFolderReason(f)) continue;
    for (const file of allFiles(survey(f, ctx))) files.add(file);
  }
  return { files: [...files], kept: ctx.kept };
}

module.exports = { planEverything, removeEmptiedFolders, appFolderReason, isGeneric, takenDate, collectPersonalFiles };
