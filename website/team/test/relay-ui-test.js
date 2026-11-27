// Phones → Sites and the Riyeser relay, against a pretend Supabase:
//  1. the relay is set up but off: the section, the main and backup relays, the switch (owners/admins);
//  2. switching it on (link_relay_set), each site's relay status ("Connected · Sydney · 42 ms", "Using backup relay",
//     an office that needs updating), Disconnect → link_relay_revoke;
//  3. Set up a phone at home → the details once (username, password, TLS 5061) and a QR code of the one-time link;
//  4. an older database (no link_relay_* yet): the page works, no section, no errors;
//  5. calls never use Google's (or anyone else's) STUN: team.js has none, and link_relay_turn is what gives ICE servers.
// Run: build the site, serve website/public on 8090, then `node website/team/test/relay-ui-test.js <shots>`. Exits 1 on failure.
const { chromium } = require('playwright');
const assert = require('assert');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const office = (id, pc, version, relay) => ({ office_id: id, pc_name: pc, version, state: 'running', addresses: ['192.168.1.20'], sip_port: 5060, address_stable: true, licence: { active: true, text: 'Riyeser Link' },
  first_seen: ago(5000), last_seen: ago(2), counts: { people: 3, phones_assigned: 0 }, phones: [], extensions: [{ extension: '101', name: 'Alex Sample', type: 'person', registered: 1 }], relay });

