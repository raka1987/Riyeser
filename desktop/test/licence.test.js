const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const lic = require('../src/core/licence');
const DAY = 86400000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
const t0 = Date.parse('2027-02-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// A stand-in Riyeser server: signs passes with a test key, the same way the Supabase "plan" function does.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const c = { url: 'https://test.supabase.co', anonKey: 'anon', passPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
const sign = (pass) => { const body = JSON.stringify(pass); return { pass: body, sig: crypto.sign(null, Buffer.from(body), privateKey).toString('base64') }; };
const passFor = (products, now = t0, extra = {}) => ({ v: 1, account: 'acc-1', email: 'a@b.c', products, extraCompanies: 0, extraUsers: 0,
  caps: { basic: 50, pos: 500, payroll: 4, asbuilt: 3, plusTrialDays: 90, warnAt: 0.8 }, issuedAt: iso(now), validUntil: iso(now + 30 * DAY), ...extra });
function server(products, log = []) {
  return async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : {}; log.push({ url, body, auth: opts.headers.Authorization });
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url.endsWith('/auth/v1/otp')) return ok({});
    if (url.endsWith('/auth/v1/verify')) return body.token === '123456' ? ok({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { email: body.email } }) : { ok: false, status: 403, json: async () => ({ msg: 'Token has expired or is invalid' }) };
    if (url.includes('/auth/v1/token')) return ok({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 });
    if (url.endsWith('/functions/v1/plan')) return ok(sign(passFor(typeof products === 'function' ? products() : products)));
    if (url.endsWith('/functions/v1/checkout')) return ok({ url: 'https://riyeser.com/pay.html?_ptxn=txn_1' });
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('plan: before Riyeser accounts exist, everything is free / trial and sign-in says coming soon', async () => {
  const dir = tmp(); const none = { url: '', anonKey: '', passPublicKey: '' };
  const s = lic.status(dir, t0, none);
  assert.equal(s.mode, 'trial'); assert.equal(s.daysLeft, 90); assert.equal(s.configured, false); assert.equal(s.caps.basic, 50);
  assert.equal(lic.status(dir, t0 + 91 * DAY, none).mode, 'free');
  await assert.rejects(lic.startSignIn(dir, 'a@b.c', { c: none }), /coming soon/);
  assert.ok(lic.read(dir).deviceId, 'a random id for this PC');
});

test('plan: sign in with an email code, then the paid programs come from the signed pass', async () => {
  const dir = tmp(); const log = [];
  const fetchFn = server({ basics: { paid: true, status: 'active', until: iso(t0 + 20 * DAY), warning: null } }, log);
  await assert.rejects(lic.startSignIn(dir, 'not-an-email', { fetchFn, c }), /doesn't look like/);
  assert.deepEqual(await lic.startSignIn(dir, ' A@B.c ', { fetchFn, c }), { sent: true, email: 'a@b.c' });
  await assert.rejects(lic.finishSignIn(dir, 'a@b.c', '999999', { fetchFn, c, now: t0 }), /didn't work/);
  const s = await lic.finishSignIn(dir, 'a@b.c', '123 456', { fetchFn, c, now: t0 });
  assert.equal(s.mode, 'licensed'); assert.equal(s.plan, 'Accounting Basics'); assert.equal(s.signedIn, true); assert.equal(s.email, 'a@b.c');
  assert.equal(s.products.basics.paid, true);
  const planCall = log.find((l) => l.url.endsWith('/functions/v1/plan'));
  assert.equal(planCall.auth, 'Bearer at'); assert.equal(planCall.body.device.id, lic.read(dir).deviceId);
  // Accounting / POS (Python) read these fields and keep working unchanged
  const f = lic.read(dir);
  assert.equal(f.key, 'riyeser-account'); assert.equal(f.licence.status, 'active'); assert.equal(f.products.basics.paid, true); assert.equal(f.caps.pos, 500);
  // tokens are kept apart from licence.json
  assert.ok(!JSON.stringify(f).includes('"rt"') && !('refreshToken' in f)); assert.ok(fs.existsSync(lic.accountFile(dir)));
  // the paid period runs out with no renewal
  assert.equal(lic.status(dir, t0 + 21 * DAY, c).products.basics.paid, false);
});

test('plan: a pass edited by hand on the PC is ignored', async () => {
  const dir = tmp();
  await lic.finishSignIn(dir, 'a@b.c', '123456', { fetchFn: server({}), c, now: t0 });
  assert.notEqual(lic.status(dir, t0, c).mode, 'licensed');
  const d = lic.read(dir); d.signed.pass = d.signed.pass.replace('"products":{}', '"products":{"pos":{"paid":true}}');
  fs.writeFileSync(lic.licenceFile(dir), JSON.stringify(d));
  assert.equal(lic.status(dir, t0, c).products.pos, undefined);
  assert.equal(lic.status(dir, t0, c).mode, 'trial');
});

test('plan: nothing paid leaves Accounting on its trial and free allowances', async () => {
  const dir = tmp();
  await lic.finishSignIn(dir, 'a@b.c', '123456', { fetchFn: server({}), c, now: t0 });
  const f = lic.read(dir);
  assert.equal(f.key, undefined); assert.equal(f.licence, undefined); assert.equal(f.caps.basic, 50);
});

test('plan: works offline for 30 days, then asks to connect; a failed card shows a warning', async () => {
  const dir = tmp(); let products = { pos: { paid: true, status: 'active', until: iso(t0 + 300 * DAY) } };
  await lic.finishSignIn(dir, 'a@b.c', '123456', { fetchFn: server(() => products), c, now: t0 });
  const offline = async () => { throw new Error('offline'); };
  assert.equal((await lic.recheck(dir, { fetchFn: offline, c, now: t0 + 10 * DAY })).mode, 'licensed');
  assert.match(lic.status(dir, t0 + 25 * DAY, c).message, /within 5 day/);
  const late = lic.status(dir, t0 + 31 * DAY, c);
  assert.equal(late.mode, 'expired'); assert.equal(late.products.pos.paid, false); assert.equal(late.needsCheck, true);
  products = { pos: { paid: true, status: 'past_due', until: iso(t0 + 14 * DAY), warning: 'payment_failed' } };
  const back = await lic.recheck(dir, { fetchFn: server(() => products), c, now: t0 });
  assert.equal(back.mode, 'licensed'); assert.match(back.message, /didn't go through/);
});

test('plan: subscribe opens checkout only when signed in; sign out keeps the trial date', async () => {
  const dir = tmp();
  await assert.rejects(lic.checkout(dir, [{ product: 'basics' }], { fetchFn: server({}), c }), /Sign in first/);
  await lic.finishSignIn(dir, 'a@b.c', '123456', { fetchFn: server({ basics: { paid: true, until: iso(t0 + 9 * DAY) } }), c, now: t0 });
  assert.equal(await lic.checkout(dir, [{ product: 'pos' }], { fetchFn: server({}), c }), 'https://riyeser.com/pay.html?_ptxn=txn_1');
  const start = lic.read(dir).trialStart;
  const out = lic.signOut(dir, t0);
  assert.equal(out.signedIn, false); assert.equal(lic.read(dir).trialStart, start); assert.equal(lic.read(dir).key, undefined);
  assert.ok(!fs.existsSync(lic.accountFile(dir)));
});

test('plan: a sealed sign-in round-trips through the seal box', async () => {
  const dir = tmp(); const box = { seal: (s) => `x:${Buffer.from(s).toString('base64')}`, unseal: (s) => Buffer.from(s.slice(2), 'base64').toString() };
  await lic.finishSignIn(dir, 'a@b.c', '123456', { fetchFn: server({}), c, box, now: t0 });
  assert.ok(!fs.readFileSync(lic.accountFile(dir), 'utf8').includes('"rt"'));
  assert.ok(await lic.checkout(dir, [{ product: 'pos' }], { fetchFn: server({}), c, box }));
});
