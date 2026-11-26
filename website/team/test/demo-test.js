const { chromium, devices } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';   // LINK_BASE=http://127.0.0.1:8091 to use another port
(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2];
  const pg = await b.newPage({ viewport: { width: 1366, height: 820 } });
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await pg.goto(BASE + '/link/?demo'); await pg.waitForSelector('.item');
  const texts = (sel) => pg.evaluate((s) => [...document.querySelectorAll(s)].map((x) => x.textContent.trim()), sel);
  console.log('channels:', await texts('[data-ch] .nm'), 'unread badges:', await texts('.badge'));
  await pg.click('[data-ch="c-jobs"]'); await pg.waitForTimeout(200);
  console.log('chips:', (await texts('#msgs .chip')).slice(0, 3));
  await pg.fill('#txt', 'Booking 14 for INV-1052 tomorrow, @Jordan please'); await pg.press('#txt', 'Enter'); await pg.waitForTimeout(2400);
  console.log('after send + live reply:', (await texts('#msgs .mb')).slice(-2));
  await pg.screenshot({ path: out + '/team-desktop.png' });
  await pg.click('[data-dm="u-sam"]'); await pg.waitForTimeout(200); console.log('dm header:', await pg.textContent('#mhead h2'));
  await pg.click('#umenu'); await pg.click('#coset'); await pg.click('#inv'); await pg.waitForSelector('.modal'); console.log('invite link (Settings):', await pg.inputValue('#il')); await pg.click('#cl');
  await pg.click('#newchat'); await pg.click('#ncch'); await pg.fill('input[name=name]', 'Hill Rd Site'); await pg.click('.modal .btn.p'); await pg.waitForTimeout(200);
  console.log('new channel:', await pg.textContent('#mhead h2'));
  await pg.click('[data-ch="c-jobs"]'); await pg.waitForTimeout(200);
  const mine = await pg.$$('.msg:has([data-act="edit"])'); const lastMine = mine[mine.length - 1]; await lastMine.hover(); await (await lastMine.$('[data-act="edit"]')).click();
  await pg.fill('[data-edit] textarea', 'Booking 14 moved to Friday'); await pg.press('[data-edit] textarea', 'Enter'); await pg.waitForTimeout(200);
  console.log('edited shows:', (await texts('#msgs .mb')).filter((t) => t.includes('Friday')));
  const ph = await b.newContext({ ...devices['iPhone 13'] }); const pp = await ph.newPage(); pp.on('pageerror', (e) => errs.push('phone: ' + e.message));
  await pp.goto(BASE + '/link/?demo'); await pp.waitForSelector('.item');
  console.log('phone starts on the list?', !(await pp.evaluate(() => document.querySelector('.shell').classList.contains('inchat'))),
    'overflow', await pp.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  await pp.screenshot({ path: out + '/team-phone-list.png' });
  await pp.tap('[data-ch="c-jobs"]'); await pp.waitForTimeout(300); await pp.screenshot({ path: out + '/team-phone-chat.png' });
  await pp.tap('#mhead .back'); console.log('back to list:', !(await pp.evaluate(() => document.querySelector('.shell').classList.contains('inchat'))));
  const g = await b.newPage(); await g.goto(BASE + '/link/'); await g.waitForTimeout(500);
  console.log('not set up yet -> demo?', await g.evaluate(() => window.RiyeserTeam && window.RiyeserTeam.demo));
  console.log('errors:', errs); await b.close();
})();
