// Help requests and refunds on Riyeser home, against a pretend Supabase:
//  1. riyeser.com/link/?help opens "Get help" straight after sign-in; the request is sent; Riyeser replies; the customer reads it and replies.
//  2. An owner asks for a refund; it shows under "Your refund requests".
//  3. Before team-chat.sql is re-run (the new functions are missing): nothing breaks, the new parts hide, Get help points to the Help Centre.
//  4. A closed business: a plain message at sign-in.
//  5. Phone width: no sideways scrolling. Run: build the site, serve website/public on 8090, then `node website/team/test/help-test.js <shots>`.
const { chromium, devices } = require('playwright');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
const NEW_RPCS = ['touch_activity', 'my_closed_businesses', 'my_tickets', 'my_ticket', 'open_ticket', 'reply_ticket', 'my_refunds', 'request_refund'];

async function fakeServer(page, opts = {}) {
  const st = { tickets: [], refunds: [], calls: [], staffReplied: false };
  await page.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  await page.route('https://fake.supabase.test/**', async (r) => {
    const u = new URL(r.request().url()); const m = r.request().method(); const fn = u.pathname.replace('/rest/v1/rpc/', '');
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const body = JSON.parse(r.request().postData() || '{}');
    if (u.pathname.startsWith('/rest/v1/rpc/')) st.calls.push(fn);
    if (opts.oldDatabase && NEW_RPCS.includes(fn)) return json({ code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` }, 404);
    if (u.pathname === '/auth/v1/token') return json({ access_token: token(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (u.pathname === '/auth/v1/user') return json(user);
    if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json(opts.closed ? [] : [{ role: 'owner', job_role: 'owner', display_name: 'Alex Sample', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business', country: 'Fiji' } }]);
    if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex Sample', role: 'owner', job_role: 'owner', extension: 101 }]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    if (fn === 'my_closed_businesses') return json(opts.closed ? [{ id: 'w1', name: 'Sample Plumbing', status: 'closed' }] : []);
    if (fn === 'company_licence') return json({ modules: { basic: { status: 'active', active: true, paid_until: '2027-06-30', days_left: 200 }, pos: { status: 'trial', active: true, trial_ends: '2026-12-08', days_left: 14 } }, seats: { included: 3, extra: 0, used: 1 } });
    if (fn === 'my_tickets') return json(st.tickets.map((t) => ({ ...t, unread: st.staffReplied && !t.read ? 1 : 0, status: st.staffReplied && t.status === 'new' ? 'waiting_customer' : t.status })));
    if (fn === 'open_ticket') { const t = { id: 't1', ref: 'T-10234', subject: body.help_subject, topic: body.help_topic, status: 'new', mine: true, business: 'Sample Plumbing', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), first: body.message, ws: body.ws };
      st.tickets.unshift(t); return json({ id: 't1', ref: 'T-10234' }); }
    if (fn === 'my_ticket') { const t = st.tickets.find((x) => x.id === body.ticket); t.read = true;
      const msgs = [{ id: 1, staff: false, mine: true, from: 'Alex Sample', body: t.first, at: t.created_at }];
      if (st.staffReplied) msgs.push({ id: 2, staff: true, mine: false, from: 'Riyeser Support', body: 'Thanks Alex. Turn the printer off and on, then print a test page from POS → Settings.', at: new Date().toISOString() });
      (t.replies || []).forEach((x, i) => msgs.push({ id: 3 + i, staff: false, mine: true, from: 'Alex Sample', body: x, at: new Date().toISOString() }));
      return json({ id: t.id, ref: t.ref, subject: t.subject, status: t.status === 'new' && st.staffReplied ? 'waiting_customer' : t.status, messages: msgs }); }
    if (fn === 'reply_ticket') { const t = st.tickets.find((x) => x.id === body.ticket); (t.replies = t.replies || []).push(body.message); t.status = 'waiting_us'; return json(null); }
    if (fn === 'my_refunds') return json(st.refunds);
    if (fn === 'request_refund') { st.lastRefund = body; st.refunds.unshift({ id: 'f1', ref: 'R-1042', for_what: body.for_what, period: body.period, amount: body.amount, currency: body.currency, status: 'submitted', created_at: new Date().toISOString() });
      return json({ id: 'f1', ref: 'R-1042', ticket_ref: 'T-10235' }); }
    return json([]);
  });
  return st;
}
const signIn = async (pg, url) => { await pg.goto(url); await pg.waitForSelector('#gf'); await pg.fill('input[name=email]', user.email); await pg.fill('input[name=password]', 'a-good-password'); await pg.click('button[type=submit]'); };

(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.';
  // 1. ?help after sign-in
  const pg = await b.newPage({ viewport: { width: 1280, height: 900 } }); pg.on('pageerror', (e) => errs.push(e.message));
  const st = await fakeServer(pg);
  await signIn(pg, 'http://127.0.0.1:8090/link/?help'); await pg.waitForSelector('#ghf');
  console.log('?help opened:', (await pg.textContent('.mcard h3')).trim(), '|', (await pg.textContent('.mcard p')).trim());
  console.log('topics:', await pg.evaluate(() => [...document.querySelectorAll('#ghf select option')].map((o) => o.textContent)));
  await pg.selectOption('#ghf select[name=topic]', 'program'); await pg.fill('#ghf input[name=subject]', 'The receipt printer stopped working');
  await pg.fill('#ghf textarea', 'Since this morning nothing prints from POS.'); await pg.click('#ghf .btn.p'); await pg.waitForSelector('#ok');
  console.log('sent:', (await pg.textContent('.mcard')).replace(/\s+/g, ' ').trim(), '| ws sent:', st.tickets[0].ws, '| url now:', await pg.evaluate(() => location.search || '(none)'));
  st.staffReplied = true; await pg.click('#ok'); await pg.waitForSelector('.htk');
  console.log('home list:', (await pg.textContent('.htk')).replace(/\s+/g, ' ').trim(), '| help badge:', await pg.textContent('.hsec .badge'));
  console.log('plan shows dates:', await pg.evaluate(() => [...document.querySelectorAll('.hplan:not(.htix) > div')].map((x) => x.innerText.replace(/\s+/g, ' ')).join(' | ')));
  await pg.screenshot({ path: out + '/help-home.png', fullPage: true });
  await pg.click('.htk'); await pg.waitForSelector('.tconv');
  console.log('conversation:', await pg.evaluate(() => [...document.querySelectorAll('.tmsg')].map((x) => x.querySelector('small').textContent.split(' · ')[0] + ': ' + x.querySelector('div').textContent)));
  await pg.fill('#trf textarea', 'Done that, still nothing.'); await pg.click('#trf .btn.p'); await pg.waitForTimeout(400);
  console.log('after reply:', await pg.evaluate(() => [...document.querySelectorAll('.tmsg div')].map((x) => x.textContent).pop()), '| status pill:', (await pg.textContent('.mcard .pl')).trim());
  await pg.screenshot({ path: out + '/help-ticket.png' });
  await pg.click('#cl'); await pg.waitForSelector('.htk');
  // 2. refund
  await pg.click('#hrefund'); await pg.waitForSelector('#rff');
  console.log('refund form:', (await pg.textContent('.mcard p')).trim());
  await pg.selectOption('#rff select[name=for_what]', 'POS'); await pg.fill('#rff input[name=period]', 'November 2026'); await pg.fill('#rff input[name=amount]', '45');
  await pg.selectOption('#rff select[name=reason_category]', 'duplicate'); await pg.fill('#rff textarea', 'We were charged twice.'); await pg.click('#rff .btn.p'); await pg.waitForSelector('#ok');
  console.log('refund sent:', (await pg.textContent('.mcard')).replace(/\s+/g, ' ').trim(), '| sent:', JSON.stringify(st.lastRefund));
  await pg.click('#ok'); await pg.waitForSelector('.hrf');
  console.log('refund list:', (await pg.textContent('.hrf')).replace(/\s+/g, ' ').trim());
  console.log('touch_activity called once:', st.calls.filter((c) => c === 'touch_activity').length);
  // 3. the live database before team-chat.sql is re-run
  const p2 = await b.newPage({ viewport: { width: 1280, height: 900 } }); p2.on('pageerror', (e) => errs.push('old db: ' + e.message));
  await fakeServer(p2, { oldDatabase: true }); await signIn(p2, 'http://127.0.0.1:8090/link/'); await p2.waitForSelector('.hco');
  console.log('old database -> home works:', await p2.textContent('.hco h2'), '| help requests hidden:', !(await p2.$('.htix')), '| refund button hidden:', !(await p2.$('#hrefund')));
  await p2.click('#hhelp'); await p2.waitForSelector('.mcard'); console.log('old database -> Get help:', (await p2.textContent('.mcard p')).trim());
  // 4. a closed business
  const p3 = await b.newPage({ viewport: { width: 1000, height: 800 } }); p3.on('pageerror', (e) => errs.push('closed: ' + e.message));
  await fakeServer(p3, { closed: true }); await signIn(p3, 'http://127.0.0.1:8090/link/'); await p3.waitForSelector('#gh');
  console.log('closed business:', (await p3.textContent('.gcard h1')).trim(), '|', (await p3.textContent('.gcard p')).trim());
  await p3.click('#gh'); await p3.waitForSelector('#ghf'); console.log('closed -> can still ask for help:', !!(await p3.$('#ghf')));
  // 5. phone
  const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
  const sp = await fakeServer(ph); sp.tickets.push({ id: 't1', ref: 'T-10234', subject: 'A rather long subject about the receipt printer that stopped working this morning', status: 'waiting_customer', mine: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), first: 'x' });
  sp.staffReplied = true; await signIn(ph, 'http://127.0.0.1:8090/link/'); await ph.waitForSelector('.htk');
  console.log('phone home overflow:', await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  await ph.screenshot({ path: out + '/help-phone.png', fullPage: true });
  await ph.click('#hrefund'); await ph.waitForSelector('#rff'); console.log('phone refund form overflow:', await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  // the demo: ?demo&help opens it too
  const p4 = await b.newPage(); p4.on('pageerror', (e) => errs.push('demo: ' + e.message));
  await p4.goto('http://127.0.0.1:8090/link/?demo&help'); await p4.waitForSelector('#ghf'); console.log('demo ?help opens Get help:', !!(await p4.$('#ghf')));
  console.log('errors:', errs); await b.close();
})();
