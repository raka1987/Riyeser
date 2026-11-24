// Riyeser Link Office's wording, in one place (used by the window, and by the tests to check the exact words).
(function (root) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const T = {
    EMERGENCY: 'Internal calls only. These phones can\'t call emergency services — keep a mobile or normal phone line for that.',
    running: (host) => `Riyeser Link Office is running on this PC (${host}).`,
    counts: (c) => `${plural(c.phones, 'phone')} connected · ${c.onCalls ? `${plural(c.onCalls, 'call')} in progress` : 'no calls right now'}`,
    WAITING_TITLE: 'Riyeser Link Office isn\'t switched on yet',
    STOPPING_TITLE: 'Riyeser Link Office is finishing the calls in progress',
    /** The licence message as HTML, with Riyeser Link Plus in bold (text must already be escaped). */
    boldPlus: (escaped) => escaped.replace('Riyeser Link Plus', '<b>Riyeser Link Plus</b>'),
    NEEDS_PLUS: 'Riyeser Link Office comes with Riyeser Link Plus. Start your free trial or add Link Plus from your Riyeser home page.',
    STOPPING: 'Link Plus isn\'t active any more. Calls in progress can finish, then Riyeser Link Office pauses. Nothing is deleted: people, phones and calls stay ready for when it\'s back on.',
    ipChanged: (ip) => `This PC's network address changed (was ${ip.from}, now ${ip.to}). Phones are being updated. To stop this happening, ask your router to always give this PC the same address. Look for 'DHCP reservation' or 'Static lease' in your router's settings.`,
    IP_UNSTABLE: 'This has happened several times this month, so phones may keep losing touch until the router always gives this PC the same address.',
    ipSteps: (mac, ip) => [
      'On a PC or phone connected to the office network, open the router\'s page in a web browser. It\'s often 192.168.1.1 or 192.168.0.1, and the sign-in is usually on a sticker on the router.',
      'Find the list of connected devices, or a section called DHCP, LAN or Address reservation.',
      `Add a reservation (it may be called "DHCP reservation", "Static lease" or "Static DHCP") for this PC's MAC address ${mac || '(shown above)'} with the address ${ip}.`,
      'Save. Nothing else needs changing: Riyeser Link Office and the phones carry on by themselves.',
      'Not sure? Your IT person or internet provider can do this in a few minutes.'],
    FIREWALL: 'Windows Firewall may be blocking the desk phones. Allow Riyeser Link Office through it (Windows asks for permission once).',
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
    duration: (s) => (!s ? '' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim()),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = T; else root.LinkText = T;
}(this));
