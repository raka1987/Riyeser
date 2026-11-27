// Riyeser Link Office's SIP server: a registrar and a record-routing proxy for desk phones on the office network.
//   REGISTER   digest authentication (MD5, qop=auth); each extension has its own strong password
//   INVITE     routed by the dial plan to a person's phones, or to a ring group's chosen phones (all at once, in order or rotating: ringgroups.js)
//              (the first to answer wins and the others are cancelled); 486 busy / 480 not connected / 404
//   in-dialog  ACK, BYE, re-INVITE (hold), REFER (transfer), INFO, UPDATE, NOTIFY pass through via Record-Route
//   CANCEL     cancels every phone still ringing
//   OPTIONS    answered here (phones use it as a keep-alive)
//   SUBSCRIBE  Event: ua-profile (desk-phone plug-and-play) is answered with the provisioning address
// Media (RTP) never comes here: the SDP passes through unchanged and phones send sound to each other directly.
// Only office (private) addresses are served, and an address that keeps getting the password wrong is blocked.
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const sip = require('./sip');
const dialplan = require('./dialplan');
const ringgroups = require('./ringgroups');
const { isPrivate, sameSubnet, v4 } = require('./netinfo');

const T1 = 500; const T2 = 4000; const TIMEOUT = 64 * T1;
const PNP_GROUP = '224.0.1.75';
const MAX_BINDINGS = 5;
const NONCE_FRESH = 5 * 60 * 1000; const NONCE_STALE = 60 * 60 * 1000;
const STALE_CALL = 12 * 3600 * 1000;
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, REFER, NOTIFY, INFO, UPDATE, PRACK, SUBSCRIBE, MESSAGE';
const AGENT = 'Riyeser Link Office';
// Which failure the caller hears when every phone said no: busy beats not connected beats the rest.
const RANK = { 486: 1, 600: 2, 603: 3, 488: 4, 480: 5, 404: 6, 408: 7, 487: 9 };
const rank = (s) => RANK[s] || (s < 500 ? 8 : 10);

class Pbx extends EventEmitter {
  /**
   * opts: { directory, host, port = 5060, bind = '0.0.0.0', tcp = true, multicast = (port === 5060),
   *         realm, allowPublic = false, maxFailures = 10, failWindow = 10 min, blockFor = 1 h, ringTimeout = 120 s,
   *         log: (level, text) => {}, onPnp: ({ mac, vendor, model, address }) => url | null, ifaces }
   */
  constructor(opts = {}) {
    super();
    this.directory = opts.directory;
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port == null ? 5060 : opts.port;
    this.bind = opts.bind || '0.0.0.0';
    this.useTcp = opts.tcp !== false;
    this.multicast = opts.multicast != null ? opts.multicast : this.port === 5060;
    this.realm = opts.realm || 'riyeser';
    this.allowPublic = !!opts.allowPublic;
    this.maxFailures = opts.maxFailures || 10;
    this.failWindow = opts.failWindow || 10 * 60 * 1000;
    this.blockFor = opts.blockFor || 60 * 60 * 1000;
    this.ringTimeout = opts.ringTimeout || 120 * 1000;
    this.logFn = opts.log || (() => {});
    this.onPnp = opts.onPnp || null;
    this.trunks = opts.trunks || null;   // trunks.js: the relay / other Links (none yet)
    this.ifaces = opts.ifaces;
    this.secret = crypto.randomBytes(32);
    this.bindings = new Map();   // ext -> Map(contact -> binding)
    this.ctx = new Map();        // server transactions: "branch|METHOD" -> context
    this.branches = new Map();   // our branch id -> client transaction
    this.probes = new Map();     // "Find this phone" rings (1.2.3): our branch id -> { msg, dest, provisional, final }
    this.calls = new Map();      // Call-ID -> call
    this.failures = new Map(); this.blocked = new Map();
    this.conns = new Map();      // TCP connections: "ip:port" -> socket
    this.accepting = true; this.running = false;
    this.stats = { received: 0, malformed: 0, blockedDrops: 0 };
    this.warned = new Set();
    this.oldHosts = [];          // this PC's earlier addresses (after a change): still "us" for calls set up before it
    this.names = [];             // names phones may use for this PC (riyeser-office.local, the router's name for it)
    this.pnpJoined = new Set();
  }

  log(level, text) { try { this.logFn(level, text); } catch { /* logging never stops calls */ } }
  logOnce(key, level, text) { if (this.warned.has(key)) return; this.warned.add(key); this.log(level, text); }

