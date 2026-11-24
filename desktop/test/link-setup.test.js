// Riyeser Link Office: desk-phone set-up, people from Riyeser Link, the offline copy, the licence and the PC's address.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');
const { Directory, mapTeam, strongPassword } = require('../src/link/directory');
const { Provisioner, route, vendorKey, macInAgent } = require('../src/link/provision');
const { callsLicence, NEEDS_PLUS } = require('../src/link/licence');
const { syncFromTeam } = require('../src/link/sync');
const { PhoneService } = require('../src/link/service');
const { Pbx } = require('../src/link/pbx');
const { SimUA } = require('../src/link/simua');
const { pickAdapter } = require('../src/link/netinfo');
const { tmp, rmTmp, get, until } = require('./link-helpers');

const DAY = 86400000;
const NOW = Date.parse('2026-11-24T10:00:00Z');
const writeLicence = (appData, online) => {
  fs.mkdirSync(path.join(appData, 'Riyeser'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Riyeser', 'licence.json'), JSON.stringify({ trialStart: '2026-11-01T00:00:00Z', ...(online ? { online } : {}) }));
};
const plan = (calls, checkedAt = new Date(NOW).toISOString()) => ({ company_code: 'SAMPLE', checkedAt, modules: calls ? { calls } : { pos: { status: 'trial', active: true } } });

// ---------- desk-phone set-up ----------
test('provisioning: an unassigned phone is refused (and shows as found); an assigned one gets its Yealink, Grandstream and Snom settings', async () => {
  const dir = tmp(); const store = new Store(dir);
  const directory = new Directory(store);
  directory.addPerson({ name: 'Alex Sample', ext: '101' });
  const prov = await new Provisioner({ store, directory, host: '192.168.1.20', sipPort: 5060, httpPort: 0, bind: '127.0.0.1' }).start();
  const url = (p) => `http://127.0.0.1:${prov.httpPort}${p}`;
  try {
    const no = await get(url('/yealink/001565aabbcc.cfg'));
    assert.strictEqual(no.status, 403);
    assert.ok(!/account\./.test(no.body));
    assert.strictEqual(prov.found()[0].mac, '001565aabbcc');
    assert.strictEqual(prov.found()[0].vendor, 'yealink');
    const pw = directory.password('101');

    prov.assign('00:15:65:AA:BB:CC', '101');
    assert.strictEqual(prov.found().length, 0);
    const y = await get(url('/yealink/001565aabbcc.cfg'));
    assert.strictEqual(y.status, 200);
    for (const l of ['account.1.enable = 1', 'account.1.user_name = 101', 'account.1.auth_name = 101', `account.1.password = ${pw}`,
      'account.1.sip_server.1.address = 192.168.1.20', 'account.1.label = Alex Sample', 'account.1.display_name = Alex Sample']) assert.ok(y.body.includes(l), l);
    assert.strictEqual((await get(url('/yealink/y000000000000.cfg'))).status, 200);

    prov.assign('000b82112233', '101');
    const g = await get(url('/grandstream/cfg000b82112233.xml'));
    assert.strictEqual(g.status, 200);
    for (const l of ['<P271>1</P271>', '<P47>192.168.1.20:5060</P47>', '<P35>101</P35>', '<P36>101</P36>', `<P34>${pw}</P34>`, '<P3>Alex Sample</P3>']) assert.ok(g.body.includes(l), l);

    prov.assign('000413445566', '101');
    const s = await get(url('/snom/000413445566.xml'));
    assert.strictEqual(s.status, 200);
    for (const l of ['<user_name idx="1" perm="">101</user_name>', `<user_pass idx="1" perm="">${pw}</user_pass>`, '<user_host idx="1" perm="">192.168.1.20:5060</user_host>',
      '<user_realname idx="1" perm="">Alex Sample</user_realname>']) assert.ok(s.body.includes(l), l);

    // a phone asking for another phone's file (its MAC is in its User-Agent) is refused
    const other = await get(url('/yealink/001565aabbcc.cfg'), { 'User-Agent': 'Yealink SIP-T46U 108.86.0.20 00:15:65:99:99:99' });
    assert.strictEqual(other.status, 403);
    // every fetch is logged, never with the password
    const log = JSON.stringify(store.get('phone-devices').fetches);
    assert.ok(log.includes('001565aabbcc')); assert.ok(!log.includes(pw));
    assert.ok(prov.phones().find((p) => p.mac === '001565aabbcc').lastFetch);
  } finally { await prov.stop(); rmTmp(dir); }
});

test('provisioning refuses addresses outside the office network', () => {
  const dir = tmp(); const store = new Store(dir); const directory = new Directory(store);
  directory.addPerson({ name: 'Alex Sample', ext: '101' });
  const prov = new Provisioner({ store, directory, host: '192.168.1.20' });
  prov.assign('001565aabbcc', '101');
  let code = 0; let body = '';
  prov.handle({ socket: { remoteAddress: '8.8.8.8' }, method: 'GET', url: '/yealink/001565aabbcc.cfg', headers: {} }, { writeHead: (c) => { code = c; }, end: (b) => { body = b; } });
  assert.strictEqual(code, 403); assert.ok(!/password/.test(body));
  rmTmp(dir);
});

test('provisioning helpers: file names, makers and MACs', () => {
  assert.deepStrictEqual(route('/grandstream/cfg000b82112233'), { vendor: 'grandstream', mac: '000b82112233', kind: 'phone' });
  assert.deepStrictEqual(route('/polycom/0004f2112233.cfg'), { vendor: 'polycom', mac: '0004f2112233', kind: 'master' });
  assert.strictEqual(route('/../../etc/passwd'), null);
  assert.strictEqual(vendorKey('', '0004131a2b3c'), 'snom');
  assert.strictEqual(vendorKey('Grandstream', ''), 'grandstream');
  assert.strictEqual(macInAgent('Grandstream Model HW GXP2170 SW 1.0.11.3 DevId 000b82112233'), '000b82112233');
});

// ---------- people ----------
test('Riyeser Link members become extensions and branches become ring groups', () => {
  const m = mapTeam({
    business: 'Sample Trading Co',
    members: [{ user_id: 'u1', display_name: 'Alex Sample', extension: 101 }, { user_id: 'u2', display_name: 'Bo Example', extension: 102 },
      { user_id: 'u3', display_name: 'New Starter', extension: null }, { user_id: 'u4', display_name: 'Far Away', extension: 4001 }],
    branches: [{ id: 'b1', name: 'Head office', extension: 100, branch_members: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' }] }, { id: 'b2', name: 'Lautoka branch', extension: 200, branch_members: [] }],
  });
  assert.strictEqual(m.business, 'Sample Trading Co');
  assert.deepStrictEqual(m.people.map((p) => [p.ext, p.name, p.source]), [['101', 'Alex Sample', 'team'], ['102', 'Bo Example', 'team']]);
  assert.deepStrictEqual(m.groups.map((g) => [g.ext, g.name, g.members]), [['100', 'Head office', ['101', '102']], ['200', 'Lautoka branch', []]]);
  assert.strictEqual(m.skipped.length, 2);
  assert.match(m.skipped[0].why, /No extension yet/);
});

test('sync from Riyeser Link, then keep working from the saved copy with no internet', async () => {
  const appData = tmp('appdata'); const dir = tmp();
  fs.mkdirSync(path.join(appData, 'Riyeser'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Riyeser', 'company.json'), JSON.stringify({ name: 'Sample Trading Co', mode: 'online', workspace_id: 'ws-1' }));
  const calls = [];
  const online = { session: { access_token: 'x' }, async call(p) { calls.push(p); return p.includes('/members') ? [{ user_id: 'u1', display_name: 'Alex Sample', extension: 101 }, { user_id: 'u2', display_name: 'Bo Example', extension: 102 }]
    : [{ id: 'b1', name: 'Head office', extension: 100, branch_members: [{ user_id: 'u1' }, { user_id: 'u2' }] }]; }, refreshLicence: async () => null };
  try {
    const directory = new Directory(new Store(dir));
    directory.addPerson({ name: 'Cam Test', ext: '150' });   // added by hand, kept
    const r = await syncFromTeam({ clients: [online], appData, directory });
    assert.strictEqual(r.status, 'synced');
    assert.ok(calls[0].includes('workspace_id=eq.ws-1'));
    assert.deepStrictEqual(directory.people().map((p) => p.ext), ['101', '102', '150']);
    assert.strictEqual(directory.group('100').members.length, 2);
    assert.strictEqual(directory.business(), 'Sample Trading Co');
    const pw = directory.password('101');

    // offline: the next sync fails, and a fresh start (new objects, same folder) still has everyone and the same passwords
    const offline = { session: { access_token: 'x' }, async call() { throw new Error('Can\'t reach Riyeser Online.'); } };
    const later = new Directory(new Store(dir));
    const r2 = await syncFromTeam({ clients: [offline], appData, directory: later });
    assert.strictEqual(r2.status, 'offline');
    assert.deepStrictEqual(later.people().map((p) => p.ext), ['101', '102', '150']);
    assert.strictEqual(later.password('101'), pw);
    assert.strictEqual(later.group('100').name, 'Head office');
    // not linked to an online company: set up by hand
    fs.rmSync(path.join(appData, 'Riyeser', 'company.json'));
    assert.strictEqual((await syncFromTeam({ clients: [online], appData, directory: later })).status, 'local');
  } finally { rmTmp(appData); rmTmp(dir); }
});

test('people added by hand get the next free extension, never an emergency number, and a strong password', () => {
  const dir = tmp(); const d = new Directory(new Store(dir));
  for (let i = 0; i < 12; i++) d.addPerson({ name: `Person ${i}` });
  const exts = d.people().map((p) => p.ext);
  assert.ok(!exts.includes('111') && !exts.includes('112'));
  assert.throws(() => d.addPerson({ name: 'X', ext: '000' }), /3 digits/);
  assert.throws(() => d.addPerson({ name: 'X', ext: '101' }), /already used/);
  const pw = strongPassword();
  assert.strictEqual(pw.length, 16); assert.match(pw, /^[A-Za-z2-9]+$/);
  assert.notStrictEqual(d.password('101'), d.password('102'));
  rmTmp(dir);
});

// ---------- licence (Link Plus) ----------
test('licence: trial and paid work; none, ended, cancelled and 30 days unchecked do not; the offline grace keeps it going', () => {
  const appData = tmp('appdata');
  try {
    assert.strictEqual(callsLicence(appData, NOW).active, false);
    assert.strictEqual(callsLicence(appData, NOW).message, NEEDS_PLUS);
    writeLicence(appData, plan(null));
    assert.strictEqual(callsLicence(appData, NOW).state, 'none');
    writeLicence(appData, plan({ status: 'trial', active: true, trial_ends: '2026-12-20', days_left: 26 }));
    let s = callsLicence(appData, NOW);
    assert.deepStrictEqual([s.active, s.state, s.daysLeft], [true, 'trial', 27]);
    assert.strictEqual(callsLicence(appData, Date.parse('2026-12-21T09:00:00Z')).active, false, 'the trial ends on its date even offline');
    writeLicence(appData, plan({ status: 'active', active: true, paid_until: '2027-11-30' }));
    s = callsLicence(appData, NOW);
    assert.deepStrictEqual([s.active, s.state], [true, 'paid']);
    assert.match(s.text, /paid until 30 Nov 2027/);
    assert.strictEqual(callsLicence(appData, NOW + 29 * DAY).active, true, 'within the 30-day offline grace');
    assert.strictEqual(callsLicence(appData, NOW + 31 * DAY).state, 'stale');
    writeLicence(appData, plan({ status: 'ended', active: false }));
    assert.strictEqual(callsLicence(appData, NOW).state, 'ended');
    writeLicence(appData, plan({ status: 'cancelled', active: false }));
    assert.strictEqual(callsLicence(appData, NOW).text, 'Cancelled');
  } finally { rmTmp(appData); }
});

const serviceEnv = async (licenceFn, extra = {}) => {
  const dir = tmp(); const appData = tmp('appdata');
  const store = new Store(dir);
  const svc = new PhoneService({ store, appData, host: '127.0.0.1', sipPort: 0, httpPort: 0, bind: '127.0.0.1', tcp: false, multicast: false, licence: licenceFn, ...extra });
  return { dir, appData, store, svc, close: async () => { await svc.stop(); rmTmp(dir); rmTmp(appData); } };
};

test('without Link Plus the phone system does not start, and says why', async () => {
  const env = await serviceEnv((a) => callsLicence(a));
  try {
    env.svc.addPerson({ name: 'Alex Sample', ext: '101' });
    env.svc.assign('001565aabbcc', '101');
    await env.svc.start();
    assert.strictEqual(env.svc.pbx, null);
    const st = env.svc.status();
    assert.strictEqual(st.state, 'waiting-licence');
    assert.strictEqual(st.licence.message, 'Riyeser Link Office comes with Riyeser Link Plus. Start your free trial or add Link Plus from your Riyeser home page.');
    assert.strictEqual(st.phones[0].state, 'waiting for Link Plus');
    assert.strictEqual(st.people[0].state, 'waiting for Link Plus');
    // switched on (trial): it starts
    writeLicence(env.appData, plan({ status: 'trial', active: true, days_left: 60 }, new Date().toISOString()));
    await env.svc.checkLicence();
    assert.ok(env.svc.pbx && env.svc.pbx.running);
    assert.strictEqual(env.svc.status().state, 'running');
  } finally { await env.close(); }
});

test('paid Link Plus: phones register and call', async () => {
  const env = await serviceEnv(() => ({ active: true, state: 'paid' }));
  try {
    env.svc.addPerson({ name: 'Alex Sample', ext: '101' }); env.svc.addPerson({ name: 'Bo Example', ext: '102' });
    await env.svc.start();
    const server = { host: '127.0.0.1', port: env.svc.pbx.port };
    const a = await new SimUA({ ext: '101', password: env.svc.manual('101').password, server }).start();
    const b = await new SimUA({ ext: '102', password: env.svc.manual('102').password, server }).start();
    try {
      assert.strictEqual((await a.register()).status, 200); await b.register();
      const { call, final } = await a.dial('102');
      assert.strictEqual(final.status, 200);
      await a.bye(call);
      await until(() => env.svc.status().recent.length === 1);
      assert.strictEqual(env.svc.status().recent[0].result, 'answered');
    } finally { await a.stop(); await b.stop(); }
  } finally { await env.close(); }
});

test('the licence lapses mid-call: the call carries on, new calls and phones are refused, then it pauses (nothing deleted)', async () => {
  let lic = { active: true, state: 'trial' };
  const env = await serviceEnv(() => lic);
  try {
    for (const [n, e] of [['Alex Sample', '101'], ['Bo Example', '102'], ['Cam Test', '103']]) env.svc.addPerson({ name: n, ext: e });
    await env.svc.start();
    const server = { host: '127.0.0.1', port: env.svc.pbx.port };
    const ua = (ext) => new SimUA({ ext, password: env.svc.manual(ext).password, server }).start();
    const a = await ua('101'); const b = await ua('102'); const c = await ua('103');
    try {
      await a.register(); await b.register(); await c.register();
      const { call } = await a.dial('102');
      await b.waitFor('ack');
      lic = { active: false, state: 'ended', message: NEEDS_PLUS };
      await env.svc.checkLicence();
      assert.strictEqual(env.svc.status().state, 'stopping');
      const refused = (await c.dial('101')).final;
      assert.strictEqual(refused.status, 403);
      assert.strictEqual((await c.register()).status, 403);
      // the call in progress still works: hold, then hang up
      assert.strictEqual((await a.hold(call)).status, 200);
      assert.strictEqual((await a.bye(call)).status, 200);
      await until(() => env.svc.pbx === null);
      const st = env.svc.status();
      assert.strictEqual(st.state, 'waiting-licence');
      assert.strictEqual(st.people.length, 3);
      assert.ok(st.recent.some((r) => r.result === 'answered'));
      // switched back on: it starts again with everything as it was
      lic = { active: true, state: 'paid' };
      await env.svc.checkLicence();
      assert.strictEqual(env.svc.status().state, 'running');
    } finally { await a.stop(); await b.stop(); await c.stop(); }
  } finally { await env.close(); }
});

// ---------- this PC's address ----------
const nic = (address, mac = 'aa:bb:cc:dd:ee:01') => ({ Ethernet: [{ address, netmask: '255.255.255.0', family: 'IPv4', internal: false, mac }],
  'vEthernet (WSL)': [{ address: '172.20.0.1', netmask: '255.255.240.0', family: 'IPv4', internal: false, mac: '00:15:5d:00:00:01' }] });

test('the right network adapter is picked, and the owner can choose another', () => {
  assert.strictEqual(pickAdapter(nic('192.168.1.20')).address, '192.168.1.20');
  assert.strictEqual(pickAdapter(nic('192.168.1.20')).mac, 'AA:BB:CC:DD:EE:01');
  assert.strictEqual(pickAdapter(nic('192.168.1.20'), 'vEthernet (WSL)').address, '172.20.0.1');
  assert.strictEqual(pickAdapter({}).address, '127.0.0.1');
});

test('when this PC\'s address changes, phones get settings with the new one and are asked to fetch them again', async () => {
  let ifaces = nic('192.168.1.20');
  const dir = tmp(); const appData = tmp('appdata'); const store = new Store(dir);
  const opts = { store, appData, sipPort: 0, httpPort: 0, bind: '127.0.0.1', tcp: false, multicast: false, licence: () => ({ active: true, state: 'paid' }), ifaces: () => ifaces };
  const synced = [];
  const orig = Pbx.prototype.checkSync;
  Pbx.prototype.checkSync = function (ip) { synced.push(ip); };
  try {
    const first = new PhoneService(opts);
    first.addPerson({ name: 'Alex Sample', ext: '101' });
    await first.start();
    assert.strictEqual(first.host, '192.168.1.20');
    first.assign('001565aabbcc', '101');
    store.update('phone-devices', {}, (d) => ({ ...d, phones: d.phones.map((p) => ({ ...p, ip: '192.168.1.50' })) }));
    await first.stop();
    assert.strictEqual(first.status().ipChanged, null);

    // the router gave the PC a new address while it was off
    ifaces = nic('192.168.1.23');
    const svc = new PhoneService(opts);
    await svc.start();
    const st = svc.status();
    assert.deepStrictEqual([st.ipChanged.from, st.ipChanged.to], ['192.168.1.20', '192.168.1.23']);
    assert.strictEqual(st.adapter.mac, 'AA:BB:CC:DD:EE:01');
    assert.deepStrictEqual(synced, ['192.168.1.50']);
    const cfg = await get(`http://127.0.0.1:${svc.prov.httpPort}/yealink/001565aabbcc.cfg`);
    assert.match(cfg.body, /sip_server\.1\.address = 192\.168\.1\.23/);
    assert.match(svc.prov.onPnp({ mac: '001565ddeeff', vendor: 'Yealink' }), /^http:\/\/192\.168\.1\.23:/);

    // and while running: it moves to the new address by itself
    ifaces = nic('192.168.1.30');
    assert.strictEqual(await svc.checkNetwork(), true);
    assert.strictEqual(svc.host, '192.168.1.30');
    assert.strictEqual(svc.pbx.host, '192.168.1.30');
    assert.deepStrictEqual(synced, ['192.168.1.50', '127.0.0.1'], 'the phone, at the address it last fetched from');
    ifaces = nic('192.168.1.31');
    await svc.checkNetwork();
    assert.strictEqual(svc.status().ipChanged.unstable, true, 'three changes in 30 days: not stable');
    await svc.stop();
  } finally { Pbx.prototype.checkSync = orig; rmTmp(dir); rmTmp(appData); }
});

test('settings export and import (to move to a new PC, or to Riyeser Link Cloud later) keep extensions, groups, phones and passwords', () => {
  const { exportSettings, importSettings } = require('../src/link/portable');
  const a = tmp(); const b = tmp();
  try {
    const sa = new Store(a); const da = new Directory(sa);
    da.addPerson({ name: 'Alex Sample', ext: '101' }); da.addPerson({ name: 'Bo Example', ext: '102' });
    da.addGroup({ name: 'Front desk', ext: '200', members: ['101', '102'] });
    da.setDnd('102', true);
    new Provisioner({ store: sa, directory: da }).assign('001565aabbcc', '101');
    const out = exportSettings({ directory: da, store: sa });
    assert.strictEqual(out.format, 'riyeser-link-settings');
    const json = JSON.parse(JSON.stringify(out));
    const sb = new Store(b); const db = new Directory(sb);
    assert.deepStrictEqual(importSettings({ directory: db, store: sb, data: json }), { people: 2, groups: 1, phones: 1 });
    assert.deepStrictEqual(db.people().map((p) => [p.ext, p.name]), [['101', 'Alex Sample'], ['102', 'Bo Example']]);
    assert.deepStrictEqual(db.group('200').members, ['101', '102']);
    assert.strictEqual(db.password('101'), da.password('101'));
    assert.strictEqual(db.dnd('102'), true);
    assert.strictEqual(sb.get('phone-devices').phones[0].ext, '101');
    assert.throws(() => importSettings({ directory: db, store: sb, data: { hello: 1 } }), /isn't a Riyeser Link Office settings file/);
  } finally { rmTmp(a); rmTmp(b); }
});

test('trunks: a number that is not on this PC can be handed to a trunk (the seam for the Riyeser relay)', async () => {
  const { Trunks } = require('../src/link/trunks');
  const { setup } = require('./link-helpers');
  const trunks = new Trunks();
  const sent = [];
  trunks.add({ id: 'relay', name: 'Test relay', start() {}, stop() {}, status: () => ({ connected: true, detail: 'test' }),
    route: (n) => (n === '7101' ? { dest: { proto: 'TRUNK', trunk: 'relay', address: 'relay', port: 0 }, uri: 'sip:7101@relay' } : null),
    send: (buf) => sent.push(buf.toString()) });
  const env = await setup({ trunks });
  try {
    const a = await env.ua('101');
    await a.register();
    a.dial('7101').catch(() => {});
    await until(() => sent.some((x) => x.startsWith('INVITE sip:7101@relay')));
    assert.strictEqual((await a.dial('000')).final.status, 404, 'emergency numbers never go to a trunk');
  } finally { await env.close(); }
});

test('wording: status line, licence message, address notice, emergency note', () => {
  const T = require('../src/renderer/link-text');
  assert.strictEqual(T.running('192.168.1.20'), 'Riyeser Link Office is running on this PC (192.168.1.20).');
  assert.strictEqual(T.NEEDS_PLUS, NEEDS_PLUS);
  assert.strictEqual(T.ipChanged({ from: '192.168.1.20', to: '192.168.1.23' }), 'This PC\'s network address changed (was 192.168.1.20, now 192.168.1.23). Phones are being updated. To stop this happening, ask your router to always give this PC the same address. Look for \'DHCP reservation\' or \'Static lease\' in your router\'s settings.');
  assert.ok(T.ipSteps('AA:BB:CC:DD:EE:01', '192.168.1.23').some((s) => s.includes('AA:BB:CC:DD:EE:01')));
  assert.strictEqual(T.EMERGENCY, 'Internal calls only. These phones can\'t call emergency services — keep a mobile or normal phone line for that.');
  assert.strictEqual(T.counts({ phones: 1, onCalls: 0 }), '1 phone connected · no calls right now');
  assert.strictEqual(T.duration(125), '2 min 5 s');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'link.html'), 'utf8');
  assert.ok(html.includes('Riyeser Link Office') && html.includes('Your office phone system'));
  assert.ok(html.includes('<b>Internal calls only.</b> These phones can\'t call emergency services — keep a mobile or normal phone line for that.'));
  for (const s of ['power over the network cable (PoE)', 'same office network as this PC', 'coming with the cloud version', 'Wi-Fi desk phones work too']) assert.ok(html.includes(s), s);
});

test('Windows: sleep settings are read (never changed) and the firewall rule is for this program only, office addresses only', () => {
  const w = require('../src/link/windows');
  const q = 'Power Setting GUID: 29f6c1db\n    Current AC Power Setting Index: 0x00000708\n    Current DC Power Setting Index: 0x00000384\n';
  assert.deepStrictEqual(w.parsePowercfg(q), { ac: 30, dc: 15 });
  assert.match(w.sleepWarning({ sleep: { ac: 30 }, hibernate: { ac: 0 } }), /after 30 minutes/);
  assert.strictEqual(w.sleepWarning({ sleep: { ac: 0 }, hibernate: { ac: 0 } }), null);
  const cmds = w.firewallCommands('C:\\Program Files\\Riyeser Link Office\\Riyeser Link Office.exe');
  assert.ok(cmds.every((c) => c.startsWith('netsh advfirewall firewall ')));
  assert.ok(cmds.slice(1).every((c) => c.includes('program="C:\\Program Files\\Riyeser Link Office\\Riyeser Link Office.exe"') && c.includes('remoteip=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16')));
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'link', 'installer.nsh'), 'utf8');
  for (const c of cmds) assert.ok(nsh.includes(c.replace('C:\\Program Files\\Riyeser Link Office\\Riyeser Link Office.exe', '$INSTDIR\\Riyeser Link Office.exe')), `installer runs: ${c}`);
});
