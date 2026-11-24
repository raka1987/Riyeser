// Riyeser Link Office and Riyeser Link online: so the business's owners and admins (and, when they allow it, Riyeser
// support) can see and manage the desk phones from the website, not only on this PC's screen.
//   Heartbeat  every 5 minutes, and soon after something changes (a phone connects or is given to someone, the address
//              changes): this PC's name and version, the address to type into phones, the licence, counts, the desk
//              phones and the extensions (link_office_report).
//   Changes    every 30 seconds: changes made on the website (give a phone to someone, add one by MAC address, take a
//              phone off someone, a new password, Do not disturb, Show password). Each is done here, then marked done
//              or failed with a plain reason (link_office_pending / link_office_done).
//   Passwords  never leave this PC in a form anyone else can read. "Show" on the website sends a one-off public key;
//              the password is encrypted to it here (RSA-OAEP, SHA-256), so only that browser tab can read it.
// PRIVACY: no calls, numbers dialled, recordings or audio are ever sent: only how many calls are in progress.
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
        name: p.label || '', location: p.location || '', note: p.note || '', provisioned_at: p.lastFetch || null };
    }),
    ...(status.found || []).map((f) => ({ mac: f.mac, vendor: VENDORS[f.vendor] || '', model: f.model || '', extension: null, assigned: false, registered: false,
      last_registered: null, ip: f.ip || null })),
  ];
  const regsOf = (ext) => regs.filter((r) => r.ext === ext);
  const extensions = [
    ...(status.people || []).map((p) => ({ extension: p.ext, name: p.name, type: 'person', registered: regsOf(p.ext).length,
      desk_phones: (status.phones || []).filter((x) => x.ext === p.ext).length, app_users: regsOf(p.ext).filter((r) => r.device === 'app').length, dnd: !!p.dnd })),
    ...(status.groups || []).map((g) => ({ extension: g.ext, name: g.name, type: 'group', members: (g.members || []).length })),
  ];
  const lic = status.licence || {};
  return {
    office_id: officeId, pc_name: String(pcName || '').slice(0, 80), version: String(version || '').slice(0, 40), state: status.state,
    addresses: [host, ...others].filter(Boolean), sip_port: status.sipPort || 5060, address_stable: status.addressStable !== false,
    pc_mac: (status.adapter && status.adapter.mac) || '',
    licence: { active: !!lic.active, state: lic.state || '', text: lic.text || lic.message || '' },
    counts: { people: (status.people || []).length, groups: (status.groups || []).length, phones_assigned: (status.phones || []).length,
      phones_connected: phones.filter((p) => p.registered).length, new_phones: (status.found || []).length,
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

/** Do one change from the website. -> { ok, error?, sealed? } (never the password itself) */
function applyCommand(service, cmd) {
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
        if (r && Number(r.pending) > 0) setImmediate(() => this.poll().catch(() => null));
        return { ok: true, pending: Number((r && r.pending) || 0) };
      } catch (e) { this.failed(e); return { ok: false, error: this.state.error }; }
      finally { this.reporting = null; }
    })();
    return this.reporting;
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
        const r = applyCommand(this.service, cmd);
        await this.withClient((o) => o.rpc('link_office_done', { command: cmd.id, ok: r.ok, error: r.ok ? null : r.error, sealed: r.sealed || null }));
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
    const first = setTimeout(() => this.report('start').then(() => this.poll()).catch(() => null), 4000);
    if (first.unref) first.unref(); this.timers.push(first);
    return this;
  }
  stop() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = []; clearTimeout(this.soon); this.soon = null;
    if (this.onChange) this.service.off('change', this.onChange);
  }
}

module.exports = { LinkCloud, buildPayload, applyCommand, sealFor, signature, HEARTBEAT, POLL };