  // ---------- start / stop ----------
  async start() {
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: this.multicast });
    this.udp.on('message', (buf, rinfo) => this.receive(buf, { proto: 'UDP', address: rinfo.address, port: rinfo.port }));
    this.udp.on('error', (e) => this.log('error', `SIP (UDP): ${e.message}`));
    await new Promise((resolve, reject) => { this.udp.once('error', reject); this.udp.bind(this.port, this.bind, () => { this.udp.off('error', reject); resolve(); }); });
    this.port = this.udp.address().port;
    if (this.multicast) {
      // Desk-phone plug-and-play: phones ask on 224.0.1.75:5060 when they start up.
      if (!this.joinPnp()) this.log('warn', 'Plug-and-play for desk phones is unavailable on this network. Phones can still be set up by MAC address or by hand.');
    }
    if (this.useTcp) {
      this.tcp = net.createServer((sock) => this.onTcp(sock));
      try {
        await new Promise((resolve, reject) => { this.tcp.once('error', reject); this.tcp.listen(this.port, this.bind, () => { this.tcp.off('error', reject); resolve(); }); });
      } catch (e) { this.log('warn', `SIP over TCP is off (${e.code || e.message}). UDP works.`); this.tcp = null; }
    }
    this.running = true;
    this.sweeper = setInterval(() => this.sweep(), 5000); this.sweeper.unref();
    this.log('info', `Riyeser Link Office listening on ${this.host}:${this.port}`);
    return this;
  }
  async stop() {
    this.running = false;
    clearInterval(this.sweeper);
    for (const b of this.branches.values()) this.clearBranchTimers(b);
    for (const c of this.ctx.values()) { clearTimeout(c.timerC); clearTimeout(c.timerG); clearTimeout(c.cleanup); }
    this.branches.clear(); this.ctx.clear();
    for (const s of this.conns.values()) { try { s.destroy(); } catch { /* gone */ } }
    this.conns.clear();
    if (this.tcp) await new Promise((r) => this.tcp.close(() => r()));
    if (this.udp) await new Promise((r) => { try { this.udp.close(() => r()); } catch { r(); } });
    this.tcp = null; this.udp = null;
  }
  /** Listen for plug-and-play on every office adapter; after an address change, on the new ones. -> joined any? */
  joinPnp() {
    if (!this.udp || !this.multicast) return false;
    const { localAddresses } = require('./netinfo');
    const ifaces = typeof this.ifaces === 'function' ? this.ifaces() : this.ifaces;
    const now = new Set(localAddresses(ifaces).map((a) => a.address));
    for (const a of this.pnpJoined) if (a !== '*' && !now.has(a)) { try { this.udp.dropMembership(PNP_GROUP, a); } catch { /* already gone with the address */ } this.pnpJoined.delete(a); }
    for (const a of now) if (!this.pnpJoined.has(a)) { try { this.udp.addMembership(PNP_GROUP, a); this.pnpJoined.add(a); } catch { /* that adapter can't */ } }
    if (!this.pnpJoined.size) { try { this.udp.addMembership(PNP_GROUP); this.pnpJoined.add('*'); } catch { /* no multicast */ } }
    try { if (this.host !== '127.0.0.1') this.udp.setMulticastInterface(this.host); } catch { /* the default one */ }
    return this.pnpJoined.size > 0;
  }
  /**
   * This PC's address changed. The sockets listen on every adapter (0.0.0.0), so they keep working: only what we
   * write into messages (Via, Record-Route, Contact, plug-and-play answers) moves to the new address, and plug-and-play
   * listens on the new adapter. Registrations are kept; the old address still counts as us for calls already set up.
   */
  setHost(host, ifaces) {
    if (!host || host === this.host) return false;
    const was = this.host;
    if (ifaces !== undefined) this.ifaces = ifaces;
    this.oldHosts = [was, ...this.oldHosts.filter((h) => h !== host && h !== was)].slice(0, 4);
    this.host = host;
    this.joinPnp();
    this.warned.clear();
    this.log('info', `Riyeser Link Office now answers on ${host}:${this.port} (was ${was}).`);
    this.emit('change');
    return true;
  }
  /** Names phones may be given for this PC instead of its address (they count as "us" in Route and Request-URIs). */
  setNames(names) { this.names = [...new Set((names || []).filter(Boolean).map((n) => String(n).toLowerCase()))]; }
  isOurHost(h) { return h === this.host || h === '127.0.0.1' || h === 'localhost' || this.oldHosts.includes(h) || this.names.includes(String(h || '').toLowerCase()) || (this.extraHosts || []).includes(h); }
  /** Software on this PC (the Riyeser Link app) may still put this PC's old address in its messages: use the new one. */
  fixLocal(msg, src) {
    if (!this.oldHosts.length || src.proto === 'TRUNK') return 0;
    if (!(src.address === this.host || src.address.startsWith('127.') || this.oldHosts.includes(src.address))) return 0;
    let n = 0;
    for (const old of this.oldHosts) n += sip.rewriteHost(msg, old, this.host);
    return n;
  }
  /** Licence lapsed (false): calls in progress finish; new phones and new calls are refused. 'idle' fires when the last call ends. */
  setAccepting(on) {
    this.accepting = !!on;
    if (!on && !this.callsInProgress().length) setImmediate(() => this.emit('idle'));
  }

  // ---------- transport ----------
  onTcp(sock) {
    const address = v4(sock.remoteAddress); const port = sock.remotePort; const key = `${address}:${port}`;
    if (this.isBlocked(address) || !this.allowed(address)) { sock.destroy(); return; }
    this.conns.set(key, sock);
    sock.setTimeout(15 * 60 * 1000, () => sock.destroy());
    sock.on('error', () => {}); sock.on('close', () => { if (this.conns.get(key) === sock) this.conns.delete(key); });
    this.readStream(sock, { proto: 'TCP', address, port });
  }
  readStream(sock, src) {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        let i = 0; while (i < buf.length && (buf[i] === 13 || buf[i] === 10)) i++;
        if (i) buf = buf.slice(i);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) { if (buf.length > sip.MAX_SIZE) { sock.destroy(); } return; }
        const m = /^(?:content-length|l)[ \t]*:[ \t]*(\d+)/im.exec(buf.slice(0, end).toString('latin1'));
        const total = end + 4 + (m ? Number(m[1]) : 0);
        if (total > sip.MAX_SIZE) { sock.destroy(); return; }
        if (buf.length < total) return;
        const packet = buf.slice(0, total); buf = buf.slice(total);
        this.receive(packet, src);
      }
    });
  }
  /** Send bytes. Tests replace this to see what would go out. */
  _send(buf, dest) {
    if (!this.running) return;
    if (dest.proto === 'TRUNK') { const t = this.trunks && this.trunks.list.get(dest.trunk); if (t) t.send(buf, dest); return; }
    if (dest.proto === 'TCP') {
      const key = `${dest.address}:${dest.port}`;
      let s = this.conns.get(key);
      if (!s || s.destroyed) {
        s = net.connect(dest.port, dest.address); s.on('error', () => {});
        this.conns.set(key, s); s.on('close', () => { if (this.conns.get(key) === s) this.conns.delete(key); });
        this.readStream(s, { proto: 'TCP', address: dest.address, port: dest.port });
      }
      s.write(buf);
      return;
    }
    if (this.udp) this.udp.send(buf, dest.port, dest.address, () => {});
  }
  sendMsg(msg, dest) { this._send(sip.serialize(msg), dest); }

  // ---------- receiving ----------
  allowed(ip) { return this.allowPublic || isPrivate(ip); }
  trusted(src) { return src.proto === 'TRUNK' ? !!(this.trunks && this.trunks.list.has(src.trunk)) : this.allowed(src.address); }
  isBlocked(ip) { const until = this.blocked.get(ip); return !!(until && until > Date.now()); }
  receive(buf, src) {
    if (!this.running) return;
    src = { ...src, address: v4(src.address) };
    if (this.isBlocked(src.address)) { this.stats.blockedDrops++; return; }
    if (!buf || buf.length < 4 || /^[\s]*$/.test(buf.toString('latin1'))) return;   // keep-alive CRLFs
    this.stats.received++;
    let msg;
    try { msg = sip.parse(buf); } catch {
      this.stats.malformed++;
      this.logOnce(`malformed:${src.address}`, 'warn', `Ignored a message that isn't proper SIP from ${src.address}.`);
      return;
    }
    try { this.fixLocal(msg, src); if (msg.method) this.onRequest(msg, src); else this.onResponse(msg, src); }
    catch (e) { this.log('error', `Couldn't handle a ${msg.method || msg.status} from ${src.address}: ${e.message}`); }
  }
  fail(ip, why) {
    const now = Date.now();
    const list = (this.failures.get(ip) || []).filter((t) => now - t < this.failWindow);
    list.push(now); this.failures.set(ip, list);
    if (list.length >= this.maxFailures && !this.isBlocked(ip)) {
      this.blocked.set(ip, now + this.blockFor);
      this.log('warn', `Blocked ${ip} for ${Math.round(this.blockFor / 60000)} minutes after ${list.length} failed attempts (${why}).`);
      this.emit('blocked', ip); this.emit('change');
    }
  }

  // ---------- helpers ----------
  txKey(req, forMethod) {
    const via = sip.parseVia(sip.getHeader(req, 'via'));
    const method = forMethod || (req.method === 'ACK' ? 'INVITE' : req.method);
    return `${via.params.branch || `${sip.getHeader(req, 'call-id')}:${sip.parseCSeq(sip.getHeader(req, 'cseq')).seq}`}|${method}`;
  }
  responseDest(req) {
    const via = sip.parseVia(sip.getHeader(req, 'via'));
    if (req._src && (via.transport === 'TCP' || req._src.proto === 'TCP' || req._src.proto === 'TRUNK')) return req._src;
    return { proto: via.transport === 'TCP' ? 'TCP' : 'UDP', address: via.params.received || via.host, port: via.params.rport ? Number(via.params.rport) : (via.port || 5060) };
  }
  ourVia(proto, branch) { return `SIP/2.0/${proto} ${this.host}:${this.port};branch=${branch};rport`; }
  isUs(uri) {
    if (!uri || !uri.host) return false;
    const port = uri.port || 5060;
    return port === this.port && this.isOurHost(uri.host);
  }
  /** Where to send a request for this URI: a registered phone's real address when the URI is its contact. */
  uriDest(u) {
    if (!u || !/^\d{1,3}(\.\d{1,3}){3}$/.test(u.host)) return null;
    const port = u.port || 5060;
    for (const map of this.bindings.values()) {
      for (const b of map.values()) {
        try { const c = sip.parseUri(b.contact); if (c.host === u.host && (c.port || 5060) === port) return b.source; } catch { /* skip */ }
      }
    }
    return { proto: String(u.params.transport || 'udp').toUpperCase() === 'TCP' ? 'TCP' : 'UDP', address: u.host, port };
  }

  // ---------- replies we make ourselves ----------
  reply(req, status, reason, { headers = [], body, keep = true, toTag } = {}) {
    const res = sip.response(req, status, reason, { toTag: toTag || sip.newTag(), headers: [['server', AGENT], ...headers], body });
    const dest = this.responseDest(req);
    this.sendMsg(res, dest);
    if (keep && req.method !== 'ACK') {
      const key = this.txKey(req);
      const ctx = this.ctx.get(key) || { key, local: true, req, dest };
      ctx.last = res; ctx.final = status >= 200 ? status : ctx.final;
      if (status >= 200) { ctx.finalSent = true; this.finishCtx(ctx); }
      this.ctx.set(key, ctx);
      if (req.method === 'INVITE' && status >= 300) this.retransmitFinal(ctx, res);
    }
    return res;
  }
  /** Keep sending a failure response to an INVITE over UDP until the phone ACKs it (RFC 3261 timer G). */
  retransmitFinal(ctx, res) {
    if (ctx.dest.proto !== 'UDP') return;
    let wait = T1; const started = Date.now();
    const again = () => {
      if (ctx.acked || Date.now() - started > TIMEOUT || !this.running) return;
      this.sendMsg(res, ctx.dest); wait = Math.min(wait * 2, T2);
      ctx.timerG = setTimeout(again, wait); ctx.timerG.unref && ctx.timerG.unref();
    };
    ctx.timerG = setTimeout(again, wait); ctx.timerG.unref && ctx.timerG.unref();
  }
  finishCtx(ctx) {
    clearTimeout(ctx.cleanup);
    ctx.cleanup = setTimeout(() => {
      clearTimeout(ctx.timerG); this.ctx.delete(ctx.key);
      for (const b of ctx.branches || []) { this.clearBranchTimers(b); this.branches.delete(b.id); }
    }, TIMEOUT);
    ctx.cleanup.unref && ctx.cleanup.unref();
  }

  // ---------- digest authentication ----------
  nonce(ip) {
    const ts = Date.now().toString(16);
    return `${ts}.${crypto.createHmac('sha256', this.secret).update(`${ts}|${ip}`).digest('hex').slice(0, 24)}`;
  }
  nonceState(n, ip) {
    const m = /^([0-9a-f]{1,13})\.([0-9a-f]{24})$/.exec(String(n || ''));
    if (!m) return 'bad';
    const want = crypto.createHmac('sha256', this.secret).update(`${m[1]}|${ip}`).digest('hex').slice(0, 24);
    if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]))) return 'bad';
    const age = Date.now() - parseInt(m[1], 16);
    return age >= -60000 && age < NONCE_FRESH ? 'ok' : age < NONCE_STALE ? 'stale' : 'bad';
  }
  challenge(req, src, proxy, stale = false) {
    const h = `Digest realm="${this.realm}", nonce="${this.nonce(src.address)}", algorithm=MD5, qop="auth"${stale ? ', stale=TRUE' : ''}`;
    return this.reply(req, proxy ? 407 : 401, null, { headers: [[proxy ? 'proxy-authenticate' : 'www-authenticate', h]] });
  }
  /** The extension that signed this request, or null after replying (challenge or refusal). */
  authenticate(req, src, proxy, mustBe = null) {
    const auth = sip.parseAuth(sip.getHeader(req, proxy ? 'proxy-authorization' : 'authorization'));
    if (!auth || !/^digest$/i.test(auth.scheme)) { this.challenge(req, src, proxy); return null; }
    const p = auth.params;
    const ns = this.nonceState(p.nonce, src.address);
    if (ns !== 'ok' || (p.realm && p.realm !== this.realm)) { this.challenge(req, src, proxy, ns === 'stale'); return null; }
    const user = this.directory.user(p.username);
    const ok = !!user && (!mustBe || p.username === mustBe) && sip.digestOk(auth, req.method, user.password);
    if (!ok) {
      this.reply(req, 403, 'Forbidden (wrong password)');
      this.log('warn', `Wrong password for extension ${String(p.username || '?').slice(0, 20)} from ${src.address}.`);
      this.fail(src.address, 'wrong password');
      return null;
    }
    return user.ext;
  }

  // ---------- requests ----------
  onRequest(req, src) {
    // Note where the request really came from (RFC 3261 received, RFC 3581 rport) so replies get back through NAT.
    const vi = req.headers.findIndex((h) => h[0] === 'via');
    const via = sip.parseVia(req.headers[vi][1]);
    via.params.received = src.address;
    if ('rport' in via.params) via.params.rport = String(src.port);
    req.headers[vi][1] = sip.formatVia(via);
    req._src = src;

    if (!this.trusted(src)) {
      this.fail(src.address, 'outside the office network');
      this.logOnce(`public:${src.address}`, 'warn', `Refused ${req.method} from ${src.address}: only phones on the office network can use Riyeser Link Office.`);
      if (['REGISTER', 'INVITE', 'SUBSCRIBE'].includes(req.method) && !this.isBlocked(src.address)) this.reply(req, 403, 'Forbidden (office network only)', { keep: false });
      return;
    }
    if (req.method === 'ACK') return this.onAck(req, src);
    if (req.method === 'CANCEL') return this.onCancel(req, src);
    const existing = this.ctx.get(this.txKey(req));
    if (existing) { if (existing.last) this.sendMsg(existing.last, existing.dest); return; }   // a resend of something we're handling
    const mf = sip.getHeader(req, 'max-forwards');
    if (mf != null && !(Number(mf) > 0)) return this.reply(req, 483, null);
    const to = sip.parseNameAddr(sip.getHeader(req, 'to'));
    if (to.params.tag) return this.inDialog(req, src);
    switch (req.method) {
      case 'REGISTER': return this.onRegister(req, src);
      case 'INVITE': return this.onInvite(req, src);
      case 'OPTIONS': return this.reply(req, 200, null, { headers: [['allow', ALLOW], ['accept', 'application/sdp']] });
      case 'SUBSCRIBE': return this.onSubscribe(req, src);
      case 'NOTIFY': return this.reply(req, 200, null);
      case 'BYE': case 'PRACK': case 'UPDATE': case 'INFO': return this.reply(req, 481, null);
      case 'MESSAGE': case 'REFER': case 'PUBLISH': return this.reply(req, 405, null, { headers: [['allow', ALLOW]] });
      default: return this.reply(req, 501, null, { headers: [['allow', ALLOW]] });
    }
  }

  // ---------- REGISTER ----------
  onRegister(req, src) {
    const to = sip.parseNameAddr(sip.getHeader(req, 'to'));
    const ext = sip.userOf(to.parsed);
    if (!this.accepting) return this.reply(req, 403, 'Forbidden (needs Riyeser Link)');
    if (!this.authenticate(req, src, false, ext)) return;
    const map = this.bindings.get(ext) || new Map();
    const contacts = sip.getAll(req, 'contact');
    const hdrExp = sip.getHeader(req, 'expires');
    const ua = String(sip.getHeader(req, 'user-agent') || '').slice(0, 120);
    const now = Date.now();
    if (contacts.length === 1 && contacts[0] === '*') {
      if (hdrExp !== '0') return this.reply(req, 400, 'Bad Request (wildcard needs Expires: 0)');
      map.clear();
    } else {
      for (const c of contacts) {
        const na = sip.parseNameAddr(c);
        let exp = na.params.expires != null ? Number(na.params.expires) : hdrExp != null ? Number(hdrExp) : 3600;
        if (!Number.isFinite(exp) || exp < 0) exp = 3600;
        if (exp === 0) { map.delete(na.uri); continue; }
        exp = Math.min(3600, Math.max(60, exp));
        const before = map.get(na.uri);
        map.set(na.uri, { ext, contact: na.uri, source: { ...src }, ip: src.address, expires: exp, expiresAt: now + exp * 1000, userAgent: ua,
          device: /riyeser/i.test(ua) ? 'app' : 'desk phone', registeredAt: before ? before.registeredAt : now, callId: sip.getHeader(req, 'call-id') });
        if (!before) {
          this.log('info', `Extension ${ext} connected from ${src.address}${ua ? ` (${ua})` : ''}.`);
          if (!sameSubnet(src.address, this.ifaces)) this.logOnce(`subnet:${ext}:${src.address}`, 'warn', `Extension ${ext} is on a different network (${src.address}) from this PC. Calls connect, but there may be no sound if that network can't reach the other phones directly.`);
        }
      }
      while (map.size > MAX_BINDINGS) map.delete([...map.entries()].sort((a, b) => a[1].registeredAt - b[1].registeredAt)[0][0]);
    }
    if (map.size) this.bindings.set(ext, map); else this.bindings.delete(ext);
    const headers = [...map.values()].map((b) => ['contact', `<${b.contact}>;expires=${Math.max(0, Math.round((b.expiresAt - now) / 1000))}`]);
    headers.push(['date', new Date(now).toUTCString()]);
    this.reply(req, 200, null, { headers });
    this.emit('change');
  }
  contactsOf(ext) { return [...(this.bindings.get(String(ext)) || new Map()).values()].filter((b) => b.expiresAt > Date.now()); }

  // ---------- INVITE (a new call) ----------
  onInvite(req, src) {
    if (!this.accepting) return this.reply(req, 403, 'Forbidden (needs Riyeser Link)');
    const caller = this.authenticate(req, src, true);
    if (!caller) return;
    const key = this.txKey(req);
    const ctx = { key, req, dest: this.responseDest(req), method: 'INVITE', branches: [], best: null, initial: true };
    this.ctx.set(key, ctx);
    const trying = sip.response(req, 100, null, {}); this.sendMsg(trying, ctx.dest); ctx.last = trying;

    const dialled = sip.userOf(sip.parseUri(req.uri));
    const r = dialplan.resolve(dialled, this.directory);
    if (r.type === 'dnd') {
      this.directory.setDnd(caller, r.on); this.emit('change');
      this.log('info', `Extension ${caller} turned Do not disturb ${r.on ? 'on' : 'off'}.`);
      return this.reply(req, 603, r.on ? 'Do Not Disturb On' : 'Do Not Disturb Off');
    }
    if (r.type === 'none') {
      // Not on this PC: a trunk (the Riyeser relay, another branch) may reach it. None are set up yet.
      const via = !r.emergency && this.trunks && this.trunks.route(dialplan.normalise(dialled));
      if (!via) return this.reply(req, 404, `Not Found (${r.reason})`);
      ctx.call = this.newCall(req, caller, { type: 'ext', ext: dialplan.normalise(dialled) });
      this.fork(ctx, [{ dest: via.dest, uri: via.uri, ext: null }], { recordRoute: true });
      return;
    }
    let targets = [];
    if (r.type === 'ext') {
      if (r.ext === caller) return this.reply(req, 486, 'Busy Here (that is your own number)');
      if (this.directory.dnd(r.ext)) return this.missed(req, ctx, caller, r, 486, 'Busy Here (Do Not Disturb)', 'busy');
      targets = this.contactsOf(r.ext).map((b) => ({ binding: b, ext: r.ext }));
      if (!targets.length) return this.missed(req, ctx, caller, r, 480, 'Temporarily Unavailable (phone not connected)', 'unavailable');
    } else return this.ringGroup(req, ctx, caller, r);
    ctx.call = this.newCall(req, caller, r);
    this.fork(ctx, targets.map((t) => ({ dest: t.binding.source, uri: t.binding.contact, ext: t.ext })), { recordRoute: true });
    ctx.timerC = setTimeout(() => { ctx.noAnswer = true; this.cancelBranches(ctx); }, this.ringTimeout);
    ctx.timerC.unref && ctx.timerC.unref();
    this.emit('change');
  }
  // ---------- ring groups (ringgroups.js): only the chosen phones, all at once, in order or rotating ----------
  ringGroup(req, ctx, caller, r) {
    ctx.group = { caller, tried: new Set(), plan: null, i: 0, deadline: 0, skipped: [], members: 0 };
    this.groupLoad(ctx, this.directory.group(r.ext), r.ext);
    ctx.call = this.newCall(req, caller, r);
    if (this.groupNext(ctx)) return this.emit('change');
    const G = ctx.group;   // nobody could be rung at all
    const [status, reason, result] = !G.members ? [480, 'Temporarily Unavailable (nobody chosen for this group)', 'unavailable']
      : G.skipped.length && G.skipped.every((x) => x.why === 'dnd') ? [486, 'Busy Here (Do Not Disturb)', 'busy']
        : G.skipped.length && G.skipped.every((x) => x.why !== 'not_connected') ? [486, 'Busy Here (everyone is on a call)', 'busy']
          : [480, 'Temporarily Unavailable (no phones connected)', 'unavailable'];
    this.reply(req, status, reason);
    this.endCall(ctx.call, result);
  }
  groupLoad(ctx, g, key) {
    const G = ctx.group;
    if (!g || G.tried.has(key) || G.tried.size > 3) return false;
    G.tried.add(key);
    this.rotation = this.rotation || new Map();
    const turn = this.rotation.get(key) || 0;
    const p = ringgroups.plan(g, { caller: G.caller, dnd: (m) => this.directory.dnd(m), busy: (m) => this.onACall(m), contactsOf: (m) => this.contactsOf(m), turn, defaultMs: this.ringTimeout });
    if (p.strategy === 'rotate' && p.members) this.rotation.set(key, turn + 1);
    Object.assign(G, { plan: p, i: 0, deadline: Date.now() + p.totalMs, members: G.members + p.members, skipped: [...G.skipped, ...p.skipped] });
    return true;
  }
  /** Ring the group's next step, or move on to its fallback. false: there's nobody left to ring. */
  groupNext(ctx) {
    const G = ctx.group;
    if (ctx.cancelled || ctx.answered || ctx.finalSent) return false;
    while (G.plan) {
      if (G.i < G.plan.steps.length && Date.now() < G.deadline) {
        const step = G.plan.steps[G.i++];
        this.fork(ctx, step.map((t) => ({ dest: t.binding.source, uri: t.binding.contact, ext: t.ext })), { recordRoute: true });
        clearTimeout(ctx.timerC);
        ctx.timerC = setTimeout(() => { ctx.noAnswer = true; this.cancelBranches(ctx); }, Math.max(1, Math.min(G.plan.stepMs, G.deadline - Date.now())));
        ctx.timerC.unref && ctx.timerC.unref();
        return true;
      }
      const fb = G.plan.fallback; G.plan = null;
      if (fb && fb.type === 'group') this.groupLoad(ctx, this.directory.group(fb.ext), fb.ext);
      else if (fb && fb.type === 'person' && this.directory.person(fb.ext)) this.groupLoad(ctx, { members: [fb.ext], strategy: 'all' }, `person:${fb.ext}`);
    }
    return false;
  }
  /** On a call right now (talking, or dialling out), on any of their phones. */
  onACall(ext) { return this.callsInProgress().some((c) => c.from === String(ext) || c.answeredBy === String(ext)); }
  /** A call that couldn't ring anyone: answered here, and noted in recent calls. */
  missed(req, ctx, caller, r, status, reason, result) {
    const call = this.newCall(req, caller, r);
    this.reply(req, status, reason);
    this.endCall(call, result);
  }
  newCall(req, caller, r) {
    const id = sip.getHeader(req, 'call-id');
    const call = { id, from: caller, fromName: this.directory.nameOf(caller), to: r.ext, toName: this.directory.nameOf(r.ext), kind: r.type === 'group' ? 'group' : 'person',
      start: new Date().toISOString(), ringing: false, answeredAt: null, answeredBy: null, end: null, result: null, lastActivity: Date.now() };
    this.calls.set(id, call);
    return call;
  }
  endCall(call, result) {
    if (!call || call.end) return;
    call.end = new Date().toISOString(); call.result = result; call.active = false;
    const { lastActivity, ...rec } = call;
    this.emit('call-ended', rec); this.emit('change');
    setTimeout(() => { if (this.calls.get(call.id) === call) this.calls.delete(call.id); }, TIMEOUT).unref();
    if (!this.accepting && !this.callsInProgress().length) setImmediate(() => this.emit('idle'));
  }
  callsInProgress() { return [...this.calls.values()].filter((c) => !c.end); }

  // ---------- forwarding (client transactions) ----------
  fork(ctx, targets, { recordRoute = false } = {}) {
    const inProto = ctx.req._src.proto;
    for (const t of targets) {
      const fwd = sip.clone(ctx.req);
      delete fwd._src;
      fwd.uri = t.uri;
      const mf = Number(sip.getHeader(fwd, 'max-forwards'));
      sip.setHeader(fwd, 'max-forwards', String(Number.isFinite(mf) ? mf - 1 : 70));
      sip.removeHeader(fwd, 'proxy-authorization');   // our own credentials stay here
      if (recordRoute) {
        // A new call: drop any Route to us, and stay in the path so hold, transfer and hang-up come through here.
        while (sip.getHeader(fwd, 'route')) { try { if (!this.isUs(sip.parseNameAddr(sip.getHeader(fwd, 'route')).parsed)) break; } catch { /* bad route */ } sip.removeFirst(fwd, 'route'); }
        const rr = (proto) => `<sip:${this.host}:${this.port}${proto === 'TCP' ? ';transport=tcp' : ''};lr>`;
        if (inProto !== t.dest.proto) sip.prependHeader(fwd, 'record-route', rr(inProto));
        sip.prependHeader(fwd, 'record-route', rr(t.dest.proto));
      }
      const id = sip.newBranch();
      sip.prependHeader(fwd, 'via', this.ourVia(t.dest.proto, id));
      const b = { id, ctx, dest: t.dest, ext: t.ext, msg: fwd, buf: sip.serialize(fwd), provisional: false, final: null, method: ctx.method };
      this.branches.set(id, b); ctx.branches.push(b);
      this._send(b.buf, b.dest);
      this.startBranchTimers(b);
    }
  }
  startBranchTimers(b) {
    if (b.dest.proto === 'UDP') {
      let wait = T1;
      const again = () => {
        if (b.final || (b.method === 'INVITE' && b.provisional) || !this.running) return;
        this._send(b.buf, b.dest); wait = b.method === 'INVITE' ? wait * 2 : Math.min(wait * 2, T2);
        b.timerA = setTimeout(again, wait); b.timerA.unref && b.timerA.unref();
      };
      b.timerA = setTimeout(again, wait); b.timerA.unref && b.timerA.unref();
    }
    b.timerB = setTimeout(() => { if (!b.final && !(b.method === 'INVITE' && b.provisional)) this.branchFinal(b, null, 408); }, TIMEOUT);
    b.timerB.unref && b.timerB.unref();
  }
  clearBranchTimers(b) { clearTimeout(b.timerA); clearTimeout(b.timerB); clearTimeout(b.timerCancel); clearTimeout(b.timerCancelRe); }

  onResponse(res, src) {
    if (!this.trusted(src)) return;
    const via = sip.parseVia(sip.getHeader(res, 'via'));
    const cseq = sip.parseCSeq(sip.getHeader(res, 'cseq'));
    const b = this.branches.get(via.params.branch);
    if (!b && this.probes.has(via.params.branch)) return this.probeResponse(this.probes.get(via.params.branch), res, cseq);
    if (!b) {
      // A resent 200 OK after the call was set up: pass it on toward the caller.
      if (res.status >= 200 && res.status < 300 && cseq.method === 'INVITE' && this.isOurHost(via.host) && (via.port || 5060) === this.port && sip.getAll(res, 'via').length > 1) {
        sip.removeFirst(res, 'via');
        const next = sip.parseVia(sip.getHeader(res, 'via'));
        this.sendMsg(res, { proto: next.transport === 'TCP' ? 'TCP' : 'UDP', address: next.params.received || next.host, port: next.params.rport ? Number(next.params.rport) : (next.port || 5060) });
      }
      return;
    }
    if (cseq.method === 'CANCEL') { b.cancelAnswered = true; clearTimeout(b.timerCancelRe); return; }
    if (cseq.method !== b.method) return;
    sip.removeFirst(res, 'via');
    if (!sip.getHeader(res, 'via')) return;
    const ctx = b.ctx;
    clearTimeout(b.timerA);
    if (res.status < 200) {
      if (!b.provisional) { b.provisional = true; clearTimeout(b.timerB); }
      if (b.cancelPending) this.sendCancel(b);
      if (res.status > 100 && !ctx.finalSent && !b.cancelPending) {
        this.forwardUp(ctx, res);
        if (ctx.call && (res.status === 180 || res.status === 183) && !ctx.call.ringing) { ctx.call.ringing = true; this.emit('change'); }
      }
      return;
    }
    this.branchFinal(b, res, res.status);
  }
  /** A branch has its final answer (res is null when it timed out). */
  branchFinal(b, res, status) {
    const ctx = b.ctx;
    if (b.final && !(status < 300 && res)) return;
    const first = !b.final; b.final = status; this.clearBranchTimers(b);
    if (res && b.method === 'INVITE' && status >= 300) this.ackBranch(b, res);
    if (status < 300 && res) {
      this.forwardUp(ctx, res);   // every 200 OK goes to the caller
      if (!ctx.answered) {
        ctx.answered = true; ctx.finalSent = true; clearTimeout(ctx.timerC);
        for (const o of ctx.branches) if (o !== b && !o.final) this.cancelBranch(o);
        if (ctx.call && ctx.initial) {
          Object.assign(ctx.call, { answeredAt: new Date().toISOString(), answeredBy: b.ext, active: true, lastActivity: Date.now() });
          this.log('info', `Call from ${ctx.call.from} to ${ctx.call.to} answered${b.ext !== ctx.call.to ? ` by ${b.ext}` : ''}.`);
          this.emit('change');
        }
        if (ctx.method === 'BYE') this.endCall(this.calls.get(sip.getHeader(ctx.req, 'call-id')), 'answered');
        this.finishCtx(ctx);
      }
      return;
    }
    if (!first || ctx.finalSent) return;
    if (res && (!ctx.best || rank(status) < rank(ctx.best.status))) ctx.best = res;
    if (ctx.branches.every((x) => x.final) && !(ctx.group && this.groupNext(ctx))) this.finalUp(ctx);
  }
  finalUp(ctx) {
    if (ctx.finalSent) return;
    ctx.finalSent = true; clearTimeout(ctx.timerC);
    let res = ctx.best;
    if (ctx.cancelled) res = sip.response(ctx.req, 487, null, { toTag: sip.newTag() });
    else if (ctx.noAnswer && ctx.method === 'INVITE') res = sip.response(ctx.req, 480, 'Temporarily Unavailable (no answer)', { toTag: sip.newTag() });
    else if (!res) res = sip.response(ctx.req, 408, null, { toTag: sip.newTag() });
    this.forwardUp(ctx, res);
    if (ctx.method === 'INVITE') this.retransmitFinal(ctx, res);
    if (ctx.call && ctx.initial) {
      const s = res.status;
      this.endCall(ctx.call, ctx.cancelled || ctx.noAnswer ? 'missed' : s === 486 || s === 600 ? 'busy' : s === 603 ? 'declined' : s === 480 || s === 408 ? 'unavailable' : 'failed');
    }
    if (ctx.method === 'BYE') this.endCall(this.calls.get(sip.getHeader(ctx.req, 'call-id')), 'answered');
    this.finishCtx(ctx);
  }
  forwardUp(ctx, res) {
    this.sendMsg(res, ctx.dest);
    ctx.last = res;   // sent again if the phone repeats its request
  }
  ackBranch(b, res) {
    const ack = { method: 'ACK', uri: b.msg.uri, headers: [], body: Buffer.alloc(0) };
    ack.headers.push(['via', sip.getHeader(b.msg, 'via')]);
    for (const r of sip.getAll(b.msg, 'route')) ack.headers.push(['route', r]);
    ack.headers.push(['max-forwards', '70'], ['from', sip.getHeader(b.msg, 'from')], ['to', sip.getHeader(res, 'to')],
      ['call-id', sip.getHeader(b.msg, 'call-id')], ['cseq', `${sip.parseCSeq(sip.getHeader(b.msg, 'cseq')).seq} ACK`]);
    this.sendMsg(ack, b.dest);
  }
  cancelBranches(ctx) { for (const b of ctx.branches) if (!b.final) this.cancelBranch(b); }
  cancelBranch(b) {
    if (b.final || b.cancelSent) return;
    if (b.provisional) this.sendCancel(b);
    else {
      b.cancelPending = true;
      // A phone that never even said "trying": stop waiting for it.
      clearTimeout(b.timerCancel);
      b.timerCancel = setTimeout(() => { if (!b.final) this.branchFinal(b, null, 487); }, 4 * T2);
      b.timerCancel.unref && b.timerCancel.unref();
    }
  }
  sendCancel(b) {
    if (b.cancelSent || b.final) return;
    b.cancelSent = true; b.cancelPending = false;
    const c = { method: 'CANCEL', uri: b.msg.uri, headers: [], body: Buffer.alloc(0) };
    c.headers.push(['via', sip.getHeader(b.msg, 'via')]);
    for (const r of sip.getAll(b.msg, 'route')) c.headers.push(['route', r]);
    c.headers.push(['max-forwards', '70'], ['from', sip.getHeader(b.msg, 'from')], ['to', sip.getHeader(b.msg, 'to')],
      ['call-id', sip.getHeader(b.msg, 'call-id')], ['cseq', `${sip.parseCSeq(sip.getHeader(b.msg, 'cseq')).seq} CANCEL`]);
    const buf = sip.serialize(c);
    this._send(buf, b.dest);
    if (b.dest.proto === 'UDP') {
      let wait = T1;
      const again = () => { if (b.cancelAnswered || b.final || !this.running) return; this._send(buf, b.dest); wait = Math.min(wait * 2, T2); b.timerCancelRe = setTimeout(again, wait); b.timerCancelRe.unref && b.timerCancelRe.unref(); };
      b.timerCancelRe = setTimeout(again, wait); b.timerCancelRe.unref && b.timerCancelRe.unref();
    }
    clearTimeout(b.timerCancel);
    b.timerCancel = setTimeout(() => { if (!b.final) this.branchFinal(b, null, 487); }, TIMEOUT);
    b.timerCancel.unref && b.timerCancel.unref();
  }

  // ---------- ACK and CANCEL from phones ----------
  onAck(req, src) {
    const ctx = this.ctx.get(this.txKey(req));
    if (ctx && ctx.finalSent && !ctx.answered) { ctx.acked = true; clearTimeout(ctx.timerG); return; }   // ACK for a failure we sent
    const to = sip.parseNameAddr(sip.getHeader(req, 'to'));
    if (to.params.tag) this.inDialog(req, src);
  }
  onCancel(req) {
    const ctx = this.ctx.get(this.txKey(req, 'INVITE'));
    if (!ctx) return this.reply(req, 481, null, { keep: false });
    this.reply(req, 200, null, { keep: false, toTag: sip.parseNameAddr(sip.getHeader(req, 'to')).params.tag || undefined });
    if (ctx.local || ctx.finalSent) return;
    ctx.cancelled = true;
    this.cancelBranches(ctx);
  }

  // ---------- requests inside a call (ACK for 200, BYE, re-INVITE, REFER, …) ----------
  inDialog(req, src) {
    const callId = sip.getHeader(req, 'call-id');
    const call = this.calls.get(callId);
    if (!call) { if (req.method !== 'ACK') this.reply(req, 481, null); return; }
    let routes = sip.getAll(req, 'route');
    if (routes.length) { try { if (this.isUs(sip.parseNameAddr(routes[0]).parsed)) { sip.removeFirst(req, 'route'); routes = routes.slice(1); } } catch { /* bad route */ } }
    let target;
    try { target = routes.length ? sip.parseNameAddr(routes[0]).parsed : sip.parseUri(req.uri); } catch { target = null; }
    const dest = this.uriDest(target);
    if (!dest || !this.allowed(dest.address) || this.isUs(target)) { if (req.method !== 'ACK') this.reply(req, 404, 'Not Found (no route)'); return; }
    call.lastActivity = Date.now();
    const fwd = sip.clone(req); delete fwd._src;
    const mf = Number(sip.getHeader(fwd, 'max-forwards'));
    sip.setHeader(fwd, 'max-forwards', String(Number.isFinite(mf) ? mf - 1 : 70));
    if (req.method === 'ACK') {   // the ACK for a 200 OK goes straight on (it has no reply)
      sip.prependHeader(fwd, 'via', this.ourVia(dest.proto, sip.newBranch()));
      this.sendMsg(fwd, dest);
      return;
    }
    if (req.method === 'BYE') this.log('info', `Call from ${call.from} to ${call.to} hung up.`);
    const key = this.txKey(req);
    const ctx = { key, req, dest: this.responseDest(req), method: req.method, branches: [], best: null, initial: false };
    this.ctx.set(key, ctx);
    if (req.method === 'INVITE') { const t = sip.response(req, 100, null, {}); this.sendMsg(t, ctx.dest); ctx.last = t; }
    this.fork(ctx, [{ dest, uri: req.uri, ext: null }]);
  }

  // ---------- desk-phone plug-and-play (SUBSCRIBE Event: ua-profile) ----------
  onSubscribe(req, src) {
    const ev = String(sip.getHeader(req, 'event') || '');
    if (!/^ua-profile\b/i.test(ev)) return this.reply(req, 489, null, { headers: [['allow-events', 'ua-profile']] });
    if (!this.accepting) return this.reply(req, 403, 'Forbidden (needs Riyeser Link)');
    const params = sip.parseParams(ev.slice(ev.indexOf(';') + 1));
    const from = sip.parseNameAddr(sip.getHeader(req, 'from'));
    let mac = null;
    for (const u of [sip.userOf(from.parsed), (() => { try { return sip.userOf(sip.parseUri(req.uri)); } catch { return ''; } })()]) {
      const m = /^(?:MAC:?)?([0-9a-f]{2}(?:[:-]?[0-9a-f]{2}){5})$/i.exec(u || '');
      if (m) { mac = m[1].replace(/[:-]/g, '').toLowerCase(); break; }
    }
    if (!mac) return this.reply(req, 400, 'Bad Request (no MAC address)');
    const toTag = sip.newTag();
    this.reply(req, 200, null, { toTag, headers: [['expires', '0'], ['contact', `<sip:${this.host}:${this.port}>`]] });
    const info = { mac, vendor: String(params.vendor || '').slice(0, 40), model: String(params.model || '').slice(0, 40), version: String(params.version || '').slice(0, 40), address: src.address };
    let url = null;
    try { url = this.onPnp ? this.onPnp(info) : null; } catch (e) { this.log('error', `Plug-and-play: ${e.message}`); }
    if (!url) return;
    let target = null;
    try { target = sip.parseNameAddr(sip.getHeader(req, 'contact')).uri; } catch { /* use the address it came from */ }
    const notify = { method: 'NOTIFY', uri: target || `sip:${src.address}:${src.port}`, headers: [], body: Buffer.from(url) };
    notify.headers.push(['via', this.ourVia(src.proto, sip.newBranch())], ['max-forwards', '70'],
      ['from', `${sip.getHeader(req, 'to')};tag=${toTag}`], ['to', sip.getHeader(req, 'from')], ['call-id', sip.getHeader(req, 'call-id')],
      ['cseq', '1 NOTIFY'], ['event', 'ua-profile;effective-by=0'], ['subscription-state', 'terminated;reason=timeout'],
      ['content-type', 'application/url'], ['contact', `<sip:${this.host}:${this.port}>`], ['user-agent', AGENT]);
    this.sendMsg(notify, { proto: src.proto, address: src.address, port: src.port });
  }

  /**
   * Ask a phone to fetch its settings again (SIP NOTIFY check-sync). Best effort: not every phone allows it.
   * event: the maker's own wording (see provision.js resyncEvent): 'check-sync;reboot=false' by default, or with
   * reboot=true after this PC's address changed (a restart makes the phone ask plug-and-play for the new address).
   */
  checkSync(address, port = 5060, event = 'check-sync;reboot=false') {
    const n = { method: 'NOTIFY', uri: `sip:${address}:${port}`, headers: [], body: Buffer.alloc(0) };
    n.headers.push(['via', this.ourVia('UDP', sip.newBranch())], ['max-forwards', '70'], ['from', `<sip:${this.host}:${this.port}>;tag=${sip.newTag()}`],
      ['to', `<sip:${address}:${port}>`], ['call-id', sip.newCallId(this.host)], ['cseq', '1 NOTIFY'], ['event', String(event || 'check-sync;reboot=false').replace(/[\r\n]/g, '')],
      ['subscription-state', 'terminated'], ['user-agent', AGENT]);
    this.sendMsg(n, { proto: 'UDP', address, port });
  }

  /**
   * "Find this phone" (1.2.3): ring one desk phone for a few seconds, shown as a call from "Riyeser Link Office", then
   * stop. Nobody can talk on it (no audio is offered). Only for a phone connected now. -> true when the ring was sent.
   */
  ring(ext, { ip = null, seconds = 5, from = 'Find this phone' } = {}) {
    const map = this.bindings.get(String(ext)); if (!map || !this.running) return false;
    const now = Date.now();
    const b = [...map.values()].find((x) => x.expiresAt > now && x.device !== 'app' && (!ip || x.ip === ip)); if (!b) return false;
    const dest = { proto: b.source.proto, address: b.source.address, port: b.source.port };
    const branch = sip.newBranch();
    const sdp = `v=0\r\no=riyeser 1 1 IN IP4 ${this.host}\r\ns=-\r\nc=IN IP4 ${this.host}\r\nt=0 0\r\nm=audio 9 RTP/AVP 0 8\r\na=inactive\r\n`;
    const msg = { method: 'INVITE', uri: b.contact, headers: [], body: Buffer.from(sdp) };
    msg.headers.push(['via', this.ourVia(dest.proto, branch)], ['max-forwards', '70'], ['from', `"${String(from).replace(/["\r\n]/g, '')}" <sip:riyeser@${this.host}:${this.port}>;tag=${sip.newTag()}`],
      ['to', `<sip:${ext}@${this.host}>`], ['call-id', sip.newCallId(this.host)], ['cseq', '1 INVITE'], ['contact', `<sip:riyeser@${this.host}:${this.port}>`],
      ['content-type', 'application/sdp'], ['user-agent', AGENT]);
    const pr = { msg, dest, branch, provisional: false, final: false, timers: [] };
    this.probes.set(branch, pr);
    const later = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); pr.timers.push(t); };
    const buf = sip.serialize(msg); this._send(buf, dest);
    if (dest.proto === 'UDP') for (const ms of [500, 1500]) later(() => { if (!pr.provisional && !pr.final) this._send(buf, dest); }, ms);
    later(() => this.probeStop(pr), Math.max(1, Math.min(15, seconds)) * 1000);
    later(() => { pr.timers.forEach(clearTimeout); this.probes.delete(branch); }, 32000);
    return true;
  }
  probeStop(pr) {
    if (pr.final || pr.cancelled) return; pr.cancelled = true;
    const c = { method: 'CANCEL', uri: pr.msg.uri, headers: [['via', sip.getHeader(pr.msg, 'via')], ['max-forwards', '70'], ['from', sip.getHeader(pr.msg, 'from')], ['to', sip.getHeader(pr.msg, 'to')],
      ['call-id', sip.getHeader(pr.msg, 'call-id')], ['cseq', '1 CANCEL']], body: Buffer.alloc(0) };
    this.sendMsg(c, pr.dest);
  }
  probeResponse(pr, res, cseq) {
    if (cseq.method !== 'INVITE') return;
    if (res.status < 200) { pr.provisional = true; return; }
    if (pr.final) return; pr.final = true;
    const to = sip.getHeader(res, 'to');
    const ack = (branch) => ({ method: 'ACK', uri: pr.msg.uri, headers: [['via', this.ourVia(pr.dest.proto, branch)], ['max-forwards', '70'], ['from', sip.getHeader(pr.msg, 'from')], ['to', to],
      ['call-id', sip.getHeader(pr.msg, 'call-id')], ['cseq', '1 ACK']], body: Buffer.alloc(0) });
    if (res.status >= 300) { this.sendMsg(ack(pr.branch), pr.dest); return; }
    // someone picked it up: say goodbye straight away
    let target = pr.msg.uri; try { target = sip.parseNameAddr(sip.getHeader(res, 'contact')).uri || target; } catch { /* the same address */ }
    const a = ack(sip.newBranch()); a.uri = target; this.sendMsg(a, pr.dest);
    const bye = { method: 'BYE', uri: target, headers: [['via', this.ourVia(pr.dest.proto, sip.newBranch())], ['max-forwards', '70'], ['from', sip.getHeader(pr.msg, 'from')], ['to', to],
      ['call-id', sip.getHeader(pr.msg, 'call-id')], ['cseq', '2 BYE'], ['user-agent', AGENT]], body: Buffer.alloc(0) };
    this.sendMsg(bye, pr.dest);
  }

  // ---------- housekeeping ----------
  sweep() {
    const now = Date.now(); let changed = false;
    for (const [ext, map] of this.bindings) {
      for (const [k, b] of map) if (b.expiresAt + 10000 < now) { map.delete(k); changed = true; this.log('info', `Extension ${ext} at ${b.ip} disconnected (it stopped checking in).`); }
      if (!map.size) this.bindings.delete(ext);
    }
    for (const [ip, until] of this.blocked) if (until <= now) { this.blocked.delete(ip); this.failures.delete(ip); changed = true; }
    for (const [ip, list] of this.failures) if (!list.some((t) => now - t < this.failWindow)) this.failures.delete(ip);
    for (const c of this.calls.values()) if (!c.end && now - c.lastActivity > STALE_CALL) this.endCall(c, c.answeredAt ? 'answered' : 'missed');
    if (changed) this.emit('change');
  }

  /** What the status screen shows. */
  snapshot() {
    const now = Date.now();
    const regs = [];
    for (const map of this.bindings.values()) for (const b of map.values()) if (b.expiresAt > now) regs.push({ ext: b.ext, ip: b.ip, device: b.device, userAgent: b.userAgent, since: new Date(b.registeredAt).toISOString(), proto: b.source.proto, port: b.source.port });
    const calls = this.callsInProgress().map((c) => ({ from: c.from, fromName: c.fromName, to: c.to, toName: c.toName, answeredBy: c.answeredBy, state: c.answeredAt ? 'talking' : 'ringing', start: c.start, answeredAt: c.answeredAt }));
    return { running: this.running, accepting: this.accepting, host: this.host, oldHosts: [...this.oldHosts], port: this.port, tcp: !!this.tcp, registrations: regs, calls,
      blocked: [...this.blocked.entries()].filter(([, u]) => u > now).map(([ip, until]) => ({ ip, until: new Date(until).toISOString() })), stats: { ...this.stats } };
  }
}

module.exports = { Pbx, PNP_GROUP, ALLOW };
