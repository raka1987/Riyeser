// Riyeser Central's first run, "One installer": the plan -> the install queue, one Windows permission prompt for the
// whole-PC programs, skipping what's installed, pausing offline and carrying on, retrying, a second PC and
// "What is this PC for?", and someone on their own picking programs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const fr = require('../src/central/first-run');
const run = require('../src/central/install-run');
const u = require('../src/central/updates');

const plan = (...mods) => ({ online: { modules: Object.fromEntries(mods.map((m) => [m, { active: true, status: 'trial' }])) } });
const ids = (q) => q.map((i) => i.id);

function fakeSpawn(outcomes) {
  const calls = [];
  const fn = (command, args, options) => {
    const o = outcomes[calls.length] || { exit: 0 };
    calls.push({ command, args, options });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => { if (o.before) o.before(); if (o.stdout) child.stdout.emit('data', Buffer.from(o.stdout)); child.emit('exit', o.exit); });
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** A pretend PC: what's installed, what the network does, and every step the driver was asked for. */
function fakePc({ installed = [], offlineAfter = Infinity, failDownload = {}, failInstall = {}, batch = null } = {}) {
  const pc = { installed: new Set(installed), log: [], fetched: 0, online: true };
  pc.driver = {
    isOnline: () => pc.online,
    async fetch(it, onPct, onChecking) {
      if (pc.fetched >= offlineAfter) pc.online = false;
      if (!pc.online) throw Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), {});
      const n = failDownload[it.id];
      if (n) { failDownload[it.id] = n - 1; throw Object.assign(new Error('Download failed (502).'), { failure: { reason: 'download', message: `Couldn't download ${it.name}.`, fix: 'Try again.' } }); }
      pc.fetched++; onPct(0.5); onPct(1); onChecking();
      pc.log.push(`fetch ${it.id}`);
      return { file: `C:\\T\\${it.id}.exe`, version: '1.0.0' };
    },
    async install(it) {
      pc.log.push(`install ${it.id}`);
      if (failInstall[it.id]) { const f = failInstall[it.id]; throw Object.assign(new Error(f.message), { failure: f }); }
      pc.installed.add(it.id);
    },
    async installBatch(list) {
      pc.log.push(`batch ${list.map((x) => x.item.id).join('+')}`);
      if (batch) return batch(list);
      for (const x of list) pc.installed.add(x.item.id);
      return Object.fromEntries(list.map((x) => [x.item.id, null]));
    },
    async verify(it) { return pc.installed.has(it.id); },
  };
  return pc;
}

test('the plan becomes the programs to install: its modules, plus the free Documents and PDF', () => {
  assert.deepEqual(fr.planPrograms(plan('plus', 'payroll', 'pos', 'calls')), ['desk', 'pdf', 'accounting', 'team', 'linkoffice', 'payroll', 'pos']);
  // Accounting Plus covers Basics; free Invoices only when there's no Accounting app on the plan
  assert.deepEqual(fr.planPrograms(plan('basic', 'plus')), ['desk', 'pdf', 'accounting']);
  assert.deepEqual(fr.planPrograms(plan('bookings')), ['desk', 'invoices', 'pdf', 'bookings']);
  assert.deepEqual(fr.planPrograms(plan('as_built', 'estimate')), ['desk', 'invoices', 'pdf', 'estimate', 'services']);
  // an ended trial isn't on the plan; no plan at all is just the free programs
  assert.deepEqual(fr.planPrograms({ online: { modules: { pos: { active: false } } } }), ['desk', 'invoices', 'pdf']);
  assert.deepEqual(fr.planPrograms({}), ['desk', 'invoices', 'pdf']);
});

