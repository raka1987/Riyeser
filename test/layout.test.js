// OWNER-POLISH (Payroll 2.3.3): lists look tidy on a laptop. The filter bar markup (always checked), then, where a
// Chromium for Playwright is installed, the real screens in demo mode at common laptop sizes (1280 x 720 at Windows 125%
// scaling, the same screen as the browser sees it: 1024 wide, and 1366 x 768): no page scrolls sideways, pills and
// buttons in table cells stay on one line, and a row's ⋯ menu opens, works with the keyboard and closes. Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LV = require('../public/listview.js');

// ------------------------------------------------------------------ the filter bar (no browser needed)
test('filter bar: labelled controls, Sort by joined to its direction button, count + Clear filters at the end', () => {
  const c = LV.list({ id: 'staff', uid: 1, meta: null, spec: {
    fields: { name: { label: 'First name', type: 'text' }, status: { label: 'Status (active first)', type: 'num' } },
    search: r => r.name, selects: [{ key: 'status', label: 'Status', options: [['active', 'Active'], ['left', 'Left / inactive']], test: () => true }] }, defaults: { sort: 'status' } });
  const html = c.bar({ shown: 3, total: 5 });
  assert.match(html, /class="lv-f lv-q"><span class="lv-k">Search<\/span><input type="search"/);
  assert.match(html, /<div class="lv-end"><div class="lv-f lv-sortbox"><label class="lv-k" for="lv-sort-staff">Sort by<\/label><div class="lv-join"><select id="lv-sort-staff" data-lv-sortsel title="Status \(active first\)">/);
  assert.match(html, /<button type="button" class="lv-dir" data-lv-dir aria-label="Ascending: press for descending"/);
  assert.match(html, /class="lv-foot"><span class="lv-count" aria-live="polite">Showing <b>3<\/b> of 5<\/span>/);
  assert.match(html, /<select data-lv-sel="status" title="All">/);   // the whole choice shows on hover, never cut off
  // headings keep a column's classes (so a column can step aside on a narrow window)
  assert.match(c.th('Phone', 'phone', { cls: 'hide-lg' }), /^<th class="hide-lg">Phone<\/th>$/);
  assert.match(c.th('Name', 'name', { cls: 'hide-md' }), /^<th class="hide-md lv-th"/);
});

test('styles: one spacing system, one-line cells, pills that never wrap, a table box that scrolls on its own', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.css'), 'utf8');
  for (const v of ['--sp-2: 8px', '--sp-3: 12px', '--sp-4: 16px', '--ctl-h: 36px', '--r-md:']) assert.ok(css.includes(v), v);
  assert.match(css, /body\.staff table\.t \.status, body\.staff table\.t \.chip, body\.staff table\.t \.pill, body\.staff table\.t \.btn \{ white-space: nowrap;/);
  assert.match(css, /body\.staff \.scroll \{ overflow: auto;/);
  assert.match(css, /scrollbar-width: thin/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.js'), 'utf8');
  assert.ok(!/'<span class="muted">·<\/span>'/.test(js), 'empty values show a quiet "—", not "·"');
  assert.match(js, /aria-haspopup="menu" aria-expanded="false" aria-label=/);
});

// ------------------------------------------------------------------ the real screens (needs Playwright's Chromium)
function loadPlaywright() {
  try { return require('playwright'); } catch { }
  try { return require(path.join(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'playwright')); } catch { }
  return null;
}
const PORT = 3987, B = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-layout-'));
let server, browser = null, cookie = null, why = '';
before(async () => {
  const pw = loadPlaywright();
  if (!pw) { why = 'Playwright is not installed'; return; }
  try { browser = await pw.chromium.launch(); } catch (e) { why = `no Chromium for Playwright (${e.message.split('\n')[0]})`; return; }
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR, APPDATA: path.join(DATA_DIR, 'appdata'), RIYESER_DEMO_FILE: path.join(DATA_DIR, 'no-demo.json'), RIYESER_DEMO: '1', RIYESER_DOCS: '', DESKTOP: '' }, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) { try { await fetch(B + '/api/public/info'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const res = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'demo' }) });
  assert.equal(res.status, 200, 'demo sign-in');
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => {
  if (browser) await browser.close();
  if (server && server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000); });
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { }
});
async function page(width, height, dpr) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const [name, ...v] = cookie.split('='); await ctx.addCookies([{ name, value: v.join('='), url: B }]);
  const p = await ctx.newPage(); return { p, ctx };
}
const VIEWS = ['employees', 'timesheets', 'roster', 'payroll', 'history', 'mypay', 'logins', 'audit', 'settings', 'timeclock', 'bank', 'dashboard'];
const SIZES = [[1280, 720, 1.25], [1024, 576, 1.25], [1366, 768, 1]];

test('no Payroll screen scrolls sideways, and pills / buttons in tables stay on one line', async t => {
  if (!browser) return t.skip(why);
  for (const [w, h, dpr] of SIZES) {
    const { p, ctx } = await page(w, h, dpr);
    for (const v of VIEWS) {
      await p.goto(`${B}/staff#/${v}`); await p.waitForSelector('#app:not(.hidden)'); await p.waitForTimeout(500);
      const r = await p.evaluate(() => {
        const de = document.documentElement, wraps = [];
        document.querySelectorAll('table.t td .status, table.t td .chip, table.t td .pill, table.t td .btn, table.t td button').forEach(el => {
          if (!el.offsetParent || !el.textContent.trim()) return;
          const one = el.offsetHeight, ws = el.style.whiteSpace; el.style.whiteSpace = 'nowrap';
          const single = el.offsetHeight; el.style.whiteSpace = ws;
          if (one !== single) wraps.push(el.textContent.trim().slice(0, 40));
        });
        return { side: de.scrollWidth - de.clientWidth, wraps };
      });
      assert.ok(r.side <= 0, `${v} at ${w}x${h}: the page scrolls sideways by ${r.side}px`);
      assert.deepEqual(r.wraps, [], `${v} at ${w}x${h}: wrapped onto two lines`);
    }
    await ctx.close();
  }
});

test('Staff: a row\'s ⋯ menu opens, has its actions, works with the keyboard, and closes with Esc', async t => {
  if (!browser) return t.skip(why);
  const { p, ctx } = await page(1280, 720, 1.25);
  await p.goto(`${B}/staff#/employees`); await p.waitForSelector('.rm-btn');
  const btn = p.locator('tr', { hasText: 'Alex Sample' }).locator('.rm-btn');
  assert.match(await btn.getAttribute('aria-label'), /Actions for Alex Sample/);
  await btn.click();
  assert.equal(await btn.getAttribute('aria-expanded'), 'true');
  const menu = p.locator('.rm-list:not([hidden])');
  assert.equal(await menu.count(), 1);
  assert.deepEqual(await menu.locator('[role=menuitem]').allTextContents(), ['Edit details…', 'Access…', 'Finish employment…']);
  assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Edit details…');
  await p.keyboard.press('ArrowDown');
  assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Access…');
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('.rm-list:not([hidden])').count(), 0);
  assert.equal(await btn.getAttribute('aria-expanded'), 'false');
  assert.equal(await p.evaluate(() => document.activeElement.classList.contains('rm-btn')), true);
  // Access… opens the same Access window as before
  await btn.click(); await p.locator('.rm-list:not([hidden]) [data-acc]').click();
  await p.waitForSelector('.modal-bg');
  assert.equal(await p.locator('.rm-list:not([hidden])').count(), 0);
  await ctx.close();
});
