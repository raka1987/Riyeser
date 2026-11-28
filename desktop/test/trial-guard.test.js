// The free trial survives reinstalls and wiped data folders (core/trial-guard.js): the earliest valid date in licence.json,
// the markers, the registry, company files and Riyeser online's anonymous PC record counts. Synthetic PCs only: an
// in-memory registry per Windows user, a made-up MachineGuid per PC, and a pretend server with the same rules as
// pc_trial_seen in website/team/team-chat.sql (earliest date kept, never moved later).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const G = require('../src/core/trial-guard');
const S = require('../src/core/signed-licence');
const licence = require('../src/core/licence');
const dg = require('../src/central/diagnostics');

const DAY = 86400000;
const T0 = Date.parse('2026-09-03T09:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tguard-'));

/** Riyeser online's PC record, as pc_trial_seen keeps it. */
function server() {
  const rows = new Map(); const calls = [];
  const rpc = async (name, a) => {
    calls.push({ name, ...a });
    assert.equal(name, 'pc_trial_seen');
    assert.match(a.pc, /^[0-9a-f]{64}$/);
    const k = `${a.pc}|${a.program}`; const r = rows.get(k);
    const s = a.trial_start ? Date.parse(a.trial_start) : null;
    if (!r && s == null) return { program: a.program, trial_start: null };
    const start = r ? (s != null ? Math.min(Date.parse(r.trial_start), s) : Date.parse(r.trial_start)) : s;
    const row = { program: a.program, trial_start: new Date(start).toISOString(), extra_days: r ? r.extra_days : 0 };
    rows.set(k, row); return { ...row };
  };
  return { rows, calls, rpc };
}
/** One Windows user on one PC: their own AppData and HKCU; the PC's MachineGuid. */
function user(guid, reg = G.memoryRegistry()) { return { appData: tmp(), reg, guid }; }
function as(u) { G.configure({ registry: u.reg, machineGuid: u.guid }); return u; }
const startOf = (u, now) => { as(u); return licence.status(u.appData, now).trialStart; };
test.afterEach(() => G.configure({ registry: null, machineGuid: null }));

test('pcId: a one-way HMAC-SHA256 of the MachineGuid with the app key; the MachineGuid itself is never sent', () => {
  const guid = 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f';
  const id = G.pcIdFrom(guid);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, crypto.createHmac('sha256', G.APP_KEY).update(guid).digest('hex'));
  assert.equal(G.pcIdFrom(guid.toUpperCase()), id, 'same PC, same code');
  assert.notEqual(G.pcIdFrom('00000000-b4a5-4697-8879-6a5b4c3d2e1f'), id);
  assert.ok(!id.includes(guid.replace(/-/g, '')));
  assert.equal(G.pcIdFrom(''), null); assert.equal(G.pcIdFrom('not a guid; rm -rf'), null);
  assert.equal(G.readMachineGuid({ platform: 'linux' }), null);
  assert.equal(G.readMachineGuid({ platform: 'win32', run: () => '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ' + guid + '\r\n' }), guid);
  assert.equal(G.readMachineGuid({ platform: 'win32', run: () => { throw new Error('denied'); } }), null);
});

test('the Windows registry shim: HKCU\\Software\\Riyeser\\Trial through reg.exe, and it never throws', () => {
  const seen = [];
  const run = (cmd, args) => { seen.push([cmd, ...args]);
    if (args[0] === 'query') return 'HKEY_CURRENT_USER\\Software\\Riyeser\\Trial\r\n    suite    REG_SZ    2026-09-03T09:00:00.000Z\r\n    Installs    REG_DWORD    0x2\r\n    LatestSeen    REG_SZ    2026-11-01T00:00:00.000Z\r\n';
    return ''; };
  const r = G.windowsRegistry({ run });
  assert.deepEqual(r.read(), { suite: '2026-09-03T09:00:00.000Z', Installs: 2, LatestSeen: '2026-11-01T00:00:00.000Z' });
  r.write({ suite: '2026-08-01T00:00:00.000Z', Installs: 3 });
  assert.deepEqual(seen[1], ['reg', 'add', 'HKCU\\Software\\Riyeser\\Trial', '/v', 'suite', '/t', 'REG_SZ', '/d', '2026-08-01T00:00:00.000Z', '/f']);
  assert.deepEqual(seen[2].slice(5, 9), ['/t', 'REG_DWORD', '/d', '3']);
  const broken = G.windowsRegistry({ run: () => { throw new Error('no reg.exe'); } });
  assert.deepEqual(broken.read(), {}); broken.write({ suite: 'x' });
  assert.equal(G.useWindowsDefaults({ platform: 'linux' }), false, 'nothing on other systems');
});

