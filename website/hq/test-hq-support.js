// Riyeser HQ in demo mode: the Support workspace. Three columns (inbox, conversation, Product diagnostics); quick tabs
// and filters (product, owner, overdue); assign; status; Reply to customer and Add internal note keep separate drafts with
// the audience shown; saved replies; Log a call; Next update (overdue shows red, and in Needs attention); planned release;
// linked bug; diagnostics and the DG- lookup; customer support notes (pinned); no diagnostics without the permission;
// phone width with no sideways scrolling.
// Run: build the site, serve website/public on port 8090, then `node website/hq/test-hq-support.js <screenshot folder>`.
// (HQ_URL=http://127.0.0.1:8091 uses another port.)
const { chromium, devices } = require('playwright');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
(async () => {
  const b = await chromium.launch(); const errs = []; const bad = []; const out = process.argv[2] || '.';
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad.push(what); };
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => { errs.push('a browser pop-up: ' + d.message()); d.dismiss(); });
  const text = async (sel) => (await pg.textContent(sel)).replace(/\s+/g, ' ').trim();
  const itext = async (sel) => (await pg.innerText(sel)).replace(/\s+/g, ' ').trim();
  const rows = () => pg.$$eval('#tl .tk', (r) => r.map((x) => x.querySelector('b').textContent));
  const quiet = () => pg.waitForTimeout(250);
  const openT = async (title) => { await pg.click(`#tl .tk:has-text("${title}")`); await pg.waitForSelector('.tview h2'); await pg.waitForFunction((t) => document.querySelector('.tview h2').textContent === t, title); };
  const lastFlash = () => pg.evaluate(() => { const f = [...document.querySelectorAll('.flash')].pop(); return f ? f.textContent : ''; });

  // --- Needs attention on the Operations overview: the overdue promised update
  await pg.goto(`${BASE}/hq/?demo`); await pg.waitForSelector('#queueCard');
  const q = await pg.$$eval('#queue tr[data-kind=update]', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  console.log('Needs attention:', q[0]); check(q.length === 1 && q[0].includes('Update overdue') && q[0].includes('Payroll export fails after update'), 'the overdue update is in Needs attention');
  check((await text('#attn')).includes('Overdue updates to customers'), 'and in Queue at a glance');
  await pg.screenshot({ path: out + '/support-overview.png' });
  await pg.click('#queue tr[data-kind=update] [data-qi]'); await pg.waitForSelector('.tview h2');
  check((await text('.tview h2')) === 'Payroll export fails after update', 'Update opens that ticket in Support');

  // --- three columns, as in the mock-up
  const cols = await pg.evaluate(() => ['.sw-in', '.sw-conv', '.sw-diag'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; }));
  console.log('columns:', JSON.stringify(cols));
  check(cols[0].x < cols[1].x && cols[1].x < cols[2].x && Math.abs(cols[0].y - cols[2].y) < 4 && cols.every((c) => c.w > 240), 'three columns: inbox, conversation, Product diagnostics');
  check((await text('.sw-in h2')) === 'Support inbox' && (await text('.sw-diag h3')).includes('Product diagnostics'), 'headings');

  // --- quick tabs and rows
  const tabs = await pg.$$eval('#boxes .chip', (c) => c.map((x) => x.textContent.replace(/\s+/g, ' ').trim() + (x.disabled ? ' [off]' : '')));
  console.log('quick tabs:', tabs.join(' | '));
  check(/^My tickets \(\d+\)$/.test(tabs[0]) && /^Waiting \(\d+\)$/.test(tabs[1]) && tabs[2] === 'Unassigned' && tabs[3].startsWith('Overdue update') && tabs[4] === 'All' && tabs[5] === 'Known issues (soon) [off]', 'My tickets (n), Waiting (n), Unassigned, Overdue update, All, Known issues (soon) switched off');
  const row = await pg.$eval('#tl .tk.late', (x) => ({ t: x.innerText.replace(/\s+/g, ' '), bg: getComputedStyle(x).backgroundColor, icon: x.querySelector('.tkic').textContent }));
  console.log('red row:', row.t.slice(0, 160), row.bg);
  check(row.t.includes('Payroll export fails after update') && row.t.includes('Harbour Cafe') && /T-\d{5}/.test(row.t) && row.t.includes('Payroll') && row.t.includes('Investigating') && row.t.includes('Riyeser to act') && row.icon === '🕒', 'a row: product icon, title, business, number, product, status, Riyeser to act');
  check(['rgb(254, 226, 226)', 'rgb(254, 202, 202)'].includes(row.bg) && row.t.includes('Update overdue'), 'the overdue update row is red');
  check((await pg.$$eval('#tl .tk', (r) => r.filter((x) => x.innerText.includes('Customer to act')).length)) >= 1, 'Customer to act badge on tickets waiting on the customer');
  await pg.click('[data-box=overdue]'); await quiet(); const od = await rows(); console.log('Overdue update:', od);
  check(od.includes('Payroll export fails after update') && !od.includes('Leave balance not updating'), 'Overdue update tab');
  await pg.click('[data-box=mine]'); await quiet(); const mine = await rows(); console.log('My tickets:', mine); check(mine.length === 1 && mine[0] === 'Payroll export fails after update', 'My tickets');
  await pg.click('[data-box=waiting_customer]'); await quiet(); check((await rows()).every(Boolean) && (await pg.$$eval('#tl .tk', (r) => r.every((x) => x.innerText.includes('Waiting on customer')))), 'Waiting: tickets waiting on the customer');
  await pg.click('[data-box=all]'); await quiet();
  await pg.selectOption('#sfil [name=product]', 'pos'); await quiet(); const pos = await rows(); console.log('product POS:', pos);
  check(pos.length === 1 && pos[0] === 'Receipt printer stopped after the update', 'product filter');
  await pg.selectOption('#sfil [name=product]', ''); await pg.selectOption('#sfil [name=owner]', { label: 'Help Desk' }); await quiet(); const hd = await rows(); console.log('owner Help Desk:', hd);
  check(hd.length >= 2 && hd.includes('Charged twice in November') && !hd.includes('Payroll export fails after update'), 'owner filter');
  await pg.selectOption('#sfil [name=owner]', 'none'); await quiet(); check((await rows()).includes('Receipt printer stopped after the update'), 'owner filter: nobody yet');
  await pg.selectOption('#sfil [name=owner]', ''); await pg.selectOption('#sfil [name=status]', 'done'); await quiet(); check((await rows()).join() === 'Do you support NZ GST?', 'status filter: resolved');
  await pg.selectOption('#sfil [name=status]', 'open'); await pg.selectOption('#sfil [name=level]', '2'); await quiet(); check((await rows()).join() === 'Payroll totals don\'t match the bank', 'level filter');
  await pg.selectOption('#sfil [name=level]', ''); await pg.selectOption('#sfil [name=topic]', 'billing'); await quiet(); check((await rows()).join() === 'Charged twice in November', 'topic filter');
  await pg.selectOption('#sfil [name=topic]', ''); await quiet();

  // --- the conversation
  await openT('Payroll export fails after update');
  const head = await text('.tview .tsub'); console.log('header:', head);
  check(head.includes('Harbour Cafe') && /Ticket T-\d{5}/.test(head) && !!(await pg.$('.tview .tsub [data-goco=w2]')), 'header: title, business (links to the customer page), ticket number');
  check((await pg.$eval('#tprod', (s) => s.options[s.selectedIndex].text)) === 'Payroll' && (await pg.$eval('#tst', (s) => s.options[s.selectedIndex].text)) === 'Investigating' && (await pg.$eval('#tas', (s) => s.options[s.selectedIndex].text)) === 'Riki', 'header: Product, Status and Owner');
  check((await pg.$$eval('#tst option', (o) => o.map((x) => x.textContent))).join(' / ') === 'New / Investigating / In progress / Waiting on customer / Resolved', 'statuses: New / Investigating / In progress / Waiting on customer / Resolved');
  const thread = await pg.$$eval('#thread .msg', (m) => m.map((x) => x.className.replace('msg', '').trim() || 'customer'));
  console.log('thread:', thread.join(', '));
  check(thread.includes('mcust') && thread.includes('staff') && thread.includes('note') && thread.includes('call'), 'one thread: customer, staff reply, internal note, logged call');
  check((await text('#thread .msg.note small')).startsWith('Internal note · only Riyeser staff see this') && (await pg.$eval('#thread .msg.note', (x) => getComputedStyle(x).backgroundColor)) === 'rgb(255, 251, 235)', 'internal notes in yellow, labelled');

  // drafts: Reply to customer and Add internal note each keep their own
  const aud = () => text('#aud'); const btn = () => pg.$eval('#rf .btn.p', (x) => x.textContent.trim());
  check((await aud()) === '✉️ The customer will see this and get an email.' && (await btn()) === 'Send reply', 'Reply to customer: audience line and Send reply');
  await pg.fill('#rf textarea[name=reply]', 'Hi Mere, the fix is in Payroll 2.8.2.');
  await pg.click('[data-ctab=note]');
  check((await aud()) === '🔒 Only Riyeser staff see internal notes. The customer never does.' && (await btn()) === 'Save internal note', 'Add internal note: audience line and Save internal note');
  check((await pg.inputValue('#rf textarea[name=note]')) === '' && await pg.isHidden('#rf textarea[name=reply]'), 'the note starts empty (the reply isn\'t copied over)');
  await pg.fill('#rf textarea[name=note]', 'Dev says 2.8.2 goes out Friday.');
  await pg.click('[data-ctab=reply]'); check((await pg.inputValue('#rf textarea[name=reply]')) === 'Hi Mere, the fix is in Payroll 2.8.2.', 'the reply draft is kept');
  await pg.click('[data-ctab=note]'); check((await pg.inputValue('#rf textarea[name=note]')) === 'Dev says 2.8.2 goes out Friday.', 'the note draft is kept');
  await openT('Leave balance not updating'); await openT('Payroll export fails after update');
  check((await pg.inputValue('#rf textarea[name=note]')) === 'Dev says 2.8.2 goes out Friday.' && (await pg.inputValue('#rf textarea[name=reply]')) === 'Hi Mere, the fix is in Payroll 2.8.2.', 'drafts survive opening another ticket');
  await pg.screenshot({ path: out + '/support-note-draft.png' });
  await pg.click('#rf .btn.p'); await pg.waitForFunction(() => [...document.querySelectorAll('#thread .msg.note')].some((x) => x.textContent.includes('Dev says 2.8.2')));
  console.log('saved note:', await lastFlash());
  check((await pg.inputValue('#rf textarea[name=reply]')) === 'Hi Mere, the fix is in Payroll 2.8.2.', 'saving the note leaves the reply draft alone');
  check(!(await pg.evaluate(() => document.querySelector('#thread').innerText)).includes('Hi Mere, the fix is in'), 'the reply wasn\'t sent with the note');
  await pg.click('[data-ctab=reply]');
  await pg.selectOption('#ins', { label: 'Printer: turn it off and on' }); check((await pg.inputValue('#rf textarea[name=reply]')).includes('Please turn the printer off and on again'), 'a saved reply is inserted');
  await pg.fill('#rf textarea[name=reply]', 'Hi Mere, the fix is in Payroll 2.8.2. Please update and try the export again.');
  await pg.click('#rf .btn.p'); await pg.waitForFunction(() => [...document.querySelectorAll('#thread .msg.staff')].some((x) => x.textContent.includes('Please update and try')));
  console.log('sent:', await lastFlash()); check((await pg.inputValue('#rf textarea[name=reply]')) === '', 'the reply draft clears once sent');
  check((await pg.$eval('#tst', (s) => s.value)) === 'waiting_customer' && (await text('.tpills')).includes('Customer to act'), 'after the reply: Waiting on customer, Customer to act');

  // log a call
  await pg.click('#tcall'); await pg.waitForSelector('#lcf'); await pg.check('#lcf input[value=in]'); await pg.fill('#lcf [name=body]', 'Mere rang: updated to 2.8.2, will try the export after lunch.');
  await pg.click('#lcf .btn.p'); await pg.waitForSelector('#lcf', { state: 'detached' }); await pg.waitForFunction(() => [...document.querySelectorAll('#thread .msg.call')].some((x) => x.textContent.includes('after lunch')));
  check((await pg.$$eval('#thread .msg.call', (m) => m.pop().innerText.replace(/\s+/g, ' '))).includes('they called us'), 'Log a call: in the thread, staff only');

  // assign and status
  await pg.selectOption('#tas', { label: 'Help Desk' }); await pg.waitForFunction(() => document.querySelector('#tas').selectedOptions[0].text === 'Help Desk');
  check((await text('#tl .tk.on')).includes('Owner: Help Desk'), 'assign: the owner shows in the inbox');
  await pg.selectOption('#tst', 'waiting_us'); await pg.waitForFunction(() => document.querySelector('#tst').value === 'waiting_us');
  check((await text('.tpills')).includes('In progress') && (await text('.tpills')).includes('Riyeser to act'), 'status: In progress, Riyeser to act');

  // Product diagnostics
  const dg = await itext('#diagCard'); console.log('diagnostics:', dg.slice(0, 220));
  check(['Product Payroll', 'Version 2.8.1', 'Error Export timed out', 'Reference DG-4821', 'Windows 11 Pro'].every((x) => dg.includes(x)), 'Product, Version, Error, Reference, Windows');
  check(dg.includes('Installed on their PCs') && dg.includes('Head office PC') && dg.includes('Payroll 2.8.1') && dg.includes('Payroll 2.8.0'), 'installed versions on the business\'s PCs');
  await pg.click('#diagCard .dlog summary'); check((await text('#diagCard .dlog pre')).includes('ERROR export: Export timed out') && (await text('#diagCard .dlog pre')).includes('m***@harbour.test'), 'log lines open, already scrubbed');

  // Next update: overdue (red) -> set by a time and an owner -> not red
  check((await pg.$eval('#nuCard', (x) => x.classList.contains('late'))) && (await text('#nuCard')).includes('Overdue: next update to customer was due'), 'Next update: overdue shows red');
  await pg.click('#nuEdit'); await pg.waitForSelector('#nuf');
  const due = await pg.evaluate(() => { const d = new Date(Date.now() + 3 * 864e5); d.setHours(15, 0, 0, 0); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T15:00`; });
  await pg.fill('#nuf [name=due]', due); await pg.selectOption('#nuf [name=owner]', { label: 'Help Desk' }); await pg.click('#nuf .btn.p'); await pg.waitForSelector('#nuf', { state: 'detached' }); await quiet();
  const nu = await text('#nuCard .nuline'); console.log('next update:', nu);
  check(/^Next update to customer: by 3:00 pm \w{3}( \d+ \w{3})? \(Help Desk\)$/.test(nu) && !(await pg.$eval('#nuCard', (x) => x.classList.contains('late'))), 'Next update: "by 3:00 pm <day> (Help Desk)"');
  check(!(await pg.$eval('#tl .tk.on', (x) => x.classList.contains('late'))) && (await text('#tl .tk.on')).includes('Update due 3:00 pm'), 'the row isn\'t red any more and shows when it\'s due');
  await pg.fill('#prf [name=planned_release]', 'Payroll 2.8.3'); await pg.click('#prf .btn'); await quiet(); check((await pg.inputValue('#prf [name=planned_release]')) === 'Payroll 2.8.3', 'Planned release is its own field');
  await pg.click('#bugEdit'); await pg.fill('#bgf [name=bug_ref]', 'BUG-7720'); await pg.fill('#bgf [name=bug_url]', 'javascript:alert(1)'); await pg.click('#bgf .btn.p'); await quiet();
  check((await text('#bgf .derr')).includes('https://'), 'Linked bug: only https links'); await pg.fill('#bgf [name=bug_url]', 'https://github.com/raka1987/Riyeser/issues/1'); await pg.click('#bgf .btn.p'); await pg.waitForSelector('#bgf', { state: 'detached' }); await quiet();
  check((await text('#bugCard')).includes('BUG-7720') && (await pg.getAttribute('#bugCard a', 'href')) === 'https://github.com/raka1987/Riyeser/issues/1' && (await pg.getAttribute('#bugCard a', 'rel')).includes('noopener'), 'Linked bug: reference and link');

  // customer support notes: pinned notes on every ticket for the business
  check((await text('#snCard')).includes('Call Mere on the cafe landline'), 'pinned note shows');
  await pg.click('#snAdd'); await pg.fill('#snf [name=body]', 'Back office PC is the one with payroll.'); await pg.click('#snf .btn.p'); await pg.waitForSelector('#snf', { state: 'detached' }); await quiet();
  await pg.click('[data-snedit="3"]'); await pg.fill('#snf [name=body]', 'Call Mere on the cafe landline before 10 am. Payroll runs on Thursdays.'); await pg.click('#snf .btn.p'); await pg.waitForSelector('#snf', { state: 'detached' }); await quiet();
  const sn = await text('#snCard'); console.log('support notes:', sn.slice(0, 200));
  check(sn.includes('Back office PC is the one with payroll.') && sn.includes('Payroll runs on Thursdays.') && !sn.includes('Ask for the PC name'), 'add and edit support notes');
  await pg.click('#tl .tk:has-text("Charged twice in November")'); await pg.waitForFunction(() => document.querySelector('.tview h2').textContent === 'Charged twice in November');
  check((await text('#snCard')).includes('Back office PC is the one with payroll.'), 'the same notes on the business\'s other tickets');
  await pg.screenshot({ path: out + '/support-desktop.png' });

  // DG lookup, and no diagnostics without support.diagnostics
  await pg.click('#dglook'); await pg.fill('#dgf [name=ref]', 'dg-4822'); await pg.click('#dgf .btn.p'); await pg.waitForSelector('#dgout .dgcard');
  check((await text('#dgout')).includes('POS') && (await text('#dgout')).includes('1.7.0') && (await text('#dgout')).includes('Sample Plumbing'), 'look up a DG- reference'); await pg.click('.modal [data-close]');
  await pg.selectOption('#demoAs', { label: 'Finance Fi (Finance)' }); await pg.waitForSelector('#tl .tk');
  await openT('Payroll export fails after update');
  check((await text('#diagCard')).includes('needs the support.diagnostics permission') && !(await text('#diagCard')).includes('Export timed out') && !(await pg.$('#dglook')), 'Finance: no diagnostics (permission needed)');
  await pg.selectOption('#demoAs', { label: 'Riki (Owner)' }); await pg.waitForSelector('#tl .tk');

  // narrower screens: two columns, then one
  await pg.setViewportSize({ width: 1100, height: 900 }); await openT('Payroll export fails after update');
  const two = await pg.evaluate(() => ['.sw-in', '.sw-conv', '.sw-diag'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().x)));
  check(two[0] < two[1] && two[1] === two[2], '1100 px: Product diagnostics goes under the conversation');

  // phone: stacked, no sideways scrolling
  const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
  await ph.goto(`${BASE}/hq/?demo#/support`); await ph.waitForSelector('#tl .tk'); const o1 = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await ph.screenshot({ path: out + '/support-phone-inbox.png', fullPage: true });
  await ph.click('#tl .tk:has-text("Payroll export fails")'); await ph.waitForSelector('#rf'); const o2 = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(await ph.isHidden('.sw-in') && await ph.isVisible('.sw-diag') && await ph.isVisible('#tback'), 'phone: the ticket replaces the inbox, with ← Inbox');
  await ph.click('[data-ctab=note]'); const o3 = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await ph.screenshot({ path: out + '/support-phone-ticket.png', fullPage: true });
  await ph.click('#tback'); await ph.waitForSelector('.sw-in', { state: 'visible' });
  console.log('phone overflow:', o1, o2, o3); check(o1 <= 0 && o2 <= 0 && o3 <= 0, 'phone width: no sideways scroll');

  console.log('errors:', errs); check(!errs.length, 'no page errors and no browser pop-ups');
  await b.close();
  console.log(bad.length ? `\n${bad.length} FAILED` : '\nALL HQ SUPPORT TESTS PASSED'); process.exit(bad.length ? 1 : 0);
})();
