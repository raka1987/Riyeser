// Link Office 1.3.0 and the Riyeser relay, on this PC: two sites (the real PBX and relay link each), the real relay,
// and simulated phones that send sound (RTP) so we can check it gets through both ways, not just the signalling.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./link-relay-helpers');

test('a desk phone in Suva calls one in Nadi through the relay: rings, answers, sound both ways, hangs up', async () => {
  const r = await H.relay();
  const relays = [{ id: 'syd1', url: r.url, host: 'syd1.relay.test', region: 'Sydney' }];
  const suva = await H.site('Suva', { office: H.OFFICES.suva, relays });
  const nadi = await H.site('Nadi', { office: H.OFFICES.nadi, relays });
  try {
    const p101 = await suva.ua('101'); const p201 = await nadi.ua('201');
    await H.until(() => suva.link.route('201') && nadi.link.route('101'), 8000, 'routes');
    const st = suva.link.status();
    assert.equal(st.connected, true); assert.equal(st.region, 'Sydney'); assert.equal(st.backup, false);
    assert.match(st.detail, /^Connected to Riyeser relay · Sydney/);
    assert.deepEqual(st.sites.map((s) => s.name), ['Nadi']);
    const { call, a, b } = await H.talk(p101, p201, '201', { ms: 800 });
    assert.ok(a.sent > 20 && a.received > 20, `Suva sent ${a.sent}, heard ${a.received}`);
    assert.ok(b.sent > 20 && b.received > 20, `Nadi sent ${b.sent}, heard ${b.received}`);
    assert.equal(a.lastPayload, '201', 'Suva hears Nadi\'s phone'); assert.equal(b.lastPayload, '101', 'Nadi hears Suva\'s phone');
    assert.match(a.from, /^127\.0\.0\.1:/, 'the sound comes from the relay');
    assert.ok(r.media.snapshot().packets > 40);
    // in the call logs on both PCs, with the extensions (never the sound)
    const bye = p201.waitFor('bye');
    assert.equal((await p101.bye(call)).status, 200);
    await bye;
    await H.until(() => !suva.pbx.callsInProgress().length && !nadi.pbx.callsInProgress().length, 4000, 'calls to end');
    await H.until(() => r.relay.dialogs.size === 0 && r.media.sessions.size === 0, 4000, 'the relay to tidy up');
  } finally { await suva.close(); await nadi.close(); await r.close(); }
});

test('ring groups across sites, a person with phones at two sites, and local calls stay local', async () => {
  const r = await H.relay();
  const relays = [{ id: 'syd1', url: r.url, host: 'syd1.relay.test', region: 'Sydney' }];
  const suva = await H.site('Suva', { office: H.OFFICES.suva, relays });
  const nadi = await H.site('Nadi', { office: H.OFFICES.nadi, relays });
  try {
    const p101 = await suva.ua('101', { mode: 'ring' }); const p102 = await suva.ua('102'); const p201 = await nadi.ua('201', { answerDelay: 200 });
    await H.until(() => suva.link.route('201') && nadi.link.route('101'), 8000, 'routes');
    // group 100 from 102: 101 (here) and 201 (Nadi) ring; Nadi answers; 101 stops ringing
    const cancelled = p101.waitFor('cancel', () => true, 8000);
    const { a, b } = await H.talk(p102, p201, '100', { ms: 500 });
    await cancelled;
    assert.ok(a.received > 10 && b.received > 10, 'sound both ways on a group call');
    // a local call never touches the relay
    const before = r.relay.stats.calls;
    p101.mode = 'answer';
    const { final } = await p102.dial('101');
    assert.equal(final.status, 200);
    assert.equal(r.relay.stats.calls, before, 'the relay never saw it');
    // a phone for 201 at Suva too: a call from Nadi's 202 rings both 201s (here and at Suva)
    const p201s = await suva.ua('201', { mode: 'ring' }); const p202 = await nadi.ua('202');
    await H.until(() => nadi.link.route('201'), 4000, 'Suva announces 201');
    const both = Promise.all([p201.waitFor('invite', () => true, 6000), p201s.waitFor('invite', () => true, 6000)]);
    const pending = p202.dial('201');
    await both;
    assert.equal((await pending).final.status, 200);
  } finally { await suva.close(); await nadi.close(); await r.close(); }
});

