// Riyeser plan: one Riyeser account and one plan for the whole suite, shared by every Riyeser program on this PC.
//   %APPDATA%\Riyeser\licence.json   what this PC is allowed (every program reads it; Riyeser Accounting too)
//   %APPDATA%\Riyeser\account.json   the sign-in, sealed with Windows' own encryption where available
//
// How it works:
//   1. The customer signs in with their email and a 6-digit code (no password).
//   2. Central asks the Riyeser server (Supabase function "plan") what they've paid for, when it opens and every few hours.
//   3. The server answers with a signed plan pass. Central checks the signature with the public key below and writes
//      licence.json. A pass works 30 days offline. Editing the file by hand breaks the signature, so it's ignored.
//   4. Subscribe / Manage plan open Paddle's checkout or customer portal in the browser. Paddle tells the server about
//      every payment, renewal and cancellation, so the next check picks it up without anyone doing anything.
//
// Free use: Central, PDF and Desk Assistant are always free. Each paid program is free up to a cap (caps come from the
// server, see DEFAULT_CAPS) and Accounting Plus is also free for its first 90 days. The programs count their own use.
// Nothing is ever locked or deleted by this file; it only reports where the plan stands.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PLUS_TRIAL_DAYS = 90;
const OFFLINE_GRACE_DAYS = 30;
const RECHECK_HOURS = 6;
const DEFAULT_CAPS = { basic: 50, pos: 500, payroll: 4, asbuilt: 3, plusTrialDays: PLUS_TRIAL_DAYS, warnAt: 0.8 };
const PRODUCTS = { basics: 'Accounting Basics', plus: 'Accounting Plus', pos: 'POS', payroll: 'Payroll', asbuilt: 'As Built' };
const BUY_URL = 'https://riyeser.com/pricing.html';
const DAY = 86400000;

// The Riyeser server. Empty until the Supabase project exists (see server/README.md); until then Central
// shows "coming soon" for sign-in and everything else keeps working.
function cloud() {
  let c = {}; try { c = require('./cloud.json'); } catch { /* not set up */ }
  return {
    url: process.env.RIYESER_CLOUD_URL || c.supabaseUrl || '',
    anonKey: process.env.RIYESER_CLOUD_KEY || c.anonKey || '',
    passPublicKey: process.env.RIYESER_PASS_KEY || c.passPublicKey || '',
  };
}
const configured = (c = cloud()) => !!(c.url && c.anonKey && c.passPublicKey);

const dir = (appData) => path.join(appData, 'Riyeser');
const licenceFile = (appData) => path.join(dir(appData), 'licence.json');
const accountFile = (appData) => path.join(dir(appData), 'account.json');
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
  return data;
}
const read = (appData) => readJson(licenceFile(appData));
const write = (appData, d) => writeJson(licenceFile(appData), d);

// The sign-in tokens. `seal`/`unseal` come from Electron's safeStorage in Central; plain text in tests.
const plain = { seal: (s) => s, unseal: (s) => s };
function readAccount(appData, box = plain) {
  const a = readJson(accountFile(appData));
  if (!a.sealed) return a;
  try { return { email: a.email, ...JSON.parse(box.unseal(a.sealed)) }; } catch { return { email: a.email }; }
}
function writeAccount(appData, acc, box = plain) {
  if (!acc) { try { fs.unlinkSync(accountFile(appData)); } catch { /* already gone */ } return; }
  const { email, ...secret } = acc;
  writeJson(accountFile(appData), { email, sealed: box.seal(JSON.stringify(secret)) });
}

/** First run: the Accounting Plus trial date and a random id for this PC (never the PC's serial or anything personal). */
function ensureTrial(appData, now = Date.now()) {
  const d = read(appData); let changed = false;
  if (!d.trialStart || Number.isNaN(Date.parse(d.trialStart))) { d.trialStart = new Date(now).toISOString(); changed = true; }
  if (!d.deviceId) { d.deviceId = crypto.randomUUID(); changed = true; }
  if (changed) write(appData, d);
  return d;
}

// ---------- the signed plan pass ----------
function verifySigned(signed, publicKeyB64) {
  if (!signed || typeof signed.pass !== 'string' || !signed.sig || !publicKeyB64) return null;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, Buffer.from(signed.pass), key, Buffer.from(signed.sig, 'base64'))) return null;
    return JSON.parse(signed.pass);
  } catch { return null; }
}

const days = (ms) => Math.max(0, Math.ceil(ms / DAY));
const paidNames = (products) => Object.entries(products || {}).filter(([, p]) => p.paid).map(([id]) => PRODUCTS[id] || id);

