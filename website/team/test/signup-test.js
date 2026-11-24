// Creating a Riyeser account with every detail on one page, against a pretend server:
// sign up (name, email, password, mobile, country, business details) -> "check your email" -> sign in ->
// the account is set up from those details straight away (no second form) -> the Riyeser home.
// Run: build the site, serve website/public on port 8090, then `node website/team/test/signup-test.js`.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('**/team/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  const user = { id: 'aaaaaaaa-0000-4000-8000-000000000021', email: 'new.owner@sample.test', aud: 'authenticated', role: 'authenticated', user_metadata: {} };
  let made = null; let signupSent = null;
  await pg.route('https://fake.supabase.test/**', async (r) => {
    const u = new URL(r.request().url()); const path = u.pathname + u.search;
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: h, body: JSON.stringify(body) });
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: h });
    if (u.pathname === '/auth/v1/signup') {           // email confirmation is on: no session yet
      signupSent = JSON.parse(r.request().postData() || '{}');
      user.user_metadata = signupSent.data || {};
      return json({ ...user, confirmation_sent_at: new Date().toISOString() });
    }
    if (u.pathname === '/auth/v1/token') return json({ access_token: 'x.y.z', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (u.pathname === '/auth/v1/user') return json(user);
    if (u.pathname === '/rest/v1/rpc/create_company') { made = JSON.parse(r.request().postData()); return json({ workspace_id: 'w1', company_code: 'RIY-NEW1-AB' }); }
    if (u.pathname === '/rest/v1/members' && path.includes('workspaces')) {
      return json(made ? [{ role: 'owner', job_role: 'owner', display_name: made.your_name, workspaces: { id: 'w1', name: made.company_name, invite_code: 'AB12CD34', company_code: 'RIY-NEW1-AB',
        kind: made.profile.kind, phone: made.profile.phone, email: made.profile.email, country: made.profile.country, legal_name: made.profile.legal_name || null, tax_number: made.profile.tax_number || null, address: made.profile.address || null } }] : []);
    }
    if (u.pathname === '/rest/v1/members') return json(made ? [{ user_id: user.id, display_name: made.your_name, role: 'owner' }] : []);
    if (u.pathname === '/rest/v1/rpc/my_join_requests') return json([]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: 'Everyone' }]);
    return json([]);
  });

  await pg.goto('http://127.0.0.1:8090/team/?signup'); await pg.waitForSelector('#gf');
  console.log('1. sign-up page asks for:', await pg.$$eval('#gf label > span', (x) => x.map((s) => s.textContent.trim()).join(' | ')));
  await pg.fill('[name=you]', 'Sione Example'); await pg.fill('[name=email]', user.email); await pg.fill('[name=password]', 'a-good-password');
  await pg.selectOption('[name=country]', 'Samoa'); console.log('   phone hint for Samoa:', await pg.getAttribute('[name=phone]', 'placeholder'));
  await pg.fill('[name=phone]', '+685 70 00000'); await pg.fill('[name=team]', 'Sample Garden Care'); await pg.fill('[name=tax_number]', '12-345-678');
  await pg.fill('[name=address]', '1 Example Road, Apia'); await pg.click('button[type=submit]');
  await pg.waitForSelector('.ok'); console.log('2. after creating:', (await pg.textContent('.ok')).trim());
  console.log('   details kept with the account:', JSON.stringify(signupSent && signupSent.data && signupSent.data.riyeser_signup));
  // after confirming the email: sign in
  await pg.fill('[name=email]', user.email); await pg.fill('[name=password]', 'a-good-password'); await pg.click('button[type=submit]');
  await pg.waitForSelector('.hco', { timeout: 10000 });
  console.log('3. signed in -> straight to the home, no second form:', await pg.textContent('.hco h2'), '|', await pg.textContent('.hco > div > small'));
  console.log('   set up with:', JSON.stringify(made));
  console.log('   home shows:', await pg.$$eval('.hkv dd', (x) => x.map((d) => d.textContent.trim()).join(' | ')));
  console.log('errors:', errs); await b.close();
})();
