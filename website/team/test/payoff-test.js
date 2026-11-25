// OWNER-PAYOFF: which ways to pay "Add to my plan" offers, against a pretend Supabase and a pretend paypal function that
// answers like the deployed one (status with the person's sign-in; sandbox = practice mode, for HQ's owner only):
//   a customer while PayPal is in sandbox: no PayPal button (bank transfer if the details are in)
//   the owner (HQ, licences.manage) in sandbox: "Pay with PayPal (practice: only you see this)"
//   live mode: "Pay with PayPal" for everyone
//   bank transfer only when my_billing says bank_ready; neither way open: "Online payments are opening soon…"
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/payoff-test.js`. Exits 1 on failure.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function open(b, errs, opts) {
  const st = { statusAuth: [] };
  const pg = await b.newPage({ viewport: { width: 1200, height: 900 } }); pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: opts.hq ? 'owner@riyeser.test' : 'alex@sample.test', aud: 'authenticated', role: 'authenticated' };
  const token = opts.hq ? 'hq.owner.token' : 'customer.x.y';
  await pg.route('https://fake.supabase.test/**', (r) => {
    const u = new URL(r.request().url()); const p = u.pathname; const m = r.request().method();
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p === '/auth/v1/token') return json({ access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (p === '/auth/v1/user') return json(user);
    if (p === '/functions/v1/paypal/status') {
      const auth = r.request().headers().authorization || ''; st.statusAuth.push(auth);
      if (opts.mode === 'live') return json({ ready: true, env: 'live', credentials: true, webhooks: true });
      if (opts.mode === 'sandbox' && auth === 'Bearer hq.owner.token') return json({ ready: true, practice: true, env: 'sandbox', credentials: true, webhooks: true });
      if (opts.mode === 'sandbox') return json({ ready: false, env: 'sandbox', credentials: true, webhooks: true, message: 'PayPal is in practice mode, so customers can\'t start paying.' });
      return json({ ready: false, env: null, credentials: false, webhooks: false });
    }
    if (p === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'X', company_code: 'RIY-7K3M-Q2', kind: 'business' } }]);
    if (p === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex', role: 'owner', job_role: 'owner', extension: 101 }]);
    if (p === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    const lic = { modules: { basic: { status: 'trial', active: true, trial_ends: day(60), days_left: 60 }, payroll: { status: 'trial', active: true, trial_ends: day(45), days_left: 45 } }, seats: { included: 3, extra: 0, used: 1 } };
    if (p === '/rest/v1/rpc/company_licence') return json(lic);
    if (p === '/rest/v1/rpc/my_billing') return json({ licence: lic, subscription: null, orders: [], payments: [], seller: { name: 'Riyeser Pty Ltd' }, bank_ready: !!opts.bank, grace_days: 7 });
    if (p === '/rest/v1/rpc/billing_quote') return json({ amount: 25, early_bird: false, due_now: 25, charge_from: day(60), charged_today: false });
    return json([]);
  });
  await pg.goto(`${BASE}/link/?add=basic,payroll&buy=1`); await pg.waitForSelector('#gf');
  await pg.fill('#gf input[name=email]', user.email); await pg.fill('#gf input[name=password]', 'pw-12345678'); await pg.click('#gf button[type=submit]');
  await pg.waitForSelector('#apf'); await pg.waitForTimeout(250);
  const vis = async (sel) => !!(await pg.$(sel)) && await pg.isVisible(sel);
  return { pg, st, paypal: await vis('#appaypal'), label: (await pg.textContent('#appaypal')).replace(/\s+/g, ' ').trim(), bank: await vis('#apbank'), soon: (await vis('#apsoon')) ? await pg.textContent('#apsoon') : '' };
}

(async () => {
  const b = await chromium.launch(); const errs = [];
  let x = await open(b, errs, { mode: 'sandbox', bank: true });
  check(!x.paypal && x.bank && !x.soon, 'a customer in sandbox: no PayPal button, bank transfer (details are in)');
  check(x.st.statusAuth.some((a) => a === 'Bearer customer.x.y'), 'status is asked with the person\'s sign-in');
  await x.pg.close();
  x = await open(b, errs, { mode: 'sandbox', bank: false });
  check(!x.paypal && !x.bank && /Online payments are opening soon\. Your free trial runs until .+, so there's nothing to pay yet\./.test(x.soon), `a customer in sandbox, no bank details: no buttons, "${x.soon}"`);
  check(!/starts today/.test(x.soon), 'the real trial end date is used (the earliest of the ticked programs)');
  await x.pg.close();
  x = await open(b, errs, { mode: 'sandbox', bank: false, hq: true });
  check(x.paypal && /^Pay with PayPal \(practice: only you see this\)/.test(x.label) && !x.bank, `the owner in sandbox: practice button (${x.label})`);
  await x.pg.close();
  x = await open(b, errs, { mode: 'live', bank: true });
  check(x.paypal && /^Pay with PayPal card or PayPal balance$/.test(x.label) && x.bank, `live mode: "${x.label}" and bank transfer`);
  await x.pg.close();
  x = await open(b, errs, { mode: 'live', bank: false });
  check(x.paypal && !x.bank && !x.soon, 'live, no bank details: PayPal only');
  await x.pg.close();
  x = await open(b, errs, { mode: 'off', bank: true });
  check(!x.paypal && x.bank && /isn't switched on yet/.test(await x.pg.textContent('#apf')), 'PayPal not set up, bank details in: bank transfer only');
  await x.pg.close();
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} PAYOFF CHECK(S) FAILED` : 'ALL PAYOFF CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
