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
const guard = require('./trial-guard');

const MODULE = 'payroll';
const PRICE = 'US$25/month';   // keep in step with riyeser.com's price for Payroll (pricing v2: unchanged)
// What the price includes (pricing v2): 3 office users (who run pay or approve timesheets), unlimited employees.
const INCLUDES = '3 office users included, unlimited employees';
const HOME_URL = 'https://riyeser.com/link/';   // the Riyeser home page, where Payroll is added to the plan
const STILL = 'You can still see and print everything.';
const ADD = `To run new pay runs, add Payroll from your Riyeser home page (${PRICE}, ${INCLUDES}).`;
const ENDED = `Payroll's free trial has ended. ${STILL} ${ADD}`;
const DAY = 86400000;
// OWNER-BANNER: an unsigned plan (Central not signed in or linked since a fresh start, or an older Central) counts for
// 14 days. Say what actually fixes it, and until when (the last day, in Fiji time like the rest of Payroll).
const lastDay = (ms) => new Date(ms - 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Pacific/Fiji' });
const REFRESH = (until) => `Open Riyeser Central and sign in to your Riyeser account to refresh your plan (until ${lastDay(until)}).`;
const REFRESH_LATE = 'Your plan couldn\'t be confirmed: open Riyeser Central and sign in to your Riyeser account to refresh it.';

const appDataDir = (env = process.env) => env.APPDATA || path.join(os.homedir(), '.config');   // as Accounting and demo.js

/**
 * The shared free trial: the earliest date in licence.json, the markers and trial-guard.js's places (the registry, company
 * files, Riyeser online's anonymous PC record), counted from the latest time seen; kept in all of them.
 */
function suiteTrial({ appData, ownDir, now, write = true }) {
  const t = signed.localTrial({ appData, ownDir, now, write, extra: guard.extraFor(appData, 'suite') });
  if (write) guard.record(appData, 'suite', { start: t.start, latest: t.seen, now });
  return t;
}

/**
 * Payroll's records file is open (the Windows program, not demo mode): an older trial stamp in it (records restored from
 * an older install) is passed on to this PC, and the trial's start is stamped into it. Never throws.
 */
function syncCompanyStamp(db, { appData = appDataDir(), ownDir = null, now = Date.now(), demo = false } = {}) {
  if (demo || !db) return null;
  try {
    db.exec('CREATE TABLE IF NOT EXISTS trial_stamp (program TEXT PRIMARY KEY, trial_start TEXT NOT NULL, stamped_at TEXT NOT NULL)');
    const row = db.prepare('SELECT trial_start FROM trial_stamp WHERE program = ?').get('suite');
    const stamp = row ? Date.parse(row.trial_start) : NaN;
    if (Number.isFinite(stamp) && stamp >= guard.MIN_DATE) guard.record(appData, 'suite', { companyFile: stamp, now });
    const t = suiteTrial({ appData, ownDir, now });
    const start = guard.earliest([t.start, Number.isFinite(stamp) ? stamp : null]);
    if (!(Number.isFinite(stamp) && stamp <= start)) {
      db.prepare('INSERT INTO trial_stamp (program, trial_start, stamped_at) VALUES (?, ?, ?) ON CONFLICT(program) DO UPDATE SET trial_start = excluded.trial_start, stamped_at = excluded.stamped_at')
        .run('suite', new Date(start).toISOString(), new Date(now).toISOString());
    }
    return start;
  } catch { return null; }   // a read-only file: the other places still count
}

/**
 * Where Payroll's licence stands.
 * opts: { appData, ownDir (Payroll's own data folder: a second place for the trial's first-run date), now, publicKey }
 * -> { licensed (new pay runs allowed), mode: 'trial' | 'licensed' | 'ended', daysLeft, source, problem, message, homeUrl, price }
 */
function status({ appData = appDataDir(), ownDir = null, now = Date.now(), publicKey } = {}) {
  const out = (o) => ({ homeUrl: HOME_URL, price: PRICE, problem: null, ...o });
  let ev = signed.check({ appData, ownDir, now, ...(publicKey !== undefined ? { publicKey } : {}) });
  if (ev.state === 'trusted' || ev.state === 'unsigned') {
    if (!(now < ev.expiresAt)) {
      return out({ licensed: false, mode: 'ended', source: 'online', problem: 'expired', message: `${signed.MESSAGES.expired} ${STILL} ${ADD}` });
    }
    const m = signed.moduleState(ev.plan, MODULE, now);
    const grace = ev.problem === 'unsigned' ? { graceUntil: new Date(ev.expiresAt).toISOString() } : {};
    const info = ev.problem === 'unsigned' ? REFRESH(ev.expiresAt) : ev.message;
    const note = info ? ` ${info}` : '';   // e.g. "Update Riyeser Central to keep your plan up to date."
    if (m.active && m.status === 'trial') return out({ licensed: true, mode: 'trial', daysLeft: m.daysLeft, source: 'online', message: info || null, ...grace });
    if (m.active) return out({ licensed: true, mode: 'licensed', daysLeft: m.daysLeft, paidUntil: m.paidUntil, source: 'online', message: info || null, ...grace });
    const why = m.status === 'cancelled' ? `Payroll isn't on your Riyeser plan right now. ${STILL} ${ADD}` : ENDED;
    return out({ licensed: false, mode: 'ended', source: 'online', message: `${why}${note}`, ...grace });
  }
  if (ev.state === 'invalid') {
    if (ev.problem === 'unsigned') ev = { ...ev, message: REFRESH_LATE };
    // no licence: a PC that has had a real plan from Riyeser gets no new local trial
    const t = suiteTrial({ appData, ownDir, now });
    if (!t.linked && t.active) return out({ licensed: true, mode: 'trial', daysLeft: t.daysLeft, source: 'local', problem: ev.problem, message: ev.message });
    return out({ licensed: false, mode: 'ended', source: 'online', problem: ev.problem, message: `${ev.message} ${STILL} ${ADD}` });
  }
  const t = suiteTrial({ appData, ownDir, now });
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

module.exports = { status, checker, MODULE, PRICE, HOME_URL, ENDED, DAY, appDataDir, suiteTrial, syncCompanyStamp };
