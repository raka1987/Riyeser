// PAYPAL-LIVE: "Add to my plan / Pay" once PayPal is live, for an owner who paid earlier with PayPal's practice site (sandbox),
// against a pretend Supabase and a pretend paypal function (status: ready, live). Desktop 1366 and phone 390.
//  1. A practice (sandbox) subscription doesn't block live: "Pay with PayPal" shows; no "You already pay by PayPal";
//     no "Online payments are opening soon"; no bank transfer button or bank wording while Riyeser's bank details aren't in.
//  2. Every ticked program still on its free trial: "Start paying when my free trial ends" (ticked) with "Nothing is charged
//     today. With PayPal, your first payment is on <trial end>"; or "Buy now: start my paid plan today": charged today,
//     "Your remaining free days (N) end today". The choice goes to the paypal function (buy_now), once on a double click.
//  3. Billing: "Practice payment (test): not a real subscription", no Manage in PayPal, no link to PayPal's practice site
//     anywhere; practice payments labelled "Practice payment (test)" in the history, no receipt; Remove asks first, then
//     calls billing_practice_cancel (Riyeser's side only), never the paypal function's cancel.
//  4. Buy now on each trial row of Your plan, and riyeser.com's ?buy=now, open the dialog with Buy now ticked.
//  5. "Opening soon" only when PayPal isn't ready AND bank transfer isn't set up; a real (live) subscription still says
//     "You already pay by PayPal", without bank wording.
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/paypal-live-test.js [shots]`.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const SHOTS = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', aud: 'authenticated', role: 'authenticated', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
const PRACTICE = { id: 'p1', ref: 'RI-10001', method: 'paypal', modules: ['basic'], module_names: ['Accounting Basics'], people: 3, billing: 'monthly', amount: 25, total: 25,
  status: 'active', paypal_env: 'sandbox', practice: true, paid_through: day(115), works_until: day(115), next_charge_at: day(115), next_amount: 25, created_at: day(-20) };
const REAL = { ...PRACTICE, id: 'l1', ref: 'RI-10009', paypal_env: 'live', practice: false };

async function open(b, errs, opts = {}) {
  const st = { calls: [], subscribes: [], quotes: [], cancels: 0 };
  const pg = await b.newPage({ viewport: { width: opts.width || 1366, height: 900 }, deviceScaleFactor: 1 }); pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  await pg.route('https://fake.supabase.test/**', async (r) => {
    const u = new URL(r.request().url()); const p = u.pathname; const m = r.request().method();
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const body = JSON.parse(r.request().postData() || '{}'); const fn = p.replace('/rest/v1/rpc/', ''); st.calls.push(fn);
    if (p === '/auth/v1/token') return json({ access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (p === '/auth/v1/user') return json(user);
    if (p.startsWith('/auth/v1/factors')) return json([]);
    if (p === '/functions/v1/paypal/status') return json(opts.ready === false ? { ready: false, env: null, credentials: false, webhooks: false } : { ready: true, env: 'live', credentials: true, webhooks: true, message: 'PayPal is set up.' });
    if (p === '/functions/v1/paypal/subscribe') { st.subscribes.push(body); await new Promise((ok) => setTimeout(ok, 300)); return json({ approve_url: `${BASE}/link/?paycancel=RI-10002`, ref: 'RI-10002' }); }
    if (p === '/functions/v1/paypal/cancel') { st.cancels++; return json({ ok: true }); }
    if (p === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex Sample', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'X', company_code: 'RIY-7K3M-Q2', kind: 'business' } }]);
    if (p === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex Sample', role: 'owner', job_role: 'owner', extension: 101 }]);
    if (p === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    // Basics paid to day 115 by the practice payment (practice_modules); Payroll and Bookings on their trial (60 days left)
    const lic = { modules: { basic: { status: 'active', active: true, paid_until: day(115), days_left: 115 }, payroll: { status: 'trial', active: true, trial_ends: day(60), days_left: 60 },
      bookings: { status: 'trial', active: true, trial_ends: day(60), days_left: 60 } }, seats: { included: 3, extra: 0, used: 1 } };
    if (fn === 'company_licence') return json(lic);
    if (fn === 'my_billing') {
      const sub = opts.real ? REAL : st.removed ? null : PRACTICE;
      return json({ licence: lic, subscription: sub, practice_subscription: null, paypal_env: opts.dbKnows ? 'live' : 'sandbox', practice_modules: st.removed || opts.real ? [] : ['basic'],
        orders: opts.real ? [REAL] : [PRACTICE], payments: [{ id: 1, ref: 'RR-10001', order_ref: 'RI-10001', method: 'paypal', status: 'completed', amount: 25, currency: 'USD', at: day(-20), period_to: day(115),
          modules: ['basic'], module_names: ['Accounting Basics'], practice: !opts.real }], seller: { name: 'Riyeser Pty Ltd' }, bank_ready: !!opts.bank, grace_days: 7,
        // the database hasn't heard PayPal is live yet: its link is still the practice site's (the page must not use it)
        paypal_manage_url: opts.dbKnows || opts.real ? 'https://www.paypal.com/myaccount/autopay/' : 'https://www.sandbox.paypal.com/myaccount/autopay/' });
    }
    if (fn === 'billing_quote') { st.quotes.push(body);
      if (body.buy_now) return json({ amount: 25, early_bird: false, due_now: 25, charge_from: day(0), charged_today: true, buy_now: true, trial_days_left: 60 });
      return json({ amount: 25, early_bird: false, due_now: 25, charge_from: day(60), charged_today: false, buy_now: false, trial_days_left: 60 }); }
    if (fn === 'billing_practice_cancel') { st.removed = true; return json({ removed: ['RI-10001'], practice: true }); }
    return json([]);
  });
  await pg.goto(`${BASE}/link/${opts.query ?? '?add=payroll&buy=1'}`); await pg.waitForSelector('#gf');
  await pg.fill('#gf input[name=email]', user.email); await pg.fill('#gf input[name=password]', 'pw-12345678'); await pg.click('#gf button[type=submit]');
  if (opts.query !== '') { await pg.waitForSelector('#apf'); await pg.waitForFunction(() => document.querySelector('#apwhen') && document.querySelector('#apwhen').textContent.length > 0, null, { timeout: 5000 }).catch(() => {}); }
  else await pg.waitForSelector('#hbill');
  await pg.waitForTimeout(150);
  return { pg, st };
}
const vis = async (pg, sel) => !!(await pg.$(sel)) && pg.isVisible(sel);
const txt = async (pg, sel) => ((await pg.$(sel)) ? (await pg.textContent(sel)).replace(/\s+/g, ' ').trim() : '');
// the dialog's lower half (when to pay, the buttons), as the owner sees it on the screen
const shot = async (pg, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true });
  await pg.evaluate(() => { const el = document.querySelector('#apsoon:not([hidden])') || document.querySelector('.mfoot'); if (el) el.scrollIntoView({ block: 'end' }); }); await pg.waitForTimeout(100);
  await pg.screenshot({ path: path.join(SHOTS, name) }); };

(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const width of [1366, 390]) {
    const { pg, st } = await open(b, errs, { width });
    const tag = `${width}`;
    check(await vis(pg, '#appaypal') && /^Pay with PayPal card or PayPal balance$/.test(await txt(pg, '#appaypal')), `${tag} a practice (sandbox) subscription doesn't block live: "${await txt(pg, '#appaypal')}"`);
    check(!(await pg.$('#apsub')) && !/You already pay by PayPal/.test(await txt(pg, '#apf')), `${tag} no "You already pay by PayPal"`);
    check(!(await vis(pg, '#apsoon')) && !/opening soon/i.test(await txt(pg, '#apf')), `${tag} no "Online payments are opening soon" while PayPal is ready`);
    check(!(await vis(pg, '#apbank')) && !/bank transfer/i.test(await pg.evaluate(() => [...document.querySelectorAll('#apf *')].filter((e) => e.offsetParent && !e.children.length).map((e) => e.textContent).join(' '))), `${tag} no bank transfer button or wording (Riyeser's bank details aren't in)`);
    check(await vis(pg, '#apstart') && await pg.isChecked('#apstart input[value=later]'), `${tag} on the free trial: "Start paying when my free trial ends" is ticked`);
    const when = await txt(pg, '#apwhen');
    check(/Nothing is charged today\. With PayPal, your first payment is on .+, when your free trial ends\./.test(when), `${tag} trial-only: "${when}"`);
    check(/Practice payment \(test\)/.test(await txt(pg, '[data-row=basic]')), `${tag} Basics (practice-paid) says "Practice payment (test)": "${await txt(pg, '[data-row=basic]')}"`);
    const wide = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth); check(wide <= 0, `${tag} nothing wider than the screen (${wide})`);
    await shot(pg, `paypal-live-dialog-after-${width}.png`);
    // Buy now: charged today, the free days left end today
    await pg.check('#apstart input[value=now]'); await pg.waitForFunction(() => /Charged today/.test(document.querySelector('#apwhen').textContent), null, { timeout: 4000 }).catch(() => {});
    const now = await txt(pg, '#apwhen');
    check(/Charged today when you pay: US\$25\.00\. Your remaining free days \(60\) end today, for Payroll only\./.test(now), `${tag} Buy now: "${now}"`);
    check(st.quotes.some((q) => q.buy_now === true), `${tag} the database quotes Buy now`);
    check(await pg.isHidden('#apfree'), `${tag} "your free days aren't lost" hidden for Buy now`);
    await shot(pg, `paypal-live-buynow-after-${width}.png`);
    // a double click: one subscribe, with buy_now
    await pg.dblclick('#appaypal'); await pg.waitForTimeout(700);
    check(st.subscribes.length === 1 && st.subscribes[0].buy_now === true, `${tag} a double click starts one PayPal subscription, with buy_now (${st.subscribes.length})`);
    await pg.close();
  }
  // the default: no buy_now sent
  { const { pg, st } = await open(b, errs, {}); await pg.click('#appaypal'); await pg.waitForTimeout(600);
    check(st.subscribes.length === 1 && !('buy_now' in st.subscribes[0]), 'the default sends no buy_now (PayPal waits for the trial end)'); await pg.close(); }
  // riyeser.com's Buy now (?buy=now): Buy now ticked
  { const { pg } = await open(b, errs, { query: '?add=bookings&buy=now' });
    check(await pg.isChecked('#apstart input[value=now]'), '?buy=now: "Buy now: start my paid plan today" ticked'); await pg.close(); }
  // Billing on the home page: practice subscription labelled, no practice-site link, Remove on Riyeser's side only
  for (const width of [1366, 390]) {
    const { pg, st } = await open(b, errs, { width, query: '' });
    check(/Practice payment \(test\): not a real subscription/.test(await txt(pg, '#hbprac')), `${width} Billing: "Practice payment (test): not a real subscription"`);
    check(!(await pg.$('#hbsub')) && !(await pg.$('a[href*="sandbox"]')), `${width} no Manage in PayPal for it, and no link to PayPal's practice site anywhere`);
    check(/Practice payment \(test\)/.test(await txt(pg, '#hbpay')) && !(await pg.$('#hbpay [data-rcpt]')), `${width} history: "Practice payment (test)", no receipt`);
    check((await pg.$$('[data-buynow]')).length === 3, `${width} Your plan: Buy now on the trial rows and the practice-paid row (${(await pg.$$('[data-buynow]')).length})`);
    const wide = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth); check(wide <= 0, `${width} home nothing wider than the screen (${wide})`);
    if (SHOTS) { await pg.evaluate(() => { const el = document.querySelector('#hplanv'); if (el) el.scrollIntoView({ block: 'start' }); }); await pg.waitForTimeout(100); await pg.screenshot({ path: path.join(SHOTS, `paypal-live-billing-after-${width}.png`) }); }
    if (width === 1366) {
      await pg.click('[data-buynow=payroll]'); await pg.waitForSelector('#apf'); await pg.waitForTimeout(300);
      check(await pg.isChecked('#apstart input[value=now]') && await pg.isChecked('#apf input[value=payroll]'), 'Buy now on a plan row: the dialog with Payroll and Buy now ticked');
      await pg.click('#cl'); await pg.waitForTimeout(150);
      await pg.click('#hbpracx'); await pg.waitForSelector('.mcard'); const q = await txt(pg, '.mcard');
      check(/no real money was ever charged/.test(q) && /nothing to cancel at PayPal/.test(q), 'Remove asks first, in plain words');
      await pg.click('.mcard .btn.p, .mcard .mfoot .btn:last-child'); await pg.waitForTimeout(500);
      check(st.calls.includes('billing_practice_cancel') && st.cancels === 0, 'removed on Riyeser\'s side only (billing_practice_cancel, never the paypal function\'s cancel)');
      check(!(await pg.$('#hbprac')), 'gone from Billing');
    }
    await pg.close();
  }
  // opening soon only when PayPal isn't ready and there's no bank transfer
  { const { pg } = await open(b, errs, { ready: false });
    check(await vis(pg, '#apsoon') && /Online payments are opening soon/.test(await txt(pg, '#apsoon')) && !(await vis(pg, '#appaypal')), 'PayPal not ready, no bank: "opening soon"'); await pg.close(); }
  { const { pg } = await open(b, errs, { ready: false, bank: true });
    check(!(await vis(pg, '#apsoon')) && await vis(pg, '#apbank'), 'PayPal not ready, bank in: bank transfer, no "opening soon"'); await pg.close(); }
  // a real (live) subscription: "You already pay by PayPal", no bank wording, no "opening soon"; its link is the real PayPal
  { const { pg } = await open(b, errs, { real: true, dbKnows: true });
    const t = await txt(pg, '#apsub');
    check(/You already pay by PayPal \(RI-10009\)/.test(t) && !/bank transfer/.test(t) && !(await vis(pg, '#appaypal')) && !(await vis(pg, '#apsoon')), `a real subscription: "${t}"`);
    await pg.click('#cl'); await pg.waitForTimeout(150);
    check(await pg.getAttribute('#hbsub a', 'href') === 'https://www.paypal.com/myaccount/autopay/', 'Manage in PayPal: the real PayPal'); await pg.close(); }
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} PAYPAL-LIVE CHECK(S) FAILED` : 'ALL PAYPAL-LIVE CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
