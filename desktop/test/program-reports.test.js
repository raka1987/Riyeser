// Riyeser Central: which programs are on this PC, as sent to Riyeser (HQ's "Installed on"). Riyeser Payroll from its
// real per-user installer entry, a copy that isn't in Windows' list (portable or picked with Locate…), and sending the
// list again soon after it changes (debounced), not only at the daily check-in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const u = require('../src/central/updates');
const pr = require('../src/central/program-reports');
const on = require('../src/core/online');
const { Store } = require('../src/core/store');

// What `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall /s /reg:64` prints on a PC with Riyeser
// Payroll 2.2.3 installed for this user by RiyeserPayroll-Setup.exe (electron-builder NSIS, perMachine: false).
const HKCU = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\5a3c6f0e-8a52-5b6f-a3c1-1f4f0b2c9d11',
  '    DisplayName    REG_SZ    Riyeser Payroll 2.2.3',
  '    UninstallString    REG_SZ    "C:\\Users\\Owner\\AppData\\Local\\Programs\\riyeser-payroll\\Uninstall Riyeser Payroll.exe" /currentuser',
  '    QuietUninstallString    REG_SZ    "C:\\Users\\Owner\\AppData\\Local\\Programs\\riyeser-payroll\\Uninstall Riyeser Payroll.exe" /currentuser /S',
  '    DisplayVersion    REG_SZ    2.2.3',
  '    DisplayIcon    REG_SZ    C:\\Users\\Owner\\AppData\\Local\\Programs\\riyeser-payroll\\Riyeser Payroll.exe,0',
  '    Publisher    REG_SZ    Riyeser Group',   // installed before the publisher became "Riyeser": still found
  '    NoModify    REG_DWORD    0x1',
  '    NoRepair    REG_DWORD    0x1',
  '    EstimatedSize    REG_DWORD    0x4a1f2',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OneDriveSetup.exe',
  '    DisplayName    REG_SZ    Microsoft OneDrive',
  '    DisplayVersion    REG_SZ    24.201.1006.0005',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\9d1e0c7b-riyeser-central',
  '    DisplayName    REG_SZ    Riyeser Central 1.8.7',
  '    DisplayVersion    REG_SZ    1.8.7',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\c0ffee00-riyeser-link',
  '    DisplayName    REG_SZ    Riyeser Link 1.1.0',
  '    DisplayVersion    REG_SZ    1.1.0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Riyeser Accounting Basics_is1',
  '    DisplayName    REG_SZ    Riyeser Accounting Basics',
  '    DisplayVersion    REG_SZ    2.3.0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Riyeser Bookings_is1',
  '    DisplayName    REG_SZ    Riyeser Bookings version 1.2.0',
  '    DisplayVersion    REG_SZ    1.2.0',
  '', ''].join('\r\n');

test('Riyeser Central finds Riyeser Payroll 2.2.3 from its per-user installer entry, next to the other programs', () => {
  assert.deepEqual(u.installedFromRegistry(HKCU), { payroll: '2.2.3', central: '1.8.7', team: '1.1.0', 'accounting-basics': '2.3.0', bookings: '1.2.0' });
  // just the Payroll entry, with Unix line ends, and with no DisplayVersion (the version from the name)
  const only = HKCU.split('\r\n\r\n')[0];
  assert.deepEqual(u.installedFromRegistry(only.replace(/\r\n/g, '\n')), { payroll: '2.2.3' });
  assert.deepEqual(u.installedFromRegistry(only.replace(/^ +DisplayVersion.*$/m, '')), { payroll: '2.2.3' });
  // the old "Riyser" hub listed too: the newest copy counts
  assert.deepEqual(u.installedFromRegistry(`${only}\r\n\r\nHKEY_CURRENT_USER\\x\\old\r\n    DisplayName    REG_SZ    Riyser 1.2.0\r\n    DisplayVersion    REG_SZ    1.2.0\r\n`), { payroll: '2.2.3' });
});

