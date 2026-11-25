// S11: Central's sign-in asks for the two-step code when the account has a verified authenticator app
// (Supabase mfa.challenge / mfa.verify, by REST), and only the AAL2 session from the code is ever saved.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const on = require('../src/core/online');
const { Store } = require('../src/core/store');

function server({ factors = [] } = {}) {
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : null; calls.push({ path: u.pathname, body, auth: (opts.headers || {}).Authorization });
    if (u.href.startsWith(on.CONFIG_URL)) return res(200, 'window.RIYESER_TEAM={supabaseUrl:"https://x.supabase.co",supabaseKey:"sb_publishable_k"};');
    if (u.pathname === '/auth/v1/token') {
      return body.password === 'right-password'
        ? res(200, { access_token: 'aal1-token', refresh_token: 'r1', expires_in: 3600, user: { id: 'u1', email: body.email, factors } })
        : res(400, { error_description: 'Invalid login credentials' });
    }
    if (u.pathname === '/auth/v1/factors/f-1/challenge') return opts.headers.Authorization === 'Bearer aal1-token' ? res(200, { id: 'ch-9', type: 'totp', expires_at: 9e9 }) : res(401, { msg: 'no' });
    if (u.pathname === '/auth/v1/factors/f-1/verify') {
      if (opts.headers.Authorization !== 'Bearer aal1-token' || body.challenge_id !== 'ch-9') return res(401, { msg: 'no' });
      return body.code === '123456'
        ? res(200, { access_token: 'aal2-token', refresh_token: 'r2', expires_in: 3600, user: { id: 'u1', email: 'owner@sample.test', factors } })
        : res(422, { msg: 'Invalid TOTP code entered' });
    }
    return res(404, {});
  };
  return { fetchFn, calls };
}
const make = (opts) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfa-'));
  const srv = server(opts); const store = new Store(path.join(dir, 'data'));
  return { srv, store, o: new on.Online({ store, fetchFn: srv.fetchFn, appData: dir }) };
};
const TOTP = [{ id: 'f-1', factor_type: 'totp', status: 'verified', friendly_name: 'Phone' }];

test('S11: no two-step sign-in -> signed in straight away, as before', async () => {
  const { o, srv } = make();
  assert.deepStrictEqual(await o.signIn('owner@sample.test', 'right-password'), { email: 'owner@sample.test' });
  assert.strictEqual(o.session.access_token, 'aal1-token');
  assert.ok(!srv.calls.some((c) => /factors/.test(c.path)));
});

test('S11: an unverified (half set up) factor doesn\'t ask for a code', async () => {
  const { o } = make({ factors: [{ id: 'f-1', factor_type: 'totp', status: 'unverified' }] });
  assert.ok(!(await o.signIn('owner@sample.test', 'right-password')).needsCode);
  assert.ok(o.session);
});

test('S11: with a verified authenticator app, the password alone signs nobody in; the code does (challenge + verify)', async () => {
  const { o, srv, store } = make({ factors: TOTP });
  const r = await o.signIn('owner@sample.test', 'right-password');
  assert.deepStrictEqual(r, { email: 'owner@sample.test', needsCode: true });
  assert.strictEqual(o.session, null, 'not signed in before the code');
  assert.doesNotMatch(JSON.stringify(store.get('online', {})), /aal1-token/, 'the password-only session is never saved');
  await assert.rejects(o.verifyCode('12'), /6-digit code/);
  await assert.rejects(o.verifyCode('654321'), /That code isn't right/);
  assert.strictEqual(o.session, null);
  await o.verifyCode('123 456');
  assert.strictEqual(o.session.access_token, 'aal2-token');
  assert.strictEqual(o.session.user.email, 'owner@sample.test');
  const ch = srv.calls.filter((c) => c.path === '/auth/v1/factors/f-1/challenge');
  const vf = srv.calls.filter((c) => c.path === '/auth/v1/factors/f-1/verify');
  assert.ok(ch.length >= 1 && vf.length >= 1);
  assert.deepStrictEqual(vf[vf.length - 1].body, { challenge_id: 'ch-9', code: '123456' });
  assert.ok(vf.every((c) => c.auth === 'Bearer aal1-token'));
  await assert.rejects(o.verifyCode('123456'), /Sign in again/);   // used once only
});

test('S11: Central\'s sign-in form shows the code step, and Central and Link Office handle it', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  assert.match(src('renderer/company.js'), /r\.needsCode\) return showCode/);
  assert.match(src('renderer/company.js'), /company:verifyCode/);
  assert.match(src('central-main.js'), /handle\('company:verifyCode'/);
  assert.match(src('link-main.js'), /needsCode/);
});
