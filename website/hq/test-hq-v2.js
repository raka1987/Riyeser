// HQ V2 prototype (behind ?v2=1): the current HQ is untouched without the flag; with it, every menu page opens with no
// errors and no sideways scroll at 390, 768, 1366 and 1920; KPI cards say their source; "not built" pages say their phase;
// a role without access sees the no-access state; ?v2=0 switches it off again. Exits 1 on failure.
// Run: build the site, serve website/public on port 8090 (or set HQ_URL), then `node website/hq/test-hq-v2.js`.
const { chromium } = require('playwright');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
(async () => {
  const b = await chromium.launch(); const bad = []; const check = (ok, what) => { if (!ok) bad.push(what); };
  const page = async (w) => { const pg = await b.newPage({ viewport: { width: w, height: 900 } }); pg.errs = []; pg.v2req = 0;
    pg.on('pageerror', (e) => pg.errs.push(e.message)); pg.on('request', (r) => { if (/hq-v2\.(js|css)/.test(r.url())) pg.v2req++; });
    await pg.route('https://api.github.com/**', (r) => r.abort()); return pg; };
  // 1. the current HQ, no flag: V2 files never requested, the current menu is there
  let pg = await page(1366); await pg.goto(BASE + '/hq/?demo'); await pg.waitForSelector('.snav');
  check(pg.v2req === 0, 'default HQ requested hq-v2 files'); check(!(await pg.$('#v2')), 'default HQ shows the V2 frame');
  await pg.close();
  // 2. with ?v2=1, at each width: every page in the menu
  for (const w of [1366, 390, 768, 1920]) {
    pg = await page(w); await pg.goto(BASE + '/hq/?demo&v2=1#/overview'); await pg.waitForSelector('#v2'); await pg.waitForSelector('#ovk .k2:not(.s-loading)');
    const keys = await pg.evaluate(() => [...document.querySelectorAll('#nav2 .ni2')].map((a) => a.dataset.k));
    check(keys.length >= 40, `${w}: menu has ${keys.length} pages`);
    for (const k of keys.concat(['company/w1'])) {
      await pg.evaluate((k) => { location.hash = '#/' + k; }, k); await pg.waitForTimeout(350);
      const r = await pg.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, txt: (document.getElementById('main') || {}).innerText || '' }));
      check(r.over <= 0, `${w} ${k}: sideways scroll ${r.over}px`); check(r.txt.trim().length > 10, `${w} ${k}: empty page`);
      check(k === 'states' || !/Couldn’t load this page/.test(r.txt), `${w} ${k}: error state`);
    }
    check(!pg.errs.length, `${w}: page errors ${pg.errs.join(' | ')}`);
    await pg.close();
  }
  pg = await page(1366); await pg.goto(BASE + '/hq/?demo&v2=1#/overview'); await pg.waitForSelector('#ovk .k2:not(.s-loading)');
  const srcs = await pg.evaluate(() => [...document.querySelectorAll('#ovk .k2')].map((k) => k.querySelector('.k2s').innerText));
  console.log('overview KPI sources:', srcs);
  check(srcs.length === 6 && srcs.every((s) => /Source:/.test(s) && /loaded/.test(s)), 'overview KPIs say their source and freshness');
  await pg.evaluate(() => { location.hash = '#/pricing'; }); await pg.waitForTimeout(300);
  check(/Not built yet — planned in Phase 2/.test(await pg.innerText('#main')), 'Plans & pricing says not built yet, Phase 2');
  await pg.evaluate(() => { location.hash = '#/integrations'; }); await pg.waitForSelector('#il table');
  const states = await pg.evaluate(() => [...document.querySelectorAll('#il tr')].slice(1).map((r) => r.cells[0].innerText + ': ' + r.cells[1].innerText));
  console.log('integrations:', states);
  check(states.filter((s) => /Nightly backups|Restore test|HQ jobs/.test(s)).every((s) => !/Healthy/.test(s)), 'unchecked GitHub jobs never show Healthy');
  // search: a page name, then a customer
  await pg.fill('#q2', 'refund'); await pg.waitForSelector('#sr2:not([hidden])'); check(/Refunds/.test(await pg.innerText('#sr2')), 'search finds the Refunds page');
  await pg.fill('#q2', 'harbour'); await pg.press('#q2', 'Enter'); await pg.waitForTimeout(600);
  check(/#\/companies/.test(pg.url()), 'search Enter opens Customers');
  // no access: Finance opening Settings
  await pg.selectOption('#demoAs2', 's3'); await pg.waitForTimeout(400);
  check(!(await pg.$('#nav2 [data-k=settings]')), 'Finance has no Settings in the menu');
  await pg.evaluate(() => { location.hash = '#/settings'; }); await pg.waitForTimeout(300);
  check(/You don’t have access to this page/.test(await pg.innerText('#main')), 'Finance sees the no-access state on Settings');
  // phone: the menu slides in and closes
  await pg.close(); pg = await page(390); await pg.goto(BASE + '/hq/?demo&v2=1#/overview'); await pg.waitForSelector('#v2');
  await pg.click('#menuBtn'); await pg.waitForTimeout(300); check(await pg.evaluate(() => document.getElementById('v2').classList.contains('open')), 'phone menu opens');
  await pg.click('#nav2 [data-k=support]'); await pg.waitForTimeout(500); check(await pg.evaluate(() => !document.getElementById('v2').classList.contains('open')), 'phone menu closes on a page');
  // ?v2=0 switches back to the current HQ (and stays off)
  await pg.goto(BASE + '/hq/?demo&v2=0'); await pg.waitForSelector('.snav', { state: 'attached' }); check(!(await pg.$('#v2')), '?v2=0 back to the current HQ');
  await pg.goto(BASE + '/hq/?demo'); await pg.waitForSelector('.snav', { state: 'attached' }); check(!(await pg.$('#v2')), 'stays off after ?v2=0');
  await b.close();
  console.log(bad.length ? 'HQ V2 TEST FAILED:\n- ' + bad.join('\n- ') : 'HQ V2 TEST PASSED'); if (bad.length) process.exitCode = 1;
})();
