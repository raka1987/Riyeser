// Is Riyeser Link Office switched on? It comes with Link Plus: the 'calls' module of the company's Riyeser plan.
// The plan is saved in %APPDATA%\Riyeser\licence.json under "online" by Riyeser Central (and by this app when it's
// signed in). It works while 'calls' is on its free trial (the same 90 days as every paid program) or paid, and keeps
// working for 30 days without the internet. Nothing here deletes anything.
const licence = require('../core/licence');

const DAY = 86400000;
const TEAM_URL = 'https://riyeser.com/link/';
const NEEDS_PLUS = 'Riyeser Link Office comes with Riyeser Link Plus. Start your free trial or add Link Plus from your Riyeser home page.';

/** End of a "YYYY-MM-DD" day (the plan's dates are whole days). */
const endOfDay = (ymd) => { const t = Date.parse(`${String(ymd).slice(0, 10)}T23:59:59Z`); return Number.isFinite(t) ? t : null; };

/**
 * { active, state: 'trial' | 'paid' | 'none' | 'ended' | 'stale', daysLeft, text, message }
 *   none   no Riyeser plan on this PC (not signed in, or Link Plus not on the plan)
 *   ended  the trial finished or the plan was cancelled
 *   stale  not checked for 30 days (connect to the internet)
 */
function callsLicence(appData, now = Date.now()) {
  const o = licence.read(appData).online;
  if (!o || typeof o !== 'object') return { active: false, state: 'none', text: 'Not set up', message: NEEDS_PLUS };
  const m = o.modules && o.modules.calls;
  if (!m) return { active: false, state: 'none', text: 'Not on your plan', message: NEEDS_PLUS };
  const checked = Date.parse(o.checkedAt) || 0;
  if (!(now - checked < licence.OFFLINE_GRACE_DAYS * DAY)) {
    return { active: false, state: 'stale', text: 'Needs checking', message: 'Riyeser couldn\'t check your Link Plus plan for 30 days. Connect this PC to the internet and open Riyeser Central.' };
  }
  if (!m.active) {
    return { active: false, state: 'ended', text: m.status === 'cancelled' ? 'Cancelled' : 'Trial ended', message: NEEDS_PLUS };
  }
  if (m.status === 'trial') {
    // The trial ends on its own date even with no internet. Without a date, count on from the last check.
    const end = (m.trial_ends && endOfDay(m.trial_ends)) || (m.days_left != null ? checked + Number(m.days_left) * DAY : null);
    if (end != null && now > end) return { active: false, state: 'ended', text: 'Trial ended', message: NEEDS_PLUS };
    const daysLeft = end != null ? Math.max(0, Math.ceil((end - now) / DAY)) : null;
    return { active: true, state: 'trial', daysLeft, text: daysLeft != null ? `Link Plus free trial, ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : 'Link Plus free trial', message: null };
  }
  return { active: true, state: 'paid', text: m.paid_until ? `Link Plus, paid until ${licence.fmtDate(m.paid_until)}` : 'Link Plus', message: null };
}

module.exports = { callsLicence, NEEDS_PLUS, TEAM_URL };