test('a new PC gets a new trial (expected and fair)', async () => {
  const srv = server();
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001'));
  assert.equal(startOf(a, T0), new Date(T0).toISOString());
  await licence.syncTrialOnline(a.appData, srv.rpc, { now: T0 });
  const b = as(user('bbbbbbbb-0000-4000-8000-000000000002'));
  const later = T0 + 200 * DAY;
  await licence.syncTrialOnline(b.appData, srv.rpc, { now: later });
  const s = licence.status(b.appData, later);
  assert.equal(s.mode, 'trial'); assert.equal(s.daysLeft, 90); assert.equal(s.trialStart, new Date(later).toISOString());
  assert.equal(srv.rows.size, 2, 'one record per PC');
});

test('reinstall: the trial date stays (the registry survives uninstalling, and so does AppData)', () => {
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001'));
  licence.status(a.appData, T0);
  assert.equal(a.reg.data.suite, new Date(T0).toISOString(), 'written to HKCU\\Software\\Riyeser\\Trial');
  // uninstall + reinstall Central: its own data folder may go; licence.json and the registry stay
  fs.rmSync(licence.centralDir(a.appData), { recursive: true, force: true });
  const s = licence.status(a.appData, T0 + 30 * DAY);
  assert.equal(s.trialStart, new Date(T0).toISOString()); assert.equal(s.daysLeft, 60);
});

test('deleted AppData: the same trial comes back from the registry', () => {
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001'));
  licence.status(a.appData, T0);
  fs.rmSync(a.appData, { recursive: true, force: true }); fs.mkdirSync(a.appData);
  const s = licence.status(a.appData, T0 + 95 * DAY);
  assert.equal(s.trialStart, new Date(T0).toISOString()); assert.equal(s.mode, 'expired');
  assert.equal(JSON.parse(fs.readFileSync(licence.licenceFile(a.appData), 'utf8')).trialStart, new Date(T0).toISOString(), 'and licence.json has it again');
});

test('deleted AppData and registry (e.g. a new Windows install on the same PC): the online PC record brings it back', async () => {
  const srv = server();
  const guid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const a = as(user(guid));
  licence.status(a.appData, T0);
  await licence.syncTrialOnline(a.appData, srv.rpc, { now: T0 + DAY });
  const fresh = as(user(guid));   // nothing on this PC any more
  const now = T0 + 40 * DAY;
  assert.equal(licence.status(fresh.appData, now).daysLeft, 90, 'offline: looks new (it can\'t know)');
  const r = await licence.syncTrialOnline(fresh.appData, srv.rpc, { now });
  assert.ok(r.sent >= 1);
  const s = licence.status(fresh.appData, now);
  assert.equal(s.trialStart, new Date(T0).toISOString()); assert.equal(s.daysLeft, 50);
  assert.equal(Date.parse(srv.rows.values().next().value.trial_start), T0, 'the server never moved it later');
});

test('a new Windows user on the same PC: the same trial, through the machine-level PC code online', async () => {
  const srv = server();
  const guid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const first = as(user(guid));
  licence.status(first.appData, T0);
  await licence.syncTrialOnline(first.appData, srv.rpc, { now: T0 });
  const second = as(user(guid));   // own AppData, own HKCU (HKLM can't be written without admin)
  const now = T0 + 10 * DAY;
  await licence.syncTrialOnline(second.appData, srv.rpc, { now });
  assert.equal(licence.status(second.appData, now).trialStart, new Date(T0).toISOString());
  assert.equal(new Set(srv.calls.map((c) => c.pc)).size, 1, 'one PC code for both Windows users');
});

test('a restored old company file: its older date wins', () => {
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001'));
  const now = T0 + 100 * DAY;
  assert.equal(licence.status(a.appData, now).daysLeft, 90, 'fresh install');
  // Accounting (riyeser/trial_guard.py) opens the restored books, finds their stamp and passes it on
  G.record(a.appData, 'suite', { companyFile: T0, now });
  const s = licence.status(a.appData, now);
  assert.equal(s.trialStart, new Date(T0).toISOString()); assert.equal(s.mode, 'expired');
  // a newer company file never moves it later
  G.record(a.appData, 'suite', { companyFile: now, now });
  assert.equal(licence.status(a.appData, now).trialStart, new Date(T0).toISOString());
});

