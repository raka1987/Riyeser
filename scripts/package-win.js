// Builds the Windows downloads for both apps with their own icon and name on the .exe.
// Usage: node scripts/package-win.js            (both)   |   node scripts/package-win.js pdf   (Desk PDF only)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts });

const apps = [
  { key: 'assistant', name: 'Desk Assistant', out: 'dist', ico: 'build/icon.ico', zip: `DeskAssistant-Windows-v${version}.zip`, desc: 'Desk Assistant - your personal file and meeting assistant', extra: [] },
  { key: 'pdf', name: 'Desk PDF', out: 'dist-pdf', ico: 'build/pdf/icon.ico', zip: `DeskPDF-Windows-v${version}.zip`, desc: 'Desk PDF - view, edit and sign PDFs',
    extra: ['-c.productName=Desk PDF', '-c.appId=com.deskassistant.pdf', '-c.extraMetadata.main=src/pdf-main.js', '-c.extraMetadata.name=desk-pdf'] },
];
const only = process.argv[2];
run('node', ['scripts/vendor.js']);
// Make sure the .ico files are in the format Windows expects (BMP small sizes + PNG 256) if Python is available.
for (const [src, out] of [['build/icon.png', 'build/icon.ico'], ['build/pdf/icon.png', 'build/pdf/icon.ico']]) {
  try { run(process.platform === 'win32' ? 'python' : 'python3', ['scripts/make-ico.py', src, out]); } catch { console.warn('Python not found - using the existing .ico files'); }
}
fs.copyFileSync(path.join(root, 'build/icon.ico'), path.join(root, 'src/renderer/icon.ico'));
fs.copyFileSync(path.join(root, 'build/pdf/icon.ico'), path.join(root, 'src/renderer/icon-pdf.ico'));
for (const a of apps.filter((x) => !only || x.key === only)) {
  fs.rmSync(path.join(root, a.out), { recursive: true, force: true });
  run('npx', ['electron-builder', '--win', 'dir', '--x64', '-c.win.signAndEditExecutable=false', `-c.win.icon=${a.ico}`, `-c.directories.output=${a.out}`, ...a.extra]);
  const unpacked = path.join(root, a.out, 'win-unpacked');
  run('node', ['scripts/brand-exe.js', path.join(unpacked, `${a.name}.exe`), a.ico, a.name, a.desc, version]);
  if (process.platform === 'win32') run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${unpacked}\\*' -DestinationPath '${path.join(root, a.out, a.zip)}' -Force`]);
  else run('zip', ['-qr9', path.join('..', a.zip), '.'], { cwd: unpacked });
  console.log(`Created ${a.out}/${a.zip}`);
}
