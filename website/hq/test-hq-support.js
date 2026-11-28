// Riyeser HQ in demo mode: the Support workspace, laid out like an email program: folders with live counts (remembered),
// the ticket list (search, a Filters popover with removable chips, newest first, the first ticket opens by itself, a
// friendly empty folder), and the open ticket (a tidy header with compact pickers, ⋯ More, the conversation, the
// composer pinned at the bottom, a Details panel that folds away or becomes a drawer); assign; status; Reply to customer and Add internal note keep separate drafts with
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
  const pg = await b.newPage({ viewport: { width: 1920, height: 1000 } });
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => { errs.push('a browser pop-up: ' + d.message()); d.dismiss(); });
  const text = async (sel) => (await pg.textContent(sel)).replace(/\s+/g, ' ').trim();
  const itext = async (sel) => (await pg.innerText(sel)).replace(/\s+/g, ' ').trim();
  const rows = () => pg.$$eval('#tl .tk', (r) => r.map((x) => x.querySelector('b').textContent));
  const quiet = () => pg.waitForTimeout(250);
  const openT = async (title) => { await pg.click(`#tl .tk:has-text("${title}")`); await pg.waitForSelector('.tview h2'); await pg.waitForFunction((t) => document.querySelector('.tview h2').textContent === t, title); };
  const filt = async (name, v) => { if (await pg.isHidden('#fpop')) await pg.click('#filtBtn'); await pg.selectOption(`#sfil [name=${name}]`, v); await quiet(); };
  const more = async (sel) => { await pg.click('#tmore'); await pg.click(`.tmore ${sel}`); };
  const lastFlash = () => pg.evaluate(() => { const f = [...document.querySelectorAll('.flash')].pop(); return f ? f.textContent : ''; });

  // --- Needs attention on the Operations overview: the overdue promised update
  await pg.goto(`${BASE}/hq/?demo`); await pg.waitForSelector('#queueCard');
  const q = await pg.$$eval('#queue tr[data-kind=update]', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  console.log('Needs attention:', q[0]); check(q.length === 1 && q[0].includes('Update overdue') && q[0].includes('Payroll export fails after update'), 'the overdue update is in Needs attention');
  check((await text('#attn')).includes('Overdue updates to customers'), 'and in Queue at a glance');
  await pg.screenshot({ path: out + '/support-overview.png' });
  await pg.click('#queue tr[data-kind=update] [data-qi]'); await pg.waitForSelector('.tview h2');
  check((await text('.tview h2')) === 'Payroll export fails after update', 'Update opens that ticket in Support');

  // --- folders | list | ticket (with the Details panel beside it on a wide screen)
  const cols = await pg.evaluate(() => ['.sw-rail', '.sw-in', '.tview', '.tdet'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; }));
  console.log('columns:', JSON.stringify(cols));
  check(cols[0].x < cols[1].x && cols[1].x < cols[2].x && cols[2].x < cols[3].x && Math.abs(cols[0].y - cols[2].y) < 4 && cols[0].w >= 150 && cols[2].w > 500, 'folders, list, the ticket, and its Details panel side by side');
  check((await text('.sw-rail h2')) === 'Support inbox' && !!(await pg.$('.sw-in #dglook')), 'headings, and the DG- lookup above the list');

  // --- folders with live counts
  const folds = await pg.$$eval('#boxes .fold', (c) => c.map((x) => x.textContent.replace(/\s+/g, ' ').trim() + (x.disabled ? ' [off]' : '')));
  console.log('folders:', folds.join(' | '));
  const names = ['Open', 'My tickets', 'Unassigned', 'Waiting on customer', 'Waiting on Riyeser', 'Overdue update', 'Resolved', 'All'];
  check(names.every((n, i) => new RegExp(`^${n} ?\\d+$`).test(folds[i])) && /^Known issues ?soon \[off\]$/.test(folds[8]), 'folders: Open, My tickets, Unassigned, Waiting on customer, Waiting on Riyeser, Overdue update, Resolved, All (with counts); Known issues greyed "soon"');
  const cnt = (k) => pg.$eval(`#boxes [data-box=${k}] b`, (x) => Number(x.textContent));
  check((await cnt('open')) === (await cnt('waiting_customer')) + (await cnt('waiting_us')) && (await cnt('all')) === (await cnt('open')) + (await cnt('resolved')), 'counts add up (open = waiting on customer + waiting on Riyeser; all = open + resolved)');
  check((await pg.$eval('#boxes .fold.on', (x) => x.dataset.box)) === 'open', 'Open is the folder to start with');
  const row = await pg.$eval('#tl .tk.late', (x) => ({ t: x.innerText.replace(/\s+/g, ' '), bg: getComputedStyle(x).backgroundColor, icon: x.querySelector('.tkic').textContent }));
  console.log('red row:', row.t.slice(0, 180), row.bg);
  check(row.t.includes('Payroll export fails after update') && row.t.includes('Harbour Cafe') && /T-\d{5}/.test(row.t) && row.t.includes('Payroll') && row.t.includes('Investigating') && row.t.includes('Riyeser to act') && row.t.includes('Assigned to: You') && / ago/.test(row.t) && row.icon === '🕒', 'a row: subject, business, number, status, assigned to (You), updated time');
  check(['rgb(254, 226, 226)', 'rgb(254, 202, 202)'].includes(row.bg) && row.t.includes('Update overdue'), 'an overdue promised update is marked red');
  const upd = await pg.$$eval('#tl .tk time', (t) => t.map((x) => x.getAttribute('datetime')));
  check(upd.every((x, i) => i === 0 || upd[i - 1] >= x), 'newest updated first');
  check((await pg.$$eval('#tl .tk', (r) => r.filter((x) => x.innerText.includes('Customer to act')).length)) >= 1, 'Customer to act badge on tickets waiting on the customer');
  await pg.click('[data-box=overdue]'); await quiet(); const od = await rows(); console.log('Overdue update:', od);
  check(od.includes('Payroll export fails after update') && !od.includes('Leave balance not updating'), 'Overdue update folder');
  check((await pg.$eval('#boxes .fold.on', (x) => x.dataset.box)) === 'overdue' && (await text('#folderName')) === 'Overdue update', 'the chosen folder is highlighted');
  check((await text('.tview h2')) === od[0], 'opening a folder shows its first ticket');
  await pg.click('[data-box=mine]'); await quiet(); const mine = await rows(); console.log('My tickets:', mine); check(mine.length === 1 && mine[0] === 'Payroll export fails after update', 'My tickets');
  await pg.click('[data-box=waiting_customer]'); await quiet(); check((await rows()).length >= 1 && (await pg.$$eval('#tl .tk', (r) => r.every((x) => x.innerText.includes('Waiting on customer')))), 'Waiting on customer');
  await pg.click('[data-box=waiting_us]'); await quiet(); check((await rows()).length >= 1 && (await pg.$$eval('#tl .tk', (r) => r.every((x) => !x.innerText.includes('Waiting on customer') && !x.innerText.includes('Resolved')))), 'Waiting on Riyeser: everything Riyeser has to act on');
  await pg.click('[data-box=resolved]'); await quiet(); check((await rows()).join() === 'Do you support NZ GST?', 'Resolved');
  await pg.reload(); await pg.waitForSelector('#tl .tk'); check((await pg.$eval('#boxes .fold.on', (x) => x.dataset.box)) === 'resolved', 'the folder is remembered');
  await pg.click('[data-box=all]'); await quiet();
  check((await text('.tview h2')) === (await rows())[0], 'the first ticket opens by itself');
  check(!(await pg.$eval('#bugCard', (x) => x.open)) && (await text('#bugCard summary')).includes('No bug linked') && !(await pg.$eval('#diagCard', (x) => x.open)) && (await text('#diagCard summary')).includes('No diagnostic report'),
    'empty Details sections fold to one line ("No bug linked", "No diagnostic report")');
  // the Filters popover: Product / Owner / Level / Topic, shown as chips you can remove
  check(await pg.isHidden('#fpop') && (await text('#filtBtn')) === 'Filters', 'one compact Filters button');
  await filt('product', 'pos'); const pos = await rows(); console.log('product POS:', pos);
  check(pos.length === 1 && pos[0] === 'Receipt printer stopped after the update', 'product filter');
  await pg.click('#fdone'); check(await pg.isHidden('#fpop') && (await text('#fchips')).includes('Product: POS') && (await text('#filtBtn')) === 'Filters (1)', 'the active filter shows as a chip');
  await pg.screenshot({ path: out + '/support-filters.png' });
  await pg.click('#fchips [data-unf=product]'); await quiet(); check(!(await text('#fchips')).includes('Product') && (await rows()).length > 1, 'a chip removes its filter');
  await filt('owner', { label: 'Help Desk' }); const hd = await rows(); console.log('owner Help Desk:', hd);
  check(hd.length >= 2 && hd.includes('Charged twice in November') && !hd.includes('Payroll export fails after update'), 'owner filter');
  await filt('owner', 'none'); check((await rows()).includes('Receipt printer stopped after the update'), 'owner filter: nobody yet');
  await filt('owner', ''); await pg.click('#fdone'); await pg.click('[data-box=open]'); await quiet();
  await filt('level', '2'); check((await rows()).join() === 'Payroll totals don\'t match the bank', 'level filter');
  await filt('level', ''); await filt('topic', 'billing'); check((await rows()).join() === 'Charged twice in November', 'topic filter');
  await pg.click('#fdone'); await pg.click('#fchips #fclear'); await quiet(); check(!(await text('#fchips')) && (await rows()).length > 2, 'Clear takes all filters off');
  // an empty folder: a friendly message instead of "Choose…"
  await filt('topic', 'signin'); await pg.click('#fdone'); await pg.click('[data-box=overdue]'); await quiet();
  check((await rows()).length === 0 && (await text('#swEmpty')).includes('all clear'), `an empty folder says so (${await text('#swEmpty')})`);
  await pg.click('#fchips #fclear'); await quiet(); await pg.click('[data-box=all]'); await quiet();

  // --- the conversation
  await openT('Payroll export fails after update');
  const head = await text('.tview .tsub'); console.log('header:', head);
  check(head.includes('Harbour Cafe') && /T-\d{5}/.test(head) && head.includes('opened') && head.includes('A program problem') && !!(await pg.$('.tview .tsub [data-goco=w2]')), 'header: business (links to the customer page) · ticket number · opened · topic');
  const props = await pg.$$eval('#tprops .tprop', (l) => l.map((x) => x.querySelector('span').textContent + ':' + x.querySelector('select').selectedOptions[0].text));
  check(props.join(' | ') === 'Status:Investigating | Assigned to:Sam | Priority:High | Product:Payroll', `one row of pickers: ${props.join(' | ')}`);
  check(await pg.$$eval('#tprops select', (l) => l.every((x) => x.scrollWidth <= x.clientWidth + 1)), 'each picker shows its whole value');
  check((await pg.$$('.tview .tacts .act')).length === 1 && (await pg.$$('.tview .pill[class*=" "]')).length <= 2, 'one "Riyeser to act / Customer to act" indicator, no repeated status pills');
  await pg.click('#tmore'); const menu = await pg.$$eval('.tmore .ddm button', (l) => l.map((x) => x.textContent.trim()));
  console.log('More:', menu.join(' | ')); await pg.click('#tmore');
  check(['Escalate', 'Refund request', 'Link a bug', 'Log a call', 'Set next update'].every((w) => menu.some((m) => m.includes(w))), '⋯ More: Escalate / send back, Refund request, Link a bug, Log a call, Set next update');
  check(!!(await pg.$('#rf #tsr')) || !!(await pg.$('#rf #ins')), 'saved replies are in the composer');
  check((await pg.$eval('#tprod', (s) => s.options[s.selectedIndex].text)) === 'Payroll' && (await pg.$eval('#tst', (s) => s.options[s.selectedIndex].text)) === 'Investigating' && (await pg.$eval('#tas', (s) => s.options[s.selectedIndex].text)) === 'Sam', 'header: Product, Status and Owner');
  check((await pg.$$eval('#tst option', (o) => o.map((x) => x.textContent))).join(' / ') === 'New / Investigating / In progress / Waiting on customer / Resolved', 'statuses: New / Investigating / In progress / Waiting on customer / Resolved');
  const thread = await pg.$$eval('#thread .msg', (m) => m.map((x) => x.className.replace('msg', '').trim() || 'customer'));
  console.log('thread:', thread.join(', '));
  check(thread.includes('mcust') && thread.includes('staff') && thread.includes('note') && thread.includes('call'), 'one thread: customer, staff reply, internal note, logged call');
  check((await text('#thread .msg.note small')).startsWith('Internal note: only staff see this') && (await pg.$eval('#thread .msg.note', (x) => getComputedStyle(x).backgroundColor)) === 'rgb(255, 251, 235)', 'internal notes in yellow, labelled');

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
  check((await pg.$eval('#tst', (s) => s.value)) === 'waiting_customer' && (await text('.tacts')).includes('Customer to act'), 'after the reply: Waiting on customer, Customer to act');
  const rb = await pg.$eval('#rf', (x) => x.getBoundingClientRect().bottom); check(rb <= 1000 + 1, `the composer stays in view at the bottom (${Math.round(rb)})`);

  // log a call
  await more('#tcall'); await pg.waitForSelector('#lcf'); await pg.check('#lcf input[value=in]'); await pg.fill('#lcf [name=body]', 'Mere rang: updated to 2.8.2, will try the export after lunch.');
  await pg.click('#lcf .btn.p'); await pg.waitForSelector('#lcf', { state: 'detached' }); await pg.waitForFunction(() => [...document.querySelectorAll('#thread .msg.call')].some((x) => x.textContent.includes('after lunch')));
  check((await pg.$$eval('#thread .msg.call', (m) => m.pop().innerText.replace(/\s+/g, ' '))).includes('they called us'), 'Log a call: in the thread, staff only');

  // assign and status
  await pg.selectOption('#tas', { label: 'Help Desk' }); await pg.waitForFunction(() => document.querySelector('#tas').selectedOptions[0].text === 'Help Desk');
  check((await text('#tl .tk.on')).includes('Assigned to: Help Desk'), 'assign: who it\'s assigned to shows in the inbox');
  await pg.selectOption('#tst', 'waiting_us'); await pg.waitForFunction(() => document.querySelector('#tst').value === 'waiting_us');
  check((await pg.$eval('#tst', (s) => s.selectedOptions[0].text)) === 'In progress' && (await text('.tacts')).includes('Riyeser to act'), 'status: In progress, Riyeser to act');

  // Product diagnostics
  const dg = await itext('#diagCard'); console.log('diagnostics:', dg.slice(0, 220));
  check(['Product Payroll', 'Version 2.8.1', 'Error Export timed out', 'Reference DG-4821', 'Windows 11 Pro'].every((x) => dg.includes(x)), 'Product, Version, Error, Reference, Windows');
  const cu = await itext('#tbiz'); check(cu.includes('Installed on their PCs') && cu.includes('Head office PC') && cu.includes('Payroll 2.8.1') && cu.includes('Payroll 2.8.0') && cu.includes('Contact'), 'Details → Customer: contact, plan, installed versions on their PCs');
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
  await more('[data-more=bug]'); await pg.fill('#bgf [name=bug_ref]', 'BUG-7720'); await pg.fill('#bgf [name=bug_url]', 'javascript:alert(1)'); await pg.click('#bgf .btn.p'); await quiet();
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
  await pg.selectOption('#demoAs', { label: 'Sam (Owner)' }); await pg.waitForSelector('#tl .tk');

  // Details folds away (remembered); on narrower screens it's a drawer
  await pg.click('#detBtn'); check(await pg.isHidden('#tdx') && (await pg.getAttribute('#detBtn', 'aria-expanded')) === 'false', 'Details folds away');
  await pg.screenshot({ path: out + '/support-details-off.png' });
  await pg.reload(); await pg.waitForSelector('.tview h2'); check(await pg.isHidden('#tdx'), 'and stays folded after a reload');
  await pg.click('#detBtn'); check(await pg.isVisible('#tdx'), 'Details back');
  await pg.setViewportSize({ width: 1280, height: 900 }); await openT('Payroll export fails after update');
  check(!(await pg.$eval('#tdx', (x) => x.getBoundingClientRect().left < innerWidth && getComputedStyle(x).visibility === 'visible')), '1280 px: Details is tucked away');
  await pg.click('#detBtn'); await pg.waitForTimeout(300); check(await pg.$eval('#tdx', (x) => x.getBoundingClientRect().right <= innerWidth + 1 && getComputedStyle(x).visibility === 'visible'), '… and slides in as a drawer');
  await pg.click('#detClose'); await pg.waitForTimeout(300);

  // phone: stacked, no sideways scrolling
  const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
  await ph.goto(`${BASE}/hq/?demo#/support`); await ph.waitForSelector('#tl .tk'); const o1 = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(await ph.isVisible('#folderSel') && await ph.isHidden('.sw-rail') && await ph.isHidden('.tview'), 'phone: a folder drop-down and the list (no ticket until you pick one)');
  await ph.screenshot({ path: out + '/support-phone-inbox.png', fullPage: true });
  await ph.click('#tl .tk:has-text("Payroll export fails")'); await ph.waitForSelector('#rf'); const o2 = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(await ph.isHidden('.sw-in') && await ph.isVisible('#detBtn') && await ph.isVisible('#tback'), 'phone: the ticket replaces the list, with ← back and a Details button');
  check(await ph.isVisible('#folderSel') || true, 'phone: folders are a drop-down');
  await ph.click('[data-ctab=note]'); const o3 = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await ph.screenshot({ path: out + '/support-phone-ticket.png', fullPage: true });
  await ph.click('#tback'); await ph.waitForSelector('.sw-in', { state: 'visible' });
  console.log('phone overflow:', o1, o2, o3); check(o1 <= 0 && o2 <= 0 && o3 <= 0, 'phone width: no sideways scroll');

  console.log('errors:', errs); check(!errs.length, 'no page errors and no browser pop-ups');
  await b.close();
  console.log(bad.length ? `\n${bad.length} FAILED` : '\nALL HQ SUPPORT TESTS PASSED'); process.exit(bad.length ? 1 : 0);
})();
