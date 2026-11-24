// Phones (Riyeser Link Office, desk phones) on the website, against a pretend Supabase:
//  1. No Link Office yet: the set-up guide (reached from the Riyeser home tile).
//  2. With a heartbeat (?phones): the server address, extensions and desk phones.
//  3. A new phone found -> Give to… -> the change is sent, "Sending to Riyeser Link Office…", then "Done".
//  4. Set up a phone by hand -> Show: a one-off key goes out, the password comes back encrypted to it, and is shown.
//  5. Let Riyeser help (and End it now). 6. Do not disturb. 7. Add a desk phone by MAC. 8. Not on Link Plus: the upsell.
//  9. An older database (no link_ functions yet): the guide, no errors. 10. Phone width: no sideways scrolling.
// Run: build the site, serve website/public on 8090, then `node website/team/test/phones-test.js <shots>`. Exits 1 on any failure.
const { chromium, devices } = require('playwright');
const crypto = require('crypto');
const assert = require('assert');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
const PASSWORD = 'Hk7mPx2vRt9wQs4n';   // made up: "the office PC's" password for extension 101
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const office = () => ({ office_id: 'lo-0001', pc_name: 'OFFICE-PC', version: '1.1.0', state: 'running', addresses: ['192.168.1.20'], sip_port: 5060, address_stable: false,
  pc_mac: '3C:52:82:1A:2B:3C', licence: { active: true, state: 'active', text: 'Riyeser Link Plus' }, first_seen: ago(5000), last_seen: ago(2),
  counts: { people: 3, groups: 1, phones_assigned: 2, phones_connected: 1, new_phones: 1, calls_in_progress: 0 },
  phones: [{ mac: '001565aabbcc', vendor: 'Yealink', model: 'T31P', extension: '101', assigned: true, registered: true, last_registered: ago(0), ip: '192.168.1.31' },
    { mac: '000b82112233', vendor: 'Grandstream', model: 'GRP2601P', extension: '102', assigned: true, registered: false, last_registered: ago(90), ip: '192.168.1.32' },
    { mac: '001565ddeeff', vendor: 'Yealink', model: 'T33G', extension: null, assigned: false, registered: false, last_registered: null, ip: '192.168.1.44' }],
  extensions: [{ extension: '100', name: 'Head office', type: 'group', members: 3 }, { extension: '101', name: 'Alex Sample', type: 'person', registered: 1, desk_phones: 1, app_users: 0, dnd: false },
    { extension: '102', name: 'Bo Example', type: 'person', registered: 0, desk_phones: 1, app_users: 0, dnd: false }, { extension: '103', name: 'Cam Test', type: 'person', registered: 1, desk_phones: 0, app_users: 1, dnd: false }] });

