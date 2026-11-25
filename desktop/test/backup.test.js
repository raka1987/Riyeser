// OWNER-BACKUP: back up and restore every Riyeser program, the same way everywhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const JSZip = require('jszip');
const B = require('../src/core/backup');
const specs = require('../src/core/backup-specs');

const NOW = new Date(2026, 10, 25, 14, 5).getTime();
const DAY = 86400000;
/** A pretend PC: %APPDATA%, the user's home and Documents, with each program's data in its usual place. */
function pc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const appData = path.join(root, 'AppData', 'Roaming'); const home = path.join(root, 'home'); const documents = path.join(home, 'Documents');
  fs.mkdirSync(documents, { recursive: true });
  const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  w(path.join(appData, 'Riyeser Central', 'data', 'checklist.json'), '{"done":["company"]}');
  w(path.join(appData, 'Riyeser Central', 'data', 'online.json'), '{"session":"SECRET-TOKEN"}');
  w(path.join(appData, 'Riyeser Central', 'data', 'device.json'), '{"id":"this-pc"}');
  w(path.join(appData, 'Riyeser', 'company.json'), '{"name":"Coastal Cafe","mode":"online"}');
  w(path.join(appData, 'Riyeser', 'licence.json'), '{"online":{}}');
  w(path.join(appData, 'Riyeser', 'device.json'), '{"id":"this-pc"}');
  w(path.join(home, '.riyeser', 'company.db'), 'SQLite format 3\0 books');
  w(path.join(home, '.riyeser', 'companies', 'second.db'), 'SQLite format 3\0 second books');
  w(path.join(home, '.riyeser', 'secret.key'), 'not in a backup');
  w(path.join(appData, 'Riyeser Payroll', 'payroll', 'payroll.db'), 'SQLite format 3\0 pay');
  w(path.join(appData, 'Riyeser Payroll', 'payroll', 'demo', 'payroll.db'), 'practice');
  w(path.join(appData, 'Desk Assistant', 'data', 'settings.json'), '{"organisedRoot":"D:/Sorted"}');
  w(path.join(appData, 'Desk Assistant', 'data', 'undo.json'), '[{"batch":1}]');
  w(path.join(appData, 'Desk PDF', 'data', 'signatures.json'), '[{"id":"sig"}]');
  w(path.join(appData, 'Riyeser Link Office', 'data', 'phone-devices.json'), '[{"ext":"201"}]');
  w(path.join(appData, 'Riyeser Link Office', 'data', 'phone-secrets.json'), '{"201":{"enc":"ENCRYPTED"}}');
  w(path.join(appData, 'Riyeser Link Office', 'logs', 'link.log'), 'log');
  w(path.join(appData, 'Riyeser Services', 'Local Storage', 'leveldb', '000003.log'), 'projects');
  w(path.join(appData, 'Riyeser Services', 'IndexedDB', 'file__0.indexeddb.leveldb', 'CURRENT'), 'MANIFEST-1');
  w(path.join(appData, 'Riyeser Services', 'Cache', 'big'), 'cache');
  return { root, appData, home, documents, env: {}, read: (...p) => fs.readFileSync(path.join(...p), 'utf8') };
}
const opts = (p) => ({ appData: p.appData, home: p.home, env: p.env });
const io = (p, now = NOW) => ({ documents: p.documents, home: p.home, env: p.env, now });
const zipNames = async (file) => Object.keys((await JSZip.loadAsync(fs.readFileSync(file))).files).filter((n) => !n.endsWith('/')).sort();

test('backups go in Documents\\Riyeser\\<Program>\\Backups, outside every install folder', () => {
  const p = pc();
  assert.strictEqual(B.backupsDir('Desk Assistant', io(p)), path.join(p.documents, 'Riyeser', 'Desk Assistant', 'Backups'));
  assert.strictEqual(B.backupsDir('Everything', io(p)), path.join(p.documents, 'Riyeser', 'Central', 'Backups'));
  assert.strictEqual(B.backupsDir('PDF', { env: { RIYESER_DOCS: path.join(p.root, 'OneDrive', 'Riyeser') } }), path.join(p.root, 'OneDrive', 'Riyeser', 'PDF', 'Backups'));
});

