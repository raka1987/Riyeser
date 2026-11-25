// Signed licences: every way of cheating the licence file should leave the paid programs locked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const S = require('../src/core/signed-licence');
const licence = require('../src/core/licence');
const on = require('../src/core/online');
const { Store } = require('../src/core/store');
const { callsLicence } = require('../src/link/licence');

const V = require('./fixtures/licence-vectors.json');
const DAY = 86400000;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const WS = '11111111-1111-4111-8111-111111111111';
const DEV = '22222222-2222-4222-8222-222222222222';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slic-'));
const b64u = (h) => Buffer.from(h, 'hex').toString('base64url');
// RFC 8032 test key 1: a published test key, only ever used in tests
const K1 = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64u(V.rfc8032[0].secret), x: b64u(V.rfc8032[0].public) }, format: 'jwk' });
const PUB = V.sample.public_key;
const OTHER = crypto.generateKeyPairSync('ed25519').privateKey;

const PLAN = {
  workspace_id: WS, company_code: 'RIY-TEST-01', checked_at: '2026-11-24T12:00:00.000Z', business_status: 'active',
  modules: {
    payroll: { status: 'ended', active: false, trial_ends: '2026-11-01', paid_until: null, days_left: 0 },
    basic: { status: 'active', active: true, trial_ends: null, paid_until: '2027-06-30', days_left: 218 },
    calls: { status: 'trial', active: true, trial_ends: '2027-01-03', paid_until: null, days_left: 40 },
  },
  seats: { included: 3, extra: 0, used: 2 }, extra_companies: 0, billing: 'monthly', early_bird: false,
};
function sign(plan = PLAN, { key = K1, issued = NOW, device = DEV, ws = WS } = {}) {
  const env = { licence: plan, issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + 30 * DAY).toISOString(), workspace_id: ws, device_id: device };
  return { ...env, sig: crypto.sign(null, Buffer.from(S.canonical(env)), key).toString('base64') };
}
/** A PC linked to the business: company.json, device.json and Central's saved licence. */
function pc({ signed = sign(), ws = WS, device = DEV, checkedAt = NOW } = {}) {
  const appData = tmp();
  on.writeCompany(appData, { mode: 'online', name: 'Sample Plumbing', company_code: 'RIY-TEST-01', workspace_id: ws });
  if (device) S.writeDeviceId(appData, device);
  licence.saveOnline(appData, signed ? signed.licence : PLAN, checkedAt, signed);
  return appData;
}
const edit = (appData, fn) => { const f = licence.licenceFile(appData); const d = JSON.parse(fs.readFileSync(f, 'utf8')); fn(d); fs.writeFileSync(f, JSON.stringify(d)); };
const withKey = (k, fn) => { S.useKeyForTests(k); try { return fn(); } finally { S.useKeyForTests(null); } };
const basicRow = (appData, now = NOW) => licence.onlinePlan(appData, now).rows.find((r) => r.id === 'basic');

// ---------- the shared test data (the same file is in Accounting, Payroll and the licence function) ----------
test('canonical JSON matches the shared vectors byte for byte', () => {
  for (const c of V.canonical) assert.strictEqual(S.canonical(c.input), c.expected);
  const { sig, ...rest } = V.sample.envelope; assert.ok(sig);
  assert.strictEqual(S.canonical(rest), V.sample.canonical);
  assert.throws(() => S.canonical({ a: 1.5 }), /whole numbers/);
  // the same as JSON.stringify with sorted keys, for ordinary data
  const sortDeep = (v) => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v);
  assert.strictEqual(S.canonical(PLAN), JSON.stringify(sortDeep(PLAN)));
});
test('Ed25519: the RFC 8032 test vectors verify with crypto.verify, and a changed message does not', () => {
  for (const t of V.rfc8032) {
    const pub = Buffer.from(t.public, 'hex').toString('base64');
    const key = S.publicKeyObject(pub);
    assert.ok(crypto.verify(null, Buffer.from(t.message, 'hex'), key, Buffer.from(t.signature, 'hex')));
    assert.ok(!crypto.verify(null, Buffer.from(`${t.message}00`, 'hex'), key, Buffer.from(t.signature, 'hex')));
  }
  assert.ok(S.verifySignature(V.sample.envelope, PUB));
  assert.ok(!S.verifySignature({ ...V.sample.envelope, expires_at: '2027-12-24T12:00:00.000Z' }, PUB));
  assert.ok(!S.verifySignature(V.sample.envelope, Buffer.alloc(32, 7).toString('base64')));
  assert.ok(!S.verifySignature({ ...V.sample.envelope, sig: 'not a signature' }, PUB));
});

