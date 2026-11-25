// Riyeser HQ → Reports → Website traffic, in demo mode: the date ranges (7 / 30 / 90 days, 12 months by week, custom),
// headline cards with the change on the period before, the chart's hover numbers, the funnel, the lists, Export CSV,
// the privacy line, hidden from staff without reports.view, and a phone with no sideways scrolling.
// Also checks the website's traffic script: on the published pages, under 1.5 KB, no cookies or localStorage.
// Run: build the site (node website/build-combined.mjs), serve website/public on port 8090, then
// `node website/hq/test-hq-traffic.js [screenshot folder]`. Exits 1 on failure.
const { chromium, devices } = require('playwright'); const fs = require('fs'); const path = require('path');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090'; const out = process.argv[2];
let bad = 0; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++; };
const points = (pg) => pg.evaluate(() => document.querySelector('.lc .ln').getAttribute('points').split(' ').length);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const pg = await (await b.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })).newPage();
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
  await pg.goto(BASE + '/hq/?demo#/traffic'); await pg.waitForSelector('#trFunnel');
  const nav = await pg.evaluate(() => [...document.querySelectorAll('.nkids [data-tab]')].map((x) => x.textContent.trim()));
  check(nav.includes('Business reports') && nav.includes('Website traffic'), 'Reports has Business reports and Website traffic');
  const tiles = await pg.evaluate(() => [...document.querySelectorAll('.trtiles .tile')].map((t) => t.innerText));
  check(tiles.length === 4 && /Visits/.test(tiles[0]) && /Page views/.test(tiles[1]) && /Pages per visit/.test(tiles[2])
    && tiles.slice(0, 3).every((t) => /previous 30 days/.test(t)), 'headline cards with the change on the previous period');
  check(await pg.evaluate(() => document.querySelector('#trc').offsetParent === null), 'custom dates hidden until Custom is chosen');
  check(await points(pg) === 30, 'a point a day for 30 days');
  const bb = await (await pg.$('.lc-plot')).boundingBox(); await pg.mouse.move(bb.x + bb.width * 0.5, bb.y + 40);
  check(/visits.*page views/.test(await pg.textContent('.lc-tip')), 'the chart shows the numbers on hover');
  await pg.mouse.move(2, 2); check(await pg.evaluate(() => document.querySelector('.lc-tip').offsetParent === null), 'and hides them after');
  const fnl = await pg.evaluate(() => [...document.querySelectorAll('.fnl li .fl b')].map((x) => x.textContent));
  check(fnl.join('|') === 'Website visits|Saw the pricing page|Signed up|Started a free trial|Paid', 'funnel: visits, pricing, sign-ups, trials, paid');
  check((await pg.$$('#trPages tr')).length > 5 && (await pg.$$('#trRefs .hb')).length > 3 && (await pg.$$('#trCamps tr')).length > 1
    && (await pg.$$('#trDev .hb')).length === 3 && (await pg.$$('#trReg .hb')).length > 3, 'top pages, referrers, campaigns, devices, regions');
  check(/No cookies, no IP addresses/.test(await pg.textContent('.trpriv')), 'says what is collected');
  if (out) await pg.screenshot({ path: path.join(out, 'hq-traffic.png'), fullPage: true });
  await pg.click('[data-trr="7"]'); await pg.waitForSelector('[data-trr="7"].on');
  check(await points(pg) === 7, '7 days');
  await pg.click('[data-trr="365"]'); await pg.waitForSelector('[data-trr="365"].on');
  check(/per week/.test(await pg.textContent('#trChart h3')), '12 months by week');
  await pg.click('[data-trr="custom"]'); await pg.waitForSelector('#trc:not([hidden])');
  await pg.fill('#trc [name=from]', '2026-10-01'); await pg.fill('#trc [name=to]', '2026-10-31'); await pg.click('#trc .btn');
  await pg.waitForFunction(() => document.querySelector('.lc .ln') && document.querySelector('.lc .ln').getAttribute('points').split(' ').length === 31);
  check(true, 'custom dates: 31 days of October');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#trcsv')]); const csv = fs.readFileSync(await dl.path(), 'utf8');
  check(/website-traffic-2026-10-01-to-2026-10-31/.test(dl.suggestedFilename()) && /"Section","Item","Visits","Page views"/.test(csv)
    && /"Funnel","Paid"/.test(csv) && /"Day","2026-10-31"/.test(csv), 'Export CSV');
  await pg.goto(BASE + '/hq/?demo'); await pg.waitForSelector('#demoAs');
  const sup = (await pg.evaluate(() => [...document.querySelectorAll('#demoAs option')].map((o) => [o.value, o.textContent]))).find((o) => /\(Support\)/.test(o[1]));
  await pg.selectOption('#demoAs', sup[0]); await pg.waitForTimeout(300);
  check(!(await pg.$('[data-tab=traffic]')), 'hidden from staff without reports.view');
  const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
  await ph.goto(BASE + '/hq/?demo#/traffic'); await ph.waitForSelector('#trFunnel');
  check(await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'phone: no sideways scrolling');
  // the website's script, in the built pages
  const pub = path.join(__dirname, '..', 'public'); const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');
  const tag = (read('pricing.html').match(/<script>\(function\(\)\{try\{var n=navigator[\s\S]*?<\/script>/) || [''])[0];
  check(tag && Buffer.byteLength(tag) < 1536 && /rpc\/track_visit/.test(tag) && !/cookie|localStorage/.test(tag) && /doNotTrack/.test(tag) && /globalPrivacyControl/.test(tag),
    `website traffic script: ${Buffer.byteLength(tag)} bytes, no cookies, respects Do Not Track and GPC`);
  check(!/track_visit/.test(read('hq/index.html')) && !/track_visit/.test(read('link/index.html')), 'not on HQ or the Riyeser Link app');
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(bad ? `${bad} HQ TRAFFIC CHECK(S) FAILED` : 'ALL HQ TRAFFIC CHECKS PASSED'); process.exit(bad ? 1 : 0);
})();