for (const id of ['desk', 'linkoffice', 'services', 'pdf']) {
  test(`${specs.NAMES[id]}: back up, change things, restore: back as it was, with a "before restore" copy first`, async () => {
    const p = pc(); const spec = specs.programSpec(id, opts(p)); const dir = spec.parts[0].dir;
    const before = B.listBackups(B.backupsDir(spec.program, io(p))).length;
    const { file } = await B.createBackup(spec, io(p));
    assert.match(path.basename(file), new RegExp(`^Riyeser ${spec.program} backup 2026-11-25 1405\\.zip$`));
    assert.strictEqual(path.dirname(file), B.backupsDir(spec.program, io(p)));
    const saved = Object.fromEntries((await (async () => { const out = []; const go = (d, r) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = r ? `${r}/${e.name}` : e.name; if (e.isDirectory()) go(path.join(d, e.name), rel); else out.push([rel, fs.readFileSync(path.join(d, e.name), 'utf8')]); } }; go(dir, ''); return out; })()));
    // the program carries on: files change, one is added, one goes
    const first = Object.keys(saved).find((k) => !B.NEVER.test(k) && !(spec.parts[0].skip && spec.parts[0].skip.test(k)));
    fs.writeFileSync(path.join(dir, ...first.split('/')), 'CHANGED');
    const added = [...first.split('/').slice(0, -1), 'added-later.json'];
    fs.writeFileSync(path.join(dir, ...added), '{}');
    const info = await B.describeBackup(file);
    assert.strictEqual(info.program, spec.program); assert.ok(info.parts[0].files >= 1);
    assert.match(B.summary(info), /file/);
    const r = await B.restoreBackup(file, spec, io(p, NOW + 3600000));
    assert.strictEqual(fs.readFileSync(path.join(dir, ...first.split('/')), 'utf8'), saved[first], 'restored');
    assert.ok(!fs.existsSync(path.join(dir, ...added)), 'the folder is as it was');
    // the safety copy has the data as it was just before the restore
    assert.match(path.basename(r.before), /\(before restore\)\.zip$/);
    const safety = await JSZip.loadAsync(fs.readFileSync(r.before));
    assert.strictEqual(await safety.file(`parts/${id}/${first}`).async('string'), 'CHANGED');
    assert.ok(safety.file(`parts/${id}/${added.join('/')}`));
    assert.strictEqual(B.listBackups(B.backupsDir(spec.program, io(p))).length, before + 2);
  });
}

test('the zips hold the expected parts, and never sign-ins, this PC\'s id, logs or caches', async () => {
  const p = pc();
  const names = (await zipNames((await B.createBackup(specs.everythingSpec(opts(p)), io(p))).file)).join('\n');
  for (const want of ['manifest.json', 'parts/central/checklist.json', 'parts/shared/company.json', 'parts/accounting/company.db', 'parts/accounting/companies/second.db',
    'parts/payroll/payroll.db', 'parts/desk/settings.json', 'parts/desk/undo.json', 'parts/pdf/signatures.json', 'parts/linkoffice/phone-devices.json',
    'parts/linkoffice/phone-secrets.json', 'parts/services/Local Storage/leveldb/000003.log', 'parts/services/IndexedDB/file__0.indexeddb.leveldb/CURRENT']) {
    assert.ok(names.split('\n').includes(want), `${want} in the backup`);
  }
  for (const never of ['online.json', 'device.json', 'licence.json', 'secret.key', 'demo/', 'Cache/', 'link.log']) assert.ok(!names.includes(never), `${never} isn't in a backup`);
  // Link Office's desk phone passwords stay encrypted as they were
  const z = await JSZip.loadAsync(fs.readFileSync(B.listBackups(B.backupsDir('Everything', io(p)))[0].file));
  assert.match(await z.file('parts/linkoffice/phone-secrets.json').async('string'), /ENCRYPTED/);
});

test('Central: "Back up everything" makes one file, "Riyeser backup <date>.zip", of the programs on this PC', async () => {
  const p = pc();
  const { file, parts } = await B.createBackup(specs.everythingSpec(opts(p), ['central', 'desk', 'accounting-basics']), io(p));
  assert.strictEqual(path.basename(file), 'Riyeser backup 2026-11-25 1405.zip');
  assert.deepStrictEqual(parts.map((x) => x.id), ['central', 'shared', 'accounting', 'desk']);
});

