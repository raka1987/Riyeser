// "Fresh start on this PC": every Riyeser folder renamed away (never deleted), rolled back if one is in use, a log,
// the open-programs check, the sign-in choice, Central's own folder on its next start, and bringing it all back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const fresh = require('../src/central/freshstart');

const NOW = new Date(2026, 10, 24, 9, 12);   // local time: "2026-11-24 0912"
const AWAY = '(before fresh start 2026-11-24 0912)';

/** A pretend PC: APPDATA, USERPROFILE and RIYESER_HOME in a temp folder, with every Riyeser folder filled in. */
function pc({ riyeserHome = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'central-fresh-'));
  const appData = path.join(root, 'AppData', 'Roaming'); const home = path.join(root, 'User');
  const env = riyeserHome ? { RIYESER_HOME: path.join(root, 'Books') } : {};
  const acc = env.RIYESER_HOME || path.join(home, '.riyeser');
  const files = {
    [path.join(acc, 'company.db')]: 'books', [path.join(acc, 'companies', 'Acme', 'company.db')]: 'acme', [path.join(acc, 'archive', 'a.db')]: 'old', [path.join(acc, 'demo', 'company.db')]: 'demo',
    [path.join(appData, 'Riyeser Payroll', 'payroll', 'payroll.db')]: 'pay', [path.join(appData, 'Riyeser Payroll', 'payroll', 'demo', 'payroll.db')]: 'paydemo',
    [path.join(appData, 'Riyser', 'payroll', 'ark.db')]: 'ark',
    [path.join(appData, 'Desk Assistant', 'data', 'tasks.json')]: '[]', [path.join(appData, 'Desk PDF', 'data', 'settings.json')]: '{}',
    [path.join(appData, 'Riyeser Team', 'Cookies')]: 'link sign-in', [path.join(appData, 'Riyeser Link Office', 'logs', 'link.log')]: 'log',
    [path.join(appData, 'Riyeser Services', 'window.json')]: '{}',
    [path.join(appData, 'Riyeser', 'company.json')]: '{"name":"Old Co"}', [path.join(appData, 'Riyeser', 'licence.json')]: '{}', [path.join(appData, 'Riyeser', 'demo.json')]: '{"on":true}',
    [path.join(appData, 'Riyser Central', 'data', 'old.json')]: '{}',
    [path.join(appData, 'Riyeser Central', 'data', 'online.json')]: JSON.stringify({ session: { token: 't', user: { email: 'me@example.com' } }, other: 1 }),
    [path.join(appData, 'Riyeser Central', 'data', 'checklist.json')]: '{"hidden":true}', [path.join(appData, 'Riyeser Central', 'data', 'device.json')]: '{"id":"d1"}',
  };
  for (const [f, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); }
  return { root, appData, home, env, acc, files, centralDir: path.join(appData, 'Riyeser Central') };
}
const opts = (p, extra = {}) => ({ appData: p.appData, home: p.home, env: p.env, centralDir: p.centralDir, now: NOW, ...extra });
const away = (dir) => path.join(path.dirname(dir), `${path.basename(dir)} ${AWAY}`);
const read = (f) => fs.readFileSync(f, 'utf8');
const json = (f) => JSON.parse(read(f));

test('fresh start: every known folder is renamed (not deleted), contents intact, Central left for its restart', () => {
  const p = pc();
  const r = fresh.putAway(opts(p));
  assert.equal(r.ok, true);
  const dirs = [p.acc, ...['Riyeser Payroll', 'Riyser', 'Desk Assistant', 'Desk PDF', 'Riyeser Team', 'Riyeser Link Office', 'Riyeser Services', 'Riyeser', 'Riyser Central'].map((n) => path.join(p.appData, n))];
  for (const d of dirs) { assert.equal(fs.existsSync(d), false, d); assert.ok(fs.statSync(away(d)).isDirectory(), away(d)); }
  for (const [f, v] of Object.entries(p.files)) {
    if (f.startsWith(p.centralDir + path.sep)) { assert.equal(read(f), v); continue; }   // still in place until Central restarts
    const d = dirs.find((x) => f.startsWith(x + path.sep));
    assert.equal(read(path.join(away(d), f.slice(d.length + 1))), v, f);
  }
  assert.equal(r.moved.length, 10);
  assert.deepEqual(r.central, { from: p.centralDir, to: away(p.centralDir) });
  assert.equal(json(path.join(p.centralDir, fresh.MARKER)).action, 'put-away');
});

