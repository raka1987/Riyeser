// Payroll's licence: the 'payroll' program of the company's Riyeser plan. The same rules as Riyeser Accounting
// (riyeser/licence.py): free for 90 days, then the company's plan from Riyeser online, which Riyeser Central saves in
// %APPDATA%\Riyeser\licence.json. Once licences are signed (a public key built into this build), only a licence
// Riyeser signed for this business and this PC counts (signed-licence.js): an edited, copied or expired one is none.
//
// Not licensed: Payroll still opens, everything can be seen and printed, and staff can still clock in and out.
// Only new pay runs and changing pay rates are locked (checked here on the server, not just on screen).
// Nothing is ever deleted. Only the Windows program (DESKTOP=1) checks it; demo mode (practice records) doesn't.
const path = require('path');
const os = require('os');
const signed = require('./signed-licence');

const MODULE = 'payroll';
const PRICE = 'US$25/month';   // keep in step with riyeser.com's price for Payroll
const HOME_URL = 'https://riyeser.com/link/';   // the Riyeser home page, where Payroll is added to the plan
const STILL = 'You can still see and print everything.';
const ADD = `To run new pay runs, add Payroll from your Riyeser home page (${PRICE}).`;
const ENDED = `Payroll's free trial has ended. ${STILL} ${ADD}`;
const DAY = 86400000;

const appDataDir = (env = process.env) => env.APPDATA || path.join(os.homedir(), '.config');   // as Accounting and demo.js

/**
 * Where Payroll's licence stands.
 * opts: { appData, ownDir (Payroll's own data folder: a second place for the trial's first-run date), now, publicKey }
 * -> { licensed (new pay runs allowed), mode: 'trial' | 'licensed' | 'ended', daysLeft, source, problem, message, homeUrl, price }
 */
function status({ appData = appDataDir(), ownDir = null, now = Date.now(), publicKey } = {}) {
  const out = (o) => ({ homeUrl: HOME_URL, price: PRICE, problem: null, ...o });
  const ev = signed.check({ appData, ownDir, now, ...(publicKey !== undefined ? { publicKey } : {}) });
  if (ev.state === 'trusted' || ev.state === 'unsigned') {
    if (!(now < ev.expiresAt)) {
      return out({ licensed: false, mode: 'ended', source: 'online', problem: 'expired', message: `${signed.MESSAGES.expired} ${STILL} ${ADD}` });
    }
    const m = signed.moduleState(ev.plan, MODULE, now);
    const note = ev.message ? ` ${ev.message}` : '';   // e.g. "Update Riyeser Central to keep your plan up to date."
    if (m.active && m.status === 'trial') return out({ licensed: true, mode: 'trial', daysLeft: m.daysLeft, source: 'online', message: ev.message || null });
    if (m.active) return out({ licensed: true, mode: 'licensed', daysLeft: m.daysLeft, paidUntil: m.paidUntil, source: 'online', message: ev.message || null });
    const why = m.status === 'cancelled' ? `Payroll isn't on your Riyeser plan right now. ${STILL} ${ADD}` : ENDED;
    return out({ licensed: false, mode: 'ended', source: 'online', message: `${why}${note}` });
  }
  if (ev.state === 'invalid') {
    // no licence: a PC that has had a real plan from Riyeser gets no new local trial
    const t = signed.localTrial({ appData, ownDir, now });
    if (!t.linked && t.active) return out({ licensed: true, mode: 'trial', daysLeft: t.daysLeft, source: 'local', problem: ev.problem, message: ev.message });
    return out({ licensed: false, mode: 'ended', source: 'online', problem: ev.problem, message: `${ev.message} ${STILL} ${ADD}` });
  }
  const t = signed.localTrial({ appData, ownDir, now });
  if (t.active) return out({ licensed: true, mode: 'trial', daysLeft: t.daysLeft, source: 'local', message: null });
  return out({ licensed: false, mode: 'ended', source: 'local', daysLeft: 0, message: ENDED });
}

/**
 * For the server: checked() -> status, at most every few seconds (it reads small files). enforce: false (the hosted
 * site, or demo mode) means always licensed.
 */
function checker({ enforce, appData = appDataDir(), ownDir = null, now = () => Date.now(), publicKey } = {}) {
  let last = null; let at = 0;
  return () => {
    if (!enforce) return { licensed: true, mode: 'licensed', source: 'none', message: null, homeUrl: HOME_URL, price: PRICE };
    const t = now();
    if (!last || t - at > 5000 || t < at) { last = status({ appData, ownDir, now: t, publicKey }); at = t; }
    return last;
  };
}

module.exports = { status, checker, MODULE, PRICE, HOME_URL, ENDED, DAY, appDataDir };
