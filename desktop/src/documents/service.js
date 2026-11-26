// Riyeser Documents: everything the window asks the program for, as plain functions (channel -> handler).
// main.js wires these to Electron; the tests and the screenshot check call them directly. Anything that needs
// Electron (dialogs, printing, opening files, scanning) comes in through `deps`, so this file runs in plain Node.
const fs = require('fs');
const path = require('path');
const access = require('./access');
const { shown, SPECIAL, EMAIL_IN, BIN_DAYS } = require('./library');
const { networkPath, BRANDS } = require('./scanfolders');

const FROM = { printer: 'Office printer', scanner: 'Scanner', phone: 'Phone', email: 'Email', upload: 'Upload', folder: 'Upload', program: 'A program' };
const fromGroup = (doc) => FROM[doc.source] || 'Upload';
const folderOfDoc = (doc) => (doc.status === 'filed' ? doc.rel.split('/').slice(0, -1).join('/') : doc.status === 'deleted' ? (doc.deletedFrom || '') : (doc.deptHint || ''));
const baseName = (n) => String(n || '').replace(/\.[a-z0-9]{1,5}$/i, '');
const tag = (ext) => (String(ext || '').replace('.', '').toUpperCase().replace('JPEG', 'JPG') || 'FILE').slice(0, 4);
const DAY = 864e5;

