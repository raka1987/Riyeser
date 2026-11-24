// The website's prices and program lists (riyeser.com, built by website/build.mjs):
//  1. The pricing page says "US$" and "All prices in US dollars", and the calculator gives the worked examples
//     (US$7 a month for each person over the 3 included, per paid program: 5 people with Accounting Plus + Payroll = US$92;
//     3 people with Basics = US$25; Link Plus with 4 people = US$46; Plus + Payroll + Link Plus with 5 people = US$145; Basics and Plus never both; yearly = 10 x; early bird half).
//  2. No FJD, AUD or NZD prices anywhere on the website.
//  3. Free programs come first everywhere programs are listed (menu, finder, All programs, Downloads), starting with
//     Riyeser Central, and Riyeser Link has the gold "★ Plus" marker.
// Run: build the site, serve website/public on 8090, then `node website/team/test/pricing-test.js [shots folder]`.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const SHOTS = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const FREE = ['central', 'invoices', 'link', 'pdf', 'desk-assistant'];

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
  const freeFirst = (list) => { const lastFree = Math.max(...list.map((x, i) => (FREE.includes(x) ? i : -1))); const firstPaid = list.findIndex((x) => !FREE.includes(x)); return firstPaid === -1 || lastFree < firstPaid; };
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

  // no FJD / AUD / NZD prices anywhere on the website (the built pages)
  const pub = path.join(__dirname, '..', '..', 'public');
  const bad = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.statSync(p);
    if (st.isDirectory()) { if (!['link', 'team', 'hq', 'app', 'vendor', 'assets'].includes(f)) walk(p); }
    else if (f.endsWith('.html') && /\b(FJD|AUD|NZD)\b|Australian dollars/.test(fs.readFileSync(p, 'utf8'))) bad.push(path.relative(pub, p)); } })(pub);
  check(!bad.length, `no FJD, AUD or NZD on the website pages ${bad.join(', ')}`);

  const ph = await b.newPage({ viewport: { width: 390, height: 844 } }); await ph.goto(`${BASE}/pricing.html`);
  check((await ph.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'phone: no sideways scrolling on Pricing');
  if (SHOTS) await ph.screenshot({ path: path.join(SHOTS, 'pricing-phone.png'), fullPage: true });
  check(!errs.length, `no page errors ${errs.join(' | ')}`);
  await b.close();
  console.log(failed ? `${failed} PRICING CHECK(S) FAILED` : 'ALL PRICING CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
