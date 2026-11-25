// The Windows program's extras: first-run setup screen and backups. Runs the back office the way the program does.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3997, B = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-desk-')), BACKUP_DIR = path.join(DATA_DIR, 'backups');
let server;
async function call(method, url, body, cookie) {
  const res = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
before(async () => {
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR, BACKUP_DIR, DESKTOP: '1', ADMIN_PASSWORD: '', RIYESER_DEMO_FILE: path.join(DATA_DIR, 'no-demo.json'), RIYESER_DEMO: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/public/info'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('Server did not start');
});
after(async () => {
  // Wait for the test server to close before removing its folder: on Windows an open database file can't be deleted.
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000); });
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp folder; Windows tidies it later */ }
});

test('desktop: first run asks the owner to create the Super admin login, once', async () => {
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'FIRST_RUN_ADMIN_PASSWORD.txt')));     // no password left lying in a file
  assert.deepEqual((await call('GET', '/api/public/setup')).data, { setup_needed: true, desktop: true });
  assert.equal((await call('POST', '/api/public/setup', { name: 'Owner', username: 'owner', password: 'short', password2: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/public/setup', { name: 'Owner', username: 'owner', password: 'ownerpass1', password2: 'different1' })).status, 400);
  const r = await call('POST', '/api/public/setup', { name: 'Owner', username: 'Owner', password: 'ownerpass1', password2: 'ownerpass1', company_name: 'Example Co Ltd' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.username, 'owner');
  const login = await call('POST', '/api/auth/login', { username: 'owner', password: 'ownerpass1' }); assert.equal(login.status, 200);
  const me = (await call('GET', '/api/auth/me', null, login.cookie)).data;
  assert.equal(me.user.role, 'admin'); assert.equal(me.user.name, 'Owner'); assert.equal(me.settings.company_name, 'Example Co Ltd');
  // nobody can run setup again
  assert.equal((await call('POST', '/api/public/setup', { name: 'X', username: 'xxx', password: 'xxxxxxxx1', password2: 'xxxxxxxx1' })).status, 400);
  assert.equal((await call('GET', '/api/public/setup')).data.setup_needed, false);
});

test('desktop: backups are made on demand (Super admin only) and are a full copy of the records', async () => {
  const owner = (await call('POST', '/api/auth/login', { username: 'owner', password: 'ownerpass1' })).cookie;
  await call('POST', '/api/staff/employees', { name: 'Seru Staff', username: 'seru', password: 'serupass1', role: 'staff', pay_rate: 6 }, owner);
  const staff = (await call('POST', '/api/auth/login', { username: 'seru', password: 'serupass1' })).cookie;
  assert.equal((await call('POST', '/api/staff/backups', {}, staff)).status, 403);
  const b = await call('POST', '/api/staff/backups', {}, owner);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const file = path.join(BACKUP_DIR, b.data.file);
  assert.ok(fs.existsSync(file));
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.ok(copy.prepare("SELECT 1 FROM users WHERE name = 'Seru Staff'").get());
  copy.close();
  const list = (await call('GET', '/api/staff/backups', null, owner)).data;
  assert.equal(list.desktop, true); assert.ok(list.backups.some(x => x.file === b.data.file)); assert.ok(list.last);
});

// OWNER-RESTORE: restore is easy to find, works from a fresh-start folder, and nothing is removed on uninstall
test('OWNER-RESTORE: restore from a backup or a "(before fresh start …)" payroll.db; Settings and first-run buttons; uninstall keeps the records', async () => {
  const R = require('../desktop/restore');
  const { DatabaseSync } = require('node:sqlite');
  const root = path.join(DATA_DIR, 'restore'), appData = path.join(root, 'AppData'), userData = path.join(appData, 'Riyeser Payroll');
  fs.mkdirSync(path.join(userData, 'payroll'), { recursive: true });
  const make = (file, staff, run = true) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const d = new DatabaseSync(file);
    d.exec("PRAGMA journal_mode = WAL; CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE timesheets (id INTEGER PRIMARY KEY); CREATE TABLE settings (key TEXT, value TEXT); CREATE TABLE payroll_runs (id INTEGER PRIMARY KEY); CREATE TABLE pay_history (id INTEGER PRIMARY KEY);");
    for (const n of staff) d.prepare('INSERT INTO users(name) VALUES(?)').run(n);
    if (run) d.exec('INSERT INTO payroll_runs DEFAULT VALUES'); return d; };
  // a fresh start put the records away; the last changes are still in the -wal file, and the files are read-only
  const older = path.join(appData, 'Riyeser Payroll (before fresh start 2026-11-01 0800)', 'payroll', 'payroll.db');
  const newer = path.join(appData, 'Riyeser Payroll (before fresh start 2026-11-24 0912)', 'payroll', 'payroll.db');
  make(older, ['Old Admin', 'Old Staff']).close();
  const open = make(newer, ['Admin', 'Mere Staff', 'Jone Staff']); // left open: its rows are only in payroll.db-wal
  for (const f of [newer, newer + '-wal']) if (fs.existsSync(f)) fs.chmodSync(f, 0o444);
  make(path.join(appData, 'Riyeser Payroll (before fresh start 2026-11-20 1000)', 'payroll', 'payroll.db'), ['Only Admin'], false).close(); // empty payroll: not offered
  fs.mkdirSync(path.join(appData, 'Riyeser Payroll (before fresh start 2026-11-21 1000)')); // no records: not offered
  const found = R.freshStartRecords(userData);
  assert.deepEqual(found.map(f => f.when), ['2026-11-24 0912', '2026-11-01 0800']);
  assert.equal(found[0].file, newer); assert.equal(R.describe(found[0].sum), '3 staff, 0 shifts, 1 pay runs, 0 weeks of pay history');
  // the picker accepts that payroll.db: a complete, writable copy with the -wal changes
  const pending = path.join(userData, 'payroll', 'restore-pending.db');
  R.payrollCopy(newer, pending, root);
  const got = new DatabaseSync(pending);
  assert.deepEqual(got.prepare('SELECT name FROM users ORDER BY id').all().map(r => r.name), ['Admin', 'Mere Staff', 'Jone Staff']);
  got.prepare("INSERT INTO settings VALUES ('x', 'y')").run(); got.close(); // writable
  open.close();
  // a file that isn't payroll records is refused
  const other = path.join(root, 'other.db'); { const d = new DatabaseSync(other); d.exec('CREATE TABLE notes (t TEXT)'); d.close(); }
  assert.throws(() => R.payrollCopy(other, pending, root), /isn't payroll records/);
  // a backup chosen from the Settings list must be a backup file in the backups folder
  const bk = path.join(root, 'Backups'); make(path.join(bk, 'payroll-manual-2026-11-25-10-00.db'), ['A']).close();
  assert.equal(R.backupFile(bk, 'payroll-manual-2026-11-25-10-00.db'), path.join(bk, 'payroll-manual-2026-11-25-10-00.db'));
  for (const bad of ['../payroll.db', 'payroll.db', '..\\payroll-x.db', 'payroll-manual-2026-01-01.db']) assert.throws(() => R.backupFile(bk, bad), new RegExp("isn't one of the backups|isn't in the backups folder"));
  // the app: the Settings panel has "Restore from a backup…" next to "Back up now" and a Restore button per backup,
  // with the menu's real name; the first-run screen offers a restore; the program wires them to the same restore
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.js'), 'utf8'), html = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.html'), 'utf8');
  assert.match(ui, /id="bk-now">Back up now<\/button>\$\{canRestore \? '<button class="btn sm ghost" id="bk-restore">Restore from a backup…<\/button>'/);
  assert.match(ui, /data-restore="\$\{esc\(b\.file\)\}">Restore<\/button>/);
  assert.match(ui, /menu <b>Payroll → Restore from a backup…<\/b>/); assert.doesNotMatch(ui, /File → Restore/);
  assert.match(html, /id="setup-restore"[\s\S]*Restore from a backup…/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8'), pre = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
  assert.match(pre, /restore: name => ipcRenderer\.invoke\('riyser:restore', name\)/);
  assert.match(main, /ipcMain\.handle\('riyser:restore'/); assert.match(main, /R\.freshStartRecords\(app\.getPath\('userData'\)\)/);
  assert.match(main, /payroll-before-restore-/); // the current records are backed up before a restore is swapped in
  // uninstall: the installer keeps the app data, and nothing in the program removes Documents\Riyeser\Payroll\Backups
  const prep = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'prepare.js'), 'utf8');
  assert.match(prep, /deleteAppDataOnUninstall: false/); assert.doesNotMatch(prep, /include:|\.nsh/); // no custom uninstall script
  assert.match(prep, /'main\.js', 'preload\.js', 'restore\.js'/); // restore.js goes in the build
});
