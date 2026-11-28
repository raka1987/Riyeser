// The booking widget (riyeser.com/widget/book.js) on someone else's website, against a pretend Riyeser API that answers
// CORS like the real one (Access-Control-Allow-Origin only for the key's websites; nothing for refused keys).
// Three origins: the widget script from the site (LINK_BASE, 8090), a business's website (8093, on the key) and another
// website (8095, not on the key); the API on 8094.
//  1. Book a slot: service → staff → day → time → details → "Booking request sent" → "Booking confirmed" (GET /v1/events).
//     The request: Bearer widget key, a UUID Idempotency-Key, start exactly as given, no cookies; nothing else is loaded.
//  2. Idempotent retry: the connection drops after the API took the booking → "Couldn't reach…" → Try again sends the
//     same Idempotency-Key and gets the first answer back (200, Idempotent-Replayed): one booking, not two.
//  3. No free time (this week and next). 4. The time just went (409 slot_not_available): fresh times.
//  5. Errors in plain words: plan (402), too many tries (429), a field the API refused (422), the widget on a website
//     that isn't on the key (no CORS: "Couldn't reach the booking system").
//  6. Enquiry form and the order button (an order request). 7. Light and dark, data-accent, phone width (no sideways
//     scrolling at 390), keyboard only, labels. 8. No cookies or storage.
// Run: build the site, serve website/public on 8090, then `node website/team/test/widget-test.js <shots>`. Exits 1 on failure.
const { chromium } = require('playwright');
const http = require('http');
const assert = require('assert');
const SITE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const SHOP = 'http://127.0.0.1:8093'; const OTHER = 'http://127.0.0.1:8095'; const API = 'http://127.0.0.1:8094/functions/v1/api';
const KEY = 'rk_pub_test_' + 'a1'.repeat(24); const NOPLAN = 'rk_pub_test_' + 'b2'.repeat(24);
const out = process.argv[2] || '.';

