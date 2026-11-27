// A Riyeser Link app call (WebRTC) through the Riyeser relay's own TURN server, for real: two headless Chromes
// with fake microphones, each on its own office network behind its own NAT (Linux network namespaces, random-port
// masquerade, nothing allowed in), and the relay on the "internet". Checks:
//   1. with the TURN details link_relay_turn gives out, the call connects through the relay (a "relay" candidate
//      pair is chosen) and sound packets arrive both ways;
//   2. with expired TURN details the relay refuses them (no relay address at all);
//   3. with no TURN (and no Google STUN, which Riyeser Link no longer uses) the two NATs can't be crossed.
// Needs Linux, root, `ip`, Chrome and Playwright. Skips (exit 0) elsewhere. Exits 1 on failure.
//   node website/team/test/relay-turn-test.js     (CHROME=/path/to/chrome, PLAYWRIGHT=/path/to/playwright)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const DESK = path.join(__dirname, '..', '..', '..', 'desktop');
const N = require(path.join(DESK, 'test', 'e2e', 'netns'));
const tokens = require(path.join(DESK, 'src', 'relay', 'lib', 'tokens'));

const SECRET = 'turn-browser-test-secret-0123456789abcdef012345';
const P = `rt${process.pid % 10000}`;
const why = N.canRun(P);
let pw = null; for (const m of [process.env.PLAYWRIGHT, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean)) { try { pw = require(m); break; } catch { /* next */ } }
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((x) => fs.existsSync(x));
if (why || !pw || !CHROME) { console.log(`relay-turn-test: skipped (${why || (!pw ? 'needs Playwright' : 'needs Chrome')})`); process.exit(0); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; let failed = 0;
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const PAGE = `<!doctype html><meta charset="utf-8"><title>Riyeser Link call test</title><script>
let pc = null;
async function gathered() { if (pc.iceGatheringState === 'complete') return; await new Promise((r) => { pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') r(); }); setTimeout(r, 8000); }); }
async function start(ice, policy) {
  pc = new RTCPeerConnection({ iceServers: ice, iceTransportPolicy: policy || 'all' });
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const t of s.getTracks()) pc.addTrack(t, s);
}
async function offer(ice, policy) { await start(ice, policy); await pc.setLocalDescription(await pc.createOffer()); await gathered(); return pc.localDescription.toJSON(); }
async function answer(ice, policy, o) { await start(ice, policy); await pc.setRemoteDescription(o); await pc.setLocalDescription(await pc.createAnswer()); await gathered(); return pc.localDescription.toJSON(); }
async function finish(a) { await pc.setRemoteDescription(a); }
function state() { return pc ? pc.connectionState : 'none'; }
function candidates() { return (pc.localDescription.sdp.match(/a=candidate:.*/g) || []).map((l) => l.split(' ')[7]); }
async function stats() {
  const r = await pc.getStats(); let inbound = null; let pair = null; const byId = {};
  r.forEach((x) => { byId[x.id] = x; if (x.type === 'inbound-rtp' && x.kind === 'audio') inbound = x; });
  r.forEach((x) => { if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') pair = x; });
  return { packetsReceived: inbound ? inbound.packetsReceived : 0, bytesReceived: inbound ? inbound.bytesReceived : 0,
    local: pair ? byId[pair.localCandidateId].candidateType : null, remote: pair ? byId[pair.remoteCandidateId].candidateType : null,
    localAddr: pair ? byId[pair.localCandidateId].address + ':' + byId[pair.localCandidateId].port : null };
}
</script>`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-turn-'));
  fs.writeFileSync(path.join(tmp, 'call.html'), PAGE);
  const net = N.net(P, { hosts: { rly: '198.51.100.10' }, offices: { A: { wan: '198.51.100.101' }, B: { wan: '198.51.100.102' } } });
  const logs = []; let relay = null; const browsers = [];
  try {
    // the relay (with its STUN/TURN server) on the internet
    relay = spawn('ip', ['netns', 'exec', net.ns('rly'), process.execPath, path.join(DESK, 'test', 'e2e', 'relay-proc.js'),
      JSON.stringify({ id: 'syd1', region: 'Suva head office', secret: SECRET, dir: path.join(tmp, 'relay'), plan: { ok: true, businesses: [], relays: [] } })], { stdio: ['pipe', 'pipe', 'pipe'] });
    let rbuf = ''; const ready = new Promise((res) => relay.stdout.on('data', (d) => { rbuf += d; for (const l of String(d).split('\n')) if (l.includes('"ready"')) res(); }));
    relay.stderr.on('data', (d) => logs.push(String(d)));
    await ready;
    const statsOf = () => new Promise((res) => { const before = rbuf.length; relay.stdin.write(`${JSON.stringify({ id: 9, cmd: 'stats' })}\n`);
      const t = setInterval(() => { const m = rbuf.slice(before).split('\n').find((l) => l.includes('"turn"')); if (m) { clearInterval(t); res(JSON.parse(m).turn); } }, 50); });
    // a headless Chrome in each office, started inside that office's network
    const launch = async (office) => {
      const w = path.join(tmp, `chrome-${office}.sh`);
      fs.writeFileSync(w, `#!/bin/sh\nexec ip netns exec ${net.ns(`site${office}`)} ${CHROME} "$@"\n`, { mode: 0o755 });
      const b = await pw.chromium.launch({ executablePath: w, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
      browsers.push(b);
      const page = await b.newPage(); await page.goto(`file://${path.join(tmp, 'call.html')}`);
      return page;
    };
    const turn = tokens.keys(SECRET).turn;
    const ice = (cred) => [{ urls: ['stun:198.51.100.10:3478', 'turn:198.51.100.10:3478?transport=udp', 'turn:198.51.100.10:3478?transport=tcp'], username: cred.username, credential: cred.credential }];
    const call = async (iceA, iceB, policy, label, ms = 15000) => {
      const a = await launch('A'); const b = await launch('B');
      const o = await a.evaluate(([i, p]) => offer(i, p), [iceA, policy]);
      const ans = await b.evaluate(([i, p, x]) => answer(i, p, x), [iceB, policy, o]);
      await a.evaluate((x) => finish(x), ans);
      const end = Date.now() + ms; let sa = 'new'; let sb = 'new';
      while (Date.now() < end) { sa = await a.evaluate(() => state()); sb = await b.evaluate(() => state()); if ((sa === 'connected' && sb === 'connected') || sa === 'failed' || sb === 'failed') break; await wait(250); }
      const out = { a, b, sa, sb, candA: await a.evaluate(() => candidates()) };
      if (sa === 'connected' && sb === 'connected') { await wait(3000); out.statsA = await a.evaluate(() => stats()); out.statsB = await b.evaluate(() => stats()); }
      console.log(`${label}: A ${sa}, B ${sb}; A's candidates: ${out.candA.join(', ') || 'none'}${out.statsA ? `; A got ${out.statsA.packetsReceived} sound packets via ${out.statsA.local}/${out.statsA.remote} (${out.statsA.localAddr}), B got ${out.statsB.packetsReceived} via ${out.statsB.local}/${out.statsB.remote}` : ''}`);
      return out;
    };

    // 1. with the relay's TURN details, as link_relay_turn gives them (12 hours)
    const before = await statsOf();
    const c1 = await call(ice(tokens.turnCredentials(turn, 'userA', 43200)), ice(tokens.turnCredentials(turn, 'userB', 43200)), 'all', 'Call through the relay (TURN)');
    check(c1.sa === 'connected' && c1.sb === 'connected', 'the call connects across two NATs');
    check(c1.statsA && c1.statsA.packetsReceived > 50 && c1.statsB.packetsReceived > 50, `sound arrives both ways (A ${c1.statsA && c1.statsA.packetsReceived}, B ${c1.statsB && c1.statsB.packetsReceived} packets in ~3 s)`);
    check(c1.statsA && (c1.statsA.local === 'relay' || c1.statsA.remote === 'relay'), 'through the relay (a TURN "relay" candidate pair)');
    check(c1.candA.includes('srflx'), 'the relay\'s own STUN gives each side its public address (no Google STUN)');
    const after = await statsOf();
    check(after.packets > before.packets + 100, `the relay's TURN server carried it (${after.packets - before.packets} packets, ${after.allocations} allocation(s))`);
    results.push(`  TURN server: ${JSON.stringify(after)}`);
    for (const b of browsers.splice(0)) await b.close();

    // 2. expired TURN details are refused
    const c2 = await call(ice(tokens.turnCredentials(turn, 'userA', -60)), ice(tokens.turnCredentials(turn, 'userB', -60)), 'relay', 'Expired TURN details', 8000);
    check(!c2.candA.includes('relay'), 'expired details get no relay address');
    check(c2.sa !== 'connected', 'and no call');
    for (const b of browsers.splice(0)) await b.close();

    // 3. no TURN at all (what an app with no relay set up has): two strict NATs can't be crossed
    const c3 = await call([], [], 'all', 'No TURN', 12000);
    check(c3.sa !== 'connected', 'without the relay the two NATs aren\'t crossed (so the TURN is what makes it work)');
    for (const b of browsers.splice(0)) await b.close();
  } catch (e) { check(false, `test crashed: ${e.stack}`); console.log(logs.join('')); } finally {
    for (const b of browsers) await b.close().catch(() => {});
    if (relay) relay.kill('SIGKILL');
    await wait(300); net.down(); fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (process.env.RIYESER_TURN_EVIDENCE) fs.writeFileSync(process.env.RIYESER_TURN_EVIDENCE, results.join('\n') + '\n');
  console.log(failed ? `relay-turn-test: ${failed} FAILED` : 'relay-turn-test: all passed');
  process.exit(failed ? 1 : 0);
})();
