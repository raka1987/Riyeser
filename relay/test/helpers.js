// Shared set-up for the relay tests: relays on spare ports on this machine, a fixed plan (what relay_sync would
// return), office passes made the way the database makes them, and a pretend Link Office that speaks the relay
// protocol directly (so the relay can be tested on its own; the real Link Office is tested in desktop/test).
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { createRelayServer } = require('../server');
const tokens = require('../lib/tokens');
const ws = require('../lib/ws');
const sip = require('../lib/sip');

const SECRET = 'test-relay-secret-0123456789abcdef0123456789';
const WS_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const WS_B = 'bbbbbbbb-0000-4000-8000-000000000002';
let portBase = 41000 + (process.pid % 50) * 160;

function plan(over = {}) {
  return {
    ok: true, relays: over.relays || [],
    businesses: over.businesses || [
      { ws: WS_A, enabled: true, offices: [{ office_id: 'lo-suva-0001', gen: 1, name: 'Suva' }, { office_id: 'lo-nadi-0002', gen: 1, name: 'Nadi' }],
        devices: [{ user: 'rhome00001', ext: '103', ha1: sip.md5('rhome00001:riyeser-relay:home-phone-pass-1'), label: 'Cam at home' }],
        groups: [{ ext: '100', members: ['101', '201', '103'] }] },
      { ws: WS_B, enabled: true, offices: [{ office_id: 'lo-other-0003', gen: 1, name: 'Other' }], devices: [], groups: [] },
    ],
  };
}

/** A fake Riyeser online: the plan can be changed by the test, sync() is instant. */
function fakeCloud(p) {
  const c = { plan: p, state: { ok: true, at: new Date().toISOString() }, calls: 0 };
  c.sync = async () => { c.calls++; return JSON.parse(JSON.stringify(c.plan)); };
  c.start = async (onPlan) => { c.onPlan = onPlan; await onPlan(await c.sync()); };
  c.push = async (np) => { if (np) c.plan = np; await c.onPlan(await c.sync()); };
  return c;
}

async function makeRelay({ id = 'syd1', region = 'Sydney', p = plan(), peers = [], turn = true, limits, limiter = { perMinute: 1000, maxFails: 1000 } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-relay-test-'));
  const base = portBase; portBase += 160;
  const cloud = fakeCloud(p);
  const s = createRelayServer({
    id, region, host: `${id}.relay.test`, secret: SECRET, httpPort: 0, httpBind: '127.0.0.1', httpsPort: 0, httpsBind: '127.0.0.1', trustProxy: false,
    sipTlsPort: 0, sipBind: '127.0.0.1', selfSigned: true, certDir: dir, mediaMin: base, mediaMax: base + 99, probePort: 0, mediaBind: '127.0.0.1', publicIp: '127.0.0.1',
    turn: turn ? { enabled: true, port: 0, tlsPort: false, min: base + 100, max: base + 159, bind: '127.0.0.1', allowPrivatePeers: true } : { enabled: false },
    metricsToken: 'metrics-test-token', ddns: {}, peers, cloud, limits, limiter, log: process.env.RELAY_LOG ? (l, t) => console.log(id, l, t) : () => {},
  });
  await s.start();
  s.dir = dir; s.fakeCloud = cloud;
  s.url = `ws://127.0.0.1:${s.ports.http}/link/v1`;
  s.close = async () => { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); };
  return s;
}

/** An office pass, as link_relay_token makes it. */
const pass = ({ ws: w = WS_A, office = 'lo-suva-0001', gen = 1, relay = 'syd1', ttl = 3600 } = {}) =>
  tokens.sign(tokens.keys(SECRET).office, { v: 1, r: relay, ws: w, o: office, g: gen, exp: Math.floor(Date.now() / 1000) + ttl });