// Program links (phase 1: open the program, or "coming soon"; no cross-program integration yet)
const PROGRAM_LINKS = [
  { test: (d) => /invoice|credit note|delivery|purchase order/i.test(`${d.docType} ${d.name}`) && folderOfDoc(d).startsWith('Accounts') || (d.status === 'inbox' && /^Accounts\/Suppliers/.test(d.suggestion?.folder || '') && /Invoices/.test(d.docType || '')), label: 'Make a bill in Accounting', program: 'accounting' },
  { test: (d) => /receipt/i.test(`${d.docType} ${d.name}`), label: 'Make an expense claim', program: 'accounting' },
  { test: (d) => /^Payroll & HR\/Staff/.test(d.suggestion?.folder || folderOfDoc(d)) || /contract|employment/i.test(d.name), label: 'Attach to the staff member in Payroll', program: 'payroll' },
  { test: (d) => /job sheet|^jobs\//i.test(`${d.name} ${d.suggestion?.folder || folderOfDoc(d)}`.toLowerCase()) && /job/i.test(d.name), label: 'Open the job in Bookings', program: 'bookings' },
  { test: (d) => /quote/i.test(d.name), label: 'Open the quote in Bookings', program: 'bookings' },
];
const programLink = (d) => { const l = PROGRAM_LINKS.find((x) => { try { return x.test(d); } catch { return false; } }); return l ? { label: l.label, program: l.program } : null; };

/**
 * deps: {
 *   lib(): the open Library, me(): the person using this PC, settings() / saveSettings(s): this PC's settings,
 *   demo: boolean, version, computer, notify(msg), changed() (tell the window to refresh),
 *   pickFiles(), pickFolder(), openPath(p), reveal(p), openPdf(p), printers(), print(files, opts), scan(opts),
 *   openScanFolder(dir), openProgram(id), openUrl(url), extractText(file), processSoon(), reopen(root)
 * }
 */
function createService(deps) {
  const lib = () => deps.lib();
  const me = () => deps.me();
  const view = () => {
    const L = lib(); const a = L.getAccess(); const p = { ...L.person(me().id), id: me().id };
    return { L, a, p, sees: (doc) => access.canSeeDoc(a, p, doc, folderOfDoc(doc)) };
  };
  const shape = (doc, L, extra = {}) => ({
    id: doc.id, name: baseName(doc.name), file: doc.name, tag: tag(doc.ext), type: doc.type, status: doc.status,
    from: doc.sourceLabel || fromGroup(doc), fromGroup: fromGroup(doc), private: !!doc.private,
    loc: doc.status === 'inbox' ? (doc.suggestion ? shown(doc.suggestion.folder) : (doc.textDone ? 'Pick a folder' : 'Reading it…'))
      : doc.status === 'deleted' ? `Was in ${doc.wasStatus === 'inbox' ? 'Inbox' : shown(doc.deletedFrom)}` : shown(folderOfDoc(doc)),
    suggested: doc.status === 'inbox' && !!doc.suggestion,
    added: doc.added, size: doc.size, deletedAt: doc.deletedAt || null,
    daysLeft: doc.deletedAt ? Math.max(0, Math.ceil((new Date(doc.deletedAt).getTime() + BIN_DAYS * DAY - Date.now()) / DAY)) : null,
    ...extra,
  });

  function list({ place = 'inbox', folder = '', q = '', type = 'All', from = '', sort = 'new' } = {}) {
    const { L, sees, p } = view();
    let docs = L.docs().filter(sees);
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const snippets = new Map();
    if (terms.length) {
      const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      docs = docs.filter((d) => d.status !== 'deleted').map((d) => {
        const name = `${d.name} ${(d.formerNames || []).join(' ')}`.toLowerCase(); const meta = `${folderOfDoc(d)} ${d.company || ''} ${d.sourceLabel || ''}`.toLowerCase(); const text = String(d.text || '').toLowerCase();
        let score = 0; let at = -1;
        for (const t of terms) {
          const re = new RegExp(`(^|[^a-z0-9])${esc(t)}`);
          if (re.test(name)) score += 8; else if (re.test(meta)) score += 4;
          else { const m = re.exec(text); if (!m) return null; score += 2; if (at < 0) at = m.index + m[1].length; }
        }
        if (at >= 0) snippets.set(d.id, String(d.text).slice(Math.max(0, at - 40), at + 90).replace(/\s+/g, ' ').trim());
        return { d, score };
      }).filter(Boolean).sort((a, b) => b.score - a.score).map((x) => x.d);
    } else if (place === 'inbox') docs = docs.filter((d) => d.status === 'inbox');
    else if (place === 'recent') docs = docs.filter((d) => d.status === 'filed' && Date.now() - new Date(d.filed || d.added).getTime() < 30 * DAY);
    else if (place === 'shared') docs = docs.filter((d) => d.status === 'filed' && d.addedBy && d.addedBy !== p.id);
    else if (place === 'mine') docs = docs.filter((d) => d.status !== 'deleted' && d.addedBy === p.id);
    else if (place === 'bin') docs = docs.filter((d) => d.status === 'deleted');
    else if (place === 'folder') { const f = access.normRel(folder); docs = docs.filter((d) => d.status === 'filed' && (folderOfDoc(d) === f || folderOfDoc(d).startsWith(`${f}/`))); }
    const counts = { All: docs.length, Scans: 0, Photos: 0, Documents: 0 };
    for (const d of docs) counts[d.type] = (counts[d.type] || 0) + 1;
    if (type && type !== 'All') docs = docs.filter((d) => d.type === type);
    if (from) docs = docs.filter((d) => fromGroup(d) === from);
    if (!terms.length) {
      const by = { new: (a, b) => String(b.added).localeCompare(String(a.added)), old: (a, b) => String(a.added).localeCompare(String(b.added)),
        name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }), size: (a, b) => (b.size || 0) - (a.size || 0) };
      docs.sort(by[sort] || by.new);
      if (place === 'recent') docs = docs.slice(0, 50);
    }
    const total = docs.length;
    return { total, counts, items: docs.slice(0, 500).map((d) => shape(d, L, snippets.has(d.id) ? { snippet: snippets.get(d.id) } : {})) };
  }

  function navState() {
    const { L, sees, a, p } = view();
    const folders = L.visibleFolders(p);
    const all = L.docs().filter(sees);
    const status = L.status();
    return {
      me: { ...me(), initials: access.initials(me().name), owner: a.owner === me().id, level: L.level('', p) },
      status, demo: !!deps.demo, version: deps.version || '', root: L.root,
      inboxCount: all.filter((d) => d.status === 'inbox').length,
      binCount: all.filter((d) => d.status === 'deleted').length,
      departments: folders.filter((f) => !f.rel.includes('/')),
      folders,
      lockedHidden: L.departments().length - folders.filter((f) => !f.rel.includes('/')).length,
      settings: { theme: (deps.settings() || {}).theme || 'system' },
    };
  }

  function getDoc(id) {
    const { L, sees, a, p } = view();
    const doc = L.doc(id);
    if (!sees(doc)) throw new Error('You don\'t have access to that document.');
    const folder = folderOfDoc(doc);
    const level = access.levelFor(a, p, folder);
    const ownerName = (rec) => ((a.people || []).find((x) => x.id === rec) || {}).name || null;
    return {
      ...shape(doc, L), path: L.docPath(doc), folder, folderParts: (doc.status === 'inbox' ? (doc.suggestion?.folder || '') : folder).split('/').filter(Boolean),
      suggestion: doc.suggestion || null, docType: doc.docType || null, company: doc.company || null,
      addedByName: doc.addedByName || ownerName(doc.addedBy) || 'Someone', textPreview: String(doc.text || '').slice(0, 600), textDone: !!doc.textDone,
      level, canEdit: access.rank(level) >= access.rank('edit') || (doc.status === 'inbox' && doc.addedBy === p.id), canFile: true,
      access: accessSummary(a, folder), locked: folder ? access.isLocked(a, folder.split('/')[0]) : false, link: programLink(doc), history: L.history({ docId: id, limit: 50 }),
      mine: doc.addedBy === p.id, formerNames: doc.formerNames || [], restoreTo: doc.status === 'deleted' ? (doc.wasStatus === 'inbox' ? 'Inbox' : shown(doc.deletedFrom)) : null,
    };
    function accessSummary(acc, f) {
      if (!f) return 'Everyone who uses the library';
      // The closest folder rule above the document, in words: "Everyone: View · Accounts team: Edit"
      const parts = f.split('/'); let rule = null;
      for (let i = parts.length; i > 0 && !rule; i--) rule = (acc.rules || {})[parts.slice(0, i).join('/')] || null;
      if (!rule) return `Everyone: ${access.LABEL[acc.everyone || 'edit']}`;
      const name = (k) => (k === access.EVERYONE ? 'Everyone' : k.startsWith('g:') ? ((acc.groups || []).find((g) => `g:${g.id}` === k) || {}).name : ownerName(k.slice(2)));
      return Object.entries(rule).map(([k, l]) => `${name(k) || 'Someone'}: ${access.LABEL[l]}`).join(' · ') + ' · Owner: Full';
    }
  }

  const each = (ids, fn) => {
    const ok = []; const failed = [];
    for (const id of [].concat(ids || [])) { try { ok.push(fn(id)); } catch (e) { failed.push({ id, reason: e.message }); } }
    deps.changed && deps.changed();
    if (!ok.length && failed.length) throw new Error(failed[0].reason);
    return { done: ok.length, failed };
  };
  const check = (doc) => { const { sees } = view(); if (!sees(doc)) throw new Error('You don\'t have access to that document.'); return doc; };

  async function addFiles(files, meta = {}) {
    const L = lib(); const added = []; const failed = [];
    for (const f of files || []) {
      try { added.push(L.addFile(f, { source: 'upload', ...meta }, me())); } catch (e) { failed.push({ file: path.basename(f), reason: e.message }); }
    }
    if (added.length) { deps.changed && deps.changed(); deps.processSoon && deps.processSoon(); }
    if (!added.length && failed.length) throw new Error(failed[0].reason);
    return { added: added.length, failed };
  }

  /** Read the text of new documents and suggest folders (OCR for scans). */
  async function processPending({ limit = 20 } = {}) {
    const L = lib();
    if (!L.online()) return 0;
    let n = 0;
    for (const doc of L.docs().filter((d) => !d.textDone && d.status !== 'deleted').slice(0, limit)) {
      let text = '';
      try { text = await deps.extractText(L.docPath(doc)); } catch { text = ''; }
      L.setText(doc.id, text);
      n++;
    }
    if (n) deps.changed && deps.changed();
    return n;
  }

  function scanSetup() {
    const L = lib();
    const shared = L.isNetwork || /^\\\\/.test(L.root);
    const deps2 = L.departments();
    return {
      root: L.root, shared, computer: deps.computer || '',
      folders: [...deps2.map((d) => ({ dept: d, dir: path.join(L.root, SPECIAL.scans, d), network: networkPath(L.root, d, { computer: deps.computer }), canAdd: L.can('add', d, me()) })),
        { dept: null, label: EMAIL_IN, dir: path.join(L.root, SPECIAL.scans, EMAIL_IN), network: networkPath(L.root, null, { computer: deps.computer }), canAdd: true, later: true }],
      brands: BRANDS,
    };
  }

  function accessState() {
    const L = lib(); const a = L.getAccess(); const p = { ...L.person(me().id), id: me().id };
    const folders = L.folders();
    return {
      owner: a.owner, ownerName: ((a.people || []).find((x) => x.id === a.owner) || {}).name || 'Not set', me: me().id, canManage: access.levelFor(a, p, '') === 'full' || a.owner === me().id,
      people: a.people || [], groups: a.groups || [], everyone: a.everyone || 'edit', levels: access.LEVELS.map((l) => ({ id: l, label: access.LABEL[l] })),
      folders: folders.filter((f) => f.split('/').length <= 2).map((f) => ({ rel: f, locked: access.isLocked(a, f), rule: (a.rules || {})[f] || {}, mine: access.levelFor(a, p, f), canChange: access.can(a, p, 'permissions', f) })),
      network: L.isNetwork,
    };
  }

  const h = {
    'docs:state': () => navState(),
    'docs:list': (opts) => list(opts),
    'docs:get': (id) => getDoc(id),
    'docs:bytes': async (id) => { const L = lib(); const d = check(L.doc(id)); const p = L.docPath(d); if (fs.statSync(p).size > 60 * 1024 * 1024) throw new Error('Too big to preview: click Open.'); return new Uint8Array(await fs.promises.readFile(p)); },
    'docs:folders': () => { const { L, p } = view(); return L.visibleFolders(p).map((f) => ({ ...f, canAdd: access.rank(f.level) >= access.rank('add') })); },
    'docs:file': (id, folder, opts = {}) => { const r = lib().fileDoc(id, folder, opts, me()); deps.changed && deps.changed(); return shape(r, lib()); },
    'docs:fileAll': (ids) => { const L = lib(); const r = L.fileAll(ids || L.docs().filter((d) => d.status === 'inbox' && d.suggestion && view().sees(d)).map((d) => d.id), me()); deps.changed && deps.changed(); return { filed: r.filed.length, skipped: r.skipped }; },
    'docs:move': (ids, folder) => each(ids, (id) => lib().move(id, folder, me())),
    'docs:rename': (id, name) => { const r = lib().rename(id, name, me()); deps.changed && deps.changed(); return shape(r, lib()); },
    'docs:delete': (ids) => each(ids, (id) => check(lib().doc(id)) && lib().remove(id, me())),
    'docs:restore': (ids) => each(ids, (id) => check(lib().doc(id)) && lib().restore(id, me())),
    'docs:emptyBin': () => { const g = lib().purge({ all: true }, me()); deps.changed && deps.changed(); return g.length; },
    'docs:private': (id, on) => { const r = lib().setPrivate(id, on, me()); deps.changed && deps.changed(); return r.private; },
    'docs:upload': async (files) => { const list2 = files && files.length ? files : await deps.pickFiles(); return list2 && list2.length ? addFiles(list2) : { added: 0, failed: [] }; },
    'docs:open': async (id) => { const L = lib(); const d = check(L.doc(id)); L.log({ action: 'opened', doc: d, detail: 'Opened' }, me()); return deps.openPath(L.docPath(d)); },
    'docs:reveal': (id) => { const L = lib(); return deps.reveal(L.docPath(check(L.doc(id)))); },
    'docs:openPdf': (id) => { const L = lib(); const d = check(L.doc(id)); if (d.ext !== '.pdf') throw new Error('Riyeser PDF opens PDFs. Use Open for this file.'); return deps.openPdf(L.docPath(d)); },
    'docs:printers': () => deps.printers(),
    'docs:print': async (ids, opts = {}) => {
      const L = lib(); const docs = [].concat(ids).map((id) => check(L.doc(id)));
      await deps.print(docs.map((d) => L.docPath(d)), opts);
      for (const d of docs) L.log({ action: 'printed', doc: d, detail: `Printed${opts.printer ? ` on ${opts.printer}` : ''}${opts.copies > 1 ? ` (${opts.copies} copies)` : ''}` }, me());
      deps.saveSettings({ ...deps.settings(), lastPrinter: opts.printer || '' });
      return docs.length;
    },
    'docs:scan': async (opts = {}) => {
      const r = await deps.scan(opts);
      if (r.ok) { await addFiles([r.file], { source: 'scanner', sourceLabel: 'Scanner', deptHint: opts.dept || null, move: true }); return { ok: true }; }
      return r;
    },
    'docs:scanSetup': () => scanSetup(),
    'docs:openScanFolder': (dept) => { const L = lib(); const d = dept || EMAIL_IN; if (d !== EMAIL_IN && !L.departments().includes(d)) throw new Error('No such scan folder.'); return deps.openScanFolder(path.join(L.root, SPECIAL.scans, d)); },
    'docs:copy': (text) => deps.copy(String(text || '')),
    'docs:history': (opts = {}) => {
      const { L, sees } = view(); const byId = new Map(L.docs().map((d) => [d.id, d]));
      return L.history({ docId: opts.docId || null, limit: opts.limit || 300 }).filter((x) => !x.doc || !byId.has(x.doc) || sees(byId.get(x.doc)));
    },
    'folders:create': (rel) => { const r = lib().createFolder(rel, me()); deps.changed && deps.changed(); return r; },
    'rules:list': () => lib().rules().map((r) => ({ ...r, where: shown(r.folder) + (r.year ? ' › (year)' : '') })),
    'rules:save': (rule) => { const r = lib().saveRule(rule, me()); deps.changed && deps.changed(); return r; },
    'rules:delete': (id) => { lib().deleteRule(id, me()); deps.changed && deps.changed(); return true; },
    'access:get': () => accessState(),
    'access:setRule': (folder, who, level) => { const L = lib(); const p = { ...L.person(me().id), id: me().id }; L.updateAccess((a) => access.setRule(a, p, folder, who, level)); L.log({ action: 'access', folder, detail: `Access to ${shown(folder) || 'the library'}: ${who === 'everyone' ? 'Everyone' : who} → ${access.LABEL[level] || 'as before'}` }, me()); deps.changed && deps.changed(); return accessState(); },
    'access:savePerson': (person) => {
      const L = lib(); if (!accessState().canManage) throw new Error('Only the owner can add or change people.');
      const id = person.id || (person.email ? `u:${String(person.email).toLowerCase().trim()}` : `local:${String(person.name || '').toLowerCase().replace(/\s+/g, '.')}`);
      if (!String(person.name || person.email || '').trim()) throw new Error('Type their name.');
      L.updateAccess((a) => access.upsertPerson(a, { ...person, id })); deps.changed && deps.changed(); return accessState();
    },
    'access:removePerson': (id) => { const L = lib(); if (!accessState().canManage) throw new Error('Only the owner can remove people.'); if (id === L.getAccess().owner) throw new Error('The owner can\'t be removed. Make someone else the owner first.'); L.updateAccess((a) => ({ ...a, people: (a.people || []).filter((p) => p.id !== id) })); return accessState(); },
    'access:setOwner': (id) => { const L = lib(); if (L.getAccess().owner !== me().id) throw new Error('Only the owner can hand over ownership.'); L.updateAccess((a) => ({ ...a, owner: id })); L.log({ action: 'access', detail: 'Changed the owner' }, me()); return accessState(); },
    'access:setEveryone': (level) => { const L = lib(); if (L.getAccess().owner !== me().id) throw new Error('Only the owner can change this.'); L.updateAccess((a) => ({ ...a, everyone: access.LEVELS.includes(level) ? level : 'edit' })); return accessState(); },
    'settings:get': () => ({ ...deps.settings(), root: lib().root, demo: !!deps.demo, defaultRoot: deps.defaultRoot || '' }),
    'settings:set': (s) => { const cur = deps.settings(); const next = { ...cur, ...s }; deps.saveSettings(next); if (s.theme && deps.applyTheme) deps.applyTheme(s.theme); return next; },
    'settings:chooseRoot': async () => { const p = await deps.pickFolder(); return p || null; },
    'settings:setRoot': async (root) => { if (deps.demo) throw new Error('In demo mode the sample library is used. Leave demo mode in Riyeser Central first.'); const r = await deps.reopen(String(root || '').trim()); deps.changed && deps.changed(); return r; },
    'program:open': (id) => deps.openProgram(id),
    'link:open': (url) => { if (/^https:\/\//i.test(url)) deps.openUrl(url); return true; },
  };
  h.processPending = processPending; // not a channel: main.js runs it in the background
  h.addFiles = addFiles;
  return h;
}

module.exports = { createService, programLink, fromGroup, folderOfDoc };
