// The Riyeser relay's SIP core: routes calls between the sites (Link Offices) and remote phones of one business, and
// to the other relays of the cluster (failover / split sites). A record-routing, stateful proxy with forking, like
// Link Office's own (desktop/src/link/pbx.js), but every hop to it is reliable (WebSocket or TLS), so there are no
// UDP retransmission timers.
//
// Who is connected:
//   site   a Link Office, over wss (authenticated by its office token; one business, one office)
//   dev    a remote SIP phone over TLS (authenticated by SIP digest with its own device username and password)
//   peer   another relay of the cluster, over wss (authenticated with the cluster's peer key); it carries several
//          businesses, so each SIP frame says which business it is for
// Endpoints are named, never addressed by IP: "site:<ws>|<office>", "dev:<username>", "peer:<relay id>". A site
// that reconnects (say its public IP changed) is the same endpoint, so its calls and routes carry on.
//
// BUSINESS ISOLATION: everything is looked up by the business (workspace id) of the authenticated connection.
// A request inside a call is only accepted from one of that call's two endpoints.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const sip = require('./sip');

const REALM = 'riyeser-relay';
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, REFER, NOTIFY, INFO, UPDATE, PRACK, MESSAGE';
const AGENT = 'Riyeser relay';
const EMERGENCY = new Set(['000', '111', '112', '911', '910', '917', '999']);
const RANK = { 486: 1, 600: 2, 603: 3, 488: 4, 480: 5, 404: 6, 408: 7, 487: 9 };
const rank = (s) => RANK[s] || (s < 500 ? 8 : 10);
const RING_TIMEOUT = 150 * 1000;
const DIALOG_MAX = 12 * 3600 * 1000;
const NONCE_FRESH = 5 * 60 * 1000;
const validExt = (n) => /^\d{3}$/.test(String(n)) && Number(n) >= 100 && Number(n) <= 899;
const normalise = (d) => { let s = String(d || ''); try { s = decodeURIComponent(s); } catch { /* as is */ } return s.replace(/[\s().-]/g, ''); };

class Relay extends EventEmitter {
  /**
   * opts: { id ('syd1'), region ('Sydney'), host (the name in Record-Route, e.g. relay.riyeser.com), keys (tokens.keys),
   *         media (media.js), log, limits: { msgsPer10s, maxExts, maxDevices } }
   */
  constructor(opts = {}) {
    super();
    this.id = opts.id || 'relay'; this.region = opts.region || ''; this.host = opts.host || 'relay.invalid';
    this.keys = opts.keys; this.media = opts.media || null;
    this.logFn = opts.log || (() => {});
    this.limits = { msgsPer10s: 400, maxExts: 200, maxDevices: 20, ...(opts.limits || {}) };
    this.secret = crypto.randomBytes(32);
    this.plan = null;              // from relay_sync: Map ws -> { enabled, offices: Map, devices: Map(user -> d), groups: Map(ext -> [members]) }
    this.conns = new Map();        // conn id -> conn
    this.endpoints = new Map();    // endpoint -> conn (the newest connection for it)
    this.regs = new Map();         // device username -> { conn, contact, expiresAt, ext, ws }
    this.peerTables = new Map();   // peer id -> { at, ws: { <ws>: { sites: [{ office, name, exts }], devs: [ext] } } }
    this.ctx = new Map(); this.branches = new Map(); this.dialogs = new Map();
    this.stats = { received: 0, malformed: 0, calls: 0, answered: 0, refused: 0, authFailures: 0, limited: 0 };
    this.nextId = 1;
    this.sweeper = setInterval(() => this.sweep(), 5000); this.sweeper.unref();
  }
  log(l, t) { try { this.logFn(l, t); } catch { /* never stops calls */ } }
  stop() { clearInterval(this.sweeper); for (const c of [...this.conns.values()]) c.close('relay stopping'); }
  get rr() { return `<sip:${this.host};lr;rly=${this.id}>`; }

