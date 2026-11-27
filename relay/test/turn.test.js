// The relay's own STUN/TURN server, checked with coturn's own test client (turnutils_uclient, when installed: it's a
// different implementation, so this is a real check of the protocol) and with a small client here.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { TurnServer, build, parse, encXorAddr, xorAddr, M, C, A } = require('../lib/turn');
const tokens = require('../lib/tokens');
const { Ddns } = require('../lib/ddns');
const { findPublicIp } = require('../lib/publicip');

const SECRET = tokens.keys('turn-test-secret-0123456789abcdef0123456789').turn;
const have = (cmd) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };

test('STUN binding: tells a client its address (what browsers use instead of Google\'s STUN)', async () => {
  const t = await new TurnServer({ secret: SECRET, port: 0, bind: '127.0.0.1', min: 47100, max: 47110 }).start();
  const s = dgram.createSocket('udp4'); await new Promise((r) => s.bind(0, '127.0.0.1', r));
  const tid = crypto.randomBytes(12);
  const got = new Promise((r) => s.once('message', r));
  s.send(build(M.BINDING, C.REQUEST, tid), t.port, '127.0.0.1');
  const m = parse(await got);
  assert.equal(m.cls, C.SUCCESS);
  assert.deepEqual(xorAddr(m.attrs.find((a) => a[0] === A.XOR_MAPPED_ADDRESS)[1]), { family: 1, port: s.address().port, address: '127.0.0.1' });
  s.close(); await t.stop();
});

test('TURN with coturn\'s client: UDP, TCP, and an expired password refused', { skip: have('turnutils_uclient') && have('turnutils_peer') ? false : 'coturn\'s test tools aren\'t installed' }, async () => {
  const t = await new TurnServer({ secret: SECRET, port: 0, bind: '127.0.0.1', min: 47200, max: 47260, allowPrivatePeers: true, publicIp: '127.0.0.1' }).start();
  const peer = spawn('turnutils_peer', ['-p', '47290', '-L', '127.0.0.1'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  const run = (cred, extra = []) => new Promise((resolve) => {
    const c = spawn('turnutils_uclient', [...extra, '-p', String(t.port), '-e', '127.0.0.1', '-r', '47290', '-u', cred.username, '-w', cred.credential, '-n', '5', '-m', '1', '-l', '170', '127.0.0.1']);
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const k = setTimeout(() => c.kill('SIGKILL'), 15000); c.on('close', () => { clearTimeout(k); resolve(out); });
  });
  try {
    const udp = await run(tokens.turnCredentials(SECRET, 'user-1', 600));
    assert.match(udp, /tot_send_msgs=10, tot_recv_msgs=10/, udp.slice(-400));
    assert.match(udp, /Total lost packets 0 /);
    const tcp = await run(tokens.turnCredentials(SECRET, 'user-1', 600), ['-t']);
    assert.match(tcp, /tot_send_msgs=10, tot_recv_msgs=10/, tcp.slice(-400));
    const before = t.stats.refused;
    const old = await run(tokens.turnCredentials(SECRET, 'user-1', -30));
    assert.match(old, /Cannot complete Allocation/);
    assert.ok(t.stats.refused > before, 'refused');
    const forged = await run({ username: `${Math.floor(Date.now() / 1000) + 600}:user-1`, credential: 'bm90LXRoZS1yaWdodC1wYXNzd29yZA==' });
    assert.match(forged, /Cannot complete Allocation/);
  } finally { peer.kill('SIGKILL'); await t.stop(); }
});

test('TURN never relays to this machine\'s own network (no way into the office LAN)', async () => {
  const t = await new TurnServer({ secret: SECRET, port: 0, bind: '127.0.0.1', min: 47300, max: 47310, publicIp: '203.0.113.5' }).start();
  const s = dgram.createSocket('udp4'); await new Promise((r) => s.bind(0, '127.0.0.1', r));
  const ask = (msg) => new Promise((r) => { s.once('message', (m) => r(parse(m))); s.send(msg, t.port, '127.0.0.1'); });
  const cred = tokens.turnCredentials(SECRET, 'u', 600);
  let res = await ask(build(M.ALLOCATE, C.REQUEST, crypto.randomBytes(12), [[A.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])]]));
  assert.equal(res.cls, C.ERROR);
  const realm = res.attrs.find((a) => a[0] === A.REALM)[1]; const nonce = res.attrs.find((a) => a[0] === A.NONCE)[1];
  const key = crypto.createHash('md5').update(`${cred.username}:${realm}:${cred.credential}`).digest();
  const auth = [[A.USERNAME, Buffer.from(cred.username)], [A.REALM, realm], [A.NONCE, nonce]];
  res = await ask(build(M.ALLOCATE, C.REQUEST, crypto.randomBytes(12), [[A.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])], ...auth], key));
  assert.equal(res.cls, C.SUCCESS);
  assert.equal(xorAddr(res.attrs.find((a) => a[0] === A.XOR_RELAYED_ADDRESS)[1]).address, '203.0.113.5', 'the relayed address is the public one');
  for (const ip of ['192.168.1.1', '10.0.0.5', '127.0.0.1', '172.20.0.1']) {
    res = await ask(build(M.CREATE_PERMISSION, C.REQUEST, crypto.randomBytes(12), [[A.XOR_PEER_ADDRESS, encXorAddr({ address: ip, port: 80 })], ...auth], key));
    assert.equal(res.cls, C.ERROR, `no permission to ${ip}`);
  }
  res = await ask(build(M.CREATE_PERMISSION, C.REQUEST, crypto.randomBytes(12), [[A.XOR_PEER_ADDRESS, encXorAddr({ address: '198.51.100.20', port: 5000 })], ...auth], key));
  assert.equal(res.cls, C.SUCCESS, 'a public peer is fine');
  s.close(); await t.stop();
});

test('own dynamic DNS (Cloudflare API) and finding the public IP without outside services', async () => {
  const calls = [];
  const fetch = async (url, o = {}) => { calls.push([o.method || 'GET', url, o.body ? JSON.parse(o.body) : null]); return { ok: true, status: 200, json: async () => (o.method !== 'GET' ? {} : { result: [{ id: 'rec1', content: '198.51.100.1' }] }) }; };
  const d = new Ddns({ provider: 'cloudflare', token: 't', zone: 'z1', name: 'relay.riyeser.com', fetch });
  assert.equal(await d.update('198.51.100.9'), true);
  assert.deepEqual(calls[1], ['PUT', 'https://api.cloudflare.com/client/v4/zones/z1/dns_records/rec1', { type: 'A', name: 'relay.riyeser.com', content: '198.51.100.9', ttl: 60, proxied: false }]);
  assert.equal(await d.update('198.51.100.9'), false, 'nothing to do the second time');
  assert.deepEqual(await findPublicIp({ configured: '198.51.100.4' }), { ip: '198.51.100.4', how: 'set by hand' });
  assert.deepEqual(await findPublicIp({ ifaces: { eth0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }] }, pmp: async () => '198.51.100.6' }), { ip: '198.51.100.6', how: 'router (NAT-PMP)' });
  assert.deepEqual(await findPublicIp({ ifaces: {}, pmp: async () => null, seenBySync: '198.51.100.7' }), { ip: '198.51.100.7', how: 'as seen by Riyeser online' });
  assert.deepEqual(await findPublicIp({ ifaces: { ens3: [{ family: 'IPv4', address: '170.64.1.2', internal: false }] } }), { ip: '170.64.1.2', how: 'network card' });
});
