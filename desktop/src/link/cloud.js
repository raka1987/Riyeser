// Riyeser Link Office and Riyeser Link online: so the business's owners and admins (and, when they allow it, Riyeser
// support) can see and manage the desk phones from the website, not only on this PC's screen.
//   Heartbeat  every 5 minutes, soon after something changes (a phone connects or is given to someone), and at once
//              when this PC's address changes: this PC's name and version, the address to type into phones, the licence, counts, the desk
//              phones and the extensions (link_office_report).
//   Changes    every 30 seconds: changes made on the website (give a phone to someone, add one by MAC address, take a
//              phone off someone, a new password, Do not disturb, Show password). Each is done here, then marked done
//              or failed with a plain reason (link_office_pending / link_office_done).
//   Passwords  never leave this PC in a form anyone else can read. "Show" on the website sends a one-off public key;
//              the password is encrypted to it here (RSA-OAEP, SHA-256), so only that browser tab can read it.
// PRIVACY: no calls, numbers dialled, recordings or audio are ever sent: only how many calls are in progress, and for each
//          extension whether it's on a call (yes or no), so Riyeser Link can show "On a call".
// With no internet (or not signed in) the phones carry on as normal; the heartbeat and changes just wait.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { readCompany } = require('../core/online');
const { normaliseMac, VENDORS } = require('./provision');

const HEARTBEAT = 5 * 60 * 1000;
const POLL = 30 * 1000;
const SOON = 5000;           // after a change, report within a few seconds
const MIN_GAP = 15000;       // ...but not more often than this
const NOT_YET = 30 * 60 * 1000;   // the online database hasn't been updated for this yet: try again in half an hour
const VENDOR_KEYS = Object.keys(VENDORS);

const missingFn = (e) => /Could not find the function|schema cache|PGRST202/i.test(String(e && e.message));
const iso = (t) => new Date(t).toISOString();

/**
 * The heartbeat: what the website and Riyeser HQ may see. Built only from the listed parts of status(), so nothing
 * else (call details, recent calls, the log, passwords) can slip in.
 * status: PhoneService.status(). opts: { officeId, pcName, version, adapters: PhoneService.adapters(), lastReg: { mac: iso }, now }
 */
function buildPayload(status, { officeId, pcName = '', version = '', adapters = null, lastReg = {}, now = Date.now() } = {}) {
  const regs = Array.isArray(status.registrations) ? status.registrations : [];
  const host = status.host || '';
  const others = adapters && Array.isArray(adapters.list) ? adapters.list.filter((a) => !a.virtual && a.address && a.address !== host).map((a) => a.address) : [];
  const phones = [
    ...(status.phones || []).map((p) => {
      const on = p.state === 'connected';
      return { mac: p.mac, vendor: VENDORS[p.vendor] || '', model: p.model || '', extension: p.ext, assigned: true, registered: on,
        last_registered: on ? iso(now) : (lastReg[p.mac] || null), ip: p.ip || null,
        name: p.label || '', location: p.location || '', note: p.note || '', provisioned_at: p.lastFetch || null,
        // 1.2.3: for the website's phone panel (no calls or passwords): firmware, when it connected, its own settings, shared
        firmware: p.firmware || '', registered_since: p.registeredSince || null, last_seen: p.lastSeen || null, shared: !!p.shared, settings: p.settings || {} };
    }),
    ...(status.found || []).map((f) => ({ mac: f.mac, vendor: VENDORS[f.vendor] || '', model: f.model || '', extension: null, assigned: false, registered: false,
      last_registered: null, ip: f.ip || null, name: f.label || '', location: f.location || '', last_seen: f.lastSeen || null })),
    ...(status.ignored || []).map((f) => ({ mac: f.mac, vendor: VENDORS[f.vendor] || '', model: f.model || '', extension: null, assigned: false, registered: false,
      last_registered: null, ip: f.ip || null, ignored: true, last_seen: f.lastSeen || null })),
  ];
  const regsOf = (ext) => regs.filter((r) => r.ext === ext);
  // "On a call" in Riyeser Link: yes or no for each extension (who it's with and the number never leave this PC)
  const talking = new Set();
  for (const c of status.inProgress || []) for (const e of [c.from, c.answeredBy || (c.state === 'talking' ? c.to : null)]) if (e) talking.add(String(e));
  const extensions = [
    ...(status.people || []).map((p) => ({ extension: p.ext, name: p.name, type: 'person', shared: !!p.shared, registered: regsOf(p.ext).length,
      desk_phones: (status.phones || []).filter((x) => x.ext === p.ext).length, app_users: regsOf(p.ext).filter((r) => r.device === 'app').length, dnd: !!p.dnd, in_call: talking.has(String(p.ext)) })),
    ...(status.groups || []).map((g) => ({ extension: g.ext, name: g.name, type: 'group', members: (g.members || []).length })),
  ];
  const lic = status.licence || {};
  return {
    office_id: officeId, pc_name: String(pcName || '').slice(0, 80), version: String(version || '').slice(0, 40), state: status.state,
    addresses: [host, ...others].filter(Boolean), sip_port: status.sipPort || 5060, address_stable: status.addressStable !== false,
    pc_mac: (status.adapter && status.adapter.mac) || '',
    // 1.2.0: the names phones can use for this PC, which one they're given, and the last few address changes
    mdns_name: (status.names && status.names.mdns) || '', router_name: (status.names && status.names.router) || '',
    phone_server: (status.names && status.names.server) || host,
    address_changes: (status.addressChanges || []).slice(0, 5).map((c) => ({ from: c.from, to: c.to, at: c.at })),
    licence: { active: !!lic.active, state: lic.state || '', text: lic.text || lic.message || '' },
    counts: { people: (status.people || []).length, groups: (status.groups || []).length, phones_assigned: (status.phones || []).length,
      phones_connected: phones.filter((p) => p.registered).length, new_phones: (status.found || []).length, ignored_phones: (status.ignored || []).length,
      app_users: regs.filter((r) => r.device === 'app').length, calls_in_progress: (status.inProgress || []).length,
      calls_made: (status.recent || []).filter((c) => c.result === 'answered').length },   // a count only: "Make a test call" ticks itself
    phones, extensions,
  };
}
/** What counts as "something changed" (the times that move on every report are left out). */
const signature = (p) => JSON.stringify({ ...p, phones: p.phones.map(({ last_registered, ...x }) => x) });

