// Riyeser POS in a real browser, the owner's 2.11.0 reports:
//   1. nothing of ours opens a new (web browser) window: receipts, reports, help, online orders, bookings, exports
//   2. Setup > Hardware has every printer option and the cash drawer
//   3. a past sale's receipt: view it on screen, print it again, email it; all inside the app
//   4. promotions apply by themselves at the till (and by code) and show on the receipt
//   5. switching Retail <-> Restaurant: the feature switches work straight away, and every menu item still clicks
//   6. tables and areas: add, rename, remove; then open a table, add items, move it and split it
// Layout at 1366x768, 1024x768 and 390 wide: no sideways scroll, no script errors.
//   python tests/browser/serve_pos_gaps.py 8321 retail &
//   python tests/browser/serve_pos_gaps.py 8322 restaurant &
//   node tests/browser/pos_gaps.e2e.js             (SHOTS=<folder> also saves the evidence screenshots)
// The other programs that share this code can be crawled for new-window links too:
//   python tests/browser/serve_demo.py 8331 plus &   APPS='{"plus":"http://127.0.0.1:8331"}' node tests/browser/pos_gaps.e2e.js
const { chromium } = require('playwright');
const R = process.env.RETAIL || 'http://127.0.0.1:8321', Q = process.env.RESTAURANT || 'http://127.0.0.1:8322';
const APPS = JSON.parse(process.env.APPS || '{}');
const SHOTS = process.env.SHOTS || '';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
const shot = async (pg, name, full) => { if (SHOTS) await pg.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: !!full }); };
const ours = u => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u);
const side = pg => pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function login(b, base, w = 1366, h = 768) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  // other websites are never loaded by the test; printing is counted, not sent to a printer
  await ctx.route(u => !ours(u.toString()) && /^https?:/.test(u.toString()), r => r.abort());
  await ctx.addInitScript(() => { window.print = () => { try { top.__printed = (top.__printed || 0) + 1; } catch (e) { /* frame */ } }; });
  const pg = await ctx.newPage(); pg.errs = []; pg.popups = [];
  pg.on('pageerror', e => pg.errs.push(e.message)); pg.on('dialog', d => d.accept());
  ctx.on('page', p => { if (p !== pg) pg.popups.push(p.url() || p.opener() && 'popup'); });
  await pg.goto(base + '/login'); await pg.fill('input[name=username]', 'admin'); await pg.fill('input[name=password]', 'admin');
  await Promise.all([pg.waitForNavigation(), pg.press('input[name=password]', 'Enter')]);
  return pg;
}
// a new window that is one of our own pages (what the app window would hand to the web browser)
const ownPopups = async pg => { await pg.waitForTimeout(150); const all = []; for (const p of pg.context().pages()) if (p !== pg) { await p.waitForLoadState('domcontentloaded').catch(() => {}); all.push(p.url()); } return all.filter(u => ours(u) || u === 'about:blank'); };
const closePopups = async pg => { for (const p of pg.context().pages()) if (p !== pg) await p.close().catch(() => {}); pg.popups.length = 0; };
// every visible element matching the selector can really be clicked: nothing is lying over it
const covered = (pg, sel) => pg.evaluate(sel => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length && e.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })).map(e => {
  e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect();
  const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return t && (e === t || e.contains(t) || t.contains(e)) ? null : (e.textContent || '').trim().slice(0, 30) + ' is under ' + (t ? t.tagName + '.' + t.className : 'nothing');
}).filter(Boolean), sel);
const openMenus = pg => pg.evaluate(() => document.querySelectorAll('details.nav-sec').forEach(d => { d.open = true; }));
const broken = async pg => /something went wrong|Nothing was saved from that last step|Internal Server Error|Not Found/i.test(await pg.title() + ' ' + (await pg.textContent('h1').catch(() => '') || ''));

