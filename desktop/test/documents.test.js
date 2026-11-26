// Riyeser Documents (phase 1): the library, suggested filing, scan folders, the Recycle bin, access and history.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library, SPECIAL } = require('../src/documents/library');
const access = require('../src/documents/access');
const { suggest, makeExample, defaultRules } = require('../src/documents/suggest');
const { scanFolders, pollOnce, networkPath, BRANDS } = require('../src/documents/scanfolders');
const scanner = require('../src/documents/scanner');
const { createService } = require('../src/documents/service');
const { seedDemo, photoPng, textPdf } = require('../src/documents/demo');
const { extractText } = require('../src/core/extract');

const OWNER = { id: 'u:rosa@example.com', name: 'Rosa Mendes' };
const JAMIE = { id: 'u:jamie@example.com', name: 'Jamie Lee' };
const ANA = { id: 'u:ana@example.com', name: 'Ana Ruiz' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-docs-'));
function newLib(opts = {}) {
  const dir = tmp();
  const lib = new Library({ root: path.join(dir, 'Riyeser Documents'), cacheDir: path.join(dir, 'cache'), me: OWNER, ...opts });
  lib.ensureLayout();
  lib.updateAccess((a) => access.upsertPerson(access.upsertPerson(a, { ...JAMIE, groups: ['accounts'] }), { ...ANA, groups: ['payroll'] }));
  return { lib, dir, as: (who) => new Library({ root: lib.root, cacheDir: path.join(dir, `cache-${who.id}`), me: who }) };
}
function put(dir, name, text) { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); fs.writeFileSync(f, text); return f; }
async function addAndRead(lib, file, meta = {}) { const d = lib.addFile(file, meta); return lib.setText(d.id, await extractText(lib.docPath(lib.doc(d.id)))); }
const year = String(new Date().getFullYear());

// ---------- the library ----------
test('a new library has the department folders, the Inbox, scan folders, Recycle bin and its shared files; the first person is the owner', () => {
  const { lib } = newLib();
  for (const f of ['Accounts/Suppliers', 'Accounts/Bank statements', 'Accounts/Tax', 'Payroll & HR', 'Sales', 'Jobs', 'Admin']) assert.ok(fs.statSync(lib.abs(f)).isDirectory(), f);
  for (const s of ['_Inbox', '_Recycle bin', '_Riyeser', '_Scans/Accounts', '_Scans/Payroll & HR', '_Scans/Email in']) assert.ok(fs.existsSync(lib.abs(s)), s);
  assert.deepStrictEqual(lib.departments(), ['Accounts', 'Admin', 'Jobs', 'Payroll & HR', 'Sales']);
  assert.strictEqual(lib.getAccess().owner, OWNER.id);
  assert.ok(lib.getAccess().people.some((p) => p.id === OWNER.id && p.initials === 'RM'));
  // Opening it again (another PC) doesn't recreate deleted department folders or change the owner
  fs.rmSync(lib.abs('Sales'), { recursive: true });
  const other = new Library({ root: lib.root, cacheDir: tmp(), me: JAMIE }); other.ensureLayout();
  assert.ok(!fs.existsSync(lib.abs('Sales')));
  assert.strictEqual(other.getAccess().owner, OWNER.id);
});

test('indexing: an upload is copied to the Inbox, its text is read and saved, and search finds words inside it', async () => {
  const { lib, dir } = newLib();
  const src = put(path.join(dir, 'Downloads'), 'scan0001.pdf', '');
  fs.writeFileSync(src, await textPdf('Invoice', 'Pacific Hardware Ltd', ['TAX INVOICE', 'Pacific Hardware Ltd', 'Invoice number: INV-2291', 'Timber 90x45 H3 x 24', 'Total due $1,284.50']));
  const doc = await addAndRead(lib, src, { source: 'upload' });
  assert.ok(fs.existsSync(src), 'the original stays where it was');
  assert.strictEqual(doc.status, 'inbox'); assert.strictEqual(doc.rel, '_Inbox/scan0001.pdf'); assert.strictEqual(doc.ext, '.pdf');
  assert.match(doc.text, /Timber 90x45/); assert.ok(doc.textDone); assert.ok(doc.size > 500);
  assert.strictEqual(doc.addedBy, OWNER.id);
  const svc = createService({ lib: () => lib, me: () => OWNER, settings: () => ({}), saveSettings() {} });
  const r = svc['docs:list']({ q: 'timber' });
  assert.deepStrictEqual(r.items.map((i) => i.name), ['scan0001']);
  assert.match(r.items[0].snippet, /Timber 90x45/);
  // a second upload with the same name doesn't overwrite the first
  const again = lib.addFile(src, { source: 'upload' });
  assert.strictEqual(again.rel, '_Inbox/scan0001 (2).pdf');
});

