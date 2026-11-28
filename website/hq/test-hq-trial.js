// Riyeser HQ in demo mode: a support ticket's "Trial history" (the PC's free-trial record from the customer's own report,
// Riyeser online's anonymous record for that PC, the signed-in business's server trial dates, a plain-English verdict),
// read-only, loaded only when opened (each look in the HQ history); Finance/Owner can give a goodwill extension with a
// reason; Support can see but not extend; Senior (no trials.view) is told it needs the permission; the Licences page's
// count of trial PCs (never a PC code); phone width with no sideways scrolling.
// Run: build the site, serve website/public on port 8090, then `node website/hq/test-hq-trial.js <screenshot folder>`.
// (HQ_URL=http://127.0.0.1:8091 uses another port; SHOT_TAG=after names the screenshots TRIAL-hq-ticket-after-<width>.png.)
const { chromium } = require('playwright');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
(async () => {
  const b = await chromium.launch(); const errs = []; const bad = []; const out = process.argv[2] || '.'; const tag = process.env.SHOT_TAG || 'after';
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad.push(what); };
  for (const w of [1366, 390]) {
    const pg = await b.newPage({ viewport: { width: w, height: w > 500 ? 900 : 844 }, deviceScaleFactor: 1 });
    pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => { errs.push('a browser pop-up: ' + d.message()); d.dismiss(); });
    const text = async (sel) => (await pg.textContent(sel)).replace(/\s+/g, ' ').trim();
    const openT = async (title) => { await pg.click(`#tl .tk:has-text("${title}")`); await pg.waitForFunction((t) => (document.querySelector('.tview h2') || {}).textContent === t, title); };
    const details = async () => { if (await pg.isHidden('#trialCard')) await pg.click('#detBtn'); await pg.waitForSelector('#trialCard', { state: 'visible' }); };
    const openTrial = async () => { await details(); await pg.click('#trialCard > summary'); await pg.waitForSelector('#trialBody .trow, #trialBody .err'); };
    await pg.goto(`${BASE}/hq/?demo#/support`); await pg.waitForSelector('#tl .tk');
    await openT('Payroll export fails after update'); await details();
    check(!!(await pg.$('#trialCard')) && !(await pg.$eval('#trialCard', (x) => x.open)), `${w}: the ticket has a closed "Trial history" section`);
    const before = (await pg.evaluate(() => document.querySelectorAll('.flash').length));
    await openTrial();
    const t = await text('#trialBody');
    console.log(`${w} trial history:`, t.slice(0, 400));
    check(/^Consistent: trial started \d{1,2} \w{3} on this PC; reinstalled twice; dates agree\./.test(await text('#trialBody .tverdict')), `${w}: a plain-English verdict`);
    for (const label of ['Trial started', 'Ends', 'Days left', 'First seen online', 'Last seen', 'licence.json', 'Hidden marker', 'Windows registry', 'Company file', 'Riyeser online'])
      check(t.includes(label), `${w}: shows ${label}`);
    check(t.includes('Signed-in business (the server\'s licence decides)') && /Payroll: trial until/.test(t), `${w}: the signed-in business's server trial dates`);
    check(/PC code [0-9a-f]{8}…/.test(t) && !/[0-9a-f]{64}/.test(await pg.content().then((h) => h.replace(/<script[\s\S]*?<\/script>/g, ''))), `${w}: only a short PC code is shown, never the whole one`);
    check(t.includes('Installs of Riyeser Central: 3') && t.includes('Clock seen going backwards: no'), `${w}: installs and the clock`);
    check(!!(await pg.$('#trx')), `${w}: the Owner can extend`);
    check(before === 0 && !(await pg.$('#trialBody input:not([name=reason]), #trialBody textarea')), `${w}: read-only (only the extension's reason box)`);
    const sw = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(sw <= 1, `${w}: no sideways scrolling (${sw}px)`);
    await pg.$eval('#trialCard', (x) => x.scrollIntoView({ block: 'start' })); await pg.waitForTimeout(200);
    await pg.screenshot({ path: `${out}/TRIAL-hq-ticket-${tag}-${w}.png` });
    if (w === 1366) {
      // the look is in the HQ history
      await pg.goto(`${BASE}/hq/?demo#/history`); await pg.waitForTimeout(500);
      check((await text('main')).includes('trial.viewed'), 'each look is in the HQ history');
      // a goodwill extension (Owner): reason needed, then +14 days, in the history
      await pg.goto(`${BASE}/hq/?demo#/support`); await pg.waitForSelector('#tl .tk'); await openT('Payroll export fails after update'); await openTrial();
      await pg.click('#trx .btn'); check(await pg.isVisible('#trx'), 'a reason is needed');
      await pg.fill('#trx [name=reason]', 'Goodwill: trial ended while they were away'); await pg.click('#trx .btn');
      await pg.waitForSelector('#trialBody .pill.violet');
      check((await text('#trialBody')).includes('+14 goodwill') && /^Check: |^Consistent: /.test(await text('#trialBody .tverdict')), 'extended: +14 goodwill days shown');
      await pg.goto(`${BASE}/hq/?demo#/history`); await pg.waitForTimeout(500);
      check((await text('main')).includes('trial.extended'), 'the extension is in the HQ history');
      // Support: sees it, can't extend. Senior: needs trials.view.
      await pg.goto(`${BASE}/hq/?demo#/support`); await pg.waitForSelector('#demoAs');
      await pg.selectOption('#demoAs', { label: 'Help Desk (Support)' }); await pg.waitForSelector('#tl .tk');
      await openT('Payroll export fails after update'); await openTrial();
      check((await text('#trialBody')).includes('Trial started') && !(await pg.$('#trx')), 'Support: sees the trial history, no extension');
      await pg.selectOption('#demoAs', { label: 'Senior Sione (Senior support)' }).catch(async () => pg.selectOption('#demoAs', 's4')); await pg.waitForSelector('#tl .tk');
      await openT('Payroll export fails after update');
      check((await text('#trialCard')).includes('needs the trials.view permission') && !(await pg.$('#trialBody')), 'Senior: needs trials.view');
      // Licences: counts of trial PCs, never a PC code
      await pg.selectOption('#demoAs', 's1'); await pg.goto(`${BASE}/hq/?demo#/licences`); await pg.waitForSelector('#trialPcs table');
      const c = await text('#trialPcs'); console.log('trial PCs:', c);
      check(c.includes('Riyeser programs (shared trial)') && c.includes('Riyeser Estimate') && !/[0-9a-f]{16}/.test(c), 'Licences: trial PCs per program, counts only');
    }
    await pg.close();
  }
  await b.close();
  if (errs.length) { console.log('page errors:', errs); bad.push('page errors'); }
  console.log(bad.length ? `${bad.length} FAILED` : 'ALL HQ TRIAL TESTS PASSED');
  process.exit(bad.length ? 1 : 0);
})();