async function fakeServer(page, opts = {}) {
  const st = { calls: [], commands: [], taken: 0, support: null, offices: opts.offices || [] };
  await page.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  await page.route('https://fake.supabase.test/**', async (r) => {
    const u = new URL(r.request().url()); const m = r.request().method(); const fn = u.pathname.replace('/rest/v1/rpc/', '');
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const body = JSON.parse(r.request().postData() || '{}');
    if (u.pathname.startsWith('/rest/v1/rpc/')) st.calls.push(fn);
    if (opts.oldDatabase && fn.startsWith('link_')) return json({ code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` }, 404);
    if (u.pathname === '/auth/v1/token') return json({ access_token: token(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (u.pathname === '/auth/v1/user') return json(user);
    if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex Sample', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business', country: 'Fiji' } }]);
    if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex Sample', role: 'owner', job_role: 'owner', extension: 101 }]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    if (fn === 'company_licence') return json({ modules: { calls: opts.noPlus ? { status: 'ended', active: false } : { status: 'active', active: true, paid_until: '2027-06-30', days_left: 200 } }, seats: { included: 3, extra: 0, used: 3 } });
    if (fn === 'team_features') return json({ calls: !opts.noPlus });
    if (fn === 'link_status') return json({ now: new Date().toISOString(), calls: !opts.noPlus, offices: st.offices, support: st.support });
    if (fn === 'link_command') {
      const c = { id: `cmd-${st.commands.length + 1}`, ...body, status: 'pending', polls: 0 }; st.commands.push(c); return json(c.id);
    }
    if (fn === 'link_command_state') {
      const c = st.commands.find((x) => x.id === body.command); c.polls += 1;
      if (c.polls >= 2 && c.status === 'pending') {   // the office picked it up
        c.status = 'done';
        if (c.kind === 'reveal_password') {
          const key = crypto.createPublicKey({ key: { kty: 'RSA', n: c.data.key.n, e: c.data.key.e }, format: 'jwk' });
          c.sealed = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(PASSWORD)).toString('base64');
        }
        if (c.kind === 'assign_phone') Object.assign(st.offices[0].phones.find((p) => p.mac === c.data.mac), { assigned: true, extension: c.data.extension });
      }
      return json({ id: c.id, kind: c.kind, status: c.status, error: null, ready: !!c.sealed });
    }
    if (fn === 'link_reveal_take') { const c = st.commands.find((x) => x.id === body.command); const s = c.sealed || null; c.sealed = null; st.taken += 1; return json(s); }
    if (fn === 'link_support_allow') { st.support = { until: new Date(Date.now() + 3600e3).toISOString() }; return json(st.support); }
    if (fn === 'link_support_end') { st.support = null; return json(null); }
    return json([]);
  });
  return st;
}
const signIn = async (pg, url) => { await pg.goto(url); await pg.waitForSelector('#gf'); await pg.fill('input[name=email]', user.email); await pg.fill('input[name=password]', 'a-good-password'); await pg.click('button[type=submit]'); };
const text = (pg, sel) => pg.textContent(sel).then((t) => t.replace(/\s+/g, ' ').trim());

(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.';
  let failed = false;
  try {
    // 1. no Link Office yet: the guide, from the Riyeser home tile
    const p1 = await b.newPage({ viewport: { width: 1280, height: 900 } }); p1.on('pageerror', (e) => errs.push(e.message));
    await fakeServer(p1); await signIn(p1, 'http://127.0.0.1:8090/link/'); await p1.waitForSelector('#hphones');
    console.log('home tile:', await text(p1, '#hphones'));
    await p1.click('#hphones'); await p1.waitForSelector('.lo-steps');
    const steps = await p1.evaluate(() => [...document.querySelectorAll('.lo-steps li')].map((x) => x.textContent));
    console.log('guide:', steps);
    assert.deepStrictEqual(steps, ['Install Riyeser Link Office on a PC at the office that stays on (Riyeser Central → Get more apps).', 'Sign in with your Riyeser account.', 'Plug in desk phones.']);
    assert.strictEqual(await p1.getAttribute('.lo-card a.btn', 'href'), '/help/link.html#desk-phones');
    await p1.screenshot({ path: out + '/phones-guide.png', fullPage: true });
    await p1.click('#phback'); await p1.waitForSelector('.hco'); console.log('back to Riyeser home: ok');

    // 2. with a heartbeat, straight from riyeser.com/link/?phones
    const pg = await b.newPage({ viewport: { width: 1280, height: 900 } }); pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
    const st = await fakeServer(pg, { offices: [office()] });
    await signIn(pg, 'http://127.0.0.1:8090/link/?phones'); await pg.waitForSelector('#loaddr');
    console.log('server address:', await text(pg, '#loaddr'), 'port', await text(pg, '#loport'), '| state:', await text(pg, '#lostate'), '| seen:', await text(pg, '#loseen'));
    assert.strictEqual(await text(pg, '#loaddr'), '192.168.1.20'); assert.strictEqual(await text(pg, '#loport'), '5060'); assert.strictEqual(await text(pg, '#lostate'), 'Running');
    const warn = await text(pg, '.lo-warn'); console.log('not stable:', warn);
    assert.match(warn, /DHCP reservation/); assert.match(warn, /3C:52:82:1A:2B:3C/);
    const exts = await pg.evaluate(() => [...document.querySelectorAll('table.lo')[0].querySelectorAll('tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    console.log('extensions:', exts);
    assert.ok(exts.some((x) => /^101 Alex Sample ● Yealink T31P 00:15:65:AA:BB:CC/.test(x)));
    assert.ok(exts.some((x) => /^100 Head office ring group · 3 people/.test(x)));
    const desk = await pg.evaluate(() => [...document.querySelectorAll('table.lo')[1].querySelectorAll('tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    console.log('desk phones:', desk);
    assert.strictEqual(desk.length, 2); assert.match(desk[1], /Grandstream GRP2601P .* 102 Bo Example ○ No · last/);
    console.log('new phones found:', await text(pg, '.lo-found'));
    await pg.screenshot({ path: out + '/phones-page.png', fullPage: true });

    // 3. a new phone found -> Give to… -> sent, then done
    await pg.click('[data-give="001565ddeeff"]'); await pg.waitForSelector('[data-to="103"]');
    await pg.screenshot({ path: out + '/phones-give.png' });
    await pg.click('[data-to="103"]');
    await pg.waitForFunction(() => /Sending to Riyeser Link Office…/.test(document.querySelector('#gstat').textContent));
    console.log('give to:', await text(pg, '#gstat'));
    await pg.waitForFunction(() => /Done/.test((document.querySelector('#gstat') || {}).textContent || 'Done'), null, { timeout: 8000 });
    const give = st.commands.find((c) => c.kind === 'assign_phone');
    console.log('sent:', JSON.stringify({ office_id: give.office_id, kind: give.kind, data: give.data }));
    assert.deepStrictEqual(give.data, { mac: '001565ddeeff', extension: '103' }); assert.strictEqual(give.office_id, 'lo-0001');
    await pg.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 5000 });
    await pg.waitForFunction(() => !document.querySelector('[data-give]'), null, { timeout: 5000 });
    console.log('after: no new phones left, desk phones:', await pg.evaluate(() => document.querySelectorAll('table.lo')[1].querySelectorAll('tbody tr').length));

    // 4. set up a phone by hand -> Show
    await pg.click('[data-hand="101"]'); await pg.waitForSelector('#show');
    console.log('by hand:', await pg.evaluate(() => [...document.querySelectorAll('.lo-sip dt')].map((d) => `${d.textContent}: ${d.nextElementSibling.querySelector('code').textContent}`)));
    assert.strictEqual(await text(pg, '#pw'), '••••••••••••••••');
    await pg.click('#show');
    await pg.waitForFunction(() => /Asking Riyeser Link Office for the password…/.test(document.querySelector('#hstat').textContent));
    console.log('show:', await text(pg, '#hstat'));
    await pg.waitForFunction(() => !/•/.test(document.querySelector('#pw').textContent), null, { timeout: 8000 });
    const shown = await text(pg, '#pw'); console.log('password shown:', shown === PASSWORD ? '(the right one)' : shown, '|', await text(pg, '#hstat'));
    assert.strictEqual(shown, PASSWORD);
    const rev = st.commands.find((c) => c.kind === 'reveal_password');
    assert.deepStrictEqual(Object.keys(rev.data.key).sort(), ['e', 'kty', 'n'], 'only the public key goes out');
    assert.ok(!JSON.stringify(rev).includes(PASSWORD), 'the password was never sent as plain text');
    assert.strictEqual(st.taken, 1, 'taken once');
    await pg.screenshot({ path: out + '/phones-byhand.png' });
    await pg.click('#show'); assert.strictEqual(await text(pg, '#pw'), '••••••••••••••••'); await pg.click('#show'); assert.strictEqual(await text(pg, '#pw'), PASSWORD);
    assert.strictEqual(st.taken, 1, 'Hide/Show again does not ask again');
    // make a new password
    await pg.click('#newpw'); await pg.waitForFunction(() => /New password made/.test(document.querySelector('#hstat').textContent), null, { timeout: 8000 });
    console.log('new password:', await text(pg, '#hstat'));
    assert.deepStrictEqual(st.commands.find((c) => c.kind === 'new_password').data, { extension: '101' });
    await pg.click('#cl');

    // 6. Do not disturb
    await pg.click('label:has([data-dnd="102"]) span');
    await pg.waitForFunction(() => /Done/.test((document.getElementById('phmsg') || {}).textContent || ''), null, { timeout: 8000 });
    console.log('DND:', JSON.stringify(st.commands.find((c) => c.kind === 'set_dnd').data));
    assert.deepStrictEqual(st.commands.find((c) => c.kind === 'set_dnd').data, { extension: '102', on: true });

    // 7. add a desk phone by MAC
    await pg.fill('#loadd input[name=mac]', 'nope'); await pg.selectOption('#loadd select[name=ext]', '102'); await pg.click('#loadd .btn.p');
    console.log('bad MAC:', await text(pg, '#phmsg'));
    await pg.fill('#loadd input[name=mac]', '00-04-13-44-55-66'); await pg.selectOption('#loadd select[name=vendor]', 'snom'); await pg.selectOption('#loadd select[name=ext]', '102'); await pg.click('#loadd .btn.p');
    await pg.waitForFunction(() => document.querySelector('#loadd') && !document.querySelector('#loadd input[name=mac]').value || /Done/.test((document.getElementById('phmsg') || {}).textContent || ''), null, { timeout: 8000 });
    console.log('add by MAC sent:', JSON.stringify(st.commands.find((c) => c.kind === 'add_phone').data));
    assert.deepStrictEqual(st.commands.find((c) => c.kind === 'add_phone').data, { mac: '000413445566', extension: '102', vendor: 'snom' });

    // 5. Let Riyeser help
    await pg.waitForSelector('#losupon'); await pg.click('#losupon'); await pg.waitForSelector('#losupend');
    console.log('let Riyeser help:', await text(pg, '#losupport'));
    assert.match(await text(pg, '#losupport'), /^Riyeser support can see and change your phone set-up until \d{1,2}:\d\d(am|pm)\. Everything they do is in your 🕘 History\.$/);
    await pg.screenshot({ path: out + '/phones-help.png', fullPage: true });
    await pg.click('#losupend'); await pg.waitForSelector('#losupon'); console.log('ended early: ok');
    assert.ok(st.calls.includes('link_support_allow') && st.calls.includes('link_support_end'));

    // the sidebar button in chat
    await pg.click('#phback'); await pg.waitForSelector('.hco'); await pg.click('#hchat'); await pg.waitForSelector('#cophones');
    await pg.click('#cophones'); await pg.waitForSelector('#loaddr'); console.log('chat sidebar ☎ Phones: ok, back says:', await text(pg, '#phback'));

    // 8. not on Link Plus: the upsell
    const p8 = await b.newPage({ viewport: { width: 1100, height: 800 } }); p8.on('pageerror', (e) => errs.push(e.message));
    await fakeServer(p8, { noPlus: true, offices: [office()] }); await signIn(p8, 'http://127.0.0.1:8090/link/?phones'); await p8.waitForSelector('.lo-up');
    console.log('upsell:', await text(p8, '.lo-up p'));
    assert.match(await text(p8, '.lo-up p'), /^Desk phones and calls come with Riyeser Link Plus\./);
    await p8.screenshot({ path: out + '/phones-upsell.png' });

    // 9. an older database: the guide, nothing breaks
    const p9 = await b.newPage({ viewport: { width: 1100, height: 800 } }); p9.on('pageerror', (e) => errs.push('old db: ' + e.message));
    await fakeServer(p9, { oldDatabase: true }); await signIn(p9, 'http://127.0.0.1:8090/link/?phones'); await p9.waitForSelector('.lo-steps');
    console.log('older database -> guide, no error box:', !(await p9.$('#phonesPage .err')));
    assert.ok(!(await p9.$('#phonesPage .err')));

    // 10. phone width
    const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
    await fakeServer(ph, { offices: [office()] }); await signIn(ph, 'http://127.0.0.1:8090/link/?phones'); await ph.waitForSelector('#loaddr');
    const over = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth); console.log('phone overflow:', over);
    assert.strictEqual(over, 0);
    await ph.screenshot({ path: out + '/phones-phone.png', fullPage: true });
    await ph.tap('[data-hand="102"]'); await ph.waitForSelector('#show');
    const over2 = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth); console.log('phone overflow (by hand):', over2); assert.strictEqual(over2, 0);
    await ph.screenshot({ path: out + '/phones-phone-byhand.png' });

    // the demo works too
    const pd = await b.newPage(); pd.on('pageerror', (e) => errs.push('demo: ' + e.message));
    await pd.goto('http://127.0.0.1:8090/link/?demo&phones'); await pd.waitForSelector('#loaddr'); console.log('demo ?phones:', await text(pd, '#loaddr'));
  } catch (e) { failed = true; console.error('FAILED:', e.message); }
  console.log('errors:', errs); await b.close();
  if (failed || errs.length) process.exit(1);
  console.log('PHONES TESTS PASSED');
})();