/** Encrypt text to a browser's one-off public key (a JWK: RSA, at least 2048 bits). Returns base64. */
function sealFor(jwk, text) {
  if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) throw new Error('The website didn\'t send a key to protect the password. Press Show again.');
  const key = crypto.createPublicKey({ key: { kty: 'RSA', n: String(jwk.n), e: String(jwk.e) }, format: 'jwk' });
  if (!(key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength >= 2048)) throw new Error('The website\'s key is too weak. Press Show again.');
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(String(text), 'utf8')).toString('base64');
}

const BY = 'Riyeser Link (website)';
/** Do one change from the website. -> { ok, error?, sealed?, result? } (never the password itself) */
function applyCommand(service, cmd) {
  service.actor = BY;
  try { return applyOne(service, cmd); } finally { service.actor = null; }
}
function applyOne(service, cmd) {
  const d = (cmd && cmd.data) || {};
  const ext = d.extension == null ? '' : String(d.extension);
  const person = () => { if (!service.directory.person(ext)) throw new Error(`No one has extension ${ext} on Riyeser Link Office.`); };
  const mac = () => { const m = normaliseMac(d.mac); if (!m) throw new Error('That isn\'t a MAC address.'); return m; };
  let what;
  try {
    switch (cmd && cmd.kind) {
      case 'assign_phone': person(); service.assign(mac(), ext); what = `gave phone ${d.mac} to extension ${ext}`; break;
      case 'add_phone': {
        person();
        const vendor = VENDOR_KEYS.includes(d.vendor) ? d.vendor : undefined;
        service.assign(mac(), ext, vendor); what = `added desk phone ${d.mac} for extension ${ext}`; break;
      }
      case 'name_phone': {
        const m = mac();
        if (!service.provisionerData().phones.some((p) => p.mac === m)) throw new Error('That phone isn\'t given to anyone yet.');
        service.label(m, { name: d.name, location: d.branch, note: d.note }); what = `named phone ${d.mac} "${String(d.name || '').slice(0, 40)}"`; break;
      }
      case 'unassign_phone': {
        const m = mac();
        if (!service.provisionerData().phones.some((p) => p.mac === m)) throw new Error('That phone isn\'t given to anyone.');
        service.unassign(m); what = `took phone ${d.mac} off its person`; break;
      }
      case 'new_password': person(); service.resetPassword(ext); return { ok: true };   // resetPassword notes it in the log (never the password)
      case 'set_dnd': person(); service.setDnd(ext, !!d.on); what = `Do not disturb ${d.on ? 'on' : 'off'} for extension ${ext}`; break;
      case 'reveal_password': {
        person();
        const sealed = sealFor(d.key, service.directory.user(ext).password);
        service.log('info', `Riyeser Link asked for extension ${ext}'s password (Set up a phone by hand). It was sent encrypted, for that person only.`);
        return { ok: true, sealed };
      }
      // 1.2.3: many phones at once, and each phone's own page
      case 'bulk_phones': {
        const act = String(d.action || '');
        if (act === 'add') { const r = service.bulkAdd(Array.isArray(d.rows) ? d.rows : [], { start: d.start, auto: !!d.auto, shared: !!d.shared }); return { ok: true, result: { summary: r.summary, added: r.added.length, skipped: r.skipped, failed: r.failed } }; }
        const to = {}; for (const [m, e] of Object.entries(d.to && typeof d.to === 'object' ? d.to : {})) { const k = normaliseMac(m); if (k && /^\d{3}$/.test(String(e))) { if (!service.directory.person(String(e))) throw new Error(`No one has extension ${e} on Riyeser Link Office.`); to[k] = String(e); } }
        const r = service.bulk(act, Array.isArray(d.macs) ? d.macs : [], { to, auto: !!d.auto, start: d.start, location: d.location, names: d.names });
        return { ok: true, result: { summary: r.summary, done: r.done.length, skipped: r.skipped, failed: r.failed } };
      }
      case 'phone_action': {
        const m = mac(); const act = String(d.action || '');
        if (act === 'restart' || act === 'resync') service.restartPhone(m, { reboot: act === 'restart' });
        else if (act === 'find') service.findPhone(m);
        else if (['ignore', 'unignore', 'remove'].includes(act)) { const r = service.bulk(act, [m]); if (!r.done.length) throw new Error((r.skipped[0] || r.failed[0] || {}).why || 'Nothing was changed.'); }
        else if (act === 'move') { if (d.extension) person(); service.movePhone(m, { ext: d.extension ? ext : null, sharedName: d.shared_name }); }
        else throw new Error('This Riyeser Link Office doesn\'t know how to do that yet. Update it in Riyeser Central.');
        return { ok: true };
      }
      case 'phone_settings': { const r = service.phoneSettings(mac(), d.settings || {}); return { ok: true, result: { applied: Object.keys(r.settings), dropped: r.dropped } }; }
      // 1.3.1: Sites & relay → Advanced checks on the website: a check, a test call or a fix (relaychecks.js)
      case 'relay_check': return service.relayChecks ? service.relayChecks.command(d) : { ok: false, error: 'This Riyeser Link Office can\'t run relay checks yet. Update it in Riyeser Central.' };
      default: throw new Error('This Riyeser Link Office doesn\'t know how to do that yet. Update it in Riyeser Central.');
    }
    service.log('info', `From Riyeser Link: ${what}.`);
    return { ok: true };
  } catch (e) {
    service.log('warn', `A change from Riyeser Link didn't work: ${e.message}`);
    return { ok: false, error: String(e.message || 'It didn\'t work.').slice(0, 300) };
  }
}

