// S58: Riyeser Central checks every installer it downloads before running it.
//
// Each release can carry installers.sig.json: the SHA-256 of every installer in it, signed with Ed25519 the same way
// Riyeser signs licences (canonical JSON of everything except "sig"; core/signed-licence.js). Only Riyeser holds the
// private key (the release workflow's secret RIYESER_RELEASE_SIGNING_KEY); the public key is built into Central when
// it's built (release-public-key.txt next to this file, from RIYESER_RELEASE_PUBLIC_KEY; scripts/package-win.js).
//
// The rule, so a release can't push an installer nobody signed:
//   1. A Central with the public key built in runs an installer ONLY when the release's signed list verifies and
//      names that file with the same SHA-256 and size. No list, a bad signature or a different hash: not run.
//   2. A Central built before release signing (no key) can't check a signature. It still checks the SHA-256 GitHub
//      publishes for each release file when there is one (catches a damaged or swapped download), and otherwise
//      installs as before. Once one signed release is out, every Central built from then on follows rule 1.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonical, verifySignature, publicKeyObject } = require('../core/signed-licence');

const MANIFEST = 'installers.sig.json';
const KIND = 'riyeser-installers';

let keyForTests = null;
function useKeyForTests(k) { keyForTests = k; }
/** The release public key built into this Central ('' before release signing was switched on). */
function builtInKey(dir = __dirname) {
  if (keyForTests !== null) return keyForTests;
  try { const k = fs.readFileSync(path.join(dir, 'release-public-key.txt'), 'utf8').trim(); return publicKeyObject(k) ? k : ''; } catch { return ''; }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

/** Make the signed list (used by scripts/sign-installers.js in the release workflow, and by the tests). */
function signManifest(files, privateKey, { tag = '', now = Date.now() } = {}) {
  const env = { kind: KIND, tag: String(tag), issued_at: new Date(now).toISOString(), files };
  return { ...env, sig: crypto.sign(null, Buffer.from(canonical(env), 'utf8'), privateKey).toString('base64') };
}

const REFUSED = 'This download couldn\'t be checked as a genuine Riyeser installer, so it wasn\'t run. Nothing was changed. Try again later, or download it from riyeser.com.';

/**
 * Is this downloaded installer the one Riyeser published?
 * { file, name (the release file name), manifest (installers.sig.json, or null), digest (GitHub's "sha256:…" or null),
 *   publicKey (default: built in) } -> { ok, how: 'signed' | 'github-digest' | 'unchecked', error }
 */
async function checkInstaller({ file, name, manifest = null, digest = null, publicKey }) {
  const key = publicKey === undefined ? builtInKey() : publicKey;
  const hash = await sha256File(file);
  const size = fs.statSync(file).size;
  if (key) {
    if (!manifest || typeof manifest !== 'object') return { ok: false, how: 'signed', error: REFUSED, problem: 'no-list' };
    if (manifest.kind !== KIND || !verifySignature(manifest, key)) return { ok: false, how: 'signed', error: REFUSED, problem: 'signature' };
    const entry = manifest.files && manifest.files[name];
    if (!entry || typeof entry.sha256 !== 'string') return { ok: false, how: 'signed', error: REFUSED, problem: 'not-listed' };
    if (entry.sha256.toLowerCase() !== hash) return { ok: false, how: 'signed', error: REFUSED, problem: 'hash' };
    if (entry.size != null && Number(entry.size) !== size) return { ok: false, how: 'signed', error: REFUSED, problem: 'size' };
    return { ok: true, how: 'signed', sha256: hash };
  }
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || ''));
  if (m) {
    if (m[1].toLowerCase() !== hash) return { ok: false, how: 'github-digest', error: 'The download was damaged (its checksum doesn\'t match). Nothing was changed. Please try again.', problem: 'hash' };
    return { ok: true, how: 'github-digest', sha256: hash };
  }
  return { ok: true, how: 'unchecked', sha256: hash };
}

module.exports = { MANIFEST, KIND, REFUSED, builtInKey, useKeyForTests, sha256File, signManifest, checkInstaller };