test('the clock rolled back: no extension, and it is noted for support', () => {
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001'));
  licence.status(a.appData, T0);
  licence.status(a.appData, T0 + 80 * DAY);
  // wipe AppData too: the registry still has the latest time seen
  fs.rmSync(a.appData, { recursive: true, force: true }); fs.mkdirSync(a.appData);
  const back = T0 + 5 * DAY;
  const s = licence.status(a.appData, back);
  assert.equal(s.daysLeft, 10, 'counted from the latest time seen, not the wound-back clock');
  assert.ok(a.reg.data.ClockBack, 'the clock going backwards is noted');
  const rep = licence.trialReport(a.appData, back);
  assert.equal(rep.clock_back, true);
});

test('online: earliest of local and server; a later local date never moves the server date; unreachable never blocks', async () => {
  const srv = server();
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001'));
  licence.status(a.appData, T0 + 20 * DAY);
  srv.rows.set(`${G.pcId()}|suite`, { program: 'suite', trial_start: new Date(T0).toISOString(), extra_days: 0 });
  await licence.syncTrialOnline(a.appData, srv.rpc, { now: T0 + 20 * DAY });
  assert.equal(licence.status(a.appData, T0 + 20 * DAY).trialStart, new Date(T0).toISOString(), 'the server\'s earlier date adopted');
  assert.equal(srv.calls[0].trial_start, new Date(T0 + 20 * DAY).toISOString(), 'only dates and the PC code are sent');
  assert.deepEqual(Object.keys(srv.calls[0]).sort(), ['app_version', 'name', 'pc', 'program', 'trial_start']);
  // offline, refused, or hanging: nothing thrown, the local dates stand
  const r1 = await licence.syncTrialOnline(a.appData, async () => { throw new Error('offline'); }, { now: T0 + 21 * DAY });
  assert.equal(r1.sent, 0);
  const r2 = await G.syncOnline({ appData: a.appData, rpc: () => new Promise(() => {}), starts: { suite: T0 }, timeoutMs: 50 });
  assert.equal(r2.sent, 0);
  assert.equal(licence.status(a.appData, T0 + 21 * DAY).trialStart, new Date(T0).toISOString());
  // no MachineGuid (not Windows): nothing sent
  G.configure({ machineGuid: null });
  assert.equal((await G.syncOnline({ appData: a.appData, rpc: srv.rpc, starts: { suite: T0 } })).skipped, 'no-pc-id');
  assert.ok(G.onlineDue(0)); assert.ok(!G.onlineDue(Date.now() - 3600e3)); assert.ok(G.onlineDue(Date.now() - 21 * 3600e3));
});

test('Estimate (a first-use trial): only looked up, never started, by Central; its own date is kept per program', async () => {
  const srv = server();
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001'));
  licence.status(a.appData, T0);
  await licence.syncTrialOnline(a.appData, srv.rpc, { now: T0 });
  const est = srv.calls.find((c) => c.program === 'estimate');
  assert.equal(est.trial_start, null, 'not used yet: a look-up only');
  assert.ok(![...srv.rows.keys()].some((k) => k.endsWith('|estimate')), 'no Estimate trial started on the server');
  G.record(a.appData, 'estimate', { start: T0 + 10 * DAY, now: T0 + 10 * DAY });
  await licence.syncTrialOnline(a.appData, srv.rpc, { now: T0 + 11 * DAY });
  assert.equal(srv.rows.get(`${G.pcId()}|estimate`).trial_start, new Date(T0 + 10 * DAY).toISOString());
  assert.equal(a.reg.data.estimate, new Date(T0 + 10 * DAY).toISOString());
  assert.equal(a.reg.data.suite, new Date(T0).toISOString(), 'the shared trial is separate');
});

test('a goodwill extension from Riyeser HQ: added while Riyeser online says so', async () => {
  const srv = server();
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001'));
  licence.status(a.appData, T0);
  await licence.syncTrialOnline(a.appData, srv.rpc, { now: T0 });
  srv.rows.get(`${G.pcId()}|suite`).extra_days = 14;
  const now = T0 + 95 * DAY;
  assert.equal(licence.status(a.appData, now).mode, 'expired');
  await licence.syncTrialOnline(a.appData, srv.rpc, { now });
  const s = licence.status(a.appData, now);
  assert.equal(s.mode, 'trial'); assert.equal(s.daysLeft, 9);
  assert.equal(s.trialStart, new Date(T0).toISOString(), 'the start date doesn\'t move');
});

