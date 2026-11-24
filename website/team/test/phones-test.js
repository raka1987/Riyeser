// Desk phones (Settings → Desk phones: Riyeser Link Office) on the website, against a pretend Supabase:
//  1. No Link Office yet: "Set up your office phones" (5 steps, none done), reached from the Riyeser home tile.
//  2. With a heartbeat (?phones): the server address, the steps ticking themselves off, the Desk phones list with all four
//     statuses (Online, Configuring, Waiting for phone, Offline), the extensions.
//  3. A new phone found -> Give to… -> the change is sent, "Sending to Riyeser Link Office…", then "Done".
//  4. Set up a phone by hand -> Show: a one-off key goes out, the password comes back encrypted to it, and is shown.
//  5. Do not disturb. 6. + Add desk phone: name, location, extension, MAC (+ S/N), then live Waiting for phone ->
//     Configuring -> Online as the heartbeat changes, then the test call. 7. Replace phone (unassign the old one, add the
//     new one on the same extension, keep the name and location). 8. Troubleshoot, and Report a phone issue (prefilled).
//  9. Advanced setup (manual SIP) is for admins only. 10. Let Riyeser help. 11. All steps done: folded away.
// 12. Not on Link Plus: the upsell. 13. An older database: the steps, no errors. 14. Phone width: no sideways scrolling.
// Run: build the site, serve website/public on 8090, then `node website/team/test/phones-test.js <shots>`. Exits 1 on any failure.
const { chromium, devices } = require('playwright');
const crypto = require('crypto');
const assert = require('assert');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
const PASSWORD = 'Hk7mPx2vRt9wQs4n';   // made up: "the office PC's" password for extension 101
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const office = (more = {}) => ({ office_id: 'lo-0001', pc_name: 'OFFICE-PC', version: '1.1.1', state: 'running', addresses: ['192.168.1.20'], sip_port: 5060, address_stable: false,
  pc_mac: '3C:52:82:1A:2B:3C', licence: { active: true, state: 'active', text: 'Riyeser Link Plus' }, first_seen: ago(5000), last_seen: ago(2),
  counts: { people: 3, groups: 1, phones_assigned: 4, phones_connected: 1, new_phones: 1, calls_in_progress: 0, calls_made: 0 },
  phones: [{ mac: '001565aabbcc', vendor: 'Yealink', model: 'T31P', extension: '101', assigned: true, registered: true, last_registered: ago(0), ip: '192.168.1.31', name: 'Reception', location: 'Head office', provisioned_at: ago(3000) },
    { mac: '000b82112233', vendor: 'Grandstream', model: 'GRP2601P', extension: '102', assigned: true, registered: false, last_registered: ago(90), ip: '192.168.1.32', name: 'Accounts', location: 'Head office', provisioned_at: ago(3000) },
    { mac: '000413778899', vendor: 'Snom', model: 'D735', extension: '103', assigned: true, registered: false, last_registered: null, ip: '192.168.1.33', name: 'Workshop', location: '', provisioned_at: ago(1) },
    { mac: '0004f2aabbcc', vendor: 'Polycom', model: 'VVX 250', extension: '103', assigned: true, registered: false, last_registered: null, ip: null, name: '', location: '', provisioned_at: null },
    { mac: '001565ddeeff', vendor: 'Yealink', model: 'T33G', extension: null, assigned: false, registered: false, last_registered: null, ip: '192.168.1.44' }],
  extensions: [{ extension: '100', name: 'Head office', type: 'group', members: 3 }, { extension: '101', name: 'Alex Sample', type: 'person', registered: 1, desk_phones: 1, app_users: 0, dnd: false },
    { extension: '102', name: 'Bo Example', type: 'person', registered: 0, desk_phones: 1, app_users: 0, dnd: false }, { extension: '103', name: 'Cam Test', type: 'person', registered: 1, desk_phones: 2, app_users: 1, dnd: false }],
  ...more });

