// Own-hardware mode (the relay on a PC or mini PC in the office): ask the office router to forward the relay's
// ports to this machine by itself, where the router allows it — NAT-PMP (RFC 6886; Apple, many TP-Link/ASUS/
// MikroTik/OpenWrt routers) first, then UPnP IGD (most home and small-office routers). Mappings are renewed every
// half lifetime and removed when the relay stops. If the router allows neither, the status says so and the owner
// sets up port forwarding by hand (README: "Port forwarding, router by router").
const dgram = require('dgram');
const http = require('http');
const { gateway } = require('./publicip');

const pmpReq = (op, inPort, exPort, life) => { const b = Buffer.alloc(12); b[0] = 0; b[1] = op; b.writeUInt16BE(inPort, 4); b.writeUInt16BE(exPort, 6); b.writeUInt32BE(life, 8); return b; };

/** One NAT-PMP request. -> response Buffer or null */
function pmp(gw, msg, { port = 5351, timeout = 1000, tries = 2 } = {}) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4'); let n = 0; let done = false;
    const end = (v) => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch { /* closed */ } resolve(v); };
    const send = () => { n++; s.send(msg, port, gw, () => {}); };
    let t = setTimeout(function again() { if (n >= tries) return end(null); send(); t = setTimeout(again, timeout); }, timeout);
    s.on('message', (m) => { if (m.length >= 4 && m[1] === (msg[1] | 128)) end(m); });
    s.on('error', () => end(null));
    s.bind(0, () => send());
  });
}

/** Find a UPnP Internet Gateway Device: -> { control, service } or null */
function ssdp({ target = '239.255.255.250', port = 1900, timeout = 2500 } = {}) {
  const st = ['urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4'); let done = false;
    const end = (v) => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch { /* closed */ } resolve(v); };
    const t = setTimeout(() => end(null), timeout);
    s.on('message', (m) => { const loc = /^location:\s*(\S+)/im.exec(m.toString()); if (loc) end(loc[1]); });
    s.on('error', () => end(null));
    s.bind(0, () => { for (const x of st) s.send(Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${x}\r\n\r\n`), port, target); });
  }).then(async (location) => {
    if (!location) return null;
    const xml = await get(location).catch(() => '');
    for (const svc of ['WANIPConnection:2', 'WANIPConnection:1', 'WANPPPConnection:1']) {
      const re = new RegExp(`<serviceType>urn:schemas-upnp-org:service:${svc}</serviceType>[\\s\\S]*?<controlURL>([^<]+)</controlURL>`, 'i');
      const m = re.exec(xml);
      if (m) return { control: new URL(m[1], location).toString(), service: `urn:schemas-upnp-org:service:${svc}` };
    }
    return null;
  });
}
function get(url) { return new Promise((res, rej) => { const r = http.get(url, { timeout: 3000 }, (x) => { let b = ''; x.on('data', (c) => { b += c; if (b.length > 200000) r.destroy(); }); x.on('end', () => res(b)); }); r.on('error', rej); r.on('timeout', () => r.destroy(new Error('timeout'))); }); }
function soap(igd, action, args) {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${igd.service}">${Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const u = new URL(igd.control);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', timeout: 4000,
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${igd.service}#${action}"`, 'Content-Length': Buffer.byteLength(body) } }, (x) => {
      let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => (x.statusCode === 200 ? resolve(b) : reject(new Error(`the router said ${x.statusCode}${/<errorDescription>([^<]*)/.exec(b) ? `: ${/<errorDescription>([^<]*)/.exec(b)[1]}` : ''}`))));
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('the router didn\'t answer'))); r.end(body);
  });
}