test('a licensed (paid) program and a signed-in business: the plan from Riyeser online still decides', () => {
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001'));
  G.record(a.appData, 'suite', { start: T0 - 400 * DAY, companyFile: T0 - 400 * DAY, now: T0 });   // an old, ended local trial
  require('../src/core/online').writeCompany(a.appData, { mode: 'online', name: 'Sample Plumbing', company_code: 'RIY-TEST-01', workspace_id: '11111111-1111-4111-8111-111111111111' });
  licence.saveOnline(a.appData, { workspace_id: '11111111-1111-4111-8111-111111111111', company_code: 'RIY-TEST-01', modules: {
    basic: { status: 'active', active: true, paid_until: '2027-06-30' },
    payroll: { status: 'trial', active: true, trial_ends: '2026-12-01' } } }, T0);
  S.useKeyForTests('');   // before licence signing: the saved plan counts (with a key, only a signed one: signed-licence.test.js)
  try {
    const s = licence.status(a.appData, T0);
    assert.equal(s.mode, 'expired', 'the local trial is long over');
    const rows = Object.fromEntries(s.online.rows.map((r) => [r.id, r]));
    assert.equal(rows.basic.tone, 'ok', 'paid: unaffected');
    assert.match(rows.payroll.text, /free trial, \d+ days left/, 'the business\'s trial dates are the server\'s, not this PC\'s');
  } finally { S.useKeyForTests(null); }
});

test('demo mode never touches the trial', async () => {
  const srv = server();
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001'));
  fs.mkdirSync(path.join(a.appData, 'Riyeser'), { recursive: true });
  fs.writeFileSync(path.join(a.appData, 'Riyeser', 'demo.json'), JSON.stringify({ on: true }));
  const s = licence.status(a.appData, T0);
  assert.equal(s.mode, 'trial'); assert.equal(s.daysLeft, 90);
  assert.equal(licence.read(a.appData).trialStart, undefined, 'not started');
  assert.deepEqual(a.reg.data, {}, 'registry untouched');
  assert.equal((await licence.syncTrialOnline(a.appData, srv.rpc, { now: T0 })).skipped, 'demo');
  assert.equal(srv.calls.length, 0);
  // out of demo mode, the real trial starts then
  fs.writeFileSync(path.join(a.appData, 'Riyeser', 'demo.json'), JSON.stringify({ on: false }));
  assert.equal(licence.status(a.appData, T0 + 3 * DAY).trialStart, new Date(T0 + 3 * DAY).toISOString());
});

test('Report an issue: the trial record (one-way PC code, dates per place), never names or folder paths', () => {
  const a = as(user('aaaaaaaa-0000-4000-8000-000000000001', G.memoryRegistry({ Installs: 3 })));
  licence.status(a.appData, T0);
  G.record(a.appData, 'suite', { companyFile: T0 - DAY, now: T0 + DAY });
  const rep = licence.trialReport(a.appData, T0 + DAY);
  assert.equal(rep.pc_id, G.pcIdFrom(a.guid)); assert.equal(rep.installs, 3); assert.equal(rep.clock_back, false);
  const suite = rep.programs.find((p) => p.program === 'suite');
  assert.equal(suite.start, new Date(T0 - DAY).toISOString()); assert.equal(suite.days_left, 88);
  assert.deepEqual(Object.keys(suite.sources).sort(), ['company_file', 'licence_json', 'marker', 'online', 'registry']);
  assert.equal(suite.sources.company_file, new Date(T0 - DAY).toISOString());
  const diag = dg.build({ product: 'central', programs: { central: '1.9.0' }, trial: { ...rep, extra: 'C:\\Users\\sam\\x', programs: [...rep.programs, { program: 'evil', start: 'x' }] } });
  const text = JSON.stringify(diag.trial);
  assert.ok(!text.includes(a.appData) && !/Users|sam/.test(text), 'no paths or names');
  assert.deepEqual(Object.keys(diag.trial).sort(), ['clock_back', 'clock_back_at', 'installs', 'latest_seen', 'pc_id', 'programs']);
  assert.ok(diag.trial.programs.every((p) => ['suite', 'estimate'].includes(p.program)));
  assert.ok(!text.includes(a.guid), 'never the MachineGuid');
  // the dates and counts are untouched by the scrub (only the PC code is checked by its own pattern instead)
  for (const p of diag.trial.programs) for (const v of [p.start, p.ends, ...Object.values(p.sources)].filter(Boolean)) assert.equal(dg.scrub(v), v);
  const rows = Object.fromEntries(dg.preview(diag, {}));
  assert.match(rows['Free trial record'], /Riyeser trial from 2026-09-02, 88 day\(s\) left · PC code [0-9a-f]{8}…/);
  // no trial given (an older Central): the report is as before
  assert.ok(!('trial' in dg.build({ product: 'central' })));
});
