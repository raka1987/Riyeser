// Backups for every Riyeser desktop program (OWNER-BACKUP), the same way as Riyeser Payroll and Riyeser Accounting:
//
//   Where:    Documents\Riyeser\<Program>\Backups — outside the install folder, so uninstalling, reinstalling or moving
//             to a new PC never touches them (copy that folder to a USB stick or OneDrive and it all comes back).
//   What:     one .zip per backup: "Riyeser <Program> backup 2026-11-25 1405.zip", with a manifest.json saying which
//             program made it, when, and what's in it (shown before restoring).
//   When:     automatically once a day (the last 30 kept), and whenever someone presses "Back up now".
//   Restore:  pick a file -> see what's in it -> a "before restore" backup of the data as it is now is saved first ->
//             the data is put back -> the program restarts. Nothing is ever deleted without that copy.
//
// A program describes its data as parts: { id, label, dir, mode, skip }. mode 'replace' (the default) makes the folder
// exactly as it was in the backup; 'merge' only puts the backed-up files back (used for Accounting's folder, where only
// the company files are backed up). Sign-ins and this PC's own id are never copied (another PC must sign in itself).
const fs = require('fs');
const path = require('path');
const os = require('os');

const KEEP = 30;
const DAY = 86400000;
const FORMAT = 1;
// never in a backup: sign-ins, this PC's id (a signed licence is for one PC), half-written files, caches and logs
const NEVER = /(^|[\\/])(online\.json|device\.json|[^\\/]*\.tmp|[^\\/]*\.saving|LOCK|lockfile|logs?|Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|Crashpad|blob_storage|Service Worker|Shared Dictionary|ocr)([\\/]|$)/i;