test('the queue: per-user programs first, the whole-PC ones (Link Office) last so Windows asks once; installed ones skipped', () => {
  const q = fr.buildQueue(fr.planPrograms(plan('plus', 'payroll', 'pos', 'calls')), { installed: ['pdf'] });
  assert.deepEqual(ids(q), ['desk', 'pdf', 'accounting', 'team', 'payroll', 'pos', 'linkoffice']);
  assert.equal(q.find((i) => i.id === 'pdf').stage, 'skipped');
  assert.equal(q.find((i) => i.id === 'linkoffice').elevate, true);
  assert.deepEqual(q.filter((i) => i.elevate).map((i) => i.id), u.PRODUCTS.filter((p) => p.elevate).map((p) => p.id));
  // Central itself is never in the queue; unknown ids are dropped; names come from Central's list
  assert.deepEqual(ids(fr.buildQueue(['central', 'nope', 'pos'], { names: { pos: 'Riyeser POS' } })), ['pos']);
  // two whole-PC programs (a future one): both at the end, together
  const products = [...u.PRODUCTS, { id: 'services', display: 'As Built', elevate: true, args: ['/S'] }].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i || p.elevate);
  const q2 = fr.buildQueue(['services', 'linkoffice', 'pos', 'desk'], { products: products.map((p) => (p.id === 'services' ? { ...p, elevate: true } : p)) });
  assert.deepEqual(ids(q2), ['desk', 'pos', 'linkoffice', 'services']);
});

test('install a plan end to end: one after another, the whole-PC ones in one batch (one permission prompt) at the end', async () => {
  const pc = fakePc();
  const r = fr.newRun({ ids: fr.planPrograms(plan('plus', 'pos', 'calls')) });
  const seen = [];
  const s = await fr.runQueue(r, pc.driver, { onChange: (x, id) => { if (id) seen.push(`${id}:${x.items.find((i) => i.id === id).stage}`); } });
  assert.equal(s.allDone, true); assert.equal(r.finished, true);
  assert.deepEqual(s.installed, ['desk', 'pdf', 'accounting', 'team', 'pos', 'linkoffice']);
  assert.deepEqual(pc.log.filter((l) => /^(install|batch)/.test(l)), ['install desk', 'install pdf', 'install accounting', 'install team', 'install pos', 'batch linkoffice']);
  // Link Office is downloaded in its turn, then waits ("ready") for the permission batch
  assert.ok(seen.indexOf('linkoffice:ready') > seen.indexOf('linkoffice:checking'));
  assert.ok(seen.indexOf('linkoffice:installing') > seen.indexOf('pos:installed'));
  // each program's bar only ever goes up
  for (const id of s.installed) {
    const bars = seen.filter((x) => x.startsWith(`${id}:`)).map((x) => fr.barPct({ stage: x.split(':')[1], pct: 1 }));
    assert.deepEqual(bars, [...bars].sort((a, b) => a - b), id);
  }
  assert.equal(fr.barPct({ stage: 'downloading', pct: 0.5 }) < fr.barPct({ stage: 'installing' }), true);
});

test('No on the one permission prompt: every whole-PC program in the batch says so, the others stay installed', async () => {
  const cancelled = run.installFailure({ code: null, startError: run.CODES.CANCELLED }, { name: 'Riyeser Link Office' });
  const pc = fakePc({ batch: (list) => Object.fromEntries(list.map((x) => [x.item.id, cancelled])) });
  const r = fr.newRun({ ids: ['pos', 'linkoffice'] });
  const s = await fr.runQueue(r, pc.driver);
  assert.deepEqual(s.installed, ['pos']); assert.deepEqual(s.failed, ['linkoffice']);
  const lo = r.items.find((i) => i.id === 'linkoffice');
  assert.equal(lo.reason, 'cancelled'); assert.match(lo.message, /You chose No/); assert.match(lo.fix, /choose Yes/);
  assert.equal(r.finished, false);
});

test('already installed programs are skipped (nothing downloaded); the run counts them as done', async () => {
  const pc = fakePc({ installed: ['desk', 'pdf', 'pos'] });
  const r = fr.newRun({ ids: ['desk', 'pdf', 'pos', 'team'], installed: ['desk', 'pdf', 'pos'] });
  const s = await fr.runQueue(r, pc.driver);
  assert.deepEqual(s.skipped, ['desk', 'pdf', 'pos']); assert.deepEqual(s.installed, ['team']);
  assert.deepEqual(pc.log, ['fetch team', 'install team']);
  assert.equal(fr.itemText(r.items[0]), 'Already on this PC');
});

