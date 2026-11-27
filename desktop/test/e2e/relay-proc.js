// The relay, as its own process (inside a network namespace in link-relay-nat.test.js). Config in argv[2] (JSON).
// Commands on stdin (one JSON a line): { cmd: 'plan', plan } | { cmd: 'stats' } | { cmd: 'outside' } (1.3.1: ports from outside). Answers on stdout, one JSON a line.
const { createRelayServer } = require('../../src/relay/server');
const cfg = JSON.parse(process.argv[2]);
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const cloud = { plan: cfg.plan, state: { ok: true } };
cloud.sync = async () => JSON.parse(JSON.stringify(cloud.plan));
cloud.start = async (onPlan) => { cloud.onPlan = onPlan; await onPlan(await cloud.sync()); };
(async () => {
  const s = createRelayServer({ id: cfg.id, region: cfg.region, host: `${cfg.id}.relay.test`, secret: cfg.secret, httpPort: 8080, httpBind: '0.0.0.0', trustProxy: false,
    sipTlsPort: false, selfSigned: false, certDir: cfg.dir, mediaMin: 40002, mediaMax: 40999, probePort: 40000, mediaBind: '0.0.0.0', publicIp: '',
    turn: { enabled: true, port: 3478, tlsPort: false, min: 50000, max: 50199, bind: '0.0.0.0' }, ddns: {}, peers: cfg.peers || [], cloud, natPmp: async () => null,
    limiter: { perMinute: 1000, maxFails: 1000 }, log: (l, t) => say({ log: `${l} ${t}` }) });
  await s.start();
  say({ ready: true, ip: s.ip, ports: s.ports });
  let buf = '';
  process.stdin.on('data', async (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.cmd === 'plan') { cloud.plan = m.plan; await cloud.onPlan(await cloud.sync()); say({ id: m.id, ok: true }); }
      if (m.cmd === 'outside') say({ id: m.id, outside: await s.outsideCheck() });
      if (m.cmd === 'stats') say({ id: m.id, media: s.media.snapshot(), relay: s.relay.snapshot(), turn: s.turn ? s.turn.snapshot() : null });
    }
  });
})().catch((e) => { say({ error: e.message }); process.exit(1); });
