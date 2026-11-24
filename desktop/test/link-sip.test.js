// Riyeser Link Office: the SIP server, driven by simulated phones over UDP on this PC.
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const sip = require('../src/link/sip');
const { setup, wait, until } = require('./link-helpers');

test('a phone registers with the right password and is refused with the wrong one', async () => {
  const env = await setup();
  try {
    const a = await env.ua('101');
    const ok = await a.register();
    assert.strictEqual(ok.status, 200);
    assert.match(sip.getHeader(ok, 'contact'), /expires=\d+/);
    assert.strictEqual(env.pbx.contactsOf('101').length, 1);
    const bad = await (await env.ua('102')).register({ password: 'not-the-password' });
    assert.strictEqual(bad.status, 403);
    assert.strictEqual(env.pbx.contactsOf('102').length, 0);
    // a made-up extension is refused too
    const ghost = await (await env.ua('555', { password: 'whatever' })).register();
    assert.strictEqual(ghost.status, 403);
    // unregister
    assert.strictEqual((await a.register({ expires: 0 })).status, 200);
    assert.strictEqual(env.pbx.contactsOf('101').length, 0);
  } finally { await env.close(); }
});

test('A calls B: rings (180), answered (200), ACK reaches B, hang up (BYE), and it is in recent calls', async () => {
  const env = await setup();
  const ended = [];
  env.pbx.on('call-ended', (c) => ended.push(c));
  try {
    const a = await env.ua('101'); const b = await env.ua('102');
    await a.register(); await b.register();
    const gotAck = b.waitFor('ack');
    const { call, final } = await a.dial('102');
    assert.strictEqual(final.status, 200);
    assert.ok(call.provisional.includes(180));
    assert.match(sip.getHeader(final, 'record-route'), /127\.0\.0\.1/);
    assert.match(call.remoteSdp, /m=audio 41000/, 'SDP passes through unchanged');
    await gotAck;
    assert.strictEqual(env.pbx.snapshot().calls[0].state, 'talking');
    const gotBye = b.waitFor('bye');
    assert.strictEqual((await a.bye(call)).status, 200);
    await gotBye;
    await until(() => ended.length === 1);
    assert.strictEqual(ended[0].result, 'answered');
    assert.strictEqual(ended[0].from, '101'); assert.strictEqual(ended[0].to, '102');
    assert.strictEqual(ended[0].fromName, 'Alex Sample');
  } finally { await env.close(); }
});

test('B busy gives 486; B not connected gives 480; an unknown number gives 404', async () => {
  const env = await setup();
  try {
    const a = await env.ua('101'); const b = await env.ua('102', { mode: 'busy' });
    await a.register(); await b.register();
    assert.strictEqual((await a.dial('102')).final.status, 486);
    const na = (await a.dial('103')).final;
    assert.strictEqual(na.status, 480);
    const nf = (await a.dial('555')).final;
    assert.strictEqual(nf.status, 404);
    assert.match(nf.reason, /No one has extension 555/);
    const outside = (await a.dial('0412345678')).final;
    assert.strictEqual(outside.status, 404);
    assert.match(outside.reason, /Internal calls only/);
    const emergency = (await a.dial('000')).final;
    assert.match(emergency.reason, /No emergency calls/);
  } finally { await env.close(); }
});

test('the caller hangs up while it rings (CANCEL): 487, and the phone stops ringing', async () => {
  const env = await setup();
  try {
    const a = await env.ua('101'); const b = await env.ua('102', { mode: 'ring' });
    await a.register(); await b.register();
    const p = a.dial('102');
    await b.waitFor('invite');
    await wait(50);
    const gotCancel = b.waitFor('cancel');
    a.cancel([...a.calls.values()].pop());
    await gotCancel;
    assert.strictEqual((await p).final.status, 487);
  } finally { await env.close(); }
});

test('ring group: every phone rings, the first to answer gets the call, the others are cancelled', async () => {
  const env = await setup();
  try {
    const a = await env.ua('101'); const b = await env.ua('102', { mode: 'ring' }); const c = await env.ua('103', { mode: 'ring' });
    await a.register(); await b.register(); await c.register();
    const p = a.dial('200');
    const [ib, ic] = await Promise.all([b.waitFor('invite'), c.waitFor('invite')]);
    assert.ok(ib && ic);
    await wait(50);
    const bCancelled = b.waitFor('cancel');
    c.answer(sip.getHeader(ic, 'call-id'));
    const { final } = await p;
    assert.strictEqual(final.status, 200);
    await bCancelled;
    await until(() => env.pbx.snapshot().calls.some((x) => x.answeredBy === '103'));
  } finally { await env.close(); }
});

