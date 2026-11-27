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
// 12. Riyeser Link paused: how to add it. 13. An older database: the steps, no errors. 14. Phone width: no sideways scrolling.
// Link Office 1.2.3 (one control panel): 15. Overview (Needs attention, tiles; a number opens the filtered list). 16. Every phone
// in one list: search, sort, filters, tick boxes, select all shown, the bar for many at once (Give to… per person or numbered in
// order, Restart, Remove) with the office's summary. 17. Add several phones (paste or CSV, the preview, fix in place, add).
// 18. Each phone's panel: Restart, Find this phone, Ignore, its settings (only what its maker supports), Save and restart.
// 19. An older Riyeser Link Office: says to update it.
// Run: build the site, serve website/public on 8090, then `node website/team/test/phones-test.js <shots>`. Exits 1 on any failure.
const { chromium, devices } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';   // LINK_BASE=http://127.0.0.1:8091 to use another port
const crypto = require('crypto');
const assert = require('assert');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
const PASSWORD = 'Hk7mPx2vRt9wQs4n';   // made up: "the office PC's" password for extension 101
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const office = (more = {}) => ({ office_id: 'lo-0001', pc_name: 'OFFICE-PC', version: '1.1.1', state: 'running', addresses: ['192.168.1.20'], sip_port: 5060, address_stable: false,
  pc_mac: '3C:52:82:1A:2B:3C', licence: { active: true, state: 'active', text: 'Riyeser Link' }, first_seen: ago(5000), last_seen: ago(2),
  counts: { people: 3, groups: 1, phones_assigned: 4, phones_connected: 1, new_phones: 1, calls_in_progress: 0, calls_made: 0 },
  phones: [{ mac: '001565aabbcc', vendor: 'Yealink', model: 'T31P', extension: '101', assigned: true, registered: true, last_registered: ago(0), ip: '192.168.1.31', name: 'Reception', location: 'Head office', provisioned_at: ago(3000) },
    { mac: '000b82112233', vendor: 'Grandstream', model: 'GRP2601P', extension: '102', assigned: true, registered: false, last_registered: ago(90), ip: '192.168.1.32', name: 'Accounts', location: 'Head office', provisioned_at: ago(3000) },
    { mac: '000413778899', vendor: 'Snom', model: 'D735', extension: '103', assigned: true, registered: false, last_registered: null, ip: '192.168.1.33', name: 'Workshop', location: '', provisioned_at: ago(1) },
    { mac: '0004f2aabbcc', vendor: 'Polycom', model: 'VVX 250', extension: '103', assigned: true, registered: false, last_registered: null, ip: null, name: '', location: '', provisioned_at: null },
    { mac: '001565ddeeff', vendor: 'Yealink', model: 'T33G', extension: null, assigned: false, registered: false, last_registered: null, ip: '192.168.1.44' }],
  extensions: [{ extension: '100', name: 'Head office', type: 'group', members: 3 }, { extension: '101', name: 'Alex Sample', type: 'person', registered: 1, desk_phones: 1, app_users: 0, dnd: false },
    { extension: '102', name: 'Bo Example', type: 'person', registered: 0, desk_phones: 1, app_users: 0, dnd: false }, { extension: '103', name: 'Cam Test', type: 'person', registered: 1, desk_phones: 2, app_users: 1, dnd: false }],
  ...more });

