// Paying for Riyeser: riyeser.com's buttons -> sign up or sign in -> Add to my plan -> PayPal or bank transfer -> Billing.
// Against a pretend Supabase (and a pretend paypal function), at desktop and phone (390px) widths.
//  1. Every paid program has "Start free for 90 days" and "Buy now" (pricing rows and checklists, program pages); the
//     calculator's "Buy this plan" carries the programs, people and yearly. All go to /link/?signup&add=…
//  2. Sign-up keeps ?add=… in the confirmation email's link; signing in instead opens "Add to my plan" for that program.
//  3. Add to my plan: the programs, people (3 included, then US$7 each per program), monthly or yearly (10 months for 12);
//     the total matches riyeser_bill; the database's early bird shows.
//  4. Pay with PayPal: to PayPal and back (?paid=RI-…): "Thanks, we're confirming your payment", then confirmed.
//  5. Bank transfer: an invoice with the number, US$ amount, due date, reference and bank details; the printable invoice.
//  6. Billing: the subscription, next charge, a failed payment's grace date, invoices, payment history, receipts, Manage in
//     PayPal, Cancel (the in-page question, what happens). PayPal not set up: only bank transfer.
//  7. Admins and staff: no billing, and "only the owner can pay". No browser pop-ups (confirm/prompt) anywhere.
//  8. The price lists agree: website/prices.mjs, team.js, hq.js and riyeser_price() in team-chat.sql.
// Run: build the site, serve website/public on 8090, then `node website/team/test/pay-test.js [screenshots folder]`.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const SHOTS = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
const token = (aal = 'aal2') => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal, amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
const WS = 'bbbbbbbb-0000-4000-8000-000000000001';
// Pricing v2 (the same sums as riyeser_plan): users per program ({module: n}, else people), POS tills, bundles.
const PRICE = { basic: 25, plus: 39, bookings: 25, calls: 20, payroll: 25, pos: 29, as_built: 29, users_included: 3, extra_user: 7, tills_included: 1, extra_till: 15 };
const BUNDLES = [{ mods: ['basic', 'pos', 'calls'], price: 59 }, { mods: ['basic', 'payroll', 'calls'], price: 59 }, { mods: ['plus', 'bookings', 'calls', 'payroll', 'pos'], price: 99 }];
const bill = (mods, people, period, early, users, tills) => { const m = mods.filter((x) => !(x === 'basic' && mods.includes('plus')));
  const u = (x) => (users && users[x]) || people; const ex = (x) => (x === 'pos' ? Math.max(0, (tills || 1) - 1) * PRICE.extra_till : PRICE.extra_user * Math.max(0, u(x) - 3));
  let best = null; let save = 0; BUNDLES.forEach((b) => { if (b.mods.every((x) => m.includes(x))) { const v = b.mods.reduce((a, x) => a + PRICE[x], 0) - b.price; if (v > save) { save = v; best = b; } } });
  const sum = m.reduce((a, x) => a + PRICE[x] + ex(x), 0) - save;
  return sum * (period === 'yearly' ? 10 : 1) * (early ? 0.5 : 1); };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const printShot = async (pg, name) => { if (!SHOTS) return; await pg.emulateMedia({ media: 'print' }); await pg.screenshot({ path: path.join(SHOTS, name), fullPage: true }); await pg.emulateMedia({ media: 'screen' }); };
const shot = async (pg, name, sel) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true });
  if (sel) await (await pg.$(sel)).screenshot({ path: path.join(SHOTS, name) }); else await pg.screenshot({ path: path.join(SHOTS, name), fullPage: true }); };

