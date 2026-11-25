// The website's prices and program lists (riyeser.com, built by website/build.mjs):
//  1. The pricing page says "US$" and "All prices in US dollars", and the calculator gives the worked examples
//     (US$7 a month for each person over the 3 included, per paid program: 5 people with Accounting Plus + Payroll = US$92;
//     3 people with Basics = US$25; Link Plus with 4 people = US$46; Plus + Payroll + Link Plus with 5 people = US$145; Basics and Plus never both; yearly = 10 x; early bird half).
//  2. No FJD, AUD or NZD prices anywhere on the website.
//  3. Free programs come first everywhere programs are listed (menu, finder, All programs, Downloads), starting with
//     Riyeser Central, and Riyeser Link has the gold "★ Plus" marker.
//  4. Riyeser Link Office is listed right after Riyeser Link (home finder and programs, the Programs menu, Downloads, its own
//     page and help page) with a Windows download, and never a price of its own: "With Link Plus", linked to #link-plus.
//  5. Find your program on a phone is a tidy list: one row per program, names and prices on one line.
// Run: build the site, serve website/public on 8090, then `node website/team/test/pricing-test.js [shots folder]`.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const SHOTS = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const FREE = ['central', 'invoices', 'link', 'pdf', 'desk-assistant'];
// Listed with the free programs, right after Riyeser Link, though it comes with Link Plus (no price of its own).
const FREE_GROUP = [...FREE, 'link-office'];
const LO_FILE = 'RiyeserLinkOffice-Setup.exe';

