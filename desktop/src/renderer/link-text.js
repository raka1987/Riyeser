// Riyeser Link Office's wording, in one place (used by the window, and by the tests to check the exact words).
(function (root) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const T = {
    EMERGENCY: 'Internal calls only. These phones can\'t call emergency services — keep a mobile or normal phone line for that.',
    running: (host) => `Riyeser Link Office is running on this PC (${host}).`,
    counts: (c) => `${plural(c.phones, 'phone')} connected · ${c.onCalls ? `${plural(c.onCalls, 'call')} in progress` : 'no calls right now'}`,
    WAITING_TITLE: 'Riyeser Link Office isn\'t switched on yet',
    STOPPING_TITLE: 'Riyeser Link Office is finishing the calls in progress',
    /** The licence message as HTML, with Riyeser Link in bold (text must already be escaped). */
    boldPlus: (escaped) => escaped.replace(/Riyeser Link(?! Office)/, '<b>Riyeser Link</b>'),
    NEEDS_PLUS: 'Riyeser Link Office comes with Riyeser Link. Start your free trial or add Riyeser Link from your Riyeser home page (Add to my plan).',
    STOPPING: 'Riyeser Link isn\'t active any more. Calls in progress can finish, then Riyeser Link Office pauses. Nothing is deleted: people, phones and calls stay ready for when it\'s back on.',
    /** "192.168.1.35" -> ".35" when only the last part differs from the old address. */
    shortTo: (from, to) => { const a = String(from || '').split('.'); const b = String(to || '').split('.'); return a.length === 4 && b.length === 4 && a.slice(0, 3).join('.') === b.slice(0, 3).join('.') ? `.${b[3]}` : String(to || ''); },
    ipChanged: (ip) => `Your PC's address changed from ${ip.from} to ${T.shortTo(ip.from, ip.to)} — phones updated.`,
    ipChangedMore: (ip) => `Riyeser Link Office moved to ${ip.to} by itself${ip.phones ? ` and asked ${plural(ip.phones, 'desk phone')} to restart and pick it up` : ''}. Desk phones it set up follow automatically. Phones or apps typed in by hand need the new address typed in (or a name: see Settings → This PC's address). To stop this happening, reserve this PC's address in your router.`,
    IP_OFFLINE: 'This PC isn\'t connected to the office network right now, so phones can\'t reach it. Check its network cable or Wi-Fi.',
    IP_UNSTABLE: 'This has happened several times this month, so phones may keep losing touch until the router always gives this PC the same address.',
    ipSteps: (mac, ip) => [
      'On a PC or phone connected to the office network, open the router\'s page in a web browser. It\'s often 192.168.1.1 or 192.168.0.1, and the sign-in is usually on a sticker on the router.',
      'Find the list of connected devices, or a section called DHCP, LAN or Address reservation.',
      `Add a reservation (it may be called "DHCP reservation", "Static lease" or "Static DHCP") for this PC's MAC address ${mac || '(shown above)'} with the address ${ip}.`,
      'Save. Nothing else needs changing: Riyeser Link Office and the phones carry on by themselves.',
      'Not sure? Your IT person or internet provider can do this in a few minutes.'],
    FIREWALL: 'Windows Firewall may be blocking the desk phones. Allow Riyeser Link Office through it (Windows asks for permission once).',
    FIREWALL_OLD: 'Update Riyeser Link Office\'s firewall rule so phones and apps can find this PC by name (riyeser-office.local). Windows asks for permission once.',
    // ---------- This PC's address (Settings) ----------
    ADDR_TITLE: 'This PC\'s address',
    ADDR_WHY: 'Desk phones keep this PC\'s address. If the router gives the PC a new one, Riyeser Link Office notices within seconds, moves to it and asks the desk phones it set up to pick it up. To stop it changing at all, reserve the address in your router.',
    namesLine: (n) => `Computers and apps on the office network can also use the name ${n.mdns}${n.router ? `, and the router knows this PC as ${n.router}` : ''}.`,
    MODE_ADDRESS: 'Give desk phones this PC\'s address (works with every phone; recommended with a reservation in the router)',
    modeName: (name) => `Give desk phones the name ${name} (it follows this PC when its address changes, using the router's own name list)`,
    MODE_NONAME: 'Your router doesn\'t have a name for this PC that Riyeser Link Office could check, so desk phones get its address. Reserve the address in your router.',
    OPTION66: 'Lots of phones, or phones from other makers? Many routers can tell phones where to get their settings (DHCP option 66, sometimes "TFTP server" or "Provisioning server"). Put this address there:',
    FIXED_TITLE: 'Use a fixed address (only if your router can\'t reserve one)',
    FIXED_WHY: 'Sets a fixed address on this PC\'s network adapter, with Windows\' permission. A reservation in the router is better: a fixed address on the PC can clash if the router gives it to another device. If the PC can\'t reach the router afterwards, it goes back to automatic by itself.',
    fixedOn: (f) => `This PC has the fixed address ${f.address} on ${f.alias} (set by Riyeser Link Office). Undo puts it back on automatic.`,
    // ---------- Reserve this PC's address in your router ----------
    RESERVE_TITLE: 'Reserve this PC\'s address in your router',
    RESERVE_INTRO: 'A reservation (also called "DHCP reservation", "Static lease", "Address reservation" or "Fixed IP") tells the router to always give this PC the same address, so phones never lose it. It takes a few minutes, and nothing changes on this PC.',
    reserveWhat: (mac, ip) => `Reserve ${ip} for the MAC address ${mac || '(see below)'}.`,
    ROUTERS: [
      { id: 'tplink', name: 'TP-Link', steps: ['Open the router\'s page and sign in (the password is often on the router\'s sticker).', 'Go to Advanced → Network → DHCP Server → Address Reservation.', 'Click Add, type this PC\'s MAC address and the address, tick Enable, then Save.'] },
      { id: 'netgear', name: 'NETGEAR', steps: ['Open the router\'s page (routerlogin.net) and sign in.', 'Go to Advanced → Setup → LAN Setup, and under Address Reservation click Add.', 'Choose this PC from the list (or type its MAC address and the address), click Add, then Apply.'] },
      { id: 'asus', name: 'ASUS', steps: ['Open the router\'s page (router.asus.com) and sign in.', 'Go to LAN → DHCP Server, and set "Enable Manual Assignment" to Yes.', 'Under "Manually Assigned IP around the DHCP list", choose this PC\'s MAC address, type the address, click +, then Apply.'] },
      { id: 'linksys', name: 'Linksys', steps: ['Open the router\'s page (myrouter.local) and sign in.', 'Go to Connectivity → Local Network → DHCP Reservations.', 'Tick this PC in the list (or add it by MAC address), check the address, then Save / Ok.'] },
      { id: 'dlink', name: 'D-Link', steps: ['Open the router\'s page and sign in.', 'Go to Settings → Network (or Setup → Network Settings) → DHCP Reservation.', 'Click Add Reservation, type a name, this PC\'s MAC address and the address, then Save.'] },
      { id: 'unifi', name: 'Ubiquiti UniFi', steps: ['Open the UniFi Network app or page.', 'Go to Client Devices and click this PC (find it by its MAC address).', 'Open Settings, turn on Fixed IP Address, type the address, then Apply.'] },
      { id: 'fritz', name: 'FRITZ!Box', steps: ['Open fritz.box and sign in.', 'Go to Home Network → Network → Network Connections, and click the pencil next to this PC.', 'Tick "Always assign this network device the same IPv4 address", then OK.'] },
      { id: 'mikrotik', name: 'MikroTik', steps: ['Open WinBox or WebFig and sign in.', 'Go to IP → DHCP Server → Leases.', 'Double-click this PC\'s lease (its MAC address) and click Make Static, then OK.'] },
      { id: 'isp', name: 'Internet provider\'s modem (Telstra, Optus, BT, Spectrum…)', steps: ['Open the modem\'s page (often 192.168.0.1 or 192.168.1.1, or your provider\'s app) and sign in.', 'Look under Advanced, LAN, Network or DHCP for "Static leases", "Reserved IP addresses" or "Address reservation".', 'Add this PC\'s MAC address with the address, then Save. Can\'t find it? Your provider\'s support can do it for you.'] },
      { id: 'other', name: 'Another router', steps: ['On a PC or phone connected to the office network, open the router\'s page in a web browser and sign in (the sign-in is usually on a sticker on the router).', 'Find the list of connected devices, or a section called DHCP, LAN or Address reservation.', 'Add a reservation for this PC\'s MAC address with the address, and save.', 'Not sure? Your IT person or internet provider can do this in a few minutes.'] },
    ],
    RESERVE_AFTER: 'Nothing else needs changing: Riyeser Link Office and the phones carry on by themselves. Restarting the PC is a good test: the address should stay the same.',
    personState: (p) => (p.dnd && p.state === 'ready' ? 'do not disturb' : p.state),
    device: (d) => (d === 'app' ? 'Riyeser Link app' : d === 'desk phone + app' || d === 'app + desk phone' ? 'desk phone and app' : d || '—'),
    result: (r) => ({ answered: 'answered', missed: 'missed', busy: 'busy', unavailable: 'not connected', declined: 'declined', failed: 'didn\'t connect' }[r] || r || ''),
    SERVER_LABEL: 'Server address to type into phones',
    port: (p) => `port ${p || 5060}`,
    SERVER_HINT: 'Username: the person\'s extension. Password: under Set up a phone by hand. Desk phones from Yealink, Grandstream, Snom and Polycom set themselves up when you give them to someone.',
    NOT_STABLE: 'This address has changed several times this month, so phones may lose touch. Ask your router to always give this PC the same address (a "DHCP reservation"): look for "Static lease" in its settings. This PC\'s MAC address is under Settings → Advanced.',
    NOT_RUNNING_HINT: 'Phones can only connect while Riyeser Link Office is running.',
    phoneCount: (n, on) => `${plural(n, 'phone')} · ${on} connected`,
    /** Riyeser Link online (the Phones page on the website). */
    cloud: (c) => (!c ? '' : c.status === 'online' ? `Your owners and admins can see these phones on riyeser.com/link (Phones)${c.at ? `, last sent ${new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.`
      : c.status === 'local' ? 'This PC isn\'t linked to a Riyeser Online business, so the phones only show here.'
      : c.status === 'not-yet' ? 'The Phones page on riyeser.com/link isn\'t switched on yet. Riyeser Link Office tries again by itself.'
      : c.status === 'offline' ? `Can't reach Riyeser Link online right now, so the website's Phones page waits. The phones here work as normal.${c.error ? ` (${c.error})` : ''}`
      : 'Connecting to Riyeser Link online…'),
    /** "Set up your office phones": the same 5 steps as the website's Phones page, ticked off from this PC's own state. */
    SETUP_TITLE: 'Set up your office phones',
    SETUP_DONE: '✓ Office phones are set up',
    setupSteps: (S) => {
      const phones = (S && S.phones) || []; const found = (S && S.found) || [];
      return [
        { text: 'Install Riyeser Link Office on a PC at the office that stays on.', done: true },
        { text: 'Sign in on that PC.', done: !!(S && (S.signedIn || S.source === 'team')), act: 'signin', actText: 'Sign in' },
        { text: 'Plug in your desk phones.', done: phones.length + found.length > 0, act: 'addphone', actText: 'How' },
        { text: 'Give each phone to a person.', done: phones.length > 0 && found.length === 0, act: 'found', actText: 'New phones found' },
        { text: 'Make a test call.', done: ((S && S.recent) || []).some((c) => c.result === 'answered') || ((S && S.inProgress) || []).length > 0,
          note: 'Pick up a desk phone and dial another extension, or a ring group like 100.' },
      ];
    },
    /** A desk phone's status pill: Online, Configuring (fetched its settings, not connected yet), Offline (was connected), Waiting for phone. */
    phoneStatus: (p, now = Date.now()) => {
      const t = (x) => (x ? Date.parse(x) : 0);
      const fetched = t(p.provisioned_at || p.lastFetch); const reg = t(p.last_registered || p.lastRegistered);
      if (p.registered) return ['Online', 'ok'];
      if (fetched && fetched > reg && now - fetched < 15 * 60000) return ['Configuring', 'cfg'];
      if (reg) return ['Offline', 'bad'];
      if (fetched) return ['Configuring', 'cfg'];
      return ['Waiting for phone', 'wait'];
    },
    howSetsUp: (name) => `How ${name || 'this person'} sets up their phone`,
    REPLACE_PREVIEW: (mac) => `The old phone (MAC ${mac}) stops getting its settings now. It keeps working until it's restarted or reset. To lock it out straight away, also make a new password.`,
    // ---------- the Riyeser relay (1.3.0): other sites and phones at home
    RELAY_TITLE: 'Connect your branches',
    RELAY_SUB: 'Other sites and phones at home, through the Riyeser relay',
    RELAY_WHY: 'With the Riyeser relay switched on for your business, desk phones here can dial any extension at your other sites (each with its own Riyeser Link Office) and phones at home, and they can dial you. Nothing to change on your router. Calls inside this office never use it, and keep working with no internet.',
    RELAY_OFF: 'The Riyeser relay is switched off for your business. An owner or admin switches it on in Riyeser Link: Phones → Sites and the relay.',
    RELAY_LOCAL: 'Link this PC to your business (in Riyeser Central) and sign in, to connect your branches.',
    relayLine: (r) => {
      if (!r || r.state === 'local' || r.state === 'off') return '';
      if (r.connected) return `${r.backup ? 'Using backup relay' : 'Connected to Riyeser relay'} · ${r.region || r.host}${r.rtt != null ? ` · ${r.rtt} ms` : ''}${r.sites && r.sites.length ? ` · ${r.sites.length} other site${r.sites.length === 1 ? '' : 's'}` : ''}`;
      if (r.state === 'refused') return `Other sites: the relay refused this office (${r.error || 'ask an admin'}). Calls in this office work as normal.`;
      return 'Other sites: not connected right now (no connection to the Riyeser relay). Calls in this office work as normal; it keeps trying.';
    },
    RELAY_UDP_BLOCKED: 'Calls to other sites connect, but there may be no sound: this network\'s firewall seems to block UDP to the relay. Allow outgoing UDP to the relay (ports 40000–49999) on the router or firewall.',
    RELAY_SITE_NAME: 'This site\'s name (what the other sites see)',
    RELAY_HOST_TITLE: 'This PC as the relay (head office)',
    RELAY_HOST_WHY: 'The head office\'s always-on PC can be the Riyeser relay for all your sites (a rented server can be the backup). It runs in the background from Windows start-up, opens its ports in Windows Firewall and asks the router to forward them. Windows asks for permission once. Then add the relay\'s DNS name and register it once in Riyeser online (the relay\'s README says how).',
    RELAY_HOST_DOWN: 'The relay is installed on this PC but isn\'t answering. Running this again repairs it.',
    RELAY_HOST_MORE: 'It runs as the Windows task "Riyeser Relay" (starts with Windows, restarts itself). Its settings and log are in C:\\ProgramData\\Riyeser Relay.',
    RELAY_HOST_DONE: 'The relay is running on this PC. Next: its DNS name, the router (if it didn\'t forward the ports itself) and registering it once — see C:\\ProgramData\\Riyeser Relay.',
    relayHostOn: (h) => `This PC runs the Riyeser relay ${h.relay} (${h.region}) · version ${h.version} · ${h.sites} site${h.sites === 1 ? '' : 's'} and ${h.phones} phone${h.phones === 1 ? '' : 's'} connected now${h.sync && h.sync.ok === false ? ' · not reaching Riyeser online' : ''}.`,
    udp: (u) => ({ ok: 'gets through', blocked: 'blocked by a firewall', checking: 'checking…', unknown: 'not checked' }[u] || '—'),
    duration: (s) => (!s ? '' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim()),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = T; else root.LinkText = T;
}(this));