async function fakeServer(page, opts = {}) {
  const seller = { name: 'Riyeser Pty Ltd', address: '1 George St, Sydney NSW 2000', tax_label: 'ABN', tax_number: '12 345 678 901', email: 'accounts@riyeser.com',
    bank: opts.noBank ? { account_number: '' } : { account_name: 'Riyeser Pty Ltd', bank_name: 'Westpac', bsb: '032-000', account_number: '123456', swift: 'WPACAU2S', note: '' } };
  const st = { orders: [], payments: [], calls: [], signup: null, cancelled: false, subscribeBody: null, polls: 0 };
  await page.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  await page.route('https://fake.supabase.test/**', async (r) => {
    const u = new URL(r.request().url()); const m = r.request().method(); const fn = u.pathname.replace('/rest/v1/rpc/', '');
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const body = JSON.parse(r.request().postData() || '{}');
    if (u.pathname.startsWith('/rest/v1/rpc/') || u.pathname.startsWith('/functions/')) st.calls.push(fn);
    if (u.pathname === '/auth/v1/signup') { st.signup = { ...body, redirectTo: u.searchParams.get('redirect_to') }; return json({ ...user, user_metadata: body.data }); }
    if (u.pathname === '/auth/v1/token') return json({ access_token: token(opts.aal), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (u.pathname === '/auth/v1/user') return json(user);
    if (u.pathname === '/auth/v1/factors' || u.pathname.startsWith('/auth/v1/factors')) return json([]);
    if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: opts.role || 'owner', job_role: 'owner', display_name: 'Alex Sample', workspaces: { id: WS, name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business', country: 'Fiji', address: '4 Harbour Rd, Suva', tax_number: '50-12345-0-1', email: 'office@sample.test' } }]);
    if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex Sample', role: opts.role || 'owner', job_role: 'owner', extension: 101 }, { user_id: 'u2', display_name: 'Sam Taylor', role: opts.role === 'owner' || !opts.role ? 'admin' : 'owner', job_role: 'manager', extension: 102 }]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    const lic = { modules: { basic: { status: 'trial', active: true, trial_ends: day(60), days_left: 60 }, plus: { status: 'trial', active: true, trial_ends: day(60), days_left: 60 },
      payroll: { status: 'trial', active: true, trial_ends: day(60), days_left: 60 }, pos: { status: 'ended', active: false }, bookings: { status: 'trial', active: true, trial_ends: day(60), days_left: 60 },
      as_built: { status: 'trial', active: true, trial_ends: day(60), days_left: 60 }, calls: st.orders.some((o) => o.method === 'paypal' && o.status === 'active') ? { status: 'active', active: true, paid_until: day(90), days_left: 90 } : { status: 'trial', active: true, trial_ends: day(60), days_left: 60 } },
      seats: { included: 3, extra: 0, used: 2 }, billing: 'monthly', early_bird: false };
    if (fn === 'company_licence') return json(lic);
    if (opts.oldDatabase && ['my_billing', 'billing_quote', 'billing_start'].includes(fn)) return json({ code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` }, 404);
    const owner = !opts.role || opts.role === 'owner';
    if (['my_billing', 'billing_quote', 'billing_start'].includes(fn) && !owner) return json({ code: 'P0001', message: 'Only the business owner can see prices and pay for Riyeser.' }, 400);
    if (fn === 'billing_quote') { const amount = bill(body.mods, body.people, body.billing_period, false, body.users, body.tills); const early = !opts.noEarly;
      return json({ modules: body.mods, people: body.people, billing: body.billing_period, amount, early_bird: early, first_amount: early ? amount / 2 : null, early_cycles: early ? (body.billing_period === 'yearly' ? 1 : 12) : 0, due_now: early ? amount / 2 : amount,
        ...(opts.oldQuote ? {} : { charge_from: body.mods.includes('pos') ? day(0) : day(60), charged_today: body.mods.includes('pos') }) }); }
    if (fn === 'billing_start') { const amount = bill(body.mods, body.people, body.billing_period, false, body.users, body.tills); const early = !opts.noEarly;
      const o = { id: 'o' + (st.orders.length + 1), ref: 'RI-' + (10001 + st.orders.length), method: body.pay_method, modules: body.mods, people: body.people, billing: body.billing_period, amount,
        first_amount: early ? amount / 2 : null, early_bird: early, early_cycles: early ? 12 : 0, total: early ? amount / 2 : amount, status: 'pending', due_date: body.pay_method === 'bank' ? day(14) : null,
        created_at: new Date().toISOString(), seller };
      st.orders.unshift(o); return json(o); }
    if (fn === 'billing_cancel_invoice') { const o = st.orders.find((x) => x.ref === body.invoice_ref); o.status = 'void'; return json(null); }
    if (fn === 'my_billing' && opts.kept) {
      // the database's kept copy of a receipt (billing_documents), as issued: different wording from today's details
      const doc = { kind: 'receipt', ref: 'RR-20001', issued_at: '2026-10-01T02:00:00Z', order_ref: 'RI-20001', seller: { ...seller, name: 'Riyeser (as issued)' },
        buyer: { name: 'Sample Plumbing', legal_name: 'Sample Plumbing Ltd (as issued)', email: 'old@sample.test', company_code: 'RIY-7K3M-Q2', contact: { name: 'Alex Sample' } },
        what: 'Payroll · 1 person · monthly', period_from: '2026-10-01', period_to: '2026-11-01', lines: [{ text: 'Riyeser: Payroll · 1 person · monthly, 1 Oct 2026 – 1 Nov 2026', amount: 25 }],
        total: 25, currency: 'USD', method: 'paypal', method_ref: '…AB12CD' };
      return json({ licence: lic, subscription: null, orders: [], payments: [{ id: 9, ref: 'RR-20001', order_ref: 'RI-20001', method: 'paypal', status: 'completed', amount: 25, currency: 'USD', at: doc.issued_at, period_to: '2026-11-01', modules: ['payroll'], module_names: ['Payroll'], people: 1, billing: 'monthly', seller, doc }],
        seller, grace_days: 7, paypal_manage_url: 'https://www.sandbox.paypal.com/myaccount/autopay/' });
    }
    if (fn === 'my_billing') {
      // back from PayPal: the webhook lands after a couple of looks
      const pp = st.orders.find((o) => o.method === 'paypal' && o.status !== 'void');
      if (pp && pp.status === 'pending' && st.approved && ++st.polls >= 2) { Object.assign(pp, { status: 'active', paid_through: day(90), works_until: day(90), next_charge_at: day(30), next_amount: pp.first_amount || pp.amount });
        st.payments.unshift({ id: 1, ref: 'RR-10001', order_ref: pp.ref, method: 'paypal', status: 'completed', amount: pp.first_amount || pp.amount, currency: 'USD', at: new Date().toISOString(), period_to: day(90), modules: pp.modules, module_names: ['Riyeser Link Plus'], people: pp.people, billing: pp.billing, seller }); }
      if (pp && opts.failAfterPaid && pp.status === 'active' && !st.failed) { st.failed = true; Object.assign(pp, { status: 'payment_failed', grace_until: day(7), works_until: day(90) });
        st.payments.unshift({ id: 2, ref: null, order_ref: pp.ref, method: 'paypal', status: 'failed', amount: pp.first_amount, currency: 'USD', at: new Date().toISOString(), note: 'PayPal couldn\'t take the payment.', modules: pp.modules, module_names: ['Riyeser Link Plus'] }); }
      if (pp && st.cancelled) pp.status = 'cancelled';
      return json({ licence: lic, subscription: pp && pp.status !== 'cancelled' ? pp : null, orders: st.orders.filter((o) => o.status !== 'void'), payments: st.payments, seller, grace_days: 7, paypal_manage_url: 'https://www.sandbox.paypal.com/myaccount/autopay/' }); }
    // the paypal function
    if (u.pathname === '/functions/v1/paypal/status') return json(opts.noPayPal ? { ready: false, credentials: false, webhooks: false, env: null, message: 'PayPal isn\'t set up yet.' } : { ready: true, env: 'sandbox', credentials: true, webhooks: true });
    if (u.pathname === '/functions/v1/paypal/subscribe') {
      st.subscribeBody = body; st.subscribeAuth = r.request().headers().authorization;
      const o = { id: 'o' + (st.orders.length + 1), ref: 'RI-' + (10001 + st.orders.length), method: 'paypal', modules: body.modules, people: body.people, billing: body.billing,
        amount: bill(body.modules, body.people, body.billing, false, body.users, body.tills), early_bird: true, early_cycles: 12, status: 'pending', created_at: new Date().toISOString(), seller };
      o.first_amount = o.amount / 2; o.total = o.first_amount; st.orders.unshift(o);
      // instead of PayPal's page, straight back as if approved
      st.approved = true; return json({ approve_url: `${BASE}/link/?paid=${o.ref}&subscription_id=I-SUB0001&ba_token=BA-1&token=EC-1`, ref: o.ref });
    }
    if (u.pathname === '/functions/v1/paypal/cancel') { st.cancelled = true; return json({ ok: true, works_until: day(90) }); }
    if (fn === 'my_refunds' || fn === 'my_tickets') return json([]);
    return json([]);
  });
  return st;
}
const signIn = async (pg) => { await pg.waitForSelector('#gf'); if (await pg.$('[data-go=in].on') === null) await pg.click('.gtabs [data-go=in]');
  await pg.fill('input[name=email]', user.email); await pg.fill('input[name=password]', 'a-good-password'); await pg.click('button[type=submit]'); };
const noScroll = async (pg) => { const r = await pg.evaluate(() => [document.documentElement.scrollWidth - innerWidth,
  [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 5).map((e) => `${e.tagName}#${e.id}.${String(e.className).slice(0, 30)}[${e.textContent.trim().slice(0, 30)}] in ${e.parentElement.className}:${Math.round(e.getBoundingClientRect().right)}`)]);
  if (r[0] > 0) console.log('   too wide:', r[0], r[1].join(' ')); return r[0]; };

(async () => {
  const b = await chromium.launch(); const errs = []; const pops = [];
  const newPage = async (w, h = 900) => { const pg = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => { pops.push(d.type() + ': ' + d.message()); d.dismiss(); }); return pg; };

  // ---- 1. the website's buttons
  const web = await newPage(1300);
  await web.goto(`${BASE}/pricing.html`);
  const rows = await web.$$eval('tr[data-row]', (rs) => rs.map((r) => [r.dataset.row, [...r.querySelectorAll('.buybtns a')].map((a) => [a.textContent, a.getAttribute('href')])]));
  // Riyeser Estimate (US$20 a month after its 90 days) has Start free + Buy now like every other paid program
  check(rows.some(([m, l]) => m === 'estimate' && l.length === 2), 'Riyeser Estimate: Start free + Buy now');
  check(rows.length >= 6 && rows.filter(([m]) => m !== 'link-office').every(([m, l]) => l.length === 2 && l[0][0] === 'Start free for 90 days' && l[0][1] === `/link/?signup&add=${m}` && l[1][0] === 'Buy now' && l[1][1] === `/link/?signup&add=${m}&buy=1`),
    `pricing rows: Start free + Buy now on every paid program (${rows.map((r) => r[0]).join(', ')})`);
  const eds = await web.$$eval('#accounting .plan .buybtns', (x) => x.map((d) => d.dataset.buy));
  check(eds.join() === 'basic,plus', `pricing checklists: Basics and Plus cards have the buttons (${eds})`);
  await web.uncheck('[data-m=basic]'); await web.check('[data-m=plus]'); await web.check('[data-m=payroll]');
  for (const m of ['plus', 'payroll']) { await web.fill(`[data-u=${m}]`, '5'); await web.dispatchEvent(`[data-u=${m}]`, 'input'); } await web.check('#yearly');
  check((await web.textContent('#total')) === 'US$920 a year', 'calculator: 920 a year');
  check(await web.getAttribute('#calcpay', 'href') === '/link/?signup&add=plus,payroll&u=plus:5,payroll:5&period=yearly&buy=1' && (await web.textContent('#calcpay')) === 'Buy this plan', `calculator: Buy this plan carries the plan (${await web.getAttribute('#calcpay', 'href')})`);
  check(await web.getAttribute('#calcfree', 'href') === '/link/?signup&add=plus,payroll&u=plus:5,payroll:5&period=yearly', 'calculator: Start free carries it too');
  await web.uncheck('#yearly'); await web.uncheck('[data-m=plus]'); await web.uncheck('[data-m=payroll]');
  check(await web.isHidden('#calcbuy'), 'calculator: no buy buttons with nothing ticked');
  await web.check('[data-m=plus]');
  await (await web.$('#link')).scrollIntoViewIfNeeded();
  if (SHOTS) { const box = await web.evaluate(() => { const t = document.querySelector('.ptable-wrap').getBoundingClientRect(); const g = [...document.querySelectorAll('.ptable tr.grp')].pop().getBoundingClientRect();
    return { x: t.left, y: g.top + scrollY, width: t.width, height: t.bottom - g.top }; });
    await web.screenshot({ path: path.join(SHOTS, 'pricing-buttons.png'), fullPage: true, clip: box }); }
  await shot(web, 'pricing-calculator-buy.png', '#calc');
  for (const [pagePath, m] of [['programs/pos.html', 'pos'], ['programs/accounting.html', 'plus'], ['programs/link.html', 'calls'], ['programs/payroll.html', 'payroll']]) {
    await web.goto(`${BASE}/${pagePath}`);
    const l = await web.$$eval(`.buybtns[data-buy="${m}"] a`, (as) => as.map((a) => a.getAttribute('href')));
    check(l.length >= 2 && l.includes(`/link/?signup&add=${m}&buy=1`) && l.includes(`/link/?signup&add=${m}`), `${pagePath}: price box buttons for ${m}`);
  }
  await web.goto(`${BASE}/programs/pos.html`); await shot(web, 'program-price-box.png', '.hero');

  // ---- 2. sign up keeps the program; sign in opens Add to my plan
  const pg = await newPage(1280); const st = await fakeServer(pg);
  await pg.goto(`${BASE}/pricing.html`); await pg.click('tr[data-row=calls] .buybtns a:has-text("Buy now")');
  await pg.waitForSelector('#gf'); check((await pg.textContent('#gf h1')).includes('Create your Riyeser account'), 'Buy now -> Create your Riyeser account');
  await pg.fill('input[name=you]', 'Alex Sample'); await pg.fill('input[name=email]', user.email); await pg.fill('input[name=password]', 'a-good-password'); await pg.fill('input[name=password2]', 'a-good-password');
  await pg.click('button[type=submit]'); await pg.waitForSelector('#gf .ok');
  check(st.signup && st.signup.redirectTo === `${BASE}/link/?signup&add=calls&buy=1`, `the confirmation email comes back with the program (${st.signup && st.signup.redirectTo})`);
  await signIn(pg); await pg.waitForSelector('#apf');
  check(await pg.isChecked('#apf input[value=calls]') && !(await pg.isChecked('#apf input[value=plus]')), 'after sign-in: Add to my plan, Riyeser Link ticked');
  check(!(await pg.evaluate(() => location.search)).includes('add='), 'the address is tidied');
  // ---- 3. the total
  const total = () => pg.textContent('#aptotal');
  const users = async (m, n) => { await pg.fill(`#apf input[data-u=${m}]`, String(n)); await pg.dispatchEvent(`#apf input[data-u=${m}]`, 'input'); };
  await users('calls', 4); await pg.waitForTimeout(150);
  check((await total()).includes('US$27.00') && (await pg.textContent('#apbrk')).includes('1 extra user × US$7'), `Riyeser Link, 4 people = US$27 (${await total()})`);
  // a bundle: Shop ticks Accounting Basics, POS and Riyeser Link, and the bundle price shows
  await pg.click('[data-bundle=shop]'); await pg.waitForTimeout(200);
  check(await pg.isChecked('#apf input[value=basic]') && await pg.isChecked('#apf input[value=pos]') && (await pg.textContent('#apbrk')).includes('Shop bundle') && (await total()).includes('US$66.00'),
    `Shop bundle: 59 + 1 extra Link user = US$66 (${await total()})`);
  await users('pos', 2); await pg.waitForTimeout(200);
  check((await total()).includes('US$81.00') && (await pg.textContent('#apbrk')).includes('1 extra till × US$15'), `a second till: US$81 (${await total()})`);
  await shot(pg, 'add-to-plan-bundle.png', '.mcard');
  await users('pos', 1); await pg.uncheck('#apf input[value=basic]'); await pg.uncheck('#apf input[value=pos]');
  await pg.check('#apf input[value=plus]'); await pg.check('#apf input[value=basic]');
  check(!(await pg.isChecked('#apf input[value=plus]')) && await pg.isChecked('#apf input[value=basic]'), 'Basics and Plus: one or the other');
  await pg.check('#apf input[value=plus]'); await users('plus', 5); await users('payroll', 5); await pg.uncheck('#apf input[value=calls]'); await pg.check('#apf input[value=payroll]');
  await pg.waitForTimeout(200);
  check((await total()).includes('US$92.00'), `Plus + Payroll, 5 people = US$92 (${await total()})`);
  check((await pg.textContent('#apeb')).includes('US$46.00 a month for your first 12 months'), `early bird from the database (${await pg.textContent('#apeb')})`);
  await pg.check('#apf input[value=yearly]'); await pg.waitForTimeout(200);
  check((await total()).includes('US$920.00') && (await total()).includes('× 10'), `yearly = 10 months (${await total()})`);
  check(await pg.isVisible('#appaypal') && await pg.isVisible('#apbank'), 'both ways to pay');
  // S10: on a free trial nothing is charged today (PayPal starts at the trial's end); with a trial over, it says "Charged today"
  check(/Nothing is charged today.*first payment is on .*when your free trial ends/.test(await pg.textContent('#apwhen')), `S10 says when the first charge is: ${await pg.textContent('#apwhen')}`);
  await pg.check('#apf input[value=pos]'); await pg.waitForTimeout(250);
  check(/Charged today/.test(await pg.textContent('#apwhen')), `S10 a program with no trial left: ${await pg.textContent('#apwhen')}`);
  await pg.uncheck('#apf input[value=pos]'); await pg.waitForTimeout(150);
  await shot(pg, 'add-to-plan.png', '.mcard');
  await pg.check('#apf input[value=monthly]'); await pg.uncheck('#apf input[value=plus]'); await pg.uncheck('#apf input[value=payroll]'); await pg.check('#apf input[value=calls]');
  await users('calls', 4); await pg.waitForTimeout(200);
  await shot(pg, 'paypal-choice.png', '.mcard');
  // ---- 4. PayPal: away and back
  await pg.click('#appaypal'); await pg.waitForURL(/\?paid=RI-/); await pg.waitForSelector('#pdmsg');
  check((await pg.textContent('.mcard h3')).includes('Thanks, we\'re confirming your payment'), 'back from PayPal: "Thanks, we\'re confirming your payment"');
  check(JSON.stringify(st.subscribeBody) === JSON.stringify({ ws: WS, modules: ['calls'], people: 4, billing: 'monthly', users: { calls: 4 }, tills: 1 }) && /^Bearer /.test(st.subscribeAuth || ''), 'the paypal function gets the plan, with the owner\'s sign-in');
  await shot(pg, 'paypal-confirming.png', '.mcard');
  await pg.waitForFunction(() => /Payment confirmed/.test((document.querySelector('.mcard h3') || {}).textContent || ''), null, { timeout: 15000 });
  check((await pg.textContent('#pdmsg')).includes('paid until'), `confirmed: ${(await pg.textContent('#pdmsg')).trim()}`);
  check(!(await pg.evaluate(() => location.search)).includes('paid='), 'the address is tidied after PayPal');
  await pg.click('.mcard #cl');
  // ---- 5. bank transfer for another program
  await pg.click('#haddplan'); await pg.waitForSelector('#apf');
  check(await pg.isHidden('#appaypal') && (await pg.textContent('#apf')).includes('You already pay by PayPal'), 'already on PayPal: only bank transfer for more');
  await pg.check('#apf input[value=pos]'); await pg.waitForTimeout(150); await pg.click('#apbank'); await pg.waitForSelector('#invref');
  const inv = (await pg.textContent('.mcard')).replace(/\s+/g, ' ');
  check(inv.includes('Invoice RI-10002') && inv.includes('US$14.50') && inv.includes('BSB032-000') && inv.includes('ReferenceRI-10002'), `the invoice: number, US$ amount (early bird half of US$29), bank details, reference`);
  check(inv.includes('Due') && inv.includes('free trial carries on'), 'due date, and the trial carries on until paid');
  await shot(pg, 'bank-transfer-invoice.png', '.mcard');
  await pg.click('#invprint'); await pg.waitForSelector('#printdoc');
  const doc = (await pg.textContent('#printdoc')).replace(/\s+/g, ' ');
  check(doc.includes('Riyeser Pty Ltd') && doc.includes('ABN 12 345 678 901') && doc.includes('Bill to') && doc.includes('Sample Plumbing') && doc.includes('US$14.50') && doc.includes('Early bird'), 'printable invoice: seller (ABN), buyer, lines, total');
  await printShot(pg, 'invoice-print.png');
  await pg.emulateMedia({ media: 'print' });
  check(await pg.evaluate(() => getComputedStyle(document.getElementById('app')).display === 'none' && getComputedStyle(document.getElementById('printdoc')).display !== 'none'), 'printing shows only the invoice');
  await pg.emulateMedia({ media: 'screen' });
  await pg.click('.modal.printing #cl'); await pg.click('.mcard #cl');
  // ---- 6. Billing
  await pg.waitForSelector('#hbsub');
  const billing = (await pg.textContent('.hbill')).replace(/\s+/g, ' ');
  check(billing.includes('PayPal subscription') && billing.includes('Next charge US$13.50') && billing.includes('RI-10002') && billing.includes('Payment history') && billing.includes('RR-10001'), 'Billing: subscription, next charge, invoices, payment history');
  check(await pg.getAttribute('.hbill a:has-text("Manage in PayPal")', 'href') === 'https://www.sandbox.paypal.com/myaccount/autopay/', 'Manage in PayPal');
  await (await pg.$('#hbill')).scrollIntoViewIfNeeded(); await shot(pg, 'owner-billing.png', '.hbill');
  await pg.click('[data-rcpt="RR-10001"]'); await pg.waitForSelector('#printdoc');
  check((await pg.textContent('#printdoc')).includes('Receipt') && (await pg.textContent('#printdoc')).includes('Paid by PayPal'), 'a receipt');
  await printShot(pg, 'receipt-print.png'); await pg.click('.modal.printing #cl');
  await pg.click('#hbcancel'); await pg.waitForSelector('#askyes');
  const q = (await pg.textContent('.mcard')).replace(/\s+/g, ' ');
  check(q.includes('Cancel your PayPal subscription?') && q.includes('won\'t charge you again') && q.includes('keeps working until') && q.includes('Nothing is deleted'), 'Cancel: says what happens, in the page');
  await shot(pg, 'cancel-question.png', '.mcard');
  await pg.click('#askno'); check(!st.cancelled, 'Keep it: nothing cancelled');
  await pg.click('#hbcancel'); await pg.click('#askyes'); await pg.waitForTimeout(500);
  check(st.cancelled && (await pg.textContent('#phmsg')).includes('keeps working until'), 'cancelled, with the date');
  check((await noScroll(pg)) <= 0, 'desktop: no sideways scrolling');

  // ---- a failed payment: the exact grace date
  const fp = await newPage(1280); const fst = await fakeServer(fp, { failAfterPaid: true });
  await fp.goto(`${BASE}/link/?add=calls&buy=1`); await signIn(fp); await fp.waitForSelector('#apf'); await fp.click('#appaypal'); await fp.waitForURL(/\?paid=/);
  await fp.waitForFunction(() => /Payment confirmed|didn't/.test((document.querySelector('.mcard') || {}).textContent || ''), null, { timeout: 15000 });
  await fp.reload(); await fp.waitForSelector('#hbsub');
  const grace = new Date(Date.now() + 90 * 864e5).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  check((await fp.textContent('#hbsub')).includes('Payment didn\'t go through') && (await fp.textContent('#hbsub')).includes(grace), `failed payment: works until the exact date (${grace})`);
  check((await fp.textContent('#hbpay')).includes('Didn\'t go through'), 'the failed payment is in the history');
  void fst;

  // ---- the kept copy of a receipt: a billing email's link (?receipt=RR-…) opens it, exactly as issued ("1 person")
  const kp = await newPage(1280); await fakeServer(kp, { kept: true });
  await kp.goto(`${BASE}/link/?receipt=RR-20001`); await signIn(kp); await kp.waitForSelector('#printdoc', { timeout: 15000 });
  const kd = (await kp.textContent('#printdoc')).replace(/\s+/g, ' ');
  check(kd.includes('RR-20001') && kd.includes('Riyeser (as issued)') && kd.includes('Sample Plumbing Ltd (as issued)') && kd.includes('Payroll · 1 person · monthly') && kd.includes('Reference …AB12CD'),
    'a receipt link opens the copy kept when it was issued');
  check(!/[?&]receipt=/.test(kp.url()), 'the link is tidied from the address bar');
  check((await kp.textContent('#hbpay')).includes('Payroll'), 'Payment history says what was paid for');

  // ---- PayPal not set up: bank transfer only
  const np = await newPage(1280); await fakeServer(np, { noPayPal: true, noEarly: true });
  await np.goto(`${BASE}/link/?add=basic`); await signIn(np); await np.waitForSelector('#apf');
  check(await np.isHidden('#appaypal') && await np.isVisible('#apbank') && (await np.textContent('#apnopp')).includes('isn\'t switched on yet'), 'PayPal not set up: only bank transfer');
  check((await np.textContent('.mcard p')).includes('free trial: nothing to pay today'), 'Start free (no buy=1): the trial words');
  await np.click('#apbank'); await np.waitForSelector('#invref');
  check((await np.textContent('.mcard')).includes('US$25.00'), 'Basics by bank: US$25.00');
  await np.click('.mcard #cl');

  // an unpaid invoice can be cancelled (in-page question)
  await np.waitForSelector('[data-inv]'); await np.click('[data-inv]'); await np.waitForSelector('#invcancel');
  await np.click('#invcancel'); await np.waitForSelector('#askyes'); await np.click('#askyes'); await np.waitForTimeout(400);
  check(!(await np.textContent('.hbill')).includes('Due '), 'an unpaid invoice can be cancelled (in-page question)');

  // ---- no bank details yet and no PayPal (OWNER-PAYOFF): no payment buttons, "opening soon" with the trial's end
  const nb = await newPage(1280); await fakeServer(nb, { noPayPal: true, noBank: true });
  await nb.goto(`${BASE}/link/?add=pos&buy=1`); await signIn(nb); await nb.waitForSelector('#apf'); await nb.waitForTimeout(200);
  check(await nb.isHidden('#appaypal') && await nb.isHidden('#apbank') && /Online payments are opening soon\. Your (free trial runs until|90-day free trial starts today).*nothing to pay yet/.test(await nb.textContent('#apsoon')),
    `OWNER-PAYOFF payments not open: no buttons, ${await nb.textContent('#apsoon')}`);

  // ---- 7. an admin: no prices, no billing
  const ad = await newPage(1280); const ast = await fakeServer(ad, { role: 'admin' });
  await ad.goto(`${BASE}/link/?signup&add=plus&buy=1`); await signIn(ad); await ad.waitForSelector('.mcard');
  check((await ad.textContent('.mcard')).includes('Only the owner of Sample Plumbing (Sam Taylor) can pay'), 'admin: only the owner can pay');
  check(!(await ad.$('#hbill')) && !ast.calls.includes('my_billing') && !ast.calls.includes('billing_quote'), 'admin: no Billing, and never asks for it');
  // an older database: Billing hides, Buy now still explains
  const od = await newPage(1280); await fakeServer(od, { oldDatabase: true });
  await od.goto(`${BASE}/link/?add=plus&buy=1`); await signIn(od); await od.waitForSelector('.mcard');
  check((await od.textContent('.mcard')).includes('still being switched on') && !(await od.$('#hbill')), 'older database: Billing hidden, a plain message');

  // ---- phone (390px)
  const ph = await newPage(390, 844); await fakeServer(ph);
  await ph.goto(`${BASE}/pricing.html`); check((await noScroll(ph)) <= 0, 'phone: pricing page fits');
  await (await ph.$('tr[data-row=plus]')).scrollIntoViewIfNeeded(); await shot(ph, 'pricing-buttons-phone.png', 'tr[data-row=plus]');
  await ph.goto(`${BASE}/programs/payroll.html`); check((await noScroll(ph)) <= 0, 'phone: program page fits');
  await ph.goto(`${BASE}/link/?signup&add=plus,payroll&users=5&buy=1`); await signIn(ph); await ph.waitForSelector('#apf');
  check(await ph.isChecked('#apf input[value=plus]') && await ph.isChecked('#apf input[value=payroll]') && (await ph.inputValue('#apf input[data-u=plus]')) === '5' && (await ph.inputValue('#apf input[data-u=payroll]')) === '5', 'phone: the calculator\'s plan arrives (users=5 from an older link)');
  check((await noScroll(ph)) <= 0, 'phone: Add to my plan fits');
  await shot(ph, 'add-to-plan-phone.png');
  await ph.click('#apbank'); await ph.waitForSelector('#invref'); await shot(ph, 'bank-transfer-invoice-phone.png');
  await ph.click('.mcard #cl'); await ph.waitForSelector('.hbill'); check((await noScroll(ph)) <= 0, 'phone: Billing fits');
  await (await ph.$('#hbill')).scrollIntoViewIfNeeded(); await shot(ph, 'owner-billing-phone.png', '.hbill');
  await ph.click('[data-inv]'); await ph.click('#invprint'); await ph.waitForSelector('#printdoc'); check((await noScroll(ph)) <= 0, 'phone: printable invoice fits');

  // ---- 8. one price list everywhere
  const root = path.join(__dirname, '..', '..');
  const site = await import(path.join(root, 'prices.mjs'));
  const fromJs = (f) => { const m = fs.readFileSync(path.join(root, f), 'utf8').match(/const PRICE = (\{[^}]+\})/); return Function(`return (${m[1]})`)(); };
  const sql = fs.readFileSync(path.join(root, 'team', 'team-chat.sql'), 'utf8').match(/function public\.riyeser_price\(item text\)[\s\S]*?\$\$;/)[0];
  const fromSql = Object.fromEntries([...sql.matchAll(/when '(\w+)' then (\d+)/g)].map((x) => [x[1], Number(x[2])]));
  const keys = ['basic', 'plus', 'payroll', 'pos', 'bookings', 'calls', 'as_built', 'estimate', 'users_included', 'extra_user', 'tills_included', 'extra_till', 'extra_company'];
  const sqlB = Object.fromEntries(['shop', 'office', 'business'].map((k) => [k, fromSql['bundle_' + k]]));
  check(site.BUNDLES.every((x) => sqlB[x.id] === x.price), `riyeser_price() has the same bundle prices as prices.mjs (${JSON.stringify(sqlB)})`);
  for (const f of ['team/team.js', 'hq/hq.js']) { const src = fs.readFileSync(path.join(root, f), 'utf8');
    check(site.BUNDLES.every((x) => src.includes(`id: '${x.id}', name: '${x.name}', mods: ${JSON.stringify(x.mods).replace(/"/g, "'").replace(/,/g, ', ')}, price: ${x.price}`)), `${f} has the same bundles as prices.mjs`); }
  for (const [name, list] of [['team.js', fromJs('team/team.js')], ['hq.js', fromJs('hq/hq.js')], ['riyeser_price()', fromSql]]) {
    const diff = keys.filter((k) => list[k] !== site.PRICE[k]);
    check(!diff.length, `${name} has the same prices as prices.mjs${diff.length ? ': differs on ' + diff.join(', ') : ''}`);
  }

  check(!pops.length, `no browser pop-ups (confirm, prompt, alert) ${pops.join(' | ')}`);
  check(!errs.length, `no page errors ${errs.join(' | ')}`);
  await b.close();
  console.log(failed ? `${failed} PAYING CHECK(S) FAILED` : 'ALL PAYING CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
