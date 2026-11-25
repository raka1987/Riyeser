// S58: Central runs a downloaded installer only when it's the one Riyeser published.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const check = require('../src/central/installer-check');
const updates = require('../src/central/updates');
const { signFolder, keyFromEnv } = require('../scripts/sign-installers');

const kp = crypto.generateKeyPairSync('ed25519');
const jwk = kp.privateKey.export({ format: 'jwk' });
const ENV_KEY = Buffer.from(JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x })).toString('base64url');
const PUB = Buffer.from(jwk.x, 'base64url').toString('base64');
const OTHER = crypto.generateKeyPairSync('ed25519').privateKey;

function release() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
  fs.writeFileSync(path.join(dir, 'RiyeserPDF-Setup.exe'), Buffer.from('MZ genuine PDF installer'));
  fs.writeFileSync(path.join(dir, 'RiyeserCentral-Setup.exe'), Buffer.from('MZ genuine Central installer'));
  return dir;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('S58: the release workflow\'s signing script makes a list that Central accepts', async () => {
  const dir = release();
  const keys = keyFromEnv(ENV_KEY);
  assert.strictEqual(keys.publicKey, PUB);
  const m = await signFolder(dir, 'riyeser-2026.11.25-1', keys);
  assert.deepStrictEqual(Object.keys(m.files), ['RiyeserCentral-Setup.exe', 'RiyeserPDF-Setup.exe']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, check.MANIFEST), 'utf8'));
  const r = await check.checkInstaller({ file: path.join(dir, 'RiyeserPDF-Setup.exe'), name: 'RiyeserPDF-Setup.exe', manifest: saved, publicKey: PUB });
  assert.deepStrictEqual([r.ok, r.how], [true, 'signed']);
});

test('S58: with the key built in, a changed installer, an unlisted one, a forged list or no list is refused', async () => {
  const dir = release(); const m = await signFolder(dir, 't', keyFromEnv(ENV_KEY));
  const file = path.join(dir, 'RiyeserPDF-Setup.exe');
  const run = (over = {}) => check.checkInstaller({ file, name: 'RiyeserPDF-Setup.exe', manifest: m, publicKey: PUB, ...over });
  // someone with release access swaps the file (and even GitHub's checksum matches the new file)
  fs.writeFileSync(file, Buffer.from('MZ evil'));
  let r = await run({ digest: `sha256:${sha(Buffer.from('MZ evil'))}` });
  assert.deepStrictEqual([r.ok, r.problem], [false, 'hash']); assert.match(r.error, /wasn't run\. Nothing was changed/);
  fs.writeFileSync(file, Buffer.from('MZ genuine PDF installer'));
  assert.ok((await run()).ok);
  // listed under another name
  assert.strictEqual((await run({ name: 'RiyeserPayroll-Setup.exe' })).problem, 'not-listed');
  // the list edited to match the evil file
  const edited = JSON.parse(JSON.stringify(m)); edited.files['RiyeserPDF-Setup.exe'].sha256 = sha(Buffer.from('MZ evil'));
  assert.strictEqual((await run({ manifest: edited })).problem, 'signature');
  // a list signed with someone else's key
  const forged = check.signManifest(m.files, OTHER);
  assert.strictEqual((await run({ manifest: forged })).problem, 'signature');
  // a release with no signed list
  assert.strictEqual((await run({ manifest: null })).problem, 'no-list');
});

test('S58: before release signing (no key built in): GitHub\'s SHA-256 is checked when there is one, else as before', async () => {
  const dir = release(); const file = path.join(dir, 'RiyeserPDF-Setup.exe');
  const good = `sha256:${sha(fs.readFileSync(file))}`;
  assert.deepStrictEqual(await check.checkInstaller({ file, name: 'RiyeserPDF-Setup.exe', digest: good, publicKey: '' }).then((r) => [r.ok, r.how]), [true, 'github-digest']);
  const bad = await check.checkInstaller({ file, name: 'RiyeserPDF-Setup.exe', digest: `sha256:${'0'.repeat(64)}`, publicKey: '' });
  assert.deepStrictEqual([bad.ok, bad.problem], [false, 'hash']); assert.match(bad.error, /damaged/);
  assert.deepStrictEqual(await check.checkInstaller({ file, name: 'RiyeserPDF-Setup.exe', publicKey: '' }).then((r) => [r.ok, r.how]), [true, 'unchecked']);
});

test('S58: the release\'s signed list and each file\'s GitHub digest reach the install step', () => {
  const base = 'https://github.com/raka1987/Riyeser/releases/download/riyeser-1/';
  const rel = { tag_name: 'riyeser-1', body: '- Riyeser PDF 0.25.0', assets: [
    { name: 'RiyeserPDF-Setup.exe', browser_download_url: `${base}RiyeserPDF-Setup.exe`, size: 10, digest: 'sha256:abc' },
    { name: 'installers.sig.json', browser_download_url: `${base}installers.sig.json`, size: 1 },
  ] };
  const latest = updates.latestFromRelease(rel);
  assert.strictEqual(latest.manifestUrl, `${base}installers.sig.json`);
  assert.deepStrictEqual([latest.products.pdf.name, latest.products.pdf.digest], ['RiyeserPDF-Setup.exe', 'sha256:abc']);
  const u = updates.availableUpdates({ pdf: '0.24.1' }, latest)[0];
  assert.deepStrictEqual([u.file, u.digest], ['RiyeserPDF-Setup.exe', 'sha256:abc']);
  // and Central checks before it runs anything
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'central-main.js'), 'utf8');
  for (const fn of ['async function installProgram', 'async function installUpdates']) {
    const body = main.slice(main.indexOf(fn), main.indexOf('\n}\n', main.indexOf(fn)));
    assert.ok(body.indexOf('verifyDownload(') > 0 && body.indexOf('verifyDownload(') < body.indexOf('runInstaller(') && body.indexOf('verifyDownload(') < body.indexOf("'cmd.exe'") + (fn.includes('Updates') ? 0 : 1e9), `${fn} checks before running`);
  }
});
