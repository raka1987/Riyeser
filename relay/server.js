#!/usr/bin/env node
// The Riyeser relay: SIP federation between a business's sites, remote phones over TLS, the media relay, and the
// health/metrics/set-up-link endpoints. coturn (TURN/STUN) runs next to it with the same secret. See README.md and
// desktop/RELAY.md (on the module/desk-assistant branch) for the design.
//
// Listens on:
//   HTTP_PORT (8080, on 127.0.0.1 behind Caddy)   /health, /metrics, /prov/<code>, and the WebSockets /link/v1 (sites)
//                                                 and /relay/v1 (the other relays of the cluster)
//   SIP_TLS_PORT (5061)                           remote phones (SIP over TLS)
//   PROBE_PORT (40000/udp)                        Link Office's "can sound get through?" check
//   MEDIA_MIN..MEDIA_MAX (40002-49999/udp)        call sound between sites
const fs = require('fs');
const http = require('http');
const tls = require('tls');
const path = require('path');
const crypto = require('crypto');
const ws = require('./lib/ws');
const tokens = require('./lib/tokens');
const sip = require('./lib/sip');
const { Relay } = require('./lib/proxy');
const { Media } = require('./lib/media');
const { CloudSync } = require('./lib/cloud');
const { Ddns } = require('./lib/ddns');
const { findPublicIp } = require('./lib/publicip');
const { TurnServer } = require('./lib/turn');
const certgen = require('./lib/certgen');
const { PortMapper, relayPorts, removeSaved } = require('./lib/portmap');
const net = require('net');
const dgram = require('dgram');
const https = require('https');

const VERSION = require('./package.json').version;
const PING_EVERY = 30000; const DEAD_AFTER = 75000;

/** Per-IP limits: new connections a minute, and failed sign-ins (then blocked for a while). */
class Limiter {
  constructor({ perMinute = 30, maxFails = 10, blockFor = 15 * 60 * 1000 } = {}) { Object.assign(this, { perMinute, maxFails, blockFor }); this.hits = new Map(); this.fails = new Map(); this.blocked = new Map(); }
  isBlocked(ip) { const u = this.blocked.get(ip); if (u && u > Date.now()) return true; if (u) { this.blocked.delete(ip); this.fails.delete(ip); } return false; }
  attempt(ip) {
    if (this.isBlocked(ip)) return false;
    const now = Date.now(); const l = (this.hits.get(ip) || []).filter((t) => now - t < 60000); l.push(now); this.hits.set(ip, l);
    return l.length <= this.perMinute;
  }
  fail(ip) {
    const now = Date.now(); const l = (this.fails.get(ip) || []).filter((t) => now - t < this.blockFor); l.push(now); this.fails.set(ip, l);
    if (l.length >= this.maxFails) { this.blocked.set(ip, now + this.blockFor); return true; }
    return false;
  }
  sweep() { const now = Date.now(); for (const [ip, l] of this.hits) if (!l.some((t) => now - t < 60000)) this.hits.delete(ip); for (const [ip, u] of this.blocked) if (u < now) this.blocked.delete(ip); }
  count() { return [...this.blocked.values()].filter((u) => u > Date.now()).length; }
}

/** KEY="value" lines (relay.env, as setup.sh / install-relay.ps1 write it) into an env object. */
function loadEnvFile(file, env = process.env) {
  if (!file || !fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*?))\s*$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
  }
  return env;
}
function config(env = process.env) {
  if (env.RELAY_ENV_FILE) loadEnvFile(env.RELAY_ENV_FILE, env);
  const secret = env.RELAY_SECRET || (env.RELAY_SECRET_FILE && fs.existsSync(env.RELAY_SECRET_FILE) ? fs.readFileSync(env.RELAY_SECRET_FILE, 'utf8').trim() : '');
  const num = (v, d) => (v == null || v === '' ? d : Number(v));
  return {
    id: env.RELAY_ID || 'syd1', region: env.RELAY_REGION || 'Sydney', host: env.RELAY_HOST || 'relay.riyeser.com', secret,
    httpPort: num(env.HTTP_PORT, 8080), httpBind: env.HTTP_BIND || '127.0.0.1', trustProxy: env.TRUST_PROXY !== '0',
    // direct mode (Windows, own hardware with no Caddy): HTTPS and the WebSockets straight on this port, e.g. 443
    httpsPort: env.HTTPS_PORT ? Number(env.HTTPS_PORT) : null, httpsBind: env.HTTPS_BIND || '0.0.0.0',
    sipTlsPort: num(env.SIP_TLS_PORT, 5061), sipBind: env.SIP_BIND || '0.0.0.0', tlsCert: env.TLS_CERT || '', tlsKey: env.TLS_KEY || '',
    // no certificate given: make a self-signed one in CERT_DIR; Link Office pins its fingerprint (from Riyeser online)
    selfSigned: env.SELF_SIGNED !== '0', certDir: env.CERT_DIR || path.join(__dirname, 'data'),
    turn: { enabled: env.TURN !== 'off', port: num(env.TURN_PORT, 3478), tlsPort: num(env.TURNS_PORT, 5349), min: num(env.TURN_MIN, 50000), max: num(env.TURN_MAX, 50999), bind: env.TURN_BIND || '0.0.0.0' },
    portMap: env.PORT_MAP === '1', portMapIp: env.PORT_MAP_IP || '',
    // 1.1.0: RELAY_DNS=0: no web name (a PC in an office, set up with a code): sites and phones use the public address
    // it reports, and trust it by its certificate's fingerprint. PORT_MAP_FILE: where the router mappings are noted.
    dns: env.RELAY_DNS !== '0', portMapFile: env.PORT_MAP_FILE || path.join(env.CERT_DIR || path.join(__dirname, 'data'), 'portmaps.json'),
    mediaMin: num(env.MEDIA_MIN, 40002), mediaMax: num(env.MEDIA_MAX, 49999), probePort: num(env.PROBE_PORT, 40000), mediaBind: env.MEDIA_BIND || '0.0.0.0',
    publicIp: env.RELAY_PUBLIC_IP || '', supabaseUrl: env.SUPABASE_URL || '', supabaseKey: env.SUPABASE_KEY || '', metricsToken: env.METRICS_TOKEN || '',
    ddns: { provider: env.DDNS_PROVIDER || '', token: env.DDNS_TOKEN || '', zone: env.DDNS_ZONE || '', name: env.DDNS_NAME || env.RELAY_HOST || '',
      host: env.DDNS_HOST || '', domain: env.DDNS_DOMAIN || '', password: env.DDNS_PASSWORD || '' },
    ddnsEvery: num(env.DDNS_EVERY_MINUTES, 30) * 60 * 1000,
    peers: (env.RELAY_PEERS || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [id, url] = s.split('='); return { id, url }; }),
  };
}

