// Riyeser Central: "This needs a free Riyeser account". Trying Riyeser never needs an account; it is asked for only at
// the few points that really work online (buying a plan, Riyeser Link chat and calls, online bookings and orders,
// adding the people who help you, and asking someone to sign). Every one of them shows this same friendly question,
// with Create account / Sign in / Not now. Not now just closes it: the person is back where they were, nothing lost.
// Nothing here is ever shown when Central starts.
//
// Plain functions first (no window or Electron), so the tests can load this file too; ask() draws the question.
// company.js uses it through window.RiyeserAccountNeed (needAccount: the sign-in and create-account flows).
(function (root) {
  /** What works online, for each point that needs an account (the words after "so"). */
  const WHY = {
    buy: 'your plan works online',
    link: 'Riyeser Link chat and calls work online',
    online: 'bookings and orders from your website come in online',
    people: 'the people who help you can join you online',
    sign: 'your signing requests work online',
  };
  const TEXT = {
    title: 'This part works online',
    create: 'Create account',
    signin: 'Sign in',
    later: 'Not now',
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** The sentence for one point. what: a WHY key, or the words themselves ("… so <words>. …"). */
  function body(what) {
    const why = WHY[what] || String(what || '').trim() || 'it works online';
    return `This needs a free Riyeser account so ${why}. Create one in a minute, or sign in.`;
  }

  /** Is the question needed? Only when nobody is signed in on this PC and demo mode is off. */
  function needed({ signedIn = null, demo = false } = {}) { return !signedIn && !demo; }

  /** The question's inside. The three answers carry data-need="create|signin|later". */
  function promptHtml(what) {
    return `<div class="askbody needbody"><div class="needic" aria-hidden="true">🔑</div><h2 id="needh">${esc(TEXT.title)}</h2><p id="needp">${esc(body(what))}</p>
      <div class="wrow"><button class="btn s" data-need="later">${esc(TEXT.later)}</button><span class="grow"></span><button class="btn s" data-need="signin">${esc(TEXT.signin)}</button><button class="btn" data-need="create">${esc(TEXT.create)}</button></div></div>`;
  }

  /** Ask. Resolves 'create', 'signin' or 'later' (Not now, Esc or closing it). Drawn over whatever is open. */
  function ask(what) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog'); d.className = 'licdlg askdlg needdlg';
      d.setAttribute('aria-labelledby', 'needh'); d.setAttribute('aria-describedby', 'needp');
      d.innerHTML = promptHtml(what);
      let answer = 'later';
      d.addEventListener('click', (e) => { const b = e.target.closest('[data-need]'); if (b) { answer = b.dataset.need; d.close(); } });
      d.addEventListener('close', () => { d.remove(); resolve(answer); });
      document.body.appendChild(d); d.showModal(); d.querySelector('[data-need="later"]').focus();   // Enter on its own never pushes to sign up
    });
  }

  const api = { WHY, TEXT, body, needed, promptHtml, ask };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RiyeserAccountNeed = api;
}(typeof window !== 'undefined' ? window : null));
