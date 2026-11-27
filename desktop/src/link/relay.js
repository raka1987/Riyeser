// Link Office and the Riyeser relay (1.3.0): the trunk that joins this office to the business's other sites and to
// phones at home. See desktop/RELAY.md for the design.
//
// - One OUTGOING wss connection to the relay (no port forwarding; fine behind CGNAT). If it drops (the internet
//   blinked, this office's public IP changed, the relay restarted) it reconnects with backoff and announces this
//   office's connected extensions again.
// - Failover: the business has an ordered list of relays (main first, then backups), each with its own pass. If the
//   one in use stops answering (a ping every 3 s; gone after 8 s) or closes, the next one is used straight away.
//   While on a backup, the main relay is tried every 30 s; once it answers, new calls go through it and the backup
//   connection is kept ("draining") until the calls in progress have ended.
// - Calls inside this office never touch the relay, and keep working with no internet.
// A self-signed relay is trusted only if its certificate is exactly the one Riyeser online lists ("pin").
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const ws = require('./ws');
const sip = require('./sip');

const PING_EVERY = 3000; const DEAD_AFTER = 8000;
const FAILBACK_EVERY = 30000; const DRAIN_MAX = 2 * 3600 * 1000;
const CONFIG_EVERY = 5 * 60 * 1000;
const backoff = (n) => Math.min(60000, 1000 * 2 ** Math.min(n, 6)) * (0.75 + Math.random() * 0.5);

class RelayLink extends EventEmitter {
  /**
   * opts: { getConfig: async () => ({ enabled, relays: [{ id, url, host, region, ip, pin }], tokens: { id: pass }, exp }),
   *         siteName: () => 'Suva', log, connect (ws.connect, for tests), probe = true, callsInProgress: () => n }
   */
  constructor(opts = {}) {
    super();
    this.id = 'relay'; this.name = 'Riyeser relay';
    this.getConfig = opts.getConfig; this.siteName = opts.siteName || (() => '');
    this.logFn = opts.log || (() => {}); this.connectFn = opts.connect || ws.connect;
    this.doProbe = opts.probe !== false; this.callsInProgress = opts.callsInProgress || (() => 0);
    this.timing = { pingEvery: PING_EVERY, deadAfter: DEAD_AFTER, failbackEvery: FAILBACK_EVERY, ...(opts.timing || {}) };
    this.conns = new Map();        // relay id -> { id, relay, ws, welcome, routes, rtt, since, lastPong, draining }
    this.active = null; this.config = null; this.configAt = 0;
    this.exts = []; this.failures = 0; this.reconnects = 0;
    this.state = 'starting'; this.error = null; this.udp = null; this.knownRemote = new Set();
  }
  log(l, t) { try { this.logFn(l, t); } catch { /* never mind */ } }

