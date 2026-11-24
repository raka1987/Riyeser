// Riyeser HQ in demo mode: Invoices & payments. The PayPal status card (sandbox; webhooks not verified yet), failed
// payments and unpaid invoices (also in the Needs attention queue), Mark bank transfer paid (amount and bank reference
// checked; the HQ history), PayPal ids shown only by their last 6 characters, the Billing entity with "Add your bank
// details" until it's filled (ABN by default), the customer page's Money tab, and who may do what (Support can look,
// only Owner and Finance mark paid). No browser pop-ups. Desktop and phone (390px).
// Run: build the site, serve website/public on port 8090, then `node website/hq/test-hq-pay.js [screenshot folder]`.
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
(async () => {
  const b = await chromium.launch(); const errs = []; const pops = []; let failed = 0; const out = process.argv[2];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
  const shot = async (pg, name, sel) => { if (!out) return; fs.mkdirSync(out, { recursive: true }); if (sel) await (await pg.$(sel)).screenshot({ path: `${out}/${name}` }); else await pg.screenshot({ path: `${out}/${name}`, fullPage: true }); };
  const pg = await b.newPage({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 2 });
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => { pops.push(d.message()); d.dismiss(); });
  const text = async (sel) => (await pg.textContent(sel)).replace(/\s+/g, ' ').trim();
  const flash = () => pg.evaluate(() => { const f = [...document.querySelectorAll('.flash')].pop(); return f ? f.textContent : ''; });
  await pg.goto(`${BASE}/hq/?demo`); await pg.waitForSelector('.tiles');
  // the overview: failed payments counted, both kinds in the work queue
  check(/Failed payments\s*1/.test(await text('.ccards')), 'Overview: 1 failed payment');
  const kinds = await pg.$$eval('#queue tr[data-kind]', (rs) => rs.map((r) => r.dataset.kind + ': ' + r.querySelector('.pill').textContent));
  check(kinds.some((k) => k === 'payment: Payment failed') && kinds.some((k) => /^invoice: Invoice (unpaid|overdue)$/.test(k)), `work queue: ${kinds.filter((k) => /payment|invoice/.test(k)).join(', ')}`);
  // Invoices & payments
  await pg.goto(`${BASE}/hq/?demo#/payments`); await pg.waitForSelector('#ppcard');
  const pp = await text('#ppcard');
  check(pp.includes('Webhooks not verified yet') && pp.includes('PAYPAL_WEBHOOK_ID') && pp.includes('sandbox') && pp.includes('Last webhook'), `PayPal card: ${pp.slice(0, 140)}`);
  check((await text('#failedCard')).includes('Payment failed') && (await text('#failedCard')).includes('works until'), 'failed payments: with the date they work until');
  const main = await text('#main');
  check(main.includes('…H8LM3P') && main.includes('…4T7Y2A') && !/I-[A-Z0-9]{8,}/.test(main), 'PayPal ids: only the last 6 characters');
  check(await pg.isVisible('#addbank') && (await text('#addbank')).startsWith('Add your bank details'), 'Billing entity: "Add your bank details" until filled');
  check((await pg.inputValue('#entf [name=tax_label]')) === 'ABN' && (await text('#entity')).includes('ABN (or tax number)'), 'ABN is the default label');
  await shot(pg, 'hq-payments.png');
  // Mark bank transfer paid: checks, then the licence and the history
  await pg.click('#unpaidTbl [data-markpaid="RI-10003"]'); await pg.waitForSelector('#mp');
  check((await text('.mcard')).includes('switches the programs on straight away'), 'Mark paid: says what it does');
  await pg.fill('#mp [name=amount]', '10'); await pg.fill('#mp [name=bankref]', 'WBC 88123'); await pg.click('#mp .btn.p'); await pg.waitForSelector('#mperr .err');
  check((await text('#mperr')).includes('The invoice is for US$46'), 'too little: refused');
  await pg.fill('#mp [name=amount]', '46'); await pg.fill('#mp [name=bankref]', ''); await pg.click('#mp .btn.p');
  check(!!(await pg.$('#mp')), 'no bank reference: the form stops it');
  await shot(pg, 'hq-mark-paid.png', '.mcard');
  await pg.fill('#mp [name=bankref]', 'WBC 88123'); await pg.click('#mp .btn.p'); await pg.waitForSelector('#mp', { state: 'detached' });
  check((await flash()).includes('RI-10003 is paid: receipt RR-'), `flash: ${await flash()}`);
  await pg.waitForSelector('#paysCard'); check(!(await pg.$('#unpaidTbl [data-markpaid="RI-10003"]')) && (await text('#paysCard')).includes('WBC 88123'), 'the invoice moved to Payments, with the bank reference');
  // the Billing entity
  for (const [k, v] of [['name', 'Riyeser Pty Ltd'], ['address', '1 George St, Sydney NSW 2000'], ['tax_number', '12 345 678 901'], ['bank.account_name', 'Riyeser Pty Ltd'], ['bank.bank_name', 'Westpac'], ['bank.bsb', '032-000'], ['bank.account_number', '123456']]) await pg.fill(`#entf [name="${k}"]`, v);
  await pg.click('#entf .btn.p'); await pg.waitForTimeout(400);
  check(!(await pg.$('#addbank')) && (await flash()).includes('Billing entity saved'), 'bank details saved: the reminder goes');
  await pg.goto(`${BASE}/hq/?demo#/history`); await pg.waitForTimeout(500);
  const hist = await text('#main'); check(hist.includes('marked a bank transfer paid') && hist.includes('changed the billing entity'), 'both are in the HQ history');
  // the customer page: Money tab
  await pg.goto(`${BASE}/hq/?demo#/company/w2/money`); await pg.waitForSelector('#coBilling');
  check((await text('#coBilling')).includes('RI-10002') && (await text('#coBilling')).includes('…7Q2X9K') && (await text('#coPays')).includes('…4T7Y2A'), 'Money tab: invoices and payments, ids masked');
  await shot(pg, 'hq-customer-money.png', '#cpBody');
  // Support can look but not mark paid
  await pg.goto(`${BASE}/hq/?demo#/payments`); await pg.waitForSelector('#ppcard');
  await pg.selectOption('#demoAs', 's2'); await pg.waitForTimeout(400); await pg.goto(`${BASE}/hq/?demo#/payments`);
  await pg.waitForTimeout(500);
  const asSupport = await text('#main');
  check(asSupport.includes('Invoices & payments') && !(await pg.$('[data-markpaid]')) && !!(await pg.$('#entf [name=name][readonly]')), 'Support: sees it, no Mark paid, entity read-only');
  // phone
  const ph = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); ph.on('pageerror', (e) => errs.push(e.message)); ph.on('dialog', (d) => { pops.push(d.message()); d.dismiss(); });
  await ph.goto(`${BASE}/hq/?demo#/payments`); await ph.waitForSelector('#ppcard');
  check((await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, 'phone: no sideways scrolling');
  await shot(ph, 'hq-payments-phone.png');
  check(!pops.length, `no browser pop-ups ${pops.join(' | ')}`);
  check(!errs.length, `no page errors ${errs.join(' | ')}`);
  await b.close();
  console.log(failed ? `${failed} HQ PAYMENT CHECK(S) FAILED` : 'ALL HQ PAYMENT CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