(async () => {
  const b = await chromium.launch(); const errs = [];
  const pg = await b.newPage({ viewport: { width: 1300, height: 900 } }); pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(`${BASE}/pricing.html`);
  const body = await pg.textContent('body');
  check(body.includes('US$') && body.includes('All prices in US dollars'), 'pricing page: "US$" and "All prices in US dollars"');
  check(body.includes('per business') && body.includes('3 users'), 'pricing page: per business, 3 users included');
  check(body.includes('2 GB of file storage per business free; 20 GB with Link Plus'), 'pricing page: Link file storage');
  check(await pg.isVisible('#link-plus'), 'pricing page: the Link Plus row (#link-plus)');
  // "What's free": every free program says what's included and its limits; only Riyeser Link has one (2 GB of files)
  const free = await pg.$$eval('tr[data-free]', (rs) => rs.map((r) => [r.dataset.free, r.querySelector('.freeinfo') ? r.querySelector('.freeinfo').textContent.replace(/\s+/g, ' ') : '', !!r.querySelector('.nolim')]));
  check(free.length === 5 && free.every(([, t]) => t.includes('Included free:') && t.includes('Limits')), `What's free on all 5 free programs (${free.map((x) => x[0]).join(', ')})`);
  check(free.filter(([, , n]) => n).map(([id]) => id).join(',') === 'central,invoices,pdf,desk-assistant', 'No limits (green) on all but Riyeser Link');
  check(free.some(([id, t]) => id === 'link' && t.includes('2 GB of space per business for files shared in chat') && t.includes('Riyeser Link Plus available')), 'Riyeser Link: the 2 GB limit and the Link Plus line');
  check(free.some(([id, t]) => id === 'invoices' && t.includes('Accounting Basics (US$25/month)')), 'Invoices: the upgrade note with the Basics price');
  check(body.includes('Are the free programs really free?'), 'FAQ: Are the free programs really free?');
  const total = () => pg.textContent('#total');
  async function set(mods, people, yearly = false) {
    for (const m of ['basic', 'plus', 'payroll', 'pos', 'bookings', 'calls']) { if (await pg.isChecked(`[data-m=${m}]`)) await pg.uncheck(`[data-m=${m}]`); }
    for (const m of mods) await pg.check(`[data-m=${m}]`);
    await pg.fill('#users', String(people)); await pg.dispatchEvent('#users', 'input');
    if (yearly !== await pg.isChecked('#yearly')) await pg.click('#yearly');
  }
  check((await total()) === 'US$25 a month', `default: Basics, 3 people = US$25 (${await total()})`);
  await set(['plus', 'payroll'], 5); check((await total()) === 'US$92 a month', `5 people, Plus + Payroll = US$92 (${await total()})`);
  check((await pg.textContent('#per')).includes('Accounting Plus') && (await pg.$$('#per li')).length === 2, 'a line for each program');
  if (await pg.$('#eb')) check((await pg.textContent('#eb')).includes('US$46 a month'), `early bird: half (${await pg.textContent('#eb')})`);
  await set(['plus', 'payroll'], 5, true); check((await total()) === 'US$920 a year', `yearly = 10 months (${await total()})`);
  if (await pg.$('#eb')) check((await pg.textContent('#eb')).includes('US$460 for your first year'), 'yearly early bird');
  await set(['basic'], 3); check((await total()) === 'US$25 a month', '3 people, Basics only = US$25');
  await set(['calls'], 4); check((await total()) === 'US$46 a month', `Link Plus, 4 people = US$46 (${await total()})`);
  await set(['plus', 'payroll', 'calls'], 5); check((await total()) === 'US$145 a month', `Plus + Payroll + Link Plus, 5 people = US$145 (${await total()})`);
  await set(['basic'], 3); await pg.check('[data-m=plus]');
  check(!(await pg.isChecked('[data-m=basic]')) && (await total()) === 'US$39 a month' && await pg.isVisible('#plusnote'), 'ticking Plus takes Basics off: US$39 only');
  await set([], 3); check((await total()) === 'US$0 a month', 'free tools only = US$0');
  await set(['basic'], 3);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await pg.screenshot({ path: path.join(SHOTS, 'pricing.png'), fullPage: true }); }
  await set(['plus', 'payroll'], 5);
  if (SHOTS) { await (await pg.$('#calc')).screenshot({ path: path.join(SHOTS, 'pricing-calculator.png') }); }

  // free first, then paid: the menu, the home finder, All programs, Downloads
  const ids = (sel) => pg.$$eval(sel, (as) => as.map((a) => (a.getAttribute('href') || '').replace(/^.*programs\//, '').replace('.html', '')));
  const freeFirst = (list) => { const lastFree = Math.max(...list.map((x, i) => (FREE_GROUP.includes(x) ? i : -1))); const firstPaid = list.findIndex((x) => !FREE_GROUP.includes(x)); return firstPaid === -1 || lastFree < firstPaid; };
  await pg.goto(`${BASE}/index.html`);
  const menu = await ids('.menu-pop.progs a:not(.all)');
  check(menu[0] === 'central' && freeFirst(menu) && menu.length >= 10, `menu: Central first, free before paid (${menu.join(', ')})`);
  check(await pg.$eval('.menu-pop.progs', (m) => [...m.querySelectorAll('.mgrp')].map((x) => x.textContent).join(' | ')) === 'Free forever | Free for 90 days, then:', 'menu: the two headings');
  check(await pg.$eval('.menu-pop.progs a[href$="programs/link.html"]', (a) => !!a.querySelector('.pluspill') && a.querySelector('.pluspill').title.includes('US$39/month')), 'menu: ★ Plus next to Riyeser Link, with the price');
  const finder = await ids('#find .frow a');
  check(finder[0] === 'central' && freeFirst(finder), `finder: Central first, free before paid (${finder.join(', ')})`);
  const home = await ids('#programs .grid a.card[href*="programs/"]');
  check(home[0] === 'central' && freeFirst(home), 'home programs grid: free first');
  // the marker opens the pricing page's Link Plus section, even inside a card
  await pg.click('#programs a.card[href$="programs/link.html"] .pluspill'); await pg.waitForURL(/pricing\.html#link-plus/);
  check(true, 'the ★ Plus marker on a card goes to pricing.html#link-plus');
  await pg.goto(`${BASE}/programs.html`);
  const all = await ids('main .grid a.card[href*="programs/"]');
  check(all[0] === 'central' && freeFirst(all), `All programs: free first (${all.join(', ')})`);
  check(await pg.$eval('main a.card[href$="programs/link.html"]', (a) => !!a.querySelector('.pluspill') && a.textContent.includes('Riyeser Link Plus available')), 'All programs: ★ Plus and the Link Plus line on Riyeser Link');
  // the pill is readable: dark text on gold
  const contrast = await pg.$eval('main .pluspill', (el) => {
    const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const L = (c) => { const [r, g, bl] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
    const s = getComputedStyle(el); const a = L(rgb(s.color)); const bb = L(rgb(s.backgroundColor)); return (Math.max(a, bb) + 0.05) / (Math.min(a, bb) + 0.05);
  });
  check(contrast >= 4.5, `★ Plus pill contrast ${contrast.toFixed(1)}:1`);
  if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'all-programs.png'), fullPage: true });
  await pg.goto(`${BASE}/index.html`); await pg.hover('.links .dd:first-child > a'); await pg.waitForTimeout(200);
  if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'programs-menu.png') });
  await pg.goto(`${BASE}/downloads.html`);
  const dls = await pg.$$eval('.dl h3', (hs) => hs.map((h) => h.textContent));
  check(dls[0].includes('Riyeser Invoices') && dls.findIndex((t) => /Free trial/.test(t)) > dls.findIndex((t) => /Riyeser Link/.test(t)), 'Downloads: free first');
  check(await pg.$$eval('.dl', (ds) => ds.some((d) => d.textContent.includes('Riyeser Link') && d.querySelector('.pluspill'))), 'Downloads: ★ Plus on Riyeser Link');

  // Riyeser Link Office: right after Riyeser Link everywhere, a Windows download, and no price of its own
  const after = (list) => list.indexOf('link-office') === list.indexOf('link') + 1;
  const lo = await pg.$eval('.dl:has(a[href$="programs/link-office.html"])', (d) => ({ t: d.textContent.replace(/\s+/g, ' '), dl: (d.querySelector('a.btn') || {}).href || '', plus: (d.querySelector('.cprice a') || {}).href || '' }));
  check(dls.findIndex((t) => /Riyeser Link Office/.test(t)) === dls.findIndex((t) => /^Riyeser Link\b(?! Office)/.test(t)) + 1, 'Downloads: Link Office right after Riyeser Link');
  check(lo.dl.endsWith(LO_FILE) && lo.plus.endsWith('pricing.html#link-plus') && lo.t.includes('Comes with Riyeser Link Plus') && !/US\$|a month/.test(lo.t), `Downloads: Link Office downloads ${LO_FILE}, "Comes with Riyeser Link Plus" (linked), no price`);
  await pg.goto(`${BASE}/index.html`);
  check(after(await ids('.menu-pop.progs a:not(.all)')) && after(await ids('#find .frow a')) && after(await ids('#programs .grid a.card[href*="programs/"]')), 'menu, finder and home programs: Link Office right after Riyeser Link');
  const noPrice = async (sel) => { const t = await pg.$eval(sel, (a) => a.textContent.replace(/\s+/g, ' ')); return t.includes('With Link Plus') && !/US\$|\/mo|a month|\bFree\b/.test(t); };
  check(await noPrice('.menu-pop.progs a[href$="programs/link-office.html"]') && await noPrice('#find .frow a[href$="programs/link-office.html"]') && await noPrice('#programs a.card[href$="programs/link-office.html"]'), 'menu, finder and home card: "With Link Plus", never a price or "Free"');
  check(await pg.$eval('#programs a.card[href$="programs/link-office.html"] .plusq', (x) => x.dataset.href.endsWith('pricing.html#link-plus') && x.textContent.includes('Comes with Riyeser Link Plus')), 'home card: "Comes with Riyeser Link Plus" goes to #link-plus');
  await pg.goto(`${BASE}/programs/link-office.html`);
  const lop = await pg.textContent('main');
  check((await pg.$eval('.phero a.btn.p', (a) => a.href + ' ' + a.textContent)).match(/RiyeserLinkOffice-Setup\.exe\s+Download for Windows/) && lop.includes('Comes with Riyeser Link Plus') && !/US\$/.test(lop)
    && await pg.$eval('.hprice a.hp-plus', (a) => a.href.endsWith('pricing.html#link-plus')), 'Link Office page: Windows download, comes with Link Plus (linked), no price');
  check(!/outside (phone )?numbers?/.test(lop) || lop.includes('Not yet'), 'Link Office page: no claim of outside calls');
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
  await fp.close();

  // no FJD / AUD / NZD prices anywhere on the website (the built pages)
  const pub = path.join(__dirname, '..', '..', 'public');
  const bad = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.statSync(p);
    if (st.isDirectory()) { if (!['link', 'team', 'hq', 'app', 'vendor', 'assets'].includes(f)) walk(p); }
    else if (f.endsWith('.html') && /\b(FJD|AUD|NZD)\b|Australian dollars/.test(fs.readFileSync(p, 'utf8'))) bad.push(path.relative(pub, p)); } })(pub);
  check(!bad.length, `no FJD, AUD or NZD on the website pages ${bad.join(', ')}`);

  // M1: the calculator only takes whole numbers from 1 to 500, and says what to do above 500
  await pg.goto(`${BASE}/pricing.html`); await pg.uncheck('[data-m=basic]'); await pg.check('[data-m=pos]');
  const typed = async (v) => { await pg.fill('#users', v); await pg.dispatchEvent('#users', 'input'); await pg.dispatchEvent('#users', 'change'); return [await pg.inputValue('#users'), await pg.textContent('#total')]; };
  let r = await typed('100000'); check(r[0] === '500' && r[1] === 'US$3,508 a month' && await pg.isVisible('#usersmax'), `M1 100,000 people -> 500 shown and charged, "More than 500? Contact us" (${r})`);
  r = await typed('0'); check(r[0] === '1' && r[1] === 'US$29 a month', `M1 0 -> 1 (${r})`);
  r = await typed('-4'); check(r[0] === '1', `M1 -4 -> 1 (${r})`);
  r = await typed('2.5'); check(r[0] === '3' && r[1] === 'US$29 a month', `M1 2.5 -> 3 (${r})`);
  r = await typed(''); check(r[0] === '1', `M1 blank -> 1 when you leave the box (${r})`);
  await pg.fill('#users', '500'); await pg.click('[data-d="1"]'); check(await pg.inputValue('#users') === '500', 'M1 + stops at 500');
  await pg.fill('#cos', '7.2'); await pg.dispatchEvent('#cos', 'change'); check(await pg.inputValue('#cos') === '7', 'M1 companies: whole numbers too');

  const ph = await b.newPage({ viewport: { width: 390, height: 844 } }); await ph.goto(`${BASE}/pricing.html`);
  check((await ph.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'phone: no sideways scrolling on Pricing');
  // S2: under about 3,000 px tall on a phone (it was 11,500): a card per program, swiped sideways; the calculator,
  // the Basics/Plus comparison, "Good to know" and the questions fold (one tap opens them; a link to #calc opens it)
  const tall = await ph.evaluate(() => document.documentElement.scrollHeight);
  check(tall < 3300, `S2 phone: Pricing is ${tall} px tall at 390 px (was about 11,500)`);
  check(await ph.evaluate(() => [...document.querySelectorAll('.ptable tbody.gcards')].every((t) => t.scrollWidth > t.clientWidth + 100 && getComputedStyle(t).overflowX === 'auto')), 'S2 phone: the price cards swipe sideways');
  check(await ph.isVisible('tr[data-row=plus] .buybtns a:has-text("Buy now")') || !!(await ph.$('tr[data-row=plus] .buybtns a')), 'S2 phone: every card keeps its buttons');
  check(await ph.isHidden('#calc .calc') && await ph.isHidden('#accounting .plans, #accounting .eds') , 'S2 phone: the calculator and the comparison start folded');
  await ph.click('#calc summary'); check(await ph.isVisible('#calc .calc') && await ph.isVisible('#users'), 'S2 phone: one tap opens the calculator');
  await ph.click('section.faq details.phfold > summary'); check(await ph.isVisible('section.faq details details summary'), 'S2 phone: one tap shows the questions');
  await ph.goto(`${BASE}/pricing.html#calc`); check(await ph.isVisible('#users'), 'S2 phone: a link to #calc opens the calculator');
  await pg.goto(`${BASE}/pricing.html`); check(await pg.isVisible('#calc .calc') && await pg.isHidden('#calc summary'), 'S2 desktop: unchanged (calculator open, no fold)');
  if (SHOTS) await ph.screenshot({ path: path.join(SHOTS, 'pricing-phone.png'), fullPage: true });
  check(!errs.length, `no page errors ${errs.join(' | ')}`);
  await b.close();
  console.log(failed ? `${failed} PRICING CHECK(S) FAILED` : 'ALL PRICING CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
