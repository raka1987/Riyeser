// Relay 1.1.0 (Link Office 1.3.1): changing or removing a relay PC, and the checks for Link Office's checklist.
//   - a relay with its own key takes the cluster's keys from relay_sync; when a relay is removed the keys change:
//     the relays that stay drop it at once, and keys copied from it no longer work
//   - removed from Riyeser (RELAY_REMOVED): it stops serving, and says so in /health
//   - ports tested from outside: another relay of the cluster connects back to our listed public address
//   - /check (only from this PC), the echo for Link Office's test call (rate-limited), the router port forwarding it
//     noted removed by the uninstaller, relay_leave signed with its own key, no web name (phones use the address)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers');
const tokens = require('../lib/tokens');
const ws = require('../lib/ws');
const { PortMapper, removeSaved } = require('../lib/portmap');
const { CloudSync } = require('../lib/cloud');
const { Ddns } = require('../lib/ddns');
const { cli } = require('../server');

const hex = (b) => Buffer.from(b).toString('hex');
const get = (url, headers = {}) => new Promise((res, rej) => { (url.startsWith('https') ? https : http).get(url, { headers, rejectUnauthorized: false }, (x) => { let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => res({ status: x.statusCode, body: b })); }).on('error', rej); });
const post = (url, headers = {}) => new Promise((res, rej) => { const r = http.request(url, { method: 'POST', headers }, (x) => { let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => res({ status: x.statusCode, body: b })); }); r.on('error', rej); r.end(); });
const peersOf = (s) => [...s.relay.conns.values()].filter((c) => c.kind === 'peer').map((c) => c.peer);

test('a relay with its own key: no keys until it syncs, then the cluster keys from Riyeser online', async () => {
  const k = tokens.keys(H.SECRET);
  const r = await H.makeRelay({ id: 'r1a2b3c4', secret: 'ab'.repeat(32), p: H.plan({ businesses: [] }) });
  try {
    await assert.rejects(ws.connect(r.url, { headers: { Authorization: `Bearer ${H.pass({ relay: 'r1a2b3c4' })}` } }), (e) => e.status === 401);
    await r.fakeCloud.push({ ...H.plan(), keys: { epoch: 1, office: hex(k.office), device: hex(k.device), peer: hex(k.peer), turn: k.turn } });
    const c = await ws.connect(r.url, { headers: { Authorization: `Bearer ${H.pass({ relay: 'r1a2b3c4' })}` } }); c.close();
    assert.equal(r.turn.secret, k.turn, 'TURN uses the cluster key too');
    // keys that aren't keys are ignored
    await r.fakeCloud.push({ ...H.plan(), keys: { epoch: 9, office: 'nope', device: hex(k.device), peer: hex(k.peer), turn: k.turn } });
    assert.equal(r.keyEpoch, 1);
  } finally { await r.close(); }
});

test('removing a relay: the others take the new keys and drop it straight away; its old keys and passes stop working', async () => {
  const k2 = tokens.keys('a-new-cluster-secret-0123456789abcdef0123456789');
  const a = await H.makeRelay({ id: 'syd1' });
  const b = await H.makeRelay({ id: 'mel1', region: 'Melbourne' });
  try {
    await a.fakeCloud.push(H.plan({ relays: [{ id: 'mel1', url: `ws://127.0.0.1:${b.ports.http}/relay/v1`, ip: '127.0.0.1' }] }));
    await H.until(() => peersOf(a).includes('mel1') && peersOf(b).includes('syd1'), 8000);
    const t0 = Date.now();
    await a.fakeCloud.push({ ...H.plan({ relays: [] }), keys: { epoch: 2, office: hex(k2.office), device: hex(k2.device), peer: hex(k2.peer), turn: k2.turn } });
    await H.until(() => !peersOf(a).includes('mel1'), 3000);
    assert.ok(Date.now() - t0 < 3000, 'at the first sync after the removal (every 30 s)');
    await assert.rejects(ws.connect(`ws://127.0.0.1:${a.ports.http}/relay/v1`, { headers: { Authorization: `Peer ${tokens.peerAuth(tokens.keys(H.SECRET).peer, 'mel1')}` } }), (e) => e.status === 401, 'its peer key no longer works');
    await assert.rejects(ws.connect(a.url, { headers: { Authorization: `Bearer ${H.pass()}` } }), (e) => e.status === 401 && e.body.code === 'token', 'passes it could make no longer work');
    const fresh = tokens.sign(k2.office, { v: 1, r: 'syd1', ws: H.WS_A, o: 'lo-suva-0001', g: 1, exp: Math.floor(Date.now() / 1000) + 600 });
    (await ws.connect(a.url, { headers: { Authorization: `Bearer ${fresh}` } })).close();
    // the removed relay hears it at its next sync: it stops serving its sites and says so
    const site = await new H.FakeSite('Nadi').connect(b.url, H.pass({ office: 'lo-nadi-0002', relay: 'mel1' }));
    b.fakeCloud.removed();
    await site.wait(() => site.closed);
    assert.ok(site.jsons.some((j) => j.t === 'bye' && /removed/.test(j.reason)), 'the site is told why (it moves to the next relay)');
    await assert.rejects(ws.connect(b.url, { headers: { Authorization: `Bearer ${H.pass({ office: 'lo-nadi-0002', relay: 'mel1' })}` } }), (e) => e.status === 403 && e.body.code === 'removed');
    assert.equal(JSON.parse((await get(`http://127.0.0.1:${b.ports.http}/health`)).body).removed, true);
  } finally { await a.close(); await b.close(); }
});

