// Riyeser HQ in demo mode: every tab, a company, Riyeser Link Plus paid-until, notes, staff, history; plus a phone.
// Run: build the site, serve website/public on port 8090, then `node website/hq/test-hq.js <screenshot folder>`.
const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.';
  const pg = await b.newPage({ viewport: { width: 1366, height: 900 } });
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
  await pg.goto('http://127.0.0.1:8090/hq/?demo'); await pg.waitForSelector('.tiles');
  console.log('tabs:', await pg.evaluate(() => [...document.querySelectorAll('.tabs button')].map((x) => x.textContent)));
  console.log('tiles:', await pg.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => t.innerText.replace(/\n/g, ' | '))));
  console.log('noindex:', await pg.getAttribute('meta[name=robots]', 'content'));
  await pg.screenshot({ path: out + '/hq-overview.png' });
  await pg.click('[data-tab=companies]'); await pg.waitForSelector('#cl table');
  await pg.fill('#sf input', 'harbour'); await pg.click('#sf button'); await pg.waitForTimeout(200);
  console.log('search harbour:', await pg.evaluate(() => [...document.querySelectorAll('#cl tr.click b')].map((x) => x.textContent)));
  await pg.fill('#sf input', ''); await pg.click('#sf button'); await pg.waitForTimeout(200);
  await pg.screenshot({ path: out + '/hq-companies.png' });
  await pg.click('tr[data-co="w1"]'); await pg.waitForSelector('.panel');
  console.log('licence now:', await pg.evaluate(() => [...document.querySelectorAll('#licCard tr[data-mod]')].map((r) => r.cells[0].innerText + ': ' + r.cells[1].innerText).join(' | ')));
  await pg.selectOption('tr[data-mod=pos] [name=st]', 'active'); await pg.fill('tr[data-mod=pos] [name=dt]', '2027-06-30'); await pg.click('[data-save=pos]'); await pg.waitForTimeout(300);
  console.log('POS now:', (await pg.textContent('tr[data-mod=pos] .pill')).trim());
  await pg.fill('#plan [name=users]', '4'); await pg.selectOption('#plan [name=billing]', 'yearly'); await pg.click('#plan .btn'); await pg.waitForTimeout(300);
  console.log('licence heading:', (await pg.textContent('#licCard h3')).trim());
  await pg.fill('#nf input', 'Wants POS at the Lautoka branch'); await pg.click('#nf button'); await pg.waitForTimeout(300);
  console.log('notes:', await pg.evaluate(() => [...document.querySelectorAll('.nt')].map((x) => x.firstChild.textContent)));
  console.log('privacy line:', (await pg.textContent('.privacy')).trim());
  await pg.screenshot({ path: out + '/hq-company.png' });
  await pg.click('#x');
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
  await ph.goto('http://127.0.0.1:8090/hq/?demo'); await ph.waitForSelector('.tiles');
  console.log('phone overflow:', await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  // signed out, not configured -> the demo; real sign-in screen when configured
  const p3 = await b.newPage(); await p3.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"k"};' }));
  await p3.route('https://fake.supabase.test/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await p3.goto('http://127.0.0.1:8090/hq/'); await p3.waitForSelector('#g'); console.log('configured & signed out ->', await p3.textContent('#g h1'));
  console.log('errors:', errs); await b.close();
})();