test('fresh start: RIYESER_HOME is used for Accounting, and missing folders are skipped', () => {
  const p = pc({ riyeserHome: true });
  fs.renameSync(path.join(p.appData, 'Desk PDF'), path.join(p.root, 'elsewhere'));   // not on this PC
  fs.renameSync(path.join(p.appData, 'Riyser'), path.join(p.root, 'elsewhere2'));
  const r = fresh.putAway(opts(p));
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(away(p.env.RIYESER_HOME)));
  assert.equal(r.moved.some((m) => m.id === 'pdf' || m.id === 'payroll-old'), false);
  assert.equal(fs.existsSync(away(path.join(p.appData, 'Desk PDF'))), false);
});

test('fresh start: a folder that is too broad (RIYESER_HOME = the home folder) is never renamed', () => {
  const p = pc(); p.env = { RIYESER_HOME: p.home };
  const r = fresh.putAway(opts(p));
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(p.home));
  assert.equal(r.moved.some((m) => m.id === 'accounting'), false);
});

test('fresh start: the log lists what moved where, in the first put-away folder', () => {
  const p = pc();
  const r = fresh.putAway(opts(p, { keepSignIn: true }));
  assert.equal(r.log, path.join(away(p.acc), fresh.LOG));
  const log = json(r.log);
  assert.equal(log.kind, 'riyeser-fresh-start'); assert.equal(log.stamp, '2026-11-24 0912'); assert.equal(log.keptSignIn, true);
  assert.deepEqual(log.items.find((i) => i.id === 'payroll'), { id: 'payroll', name: 'Riyeser Payroll', from: path.join(p.appData, 'Riyeser Payroll'), to: away(path.join(p.appData, 'Riyeser Payroll')), status: 'moved' });
  assert.match(log.items.find((i) => i.id === 'central').status, /restarts/);
});