  // ---------- the plan from the database ----------
  /** plan: { businesses: [{ ws, enabled, offices: [{ office_id, gen, revoked, name }], devices: [{ user, ext, ha1, label }], groups: [{ ext, members }] }] } */
  setPlan(raw) {
    const plan = new Map();
    for (const b of (raw && raw.businesses) || []) {
      if (!b || !b.ws) continue;
      plan.set(b.ws, {
        enabled: b.enabled !== false,
        offices: new Map((b.offices || []).map((o) => [o.office_id, { gen: Number(o.gen) || 0, revoked: !!o.revoked, name: o.name || '' }])),
        devices: new Map((b.devices || []).slice(0, this.limits.maxDevices).map((d) => [String(d.user).toLowerCase(), { ext: String(d.ext), ha1: String(d.ha1 || '').toLowerCase(), label: d.label || '' }])),
        groups: new Map((b.groups || []).map((g) => [String(g.ext), (g.members || []).map(String)])),
      });
    }
    this.plan = plan;
    // anyone no longer allowed goes: a revoked office, a business that switched the relay off, a removed phone
    for (const c of [...this.conns.values()]) {
      const why = this.stillAllowed(c);
      if (why) { this.log('info', `Closing ${this.describe(c)}: ${why}.`); c.close(why); }
    }
    for (const [user, r] of [...this.regs]) { const b = plan.get(r.ws); if (!b || !b.enabled || !b.devices.has(user)) { this.regs.delete(user); this.routesChanged(r.ws); } }
    this.emit('plan');
  }
  business(ws) { return this.plan ? this.plan.get(ws) || null : null; }
  /** null if the connection may stay, else why not (plain words). */
  stillAllowed(c) {
    if (!this.plan || c.kind === 'peer') return null;
    const b = this.business(c.ws);
    if (!b || !b.enabled) return 'the business has switched the relay off';
    if (c.kind === 'site') {
      const o = b.offices.get(c.office);
      if (!o) return 'this office is not known for the business';
      if (o.revoked) return 'this office has been disconnected from the relay';
      if (o.gen !== c.gen) return 'this office\'s relay pass has been replaced';
    }
    if (c.kind === 'dev' && c.device && !b.devices.has(c.device)) return 'this phone has been removed';
    return null;
  }
  /** Check a site's token payload against the plan (before accepting the connection). -> null or why not */
  admitSite(p) {
    if (!p || p.v !== 1 || p.r !== this.id || typeof p.ws !== 'string' || typeof p.o !== 'string') return 'not a pass for this relay';
    if (!/^[0-9a-f-]{36}$/i.test(p.ws) || !/^[A-Za-z0-9-]{8,64}$/.test(p.o)) return 'not a pass for this relay';
    return this.stillAllowed({ kind: 'site', ws: p.ws, office: p.o, gen: Number(p.g) || 0 });
  }

  // ---------- connections ----------
  /**
   * Add a connection. c: { kind, ws?, office?, gen?, name?, peer?, ip, sendSip(buf, ws?), sendJson?(o), close(why) }
   * Returns the connection (with id). A site or peer that connects again replaces its older connection.
   */
  addConn(c) {
    c.id = this.nextId++; c.at = Date.now(); c.msgs = []; c.exts = new Set();
    this.conns.set(c.id, c);
    const ep = this.endpointOf(c);
    if (ep) {
      const old = this.endpoints.get(ep);
      this.endpoints.set(ep, c);
      if (old && old !== c && c.kind === 'site') { old.replaced = true; old.close('replaced by a newer connection from the same office'); }
    }
    if (c.kind === 'site') {
      this.log('info', `Site connected: business ${c.ws.slice(0, 8)}, office ${c.office}${c.name ? ` (${c.name})` : ''} from ${c.ip}.`);
      c.sendJson && c.sendJson({ t: 'welcome', relay: this.id, region: this.region, host: this.host, rr: this.rr, ip: this.media ? this.media.publicIp : null,
        probe: this.media ? this.media.probePort : null, office: c.office, ws: c.ws });
      this.sendRoutes(c);
    }
    if (c.kind === 'peer') { this.log('info', `Relay ${c.peer} connected (${c.ip}).`); this.sendTable(c); }
    return c;
  }
  endpointOf(c) {
    if (c.kind === 'site') return `site:${c.ws}|${c.office}`;
    if (c.kind === 'dev') return c.device ? `dev:${c.device}` : null;
    if (c.kind === 'peer') return `peer:${c.peer}`;
    return null;
  }
  removeConn(c) {
    if (!this.conns.has(c.id)) return;
    this.conns.delete(c.id);
    const ep = this.endpointOf(c);
    if (ep && this.endpoints.get(ep) === c) this.endpoints.delete(ep);
    if (c.kind === 'dev') for (const [u, r] of [...this.regs]) if (r.conn === c) this.regs.delete(u);
    if (c.kind === 'peer' && !this.endpoints.has(ep)) this.peerTables.delete(c.peer);
    if (c.kind === 'site' && !c.replaced) this.log('info', `Site disconnected: office ${c.office}.`);
    if (c.ws) this.routesChanged(c.ws); else this.routesChangedAll();
  }
  describe(c) { return c.kind === 'site' ? `office ${c.office}` : c.kind === 'dev' ? `phone ${c.device || '(not signed in)'}` : `relay ${c.peer}`; }
  /** Rate limit per connection. -> true when the message may be handled */
  allow(c) {
    const now = Date.now();
    while (c.msgs.length && now - c.msgs[0] > 10000) c.msgs.shift();
    if (c.msgs.length >= this.limits.msgsPer10s) { this.stats.limited++; if (!c.warned) { c.warned = true; this.log('warn', `Too many messages from ${this.describe(c)} (${c.ip}); slowing it down.`); } return false; }
    c.msgs.push(now); return true;
  }

