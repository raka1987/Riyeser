// The hosted booking page (riyeser.com/book/<address>, website/book) against a pretend Riyeser API (the /v1/pages/…
// routes of the "api" Edge Function, answering CORS like the real one). The site is served the way GitHub Pages does
// it: a missing file gets 404.html, so the clean address /book/harbour-hair is the booking page.
//  1. The clean address and /book/?b=: the business's name, initials (no logo) in its colour, address, "Open today",
//     the opening hours, services with duration and price; nothing else is loaded (only the site and the API).
//  2. Book: service → who (Anyone / a person) → day → time → details (checked: name, phone or email) → Request booking:
//     no key and no cookies sent, a UUID Idempotency-Key, start exactly as given → "Booking request sent" → the event
//     says confirmed → "Booking confirmed" with the reference. Later dates / Earlier.
//  3. The time just went (409): fresh times and a message. A field the API refused (422) next to the field. The
//     connection drops after the API took it: Try again sends the same Idempotency-Key (one booking, not two).
//  4. Unknown or switched-off address, a paused business, no Riyeser Bookings: "not taking online bookings" (with the
//     phone when known). The API down: "Couldn't load", Try again. Any other missing page: "That page isn't here".
//  5. /book/demo: a sample, nothing sent. ?preview: the owner's unsaved look from Riyeser Link (this browser only).
//  6. Phone width (390): no sideways scrolling; dark mode; keyboard only; every control labelled; contrast of the
//     business's colour (a pale yellow brand still gets readable text); no cookies or storage written.
// Run: node website/build.mjs, then `node website/team/test/booking-page-test.js <shots>` (it serves website/public
// itself on 18732). Exits 1 on failure.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const PUB = path.join(__dirname, '..', '..', 'public');
const SITE = 'http://127.0.0.1:18732';
const API = 'https://goaugynxeatzqzifpoes.supabase.co/functions/v1/api';
const out = process.argv[2] || '.';
const day = (n) => { const d = new Date(Date.now() + 12 * 3600e3); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };   // Fiji's date

