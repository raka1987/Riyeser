// Passwords, email links and two-step set-up against a pretend Supabase that keeps the account's password (F17, F1, F2, S6):
//   F17 the "Reset your password" link asks for a new password (twice); afterwards the old one fails and the new one works,
//       and other devices are signed out; a signed-in person can change their password (current one checked, code when 2FA is on)
//   F1  a "Confirm your email" link (#access_token=…&type=signup) shows "Email confirmed", then carries on; an expired link says so
//   F2  "email rate limit exceeded" from Supabase shows a plain message with info@riyeser.com instead
//   S6  "Turn on two-step sign-in" works with one click right after the page loads, again after Later, and a page that signed in
//       before it was turned on elsewhere catches up with one code.
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/password-test.js`. Exits 1 on failure.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeServer(acct) {
  // acct: { user, password, factors: [], aal, recoverCalls, logouts: [], puts: [], enrolls: [] }
  const token = (aal) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: acct.user.id, aal, amr: [{ method: 'password', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
  acct.token = token;
  const session = (aal) => ({ access_token: token(aal), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { ...acct.user, factors: acct.factors } });
  return async (r) => {
    const u = new URL(r.request().url()); const m = r.request().method();
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const body = () => { try { return JSON.parse(r.request().postData() || '{}'); } catch { return {}; } };
    if (u.pathname === '/auth/v1/token') {
      if (u.searchParams.get('grant_type') === 'refresh_token') return json(session(acct.aal || 'aal1'));
      if (body().password !== acct.password) return json({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
      return json(session('aal1'));
    }
    if (u.pathname === '/auth/v1/user' && m === 'PUT') { const bd = body(); acct.puts.push(bd); if (bd.password) acct.password = bd.password; return json({ ...acct.user, factors: acct.factors }); }
    if (u.pathname === '/auth/v1/user') return json({ ...acct.user, factors: acct.factors });
    if (u.pathname === '/auth/v1/logout') { acct.logouts.push(u.searchParams.get('scope') || 'global'); return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } }); }
    if (u.pathname === '/auth/v1/recover') { acct.recoverCalls = (acct.recoverCalls || 0) + 1;
      if (acct.recoverCalls > 1) return json({ code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }, 429); return json({}); }
    if (u.pathname === '/auth/v1/signup') return json({ code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }, 429);
    if (u.pathname === '/auth/v1/factors' && m === 'POST') { const bd = body(); acct.enrolls.push(bd.friendly_name);
      if (acct.factors.some((f) => f.friendly_name === bd.friendly_name)) return json({ code: 422, error_code: 'mfa_factor_name_conflict', msg: `A factor with the friendly name "${bd.friendly_name}" for this user already exists` }, 422);
      const f = { id: 'f' + (acct.factors.length + 10), factor_type: 'totp', status: 'unverified', friendly_name: bd.friendly_name }; acct.factors.push(f);
      return json({ id: f.id, type: 'totp', friendly_name: f.friendly_name, totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg"/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://x' } }); }
    const fm = u.pathname.match(/^\/auth\/v1\/factors\/([^/]+)(\/challenge|\/verify)?$/);
    if (fm && m === 'DELETE') { acct.factors = acct.factors.filter((f) => f.id !== fm[1]); acct.deletes = (acct.deletes || 0) + 1; return json({ id: fm[1] }); }
    if (fm && fm[2] === '/challenge') return json({ id: 'ch1', type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
    if (fm && fm[2] === '/verify') { if (body().code !== '246810') return json({ code: 422, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }, 422);
      const f = acct.factors.find((x) => x.id === fm[1]); if (f) f.status = 'verified'; acct.aal = 'aal2'; return json(session('aal2')); }
    if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2' } }]);
    if (u.pathname === '/rest/v1/members') return json([{ user_id: acct.user.id, display_name: 'Alex', role: 'owner', job_role: 'owner', extension: 101 }]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    if (u.pathname === '/rest/v1/rpc/my_billing') return json(null);
    return json([]);
  };
}
async function page(b, acct, errs, tag) {
  const pg = await b.newPage({ viewport: { width: 1200, height: 850 } });
  pg.on('pageerror', (e) => errs.push(tag + ': ' + e.message));
  await pg.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  await pg.route('https://fake.supabase.test/**', fakeServer(acct));
  await pg.route('**/functions/v1/paypal/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ready":false}' }));
  return pg;
}
const newAcct = (extra = {}) => ({ user: { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', aud: 'authenticated', role: 'authenticated' }, password: 'old-password-1', factors: [], logouts: [], puts: [], enrolls: [], ...extra });
const linkHash = (acct, type) => `#access_token=${acct.token('aal1')}&expires_at=${Math.floor(Date.now() / 1000) + 3600}&expires_in=3600&refresh_token=r&token_type=bearer&type=${type}`;
async function signIn(pg, email, pw) {
  await pg.goto(BASE + '/link/'); await pg.evaluate(() => localStorage.clear()); await pg.reload(); await pg.waitForSelector('#gf');
  await pg.fill('#gf input[name=email]', email); await pg.fill('#gf input[name=password]', pw); await pg.click('#gf button[type=submit]');
  return Promise.race([pg.waitForSelector('.hco', { timeout: 8000 }).then(() => 'in'), pg.waitForSelector('#gf .err', { timeout: 8000 }).then(async () => 'error: ' + await pg.textContent('#gf .err'))]);
}