async function fakeServer(page, opts = {}) {
  const st = { calls: [], bodies: {}, relay: { enabled: false, admin: true, relays: [{ id: 'syd1', host: 'relay.riyeser.com', region: 'Sydney', online: true }, { id: 'mel1', host: 'relay2.riyeser.com', region: 'Melbourne', online: true }],
    offices: [{ office_id: 'lo-suva', pc_name: 'SUVA-PC', version: '1.3.0', last_seen: ago(1), relay: { state: 'connecting' }, revoked: false },
      { office_id: 'lo-nadi', pc_name: 'NADI-PC', version: '1.3.0', last_seen: ago(1), relay: { state: 'connecting' }, revoked: false },
      { office_id: 'lo-old', pc_name: 'OLD-PC', version: '1.2.2', last_seen: ago(3), relay: null, revoked: false }], devices: [] } };
  await page.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  await page.route('https://fake.supabase.test/**', async (r) => {
    const u = new URL(r.request().url()); const m = r.request().method(); const fn = u.pathname.replace('/rest/v1/rpc/', '');
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const body = JSON.parse(r.request().postData() || '{}');
    if (u.pathname.startsWith('/rest/v1/rpc/')) { st.calls.push(fn); st.bodies[fn] = body; }
    if (opts.oldDatabase && fn.startsWith('link_relay')) return json({ code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` }, 404);
    if (u.pathname === '/auth/v1/token') return json({ access_token: token(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (u.pathname === '/auth/v1/user') return json(user);
    if (u.pathname === '/auth/v1/factors/f1/challenge') return json({ id: 'ch1', expires_at: Math.floor(Date.now() / 1000) + 300 });
    if (u.pathname === '/auth/v1/factors/f1/verify') return json({ access_token: token(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r2', user });
    if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex Sample', workspaces: { id: 'w1', name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business', country: 'Fiji' } }]);
    if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex Sample', role: 'owner', job_role: 'owner', extension: 101 }, { user_id: 'aaaaaaaa-0000-4000-8000-000000000002', display_name: 'Ned Nadi', role: 'member', job_role: 'staff', extension: 201 }]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    if (u.pathname === '/rest/v1/branches') return json([{ id: 'b1', name: 'Head office', code: 'HEA-1001', extension: 100, branch_members: [{ user_id: user.id }] }]);
    if (fn === 'company_licence') return json({ modules: { calls: { status: 'active', active: true, paid_until: '2027-06-30', days_left: 200 } }, seats: { included: 3, extra: 0, used: 2 } });
    if (fn === 'team_features') return json({ calls: true });
    if (fn === 'link_status') return json({ now: new Date().toISOString(), calls: true, offices: [office('lo-suva', 'SUVA-PC', '1.3.0')], support: null });
    if (fn === 'link_relay_status') return json(st.relay);
    if (fn === 'link_relay_set') {
      st.relay.enabled = body.enabled;
      st.relay.offices[0].relay = { state: 'connected', relay: 'syd1', region: 'Sydney', rtt_ms: 42, udp: 'ok', backup: false };
      st.relay.offices[1].relay = { state: 'connected', relay: 'mel1', region: 'Melbourne', rtt_ms: 61, udp: 'blocked', backup: true };
      return json({ enabled: body.enabled });
    }
    if (fn === 'link_relay_revoke') { const o = st.relay.offices.find((x) => x.office_id === body.office_id); o.revoked = !body.allow; return json(null); }
    if (fn === 'link_relay_device_add') {
      st.relay.devices.push({ id: 'd1', extension: body.extension, label: body.label || 'Phone at home', username: 'rk3m9x2q7wz', created_at: ago(0), online: false });
      return json({ id: 'd1', extension: body.extension, username: 'rk3m9x2q7wz', password: 'Qx8LzkPw3RtYv9Nm2Hs7', server: 'relay.riyeser.com', domain: 'relay.riyeser.com', port: 5061, transport: 'TLS', realm: 'riyeser-relay',
        self_signed: false, prov_url: 'https://relay.riyeser.com/prov/eyJ2IjoxfQ.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', prov_expires: new Date(Date.now() + 900e3).toISOString() });
    }
    if (fn === 'link_relay_turn') return json({ ice_servers: [{ urls: ['stun:relay.riyeser.com:3478', 'turn:relay.riyeser.com:3478?transport=udp'], username: '1:x', credential: 'y' }], ttl: 43200 });
    return json([]);
  });
  return st;
}
const signIn = async (pg, url) => { await pg.goto(url); await pg.waitForSelector('#gf'); await pg.fill('input[name=email]', user.email); await pg.fill('input[name=password]', 'a-good-password'); await pg.click('button[type=submit]'); };
async function unlock(p, code = '246810') { await p.waitForSelector('#mgucode'); await p.fill('#mgucode', code); await p.click('#mgugo'); }
const text = (pg, sel) => pg.textContent(sel).then((t) => t.replace(/\s+/g, ' ').trim());

(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.'; let failed = false;
  try {
    // 1. set up but off
    const pg = await b.newPage({ viewport: { width: 1280, height: 900 } }); pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
    const st = await fakeServer(pg);
    await signIn(pg, BASE + '/link/?phones'); await unlock(pg); await pg.waitForSelector('#lorelay');
    const sec = await text(pg, '#lorelay'); console.log('relay section (off):', sec.slice(0, 200));
    assert.match(sec, /Sites and the Riyeser relay/); assert.ok(!(await pg.isChecked('#lorelayon')), 'off to start with');
    assert.match(await text(pg, '#lorelays'), /Sydney \(main\) · online → Melbourne \(backup\) · online/);
    assert.ok(!(await pg.$('table.lo-sites')), 'no sites table until it is on');
    // 2. switch it on
    await pg.click('label.lo-relaysw'); await pg.waitForSelector('table.lo-sites');
    assert.deepStrictEqual(st.bodies.link_relay_set, { ws: 'w1', enabled: true });
    const sites = await pg.evaluate(() => [...document.querySelectorAll('table.lo-sites tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    console.log('sites:', sites);
    assert.match(sites[0], /^SUVA-PC · 1\.3\.0 Connected · Sydney · 42 ms/);
    assert.match(sites[1], /^NADI-PC · 1\.3\.0 Using backup relay · Melbourne · 61 ms .*blocks UDP/);
    assert.match(sites[2], /^OLD-PC · 1\.2\.2 Update needed/);
    await pg.screenshot({ path: out + '/relay-sites.png', fullPage: true });
    await pg.click('[data-relayoff="lo-nadi"]'); await pg.click('#askyes'); await pg.waitForFunction(() => /Allow again/.test(document.querySelector('[data-relayoff="lo-nadi"]').textContent));
    assert.deepStrictEqual(st.bodies.link_relay_revoke, { ws: 'w1', office_id: 'lo-nadi', allow: false });
    // 3. a phone at home
    await pg.click('#lorelayadd'); await pg.waitForSelector('#rpext');
    await pg.selectOption('#rpext', '201'); await pg.fill('#rplabel', 'Home'); await pg.click('#rpgo');
    await pg.waitForSelector('.lo-relaydet'); await pg.waitForSelector('#rpqr svg');
    const det = await text(pg, '.lo-relaydet'); console.log('phone at home:', det.slice(0, 220));
    assert.deepStrictEqual(st.bodies.link_relay_device_add, { ws: 'w1', extension: '201', label: 'Home' });
    assert.match(det, /Server \(domain\) ?relay\.riyeser\.com ?Port ?5061 ?Transport ?TLS ?Username ?rk3m9x2q7wz ?Password ?Qx8LzkPw3RtYv9Nm2Hs7/);
    assert.match(det, /shown only this once/); assert.match(det, /Linphone/);
    await pg.screenshot({ path: out + '/relay-phone-at-home.png' });
    await pg.click('#cl'); await pg.waitForSelector('table.lo-rdev');
    assert.match(await text(pg, 'table.lo-rdev'), /Home ?rk3m9x2q7wz ?201 Ned Nadi ?Not connected yet/);
    // phone width: no sideways scrolling
    await pg.setViewportSize({ width: 375, height: 800 }); await pg.waitForTimeout(200);
    assert.ok(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'fits a phone');
    // 4. an older database
    const po = await b.newPage({ viewport: { width: 1280, height: 900 } }); po.on('pageerror', (e) => errs.push('old: ' + e.message));
    await fakeServer(po, { oldDatabase: true }); await signIn(po, BASE + '/link/?phones'); await unlock(po); await po.waitForSelector('#loaddr');
    assert.ok(!(await po.$('#lorelay')), 'no relay section on an older database');
    // 5. no outside STUN anywhere in the app
    const js = await (await pg.request.get(BASE + '/link/team.js')).text();
    assert.ok(!/stun\.l\.google|stun1\.l\.google|:19302/.test(js), 'no Google STUN in team.js');
    assert.match(js, /link_relay_turn/);
    if (errs.length) throw new Error(`page errors: ${errs.join(' | ')}`);
    console.log('relay-ui-test: all passed');
  } catch (e) { failed = true; console.error('FAILED:', e.message); } finally { await b.close(); }
  process.exit(failed ? 1 : 0);
})();
