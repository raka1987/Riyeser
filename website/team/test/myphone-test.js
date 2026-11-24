// ☎ My phone (every member) on the website, against a pretend Supabase:
//  1. A member with a connected desk phone (from ?myphone): the extension in big type, the phone, the set-up guide.
//  2. Show my own password: a one-off key goes out through link_my_reveal (not the admin link_command), the password comes
//     back encrypted to it, taken once. 3. Do not disturb for myself. 4. Report a phone issue: Get help, filled in.
//  5. Call someone opens the dial pad. 6. A member with no desk phone: "No desk phone yet." and the guide.
//  7. No extension yet. 8. Link Plus off, and no Link Office yet: friendly text (members: ask the owner; admins: the
//     Phones set-up guide). 9. An older database. 10. The ways in: chat sidebar, Riyeser home tile, ⚙ Settings.
// 11. Phone width: no sideways scrolling.
// Run: build the site, serve website/public on 8090, then `node website/team/test/myphone-test.js <shots>`. Exits 1 on any failure.
const { chromium, devices } = require('playwright');
const crypto = require('crypto');
const assert = require('assert');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const user = { id: 'bbbbbbbb-0000-4000-8000-000000000002', email: 'member@sample.test', factors: [] };
const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal1', exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
const PASSWORD = 'Zr4nTq8wLp2xKd6m';   // made up: "the office PC's" password for extension 102
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const phone = { mac: '001565aabb02', vendor: 'Yealink', model: 'T31P', name: 'Front counter', location: 'Head office', registered: true, last_registered: ago(0), provisioned_at: ago(600) };
const mine = (more = {}) => ({ now: new Date().toISOString(), calls: true, extension: '102', owner_name: 'Pat Owner', first_group: { extension: '100', name: 'Head office' }, dnd: false,
  office: { office_id: 'lo-0001', pc_name: 'OFFICE-PC', state: 'running', address: '192.168.1.20', sip_port: 5060, last_seen: ago(1), online: true, licence: { active: true } },
  phones: [phone], ...more });

async function fakeServer(page, opts = {}) {
  const st = { calls: [], commands: [], taken: 0, my: opts.my === undefined ? mine() : opts.my, dnd: [] };
  const role = opts.admin ? 'admin' : 'member';
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
    if (u.pathname === '/auth/v1/factors' || u.pathname.includes('/factors')) return json([]);
    if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role, job_role: 'staff', display_name: 'Kai Member', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business', country: 'Fiji' } }]);
    if (u.pathname === '/rest/v1/members') return json([{ user_id: 'aaaaaaaa-0000-4000-8000-000000000001', display_name: 'Pat Owner', role: 'owner', job_role: 'owner', extension: 101 },
      { user_id: user.id, display_name: 'Kai Member', role, job_role: 'staff', extension: opts.noExt ? null : 102 }]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    if (u.pathname === '/rest/v1/branches') return json([{ id: 'b1', name: 'Head office', code: 'HEA-1001', extension: 100, branch_members: [] }]);
    if (fn === 'team_features') return json({ calls: !opts.noPlus });
    if (fn === 'company_licence') return json({ modules: { calls: opts.noPlus ? { status: 'ended', active: false } : { status: 'active', active: true, days_left: 200 } }, seats: { included: 3, extra: 0, used: 3 } });
    if (fn === 'link_my_phone') return json(st.my);
    if (fn === 'link_status') return json({ now: new Date().toISOString(), calls: !opts.noPlus, offices: [], support: null });
    if (fn === 'link_command') return json({ code: 'P0001', message: 'Only the business\'s owner or an admin, signed in with two-step sign-in, can change the phones.' }, 400);
    if (fn === 'link_my_reveal' || fn === 'link_my_dnd') {
      const c = { id: `my-${st.commands.length + 1}`, fn, body, polls: 0, status: 'pending' }; st.commands.push(c);
      if (fn === 'link_my_dnd') st.dnd.push(body.dnd_on);
      return json(c.id);
    }
    if (fn === 'link_command_state') {
      const c = st.commands.find((x) => x.id === body.command); c.polls += 1;
      if (c.polls >= 2 && c.status === 'pending') {
        c.status = 'done';
        if (c.fn === 'link_my_reveal') {
          const key = crypto.createPublicKey({ key: { kty: 'RSA', n: c.body.pub_key.n, e: c.body.pub_key.e }, format: 'jwk' });
          c.sealed = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(PASSWORD)).toString('base64');
        }
        if (c.fn === 'link_my_dnd') st.my.dnd = c.body.dnd_on;
      }
      return json({ id: c.id, kind: c.fn === 'link_my_dnd' ? 'set_dnd' : 'reveal_password', status: c.status, error: null, ready: !!c.sealed });
    }
    if (fn === 'link_reveal_take') { const c = st.commands.find((x) => x.id === body.command); const s = c.sealed || null; c.sealed = null; st.taken += 1; return json(s); }
    if (fn === 'my_tickets') return json([]);
    return json([]);
  });
  return st;
}
const signIn = async (pg, url) => { await pg.goto(url); await pg.waitForSelector('#gf'); await pg.fill('input[name=email]', user.email); await pg.fill('input[name=password]', 'a-good-password'); await pg.click('button[type=submit]'); };
const text = (pg, sel) => pg.textContent(sel).then((t) => t.replace(/\s+/g, ' ').trim());