(async () => {
  const b = await chromium.launch(); const errs = [];

  // ---- F2: the second reset email hits Supabase's limit
  { const acct = newAcct(); fakeServer(acct); const pg = await page(b, acct, errs, 'F2');
    await pg.goto(BASE + '/link/'); await pg.waitForSelector('#gf');
    await pg.click('[data-go=reset]'); await pg.fill('#gf input[name=email]', 'owner@sample.test'); await pg.click('#gf button[type=submit]');
    await pg.waitForSelector('#gf .ok'); check(/Check your email/.test(await pg.textContent('#gf .ok')), 'F2 first reset email: "Check your email for the link."');
    await pg.click('[data-go=reset]'); await pg.fill('#gf input[name=email]', 'owner@sample.test'); await pg.click('#gf button[type=submit]');
    await pg.waitForSelector('#gf .err'); const t = await pg.textContent('#gf .err');
    check(/couldn't send the email just now/.test(t) && /info@riyeser\.com/.test(t) && !/rate limit/i.test(t), 'F2 rate limit on reset -> ' + t);
    check(await pg.inputValue('#gf input[name=email]') === 'owner@sample.test', 'F2 the typed email stays in the box');
    await pg.click('[data-go=in]'); await pg.click('[data-go=up]'); await pg.fill('#gf input[name=you]', 'Alex'); await pg.fill('#gf input[name=email]', 'new@sample.test');
    await pg.fill('#gf input[name=password]', 'abcdefgh1'); await pg.fill('#gf input[name=password2]', 'abcdefgh1'); await pg.click('#gf button[type=submit]');
    await pg.waitForSelector('#gf .err'); const t2 = await pg.textContent('#gf .err');
    check(/couldn't send the email just now/.test(t2) && !/rate limit/i.test(t2), 'F2 rate limit on sign-up -> ' + t2);
    await pg.close(); }

  // ---- F17: the reset link -> choose a new password; the old one fails, the new one works
  { const acct = newAcct(); fakeServer(acct); const pg = await page(b, acct, errs, 'F17');
    await pg.goto(BASE + '/link/' + linkHash(acct, 'recovery'));
    await pg.waitForSelector('#npf', { timeout: 10000 }); check(/Choose a new password/.test(await pg.textContent('#npf h1')), 'F17 reset link shows "Choose a new password"');
    check(!(await pg.evaluate(() => location.hash.includes('access_token'))), 'F17 the sign-in details are cleared from the address');
    await pg.fill('#npf [name=password]', 'new-password-2'); await pg.fill('#npf [name=password2]', 'new-password-3'); await pg.click('#npf button[type=submit]');
    await pg.waitForSelector('#npf .err'); check(/don't match/.test(await pg.textContent('#npf .err')), 'F17 two different passwords are refused');
    await pg.fill('#npf [name=password]', 'short'); await pg.fill('#npf [name=password2]', 'short'); await pg.click('#npf button[type=submit]');
    await pg.waitForTimeout(300); check(!acct.puts.length && await pg.$eval('#npf [name=password]', (i) => i.validity.tooShort || !i.checkValidity()), 'F17 a short password is refused (at least 8)');
    await pg.fill('#npf [name=password]', 'new-password-2'); await pg.fill('#npf [name=password2]', 'new-password-2'); await pg.click('#npf button[type=submit]');
    await pg.waitForSelector('.hco', { timeout: 10000 }); check(true, 'F17 saved, then on to the Riyeser home');
    check(acct.puts.some((x) => x.password === 'new-password-2'), 'F17 updateUser({ password }) sent');
    check(acct.logouts.includes('others'), 'F17 other devices signed out (logout scope=others)');
    await pg.close();
    const p2 = await page(b, acct, errs, 'F17b');
    const old = await signIn(p2, 'owner@sample.test', 'old-password-1'); check(/error/.test(old) && /isn't right/.test(old), 'F17 the old password now fails: ' + old);
    const nw = await signIn(p2, 'owner@sample.test', 'new-password-2'); check(nw === 'in', 'F17 the new password works');
    // ---- F17: Change password while signed in (home -> 🔑 Change password)
    await p2.click('#hpw'); await p2.waitForSelector('#cpf'); check(!(await p2.$('#cpf [name=code]')), 'F17 change password: no code box when two-step sign-in is off');
    await p2.fill('#cpf [name=current]', 'wrong-one-99'); await p2.fill('#cpf [name=password]', 'third-password-3'); await p2.fill('#cpf [name=password2]', 'third-password-3');
    await p2.click('#cpf button[type=submit]'); await p2.waitForSelector('#cperr .err');
    check(/current password isn't right/.test(await p2.textContent('#cperr .err')), 'F17 change password: a wrong current password is refused');
    check(acct.password === 'new-password-2', 'F17 ...and nothing changed');
    await p2.fill('#cpf [name=current]', 'new-password-2'); await p2.click('#cpf button[type=submit]');
    await p2.waitForSelector('.mcard h3:has-text("Password changed")'); check(acct.password === 'third-password-3', 'F17 change password: the new password is saved');
    check(acct.logouts.filter((x) => x === 'others').length >= 2, 'F17 change password signs out other devices');
    await p2.click('#cl'); check(!!(await p2.$('.hco')), 'F17 still signed in on this page after changing it');
    const p3 = await page(b, acct, errs, 'F17c'); check(await signIn(p3, 'owner@sample.test', 'third-password-3') === 'in', 'F17 sign in with the changed password works');
    check(/error/.test(await signIn(p3, 'owner@sample.test', 'new-password-2')), 'F17 the previous password fails');
    await p2.close(); await p3.close(); }

  // ---- F17 with two-step sign-in on: the reset link asks for the code first, Change password asks for a code too
  { const acct = newAcct({ factors: [{ id: 'f1', factor_type: 'totp', status: 'verified', friendly_name: 'Riyeser phone' }] }); fakeServer(acct); const pg = await page(b, acct, errs, 'F17mfa');
    await pg.goto(BASE + '/link/' + linkHash(acct, 'recovery'));
    await pg.waitForSelector('#cs', { timeout: 10000 }); check(true, 'F17 2FA: reset link asks for the 6-number code first');
    await pg.fill('#cs input', '246810'); await pg.click('#cs .btn.p'); await pg.waitForSelector('#npf'); check(true, 'F17 2FA: then "Choose a new password"');
    await pg.fill('#npf [name=password]', 'mfa-password-1'); await pg.fill('#npf [name=password2]', 'mfa-password-1'); await pg.click('#npf button[type=submit]');
    await pg.waitForSelector('.hco'); check(acct.password === 'mfa-password-1', 'F17 2FA: new password saved');
    await pg.click('#hpw'); await pg.waitForSelector('#cpf [name=code]'); check(true, 'F17 2FA: Change password asks for the code');
    await pg.fill('#cpf [name=current]', 'mfa-password-1'); await pg.fill('#cpf [name=password]', 'mfa-password-2'); await pg.fill('#cpf [name=password2]', 'mfa-password-2');
    await pg.fill('#cpf [name=code]', '111111'); await pg.click('#cpf button[type=submit]'); await pg.waitForSelector('#cperr .err');
    check(/code isn't right/.test(await pg.textContent('#cperr .err')) && acct.password === 'mfa-password-1', 'F17 2FA: a wrong code changes nothing');
    await pg.fill('#cpf [name=code]', '246810'); await pg.click('#cpf button[type=submit]'); await pg.waitForSelector('.mcard h3:has-text("Password changed")');
    check(acct.password === 'mfa-password-2', 'F17 2FA: with the right code the password changes');
    await pg.close(); }

  // ---- F1: the confirm-your-email link, and an expired one
  { const acct = newAcct(); fakeServer(acct); const pg = await page(b, acct, errs, 'F1');
    await pg.goto(BASE + '/link/' + linkHash(acct, 'signup'));
    await pg.waitForSelector('#confirmed', { timeout: 10000 }); const t = await pg.textContent('#confirmed');
    check(/Email confirmed/.test(t) && /owner@sample\.test/.test(t), 'F1 "Email confirmed" and who is signed in');
    check(!(await pg.evaluate(() => location.hash.includes('access_token'))), 'F1 the token is cleared from the address');
    await pg.click('#cgo'); await pg.waitForSelector('.hco'); check(true, 'F1 Continue -> the account works (Riyeser home)');
    await pg.close();
    const p2 = await page(b, newAcct(), errs, 'F1b');
    await p2.goto(BASE + '/link/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    await p2.waitForSelector('#gf .err'); const e = await p2.textContent('#gf .err');
    check(/expired or has already been used/.test(e), 'F1 an expired link says so: ' + e);
    check(!(await p2.evaluate(() => location.hash)), 'F1 the error is cleared from the address');
    await p2.close(); }

  // ---- S6: two-step set-up right after load, again after Later; and catching up after it was turned on elsewhere
  { const minute = new Date().toISOString().slice(0, 16);
    // what the old page left behind: an unfinished set-up with the name the old code would use this minute
    const acct = newAcct({ factors: [{ id: 'f0', factor_type: 'totp', status: 'unverified', friendly_name: 'Riyeser ' + minute }] }); fakeServer(acct);
    const pg = await page(b, acct, errs, 'S6');
    check(await signIn(pg, 'owner@sample.test', 'old-password-1') === 'in', 'S6 signed in (owner, two-step off)');
    check(!!(await pg.$('#hmfa')), 'S6 the "Turn on two-step sign-in" reminder shows');
    await pg.click('#hmfa'); await pg.waitForSelector('#vf', { timeout: 5000 }); check(await pg.isVisible('.qr img'), 'S6 one click right after load shows the QR code (no "already exists")');
    check(!acct.factors.some((f) => f.id === 'f0'), 'S6 the unfinished set-up was removed first');
    check(new Set(acct.enrolls).size === acct.enrolls.length && /\d{2}:\d{2}:\d{2} [a-z0-9]+$/.test(acct.enrolls[0]), 'S6 a name of its own: ' + acct.enrolls[0]);
    await pg.click('#vf #cl'); await pg.waitForTimeout(300);
    check(acct.factors.filter((f) => f.status === 'unverified').length === 0, 'S6 Later removes the unfinished set-up');
    await pg.click('#hsec'); await pg.waitForSelector('#vf'); check(await pg.isVisible('.qr img'), 'S6 pressing it again after Later works');
    await pg.fill('#vf input', '246810'); await pg.click('#vf .btn.p'); await pg.waitForSelector('.mcard h3:has-text("is on")');
    await pg.click('.mcard #cl'); await pg.waitForTimeout(300);
    check(!(await pg.$('#hmfa')), 'S6 after turning it on the reminder is gone');
    check(acct.factors.length === 1 && acct.factors[0].status === 'verified', 'S6 exactly one factor, verified');
    // another page that signed in before it was turned on
    const acct2 = newAcct(); fakeServer(acct2); const p2 = await page(b, acct2, errs, 'S6b');
    check(await signIn(p2, 'owner@sample.test', 'old-password-1') === 'in' && !!(await p2.$('#hmfa')), 'S6 a second page signed in with two-step off');
    acct2.factors.push({ id: 'f7', factor_type: 'totp', status: 'verified', friendly_name: 'Riyeser other' });   // turned on elsewhere
    await p2.click('#hmfa'); await p2.waitForSelector('.mcard #vf'); check(/after this page signed in/.test(await p2.textContent('.mcard')), 'S6 that page asks for one code to catch up');
    await p2.fill('#vf input', '246810'); await p2.click('#vf .btn.p'); await p2.waitForTimeout(600);
    check(!(await p2.$('#hmfa')), 'S6 ...and the reminder goes away');
    check(!acct2.enrolls.length, 'S6 ...without starting a second set-up');
    await pg.close(); await p2.close(); }

  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} PASSWORD CHECK(S) FAILED` : 'ALL PASSWORD CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
