// Riyeser Link Office's engine: the SIP server, the desk-phone set-up server, people, recent calls and the licence,
// put together. The Electron app (phone-main.js) shows it; the self-test and the tests drive it directly.
// It only starts the phone system while Riyeser Link is on (trial or paid). If it lapses while running, calls in
// progress finish, then new phones and calls are refused. Nothing is deleted: people, phones and call history stay.
const { EventEmitter } = require('events');
const { Pbx } = require('./pbx');
const { Provisioner, prettyMac, normaliseMac, vendorKey, resyncEvent, VENDORS } = require('./provision');
const { Directory } = require('./directory');
const { CallLog } = require('./calllog');
const { callsLicence } = require('./licence');
const { syncFromTeam } = require('./sync');
const { pickAdapter, localAddresses } = require('./netinfo');
const { MdnsResponder, NAME: MDNS_NAME } = require('./mdns');
const { NetWatcher } = require('./netwatch');
const { findRouterName } = require('./pcname');

const MAX_LOG = 300;

class PhoneService extends EventEmitter {
  /**
   * opts: { store, appData, host, sipPort = 5060, httpPort = 5080, bind, tcp, multicast, ringTimeout, ifaces,
   *         clients: () => [Online-like], seal, unseal, licence: (appData) => state (tests), log,
   *         mdns: false | { port, multicast } (riyeser-office.local; off unless given), hostname (this PC's name),
   *         netConfig: () => Promise<[windows.js readNetConfig() rows]> (routers, DNS suffixes, adapter descriptions),
   *         findName: (opts) => Promise<name | null> (the router's DNS name for this PC; pcname.js) }
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
    this.net = { rows: [], gateways: [], describe: {}, suffixes: [] };   // from Windows (netConfig), refreshed on every change
    this.routerName = null; this.mdns = null; this.watcher = null;
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
  /** This PC's office address now (the adapter chosen in settings, else the one in use, else the most likely one). */
  adapter() {
    if (this.opts.host) return { name: '', address: this.opts.host, mac: '', chosen: false };
    const s = this.settings();
    return pickAdapter(this.ifaces(), s.adapter, { last: { name: s.lastAdapter, address: this.host || s.lastHost }, gateways: this.net.gateways, describe: this.net.describe });
  }
  /** What Windows says about the adapter in use: its router, DNS servers, DHCP or fixed, description. */
  adapterInfo(a = this.adapter()) { return this.net.rows.find((r) => r.address === a.address) || null; }
  /** Routers, adapter descriptions (to spot virtual ones) and DNS suffixes, from Windows. Never fails. */
  async refreshNet() {
    if (!this.opts.netConfig) return this.net;
    try {
      const rows = await this.opts.netConfig();
      this.net = { rows, gateways: rows.filter((r) => r.gateway).map((r) => r.address), describe: Object.fromEntries(rows.map((r) => [r.alias, r.description])),
        suffixes: [...new Set(rows.map((r) => r.suffix).filter(Boolean))] };
    } catch { /* keep the last */ }
    return this.net;
  }
  /** The names phones and apps can use for this PC: riyeser-office.local (answered here) and, if it checks out, the router's. */
  mdnsName() { return (this.mdns && this.mdns.name) || this.settings().mdnsName || MDNS_NAME; }
  /** Phones are given the router's name for this PC (if it has one that checks out), or its address (the default). */
  useName() { return this.settings().phoneAddress === 'name' && !!this.routerName; }
  phoneServer() { return this.useName() ? this.routerName : this.host; }
  async refreshNames() {
    const find = this.opts.findName || findRouterName;
    if (this.opts.host || this.host === '127.0.0.1') { this.routerName = null; this.applyNames(); return null; }
    const host = this.host;
    let name = null;
    try { name = await find({ hostname: this.opts.hostname || require('os').hostname(), suffixes: this.net.suffixes, address: host, servers: (this.adapterInfo() || {}).dns }); } catch { name = null; }
    if (host !== this.host) return this.routerName;   // the address moved again meanwhile: the next look decides
    if (name !== this.routerName) {
      if (name) this.log('info', `The office network knows this PC as ${name}, so phones can find it by name.`);
      else if (this.routerName) this.log('info', `The office network no longer knows this PC as ${this.routerName}. Phones use its address, ${host}.`);
      this.routerName = name; this.applyNames();
    }
    return name;
  }
  applyNames() {
    if (this.pbx) this.pbx.setNames([this.mdnsName(), this.routerName]);
    if (this.prov) this.prov.setHost(this.host, { name: this.routerName, useName: this.useName() });
    this.emit('change');
  }
  async setPhoneAddress(mode) {
    this.setSettings({ phoneAddress: mode === 'name' ? 'name' : 'address' });
    await this.refreshNames();
    this.applyNames();
    if (this.pbx) this.resyncPhones();
    return this.names();
  }
  names() { return { mdns: this.mdnsName(), router: this.routerName, useName: this.useName(), mode: this.settings().phoneAddress === 'name' ? 'name' : 'address', server: this.phoneServer() }; }