  // ---------- control messages from sites and peers ----------
  onControl(c, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') { c.sendJson && c.sendJson({ t: 'pong', id: m.id, at: m.at }); return; }
    if (c.kind === 'site' && m.t === 'exts') {
      const list = (Array.isArray(m.exts) ? m.exts : []).map(String).filter(validExt).slice(0, this.limits.maxExts);
      c.exts = new Set(list);
      if (typeof m.name === 'string') c.name = m.name.replace(/[\x00-\x1f<>]/g, '').slice(0, 60);
      c.draining = !!m.draining;
      this.routesChanged(c.ws);
      return;
    }
    if (c.kind === 'peer' && m.t === 'table') { this.peerTables.set(c.peer, { at: Date.now(), ws: m.ws && typeof m.ws === 'object' ? m.ws : {} }); this.routesChangedAll(true); }
  }
  /** Something about a business's routes changed: tell its sites (and the other relays) soon. */
  routesChanged(ws) {
    this.dirty = this.dirty || new Set(); this.dirty.add(ws);
    if (this.routeTimer) return;
    this.routeTimer = setTimeout(() => {
      this.routeTimer = null; const list = this.dirty; this.dirty = null;
      for (const c of this.conns.values()) if (c.kind === 'site' && list.has(c.ws)) this.sendRoutes(c);
      for (const c of this.conns.values()) if (c.kind === 'peer') this.sendTable(c);
    }, 100);
    this.routeTimer.unref && this.routeTimer.unref();
  }
  routesChangedAll(sitesOnly = false) {
    for (const c of this.conns.values()) if (c.kind === 'site') this.sendRoutes(c);
    if (!sitesOnly) for (const c of this.conns.values()) if (c.kind === 'peer') this.sendTable(c);
  }
  /** This relay's own sites and phones, per business, for the other relays. */
  table() {
    const ws = {};
    for (const c of this.conns.values()) if (c.kind === 'site' && this.endpoints.get(this.endpointOf(c)) === c) {
      (ws[c.ws] = ws[c.ws] || { sites: [], devs: [] }).sites.push({ office: c.office, name: c.name || '', exts: c.draining ? [] : [...c.exts] });
    }
    for (const r of this.regs.values()) if (r.expiresAt > Date.now()) (ws[r.ws] = ws[r.ws] || { sites: [], devs: [] }).devs.push(r.ext);
    return ws;
  }
  sendTable(c) { c.sendJson && c.sendJson({ t: 'table', relay: this.id, ws: this.table() }); }
  /** Everything a business can reach through this relay: { sites: [{ office, name, exts, via }], devs: [ext], here } */
  reach(ws) {
    const sites = []; const devs = [];
    for (const c of this.conns.values()) if (c.kind === 'site' && c.ws === ws && this.endpoints.get(this.endpointOf(c)) === c) sites.push({ office: c.office, name: c.name || '', exts: c.draining ? [] : [...c.exts], via: this.id });
    for (const r of this.regs.values()) if (r.ws === ws && r.expiresAt > Date.now()) devs.push(r.ext);
    const local = new Set(sites.map((s) => s.office));
    for (const [peer, t] of this.peerTables) {
      const w = t.ws && t.ws[ws]; if (!w || !this.endpoints.has(`peer:${peer}`)) continue;
      for (const s of w.sites || []) if (!local.has(s.office)) sites.push({ office: String(s.office), name: String(s.name || ''), exts: (s.exts || []).map(String).filter(validExt), via: peer });
      for (const d of w.devs || []) if (validExt(d)) devs.push(String(d));
    }
    return { sites, devs };
  }
  sendRoutes(c) {
    if (!c.sendJson) return;
    const r = this.reach(c.ws);
    const others = r.sites.filter((s) => s.office !== c.office);
    const remote = [...new Set([...others.flatMap((s) => s.exts), ...r.devs])].sort();
    const b = this.business(c.ws);
    c.sendJson({ t: 'routes', remote, groups: b ? [...b.groups.keys()] : [], phones: r.devs.length,
      sites: others.map((s) => ({ office: s.office, name: s.name, exts: s.exts.length, via: s.via === this.id ? 'here' : s.via })) });
  }