/**
 * Build a relay. cfg: config() plus, for tests: { cloud: { sync(info) -> plan result }, plan (fixed plan), log, ca }.
 * -> { start(), stop(), relay, media, ports, ... }
 */
function createRelayServer(cfg) {
  const keys = tokens.keys(cfg.secret);
  const logLines = [];
  const log = (level, text) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${text}`;
    logLines.push(line); if (logLines.length > 500) logLines.shift();
    if (cfg.log) cfg.log(level, text); else if (level !== 'debug') console.log(line);
  };
  const media = new Media({ publicIp: cfg.publicIp || '127.0.0.1', bind: cfg.mediaBind, min: cfg.mediaMin, max: cfg.mediaMax, probePort: cfg.probePort, log });
  const relay = new Relay({ id: cfg.id, region: cfg.region, host: cfg.host, keys, media, log, limits: cfg.limits });
  const turnCfg = cfg.turn || { enabled: false };
  const turn = turnCfg.enabled ? new TurnServer({ secret: keys.turn, publicIp: cfg.publicIp || '127.0.0.1', bind: turnCfg.bind, port: turnCfg.port, min: turnCfg.min, max: turnCfg.max, allowPrivatePeers: turnCfg.allowPrivatePeers, log }) : null;
  const limiter = new Limiter(cfg.limiter);
  relay.on('auth-failed', (ip) => { if (limiter.fail(ip)) log('warn', `Blocked ${ip} for 15 minutes after repeated failed sign-ins.`); });
  const started = Date.now();
  if (turn) turn.on('auth-failed', (ip) => { if (limiter.fail(ip)) log('warn', `Blocked ${ip} for 15 minutes after repeated failed TURN sign-ins.`); });
  const self = { relay, media, turn, limiter, keys, cfg, log, logLines, ports: {}, relays: [], peerDialers: new Map(), usedCodes: new Map(), ip: { ip: null, how: null } };

  // ---------- the plan from Riyeser online ----------
  const cloud = cfg.cloud || new CloudSync({ url: cfg.supabaseUrl, key: cfg.supabaseKey, relayId: cfg.id, secret: cfg.secret, log, info: () => info() });
  const ddns = new Ddns({ ...cfg.ddns, log });
  self.cloud = cloud; self.ddns = ddns;
  function info() {
    const offices = [...relay.conns.values()].filter((c) => c.kind === 'site').map((c) => ({ ws: c.ws, office: c.office, since: new Date(c.at).toISOString(), exts: c.exts.size, draining: !!c.draining }));
    return { version: VERSION, region: cfg.region, host: cfg.host, public_ip: self.ip.ip, ip_how: self.ip.how,
      ports: { sip_tls: self.ports.sipTls || null, media: [cfg.mediaMin, cfg.mediaMax], probe: media.probePort, turn: self.ports.turn || null, turns: self.ports.turns || null, https: self.ports.https || null },
      counts: relay.snapshot(), turn: turn ? turn.snapshot() : null, offices: offices.slice(0, 2000), ddns: ddns.enabled ? ddns.state : null,
      cert: self.cert ? { sha256: self.cert.fingerprint, self_signed: !!self.cert.selfSigned } : null, https_port: self.ports.https || null,
      port_map: self.portMapper ? self.portMapper.state : null };
  }
  async function applySync(j) {
    if (!j) return;
    if (j.keys) adoptKeys(j.keys);
    self.removed = false;
    relay.setPlan(j);
    self.relays = Array.isArray(j.relays) ? j.relays : [];
    if (j.your_ip && !cfg.publicIp) await refreshIp(j.your_ip);
    dialPeers();
    // a relay that was removed (or moved to another PC) is no longer one of ours: drop its connection
    for (const c of [...relay.conns.values()]) if (c.kind === 'peer' && !self.relays.some((x) => x.id === c.peer) && !(cfg.peers || []).some((x) => x.id === c.peer)) { log('warn', `Relay ${c.peer} is no longer in the cluster; disconnecting it.`); c.close('removed from the cluster'); }
  }
  /** 1.1.0: the cluster's keys from relay_sync (a relay with its own key). They change when a relay is removed. */
  function adoptKeys(k) {
    const hex = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
    if (!hex(k.office) || !hex(k.device) || !hex(k.peer) || !hex(k.turn)) return;
    const changed = self.keyEpoch != null && self.keyEpoch !== k.epoch;
    keys.office = Buffer.from(k.office, 'hex'); keys.device = Buffer.from(k.device, 'hex'); keys.peer = Buffer.from(k.peer, 'hex'); keys.turn = k.turn;
    if (turn) turn.secret = k.turn;
    if (self.keyEpoch !== k.epoch) {
      if (changed) {
        log('warn', 'The relay keys were changed (a relay was removed or moved): reconnecting to the other relays with the new ones.');
        for (const d of self.peerDialers.values()) d.stop(); self.peerDialers.clear();
        for (const c of [...relay.conns.values()]) if (c.kind === 'peer') c.close('the relay keys changed');
      } else log('info', `Got the relay keys from Riyeser online (set ${k.epoch}).`);
      self.keyEpoch = k.epoch;
    }
  }
  /** Riyeser online says this relay was removed (on the website, or another PC took over): stop serving. */
  function onRemoved() {
    if (self.removed) return;
    self.removed = true;
    log('error', 'This relay has been removed from Riyeser (on the website, or another PC took over as the relay). It no longer serves anyone: sites move to the next relay by themselves. Uninstall it from this PC (Riyeser Link Office → Settings → Connect your branches).');
    for (const c of [...relay.conns.values()]) if (c.kind === 'site' || c.kind === 'peer') c.close('this relay was removed from Riyeser');
    for (const d of self.peerDialers.values()) d.stop(); self.peerDialers.clear();
    relay.setPlan({ businesses: [] });
  }

  // ---------- our public IP (and DNS) ----------
  async function refreshIp(seen) {
    const r = await findPublicIp({ configured: cfg.publicIp, seenBySync: seen || (cloud.state && cloud.state.yourIp), pmp: cfg.natPmp });
    if (r.ip && r.ip !== self.ip.ip) {
      if (self.ip.ip) log('warn', `This relay's public address changed from ${self.ip.ip} to ${r.ip} (${r.how}).`);
      else log('info', `Public address ${r.ip} (${r.how}).`);
      self.ip = r; media.setPublicIp(r.ip); if (turn) turn.setPublicIp(r.ip);
      ddns.update(r.ip).catch(() => {});
    }
    return self.ip;
  }

  // ---------- HTTP: health, metrics, phone set-up links ----------
  const clientIp = (req) => {
    const direct = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const xff = req.headers['x-forwarded-for'];
    if (cfg.trustProxy && xff && (direct === '127.0.0.1' || direct === '::1')) return String(xff).split(',')[0].trim().replace(/^::ffff:/, '');
    return direct;
  };
  const json = (res, status, o) => { const b = JSON.stringify(o); res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
  function metrics() {
    const s = relay.snapshot(); const m = media.snapshot();
    const lines = [
      ['riyeser_relay_up', 1], ['riyeser_relay_uptime_seconds', Math.round((Date.now() - started) / 1000)],
      ['riyeser_relay_sites_connected', s.sites], ['riyeser_relay_remote_phones', s.phones], ['riyeser_relay_peers_connected', s.peers],
      ['riyeser_relay_businesses_connected', s.businesses], ['riyeser_relay_calls_active', s.calls], ['riyeser_relay_calls_ringing', s.ringing],
      ['riyeser_relay_calls_total', s.calls_total || s.calls + 0], ['riyeser_relay_calls_placed_total', s.calls], ['riyeser_relay_calls_answered_total', s.answered],
      ['riyeser_relay_sip_messages_total', s.received], ['riyeser_relay_sip_malformed_total', s.malformed], ['riyeser_relay_refused_total', s.refused],
      ['riyeser_relay_auth_failures_total', s.authFailures], ['riyeser_relay_rate_limited_total', s.limited], ['riyeser_relay_blocked_ips', limiter.count()],
      ['riyeser_relay_media_sessions', m.sessions], ['riyeser_relay_media_packets_total', m.packets], ['riyeser_relay_media_bytes_total', m.bytes], ['riyeser_relay_media_dropped_total', m.dropped],
      ['riyeser_relay_turn_allocations', turn ? turn.allocs.size : 0], ['riyeser_relay_turn_packets_total', turn ? turn.stats.packets : 0], ['riyeser_relay_turn_bytes_total', turn ? turn.stats.bytes : 0],
      ['riyeser_relay_turn_refused_total', turn ? turn.stats.refused : 0],
      ['riyeser_relay_sync_ok', cloud.state && cloud.state.ok ? 1 : 0],
      ['riyeser_relay_sync_age_seconds', cloud.state && cloud.state.at ? Math.round((Date.now() - Date.parse(cloud.state.at)) / 1000) : -1],
    ];
    return lines.map(([k, v]) => `${k} ${v}`).join('\n') + '\n';
  }
  function provisioning(code) {
    const v = tokens.verify(keys.device, code);
    if (!v.ok || v.payload.v !== 1 || typeof v.payload.u !== 'string') return null;
    const n = String(v.payload.n || '');
    if (self.usedCodes.has(n)) return null;
    let dev = null;
    for (const b of (relay.plan || new Map()).values()) { const d = b.enabled && b.devices.get(v.payload.u.toLowerCase()); if (d) { dev = d; break; } }
    if (!dev) return null;
    self.usedCodes.set(n, Number(v.payload.exp) * 1000);
    const u = v.payload.u.toLowerCase(); const esc = (s) => String(s).replace(/[<>&"]/g, '');
    const addr = cfg.dns ? cfg.host : (self.ip.ip || cfg.host);   // no web name: the phone uses the relay's address
    // Linphone's remote provisioning format, with the HA1 (the password itself is never on the relay)
    return `<?xml version="1.0" encoding="UTF-8"?>
<config xmlns="http://www.linphone.org/xsds/lpconfig.xsd">
  <section name="proxy_0">
    <entry name="reg_proxy">&lt;sip:${esc(addr)}:${self.ports.sipTls || cfg.sipTlsPort};transport=tls&gt;</entry>
    <entry name="reg_identity">"${esc(dev.label || `Extension ${dev.ext}`)}" &lt;sip:${esc(u)}@${esc(addr)}&gt;</entry>
    <entry name="reg_expires">600</entry>
    <entry name="reg_sendregister">1</entry>
    <entry name="realm">riyeser-relay</entry>
  </section>
  <section name="auth_info_0">
    <entry name="username">${esc(u)}</entry>
    <entry name="ha1">${esc(dev.ha1)}</entry>
    <entry name="realm">riyeser-relay</entry>
    <entry name="domain">${esc(addr)}</entry>
  </section>
</config>
`;
  }
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://relay');
    if (req.method === 'GET' && url.pathname === '/health') {
      const s = relay.snapshot();
      return json(res, 200, { ok: true, relay: cfg.id, region: cfg.region, host: cfg.host, version: VERSION, cert_sha256: self.cert ? self.cert.fingerprint : null, uptime: Math.round((Date.now() - started) / 1000), sites: s.sites, phones: s.phones, peers: s.peers, calls: s.calls,
        sync: cloud.state ? { ok: cloud.state.ok, at: cloud.state.at, error: cloud.state.ok === false ? cloud.state.error : null } : null, removed: !!self.removed,
        public_ip: self.ip.ip, ip_how: self.ip.how, dns_name: cfg.dns ? cfg.host : null, ports: self.ports, keys: self.keyEpoch != null ? self.keyEpoch : null,
        port_map: self.portMapper ? self.portMapper.state : null, peers_list: [...relay.conns.values()].filter((c) => c.kind === 'peer').map((c) => c.peer),
        dns: ddns.enabled ? { provider: ddns.provider, name: ddns.name, ok: ddns.state.ok, at: ddns.state.at, error: ddns.state.error } : null });
    }
    if (req.method === 'GET' && url.pathname === '/metrics') {
      const auth = String(req.headers.authorization || '');
      if (!cfg.metricsToken) return json(res, 404, { error: 'Metrics are off (set METRICS_TOKEN).' });
      const want = `Bearer ${cfg.metricsToken}`;
      if (auth.length !== want.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(want))) return json(res, 401, { error: 'Needs the metrics token.' });
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }); return res.end(metrics());
    }
    // 1.1.0: the checklist in Riyeser Link Office on this PC (only from this PC, never through HTTPS from outside)
    if (url.pathname.startsWith('/check')) {
      const local = !req.socket.encrypted && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(req.socket.remoteAddress || '')) && !req.headers['x-forwarded-for'];
      if (!local) return json(res, 404, { error: 'Not here.' });
      if (req.method === 'GET' && url.pathname === '/check') return json(res, 200, checkInfo());
      if (req.method === 'POST' && url.pathname === '/check/outside') return outsideCheck().then((r) => json(res, 200, r), (e) => json(res, 200, { ok: false, error: e.message }));
      if (req.method === 'POST' && url.pathname === '/check/portmap') {
        if (!self.portMapper) return json(res, 200, { ok: false, error: 'Automatic port forwarding is off (PORT_MAP=0).' });
        return self.portMapper.map().then((st) => json(res, 200, { ok: !st.error, state: st }), (e) => json(res, 200, { ok: false, error: e.message }));
      }
      if (req.method === 'POST' && url.pathname === '/check/sync') return self.sync().then(() => json(res, 200, { ok: true, sync: cloud.state }), (e) => json(res, 200, { ok: false, error: e.message }));
      return json(res, 404, { error: 'Not here.' });
    }
    const pm = /^\/prov\/([A-Za-z0-9_.-]{20,1500})$/.exec(url.pathname);
    if (req.method === 'GET' && pm) {
      const ip = clientIp(req);
      if (!limiter.attempt(ip)) return json(res, 429, { error: 'Too many tries. Wait a minute.' });
      const xml = provisioning(pm[1]);
      if (!xml) { limiter.fail(ip); return json(res, 410, { error: 'This set-up link has been used or has expired. Make a new one on the website.' }); }
      log('info', 'A remote phone fetched its set-up (one-time link).');
      res.writeHead(200, { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store' }); return res.end(xml);
    }
    json(res, 404, { error: 'Not here.' });
  };
  const httpServer = http.createServer(handler);
  let httpsServer = null;
  const onUpgrade = (req, socket, head) => {
    socket.on('error', () => {});
    const ip = clientIp(req);
    const url = new URL(req.url, 'http://relay');
    if (!limiter.attempt(ip)) return ws.refuse(socket, 429, 'Too Many Requests', JSON.stringify({ error: 'Too many connections from your address. Wait a minute.', code: 'rate' }));
    const auth = String(req.headers.authorization || '');
    if (url.pathname === '/link/v1') {
      const m = /^Bearer (\S+)$/.exec(auth);
      const v = m ? tokens.verify(keys.office, m[1]) : { ok: false, why: 'no pass' };
      if (!v.ok) {
        limiter.fail(ip); relay.stats.authFailures++;
        log('warn', `Refused a site from ${ip}: ${v.why}.`);
        return ws.refuse(socket, 401, 'Unauthorized', JSON.stringify({ error: v.why === 'expired' ? 'This office\'s relay pass has expired.' : 'This office\'s relay pass isn\'t valid.', code: v.why === 'expired' ? 'expired' : 'token' }));
      }
      if (self.removed) return ws.refuse(socket, 403, 'Forbidden', JSON.stringify({ error: 'The relay refused this office: this relay was removed from Riyeser.', code: 'removed' }));
      const why = relay.admitSite(v.payload);
      if (why) { relay.stats.refused++; log('warn', `Refused office ${v.payload.o} from ${ip}: ${why}.`); return ws.refuse(socket, 403, 'Forbidden', JSON.stringify({ error: `The relay refused this office: ${why}.`, code: 'refused' })); }
      const conn = ws.accept(req, socket, head);
      if (!conn) return;
      wireWs(conn, { kind: 'site', ws: v.payload.ws, office: v.payload.o, gen: Number(v.payload.g) || 0, name: String(req.headers['x-riyeser-site'] || '').replace(/[\x00-\x1f<>]/g, '').slice(0, 60), ip });
      return;
    }
    if (url.pathname === '/relay/v1') {
      const m = /^Peer (\S+)$/.exec(auth);
      const peer = m ? tokens.peerCheck(keys.peer, m[1]) : null;
      if (!peer || peer === cfg.id) { limiter.fail(ip); return ws.refuse(socket, 401, 'Unauthorized', JSON.stringify({ error: 'Not a relay of this cluster.' })); }
      const conn = ws.accept(req, socket, head);
      if (conn) wireWs(conn, { kind: 'peer', peer, ip });
      return;
    }
    ws.refuse(socket, 404, 'Not Found', JSON.stringify({ error: 'Not here.' }));
  };
  httpServer.on('upgrade', onUpgrade);

  /** Join a WebSocket to the relay core (sites and peers). */
  function wireWs(conn, fields) {
    let lastSeen = Date.now();
    const c = relay.addConn({
      ...fields,
      sendSip: (buf, wsId) => (fields.kind === 'peer' ? conn.send(Buffer.concat([Buffer.from(`ws:${wsId}\n`), buf])) : conn.send(buf)),
      sendJson: (o) => conn.sendJson(o),
      close: (why) => { try { conn.sendJson({ t: 'bye', reason: why }); } catch { /* gone */ } conn.close(4000, String(why || '').slice(0, 100)); },
    });
    conn.on('message', (data, binary) => {
      lastSeen = Date.now();
      if (!binary) {
        let m; try { m = JSON.parse(data); } catch { return; }
        if (fields.kind === 'peer' && m.t === 'probe-me') return probeBack(c, m);
        if (fields.kind === 'peer' && m.t === 'probe-result') { const w = self.probes.get(m.id); if (w) { self.probes.delete(m.id); w(m); } return; }
        return relay.onControl(c, m);
      }
      if (fields.kind === 'peer') {
        const nl = data.indexOf(10); if (nl < 0 || nl > 60) return;
        const head2 = data.slice(0, nl).toString(); if (!head2.startsWith('ws:')) return;
        return relay.receive(data.slice(nl + 1), c, head2.slice(3));
      }
      relay.receive(data, c);
    });
    conn.on('pong', () => { lastSeen = Date.now(); });
    conn.on('error', () => {});
    const t = setInterval(() => { if (Date.now() - lastSeen > DEAD_AFTER) { conn.terminate(); return; } conn.ping(); }, PING_EVERY); t.unref();
    conn.on('close', () => { clearInterval(t); relay.removeConn(c); });
    return c;
  }

  // ---------- 1.1.0: checks for Link Office's checklist ----------
  self.probes = new Map();
  /** What the checklist needs to know (this PC only): ports, address, port forwarding, peers, keys, the last outside test. */
  function checkInfo() {
    return { relay: cfg.id, region: cfg.region, host: cfg.host, dns: cfg.dns, version: VERSION, public_ip: self.ip.ip, ip_how: self.ip.how, ports: self.ports,
      media: [cfg.mediaMin, cfg.mediaMax], port_map: self.portMapper ? self.portMapper.state : { method: null, off: true }, removed: !!self.removed,
      sync: cloud.state || null, keys: self.keyEpoch != null ? self.keyEpoch : null, cert_sha256: self.cert ? self.cert.fingerprint : null,
      peers: [...relay.conns.values()].filter((c) => c.kind === 'peer').map((c) => c.peer), relays: self.relays.map((x) => ({ id: x.id, region: x.region, ip: x.ip })),
      dns_state: ddns.enabled ? { provider: ddns.provider, name: ddns.name, ok: ddns.state.ok, at: ddns.state.at, error: ddns.state.error } : null,
      outside: self.outside || null, log: logLines.slice(-60) };
  }
  /** The ports that must be open from the internet: [{ proto, port, what }] */
  function outsidePorts() {
    const out = [];
    if (self.ports.https) out.push({ proto: 'tcp', port: self.ports.https, what: 'sites (secure WebSocket)' });
    if (self.ports.sipTls) out.push({ proto: 'tcp', port: self.ports.sipTls, what: 'phones at home (SIP over TLS)' });
    if (self.ports.turn) { out.push({ proto: 'udp', port: self.ports.turn, what: 'calls from browsers and apps (TURN)' }); out.push({ proto: 'tcp', port: self.ports.turn, what: 'TURN over TCP' }); }
    if (self.ports.turns) out.push({ proto: 'tcp', port: self.ports.turns, what: 'TURN over TLS' });
    if (media.probePort) out.push({ proto: 'udp', port: media.probePort, what: 'call sound (and the sound check)' });
    return out;
  }
  /**
   * Are our ports open from the internet? Another relay of the cluster connects back to our public address on each
   * port (peers only test the address Riyeser online lists for us, so nobody can use them to test anyone else's).
   * -> { ok, via, ip, results: [{ proto, port, what, open }], at } (also kept as self.outside for /check)
   */
  async function outsideCheck() {
    const peer = [...relay.conns.values()].find((c) => c.kind === 'peer');
    if (!self.ip.ip) return (self.outside = { ok: false, error: 'This relay doesn\'t know its public address yet.', at: new Date().toISOString() });
    if (!peer) return (self.outside = { ok: null, error: 'No other relay is connected to test from outside. The sites test it when they connect.', ip: self.ip.ip, at: new Date().toISOString() });
    const id = crypto.randomBytes(6).toString('hex'); const ports = outsidePorts();
    const answer = await new Promise((resolve) => {
      const t = setTimeout(() => { self.probes.delete(id); resolve(null); }, 15000);
      self.probes.set(id, (m) => { clearTimeout(t); resolve(m); });
      peer.sendJson({ t: 'probe-me', id, ports });
    });
    if (answer && answer.error) return (self.outside = { ok: null, error: `The relay ${peer.peer} couldn't test this relay's address (${answer.error}).`, ip: self.ip.ip, at: new Date().toISOString() });
    if (!answer || !Array.isArray(answer.results)) return (self.outside = { ok: null, error: `The relay ${peer.peer} didn't answer the test.`, ip: self.ip.ip, at: new Date().toISOString() });
    const results = ports.map((p) => ({ ...p, open: !!(answer.results.find((r) => r.proto === p.proto && r.port === p.port) || {}).open }));
    return (self.outside = { ok: results.every((r) => r.open), via: peer.peer, ip: answer.ip || self.ip.ip, results, at: new Date().toISOString() });
  }
  /** Another relay asked us to test its ports from here: only its own listed address, only the ports it names. */
  async function probeBack(c, m) {
    const listed = self.relays.find((x) => x.id === c.peer);
    const ip = listed && listed.ip; const ports = (Array.isArray(m.ports) ? m.ports : []).slice(0, 12).filter((p) => p && ['tcp', 'udp'].includes(p.proto) && Number.isInteger(p.port) && p.port > 0 && p.port < 65536);
    if (!ip || !net.isIPv4(ip)) { c.sendJson({ t: 'probe-result', id: m.id, error: 'no address listed for you', results: [] }); return; }
    const results = [];
    for (const p of ports) results.push({ proto: p.proto, port: p.port, open: p.proto === 'tcp' ? await tcpOpen(ip, p.port) : await udpAnswers(ip, p.port) });
    c.sendJson({ t: 'probe-result', id: m.id, ip, results });
  }
  const tcpOpen = (ip, port) => new Promise((resolve) => { const s = net.connect({ host: ip, port, timeout: 3000 }); const end = (v) => { s.destroy(); resolve(v); }; s.on('connect', () => end(true)); s.on('timeout', () => end(false)); s.on('error', () => end(false)); });
  /** UDP: the sound check (RYPROBE1) on the probe port, a STUN binding request on the TURN port. */
  function udpAnswers(ip, port) {
    return new Promise((resolve) => {
      const s = dgram.createSocket('udp4'); const tid = crypto.randomBytes(12);
      const stun = Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), tid]);
      let done = false; const end = (v) => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch { /* closed */ } resolve(v); };
      const t = setTimeout(() => end(false), 2500);
      s.on('message', () => end(true)); s.on('error', () => end(false));
      // both kinds: the other relay's probe port may differ from ours, so send the sound check and STUN
      s.bind(0, () => { for (let i = 0; i < 3; i++) setTimeout(() => { if (done) return; try { s.send(Buffer.from(`RYPROBE1${tid.toString('hex')}`), port, ip); s.send(stun, port, ip); } catch { /* closed */ } }, i * 400); });
    });
  }

  // ---------- the other relays of the cluster ----------
  function dialPeers() {
    if (self.removed) return;
    const want = new Map();
    // 1.1.0: a self-signed relay (a PC with no web name) is trusted by the fingerprint Riyeser online lists (pin)
    const pins = new Map();
    for (const r of [...(cfg.peers || []), ...self.relays.map((x) => ({ id: x.id, url: x.url || (x.host ? `wss://${x.host}/relay/v1` : null), pin: x.pin }))]) if (r.id && r.url && r.id !== cfg.id) { want.set(r.id, r.url); if (r.pin) pins.set(r.id, r.pin); }
    for (const [id, d] of self.peerDialers) if (!want.has(id) || want.get(id) !== d.url || (pins.get(id) || null) !== (d.pin || null)) { d.stop(); self.peerDialers.delete(id); }
    for (const [id, url] of want) if (!self.peerDialers.has(id)) self.peerDialers.set(id, peerDialer(id, url, pins.get(id)));
  }
  function peerDialer(id, url, pin) {
    const d = { url, pin, stopped: false, conn: null, delay: 1000 };
    const go = async () => {
      if (d.stopped) return;
      try {
        const conn = await ws.connect(url, { headers: { Authorization: `Peer ${tokens.peerAuth(keys.peer, cfg.id)}` }, ca: cfg.ca, rejectUnauthorized: cfg.rejectUnauthorized, pin: pin || undefined });
        if (d.stopped) { conn.close(); return; }
        d.conn = conn; d.delay = 1000;
        wireWs(conn, { kind: 'peer', peer: id, ip: String(conn.remoteAddress || '').replace(/^::ffff:/, '') });
        conn.on('close', () => { d.conn = null; if (!d.stopped) d.timer = setTimeout(go, d.delay); });
      } catch { d.delay = Math.min(d.delay * 2, 30000); if (!d.stopped) d.timer = setTimeout(go, d.delay); }
    };
    d.stop = () => { d.stopped = true; clearTimeout(d.timer); if (d.conn) d.conn.close(); };
    go();
    return d;
  }

  // ---------- SIP over TLS for remote phones ----------
  let tlsServer = null; let certStamp = '';
  function loadCert() {
    let certFile = cfg.tlsCert; let keyFile = cfg.tlsKey; let selfSigned = false;
    if (!certFile || !keyFile || !fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      if (!cfg.selfSigned) return null;
      const made = certgen.ensure(cfg.certDir, { name: cfg.host });
      if (made.made) log('info', `Made a self-signed certificate for ${cfg.host} (SHA-256 ${made.fingerprint}). Link Office checks for exactly this one.`);
      certFile = made.certFile; keyFile = made.keyFile; selfSigned = true;
    }
    const stamp = `${fs.statSync(certFile).mtimeMs}|${fs.statSync(keyFile).mtimeMs}`;
    const ctx = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    self.cert = { fingerprint: new crypto.X509Certificate(ctx.cert).fingerprint256, selfSigned };
    if (stamp !== certStamp && certStamp) {
      for (const srv of [tlsServer, httpsServer, turn && turn.tls]) if (srv) { try { srv.setSecureContext(ctx); } catch (e) { log('warn', `TLS certificate: ${e.message}`); } }
      log('info', 'Loaded the renewed TLS certificate.');
    }
    certStamp = stamp; return ctx;
  }
  function onTls(sock) {
    const ip = String(sock.remoteAddress || '').replace(/^::ffff:/, '');
    if (!limiter.attempt(ip)) { sock.destroy(); return; }
    sock.on('error', () => {});
    sock.setKeepAlive(true, 30000);
    const c = relay.addConn({ kind: 'dev', ip, sendSip: (buf) => { if (!sock.destroyed) sock.write(buf); }, close: () => sock.end() });
    // keep the phone's NAT open (RFC 5626 double-CRLF), and drop silent connections
    let last = Date.now();
    const t = setInterval(() => { if (Date.now() - last > 15 * 60 * 1000) sock.destroy(); else if (!sock.destroyed) sock.write('\r\n\r\n'); }, 30000); t.unref();
    sock.on('close', () => { clearInterval(t); relay.removeConn(c); });
    readSipStream(sock, (packet) => { last = Date.now(); relay.receive(packet, c); });
  }

  self.start = async () => {
    await media.start();
    await new Promise((r, j) => { httpServer.once('error', j); httpServer.listen(cfg.httpPort, cfg.httpBind, () => { httpServer.off('error', j); r(); }); });
    self.ports.http = httpServer.address().port; self.ports.probe = media.probePort;
    const ctx = loadCert();
    if (ctx && cfg.httpsPort != null) {
      httpsServer = https.createServer({ ...ctx, minVersion: 'TLSv1.2' }, handler);
      httpsServer.on('upgrade', onUpgrade); httpsServer.on('tlsClientError', () => {});
      await new Promise((r, j) => { httpsServer.once('error', j); httpsServer.listen(cfg.httpsPort, cfg.httpsBind, () => { httpsServer.off('error', j); r(); }); });
      self.ports.https = httpsServer.address().port;
    }
    if (turn) {
      if (ctx && turnCfg.tlsPort !== false) turn.tlsOpts = { ...ctx, port: turnCfg.tlsPort };
      await turn.start(); self.ports.turn = turn.port; self.ports.turns = turn.tlsPort || null;
    }
    if (ctx && cfg.sipTlsPort !== false) {
      tlsServer = tls.createServer({ ...ctx, minVersion: 'TLSv1.2' }, onTls);
      tlsServer.on('tlsClientError', () => {});
      await new Promise((r, j) => { tlsServer.once('error', j); tlsServer.listen(cfg.sipTlsPort, cfg.sipBind, () => { tlsServer.off('error', j); r(); }); });
      self.ports.sipTls = tlsServer.address().port;
      self.certTimer = setInterval(loadCert, 3600 * 1000); self.certTimer.unref();
    } else log('warn', 'No TLS certificate yet, so remote phones (SIP over TLS) are off. Sites and TURN are not affected.');
    await refreshIp();
    self.ipTimer = setInterval(() => refreshIp().catch(() => {}), 5 * 60 * 1000); self.ipTimer.unref();
    // dynamic DNS: set at start (refreshIp above, once the address is known), on every public-address change, and
    // every 30 minutes as a safety net (DDNS_EVERY_MINUTES)
    if (cfg.ddns && cfg.ddns.provider && !ddns.enabled) log('warn', cfg.ddns.provider === 'namecheap' ? 'DNS: DDNS_PROVIDER is namecheap but DDNS_HOST, DDNS_DOMAIN or DDNS_PASSWORD is missing in relay.env, so the relay can\'t keep its DNS name up to date.' : `DNS: DDNS_PROVIDER "${cfg.ddns.provider}" isn't set up fully (it needs DDNS_ZONE and DDNS_TOKEN; or use cloudflare, digitalocean or namecheap).`);
    self.ddnsTimer = setInterval(() => { if (self.ip.ip) ddns.update(self.ip.ip, { force: true }).catch(() => {}); }, cfg.ddnsEvery || 30 * 60 * 1000); self.ddnsTimer.unref();
    self.sweepTimer = setInterval(() => { limiter.sweep(); const now = Date.now(); for (const [n, exp] of self.usedCodes) if (exp < now) self.usedCodes.delete(n); }, 60000); self.sweepTimer.unref();
    // own hardware: ask the office router to forward our ports (NAT-PMP or UPnP), where it allows it
    if (cfg.portMap) {
      const lan = Object.values(require('os').networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
      self.portMapper = new PortMapper({ ports: relayPorts(cfg, self.ports), localIp: cfg.portMapIp || (lan && lan.address), log, gw: cfg.portMapGateway, ssdpTarget: cfg.ssdpTarget, ssdpPort: cfg.ssdpPort, pmpPort: cfg.pmpPort, saveFile: cfg.portMapFile });
      await self.portMapper.start().catch((e) => log('warn', `Router port forwarding: ${e.message}`));
    }
    if (cfg.plan) await applySync(cfg.plan);
    if (cloud.start) await cloud.start(applySync, onRemoved);
    else if (cloud.enabled === false) log('warn', 'Not connected to Riyeser online (SUPABASE_URL / SUPABASE_KEY missing): no business can use this relay until it is.');
    dialPeers();
    log('info', `Riyeser relay ${cfg.id} (${cfg.region}) ${VERSION} ready: http ${self.ports.http}${self.ports.https ? `, https ${self.ports.https}` : ''}, sip-tls ${self.ports.sipTls || 'off'}, turn ${self.ports.turn || 'off'}${self.ports.turns ? `/${self.ports.turns} (tls)` : ''}, media ${cfg.mediaMin}-${cfg.mediaMax}, probe ${media.probePort}.`);
    return self;
  };
  self.sync = async () => {
    try { const j = await cloud.sync(info()); await applySync(j); return j; } catch (e) { if (/RELAY_REMOVED/.test(e.message)) onRemoved(); throw e; }
  };
  self.outsideCheck = outsideCheck; self.checkInfo = checkInfo;
  self.info = info;
  self.stop = async () => {
    for (const t of [self.ipTimer, self.ddnsTimer, self.sweepTimer, self.certTimer]) clearInterval(t);
    ddns.stop();
    if (cloud.stop) cloud.stop();
    if (self.portMapper) await self.portMapper.stop().catch(() => {});
    for (const d of self.peerDialers.values()) d.stop();
    relay.stop();
    await new Promise((r) => httpServer.close(() => r()));
    if (httpsServer) await new Promise((r) => httpsServer.close(() => r()));
    if (turn) await turn.stop();
    if (tlsServer) await new Promise((r) => tlsServer.close(() => r()));
    await media.stop();
  };
  return self;
}