test('Do not disturb: *78 turns it on (callers hear busy), *79 turns it off', async () => {
  const env = await setup();
  try {
    const a = await env.ua('101'); const b = await env.ua('102');
    await a.register(); await b.register();
    const on = (await b.dial('*78')).final;
    assert.strictEqual(on.status, 603); assert.match(on.reason, /Do Not Disturb On/);
    assert.strictEqual(env.directory.dnd('102'), true);
    const busy = (await a.dial('102')).final;
    assert.strictEqual(busy.status, 486); assert.match(busy.reason, /Do Not Disturb/);
    assert.strictEqual((await b.dial('*79')).final.status, 603);
    assert.strictEqual(env.directory.dnd('102'), false);
    assert.strictEqual((await a.dial('102')).final.status, 200);
  } finally { await env.close(); }
});

test('hold (re-INVITE) and transfer (REFER) pass through to the other phone', async () => {
  const env = await setup();
  try {
    const a = await env.ua('101'); const b = await env.ua('102');
    await a.register(); await b.register();
    const { call } = await a.dial('102');
    await b.waitFor('ack');
    const re = b.waitFor('reinvite');
    const res = await a.hold(call);
    assert.strictEqual(res.status, 200);
    assert.match((await re).body.toString(), /a=sendonly/);
    const ref = b.waitFor('refer');
    assert.strictEqual((await a.refer(call, '103')).status, 202);
    assert.match(sip.getHeader(await ref, 'refer-to'), /sip:103@/);
    // and the one called can hang up too
    const bcall = [...b.calls.values()].pop();
    const gotBye = a.waitFor('bye');
    assert.strictEqual((await b.bye(bcall)).status, 200);
    await gotBye;
  } finally { await env.close(); }
});

test('an address that keeps getting the password wrong is blocked', async () => {
  const env = await setup({ maxFailures: 3 });
  try {
    const x = await env.ua('101', { password: 'guessing' });
    for (let i = 0; i < 3; i++) assert.strictEqual((await x.register()).status, 403);
    assert.ok(env.pbx.snapshot().blocked.some((b) => b.ip === '127.0.0.1'));
    // blocked: no answer at all now, even with the right password
    const good = await env.ua('101');
    await assert.rejects(good.register(), /no answer/);
  } finally { await env.close(); }
});

test('a REGISTER from outside the office network (a public address) is refused', async () => {
  const env = await setup();
  try {
    const sent = [];
    env.pbx._send = (buf, dest) => sent.push({ msg: sip.parse(buf), dest });
    const reg = ['REGISTER sip:127.0.0.1 SIP/2.0', 'Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bKpub1;rport', 'From: <sip:101@127.0.0.1>;tag=1',
      'To: <sip:101@127.0.0.1>', 'Call-ID: pub1', 'CSeq: 1 REGISTER', 'Contact: <sip:101@203.0.113.9>', 'Content-Length: 0', '', ''].join('\r\n');
    env.pbx.receive(Buffer.from(reg), { proto: 'UDP', address: '203.0.113.9', port: 5060 });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].msg.status, 403);
    assert.match(sent[0].msg.reason, /office network only/);
    assert.strictEqual(env.pbx.contactsOf('101').length, 0);
  } finally { await env.close(); }
});

test('desk-phone plug-and-play: SUBSCRIBE ua-profile gets 200 and a NOTIFY with the settings address', async () => {
  const found = [];
  const env = await setup({ onPnp: (info) => { found.push(info); return 'http://127.0.0.1:5080/yealink/'; } });
  try {
    const phone = await env.ua('000', {});
    const sub = { method: 'SUBSCRIBE', uri: 'sip:MAC%3a001565aabbcc@224.0.1.75', headers: [['via', phone.via().value], ['max-forwards', '70'],
      ['from', '<sip:MAC%3a001565aabbcc@224.0.1.75>;tag=pnp1'], ['to', '<sip:MAC%3a001565aabbcc@224.0.1.75>'], ['call-id', 'pnp-1'], ['cseq', '1 SUBSCRIBE'],
      ['event', 'ua-profile;profile-type="device";vendor="Yealink";model="T46U";version="108.86.0.20"'], ['expires', '0'], ['accept', 'application/url'],
      ['contact', `<sip:127.0.0.1:${phone.port}>`]], body: Buffer.alloc(0) };
    const notified = phone.waitFor('notify');
    const res = await phone.request(sub);
    assert.strictEqual(res.status, 200);
    const n = await notified;
    assert.strictEqual(sip.getHeader(n, 'content-type'), 'application/url');
    assert.strictEqual(n.body.toString(), 'http://127.0.0.1:5080/yealink/');
    assert.deepStrictEqual({ mac: found[0].mac, vendor: found[0].vendor, model: found[0].model }, { mac: '001565aabbcc', vendor: 'Yealink', model: 'T46U' });
  } finally { await env.close(); }
});

