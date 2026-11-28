// Riyeser POS 2.11.1 in a real browser: Till PINs (lock screen, who's opening the till, switch, auto-lock, manager
// PIN), the keypads' Clear key (tap and Esc / Delete), printing that stays in the app window, the barcode scanner, and
// POS setup › Hardware. Layout at 1366x768, 1024x768 and 390 wide: no sideways scroll, no script errors.
//   python tests/browser/serve_pos_pins.py 8311 retail &
//   python tests/browser/serve_pos_pins.py 8312 restaurant &
//   node tests/browser/pos_pins.e2e.js            (SHOTS=<folder> also saves the evidence screenshots)
const { chromium } = require('playwright');
const R = process.env.RETAIL || 'http://127.0.0.1:8311', Q = process.env.RESTAURANT || 'http://127.0.0.1:8312';
const SHOTS = process.env.SHOTS || '';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
const shot = async (pg, name, opts) => { if (SHOTS) await (opts && opts.el ? pg.locator(opts.el).screenshot({ path: `${SHOTS}/${name}.png` }) : pg.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: !!(opts && opts.full) })); };
async function login(b, base, w, h) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage(); pg.errs = [];
  pg.on('pageerror', e => pg.errs.push(e.message)); pg.on('dialog', d => d.accept());
  await pg.goto(base + '/login'); await pg.fill('input[name=username]', 'admin'); await pg.fill('input[name=password]', 'admin');
  await Promise.all([pg.waitForNavigation(), pg.press('input[name=password]', 'Enter')]);
  return pg;
}
async function pin(pg, digits) { for (const d of digits) await pg.click(`#lkKeys [data-k="${d}"]`); await pg.click('#lkGo'); }
async function unlockAs(pg, name, digits) {
  const tile = await pg.$(`#lkTiles button:has-text("${name}")`);   // not one of today's cashiers yet: PIN only
  await (tile ? tile.click() : pg.click('#lkTiles button.other')); await pin(pg, digits);
  await pg.waitForLoadState('load'); await pg.waitForTimeout(400);
}
const side = pg => pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