test('ports from outside: the other relay tests our listed public address; /check works only from this PC', async () => {
  const a = await H.makeRelay({ id: 'syd1' });
  const b = await H.makeRelay({ id: 'mel1', region: 'Melbourne' });
  try {
    const none = await a.outsideCheck();
    assert.equal(none.ok, null); assert.match(none.error, /No other relay is connected/);
    await a.fakeCloud.push(H.plan({ relays: [{ id: 'mel1', url: `ws://127.0.0.1:${b.ports.http}/relay/v1`, ip: '127.0.0.1' }] }));
    await b.fakeCloud.push(H.plan({ relays: [{ id: 'syd1', url: `ws://127.0.0.1:${a.ports.http}/relay/v1`, ip: '127.0.0.1' }] }));
    await H.until(() => peersOf(a).includes('mel1'), 8000);
    const o = JSON.parse((await post(`http://127.0.0.1:${a.ports.http}/check/outside`)).body);
    assert.equal(o.ok, true, JSON.stringify(o)); assert.equal(o.via, 'mel1');
    assert.deepEqual(o.results.map((x) => `${x.port}/${x.proto}`).sort(), [`${a.ports.https}/tcp`, `${a.ports.sipTls}/tcp`, `${a.ports.turn}/tcp`, `${a.ports.turn}/udp`, `${a.ports.probe}/udp`].sort());
    // a port that's closed shows as closed
    a.ports.sipTls = 9; const o2 = await a.outsideCheck(); assert.equal(o2.ok, false); assert.deepEqual(o2.results.filter((x) => !x.open).map((x) => x.port), [9]);
    // a peer only ever tests the address Riyeser online lists for the asker
    await b.fakeCloud.push(H.plan({ relays: [{ id: 'syd1', url: `ws://127.0.0.1:${a.ports.http}/relay/v1` }] }));
    const o3 = await a.outsideCheck(); assert.equal(o3.ok, null); assert.match(o3.error, /didn't answer|address/);
    const c = JSON.parse((await get(`http://127.0.0.1:${a.ports.http}/check`)).body);
    assert.equal(c.relay, 'syd1'); assert.ok(Array.isArray(c.log)); assert.ok(c.outside);
    assert.equal((await get(`http://127.0.0.1:${a.ports.http}/check`, { 'X-Forwarded-For': '203.0.113.5' })).status, 404, 'not through a proxy');
    assert.equal((await get(`https://127.0.0.1:${a.ports.https}/check`)).status, 404, 'never on the internet-facing HTTPS port');
  } finally { await a.close(); await b.close(); }
});

test('the echo for Link Office\'s test call: packets come straight back, at most 64 a second from one address', async () => {
  const r = await H.makeRelay();
  const s = dgram.createSocket('udp4'); let back = 0;
  s.on('message', (m) => { if (m.slice(0, 8).toString() === 'RYECHO1 ') back++; });
  await new Promise((res) => s.bind(0, '127.0.0.1', res));
  try {
    const pkt = Buffer.concat([Buffer.from('RYECHO1 '), Buffer.alloc(180, 7)]);
    for (let i = 0; i < 100; i++) s.send(pkt, r.ports.probe, '127.0.0.1');
    await H.wait(300);
    assert.ok(back >= 30 && back <= 64, `echoed ${back}`);
    back = 0; s.send(Buffer.concat([Buffer.from('RYECHO1 '), Buffer.alloc(400)]), r.ports.probe, '127.0.0.1'); await H.wait(1100);
    s.send(Buffer.concat([Buffer.from('RYECHO1 '), Buffer.alloc(400)]), r.ports.probe, '127.0.0.1'); await H.wait(200);
    assert.equal(back, 0, 'nothing bigger than a call\'s packet');
  } finally { s.close(); await r.close(); }
});

test('router port forwarding noted and removed by the uninstaller; relay_leave signed with its own key', async () => {
  const router = dgram.createSocket('udp4'); const got = [];
  router.on('message', (m, rr) => {
    if (m.length === 2) { const b = Buffer.alloc(12); b[1] = 128; router.send(b, rr.port, rr.address); return; }
    got.push([m[1], m.readUInt16BE(4), m.readUInt32BE(8)]); const b = Buffer.alloc(16); b[1] = m[1] | 128; router.send(b, rr.port, rr.address);
  });
  await new Promise((res) => router.bind(0, '127.0.0.1', res));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-pm-')); const file = path.join(dir, 'portmaps.json');
  try {
    const pm = new PortMapper({ ports: [{ proto: 'tcp', port: 443 }, { proto: 'udp', port: 3478 }], gw: '127.0.0.1', pmpPort: router.address().port, saveFile: file });
    await pm.map(); clearInterval(pm.timer);
    assert.ok(fs.existsSync(file));
    got.length = 0;
    assert.deepEqual(await cli(['--remove-port-mappings'], { portMapFile: file }), { removed: 2, failed: 0, method: 'NAT-PMP' });
    assert.deepEqual(got, [[2, 443, 0], [1, 3478, 0]]); assert.equal(fs.existsSync(file), false);
    assert.deepEqual(await removeSaved(file), { removed: 0, failed: 0, method: null });
  } finally { router.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  let body = null;
  const c = new CloudSync({ url: 'https://x.supabase.co', key: 'pk', relayId: 'r1', secret: 'ab'.repeat(32), fetch: async (u, o) => { body = { u, ...JSON.parse(o.body) }; return { ok: true, status: 200, json: async () => ({ removed: true, rotated: true }) }; } });
  assert.deepEqual(await c.leave(), { removed: true, rotated: true });
  assert.equal(body.u, 'https://x.supabase.co/rest/v1/rpc/relay_leave');
  assert.equal(body.sig, tokens.syncSig('ab'.repeat(32), 'r1', body.ts), 'signed like relay_sync');
});

test('no web name (a PC in an office): phones are given the relay\'s address; Cloudflare dynamic DNS by the domain\'s name, never proxied', async () => {
  const r = await H.makeRelay({ dns: false });
  try {
    const code = tokens.sign(tokens.keys(H.SECRET).device, { v: 1, u: 'rhome00001', n: 'nodns1', exp: Math.floor(Date.now() / 1000) + 900 });
    const x = await get(`http://127.0.0.1:${r.ports.http}/prov/${code}`);
    assert.equal(x.status, 200); assert.match(x.body, /reg_proxy">&lt;sip:127\.0\.0\.1:/); assert.doesNotMatch(x.body, /syd1\.relay\.test/);
    const h = JSON.parse((await get(`http://127.0.0.1:${r.ports.http}/health`)).body);
    assert.equal(h.dns_name, null); assert.equal(h.public_ip, '127.0.0.1');
  } finally { await r.close(); }
  const calls = [];
  const d = new Ddns({ provider: 'cloudflare', token: 't'.repeat(40), zone: 'riyeser.com', name: 'relay.riyeser.com',
    fetch: async (u, o = {}) => { calls.push([o.method || 'GET', u, o.body && JSON.parse(o.body)]); return { ok: true, status: 200, json: async () => (/zones\?name/.test(u) ? { result: [{ id: 'f'.repeat(32) }] } : /dns_records\?/.test(u) ? { result: [] } : { result: {} }) }; } });
  assert.equal(await d.update('203.0.113.9'), true);
  assert.match(calls[0][1], /\/zones\?name=riyeser\.com$/); assert.equal(calls[2][0], 'POST'); assert.equal(calls[2][2].proxied, false);
});
