// A Link Office site, as its own process (inside a network namespace behind its own NAT in link-relay-nat.test.js):
// the real PBX and relay link, and simulated desk phones on the office network that send and count sound (RTP).
// Config in argv[2] (JSON): { name, office, ws, host, phones: [{ ext, bind }], relays, tokens, timing }.
// Commands on stdin: { cmd: 'status' } | { cmd: 'call', from, to, ms } | { cmd: 'hangup', from } — answers on stdout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../../src/core/store');
const { Directory } = require('../../src/link/directory');
const { Pbx } = require('../../src/link/pbx');
const { Trunks } = require('../../src/link/trunks');
const { RelayLink } = require('../../src/link/relay');
const { SimUA } = require('../../src/link/simua');
const cfg = JSON.parse(process.argv[2]);
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `riyeser-nat-${cfg.name}-`));
  const directory = new Directory(new Store(dir));
  for (const [ext, name] of cfg.people) directory.addPerson({ name, ext });
  const trunks = new Trunks();
  const pbx = await new Pbx({ directory, host: cfg.host, port: cfg.port || 5060, bind: cfg.host, tcp: false, multicast: false, trunks, ringTimeout: 20000, log: (l, t) => say({ log: `${l} ${t}` }) }).start();
  const link = new RelayLink({ getConfig: async () => ({ enabled: true, relays: cfg.relays, tokens: cfg.tokens, exp: Math.floor(Date.now() / 1000) + 3600 }), siteName: () => cfg.name,
    timing: cfg.timing, probe: true, callsInProgress: () => pbx.callsInProgress().length, log: (l, t) => say({ log: `${l} ${t}` }) });
  trunks.add(link); await link.start({ pbx });
  pbx.on('change', () => link.setExts([...pbx.bindings.keys()]));
  const phones = {};
  for (const p of cfg.phones) {
    const u = await new SimUA({ ext: p.ext, password: directory.password(p.ext), server: { host: cfg.host, port: cfg.port || 5060 }, bind: p.bind, rtp: true, answerDelay: 80 }).start();
    const r = await u.register(); if (r.status !== 200) throw new Error(`${p.ext} didn't register (${r.status})`);
    phones[p.ext] = u;
  }
  const calls = {};
  say({ ready: true });
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      (async () => {
        if (m.cmd === 'status') return say({ id: m.id, relay: link.status(), regs: [...pbx.bindings.keys()] });
        if (m.cmd === 'call') {
          const u = phones[m.from];
          const { call, final } = await u.dial(m.to);
          if (final.status !== 200) return say({ id: m.id, status: final.status, reason: final.reason });
          calls[m.from] = call;
          await new Promise((r) => setTimeout(r, m.ms || 1000));
          return say({ id: m.id, status: 200, rtp: u.rtpStats(call.id) });
        }
        if (m.cmd === 'rtp') { const u = phones[m.ext]; return say({ id: m.id, rtp: u.rtpStats() }); }
        if (m.cmd === 'hangup') { const u = phones[m.from]; const r = await u.bye(calls[m.from]); return say({ id: m.id, status: r.status }); }
      })().catch((e) => say({ id: m.id, error: e.message }));
    }
  });
})().catch((e) => { say({ error: e.message }); process.exit(1); });
