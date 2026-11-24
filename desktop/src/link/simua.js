// A tiny simulated SIP phone, used by the self-test (riyeser-phone --self-test) and the tests. It registers, places
// calls (handling the digest challenges), answers / rings / says busy, hangs up, holds (re-INVITE) and cancels,
// all over UDP on this PC. It is a test helper: it does no audio.
const dgram = require('dgram');
const { EventEmitter } = require('events');
const sip = require('./sip');

const SDP = (port, dir = 'sendrecv') => ['v=0', `o=- ${Date.now()} 1 IN IP4 127.0.0.1`, 's=-', 'c=IN IP4 127.0.0.1', 't=0 0',
  `m=audio ${port} RTP/AVP 0 8 101`, 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', `a=${dir}`, ''].join('\r\n');

class SimUA extends EventEmitter {
  /** { ext, password, server: { host, port }, mode: 'answer' | 'ring' | 'busy' | 'silent', answerDelay, userAgent } */
  constructor(o) {
    super();
    Object.assign(this, { ext: String(o.ext), password: o.password, server: o.server, mode: o.mode || 'answer', answerDelay: o.answerDelay == null ? 30 : o.answerDelay,
      userAgent: o.userAgent || 'SimPhone/1.0', domain: o.server.host });
    this.txns = new Map(); this.incoming = new Map(); this.calls = new Map(); this.seen = new Map(); this.log = [];
    this.callIdReg = sip.newCallId('sim'); this.regSeq = 0;
  }
  async start() {
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
    await new Promise((r) => this.udp.bind(0, '127.0.0.1', r));
    this.port = this.udp.address().port;
    return this;
  }
  stop() { return new Promise((r) => { try { this.udp.close(() => r()); } catch { r(); } }); }
  get contact() { return `<sip:${this.ext}@127.0.0.1:${this.port}>`; }
  sendRaw(buf, to = this.server) { this.udp.send(buf, to.port, to.host); }
  send(msg, to = this.server) { this.sendRaw(sip.serialize(msg), to); }
  via(branch = sip.newBranch()) { return { branch, value: `SIP/2.0/UDP 127.0.0.1:${this.port};branch=${branch};rport` }; }

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
      const m = { method: 'REGISTER', uri, headers: [['via', v.value], ['max-forwards', '70'], ['from', `<sip:${this.ext}@${this.domain}>;tag=${sip.newTag()}`],
        ['to', `<sip:${this.ext}@${this.domain}>`], ['call-id', this.callIdReg], ['cseq', `${++this.regSeq} REGISTER`], ['contact', this.contact],
        ['expires', String(expires)], ['user-agent', this.userAgent]], body: Buffer.alloc(0) };
      if (auth) m.headers.push(['authorization', auth]);
      return m;
    };
    let res = await this.request(build());
    if (res.status === 401) res = await this.request(build(sip.authorize(sip.getHeader(res, 'www-authenticate'), { username: this.ext, password, method: 'REGISTER', uri })));
    return res;
  }

  // ---------- placing a call ----------
  /** Dial a number. Resolves with { call, final } once the call is answered or fails. */
  async dial(target, { password = this.password, onProvisional } = {}) {
    const call = { id: sip.newCallId('sim'), localTag: sip.newTag(), cseq: 1, local: `sip:${this.ext}@${this.domain}`, remote: `sip:${target}@${this.domain}`, provisional: [] };
    this.calls.set(call.id, call);
    const uri = `sip:${target}@${this.domain}:${this.server.port}`;
    const build = (auth) => {
      const v = this.via();
      const m = { method: 'INVITE', uri, headers: [['via', v.value], ['max-forwards', '70'], ['from', `<${call.local}>;tag=${call.localTag}`], ['to', `<${call.remote}>`],
        ['call-id', call.id], ['cseq', `${call.cseq} INVITE`], ['contact', this.contact], ['user-agent', this.userAgent], ['content-type', 'application/sdp']], body: Buffer.from(SDP(40000)) };
      if (auth) m.headers.push(['proxy-authorization', auth]);
      call.invite = m;
      return m;
    };
    const onProv = (r) => { call.provisional.push(r.status); if (onProvisional) onProvisional(r); this.emit('provisional', r, call); };
    let res = await this.request(build(), { onProvisional: onProv });
    if (res.status === 407) {
      this.ackFailure(call.invite, res);
      call.cseq++;
      res = await this.request(build(sip.authorize(sip.getHeader(res, 'proxy-authenticate'), { username: this.ext, password, method: 'INVITE', uri })), { onProvisional: onProv });
    }
    call.final = res.status;
    if (res.status >= 200 && res.status < 300) {
      call.remoteTag = sip.parseNameAddr(sip.getHeader(res, 'to')).params.tag;
      call.routeSet = sip.getAll(res, 'record-route').reverse();
      call.target = sip.parseNameAddr(sip.getHeader(res, 'contact')).uri;
      call.remoteSdp = res.body.toString();
      this.sendAck(call);
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
  bye(call) { return this.request(this.dialogRequest(call, 'BYE')); }
  /** Put the call on hold (a re-INVITE with sendonly), and ACK the answer. */
  async hold(call) {
    const m = this.dialogRequest(call, 'INVITE', { body: SDP(40000, 'sendonly') });
    const res = await this.request(m);
    if (res.status < 300) this.sendAck(call); else this.ackFailure(m, res);
    return res;
  }
  refer(call, to) { return this.request(this.dialogRequest(call, 'REFER', { headers: [['refer-to', `<sip:${to}@${this.domain}>`], ['referred-by', `<${call.local}>`]] })); }

  // ---------- being called ----------
  answer(callId) {
    const inc = this.incoming.get(callId); if (!inc || inc.done) return;
    inc.done = true;
    this.respond(inc.req, 200, { toTag: inc.call.localTag, body: SDP(41000), headers: [['contact', this.contact], ['content-type', 'application/sdp']] });
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
        if (to.params.tag) { this.respond(msg, 200, { toTag: to.params.tag, body: SDP(41000), headers: [['contact', this.contact], ['content-type', 'application/sdp']] }); this.emit('reinvite', msg); return; }
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
      case 'BYE': this.respond(msg, 200, {}); this.emit('bye', msg); return;
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
