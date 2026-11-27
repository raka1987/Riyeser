// Link Office 1.3.1 on the website: Management → Desk phones → Sites & relay, against a pretend Supabase.
//  1. your relays: main and backup, last seen, version; Make it the main relay, Stop using it (link_relay_manage);
//     Riyeser's relay can't be removed from here
//  2. each site's checklist (from its reports): the relay PC with a closed router port, a site with UDP blocked
//  3. Advanced checks run on a chosen site's Link Office (link_command relay_check): test call, one check, raw details;
//     results come back as cards
//  4. Move to another PC: a one-time set-up code with the steps (link_relay_enroll_code, takes over)
//  5. Remove the last relay: a clear warning (LAST_RELAY), then confirm: the relay is switched off for the business
//  6. a phone: one column, big buttons, nothing sideways
// Run: build the site, serve website/public on 8090, then `node website/team/test/relay-remove-ui-test.js <shots>`.
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const office = (id, pc, version, relay) => ({ office_id: id, pc_name: pc, version, state: 'running', addresses: ['192.168.1.20'], sip_port: 5060, address_stable: true, licence: { active: true, text: 'Riyeser Link' },
  first_seen: ago(5000), last_seen: ago(2), counts: { people: 3, phones_assigned: 0 }, phones: [], extensions: [{ extension: '101', name: 'Alex Sample', type: 'person', registered: 1 }], relay });