  async start() {
    await this.refreshNet();
    const a = this.adapter();
    this.host = a.address;
    this.noteAddress(this.host, Date.now(), 'start');
    if (a.name) this.setSettings({ lastAdapter: a.name });
    await this.checkLicence();
    this.refreshNames().catch(() => null);
    return this;
  }
  /** Watch for address changes (adapters polled every few seconds, plus Windows' own change events). */
  watch(opts = {}) {
    if (this.watcher || this.opts.host) return this.watcher;
    this.watcher = new NetWatcher({ ifaces: () => this.ifaces() || require('os').networkInterfaces(), log: (l, t) => this.log(l, t), ...opts }).start();
    this.watcher.on('change', (c) => this.checkNetwork(c.source).catch((e) => this.log('error', `Couldn't move to the new address: ${e.message}`)));
    return this.watcher;
  }
  /**
   * Phones keep this PC's address, so note when it changes: since the last start, or while running. A change shows a
   * notice, and every desk phone it can reach is asked to fetch its settings again (which carry the new address).
   * Three changes in 30 days means the address isn't stable: the notice then stays until the router is sorted out.
   */
  noteAddress(addr, now = Date.now(), source = 'check') {
    const s = this.settings();
    const last = s.lastHost === '127.0.0.1' ? null : s.lastHost;
    if (addr === '127.0.0.1') {
      if (!last) return;   // no office network at all just now (cable out, Wi-Fi dropped): not a new address
      if (!this.offline) this.log('warn', `This PC isn't connected to the office network right now (it was on ${last}). Phones can't reach it until it's back.`);
      this.offline = true; return;
    }
    this.offline = false;
    if (last && last !== addr) {
      const history = [...(s.hostChanges || []).filter((c) => now - Date.parse(c.at) < 30 * 86400000), { at: new Date(now).toISOString(), from: last, to: addr, source }];
      this.ipChanged = { from: last, to: addr, at: new Date(now).toISOString(), unstable: history.length >= 3, source, phones: 0 };
      this.setSettings({ lastHost: addr, hostChanges: history.slice(-10) });
      this.log('warn', `This PC's network address changed from ${last} to ${addr} (${source === 'start' ? 'since it last ran' : 'just now'}). Desk phones are being updated.`);
      this.updatePhones = true;
    } else if (!last) this.setSettings({ lastHost: addr });
  }
  /**
   * Ask every desk phone to fetch its settings again (they now carry this PC's new address): those given to someone
   * here (at the address they last used) and anything connected right now. reboot (after an address change): the
   * phone also restarts, and on start-up asks the network who sets it up, which finds this PC's new address even if
   * its saved settings still have the old one. Each maker's own wording (provision.js resyncEvent).
   */
  resyncPhones({ reboot = !!this.updatePhones } = {}) {
    if (!this.pbx) return 0;
    // phones connected now, at the address and port they connect from; then phones given out here that aren't connected
    const targets = new Map(); const vendors = new Map(this.provisionerData().phones.filter((p) => p.ip).map((p) => [p.ip, p.vendor]));
    for (const r of this.pbx.snapshot().registrations) {
      if (!r.ip || r.device === 'app' || r.proto !== 'UDP') continue;
      targets.set(`${r.ip}:${r.port || 5060}`, { ip: r.ip, port: r.port || 5060, vendor: vendors.get(r.ip) || vendorKey(r.userAgent) || (/cisco|linksys|\bspa\d/i.test(r.userAgent || '') ? 'cisco' : '') });
    }
    const covered = new Set([...targets.values()].map((t) => t.ip));
    for (const [ip, vendor] of vendors) if (!covered.has(ip)) targets.set(`${ip}:5060`, { ip, port: 5060, vendor });
    let n = 0;
    for (const t of targets.values()) { try { this.pbx.checkSync(t.ip, t.port, resyncEvent(t.vendor, { reboot })); n++; } catch { /* best effort */ } }
    if (this.updatePhones && this.ipChanged) { this.ipChanged.phones = n; if (n) this.log('info', `Asked ${n} desk phone${n === 1 ? '' : 's'} to fetch the new address (${this.host}).`); }
    this.updatePhones = false;
    return n;
  }
  /**
   * Run on every address change (and now and then): if the address phones should use has changed, move to it.
   * The listeners are on every adapter, so they stay up: what we tell phones (Via, Record-Route, Contact, settings,
   * plug-and-play, riyeser-office.local) moves to the new address, then every desk phone is asked to update, and the
   * website hears straight away. If the old address is still on this PC (say a second network appeared) and calls are
   * in progress, it waits for them to end; if the old address is gone, those calls can't carry on anyway.
   */
  async checkNetwork(source = 'check') {
    if (this.opts.host || this.moving) return false;
    if (source !== 'check' || !this.net.rows.length) await this.refreshNet();
    const a = this.adapter(); const now = a.address;
    if (now === this.host) { if (this.offline && now !== '127.0.0.1') this.offline = false; return false; }
    const stillHere = localAddresses(this.ifaces()).some((x) => x.address === this.host);
    if (this.pbx && stillHere && this.pbx.callsInProgress().length) { this.pendingMove = true; return false; }   // after the calls end
    if (now === '127.0.0.1') { this.noteAddress(now, Date.now(), source); this.emit('change'); return false; }   // no network: wait for one
    this.moving = true; this.pendingMove = false;
    try {
      const from = this.host;
      this.noteAddress(now, Date.now(), source);
      this.host = now;
      if (a.name) this.setSettings({ lastAdapter: a.name });
      const live = !this.opts.bind || this.opts.bind === '0.0.0.0';
      if (this.pbx && live) {
        this.pbx.setHost(now, this.ifaces());
        this.prov.setHost(now);
        if (this.mdns) this.mdns.setAddress(now);
        this.resyncPhones({ reboot: true });
      } else if (this.pbx) { await this.stopPbx(); await this.checkLicence(); }   // listening on one address only: start again on the new one
      await this.refreshNames().catch(() => null);
      this.emit('address-changed', { from, to: now, source, ...(this.ipChanged || {}) });
      this.emit('change');
      return true;
    } finally { this.moving = false; }
  }
  /** The network adapters the owner can choose from (Settings), and which one is in use. */
  adapters() {
    const a = this.adapter(); const info = this.adapterInfo(a);
    return { current: { ...a, gateway: info ? info.gateway : '', dhcp: info ? info.dhcp : null, description: info ? info.description : '', prefix: info ? info.prefix : null, dns: info ? info.dns : [] },
      list: localAddresses(this.ifaces(), { describe: this.net.describe }).map((x) => ({ name: x.name, address: x.address, mac: x.mac, virtual: x.virtual })) };
  }
  async chooseAdapter(name) { this.setSettings({ adapter: name || '' }); await this.checkNetwork(); this.emit('change'); return this.adapters(); }
  /** The address is "stable" until it has changed 3 times in 30 days (then phones may keep losing touch). */
  addressStable(now = Date.now()) { return (this.settings().hostChanges || []).filter((c) => now - Date.parse(c.at) < 30 * 86400000).length < 3; }
  /** This install's id for Riyeser Link online (made once, kept in phone-settings.json). */
  officeId() { let id = this.settings().officeId; if (!id) { id = `lo-${require('crypto').randomUUID()}`; this.setSettings({ officeId: id }); } return id; }
  dismissIpNotice() { if (this.ipChanged && !this.ipChanged.unstable) this.ipChanged = null; this.emit('change'); }
  provisionerData() { const d = this.store.get('phone-devices', null) || {}; return { phones: d.phones || [], found: d.found || [] }; }