async function fakeServer(page, opts = {}) {
  const st = { calls: [], commands: [], taken: 0, support: null, offices: opts.offices || [], tickets: [] };
  const role = opts.member ? 'member' : 'owner';
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
    if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role, job_role: role, display_name: 'Alex Sample', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business', country: 'Fiji' } }]);
    if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex Sample', role, job_role: role, extension: 101 }]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    if (u.pathname === '/rest/v1/branches') return json([{ id: 'b1', name: 'Head office', code: 'HEA-1001', extension: 100, branch_members: [{ user_id: user.id }] }, { id: 'b2', name: 'Nadi branch', code: 'NAD-2002', extension: 200, branch_members: [] }]);
    if (fn === 'company_licence') return json({ modules: { calls: opts.noPlus ? { status: 'ended', active: false } : { status: 'active', active: true, paid_until: '2027-06-30', days_left: 200 } }, seats: { included: 3, extra: 0, used: 3 } });
    if (fn === 'team_features') return json({ calls: !opts.noPlus });
    if (fn === 'link_status') return json({ now: new Date().toISOString(), calls: !opts.noPlus, offices: st.offices, support: st.support });
    if (fn === 'link_my_phone') return json({ now: new Date().toISOString(), calls: !opts.noPlus, extension: '101', owner_name: 'Alex Sample', first_group: { extension: '100', name: 'Head office' }, dnd: false,
      office: st.offices[0] ? { office_id: 'lo-0001', address: '192.168.1.20', sip_port: 5060, last_seen: ago(2), online: true } : null, phones: [] });
    if (fn === 'my_tickets') return json(st.tickets);
    if (fn === 'link_command') {
      const c = { id: `cmd-${st.commands.length + 1}`, ...body, status: 'pending', polls: 0 }; st.commands.push(c); return json(c.id);
    }
    if (fn === 'link_command_state') {
      const c = st.commands.find((x) => x.id === body.command); c.polls += 1;
      if (c.polls >= 2 && c.status === 'pending') {   // the office picked it up
        c.status = 'done'; const phones = st.offices[0] ? st.offices[0].phones : [];
        if (c.kind === 'reveal_password') {
          const key = crypto.createPublicKey({ key: { kty: 'RSA', n: c.data.key.n, e: c.data.key.e }, format: 'jwk' });
          c.sealed = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(PASSWORD)).toString('base64');
        }
        if (c.kind === 'assign_phone') Object.assign(phones.find((p) => p.mac === c.data.mac), { assigned: true, extension: c.data.extension });
        if (c.kind === 'add_phone') phones.push({ mac: c.data.mac, vendor: c.data.vendor === 'snom' ? 'Snom' : '', model: '', extension: c.data.extension, assigned: true, registered: false, last_registered: null, ip: null, provisioned_at: null });
        if (c.kind === 'unassign_phone') st.offices[0].phones = phones.filter((p) => p.mac !== c.data.mac);
        if (c.kind === 'name_phone') Object.assign(phones.find((p) => p.mac === c.data.mac), { name: c.data.name, location: c.data.branch, note: c.data.note });
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
const steps = (pg) => pg.evaluate(() => [...document.querySelectorAll('.lo-tick li')].map((x) => `${x.classList.contains('done') ? '✓' : '·'} ${x.querySelector('b').textContent}`));
const rows = (pg) => pg.evaluate(() => [...document.querySelectorAll('table.lo-dp tbody tr')].map((r) => ({ mac: r.dataset.mac, st: r.querySelector('.lo-pill').dataset.st, text: r.innerText.replace(/\s+/g, ' ').trim() })));
const kinds = (st) => st.commands.map((c) => c.kind);

(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.';
  let failed = false;
  try {
    // 1. no Link Office yet: the 5 steps, from the Riyeser home tile
    const p1 = await b.newPage({ viewport: { width: 1280, height: 900 } }); p1.on('pageerror', (e) => errs.push(e.message));
    await fakeServer(p1); await signIn(p1, 'http://127.0.0.1:8090/link/'); await p1.waitForSelector('#hphones');
    console.log('home tile:', await text(p1, '#hphones'));
    await p1.click('#hphones'); await p1.waitForSelector('.lo-setup');
    const s1 = await steps(p1); console.log('steps, nothing yet:', s1);
    assert.deepStrictEqual(s1, ['· Install Riyeser Link Office on a PC at the office that stays on.', '· Sign in on that PC.', '· Plug in your desk phones.', '· Give each phone to a person.', '· Make a test call.']);
    assert.strictEqual(await p1.getAttribute('.lo-setup a.btn', 'href'), '/help/link.html#desk-phones');
    assert.match(await text(p1, '.hbrand-t'), /Settings › ☎ Desk phones/);
    await p1.screenshot({ path: out + '/phones-guide.png', fullPage: true });
    await p1.click('#phback'); await p1.waitForSelector('.hco'); console.log('back to Riyeser home: ok');

    // 2. with a heartbeat, straight from riyeser.com/link/?phones
    const pg = await b.newPage({ viewport: { width: 1280, height: 900 } }); pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
    const st = await fakeServer(pg, { offices: [office()] });
    await signIn(pg, 'http://127.0.0.1:8090/link/?phones'); await pg.waitForSelector('#loaddr');
    console.log('server address:', await text(pg, '#loaddr'), 'port', await text(pg, '#loport'), '| state:', await text(pg, '#lostate'), '| seen:', await text(pg, '#loseen'));
    assert.strictEqual(await text(pg, '#loaddr'), '192.168.1.20'); assert.strictEqual(await text(pg, '#loport'), '5060'); assert.strictEqual(await text(pg, '#lostate'), 'Running');
    const warn = await text(pg, '.lo-warn'); assert.match(warn, /DHCP reservation/); assert.match(warn, /3C:52:82:1A:2B:3C/);
    const s2 = await steps(pg); console.log('steps:', s2);
    assert.deepStrictEqual(s2.map((x) => x[0]), ['✓', '✓', '✓', '·', '·'], 'installed, signed in, phones plugged in; one not given; no test call');
    const list = await rows(pg); console.log('desk phones:', list.map((x) => x.text));
    assert.deepStrictEqual(list.map((x) => x.st), ['Online', 'Offline', 'Configuring', 'Waiting for phone'], 'all four statuses');
    assert.match(list[0].text, /^☎ Reception Yealink T31P · 00:15:65:AA:BB:CC 101 Alex Sample Head office Online Now/);
    assert.match(list[1].text, /Accounts .* 102 Bo Example Head office Offline \d+ h ago/);
    assert.match(list[3].text, /Polycom VVX 250 .* 103 Cam Test — Waiting for phone Never/);
    assert.ok(await pg.$('#loaddphone'), '+ Add desk phone above the list');
    const exts = await pg.evaluate(() => [...document.querySelectorAll('table.lo-ext tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    assert.ok(exts.some((x) => /^101 Alex Sample ● Yealink T31P 00:15:65:AA:BB:CC/.test(x))); assert.ok(exts.some((x) => /^100 Head office ring group · 3 people/.test(x)));
    console.log('new phones found:', await text(pg, '.lo-found'));
    await pg.screenshot({ path: out + '/phones-page.png', fullPage: true });

    // 3. a new phone found -> Give to… -> sent, then done; step 4 ticks itself
    await pg.click('[data-give="001565ddeeff"]'); await pg.waitForSelector('[data-to="103"]');
    await pg.click('[data-to="103"]');
    await pg.waitForFunction(() => /Sending to Riyeser Link Office…/.test(document.querySelector('#gstat').textContent));
    await pg.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 8000 });
    assert.deepStrictEqual(st.commands.find((c) => c.kind === 'assign_phone').data, { mac: '001565ddeeff', extension: '103' });
    await pg.waitForFunction(() => !document.querySelector('[data-give]'), null, { timeout: 5000 });
    assert.strictEqual((await steps(pg))[3][0], '✓', 'every phone given to someone');

    // 4. set up a phone by hand -> Show
    await pg.click('[data-hand="101"]'); await pg.waitForSelector('#show');
    assert.strictEqual(await text(pg, '#pw'), '••••••••••••••••');
    assert.ok(await pg.$('#hmenus'), 'Where do I type these on my phone?');
    await pg.click('#show');
    await pg.waitForFunction(() => /Asking Riyeser Link Office for the password…/.test(document.querySelector('#hstat').textContent));
    await pg.waitForFunction(() => !/•/.test(document.querySelector('#pw').textContent), null, { timeout: 8000 });
    assert.strictEqual(await text(pg, '#pw'), PASSWORD);
    const rev = st.commands.find((c) => c.kind === 'reveal_password');
    assert.deepStrictEqual(Object.keys(rev.data.key).sort(), ['e', 'kty', 'n'], 'only the public key goes out');
    assert.ok(!JSON.stringify(rev).includes(PASSWORD), 'the password was never sent as plain text');
    assert.strictEqual(st.taken, 1, 'taken once'); console.log('by hand Show: ok');
    await pg.screenshot({ path: out + '/phones-byhand.png' });
    await pg.click('#newpw'); await pg.waitForFunction(() => /New password made/.test(document.querySelector('#hstat').textContent), null, { timeout: 8000 });
    await pg.click('#cl');

    // 5. Do not disturb
    await pg.click('label:has([data-dnd="102"]) span');
    await pg.waitForFunction(() => /Done/.test((document.getElementById('phmsg') || {}).textContent || ''), null, { timeout: 8000 });
    assert.deepStrictEqual(st.commands.find((c) => c.kind === 'set_dnd').data, { extension: '102', on: true });

    // 6. + Add desk phone, through to Online
    await pg.click('#loaddphone'); await pg.waitForSelector('#wf input[name=name]');
    await pg.screenshot({ path: out + '/wizard-1-name.png' });
    await pg.fill('#wf input[name=name]', 'Front counter'); await pg.click('#wf .btn.p');
    await pg.waitForSelector('#wf select[name=branch]'); await pg.selectOption('#wf select[name=branch]', 'Nadi branch'); await pg.click('#wf .btn.p');
    await pg.waitForSelector('#wf input[name=ext]'); await pg.check('#wf input[name=ext][value="102"]'); await pg.click('#wf .btn.p');
    await pg.waitForSelector('#wf input[name=mac]');
    assert.ok(await pg.$('#wf .lo-off input[disabled]'), 'Use a setup code: shown, switched off (coming with Riyeser Link Cloud)');
    await pg.click('.lo-label summary'); await pg.waitForSelector('.lo-label img');
    await pg.waitForFunction(() => document.querySelector('.lo-label img').complete && document.querySelector('.lo-label img').naturalWidth > 100, null, { timeout: 8000 });   // the label photo loads
    await pg.fill('#wf input[name=mac]', 'bad'); await pg.click('#wf .btn.p');
    assert.match(await text(pg, '#wstat'), /That isn't a MAC address/);
    await pg.fill('#wf input[name=mac]', '00:04:13:44:55:66'); await pg.fill('#wf input[name=sn]', 'BP78459236'); await pg.selectOption('#wf select[name=vendor]', 'snom');
    await pg.screenshot({ path: out + '/wizard-4-identify.png' });
    await pg.click('#wf .btn.p');
    await pg.waitForSelector('#wlive .lo-live', { timeout: 15000 });
    assert.deepStrictEqual(st.commands.find((c) => c.kind === 'add_phone').data, { mac: '000413445566', extension: '102', vendor: 'snom' });
    assert.deepStrictEqual(st.commands.find((c) => c.kind === 'name_phone').data, { mac: '000413445566', name: 'Front counter', branch: 'Nadi branch', note: 'S/N BP78459236' });
    const live = () => pg.getAttribute('#wlive .lo-live', 'data-st');
    assert.strictEqual(await live(), 'Waiting for phone'); console.log('live: Waiting for phone');
    await pg.screenshot({ path: out + '/wizard-5-waiting.png' });
    Object.assign(st.offices[0].phones.find((p) => p.mac === '000413445566'), { provisioned_at: new Date().toISOString() });
    await pg.waitForFunction(() => document.querySelector('#wlive .lo-live').dataset.st === 'Configuring', null, { timeout: 15000 }); console.log('live: Configuring');
    Object.assign(st.offices[0].phones.find((p) => p.mac === '000413445566'), { registered: true, last_registered: new Date().toISOString() });
    await pg.waitForFunction(() => document.querySelector('#wlive .lo-live').dataset.st === 'Online', null, { timeout: 15000 }); console.log('live: Online');
    await pg.waitForFunction(() => !document.querySelector('#wnext').disabled);
    await pg.screenshot({ path: out + '/wizard-5-online.png' });
    await pg.click('#wnext'); await pg.waitForSelector('#wf input[name=ok]'); await pg.check('#wf input[name=ok]'); await pg.click('#wf .btn.p');
    await pg.waitForFunction(() => !document.querySelector('.modal'));
    await pg.waitForFunction(() => [...document.querySelectorAll('table.lo-dp tbody tr')].some((r) => r.dataset.mac === '000413445566' && /Front counter/.test(r.innerText) && /Online/.test(r.innerText)), null, { timeout: 8000 });
    console.log('added: Front counter, Online');

    // 7. Replace phone: the Offline one (Accounts, 102)
    await pg.click('[data-more="000b82112233"]'); await pg.waitForSelector('[data-m=replace]');
    const menu = await pg.evaluate(() => [...document.querySelectorAll('[data-m]')].map((x) => x.textContent));
    console.log('⋯ menu:', menu);
    assert.deepStrictEqual(menu, ['View setup', 'Troubleshoot', 'Replace phone', 'Advanced setup (manual SIP)', 'Rename / move location', 'Remove from this person']);
    await pg.click('[data-m=replace]'); await pg.waitForSelector('#rpf');
    const prev = await text(pg, '#rpprev'); console.log('preview:', prev);
    assert.match(prev, /^The old phone \(MAC 00:0B:82:11:22:33\) stops getting its settings now; it keeps working until it's restarted or reset\. To lock it out straight away, also make a new password\. The new phone keeps extension 102, the name Accounts and the location Head office\.$/);
    await pg.fill('#rpf input[name=mac]', '00:0B:82:44:55:66');
    await pg.screenshot({ path: out + '/replace.png' });
    const before = st.commands.length;
    await pg.click('#rpgo');
    await pg.waitForFunction(() => /Replaced/.test(document.querySelector('#rpstat').textContent), null, { timeout: 20000 });
    const sent = st.commands.slice(before).map((c) => [c.kind, c.data]); console.log('replace sent:', JSON.stringify(sent));
    assert.deepStrictEqual(sent, [['unassign_phone', { mac: '000b82112233' }], ['add_phone', { mac: '000b82445566', extension: '102' }],
      ['name_phone', { mac: '000b82445566', name: 'Accounts', branch: 'Head office', note: '' }]], 'old one off, new one on the same extension, same name and location');
    await pg.waitForSelector('#rplive .lo-live'); await pg.click('#cl');
    await pg.waitForFunction(() => { const r = [...document.querySelectorAll('table.lo-dp tbody tr')]; return !r.some((x) => x.dataset.mac === '000b82112233') && r.some((x) => x.dataset.mac === '000b82445566' && /Accounts/.test(x.innerText) && /102 Bo Example/.test(x.innerText)); }, null, { timeout: 8000 });

    // 8. Troubleshoot, and Report a phone issue
    await pg.click('[data-more="0004f2aabbcc"]'); await pg.click('[data-m=trouble]'); await pg.waitForSelector('.lo-check');
    const checks = await pg.evaluate(() => [...document.querySelectorAll('.lo-check li')].map((x) => x.querySelector('b').textContent));
    console.log('troubleshoot:', checks);
    assert.deepStrictEqual(checks, ['Power.', 'Network cable in the LAN port.', 'Same office network.', 'The office PC is on and online.', 'Restart the phone.']);
    assert.match(await text(pg, '.lo-trouble'), /Last check-in: Never · Last settings fetch: never/);
    await pg.screenshot({ path: out + '/troubleshoot.png' });
    await pg.click('[data-report="0004f2aabbcc"]'); await pg.waitForSelector('#ghf');
    const t = await pg.evaluate(() => { const f = document.querySelector('#ghf'); return { topic: f.topic.value, subject: f.subject.value, message: f.message.value }; });
    console.log('report:', JSON.stringify(t));
    assert.strictEqual(t.topic, 'program'); assert.strictEqual(t.subject, 'Phone problem: extension 103');
    assert.match(t.message, /Phone: Polycom VVX 250\nMAC: 00:04:F2:AA:BB:CC\nConnected: no \(Waiting for phone, last check-in Never\)/);
    await pg.click('#ghf #cl'); await pg.click('.modal #cl');

    // Rename / move, and View setup
    await pg.click('[data-more="0004f2aabbcc"]'); await pg.click('[data-m=rename]'); await pg.waitForSelector('#rnf');
    await pg.fill('#rnf input[name=name]', 'Store room'); await pg.selectOption('#rnf select[name=branch]', 'Head office'); await pg.click('#rnf .btn.p');
    await pg.waitForFunction(() => !document.querySelector('#rnf'), null, { timeout: 8000 });
    assert.deepStrictEqual(st.commands[st.commands.length - 1].data, { mac: '0004f2aabbcc', name: 'Store room', branch: 'Head office', note: '' });
    await pg.click('[data-more="0004f2aabbcc"]'); await pg.click('[data-m=view]'); await pg.waitForSelector('#vlive .lo-live');
    await pg.screenshot({ path: out + '/view-setup.png' }); await pg.click('.modal #cl');

    // 9. Advanced setup (manual SIP): admins get it; a member can't open the Desk phones page at all (they get My phone)
    await pg.click('[data-more="001565aabbcc"]'); await pg.click('[data-m=adv]'); await pg.waitForSelector('#show');
    assert.match(await text(pg, '.mcard h3'), /Advanced setup \(manual SIP\)/); await pg.click('.mcard #cl');
    const pm = await b.newPage({ viewport: { width: 1100, height: 800 } }); pm.on('pageerror', (e) => errs.push('member: ' + e.message));
    await fakeServer(pm, { member: true, offices: [office()] }); await signIn(pm, 'http://127.0.0.1:8090/link/?phones'); await pm.waitForSelector('#myPhonePage');
    assert.ok(!(await pm.$('[data-more]')) && !(await pm.$('#cophones')), 'no Desk phones list or ⋯ menu for a member');
    assert.ok(!(await pm.evaluate(() => document.body.innerText.includes('Advanced setup'))), 'no Advanced setup for a member');
    console.log('member ?phones -> My phone, no Advanced setup: ok');

    // 10. Let Riyeser help
    await pg.waitForSelector('#losupon'); await pg.click('#losupon'); await pg.waitForSelector('#losupend');
    assert.match(await text(pg, '#losupport'), /^Riyeser support can see and change your phone set-up until \d{1,2}:\d\d(am|pm)\. Everything they do is in your 🕘 History\.$/);
    await pg.click('#losupend'); await pg.waitForSelector('#losupon');
    assert.ok(st.calls.includes('link_support_allow') && st.calls.includes('link_support_end'));

    // "The test call worked" was ticked in Add desk phone -> all 5 done -> folded away
    await pg.waitForSelector('.lo-setdone');
    console.log('all done:', await text(pg, '.lo-setdone'));
    assert.strictEqual(await text(pg, '.lo-setdone'), '✓ Office phones are set up · Show the steps');
    await pg.click('[data-step="show"]'); await pg.waitForSelector('.lo-setup'); await pg.click('[data-step="hide"]'); await pg.waitForSelector('.lo-setdone');

    // the chat sidebar: ☎ Desk phones, and ⚙ Settings → Desk phones
    await pg.click('#phback'); await pg.waitForSelector('.hco'); await pg.click('#hchat'); await pg.waitForSelector('#cophones');
    await pg.click('#cophones'); await pg.waitForSelector('#loaddr'); await pg.click('#phback'); await pg.waitForSelector('#coset');
    await pg.click('#coset'); await pg.waitForSelector('[data-s=phones]');
    await pg.screenshot({ path: out + '/settings-menu.png' });
    await pg.click('[data-s=phones]'); await pg.waitForSelector('#loaddr'); console.log('⚙ Settings → Desk phones: ok');

    // 11. real calls made: step 5 ticks itself (no tick by hand)
    const p11 = await b.newPage({ viewport: { width: 1100, height: 800 } }); p11.on('pageerror', (e) => errs.push(e.message));
    const done = office(); done.phones = done.phones.filter((p) => p.assigned); done.counts.calls_made = 4;
    await fakeServer(p11, { offices: [done] }); await signIn(p11, 'http://127.0.0.1:8090/link/?phones'); await p11.waitForSelector('.lo-setdone');
    await p11.screenshot({ path: out + '/phones-allset.png' });
    // no calls reported: "Done" by hand
    const p12 = await b.newPage({ viewport: { width: 1100, height: 800 } }); p12.on('pageerror', (e) => errs.push(e.message));
    const nocall = office(); nocall.phones = nocall.phones.filter((p) => p.assigned);
    await fakeServer(p12, { offices: [nocall] }); await signIn(p12, 'http://127.0.0.1:8090/link/?phones'); await p12.waitForSelector('[data-step="test"]');
    assert.deepStrictEqual((await steps(p12)).map((x) => x[0]), ['✓', '✓', '✓', '✓', '·']);
    await p12.click('[data-step="test"]'); await p12.waitForSelector('.lo-setdone'); console.log('test call ticked by hand: folded away');

    // 12. not on Link Plus: the upsell
    const p8 = await b.newPage({ viewport: { width: 1100, height: 800 } }); p8.on('pageerror', (e) => errs.push(e.message));
    await fakeServer(p8, { noPlus: true, offices: [office()] }); await signIn(p8, 'http://127.0.0.1:8090/link/?phones'); await p8.waitForSelector('.lo-up');
    assert.match(await text(p8, '.lo-up p'), /^Desk phones and calls come with Riyeser Link Plus\./);

    // 13. an older database: the steps, nothing breaks
    const p9 = await b.newPage({ viewport: { width: 1100, height: 800 } }); p9.on('pageerror', (e) => errs.push('old db: ' + e.message));
    await fakeServer(p9, { oldDatabase: true }); await signIn(p9, 'http://127.0.0.1:8090/link/?phones'); await p9.waitForSelector('.lo-setup');
    assert.ok(!(await p9.$('#phonesPage .err')));

    // 14. phone width
    const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
    await fakeServer(ph, { offices: [office()] }); await signIn(ph, 'http://127.0.0.1:8090/link/?phones'); await ph.waitForSelector('#loaddr');
    const over = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth); console.log('phone overflow:', over);
    assert.strictEqual(over, 0);
    await ph.screenshot({ path: out + '/phones-phone.png', fullPage: true });
    await ph.tap('#loaddphone'); await ph.fill('#wf input[name=name]', 'Front'); await ph.tap('#wf .btn.p'); await ph.tap('#wf .btn.p');
    await ph.check('#wf input[name=ext][value="101"]'); await ph.tap('#wf .btn.p'); await ph.waitForSelector('#wf input[name=mac]');
    const over2 = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth); console.log('phone overflow (Add desk phone):', over2); assert.strictEqual(over2, 0);
    await ph.screenshot({ path: out + '/phones-phone-wizard.png' });

    // the demo works too
    const pd = await b.newPage(); pd.on('pageerror', (e) => errs.push('demo: ' + e.message));
    await pd.goto('http://127.0.0.1:8090/link/?demo&phones'); await pd.waitForSelector('#loaddr'); console.log('demo ?phones:', await text(pd, '#loaddr'));
    assert.deepStrictEqual((await rows(pd)).map((x) => x.st), ['Online', 'Online', 'Offline']);
  } catch (e) { failed = true; console.error('FAILED:', e.message); }
  console.log('errors:', errs); await b.close();
  if (failed || errs.length) process.exit(1);
  console.log('PHONES TESTS PASSED');
})();
