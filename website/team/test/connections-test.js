// Management › Connections (online connections: API keys, post box, request log, webhooks, Add to your website) against a
// pretend Supabase that answers the api_* functions of team-chat.sql like the real ones:
//  1. ?connections asks for Management's fresh code first (a wrong code is refused; no api_* call before it), then the
//     Overview (counts, what's published, the turned-off webhook notice). Back to Management shows the Connections tile.
//  2. + New key, Website booking widget: needs a website; the key is shown ONCE (copy, the warning), then only its prefix;
//     never in the page, browser storage or the change history afterwards (a secret "Online shop orders" key too; the
//     presets send the right permissions; widget keys can't tick orders).
//  3. Rename, Websites and addresses, Revoke (the in-page question; it moves to Revoked keys).
//  4. Post box: filters, Try again on a failed one. 5. Request log: per key, refused only, Show older.
//  6. Webhooks: https only, events, the secret shown once, Send test, Deliveries, Turn back on.
//  7. Add to your website: the new widget key in the snippet, the order button's SKU, a live preview (the widget in a
//     shadow DOM, sample data, nothing sent).
//  8. Plan messages (Bookings / POS or Accounting / no program), and a refusal from the database shown as it is.
//  9. An older database (PGRST202): "Connections aren't set up yet", nothing breaks.
// 10. Staff never see Connections (no tile, ?connections does nothing, no api_* call); an owner without two-step
//     sign-in is sent to set it up. 11. Phone width (390): no sideways scrolling on any tab.
// Run: build the site (node website/build-combined.mjs), serve website/public on 8090 (or LINK_BASE), then
// `node website/team/test/connections-test.js <shots>`. Exits 1 on any failure.
const { chromium } = require('playwright');
const assert = require('assert');
const crypto = require('crypto');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const ADMIN_ONLY = 'Only the business\'s owner or an admin, signed in with two-step sign-in, can manage online connections.';