(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.';
  let failed = false;
  const page = async (opts, url = 'http://127.0.0.1:8090/link/?myphone', vp = { width: 1180, height: 900 }) => {
    const pg = await b.newPage({ viewport: vp }); pg.on('pageerror', (e) => errs.push(e.message));
    const st = await fakeServer(pg, opts); await signIn(pg, url); return [pg, st];
  };
  try {
    // 1. a member with a connected desk phone
    const [pg, st] = await page({});
    await pg.waitForSelector('#myPhonePage');
    console.log('extension:', await text(pg, '#myext'));
    assert.strictEqual(await text(pg, '#myext'), 'Others call you by dialling 102');
    const ph = await pg.evaluate(() => document.querySelector('.my-phones').innerText.replace(/\s+/g, ' ').trim()); console.log('my phone:', ph);
    assert.match(ph, /Front counter Yealink T31P · 00:15:65:AA:BB:02 ● connected now/);
    const guide = await pg.evaluate(() => [...document.querySelectorAll('.my-steps > li')].map((li) => li.innerText.split('\n').filter((x) => x && x !== 'LAN')[0]));
    console.log('guide:', guide);
    assert.deepStrictEqual(guide, ['Plug the phone into a network socket at the office (and into power, if it has an adapter).',
      'Most phones set themselves up: your manager will see it appear and give it to you.', 'If it doesn\'t, type these into the phone\'s account settings:',
      'Test it: dial another extension, e.g. 100 for Head office.']);
    assert.strictEqual(await pg.$$eval('.my-steps svg.pic', (x) => x.length), 2, 'pictures: a socket and a phone');
    assert.strictEqual(await text(pg, '#myaddr'), '192.168.1.20'); assert.strictEqual(await text(pg, '#myport'), '5060'); assert.strictEqual(await text(pg, '#myuser'), '102');
    assert.strictEqual(await text(pg, '#mypw'), '••••••••••••••••');
    await pg.click('#mymenus summary');
    const makers = await pg.$$eval('#mymenus dt', (x) => x.map((y) => y.textContent)); console.log('where to type them:', makers);
    assert.deepStrictEqual(makers, ['Yealink', 'Grandstream', 'Snom', 'Polycom / Poly']); assert.match(await text(pg, '#mymenus'), /Menus differ by model/);
    assert.match(await text(pg, '.my-sos'), /No emergency calls/);
    assert.strictEqual(await pg.getAttribute('a[href="/help/link.html#own-desk-phone"]', 'href'), '/help/link.html#own-desk-phone');
    await pg.screenshot({ path: out + '/myphone.png', fullPage: true });

    // 2. Show my own password
    await pg.click('#myshow');
    await pg.waitForFunction(() => /Asking Riyeser Link Office for your password…/.test(document.querySelector('#mystat').textContent));
    await pg.waitForFunction(() => !/•/.test(document.querySelector('#mypw').textContent), null, { timeout: 8000 });
    assert.strictEqual(await text(pg, '#mypw'), PASSWORD); console.log('Show:', await text(pg, '#mystat'));
    const rev = st.commands.find((c) => c.fn === 'link_my_reveal');
    assert.deepStrictEqual(Object.keys(rev.body).sort(), ['pub_key', 'ws']); assert.deepStrictEqual(Object.keys(rev.body.pub_key).sort(), ['e', 'kty', 'n'], 'only the public key goes out');
    assert.ok(!st.calls.includes('link_command'), 'not the admin route'); assert.strictEqual(st.taken, 1, 'taken once');
    await pg.screenshot({ path: out + '/myphone-show.png' });
    await pg.click('#myshow'); assert.strictEqual(await text(pg, '#mypw'), '••••••••••••••••'); await pg.click('#myshow'); assert.strictEqual(await text(pg, '#mypw'), PASSWORD);
    assert.strictEqual(st.taken, 1, 'Hide/Show again does not ask again');

    // 3. Do not disturb for myself
    await pg.click('.my-dnd .sw span');
    await pg.waitForFunction(() => /Do not disturb is on/.test((document.getElementById('phmsg') || {}).textContent || ''), null, { timeout: 8000 });
    assert.deepStrictEqual(st.dnd, [true]); console.log('DND: on');

    // 4. Report a phone issue
    await pg.click('#myreport'); await pg.waitForSelector('#ghf');
    const t = await pg.evaluate(() => { const f = document.querySelector('#ghf'); return { topic: f.topic.value, subject: f.subject.value, message: f.message.value }; });
    console.log('report:', JSON.stringify(t));
    assert.strictEqual(t.topic, 'program'); assert.strictEqual(t.subject, 'Phone problem: extension 102');
    assert.match(t.message, /^Phone: Yealink T31P \(Front counter\)\nMAC: 00:15:65:AA:BB:02\nConnected: yes \(Online, last check-in Now\)/);
    await pg.screenshot({ path: out + '/myphone-report.png' });
    await pg.click('#ghf #cl');

    // 5. Call someone: the dial pad
    await pg.click('#mycall'); await pg.waitForSelector('#dpn'); console.log('Call someone: dial pad'); await pg.click('#dpf #cl');

    // 6. no desk phone yet: the guide
    const [p6] = await page({ my: mine({ phones: [] }) }); await p6.waitForSelector('#mynophone');
    assert.strictEqual(await text(p6, '#mynophone'), 'No desk phone yet.'); assert.ok(await p6.$('#myguide'), 'the guide is there');
    await p6.screenshot({ path: out + '/myphone-nophone.png', fullPage: true });

    // 7. no extension yet
    const [p7] = await page({ noExt: true, my: mine({ extension: null, phones: [] }) }); await p7.waitForSelector('#myext');
    assert.strictEqual(await text(p7, '#myext'), 'You don\'t have an extension yet. Ask Pat Owner to give you one in People & access.');
    assert.ok(!(await p7.$('#myshow')) && !(await p7.$('#mydnd')), 'nothing to show or switch');

    // 8. Link Plus off / no Link Office yet
    const [p8] = await page({ noPlus: true, my: mine({ calls: false }) }); await p8.waitForSelector('#mynone');
    console.log('Link Plus off:', await text(p8, '#mynone'));
    assert.strictEqual(await text(p8, '#mynone'), 'Your business hasn\'t set up office phones yet. Ask Pat Owner.'); assert.ok(!(await p8.$('#mycall')));
    await p8.screenshot({ path: out + '/myphone-noplus.png', fullPage: true });
    const [p8b] = await page({ my: mine({ office: null, phones: [] }) }); await p8b.waitForSelector('#mynone');
    assert.strictEqual(await text(p8b, '#mynone'), 'Your business hasn\'t set up office phones yet. Ask Pat Owner.');
    const [p8c] = await page({ admin: true, my: mine({ office: null, phones: [] }) }); await p8c.waitForSelector('#mytophones');
    console.log('admin, no Link Office:', await text(p8c, '#mynone'));
    await p8c.click('#mytophones'); await p8c.waitForSelector('#phonesPage'); console.log('-> Phones set-up guide');

    // 9. an older database: the extension from People & access, no errors
    const [p9] = await page({ oldDatabase: true }); await p9.waitForSelector('#myPhonePage');
    assert.strictEqual(await text(p9, '#myext'), 'Others call you by dialling 102'); assert.ok(!(await p9.$('#myPhonePage .err')));

    // 10. the ways in
    const [p10] = await page({}, 'http://127.0.0.1:8090/link/'); await p10.waitForSelector('#hmyphone');
    console.log('home tile:', await text(p10, '#hmyphone'));
    await p10.click('#hmyphone'); await p10.waitForSelector('#myPhonePage'); await p10.click('#myback'); await p10.waitForSelector('#hchat');
    await p10.click('#hchat'); await p10.waitForSelector('#comyphone');
    assert.ok(!(await p10.$('#cophones')), 'members don\'t get the Desk phones button');
    await p10.click('#comyphone'); await p10.waitForSelector('#myPhonePage'); assert.match(await text(p10, '#myback'), /Back to chat/);
    await p10.click('#myback'); await p10.waitForSelector('#coset'); await p10.click('#coset'); await p10.waitForSelector('[data-s=myphone]');
    assert.ok(!(await p10.$('[data-s=phones]')), 'Settings: no Desk phones for members');
    await p10.click('[data-s=myphone]'); await p10.waitForSelector('#myPhonePage'); console.log('chat sidebar, home tile, ⚙ Settings: ok');

    // 11. phone width
    const mob = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); mob.on('pageerror', (e) => errs.push('phone: ' + e.message));
    await fakeServer(mob, {}); await signIn(mob, 'http://127.0.0.1:8090/link/?myphone'); await mob.waitForSelector('#myPhonePage');
    await mob.click('#mymenus summary');
    const over = await mob.evaluate(() => document.documentElement.scrollWidth - innerWidth); console.log('phone overflow:', over);
    assert.strictEqual(over, 0);
    await mob.screenshot({ path: out + '/myphone-phone.png', fullPage: true });

    // the demo works too (Jordan: extension 201, an offline desk phone)
    const pd = await b.newPage(); pd.on('pageerror', (e) => errs.push('demo: ' + e.message));
    await pd.goto('http://127.0.0.1:8090/link/?demo&as=u-jordan&myphone'); await pd.waitForSelector('#myext');
    assert.strictEqual(await text(pd, '#myext'), 'Others call you by dialling 201'); console.log('demo:', await text(pd, '.my-phones'));
  } catch (e) { failed = true; console.error('FAILED:', e.message); }
  console.log('errors:', errs); await b.close();
  if (failed || errs.length) process.exit(1);
  console.log('MY PHONE TESTS PASSED');
})();
