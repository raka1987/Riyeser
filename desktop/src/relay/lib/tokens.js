// The relay's keys, all derived from the one relay secret (shared by the relays of the cluster and the database):
//   turn secret  hex(HMAC-SHA256(secret, "turn"))          coturn's static-auth-secret (the TURN REST API)
//   office key   HMAC-SHA256(secret, "office-token")       signs Link Office tokens (link_relay_token in team-chat.sql)
//   device key   HMAC-SHA256(secret, "device-prov")        signs one-time phone set-up links (link_relay_device_add)
//   peer key     HMAC-SHA256(secret, "peer")               relays of the cluster prove themselves to each other
//   the secret   itself                                     signs the relay's own relay_sync calls to the database
// Tokens are base64url(JSON) + "." + base64url(HMAC-SHA256(key, base64url(JSON))), made the same way in SQL.
const crypto = require('crypto');

const hmac = (key, data, alg = 'sha256') => crypto.createHmac(alg, key).update(data).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function keys(secret) {
  if (!secret || String(secret).length < 32) throw new Error('The relay secret must be at least 32 characters (setup.sh makes one).');
  return {
    secret: String(secret),
    turn: hmac(String(secret), 'turn').toString('hex'),
    office: hmac(String(secret), 'office-token'),
    device: hmac(String(secret), 'device-prov'),
    peer: hmac(String(secret), 'peer'),
  };
}

function sign(key, payload) {
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${b64u(hmac(key, body))}`;
}
/** -> { ok: true, payload } | { ok: false, why } */
function verify(key, token, now = Date.now()) {
  const m = /^([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m) return { ok: false, why: 'not a relay token' };
  const want = b64u(hmac(key, m[1]));
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]))) return { ok: false, why: 'signature' };
  let p; try { p = JSON.parse(unb64u(m[1]).toString('utf8')); } catch { return { ok: false, why: 'not a relay token' }; }
  if (!p || typeof p !== 'object') return { ok: false, why: 'not a relay token' };
  if (!(Number(p.exp) * 1000 > now)) return { ok: false, why: 'expired', payload: p };
  return { ok: true, payload: p };
}

/** TURN REST API credentials (what coturn's use-auth-secret checks): username "<expiry>:<id>". */
function turnCredentials(turnSecret, id, ttl = 12 * 3600, now = Date.now()) {
  const username = `${Math.floor(now / 1000) + ttl}:${id}`;
  return { username, credential: hmac(turnSecret, username, 'sha1').toString('base64'), ttl };
}
/** The same check coturn makes (for tests and diagnostics). */
function turnCheck(turnSecret, username, credential, now = Date.now()) {
  const exp = Number(String(username).split(':')[0]);
  if (!(exp * 1000 > now)) return false;
  const want = hmac(turnSecret, String(username), 'sha1').toString('base64');
  return want.length === String(credential).length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(credential)));
}

/** relay_sync's signature: HMAC-SHA256(secret, "<relay id>|<unix seconds>") in hex. */
const syncSig = (secret, relay, ts) => hmac(secret, `${relay}|${ts}`).toString('hex');
/** A relay proving itself to another relay of the cluster: "<id>.<ts>.<hex hmac>" (valid 5 minutes). */
const peerAuth = (peerKey, id, ts = Math.floor(Date.now() / 1000)) => `${id}.${ts}.${hmac(peerKey, `peer|${id}|${ts}`).toString('hex')}`;
function peerCheck(peerKey, text, now = Date.now()) {
  const m = /^([a-z0-9-]{1,40})\.(\d{9,11})\.([0-9a-f]{64})$/.exec(String(text || ''));
  if (!m || Math.abs(now / 1000 - Number(m[2])) > 300) return null;
  const want = hmac(peerKey, `peer|${m[1]}|${m[2]}`).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[3])) ? m[1] : null;
}

module.exports = { keys, sign, verify, turnCredentials, turnCheck, syncSig, peerAuth, peerCheck, b64u, unb64u, hmac };
