// The website's Content-Security-Policy (a <meta> on every page built by build.mjs): nothing on the pages is refused,
// and what they do still works: the phone menu, the price calculator and its Buy links, the Help Centre search,
// "Sign in" to Riyeser Link, fonts and images; an injected inline script is refused.
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/csp-test.js`. Exits 1 on failure.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (path, w = 1280) => {
    const pg = await b.newPage({ viewport: { width: w, height: 900 } }); const refused = [];
    pg.on('pageerror', (e) => errs.push(path + ': ' + e.message));
    pg.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) refused.push(m.text().slice(0, 140)); });
    await pg.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline'))); });
    await pg.goto(BASE + path); await pg.waitForTimeout(500);
    pg.refused = async () => [...refused, ...(await pg.evaluate(() => window.__csp))];
    return pg;
  };
  const pages = ['/index.html', '/pricing.html', '/programs.html', '/downloads.html', '/help.html', '/help/link.html', '/programs/payroll.html', '/terms.html'];
  for (const path of pages) {
    const pg = await open(path);
    const meta = await pg.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content).catch(() => '');
    check(/default-src 'self'/.test(meta) && /script-src 'self' 'sha256-/.test(meta) && !/unsafe-inline'[^;]*;?\s*style/.test(meta.split('script-src')[1].split(';')[0]), `${path}: has the policy (scripts by hash only)`);
    const fonts = await pg.evaluate(() => document.fonts.status);
    const imgs = await pg.$$eval('img', (x) => x.filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0 && i.getAttribute('loading') !== 'lazy').map((i) => i.src));
    const r = await pg.refused();
    check(!r.length && fonts === 'loaded' && !imgs.length, `${path}: nothing refused, fonts and images load ${r.join(' | ')} ${imgs.join(' ')}`);
    await pg.close();
  }
  // what the pages do still works
  { const pg = await open('/pricing.html');
    await pg.check('[data-m=plus]'); await pg.fill('#users', '5'); await pg.dispatchEvent('#users', 'input');
    check((await pg.textContent('#total')) === 'US$53 a month' && /add=plus&users=5/.test(await pg.getAttribute('#calcpay', 'href')), 'pricing: the calculator works (Plus, 5 people = US$53)');
    const bad = await pg.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__ran = 1'; document.body.appendChild(s); return window.__ran === 1; });
    check(!bad, 'an injected inline script is refused');
    await pg.close(); }
  { const pg = await open('/index.html', 390);
    await pg.click('#nav .menu'); check(await pg.evaluate(() => document.getElementById('nav').classList.contains('open')) && await pg.getAttribute('#nav .menu', 'aria-expanded') === 'true', 'phone menu opens (no inline onclick)');
    check(!(await pg.refused()).length, 'phone menu: nothing refused'); await pg.close(); }
  { const pg = await open('/help.html');
    await pg.fill('#hq', 'password'); await pg.dispatchEvent('#hq', 'input'); await pg.waitForTimeout(200);
    const first = await pg.$eval('#hres a', (a) => a.href).catch(() => null);
    await pg.click('.hsearch-wrap .go'); await pg.waitForTimeout(500);
    check(!!first && pg.url() === first, `Help Centre search: the search button opens the first result (${first})`);
    await pg.close(); }
  { const pg = await open('/index.html');
    await pg.click('.right .signin'); await pg.waitForSelector('#gf', { timeout: 8000 });
    check(pg.url().includes('/link/'), 'Sign in goes to Riyeser Link (its page has no meta policy: Supabase, PayPal and calls are set by config)');
    await pg.close(); }
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} CSP CHECK(S) FAILED` : 'ALL CSP CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