  /** Look at the licence again and start, keep going, or wind down. */
  async checkLicence() {
    this.lic = this.licence();
    if (this.lic.active) {
      if (!this.pbx) await this.startPbx();
      else if (!this.pbx.accepting) { this.pbx.setAccepting(true); this.state = 'running'; this.log('info', 'Riyeser Link is on again. Phones can connect and call.'); }
    } else if (this.pbx) {
      if (this.pbx.accepting) {
        this.log('warn', 'Riyeser Link isn\'t active any more. Calls in progress can finish; new calls and phones are refused.');
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
      bind: o.bind, allowPublic: !!s.allowPublic, log: (l, t) => this.log(l, t), name: this.routerName, useName: this.useName() });
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
    pbx.setNames([this.mdnsName(), this.routerName]);
    pbx.on('change', () => { this.emit('change'); if (this.pendingMove && !pbx.callsInProgress().length) setImmediate(() => this.checkNetwork('calls ended').catch(() => null)); });
    pbx.on('call-ended', (rec) => { this.calls.add(rec); });
    pbx.on('idle', () => { if (!this.lic.active) this.stopPbx('licence'); });
    prov.on('change', () => this.emit('change'));
    prov.on('assigned', (p) => { if (p.ip) pbx.checkSync(p.ip); });
    this.pbx = pbx; this.prov = prov; this.state = 'running'; this.error = null;
    await this.startMdns();
    if (this.updatePhones) this.resyncPhones({ reboot: true });
    this.emit('change');
  }
  /** riyeser-office.local: answered while the phone system runs (when switched on, which the app does). */
  async startMdns() {
    const m = this.opts.mdns; if (!m || this.mdns) return;
    const r = new MdnsResponder({ name: this.settings().mdnsName || MDNS_NAME, address: this.host, port: m.port, multicast: m.multicast, bind: m.bind, ifaces: () => this.ifaces(), log: (l, t) => this.log(l, t) });
    r.on('name', (n) => { this.setSettings({ mdnsName: n }); if (this.pbx) this.pbx.setNames([n, this.routerName]); this.emit('change'); });
    try { await r.start(); this.mdns = r; } catch (e) { this.log('warn', `Phones and apps can't find this PC as ${r.name} (${e.code || e.message}). Its address still works.`); }
  }
  async stopPbx(why) {
    const pbx = this.pbx; const prov = this.prov; const mdns = this.mdns;
    this.pbx = null; this.prov = null; this.mdns = null;
    if (mdns) await mdns.stop().catch(() => {});
    if (pbx) await pbx.stop().catch(() => {});
    if (prov) await prov.stop().catch(() => {});
    if (why === 'licence') { this.state = 'waiting-licence'; this.log('info', 'Riyeser Link Office is paused until Riyeser Link is on. People, phones and call history are kept.'); }
    this.emit('change');
  }
  async stop() { clearInterval(this.timer); if (this.watcher) { this.watcher.stop(); this.watcher = null; } await this.stopPbx(); }

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
  label(mac, fields) { const r = this.devices().label(mac, fields); this.emit('change'); return r; }
  /** Replace a desk phone: the new one gets the old one's extension, name, location and note; the old one stops getting settings. */
  replacePhone(oldMac, newMac, vendor) {
    const was = this.provisionerData().phones.find((x) => x.mac === normaliseMac(oldMac));
    if (!was) throw new Error('That phone isn\'t given to anyone.');
    if (!normaliseMac(newMac)) throw new Error('That isn\'t a MAC address. It\'s 12 letters and numbers, on a sticker under the phone (like 00:15:65:12:34:56).');
    if (normaliseMac(newMac) === was.mac) throw new Error('That\'s the same phone.');
    const p = this.assign(newMac, was.ext, vendor);
    this.devices().label(p.mac, { name: was.label, location: was.location, note: '' });
    this.unassign(was.mac);
    this.emit('change');
    return { ...p, label: was.label, location: was.location };
  }
  ignore(mac) { return this.devices().ignore(mac); }
  addPerson(p) { const r = this.directory.addPerson(p); this.emit('change'); return r; }
  removePerson(id) { const r = this.directory.removePerson(id); this.emit('change'); return r; }
  setDnd(ext, on) { this.directory.setDnd(ext, on); this.emit('change'); return true; }
  /** The details to type into any SIP phone by hand. */
  manual(ext) {
    const u = this.directory.user(ext);
    if (!u) throw new Error('No one has that extension.');
    return { server: this.phoneServer(), address: this.host, names: this.names(), port: this.pbx ? this.pbx.port : (this.opts.sipPort || 5060), username: u.ext, authName: u.ext, password: u.password, name: u.name };
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
      const state = waiting ? 'waiting for Riyeser Link' : busy.get(p.ext) || (regs.length ? 'ready' : 'not connected');
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
      phones: phones.map((x) => ({ ...x, macText: prettyMac(x.mac), vendorName: VENDORS[x.vendor] || 'Desk phone', name: this.directory.nameOf(x.ext), registered: !!(x.ip && regIps.has(x.ip)),
        lastRegistered: (x.ip && regIps.has(x.ip)) ? new Date().toISOString() : (((this.store.get('phone-cloud', {}) || {}).lastReg || {})[x.mac] || null),
        state: waiting ? 'waiting for Riyeser Link' : (x.ip && regIps.has(x.ip)) ? 'connected' : x.lastFetch ? 'set up, not connected now' : 'waiting for the phone to ask for its settings' })),
      found, inProgress: snap.calls, recent: this.calls.list({ limit: 100 }),
      counts: { connected: new Set(snap.registrations.map((r) => r.ext)).size, onCalls: snap.calls.filter((c) => c.state === 'talking').length, phones: snap.registrations.length },
      registrations: snap.registrations.map((r) => ({ ext: r.ext, ip: r.ip, device: r.device, since: r.since })), addressStable: this.addressStable(),
      blocked: snap.blocked, ipChanged: this.ipChanged || null, adapter: this.adapter(), names: this.names(), offline: !!this.offline,
      addressChanges: (this.settings().hostChanges || []).slice(-5).reverse(), fixedAddress: this.settings().fixedAddress || null, allowPublic: !!this.settings().allowPublic, logs: this.logs.slice(-60).reverse(),
    };
  }
}

module.exports = { PhoneService };
