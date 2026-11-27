// A tiny simulated SIP phone, used by the self-test (riyeser-phone --self-test) and the tests. It registers, places
// calls (handling the digest challenges), answers / rings / says busy, hangs up, holds (re-INVITE) and cancels,
// over UDP on this PC (or TLS, for phones that register straight to the Riyeser relay). It is a test helper. With
// rtp: true it also sends and counts sound packets (RTP, 20 ms each) from its own port, so tests can check that
// sound gets through both ways (it does no real audio).
const dgram = require('dgram');
const tls = require('tls');
const { EventEmitter } = require('events');
const sip = require('../lib/sip');

const SDP = (port, dir = 'sendrecv', ip = '127.0.0.1') => ['v=0', `o=- ${Date.now()} 1 IN IP4 ${ip}`, 's=-', `c=IN IP4 ${ip}`, 't=0 0',
  `m=audio ${port} RTP/AVP 0 8 101`, 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', `a=${dir}`, ''].join('\r\n');

class SimUA extends EventEmitter {
  /**
   * { ext, password, server: { host, port }, mode: 'answer' | 'ring' | 'busy' | 'silent', answerDelay, userAgent,
   *   bind (this phone's own address, default 127.0.0.1), rtp (send and count sound packets),
   *   tls: { ca, servername } (SIP over TLS to the server instead of UDP), user (the SIP username, default ext) }
   */
  constructor(o) {
    super();
    Object.assign(this, { ext: String(o.ext), password: o.password, server: o.server, mode: o.mode || 'answer', answerDelay: o.answerDelay == null ? 30 : o.answerDelay,
      userAgent: o.userAgent || 'SimPhone/1.0', domain: o.domain || o.server.host, bind: o.bind || '127.0.0.1', useRtp: !!o.rtp, tlsOpts: o.tls || null, user: String(o.user || o.ext) });
    this.rtp = new Map();   // Call-ID -> { sent, received, from, to, timer }
    this.txns = new Map(); this.incoming = new Map(); this.calls = new Map(); this.seen = new Map(); this.log = [];
    this.callIdReg = sip.newCallId('sim'); this.regSeq = 0;
  }
  async start() {
    if (this.tlsOpts) await this.connectTls();
    else {
      this.udp = dgram.createSocket('udp4');
      this.udp.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
      await new Promise((r) => this.udp.bind(0, this.bind, r));
      this.port = this.udp.address().port;
    }
    if (this.useRtp) {
      this.media = dgram.createSocket('udp4');
      this.media.on('message', (buf, r) => this.onRtp(buf, r));
      await new Promise((r) => this.media.bind(0, this.bind, r));
      this.mediaPort = this.media.address().port;
    }
    return this;
  }
  async connectTls() {
    this.sock = tls.connect({ host: this.server.host, port: this.server.port, ca: this.tlsOpts.ca, servername: this.tlsOpts.servername, localAddress: this.bind === '127.0.0.1' && !/^127\./.test(this.server.host) ? undefined : this.bind });
    await new Promise((res, rej) => { this.sock.once('secureConnect', res); this.sock.once('error', rej); });
    this.sock.on('error', () => {});
    this.port = this.sock.localPort;
    let buf = Buffer.alloc(0);
    this.sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        let i = 0; while (i < buf.length && (buf[i] === 13 || buf[i] === 10)) i++;
        if (i) buf = buf.slice(i);
        const end = buf.indexOf('\r\n\r\n'); if (end < 0) return;
        const m = /^(?:content-length|l)[ \t]*:[ \t]*(\d+)/im.exec(buf.slice(0, end).toString('latin1'));
        const total = end + 4 + (m ? Number(m[1]) : 0); if (buf.length < total) return;
        const packet = buf.slice(0, total); buf = buf.slice(total);
        this.onMessage(packet, { address: this.server.host, port: this.server.port });
      }
    });
  }
  stop() {
    for (const r of this.rtp.values()) clearInterval(r.timer);
    const close = (s) => new Promise((r) => { try { s.close(() => r()); } catch { r(); } });
    return Promise.all([this.udp ? close(this.udp) : null, this.media ? close(this.media) : null, this.sock ? new Promise((r) => { this.sock.end(); this.sock.destroy(); r(); }) : null]);
  }
  get contact() { return `<sip:${this.user}@${this.bind}:${this.port}${this.tlsOpts ? ';transport=tls' : ''}>`; }
  sendRaw(buf, to = this.server) { if (this.sock) this.sock.write(buf); else this.udp.send(buf, to.port, to.host); }
  send(msg, to = this.server) { this.sendRaw(sip.serialize(msg), to); }
  via(branch = sip.newBranch()) { return { branch, value: `SIP/2.0/${this.tlsOpts ? 'TLS' : 'UDP'} ${this.bind}:${this.port};branch=${branch};rport` }; }
  sdp(dir, answer = false) { return this.useRtp ? SDP(this.mediaPort, dir, this.bind) : SDP(answer ? 41000 : 40000, dir); }

  // ---------- sound (RTP) ----------
  /** Start sending RTP to where the other side's SDP says, from our media port, every 20 ms. */
  startRtp(callId, remoteSdp) {
    if (!this.useRtp || !remoteSdp) return;
    const c = /^c=IN IP4 (\S+)/m.exec(remoteSdp); const m = /^m=audio (\d+)/m.exec(remoteSdp);
    if (!c || !m) return;
    const st = this.rtp.get(callId) || { sent: 0, received: 0, from: null, seq: 0 };
    st.to = { address: c[1], port: Number(m[1]) };
    clearInterval(st.timer);
    const ssrc = Math.floor(Math.random() * 2 ** 31);
    st.timer = setInterval(() => {
      const pkt = Buffer.alloc(12 + 160, 0xff);
      pkt[0] = 0x80; pkt[1] = 0; pkt.writeUInt16BE(st.seq++ & 0xffff, 2); pkt.writeUInt32BE((st.seq * 160) >>> 0, 4); pkt.writeUInt32BE(ssrc, 8);
      pkt.write(`${this.ext}`, 12);
      this.media.send(pkt, st.to.port, st.to.address); st.sent++;
    }, 20);
    st.timer.unref && st.timer.unref();
    this.rtp.set(callId, st);
  }
  stopRtp(callId) { const st = this.rtp.get(callId); if (st) clearInterval(st.timer); }
  onRtp(buf, r) {
    if (buf.length < 12 || (buf[0] & 0xc0) !== 0x80) return;
    // count for whichever call is sending (tests have one call at a time per phone)
    for (const st of this.rtp.values()) { st.received++; st.from = `${r.address}:${r.port}`; st.lastPayload = buf.slice(12, 15).toString(); }
    this.emit('rtp', buf, r);
  }
  rtpStats(callId) { const st = callId ? this.rtp.get(callId) : [...this.rtp.values()].pop(); return st ? { sent: st.sent, received: st.received, from: st.from, to: st.to, lastPayload: st.lastPayload } : { sent: 0, received: 0 }; }

  /** Send a request and wait for its final response. onProvisional gets 1xx responses. */
  request(msg, { onProvisional, timeout = 5000 } = {}) {
    const branch = `${sip.parseVia(sip.getHeader(msg, 'via')).params.branch}|${msg.method}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.txns.delete(branch); reject(new Error(`${this.ext}: no answer to ${msg.method}`)); }, timeout);
      this.txns.set(branch, { onProvisional, resolve: (res) => { clearTimeout(t); this.txns.delete(branch); resolve(res); } });
      this.send(msg);
    });
  }

  // ---------- REGISTER ----------
  async register({ password = this.password, expires = 600 } = {}) {
    const uri = `sip:${this.domain}:${this.server.port}`;
    const build = (auth) => {
      const v = this.via();
      const m = { method: 'REGISTER', uri, headers: [['via', v.value], ['max-forwards', '70'], ['from', `<sip:${this.user}@${this.domain}>;tag=${sip.newTag()}`],
        ['to', `<sip:${this.user}@${this.domain}>`], ['call-id', this.callIdReg], ['cseq', `${++this.regSeq} REGISTER`], ['contact', this.contact],
        ['expires', String(expires)], ['user-agent', this.userAgent]], body: Buffer.alloc(0) };
      if (auth) m.headers.push(['authorization', auth]);
      return m;
    };
    let res = await this.request(build());
    if (res.status === 401) res = await this.request(build(sip.authorize(sip.getHeader(res, 'www-authenticate'), { username: this.user, password, method: 'REGISTER', uri })));
    return res;
  }

  // ---------- placing a call ----------
  /** Dial a number. Resolves with { call, final } once the call is answered or fails. */
  async dial(target, { password = this.password, onProvisional } = {}) {
    const call = { id: sip.newCallId('sim'), localTag: sip.newTag(), cseq: 1, local: `sip:${this.user}@${this.domain}`, remote: `sip:${target}@${this.domain}`, provisional: [] };
    this.calls.set(call.id, call);
    const uri = `sip:${target}@${this.domain}:${this.server.port}`;
    const build = (auth) => {
      const v = this.via();
      const m = { method: 'INVITE', uri, headers: [['via', v.value], ['max-forwards', '70'], ['from', `<${call.local}>;tag=${call.localTag}`], ['to', `<${call.remote}>`],
        ['call-id', call.id], ['cseq', `${call.cseq} INVITE`], ['contact', this.contact], ['user-agent', this.userAgent], ['content-type', 'application/sdp']], body: Buffer.from(this.sdp()) };
      if (auth) m.headers.push(['proxy-authorization', auth]);
      call.invite = m;
      return m;
    };
    const onProv = (r) => { call.provisional.push(r.status); if (onProvisional) onProvisional(r); this.emit('provisional', r, call); };
    let res = await this.request(build(), { onProvisional: onProv });
    if (res.status === 407) {
      this.ackFailure(call.invite, res);
      call.cseq++;
      res = await this.request(build(sip.authorize(sip.getHeader(res, 'proxy-authenticate'), { username: this.user, password, method: 'INVITE', uri })), { onProvisional: onProv });
    }
    call.final = res.status;
    if (res.status >= 200 && res.status < 300) {
      call.remoteTag = sip.parseNameAddr(sip.getHeader(res, 'to')).params.tag;
      call.routeSet = sip.getAll(res, 'record-route').reverse();
      call.target = sip.parseNameAddr(sip.getHeader(res, 'contact')).uri;
      call.remoteSdp = res.body.toString();
      this.sendAck(call);
      this.startRtp(call.id, call.remoteSdp);
    } else if (res.status >= 300) this.ackFailure(call.invite, res);
    return { call, final: res };
  }
  /** Hang up a call that's still ringing. Resolves with the INVITE's final response (487). */
  cancel(call) {
    const inv = call.invite;
    const c = { method: 'CANCEL', uri: inv.uri, headers: [['via', sip.getHeader(inv, 'via')], ['max-forwards', '70'], ['from', sip.getHeader(inv, 'from')],
      ['to', sip.getHeader(inv, 'to')], ['call-id', call.id], ['cseq', `${call.cseq} CANCEL`]], body: Buffer.alloc(0) };
    this.send(c);
  }
  ackFailure(inv, res) {
    this.send({ method: 'ACK', uri: inv.uri, headers: [['via', sip.getHeader(inv, 'via')], ['max-forwards', '70'], ['from', sip.getHeader(inv, 'from')],
      ['to', sip.getHeader(res, 'to')], ['call-id', sip.getHeader(inv, 'call-id')], ['cseq', `${sip.parseCSeq(sip.getHeader(inv, 'cseq')).seq} ACK`]], body: Buffer.alloc(0) });
  }
  /** A request inside a call (we're the caller or the one called). */
  dialogRequest(call, method, { body, headers = [], seq } = {}) {
    const m = { method, uri: call.target, headers: [['via', this.via().value], ['max-forwards', '70']], body: body ? Buffer.from(body) : Buffer.alloc(0) };
    for (const r of call.routeSet || []) m.headers.push(['route', r]);
    m.headers.push(['from', `<${call.local}>;tag=${call.localTag}`], ['to', `<${call.remote}>;tag=${call.remoteTag}`], ['call-id', call.id],
      ['cseq', `${seq || ++call.cseq} ${method}`], ['contact', this.contact], ...headers);
    if (body) m.headers.push(['content-type', 'application/sdp']);
    return m;
  }
  sendAck(call) { this.send(this.dialogRequest(call, 'ACK', { seq: call.cseq })); }
  bye(call) { this.stopRtp(call.id); return this.request(this.dialogRequest(call, 'BYE')); }
  /** Put the call on hold (a re-INVITE with sendonly), and ACK the answer. */
  async hold(call) {
    const m = this.dialogRequest(call, 'INVITE', { body: this.sdp('sendonly') });
    const res = await this.request(m);
    if (res.status < 300) this.sendAck(call); else this.ackFailure(m, res);
    return res;
  }
  refer(call, to) { return this.request(this.dialogRequest(call, 'REFER', { headers: [['refer-to', `<sip:${to}@${this.domain}>`], ['referred-by', `<${call.local}>`]] })); }

  // ---------- being called ----------
  answer(callId) {
    const inc = this.incoming.get(callId); if (!inc || inc.done) return;
    inc.done = true;
    this.respond(inc.req, 200, { toTag: inc.call.localTag, body: this.sdp(undefined, true), headers: [['contact', this.contact], ['content-type', 'application/sdp']] });
    this.startRtp(callId, inc.req.body.toString());
  }
  respond(req, status, { toTag, headers = [], body } = {}) {
    const res = sip.response(req, status, null, { toTag, headers, body });
    const key = `${sip.parseVia(sip.getHeader(req, 'via')).params.branch}|${req.method}`;
    this.seen.set(key, res);
    this.send(res, req._from);
  }

  onMessage(buf, rinfo) {
    let msg;
    try { msg = sip.parse(buf); } catch { return; }
    msg._from = { host: rinfo.address, port: rinfo.port };
    this.log.push(msg.method || msg.status);
    if (!msg.method) {
      const t = this.txns.get(`${sip.parseVia(sip.getHeader(msg, 'via')).params.branch}|${sip.parseCSeq(sip.getHeader(msg, 'cseq')).method}`);
      if (!t) { this.emit('stray', msg); return; }
      if (msg.status < 200) { if (t.onProvisional) t.onProvisional(msg); } else t.resolve(msg);
      return;
    }
    const key = `${sip.parseVia(sip.getHeader(msg, 'via')).params.branch}|${msg.method}`;
    if (msg.method !== 'ACK' && this.seen.has(key)) { this.send(this.seen.get(key), msg._from); return; }   // a resend
    const callId = sip.getHeader(msg, 'call-id');
    const to = sip.parseNameAddr(sip.getHeader(msg, 'to'));
    switch (msg.method) {
      case 'INVITE': {
        if (to.params.tag) { this.respond(msg, 200, { toTag: to.params.tag, body: this.sdp(undefined, true), headers: [['contact', this.contact], ['content-type', 'application/sdp']] }); this.emit('reinvite', msg); return; }
        const from = sip.parseNameAddr(sip.getHeader(msg, 'from'));
        const call = { id: callId, localTag: sip.newTag(), remoteTag: from.params.tag, local: to.uri, remote: from.uri, cseq: 100,
          routeSet: sip.getAll(msg, 'record-route'), target: sip.parseNameAddr(sip.getHeader(msg, 'contact')).uri };
        const inc = { req: msg, call, done: false };
        this.incoming.set(callId, inc); this.calls.set(callId, call);
        this.emit('invite', msg, call);
        if (this.mode === 'busy') { inc.done = true; this.respond(msg, 486, { toTag: call.localTag }); return; }
        if (this.mode === 'silent') return;
        this.respond(msg, 180, { toTag: call.localTag, headers: [['contact', this.contact]] });
        if (this.mode === 'answer') setTimeout(() => this.answer(callId), this.answerDelay);
        return;
      }
      case 'ACK': this.emit('ack', msg); return;
      case 'CANCEL': {
        this.respond(msg, 200, {});
        const inc = this.incoming.get(callId);
        if (inc && !inc.done) { inc.done = true; this.respond(inc.req, 487, { toTag: inc.call.localTag }); }
        this.emit('cancel', msg); return;
      }
      case 'BYE': this.stopRtp(callId); this.respond(msg, 200, {}); this.emit('bye', msg); return;
      case 'REFER': this.respond(msg, 202, {}); this.emit('refer', msg); return;
      case 'NOTIFY': this.respond(msg, 200, {}); this.emit('notify', msg); return;
      default: this.respond(msg, 200, {}); this.emit('request', msg);
    }
  }
  /** Wait for an event (optionally one that matches). */
  waitFor(event, test = () => true, timeout = 4000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off(event, fn); reject(new Error(`${this.ext}: no ${event} within ${timeout} ms`)); }, timeout);
      const fn = (...a) => { if (test(...a)) { clearTimeout(t); this.off(event, fn); resolve(a[0]); } };
      this.on(event, fn);
    });
  }
}

module.exports = { SimUA, SDP };
