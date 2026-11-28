// Riyeser HQ → Downloads in demo mode: the headline tiles (real downloads, new installs, updates), the hidden counts in
// small print (tests, staff, bots), the 30 / 90 day chart with numbers on hover and a per-program filter, by program,
// country and the page the button was on, "Don't count downloads from this browser" (kept for the website's download
// page), the raw GitHub counts collapsed until opened, an older database, and a phone with no sideways scrolling.
// Also the website's download hand-off page (riyeser.com/download/<program>.html): every Download button goes there,
// it asks the download counter, passes staff / test / where the button was, and goes to GitHub when the counter is
// missing or slow. GitHub and the counter are pretend (routed), so nothing real is counted.
// Run: build the site (node website/build-combined.mjs), serve website/public on port 8090, then
// `node website/hq/test-hq-downloads.js [screenshot folder]`. Exits 1 on failure.
const { chromium, devices } = require('playwright'); const path = require('path');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090'; const out = process.argv[2];
let bad = 0; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++; };
const points = (pg) => pg.evaluate(() => document.querySelector('#dlChart .lc .ln').getAttribute('points').split(' ').length);
// The public downloads repository's releases, and the code repository's (older ones, and a copy of the newest while
// both get them): added together, one release per tag.
const RELEASES = [{ tag_name: 'riyeser-2026.11.27-60', published_at: '2026-11-27T01:00:00Z',
  assets: [{ name: 'RiyeserCentral-Setup.exe', download_count: 4000 }, { name: 'RiyeserPOS-Setup.exe', download_count: 880 }] }];
const OLD_RELEASES = [{ tag_name: 'riyeser-2026.11.27-60', published_at: '2026-11-27T01:00:00Z', assets: [{ name: 'RiyeserCentral-Setup.exe', download_count: 210 }] },
  { tag_name: 'riyeser-2026.11.24-58', published_at: '2026-11-24T01:00:00Z', assets: [{ name: 'RiyeserCentral-Setup.exe', download_count: 100 }] }];