test('Central: "Restore everything" on a new PC puts every program\'s data back (before-restore copy first)', async () => {
  const old = pc();
  const { file } = await B.createBackup(specs.everythingSpec(opts(old)), io(old));
  // a new PC with Windows reinstalled: nothing there but a new Central with its own sign-in and id
  const fresh = pc();
  for (const d of [path.join(fresh.appData), path.join(fresh.home, '.riyeser')]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(path.join(fresh.appData, 'Riyeser Central', 'data'), { recursive: true });
  fs.writeFileSync(path.join(fresh.appData, 'Riyeser Central', 'data', 'online.json'), '{"session":"NEW-PC"}');
  // the backup came across on a USB stick
  const usb = path.join(fresh.root, 'USB'); fs.mkdirSync(usb); fs.copyFileSync(file, path.join(usb, path.basename(file)));
  const r = await B.restoreBackup(path.join(usb, path.basename(file)), specs.everythingSpec(opts(fresh)), io(fresh));
  assert.deepStrictEqual(r.restored, ['central', 'shared', 'accounting', 'payroll', 'desk', 'pdf', 'linkoffice', 'services']);
  assert.match(fresh.read(fresh.appData, 'Riyeser', 'company.json'), /Coastal Cafe/);
  assert.match(fresh.read(fresh.home, '.riyeser', 'company.db'), /books/);
  assert.match(fresh.read(fresh.home, '.riyeser', 'companies', 'second.db'), /second books/);
  assert.match(fresh.read(fresh.appData, 'Riyeser Payroll', 'payroll', 'payroll.db'), /pay/);
  assert.match(fresh.read(fresh.appData, 'Desk Assistant', 'data', 'undo.json'), /batch/);
  assert.match(fresh.read(fresh.appData, 'Riyeser Link Office', 'data', 'phone-devices.json'), /201/);
  assert.match(fresh.read(fresh.appData, 'Riyeser Services', 'Local Storage', 'leveldb', '000003.log'), /projects/);
  assert.match(fresh.read(fresh.appData, 'Riyeser Central', 'data', 'online.json'), /NEW-PC/, 'this PC\'s own sign-in is kept');
  assert.ok(!fs.existsSync(path.join(fresh.appData, 'Riyeser', 'device.json')), 'the old PC\'s id isn\'t copied');
  assert.ok(fs.existsSync(r.before) && /\(before restore\)/.test(r.before));
  // a single program can take its part from the all-in-one file
  const desk = specs.programSpec('desk', opts(fresh));
  fs.writeFileSync(path.join(fresh.appData, 'Desk Assistant', 'data', 'undo.json'), '[]');
  await B.restoreBackup(file, desk, io(fresh));
  assert.match(fresh.read(fresh.appData, 'Desk Assistant', 'data', 'undo.json'), /batch/);
  // and the wrong program's backup is refused in plain words
  const pdfOnly = (await B.createBackup(specs.programSpec('pdf', opts(fresh)), io(fresh))).file;
  await assert.rejects(B.restoreBackup(pdfOnly, desk, io(fresh)), /That's a backup of Riyeser PDF, not Riyeser Desk Assistant/);
  await assert.rejects(B.describeBackup(path.join(fresh.appData, 'Riyeser', 'company.json')), /isn't a Riyeser backup/);
});

test('automatic backups: once a day, the last 30 kept (before-restore copies kept apart)', async () => {
  const p = pc(); const spec = specs.programSpec('desk', opts(p)); const folder = B.backupsDir(spec.program, io(p));
  assert.ok(await B.dailyBackup(spec, io(p)));
  assert.strictEqual(await B.dailyBackup(spec, io(p, NOW + 3600000)), null, 'not twice in a day');
  for (let d = 1; d <= 34; d++) {
    assert.ok(await B.dailyBackup(spec, io(p, NOW + d * DAY)));
  }
  const left = B.listBackups(folder);
  assert.strictEqual(left.filter((b) => !b.beforeRestore).length, 30);
  assert.match(left[0].name, /2026-12-29/);
});

test('restore on restart: a program asks, restarts, and the restore runs before its data is opened', async () => {
  const p = pc(); const spec = specs.programSpec('linkoffice', opts(p));
  const { file } = await B.createBackup(spec, io(p));
  fs.writeFileSync(path.join(spec.parts[0].dir, 'phone-devices.json'), '[]');
  const userData = path.join(p.appData, 'Riyeser Link Office');
  B.scheduleRestore(userData, file);
  const r = await B.applyPendingRestore(userData, spec, io(p));
  assert.ok(r.ok); assert.match(p.read(spec.parts[0].dir, 'phone-devices.json'), /201/);
  assert.strictEqual(await B.applyPendingRestore(userData, spec, io(p)), null, 'only once');
});

test('uninstalling never removes data or backups (deleteAppDataOnUninstall is off for every installer)', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'builder.config.js'), 'utf8');
  assert.match(cfg, /deleteAppDataOnUninstall: false/);
  assert.doesNotMatch(cfg, /deleteAppDataOnUninstall: true/);
});

