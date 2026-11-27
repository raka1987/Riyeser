// Network helpers for Riyeser Link Office: which addresses count as "this office", this PC's address, and
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

// Adapters that aren't the office network: virtual machines (Hyper-V, VirtualBox, VMware), WSL, Docker, VPNs and
// tunnels, Bluetooth and capture drivers. Matched on the adapter's name and, on Windows, its description.
const VIRTUAL = /vethernet|virtualbox|vboxnet|vmware|vmnet|hyper-v|wsl|docker|br-[0-9a-f]|virbr|veth|loopback|tailscale|zerotier|wireguard|nordlynx|openvpn|vpn|anyconnect|globalprotect|pangp|fortinet|forticlient|hamachi|radmin|tap-|\btap\d|\btun|utun|ppp|teredo|isatap|6to4|bluetooth|npcap|pseudo/i;
const isVirtualName = (name, description = '') => VIRTUAL.test(String(name || '')) || VIRTUAL.test(String(description || ''));

/**
 * This PC's IPv4 addresses on its adapters: [{ name, address, netmask, cidr, mac, virtual }], the most likely office one
 * first. Loopback and link-local (169.254, "no DHCP answer") addresses are left out; so are public and CGNAT (100.64/10,
 * e.g. Tailscale) addresses, which aren't an office network. hints: { describe: { name: description } } from Windows.
 */
function localAddresses(ifaces = os.networkInterfaces(), hints = {}) {
  const out = [];
  const describe = hints.describe || {};
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      if (!isPrivate(a.address) || a.address.startsWith('169.254.') || a.address.startsWith('127.')) continue;
      out.push({ name, address: a.address, netmask: a.netmask, cidr: a.cidr || null, mac: a.mac && a.mac !== '00:00:00:00:00:00' ? a.mac.toUpperCase() : '', virtual: isVirtualName(name, describe[name]) });
    }
  }
  const gw = new Set(hints.gateways || []);
  // real adapters first; then the one with the router (default gateway); then 192.168 > 10 > 172.16 (Docker/WSL live there)
  const rank = (a) => (a.virtual ? 100 : 0) + (gw.size && !gw.has(a.address) ? 10 : 0) + (a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2);
  return out.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
}
/** The address phones should use to reach this PC, or 127.0.0.1 when there's no network. */
const primaryAddress = (ifaces, hints) => pickAdapter(ifaces, '', hints).address;
/**
 * The adapter phones should use. In order:
 *  1. the one the owner chose in settings (by adapter name, so it survives a new address), even a virtual one;
 *  2. the address in use now, if it's still on this PC (a second address appearing, or a VPN connecting, doesn't move
 *     the phones);
 *  3. the adapter in use now (same name), with its new address;
 *  4. the most likely office adapter (real, with the router, 192.168 first).
 * Virtual adapters (Hyper-V, WSL, VPNs…) are never picked by themselves, unless one is the only way to the router.
 * hints: { last: { name, address }, gateways: [address], describe: { name: description } }
 * -> { name, address, mac, netmask, chosen } (address 127.0.0.1 when there's no office network)
 */
function pickAdapter(ifaces, preferredName, hints = {}) {
  const list = localAddresses(ifaces, hints);
  const real = list.filter((a) => !a.virtual);
  const last = hints.last || {};
  const chosen = preferredName && (list.find((a) => a.name === preferredName && a.address === last.address) || list.find((a) => a.name === preferredName));
  const a = chosen || (last.address && real.find((x) => x.address === last.address)) || (last.name && real.find((x) => x.name === last.name)) || real[0]
    // a Hyper-V "external" switch moves the real network card's address onto a vEthernet adapter: use it if it has the router
    || list.find((x) => (hints.gateways || []).includes(x.address));
  return a ? { name: a.name, address: a.address, mac: a.mac, netmask: a.netmask, chosen: !!chosen } : { name: '', address: '127.0.0.1', mac: '', netmask: '', chosen: false };
}
/** A short fingerprint of this PC's addresses, to notice when anything changes. */
const addressSignature = (ifaces) => Object.entries(ifaces || {}).flatMap(([n, l]) => (l || []).filter((a) => !a.internal && (a.family === 'IPv4' || a.family === 4)).map((a) => `${n}=${a.address}/${a.netmask}`)).sort().join(',');

/** Is this address on the same subnet as one of this PC's adapters? */
function sameSubnet(ip, ifaces) {
  const a = toInt(v4(ip)); if (a == null) return false;
  if (v4(ip).startsWith('127.')) return true;
  return localAddresses(ifaces).some((l) => {
    const m = toInt(l.netmask); const b = toInt(l.address);
    return m != null && b != null && ((a & m) >>> 0) === ((b & m) >>> 0);
  });
}

module.exports = { isPrivate, inCidr, localAddresses, primaryAddress, pickAdapter, sameSubnet, addressSignature, isVirtualName, toInt, PRIVATE, v4 };