function people(opts) {
  const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: opts.member ? 'staff@sample.test' : 'owner@sample.test', factors: opts.noMfa ? [] : [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
  const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: opts.noMfa ? 'aal1' : 'aal2', amr: [{ method: opts.noMfa ? 'password' : 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
  return { user, token };
}
async function fakeServer(page, opts = {}) {
  const { user, token } = people(opts);
  const role = opts.member ? 'member' : 'owner';
  const key = (id, name, kind, mode, scopes, origins, extra = {}) => ({ id, name, kind, mode, scopes, prefix: `rk_${kind === 'widget' ? 'pub_' : ''}${mode}_${id.slice(-8).padStart(8, '0')}…`, allowed_origins: origins, allowed_ips: [],
    created_at: ago(9000), created_by_name: 'Alex Sample', last_used_at: ago(3), revoked_at: null, status: 'active', requests_24h: 12, ...extra });
  const st = { calls: [], args: {}, raws: [], audit: [], unlocked: false,
    keys: [key('k0000001', 'Website booking form', 'widget', 'live', ['availability:read', 'bookings:write', 'enquiries:write'], ['https://www.sample.test'])],
    hooks: [{ id: 'h1', url: 'https://crm.sample.test/hooks', events: ['booking.received'], mode: 'live', description: 'Our CRM', active: true, disabled_reason: null, secret_hint: 'whsec_…ab12', created_at: ago(9000), last_success_at: ago(5), last_failure_at: null, failing_since: null, pending: 0 },
      { id: 'h2', url: 'https://old.sample.test/hook', events: ['order.received'], mode: 'live', description: '', active: false, disabled_reason: 'Turned off on 20 Nov after failing for 3 days (last answer: 500).', secret_hint: 'whsec_…cd34', created_at: ago(20000), last_success_at: null, last_failure_at: ago(3000), failing_since: ago(8000), pending: 0 }],
    inbox: [{ id: 'e1', kind: 'booking', test: false, status: 'waiting', source: 'widget', key_name: 'Website booking form', attempts: 0, error: null, result: {}, customer_name: 'Mele Tui', taken_by_pc: null, created_at: ago(2), updated_at: ago(2) },
      { id: 'e2', kind: 'order', test: true, status: 'done', source: 'api', key_name: 'Online shop', attempts: 1, error: null, result: { reference: 'S-2041', state: 'accepted', message: 'Ready after 3 pm.' }, customer_name: 'Litia <b>Naca</b>', taken_by_pc: 'FRONT-PC', created_at: ago(60), updated_at: ago(58) },
      { id: 'e3', kind: 'booking', test: false, status: 'failed', source: 'widget', key_name: 'Website booking form', attempts: 5, error: 'Bookings was closed on every PC.', result: {}, customer_name: 'Sam Lee', taken_by_pc: null, created_at: ago(600), updated_at: ago(500) }],
    reqs: Array.from({ length: 130 }, (_, i) => ({ id: 1000 - i, key_id: i % 3 ? 'k0000001' : 'k0000002', key_name: i % 3 ? 'Website booking form' : 'Online shop', method: i % 2 ? 'GET' : 'POST', path: i % 2 ? '/v1/availability/slots' : '/v1/bookings', status: i % 7 ? 200 : 429, ms: 30 + i, ip: '203.0.113.0', code: i % 7 ? null : 'rate_limited', at: ago(i * 3) })),
    deliveries: [] };
  const allowed = opts.allowed || { any: true, bookings: true, orders: true };
  await page.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
  await page.route('https://fake.supabase.test/**', async (r) => {
    const u = new URL(r.request().url()); const m = r.request().method(); const fn = u.pathname.replace('/rest/v1/rpc/', '');
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    const fail = (message, code = 'P0001', status = 400) => json({ code, message, details: null, hint: null }, status);
    if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const a = JSON.parse(r.request().postData() || '{}');
    if (u.pathname === '/auth/v1/token') return json({ access_token: token(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
    if (u.pathname === '/auth/v1/user') return json(user);
    if (u.pathname === '/auth/v1/factors' && m === 'POST') return json({ id: 'f2', type: 'totp', friendly_name: 'x', totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg"/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } });
    if (u.pathname === '/auth/v1/factors/f1/challenge') return json({ id: 'ch1', expires_at: Math.floor(Date.now() / 1000) + 300 });
    if (u.pathname === '/auth/v1/factors/f1/verify') { if (a.code !== '246810') return json({ code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }, 422);
      st.unlocked = true; return json({ access_token: token(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r2', user }); }
    if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role, job_role: role, display_name: 'Alex Sample', workspaces: { id: 'w1', name: 'Sample Salon', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business', country: 'Fiji' } }]);
    if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex Sample', role, job_role: role, extension: 101 }]);
    if (u.pathname === '/rest/v1/channels') return json([{ id: 'c1', kind: 'channel', name: 'general', topic: null }]);
    if (u.pathname === '/rest/v1/audit_log') return json(st.audit);
    if (fn === 'company_licence') return json({ modules: { bookings: { status: 'trial', active: true, days_left: 60 } }, seats: { included: 3, extra: 0, used: 1 } });
    if (fn === 'team_features') return json({ calls: true });
    if (!fn.startsWith('api_')) return json([]);
    // ---- the api_* functions
    st.calls.push(fn); st.args[fn] = a;
    if (opts.oldDatabase) return json({ code: 'PGRST202', message: `Could not find the function public.${fn}(ws) in the schema cache`, details: null, hint: null }, 404);
    if (opts.member || opts.refuse) return fail(ADMIN_ONLY);
    if (a.ws !== 'w1') return fail('wrong business');
    const find = (id) => st.keys.find((k) => k.id === id);
    const hook = (id) => st.hooks.find((h) => h.id === id);
    switch (fn) {
      case 'api_overview': { const n = (s) => st.inbox.filter((x) => x.status === s).length;
        return json({ keys: { active: st.keys.filter((k) => k.status === 'active').length, revoked: st.keys.filter((k) => k.status !== 'active').length }, inbox: { waiting: n('waiting'), taken: n('taken'), failed: n('failed'), rejected_7d: n('rejected'), done_7d: n('done') },
          published: { catalog_items: 12, stock_items: 0, open_times: 40, staff: 2, catalog_at: ago(30), stock_at: null, availability_at: ago(8) }, webhooks: { active: st.hooks.filter((h) => h.active).length, failing: 1 }, requests_24h: 130, errors_24h: 19, allowed }); }
      case 'api_keys_list': return json(st.keys);
      case 'api_key_create': {
        if (a.key_kind === 'widget' && a.key_scopes.some((s) => !['availability:read', 'bookings:write', 'enquiries:write'].includes(s))) return fail('A widget key is seen by everyone visiting the website, so it can only read open times and send bookings and enquiries.');
        if (a.key_kind === 'widget' && !a.origins.length) return fail('Add the website address the widget is on (like https://www.example.com).');
        if (a.origins.some((o) => /\/\w/.test(o.replace(/^https?:\/\//, '')))) return fail(`"${a.origins[0]}" isn't a website address. Use one like https://shop.example.com (no path).`);
        const raw = `rk_${a.key_kind === 'widget' ? 'pub_' : ''}${a.key_mode}_${crypto.randomBytes(24).toString('hex')}`; st.raws.push(raw);
        const k = key('k' + crypto.randomBytes(4).toString('hex'), a.key_name, a.key_kind, a.key_mode, [...a.key_scopes].sort(), a.origins, { allowed_ips: a.ips, prefix: raw.slice(0, raw.length - 40) + '…', last_used_at: null, requests_24h: 0, created_at: new Date().toISOString() });
        st.keys.push(k); st.audit.unshift({ id: st.audit.length + 1, at: new Date().toISOString(), actor: user.id, action: 'api_key.create', details: { id: k.id, name: k.name, prefix: k.prefix.replace('…', '') } });
        return json({ ...k, key: raw }); }
      case 'api_key_rename': return json(Object.assign(find(a.key_id), { name: a.key_name }));
      case 'api_key_set_access': return json(Object.assign(find(a.key_id), { allowed_origins: a.origins, allowed_ips: a.ips }));
      case 'api_key_revoke': return json(Object.assign(find(a.key_id), { status: 'revoked', revoked_at: new Date().toISOString() }));
      case 'api_inbox_recent': return json(st.inbox.filter((x) => !a.status || x.status === a.status));
      case 'api_inbox_retry': { const e = st.inbox.find((x) => x.id === a.event_id); if (!['failed', 'rejected'].includes(e.status)) return fail('Only a failed or rejected one can be tried again.'); Object.assign(e, { status: 'waiting', attempts: 0 }); return json({ id: e.id, status: 'waiting' }); }
      case 'api_requests_list': return json(st.reqs.filter((x) => (!a.key_id || x.key_id === a.key_id) && (!a.before_id || x.id < a.before_id)).slice(0, a.max_rows));
      case 'api_webhooks_list': return json(st.hooks);
      case 'api_webhook_create': { if (!/^https:\/\//.test(a.url)) return fail('Use a public https address.');
        const h = { id: 'h' + (st.hooks.length + 1), url: a.url, events: a.events, mode: a.hook_mode, description: a.description, active: true, disabled_reason: null, secret_hint: 'whsec_…9f9f', created_at: new Date().toISOString(), last_success_at: null, last_failure_at: null, failing_since: null, pending: 0 };
        st.hooks.push(h); st.secret = 'whsec_' + crypto.randomBytes(24).toString('hex'); return json({ ...h, secret: st.secret }); }
      case 'api_webhook_update': { const h = hook(a.hook_id); if (a.url) h.url = a.url; if (a.events) h.events = a.events; if (a.active !== null) { h.active = a.active; if (a.active) { h.disabled_reason = null; h.failing_since = null; } } return json(h); }
      case 'api_webhook_ping': st.deliveries.unshift({ id: 'd1', event: 'ping', event_id: 'x', status: 'delivered', attempts: 1, next_at: null, last_status: 200, last_error: null, created_at: new Date().toISOString(), delivered_at: new Date().toISOString() }); return json({ queued: 1, event_id: 'x' });
      case 'api_webhook_deliveries_list': return json(st.deliveries);
      case 'api_webhook_rotate': return json({ ...hook(a.hook_id), secret: 'whsec_' + crypto.randomBytes(24).toString('hex') });
      case 'api_webhook_delete': st.hooks = st.hooks.filter((h) => h.id !== a.hook_id); return json(null);
      default: return fail('unknown ' + fn);
    }
  });
  return st;
}
const signIn = async (pg, url) => { await pg.goto(url); await pg.waitForSelector('#gf'); await pg.fill('input[name=email]', 'owner@sample.test'); await pg.fill('input[name=password]', 'a-good-password'); await pg.click('button[type=submit]'); };
const text = (pg, sel) => pg.textContent(sel).then((t) => t.replace(/\s+/g, ' ').trim());
const noSideways = (pg) => pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.'; let failed = false;
  const newPage = async (opts, vp = { width: 1280, height: 900 }) => { const pg = await b.newPage({ viewport: vp }); pg.on('pageerror', (e) => errs.push(e.message));
    await pg.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {}); const st = await fakeServer(pg, opts); return [pg, st]; };
  try {
    // 1. the fresh code first, then the Overview
    const [pg, st] = await newPage({});
    await signIn(pg, BASE + '/link/?connections'); await pg.waitForSelector('#mgucode');
    assert.deepStrictEqual(st.calls, [], 'nothing about connections is asked before the code');
    await pg.fill('#mgucode', '111111'); await pg.click('#mgugo'); await pg.waitForSelector('#mguerr:not([hidden])');
    console.log('wrong code:', await text(pg, '#mguerr')); assert.match(await text(pg, '#mguerr'), /code isn't right/);
    assert.deepStrictEqual(st.calls, [], 'still nothing after a wrong code');
    await pg.fill('#mgucode', '246810'); await pg.click('#mgugo'); await pg.waitForSelector('#connPage .cn-stats');
    assert.ok(st.unlocked, 'a fresh two-step code was checked');
    const stats = await pg.$$eval('.cn-stat', (x) => x.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    console.log('overview:', stats);
    assert.deepStrictEqual(stats.map((s) => s.split(' ')[0]), ['1', '1', '1', '130', '1']);
    assert.match(await text(pg, '#cnhookoff'), /webhook was turned off after failing for 3 days: https:\/\/old\.sample\.test\/hook/);
    assert.match(await text(pg, '.cn-pub'), /Stock levels Not published yet/);
    assert.strictEqual(await pg.$('.cn-plan'), null, 'no plan message when everything is allowed');
    await pg.screenshot({ path: out + '/conn-overview.png', fullPage: true });

    // 2. + New key: a widget key, shown once
    await pg.click('#cnt-keys'); await pg.waitForSelector('#cnnewkey');
    await pg.click('#cnnewkey'); await pg.waitForSelector('#cnkf');
    const ticks = await pg.$$eval('#cnkf input[name=scope]', (x) => x.filter((i) => i.checked).map((i) => i.value));
    assert.deepStrictEqual(ticks, ['bookings:write', 'enquiries:write', 'availability:read'], 'the widget preset ticks what a widget may do');
    assert.ok(await pg.$eval('#cnkf input[value="orders:write"]', (i) => i.disabled), 'a widget key can\'t send orders');
    assert.ok(await pg.$eval('#cniprow', (x) => x.hidden), 'no internet address list for a widget key');
    await pg.fill('#cnkf input[name=name]', 'Booking form'); await pg.click('#cnkgo');
    assert.match(await text(pg, '#cnkerr'), /Add the website the widget is on/); assert.ok(!st.calls.includes('api_key_create'));
    await pg.fill('#cnkf textarea[name=origins]', 'https://www.sample.test/booking'); await pg.click('#cnkgo');
    await pg.waitForFunction(() => !document.querySelector('#cnkerr').hidden);
    console.log('the database\'s refusal:', await text(pg, '#cnkerr')); assert.match(await text(pg, '#cnkerr'), /isn't a website address/);
    await pg.fill('#cnkf textarea[name=origins]', 'https://www.sample.test\nhttps://*.sample.test'); await pg.click('#cnkgo');
    await pg.waitForSelector('#cnnewkey[readonly]');
    const raw1 = st.raws[0];
    assert.strictEqual(await pg.inputValue('input#cnnewkey'), raw1, 'the whole key, once');
    assert.deepStrictEqual(st.args.api_key_create, { ws: 'w1', key_name: 'Booking form', key_kind: 'widget', key_mode: 'live', key_scopes: ['bookings:write', 'enquiries:write', 'availability:read'], origins: ['https://www.sample.test', 'https://*.sample.test'], ips: [] });
    assert.match(await text(pg, '.mcard .lo-warn'), /You won't see this key again/);
    await pg.click('#cnkcopy'); await pg.waitForFunction(() => document.querySelector('#cnkcopy').textContent === 'Copied');
    assert.strictEqual(await pg.evaluate(() => navigator.clipboard.readText()), raw1, 'Copy puts the key on the clipboard');
    await pg.mouse.click(5, 5); assert.ok(await pg.$('input#cnnewkey'), 'a stray click outside doesn\'t close it');
    await pg.screenshot({ path: out + '/conn-key-once.png' });
    await pg.click('#cnkdone'); await pg.waitForFunction(() => !document.querySelector('.modal'));
    await pg.waitForFunction(() => document.querySelectorAll('table.cn-keys tbody tr').length === 2);
    assert.match(await text(pg, 'table.cn-keys'), new RegExp(raw1.slice(0, raw1.length - 40) + '…'));
    // a secret key for the online shop
    await pg.click('#cnnewkey'); await pg.waitForSelector('#cnkf'); await pg.check('#cnkf input[value=shop]');
    assert.deepStrictEqual(await pg.$$eval('#cnkf input[name=scope]', (x) => x.filter((i) => i.checked).map((i) => i.value)), ['orders:write', 'customers:write', 'catalog:read', 'prices:read', 'stock:read']);
    await pg.check('#cnkf input[name=mode][value=test]'); await pg.fill('#cnkf input[name=name]', 'Online shop'); await pg.fill('#cnkf textarea[name=ips]', '203.0.113.7, 198.51.100.0/24');
    await pg.click('#cnkgo'); await pg.waitForSelector('input#cnnewkey');
    const raw2 = st.raws[1]; assert.ok(raw2.startsWith('rk_test_'));
    assert.deepStrictEqual(st.args.api_key_create.ips, ['203.0.113.7', '198.51.100.0/24']); assert.strictEqual(st.args.api_key_create.key_kind, 'secret');
    assert.match(await text(pg, '.mcard .lo-warn'), /never in a web page/);
    await pg.click('#cnkdone'); await pg.waitForFunction(() => document.querySelectorAll('table.cn-keys tbody tr').length === 3);
    const leak = await pg.evaluate((k) => ({ dom: document.documentElement.outerHTML.includes(k), ls: JSON.stringify(localStorage).includes(k), ss: JSON.stringify(sessionStorage).includes(k) }), raw2);
    assert.deepStrictEqual(leak, { dom: false, ls: false, ss: false }, 'the secret key is gone once closed');
    assert.ok(!JSON.stringify(st.audit).includes(raw2) && !JSON.stringify(st.audit).includes(raw1), 'never in the change history');
    await pg.screenshot({ path: out + '/conn-keys.png', fullPage: true });

    // 3. rename, websites, revoke
    const shopId = st.keys[2].id;
    await pg.click(`[data-kmore="${shopId}"]`); await pg.click('[data-m=rename]'); await pg.fill('#cnkef input[name=name]', 'Shop server'); await pg.click('#cnkef .btn.p');
    await pg.waitForFunction(() => /Shop server/.test(document.querySelector('table.cn-keys').innerText));
    await pg.click(`[data-kmore="${shopId}"]`); await pg.click('[data-m=access]'); await pg.fill('#cnkef textarea[name=ips]', '203.0.113.9'); await pg.click('#cnkef .btn.p');
    await pg.waitForFunction(() => /Addresses: 203\.0\.113\.9/.test(document.querySelector('table.cn-keys').innerText));
    assert.deepStrictEqual(st.args.api_key_set_access, { ws: 'w1', key_id: shopId, origins: [], ips: ['203.0.113.9'] });
    await pg.click(`[data-kmore="${shopId}"]`); await pg.click('[data-m=revoke]'); await pg.waitForSelector('#askyes');
    console.log('revoke question:', await text(pg, '.askp')); assert.match(await text(pg, '.askp'), /stops working straight away\. This can't be undone/);
    await pg.click('#askno'); assert.ok(!st.calls.includes('api_key_revoke'), 'Cancel revokes nothing');
    await pg.click(`[data-kmore="${shopId}"]`); await pg.click('[data-m=revoke]'); await pg.click('#askyes');
    await pg.waitForSelector('details.cn-rev'); assert.deepStrictEqual(st.args.api_key_revoke, { ws: 'w1', key_id: shopId });
    assert.match(await text(pg, 'details.cn-rev summary'), /Revoked keys \(1\)/); console.log('rename, access, revoke: ok');

    // 4. post box
    await pg.click('#cnt-inbox'); await pg.waitForSelector('table.cn-box');
    assert.strictEqual(await pg.$$eval('table.cn-box tbody tr', (x) => x.length), 3);
    assert.ok(await pg.$eval('[data-ev=e2]', (r) => r.innerText.includes('Litia <b>Naca</b>') && r.innerText.includes('Test') && r.innerText.includes('S-2041')), 'customer names are shown as text, tests marked');
    await pg.click('[data-box=failed]'); await pg.waitForFunction(() => document.querySelectorAll('table.cn-box tbody tr').length === 1);
    assert.strictEqual(st.args.api_inbox_recent.status, 'failed');
    await pg.screenshot({ path: out + '/conn-postbox.png', fullPage: true });
    await pg.click('[data-retry=e3]'); await pg.waitForSelector('#cnboxempty');
    assert.deepStrictEqual(st.args.api_inbox_retry, { ws: 'w1', event_id: 'e3' }); console.log('post box retry: ok');

    // 5. request log
    await pg.click('#cnt-log'); await pg.waitForSelector('table.cn-log');
    assert.strictEqual(await pg.$$eval('table.cn-log tbody tr', (x) => x.length), 100); await pg.click('#cnolder');
    await pg.waitForFunction(() => document.querySelectorAll('table.cn-log tbody tr').length === 130); assert.strictEqual(st.args.api_requests_list.before_id, 901);
    await pg.selectOption('#cnrqkey', 'k0000001'); await pg.waitForFunction(() => document.querySelectorAll('table.cn-log tbody tr').length && ![...document.querySelectorAll('table.cn-log tbody tr')].some((r) => /Online shop/.test(r.innerText)));
    assert.strictEqual(st.args.api_requests_list.key_id, 'k0000001');
    await pg.selectOption('#cnrqst', 'err'); assert.ok(await pg.$$eval('table.cn-log tbody tr', (x) => x.every((r) => /429/.test(r.innerText))), 'refused only');
    await pg.screenshot({ path: out + '/conn-log.png', fullPage: true }); console.log('request log: ok');

    // 6. webhooks
    await pg.click('#cnt-hooks'); await pg.waitForSelector('#cnaddhook');
    assert.match(await text(pg, '[data-hook=h2] .cn-offnote'), /Turned off on 20 Nov after failing for 3 days/);
    await pg.click('#cnaddhook'); await pg.fill('#cnhf input[name=url]', 'http://crm.sample.test/x'); await pg.click('#cnhf .btn.p');
    assert.match(await text(pg, '#cnherr'), /starts with https/);
    await pg.fill('#cnhf input[name=url]', 'https://localhost/x'); await pg.click('#cnhf .btn.p'); assert.match(await text(pg, '#cnherr'), /public address/);
    await pg.fill('#cnhf input[name=url]', 'https://hooks.sample.test/riyeser'); await pg.check('#cnhf input[value="stock.changed"]'); await pg.click('#cnhf .btn.p');
    await pg.waitForSelector('#cnsecret'); assert.strictEqual(await pg.inputValue('#cnsecret'), st.secret);
    assert.deepStrictEqual(st.args.api_webhook_create.events, ['booking.received', 'order.received', 'enquiry.received', 'stock.changed']);
    await pg.click('#cnsdone'); await pg.waitForSelector('[data-hook=h3]');
    assert.ok(!(await pg.content()).includes(st.secret), 'the secret is gone once closed');
    await pg.click('[data-whping=h3]'); await pg.waitForFunction(() => /Test event on its way/.test((document.getElementById('phmsg') || {}).textContent || ''));
    await pg.click('[data-whlog=h3]'); await pg.waitForSelector('table.cn-del'); assert.match(await pg.innerText('table.cn-del tbody'), /ping\s+Delivered\s+200/); await pg.click('.mcard #cl');
    await pg.click('[data-whon=h2]'); await pg.waitForFunction(() => !document.querySelector('[data-hook=h2] .cn-offnote'));
    assert.deepStrictEqual(st.args.api_webhook_update, { ws: 'w1', hook_id: 'h2', url: null, events: null, active: true });
    await pg.screenshot({ path: out + '/conn-webhooks.png', fullPage: true }); console.log('webhooks: ok');

    // 7. add to your website: the widget key made in 2 is in the snippet; a live preview
    await pg.click('#cnt-site'); await pg.waitForSelector('#cnsnip');
    assert.match(await pg.inputValue('#cnsnip'), new RegExp(`^<script src="https://riyeser.com/widget/book.js" data-key="${raw1}" async></script>$`));
    await pg.waitForFunction(() => { const h = document.querySelector('#cnprev .riyeser-widget'); return h && h.shadowRoot && h.shadowRoot.querySelectorAll('[data-svc]').length === 3; }, null, { timeout: 8000 });
    await pg.check('input[name=cnwtype][value=order]'); await pg.waitForSelector('#cnwsku');
    await pg.fill('#cnwsku', 'CAKE-CHOC'); await pg.fill('#cnwname', 'Chocolate cake'); await pg.fill('#cnwprice', '45');
    assert.match(await pg.inputValue('#cnsnip'), /data-type="order" data-sku="CAKE-CHOC" data-name="Chocolate cake" data-price="45" data-currency="USD"/);
    await pg.waitForFunction(() => { const h = document.querySelector('#cnprev .riyeser-widget'); return h && h.dataset.type === 'order' && /Order/.test(h.shadowRoot.textContent); }, null, { timeout: 8000 });
    await pg.screenshot({ path: out + '/conn-website.png', fullPage: true }); console.log('add to your website: ok');

    // back, then Management (still unlocked): the Connections tile
    await pg.click('#cnback'); await pg.waitForSelector('.hco');   // it was opened from the Riyeser home
    await pg.evaluate(() => window.RiyeserTeam.setNav('manage')); await pg.waitForSelector('#coconn'); assert.match(await text(pg, '#coconn'), /Connections/);
    await pg.click('#coconn'); await pg.waitForSelector('#connPage'); console.log('Management tile: ok');

    // 11. phone width: no sideways scrolling on any tab
    const [pp] = await newPage({}, { width: 390, height: 844 });
    await signIn(pp, BASE + '/link/?connections'); await pp.waitForSelector('#mgucode'); await pp.fill('#mgucode', '246810'); await pp.click('#mgugo'); await pp.waitForSelector('.cn-stats');
    for (const t of ['overview', 'keys', 'inbox', 'log', 'hooks', 'site']) {
      await pp.click('#cnt-' + t); await pp.waitForTimeout(500); await pp.waitForFunction(() => !/Loading…/.test(document.getElementById('cnpanel').innerText));
      assert.ok(await noSideways(pp), `no sideways scrolling at 390 on ${t}`);
      if (t === 'keys' || t === 'site' || t === 'overview') await pp.screenshot({ path: `${out}/conn-phone-${t}.png`, fullPage: true });
    }
    await pp.click('#cnt-keys'); await pp.click('#cnnewkey'); await pp.waitForSelector('#cnkf'); assert.ok(await noSideways(pp), 'New key at 390');
    await pp.screenshot({ path: out + '/conn-phone-newkey.png' }); console.log('phone width: ok');

    // 8. plan messages; a refusal shown as it is
    const [p8] = await newPage({ allowed: { any: true, bookings: false, orders: false } });
    await signIn(p8, BASE + '/link/?connections'); await p8.waitForSelector('#mgucode'); await p8.fill('#mgucode', '246810'); await p8.click('#mgugo'); await p8.waitForSelector('.cn-plan');
    const plans = await p8.$$eval('.cn-plan', (x) => x.map((e) => e.dataset.plan + ': ' + e.innerText.replace(/\s+/g, ' ')));
    console.log('plan:', plans); assert.deepStrictEqual(plans.map((x) => x.split(':')[0]), ['bookings', 'orders']); assert.ok(await p8.$('[data-cnplan]'), 'the owner can open the plan');
    await p8.screenshot({ path: out + '/conn-plan.png' });
    const [p8b] = await newPage({ allowed: { any: false, bookings: false, orders: false } });
    await signIn(p8b, BASE + '/link/?connections'); await p8b.waitForSelector('#mgucode'); await p8b.fill('#mgucode', '246810'); await p8b.click('#mgugo'); await p8b.waitForSelector('.cn-plan');
    assert.deepStrictEqual(await p8b.$$eval('.cn-plan', (x) => x.map((e) => e.dataset.plan)), ['any']);
    const [p8c] = await newPage({ refuse: true });
    await signIn(p8c, BASE + '/link/?connections'); await p8c.waitForSelector('#mgucode'); await p8c.fill('#mgucode', '246810'); await p8c.click('#mgugo'); await p8c.waitForSelector('#connPage .err');
    assert.strictEqual(await text(p8c, '#connPage .err'), ADMIN_ONLY, 'the database\'s aal2 refusal is shown as it is'); console.log('plan messages, refusal: ok');

    // 9. an older database
    const [p9, s9] = await newPage({ oldDatabase: true });
    await signIn(p9, BASE + '/link/?connections'); await p9.waitForSelector('#mgucode'); await p9.fill('#mgucode', '246810'); await p9.click('#mgugo'); await p9.waitForSelector('#cnoff');
    console.log('older database:', await text(p9, '#cnoff h2')); assert.ok(s9.calls.length > 0);
    await p9.screenshot({ path: out + '/conn-not-set-up.png' });

    // 10. staff never see it; an owner without two-step sign-in sets it up first
    const [p10, s10] = await newPage({ member: true });
    await signIn(p10, BASE + '/link/?connections'); await p10.waitForSelector('.hco, #lkshell'); await p10.waitForTimeout(1200);
    assert.ok(!(await p10.$('#connPage')) && !(await p10.$('#mgucode')) && !(await p10.$('#coconn')), 'staff: no Connections, no code box');
    assert.deepStrictEqual(s10.calls, [], 'staff: no api_* call at all');
    assert.ok(!(await p10.evaluate(() => /Connections/.test(document.body.innerText))), 'staff: the word Connections isn\'t on their screen');
    const [p10b, s10b] = await newPage({ noMfa: true });
    await signIn(p10b, BASE + '/link/?connections'); await p10b.waitForSelector('.modal'); await p10b.waitForTimeout(500);
    assert.ok(!(await p10b.$('#connPage')), 'no Connections without two-step sign-in'); assert.deepStrictEqual(s10b.calls, []);
    console.log('without two-step sign-in:', (await text(p10b, '.modal h3'))); assert.match(await text(p10b, '.modal'), /two-step|authenticator/i);
    console.log('staff and no two-step: ok');
  } catch (e) { failed = true; console.error('FAIL', e); }
  if (errs.length) { failed = true; console.error('page errors:', errs); }
  await b.close();
  console.log(failed ? 'CONNECTIONS TESTS FAILED' : 'ALL CONNECTIONS TESTS PASSED');
  process.exit(failed ? 1 : 0);
})();