// ---- click every item in the back office menu (sidebar), one at a time, starting from the same page each time
async function clickBackOfficeMenu(pg, base, label) {
  await pg.goto(base + '/pos/setup'); await openMenus(pg);
  const items = await pg.$$eval('.side a[href]', as => as.map(a => ({ href: a.getAttribute('href'), text: a.textContent.trim() })).filter(a => a.href.startsWith('/') && !/logout|\/switch/.test(a.href)));
  let bad = [];
  for (const it of items) {
    await pg.goto(base + '/pos/setup'); await openMenus(pg); pg.errs.length = 0;
    const link = pg.locator(`.side a[href="${it.href}"]`).first();
    try { await Promise.all([pg.waitForNavigation({ timeout: 8000 }), link.click({ timeout: 4000 })]); } catch (e) { bad.push(it.text + ': could not be clicked'); continue; }
    await pg.waitForLoadState('load');
    if (await broken(pg) || pg.errs.length) bad.push(`${it.text} -> ${pg.url().replace(base, '')} ${pg.errs.join(' | ')}`);
    else if (!pg.url().includes('/pos/')) { const c = await covered(pg, '.side a[href], .content .btn, .content button:not([disabled])'); if (c.length) bad.push(it.text + ': ' + c[0]); }
  }
  check(items.length >= 15 && !bad.length, `${label}: every back office menu item opens and can be clicked (${items.length} items) ${bad.join(' ; ')}`);
  check(!(await ownPopups(pg)).length, `${label}: no menu item opened a new window`); await closePopups(pg);
}
// ---- the till's own menu: the top bar, then the person menu
async function clickTillMenu(pg, base, label, mode) {
  await pg.goto(base + '/pos/'); await pg.waitForTimeout(300);
  let bad = (await covered(pg, '#tnav a, #grid .pt, #cats .cat, .cart button:not([disabled]), #till, details.um > summary')).slice(0, 3);
  const top = await pg.$$eval('#tnav a', as => as.map(a => ({ open: a.dataset.open || '', text: a.textContent.trim() })));
  for (let i = 0; i < top.length; i++) {
    await pg.goto(base + '/pos/'); await pg.waitForTimeout(200); pg.errs.length = 0;
    const a = pg.locator('#tnav a').nth(i);
    try {
      if (top[i].open) { await a.click({ timeout: 4000 }); await pg.waitForTimeout(350);
        const m = top[i].open === 'tables' ? '#mTables' : '#mOrders';
        if (!(await pg.isVisible(m + '.show'))) bad.push(top[i].text + ': nothing opened');
        else { await pg.click(m + ' [data-close]'); if (await pg.isVisible(m + '.show')) bad.push(top[i].text + ': would not close'); }
      } else { await Promise.all([pg.waitForNavigation({ timeout: 8000 }), a.click({ timeout: 4000 })]); await pg.waitForLoadState('load'); if (await broken(pg)) bad.push(top[i].text + ' broke'); }
    } catch (e) { bad.push(top[i].text + ': could not be clicked'); }
    if (pg.errs.length) bad.push(top[i].text + ': ' + pg.errs.join(' | '));
  }
  check(top.length === (mode === 'restaurant' ? 5 : 4) && !bad.length, `${label}: the till's top menu (${top.map(t => t.text).join(', ')}) all clicks ${bad.join(' ; ')}`);
  bad = [];
  await pg.goto(base + '/pos/'); await pg.click('details.um > summary');
  const menu = await pg.$$eval('details.um .dd a', as => as.map(a => ({ href: a.getAttribute('href'), text: a.textContent.trim(), inapp: a.hasAttribute('data-inapp') })).filter(a => a.href.startsWith('/') && !/logout/.test(a.href)));
  for (const it of menu) {
    await pg.goto(base + '/pos/'); await pg.waitForTimeout(150); pg.errs.length = 0; await pg.click('details.um > summary');
    const link = pg.locator(`details.um .dd a[href="${it.href}"]`).first();
    try {
      if (it.inapp) { await link.click({ timeout: 4000 }); await pg.waitForTimeout(400); if (!(await pg.isVisible('#inappViewer'))) bad.push(it.text + ': no in-app viewer'); }
      else { await Promise.all([pg.waitForNavigation({ timeout: 8000 }), link.click({ timeout: 4000 })]); await pg.waitForLoadState('load'); if (await broken(pg)) bad.push(it.text + ' broke'); }
    } catch (e) { bad.push(it.text + ': could not be clicked'); }
    if (pg.errs.length) bad.push(it.text + ': ' + pg.errs.join(' | '));
  }
  check(menu.length >= 6 && !bad.length, `${label}: the till's person menu (${menu.map(t => t.text).join(', ')}) all clicks ${bad.join(' ; ')}`);
  check(!(await ownPopups(pg)).length, `${label}: the till's menus opened no new window`); await closePopups(pg);
}
// ---- every link on a page that asks for a new window, a print or the viewer: our own pages stay in this window
async function probeLinks(pg, base, urls, label) {
  let n = 0, bad = [];
  for (const u of urls) {
    const r = await pg.goto(base + u, { waitUntil: 'load' }).catch(() => null); if (!r || r.status() >= 400) continue;
    await openMenus(pg);
    const count = await pg.evaluate(() => { let i = 0; document.querySelectorAll('a[href]').forEach(a => { const own = new URL(a.href, location.href).origin === location.origin;
      const tg = (a.getAttribute('target') || '').toLowerCase(); if (own && ((tg && !['_self', '_top', '_parent'].includes(tg)) || a.hasAttribute('data-print') || a.hasAttribute('data-inapp')) && a.checkVisibility() && !(a.getAttribute('href') || '#').startsWith('#')) a.setAttribute('data-probe', i++); }); return i; });
    for (let i = 0; i < Math.min(count, 6); i++) {
      const before = pg.url();
      await pg.evaluate(i => { const a = document.querySelector(`[data-probe="${i}"]`); a.scrollIntoView({ block: 'center' }); a.click(); }, i); n++;
      await pg.waitForTimeout(250);
      const pops = await ownPopups(pg);
      if (pops.length) bad.push(`${u}: opened ${pops[0]}`); if (pg.url().split('#')[0] !== before.split('#')[0]) bad.push(`${u}: left the page for ${pg.url()}`);
      await closePopups(pg);
      await pg.evaluate(() => { const x = document.querySelector('#inappViewer [data-iv=close]'); if (x) x.click(); });
    }
  }
  check(!bad.length, `${label}: ${n} print / view / new-window links on ${urls.length} screens all stay in the app window ${bad.slice(0, 4).join(' ; ')}`);
}