test('a program\'s Restore from a backup…: pick a file, see what\'s in it, restart, and it\'s restored before the data opens', async () => {
  const p = pc(); const { backupUi } = require('../src/core/backup-ui');
  const spec = specs.programSpec('desk', opts(p));
  const userData = path.join(p.appData, 'Desk Assistant');
  const shown = []; let restarted = 0;
  const app = { getPath: (k) => ({ documents: p.documents, userData }[k]), relaunch: () => { restarted++; }, exit: () => { restarted++; } };
  let pickFile = null;
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [pickFile] }), showMessageBox: async (_w, o) => { shown.push(o); return { response: 0 }; }, showErrorBox: () => {} };
  const ui = backupUi({ app, dialog, shell: { openPath: async () => '' }, spec, name: 'Riyeser Desk Assistant' });
  const { file } = await ui.backUpNow({ quiet: true });
  assert.strictEqual(path.dirname(file), path.join(p.documents, 'Riyeser', 'Desk Assistant', 'Backups'));
  fs.writeFileSync(path.join(spec.parts[0].dir, 'undo.json'), '[]');
  pickFile = file;
  assert.strictEqual(await ui.restoreFromBackup(), true);
  assert.match(shown[0].detail, /Desk Assistant settings, to-dos and undo history: \d+ files?/);   // what's in it
  assert.match(shown[0].detail, /A copy of everything as it is now is saved in the backups folder first/);
  assert.strictEqual(restarted, 2);
  assert.match(p.read(spec.parts[0].dir, 'undo.json'), /^\[\]$/, 'nothing changed until the restart');
  // ...the program starts again
  const r = await ui.applyPending();
  assert.ok(r.ok); assert.match(p.read(spec.parts[0].dir, 'undo.json'), /batch/);
  assert.ok(fs.existsSync(r.before));
  // another program's backup is refused before anything happens
  pickFile = (await B.createBackup(specs.programSpec('pdf', opts(p)), io(p, NOW + DAY))).file;
  assert.strictEqual(await ui.restoreFromBackup(), false);
  assert.match(shown[shown.length - 1].detail, /backup of Riyeser PDF, not Riyeser Desk Assistant/);
});

test('every program has Back up now, Restore from a backup… and the backups folder in its menu and Settings, and offers a restore on a new PC', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  const ui = src('core/backup-ui.js');
  for (const label of ['Back up now', 'Restore from a backup…', 'Open the backups folder', 'Start fresh']) assert.ok(ui.includes(`'${label}'`), label);
  // Desk Assistant: tray menu, Settings, first run, daily
  const desk = src('main.js'); const deskUi = src('renderer/app.js');
  assert.match(desk, /\.\.\.backups\.menuItems\(\)/); assert.match(desk, /backups\.startDaily\(\)/); assert.match(desk, /backups\.firstRunOffer\(\)/);
  assert.match(desk, /await backups\.applyPending\(\)[\s\S]*store = new Store\(/);
  assert.match(deskUi, /data-act="backupnow">Back up now<\/button><button data-act="backuprestore">Restore from a backup…<\/button><button data-act="backupfolder">Open the backups folder<\/button>/);
  // Link Office: tray menu, its screen, first run, daily
  const lo = src('link-main.js');
  assert.match(lo, /\.\.\.backups\.menuItems\(\)/); assert.match(lo, /backups\.startDaily\(\)/); assert.match(lo, /firstRunOffer/);
  assert.match(lo, /await backups\.applyPending\(\)[\s\S]*makeService\(\);/);
  assert.match(src('renderer/link.js'), /data-a="backupnow">Back up now/);
  // As Built: its menu, first run, daily
  const ab = src('services-main.js');
  assert.match(ab, /backups \? backups\.menuItems\(\) : \[\]/); assert.match(ab, /backups\.startDaily\(\)/); assert.match(ab, /firstRunOffer/);
  // Central: Settings, first-run screen, restore on restart, daily
  const c = src('central-main.js'); const cr = src('renderer/central.js');
  assert.match(cr, /data-bk="all">Back up everything…<\/button> <button data-bk="restore">Restore everything from a backup…<\/button> <button data-bk="folder">Open the backups folder/);
  assert.match(require('../src/renderer/demo-ui').startHtml(), /data-w="restore">Restore everything from a backup…/);
  assert.match(c, /applyPendingRestore\([\s\S]*store = new Store\(/);
  assert.match(c, /if \(open\.length\) return \{ ok: false, open, message: freshstart\.closeFirst\(open\) \}/);
});
