// The signing page (riyeser.com/sign/?t=…, website/sign) against a pretend "sign" Edge Function (Playwright answers
// requests to its real address) and a synthetic two-page PDF.
//  1. Sign: the request (business, who asked, the message, sign-by date), both pages drawn, only this signer's fields
//     highlighted; Finish waits for every field and "I agree to sign electronically"; draw a signature and initials →
//     every Sign here / Initial is filled; the name is filled in; the date is today's → Finish → "You've signed". What
//     was sent: the link, agree: true, exactly this signer's field ids, PNG signatures, "drawn", today's date. Typed
//     signatures too (phone width).
//  2. Decline: a reason is needed → "You declined to sign" with the reason.
//  3. Expired: "This request has expired" (and no document is asked for). 4. A wrong link: "This link isn't working";
//     a link that isn't even the right shape never reaches the function; no link at all. 5. Completed: Download the
//     signed copy. 6. Busy (429), a document whose fingerprint doesn't match.
//  7. Privacy: nothing but riyeser.com and the function is loaded, no cookies or browser storage, no referrer sent,
//     noindex, robots.txt has Disallow: /sign/, no CSP refusals, no sideways scrolling at 390.
// Run: node website/build-combined.mjs (or build.mjs), then `node website/team/test/sign-page-test.js <shots folder>`
// (it serves website/public itself on 18741). Exits 1 on failure.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PUB = path.join(__dirname, '..', '..', 'public');
const SITE = 'http://127.0.0.1:18741';
const API = 'https://goaugynxeatzqzifpoes.supabase.co/functions/v1/sign';
const out = process.argv[2] || '.';
fs.mkdirSync(out, { recursive: true });
const PDFLib = require(path.join(__dirname, '..', '..', 'services', 'vendor', 'pdf-lib.min.js'));

