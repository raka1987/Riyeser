// Riyeser Link Office 1.3.1: what the "Connect your branches" checklist looks at, and the fixes it can make.
//   facts()        everything the checklist needs (renderer/link-relaycheck.js build() turns it into steps): this
//                  office's relay link, the internet, and on the relay PC its service, address, ports, web name,
//                  certificate and registration. Read only, except where a fix is asked for.
//   run(step)      check one step again now (also from the website: Sites & relay → Advanced checks)
//   command(d)     a relay_check change from the website: run_check, run_all, test_call, echo_test, retry_upnp,
//                  reregister, reset_pass, force_relay, details. -> { ok, result } (the result goes back to the website)
//   watch()        one Windows notification when calls to the other sites stop working (once; quiet afterwards)
// Also: admin unlock for Advanced checks (an owner or admin's Riyeser account with two-step sign-in, held in memory
// only, locked again after 15 minutes without use), and the muted steps (an admin can dismiss a step for good).
const dns = require('dns').promises;
const C = require('../renderer/link-relaycheck');

const IDLE_LOCK = 15 * 60 * 1000;

class RelayChecks {
  /**
   * opts: { service (PhoneService), cloud (LinkCloud), windows (./windows), powerMonitor, isWin, notify(title, body),
   *         makeOnline: () => Online (a fresh, unsaved one for the admin unlock), now }
   */
  constructor(opts = {}) {
    Object.assign(this, opts);
    this.now = opts.now || Date.now;
    this.w = opts.windows || require('./windows');
    this.cache = { host: null, pc: null, dns: null, reach: null, check: null, at: 0 };
    this.admin = null;   // { online, email, until }
  }
  get store() { return this.service.store; }
  muted() { return (this.store.get('relay-checks', {}) || {}).muted || []; }
  mute(k, on = true) {
    if (!C.TITLES[k]) throw new Error('Unknown step.');
    this.requireAdmin();
    const m = new Set(this.muted()); if (on) m.add(k); else m.delete(k);
    this.store.update('relay-checks', {}, (o) => ({ ...(o || {}), muted: [...m] }));
    this.service.emit('change'); return [...m];
  }

  // ---------- facts ----------
  async hostFacts(force = false) {
    if (!this.isWin && !this.cache.forceHost) return { installed: false };
    if (!force && this.cache.host && this.now() - this.cache.hostAt < 20000) return this.cache.host;
    const st = await this.w.relayHostState().catch(() => ({ installed: false }));
    const h = { installed: !!st.installed, health: st.health || null };
    if (h.installed || h.health) {
      h.check = await this.w.relayCheck().catch(() => null);
      if (!this.cache.pc || force) this.cache.pc = await this.w.relayPcFacts({ powerMonitor: this.powerMonitor }).catch(() => ({}));
      h.pc = this.cache.pc;
      h.sleepNote = this.sleepNote ? this.sleepNote() : null;
      const host = this.service.status().host; const list = (this.service.adapters() || {}).list || [];
      h.adapter = (this.service.adapters() || {}).current || list.find((a) => a.address === host) || null;
      if (h.health && h.health.dns_name) h.dns = await this.dnsFacts(h.health.dns_name, force);
    }
    this.cache.host = h; this.cache.hostAt = this.now();
    return h;
  }
  /** The web name (Advanced): what it resolves to, and who serves the domain's DNS. */
  async dnsFacts(name, force = false) {
    if (!force && this.cache.dns && this.cache.dns.name === name && this.now() - this.cache.dnsAt < 60000) return this.cache.dns;
    const out = { name };
    try { out.ips = await dns.resolve4(name); } catch (e) { out.error = e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? 'no such record' : e.code || e.message; }
    out.host = await this.nameservers(name.split('.').slice(-2).join('.'));
    this.cache.dns = out; this.cache.dnsAt = this.now();
    return out;
  }
  /** Who serves a domain's DNS (for the Advanced web name settings): 'cloudflare' | 'namecheap' | 'other' | null */
  async nameservers(domain) { try { return C.dnsHost(await dns.resolveNs(domain)); } catch { return null; } }
  async facts({ force = false } = {}) {
    const s = this.service.status();
    const host = await this.hostFacts(force);
    const relay = s.relay || {};
    if (!relay.connected && this.service.relay && (force || !this.cache.reach || this.now() - this.cache.reachAt > 60000)) {
      const r = await this.service.relay.reach().catch(() => ({}));
      this.cache.reach = r[Object.keys(r)[0]] || null; this.cache.reachAt = this.now();
    }
    return { relay, cloud: this.cloud ? this.cloud.state : null, host, reach: relay.connected ? null : this.cache.reach,
      exts: this.service.relay ? this.service.relay.exts : [], muted: this.muted() };
  }
  async list(opts) { const f = await this.facts(opts); return { ...C.build(f), facts: f, admin: this.adminState() }; }