test('offline: the rest pauses ("waiting for the internet"), the batch still runs for what was downloaded; back online it carries on', async () => {
  const pc = fakePc({ offlineAfter: 2 });
  let r = fr.newRun({ ids: ['desk', 'pdf', 'accounting', 'payroll', 'linkoffice'] });
  let s = await fr.runQueue(r, pc.driver);
  assert.deepEqual(s.installed, ['desk', 'pdf']);
  assert.deepEqual(s.paused, ['accounting', 'payroll', 'linkoffice']);
  assert.equal(r.items.find((i) => i.id === 'accounting').reason, 'offline');
  assert.match(fr.itemText(r.items.find((i) => i.id === 'payroll')), /Waiting for the internet/);
  assert.equal(pc.log.filter((l) => l.startsWith('fetch')).length, 2);   // nothing more was tried once offline
  // the run is saved as JSON (Central's store) and read back after a restart
  r = JSON.parse(JSON.stringify(r));
  pc.online = true; pc.fetched = -Infinity;
  r = fr.retry(r);   // what Central does when it's back online (paused ones go back in the queue)
  s = await fr.runQueue(r, pc.driver);
  assert.equal(s.allDone, true);
  assert.deepEqual(s.installed, ['desk', 'pdf', 'accounting', 'payroll', 'linkoffice']);
  assert.equal(pc.log.filter((l) => l === 'install desk').length, 1);   // what was done isn't done again
});

test('offline from the start: nothing is tried, everything waits', async () => {
  const pc = fakePc(); pc.online = false;
  const r = fr.newRun({ ids: ['pos', 'team'] });
  const s = await fr.runQueue(r, pc.driver);
  assert.deepEqual(s.paused, ['team', 'pos']); assert.deepEqual(pc.log, []);
  assert.equal(fr.isOffline(new Error('net::ERR_NAME_NOT_RESOLVED')), true);
  assert.equal(fr.isOffline(new Error('Download failed (502).')), false);
});

