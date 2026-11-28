const { _electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs'); const path = require('path');
const DESK = process.argv[2]; const HOME = fs.mkdtempSync('/dev/shm/qa-pdfk-');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
(async () => {
  const app = await _electron.launch({ executablePath: require(require('path').join(__dirname, '..', '..', '..', 'node_modules', 'electron')), args: ['--no-sandbox', path.join(DESK, 'src', 'pdf-main.js')], env: { ...process.env, HOME, TMPDIR: '/dev/shm' } });
  const w = await app.firstWindow(); await w.waitForFunction(() => window.__editor, null, { timeout: 30000 });
  w.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await w.evaluate((f) => window.__editor.openTab(f), (process.env.PDF_FILES || '/dev/shm/pdfh-files') + '/Quote Q-2041 v1.pdf'); await w.waitForTimeout(2000);
  await w.focus('#signbtn'); await w.keyboard.press('Enter'); await w.waitForTimeout(200);
  let a = await w.evaluate(() => [document.querySelector('#signmenu').hidden, document.activeElement.dataset.cmd, document.querySelector('#signbtn').getAttribute('aria-expanded')]);
  ok(!a[0] && a[1] === 'mysignature' && a[2] === 'true', `Enter on Sign opens its menu, focus on the first entry: ${a}`);
  await w.keyboard.press('ArrowDown'); a = await w.evaluate(() => document.activeElement.dataset.cmd); ok(a === 'myinitials', `Down moves: ${a}`);
  await w.keyboard.press('Escape'); a = await w.evaluate(() => [document.querySelector('#signmenu').hidden, document.activeElement.id]); ok(a[0] && a[1] === 'signbtn', `Esc closes and goes back to the button: ${a}`);
  await w.keyboard.press('Enter'); await w.waitForTimeout(100); await w.keyboard.press('ArrowDown'); await w.keyboard.press('Enter'); await w.waitForTimeout(600);
  a = await w.evaluate(() => !document.querySelector('#sigmodal').hidden); ok(a, 'My initials with none saved opens the window to make them');
  await w.keyboard.press('Escape'); await w.waitForTimeout(200);
  a = await w.evaluate(() => document.querySelector('#sigmodal').hidden); ok(a, 'Esc closes the signature window');
  await w.keyboard.press('Control+w'); await w.waitForTimeout(500);
  a = await w.evaluate(() => [window.__editor.tabs.list.length, document.body.dataset.view]); ok(a[0] === 0 && a[1] === 'home', `Ctrl+W closes an unchanged tab without asking: ${a}`);
  // a changed tab asks before closing
  await w.evaluate((f) => window.__editor.openTab(f), (process.env.PDF_FILES || '/dev/shm/pdfh-files') + '/Quote Q-2041 v1.pdf'); await w.waitForTimeout(1500);
  await w.evaluate(() => window.__editor.commands.date()); await w.waitForTimeout(300);
  await w.evaluate(() => { window.__editor.closeTab(window.__editor.tabs.active); }); await w.waitForTimeout(400);
  a = await w.evaluate(() => [!document.querySelector('#dlg').hidden, document.querySelector('#dlgbox h2').textContent]); ok(a[0], `closing a changed tab asks: ${a[1]}`);
  await w.click('#dlgbox [data-dlg="discard"]'); await w.waitForTimeout(300);
  a = await w.evaluate(() => window.__editor.tabs.list.length); ok(a === 0, 'Don\'t save closes it');
  // start screen with the keyboard: Tab reaches the tiles, Enter on Settings
  await w.keyboard.press('Tab'); await w.keyboard.press('Tab'); await w.keyboard.press('Tab'); await w.keyboard.press('Tab');
  a = await w.evaluate(() => document.activeElement.className + ':' + document.activeElement.textContent.trim().slice(0, 20)); console.log('INFO focus after 4 tabs:', a);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((x) => x.destroy())).catch(() => {}); await app.close().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
