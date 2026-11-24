// Signed licences: can this PC trust the company's Riyeser plan in %APPDATA%\Riyeser\licence.json?
//
// Riyeser online signs each licence with Ed25519 (the Supabase Edge Function "licence"). Only Riyeser holds the
// private key; the public key is built into each program when it's built (licence-public-key.txt next to this file).
// A licence is trusted only when the signature verifies, it's for the business in company.json, it's for this PC
// (device.json, written by Riyeser Central) when it names one, it hasn't expired, and the PC clock hasn't been put back.
//
// The same file is in Riyeser Payroll (signed-licence.js, branch module/payroll); riyeser/signed_licence.py in Riyeser Accounting and
// supabase/functions/licence in the Riyeser repo follow the same rules and the same canonical JSON. Keep them in step.
//
// Without a built-in public key (a build made before signing was switched on) everything works as before.
// Nothing here deletes anything: an untrusted licence just counts as no licence.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 86400000;
const CLOCK_SLACK_MS = 48 * 3600 * 1000;   // the PC clock may be this far behind the latest time seen
const UNSIGNED_GRACE_DAYS = 14;            // an older Central's unsigned licence still counts this long
const TRIAL_DAYS = 90;
const OFFLINE_GRACE_DAYS = 30;
const MARKER = '.riyeser-licence.json';    // kept in each program's own data folder, and in %APPDATA%\Riyeser
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

const MESSAGES = {
  update: 'Update Riyeser Central to keep your plan up to date.',
  invalid: 'Your Riyeser plan on this PC couldn\'t be checked. Open Riyeser Central and sign in to check it again.',
  expired: 'Riyeser couldn\'t check your plan for 30 days: connect to the internet and open Riyeser Central.',
  clock: 'This PC\'s date or time looks wrong. Set the clock right, then open Riyeser Central to check your plan.',
};

// ---------- canonical JSON: keys sorted (UTF-16 order), no spaces, whole numbers only ----------
function quote(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { out += s[i] + s[i + 1]; i++; }
    else if (c >= 0xd800 && c <= 0xdfff) out += `\\u${c.toString(16)}`;   // a lone surrogate
    else out += s[i];
  }
  return `${out}"`;
}
function canonical(v) {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('Canonical JSON takes whole numbers only.');
    return String(v === 0 ? 0 : v);
  }
  if (typeof v === 'string') return quote(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${quote(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  throw new Error('Canonical JSON can\'t hold that value.');
}

// ---------- Ed25519 ----------
function publicKeyObject(b64) {
  const raw = Buffer.from(String(b64 || '').trim(), 'base64');
  if (raw.length !== 32) return null;
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
}
/** The bytes a signed licence's signature covers: everything except sig, as canonical JSON. */
function signedBytes(env) {
  const rest = { ...env }; delete rest.sig;
  return Buffer.from(canonical(rest), 'utf8');
}
function verifySignature(env, publicKey) {
  try {
    if (!env || typeof env !== 'object' || typeof env.sig !== 'string') return false;
    const key = publicKeyObject(publicKey);
    const sig = Buffer.from(env.sig, 'base64');
    if (!key || sig.length !== 64) return false;
    return crypto.verify(null, signedBytes(env), key, sig);
  } catch { return false; }
}

/** The public key built into this program ('' before licence signing was switched on). */
let keyForTests = null;
function useKeyForTests(k) { keyForTests = k; }
function builtInKey(dir = __dirname) {
  if (keyForTests !== null) return keyForTests;
  try { const k = fs.readFileSync(path.join(dir, 'licence-public-key.txt'), 'utf8').trim(); return publicKeyObject(k) ? k : ''; } catch { return ''; }
}

// ---------- files ----------
const riyeserDir = (appData) => path.join(appData, 'Riyeser');
function readJson(f) { try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d && typeof d === 'object' ? d : null; } catch { return null; } }
function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}
const deviceFile = (appData) => path.join(riyeserDir(appData), 'device.json');
/** This PC's id, as Riyeser Central linked it (null when Central hasn't written it). */
function readDeviceId(appData) { const d = readJson(deviceFile(appData)); return d && typeof d.id === 'string' && d.id ? d.id : null; }
function writeDeviceId(appData, id) {
  if (readDeviceId(appData) === id) return;
  writeJson(deviceFile(appData), { id, note: 'This PC in Riyeser online. Written by Riyeser Central.' });
}
function companyWorkspace(appData) { const c = readJson(path.join(riyeserDir(appData), 'company.json')); return c && c.mode === 'online' && c.workspace_id ? String(c.workspace_id) : null; }

