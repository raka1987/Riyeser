// Zero-touch desk-phone set-up for Riyeser Link Office.
// A new desk phone asks the office network "who sets me up?" (SIP plug-and-play, SUBSCRIBE Event: ua-profile on
// 224.0.1.75). The phone system answers with the address of the small web server below, and the phone fetches its
// settings file from it, in its maker's own format:
//   Yealink      /yealink/<mac>.cfg
//   Grandstream  /grandstream/cfg<mac>.xml
//   Snom         /snom/<mac>.xml
//   Polycom      /polycom/<mac>.cfg (+ <mac>-riyeser.cfg)
// Settings hold the extension's password, so a file is only given to a phone the owner has assigned to someone, only
// on the office network, and every fetch is logged (without the password).
// phone-devices.json: { phones: [{ mac, ext, vendor, model, ip, addedAt, lastSeen, lastFetch, label, location, note }], found: [{ mac, vendor, model, ip, firstSeen, lastSeen }], fetches: [...] }
const http = require('http');
const { EventEmitter } = require('events');
const { isPrivate, v4 } = require('./netinfo');

const OUI = {
  yealink: ['001565', '249ad8', '805ec0', '805e0c', '44dbd2', '001fc1'],
  grandstream: ['000b82', 'c074ad', 'ec74d7'],
  snom: ['000413'],
  polycom: ['0004f2', '64167f', '482567', '00e0db'],
};
const VENDORS = { yealink: 'Yealink', grandstream: 'Grandstream', snom: 'Snom', polycom: 'Polycom' };
const normaliseMac = (s) => { const m = String(s || '').replace(/[\s:.-]/g, '').toLowerCase(); return /^[0-9a-f]{12}$/.test(m) ? m : null; };
const prettyMac = (m) => (m ? m.match(/../g).join(':').toUpperCase() : '');
function vendorKey(vendor, mac) {
  const v = String(vendor || '').toLowerCase();
  for (const k of Object.keys(VENDORS)) if (v.includes(k) || (k === 'polycom' && v.includes('poly'))) return k;
  const oui = String(mac || '').slice(0, 6);
  for (const [k, list] of Object.entries(OUI)) if (list.includes(oui)) return k;
  return '';
}
const xml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const line = (s) => String(s == null ? '' : s).replace(/[\r\n]/g, ' ');

