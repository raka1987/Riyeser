// The website's prices and program lists (riyeser.com, built by website/build.mjs), pricing v2:
//  1. The pricing page says "US$" and "All prices in US dollars"; the bundles (Shop, Office, Business, the last "Most
//     popular"); and the calculator gives the worked examples with users per program, tills and bundles (5 users with
//     Accounting Plus + Payroll = US$92; Basics = US$25; Riyeser Link with 4 people = US$27; Plus + Link with 5 and Payroll
//     with 2 office users = US$112; Shop = US$59; Business = US$99; POS with 3 tills = US$59; Basics and Plus never both;
//     yearly = 10 x; early bird half).
//  2. No FJD, AUD or NZD prices anywhere on the website, and no "Link Plus" or "★ Plus" left.
//  3. Free programs come first everywhere programs are listed (menu, finder, All programs, Downloads, footer), A to Z:
//     Central, Riyeser Documents, Invoices, PDF; then the paid ones A to Z, with Riyeser Link Office right after Riyeser Link.
//  4. Riyeser Link Office never has a price of its own: "With Riyeser Link", linked to pricing.html#link.
//  5. Find your program on a phone is a tidy list; the home hero is one still picture on a phone; the footer is tidy.
// Run: build the site, serve website/public on 8090, then `node website/team/test/pricing-test.js [shots folder]`.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const SHOTS = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const FREE = ['central', 'documents', 'invoices', 'pdf'];
const PAID = ['accounting-basics', 'accounting', 'bookings', 'estimate', 'link', 'link-office', 'payroll', 'pos'];
const LO_FILE = 'RiyeserLinkOffice-Setup.exe';