  // ---------- the trunk interface (trunks.js) ----------
  async start({ pbx } = {}) {
    this.pbx = pbx; this.stopped = false;
    this.loop().catch(() => {});
    this.failbackTimer = setInterval(() => this.failback().catch(() => {}), this.timing.failbackEvery); this.failbackTimer.unref && this.failbackTimer.unref();
  }
  async stop() {
    this.stopped = true; clearTimeout(this.retry); clearInterval(this.failbackTimer);
    for (const c of [...this.conns.values()]) this.drop(c, 'stopping');
    this.active = null; this.set('off');
  }
  status() {
    const c = this.activeConn();
    const primary = this.config && this.config.relays && this.config.relays[0];
    const r = c ? c.relay : null;
    const others = c && c.routes ? c.routes.sites || [] : [];
    return {
      connected: !!c, state: this.state, relay: r ? r.id : null, region: r ? r.region || '' : '', host: r ? r.host : '', rtt: c ? c.rtt : null,
      backup: !!(c && primary && c.id !== primary.id), primary: primary ? { id: primary.id, region: primary.region || '' } : null,
      sites: others.map((s) => ({ name: s.name || s.office, exts: s.exts, via: s.via })), remote: c && c.routes ? (c.routes.remote || []).length : 0, phones: c && c.routes ? c.routes.phones || 0 : 0,
      udp: c ? c.udp || 'checking' : null, since: c ? new Date(c.since).toISOString() : null, error: this.error, reconnects: this.reconnects,
      draining: [...this.conns.values()].filter((x) => x.draining).map((x) => x.id), relays: (this.config && this.config.relays || []).map((x) => ({ id: x.id, region: x.region || '', online: x.online })),
      detail: this.detail(),
    };
  }
  detail() {
    const c = this.activeConn();
    if (c) return `${c.id !== (this.config && this.config.relays[0] || {}).id ? 'Using backup relay' : 'Connected to Riyeser relay'} · ${c.relay.region || c.relay.host}${c.rtt != null ? ` · ${c.rtt} ms` : ''}`;
    if (this.state === 'off') return 'The Riyeser relay is switched off for this business.';
    if (this.state === 'refused') return `The relay refused this office: ${this.error || 'ask an admin to check Phones → Sites and the relay'}.`;
    if (this.state === 'no-config') return this.error || 'Waiting for Riyeser Link (sign in, and link this PC to the business).';
    return `Connecting to the Riyeser relay…${this.error ? ` (${this.error})` : ''}`;
  }
  activeConn() { const c = this.active && this.conns.get(this.active); return c && c.ws && c.ws.open ? c : null; }
  /** Can the relay reach this number (an extension with a phone at another site or at home, or a group with such a member)? */
  route(number, { members } = {}) {
    const c = this.activeConn(); if (!c || !c.routes) return null;
    const remote = new Set(c.routes.remote || []);
    if (!(remote.has(String(number)) || (members || []).some((m) => remote.has(String(m))))) return null;
    return { dest: { proto: 'TRUNK', trunk: this.id, relay: c.id, address: c.relay.host, port: 0 }, uri: `sip:${number}@${c.relay.host}` };
  }
  /** Was this number reachable through the relay before it went away? (for a clearer "can't reach" reason) */
  wasRemote(number) { return this.knownRemote.has(String(number)); }
  /** A Route or Request-URI pointing at one of our relays: where to send it. */
  owns(uri) {
    if (!uri) return null;
    const rly = uri.params && uri.params.rly;
    for (const c of this.conns.values()) {
      if ((rly && rly === c.id) || (!uri.user && c.relay.host && String(uri.host).toLowerCase() === c.relay.host.toLowerCase())) {
        return { proto: 'TRUNK', trunk: this.id, relay: c.id, address: c.relay.host, port: 0 };
      }
    }
    return null;
  }
  send(buf, dest) {
    const c = (dest && dest.relay && this.conns.get(dest.relay)) || this.activeConn();
    if (c && c.ws && c.ws.open) c.ws.send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }
  /** This office's extensions with a phone connected right now. */
  setExts(list) {
    const next = [...new Set((list || []).map(String))].sort();
    if (next.join(',') === this.exts.join(',')) return;
    this.exts = next;
    for (const c of this.conns.values()) this.announce(c);
  }
  announce(c) { if (c.ws && c.ws.open) c.ws.sendJson({ t: 'exts', exts: c.draining ? [] : this.exts, draining: !!c.draining, name: String(this.siteName() || '').slice(0, 60) }); }
  /** Something changed on this side (the PC's address, the network): check the connection now. */
  nudge() { const c = this.activeConn(); if (c) this.ping(c); else { clearTimeout(this.retry); this.loop().catch(() => {}); } }

