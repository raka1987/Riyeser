// Every app's main screens at 1280 wide (Windows 125% scaling) with the demo company: the page never scrolls
// sideways, and status pills and row buttons in table cells stay on one line.
//   python tests/browser/serve_demo.py 8095 invoices &   (one server per app)
//   APPS='{"invoices":"http://127.0.0.1:8095"}' node tests/browser/layout.e2e.js
const { chromium } = require('playwright');

const APPS = JSON.parse(process.env.APPS || '{"plus":"http://127.0.0.1:8095"}');
const SCREENS = {
  basics: ['/', '/sale/list', '/cards/customer', '/expenses/', '/inventory/', '/inventory/low-stock', '/reports/', '/online/', '/online/settings', '/users', '/setup/company'],
  plus: ['/', '/sale/list', '/purchase/list', '/cards/customer', '/expenses/', '/inventory/', '/inventory/low-stock', '/banking/', '/journal', '/accounts', '/setup/tax-codes', '/online/', '/users'],
  invoices: ['/', '/sale/list', '/sale/list?status=quote', '/cards/customer', '/sale/new', '/online/', '/online/settings'],
  bookings: ['/bookings/', '/bookings/week', '/bookings/list', '/bookings/jobs', '/bookings/site', '/cards/customer', '/online/'],
  pos: ['/pos/', '/pos/sales', '/pos/sales/all', '/pos/approvals', '/today', '/cards/customer', '/inventory/', '/inventory/low-stock'],
  estimate: ['/estimate/', '/estimate/1/customer', '/estimate/1/how', '/estimate/1/price', '/estimate/quotes', '/estimate/templates', '/cards/customer'],
};
// screens reached from a list: the first row's page
const FIRST = { '/cards/customer': 'tr[data-href*="/cards/view/"]', '/sale/list': 'tr[data-href*="/document/"]' };

let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

function inspect() {
  const out = { sideways: document.documentElement.scrollWidth - window.innerWidth, wrapped: [] };
  const one = (e) => {   // the element's text sits on one line
    const lh = parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.4;
    const bottoms = []; const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (q.width > 1) bottoms.push(q.bottom);
    }
    return !bottoms.length || Math.max(...bottoms) - Math.min(...bottoms) <= lh * 0.6;
  };
  document.querySelectorAll('td .badge, td .pill, td .bk-st, td .st, td .btn, td button, th').forEach((e) => {
    const b = e.getBoundingClientRect();
    if (!b.width || e.closest('.wrap') || e.querySelector('br, div, small')) return;
    if (!one(e)) out.wrapped.push(e.tagName.toLowerCase() + '.' + [...e.classList].join('.') + ' "' + e.innerText.trim().slice(0, 40) + '"');
  });
  return out;
}

(async () => {
  const browser = await chromium.launch();
  for (const [app, base] of Object.entries(APPS)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.25 });
    const pg = await ctx.newPage(); const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(base + '/login');
    await pg.fill('input[name=username]', 'admin'); await pg.fill('input[name=password]', 'admin');
    await Promise.all([pg.waitForNavigation(), pg.press('input[name=password]', 'Enter')]);
    const urls = [...SCREENS[app]];
    for (const [list, sel] of Object.entries(FIRST)) {
      if (!urls.includes(list)) continue;
      await pg.goto(base + list); const row = await pg.$(sel);
      if (row) urls.push(await row.getAttribute('data-href'));
    }
    for (const u of urls) {
      const res = await pg.goto(base + u, { waitUntil: 'load' });
      if (!res || res.status() >= 400) { check(false, `${app} ${u}: opens (${res && res.status()})`); continue; }
      const r = await pg.evaluate(inspect);
      check(r.sideways <= 1, `${app} ${u}: no sideways scroll (${r.sideways}px)`);
      check(!r.wrapped.length, `${app} ${u}: pills, buttons and headers in tables on one line${r.wrapped.length ? ': ' + r.wrapped.slice(0, 3).join(' | ') : ''}`);
    }
    check(!errs.length, `${app}: no script errors${errs.length ? ': ' + errs[0] : ''}`);
    await ctx.close();
  }
  await browser.close();
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
