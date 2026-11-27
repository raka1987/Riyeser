// A name for this PC that desk phones can use instead of its address, so they keep finding it after the router gives
// the PC a new address. Many office routers put each device's name in their own DNS when they hand out addresses
// (OFFICE-PC.lan, office-pc.home, office-pc.fritz.box…). Desk phones ask the router's DNS, so such a name follows the
// PC automatically. It's only used once checked: asked of the network's DNS servers directly (not Windows' own
// LLMNR/NetBIOS guesses, which phones can't use), and it must give exactly this PC's address now.
// riyeser-office.local (mdns.js) is the other name: it works for computers, phones and apps that look up .local
// names (multicast DNS), which most desk phones don't, so it isn't put into desk phones' settings by itself.
const dns = require('dns');

const SUFFIXES = ['lan', 'home', 'home.arpa', 'localdomain', 'local.lan', 'fritz.box', 'router', 'internal'];
const clean = (s) => String(s || '').trim().toLowerCase().replace(/\.$/, '');
const validName = (s) => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(clean(s));

/** The names to try for this PC, most likely first. suffixes: the network's own DNS suffix(es) (from Windows), if any. */
function candidates(hostname, suffixes = []) {
  const h = clean(hostname).split('.')[0];
  if (!h || !validName(h)) return [];
  const sfx = [...new Set([...suffixes.map(clean).filter((x) => x && validName(x) && x !== 'local'), ...SUFFIXES])];
  return [...new Set([...(clean(hostname).includes('.') ? [clean(hostname)] : []), ...sfx.map((x) => `${h}.${x}`)])];   // never the bare name: phones may not add the network's suffix
}

/**
 * Find a name the network's DNS gives as this PC's address. -> the name, or null.
 * opts: { hostname, suffixes, address, resolve4: (name) => Promise<[ip]> (tests), timeout = 1500, servers }
 */
async function findRouterName({ hostname, suffixes = [], address, resolve4, timeout = 1500, servers } = {}) {
  if (!address || address === '127.0.0.1') return null;
  let lookup = resolve4;
  if (!lookup) {
    const r = new dns.promises.Resolver({ timeout, tries: 1 });
    if (servers && servers.length) { try { r.setServers(servers); } catch { /* the system's */ } }
    lookup = (n) => r.resolve4(n);
  }
  for (const name of candidates(hostname, suffixes)) {
    try {
      const ips = await Promise.race([lookup(name), new Promise((_r, no) => setTimeout(() => no(new Error('timeout')), timeout + 200).unref())]);
      if (Array.isArray(ips) && ips.length && ips.every((ip) => ip === address)) return name;
    } catch { /* not that one */ }
  }
  return null;
}

module.exports = { findRouterName, candidates, validName, SUFFIXES };