(async () => {
  const b = await chromium.launch();
  let pg;

  // ================= 6. tables and areas (a restaurant with no tables yet)
  pg = await login(b, Q);
  await pg.goto(Q + '/pos/'); await pg.click('#tnav [data-open="tables"]'); await pg.waitForTimeout(300);
  check((await pg.textContent('#tables')).includes('No tables yet') && await pg.isVisible('#addTables'), 'restaurant till, no tables: "No tables yet" with an Add tables button');
  await shot(pg, 'after-restaurant-till-no-tables-yet');
  await Promise.all([pg.waitForNavigation(), pg.click('#addTables')]);
  check(pg.url().endsWith('/pos/tables') && (await pg.textContent('.tb-empty h2')) === 'No tables yet', 'Add tables opens POS setup > Tables');
  await shot(pg, 'after-tables-setup-empty', true);
  await pg.fill('#new_area_tables', '1-6'); await Promise.all([pg.waitForNavigation(), pg.click('.tb-save .btn.pri')]);
  check((await pg.textContent('.flash.ok')).includes('Inside added with 6 tables'), 'the first area and tables 1 to 6 are added in one go');
  await pg.fill('#new_area', 'Outside'); await pg.fill('#new_area_tables', 'P1, P2, Deck 1'); await pg.fill('#new_area_seats', '2');
  await Promise.all([pg.waitForNavigation(), pg.click('.tb-save .btn.pri')]);
  check(await pg.$$eval('.tb-area[data-area]', e => e.map(x => x.dataset.area).join()) === 'Inside,Outside' && await pg.$$eval('.tb-row', e => e.length) === 9, 'a second area (Outside) with named tables');
  // rename a table, change its seats, remove another
  const row = pg.locator('.tb-row', { has: pg.locator('input[value="Deck 1"]') });
  await row.locator('input[type=text]').fill('Deck'); await row.locator('input[type=number]').fill('8');
  await pg.locator('.tb-row', { has: pg.locator('input[value="6"][type=text]') }).locator('input[type=checkbox]').check();
  await Promise.all([pg.waitForNavigation(), pg.click('.tb-save .btn.pri')]);
  const flash = await pg.textContent('.flash.ok');
  check(flash.includes('1 table removed') && flash.includes('1 renamed') && await pg.$$eval('.tb-row', e => e.length) === 8, 'rename a table, change its seats, remove a table: ' + flash.trim());
  check(await side(pg) <= 0 && !pg.errs.length, 'Tables setup: no sideways scroll, no errors ' + pg.errs.join(' | '));
  await shot(pg, 'after-tables-setup', true);
  // the till shows them by area; open a table, add items, send, then move and split
  await pg.goto(Q + '/pos/'); await pg.click('#tnav [data-open="tables"]'); await pg.waitForTimeout(300);
  check(await pg.$$eval('#tables h3', e => e.map(x => x.textContent).join()) === 'Inside,Outside' && await pg.$$eval('#tables [data-table]', e => e.map(x => x.dataset.table).join()) === '1,2,3,4,5,P1,P2,Deck', 'the till shows the tables by area: ' + await pg.$$eval('#tables [data-table]', e => e.map(x => x.dataset.table).join()));
  check((await pg.textContent('#tables [data-table="Deck"]')).includes('8 seats'), 'a free table shows its seats');
  await pg.click('#tables [data-table="3"]'); await pg.click('#grid .pt >> text=Beef Burger'); await pg.click('#grid .pt >> text=Flat White'); await pg.click('#grid .pt >> text=Flat White');
  check((await pg.textContent('#cTitle')).includes('Table 3') && await pg.$$eval('#lines .cl', e => e.length) === 2, 'open table 3 and add items');
  await pg.click('#kitchen'); await pg.waitForTimeout(600);
  await pg.click('#tnav [data-open="tables"]'); await pg.waitForTimeout(300);
  check(await pg.$eval('#tables [data-table="3"]', e => e.classList.contains('busy') && /\$\d/.test(e.textContent)), 'table 3 now shows as in use, with its total');
  await shot(pg, 'after-restaurant-till-tables');
  await pg.click('#tables [data-table="3"]'); await pg.waitForTimeout(200);
  await pg.click('#tact'); await pg.click('[data-ta="move"]'); await pg.waitForTimeout(400); await pg.click('#tables [data-table="P1"]'); await pg.waitForTimeout(500);
  check((await pg.textContent('#cTitle')).includes('Table P1'), 'move the table to P1 (Outside)');
  await pg.click('#tact'); await pg.click('[data-ta="split"]'); await pg.waitForTimeout(400); await pg.click('#spGo'); await pg.waitForTimeout(600);
  check(await pg.isVisible('#pBill.show') && await pg.$$eval('#bParts .part', e => e.length) === 2, 'split the bill between two guests');
  await pg.click('#bUndo'); await pg.waitForTimeout(500);
  // a table with an open order can't be removed
  await pg.goto(Q + '/pos/tables');
  check(await pg.locator('.tb-row.busy').count() === 1 && (await pg.textContent('.tb-row.busy')).includes('Order open'), 'Tables setup marks the table with an open order (no Remove)');
  check(!pg.errs.length, 'tables: no script errors ' + pg.errs.join(' | '));

  // ================= 4. promotions
  await pg.goto(Q + '/pos/promotions');
  check((await pg.textContent('.content')).includes('No promotions yet') && await pg.isVisible('#form'), 'Promotions: empty, with the form ready for the first one');
  const mk = async (f) => { if (!(await pg.isVisible('#form'))) await Promise.all([pg.waitForNavigation(), pg.click('a:has-text("+ New promotion")')]);
    await pg.fill('#pname', f.name); await pg.check(`input[name=kind][value=${f.kind}]`); await pg.fill('#pvalue', f.value); await pg.check(`input[name=scope][value=${f.scope}]`);
    if (f.category) await pg.selectOption('#pcat', f.category); if (f.code) await pg.fill('#pcode', f.code);
    for (const d of f.days || []) await pg.check(`input[name=days][value="${d}"]`);
    if (f.from) { await pg.fill('#pfrom', f.from); await pg.fill('#pto', f.to); }
    if (f.shot) await shot(pg, f.shot, true);
    await Promise.all([pg.waitForNavigation(), pg.click('#form .btn.pri')]); };
  await mk({ name: 'Coffee special', kind: 'amount', value: '1.00', scope: 'category', category: 'Coffee' });
  check((await pg.textContent('.flash.ok')).includes('The till applies it by itself'), 'a promotion without a code applies by itself');
  await mk({ name: 'Welcome', kind: 'percent', value: '10', scope: 'sale', code: 'welcome10' });
  check((await pg.textContent('.flash.ok')).includes('WELCOME10'), 'a promotion with a code');
  await mk({ name: 'Five off', kind: 'amount', value: '5', scope: 'sale' });
  await mk({ name: 'Weekday happy hour', kind: 'percent', value: '20', scope: 'category', category: 'Drinks', days: [0, 1, 2, 3, 4], from: '15:00', to: '17:00', shot: 'after-promotions-new-form' });
  const list = await pg.textContent('.pm-list');
  check(list.includes('$1.00 off') && list.includes('10% off') && list.includes('Mon to Fri, 3 pm to 5 pm') && list.includes('WELCOME10'), 'the list says what each promotion does, when, and its code');
  check(await side(pg) <= 0 && !pg.errs.length, 'Promotions: no sideways scroll, no errors ' + pg.errs.join(' | '));
  await shot(pg, 'after-promotions', true);
  await openMenus(pg);
  check(await pg.locator('.side a:has-text("Promotions")').count() === 1 && await pg.locator('.side a:has-text("Tables")').count() === 1, 'Promotions and Tables are in the Setup menu');
  // at the till: by itself, by code, off the whole sale; the till's total is the server's total
  await pg.goto(Q + '/pos/'); await pg.waitForTimeout(300);
  await pg.evaluate(() => sessionStorage.clear()); await pg.reload(); await pg.waitForTimeout(300);
  await pg.click('#otype [data-t="takeaway"]');
  await pg.click('#grid .pt >> text=Flat White'); await pg.click('#grid .pt >> text=Flat White'); await pg.click('#grid .pt >> text=Beef Burger');
  let cart = await pg.textContent('#lines');
  check(cart.includes('Coffee special −$2.00') && !cart.includes('Welcome'), 'the category promotion shows on its items by itself: $1.00 off each coffee');
  check((await pg.textContent('#wholeRow')).includes('Five off') && (await pg.textContent('#total')).trim() === '$24.00', 'the amount off the whole sale comes off once: total ' + (await pg.textContent('#total')).trim());
  await pg.click('#promoBtn'); await pg.fill('#codeIn', 'nope'); await pg.click('#codeGo');
  check((await pg.textContent('#codeErr')).includes('No promotion uses that code'), 'a wrong promo code says so plainly');
  await pg.fill('#codeIn', 'welcome10'); await pg.click('#codeGo'); await pg.waitForTimeout(200);
  cart = await pg.textContent('#lines');
  check(cart.includes('Welcome −$2.00') && cart.includes('Coffee special −$2.00') && (await pg.textContent('#total')).trim() === '$22.00', 'the code adds its promotion where it is the best one: total ' + (await pg.textContent('#total')).trim());
  check((await pg.textContent('#savedRow')).includes('$9.00'), 'the till shows what the customer saves ($9.00)');
  await shot(pg, 'after-promotions-at-the-till');
  await pg.click('#pay'); await pg.click('#methods [data-m="cash"]'); await pg.click('#quick [data-cash]'); await pg.click('#complete'); await pg.waitForTimeout(800);
  check(await pg.isVisible('#pDone.show') && !(await pg.textContent('#payErr')), 'the sale completes: the till and the server agree on $22.00 ' + await pg.textContent('#payErr'));
  // ================= 3. the receipt, straight after the sale
  await Promise.all([pg.waitForNavigation(), pg.click('#viewRc')]);
  check(/\/pos\/receipt\/\d+\/view/.test(pg.url()), '"View or email the receipt" opens the receipt on the screen, in the same window');
  await pg.waitForTimeout(500);
  let rc = await pg.frameLocator('#rvFrame').locator('body').textContent();
  check(rc.includes('Coffee special') && rc.includes('Welcome') && rc.includes('Five off') && rc.includes('You saved') && rc.includes('$9.00') && rc.includes('$22.00'), 'the receipt names each promotion and what was saved');
  check(!/-\d+\.\d{3,}%/.test(rc), 'no odd percentages on the receipt');
  check(await pg.isVisible('a:has-text("New sale")'), 'after a sale the receipt screen offers New sale');
  await shot(pg, 'after-receipt-view-with-promotions');
  check(!pg.errs.length && !(await ownPopups(pg)).length, 'promotions and the receipt: no script errors, no new window ' + pg.errs.join(' | '));
  await pg.context().close();

  // ================= 3. a past receipt from the sales lists (a shop with no receipt printer chosen)
  pg = await login(b, R);
  for (const [u, name] of [['/pos/sales', "Today's sales"], ['/pos/sales/all', 'All sales']]) {
    await pg.goto(R + u); await Promise.all([pg.waitForNavigation(), pg.click('[data-view-receipt]')]);
    check(/\/pos\/receipt\/1\/view/.test(pg.url()) && pg.context().pages().length === 1, `${name}: View receipt opens it on the screen, in the app window`);
  }
  await pg.goto(R + '/pos/sales'); await Promise.all([pg.waitForNavigation(), pg.click('[data-view-receipt]')]); await pg.waitForTimeout(500);
  rc = await pg.frameLocator('#rvFrame').locator('body').textContent();
  check(rc.includes('Surf Hoodie') && rc.includes('TOTAL') && rc.includes('Synthetic Surf & Cafe'), 'the receipt is shown as it prints');
  check(await pg.evaluate(() => !window.__printed), 'looking at a receipt does not print it');
  check((await pg.textContent('#rvHint')).includes('narrow strip') && await pg.locator('#rvHint a[href*="/pos/hardware"]').count() === 1, 'no receipt printer chosen: it says so, with a link to Hardware');
  check((await pg.textContent('#rvNoMail')).includes("Email isn't set up yet"), 'email not set up: it says so (no dead button)');
  await shot(pg, 'after-receipt-view');
  await pg.click('#rvPrint'); await pg.waitForTimeout(900);
  check(await pg.evaluate(() => window.__printed === 1) && await pg.locator('iframe[data-inapp-print]').count() === 1 && pg.context().pages().length === 1, 'Print it again prints from inside the app (no new window, no web browser)');
  // on an A4 printer: the receipt keeps its own width (the block is 72 mm or so wide, whatever the paper)
  const paperW = await pg.frameLocator('#rvFrame').locator('.r').evaluate(e => e.getBoundingClientRect().width);
  check(paperW > 200 && paperW <= 80 * 3.78 + 1, `sent to an A4 printer it is still receipt-sized (${Math.round(paperW / 3.78)} mm wide)`);
  // with a receipt printer chosen in Hardware: straight to it, and the note goes
  await pg.goto(R + '/pos/hardware');
  check(await pg.isVisible('#noPrinterNote'), 'Hardware says plainly that no receipt printer is chosen');
  const hw = await pg.textContent('.content');
  check(['Receipt printer', 'Cash drawer', 'Barcode scanner', 'Adjust print layout', 'What the receipt says', 'Card machine'].every(t => hw.includes(t)) &&
    await pg.locator('#rp option').count() === 3 && await pg.locator('input[name=paper][value="58"]').count() === 1 && await pg.locator('input[name=paper][value="80"]').count() === 1 &&
    await pg.locator('#adj_left, #adj_right, #adj_top, #adj_bottom').count() === 4 && await pg.locator('input[name=logo]').count() === 1 && await pg.locator('#adjLogo').count() === 1 &&
    await pg.locator('[data-testprint]').count() === 1 && await pg.locator('[data-testdrawer]').count() === 1 && await pg.locator('[data-align]').count() === 1,
    'Hardware: choose the printer, 58 / 80 mm paper, left / right / top / bottom margins, logo on / off and size, test print, scanner and cash drawer, all on one page');
  await pg.selectOption('#rp', 'EPSON TM-T82III Receipt'); await Promise.all([pg.waitForNavigation(), pg.click('#receipt .btn.pri')]);
  check(!(await pg.isVisible('#noPrinterNote')), 'with a receipt printer chosen the note goes');
  await pg.click('[data-testprint]'); await pg.waitForTimeout(500);
  check((await pg.textContent('#tpRes')).includes('Sent to EPSON'), 'Test print goes to the chosen printer');
  await shot(pg, 'after-hardware', true);
  await pg.goto(R + '/pos/receipt/1/view'); await pg.evaluate(() => { window.__printed = 0; });
  check(!(await pg.locator('#rvHint').count()) && (await pg.textContent('#rvWhere')).includes('EPSON'), 'the receipt screen names the printer it will use');
  await pg.click('#rvPrint'); await pg.waitForTimeout(500);
  check((await pg.textContent('#rvMsg')).includes('Receipt printed') && await pg.evaluate(() => !window.__printed), 'Print it again goes straight to the receipt printer (no print box)');
  check(!pg.errs.length, 'receipts: no script errors ' + pg.errs.join(' | '));

  // ================= 1. nothing of ours opens a new window
  await pg.goto(R + '/pos/sales');
  await pg.evaluate(() => { const a = document.createElement('a'); a.href = '/pos/receipt/1'; a.target = '_blank'; a.id = 'probeBlank'; a.textContent = 'x'; document.body.appendChild(a); a.click(); });
  await pg.waitForTimeout(400);
  check(!(await ownPopups(pg)).length && await pg.isVisible('#inappViewer'), 'a link to our own page with target="_blank" (what 2.11.0 did) opens the in-app viewer, not a new window');
  await pg.click('#inappViewer [data-iv=close]');
  const opened = await pg.evaluate(() => window.open('/pos/receipt/1')); await pg.waitForTimeout(400);
  check(opened === null && !(await ownPopups(pg)).length && await pg.isVisible('#inappViewer'), 'window.open for our own page does the same');
  await pg.click('#inappViewer [data-iv=close]');
  await pg.evaluate(() => { const f = document.createElement('form'); f.action = '/pos/sales'; f.target = '_blank'; f.method = 'get'; document.body.appendChild(f); f.requestSubmit(); });
  await pg.waitForLoadState('load'); await pg.waitForTimeout(300);
  check(!(await ownPopups(pg)).length, 'a form to our own page with target="_blank" stays in this window');
  await pg.goto(R + '/pos/sales');
  const [ext] = await Promise.all([pg.context().waitForEvent('page', { timeout: 4000 }).catch(() => null),
    pg.evaluate(() => { const a = document.createElement('a'); a.href = 'https://riyeser.com/link/'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'x'; document.body.appendChild(a); a.click(); })]);
  check(!!ext, 'a link to another website (riyeser.com) still opens outside the app, as it should'); await closePopups(pg);
  const POS_SCREENS = ['/pos/sales', '/pos/sales/all', '/pos/close?till=1', '/pos/shift/1', '/pos/setup', '/pos/hardware', '/pos/kitchen', '/pos/approvals', '/pos/promotions', '/pos/tables',
    '/pos/receipt/1/view', '/today', '/reports/', '/reports/sales_item', '/help/', '/online/', '/online/settings', '/inventory/', '/inventory/low-stock', '/inventory/count', '/inventory/transfers',
    '/cards/customer', '/core/bookings-app', '/backups/', '/setup/email/', '/users', '/companies/'];
  await probeLinks(pg, R, POS_SCREENS, 'Riyeser POS (retail)');
  await pg.context().close();
  pg = await login(b, Q);
  await probeLinks(pg, Q, POS_SCREENS.concat(['/kds/']), 'Riyeser POS (restaurant)');
  await pg.context().close();
  for (const [name, base] of Object.entries(APPS)) {   // the other programs that share this code
    pg = await login(b, base); await openMenus(pg);
    const urls = await pg.$$eval('a[href]', as => [...new Set(as.map(a => a.getAttribute('href')).filter(h => h.startsWith('/') && !/logout|switch|delete|void|\/static\//.test(h)))]);
    const more = [];
    for (const u of urls.slice(0, 60)) { const r = await pg.goto(base + u).catch(() => null); if (!r || r.status() >= 400) continue;
      for (const h of await pg.$$eval('.content a[href]', as => as.map(a => a.getAttribute('href')).filter(h => h.startsWith('/') && !/logout|switch|delete|void|\/static\//.test(h)).slice(0, 4))) if (!urls.includes(h) && !more.includes(h)) more.push(h); }
    await probeLinks(pg, base, urls.concat(more.slice(0, 80)), `Riyeser ${name}`);
    check(!pg.popups.filter(ours).length, `Riyeser ${name}: no new window for our own pages`);
    await pg.context().close();
  }

  // ================= 5. switching Retail <-> Restaurant
  pg = await login(b, R);
  await pg.goto(R + '/pos/'); await pg.waitForTimeout(300); await pg.click('#grid .pt >> text=Surf Cap');     // a sale in progress when the type changes
  await pg.goto(R + '/pos/setup');
  await pg.click('input[name=mode][value=restaurant]'); await pg.waitForTimeout(150);
  const st = await pg.evaluate(() => ({ opacity: getComputedStyle(document.getElementById('featCard')).opacity,
    shown: [...document.querySelectorAll('[data-feats]')].filter(d => !d.hidden).map(d => d.dataset.feats).join(),
    names: [...document.querySelectorAll('[data-feats]:not([hidden]) .ft b')].map(x => x.textContent) }));
  check(st.opacity === '1' && st.shown === 'restaurant' && st.names.includes('Tables (dine-in)') && !st.names.includes('Barcode scanning'), 'choosing Restaurant shows the restaurant features straight away, not greyed out: ' + st.names.join(', '));
  check(!(await covered(pg, '[data-feats]:not([hidden]) .ft input, input[name=mode], #setupForm button.btn.pri')).length, 'nothing lies over the feature switches or Save');
  const sw = pg.locator('[data-feats="restaurant"] input[value="stock"]'), was = await sw.isChecked();
  await sw.click(); check(await sw.isChecked() === !was, 'a feature switch can be turned on before saving');
  await pg.locator('[data-feats="restaurant"] input[value="takeaway"]').click();
  await pg.evaluate(() => document.querySelector('.ptypes').scrollIntoView()); await shot(pg, 'after-mode-switch-features-usable');
  await Promise.all([pg.waitForNavigation(), pg.click('#setupForm button.btn.pri')]);
  check(pg.url().endsWith('/pos/tables') && (await pg.textContent('.content')).includes('Next: add your tables and areas.'), 'saving switches to Restaurant and goes on to add tables');
  await pg.goto(R + '/pos/setup');
  const on = await pg.$$eval('[data-feats="restaurant"] input', e => e.filter(x => x.checked).map(x => x.value).join());
  check(on.includes('stock') && !on.includes('takeaway') && await pg.isChecked('input[name=mode][value=restaurant]'), 'the switches chosen on the way were saved: ' + on);
  await pg.goto(R + '/pos/'); await pg.waitForTimeout(400);
  check(!pg.errs.length && await pg.isVisible('#tableBtn') && await pg.$$eval('#lines .cl', e => e.length) === 1, 'the till after the switch: the sale in progress is kept as a dine-in order asking for its table ' + pg.errs.join(' | '));
  await pg.click('#grid .pt >> text=Board Wax');
  check(await pg.$$eval('#lines .cl', e => e.length) === 2, 'products still add to the sale after the switch');
  await pg.click('#clear');
  await clickTillMenu(pg, R, 'retail -> restaurant', 'restaurant');
  await clickBackOfficeMenu(pg, R, 'retail -> restaurant');
  // and back again
  await pg.goto(R + '/pos/setup'); await pg.click('input[name=mode][value=retail]'); await pg.waitForTimeout(150);
  check(await pg.evaluate(() => [...document.querySelectorAll('[data-feats]')].filter(d => !d.hidden).map(d => d.dataset.feats).join()) === 'retail', 'choosing Retail shows the retail features');
  await pg.locator('[data-feats="retail"] input[value="sku"]').click();
  await Promise.all([pg.waitForNavigation(), pg.click('#setupForm button.btn.pri')]);
  check(pg.url().endsWith('/pos/setup') && (await pg.textContent('.flash.ok')).includes('Switched to Retail'), 'saving switches back to Retail');
  check(!(await pg.$$eval('[data-feats="retail"] input', e => e.filter(x => x.checked).map(x => x.value))).includes('sku'), 'with the retail switch that was changed');
  await pg.goto(R + '/pos/'); await pg.waitForTimeout(300);
  check(!pg.errs.length && !(await pg.locator('#tableBtn').count()) && !(await pg.locator('#otype').count()), 'the till is a shop till again: no tables, no kitchen');
  await clickTillMenu(pg, R, 'restaurant -> retail', 'retail');
  await clickBackOfficeMenu(pg, R, 'restaurant -> retail');
  await pg.context().close();

  // ================= layout: every new or changed screen at three sizes
  for (const [w, h] of [[1366, 768], [1024, 768], [390, 844]]) {
    for (const base of [R, Q]) {
      const p2 = await login(b, base, w, h);
      for (const u of ['/pos/', '/pos/promotions', '/pos/promotions?new=1', '/pos/tables', '/pos/receipt/1/view', '/pos/setup', '/pos/hardware', '/pos/sales', '/pos/sales/all']) {
        p2.errs.length = 0;
        const r = await p2.goto(base + u, { waitUntil: 'load' }); await p2.waitForTimeout(250);
        const s = await side(p2);
        check(r.status() < 400 && s <= 0 && !p2.errs.length, `${w}x${h} ${base === R ? 'retail' : 'restaurant'} ${u}: no sideways scroll (${s}), no errors ${p2.errs.join(' | ')}`);
      }
      if (base === Q) { await p2.goto(base + '/pos/'); await p2.click('#tnav [data-open="tables"]'); await p2.waitForTimeout(300);
        const fits = await p2.evaluate(() => { const b = document.querySelector('#mTables .box').getBoundingClientRect(); return [...document.querySelectorAll('#tables button')].every(x => { const r = x.getBoundingClientRect(); return r.left >= b.left - 1 && r.right <= b.right + 1 && r.width >= 44 && r.height >= 44; }); });
        check(fits && await side(p2) <= 0, `${w}x${h} the Tables screen fits, with touch-sized tables`); }
      await p2.context().close();
    }
  }
  await b.close();
  console.log(failed ? `${failed} failed` : 'all passed'); process.exit(failed ? 1 : 0);
})();