test('malformed SIP is ignored safely, and the server keeps working', async () => {
  const env = await setup();
  try {
    const junk = ['', '\r\n\r\n', 'hello', 'INVITE sip:102@x SIP/2.0\r\n\r\n', 'SIP/2.0 999 Nope\r\n\r\n',
      'INVITE sip:102@x SIP/2.0\r\nVia: SIP/2.0/UDP\r\nFrom: x\r\nTo: y\r\nCall-ID: 1\r\nCSeq: 1 INVITE\r\n\r\n',
      'INVITE sip:102@x SIP/2.0\r\nVia: SIP/2.0/UDP 1.2.3.4\r\nFrom: <sip:a@b>\r\nTo: <sip:c@d>\r\nCall-ID: 1\r\nCSeq: x INVITE\r\n\r\n',
      'OPTIONS sip:x SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:1;branch=z9hG4bKx\r\nFrom: <sip:a@b>;tag=1\r\nTo: <sip:c@d>\r\nCall-ID: 1\r\nCSeq: 1 OPTIONS\r\nContent-Length: 999\r\n\r\nshort',
      Buffer.alloc(70000, 65), Buffer.from([0, 1, 2, 3, 255, 254])];
    const s = dgram.createSocket('udp4');
    await new Promise((r) => s.bind(0, '127.0.0.1', r));
    for (const j of junk) { const b = Buffer.isBuffer(j) ? j : Buffer.from(j); if (b.length < 65000) s.send(b, env.pbx.port, '127.0.0.1'); }
    env.pbx.receive(Buffer.alloc(70000, 65), { proto: 'UDP', address: '127.0.0.1', port: 9 });
    await wait(100);
    s.close();
    assert.ok(env.pbx.stats.malformed >= 6);
    const a = await env.ua('101');
    assert.strictEqual((await a.register()).status, 200);
  } finally { await env.close(); }
});

test('the SIP parser survives random damage (fuzz) and only ever throws its own error', () => {
  const good = Buffer.from(['INVITE sip:102@192.168.1.20:5060 SIP/2.0', 'Via: SIP/2.0/UDP 192.168.1.50:5060;branch=z9hG4bK776asdhds;rport',
    'Max-Forwards: 70', 'To: "Bo" <sip:102@192.168.1.20>', 'From: "Alex" <sip:101@192.168.1.20>;tag=1928301774', 'Call-ID: a84b4c76e66710@pc33',
    'CSeq: 314159 INVITE', 'Contact: <sip:101@192.168.1.50>', 'Content-Type: application/sdp', 'Content-Length: 4', '', 'v=0\n'].join('\r\n'));
  assert.strictEqual(sip.parse(good).method, 'INVITE');
  let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const chars = Buffer.from(':;<>"@=,\r\n \t%\\/0aZ');
  for (let i = 0; i < 3000; i++) {
    const b = Buffer.from(good);
    for (let k = 0, n = 1 + rnd(6); k < n; k++) { const at = rnd(b.length); b[at] = rnd(3) ? chars[rnd(chars.length)] : rnd(256); }
    const cut = rnd(4) === 0 ? b.slice(0, rnd(b.length)) : b;
    try { const m = sip.parse(cut); sip.serialize(m); } catch (e) { assert.ok(e instanceof sip.SipError, `unexpected ${e.name}: ${e.message}`); }
  }
});

test('compact headers, folded lines and comma lists are understood', () => {
  const m = sip.parse(['SIP/2.0 200 OK', 'v: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bKa, SIP/2.0/UDP 10.0.0.2;branch=z9hG4bKb', 'f: <sip:a@b>;tag=1',
    't: <sip:c@d>', '   ;tag=2', 'i: x1', 'CSeq: 2 INVITE', 'Record-Route: <sip:10.0.0.9;lr>, <sip:10.0.0.8;lr>', 'l: 0', '', ''].join('\r\n'));
  assert.strictEqual(sip.getAll(m, 'via').length, 2);
  assert.strictEqual(sip.getAll(m, 'record-route').length, 2);
  assert.strictEqual(sip.parseNameAddr(sip.getHeader(m, 'to')).params.tag, '2');
  assert.strictEqual(sip.getHeader(m, 'call-id'), 'x1');
});

test('SIP over TCP works too (a REGISTER gets its challenge back on the same connection)', async () => {
  const env = await setup({ tcp: true });
  try {
    const net = require('net');
    const s = net.connect(env.pbx.port, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    const reg = ['REGISTER sip:127.0.0.1 SIP/2.0', `Via: SIP/2.0/TCP 127.0.0.1:${s.localPort};branch=z9hG4bKtcp1`, 'From: <sip:101@127.0.0.1>;tag=1',
      'To: <sip:101@127.0.0.1>', 'Call-ID: tcp1', 'CSeq: 1 REGISTER', `Contact: <sip:101@127.0.0.1:${s.localPort};transport=tcp>`, 'Content-Length: 0', '', ''].join('\r\n');
    const got = new Promise((r) => s.once('data', (d) => r(d.toString())));
    s.write('\r\n\r\n' + reg);
    assert.match(await got, /^SIP\/2\.0 401 /);
    s.destroy();
  } finally { await env.close(); }
});