test('indexing: files put into the folders in File Explorer are picked up; ones deleted there drop off', () => {
  const { lib } = newLib();
  put(lib.abs('Sales'), 'Quote Q-0318.txt', 'Quote for Northshore Fitness');
  put(lib.abs('_Inbox'), 'From scanner.txt', 'hello');
  put(lib.abs('Sales'), 'desktop.ini', 'x');
  const r = lib.reconcile();
  assert.deepStrictEqual(r.added.map((d) => [d.rel, d.status]).sort(), [['Sales/Quote Q-0318.txt', 'filed'], ['_Inbox/From scanner.txt', 'inbox']]);
  assert.strictEqual(lib.reconcile().added.length, 0, 'only once');
  fs.rmSync(lib.abs('Sales/Quote Q-0318.txt'));
  assert.deepStrictEqual(lib.reconcile().removed.map((d) => d.rel), ['Sales/Quote Q-0318.txt']);
});

test('a shared network folder that is briefly unreachable: the last list is shown, changes are refused politely, nothing crashes', async () => {
  const { lib, dir } = newLib();
  await addAndRead(lib, put(dir, 'a.txt', 'BSP statement'), {});
  const away = `${lib.root}-away`;
  fs.renameSync(lib.root, away); // the office PC went off
  const st = lib.status();
  assert.strictEqual(st.online, false); assert.match(st.error, /can't be reached right now/);
  assert.strictEqual(lib.docs().length, 1, 'shown from this PC\'s copy');
  assert.throws(() => lib.addFile(put(dir, 'b.txt', 'x')), /can't be reached right now, so nothing was changed/);
  assert.deepStrictEqual(lib.reconcile(), { added: [], removed: [] });
  assert.deepStrictEqual(lib.purge(), []);
  const svc = createService({ lib: () => lib, me: () => OWNER, settings: () => ({}), saveSettings() {} });
  assert.strictEqual(svc['docs:state']().status.online, false);
  assert.strictEqual(svc['docs:list']({ place: 'inbox' }).total, 1);
  fs.renameSync(away, lib.root); // back again
  assert.strictEqual(lib.status().online, true);
  assert.ok(lib.addFile(put(dir, 'c.txt', 'y')));
});

test('folders can\'t point outside the library or into its own special folders', async () => {
  const { lib, dir } = newLib();
  const d = await addAndRead(lib, put(dir, 'x.txt', 'hello'));
  for (const bad of ['../outside', 'Accounts/../../outside', '_Recycle bin', '_Riyeser', '.hidden', '']) assert.throws(() => lib.fileDoc(d.id, bad), /isn't a folder in the library|Pick a folder/, bad);
  assert.strictEqual(lib.createFolder('Sales/../../evil'), 'Sales/evil', 'dots are dropped, never followed');
  assert.throws(() => lib.createFolder('_Scans'), /can't start with _/);
  assert.strictEqual(lib.createFolder('Sales/Customers.'), 'Sales/Customers');
});

test('two PCs saving at once don\'t lose each other\'s changes (lock file); a stale lock is cleared', () => {
  const { lib, as, dir } = newLib();
  const other = as(JAMIE);
  for (let i = 0; i < 5; i++) { lib.addFile(put(dir, `a${i}.txt`, 'a')); other.addFile(put(dir, `b${i}.txt`, 'b')); }
  assert.strictEqual(lib.docs().length, 10);
  fs.writeFileSync(lib.meta('library.lock'), 'crashed PC');
  const old = (Date.now() - 60_000) / 1000; fs.utimesSync(lib.meta('library.lock'), old, old);
  assert.ok(lib.addFile(put(dir, 'c.txt', 'c')));
  assert.ok(!fs.existsSync(lib.meta('library.lock')));
});

// ---------- suggestions ----------
test('suggestions: your rules come first ("anything from BSP goes in Accounts › Bank statements"), by year', () => {
  const s = suggest({ name: 'scan_0042.pdf', ext: '.pdf', text: 'BSP Bank South Pacific\nStatement period 1 October 2026 to 31 October 2026\nOpening balance', added: '2026-11-03T10:00:00Z' }, { rules: defaultRules(), departments: ['Accounts', 'Admin'] });
  assert.strictEqual(s.folder, 'Accounts/Bank statements/2026');
  assert.match(s.because, /Your rule: Anything from BSP/);
});
test('suggestions: what the document is and who it is from (supplier invoice, payslip, quote, tax)', () => {
  const deps = ['Accounts', 'Payroll & HR', 'Sales', 'Jobs', 'Admin'];
  const inv = suggest({ name: 'scan.pdf', ext: '.pdf', text: 'TAX INVOICE\nPacific Hardware Ltd\nInvoice number: INV-2291\nDate: 26/11/2026\nAmount due $1,284.50\nPayment terms 20th', added: '2026-11-26T09:00:00Z' }, { departments: deps });
  assert.strictEqual(inv.folder, 'Accounts/Suppliers/Pacific Hardware/2026');
  assert.match(inv.because, /invoice from Pacific Hardware/);
  assert.match(inv.name, /Pacific Hardware.*Invoice.*INV-2291\.pdf$/);
  assert.strictEqual(suggest({ name: 'Payslip Ana.pdf', ext: '.pdf', text: 'Payslip\nPay period 1-14 Nov 2026\nGross pay 1,200\nNet pay 1,000', added: '2026-11-15T00:00:00Z' }, { departments: deps }).folder, 'Payroll & HR/Pay/2026');
  assert.strictEqual(suggest({ name: 'Quote Q-0318.pdf', ext: '.pdf', text: 'Quotation\nQuote number Q-0318\nValid until 30 Dec 2026', added: '2026-11-20T00:00:00Z' }, { departments: deps }).folder, 'Sales/Quotes/2026');
  assert.strictEqual(suggest({ name: 'VAT return Q3.pdf', ext: '.pdf', text: 'VAT return for the tax year', added: '2026-10-20T00:00:00Z' }, { rules: defaultRules(), departments: deps }).folder, 'Accounts/Tax/2026');
});
test('suggestions: the scan folder it came in through keeps it in that department', () => {
  const s = suggest({ name: 'Scan 0001.pdf', ext: '.pdf', text: '', deptHint: 'Payroll & HR', added: '2026-11-26T00:00:00Z' }, { departments: ['Accounts', 'Payroll & HR'] });
  assert.strictEqual(s.folder, 'Payroll & HR/2026'); assert.match(s.because, /Scanned to the Payroll & HR scan folder/);
});
test('suggestions learn from past filings: after filing two Harbour Cafe job sheets in Jobs › Harbour Cafe, the next one goes there', async () => {
  const { lib, dir } = newLib();
  for (const n of [1041, 1042]) {
    const d = await addAndRead(lib, put(dir, `Harbour Cafe job sheet ${n}.txt`, `Harbour Cafe job sheet ${n}\nHot water cylinder serviced\nSigned by the cafe manager`));
    lib.fileDoc(d.id, `Jobs/Harbour Cafe/${year}`);
  }
  const next = await addAndRead(lib, put(dir, 'Harbour Cafe job sheet 1050.txt', 'Harbour Cafe job sheet 1050\nHot water cylinder replaced\nSigned by the cafe manager'));
  assert.strictEqual(next.suggestion.folder, `Jobs/Harbour Cafe/${year}`);
  assert.match(next.suggestion.because, /You filed 2 similar documents here/);
  // "Change" counts more: one explicit choice is enough for a close match
  const ex = makeExample({ name: 'Northshore gym roster.txt', text: 'Northshore Fitness gym roster for the week of classes and trainers', ext: '.txt' }, 'Sales/Northshore Fitness', true);
  const s = suggest({ name: 'Northshore gym roster 2.txt', ext: '.txt', text: 'Northshore Fitness gym roster for the week of classes and trainers' }, { examples: [ex], departments: ['Sales', 'Admin'] });
  assert.strictEqual(s.folder, 'Sales/Northshore Fitness');
});
test('a new filing rule updates the suggestions already in the Inbox', async () => {
  const { lib, dir } = newLib();
  const d = await addAndRead(lib, put(dir, 'note.txt', 'Letter from Coral Coast Rentals about the forklift hire'));
  assert.notStrictEqual(d.suggestion.folder, 'Admin/Hire');
  lib.saveRule({ words: ['Coral Coast Rentals'], folder: 'Admin/Hire', year: false });
  assert.strictEqual(lib.doc(d.id).suggestion.folder, 'Admin/Hire');
});

// ---------- scan folders ----------
test('scan folders: a printer scan appears in the Inbox once it has finished writing, with its department set', async () => {
  const { lib } = newLib();
  const folders = scanFolders(lib.root, lib.departments());
  assert.ok(folders.some((f) => f.dept === 'Accounts' && f.dir === path.join(lib.root, '_Scans', 'Accounts')));
  assert.ok(folders.some((f) => f.dept === null && f.source === 'email'));
  const state = new Map(); const got = [];
  const onFile = (file, f) => { got.push(lib.addFile(file, { move: true, trusted: true, source: f.source, deptHint: f.dept })); };
  const scan = put(path.join(lib.root, '_Scans', 'Accounts'), 'SCAN_20261126_0912.pdf', 'pretend pdf');
  put(path.join(lib.root, '_Scans', 'Accounts'), 'notes.ini', 'not a scan');
  assert.deepStrictEqual(await pollOnce(folders, state, onFile), [], 'first sight: it may still be writing');
  fs.appendFileSync(scan, ' more'); // still being written
  assert.deepStrictEqual(await pollOnce(folders, state, onFile), []);
  assert.deepStrictEqual(await pollOnce(folders, state, onFile), [scan], 'unchanged since the last check: taken');
  assert.ok(!fs.existsSync(scan), 'the printer\'s folder is left empty');
  assert.strictEqual(got.length, 1);
  const doc = lib.doc(got[0].id);
  assert.deepStrictEqual([doc.status, doc.deptHint, doc.source, doc.sourceLabel, doc.type], ['inbox', 'Accounts', 'printer', 'Office printer', 'Scans']);
  // A scan to Payroll & HR is only visible to people who can see Payroll & HR
  const p = put(path.join(lib.root, '_Scans', 'Payroll & HR'), 'contract.pdf', 'x');
  await pollOnce(folders, state, onFile); await pollOnce(folders, state, onFile);
  assert.ok(!fs.existsSync(p));
  const svcAs = (who) => createService({ lib: () => new Library({ root: lib.root, cacheDir: tmp(), me: who }), me: () => who, settings: () => ({}), saveSettings() {} });
  assert.deepStrictEqual(svcAs(JAMIE)['docs:list']({ place: 'inbox' }).items.map((i) => i.name), ['SCAN_20261126_0912']);
  assert.strictEqual(svcAs(ANA)['docs:list']({ place: 'inbox' }).total, 2);
});
test('scan folders: the network path to type into the printer, and steps for common brands', () => {
  assert.strictEqual(networkPath('\\\\OFFICE-PC\\Riyeser Documents', 'Accounts'), '\\\\OFFICE-PC\\Riyeser Documents\\_Scans\\Accounts');
  assert.strictEqual(networkPath('C:\\Users\\rosa\\Documents\\Riyeser Documents', 'Payroll & HR', { computer: 'office-pc' }), '\\\\OFFICE-PC\\Riyeser Documents\\_Scans\\Payroll & HR');
  assert.strictEqual(networkPath('\\\\NAS\\docs\\', null), '\\\\NAS\\docs\\_Scans\\Email in');
  for (const b of ['HP', 'Canon', 'Brother', 'Ricoh', 'Epson']) assert.ok(BRANDS.some((x) => x.name.startsWith(b) && x.steps.length >= 3), b);
});

// ---------- filing, moving, recycle bin ----------
test('File it moves the file into the folder (made if needed), renames it if asked, and learns; File all files the rest', async () => {
  const { lib, dir } = newLib();
  const d = await addAndRead(lib, put(dir, 'scan.txt', 'TAX INVOICE\nPacific Hardware Ltd\nInvoice number: INV-2291\nDate: 26/11/2026\nAmount due $1,284.50'));
  const filed = lib.fileDoc(d.id, d.suggestion.folder, { name: d.suggestion.name });
  assert.strictEqual(filed.status, 'filed');
  assert.strictEqual(filed.rel, `${d.suggestion.folder}/${d.suggestion.name}`);
  assert.ok(fs.existsSync(lib.docPath(filed))); assert.ok(!fs.existsSync(lib.abs('_Inbox/scan.txt')));
  assert.strictEqual(lib.readData().examples.length, 1);
  assert.throws(() => lib.fileDoc(d.id, 'Admin'), /already been filed/);
  const a = await addAndRead(lib, put(dir, 'BSP Oct.txt', 'BSP statement'));
  const b = await addAndRead(lib, put(dir, 'BSP Nov.txt', 'BSP statement'));
  const r = lib.fileAll([a.id, b.id]);
  assert.strictEqual(r.filed.length, 2);
  assert.ok(r.filed.every((x) => x.rel.startsWith('Accounts/Bank statements/')));
});
test('move, rename (the old name still finds it), delete to the Recycle bin, restore to where it was, removed for good after 30 days', async () => {
  let now = new Date('2026-11-01T09:00:00Z');
  const { lib, dir } = newLib({ now: () => now });
  const d = await addAndRead(lib, put(dir, 'lease.txt', 'Lease renewal for Shop 4'));
  lib.fileDoc(d.id, 'Admin');
  const moved = lib.move(d.id, 'Admin/Property');
  assert.strictEqual(moved.rel, 'Admin/Property/lease.txt'); assert.ok(fs.existsSync(lib.abs('Admin/Property/lease.txt')));
  const renamed = lib.rename(d.id, 'Lease renewal 2027');
  assert.strictEqual(renamed.name, 'Lease renewal 2027.txt', 'keeps its .txt');
  const svc = createService({ lib: () => lib, me: () => OWNER, settings: () => ({}), saveSettings() {} });
  assert.strictEqual(svc['docs:list']({ q: 'lease.txt' }).total, 1, 'the old name still finds it');
  const gone = lib.remove(d.id);
  assert.strictEqual(gone.status, 'deleted'); assert.strictEqual(gone.deletedFrom, 'Admin/Property'); assert.strictEqual(gone.name, 'Lease renewal 2027.txt', 'shown under its own name in the bin');
  assert.ok(gone.rel.startsWith(`${SPECIAL.bin}/`)); assert.ok(fs.existsSync(lib.docPath(gone))); assert.ok(!fs.existsSync(lib.abs('Admin/Property/Lease renewal 2027.txt')));
  assert.strictEqual(svc['docs:list']({ place: 'bin' }).items[0].daysLeft >= 0, true);
  assert.strictEqual(svc['docs:list']({ q: 'lease' }).total, 0, 'deleted documents aren\'t in search');
  const back = lib.restore(d.id);
  assert.strictEqual(back.status, 'filed'); assert.strictEqual(back.rel, 'Admin/Property/Lease renewal 2027.txt');
  // An Inbox document goes back to the Inbox
  const i = await addAndRead(lib, put(dir, 'misc.txt', 'hello'));
  lib.remove(i.id); assert.strictEqual(lib.restore(i.id).status, 'inbox');
  // 30 days
  lib.remove(d.id);
  now = new Date('2026-11-20T09:00:00Z'); assert.deepStrictEqual(lib.purge(), []);
  now = new Date('2026-12-02T09:00:00Z');
  const purged = lib.purge();
  assert.deepStrictEqual(purged.map((x) => x.id), [d.id]);
  assert.throws(() => lib.doc(d.id), /isn't in the library/);
  assert.deepStrictEqual(fs.readdirSync(lib.abs(SPECIAL.bin)), []);
});

// ---------- access ----------
test('access: a locked folder is hidden from people without access; its documents don\'t show in lists or search', async () => {
  const { lib, as, dir } = newLib();
  const d = await addAndRead(lib, put(dir, 'Ana contract.txt', 'Employment agreement for Ana Ruiz'));
  lib.fileDoc(d.id, 'Payroll & HR/Staff');
  assert.ok(access.isLocked(lib.getAccess(), 'Payroll & HR'), 'Payroll & HR is locked by default');
  const jamie = as(JAMIE); const ana = as(ANA);
  assert.ok(!jamie.visibleFolders().some((f) => f.rel.startsWith('Payroll')));
  assert.ok(ana.visibleFolders().some((f) => f.rel === 'Payroll & HR/Staff'));
  const svc = (who, l) => createService({ lib: () => l, me: () => who, settings: () => ({}), saveSettings() {} });
  assert.strictEqual(svc(JAMIE, jamie)['docs:list']({ q: 'employment' }).total, 0);
  assert.strictEqual(svc(JAMIE, jamie)['docs:list']({ place: 'folder', folder: 'Payroll & HR' }).total, 0);
  assert.throws(() => svc(JAMIE, jamie)['docs:get'](d.id), /don't have access/);
  await assert.rejects(() => svc(JAMIE, jamie)['docs:bytes'](d.id), /don't have access/);
  assert.strictEqual(svc(ANA, ana)['docs:list']({ q: 'employment' }).total, 1);
  assert.ok(svc(JAMIE, jamie)['docs:state']().lockedHidden >= 1);
});
test('access: View can open but not move, rename or delete; Add can file but not move out; the owner always has Full', async () => {
  const { lib, as, dir } = newLib();
  lib.updateAccess((a) => access.setRule(access.setRule(a, OWNER, 'Accounts', 'everyone', 'view'), OWNER, 'Admin', `p:${JAMIE.id}`, 'add'));
  const d = await addAndRead(lib, put(dir, 'stmt.txt', 'BSP statement'));
  const filed = lib.fileDoc(d.id, 'Accounts/Bank statements');
  const jamie = as(JAMIE);
  assert.strictEqual(jamie.level('Accounts/Bank statements'), 'view');
  assert.ok(jamie.canSee(jamie.doc(filed.id)));
  assert.throws(() => jamie.move(filed.id, 'Admin'), /don't have access to move documents in Accounts › Bank statements/);
  assert.throws(() => jamie.rename(filed.id, 'x'), /don't have access to rename/);
  assert.throws(() => jamie.remove(filed.id), /don't have access to delete/);
  // Add: can file into Admin, can't then move it away
  const mine = await addAndRead(jamie, put(dir, 'note.txt', 'a note'));
  assert.throws(() => jamie.fileDoc(mine.id, 'Accounts/Tax'), /don't have access to file documents in Accounts › Tax/);
  const inAdmin = jamie.fileDoc(mine.id, 'Admin');
  assert.throws(() => jamie.move(inAdmin.id, 'Jobs'), /don't have access to move/);
  // The owner keeps Full even when a rule says No access for everyone, or for the owner by name
  lib.updateAccess((a) => access.setRule(access.setRule(a, OWNER, 'Accounts', 'everyone', 'none'), OWNER, 'Accounts', `p:${OWNER.id}`, 'none'));
  assert.strictEqual(lib.level('Accounts/Bank statements'), 'full');
  assert.ok(lib.move(filed.id, 'Admin'));
  assert.throws(() => access.setRule(lib.getAccess(), JAMIE, 'Admin', 'everyone', 'full'), /Only the owner/);
});
test('access: levels follow the closest folder rule; a person\'s own rule beats their groups, groups beat Everyone', () => {
  const a = { ...access.defaultAccess('o'), people: [{ id: 'j', groups: ['accounts'] }, { id: 's', groups: [] }] };
  let x = access.setRule(a, { id: 'o' }, 'Accounts', 'everyone', 'view');
  x = access.setRule(x, { id: 'o' }, 'Accounts', 'g:accounts', 'edit');
  x = access.setRule(x, { id: 'o' }, 'Accounts/Tax', `p:j`, 'none');
  assert.strictEqual(access.levelFor(x, { id: 's' }, 'Accounts/Suppliers/Acme'), 'view');
  assert.strictEqual(access.levelFor(x, { id: 'j' }, 'Accounts/Suppliers/Acme'), 'edit');
  assert.strictEqual(access.levelFor(x, { id: 'j' }, 'Accounts/Tax/2026'), 'none');
  assert.strictEqual(access.levelFor(x, { id: 's' }, 'Accounts/Tax'), 'view', 'Jamie\'s rule is only for Jamie');
  assert.strictEqual(access.levelFor(x, { id: 's' }, 'Sales'), 'edit', 'no rule: the library default');
  assert.strictEqual(access.levelFor(x, { id: 'o' }, 'Accounts/Tax'), 'full');
  assert.strictEqual(access.levelFor(x, { id: 'j', groups: [] }, 'Payroll & HR'), 'none');
});
test('access: a Private document is only seen by whoever added it, the owner and Full access', async () => {
  const { lib, as, dir } = newLib();
  const jamie = as(JAMIE); const ana = as(ANA);
  const d = await addAndRead(jamie, put(dir, 'my review.txt', 'performance review notes'));
  jamie.fileDoc(d.id, 'Admin');
  jamie.setPrivate(d.id, true);
  assert.ok(jamie.canSee(jamie.doc(d.id)));
  assert.ok(lib.canSee(lib.doc(d.id)), 'owner');
  assert.ok(!ana.canSee(ana.doc(d.id)));
  assert.throws(() => ana.setPrivate(d.id, false), /don't have access/);
  assert.throws(() => ana.move(d.id, 'Sales'), /don't have access/);
  assert.throws(() => ana.remove(d.id), /don't have access/);
});

// ---------- history ----------
test('history: who added, filed, moved, renamed, printed, deleted and restored, per document and overall', async () => {
  const { lib, as, dir } = newLib();
  const d = await addAndRead(lib, put(dir, 'stmt.txt', 'BSP statement'));
  lib.fileDoc(d.id, 'Accounts/Bank statements');
  as(JAMIE).move(d.id, 'Admin'); // Everyone can edit by default
  lib.rename(d.id, 'BSP October');
  const svc = createService({ lib: () => lib, me: () => OWNER, settings: () => ({}), saveSettings() {}, print: async () => {} });
  await svc['docs:print']([d.id], { printer: 'HP LaserJet', copies: 2 });
  lib.remove(d.id); lib.restore(d.id);
  const h = lib.history({ docId: d.id });
  assert.deepStrictEqual(h.map((x) => x.action).reverse(), ['added', 'filed', 'moved', 'renamed', 'printed', 'deleted', 'restored']);
  assert.strictEqual(h.find((x) => x.action === 'moved').whoName, 'Jamie Lee');
  assert.match(h.find((x) => x.action === 'printed').detail, /Printed on HP LaserJet \(2 copies\)/);
  assert.match(h.find((x) => x.action === 'moved').detail, /Moved from Accounts › Bank statements to Admin/);
  assert.ok(svc['docs:history']({}).length >= 7);
  assert.strictEqual(svc['docs:get'](d.id).history.length, 7);
});

// ---------- scanning, demo, program links ----------
test('scanner: Windows\' scan dialog through WIA, a clear answer when there is no scanner, and scans become PDFs', async () => {
  assert.match(scanner.WIA_SCRIPT, /New-Object -ComObject WIA\.CommonDialog/);
  assert.match(scanner.WIA_SCRIPT, /ShowAcquireImage\(1, /);
  assert.deepStrictEqual((await scanner.scanWithWia({ platform: 'linux' })).reason, 'not-windows');
  const fake = (said) => (cmd, args, opts, cb) => { assert.strictEqual(cmd, 'powershell.exe'); assert.ok(args.includes('-STA')); cb(said === 'ERROR' ? new Error('x') : null, said === 'ERROR' ? 'ERROR: The device is offline' : said); };
  assert.strictEqual((await scanner.scanWithWia({ platform: 'win32', exec: fake('CANCELLED'), outDir: tmp() })).reason, 'cancelled');
  assert.strictEqual((await scanner.scanWithWia({ platform: 'win32', exec: fake('NO_WIA'), outDir: tmp() })).reason, 'no-wia');
  const off = await scanner.scanWithWia({ platform: 'win32', exec: fake('ERROR'), outDir: tmp() });
  assert.deepStrictEqual([off.reason, off.message], ['no-scanner', 'The device is offline']);
  const dir = tmp(); const png = path.join(dir, 'page.png'); fs.writeFileSync(png, photoPng(1, 60, 80));
  await scanner.imageToPdf(png, path.join(dir, 'page.pdf'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'page.pdf')).subarray(0, 5).toString(), '%PDF-');
});
test('demo mode: a sample library like the design (Inbox with suggestions, department folders, a locked Payroll & HR, history)', async () => {
  const dir = tmp();
  const lib = await seedDemo(path.join(dir, 'Riyeser Documents'), { cacheDir: path.join(dir, 'c') });
  const svc = createService({ lib: () => lib, me: () => lib.me, settings: () => ({}), saveSettings() {}, demo: true });
  const st = svc['docs:state']();
  assert.strictEqual(st.inboxCount, 4); assert.strictEqual(st.me.initials, 'RM'); assert.ok(st.me.owner); assert.ok(st.demo);
  assert.deepStrictEqual(st.departments.map((d) => d.rel), ['Accounts', 'Admin', 'Jobs', 'Payroll & HR', 'Sales']);
  assert.ok(st.departments.find((d) => d.rel === 'Payroll & HR').locked);
  const inbox = svc['docs:list']({ place: 'inbox' }).items;
  assert.strictEqual(inbox[0].name, 'Invoice INV-2291'); assert.strictEqual(inbox[0].loc, 'Accounts › Suppliers › Pacific Hardware › 2026');
  assert.deepStrictEqual(svc['docs:get'](inbox[0].id).link, { label: 'Make a bill in Accounting', program: 'accounting' });
  assert.strictEqual(svc['docs:list']({ q: 'pacific' }).total, 4);
  const acc = svc['docs:list']({ place: 'folder', folder: 'Accounts', type: 'Scans', sort: 'name' });
  assert.deepStrictEqual(acc.items.map((i) => i.name), ['BSP statement October 2026', 'Invoice INV-2214 - Pacific Hardware']);
  assert.ok(svc['docs:history']({}).length > 10);
  assert.strictEqual((await seedDemo(lib.root, { cacheDir: path.join(dir, 'c') })).docs().length, 14, 'made once');
});

// ---------- the program itself ----------
test('the build: Riyeser Documents 1.0.0, same app id and install folder as Desk Assistant, new installer name', () => {
  const cfg = () => { delete require.cache[require.resolve('../scripts/builder.config.js')]; return require('../scripts/builder.config.js'); };
  const old = process.env.DESK_APP; delete process.env.DESK_APP;
  try {
    const c = cfg();
    assert.strictEqual(c.productName, 'Riyeser Documents');
    assert.strictEqual(c.appId, 'com.deskassistant.app');
    assert.strictEqual(c.nsis.shortcutName, 'Riyeser Documents');
    assert.strictEqual(c.nsis.artifactName, 'RiyeserDocuments-Setup-${version}.${ext}');
    assert.strictEqual(c.extraMetadata.version, '1.0.0');
    assert.strictEqual(c.extraMetadata.name, 'desk-assistant', 'same install folder');
    assert.strictEqual(c.executableName, 'Riyeser Desk Assistant', 'same program file, so older Centrals still find it');
    process.env.DESK_APP = 'pdf';
    assert.strictEqual(cfg().productName, 'Riyeser PDF');
  } finally { if (old === undefined) delete process.env.DESK_APP; else process.env.DESK_APP = old; }
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), 'Desk Assistant'\)\)/, 'keeps its data folder');
  assert.match(main, /loadFile\(path\.join\(__dirname, 'renderer', 'documents\.html'\)\)/);
});
test('Riyeser Central sees an installed Desk Assistant as Riyeser Documents, and updates it from either release file', () => {
  const updates = require('../src/central/updates');
  const reg = (name, ver) => `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\x\n    DisplayName    REG_SZ    ${name}\n    DisplayVersion    REG_SZ    ${ver}\n`;
  assert.deepStrictEqual(updates.installedFromRegistry(reg('Riyeser Desk Assistant 0.25.0', '0.25.0')), { desk: '0.25.0' });
  assert.deepStrictEqual(updates.installedFromRegistry(reg('Riyeser Documents 1.0.0', '1.0.0')), { desk: '1.0.0' });
  const asset = (name) => ({ name, browser_download_url: `https://github.com/raka1987/Riyeser/releases/download/v1/${name}`, size: 1 });
  const both = updates.latestFromRelease({ assets: [asset('RiyeserDeskAssistant-Setup.exe'), asset('RiyeserDocuments-Setup.exe')], body: '' }, { desk: '1.0.0' });
  assert.strictEqual(both.products.desk.name, 'RiyeserDocuments-Setup.exe');
  const oldOnly = updates.latestFromRelease({ assets: [asset('RiyeserDeskAssistant-Setup.exe')], body: '- Riyeser Desk Assistant 0.25.0' });
  assert.deepStrictEqual([oldOnly.products.desk.name, oldOnly.products.desk.version], ['RiyeserDeskAssistant-Setup.exe', '0.25.0']);
  const central = fs.readFileSync(path.join(__dirname, '..', 'src', 'central-main.js'), 'utf8');
  assert.match(central, /id: 'desk', name: 'Documents', full: 'Riyeser Documents'/);
  assert.match(central, /exes: \['Riyeser Documents\.exe', 'Riyeser Desk Assistant\.exe', 'Desk Assistant\.exe'\]/);
});