  // ---------- SIP in ----------
  /** A SIP message from a connection. ws: the business, for frames from another relay. */
  receive(buf, c, ws) {
    if (!this.conns.has(c.id)) return;
    if (!buf || buf.length < 4 || /^[\s]*$/.test(buf.toString('latin1'))) return;
    if (!this.allow(c)) return;
    this.stats.received++;
    let msg;
    try { msg = sip.parse(buf); } catch { this.stats.malformed++; return; }
    const src = { conn: c, ws: c.kind === 'peer' ? ws : c.ws, ep: this.endpointOf(c) };
    if (c.kind === 'peer' && !(typeof ws === 'string' && /^[0-9a-f-]{36}$/i.test(ws))) return;
    try { if (msg.method) this.onRequest(msg, src); else this.onResponse(msg, src); }
    catch (e) { this.log('error', `Couldn't handle a ${msg.method || msg.status} from ${this.describe(c)}: ${e.message}`); }
  }
  send(conn, msg, ws) { if (conn && this.conns.has(conn.id)) conn.sendSip(sip.serialize(msg), ws); }
  reply(req, src, status, reason, { headers = [], toTag } = {}) {
    if (req.method === 'ACK') return;
    const res = sip.response(req, status, reason, { toTag: toTag || sip.newTag(), headers: [['server', AGENT], ...headers] });
    this.send(src.conn, res, src.ws);
  }
  ourVia(branch) { return `SIP/2.0/TLS ${this.host};branch=${branch};rly=${this.id}`; }
  isUsUri(u) { return !!u && (u.params && u.params.rly === this.id || String(u.host).toLowerCase() === String(this.host).toLowerCase() && !u.user); }
  popRoutes(msg) {
    for (;;) { const r = sip.getHeader(msg, 'route'); if (!r) return; let u; try { u = sip.parseNameAddr(r).parsed; } catch { return; } if (!this.isUsUri(u)) return; sip.removeFirst(msg, 'route'); }
  }

  onRequest(req, src) {
    const c = src.conn;
    if (req.method === 'OPTIONS' && !sip.parseNameAddr(sip.getHeader(req, 'to')).params.tag) return this.reply(req, src, 200, null, { headers: [['allow', ALLOW]] });
    if (req.method === 'REGISTER') return c.kind === 'dev' ? this.onRegister(req, src) : this.reply(req, src, 405, null, { headers: [['allow', ALLOW]] });
    if (c.kind === 'dev' && !src.ws && req.method !== 'INVITE') { if (req.method !== 'ACK') this.reply(req, src, 403, 'Forbidden (register first)'); return; }
    if (req.method === 'CANCEL') return this.onCancel(req, src);
    const to = sip.parseNameAddr(sip.getHeader(req, 'to'));
    if (to.params.tag) return this.inDialog(req, src);
    if (req.method === 'ACK') return;   // the ACK for a failure we passed on: hop by hop, nothing to do
    if (req.method === 'INVITE') return this.onInvite(req, src);
    if (req.method === 'MESSAGE' || req.method === 'SUBSCRIBE') return this.reply(req, src, 405, null, { headers: [['allow', ALLOW]] });
    return this.reply(req, src, 481, null);
  }

