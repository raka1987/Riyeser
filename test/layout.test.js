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

// ------------------------------------------------------------------ OWNER-BULKROSTER (Payroll 2.4.0): the Roster's bulk tools
// a week well after the demo's own roster, emptied first
const emptyWeek = p => p.evaluate(async () => { const W = await api(`/api/staff/roster?week=${addDays(today(), 28)}`); await api('/api/staff/roster/bulk', { body: { action: 'clear', cells: [null, ...W.people.map(x => x.id)].flatMap(u => W.days.map(d => ({ user_id: u, date: d }))) } }).catch(() => {}); return renderRoster({ week: W.week_start }); });
const rosterCount = async (p, weeks) => p.evaluate(async w => { const W = await api(`/api/staff/roster?week=${addDays(today(), 7 * w)}`); return W.people.reduce((t, x) => t + x.shifts.filter(s => !s.deleted).length, 0) + W.open.filter(s => !s.deleted).length; }, weeks);
test('Roster: select many days (a name, a day heading, drag, keyboard), apply a shift template once, undo with Ctrl+Z', async t => {
  if (!browser) return t.skip(why);
  const { p, ctx } = await page(1366, 768, 1);
  await p.goto(`${B}/staff#/roster`); await p.waitForSelector('.ro-grid[role=grid]');
  await emptyWeek(p); await p.waitForTimeout(300);
  assert.equal(await rosterCount(p, 4), 0);
  const row = n => p.locator(`tbody tr[data-row]:nth-child(${n})`);
  // a name: that person's week; Ctrl + a day heading: everyone that day as well
  await row(2).locator('th.ro-p').click();
  assert.equal(await p.locator('.ro-cell.sel').count(), 7);
  await p.locator('thead th[data-col]').nth(2).click({ modifiers: ['Control'] });
  const people = await p.locator('tbody tr[data-row]').count();
  assert.equal(await p.locator('.ro-cell.sel').count(), 7 + people - 1);
  assert.match(await p.locator('#ro-bulk .ro-bb-n').textContent(), new RegExp(`${7 + people - 1} days`));
  // Esc: nothing; then drag across days from one + to another (2 people × 3 days)
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('.ro-cell.sel').count(), 0);
  const a = await row(2).locator('td[data-d]').nth(0).locator('.ro-add').boundingBox(), b = await row(3).locator('td[data-d]').nth(2).locator('.ro-add').boundingBox();
  await p.mouse.move(a.x + 5, a.y + 5); await p.mouse.down(); await p.mouse.move(b.x + 5, b.y + 5, { steps: 6 }); await p.mouse.up();
  assert.equal(await p.locator('.ro-cell.sel').count(), 6);
  assert.match(await p.locator('#ro-bulk .ro-bb-n').textContent(), /6 days · 2 rows × 3 days/);
  assert.equal(await p.evaluate(() => getSelection().toString()), '', 'no text highlighted while dragging');
  // the keyboard: Shift+→ makes the block a day wider; Space adds one more day
  await row(3).locator('td[data-d]').nth(2).focus();
  await p.keyboard.press('Shift+ArrowRight');
  assert.equal(await p.locator('.ro-cell.sel').count(), 8);
  await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight'); await p.keyboard.press(' ');
  assert.equal(await p.locator('.ro-cell.sel').count(), 9);
  // one click on a shift template puts it on all 9 days; the summary says so and has Undo
  const t0 = await p.locator('#ro-bulk [data-bb-t]:not([hidden])').first();
  await t0.click(); await p.waitForSelector('.ro-flash');
  assert.match(await p.locator('.ro-flash').textContent(), /added 9 shifts/);
  assert.equal(await rosterCount(p, 4), 9);
  assert.equal(await p.locator('.ro-grid .ro-shift.tpl').count(), 9);
  // Ctrl+Z: undone
  await p.locator('h1, .topbar').first().click(); await p.keyboard.press('Control+z'); await p.waitForTimeout(600);
  assert.equal(await rosterCount(p, 4), 0);
  await ctx.close();
});

test('Roster on a phone: "Select" shows tick boxes; tick two people, apply a template, Undo from the summary', async t => {
  if (!browser) return t.skip(why);
  const { p, ctx } = await page(390, 844, 2);
  await p.goto(`${B}/staff#/roster`); await p.waitForSelector('.ro-phone');
  await emptyWeek(p); await p.waitForTimeout(300);
  await p.click('#ro-selmode'); await p.waitForSelector('.ro-pck');
  const ticks = p.locator('.ro-pck'); await ticks.nth(1).check(); await ticks.nth(2).check();
  assert.match(await p.locator('#ro-bulk .ro-bb-n').textContent(), /2 days/);
  const r = await p.evaluate(() => ({ side: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  assert.ok(r.side <= 0, `the phone roster scrolls sideways by ${r.side}px`);
  await p.locator('#ro-bulk [data-bb-t]').first().click(); await p.waitForSelector('.ro-flash');
  assert.equal(await rosterCount(p, 4), 2);
  await p.locator('.ro-flash [data-ro-undo]').click(); await p.waitForTimeout(600);
  assert.equal(await rosterCount(p, 4), 0);
  await ctx.close();
});

test('Staff: former staff are hidden by default, with "+1 former staff hidden" and Show / Hide former staff', async t => {
  if (!browser) return t.skip(why);
  const { p, ctx } = await page(1280, 720, 1.25);
  await p.goto(`${B}/staff#/employees`); await p.waitForSelector('.lv-bar');
  // someone who has left
  await p.evaluate(async () => { const e = await api('/api/staff/employees', { body: { name: 'Lee Former', username: 'leeformer', password: 'formerpass1', role: 'staff', pay_type: 'hourly', pay_rate: 10 } }); await api(`/api/staff/employees/${e.id}`, { method: 'PUT', body: { active: false } }); });
  await p.evaluate(() => renderEmployees()); await p.waitForSelector('[data-former]');
  assert.equal(await p.locator('tr', { hasText: 'Lee Former' }).count(), 0);
  assert.match(await p.locator('.lv-bar').textContent(), /\+1 former staff hidden/);
  assert.equal(await p.locator('[data-lv-sel="status"]').inputValue(), 'current');
  assert.equal(await p.locator('.lv-clear').isDisabled(), true, 'the default is not a filter to clear');
  await p.click('[data-former]');
  assert.equal(await p.locator('tr', { hasText: 'Lee Former' }).count(), 1);
  assert.equal(await p.locator('[data-former]').textContent(), 'Hide former staff');
  // remembered: still shown after coming back
  await p.evaluate(() => renderEmployees()); await p.waitForSelector('.lv-bar');
  assert.equal(await p.locator('tr', { hasText: 'Lee Former' }).count(), 1);
  await p.click('[data-former]');
  assert.equal(await p.locator('tr', { hasText: 'Lee Former' }).count(), 0);
  // not on the roster or the time clock lists
  await p.goto(`${B}/staff#/roster`); await p.waitForSelector('.ro-grid');
  assert.equal(await p.locator('.ro-grid tr', { hasText: 'Lee Former' }).count(), 0);
  await ctx.close();
});