  // ---------- running checks and fixes ----------
  async run(step) {
    if (step === 'ports') await this.w.relayCheck('outside', 'POST').catch(() => null);
    if (step === 'test') await this.testCall();
    if (step === 'reach' && this.service.relay) { this.cache.reach = null; this.service.relay.nudge(); }
    if (step === 'sound' && this.service.relay && this.service.relay.activeConn()) await this.service.relay.probe(this.service.relay.activeConn()).catch(() => null);
    const l = await this.list({ force: true });
    return l.steps.find((x) => x.k === step) || null;
  }
  async testCall() { if (!this.service.relay) return { ok: false, error: 'The relay link isn\'t running (the phone system isn\'t running).' }; const r = await this.service.relay.testCall(); this.service.emit('change'); return r; }
  async retryUpnp() { const r = await this.w.relayCheck('portmap', 'POST', 30000); this.cache.host = null; return r || { ok: false, error: 'The relay isn\'t answering on this PC.' }; }
  async reregister() { const r = await this.w.relayCheck('sync', 'POST'); this.cache.host = null; return r || { ok: false, error: 'The relay isn\'t answering on this PC.' }; }
  resetPass() { if (!this.service.relay) throw new Error('The relay link isn\'t running.'); this.service.relay.configAt = 0; this.service.relay.config = null; this.service.relay.nudge(); return { ok: true }; }
  async details() {
    const f = await this.facts({ force: true }); const r = f.relay || {}; const ck = f.host && f.host.check;
    return { relay: { state: r.state, relay: r.relay, region: r.region, rtt: r.rtt, udp: r.udp, backup: r.backup, error: r.error, exp: r.exp, relays: r.relays, sites: (r.sites || []).length, test: r.test },
      reach: f.reach, host: f.host && f.host.installed ? { public_ip: ck && ck.public_ip, ports: ck && ck.ports, port_map: ck && ck.port_map, peers: ck && ck.peers, keys: ck && ck.keys, outside: ck && ck.outside, sync: ck && ck.sync && { ok: ck.sync.ok, at: ck.sync.at, error: ck.sync.error } } : null };
  }
  /** A relay_check change from the website. Never throws. */
  async command(d = {}) {
    try {
      const a = String(d.action || '');
      let result;
      if (a === 'run_check') result = { step: await this.run(String(d.step || '')) };
      else if (a === 'run_all') { const l = await this.list({ force: true }); result = { summary: l.summary, checks: C.forReport(l) }; }
      else if (a === 'test_call' || a === 'echo_test') result = { test: await this.testCall() };
      else if (a === 'retry_upnp') result = await this.retryUpnp();
      else if (a === 'reregister') result = await this.reregister();
      else if (a === 'reset_pass') result = this.resetPass();
      else if (a === 'force_relay') result = { relay: (await this.service.relay.force(String(d.relay || ''))).relay };
      else if (a === 'details') result = await this.details();
      else throw new Error('This Riyeser Link Office doesn\'t know how to do that yet. Update it in Riyeser Central.');
      this.service.log('info', `From Riyeser Link: relay check "${a}"${d.step ? ` (${d.step})` : ''}.`);
      if (this.cloud) setTimeout(() => this.cloud.relayReport(true).catch(() => null), 500).unref?.();
      return { ok: true, result: JSON.stringify(result || {}).length < 15000 ? (result || {}) : { note: 'The details were too long to send; see this PC.' } };
    } catch (e) { return { ok: false, error: String(e.message || 'It didn\'t work.').slice(0, 300) }; }
  }

