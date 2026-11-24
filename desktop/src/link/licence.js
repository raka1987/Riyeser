// Is Riyeser Link Office switched on? It comes with Link Plus: the 'calls' module of the company's Riyeser plan.
// The plan is saved in %APPDATA%\Riyeser\licence.json under "online" by Riyeser Central (and by this app when it's
// signed in). It works while 'calls' is on its free trial (the same 90 days as every paid program) or paid, and keeps
// working for 30 days without the internet. Nothing here deletes anything.
const path = require('path');
const licence = require('../core/licence');
const signed = require('../core/signed-licence');

const TEAM_URL = 'https://riyeser.com/link/';
const NEEDS_PLUS = 'Riyeser Link Office comes with Riyeser Link Plus. Start your free trial or add Link Plus from your Riyeser home page.';
// what's paused, what still works, the price and where to add it (the same pattern as every paid program)
const LOCKED = `Link Plus isn't on, so office calls are paused. Your people, phones and call history are kept, and Riyeser Link chat still works. To carry on, add Link Plus from your Riyeser home page (${licence.MODULE_PRICES.calls}).`;
const STALE = 'Riyeser couldn\'t check your Link Plus plan for 30 days. Connect this PC to the internet and open Riyeser Central.';


/**
 * { active, state: 'trial' | 'paid' | 'none' | 'ended' | 'stale', daysLeft, text, message }
 *   none   no Riyeser plan on this PC (not signed in, or Link Plus not on the plan)
 *   ended  the trial finished or the plan was cancelled
 *   stale  not checked for 30 days (connect to the internet)
 */
function callsLicence(appData, now = Date.now()) {
  // only a plan this PC can trust counts (signed-licence.js: signed by Riyeser, for this business and this PC, not expired)
  const ev = signed.check({ appData, ownDir: path.join(appData, 'Riyeser Link Office', 'data'), now });
  if (ev.state === 'none') return { active: false, state: 'none', text: 'Not set up', message: NEEDS_PLUS };
  if (ev.state === 'invalid') {
    const stale = ev.problem === 'expired';
    return { active: false, state: stale ? 'stale' : 'ended', text: 'Needs checking', message: stale ? STALE : `${ev.message} ${LOCKED}`, problem: ev.problem };
  }
  const o = ev.plan;
  const m = o.modules && o.modules.calls;
  if (!m) return { active: false, state: 'none', text: 'Not on your plan', message: NEEDS_PLUS };
  if (!(now < ev.expiresAt)) return { active: false, state: 'stale', text: 'Needs checking', message: STALE };
  const note = ev.message ? ` ${ev.message}` : '';   // an older Central: "Update Riyeser Central to keep your plan up to date."
  const live = signed.moduleState(o, 'calls', now);
  if (!live.active) {
    return { active: false, state: 'ended', text: m.status === 'cancelled' ? 'Cancelled' : 'Trial ended', message: `${LOCKED}${note}` };
  }
  if (live.status === 'trial') {
    const daysLeft = live.daysLeft;
    return { active: true, state: 'trial', daysLeft, text: daysLeft != null ? `Link Plus free trial, ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : 'Link Plus free trial', message: ev.message || null };
  }
  return { active: true, state: 'paid', text: m.paid_until ? `Link Plus, paid until ${licence.fmtDate(m.paid_until)}` : 'Link Plus', message: ev.message || null };
}

module.exports = { callsLicence, NEEDS_PLUS, LOCKED, TEAM_URL };
