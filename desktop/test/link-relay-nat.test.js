// The Riyeser relay end to end, on real (virtual) networks: two Link Office sites of one business, each behind its
// own NAT router (Linux network namespaces with iptables masquerade, ports randomised, nothing allowed in), both
// using the same office subnet 192.168.1.0/24; a third site of another business; a main relay and a backup relay
// on the "internet". Simulated desk phones on each office network send real RTP, and the test checks the sound
// arrives both ways. Then: a site's public IP changes mid-day; another business can't reach in; the main relay is
// killed (failover to the backup); both relays down (calls in the office still work).
// Needs Linux, root and `ip`; skipped anywhere else (Windows CI runs link-relay.test.js and the relay job instead).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const tokens = require('../src/relay/lib/tokens');

const SECRET = 'nat-e2e-relay-secret-0123456789abcdef0123456789';
const WS_A = 'aaaaaaaa-0000-4000-8000-0000000000e1'; const WS_B = 'bbbbbbbb-0000-4000-8000-0000000000e2';
const P = `ry${process.pid % 10000}`;
const N = require('./e2e/netns');
let NET = null;
const ns = (n) => `${P}${n}`;
const nsx = (n, cmd) => NET.exec(n, cmd);
function build() {
  NET = N.net(P, { hosts: { rly1: '198.51.100.10', rly2: '198.51.100.20' },
    offices: { A: { wan: '198.51.100.101', lan: ['192.168.1.10', '192.168.1.21', '192.168.1.22'] }, B: { wan: '198.51.100.102', lan: ['192.168.1.10', '192.168.1.21'] }, C: { wan: '198.51.100.104', lan: ['192.168.1.10', '192.168.1.21'] } } });
}
function teardown() { if (NET) NET.down(); }
const canRun = () => N.canRun(P);

/** A child process in a namespace that answers JSON lines. */
function proc(name, nsName, script, cfg, logs) {
  const child = spawn('ip', ['netns', 'exec', ns(nsName), process.execPath, path.join(__dirname, 'e2e', script), JSON.stringify(cfg)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let seq = 0; let buf = ''; let readyFn; const ready = new Promise((r) => { readyFn = r; });
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.log) { logs.push(`[${name}] ${m.log}`); continue; }
      if (m.ready || m.error && m.id == null) { readyFn(m); continue; }
      const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); }
    }
  });
  child.stderr.on('data', (d) => logs.push(`[${name} stderr] ${String(d).trim()}`));
  return {
    child, ready,
    ask(cmd, extra = {}, timeout = 20000) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { waiting.delete(id); reject(new Error(`${name}: no answer to ${cmd}`)); }, timeout);
        waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
        child.stdin.write(`${JSON.stringify({ id, cmd, ...extra })}\n`);
      });
    },
    kill(sig = 'SIGTERM') { try { child.kill(sig); } catch { /* gone */ } },
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout, what) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return true; await wait(200); } throw new Error(`timed out: ${what}`); }

