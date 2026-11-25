// Joining and leaving a business, against a pretend Supabase (S7, S8, S59):
//   S7  an owner without two-step sign-in still sees how many are waiting (bell, Join requests, the home), and the email's
//       link (?requests) opens Join requests (two-step set-up first when it's off)
//   S8  the invite link says "Join {business} on Riyeser"; the join form has the person's name already
//   S59 someone removed sees "You're no longer part of {business}" instead of a bare set-up screen; their old messages show
//       "{name} (left)"; an empty name on the join form says what's missing
//   S3  help without signing in: ?help signed out offers it first, the sign-in page links to it, ?contact (the website's
//       Contact support) opens it; it sends guest_ticket and shows the request number; missing details are named
//   M4  the sign-up country is this computer's (time zone or language), or blank: not Fiji for everyone
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/people-test.js`. Exits 1 on failure.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function server(st) {
  const token = (aal) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: st.user.id, aal, amr: [{ method: 'password', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
  return async (r) => {
    const u = new URL(r.request().url()); const m = r.request().method(); const p = u.pathname;
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const body = () => { try { return JSON.parse(r.request().postData() || '{}'); } catch { return {}; } };
    st.calls.push(m + ' ' + p);
    if (p === '/auth/v1/token') return json({ access_token: token('aal1'), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: st.user });
    if (p === '/auth/v1/user') return json(st.user);
    if (p === '/rest/v1/rpc/guest_ticket') { st.guest = body(); if (st.guestFail) return json({ code: 'P0001', message: 'You\'ve sent a few help requests already. We\'ll reply to them by email soon.' }, 400); return json({ ref: 'T-10260' }); }
    if (p === '/rest/v1/rpc/invite_info') { st.inviteAsked = body().code; return json(body().code === 'RIY-7K3M-Q2' ? { name: 'Sample Plumbing' } : null); }
    if (p === '/rest/v1/members' && u.search.includes('workspaces')) return json(st.member ? [{ role: st.role, job_role: st.role, display_name: 'Alex', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business' } }] : []);
    if (p === '/rest/v1/members') return json([{ user_id: st.user.id, display_name: 'Alex', role: st.role, job_role: st.role, extension: 101 }]);
    if (p === '/rest/v1/rpc/join_request_count') return json(2);
    if (p === '/rest/v1/join_requests') return json([]);   // names need two-step sign-in (the database returns none)
    if (p === '/rest/v1/rpc/former_members') return json([{ user_id: 'gone-1', display_name: 'Sam Taylor' }]);
    if (p === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    if (p === '/rest/v1/messages' && m === 'GET') return json([{ id: 'm1', channel_id: 'c1', workspace_id: 'w1', user_id: 'gone-1', body: 'Van 2 is booked in', created_at: new Date(Date.now() - 3600e3).toISOString(), edited_at: null, deleted: false }]);
    if (p === '/rest/v1/rpc/request_join') { st.joinBody = body(); return json({ status: 'pending', company_name: 'Sample Plumbing', workspace_id: 'w1' }); }
    if (p === '/rest/v1/rpc/my_join_requests') return json(st.joinBody ? [{ id: 'r1', workspace_id: 'w1', company_name: 'Sample Plumbing', status: 'pending' }] : []);
    if (p === '/rest/v1/rpc/my_billing') return json(null);
    if (p === '/auth/v1/factors' && m === 'POST') return json({ id: 'f9', type: 'totp', totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg"/>', secret: 'X', uri: '' } });
    return json([]);
  };
}
async function page(b, st, errs, w = 1200) {
  const pg = await b.newPage({ viewport: { width: w, height: 850 } });
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  await pg.route('https://fake.supabase.test/**', server(st));
  return pg;
}
async function signIn(pg, path = '/link/') {
  await pg.goto(BASE + path); await pg.waitForSelector('#gf');
  await pg.fill('#gf input[name=email]', 'alex@sample.test'); await pg.fill('#gf input[name=password]', 'right-password'); await pg.click('#gf button[type=submit]');
}

(async () => {
  const b = await chromium.launch(); const errs = [];
  const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'alex@sample.test', aud: 'authenticated', role: 'authenticated', user_metadata: { riyeser_signup: { you: 'Alex Nguyen', joining: true } } };

  // ---- S7: owner without two-step sign-in
  { const st = { user, member: true, role: 'owner', calls: [] }; const pg = await page(b, st, errs);
    await signIn(pg, '/link/?requests'); await pg.waitForSelector('.hco');
    check(/Requests\s*2/.test(await pg.textContent('#hreq')), 'S7 home: Requests shows 2 waiting before two-step sign-in');
    await pg.waitForSelector('.mcard #vf', { timeout: 5000 }); check(true, 'S7 the ?requests link from the email opens two-step set-up first (names need it)');
    check(!(await pg.evaluate(() => location.search)).includes('requests'), 'S7 the address is tidied');
    await pg.click('.mcard #cl'); await pg.click('#hchat'); await pg.waitForSelector('#bellc');
    check(await pg.textContent('#bellc') === '2' && await pg.isVisible('#bellc'), 'S7 the bell counts the 2 join requests');
    await pg.click('#bell'); check(/2 join requests/.test(await pg.textContent('.bellmenu, #bellmenu, .popmenu').catch(() => pg.textContent('body'))), 'S7 the bell menu says "2 join requests"');
    // S59b: the removed person's message keeps their name
    await pg.keyboard.press('Escape');
    check(/Sam Taylor \(left\)/.test(await pg.textContent('#msgs')), 'S59 a removed person\'s message shows "Sam Taylor (left)"');
    check(!/Someone who left/.test(await pg.textContent('#msgs')), 'S59 ...not "Someone who left"');
    await pg.close(); }

  // ---- S8: the invite link
  { const st = { user, member: false, role: 'member', calls: [] }; const pg = await page(b, st, errs, 390);
    await pg.goto(BASE + '/link/?join=RIY-7K3M-Q2&signup'); await pg.waitForSelector('#ginv:not([hidden])', { timeout: 5000 });
    check(/Join Sample Plumbing on Riyeser/.test(await pg.textContent('#ginv')), 'S8 invite page: "Join Sample Plumbing on Riyeser"');
    await signIn(pg, '/link/?join=RIY-7K3M-Q2'); await pg.waitForSelector('#jf');
    await pg.waitForFunction(() => /Join Sample Plumbing on Riyeser/.test(document.querySelector('#jfh').textContent));
    check(true, 'S8 the join form is headed "Join Sample Plumbing on Riyeser"');
    check(await pg.inputValue('#jf [name=you]') === 'Alex Nguyen', 'S8 the join form has their name already');
    // S59c: empty name -> says what's missing
    await pg.fill('#jf [name=you]', ''); await pg.click('#jf button.p');
    await pg.waitForSelector('#jferr .err'); check(/Type your name/.test(await pg.textContent('#jferr')), 'S59 an empty name says what\'s missing');
    check(!st.joinBody, 'S59 ...and nothing is sent');
    await pg.fill('#jf [name=you]', 'Alex Nguyen'); await pg.click('#jf button.p'); await pg.waitForSelector('.waitdots');
    check(st.joinBody && st.joinBody.your_name === 'Alex Nguyen', 'S8 asking to join sends the name');
    await pg.close(); }

  // ---- S59a: removed since last time
  { const st = { user, member: true, role: 'member', calls: [] }; const pg = await page(b, st, errs);
    await signIn(pg); await pg.waitForSelector('.hco'); st.member = false;   // the owner removes them
    await pg.reload(); await pg.waitForSelector('#gonenote', { timeout: 8000 });
    check(/no longer part of Sample Plumbing.*Ask the owner if this is a mistake/.test(await pg.textContent('#gonenote')), 'S59 removed: "You\'re no longer part of Sample Plumbing. Ask the owner…"');
    await pg.reload(); await pg.waitForSelector('.gcard'); await pg.waitForTimeout(300);
    check(!(await pg.$('#gonenote')), 'S59 said once');
    await pg.close(); }

  // ---- S3: help without signing in
  { const st = { user, member: false, role: 'member', calls: [] }; const pg = await page(b, st, errs, 390);
    await pg.goto(BASE + '/link/?help'); await pg.waitForSelector('#gf .ghelp');
    check(/You don't have to sign in/.test(await pg.textContent('.ghelp')), 'S3 ?help signed out: help without signing in is offered first');
    await pg.click('#gcontact1'); await pg.waitForSelector('#ctf');
    await pg.click('#ctf button[type=submit]'); await pg.waitForSelector('#ctf .err'); check(/Type your name/.test(await pg.textContent('#ctf .err')), 'S3 missing name is named');
    await pg.fill('#ctf [name=name]', 'Mere Guest'); await pg.fill('#ctf [name=email]', 'mere@'); await pg.click('#ctf button[type=submit]');
    await pg.waitForSelector('#ctf .err'); check(/email address/.test(await pg.textContent('#ctf .err')) && await pg.inputValue('#ctf [name=name]') === 'Mere Guest', 'S3 a bad email is named, typing kept');
    await pg.fill('#ctf [name=email]', 'mere@guest.test'); await pg.fill('#ctf [name=subject]', 'Can\'t sign in'); await pg.fill('#ctf [name=message]', 'I forgot which email I used.');
    await pg.click('#ctf button[type=submit]'); await pg.waitForSelector('#ctsent');
    check(/T-10260/.test(await pg.textContent('#ctsent')) && /mere@guest\.test/.test(await pg.textContent('#ctsent')), 'S3 sent: the request number and where the reply goes');
    check(st.guest && st.guest.your_email === 'mere@guest.test' && st.guest.help_topic === 'signin' && st.guest.message === 'I forgot which email I used.', 'S3 guest_ticket gets the details');
    await pg.click('#ctdone'); await pg.waitForSelector('#gf #gcontact'); check(true, 'S3 the sign-in page links to it ("Contact Riyeser support")');
    st.guestFail = true; await pg.goto(BASE + '/link/?contact'); await pg.waitForSelector('#ctf');
    check(true, 'S3 ?contact (Contact support on riyeser.com) opens the form');
    await pg.fill('#ctf [name=name]', 'Mere'); await pg.fill('#ctf [name=email]', 'mere@guest.test'); await pg.fill('#ctf [name=subject]', 'x'); await pg.fill('#ctf [name=message]', 'y');
    await pg.click('#ctf button[type=submit]'); await pg.waitForSelector('#ctf .err'); check(/a few help requests already/.test(await pg.textContent('#ctf .err')), 'S3 the limit reads plainly');
    const site = await pg.goto(BASE + '/help.html'); check(site.ok() && !!(await pg.$('a[href="/link/?contact"]')), 'S3 the website links to it (Help Centre and footer)');
    await pg.close(); }

  // ---- M4: the sign-up country
  for (const [tz, loc, want, dial] of [['Australia/Sydney', 'en-AU', 'Australia', '+61'], ['Pacific/Fiji', 'en-US', 'Fiji', '+679'], ['Europe/Berlin', 'de-DE', 'Germany', '+49'], ['UTC', 'en', '', '']]) {
    const ctx = await b.newContext({ timezoneId: tz, locale: loc, viewport: { width: 1000, height: 900 } }); const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(e.message));
    await pg.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
    await pg.goto(BASE + '/link/?signup'); await pg.waitForSelector('#gf select[name=country]');
    const v = await pg.inputValue('#gf select[name=country]'); const ph = await pg.getAttribute('#gf input[name=phone]', 'placeholder');
    check(v === want && (dial ? ph.includes(dial) : !/\+679/.test(ph)), `M4 ${tz} / ${loc}: country "${v || '(choose)'}", phone hint "${ph}"`);
    await ctx.close();
  }

  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} PEOPLE CHECK(S) FAILED` : 'ALL PEOPLE CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