/** A pretend Link Office: connects, announces extensions, and lets the test send and receive SIP. */
class FakeSite {
  constructor(name) { this.name = name; this.sips = []; this.jsons = []; this.waiters = []; }
  async connect(url, token, opts = {}) {
    this.conn = await ws.connect(url, { headers: { Authorization: `Bearer ${token}`, 'X-Riyeser-Site': this.name }, ...opts });
    this.conn.on('message', (d, bin) => { if (bin) this.sips.push(sip.parse(d)); else this.jsons.push(JSON.parse(d)); this.waiters.forEach((w) => w()); });
    this.conn.on('close', (code, why) => { this.closed = { code, why }; this.waiters.forEach((w) => w()); });
    await this.wait(() => this.jsons.find((j) => j.t === 'welcome'));
    return this;
  }
  exts(list) { this.conn.sendJson({ t: 'exts', exts: list, name: this.name }); }
  send(msg) { this.conn.send(sip.serialize(msg)); }
  wait(fn, timeout = 4000) {
    return new Promise((resolve, reject) => {
      const check = () => { const v = fn(); if (v) { this.waiters = this.waiters.filter((w) => w !== check); clearTimeout(t); resolve(v); } };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== check); reject(new Error(`${this.name}: timed out`)); }, timeout);
      this.waiters.push(check); check();
    });
  }
  waitSip(pred, timeout) { return this.wait(() => { const i = this.sips.findIndex(pred); return i >= 0 ? this.sips.splice(i, 1)[0] : null; }, timeout); }
  routes() { return [...this.jsons].reverse().find((j) => j.t === 'routes'); }
  close() { if (this.conn) this.conn.close(); }
}

const SDP = (ip, port) => `v=0\r\no=- 1 1 IN IP4 ${ip}\r\ns=-\r\nc=IN IP4 ${ip}\r\nt=0 0\r\nm=audio ${port} RTP/AVP 0 8\r\na=rtpmap:0 PCMU/8000\r\na=rtcp:${port + 1} IN IP4 ${ip}\r\na=candidate:1 1 UDP 1 ${ip} ${port} typ host\r\na=sendrecv\r\n`;
function invite({ from = '101', to = '201', callId = sip.newCallId('t'), sdp = SDP('192.168.1.20', 4000), host = 'syd1.relay.test' } = {}) {
  return { method: 'INVITE', uri: `sip:${to}@${host}`, headers: [['via', `SIP/2.0/UDP 192.168.1.10:5060;branch=${sip.newBranch()};rport`], ['max-forwards', '70'],
    ['record-route', '<sip:192.168.1.10:5060;lr>'], ['from', `<sip:${from}@192.168.1.10>;tag=${sip.newTag()}`], ['to', `<sip:${to}@192.168.1.10>`], ['call-id', callId],
    ['cseq', '1 INVITE'], ['contact', `<sip:${from}@192.168.1.20:5060>`], ['content-type', 'application/sdp']], body: Buffer.from(sdp) };
}
/** Answer a request the way a Link Office passes on its phone's answer (adds the phone's To tag and Contact). */
function answer(req, status, { tag = 'callee1', sdp, contact = '<sip:201@192.168.1.30:5060>' } = {}) {
  const res = sip.response(req, status, null, { toTag: tag, headers: status >= 200 && status < 300 ? [['contact', contact], ...(sdp ? [['content-type', 'application/sdp']] : [])] : [], body: sdp ? Buffer.from(sdp) : undefined });
  return res;
}
const sdpAddr = (body) => ({ ip: (/^c=IN IP4 (\S+)/m.exec(String(body)) || [])[1], port: Number((/^m=audio (\d+)/m.exec(String(body)) || [])[1]) });
const udp = async (addr = '127.0.0.1') => { const s = dgram.createSocket('udp4'); await new Promise((r) => s.bind(0, addr, r)); s.got = []; s.on('message', (m, r) => s.got.push({ m, r })); return s; };
/** An RTP packet (12-byte header) carrying some text, so tests can see whose sound arrived. */
const rtp = (text) => Buffer.concat([Buffer.from([0x80, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]), Buffer.from(text)]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 4000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return true; await wait(20); } throw new Error('timed out waiting'); }

module.exports = { SECRET, WS_A, WS_B, plan, fakeCloud, makeRelay, pass, FakeSite, invite, answer, SDP, sdpAddr, udp, rtp, wait, until };
