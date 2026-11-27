// Riyeser Estimate extras in a browser: Good / Better / Best options (add them, change one, recommend one, make the
// quote, the quote's options and its PDF) and photos with markup (add a photo, draw an arrow, a circle, a box, a
// freehand line, a text label and a size, undo and redo, save; on a phone the same with a finger). At 1280 wide at
// 125% (1024 CSS px), 1366, 1920 and a 390 phone: nothing sideways, nothing cut off.
//   python tests/browser/serve_estimate.py 8091 8092 &   then   PHOTO=... SHOTS=/some/folder node tests/browser/estimate_extras.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8091';
const SHOTS = process.env.SHOTS || path.join(require('os').tmpdir(), 'estimate-extras-shots');
const PHOTO = process.env.PHOTO;
fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

async function noSideways(pg, what) {
  const w = await pg.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check(w[0] <= w[1] + 1, `${what}: no sideways scroll (${w[0]} <= ${w[1]})`);
}
// text that is cut off (ellipsis or hidden overflow) or sticks out of its box
async function noCutOff(pg, sel, what) {
  const bad = await pg.evaluate((sel) => Array.from(document.querySelectorAll(sel)).filter((el) => {
    if (!el.offsetParent) return false;
    const r = el.getBoundingClientRect(), p = (el.closest('.opt-card, .qopt') || el.parentElement).getBoundingClientRect();
    return el.scrollWidth > el.clientWidth + 1 || r.right > p.right + 1 || r.left < p.left - 1;
  }).map((el) => el.className + ': ' + el.textContent.trim().slice(0, 40)), sel);
  check(bad.length === 0, `${what}: nothing cut off ${bad.join(' | ')}`);
}
async function shot(pg, name, full) { await pg.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full }); }

async function login(pg) {
  await pg.goto(BASE + '/login');
  await pg.fill('input[name=username]', 'admin'); await pg.fill('input[name=password]', 'admin');
  await Promise.all([pg.waitForNavigation(), pg.press('input[name=password]', 'Enter')]);
}

