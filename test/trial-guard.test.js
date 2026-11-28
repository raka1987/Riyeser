// Payroll's free trial survives reinstalls and wiped data folders (trial-guard.js, the same file as Riyeser Central's):
// the earliest valid date in licence.json, the markers, the registry (in memory here), the records file's stamp and
// Riyeser online's PC record (kept by Central in the registry) counts. Synthetic data only.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-trialguard-'));
Object.assign(process.env, { RIYESER_DEMO_FILE: path.join(ROOT, 'no-demo.json'), RIYESER_DEMO: '' });
const G = require('../trial-guard');
const S = require('../signed-licence');
const licence = require('../licence');

const DAY = 86400000;
const T0 = Date.parse('2026-09-03T09:00:00Z');
let n = 0;
function pc() {
  const appData = path.join(ROOT, `pc${++n}`); const ownDir = path.join(appData, 'Riyeser Payroll', 'payroll');
  fs.mkdirSync(path.join(appData, 'Riyeser'), { recursive: true }); fs.mkdirSync(ownDir, { recursive: true });
  const reg = G.memoryRegistry(); G.configure({ registry: reg, machineGuid: 'aaaaaaaa-0000-4000-8000-000000000001' });
  return { appData, ownDir, reg };
}
const st = (p, now) => licence.status({ appData: p.appData, ownDir: p.ownDir, now, publicKey: '' });
const wipe = (p) => { fs.rmSync(p.appData, { recursive: true, force: true }); fs.mkdirSync(path.join(p.appData, 'Riyeser'), { recursive: true }); fs.mkdirSync(p.ownDir, { recursive: true }); };
afterEach(() => G.configure({ registry: null, machineGuid: null }));

test('reinstall and deleted AppData: the same trial, from the registry', () => {
  const p = pc();
  assert.equal(st(p, T0).daysLeft, 90);
  assert.equal(p.reg.data.suite, new Date(T0).toISOString());
  wipe(p);
  const s = st(p, T0 + 30 * DAY);
  assert.equal(s.mode, 'trial'); assert.equal(s.daysLeft, 60);
  assert.equal(st(p, T0 + 95 * DAY).mode, 'ended');
});

test('restored records file: its older stamp wins; a newer one never moves it later; demo mode stamps nothing', () => {
  const p = pc();
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE trial_stamp (program TEXT PRIMARY KEY, trial_start TEXT NOT NULL, stamped_at TEXT NOT NULL)');
  db.prepare('INSERT INTO trial_stamp VALUES (?, ?, ?)').run('suite', new Date(T0).toISOString(), new Date(T0).toISOString());
  const now = T0 + 100 * DAY;
  assert.equal(licence.syncCompanyStamp(db, { appData: p.appData, ownDir: p.ownDir, now }), T0);
  assert.equal(st(p, now).mode, 'ended', 'the restored file\'s older date wins');
  assert.equal(p.reg.data['suite.CompanyFile'], new Date(T0).toISOString());
  // a fresh records file is stamped with the trial's start
  const fresh = new DatabaseSync(':memory:');
  licence.syncCompanyStamp(fresh, { appData: p.appData, ownDir: p.ownDir, now });
  assert.equal(fresh.prepare('SELECT trial_start FROM trial_stamp WHERE program = ?').get('suite').trial_start, new Date(T0).toISOString());
  // demo mode: nothing at all
  const q = pc(); const demoDb = new DatabaseSync(':memory:');
  assert.equal(licence.syncCompanyStamp(demoDb, { appData: q.appData, ownDir: q.ownDir, now, demo: true }), null);
  assert.deepEqual(q.reg.data, {});
  assert.equal(demoDb.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'trial_stamp'").get().n, 0);
});

test('the clock rolled back: no extension', () => {
  const p = pc();
  st(p, T0); st(p, T0 + 80 * DAY);
  wipe(p);
  assert.equal(st(p, T0 + 5 * DAY).daysLeft, 10);
  assert.ok(p.reg.data.ClockBack);
});

test('Riyeser online\'s PC record (fetched by Central): the earliest date and a goodwill extension', () => {
  const p = pc();
  p.reg.data['suite.Online'] = new Date(T0).toISOString(); p.reg.data.OnlineCheckedAt = new Date(T0 + 40 * DAY).toISOString(); p.reg.data['suite.OnlineExtra'] = '14';
  const s = st(p, T0 + 95 * DAY);
  assert.equal(s.mode, 'trial'); assert.equal(s.daysLeft, 9);
});

test('a paid Payroll (the plan from Riyeser online) is unaffected by an old local trial', () => {
  const p = pc();
  p.reg.data.suite = '2024-06-01T00:00:00.000Z';
  fs.writeFileSync(path.join(p.appData, 'Riyeser', 'company.json'), JSON.stringify({ mode: 'online', workspace_id: 'w1' }));
  fs.writeFileSync(path.join(p.appData, 'Riyeser', 'licence.json'), JSON.stringify({ online: { workspace_id: 'w1', checkedAt: new Date(T0).toISOString(),
    modules: { payroll: { status: 'active', active: true, paid_until: '2027-06-30' } } } }));
  const s = st(p, T0);
  assert.equal(s.licensed, true); assert.equal(s.mode, 'licensed'); assert.equal(s.source, 'online');
});

test('without a registry (other systems, tests): it all still works from the files', () => {
  G.configure({ registry: null });
  const appData = path.join(ROOT, 'noreg'); fs.mkdirSync(path.join(appData, 'Riyeser'), { recursive: true });
  const s = licence.status({ appData, ownDir: null, now: T0, publicKey: '' });
  assert.equal(s.mode, 'trial'); assert.equal(s.daysLeft, 90);
  assert.equal(S.localTrial({ appData, now: T0 + DAY, write: false }).daysLeft, 89);
});
