// Riyeser Link Office 1.3.1: the guided checklist for Settings → Connect your branches. Plain functions with no window,
// Electron or network, so the same file runs in the main process (for the report to the website), in the window, and
// in the tests. Each step is { k, group ('relay' | 'site'), title, s ('ok' | 'warn' | 'fail' | 'todo'), t (one plain
// line), fix: { act, label } (a one-click fix) or null, how: [steps in words] or null, muted }.
//   On the relay PC: pc, service, address, ports, name (only with your own web name), secure, registered, switched
//   On every site:   internet, reach, auth, sound, exts, test
// build(facts) -> { unused, steps, summary: { cls, text, first, problems }, sites }
// facts: { relay (RelayLink.status()), cloud ({ status }), host ({ installed, health, check, pc, sleepNote, adapter, dns }),
//          reach ({ dns, tcp, tls } for the relay in use or the first one), muted: [keys] }
(function (root) {
  const TITLES = {
    pc: 'This PC can be the relay', service: 'Relay service running', address: 'Address reserved in the router', ports: 'Router ports open from the internet',
    name: 'Web name points here', secure: 'Secure connection', registered: 'Registered with your business', switched: 'Relay switched on for the business',
    internet: 'Internet', reach: 'Can reach the relay', auth: 'Signed in and allowed', sound: 'Sound can get through', exts: 'Extensions announced', test: 'Test call',
  };
  const ORDER = ['pc', 'service', 'address', 'ports', 'name', 'secure', 'registered', 'switched', 'internet', 'reach', 'auth', 'sound', 'exts', 'test'];
  // Cloudflare's proxy addresses (IPv4): a name proxied through Cloudflare ("orange cloud") resolves into these
  const CLOUDFLARE = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
  const ip2n = (ip) => String(ip).split('.').reduce((a, x) => a * 256 + (Number(x) & 255), 0);
  const inCidr = (ip, cidr) => { const [base, bits] = cidr.split('/'); const size = 2 ** (32 - Number(bits)); return Math.floor(ip2n(ip) / size) === Math.floor(ip2n(base) / size); };
  const isCloudflare = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || '')) && CLOUDFLARE.some((c) => inCidr(ip, c));
  /** Who serves a domain's DNS, from its NS records -> 'cloudflare' | 'namecheap' | 'other' | null */
  const dnsHost = (ns) => { const l = [].concat(ns || []).map((x) => String(x).toLowerCase()); if (!l.length) return null; if (l.some((x) => /\.ns\.cloudflare\.com\.?$/.test(x))) return 'cloudflare'; if (l.some((x) => /registrar-servers\.com\.?$/.test(x))) return 'namecheap'; return 'other'; };
  const portList = (rs) => rs.map((r) => `${r.port}/${String(r.proto).toUpperCase()}`).join(', ');

  /** Per-router port forwarding, in words (only when automatic forwarding didn't work). */
  function forwardSteps(ip, ports) {
    return [`Open your router's page (usually http://${ip ? ip.replace(/\.\d+$/, '.1') : '192.168.1.1'}) and sign in (the password is often on a sticker under the router).`,
      'Find "Port forwarding" (also called "Virtual server", "NAT" or "Applications & gaming"; on TP-Link: Advanced → NAT Forwarding; on ASUS: WAN → Virtual Server; on Huawei and ZTE: Forward Rules or Security → Port Mapping).',
      `Add a rule for each of these, all to this PC (${ip || 'this PC\'s address'}): ${ports}.`,
      'Save, then press Check again here.'];
  }

  function relaySteps(f) {
    const h = f.host || {}; const hp = h.health || null; const ck = h.check || null; const pc = h.pc || {}; const r = f.relay || {};
    const out = [];
    // 1. this PC can be the relay
    {
      let s = 'ok'; let t = 'Windows 10 or 11, plugged in, with room to spare.'; let fix = null;
      if (pc.windows === 'old') { s = 'fail'; t = 'The relay needs Windows 10 or 11.'; }
      else if (pc.admin === false) { s = 'fail'; t = 'Setting up the relay needs a Windows administrator. Sign in to Windows as one (or ask your IT person) to set it up.'; }
      else if (pc.diskFreeGb != null && pc.diskFreeGb < 1) { s = 'warn'; t = `Only ${pc.diskFreeGb} GB free on the disk. Free up some space (the relay keeps its logs here).`; }
      else if (pc.onBattery) { s = 'warn'; t = 'This PC is running on battery. Keep it plugged in: if it goes off, other sites can\'t call.'; }
      else if (h.sleepNote) { s = 'warn'; t = 'Windows may put this PC to sleep. While it sleeps, your sites can\'t call each other.'; fix = { act: 'keepawake', label: 'Keep this PC awake' }; }
      out.push({ k: 'pc', s, t, fix });
    }
    // 2. the service
    if (!h.installed) out.push({ k: 'service', s: 'fail', t: 'The relay isn\'t set up on this PC.', fix: { act: 'relayhost', label: 'Set it up' } });
    else if (!hp) out.push({ k: 'service', s: 'fail', t: 'The relay is installed but not answering. Restart this PC; if that doesn\'t help, set it up again.', fix: { act: 'relayhost', label: 'Set it up again' } });
    else out.push({ k: 'service', s: 'ok', t: `Running${hp.version ? ` (version ${hp.version})` : ''}${hp.uptime != null ? `, for ${hp.uptime >= 3600 ? `${Math.round(hp.uptime / 3600)} h` : `${Math.max(1, Math.round(hp.uptime / 60))} min`}` : ''}.` });
    // 3. the address in the office
    const a = h.adapter || null;
    if (!a) out.push({ k: 'address', s: 'todo', t: 'Not checked yet.' });
    else if (a.dhcp === false) out.push({ k: 'address', s: 'ok', t: `This PC keeps the address ${a.address}.` });
    else out.push({ k: 'address', s: 'warn', t: `This PC gets its address (${a.address}) from the router, which may change it. Reserve it in the router, so the router keeps forwarding to this PC.`, fix: { act: 'reserve', label: 'Reserve this address' } });
    // 4. ports from the internet: automatic first (UPnP / NAT-PMP); by hand only when that didn't work
    if (hp) {
      const pm = (ck && ck.port_map) || hp.port_map || {}; const o = ck && ck.outside;
      const closed = o && Array.isArray(o.results) ? o.results.filter((x) => !x.open) : [];
      const auto = pm.method && pm.mapped > 0 && !pm.failed;
      if (o && o.ok === true) out.push({ k: 'ports', s: 'ok', t: `Open from the internet (tested from the relay ${o.via}${auto ? `; the router forwards them automatically, ${pm.method}` : ''}).` });
      else if (closed.length) out.push({ k: 'ports', s: 'fail', t: `Closed from the internet: ${portList(closed)}.${auto ? ' The router said yes to forwarding them, but they still don\'t get through.' : ''}`,
        fix: pm.off ? null : { act: 'retryupnp', label: 'Try automatic forwarding again' }, how: pm.method && !pm.failed ? null : forwardSteps(a && a.address, portList(closed)) });
      else if (pm.method === null && !pm.off && pm.error) out.push({ k: 'ports', s: (hp.sites || 0) > 0 ? 'ok' : 'fail', t: (hp.sites || 0) > 0 ? 'Sites connect to it from the internet (forwarded by hand).' : 'Your router doesn\'t allow automatic port forwarding, so it needs setting once by hand.',
        fix: { act: 'retryupnp', label: 'Try automatic forwarding again' }, how: (hp.sites || 0) > 0 ? null : forwardSteps(a && a.address, portList(((ck && ck.ports) ? outsideList(ck) : []))) });
      else if (auto) out.push({ k: 'ports', s: (hp.sites || 0) > 0 ? 'ok' : 'todo', t: `The router forwards the relay's ports automatically (${pm.method}).${(hp.sites || 0) > 0 ? ' Sites connect from the internet.' : ' Checked from outside once another relay or a site connects.'}`, fix: { act: 'checkoutside', label: 'Test from outside' } });
      else out.push({ k: 'ports', s: (hp.sites || 0) > 0 ? 'ok' : 'todo', t: (hp.sites || 0) > 0 ? 'Sites connect to it from the internet.' : 'Not tested from outside yet.', fix: { act: 'checkoutside', label: 'Test from outside' } });
    } else out.push({ k: 'ports', s: 'todo', t: 'Checked once the relay is running.' });
    // 5. the web name: only with "Advanced: use your own web name"
    if (hp && hp.dns_name) {
      const d = h.dns || {}; const ip = hp.public_ip;
      let s = 'ok'; let t = `${hp.dns_name} points at this office (${ip}).`; let how = null;
      if (d.error) { s = 'fail'; t = `${hp.dns_name} isn't found (${d.error}).`; how = d.host === 'cloudflare' ? ['On Cloudflare: DNS → Records → Add record: type A, name relay, IPv4 this office\'s address' + (ip ? ` (${ip})` : '') + ', Proxy status: DNS only (grey cloud).'] : null; }
      else if ((d.ips || []).some(isCloudflare)) { s = 'fail'; t = `${hp.dns_name} is proxied through Cloudflare (orange cloud). Calls can't go through Cloudflare's proxy.`; how = ['On Cloudflare: DNS → Records → the relay\'s A record → Edit → Proxy status: DNS only (grey cloud) → Save.']; }
      else if (ip && d.ips && d.ips.length && !d.ips.includes(ip)) { s = 'fail'; t = `${hp.dns_name} points at ${d.ips.join(', ')}, not this office (${ip}).`; }
      else if (hp.dns && hp.dns.ok === false) { s = 'warn'; t = `The relay couldn't update ${hp.dns_name}: ${hp.dns.error}`; }
      else if (!d.ips) { s = 'todo'; t = 'Not checked yet.'; }
      out.push({ k: 'name', s, t, how, fix: s === 'ok' || s === 'todo' ? null : { act: 'advanced', label: 'Web name settings' } });
    }
    // 6. the certificate Riyeser online lists for it
    if (hp) {
      const mine = (r.relays || []).find((x) => x.id === hp.relay);
      if (!hp.cert_sha256) out.push({ k: 'secure', s: 'fail', t: 'The relay has no certificate yet. Set it up again.', fix: { act: 'relayhost', label: 'Set it up again' } });
      else if (!mine || !mine.pin) out.push({ k: 'secure', s: 'todo', t: 'Riyeser online lists its certificate within a minute of it checking in.' });
      else if (String(mine.pin).toUpperCase() === String(hp.cert_sha256).toUpperCase()) out.push({ k: 'secure', s: 'ok', t: 'Sites check its certificate, and it\'s the right one.' });
      else out.push({ k: 'secure', s: 'warn', t: 'Riyeser online still lists an older certificate for it. It updates within a minute.' });
    }
    // 7. registered with the business
    if (hp) {
      const mine = (r.relays || []).find((x) => x.id === hp.relay); const pos = (r.relays || []).findIndex((x) => x.id === hp.relay);
      if (hp.removed) out.push({ k: 'registered', s: 'fail', t: 'This relay was removed from your business (on the website, or another PC took over). Nobody uses it now.', fix: { act: 'relaystop', label: 'Remove it from this PC' } });
      else if (hp.sync && hp.sync.ok) out.push({ k: 'registered', s: 'ok', t: `Registered with your business: ${hp.region || hp.relay}${mine ? ` (${pos === 0 ? 'main relay' : `backup ${pos}`})` : ''}.` });
      else if (hp.sync && hp.sync.ok === false) out.push({ k: 'registered', s: 'fail', t: `Riyeser online didn't accept it: ${hp.sync.error || 'no answer'}.`, fix: { act: 'reregister', label: 'Try again' } });
      else out.push({ k: 'registered', s: 'todo', t: 'Checking in with Riyeser online…' });
    }
    // 8. switched on for the business
    out.push(r.state === 'off' ? { k: 'switched', s: 'warn', t: 'The relay is switched off for your business, so sites don\'t use it.', fix: { act: 'web', label: 'Switch it on (website)' } }
      : { k: 'switched', s: 'ok', t: 'Switched on for your business.' });
    return out.map((x) => ({ group: 'relay', ...x }));
  }
  function outsideList(ck) { const p = ck.ports || {}; return [p.https && { port: p.https, proto: 'tcp' }, p.sipTls && { port: p.sipTls, proto: 'tcp' }, p.turn && { port: p.turn, proto: 'udp' }, p.probe && { port: p.probe, proto: 'udp' }].filter(Boolean); }

  function siteSteps(f) {
    const r = f.relay || {}; const c = f.cloud || {}; const rc = f.reach || null; const out = [];
    out.push(c.status === 'offline' ? { k: 'internet', s: 'fail', t: 'This PC can\'t reach Riyeser online. Check the office\'s internet connection.' } : { k: 'internet', s: c.status === 'online' ? 'ok' : 'todo', t: c.status === 'online' ? 'Connected to the internet and Riyeser online.' : 'Checking…' });
    if (r.connected) out.push({ k: 'reach', s: 'ok', t: `Connected to ${r.region || r.relay}${r.rtt != null ? ` · ${r.rtt} ms` : ''}${r.backup ? ' (the backup relay)' : ''}.` });
    else if (rc && rc.dns && rc.dns.ok === false) out.push({ k: 'reach', s: 'fail', t: `The relay's name can't be found (${rc.dns.error}).` });
    else if (rc && rc.tcp && rc.tcp.ok === false) out.push({ k: 'reach', s: 'fail', t: `Can't connect to the relay: ${rc.tcp.error}. If this keeps happening, the relay PC's router ports need checking (on the relay PC: Connect your branches).` });
    else if (rc && rc.tls && rc.tls.ok === false) out.push({ k: 'reach', s: 'fail', t: `The secure connection failed: ${rc.tls.error}.` });
    else out.push({ k: 'reach', s: r.state === 'connecting' && r.error ? 'fail' : 'todo', t: r.error ? `Not connected: ${r.error}.` : 'Connecting…', fix: { act: 'relayretry', label: 'Reconnect now' } });
    if (r.state === 'refused' || /revoked|disconnected from the relay/i.test(r.error || '')) out.push({ k: 'auth', s: 'fail', t: `The relay refused this office: ${r.error || 'an admin disconnected it'}. An owner or admin can allow it again on the website (Sites & relay).`, fix: { act: 'web', label: 'Open Sites & relay' } });
    else if (r.connected) out.push({ k: 'auth', s: 'ok', t: `Allowed${r.exp ? `; its pass renews by itself (now until ${new Date(r.exp * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}.` });
    else out.push({ k: 'auth', s: 'todo', t: 'Checked once connected.' });
    if (r.udp === 'ok') out.push({ k: 'sound', s: 'ok', t: 'Call sound (UDP) gets through to the relay.' });
    else if (r.udp === 'blocked') out.push({ k: 'sound', s: 'fail', t: 'UDP blocked: calls to other sites connect, but there may be no sound.', how: ['In this office\'s firewall or router, allow outgoing UDP to the relay (any port from 3478 and 40000 up).', 'On a business firewall: allow UDP to the relay\'s address, ports 3478 and 40000–40301.', 'Then press Check again.'] });
    else out.push({ k: 'sound', s: 'todo', t: r.connected ? 'Checking…' : 'Checked once connected.' });
    if (r.connected) {
      const n = (f.exts || []).length; const sites = (r.sites || []).length;
      out.push(n ? { k: 'exts', s: 'ok', t: `${n} extension${n === 1 ? '' : 's'} with a phone here announced${sites ? ` · ${sites} other site${sites === 1 ? '' : 's'} connected` : ''}.` }
        : { k: 'exts', s: 'warn', t: 'No phone is connected at this site yet, so there\'s nothing to announce to the other sites.' });
    } else out.push({ k: 'exts', s: 'todo', t: 'Checked once connected.' });
    const tc = r.test;
    if (tc && tc.ok) out.push({ k: 'test', s: 'ok', t: `Sound both ways · ${tc.rtt_ms} ms round trip · ${tc.loss}% lost.`, fix: { act: 'testcall', label: 'Test again' } });
    else if (tc) out.push({ k: 'test', s: 'fail', t: tc.error || 'The test call didn\'t work.', fix: { act: 'testcall', label: 'Test again' } });
    else out.push({ k: 'test', s: 'todo', t: r.connected ? 'Plays a tone through the relay and checks it comes back clearly.' : 'Once connected.', fix: r.connected ? { act: 'testcall', label: 'Test call' } : null });
    return out.map((x) => ({ group: 'site', ...x }));
  }

  function build(f = {}) {
    const r = f.relay || {}; const isHost = !!(f.host && (f.host.installed || f.host.health));
    // a single office with no branches: one calm line, no promotion
    if (!isHost && (!r.state || ['local', 'off', 'no-config'].includes(r.state))) return { unused: true, steps: [], summary: { cls: 'off', text: 'Branches: not used', first: null, problems: [] }, sites: 0 };
    const muted = new Set(f.muted || []);
    const steps = [...(isHost ? relaySteps(f) : []), ...siteSteps(f)].map((x) => ({ title: TITLES[x.k], fix: null, how: null, ...x, muted: muted.has(x.k) }))
      .sort((a, b) => ORDER.indexOf(a.k) - ORDER.indexOf(b.k));
    const problems = steps.filter((x) => (x.s === 'fail' || x.s === 'warn') && !x.muted);
    const fails = problems.filter((x) => x.s === 'fail');
    const sites = (r.sites || []).length + (r.connected ? 1 : 0);
    const first = (fails[0] || problems[0] || null);
    const summary = !problems.length
      ? { cls: steps.some((x) => x.s === 'todo') && !r.connected ? 'info' : 'ok', text: r.connected ? `All good — ${sites} site${sites === 1 ? '' : 's'} connected` : steps.some((x) => x.s === 'todo') ? 'Checking…' : 'All good', first: null, problems: [] }
      : { cls: fails.length ? 'bad' : 'warn', text: `${problems.length} thing${problems.length === 1 ? ' needs' : 's need'} attention: ${first.title}${first.t ? ` — ${first.t.replace(/\.$/, '')}` : ''}`, first: first.k, problems: problems.map((x) => x.k) };
    return { unused: false, steps, summary, sites };
  }
  /** What goes to the website (link_relay_report checks): only the key, state and the short line. */
  const forReport = (list) => (list.steps || []).map((x) => ({ k: x.k, s: x.muted && x.s !== 'ok' ? 'todo' : x.s, t: String(x.t || '').slice(0, 160) }));

  const C = { build, forReport, TITLES, ORDER, isCloudflare, dnsHost, forwardSteps };
  if (typeof module !== 'undefined' && module.exports) module.exports = C; else root.LinkRelayCheck = C;
})(typeof window !== 'undefined' ? window : globalThis);
