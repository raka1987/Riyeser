// Riyeser HQ layout check (demo data): every page of the current HQ and of HQ V2 (?v2=1), at 1280, 1366, 1440, 1920
// and 390 px wide. On each page it checks that
//   - nothing scrolls sideways (the page itself, or any box in it), except wide data tables marked data-wide;
//   - no box has its own inner vertical scrollbar (menus, dialogs and the left-hand menu excepted);
//   - no text is cut off (an element with its own text whose scrollWidth is wider than its box) or squeezed into a sliver;
//   - cards side by side in one row are the same height (within 1 px);
//   - row menus (⋯ / ▾) open fully inside the window and aren't hidden behind a scrolling box;
//   - on the Overview, the count cards still fit with big figures (US$64,512.50) and long captions;
//   - HQ team: the Roles tab, a role's checklist, a new role and a person's role and ticks (custom roles) pass the same checks.
// Run: build the site, serve website/public on port 8090 (or set HQ_URL), then `node website/hq/test-hq-layout.js [screenshot folder]`.
// LAYOUT_WIDTHS=1280,390 and LAYOUT_ONLY=overview,companies narrow it down. Exits 1 on failure.
const { chromium } = require('playwright');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
const WIDTHS = (process.env.LAYOUT_WIDTHS || '1280,1366,1440,1920,390').split(',').map(Number);
const ONLY = process.env.LAYOUT_ONLY ? process.env.LAYOUT_ONLY.split(',') : null;
const CUR = ['overview', 'companies', 'signups', 'licences', 'approvals', 'refunds', 'payments', 'support', 'inbox', 'inactive', 'health', 'emails',
  'downloads', 'reports', 'traffic', 'team', 'history', 'settings', 'test-accounts',
  ...['overview', 'programs', 'pcs', 'people', 'conversations', 'money', 'history', 'link'].map((t) => `company/w1/${t}`)];
const V2 = ['overview', 'queue', 'reports', 'companies', 'signups', 'inactive', 'traffic', 'licences', 'payments', 'refunds', 'downloads', 'support', 'health',
  'integrations', 'emails', 'team', 'security', 'history', 'approvals', 'settings', 'test-accounts', 'states', 'notifications', 'company/w1/overview', 'company/w1/programs', 'company/w1/money'];