test('Riyeser Central reports a program its home screen finds but Windows\' list doesn\'t have (portable, or picked with Locate…)', () => {
  assert.equal(u.versionInFileName('C:\\Users\\Owner\\Desktop\\RiyeserPayroll-Portable-2.2.3.exe'), '2.2.3');
  assert.equal(u.versionInFileName('C:\\Users\\Owner\\AppData\\Local\\Programs\\riyeser-payroll\\Riyeser Payroll.exe'), null);
  const reg = u.installedFromRegistry(HKCU.replace(/Riyeser Payroll 2\.2\.3/, 'Something Else 1.0').replace(/DisplayVersion {4}REG_SZ {4}2\.2\.3/, 'DisplayVersion    REG_SZ    1.0'));
  assert.ok(!('payroll' in reg), 'not in the registry');
  const all = u.withFoundPrograms(reg, {
    payroll: { exe: 'C:\\Users\\Owner\\Downloads\\RiyeserPayroll-Portable-2.2.3.exe', version: null },
    pdf: { exe: 'D:\\Apps\\Riyeser PDF\\Riyeser PDF.exe', version: '1.3.2' },   // its file details say 1.3.2
    desk: { exe: 'D:\\Apps\\desk\\Riyeser Desk Assistant.exe', version: null },  // found, version unknown
    team: { exe: 'C:\\elsewhere\\Riyeser Team.exe', version: '0.9.0' },           // the registry's version wins
    pos: null });
  assert.equal(all.payroll, '2.2.3'); assert.equal(all.pdf, '1.3.2'); assert.ok('desk' in all && all.desk === null);
  assert.equal(all.team, '1.1.0'); assert.ok(!('pos' in all));
  // the newest portable copy on the desktop or in Downloads
  const dirs = { 'C:\\Users\\Owner\\Desktop': ['RiyeserPayroll-Portable-2.1.0.exe', 'notes.txt'], 'C:\\Users\\Owner\\Downloads': ['RiyeserPayroll-Portable-2.2.3.exe', 'RiyeserPayroll-Setup-2.2.3.exe'] };
  const pattern = /^RiyeserPayroll-Portable(?:-\d+(?:\.\d+){1,3})?\.exe$/i;
  assert.equal(u.findPortable(Object.keys(dirs).concat('C:\\missing'), pattern, (d) => { if (!dirs[d]) throw new Error('ENOENT'); return dirs[d]; }),
    'C:\\Users\\Owner\\Downloads\\RiyeserPayroll-Portable-2.2.3.exe');
  assert.equal(u.findPortable(['/home/x'], pattern, () => ['other.exe']), null);
});

function fakeTimers() {
  let now = 0; let id = 0; const due = new Map();
  return { setTimeout: (fn, ms) => { due.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: (t) => due.delete(t),
    async tick(ms) { now += ms; for (const [k, t] of [...due]) if (t.at <= now) { due.delete(k); await t.fn(); } }, pending: () => due.size };
}
const list = (...ids) => ids.map((id) => ({ id, status: 'installed', where: `C:\\P\\${id}.exe` })).concat([{ id: 'pdf', status: 'missing', where: null }]);

test('Riyeser Central sends the programs again soon after the list changes, once for changes close together', async () => {
  const timers = fakeTimers(); let sent = 0;
  const r = pr.createReporter({ report: async () => { sent++; return true; }, delayMs: 30000, timers });
  assert.equal(r.seen(list('team', 'bookings')), true, 'first look at the home screen: send soon');
  await timers.tick(29000); assert.equal(sent, 0, 'waits a little');
  assert.equal(r.seen(list('bookings', 'team')), false, 'same programs (any order): nothing new');
  await timers.tick(1000); assert.equal(sent, 1, 'sent once');
  // Payroll appears on the home screen (installed by hand), then Central installs Accounting Basics a few seconds later
  assert.equal(r.seen(list('team', 'bookings', 'payroll')), true);
  await timers.tick(10000); r.soon();
  await timers.tick(20000); assert.equal(sent, 1, 'the wait starts again with each change');
  await timers.tick(10000); assert.equal(sent, 2, 'one report for both');
  // an update installed: soon(); flush() sends at once
  r.soon(); assert.ok(r.waiting()); await r.flush(); assert.equal(sent, 3); assert.ok(!r.waiting());
  // a report that fails doesn't stop the next one
  const r2 = pr.createReporter({ report: async () => { throw new Error('offline'); }, delayMs: 5, timers });
  r2.soon(); await timers.tick(5); assert.equal(await r2.flush(), null);
});

test('Riyeser Central: a report only goes out when the list differs from what this PC last sent (the daily check-in always sends)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchFn = async (url, opts = {}) => {
    const p = new URL(url); const body = opts.body ? JSON.parse(opts.body) : null;
    if (p.href.startsWith(on.CONFIG_URL)) return res(200, 'window.RIYESER_TEAM={supabaseUrl:"https://x.supabase.co",supabaseKey:"sb_publishable_k"};');
    if (p.pathname === '/auth/v1/token') return res(200, { access_token: 'tok', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: body.email, user_metadata: {} } });
    if (p.pathname === '/rest/v1/rpc/report_programs') { calls.push(body); return res(204, ''); }
    return res(200, '');
  };
  let installed = { central: '1.8.8', team: '1.1.0' };
  const o = new on.Online({ store: new Store(path.join(dir, 'data')), fetchFn, appData: dir, appVersion: '1.8.8', deviceName: 'OWNER-PC', programsFn: async () => installed });
  await o.signIn('owner@a.test', 'right-password');
  assert.equal(await o.reportPrograms('w1', { onlyIfChanged: true }), true, 'never sent: sent');
  assert.equal(await o.reportPrograms('w1', { onlyIfChanged: true }), null, 'the same list: not sent again');
  installed = { central: '1.8.8', team: '1.1.0', payroll: '2.2.3' };
  assert.equal(await o.reportPrograms('w1', { onlyIfChanged: true }), true, 'Payroll installed: sent');
  assert.deepEqual(calls[1].programs, [{ id: 'central', version: '1.8.8' }, { id: 'payroll', version: '2.2.3' }, { id: 'team', version: '1.1.0' }]);
  assert.equal(await o.reportPrograms('w1'), true, 'the daily check-in sends even when nothing changed');
  assert.equal(await o.reportPrograms('w2', { onlyIfChanged: true }), true, 'another business: sent');
  assert.equal(calls.length, 4);
});
