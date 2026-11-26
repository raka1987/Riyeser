// Riyeser HQ in demo mode: every tab, a customer page, Mark paid until, plan, notes, staff, history; plus a phone.
// Run: build the site, serve website/public on port 8090 (or set HQ_URL), then `node website/hq/test-hq.js <screenshot folder>`.
const { chromium, devices } = require('playwright');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.';
  const pg = await b.newPage({ viewport: { width: 1366, height: 900 } });
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
  await pg.goto(BASE + '/hq/?demo'); await pg.waitForSelector('.tiles');
  console.log('tabs:', await pg.evaluate(() => [...document.querySelectorAll('.snav .nv')].map((x) => x.textContent)));
  console.log('tiles:', await pg.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => t.innerText.replace(/\n/g, ' | '))));
  console.log('noindex:', await pg.getAttribute('meta[name=robots]', 'content'));
  await pg.screenshot({ path: out + '/hq-overview.png' });
  await pg.click('[data-tab=companies]'); await pg.waitForSelector('#cl table');
  await pg.fill('#sf input', 'harbour'); await pg.click('#sf button'); await pg.waitForTimeout(200);
  console.log('search harbour:', await pg.evaluate(() => [...document.querySelectorAll('#cl tr.click b')].map((x) => x.textContent)));
  await pg.fill('#sf input', ''); await pg.click('#sf button'); await pg.waitForTimeout(200);
  await pg.screenshot({ path: out + '/hq-companies.png' });
  await pg.fill('#sf input', 'sample plumbing'); await pg.click('#sf button'); await pg.waitForTimeout(200);
  await pg.click('tr[data-co="w1"]'); await pg.waitForSelector('.cpage'); await pg.click('[data-cptab=programs]'); await pg.waitForSelector('#licCard');
  console.log('licence now:', await pg.evaluate(() => [...document.querySelectorAll('#licCard tr[data-mod]')].map((r) => r.cells[0].innerText + ': ' + r.cells[1].innerText.replace(/\s+/g, ' ')).join(' | ')));
  await pg.click('tr[data-mod=pos] [data-manage]'); await pg.click('#mgl [data-q=paid_until]'); await pg.fill('#qa [name=until]', '2027-06-30'); await pg.fill('#qa [name=reason]', 'Paid by bank transfer'); await pg.click('#qa .btn.p'); await pg.waitForTimeout(300);
  console.log('POS now:', (await pg.textContent('tr[data-mod=pos] .pill')).trim(), (await pg.textContent('tr[data-mod=pos] td:nth-child(3)')).trim());
  await pg.fill('#plan [name=users]', '4'); await pg.selectOption('#plan [name=billing]', 'yearly'); await pg.click('#plan .btn'); await pg.waitForTimeout(300);
  console.log('licence heading:', (await pg.textContent('#licCard h3')).trim());
  await pg.click('[data-cptab=overview]'); await pg.fill('#nf input', 'Wants POS at the Lautoka branch'); await pg.click('#nf button'); await pg.waitForTimeout(300);
  console.log('notes:', await pg.evaluate(() => [...document.querySelectorAll('.nt')].map((x) => x.firstChild.textContent)));
  console.log('privacy line:', (await pg.textContent('.privacy')).trim());
  await pg.screenshot({ path: out + '/hq-company.png' });
  await pg.click('#cpBack');
  await pg.click('[data-tab=licences]'); await pg.waitForSelector('.tiles');
  console.log('licences:', await pg.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => t.innerText.replace(/\n/g, ' | '))));
  console.log('ending soon:', await pg.evaluate(() => [...document.querySelectorAll('tr[data-co]')].map((r) => r.innerText.replace(/\s+/g, ' ')).slice(0, 3)));
  await pg.screenshot({ path: out + '/hq-licences.png' });
  await pg.click('[data-tab=downloads]'); await pg.waitForSelector('#dl .tiles', { timeout: 20000 });
  console.log('downloads:', await pg.evaluate(() => [...document.querySelectorAll('#dl .tile')].map((t) => t.innerText.replace(/\n/g, ' | ')).slice(0, 3)),
    '| by program rows:', await pg.evaluate(() => document.querySelectorAll('#dl .hb').length), '| trend bars:', await pg.evaluate(() => document.querySelectorAll('#dl .bars .b').length));
  await pg.screenshot({ path: out + '/hq-downloads.png' });
  await pg.click('[data-tab=team]'); await pg.waitForSelector('#as');
  await pg.fill('#as input[name=email]', 'sales@riyeser.test'); await pg.fill('#as input[name=name]', 'Sales Sam'); await pg.selectOption('#as select', 'sales'); await pg.click('#as .btn');
  await pg.waitForTimeout(300); console.log('HQ team:', await pg.evaluate(() => [...document.querySelectorAll('.tbl tr td:first-child b')].map((x) => x.textContent)));
  await pg.click('[data-tab=history]'); await pg.waitForSelector('.tbl');
  console.log('history:', await pg.evaluate(() => [...document.querySelectorAll('.tbl tr')].slice(1, 4).map((r) => r.innerText.replace(/\s+/g, ' '))));
  const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
  await ph.goto(BASE + '/hq/?demo'); await ph.waitForSelector('.tiles');
  console.log('phone overflow:', await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  // phone widths (360 and 390): a compact bar with a Menu (every page, the current one marked; closes on a choice, Escape or a tap outside),
  // every page and a customer page without sideways scrolling, and tables shown as cards (one column, "Label: value").
  const bad = [];
  for (const [w, h] of [[390, 844], [360, 780]]) {
    const pp = await (await b.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true })).newPage(); pp.on('pageerror', (e) => errs.push(`${w}: ${e.message}`));
    await pp.goto(BASE + '/hq/?demo'); await pp.waitForSelector('.tiles');
    if (!(await pp.isVisible('.mbar #mnav')) || await pp.isVisible('.side')) bad.push(`${w}: no compact bar`);
    await pp.click('#mnav'); if (!(await pp.isVisible('#mmenu'))) bad.push(`${w}: Menu does not open`);
    if ((await pp.textContent('#mmenu .mmi.on .nl')).trim() !== 'Overview') bad.push(`${w}: current page not marked`);
    await pp.keyboard.press('Escape'); if (await pp.isVisible('#mmenu')) bad.push(`${w}: Escape does not close the Menu`);
    await pp.click('#mnav'); await pp.click('#mbarT'); if (await pp.isVisible('#mmenu')) bad.push(`${w}: a tap outside does not close the Menu`);
    const tabs = await pp.evaluate(() => [...document.querySelectorAll('#mmenu [data-tab]')].map((x) => x.dataset.tab)); const over = {};
    for (const k of tabs) { await pp.click('#mnav'); await pp.click(`#mmenu [data-tab=${k}]`); await pp.waitForTimeout(k === 'downloads' || k === 'traffic' ? 1500 : 450);
      if (await pp.isVisible('#mmenu')) bad.push(`${w}: Menu stays open after choosing ${k}`);
      const r = await pp.evaluate(() => ({ o: document.documentElement.scrollWidth - document.documentElement.clientWidth, t: document.getElementById('mbarT').textContent,
        rows: [...document.querySelectorAll('#main table.tbl tr:not(.thr):not([hidden])')].filter((tr) => tr.offsetParent).map((tr) => tr.getBoundingClientRect().width > tr.parentElement.getBoundingClientRect().width + 1 || getComputedStyle(tr).display !== 'flex').filter(Boolean).length }));
      over[k] = r.o; if (r.o > 0) bad.push(`${w} ${k}: ${r.o}px sideways scroll`); if (r.rows) bad.push(`${w} ${k}: ${r.rows} table rows not shown as cards`); }
    for (const hh of ['#/company/w1', '#/company/w1/programs', '#/company/w1/people', '#/company/w1/money']) { await pp.evaluate((x) => { location.hash = x; }, hh); await pp.waitForTimeout(500);
      const o = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); over[hh] = o; if (o > 0) bad.push(`${w} ${hh}: ${o}px sideways scroll`); }
    console.log(`phone ${w}px overflow:`, JSON.stringify(over)); await pp.context().close();
  }
  console.log(bad.length ? 'PHONE CHECK FAILED: ' + bad.join(' | ') : 'phone check (360 and 390): compact bar and Menu, no sideways scroll on any page, tables as cards'); if (bad.length) process.exitCode = 1;
  // signed out, not configured -> the demo; real sign-in screen when configured
  const p3 = await b.newPage(); await p3.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"k"};' }));
  await p3.route('https://fake.supabase.test/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await p3.goto(BASE + '/hq/'); await p3.waitForSelector('#g'); console.log('configured & signed out ->', await p3.textContent('#g h1'));
  console.log('errors:', errs); await b.close();
})();
