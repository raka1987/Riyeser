// Riyeser Link Office 1.2.0: surviving a new address for the office PC (a router restart, Wi-Fi <-> Ethernet, a new
// network). Which adapter is the office one; noticing a change (polling and the OS's own events); moving to the new
// address without dropping the phones (Via, Record-Route, Contact, settings, plug-and-play); asking each desk phone to
// pick it up (check-sync, in each maker's wording); riyeser-office.local (mDNS); the router's own name for the PC;
// telling the website at once; the "Use a fixed address" script and its rollback; and the wording.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { Store } = require('../src/core/store');
const { PhoneService } = require('../src/link/service');
const { Pbx } = require('../src/link/pbx');
const { LinkCloud, buildPayload } = require('../src/link/cloud');
const { SimUA } = require('../src/link/simua');
const sip = require('../src/link/sip');
const { pickAdapter, localAddresses, addressSignature } = require('../src/link/netinfo');
const { NetWatcher } = require('../src/link/netwatch');
const { MdnsResponder, parseMessage, queryMessage, answerMessage } = require('../src/link/mdns');
const { resyncEvent, yealinkConfig, grandstreamConfig, polycomConfig, Provisioner } = require('../src/link/provision');
const { candidates, findRouterName } = require('../src/link/pcname');
const win = require('../src/link/windows');
const T = require('../src/renderer/link-text');
const { tmp, rmTmp, get, wait, until } = require('./link-helpers');
const { EventEmitter } = require('events');

