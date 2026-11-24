// Private chats in the demo: make one with chosen people, see who's in it, change it, leave it.
const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.';
  const pg = await b.newPage({ viewport: { width: 1366, height: 820 } });
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
  await pg.goto('http://127.0.0.1:8090/link/?demo'); await pg.waitForSelector('.item');
  const side = () => pg.evaluate(() => [...document.querySelectorAll('[data-ch]')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  console.log('sidebar:', await side());
  await pg.click('[data-ch="c-exec"]'); await pg.waitForTimeout(200);
  console.log('executives header:', (await pg.textContent('#mhead')).replace(/\s+/g, ' ').trim());
  // make a private "sales" chat with Sam and Alex
  await pg.click('#addch'); await pg.fill('input[name=name]', 'Sales');
  console.log('private is the default:', await pg.isChecked('input[name=who][value=some]'));
  console.log('people list shows:', await pg.isVisible('#pickwrap'), '| you are ticked and locked:', await pg.evaluate(() => { const me = document.querySelector('input[name=p][value="u-me"]'); return me.checked && me.disabled; }));
  await pg.check('input[name=p][value="u-sam"]'); await pg.check('input[name=p][value="u-alex"]');
  await pg.screenshot({ path: out + '/team-private-add.png' });
  await pg.click('.modal .btn.p'); await pg.waitForTimeout(300);
  console.log('new chat:', (await pg.textContent('#mhead')).replace(/\s+/g, ' ').trim());
  // change who's in it: add Jordan, take Alex out
  await pg.click('#ppl'); await pg.waitForSelector('.modal');
  await pg.check('.modal input[name=p][value="u-jordan"]'); await pg.uncheck('.modal input[name=p][value="u-alex"]');
  await pg.click('#sv'); await pg.waitForTimeout(200);
  const people = await pg.evaluate(() => window.RiyeserTeam.state.ch.people);
  console.log('after change, people:', people, '| header:', (await pg.textContent('#mhead small')).trim());
  // leave it
  await pg.click('#ppl'); await pg.waitForSelector('#lv'); await pg.click('#lv'); await pg.waitForTimeout(300);
  console.log('after leaving, sidebar:', await side());
  const ph = await b.newContext({ ...devices['iPhone 13'] }); const pp = await ph.newPage(); pp.on('pageerror', (e) => errs.push('phone: ' + e.message));
  await pp.goto('http://127.0.0.1:8090/link/?demo'); await pp.waitForSelector('.item'); await pp.tap('#addch'); await pp.check('input[name=who][value=some]');
  console.log('phone add-chat overflow:', await pp.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  await pp.screenshot({ path: out + '/team-private-phone.png' });
  console.log('errors:', errs); await b.close();
})();
