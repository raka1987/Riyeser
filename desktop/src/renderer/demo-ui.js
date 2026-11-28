// Riyeser Central: the words and choices for demo mode. Plain functions (no window or Electron), so the tests can
// load this file too. central.js and company.js use them through window.RiyeserDemo.
(function (root) {
  const BUSINESS = 'Sample Trading Co';
  const TEXT = {
    // The welcome screen, the first time Central opens (company.js showStart). Just try it needs no account.
    startTitle: 'Welcome to Riyeser',
    startSub: 'Start in a minute. You only need an account for things that work online, and Riyeser asks only then.',
    tryTitle: 'Just try it — no account needed',
    trySub: 'Start using the programs on this PC straight away. Free programs stay free; the others are free for 90 days.',
    demoTitle: 'Look around with a sample business',
    demoSub: `Try with sample data: every program filled in for a made-up business, ${BUSINESS}. Your own records stay separate, and you can leave demo mode any time.`,
    signinTitle: 'I already use Riyeser — sign in',
    signinSub: 'For businesses already using Riyeser. Use the same email as riyeser.com.',
    joinTitle: 'Join with a code',
    signupTitle: 'Create a free account',
    blankTitle: 'Start with my own business',
    offline: 'Signing in isn\'t available right now (it needs the internet). Just try it, and sign in later from Your account if you want to.',
    laterTitle: 'Set up later',
    banner: `everything you see is practice data for ${BUSINESS}.`,
    leaveButton: 'Leave demo mode',
    tryButton: 'Try demo mode',
    // Demo mode only ever starts after this question (the wizard's demo choice and "Try demo mode" both ask it).
    confirmTitle: 'Turn on demo mode?',
    confirmBody: `Every Riyeser program opens with made-up practice data for ${BUSINESS}. Your own records stay separate. You can leave any time from the yellow banner.`,
    confirmOk: 'Turn on demo mode',
    confirmCancel: 'Cancel',
    confirmLeave: 'Leave demo mode? The practice data is put away (not deleted), and Riyeser goes back to your own setup. Close any open Riyeser programs first.',
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * What Central shows first when it starts: 'start' (the first-run choice, only on a PC never set up), 'waiting' (a
   * join request is out), 'signedout' (the Company page's "You're signed out") or 'none'.
   */
  function firstScreen(company, demo) {
    const c = company || {};
    if (c.pendingJoin) return 'waiting';
    if (c.signedOut && !c.company) return 'signedout';   // signed out on purpose: the Company page asks to sign in
    if (demo && demo.on) return 'none';            // exploring the demo: no set-up for now
    if (!c.company && !c.skipped) return 'start';  // never set up: ask how they'd like to start
    return 'none';                                 // already set up (or chose "Set up later"): never asked again
  }

  /**
   * The welcome screen: every way to start, on one screen. Just try it is the big choice (no account, works offline);
   * the sample business next to signing in; joining, creating an account and setting up a business on this PC are
   * smaller links. online: signing in can work (else those are greyed, with a note); back: opened from inside Central.
   */
  function startHtml({ online = true, back = false } = {}) {
    const off = online ? '' : ' disabled';
    return `<h1>${TEXT.startTitle}</h1><p class="wsub">${esc(TEXT.startSub)}</p>
    <button class="wbig wmain wprimary" data-w="try"><span class="wi">🚀</span><b>${esc(TEXT.tryTitle)}</b><small>${esc(TEXT.trySub)}</small></button>
    <div class="wchoices two wsecond">
      <button class="wbig wsm" data-w="demo"><span class="wi">🧪</span><b>${esc(TEXT.demoTitle)}</b><small>${esc(TEXT.demoSub)}</small></button>
      <button class="wbig wsm" data-w="signin"${off}><span class="wi">🔑</span><b>${esc(TEXT.signinTitle)}</b><small>${esc(TEXT.signinSub)}</small></button>
    </div>${online ? '' : `<p class="wnote">${esc(TEXT.offline)}</p>`}
    <p class="wfoot wmore"><button class="wlink" data-w="join"${off}>${esc(TEXT.joinTitle)}</button><span aria-hidden="true">·</span><button class="wlink" data-w="signup"${off}>${esc(TEXT.signupTitle)}</button><span aria-hidden="true">·</span><button class="wlink" data-w="blank">${esc(TEXT.blankTitle)}</button></p>
    <p class="wfoot wmore">${back ? '<button class="wlink" data-w="leave">Back</button><span aria-hidden="true">·</span>' : ''}<button class="wlink" data-w="later">${esc(TEXT.laterTitle)}</button><span aria-hidden="true">·</span><button class="wlink" data-w="restore">Restore everything from a backup…</button></p>`;
  }

  /** The yellow banner across Central while demo mode is on ('' when it's off). */
  function bannerHtml(demo) {
    if (!demo || !demo.on) return '';
    return `<span class="grow"><b>Demo mode</b>: ${esc(TEXT.banner)}</span><button class="demo-leave" data-demo="leave">${TEXT.leaveButton}</button>`;
  }

  /** What to tell the person after leaving demo mode. */
  function leaveMessage(r) {
    const busy = (r && r.busy) || [];
    if (!busy.length) return { ok: true, text: 'Demo mode is off. The practice data is put away, and Riyeser is back to your own setup.' };
    const names = busy.map((b) => b.name);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const one = busy.length === 1;
    return { ok: false, text: `Demo mode is off, but ${list} ${one ? 'is' : 'are'} still open, so ${one ? 'its' : 'their'} practice data couldn't be put away yet. Please close ${list}, then press Try again. Next time ${one ? 'it starts, it uses' : 'they start, they use'} your own records.` };
  }

  /** Central's main process starts demo mode only when the renderer says the person confirmed it. */
  const startAllowed = (opts) => !!(opts && opts.confirmed === true);

  const api = { BUSINESS, TEXT, firstScreen, startHtml, bannerHtml, leaveMessage, startAllowed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RiyeserDemo = api;
}(typeof window !== 'undefined' ? window : null));
