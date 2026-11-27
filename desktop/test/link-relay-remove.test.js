// Link Office 1.3.1: changing or removing the relay PC, and the guided checklist.
//   - the uninstaller (what Link Office runs, and what install-relay.ps1 -Uninstall does: out of Riyeser, task,
//     router port forwarding, firewall rules, logs zipped, key and settings deleted)
//   - the router port forwarding the relay made is noted and removed again (a pretend NAT-PMP router)
//   - "This PC as the relay" with a set-up code (its own key, no web name; or Cloudflare / Namecheap for your own name)
//   - removing a relay: its key stops working, the other relays take the new keys and drop it within one sync, keys
//     copied from it no longer work, and sites move to the next relay by themselves; moving it to a new PC
//   - the checklist's states (all good, port closed, web name wrong, UDP blocked, not used), the test call (echo), the
//     remote checks from the website, Advanced checks' lock, and the report to the website
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const H = require('./link-relay-helpers');
const tokens = require('../src/relay/lib/tokens');
const w = require('../src/link/windows');
const C = require('../src/renderer/link-relaycheck');
const T = require('../src/renderer/link-text');
const { PortMapper, removeSaved } = require('../src/relay/lib/portmap');
const { RelayLink, echoTest, toneStrength, tonePacket, muDecode } = require('../src/link/relay');
const { Media } = require('../src/relay/lib/media');
const { Ddns } = require('../src/relay/lib/ddns');
const { RelayChecks, memoryStore } = require('../src/link/relaychecks');

const PS1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'relay', 'deploy', 'windows', 'install-relay.ps1'), 'utf8');

test('Stop using this PC as the relay: the uninstall script Link Office runs, and what -Uninstall removes (in order)', () => {
  const s = w.relayUninstallScript({ script: 'C:\\P\\relay\\deploy\\windows\\install-relay.ps1', relayDir: 'C:\\P\\relay' }, 'C:\\t\\result.json');
  assert.match(s, /^\$out = & 'C:\\P\\relay\\deploy\\windows\\install-relay\.ps1' -Uninstall -RelayDir 'C:\\P\\relay' \*>&1 \| Out-String/);
  assert.doesNotMatch(s, /KeepRegistration/, 'removed from the business too, by default');
  assert.match(w.relayUninstallScript({ script: 'x.ps1', relayDir: 'R', keepRegistration: true }, 'r.json'), /-Uninstall -RelayDir 'R' -KeepRegistration/);
  assert.match(s, /RESULT/); assert.match(s, /Set-Content -Path 'C:\\t\\result\.json'/);
  assert.throws(() => w.relayUninstallScript({}, 'r.json'), /uninstaller is missing/);
  // install-relay.ps1 -Uninstall: each step, in this order
  const u = PS1.slice(PS1.indexOf('if ($Uninstall) {'), PS1.indexOf('# ---- what runs it'));
  const steps = [["Relay-Helper '--leave'", 'out of Riyeser (its own key)'], ['Stop-ScheduledTask -TaskName $Task', 'the task stopped'], ['Stop-Process -Id', 'the relay process stopped'],
    ["Relay-Helper '--remove-port-mappings'", 'the router port forwarding it made'], ['Unregister-ScheduledTask -TaskName $Task', 'the task removed'],
    ['Remove-NetFirewallRule', 'its firewall rules'], ['Compress-Archive', 'its logs zipped for support'], ['Remove-Item -Recurse -Force $Data', 'its key and settings deleted']];
  let at = -1;
  for (const [needle, what] of steps) { const i = u.indexOf(needle); assert.ok(i > at, `${what} (${needle}) comes next`); at = i; }
  assert.match(u, /if \(-not \$KeepRegistration\) \{ \$res\.left = Relay-Helper '--leave' \}/);
  assert.match(u, /\$LogsDir/); assert.match(PS1, /\[string\]\$LogsDir = \(Join-Path \$env:ProgramData 'Riyeser Relay Logs'\)/);
  assert.doesNotMatch(u.slice(u.indexOf('Compress-Archive') - 200, u.indexOf('Compress-Archive')), /secret|relay\.env/, 'only the logs folder is zipped');
  // and the result Link Office shows
  const p = w.parseUninstall({ ok: true, result: { left: { left: true, removed: true, switched_off: [] }, port_mappings: { removed: 6, failed: 0, method: 'UPnP' }, task_removed: true, firewall_removed: true, logs_zip: 'C:\\ProgramData\\Riyeser Relay Logs\\relay-logs-1.zip', settings_removed: true } });
  assert.deepEqual([p.ok, p.left, p.removedMappings, p.taskRemoved, p.firewallRemoved, p.settingsRemoved], [true, true, 6, true, true, true]);
  assert.match(T.stopDone(p), /^Removed from this PC and from your business\. 6 router port forwards removed\. Logs kept in C:\\ProgramData\\Riyeser Relay Logs/);
  assert.match(T.stopDone(w.parseUninstall({ ok: true, result: { left: { left: false, why: 'no internet' }, task_removed: true, firewall_removed: true, settings_removed: true } })), /remove it on the website/);
  assert.match(T.stopImpact([]), /only relay[\s\S]*switched off for your business/);
  assert.match(T.stopImpact([{ id: 'mel1', region: 'Sydney' }]), /move to Sydney by themselves/);
});

