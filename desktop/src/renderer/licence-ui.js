// Riyeser Central: the words for the licence window and the program cards. Plain functions (no window or Electron), so
// the tests can load this file too. central.js uses them through window.RiyeserLicenceUi.
//
// S12: there is one licence system, the company's plan from the Riyeser account. Nobody types a key any more: the
// licence window says "Sign in to your Riyeser account to unlock your plan". Each paid program's card says where that
// program really stands (paid, free trial with days left, trial ended), from the plan or the local trial.
// F3: prices come from the one price list (core/prices.js, sent with the licence status), never from text here.
(function (root) {
  // Central's program ids -> the plan's module ids. Programs not listed here are free.
  const MODULE = { 'accounting-basics': 'basic', accounting: 'plus', pos: 'pos', bookings: 'bookings', payroll: 'payroll', services: 'as_built', linkoffice: 'calls' };
  const SIGN_IN_TITLE = 'Sign in to your Riyeser account to unlock your plan';
  const SIGN_IN_TEXT = 'Your plan comes with your Riyeser account: sign in once on this PC and every Riyeser program on it follows your plan. '
    + 'Paid on riyeser.com? Sign in with the same email.';

  /** { text, alert, module } for a paid program's card, or null for a free program. */
  function programStatus(id, lic) {
    const mod = MODULE[id];
    if (!mod) return null;
    const s = lic || {};
    if (s.online) {
      const row = (s.online.rows || []).find((r) => r.id === mod);
      if (row) {
        const t = String(row.text || '');
        return { module: mod, text: t.charAt(0).toUpperCase() + t.slice(1), alert: row.tone === 'bad', tone: row.tone };
      }
      return { module: mod, text: 'Not on your plan', alert: true, tone: 'bad' };
    }
    if (s.mode === 'trial') {
      const n = s.daysLeft;
      return { module: mod, text: n != null ? `Free trial, ${n} day${n === 1 ? '' : 's'} left` : 'Free trial', alert: n != null && n <= 14, tone: n != null && n <= 14 ? 'warn' : 'trial' };
    }
    if (s.mode === 'licensed') return { module: mod, text: 'Licensed', alert: false, tone: 'ok' };
    if (s.mode === 'expired') return { module: mod, text: 'Free trial ended: sign in to unlock your plan', alert: true, tone: 'bad' };
    return { module: mod, text: 'Free for 90 days', alert: false, tone: 'trial' };
  }

  /** The "Premium version available" line on Riyeser Link, with the price from the price list. */
  function plusText(prices) {
    const p = prices && prices.monthly && prices.monthly.calls;
    return `Premium version available: Riyeser Link Plus adds calls, desk phones and 20 GB of files${p ? ` for ${p}` : ''}`;
  }

  /** The licence window's sign-in part (in place of the old licence key box). esc: the page's HTML escaper. */
  function signInHtml(s, esc, signedIn) {
    const prices = (s && s.prices && s.prices.summary) || '';
    return `<div class="signin-plan"><b>${esc(SIGN_IN_TITLE)}</b><p>${esc(SIGN_IN_TEXT)}</p>
      <div class="row"><button class="btn" data-lic="signin">${signedIn ? 'Link this PC to your business' : 'Sign in'}</button><button class="btn s" data-lic="buy">See plans &amp; buy</button></div></div>
      ${prices ? `<p class="muted">${esc(prices)}</p>` : ''}`;
  }

  const api = { MODULE, SIGN_IN_TITLE, SIGN_IN_TEXT, programStatus, plusText, signInHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RiyeserLicenceUi = api;
}(typeof window !== 'undefined' ? window : null));
