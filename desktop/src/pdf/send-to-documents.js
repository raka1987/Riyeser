// Riyeser PDF: "Send to Riyeser Documents". Puts a copy of the PDF in the Riyeser Documents library's Inbox, the same
// way Documents' own Upload does (src/documents/library.js addFile: a copy, a line in the library's list and its
// history, under the library's lock file), so Documents reads it and suggests a folder like any other new document.
// Where the library is: Riyeser Documents' own setting (%APPDATA%\Desk Assistant\data\documents.json), else its
// default folder (Documents\Riyeser Documents). It may be a shared office folder (\\OFFICE-PC\Riyeser Documents).
// Access: the person needs Add access to the library (or to the department they choose), as in Documents.
// Who is sending: the Riyeser account Central is signed in to, else this Windows user (as Riyeser Documents does).
const fs = require('fs');
const os = require('os');
const path = require('path');

const DOCS_DATA = ['Desk Assistant', 'data', 'documents.json'];

function whoAmI(company) {
  const email = company && String(company.email_signed_in || '').trim().toLowerCase();
  if (email) return { id: `u:${email}`, name: (company.your_name || email).trim(), email, company: company.name };
  let user = 'me'; try { user = os.userInfo().username || 'me'; } catch { /* default */ }
  return { id: `local:${user.toLowerCase()}@${os.hostname().toLowerCase()}`, name: (company && company.your_name) || user, email: '', company: company ? company.name : '' };
}

/** Where Riyeser Documents keeps its library on this PC. */
function libraryRoot({ appData, documentsDir }) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(appData, ...DOCS_DATA), 'utf8'));
    if (s && typeof s.root === 'string' && s.root.trim()) return s.root.trim();
  } catch { /* Documents' default */ }
  return path.join(documentsDir, 'Riyeser Documents');
}

/**
 * deps: { appData, documentsDir, readCompany(appData), isDemo(), cacheDir }
 * Returns { target(), send(files, { dept }) }.
 */
function createSender(deps) {
  const { Library } = require('../documents/library');
  function open() {
    if (deps.isDemo && deps.isDemo()) return { error: 'Riyeser is in demo mode, so Riyeser Documents is showing its sample library. Leave demo mode in Riyeser Central first.' };
    const root = libraryRoot(deps);
    const meta = path.join(root, '_Riyeser');
    if (!fs.existsSync(meta)) {
      return { error: /^\\\\/.test(root)
        ? `Can't reach the shared library at ${root}. Check this PC is on the office network.`
        : 'Riyeser Documents isn\'t set up on this PC yet. Install it from Riyeser Central (it\'s free) and open it once.' };
    }
    const me = whoAmI(deps.readCompany ? deps.readCompany(deps.appData) : null);
    const lib = new Library({ root, cacheDir: deps.cacheDir || null, me });
    if (!lib.online()) return { error: `Can't reach the library at ${root} just now.` };
    return { lib, me, root };
  }
  return {
    /** What the Send dialog shows: { ok, root, departments: [{ rel, canAdd }], canAddInbox } or { ok: false, reason } */
    target() {
      const o = open();
      if (o.error) return { ok: false, reason: o.error };
      const departments = o.lib.departments().map((rel) => ({ rel, canAdd: o.lib.can('add', rel, o.me) })).filter((d) => o.lib.can('view', d.rel, o.me));
      return { ok: true, root: o.root, shared: /^\\\\/.test(o.root), who: o.me.name, canAddInbox: o.lib.can('add', '', o.me), departments };
    },
    /** Copy the files into the library's Inbox. dept: a department to suggest (needs Add access there). */
    send(files, { dept = null } = {}) {
      const o = open();
      if (o.error) throw new Error(o.error);
      if (dept) o.lib.check('add', dept, o.me);
      else if (!o.lib.can('add', '', o.me)) throw new Error('You don\'t have access to add documents to the library. Ask the owner to change it in Riyeser Documents › Settings › People & access.');
      const added = [];
      for (const f of files) {
        if (!fs.existsSync(f)) throw new Error(`${path.basename(f)} isn't there any more.`);
        const doc = o.lib.addFile(f, { source: 'program', sourceLabel: 'Riyeser PDF', deptHint: dept || null }, o.me);
        added.push({ id: doc.id, name: doc.name });
      }
      return { added, root: o.root };
    },
  };
}

module.exports = { createSender, libraryRoot, whoAmI };