class LinkCloud extends EventEmitter {
  /** opts: { service: PhoneService, clients: () => [Online-like], appData, version, pcName, now: () => ms } */
  constructor(opts = {}) {
    super();
    Object.assign(this, { service: opts.service, clientsFn: opts.clients || (() => []), appData: opts.appData, version: opts.version || '', pcName: opts.pcName || '' });
    this.now = opts.now || Date.now;
    this.state = { status: 'starting', at: null, error: null };
    this.lastSig = null; this.lastReportAt = 0; this.notYetUntil = 0; this.timers = [];
  }
  company() { const c = readCompany(this.appData); return c && c.mode === 'online' && c.workspace_id ? c : null; }
  lastReg() { return (this.service.store.get('phone-cloud', {}) || {}).lastReg || {}; }
  payload() {
    const st = this.service.status();
    const p = buildPayload(st, { officeId: this.service.officeId(), pcName: this.pcName, version: this.version, adapters: this.service.adapters(), lastReg: this.lastReg(), now: this.now() });
    const seen = p.phones.filter((x) => x.registered).map((x) => [x.mac, x.last_registered]);
    if (seen.length) this.service.store.update('phone-cloud', {}, (c) => ({ ...(c || {}), lastReg: { ...((c && c.lastReg) || {}), ...Object.fromEntries(seen) } }));
    return p;
  }
  /** Try each signed-in client in turn (this app's own sign-in, then Riyeser Central's). */
  async withClient(fn) {
    let last = null;
    for (const online of (this.clientsFn() || []).filter(Boolean)) {
      if (!online.session) continue;
      try { return await fn(online); } catch (e) { last = e; if (missingFn(e)) break; }
    }
    throw last || new Error('Sign in to your Riyeser account (here or in Riyeser Central) to see the phones on the website.');
  }
  setState(s) { this.state = { ...this.state, ...s }; this.emit('change', this.state); }
  failed(e) {
    if (missingFn(e)) { this.notYetUntil = this.now() + NOT_YET; this.setState({ status: 'not-yet', error: 'Riyeser Link online isn\'t ready for this yet. It tries again by itself.' }); }
    else this.setState({ status: 'offline', error: String((e && e.message) || e) });
  }
  ready() {
    if (!this.company()) { this.setState({ status: 'local', error: null }); return null; }
    if (this.notYetUntil > this.now()) return null;
    return this.company();
  }

