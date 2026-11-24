// Riyeser Link Office's engine: the SIP server, the desk-phone set-up server, people, recent calls and the licence,
// put together. The Electron app (phone-main.js) shows it; the self-test and the tests drive it directly.
// It only starts the phone system while Link Plus is on (trial or paid). If it lapses while running, calls in
// progress finish, then new phones and calls are refused. Nothing is deleted: people, phones and call history stay.
const { EventEmitter } = require('events');
const { Pbx } = require('./pbx');
const { Provisioner, prettyMac, VENDORS } = require('./provision');
const { Directory } = require('./directory');
const { CallLog } = require('./calllog');
const { callsLicence } = require('./licence');
const { syncFromTeam } = require('./sync');
const { pickAdapter, localAddresses } = require('./netinfo');

const MAX_LOG = 300;

class PhoneService extends EventEmitter {
  /**
   * opts: { store, appData, host, sipPort = 5060, httpPort = 5080, bind, tcp, multicast, ringTimeout, ifaces,
   *         clients: () => [Online-like], seal, unseal, licence: (appData) => state (tests), log }
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.store = opts.store; this.appData = opts.appData;
    this.directory = new Directory(this.store, { seal: opts.seal, unseal: opts.unseal });
    this.calls = new CallLog(this.store);
    this.logs = [];
    this.pbx = null; this.prov = null;
    this.state = 'starting'; this.error = null; this.syncState = null;
    this.lic = { active: false, state: 'none' };
  }
  log(level, text) {
    this.logs.push({ at: new Date().toISOString(), level, text: String(text).slice(0, 300) });
    if (this.logs.length > MAX_LOG) this.logs.shift();
    if (this.opts.log) { try { this.opts.log(level, text); } catch { /* never mind */ } }
    this.emit('change');
  }
  settings() { return this.store.get('phone-settings', {}) || {}; }
  setSettings(patch) { this.store.set('phone-settings', { ...this.settings(), ...patch }); }
  licence() { return (this.opts.licence || callsLicence)(this.appData); }

  ifaces() { const f = this.opts.ifaces; return typeof f === 'function' ? f() : f; }
  /** This PC's office address now (the adapter chosen in settings, else the most likely one). */
  adapter() { return this.opts.host ? { name: '', address: this.opts.host, mac: '', chosen: false } : pickAdapter(this.ifaces(), this.settings().adapter); }

  async start() {
    this.host = this.adapter().address;
    this.noteAddress(this.host);
    await this.checkLicence();
    return this;
  }
  /**
   * Phones keep this PC's address, so note when it changes: since the last start, or while running. A change shows a
   * notice, and every desk phone it can reach is asked to fetch its settings again (which carry the new address).
   * Three changes in 30 days means the address isn't stable: the notice then stays until the router is sorted out.
   */
  noteAddress(addr, now = Date.now()) {
    const s = this.settings();
    const last = s.lastHost;
    if (last && last !== addr) {
      const history = [...(s.hostChanges || []).filter((c) => now - Date.parse(c.at) < 30 * 86400000), { at: new Date(now).toISOString(), from: last, to: addr }];
      this.ipChanged = { from: last, to: addr, at: new Date(now).toISOString(), unstable: history.length >= 3 };
      this.setSettings({ lastHost: addr, hostChanges: history.slice(-10) });
      this.log('warn', `This PC's network address changed from ${last} to ${addr}. Desk phones are being updated.`);
      this.updatePhones = true;
    } else if (!last) this.setSettings({ lastHost: addr });
  }
  /** Ask every assigned desk phone to fetch its settings again (they now carry this PC's new address). */
  resyncPhones() {
    if (!this.pbx) return 0;
    let n = 0;
    for (const p of this.provisionerData().phones) if (p.ip) { try { this.pbx.checkSync(p.ip); n++; } catch { /* best effort */ } }
    this.updatePhones = false;
    return n;
  }
  /** Run now and then: if the address changed while running, restart the phone system on the new one (between calls). */
  async checkNetwork() {
    if (this.opts.host) return false;
    const now = this.adapter().address;
    if (now === this.host) return false;
    if (this.pbx && this.pbx.callsInProgress().length) return false;   // try again after the calls end
    this.noteAddress(now);
    this.host = now;
    if (this.pbx) { await this.stopPbx(); await this.checkLicence(); }
    return true;
  }
  /** The network adapters the owner can choose from (Settings), and which one is in use. */
  adapters() { const a = this.adapter(); return { current: a, list: localAddresses(this.ifaces()).map((x) => ({ name: x.name, address: x.address, mac: x.mac, virtual: x.virtual })) }; }
  async chooseAdapter(name) { this.setSettings({ adapter: name || '' }); await this.checkNetwork(); this.emit('change'); return this.adapters(); }
  dismissIpNotice() { if (this.ipChanged && !this.ipChanged.unstable) this.ipChanged = null; this.emit('change'); }
  provisionerData() { const d = this.store.get('phone-devices', null) || {}; return { phones: d.phones || [], found: d.found || [] }; }

  /** Look at the licence again and start, keep going, or wind down. */
  async checkLicence() {
    this.lic = this.licence();
    if (this.lic.active) {
      if (!this.pbx) await this.startPbx();
      else if (!this.pbx.accepting) { this.pbx.setAccepting(true); this.state = 'running'; this.log('info', 'Link Plus is on again. Phones can connect and call.'); }
    } else if (this.pbx) {
      if (this.pbx.accepting) {
        this.log('warn', 'Link Plus isn\'t active any more. Calls in progress can finish; new calls and phones are refused.');
        this.state = 'stopping';
        this.pbx.setAccepting(false);   // 'idle' (below) stops the phone system once the last call ends
      }
    } else this.state = 'waiting-licence';
    this.emit('change');
    return this.lic;
  }

  async startPbx() {
    const o = this.opts; const s = this.settings();
    const pbx = new Pbx({ directory: this.directory, host: this.host, port: o.sipPort == null ? 5060 : o.sipPort, bind: o.bind, tcp: o.tcp, multicast: o.multicast,
      allowPublic: !!s.allowPublic, ringTimeout: o.ringTimeout, ifaces: this.ifaces(), log: (l, t) => this.log(l, t), onPnp: (info) => this.prov && this.prov.onPnp(info) });
    const prov = new Provisioner({ store: this.store, directory: this.directory, host: this.host, sipPort: 0, httpPort: o.httpPort == null ? 5080 : o.httpPort,
      bind: o.bind, allowPublic: !!s.allowPublic, log: (l, t) => this.log(l, t) });
    try {
      await pbx.start();
      prov.sipPort = pbx.port;
      await prov.start();
    } catch (e) {
      await pbx.stop().catch(() => {}); await prov.stop().catch(() => {});
      this.state = 'error';
      this.error = e.code === 'EADDRINUSE' ? 'Another program on this PC is already using the phone ports (5060 or 5080). Close other phone or SIP software, then restart Riyeser Link Office.'
        : `Riyeser Link Office couldn't start: ${e.message}`;
      this.log('error', this.error);
      return;
    }
    pbx.on('change', () => this.emit('change'));
    pbx.on('call-ended', (rec) => { this.calls.add(rec); });
    pbx.on('idle', () => { if (!this.lic.active) this.stopPbx('licence'); });
    prov.on('change', () => this.emit('change'));
    prov.on('assigned', (p) => { if (p.ip) pbx.checkSync(p.ip); });
    this.pbx = pbx; this.prov = prov; this.state = 'running'; this.error = null;
    if (this.updatePhones) this.resyncPhones();
    this.emit('change');
  }
  async stopPbx(why) {
    const pbx = this.pbx; const prov = this.prov;
    this.pbx = null; this.prov = null;
    if (pbx) await pbx.stop().catch(() => {});
    if (prov) await prov.stop().catch(() => {});
    if (why === 'licence') { this.state = 'waiting-licence'; this.log('info', 'Riyeser Link Office is paused until Link Plus is on. People, phones and call history are kept.'); }
    this.emit('change');
  }
  async stop() { clearInterval(this.timer); await this.stopPbx(); }

  /** Bring people in from Riyeser Link (when linked), then re-check the licence. */
  async sync() {
    const r = await syncFromTeam({ clients: (this.opts.clients ? this.opts.clients() : []), appData: this.appData, directory: this.directory });
    this.syncState = { ...r, at: new Date().toISOString() };
    if (r.status === 'synced') this.log('info', `Brought in ${r.people} people and ${r.groups} ring group${r.groups === 1 ? '' : 's'} from Riyeser Link.`);
    await this.checkLicence();
    return this.syncState;
  }

  // ---------- what the owner can do ----------
  devices() { return this.prov || new Provisioner({ store: this.store, directory: this.directory, host: this.host }); }
  assign(mac, ext, vendor) { return this.devices().assign(mac, ext, { vendor }); }
  unassign(mac) { return this.devices().unassign(mac); }
  ignore(mac) { return this.devices().ignore(mac); }
  addPerson(p) { const r = this.directory.addPerson(p); this.emit('change'); return r; }
  removePerson(id) { const r = this.directory.removePerson(id); this.emit('change'); return r; }
  setDnd(ext, on) { this.directory.setDnd(ext, on); this.emit('change'); return true; }
  /** The details to type into any SIP phone by hand. */
  manual(ext) {
    const u = this.directory.user(ext);
    if (!u) throw new Error('No one has that extension.');
    return { server: this.host, port: this.pbx ? this.pbx.port : (this.opts.sipPort || 5060), username: u.ext, authName: u.ext, password: u.password, name: u.name };
  }
  resetPassword(ext) { this.directory.resetPassword(ext); this.log('info', `New password made for extension ${ext}. Its phones need setting up again (assigned desk phones get it when they restart).`); return this.manual(ext); }

  /** Everything the status screen shows, in plain words. */
  status() {
    const snap = this.pbx ? this.pbx.snapshot() : { registrations: [], calls: [], blocked: [], running: false };
    const waiting = !this.lic.active;
    const regsBy = new Map();
    for (const r of snap.registrations) { if (!regsBy.has(r.ext)) regsBy.set(r.ext, []); regsBy.get(r.ext).push(r); }
    const busy = new Map();
    for (const c of snap.calls) { for (const e of [c.from, c.answeredBy || (c.state === 'ringing' ? null : c.to)]) if (e) busy.set(e, 'on a call'); if (c.state === 'ringing' && !busy.has(c.to)) busy.set(c.to, 'ringing'); }
    const phones = this.provisionerData().phones;
    const people = this.directory.people().map((p) => {
      const regs = regsBy.get(p.ext) || [];
      const kinds = [...new Set(regs.map((r) => r.device))];
      const assigned = phones.filter((x) => x.ext === p.ext);
      const state = waiting ? 'waiting for Link Plus' : busy.get(p.ext) || (regs.length ? 'ready' : 'not connected');
      return { id: p.id, name: p.name, ext: p.ext, source: p.source, dnd: this.directory.dnd(p.ext), device: kinds.length ? kinds.join(' + ') : assigned.length ? 'desk phone' : '',
        connected: regs.length > 0, state, ips: regs.map((r) => r.ip) };
    });
    const regIps = new Set(snap.registrations.map((r) => r.ip));
    const found = this.provisionerData().found.filter((f) => !f.ignored).map((f) => ({ ...f, macText: prettyMac(f.mac), vendorName: VENDORS[f.vendor] || 'Desk phone' }));
    const d = this.directory.data();
    return {
      state: this.state, error: this.error, host: this.host, sipPort: snap.port || this.opts.sipPort || 5060, httpPort: this.prov ? this.prov.httpPort : (this.opts.httpPort || 5080),
      licence: this.lic, business: d.business, source: d.source, teamSyncedAt: d.teamSyncedAt, skipped: d.skipped || [], sync: this.syncState,
      people, groups: this.directory.groups().map((g) => ({ ...g, names: g.members.map((m) => this.directory.nameOf(m)) })),
      phones: phones.map((x) => ({ ...x, macText: prettyMac(x.mac), vendorName: VENDORS[x.vendor] || 'Desk phone', name: this.directory.nameOf(x.ext),
        state: waiting ? 'waiting for Link Plus' : (x.ip && regIps.has(x.ip)) ? 'connected' : x.lastFetch ? 'set up, not connected now' : 'waiting for the phone to ask for its settings' })),
      found, inProgress: snap.calls, recent: this.calls.list({ limit: 100 }),
      counts: { connected: new Set(snap.registrations.map((r) => r.ext)).size, onCalls: snap.calls.filter((c) => c.state === 'talking').length, phones: snap.registrations.length },
      blocked: snap.blocked, ipChanged: this.ipChanged || null, adapter: this.adapter(), allowPublic: !!this.settings().allowPublic, logs: this.logs.slice(-60).reverse(),
    };
  }
}

module.exports = { PhoneService };