// Management (and so Desk phones) asks for a fresh two-step code each time: the pretend server takes 246810
async function unlock(p, code = '246810') { await p.waitForSelector('#mgucode'); await p.fill('#mgucode', code); await p.click('#mgugo'); }
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
    // Management's fresh code (a new challenge and verify on the two-step factor)
    if (u.pathname === '/auth/v1/factors/f1/challenge') { (st.calls || []).push('mfa_challenge'); return json({ id: 'ch1', expires_at: Math.floor(Date.now() / 1000) + 300 }); }
    if (u.pathname === '/auth/v1/factors/f1/verify') { const code = JSON.parse(r.request().postData()).code; if (code !== '246810') return json({ code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }, 422);
      return json({ access_token: token(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r2', user }); }
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
        if (c.kind === 'bulk_phones') {   // Link Office 1.2.3: many phones at once, with its summary back
          const d = c.data; const n = (k) => `${k} phone${k === 1 ? '' : 's'}`;
          if (d.action === 'give') { let e = Number(d.start) || 201; for (const m of d.macs) Object.assign(phones.find((p) => p.mac === m), { assigned: true, extension: (d.to || {})[m] || String(e++) }); c.result = { summary: `Gave out ${n(d.macs.length)}.`, done: d.macs.length }; }
          if (d.action === 'add') { for (const r of d.rows) phones.push({ mac: r.macText.replace(/[^0-9a-f]/gi, '').toLowerCase(), vendor: '', model: '', extension: r.ext || null, assigned: !!r.ext, registered: false, last_registered: null, ip: null, name: r.name || '', location: r.location || '' });
            c.result = { summary: `Added ${n(d.rows.length)}, 1 skipped: duplicates.`, added: d.rows.length, skipped: [{ mac: '001565aabbcc', why: 'duplicates' }] }; }
          if (d.action === 'restart') c.result = { summary: `Restarted ${n(d.macs.length - 1)}, 1 skipped: not on the network now.` };
          if (d.action === 'remove') { st.offices[0].phones = phones.filter((p) => !d.macs.includes(p.mac)); c.result = { summary: `Removed ${n(d.macs.length)}.` }; }
        }
        if (c.kind === 'phone_action' && c.data.action === 'ignore') Object.assign(phones.find((p) => p.mac === c.data.mac), { ignored: true });
        if (c.kind === 'phone_action' && c.data.action === 'find' && !phones.find((p) => p.mac === c.data.mac).registered) { c.status = 'failed'; c.error = 'That phone isn\'t connected right now, so it can\'t ring.'; }
        if (c.kind === 'phone_settings') { Object.assign(phones.find((p) => p.mac === c.data.mac), { settings: c.data.settings }); c.result = { applied: Object.keys(c.data.settings) }; }
      }
      return json({ id: c.id, kind: c.kind, status: c.status, error: c.error || null, result: c.result || null, ready: !!c.sealed });
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
    await fakeServer(p1); await signIn(p1, BASE + '/link/'); await p1.waitForSelector('#hphones');
    console.log('home tile:', await text(p1, '#hphones'));
    await p1.click('#hphones'); await unlock(p1); await p1.waitForSelector('.lo-setup');
    const s1 = await steps(p1); console.log('steps, nothing yet:', s1);
    assert.deepStrictEqual(s1, ['· Install Riyeser Link Office on a PC at the office that stays on.', '· Sign in on that PC.', '· Plug in your desk phones.', '· Give each phone to a person.', '· Make a test call.']);
    assert.strictEqual(await p1.getAttribute('.lo-setup a.btn', 'href'), '/help/link.html#desk-phones');
    assert.match(await text(p1, '.hbrand-t'), /Management › ☎ Desk phones/);
    await p1.screenshot({ path: out + '/phones-guide.png', fullPage: true });
    await p1.click('#phback'); await p1.waitForSelector('.hco'); console.log('back to Riyeser home: ok');

    // 2. with a heartbeat, straight from riyeser.com/link/?phones
    const pg = await b.newPage({ viewport: { width: 1280, height: 900 } }); pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
    const st = await fakeServer(pg, { offices: [office()] });
    await signIn(pg, BASE + '/link/?phones'); await unlock(pg); await pg.waitForSelector('#loaddr');
    console.log('server address:', await text(pg, '#loaddr'), 'port', await text(pg, '#loport'), '| state:', await text(pg, '#lostate'), '| seen:', await text(pg, '#loseen'));
    assert.strictEqual(await text(pg, '#loaddr'), '192.168.1.20'); assert.strictEqual(await text(pg, '#loport'), '5060'); assert.strictEqual(await text(pg, '#lostate'), 'Running');
    const warn = await text(pg, '.lo-warn'); assert.match(warn, /DHCP reservation/); assert.match(warn, /3C:52:82:1A:2B:3C/);
    const s2 = await steps(pg); console.log('steps:', s2);
    // the control panel opens on Overview: what needs attention, and a tile for each part
    const attn = await pg.evaluate(() => [...document.querySelectorAll('#loattn li')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    console.log('needs attention:', attn);
    assert.ok(attn.some((x) => /^1 new phone waiting to be given out\. Give out 1 new phone$/.test(x)) && attn.some((x) => /^1 phone offline: Accounts\. Show them$/.test(x)), 'new and offline phones');
    assert.ok(attn.some((x) => /keeps changing/.test(x)), 'the address isn\'t stable');
    assert.ok(attn.some((x) => /Update Riyeser Link Office on OFFICE-PC \(version 1\.1\.1\)/.test(x)), 'an older Link Office: update it');
    const tiles = await pg.evaluate(() => [...document.querySelectorAll('.lo-tile h4')].map((x) => x.textContent));
    assert.deepStrictEqual(tiles, ['☎ Phones', '🖥 Office PC', '👥 People', '↗ Calls', '☏ Ring groups', '🏢 Branches and relay']);
    await pg.screenshot({ path: out + '/phones-overview.png', fullPage: true });
    await pg.click('.lo-tile [data-lof="Offline"]'); await pg.waitForSelector('[data-lopane="phones"]:not([hidden])');
    assert.deepStrictEqual((await rows(pg)).map((x) => x.st), ['Offline'], 'a tile number opens the filtered list');
    await pg.selectOption('#lost', 'all');
    assert.deepStrictEqual(s2.map((x) => x[0]), ['✓', '✓', '✓', '·', '·'], 'installed, signed in, phones plugged in; one not given; no test call');
    const list = await rows(pg); console.log('desk phones:', list.map((x) => x.text));
    assert.deepStrictEqual(list.map((x) => x.st), ['New', 'Offline', 'Waiting for phone', 'Configuring', 'Online'], 'every phone, new ones first, then what needs a look');
    assert.match(list[4].text, /^☎ Reception Head office 101 Alex Sample Yealink T31P 00:15:65:AA:BB:CC 192\.168\.1\.31 Online Now/);
    assert.match(list[1].text, /^☎ Accounts Head office 102 Bo Example Grandstream GRP2601P .* Offline \d+ h ago/);
    assert.match(list[2].text, /^☎ Polycom VVX 250 — 103 Cam Test Polycom VVX 250 00:04:F2:AA:BB:CC — Waiting for phone Never/);
    assert.match(list[0].text, /^☎ New phone — — — Yealink T33G 00:15:65:DD:EE:FF 192\.168\.1\.44 New/);
    assert.ok(await pg.$('#loaddphone'), '+ Add desk phone above the list');
    await pg.click('[data-lotab="ext"]');
    const exts = await pg.evaluate(() => [...document.querySelectorAll('table.lo-ext tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    assert.ok(exts.some((x) => /^101 Alex Sample ● Yealink T31P 00:15:65:AA:BB:CC/.test(x))); assert.ok(exts.some((x) => /^100 Head office ring group · 3 people/.test(x)));
    await pg.click('[data-lotab="phones"]'); console.log('new phones found:', await text(pg, '.lo-found'));
    await pg.screenshot({ path: out + '/phones-page.png', fullPage: true });
    await pg.click('[data-lotab="overview"]');

    // 2b. Link Office 1.2.0: the PC's address changed -> the notice, the new address, its names, the reservation link
    const pa = await b.newPage({ viewport: { width: 1280, height: 900 } }); pa.on('pageerror', (e) => errs.push('address: ' + e.message));
    await fakeServer(pa, { offices: [office({ version: '1.2.0', addresses: ['192.168.1.35'], address_stable: true, mdns_name: 'riyeser-office.local', router_name: 'office-pc.lan', phone_server: '192.168.1.35',
      address_changes: [{ from: '192.168.1.20', to: '192.168.1.35', at: ago(3) }] })] });
    await signIn(pa, BASE + '/link/?phones'); await unlock(pa); await pa.waitForSelector('#lomoved');
    const moved = await text(pa, '#lomoved'); console.log('address changed:', moved);
    assert.match(moved, /^ℹ️ The office PC's address changed from 192\.168\.1\.20 to \.35 — phones updated/);
    assert.strictEqual(await text(pa, '#loaddr'), '192.168.1.35');
    assert.match(await text(pa, '#lonames'), /riyeser-office\.local and office-pc\.lan/);
    assert.ok(!(await pa.$('#loname')), 'phones are given the address, so no "given the name" line');
    assert.ok(await pa.$('.lo-top a[href="/help/link.html#stable-address"]'), 'how to reserve it');
    await pa.screenshot({ path: out + '/phones-address-changed.png', fullPage: false });
    // given the router's name: the line says so, and Set up a phone by hand shows the name
    const pn = await b.newPage({ viewport: { width: 1280, height: 900 } }); pn.on('pageerror', (e) => errs.push('name: ' + e.message));
    await fakeServer(pn, { offices: [office({ version: '1.2.0', addresses: ['192.168.1.35'], address_stable: true, mdns_name: 'riyeser-office.local', router_name: 'office-pc.lan', phone_server: 'office-pc.lan', address_changes: [] })] });
    await signIn(pn, BASE + '/link/?phones'); await unlock(pn); await pn.waitForSelector('#loname');
    assert.match(await text(pn, '#loname'), /given the name office-pc\.lan/); assert.ok(!(await pn.$('#lomoved')), 'no change: no notice');
    await pn.close(); await pa.close();

    // 3. a new phone found -> Give to… -> sent, then done; step 4 ticks itself
    await pg.click('[data-lotab="phones"]'); await pg.click('tr[data-mac="001565ddeeff"] td[data-l="Name"]'); await pg.waitForSelector('#lopanel [data-give="001565ddeeff"]');
    await pg.screenshot({ path: out + '/phones-panel-new.png' });
    await pg.click('[data-give="001565ddeeff"]'); await pg.waitForSelector('[data-to="103"]');
    await pg.click('[data-to="103"]');
    await pg.waitForFunction(() => /Sending to Riyeser Link Office…/.test(document.querySelector('#gstat').textContent));
    await pg.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 8000 });
    assert.deepStrictEqual(st.commands.find((c) => c.kind === 'assign_phone').data, { mac: '001565ddeeff', extension: '103' });
    await pg.waitForFunction(() => !document.querySelector('[data-give]'), null, { timeout: 5000 });
    assert.strictEqual((await steps(pg))[3][0], '✓', 'every phone given to someone');

    // 4. set up a phone by hand -> Show (Extensions)
    await pg.click('#lopclose'); await pg.click('[data-lotab="ext"]');
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
    await pg.click('#newpw'); await pg.click('#askyes'); await pg.waitForFunction(() => /New password made/.test(document.querySelector('#hstat').textContent), null, { timeout: 8000 });
    await pg.click('#cl');

    // 5. Do not disturb
    await pg.click('label:has([data-dnd="102"]) span');
    await pg.waitForFunction(() => /Done/.test((document.getElementById('phmsg') || {}).textContent || ''), null, { timeout: 8000 });
    assert.deepStrictEqual(st.commands.find((c) => c.kind === 'set_dnd').data, { extension: '102', on: true });

    // 6. + Add desk phone, through to Online
    await pg.click('[data-lotab="phones"]'); await pg.click('#loaddphone'); await pg.waitForSelector('#wf input[name=name]');
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
    await pg.click('tr[data-mac="000b82112233"] td[data-l="Name"]'); await pg.waitForSelector('#lopanel [data-m=replace]');
    const menu = await pg.evaluate(() => [...document.querySelectorAll('#lopanel .lo-pacts .btn')].map((x) => x.textContent));
    console.log('phone panel:', menu);
    assert.deepStrictEqual(menu, ['Restart', 'Re-send settings', 'View setup', 'Troubleshoot', 'Replace phone', 'Advanced setup (manual SIP)', 'Remove from this person', 'Remove']);
    assert.match(await pg.evaluate(() => document.querySelector('#lopanel .lo-pkv').innerText.replace(/\s+/g, ' ')), /^Extension 102 Bo Example Location Head office IP address 192\.168\.1\.32 Last seen \d+ h ago Settings fetched/);
    await pg.screenshot({ path: out + '/phones-panel.png' });
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
    await pg.waitForFunction(() => { const r = [...document.querySelectorAll('table.lo-dp tbody tr')]; return !r.some((x) => x.dataset.mac === '000b82112233') && r.some((x) => x.dataset.mac === '000b82445566' && /Accounts/.test(x.innerText) && /102\s+Bo Example/.test(x.innerText)); }, null, { timeout: 8000 });

    // 8. Troubleshoot, and Report a phone issue
    await pg.click('tr[data-mac="0004f2aabbcc"] td[data-l="Name"]'); await pg.click('#lopanel [data-m=trouble]'); await pg.waitForSelector('.lo-check');
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

    // Name and location (in the panel), and View setup
    await pg.fill('#lopname input[name=name]', 'Store room'); await pg.selectOption('#lopname select[name=branch]', 'Head office'); await pg.click('#lopname .btn');
    await pg.waitForFunction(() => /Done/.test((document.getElementById('lopstat') || {}).textContent || ''), null, { timeout: 8000 });
    assert.deepStrictEqual(st.commands[st.commands.length - 1].data, { mac: '0004f2aabbcc', name: 'Store room', branch: 'Head office', note: '' });
    await pg.click('#lopanel [data-m=view]'); await pg.waitForSelector('#vlive .lo-live');
    await pg.screenshot({ path: out + '/view-setup.png' }); await pg.click('.modal #cl');

    // 16. every phone in one list: search, filters, sort, tick boxes, select all shown, the bar for many at once
    await pg.click('#lopclose');
    st.offices[0].phones.push({ mac: '000b82aa0001', vendor: 'Grandstream', model: 'GRP2602P', extension: null, assigned: false, registered: false, ip: '192.168.1.51' },
      { mac: '000b82aa0002', vendor: 'Grandstream', model: 'GRP2602P', extension: null, assigned: false, registered: false, ip: '192.168.1.52' },
      { mac: 'c074ad000777', vendor: 'Grandstream', model: 'HT802', extension: null, assigned: false, ignored: true, registered: false, ip: '192.168.1.80' });
    await pg.evaluate(() => window.RiyeserTeam && 0); await pg.click('[data-lotab="overview"]'); await pg.click('[data-lotab="phones"]');
    await pg.waitForTimeout(100); await pg.evaluate(() => document.querySelector('#loq').dispatchEvent(new Event('input')));
    await pg.waitForFunction(() => document.querySelectorAll('table.lo-dp tbody tr').length >= 7, null, { timeout: 25000 });   // the next refresh brings the new ones
    const all = await rows(pg); console.log('all phones:', all.map((x) => `${x.st}`).join(', '));
    assert.ok(all.some((x) => x.st === 'Ignored'), 'ignored phones are listed too');
    await pg.fill('#loq', 'GRP2602P'); assert.deepStrictEqual((await rows(pg)).map((x) => x.mac).sort(), ['000b82aa0001', '000b82aa0002']);
    await pg.fill('#loq', ''); await pg.selectOption('#lost', 'New'); assert.ok((await rows(pg)).every((x) => x.st === 'New'));
    await pg.selectOption('#lost', 'all'); await pg.selectOption('#loas', 'yes'); assert.ok((await rows(pg)).every((x) => !/ New| Ignored/.test(x.st)));
    await pg.selectOption('#loas', ''); await pg.click('th[data-sort="ip"]');
    const ips = await pg.evaluate(() => [...document.querySelectorAll('table.lo-dp tbody td[data-l="IP"]')].map((x) => x.textContent).filter((x) => x !== '—'));
    assert.deepStrictEqual(ips, [...ips].sort(), 'sorted by IP');
    await pg.click('th[data-sort="status"]');
    await pg.selectOption('#lost', 'New'); await pg.check('#loall');
    assert.deepStrictEqual(await pg.evaluate(() => [document.querySelector('#lobulk b').textContent, ...[...document.querySelectorAll('#lobulk [data-bulk]')].map((x) => x.textContent)]),
      ['2 phones selected', 'Give to…', 'Add as shared phones', 'Move location', 'Restart', 'Ignore', 'Remove', 'Clear'], 'only what fits new phones');
    await pg.screenshot({ path: out + '/phones-bulkbar.png' });
    await pg.click('[data-bulk="give"]'); await pg.waitForSelector('[data-gto="000b82aa0001"]');
    await pg.screenshot({ path: out + '/phones-give.png' });
    await pg.click('#gmgo'); assert.match(await text(pg, '#gmstat'), /Choose who each phone is for/);
    await pg.selectOption('[data-gto="000b82aa0001"]', '101'); await pg.selectOption('[data-gto="000b82aa0002"]', '102'); await pg.click('#gmgo');
    await pg.waitForFunction(() => /Gave out 2 phones\./.test((document.getElementById('gmstat') || {}).textContent || ''), null, { timeout: 8000 });
    const give = st.commands.filter((c) => c.kind === 'bulk_phones').pop();
    assert.deepStrictEqual(give.data, { action: 'give', macs: ['000b82aa0001', '000b82aa0002'], to: { '000b82aa0001': '101', '000b82aa0002': '102' } }, 'one change for both');
    await pg.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 5000 });
    // restart and remove many: the office's summary shows
    await pg.selectOption('#lost', 'all'); await pg.check('[data-pick="000b82aa0001"]'); await pg.check('[data-pick="000b82aa0002"]');
    await pg.click('[data-bulk="restart"]'); await pg.click('#askyes');
    await pg.waitForFunction(() => /Restarted 1 phone, 1 skipped: not on the network now\./.test((document.getElementById('phmsg') || {}).textContent || ''), null, { timeout: 8000 });
    assert.strictEqual(await text(pg, '#lobulk b'), '2 phones selected', 'still ticked after a restart');
    await pg.click('[data-bulk="clear"]'); await pg.check('[data-pick="c074ad000777"]'); await pg.click('[data-bulk="remove"]'); await pg.click('#askyes');
    await pg.waitForFunction(() => /Removed 1 phone\./.test((document.getElementById('phmsg') || {}).textContent || ''), null, { timeout: 8000 });
    assert.deepStrictEqual(st.commands.filter((c) => c.kind === 'bulk_phones').pop().data, { action: 'remove', macs: ['c074ad000777'] }, 'only what was still ticked');
    console.log('bulk give, restart, remove: ok');

    // 17. Add several phones: paste, the preview, fix a row in place, add
    await pg.click('#loaddmany'); await pg.waitForSelector('#amtext');
    await pg.fill('#amtext', 'MAC,Model,Extension,Person,Phone name,Location\n00:15:65:12:34:56,Yealink T31P,,Bo Example,Bo desk,Head office\n000B82123457,,,,Kitchen,Nadi branch\n001565aabbcc,,,,,\n00:15:65:12:34:56,,,,,\nnot-a-mac,,,,,');
    await pg.waitForFunction(() => document.querySelectorAll('table.lo-am tbody tr').length === 5);
    assert.match(await text(pg, '#amsum'), /^2 phones to add · 2 skipped \(already added or twice in the list\) · 1 to fix$/);
    const pv = await pg.evaluate(() => [...document.querySelectorAll('table.lo-am td.lo-chk')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    console.log('preview:', pv);
    assert.match(pv[0], /^OK Yealink · ext\. 102 \(Bo Example\)/); assert.match(pv[1], /^OK Grandstream/); assert.match(pv[2], /^Skip .*Already added \(extension 101\)/);
    assert.match(pv[3], /Twice in this list/); assert.match(pv[4], /^Fix not-a-mac isn't a MAC address/);
    await pg.fill('table.lo-am tr[data-i="4"] input[data-f="macText"]', '00-04-13-44-55-77'); await pg.press('table.lo-am tr[data-i="4"] input[data-f="macText"]', 'Tab');
    await pg.waitForFunction(() => /^3 phones to add/.test(document.querySelector('#amsum').textContent));
    await pg.check('[name=ammode][value=auto]');
    await pg.screenshot({ path: out + '/phones-addmany.png' });
    assert.match(await pg.getAttribute('#amtpl', 'href'), /^blob:/, 'the CSV template downloads');
    await pg.click('#amgo');
    await pg.waitForFunction(() => /Added 3 phones, 1 skipped: duplicates\./.test(document.querySelector('#amsum').textContent), null, { timeout: 8000 });
    const add = st.commands.filter((c) => c.kind === 'bulk_phones').pop().data;
    assert.deepStrictEqual([add.action, add.auto, add.rows.map((r) => r.macText)], ['add', true, ['00:15:65:12:34:56', '000B82123457', '00-04-13-44-55-77']], 'only the rows to add');
    await pg.screenshot({ path: out + '/phones-addmany-done.png' });
    await pg.click('.modal #cl');

    // 18. each phone's panel: its settings (only what its maker supports), Save and restart, Find this phone, Ignore
    await pg.click('tr[data-mac="001565aabbcc"] td[data-l="Name"]'); await pg.waitForSelector('#lopsf');
    const fields = await pg.evaluate(() => [...document.querySelectorAll('#lopsf label.f > span')].map((x) => x.textContent));
    assert.deepStrictEqual(fields, ['Name on the line key', 'Name shown on calls', 'Time zone', 'Clock', 'Language', 'Ringtone', 'Ring volume', 'Do not disturb'], 'Yealink: everything');
    await pg.selectOption('#lopsf [name=timeFormat]', '24'); await pg.selectOption('#lopsf [name=ringVolume]', '9'); await pg.fill('#lopsf [name=kv0]', '102'); await pg.fill('#lopsf [name=kl0]', 'Bo');
    await pg.screenshot({ path: out + '/phones-panel-settings.png' });
    await pg.click('#lopsf [value=restart]');
    await pg.waitForFunction(() => /Done/.test((document.getElementById('lopstat') || {}).textContent || ''), null, { timeout: 15000 });
    const sk = st.commands.filter((c) => c.kind === 'phone_settings' || c.kind === 'phone_action').slice(-2);
    assert.deepStrictEqual(sk.map((c) => [c.kind, c.data]), [['phone_settings', { mac: '001565aabbcc', settings: { timeFormat: '24', ringVolume: '9', lineKeys: [{ value: '102', label: 'Bo' }] } }], ['phone_action', { mac: '001565aabbcc', action: 'restart' }]]);
    await pg.click('#lopanel [data-pa="find"]');
    await pg.waitForFunction(() => /Done|connected right now/.test((document.getElementById('lopstat') || {}).textContent || ''), null, { timeout: 8000 });
    await pg.click('tr[data-mac="0004f2aabbcc"] td[data-l="Name"]'); await pg.waitForSelector('#lopanel');
    assert.ok(!(await pg.$('#lopanel [data-pa="find"]')), 'Find this phone only for a phone that is connected');
    assert.deepStrictEqual(await pg.evaluate(() => [...document.querySelectorAll('#lopsf label.f > span')].map((x) => x.textContent)),
      ['Name on the line key', 'Name shown on calls', 'Time zone', 'Clock', 'Language', 'Ringtone'], 'Polycom: only what its settings file carries');
    st.offices[0].phones.filter((p) => !p.assigned).forEach((p, i) => Object.assign(p, { assigned: true, ignored: false, extension: String(201 + i) }));   // the office numbered them (auto)
    console.log('phone panel settings: ok');

    // 9. Advanced setup (manual SIP): admins get it; a member can't open the Desk phones page at all (they get My phone)
    await pg.click('tr[data-mac="001565aabbcc"] td[data-l="Name"]'); await pg.click('#lopanel [data-m=adv]'); await pg.waitForSelector('#show');
    assert.match(await text(pg, '.mcard h3'), /Advanced setup \(manual SIP\)/); await pg.click('.mcard #cl');
    const pm = await b.newPage({ viewport: { width: 1100, height: 800 } }); pm.on('pageerror', (e) => errs.push('member: ' + e.message));
    await fakeServer(pm, { member: true, offices: [office()] }); await signIn(pm, BASE + '/link/?phones'); await pm.waitForSelector('#myPhonePage');
    assert.ok(!(await pm.$('[data-more]')) && !(await pm.$('#cophones')), 'no Desk phones list or ⋯ menu for a member');
    assert.ok(!(await pm.evaluate(() => document.body.innerText.includes('Advanced setup'))), 'no Advanced setup for a member');
    console.log('member ?phones -> My phone, no Advanced setup: ok');

    // 10. Let Riyeser help
    await pg.click('[data-lotab="help"]'); await pg.waitForSelector('#losupon'); await pg.click('#losupon'); await pg.click('#askyes'); await pg.waitForSelector('#losupend');
    assert.match(await text(pg, '#losupport'), /^Riyeser support can see and change your phone set-up until \d{1,2}:\d\d(am|pm)\. Everything they do is in your 🕘 History\.$/);
    await pg.click('#losupend'); await pg.waitForSelector('#losupon');
    assert.ok(st.calls.includes('link_support_allow') && st.calls.includes('link_support_end'));

    // "The test call worked" was ticked in Add desk phone -> all 5 done -> folded away
    await pg.waitForSelector('.lo-setdone');
    console.log('all done:', await text(pg, '.lo-setdone'));
    assert.strictEqual(await text(pg, '.lo-setdone'), '✓ Office phones are set up · Show the steps');
    await pg.click('[data-step="show"]'); await pg.waitForSelector('.lo-setup'); await pg.click('[data-step="hide"]'); await pg.waitForSelector('.lo-setdone');

    // Management → Desk phones (a fresh two-step code first), and back to Management
    await pg.click('#phback'); await pg.waitForSelector('.hco'); await pg.click('#hchat'); await pg.waitForSelector('#lkshell');
    await pg.click('#umenu'); await pg.click('#um-mgmt'); await pg.waitForSelector('#cophones');   // still unlocked from opening Desk phones
    await pg.evaluate(() => window.RiyeserTeam.management.lock()); await pg.waitForSelector('#mgcode');   // locked again: a fresh code
    await pg.fill('#mgcode', '111111'); await pg.click('#mgunlock'); await pg.waitForSelector('#mgerr:not([hidden])');
    await pg.fill('#mgcode', '246810'); await pg.click('#mgunlock'); await pg.waitForSelector('#cophones');
    await pg.screenshot({ path: out + '/settings-menu.png' });
    await pg.click('#cophones'); await pg.waitForSelector('#loaddr'); assert.match(await text(pg, '#phback'), /Back to Management/);
    await pg.click('#phback'); await pg.waitForSelector('#mgopen'); console.log('Management → Desk phones: ok');

    // 11. real calls made: step 5 ticks itself (no tick by hand)
    const p11 = await b.newPage({ viewport: { width: 1100, height: 800 } }); p11.on('pageerror', (e) => errs.push(e.message));
    const done = office(); done.phones = done.phones.filter((p) => p.assigned); done.counts.calls_made = 4;
    await fakeServer(p11, { offices: [done] }); await signIn(p11, BASE + '/link/?phones'); await unlock(p11); await p11.waitForSelector('.lo-setdone');
    await p11.screenshot({ path: out + '/phones-allset.png' });
    // no calls reported: "Done" by hand
    const p12 = await b.newPage({ viewport: { width: 1100, height: 800 } }); p12.on('pageerror', (e) => errs.push(e.message));
    const nocall = office(); nocall.phones = nocall.phones.filter((p) => p.assigned);
    await fakeServer(p12, { offices: [nocall] }); await signIn(p12, BASE + '/link/?phones'); await unlock(p12); await p12.waitForSelector('[data-step="test"]');
    assert.deepStrictEqual((await steps(p12)).map((x) => x[0]), ['✓', '✓', '✓', '✓', '·']);
    await p12.click('[data-step="test"]'); await p12.waitForSelector('.lo-setdone'); console.log('test call ticked by hand: folded away');

    // 12. Riyeser Link paused: how to add it
    const p8 = await b.newPage({ viewport: { width: 1100, height: 800 } }); p8.on('pageerror', (e) => errs.push(e.message));
    await fakeServer(p8, { noPlus: true, offices: [office()] }); await signIn(p8, BASE + '/link/?phones'); await unlock(p8); await p8.waitForSelector('.lo-up');
    assert.match(await text(p8, '.lo-up p'), /^Riyeser Link is paused, so desk phones and calls are paused too\./);

    // 13. an older database: the steps, nothing breaks
    const p9 = await b.newPage({ viewport: { width: 1100, height: 800 } }); p9.on('pageerror', (e) => errs.push('old db: ' + e.message));
    await fakeServer(p9, { oldDatabase: true }); await signIn(p9, BASE + '/link/?phones'); await unlock(p9); await p9.waitForSelector('.lo-setup');
    assert.ok(!(await p9.$('#phonesPage .err')));

    // 14. phone width
    const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
    await fakeServer(ph, { offices: [office()] }); await signIn(ph, BASE + '/link/?phones'); await unlock(ph); await ph.waitForSelector('#loaddr');
    const over = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth); console.log('phone overflow:', over);
    assert.strictEqual(over, 0);
    await ph.screenshot({ path: out + '/phones-phone.png', fullPage: true });
    await ph.tap('[data-lotab="phones"]'); await ph.screenshot({ path: out + '/phones-phone-list.png', fullPage: true });
    const over3 = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.strictEqual(over3, 0, 'the list at phone width');
    await ph.tap('#loaddphone'); await ph.fill('#wf input[name=name]', 'Front'); await ph.tap('#wf .btn.p'); await ph.tap('#wf .btn.p');
    await ph.check('#wf input[name=ext][value="101"]'); await ph.tap('#wf .btn.p'); await ph.waitForSelector('#wf input[name=mac]');
    const over2 = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth); console.log('phone overflow (Add desk phone):', over2); assert.strictEqual(over2, 0);
    await ph.screenshot({ path: out + '/phones-phone-wizard.png' });

    // the demo works too
    const pd = await b.newPage(); pd.on('pageerror', (e) => errs.push('demo: ' + e.message));
    await pd.goto(BASE + '/link/?demo&phones'); await unlock(pd, '123456'); await pd.waitForSelector('#loaddr'); console.log('demo ?phones:', await text(pd, '#loaddr'));
    await pd.click('[data-lotab="phones"]');
    assert.deepStrictEqual((await rows(pd)).map((x) => x.st), ['New', 'New', 'Offline', 'Online', 'Online']);
    // the demo gives out both new phones in order, with the office's summary
    await pd.check('#loall'); await pd.click('[data-bulk="give"]'); await pd.check('[name=gm][value=auto]'); await pd.click('#gmgo');
    await pd.waitForFunction(() => /Gave out 2 phones\./.test((document.getElementById('gmstat') || {}).textContent || ''), null, { timeout: 8000 });
    console.log('demo bulk give: ok');
  } catch (e) { failed = true; console.error('FAILED:', e.message); }
  console.log('errors:', errs); await b.close();
  if (failed || errs.length) process.exit(1);
  console.log('PHONES TESTS PASSED');
})();
