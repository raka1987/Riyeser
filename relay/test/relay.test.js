// The relay on its own: office passes, sites, a call between two sites with sound both ways, business isolation,
// revoked offices, remote phones over TLS, the other relays of the cluster, set-up links, health and metrics.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const tokens = require('../lib/tokens');
const sip = require('../lib/sip');
const ws = require('../lib/ws');
const { SimUA } = require('./simua');
const H = require('./helpers');

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

test('office passes: signed, checked, expired, tampered; TURN passwords as coturn checks them', () => {
  const k = tokens.keys(H.SECRET);
  const t = tokens.sign(k.office, { v: 1, r: 'syd1', ws: H.WS_A, o: 'lo-suva-0001', g: 1, exp: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(tokens.verify(k.office, t).ok, true);
  assert.equal(tokens.verify(k.office, t).payload.o, 'lo-suva-0001');
  assert.equal(tokens.verify(k.office, t, Date.now() + 61000).why, 'expired');
  const [body, sig] = t.split('.');
  const forged = tokens.b64u(Buffer.from(JSON.stringify({ ...JSON.parse(tokens.unb64u(body)), ws: H.WS_B })));
  assert.equal(tokens.verify(k.office, `${forged}.${sig}`).why, 'signature', 'another business in the pass breaks the signature');
  assert.equal(tokens.verify(tokens.keys('a-different-relay-secret-0123456789abcdef').office, t).why, 'signature');
  const c = tokens.turnCredentials(k.turn, 'user-1', 600);
  assert.equal(tokens.turnCheck(k.turn, c.username, c.credential), true);
  assert.equal(tokens.turnCheck(k.turn, c.username, c.credential, Date.now() + 601000), false, 'expired');
  assert.equal(tokens.turnCheck(k.turn, c.username.replace('user-1', 'user-2'), c.credential), false);
  assert.throws(() => tokens.keys('short'), /32 characters/);
});

test('a pass made by the database (team-chat.sql link_relay_token) is accepted, with the same keys', () => {
  // Made by: select public.relay_sign_test('test-relay-secret-0123456789abcdef0123456789') in rules-test.sql
  const fromSql = 'eyJnIjogMSwgIm8iOiAibG8tc3V2YS0wMDAxIiwgInIiOiAic3lkMSIsICJ2IjogMSwgIndzIjogImFhYWFhYWFhLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsICJleHAiOiA0MTAyNDQ0ODAwfQ.nhcgHsepBLiMXHM75t5YocDIXmtRETfbZyQ9Y3In-eo';
  const v = tokens.verify(tokens.keys(H.SECRET).office, fromSql);
  assert.equal(v.ok, true, v.why);
  assert.deepEqual({ ws: v.payload.ws, o: v.payload.o, g: v.payload.g, r: v.payload.r }, { ws: H.WS_A, o: 'lo-suva-0001', g: 1, r: 'syd1' });
  // and the TURN secret the database uses (link_relay_turn) is coturn's static-auth-secret made by setup.sh
  assert.equal(tokens.keys(H.SECRET).turn, require('crypto').createHmac('sha256', H.SECRET).update('turn').digest('hex'));
});

test('two sites of one business: routes, a call with sound both ways through the relay, hang-up', async () => {
  const r = await H.makeRelay();
  const suva = await new H.FakeSite('Suva').connect(r.url, H.pass());
  const nadi = await new H.FakeSite('Nadi').connect(r.url, H.pass({ office: 'lo-nadi-0002' }));
  try {
    const welcome = suva.jsons.find((j) => j.t === 'welcome');
    assert.equal(welcome.region, 'Sydney'); assert.match(welcome.rr, /rly=syd1/);
    suva.exts(['101', '102']); nadi.exts(['201']);
    await suva.wait(() => (suva.routes() || {}).remote && suva.routes().remote.includes('201'));
    await nadi.wait(() => (nadi.routes() || {}).remote && nadi.routes().remote.includes('101'));
    assert.deepEqual(suva.routes().remote, ['201']);
    assert.equal(suva.routes().sites[0].name, 'Nadi');

    const phoneA = await H.udp(); const phoneB = await H.udp();
    const inv = H.invite({ sdp: H.SDP('192.168.1.20', 4000) });
    suva.send(inv);
    const atNadi = await nadi.waitSip((m) => m.method === 'INVITE');
    assert.equal(atNadi.uri, 'sip:201@syd1.relay.test');
    assert.match(sip.getHeader(atNadi, 'record-route'), /rly=syd1/, 'the relay stays in the call');
    assert.match(sip.getHeader(atNadi, 'p-asserted-identity'), /sip:101@/);
    const offer = H.sdpAddr(atNadi.body);
    assert.equal(offer.ip, '127.0.0.1', 'Nadi is told to send its sound to the relay');
    assert.doesNotMatch(String(atNadi.body), /192\.168\.1\.20|a=candidate|a=rtcp:/, 'Suva\'s private address and ICE lines are gone');
    nadi.send(H.answer(atNadi, 180));
    await suva.waitSip((m) => m.status === 180);
    nadi.send(H.answer(atNadi, 200, { sdp: H.SDP('192.168.1.30', 5000) }));
    const ok = await suva.waitSip((m) => m.status === 200);
    const ans = H.sdpAddr(ok.body);
    assert.equal(ans.ip, '127.0.0.1'); assert.notEqual(ans.port, offer.port);
    // sound: each phone sends to its relay port (that latches its address); then both hear the other
    for (let i = 0; i < 5; i++) { phoneA.send(H.rtp(`AAAA${i}`), ans.port, '127.0.0.1'); phoneB.send(H.rtp(`BBBB${i}`), offer.port, '127.0.0.1'); await H.wait(20); }
    await H.until(() => phoneA.got.length >= 3 && phoneB.got.length >= 3);
    assert.match(phoneA.got.at(-1).m.toString(), /BBBB/, 'Suva hears Nadi');
    assert.match(phoneB.got.at(-1).m.toString(), /AAAA/, 'Nadi hears Suva');
    assert.ok(r.media.snapshot().packets >= 6);
    // a stranger can't take over the call's sound by sending to the port
    const stranger = await H.udp('127.0.0.2');
    stranger.send(H.rtp('EVIL'), ans.port, '127.0.0.1'); await H.wait(50);
    assert.doesNotMatch(phoneB.got.at(-1).m.toString(), /EVIL/);
    stranger.close();
    // hang up from Nadi: the BYE reaches Suva, the 200 comes back
    const toTag = sip.parseNameAddr(sip.getHeader(ok, 'to')).params.tag;
    const bye = { method: 'BYE', uri: 'sip:101@192.168.1.20:5060', headers: [['via', `SIP/2.0/UDP 192.168.1.30:5060;branch=${sip.newBranch()}`], ['max-forwards', '70'],
      ['route', '<sip:syd1.relay.test;lr;rly=syd1>'], ['route', '<sip:192.168.1.10:5060;lr>'], ['from', sip.getHeader(ok, 'to')], ['to', sip.getHeader(inv, 'from')],
      ['call-id', sip.getHeader(inv, 'call-id')], ['cseq', '1 BYE']], body: Buffer.alloc(0) };
    void toTag;
    nadi.send(bye);
    const byeAtSuva = await suva.waitSip((m) => m.method === 'BYE');
    assert.equal(sip.getAll(byeAtSuva, 'route').length, 1, 'the relay took itself off the route');
    suva.send(sip.response(byeAtSuva, 200, null, {}));
    await nadi.waitSip((m) => m.status === 200 && /BYE/.test(sip.getHeader(m, 'cseq')));
    await H.until(() => r.relay.dialogs.size === 0 && r.media.sessions.size === 0);
    phoneA.close(); phoneB.close();
  } finally { suva.close(); nadi.close(); await r.close(); }
});

test('business isolation: another business can\'t reach, see or touch these extensions', async () => {
  const r = await H.makeRelay();
  const suva = await new H.FakeSite('Suva').connect(r.url, H.pass());
  const nadi = await new H.FakeSite('Nadi').connect(r.url, H.pass({ office: 'lo-nadi-0002' }));
  const other = await new H.FakeSite('Other').connect(r.url, H.pass({ ws: H.WS_B, office: 'lo-other-0003' }));
  try {
    suva.exts(['101']); nadi.exts(['201']); other.exts(['301']);
    await other.wait(() => other.routes());
    await H.wait(200);
    assert.deepEqual(other.routes().remote, [], 'business B sees none of A\'s extensions');
    assert.deepEqual(other.routes().sites, []);
    assert.ok(!suva.routes().remote.includes('301'));
    const inv = H.invite({ from: '301', to: '201' });
    other.send(inv);
    const res = await other.waitSip((m) => m.status >= 400);
    assert.equal(res.status, 480, 'A\'s 201 doesn\'t exist for B');
    await H.wait(100);
    assert.equal(nadi.sips.filter((m) => m.method === 'INVITE').length, 0, 'Nadi never heard of it');
    // set up a real call in A, then B tries a BYE with the same Call-ID: refused (calls are kept per business)
    const callId = sip.newCallId('shared');
    suva.send(H.invite({ callId }));
    const atNadi = await nadi.waitSip((m) => m.method === 'INVITE');
    nadi.send(H.answer(atNadi, 200, { sdp: H.SDP('192.168.1.30', 5000) }));
    await suva.waitSip((m) => m.status === 200);
    other.send({ method: 'BYE', uri: 'sip:201@x', headers: [['via', `SIP/2.0/UDP 10.0.0.9;branch=${sip.newBranch()}`], ['max-forwards', '70'], ['from', '<sip:301@x>;tag=a'], ['to', '<sip:201@x>;tag=callee1'], ['call-id', callId], ['cseq', '9 BYE']], body: Buffer.alloc(0) });
    const no = await other.waitSip((m) => /BYE/.test(sip.getHeader(m, 'cseq')));
    assert.equal(no.status, 481);
    await H.wait(100);
    assert.equal(nadi.sips.filter((m) => m.method === 'BYE').length, 0);
    assert.equal(r.relay.dialogs.size, 1, 'A\'s call carries on');
    // and a pass for business B can't be bent to an office of A
    await assert.rejects(new H.FakeSite('x').connect(r.url, H.pass({ ws: H.WS_B, office: 'lo-suva-0001' })), (e) => e.status === 403);
  } finally { suva.close(); nadi.close(); other.close(); await r.close(); }
});

test('passes: wrong, expired, for another relay, revoked (closes the live connection), business switched off', async () => {
  const r = await H.makeRelay();
  try {
    await assert.rejects(new H.FakeSite('x').connect(r.url, 'nonsense.token'), (e) => e.status === 401);
    await assert.rejects(new H.FakeSite('x').connect(r.url, H.pass({ ttl: -5 })), (e) => e.status === 401 && e.body.code === 'expired');
    await assert.rejects(new H.FakeSite('x').connect(r.url, H.pass({ relay: 'mel1' })), (e) => e.status === 403);
    const suva = await new H.FakeSite('Suva').connect(r.url, H.pass());
    const p = H.plan(); p.businesses[0].offices[0].revoked = true; p.businesses[0].offices[0].gen = 2;
    await r.fakeCloud.push(p);
    await suva.wait(() => suva.closed);
    assert.match(suva.jsons.at(-1).reason, /disconnected from the relay/);
    await assert.rejects(new H.FakeSite('x').connect(r.url, H.pass()), (e) => e.status === 403 && /disconnected/.test(e.body.error));
    // allowed again: a new generation, so the old pass stays useless
    p.businesses[0].offices[0].revoked = false; await r.fakeCloud.push(p);
    await assert.rejects(new H.FakeSite('x').connect(r.url, H.pass({ gen: 1 })), (e) => e.status === 403 && /replaced/.test(e.body.error));
    const again = await new H.FakeSite('Suva').connect(r.url, H.pass({ gen: 2 }));
    p.businesses[0].enabled = false; await r.fakeCloud.push(p);
    await again.wait(() => again.closed);
    assert.match(again.jsons.at(-1).reason, /switched the relay off/);
  } finally { await r.close(); }
});

test('rate limits: an address that keeps failing is blocked', async () => {
  const r = await H.makeRelay({ limiter: { perMinute: 100, maxFails: 3 } });
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(new H.FakeSite('x').connect(r.url, 'bad.bad'), (e) => e.status === 401);
    await assert.rejects(new H.FakeSite('x').connect(r.url, H.pass()), (e) => e.status === 429, 'even a good pass waits now');
  } finally { await r.close(); }
});

test('a phone at home over TLS: signs in with its own password, rings from a site, calls a site, sound both ways', async () => {
  const r = await H.makeRelay();
  const suva = await new H.FakeSite('Suva').connect(r.url, H.pass());
  const ca = require('fs').readFileSync(require('path').join(r.dir, 'relay-cert.pem'));
  const home = await new SimUA({ ext: '103', user: 'rhome00001', password: 'home-phone-pass-1', server: { host: '127.0.0.1', port: r.ports.sipTls }, domain: 'syd1.relay.test', tls: { ca, servername: 'syd1.relay.test' }, rtp: true, answerDelay: 50 }).start();
  const wrong = await new SimUA({ ext: '103', user: 'rhome00001', password: 'not-it', server: { host: '127.0.0.1', port: r.ports.sipTls }, domain: 'syd1.relay.test', tls: { ca, servername: 'syd1.relay.test' } }).start();
  try {
    assert.equal((await wrong.register()).status, 403, 'a wrong password is refused');
    assert.equal((await home.register()).status, 200);
    suva.exts(['101']);
    await suva.wait(() => (suva.routes() || {}).remote && suva.routes().remote.includes('103'));
    // Suva calls 103: it rings at home, is answered, sound flows both ways
    const phoneA = await H.udp();
    const inv = H.invite({ to: '103', sdp: H.SDP('192.168.1.20', 4000) });
    suva.send(inv);
    const ok = await suva.waitSip((m) => m.status === 200, 5000);
    const ans = H.sdpAddr(ok.body);
    for (let i = 0; i < 10; i++) { phoneA.send(H.rtp(`SUVA${i}`), ans.port, '127.0.0.1'); await H.wait(20); }
    await H.until(() => home.rtpStats().received >= 5 && phoneA.got.length >= 5);
    assert.match(home.rtpStats().lastPayload, /SUV/);
    assert.equal(phoneA.got.at(-1).m.slice(12, 15).toString(), '103', 'Suva hears the phone at home');
    phoneA.close();
    // the phone at home calls 101 at Suva
    const pending = home.dial('101');
    const atSuva = await suva.waitSip((m) => m.method === 'INVITE' && /101@/.test(m.uri));
    assert.match(sip.getHeader(atSuva, 'p-asserted-identity'), /sip:103@/, 'Suva sees extension 103 calling');
    assert.equal(sip.getHeader(atSuva, 'proxy-authorization'), null, 'the phone\'s credentials stay at the relay');
    suva.send(H.answer(atSuva, 200, { sdp: H.SDP('192.168.1.20', 4002), tag: 's1' }));
    const { final } = await pending;
    assert.equal(final.status, 200);
    // emergency numbers are refused here too
    const em = await home.dial('000');
    assert.equal(em.final.status, 403); assert.match(em.final.reason, /emergency/i);
  } finally { await home.stop(); await wrong.stop(); suva.close(); await r.close(); }
});

test('two relays of the cluster: a site on each can still call the other (failover, split sites)', async () => {
  const a = await H.makeRelay({ id: 'syd1' });
  const b = await H.makeRelay({ id: 'mel1', region: 'Melbourne', peers: [{ id: 'syd1', url: `ws://127.0.0.1:${a.ports.http}/relay/v1` }] });
  const suva = await new H.FakeSite('Suva').connect(a.url, H.pass({ relay: 'syd1' }));
  const nadi = await new H.FakeSite('Nadi').connect(b.url, H.pass({ office: 'lo-nadi-0002', relay: 'mel1' }));
  const other = await new H.FakeSite('Other').connect(b.url, H.pass({ ws: H.WS_B, office: 'lo-other-0003', relay: 'mel1' }));
  try {
    suva.exts(['101']); nadi.exts(['201']); other.exts(['301']);
    await suva.wait(() => (suva.routes() || {}).remote && suva.routes().remote.includes('201'));
    assert.equal(suva.routes().sites[0].via, 'mel1', 'Nadi is reached through the other relay');
    assert.ok(!suva.routes().remote.includes('301'), 'still only this business');
    suva.send(H.invite());
    const atNadi = await nadi.waitSip((m) => m.method === 'INVITE');
    assert.equal(sip.getAll(atNadi, 'record-route').filter((x) => /rly=/.test(x)).length, 2, 'both relays stay in the call');
    nadi.send(H.answer(atNadi, 200, { sdp: H.SDP('192.168.1.30', 5000) }));
    const ok = await suva.waitSip((m) => m.status === 200);
    // sound through both relays
    const pa = await H.udp(); const pb = await H.udp();
    const toA = H.sdpAddr(ok.body); const toB = H.sdpAddr(atNadi.body);
    for (let i = 0; i < 8; i++) { pa.send(H.rtp('FROM-A'), toA.port, '127.0.0.1'); pb.send(H.rtp('FROM-B'), toB.port, '127.0.0.1'); await H.wait(25); }
    await H.until(() => pa.got.length >= 2 && pb.got.length >= 2);
    assert.match(pa.got.at(-1).m.toString(), /FROM-B/); assert.match(pb.got.at(-1).m.toString(), /FROM-A/);
    pa.close(); pb.close();
  } finally { suva.close(); nadi.close(); other.close(); await b.close(); await a.close(); }
});

test('health, metrics (token only), one-time phone set-up link, certificate fingerprint', async () => {
  const r = await H.makeRelay();
  try {
    const h = JSON.parse((await get(`http://127.0.0.1:${r.ports.http}/health`)).body);
    assert.equal(h.ok, true); assert.equal(h.region, 'Sydney');
    assert.equal((await get(`http://127.0.0.1:${r.ports.http}/metrics`)).status, 401);
    const m = await get(`http://127.0.0.1:${r.ports.http}/metrics`, { Authorization: 'Bearer metrics-test-token' });
    assert.match(m.body, /riyeser_relay_sites_connected 0/); assert.match(m.body, /riyeser_relay_media_packets_total/);
    assert.doesNotMatch(m.body, /101|rhome/, 'no numbers or usernames in the metrics');
    const code = tokens.sign(tokens.keys(H.SECRET).device, { v: 1, u: 'rhome00001', n: 'abc123', exp: Math.floor(Date.now() / 1000) + 900 });
    const x = await get(`http://127.0.0.1:${r.ports.http}/prov/${code}`);
    assert.equal(x.status, 200); assert.match(x.body, /<entry name="ha1">[0-9a-f]{32}</); assert.match(x.body, /transport=tls/);
    assert.doesNotMatch(x.body, /home-phone-pass-1/, 'never the password');
    assert.equal((await get(`http://127.0.0.1:${r.ports.http}/prov/${code}`)).status, 410, 'only once');
    const info = r.info();
    assert.match(info.cert.sha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/); assert.equal(info.cert.self_signed, true);
    // Link Office pins that fingerprint over wss: the right one connects, a wrong one is refused before the pass is sent
    const wss = `wss://127.0.0.1:${r.ports.https}/link/v1`;
    const ok = await ws.connect(wss, { headers: { Authorization: `Bearer ${H.pass()}` }, pin: info.cert.sha256 });
    ok.close();
    await assert.rejects(ws.connect(wss, { headers: { Authorization: `Bearer ${H.pass()}` }, pin: 'AA:'.repeat(31) + 'AA' }), (e) => e.code === 'PIN');
    await assert.rejects(ws.connect(wss, { headers: { Authorization: `Bearer ${H.pass()}` } }), /self.signed|certificate/i, 'without the pin a self-signed relay isn\'t trusted');
  } finally { await r.close(); }
});