// ---- the pretend API
const st = { posts: [], bookings: [], enquiries: [], idem: {}, drops: new Set(), seen: [] };
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function api(req, res) {
  const origin = req.headers.origin || ''; const u = new URL(req.url, 'http://x'); const path = u.pathname.replace('/functions/v1/api', '');
  st.seen.push({ method: req.method, path, origin, cookie: req.headers.cookie || '', auth: req.headers.authorization || '', idem: req.headers['idempotency-key'] || '' });
  const cors = (o) => ({ 'Access-Control-Allow-Origin': o, 'Access-Control-Expose-Headers': 'X-Request-Id, Idempotent-Replayed, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Location', Vary: 'Origin' });
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600' }); return res.end(); }
  const key = (req.headers.authorization || '').replace(/^Bearer /, '');
  const send = (status, body, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_' + st.seen.length, 'Cache-Control': 'no-store', ...(origin === SHOP ? cors(origin) : {}), ...extra }); res.end(JSON.stringify(body)); };
  const err = (status, code, message, extra, details) => send(status, { error: { code, message, ...(details ? { details } : {}) } }, extra);
  if (![KEY, NOPLAN].includes(key)) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":{"code":"invalid_key","message":"That key isn\'t right."}}'); }   // before the key is known: no CORS
  if (origin !== SHOP) return err(403, 'origin_not_allowed', 'This key can\'t be used from this website.');   // sent without CORS headers (origin isn't on the key)
  if (key === NOPLAN) return err(402, 'bookings_licence_required', 'Online bookings and open times need Riyeser Bookings (on its free trial or paid).');
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (req.method === 'GET' && path === '/v1/availability') return send(200, { timezone: 'Pacific/Fiji', slot_minutes: 30, min_notice_minutes: 60, days_ahead: 30, updated_at: new Date().toISOString(),
      services: [{ sku: 'CUT', name: 'Haircut', duration_minutes: 30, price: 35, currency: 'FJD' }, { sku: 'FULL', name: 'Colour <b>& style</b>', duration_minutes: 90, price: 120, currency: 'FJD' }],
      staff: [{ ref: 'amy', name: 'Amy', services: [] }, { ref: 'sam', name: 'Sam', services: ['FULL'] }], test: true });
    if (req.method === 'GET' && path === '/v1/availability/slots') {
      const svc = u.searchParams.get('service'); const from = u.searchParams.get('from');
      if (svc === 'FULL') return send(200, { timezone: 'Pacific/Fiji', service: svc, slots: [], test: true });
      const slots = []; for (let i = 1; i <= 3; i++) for (const t of ['09:00', '09:30', '14:00']) { const d = day(i); const start = new Date(`${d}T${t}:00+12:00`).toISOString(); slots.push({ start, end: new Date(Date.parse(start) + 1800e3).toISOString(), local_start: `${d}T${t}`, staff: ['amy'], capacity: 1 }); }
      st.slotAsks = (st.slotAsks || 0) + 1; st.lastFrom = from;
      return send(200, { timezone: 'Pacific/Fiji', service: svc, duration_minutes: 30, slots: st.taken ? slots.filter((s) => s.start !== st.taken) : slots, test: true });
    }
    if (req.method === 'GET' && path.startsWith('/v1/events/')) { const b = st.bookings.find((x) => x.id === path.split('/').pop()); return b ? send(200, { id: b.id, kind: 'booking', status: 'done', test: true, result: { reference: 'BK-1042', state: 'confirmed', message: 'See you then, ' + b.body.customer.name + '!' } }) : err(404, 'not_found', 'Not found'); }
    if (req.method === 'POST') {
      const kind = path === '/v1/bookings' ? 'booking' : path === '/v1/enquiries' ? 'enquiry' : null; if (!kind) return err(404, 'not_found', 'Not found');
      let j; try { j = JSON.parse(body); } catch { return err(400, 'invalid_json', 'Send JSON.'); }
      const idem = req.headers['idempotency-key'] || ''; st.posts.push({ kind, idem, body: j });
      if (!/^[A-Za-z0-9._:-]{1,100}$/.test(idem)) return err(400, 'invalid_idempotency_key', 'Bad Idempotency-Key.');
      const name = (j.customer || {}).name || '';
      if (st.idem[idem]) { if (st.idem[idem].sig !== JSON.stringify(j)) return err(409, 'idempotency_conflict', 'Different body.'); return send(200, st.idem[idem].answer, { 'Idempotent-Replayed': 'true', Location: '/v1/events/' + st.idem[idem].answer.id }); }
      if (name === 'Rate Me') return err(429, 'rate_limited', 'Too many requests.', { 'Retry-After': '30' });
      if (name === 'Too Late') { st.taken = j.start; return err(409, 'slot_not_available', 'That time is no longer free.'); }
      if (name === 'Bad Email') return err(422, 'invalid_payload', 'Some details need fixing.', {}, [{ field: 'customer.email', message: 'customer.email doesn\'t look like an email address.' }]);
      const answer = { id: '6f1c2a90-1d1e-4c55-9b7e-' + String(st.posts.length).padStart(12, '0'), kind, status: 'waiting', test: true, created_at: new Date().toISOString() };
      st.idem[idem] = { sig: JSON.stringify(j), answer }; (kind === 'booking' ? st.bookings : st.enquiries).push({ id: answer.id, body: j });
      if (name === 'Drop Once' && !st.drops.has(name)) {   // taken in, but the answer is cut off half way (the browser can't retry it by itself)
        st.drops.add(name); res.writeHead(202, { 'Content-Type': 'application/json', 'Content-Length': '400', ...cors(origin) }); res.write('{"id":"'); return setTimeout(() => req.socket.destroy(), 50); }
      return send(202, answer, { Location: '/v1/events/' + answer.id });
    }
    err(405, 'method_not_allowed', 'No.');
  });
}
// ---- the business's website, and another website
const pageHtml = (attrs, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sample Salon</title>
<style>body{font-family:Georgia,serif;margin:0;padding:16px;background:Canvas;color:CanvasText}h1{font-size:22px}</style><meta name="color-scheme" content="light dark"></head>
<body><h1>Book with Sample Salon</h1>${extra}<script src="${SITE}/widget/book.js" ${attrs}></script><p>Thanks for visiting.</p></body></html>`;
const site = (req, res) => { const u = new URL(req.url, 'http://x'); const a = `data-key="${u.searchParams.get('key') || KEY}" data-api="${API}" data-poll="300"`;
  const pages = { '/book': pageHtml(`${a} data-accent="#0f766e" async`), '/enquiry': pageHtml(`${a} data-type="enquiry" data-service="CUT"`),
    '/order': pageHtml(`${a} data-type="order" data-sku="CAKE-CHOC" data-name="Chocolate cake" data-price="45" data-currency="FJD"`), '/target': pageHtml(`${a} data-target="#here"`, '<div id="here">Loading the booking form…</div>') };
  res.writeHead(pages[u.pathname] ? 200 : 404, { 'Content-Type': 'text/html' }); res.end(pages[u.pathname] || 'no'); };

(async () => {
  const servers = [http.createServer(api).listen(8094, '127.0.0.1'), http.createServer(site).listen(8093, '127.0.0.1'), http.createServer(site).listen(8095, '127.0.0.1')];
  const b = await chromium.launch(); let failed = false; const errs = [];
  const open = async (url, o = {}) => { const ctx = await b.newContext({ viewport: o.vp || { width: 1100, height: 900 }, colorScheme: o.dark ? 'dark' : 'light' }); const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(url + ': ' + e.message)); pg.loaded = []; pg.on('request', (r) => pg.loaded.push(r.url())); await pg.goto(url); await pg.waitForSelector('.riyeser-widget'); return pg; };
  const W = (pg) => pg.locator('.riyeser-widget');   // Playwright's locators reach into the (open) shadow root
  const wtext = (pg) => pg.evaluate(() => document.querySelector('.riyeser-widget').shadowRoot.querySelector('#b').innerText.replace(/\s+/g, ' ').trim());
  const until = (pg, re, t = 8000) => pg.waitForFunction((s) => new RegExp(s).test(document.querySelector('.riyeser-widget').shadowRoot.querySelector('#b').innerText), re.source, { timeout: t });
  const fill = async (pg, name, phone, email) => { await W(pg).locator('#f-name').fill(name); if (phone) await W(pg).locator('#f-phone').fill(phone); if (email) await W(pg).locator('#f-email').fill(email); };
  const pickTime = async (pg) => { await W(pg).locator('[data-svc=CUT]').click(); await W(pg).locator('[data-staff=amy]').click(); await W(pg).locator('[data-slot="1"]').first().click(); await W(pg).locator('#f-name').waitFor(); };
  try {
    // 1. book a slot
    const pg = await open(SHOP + '/book');
    await until(pg, /What would you like to book\?/);
    assert.strictEqual(await W(pg).locator('[data-svc]').count(), 2);
    assert.match(await W(pg).locator('[data-svc=FULL]').innerText(), /Colour <b>& style<\/b>/, 'names from the API are shown as text');
    assert.strictEqual(await pg.evaluate(() => getComputedStyle(document.querySelector('.riyeser-widget').shadowRoot.querySelector('.w')).backgroundColor), 'rgb(255, 255, 255)');
    await pg.screenshot({ path: out + '/widget-1-service.png' });
    await W(pg).locator('[data-svc=CUT]').click(); await until(pg, /Who would you like\?/);
    assert.deepStrictEqual(await W(pg).locator('[data-staff]').allInnerTexts(), ['Anyone available', 'Amy'], 'only staff who do the service');
    await W(pg).locator('[data-staff=amy]').click(); await until(pg, /When\?/); await W(pg).locator('.times').waitFor();
    assert.strictEqual(await W(pg).locator('.days .o').count(), 3);
    const ask = st.seen.filter((x) => x.path === '/v1/availability/slots').pop(); assert.ok(ask, 'slots asked');
    await pg.screenshot({ path: out + '/widget-2-times.png' });
    await W(pg).locator('[data-day]').nth(1).click(); await W(pg).locator('[data-slot="0"]').click(); await until(pg, /Your details/);
    await W(pg).locator('button[type=submit]').click(); await until(pg, /Please type your name/);
    assert.strictEqual(await W(pg).locator('#f-name').getAttribute('aria-invalid'), 'true'); assert.match(await W(pg).locator('#f-phone-e').innerText(), /phone number or an email/);
    assert.ok(!st.posts.length, 'nothing sent with missing details');
    await fill(pg, 'Mele Tui', '+679 999 1234', 'Mele@Example.com'); await W(pg).locator('#f-note').fill('First visit');
    await pg.screenshot({ path: out + '/widget-3-details.png' });
    await W(pg).locator('button[type=submit]').click(); await until(pg, /Booking request sent|Booking confirmed/);
    const p1 = st.posts[0];
    assert.strictEqual(p1.kind, 'booking'); assert.match(p1.idem, /^[0-9a-f-]{36}$/, 'a UUID Idempotency-Key');
    assert.deepStrictEqual(Object.keys(p1.body).sort(), ['customer', 'end', 'metadata', 'notes', 'service', 'staff', 'start']);
    assert.strictEqual(p1.body.service, 'CUT'); assert.strictEqual(p1.body.staff, 'amy'); assert.strictEqual(p1.body.start, new Date(`${day(2)}T09:00:00+12:00`).toISOString(), 'start exactly as the API gave it');
    assert.deepStrictEqual(p1.body.customer, { name: 'Mele Tui', email: 'Mele@Example.com', phone: '+679 999 1234' });
    await until(pg, /Booking confirmed/); assert.match(await wtext(pg), /See you then, Mele Tui!.*Reference: BK-1042/);
    const sent = st.seen;
    assert.ok(sent.every((x) => !x.cookie), 'no cookies sent'); assert.ok(sent.filter((x) => x.method !== 'OPTIONS').every((x) => x.auth === 'Bearer ' + KEY), 'the widget key as Bearer');
    assert.ok(pg.loaded.every((u) => u.startsWith(SHOP) || u.startsWith(SITE + '/widget/') || u.startsWith(API)), 'nothing else loaded: ' + pg.loaded.filter((u) => !u.startsWith(SHOP) && !u.startsWith(API)).join(' '));
    assert.deepStrictEqual(await pg.evaluate(() => [document.cookie, localStorage.length, sessionStorage.length]), ['', 0, 0], 'no cookies or storage');
    await pg.screenshot({ path: out + '/widget-4-confirmed.png' }); console.log('booked a slot on another website: ok');

    // 2. idempotent retry after a dropped connection
    await W(pg).locator('[data-a=again]').click(); await pickTime(pg);
    await fill(pg, 'Drop Once', '+679 111 2222'); await W(pg).locator('button[type=submit]').click();
    await until(pg, /Couldn't reach the booking system/); assert.match(await W(pg).locator('button[type=submit]').innerText(), /Try again/);
    await pg.screenshot({ path: out + '/widget-5-dropped.png' });
    await W(pg).locator('button[type=submit]').click(); await until(pg, /Booking (request sent|confirmed)/);
    const drops = st.posts.filter((x) => x.body.customer.name === 'Drop Once');
    assert.strictEqual(drops.length, 2); assert.strictEqual(drops[0].idem, drops[1].idem, 'the same Idempotency-Key on Try again');
    assert.strictEqual(st.bookings.filter((x) => x.body.customer.name === 'Drop Once').length, 1, 'one booking, not two'); console.log('idempotent retry: ok');

    // 4. the time just went
    await W(pg).locator('[data-a=again]').click(); await pickTime(pg); await fill(pg, 'Too Late', '+679 333 4444'); await W(pg).locator('button[type=submit]').click();
    await until(pg, /that time has just gone/); await W(pg).locator('.times').waitFor();
    assert.ok(!(await pg.evaluate((t) => [...document.querySelector('.riyeser-widget').shadowRoot.querySelectorAll('[data-slot]')].length === 9, null)), 'fresh times, without the one that went');
    await pg.screenshot({ path: out + '/widget-6-time-gone.png' }); console.log('409 slot_not_available: ok');

    // 5a. a field the API refused, 5b. too many tries
    await W(pg).locator('[data-slot="0"]').first().click(); await fill(pg, 'Bad Email', '', 'x@y.zz'); await W(pg).locator('button[type=submit]').click();
    await until(pg, /check the details/); assert.match(await W(pg).locator('#f-email-e').innerText(), /doesn't look like an email address/);
    await fill(pg, 'Rate Me', '', 'rate@me.com'); await W(pg).locator('button[type=submit]').click(); await until(pg, /Too many tries just now/);
    console.log('422 and 429:', (await wtext(pg)).match(/Too many tries[^.]*\./)[0]);

    // 3. no free time
    const p3 = await open(SHOP + '/book'); await W(p3).locator('[data-svc=FULL]').click(); await W(p3).locator('[data-staff=""]').click();
    await until(p3, /No available times between/); await W(p3).locator('[data-a=next]').click(); await until(p3, /No available times between/);
    assert.ok(await W(p3).locator('[data-a=prev]').count(), 'Earlier after Next week'); await p3.screenshot({ path: out + '/widget-7-no-time.png' }); console.log('no free time: ok');

    // 5c. plan; 5d. a website that isn't on the key
    const p5 = await open(SHOP + '/book?key=' + NOPLAN); await until(p5, /Online booking isn't available for this business right now/); await p5.screenshot({ path: out + '/widget-8-plan.png' });
    const p6 = await open(OTHER + '/book'); await until(p6, /Couldn't reach the booking system/); console.log('plan and other website: ok');

    // 6. enquiry form and the order button
    const pe = await open(SHOP + '/enquiry'); await until(pe, /Send an enquiry/);
    await fill(pe, 'Ravi Prasad', '', 'ravi@example.com'); await W(pe).locator('#f-message').fill('Do you do kids\' cuts?'); await W(pe).locator('button[type=submit]').click(); await until(pe, /Enquiry sent/);
    const e1 = st.enquiries.pop().body; assert.deepStrictEqual([e1.service, e1.message, e1.customer.email], ['CUT', 'Do you do kids\' cuts?', 'ravi@example.com']); assert.strictEqual(e1.source_page, SHOP + '/enquiry');
    const po = await open(SHOP + '/order'); assert.match(await wtext(po), /^Order/); await po.screenshot({ path: out + '/widget-9-order-button.png' });
    await W(po).locator('[data-a=open]').click(); await until(po, /Order Chocolate cake/); await W(po).locator('[data-a=plus]').click();
    await fill(po, 'Litia Naca', '+679 555 0000'); await W(po).locator('#f-when').fill('Saturday morning'); await W(po).locator('button[type=submit]').click(); await until(po, /Order request sent/);
    const o1 = st.enquiries.pop().body; console.log('order request:', o1.subject);
    assert.strictEqual(o1.subject, 'Order request: 2 × Chocolate cake'); assert.deepStrictEqual(o1.metadata, { order_sku: 'CAKE-CHOC', order_quantity: 2, order_unit_price: 45, order_currency: 'FJD' }); assert.strictEqual(o1.preferred_time, 'Saturday morning');
    const pt = await open(SHOP + '/target'); await pt.waitForFunction(() => document.querySelector('#here .riyeser-widget')); console.log('enquiry, order button, data-target: ok');

    // 7. dark, accent, phone width, keyboard
    const pd = await open(SHOP + '/book', { dark: true, vp: { width: 390, height: 844 } }); await until(pd, /What would you like/);
    assert.strictEqual(await pd.evaluate(() => getComputedStyle(document.querySelector('.riyeser-widget').shadowRoot.querySelector('.w')).backgroundColor), 'rgb(15, 23, 42)', 'dark with the visitor\'s device');
    await pd.screenshot({ path: out + '/widget-10-phone-dark.png' });
    await W(pd).locator('[data-svc=CUT]').click(); await W(pd).locator('[data-staff=amy]').click(); await W(pd).locator('.times').waitFor();
    assert.ok(await pd.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling at 390');
    await pd.screenshot({ path: out + '/widget-11-phone-times.png' });
    const pk = await open(SHOP + '/book'); await until(pk, /What would you like/);
    assert.strictEqual(await pk.evaluate(() => getComputedStyle(document.querySelector('.riyeser-widget').shadowRoot.querySelector('.btn, [data-svc]')).borderColor !== ''), true);
    await pk.keyboard.press('Tab'); await pk.keyboard.press('Enter');   // the first service, by keyboard
    await until(pk, /Who would you like\?/); assert.strictEqual(await pk.evaluate(() => document.querySelector('.riyeser-widget').shadowRoot.activeElement.tagName), 'H3', 'focus moves to the new step');
    assert.strictEqual(await pk.evaluate(() => document.querySelector('.riyeser-widget').shadowRoot.querySelector('[aria-live]') !== null), true);
    const accent = await pk.evaluate(() => getComputedStyle(document.querySelector('.riyeser-widget')).getPropertyValue('--a').trim()); assert.strictEqual(accent, '#0f766e', 'data-accent');
    console.log('dark, phone width, keyboard: ok');
  } catch (e) { failed = true; console.error('FAIL', e); }
  if (errs.length) { failed = true; console.error('page errors:', errs); }
  await b.close(); servers.forEach((s) => s.close());
  console.log(failed ? 'WIDGET TESTS FAILED' : 'ALL WIDGET TESTS PASSED');
  process.exit(failed ? 1 : 0);
})();
