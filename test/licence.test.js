// Payroll's licence: free for 90 days, then the company's Riyeser plan (module 'payroll'), and every way of cheating
// the licence file leaves new pay runs locked. Viewing, printing and the time clock always work.
// test/fixtures/licence-vectors.json is shared with Central, Accounting and the licence function.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-licence-'));
const APPDATA = path.join(ROOT, 'AppData');
const DATA = path.join(ROOT, 'payroll');
Object.assign(process.env, { DESKTOP: '1', APPDATA, DATA_DIR: DATA, RIYESER_DEMO_FILE: path.join(ROOT, 'no-demo.json'), RIYESER_DEMO: '' });
delete process.env.BACKUP_DIR;

const S = require('../signed-licence');
const licence = require('../licence');
const V = require('./fixtures/licence-vectors.json');

const DAY = 86400000;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const WS = '11111111-1111-4111-8111-111111111111';
const DEV = '22222222-2222-4222-8222-222222222222';
const b64u = (h) => Buffer.from(h, 'hex').toString('base64url');
// RFC 8032 test key 1: published, only ever used in tests
const K1 = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64u(V.rfc8032[0].secret), x: b64u(V.rfc8032[0].public) }, format: 'jwk' });
const PUB = V.sample.public_key;
const OTHER = crypto.generateKeyPairSync('ed25519').privateKey;
const mod = (o) => ({ workspace_id: WS, company_code: 'RIY-TEST-01', modules: { payroll: o }, seats: { included: 3, extra: 0, used: 1 } });
const PAID = mod({ status: 'active', active: true, trial_ends: null, paid_until: '2027-06-30', days_left: 218 });
const TRIAL = mod({ status: 'trial', active: true, trial_ends: '2027-01-03', paid_until: null, days_left: 40 });
const ENDED = mod({ status: 'ended', active: false, trial_ends: '2026-11-01', paid_until: null, days_left: 0 });

function sign(plan, { key = K1, issued = NOW, device = DEV, ws = WS } = {}) {
  const env = { licence: plan, issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + 30 * DAY).toISOString(), workspace_id: ws, device_id: device };
  return { ...env, sig: crypto.sign(null, Buffer.from(S.canonical(env)), key).toString('base64') };
}
let n = 0;
/** A pretend PC: %APPDATA%\Riyeser with company.json, device.json and licence.json, and Payroll's own folder. */
function pc({ plan = PAID, signed = 'sign', device = DEV, ws = WS, checkedAt = NOW, trialStart = new Date(NOW - 200 * DAY).toISOString(), online = true } = {}) {
  const appData = path.join(ROOT, `pc${++n}`); const rd = path.join(appData, 'Riyeser'); const own = path.join(appData, 'Riyeser Payroll', 'payroll');
  fs.mkdirSync(rd, { recursive: true }); fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(rd, 'company.json'), JSON.stringify({ mode: 'online', name: 'Sample Trading Co', workspace_id: ws }));
  if (device) S.writeDeviceId(appData, device);
  const s = signed === 'sign' ? sign(plan) : signed;
  const lic = { trialStart };
  if (online) lic.online = { ...(s ? s.licence : plan), checkedAt: new Date(checkedAt).toISOString(), ...(s ? { signed: s } : {}) };
  fs.writeFileSync(path.join(rd, 'licence.json'), JSON.stringify(lic));
  return { appData, ownDir: own, file: path.join(rd, 'licence.json') };
}
const st = (p, now = NOW) => licence.status({ appData: p.appData, ownDir: p.ownDir, now });
const edit = (p, fn) => { const d = JSON.parse(fs.readFileSync(p.file, 'utf8')); fn(d); fs.writeFileSync(p.file, JSON.stringify(d)); };

// ---------- the shared vectors ----------
test('canonical JSON and the RFC 8032 vectors, the same as every other Riyeser program', () => {
  for (const c of V.canonical) assert.strictEqual(S.canonical(c.input), c.expected);
  const { sig, ...rest } = V.sample.envelope; assert.ok(sig);
  assert.strictEqual(S.canonical(rest), V.sample.canonical);
  for (const t of V.rfc8032) {
    assert.ok(crypto.verify(null, Buffer.from(t.message, 'hex'), S.publicKeyObject(Buffer.from(t.public, 'hex').toString('base64')), Buffer.from(t.signature, 'hex')));
  }
  assert.ok(S.verifySignature(V.sample.envelope, PUB));
  assert.strictEqual(sign(V.sample.envelope.licence, { issued: Date.parse(V.sample.envelope.issued_at) }).sig, V.sample.envelope.sig);
});