/**
 * Where things stand:
 *   { mode: 'licensed' | 'trial' | 'free' | 'expired', configured, signedIn, email, products, caps, plan,
 *     extraCompanies, extraUsers, trialEnds, daysLeft, checkedAt, needsCheck, message }
 *   licensed  at least one paid program (a valid, signed pass that's less than 30 days old)
 *   trial     nothing paid yet; still inside the Accounting Plus 90-day trial
 *   free      nothing paid; free programs and free allowances only
 *   expired   signed in with a pass that's too old to trust: connect to the internet
 */
function status(appData, now = Date.now(), c = cloud()) {
  const d = ensureTrial(appData, now);
  const acc = readAccount(appData);
  const trialEnds = Date.parse(d.trialStart) + PLUS_TRIAL_DAYS * DAY;
  const base = { configured: configured(c), signedIn: !!acc.refreshToken, email: acc.email || null, trialStart: d.trialStart,
    trialEnds: new Date(trialEnds).toISOString(), daysLeft: days(trialEnds - now), buyUrl: BUY_URL, caps: { ...DEFAULT_CAPS }, products: {} };
  const pass = verifySigned(d.signed, c.passPublicKey);
  if (pass) {
    const checked = Date.parse(pass.issuedAt) || 0;
    const fresh = now < (Date.parse(pass.validUntil) || checked + OFFLINE_GRACE_DAYS * DAY);
    const products = {};
    for (const [id, p] of Object.entries(pass.products || {})) products[id] = { ...p, paid: !!(fresh && p.paid && (!p.until || Date.parse(p.until) > now)) };
    const names = paidNames(products);
    const out = { ...base, email: pass.email || base.email, caps: { ...DEFAULT_CAPS, ...(pass.caps || {}) }, products,
      extraCompanies: pass.extraCompanies || 0, extraUsers: pass.extraUsers || 0, checkedAt: pass.issuedAt,
      needsCheck: now - checked > RECHECK_HOURS * 3600000, plan: names.join(' + ') || null };
    const failed = Object.values(products).find((p) => p.paid && p.warning === 'payment_failed');
    const offlineLeft = (Date.parse(pass.validUntil) || 0) - now;
    if (!fresh) return { ...out, mode: 'expired', needsCheck: true, message: 'Connect to the internet and open Riyeser Central so your plan can be checked.' };
    if (names.length) {
      return { ...out, mode: 'licensed',
        message: failed ? `Your last payment didn't go through. Update your card under Manage plan before ${new Date(failed.until).toLocaleDateString()} to keep going.`
          : offlineLeft < 7 * DAY ? `Connect to the internet within ${days(offlineLeft)} day(s) so your plan can be checked.` : null };
    }
    return { ...out, mode: now < trialEnds ? 'trial' : 'free' };
  }
  return { ...base, mode: now < trialEnds ? 'trial' : 'free', needsCheck: base.signedIn };
}

