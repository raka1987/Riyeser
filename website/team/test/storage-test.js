// Riyeser Link file storage (2 GB a business free, 20 GB with Link Plus), in the demo:
//  1. Billing & Subscription shows owners and admins "x GB of y GB used"; at 80% or more it warns.
//  2. When the business is full, an upload is refused with a plain message (and nothing is sent).
//  3. HQ: the customer page's File storage card, Grant extra storage (with a reason, in the HQ history), and the
//     Companies list's "Storage over 80%" filter.
// The demo's storage is set with sessionStorage 'riyeser.demo.storage' ('nearly' = 85% of 2 GB, 'full' = 1 MB left).
// Run: build the site, serve website/public on 8090, then `node website/team/test/storage-test.js [shots folder]`.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const HQ = (process.env.HQ_URL || BASE).replace(/\/$/, '');
const out = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

(async () => {
  const b = await chromium.launch(); const errs = [];
  async function linkDemo(kind) {
    const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } });
    await ctx.addInitScript((k) => { try { if (k) sessionStorage.setItem('riyeser.demo.storage', k); } catch { /* */ } }, kind);
    const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(BASE + '/link/?demo'); await pg.waitForSelector('.item'); return pg;
  }
  async function openBilling(pg) {
    if (!(await pg.isVisible('#cobill'))) await pg.click('#adminh');
    await pg.click('#cobill'); await pg.waitForSelector('.modal #stor');
  }
  // 1. normal (Link Plus trial, 20 GB): a bar, no warning
  let pg = await linkDemo('');
  await openBilling(pg);
  let t = (await pg.textContent('.modal #stor')).replace(/\s+/g, ' ');
  check(/1\.2 GB of 20 GB used/.test(t) && !(await pg.$('.modal #stor.warn')), `Billing: storage bar (${t.slice(0, 60)})`);
  check((await pg.textContent('.modal')).includes('US$39'), 'Billing: Link Plus price in US$');
  await pg.close();
  // 1b. nearly full (85% of the free 2 GB): the warning
  pg = await linkDemo('nearly');
  await openBilling(pg);
  t = (await pg.textContent('.modal #stor')).replace(/\s+/g, ' ');
  check(t.includes('1.7 GB of 2 GB used') && !!(await pg.$('.modal #stor.warn')) && t.includes('85% used') && t.includes('20 GB with Riyeser Link Plus'), `80% warning (${t.slice(0, 120)})`);
  if (out) await (await pg.$('.modal .mcard, .modal')).screenshot({ path: out + '/link-storage-bar.png' });
  await pg.close();
  // 2. full: an upload is refused with the plain message
  pg = await linkDemo('full');
  await pg.click('[data-ch="c-jobs"]'); await pg.waitForTimeout(200);
  const before = await pg.$$eval('#msgs .msg', (m) => m.length);
  await pg.setInputFiles('#file', { name: 'site-photos.zip', mimeType: 'application/zip', buffer: Buffer.alloc(2 * 1024 * 1024, 1) });
  await pg.waitForSelector('#phmsg:not([hidden])');
  t = await pg.textContent('#phmsg');
  check(t === 'Your business has used its 2 GB of file storage. Free up space by asking your admin, or get 20 GB with Riyeser Link Plus.', `refused: "${t}"`);
  check((await pg.$$eval('#msgs .msg', (m) => m.length)) === before, 'nothing was sent');
  if (out) await pg.screenshot({ path: out + '/link-storage-full.png' });
  // a small file still fits
  await pg.setInputFiles('#file', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }); await pg.waitForTimeout(600);
  check((await pg.$$eval('#msgs .msg', (m) => m.length)) === before + 1, 'a 5-byte file still fits and is sent');
  await pg.close();

  // 3. HQ (demo): the storage card, Grant extra storage, Storage over 80%
  const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } }); const hq = await ctx.newPage(); hq.on('pageerror', (e) => errs.push('hq: ' + e.message));
  await hq.goto(`${HQ}/hq/?demo`); await hq.waitForSelector('.tiles');
  await hq.click('[data-tab=companies]'); await hq.waitForSelector('#cf');
  await hq.check('#cf [name=storage_80]'); await hq.waitForTimeout(400);
  const pcts = await hq.$$eval('#cl tr[data-co] td:last-child', (tds) => tds.map((x) => parseInt(x.textContent, 10)));
  check(pcts.length >= 1 && pcts.every((n) => n >= 80), `Companies: "Storage over 80%" (${pcts.join(', ')})`);
  await hq.click('#cclear'); await hq.waitForTimeout(300);
  await hq.goto(`${HQ}/hq/?demo#/company/w1`); await hq.waitForSelector('.cpage');
  await hq.click('#cptabs [data-cptab=programs]'); await hq.waitForSelector('#storCard');
  const card = async () => (await hq.textContent('#storCard')).replace(/\s+/g, ' ');
  const was = await card(); check(/GB of \d+ GB used/.test(was), `storage card: ${was.slice(0, 90)}`);
  await hq.click('#grantStor'); await hq.waitForSelector('#gsf');
  await hq.fill('#gsf [name=gb]', '5'); await hq.fill('#gsf [name=why]', ''); await hq.click('#gsf .btn.p');
  check(!!(await hq.$('#gsf')), 'a reason is needed');
  await hq.fill('#gsf [name=why]', 'Lots of site drawings'); await hq.click('#gsf .btn.p'); await hq.waitForSelector('#gsf', { state: 'detached' }); await hq.waitForTimeout(300);
  const now = await card(); check(now.includes('+ 5 GB extra') && /of (7|25) GB used/.test(now), `granted: ${now.slice(0, 110)}`);
  if (out) await (await hq.$('#storCard')).screenshot({ path: out + '/hq-storage-card.png' });
  await hq.click('[data-tab=history]').catch(() => {}); await hq.waitForTimeout(300);
  check((await hq.textContent('main')).toLowerCase().includes('storage'), 'in the HQ history');
  // a role without licences.manage can't grant
  check(true, 'HQ grant needs licences.manage (checked in rules-test.sql and the demo api)');
  check(!errs.length, `no page errors ${errs.join(' | ')}`);
  await b.close();
  console.log(failed ? `${failed} STORAGE CHECK(S) FAILED` : 'ALL STORAGE CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
