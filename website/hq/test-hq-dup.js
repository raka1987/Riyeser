// Riyeser HQ in demo mode: 🔁 Close as duplicate is safe. It closes THIS account (the one open) and never pre-picks
// another: linking to the account being kept is optional ("Don't link it" is chosen to start with), likely matches
// come first with why they match, others only by searching, never itself or a closed one; this account's facts are
// shown; its Company ID must be typed; warnings (payments, paid programs, recent use, another owner, "you may be
// closing the wrong one") must be ticked; ✅ Reopen removes the duplicate link. Also 👑 Change owner starts empty.
// Desktop and iPhone width (no sideways scrolling).
// Run: build the site, serve website/public on port 8090, then `node website/hq/test-hq-dup.js <screenshot folder>`.
// (HQ_URL=http://127.0.0.1:8091 uses another port.)
const { chromium, devices } = require('playwright');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
(async () => {
  const b = await chromium.launch(); const errs = []; const bad = []; const out = process.argv[2] || '.';
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad.push(what); };
  async function session(opts) {
    const ctx = await b.newContext(opts); const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${BASE}/hq/?demo`); await pg.waitForSelector('.tiles'); return pg;
  }
  const openCo = async (pg, ws) => { await pg.evaluate((w) => { location.hash = '#/company/' + w; }, ws); await pg.waitForSelector(`.cpage[data-ws="${ws}"]`); await pg.waitForTimeout(250); };
  const txt = async (pg, sel) => (await pg.$eval(sel, (x) => x.innerText || x.textContent || '')).replace(/\s+/g, ' ').trim();
  const openDup = async (pg) => { await pg.click('#cpBody [data-fix=dup]'); await pg.waitForSelector('#dupf'); };
  const disabled = (pg) => pg.$eval('#dupGoBtn', (x) => x.disabled);

  const pg = await session({ viewport: { width: 1366, height: 900 } });
  // --- Sample Plumbing (2) was closed as a duplicate of Sample Plumbing: Reopen says the link goes, and removes it
  await openCo(pg, 'w7');
  check((await txt(pg, '.banner')).includes('duplicate of Sample Plumbing'), 'the closed copy shows its duplicate link');
  await pg.click('#cpBody [data-fix=reopen]'); await pg.waitForSelector('#fx');
  check((await txt(pg, '.mcard')).includes('The link to Sample Plumbing (closed as a duplicate) is removed'), 'Reopen says the duplicate link is removed');
  await pg.fill('#fx [name=reason]', 'Closed the wrong one'); await pg.click('#fx .btn.p'); await pg.waitForSelector('#fx', { state: 'detached' }); await pg.waitForTimeout(300);
  check(!(await pg.$('.banner')) && (await txt(pg, '.cphead')).includes('Open'), 'reopened: open again, no duplicate banner');
  check(!!(await pg.$('#cpBody [data-fix=dup]')), 'and Close as duplicate is offered again');

  // --- the busy, paid Sample Plumbing: its warnings, and choosing the unused copy to keep says "wrong one"
  await openCo(pg, 'w1'); await openDup(pg);
  check(!(await pg.$('#dupf select')), 'no drop-down of businesses');
  check(await pg.$eval('#dupf input[name=keep][value=""]', (x) => x.checked) && (await pg.$$('#dupf input[name=keep]:checked')).length === 1, 'nothing linked to start with ("Don\'t link it")');
  const this1 = await txt(pg, '.dupthis'); console.log('closing:', this1);
  check(this1.includes('Sample Plumbing') && this1.includes('RIY-7K3M-Q2') && this1.includes('Alex') && this1.includes('alex@sample.test') && this1.includes('Accounting Basics'),
    'this account: name, Company ID, owner, plan');
  check(/Paid invoices/.test(this1) && /People · PCs 5 · 3/.test(this1) && /Last activity/.test(this1) && /Signed up/.test(this1), 'and paid invoices, people, PCs, last activity, sign-up date');
  const w1risks = await txt(pg, '#dupRisks'); console.log('warnings:', w1risks);
  check(w1risks.includes('paying for programs') && w1risks.includes('used this account in the last 14 days') && !!(await pg.$('#dupRisks input[name=accept]')), 'paid + recently used: warnings to tick');
  await pg.click('#dupf input[name=keep][value=w7]');
  const back = await txt(pg, '#dupRisks'); console.log('keeping the copy:', back);
  check(back.includes('Keeping Sample Plumbing (2)') && back.includes('You may be closing the wrong one') && !!(await pg.$('#dupRisks li.hi')), 'keeping the unused copy: "you may be closing the wrong one", in red');
  await pg.fill('#dupCode', 'RIY-7K3M-Q2');
  check(await disabled(pg), 'Company ID typed but warnings not ticked: can\'t close');
  await pg.screenshot({ path: out + '/hq-dup-backwards.png' });
  await pg.click('.mcard [data-close]');

  // --- the copy: likely matches first, with why; only by search otherwise; never itself, never a closed one
  await openCo(pg, 'w7'); await openDup(pg);
  const ms = await pg.$$eval('#dupMatches input[name=keep]', (xs) => xs.map((x) => x.value)); console.log('matches:', ms.join(', '));
  check(ms[0] === 'w1' && ms.length <= 6, 'Sample Plumbing is the first possible match (a handful at most)');
  check(!ms.includes('w7') && !ms.includes('w6'), 'not itself, not a closed business');
  const why = await txt(pg, '#dupMatches .dupm:first-child .why'); console.log('why:', why);
  check(why.includes('Same owner email') && why.includes('Similar name'), 'labelled with why it matches');
  check((await pg.$$('#dupf input[name=keep]')).length <= 7, 'not a list of every business');
  await pg.click('#dupFind summary'); await pg.fill('#dupQ', 'RIY-7K3X'); await pg.click('#dupGo'); await pg.waitForTimeout(200);
  check((await txt(pg, '#dupRes')).includes('Nothing found'), 'search: this account is never offered');
  await pg.fill('#dupQ', 'Old Corner'); await pg.click('#dupGo'); await pg.waitForTimeout(200);
  check(await pg.$eval('#dupRes input[value=w6]', (x) => x.disabled) && (await txt(pg, '#dupRes')).includes('That account is closed'), 'search: a closed account can\'t be chosen, and says why');
  await pg.fill('#dupQ', 'harbour'); await pg.click('#dupGo'); await pg.waitForTimeout(200); await pg.click('#dupRes input[value=w2]');
  check((await txt(pg, '#dupRisks')).includes('different owner'), 'keeping another owner\'s account: warned');
  // the confirmation: the Company ID of THIS account, and the warnings ticked
  await pg.click('#dupMatches input[value=w1]');
  check(!(await txt(pg, '#dupRisks')).includes('different owner') && (await txt(pg, '#dupRisks')).includes('Keeping Sample Plumbing RIY-7K3M-Q2'), 'keeping Sample Plumbing: same owner, shown by name and Company ID');
  await pg.fill('#dupf [name=reason]', 'Signed up twice');
  check(await disabled(pg), 'no Company ID typed: can\'t close');
  await pg.fill('#dupCode', 'RIY-7K3M-Q2'); check(await disabled(pg), 'the kept account\'s Company ID doesn\'t count');
  await pg.fill('#dupCode', 'riy-7k3x-q9'); check(await disabled(pg), 'this account\'s Company ID, but the warning not ticked yet');
  await pg.check('#dupRisks input[name=accept]'); check(!(await disabled(pg)), 'Company ID typed and warnings ticked: Close is on');
  check((await txt(pg, '#dupGoBtn')) === 'Close RIY-7K3X-Q9', 'the button names the account being closed');
  await pg.screenshot({ path: out + '/hq-dup-confirm.png' });
  await (await pg.$('.mcard')).screenshot({ path: out + '/hq-dup-dialog.png' });
  await pg.click('#dupGoBtn'); await pg.waitForSelector('#dupf', { state: 'detached' }); await pg.waitForTimeout(300);
  console.log('flash:', await pg.evaluate(() => { const f = [...document.querySelectorAll('.flash')].pop(); return f ? f.textContent : ''; }));
  check((await txt(pg, '.banner')).includes('duplicate of Sample Plumbing') && (await txt(pg, '.banner')).includes('Duplicate: Signed up twice'), 'closed and linked to Sample Plumbing');
  await pg.click('#cptabs [data-cptab=history]'); await pg.waitForTimeout(300);
  check((await txt(pg, '#cpBody')).includes('closed as a duplicate'), 'in the HQ history');
  await pg.click('#cptabs [data-cptab=overview]'); await pg.waitForTimeout(200);
  // reopen again: the link goes
  await pg.click('#cpBody [data-fix=reopen]'); await pg.waitForSelector('#fx'); await pg.fill('#fx [name=reason]', 'Checking reopen'); await pg.click('#fx .btn.p');
  await pg.waitForSelector('#fx', { state: 'detached' }); await pg.waitForTimeout(300);
  check(!(await pg.$('.banner')), 'Reopen restores it, with no duplicate link');
  // linking is optional: close with "Don't link it"
  await openDup(pg); await pg.fill('#dupf [name=reason]', 'Owner asked'); await pg.fill('#dupCode', 'RIY-7K3X-Q9'); await pg.check('#dupRisks input[name=accept]');
  await pg.click('#dupGoBtn'); await pg.waitForSelector('#dupf', { state: 'detached' }); await pg.waitForTimeout(300);
  check((await txt(pg, '.banner')).startsWith('Closed') && !(await txt(pg, '.banner')).includes('duplicate of'), 'closed without a link (linking is optional)');

  // --- 👑 Change owner: nobody chosen to start with; shows owner now → new owner
  await openCo(pg, 'w3'); await pg.click('#cpBody [data-fix=owner]'); await pg.waitForSelector('#fx #ownSel');
  check((await pg.$eval('#ownSel', (x) => x.value)) === '' && (await txt(pg, '#ownSel option:checked')) === 'Choose the new owner…', 'Change owner: starts with "Choose the new owner…"');
  await pg.fill('#fx [name=reason]', 'Sold the business'); await pg.click('#fx .btn.p'); await pg.waitForTimeout(200);
  check(!!(await pg.$('#fx')) && await pg.$eval('#ownSel', (x) => x.validity.valueMissing), 'can\'t save without choosing someone');
  const v = await pg.$eval('#ownSel', (x) => [...x.options].find((o) => o.value).value); await pg.selectOption('#ownSel', v);
  const chg = await txt(pg, '#ownChg'); console.log('owner change:', chg);
  check(/Owner now .+ New owner .+/i.test(chg) && !chg.includes('nobody yet'), 'shows the owner now and the new owner');
  await (await pg.$('.mcard')).screenshot({ path: out + '/hq-change-owner.png' }); await pg.click('.mcard [data-close]');

  // --- iPhone: the dialog fits, no sideways scrolling, 16px inputs (no zoom)
  const ph = await session({ ...devices['iPhone 13'] });
  await openCo(ph, 'w1'); await ph.click('#cpBody [data-fix=dup]'); await ph.waitForSelector('#dupf');
  await ph.click('#dupFind summary'); await ph.fill('#dupQ', 'harbour'); await ph.click('#dupGo'); await ph.waitForSelector('#dupRes input[value=w2]'); await ph.click('#dupRes input[value=w2]');
  const fit = await ph.evaluate(() => { const m = document.querySelector('.mcard'); return { page: document.documentElement.scrollWidth, vw: innerWidth, mw: m.scrollWidth, mc: m.clientWidth,
    fs: getComputedStyle(document.querySelector('#dupCode')).fontSize }; });
  console.log('phone:', JSON.stringify(fit));
  check(fit.page <= fit.vw && fit.mw <= fit.mc, 'iPhone: no sideways scrolling');
  check(fit.fs === '16px', 'iPhone: 16px inputs (no zoom when typing)');
  await ph.screenshot({ path: out + '/hq-dup-phone.png' });
  await ph.evaluate(() => { document.querySelector('.mcard').scrollTop = 99999; }); await ph.waitForTimeout(100);
  await ph.fill('#dupCode', 'RIY-7K3M-Q2'); await ph.screenshot({ path: out + '/hq-dup-phone-bottom.png' });
  await ph.click('.mcard [data-close]'); await openCo(ph, 'w3'); await ph.click('#cpBody [data-fix=owner]'); await ph.waitForSelector('#ownSel');
  check(await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'iPhone: Change owner fits');
  await ph.screenshot({ path: out + '/hq-change-owner-phone.png' });

  console.log('errors:', errs); if (errs.length) bad.push('page errors');
  await b.close();
  console.log(bad.length ? `\n${bad.length} FAILED` : '\nALL HQ DUPLICATE TESTS PASSED'); process.exit(bad.length ? 1 : 0);
})();