// Markers: the first-run date, whether a trusted plan was ever seen here, when an unsigned licence was first seen,
// and the latest time seen (for the clock check). One in each program's data folder and one in %APPDATA%\Riyeser.
function markerDirs(appData, ownDir) { return [...new Set([ownDir, riyeserDir(appData)].filter(Boolean))]; }
function hide(f) {
  if (process.platform !== 'win32') return;
  try { require('child_process').execFile('attrib', ['+h', f], { windowsHide: true }, () => {}); } catch { /* not hidden: still works */ }
}
function readMarkers(dirs) { return dirs.map((d) => readJson(path.join(d, MARKER)) || {}); }
function mergeMarkers(list) {
  const t = (s) => { const v = Date.parse(s); return Number.isFinite(v) ? v : null; };
  const min = (xs) => { const v = xs.filter((x) => x != null); return v.length ? Math.min(...v) : null; };
  const out = { firstRun: min(list.map((m) => t(m.firstRun))), linked: list.some((m) => m.linked === true), unsignedSince: min(list.map((m) => t(m.unsignedSince))), clock: null };
  // the latest time seen counts only for the newest licence it was recorded with (a new licence from Riyeser resets it)
  for (const m of list) {
    const c = m.clock; if (!c || !Number.isFinite(Number(c.latest))) continue;
    const issued = String(c.issued || '');
    if (!out.clock || issued > out.clock.issued || (issued === out.clock.issued && Number(c.latest) > out.clock.latest)) out.clock = { issued, latest: Number(c.latest) };
  }
  return out;
}
function saveMarkers(dirs, before, m) {
  const iso = (v) => (v == null ? null : new Date(v).toISOString());
  const data = { firstRun: iso(m.firstRun), linked: !!m.linked, unsignedSince: iso(m.unsignedSince), clock: m.clock };
  dirs.forEach((d, i) => {
    const old = before[i] || {};
    const same = old.firstRun === data.firstRun && !!old.linked === data.linked && (old.unsignedSince || null) === data.unsignedSince
      && old.clock && data.clock && old.clock.issued === data.clock.issued && data.clock.latest - Number(old.clock.latest) < 3600 * 1000;
    if (same) return;   // nothing new (the latest time is written at most once an hour)
    try {
      const f = path.join(d, MARKER); const isNew = !fs.existsSync(f);
      writeJson(f, data); if (isNew) hide(f);
    } catch { /* a folder we can't write: the other markers still count */ }
  });
}

