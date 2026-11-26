// Riyeser Documents: the library. One root folder (on this PC, or a shared office folder such as
// \\OFFICE-PC\Riyeser Documents so several PCs share one library) holding real Windows folders:
//
//   <root>\Accounts\Suppliers ...   department folders (your documents, filed)
//   <root>\_Inbox                   new scans and uploads waiting to be filed
//   <root>\_Scans\Accounts ...      scan-to-folder targets for the office printers (watched)
//   <root>\_Scans\Email in          for scan-to-email later (watched)
//   <root>\_Recycle bin             deleted documents, kept for 30 days
//   <root>\_Riyeser                 the shared list of documents (library.json), history.jsonl and access.json
//
// The files on disk are the truth: anything put into a department folder in File Explorer is picked up by
// reconcile(). Every change to library.json happens under a lock file, so two PCs can't overwrite each other.
// A copy of the list is kept on this PC, so if the shared folder is briefly unreachable the app still shows the
// last known documents (read-only) instead of failing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const access = require('./access');
const { suggest, defaultRules, makeExample } = require('./suggest');

const DEFAULT_FOLDERS = ['Accounts/Suppliers', 'Accounts/Bank statements', 'Accounts/Tax', 'Payroll & HR', 'Sales', 'Jobs', 'Admin'];
const SPECIAL = { inbox: '_Inbox', scans: '_Scans', bin: '_Recycle bin', meta: '_Riyeser' };
const EMAIL_IN = 'Email in';
const BIN_DAYS = 30;
const MAX_TEXT = 20000;
const SKIP_FILE = /^(desktop\.ini|thumbs\.db|\.ds_store|~\$.*|.*\.(tmp|part|crdownload|lnk))$/i;

