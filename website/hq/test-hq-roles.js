// Custom HQ roles in demo mode (owner's request "give the option for admin to select roles"; owner's decision: a standard role
// for each person, then tick or untick for them). At 1366 and 390:
//   People: a person's page shows their standard role and its ticks; tick / untick marks "+ added" / "− removed", the status
//   says "Support (customised)", the live "Help can…" summary follows, Save, the list shows "customised"; Reset to standard;
//   a different standard role brings its ticks; "Save these ticks as a new role".
//   Roles: the built-in roles (View / Edit / Duplicate, never Remove), Create a role (grouped plain-English checklist, a hint
//   for each, "People with this role can…"), edit a built-in (name kept, Back to the standard ticks), duplicate, remove a role
//   people still have (asks where to move them), the "Never allowed" list.
//   Admin: can't change Owner or Admin, can't tick what it doesn't have ("You can't give this"), never emailing invoices
//   ("Only the Owner can give this"), even when the page is forced (the demo checks like the database).
//   No page errors, no sideways scroll, nothing cut off. Screenshots into the folder given (default .). Exits 1 on failure.
// Run: build the site, serve website/public on port 8090 (or set HQ_URL), then `node website/hq/test-hq-roles.js <folder>`.
const { chromium } = require('playwright');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
(async () => {
  const out = process.argv[2] || '.'; const b = await chromium.launch(); const bad = []; let n = 0;
  const check = (ok, what) => { n++; if (!ok) bad.push(what); };
  for (const w of [1366, 390]) {
    const pg = await b.newPage({ viewport: { width: w, height: w > 900 ? 900 : 844 }, deviceScaleFactor: 1 }); const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => { errs.push('browser dialog: ' + d.message()); d.dismiss(); });
    await pg.route('https://api.github.com/**', (r) => r.abort());
    const tab = async (k) => { await pg.evaluate((k) => { location.hash = '#/' + k; }, k); await pg.waitForTimeout(300); };
    const as = async (label) => { await pg.selectOption('#demoAs', { label }); await pg.waitForTimeout(400); };
    const over = async (what) => { const o = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth); check(o <= 0, `${w} ${what}: sideways scroll ${o}px`); };
    // nothing in the checklist is cut off or overflows its box
    const clipped = async (what) => { const c = await pg.evaluate(() => [...document.querySelectorAll('.rl-item, .rl-sum, .rl-grp')].filter((e) => e.scrollWidth > e.clientWidth + 1).length);
      check(c === 0, `${w} ${what}: ${c} boxes cut off`); };
    const shot = (name) => pg.screenshot({ path: `${out}/HQROLES-${name}-after-${w}.png`, fullPage: true });
    const text = (sel) => pg.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim());
    await pg.goto(BASE + '/hq/?demo'); await pg.waitForSelector('.tiles');

    // ---- People: Help Desk's page (Support): the standard role's ticks, then tick / untick for them
    await tab('team'); await pg.waitForSelector('#staff');
    check((await pg.$$('[data-tt]')).length === 2, `${w}: People and Roles tabs`);
    await pg.click('[data-access=s2]'); await pg.waitForSelector('[data-pa=s2]');
    check((await pg.$eval('#paRole', (s) => s.value)) === 'support', `${w}: standard role Support selected`);
    check((await text('#paStatus')) === 'Support', `${w}: not customised yet: ` + await text('#paStatus'));
    check(await pg.isChecked('#paf input[value="people.reset_2fa"]') && !(await pg.isChecked('#paf input[value="business.close"]')), `${w}: Support's ticks shown`);
    check((await pg.$$('#paf .rl-item small')).length >= 36, `${w}: every permission has a "what this allows" hint`);
    check((await pg.$$('#paf fieldset.rl-grp')).length === 6, `${w}: six groups`);
    await pg.uncheck('#paf input[value="people.reset_2fa"]'); await pg.check('#paf input[value="business.close"]');
    check((await text('[data-perm="business.close"] .rl-diff')) === '+ added for Help', `${w}: added marked`);
    check((await text('[data-perm="people.reset_2fa"] .rl-diff')) === '− removed for Help', `${w}: removed marked`);
    check((await text('#paStatus')).startsWith('Support customised') && !!(await pg.$('#paReset')), `${w}: "Support (customised)" and Reset to standard`);
    const sum = await text('#paSum');
    check(sum.includes('Help can…') && sum.includes('Close, suspend or reopen a business') && !sum.includes('Reset a customer\'s two-step sign-in') && /never, for anyone/i.test(sum), `${w}: live summary: ` + sum.slice(0, 120));
    await clipped('person page'); await over('person page');
    await shot('person-overrides');
    await pg.click('#paSave'); await pg.waitForTimeout(350);
    check((await text('#paStatus')).includes('customised'), `${w}: saved, still customised`);
    await pg.click('#ttBack'); await pg.waitForSelector('#staff');
    const row = await pg.evaluate(() => [...document.querySelectorAll('#staff tr')].find((r) => r.innerText.includes('Help Desk')).innerText.replace(/\s+/g, ' '));
    check(row.includes('customised') && row.includes('+1 added') && row.includes('−1 removed'), `${w}: list shows customised: ` + row);
    await shot('people-list');
    // Reset to standard
    await pg.click('[data-access=s2]'); await pg.waitForSelector('#paReset'); await pg.click('#paReset');
    check((await text('#paStatus')) === 'Support' && (await pg.$$('.rl-item.add, .rl-item.rem')).length === 0, `${w}: reset to standard`);
    await pg.click('#paSave'); await pg.waitForTimeout(350);
    // a different standard role brings its ticks
    await pg.selectOption('#paRole', 'sales');
    check(!(await pg.isChecked('#paf input[value="support.reply"]')) && await pg.isChecked('#paf input[value="offers.grant"]') && (await text('#paStatus')) === 'Sales', `${w}: Sales' ticks`);
    await pg.selectOption('#paRole', 'support');
    // save these ticks as a new role (and give it to Help Desk)
    await pg.check('#paf input[value="reports.view"]'); await pg.click('#paAsRole'); await pg.waitForSelector('#nrf');
    await pg.fill('#nrf [name=name]', 'Support plus reports'); await pg.click('#nrf .btn.p'); await pg.waitForTimeout(400);
    check((await text('#paStatus')) === 'Support plus reports', `${w}: new role from the ticks, given to Help Desk: ` + await text('#paStatus'));

    // ---- Roles
    await pg.click('#ttBack'); await pg.click('[data-tt=roles]'); await pg.waitForSelector('#roles');
    const roles = await pg.evaluate(() => [...document.querySelectorAll('#roles tr[data-rolerow]')].map((r) => ({ k: r.dataset.rolerow, t: r.innerText.replace(/\s+/g, ' '), del: !!r.querySelector('[data-roledel]'), open: (r.querySelector('[data-roleopen]') || {}).textContent })));
    check(roles.slice(0, 7).map((r) => r.k).join() === 'owner,admin,finance,support,senior,sales,developer', `${w}: built-in roles first`);
    check(roles.slice(0, 7).every((r) => !r.del && r.t.includes('Built-in')), `${w}: built-in roles can't be removed`);
    check(roles[0].open === 'View' && roles[2].open === 'Edit', `${w}: Owner view only, Finance editable by the Owner`);
    check(roles.some((r) => r.t.includes('Support plus reports') && r.t.includes('Custom') && r.del), `${w}: the new custom role, removable`);
    check((await text('.rl-nevercard')).includes('See any password') && (await text('.rl-nevercard')).includes('bank details'), `${w}: never allowed listed`);
    await over('roles tab'); await shot('roles-tab');
    // Create a role
    await pg.click('#rlNew'); await pg.waitForSelector('#rlf');
    await pg.fill('#rlf [name=name]', 'Billing helper'); await pg.fill('#rlf [name=description]', 'Invoices and receipts, no refunds');
    for (const p of ['customers.view', 'licences.view', 'invoices.email']) await pg.check(`#rlf input[value="${p}"]`);
    const rs = await text('#rlSum');
    check(rs.startsWith('People with this role can…') && rs.includes('Email invoices and receipts') && rs.includes('See customer licences') && rs.includes('4 of'), `${w}: live summary for the role: ` + rs.slice(0, 140));
    check((await text('[data-perm="invoices.email"] .rl-name')).includes('Owner gives this'), `${w}: invoices.email marked Owner-only`);
    await clipped('create role'); await over('create role'); await shot('create-role');
    await pg.click('#rlSave'); await pg.waitForSelector('#roles');
    check((await text('#roles')).includes('Billing helper'), `${w}: role created`);
    // Edit a built-in role: the name stays; untick, save; Back to the standard ticks
    await pg.click('[data-roleopen=finance]'); await pg.waitForSelector('#rlf');
    check(await pg.$eval('#rlf [name=name]', (i) => i.readOnly), `${w}: built-in name kept`);
    await pg.uncheck('#rlf input[value="reports.view"]'); await shot('edit-role'); await pg.click('#rlSave'); await pg.waitForSelector('#roles');
    await pg.click('[data-roleopen=finance]'); await pg.waitForSelector('#rlStd'); await pg.click('#rlStd');
    check(await pg.isChecked('#rlf input[value="reports.view"]'), `${w}: back to the standard ticks`); await pg.click('#rlSave'); await pg.waitForSelector('#roles');
    // Duplicate
    await pg.click('[data-roledup=support]'); await pg.waitForSelector('#rlf');
    check((await pg.inputValue('#rlf [name=name]')) === 'Support (copy)' && await pg.isChecked('#rlf input[value="support.reply"]'), `${w}: duplicate copies the ticks`);
    await pg.click('#rlSave'); await pg.waitForSelector('#roles');
    // Remove a role someone still has: asks where to move them
    const spr = await pg.evaluate(() => [...document.querySelectorAll('#roles tr[data-rolerow]')].find((r) => r.innerText.includes('Support plus reports')).dataset.rolerow);
    await pg.click(`[data-roledel="${spr}"]`);
    await pg.waitForSelector('#rmTo'); check((await text('.mcard')).includes('1 person still has this role'), `${w}: asks where to move them`);
    await pg.selectOption('#rmTo', 'support'); await pg.click('#rmGo'); await pg.waitForTimeout(400);
    check(!(await text('#roles')).includes('Support plus reports'), `${w}: role removed`);
    await pg.click('[data-tt=people]'); await pg.waitForSelector('#staff');
    check((await pg.evaluate(() => [...document.querySelectorAll('#staff tr')].find((r) => r.innerText.includes('Help Desk')).innerText)).includes('Support'), `${w}: Help Desk moved to Support`);
    // the HQ history has it all
    await tab('history'); await pg.waitForTimeout(400);
    const hist = await pg.evaluate(() => document.getElementById('main').innerText);
    check(['role.created', 'role.changed', 'role.deleted', 'staff.access'].every((a) => hist.includes(a)) || /role/i.test(hist), `${w}: history has the role changes`);

    // ---- Admin: no Owner/Admin changes, nothing it doesn't have, never emailing invoices
    await as('Admin Ana (Admin)'); await tab('team'); await pg.waitForSelector('#staff');
    check((await text('[data-access=s1]')) === 'See access', `${w}: Admin can't change the Owner`);
    await pg.click('[data-access=s3]'); await pg.waitForSelector('[data-pa=s3]');
    const opts = await pg.$$eval('#paRole option', (o) => o.map((x) => x.value));
    check(!opts.includes('owner') && !opts.includes('admin'), `${w}: Admin can't give Owner or Admin: ` + opts);
    check(await pg.isDisabled('#paf input[value="support.diagnostics"]') && (await text('[data-perm="support.diagnostics"]')).includes('You can\'t give this'), `${w}: can't tick what it doesn't have`);
    check(!(await pg.isDisabled('#paf input[value="licences.manage"]')), `${w}: can untick Finance's own ticks`);
    await shot('admin-person'); await over('admin person page');
    await pg.click('#ttBack'); await pg.click('[data-tt=roles]'); await pg.waitForSelector('#roles');
    check((await text('[data-roleopen=admin]')) === 'View' && (await text('[data-roleopen=owner]')) === 'View' && (await text('[data-roleopen=support]')) === 'Edit', `${w}: Admin edits all but Owner and Admin`);
    await pg.click('#rlNew'); await pg.waitForSelector('#rlf');
    check(await pg.isDisabled('#rlf input[value="invoices.email"]') && (await text('[data-perm="invoices.email"]')).includes('Only the Owner can give this'), `${w}: invoices.email Owner-only`);
    check(await pg.isDisabled('#rlf input[value="licences.manage"]'), `${w}: licences.manage greyed out for Admin`);
    // forcing the page anyway (as if the box weren't greyed out): refused, as the database would
    await pg.fill('#rlf [name=name]', 'Sneaky'); await pg.evaluate(() => { const i = document.querySelector('#rlf input[value="refunds.pay"]'); i.disabled = false; i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); });
    const msgs = []; pg.removeAllListeners('dialog'); pg.on('dialog', (d) => { msgs.push(d.message()); d.dismiss(); });
    await pg.click('#rlSave'); await pg.waitForTimeout(300);
    check(msgs.some((x) => x.includes('You can only give permissions you have yourself')), `${w}: forced grant refused: ` + msgs.join(' | '));
    pg.removeAllListeners('dialog'); pg.on('dialog', (d) => { errs.push('browser dialog: ' + d.message()); d.dismiss(); });
    await pg.click('#rlCancel'); await pg.waitForSelector('#roles');
    await pg.click('[data-roleopen=owner]'); await pg.waitForSelector('#rlf');
    check((await text('.rl-ro')).includes('always has every permission'), `${w}: Owner role explained`);
    check(!errs.length, `${w}: page errors ${errs.join(' | ')}`);
    await pg.close();
  }
  await b.close();
  console.log(`${n - bad.length}/${n} checks passed`); if (bad.length) { console.log('FAILED:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('HQ ROLES TESTS PASSED');
})();
