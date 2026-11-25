// Riyeser Link chat details from the round-20 fix list, in the demo (?demo) at desktop and phone width:
//   S9  a long message: a counter near the limit; over 4,000 characters Send offers to send it as a .txt file (no raw
//       database error); the database's own refusal reads plainly
//   S49 on a phone, Back from a conversation shows the chat list, and Back again the Riyeser home (against a pretend Supabase)
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/chat-test.js`. Exits 1 on failure.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (w, q = '') => { const pg = await b.newPage({ viewport: { width: w, height: 860 } }); pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${BASE}/link/?demo${q}`); await pg.waitForSelector('#lknav'); return pg; };

  // ---- S9: long messages
  { const pg = await open(1280);
    await pg.fill('#txt', 'x'.repeat(3400)); check(await pg.isHidden('#cnt'), 'S9 no counter for an ordinary message');
    await pg.fill('#txt', 'y'.repeat(3700)); check(await pg.isVisible('#cnt') && /3,700 \/ 4,000/.test(await pg.textContent('#cnt')), `S9 counter near the limit: ${await pg.textContent('#cnt')}`);
    const long = 'Site notes. '.repeat(400);   // 4,800 characters
    await pg.fill('#txt', long); check(/too long for one message/.test(await pg.textContent('#cnt')), 'S9 over the limit the counter says so');
    const before = await pg.$$eval('#msgs .msg', (x) => x.length);
    await pg.press('#txt', 'Enter'); await pg.waitForSelector('#askyes');
    check(/4,79\d characters.*up to 4,000.*text file/.test(await pg.textContent('.askp')), `S9 Send offers a text file: ${await pg.textContent('.askp')}`);
    await pg.click('#askyes'); await pg.waitForFunction((n) => document.querySelectorAll('#msgs .msg').length > n, before, { timeout: 8000 });
    const last = await pg.$$eval('#msgs .msg', (x) => x[x.length - 1].textContent);
    check(/message-\d{12}\.txt/.test(last), 'S9 sent as message-….txt: ' + last.replace(/\s+/g, ' ').slice(0, 120));
    check(await pg.inputValue('#txt') === '', 'S9 the box is cleared');
    await pg.close(); }

  // ---- S49: the phone's Back button
  { const pg = await b.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true }); pg.on('pageerror', (e) => errs.push(e.message));
    await pg.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
    const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'alex@sample.test', aud: 'authenticated', role: 'authenticated' };
    await pg.route('https://fake.supabase.test/**', (r) => {
      const u = new URL(r.request().url()); const p = u.pathname;
      const json = (body) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      if (p === '/auth/v1/token') return json({ access_token: 'x.y.z', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
      if (p === '/auth/v1/user') return json(user);
      if (p === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'member', job_role: 'staff', display_name: 'Alex', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'X', company_code: 'RIY-7K3M-Q2', kind: 'business' } }]);
      if (p === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex', role: 'member', job_role: 'staff', extension: 101 }]);
      if (p === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }, { id: 'c2', kind: 'channel', name: 'jobs', topic: null }]);
      return json([]);
    });
    await pg.goto(BASE + '/link/'); await pg.waitForSelector('#gf');
    await pg.fill('#gf input[name=email]', user.email); await pg.fill('#gf input[name=password]', 'pw-12345678'); await pg.click('#gf button[type=submit]');
    await pg.waitForSelector('.hco'); await pg.click('#hchat'); await pg.waitForSelector('#lkshell');
    const pane = () => pg.evaluate(() => (document.querySelector('.hco') ? 'home' : document.getElementById('lkshell').classList.contains('inchat') ? 'conversation' : 'list'));
    check(await pane() === 'list', 'S49 Open -> the chat list');
    await pg.click('#side [data-ch="c1"]'); await pg.waitForTimeout(300);
    check(await pane() === 'conversation', 'S49 tap #general -> the conversation');
    await pg.goBack(); await pg.waitForTimeout(300);
    check(await pane() === 'list' && pg.url().includes('/link/'), 'S49 Back -> the chat list (still in Link)');
    await pg.goBack(); await pg.waitForTimeout(500);
    check(await pane() === 'home' && pg.url().includes('/link/'), 'S49 Back again -> the Riyeser home');
    await pg.goForward(); await pg.waitForTimeout(400); check(await pane() === 'list', 'S49 Forward -> the chat list again');
    // the in-page back arrow and the phone's Back agree
    await pg.click('#side [data-ch="c2"]'); await pg.waitForTimeout(300);
    await pg.click('#mhead .back'); await pg.waitForTimeout(400); check(await pane() === 'list', 'S49 the in-page back arrow -> the list');
    await pg.goBack(); await pg.waitForTimeout(400); check(await pane() === 'home', 'S49 ...and the phone\'s Back then -> home (no extra step)');
    await pg.close(); }

  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} CHAT CHECK(S) FAILED` : 'ALL CHAT CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