  // ---------- remote phones (digest with the HA1 from the database) ----------
  nonce() { const ts = Date.now().toString(16); return `${ts}.${crypto.createHmac('sha256', this.secret).update(ts).digest('hex').slice(0, 24)}`; }
  nonceOk(n) {
    const m = /^([0-9a-f]{1,13})\.([0-9a-f]{24})$/.exec(String(n || '')); if (!m) return false;
    const want = crypto.createHmac('sha256', this.secret).update(m[1]).digest('hex').slice(0, 24);
    return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2])) && Date.now() - parseInt(m[1], 16) < NONCE_FRESH;
  }
  /** -> the device { user, ws, ext } that signed the request, or null after replying. */
  authDevice(req, src, proxy) {
    const auth = sip.parseAuth(sip.getHeader(req, proxy ? 'proxy-authorization' : 'authorization'));
    const challenge = () => this.reply(req, src, proxy ? 407 : 401, null, { headers: [[proxy ? 'proxy-authenticate' : 'www-authenticate', `Digest realm="${REALM}", nonce="${this.nonce()}", algorithm=MD5, qop="auth"`]] });
    if (!auth || !/^digest$/i.test(auth.scheme)) { challenge(); return null; }
    const p = auth.params;
    if (!this.nonceOk(p.nonce) || (p.realm && p.realm !== REALM)) { challenge(); return null; }
    const user = String(p.username || '').toLowerCase();
    let found = null;
    if (this.plan) for (const [ws, b] of this.plan) { const d = b.enabled && b.devices.get(user); if (d) { found = { user, ws, ext: d.ext, ha1: d.ha1 }; break; } }
    const ok = !!found && digestOkHa1(auth, req.method, found.ha1) && (!src.conn.device || src.conn.device === user);
    if (!ok) {
      this.stats.authFailures++;
      this.reply(req, src, 403, 'Forbidden (wrong username or password)');
      this.log('warn', `A phone failed to sign in as ${user.slice(0, 20) || '?'} from ${src.conn.ip}.`);
      this.emit('auth-failed', src.conn.ip);
      return null;
    }
    if (!src.conn.device) {
      src.conn.device = user; src.conn.ws = found.ws; src.conn.ext = found.ext;
      const ep = this.endpointOf(src.conn); const old = this.endpoints.get(ep);
      this.endpoints.set(ep, src.conn);
      if (old && old !== src.conn) old.close('the phone connected again');
    }
    src.ws = found.ws; src.ep = this.endpointOf(src.conn);
    return found;
  }
  onRegister(req, src) {
    const d = this.authDevice(req, src, false); if (!d) return;
    const to = sip.parseNameAddr(sip.getHeader(req, 'to'));
    if (String(sip.userOf(to.parsed)).toLowerCase() !== d.user) return this.reply(req, src, 403, 'Forbidden (register as yourself)');
    const contacts = sip.getAll(req, 'contact'); const hdr = sip.getHeader(req, 'expires');
    let headers = [];
    if (contacts.length === 1 && contacts[0] === '*' || contacts.some((x) => { try { const n = sip.parseNameAddr(x); return (n.params.expires != null ? n.params.expires : hdr) === '0'; } catch { return false; } })) {
      this.regs.delete(d.user);
      this.log('info', `Remote phone ${d.user} (extension ${d.ext}) signed off.`);
    } else if (contacts.length) {
      const na = sip.parseNameAddr(contacts[0]);
      let exp = Number(na.params.expires != null ? na.params.expires : hdr != null ? hdr : 600);
      if (!Number.isFinite(exp)) exp = 600; exp = Math.min(600, Math.max(60, exp));
      const was = this.regs.get(d.user);
      this.regs.set(d.user, { conn: src.conn, contact: na.uri, expiresAt: Date.now() + exp * 1000, ext: d.ext, ws: d.ws, ua: String(sip.getHeader(req, 'user-agent') || '').slice(0, 80) });
      if (!was) this.log('info', `Remote phone ${d.user} (extension ${d.ext}) connected from ${src.conn.ip}.`);
      headers = [['contact', `<${na.uri}>;expires=${exp}`]];
    }
    this.reply(req, src, 200, null, { headers });
    this.routesChanged(d.ws);
  }

  // ---------- a new call ----------
  txKey(req, src, method) { return `${src.conn.id}|${sip.parseVia(sip.getHeader(req, 'via')).params.branch}|${method || req.method}`; }
  onInvite(req, src) {
    const key = this.txKey(req, src);
    if (this.ctx.has(key)) return;   // a repeat over a reliable link: ignore
    let callerExt = null;
    if (src.conn.kind === 'dev') { const d = this.authDevice(req, src, true); if (!d) return; callerExt = d.ext; }
    else {
      const pai = src.conn.kind === 'peer' ? sip.getHeader(req, 'p-asserted-identity') : null;
      try { callerExt = sip.userOf(sip.parseNameAddr(pai || sip.getHeader(req, 'from')).parsed); } catch { callerExt = null; }
      if (!validExt(callerExt)) callerExt = null;
    }
    const b = this.business(src.ws);
    if (this.plan && (!b || !b.enabled)) { this.stats.refused++; return this.reply(req, src, 403, 'Forbidden (the Riyeser relay is switched off for this business)'); }
    const mf = sip.getHeader(req, 'max-forwards');
    if (mf != null && !(Number(mf) > 0)) return this.reply(req, src, 483, null);
    let number; try { number = normalise(sip.userOf(sip.parseUri(req.uri))); } catch { number = ''; }
    if (EMERGENCY.has(number)) return this.reply(req, src, 403, 'Forbidden (No emergency calls - use a mobile or normal phone)');
    if (!validExt(number)) return this.reply(req, src, 404, 'Not Found (Dial a 3-digit extension)');
    const targets = this.targets(src, number, callerExt);
    this.stats.calls++;
    if (!targets.length) {
      this.log('info', `Call from ${callerExt || '?'} to ${number} (business ${String(src.ws).slice(0, 8)}): not connected at any other site.`);
      return this.reply(req, src, 480, 'Temporarily Unavailable (not connected at any other site)');
    }
    const callId = sip.getHeader(req, 'call-id');
    const ctx = { key, req, src, method: 'INVITE', branches: [], best: null, initial: true, callId, mediaKey: `${src.ws}|${callId}`, number, callerExt };
    this.ctx.set(key, ctx);
    this.send(src.conn, sip.response(req, 100, null, {}), src.ws);
    ctx.timer = setTimeout(() => { ctx.noAnswer = true; this.cancelAll(ctx); }, RING_TIMEOUT); ctx.timer.unref && ctx.timer.unref();
    this.log('info', `Call from ${callerExt || '?'} to ${number} (business ${String(src.ws).slice(0, 8)}): ringing ${targets.map((t) => t.label).join(', ')}.`);
    this.forward(ctx, targets, callerExt).catch((e) => { this.log('error', `Couldn't place the call: ${e.message}`); if (!ctx.finalSent) { ctx.finalSent = true; this.reply(req, src, 503, 'Service Unavailable (relay busy)'); this.finish(ctx); } });
  }
  /** Where a call to `number` should ring, for a call from src. */
  targets(src, number, callerExt) {
    const ws = src.ws; const b = this.business(ws);
    const group = b && b.groups.get(number);
    const members = new Set(group ? group : [number]);
    const out = []; const fromPeer = src.conn.kind === 'peer';
    const originOffice = src.conn.kind === 'site' ? src.conn.office : null;
    const hit = (exts) => [...exts].some((e) => members.has(String(e)) && String(e) !== String(callerExt || ''));
    for (const c of this.conns.values()) {
      if (c.kind !== 'site' || c.ws !== ws || c === src.conn || c.office === originOffice || c.draining) continue;
      if (this.endpoints.get(this.endpointOf(c)) !== c) continue;
      if (hit(c.exts)) out.push({ conn: c, ws, uri: `sip:${number}@${this.host}`, label: c.name || c.office, ep: this.endpointOf(c) });
    }
    for (const [user, r] of this.regs) {
      if (r.ws !== ws || r.expiresAt < Date.now() || !members.has(r.ext) || r.conn === src.conn || r.ext === callerExt) continue;
      out.push({ conn: r.conn, ws, uri: r.contact, label: `remote phone ${r.ext}`, ep: `dev:${user}` });
    }
    if (!fromPeer) {
      const local = new Set(out.filter((t) => t.conn.kind === 'site').map((t) => t.conn.office)); if (originOffice) local.add(originOffice);
      for (const c of this.conns.values()) if (c.kind === 'site' && c.ws === ws) local.add(c.office);
      for (const [peer, t] of this.peerTables) {
        const conn = this.endpoints.get(`peer:${peer}`); const w = conn && t.ws && t.ws[ws]; if (!w) continue;
        const sites = (w.sites || []).filter((s) => !local.has(String(s.office)) && hit(s.exts || []));
        if (sites.length || hit(w.devs || [])) out.push({ conn, ws, uri: `sip:${number}@${this.host}`, label: `relay ${peer}`, ep: `peer:${peer}`, peer: true });
      }
    }
    return out;
  }
  async forward(ctx, targets, callerExt) {
    const { req, src } = ctx;
    for (const t of targets) {
      const fwd = sip.clone(req);
      fwd.uri = t.uri;
      const mf = Number(sip.getHeader(fwd, 'max-forwards'));
      sip.setHeader(fwd, 'max-forwards', String(Number.isFinite(mf) ? mf - 1 : 70));
      sip.removeHeader(fwd, 'proxy-authorization');
      sip.removeHeader(fwd, 'p-asserted-identity');
      if (callerExt) sip.prependHeader(fwd, 'p-asserted-identity', `<sip:${callerExt}@${this.host}>`);
      this.popRoutes(fwd);
      sip.prependHeader(fwd, 'record-route', this.rr);
      const id = sip.newBranch();
      sip.prependHeader(fwd, 'via', this.ourVia(id));
      if (fwd.body && fwd.body.length && this.media && isSdp(fwd)) fwd.body = await this.media.rewrite(ctx.mediaKey, 'a', fwd.body, { a: src.conn.ip }, { trustSdp: src.conn.kind === 'peer' });
      const br = { id, ctx, target: t, msg: fwd, final: null, provisional: false };
      this.branches.set(id, br); ctx.branches.push(br);
      if (ctx.finalSent || ctx.cancelled) { br.final = 487; continue; }
      this.send(t.conn, fwd, t.ws);
    }
    if (ctx.cancelled) this.cancelAll(ctx);
  }

  onResponse(res, src) {
    const via = sip.parseVia(sip.getHeader(res, 'via'));
    const br = this.branches.get(via.params.branch);
    if (!br || br.target.conn !== src.conn) return;
    const cseq = sip.parseCSeq(sip.getHeader(res, 'cseq'));
    if (cseq.method === 'CANCEL') return;
    sip.removeFirst(res, 'via');
    if (!sip.getHeader(res, 'via')) return;
    this.handleBranch(br, res).catch((e) => this.log('error', `Couldn't pass on a ${res.status}: ${e.message}`));
  }
  async handleBranch(br, res) {
    const ctx = br.ctx; const status = res.status;
    if (status === 100) return;
    if (res.body && res.body.length && this.media && isSdp(res)) {
      const d = ctx.dialog || this.dialogs.get(ctx.mediaKey);
      const side = ctx.initial ? 'b' : (d && d.a === br.target.ep ? 'a' : 'b');
      res.body = await this.media.rewrite(ctx.mediaKey, side, res.body, ctx.initial ? {} : undefined, { trustSdp: br.target.conn.kind === 'peer' });
    }
    if (status < 200) {
      br.provisional = true;
      if (br.cancelPending) this.sendCancel(br);
      if (!ctx.finalSent && !br.cancelPending) this.send(ctx.src.conn, res, ctx.src.ws);
      return;
    }
    if (br.final && !(status < 300)) return;
    const first = !br.final; br.final = status;
    if (status >= 300 && ctx.method === 'INVITE') this.ackBranch(br, res);
    if (status < 300) {
      this.send(ctx.src.conn, res, ctx.src.ws);
      if (!ctx.answered) {
        ctx.answered = true; ctx.finalSent = true; clearTimeout(ctx.timer);
        for (const o of ctx.branches) if (o !== br && !o.final) this.cancelBranch(o);
        if (ctx.initial && ctx.method === 'INVITE') {
          this.stats.answered++;
          const d = { key: ctx.mediaKey, ws: ctx.src.ws, callId: ctx.callId, a: ctx.src.ep, b: br.target.ep, at: Date.now(), last: Date.now() };
          this.dialogs.set(d.key, d);
          if (this.media) { this.media.answered(d.key); this.media.setExpect(d.key, 'b', br.target.conn.ip); }
          this.log('info', `Call from ${ctx.callerExt || '?'} to ${ctx.number} answered at ${br.target.label}.`);
        }
        if (ctx.method === 'BYE') this.endDialog(ctx.mediaKey);
        this.finish(ctx);
      }
      return;
    }
    if (!first || ctx.finalSent) return;
    if (!ctx.best || rank(status) < rank(ctx.best.status)) ctx.best = res;
    if (ctx.branches.every((x) => x.final)) this.finalUp(ctx);
  }
  finalUp(ctx) {
    if (ctx.finalSent) return;
    ctx.finalSent = true; clearTimeout(ctx.timer);
    let res = ctx.best;
    if (ctx.cancelled) res = sip.response(ctx.req, 487, null, { toTag: sip.newTag() });
    else if (ctx.noAnswer) res = sip.response(ctx.req, 480, 'Temporarily Unavailable (no answer)', { toTag: sip.newTag() });
    else if (!res) res = sip.response(ctx.req, 408, null, { toTag: sip.newTag() });
    this.send(ctx.src.conn, res, ctx.src.ws);
    if (ctx.method === 'BYE') this.endDialog(ctx.mediaKey);
    if (ctx.initial && ctx.method === 'INVITE' && this.media) this.media.close(ctx.mediaKey);
    this.finish(ctx);
  }
  finish(ctx) {
    clearTimeout(ctx.timer);
    setTimeout(() => { this.ctx.delete(ctx.key); for (const b of ctx.branches) this.branches.delete(b.id); }, 32000).unref();
  }
  ackBranch(br, res) {
    const ack = { method: 'ACK', uri: br.msg.uri, headers: [['via', sip.getHeader(br.msg, 'via')]], body: Buffer.alloc(0) };
    for (const r of sip.getAll(br.msg, 'route')) ack.headers.push(['route', r]);
    ack.headers.push(['max-forwards', '70'], ['from', sip.getHeader(br.msg, 'from')], ['to', sip.getHeader(res, 'to')], ['call-id', sip.getHeader(br.msg, 'call-id')],
      ['cseq', `${sip.parseCSeq(sip.getHeader(br.msg, 'cseq')).seq} ACK`]);
    this.send(br.target.conn, ack, br.target.ws);
  }
  cancelAll(ctx) { for (const b of ctx.branches) if (!b.final) this.cancelBranch(b); if (ctx.branches.every((b) => b.final)) this.finalUp(ctx); }
  cancelBranch(br) {
    if (br.final || br.cancelSent) return;
    if (br.provisional) this.sendCancel(br);
    else { br.cancelPending = true; br.cancelTimer = setTimeout(() => { if (!br.final) this.handleBranch(br, Object.assign(sip.response(br.msg, 487, null, { toTag: sip.newTag() }), {})).catch(() => {}); }, 8000); br.cancelTimer.unref && br.cancelTimer.unref(); }
  }
  sendCancel(br) {
    if (br.cancelSent || br.final) return;
    br.cancelSent = true; br.cancelPending = false;
    const c = { method: 'CANCEL', uri: br.msg.uri, headers: [['via', sip.getHeader(br.msg, 'via')]], body: Buffer.alloc(0) };
    for (const r of sip.getAll(br.msg, 'route')) c.headers.push(['route', r]);
    c.headers.push(['max-forwards', '70'], ['from', sip.getHeader(br.msg, 'from')], ['to', sip.getHeader(br.msg, 'to')], ['call-id', sip.getHeader(br.msg, 'call-id')],
      ['cseq', `${sip.parseCSeq(sip.getHeader(br.msg, 'cseq')).seq} CANCEL`]);
    this.send(br.target.conn, c, br.target.ws);
    br.cancelTimer = setTimeout(() => { if (!br.final) this.handleBranch(br, sip.response(br.msg, 487, null, { toTag: sip.newTag() })).catch(() => {}); }, 32000);
    br.cancelTimer.unref && br.cancelTimer.unref();
  }
  onCancel(req, src) {
    const ctx = this.ctx.get(this.txKey(req, src, 'INVITE'));
    this.reply(req, src, ctx ? 200 : 481, null, { toTag: sip.parseNameAddr(sip.getHeader(req, 'to')).params.tag || undefined });
    if (!ctx || ctx.finalSent) return;
    ctx.cancelled = true;
    this.cancelAll(ctx);
  }

  // ---------- inside a call ----------
  inDialog(req, src) {
    const key = `${src.ws}|${sip.getHeader(req, 'call-id')}`;
    const d = this.dialogs.get(key);
    if (!d) { if (req.method !== 'ACK') this.reply(req, src, 481, null); return; }
    if (src.ep !== d.a && src.ep !== d.b) { this.stats.refused++; this.log('warn', `Refused a ${req.method} for a call that isn't ${this.describe(src.conn)}'s.`); if (req.method !== 'ACK') this.reply(req, src, 403, 'Forbidden (not your call)'); return; }
    const otherEp = src.ep === d.a ? d.b : d.a;
    const conn = this.endpoints.get(otherEp);
    if (!conn) { if (req.method !== 'ACK') this.reply(req, src, 480, 'Temporarily Unavailable (the other side lost its connection to the relay)'); if (req.method === 'BYE') this.endDialog(key); return; }
    d.last = Date.now();
    const fwd = sip.clone(req);
    const mf = Number(sip.getHeader(fwd, 'max-forwards'));
    sip.setHeader(fwd, 'max-forwards', String(Number.isFinite(mf) ? mf - 1 : 70));
    this.popRoutes(fwd);
    const side = src.ep === d.a ? 'a' : 'b';
    const go = async () => {
      if (fwd.body && fwd.body.length && this.media && isSdp(fwd)) fwd.body = await this.media.rewrite(key, side, fwd.body, undefined, { trustSdp: src.conn.kind === 'peer' });
      const id = sip.newBranch();
      sip.prependHeader(fwd, 'via', this.ourVia(id));
      if (req.method === 'ACK') { this.send(conn, fwd, d.ws); return; }
      const tk = this.txKey(req, src);
      if (this.ctx.has(tk)) return;
      const ctx = { key: tk, req, src, method: req.method, branches: [], best: null, initial: false, callId: d.callId, mediaKey: key, dialog: d };
      this.ctx.set(tk, ctx);
      const br = { id, ctx, target: { conn, ws: d.ws, ep: otherEp, label: otherEp }, msg: fwd, final: null, provisional: false };
      this.branches.set(id, br); ctx.branches.push(br);
      this.send(conn, fwd, d.ws);
      ctx.timer = setTimeout(() => { if (!br.final) this.handleBranch(br, sip.response(fwd, 408, null, { toTag: sip.newTag() })).catch(() => {}); }, 32000); ctx.timer.unref && ctx.timer.unref();
      if (req.method === 'BYE') this.log('info', `Call ${key.split('|')[1].slice(0, 8)}… hung up.`);
    };
    go().catch((e) => this.log('error', `Couldn't pass on a ${req.method}: ${e.message}`));
  }
  endDialog(key) { if (this.dialogs.delete(key) && this.media) this.media.close(key); else if (this.media) this.media.close(key); }

  // ---------- housekeeping ----------
  sweep() {
    const now = Date.now();
    for (const [u, r] of [...this.regs]) if (r.expiresAt + 10000 < now) { this.regs.delete(u); this.routesChanged(r.ws); this.log('info', `Remote phone ${u} stopped checking in.`); }
    for (const [k, d] of [...this.dialogs]) if (now - d.at > DIALOG_MAX || (this.media && !this.media.sessions.has(k) && now - d.last > 3600 * 1000)) this.endDialog(k);
    for (const [peer, t] of [...this.peerTables]) if (now - t.at > 120000) { this.peerTables.delete(peer); this.routesChangedAll(true); }
  }
  snapshot() {
    const kinds = { site: 0, dev: 0, peer: 0 };
    for (const c of this.conns.values()) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    return { sites: kinds.site, phones: this.regs.size, peers: kinds.peer, calls: this.dialogs.size, ringing: [...this.ctx.values()].filter((c) => c.initial && !c.finalSent).length,
      businesses: new Set([...this.conns.values()].filter((c) => c.ws).map((c) => c.ws)).size, ...this.stats };
  }
}

const isSdp = (m) => String(sip.getHeader(m, 'content-type') || '').toLowerCase().startsWith('application/sdp');
function digestOkHa1(auth, method, ha1) {
  const p = auth && auth.params;
  if (!p || !p.username || !p.nonce || !p.uri || !p.response || !/^[0-9a-f]{32}$/.test(ha1 || '')) return false;
  if (p.algorithm && !/^md5$/i.test(p.algorithm)) return false;
  if (p.qop && (p.qop !== 'auth' || !p.nc || !p.cnonce)) return false;
  const ha2 = sip.md5(`${method}:${p.uri}`);
  const want = p.qop ? sip.md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : sip.md5(`${ha1}:${p.nonce}:${ha2}`);
  const a = Buffer.from(want); const b = Buffer.from(String(p.response).toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { Relay, REALM, digestOkHa1, validExt, EMERGENCY };
