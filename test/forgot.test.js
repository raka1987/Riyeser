// "Forgot password?": the emailed code (a pretend mail server) and the business owner's Riyeser account (a pretend
// Riyeser Online / Supabase Auth). Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const PORT = 3994;
const B = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-forgot-'));
const APPDATA = path.join(DATA_DIR, 'appdata');
const COMPANY = path.join(APPDATA, 'Riyeser', 'company.json');
const WS = '11111111-2222-3333-4444-555555555555';
let server, smtp, online, mails = [], onlineCalls = [];

async function call(method, url, body, cookie, ip = '10.0.0.1') {
  const res = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function login(username, password, ip) {
  const r = await call('POST', '/api/auth/login', { username, password }, null, ip);
  assert.equal(r.status, 200, `login ${username} failed: ${JSON.stringify(r.data)}`);
  return r.cookie;
}
const waitFor = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } return null; };

// ---- a pretend Riyeser Online: three accounts, one with two-step sign-in
const jwt = o => `h.${Buffer.from(JSON.stringify(o)).toString('base64url')}.s`;
const ACCOUNTS = {
  'owner@biz.test': { pw: 'ownerpass1', id: 'u-owner', members: [{ workspace_id: WS, role: 'owner' }] },
  'mfa@biz.test': { pw: 'mfapass123', id: 'u-mfa', factor: 'f-1', members: [{ workspace_id: WS, role: 'owner' }] },
  'admin@biz.test': { pw: 'adminpass1', id: 'u-admin', members: [{ workspace_id: WS, role: 'admin' }] },
  'other@biz.test': { pw: 'otherpass1', id: 'u-other', members: [{ workspace_id: 'another-business', role: 'owner' }] },
};
const byId = id => Object.values(ACCOUNTS).find(a => a.id === id);
function fakeOnline(req, res) {
  let body = ''; req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, 'http://x'), b = body ? JSON.parse(body) : {};
    onlineCalls.push({ path: u.pathname, apikey: req.headers.apikey });
    if (req.headers.apikey !== 'test-key') return send(401, { message: 'No API key found in request' });
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, ''); let who = null; try { who = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url')); } catch { }
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
      const a = ACCOUNTS[b.email];
      if (!a || a.pw !== b.password) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      return send(200, { access_token: jwt({ sub: a.id, aal: 'aal1' }), refresh_token: 'r', user: { id: a.id, email: b.email, factors: a.factor ? [{ id: a.factor, factor_type: 'totp', status: 'verified' }] : [] } });
    }
    const f = /^\/auth\/v1\/factors\/([^/]+)\/(challenge|verify)$/.exec(u.pathname);
    if (f && who) {
      if (f[2] === 'challenge') return send(200, { id: 'ch-1' });
      if (b.challenge_id !== 'ch-1' || b.code !== '246810') return send(422, { code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' });
      return send(200, { access_token: jwt({ sub: who.sub, aal: 'aal2' }), refresh_token: 'r2', user: { id: who.sub } });
    }
    if (u.pathname === '/rest/v1/members' && who) {
      const a = byId(who.sub); const ws = (u.searchParams.get('workspace_id') || '').replace(/^eq\./, ''), uid = (u.searchParams.get('user_id') || '').replace(/^eq\./, '');
      if (uid !== who.sub) return send(200, []);   // the row rules: your own rows
      return send(200, (a ? a.members : []).filter(m => m.workspace_id === ws));
    }
    send(404, { message: 'not found' });
  });
}

before(async () => {
  smtp = net.createServer(sock => { let data = false, buf = '', msg = ''; sock.write('220 t\r\n');
    sock.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data) { if (l === '.') { data = false; mails.push(msg); msg = ''; sock.write('250 OK\r\n'); } else msg += l + '\n'; continue; }
      const c4 = l.slice(0, 4).toUpperCase();
      if (c4 === 'EHLO' || c4 === 'HELO') sock.write('250-t\r\n250 AUTH PLAIN\r\n');
      else if (c4 === 'DATA') { data = true; sock.write('354 go\r\n'); } else if (c4 === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 OK\r\n'); } }); });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  online = http.createServer(fakeOnline); await new Promise(r => online.listen(0, '127.0.0.1', r));
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR, APPDATA, ADMIN_PASSWORD: 'AdminPass123', TRUST_PROXY: '1', RIYESER_DEMO_FILE: path.join(DATA_DIR, 'no-demo.json'), RIYESER_DEMO: '',
      RIYESER_DOCS: path.join(DATA_DIR, 'docs'), DESKTOP: '', RIYESER_ONLINE_URL: `http://127.0.0.1:${online.address().port}`, RIYESER_ONLINE_KEY: 'test-key' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/public/info'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('Server did not start');
});
after(async () => {
  smtp.close(); online.close();
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000); });
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { }
});