/** Documents\Riyeser (RIYESER_DOCS moves it, as in Riyeser Accounting and Payroll). */
function docsRoot({ env = process.env, documents = null, home = os.homedir() } = {}) {
  if (env.RIYESER_DOCS) return env.RIYESER_DOCS;
  const docs = documents || path.join(home, 'Documents');
  return path.join(fs.existsSync(docs) ? docs : home, 'Riyeser');
}
const backupsDir = (program, opts = {}) => path.join(docsRoot(opts), program === 'Everything' ? 'Central' : program, 'Backups');

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`; };
const dayOf = (t) => stampOf(t).slice(0, 10);

function walk(dir, skip) {
  const out = [];
  const go = (d, rel) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (NEVER.test(r) || (skip && skip.test(r))) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) go(full, r);
      else if (e.isFile()) out.push({ rel: r, full });
    }
  };
  go(dir, '');
  return out;
}

/**
 * Make a backup. spec: { program, parts: [{ id, label, dir, mode?, skip? }] }; opts: { now, kind ('manual' | 'auto' |
 * 'before restore'), folder (default Documents\Riyeser\<program>\Backups), env, documents, home }.
 * -> { file, parts: [{ id, label, files, bytes }] }
 */
async function createBackup(spec, opts = {}) {
  const JSZip = require('jszip');
  const now = opts.now || Date.now(); const kind = opts.kind || 'manual';
  const zip = new JSZip();
  const parts = [];
  for (const p of spec.parts) {
    if (!p.dir || !fs.existsSync(p.dir)) continue;
    const files = walk(p.dir, p.skip);
    let bytes = 0; let n = 0;
    for (const f of files) {
      let data; try { data = fs.readFileSync(f.full); } catch { continue; }   // a file in use: the rest still count
      zip.file(`parts/${p.id}/${f.rel}`, data, { date: new Date(now) }); bytes += data.length; n++;
    }
    parts.push({ id: p.id, label: p.label || p.id, files: n, bytes, mode: p.mode || 'replace' });
  }
  const manifest = { format: FORMAT, program: spec.program, kind, created: new Date(now).toISOString(), computer: os.hostname(), parts };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const folder = opts.folder || backupsDir(spec.program, opts);
  fs.mkdirSync(folder, { recursive: true });
  const label = kind === 'before restore' ? ' (before restore)' : '';
  const title = spec.title || `Riyeser ${spec.program} backup`;
  let file = path.join(folder, `${title} ${stampOf(now)}${label}.zip`);
  for (let k = 2; fs.existsSync(file); k++) file = path.join(folder, `${title} ${stampOf(now)}${label} (${k}).zip`);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(`${file}.saving`, buf); fs.renameSync(`${file}.saving`, file);
  if (kind !== 'before restore') prune(folder, opts.keep || KEEP);
  return { file, parts, manifest };
}

/** The backups in a folder, newest first: [{ file, name, when, size, beforeRestore }]. */
function listBackups(folder) {
  let names; try { names = fs.readdirSync(folder); } catch { return []; }
  return names.filter((n) => /^Riyeser (.* )?backup .*\.zip$/i.test(n)).map((n) => {
    const file = path.join(folder, n); const st = fs.statSync(file);
    // when it was made: from its name (copied files keep it), else the file's own date
    const m = /(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})/.exec(n);
    const when = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : st.mtimeMs;
    return { file, name: n, when, size: st.size, beforeRestore: /\(before restore\)/.test(n) };
  }).sort((a, b) => b.when - a.when || b.name.localeCompare(a.name));
}
/** Keep the newest `keep` backups (and the newest `keep` before-restore copies, separately). */
function prune(folder, keep = KEEP) {
  const all = listBackups(folder);
  for (const set of [all.filter((b) => !b.beforeRestore), all.filter((b) => b.beforeRestore)]) {
    for (const b of set.slice(keep)) { try { fs.unlinkSync(b.file); } catch { /* in use */ } }
  }
}

/** The automatic backup: at most one a day. Returns the new backup, or null when today's is already there. */
async function dailyBackup(spec, opts = {}) {
  const now = opts.now || Date.now();
  const folder = opts.folder || backupsDir(spec.program, opts);
  const last = listBackups(folder).find((b) => !b.beforeRestore);
  if (last && dayOf(last.when) === dayOf(now)) return null;
  return createBackup(spec, { ...opts, now, kind: 'auto' });
}

/** What's in a backup (shown before restoring): its manifest. Throws a plain message for anything else. */
async function describeBackup(file) {
  const JSZip = require('jszip');
  let zip; try { zip = await JSZip.loadAsync(fs.readFileSync(file)); } catch { throw new Error('That file isn\'t a Riyeser backup (or it\'s damaged).'); }
  const m = zip.file('manifest.json');
  if (!m) throw new Error('That file isn\'t a Riyeser backup.');
  let manifest; try { manifest = JSON.parse(await m.async('string')); } catch { throw new Error('That Riyeser backup is damaged.'); }
  return { ...manifest, zip };
}
/** One line per part, for the "This backup has…" message. */
function summary(manifest) {
  const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const when = new Date(manifest.created);
  return [`Made ${when.toLocaleString()}${manifest.computer ? ` on ${manifest.computer}` : ''}.`,
    ...manifest.parts.map((p) => `• ${p.label}: ${p.files} file${p.files === 1 ? '' : 's'} (${kb(p.bytes)})`)].join('\n');
}

/**
 * Put a backup back. A "before restore" backup of the current data (the same parts) is saved first, in the program's
 * backups folder. opts.only: part ids to restore (default all that are in both). -> { before, restored: [ids] }
 */
async function restoreBackup(file, spec, opts = {}) {
  const info = await describeBackup(file);
  if (opts.program !== false && info.program !== spec.program && !(spec.accepts || []).includes(info.program)) {
    throw new Error(info.program === 'Everything' ? `That backup of every Riyeser program has nothing for Riyeser ${spec.program}.` : `That's a backup of Riyeser ${info.program}, not Riyeser ${spec.program}.`);
  }
  const want = spec.parts.filter((p) => info.parts.some((q) => q.id === p.id) && (!opts.only || opts.only.includes(p.id)));
  if (!want.length) throw new Error('That backup has nothing for this program.');
  const before = await createBackup({ program: spec.program, parts: want }, { ...opts, kind: 'before restore' });
  for (const p of want) {
    const prefix = `parts/${p.id}/`;
    const entries = Object.values(info.zip.files).filter((e) => !e.dir && e.name.startsWith(prefix));
    fs.mkdirSync(p.dir, { recursive: true });
    if ((p.mode || 'replace') === 'replace') {   // the folder as it was (what's there now is in the before-restore copy)
      for (const f of walk(p.dir, p.skip)) { try { fs.unlinkSync(f.full); } catch { /* in use: overwritten below if it's in the backup */ } }
    }
    for (const e of entries) {
      const rel = e.name.slice(prefix.length);
      if (!rel || rel.split('/').some((s) => s === '..' || s === '') || path.isAbsolute(rel)) continue;   // nothing outside the folder
      const out = path.join(p.dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(`${out}.restoring`, await e.async('nodebuffer'));
      fs.renameSync(`${out}.restoring`, out);
    }
  }
  return { before: before.file, restored: want.map((p) => p.id) };
}

// ---------- restoring on restart (a program's data can't be replaced while it has it open) ----------
const PENDING = 'restore-pending.json';
function scheduleRestore(userData, file, extra = {}) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, PENDING), JSON.stringify({ file, at: new Date().toISOString(), ...extra }));
}
/** At start, before anything opens the data: do a restore that was asked for. null when there's none. */
async function applyPendingRestore(userData, spec, opts = {}) {
  const f = path.join(userData, PENDING);
  let p; try { p = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  try { fs.unlinkSync(f); } catch { /* done once only */ }
  try { return { ok: true, ...(await restoreBackup(p.file, spec, { ...opts, only: p.only })) }; } catch (e) { return { ok: false, error: e.message, file: p.file }; }
}

module.exports = { KEEP, NEVER, docsRoot, backupsDir, createBackup, listBackups, prune, dailyBackup, describeBackup, summary, restoreBackup,
  scheduleRestore, applyPendingRestore, stampOf };