// a room, the painting template, walls at 15
async function makeEstimate(pg, tag) {
  await pg.goto(BASE + '/estimate/new');
  await pg.fill('#new_name', `Alex Moore ${tag}`); await pg.fill('#title', `Repaint the lounge ${tag}`); await pg.fill('#address', '9 Hill Rd');
  await Promise.all([pg.waitForNavigation(), pg.click('text=Next: how to measure')]);
  await Promise.all([pg.waitForNavigation(), pg.click('button.choice[value=manual]')]);
  const tid = pg.url().match(/estimate\/(\d+)\//)[1];
  await pg.click('.kindpick label:has-text("Room")');
  await pg.fill('#m_label', 'Lounge'); await pg.fill('#m_length', '5'); await pg.fill('#m_width', '4'); await pg.fill('#m_height', '2.4');
  await Promise.all([pg.waitForNavigation(), pg.click('#m_save')]);
  await pg.goto(`${BASE}/estimate/${tid}/template`);
  await pg.click('.choice:has-text("Painting")');
  await Promise.all([pg.waitForNavigation(), pg.click('text=Next: review the price')]);
  await pg.locator('input[name^=rate_]').nth(0).fill('15');
  await pg.locator('input[name^=rate_]').nth(1).fill('12');
  await Promise.all([pg.waitForNavigation(), pg.click('button[name=go][value=save]')]);
  return tid;
}

async function options(pg, tag, tid) {
  await pg.goto(`${BASE}/estimate/${tid}/price`);
  check(await pg.isVisible('#opt-start'), `${tag} "Add options" offered on a one-price estimate`);
  await shot(pg, `${tag}-01-price-one`, true);
  await Promise.all([pg.waitForNavigation(), pg.click('#opt-start')]);
  const names = await pg.$$eval('.opt-card .opt-name', (els) => els.map((e) => e.textContent.trim()));
  check(names.join(',') === 'Good,Better,Best', `${tag} options Good, Better, Best (${names})`);
  check((await pg.textContent('.opt-card.rec .opt-name')).trim() === 'Better', `${tag} Better recommended to start`);
  // Best: its own markup and name
  await Promise.all([pg.waitForNavigation(), pg.click('.opt-card[data-opt="2"] .opt-pick')]);
  check(await pg.inputValue('#option_name') === 'Best', `${tag} Best open for changes`);
  await pg.fill('#option_name', 'Premium'); await pg.fill('#markup', '25');
  await Promise.all([pg.waitForNavigation(), pg.click('#opt-save')]);
  const tot = await pg.$$eval('.opt-card .opt-total b', (els) => els.map((e) => Number(e.textContent.replace(/[^0-9.]/g, ''))));
  check(tot[2] > tot[1] && tot[1] === tot[0], `${tag} Premium has its own total (${tot.join(' / ')})`);
  const margins = await pg.$$eval('.opt-card .opt-margin', (els) => els.map((e) => e.textContent.trim()));
  check(margins.length === 3, `${tag} profit and margin shown for each option (${margins})`);
  // Good: walls only (its own template choice is kept; the ceiling rate taken off)
  await Promise.all([pg.waitForNavigation(), pg.click('.opt-card[data-opt="0"] .opt-pick')]);
  await pg.locator('input[name^=rate_]').nth(1).fill('0');
  await Promise.all([pg.waitForNavigation(), pg.click('#opt-save')]);
  const tot2 = await pg.$$eval('.opt-card .opt-total b', (els) => els.map((e) => Number(e.textContent.replace(/[^0-9.]/g, ''))));
  check(tot2[0] < tot2[1], `${tag} Good is cheaper (${tot2.join(' / ')})`);
  // recommend Premium
  await Promise.all([pg.waitForNavigation(), pg.click('.opt-card[data-opt="2"] .opt-recbtn')]);
  check((await pg.textContent('.opt-card.rec .opt-name')).trim() === 'Premium', `${tag} Premium now recommended`);
  await noSideways(pg, `${tag} options`); await noCutOff(pg, '.opt-card .opt-total b, .opt-card .opt-pm b, .opt-name, .opt-rec', `${tag} option cards`);
  await shot(pg, `${tag}-02-options`, true);
  await pg.evaluate(() => document.querySelector('.opt-board').scrollIntoView({ block: 'start', behavior: 'instant' }));
  await shot(pg, `${tag}-02b-options-view`);
  // make the quote
  await Promise.all([pg.waitForNavigation(), pg.click('button[name=go][value=quote]')]);
  check(/\/send$/.test(pg.url()), `${tag} quote made with options`);
  check((await pg.textContent('.est-head .sub')).includes('3 options from'), `${tag} send step shows "3 options from"`);
  await shot(pg, `${tag}-03-send`);
  await noSideways(pg, `${tag} send`);
  const pdf = await pg.request.get(`${BASE}/estimate/${tid}/quote.pdf`);
  const body = await pdf.body();
  check(pdf.ok() && body.slice(0, 5).toString() === '%PDF-' && body.length > 3000, `${tag} quote PDF with options (${body.length} bytes)`);
  fs.writeFileSync(path.join(SHOTS, `${tag}-quote.pdf`), body);
  // the quote: every option, the recommended one marked, choose the one they accepted
  const href = await pg.getAttribute('.est-head .sub a', 'href');
  await pg.goto(BASE + href);
  check(await pg.locator('.qopt').count() === 3, `${tag} quote shows the 3 options`);
  check((await pg.textContent('.qopt.rec')).includes('Recommended'), `${tag} recommended badge on the quote`);
  await noSideways(pg, `${tag} quote`); await noCutOff(pg, '.qopt-name, .qopt-tot dd', `${tag} quote options`);
  await shot(pg, `${tag}-04-quote-options`, true);
  await pg.check('input[name=option][value="1"]');
  await pg.fill('#q-name', 'Alex Moore');
  await Promise.all([pg.waitForNavigation(), pg.click('text=Save: accepted')]);
  check((await pg.textContent('.flash.ok')).includes('(Good)'), `${tag} accepted with Good`);
  check((await pg.textContent('.qopt.chosen')).includes('Good'), `${tag} Good marked chosen`);
  await shot(pg, `${tag}-05-quote-accepted`);
  return tid;
}

async function photos(pg, ctx, tag, tid, touch) {
  await pg.goto(`${BASE}/estimate/${tid}/measure`);
  check(await pg.isVisible('#photos-link'), `${tag} Photos button on the Measure step`);
  await noSideways(pg, `${tag} measure with Photos button`);
  await shot(pg, `${tag}-06-measure-photos-button`);
  await Promise.all([pg.waitForNavigation(), pg.click('#photos-link')]);
  await shot(pg, `${tag}-07-photos-empty`);
  await pg.setInputFiles('#ph-file', PHOTO);
  await pg.waitForSelector('.ph-card');
  check((await pg.textContent('#ph-status')).includes('Photo added'), `${tag} photo added`);
  await pg.fill('.ph-cap', 'Window frame: rot along the sill'); await pg.press('.ph-cap', 'Tab');
  await pg.waitForFunction(() => /Caption saved/.test(document.getElementById('ph-status').textContent));
  await noSideways(pg, `${tag} photos`);
  await shot(pg, `${tag}-08-photos`);
  await pg.click('.ph-card [data-edit]');
  await pg.waitForFunction(() => window.RE_MK && RE_MK.state().open);
  await pg.waitForTimeout(200);
  const box = await pg.locator('#mk-canvas').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  let cdp = null;
  if (touch) cdp = await ctx.newCDPSession(pg);
  async function drag(points) {
    if (touch) {
      const tp = (p) => [{ x: p[0], y: p[1], id: 1, radiusX: 4, radiusY: 4, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(points[0]) });
      for (const p of points.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(p) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await pg.mouse.move(...points[0]); await pg.mouse.down();
      for (const p of points.slice(1)) await pg.mouse.move(...p, { steps: 3 });
      await pg.mouse.up();
    }
    await pg.waitForTimeout(80);
  }
  const line = (a, b, n = 6) => Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
  const n = () => pg.evaluate(() => RE_MK.state().shapes.length);
  // arrow (the starting tool)
  await drag(line(at(0.15, 0.15), at(0.38, 0.32)));
  // circle around the window's corner, in blue
  await pg.click('.mk-c[data-colour="#2563eb"]');
  await pg.click('[data-tool=circle]'); await drag(line(at(0.55, 0.5), at(0.75, 0.7)));
  await pg.click('[data-tool=rect]'); await drag(line(at(0.05, 0.8), at(0.3, 0.95)));
  await pg.click('.mk-c[data-colour="#dc2626"]');
  await pg.click('[data-tool=pen]'); await drag([at(0.6, 0.1), at(0.62, 0.12), at(0.66, 0.18), at(0.7, 0.16), at(0.74, 0.2)]);
  check(await n() === 4, `${tag} arrow, circle, box and freehand drawn (${await n()})`);
  // a text label: tap, type, Enter
  await pg.click('[data-tool=text]');
  await drag([at(0.2, 0.45)]);
  await pg.waitForSelector('#mk-ask:not([hidden])');
  await pg.fill('#mk-text', 'Rot here'); await pg.press('#mk-text', 'Enter');
  // a size: drag along it, type the length (a plain number gets the estimate's unit)
  await pg.click('[data-tool=measure]'); await drag(line(at(0.33, 0.66), at(0.67, 0.66)));
  await pg.waitForSelector('#mk-ask:not([hidden])');
  await pg.fill('#mk-text', '1.2'); await pg.press('#mk-text', 'Enter');
  let st = await pg.evaluate(() => RE_MK.state());
  check(st.shapes.length === 6 && st.shapes[4].s === 'Rot here' && st.shapes[5].s === '1.2 m',
    `${tag} text label and size callout (${st.shapes.map((s) => s.t + (s.s ? ':' + s.s : '')).join(', ')})`);
  check(st.shapes[1].c === '#2563eb' && st.shapes[0].c === '#dc2626', `${tag} colours kept per mark`);
  await shot(pg, `${tag}-09-markup-editor`);
  await pg.click('#mk-undo'); await pg.click('#mk-undo');
  check(await n() === 4, `${tag} undo twice`);
  await pg.click('#mk-redo');
  st = await pg.evaluate(() => RE_MK.state());
  check(st.shapes.length === 5 && st.canRedo, `${tag} redo once (one more to redo)`);
  await pg.click('#mk-redo');
  check(await n() === 6, `${tag} redo again`);
  await noSideways(pg, `${tag} markup editor`);
  const barFits = await pg.evaluate(() => { const b = document.querySelector('.mk-bar'); return Array.from(b.querySelectorAll('button')).filter((x) => x.offsetParent).every((x) => { const r = x.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.left >= -1; }); });
  check(barFits, `${tag} every editor button on screen`);
  await pg.click('#mk-save');
  await pg.waitForFunction(() => !RE_MK.state().open);
  check((await pg.textContent('#ph-status')).includes('Markup saved (6 marks)'), `${tag} markup saved`);
  check((await pg.textContent('.ph-marks')).includes('6 marks'), `${tag} 6 marks on the photo`);
  const mj = await (await pg.request.get(`${BASE}/estimate/${tid}/photos/${await pg.getAttribute('.ph-card', 'data-photo')}/markup`)).json();
  check(mj.markup.shapes.length === 6 && mj.markup.shapes[5].t === 'measure', `${tag} markup JSON kept on the PC`);
  await pg.waitForTimeout(300);
  await shot(pg, `${tag}-10-photos-marked`);
  // on the quote PDF: the Send step lists it, ticked
  const send = await pg.request.get(`${BASE}/estimate/${tid}/send`);
  check((await send.text()).includes('Window frame: rot along the sill'), `${tag} photo listed on the Send step`);
  const pdf = await pg.request.get(`${BASE}/estimate/${tid}/quote.pdf`);
  const body = await pdf.body();
  check(body.includes('/Subtype /Image') || body.includes('/Subtype/Image'), `${tag} the marked-up photo is in the quote PDF`);
  fs.writeFileSync(path.join(SHOTS, `${tag}-quote-with-photo.pdf`), body);
  await pg.goto(`${BASE}/estimate/${tid}/send`);
  await pg.evaluate(() => document.getElementById('send-photos').scrollIntoView({ block: 'center', behavior: 'instant' }));
  await shot(pg, `${tag}-11-send-photos`);
  await noSideways(pg, `${tag} send with photos`);
}

async function run(vw, vh, dpr, tag, touch) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr, hasTouch: !!touch, isMobile: !!touch });
  const pg = await ctx.newPage(); const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push(m.text()); });
  pg.on('dialog', (d) => d.accept());
  await login(pg);
  const tid = await makeEstimate(pg, tag);
  await options(pg, tag, tid);
  await photos(pg, ctx, tag, tid, touch);
  check(errs.length === 0, `${tag} no page errors ${errs.join(' | ')}`);
  await b.close();
}

(async () => {
  const only = process.env.ONLY;
  const runs = [[1024, 657, 1.25, 'w1280at125'], [1366, 768, 1, 'w1366'], [1920, 1080, 1, 'w1920'], [390, 844, 3, 'phone390', true]];
  for (const r of runs) if (!only || only === r[3]) await run(...r);
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