let admin, jo;
const codeIn = m => (/password reset code: (\d{6})/.exec(m) || [])[1];

test('forgot password: what the sign-in screen offers', async () => {
  admin = await login('admin', 'AdminPass123');
  let o = (await call('GET', '/api/auth/forgot')).data;
  assert.equal(o.email, false); assert.equal(o.owner_linked, false);
  assert.match(o.not_linked, /Sign in to Riyeser Central on this PC first, then try again/);
  // no email set up: asking for a code says so plainly
  const r = await call('POST', '/api/auth/forgot/email', { who: 'admin' });
  assert.equal(r.status, 400); assert.match(r.data.error, /Email isn't set up/);
  await call('PUT', '/api/staff/email', { email_enabled: '1', smtp_host: '127.0.0.1', smtp_port: String(smtp.address().port), smtp_secure: 'none', email_from: 'payroll@club.test' }, admin);
  o = (await call('GET', '/api/auth/forgot')).data;
  assert.equal(o.email, true);
});

test('emailed code: sent to the person, works once, signs out other sessions, clears the PIN lockout', async () => {
  jo = (await call('POST', '/api/staff/employees', { name: 'Jo Bloggs', username: 'jo', password: 'jopass123', role: 'staff', pay_type: 'hourly', pay_rate: 10, email: 'jo@club.test' }, admin)).data;
  const joSession = await login('jo', 'jopass123');
  // 10 wrong PINs lock Jo's time-clock PIN
  for (let i = 0; i < 10; i++) await call('POST', '/api/staff/timeclock/punch', { user_id: jo.id, pin: '0000' === jo.clock_pin ? '1111' : '0000' }, admin);
  assert.equal((await call('POST', '/api/staff/timeclock/punch', { user_id: jo.id, pin: '9' }, admin)).status, 429);

  const r = await call('POST', '/api/auth/forgot/email', { who: 'JO' }, null, '10.0.1.1');
  assert.equal(r.status, 200); assert.match(r.data.message, /If that matches a person with an email address, we've sent/);
  const mail = await waitFor(() => mails.find(m => /jo@club\.test/.test(m)));
  assert.ok(mail, 'the code was emailed'); const code = codeIn(mail); assert.ok(code);

  // wrong code, short password, passwords that don't match: refused, and the code still works after
  const ip = '10.0.1.2';
  const wrong = String((+code + 1) % 1e6).padStart(6, '0');
  let x = await call('POST', '/api/auth/forgot/email/reset', { who: 'jo', code: wrong, password: 'newjopass1', password2: 'newjopass1' }, null, ip);
  assert.equal(x.status, 400); assert.match(x.data.error, /isn't right, or it has expired/);
  assert.match((await call('POST', '/api/auth/forgot/email/reset', { who: 'jo', code, password: 'short', password2: 'short' }, null, ip)).data.error, /at least 8 characters/);
  assert.match((await call('POST', '/api/auth/forgot/email/reset', { who: 'jo', code, password: 'newjopass1', password2: 'newjopass2' }, null, ip)).data.error, /don't match/);
  // by email address works too
  x = await call('POST', '/api/auth/forgot/email/reset', { who: 'jo@club.test', code, password: 'newjopass1', password2: 'newjopass1' }, null, ip);
  assert.equal(x.status, 200, JSON.stringify(x.data)); assert.equal(x.data.username, 'jo');
  // single use
  x = await call('POST', '/api/auth/forgot/email/reset', { who: 'jo', code, password: 'another12', password2: 'another12' }, null, ip);
  assert.equal(x.status, 400);
  // Jo's old session is signed out; the new password works, the old one doesn't
  assert.equal((await call('GET', '/api/auth/me', null, joSession)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'jo', password: 'jopass123' }, null, ip)).status, 401);
  await login('jo', 'newjopass1', ip);
  // the PIN lockout was cleared: a wrong PIN is just wrong again (403), not "too many" (429)
  assert.equal((await call('POST', '/api/staff/timeclock/punch', { user_id: jo.id, pin: '9' }, admin)).status, 403);
  // the audit trail
  const a = (await call('GET', '/api/staff/audit', null, admin)).data.find(e => e.action === 'Password reset with an emailed code');
  assert.ok(a); assert.match(a.details, /Jo Bloggs \(jo\)/);
});

test('emailed code: no user enumeration, 3 codes an hour per person, 5 wrong tries lock it', async () => {
  const before = mails.length;
  const yes = await call('POST', '/api/auth/forgot/email', { who: 'jo' }, null, '10.0.2.1');
  const no = await call('POST', '/api/auth/forgot/email', { who: 'nobody-here' }, null, '10.0.2.1');
  const noMail = await call('POST', '/api/auth/forgot/email', { who: 'admin' }, null, '10.0.2.1');   // admin has no email address
  assert.deepEqual([yes.status, yes.data], [no.status, no.data]); assert.deepEqual(no.data, noMail.data);
  await waitFor(() => mails.length >= before + 1);
  // a wrong code reads the same for a real and an unknown username
  const ip = '10.0.2.2';
  const real = await call('POST', '/api/auth/forgot/email/reset', { who: 'jo', code: '000000', password: 'whatever1', password2: 'whatever1' }, null, ip);
  const fake = await call('POST', '/api/auth/forgot/email/reset', { who: 'nobody-here', code: '000000', password: 'whatever1', password2: 'whatever1' }, null, ip);
  assert.deepEqual([real.status, real.data], [fake.status, fake.data]);
  // Jo has had 2 codes this hour: the 3rd is sent, the 4th isn't (and the answer is the same)
  await call('POST', '/api/auth/forgot/email', { who: 'jo' }, null, '10.0.2.3');
  assert.ok(await waitFor(() => mails.filter(m => /jo@club\.test/.test(m)).length === 3));
  const fourth = await call('POST', '/api/auth/forgot/email', { who: 'jo' }, null, '10.0.2.3');
  assert.deepEqual(fourth.data, yes.data);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(mails.filter(m => /jo@club\.test/.test(m)).length, 3, 'no 4th code in an hour');
  const code = codeIn(mails.filter(m => /jo@club\.test/.test(m)).pop());
  // 5 wrong codes: the right one no longer works either
  for (let i = 0; i < 4; i++) await call('POST', '/api/auth/forgot/email/reset', { who: 'jo', code: code === '999999' ? '999998' : '999999', password: 'whatever1', password2: 'whatever1' }, null, '10.0.2.4');
  const locked = await call('POST', '/api/auth/forgot/email/reset', { who: 'jo', code, password: 'whatever1', password2: 'whatever1' }, null, '10.0.2.4');
  assert.equal(locked.status, 429); assert.match(locked.data.error, /Too many wrong codes/);
  // and the same for a username that doesn't exist
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/forgot/email/reset', { who: 'ghost', code: '123456', password: 'whatever1', password2: 'whatever1' }, null, '10.0.2.5');
  assert.equal((await call('POST', '/api/auth/forgot/email/reset', { who: 'ghost', code: '123456', password: 'whatever1', password2: 'whatever1' }, null, '10.0.2.5')).status, 429);
  // the per-device limit on asking for codes
  let last; for (let i = 0; i < 11; i++) last = await call('POST', '/api/auth/forgot/email', { who: 'x' + i }, null, '10.0.2.6');
  assert.equal(last.status, 429);
});

test('owner recovery: a PC that isn\'t linked to a business says to sign in to Central first', async () => {
  const r = await call('POST', '/api/auth/forgot/owner/start', { email: 'owner@biz.test', password: 'ownerpass1' }, null, '10.0.3.1');
  assert.equal(r.status, 409); assert.match(r.data.error, /Sign in to Riyeser Central on this PC first, then try again/);
  assert.equal(onlineCalls.length, 0, 'nothing was sent to Riyeser');
  // a PC set up on its own (not online) is the same
  fs.mkdirSync(path.dirname(COMPANY), { recursive: true });
  fs.writeFileSync(COMPANY, JSON.stringify({ mode: 'local', name: 'Sample Trading Co' }));
  assert.equal((await call('POST', '/api/auth/forgot/owner/start', { email: 'owner@biz.test', password: 'ownerpass1' }, null, '10.0.3.1')).status, 409);
  fs.writeFileSync(COMPANY, JSON.stringify({ mode: 'online', name: 'Sample Trading Co', company_code: 'RYS-ABCD', workspace_id: WS }));
  const o = (await call('GET', '/api/auth/forgot')).data;
  assert.equal(o.owner_linked, true); assert.equal(o.business, 'Sample Trading Co');
});

test('owner recovery: wrong password, a non-owner and another business\'s owner are refused', async () => {
  const ip = '10.0.4.1';
  let r = await call('POST', '/api/auth/forgot/owner/start', { email: 'owner@biz.test', password: 'wrong-password' }, null, ip);
  assert.equal(r.status, 401); assert.match(r.data.error, /That email or password isn't right/);
  assert.equal(onlineCalls.at(-1).apikey, 'test-key');
  r = await call('POST', '/api/auth/forgot/owner/start', { email: 'admin@biz.test', password: 'adminpass1' }, null, ip);
  assert.equal(r.status, 403); assert.match(r.data.error, /isn't the owner of Sample Trading Co/); assert.equal(r.data.admins, undefined);
  r = await call('POST', '/api/auth/forgot/owner/start', { email: 'other@biz.test', password: 'otherpass1' }, null, ip);
  assert.equal(r.status, 403);
  // a made-up ticket can't reset anything
  r = await call('POST', '/api/auth/forgot/owner/reset', { ticket: 'made-up', user_id: 1, password: 'hackedpass1', password2: 'hackedpass1' }, null, ip);
  assert.equal(r.status, 401);
  await login('admin', 'AdminPass123', ip);
});

test('owner recovery: two-step code is required when the account has one', async () => {
  const ip = '10.0.5.1';
  const s = await call('POST', '/api/auth/forgot/owner/start', { email: 'mfa@biz.test', password: 'mfapass123' }, null, ip);
  assert.equal(s.status, 200); assert.equal(s.data.needs_code, true); assert.equal(s.data.admins, undefined);
  // skipping the code: refused
  let r = await call('POST', '/api/auth/forgot/owner/reset', { ticket: s.data.ticket, user_id: 1, password: 'mfanewpass1', password2: 'mfanewpass1' }, null, ip);
  assert.equal(r.status, 403); assert.match(r.data.error, /two-step code/);
  r = await call('POST', '/api/auth/forgot/owner/code', { ticket: s.data.ticket, code: '111111' }, null, ip);
  assert.equal(r.status, 401); assert.match(r.data.error, /code isn't right/);
  r = await call('POST', '/api/auth/forgot/owner/code', { ticket: s.data.ticket, code: '246 810' }, null, ip);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.admins[0].username, 'admin');
  assert.ok(onlineCalls.some(c => /\/factors\/f-1\/verify$/.test(c.path)));
  r = await call('POST', '/api/auth/forgot/owner/reset', { ticket: s.data.ticket, user_id: r.data.admins[0].id, password: 'mfanewpass1', password2: 'mfanewpass1' }, null, ip);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = (await call('GET', '/api/staff/audit', null, await login('admin', 'mfanewpass1', ip))).data[0];
  assert.equal(a.action, 'Password reset by the business owner through their Riyeser account'); assert.equal(a.user_name, 'Business owner (mfa@biz.test)');
});

test('owner recovery: a confirmed owner sets a new Super admin password; signed out elsewhere, lockout cleared, audit entry', async () => {
  const ip = '10.0.6.1';
  // the admin is locked out: 10 wrong passwords from this PC
  for (let i = 0; i < 10; i++) await call('POST', '/api/auth/login', { username: 'admin', password: 'guess' + i }, null, ip);
  assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'AdminPass123' }, null, ip)).status, 429);
  const s = await call('POST', '/api/auth/forgot/owner/start', { email: 'owner@biz.test', password: 'ownerpass1' }, null, ip);
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.business, 'Sample Trading Co');
  const main = s.data.admins.find(a => a.main); assert.equal(main.username, 'admin');
  // only Super admin logins can be chosen
  let r = await call('POST', '/api/auth/forgot/owner/reset', { ticket: s.data.ticket, user_id: jo.id, password: 'ownernew12', password2: 'ownernew12' }, null, ip);
  assert.equal(r.status, 400); assert.match(r.data.error, /Choose the Super admin login/);
  r = await call('POST', '/api/auth/forgot/owner/reset', { ticket: s.data.ticket, user_id: main.id, password: 'short', password2: 'short' }, null, ip);
  assert.match(r.data.error, /at least 8 characters/);
  r = await call('POST', '/api/auth/forgot/owner/reset', { ticket: s.data.ticket, user_id: main.id, password: 'ownernew12', password2: 'ownernew13' }, null, ip);
  assert.match(r.data.error, /don't match/);
  r = await call('POST', '/api/auth/forgot/owner/reset', { ticket: s.data.ticket, user_id: main.id, password: 'ownernew12', password2: 'ownernew12' }, null, ip);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.username, 'admin');
  // the ticket worked once
  assert.equal((await call('POST', '/api/auth/forgot/owner/reset', { ticket: s.data.ticket, user_id: main.id, password: 'again12345', password2: 'again12345' }, null, ip)).status, 401);
  // the old session is signed out; the lockout on this PC is cleared; the new password works
  assert.equal((await call('GET', '/api/auth/me', null, admin)).status, 401);
  admin = await login('admin', 'ownernew12', ip);
  const a = (await call('GET', '/api/staff/audit', null, admin)).data.find(e => e.action === 'Password reset by the business owner through their Riyeser account');
  assert.ok(a, 'audit entry');
  assert.equal(a.user_name, 'Business owner (owner@biz.test)'); assert.match(a.details, /Administrator \(admin\)/);
});

test('an administrator resetting someone\'s password signs them out everywhere', async () => {
  const joSession = await login('jo', 'newjopass1', '10.0.7.1');
  await call('PUT', `/api/staff/employees/${jo.id}`, { password: 'byadmin123' }, admin);
  assert.equal((await call('GET', '/api/auth/me', null, joSession)).status, 401);
  await login('jo', 'byadmin123', '10.0.7.1');
});
