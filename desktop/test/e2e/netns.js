// Virtual networks for the relay's end-to-end tests (Linux network namespaces, needs root): an "internet"
// (198.51.100.0/24 on one bridge) with machines on it, and offices that each sit behind their own NAT router
// (iptables masquerade with random ports, nothing allowed in unless it answers something that went out), every
// office on the same 192.168.1.0/24, as is usual.
const { execSync } = require('child_process');

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** Can we make namespaces here? -> null, or why not */
function canRun(prefix = 'ryprobe') {
  if (process.platform !== 'linux' || (process.getuid && process.getuid() !== 0) || process.env.RIYESER_SKIP_NETNS) return 'needs Linux and root';
  try { execSync('ip -V', { stdio: 'ignore' }); execSync('iptables -V', { stdio: 'ignore' }); } catch { return 'needs ip and iptables'; }
  try { execSync(`ip netns add ${prefix}x && ip netns del ${prefix}x`, { stdio: 'ignore' }); } catch { return 'network namespaces are not allowed here'; }
  return null;
}

/**
 * net(P, { hosts: { name: publicIp }, offices: { name: { wan, lan: ['192.168.1.10', …] } } })
 * Namespaces are `${P}${name}` (offices: `${P}nat${name}` and `${P}site${name}`). -> { ns(name), exec(name, cmd), down() }
 */
function net(P, { hosts = {}, offices = {} } = {}) {
  const names = ['inet', ...Object.keys(hosts), ...Object.keys(offices).flatMap((o) => [`nat${o}`, `site${o}`])];
  const ns = (n) => `${P}${n}`;
  const exec = (n, cmd) => sh(`ip netns exec ${ns(n)} ${cmd}`);
  const down = () => { for (const n of names) { try { sh(`ip netns del ${ns(n)}`); } catch { /* gone */ } } };
  down();
  for (const n of names) { sh(`ip netns add ${ns(n)}`); sh(`ip -n ${ns(n)} link set lo up`); }
  sh(`ip -n ${ns('inet')} link add br0 type bridge && ip -n ${ns('inet')} link set br0 up`);
  const wan = { ...hosts, ...Object.fromEntries(Object.entries(offices).map(([o, c]) => [`nat${o}`, c.wan])) };
  let i = 0;
  for (const [n, ip] of Object.entries(wan)) {
    const a = `${P}w${i}o`; const b = `${P}w${i}i`; i++;
    sh(`ip link add ${a} type veth peer name ${b}`);
    sh(`ip link set ${a} netns ${ns('inet')} && ip -n ${ns('inet')} link set ${a} master br0 up`);
    sh(`ip link set ${b} netns ${ns(n)} && ip -n ${ns(n)} link set ${b} name eth0 && ip -n ${ns(n)} addr add ${ip}/24 dev eth0 && ip -n ${ns(n)} link set eth0 up`);
  }
  for (const [o, c] of Object.entries(offices)) {
    const a = `${P}l${i}o`; const b = `${P}l${i}i`; i++;
    const nat = `nat${o}`; const site = `site${o}`;
    sh(`ip link add ${a} type veth peer name ${b}`);
    sh(`ip link set ${a} netns ${ns(nat)} && ip -n ${ns(nat)} link set ${a} name lan0 && ip -n ${ns(nat)} addr add 192.168.1.1/24 dev lan0 && ip -n ${ns(nat)} link set lan0 up`);
    sh(`ip link set ${b} netns ${ns(site)} && ip -n ${ns(site)} link set ${b} name eth0 && ip -n ${ns(site)} link set eth0 up`);
    for (const addr of c.lan || ['192.168.1.10']) sh(`ip -n ${ns(site)} addr add ${addr}/24 dev eth0`);
    sh(`ip -n ${ns(site)} route add default via 192.168.1.1`);
    exec(nat, 'sysctl -qw net.ipv4.ip_forward=1');
    exec(nat, 'sysctl -qw net.ipv4.conf.eth0.promote_secondaries=1');
    try { exec(nat, 'iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE --random-fully'); } catch { exec(nat, 'iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE --random'); }
    exec(nat, 'iptables -P FORWARD DROP');
    exec(nat, 'iptables -A FORWARD -i lan0 -o eth0 -j ACCEPT');
    exec(nat, 'iptables -A FORWARD -i eth0 -o lan0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
    exec(nat, 'iptables -A INPUT -i eth0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
    exec(nat, 'iptables -A INPUT -i eth0 -j DROP');
  }
  return { ns, exec, down };
}

module.exports = { canRun, net, sh };