/** Does this module count as on right now, going by the dates in the plan (they hold even with no internet)? */
const endOfDay = (ymd) => { const v = Date.parse(`${String(ymd).slice(0, 10)}T23:59:59Z`); return Number.isFinite(v) ? v : null; };
function moduleState(plan, mod, now = Date.now()) {
  const m = plan && plan.modules && plan.modules[mod];
  if (!m || typeof m !== 'object') return { active: false, status: 'none', daysLeft: null };
  if (!m.active) return { active: false, status: m.status || 'ended', daysLeft: 0, trialEnds: m.trial_ends || null, paidUntil: m.paid_until || null };
  const trial = m.status === 'trial';
  const end = trial ? (m.trial_ends ? endOfDay(m.trial_ends) : null) : (m.paid_until ? endOfDay(m.paid_until) : null);
  if (end != null && now > end) return { active: false, status: 'ended', daysLeft: 0, trialEnds: m.trial_ends || null, paidUntil: m.paid_until || null };
  // whole days, as Riyeser online counts them (the end date minus today's date)
  const daysLeft = end != null ? Math.max(0, Math.round((Date.parse(`${String(trial ? m.trial_ends : m.paid_until).slice(0, 10)}T00:00:00Z`) - Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`)) / DAY))
    : (m.days_left != null ? Number(m.days_left) : null);
  return { active: true, status: trial ? 'trial' : (m.status || 'active'), daysLeft, trialEnds: m.trial_ends || null, paidUntil: m.paid_until || null };
}

/**
 * Where this PC's online plan stands, after checking it can be trusted.
 * opts: { appData, ownDir (this program's data folder), now, publicKey (default: built in), write (default true) }
 * -> { state, plan, expiresAt, checkedAt, problem, message, signed }
 *   state 'trusted'   a signed licence that checks out: use plan
 *         'unsigned'  no public key built in yet (or an older Central within its 14 days): use plan as before
 *         'none'      no online plan on this PC
 *         'invalid'   edited, copied, for another business or PC, expired, clock put back, or unsigned for too long:
 *                     counts as no licence (problem says which, message says what to do)
 */
function check({ appData, ownDir = null, now = Date.now(), publicKey, write = true } = {}) {
  const key = publicKey === undefined ? builtInKey() : publicKey;
  const lic = readJson(path.join(riyeserDir(appData), 'licence.json')) || {};
  const o = lic.online && typeof lic.online === 'object' ? lic.online : null;
  const dirs = markerDirs(appData, ownDir);
  const before = readMarkers(dirs);
  const m = mergeMarkers(before);
  const done = (r) => { if (write) saveMarkers(dirs, before, m); return r; };
  if (!o) return done({ state: 'none', plan: null, problem: null, message: null });
  const checkedAt = Date.parse(o.checkedAt) || 0;
  const unsignedPlan = { ...o }; delete unsignedPlan.signed;
  if (!key) {   // before licence signing: exactly as it was
    return done({ state: 'unsigned', plan: unsignedPlan, checkedAt, expiresAt: checkedAt + OFFLINE_GRACE_DAYS * DAY, problem: null, message: null });
  }
  const s = o.signed;
  if (!s || typeof s !== 'object') {
    // an older Riyeser Central saved it: it counts for 14 days from when this program first saw it, then not
    if (m.unsignedSince == null) m.unsignedSince = now;
    const until = m.unsignedSince + UNSIGNED_GRACE_DAYS * DAY;
    if (now < until) return done({ state: 'unsigned', plan: unsignedPlan, checkedAt, expiresAt: Math.min(until, checkedAt + OFFLINE_GRACE_DAYS * DAY), problem: 'unsigned', message: MESSAGES.update });
    return done({ state: 'invalid', plan: null, problem: 'unsigned', message: MESSAGES.update });
  }
  const bad = (problem, message = MESSAGES.invalid) => done({ state: 'invalid', plan: null, problem, message });
  if (!verifySignature(s, key)) return bad('signature');
  const L = s.licence && typeof s.licence === 'object' ? s.licence : null;
  const issued = Date.parse(s.issued_at); const expires = Date.parse(s.expires_at);
  if (!L || !Number.isFinite(issued) || !Number.isFinite(expires)) return bad('signature');
  const ws = companyWorkspace(appData);
  if (!ws || ws !== String(s.workspace_id || '') || (L.workspace_id && String(L.workspace_id) !== ws)) return bad('business');
  if (s.device_id && s.device_id !== readDeviceId(appData)) return bad('device');
  // clock: the latest time seen with this licence (never earlier than when Riyeser issued it)
  const issuedIso = new Date(issued).toISOString();
  if (!m.clock || m.clock.issued < issuedIso) m.clock = { issued: issuedIso, latest: issued };
  const latest = Math.max(m.clock.latest, issued);
  if (now < latest - CLOCK_SLACK_MS) return bad('clock', MESSAGES.clock);
  m.clock.latest = Math.max(latest, now);
  m.linked = true;
  m.unsignedSince = null;
  if (now >= expires) return bad('expired', MESSAGES.expired);
  return done({ state: 'trusted', plan: { ...L, checkedAt: o.checkedAt || s.issued_at }, checkedAt: issued, expiresAt: expires, problem: null, message: null, signed: s });
}

/**
 * The local 90-day trial (a PC that has never had a trusted plan from Riyeser online). The first-run date is the
 * earlier of licence.json's trialStart and this program's own marker, so deleting one doesn't restart it, and the
 * clock can't be wound back to get days back. A PC that has never been online can't be fully protected.
 * -> { start, ends, daysLeft, active, linked }
 */
function localTrial({ appData, ownDir = null, now = Date.now(), write = true, days = TRIAL_DAYS } = {}) {
  const lf = path.join(riyeserDir(appData), 'licence.json');
  const lic = readJson(lf) || {};
  const dirs = markerDirs(appData, ownDir);
  const before = readMarkers(dirs);
  const m = mergeMarkers(before);
  const fromFile = Date.parse(lic.trialStart);
  const start = Math.min(...[Number.isFinite(fromFile) ? fromFile : null, m.firstRun, now].filter((x) => x != null));
  m.firstRun = start;
  // the clock can't be wound back for more trial days: count from the latest time seen
  const t = Math.max(now, m.clock ? m.clock.latest : 0);
  if (!m.clock || m.clock.issued === '') m.clock = { issued: '', latest: t };
  if (write) {
    saveMarkers(dirs, before, m);
    if (!Number.isFinite(fromFile) || fromFile > start) { try { writeJson(lf, { ...lic, trialStart: new Date(start).toISOString() }); } catch { /* read-only: the markers keep it */ } }
  }
  const ends = start + days * DAY;
  return { start, ends, daysLeft: Math.max(0, Math.ceil((ends - t) / DAY)), active: t < ends, linked: m.linked };
}

module.exports = { useKeyForTests, canonical, signedBytes, verifySignature, publicKeyObject, builtInKey, check, localTrial, moduleState, readDeviceId, writeDeviceId, deviceFile,
  MESSAGES, MARKER, CLOCK_SLACK_MS, UNSIGNED_GRACE_DAYS, TRIAL_DAYS, OFFLINE_GRACE_DAYS, endOfDay };
