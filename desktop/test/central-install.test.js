// Riyeser Central's Install button: starting the installer (Link Office through the Windows permission prompt), reading
// its result, the states a tile shows, and finding the program afterwards in Windows' installed-apps list.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const run = require('../src/central/install-run');
const u = require('../src/central/updates');
const checklist = require('../src/central/checklist');
const dg = require('../src/central/diagnostics');

// A stand-in for child_process.spawn: each call takes the next scripted outcome.
function fakeSpawn(outcomes) {
  const calls = [];
  const fn = (command, args, options) => {
    const o = outcomes[calls.length] || { exit: 0 };
    calls.push({ command, args, options });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; };
    setImmediate(() => {
      if (o.error) { const e = new Error(o.error.message || `spawn ${o.error.code}`); e.code = o.error.code; child.emit('error', e); return; }
      if (o.stdout) child.stdout.emit('data', Buffer.from(o.stdout));
      if (!o.hang) child.emit('exit', o.exit);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('Link Office is the program that needs Windows\' permission; the others install for this user', () => {
  const lo = u.PRODUCTS.find((p) => p.id === 'linkoffice');
  assert.equal(lo.elevate, true);
  assert.deepEqual(u.PRODUCTS.filter((p) => p.elevate).map((p) => p.id), ['linkoffice']);
  // builder.config.js: Link Office is the per-machine (Program Files, HKLM) build
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'builder.config.js'), 'utf8');
  assert.match(cfg, /linkoffice: \{[^\n]*appId: 'com\.riyeser\.linkoffice'[^\n]*artifact: 'RiyeserLinkOffice'[^\n]*\n\s*perMachine: true/);
});

test('a normal installer starts directly; Link Office starts through PowerShell Start-Process -Verb RunAs', () => {
  const plain = run.launchPlan({ file: 'C:\\T\\RiyeserPOS-Setup.exe', args: ['/VERYSILENT', '/SUPPRESSMSGBOXES'] });
  assert.equal(plain.command, 'C:\\T\\RiyeserPOS-Setup.exe');
  assert.deepEqual(plain.args, ['/VERYSILENT', '/SUPPRESSMSGBOXES']);
  const up = run.launchPlan({ file: "C:\\Users\\O'Neil\\AppData\\Local\\Temp\\riyeser-install-x\\RiyeserLinkOffice-Setup.exe", args: ['/S'], elevate: true });
  assert.equal(up.command, 'powershell.exe');
  assert.equal(up.elevated, true);
  const i = up.args.indexOf('-EncodedCommand');
  const script = Buffer.from(up.args[i + 1], 'base64').toString('utf16le');
  assert.match(script, /Start-Process -FilePath 'C:\\Users\\O''Neil\\AppData\\Local\\Temp\\riyeser-install-x\\RiyeserLinkOffice-Setup\.exe' -ArgumentList '\/S' -Verb RunAs -PassThru/);
  assert.match(script, /WaitForExit\(\)/);
  assert.match(script, /exit \[int\]\$p\.ExitCode/);
  assert.match(script, /RIYESER-START-ERROR/);
});

test('runInstaller: exit code 0 is installed; a code is reported, not thrown', async () => {
  const ok = await run.runInstaller({ file: 'a.exe', args: ['/S'], spawn: fakeSpawn([{ exit: 0 }]) });
  assert.equal(ok.code, 0); assert.equal(ok.startError, null); assert.equal(ok.elevated, false);
  assert.equal(run.installFailure(ok, { name: 'Riyeser POS' }).ok, true);
  const bad = await run.runInstaller({ file: 'a.exe', args: ['/S'], spawn: fakeSpawn([{ exit: 2 }]) });
  const f = run.installFailure(bad, { name: 'Riyeser PDF', args: ['/S'] });
  assert.equal(f.ok, false); assert.equal(f.reason, 'failed'); assert.equal(f.code, 2);
  assert.match(f.message, /Install failed \(code 2\)/); assert.match(f.fix, /Get help/);
});

test('the bug: Link Office started directly fails with spawn EACCES (Windows error 740); now it asks for permission', async () => {
  // Central 1.8.10: spawn() of the per-machine installer -> 'error' EACCES, no prompt ever shown
  const old = await run.runInstaller({ file: 'RiyeserLinkOffice-Setup.exe', args: ['/S'], spawn: fakeSpawn([{ error: { code: 'EACCES' } }]), retryElevated: false });
  assert.equal(old.startError, 740);
  const f = run.installFailure(old, { name: 'Riyeser Link Office' });
  assert.equal(f.reason, 'needs-permission'); assert.match(f.message, /permission/);
  // Now: started through the permission prompt, waits for it, exit code 0
  const sp = fakeSpawn([{ exit: 0 }]);
  const now = await run.runInstaller({ file: 'RiyeserLinkOffice-Setup.exe', args: ['/S'], elevate: true, spawn: sp });
  assert.equal(sp.calls[0].command, 'powershell.exe');
  assert.equal(now.elevated, true); assert.equal(now.code, 0);
  assert.equal(run.installFailure(now, { name: 'Riyeser Link Office' }).ok, true);
});

test('a per-user installer that unexpectedly needs permission is tried again through the prompt', async () => {
  const sp = fakeSpawn([{ error: { code: 'EACCES' } }, { exit: 0 }]);
  const r = await run.runInstaller({ file: 'x.exe', args: ['/S'], spawn: sp });
  assert.equal(sp.calls.length, 2);
  assert.equal(sp.calls[1].command, 'powershell.exe');
  assert.equal(r.retried, true); assert.equal(r.firstError, 740); assert.equal(r.code, 0);
});

test('No on the permission prompt, a blocked file, a missing file and a timeout each get their own message', async () => {
  const no = await run.runInstaller({ file: 'x.exe', args: ['/S'], elevate: true,
    spawn: fakeSpawn([{ stdout: 'RIYESER-START-ERROR 1223 The operation was canceled by the user.\r\n', exit: run.PS_FAILED }]) });
  assert.equal(no.startError, 1223); assert.match(no.detail, /canceled by the user/);
  const fNo = run.installFailure(no, { name: 'Riyeser Link Office' });
  assert.equal(fNo.reason, 'cancelled'); assert.match(fNo.message, /You chose No/); assert.match(fNo.fix, /choose Yes/);

  const av = await run.runInstaller({ file: 'x.exe', args: ['/S'], elevate: true,
    spawn: fakeSpawn([{ stdout: 'RIYESER-START-ERROR 225 Operation did not complete successfully because the file contains a virus', exit: run.PS_FAILED }]) });
  const fAv = run.installFailure(av, { name: 'Riyeser Link Office' });
  assert.equal(fAv.reason, 'blocked'); assert.match(fAv.fix, /More info → Run anyway/);

  const gone = await run.runInstaller({ file: 'x.exe', args: ['/S'], spawn: fakeSpawn([{ error: { code: 'ENOENT' } }]) });
  assert.equal(run.installFailure(gone, { name: 'Riyeser POS' }).reason, 'blocked');   // the antivirus took the file away

  const slow = await run.runInstaller({ file: 'x.exe', args: ['/S'], spawn: fakeSpawn([{ hang: true }]), timeoutMs: 20 });
  assert.equal(slow.startError, 'timeout');
  assert.equal(run.installFailure(slow, { name: 'Riyeser POS' }).reason, 'timeout');
});

test('exit codes: NSIS 1 and Inno 5 mean it stopped (usually the program is open)', () => {
  assert.equal(run.installFailure({ code: 1, startError: null }, { name: 'Riyeser PDF', args: ['/S'] }).reason, 'running');
  const inno = run.installFailure({ code: 5, startError: null }, { name: 'Riyeser POS', args: ['/VERYSILENT', '/SUPPRESSMSGBOXES'] });
  assert.equal(inno.reason, 'running'); assert.match(inno.fix, /Close Riyeser POS/);
  assert.equal(run.installFailure({ code: 1, startError: null }, { name: 'Riyeser POS', args: ['/VERYSILENT'] }).reason, 'failed');
  assert.equal(run.notFoundAfterInstall('Riyeser Link Office').reason, 'not-found');
});

test('install states: downloading -> checking -> installing -> verifying -> installed, or failed (never silently back to Install)', () => {
  let s = run.step(null, { id: 'linkoffice', stage: 'downloading', pct: 0.24 });
  assert.equal(run.stateText(s), 'Downloading… 24%');
  s = run.step(s, { stage: 'downloading', pct: 1 });
  s = run.step(s, { stage: 'checking' });
  assert.equal(s.stage, 'checking');
  s = run.step(s, { stage: 'installing', elevate: true });
  assert.match(run.stateText(s), /Windows will ask for permission: choose Yes/);
  s = run.step(s, { stage: 'verifying' });
  s = run.step(s, { stage: 'installed', version: '1.1.5' });
  assert.equal(s.stage, 'installed'); assert.equal(s.id, 'linkoffice');
  assert.match(run.stateText(s, 'Riyeser Link Office'), /Installed ✓/);
  // a failure keeps its reason and fix until Try again
  let f = run.step({ stage: 'installing', id: 'linkoffice' }, { stage: 'failed', reason: 'cancelled', message: 'You chose No…', fix: 'Click Install again', code: 1223 });
  assert.deepEqual([f.stage, f.reason, f.code], ['failed', 'cancelled', 1223]);
  assert.equal(run.step(f, { stage: 'installed' }).stage, 'failed');   // can't jump to installed from failed
  f = run.step(f, { stage: 'downloading', pct: 0 });
  assert.equal(f.stage, 'downloading');
  // out-of-order steps are ignored
  assert.equal(run.step({ stage: 'idle' }, { stage: 'installed' }).stage, 'idle');
  assert.equal(run.step({ stage: 'downloading' }, { stage: 'nonsense' }).stage, 'downloading');
});

test('the install log line has the codes and no paths beyond the file name', () => {
  const line = run.logEntry({ at: Date.UTC(2026, 10, 27, 9), id: 'linkoffice', version: '1.1.5', file: 'RiyeserLinkOffice-Setup.exe', stage: 'failed',
    elevated: false, code: null, startError: 740, reason: 'needs-permission', ms: 12, extra: 'not logged' });
  assert.match(line, /^2026-11-27T09:00:00\.000Z install \{/);
  const j = JSON.parse(line.slice(line.indexOf('{')));
  assert.deepEqual(j, { id: 'linkoffice', version: '1.1.5', file: 'RiyeserLinkOffice-Setup.exe', stage: 'failed', elevated: false, code: null, startError: 740, reason: 'needs-permission', ms: 12 });
});

// ---------- detection: what Windows lists after each installer (HKCU for per-user, HKLM for Link Office) ----------
const HKLM = [
  'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\4a6bd3a8-9a2f-5b44-a6b7-riyeser-linkoffice',
  '    DisplayName    REG_SZ    Riyeser Link Office 1.1.5',
  '    DisplayVersion    REG_SZ    1.1.5',
  '    Publisher    REG_SZ    Riyeser Group',
  '',
  'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Microsoft Edge',
  '    DisplayName    REG_SZ    Microsoft Edge',
  '    DisplayVersion    REG_SZ    131.0.2903.70',
].join('\r\n');
const HKCU = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\c0ffee00-riyeser-link',
  '    DisplayName    REG_SZ    Riyeser Link 1.1.2',
  '    DisplayVersion    REG_SZ    1.1.2',
  ...[['Riyeser Accounting Basics', '2.10.1'], ['Riyeser Accounting Plus', '2.10.1'], ['Riyeser POS', '2.10.1'], ['Riyeser Invoices', '2.10.1'],
    ['Riyeser Bookings', '2.10.1'], ['Riyeser Estimate', '2.10.1']].flatMap(([n, v]) => [
    '', `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${n}_is1`, `    DisplayName    REG_SZ    ${n}`, `    DisplayVersion    REG_SZ    ${v}`]),
  ...[['Riyeser Payroll 2.3.3', '2.3.3'], ['Riyeser Documents 1.0.0', '1.0.0'], ['Riyeser PDF 0.25.0', '0.25.0'], ['As Built 1.2.1', '1.2.1']].flatMap(([n, v], i) => [
    '', `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\guid-${i}`, `    DisplayName    REG_SZ    ${n}`, `    DisplayVersion    REG_SZ    ${v}`]),
].join('\r\n');

test('detection: every program is found after its installer, Link Office from HKLM and not mistaken for Link', () => {
  const v = { ...u.installedFromRegistry(HKLM), ...u.installedFromRegistry(HKCU) };
  assert.deepEqual(v, { linkoffice: '1.1.5', team: '1.1.2', 'accounting-basics': '2.10.1', accounting: '2.10.1', pos: '2.10.1', invoices: '2.10.1',
    bookings: '2.10.1', estimate: '2.10.1', payroll: '2.3.3', desk: '1.0.0', pdf: '0.25.0', services: '1.2.1' });
  assert.deepEqual(u.installedFromRegistry(HKCU).linkoffice, undefined);   // only in HKLM
});

// The 27 November 2026 release (riyeser-2026.11.27-55): its files and "In this release" list.
const RELEASE = {
  tag_name: 'riyeser-2026.11.27-55',
  body: ['- Riyeser Accounting Basics 2.10.1', '- Riyeser Accounting Plus 2.10.1', '- Riyeser Bookings 2.10.1', '- Riyeser Central 1.8.10',
    '- Riyeser Documents 1.0.0', '- Riyeser PDF 0.25.0', '- As Built 1.2.1', '- Riyeser Link 1.1.2', '- Riyeser Link Office 1.1.5',
    '- Riyeser Estimate 2.10.1', '- Riyeser Invoices 2.10.1', '- Riyeser Payroll 2.3.3', '- Riyeser POS 2.10.1'].join('\n'),
  assets: ['RiyeserAccounting', 'RiyeserAccountingBasics', 'RiyeserAccountingPlus', 'RiyeserBookings', 'RiyeserCentral', 'RiyeserDeskAssistant',
    'RiyeserDocuments', 'RiyeserEstimate', 'RiyeserInvoices', 'RiyeserLink', 'RiyeserLinkOffice', 'RiyeserPayroll', 'RiyeserPDF', 'RiyeserPOS',
    'RiyeserServices', 'RiyeserTeam'].map((n) => ({ name: `${n}-Setup.exe`, size: 1, browser_download_url: `https://github.com/raka1987/riyeser-downloads/releases/download/riyeser-2026.11.27-55/${n}-Setup.exe` })),
};

test('every program has its own installer in the release, and every plan module maps to one of them', () => {
  const latest = u.latestFromRelease(RELEASE, { central: '1.8.10', desk: '1.0.0', pdf: '0.25.0', services: '1.2.1', team: '1.1.2', linkoffice: '1.1.5' });
  const want = { 'accounting-basics': 'RiyeserAccountingBasics-Setup.exe', accounting: 'RiyeserAccountingPlus-Setup.exe', pos: 'RiyeserPOS-Setup.exe',
    invoices: 'RiyeserInvoices-Setup.exe', bookings: 'RiyeserBookings-Setup.exe', estimate: 'RiyeserEstimate-Setup.exe', payroll: 'RiyeserPayroll-Setup.exe',
    desk: 'RiyeserDocuments-Setup.exe', pdf: 'RiyeserPDF-Setup.exe', services: 'RiyeserServices-Setup.exe', team: 'RiyeserLink-Setup.exe',
    linkoffice: 'RiyeserLinkOffice-Setup.exe', central: 'RiyeserCentral-Setup.exe' };
  for (const [id, file] of Object.entries(want)) assert.equal(latest.products[id] && latest.products[id].name, file, id);
  assert.equal(latest.products.linkoffice.version, '1.1.5');
  // the plan's modules (licence "online".modules) -> programs with an installer
  for (const [m, ids] of Object.entries(checklist.MODULE_PROGRAMS)) for (const id of ids) assert.ok(latest.products[id], `${m} -> ${id}`);
  assert.deepEqual(checklist.MODULE_PROGRAMS.basic, ['accounting-basics']);
  assert.deepEqual(checklist.MODULE_PROGRAMS.plus, ['accounting']);
});

test('home screen tiles use each program\'s own name (no "Books" tile for Accounting Basics / Plus)', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'central.js'), 'utf8');
  const look = js.slice(js.indexOf('const LOOK = {'), js.indexOf('};', js.indexOf('const LOOK = {')));
  assert.doesNotMatch(look, /nav: 'Books'/);
  assert.match(look, /'accounting-basics': \{[^}]*nav: 'Accounting Basics'/);
  assert.match(look, /accounting: \{[^}]*nav: 'Accounting Plus'/);
});

test('Report an issue includes Central\'s install log', () => {
  const env = { APPDATA: 'C:\\Users\\O\\AppData\\Roaming' };
  const files = dg.logFiles('central', env).map((x) => x.file);
  assert.ok(files.some((f) => /Riyeser Central[\\/]logs[\\/]install\.log$/.test(f)));
  assert.ok(dg.logFiles('linkoffice', env).some((x) => /install\.log$/.test(x.file)));   // after its own log
});