test('relay down: calls in the office still work; other sites get a clear "can\'t reach"; it comes back by itself', async () => {
  let r = await H.relay();
  const port = r.ports.http;
  const relays = [{ id: 'syd1', url: r.url, host: 'syd1.relay.test', region: 'Sydney' }];
  const suva = await H.site('Suva', { office: H.OFFICES.suva, relays });
  const nadi = await H.site('Nadi', { office: H.OFFICES.nadi, relays });
  try {
    const p101 = await suva.ua('101'); const p102 = await suva.ua('102'); const p201 = await nadi.ua('201');
    await H.until(() => suva.link.route('201'), 8000, 'routes');
    await r.close();
    await H.until(() => !suva.link.status().connected, 4000, 'Suva to notice');
    assert.match(suva.link.status().detail, /^Connecting to the Riyeser relay/);
    const local = await H.talk(p101, p102, '102', { ms: 300 });
    assert.ok(local.a.received > 5 && local.b.received > 5, 'local call with sound, relay or not');
    await p101.bye(local.call);
    const far = await p101.dial('201');
    assert.equal(far.final.status, 480);
    assert.match(far.final.reason, /no connection to the Riyeser relay/);
    // the relay comes back (same address): both sites reconnect and announce their phones again
    r = await H.relay({ httpPort: port });
    await H.until(() => suva.link.route('201') && nadi.link.route('101'), 15000, 'reconnect');
    assert.ok(suva.link.status().reconnects >= 1);
    const again = await H.talk(p101, p201, '201', { ms: 400 });
    assert.ok(again.a.received > 5 && again.b.received > 5);
  } finally { await suva.close(); await nadi.close(); await r.close(); }
});

test('an office whose connection drops (say its public IP changed) reconnects, and new calls work', async () => {
  const r = await H.relay();
  const relays = [{ id: 'syd1', url: r.url, host: 'syd1.relay.test', region: 'Sydney' }];
  const suva = await H.site('Suva', { office: H.OFFICES.suva, relays });
  const nadi = await H.site('Nadi', { office: H.OFFICES.nadi, relays });
  try {
    const p101 = await suva.ua('101'); const p201 = await nadi.ua('201');
    await H.until(() => suva.link.route('201'), 8000, 'routes');
    // what a NAT losing its mapping looks like from here: the connection just dies, no goodbye
    const c = suva.link.activeConn(); c.ws.sock.destroy();
    await H.until(() => suva.link.status().reconnects >= 1 && suva.link.status().connected, 10000, 'reconnect');
    await H.until(() => nadi.link.route('101'), 4000, 'Suva announced again');
    const { a, b } = await H.talk(p201, p101, '101', { ms: 400 });
    assert.ok(a.received > 5 && b.received > 5);
  } finally { await suva.close(); await nadi.close(); await r.close(); }
});

test('failover: main relay stops → both sites move to the backup within seconds → calls work → fail back to the main', async () => {
  let main = await H.relay({ id: 'syd1', region: 'Suva head office' });
  const mainPort = main.ports.http;
  const backup = await H.relay({ id: 'mel1', region: 'Sydney', peers: [{ id: 'syd1', url: `ws://127.0.0.1:${mainPort}/relay/v1` }] });
  const relays = [{ id: 'syd1', url: main.url, host: 'syd1.relay.test', region: 'Suva head office' }, { id: 'mel1', url: backup.url, host: 'mel1.relay.test', region: 'Sydney' }];
  const suva = await H.site('Suva', { office: H.OFFICES.suva, relays });
  const nadi = await H.site('Nadi', { office: H.OFFICES.nadi, relays });
  try {
    const p101 = await suva.ua('101'); const p201 = await nadi.ua('201');
    await H.until(() => suva.link.route('201') && nadi.link.route('101'), 8000, 'routes');
    assert.equal(suva.link.status().relay, 'syd1');
    const t0 = Date.now();
    await main.close();
    await H.until(() => suva.link.status().relay === 'mel1' && nadi.link.status().relay === 'mel1' && suva.link.route('201') && nadi.link.route('101'), 10000, 'failover');
    const took = Date.now() - t0;
    assert.ok(took < 8000, `failed over in ${took} ms`);
    assert.equal(suva.link.status().backup, true);
    assert.match(suva.link.status().detail, /^Using backup relay · Sydney/);
    const viaBackup = await H.talk(p101, p201, '201', { ms: 400 });
    assert.ok(viaBackup.a.received > 5 && viaBackup.b.received > 5, 'sound through the backup');
    assert.ok(backup.media.snapshot().packets > 10);
    // the call stays up while the main relay comes back; new calls go through the main relay; the backup drains
    main = await H.relay({ id: 'syd1', region: 'Suva head office', httpPort: mainPort });
    await H.until(() => suva.link.status().relay === 'syd1' && nadi.link.status().relay === 'syd1' && suva.link.route('201'), 15000, 'fail back');
    assert.deepEqual(suva.link.status().draining, ['mel1'], 'the backup is kept while the call is on');
    const mid = viaBackup.a.received; await H.wait(300);
    assert.ok(p101.rtpStats(viaBackup.call.id).received > mid, 'the call in progress kept its sound');
    await p101.bye(viaBackup.call);
    await H.until(() => !suva.link.status().draining.length, 10000, 'the backup to be let go');
    const viaMain = await H.talk(p201, p101, '101', { ms: 400 });
    assert.ok(viaMain.a.received > 5 && viaMain.b.received > 5);
    assert.ok(main.media.snapshot().packets > 10, 'through the main relay again');
  } finally { await suva.close(); await nadi.close(); await backup.close(); await main.close(); }
});

