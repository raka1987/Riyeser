// Riyeser Link's old address, riyeser.com/team/, still works exactly as before: older Riyeser Team desktop apps and
// Centrals open it, and invite links and sign-up emails point at it. Against a pretend Supabase.
//   1. /team/?signup shows the sign-up form, and a sign-up there returns to /team/ (an address Supabase allows today)
//   2. /team/?join=CODE asks to join that company
//   3. a sign-in link from an email (/team/#access_token=...) signs in, and the link's details are cleared from the address
//   4. /team/config.js, /team/icon.svg and the demo are there; /team/ names /link/ as the main address
//   5. inside chat the tab says "(n) Riyeser Link", the form the desktop apps read the unread count from
// Run: build the site, serve website/public on port 8090, then `node website/team/test/oldaddress-test.js`.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';   // LINK_BASE=http://127.0.0.1:8091 to use another port
(async () => {
  const b = await chromium.launch(); const errs = []; const fail = (m) => { errs.push(m); console.log('FAIL:', m); };
  const user = { id: 'aaaaaaaa-0000-4000-8000-000000000031', email: 'old.link@sample.test', aud: 'authenticated', role: 'authenticated', user_metadata: {} };
  let signup = null; let userAsked = false;
  const page = async () => {
    const pg = await b.newPage({ viewport: { width: 1200, height: 860 } });
    pg.on('pageerror', (e) => fail('page error: ' + e.message));
    await pg.route('**/team/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
    await pg.route('https://fake.supabase.test/**', async (r) => {
      const u = new URL(r.request().url()); const path = u.pathname + u.search;
      const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(body) });
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: h });
      if (u.pathname === '/auth/v1/signup') { signup = { body: JSON.parse(r.request().postData() || '{}'), redirectTo: u.searchParams.get('redirect_to') }; return json({ ...user, confirmation_sent_at: new Date().toISOString() }); }
      if (u.pathname === '/auth/v1/user') { userAsked = true; return json(user); }
      if (u.pathname === '/rest/v1/members' && path.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2' } }]);
      if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex', role: 'owner' }]);
      if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: 'Everyone in the team' }, { id: 'c2', kind: 'channel', name: 'jobs', topic: null }]);
      if (u.pathname === '/rest/v1/rpc/unread_counts') return json([{ channel_id: 'c2', unread: 3 }]);
      return json([]);
    });
    return pg;
  };

  // 1. sign up on the old address
  let pg = await page();
  await pg.goto(`${BASE}/team/?signup`); await pg.waitForSelector('#gf');
  const fields = await pg.$$eval('#gf label > span', (x) => x.length);
  console.log('1. /team/?signup shows the sign-up form with', fields, 'fields');
  await pg.fill('[name=you]', 'Alex Sample'); await pg.fill('[name=email]', user.email); await pg.fill('[name=password]', 'a-good-password'); await pg.fill('[name=password2]', 'a-good-password');
  await pg.click('button[type=submit]'); await pg.waitForSelector('.ok');
  console.log('   confirmation email returns to:', signup && signup.redirectTo);
  if (!signup || signup.redirectTo !== `${BASE}/team/?signup`) fail('a sign-up on /team/ must return to /team/');
  await pg.close();

  // 2. an invite link to the old address
  pg = await page();
  await pg.goto(`${BASE}/team/?join=RIY-7K3M-Q2`); await pg.waitForSelector('#gf');
  const joinText = await pg.textContent('.gcard');
  console.log('2. /team/?join= says:', joinText.replace(/\s+/g, ' ').trim().slice(0, 90));
  if (!/invited/i.test(joinText)) fail('the join link on /team/ should say you have been invited');
  await pg.close();

  // 3. a sign-in link from an email, with its details after # (Supabase's email links)
  pg = await page();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await pg.goto(`${BASE}/team/#access_token=x.y.z&expires_at=${exp}&expires_in=3600&refresh_token=r&token_type=bearer&type=signup`);
  await pg.waitForSelector('.hco, #txt', { timeout: 10000 });
  console.log('3. email link on /team/ signed in:', userAsked, '| address now:', await pg.evaluate(() => location.pathname + location.search + location.hash));
  if (!userAsked) fail('the #access_token link was not used');
  if (await pg.evaluate(() => location.hash.includes('access_token'))) fail('the sign-in details should be cleared from the address');

  // 5. inside chat: "(n) Riyeser Link"
  if (await pg.$('#hchat')) await pg.click('#hchat');
  await pg.waitForSelector('#txt'); await pg.waitForTimeout(300);
  const title = await pg.title(); console.log('5. tab title in chat:', title);
  if (!/^\(3\) Riyeser Link$/.test(title)) fail('the chat tab should read "(3) Riyeser Link", got ' + title);
  await pg.close();

  // 4. the files the old apps load, and the demo
  pg = await page();
  for (const f of ['/team/config.js', '/team/icon.svg', '/team/team.js', '/link/config.js', '/link/icon.svg']) {
    const r = await pg.request.get(BASE + f); if (r.status() !== 200) fail(`${f}: ${r.status()}`);
  }
  await pg.goto(`${BASE}/team/?demo`); await pg.waitForSelector('.item');
  const canon = await pg.getAttribute('link[rel=canonical]', 'href');
  console.log('4. /team/?demo works; files there; canonical:', canon);
  if (canon !== 'https://riyeser.com/link/') fail('/team/ should name https://riyeser.com/link/ as the main address');
  await pg.goto(`${BASE}/link/?demo`); await pg.waitForSelector('.item');
  if (await pg.$('link[rel=canonical]')) fail('/link/ is the main address: it needs no canonical link');
  await b.close();
  console.log(errs.length ? `OLD ADDRESS TEST FAILED (${errs.length})` : 'OLD ADDRESS /team/ STILL WORKS');
  process.exit(errs.length ? 1 : 0);
})();