test('a download that breaks is tried once more by itself; an installer that fails shows a plain reason and Try again works', async () => {
  const pc = fakePc({ failDownload: { pos: 1, payroll: 5 }, failInstall: { team: run.installFailure({ code: 1, startError: null }, { name: 'Riyeser Link', args: ['/S'] }) } });
  let r = fr.newRun({ ids: ['pos', 'payroll', 'team'] });
  let s = await fr.runQueue(r, pc.driver);
  assert.deepEqual(s.installed, ['pos']);                // its first download broke, the second worked
  assert.deepEqual(s.failed, ['team', 'payroll']);
  const pay = r.items.find((i) => i.id === 'payroll'); assert.equal(pay.reason, 'download'); assert.match(pay.message, /Couldn't download/);
  const link = r.items.find((i) => i.id === 'team'); assert.equal(link.reason, 'running'); assert.match(link.fix, /Close Riyeser Link/);
  // Try again on Riyeser Link only (it was closed): only that one runs
  delete pc.driver; const pc2 = fakePc({ installed: ['pos'] });
  r = fr.retry(r, ['team']);
  assert.equal(r.items.find((i) => i.id === 'team').stage, 'waiting');
  assert.equal(r.items.find((i) => i.id === 'payroll').stage, 'failed');
  r.items = r.items.map((i) => (i.id === 'payroll' ? { ...i, stage: 'skipped' } : i));   // (left out of this round)
  s = await fr.runQueue(r, pc2.driver);
  assert.deepEqual(pc2.log, ['fetch team', 'install team']);
  assert.ok(s.installed.includes('team'));
});

test('the installer said yes but the program isn\'t there: a problem, not "Installed"', async () => {
  const pc = fakePc(); pc.driver.verify = async () => false;
  const r = fr.newRun({ ids: ['pdf'] });
  const s = await fr.runQueue(r, pc.driver);
  assert.deepEqual(s.failed, ['pdf']); assert.equal(r.items[0].reason, 'not-found');
});

test('Choose programs instead: untick some; what was already done is kept', () => {
  let r = fr.newRun({ ids: ['desk', 'pdf', 'pos', 'team'] });
  r.items = r.items.map((i) => (i.id === 'desk' ? { ...i, stage: 'installed', pct: 1 } : i));
  r = fr.choose(r, ['desk', 'team', 'payroll']);
  assert.deepEqual(ids(r.items), ['desk', 'team', 'payroll']);
  assert.equal(r.items[0].stage, 'installed'); assert.equal(r.items[2].stage, 'waiting');
});

test('which first run: a business signed in -> its plan; a personal account, no account or "Set up later" -> pick programs', () => {
  assert.equal(fr.pathFor({ company: { mode: 'online', workspace_id: 'w1', name: 'Sample Trading Co' }, kind: 'business' }), 'plan');
  assert.equal(fr.pathFor({ company: { mode: 'online', workspace_id: 'w1', name: 'Sample Trading Co' }, kind: null }), 'plan');
  assert.equal(fr.pathFor({ company: { mode: 'online', workspace_id: 'w1', name: 'Alex', kind: 'personal' } }), 'individual');
  assert.equal(fr.pathFor({ company: { mode: 'online', workspace_id: 'w1', name: 'Alex' }, kind: 'personal' }), 'individual');
  assert.equal(fr.pathFor({ company: { mode: 'local', name: 'My Shop' } }), 'individual');
  assert.equal(fr.pathFor({ company: null }), 'individual');
  // someone on their own: free and trial programs, not the office phone system; the free ones ticked to start with
  assert.ok(!fr.INDIVIDUAL.includes('linkoffice'));
  assert.deepEqual(fr.INDIVIDUAL_DEFAULT, ['invoices', 'desk', 'pdf']);
  for (const id of fr.INDIVIDUAL_DEFAULT) assert.ok(fr.INDIVIDUAL.includes(id));
});

test('"What is this PC for?": Office PC, Till, Reception, Everything keep the right programs of the plan', () => {
  const p = fr.planPrograms(plan('plus', 'payroll', 'pos', 'calls', 'bookings'));
  assert.deepEqual(fr.ROLES.map((r) => r.id), ['office', 'till', 'reception', 'everything']);
  assert.deepEqual(fr.forRole(p, 'everything'), p);
  assert.deepEqual(fr.forRole(p, 'office'), p.filter((id) => id !== 'pos'));        // "POS only on the till PC"
  assert.deepEqual(fr.forRole(p, 'till'), ['team', 'pos']);
  assert.deepEqual(fr.forRole(p, 'reception'), ['desk', 'bookings', 'team', 'linkoffice']);
  // a role that has nothing on this plan installs nothing (not everything); an unknown role is Everything
  assert.deepEqual(fr.forRole(fr.planPrograms(plan('plus')), 'till'), []);
  assert.deepEqual(fr.forRole(p, 'nonsense'), p);
  // the program to open when it's done follows the PC's job
  assert.equal(fr.mainProgram(fr.forRole(p, 'till'), 'till'), 'pos');
  assert.equal(fr.mainProgram(p, 'everything'), 'accounting');
  assert.equal(fr.mainProgram(fr.forRole(p, 'reception'), 'reception'), 'bookings');
});

test('a second PC of the same business: sign in, the same plan, only what this PC is for; programs already there skipped', async () => {
  const lic = plan('plus', 'payroll', 'pos', 'calls');
  // the first PC (Everything)
  const first = fakePc();
  const r1 = fr.newRun({ ids: fr.forRole(fr.planPrograms(lic), 'everything'), role: 'everything' });
  assert.equal((await fr.runQueue(r1, first.driver)).allDone, true);
  // the till PC: Riyeser Link was already installed there by hand
  const till = fakePc({ installed: ['team'] });
  const r2 = fr.newRun({ ids: fr.forRole(fr.planPrograms(lic), 'till'), role: 'till', installed: ['team'] });
  const s2 = await fr.runQueue(r2, till.driver);
  assert.deepEqual(s2.installed, ['pos']); assert.deepEqual(s2.skipped, ['team']);
  assert.ok(!till.log.some((l) => /payroll|accounting|linkoffice/.test(l)));   // nothing the till doesn't need, no permission prompt
  assert.deepEqual(s2.needsPermission, []);
});

test('the one permission prompt: a PowerShell script runs each installer in turn and writes each exit code', () => {
  const s = run.batchScript([{ id: 'linkoffice', file: "C:\\Users\\O'Neil\\Temp\\RiyeserLinkOffice-Setup.exe", args: ['/S'] }, { id: 'services', file: 'C:\\T\\As Built.exe', args: ['/S', '--x y'] }], 'C:\\T\\r.txt');
  assert.match(s, /Start-Process -FilePath 'C:\\Users\\O''Neil\\Temp\\RiyeserLinkOffice-Setup\.exe' -ArgumentList '\/S' -PassThru/);
  assert.match(s, /-ArgumentList '\/S "--x y"'/);
  assert.doesNotMatch(s, /-Verb RunAs/);   // already elevated inside: no second prompt
  assert.equal((s.match(/WaitForExit\(\)/g) || []).length, 2);
  assert.match(s, /RIYESER-BATCH linkoffice " \+ \[int\]\$p\.ExitCode/);
  assert.match(s, /RIYESER-BATCH services ERR " \+ \$n/);
  assert.match(s, /'RIYESER-BATCH DONE'/);
  assert.deepEqual(run.parseBatch('\r\nRIYESER-BATCH linkoffice 0\r\nRIYESER-BATCH services ERR 225\r\n', ['linkoffice', 'services', 'pos']), {
    linkoffice: { code: 0, startError: null }, services: { code: null, startError: 225 }, pos: { code: null, startError: 'start', detail: 'did not run' } });
});

test('runElevatedBatch: one PowerShell through "Run as administrator" for every whole-PC installer; No applies to all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riy-batch-'));
  const items = [{ id: 'linkoffice', file: 'C:\\T\\lo.exe', args: ['/S'] }, { id: 'services', file: 'C:\\T\\ab.exe', args: ['/S'] }];
  // Yes: the elevated script ran both and wrote their codes
  const sp = fakeSpawn([{ exit: 0, before: () => fs.writeFileSync(path.join(dir, 'riyeser-batch.txt'), 'RIYESER-BATCH linkoffice 0\nRIYESER-BATCH services 2\nRIYESER-BATCH DONE\n') }]);
  const ok = await run.runElevatedBatch({ items, spawn: sp, dir });
  assert.equal(sp.calls.length, 1);                      // one prompt for both
  assert.equal(sp.calls[0].command, 'powershell.exe');
  const outer = Buffer.from(sp.calls[0].args[sp.calls[0].args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.match(outer, /Start-Process -FilePath 'powershell\.exe' -ArgumentList '.*-File .*riyeser-batch\.ps1.*' -Verb RunAs/);
  assert.deepEqual(ok.results.linkoffice, { code: 0, startError: null });
  assert.equal(run.installFailure(ok.results.services, { name: 'As Built', args: ['/S'] }).reason, 'failed');
  assert.ok(!fs.existsSync(path.join(dir, 'riyeser-batch.ps1')));   // tidied away
  // No on the prompt
  const no = await run.runElevatedBatch({ items, dir, spawn: fakeSpawn([{ stdout: 'RIYESER-START-ERROR 1223 The operation was canceled by the user.', exit: run.PS_FAILED }]) });
  for (const id of ['linkoffice', 'services']) assert.equal(run.installFailure(no.results[id], { name: id }).reason, 'cancelled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Central wires the first run: its window steps, the IPC, offline resume, and Central\'s version', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'central-main.js'), 'utf8');
  for (const h of ['firstrun:get', 'firstrun:start', 'firstrun:retry', 'firstrun:role', 'firstrun:step', 'firstrun:profile', 'firstrun:logo', 'firstrun:resume']) assert.ok(main.includes(`'${h}'`), h);
  assert.match(main, /runElevatedBatch/);
  assert.match(main, /setInterval\(resumeIfOnline/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'central.html'), 'utf8');
  assert.ok(html.indexOf('first-run.js') > html.indexOf('company.js'));
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'first-run.js'), 'utf8');
  for (const t of ['Install your plan', 'Your business', 'What is this PC for?', 'Choose programs instead', 'Get help', 'Keep using Central']) assert.ok(ui.includes(t), t);
  assert.doesNotMatch(ui, /\balert\(|confirm\(/);   // no pop-ups
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'builder.config.js'), 'utf8');
  assert.match(cfg, /name: 'riyeser-central', version: '1\.9\.2'/);
});

test('"Your business": the currency follows the country unless chosen', () => {
  assert.equal(fr.currencyFor('Fiji'), 'FJD'); assert.equal(fr.currencyFor('Australia'), 'AUD'); assert.equal(fr.currencyFor('Other'), 'USD');
  for (const c of Object.values(fr.COUNTRY_CURRENCY)) assert.ok(fr.CURRENCIES.some(([k]) => k === c));
});
