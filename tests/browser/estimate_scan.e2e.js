// Riyeser Estimate, Import a scan, in a browser at 1280 and 390 (a phone, touch): import a RoomPlan-style scan ->
// check and edit the rooms -> use them -> the 3D mock-up renders (WebGL, SwiftShader in headless Chromium) and turns
// with a drag -> finish colours -> the floor plan -> a painting quote and its PDF. A raw mesh shows as an estimate.
// No sideways scrolling anywhere.
//   python tests/browser/serve_estimate.py 8091 8092 &   (prints SCAN and MESH paths)
//   SCAN=... MESH=... SHOTS=/some/folder node tests/browser/estimate_scan.e2e.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8091';
const SHOTS = process.env.SHOTS || path.join(require('os').tmpdir(), 'estimate-scan-shots');
const SCAN = process.env.SCAN, MESH = process.env.MESH;
fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
async function noSideways(pg, what) {
  const w = await pg.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check(w[0] <= w[1] + 1, `${what}: no sideways scroll (${w[0]} <= ${w[1]})`);
}
async function shot(pg, name, sel) {
  if (sel) {   // scrolled to the middle so the sticky top bar doesn't cover it
    await pg.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }), sel);
    await pg.waitForTimeout(200);
    await pg.locator(sel).screenshot({ path: path.join(SHOTS, name + '.png') });
  }
  else await pg.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
}

