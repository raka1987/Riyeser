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
    duration: (s) => (!s ? '' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim()),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = T; else root.LinkText = T;
}(this));