  // ---------- one notification when cross-site calls stop working ----------
  watch() {
    const tick = async () => {
      const r = this.service.status().relay || {};
      if (r.connected) { this.downSince = null; if (this.toldDown) { this.toldDown = false; } return; }
      if (!this.wasConnected) return;
      this.downSince = this.downSince || this.now();
      if (!this.toldDown && this.now() - this.downSince > 2 * 60 * 1000) {
        this.toldDown = true;
        if (this.notify) this.notify('Calls to your other sites aren\'t working', 'This office lost its connection to the Riyeser relay. Calls inside this office work as normal. Open Connect your branches to see why.');
      }
    };
    this.service.on('change', () => { const r = this.service.status().relay || {}; if (r.connected) this.wasConnected = true; });
    const t = setInterval(() => tick().catch(() => null), 30000); if (t.unref) t.unref();
    return t;
  }

  // ---------- Advanced checks: owners and admins only ----------
  adminState() { if (this.admin && this.now() > this.admin.until) this.admin = null; return this.admin ? { email: this.admin.email, until: this.admin.until } : null; }
  requireAdmin() { if (!this.adminState()) throw new Error('Unlock Advanced checks first (an owner or admin, with two-step sign-in).'); this.admin.until = this.now() + IDLE_LOCK; return this.admin; }
  lock() { this.admin = null; this.pendingAdmin = null; return null; }
  /** Step 1: the Riyeser account's email and password. Two-step sign-in is required for this. */
  async unlock(email, password) {
    const o = this.makeOnline();
    const r = await o.signIn(String(email || '').trim(), String(password || ''));
    if (!r || !r.needsCode) { o.signOut(); throw new Error('Advanced checks need two-step sign-in on your Riyeser account. Turn it on in Riyeser Link (your name → Two-step sign-in), then try again.'); }
    this.pendingAdmin = { online: o, email: r.email }; return { needsCode: true };
  }
  /** Step 2: the 6-digit code. Then: is this person an owner or admin of this PC's business? */
  async unlockCode(code) {
    const p = this.pendingAdmin; if (!p) throw new Error('Sign in again.');
    await p.online.verifyCode(code);
    const co = this.cloud && this.cloud.company && this.cloud.company();
    if (!co) throw new Error('This PC isn\'t linked to a business.');
    const st = await p.online.call('/rest/v1/rpc/link_relay_status', { method: 'POST', body: { ws: co.workspace_id } }).catch(() => null);
    if (!st || !st.admin) { this.pendingAdmin = null; throw new Error('Only the business\'s owner or an admin can use Advanced checks.'); }
    this.pendingAdmin = null; this.admin = { online: p.online, email: p.email, ws: co.workspace_id, until: this.now() + IDLE_LOCK };
    return this.adminState();
  }
  /** An admin RPC with the unlocked admin's session (never the PC's own). */
  async adminRpc(fn, args) { const a = this.requireAdmin(); return a.online.call(`/rest/v1/rpc/${fn}`, { method: 'POST', body: { ws: a.ws, ...args } }); }
}

/** A Store-like object that keeps everything in memory, except Riyeser online's settings (read from the real store). */
function memoryStore(real) {
  const m = new Map();
  return { get: (k, d) => (k === 'online-config' ? real.get(k, d) : m.has(k) ? m.get(k) : d), set: (k, v) => { if (k === 'online-config') real.set(k, v); else m.set(k, v); },
    update: (k, d, fn) => { const v = fn(m.has(k) ? m.get(k) : d); m.set(k, v); return v; } };
}

module.exports = { RelayChecks, memoryStore, IDLE_LOCK };
