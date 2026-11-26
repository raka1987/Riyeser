// Riyeser Link chat details from the round-20 fix list, in the demo (?demo) at desktop and phone width:
//   S9  a long message: a counter near the limit; over 4,000 characters Send offers to send it as a .txt file (no raw
//       database error); the database's own refusal reads plainly
//   M9  "(edited)" on edited messages; your own extension says so; no channel call buttons until group calls; initials
//       without punctuation; "Seen" in direct messages
//   M27 a shared .exe (or other program) says "This is a program…" and asks before downloading; clicking a file's name opens it
//   M20 on a 390 px phone: the Riyeser ID on one line; Sign out, Copy and the home's buttons at least 44 px tall
//   S49 on a phone, Back from a conversation shows the chat list, and Back again the Riyeser home (against a pretend Supabase)
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/chat-test.js`. Exits 1 on failure.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (w, q = '') => { const pg = await b.newPage({ viewport: { width: w, height: 860 } }); pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${BASE}/link/?demo${q}`); await pg.waitForSelector('#lkshell'); return pg; };

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

  // ---- M9: wording
  { const pg = await open(1280);
    await pg.click('#callbtn'); await pg.waitForSelector('.callmenu');
    check(!(await pg.$('#vidbtn')) && !!(await pg.$('.callmenu [data-cw]')), 'M9 #general: Call lists one person at a time, no video (group calls aren\'t here yet)');
    await pg.keyboard.press('Escape');
    await pg.fill('#txt', 'Typo hree'); await pg.press('#txt', 'Enter'); await pg.waitForTimeout(200);
    await pg.hover('#msgs .msg:last-child'); await pg.click('#msgs .msg:last-child [data-act=edit]');
    await pg.fill('#msgs [data-edit] textarea', 'Typo here'); await pg.press('#msgs [data-edit] textarea', 'Enter'); await pg.waitForTimeout(200);
    check(/Typo here\s*\(edited\)/.test(await pg.textContent('#msgs .msg:last-child')), 'M9 an edited message says "(edited)"');
    await pg.click('[data-dm="u-sam"]'); await pg.click('#callbtn'); await pg.waitForSelector('#calldm');
    check(!!(await pg.$('#vidbtn')), 'M9 a direct message keeps Call and Video'); await pg.keyboard.press('Escape');
    await pg.fill('#txt', 'Are the timesheets done?'); await pg.press('#txt', 'Enter'); await pg.waitForTimeout(200);
    await pg.click('[data-dm="u-alex"]'); await pg.waitForTimeout(150); await pg.click('[data-dm="u-sam"]'); await pg.waitForSelector('#seen', { timeout: 4000 });
    check(true, 'M9 "Seen" under your message once they\'ve read it');
    await pg.click('[data-dm="u-alex"]'); await pg.fill('#txt', 'See you at 3'); await pg.press('#txt', 'Enter'); await pg.waitForTimeout(300);
    check(!(await pg.$('#seen')), 'M9 no "Seen" before they\'ve read it');
    await pg.click('#tbcalls'); await pg.waitForSelector('#vdn');
    await pg.fill('#vdn', '101'); await pg.dispatchEvent('#vdn', 'input'); check(await pg.textContent('#vdw') === 'That\'s your own extension', 'M9 dialling your own extension says so');
    await pg.fill('#vdn', '999'); await pg.dispatchEvent('#vdn', 'input'); check(await pg.textContent('#vdw') === 'No one on that number', 'M9 an unused number still says "No one on that number"');
    await pg.close(); }

  // ---- M27: files
  { const pg = await open(1280);
    await pg.click('[data-ch="c-jobs"]'); await pg.waitForSelector('.fcard');
    const got = Promise.race([pg.waitForEvent('download', { timeout: 5000 }).then(() => 'download'), pg.waitForEvent('popup', { timeout: 5000 }).then(() => 'popup')]).catch(() => 'nothing');
    await pg.click('.fcard button.fnm'); check(await got !== 'nothing', `M27 clicking a file's name opens it (${await got})`);
    await pg.setInputFiles('#file', { name: 'Invoice_viewer.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ not really a program') });
    await pg.waitForFunction(() => /Invoice_viewer\.exe/.test(document.getElementById('msgs').textContent), null, { timeout: 8000 });
    const last = await pg.$$eval('#msgs .msg', (x) => x[x.length - 1].textContent);
    check(/This is a program\. Only open it if you trust the sender\./.test(last), 'M27 an .exe says "This is a program. Only open it if you trust the sender."');
    await pg.click('#msgs .msg:last-child .fcard button.fnm'); await pg.waitForSelector('#askyes');
    check(/is a program/.test(await pg.textContent('.mcard')) && /Download anyway/.test(await pg.textContent('#askyes')), 'M27 opening it asks first ("Download anyway")');
    await pg.click('#askno'); check(!(await pg.$('#askyes')), 'M27 Cancel downloads nothing');
    const pdf = await pg.$$eval('.fcard .frisk', (x) => x.length); check(pdf === 1, 'M27 an ordinary PDF has no warning');
    await pg.close(); }

  // ---- M20: phone sizes on the Riyeser home
  { const pg = await b.newPage({ viewport: { width: 390, height: 844 } }); pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${BASE}/link/?demo&help`); await pg.waitForSelector('.hco'); await pg.evaluate(() => document.querySelectorAll('.modal').forEach((m) => m.remove()));
    const r = await pg.evaluate(() => { const c = document.querySelector('.cid .code'); return { h: c.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(c).lineHeight),
      small: [...document.querySelectorAll('#hout, #hcp, .hmine button, .hacts button')].filter((x) => x.getBoundingClientRect().height < 44).map((x) => x.textContent.trim()) }; });
    check(r.h < (r.lh || 28) * 1.5, `M20 the Riyeser ID is on one line (${Math.round(r.h)} px)`);
    check(!r.small.length, `M20 buttons at least 44 px tall ${r.small.join(', ')}`);
    check(await pg.evaluate(() => document.documentElement.scrollWidth) <= 390, 'M20 no sideways scrolling');
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
      if (p === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex', role: 'member', job_role: 'staff', extension: 101 }, { user_id: 'qa', display_name: '[AI TEST] Riyeser QA Staff', role: 'member', job_role: 'staff', extension: 102 }]);
      if (p === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }, { id: 'c2', kind: 'channel', name: 'jobs', topic: null }]);
      if (p === '/rest/v1/messages' && u.searchParams.get('channel_id') === 'eq.c1') return json([{ id: 'm1', channel_id: 'c1', workspace_id: 'w1', user_id: 'qa', body: 'Hello', created_at: new Date().toISOString(), edited_at: null, deleted: false }]);
      return json([]);
    });
    await pg.goto(BASE + '/link/'); await pg.waitForSelector('#gf');
    await pg.fill('#gf input[name=email]', user.email); await pg.fill('#gf input[name=password]', 'pw-12345678'); await pg.click('#gf button[type=submit]');
    await pg.waitForSelector('.hco'); await pg.click('#hchat'); await pg.waitForSelector('#lkshell');
    const pane = () => pg.evaluate(() => (document.querySelector('.hco') ? 'home' : document.getElementById('lkshell').classList.contains('inchat') ? 'conversation' : 'list'));
    check(await pane() === 'list', 'S49 Open -> the chat list');
    await pg.click('#side [data-ch="c1"]'); await pg.waitForTimeout(300);
    check(await pane() === 'conversation', 'S49 tap #general -> the conversation');
    check(await pg.textContent('#msgs .msg .av') === 'AT', `M9 initials skip punctuation: "[AI TEST] Riyeser QA Staff" -> ${await pg.textContent('#msgs .msg .av')}`);
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