const v4 = (address, mac = 'aa:bb:cc:dd:ee:01', netmask = '255.255.255.0') => ({ address, netmask, family: 'IPv4', internal: false, mac });
const lo = { lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' }] };

// ---------- which adapter is the office one ----------
test('adapter choice: virtual, VPN, WSL, Hyper-V, link-local and CGNAT addresses are never picked by themselves', () => {
  const ifaces = { ...lo,
    'vEthernet (WSL)': [v4('172.20.0.1', '00:15:5d:00:00:01')], 'vEthernet (Default Switch)': [v4('192.168.160.1', '00:15:5d:00:00:02')],
    'Ethernet 3': [v4('10.8.0.6', '00:ff:aa:00:00:01')],   // a VPN (says its description)
    Tailscale: [v4('100.101.1.2')], 'Ethernet 2': [v4('169.254.10.20', 'aa:aa:aa:aa:aa:02')],
    'Wi-Fi': [v4('192.168.1.20', 'aa:bb:cc:dd:ee:01')] };
  const describe = { 'Ethernet 3': 'TAP-Windows Adapter V9 for OpenVPN Connect', 'Wi-Fi': 'Intel(R) Wi-Fi 6 AX201 160MHz' };
  const a = pickAdapter(ifaces, '', { describe });
  assert.deepStrictEqual([a.name, a.address, a.mac], ['Wi-Fi', '192.168.1.20', 'AA:BB:CC:DD:EE:01']);
  const list = localAddresses(ifaces, { describe });
  assert.ok(!list.some((x) => /^(127|169\.254|100\.)/.test(x.address)), 'no loopback, link-local or CGNAT');
  assert.deepStrictEqual(list.filter((x) => x.virtual).map((x) => x.name).sort(), ['Ethernet 3', 'vEthernet (Default Switch)', 'vEthernet (WSL)']);
  // only virtual adapters: no office network (127.0.0.1), unless one of them is the way to the router (Hyper-V external switch)
  const onlyVirtual = { 'vEthernet (External)': [v4('192.168.1.40')], 'vEthernet (WSL)': [v4('172.20.0.1')] };
  assert.strictEqual(pickAdapter(onlyVirtual).address, '127.0.0.1');
  assert.strictEqual(pickAdapter(onlyVirtual, '', { gateways: ['192.168.1.40'] }).address, '192.168.1.40');
  // the owner's choice wins, even a virtual one
  assert.strictEqual(pickAdapter(ifaces, 'vEthernet (WSL)', { describe }).address, '172.20.0.1');
});

test('adapter choice: the adapter with the router comes first, and a second address or network doesn\'t move the phones', () => {
  const two = { Ethernet: [v4('10.0.0.15', 'aa:00:00:00:00:01')], 'Wi-Fi': [v4('192.168.1.20', 'aa:00:00:00:00:02')] };
  assert.strictEqual(pickAdapter(two).address, '192.168.1.20', 'no hints: 192.168 first');
  assert.strictEqual(pickAdapter(two, '', { gateways: ['10.0.0.15'] }).address, '10.0.0.15', 'the adapter with the router first');
  // in use: 10.0.0.15; Wi-Fi joining another network must not take the phones away
  assert.strictEqual(pickAdapter(two, '', { last: { name: 'Ethernet', address: '10.0.0.15' } }).address, '10.0.0.15');
  // a second address on the same adapter: stays on the one in use
  const second = { Ethernet: [v4('192.168.1.20'), v4('192.168.1.99')] };
  assert.strictEqual(pickAdapter(second, '', { last: { name: 'Ethernet', address: '192.168.1.99' } }).address, '192.168.1.99');
  assert.strictEqual(pickAdapter(second, 'Ethernet', { last: { name: 'Ethernet', address: '192.168.1.99' } }).address, '192.168.1.99', 'on the adapter the owner chose too');
  // the adapter in use got a new address (DHCP): follow it on the same adapter, not a different one
  const moved = { Ethernet: [v4('10.0.0.15')], 'Wi-Fi': [v4('192.168.1.35')] };
  assert.strictEqual(pickAdapter(moved, '', { last: { name: 'Ethernet', address: '10.0.0.9' } }).address, '10.0.0.15');
  assert.notStrictEqual(addressSignature(two), addressSignature(moved));
  assert.strictEqual(addressSignature({ ...two, ...lo }), addressSignature(two), 'loopback never counts as a change');
});

// ---------- noticing a change ----------
test('the watcher notices a change from the OS\'s own event (and by polling), once it has settled', async () => {
  let ifaces = { Ethernet: [v4('192.168.1.20')] };
  const os = new EventEmitter();
  const w = new NetWatcher({ ifaces: () => ifaces, interval: 60000, settle: 60, events: os }).start();
  const seen = [];
  w.on('change', (c) => seen.push(c));
  try {
    assert.strictEqual(w.check(), false, 'nothing changed');
    ifaces = { Ethernet: [v4('169.254.3.4')] };   // DHCP hasn't answered yet...
    os.emit('changed', 'address');
    await wait(20);
    ifaces = { Ethernet: [v4('192.168.1.35')] };   // ...then the real address
    await until(() => seen.length === 1, 2000);
    assert.strictEqual(seen[0].source, 'os');
    assert.match(seen[0].before, /192\.168\.1\.20/); assert.match(seen[0].after, /192\.168\.1\.35/);
    await wait(150); assert.strictEqual(seen.length, 1, 'reported once');
    // polling finds it too
    const p = new NetWatcher({ ifaces: () => ifaces, interval: 30, settle: 0, events: null }).start();
    const polled = [];
    p.on('change', (c) => polled.push(c.source));
    ifaces = { Ethernet: [v4('192.168.1.36')] };
    await until(() => polled.length === 1, 2000);
    assert.deepStrictEqual(polled, ['poll']);
    p.stop();
  } finally { w.stop(); }
});

// ---------- moving to the new address ----------
const YEALINK_UA = 'Yealink SIP-T31P 124.86.0.40 00:15:65:aa:bb:cc';
function office(opts = {}) {
  const dir = tmp(); const appData = tmp('appdata');
  fs.mkdirSync(path.join(appData, 'Riyeser'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Riyeser', 'company.json'), JSON.stringify({ name: 'Sample Trading Co', mode: 'online', workspace_id: 'ws-1' }));
  const store = new Store(dir);
  const st = { ifaces: { ...lo, Ethernet: [v4('192.168.1.20')] } };
  const svc = new PhoneService({ store, appData, sipPort: 0, httpPort: 0, tcp: false, multicast: false, licence: () => ({ active: true, state: 'paid' }),
    ifaces: () => st.ifaces, mdns: { port: 0, multicast: false }, hostname: 'OFFICE-PC', findName: async ({ address }) => (st.dns ? (st.dns[address] || null) : null), ...opts });
  svc.addPerson({ name: 'Alex Sample', ext: '101' }); svc.addPerson({ name: 'Bo Example', ext: '102' });
  return { dir, appData, store, svc, st, close: async () => { await svc.stop(); rmTmp(dir); rmTmp(appData); } };
}
const mdnsAsk = (port, name = 'riyeser-office.local', id = 4242) => new Promise((resolve, reject) => {
  const s = dgram.createSocket('udp4');
  const t = setTimeout(() => { s.close(); reject(new Error('no mDNS answer')); }, 1500);
  s.on('message', (buf) => { clearTimeout(t); s.close(); resolve(parseMessage(buf)); });
  s.bind(0, '127.0.0.1', () => s.send(queryMessage(name, { id }), port, '127.0.0.1'));
});

test('a new address while running: phones stay registered, SIP and settings use it, desk phones are asked to restart, the website hears at once', async () => {
  const o = office();
  const uas = [];
  try {
    await o.svc.start();
    assert.strictEqual(o.svc.host, '192.168.1.20');
    o.svc.assign('001565aabbcc', '101');
    const port = o.svc.pbx.port;
    const A = await new SimUA({ ext: '101', password: o.svc.directory.password('101'), server: { host: '127.0.0.1', port }, userAgent: YEALINK_UA }).start();
    const B = await new SimUA({ ext: '102', password: o.svc.directory.password('102'), server: { host: '127.0.0.1', port }, userAgent: 'Grandstream GRP2601P 1.0.5.67 c0:74:ad:11:22:33' }).start();
    uas.push(A, B);
    assert.strictEqual((await A.register()).status, 200); assert.strictEqual((await B.register()).status, 200);
    // the website, linked
    const sent = [];
    const online = { session: { access_token: 'x' }, rpc: async (name, args) => { sent.push({ name, args }); return name === 'link_office_report' ? { ok: true, pending: 0 } : []; } };
    const cloud = new LinkCloud({ service: o.svc, clients: () => [online], appData: o.appData, version: '1.2.0', pcName: 'OFFICE-PC' });
    cloud.start();
    assert.strictEqual((await mdnsAsk(o.svc.mdns.port)).answers[0].address, '192.168.1.20', 'riyeser-office.local answers the address');

    // the router restarts and gives the PC .35; the old address is gone
    const notifies = [];
    A.on('notify', (m) => notifies.push(['A', sip.getHeader(m, 'event')])); B.on('notify', (m) => notifies.push(['B', sip.getHeader(m, 'event')]));
    const changed = new Promise((r) => o.svc.once('address-changed', r));
    o.st.ifaces = { ...lo, Ethernet: [v4('192.168.1.35')] };
    assert.strictEqual(await o.svc.checkNetwork('os'), true);
    const c = await changed;
    assert.deepStrictEqual([c.from, c.to, c.source], ['192.168.1.20', '192.168.1.35', 'os']);
    assert.strictEqual(o.svc.pbx.host, '192.168.1.35'); assert.strictEqual(o.svc.pbx.port, port, 'the same listeners (no restart)');
    assert.strictEqual(o.svc.status().counts.phones, 2, 'registrations kept');
    // each phone: "fetch your settings and restart", in its maker's wording
    await until(() => notifies.length === 2);
    assert.deepStrictEqual(notifies.sort(), [['A', 'check-sync;reboot=true'], ['B', 'check-sync;reboot=true']]);
    assert.strictEqual(o.svc.status().ipChanged.phones, 2);
    // settings, plug-and-play and riyeser-office.local carry the new address
    const cfg = await get(`http://127.0.0.1:${o.svc.prov.httpPort}/yealink/001565aabbcc.cfg`);
    assert.match(cfg.body, /account\.1\.sip_server\.1\.address = 192\.168\.1\.35/);
    assert.match(cfg.body, /static\.auto_provision\.server\.url = http:\/\/192\.168\.1\.35:/);
    assert.match(o.svc.prov.onPnp({ mac: '001565ddeeff', vendor: 'Yealink' }), /^http:\/\/192\.168\.1\.35:/);
    assert.strictEqual((await mdnsAsk(o.svc.mdns.port)).answers[0].address, '192.168.1.35');
    // a call now: the INVITE B gets says the new address (Via and Record-Route)
    const got = B.waitFor('invite');
    const dial = A.dial('102');
    const inv = await got;
    assert.match(sip.getHeader(inv, 'via'), /^SIP\/2\.0\/UDP 192\.168\.1\.35:/);
    assert.match(sip.getHeader(inv, 'record-route'), /sip:192\.168\.1\.35:/);
    const { call } = await dial; await A.bye(call);
    // the old address still counts as us for calls set up before the change (Route header)
    assert.ok(o.svc.pbx.isUs(sip.parseUri(`sip:192.168.1.20:${port};lr`)));
    assert.ok(o.svc.pbx.isUs(sip.parseUri(`sip:riyeser-office.local:${port};lr`)), 'and so does the name');
    // the website: reported straight away, with the new address first and the change listed
    await until(() => sent.some((x) => x.name === 'link_office_report' && x.args.payload.addresses[0] === '192.168.1.35'), 3000);
    const p = sent.filter((x) => x.name === 'link_office_report').pop().args.payload;
    assert.deepStrictEqual(p.address_changes.map((x) => [x.from, x.to]), [['192.168.1.20', '192.168.1.35']]);
    assert.strictEqual(p.mdns_name, 'riyeser-office.local'); assert.strictEqual(p.phone_server, '192.168.1.35');
    assert.strictEqual(o.svc.logs.some((l) => /changed from 192\.168\.1\.20 to 192\.168\.1\.35/.test(l.text)), true, 'in the log');
    cloud.stop();
  } finally { for (const u of uas) await u.stop(); await o.close(); }
});

test('a second network appearing during a call waits for the call to end; a lost address moves at once; no network is not a change', async () => {
  const o = office();
  const uas = [];
  try {
    await o.svc.start();
    const port = o.svc.pbx.port;
    const A = await new SimUA({ ext: '101', password: o.svc.directory.password('101'), server: { host: '127.0.0.1', port } }).start();
    const B = await new SimUA({ ext: '102', password: o.svc.directory.password('102'), server: { host: '127.0.0.1', port } }).start();
    uas.push(A, B); await A.register(); await B.register();
    const { call } = await A.dial('102');
    // the owner picks Wi-Fi while a call is on, and the old address is still there: wait
    o.st.ifaces = { ...lo, Ethernet: [v4('192.168.1.20')], 'Wi-Fi': [v4('192.168.1.77', 'aa:bb:cc:dd:ee:09')] };
    o.svc.setSettings({ adapter: 'Wi-Fi' });
    assert.strictEqual(await o.svc.checkNetwork('poll'), false);
    assert.strictEqual(o.svc.host, '192.168.1.20');
    await A.bye(call);
    await until(() => o.svc.host === '192.168.1.77', 3000);   // moved once the call ended
    o.svc.setSettings({ adapter: '' });
    // the cable comes out: no office network. Not a "new address": it waits on the old one
    o.st.ifaces = { ...lo };
    assert.strictEqual(await o.svc.checkNetwork('os'), false);
    assert.strictEqual(o.svc.host, '192.168.1.77'); assert.strictEqual(o.svc.status().offline, true);
    // back on the same address: nothing to do
    o.st.ifaces = { ...lo, 'Wi-Fi': [v4('192.168.1.77', 'aa:bb:cc:dd:ee:09')] };
    assert.strictEqual(await o.svc.checkNetwork('os'), false); assert.strictEqual(o.svc.status().offline, false);
  } finally { for (const u of uas) await u.stop(); await o.close(); }
});

test('the router\'s own name for the PC: checked against the address, given to phones only when chosen, and backup server otherwise', async () => {
  const o = office();
  try {
    o.st.dns = { '192.168.1.20': 'office-pc.lan' };
    await o.svc.start();
    await until(() => o.svc.routerName === 'office-pc.lan');
    o.svc.assign('001565aabbcc', '101');
    let cfg = (await get(`http://127.0.0.1:${o.svc.prov.httpPort}/yealink/001565aabbcc.cfg`)).body;
    assert.match(cfg, /sip_server\.1\.address = 192\.168\.1\.20/); assert.match(cfg, /sip_server\.2\.address = office-pc\.lan/, 'the name as the backup server');
    const n = await o.svc.setPhoneAddress('name');
    assert.deepStrictEqual([n.useName, n.server], [true, 'office-pc.lan']);
    cfg = (await get(`http://127.0.0.1:${o.svc.prov.httpPort}/yealink/001565aabbcc.cfg`)).body;
    assert.match(cfg, /sip_server\.1\.address = office-pc\.lan/); assert.match(cfg, /server\.url = http:\/\/office-pc\.lan:/);
    assert.strictEqual(o.svc.manual('101').server, 'office-pc.lan');
    // the PC moves and the router hasn't caught up (or never knew it): phones get the address again
    o.st.dns = {};
    o.st.ifaces = { ...lo, Ethernet: [v4('192.168.1.35')] };
    await o.svc.checkNetwork('os');
    assert.strictEqual(o.svc.routerName, null); assert.strictEqual(o.svc.names().server, '192.168.1.35');
    cfg = (await get(`http://127.0.0.1:${o.svc.prov.httpPort}/yealink/001565aabbcc.cfg`)).body;
    assert.match(cfg, /sip_server\.1\.address = 192\.168\.1\.35/); assert.doesNotMatch(cfg, /sip_server\.2/);
  } finally { await o.close(); }
  // the name is only trusted when the network's DNS gives exactly this PC's address
  assert.deepStrictEqual(candidates('OFFICE-PC', ['corp.example']).slice(0, 3), ['office-pc.corp.example', 'office-pc.lan', 'office-pc.home']);
  assert.ok(!candidates('OFFICE-PC').includes('office-pc'), 'never the bare name');
  const dns = { 'office-pc.lan': ['192.168.1.99'], 'office-pc.home': ['192.168.1.20'] };
  const resolve4 = async (n) => { if (dns[n]) return dns[n]; throw new Error('ENOTFOUND'); };
  assert.strictEqual(await findRouterName({ hostname: 'OFFICE-PC', address: '192.168.1.20', resolve4 }), 'office-pc.home', 'a stale name for another address is skipped');
  assert.strictEqual(await findRouterName({ hostname: 'OFFICE-PC', address: '192.168.1.50', resolve4 }), null);
});

// ---------- SIP: this PC's old address in messages from software on this PC ----------
test('SIP address rewriting: Via, Contact, Record-Route, Route and the SDP move to the new address; received= and From/To stay', () => {
  const raw = ['INVITE sip:102@192.168.1.20:5060 SIP/2.0', 'Via: SIP/2.0/UDP 192.168.1.20:5062;branch=z9hG4bK1;rport;received=192.168.1.20',
    'Route: <sip:192.168.1.20:5060;lr>', 'Record-Route: <sip:192.168.1.20;lr>', 'From: "Alex" <sip:101@192.168.1.20>;tag=a', 'To: <sip:102@192.168.1.20>',
    'Call-ID: x@192.168.1.20', 'CSeq: 1 INVITE', 'Contact: <sip:101@192.168.1.20:5062;transport=udp>', 'Content-Type: application/sdp', '', ''].join('\r\n');
  const m = sip.parse(Buffer.from(raw));
  m.body = Buffer.from('v=0\r\no=- 5 5 IN IP4 192.168.1.20\r\ns=-\r\nc=IN IP4 192.168.1.20\r\nt=0 0\r\nm=audio 40000 RTP/AVP 0 8\r\na=rtcp:40001 IN IP4 192.168.1.20\r\n');
  assert.strictEqual(sip.rewriteHost(m, '192.168.1.20', '192.168.1.35'), 7);
  const out = sip.serialize(m).toString();
  assert.match(out, /Via: SIP\/2\.0\/UDP 192\.168\.1\.35:5062;branch=z9hG4bK1;rport;received=192\.168\.1\.20/);
  assert.match(out, /Route: <sip:192\.168\.1\.35:5060;lr>/); assert.match(out, /Record-Route: <sip:192\.168\.1\.35;lr>/);
  assert.match(out, /Contact: <sip:101@192\.168\.1\.35:5062;transport=udp>/);
  assert.match(out, /From: "Alex" <sip:101@192\.168\.1\.20>/); assert.match(out, /Call-ID: x@192\.168\.1\.20/);
  assert.match(out, /c=IN IP4 192\.168\.1\.35\r\n/); assert.match(out, /o=- 5 5 IN IP4 192\.168\.1\.35/); assert.match(out, /a=rtcp:40001 IN IP4 192\.168\.1\.35/);
  // a different address that only starts the same is left alone
  const m2 = sip.parse(Buffer.from(raw.replace('Contact: <sip:101@192.168.1.20:5062', 'Contact: <sip:101@192.168.1.201:5062')));
  sip.rewriteHost(m2, '192.168.1.20', '192.168.1.35');
  assert.match(sip.getHeader(m2, 'contact'), /192\.168\.1\.201:5062/);
  // the phone system only does it for this PC's own software, and only after a change
  const pbx = new Pbx({ directory: null, host: '192.168.1.20', port: 5060, tcp: false, multicast: false });
  const fresh = () => sip.parse(Buffer.from(raw));
  assert.strictEqual(pbx.fixLocal(fresh(), { proto: 'UDP', address: '127.0.0.1', port: 5062 }), 0, 'nothing changed yet');
  pbx.setHost('192.168.1.35', {});
  assert.ok(pbx.fixLocal(fresh(), { proto: 'UDP', address: '127.0.0.1', port: 5062 }) > 0, 'from this PC');
  assert.strictEqual(pbx.fixLocal(fresh(), { proto: 'UDP', address: '192.168.1.50', port: 5060 }), 0, 'never a desk phone\'s message');
  assert.deepStrictEqual(pbx.oldHosts, ['192.168.1.20']);
});

// ---------- riyeser-office.local ----------
test('mDNS: answers riyeser-office.local (A and ANY) with this PC\'s address, nothing else; follows a new address; takes another name on a clash', async () => {
  const r = await new MdnsResponder({ address: '192.168.1.20', port: 0, bind: '127.0.0.1', multicast: false, ownAddresses: () => ['192.168.1.20'] }).start();
  try {
    let a = await mdnsAsk(r.port, 'Riyeser-Office.local', 77);
    assert.strictEqual(a.id, 77); assert.strictEqual(a.response, true);
    assert.deepStrictEqual(a.questions.map((q) => q.name), ['Riyeser-Office.local'], 'legacy unicast: the question comes back');
    assert.deepStrictEqual(a.answers.map((x) => [x.name, x.address, x.ttl]), [['riyeser-office.local', '192.168.1.20', 10]]);
    await assert.rejects(mdnsAsk(r.port, 'someone-else.local'), /no mDNS answer/);
    // malformed packets are ignored
    const s = dgram.createSocket('udp4'); await new Promise((res) => s.bind(0, '127.0.0.1', res));
    for (const junk of [Buffer.from('hi'), Buffer.alloc(40, 0xff), Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1])]) s.send(junk, r.port, '127.0.0.1');
    await wait(100); s.close();
    assert.ok(r.stats.malformed >= 2);
    r.setAddress('192.168.1.35');
    a = await mdnsAsk(r.port);
    assert.strictEqual(a.answers[0].address, '192.168.1.35');
    // another computer answers for the name with a different address: move to riyeser-office-2.local
    const names = []; r.on('name', (n) => names.push(n));
    r.receive(answerMessage('riyeser-office.local', '192.168.1.60'), { address: '192.168.1.60', port: 5353 });
    assert.deepStrictEqual(names, ['riyeser-office-2.local']);
    r.receive(answerMessage('riyeser-office-2.local', '192.168.1.35'), { address: '192.168.1.35', port: 5353 });
    assert.strictEqual(r.name, 'riyeser-office-2.local', 'our own echo is not a clash');
    assert.strictEqual((await mdnsAsk(r.port, 'riyeser-office-2.local')).answers[0].address, '192.168.1.35');
  } finally { await r.stop(); }
});

// ---------- asking phones to pick up the new address ----------
test('re-provisioning: check-sync in each maker\'s wording, restart after a new address; settings carry a backup server and start-up plug-and-play', () => {
  assert.strictEqual(resyncEvent('yealink'), 'check-sync;reboot=false');
  assert.strictEqual(resyncEvent('yealink', { reboot: true }), 'check-sync;reboot=true');
  assert.strictEqual(resyncEvent('grandstream', { reboot: true }), 'check-sync;reboot=true');
  assert.strictEqual(resyncEvent('snom', { reboot: true }), 'check-sync;reboot=true');
  assert.strictEqual(resyncEvent('polycom', { reboot: true }), 'check-sync');
  assert.strictEqual(resyncEvent('cisco'), 'resync'); assert.strictEqual(resyncEvent('cisco', { reboot: true }), 'reboot');
  const a = { mac: '001565aabbcc', ext: '101', name: 'Alex', password: 'pw', server: '192.168.1.20', backup: 'office-pc.lan', sipPort: 5060, provisionUrl: 'http://192.168.1.20:5080/yealink/' };
  const y = yealinkConfig(a);
  for (const l of ['account.1.sip_server.2.address = office-pc.lan', 'static.auto_provision.pnp_enable = 1', 'static.auto_provision.power_on = 1', 'sip.notify_reboot_enable = 1']) assert.ok(y.includes(l), l);
  assert.match(grandstreamConfig(a), /<P2312>office-pc\.lan:5060<\/P2312>/);
  assert.match(polycomConfig(a), /reg\.1\.server\.2\.address="office-pc\.lan"/); assert.match(polycomConfig(a), /checkSync\.alwaysReboot="1"/);
  assert.doesNotMatch(yealinkConfig({ ...a, backup: null }), /sip_server\.2/);
  const p = new Provisioner({ host: '192.168.1.20', name: 'office-pc.lan', useName: true });
  assert.deepStrictEqual(p.servers(), { server: 'office-pc.lan', backup: '192.168.1.20' });
  p.setHost('192.168.1.35', { useName: false });
  assert.deepStrictEqual(p.servers(), { server: '192.168.1.35', backup: 'office-pc.lan' });
  // the NOTIFY itself
  const pbx = new Pbx({ directory: null, host: '192.168.1.35', port: 5060, tcp: false, multicast: false });
  const out = []; pbx.running = true; pbx._send = (buf, dest) => out.push([buf.toString(), dest]);
  pbx.checkSync('192.168.1.50', 5062, resyncEvent('yealink', { reboot: true }));
  assert.match(out[0][0], /^NOTIFY sip:192\.168\.1\.50:5062 SIP\/2\.0/); assert.match(out[0][0], /Event: check-sync;reboot=true/);
  assert.match(out[0][0], /Via: SIP\/2\.0\/UDP 192\.168\.1\.35:5060/); assert.deepStrictEqual(out[0][1], { proto: 'UDP', address: '192.168.1.50', port: 5062 });
});

test('the heartbeat carries the names and the last address changes', () => {
  const p = buildPayload({ host: '192.168.1.35', state: 'running', names: { mdns: 'riyeser-office.local', router: 'office-pc.lan', server: 'office-pc.lan' },
    addressChanges: [{ at: '2026-11-27T01:00:00.000Z', from: '192.168.1.20', to: '192.168.1.35', source: 'os' }], adapter: { mac: 'AA:BB:CC:DD:EE:01' } }, { officeId: 'lo-abcdefgh' });
  assert.deepStrictEqual([p.mdns_name, p.router_name, p.phone_server], ['riyeser-office.local', 'office-pc.lan', 'office-pc.lan']);
  assert.deepStrictEqual(p.address_changes, [{ from: '192.168.1.20', to: '192.168.1.35', at: '2026-11-27T01:00:00.000Z' }]);
});

// ---------- Windows: what it reads, the firewall rule, and the optional fixed address ----------
test('Windows: adapter details are read, the firewall rule opens 5353 for the name, and the fixed address checks the router and rolls back', () => {
  const rows = win.parseNetConfig(JSON.stringify([
    { alias: 'Ethernet', description: 'Intel(R) Ethernet Connection I219-V', address: '192.168.1.20', prefix: 24, gateway: '192.168.1.1', dns: ['192.168.1.1', '8.8.8.8'], dhcp: true, suffix: 'lan', mac: '3C-52-82-1A-2B-3C' },
    { alias: 'vEthernet (WSL)', description: 'Hyper-V Virtual Ethernet Adapter', address: '172.20.0.1', prefix: 20, gateway: null, dns: [], dhcp: false, mac: '00-15-5D-00-00-01' },
    { alias: 'Broken', address: 'not an address' }]));
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual([rows[0].netmask, rows[0].gateway, rows[0].dhcp, rows[0].mac, rows[0].suffix], ['255.255.255.0', '192.168.1.1', true, '3C:52:82:1A:2B:3C', 'lan']);
  assert.strictEqual(rows[1].netmask, '255.255.240.0');
  assert.deepStrictEqual(win.parseNetConfig('{"alias":"Wi-Fi","address":"10.0.0.5","prefix":8}').map((r) => r.netmask), ['255.0.0.0'], 'one adapter comes as an object');
  assert.deepStrictEqual(win.parseNetConfig('oops'), []);
  // the firewall rule: UDP 5060 and 5353, office addresses only; a rule from before 1.2.0 shows as outdated
  const cmds = win.firewallCommands('C:\\Program Files\\Riyeser Link Office\\Riyeser Link Office.exe');
  assert.match(cmds[1], /protocol=UDP localport=5060,5353 /); assert.match(cmds[1], /remoteip=10\.0\.0\.0\/8,172\.16\.0\.0\/12,192\.168\.0\.0\/16,169\.254\.0\.0\/16/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'build', 'link', 'installer.nsh'), 'utf8'), /protocol=UDP localport=5060,5353 /);
  assert.strictEqual(win.ruleState(true, 'Rule Name: Riyeser Link Office\nLocalPort: 5060,5353'), true);
  assert.strictEqual(win.ruleState(true, 'Rule Name: Riyeser Link Office\nLocalPort: 5060'), 'outdated');
  assert.strictEqual(win.ruleState(false, ''), false);
  // the fixed address: never without an address and a router; refuses odd adapter names
  assert.throws(() => win.fixedAddressScript({ alias: 'Ethernet', address: '192.168.1.20', prefix: 24, gateway: '' }, 'r.json'), /needs an address and a router/);
  assert.throws(() => win.fixedAddressScript({ alias: 'Eth"; rm', address: '192.168.1.20', prefix: 24, gateway: '192.168.1.1' }, 'r.json'));
  const ps = win.fixedAddressScript({ alias: 'Ethernet', address: '192.168.1.20', prefix: 24, gateway: '192.168.1.1', dns: ['192.168.1.1', '1.1.1.1', '9.9.9.9'] }, 'C:\\t\\r.json');
  assert.match(ps, /netsh interface ipv4 set address name="\$alias" source=static address=192\.168\.1\.20 mask=255\.255\.255\.0 gateway=192\.168\.1\.1/);
  assert.match(ps, /set dnsservers name="\$alias" source=static address=192\.168\.1\.1/); assert.match(ps, /add dnsservers name="\$alias" address=1\.1\.1\.1 index=2/);
  assert.doesNotMatch(ps, /9\.9\.9\.9/);
  assert.match(ps, /Test-Connection -ComputerName '192\.168\.1\.1'/, 'checks the router afterwards');
  assert.match(ps, /if \(-not \$ok\) \{\r\n {2}netsh interface ipv4 set address name="\$alias" source=dhcp/, 'and goes back to automatic by itself if it can\'t');
  assert.match(ps, /why = 'in-use'/, 'never takes an address another device answers on');
  assert.match(win.dhcpScript('Ethernet', 'r.json'), /set address name="\$alias" source=dhcp/);
});

test('wording: the address-changed notice and the router helper', () => {
  assert.strictEqual(T.ipChanged({ from: '192.168.1.20', to: '192.168.1.35' }), 'Your PC\'s address changed from 192.168.1.20 to .35 — phones updated.');
  assert.strictEqual(T.ipChanged({ from: '192.168.1.20', to: '10.0.0.7' }), 'Your PC\'s address changed from 192.168.1.20 to 10.0.0.7 — phones updated.');
  assert.match(T.ipChangedMore({ from: '192.168.1.20', to: '192.168.1.35', phones: 3 }), /asked 3 desk phones to restart/);
  const ids = T.ROUTERS.map((r) => r.id);
  for (const id of ['tplink', 'netgear', 'asus', 'linksys', 'dlink', 'unifi', 'fritz', 'mikrotik', 'isp', 'other']) assert.ok(ids.includes(id), id);
  assert.ok(T.ROUTERS.every((r) => r.steps.length >= 3));
  assert.strictEqual(T.reserveWhat('3C:52:82:1A:2B:3C', '192.168.1.35'), 'Reserve 192.168.1.35 for the MAC address 3C:52:82:1A:2B:3C.');
});