(async () => {
  const b = await chromium.launch();
  // ---- layout: every new or changed screen at three sizes
  for (const [w, h] of [[1366, 768], [1024, 768], [390, 844]]) {
    for (const base of [R, Q]) {
      const pg = await login(b, base, w, h);
      for (const u of ['/pos/', '/pos/hardware', '/pos/hardware/start?till=2', '/pos/hardware/start?till=2&step=adjust',
        '/users', '/pos/setup', '/pos/approvals', '/login']) {
        pg.errs.length = 0;
        const r = await pg.goto(base + u, { waitUntil: 'load' }); await pg.waitForTimeout(250);
        const s = await side(pg);
        check(r.status() < 400 && s <= 0 && !pg.errs.length, `${w}x${h} ${base === R ? 'retail' : 'restaurant'} ${u}: no sideways scroll (${s}), no errors ${pg.errs.join(' | ')}`);
        if (base === R && u === '/pos/hardware' && SHOTS) await shot(pg, `PIN-hardware-after-${w}`, { full: true });
        if (base === R && u === '/pos/hardware/start?till=2' && SHOTS) await shot(pg, `PIN-walkthrough-after-${w}`, { full: true });
        if (base === R && u === '/users' && SHOTS) await shot(pg, `PIN-users-after-${w}`, { full: true });
        if (base === R && u === '/pos/setup' && SHOTS) await shot(pg, `PIN-setup-after-${w}`, { full: true });
        if (base === R && u === '/login' && SHOTS && w !== 1024) await shot(pg, `PIN-login-after-${w}`);
      }
      await pg.goto(base + '/pos/');
      check(await pg.isVisible('#lockScr.show'), `${w} the till opens locked: "Who's selling?"`);
      if (base === R) await shot(pg, `PIN-locked-whos-selling-after-${w}`);
      await unlockAs(pg, 'Sam Supervisor', '9999');
      for (const u of ['/pos/', '/pos/sales', '/pos/close?till=1']) {
        pg.errs.length = 0; await pg.goto(base + u); await pg.waitForTimeout(250);
        const s = await side(pg);
        check(s <= 0 && !pg.errs.length && !(await pg.isVisible('#lockScr.show')), `${w} unlocked ${u}: no sideways scroll (${s}), no errors ${pg.errs.join(' | ')}`);
        if (base === R && u === '/pos/sales') await shot(pg, `PIN-sales-by-cashier-after-${w}`, { full: true });
      }
      await pg.context().close();
    }
  }
  // ---- the lock screen, a wrong PIN, Maria signs in
  let pg = await login(b, R, 1366, 768);
  await pg.goto(R + '/pos/');
  await pg.click('#lkTiles button:has-text("Maria Synthetic")');
  check(await pg.isVisible('#lkPad') && (await pg.textContent('#lkWho')).includes('Maria Synthetic'), 'tapping a name asks for that person\'s PIN');
  await pg.keyboard.type('0000'); await pg.keyboard.press('Enter'); await pg.waitForTimeout(400);
  check((await pg.textContent('#lkErr')).includes("isn't right"), 'a wrong PIN is refused');
  await pg.keyboard.type('12'); await pg.keyboard.press('Escape');
  check((await pg.$$eval('#lkDots i.f', x => x.length)) === 0, 'Esc clears the PIN pad');
  await shot(pg, 'PIN-pin-pad-after-1366');
  await pg.keyboard.type('1111'); await pg.keyboard.press('Enter');
  await pg.waitForLoadState('load'); await pg.waitForTimeout(500);
  check((await pg.textContent('#switchBtn')).includes('Maria Synthetic'), 'Maria is selling: her name is on the Switch cashier button');
  // ---- who's opening the till (Kiosk till is closed): PIN first, then the float, with Clear
  await pg.selectOption('#till', '2'); await pg.waitForTimeout(400);
  check(await pg.isVisible('#lockScr.show') && (await pg.textContent('#lkTitle')) === "Who's opening the till?", 'opening a till asks "Who\'s opening the till?"');
  await shot(pg, 'PIN-whos-opening-the-till-after-1366');
  await pin(pg, '2222'); await pg.waitForTimeout(500);
  check((await pg.textContent('#openWhoTxt')).includes('Jo Example'), 'the float is counted against Jo');
  await pg.click('#fkeys [data-k="clear"]'); await pg.click('#fkeys button:text-is("5")'); await pg.click('#fkeys button:text-is("0")');
  check((await pg.textContent('#flt')).trim() === '$0.50', 'float keypad types');
  await pg.click('#fkeys [data-k="clear"]');
  check((await pg.textContent('#flt')).trim() === '$0.00', 'C clears the float to $0.00');
  await pg.keyboard.type('15000'); await pg.keyboard.press('Backspace');
  check((await pg.textContent('#flt')).trim() === '$15.00', 'typing and Backspace on the keyboard work on the float');
  await pg.keyboard.press('Delete');
  check((await pg.textContent('#flt')).trim() === '$0.00', 'Delete clears the float');
  await pg.keyboard.type('20000'); await pg.keyboard.press('Escape');
  check((await pg.textContent('#flt')).trim() === '$0.00', 'Esc clears the float');
  await pg.click('[data-flt="20000"]');
  await shot(pg, 'PIN-keypad-open-till-after-1366');
  await pg.click('#openGo'); await pg.waitForLoadState('load'); await pg.waitForTimeout(600);
  check((await pg.textContent('#switchBtn')).includes('Jo Example'), 'after opening, Jo is selling');
  // ---- the cash keypad's Clear, then printing stays in the app (Kiosk till: no receipt printer -> print box in a frame)
  await pg.click('.pt >> nth=2'); await pg.click('#pay'); await pg.click('[data-m=cash]');
  for (const k of ['1', '2', '3']) await pg.click(`#keys button:text-is("${k}")`);
  check((await pg.textContent('#tend')).trim() === '$1.23', 'cash keypad types');
  await pg.keyboard.press('Delete');
  check((await pg.textContent('#tend')).trim() === '$0.00', 'Delete clears the cash received');
  await pg.click('#keys button:text-is("2")'); await pg.click('#keys [data-k="clear"]');
  check((await pg.textContent('#tend')).trim() === '$0.00', 'C clears the cash received');
  await pg.click('#quick button >> nth=1');
  await shot(pg, 'PIN-keypad-cash-after-1366');
  await pg.click('#complete'); await pg.waitForSelector('#pDone.show');
  const pages = pg.context().pages().length;
  await pg.click('#printRc'); await pg.waitForTimeout(900);
  const fr = await pg.evaluate(() => { const f = document.querySelector('iframe[data-inapp-print]'); return f ? f.dataset.inappPrint : null; });
  check(pg.context().pages().length === pages && /\/pos\/receipt\/\d+/.test(fr || '') && pg.url().startsWith(R + '/pos/'),
    'Print receipt prints inside the app window (no new window, same session): ' + fr);
  const rc = await pg.evaluate(async u => { const r = await fetch(u); return [r.status, r.url]; }, fr);
  check(rc[0] === 200 && !rc[1].includes('/login'), 'the receipt loads signed in (not the sign-in page)');
  // Till 1 has a receipt printer: the receipt goes straight to it
  await pg.selectOption('#till', '1'); await pg.waitForTimeout(300);
  await pg.click('.pt >> nth=1'); await pg.click('#pay'); await pg.click('[data-m=cash]'); await pg.click('#quick button >> nth=0');
  await pg.click('#complete'); await pg.waitForSelector('#pDone.show');
  await pg.click('#printRc'); await pg.waitForTimeout(600);
  check((await pg.textContent('#toast')).includes('Receipt printed') && pg.context().pages().length === pages, 'with a receipt printer: printed straight to it, no print box');
  // ---- the barcode scanner: a fast burst + Enter adds the item, even with the search box selected; slow typing is left alone
  await pg.waitForTimeout(200);
  await pg.click('#q'); await pg.keyboard.type('wax', { delay: 160 });
  check((await pg.inputValue('#q')) === 'wax', 'slow typing in the search box is left alone');
  await pg.keyboard.type('9300000001001', { delay: 4 }); await pg.keyboard.press('Enter'); await pg.waitForTimeout(300);
  check((await pg.textContent('#lines')).includes('Classic Tee') && (await pg.inputValue('#q')) === 'wax', 'a scan adds the item and the search box keeps what was typed');
  await pg.fill('#q', ''); await pg.click('body', { position: { x: 300, y: 300 } });
  await pg.keyboard.type('9399999999999', { delay: 4 }); await pg.keyboard.press('Enter'); await pg.waitForTimeout(300);
  check(await pg.isVisible('#mUnknown.show') && await pg.isVisible('#unkAsk') && !(await pg.isVisible('#unkAdd')), 'an unknown barcode: a cashier is told to ask a manager');
  await shot(pg, 'PIN-scan-unknown-cashier-after-1366');
  if (await pg.isVisible('#mUnknown.show')) await pg.click('#mUnknown .x');
  // ---- manager PIN approval on the same screen: Jo refunds, Sam approves with his PIN, Jo stays signed in
  await pg.goto(R + '/pos/sales'); await pg.click('[data-refund] >> nth=0'); await pg.waitForTimeout(500);
  await pg.click('#rfLines [data-inc="0"]'); await pg.click('#rfMethod [data-m=cash]'); await pg.click('#rfGo');
  await pg.waitForTimeout(400);
  const asked = await pg.isVisible('#mApprove.show');
  check(asked, 'a cashier\'s refund asks for a manager\'s approval');
  if (asked) {
    await pg.click('#apReasons button >> nth=0');
    const tab = await pg.$('[data-aptab=pin]'); if (tab) await tab.click();
    for (const d of '9999') await pg.click(`#apPad button:has-text("${d}")`);
    await shot(pg, 'PIN-manager-pin-approval-after-1366');
    await pg.click('#apGo'); await pg.waitForTimeout(900);
    check((await pg.textContent('#switchBtn')).includes('Jo Example'), 'after the manager approves, Jo is still the cashier');
  }
  // ---- Switch cashier, then auto-lock
  await pg.goto(R + '/pos/'); await pg.click('#switchBtn'); await pg.waitForTimeout(400);
  check(await pg.isVisible('#lockScr.show') && (await pg.textContent('#lkTiles')).includes('Jo Example'), 'Switch cashier locks to today\'s cashiers');
  await unlockAs(pg, 'Maria Synthetic', '1111');
  await pg.evaluate(() => TillLock._idle(6 * 60000)); await pg.waitForTimeout(6000);
  check(await pg.isVisible('#lockScr.show'), 'the till locks itself after 5 minutes with no use');
  await pg.context().close();
  // ---- Hardware: the scanner test, the adjust panel, the receipt preview at 80 / 58 mm
  pg = await login(b, R, 1366, 900);
  await pg.goto(R + '/pos/hardware');
  await pg.click('#scanTest'); await pg.keyboard.type('9300000001003', { delay: 4 }); await pg.keyboard.press('Enter'); await pg.waitForTimeout(400);
  check((await pg.textContent('#scanOut')).includes('It works'), 'the scanner test reads a fast scan with Enter');
  await shot(pg, 'PIN-hw-scanner-test-after-1366', { el: '#scanner' });
  await pg.click('#scanTest'); await pg.keyboard.type('9300000001003', { delay: 4 }); await pg.waitForTimeout(1200);
  check((await pg.textContent('#scanOut')).includes("didn't press Enter"), 'a scan without Enter is explained');
  await shot(pg, 'PIN-hw-receipt-printer-after-1366', { el: '#receipt' });
  await shot(pg, 'PIN-hw-cash-drawer-after-1366', { el: '#drawer' });
  await shot(pg, 'PIN-hw-card-machine-after-1366', { el: '#card' });
  await shot(pg, 'PIN-hw-receipt-preview-80-after-1366', { el: '#layout' });
  await pg.check('#layout [name=pv][value="58"]'); await pg.waitForTimeout(800);
  await shot(pg, 'PIN-hw-receipt-preview-58-after-1366', { el: '#layout' });
  const w58 = await pg.$eval('#pvFrame', f => { const d = f.contentDocument; return d.documentElement.scrollWidth - d.documentElement.clientWidth; });
  check(w58 <= 0, '58 mm preview: nothing runs off the paper (' + w58 + ')');
  await pg.fill('#adj_left', '1.5'); await pg.click('[data-step="right|0.5"]'); await pg.waitForTimeout(700);
  await shot(pg, 'PIN-hw-adjust-layout-after-1366', { el: '#adjust' });
  await pg.check('#adjust [name=adjpv][value=align]'); await pg.waitForTimeout(800);
  check(await pg.$eval('#adjFrame', f => /TOP/.test(f.contentDocument.body.textContent) && /BOTTOM/.test(f.contentDocument.body.textContent)), 'the alignment test slip shows in the preview');
  await shot(pg, 'PIN-hw-alignment-slip-after-1366', { el: '#adjust' });
  await pg.click('[data-align]'); await pg.waitForTimeout(500);
  check((await pg.textContent('#taRes')).includes('Sent to EPSON'), 'Print alignment test goes to the printer');
  await pg.goto(R + '/users');
  await pg.evaluate(() => { const s = document.querySelector('#newPreset'); s.size = s.options.length; s.scrollIntoView({ block: 'center' }); });
  await pg.selectOption('#newPreset', 'cashier'); await pg.waitForTimeout(200);
  check((await pg.textContent('#presetHint')).includes("manager's PIN"), 'the Starting access hint explains Cashier');
  await shot(pg, 'PIN-starting-access-after-1366');
  await pg.evaluate(() => { document.querySelector('#newPreset').size = 0; });
  await pg.selectOption('#newPreset', 'supervisor'); await pg.selectOption('#newPreset', 'cashier');
  check(await pg.isChecked('#newPerms input[name=perm_sales][value="2"]') && (await pg.textContent('#newRole')) === 'Cashier',
    'choosing Cashier shows its standard access before adding');
  await pg.check('#newPerms input[name=perm_stock][value="1"]');
  check((await pg.textContent('#newRole')) === 'Cashier (customised)' && await pg.isVisible('#newReset'), 'changing an area shows "Cashier (customised)"');
  await pg.locator('#addUser').scrollIntoViewIfNeeded();
  await shot(pg, 'PIN-add-user-customised-after-1366', { el: '#addUser' });
  await pg.click('#newReset');
  check((await pg.textContent('#newRole')) === 'Cashier' && await pg.isChecked('#newPerms input[name=perm_stock][value="0"]'), 'Reset to Cashier standard');
  await pg.context().close();
  pg = await login(b, Q, 1366, 900);
  await pg.goto(Q + '/pos/hardware');
  await shot(pg, 'PIN-hw-kitchen-printers-after-1366', { el: '#kitchen' });
  await pg.goto(Q + '/pos/hardware?adj=station:2#adjust'); await pg.waitForTimeout(800);
  await shot(pg, 'PIN-hw-adjust-bar-docket-58-after-1366', { el: '#adjust' });
  await pg.context().close();
  await b.close();
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
