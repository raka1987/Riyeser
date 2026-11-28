// Riyeser Central's icon (taskbar, desktop shortcut, Start menu, installer, uninstaller, window): the "R." mark from the
// Riyeser wordmark on a white rounded tile. The .ico has every size Windows asks for, the window uses the same file as the
// installer, and the 1.9.2 build points at it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f));

function icoSizes(buf) {
  assert.strictEqual(buf.readUInt16LE(0), 0); assert.strictEqual(buf.readUInt16LE(2), 1, 'an icon file');
  const n = buf.readUInt16LE(4); const out = [];
  for (let i = 0; i < n; i++) { const w = buf[6 + i * 16]; out.push(w === 0 ? 256 : w); }
  return out;
}
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

test('Central .ico: 16, 20, 24, 32, 40, 48, 64, 96, 128 and 256 px', () => {
  const ico = read('build/central/icon.ico');
  assert.deepStrictEqual(icoSizes(ico), [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
  assert.ok(read('src/renderer/icon-central.ico').equals(ico), 'the window icon is the same file as the installer icon');
});

test('Central PNG icons: square sizes, and packaging rebuilds the .ico with all ten sizes', () => {
  assert.deepStrictEqual(pngSize(read('build/central/icon.png')), [1024, 1024]);
  assert.deepStrictEqual(pngSize(read('src/renderer/icon-central.png')), [256, 256]);
  const pack = read('scripts/package-win.js').toString();
  assert.match(pack, /\['build\/central\/icon\.png', 'build\/central\/icon\.ico', '16,20,24,32,40,48,64,96,128,256'\]/);
  assert.match(pack, /build\/central\/icon\.ico'\), path\.join\(root, 'src\/renderer\/icon-central\.ico'\)/);
});

test('Central 1.9.2 uses build/central/icon.ico for the program, installer and uninstaller; windows use icon-central', () => {
  const cfg = read('scripts/builder.config.js').toString();
  assert.match(cfg, /central: \{ name: 'Riyeser Central', appId: 'com\.riyeser\.central', ico: 'build\/central\/icon\.ico'/);
  assert.match(cfg, /version: '1\.9\.2', productName: 'Riyeser Central'/);
  assert.match(cfg, /win: \{.*\bicon: a\.ico/); assert.match(cfg, /installerIcon: a\.ico/); assert.match(cfg, /uninstallerIcon: a\.ico/);
  const main = read('src/central-main.js').toString();
  assert.strictEqual((main.match(/'icon-central\.ico' : 'icon-central\.png'/g) || []).length, 2, 'both Central windows');
});
