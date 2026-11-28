// Shared set-up for the Riyeser relay tests (1.3.0): the real relay (src/relay, the same code as relay/ on main)
// on this PC, Link Office sites (the real PBX and RelayLink) and simulated phones that send and count sound.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/core/store');
const { Directory } = require('../src/link/directory');
const { Pbx } = require('../src/link/pbx');
const { Trunks } = require('../src/link/trunks');
const { RelayLink } = require('../src/link/relay');
const { SimUA } = require('../src/link/simua');
const { createRelayServer } = require('../src/relay/server');
const tokens = require('../src/relay/lib/tokens');
const dgram = require('dgram');

const SECRET = 'link-office-test-relay-secret-0123456789abcdef';
const WS = 'aaaaaaaa-0000-4000-8000-00000000000a';
const WS2 = 'bbbbbbbb-0000-4000-8000-00000000000b';
const OFFICES = { suva: 'lo-suva-00000001', nadi: 'lo-nadi-00000002', other: 'lo-other-0000003' };
// Each relay gets 200 UDP ports for sound. They are taken from 20000-32699: below the ports Windows (49152 up) and
// Linux (32768 up) hand out by themselves, where Windows can also reserve whole blocks (Hyper-V / WinNAT excluded
// port ranges) that can't be bound at all. A relay whose range is unusable answers every call "503 relay busy"
// ("No free media ports on the relay"): CI run 46114154487. Each range is checked before use; a taken one is skipped.
const MEDIA_LO = 20000; const MEDIA_HI = 32700; const SPAN = 220;
let base = MEDIA_LO + (process.pid % 50) * SPAN;
const bindable = (port, bind) => new Promise((ok) => { const s = dgram.createSocket('udp4'); s.once('error', () => { s.close(); ok(false); }); s.bind(port, bind, () => s.close(() => ok(true))); });
async function mediaRange(bind) {
  for (let tries = 0; tries < (MEDIA_HI - MEDIA_LO) / SPAN; tries++) {
    if (base + 200 > MEDIA_HI) base = MEDIA_LO;
    const b = base; base += SPAN;
    let free = true;
    for (let p = b; p < b + 200 && free; p++) free = await bindable(p, bind);
    if (free) return b;
  }
  throw new Error('no free range of 200 UDP ports for the test relay');
}

function plan(over = {}) {
  return { ok: true, relays: over.relays || [], businesses: over.businesses || [
    { ws: WS, enabled: true, offices: [{ office_id: OFFICES.suva, gen: 1, name: 'Suva' }, { office_id: OFFICES.nadi, gen: 1, name: 'Nadi' }], devices: [],
      groups: [{ ext: '100', members: ['101', '102', '201'] }] },
    { ws: WS2, enabled: true, offices: [{ office_id: OFFICES.other, gen: 1, name: 'Other' }], devices: [], groups: [] }] };
}
function fakeCloud(p) {
  const c = { plan: p, state: { ok: true } };
  c.sync = async () => JSON.parse(JSON.stringify(c.plan));
  c.start = async (onPlan, onRemoved) => { c.onPlan = onPlan; c.onRemoved = onRemoved; await onPlan(await c.sync()); };
  c.removed = () => { c.state = { ok: false, removed: true, error: 'This relay has been removed from Riyeser (RELAY_REMOVED).' }; if (c.onRemoved) c.onRemoved(c.state.error); };   // 1.3.1
  c.push = async (np) => { if (np) c.plan = np; await c.onPlan(await c.sync()); };
  return c;
}

