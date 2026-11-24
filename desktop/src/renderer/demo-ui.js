// Riyeser Central: the words and choices for demo mode. Plain functions (no window or Electron), so the tests can
// load this file too. central.js and company.js use them through window.RiyeserDemo.
(function (root) {
  const BUSINESS = 'Sample Trading Co';
  const TEXT = {
    startTitle: 'How would you like to start?',
    blankTitle: 'Start blank (recommended)',
    blankSub: 'For your own business. Nothing is filled in.',
    demoTitle: 'Explore with demo data',
    demoSub: `Try every program with a made-up business, ${BUSINESS}. Your own records stay separate, and you can leave demo mode any time.`,
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

  /** The first step of the set-up wizard. */
  function startHtml() {
    return `<h1>${TEXT.startTitle}</h1><p class="wsub">You can change your mind later.</p>
    <button class="wbig wmain wprimary" data-w="blank"><span class="wi">📄</span><b>${TEXT.blankTitle}</b><small>${TEXT.blankSub}</small></button>
    <div class="wsecond"><button class="wbig wsm" data-w="demo"><span class="wi">🧪</span><b>${TEXT.demoTitle}</b><small>${esc(TEXT.demoSub)}</small></button></div>`;
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