// ---- the site, as GitHub Pages serves it
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const site = http.createServer((req, res) => {
  const u = new URL(req.url, SITE); let f = path.join(PUB, decodeURIComponent(u.pathname));
  if (!f.startsWith(PUB)) { res.writeHead(400); return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': types['.html'] }); return res.end(fs.readFileSync(path.join(PUB, '404.html'))); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});

// ---- the pretend API (Playwright answers requests to the real address)
const st = { seen: [], posts: [], idem: {}, taken: null, down: false, drops: new Set() };
const PROFILE = { slug: 'harbour-hair', name: 'Harbour Hair Studio', intro: 'Cuts, colour and styling by the water.', colour: '#0e7c86', logo: null,
  address: '12 Marine Drive, Suva', phone: '+679 330 1234', timezone: 'Pacific/Fiji', slot_minutes: 15, days_ahead: 30, accepting: true, reason: null,
  services: [{ sku: 'CUT', name: 'Cut & style', duration_minutes: 45, price: 45, currency: 'FJD', category: null }, { sku: 'COLOUR', name: 'Colour <b>bold</b>', duration_minutes: 90, price: 95, currency: 'FJD', description: 'Includes a wash.' },
    { sku: 'KIDS', name: 'Kids cut', duration_minutes: 30, price: 25, currency: 'FJD' }],
  staff: [{ ref: 'amy', name: 'Amy', services: [] }, { ref: 'sam', name: 'Sam', services: ['COLOUR'] }],
  hours: [0, 1, 2, 3, 5].map((n) => ({ day: day(n), open: '09:00', close: n === 5 ? '13:00' : '17:00' })) };
const pages = { 'harbour-hair': PROFILE, 'sunny-cafe': { ...PROFILE, slug: 'sunny-cafe', name: 'Sunny Cafe', colour: '#fde047', staff: [] },
  'lapsed-salon': { ...PROFILE, slug: 'lapsed-salon', name: 'Lapsed Salon', accepting: false, reason: 'bookings_licence_required', services: [], staff: [] } };
async function api(route) {
  const r = route.request(); const u = new URL(r.url()); const p = u.pathname.replace('/functions/v1/api', ''); const h = r.headers(); const origin = h.origin || '';
  st.seen.push({ method: r.method(), path: p, search: u.search, auth: h.authorization || '', cookie: h.cookie || '', idem: h['idempotency-key'] || '', origin });
  const cors = origin === SITE ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'X-Request-Id, Idempotent-Replayed, Retry-After', Vary: 'Origin' } : {};
  if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
  const send = (status, body, extra = {}) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra }, body: JSON.stringify(body) });
  const err = (status, code, message, extra, details) => send(status, { error: { code, message, ...(details ? { details } : {}) } }, extra);
  if (st.down) return route.abort('connectionrefused');
  const m = /^\/v1\/pages\/([^/]+)(\/.*)?$/.exec(p); if (!m) return err(404, 'not_found', 'Not here.');
  const slug = m[1]; const rest = m[2] || '';
  if (slug === 'paused-shop') return err(403, 'business_closed', 'This business\'s Riyeser account is closed or paused.');
  const pg = pages[slug]; if (!pg) return err(404, 'page_not_found', 'This business isn\'t taking online bookings here.');
  if (!rest && r.method() === 'GET') return send(200, pg);
  if (rest === '/slots') {
    const from = u.searchParams.get('from'); const staff = u.searchParams.get('staff'); const svc = u.searchParams.get('service'); const slots = [];
    for (let i = 0; i < 7; i++) { const d = new Date(Date.parse(from + 'T00:00:00Z') + i * 864e5).toISOString().slice(0, 10); if (d < day(1) || d > day(12)) continue;
      for (const t of staff === 'sam' ? ['13:00', '13:45'] : ['09:00', '09:45', '10:30', '14:00', '15:15']) { const start = new Date(`${d}T${t}:00+12:00`).toISOString(); if (start === st.taken) continue;
        slots.push({ start, end: new Date(Date.parse(start) + 45 * 60e3).toISOString(), local_start: `${d}T${t}`, staff: [staff || 'amy'], capacity: 1 }); } }
    return send(200, { timezone: 'Pacific/Fiji', service: svc, duration_minutes: 45, slots });
  }
  if (rest === '/bookings' && r.method() === 'POST') {
    const j = JSON.parse(r.postData() || '{}'); const idem = h['idempotency-key'] || ''; st.posts.push({ idem, body: j });
    if (st.idem[idem]) return send(200, st.idem[idem], { 'Idempotent-Replayed': 'true' });
    const name = (j.customer || {}).name || '';
    if (name === 'Too Late') { st.taken = j.start; return err(409, 'slot_not_available', 'That time isn\'t free any more.'); }
    if (name === 'Bad Email') return err(422, 'invalid_payload', 'Some details need fixing.', {}, [{ field: 'customer.email', message: 'customer.email doesn\'t look like an email address.' }]);
    const answer = { id: '6f1c2a90-1d1e-4c55-9b7e-' + String(st.posts.length).padStart(12, '0'), kind: 'booking', status: 'waiting', test: false, created_at: new Date().toISOString() };
    st.idem[idem] = answer;
    if (name === 'Drop Once' && !st.drops.has(name)) { st.drops.add(name); return route.abort('connectionreset'); }
    return send(202, answer, { Location: '/v1/events/' + answer.id });
  }
  const ev = /^\/events\/(.+)$/.exec(rest);
  if (ev) return send(200, { id: ev[1], kind: 'booking', status: 'done', result: { reference: 'BK-1042', state: 'confirmed', message: 'See you then! Reply to our text to change it.' } });
  return err(405, 'method_not_allowed', 'No.');
}

