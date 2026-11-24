// Network helpers for Riyeser Link: which addresses count as "this office", this PC's address, and
// whether a phone is on the same network (subnet) as this PC.
const os = require('os');

const toInt = (ip) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};
const v4 = (ip) => String(ip || '').replace(/^::ffff:/i, '');
function inCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const a = toInt(v4(ip)); const b = toInt(base); const n = Number(bits);
  if (a == null || b == null) return false;
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
// Office networks (RFC 1918), link-local (phones with no DHCP) and this PC itself.
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8'];
const isPrivate = (ip) => PRIVATE.some((c) => inCidr(ip, c));

// Adapters that aren't the office network (virtual machines, VPNs, WSL, Docker).
const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier|vpn|tap-|tun|bluetooth|npcap/i;

/** This PC's IPv4 addresses on real adapters: [{ name, address, netmask, cidr }], the most likely office one first. */
function localAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      if (!isPrivate(a.address) || a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address, netmask: a.netmask, cidr: a.cidr || null, mac: a.mac && a.mac !== '00:00:00:00:00:00' ? a.mac.toUpperCase() : '', virtual: VIRTUAL.test(name) });
    }
  }
  const rank = (a) => (a.virtual ? 10 : 0) + (a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}
/** The address phones should use to reach this PC, or 127.0.0.1 when there's no network. */
const primaryAddress = (ifaces) => (localAddresses(ifaces)[0] || {}).address || '127.0.0.1';
/**
 * The adapter phones should use: the one the owner chose in settings (by adapter name, so it survives a new address),
 * else the most likely office one. -> { name, address, mac, chosen } (address 127.0.0.1 when there's no network)
 */
function pickAdapter(ifaces, preferredName) {
  const list = localAddresses(ifaces);
  const chosen = preferredName && list.find((a) => a.name === preferredName);
  const a = chosen || list[0];
  return a ? { name: a.name, address: a.address, mac: a.mac, netmask: a.netmask, chosen: !!chosen } : { name: '', address: '127.0.0.1', mac: '', chosen: false };
}

/** Is this address on the same subnet as one of this PC's adapters? */
function sameSubnet(ip, ifaces) {
  const a = toInt(v4(ip)); if (a == null) return false;
  if (v4(ip).startsWith('127.')) return true;
  return localAddresses(ifaces).some((l) => {
    const m = toInt(l.netmask); const b = toInt(l.address);
    return m != null && b != null && ((a & m) >>> 0) === ((b & m) >>> 0);
  });
}

module.exports = { isPrivate, inCidr, localAddresses, primaryAddress, pickAdapter, sameSubnet, PRIVATE, v4 };
