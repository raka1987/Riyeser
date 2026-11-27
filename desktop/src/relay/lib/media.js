// The relay's sound path for calls between sites (rtpengine-style media anchoring with latching).
// For each call, each side (the caller's and the called side) gets its own UDP port pair on the relay (RTP, and the
// next port for RTCP). The SDP each side receives is rewritten to point at its own port on the relay, so every phone
// sends its sound to the relay. The first packet from a side "latches" its real address (its router's NAT mapping),
// and the other side's packets are sent back to exactly that address. So it works behind any NAT, phones need no
// ICE/STUN, and the payload is never looked at, logged or kept.
const dgram = require('dgram');
const { EventEmitter } = require('events');

const IDLE_BEFORE_ANSWER = 2 * 60 * 1000;
const IDLE_TALKING = 60 * 60 * 1000;      // on hold for a long time still counts
const SIDES = ['a', 'b'];
const other = (s) => (s === 'a' ? 'b' : 'a');

class Media extends EventEmitter {
  /** opts: { publicIp, bind = '0.0.0.0', min = 40002, max = 49999, probePort (UDP echo for Link Office's check), log } */
  constructor(opts = {}) {
    super();
    this.publicIp = opts.publicIp || '127.0.0.1';
    this.bind = opts.bind || '0.0.0.0';
    this.min = opts.min || 40002; this.max = opts.max || 49999;
    this.probePort = opts.probePort == null ? 40000 : opts.probePort;
    this.logFn = opts.log || (() => {});
    this.sessions = new Map();   // key -> session
    this.used = new Set();
    this.next = this.min + (this.min % 2);
    this.stats = { sessions: 0, packets: 0, bytes: 0, dropped: 0 };
  }
  log(l, t) { try { this.logFn(l, t); } catch { /* never mind */ } }
  async start() {
    if (this.probePort !== false) {
      this.probe = dgram.createSocket('udp4');
      this.probe.on('message', (m, r) => {
        const tag = m.length >= 8 ? m.slice(0, 8).toString() : '';
        if (tag === 'RYPROBE1' && m.length <= 64) this.probe.send(Buffer.concat([Buffer.from('RYPROBE1'), m.slice(8), Buffer.from(` ${r.address}:${r.port}`)]), r.port, r.address);
        // 1.1.0: Link Office's test call (echo): a call's worth of sound (20 ms packets, up to 64 a second from one
        // address) comes straight back, so it can measure the round trip and loss, and hear its own tone
        else if (tag === 'RYECHO1 ' && m.length <= 300 && this.echoAllowed(r.address)) { this.stats.echoed = (this.stats.echoed || 0) + 1; this.probe.send(m, r.port, r.address); }
      });
      this.probe.on('error', (e) => this.log('warn', `UDP probe: ${e.message}`));
      await new Promise((res, rej) => { this.probe.once('error', rej); this.probe.bind(this.probePort, this.bind, () => { this.probe.off('error', rej); res(); }); });
      this.probePort = this.probe.address().port;
    }
    this.sweeper = setInterval(() => this.sweep(), 10000); this.sweeper.unref();
    return this;
  }
  async stop() {
    clearInterval(this.sweeper);
    for (const k of [...this.sessions.keys()]) this.close(k);
    if (this.probe) await new Promise((r) => { try { this.probe.close(() => r()); } catch { r(); } });
  }
  setPublicIp(ip) { if (ip) this.publicIp = ip; }
  /** The echo test's limit: 64 packets a second from one address (no use for flooding anyone). */
  echoAllowed(ip) {
    const now = Date.now(); this.echoes = this.echoes || new Map();
    let e = this.echoes.get(ip); if (!e || now - e.at > 1000) { e = { at: now, n: 0 }; this.echoes.set(ip, e); if (this.echoes.size > 1000) this.echoes.clear(); }
    return ++e.n <= 64;
  }

  async openPair() {
    const span = this.max - this.min;
    for (let tries = 0; tries < span / 2; tries++) {
      const p = this.next; this.next += 2; if (this.next > this.max - 1) this.next = this.min + (this.min % 2);
      if (this.used.has(p)) continue;
      try {
        const rtp = await bindUdp(p, this.bind); let rtcp;
        try { rtcp = await bindUdp(p + 1, this.bind); } catch (e) { rtp.close(); continue; }
        this.used.add(p);
        return { port: p, rtp, rtcp };
      } catch { /* taken by something else: try the next */ }
    }
    throw new Error('No free media ports on the relay');
  }

