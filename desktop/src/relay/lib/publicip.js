// The relay's own public IPv4 address, found without any "what is my IP" service:
//   1. RELAY_PUBLIC_IP (set by hand, or by setup.sh on a VPS)
//   2. a public address on one of this machine's network cards (a VPS usually has one)
//   3. the router, over NAT-PMP (RFC 6886: most home and office routers answer on port 5351) — own-hardware mode
//   4. the address the database saw our relay_sync come from (cloud.js passes it in)
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');

const isPrivate = (ip) => /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/.test(ip);
const isV4 = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || '')) && String(ip).split('.').every((n) => Number(n) <= 255);
const isPublic = (ip) => isV4(ip) && !isPrivate(ip) && !/^(22[4-9]|2[3-5]\d)\./.test(ip);

function fromInterfaces(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces || {})) for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isPublic(a.address)) return a.address;
  return null;
}
/** The default gateway from /proc/net/route (Linux). */
function gateway(text) {
  try { text = text == null ? fs.readFileSync('/proc/net/route', 'utf8') : text; } catch { return null; }
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] === '00000000' && f[2] && f[2] !== '00000000') { const n = parseInt(f[2], 16); return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.'); }
  }
  return null;
}
/** Ask the router for its outside address over NAT-PMP. -> ip | null */
function natPmp(gw = gateway(), { port = 5351, timeout = 1500 } = {}) {
  if (!gw) return Promise.resolve(null);
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4'); let done = false;
    const end = (v) => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch { /* closed */ } resolve(v); };
    const t = setTimeout(() => end(null), timeout);
    s.on('error', () => end(null));
    s.on('message', (m) => { if (m.length >= 12 && m[0] === 0 && m[1] === 128 && m.readUInt16BE(2) === 0) { const ip = [m[8], m[9], m[10], m[11]].join('.'); end(isPublic(ip) ? ip : null); } });
    s.send(Buffer.from([0, 0]), port, gw, (e) => { if (e) end(null); });
  });
}
/** -> { ip, how } */
async function findPublicIp({ configured, seenBySync, ifaces, pmp = natPmp } = {}) {
  if (isV4(configured)) return { ip: configured, how: 'set by hand' };
  const nic = fromInterfaces(ifaces); if (nic) return { ip: nic, how: 'network card' };
  const r = await pmp().catch(() => null); if (r) return { ip: r, how: 'router (NAT-PMP)' };
  if (isPublic(seenBySync)) return { ip: seenBySync, how: 'as seen by Riyeser online' };
  return { ip: null, how: 'unknown' };
}

module.exports = { findPublicIp, fromInterfaces, natPmp, gateway, isPublic, isPrivate, isV4 };
