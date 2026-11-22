// Builds the Windows installers (Setup.exe) for both apps.
// Usage: node scripts/package-win.js            (both)   |   node scripts/package-win.js pdf | assistant
// On Linux/macOS this needs Wine installed (electron-builder uses it to stamp the icon and build the uninstaller).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });

run('node', ['scripts/vendor.js']);
// .ico files in the format Windows expects (BMP small sizes + PNG 256), if Python is available.
for (const [src, out] of [['build/icon.png', 'build/icon.ico'], ['build/pdf/icon.png', 'build/pdf/icon.ico'], ['build/central/icon.png', 'build/central/icon.ico'], ['build/services/icon.png', 'build/services/icon.ico']]) {
  try { run(process.platform === 'win32' ? 'python' : 'python3', ['scripts/make-ico.py', src, out]); } catch { console.warn('Python not found - using the existing .ico files'); }
}
fs.copyFileSync(path.join(root, 'build/icon.ico'), path.join(root, 'src/renderer/icon.ico'));
fs.copyFileSync(path.join(root, 'build/pdf/icon.ico'), path.join(root, 'src/renderer/icon-pdf.ico'));
fs.copyFileSync(path.join(root, 'build/central/icon.ico'), path.join(root, 'src/renderer/icon-central.ico'));
fs.copyFileSync(path.join(root, 'build/services/icon.ico'), path.join(root, 'src/renderer/icon-services.ico'));

// Riyeser Services' own copy of the app: the riyeser.com build, kept inside the installer so it works offline.
if (!process.argv[2] || process.argv[2] === 'services') {
  const site = path.join(root, '..', 'website');
  run('node', [path.join(site, 'build-combined.mjs')]);
  fs.rmSync(path.join(root, 'build', 'services-web'), { recursive: true, force: true });
  fs.cpSync(path.join(site, 'public'), path.join(root, 'build', 'services-web'), { recursive: true });
}

const only = process.argv[2];
for (const app of ['assistant', 'pdf', 'central', 'services'].filter((a) => !only || a === only)) {
  const out = app === 'assistant' ? 'dist' : `dist-${app}`;
  fs.rmSync(path.join(root, out), { recursive: true, force: true });
  run('npx', ['electron-builder', '--win', '--config', 'scripts/builder.config.js'], { DESK_APP: app });
}