// ---------- the rules (signing switched on: a public key built in) ----------
test('licence rules: trial, paid, ended, cheating and the clock', async (t) => {
  S.useKeyForTests(PUB);
  t.after(() => S.useKeyForTests(null));
  await t.test('trial active (the local 90 days, a PC never linked)', () => {
    const p = pc({ online: false, trialStart: new Date(NOW - 10 * DAY).toISOString() });
    const s = st(p); assert.deepStrictEqual([s.licensed, s.mode, s.daysLeft], [true, 'trial', 80]);
  });
  await t.test('trial active (the company\'s trial from Riyeser online)', () => {
    const s = st(pc({ plan: TRIAL })); assert.deepStrictEqual([s.licensed, s.mode, s.daysLeft], [true, 'trial', 40]);
  });
  await t.test('paid', () => { const s = st(pc()); assert.deepStrictEqual([s.licensed, s.mode], [true, 'licensed']); });
  await t.test('ended: the message, the price and the button', () => {
    const s = st(pc({ plan: ENDED }));
    assert.strictEqual(s.licensed, false);
    assert.strictEqual(s.message, 'Payroll\'s free trial has ended. You can still see and print everything. To run new pay runs, add Payroll from your Riyeser home page (US$25/month).');
    assert.strictEqual(s.homeUrl, 'https://riyeser.com/link/');
    const local = st(pc({ online: false }));   // a PC that was never online, after its 90 days
    assert.strictEqual(local.licensed, false); assert.strictEqual(local.message, licence.ENDED);
  });
  await t.test('edited licence (payroll switched on by hand) is locked', () => {
    const p = pc({ plan: ENDED });
    edit(p, (d) => { d.online.signed.licence.modules.payroll = { status: 'active', active: true, paid_until: '2099-12-31' }; d.online.modules = d.online.signed.licence.modules; });
    const s = st(p); assert.strictEqual(s.licensed, false); assert.strictEqual(s.problem, 'signature');
  });
  await t.test('signed with a different key is locked', () => { assert.strictEqual(st(pc({ signed: sign(PAID, { key: OTHER }) })).licensed, false); });
  await t.test('copied licence (the right business, the wrong PC) is locked', () => {
    const s = st(pc({ device: '33333333-3333-4333-8333-333333333333' })); assert.deepStrictEqual([s.licensed, s.problem], [false, 'device']);
    assert.strictEqual(st(pc({ ws: '44444444-4444-4444-8444-444444444444' })).problem, 'business');
  });
  await t.test('clock rolled back is locked', () => {
    const p = pc();
    assert.strictEqual(st(p, NOW + 20 * DAY).licensed, true);
    const s = st(p, NOW + 5 * DAY); assert.deepStrictEqual([s.licensed, s.problem], [false, 'clock']);
    assert.match(s.message, /clock/);
    fs.rmSync(path.join(p.appData, 'Riyeser', S.MARKER));   // Payroll's own marker still remembers
    assert.strictEqual(st(p, NOW + 5 * DAY).problem, 'clock');
  });
  await t.test('offline within the 30-day grace keeps working; after it, locked', () => {
    const p = pc();
    assert.strictEqual(st(p, NOW + 29 * DAY).licensed, true);
    const s = st(p, NOW + 31 * DAY); assert.deepStrictEqual([s.licensed, s.problem], [false, 'expired']);
    assert.match(s.message, /couldn't check your plan for 30 days/);
  });
  await t.test('a trial ends on its own date even offline', () => { assert.strictEqual(st(pc({ plan: TRIAL }), Date.parse('2027-01-04T01:00:00Z')).licensed, false); });
  await t.test('an older Central\'s unsigned licence: 14 days with "Update Riyeser Central", then locked', () => {
    const p = pc({ signed: null });
    const s = st(p); assert.strictEqual(s.licensed, true);
    assert.strictEqual(s.message, 'Open Riyeser Central and sign in to your Riyeser account to refresh your plan (until 8 December 2026).');
    assert.strictEqual(s.graceUntil, new Date(NOW + 14 * DAY).toISOString());
    edit(p, (d) => { d.online.checkedAt = new Date(NOW + 13 * DAY).toISOString(); });
    assert.strictEqual(st(p, NOW + 13 * DAY).licensed, true);
    const late = st(p, NOW + 15 * DAY); assert.deepStrictEqual([late.licensed, late.problem], [false, 'unsigned']);
    assert.match(late.message, /^Your plan couldn't be confirmed: open Riyeser Central and sign in to your Riyeser account to refresh it\. You can still see and print everything\./);
  });
  await t.test('the local trial: deleting licence.json doesn\'t restart it, and winding the clock back gives nothing', () => {
    const p = pc({ online: false, trialStart: new Date(NOW - 100 * DAY).toISOString() });
    assert.strictEqual(st(p).licensed, false);
    fs.rmSync(p.file); fs.rmSync(path.join(p.appData, 'Riyeser', S.MARKER));
    assert.strictEqual(st(p).licensed, false);   // Payroll's own hidden marker
    const q = pc({ online: false, trialStart: new Date(NOW).toISOString() });
    st(q, NOW + 85 * DAY);
    assert.strictEqual(st(q, NOW + 10 * DAY).daysLeft, 5);
  });
});

test('transition: with no key built in, an unsigned licence works exactly as before', () => {
  S.useKeyForTests('');
  try { assert.strictEqual(st(pc({ signed: null })).licensed, true); assert.strictEqual(st(pc({ signed: null, plan: ENDED })).licensed, false); }
  finally { S.useKeyForTests(null); }
});

// ---------- Payroll's own API enforces it ----------
let server; let B; let cookie;
async function call(method, url, body) {
  const res = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
let app;
const useLicence = (p) => { app.locals.payrollLicence = licence.checker({ enforce: true, appData: p.appData, ownDir: p.ownDir, now: () => NOW }); };
before(async () => {
  ({ app, server } = require('../server'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  B = `http://127.0.0.1:${server.address().port}`;
  const s = await call('POST', '/api/public/setup', { name: 'Owner', username: 'owner', password: 'OwnerPass1', password2: 'OwnerPass1', company_name: 'Sample Trading Co' });
  assert.strictEqual(s.status, 200, JSON.stringify(s.data));
  cookie = (await call('POST', '/api/auth/login', { username: 'owner', password: 'OwnerPass1' })).cookie;
});
after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { } });

test('API: not licensed: no new pay runs or pay-rate changes, but everything can be seen and the time clock works', async () => {
  S.useKeyForTests(PUB);
  try {
    useLicence(pc({ plan: ENDED }));
    const l = await call('GET', '/api/staff/licence');
    assert.strictEqual(l.data.licensed, false); assert.strictEqual(l.data.home_url, 'https://riyeser.com/link/'); assert.match(l.data.message, /US\$25\/month/);
    const run = await call('POST', '/api/staff/payroll/runs', { period_start: '2026-11-01', period_end: '2026-11-14', pay_date: '2026-11-15' });
    assert.strictEqual(run.status, 402); assert.strictEqual(run.data.locked, true); assert.match(run.data.error, /^Payroll's free trial has ended\./);
    assert.strictEqual((await call('POST', '/api/staff/payroll/preview', { period_start: '2026-11-01', period_end: '2026-11-14' })).status, 402);
    // staff: a new person without pay is fine; a pay rate is locked; other details can still be kept up to date
    const add = await call('POST', '/api/staff/employees', { name: 'Sera Tui', username: 'sera', password: 'staffpass1', role: 'staff' });
    assert.strictEqual(add.status, 200, JSON.stringify(add.data));
    assert.strictEqual((await call('PUT', `/api/staff/employees/${add.data.id}`, { pay_rate: 7.5 })).status, 402);
    assert.strictEqual((await call('POST', '/api/staff/employees', { name: 'Jo Paid', username: 'jopaid', password: 'staffpass1', role: 'staff', pay_rate: 9 })).status, 402);
    assert.strictEqual((await call('PUT', `/api/staff/employees/${add.data.id}`, { phone: '555 0101' })).status, 200);
    // viewing and printing
    for (const u of ['/api/staff/employees', '/api/staff/timesheets', '/api/staff/payroll/runs', '/api/staff/payslips/mine']) assert.strictEqual((await call('GET', u)).status, 200, u);
    const slips = await call('GET', '/api/staff/payslips/build?from=2026-11-01&to=2026-11-14');
    assert.strictEqual(slips.status, 200); assert.ok(slips.data.payslips.every((x) => x.status === 'final'), 'no new draft payslips');
    // the time clock keeps recording hours
    const clock = await call('POST', '/api/staff/clock', {});
    assert.strictEqual(clock.status, 200, JSON.stringify(clock.data)); assert.strictEqual(clock.data.on_shift, true);
  } finally { S.useKeyForTests(null); }
});

test('API: licensed (and an edited licence isn\'t)', async () => {
  S.useKeyForTests(PUB);
  try {
    useLicence(pc());
    assert.strictEqual((await call('GET', '/api/staff/licence')).data.licensed, true);
    const emp = (await call('GET', '/api/staff/employees')).data.find((e) => e.username === 'sera');
    assert.strictEqual((await call('PUT', `/api/staff/employees/${emp.id}`, { pay_rate: 7.5 })).status, 200);
    assert.notStrictEqual((await call('POST', '/api/staff/payroll/preview', { period_start: '2026-11-01', period_end: '2026-11-14' })).status, 402);
    const p = pc({ plan: ENDED });
    edit(p, (d) => { d.online.signed.licence.modules.payroll = PAID.modules.payroll; });
    useLicence(p);
    assert.strictEqual((await call('POST', '/api/staff/payroll/runs', { period_start: '2026-11-01', period_end: '2026-11-14', pay_date: '2026-11-15' })).status, 402);
  } finally { S.useKeyForTests(null); }
});

test('OWNER-BANNER: an unsigned online plan within its 14 days doesn\'t block pay runs', async () => {
  S.useKeyForTests(PUB);
  try {
    const p = pc({ signed: null });   // licence.json has the plan, but unsigned (Central not signed in since a fresh start)
    useLicence(p);
    const l = (await call('GET', '/api/staff/licence')).data;
    assert.strictEqual(l.licensed, true); assert.strictEqual(l.grace_until, new Date(NOW + 14 * DAY).toISOString());
    assert.match(l.message, /^Open Riyeser Central and sign in to your Riyeser account to refresh your plan \(until 8 December 2026\)\.$/);
    assert.strictEqual((await call('GET', '/api/staff/payroll/next-period')).status, 200);
    const pv = await call('POST', '/api/staff/payroll/preview', { period_start: '2026-11-16', period_end: '2026-11-22' });
    assert.strictEqual(pv.status, 200, JSON.stringify(pv.data)); assert.ok(pv.data.lines.length);
    const run = await call('POST', '/api/staff/payroll/runs', { period_start: '2026-11-16', period_end: '2026-11-22', pay_date: '2026-11-23' });
    assert.strictEqual(run.status, 200, JSON.stringify(run.data));
    const emp = (await call('GET', '/api/staff/employees')).data.find((e) => e.username === 'sera');
    assert.strictEqual((await call('PUT', `/api/staff/employees/${emp.id}`, { pay_rate: 8 })).status, 200);   // pay rates too
    // day 13 of the 14: still fine; after the 14 days: locked
    app.locals.payrollLicence = licence.checker({ enforce: true, appData: p.appData, ownDir: p.ownDir, now: () => NOW + 13 * DAY });
    assert.strictEqual((await call('POST', '/api/staff/payroll/preview', { period_start: '2026-11-23', period_end: '2026-11-29' })).status, 200);
    app.locals.payrollLicence = licence.checker({ enforce: true, appData: p.appData, ownDir: p.ownDir, now: () => NOW + 15 * DAY });
    assert.strictEqual((await call('POST', '/api/staff/payroll/preview', { period_start: '2026-11-23', period_end: '2026-11-29' })).status, 402);
  } finally { S.useKeyForTests(null); }
});