(async () => {
  await new Promise((ok) => site.listen(18732, '127.0.0.1', ok));
  const b = await chromium.launch(); let failed = 0; const errs = []; const external = [];
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
  const open = async (url, o = {}) => {
    const ctx = await b.newContext({ viewport: o.vp || { width: 1280, height: 900 }, colorScheme: o.dark ? 'dark' : 'light', locale: 'en-NZ', timezoneId: 'Pacific/Fiji', deviceScaleFactor: o.dpr || 1 });
    await ctx.route(API + '/**', api);
    ctx.on('request', (r) => { const u = r.url(); if (!u.startsWith(SITE) && !u.startsWith(API) && !u.startsWith('data:')) external.push(u); });
    const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(url + ': ' + e.message));
    await pg.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
    await pg.goto(SITE + url); return pg;
  };
  const shot = (pg, name, full = true) => pg.screenshot({ path: path.join(out, name), fullPage: full });
  const text = (pg) => pg.evaluate(() => document.body.innerText);
  try {
    // ---- 1. the clean address
    let pg = await open('/book/harbour-hair', { vp: { width: 1366, height: 1000 } });
    await pg.waitForSelector('#bizname');
    check(await pg.title() === 'Book with Harbour Hair Studio', 'the clean address /book/harbour-hair is the booking page (404.html, title)');
    const t1 = await text(pg);
    check(/12 Marine Drive, Suva/.test(t1) && /Open today 9:00/i.test(t1) && /Opening hours/i.test(t1), 'address, "Open today", opening hours');
    check(/Cut & style/.test(t1) && /45 min · \D*45\b/.test(t1) && /1 hr 30 min · \D*95\b/.test(t1), 'services with duration and price');
    check(await pg.$eval('.svc[data-svc=COLOUR] b', (e) => e.innerHTML) === 'Colour &lt;b&gt;bold&lt;/b&gt;', 'what the business typed is shown as text, never as HTML');
    check(await pg.$eval('.logo', (e) => e.textContent) === 'HH' && await pg.$eval('.logo', (e) => getComputedStyle(e).backgroundColor) === 'rgb(14, 124, 134)', 'initials in the business\'s colour (no logo)');
    check(st.seen.filter((s) => s.path === '/v1/pages/harbour-hair').length === 1 && st.seen.every((s) => !s.auth && !s.cookie), 'one profile request, no key, no cookies');
    await shot(pg, 'booking-page-desktop.png');
    // ---- 2. book
    await pg.click('[data-svc=COLOUR]');
    await pg.waitForSelector('#s-who [data-staff]');
    check((await pg.$$eval('#s-who [data-staff]', (x) => x.map((e) => e.textContent))).join('|') === 'Anyone available|Amy|Sam', 'who: Anyone, and the people who do that service');
    await pg.waitForSelector('.days [data-day]:not([disabled])');
    await pg.click('[data-staff=sam]'); await pg.waitForSelector('.times [data-slot]');
    check(st.seen.some((s) => s.path.endsWith('/slots') && /staff=sam/.test(s.search)), 'free times for Sam');
    check((await pg.$$eval('.times [data-slot]', (x) => x.map((e) => e.textContent))).join('|') === '1:00 pm|1:45 pm', 'Sam\'s times, in the business\'s time');
    await pg.click('[data-staff=""]'); await pg.waitForSelector('.times [data-slot]');
    const firstDay = await pg.$eval('.days [aria-pressed=true]', (e) => e.dataset.day);
    check(firstDay === day(1), 'the first day with free times is chosen (' + firstDay + ')');
    check(await pg.$eval('.days [data-day="' + day(0) + '"]', (e) => e.disabled && /no free times/.test(e.getAttribute('aria-label'))), 'a day with no free times can\'t be chosen and says so');
    await pg.click('.days [data-day="' + day(2) + '"]'); await pg.click('.times [data-slot="2"]');
    await pg.waitForSelector('#f-name');
    check(await pg.evaluate(() => document.activeElement.id) === 'f-name', 'choosing a time goes to the details (focus on name)');
    check(/Colour <b>bold<\/b>.*10:30 am/s.test(await pg.$eval('.sum', (e) => e.textContent)), 'the summary: service, day and time');
    await shot(pg, 'booking-page-details.png');
    await pg.click('#send');
    check(await pg.$eval('#f-name', (e) => e.getAttribute('aria-invalid')) === 'true' && /phone number or an email/.test(await text(pg)), 'details are checked before anything is sent');
    check(!st.posts.length, 'nothing sent yet');
    await pg.fill('#f-name', 'Mele Tui'); await pg.fill('#f-phone', '+679 777 1234'); await pg.fill('#f-note', 'First time here');
    await pg.click('#send'); await pg.waitForSelector('#donehead');
    const post = st.posts[0]; const seenPost = st.seen.find((s) => s.method === 'POST');
    check(!!post && post.body.service === 'COLOUR' && post.body.start === new Date(`${day(2)}T10:30:00+12:00`).toISOString() && post.body.customer.name === 'Mele Tui' && post.body.notes === 'First time here' && !post.body.staff,
      'the booking: service, start exactly as given, customer, notes');
    check(/^[0-9a-f-]{36}$/.test(post.idem) && !seenPost.auth && !seenPost.cookie && seenPost.origin === SITE, 'a UUID Idempotency-Key, no key, no cookies, from the site');
    check(/Booking request sent/.test(await text(pg)), '"Booking request sent"');
    await pg.waitForFunction(() => /Booking confirmed/.test(document.body.innerText), null, { timeout: 15000 });
    const t2 = await text(pg); check(/BK-1042/.test(t2) && /See you then!/.test(t2), 'the event says confirmed: the reference and the business\'s message');
    await shot(pg, 'booking-page-done.png');
    // later dates
    await pg.click('[data-a=again]'); await pg.click('[data-svc=CUT]'); await pg.waitForSelector('.days [data-day]:not([disabled])');
    await pg.click('[data-a=next]'); await pg.waitForSelector('.times [data-slot]');
    check(st.seen.some((s) => s.path.endsWith('/slots') && s.search.includes('from=' + day(7))), 'Later dates asks for the next week');
    check(!!(await pg.$('[data-a=prev]')), 'and Earlier comes back');
    await pg.context().close();

    // ---- 3. the time went, a field refused, a dropped connection
    pg = await open('/book/?b=harbour-hair');
    await pg.waitForSelector('[data-svc=CUT]'); check(true, '/book/?b=harbour-hair works too');
    const pick = async (slot = 0) => { await pg.click('[data-svc=CUT]'); await pg.waitForSelector('.times [data-slot]'); await pg.click(`.times [data-slot="${slot}"]`); await pg.waitForSelector('#f-name'); };
    await pick(0); await pg.fill('#f-name', 'Too Late'); await pg.fill('#f-email', 'late@example.com'); await pg.click('#send');
    await pg.waitForFunction(() => /just gone/.test(document.body.innerText));
    check(!(await pg.$('#f-name')) && !!(await pg.$('.times [data-slot]')), 'the time went (409): fresh times and "that time has just gone"');
    await pg.click('.times [data-slot="0"]'); await pg.fill('#f-name', 'Bad Email'); await pg.click('#send');
    await pg.waitForSelector('#f-email-e');
    check(/doesn't look like an email/.test(await pg.textContent('#f-email-e')), 'a field the API refused (422) is shown next to it');
    await pg.fill('#f-name', 'Drop Once'); await pg.fill('#f-email', 'drop@example.com'); await pg.click('#send');
    await pg.waitForFunction(() => /Couldn't reach the booking system/.test(document.body.innerText));
    check(await pg.textContent('#send') === 'Try again', 'connection dropped: "Couldn\'t reach…", Try again');
    await pg.click('#send'); await pg.waitForSelector('#donehead');
    const drops = st.posts.filter((x) => x.body.customer.name === 'Drop Once');
    check(drops.length === 2 && drops[0].idem === drops[1].idem, 'Try again sends the same Idempotency-Key (one booking, not two)');
    await pg.context().close();

    // ---- 4. not taking bookings, API down, missing pages
    pg = await open('/book/no-such-salon'); await pg.waitForSelector('#msghead');
    check(/isn't taking online bookings here/.test(await text(pg)), 'unknown or switched-off address: "not taking online bookings"');
    await shot(pg, 'booking-page-not-found.png', false); await pg.context().close();
    pg = await open('/book/paused-shop'); await pg.waitForSelector('#msghead');
    check(/isn't taking online bookings here/.test(await text(pg)), 'a paused business: the same');
    await pg.context().close();
    pg = await open('/book/lapsed-salon'); await pg.waitForSelector('#msghead');
    const t4 = await text(pg); check(/Lapsed Salon isn't taking online bookings right now/.test(t4) && /\+679 330 1234/.test(t4), 'no Riyeser Bookings: the business\'s name and phone');
    await pg.context().close();
    st.down = true; pg = await open('/book/harbour-hair'); await pg.waitForSelector('#msghead');
    check(/Couldn't load the booking page/.test(await text(pg)), 'the API down: "Couldn\'t load"');
    st.down = false; await pg.click('[data-a=reload]'); await pg.waitForSelector('#bizname'); check(true, 'Try again loads it');
    await pg.context().close();
    pg = await open('/pricing-old.html'); await pg.waitForSelector('#msghead');
    check(/That page isn't here/.test(await text(pg)) && !st.seen.some((s) => s.path.includes('pricing')), 'any other missing page: "That page isn\'t here" (no API call)');
    await pg.context().close();
    pg = await open('/book/'); await pg.waitForSelector('#msghead');
    check(/Ask the business for their booking link/.test(await text(pg)), '/book/ on its own explains the address');
    await pg.context().close();

    // ---- 5. the sample and the owner's preview
    const before = st.seen.length;
    pg = await open('/book/demo'); await pg.waitForSelector('#bizname');
    await pg.click('[data-svc=CUT]'); await pg.waitForSelector('.times [data-slot]'); await pg.click('.times [data-slot="0"]');
    await pg.fill('#f-name', 'Sample'); await pg.fill('#f-email', 's@example.com'); await pg.click('#send'); await pg.waitForSelector('#donehead');
    check(st.seen.length === before && /nothing is sent/i.test(await text(pg)), '/book/demo: a sample, nothing sent');
    await pg.evaluate(() => localStorage.setItem('riyeser.book.preview', JSON.stringify({ at: Date.now(), look: { name: 'Draft Barber', colour: '#7c3aed', intro: 'New look', show_prices: false } })));
    await pg.goto(SITE + '/book/?preview'); await pg.waitForSelector('#bizname');
    const t5 = await text(pg);
    check(/Draft Barber/.test(t5) && /New look/.test(t5) && /Preview: sample services/.test(t5) && !/\$45/.test(t5) && st.seen.length === before, 'preview: the owner\'s unsaved look, prices hidden, nothing sent');
    await pg.context().close();

    // ---- 6. phone, dark, keyboard, contrast, storage
    pg = await open('/book/harbour-hair', { vp: { width: 390, height: 844 }, dpr: 2 }); await pg.waitForSelector('#bizname');
    const wide = async () => pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(await wide() <= 0, 'phone (390): no sideways scrolling');
    await shot(pg, 'booking-page-phone.png');
    await pg.click('[data-svc=CUT]'); await pg.waitForSelector('.times [data-slot]');
    check(await wide() <= 0, 'phone: the days scroll inside their row, not the page');
    await pg.click('.times [data-slot="1"]'); await pg.waitForSelector('#f-name');
    await shot(pg, 'booking-page-phone-details.png');
    check(await wide() <= 0, 'phone: details');
    await pg.context().close();
    pg = await open('/book/harbour-hair', { dark: true }); await pg.waitForSelector('#bizname');
    const dk = await pg.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.card')).backgroundColor]);
    check(dk[0] === 'rgb(11, 17, 32)' && dk[1] === 'rgb(18, 26, 44)', 'dark mode');
    await shot(pg, 'booking-page-dark.png', false);
    await pg.context().close();
    // keyboard only
    pg = await open('/book/harbour-hair'); await pg.waitForSelector('#bizname');
    let found = false; for (let i = 0; i < 25 && !found; i++) { await pg.keyboard.press('Tab'); found = await pg.evaluate(() => document.activeElement.dataset.svc === 'CUT'); }
    check(found, 'Tab reaches the services');
    await pg.keyboard.press('Enter'); await pg.waitForSelector('.times [data-slot]');
    check(await pg.evaluate(() => document.activeElement.id) === 's-who-h', 'Enter chooses it and moves on to the next step ("Who would you like?")');
    for (let i = 0; i < 30; i++) { await pg.keyboard.press('Tab'); if (await pg.evaluate(() => document.activeElement.dataset.slot === '0')) break; }
    await pg.keyboard.press('Enter'); await pg.waitForSelector('#f-name');
    await pg.keyboard.type('Key Board'); await pg.keyboard.press('Tab'); await pg.keyboard.type('021 555 0101');
    await pg.keyboard.press('Tab'); await pg.keyboard.press('Tab'); await pg.keyboard.press('Tab'); await pg.keyboard.press('Enter');
    await pg.waitForSelector('#donehead');
    check(st.posts.some((x) => x.body.customer.name === 'Key Board'), 'booked with the keyboard only');
    const unlabelled = await pg.evaluate(() => [...document.querySelectorAll('button, input, textarea, a')].filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length))).length);
    check(unlabelled === 0, 'every control has a name');
    const ring = await pg.evaluate(() => { const b = document.querySelector('[data-a=again]'); b.focus(); return getComputedStyle(b).outlineStyle; });
    check(ring !== 'none', 'a focus ring shows');
    const store = await pg.evaluate(() => [document.cookie, localStorage.length, sessionStorage.length]);
    check(store[0] === '' && store[1] === 0 && store[2] === 0, 'no cookies or storage');
    check(!(await pg.evaluate(() => window.__csp)).length, 'nothing refused by the Content-Security-Policy');
    await pg.context().close();
    // a pale brand colour: text in it is darkened until it reads (4.5:1), the button text is dark
    pg = await open('/book/sunny-cafe'); await pg.waitForSelector('#bizname');
    await pg.click('[data-svc=CUT]'); await pg.waitForSelector('.times [data-slot]'); await pg.click('.times [data-slot="0"]'); await pg.waitForSelector('#send');
    const c = await pg.evaluate(() => { const r = (a, b) => { const p = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((x, v, i) => x + v * [0.2126, 0.7152, 0.0722][i], 0); const x = p(a); const y = p(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const btn = getComputedStyle(document.getElementById('send')); const n = getComputedStyle(document.querySelector('.step h2 .n'));
      return { button: r(btn.color, btn.backgroundColor), step: r(n.color, n.backgroundColor), link: r(getComputedStyle(document.querySelector('.about a')).color, 'rgb(255,255,255)') }; });
    check(c.button >= 4.5 && c.step >= 4.5 && c.link >= 4.5, `a pale yellow brand still reads: button ${c.button.toFixed(1)}, step numbers ${c.step.toFixed(1)}, links ${c.link.toFixed(1)}`);
    await pg.context().close();
    check(!external.length, 'nothing loaded from anywhere else ' + external.join(' '));
    check(!errs.length, 'no page errors ' + errs.join(' | '));
  } catch (e) { console.log('FAIL ' + (e && e.stack || e)); failed++; }
  await b.close(); site.close();
  console.log(failed ? `${failed} BOOKING PAGE CHECK(S) FAILED` : 'ALL BOOKING PAGE CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
