// M21: accessibility checks on riyeser.com and Riyeser Link (what axe-core flagged in round 20), without extra packages:
//   small grey text on the home and pricing cards at least 4.5:1; heading levels never skip (h2 -> h4); "Skip to content"
//   is the first thing Tab reaches; in Link, white initials on every avatar colour at least 4.5:1, nothing that acts as a
//   button has buttons inside, the "Search people" box shows a focus ring, and the sign-in email box is autocomplete="username".
// With AXE=path/to/axe.min.js it also runs axe-core (WCAG 2 A/AA + best practice) on the same pages and lists what it finds.
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/a11y-test.js`. Exits 1 on failure.
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

// contrast of an element's text against the first solid background behind it
const CONTRAST = () => {
  const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c.length < 4 || c[3] > 0.9)) return c; } return [255, 255, 255]; };
  window.__contrast = (el) => { const a = lum(rgb(getComputedStyle(el).color)); const b = lum(bgOf(el)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
};

(async () => {
  const b = await chromium.launch(); const errs = [];
  const AXE = process.env.AXE ? fs.readFileSync(process.env.AXE, 'utf8') : null;
  const axe = async (pg, name) => { if (!AXE) return; await pg.addScriptTag({ content: AXE });
    const v = await pg.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] })).violations.map((x) => `${x.id} (${x.nodes.length})`));
    check(!v.length, `axe-core on ${name}: ${v.join(', ') || 'nothing'}`); };
  const page = async (path, w = 1280) => { const pg = await b.newPage({ viewport: { width: w, height: 900 } }); pg.on('pageerror', (e) => errs.push(path + ': ' + e.message));
    await pg.addInitScript(CONTRAST); await pg.goto(BASE + path); await pg.waitForTimeout(400); return pg; };

  for (const [path, sel] of [['/index.html', '.cfoot .cq'], ['/pricing.html', '.psub, .ptable small, .muted']]) {
    const pg = await page(path);
    const low = await pg.$$eval(sel, (els) => els.filter((e) => e.offsetParent && e.textContent.trim()).map((e) => [e.textContent.trim().slice(0, 30), window.__contrast(e)]).filter(([, c]) => c < 4.5));
    check(!low.length, `M21 ${path}: small grey text at least 4.5:1 ${low.map(([t, c]) => `"${t}" ${c.toFixed(2)}`).join(', ')}`);
    await axe(pg, path); await pg.close();
  }
  for (const path of ['/index.html', '/pricing.html', '/help.html', '/downloads.html']) {
    const pg = await page(path);
    const jumps = await pg.$$eval('h1, h2, h3, h4, h5, h6', (hs) => { const out = []; let last = 0;
      for (const h of hs) { const n = Number(h.tagName[1]); if (last && n > last + 1) out.push(`${h.tagName} "${h.textContent.trim().slice(0, 25)}" after h${last}`); last = n; } return out; });
    check(!jumps.length, `M21 ${path}: heading levels in order ${jumps.join('; ')}`);
    await pg.keyboard.press('Tab');
    const f = await pg.evaluate(() => { const a = document.activeElement; return { text: a.textContent.trim(), href: a.getAttribute('href'), seen: a.getBoundingClientRect().top >= 0, target: !!document.getElementById('main') }; });
    check(f.text === 'Skip to content' && f.href === '#main' && f.seen && f.target, `M21 ${path}: Tab first reaches a visible "Skip to content"`);
    await pg.close();
  }

  // ---- the download hand-off page (riyeser.com/download/<program>.html): the counter is refused and GitHub's file is a pretend one, so it stays put
  { const pg = await b.newPage({ viewport: { width: 1280, height: 900 } }); pg.on('pageerror', (e) => errs.push('/download/pos.html: ' + e.message));
    await pg.route('https://*.supabase.co/**', (r) => r.abort()); await pg.route('https://api.github.com/**', (r) => r.abort());
    await pg.route('https://github.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'content-disposition': 'attachment; filename=setup.exe' }, body: 'MZ' }));
    await pg.addInitScript(CONTRAST);
    await pg.goto(BASE + '/download/pos.html', { waitUntil: 'commit' }); await pg.waitForSelector('#dlgo'); await pg.waitForTimeout(600);
    const low = await pg.$$eval('.dlgo-sub, .dlgo-alt, .dlgo-steps small, .dlgo-back, .dlgo-st', (els) => els.filter((e) => e.offsetParent && e.textContent.trim()).map((e) => [e.textContent.trim().slice(0, 30), window.__contrast(e)]).filter(([, c]) => c < 4.5));
    check(!low.length, `download page: text at least 4.5:1 ${low.map(([t, c]) => `"${t}" ${c.toFixed(2)}`).join(', ')}`);
    check(await pg.$eval('#dlst', (e) => e.getAttribute('role') === 'status' && e.getAttribute('aria-live') === 'polite'), 'download page: the "starting / started" line is announced');
    await axe(pg, '/download/pos.html'); await pg.close(); }
  // ---- the hosted booking page (/book/): headings in order, every control named, contrast of the business's colour
  { const pg = await page('/book/?b=demo'); await pg.waitForSelector('[data-svc]');
    await pg.click('[data-svc=CUT]'); await pg.waitForSelector('.times [data-slot]'); await pg.click('.times [data-slot="0"]'); await pg.waitForSelector('#f-name');
    const jumps = await pg.$$eval('h1, h2, h3, h4', (hs) => { const out = []; let last = 0; for (const h of hs) { const n = Number(h.tagName[1]); if (last && n > last + 1) out.push(h.tagName); last = n; } return out; });
    check(!jumps.length && (await pg.$$('h1')).length === 1, `booking page: one h1, heading levels in order ${jumps.join(' ')}`);
    const unnamed = await pg.$$eval('button, input, textarea, a', (x) => x.filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length))).length);
    check(!unnamed, 'booking page: every control has a name');
    const low = await pg.$$eval('.step h2, .opt, .hint, .fine, .meta, .about dd a, #send, .step h2 .n', (els) => els.filter((e) => e.offsetParent && e.textContent.trim() && !e.disabled && !e.closest('.later')).map((e) => [e.textContent.trim().slice(0, 20), window.__contrast(e)]).filter(([, c]) => c < 4.5));
    check(!low.length, `booking page: text at least 4.5:1 ${low.map(([t, c]) => `"${t}" ${c.toFixed(2)}`).join(', ')}`);
    await axe(pg, '/book/?b=demo'); await pg.close(); }

  // ---- Riyeser Link
  { const pg = await page('/link/?demo');
    await pg.waitForSelector('#lkshell'); await pg.click('#infobtn'); await pg.waitForTimeout(300);   // the details (ⓘ): members with their status
    const avs = await pg.$$eval('.av', (x) => x.filter((e) => e.textContent.trim()).map((e) => [e.textContent, window.__contrast(e)]));
    check(avs.length > 3 && avs.every(([, c]) => c >= 4.5), `M21 Link: white initials at least 4.5:1 on every avatar (lowest ${Math.min(...avs.map((a) => a[1])).toFixed(2)})`);
    const nested = await pg.$$eval('[role=button]', (x) => x.filter((e) => e.querySelector('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).map((e) => e.className));
    check(!nested.length, `M21 Link: nothing acting as a button has buttons inside ${nested.join(', ')}`);
    const row = await pg.$('.lk-person.clk .lk-pn[role=button]');
    check(!!row, 'M21 Link: a person row is still opened from the keyboard (its name is the button)');
    const ps = await pg.$('#psearch');
    if (ps) { await ps.focus(); const ring = await pg.$eval('.lk-psearch', (e) => getComputedStyle(e).boxShadow);
      check(ring && ring !== 'none', `M21 Link: "Search people" shows a focus ring (${ring})`); }
    else check(false, 'M21 Link: the Search people box is there');
    await axe(pg, '/link/?demo'); await pg.close(); }
  { const pg = await page('/link/'); await pg.waitForSelector('#gf');
    check(await pg.getAttribute('#gf [name=email]', 'autocomplete') === 'username', 'M21 Link sign-in: the email box is autocomplete="username"');
    await axe(pg, '/link/ (sign in)'); await pg.close(); }

  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} ACCESSIBILITY CHECK(S) FAILED` : 'ALL ACCESSIBILITY CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
