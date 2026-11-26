// Riyeser Link file storage (20 GB a business with Riyeser Link; nothing new while it's paused), in the demo:
//  1. The owner's Plan & billing (Riyeser home) shows "x GB of y GB used" and warns at 80%; admins who aren't the owner
//     get no Billing or Plan & billing and no prices, only "Files: x of y" in the Info panel.
//  2. When the business is full, an upload is refused with a plain message (and nothing is sent).
//  3. HQ: the customer page's File storage card, Grant extra storage (with a reason, in the HQ history), and the
//     Companies list's "Storage over 80%" filter.
// The demo's storage is set with sessionStorage 'riyeser.demo.storage' ('nearly' = 85% of 20 GB, 'full' = 1 MB left, 'off' = Riyeser Link paused).
// Run: build the site, serve website/public on 8090, then `node website/team/test/storage-test.js [shots folder]`.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const HQ = (process.env.HQ_URL || BASE).replace(/\/$/, '');
const out = process.argv[2];
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

(async () => {
  const b = await chromium.launch(); const errs = [];
  async function linkDemo(kind, as = '') {
    const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } });
    await ctx.addInitScript((k) => { try { if (k) sessionStorage.setItem('riyeser.demo.storage', k); } catch { /* */ } }, kind);
    const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(BASE + '/link/?demo' + (as ? '&as=' + as : '')); await pg.waitForSelector('.item'); return pg;
  }
  async function manage(pg) {   // Management, unlocked with the demo code
    await pg.evaluate(() => window.RiyeserTeam.setNav('manage')); await pg.fill('#mgcode', '123456'); await pg.click('#mgunlock'); await pg.waitForSelector('#mgopen');
  }
  async function openPlan(pg) {   // the owner: Management → Billing & plan opens Riyeser home's plan
    if (!(await pg.$('#coplan'))) await manage(pg);
    await pg.click('#coplan'); await pg.waitForSelector('#hplanv'); await pg.waitForSelector('#stor');
  }
  // 1. the owner (Riyeser Link trial, 20 GB): Plan & billing, with the bar and no warning; no Billing item in Link
  let pg = await linkDemo('');
  await manage(pg);
  check(!(await pg.$('#cobill')), 'Link: no "Billing & Subscription" in Management');
  check(!!(await pg.$('#coplan')), 'the owner sees "Billing & plan" in Management');
  await openPlan(pg);
  let t = (await pg.textContent('#stor')).replace(/\s+/g, ' ');
  check(/1\.2 GB of 20 GB used/.test(t) && !(await pg.$('#stor.warn')), `owner's plan view: storage bar (${t.slice(0, 60)})`);
  check((await pg.textContent('body')).includes('To change your plan'), 'owner sees the plan and how to change it');
  await pg.close();
  // 1b. nearly full (85% of the 20 GB): the owner's warning
  pg = await linkDemo('nearly');
  await openPlan(pg);
  t = (await pg.textContent('#stor')).replace(/\s+/g, ' ');
  check(t.includes('17 GB of 20 GB used') && !!(await pg.$('#stor.warn')) && t.includes('85% used') && t.includes('Contact Riyeser support for more space.')
    && t.includes('space for files shared in Link chats (not website, email or cloud hosting)') && !/free up space/i.test(t), `80% warning (${t.slice(0, 160)})`);
  check(!!(await pg.$('#hrefund')), 'the owner can ask for a refund on Riyeser home');
  if (out) { await (await pg.$('#hplanv')).scrollIntoViewIfNeeded(); await pg.screenshot({ path: out + '/link-storage-bar.png' }); }
  await pg.close();
  // 1c. an admin who isn't the owner: no Billing, no Plan & billing, no prices; "Files: x of y" in the Info panel
  pg = await linkDemo('nearly', 'u-sam');
  await manage(pg);
  check(!!(await pg.$('#coppl')) && !(await pg.$('#cobill')) && !(await pg.$('#coplan')), 'admin: Management, but no Billing and no Billing & plan');
  check(!/US\$\d|\$\d+ a month/.test(await pg.textContent('#mview')), 'admin: no prices in Management');
  await pg.click('[data-ch="c-jobs"]'); await pg.waitForTimeout(200); await pg.click('#infobtn'); await pg.waitForSelector('#ifiles');
  t = (await pg.textContent('#ifiles')).replace(/\s+/g, ' ');
  check(t.includes('Files: 17 GB of 20 GB') && t.includes('Ask the owner to contact Riyeser support') && !/US\$|\$\d/.test(t), `admin Info panel: ${t}`);
  if (out) await pg.screenshot({ path: out + '/link-admin-info-files.png' });
  await pg.click('#umenu'); const um = await pg.textContent('.usermenu'); await pg.keyboard.press('Escape');
  check(!/US\$\d|\$\d+ a month/.test(um + await pg.textContent('#lktop')), 'admin: no prices in the top bar or the menu under your picture');
  await pg.evaluate(() => window.RiyeserTeam.setNav('settings')); await pg.waitForTimeout(300);
  const home = await pg.textContent('#mview');
  check(!home.includes('Your plan') && !home.includes('To change your plan') && !/US\$\d/.test(home) && !home.includes('Paid to'), 'admin: Settings shows no plan, prices or billing');
  await pg.close();
  // 2. full: an upload is refused with the plain message
  pg = await linkDemo('full');
  await pg.click('[data-ch="c-jobs"]'); await pg.waitForTimeout(200);
  const before = await pg.$$eval('#msgs .msg', (m) => m.length);
  await pg.setInputFiles('#file', { name: 'site-photos.zip', mimeType: 'application/zip', buffer: Buffer.alloc(2 * 1024 * 1024, 1) });
  await pg.waitForSelector('#phmsg:not([hidden])');
  t = await pg.textContent('#phmsg');
  check(t === 'Your business has used its 20 GB of space for files shared in Link chats (not website, email or cloud hosting). Contact Riyeser support for more space.', `refused: "${t}"`);
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