// ---------- the settings files ----------
// a.backup: a second address for the same PC (its name when phones use its address, or the other way round), so a
// phone that loses touch with the first tries the second. After this PC's address changes, the name still works.
/** a: { mac, ext, name, password, server, backup, sipPort, provisionUrl } */
function yealinkConfig(a) {
  return ['#!version:1.0.0.1', '## Riyeser Link Office', 'account.1.enable = 1', `account.1.label = ${line(a.name)}`, `account.1.display_name = ${line(a.name)}`,
    `account.1.auth_name = ${a.ext}`, `account.1.user_name = ${a.ext}`, `account.1.password = ${line(a.password)}`,
    `account.1.sip_server.1.address = ${a.server}`, `account.1.sip_server.1.port = ${a.sipPort}`, 'account.1.sip_server.1.transport_type = 0',
    'account.1.sip_server.1.expires = 600',
    ...(a.backup ? [`account.1.sip_server.2.address = ${line(a.backup)}`, `account.1.sip_server.2.port = ${a.sipPort}`, 'account.1.sip_server.2.transport_type = 0', 'account.1.sip_server.2.expires = 600'] : []),
    `static.auto_provision.server.url = ${a.provisionUrl}`,
    // on every start-up, ask the network who sets it up (plug-and-play), so a phone restarted after this PC's address
    // changed finds the new one; and allow "check-sync" restarts from Riyeser Link Office
    'static.auto_provision.pnp_enable = 1', 'static.auto_provision.power_on = 1', 'sip.notify_reboot_enable = 1', ''].join('\n');
}
function grandstreamConfig(a) {
  // P2312 secondary SIP server; P145 lets DHCP option 66 (a provisioning address from the router) take over
  const p = { P271: 1, P270: a.name, P47: `${a.server}:${a.sipPort}`, ...(a.backup ? { P2312: `${a.backup}:${a.sipPort}` } : {}), P35: a.ext, P36: a.ext, P34: a.password, P3: a.name, P32: 10, P237: a.provisionUrl, P212: 1, P145: 1 };
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<!-- Riyeser Link Office -->\n<gs_provision version="1">\n<mac>${a.mac}</mac>\n<config version="1">\n${
    Object.entries(p).map(([k, v]) => `<${k}>${xml(v)}</${k}>`).join('\n')}\n</config>\n</gs_provision>\n`;
}
function snomConfig(a) {
  const s = [['user_active', 'on'], ['user_realname', a.name], ['user_name', a.ext], ['user_pname', a.ext], ['user_pass', a.password], ['user_host', `${a.server}:${a.sipPort}`], ['user_expiry', '600']];
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- Riyeser Link Office -->\n<settings>\n<phone-settings e="2">\n${
    s.map(([k, v]) => `<${k} idx="1" perm="">${xml(v)}</${k}>`).join('\n')}\n<setting_server perm="">${xml(a.provisionUrl)}</setting_server>\n</phone-settings>\n</settings>\n`;
}
function polycomMaster(a) {
  return `<?xml version="1.0" standalone="yes"?>\n<!-- Riyeser Link Office -->\n<APPLICATION APP_FILE_PATH="" CONFIG_FILES="${a.mac}-riyeser.cfg" MISC_FILES="" LOG_FILE_DIRECTORY="" OVERRIDES_DIRECTORY="" CONTACTS_DIRECTORY="" LICENSE_DIRECTORY=""/>\n`;
}
function polycomConfig(a) {
  const r = { 'reg.1.displayName': a.name, 'reg.1.label': a.name, 'reg.1.address': a.ext, 'reg.1.auth.userId': a.ext, 'reg.1.auth.password': a.password,
    'reg.1.server.1.address': a.server, 'reg.1.server.1.port': a.sipPort, 'reg.1.server.1.transport': 'UDPOnly', 'reg.1.server.1.expires': 600,
    ...(a.backup ? { 'reg.1.server.2.address': a.backup, 'reg.1.server.2.port': a.sipPort, 'reg.1.server.2.transport': 'UDPOnly', 'reg.1.server.2.expires': 600 } : {}) };
  // check-sync from Riyeser Link Office restarts the phone, so it picks up a new address
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- Riyeser Link Office -->\n<polycomConfig>\n<reg ${Object.entries(r).map(([k, v]) => `${k}="${xml(v)}"`).join(' ')}/>\n<voIpProt voIpProt.SIP.specialEvent.checkSync.alwaysReboot="1"/>\n</polycomConfig>\n`;
}

/**
 * The SIP NOTIFY Event that asks this maker's phone to fetch its settings again. reboot: also restart, which is what's
 * needed after this PC's address changed (on start-up the phone asks plug-and-play who sets it up, and finds the new
 * address). Cisco/Linksys SPA phones (not set up by Riyeser Link Office, but often typed in by hand) use "resync".
 */
function resyncEvent(vendor, { reboot = false } = {}) {
  if (vendor === 'cisco') return reboot ? 'reboot' : 'resync';
  if (vendor === 'polycom') return 'check-sync';    // its settings say: always restart on check-sync
  return `check-sync;reboot=${reboot ? 'true' : 'false'}`;   // Yealink, Grandstream, Snom
}

/** Which settings file a path asks for: { vendor, mac, kind } or null. */
function route(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  const file = parts.pop() || ''; const dir = (parts[0] || '').toLowerCase();
  let m;
  if (/^y0{10}\d\d\.cfg$/i.test(file) || /^y0{12}\.cfg$/i.test(file)) return { vendor: 'yealink', kind: 'common' };
  if (/^0{12}(\.cfg|-riyeser\.cfg)$/i.test(file)) return null;   // Polycom's default file: nothing to give
  if ((m = /^cfg([0-9a-f]{12})(\.xml)?$/i.exec(file))) return { vendor: 'grandstream', mac: m[1].toLowerCase(), kind: 'phone' };
  if ((m = /^([0-9a-f]{12})-riyeser\.cfg$/i.exec(file))) return { vendor: 'polycom', mac: m[1].toLowerCase(), kind: 'phone' };
  if ((m = /^([0-9a-f]{12})\.cfg$/i.exec(file))) return dir === 'polycom' ? { vendor: 'polycom', mac: m[1].toLowerCase(), kind: 'master' } : { vendor: 'yealink', mac: m[1].toLowerCase(), kind: 'phone' };
  if ((m = /^([0-9a-f]{12})\.xml$/i.exec(file))) return { vendor: 'snom', mac: m[1].toLowerCase(), kind: 'phone' };
  return null;
}
/** A MAC address in a phone's User-Agent (Yealink and Grandstream send theirs). */
function macInAgent(ua) {
  const m = /(?:^|[^0-9a-f])((?:[0-9a-f]{2}:){5}[0-9a-f]{2}|[0-9a-f]{12})(?:[^0-9a-f]|$)/i.exec(String(ua || ''));
  return m ? normaliseMac(m[1]) : null;
}

class Provisioner extends EventEmitter {
  /**
   * opts: { store, directory, host, sipPort, httpPort = 5080, bind = '0.0.0.0', log, allowPublic,
   *         name: a name for this PC that the office network answers (or null), useName: give phones the name, not the address }
   */
  constructor(opts = {}) {
    super();
    Object.assign(this, { store: opts.store, directory: opts.directory, host: opts.host || '127.0.0.1', sipPort: opts.sipPort || 5060, name: opts.name || null, useName: !!opts.useName,
      httpPort: opts.httpPort == null ? 5080 : opts.httpPort, bind: opts.bind || '0.0.0.0', logFn: opts.log || (() => {}), allowPublic: !!opts.allowPublic });
    this.refused = new Map(); this.blocked = new Map(); this.lastPnp = new Map();
  }
  log(level, text) { try { this.logFn(level, text); } catch { /* never mind */ } }
  data() { const d = this.store.get('phone-devices', null) || {}; return { phones: d.phones || [], found: d.found || [], fetches: d.fetches || [] }; }
  save(d) { this.store.set('phone-devices', d); this.emit('change'); return d; }
  phones() { return this.data().phones; }
  found() { return this.data().found.filter((f) => !f.ignored); }
  /** The server address written into phones' settings, and the other one as their backup. */
  servers() { return this.useName && this.name ? { server: this.name, backup: this.host } : { server: this.host, backup: this.name || null }; }
  base(host = this.host) { return `http://${host}:${this.httpPort}`; }
  /** This PC has a new address (and maybe name): settings and plug-and-play answers carry them from now on. */
  setHost(host, { name, useName } = {}) { if (host) this.host = host; if (name !== undefined) this.name = name || null; if (useName !== undefined) this.useName = !!useName; this.emit('change'); }
  pnpUrl(vendor) {
    return { yealink: `${this.base()}/yealink/`, grandstream: `${this.base()}/grandstream`, snom: `${this.base()}/snom/{mac}.xml`, polycom: `${this.base()}/polycom/` }[vendor] || null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch { /* gone */ } });
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.httpPort, this.bind, () => { this.server.off('error', reject); resolve(); }); });
    this.httpPort = this.server.address().port;
    return this;
  }
  async stop() { if (this.server) await new Promise((r) => this.server.close(() => r())); this.server = null; }

  // ---------- phones the owner manages ----------
  /** A phone said hello (plug-and-play). Returns the address it should fetch its settings from. */
  onPnp(info) {
    const mac = normaliseMac(info.mac); if (!mac) return null;
    const vendor = vendorKey(info.vendor, mac);
    const last = this.lastPnp.get(mac) || 0;
    if (Date.now() - last < 3000) return this.pnpUrl(vendor);
    this.lastPnp.set(mac, Date.now());
    this.seen(mac, { vendor, model: info.model, ip: info.address });
    return this.pnpUrl(vendor);
  }
  /** Note a phone we heard from: an assigned one gets its address updated, an unknown one shows as "New phone found". */
  seen(mac, { vendor, model, ip }) {
    const d = this.data(); const now = new Date().toISOString();
    const p = d.phones.find((x) => x.mac === mac);
    if (p) { Object.assign(p, { ip: ip || p.ip, lastSeen: now, vendor: p.vendor || vendor, model: model || p.model }); return this.save(d); }
    let f = d.found.find((x) => x.mac === mac);
    if (!f) {
      f = { mac, vendor: vendor || '', model: model || '', ip: ip || '', firstSeen: now, lastSeen: now };
      d.found.push(f);
      this.log('info', `New phone found: ${VENDORS[vendor] || 'a phone'} ${model || ''} (${prettyMac(mac)}) at ${ip || 'unknown address'}.`);
      this.emit('found', f);
    } else Object.assign(f, { lastSeen: now, ip: ip || f.ip, vendor: f.vendor || vendor || '', model: model || f.model });
    return this.save(d);
  }
  assign(mac, ext, { vendor } = {}) {
    const m = normaliseMac(mac);
    if (!m) throw new Error('That isn\'t a MAC address. It\'s 12 letters and numbers, on a sticker under the phone (like 00:15:65:12:34:56).');
    if (!this.directory.person(ext)) throw new Error('Choose who this phone is for.');
    const d = this.data();
    const f = d.found.find((x) => x.mac === m);
    const was = d.phones.find((x) => x.mac === m);
    const p = { mac: m, ext: String(ext), vendor: vendor || (was && was.vendor) || (f && f.vendor) || vendorKey('', m), model: (was && was.model) || (f && f.model) || '',
      ip: (was && was.ip) || (f && f.ip) || '', addedAt: (was && was.addedAt) || new Date().toISOString(), lastSeen: (was && was.lastSeen) || (f && f.lastSeen) || null, lastFetch: (was && was.lastFetch) || null,
      label: (was && was.label) || '', location: (was && was.location) || '', note: (was && was.note) || '' };
    d.phones = [...d.phones.filter((x) => x.mac !== m), p];
    d.found = d.found.filter((x) => x.mac !== m);
    this.save(d);
    this.log('info', `Phone ${prettyMac(m)} is now extension ${ext} (${this.directory.nameOf(ext)}).`);
    this.emit('assigned', p);
    return p;
  }
  /** A desk phone's name ("Reception"), location (a branch) and a note (e.g. its S/N). Only for a phone given to someone. */
  label(mac, { name = '', location = '', note = '' } = {}) {
    const m = normaliseMac(mac); const d = this.data(); const p = d.phones.find((x) => x.mac === m);
    if (!p) throw new Error('That phone isn\'t given to anyone yet.');
    const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
    Object.assign(p, { label: clean(name, 40), location: clean(location, 60), note: clean(note, 60) });
    this.save(d);
    this.log('info', `Phone ${prettyMac(m)} is now called "${p.label || 'no name'}"${p.location ? ` at ${p.location}` : ''}.`);
    return p;
  }
  /** Stop giving settings to this phone. (It keeps what it already has until reset; change the password to lock it out.) */
  unassign(mac) { const m = normaliseMac(mac); const d = this.data(); d.phones = d.phones.filter((x) => x.mac !== m); this.save(d); return true; }
  ignore(mac) { const m = normaliseMac(mac); const d = this.data(); const f = d.found.find((x) => x.mac === m); if (f) f.ignored = true; this.save(d); return true; }

  // ---------- the web server ----------
  settingsFor(r) {
    const phone = this.phones().find((p) => p.mac === r.mac);
    const user = phone && this.directory.user(phone.ext);
    if (!user) return null;
    const vendor = r.vendor;
    const { server, backup } = this.servers();
    const base = this.base(server);
    const provisionUrl = vendor === 'snom' ? `${base}/snom/{mac}.xml` : vendor === 'grandstream' ? `${base}/grandstream` : `${base}/${vendor}/`;
    const a = { mac: r.mac, ext: user.ext, name: user.name, password: user.password, server, backup, sipPort: this.sipPort, provisionUrl };
    if (vendor === 'yealink') return { type: 'text/plain; charset=utf-8', body: yealinkConfig(a), phone };
    if (vendor === 'grandstream') return { type: 'application/xml; charset=utf-8', body: grandstreamConfig(a), phone };
    if (vendor === 'snom') return { type: 'application/xml; charset=utf-8', body: snomConfig(a), phone };
    if (vendor === 'polycom') return { type: 'application/xml; charset=utf-8', body: r.kind === 'master' ? polycomMaster(a) : polycomConfig(a), phone };
    return null;
  }
  refuse(ip) {
    const now = Date.now(); const list = (this.refused.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000); list.push(now); this.refused.set(ip, list);
    if (list.length >= 20 && !(this.blocked.get(ip) > now)) { this.blocked.set(ip, now + 60 * 60 * 1000); this.log('warn', `Blocked ${ip} from phone settings for an hour after ${list.length} refused requests.`); }
  }
  logFetch(entry) {
    const d = this.data(); d.fetches = [...d.fetches, { at: new Date().toISOString(), ...entry }].slice(-500);
    if (entry.ok) { const p = d.phones.find((x) => x.mac === entry.mac); if (p) Object.assign(p, { lastFetch: d.fetches[d.fetches.length - 1].at, ip: entry.ip, lastSeen: d.fetches[d.fetches.length - 1].at }); }
    this.save(d);
  }
  handle(req, res) {
    const ip = v4(req.socket.remoteAddress);
    const send = (code, body = '', type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', Server: 'Riyeser Link Office' }); res.end(body); };
    if (!this.allowPublic && !isPrivate(ip)) { this.log('warn', `Refused phone settings to ${ip}: not on the office network.`); return send(403, 'Office network only\n'); }
    if (this.blocked.get(ip) > Date.now()) return send(403, 'Blocked\n');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'GET only\n');
    let pathname = '/';
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(400, 'Bad address\n'); }
    const r = route(pathname);
    const file = pathname.slice(0, 120);
    if (!r) { this.logFetch({ ip, file, ok: false, why: 'not a settings file' }); return send(404, 'Not found\n'); }
    if (r.kind === 'common') return send(200, '#!version:1.0.0.1\n## Riyeser Link Office\n');
    const agentMac = macInAgent(req.headers['user-agent']);
    if (agentMac && agentMac !== r.mac) {
      this.refuse(ip); this.logFetch({ ip, mac: r.mac, file, ok: false, why: 'MAC in the request does not match the phone' });
      this.log('warn', `Refused phone settings for ${prettyMac(r.mac)} to ${ip}: the request came from a different phone (${prettyMac(agentMac)}).`);
      return send(403, 'Not this phone\n');
    }
    const s = this.settingsFor(r);
    if (!s) {
      this.refuse(ip); this.seen(r.mac, { vendor: r.vendor, model: '', ip });
      this.logFetch({ ip, mac: r.mac, file, ok: false, why: 'phone not assigned to anyone yet' });
      return send(403, 'This phone has not been given to anyone yet. Open Riyeser Link Office on the office PC.\n');
    }
    this.logFetch({ ip, mac: r.mac, file, ok: true, ext: s.phone.ext });
    this.log('info', `Sent settings to phone ${prettyMac(r.mac)} (extension ${s.phone.ext}) at ${ip}.`);
    return send(200, req.method === 'HEAD' ? '' : s.body, s.type);
  }
}

module.exports = { Provisioner, normaliseMac, prettyMac, vendorKey, route, resyncEvent, macInAgent, yealinkConfig, grandstreamConfig, snomConfig, polycomConfig, polycomMaster, VENDORS };
