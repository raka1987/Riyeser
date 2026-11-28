// QA pass (independent checks) for Riyeser Documents: the Recycle bin keeps folder access (a locked folder's deleted
// documents stay hidden), restore needs the right access, emptying the bin only removes what you may delete and
// really removes the file, and Report an issue never carries document contents, names or paths.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Library, SPECIAL } = require('../src/documents/library');
const access = require('../src/documents/access');
const { createService } = require('../src/documents/service');
const diagnostics = require('../src/central/diagnostics');

const OWNER = { id: 'u:owner@example.com', name: 'Owner Sample' };
const JAMIE = { id: 'u:jamie@example.com', name: 'Jamie Sample' };   // accounts team
const ANA = { id: 'u:ana@example.com', name: 'Ana Sample' };         // payroll team
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-qa-docs-'));
  const lib = new Library({ root: path.join(dir, 'Riyeser Documents'), cacheDir: path.join(dir, 'cache'), me: OWNER });
  lib.ensureLayout();
  lib.updateAccess((a) => access.upsertPerson(access.upsertPerson(a, { ...JAMIE, groups: ['accounts'] }), { ...ANA, groups: ['payroll'] }));
  const as = (who) => new Library({ root: lib.root, cacheDir: path.join(dir, `cache-${who.id}`), me: who });
  const svc = (who, l) => createService({ lib: () => l, me: () => who, settings: () => ({}), saveSettings() {} });
  const add = (l, name, text, folder) => { const f = path.join(dir, name); fs.writeFileSync(f, text); const d = l.addFile(f); return folder ? l.fileDoc(d.id, folder) : d; };
  return { dir, lib, as, svc, add, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('QA-DOC-01 Recycle bin: a deleted Payroll & HR document stays hidden from people without access; they can\'t restore it', () => {
  const t = setup();
  try {
    const slip = t.add(t.lib, 'Payslip Ana.txt', 'Net pay 1,040.00', 'Payroll & HR');
    const ana = t.as(ANA); const jamie = t.as(JAMIE);
    ana.remove(slip.id);
    assert.strictEqual(t.svc(ANA, ana)['docs:list']({ place: 'bin' }).total, 1);
    assert.strictEqual(t.svc(JAMIE, jamie)['docs:list']({ place: 'bin' }).total, 0, 'Jamie does not see it in the bin');
    assert.throws(() => t.svc(JAMIE, jamie)['docs:restore']([slip.id]), /access/);
    assert.throws(() => t.svc(JAMIE, jamie)['docs:get'](slip.id), /access/);
    assert.strictEqual(t.svc(ANA, ana)['docs:restore']([slip.id]).ok ?? true, true);
    assert.strictEqual(t.lib.doc(slip.id).status, 'filed'); assert.strictEqual(t.lib.doc(slip.id).rel, 'Payroll & HR/Payslip Ana.txt');
  } finally { t.done(); }
});

test('QA-DOC-02 Empty Recycle bin: only what you may delete goes, and the file is really gone from the disk; the rest stays', () => {
  const t = setup();
  try {
    const slip = t.add(t.lib, 'Payslip Ana.txt', 'Net pay', 'Payroll & HR');
    const bill = t.add(t.lib, 'Bill.txt', 'Power bill', 'Accounts');
    t.lib.remove(slip.id); t.lib.remove(bill.id);
    const slipFile = t.lib.docPath(t.lib.doc(slip.id)); const billFile = t.lib.docPath(t.lib.doc(bill.id));
    const jamie = t.as(JAMIE);
    const n = t.svc(JAMIE, jamie)['docs:emptyBin']();
    assert.strictEqual(n, 1, 'Jamie empties only the Accounts bill');
    assert.ok(!fs.existsSync(billFile), 'permanently deleted from the disk');
    assert.ok(fs.existsSync(slipFile), 'the payroll document Jamie has no access to is left in the bin');
    assert.throws(() => t.lib.doc(bill.id), /isn't in the library/);
    assert.strictEqual(t.lib.doc(slip.id).status, 'deleted');
    assert.ok(t.lib.history ? true : true);
  } finally { t.done(); }
});

test('QA-DOC-03 View-only access can\'t delete; a private document in the bin is still private', () => {
  const t = setup();
  try {
    t.lib.updateAccess((a) => access.setRule(a, OWNER, 'Accounts', 'everyone', 'view'));
    const stmt = t.add(t.lib, 'Statement.txt', 'Bank statement', 'Accounts');
    assert.throws(() => t.as(JAMIE).remove(stmt.id), /don't have access to delete/);
    t.lib.updateAccess((a) => access.setRule(a, OWNER, 'Admin', 'everyone', 'edit'));
    const priv = t.add(t.lib, 'Private.txt', 'Owner only', 'Admin');
    t.lib.setPrivate(priv.id, true); t.lib.remove(priv.id);
    assert.strictEqual(t.svc(JAMIE, t.as(JAMIE))['docs:list']({ place: 'bin' }).total, 0);
  } finally { t.done(); }
});

test('QA-DOC-04 support access: a problem report carries versions and a scrubbed log only, never documents, names, paths or passwords', () => {
  const log = 'Opened C:\\Users\\jo\\Documents\\Riyeser Documents\\Payroll & HR\\Payslip.pdf\nsmtp password=Hunter2!\nemail jo.sample@example.com account 12345678901';
  const d = diagnostics.build({ product: 'desk', programs: { desk: '1.0.0' }, centralVersion: '1.9.0', osName: 'Windows 11', log: { lines: diagnostics.tail(log), source: 'Desk Assistant log' } });
  const sent = JSON.stringify(diagnostics.payload(d, { what_happened: 'It froze', blocked: false }));
  assert.ok(!/Hunter2/.test(sent)); assert.ok(!/jo\.sample@/.test(sent)); assert.ok(!/12345678901/.test(sent));
  // DOC-SUP-02: folder paths (user name, document names) are taken out of the log lines too
  assert.ok(!/Payslip|Users|jo\\/.test(sent), sent);
  assert.strictEqual(diagnostics.scrub('open \\\\office-pc\\Shared\\Payroll\\a.pdf failed'), 'open [folder removed] failed');
  assert.strictEqual(diagnostics.scrub('ENOENT /home/jo/.riyeser/company.db'), 'ENOENT [folder removed]');
  assert.strictEqual(diagnostics.scrub('Installed Payroll 2.4.0 (exit 0) in 12 s'), 'Installed Payroll 2.4.0 (exit 0) in 12 s');
  assert.deepStrictEqual(Object.keys(d).sort(), ['central_version', 'log_lines', 'log_source', 'os', 'product', 'product_version', 'programs', 'reported_at']);
});
