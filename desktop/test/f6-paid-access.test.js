// F6: a paying customer keeps access. End to end, with a pretend Riyeser online that signs licences like the real
// "licence" function (Ed25519, expires 30 days after issue):
//   pay -> sign in to Central -> link the PC -> Central's daily check -> licence status 15 and 45 days later.
// Checked three ways: Central's own view (licence.onlinePlan), Riyeser Link Office (callsLicence), and Riyeser
// Accounting's view of the same licence.json (riyeser/licence.py + signed_licence.py from main, run with Python).
//
// test/fixtures/accounting-main/riyeser holds byte-for-byte copies of main's riyeser/licence.py, signed_licence.py and
// ed25519.py, so this runs in CI too. The last test checks the copies still match main when main is available.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const S = require('../src/core/signed-licence');
const licence = require('../src/core/licence');
const on = require('../src/core/online');
const { Store } = require('../src/core/store');
const { callsLicence } = require('../src/link/licence');

const V = require('./fixtures/licence-vectors.json');
const DAY = 86400000;
const T0 = Date.parse('2026-11-25T09:00:00Z');
const WS = '55555555-5555-4555-8555-555555555555';
const b64u = (h) => Buffer.from(h, 'hex').toString('base64url');
const KEY = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64u(V.rfc8032[0].secret), x: b64u(V.rfc8032[0].public) }, format: 'jwk' });
const PUB = V.sample.public_key;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const ACCOUNTING = path.join(__dirname, 'fixtures', 'accounting-main');

/** Riyeser online: accounts, the business, payments (a monthly subscription that renews) and the licence function. */
function riyeserOnline() {
  const srv = { now: T0, paid: new Set(), linked: new Set(), calls: [] };
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  srv.plan = () => {
    const modules = {};
    for (const id of ['basic', 'plus', 'payroll', 'pos', 'bookings', 'calls']) {
      modules[id] = srv.paid.has(id)
        // paid monthly: the paid-until date is always the end of the current month the card has paid for
        ? { status: 'active', active: true, trial_ends: null, paid_until: ymd(srv.now + 30 * DAY), days_left: 30 }
        : { status: 'ended', active: false, trial_ends: ymd(T0 - 10 * DAY), paid_until: null, days_left: 0 };
    }
    return { workspace_id: WS, company_code: 'RIY-PAID-01', checked_at: new Date(srv.now).toISOString(), business_status: 'active', modules,
      seats: { included: 3, extra: 0, used: 1 }, extra_companies: 0, billing: 'monthly', early_bird: false };
  };
  srv.fetchFn = async (url, opts = {}) => {
    const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : null; srv.calls.push(u.pathname);
    if (u.href.startsWith(on.CONFIG_URL)) return res(200, 'window.RIYESER_TEAM={supabaseUrl:"https://x.supabase.co",supabaseKey:"sb_publishable_k"};');
    if (u.pathname === '/auth/v1/token') {
      return body.password === 'right-password'
        ? res(200, { access_token: 'tok', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: body.email, factors: [] } })
        : res(400, { error_description: 'Invalid login credentials' });
    }
    if (u.pathname === '/rest/v1/members') {
      return res(200, [{ role: 'owner', display_name: 'Mere', workspaces: { id: WS, name: 'Coastal Cafe', company_code: 'RIY-PAID-01', country: 'Fiji' } }]);
    }
    if (u.pathname === '/rest/v1/rpc/link_device') { srv.linked.add(body.device); return res(200, ''); }
    if (u.pathname === '/rest/v1/rpc/report_programs') return res(200, true);
    if (u.pathname === '/rest/v1/rpc/company_licence') return res(200, srv.plan());
    if (u.pathname === '/functions/v1/licence') {   // as supabase/functions/licence/sign.ts: expires 30 days after issue
      const env = { licence: srv.plan(), issued_at: new Date(srv.now).toISOString(), expires_at: new Date(srv.now + 30 * DAY).toISOString(),
        workspace_id: body.ws, device_id: srv.linked.has(body.device) ? body.device : null };
      return res(200, { ...env, sig: crypto.sign(null, Buffer.from(S.canonical(env)), KEY).toString('base64') });
    }
    return res(404, { message: 'not found' });
  };
  return srv;
}

function python() {
  for (const p of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(p, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return p;
  }
  return null;
}
/** Riyeser Accounting's status(product=...) for this PC, at time t, with the given public key built in. */
function accountingStatus(appData, product, t, key = PUB) {
  const py = python();
  if (!py) return null;
  const code = [
    'import sys, json, os',
    'from datetime import datetime, timezone',
    'sys.path.insert(0, sys.argv[1])',
    'from riyeser import licence, signed_licence',
    'signed_licence.use_key_for_tests(sys.argv[5])',
    'now = datetime.fromtimestamp(int(sys.argv[4]) / 1000, timezone.utc)',
    'print(json.dumps(licence.status(now=now, path=sys.argv[2], product=sys.argv[3])))',
  ].join('\n');
  const own = path.join(appData, 'accounting-home');
  const out = execFileSync(py, ['-I', '-c', code, ACCOUNTING, licence.licenceFile(appData), product, String(t), key],
    { encoding: 'utf8', env: { ...process.env, RIYESER_HOME: own } });
  return JSON.parse(out.trim().split('\n').pop());
}

/** Central on a new PC, signed in and linked. */
async function linkedPC(srv) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'f6-'));
  const central = new on.Online({ store: new Store(path.join(appData, 'Riyeser Central', 'data')), fetchFn: srv.fetchFn, appData,
    appVersion: '1.8.6', deviceName: 'Front desk', shareDevice: true, programsFn: async () => ({ central: '1.8.6' }) });
  licence.ensureTrial(appData, srv.now);
  const s = await central.signIn('mere@coastalcafe.com.fj', 'right-password');
  assert.strictEqual(s.email, 'mere@coastalcafe.com.fj');
  const r = await central.afterSignIn();
  assert.strictEqual(r.status, 'linked');
  return { appData, central };
}
const day = (n) => T0 + n * DAY;
const row = (appData, id, t) => licence.onlinePlan(appData, t).rows.find((x) => x.id === id);