/** The relay. opts: { id, region, httpPort, peers, bind, publicIp, p } */
async function relay({ id = 'syd1', region = 'Sydney', httpPort = 0, peers = [], bind = '127.0.0.1', publicIp = '127.0.0.1', p = plan(), log, secret = SECRET, probePort = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-relay-'));
  const b = await mediaRange(bind);
  const cloud = fakeCloud(p);
  const s = createRelayServer({ id, region, host: `${id}.relay.test`, secret, httpPort, httpBind: bind, trustProxy: false, sipTlsPort: false, selfSigned: false, certDir: dir,
    mediaMin: b, mediaMax: b + 199, probePort, mediaBind: bind, publicIp, turn: { enabled: false }, ddns: {}, peers, cloud,
    limiter: { perMinute: 1000, maxFails: 1000 }, log: log || (process.env.RELAY_LOG ? (l, t) => console.log(id, l, t) : () => {}) });
  await s.start();
  s.dir = dir; s.fakeCloud = cloud; s.url = `ws://${bind}:${s.ports.http}/link/v1`;
  s.close = async () => { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); };
  return s;
}
const pass = (office, { ws = WS, gen = 1, relayId = 'syd1', ttl = 3600 } = {}) =>
  tokens.sign(tokens.keys(SECRET).office, { v: 1, r: relayId, ws, o: office, g: gen, exp: Math.floor(Date.now() / 1000) + ttl });

/**
 * A Link Office site: its directory (the same people at every site, as Riyeser Link syncs them), its PBX and its
 * relay link. relays: [{ id, url, host, region }] in order. bind: the PBX's address.
 */
async function site(name, { office, relays, ws = WS, bind = '127.0.0.1', host = bind, timing = { pingEvery: 400, deadAfter: 1500, failbackEvery: 800 }, people } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `riyeser-site-${name}-`));
  const store = new Store(dir); const directory = new Directory(store);
  for (const [ext, n] of people || [['101', 'Alex Suva'], ['102', 'Bo Suva'], ['201', 'Ned Nadi'], ['202', 'Nia Nadi']]) directory.addPerson({ name: n, ext });
  directory.addGroup({ name: 'Everyone', ext: '100', members: ['101', '102', '201'] });
  const trunks = new Trunks();
  const pbx = await new Pbx({ directory, host, port: 0, bind, tcp: false, multicast: false, trunks, ringTimeout: 20000 }).start();
  const cfg = { enabled: true, relays, tokens: Object.fromEntries(relays.map((r) => [r.id, pass(office, { ws, relayId: r.id })])), exp: Math.floor(Date.now() / 1000) + 3600 };
  const link = new RelayLink({ getConfig: async () => cfg, siteName: () => name, timing, probe: false, callsInProgress: () => pbx.callsInProgress().length });
  trunks.add(link);
  await link.start({ pbx });
  const exts = () => link.setExts([...pbx.bindings.keys()]);
  pbx.on('change', exts);
  const uas = [];
  const ua = async (ext, opts = {}) => {
    const u = await new SimUA({ ext, password: directory.password(ext), server: { host, port: pbx.port }, bind: opts.bind || bind, rtp: true, answerDelay: 60, ...opts }).start();
    uas.push(u); if (opts.register !== false) { const r = await u.register(); if (r.status !== 200) throw new Error(`${ext} didn't register: ${r.status}`); }
    return u;
  };
  const close = async () => { for (const u of uas) await u.stop(); await link.stop(); await pbx.stop(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { name, dir, directory, pbx, link, cfg, ua, close, exts };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 8000, what = 'it') { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return true; await wait(25); } throw new Error(`timed out waiting for ${what}`); }
/** Place a call and check sound flows both ways for `ms`. -> { call, a: stats, b: stats } */
async function talk(from, to, number, { ms = 600 } = {}) {
  // listen for the ring before dialling, and stop listening either way (no timer left behind if the call fails)
  let rang = false; const onInvite = () => { rang = true; };
  to.on('invite', onInvite);
  let call; let final;
  try {
    ({ call, final } = await from.dial(number));
    if (final.status !== 200) throw Object.assign(new Error(`call to ${number}: ${final.status} ${final.reason}`), { final });
    await until(() => rang, 8000, `${to.ext} to ring`);
  } finally { to.off('invite', onInvite); }
  const callee = [...to.calls.values()].pop();
  await wait(ms);
  const a = from.rtpStats(call.id); const b = to.rtpStats(callee.id);
  return { call, callee, a, b, final };
}

module.exports = { SECRET, WS, WS2, OFFICES, plan, relay, site, pass, wait, until, talk };