  /** The session for a call (made on first use). expect: { a: ip, b: ip } — where each side's packets should come from. */
  session(key, expect = {}) {
    let s = this.sessions.get(key);
    if (!s) {
      s = { key, streams: [], expect: { ...expect }, created: Date.now(), last: Date.now(), answered: false, pending: Promise.resolve() };
      this.sessions.set(key, s); this.stats.sessions++;
    } else for (const k of SIDES) if (expect[k]) s.expect[k] = expect[k];
    return s;
  }
  /** Make sure stream i has ports on both sides. */
  async stream(s, i) {
    while (s.streams.length <= i) s.streams.push(null);
    if (s.streams[i]) return s.streams[i];
    const st = { a: null, b: null };
    s.streams[i] = st;
    for (const side of SIDES) {
      const pair = await this.openPair();
      st[side] = { ...pair, latch: { rtp: null, rtcp: null } };
    }
    for (const side of SIDES) for (const kind of ['rtp', 'rtcp']) st[side][kind].on('message', (buf, r) => this.onPacket(s, st, side, kind, buf, r));
    return st;
  }
  onPacket(s, st, side, kind, buf, r) {
    const me = st[side]; const to = st[other(side)];
    const latched = me.latch[kind];
    if (!latched) me.latch[kind] = { address: r.address, port: r.port };   // the first packet: this is where the side is
    else if (latched.address !== r.address || latched.port !== r.port) {
      // a different source: only follow it from the side's own public address (its NAT mapping moved, or its IP changed
      // and it reconnected); anything else is dropped, so nobody can take over a call's sound by guessing a port
      if (s.expect[side] && r.address === s.expect[side]) me.latch[kind] = { address: r.address, port: r.port };
      else { this.stats.dropped++; return; }
    }
    s.last = Date.now();
    const dest = to.latch[kind];
    if (!dest) return;   // the other side hasn't sent anything yet, so we don't know where it is
    to[kind].send(buf, dest.port, dest.address);
    this.stats.packets++; this.stats.bytes += buf.length;
  }

  /**
   * Rewrite an SDP body produced by side `from` for delivery to the other side: every audio/video stream's address
   * and port become the relay's, on the receiving side's ports. ICE candidates and a=rtcp lines are dropped
   * (RTCP is the next port). -> Promise<Buffer>
   */
  async rewrite(key, from, body, expect, { trustSdp = false } = {}) {
    const s = this.session(key, expect);
    const run = s.pending.then(() => this._rewrite(s, from, body, trustSdp));
    s.pending = run.catch(() => null);
    return run;
  }
  async _rewrite(s, from, body, trustSdp) {
    const to = other(from);
    const lines = String(body).split(/\r?\n/);
    const out = []; let idx = -1;
    // another relay of the cluster can't send first (it only forwards), so where its SDP says is where to send
    let sessionIp = null; const trusted = [];
    for (const line of lines) {
      if (/^a=(candidate|end-of-candidates|ice-|rtcp:)/.test(line)) continue;
      if (line.startsWith('c=')) {
        const ip = (/^c=IN IP4 (\d+\.\d+\.\d+\.\d+)/.exec(line) || [])[1] || null;
        if (idx < 0) sessionIp = ip; else if (trusted[idx]) trusted[idx].address = ip;
        out.push(`c=IN IP4 ${this.publicIp}`); continue;
      }
      const m = /^m=(\S+) (\d+)(\/\d+)? (.*)$/.exec(line);
      if (m) {
        idx++;
        if (m[2] === '0') { out.push(line); continue; }   // a stream switched off stays off
        const st = await this.stream(s, idx);
        if (trustSdp) trusted[idx] = { st, port: Number(m[2]), address: sessionIp };
        out.push(`m=${m[1]} ${st[to].port} ${m[4]}`);
        continue;
      }
      if (line.startsWith('o=')) { out.push(line.replace(/IN IP4 \S+$/, `IN IP4 ${this.publicIp}`)); continue; }
      out.push(line);
    }
    // a media-level c= is kept per stream; make sure there's a session-level one
    if (!out.some((l) => l.startsWith('c='))) { const t = out.findIndex((l) => l.startsWith('t=')); out.splice(t < 0 ? out.length : t, 0, `c=IN IP4 ${this.publicIp}`); }
    for (const t of trusted) if (t && t.address && t.port) {
      const me = t.st[from];
      if (!me.latch.rtp) me.latch.rtp = { address: t.address, port: t.port };
      if (!me.latch.rtcp) me.latch.rtcp = { address: t.address, port: t.port + 1 };
    }
    let text = out.join('\r\n'); if (!text.endsWith('\r\n')) text += '\r\n';
    text = text.replace(/(\r\n)+$/, '\r\n');
    return Buffer.from(text, 'utf8');
  }
  answered(key) { const s = this.sessions.get(key); if (s) s.answered = true; }
  setExpect(key, side, ip) { const s = this.sessions.get(key); if (s && ip) s.expect[side] = ip; }
  close(key) {
    const s = this.sessions.get(key); if (!s) return;
    this.sessions.delete(key);
    for (const st of s.streams) if (st) for (const side of SIDES) { if (!st[side]) continue; try { st[side].rtp.close(); st[side].rtcp.close(); } catch { /* closed */ } this.used.delete(st[side].port); }
  }
  sweep() {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) if (now - s.last > (s.answered ? IDLE_TALKING : IDLE_BEFORE_ANSWER)) this.close(s.key);
  }
  snapshot() { return { sessions: this.sessions.size, ports: this.used.size * 2, ...this.stats }; }
}

function bindUdp(port, address) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(port, address, () => { s.off('error', reject); s.on('error', () => {}); resolve(s); });
  });
}

module.exports = { Media };
