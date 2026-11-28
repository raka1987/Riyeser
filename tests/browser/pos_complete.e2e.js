// Riyeser POS 2.11 screens at 1366 and 390 wide (the kitchen screen also at 1024x768, the usual tablet): the page
// never scrolls sideways, nothing errors, and the main flows work (variant picker, scan a variant, table actions).
//   python tests/browser/serve_pos_complete.py 8301 retail &
//   python tests/browser/serve_pos_complete.py 8302 restaurant &
//   node tests/browser/pos_complete.e2e.js
const { chromium } = require('playwright');
const R = process.env.RETAIL || 'http://127.0.0.1:8301', Q = process.env.RESTAURANT || 'http://127.0.0.1:8302';
const PAGES = [[R, '/pos/'], [R, '/inventory/1/variants'], [R, '/inventory/locations'], [R, '/inventory/locations/3'],
  [R, '/inventory/transfers'], [R, '/inventory/transfers/1'], [R, '/inventory/transfers/new'], [R, '/inventory/transfers/1/docket'],
  [R, '/inventory/variants/import'], [R, '/inventory/count?loc=3'], [R, '/inventory/low-stock?loc=3'], [R, '/pos/drawer'],
  [R, '/pos/setup'], [R, '/inventory/1/edit'], [Q, '/pos/'], [Q, '/pos/kitchen'], [Q, '/kds/']];
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
async function login(b, base, w, h) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage(); pg.errs = [];
  pg.on('pageerror', e => pg.errs.push(e.message)); pg.on('dialog', d => d.accept());
  await pg.goto(base + '/login'); await pg.fill('input[name=username]', 'admin'); await pg.fill('input[name=password]', 'admin');
  await Promise.all([pg.waitForNavigation(), pg.press('input[name=password]', 'Enter')]);
  return pg;
}
(async () => {
  const b = await chromium.launch();
  for (const [w, h] of [[1366, 768], [390, 844], [1024, 768]]) {
    for (const base of [R, Q]) {
      const pg = await login(b, base, w, h);
      for (const [bb, u] of PAGES) {
        if (bb !== base || (w === 1024 && !['/kds/', '/pos/'].includes(u))) continue;
        pg.errs.length = 0;
        const r = await pg.goto(base + u, { waitUntil: 'load' }); await pg.waitForTimeout(300);
        const side = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        check(r.status() < 400 && side <= 0 && !pg.errs.length, `${w} ${u}: opens, no sideways scroll (${side}), no errors ${pg.errs.join(' | ')}`);
      }
      await pg.context().close();
    }
  }
  // the variant picker and a variant's barcode at the till
  let pg = await login(b, R, 1366, 768);
  await pg.goto(R + '/pos/'); await pg.click('[data-id="1"]');
  check(await pg.isVisible('#mVar.show'), 'tapping a product with variants opens the picker');
  check(await pg.$$eval('#vGrid button', e => e.length) === 12, 'the picker lists the 12 variants');
  await pg.click('#vOpts [data-vv="Navy"]');
  check(await pg.$$eval('#vGrid button', e => e.length) === 4, 'choosing Navy narrows it to 4');
  await pg.click('#vGrid button:not(.out)');
  await pg.fill('#q', '930000001005'); await pg.press('#q', 'Enter');
  check(await pg.$$eval('#lines .cl', e => e.length) === 2, 'a scanned variant barcode is added directly');
  await pg.context().close();
  // table actions and the split screen (restaurant)
  pg = await login(b, Q, 390, 844);
  await pg.goto(Q + '/pos/'); await pg.click('#tnav [data-open="tables"]'); await pg.click('[data-table="9"]');
  await pg.click('#tact'); check(await pg.isVisible('#mTact.show'), 'Table opens move / merge / split');
  await pg.click('[data-ta="split"]'); await pg.waitForTimeout(300);
  check(await pg.isVisible('#mSplit.show'), 'Split the bill opens');
  const side = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(side <= 0, '390: the split screen fits');
  check(!pg.errs.length, 'no errors ' + pg.errs.join(' | '));
  await pg.context().close();
  await b.close();
  console.log(failed ? `${failed} failed` : 'all passed'); process.exit(failed ? 1 : 0);
})();
