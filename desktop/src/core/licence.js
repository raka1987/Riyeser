// Riyeser licence: one free trial and one licence for the whole suite, shared by every Riyeser program on this PC.
//   %APPDATA%\Riyeser\licence.json   (Riyeser Accounting reads the same file)
// Licence keys are sold and checked by Lemon Squeezy (https://docs.lemonsqueezy.com/api/license-api).
// Works offline: a key checked online stays valid for OFFLINE_GRACE_DAYS without internet.
// Nothing is ever locked or deleted by this file; it only reports where the trial / licence stands.
const fs = require('fs');
const path = require('path');
const os = require('os');

const TRIAL_DAYS = 90;
const OFFLINE_GRACE_DAYS = 30;
const RECHECK_DAYS = 3; // check a licence with Lemon Squeezy this often when online
const API = 'https://api.lemonsqueezy.com/v1/licenses';
// Set once the Riyeser store exists on Lemon Squeezy, so keys from other shops are refused.
const STORE_ID = process.env.RIYESER_LS_STORE_ID ? Number(process.env.RIYESER_LS_STORE_ID) : null;
const BUY_URL = 'https://riyeser.com/pricing.html';
const DAY = 86400000;

const licenceFile = (appData) => path.join(appData, 'Riyeser', 'licence.json');
function read(appData) { try { return JSON.parse(fs.readFileSync(licenceFile(appData), 'utf8')); } catch { return {}; } }
function write(appData, data) {
  const f = licenceFile(appData);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
  return data;
}

/** The trial starts the first time any Riyeser program asks. */
function ensureTrial(appData, now = Date.now()) {
  const d = read(appData);
  if (!d.trialStart || Number.isNaN(Date.parse(d.trialStart))) { d.trialStart = new Date(now).toISOString(); write(appData, d); }
  return d;
}

const days = (ms) => Math.max(0, Math.ceil(ms / DAY));
const mask = (key) => (key ? `${String(key).slice(0, 4)}…${String(key).slice(-4)}` : null);

/**
 * Where things stand:
 *   { mode: 'trial' | 'licensed' | 'expired', daysLeft, trialEnds, plan, email, key (masked), checkedAt, needsCheck, message }
 */
function status(appData, now = Date.now()) {
  const d = ensureTrial(appData, now);
  const trialEnds = Date.parse(d.trialStart) + TRIAL_DAYS * DAY;
  const base = { trialStart: d.trialStart, trialEnds: new Date(trialEnds).toISOString(), buyUrl: BUY_URL };
  if (d.key && d.licence) {
    const checked = Date.parse(d.licence.checkedAt || 0) || 0;
    const expiresAt = d.licence.expiresAt ? Date.parse(d.licence.expiresAt) : null;
    const offlineLeft = checked + OFFLINE_GRACE_DAYS * DAY - now;
    const active = d.licence.status === 'active' && (!expiresAt || expiresAt > now);
    if (active && offlineLeft > 0) {
      return { ...base, mode: 'licensed', plan: d.licence.plan || 'Riyeser', email: d.licence.email || null, key: mask(d.key), extraCompanies: d.licence.extraCompanies || 0,
        checkedAt: d.licence.checkedAt, needsCheck: now - checked > RECHECK_DAYS * DAY,
        message: offlineLeft < 7 * DAY ? `Connect to the internet within ${days(offlineLeft)} day(s) so your licence can be checked.` : null };
    }
    if (active) return { ...base, mode: 'expired', key: mask(d.key), needsCheck: true, message: 'Your licence needs checking. Connect to the internet and open Riyeser Central.' };
    return { ...base, mode: 'expired', key: mask(d.key), needsCheck: false, message: d.licence.status === 'expired' ? 'Your subscription has ended. Renew it to keep adding new work.' : `This licence is ${d.licence.status || 'not active'}.` };
  }
  if (now < trialEnds) return { ...base, mode: 'trial', daysLeft: days(trialEnds - now) };
  return { ...base, mode: 'expired', daysLeft: 0, message: 'Your free trial has finished. Everything you made is still here — get a licence to keep adding new work.' };
}

function fromApi(r) {
  const lk = r.license_key || {}; const meta = r.meta || {};
  return {
    status: lk.status || (r.valid || r.activated ? 'active' : 'inactive'),
    expiresAt: lk.expires_at || null,
    seats: lk.activation_limit || null,
    used: lk.activation_usage || null,
    plan: [meta.product_name, meta.variant_name].filter(Boolean).join(' · ') || null,
    email: meta.customer_email || null,
    storeId: meta.store_id || null,
    // Extra companies (Riyeser Accounting add-on, $10 a month each): set up in the shop as a variant named like "3 extra companies"
    extraCompanies: Number((String(meta.variant_name || '').match(/(\d+)\s*extra\s*compan/i) || [])[1] || 0),
  };
}
async function post(fetchFn, endpoint, params) {
  const res = await fetchFn(`${API}/${endpoint}`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  let body = {}; try { body = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, body };
}
function checkStore(info) {
  if (STORE_ID && info.storeId && Number(info.storeId) !== STORE_ID) throw new Error("That key isn't a Riyeser licence.");
}

/** Turn on a licence key on this PC (needs internet once). */
async function activate(appData, key, { fetchFn = globalThis.fetch, instanceName = os.hostname(), now = Date.now() } = {}) {
  key = String(key || '').trim();
  if (!/^[A-Za-z0-9-]{8,}$/.test(key)) throw new Error('That doesn\'t look like a licence key. Copy it from your receipt email.');
  let r;
  try { r = await post(fetchFn, 'activate', { license_key: key, instance_name: instanceName }); } catch { throw new Error('No internet connection. Connect once to turn on your licence; after that it works offline.'); }
  if (!r.body.activated) {
    const why = String(r.body.error || '');
    if (/limit/i.test(why)) throw new Error('This licence is already in use on its maximum number of computers. Remove it from another PC, or add users to your plan.');
    throw new Error(why ? `Licence not accepted: ${why}` : 'Licence not accepted. Check the key and try again.');
  }
  const info = fromApi(r.body); checkStore(info);
  const d = read(appData);
  d.key = key; d.instanceId = r.body.instance && r.body.instance.id;
  d.licence = { ...info, checkedAt: new Date(now).toISOString() };
  write(appData, d);
  return status(appData, now);
}

/** Re-check the licence online (quietly does nothing when offline). */
async function recheck(appData, { fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  const d = read(appData);
  if (!d.key) return status(appData, now);
  let r;
  try { r = await post(fetchFn, 'validate', { license_key: d.key, ...(d.instanceId ? { instance_id: d.instanceId } : {}) }); } catch { return status(appData, now); }
  if (r.body && (r.body.valid !== undefined || r.body.license_key)) {
    const info = fromApi(r.body);
    d.licence = { ...d.licence, ...info, status: r.body.valid ? (info.status || 'active') : (info.status === 'active' ? 'inactive' : info.status), checkedAt: new Date(now).toISOString() };
    write(appData, d);
  }
  return status(appData, now);
}

/** Take the licence off this PC (frees a seat). The trial date is kept. */
async function remove(appData, { fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  const d = read(appData);
  if (d.key && d.instanceId) { try { await post(fetchFn, 'deactivate', { license_key: d.key, instance_id: d.instanceId }); } catch { /* offline: still remove here */ } }
  delete d.key; delete d.instanceId; delete d.licence;
  write(appData, d);
  return status(appData, now);
}

module.exports = { TRIAL_DAYS, OFFLINE_GRACE_DAYS, BUY_URL, licenceFile, read, ensureTrial, status, activate, recheck, remove };