// ---------- cheating, in Central's plan view and Riyeser Link Office ----------
test('valid: a signed licence for this business and this PC unlocks', () => withKey(PUB, () => {
  const a = pc();
  assert.strictEqual(licence.trustedOnline(a, NOW).state, 'trusted');
  assert.strictEqual(basicRow(a).tone, 'ok');
  assert.strictEqual(licence.onlinePlan(a, NOW).stale, false);
  const c = callsLicence(a, NOW); assert.deepStrictEqual([c.active, c.state, c.daysLeft], [true, 'trial', 40]);
}));
test('edited: modules switched on by hand stay locked', () => withKey(PUB, () => {
  const a = pc();
  edit(a, (d) => { d.online.signed.licence.modules.payroll = { status: 'active', active: true, paid_until: '2099-12-31' }; d.online.modules.payroll = d.online.signed.licence.modules.payroll; });
  assert.strictEqual(licence.trustedOnline(a, NOW).problem, 'signature');
  const p = licence.onlinePlan(a, NOW);
  assert.ok(p.stale && p.rows.every((r) => r.tone === 'bad' && r.locked));
  assert.match(p.message, /couldn't be checked/);
  assert.strictEqual(callsLicence(a, NOW).active, false);
  // the unsigned copy next to it (for older programs) is ignored too
  const b = pc(); edit(b, (d) => { d.online.modules.payroll = { status: 'active', active: true }; });
  assert.strictEqual(licence.onlinePlan(b, NOW).rows.find((r) => r.id === 'payroll').tone, 'bad');
}));
test('a later expiry date written in is refused', () => withKey(PUB, () => {
  const a = pc(); edit(a, (d) => { d.online.signed.expires_at = '2099-01-01T00:00:00.000Z'; });
  assert.strictEqual(callsLicence(a, NOW + 40 * DAY).active, false);
  assert.strictEqual(licence.trustedOnline(a, NOW).problem, 'signature');
}));
test('signed with a different key: locked', () => withKey(PUB, () => {
  const a = pc({ signed: sign(PLAN, { key: OTHER }) });
  assert.strictEqual(licence.trustedOnline(a, NOW).problem, 'signature');
  assert.strictEqual(callsLicence(a, NOW).active, false);
}));
test('copied: the right business but another PC is locked', () => withKey(PUB, () => {
  const a = pc({ device: '33333333-3333-4333-8333-333333333333' });
  assert.strictEqual(licence.trustedOnline(a, NOW).problem, 'device');
  assert.strictEqual(callsLicence(a, NOW).active, false);
  const b = pc({ device: null });   // no device.json at all
  assert.strictEqual(licence.trustedOnline(b, NOW).problem, 'device');
  const c = pc({ signed: sign(PLAN, { device: null }), device: null });   // a licence that names no PC
  assert.strictEqual(licence.trustedOnline(c, NOW).state, 'trusted');
}));
test('copied to another business: locked', () => withKey(PUB, () => {
  const a = pc({ ws: '44444444-4444-4444-8444-444444444444' });
  assert.strictEqual(licence.trustedOnline(a, NOW).problem, 'business');
}));
test('expired: past expires_at (30 days offline) is locked', () => withKey(PUB, () => {
  const a = pc();
  assert.strictEqual(callsLicence(a, NOW + 29 * DAY).active, true);
  assert.strictEqual(licence.trustedOnline(a, NOW + 31 * DAY).problem, 'expired');
  assert.strictEqual(callsLicence(a, NOW + 31 * DAY).state, 'stale');
  assert.strictEqual(licence.onlinePlan(a, NOW + 31 * DAY).stale, true);
}));
test('clock moved back: more than 48 hours behind the latest time seen is locked until checked online', () => withKey(PUB, () => {
  const a = pc();
  assert.strictEqual(licence.trustedOnline(a, NOW + 20 * DAY).state, 'trusted');   // seen on day 20
  assert.strictEqual(licence.trustedOnline(a, NOW + 19 * DAY).state, 'trusted');   // a day back is fine
  const back = licence.trustedOnline(a, NOW + 5 * DAY);
  assert.strictEqual(back.problem, 'clock'); assert.match(back.message, /clock/);
  assert.strictEqual(callsLicence(a, NOW + 5 * DAY).active, false);
  // before the licence was even issued
  const b = pc(); assert.strictEqual(licence.trustedOnline(b, NOW - 3 * DAY).problem, 'clock');
  // deleting the marker in %APPDATA%\Riyeser doesn't help: Central's own marker remembers
  fs.rmSync(path.join(a, 'Riyeser', S.MARKER));
  assert.strictEqual(licence.trustedOnline(a, NOW + 5 * DAY).problem, 'clock');
  // a new licence from Riyeser (checked online) starts again from its own time
  licence.saveOnline(a, PLAN, NOW + 6 * DAY, sign(PLAN, { issued: NOW + 6 * DAY }));
  assert.strictEqual(licence.trustedOnline(a, NOW + 6 * DAY).state, 'trusted');
}));
test('transition: with no key built in, unsigned licences work exactly as before', () => withKey('', () => {
  const a = pc({ signed: null });
  assert.strictEqual(licence.trustedOnline(a, NOW).state, 'unsigned');
  assert.strictEqual(basicRow(a).tone, 'ok');
  assert.strictEqual(callsLicence(a, NOW).active, true);
}));
test('transition: once a key is built in, an older Central\'s unsigned licence gets 14 days on a PC that has had a signed plan, with "Update Riyeser Central"', () => withKey(PUB, () => {
  const a = pc();
  assert.strictEqual(licence.trustedOnline(a, NOW).state, 'trusted');   // a signed plan seen here first
  licence.saveOnline(a, PLAN, NOW + DAY);                               // then an older Central writes an unsigned one
  edit(a, (d) => { delete d.online.signed; });
  const first = licence.trustedOnline(a, NOW + DAY);
  assert.strictEqual(first.state, 'unsigned'); assert.match(first.message, /Update Riyeser Central to keep your plan up to date/);
  assert.match(licence.onlinePlan(a, NOW + DAY).message, /Update Riyeser Central/);
  const c = callsLicence(a, NOW + 5 * DAY); assert.ok(c.active); assert.match(c.message, /Update Riyeser Central/);
  assert.strictEqual(licence.trustedOnline(a, NOW + 14 * DAY).state, 'unsigned');
  const late = licence.trustedOnline(a, NOW + 16 * DAY);
  assert.deepStrictEqual([late.state, late.problem], ['invalid', 'unsigned']);
  assert.match(late.message, /Update Riyeser Central/);
  assert.strictEqual(callsLicence(a, NOW + 16 * DAY).active, false);
  // once Central is updated, the signed licence works straight away
  licence.saveOnline(a, PLAN, NOW + 17 * DAY, sign(PLAN, { issued: NOW + 17 * DAY }));
  assert.strictEqual(licence.trustedOnline(a, NOW + 17 * DAY).state, 'trusted');
}));
test('S13: a hand-written unsigned plan on a PC that never had a signed one unlocks nothing, even after deleting the markers', () => withKey(PUB, () => {
  const a = pc({ signed: null });
  const ev = licence.trustedOnline(a, NOW);
  assert.deepStrictEqual([ev.state, ev.problem], ['invalid', 'unsigned']);
  assert.match(ev.message, /Update Riyeser Central/);
  assert.strictEqual(basicRow(a).tone, 'bad');
  assert.strictEqual(callsLicence(a, NOW).active, false);
  for (const d of [path.join(a, 'Riyeser'), path.join(a, 'Riyeser Central', 'data'), path.join(a, 'Riyeser Link Office', 'data')]) fs.rmSync(path.join(d, S.MARKER), { force: true });
  assert.strictEqual(licence.trustedOnline(a, NOW + DAY).state, 'invalid');
  assert.strictEqual(callsLicence(a, NOW + DAY).active, false);
}));
test('a check that only got an unsigned answer keeps the last signed licence (same business)', () => withKey(PUB, () => {
  const a = pc();
  licence.saveOnline(a, { ...PLAN, modules: {} }, NOW + DAY);
  assert.ok(licence.read(a).online.signed);
  assert.strictEqual(licence.trustedOnline(a, NOW + DAY).state, 'trusted');
}));
test('the offline grace: a trial ends on its own date even inside the 30 days', () => withKey(PUB, () => {
  const a = pc();
  assert.strictEqual(callsLicence(a, Date.parse('2027-01-03T20:00:00Z')).active, false);   // trial_ends 3 Jan, licence good to 24 Dec
}));

// ---------- the local 90-day trial (a PC that has never been online) ----------
test('local trial: the earlier of licence.json and the hidden markers counts; deleting licence.json doesn\'t restart it', () => {
  const a = tmp();
  licence.ensureTrial(a, NOW - 100 * DAY);
  assert.strictEqual(licence.status(a, NOW).mode, 'expired');
  fs.rmSync(licence.licenceFile(a));
  assert.strictEqual(licence.status(a, NOW).mode, 'expired');
  assert.strictEqual(Date.parse(licence.read(a).trialStart), NOW - 100 * DAY);   // put back from the marker
  edit(a, (d) => { d.trialStart = new Date(NOW).toISOString(); });                // a later date written in
  assert.strictEqual(licence.status(a, NOW).mode, 'expired');
});
test('local trial: winding the clock back doesn\'t give days back', () => {
  const a = tmp();
  licence.ensureTrial(a, NOW);
  licence.ensureTrial(a, NOW + 80 * DAY);
  assert.strictEqual(licence.status(a, NOW + 10 * DAY).daysLeft, 10);
});
test('local trial: a licence key in the file no longer unlocks once licences are signed', () => withKey(PUB, () => {
  const a = tmp(); licence.ensureTrial(a, NOW - 100 * DAY);
  edit(a, (d) => { d.key = 'ABCD-EFGH-1234'; d.licence = { status: 'active', checkedAt: new Date(NOW).toISOString() }; });
  assert.strictEqual(licence.status(a, NOW).mode, 'expired');
}));

// ---------- Riyeser Central fetches the signed licence ----------
function server({ fn = 'signed', rpc = PLAN } = {}) {
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url); calls.push([u.pathname, opts.body ? JSON.parse(opts.body) : null, opts.headers || {}]);
    if (u.href.startsWith(on.CONFIG_URL)) return res(200, 'window.RIYESER_TEAM={supabaseUrl:"https://x.supabase.co",supabaseKey:"sb_publishable_k"};');
    if (u.pathname === '/functions/v1/licence') return fn === 'signed' ? res(200, sign(PLAN, { device: JSON.parse(opts.body).device })) : res(404, { message: 'Requested function was not found' });
    if (u.pathname === '/rest/v1/rpc/company_licence') return res(200, rpc);
    return res(404, {});
  };
  return { fetchFn, calls };
}
function central(appData, srv) {
  const o = new on.Online({ store: new Store(path.join(appData, 'Riyeser Central', 'data')), fetchFn: srv.fetchFn, appData, shareDevice: true });
  o.setSession({ access_token: 't', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: 'owner@sample.test' } });
  on.writeCompany(appData, { mode: 'online', name: 'Sample Plumbing', company_code: 'RIY-TEST-01', workspace_id: WS });
  return o;
}
test('Central: asks the licence function for this business and this PC, and saves the signed licence as it came', async () => {
  const a = tmp(); const srv = server(); const o = central(a, srv);
  await o.refreshLicence(NOW);
  const call = srv.calls.find((c) => c[0] === '/functions/v1/licence');
  assert.strictEqual(call[1].ws, WS); assert.strictEqual(call[2].Authorization, 'Bearer t');
  const id = S.readDeviceId(a);
  assert.ok(id); assert.strictEqual(call[1].device, id);               // device.json written by Central
  const saved = licence.read(a).online;
  assert.strictEqual(saved.signed.device_id, id); assert.ok(S.verifySignature(saved.signed, PUB));
  assert.ok(!srv.calls.some((c) => c[0] === '/rest/v1/rpc/company_licence'));
  withKey(PUB, () => assert.strictEqual(licence.trustedOnline(a, NOW).state, 'trusted'));
  // Riyeser Link Office's own sign-in uses Central's PC id, not one of its own
  const lo = new on.Online({ store: new Store(path.join(a, 'Riyeser Link Office', 'data')), fetchFn: srv.fetchFn, appData: a });
  assert.strictEqual(lo.deviceId(), id);
});
test('Central: before the licence function is switched on, it saves the unsigned plan as before', async () => {
  const a = tmp(); const srv = server({ fn: 'missing' }); const o = central(a, srv);
  const r = await o.refreshLicence(NOW);
  assert.strictEqual(r.company_code, 'RIY-TEST-01'); assert.strictEqual(licence.read(a).online.signed, undefined);
  assert.ok(srv.calls.some((c) => c[0] === '/rest/v1/rpc/company_licence'));
});

test('the prices in the locked messages are riyeser.com\'s (website/prices.mjs)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'website', 'prices.mjs'), 'utf8');
  for (const [id, text] of Object.entries(licence.MODULE_PRICES)) {
    const m = new RegExp(`\\b${id}:\\s*(\\d+)`).exec(src);
    assert.ok(m, `${id} in prices.mjs`); assert.strictEqual(text, `US$${m[1]}/month`, id);
  }
  assert.match(licence.lockedText('payroll'), /You can still open, see and print everything\..*\(US\$25\/month\)/);
});