const tok = (c) => c.repeat(64);
const T = { ok: tok('a'), typed: tok('b'), decline: tok('c'), expired: tok('d'), bad: tok('e'), done: tok('f'), busy: tok('1'), changed: tok('2') };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const site = http.createServer((req, res) => {
  const u = new URL(req.url, SITE); let f = path.join(PUB, decodeURIComponent(u.pathname));
  if (!f.startsWith(PUB)) { res.writeHead(400); return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});

async function samplePdf(title) {
  const d = await PDFLib.PDFDocument.create(); const f = await d.embedFont(PDFLib.StandardFonts.Helvetica); const b = await d.embedFont(PDFLib.StandardFonts.HelveticaBold);
  for (let i = 1; i <= 2; i++) {
    const p = d.addPage([595, 842]);
    p.drawText(i === 1 ? title : `${title} (continued)`, { x: 56, y: 770, size: 20, font: b });
    const lines = i === 1 ? ['Between Sample Plumbing Ltd and Pat Client (synthetic test document).', '1. Sample Plumbing will service the hot water system every 6 months.',
      '2. The fee is shown on the attached quote.', '3. Either side can end this agreement with 30 days notice in writing.'] : ['4. This is a synthetic document made for testing only.', '5. Nothing in it is a real agreement.'];
    lines.forEach((l, k) => p.drawText(l, { x: 56, y: 720 - k * 22, size: 12, font: f }));
    p.drawText(i === 1 ? 'Customer signature:' : 'Witness:', { x: 56, y: 230, size: 11, font: f });
    p.drawLine({ start: { x: 56, y: 170 }, end: { x: 300, y: 170 }, thickness: 0.8 });
  }
  return Buffer.from(await d.save());
}
const FIELDS = [{ id: 's1', kind: 'signature', signer: 1, page: 1, x: 0.094, y: 0.69, w: 0.36, h: 0.07 }, { id: 'd1', kind: 'date', signer: 1, page: 1, x: 0.55, y: 0.72, w: 0.22, h: 0.035 },
  { id: 'n1', kind: 'name', signer: 1, page: 1, x: 0.55, y: 0.67, w: 0.3, h: 0.035 }, { id: 'i1', kind: 'initials', signer: 1, page: 2, x: 0.8, y: 0.9, w: 0.1, h: 0.05 },
  { id: 's1b', kind: 'signature', signer: 1, page: 2, x: 0.094, y: 0.69, w: 0.36, h: 0.07 }];
const REQ = { id: '0d6c3f0e-1111-4c2b-9d1e-222233334444', title: 'Hot water service agreement', sender: 'Alex Sample', company: 'Sample Plumbing', expires_at: '2026-12-28T00:00:00Z', pages: 2, finished_at: null };
const st = { posts: [], doc: 0, opens: 0 };
let PDF; let PDF_SHA;
async function fnRoute(route) {
  const r = route.request(); const action = new URL(r.url()).pathname.split('/').pop(); const origin = r.headers().origin || '';
  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'X-Doc-Sha256, X-Doc-Kind', 'Cache-Control': 'no-store' };
  if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type' } });
  const body = JSON.parse(r.postData() || '{}'); st.posts.push({ action, body, headers: r.headers() });
  const send = (status, j) => route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(j) });
  const t = body.t;
  if (t === T.busy) return send(429, { state: 'busy' });
  if (action === 'open') {
    st.opens++;
    if (t === T.expired) return send(200, { state: 'expired', request: { ...REQ, expires_at: '2026-11-20T00:00:00Z' }, signer: { name: 'Pat Client', position: 1 } });
    if (t === T.done) return send(200, { state: 'completed', request: REQ, signer: { name: 'Pat Client', position: 1 }, signed_sha256: 'b'.repeat(64) });
    if (![T.ok, T.typed, T.decline, T.changed].includes(t)) return send(200, { state: 'unknown' });
    return send(200, { state: 'ready', request: REQ, signer: { name: 'Pat Client', position: 1, signed_at: null }, message: 'Hi Pat, please sign by Friday.\nThanks, Alex', sha256: PDF_SHA, fields: FIELDS, others: 1 });
  }
  if (action === 'doc') {
    st.doc++;
    if (t === T.expired || t === T.bad) return send(404, { error: 'This document isn\'t available.', state: 'closed' });
    const sha = t === T.changed ? 'c'.repeat(64) : PDF_SHA;
    return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/pdf', 'X-Doc-Sha256': sha }, body: PDF });
  }
  if (action === 'finish') return send(200, { state: 'signed' });
  if (action === 'decline') return body.reason && body.reason.length >= 2 ? send(200, { state: 'you_declined' }) : send(400, { error: 'Say briefly why you\'re declining (up to 500 characters).' });
  return send(404, { error: 'Not found.' });
}

