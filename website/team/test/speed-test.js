// S4: the Riyeser home (account screen) is usable in under 2 seconds after sign-in or a reload, even when every Supabase
// call takes 300 ms: independent calls go together, and the plan, billing and help fill in when they arrive.
// Against a pretend Supabase (and paypal function) that answers each request after LATENCY ms.
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/speed-test.js`. Exits 1 on failure.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const LATENCY = Number(process.env.LATENCY || 300);
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

(async () => {
  const b = await chromium.launch(); const errs = [];
  const pg = await b.newPage({ viewport: { width: 1200, height: 850 } });
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', aud: 'authenticated', role: 'authenticated', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
  let log = []; let t0 = 0;
  const handler = async (r) => {
    const u = new URL(r.request().url()); const m = r.request().method();
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const start = Date.now() - t0; await new Promise((res) => setTimeout(res, LATENCY));
    log.push([start, Date.now() - t0, m + ' ' + u.pathname]);
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    const p = u.pathname;
    if (p === '/auth/v1/token') return json({ access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (p === '/auth/v1/user') return json(user);
    if (p === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business' } }]);
    if (p === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex', role: 'owner', job_role: 'owner', extension: 101 }, { user_id: 'u2', display_name: 'Sam', role: 'member', job_role: 'staff', extension: 102 }]);
    if (p === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }, { id: 'c2', kind: 'dm', name: null, topic: null }]);
    if (p === '/rest/v1/channel_members') return json([{ channel_id: 'c2', user_id: user.id }, { channel_id: 'c2', user_id: 'u2' }]);
    if (p === '/rest/v1/rpc/team_features') return json({ calls: true });
    if (p === '/rest/v1/rpc/company_licence') return json({ modules: { basic: { status: 'trial', active: true, days_left: 60, trial_ends: '2027-01-24' } }, seats: { included: 3, extra: 0, used: 2 } });
    if (p === '/rest/v1/rpc/my_billing') return json({ licence: { modules: {} }, subscription: null, orders: [], payments: [], seller: { name: 'Riyeser' } });
    if (p === '/rest/v1/rpc/my_tickets') return json([]);
    if (p === '/functions/v1/paypal/status') return json({ ready: true });
    return json([]);
  };
  await pg.route('https://fake.supabase.test/**', handler);

  // 1. sign in -> the home is on screen and usable (Open Riyeser Link works, Billing is there)
  await pg.goto(BASE + '/link/'); await pg.waitForSelector('#gf');
  await pg.fill('#gf input[name=email]', user.email); await pg.fill('#gf input[name=password]', 'right-password');
  log = []; t0 = Date.now(); await pg.click('#gf button[type=submit]');
  await pg.waitForSelector('.hco h2', { timeout: 20000 }); const shown = Date.now() - t0;
  await pg.waitForSelector('#hbill', { timeout: 20000 }); const full = Date.now() - t0;
  console.log(`sign-in: home shown after ${shown} ms, billing in after ${full} ms, ${log.length} requests`);
  check(shown < 2000, `S4 after sign-in the home is on screen in under 2 s (${shown} ms with ${LATENCY} ms a request)`);
  check(full < 2500, `S4 the plan and billing are filled in soon after (${full} ms)`);
  await pg.click('#hchat'); await pg.waitForSelector('#txt', { timeout: 5000 }); const chat = Date.now() - t0;
  check(chat < 3000 && /general/.test(await pg.textContent('body')), `S4 Open Riyeser Link works straight away (${chat} ms)`);

  // 2. reload (signed in already)
  log = []; t0 = Date.now(); await pg.goto(BASE + '/link/');
  await pg.waitForSelector('.hco h2', { timeout: 20000 }); const shown2 = Date.now() - t0;
  await pg.waitForSelector('#hbill', { timeout: 20000 }); const full2 = Date.now() - t0;
  console.log(`reload: home shown after ${shown2} ms (page load included), billing after ${full2} ms, ${log.length} requests`);
  const waves = []; for (const [s] of log.sort((a, c) => a[0] - c[0])) if (!waves.length || s >= waves[waves.length - 1] + LATENCY * 0.8) waves.push(s);
  console.log(`  requests went in ${waves.length} rounds`);
  check(shown2 < 2000, `S4 after a reload the home is on screen in under 2 s (${shown2} ms)`);
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} SPEED CHECK(S) FAILED` : 'ALL SPEED CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
