// Puts the back office and the desktop window together in desktop/build/app, ready for electron-builder.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..'), OUT = path.join(__dirname, 'build', 'app');
const root = require(path.join(ROOT, 'package.json'));
const electronVersion = require(path.join(__dirname, 'node_modules', 'electron', 'package.json')).version;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of ['server.js', 'db.js', 'mailer.js', 'wages.js', 'bank.js', 'desktop.js', 'perms.js', 'archive.js', 'demo.js', 'licence.js', 'signed-licence.js', 'pdf.js', 'forgot.js', 'payweek.js']) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
// The licence public key (Ed25519), so Payroll only trusts licences Riyeser signed (signed-licence.js). The release
// workflow fetches it from the licence function's /public-key. Without it (licence signing not switched on yet) the
// build accepts unsigned licences, as before. It's a public key: nothing secret goes into the build.
{
  const key = String(process.env.RIYESER_LICENCE_PUBLIC_KEY || '').trim();
  if (key) {
    if (Buffer.from(key, 'base64').length !== 32) throw new Error("RIYESER_LICENCE_PUBLIC_KEY isn't an Ed25519 public key (32 bytes, base64).");
    fs.writeFileSync(path.join(OUT, 'licence-public-key.txt'), `${key}\n`); console.log('Licence public key built in:', key);
  } else console.log('No licence public key: this build accepts unsigned licences (licence signing not switched on yet).');
}
// every program file the back office loads must be in the list above (Payroll 2.2.3 left out forgot.js and payweek.js and
// would not start): check each require('./…') now, so a missing file stops the build here instead of in the installed app
for (const f of fs.readdirSync(OUT).filter(f => f.endsWith('.js'))) {
  for (const [, dep] of fs.readFileSync(path.join(OUT, f), 'utf8').matchAll(/require\('\.\/([\w-]+)(?:\.js)?'\)/g)) {
    if (!fs.existsSync(path.join(OUT, `${dep}.js`))) throw new Error(`${f} needs ${dep}.js: add it to the file list in desktop/prepare.js`);
  }
}
fs.cpSync(path.join(ROOT, 'public'), path.join(OUT, 'public'), { recursive: true });
for (const f of ['main.js', 'preload.js', 'restore.js']) fs.copyFileSync(path.join(__dirname, f), path.join(OUT, f));
fs.copyFileSync(path.join(__dirname, 'icon.png'), path.join(OUT, 'icon.png'));
fs.mkdirSync(path.join(OUT, 'build'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'icon.png'), path.join(OUT, 'build', 'icon.png'));
// the program's icon and name are written into the .exe on Windows, or on Linux when Wine is installed
const canEditExe = process.platform === 'win32' || (() => { try { execSync('wine --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({
  name: 'riyeser-payroll', productName: 'Riyeser Payroll', version: root.version, description: 'Riyeser Payroll: time clock, timesheets, pay runs and payslips', author: { name: 'Riyeser Group' },
  main: 'main.js', dependencies: root.dependencies, overrides: root.overrides,
  build: {
    appId: 'com.riyeser.payroll', productName: 'Riyeser Payroll', copyright: 'Riyeser Group', electronVersion, electronLanguages: ['en-US'], compression: 'maximum',
    directories: { output: path.join(__dirname, 'dist') },
    // leave out library files the program never uses (keeps the download smaller)
    files: ['**/*', '!build/**', '!**/*.map', '!node_modules/exceljs/dist/**', '!node_modules/pdfjs-dist/{legacy,web,types,image_decoders}/**',
      '!node_modules/tesseract.js-core/*.wasm', '!node_modules/tesseract.js-core/tesseract-core{,-simd,-relaxedsimd}.{js,wasm.js}',
      '!node_modules/tesseract.js-core/tesseract-core{,-simd,-relaxedsimd}-lstm.js', '!node_modules/@tesseract.js-data/eng/4.0.0/**'],
    win: { target: ['nsis', 'portable'], icon: 'build/icon.png', signAndEditExecutable: canEditExe, signExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true,
      shortcutName: 'Riyeser Payroll', artifactName: 'RiyeserPayroll-Setup-${version}.${ext}', deleteAppDataOnUninstall: false },
    portable: { artifactName: 'RiyeserPayroll-Portable-${version}.${ext}' },
    publish: [],
  },
}, null, 2));
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: OUT, stdio: 'inherit' });
console.log('Prepared', OUT);