(async () => {
  PDF = await samplePdf('Hot water service agreement'); PDF_SHA = crypto.createHash('sha256').update(PDF).digest('hex');
  await new Promise((ok) => site.listen(18741, '127.0.0.1', ok));
  const b = await chromium.launch(); let failed = 0; const errs = []; const external = [];
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
  const ctxs = [];
  const open = async (t, o = {}) => {
    const ctx = await b.newContext({ viewport: o.vp || { width: 1366, height: 900 }, colorScheme: o.dark ? 'dark' : 'light', locale: 'en-AU', timezoneId: 'Pacific/Fiji', deviceScaleFactor: 1, acceptDownloads: true });
    ctxs.push(ctx);
    await ctx.route(API + '/**', fnRoute);
    ctx.on('request', (r) => { const u = r.url(); if (!u.startsWith(SITE) && !u.startsWith(API) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u); });
    const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await pg.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
    await pg.goto(`${SITE}/sign/${t === null ? '' : `?t=${t}`}`); return pg;
  };
  const text = (pg) => pg.evaluate(() => document.body.innerText);
  const shot = (pg, name, full = false) => pg.screenshot({ path: path.join(out, name), fullPage: full });
  const noSideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const drawOn = async (pg, sel) => {
    const bx = await pg.locator(sel).boundingBox();
    await pg.mouse.move(bx.x + bx.width * 0.15, bx.y + bx.height * 0.6); await pg.mouse.down();
    for (let i = 0; i <= 24; i++) await pg.mouse.move(bx.x + bx.width * (0.15 + i * 0.028), bx.y + bx.height * (0.6 - Math.sin(i / 2.2) * 0.25), { steps: 2 });
    await pg.mouse.up();
  };
  try {
    // ---- 1. sign (desktop, drawn)
    let pg = await open(T.ok);
    await pg.waitForSelector('.page canvas'); await pg.waitForFunction(() => document.querySelectorAll('.page').length === 2 && document.querySelectorAll('.fld').length === 5);
    await pg.waitForTimeout(400);
    const t1 = await text(pg);
    check(/Sample Plumbing · Alex Sample asked you to sign/.test(t1) && /Hot water service agreement/.test(t1) && /Hi Pat, please sign by Friday/.test(t1) && /Sign by 28 December 2026/.test(t1), 'the request: business, who asked, the message, the sign-by date');
    check(await pg.title() === 'Sign Hot water service agreement · Riyeser', 'the title');
    check(await pg.$eval('.fld.k-name input', (e) => e.value) === 'Pat Client', 'the name is filled in');
    check(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(await pg.$eval('.fld.k-date', (e) => e.textContent.trim())), 'the date is today\'s, filled in');
    check(await pg.$eval('#finish', (e) => e.disabled), 'Finish waits until everything is done');
    check(st.doc === 1 && st.posts.every((p) => p.body.t === T.ok), 'the document is fetched once, with the link in the body (not the address)');
    await shot(pg, 'sign-page-1366.png');
    await pg.screenshot({ path: path.join(out, 'sign-page-1366-full.png'), fullPage: true });
    await pg.click('.fld.k-signature >> nth=0');
    await pg.waitForSelector('.modal #padS');
    await drawOn(pg, '#padS'); await drawOn(pg, '#padI');
    await shot(pg, 'sign-adopt-1366.png');
    await pg.click('#use');
    await pg.waitForFunction(() => document.querySelectorAll('.fld.ok img').length === 3);
    check(await pg.$eval('#finish', (e) => e.disabled), 'all fields filled, but not agreed yet: still waiting');
    check(/Tick “I agree to sign electronically” to finish/.test(await text(pg)), 'it says what\'s missing');
    await pg.check('#agree');
    check(!(await pg.$eval('#finish', (e) => e.disabled)), 'agreed: Finish is ready');
    await pg.locator('.fld.k-signature >> nth=0').scrollIntoViewIfNeeded();
    await shot(pg, 'sign-ready-1366.png');
    await pg.click('#finish');
    await pg.waitForSelector('.st-signed');
    const fin = st.posts.find((p) => p.action === 'finish');
    check(fin && fin.body.t === T.ok && fin.body.agree === true && fin.body.method === 'drawn' && /^\d{4}-\d{2}-\d{2}$/.test(fin.body.day), 'sent: the link, agree, drawn, today');
    check(fin && Object.keys(fin.body.values).sort().join() === 'd1,i1,n1,s1,s1b' && /^data:image\/png;base64,/.test(fin.body.values.s1) && /^data:image\/png;base64,/.test(fin.body.values.i1)
      && fin.body.values.s1 === fin.body.values.s1b && fin.body.values.n1 === 'Pat Client', 'exactly this signer\'s fields, PNG signature and initials');
    check(/You've signed/.test(await text(pg)) && /we'll email you a link to download the signed copy/i.test(await text(pg)), '"You\'ve signed", and what happens next');
    check(fin && fin.headers.referer === undefined, 'no referrer sent to the function');
    await shot(pg, 'sign-done-1366.png');
    const storage = await pg.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, ck: document.cookie }));
    check(storage.ls === 0 && storage.ss === 0 && storage.ck === '', 'nothing kept in the browser (no storage, no cookies)');
    check((await pg.evaluate(() => window.__csp)).length === 0, 'no Content-Security-Policy refusals');
    check(await pg.$eval('meta[name=robots]', (e) => e.content) === 'noindex, nofollow' && await pg.$eval('meta[name=referrer]', (e) => e.content) === 'no-referrer', 'noindex and no referrer');

    // ---- 1b. typed, on a phone
    pg = await open(T.typed, { vp: { width: 390, height: 844 } });
    await pg.waitForFunction(() => document.querySelectorAll('.fld').length === 5); await pg.waitForTimeout(300);
    check(await noSideways(pg), 'phone: no sideways scrolling');
    check(await pg.isVisible('.mobar') && /to fill in/.test(await pg.textContent('#mocount')), 'phone: the bar along the bottom says what\'s left');
    await shot(pg, 'sign-page-390.png');
    await pg.click('#adopt'); await pg.click('[data-tab=type]');
    await pg.fill('#tName', 'Pat Q Client');
    check(await pg.inputValue('#tIni') === 'PQC', 'typed: initials from the name');
    await pg.click('.sty >> nth=1');
    await shot(pg, 'sign-adopt-typed-390.png');
    await pg.click('#use');
    await pg.waitForFunction(() => document.querySelectorAll('.fld.ok img').length === 3);
    await pg.check('#agree');
    check(await noSideways(pg), 'phone: still no sideways scrolling');
    await pg.click('#finish'); await pg.waitForSelector('.st-signed');
    const fin2 = st.posts.filter((p) => p.action === 'finish').pop();
    check(fin2.body.method === 'typed' && /^data:image\/png;base64,/.test(fin2.body.values.s1), 'typed: sent as a typed, adopted signature (a PNG)');
    await shot(pg, 'sign-done-390.png');

    // ---- 2. decline
    for (const vp of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
      pg = await open(T.decline, { vp });
      await pg.waitForFunction(() => document.querySelectorAll('.fld').length === 5);
      await pg.click('#decline'); await pg.waitForSelector('#why2');
      await pg.click('#dgo');
      check(/Say briefly why/.test(await pg.textContent('#derr')), `decline (${vp.width}): a reason is needed`);
      await pg.fill('#why2', 'The fee isn\'t what we agreed on the phone.');
      await shot(pg, `sign-decline-box-${vp.width}.png`);
      await pg.click('#dgo'); await pg.waitForSelector('.st-you_declined');
      const dec = st.posts.filter((p) => p.action === 'decline').pop();
      check(dec.body.reason === 'The fee isn\'t what we agreed on the phone.' && dec.body.t === T.decline, `decline (${vp.width}): the reason is sent with the link`);
      check(/You declined to sign/.test(await text(pg)) && /The fee isn't what we agreed/.test(await text(pg)) && /Alex Sample at Sample Plumbing/.test(await text(pg)), `decline (${vp.width}): the screen says so, with the reason`);
      check(await noSideways(pg), `decline (${vp.width}): no sideways scrolling`);
      await shot(pg, `sign-declined-${vp.width}.png`);
    }

    // ---- 3. expired, 4. wrong links, 5. completed, 6. busy and changed
    for (const vp of [{ width: 1366, height: 800 }, { width: 390, height: 844 }]) {
      const docsBefore = st.doc;
      pg = await open(T.expired, { vp }); await pg.waitForSelector('.st-expired');
      check(/This request has expired/.test(await text(pg)) && /20 November 2026/.test(await text(pg)) && /Ask Alex Sample at Sample Plumbing to send it to you again/.test(await text(pg)), `expired (${vp.width})`);
      check(st.doc === docsBefore, `expired (${vp.width}): the document isn't asked for`);
      await shot(pg, `sign-expired-${vp.width}.png`);
      pg = await open(T.bad, { vp }); await pg.waitForSelector('.st-unknown');
      check(/This link isn't working/.test(await text(pg)) && /a reminder sends a new link/.test(await text(pg)), `a wrong link (${vp.width})`);
      await shot(pg, `sign-wrong-link-${vp.width}.png`);
    }
    const before = st.posts.length;
    pg = await open('not-a-real-link'); await pg.waitForSelector('.st-missing');
    check(st.posts.length === before, 'a link of the wrong shape never reaches the function');
    pg = await open(null); await pg.waitForSelector('.st-missing');
    check(/There's no link here/.test(await text(pg)), 'no link at all');
    pg = await open(T.done); await pg.waitForSelector('.st-completed');
    check(/Everyone has signed/.test(await text(pg)) && /b{64}/.test(await text(pg)), 'completed: the signed file\'s fingerprint');
    const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('[data-act=download]')]);
    check(dl.suggestedFilename() === 'Hot water service agreement (signed).pdf', 'completed: Download the signed copy');
    await shot(pg, 'sign-completed-1366.png');
    pg = await open(T.busy); await pg.waitForSelector('.st-busy');
    check(/Too many tries/.test(await text(pg)), 'too many tries (429)');
    pg = await open(T.changed); await pg.waitForSelector('.st-changed');
    check(/This document has changed/.test(await text(pg)), 'a document whose fingerprint doesn\'t match isn\'t shown');
    pg = await open(T.ok, { vp: { width: 1366, height: 900 }, dark: true });
    await pg.waitForFunction(() => document.querySelectorAll('.fld').length === 5); await pg.waitForTimeout(300);
    await shot(pg, 'sign-page-dark-1366.png');

    // ---- axe-core (WCAG 2 A/AA + best practice) when AXE=path/to/axe.min.js is given (its own context: axe is an inline script)
    if (process.env.AXE) {
      const AXE = fs.readFileSync(process.env.AXE, 'utf8');
      for (const [t, vp, step] of [[T.ok, 1366, 'signing'], [T.ok, 390, 'signing (phone)'], [T.ok, 1366, 'adopt'], [T.decline, 1366, 'declined'], [T.expired, 390, 'expired'], [T.bad, 1366, 'wrong link']]) {
        const ctx = await b.newContext({ viewport: { width: vp, height: 900 }, bypassCSP: true }); ctxs.push(ctx); await ctx.route(API + '/**', fnRoute);
        const p2 = await ctx.newPage(); await p2.goto(`${SITE}/sign/?t=${t}`); await p2.waitForSelector('#main'); await p2.waitForTimeout(800);
        if (step === 'adopt') { await p2.click('#adopt'); await p2.waitForSelector('.modal'); }
        if (step === 'declined') { await p2.waitForSelector('#decline'); await p2.click('#decline'); await p2.fill('#why2', 'Not agreed.'); await p2.click('#dgo'); await p2.waitForSelector('.st-you_declined'); }
        await p2.addScriptTag({ content: AXE });
        const v = await p2.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] })).violations.map((x) => `${x.id} (${x.nodes.length}: ${x.nodes[0].target.join(' ')})`));
        check(!v.length, `axe-core, ${step} at ${vp}: ${v.join(', ') || 'nothing'}`);
      }
    }
    // ---- 7. privacy and search engines
    check(external.length === 0, 'nothing loaded from anywhere else: ' + external.slice(0, 3).join(', '));
    const robots = fs.readFileSync(path.join(PUB, 'robots.txt'), 'utf8');
    check(/^Disallow: \/sign\/$/m.test(robots), 'robots.txt: Disallow: /sign/');
    check(!fs.readFileSync(path.join(PUB, 'sitemap.xml'), 'utf8').includes('/sign/'), 'not in the sitemap');
    check(!/ESIGN|eIDAS|legally binding|compl(y|ies|iant)/i.test(fs.readFileSync(path.join(PUB, 'sign', 'sign.js'), 'utf8') + fs.readFileSync(path.join(PUB, 'sign', 'index.html'), 'utf8')), 'no claim about any e-signature law');
    check(errs.length === 0, 'no page errors: ' + errs.slice(0, 3).join(' | '));
  } catch (e) { console.log('FAIL ' + e.stack); failed++; }
  for (const c of ctxs) await c.close().catch(() => {});
  await b.close(); site.close();
  console.log(failed ? `${failed} FAILED` : 'ALL SIGNING PAGE TESTS PASSED');
  process.exit(failed ? 1 : 0);
})();