async function run(width, height, tag) {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: width < 500, isMobile: width < 500 });
  const pg = await ctx.newPage(); const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push(m.text()); if (process.env.DEBUG) console.log('console:', m.text()); });
  await pg.goto(BASE + '/login');
  await pg.fill('input[name=username]', 'admin'); await pg.fill('input[name=password]', 'admin');
  await Promise.all([pg.waitForNavigation(), pg.press('input[name=password]', 'Enter')]);

  // 1 customer -> 2 how: the fourth card
  await pg.goto(BASE + '/estimate/new');
  await pg.fill('#new_name', `Alex Chen ${tag}`); await pg.fill('#title', `Repaint the bedroom ${tag}`);
  await Promise.all([pg.waitForNavigation(), pg.click('text=Next: how to measure')]);
  check(await pg.isVisible('button.choice[value=scan]'), `${tag} "Import a scan" card on How to measure`);
  await shot(pg, `${tag}-01-how`); await noSideways(pg, `${tag} how`);
  await Promise.all([pg.waitForNavigation(), pg.click('button.choice[value=scan]')]);
  const tid = pg.url().match(/estimate\/(\d+)\//)[1];
  await pg.waitForFunction(() => window.RE && RE.view3d);
  await shot(pg, `${tag}-02-import`); await noSideways(pg, `${tag} import screen`);

  // import the RoomPlan-style scan: full rooms to check
  await pg.setInputFiles('#scanfile', SCAN);
  await pg.waitForSelector('#roomedit .roomcard');
  const card = await pg.textContent('#roomedit');
  check(/Full rooms/.test(card) && /Floor 15\.12 m²/.test(card), `${tag} scan read as a full room: floor 15.12 m²`);
  check((await pg.locator('#roomedit .oprow').count()) === 2, `${tag} a door and a window found`);
  await pg.fill('.rc-name', 'Main bedroom'); await pg.press('.rc-name', 'Tab');
  await pg.locator('[data-wall="0"]').fill('4.25'); await pg.press('[data-wall="0"]', 'Tab');
  check(/perimeter 15\.65 m/.test(await pg.textContent('[data-fig="0"]')), `${tag} editing a wall updates the room's figures`);
  await pg.locator('#roomedit').scrollIntoViewIfNeeded();
  await shot(pg, `${tag}-03-check-rooms`); await noSideways(pg, `${tag} check rooms`);
  await pg.click('#re_use');
  await pg.waitForFunction(() => /Main bedroom/.test(document.getElementById('mlist').textContent));
  const tot = await pg.textContent('#totals');
  check(/Floor area\s*15\.12 m²/.test(tot) && /Doors\s*1/.test(tot), `${tag} rooms used: totals have floor area and doors`);

  // the 3D mock-up
  await pg.waitForFunction(() => document.getElementById('three').dataset.ready === '1', null, { timeout: 20000 });
  const v = await pg.evaluate(() => ({ walls: RE.view3d.walls, openings: RE.view3d.openings, err: RE.view3d.error }));
  check(v.walls === 4 && v.openings === 2 && !v.err, `${tag} 3D: 4 walls, a door and a window (${JSON.stringify(v)})`);
  await pg.waitForTimeout(600);
  const drawn = await pg.evaluate(() => {
    const c = document.querySelector('#three canvas'); const t = document.createElement('canvas'); t.width = 64; t.height = 48;
    const g = t.getContext('2d'); g.drawImage(c, 0, 0, 64, 48); const d = g.getImageData(0, 0, 64, 48).data; const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
    return seen.size;
  });
  check(drawn > 6, `${tag} 3D view rendered with WebGL (${drawn} colours on the canvas)`);
  check((await pg.locator('.v3d-label.len').count()) >= 4, `${tag} 3D wall sizes shown`);
  await pg.locator('#view3d').scrollIntoViewIfNeeded();
  await shot(pg, `${tag}-04-3d`, '#view3d');
  // turn it with a drag (a finger on the phone)
  const before = await pg.evaluate(() => RE.view3d.camera.position.toArray());
  const box = await pg.locator('#three canvas').boundingBox();
  if (width < 500) {
    const cdp = await ctx.newCDPSession(pg);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let k = 1; k <= 8; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + k * 15, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await pg.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await pg.mouse.down();
    await pg.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2, { steps: 8 }); await pg.mouse.up();
  }
  await pg.waitForTimeout(500);
  const after = await pg.evaluate(() => RE.view3d.camera.position.toArray());
  check(Math.hypot(after[0] - before[0], after[2] - before[2]) > 0.2, `${tag} 3D view turns with a ${width < 500 ? 'finger' : 'mouse'} drag`);
  // finish preview: wall and floor colours, openings off and on
  await pg.evaluate(() => { const w = document.getElementById('v_wall'); w.value = '#6b8f71'; w.dispatchEvent(new Event('input')); const f = document.getElementById('v_floor'); f.value = '#3f3a36'; f.dispatchEvent(new Event('input')); });
  await pg.uncheck('#v_openings'); check(await pg.evaluate(() => RE.view3d.openings === 0), `${tag} openings toggle off`);
  await pg.check('#v_openings'); check(await pg.evaluate(() => RE.view3d.openings === 2), `${tag} openings toggle on`);
  await pg.check('#v_scan'); await pg.waitForTimeout(800);
  await pg.uncheck('#v_scan');
  await pg.waitForTimeout(300);
  await pg.locator('#view3d').scrollIntoViewIfNeeded();
  await shot(pg, `${tag}-05-3d-colours`, '#view3d'); await noSideways(pg, `${tag} 3D`);

  // the floor plan
  const fp = await pg.evaluate(() => { const s = document.querySelector('#fpwrap svg'); return s ? { walls: s.querySelectorAll('.wall').length, doors: s.querySelectorAll('.door').length, txt: s.textContent } : null; });
  check(fp && fp.walls === 4 && fp.doors === 1 && /Main bedroom/.test(fp.txt) && /4\.25 m/.test(fp.txt), `${tag} floor plan: walls, door, name and the edited size`);
  await pg.locator('#floorplan').scrollIntoViewIfNeeded();
  await shot(pg, `${tag}-06-floorplan`, '#floorplan');

  // a raw mesh: an estimate to check on site (looked at, then closed without using it)
  if (MESH && width >= 500) {
    await pg.evaluate(() => window.scrollTo(0, 0));
    await pg.setInputFiles('#scanfile', MESH);
    await pg.waitForFunction(() => /Estimated from a 3D mesh/.test((document.getElementById('roomedit') || {}).textContent || ''));
    check(/check on site/.test(await pg.textContent('#roomedit')), `${tag} mesh scan marked "check on site"`);
    await pg.locator('#roomedit').scrollIntoViewIfNeeded();
    await shot(pg, `${tag}-07-mesh-estimate`);
    await pg.click('#re_cancel');
  }

  // 4 template -> 5 price -> quote and PDF
  await pg.goto(`${BASE}/estimate/${tid}/template`);
  await pg.click('.choice:has-text("Painting")');
  await Promise.all([pg.waitForNavigation(), pg.click('text=Next: review the price')]);
  const price = await pg.textContent('body');
  check(/Paint walls \(2 coats\)/.test(price) && /Paint doors/.test(price), `${tag} painting template priced the scanned room`);
  await pg.locator('input[name^=rate_]').first().fill('14');
  await shot(pg, `${tag}-08-price`); await noSideways(pg, `${tag} price`);
  await Promise.all([pg.waitForNavigation(), pg.click('button[name=go][value=quote]')]);
  check(/\/send$/.test(pg.url()), `${tag} quote made`);
  const pdf = await pg.request.get(`${BASE}/estimate/${tid}/quote.pdf`);
  check(pdf.ok() && (await pdf.body()).slice(0, 5).toString() === '%PDF-', `${tag} quote PDF (with the floor plan page)`);
  fs.writeFileSync(path.join(SHOTS, `${tag}-09-quote.pdf`), await pdf.body());
  await shot(pg, `${tag}-09-send`); await noSideways(pg, `${tag} send`);
  check(errs.length === 0, `${tag} no page errors ${errs.join(' | ')}`);
  await b.close();
}

(async () => {
  await run(1280, 860, 'desk');
  await run(390, 844, 'phone');
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
