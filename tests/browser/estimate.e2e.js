// Riyeser Estimate in a browser, at 1280 and 390 (a phone): a room typed in, a plan with a scale and drawn area and
// length, a roof face with pitch on the map (stand-in tiles: never Esri), and the quote. No sideways scrolling.
//   python tests/browser/serve_estimate.py 8091 8092 &   then   SHOTS=/some/folder node tests/browser/estimate.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8091';
const SHOTS = process.env.SHOTS || path.join(require('os').tmpdir(), 'estimate-shots');
const PLAN = process.env.PLAN;
fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

async function noSideways(pg, what) {
  const w = await pg.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check(w[0] <= w[1] + 1, `${what}: no sideways scroll (${w[0]} <= ${w[1]})`);
}
async function shot(pg, name) { await pg.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); }

async function run(width, height, tag) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: width < 500 });
  const pg = await ctx.newPage(); const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  if (process.env.DEBUG) { pg.on('console', (m) => console.log('console:', m.text())); pg.on('response', (r) => { if (r.status() >= 400) console.log('http', r.status(), r.url()); }); }
  pg.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push(m.text()); });
  await pg.goto(BASE + '/login');
  await pg.fill('input[name=username]', 'admin'); await pg.fill('input[name=password]', 'admin');
  await Promise.all([pg.waitForNavigation(), pg.press('input[name=password]', 'Enter')]);
  await pg.goto(BASE + '/estimate/'); await shot(pg, `${tag}-01-estimates`); await noSideways(pg, `${tag} estimates`);

  // 1 customer -> 2 how -> 3 type in a room
  await pg.goto(BASE + '/estimate/new');
  await pg.fill('#new_name', `Sam Rivera ${tag}`); await pg.fill('#title', `Bathroom and roof ${tag}`); await pg.fill('#address', '1 Sample St');
  await shot(pg, `${tag}-02-customer`); await noSideways(pg, `${tag} customer`);
  await Promise.all([pg.waitForNavigation(), pg.click('text=Next: how to measure')]);
  await shot(pg, `${tag}-03-how`); await noSideways(pg, `${tag} how`);
  await Promise.all([pg.waitForNavigation(), pg.click('button.choice[value=manual]')]);
  const tid = pg.url().match(/estimate\/(\d+)\//)[1];
  await pg.click('.kindpick label:has-text("Room")');
  await pg.fill('#m_label', 'Bedroom'); await pg.fill('#m_length', '4.2'); await pg.fill('#m_width', '3.6'); await pg.fill('#m_height', '2.4');
  await pg.fill('[name=op_w] >> nth=0', '0.82'); await pg.fill('[name=op_h] >> nth=0', '2.04');
  check((await pg.textContent('#preview')).includes('Floor 15.12 m²'), `${tag} live preview of the room`);
  await Promise.all([pg.waitForNavigation(), pg.click('#m_save')]);
  check((await pg.textContent('#totals')).includes('15.12 m²'), `${tag} manual room saved: floor 15.12 m²`);
  await shot(pg, `${tag}-04-manual-room`); await noSideways(pg, `${tag} manual`);

  // plan: open, set the scale from the 1 m bar, draw the floor and a length
  await pg.goto(`${BASE}/estimate/${tid}/measure?m=plan`);
  await pg.waitForFunction(() => window.RE && RE.plan);   // plan.js is a module: wait until it's running
  await pg.setInputFiles('#planfile', PLAN);
  await pg.waitForFunction(() => window.RE && RE.plan && RE.plan.state().pageW > 0);
  // Playwright scrolls to each button it clicks, so bring the drawing back into view before every tap
  const toClient = async (x, y) => pg.evaluate(([x, y]) => { document.getElementById('stage').scrollIntoView({ block: 'center', behavior: 'instant' }); const s = RE.plan.state(); const r = document.getElementById('stage').getBoundingClientRect(); return [r.left + s.tx + x * s.z, r.top + s.ty + y * s.z]; }, [x, y]);
  const tap = async (x, y) => { const [cx, cy] = await toClient(x, y); await pg.mouse.click(cx, cy); await pg.waitForTimeout(400); };
  pg.once('dialog', (d) => d.accept('1'));
  await pg.click('[data-tool=scale]'); await tap(70, 420); await tap(170, 420);
  await pg.waitForFunction(() => /line of 1 m/.test(document.getElementById('scaleinfo').textContent));
  check(true, `${tag} plan scale set from a line of known length`);
  await pg.click('[data-tool=shape]'); await pg.fill('#d_label', 'Bathroom floor'); await pg.selectOption('#d_as', 'floor');
  for (const [x, y] of [[70, 60], [310, 60], [310, 360], [70, 360]]) await tap(x, y);
  check((await pg.textContent('#live')).includes('7.2 m²'), `${tag} live area while drawing`);
  await pg.click('#finish'); await pg.waitForFunction(() => /Bathroom floor/.test(document.getElementById('mlist').textContent));
  await pg.click('[data-tool=line]'); await pg.fill('#d_label', 'Vanity wall');
  await tap(70, 60); await tap(310, 60); await pg.click('#finish');
  await pg.waitForFunction(() => /Vanity wall/.test(document.getElementById('mlist').textContent));
  const tot = await pg.textContent('#totals');
  check(tot.includes('Area') && tot.includes('7.2 m²') && /Length\s*2\.4 m/.test(tot), `${tag} plan area 7.2 m² and length 2.4 m in totals`);
  await pg.click('#undo'); await pg.waitForFunction(() => !/Vanity wall/.test(document.getElementById('mlist').textContent));
  await pg.click('#redo'); await pg.waitForFunction(() => /Vanity wall/.test(document.getElementById('mlist').textContent));
  check(true, `${tag} undo and redo a saved measurement`);
  await pg.waitForTimeout(1500);   // the page picture for the PDF
  await shot(pg, `${tag}-05-plan`); await noSideways(pg, `${tag} plan`);

  // map: a roof face with a pitch, then its edges
  await pg.goto(`${BASE}/estimate/${tid}/measure?m=map`);
  await pg.waitForFunction(() => window.RE && RE.map && document.querySelector('.leaflet-tile-loaded'));
  check(!(await pg.content()).includes('arcgisonline'), `${tag} map uses the stand-in tiles`);
  check((await pg.textContent('.leaflet-control-attribution')).includes('Esri'), `${tag} Esri attribution shown`);
  check((await pg.textContent('.map-warn')).includes('verify on site'), `${tag} "verify on site" label`);
  await pg.evaluate(() => RE.map.map.setView([-33.8473, 151.0671], 20, { animate: false }));
  await pg.click('[data-tool=roof]'); await pg.fill('#d_pitch', '22.5'); await pg.fill('#d_label', 'North face');
  await pg.evaluate(() => document.getElementById('map').scrollIntoView({ block: 'center', behavior: 'instant' })); await pg.waitForTimeout(300);
  const box = await pg.locator('#map').boundingBox();
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.7, 0.6], [0.3, 0.6]]) { await pg.mouse.click(box.x + box.width * fx, box.y + box.height * fy); await pg.waitForTimeout(250); }
  await pg.click('#finish');
  await pg.waitForSelector('#edges:not([hidden])');
  await pg.selectOption('[data-edge="0"]', 'ridge'); await pg.selectOption('[data-edge="2"]', 'eave');
  await pg.selectOption('[data-edge="1"]', 'rake'); await pg.selectOption('[data-edge="3"]', 'rake');
  await pg.click('#edgesave'); await pg.waitForFunction(() => /Ridge/.test(document.getElementById('totals').textContent));
  const rt = await pg.textContent('#totals');
  check(/Roof area \(true, pitch applied\)/.test(rt) && /Rakes/.test(rt), `${tag} roof face saved with pitch and edges`);
  const ratio = await pg.evaluate(() => { const r = RE.items.find((i) => i.kind === 'roof'); const q = RG.quantities('roof', r.data); return q.roof_area / q.roof_plan_area; });
  check(Math.abs(ratio - 1.0824) < 0.001, `${tag} pitch factor 22.5° = 1.082 (${ratio.toFixed(4)})`);
  await shot(pg, `${tag}-06-map-roof`); await noSideways(pg, `${tag} map`);
  if (width < 500) { await pg.click('#sheet'); await shot(pg, `${tag}-06b-totals-sheet`); }

  // 4 template -> 5 price -> 6 send
  await pg.goto(`${BASE}/estimate/${tid}/template`);
  await pg.click('.choice:has-text("Tiling")'); await pg.click('.choice:has-text("Roofing")');
  await shot(pg, `${tag}-07-template`); await noSideways(pg, `${tag} template`);
  await Promise.all([pg.waitForNavigation(), pg.click('text=Next: review the price')]);
  const rate = pg.locator('input[name^=rate_]').first(); await rate.fill('65');
  await pg.fill('#markup', '10');
  await shot(pg, `${tag}-08-price`); await noSideways(pg, `${tag} price`);
  await Promise.all([pg.waitForNavigation(), pg.click('button[name=go][value=quote]')]);
  check(/\/send$/.test(pg.url()) && (await pg.textContent('.flash.ok')).includes('made'), `${tag} quote made`);
  const num = await pg.textContent('.est-head .sub a');
  check(/^Q\d+/.test(num.trim()), `${tag} quote number ${num.trim()}`);
  await shot(pg, `${tag}-09-send`); await noSideways(pg, `${tag} send`);
  const pdf = await pg.request.get(`${BASE}/estimate/${tid}/quote.pdf`);
  check(pdf.ok() && (await pdf.body()).slice(0, 5).toString() === '%PDF-', `${tag} quote PDF`);
  await pg.goto(BASE + '/estimate/'); await shot(pg, `${tag}-10-list`); await noSideways(pg, `${tag} list`);
  check(errs.length === 0, `${tag} no page errors ${errs.join(' | ')}`);
  await b.close();
}

(async () => {
  await run(1280, 860, 'desk');
  await run(390, 844, 'phone');
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