class PortMapper {
  /** opts: { ports: [{ proto: 'tcp' | 'udp', port }], localIp, lifetime = 3600, gw, ssdpTarget, pmpPort, log } */
  constructor(opts = {}) {
    this.ports = opts.ports || []; this.localIp = opts.localIp; this.lifetime = opts.lifetime || 3600;
    this.gw = opts.gw || null; this.ssdpTarget = opts.ssdpTarget; this.ssdpPort = opts.ssdpPort; this.pmpPort = opts.pmpPort;
    this.logFn = opts.log || (() => {});
    this.state = { method: null, mapped: 0, failed: 0, error: null, externalIp: null, at: null };
  }
  log(l, t) { try { this.logFn(l, t); } catch { /* never mind */ } }
  async start() { await this.map(); this.timer = setInterval(() => this.map().catch(() => {}), (this.lifetime * 1000) / 2); this.timer.unref && this.timer.unref(); return this.state; }
  async map() {
    const gw = this.gw || gateway();
    let mapped = 0; let failed = 0;
    // NAT-PMP
    const probe = gw ? await pmp(gw, Buffer.from([0, 0]), { port: this.pmpPort }) : null;
    if (probe && probe.readUInt16BE(2) === 0) {
      for (const p of this.ports) {
        const r = await pmp(gw, pmpReq(p.proto === 'udp' ? 1 : 2, p.port, p.port, this.lifetime), { port: this.pmpPort });
        if (r && r.readUInt16BE(2) === 0) mapped++; else failed++;
      }
      this.state = { method: 'NAT-PMP', mapped, failed, error: failed ? `${failed} port(s) were refused by the router` : null, externalIp: [probe[8], probe[9], probe[10], probe[11]].join('.'), at: new Date().toISOString() };
    } else {
      const igd = await ssdp({ target: this.ssdpTarget, port: this.ssdpPort }).catch(() => null);
      if (!igd) { this.state = { method: null, mapped: 0, failed: this.ports.length, error: 'The router doesn\'t allow automatic port forwarding (no NAT-PMP or UPnP). Set up port forwarding by hand.', externalIp: null, at: new Date().toISOString() }; this.log('warn', this.state.error); return this.state; }
      this.igd = igd; let err = null;
      for (const p of this.ports) {
        try {
          await soap(igd, 'AddPortMapping', { NewRemoteHost: '', NewExternalPort: p.port, NewProtocol: p.proto.toUpperCase(), NewInternalPort: p.port, NewInternalClient: this.localIp, NewEnabled: 1, NewPortMappingDescription: 'Riyeser relay', NewLeaseDuration: this.lifetime });
          mapped++;
        } catch (e) { failed++; err = e.message; }
      }
      let ext = null; try { ext = (/<NewExternalIPAddress>([^<]+)</.exec(await soap(igd, 'GetExternalIPAddress', {})) || [])[1] || null; } catch { /* fine */ }
      this.state = { method: 'UPnP', mapped, failed, error: failed ? `${failed} port(s) were refused by the router (${err})` : null, externalIp: ext, at: new Date().toISOString() };
    }
    this.log(failed ? 'warn' : 'info', `Router port forwarding (${this.state.method}): ${mapped} port(s) forwarded${failed ? `, ${failed} refused` : ''}.`);
    return this.state;
  }
  async stop() {
    clearInterval(this.timer);
    const gw = this.gw || gateway();
    if (this.state.method === 'NAT-PMP' && gw) for (const p of this.ports) await pmp(gw, pmpReq(p.proto === 'udp' ? 1 : 2, p.port, 0, 0), { port: this.pmpPort, tries: 1, timeout: 300 });
    if (this.state.method === 'UPnP' && this.igd) for (const p of this.ports) await soap(this.igd, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: p.port, NewProtocol: p.proto.toUpperCase() }).catch(() => {});
  }
}

/** The ports the relay needs forwarded, from its config. Ranges are listed port by port (keep them small at home). */
function relayPorts(cfg, ports = {}) {
  const out = [];
  const add = (proto, port) => { if (port) out.push({ proto, port: Number(port) }); };
  add('tcp', ports.https || cfg.httpsPort); add('tcp', ports.sipTls || cfg.sipTlsPort);
  if (cfg.turn && cfg.turn.enabled) { add('udp', cfg.turn.port); add('tcp', cfg.turn.port); for (let p = cfg.turn.min; p <= cfg.turn.max; p++) add('udp', p); }
  add('udp', ports.probe || cfg.probePort);
  for (let p = cfg.mediaMin; p <= cfg.mediaMax; p++) add('udp', p);
  return out;
}

module.exports = { PortMapper, relayPorts, pmp, ssdp, soap };
