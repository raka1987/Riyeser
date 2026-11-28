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
  check(/Payments received\s*US\$25\s*1 payment in the last 7 days/.test(await text('#payRecv')) && (await pg.getAttribute('#payRecv', 'href')) === '#/payments', `Overview: payments received in 7 days, linking to Invoices & payments (${await text('#payRecv')})`);
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
  // SEC-011: two people. It's only proposed; Riki can withdraw it but not approve it; Finance Fi approves it
  check((await flash()).includes('Change proposed') && await pg.isVisible('#entPending') && await pg.isVisible('#addbank'), 'bank details proposed: waiting, the reminder stays until approved');
  const pend = await text('#entPending');
  check(pend.includes('Waiting for a second person') && pend.includes('Riki proposed') && pend.includes('032-000') && pend.includes('123456') && !(await pg.$('#entYes')) && !!(await pg.$('#entNo')),
    `the waiting change: who, what changes, no Approve for the proposer (${pend.slice(0, 120)})`);
  await shot(pg, 'hq-entity-pending.png', '#entity');
  await pg.selectOption('#demoAs', 's3'); await pg.waitForTimeout(400); await pg.goto(`${BASE}/hq/?demo#/payments`); await pg.waitForSelector('#entPending');
  check(!!(await pg.$('#entYes')) && (await text('#entPending')).includes('Riki proposed'), 'Finance sees Approve');
  await pg.click('#entYes'); await pg.waitForTimeout(500);
  check(!(await pg.$('#entPending')) && !(await pg.$('#addbank')) && (await flash()).includes('Approved'), 'approved by a second person: in force, the reminder goes');
  await pg.selectOption('#demoAs', 's1'); await pg.waitForTimeout(400);
  await pg.goto(`${BASE}/hq/?demo#/history`); await pg.waitForTimeout(500);
  const hist = await text('#main'); check(hist.includes('marked a bank transfer paid') && hist.includes('proposed a billing entity change') && hist.includes('approved a billing entity change'), 'all in the HQ history');
  // the customer page: Money tab
  await pg.goto(`${BASE}/hq/?demo#/company/w2/money`); await pg.waitForSelector('#coBilling');
  check((await text('#coBilling')).includes('RI-10002') && (await text('#coBilling')).includes('…7Q2X9K') && (await text('#coPays')).includes('…4T7Y2A'), 'Money tab: invoices and payments, ids masked');
  await shot(pg, 'hq-customer-money.png', '#cpBody');
  // what each payment was for; "1 person"; the early bird amount; the receipt number opens the customer's copy
  const forCell = await text('#coPayTbl tr:nth-child(2) td.forc');
  check(/^Accounting Basics, POS, Riyeser Link · 9 people · monthly · .+ – .+\d{4}$/.test(forCell), `Payments: For says what was paid for (${forCell})`);
  await pg.click('#coPayTbl [data-doc="RR-10002"]'); await pg.waitForSelector('#printdoc');
  const doc = await text('#printdoc');
  check(doc.includes('Receipt') && doc.includes('RR-10002') && doc.includes('Harbour Cafe Pty Ltd') && doc.includes('Contact: Mere') && doc.includes('US$143.00') && doc.includes('Paid by PayPal'), 'the customer\'s copy of the receipt');
  check(await pg.isVisible('#docPrint') && await pg.isVisible('#docResend') && await pg.isVisible('#docOther'), 'Print, Resend, Send to a different email');
  await pg.click('#docResend'); await pg.waitForSelector('#rsGo');
  check((await text('.modal:last-child .mcard')).includes('mere@harbour.test'), 'Resend: says where it goes'); await pg.click('#rsGo'); await pg.waitForTimeout(300);
  check((await flash()).includes('RR-10002 sent to mere@harbour.test'), `resent: ${await flash()}`);
  await pg.click('#docOther'); await pg.waitForSelector('#rsf'); await pg.fill('#rsf [name=to]', 'nope'); await pg.click('#rsGo');
  check(!!(await pg.$('#rsStep1:not([hidden])')), 'a bad address: the form stops it');
  await pg.fill('#rsf [name=to]', 'Accounts@Harbour.test'); await pg.check('#rsf [name=fix]'); await pg.click('#rsGo');
  check((await text('#rsCheck')).includes('Accounts@Harbour.test') && (await text('#rsCheck')).includes('billing email'), 'asks to check the address first');
  await pg.click('#rsGo'); await pg.waitForTimeout(400);
  check((await flash()).includes('sent to accounts@harbour.test') && (await flash()).includes('billing email is updated') && !(await pg.$('#printdoc')), `sent to another address: ${await flash()}`);
  await pg.goto(`${BASE}/hq/?demo#/company/w2/money`); await pg.waitForSelector('#coBilling');
  await pg.goto(`${BASE}/hq/?demo#/history`); await pg.waitForTimeout(500);
  check((await text('#main')).includes('sent an invoice or receipt again') && (await text('#main')).includes('ac…@harbour.test'), 'resends are in the HQ history, address shortened');
  await pg.goto(`${BASE}/hq/?demo#/company/w1/money`); await pg.waitForSelector('#coBilling');
  const inv = await text('#coOrders');
  check(inv.includes('5 people') && /US\$46 \(early bird\)\s*then US\$92 a month/.test(inv), `invoice row: people, early bird wording (${inv.slice(0, 160)})`);
  await pg.click('#coOrders [data-doc="RI-10003"]'); await pg.waitForSelector('#printdoc');
  check((await text('#printdoc')).includes('Invoice') && (await text('#printdoc')).includes('Early bird'), 'the invoice copy opens too'); await pg.click('.modal [data-close]');
  // SEC-010: Support (no licences.manage) can look at a receipt but not email it
  await pg.selectOption('#demoAs', 's2'); await pg.waitForTimeout(400); await pg.goto(`${BASE}/hq/?demo#/company/w2/money`); await pg.waitForSelector('#coBilling');
  await pg.click('#coPayTbl [data-doc="RR-10002"]'); await pg.waitForSelector('#printdoc');
  check(!(await pg.$('#docResend')) && !(await pg.$('#docOther')) && (await text('#docNoSend')).includes('Only Finance and the Owner') && await pg.isVisible('#docPrint'), 'Support: Print only, no Resend');
  await pg.click('.modal [data-close]');
  await pg.selectOption('#demoAs', (await pg.$$eval('#demoAs option', (o) => o[0].value))); await pg.waitForTimeout(400);
  // Programs as Support (no licences.manage): the list, no Manage buttons
  await pg.selectOption('#demoAs', 's2'); await pg.waitForTimeout(400); await pg.goto(`${BASE}/hq/?demo#/company/w2/programs`); await pg.waitForSelector('#licCard');
  check((await pg.$$('#licCard tr[data-mod]')).length > 0 && !(await pg.$('#licCard [data-manage]')), 'Support: sees the programs, no Manage buttons');
  await pg.selectOption('#demoAs', (await pg.$$eval('#demoAs option', (o) => o[0].value))); await pg.waitForTimeout(400);
  // Support can look but not mark paid
  await pg.goto(`${BASE}/hq/?demo#/payments`); await pg.waitForSelector('#ppcard');
  await pg.selectOption('#demoAs', 's2'); await pg.waitForTimeout(400); await pg.goto(`${BASE}/hq/?demo#/payments`);
  await pg.waitForTimeout(500);
  const asSupport = await text('#main');
  check(asSupport.includes('Invoices & payments') && !(await pg.$('[data-markpaid]')) && !!(await pg.$('#entf [name=name][readonly]')), 'Support: sees it, no Mark paid, entity read-only');
  // the left menu: a group heading folds its pages away and is never itself highlighted
  await pg.selectOption('#demoAs', (await pg.$$eval('#demoAs option', (o) => o[0].value))); await pg.waitForTimeout(400);
  await pg.goto(`${BASE}/hq/?demo#/licences`); await pg.waitForSelector('#licTbl');
  check(!(await pg.$('.ngrp[data-tab]')) && (await pg.$$eval('.snav .on', (l) => l.map((x) => x.textContent.trim()))).join() === 'Licences', 'only the page is highlighted, not its group');
  await pg.click('.ngrp[data-grp="Billing & Licences"]'); check(await pg.isHidden('[data-tab=licences]') && (await pg.getAttribute('.ngrp[data-grp="Billing & Licences"]', 'aria-expanded')) === 'false' && (await pg.evaluate(() => location.hash)) === '#/licences', 'the group heading folds its pages (it isn\'t a page)');
  await pg.reload(); await pg.waitForSelector('#licTbl'); check(await pg.isHidden('[data-tab=licences]'), 'and stays folded');
  await pg.click('.ngrp[data-grp="Billing & Licences"]'); check(await pg.isVisible('[data-tab=licences]'), 'unfolds again');
  // Licences: real figures, As Built hidden, a list per program and status, fits the screen
  const lic = await text('#main');
  check(!lic.includes('until payments are connected') && /Received last 30 days\s*US\$\d/.test(lic) && /Monthly recurring\s*US\$\d/.test(lic) && lic.includes('list-price estimate'), 'Licences: received in 30 days and monthly recurring, the estimate as a quiet extra');
  check(!(await pg.$('#licTbl [data-lrow=as_built]')), 'As Built hidden (nobody has it paid or installed)');
  check(await pg.$$eval('#licTbl tbody tr', (r) => r.every((x) => [...x.cells].slice(1).every((c) => getComputedStyle(c).textAlign === 'right')) && new Set(r.map((x) => Math.round(x.getBoundingClientRect().height))).size === 1), 'numbers right-aligned, rows the same height');
  await pg.click('#licTbl [data-lmod=pos][data-lst=paid]'); await pg.waitForSelector('#llTbl');
  check((await text('.mcard h3')) === 'POS' && (await pg.$$('#llTbl tbody tr')).length === 10 && (await text('#llst .chip.on')) === 'Paid', 'a number opens the businesses on that program and status');
  await pg.click('#llst [data-st=trial]'); await pg.waitForTimeout(300); check((await pg.$$('#llTbl tbody tr')).length === 112, 'switch to On trial');
  await pg.click('#llTbl tbody tr'); await pg.waitForSelector('#licCard'); check(/#\/company\/.+\/programs$/.test(await pg.evaluate(() => location.hash)), 'a business opens its Programs tab');
  await pg.goto(`${BASE}/hq/?demo#/licences`); await pg.waitForSelector('#licTbl');
  check(await pg.$eval('#endSoon', (x) => x.scrollWidth <= x.clientWidth + 1) && (await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, 'Ending soon fits, no sideways scroll');
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