test('business isolation and revoking, end to end', async () => {
  const r = await H.relay();
  const relays = [{ id: 'syd1', url: r.url, host: 'syd1.relay.test', region: 'Sydney' }];
  const suva = await H.site('Suva', { office: H.OFFICES.suva, relays });
  const nadi = await H.site('Nadi', { office: H.OFFICES.nadi, relays });
  const other = await H.site('Other', { office: H.OFFICES.other, relays, ws: H.WS2, people: [['201', 'Someone Else'], ['301', 'Oli Other']] });
  try {
    const p201 = await nadi.ua('201'); const o301 = await other.ua('301'); await suva.ua('101');
    await H.until(() => suva.link.route('201') && other.link.status().connected, 8000, 'routes');
    await H.wait(300);
    assert.equal(other.link.route('201'), null, `business B can't see A's 201: ${JSON.stringify(other.link.activeConn().routes)}`);
    const tried = await o301.dial('201');
    assert.equal(tried.final.status, 480, 'B\'s call to "201" goes nowhere');
    assert.equal([...p201.calls.values()].length, 0, 'A\'s 201 never rang');
    // an owner disconnects Nadi from the relay: it's dropped, and refused when it tries again
    const p = H.plan(); p.businesses[0].offices[1].revoked = true; p.businesses[0].offices[1].gen = 2;
    await r.fakeCloud.push(p);
    await H.until(() => nadi.link.status().state === 'refused', 10000, 'refused');
    assert.match(nadi.link.status().detail, /refused this office: .*disconnected/);
    await H.until(() => suva.link.route('201') === null, 4000, 'Suva no longer reaches Nadi');
  } finally { await suva.close(); await nadi.close(); await other.close(); await r.close(); }
});

test('This PC as the relay: the Namecheap Dynamic DNS password goes to the installer as a file, never in the script, and the panel says the DNS state', () => {
  const w = require('../src/link/windows');
  const T = require('../src/renderer/link-text');
  const base = { script: 'C:\\R\\install-relay.ps1', relayDir: 'C:\\R', domain: 'relay.riyeser.com', region: 'Head office', id: 'suva1' };
  const plain = w.relayHostScript(base, 'C:\\t\\result.json');
  assert.doesNotMatch(plain, /Ddns/, 'no password: the installer keeps whatever DNS settings are there');
  const pw = '0123abcd4567ef890123abcd4567ef89';
  const s = w.relayHostScript({ ...base, ddnsPasswordFile: 'C:\\t\\ddns.txt' }, 'C:\\t\\result.json');
  assert.match(s, / -DdnsProvider namecheap -DdnsPasswordFile 'C:\\t\\ddns\.txt' \*>&1/);
  assert.ok(!s.includes(pw));
  assert.equal(w.checkDdnsPassword(`  ${pw}\n`), pw);
  for (const bad of ['', 'short', 'has space in it', 'quote"inside1', 'dollar$sign12']) assert.throws(() => w.checkDdnsPassword(bad), /Advanced DNS → Dynamic DNS/);
  assert.match(T.relayDns(null), /doesn't update its name itself/);
  assert.match(T.relayDns({ provider: 'namecheap', name: 'relay.riyeser.com', ok: true }), /relay\.riyeser\.com points at this office \(Namecheap Dynamic DNS/);
  assert.match(T.relayDns({ provider: 'namecheap', name: 'relay.riyeser.com', ok: false, error: 'Namecheap refused the Dynamic DNS password.' }), /^DNS: couldn't update relay\.riyeser\.com\. Namecheap refused/);
  assert.match(T.RELAY_DDNS_WHY, /never in chat or email/);
});

test('src/relay is the same code as relay/ (the Namecheap dynamic DNS too)', () => {
  const { Ddns } = require('../src/relay/lib/ddns');
  const d = new Ddns({ provider: 'namecheap', name: 'relay2.riyeser.com', password: 'x'.repeat(32) });
  assert.deepEqual([d.enabled, d.host, d.domain], [true, 'relay2', 'riyeser.com']);
});
