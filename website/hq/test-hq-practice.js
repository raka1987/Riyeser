// PAYPAL-LIVE: Riyeser HQ in demo mode with PayPal live (?demo&pplive) and a practice (PayPal sandbox) payment left over
// (Pacific business g12, RI-10001). Needs attention (Owner only): "Add Riyeser's bank details to offer bank transfer" and
// "Practice payments to clear"; Invoices & payments lists the business; its Money tab: "Clear practice payments for this
// business" (Owner only, says what it does, in the HQ history, then "Put practice payments back"); live orders untouched;
// "Bought now (ended trial early)" on a Buy now order. Finance sees no Clear button. Desktop 1366 and phone 390.
// Run: build the site, serve website/public on port 8090 (or HQ_URL), then `node website/hq/test-hq-practice.js [shots]`.
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
(async () => {
  const b = await chromium.launch(); const errs = []; const pops = []; let failed = 0; const out = process.argv[2];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
  const pg = await b.newPage({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => { pops.push(d.message()); d.dismiss(); });
  const text = async (sel) => ((await pg.$(sel)) ? (await pg.textContent(sel)).replace(/\s+/g, ' ').trim() : '');
  const flash = () => pg.evaluate(() => { const f = [...document.querySelectorAll('.flash')].pop(); return f ? f.textContent : ''; });
  await pg.goto(`${BASE}/hq/?demo&pplive`); await pg.waitForSelector('#attn');
  // Needs attention, for the Owner
  check(/Add Riyeser's bank details to offer bank transfer/.test(await text('#attnBank')), `Needs attention: ${await text('#attnBank')}`);
  check(/1\s*Practice payments to clear/.test(await text('#attn .alist')), 'Queue: 1 business with practice payments to clear');
  // Invoices & payments: PayPal live, the business listed; RI-10001 labelled practice; live orders say PayPal
  await pg.goto(`${BASE}/hq/?demo&pplive#/payments`); await pg.waitForSelector('#practiceCard');
  check((await text('#ppcard')).includes('Live'), 'PayPal card: Live');
  check(/Practice payments to clear/.test(await text('#practiceCard')) && /RI-10001/.test(await text('#practiceCard')), `practice card: ${await text('#practiceCard')}`);
  check(/Practice payment \(test\)/.test(await text('#failedCard')), 'the left-over practice subscription is labelled "Practice payment (test)"');
  if (out) { fs.mkdirSync(out, { recursive: true }); await (await pg.$('#practiceCard')).screenshot({ path: `${out}/hq-practice-card-1366.png` }); }
  // Bought now
  await pg.goto(`${BASE}/hq/?demo&pplive#/company/w1/money`); await pg.waitForSelector('#coBilling');
  check(/Bought now \(ended trial early\)/.test(await text('#coOrders')), 'Buy now order: "Bought now (ended trial early)"');
  // Finance: no Clear button
  await pg.selectOption('#demoAs', 's3'); await pg.waitForTimeout(400); await pg.goto(`${BASE}/hq/?demo&pplive#/company/g12/money`); await pg.waitForSelector('#coPractice');
  check(!(await pg.$('#clearPractice')) && /Only the Owner can clear practice payments/.test(await text('#coPractice')), 'Finance: no Clear practice payments');
  await pg.goto(`${BASE}/hq/?demo&pplive#/overview`); await pg.waitForSelector('#attn');
  check(!(await pg.$('#attnBank')) && !/Practice payments to clear/.test(await text('#attn')), 'Finance: no bank-details or practice items in Needs attention');
  // the Owner clears, says what it does first; then it's in the history and can be put back
  await pg.selectOption('#demoAs', 's1'); await pg.waitForTimeout(400); await pg.goto(`${BASE}/hq/?demo&pplive#/company/g12/money`); await pg.waitForSelector('#clearPractice');
  const liveBefore = await text('#coOrders');
  await pg.click('#clearPractice'); await pg.waitForSelector('#pxGo');
  const q = await text('.mcard');
  check(/marked void \(test\)/.test(q) && /Live PayPal and bank transfer payments, and their paid time, stay exactly as they are/.test(q) && /HQ history/.test(q), 'Clear: says what happens first');
  if (out) await (await pg.$('.mcard')).screenshot({ path: `${out}/hq-practice-clear-dialog-1366.png` });
  await pg.click('#pxGo'); await pg.waitForSelector('#restorePractice');
  check(/Practice payments cleared \(RI-10001\)/.test(await flash()), `flash: ${await flash()}`);
  check(/Cleared \(test\)/.test(await text('#coOrders')), 'the order shows "Cleared (test)"');
  check(liveBefore.length > 0, 'orders listed before');
  await pg.goto(`${BASE}/hq/?demo&pplive#/company/w2/money`); await pg.waitForSelector('#coBilling');
  check(/Active/.test(await text('#coOrders')) && !/Cleared/.test(await text('#coOrders')), 'another business\'s live PayPal subscription untouched');
  await pg.goto(`${BASE}/hq/?demo&pplive#/history`); await pg.waitForTimeout(500);
  check((await text('#main')).includes('cleared practice (test) payments'), 'in the HQ history');
  await pg.goto(`${BASE}/hq/?demo&pplive#/company/g12/money`); await pg.waitForSelector('#restorePractice');
  await pg.click('#restorePractice'); await pg.waitForSelector('#pxGo'); await pg.click('#pxGo'); await pg.waitForSelector('#clearPractice');
  check(/put back/.test(await flash()) && !/Cleared \(test\)/.test(await text('#coOrders')), 'put back');
  // phone
  const ph = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 }); ph.on('pageerror', (e) => errs.push(e.message)); ph.on('dialog', (d) => { pops.push(d.message()); d.dismiss(); });
  await ph.goto(`${BASE}/hq/?demo&pplive#/company/g12/money`); await ph.waitForSelector('#coPractice');
  check((await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, 'phone: no sideways scrolling');
  if (out) await (await ph.$('#coPractice')).screenshot({ path: `${out}/hq-practice-money-390.png` });
  check(!pops.length, `no browser pop-ups ${pops.join(' | ')}`);
  check(!errs.length, `no page errors ${errs.join(' | ')}`);
  await b.close();
  console.log(failed ? `${failed} HQ PRACTICE CHECK(S) FAILED` : 'ALL HQ PRACTICE CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