test('F6: pay -> link the PC -> still licensed 15 and 45 days later (Central, Link Office and Accounting)', async () => {
  S.useKeyForTests(PUB);
  try {
    const srv = riyeserOnline();
    srv.paid.add('basic'); srv.paid.add('calls');   // paid on riyeser.com before setting up the PC
    const { appData, central } = await linkedPC(srv);

    // what Central left on the PC: a signed licence for this business and this PC, and device.json with the same id
    const saved = licence.read(appData).online;
    assert.ok(saved.signed && S.verifySignature(saved.signed, PUB), 'licence.json has the signed envelope');
    const dev = S.readDeviceId(appData);
    assert.ok(dev && fs.existsSync(path.join(appData, 'Riyeser', 'device.json')), 'device.json in %APPDATA%\\Riyeser');
    assert.strictEqual(saved.signed.device_id, dev);
    assert.strictEqual(on.readCompany(appData).workspace_id, WS);

    // Central's check: every 20 hours or so while it runs (refreshOnlineLicence). Day by day to day 45:
    const seen = {};
    for (let d = 0; d <= 45; d++) {
      srv.now = day(d);
      await central.refreshLicence(srv.now);
      if (d === 15 || d === 45) {
        seen[d] = {
          central: row(appData, 'basic', srv.now).tone,
          link: callsLicence(appData, srv.now).active,
          trusted: licence.trustedOnline(appData, srv.now).state,
          accounting: accountingStatus(appData, 'basic', srv.now),
        };
      }
    }
    for (const d of [15, 45]) {
      assert.strictEqual(seen[d].trusted, 'trusted', `day ${d}: signed licence trusted`);
      assert.strictEqual(seen[d].central, 'ok', `day ${d}: Central shows Accounting Basics paid`);
      assert.strictEqual(seen[d].link, true, `day ${d}: Riyeser Link on`);
      if (seen[d].accounting) {
        assert.strictEqual(seen[d].accounting.mode, 'licensed', `day ${d}: Accounting says licensed: ${JSON.stringify(seen[d].accounting)}`);
        assert.strictEqual(seen[d].accounting.source, 'online');
        assert.ok(!seen[d].accounting.message, `day ${d}: no "Update Riyeser Central" note`);
      }
    }
    // a module that wasn't paid for stays locked everywhere
    assert.strictEqual(row(appData, 'payroll', day(45)).tone, 'bad');
    const acc = accountingStatus(appData, 'plus', day(45));
    if (acc) assert.strictEqual(acc.mode, 'expired');
  } finally { S.useKeyForTests(null); }
});

test('F6: offline after linking: licensed for the 30 days the signed licence allows, then asks to connect (nothing deleted)', async () => {
  S.useKeyForTests(PUB);
  try {
    const srv = riyeserOnline(); srv.paid.add('basic');
    const { appData } = await linkedPC(srv);
    // Central not opened again (no internet): day 15 still licensed everywhere
    assert.strictEqual(row(appData, 'basic', day(15)).tone, 'ok');
    const a15 = accountingStatus(appData, 'basic', day(15));
    if (a15) assert.strictEqual(a15.mode, 'licensed');
    // day 31 without any check: the plan needs checking (the 30-day offline rule), not a silent loss
    assert.strictEqual(licence.trustedOnline(appData, day(31)).problem, 'expired');
    const a31 = accountingStatus(appData, 'basic', day(31));
    if (a31) { assert.strictEqual(a31.mode, 'expired'); assert.match(a31.message, /connect to the internet and open Riyeser Central/); }
    // ...and one check online brings it straight back
    srv.now = day(45);
    const c2 = new on.Online({ store: new Store(path.join(appData, 'Riyeser Central', 'data')), fetchFn: srv.fetchFn, appData, shareDevice: true });
    await c2.refreshLicence(srv.now);
    assert.strictEqual(row(appData, 'basic', day(45)).tone, 'ok');
    const a45 = accountingStatus(appData, 'basic', day(45));
    if (a45) assert.strictEqual(a45.mode, 'licensed');
  } finally { S.useKeyForTests(null); }
});

test('F6: the Accounting copies used here are main\'s riyeser/*.py byte for byte (when main is available)', (t) => {
  const root = path.join(__dirname, '..', '..');
  for (const f of ['licence', 'signed_licence', 'ed25519']) {
    let mainCopy = null;
    for (const ref of ['origin/main', 'main']) {
      const r = spawnSync('git', ['show', `${ref}:riyeser/${f}.py`], { cwd: root, encoding: 'utf8' });
      if (r.status === 0) { mainCopy = r.stdout; break; }
    }
    if (mainCopy == null) { t.skip('main is not in this checkout'); return; }
    assert.strictEqual(fs.readFileSync(path.join(ACCOUNTING, 'riyeser', `${f}.py`), 'utf8'), mainCopy, `${f}.py differs from main: copy it again`);
  }
  if (!python()) t.diagnostic('Python not found: the Accounting checks were skipped');
});
