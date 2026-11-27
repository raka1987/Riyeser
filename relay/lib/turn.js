// The relay's own STUN/TURN server (RFC 5389 / 8489 STUN, RFC 5766 / 8656 TURN, UDP relaying), so Riyeser Link's
// browser and app calls get through any NAT with no Google or other outside STUN/TURN, and so the relay runs the
// same on Windows and Linux (coturn doesn't run on Windows). Passwords are the TURN REST API kind
// (use-auth-secret, as coturn): username "<expiry>:<id>", password base64(HMAC-SHA1(turn secret, username)), made by
// the database (link_relay_turn). Over UDP and TCP (and TLS when the relay has a certificate browsers trust).
//
// Safety: only peers on the public internet can be reached (never this machine's own network, loopback or private
// addresses, unless allowPrivatePeers), only after the client asked for a permission, and allocations end after
// their lifetime (10 minutes unless refreshed). Payloads are never looked at or logged.
const dgram = require('dgram');
const net = require('net');
const tlsMod = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAGIC = 0x2112a442;
const M = { BINDING: 0x001, ALLOCATE: 0x003, REFRESH: 0x004, SEND: 0x006, DATA: 0x007, CREATE_PERMISSION: 0x008, CHANNEL_BIND: 0x009 };
const C = { REQUEST: 0x000, INDICATION: 0x010, SUCCESS: 0x100, ERROR: 0x110 };
const A = { MAPPED_ADDRESS: 0x0001, USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008, ERROR_CODE: 0x0009, UNKNOWN: 0x000a, CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d, XOR_PEER_ADDRESS: 0x0012, DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015, XOR_RELAYED_ADDRESS: 0x0016, REQUESTED_FAMILY: 0x0017,
  EVEN_PORT: 0x0018, REQUESTED_TRANSPORT: 0x0019, DONT_FRAGMENT: 0x001a, MI_SHA256: 0x001c, XOR_MAPPED_ADDRESS: 0x0020, RESERVATION_TOKEN: 0x0022,
  SOFTWARE: 0x8022, FINGERPRINT: 0x8028 };
const REASONS = { 300: 'Try Alternate', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 420: 'Unknown Attribute', 437: 'Allocation Mismatch', 438: 'Stale Nonce',
  440: 'Address Family not Supported', 441: 'Wrong Credentials', 442: 'Unsupported Transport Protocol', 486: 'Allocation Quota Reached', 508: 'Insufficient Capacity' };
const DEFAULT_LIFETIME = 600; const MAX_LIFETIME = 3600; const PERMISSION = 300 * 1000; const CHANNEL = 600 * 1000;

