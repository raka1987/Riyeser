// Help requests and refunds on Riyeser home, against a pretend Supabase:
//  1. riyeser.com/link/?help opens "Get help" straight after sign-in; the request is sent; Riyeser replies; the customer reads it and replies.
//  2. An owner asks for a refund; it shows under "Your refund requests".
//  3. Before team-chat.sql is re-run (the new functions are missing): nothing breaks, the new parts hide, Get help points to the Help Centre.
//  4. A closed business: a plain message at sign-in.
//  5. A message Riyeser started (HQ's "Message customer") shows as "Message from Riyeser" and can be answered; "Your details" (name, phone) can be changed.
//  6. Report an issue (product, what happened, work blocked, an optional DG- reference; no logs); "We'll update you by";
//     Still having an issue; Confirm fixed, then "How did we do?" (1 to 5, optional comment); ?help#T-… (the email link) opens the request.
//  7. Phone width: no sideways scrolling. Run: build the site, serve website/public on 8090, then `node website/team/test/help-test.js <shots>`.
const { chromium, devices } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';   // LINK_BASE=http://127.0.0.1:8091 to use another port
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
const NEW_RPCS = ['touch_activity', 'my_closed_businesses', 'my_tickets', 'my_ticket', 'open_ticket', 'reply_ticket', 'my_refunds', 'request_refund',
  'support_report', 'ticket_still_issue', 'ticket_confirm_fixed', 'ticket_rate'];

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
    if (u.pathname === '/auth/v1/user' && m === 'PUT') { st.userUpdate = body; return json({ ...user, user_metadata: body.data }); }
    if (u.pathname === '/auth/v1/user') return json(user);
    if (u.pathname === '/rest/v1/members' && m === 'PATCH') { st.memberUpdate = { body, query: u.search }; return json([]); }
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
      const status = t.status === 'new' && st.staffReplied ? 'waiting_customer' : t.status;
      return json({ id: t.id, ref: t.ref, subject: t.subject, from_riyeser: !!t.from_riyeser, status, messages: msgs,
        ...(t.fresh ? { who_acts: status === 'done' ? null : status === 'waiting_customer' ? 'customer' : 'riyeser', product: t.product, diag_ref: t.diag_ref, next_update_due: t.next_update_due || null, rating: t.rating || null } : {}) }); }
    if (fn === 'support_report') { const p = body.payload; st.lastReport = { ws: body.ws, payload: p }; const n = st.tickets.length;
      const t = { id: 'r' + n, ref: 'T-' + (10241 + n), subject: 'Payroll: ' + p.what_happened.split('\n')[0], topic: 'program', status: 'new', mine: true, fresh: true, product: p.product, diag_ref: p.diag_ref || 'DG-4830',
        business: 'Sample Plumbing', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), first: p.what_happened };
      st.tickets.unshift(t); return json({ id: t.id, ref: t.ref, diag_ref: t.diag_ref, diag_id: 'd1' }); }
    const tk = st.tickets.find((x) => x.id === body.ticket);
    if (fn === 'ticket_still_issue') { st.lastStill = body; tk.status = 'waiting_us'; (tk.replies = tk.replies || []).push('Still having an issue.' + (body.message ? '\n\n' + body.message : '')); return json(null); }
    if (fn === 'ticket_confirm_fixed') { tk.status = 'done'; (tk.replies = tk.replies || []).push('Confirmed fixed. Thanks!'); return json(null); }
    if (fn === 'ticket_rate') { if (tk.status !== 'done') return json({ code: 'P0001', message: 'You can rate this once it\'s resolved.' }, 400); tk.rating = body.stars; st.lastRate = body; return json(null); }
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
  await signIn(pg, BASE + '/link/?help'); await pg.waitForSelector('#ghf');
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
  // 5. a message from Riyeser, and Your details
  st.tickets.push({ id: 't9', ref: 'T-10240', subject: 'Your POS trial is nearly up', topic: 'billing', status: 'waiting_customer', mine: true, from_riyeser: true, business: 'Sample Plumbing',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), first: 'Hi Alex, would you like a hand choosing a plan?' });
  await pg.reload(); await pg.waitForSelector('.htk');
  const riy = await pg.evaluate(() => [...document.querySelectorAll('.htk')].map((x) => x.innerText.replace(/\s+/g, ' ')).find((x) => x.includes('Your POS trial')));
  console.log('message from Riyeser:', riy);
  await pg.click('.htk:has-text("Your POS trial")'); await pg.waitForSelector('.tconv');
  console.log('opened:', (await pg.textContent('.mcard p.small')).replace(/\s+/g, ' ').trim());
  await pg.fill('#trf textarea', 'Yes please, call me tomorrow.'); await pg.click('#trf .btn.p'); await pg.waitForTimeout(300);
  console.log('customer replied:', JSON.stringify(st.tickets.find((x) => x.id === 't9').replies)); await pg.click('#cl');
  console.log('your details:', (await pg.textContent('#hmyd')).replace(/\s+/g, ' ').trim());
  await pg.click('#hmine'); await pg.waitForSelector('#mdf'); await pg.fill('#mdf [name=name]', 'Alex Sample-Smith'); await pg.fill('#mdf [name=phone]', '+679 330 9999'); await pg.click('#mdf .btn.p'); await pg.waitForTimeout(400);
  console.log('saved: name ->', JSON.stringify(st.memberUpdate), '| phone ->', JSON.stringify(st.userUpdate), '| card:', (await pg.textContent('#hmyd')).replace(/\s+/g, ' ').trim());
  // 6. Report an issue, the promised update, Still having an issue, Confirm fixed and the rating
  const bad = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad.push(what); };
  const txt = async (sel) => (await pg.textContent(sel)).replace(/\s+/g, ' ').trim();
  await pg.click('#hreport'); await pg.waitForSelector('#rif');
  const fields = await pg.$$eval('#rif [name]', (x) => x.map((e) => e.name + (e.type === 'radio' ? ':' + e.value : '')));
  console.log('Report an issue fields:', fields.join(', '));
  check(['product', 'what', 'blocked:yes', 'blocked:no', 'diag'].every((f) => fields.includes(f)) && !fields.some((f) => /log/i.test(f)), 'Report an issue: product, what happened, work blocked Yes/No, DG- reference, no logs');
  check((await pg.$$eval('#rif [name=product] option', (o) => o.map((x) => x.value))).join() === ',central,accounting,invoices,pos,bookings,payroll,link,linkoffice,pdf,desk,website,other', 'every product');
  await pg.selectOption('#rif [name=product]', 'payroll'); await pg.fill('#rif [name=what]', 'Payroll export times out after the update'); await pg.check('#rif input[value=yes]');
  await pg.fill('#rif [name=diag]', 'X-1'); await pg.click('#rif .btn.p'); await pg.waitForSelector('#rierr .err'); check((await txt('#rierr')).includes('It looks like DG-4821'), 'a wrong reference is caught');
  await pg.fill('#rif [name=diag]', 'dg-4821'); await pg.fill('#rif [name=version]', '2.8.1'); await pg.click('#rif .btn.p'); await pg.waitForSelector('#see');
  const thanks = await txt('.mcard'); console.log('sent:', thanks, '|', JSON.stringify(st.lastReport));
  check(/^✅ Thanks — your request number is T-\d+\.\s*Reference DG-4821\./.test(thanks), '"Thanks — your request number is T-…. Reference DG-4821."');
  const lr = st.lastReport.payload; check(st.lastReport.ws === 'w1' && lr.product === 'payroll' && lr.blocked === true && lr.diag_ref === 'DG-4821' && lr.source === 'web' && lr.product_version === '2.8.1' && !('log_lines' in lr), 'sent: product, blocked, reference, no logs');
  const ref = thanks.match(/T-\d+/)[0]; const rt = st.tickets.find((x) => x.ref === ref);
  await pg.click('#see'); await pg.waitForSelector('#tsays');
  console.log('status words:', await txt('#tsays')); check((await txt('.mcard p.small')).includes('Diagnostic reference DG-4821') && (await txt('.mcard p.small')).includes('Payroll'), 'the request shows the product and reference');
  check(!!(await pg.$('#tstill')) && !!(await pg.$('#tfixed')) && (await txt('#treply')) === 'Reply', 'buttons: Reply, Still having an issue, Confirm fixed');
  check(!(await pg.$('#rtf')), 'no rating before it\'s resolved');
  await pg.click('#cl'); rt.next_update_due = await pg.evaluate(() => { const d = new Date(Date.now() + 864e5); d.setHours(15, 0, 0, 0); return d.toISOString(); });
  await pg.waitForSelector('.htk'); await pg.reload(); await pg.waitForSelector('.htk');
  const li = await pg.evaluate((r) => [...document.querySelectorAll('.htk')].map((x) => x.innerText.replace(/\s+/g, ' ')).find((x) => x.includes(r)), ref);
  console.log('list:', li); check(/We'll update you by 3:00 pm \w{3}/.test(li), 'the list says "We\'ll update you by …"');
  await pg.click(`.htk:has-text("${ref}")`); await pg.waitForSelector('#tsays'); check(/We'll update you by 3:00 pm \w{3}\./.test(await txt('#tsays')), 'so does the request');
  await pg.fill('#trf textarea', 'Updated to 2.8.2, still times out.'); await pg.click('#tstill'); await pg.waitForSelector('.okmsg');
  console.log('still:', await txt('.okmsg'), JSON.stringify(st.lastStill)); check(st.lastStill.message === 'Updated to 2.8.2, still times out.' && (await txt('.mcard p.small')).includes('With Riyeser'), 'Still having an issue: back with Riyeser');
  await pg.click('#tfixed'); await pg.waitForSelector('#rtf'); console.log('fixed:', await txt('.okmsg'), '|', await txt('#tsays'));
  check((await txt('.mcard p.small')).includes('Resolved') && !(await pg.$('#tfixed')) && (await txt('#rtf')).startsWith('How did we do?'), 'Confirm fixed: resolved, then "How did we do?"');
  await pg.screenshot({ path: out + '/help-rate.png' });
  await pg.click('#rtf .btn.p'); check((await txt('#rterr')).includes('Choose 1 to 5 stars'), 'stars needed (or No thanks)');
  await pg.click('#rtf .starpick label:nth-child(4)'); await pg.fill('#rtf [name=comment]', 'Quick and clear, thanks'); await pg.click('#rtf .btn.p'); await pg.waitForSelector('#rated');
  console.log('rated:', await txt('#rated'), JSON.stringify(st.lastRate)); check(st.lastRate.stars === 4 && st.lastRate.comment === 'Quick and clear, thanks', 'rating and comment stored');
  await pg.click('#cl');
  // the email's link: riyeser.com/link/?help#T-… opens that request after sign-in
  const p6 = await b.newPage({ viewport: { width: 1280, height: 900 } }); p6.on('pageerror', (e) => errs.push('email link: ' + e.message));
  const s6 = await fakeServer(p6); s6.tickets.push({ id: 't7', ref: 'T-10250', subject: 'Leave balance not updating', status: 'waiting_customer', mine: true, fresh: true, product: 'payroll', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), first: 'Leave didn\'t change.' });
  await signIn(p6, BASE + '/link/?help#T-10250'); await p6.waitForSelector('.tconv');
  check((await p6.textContent('.mcard h3')).trim() === 'Leave balance not updating' && !(await p6.$('#ghf')), '?help#T-10250 opens that request');

  // 3. the live database before team-chat.sql is re-run
  const p2 = await b.newPage({ viewport: { width: 1280, height: 900 } }); p2.on('pageerror', (e) => errs.push('old db: ' + e.message));
  await fakeServer(p2, { oldDatabase: true }); await signIn(p2, BASE + '/link/'); await p2.waitForSelector('.hco');
  console.log('old database -> home works:', await p2.textContent('.hco h2'), '| help requests hidden:', !(await p2.$('.htix')), '| refund button hidden:', !(await p2.$('#hrefund')));
  check(!(await p2.$('#hreport')), 'old database: Report an issue hidden');
  await p2.click('#hhelp'); await p2.waitForSelector('.mcard'); console.log('old database -> Get help:', (await p2.textContent('.mcard p')).trim());
  // 4. a closed business
  const p3 = await b.newPage({ viewport: { width: 1000, height: 800 } }); p3.on('pageerror', (e) => errs.push('closed: ' + e.message));
  await fakeServer(p3, { closed: true }); await signIn(p3, BASE + '/link/'); await p3.waitForSelector('#gh');
  console.log('closed business:', (await p3.textContent('.gcard h1')).trim(), '|', (await p3.textContent('.gcard p')).trim());
  await p3.click('#gh'); await p3.waitForSelector('#ghf'); console.log('closed -> can still ask for help:', !!(await p3.$('#ghf')));
  // 5. phone
  const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
  const sp = await fakeServer(ph); sp.tickets.push({ id: 't1', ref: 'T-10234', subject: 'A rather long subject about the receipt printer that stopped working this morning', status: 'waiting_customer', mine: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), first: 'x' });
  sp.staffReplied = true; await signIn(ph, BASE + '/link/'); await ph.waitForSelector('.htk');
  console.log('phone home overflow:', await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  await ph.screenshot({ path: out + '/help-phone.png', fullPage: true });
  await ph.click('#hrefund'); await ph.waitForSelector('#rff'); console.log('phone refund form overflow:', await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  await ph.evaluate(() => document.querySelector('#rff #cl').click()); await ph.click('#hreport'); await ph.waitForSelector('#rif'); const ro = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await ph.screenshot({ path: out + '/help-report-phone.png' }); check(ro <= 0, 'phone: Report an issue fits (overflow ' + ro + ')');
  // the demo: ?demo&help opens it too
  const p4 = await b.newPage(); p4.on('pageerror', (e) => errs.push('demo: ' + e.message));
  await p4.goto(BASE + '/link/?demo&help'); await p4.waitForSelector('#ghf'); console.log('demo ?help opens Get help:', !!(await p4.$('#ghf')));
  console.log('errors:', errs); check(!errs.length, 'no page errors'); await b.close();
  console.log(bad.length ? `\n${bad.length} FAILED` : '\nALL HELP TESTS PASSED'); process.exit(bad.length ? 1 : 0);
})();
