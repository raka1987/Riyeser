// S58: sign the list of installers in a release (installers.sig.json), for Riyeser Central to check before it runs one.
//
//   node scripts/sign-installers.js <folder> [tag]     writes <folder>/installers.sig.json for every .exe in <folder>
//   node scripts/sign-installers.js --public-key       prints the public key to build into Central
//
// The private key comes from the environment variable RIYESER_RELEASE_SIGNING_KEY: base64url of the Ed25519 JWK
// {"kty":"OKP","crv":"Ed25519","d":…,"x":…} (the same shape as the licence function's LICENCE_SIGNING_KEY, but a
// separate key). It's never written to a file or printed. Only the public key is printed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const check = require('../src/central/installer-check');

function keyFromEnv(v = process.env.RIYESER_RELEASE_SIGNING_KEY) {
  if (!v) throw new Error('RIYESER_RELEASE_SIGNING_KEY isn\'t set.');
  const j = JSON.parse(Buffer.from(String(v).trim(), 'base64url').toString('utf8'));
  const privateKey = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: j.d, x: j.x }, format: 'jwk' });
  const publicKey = Buffer.from(j.x, 'base64url').toString('base64');
  return { privateKey, publicKey };
}

async function signFolder(dir, tag, keys = keyFromEnv(), now = Date.now()) {
  const files = {};
  for (const name of fs.readdirSync(dir).filter((n) => /\.exe$/i.test(n)).sort()) {
    const f = path.join(dir, name);
    files[name] = { sha256: await check.sha256File(f), size: fs.statSync(f).size };
  }
  if (!Object.keys(files).length) throw new Error(`No installers in ${dir}`);
  const manifest = check.signManifest(files, keys.privateKey, { tag, now });
  // check it before it's published, with the public key Central is built with
  for (const name of Object.keys(files)) {
    const r = await check.checkInstaller({ file: path.join(dir, name), name, manifest, publicKey: keys.publicKey });
    if (!r.ok) throw new Error(`Signed list check failed for ${name}: ${r.problem}`);
  }
  fs.writeFileSync(path.join(dir, check.MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  (async () => {
    const keys = keyFromEnv();
    if (process.argv[2] === '--public-key') { process.stdout.write(keys.publicKey); return; }
    const dir = process.argv[2]; if (!dir) throw new Error('Usage: node scripts/sign-installers.js <folder> [tag]');
    const m = await signFolder(dir, process.argv[3] || '', keys);
    console.log(`Signed ${Object.keys(m.files).length} installers into ${path.join(dir, check.MANIFEST)}. Public key: ${keys.publicKey}`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { keyFromEnv, signFolder };
