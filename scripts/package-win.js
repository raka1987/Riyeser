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
for (const a of apps.filter((x) => !only || x.key === only)) {
  fs.rmSync(path.join(root, a.out), { recursive: true, force: true });
  run('npx', ['electron-builder', '--win', 'dir', '--x64', '-c.win.signAndEditExecutable=false', `-c.win.icon=${a.ico}`, `-c.directories.output=${a.out}`, ...a.extra]);
  const unpacked = path.join(root, a.out, 'win-unpacked');
  run('node', ['scripts/brand-exe.js', path.join(unpacked, `${a.name}.exe`), a.ico, a.name, a.desc, version]);
  if (process.platform === 'win32') run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${unpacked}\\*' -DestinationPath '${path.join(root, a.out, a.zip)}' -Force`]);
  else run('zip', ['-qr9', path.join('..', a.zip), '.'], { cwd: unpacked });
  console.log(`Created ${a.out}/${a.zip}`);
}
