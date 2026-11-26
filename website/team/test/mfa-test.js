// Two-step sign-in and the change history: in the demo, and the sign-in code screen against a pretend server.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';   // LINK_BASE=http://127.0.0.1:8091 to use another port
(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.';
  const pg = await b.newPage({ viewport: { width: 1280, height: 860 } });
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
  await pg.goto(BASE + '/link/?demo'); await pg.waitForSelector('#lkshell');
  const nav = (k) => pg.evaluate((x) => window.RiyeserTeam.setNav(x), k);
  await nav('settings'); console.log('owner with two-step: nag shown?', !!(await pg.$('#mfanag')));
  // Management: a code first, then the tools
  await nav('manage'); await pg.waitForSelector('#mgcode'); await pg.fill('#mgcode', '123456'); await pg.click('#mgunlock'); await pg.waitForSelector('#mgopen');
  console.log('Management tools:', (await pg.$$eval('.lk-tile b', (x) => x.map((e) => e.textContent))).join(' | '));
  // history
  await pg.click('#cohist'); await pg.waitForSelector('.hist');
  console.log('history:', await pg.evaluate(() => [...document.querySelectorAll('.hl')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()).slice(0, 3)));
  await pg.screenshot({ path: out + '/mfa-history.png' }); await pg.click('#cl');
  // turn it off: Management locks and only offers setting it up; Settings shows the reminder
  await pg.click('#cosec'); await pg.waitForSelector('#off'); await pg.click('#off'); await pg.click('#askyes'); await pg.waitForTimeout(300);
  console.log('after turning off: Management shows only the set-up step?', !!(await pg.$('#mg-setup')) && !(await pg.$('#coppl')) && !(await pg.$('#mgcode')));
  await nav('settings'); console.log('after turning off: nag shown?', !!(await pg.$('#mfanag')));
  await nav('manage'); await pg.click('#mg-setup'); await pg.waitForSelector('#vf');
  console.log('Management asks for set-up first:', await pg.textContent('.mcard h3'), '| QR shown:', await pg.isVisible('.qr img'));
  await pg.screenshot({ path: out + '/mfa-setup.png' });
  await pg.fill('#vf input', '12'); await pg.click('#vf .btn.p'); await pg.waitForTimeout(200);
  await pg.fill('#vf input', '123456'); await pg.click('#vf .btn.p'); await pg.waitForSelector('.mcard h3:has-text("is on")');
  console.log('turned on:', await pg.textContent('.mcard h3'));
  await pg.click('#cl'); await pg.click('#coppl'); await pg.waitForSelector('details.brm'); console.log('People opens now (the code just typed unlocked Management):', await pg.textContent('.mcard h3'));
  await pg.click('#cl'); await nav('settings'); console.log('nag gone:', !(await pg.$('#mfanag')));

  // sign in to an account with two-step on: asks for the code, then lets you in
  const p2 = await b.newPage({ viewport: { width: 1000, height: 800 } }); p2.on('pageerror', (e) => errs.push('signin: ' + e.message));
  await p2.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = (aal) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal, amr: [{ method: 'password', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
  let level = 'aal1'; const calls = [];
  await p2.route('https://fake.supabase.test/**', async (r) => {
    const u = new URL(r.request().url()); const m = r.request().method(); calls.push(m + ' ' + u.pathname);
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (u.pathname === '/auth/v1/token') return json({ access_token: token(level), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (u.pathname === '/auth/v1/user') return json(user);
    if (u.pathname === '/auth/v1/factors/f1/challenge') return json({ id: 'ch1', expires_at: Math.floor(Date.now() / 1000) + 300 });
    if (u.pathname === '/auth/v1/factors/f1/verify') { const code = JSON.parse(r.request().postData()).code; if (code !== '246810') return json({ code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }, 422);
      level = 'aal2'; return json({ access_token: token('aal2'), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r2', user }); }
    if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex', workspaces: { id: 'w1', name: 'Sample Plumbing', company_code: 'RIY-7K3M-Q2', invite_code: 'X' } }]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex', role: 'owner', job_role: 'owner', extension: 101 }]);
    if (u.pathname === '/rest/v1/rpc/team_features') return json({ calls: true });
    return json([]);
  });
  await p2.goto(BASE + '/link/?chat'); await p2.waitForSelector('#gf');
  await p2.fill('input[name=email]', user.email); await p2.fill('input[name=password]', 'right-password'); await p2.click('button[type=submit]');
  await p2.waitForSelector('#cs'); console.log('after password -> asks for code:', await p2.textContent('#cs h1'));
  await p2.screenshot({ path: out + '/mfa-code.png' });
  await p2.fill('#cs input', '111111'); await p2.click('#cs .btn.p'); await p2.waitForSelector('#cs .err'); console.log('wrong code:', await p2.textContent('#cs .err'));
  await p2.fill('#cs input', '246810'); await p2.click('#cs .btn.p'); await p2.waitForSelector('#lkshell', { timeout: 8000 });
  await p2.evaluate(() => window.RiyeserTeam.setNav('settings'));
  console.log('right code -> in:', (await p2.textContent('#lkbiz b')).trim(), '| owner nag shown (should be no):', !!(await p2.$('#mfanag')));
  console.log('errors:', errs); await b.close();
})();
