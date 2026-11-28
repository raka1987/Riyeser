// HQ staff sessions (owner's decision: signed out after 30 minutes without activity and 12 hours after signing in),
// against a pretend Supabase: the database says the session ended -> the sign-in screen with a plain note; the browser's
// own timers (30 minutes idle, 12 hours) sign out; activity is sent to the database at most about once a minute; a refused
// call in the middle of work ("Your HQ session has ended") signs out too. Both layouts (current and ?v2=1). Exits 1 on failure.
// Run: build the site, serve website/public on port 8090 (or set HQ_URL), then `node website/hq/test-hq-session.js`.
const { chromium } = require('playwright');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
(async () => {
  const b = await chromium.launch(); const bad = []; const check = (ok, what) => { if (!ok) bad.push(what); console.log(ok ? 'ok  ' : 'FAIL', what); };
  // touch: what hq_touch answers ('ok', 'idle', 'max'); fail: answer every other rpc with "session has ended" after n calls
  async function open(qs, { touch = 'ok', signedAgoH = 1, failAfter = Infinity } = {}) {
    const pg = await b.newPage({ viewport: { width: 1366, height: 900 } }); const calls = []; let n = 0;
    await pg.clock.install({ time: new Date('2026-11-28T09:00:00Z') });
    const now = Math.floor(new Date('2026-11-28T09:00:00Z').getTime() / 1000);
    const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', aal: 'aal2', session_id: 's1', exp: now + 36000, iat: now, amr: [{ method: 'totp', timestamp: now - signedAgoH * 3600 }] })}.sig`;
    await pg.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"k"};' }));
    await pg.addInitScript(([tok, exp]) => { localStorage.setItem('riyeser.hq.session', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer', expires_in: 36000, expires_at: exp,
      user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'staff@riyeser.test', factors: [{ id: 'f', factor_type: 'totp', status: 'verified' }] } })); }, [jwt, now + 36000]);
    await pg.route('https://fake.supabase.test/**', async (r) => { const u = new URL(r.request().url()); const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: h });
      const fn = u.pathname.split('/rpc/')[1]; if (fn) calls.push({ fn, at: Date.now() });
      if (u.pathname.startsWith('/auth/v1/logout')) return r.fulfill({ status: 204, headers: h });
      if (u.pathname.startsWith('/auth/v1/user')) return r.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify({ id: 'u1', email: 'staff@riyeser.test', factors: [{ id: 'f', factor_type: 'totp', status: 'verified' }] }) });
      if (fn === 'hq_me') return r.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify({ role: 'support', name: 'Help Desk', active: true, two_step: true, perms: ['overview.view'] }) });
      if (fn === 'hq_touch') return r.fulfill({ status: 200, headers: h, contentType: 'application/json',
        body: JSON.stringify(touch === 'ok' ? { ok: true, timed: true, idle_minutes: 30, max_hours: 12, signed_in_at: new Date((now - signedAgoH * 3600) * 1000).toISOString() } : { ok: false, ended: touch, idle_minutes: 30, max_hours: 12 }) });
      if (fn && ++n > failAfter) return r.fulfill({ status: 400, headers: h, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: 'Your HQ session has ended (30 minutes without activity, or 12 hours since you signed in). Sign in again.' }) });
      return r.fulfill({ status: 200, headers: h, contentType: 'application/json', body: fn ? 'null' : '{}' }); });
    await pg.goto(`${BASE}/hq/${qs}`); await pg.waitForTimeout(1500);
    return { pg, calls };
  }
  const gateNote = (pg) => pg.evaluate(() => { const n = document.querySelector('#g .note'); return n ? n.textContent : null; });
  for (const qs of ['?v2=0', '?v2=1']) {
    // 1. the database says it ended (idle) -> sign-in screen with the note, nothing else asked
    let { pg } = await open(qs, { touch: 'idle' });
    check(/30 minutes without activity/.test(await gateNote(pg) || ''), `${qs} ended session at start: sign-in screen says 30 minutes`); await pg.close();
    ({ pg } = await open(qs, { touch: 'max' }));
    check(/12 hours/.test(await gateNote(pg) || ''), `${qs} 12-hour session at start: sign-in screen says 12 hours`); await pg.close();
    // 2. a working session: activity sent at most about once a minute; 31 minutes without activity -> signed out
    let calls; ({ pg, calls } = await open(qs));
    check(!!(await pg.$(qs === '?v2=1' ? '#v2' : '.snav')), `${qs} a working session opens HQ`);
    for (let i = 0; i < 5; i++) { await pg.mouse.click(700, 300); await pg.clock.runFor(10e3); }
    await pg.clock.runFor(61e3); await pg.mouse.click(700, 300); await pg.waitForTimeout(200);
    const touches = calls.filter((c) => c.fn === 'hq_touch').length;
    check(touches === 2, `${qs} activity told to the database at most once a minute (touches: ${touches})`);
    await pg.clock.runFor(31 * 60e3); await pg.waitForTimeout(300);
    check(/30 minutes without activity/.test(await gateNote(pg) || ''), `${qs} 31 minutes idle: signed out with a note`); await pg.close();
    // 3. 12 hours after signing in, even while active -> signed out
    ({ pg } = await open(qs, { signedAgoH: 11.9 }));
    for (let i = 0; i < 12; i++) { await pg.mouse.click(700, 300); await pg.clock.runFor(60e3); }
    await pg.waitForTimeout(300);
    check(/12 hours/.test(await gateNote(pg) || ''), `${qs} 12 hours after signing in: signed out while active`); await pg.close();
    // 4. a call refused mid-work ("Your HQ session has ended") -> signed out
    ({ pg } = await open(qs, { failAfter: 1 }));
    await pg.waitForTimeout(500);
    check(/without activity/.test(await gateNote(pg) || ''), `${qs} a refused call ("session has ended") signs out`); await pg.close();
  }
  await b.close();
  console.log(bad.length ? 'HQ SESSION TEST FAILED' : 'ALL HQ SESSION TESTS PASSED'); if (bad.length) process.exitCode = 1;
})();
