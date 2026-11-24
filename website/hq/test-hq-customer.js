// Riyeser HQ in demo mode: the customer page (#/company/<id>, every tab), one-click licence actions (+30 days on a trial;
// +90 days goes to Approvals; Mark paid until), Message customer, Log a call with a follow-up (My follow-ups), Reports with
// CSV, the Companies list (filters, sorting, pages, CSV), and no sideways scrolling at phone width.
// Run: build the site, serve website/public on port 8090, then `node website/hq/test-hq-customer.js <screenshot folder>`.
// (HQ_URL=http://127.0.0.1:8091 uses another port.)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
(async () => {
  const b = await chromium.launch(); const errs = []; const bad = []; const out = process.argv[2] || '.';
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad.push(what); };
  const ctx = await b.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true }); const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
  const text = async (sel) => (await pg.textContent(sel)).replace(/\s+/g, ' ').trim();
  const tab = async (k) => { await pg.click(`[data-tab=${k}]`); await pg.waitForTimeout(250); };
  const cptab = async (k) => { await pg.click(`#cptabs [data-cptab=${k}]`); await pg.waitForSelector(`#cpBody[data-tab=${k}]`); };
  const find = async (name) => { await tab('companies'); await pg.fill('#sf input', name); await pg.click('#sf button'); await pg.waitForTimeout(300); };
  const lastFlash = () => pg.evaluate(() => { const f = [...document.querySelectorAll('.flash')].pop(); return f ? f.textContent : ''; });
  const confirmQuick = async (reason, extra) => { await pg.waitForSelector('#qa'); if (extra) await extra(); await pg.fill('#qa [name=reason]', reason); await pg.click('#qa .btn.p'); await pg.waitForSelector('#qa', { state: 'detached' }); await pg.waitForTimeout(200); };
  await pg.goto(`${BASE}/hq/?demo`); await pg.waitForSelector('.tiles');

  // --- open a business from the list: a full page with its own address and every tab
  await find('Sample Plumbing'); await pg.click('tr[data-co="w1"]'); await pg.waitForSelector('.cpage');
  check(await pg.evaluate(() => location.hash) === '#/company/w1', 'the page has its own address (#/company/w1)');
  check(!(await pg.$('.panel')), 'a full page, not a side panel');
  const head = await text('.cphead'); console.log('header:', head.slice(0, 260));
  check(head.includes('Sample Plumbing') && head.includes('RIY-7K3M-Q2') && head.includes('Business') && head.includes('Fiji'), 'header: name, Company ID, kind, country');
  check(head.includes('alex@sample.test') && /\d{3}/.test(await pg.getAttribute('.cpowner a[href^="tel:"]', 'href')), 'header: the owner\'s phone (tel:) and email (mailto:)');
  check(!!(await pg.$('.cpowner a[href="mailto:alex@sample.test"]')) && !!(await pg.$('.cphead [data-copy="RIY-7K3M-Q2"]')), 'click to email, and copy the Company ID');
  console.log('health chips:', await pg.evaluate(() => [...document.querySelectorAll('#health .pill')].map((x) => x.textContent).join(' | ')));
  check((await pg.$$('#health .pill')).length >= 1, 'health chips');
  const tabs = await pg.evaluate(() => [...document.querySelectorAll('#cptabs button')].map((x) => x.textContent.replace(/\d+$/, '').trim()));
  console.log('tabs:', tabs.join(', '));
  check(['Overview', 'Programs', 'PCs & programs', 'People', 'Conversations', 'Money', 'History', 'Link'].every((t) => tabs.includes(t)), 'all eight tabs');
  check((await text('#contactCard')).includes('What they typed at sign-up') && (await text('#contactCard')).includes('Last sign-in'), 'Overview: the contact person, with what they typed at sign-up');
  await pg.screenshot({ path: out + '/hq-customer-overview.png', fullPage: true });
  const extra = { pcs: async () => check((await text('#pcsTbl')).includes('POS 1.4.0'), 'PCs & programs: which Riyeser programs are installed, with versions'),
    people: async () => check((await text('#ppl')).includes('555 0201') && !!(await pg.$('#ppl [data-mkowner]')) && !!(await pg.$('#ppl [data-r2fa]')), 'People: phone, Make owner, Reset two-step'),
    link: async () => { await pg.waitForSelector('#cpLink .lnk-sum'); check((await text('#cpLink .lnk-sum')).startsWith('Link Office:') && (await pg.getAttribute('#cpLink', 'data-ws')) === 'w1', 'Link tab: #cpLink with data-ws, filled by hq-link.js'); } };
  for (const t of ['programs', 'pcs', 'people', 'conversations', 'money', 'history', 'link']) { await cptab(t); check((await text('#cpBody')).length > 20, `tab ${t} shows something`); if (extra[t]) await extra[t](); }
  check(await pg.evaluate(() => location.hash) === '#/company/w1/link', 'each tab has an address too');
  await pg.goBack(); await pg.waitForSelector('#cl table'); check(await pg.evaluate(() => location.hash) === '#/companies', 'Back goes to the list');
  await pg.goForward(); await pg.waitForSelector('.cpage'); await pg.click('#cpBack'); await pg.waitForSelector('#cl table'); check(true, 'the ← Companies link goes back too');

  // --- Programs: +30 days on a trial applies; +90 goes to Approvals; Mark paid until
  await find('Northside'); await pg.click('tr[data-co="w3"]'); await pg.waitForSelector('.cpage'); await cptab('programs');
  const until = (m) => text(`#licCard tr[data-mod=${m}] td:nth-child(3)`);
  console.log('programs:', await pg.evaluate(() => [...document.querySelectorAll('#licCard tr')].slice(1).map((r) => [...r.cells].slice(0, 5).map((c) => c.innerText.replace(/\s+/g, ' ')).join(' / ')).join(' || ')));
  check((await text('#licCard')).includes('Riyeser Central') && (await text('#licCard tr.free')).includes('Free'), 'free programs shown as Free');
  const before = await until('bookings');
  await pg.click('#licCard tr[data-mod=bookings] [data-q=extend][data-days="30"]');
  console.log('confirm says:', await text('.mcard p'));
  await confirmQuick('Setting up took a while', () => pg.selectOption('#qa [name=why]', 'goodwill'));
  const after = await until('bookings'); console.log('+30 days:', await lastFlash(), '| Bookings until', before, '->', after);
  check(/30 free days applied/.test(await lastFlash()) && after !== before, '+30 days on a trial applies straight away');
  check(await pg.evaluate(() => location.hash) === '#/company/w3/programs', 'stays on the Programs tab');
  await pg.click('#licCard tr[data-mod=payroll] [data-q=extend][data-days="90"]');
  check((await text('.mcard p')).includes('over the 31-day limit'), 'the confirm warns that 90 days is over the limit');
  await confirmQuick('Wants a full quarter to decide');
  console.log('+90 days:', await lastFlash()); check(/waiting for a supervisor in Approvals/.test(await lastFlash()), '+90 days waits for a supervisor');
  await pg.click('#licCard tr[data-mod=pos] [data-q=paid_until]');
  await confirmQuick('Paid a year by bank transfer', async () => { await pg.fill('#qa [name=until]', '2027-11-30'); await pg.selectOption('#qa [name=why]', 'payment'); });
  console.log('mark paid:', await lastFlash(), '|', await text('#licCard tr[data-mod=pos]'));
  check((await text('#licCard tr[data-mod=pos] .pill')) === 'Paid' && (await until('pos')).includes('2027'), 'Mark paid until: POS paid to 30 Nov 2027');
  await pg.click('#licCard tr[data-mod=pos] [data-q=extend][data-days="7"]'); await pg.waitForSelector('#qa'); await pg.click('#qa .btn.p');
  check(await pg.evaluate(() => document.querySelector('#qa [name=reason]').validity.valueMissing), 'a reason is required'); await pg.click('.modal [data-close]');
  await pg.screenshot({ path: out + '/hq-customer-programs.png', fullPage: true });
  await tab('approvals'); const ao = await text('#ao'); console.log('approvals:', ao.slice(0, 200));
  check(ao.includes('Northside Dental') && ao.includes('90 free days'), 'the 90 days is in Approvals');
  await pg.click('#ao [data-goco]'); await pg.waitForSelector('.cpage'); check(await pg.evaluate(() => location.hash) === '#/company/w3/programs', 'Approvals links to the customer page');

  // --- Message customer: shows in Conversations (and the Support inbox)
  await pg.click('#cpMsg'); await pg.waitForSelector('#mc');
  console.log('message to:', await pg.$eval('#mc [name=to]', (s) => s.options[s.selectedIndex].text));
  check((await pg.$eval('#mc [name=to]', (s) => s.options[s.selectedIndex].text)).includes('(owner)'), 'addressed to the owner by default');
  await pg.fill('#mc [name=subject]', 'Your POS trial is nearly up'); await pg.fill('#mc [name=body]', 'Hi Priya, would you like a hand choosing a plan?'); await pg.click('#mc .btn.p');
  await pg.waitForSelector('#timeline'); await pg.waitForTimeout(200); console.log('message:', await lastFlash());
  const tl = await text('#timeline'); console.log('timeline:', tl.slice(0, 260));
  check(tl.includes('Message from Riyeser') && tl.includes('Your POS trial is nearly up'), 'Message customer appears in Conversations');
  check(tl.includes('Email') && tl.includes('Free period'), 'the timeline has emails and free periods too');
  await pg.screenshot({ path: out + '/hq-customer-conversations.png', fullPage: true });

  // --- Log a call with a follow-up: on My follow-ups (Overview tab and the HQ home)
  await pg.click('#cpCall'); await pg.waitForSelector('#lc'); await pg.check('#lc input[value=out]');
  const todayIso = await pg.evaluate(() => new Date().toISOString().slice(0, 10));
  await pg.fill('#lc [name=body]', 'Rang about the POS trial; call back after the weekend'); await pg.fill('#lc [name=fu]', todayIso); await pg.click('#lc .btn.p');
  await pg.waitForSelector('#lc', { state: 'detached' }); await pg.waitForTimeout(200); console.log('call:', await lastFlash());
  check((await text('#timeline')).includes('we called them'), 'the call is in the timeline');
  await cptab('overview'); await pg.waitForSelector('#fuBox .fu'); const fu = await text('#fuBox'); console.log('my follow-ups (customer page):', fu.slice(0, 200));
  check(fu.includes('Northside Dental') && fu.includes('Rang about the POS trial'), 'My follow-ups on the Overview tab');
  await tab('overview'); await pg.waitForSelector('#myfu'); const home = await text('#myfu'); console.log('home follow-ups:', home.slice(0, 200));
  check(home.includes('Northside Dental'), 'My follow-ups on the HQ home');
  console.log('needs attention:', await pg.evaluate(() => [...document.querySelectorAll('#attn .aitem')].map((x) => x.innerText.replace(/\s+/g, ' ')).join(' | ')));
  check((await pg.$$('#attn .aitem')).length >= 6, 'Needs attention on the home page');
  await pg.click('#attn [data-go="support:unassigned"]'); await pg.waitForSelector('.tk'); check(await pg.evaluate(() => location.hash) === '#/support' && (await pg.$eval('#boxes .chip.on', (x) => x.dataset.box)) === 'unassigned', 'an item opens the right page (unassigned tickets)');
  await pg.click('[data-box=waiting_customer]'); await pg.waitForTimeout(300);
  check((await text('#tl')).includes('Your POS trial is nearly up'), 'the staff-started ticket is in the Support inbox (waiting on the customer)');

  // --- Reports: renders, CSV export, date range
  await tab('reports'); await pg.waitForSelector('#rSignups .bars');
  console.log('report sections:', await pg.evaluate(() => [...document.querySelectorAll('#rep .card h3')].map((h) => h.childNodes[0].textContent.trim()).join(' | ')));
  check((await pg.$$('#rep .card')).length >= 12 && (await text('#rep')).includes('Estimate until payments are connected'), 'Reports: every section, money labelled as an estimate');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('[data-csv=signups]')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8'); console.log('reports CSV:', dl.suggestedFilename(), '|', csv.split('\r\n')[0].replace(/^﻿/, ''), '|', csv.split('\r\n').length - 1, 'rows');
  check(/^riyeser-hq-report-signups-90d-/.test(dl.suggestedFilename()) && csv.includes('Week starting'), 'Reports table downloads as CSV');
  const [dl2] = await Promise.all([pg.waitForEvent('download'), pg.click('[data-csv=trials_ending]')]);
  check(fs.readFileSync(await dl2.path(), 'utf8').includes('Days left'), 'the trials-ending list downloads too');
  await pg.click('[data-range="30"]'); await pg.waitForSelector('#rSignups'); check((await pg.$eval('#ranges .chip.on', (x) => x.dataset.range)) === '30', 'date range 30 / 90 / 365 days');
  await pg.click('#rEnding tr[data-co]'); await pg.waitForSelector('.cpage'); check(/#\/company\/.+\/programs/.test(await pg.evaluate(() => location.hash)), 'a trial ending links to that business');
  await tab('reports'); await pg.waitForSelector('#rSignups .bars'); await pg.screenshot({ path: out + '/hq-reports.png', fullPage: true });

  // --- Companies: pages, sorting, filters, quick views, CSV
  await find('');
  console.log('pager:', await text('#pager')); check((await text('#ctotal')).includes('1–50 of 125'), '50 a page, with the total');
  await pg.click('[data-page=next]'); await pg.waitForTimeout(300); check((await text('#ctotal')).includes('51–100 of 125'), 'next page');
  await pg.click('[data-sort=name]'); await pg.waitForTimeout(300);
  const names = await pg.evaluate(() => [...document.querySelectorAll('#cl tr.click b')].map((x) => x.textContent));
  check(names.length === 50 && names.every((n, i) => !i || names[i - 1].localeCompare(n) <= 0) && (await text('#ctotal')).startsWith('1–50'), 'sort by name (A to Z), back to page 1');
  await pg.click('[data-sort=name]'); await pg.waitForTimeout(300);
  const names2 = await pg.evaluate(() => [...document.querySelectorAll('#cl tr.click b')].map((x) => x.textContent)); check(names2[0].localeCompare(names2[1]) >= 0, 'click again: Z to A');
  await pg.click('[data-sort=tickets]'); await pg.waitForTimeout(300); check((await pg.$$eval('#cl tr.click', (r) => r[0].cells[6].innerText.trim())) !== '0', 'sort by open tickets');
  await pg.click('[data-view=paying]'); await pg.waitForTimeout(300);
  const plans = await pg.evaluate(() => [...document.querySelectorAll('#cl tr.click')].map((r) => r.cells[3].innerText.split('\n')[0]));
  console.log('paying customers:', await text('#ctotal'), plans.slice(0, 4).join(', ')); check(plans.length > 3 && plans.every((x) => /paid$/.test(x)), 'quick view: paying customers');
  await pg.click('[data-view=trials_week]'); await pg.waitForTimeout(300);
  const ends = await pg.evaluate(() => [...document.querySelectorAll('#cl tr.click')].map((r) => r.cells[4].innerText.split('\n')[0]));
  console.log('trials ending this week:', ends.join(', ')); check(ends.length >= 2 && ends.every((x) => /^(today|[1-7] days?)$/.test(x)), 'quick view: trials ending this week');
  await pg.click('#cclear'); await pg.waitForTimeout(300);
  await pg.selectOption('#cf [name=country]', 'Samoa'); await pg.waitForTimeout(300); await pg.check('#cf [name=open_tickets]'); await pg.waitForTimeout(300);
  console.log('Samoa + open tickets:', await text('#ctotal'));
  await pg.uncheck('#cf [name=open_tickets]'); await pg.waitForTimeout(300); await pg.selectOption('#cf [name=plan]', 'trial'); await pg.waitForTimeout(300);
  const samoa = await text('#ctotal'); check(/of (\d+)/.test(samoa) && Number(samoa.match(/of (\d+)/)[1]) < 25, `filters: country and plan (${samoa})`);
  await pg.click('#cclear'); await pg.waitForTimeout(300); await pg.selectOption('#cf [name=inactive_days]', '60'); await pg.waitForTimeout(300);
  console.log('inactive 60 days:', await text('#ctotal'));
  await pg.click('#cclear'); await pg.waitForTimeout(300); await pg.check('#cf [name=follow_up]'); await pg.waitForTimeout(300);
  check((await pg.evaluate(() => [...document.querySelectorAll('#cl tr.click b')].map((x) => x.textContent))).includes('Northside Dental'), 'needs follow-up finds the business with a follow-up');
  await pg.screenshot({ path: out + '/hq-companies.png', fullPage: true });
  await pg.click('#cclear'); await pg.waitForTimeout(300);
  const [dl3] = await Promise.all([pg.waitForEvent('download'), pg.click('#ccsv')]);
  const ccsv = fs.readFileSync(await dl3.path(), 'utf8').split('\r\n'); console.log('companies CSV:', dl3.suggestedFilename(), '|', ccsv.length - 1, 'rows |', ccsv[0].replace(/^﻿/, '').slice(0, 120));
  check(ccsv.length - 1 === 125, 'CSV export of the whole filtered list (every page)');
  await tab('history'); await pg.waitForSelector('#hl table'); check((await text('#hl')).includes('downloaded the businesses list') && (await text('#hl')).includes('messaged the customer'), 'the HQ history records it all');

  // --- a business can be opened from Support, Refunds, Licences and Inactive accounts
  await tab('refunds'); await pg.click('.rcard [data-goco]'); await pg.waitForSelector('.cpage'); check(/#\/company\/w\d\/money/.test(await pg.evaluate(() => location.hash)), 'from Refunds');
  await tab('inactive'); await pg.click('tr[data-co]'); await pg.waitForSelector('.cpage'); check(true, 'from Inactive accounts');
  await tab('licences'); await pg.click('tr[data-co]'); await pg.waitForSelector('.cpage'); check(true, 'from Licences');
  await pg.goto(`${BASE}/hq/?demo#/company/w2/conversations`); await pg.waitForSelector('#timeline'); check(true, 'a link straight to a tab works');

  // --- the layout: one left-hand menu everywhere; the Operations overview; Signups; System Operations; Admin
  await tab('overview'); await pg.waitForSelector('#queue');
  const nav = await pg.evaluate(() => [...document.querySelectorAll('.snav .nv:not(.nsub) .nl')].map((x) => x.textContent)); console.log('menu:', nav.join(', '));
  check(['Overview', 'Customers', 'Signups', 'Billing & Licences', 'Support', 'Team Inbox', 'Retention', 'System Operations', 'Reports', 'Admin'].every((x) => nav.includes(x)), 'the left-hand menu has every section');
  console.log('count cards:', await pg.evaluate(() => [...document.querySelectorAll('.ccard')].map((x) => x.innerText.replace(/\s+/g, ' ')).join(' | ')));
  check(/Failed payments\s*0\s*payments not connected yet/.test(await text('.ccards')), 'count cards (failed payments: not connected yet)');
  const q1 = await pg.evaluate(() => [...document.querySelectorAll('#queue tr[data-kind]')].slice(0, 4).map((r) => r.innerText.replace(/\s+/g, ' ')));
  console.log('needs attention:', q1.join(' || ')); check(q1.length >= 3 && !!(await pg.$('#queue .avatar.sq')) && !!(await pg.$('#queue details.dd')), 'Needs attention: customer, issue, owner, next action and a menu');
  await pg.click('#queue tr[data-kind=renewal] button[data-qi]:not([data-qm])'); await pg.waitForSelector('#licCard'); check(/\/programs$/.test(await pg.evaluate(() => location.hash)), 'Extend opens the Programs tab');
  await tab('overview'); await pg.waitForSelector('#syshealth');
  await pg.waitForFunction(() => [...document.querySelectorAll('#syshealth [data-gh] .pill')].every((p) => p.textContent !== '…'), null, { timeout: 20000 }).catch(() => {});
  console.log('system health:', await text('#syshealth')); check(/Backups.*(Healthy|Failed|Not set up yet|Couldn't check|Running)/.test(await text('#syshealth')), 'System health: backups and restore test from GitHub (soft)');
  await pg.click('#hoAdd'); await pg.fill('#hof [name=note]', 'Northside: confirm the POS plan tomorrow morning'); await pg.click('#hof .btn.p'); await pg.waitForSelector('#hof', { state: 'detached' }); await pg.waitForSelector('#handover');
  check((await text('#handover')).includes('Northside: confirm the POS plan'), 'Team handover: add a note');
  await tab('signups'); await pg.waitForSelector('#sutbl'); console.log('signup row:', (await text('#sutbl tr[data-su]')).slice(0, 160));
  check((await text('#sutbl')).includes('Blocking go-live') && !!(await pg.$('#sutbl .ck')), 'Signups: stages and what blocks go-live');
  await pg.click('#sutbl details.chkdd summary'); check((await text('#sutbl details[open]')).includes('not reported yet'), 'checklists say "not reported yet" rather than guessing');
  await tab('payments'); check((await text('#main')).includes('Coming with payments (phase 2)'), 'Invoices & payments: phase 2 note');
  await tab('health'); await pg.waitForSelector('#syshealth'); check(true, 'System Operations: System health');
  await tab('settings'); await pg.waitForSelector('#setf'); check(true, 'Admin: Settings');
  await pg.goto(`${BASE}/hq/?demo#/company/w3`); await pg.waitForSelector('.cpage'); console.log('header line:', await text('.cpline'));
  check((await text('.cpline')).includes('Owner: Riki') && (await text('.cpline')).includes('Next renewal') && (await text('.cpline')).includes('Next follow-up'), 'header: Owner, Next renewal, Next follow-up');
  check((await text('#cptl')).includes('Add internal note') && (await text('#cptl')).includes('Send customer reply'), 'Customer timeline with Add internal note and Send customer reply');
  check((await pg.$$('#modsCard .mod')).length === 7, 'Enabled modules cards');
  await pg.click('#cpMore'); await pg.click('[data-menu=owner]'); await pg.selectOption('#sof [name=staff]', { label: 'Help Desk' }); await pg.click('#sof .btn.p'); await pg.waitForSelector('#sof', { state: 'detached' }); await pg.waitForTimeout(300);
  check((await text('#cpOwner')) === 'Help Desk', 'set the Riyeser owner from the ⋯ menu');
  await pg.selectOption('#demoAs', { label: 'Help Desk (Support)' }); await pg.waitForSelector('#main > *'); await tab('companies'); await pg.click('[data-view=mine]'); await pg.waitForTimeout(300);
  const mine = await pg.evaluate(() => [...document.querySelectorAll('#cl tr.click b')].map((x) => x.textContent)); console.log('Help Desk\'s customers:', await text('#ctotal'));
  check(mine.includes('Northside Dental') && mine.includes('Sample Plumbing'), 'My customers');
  await pg.selectOption('#demoAs', { label: 'Riki (Owner)' }); await pg.waitForSelector('#main > *');
  await tab('support'); await pg.click('.tk'); await pg.waitForSelector('#rf'); check((await text('#rf')).includes('Reply to customer') && (await text('#rf')).includes('Add internal note'), 'tickets: Reply to customer / Add internal note');

  // --- phone width: no sideways scrolling
  const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message)); const over = {};
  for (const h of ['#/overview', '#/companies', '#/reports', '#/signups', '#/health', '#/company/w1', '#/company/w1/programs', '#/company/w1/pcs', '#/company/w1/people', '#/company/w1/conversations', '#/company/w2/money']) {
    await ph.goto(`${BASE}/hq/?demo${h}`); await ph.waitForSelector('#main > *:not(.muted)'); await ph.waitForTimeout(400); over[h] = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth); }
  await ph.goto(`${BASE}/hq/?demo#/company/w3/programs`); await ph.waitForSelector('#licCard'); await ph.screenshot({ path: out + '/hq-customer-phone.png', fullPage: true });
  console.log('phone overflow:', JSON.stringify(over)); check(Object.values(over).every((x) => x <= 0), 'phone width: no sideways scroll');

  console.log('errors:', errs); check(!errs.length, 'no page errors');
  await b.close();
  console.log(bad.length ? `\n${bad.length} FAILED` : '\nALL HQ CUSTOMER PAGE TESTS PASSED'); process.exit(bad.length ? 1 : 0);
})();