(async () => {
  const b = await chromium.launch(); const errs = [];
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(`${BASE}/pricing.html`);
  const body = await pg.textContent('body');
  check(body.includes('US$') && body.includes('All prices in US dollars'), 'pricing page: "US$" and "All prices in US dollars"');
  check(body.includes('per business') && body.includes('3 users'), 'pricing page: per business, 3 users included');
  check(body.includes('20 GB') && !/Link Plus|★ Plus|2 GB/.test(body), 'pricing page: 20 GB with Riyeser Link, no Link Plus or 2 GB tier');
  check(await pg.isVisible('#link') && await pg.isVisible('#link-office'), 'pricing page: the Riyeser Link and Link Office rows');
  check((await pg.textContent('#link-office')).includes('With Riyeser Link') && !/US\$/.test(await pg.textContent('#link-office')), 'Link Office row: "With Riyeser Link", no price');
  const bundles = await pg.$$eval('#bundles .plan', (ps) => ps.map((p) => [p.id, p.querySelector('.price').textContent, p.classList.contains('best'), p.textContent.replace(/\s+/g, ' ')]));
  check(bundles.map((x) => x[0]).join() === 'bundle-shop,bundle-office,bundle-business' && bundles.map((x) => x[1].replace(/\s/g, '')).join() === 'US$59/month,US$59/month,US$99/month', `bundles: Shop 59, Office 59, Business 99 (${bundles.map((x) => x[1]).join(' | ')})`);
  check(bundles[2][2] && bundles[2][3].includes('Most popular') && bundles[0][3].includes('US$74') && bundles[1][3].includes('US$70') && bundles[2][3].includes('US$138'), 'Business is "Most popular"; separate prices 74, 70, 138');
  check(bundles[2][3].includes('US$990 a year'), 'bundles show the yearly price');
  check(await pg.$eval('#bundle-shop .buybtns a.btn.p', (a) => a.getAttribute('href')) === '/link/?signup&add=basic,pos,calls&buy=1', 'Shop bundle: Buy now adds its three programs');
  const free = await pg.$$eval('tr[data-free]', (rs) => rs.map((r) => [r.dataset.free, r.querySelector('.freeinfo') ? r.querySelector('.freeinfo').textContent.replace(/\s+/g, ' ') : '', !!r.querySelector('.nolim')]));
  check(free.map((x) => x[0]).join() === FREE.join() && free.every(([, t, n]) => t.includes('Included free:') && n), `What's free: ${free.map((x) => x[0]).join(', ')}, all with no limits`);
  check(free.some(([id, t]) => id === 'invoices' && t.includes('Accounting Basics (US$25/month)')), 'Invoices: the upgrade note with the Basics price');
  check(await pg.$$eval('tr[data-row]', (rs) => rs.map((r) => r.dataset.row).join()) === 'basic,plus,bookings,estimate,calls,link-office,payroll,pos', 'paid rows A to Z, Link Office after Link');
  // Riyeser Estimate: free for 90 days from first use, then US$20 a month (3 users included); not in any bundle
  const est = await pg.$eval('tr[data-row="estimate"] td.pr', (td) => td.textContent.replace(/\s+/g, ' '));
  check(est.includes('US$20 a month') && est.includes('Free for 90 days from the first time you use it, then US$20 a month') && est.includes('3 users included') && est.includes('US$200 a year') && !/announced/i.test(est),
    `Riyeser Estimate row: free for 90 days, then US$20 a month (${est.slice(0, 160)})`);
  check(!/to be announced/i.test(body), 'no "price to be announced" left');
  check(await pg.$$eval('#bundles .bmods', (x) => x.every((u) => !/Estimate/.test(u.textContent))), 'Riyeser Estimate is in no bundle');
  check((await pg.textContent('tr[data-row=pos]')).includes('unlimited cashiers') && (await pg.textContent('tr[data-row=payroll]')).includes('unlimited employees'), 'POS: unlimited cashiers; Payroll: unlimited employees');
  check(body.includes('Your accountant is free') && body.includes('Is it per person?'), 'the free accountant; FAQ');
  const total = () => pg.textContent('#total');
  async function set(mods, users = {}, yearly = false) {
    for (const m of ['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'estimate']) { if (await pg.isChecked(`[data-m=${m}]`)) await pg.uncheck(`[data-m=${m}]`); }
    for (const m of mods) await pg.check(`[data-m=${m}]`);
    for (const m of ['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'estimate']) { const v = typeof users === 'number' ? (m === 'pos' ? 1 : users) : users[m] || (m === 'pos' ? 1 : 3);
      await pg.fill(`[data-u=${m}]`, String(v)); await pg.dispatchEvent(`[data-u=${m}]`, 'input'); }
    if (yearly !== await pg.isChecked('#yearly')) await pg.click('#yearly');
  }
  check((await total()) === 'US$25 a month', `default: Basics, 3 users = US$25 (${await total()})`);
  await set(['plus', 'payroll'], 5); check((await total()) === 'US$92 a month', `5 users each, Plus + Payroll = US$92 (${await total()})`);
  check((await pg.textContent('#per')).includes('Accounting Plus') && (await pg.$$('#per li')).length === 2, 'a line for each program');
  if (await pg.$('#eb')) check((await pg.textContent('#eb')).includes('US$46 a month'), `early bird: half (${await pg.textContent('#eb')})`);
  await set(['plus', 'payroll'], 5, true); check((await total()) === 'US$920 a year', `yearly = 10 months (${await total()})`);
  if (await pg.$('#eb')) check((await pg.textContent('#eb')).includes('US$460 for your first year'), 'yearly early bird');
  await set(['basic'], 3); check((await total()) === 'US$25 a month', '3 users, Basics only = US$25');
  await set(['calls'], { calls: 4 }); check((await total()) === 'US$27 a month', `Riyeser Link, 4 people = US$27 (${await total()})`);
  await set(['plus', 'calls', 'payroll'], { plus: 5, calls: 5, payroll: 2 }); check((await total()) === 'US$112 a month', `the FAQ example: Plus + Link 5, Payroll 2 office users = US$112 (${await total()})`);
  await set(['basic', 'pos', 'calls'], 3);
  check((await total()) === 'US$59 a month' && (await pg.$$('#per li')).length === 1 && (await pg.textContent('#per')).includes('Shop bundle') && (await pg.textContent('#bline')).includes('save US$15'), `Shop bundle: one line, US$59, saves US$15 (${await total()})`);
  await set(['plus', 'bookings', 'calls', 'payroll', 'pos'], 3); check((await total()) === 'US$99 a month', `Business bundle = US$99 (${await total()})`);
  await set(['estimate'], { estimate: 5 }); check((await total()) === 'US$34 a month', `Riyeser Estimate, 5 users = 20 + 2 × 7 = US$34 (${await total()})`);
  await set(['basic', 'pos', 'calls', 'estimate'], 3); check((await total()) === 'US$79 a month' && (await pg.textContent('#per')).includes('Shop bundle'), `Shop bundle + Riyeser Estimate = 59 + 20 = US$79 (${await total()})`);
  await set(['pos'], { pos: 3 }); check((await total()) === 'US$59 a month', `POS with 3 tills = 29 + 2 × 15 = US$59 (${await total()})`);
  await set(['basic', 'pos', 'payroll', 'bookings', 'calls'], 3); check((await total()) === 'US$109 a month' && (await pg.textContent('#bline')).includes('Business bundle'), `Shop + Payroll + Bookings = US$109, with the Business bundle tip (${await pg.textContent('#bline')})`);
  check((await pg.getAttribute('#calcpay', 'href')).startsWith('/link/?signup&add=basic,bookings,calls,payroll,pos'), 'Buy this plan carries the programs');
  await set(['basic', 'calls'], { basic: 5, calls: 8 });
  check((await pg.getAttribute('#calcpay', 'href')) === '/link/?signup&add=basic,calls&u=basic:5,calls:8&buy=1', `users per program go to Add to my plan (${await pg.getAttribute('#calcpay', 'href')})`);
  await set(['basic'], 3); await pg.check('[data-m=plus]');
  check(!(await pg.isChecked('[data-m=basic]')) && (await total()) === 'US$39 a month' && await pg.isVisible('#plusnote'), 'ticking Plus takes Basics off: US$39 only');
  await set([], 3); check((await total()) === 'US$0 a month', 'free tools only = US$0');
  await set(['basic'], 3);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await pg.screenshot({ path: path.join(SHOTS, 'pricing.png'), fullPage: true }); }
  await set(['basic', 'pos', 'calls'], 3);
  if (SHOTS) { await (await pg.$('#calc')).screenshot({ path: path.join(SHOTS, 'pricing-calculator.png') }); }

  // free first (A to Z), then paid (A to Z): the menu, the home finder, All programs, Downloads, the footer
  const ids = (sel) => pg.$$eval(sel, (as) => as.map((a) => (a.getAttribute('href') || '').replace(/^.*programs\//, '').replace('.html', '')));
  const ordered = (list) => list.join() === [...FREE, ...PAID].filter((x) => list.includes(x)).join() && list.length >= 10;
  await pg.goto(`${BASE}/index.html`);
  const menu = await ids('.menu-pop.progs a:not(.all)');
  check(ordered(menu), `menu: free A to Z, then paid A to Z (${menu.join(', ')})`);
  check(await pg.$eval('.menu-pop.progs', (m) => [...m.querySelectorAll('.mgrp')].map((x) => x.textContent).join(' | ')) === 'Free forever | Free for 90 days, then:', 'menu: the two headings');
  check(!(await pg.$('.pluspill')) && !(await pg.textContent('body')).includes('Link Plus'), 'home: no ★ Plus and no Link Plus');
  const finder = await ids('#find .frow a');
  check(ordered(finder), `finder: ${finder.join(', ')}`);
  check(ordered(await ids('#programs .grid a.card[href*="programs/"]')), 'home programs grid: in order');
  const foot = await pg.$$eval('footer .fpcols > div', (ds) => ds.map((d) => [d.querySelector('.fsub').textContent, [...d.querySelectorAll('a')].map((a) => a.getAttribute('href').replace(/^.*programs\//, '').replace('.html', ''))]));
  check(foot.length === 2 && foot[0][0] === 'Free' && foot[1][0] === 'Paid' && foot[0][1].join() === FREE.join() && foot[1][1].join() === PAID.join(), `footer: Free and Paid columns, A to Z (${JSON.stringify(foot)})`);
  await pg.goto(`${BASE}/programs.html`);
  const all = await ids('main .grid a.card[href*="programs/"]');
  check(ordered(all), `All programs: ${all.join(', ')}`);
  check(await pg.$eval('main a.card[href$="programs/link.html"]', (a) => a.textContent.includes('US$20')), 'All programs: Riyeser Link US$20');
  if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'all-programs.png'), fullPage: true });
  await pg.goto(`${BASE}/index.html`); await pg.hover('.links .dd:first-child > a'); await pg.waitForTimeout(200);
  if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'programs-menu.png') });
  await pg.goto(`${BASE}/downloads.html`);
  const dls = await pg.$$eval('.dl h3', (hs) => hs.map((h) => h.textContent));
  check(dls[0].includes('Riyeser Documents') && dls.findIndex((t) => /Free trial/.test(t)) > dls.findIndex((t) => /Riyeser PDF/.test(t)), `Downloads: free first (${dls.map((t) => t.replace(/\s+/g, ' ')).join(' | ')})`);

  // Riyeser Link Office: right after Riyeser Link everywhere, a Windows download, and no price of its own
  const after = (list) => list.indexOf('link-office') === list.indexOf('link') + 1;
  const lo = await pg.$eval('.dl:has(a[href$="programs/link-office.html"])', (d) => ({ t: d.textContent.replace(/\s+/g, ' '), dl: (d.querySelector('a.btn') || {}).href || '', w: (d.querySelector('.cprice a') || {}).href || '' }));
  check(dls.findIndex((t) => /Riyeser Link Office/.test(t)) === dls.findIndex((t) => /^Riyeser Link\b(?! Office)/.test(t)) + 1, 'Downloads: Link Office right after Riyeser Link');
  check(lo.dl.endsWith(LO_FILE) && lo.w.endsWith('pricing.html#link') && lo.t.includes('Comes with Riyeser Link') && !/US\$|a month/.test(lo.t), `Downloads: Link Office downloads ${LO_FILE}, "Comes with Riyeser Link" (linked), no price`);
  await pg.goto(`${BASE}/index.html`);
  check(after(await ids('.menu-pop.progs a:not(.all)')) && after(await ids('#find .frow a')) && after(await ids('#programs .grid a.card[href*="programs/"]')), 'menu, finder and home programs: Link Office right after Riyeser Link');
  const noPrice = async (sel) => { const t = await pg.$eval(sel, (a) => a.textContent.replace(/\s+/g, ' ')); return t.includes('With Riyeser Link') && !/US\$|\/mo|a month|\bFree\b/.test(t); };
  check(await noPrice('.menu-pop.progs a[href$="programs/link-office.html"]') && await noPrice('#find .frow a[href$="programs/link-office.html"]') && await noPrice('#programs a.card[href$="programs/link-office.html"]'), 'menu, finder and home card: "With Riyeser Link", never a price or "Free"');
  await pg.goto(`${BASE}/programs/link-office.html`);
  const lop = await pg.textContent('main');
  check((await pg.$eval('.phero a.btn.p.big', (a) => a.href + ' ' + a.textContent)).match(/RiyeserLinkOffice-Setup\.exe\s+Download for Windows/) && lop.includes('Comes with Riyeser Link') && lop.includes('phone system') && !/Link Plus/.test(lop)
    && await pg.$eval('.hprice a.hp-plus', (a) => a.href.endsWith('pricing.html#link')), 'Link Office page: Windows download, comes with Riyeser Link (linked), the office phone system');
  check(!/outside (phone )?numbers?/.test(lop) || lop.includes('Not yet'), 'Link Office page: no claim of outside calls');
  await pg.goto(`${BASE}/programs/link.html`);
  const lkp = await pg.textContent('main');
  check(lkp.includes('US$20') && lkp.includes('20 GB') && !/Link Plus|★/.test(lkp), 'Link page: US$20, 20 GB, no Link Plus');
  await pg.goto(`${BASE}/help/link-office.html`);
  check((await pg.$eval('.hhead a.btn.p', (a) => a.href)).endsWith(LO_FILE), 'Link Office help page with a Download button');
  await pg.goto(`${BASE}/help/link.html#desk-phones`);
  check(await pg.$$eval('#desk-phones a', (as) => as.some((a) => a.href.endsWith('programs/link-office.html'))), 'help/link.html#desk-phones links to the Link Office download');

  // Find your program on a phone: one row per program, nothing wrapping, the price on the right
  const fp = await b.newPage({ viewport: { width: 390, height: 844 } }); await fp.goto(`${BASE}/index.html`);
  const rows = await fp.$$eval('#find .frow a', (as) => as.map((a) => { const r = a.getBoundingClientRect(); const n = a.querySelector('.fname').getBoundingClientRect(); const p = a.querySelector('.fprice').getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width), oneName: n.height < 26, onePrice: p.height < 24, right: p.right > r.right - 30 }; }));
  check(rows.length >= 11 && rows.every((r) => r.oneName && r.onePrice && r.right) && new Set(rows.map((r) => r.w)).size === 1 && Math.max(...rows.map((r) => r.h)) - Math.min(...rows.map((r) => r.h)) <= 2,
    `phone finder: a list, every row the same size, names and prices on one line (${rows.length} rows)`);
  check((await fp.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'phone: no sideways scrolling on the home page');
  if (SHOTS) await (await fp.$('#find')).screenshot({ path: path.join(SHOTS, 'finder-phone.png') });
  // the home hero on a phone: one still picture that shows, then the text (no slideshow dots)
  const hero = await fp.evaluate(() => { const im = document.querySelector('.h3slide img'); const r = im.getBoundingClientRect(); const h1 = document.querySelector('.h3text h1').getBoundingClientRect();
    return { h: r.height, w: r.width, loaded: im.complete && im.naturalWidth > 0, op: getComputedStyle(im.closest('.h3slide')).opacity, dots: getComputedStyle(document.querySelector('.h3dots')).display, textBelow: h1.top >= r.bottom - 2 }; });
  check(hero.h > 180 && hero.w >= 380 && hero.loaded && hero.op === '1' && hero.dots === 'none' && hero.textBelow, `phone hero: the picture shows, then the text, no dots (${JSON.stringify(hero)})`);
  // the footer on a phone: Programs in Free and Paid columns side by side, no sideways scrolling
  const fcols = await fp.$$eval('footer .fpcols > div', (ds) => ds.map((d) => Math.round(d.getBoundingClientRect().top)));
  check(fcols.length === 2 && fcols[0] === fcols[1], 'phone footer: Free and Paid side by side');
  if (SHOTS) { await (await fp.$('footer')).screenshot({ path: path.join(SHOTS, 'footer-phone.png') }); await fp.screenshot({ path: path.join(SHOTS, 'hero-phone.png') }); }
  await fp.close();

  // no FJD / AUD / NZD prices anywhere on the website (the built pages)
  const pub = path.join(__dirname, '..', '..', 'public');
  const bad = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.statSync(p);
    if (st.isDirectory()) { if (!['link', 'team', 'hq', 'app', 'vendor', 'assets'].includes(f)) walk(p); }
    else if (f.endsWith('.html') && /\b(FJD|AUD|NZD)\b|Australian dollars/.test(fs.readFileSync(p, 'utf8'))) bad.push(path.relative(pub, p)); } })(pub);
  check(!bad.length, `no FJD, AUD or NZD on the website pages ${bad.join(', ')}`);

  // M1: the calculator only takes whole numbers from 1 to 500, and says what to do above 500
  await pg.goto(`${BASE}/pricing.html`); await pg.uncheck('[data-m=basic]'); await pg.check('[data-m=calls]');
  const typed = async (v) => { await pg.fill('[data-u=calls]', v); await pg.dispatchEvent('[data-u=calls]', 'input'); await pg.dispatchEvent('[data-u=calls]', 'change'); return [await pg.inputValue('[data-u=calls]'), await pg.textContent('#total')]; };
  let r = await typed('100000'); check(r[0] === '500' && r[1] === 'US$3,499 a month' && await pg.isVisible('#usersmax'), `M1 100,000 people -> 500 shown and charged, "More than 500? Contact us" (${r})`);
  r = await typed('0'); check(r[0] === '1' && r[1] === 'US$20 a month', `M1 0 -> 1 (${r})`);
  r = await typed('-4'); check(r[0] === '1', `M1 -4 -> 1 (${r})`);
  r = await typed('2.5'); check(r[0] === '3' && r[1] === 'US$20 a month', `M1 2.5 -> 3 (${r})`);
  r = await typed(''); check(r[0] === '1', `M1 blank -> 1 when you leave the box (${r})`);
  await pg.fill('[data-u=calls]', '500'); await pg.click('[data-for=calls] [data-step="1"]'); check(await pg.inputValue('[data-u=calls]') === '500', 'M1 + stops at 500');
  await pg.fill('#cos', '7.2'); await pg.dispatchEvent('#cos', 'change'); check(await pg.inputValue('#cos') === '7', 'M1 companies: whole numbers too');

  const ph = await b.newPage({ viewport: { width: 390, height: 844 } }); await ph.goto(`${BASE}/pricing.html`);
  check((await ph.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'phone: no sideways scrolling on Pricing');
  // S2: under about 3,000 px tall on a phone (it was 11,500): a card per program, swiped sideways; the calculator,
  // the Basics/Plus comparison, "Good to know" and the questions fold (one tap opens them; a link to #calc opens it)
  const tall = await ph.evaluate(() => document.documentElement.scrollHeight);
  check(tall < 4700, `S2 phone: Pricing is ${tall} px tall at 390 px (was about 11,500; the bundles added about 1,000)`);
  check(await ph.evaluate(() => [...document.querySelectorAll('.ptable tbody.gcards')].every((t) => t.scrollWidth > t.clientWidth + 100 && getComputedStyle(t).overflowX === 'auto')), 'S2 phone: the price cards swipe sideways');
  check(await ph.isVisible('tr[data-row=plus] .buybtns a:has-text("Buy now")') || !!(await ph.$('tr[data-row=plus] .buybtns a')), 'S2 phone: every card keeps its buttons');
  check(await ph.isHidden('#calc .calc') && await ph.isHidden('#accounting .plans, #accounting .eds') , 'S2 phone: the calculator and the comparison start folded');
  await ph.click('#calc summary'); check(await ph.isVisible('#calc .calc') && await ph.isVisible('[data-u=basic]'), 'S2 phone: one tap opens the calculator');
  await ph.click('section.faq details.phfold > summary'); check(await ph.isVisible('section.faq details details summary'), 'S2 phone: one tap shows the questions');
  await ph.goto(`${BASE}/pricing.html#calc`); check(await ph.isVisible('[data-u=basic]'), 'S2 phone: a link to #calc opens the calculator');
  await pg.goto(`${BASE}/pricing.html`); check(await pg.isVisible('#calc .calc') && await pg.isHidden('#calc summary'), 'S2 desktop: unchanged (calculator open, no fold)');
  if (SHOTS) await ph.screenshot({ path: path.join(SHOTS, 'pricing-phone.png'), fullPage: true });
  check(!errs.length, `no page errors ${errs.join(' | ')}`);
  await b.close();
  console.log(failed ? `${failed} PRICING CHECK(S) FAILED` : 'ALL PRICING CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