  // ---------- connecting, failover, fail-back ----------
  set(state, error = null) { const was = `${this.state}|${this.error}`; this.state = state; this.error = error; if (was !== `${state}|${error}`) this.emit('change', this.status()); }
  async refreshConfig(force = false) {
    if (!force && this.config && Date.now() - this.configAt < CONFIG_EVERY && (Number(this.config.exp) || 0) * 1000 > Date.now() + 10 * 60 * 1000) return this.config;
    const cfg = await this.getConfig();
    this.config = cfg; this.configAt = Date.now();
    return cfg;
  }
  async loop() {
    if (this.stopped || this.looping) return;
    this.looping = true;
    try {
      while (!this.stopped && !this.activeConn()) {
        let cfg;
        try { cfg = await this.refreshConfig(this.failures > 0); } catch (e) { this.set('no-config', String(e.message || e).slice(0, 200)); await this.sleep(backoff(this.failures++)); continue; }
        if (!cfg || !cfg.enabled) { this.set('off'); await this.sleep(CONFIG_EVERY); this.configAt = 0; continue; }
        // the relay that just went away is tried last for a minute (fail-back brings us home once it answers)
        const avoid = this.avoid && Date.now() - this.avoid.at < 60000 ? this.avoid.id : null;
        const relays = [...(cfg.relays || [])].sort((a, b) => (a.id === avoid) - (b.id === avoid));
        if (!relays.length) { this.set('no-config', 'No Riyeser relay is set up yet.'); await this.sleep(CONFIG_EVERY); continue; }
        if (this.state !== 'connecting') this.set('connecting', this.error);
        let ok = false; let refused = null;
        for (const r of relays) {
          if (this.stopped) return;
          try { await this.open(r); ok = true; break; } catch (e) {
            if (e.status === 401 && e.body && e.body.code === 'expired') this.configAt = 0;
            if (e.status === 403) refused = (e.body && e.body.error) || e.message;
            this.log('warn', `Couldn't connect to the relay ${r.region || r.host} (${e.code === 'PIN' ? 'its certificate isn\'t the one Riyeser online lists' : e.message}).`);
            this.error = e.code === 'PIN' ? 'the relay\'s certificate isn\'t the expected one' : String(e.message || e).slice(0, 200);
          }
        }
        if (ok) { this.failures = 0; break; }
        if (refused) this.set('refused', String(refused).replace(/^The relay refused this office: /, '').replace(/\.$/, ''));
        else this.set('connecting', this.error);
        await this.sleep(backoff(this.failures++));
      }
    } finally { this.looping = false; }
  }
  sleep(ms) { return new Promise((r) => { clearTimeout(this.retry); this.retry = setTimeout(r, ms); this.retry.unref && this.retry.unref(); }); }
  /** Connect to one relay; it becomes the active one. */
  async open(r, { asActive = true } = {}) {
    const token = this.config.tokens && this.config.tokens[r.id];
    if (!token) throw new Error('no pass for this relay');
    const urls = [r.url];
    const conn = await this.connectTry(r, token);
    const c = { id: r.id, relay: r, ws: conn, welcome: null, routes: null, rtt: null, since: Date.now(), lastPong: Date.now(), draining: false };
    void urls;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the relay didn\'t say hello')), 5000);
      conn.on('message', (data, binary) => {
        if (binary) { if (this.pbx) this.pbx.receive(data, { proto: 'TRUNK', trunk: this.id, relay: c.id, address: c.relay.host, port: 0 }); return; }
        let m; try { m = JSON.parse(data); } catch { return; }
        if (m.t === 'welcome') { c.welcome = m; clearTimeout(t); resolve(); }
        else if (m.t === 'routes') { c.routes = m; if (this.active === c.id) for (const x of m.remote || []) this.knownRemote.add(String(x)); this.emit('change', this.status()); }
        else if (m.t === 'pong') { c.lastPong = Date.now(); if (m.at) c.rtt = Math.max(0, Date.now() - Number(m.at)); this.emit('rtt', c.rtt); }
        else if (m.t === 'bye') { c.byeReason = String(m.reason || '').slice(0, 200); }
      });
      conn.on('close', () => { clearTimeout(t); reject(new Error(c.byeReason || 'the relay closed the connection')); this.lost(c); });
      conn.on('error', () => {});
    });
    this.conns.set(c.id, c);
    c.pinger = setInterval(() => this.ping(c), this.timing.pingEvery); c.pinger.unref && c.pinger.unref();
    this.ping(c);
    if (asActive) this.makeActive(c);
    if (this.doProbe) this.probe(c).catch(() => {});
    return c;
  }
  async connectTry(r, token) {
    const opts = { headers: { Authorization: `Bearer ${token}`, 'X-Riyeser-Site': String(this.siteName() || '').replace(/[^\x20-\x7e]/g, '').slice(0, 60) }, pin: r.pin || undefined, ca: r.ca, timeout: 4000 };
    try { return await this.connectFn(r.url, opts); } catch (e) {
      // the name doesn't resolve (or points at an old address): try the address the relay last reported
      let host = ''; try { host = new URL(r.url).hostname; } catch { /* keep '' */ }
      if (r.ip && r.ip !== host && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(e.code)) return this.connectFn(r.url, { ...opts, lookupAddress: r.ip });
      throw e;
    }
  }
  makeActive(c) {
    const prev = this.active && this.active !== c.id ? this.conns.get(this.active) : null;
    this.active = c.id; c.draining = false;
    this.announce(c);
    const primary = this.config.relays[0];
    this.log('info', `${c.id === primary.id ? 'Connected to the Riyeser relay' : 'Using backup relay'} (${c.relay.region || c.relay.host}).`);
    if (prev) { prev.draining = true; this.announce(prev); this.drainLater(prev); }
    this.set('connected');
  }
  /** Keep an old relay connection while calls set up through it may still be going, then close it. */
  drainLater(c) {
    const started = Date.now();
    const check = () => {
      if (!this.conns.has(c.id) || this.conns.get(c.id) !== c || !c.draining) return;
      if (!this.callsInProgress() || Date.now() - started > DRAIN_MAX) { this.drop(c, 'drained'); return; }
      c.drainTimer = setTimeout(check, 5000); c.drainTimer.unref && c.drainTimer.unref();
    };
    check();
  }
  ping(c) {
    if (!c.ws || !c.ws.open) return;
    if (Date.now() - c.lastPong > this.timing.deadAfter) { this.log('warn', `The relay ${c.relay.region || c.id} stopped answering.`); this.avoid = { id: c.id, at: Date.now() }; c.ws.terminate(); return; }
    c.ws.sendJson({ t: 'ping', id: crypto.randomBytes(4).toString('hex'), at: Date.now() });
  }
  drop(c, why) { clearInterval(c.pinger); clearTimeout(c.drainTimer); if (this.conns.get(c.id) === c) this.conns.delete(c.id); try { c.ws.close(1000, why); } catch { /* gone */ } }
  lost(c) {
    clearInterval(c.pinger); clearTimeout(c.drainTimer);
    if (this.conns.get(c.id) !== c) return;
    this.conns.delete(c.id);
    if (this.stopped) return;
    if (this.active === c.id) {
      this.active = null; this.reconnects++;
      this.log('warn', `Lost the connection to the relay ${c.relay.region || c.id}${c.byeReason ? ` (${c.byeReason})` : ''}. Calls inside this office carry on; reconnecting.`);
      if (c.byeReason && /revoked|disconnected|switched the relay off|replaced/.test(c.byeReason)) { this.configAt = 0; this.error = c.byeReason; }
      this.set('connecting', c.byeReason || 'connection lost');
      // a draining backup still connected? use it straight away while we look again
      const spare = [...this.conns.values()].find((x) => x.ws.open);
      if (spare) { this.makeActive(spare); return; }
      this.failures = c.byeReason ? 1 : 0;
      setImmediate(() => this.loop().catch(() => {}));
    }
  }
  /** While on a backup: is the main relay (or one before this) back? Then move new calls to it. */
  async failback() {
    const c = this.activeConn(); if (!c || this.stopped || this.failingBack || !this.config) return;
    const order = this.config.relays.map((r) => r.id); const at = order.indexOf(c.id);
    if (at <= 0) return;
    this.failingBack = true;
    try {
      await this.refreshConfig().catch(() => null);
      for (const r of this.config.relays.slice(0, at)) {
        try { const n = await this.open(r, { asActive: false }); this.makeActive(n); this.log('info', `The relay ${r.region || r.id} is back: new calls go through it.`); return; } catch { /* still down */ }
      }
    } finally { this.failingBack = false; }
  }
  /** Can sound (UDP) get through to the relay? It echoes a probe on its probe port. */
  async probe(c) {
    const port = c.welcome && c.welcome.probe; const ip = (c.welcome && c.welcome.ip) || c.relay.ip;
    if (!port || !ip) { c.udp = 'unknown'; return; }
    const s = dgram.createSocket('udp4'); const nonce = crypto.randomBytes(6).toString('hex');
    const got = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2500);
      s.on('message', (m) => { if (m.toString().startsWith(`RYPROBE1${nonce}`)) { clearTimeout(t); resolve(true); } });
      s.on('error', () => resolve(false));
      s.bind(0, () => { for (let i = 0; i < 3; i++) setTimeout(() => { try { s.send(Buffer.from(`RYPROBE1${nonce}`), port, ip); } catch { /* closed */ } }, i * 300); });
    });
    try { s.close(); } catch { /* closed */ }
    c.udp = got ? 'ok' : 'blocked';
    if (!got) this.log('warn', 'Calls to other sites connect, but there may be no sound: the firewall seems to block UDP to the relay.');
    this.emit('change', this.status());
  }
}

/** The caller of a call that came from the relay: the extension the relay vouches for. */
function trunkCaller(req) {
  for (const h of ['p-asserted-identity', 'from']) {
    try { const u = sip.userOf(sip.parseNameAddr(sip.getHeader(req, h)).parsed); if (/^\d{3}$/.test(u)) return u; } catch { /* next */ }
  }
  return null;
}

module.exports = { RelayLink, trunkCaller, backoff };