  /** Send the heartbeat now. -> { ok, pending } | { ok: false, error } (never throws: the phones don't depend on it) */
  async report(reason = 'timer') {
    const co = this.ready(); if (!co) return { ok: false, error: this.state.error || 'not linked' };
    if (this.reporting) return this.reporting;
    this.reporting = (async () => {
      try {
        const payload = this.payload();
        const r = await this.withClient((o) => o.rpc('link_office_report', { ws: co.workspace_id, office_id: payload.office_id, payload }));
        this.lastSig = signature(payload); this.lastReportAt = this.now();
        this.setState({ status: 'online', at: iso(this.now()), error: null, reason });
        this.relayReport().catch(() => null);
        if (r && Number(r.pending) > 0) setImmediate(() => this.poll().catch(() => null));
        return { ok: true, pending: Number((r && r.pending) || 0) };
      } catch (e) { this.failed(e); return { ok: false, error: this.state.error }; }
      finally { this.reporting = null; }
    })();
    return this.reporting;
  }

  // ---------- the Riyeser relay (1.3.0) ----------
  /**
   * Is the relay on for this business, which relays (in order) and a pass for each (6 hours). The last answer is
   * kept on this PC (passes sealed), so with Riyeser online unreachable but the internet up the relay still works
   * until the passes run out. -> { enabled, relays, tokens, exp }
   */
  async relayConfig() {
    const co = this.company();
    if (!co) throw new Error('This PC isn\'t linked to a Riyeser Online company (link it in Riyeser Central).');
    const ws = co.workspace_id; const office = this.service.officeId();
    try {
      const cfg = await this.withClient((o) => o.rpc('link_relay_config', { ws }));
      if (!cfg || !cfg.enabled) { this.service.store.set('phone-relay', { enabled: false, at: iso(this.now()) }); return { enabled: false, relays: (cfg && cfg.relays) || [] }; }
      const t = await this.withClient((o) => o.rpc('link_relay_token', { ws, office_id: office }));
      const out = { enabled: true, relays: t.relays || cfg.relays || [], tokens: t.tokens || {}, exp: Number(t.exp) || 0 };
      const seal = this.service.directory && this.service.directory.seal;
      this.service.store.set('phone-relay', { ...out, tokens: seal ? Object.fromEntries(Object.entries(out.tokens).map(([k, v]) => [k, seal(v)])) : out.tokens, at: iso(this.now()) });
      return out;
    } catch (e) {
      if (/switched off|disconnected from the relay/i.test(String(e.message))) throw e;   // a real answer, not a network problem
      const c = this.service.store.get('phone-relay', null);
      const unseal = this.service.directory && this.service.directory.unseal;
      if (c && c.enabled && Number(c.exp) * 1000 > this.now() + 60000) return { ...c, tokens: unseal ? Object.fromEntries(Object.entries(c.tokens || {}).map(([k, v]) => [k, unseal(v)])) : c.tokens, cached: true };
      throw e;
    }
  }
  /**
   * 1.3.1: "This PC as the relay": a set-up code from the website (or made here by an unlocked admin) -> this relay's
   * own new key, once. Needs no sign-in: the code is the permission (30 minutes, used once).
   * -> { relay_id, host, dns, region, priority, replaces, key }
   */
  async claimRelayCode(code) {
    const c = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!/^RLY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)) throw new Error('Type the set-up code as it shows on the website, like RLY-AB12-CD34-EF56.');
    const o = this.service.online;
    const r = await o.call('/rest/v1/rpc/relay_enroll_claim', { method: 'POST', auth: false, body: { code: c } });
    if (!r || !/^[0-9a-f]{64}$/.test(r.key || '') || !/^[a-z0-9-]{2,40}$/.test(r.relay_id || '')) throw new Error('Riyeser online didn\'t send this relay\'s key. Make a new set-up code and try again.');
    return r;
  }
  /** Tell the website how the relay connection is (state, which relay, round trip) — never calls or numbers. */
  async relayReport(force = false) {
    const co = this.ready(); const st = this.service.status().relay;
    if (!co || !st || st.state === 'local') return false;
    // 1.3.1: the guided checklist too (each step's key, state and short line), the last test call, and whether this PC is the relay
    let list = null;
    if (this.service.relayChecks) { try { list = await this.service.relayChecks.list(); } catch { list = null; } }
    const checks = list && !list.unused ? require('../renderer/link-relaycheck').forReport(list) : undefined;
    const t = st.test ? { rtt_ms: st.test.rtt_ms, loss: st.test.loss, ok: !!st.test.ok, at: st.test.at } : undefined;
    const host = !!(list && list.facts && list.facts.host && list.facts.host.installed);
    const sig = JSON.stringify([st.state, st.relay, st.backup, st.udp, st.error, st.sites && st.sites.length, Math.round((st.rtt || 0) / 25), checks && checks.map((c) => `${c.k}${c.s}`), t && t.at, host]);
    if (!force && sig === this.lastRelaySig && this.now() - (this.lastRelayAt || 0) < HEARTBEAT - 1000) return false;
    try {
      await this.withClient((o) => o.rpc('link_relay_report', { ws: co.workspace_id, office_id: this.service.officeId(),
        state: { state: st.state, relay: st.relay, region: st.region, rtt_ms: st.rtt, backup: st.backup, udp: st.udp, error: st.error, sites: (st.sites || []).length, since: st.since, checks, test: t, host } }));
      this.lastRelaySig = sig; this.lastRelayAt = this.now();
      return true;
    } catch { return false; }
  }

  /** Fetch and do the changes waiting from the website. -> how many were done */
  async poll() {
    const co = this.ready(); if (!co || this.polling) return 0;
    this.polling = true;
    let n = 0;
    try {
      const office = this.service.officeId();
      const list = await this.withClient((o) => o.rpc('link_office_pending', { ws: co.workspace_id, office_id: office }));
      for (const cmd of Array.isArray(list) ? list : []) {
        const r = await applyCommand(this.service, cmd);
        const args = { command: cmd.id, ok: r.ok, error: r.ok ? null : r.error, sealed: r.sealed || null };
        if (r.result) {
          try { await this.withClient((o) => o.rpc('link_office_done', { ...args, result: r.result })); }
          catch (e) { if (!missingFn(e)) throw e; await this.withClient((o) => o.rpc('link_office_done', args)); }   // a database from before 1.2.3
        } else await this.withClient((o) => o.rpc('link_office_done', args));
        n++;
      }
      if (this.state.status !== 'online') this.setState({ status: 'online', at: this.state.at || iso(this.now()), error: null });
    } catch (e) { this.failed(e); } finally { this.polling = false; }
    if (n) await this.report('changes');
    return n;
  }

  /** Called on every change on this PC: report soon if what the website shows would be different. */
  changed() {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      try {
        if (!this.ready() || this.state.status === 'offline') return;
        this.relayReport().catch(() => null);
        if (signature(buildPayload(this.service.status(), { officeId: this.service.officeId(), pcName: this.pcName, version: this.version, adapters: this.service.adapters() })) === this.lastSig) return;
        if (this.now() - this.lastReportAt < MIN_GAP) { this.changed(); return; }
        this.report('change');
      } catch { /* the next heartbeat will do */ }
    }, SOON);
    if (this.soon.unref) this.soon.unref();
  }

  start() {
    const every = (fn, ms) => { const t = setInterval(() => fn().catch(() => null), ms); if (t.unref) t.unref(); this.timers.push(t); };
    every(() => this.report('timer'), HEARTBEAT);
    every(() => this.poll(), POLL);
    this.onChange = () => this.changed();
    this.service.on('change', this.onChange);
    // this PC's address changed: the website's "server address to type into phones" must follow at once
    this.onAddress = () => { this.lastReportAt = 0; this.report('address').catch(() => null); };
    this.service.on('address-changed', this.onAddress);
    const first = setTimeout(() => this.report('start').then(() => this.poll()).catch(() => null), 4000);
    if (first.unref) first.unref(); this.timers.push(first);
    return this;
  }
  stop() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = []; clearTimeout(this.soon); this.soon = null;
    if (this.onChange) this.service.off('change', this.onChange);
    if (this.onAddress) this.service.off('address-changed', this.onAddress);
  }
}

module.exports = { LinkCloud, buildPayload, applyCommand, sealFor, signature, HEARTBEAT, POLL };