const skip = canRun();
test('two sites behind separate NATs + the relay: calls with sound both ways, IP change, isolation, failover, relay down', { skip: skip || false, timeout: 240000 }, async (t) => {
  const logs = []; const evidence = [];
  const note = (s) => { evidence.push(s); t.diagnostic(s); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-nat-'));
  build();
  const plan = { ok: true, relays: [], businesses: [
    { ws: WS_A, enabled: true, offices: [{ office_id: 'lo-suva-nat00001', gen: 1, name: 'Suva' }, { office_id: 'lo-nadi-nat00002', gen: 1, name: 'Nadi' }], devices: [], groups: [{ ext: '100', members: ['101', '201'] }] },
    { ws: WS_B, enabled: true, offices: [{ office_id: 'lo-other-nat0003', gen: 1, name: 'Other' }], devices: [], groups: [] }] };
  const k = tokens.keys(SECRET).office;
  const pass = (ws, o, r) => tokens.sign(k, { v: 1, r, ws, o, g: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
  const relays = [{ id: 'syd1', url: 'ws://198.51.100.10:8080/link/v1', host: 'syd1.relay.test', region: 'Suva head office', ip: '198.51.100.10' },
    { id: 'mel1', url: 'ws://198.51.100.20:8080/link/v1', host: 'mel1.relay.test', region: 'Sydney', ip: '198.51.100.20' }];
  const timing = { pingEvery: 1000, deadAfter: 3500, failbackEvery: 5000 };
  const people = [['101', 'Alex Suva'], ['102', 'Bo Suva'], ['201', 'Ned Nadi']];
  const siteCfg = (name, ws, office, phones, ppl = people) => ({ name, ws, office, host: '192.168.1.10', people: ppl, phones, relays, timing,
    tokens: { syd1: pass(ws, office, 'syd1'), mel1: pass(ws, office, 'mel1') } });
  const procs = [];
  try {
    const r1 = proc('relay syd1', 'rly1', 'relay-proc.js', { id: 'syd1', region: 'Suva head office', secret: SECRET, dir: path.join(dir, 'r1'), plan, peers: [{ id: 'mel1', url: 'ws://198.51.100.20:8080/relay/v1' }] }, logs); procs.push(r1);
    const r2 = proc('relay mel1', 'rly2', 'relay-proc.js', { id: 'mel1', region: 'Sydney', secret: SECRET, dir: path.join(dir, 'r2'), plan, peers: [{ id: 'syd1', url: 'ws://198.51.100.10:8080/relay/v1' }] }, logs); procs.push(r2);
    const rr1 = await r1.ready; await r2.ready;
    assert.equal(rr1.ip.ip, '198.51.100.10', 'the relay found its own public address');
    const suva = proc('Suva', 'siteA', 'site-proc.js', siteCfg('Suva', WS_A, 'lo-suva-nat00001', [{ ext: '101', bind: '192.168.1.21' }, { ext: '102', bind: '192.168.1.22' }]), logs); procs.push(suva);
    const nadi = proc('Nadi', 'siteB', 'site-proc.js', siteCfg('Nadi', WS_A, 'lo-nadi-nat00002', [{ ext: '201', bind: '192.168.1.21' }]), logs); procs.push(nadi);
    const other = proc('Other', 'siteC', 'site-proc.js', siteCfg('Other', WS_B, 'lo-other-nat0003', [{ ext: '301', bind: '192.168.1.21' }], [['201', 'Not Ned'], ['301', 'Oli Other']]), logs); procs.push(other);
    for (const p of [suva, nadi, other]) { const m = await p.ready; assert.ok(m.ready, m.error); }
    const connected = async (p, relay, reach) => { const s = await p.ask('status'); return s.relay.connected && s.relay.relay === relay && (!reach || s.relay.remote >= reach); };
    await until(async () => (await connected(suva, 'syd1', 1)) && (await connected(nadi, 'syd1', 1)), 30000, 'both sites connected to the main relay');
    assert.ok(logs.some((l) => /Site connected: .*lo-suva-nat00001.* from 198\.51\.100\.101/.test(l)), 'the relay sees Suva only as its NAT\'s public address');
    assert.ok(logs.some((l) => /Site connected: .*lo-nadi-nat00002.* from 198\.51\.100\.102/.test(l)));
    const st = (await suva.ask('status')).relay;
    note(`Suva status: "${st.detail}" · sound (UDP) to the relay: ${st.udp}`);
    assert.equal(st.udp, 'ok', 'UDP gets out through the NAT to the relay');

    // 1. a cross-site call, sound both ways (through two NATs, phones on the same subnet at both sites)
    const c1 = await suva.ask('call', { from: '101', to: '201', ms: 2000 });
    assert.equal(c1.status, 200, JSON.stringify(c1));
    const b1 = (await nadi.ask('rtp', { ext: '201' })).rtp;
    note(`Call 1 Suva 101 → Nadi 201: Suva sent ${c1.rtp.sent}, received ${c1.rtp.received} (from ${c1.rtp.from}); Nadi sent ${b1.sent}, received ${b1.received} (from ${b1.from})`);
    assert.ok(c1.rtp.received > 50 && b1.received > 50, 'sound both ways');
    assert.equal(c1.rtp.lastPayload, '201'); assert.equal(b1.lastPayload, '101');
    assert.match(c1.rtp.from, /^198\.51\.100\.10:/, 'the sound comes from the relay'); assert.match(b1.from, /^198\.51\.100\.10:/);
    assert.equal((await suva.ask('hangup', { from: '101' })).status, 200);

    // 2. another business can't reach A's extensions (it has a "201" of its own on its directory)
    const c2 = await other.ask('call', { from: '301', to: '201', ms: 100 });
    assert.equal(c2.status, 480, `business B gets nowhere: ${JSON.stringify(c2)}`);
    note(`Business isolation: Other 301 → "201": ${c2.status} ${c2.reason}`);

    // 3. Nadi's public IP changes mid-day (198.51.100.102 → .103): it reconnects by itself; new calls work
    const before = (await nadi.ask('status')).relay.reconnects;
    nsx('natB', 'ip addr add 198.51.100.103/24 dev eth0'); nsx('natB', 'ip addr del 198.51.100.102/24 dev eth0');
    const t0 = Date.now();
    await until(async () => { const s = (await nadi.ask('status')).relay; return s.reconnects > before && s.connected && s.relay === 'syd1'; }, 30000, 'Nadi reconnected from its new address');
    await until(() => logs.some((l) => /Site connected: .*lo-nadi-nat00002.* from 198\.51\.100\.103/.test(l)), 5000, 'the relay sees the new address');
    await until(async () => (await connected(suva, 'syd1', 1)), 10000, 'Suva sees Nadi again');
    note(`Nadi's public IP changed to 198.51.100.103: reconnected in ${Date.now() - t0} ms`);
    const c3 = await nadi.ask('call', { from: '201', to: '101', ms: 1500 });
    assert.equal(c3.status, 200, JSON.stringify(c3));
    const a3 = (await suva.ask('rtp', { ext: '101' })).rtp;
    note(`Call 2 after the IP change, Nadi 201 → Suva 101: Nadi sent ${c3.rtp.sent}, received ${c3.rtp.received}; Suva received ${a3.received}`);
    assert.ok(c3.rtp.received > 30 && a3.received > 30);
    await nadi.ask('hangup', { from: '201' });

    // 4. revoked: the other business's office is disconnected from the relay → dropped and refused
    const p2 = JSON.parse(JSON.stringify(plan)); p2.businesses[1].offices[0].revoked = true; p2.businesses[1].offices[0].gen = 2;
    await r1.ask('plan', { plan: p2 }); await r2.ask('plan', { plan: p2 });
    await until(async () => (await other.ask('status')).relay.state === 'refused', 20000, 'Other refused');
    note(`Revoked office: "${(await other.ask('status')).relay.detail}"`);

    // 5. failover: the main relay goes silent (its network drops everything: no goodbye, no reset) → both sites
    //    notice within seconds and move to the backup → a call with sound through the backup
    let t1 = Date.now();
    nsx('rly1', 'iptables -A INPUT -i eth0 -j DROP'); nsx('rly1', 'iptables -A OUTPUT -o eth0 -j DROP');
    await until(async () => (await connected(suva, 'mel1', 1)) && (await connected(nadi, 'mel1', 1)), 30000, 'failover to the backup');
    let took = Date.now() - t1;
    const sb = (await suva.ask('status')).relay;
    note(`Main relay unreachable (all its packets dropped): both sites on the backup after ${took} ms; Suva says "${sb.detail}"`);
    assert.equal(sb.backup, true); assert.match(sb.detail, /^Using backup relay · Sydney/);
    const c4 = await suva.ask('call', { from: '101', to: '201', ms: 1500 });
    assert.equal(c4.status, 200, JSON.stringify(c4));
    const b4 = (await nadi.ask('rtp', { ext: '201' })).rtp;
    note(`Call 3 through the backup: Suva received ${c4.rtp.received} (from ${c4.rtp.from}), Nadi received ${b4.received}`);
    assert.ok(c4.rtp.received > 30 && b4.received > 30); assert.match(c4.rtp.from, /^198\.51\.100\.20:/);
    await suva.ask('hangup', { from: '101' });
    // the main relay is reachable again: both sites go back to it by themselves
    t1 = Date.now();
    nsx('rly1', 'iptables -F INPUT'); nsx('rly1', 'iptables -F OUTPUT');
    await until(async () => (await connected(suva, 'syd1', 1)) && (await connected(nadi, 'syd1', 1)), 40000, 'fail back to the main relay');
    note(`Main relay back: both sites returned to it after ${Date.now() - t1} ms`);
    const c4b = await nadi.ask('call', { from: '201', to: '101', ms: 1200 });
    assert.equal(c4b.status, 200, JSON.stringify(c4b));
    note(`Call 4 through the main relay again: Nadi received ${c4b.rtp.received} (from ${c4b.rtp.from})`);
    assert.ok(c4b.rtp.received > 20); assert.match(c4b.rtp.from, /^198\.51\.100\.10:/);
    await nadi.ask('hangup', { from: '201' });
    // and the main relay is killed outright
    t1 = Date.now();
    r1.kill('SIGKILL');
    await until(async () => (await connected(suva, 'mel1', 1)) && (await connected(nadi, 'mel1', 1)), 30000, 'failover after a kill');
    took = Date.now() - t1;
    note(`Main relay killed: both sites on the backup after ${took} ms`);
    const c4c = await suva.ask('call', { from: '101', to: '201', ms: 1200 });
    assert.equal(c4c.status, 200, JSON.stringify(c4c));
    note(`Call 5 through the backup after the kill: Suva received ${c4c.rtp.received} (from ${c4c.rtp.from})`);
    assert.ok(c4c.rtp.received > 20);
    await suva.ask('hangup', { from: '101' });

    // 6. both relays down: calls inside the office still work (with sound); other sites get a clear answer
    r2.kill('SIGKILL');
    await until(async () => !(await suva.ask('status')).relay.connected, 15000, 'Suva notices');
    const c5 = await suva.ask('call', { from: '101', to: '102', ms: 1000 });
    assert.equal(c5.status, 200);
    const b5 = (await suva.ask('rtp', { ext: '102' })).rtp;
    note(`Both relays down: local call Suva 101 → 102: 101 received ${c5.rtp.received}, 102 received ${b5.received}`);
    assert.ok(c5.rtp.received > 20 && b5.received > 20);
    await suva.ask('hangup', { from: '101' });
    const c6 = await suva.ask('call', { from: '101', to: '201', ms: 100 });
    note(`Both relays down: Suva 101 → Nadi 201: ${c6.status} ${c6.reason}`);
    assert.equal(c6.status, 480); assert.match(c6.reason, /no connection to the Riyeser relay/);
    const out = process.env.RIYESER_NAT_EVIDENCE; if (out) fs.writeFileSync(out, `${evidence.join('\n')}\n\n--- logs ---\n${logs.join('\n')}\n`);
  } catch (e) {
    const out = process.env.RIYESER_NAT_EVIDENCE; if (out) fs.writeFileSync(out, `FAILED: ${e.stack}\n${evidence.join('\n')}\n\n--- logs ---\n${logs.join('\n')}\n`);
    t.diagnostic(logs.slice(-60).join('\n'));
    throw e;
  } finally {
    for (const p of procs) p.kill('SIGKILL');
    await wait(300);
    teardown(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