// ---------- the wire format ----------
const msgType = (method, cls) => (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | cls;
const splitType = (t) => ({ method: (t & 0x000f) | ((t & 0x00e0) >> 1) | ((t & 0x3e00) >> 2), cls: t & 0x0110 });
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) { CRC_TABLE = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
/** -> { method, cls, tid, attrs: [[type, Buffer, offset]], raw } or null */
function parse(buf) {
  if (buf.length < 20 || (buf[0] & 0xc0) !== 0 || buf.readUInt32BE(4) !== MAGIC) return null;
  const len = buf.readUInt16BE(2); if (len % 4 || buf.length < 20 + len) return null;
  const { method, cls } = splitType(buf.readUInt16BE(0));
  const attrs = []; let i = 20;
  while (i + 4 <= 20 + len) {
    const t = buf.readUInt16BE(i); const l = buf.readUInt16BE(i + 2);
    if (i + 4 + l > 20 + len) return null;
    attrs.push([t, buf.slice(i + 4, i + 4 + l), i]);
    i += 4 + l + ((4 - (l % 4)) % 4);
  }
  return { method, cls, tid: buf.slice(8, 20), attrs, raw: buf.slice(0, 20 + len) };
}
const attr = (m, t) => { const a = m.attrs.find((x) => x[0] === t); return a ? a[1] : null; };
function xorAddr(v, tid) {
  if (!v || v.length < 8) return null;
  const fam = v[1]; const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  if (fam !== 1) return { family: fam, port };
  const n = v.readUInt32BE(4) ^ MAGIC;
  return { family: 1, port, address: [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.') };
}
function encXorAddr({ address, port }) {
  const b = Buffer.alloc(8); b[1] = 1; b.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const n = address.split('.').reduce((a, x) => ((a << 8) | Number(x)) >>> 0, 0);
  b.writeUInt32BE((n ^ MAGIC) >>> 0, 4); return b;
}
/** Build a message. attrs: [[type, Buffer]]. key: add MESSAGE-INTEGRITY with it. Always adds FINGERPRINT. */
function build(method, cls, tid, attrs = [], key = null) {
  const parts = [];
  for (const [t, v] of attrs) { const h = Buffer.alloc(4); h.writeUInt16BE(t); h.writeUInt16BE(v.length, 2); parts.push(h, v, Buffer.alloc((4 - (v.length % 4)) % 4)); }
  let body = Buffer.concat(parts);
  const head = (extra) => { const h = Buffer.alloc(20); h.writeUInt16BE(msgType(method, cls)); h.writeUInt16BE(body.length + extra, 2); h.writeUInt32BE(MAGIC, 4); tid.copy(h, 8); return h; };
  if (key) {
    const mac = crypto.createHmac('sha1', key).update(Buffer.concat([head(24), body])).digest();
    const h = Buffer.alloc(4); h.writeUInt16BE(A.MESSAGE_INTEGRITY); h.writeUInt16BE(20, 2);
    body = Buffer.concat([body, h, mac]);
  }
  const fp = crc32(Buffer.concat([head(8), body])) ^ 0x5354554e;
  const f = Buffer.alloc(8); f.writeUInt16BE(A.FINGERPRINT); f.writeUInt16BE(4, 2); f.writeUInt32BE(fp >>> 0, 4);
  return Buffer.concat([head(8), body, f]);
}
/** Check MESSAGE-INTEGRITY with key. */
function integrityOk(m, key) {
  const a = m.attrs.find((x) => x[0] === A.MESSAGE_INTEGRITY); if (!a || a[1].length !== 20) return false;
  const off = a[2];
  const copy = Buffer.from(m.raw.slice(0, off)); copy.writeUInt16BE(off - 20 + 24, 2);
  const mac = crypto.createHmac('sha1', key).update(copy).digest();
  return crypto.timingSafeEqual(mac, a[1]);
}
const errAttr = (code, reason) => { const r = Buffer.from(reason || REASONS[code] || ''); const b = Buffer.alloc(4 + r.length); b[2] = Math.floor(code / 100); b[3] = code % 100; r.copy(b, 4); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const isPrivatePeer = (ip) => /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/.test(ip);

class TurnServer extends EventEmitter {
  /**
   * opts: { secret (the turn secret, hex), realm = 'riyeser', publicIp, bind = '0.0.0.0', port = 3478 (UDP and TCP),
   *         tls: { cert, key, port } (TURN over TLS), min = 50000, max = 50999 (relayed ports), allowPrivatePeers,
   *         maxPerUser = 10, log }
   */
  constructor(opts = {}) {
    super();
    this.secret = opts.secret; this.realm = opts.realm || 'riyeser';
    this.publicIp = opts.publicIp || '127.0.0.1'; this.bind = opts.bind || '0.0.0.0';
    this.port = opts.port == null ? 3478 : opts.port; this.tlsOpts = opts.tls || null;
    this.min = opts.min || 50000; this.max = opts.max || 50999; this.next = this.min;
    this.allowPrivatePeers = !!opts.allowPrivatePeers; this.maxPerUser = opts.maxPerUser || 10;
    this.logFn = opts.log || (() => {});
    this.nonceKey = crypto.randomBytes(32);
    this.allocs = new Map();    // 5-tuple key -> allocation
    this.byPort = new Map();    // relayed port -> allocation
    this.stats = { allocations: 0, refused: 0, packets: 0, bytes: 0, bindings: 0 };
  }
  log(l, t) { try { this.logFn(l, t); } catch { /* never mind */ } }
  async start() {
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', (b, r) => this.onPacket(b, { proto: 'udp', address: r.address, port: r.port, send: (x) => this.udp.send(x, r.port, r.address) }));
    this.udp.on('error', (e) => this.log('warn', `TURN (UDP): ${e.message}`));
    await new Promise((res, rej) => { this.udp.once('error', rej); this.udp.bind(this.port, this.bind, () => { this.udp.off('error', rej); res(); }); });
    this.port = this.udp.address().port;
    this.tcp = net.createServer((s) => this.onStream(s, 'tcp'));
    await new Promise((res) => { this.tcp.once('error', (e) => { this.log('warn', `TURN over TCP is off (${e.code}).`); this.tcp = null; res(); }); this.tcp.listen(this.port, this.bind, res); });
    if (this.tlsOpts && this.tlsOpts.cert && this.tlsOpts.key) {
      this.tls = tlsMod.createServer({ cert: this.tlsOpts.cert, key: this.tlsOpts.key, minVersion: 'TLSv1.2' }, (s) => this.onStream(s, 'tls'));
      this.tls.on('tlsClientError', () => {});
      await new Promise((res) => { this.tls.once('error', (e) => { this.log('warn', `TURN over TLS is off (${e.code}).`); this.tls = null; res(); }); this.tls.listen(this.tlsOpts.port || 5349, this.bind, res); });
      if (this.tls) this.tlsPort = this.tls.address().port;
    }
    this.sweeper = setInterval(() => this.sweep(), 5000); this.sweeper.unref();
    return this;
  }
  async stop() {
    clearInterval(this.sweeper);
    for (const a of [...this.allocs.values()]) this.free(a);
    const close = (s) => s && new Promise((r) => { try { s.close(() => r()); } catch { r(); } });
    await Promise.all([close(this.udp), close(this.tcp), close(this.tls)]);
  }
  setPublicIp(ip) { if (ip) this.publicIp = ip; }

  onStream(sock, proto) {
    sock.on('error', () => {}); sock.setNoDelay(true);
    const address = String(sock.remoteAddress).replace(/^::ffff:/, ''); const port = sock.remotePort;
    const src = { proto, address, port, sock, send: (x) => { if (!sock.destroyed) sock.write(x.length % 4 && x[0] >= 0x40 && x[0] <= 0x7f ? Buffer.concat([x, Buffer.alloc(4 - (x.length % 4))]) : x); } };
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        let total;
        if (buf[0] >= 0x40 && buf[0] <= 0x7f) { const l = buf.readUInt16BE(2); total = 4 + l + ((4 - (l % 4)) % 4); }
        else total = 20 + buf.readUInt16BE(2);
        if (total > 65535 + 20) { sock.destroy(); return; }
        if (buf.length < total) return;
        const one = buf.slice(0, total); buf = buf.slice(total);
        this.onPacket(one, src);
      }
    });
    sock.on('close', () => { const a = this.allocs.get(this.key(src)); if (a) this.free(a); });
    sock.setTimeout(10 * 60 * 1000, () => sock.destroy());
  }
  key(src) { return `${src.proto}|${src.address}|${src.port}`; }

  onPacket(buf, src) {
    if (buf.length >= 4 && buf[0] >= 0x40 && buf[0] <= 0x7f) return this.onChannelData(buf, src);
    const m = parse(buf); if (!m) return;
    if (m.method === M.BINDING && m.cls === C.REQUEST) {
      this.stats.bindings++;
      return src.send(build(M.BINDING, C.SUCCESS, m.tid, [[A.XOR_MAPPED_ADDRESS, encXorAddr(src)], [A.SOFTWARE, Buffer.from('Riyeser relay')]]));
    }
    if (m.cls === C.INDICATION) { if (m.method === M.SEND) this.onSend(m, src); return; }
    if (m.cls !== C.REQUEST) return;
    // everything else needs the long-term credential (REST API username and password)
    const user = attr(m, A.USERNAME); const nonce = attr(m, A.NONCE); const realm = attr(m, A.REALM);
    const challenge = (code) => src.send(build(m.method, C.ERROR, m.tid, [[A.ERROR_CODE, errAttr(code)], [A.REALM, Buffer.from(this.realm)], [A.NONCE, Buffer.from(this.nonce())]]));
    if (!user || !nonce || !realm || !attr(m, A.MESSAGE_INTEGRITY)) return challenge(401);
    if (!this.nonceOk(nonce.toString())) return challenge(438);
    const username = user.toString('utf8');
    const exp = Number(username.split(':')[0]);
    const password = crypto.createHmac('sha1', this.secret).update(username).digest('base64');
    const key = crypto.createHash('md5').update(`${username}:${this.realm}:${password}`).digest();
    if (!integrityOk(m, key) || realm.toString() !== this.realm) { this.stats.refused++; this.emit('auth-failed', src.address); return challenge(401); }
    if (!(exp * 1000 > Date.now())) { this.stats.refused++; this.log('info', `TURN: refused an expired password from ${src.address}.`); return challenge(401); }
    const ok = (attrs) => src.send(build(m.method, C.SUCCESS, m.tid, attrs, key));
    const err = (code, reason) => src.send(build(m.method, C.ERROR, m.tid, [[A.ERROR_CODE, errAttr(code, reason)]], key));
    const a = this.allocs.get(this.key(src));
    switch (m.method) {
      case M.ALLOCATE: {
        if (a) { if (a.tid.equals(m.tid)) return ok(a.okAttrs); return err(437); }
        const rt = attr(m, A.REQUESTED_TRANSPORT); if (!rt || rt[0] !== 17) return err(442);
        const fam = attr(m, A.REQUESTED_FAMILY); if (fam && fam[0] !== 1) return err(440);
        if (attr(m, A.EVEN_PORT) || attr(m, A.RESERVATION_TOKEN)) { /* not needed by browsers: ignore and give any port */ }
        const id = username.slice(username.indexOf(':') + 1);
        if ([...this.allocs.values()].filter((x) => x.user === id).length >= this.maxPerUser) return err(486);
        return this.allocate(src, m, username, id, key, ok, err);
      }
      case M.REFRESH: {
        if (!a) return err(437);
        const lt = attr(m, A.LIFETIME); let life = lt ? lt.readUInt32BE(0) : DEFAULT_LIFETIME;
        if (life === 0) { this.free(a); return ok([[A.LIFETIME, u32(0)]]); }
        life = Math.min(MAX_LIFETIME, Math.max(DEFAULT_LIFETIME, life)); a.expires = Date.now() + life * 1000; a.username = username;
        return ok([[A.LIFETIME, u32(life)]]);
      }
      case M.CREATE_PERMISSION: {
        if (!a) return err(437);
        const peers = m.attrs.filter((x) => x[0] === A.XOR_PEER_ADDRESS).map((x) => xorAddr(x[1], m.tid));
        if (!peers.length || peers.some((p) => !p || p.family !== 1)) return err(400);
        if (peers.some((p) => !this.peerAllowed(p.address))) return err(403, 'Forbidden (that address is not on the internet)');
        for (const p of peers) a.perms.set(p.address, Date.now() + PERMISSION);
        return ok([]);
      }
      case M.CHANNEL_BIND: {
        if (!a) return err(437);
        const ch = attr(m, A.CHANNEL_NUMBER); const p = xorAddr(attr(m, A.XOR_PEER_ADDRESS), m.tid);
        if (!ch || !p || p.family !== 1) return err(400);
        const n = ch.readUInt16BE(0); if (n < 0x4000 || n > 0x7ffe) return err(400);
        if (!this.peerAllowed(p.address)) return err(403);
        const pk = `${p.address}:${p.port}`;
        const byN = a.channels.get(n); if (byN && byN.peer !== pk) return err(400);
        for (const [k, c] of a.channels) if (c.peer === pk && k !== n) return err(400);
        a.channels.set(n, { peer: pk, address: p.address, port: p.port, expires: Date.now() + CHANNEL });
        a.perms.set(p.address, Date.now() + PERMISSION);
        return ok([]);
      }
      default: return err(400);
    }
  }
  peerAllowed(ip) { return this.allowPrivatePeers || !isPrivatePeer(ip) || ip === this.publicIp; }
  nonce() { const ts = Date.now().toString(16); return `${ts}${crypto.createHmac('sha256', this.nonceKey).update(ts).digest('hex').slice(0, 16)}`; }
  nonceOk(n) {
    const m = /^([0-9a-f]{8,13})([0-9a-f]{16})$/.exec(n); if (!m) return false;
    const want = crypto.createHmac('sha256', this.nonceKey).update(m[1]).digest('hex').slice(0, 16);
    return want === m[2] && Date.now() - parseInt(m[1], 16) < 10 * 60 * 1000;
  }
  async allocate(src, m, username, id, key, ok, err) {
    let sock = null; let port = 0;
    for (let tries = 0; tries <= this.max - this.min && !sock; tries++) {
      const p = this.next; this.next = this.next >= this.max ? this.min : this.next + 1;
      if (this.byPort.has(p)) continue;
      sock = await new Promise((res) => { const s = dgram.createSocket('udp4'); s.once('error', () => { try { s.close(); } catch { /* */ } res(null); }); s.bind(p, this.bind, () => res(s)); });
      if (sock) port = p;
    }
    if (!sock) return err(508);
    const lt = attr(m, A.LIFETIME); const life = Math.min(MAX_LIFETIME, Math.max(DEFAULT_LIFETIME, lt ? lt.readUInt32BE(0) : DEFAULT_LIFETIME));
    const a = { key: this.key(src), src, sock, port, user: id, username, tid: m.tid, perms: new Map(), channels: new Map(), expires: Date.now() + life * 1000 };
    a.okAttrs = [[A.XOR_RELAYED_ADDRESS, encXorAddr({ address: this.publicIp, port })], [A.LIFETIME, u32(life)], [A.XOR_MAPPED_ADDRESS, encXorAddr(src)], [A.SOFTWARE, Buffer.from('Riyeser relay')]];
    sock.on('error', () => {});
    sock.on('message', (data, r) => this.fromPeer(a, data, r.address, r.port));
    this.allocs.set(a.key, a); this.byPort.set(port, a); this.stats.allocations++;
    ok(a.okAttrs);
  }
  free(a) {
    if (this.allocs.get(a.key) === a) this.allocs.delete(a.key);
    if (this.byPort.get(a.port) === a) this.byPort.delete(a.port);
    try { a.sock.close(); } catch { /* closed */ }
  }
  /** Send from an allocation to a peer. A peer that is one of our own allocations is delivered directly (no hairpin). */
  toPeer(a, data, address, port) {
    const p = a.perms.get(address); if (!p || p < Date.now()) return;
    this.stats.packets++; this.stats.bytes += data.length;
    const mine = address === this.publicIp && this.byPort.get(port);
    if (mine) return this.fromPeer(mine, data, this.publicIp, a.port);
    a.sock.send(data, port, address);
  }
  fromPeer(a, data, address, port) {
    const p = a.perms.get(address); if (!p || p < Date.now()) return;
    for (const [n, c] of a.channels) if (c.address === address && c.port === port && c.expires > Date.now()) {
      const h = Buffer.alloc(4); h.writeUInt16BE(n); h.writeUInt16BE(data.length, 2);
      a.src.send(Buffer.concat([h, data])); return;
    }
    a.src.send(build(M.DATA, C.INDICATION, crypto.randomBytes(12), [[A.XOR_PEER_ADDRESS, encXorAddr({ address, port })], [A.DATA, data]]));
  }
  onSend(m, src) {
    const a = this.allocs.get(this.key(src)); if (!a) return;
    const p = xorAddr(attr(m, A.XOR_PEER_ADDRESS), m.tid); const d = attr(m, A.DATA);
    if (p && d && p.family === 1) this.toPeer(a, d, p.address, p.port);
  }
  onChannelData(buf, src) {
    const a = this.allocs.get(this.key(src)); if (!a) return;
    const n = buf.readUInt16BE(0); const l = buf.readUInt16BE(2);
    const c = a.channels.get(n); if (!c || c.expires < Date.now() || buf.length < 4 + l) return;
    this.toPeer(a, buf.slice(4, 4 + l), c.address, c.port);
  }
  sweep() {
    const now = Date.now();
    for (const a of [...this.allocs.values()]) {
      if (a.expires < now) { this.free(a); continue; }
      for (const [ip, t] of a.perms) if (t < now) a.perms.delete(ip);
      for (const [n, c] of a.channels) if (c.expires < now) a.channels.delete(n);
    }
  }
  snapshot() { return { allocations: this.allocs.size, ...this.stats }; }
}

module.exports = { TurnServer, parse, build, encXorAddr, xorAddr, integrityOk, crc32, M, C, A };