test('fresh start: a folder in use stops it and the ones already moved are put back', () => {
  const p = pc();
  const rename = (a, b) => { if (path.basename(a) === 'Riyeser Team') { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } fs.renameSync(a, b); };
  const r = fresh.putAway(opts(p, { rename }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, { id: 'team', name: 'Riyeser Link', dir: path.join(p.appData, 'Riyeser Team'), error: 'EBUSY' });
  assert.deepEqual(r.notRolledBack, []);
  assert.deepEqual(r.rolledBack, ['Riyeser PDF', 'Riyeser Desk Assistant', 'Riyser (Payroll’s earlier name)', 'Riyeser Payroll', 'Riyeser Accounting, Invoices, POS and Bookings']);
  for (const f of Object.keys(p.files)) assert.ok(fs.existsSync(f), f);   // everything back where it was
  assert.equal(fs.readdirSync(p.appData).some((n) => n.includes('before fresh start')), false);
  assert.equal(fs.existsSync(path.join(p.centralDir, fresh.MARKER)), false);   // no restart is set up
  assert.match(fresh.failMessage(r), /Nothing was put away: Riyeser Link is still in use/);
});

test('fresh start: names stay unique when a folder of the same name is already there', () => {
  const p = pc();
  fs.mkdirSync(away(path.join(p.appData, 'Riyeser Payroll')));
  const r = fresh.putAway(opts(p));
  assert.equal(r.moved.find((m) => m.id === 'payroll').to, path.join(p.appData, 'Riyeser Payroll (before fresh start 2026-11-24 0912-2)'));
});

test('open programs: blocks with their names (tasklist mocked)', async () => {
  const programs = [{ full: 'Riyeser Payroll', exes: ['Riyeser Payroll.exe', 'Riyeser.exe'] }, { full: 'Riyeser Accounting Plus', exes: ['Riyeser Accounting Plus.exe'] }, { full: 'Riyeser PDF', exes: ['Riyeser PDF.exe'] }];
  const exec = (cmd, args, o, cb) => { assert.equal(cmd, 'tasklist'); cb(null, '"System","4","Services","0","1 K"\r\n"riyeser payroll.exe","10","Console","1","5 K"\r\n"Riyeser Accounting Plus.exe","11","Console","1","5 K"\r\n"Riyeser Central.exe","12","Console","1","5 K"\r\n'); };
  const imgs = await fresh.runningImages({ platform: 'win32', exec });
  const open = fresh.openPrograms(programs, imgs);
  assert.deepEqual(open, ['Riyeser Payroll', 'Riyeser Accounting Plus']);
  assert.equal(fresh.closeFirst(open), 'Close these first: Riyeser Payroll, Riyeser Accounting Plus.');
  assert.deepEqual(await fresh.runningImages({ platform: 'linux', exec }), []);
});

test('Central restart: its folder is put away; signed out by default', () => {
  const p = pc();
  fresh.putAway(opts(p));
  const r = fresh.finishOnStart({ dir: p.centralDir, now: NOW, wait: () => {} });
  assert.equal(r.whole, true); assert.equal(r.keptSignIn, false);
  const to = away(p.centralDir);
  assert.equal(read(path.join(to, 'data', 'device.json')), '{"id":"d1"}');
  assert.ok(fs.existsSync(path.join(to, 'fresh-start-done.json')));
  assert.deepEqual(fs.readdirSync(p.centralDir), ['data']);
  assert.deepEqual(fs.readdirSync(path.join(p.centralDir, 'data')), []);   // a brand-new store: no settings, checklist or sign-in
  assert.equal(json(path.join(away(p.acc), fresh.LOG)).items.find((i) => i.id === 'central').status, 'moved');
  assert.equal(fresh.finishOnStart({ dir: p.centralDir }), null);   // only once
});

test('Central restart: "sign out" unticked keeps only the Riyeser sign-in, and a fresh checklist', () => {
  const p = pc();
  fresh.putAway(opts(p, { keepSignIn: true }));
  fresh.finishOnStart({ dir: p.centralDir, now: NOW, wait: () => {} });
  assert.deepEqual(json(path.join(p.centralDir, 'data', 'online.json')), { session: { token: 't', user: { email: 'me@example.com' } } });
  assert.deepEqual(json(path.join(p.centralDir, 'data', 'checklist.json')), { hidden: false });
  assert.equal(fs.existsSync(path.join(p.centralDir, 'data', 'device.json')), false);
});

test('Central restart: still held open, it tries again, then puts away just the settings', () => {
  const p = pc();
  fresh.putAway(opts(p));
  let tries = 0;
  const rename = (a, b) => { if (a === p.centralDir) { tries++; const e = new Error('busy'); e.code = 'EPERM'; throw e; } fs.renameSync(a, b); };
  const r = fresh.finishOnStart({ dir: p.centralDir, now: NOW, rename, tries: 3, wait: () => {} });
  assert.equal(tries, 3); assert.equal(r.whole, false);
  assert.equal(read(path.join(away(p.centralDir), 'data', 'device.json')), '{"id":"d1"}');
  assert.deepEqual(fs.readdirSync(path.join(p.centralDir, 'data')), []);
  assert.equal(fs.existsSync(path.join(p.centralDir, fresh.MARKER)), false);
});

test('bring back: lists earlier fresh starts and restores them, putting what is there now aside first', () => {
  const p = pc();
  fresh.putAway(opts(p));
  fresh.finishOnStart({ dir: p.centralDir, now: NOW, wait: () => {} });
  // the new start: Payroll made a new folder, Central has its new store
  fs.mkdirSync(path.join(p.appData, 'Riyeser Payroll', 'payroll'), { recursive: true });
  fs.writeFileSync(path.join(p.appData, 'Riyeser Payroll', 'payroll', 'payroll.db'), 'new');
  const sets = fresh.sets({ appData: p.appData, home: p.home, env: p.env });
  assert.equal(sets.length, 1); assert.equal(sets[0].items.length, 11);
  const later = new Date(2026, 10, 24, 10, 5);
  const r = fresh.bringBack({ set: sets[0], centralDir: p.centralDir, now: later });
  assert.equal(r.ok, true);
  assert.deepEqual(r.central, { from: away(p.centralDir), to: p.centralDir });
  for (const [f, v] of Object.entries(p.files)) if (!f.startsWith(p.centralDir + path.sep)) assert.equal(read(f), v, f);
  assert.equal(read(path.join(p.appData, 'Riyeser Payroll (before bringing back 2026-11-24 1005)', 'payroll', 'payroll.db')), 'new');
  // Central's own folder is swapped on its next start
  const c = fresh.finishOnStart({ dir: p.centralDir, now: later, wait: () => {} });
  assert.equal(c.ok, true);
  for (const [f, v] of Object.entries(p.files)) if (f.startsWith(p.centralDir + path.sep) && !f.includes('checklist')) assert.equal(read(f), v, f);
  assert.ok(fs.existsSync(path.join(p.appData, 'Riyeser Central (before bringing back 2026-11-24 1005)', 'data')));
  assert.equal(fresh.finishOnStart({ dir: p.centralDir }), null);   // the restored folder doesn't start another fresh start
  assert.deepEqual(fresh.sets({ appData: p.appData, home: p.home, env: p.env }), []);   // not offered again
  assert.ok(fs.readdirSync(p.acc).some((n) => /^fresh-start-log \(brought back /.test(n)));   // the log is kept
});

test('bring back: a folder in use puts everything back as it was', () => {
  const p = pc();
  fresh.putAway(opts(p));
  const set = fresh.sets({ appData: p.appData, home: p.home, env: p.env })[0];
  fs.mkdirSync(path.join(p.appData, 'Riyeser Team'));
  const rename = (a, b) => { if (a === away(path.join(p.appData, 'Riyeser Team'))) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } fs.renameSync(a, b); };
  const r = fresh.bringBack({ set, centralDir: p.centralDir, now: NOW, rename });
  assert.equal(r.ok, false); assert.deepEqual(r.notRolledBack, []);
  assert.ok(fs.existsSync(away(p.acc))); assert.equal(fs.existsSync(p.acc), false);
  assert.ok(fs.existsSync(path.join(p.appData, 'Riyeser Team')));
  assert.equal(fresh.sets({ appData: p.appData, home: p.home, env: p.env }).length, 1);
});

test('Settings: the wording and the START FRESH check', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'central.js'), 'utf8');
  assert.ok(ui.includes('Puts away everything Riyeser has saved on this PC — every program’s records, settings and sign-ins — so Riyeser starts like it’s brand new. <b>Nothing is deleted</b>: it’s all moved to folders named “before fresh start” and today’s date, and can be brought back. Your Riyeser account online isn’t affected.'));
  for (const s of ['Fresh start on this PC', 'Start fresh…', 'Bring back a fresh start…', 'Also sign out of my Riyeser account on this PC', 'border:1.5px solid var(--bad)']) assert.ok(ui.includes(s), s);
  assert.equal(fresh.CONFIRM, 'START FRESH');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'central-main.js'), 'utf8');
  assert.ok(main.indexOf('freshstart.finishOnStart') < main.indexOf("app.setPath('userData'"));   // before anything opens Central's folder
  assert.ok(!/rmSync|unlinkSync|rmdirSync/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'central', 'freshstart.js'), 'utf8')));   // never deletes
});
