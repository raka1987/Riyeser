// Windows runner check: Riyeser Central's automatic updates (central/auto-update.js) with real installers.
//   node scripts/central-autoupdate-check.js --dir=<downloaded release installers> --out=report.json
// A released Riyeser PDF is installed, then a made-up newer release (99.0.0, the same installer file) is offered:
//   0. during work hours (set here to every day, all day) nothing installs, not even with PDF closed, and Central
//      doesn't update itself at a start; then "As soon as possible" for the rest:
//   1. while Riyeser PDF is open, nothing installs (it waits: "Installs once it's closed");
//   2. once it's closed, the next look installs it quietly with the real installer (its program file is rewritten);
//   3. Riyeser Central's own update waits for the next start; at that start it's handed over and installs quietly
//      (the released Central installer, /S), and the start after that notes it in the history.
// The same scheduler, the same "is it running" check (Windows' tasklist) and the same installer check as Central.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const A = require('../src/central/auto-update');
const updates = require('../src/central/updates');
const run = require('../src/central/install-run');
const check = require('../src/central/installer-check');
const freshstart = require('../src/central/freshstart');
const { Store } = require('../src/core/store');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const dl = arg('dir', 'C:\\riy\\dl');
const outFile = arg('out', path.join(os.tmpdir(), 'central-autoupdate.json'));
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const programs = path.join(process.env.LOCALAPPDATA || '', 'Programs');
const PDF_EXE = path.join(programs, 'desk-pdf', 'Riyeser PDF.exe');
const report = { steps: [], ok: false };
const step = (name, ok, extra = {}) => { report.steps.push({ name, ok: !!ok, ...extra }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`, Object.keys(extra).length ? JSON.stringify(extra) : ''); if (!ok) throw new Error(name); };
const regVersions = () => {
  const q = (key) => { try { return execFileSync('reg', ['query', key, '/s', '/reg:64'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e.stdout || ''; } };
  return updates.installedFromRegistry(q('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'));
};
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
// NSIS keeps the files' own dates, so the same version installed again can leave them as they were: the creation time
// (a fresh copy) is noted too, and the proof is the real installer's exit code 0 with the program still there.
const stamp = (f) => { try { const st = fs.statSync(f); return `${st.birthtimeMs}/${st.mtimeMs}`; } catch { return ''; } };
const sha = async (f) => `sha256:${await check.sha256File(f)}`;
const quiet = async (file, args) => { const r = await run.runInstaller({ file, args, elevate: false, retryElevated: false, spawn }); return run.installFailure(r, { name: path.basename(file), args }); };

(async () => {
  const pdfSetup = path.join(dl, 'RiyeserPDF-Setup.exe'); const centralSetup = path.join(dl, 'RiyeserCentral-Setup.exe');
  step('the released installers are here', fs.existsSync(pdfSetup) && fs.existsSync(centralSetup));
  // the released Riyeser PDF, installed the normal way
  const first = await quiet(pdfSetup, ['/S']);
  for (let i = 0; i < 30 && !fs.existsSync(PDF_EXE); i++) await wait(1000);
  const v0 = regVersions().pdf;
  step('the released Riyeser PDF is installed', first.ok && fs.existsSync(PDF_EXE) && v0, { version: v0 });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-auto-check-'));
  const store = new Store(path.join(work, 'data'));
  const base = 'https://github.com/raka1987/riyeser-downloads/releases/download/riyeser-fake/';
  // a made-up newer release: Riyeser PDF and Riyeser Central at 99.0.0 (the release's own files)
  const release = [
    { id: 'pdf', name: 'Riyeser PDF', from: v0, to: '99.0.0', url: `${base}RiyeserPDF-Setup.exe`, file: 'RiyeserPDF-Setup.exe', args: ['/S'], self: false, elevate: false, digest: await sha(pdfSetup), src: pdfSetup },
    { id: 'central', name: 'Riyeser Central', from: '1.0.0', to: '99.0.0', url: `${base}RiyeserCentral-Setup.exe`, file: 'RiyeserCentral-Setup.exe', args: ['/S'], self: true, elevate: false, digest: await sha(centralSetup), src: centralSetup },
  ];
  const left = new Set(['pdf', 'central']);
  let when = { mode: 'outside', hours: { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00' } };   // always work time
  const logs = []; const selfRuns = [];
  const au = A.createAutoUpdater({
    store, cacheDir: path.join(work, 'updates'), allowed: () => true, when: () => when, isDemo: () => false,
    status: async () => ({ updates: release.filter((u) => left.has(u.id)), latest: { manifest: null } }),
    download: async (u, file) => fs.copyFileSync(u.src, file),
    verify: (file, u, manifest) => check.checkInstaller({ file, name: u.file, manifest, digest: u.digest, publicKey: '' }),
    running: async () => A.runningIds(await freshstart.runningImages(), [{ id: 'pdf', exes: ['Riyeser PDF.exe', 'Desk PDF.exe'] }]),
    busy: async () => ({}), idle: async () => false,
    install: async (u, file) => { const f = await quiet(file, u.args); if (f.ok) left.delete(u.id); return f; },
    installBatch: async () => { throw new Error('no whole-PC programs in this check'); },
    installSelf: (u, file, when) => selfRuns.push({ when }),
    log: (e) => logs.push(e),
  });

  // 0. work hours: downloaded, nothing installed (PDF is closed), no self-update at a start
  const r0 = await au.check();
  step('during work hours nothing installs, even with the program closed', r0.installed && !r0.installed.length && r0.waiting.pdf === 'work-hours', { waiting: r0.waiting });
  step('a Central start during work hours doesn\'t update itself', au.atStart({ appVersion: '1.0.0', newer: updates.newer }) === null);
  step('the "updates ready" item lists both', au.summary().ready.length === 2);
  when = { mode: 'asap' };

  // 1. Riyeser PDF open: it waits
  const pdf = spawn(PDF_EXE, [], { detached: true, stdio: 'ignore' }); pdf.unref();
  let open = null;
  for (let i = 0; i < 30 && !(open && open.has('pdf')); i++) { await wait(1000); open = A.runningIds(await freshstart.runningImages(), [{ id: 'pdf', exes: ['Riyeser PDF.exe'] }]); }
  step('Riyeser PDF is open', open && open.has('pdf'));
  const r1 = await au.check();
  step('while it\'s open, nothing installs', r1.installed && !r1.installed.includes('pdf') && r1.waiting.pdf === 'running', { waiting: r1.waiting });
  step('both installers were downloaded into the cache and checked', fs.readdirSync(path.join(work, 'updates')).length === 2 && logs.filter((e) => e.stage === 'checked').length === 2);
  step('Central\'s own update waits for the next start', r1.waiting.central === 'next-start' || r1.waiting.central === 'after-others', { central: r1.waiting.central });

  // 2. closed: the next look installs it with the real installer
  try { execFileSync('taskkill', ['/IM', 'Riyeser PDF.exe', '/F', '/T'], { stdio: 'ignore' }); } catch { /* gone */ }
  for (let i = 0; i < 20; i++) { await wait(1000); const o = A.runningIds(await freshstart.runningImages(), [{ id: 'pdf', exes: ['Riyeser PDF.exe'] }]); if (o && !o.has('pdf')) break; }
  await wait(3000);
  const before = stamp(PDF_EXE);
  const r2 = await au.tick();
  for (let i = 0; i < 10 && !fs.existsSync(PDF_EXE); i++) await wait(1000);
  step('closed: installed quietly by itself', r2.installed.includes('pdf'), { installed: r2.installed });
  const ran = logs.filter((e) => e.id === 'pdf' && e.stage === 'installed');
  step('the real installer finished (exit code 0) and Riyeser PDF is still there', ran.length === 1 && fs.existsSync(PDF_EXE) && regVersions().pdf, { before, after: stamp(PDF_EXE), freshCopy: stamp(PDF_EXE) !== before });
  const s2 = store.get(A.STATE, {});
  step('it\'s in Central\'s history and install log', s2.history[0] && s2.history[0].id === 'pdf' && logs.some((e) => e.stage === 'installed' && e.how === 'auto'), { history: s2.history[0] });

  // 3. Central's next start: its own update is handed over before the window, and installs quietly
  const c = au.atStart({ appVersion: '1.0.0', newer: updates.newer });
  step('at the next start Central\'s update is ready to install', c && fs.existsSync(c.file) && (await check.checkInstaller({ file: c.file, name: c.name, digest: c.digest, publicKey: '' })).ok);
  const findCentral = () => { try { return fs.readdirSync(programs).map((d) => path.join(programs, d, 'Riyeser Central.exe')).find((f) => fs.existsSync(f)) || null; } catch { return null; } };
  const was = findCentral(); const wasAt = was ? stamp(was) : '';
  const f3 = await quiet(c.file, ['/S']);
  let central = null;
  for (let i = 0; i < 60 && !central; i++) { central = findCentral(); if (!central) await wait(1000); }
  step('Riyeser Central installed itself quietly (exit code 0)', f3.ok && central && regVersions().central, { where: central, code: f3.code, freshCopy: !!central && stamp(central) !== wasAt });
  au.atStart({ appVersion: '99.0.0', newer: updates.newer });
  const s3 = store.get(A.STATE, {});
  step('the start after notes it in the history, and the cache is empty', s3.history[0] && s3.history[0].id === 'central' && !fs.readdirSync(path.join(work, 'updates')).length, { history: s3.history.map((h) => `${h.id} ${h.from} -> ${h.to}`) });
  try { execFileSync('taskkill', ['/IM', 'Riyeser Central.exe', '/F', '/T'], { stdio: 'ignore' }); } catch { /* not open */ }
  report.ok = true;
})().catch((e) => { report.error = e.message; }).finally(() => {
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
});