// Runs in the page: what's wrong with the layout right now.
function audit() {
  const out = [];
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; }
    return true; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
  const where = (el) => { const p = []; for (let e = el; e && p.length < 3 && e.id !== 'main'; e = e.parentElement) p.unshift(name(e)); return p.join(' > '); };
  const skip = (el) => el.closest('aside, nav, .side, .snav, .modal, .ddm, .mem2, .mmenu, .panel, .pnl, textarea, select, input, svg, .sr, [aria-hidden=true], .demo, .bars, .bars2');
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} px in a ${innerWidth} px window)`);
  const all = [...document.querySelectorAll('#app *, #v2 *')];
  for (const el of all) {
    if (skip(el) || !shown(el)) continue;
    const cs = getComputedStyle(el);
    if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && !el.closest('[data-wide]')) out.push('sideways scrollbar: ' + where(el));
    if (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && !el.closest('[data-vscroll]')) out.push('inner scrollbar: ' + where(el));
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own && cs.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && !el.closest('[data-wide]')) out.push(`text cut off: ${where(el)} "${el.textContent.trim().slice(0, 40)}"`);
    // text squeezed into a sliver (a heading broken letter by letter)
    if (own && cs.display !== 'inline' && el.textContent.trim().length > 24 && el.getBoundingClientRect().width < 90 && el.getBoundingClientRect().height > 90) out.push(`text squeezed into a narrow column: ${where(el)} "${el.textContent.trim().slice(0, 40)}"`);
  }
  // table rows line up: in a table shown as a table, every cell is a table cell (a cell turned into a flex box breaks the row lines)
  for (const t of all.filter((el) => el.tagName === 'TABLE' && !skip(el) && shown(el) && getComputedStyle(el).display === 'table')) {
    const odd = [...t.querySelectorAll(':scope > tbody > tr > *, :scope > thead > tr > *, :scope > tr > *')].filter((c) => shown(c) && getComputedStyle(c).display !== 'table-cell');
    if (odd.length) out.push(`table cells out of line (${odd.length}, e.g. ${name(odd[0])}): ${where(t)}`);
  }
  // cards side by side: the same height
  const CARD = '.ccard, .tile, .aitem, .card, .card2, .kpi2, .kc2, .rcard2, .mcard2';
  const parents = new Set(all.filter((el) => el.matches(CARD) && !skip(el) && shown(el)).map((el) => el.parentElement));
  for (const p of parents) {
    const kids = [...p.children].filter((k) => k.matches(CARD) && shown(k)); if (kids.length < 2) continue;
    const rows = {}; kids.forEach((k) => { const t = Math.round(k.getBoundingClientRect().top); (rows[t] = rows[t] || []).push(k); });
    Object.values(rows).filter((r) => r.length > 1).forEach((r) => { const h = r.map((k) => k.getBoundingClientRect().height);
      if (Math.max(...h) - Math.min(...h) > 1) out.push(`cards in one row differ in height (${h.map(Math.round).join('/')}): ${where(p)}`); });
  }
  return [...new Set(out)];
}
// Opens the first and the last row menu on the page and checks each fits in the window and is on top.
async function menus(pg) {
  const bad = []; const n = await pg.evaluate(() => [...document.querySelectorAll('#main details.dd, #main2 details.dd, main details.dd')].filter((d) => d.getBoundingClientRect().width > 0).length);
  for (const i of [...new Set([0, n - 1])].filter((x) => x >= 0)) {
    const r = await pg.evaluate(async (i) => {
      const d = [...document.querySelectorAll('#main details.dd, #main2 details.dd, main details.dd')].filter((x) => x.getBoundingClientRect().width > 0)[i]; if (!d) return null;
      d.scrollIntoView({ block: 'center' }); await new Promise((ok) => setTimeout(ok, 50));
      const before = document.documentElement.scrollWidth;
      d.querySelector('summary').click(); await new Promise((ok) => setTimeout(ok, 150));
      const m = d.querySelector('.ddm'); if (!m) { d.open = false; return null; }
      const b = m.getBoundingClientRect(); const pts = [[b.left + 4, b.top + 4], [b.right - 4, b.top + 4], [b.left + 4, b.bottom - 4], [b.right - 4, b.bottom - 4]];
      const covered = pts.filter(([x, y]) => { const e = document.elementFromPoint(x, y); return !e || !m.contains(e); }).length;
      let scrollers = 0; for (let e = d.parentElement; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e);
        if ((/auto|scroll/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) || (/auto|scroll/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1 && !e.closest('[data-wide]'))) scrollers++; }
      const res = { label: d.querySelector('summary').textContent.trim() || d.querySelector('summary').getAttribute('aria-label'), in: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
        covered, scrollers, wider: document.documentElement.scrollWidth > Math.max(before, innerWidth) + 1 };
      d.querySelector('summary').click(); await new Promise((ok) => setTimeout(ok, 50)); d.open = false; return res; }, i);
    if (r && (!r.in || r.covered || r.scrollers || r.wider)) bad.push(`menu "${r.label}" ${!r.in ? 'goes outside the window ' : ''}${r.covered ? 'is hidden behind something ' : ''}${r.scrollers ? 'sits in a scrolling box ' : ''}${r.wider ? 'makes the page scroll sideways' : ''}`.trim());
  }
  return bad;
}
(async () => {
  const b = await chromium.launch(); const shots = process.argv[2]; const fails = []; let checked = 0;
  for (const w of WIDTHS) {
    for (const [v2, list] of [[false, CUR], [true, V2]]) {
      const pg = await b.newPage({ viewport: { width: w, height: w < 600 ? 844 : 900 } }); const errs = [];
      pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.dismiss());
      await pg.goto(`${BASE}/hq/?demo${v2 ? '&v2=1' : '&v2=0'}#/overview`); await pg.waitForSelector(v2 ? '#v2' : '.snav', { state: 'attached' });
      for (const p of list) {
        if (ONLY && !ONLY.includes(p.split('/')[0])) continue;
        await pg.evaluate((h) => { location.hash = h; window.scrollTo(0, 0); }, '#/' + p); await pg.waitForTimeout(p === 'downloads' || p === 'traffic' ? 1500 : 700);
        await pg.evaluate(() => document.querySelectorAll('details[open]').forEach((d) => { d.open = false; }));
        const bad = [...(await pg.evaluate(audit)), ...(await menus(pg))]; checked++;
        // the count cards with a big live figure and a long caption (the owner saw "US$64.5(" cut off): still fits, same heights
        if (!v2 && p === 'overview') {
          await pg.evaluate(() => document.querySelectorAll('.ccards .ccard').forEach((c, i) => { c.querySelector('.v').textContent = ['1,284', '12', 'US$64,512.50', '318', '1,027'][i % 5];
            const d = c.querySelector('.d'); if (d) d.textContent = '12 payments in the last 7 days, including 3 bank transfers'; }));
          (await pg.evaluate(audit)).forEach((x) => bad.push('with big figures: ' + x));
          bad.push(...(await pg.evaluate(() => [...document.querySelectorAll('.ccards .ccard .v')].filter((v) => v.scrollWidth > v.clientWidth + 1 || v.getBoundingClientRect().right > v.closest('.ccard').getBoundingClientRect().right).map((v) => 'figure cut off: ' + v.textContent))));
        }
        // HQ team: the custom roles views (Roles tab, a role's checklist, a person's role and ticks) get the same checks
        if (!v2 && p === 'team' && await pg.$('[data-tt=roles]')) {
          for (const [k, go] of [['roles', async () => { await pg.click('[data-tt=roles]'); await pg.waitForSelector('#roles'); }],
            ['role', async () => { await pg.click('[data-roleopen=finance]'); await pg.waitForSelector('#rlf'); }],
            ['new-role', async () => { await pg.click('#rlCancel'); await pg.waitForSelector('#roles'); await pg.click('#rlNew'); await pg.waitForSelector('#rlf'); }],
            ['person', async () => { await pg.click('#rlCancel'); await pg.waitForSelector('#roles'); await pg.click('[data-tt=people]'); await pg.waitForSelector('#staff');
              await pg.click('[data-access=s2]'); await pg.waitForSelector('[data-pa=s2]'); }]]) {
            await go(); await pg.waitForTimeout(300); await pg.evaluate(() => window.scrollTo(0, 0)); checked++;
            const rb = [...(await pg.evaluate(audit)), ...(await menus(pg))];
            rb.forEach((x) => bad.push(`${k}: ${x}`));
          }
          await pg.click('#ttBack').catch(() => {}); await pg.waitForTimeout(200);
        }
        bad.forEach((x) => fails.push(`${v2 ? 'v2 ' : ''}${p} @${w}: ${x}`));
        if (shots && bad.length) await pg.screenshot({ path: `${shots}/layout-${v2 ? 'v2-' : ''}${p.replace(/\//g, '-')}-${w}.png`, fullPage: true });
      }
      errs.forEach((e) => fails.push(`${v2 ? 'v2' : 'current'} @${w}: page error ${e}`));
      await pg.close();
    }
  }
  await b.close();
  console.log(`${checked} page views checked`);
  console.log(fails.length ? 'HQ LAYOUT TEST FAILED:\n- ' + fails.join('\n- ') : 'HQ LAYOUT TEST PASSED'); if (fails.length) process.exitCode = 1;
})();
