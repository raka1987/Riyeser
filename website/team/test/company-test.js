// Companies in the Team app: Company ID, join requests (approve with role + branch), people & access,
// company profile, linked PCs (demo); and ask-to-join -> waiting -> approved (pretend server).
const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.';
  const pg = await b.newPage({ viewport: { width: 1280, height: 860 } });
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
  await pg.goto('http://127.0.0.1:8090/team/?demo'); await pg.waitForSelector('.cobar');
  console.log('team header:', (await pg.textContent('.team small')).trim(), '| bar:', (await pg.textContent('.cobar')).replace(/\s+/g, ' ').trim());
  // approve Mere as Sales in Lautoka
  await pg.click('#coreq'); await pg.waitForSelector('form[data-req]');
  console.log('request:', (await pg.textContent('.rq-who')).replace(/\s+/g, ' ').trim(), '| Lautoka pre-ticked:', await pg.isChecked('form[data-req] input[name=br][value="b-lau"]'));
  await pg.selectOption('form[data-req] select[name=job]', 'sales');
  await pg.screenshot({ path: out + '/company-requests.png' });
  await pg.click('form[data-req] .btn.p'); await pg.waitForTimeout(300);
  const mere = await pg.evaluate(() => window.RiyeserTeam.state.people.find((p) => p.display_name === 'Mere Vula'));
  console.log('approved:', mere && `${mere.display_name} ${mere.job_role} ext ${mere.extension}`, '| requests left:', await pg.evaluate(() => window.RiyeserTeam.state.requests.length));
  await pg.click('#cl');
  // change Jordan to Bookkeeper + admin, in both branches
  await pg.click('#coppl'); await pg.waitForSelector('details.brm summary');
  const jf = 'form[data-person="u-jordan"]';
  await pg.click(`details:has(${jf}) summary`); await pg.selectOption(`${jf} select[name=job]`, 'bookkeeper'); await pg.check(`${jf} input[name=admin]`);
  await pg.check(`${jf} input[name=br][value="b-head"]`); await pg.click(`${jf} .btn.p`); await pg.waitForTimeout(300);
  const jordan = await pg.evaluate(() => { const S = window.RiyeserTeam.state; const p = S.people.find((x) => x.user_id === 'u-jordan');
    return `${p.role}/${p.job_role} in ${S.branches.filter((b) => b.people.includes('u-jordan')).map((b) => b.name).join(' + ')}`; });
  console.log('access changed:', jordan);
  await pg.screenshot({ path: out + '/company-people.png' }); await pg.click('#cl');
  // company profile and PCs
  await pg.click('#coinfo'); await pg.waitForSelector('#cof');
  console.log('company ID:', await pg.textContent('#cidv'), '| PCs:', await pg.evaluate(() => [...document.querySelectorAll('.devs b')].map((x) => x.textContent)));
  await pg.fill('#cof input[name=phone]', '330 9999'); await pg.click('[data-unlink="d2"]'); await pg.waitForTimeout(200);
  await pg.screenshot({ path: out + '/company-profile.png' });
  await pg.click('#cof .btn.p'); await pg.waitForTimeout(300);
  console.log('saved phone:', await pg.evaluate(() => window.RiyeserTeam.state.team.phone), '| PCs after unlink:', (await pg.evaluate(async () => (await window.RiyeserTeam.state, 1))) && 'ok');

  // ask to join -> waiting -> approved (pretend Supabase)
  const p2 = await b.newPage({ viewport: { width: 1000, height: 800 } }); p2.on('pageerror', (e) => errs.push('join: ' + e.message));
  await p2.route('**/team/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  const user = { id: 'aaaaaaaa-0000-4000-8000-000000000009', email: 'mere@sample.test' }; let approved = false; let asked = null;
  await p2.route('https://fake.supabase.test/**', async (r) => {
    const u = new URL(r.request().url()); const m = r.request().method();
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (u.pathname === '/auth/v1/token') return json({ access_token: 'x.y.z', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json(approved ? [{ role: 'member', job_role: 'sales', display_name: 'Mere', workspaces: { id: 'w1', name: 'Sample Plumbing', company_code: 'RIY-7K3M-Q2', invite_code: 'X' } }] : []);
    if (u.pathname === '/rest/v1/rpc/request_join') { asked = JSON.parse(r.request().postData()); return json({ status: 'pending', company_name: 'Sample Plumbing', workspace_id: 'w1' }); }
    if (u.pathname === '/rest/v1/rpc/my_join_requests') return json(asked ? [{ id: 'r1', workspace_id: 'w1', company_name: 'Sample Plumbing', status: approved ? 'approved' : 'pending' }] : []);
    if (u.pathname === '/rest/v1/rpc/team_features') return json({ calls: true, trial_days_left: 80 });
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    if (u.pathname === '/rest/v1/rpc/unread_counts') return json([]);
    if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Mere', role: 'member', job_role: 'sales', extension: 201 }]);
    return json([]);
  });
  await p2.goto('http://127.0.0.1:8090/team/?join=riy-7k3m-q2'); await p2.waitForSelector('#gf');
  await p2.fill('input[name=email]', user.email); await p2.fill('input[name=password]', 'a-good-password'); await p2.click('button[type=submit]');
  await p2.waitForSelector('#jf'); console.log('join form prefilled with:', await p2.inputValue('#jf input[name=code]'));
  await p2.fill('#jf input[name=you]', 'Mere'); await p2.fill('#jf input[name=note]', 'Lautoka front desk'); await p2.click('#jf button');
  await p2.waitForSelector('.waitdots'); console.log('waiting screen:', await p2.textContent('.gcard h1'), '| sent:', JSON.stringify(asked));
  await p2.screenshot({ path: out + '/company-waiting.png' });
  approved = true; await p2.click('#chk'); await p2.waitForSelector('.cobar', { timeout: 8000 });
  console.log('approved -> in the company:', (await p2.textContent('.team b')).trim(), '| no admin buttons for staff:', !(await p2.$('#coreq')));
  const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); await ph.goto('http://127.0.0.1:8090/team/?demo'); await ph.waitForSelector('.cobar');
  await ph.tap('#coreq'); await ph.waitForSelector('form[data-req]'); console.log('phone overflow:', await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  console.log('errors:', errs); await b.close();
})();