// ---------- talking to the server ----------
async function call(fetchFn, c, endpoint, { body, token, method = 'POST' } = {}) {
  let res;
  try {
    res = await fetchFn(`${c.url}${endpoint}`, {
      method, headers: { apikey: c.anonKey, 'Content-Type': 'application/json', Authorization: `Bearer ${token || c.anonKey}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { const e = new Error('No internet connection. Connect and try again.'); e.offline = true; throw e; }
  let data = {}; try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) { const e = new Error(data.error_description || data.msg || data.error || data.message || `The Riyeser server said ${res.status}.`); e.status = res.status; throw e; }
  return data;
}
function needCloud(c) { if (!configured(c)) throw new Error('Riyeser accounts are coming soon. Everything keeps working in the meantime.'); }
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const session = (r, email) => ({ email: (r.user && r.user.email) || email, accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: Date.now() + (r.expires_in || 3600) * 1000 });

/** Step 1 of signing in: email them a 6-digit code. Also makes the account the first time. */
async function startSignIn(appData, email, { fetchFn = globalThis.fetch, c = cloud() } = {}) {
  needCloud(c); email = String(email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new Error("That doesn't look like an email address.");
  await call(fetchFn, c, '/auth/v1/otp', { body: { email, create_user: true } });
  return { sent: true, email };
}

/** Step 2: check the code, keep the sign-in, and fetch the plan. */
async function finishSignIn(appData, email, code, { fetchFn = globalThis.fetch, c = cloud(), box = plain, device = {}, now = Date.now() } = {}) {
  needCloud(c); email = String(email || '').trim().toLowerCase(); code = String(code || '').replace(/\D/g, '');
  if (code.length < 6) throw new Error('Type the 6-digit code from the email.');
  let r;
  try { r = await call(fetchFn, c, '/auth/v1/verify', { body: { type: 'email', email, token: code } }); } catch (e) {
    if (e.offline) throw e;
    throw new Error('That code didn\'t work. It may have expired: ask for a new one.');
  }
  writeAccount(appData, session(r, email), box);
  return recheck(appData, { fetchFn, c, box, device, now, force: true });
}

async function accessToken(appData, fetchFn, c, box) {
  const acc = readAccount(appData, box);
  if (!acc.refreshToken) return null;
  if (acc.accessToken && acc.expiresAt - Date.now() > 60000) return acc.accessToken;
  try {
    const r = await call(fetchFn, c, '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: acc.refreshToken } });
    const s = session(r, acc.email); writeAccount(appData, s, box); return s.accessToken;
  } catch (e) {
    if (!e.offline && (e.status === 400 || e.status === 401)) writeAccount(appData, null); // signed out elsewhere: sign in again
    throw e;
  }
}

/** Ask the server for a fresh plan pass (quietly does nothing when offline). */
async function recheck(appData, { fetchFn = globalThis.fetch, c = cloud(), box = plain, device = {}, now = Date.now(), force = false } = {}) {
  const d = ensureTrial(appData, now);
  if (!configured(c)) return status(appData, now, c);
  try {
    const token = await accessToken(appData, fetchFn, c, box);
    if (!token) return status(appData, now, c);
    const signed = await call(fetchFn, c, '/functions/v1/plan', { token, body: { device: { id: d.deviceId, name: os.hostname(), os: `${os.platform()} ${os.release()}`, ...device } } });
    const pass = verifySigned(signed, c.passPublicKey);
    if (!pass) throw new Error('The plan from the server could not be checked. Please try again later.');
    write(appData, compatible({ ...read(appData), signed }, pass));
  } catch (e) { if (force) throw e; }
  return status(appData, now, c);
}

// Riyeser Accounting and POS (riyeser/licence.py, riyeser/plan.py) read `key` + `licence` from licence.json.
// Keep those filled in from the pass so they work unchanged; `products` and `caps` say which program is paid.
function compatible(d, pass) {
  const paid = Object.entries(pass.products || {}).filter(([, p]) => p.paid);
  const until = paid.map(([, p]) => Date.parse(p.until) || 0).reduce((a, b) => Math.max(a, b), 0);
  if (!paid.length) {
    // Nothing paid: leave `key`/`licence` out, so Accounting keeps counting the Plus trial and the free allowances.
    const { key, licence, ...rest } = d;
    return { ...rest, products: pass.products || {}, caps: { ...DEFAULT_CAPS, ...(pass.caps || {}) } };
  }
  return { ...d, key: 'riyeser-account', products: pass.products || {}, caps: { ...DEFAULT_CAPS, ...(pass.caps || {}) },
    licence: { status: paid.length ? 'active' : 'inactive', expiresAt: until ? new Date(Math.min(until, Date.parse(pass.validUntil))).toISOString() : null,
      checkedAt: pass.issuedAt, plan: paid.map(([id]) => PRODUCTS[id] || id).join(' + ') || null, email: pass.email || null,
      extraCompanies: pass.extraCompanies || 0, extraUsers: pass.extraUsers || 0 } };
}

/** A Paddle checkout link for these programs, to open in the browser. items: [{ product: 'basics', quantity: 1 }] */
async function checkout(appData, items, { interval = 'month', fetchFn = globalThis.fetch, c = cloud(), box = plain } = {}) {
  needCloud(c);
  const token = await accessToken(appData, fetchFn, c, box);
  if (!token) throw new Error('Sign in first, so your payment goes to your account.');
  const r = await call(fetchFn, c, '/functions/v1/checkout', { token, body: { items, interval } });
  return r.url;
}

/** Paddle's customer portal: change card, see receipts, cancel. */
async function portal(appData, { fetchFn = globalThis.fetch, c = cloud(), box = plain } = {}) {
  needCloud(c);
  const token = await accessToken(appData, fetchFn, c, box);
  if (!token) throw new Error('Sign in first.');
  return (await call(fetchFn, c, '/functions/v1/portal', { token })).url;
}

/** Sign out on this PC. The plan on this PC is cleared; the trial date and the PC's id are kept. */
function signOut(appData, now = Date.now()) {
  writeAccount(appData, null);
  const d = read(appData);
  for (const k of ['signed', 'key', 'licence', 'products', 'caps', 'instanceId']) delete d[k];
  write(appData, d);
  return status(appData, now);
}

module.exports = { PLUS_TRIAL_DAYS, TRIAL_DAYS: PLUS_TRIAL_DAYS, OFFLINE_GRACE_DAYS, DEFAULT_CAPS, PRODUCTS, BUY_URL, licenceFile, accountFile,
  configured, read, ensureTrial, status, startSignIn, finishSignIn, recheck, checkout, portal, signOut, verifySigned };
