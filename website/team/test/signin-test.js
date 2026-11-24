// The real (non-demo) sign-in and team set-up, against a pretend Supabase that answers like the real one.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = []; const calls = [];
  const pg = await b.newPage({ viewport: { width: 1200, height: 800 } });
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('**/team/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test' };
  let teamMade = false;
  await pg.route('https://fake.supabase.test/**', async (r) => {
    const u = new URL(r.request().url()); const path = u.pathname + u.search; calls.push(r.request().method() + ' ' + u.pathname);
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (u.pathname === '/auth/v1/token') {
      const body = JSON.parse(r.request().postData() || '{}');
      if (body.password !== 'right-password') return json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400);
      return json({ access_token: 'x.y.z', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    }
    if (u.pathname === '/rest/v1/members' && path.includes('workspaces')) return json(teamMade ? [{ role: 'owner', job_role: 'owner', display_name: 'Alex', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2' } }] : []);
    if (u.pathname === '/rest/v1/rpc/create_company') { teamMade = true; return json({ workspace_id: 'w1', company_code: 'RIY-7K3M-Q2' }); }
    if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex', role: 'owner' }]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: 'Everyone in the team' }, { id: 'c2', kind: 'channel', name: 'jobs', topic: null }]);
    if (u.pathname === '/rest/v1/rpc/unread_counts') return json([]);
    if (u.pathname === '/rest/v1/messages' && r.request().method() === 'GET') return json([]);
    if (u.pathname === '/rest/v1/messages' && r.request().method() === 'POST') { const m = JSON.parse(r.request().postData()); return json({ id: 'm1', user_id: user.id, created_at: new Date().toISOString(), edited_at: null, deleted: false, ...m }); }
    if (u.pathname === '/rest/v1/reads') return json([], 201);
    return json([]);
  });
  await pg.goto('http://127.0.0.1:8090/team/'); await pg.waitForSelector('#gf');
  console.log('1. signed out shows:', await pg.textContent('.gcard h1'), '| demo?', await pg.evaluate(() => window.RiyeserTeam.demo));
  await pg.fill('input[name=email]', user.email); await pg.fill('input[name=password]', 'wrong-password'); await pg.click('button[type=submit]');
  await pg.waitForSelector('.err'); console.log('2. wrong password:', await pg.textContent('.err'));
  await pg.fill('input[name=email]', user.email); await pg.fill('input[name=password]', 'right-password'); await pg.click('button[type=submit]');
  await pg.waitForSelector('#jf'); console.log('3. signed in, no company yet ->', await pg.textContent('#jf h1'), '/', await pg.textContent('.newco summary'));
  await pg.click('.newco summary'); await pg.fill('#cf input[name=team]', 'Sample Plumbing'); await pg.fill('#cf input[name=you]', 'Alex'); await pg.click('#cf button');
  await pg.waitForSelector('#cidv'); console.log('4. company made, shows its ID:', await pg.textContent('#cidv')); await pg.click('#cl');
  await pg.waitForSelector('#txt'); console.log('   chat open on:', await pg.textContent('#mhead h2'));
  await pg.fill('#txt', 'First message'); await pg.press('#txt', 'Enter'); await pg.waitForTimeout(400);
  console.log('5. sent:', await pg.evaluate(() => [...document.querySelectorAll('#msgs .mb')].map((x) => x.textContent.trim())));
  console.log('server calls:', [...new Set(calls)].join(', '));
  console.log('errors:', errs); await b.close();
})();