const CHECKS = {
  allgood: [['pc', 'ok', 'Windows 10 or 11, plugged in, with room to spare.'], ['service', 'ok', 'Running (version 1.1.0), for 3 h.'], ['address', 'ok', 'This PC keeps the address 192.168.1.20.'], ['ports', 'ok', 'Open from the internet (tested from the relay mel1; the router forwards them automatically, UPnP).'], ['secure', 'ok', 'Sites check its certificate, and it\'s the right one.'], ['registered', 'ok', 'Registered with your business: Suva head office (main relay).'], ['switched', 'ok', 'Switched on for your business.'], ['internet', 'ok', 'Connected to the internet and Riyeser online.'], ['reach', 'ok', 'Connected to Suva head office · 3 ms.'], ['auth', 'ok', 'Allowed.'], ['sound', 'ok', 'Call sound (UDP) gets through to the relay.'], ['exts', 'ok', '4 extensions with a phone here announced · 2 other sites connected.'], ['test', 'ok', 'Sound both ways · 4 ms round trip · 0% lost.']],
  ports: [['pc', 'ok', 'Windows 10 or 11, plugged in, with room to spare.'], ['service', 'ok', 'Running (version 1.1.0), for 3 h.'], ['address', 'warn', 'This PC gets its address (192.168.1.20) from the router, which may change it.'], ['ports', 'fail', 'Closed from the internet: 3478/UDP.'], ['secure', 'ok', 'Sites check its certificate, and it\'s the right one.'], ['registered', 'ok', 'Registered with your business: Suva head office (main relay).'], ['switched', 'ok', 'Switched on for your business.'], ['internet', 'ok', 'Connected.'], ['reach', 'ok', 'Connected to Suva head office · 3 ms.'], ['auth', 'ok', 'Allowed.'], ['sound', 'ok', 'Call sound gets through.'], ['exts', 'ok', '4 extensions announced.'], ['test', 'ok', 'Sound both ways · 4 ms · 0% lost.']],
  udp: [['internet', 'ok', 'Connected to the internet and Riyeser online.'], ['reach', 'ok', 'Connected to Suva head office · 48 ms.'], ['auth', 'ok', 'Allowed.'], ['sound', 'fail', 'UDP blocked: calls to other sites connect, but there may be no sound.'], ['exts', 'ok', '2 extensions announced.'], ['test', 'fail', 'No sound came back: UDP to the relay seems blocked.']],
};
for (const k of Object.keys(CHECKS)) CHECKS[k] = CHECKS[k].map(([kk, s, t]) => ({ k: kk, s, t }));
async function fakeServer(page, opts = {}) {
  const st = { calls: [], bodies: {}, cmds: {}, relay: { enabled: true, admin: true, api: 2, relays: [{ id: 'syd1', host: 'relay.riyeser.com', region: 'Sydney', online: true }, { id: 'mel1', host: 'relay2.riyeser.com', region: 'Melbourne', online: true }],
    offices: [{ office_id: 'lo-suva', pc_name: 'SUVA-PC', version: '1.3.0', last_seen: ago(1), relay: { state: 'connecting' }, revoked: false },
      { office_id: 'lo-nadi', pc_name: 'NADI-PC', version: '1.3.0', last_seen: ago(1), relay: { state: 'connecting' }, revoked: false },
      { office_id: 'lo-old', pc_name: 'OLD-PC', version: '1.2.2', last_seen: ago(3), relay: null, revoked: false }], devices: [],
    manage: [{ id: 'suva1', host: 'suva1.relay.invalid', region: 'Suva head office', priority: 1, online: true, last_seen: ago(0), version: '1.1.0', managed: true, off: false },
      { id: 'mel1', host: 'relay2.riyeser.com', dns: true, region: 'Sydney (Riyeser)', priority: 2, online: true, last_seen: ago(0), version: '1.1.0', shared: true, off: false }] } };
  st.relay.relays = st.relay.manage.map((x) => ({ ...x }));
  Object.assign(st.relay.offices[0], { version: '1.3.1', relay: { state: 'connected', relay: 'suva1', region: 'Suva head office', rtt_ms: 3, udp: 'ok', host: true, test: { ok: true, rtt_ms: 4, loss: 0, at: ago(1) }, checks: opts.checksSuva || CHECKS.allgood } });
  Object.assign(st.relay.offices[1], { version: '1.3.1', relay: { state: 'connected', relay: 'suva1', region: 'Suva head office', rtt_ms: 48, udp: 'blocked', test: { ok: false, rtt_ms: null, loss: 100, at: ago(3) }, checks: CHECKS.udp } });
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
    if (fn === 'link_relay_manage') {
      const x = st.relay.manage.find((r) => r.id === body.relay_id);
      const left = st.relay.manage.filter((r) => !r.off && r.id !== body.relay_id);
      if ((body.action === 'off' || body.action === 'remove') && !left.length && st.relay.enabled && !body.confirm) return json({ code: 'P0001', message: 'LAST_RELAY: This is your business\'s last relay. Without it your sites can\'t call each other and phones at home stop working, so the relay will be switched off for your business. Add another relay first, or confirm.' }, 400);
      if (body.action === 'main') { st.relay.manage = [x, ...st.relay.manage.filter((r) => r !== x)]; }
      if (body.action === 'off') x.off = true; if (body.action === 'on') x.off = false;
      if (body.action === 'remove') st.relay.manage = st.relay.manage.filter((r) => r !== x);
      st.relay.relays = st.relay.manage.filter((r) => !r.off); if (!st.relay.relays.length) st.relay.enabled = false;
      st.manageCalls = (st.manageCalls || []).concat([body]);
      return json(st.relay);
    }
    if (fn === 'link_relay_enroll_code') return json({ code: 'RLY-7K3M-Q2XZ-WP4D', expires_at: new Date(Date.now() + 1800e3).toISOString(), relay_id: 'r9f8e7d6', replaces: body.replaces || null });
    if (fn === 'link_command') { const id = `cmd${Object.keys(st.cmds).length + 1}`; st.cmds[id] = body; return json(id); }
    if (fn === 'link_command_state') {
      const c = st.cmds[body.command]; const a = c.data.action;
      const result = a === 'test_call' ? { test: { ok: false, rtt_ms: null, loss: 100, tone: false, error: 'No sound came back: UDP to the relay seems blocked by this office\'s firewall or router.' } }
        : a === 'run_check' ? { step: { k: c.data.step, s: 'fail', t: 'UDP blocked: calls to other sites connect, but there may be no sound.' } }
          : a === 'details' ? { relay: { state: 'connected', relay: 'suva1', rtt: 48, udp: 'blocked', relays: [{ id: 'suva1' }, { id: 'mel1' }] } } : { ok: true };
      return json({ id: body.command, kind: 'relay_check', status: 'done', result, ready: false });
    }
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
  fs.mkdirSync(out, { recursive: true });
  try {
    const pg = await b.newPage({ viewport: { width: 1280, height: 900 } }); pg.on('pageerror', (e) => errs.push(e.message));
    const st = await fakeServer(pg, { checksSuva: CHECKS.ports });
    await signIn(pg, BASE + '/link/?phones'); await unlock(pg); await pg.waitForSelector('#lorelay', { state: 'attached' });
    await pg.click('.lo-nav [data-lotab="relay"]'); await pg.waitForSelector('#lorlyman', { state: 'visible' });
    // your relays: the main one (this business's own PC) and Riyeser's backup, each with last seen and what can be done
    const cards = await pg.evaluate(() => [...document.querySelectorAll('.lo-rlycard')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    console.log('relays:', cards);
    assert.match(cards[0], /^Suva head office ?Main ?Your PC Online now · suva1 · version 1\.1\.0/); assert.match(cards[0], /Move to another PC/); assert.match(cards[0], /Remove/);
    assert.match(cards[1], /^Sydney \(Riyeser\) Backup 1 Riyeser's/); assert.doesNotMatch(cards[1], /Remove/, 'Riyeser\'s relay can\'t be removed from here');
    // each site's checklist, from its reports: the relay PC with a closed port, a site with UDP blocked
    const sites = await pg.evaluate(() => [...document.querySelectorAll('.lo-chksite summary')].map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    console.log('site checklists:', sites);
    assert.match(sites[0], /SUVA-PC The relay PC 2 things need attention: Router ports open from the internet/);
    assert.match(sites[1], /NADI-PC 2 things need attention: Sound can get through/);
    await pg.click('.lo-chksite[data-office="lo-suva"] summary');
    assert.match(await text(pg, '.lo-chksite[data-office="lo-suva"] .lo-rchk'), /✗ ?Router ports open from the internet ?Closed from the internet: 3478\/UDP/);
    await pg.screenshot({ path: `${out}/website-sites-relay-port-closed.png`, fullPage: true });
    // Advanced checks, run remotely on Nadi's Link Office: the test call; the result comes back as a card
    await pg.click('.lo-chksite[data-office="lo-suva"] summary');
    await pg.click('.lo-chksite[data-office="lo-nadi"] summary');
    await pg.click('.lo-chksite[data-office="lo-nadi"] [data-chk="test_call"]');
    await pg.waitForSelector('#advout-lo-nadi .lo-advcard.c-bad', { timeout: 10000 });
    assert.match(await text(pg, '#advout-lo-nadi'), /Test call: didn't work ?No sound came back: UDP to the relay seems blocked/);
    assert.deepStrictEqual(st.cmds.cmd1, { ws: 'w1', office_id: 'lo-nadi', kind: 'relay_check', data: { action: 'test_call' } });
    await pg.selectOption('.lo-chksite[data-office="lo-nadi"] [data-chkstep]', 'sound');
    await pg.click('.lo-chksite[data-office="lo-nadi"] [data-chk="run_check"]');
    await pg.waitForFunction(() => /Sound can get through: needs attention/.test(document.querySelector('#advout-lo-nadi').innerText), null, { timeout: 10000 });
    assert.deepStrictEqual(st.cmds.cmd2.data, { action: 'run_check', step: 'sound' });
    await pg.click('.lo-chksite[data-office="lo-nadi"] [data-chk="details"]');
    await pg.waitForSelector('#advout-lo-nadi .lo-raw', { timeout: 10000 });
    await pg.screenshot({ path: `${out}/website-advanced-checks.png`, fullPage: true });
    // make Riyeser's relay the main one, then stop using it
    await pg.click('[data-rlyact="main"][data-rid="mel1"]'); await pg.click('#askyes');
    await pg.waitForFunction(() => /Sydney \(Riyeser\)\s*Main/.test(document.querySelector('.lo-rlycard').innerText));
    assert.deepStrictEqual(st.manageCalls.at(-1), { ws: 'w1', relay_id: 'mel1', action: 'main', confirm: false });
    await pg.click('[data-rlyact="off"][data-rid="mel1"]'); await pg.click('#askyes');
    await pg.waitForFunction(() => /Off for your business/.test(document.querySelector('#lorlyman').innerText));
    // move the relay PC to another PC: a one-time set-up code, with the steps
    await pg.click('[data-rlymove="suva1"]'); await pg.waitForSelector('#rcregion');
    assert.equal(await pg.inputValue('#rcrep'), 'suva1');
    await pg.fill('#rcregion', 'Suva head office (new PC)'); await pg.click('#rcgo'); await pg.waitForSelector('#rccode');
    assert.equal(await text(pg, '#rccode'), 'RLY-7K3M-Q2XZ-WP4D');
    assert.deepStrictEqual(st.bodies.link_relay_enroll_code, { ws: 'w1', region: 'Suva head office (new PC)', replaces: 'suva1', host: null });
    assert.match(await text(pg, '.lo-steps'), /takes over from suva1 by itself, the old PC is removed/);
    await pg.screenshot({ path: `${out}/website-move-relay-code.png` });
    await pg.click('#cl');
    // remove the last relay: a clear warning first, then it's removed and the relay is switched off for the business
    await pg.waitForSelector('[data-rlyact="remove"][data-rid="suva1"]');
    await pg.click('[data-rlyact="remove"][data-rid="suva1"]'); await pg.click('#askyes');
    await pg.waitForFunction(() => /last relay/i.test(document.body.innerText) && document.querySelector('#askyes'));
    const warn = await pg.evaluate(() => document.querySelector('.modal, dialog[open]') ? document.querySelector('.modal, dialog[open]').innerText.replace(/\s+/g, ' ') : '');
    console.log('last relay warning:', warn.slice(0, 220)); assert.match(warn, /This is your business's last relay[\s\S]*switched off for your business/);
    await pg.screenshot({ path: `${out}/website-remove-last-relay-warning.png` });
    await pg.click('#askyes');
    await pg.waitForFunction(() => !document.querySelector('[data-rid="suva1"]'));
    assert.deepStrictEqual(st.manageCalls.slice(-2).map((x) => x.confirm), [false, true]);
    assert.equal(st.relay.enabled, false);
    // phone width: one column, big buttons, nothing sideways
    const ph = await b.newPage({ viewport: { width: 390, height: 844 } }); ph.on('pageerror', (e) => errs.push('phone: ' + e.message));
    await fakeServer(ph, { checksSuva: CHECKS.allgood }); await signIn(ph, BASE + '/link/?phones'); await unlock(ph);
    await ph.waitForSelector('#lorelay', { state: 'attached' }); await ph.click('.lo-nav [data-lotab="relay"]');
    await ph.click('.lo-chksite[data-office="lo-nadi"] summary');
    await ph.click('.lo-chksite[data-office="lo-nadi"] [data-chk="test_call"]'); await ph.waitForSelector('#advout-lo-nadi .lo-advcard.c-bad', { timeout: 10000 });
    assert.ok(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'fits a phone');
    const btnH = await ph.evaluate(() => document.querySelector('.lo-chksite[data-office="lo-nadi"] [data-chk="test_call"]').getBoundingClientRect().height);
    assert.ok(btnH >= 44, `big buttons on a phone (${btnH}px)`);
    const cols = await ph.evaluate(() => new Set([...document.querySelectorAll('.lo-rlycard')].map((x) => Math.round(x.getBoundingClientRect().left))).size);
    assert.equal(cols, 1, 'one column of relays');
    await ph.screenshot({ path: `${out}/website-phone-checks.png`, fullPage: true });
    if (errs.length) throw new Error(`page errors: ${errs.join(' | ')}`);
    console.log('relay-remove-ui-test: all passed');
  } catch (e) { failed = true; console.error('FAILED:', e.stack || e.message); } finally { await b.close(); }
  process.exit(failed ? 1 : 0);
})();
