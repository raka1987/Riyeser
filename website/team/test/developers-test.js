// riyeser.com/developers/ (the API, webhooks and booking widget docs, from website/developers.mjs): every page renders
// with the site's header, footer and Content-Security-Policy and nothing is refused; the owner's intro; every endpoint
// with curl and JavaScript; the errors table; idempotency and limits; webhook signatures in Node and PHP with the known
// answer (checked here too); the widget page's live preview (sample data) under the site's CSP; copy buttons; links from
// the footer and the Riyeser Link help; the sitemap; no sideways scrolling at 390.
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/developers-test.js <shots>`.
const { chromium } = require('playwright');
const crypto = require('crypto');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const out = process.argv[2] || '.';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (path, w = 1280) => {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 } }); await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    const pg = await ctx.newPage(); const refused = [];
    pg.on('pageerror', (e) => errs.push(path + ': ' + e.message));
    pg.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) refused.push(m.text().slice(0, 160)); });
    await pg.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline'))); });
    const r = await pg.goto(BASE + path); pg.status = r.status(); await pg.waitForTimeout(400);
    pg.refused = async () => [...refused, ...(await pg.evaluate(() => window.__csp))];
    return pg;
  };
  const pages = ['/developers/', '/developers/api.html', '/developers/webhooks.html', '/developers/widget.html'];
  for (const path of pages) {
    const pg = await open(path);
    const meta = await pg.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content).catch(() => '');
    const info = await pg.evaluate(() => ({ h1: (document.querySelector('h1') || {}).textContent, nav: [...document.querySelectorAll('.hside > a')].map((a) => a.textContent), on: (document.querySelector('.hside a.on') || {}).textContent,
      code: document.querySelectorAll('.dcode').length, foot: !!document.querySelector('footer a[href$="developers/"]') }));
    check(pg.status === 200 && info.h1 && info.nav.join('|') === 'Overview|API reference|Webhooks|Booking widget' && info.foot, `${path}: renders "${info.h1}" (${info.code} examples), the docs menu, Developers in the footer`);
    check(/script-src 'self'/.test(meta) && !(await pg.refused()).length, `${path}: the site's CSP, nothing refused ${(await pg.refused()).join(' | ')}`);
    if (path === '/developers/') {
      const t = await pg.innerText('main');
      check(/send it to your web developer/.test(t) && /Management → Connections/.test(t), 'overview: the business owner\'s intro');
      check(/rk_live_…/.test(t) && /rk_pub_live_…/.test(t) && /Authorization/.test(t) && /Test mode/.test(t), 'overview: keys, auth header, test mode');
      await pg.click('.dcode .dcopy'); await pg.waitForFunction(() => document.querySelector('.dcopy').textContent === 'Copied');
      check(/^GET \/functions\/v1\/api\/v1\/ping/.test(await pg.evaluate(() => navigator.clipboard.readText())), 'a copy button copies its example');
      await pg.screenshot({ path: out + '/dev-overview.png', fullPage: true });
    }
    if (path === '/developers/api.html') {
      const ends = await pg.$$eval('.dend', (x) => x.map((e) => e.id));
      check(ends.join() === 'ping,bookings,orders,enquiries,customers,quotes,payments,events,catalog,prices,stock,availability,slots', 'api: every endpoint ' + ends.join(' '));
      const each = await pg.$$eval('.dend', (x) => x.every((e) => [...e.querySelectorAll('.dlab span')].map((s) => s.textContent).filter((l) => l === 'curl' || l === 'JavaScript').length === 2));
      check(each, 'api: curl and JavaScript for each');
      const t = await pg.innerText('main');
      check(['slot_not_available', 'idempotency_conflict', 'plan_required', 'origin_not_allowed', 'invalid_payload', 'rate_limited', 'Retry-After', 'Idempotency-Key', '120 requests a minute', '20 000 requests a day'].every((s) => t.includes(s)), 'api: errors, idempotency, rate limits');
      check(/-H "Idempotency-Key: web-booking-1042"/.test(t) && /goaugynxeatzqzifpoes\.supabase\.co\/functions\/v1\/api\/v1\/bookings/.test(t), 'api: the base address and Idempotency-Key in the examples');
      await pg.screenshot({ path: out + '/dev-api.png' });
    }
    if (path === '/developers/webhooks.html') {
      const t = await pg.innerText('main');
      const v1 = crypto.createHmac('sha256', 'whsec_test').update('1700000000.{"id":"1"}').digest('hex');
      check(t.includes(v1), 'webhooks: the known answer is right (' + v1.slice(0, 12) + '…)');
      const labs = await pg.$$eval('.dlab span', (x) => x.map((s) => s.textContent));
      check(labs.includes('Node.js') && labs.includes('PHP') && /timingSafeEqual/.test(t) && /hash_equals/.test(t), 'webhooks: Node and PHP signature checks (constant time)');
      check(['booking.received', 'order.ready', 'stock.changed', 'ping', 'Riyeser-Signature', '1, 5 and 30 minutes'].every((s) => t.includes(s)), 'webhooks: events, headers, retries');
      // the Node example's check really works
      const node = await pg.$$eval('.dcode', (x) => x.find((d) => d.querySelector('.dlab span').textContent === 'Node.js').querySelector('code').textContent);
      check(/createHmac\("sha256", SECRET\)\.update\(`\$\{parts\.t\}\.\$\{req\.body\}`\)/.test(node), 'webhooks: the Node example signs "<t>.<raw body>"');
    }
    if (path === '/developers/widget.html') {
      await pg.waitForFunction(() => { const h = document.querySelector('#demo .riyeser-widget'); return h && h.shadowRoot.querySelectorAll('[data-svc]').length === 3; }, null, { timeout: 8000 });
      await pg.locator('#demo .riyeser-widget [data-svc=CUT]').click(); await pg.locator('#demo .riyeser-widget [data-staff=""]').click(); await pg.locator('#demo .riyeser-widget .times').waitFor();
      check(!(await pg.refused()).length, 'widget: the live preview works under the site\'s CSP (script, shadow DOM styles)');
      const t = await pg.innerText('main');
      check(/data-key="rk_pub_live_/.test(t) && /https:\/\/riyeser\.com\/widget\/book\.js/.test(t) && /data-type="order"/.test(t) && /connect-src 'self' https:\/\/goaugynxeatzqzifpoes\.supabase\.co/.test(t), 'widget: embed, order button and CSP advice');
      await pg.screenshot({ path: out + '/dev-widget.png', fullPage: true });
    }
    await pg.context().close();
  }
  // phones
  for (const path of pages) {
    const pg = await open(path, 390);
    const wide = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(wide <= 1, `${path} at 390: no sideways scrolling (${wide})`);
    if (path === '/developers/api.html') await pg.screenshot({ path: out + '/dev-api-phone.png' });
    await pg.context().close();
  }
  // links in: the footer everywhere, the Riyeser Link help, the sitemap
  { const pg = await open('/help/link.html'); const t = await pg.innerText('main');
    check(/Connect your website to Riyeser/.test(t) && /API keys: make, change and revoke/.test(t) && /What happens when a booking comes in/.test(t) && /Webhooks: tell your other systems/.test(t), 'help: Connections entries in the Riyeser Link guide');
    check(await pg.$$eval('main a[href$="developers/"], main a[href$="developers/widget.html"], main a[href$="developers/webhooks.html"]', (x) => x.length) >= 3, 'help: links to the developer docs');
    check(!!(await pg.$('#connections')), 'help: /help/link.html#connections (the link from Connections) is there');
    await pg.context().close(); }
  { const pg = await open('/sitemap.xml'); const t = await pg.content(); check(/developers\/<\/loc>/.test(t) && /developers\/widget\.html/.test(t), 'sitemap: the developer pages'); await pg.context().close(); }
  { const pg = await open('/widget/book.js'); const t = await pg.evaluate(() => document.body.innerText);
    check(pg.status === 200 && t.includes('https://goaugynxeatzqzifpoes.supabase.co/functions/v1/api') && !t.includes('__RIYESER_API__'), 'widget/book.js is served with the API address filled in');
    check(t.length < 32000, `widget/book.js is small (${t.length} bytes, no dependencies)`); await pg.context().close(); }
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} DEVELOPER DOCS CHECKS FAILED` : 'ALL DEVELOPER DOCS CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