/** A folder inside the library that people may file into: no "..", no hidden or special (_) top folder. */
function safeFolder(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Pick a folder.');
  if (parts.some((p) => p === '.' || p === '..' || p.startsWith('.') || /[<>:"|?*\u0000-\u001f]/.test(p)) || /^[_$]/.test(parts[0])) throw new Error('That isn\'t a folder in the library.');
  return parts.join('/');
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const newId = () => crypto.randomBytes(6).toString('hex');
const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const shown = (rel) => String(rel || '').split('/').filter(Boolean).join(' › ');

/** Scans (PDFs from a printer or scanner), Photos (pictures) or Documents (everything else). */
function typeOf(ext, source) {
  const e = String(ext || '').toLowerCase();
  if (/^\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/.test(e)) return source === 'printer' || source === 'scanner' ? 'Scans' : 'Photos';
  if (e === '.pdf' && ['printer', 'scanner'].includes(source)) return 'Scans';
  return 'Documents';
}

class OfflineError extends Error {}

class Library {
  /**
   * opts: { root, cacheDir (this PC's copy of the list), me: { id, name, email }, now?: () => Date, settings?: classifier settings }
   */
  constructor({ root, cacheDir, me, now = () => new Date(), settings = {} }) {
    this.root = path.resolve(String(root));
    this.cacheDir = cacheDir;
    this.me = me;
    this.now = now;
    this.settings = settings;
    this.lastError = null;
  }

  // ---------- where things are ----------
  abs(rel) { return path.join(this.root, ...String(rel || '').split('/').filter(Boolean)); }
  meta(name) { return path.join(this.root, SPECIAL.meta, name); }
  docPath(doc) { return this.abs(doc.rel); }
  get isNetwork() { return /^\\\\|^\/\//.test(this.root) || /^\\\\/.test(String(this.root)); }

  /** Is the library folder reachable right now? */
  online() {
    try { return fs.statSync(this.root).isDirectory(); } catch { return false; }
  }
  status() {
    const online = this.online();
    return { root: this.root, online, network: this.isNetwork, error: online ? null : `The library folder ${this.root} can't be reached right now. If it's on another PC, check that PC is on and connected to the network. Documents you saw last are shown; changes wait until it's back.` };
  }
  requireOnline() {
    if (!this.online()) throw new OfflineError(`The library folder ${this.root} can't be reached right now, so nothing was changed. Try again when it's back.`);
  }

  /** Create the folders (department folders the first time only) and the shared files. */
  ensureLayout({ folders = DEFAULT_FOLDERS, departments } = {}) {
    const fresh = !fs.existsSync(this.meta('library.json'));
    fs.mkdirSync(this.root, { recursive: true });
    for (const s of [SPECIAL.inbox, SPECIAL.bin, SPECIAL.meta, SPECIAL.scans]) fs.mkdirSync(path.join(this.root, s), { recursive: true });
    if (fresh) for (const f of folders) fs.mkdirSync(this.abs(f), { recursive: true });
    if (fresh) this.writeData({ version: 1, docs: {}, rules: defaultRules(), examples: [] });
    if (!fs.existsSync(this.meta('access.json'))) this.writeJson('access.json', access.defaultAccess(this.me ? this.me.id : null));
    this.ensureScanFolders(departments);
    // Whoever opens the library is on its people list (so the owner can give them access); the first is the owner.
    this.updateAccess((a) => {
      let out = a;
      if (!out.owner && this.me) out = { ...out, owner: this.me.id };
      if (this.me && !(out.people || []).some((p) => p.id === this.me.id)) out = access.upsertPerson(out, this.me);
      return out;
    }, { force: true });
    return fresh;
  }
  ensureScanFolders(departments = this.departments()) {
    for (const d of [...departments, EMAIL_IN]) { try { fs.mkdirSync(path.join(this.root, SPECIAL.scans, d), { recursive: true }); } catch { /* offline */ } }
  }

  // ---------- the shared list, under a lock ----------
  readJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(this.meta(name), 'utf8')); } catch { return fallback; }
  }
  writeJson(name, value) {
    const f = this.meta(name); const tmp = `${f}.${process.pid}.${newId()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, f);
  }
  cacheFile(name) { return this.cacheDir ? path.join(this.cacheDir, name) : null; }
  readData() {
    if (this.online()) {
      const d = this.readJson('library.json', null);
      if (d) { this.cache('library.json', d); return d; }
    }
    const c = this.cacheFile('library.json');
    try { return JSON.parse(fs.readFileSync(c, 'utf8')); } catch { return { version: 1, docs: {}, rules: defaultRules(), examples: [] }; }
  }
  writeData(d) { this.writeJson('library.json', d); this.cache('library.json', d); }
  cache(name, d) {
    const c = this.cacheFile(name); if (!c) return;
    try { fs.mkdirSync(path.dirname(c), { recursive: true }); fs.writeFileSync(c, JSON.stringify(d)); } catch { /* the copy is a convenience */ }
  }
  /** Run fn while holding the library's lock file (another PC waits a moment; a lock older than 30s is stale). */
  withLock(fn) {
    this.requireOnline();
    const lock = this.meta('library.lock');
    let fd = null;
    for (let i = 0; i < 100 && fd === null; i++) {
      try { fd = fs.openSync(lock, 'wx'); } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true }); } catch { /* gone already */ }
        sleep(50);
      }
    }
    if (fd === null) throw new Error('Another PC is busy saving changes to the library. Try again in a moment.');
    try { fs.writeSync(fd, `${this.me ? this.me.name : ''} ${new Date().toISOString()}`); return fn(); }
    finally { try { fs.closeSync(fd); } catch { /* ignore */ } try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ } }
  }
  mutate(fn) {
    return this.withLock(() => { const d = this.readData(); const r = fn(d); this.writeData(d); return r; });
  }

  // ---------- access ----------
  getAccess() {
    const a = this.online() ? this.readJson('access.json', null) : null;
    if (a) { this.cache('access.json', a); return a; }
    try { return JSON.parse(fs.readFileSync(this.cacheFile('access.json'), 'utf8')); } catch { return access.defaultAccess(null); }
  }
  updateAccess(fn, { force = false } = {}) {
    return this.withLock(() => {
      const before = this.getAccess();
      const after = fn(before);
      if (!force && after === before) return before;
      this.writeJson('access.json', after); this.cache('access.json', after);
      return after;
    });
  }
  /** The person record (with groups) for an id. */
  person(id) { return (this.getAccess().people || []).find((p) => p.id === id) || (this.me && this.me.id === id ? this.me : { id, name: id, groups: [] }); }
  level(folderRel, who = this.me) { return access.levelFor(this.getAccess(), this.person(who.id), folderRel); }
  can(action, folderRel, who = this.me) { return access.can(this.getAccess(), this.person(who.id), action, folderRel); }
  check(action, folderRel, who = this.me) {
    if (this.can(action, folderRel, who)) return;
    const what = { view: 'open', add: 'add documents to', file: 'file documents in', move: 'move documents in', rename: 'rename documents in', delete: 'delete documents in', restore: 'restore documents to', permissions: 'change access to', private: 'change' }[action] || action;
    throw new Error(`You don't have access to ${what} ${shown(folderRel) || 'the library'}. Ask the owner to change it in Settings › People & access.`);
  }

  // ---------- folders ----------
  /** Every department folder and sub-folder (relative paths, '/' separators), hidden _ and . folders left out. */
  folders() {
    const out = [];
    const walk = (rel, depth) => {
      if (depth > 6 || out.length > 5000) return;
      let ents; try { ents = fs.readdirSync(this.abs(rel), { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isDirectory() || /^[_.$]/.test(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        out.push(r); walk(r, depth + 1);
      }
    };
    if (this.online()) walk('', 0);
    else { // offline: the folders the cached documents are in
      for (const d of Object.values(this.readData().docs)) if (d.status === 'filed') { const p = d.rel.split('/').slice(0, -1); for (let i = 1; i <= p.length; i++) out.push(p.slice(0, i).join('/')); }
    }
    return [...new Set(out)].sort((a, b) => a.localeCompare(b));
  }
  departments() { return this.folders().filter((f) => !f.includes('/')); }
  /** Folders this person can see, with their level and whether they're locked for everyone else. */
  visibleFolders(who = this.me) {
    const a = this.getAccess(); const p = this.person(who.id);
    return this.folders().map((rel) => ({ rel, level: access.levelFor(a, p, rel), locked: access.isLocked(a, rel) })).filter((f) => f.level !== 'none');
  }
  createFolder(rel, who = this.me) {
    const clean = String(rel).split('/').map((s) => s.replace(/[<>:"\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').trim()).filter(Boolean);
    if (!clean.length || /^[_.$]/.test(clean[0]) || clean.some((s) => s.startsWith('.'))) throw new Error('Give the folder a name (it can\'t start with _ or .).');
    const r = safeFolder(clean.join('/'));
    this.requireOnline();
    this.check('add', clean.length > 1 ? clean.slice(0, -1).join('/') : r, who);
    fs.mkdirSync(this.abs(r), { recursive: true });
    if (clean.length === 1) this.ensureScanFolders([clean[0]]);
    this.log({ action: 'folder', folder: r, detail: `Made the folder ${shown(r)}` }, who);
    return r;
  }

  // ---------- documents ----------
  docs() { return Object.values(this.readData().docs); }
  doc(id) { const d = this.readData().docs[id]; if (!d) throw new Error('That document isn\'t in the library any more.'); return d; }
  /** The folder a document is in ('' for the Inbox; the department it was scanned for counts for permissions). */
  folderOf(doc) {
    if (doc.status === 'filed') return doc.rel.split('/').slice(0, -1).join('/');
    if (doc.status === 'deleted') return doc.deletedFrom || '';
    return doc.deptHint || '';
  }
  canSee(doc, who = this.me) {
    return access.canSeeDoc(this.getAccess(), this.person(who.id), doc, this.folderOf(doc));
  }

  uniqueRel(folderRel, name) {
    const ext = path.extname(name); const base = name.slice(0, name.length - ext.length);
    let candidate = name; let n = 2;
    while (fs.existsSync(this.abs(folderRel ? `${folderRel}/${candidate}` : candidate))) candidate = `${base} (${n++})${ext}`;
    return folderRel ? `${folderRel}/${candidate}` : candidate;
  }

  /**
   * Put a new document in the Inbox. file: a path on this PC. move: true for files from a scan folder (taken out of
   * it so the printer's folder stays empty); otherwise a copy is made and the original is left alone.
   * meta: { source: 'upload'|'printer'|'scanner'|'email'|'phone'|'program', sourceLabel, deptHint }
   */
  addFile(file, meta = {}, who = this.me) {
    this.requireOnline();
    // trusted: a scan folder the office printer saved into (the watcher hands it over, whoever's PC is running it)
    if (meta.deptHint && !meta.trusted) this.check('add', meta.deptHint, who);
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('Only files can be added.');
    const name = path.basename(file).replace(/[<>:"\\|?*\u0000-\u001f]/g, '-');
    const rel = this.uniqueRel(SPECIAL.inbox, name);
    const target = this.abs(rel);
    if (meta.move) { try { fs.renameSync(file, target); } catch { fs.copyFileSync(file, target); fs.rmSync(file, { force: true }); } }
    else fs.copyFileSync(file, target);
    const at = this.now().toISOString();
    const doc = {
      id: newId(), name: path.basename(rel), rel, ext: path.extname(rel).toLowerCase(), size: st.size, type: typeOf(path.extname(rel), meta.source),
      status: 'inbox', added: at, addedBy: who.id, addedByName: who.name, source: meta.source || 'upload', sourceLabel: meta.sourceLabel || sourceLabel(meta.source),
      deptHint: meta.deptHint || null, private: false, text: '', textDone: false, suggestion: null,
    };
    this.mutate((d) => { d.docs[doc.id] = doc; });
    this.log({ action: 'added', doc, detail: `Added from ${doc.sourceLabel}${doc.deptHint ? ` for ${doc.deptHint}` : ''}` }, who);
    return doc;
  }

  /** Save what was read from a document (its text) and work out where it should go. */
  setText(id, text, extra = {}) {
    return this.mutate((d) => {
      const doc = d.docs[id]; if (!doc) return null;
      doc.text = String(text || '').slice(0, MAX_TEXT); doc.textDone = true;
      Object.assign(doc, extra);
      if (doc.status === 'inbox') doc.suggestion = this.suggestFor(doc, d);
      return doc;
    });
  }
  suggestFor(doc, data = this.readData()) {
    const s = suggest(doc, { rules: data.rules, examples: data.examples, departments: this.departments(), settings: this.settings });
    doc.company = doc.company || s.company; doc.docType = doc.docType || s.docType;
    return { folder: s.folder, because: s.because, name: s.name };
  }
  /** Work the suggestions out again (after a rule changed). */
  resuggest() {
    return this.mutate((d) => { let n = 0; for (const doc of Object.values(d.docs)) if (doc.status === 'inbox' && doc.textDone) { doc.suggestion = this.suggestFor(doc, d); n++; } return n; });
  }

  /**
   * File an Inbox document into a folder (a real move on disk). opts: { name: new file name, explicit: the person
   * picked the folder themselves (learned more strongly) }.
   */
  fileDoc(id, folderRel, opts = {}, who = this.me) {
    const folder = safeFolder(folderRel);
    this.check('file', folder, who);
    const doc = this.doc(id);
    if (doc.status !== 'inbox') throw new Error(`${doc.name} has already been filed.`);
    if (!this.canSee(doc, who)) throw new Error('You don\'t have access to that document.');
    return this.relocate(doc, folder, opts.name, who, (d, data) => {
      d.status = 'filed'; d.filed = this.now().toISOString(); d.filedBy = who.id;
      data.examples = [...(data.examples || []), makeExample(d, folder, !!opts.explicit)].slice(-2000);
      delete d.suggestion;
    }, 'filed', `Filed in ${shown(folder)}`);
  }
  /** File every Inbox document that has a suggestion, as suggested. Returns { filed, skipped } */
  fileAll(ids, who = this.me) {
    const out = { filed: [], skipped: [] };
    for (const id of ids) {
      try { const d = this.doc(id); if (!d.suggestion) throw new Error('No suggestion yet'); out.filed.push(this.fileDoc(id, d.suggestion.folder, {}, who)); }
      catch (e) { out.skipped.push({ id, reason: e.message }); }
    }
    return out;
  }
  move(id, folderRel, who = this.me) {
    const folder = safeFolder(folderRel);
    const doc = this.doc(id);
    if (doc.status === 'inbox') return this.fileDoc(id, folder, { explicit: true }, who);
    if (doc.status !== 'filed') throw new Error('Restore it from the Recycle bin first.');
    const from = this.folderOf(doc);
    this.check('move', from, who); this.check('add', folder, who);
    if (from === folder) return doc;
    return this.relocate(doc, folder, null, who, (d, data) => { data.examples = [...(data.examples || []), makeExample(d, folder, true)].slice(-2000); }, 'moved', `Moved from ${shown(from)} to ${shown(folder)}`);
  }
  rename(id, newName, who = this.me) {
    const doc = this.doc(id);
    let name = String(newName || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim();
    if (!name) throw new Error('Type a name.');
    if (!path.extname(name) && doc.ext) name += doc.ext; // keep it a .pdf
    this.check('rename', this.folderOf(doc), who);
    const folder = doc.rel.split('/').slice(0, -1).join('/');
    const old = doc.name;
    return this.relocate(doc, folder, name, who, (d) => { d.formerNames = [...new Set([...(d.formerNames || []), old])].slice(-10); }, 'renamed', `Renamed from ${old}`);
  }
  /** Move the file on disk and update the list. */
  relocate(doc, folder, newName, who, change, action, detail) {
    this.requireOnline();
    if (!this.canSee(doc, who)) throw new Error('You don\'t have access to that document.');
    const src = this.docPath(doc);
    if (!fs.existsSync(src)) { this.mutate((d) => { delete d.docs[doc.id]; }); throw new Error(`${doc.name} isn't there any more (moved or deleted outside Riyeser Documents).`); }
    const name = newName || doc.name;
    if (path.basename(doc.rel) === name && doc.rel.split('/').slice(0, -1).join('/') === folder) return doc;
    fs.mkdirSync(this.abs(folder), { recursive: true });
    const rel = this.uniqueRel(folder, name);
    try { fs.renameSync(src, this.abs(rel)); } catch { fs.copyFileSync(src, this.abs(rel)); fs.rmSync(src, { force: true }); }
    const fromRel = doc.rel;
    const out = this.mutate((data) => {
      const d = data.docs[doc.id] || doc; data.docs[doc.id] = d;
      d.rel = rel; d.name = path.basename(rel); d.ext = path.extname(rel).toLowerCase();
      change(d, data);
      return d;
    });
    this.log({ action, doc: out, from: fromRel, to: rel, detail }, who);
    return out;
  }

  /** Delete: into the Recycle bin (restorable for 30 days). */
  remove(id, who = this.me) {
    const doc = this.doc(id);
    if (doc.status === 'deleted') return doc;
    const from = this.folderOf(doc);
    if (doc.status === 'filed') this.check('delete', from, who);
    else if (!(doc.addedBy === who.id || this.can('delete', from, who))) this.check('delete', from, who);
    const wasStatus = doc.status; const wasRel = doc.rel;
    return this.relocate(doc, SPECIAL.bin, `${doc.id}~${doc.name}`, who, (d) => {
      d.status = 'deleted'; d.deletedAt = this.now().toISOString(); d.deletedBy = who.id; d.deletedFrom = from; d.wasStatus = wasStatus; d.wasRel = wasRel;
      if (d.name.startsWith(`${d.id}~`)) d.name = d.name.slice(d.id.length + 1);
    }, 'deleted', `Moved to the Recycle bin from ${wasStatus === 'inbox' ? 'the Inbox' : shown(from)}`);
  }
  restore(id, who = this.me) {
    const doc = this.doc(id);
    if (doc.status !== 'deleted') return doc;
    const back = doc.wasStatus === 'inbox' ? SPECIAL.inbox : (doc.deletedFrom || SPECIAL.inbox);
    if (doc.wasStatus !== 'inbox') this.check('restore', back, who);
    const name = path.basename(doc.wasRel || doc.name);
    return this.relocate(doc, back, name, who, (d) => {
      d.status = d.wasStatus || 'inbox'; delete d.deletedAt; delete d.deletedBy; delete d.wasStatus; delete d.wasRel;
      if (d.status === 'inbox') d.suggestion = d.suggestion || null;
    }, 'restored', `Restored to ${back === SPECIAL.inbox ? 'the Inbox' : shown(back)}`);
  }
  /** Empty Recycle bin entries older than 30 days (or all of them with all=true). */
  purge({ all = false } = {}, who = this.me) {
    if (!this.online()) return [];
    const cutoff = this.now().getTime() - BIN_DAYS * 864e5;
    const gone = [];
    for (const doc of this.docs()) {
      if (doc.status !== 'deleted' || (!all && new Date(doc.deletedAt).getTime() > cutoff)) continue;
      if (all && !this.can('delete', doc.deletedFrom || '', who)) continue;
      try { fs.rmSync(this.docPath(doc), { force: true }); } catch { /* already gone */ }
      gone.push(doc);
    }
    if (gone.length) {
      this.mutate((d) => { for (const g of gone) delete d.docs[g.id]; });
      for (const g of gone) this.log({ action: 'purged', doc: g, detail: all ? 'Recycle bin emptied' : `Removed for good after ${BIN_DAYS} days in the Recycle bin` }, who);
    }
    return gone;
  }
  setPrivate(id, on, who = this.me) {
    const doc = this.doc(id);
    if (!this.canSee(doc, who)) throw new Error('You don\'t have access to that document.');
    if (!(doc.addedBy === who.id || this.can('private', this.folderOf(doc), who))) this.check('private', this.folderOf(doc), who);
    const out = this.mutate((d) => { d.docs[id].private = !!on; return d.docs[id]; });
    this.log({ action: on ? 'private' : 'shared', doc: out, detail: on ? 'Made private' : 'No longer private' }, who);
    return out;
  }

  /**
   * Bring the list in line with the folders: files put in a department folder (or the Inbox) outside the app are
   * added; documents whose file disappeared are dropped. Returns { added: [...], removed: [...] }.
   */
  reconcile() {
    if (!this.online()) return { added: [], removed: [] };
    const files = [];
    const walk = (rel, depth, inbox) => {
      if (depth > 7 || files.length > 50000) return;
      let ents; try { ents = fs.readdirSync(this.abs(rel), { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!/^[_.$]/.test(e.name)) walk(r, depth + 1, inbox); }
        else if (e.isFile() && !SKIP_FILE.test(e.name)) files.push({ rel: r, inbox });
      }
    };
    walk('', 0, false); walk(SPECIAL.inbox, 1, true);
    const binFiles = new Set(); try { for (const n of fs.readdirSync(path.join(this.root, SPECIAL.bin))) binFiles.add(`${SPECIAL.bin}/${n}`); } catch { /* none */ }
    return this.mutate((d) => {
      const known = new Map(Object.values(d.docs).map((x) => [x.rel.toLowerCase(), x]));
      const added = []; const removed = [];
      for (const f of files) {
        if (known.has(f.rel.toLowerCase())) continue;
        let st; try { st = fs.statSync(this.abs(f.rel)); } catch { continue; }
        const doc = { id: newId(), name: path.basename(f.rel), rel: f.rel, ext: path.extname(f.rel).toLowerCase(), size: st.size, type: typeOf(path.extname(f.rel), 'folder'),
          status: f.inbox ? 'inbox' : 'filed', added: new Date(st.mtimeMs).toISOString(), addedBy: null, addedByName: 'Found in the folder', source: 'folder', sourceLabel: 'Put in the folder',
          deptHint: null, private: false, text: '', textDone: false, suggestion: null };
        d.docs[doc.id] = doc; added.push(doc);
      }
      const live = new Set(files.map((f) => f.rel.toLowerCase()));
      for (const doc of Object.values(d.docs)) {
        const there = doc.status === 'deleted' ? binFiles.has(doc.rel) : live.has(doc.rel.toLowerCase());
        if (!there) { removed.push(doc); delete d.docs[doc.id]; }
      }
      return { added, removed };
    });
  }

  // ---------- rules ----------
  rules() { return this.readData().rules || []; }
  saveRule(rule, who = this.me) {
    this.check('add', rule.folder, who);
    const clean = { id: rule.id || `r${newId()}`, name: String(rule.name || '').trim() || `Anything mentioning ${rule.words[0]}`, words: (rule.words || []).map((w) => String(w).trim()).filter(Boolean),
      folder: rule.folder ? safeFolder(rule.folder) : '', year: rule.year !== false, enabled: rule.enabled !== false };
    if (!clean.words.length) throw new Error('Type the words to look for (for example the supplier\'s name).');
    if (!clean.folder) throw new Error('Pick the folder.');
    this.mutate((d) => { d.rules = [...(d.rules || []).filter((r) => r.id !== clean.id), clean]; });
    this.log({ action: 'rule', detail: `Filing rule: ${clean.name} → ${shown(clean.folder)}` }, who);
    this.resuggest();
    return clean;
  }
  deleteRule(id, who = this.me) { this.mutate((d) => { d.rules = (d.rules || []).filter((r) => r.id !== id); }); this.log({ action: 'rule', detail: 'Removed a filing rule' }, who); this.resuggest(); return true; }

  // ---------- history ----------
  /** Append one line to the library's history (who did what, when). */
  log({ action, doc, from, to, folder, detail, extra }, who = this.me) {
    const line = { at: this.now().toISOString(), who: who ? who.id : null, whoName: who ? who.name : 'Riyeser Documents', action,
      doc: doc ? doc.id : null, name: doc ? doc.name : null, from: from || null, to: to || null, folder: folder || null, detail: detail || '', ...(extra || {}) };
    try { fs.appendFileSync(this.meta('history.jsonl'), `${JSON.stringify(line)}\n`); } catch { /* offline: history is best-effort */ }
    return line;
  }
  /** Newest first. docId: one document's history. */
  history({ docId = null, limit = 300 } = {}) {
    let text = '';
    try {
      // Only the last few MB: years of history stay quick to show
      const f = this.meta('history.jsonl'); const size = fs.statSync(f).size; const keep = 4 * 1024 * 1024;
      if (size <= keep) text = fs.readFileSync(f, 'utf8');
      else { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(keep); fs.readSync(fd, b, 0, keep, size - keep); text = b.toString('utf8'); text = text.slice(text.indexOf('\n') + 1); } finally { fs.closeSync(fd); } }
    } catch { return []; }
    const out = [];
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      let h; try { h = JSON.parse(lines[i]); } catch { continue; }
      if (docId && h.doc !== docId) continue;
      out.push(h);
    }
    return out;
  }
}

function sourceLabel(source) {
  return { upload: 'Upload', printer: 'Office printer', scanner: 'Scanner', email: 'Email', phone: 'Phone', folder: 'Put in the folder', program: 'A Riyeser program' }[source] || 'Upload';
}

module.exports = { Library, OfflineError, safeFolder, DEFAULT_FOLDERS, SPECIAL, EMAIL_IN, BIN_DAYS, typeOf, shown, sourceLabel, relOf };