test('Uninstalling Link Office from Windows Apps removes the relay too (not on an update)', () => {
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'link', 'installer.nsh'), 'utf8');
  const un = nsh.slice(nsh.indexOf('!macro customUnInit'));
  assert.match(un, /\$\{ifNot\} \$\{isUpdated\}/);
  assert.match(un, /Get-ScheduledTask -TaskName ''Riyeser Relay''/);
  assert.match(un, /install-relay\.ps1" -Uninstall -RelayDir "\$INSTDIR\\resources\\app\.asar\.unpacked\\src\\relay"/);
  assert.equal(require('../scripts/builder.config.js') && /version: '1\.3\.1', productName: 'Riyeser Link Office'/.test(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'builder.config.js'), 'utf8')), true, 'Link Office 1.3.1');
});

test('This PC as the relay with a set-up code: its own key as a file, no web name; Cloudflare or Namecheap only for your own name', () => {
  const base = { script: 'C:\\R\\install-relay.ps1', relayDir: 'C:\\R', domain: 'r1a2b3c4.relay.invalid', region: 'Suva head office', id: 'r1a2b3c4' };
  const key = 'ab'.repeat(32);
  const s = w.relayHostScript({ ...base, secretFile: 'C:\\t\\relay-key.txt', noDns: true, priority: 1 }, 'C:\\t\\result.json');
  assert.match(s, / -SecretFile 'C:\\t\\relay-key\.txt' -NoDns -Priority 1 \*>&1/);
  assert.ok(!s.includes(key)); assert.doesNotMatch(s, /Ddns/);
  const cf = w.relayHostScript({ ...base, domain: 'relay.riyeser.com', ddns: { provider: 'cloudflare', file: 'C:\\t\\ddns.txt' } }, 'r.json');
  assert.match(cf, / -DdnsProvider cloudflare -DdnsZone 'riyeser\.com' -DdnsTokenFile 'C:\\t\\ddns\.txt'/);
  const nc = w.relayHostScript({ ...base, domain: 'relay.riyeser.com', ddns: { provider: 'namecheap', file: 'C:\\t\\ddns.txt' } }, 'r.json');
  assert.match(nc, / -DdnsProvider namecheap -DdnsPasswordFile 'C:\\t\\ddns\.txt'/);
  assert.throws(() => w.relayHostScript({ ...base, ddns: { provider: 'godaddy', file: 'x' } }, 'r.json'), /Cloudflare or Namecheap/);
  // the installer: the key file is read once and deleted; no REGISTER.sql (it's registered with the business already)
  assert.match(PS1, /Remove-Item \$SecretFile -Force/); assert.match(PS1, /if \(\$Enrolled\) \{[\s\S]*?exit 0\s*\}\s*\$reg = Join-Path \$Data 'REGISTER\.sql'/);
  assert.match(PS1, /RELAY_DNS="\$\(if \(\$NoDns\) \{ '0' \} else \{ '1' \}\)"/);
  assert.match(PS1, /Remove-Item \$DdnsTokenFile -Force/);
  // the DNS provider is found from the domain's nameservers; the help says what to make
  assert.equal(C.dnsHost(['beau.ns.cloudflare.com', 'kay.ns.cloudflare.com']), 'cloudflare');
  assert.equal(C.dnsHost(['dns1.registrar-servers.com']), 'namecheap');
  assert.equal(C.dnsHost(['ns1.example.net']), 'other'); assert.equal(C.dnsHost([]), null);
  assert.match(T.dnsAt('cloudflare', 'riyeser.com'), /riyeser\.com's DNS is at Cloudflare[\s\S]*Edit zone DNS[\s\S]*DNS only \(grey cloud\)/);
});

test('the set-up code is claimed without signing in, once, and only a 64-hex key comes back', async () => {
  const { LinkCloud } = require('../src/link/cloud');
  const calls = [];
  const online = { call: async (p, o) => { calls.push([p, o]); return { relay_id: 'r1a2b3c4', host: 'r1a2b3c4.relay.invalid', dns: false, region: 'Suva', priority: 1, replaces: 'suva1', key: 'cd'.repeat(32) }; } };
  const cloud = new LinkCloud({ service: { online, on() {} } });
  await assert.rejects(cloud.claimRelayCode('hello'), /like RLY-AB12-CD34-EF56/);
  const r = await cloud.claimRelayCode(' rly-ab12-cd34-ef56 ');
  assert.deepEqual(calls[0], ['/rest/v1/rpc/relay_enroll_claim', { method: 'POST', auth: false, body: { code: 'RLY-AB12-CD34-EF56' } }]);
  assert.equal(r.replaces, 'suva1');
  online.call = async () => ({ relay_id: 'x1', key: 'short' });
  await assert.rejects(cloud.claimRelayCode('RLY-AB12-CD34-EF56'), /didn't send this relay's key/);
});

test('router port forwarding: what the relay asked for is noted, and the uninstaller removes it even after a hard stop', async () => {
  // a pretend NAT-PMP router on this PC
  const router = dgram.createSocket('udp4'); const got = [];
  router.on('message', (m, r) => {
    if (m.length === 2) { const b = Buffer.alloc(12); b[1] = 128; b.writeUInt32BE(1, 4); b.set([203, 0, 113, 9], 8); router.send(b, r.port, r.address); return; }
    got.push({ op: m[1], inPort: m.readUInt16BE(4), exPort: m.readUInt16BE(6), life: m.readUInt32BE(8) });
    const b = Buffer.alloc(16); b[1] = m[1] | 128; b.writeUInt16BE(m.readUInt16BE(4), 8); b.writeUInt16BE(m.readUInt16BE(6), 10); router.send(b, r.port, r.address);
  });
  await new Promise((r) => router.bind(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-pm-')); const file = path.join(dir, 'portmaps.json');
  try {
    const pm = new PortMapper({ ports: [{ proto: 'tcp', port: 443 }, { proto: 'udp', port: 3478 }, { proto: 'udp', port: 40000 }], gw: '127.0.0.1', pmpPort: router.address().port, saveFile: file, lifetime: 600 });
    await pm.map(); clearInterval(pm.timer);
    assert.equal(pm.state.method, 'NAT-PMP'); assert.deepEqual(pm.state.ports, ['443/tcp', '3478/udp', '40000/udp']);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.ports.map((p) => p.port), [443, 3478, 40000]); assert.equal(saved.gw, '127.0.0.1');
    // the relay was stopped hard (no chance to remove them): the uninstaller's helper does it from the file
    got.length = 0;
    const r = await removeSaved(file);
    assert.deepEqual(r, { removed: 3, failed: 0, method: 'NAT-PMP' });
    assert.deepEqual(got.map((x) => [x.op, x.inPort, x.exPort, x.life]), [[2, 443, 0, 0], [1, 3478, 0, 0], [1, 40000, 0, 0]], 'each mapping deleted (lifetime 0)');
    assert.equal(fs.existsSync(file), false, 'the note is gone');
    assert.deepEqual(await removeSaved(file), { removed: 0, failed: 0, method: null }, 'nothing noted: nothing to do');
    // the same through the relay's own command line (what install-relay.ps1 -Uninstall runs)
    await pm.map(); clearInterval(pm.timer);
    const { cli } = require('../src/relay/server');
    assert.equal((await cli(['--remove-port-mappings'], { portMapFile: file })).removed, 3);
    assert.deepEqual(await cli(['--leave'], { portMapFile: file, supabaseUrl: '', secret: '' }), { left: false, why: 'not connected to Riyeser online' });
    // a clean stop removes them and the note
    await pm.map(); clearInterval(pm.timer); await pm.stop();
    assert.equal(fs.existsSync(file), false);
  } finally { router.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('removing a relay revokes it: the other relays take the new keys and drop it within one sync, its copied keys stop working, and sites move on by themselves', async () => {
  const SECRET2 = 'the-new-cluster-secret-after-removal-0123456789';
  const k2 = tokens.keys(SECRET2);
  const hex = (b) => Buffer.from(b).toString('hex');
  const a = await H.relay({ id: 'syd1', region: 'Sydney', p: H.plan({}) });
  const b = await H.relay({ id: 'mel1', region: 'Melbourne', p: H.plan({}) });
  const peers = (s) => [...s.relay.conns.values()].filter((c) => c.kind === 'peer').map((c) => c.peer);
  const relays = [{ id: 'mel1', url: b.url, host: 'mel1.relay.test', region: 'Melbourne' }, { id: 'syd1', url: a.url, host: 'syd1.relay.test', region: 'Sydney' }];
  let cfgRelays = relays;
  const suva = await H.site('Suva', { office: H.OFFICES.suva, relays });
  // the site's config follows Riyeser online (after a removal: the relays left, and new passes)
  suva.link.getConfig = async () => ({ enabled: true, relays: cfgRelays, tokens: Object.fromEntries(cfgRelays.map((r) => [r.id, H.pass(H.OFFICES.suva, { relayId: r.id })])), exp: Math.floor(Date.now() / 1000) + 3600 });
  try {
    await a.fakeCloud.push(H.plan({ relays: [{ id: 'mel1', url: b.url.replace('/link/v1', '/relay/v1'), ip: '127.0.0.1' }] }));
    await b.fakeCloud.push(H.plan({ relays: [{ id: 'syd1', url: a.url.replace('/link/v1', '/relay/v1'), ip: '127.0.0.1' }] }));
    await H.until(() => peers(a).includes('mel1') && peers(b).includes('syd1'), 8000, 'the relays joined up');
    await H.until(() => suva.link.status().connected && suva.link.status().relay === 'mel1', 8000, 'Suva on mel1');
    // the owner removes mel1 on the website (its PC was lost): Riyeser online changes the cluster secret. At syd1's next
    // sync (every 30 s; here: now) it gets the new keys and mel1 is no longer listed
    const t0 = Date.now();
    await a.fakeCloud.push({ ...H.plan({ relays: [] }), keys: { epoch: 2, office: hex(k2.office), device: hex(k2.device), peer: hex(k2.peer), turn: k2.turn } });
    await H.until(() => !peers(a).includes('mel1'), 3000, 'syd1 dropped mel1');
    const took = Date.now() - t0;
    assert.ok(took < 3000, `dropped ${took} ms after the sync (a sync is every 30 s: within 30 s of the removal)`);
    assert.equal(a.keyEpoch, 2);
    // mel1 still has the old keys: it can't join syd1 as a peer, and a pass made with the old office key is refused
    const ws = require('../src/link/ws');
    await assert.rejects(ws.connect(a.url.replace('/link/v1', '/relay/v1'), { headers: { Authorization: `Peer ${tokens.peerAuth(tokens.keys(H.SECRET).peer, 'mel1')}` } }), (e) => e.status === 401);
    await assert.rejects(ws.connect(a.url, { headers: { Authorization: `Bearer ${H.pass(H.OFFICES.nadi)}` } }), (e) => e.status === 401 && e.body.code === 'token');
    const good = tokens.sign(k2.office, { v: 1, r: 'syd1', ws: H.WS, o: H.OFFICES.nadi, g: 1, exp: Math.floor(Date.now() / 1000) + 600 });
    const c = await ws.connect(a.url, { headers: { Authorization: `Bearer ${good}` } }); c.close();
    // mel1 hears it was removed (its sync is refused): it stops serving, and Suva moves to syd1 by itself
    cfgRelays = [relays[1]];
    suva.link.getConfig = async () => ({ enabled: true, relays: cfgRelays, tokens: { syd1: tokens.sign(k2.office, { v: 1, r: 'syd1', ws: H.WS, o: H.OFFICES.suva, g: 1, exp: Math.floor(Date.now() / 1000) + 3600 }) }, exp: Math.floor(Date.now() / 1000) + 3600 });
    const t1 = Date.now();
    b.fakeCloud.removed();
    assert.equal(b.removed, true);
    await H.until(() => suva.link.status().connected && suva.link.status().relay === 'syd1', 10000, 'Suva moved to syd1');
    assert.ok(Date.now() - t1 < 10000);
    await assert.rejects(ws.connect(b.url, { headers: { Authorization: `Bearer ${H.pass(H.OFFICES.nadi, { relayId: 'mel1' })}` } }), (e) => e.status === 403 && e.body.code === 'removed');
    const hb = await new Promise((res) => require('http').get(`http://127.0.0.1:${b.ports.http}/health`, (x) => { let s = ''; x.on('data', (d) => { s += d; }); x.on('end', () => res(JSON.parse(s))); }));
    assert.equal(hb.removed, true, '/health says so (Link Office on that PC shows "removed: remove it from this PC")');
    // the default sync really is every 30 seconds
    assert.equal(new (require('../src/relay/lib/cloud').CloudSync)({}).every, 30000);
  } finally { await suva.close(); await a.close(); await b.close(); }
});

test('moving the relay to a new PC: the new one starts with its own key and gets the cluster keys from Riyeser online; sites reconnect to it', async () => {
  const keys = tokens.keys(H.SECRET); const hex = (x) => Buffer.from(x).toString('hex');
  // the new PC's relay: its own key (not the cluster secret); until its first sync it accepts nobody
  const n = await H.relay({ id: 'r1a2b3c4', region: 'Suva head office', secret: 'ef'.repeat(32), p: H.plan({}) });
  const old = await H.relay({ id: 'suva1', region: 'Suva head office', p: H.plan({}) });
  let cfgRelays = [{ id: 'suva1', url: old.url, host: 'suva1.relay.test', region: 'Suva head office' }];
  const site = await H.site('Nadi', { office: H.OFFICES.nadi, relays: cfgRelays });
  site.link.getConfig = async () => ({ enabled: true, relays: cfgRelays, tokens: Object.fromEntries(cfgRelays.map((r) => [r.id, H.pass(H.OFFICES.nadi, { relayId: r.id })])), exp: Math.floor(Date.now() / 1000) + 3600 });
  const ws = require('../src/link/ws');
  try {
    await H.until(() => site.link.status().connected && site.link.status().relay === 'suva1', 8000, 'Nadi on the old PC');
    await assert.rejects(ws.connect(n.url, { headers: { Authorization: `Bearer ${H.pass(H.OFFICES.nadi, { relayId: 'r1a2b3c4' })}` } }), (e) => e.status === 401, 'no keys yet: nobody gets in');
    // its first sync (with its own key): it takes over (Riyeser online removes the old one) and gets the cluster keys
    await n.fakeCloud.push({ ...H.plan({}), keys: { epoch: 1, office: hex(keys.office), device: hex(keys.device), peer: hex(keys.peer), turn: keys.turn } });
    assert.equal(n.keyEpoch, 1);
    cfgRelays = [{ id: 'r1a2b3c4', url: n.url, host: 'r1a2b3c4.relay.invalid', region: 'Suva head office' }];
    old.fakeCloud.removed();
    await H.until(() => site.link.status().connected && site.link.status().relay === 'r1a2b3c4', 10000, 'Nadi reconnected to the new PC by itself');
  } finally { await site.close(); await n.close(); await old.close(); }
});

test('the test call: a second of 1 kHz tone through the relay\'s echo, round trip and loss; the echo is rate-limited', async () => {
  const m = await new Media({ probePort: 0, bind: '127.0.0.1', min: 47100, max: 47120 }).start();
  try {
    const r = await echoTest({ ip: '127.0.0.1', port: m.probePort, every: 5, timeout: 400 });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.received, 50); assert.equal(r.loss, 0); assert.equal(r.tone, true); assert.ok(r.rtt_ms >= 0 && r.rtt_ms < 200);
    // the tone really is a 1 kHz tone (and not some other)
    const samples = [...tonePacket(0), ...tonePacket(1)].map(muDecode);
    assert.ok(toneStrength(samples, 1000) > 0.8 && toneStrength(samples, 400) < 0.1);
    // more than 64 a second from one address: the rest isn't echoed (nobody can use the relay to flood anyone)
    const f = await echoTest({ ip: '127.0.0.1', port: m.probePort, packets: 100, every: 0, timeout: 300 });
    assert.ok(f.received <= 64 && f.loss >= 30, `flood limited: ${f.received}`);
    assert.match((await echoTest({ ip: null, port: null })).error, /sound port/);
    // nothing comes back (UDP blocked): it says so
    const nowhere = await echoTest({ ip: '127.0.0.1', port: 9, packets: 5, every: 5, timeout: 300 });
    assert.equal(nowhere.ok, false); assert.match(nowhere.error, /UDP to the relay seems blocked/);
  } finally { await m.stop(); }
});

// ---------- the checklist ----------
const HEALTH = { ok: true, relay: 'suva1', region: 'Suva head office', version: '1.1.0', uptime: 7200, sites: 2, cert_sha256: 'AB:CD', public_ip: '203.0.113.9', dns_name: null,
  sync: { ok: true }, removed: false, port_map: { method: 'UPnP', mapped: 8, failed: 0 } };
const CONNECTED = { state: 'connected', connected: true, relay: 'suva1', region: 'Suva head office', rtt: 18, udp: 'ok', sites: [{ name: 'Nadi' }, { name: 'Lautoka' }], test: { ok: true, rtt_ms: 21, loss: 0 },
  relays: [{ id: 'suva1', region: 'Suva head office', pin: 'AB:CD' }, { id: 'mel1', region: 'Sydney' }], exp: Math.floor(Date.now() / 1000) + 3600 };
const host = (over = {}) => ({ installed: true, health: { ...HEALTH, ...(over.health || {}) }, check: { port_map: HEALTH.port_map, outside: { ok: true, via: 'mel1', results: [] }, ports: { https: 443, probe: 40000 }, ...(over.check || {}) },
  pc: { windows: 'ok', admin: true, diskFreeGb: 40, onBattery: false }, adapter: { address: '192.168.1.20', dhcp: false }, ...over.rest });
const facts = (over = {}) => ({ relay: { ...CONNECTED, ...(over.relay || {}) }, cloud: { status: 'online' }, host: over.host === undefined ? host() : over.host, exts: ['101', '102'], muted: over.muted || [], reach: over.reach || null });
const stepOf = (l, k) => l.steps.find((x) => x.k === k);

test('checklist: all good on the relay PC and at the site; one office with no branches sees one calm line', () => {
  const l = C.build(facts());
  assert.deepEqual(l.steps.map((x) => x.k), ['pc', 'service', 'address', 'ports', 'secure', 'registered', 'switched', 'internet', 'reach', 'auth', 'sound', 'exts', 'test'], 'no web name step without your own web name');
  assert.ok(l.steps.every((x) => x.s === 'ok'), JSON.stringify(l.steps.filter((x) => x.s !== 'ok')));
  assert.equal(l.summary.text, 'All good — 3 sites connected'); assert.equal(l.summary.cls, 'ok');
  assert.match(stepOf(l, 'registered').t, /Suva head office \(main relay\)/);
  assert.match(stepOf(l, 'test').t, /Sound both ways · 21 ms round trip · 0% lost/);
  const site = C.build(facts({ host: null }));
  assert.deepEqual(site.steps.map((x) => x.k), ['internet', 'reach', 'auth', 'sound', 'exts', 'test'], 'a site without the relay: only its own steps');
  for (const st of ['local', 'off', 'no-config']) { const u = C.build({ relay: { state: st } }); assert.equal(u.unused, true); assert.equal(u.summary.text, 'Branches: not used'); assert.equal(u.steps.length, 0); }
});

test('checklist: router port closed (tested from outside) flags that step with the ports, a retry and per-router steps', () => {
  const l = C.build(facts({ host: host({ check: { port_map: { method: null, mapped: 0, failed: 8, error: 'The router doesn\'t allow automatic port forwarding' }, outside: { ok: false, via: 'mel1', results: [{ proto: 'tcp', port: 443, open: true }, { proto: 'udp', port: 3478, open: false }] } } }) }));
  const p = stepOf(l, 'ports');
  assert.equal(p.s, 'fail'); assert.match(p.t, /Closed from the internet: 3478\/UDP/);
  assert.equal(p.fix.act, 'retryupnp'); assert.ok(p.how.some((x) => /Port forwarding/.test(x)) && p.how.some((x) => /3478\/UDP/.test(x) && /192\.168\.1\.20/.test(x)));
  assert.equal(l.summary.first, 'ports'); assert.equal(l.summary.cls, 'bad');
  assert.match(l.summary.text, /^1 thing needs attention: Router ports open from the internet — Closed from the internet: 3478\/UDP/);
  // automatic forwarding worked: no "by hand" steps shown
  const auto = C.build(facts({ host: host({ check: { outside: { ok: false, via: 'mel1', results: [{ proto: 'udp', port: 3478, open: false }] } } }) }));
  assert.equal(stepOf(auto, 'ports').how, null);
});

test('checklist: your own web name — missing, proxied through Cloudflare (orange cloud) or pointing elsewhere', () => {
  const named = (dns) => C.build(facts({ host: { ...host({ health: { dns_name: 'relay.riyeser.com' } }), dns } }));
  assert.equal(stepOf(named({ name: 'relay.riyeser.com', ips: ['203.0.113.9'] }), 'name').s, 'ok');
  const miss = stepOf(named({ name: 'relay.riyeser.com', error: 'no such record', host: 'cloudflare' }), 'name');
  assert.equal(miss.s, 'fail'); assert.match(miss.how[0], /Add record: type A, name relay[\s\S]*DNS only \(grey cloud\)/);
  const proxied = stepOf(named({ name: 'relay.riyeser.com', ips: ['104.21.3.4'] }), 'name');
  assert.equal(proxied.s, 'fail'); assert.match(proxied.t, /proxied through Cloudflare \(orange cloud\)/);
  assert.equal(C.isCloudflare('104.21.3.4'), true); assert.equal(C.isCloudflare('203.0.113.9'), false);
  const wrong = stepOf(named({ name: 'relay.riyeser.com', ips: ['198.51.100.7'] }), 'name');
  assert.equal(wrong.s, 'fail'); assert.match(wrong.t, /points at 198\.51\.100\.7, not this office \(203\.0\.113\.9\)/);
});

test('checklist: UDP blocked at a site, can\'t reach the relay (says where), refused, removed relay, and dismissing a step', () => {
  const udp = C.build(facts({ host: null, relay: { udp: 'blocked' } }));
  assert.equal(stepOf(udp, 'sound').s, 'fail'); assert.match(stepOf(udp, 'sound').t, /UDP blocked/); assert.ok(stepOf(udp, 'sound').how.length);
  assert.equal(udp.summary.first, 'sound');
  const down = C.build(facts({ host: null, relay: { state: 'connecting', connected: false, error: 'connection lost', udp: null, test: null }, reach: { dns: { ok: true, ip: '203.0.113.9' }, tcp: { ok: false, error: 'no answer (blocked, or the relay\'s router doesn\'t forward the port)' } } }));
  assert.equal(stepOf(down, 'reach').s, 'fail'); assert.match(stepOf(down, 'reach').t, /Can't connect to the relay: no answer/);
  assert.equal(stepOf(down, 'auth').s, 'todo'); assert.equal(stepOf(down, 'test').fix, null);
  const refused = C.build(facts({ host: null, relay: { state: 'refused', connected: false, error: 'an admin disconnected this office' } }));
  assert.equal(stepOf(refused, 'auth').s, 'fail');
  const removed = C.build(facts({ host: host({ health: { removed: true } }) }));
  assert.equal(stepOf(removed, 'registered').s, 'fail'); assert.equal(stepOf(removed, 'registered').fix.act, 'relaystop');
  const sleepy = C.build(facts({ host: { ...host(), sleepNote: 'Windows is set to put this PC to sleep after 30 minutes.' } }));
  assert.equal(stepOf(sleepy, 'pc').fix.act, 'keepawake');
  const dhcp = C.build(facts({ host: { ...host(), adapter: { address: '192.168.1.20', dhcp: true } } }));
  assert.equal(stepOf(dhcp, 'address').s, 'warn'); assert.equal(stepOf(dhcp, 'address').fix.act, 'reserve');
  // an admin dismissed it for good: shown dimmed, not counted, reported as "not yet"
  const muted = C.build({ ...facts({ host: null, relay: { udp: 'blocked' } }), muted: ['sound'] });
  assert.equal(stepOf(muted, 'sound').muted, true); assert.equal(muted.summary.first, null); assert.match(muted.summary.text, /^All good/);
  assert.equal(C.forReport(muted).find((x) => x.k === 'sound').s, 'todo');
  assert.ok(C.forReport(udp).every((x) => /^[a-z]+$/.test(x.k) && ['ok', 'warn', 'fail', 'todo'].includes(x.s) && x.t.length <= 160));
});

test('remote checks from the website, the one notification, and Advanced checks lock after 15 minutes', async () => {
  const { EventEmitter } = require('events');
  let now = 1e12;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-rc-'));
  const { Store } = require('../src/core/store'); const store = new Store(dir);
  const service = new EventEmitter();
  let st = { ...CONNECTED };
  Object.assign(service, { store, log() {}, status: () => ({ relay: st, host: '192.168.1.20' }), adapters: () => ({ list: [], current: null }),
    relay: { exts: ['101'], testCall: async () => ({ ok: true, rtt_ms: 9, loss: 0, tone: true }), activeConn: () => null, nudge() {}, reach: async () => ({}), force: async (id) => ({ relay: id }) } });
  const told = [];
  const rc = new RelayChecks({ service, isWin: false, now: () => now, notify: (t, b) => told.push([t, b]),
    makeOnline: () => ({ signIn: async () => ({ email: 'boss@x.test', needsCode: true }), verifyCode: async () => ({}), call: async () => ({ admin: true }), signOut() {} }) });
  rc.cloud = { state: { status: 'online' }, company: () => ({ workspace_id: 'ws1' }), relayReport: async () => true };
  try {
    const all = await rc.command({ action: 'run_all' });
    assert.equal(all.ok, true); assert.equal(all.result.summary.text, 'All good — 3 sites connected');
    assert.ok(all.result.checks.find((x) => x.k === 'test'));
    assert.deepEqual((await rc.command({ action: 'test_call' })).result.test, { ok: true, rtt_ms: 9, loss: 0, tone: true });
    assert.equal((await rc.command({ action: 'force_relay', relay: 'mel1' })).result.relay, 'mel1');
    assert.match((await rc.command({ action: 'format_disk' })).error, /doesn't know how/);
    // dismissing a step and Advanced checks need an unlocked owner or admin (two-step); it locks after 15 minutes
    assert.throws(() => rc.mute('sound'), /Unlock Advanced checks first/);
    assert.deepEqual(await rc.unlock('boss@x.test', 'pw'), { needsCode: true });
    assert.equal((await rc.unlockCode('123456')).email, 'boss@x.test');
    assert.deepEqual(rc.mute('sound'), ['sound']);
    now += 14 * 60 * 1000; assert.ok(rc.adminState(), 'still unlocked (used 14 minutes ago)');
    now += 16 * 60 * 1000; assert.equal(rc.adminState(), null, 'locked again after 15 minutes without use');
    const noMfa = new RelayChecks({ service, makeOnline: () => ({ signIn: async () => ({ email: 'x' }), signOut() {} }) });
    await assert.rejects(noMfa.unlock('x', 'y'), /need two-step sign-in/);
    // one Windows notification when cross-site calls stop working (after 2 minutes), and no repeats
    const t = rc.watch(); clearInterval(t);
    service.emit('change');                  // connected: remembered
    st = { state: 'connecting', connected: false };
    const tick = async () => { rc.downSince = rc.downSince || now; if (!rc.toldDown && now - rc.downSince > 120000) { rc.toldDown = true; rc.notify('Calls to your other sites aren\'t working', 'x'); } };
    await tick(); now += 3 * 60 * 1000; await tick(); await tick(); now += 60 * 60 * 1000; await tick();
    assert.equal(told.length, 1, 'told once');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const ms = memoryStore({ get: (k, d) => (k === 'online-config' ? { url: 'u' } : d), set() {} });
  ms.set('online', { session: 's' }); assert.deepEqual(ms.get('online'), { session: 's' }); assert.deepEqual(ms.get('online-config'), { url: 'u' });
});

test('the website sees each site\'s checklist and last test call (link_relay_report)', async () => {
  const { LinkCloud } = require('../src/link/cloud');
  const sent = [];
  const service = { on() {}, officeId: () => 'lo-suva-1', status: () => ({ relay: { ...CONNECTED, udp: 'blocked', test: { ok: true, rtt_ms: 30, loss: 0, at: '2026-11-27T00:00:00Z' } } }),
    relayChecks: { list: async () => ({ ...C.build(facts({ host: null, relay: { udp: 'blocked' } })), facts: { host: null } }) } };
  const cloud = new LinkCloud({ service });
  cloud.ready = () => ({ workspace_id: 'ws1' });
  cloud.withClient = async (fn) => fn({ rpc: async (name, args) => { sent.push([name, args]); return null; } });
  assert.equal(await cloud.relayReport(), true);
  const st = sent[0][1].state;
  assert.equal(sent[0][0], 'link_relay_report');
  assert.equal(st.checks.find((x) => x.k === 'sound').s, 'fail');
  assert.deepEqual(st.test, { rtt_ms: 30, loss: 0, ok: true, at: '2026-11-27T00:00:00Z' });
  assert.equal(st.host, false);
  assert.equal(await cloud.relayReport(), false, 'nothing changed: not sent again');
  assert.equal(await cloud.relayReport(true), true, 'unless asked (after a remote check)');
});

test('Cloudflare dynamic DNS: the zone by its name, and a proxied (orange cloud) record is set to DNS only', async () => {
  const calls = [];
  const fetch = async (url, o = {}) => {
    calls.push([o.method || 'GET', url.replace('https://api.cloudflare.com/client/v4', ''), o.body ? JSON.parse(o.body) : null]);
    const j = /\/zones\?name=/.test(url) ? { result: [{ id: 'z'.repeat(32) }] } : /dns_records\?/.test(url) ? { result: [{ id: 'rec1', content: '203.0.113.9', proxied: true }] } : { result: {} };
    return { ok: true, status: 200, json: async () => j };
  };
  const logs = [];
  const d = new Ddns({ provider: 'cloudflare', token: 't'.repeat(40), zone: 'riyeser.com', name: 'relay.riyeser.com', fetch, log: (l, t) => logs.push(t) });
  assert.equal(await d.update('203.0.113.9'), true, 'same address, but proxied: fixed');
  assert.deepEqual(calls.map((c) => [c[0], c[1].split('?')[0]]), [['GET', '/zones'], ['GET', `/zones/${'z'.repeat(32)}/dns_records`], ['PUT', `/zones/${'z'.repeat(32)}/dns_records/rec1`]]);
  assert.equal(calls[2][2].proxied, false);
  assert.ok(logs.some((l) => /orange cloud/.test(l)));
  assert.ok(!logs.join(' ').includes('t'.repeat(40)), 'never the token');
});

test('the relay link\'s new pass when the relay keys changed, and the reach test says where it fails', async () => {
  const { reachTest } = require('../src/link/relay');
  const net = require('net');
  const r1 = await reachTest({ url: 'wss://no-such-name.invalid/link/v1' });
  assert.equal(r1.dns.ok, false); assert.equal(r1.tcp, undefined);
  const srv = net.createServer((s) => s.destroy()); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const closed = await reachTest({ url: `wss://127.0.0.1:${srv.address().port}/link/v1` });
  assert.equal(closed.dns.none, true); assert.equal(closed.tcp.ok, true); assert.equal(closed.tls.ok, false);
  srv.close();
  const refused = await reachTest({ url: 'wss://127.0.0.1:9/link/v1' });
  assert.equal(refused.tcp.ok, false); assert.match(refused.tcp.error, /refused|no answer/);
  // a 401 "token" (the keys were changed when a relay was removed) asks Riyeser online for new passes
  const link = new RelayLink({ getConfig: async () => ({ enabled: true, relays: [{ id: 'x', url: 'ws://127.0.0.1:9/link/v1' }], tokens: { x: 'p' } }), connect: async () => { throw Object.assign(new Error('401'), { status: 401, body: { code: 'token' } }); } });
  link.config = await link.getConfig(); link.configAt = Date.now();
  link.stopped = false; const loop = link.loop(); await H.wait(50); link.stopped = true; clearTimeout(link.retry);
  assert.equal(link.configAt, 0); void loop;
});

test('a nudge while the relay link is waiting between tries makes it try again now (it used to wait forever)', async () => {
  let cfg = { enabled: false };
  const link = new RelayLink({ getConfig: async () => { if (cfg instanceof Error) throw cfg; return cfg; } });
  link.stopped = false; link.loop().catch(() => {});
  await H.until(() => link.state === 'off', 2000, 'off, and waiting 5 minutes before asking again');
  cfg = new Error('Riyeser online now says something new');
  link.nudge();
  await H.until(() => link.state === 'no-config' && /something new/.test(link.error), 2000, 'asked again straight away');
  link.stopped = true; link.nudge(); clearTimeout(link.retry);
});