const DL = 'https://github.com/raka1987/riyeser-downloads/releases';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  let gh = 0;
  const ghAsked = [];
  await ctx.route('https://api.github.com/**', (r) => { gh++; const u = r.request().url(); ghAsked.push(u);
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(/\/repos\/raka1987\/riyeser-downloads\//.test(u) ? RELEASES : OLD_RELEASES) }); });
  const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(BASE + '/hq/?demo#/downloads'); await pg.waitForSelector('#dlChart');
  const tiles = await pg.evaluate(() => [...document.querySelectorAll('.dltiles .tile')].map((t) => t.innerText));
  check(tiles.length === 4 && /Real downloads/.test(tiles[0]) && /New installs/.test(tiles[1]) && /Updates/.test(tiles[2]) && /once a day/.test(tiles[0]), 'tiles: real downloads, new installs, updates');
  check(/^Hidden: tests \d[\d,]*, staff \d[\d,]*, bots \d[\d,]*/.test(await pg.textContent('#dlhidden')), 'hidden tests, staff and bots in small print');
  check(await points(pg) === 30, 'a point a day for 30 days');
  const bb = await (await pg.$('#dlChart .lc-plot')).boundingBox(); await pg.mouse.move(bb.x + bb.width * 0.6, bb.y + 40);
  check(/real downloads.*new installs/.test(await pg.textContent('#dlChart .lc-tip')), 'the chart shows the numbers on hover'); await pg.mouse.move(2, 2);
  check((await pg.$$('#dlProgs tr')).length > 5 && (await pg.$$('#dlCountries .hb')).length > 4 && (await pg.$$('#dlFrom .hb')).length > 4, 'by program, by country, by page');
  check(/Fiji/.test(await pg.textContent('#dlCountries')) && /Downloads page/.test(await pg.textContent('#dlFrom')), 'country names and page names');
  check(gh === 0 && !(await pg.$eval('#dlraw', (d) => d.open)), 'raw GitHub counts collapsed (and not fetched) until opened');
  if (out) await pg.screenshot({ path: path.join(out, 'hq-downloads.png'), fullPage: true });
  await pg.click('#dlraw summary'); await pg.waitForSelector('#dlrawb .tiles');
  check(/include tests and update checks/.test(await pg.textContent('#dlraw summary')) && /5,190/.test(await pg.textContent('#dlrawb')) && /2 releases/.test(await pg.textContent('#dlrawb'))
    && /27-60[\s\S]*5,090/.test(await pg.textContent('#dlrawb')), 'opened: GitHub\'s totals (both repositories added together, one release per tag)');
  check(ghAsked.some((u) => u.includes('/repos/raka1987/riyeser-downloads/releases')) && ghAsked.some((u) => u.includes('/repos/raka1987/Riyeser/releases')), 'raw counts: the downloads repository and the code repository');
  if (out) await pg.screenshot({ path: path.join(out, 'hq-downloads-raw.png'), fullPage: true });
  await pg.click('[data-dlp="POS"]'); await pg.waitForSelector('[data-dlp="POS"].on');
  check(/POS/.test(await pg.textContent('#dlChart h3')), 'chart for one program');
  if (out) await (await pg.$('#dlChart')).screenshot({ path: path.join(out, 'hq-downloads-pos.png') });
  await pg.click('[data-dlr="90"]'); await pg.waitForSelector('[data-dlr="90"].on');
  check(await points(pg) === 90, '90 days');
  await pg.check('#dlstaff');
  check(await pg.evaluate(() => localStorage.getItem('riyeser-hq-nocount')) === '1', '"Don\'t count downloads from this browser" is kept for the website');
  // an older database without hq_real_downloads: a plain message, the raw counts still there
  const old = await ctx.newPage(); old.on('pageerror', (e) => errs.push('old db: ' + e.message));
  await old.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"k"};' }));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); const user = { id: 'u1', email: 'sam@riyeser.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
  const tok = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
  await old.addInitScript(([t, u]) => localStorage.setItem('riyeser.hq.session', JSON.stringify({ access_token: t, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: u })), [tok, user]);
  const OLD = ['hq_me', 'hq_overview', 'hq_companies', 'hq_staff_list', 'hq_history', 'hq_downloads', 'hq_licences'];
  await old.route('https://fake.supabase.test/**', (r) => { const u = new URL(r.request().url()); const fn = u.pathname.replace('/rest/v1/rpc/', '');
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (u.pathname === '/auth/v1/user') return json(user);
    if (fn === 'hq_me') return json({ role: 'owner', name: 'Sam', active: true, two_step: true });
    if (fn === 'hq_overview') return json({ companies: 1, versions: [], countries: [], signups_by_week: [], trials_ending: [] });
    if (u.pathname.startsWith('/rest/v1/rpc/') && !OLD.includes(fn)) return json({ code: 'PGRST202', message: `Could not find the function public.${fn}` }, 404);
    return json([]); });
  await old.goto(BASE + '/hq/#/downloads'); await old.waitForSelector('#dl .banner', { timeout: 15000 });
  check(/latest team-chat\.sql/.test(await old.textContent('#dl')) && !!(await old.$('#dlraw')), 'older database: says what to run');
  await old.close();
  // a phone
  const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
  await ph.goto(BASE + '/hq/?demo#/downloads'); await ph.waitForSelector('#dlChart');
  check(await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'phone: no sideways scrolling');
  if (out) await ph.screenshot({ path: path.join(out, 'hq-downloads-phone.png'), fullPage: true });

  // ---- the website: Download buttons, the hand-off page
  const sctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await sctx.addInitScript(() => { try { localStorage.setItem('riyeser-hq-nocount', '1'); } catch (e) { /* */ } });
  const site = await sctx.newPage(); site.on('pageerror', (e) => errs.push('site: ' + e.message));
  await site.goto(BASE + '/downloads.html');
  const hrefs = await site.$$eval('main a.btn', (as) => as.map((a) => a.getAttribute('href')).filter((h) => /download\/|releases/.test(h)));
  check(hrefs.length > 5 && hrefs.every((h) => /^(\.\.\/)*download\/[a-z-]+\.html$/.test(h)), `every Download button goes to the hand-off page (${hrefs.length})`);
  const asked = []; let answer = 'ok';
  await sctx.route('https://*.supabase.co/functions/v1/download/**', (r) => { asked.push(r.request().url());
    if (answer === 'down') return r.abort();
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ url: `${DL}/download/riyeser-2026.11.27-60/RiyeserPOS-Setup.exe`, tag: 'riyeser-2026.11.27-60' }) }); });
  const went = [];
  await sctx.route(`${DL}/**`, (r) => { went.push(r.request().url()); r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'content-disposition': 'attachment; filename=setup.exe' }, body: 'MZ' }); });
  await site.goto(BASE + '/programs/pos.html'); await site.click('.phero a.btn.p.big');
  await site.waitForFunction(() => /started/.test((document.getElementById('dlst') || {}).textContent || ''));
  const q = new URL(asked[0]).searchParams;
  check(/\/download\/pos$/.test(new URL(asked[0]).pathname) && q.get('file') === 'RiyeserPOS-Setup.exe' && q.get('js') === '1' && q.get('mode') === 'json'
    && q.get('from') === '/programs/pos.html' && q.get('staff') === '1' && q.get('test') === '1' && q.get('wd') === '1', `the page asks the counter: ${asked[0]}`);
  check(went.some((u) => /riyeser-2026\.11\.27-60\/RiyeserPOS-Setup\.exe$/.test(u)), 'then the download starts from GitHub');
  check(/releases\/download\/riyeser-2026\.11\.27-60\//.test(await site.getAttribute('#dlgo', 'href')), 'the button now points at the file itself (a second press isn\'t counted again)');
  if (out) await site.screenshot({ path: path.join(out, 'site-download-page.png'), fullPage: true });
  answer = 'down'; went.length = 0;
  const s2 = await sctx.newPage(); s2.on('pageerror', (e) => errs.push('site: ' + e.message));
  await s2.goto(BASE + '/download/central.html', { waitUntil: 'commit' }); await s2.waitForFunction(() => /started/.test((document.getElementById('dlst') || {}).textContent || ''));
  await s2.waitForTimeout(300);
  check(went.some((u) => /\/raka1987\/riyeser-downloads\/releases\/latest\/download\/RiyeserCentral-Setup\.exe$/.test(u)), 'counter down: straight to GitHub (the downloads repository)');
  check(await s2.$eval('meta[name=robots]', (m) => m.content) === 'noindex', 'not for search engines');
  const sp = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
  await sp.route('https://*.supabase.co/**', (r) => r.abort()); await sp.route('https://api.github.com/**', (r) => r.abort());
  await sp.route('https://github.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'content-disposition': 'attachment; filename=setup.exe' }, body: 'MZ' })); await sp.goto(BASE + '/download/central.html', { waitUntil: 'commit' }); await sp.waitForTimeout(300);
  check(await sp.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'download page on a phone: no sideways scrolling');
  if (out) await sp.screenshot({ path: path.join(out, 'site-download-phone.png'), fullPage: true });
  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(bad ? `${bad} HQ DOWNLOADS CHECK(S) FAILED` : 'ALL HQ DOWNLOADS CHECKS PASSED'); process.exit(bad ? 1 : 0);
})();
