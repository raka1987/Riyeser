// Signing out of Riyeser HQ, against a pretend Supabase, in both layouts (current and ?v2=1) and on a phone:
//   - the account menu at the top right says who you are ("Name · Role") and has Sign out and Sign out of all devices;
//   - Sign out ends the session (Supabase logout, this browser only; "all devices" = every session), forgets the stored
//     session and lands on the HQ sign-in screen;
//   - Back afterwards shows the sign-in screen, never HQ data, and asks the database for nothing;
//   - opening HQ again asks for nothing either, and the old session's token is refused by the database.
// The left-hand menu has a small Sign out link too, and on a phone Sign out is in the Menu.
// Run: build the site, serve website/public on port 8090 (or set HQ_URL), then `node website/hq/test-hq-signout.js`. Exits 1 on failure.
const { chromium } = require('playwright');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const MARK = 'Marker Business Ltd';
(async () => {
  const b = await chromium.launch(); const bad = []; const check = (ok, what) => { if (!ok) bad.push(what); console.log(ok ? 'ok  ' : 'FAIL', what); };
  async function open(qs, w = 1366) {
    const pg = await b.newPage({ viewport: { width: w, height: 900 } }); const S = { calls: [], logout: [], revoked: new Set() };
    const now = Math.floor(Date.now() / 1000);
    const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', aal: 'aal2', session_id: 's1', exp: now + 36000, iat: now, amr: [{ method: 'totp', timestamp: now - 600 }] })}.sig`; S.jwt = jwt;
    await pg.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"k"};' }));
    await pg.addInitScript(([tok, exp]) => { try { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); } catch { return; }
      localStorage.setItem('riyeser.hq.session', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 36000, expires_at: exp,
        user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'staff@riyeser.test', factors: [{ id: 'f', factor_type: 'totp', status: 'verified' }] } })); }, [jwt, now + 36000]);
    await pg.route('https://fake.supabase.test/**', async (r) => { const u = new URL(r.request().url()); const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: h });
      const auth = (r.request().headers().authorization || '').replace(/^Bearer /, ''); const json = (o, status = 200) => r.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(o) });
      if (u.pathname.startsWith('/auth/v1/logout')) { S.logout.push({ scope: u.searchParams.get('scope'), token: auth }); S.revoked.add(auth); return r.fulfill({ status: 204, headers: h }); }
      if (S.revoked.has(auth)) return json({ code: 'PGRST301', message: 'JWT expired' }, 401);
      const fn = u.pathname.split('/rpc/')[1]; if (fn) S.calls.push({ fn, token: auth, at: Date.now() });
      if (u.pathname.startsWith('/auth/v1/user')) return json({ id: 'u1', email: 'staff@riyeser.test', factors: [{ id: 'f', factor_type: 'totp', status: 'verified' }] });
      if (fn === 'hq_me') return json({ role: 'owner', name: 'Sam', active: true, two_step: true, perms: ['overview.view', 'customers.view'] });
      if (fn === 'hq_touch') return json({ ok: true, timed: true, idle_minutes: 30, max_hours: 12, signed_in_at: new Date().toISOString() });
      if (fn === 'hq_companies_page') return json({ total: 1, page: 1, per_page: 50, rows: [{ id: 'x1', name: MARK, company_code: 'RIY-TEST-01', status: 'active' }] });
      return r.fulfill({ status: 200, headers: h, contentType: 'application/json', body: fn ? 'null' : '{}' }); });
    await pg.goto(`${BASE}/hq/${qs}#/overview`); await pg.waitForTimeout(1500);
    return { pg, S };
  }
  const body = (pg) => pg.evaluate(() => document.body.innerText);
  for (const qs of ['?v2=0', '?v2=1']) {
    let { pg, S } = await open(qs);
    const v2 = qs === '?v2=1';
    check(!!(await pg.$(v2 ? '#v2' : '.snav')), `${qs} HQ opens`);
    const sum = v2 ? '.me2 > summary' : '#acct > summary';
    check(/Sam · Owner/.test(await pg.innerText(sum)), `${qs} the account menu at the top right says "Sam · Owner"`);
    await pg.click(sum); await pg.waitForTimeout(200);
    const items = await pg.evaluate((v) => [...document.querySelectorAll(v ? '.mem2 button' : '#acct .ddm button')].filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.textContent.trim()), v2);
    check(items.includes('Sign out') && items.includes('Sign out of all devices'), `${qs} it has Sign out and Sign out of all devices (${items.join(', ')})`);
    const inView = await pg.evaluate((v) => { const m = document.querySelector(v ? '.mem2' : '#acct .ddm').getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth && m.bottom <= innerHeight; }, v2);
    check(inView, `${qs} the account menu opens inside the window`);
    check(await pg.evaluate((v) => [...document.querySelectorAll(v ? '.sout2' : '.sout')].some((x) => /Sign out/.test(x.textContent)), v2), `${qs} the left-hand menu has a Sign out link`);
    await pg.keyboard.press('Escape'); await pg.evaluate((v) => { if (v) document.querySelector('.me2').open = false; }, v2);
    // some HQ data on screen
    await pg.evaluate(() => { location.hash = '#/companies'; }); await pg.waitForTimeout(1200);
    check((await body(pg)).includes(MARK), `${qs} customer data on screen before signing out`);
    // sign out
    await pg.click(sum); await pg.waitForTimeout(150);
    await pg.click(v2 ? '.mem2 [data-signout2]:not([data-signout2="global"])' : '#acct [data-signout]:not([data-signout="global"])'); await pg.waitForTimeout(800);
    const t0 = Date.now();
    check(S.logout.length === 1 && S.logout[0].scope === 'local' && S.logout[0].token === S.jwt, `${qs} Sign out ended the session with the database (${JSON.stringify(S.logout.map((x) => x.scope))})`);
    check(await pg.evaluate(() => localStorage.getItem('riyeser.hq.session')) === null, `${qs} the stored session is gone`);
    check(!!(await pg.$('#g input[type=email]')) && /signed out/i.test(await body(pg)), `${qs} lands on the HQ sign-in screen`);
    check(!(await body(pg)).includes(MARK) && !(await pg.$('#v2, .snav')), `${qs} no HQ data or menu left on the page`);
    // Back: still the sign-in screen, nothing asked of the database
    await pg.goBack(); await pg.waitForTimeout(800);
    check(!!(await pg.$('#g')) && !(await body(pg)).includes(MARK), `${qs} Back shows the sign-in screen, not HQ data`);
    await pg.goBack().catch(() => {}); await pg.waitForTimeout(500);
    check(!(await body(pg)).includes(MARK), `${qs} Back again: still no HQ data`);
    check(!S.calls.some((c) => c.at >= t0), `${qs} no HQ data calls after signing out (${S.calls.filter((c) => c.at >= t0).map((c) => c.fn).join(', ')})`);
    // opening HQ again: the sign-in screen; and the old session's token is refused
    await pg.goto(`${BASE}/hq/${qs}#/companies`); await pg.waitForTimeout(1200);
    check(!!(await pg.$('#g')) && !(await body(pg)).includes(MARK) && !S.calls.some((c) => c.at >= t0), `${qs} opening HQ again asks to sign in, with no data calls`);
    const st = await pg.evaluate(async (tok) => (await fetch('https://fake.supabase.test/rest/v1/rpc/hq_companies_page', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: '{}' })).status, S.jwt);
    check(st === 401, `${qs} an HQ data call with the old session fails (${st})`);
    await pg.close();
    // Sign out of all devices
    ({ pg, S } = await open(qs));
    await pg.click(sum); await pg.waitForTimeout(150); await pg.click(v2 ? '.mem2 [data-signout2="global"]' : '#acct [data-signout="global"]'); await pg.waitForTimeout(800);
    check(S.logout.length === 1 && S.logout[0].scope === 'global' && /every device/.test(await body(pg)), `${qs} Sign out of all devices ends every session (${JSON.stringify(S.logout.map((x) => x.scope))})`);
    await pg.close();
    // a phone: Sign out is in the Menu
    ({ pg, S } = await open(qs, 390));
    if (v2) { await pg.click('#menuBtn'); await pg.waitForTimeout(300); check(await pg.isVisible('.sout2'), `${qs} phone: Sign out in the menu`); await pg.click('.sout2'); }
    else { await pg.click('#mnav'); await pg.waitForTimeout(300); check(await pg.isVisible('#mmenu [data-signout]:not([data-signout="global"])') && await pg.isVisible('#mmenu [data-signout="global"]'), `${qs} phone: Sign out and Sign out of all devices in the Menu`);
      await pg.click('#mmenu [data-signout]:not([data-signout="global"])'); }
    await pg.waitForTimeout(800);
    check(S.logout.length === 1 && !!(await pg.$('#g')), `${qs} phone: signed out to the sign-in screen`);
    await pg.close();
  }
  await b.close();
  console.log(bad.length ? 'HQ SIGN-OUT TEST FAILED' : 'ALL HQ SIGN-OUT TESTS PASSED'); if (bad.length) process.exitCode = 1;
})();
