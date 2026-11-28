// Builds the Windows installers (Setup.exe) for both apps.
// Usage: node scripts/package-win.js            (both)   |   node scripts/package-win.js pdf | assistant
// On Linux/macOS this needs Wine installed (electron-builder uses it to stamp the icon and build the uninstaller).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });

run('node', ['scripts/vendor.js']);
// The licence public key (Ed25519), built into Central and Link Office so they only trust licences Riyeser signed.
// The workflow fetches it from the licence function's /public-key; without it (signing not switched on yet) the build
// accepts unsigned licences, as before. It's a public key: nothing secret is in the build.
{
  const keyFile = path.join(root, 'src', 'core', 'licence-public-key.txt');
  const key = String(process.env.RIYESER_LICENCE_PUBLIC_KEY || '').trim();
  if (key) {
    if (Buffer.from(key, 'base64').length !== 32) throw new Error('RIYESER_LICENCE_PUBLIC_KEY isn\'t an Ed25519 public key (32 bytes, base64).');
    fs.writeFileSync(keyFile, `${key}\n`); console.log('Licence public key built in:', key);
  } else { fs.rmSync(keyFile, { force: true }); console.log('No licence public key: this build accepts unsigned licences (licence signing not switched on yet).'); }
}
// S58: the release public key (Ed25519), built into Central so it only runs installers listed in the release's signed
// installers.sig.json. Without it (release signing not switched on yet) Central checks GitHub's SHA-256 when there is one.
{
  const keyFile = path.join(root, 'src', 'central', 'release-public-key.txt');
  const key = String(process.env.RIYESER_RELEASE_PUBLIC_KEY || '').trim();
  if (key) {
    if (Buffer.from(key, 'base64').length !== 32) throw new Error('RIYESER_RELEASE_PUBLIC_KEY isn\'t an Ed25519 public key (32 bytes, base64).');
    fs.writeFileSync(keyFile, `${key}\n`); console.log('Release public key built in:', key);
  } else { fs.rmSync(keyFile, { force: true }); console.log('No release public key: installers are checked against GitHub\'s SHA-256 only (release signing not switched on yet).'); }
}
// .ico files in the format Windows expects (BMP small sizes + PNG 256), if Python is available.
for (const [src, out, sizes] of [['build/icon.png', 'build/icon.ico'], ['build/pdf/icon.png', 'build/pdf/icon.ico'], ['build/central/icon.png', 'build/central/icon.ico', '16,20,24,32,40,48,64,96,128,256'], ['build/services/icon.png', 'build/services/icon.ico'], ['build/team/icon.png', 'build/team/icon.ico'], ['build/link/icon.png', 'build/link/icon.ico']]) {
  try { run(process.platform === 'win32' ? 'python' : 'python3', ['scripts/make-ico.py', src, out, ...(sizes ? [sizes] : [])]); } catch { console.warn('Python not found - using the existing .ico files'); }
}
fs.copyFileSync(path.join(root, 'build/icon.ico'), path.join(root, 'src/renderer/icon.ico'));
fs.copyFileSync(path.join(root, 'build/pdf/icon.ico'), path.join(root, 'src/renderer/icon-pdf.ico'));
fs.copyFileSync(path.join(root, 'build/central/icon.ico'), path.join(root, 'src/renderer/icon-central.ico'));
fs.copyFileSync(path.join(root, 'build/services/icon.ico'), path.join(root, 'src/renderer/icon-services.ico'));
fs.copyFileSync(path.join(root, 'build/team/icon.ico'), path.join(root, 'src/renderer/icon-team.ico'));
fs.copyFileSync(path.join(root, 'build/link/icon.ico'), path.join(root, 'src/renderer/icon-link.ico'));

// As Built's own copy of the app: the riyeser.com build, kept inside the installer so it works offline.
if (!process.argv[2] || process.argv[2] === 'services') {
  const site = path.join(root, '..', 'website');
  run('node', [path.join(site, 'build-combined.mjs')], { ASBUILT_WEB: '1' });
  fs.rmSync(path.join(root, 'build', 'services-web'), { recursive: true, force: true });
  fs.cpSync(path.join(site, 'public'), path.join(root, 'build', 'services-web'), { recursive: true });
}

// Minify the app's own JavaScript into build/app-min/src before packaging (scripts/minify-app.js). builder.config.js
// packs that mirror instead of src/, so the shipped installers don't carry readable source once the code repository
// goes private. node_modules are left to electron-builder as usual. Done once, shared by every app below.
run('node', ['scripts/minify-app.js', path.join(root, 'src'), path.join(root, 'build', 'app-min', 'src')]);

const only = process.argv[2];
for (const app of ['assistant', 'pdf', 'central', 'services', 'team', 'linkoffice'].filter((a) => !only || a === only)) {
  const out = app === 'assistant' ? 'dist' : `dist-${app}`;
  fs.rmSync(path.join(root, out), { recursive: true, force: true });
  run('npx', ['electron-builder', '--win', '--config', 'scripts/builder.config.js'], { DESK_APP: app });
  // Riyeser Documents' installer is RiyeserDocuments-Setup; a RiyeserDeskAssistant-Setup copy keeps the old name working
  if (app === 'assistant') {
    const dir = path.join(root, out);
    for (const f of fs.readdirSync(dir).filter((n) => /^RiyeserDocuments-Setup-.*\.exe$/.test(n))) fs.copyFileSync(path.join(dir, f), path.join(dir, f.replace(/^RiyeserDocuments-/, 'RiyeserDeskAssistant-')));
  }
  // M3: Riyeser Link's installer is RiyeserLink-Setup; a RiyeserTeam-Setup copy keeps the old name working
  if (app === 'team') {
    const dir = path.join(root, out);
    for (const f of fs.readdirSync(dir).filter((n) => /^RiyeserLink-Setup-.*\.exe$/.test(n))) fs.copyFileSync(path.join(dir, f), path.join(dir, f.replace(/^RiyeserLink-/, 'RiyeserTeam-')));
  }
}