/** SIP over a stream (TLS/TCP): messages are separated by Content-Length. */
function readSipStream(sock, onPacket) {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      let i = 0; while (i < buf.length && (buf[i] === 13 || buf[i] === 10)) i++;
      if (i) buf = buf.slice(i);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > sip.MAX_SIZE) sock.destroy(); return; }
      const m = /^(?:content-length|l)[ \t]*:[ \t]*(\d+)/im.exec(buf.slice(0, end).toString('latin1'));
      const total = end + 4 + (m ? Number(m[1]) : 0);
      if (total > sip.MAX_SIZE) { sock.destroy(); return; }
      if (buf.length < total) return;
      const packet = buf.slice(0, total); buf = buf.slice(total);
      onPacket(packet);
    }
  });
}

module.exports = { createRelayServer, config, loadEnvFile, Limiter, readSipStream, VERSION };

/**
 * The uninstaller's helpers (install-relay.ps1 -Uninstall, with RELAY_ENV_FILE set):
 *   --remove-port-mappings  remove the router port forwarding this relay noted (portmaps.json)
 *   --leave                 remove this relay from Riyeser (relay_leave, signed with its own key)
 * Each prints one line of JSON.
 */
async function cli(argv, cfg = config()) {
  if (argv.includes('--remove-port-mappings')) return removeSaved(cfg.portMapFile);
  if (argv.includes('--leave')) {
    if (!cfg.supabaseUrl || !cfg.supabaseKey || !cfg.secret) return { left: false, why: 'not connected to Riyeser online' };
    try { const r = await new CloudSync({ url: cfg.supabaseUrl, key: cfg.supabaseKey, relayId: cfg.id, secret: cfg.secret }).leave(); return { left: true, ...(r || {}) }; }
    catch (e) { return { left: false, why: String(e.message).slice(0, 200), gone: /RELAY_REMOVED/.test(e.message) }; }
  }
  return null;
}

module.exports.cli = cli;

if (require.main === module && process.argv.some((a) => a === '--remove-port-mappings' || a === '--leave')) {
  cli(process.argv).then((r) => { console.log(JSON.stringify(r)); process.exit(0); }, (e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
} else if (require.main === module) {
  const cfg = config();
  if (!cfg.secret) { console.error('RELAY_SECRET (or RELAY_SECRET_FILE) is missing. Run setup.sh, which makes one.'); process.exit(1); }
  const s = createRelayServer(cfg);
  s.start().catch((e) => { console.error(`The relay couldn't start: ${e.message}`); process.exit(1); });
  const bye = () => { s.stop().finally(() => process.exit(0)); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
