// Update all (central/update-run.js): every way an update can fail shows a plain reason, is logged, and doesn't stop
// the others; Central's own update goes last and only when the rest went in. Plain Node, no Windows needed.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { runUpdates } = require('../src/central/update-run');
const run = require('../src/central/install-run');
const L9 = require('../src/renderer/launcher');

const U = (id, name, extra = {}) => ({ id, name, to: '2.11.0', url: `https://github.com/raka1987/Riyeser/releases/download/t/${id}.exe`, ...extra });
const FIVE = [U('accounting-basics', 'Riyeser Accounting Basics'), U('pos', 'Riyeser POS'), U('bookings', 'Riyeser Bookings'), U('estimate', 'Riyeser Estimate'), U('central', 'Riyeser Central', { self: true, to: '1.9.2' })];
const errno = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code });

function harness(over = {}) {
  const seen = { tell: [], log: [], installed: [], self: [], closed: [], reopened: [] };
  const deps = {
    platform: 'win32', scanWait: { tries: 3, waitMs: 0 },
    fileFor: (u) => `C:\\Temp\\riyser-update-x\\${u.id}.exe`,
    download: async (u, file, onPct) => { onPct(0.5); onPct(1); },
    verify: async () => ({ how: 'github-digest' }),
    closeProgram: async (u) => { seen.closed.push(u.id); return { closed: [], stillOpen: [] }; },
    reopen: (u) => seen.reopened.push(u.id),
    install: async (u) => { seen.installed.push(u.id); },
    selfInstall: async (u) => { seen.self.push(u.id); },
    tell: (u, x) => seen.tell.push({ id: u.id, ...x }),
    log: (e) => seen.log.push(e),
    ...over,
  };
  return { deps, seen };
}

test('all five: Central last, through its own restart; each step told and logged', async () => {
  const { deps, seen } = harness();
  const r = await runUpdates(FIVE, deps);
  assert.deepStrictEqual(r, { done: ['accounting-basics', 'pos', 'bookings', 'estimate', 'central'], failed: [], restarting: true });
  assert.deepStrictEqual(seen.installed, ['accounting-basics', 'pos', 'bookings', 'estimate']);
  assert.deepStrictEqual(seen.self, ['central']);
  const ab = seen.tell.filter((t) => t.id === 'accounting-basics').map((t) => t.stage);
  assert.deepStrictEqual([...new Set(ab)], ['downloading', 'checking', 'installing']);
  assert.ok(seen.log.some((e) => e.id === 'accounting-basics' && e.stage === 'checked' && e.how === 'github-digest'));
});

test('the antivirus takes the download away (the owner\'s 1.9.0 bug): a plain reason, logged, the others still update, Central waits', async () => {
  const { deps, seen } = harness({ download: async (u) => { if (u.id === 'accounting-basics') throw errno('ENOENT', "no such file or directory, stat 'C:\\Temp\\x.exe'"); } });
  const r = await runUpdates(FIVE, deps);
  assert.strictEqual(r.restarting, false);
  assert.deepStrictEqual(r.done, ['pos', 'bookings', 'estimate']);
  assert.deepStrictEqual(r.failed.map((f) => [f.id, f.reason]), [['accounting-basics', 'blocked'], ['central', 'waiting']]);
  assert.match(r.failed[0].message, /antivirus/); assert.doesNotMatch(r.failed[0].message, /ENOENT/);
  assert.match(r.failed[0].fix, /Try again/);
  assert.ok(seen.log.some((e) => e.id === 'accounting-basics' && e.stage === 'failed' && e.reason === 'blocked' && /ENOENT/.test(e.detail)));
  assert.ok(seen.tell.some((t) => t.id === 'accounting-basics' && t.stage === 'failed' && /antivirus/.test(t.message)));
  assert.deepStrictEqual(seen.self, []);
});

test('the file is held by a scan for a moment: waited for, then installs', async () => {
  let n = 0;
  const { deps, seen } = harness({ verify: async () => { if (++n < 3) throw errno('EBUSY', 'resource busy or locked'); return { how: 'github-digest' }; } });
  const r = await runUpdates([FIVE[0]], deps);
  assert.deepStrictEqual(r.failed, []); assert.strictEqual(n, 3); assert.deepStrictEqual(seen.installed, ['accounting-basics']);
});

test('held for too long: blocked, with Try again', async () => {
  const { deps } = harness({ verify: async () => { throw errno('EBUSY', 'resource busy or locked'); } });
  const r = await runUpdates([FIVE[0]], deps);
  assert.strictEqual(r.failed[0].reason, 'blocked');
});

test('a damaged download (checksum) and a refused signature: plain reason, nothing run', async () => {
  for (const msg of ['The download was damaged (its checksum doesn\'t match). Nothing was changed. Please try again.', 'This download couldn\'t be checked as a genuine Riyeser installer, so it wasn\'t run.']) {
    const { deps, seen } = harness({ verify: async () => { throw new Error(msg); } });
    const r = await runUpdates([FIVE[0]], deps);
    assert.strictEqual(r.failed[0].reason, 'check'); assert.strictEqual(r.failed[0].message, msg);
    assert.deepStrictEqual(seen.installed, []);
  }
});

test('the connection drops or the address is refused: a download failure with the reason', async () => {
  const { deps } = harness({ download: async () => { throw new Error('The download stopped part-way.'); } });
  const r = await runUpdates([FIVE[1]], deps);
  assert.strictEqual(r.failed[0].reason, 'download'); assert.match(r.failed[0].message, /Couldn't download the Riyeser POS update: The download stopped part-way/);
  assert.match(r.failed[0].fix, /internet/);
});

test('the program is open: Central closes it first, reopens it after; if the installer still says code 5 it says Close it, Try again', async () => {
  const { deps, seen } = harness({ closeProgram: async (u) => ({ closed: [u.name], stillOpen: [] }) });
  await runUpdates([FIVE[0]], deps);
  assert.deepStrictEqual(seen.reopened, ['accounting-basics']);
  assert.ok(seen.log.some((e) => e.stage === 'closed'));
  const f = run.installFailure({ code: 5, startError: null }, { name: 'Riyeser Accounting Basics', args: ['/VERYSILENT'] });
  const h = harness({ install: async () => { throw Object.assign(new Error(f.message), { failure: f }); } });
  const r = await runUpdates([FIVE[0]], h.deps);
  assert.strictEqual(r.failed[0].reason, 'running'); assert.match(r.failed[0].fix, /then click Try again/);
  assert.ok(!h.seen.log.some((e) => e.stage === 'failed'), 'the installer step logs its own line (no double entry)');
});

test('Windows permission: the window is told the moment Windows asks', async () => {
  const { deps, seen } = harness({ install: async (u, file, onElevate) => { onElevate(); } });
  await runUpdates([U('linkoffice', 'Riyeser Link Office', { elevate: true })], deps);
  const asks = seen.tell.filter((t) => t.stage === 'installing' && t.elevate);
  assert.ok(asks.length >= 1);
  assert.strictEqual(L9.updateStep({ stage: 'installing', elevate: true, name: 'Riyeser Link Office' }), 'Installing Riyeser Link Office… Windows is asking for permission — look for the prompt on the taskbar');
});

test('install-run asks onElevate before an elevated start (also on the retry after error 740)', async () => {
  const spawn = (cmd) => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    setImmediate(() => { if (cmd === 'powershell.exe') c.emit('exit', 0); else c.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })); }); return c; };
  let asked = 0;
  const r = await run.runInstaller({ file: 'C:\\x.exe', args: ['/S'], spawn, onElevate: () => { asked++; } });
  assert.strictEqual(r.retried, true); assert.strictEqual(r.code, 0); assert.strictEqual(asked, 1);
});

test('an unexpected error is still a plain failure, never a stuck banner', async () => {
  const { deps } = harness({ install: async () => { throw new TypeError('x is not a function'); } });
  const r = await runUpdates([FIVE[0]], deps);
  assert.strictEqual(r.failed.length, 1); assert.ok(r.failed[0].message); assert.ok(r.failed[0].fix);
});

test('every step has a banner line', () => {
  for (const stage of ['downloading', 'checking', 'installing', 'restarting', 'failed']) assert.ok(L9.updateStep({ stage, name: 'X', pct: 1 }));
  assert.strictEqual(L9.updateStep({ stage: 'downloading', name: 'Riyeser POS', pct: 1 }), 'Downloading Riyeser POS… 100%');
});

// ---------- the Updates panel and the Update now? box (avatar menu → Updates) ----------
const AU = require('../src/central/auto-update');

test('Set a time…: a picked time holds the update until then, then it may install (work hours or not)', () => {
  const u = { id: 'pos', to: '2.11.0' };
  const mon10 = new Date(2026, 10, 30, 10, 0).getTime(); const mon23 = new Date(2026, 10, 30, 23, 0).getTime();
  const state = { approval: null, tonight: { items: { pos: '2.11.0' }, after: mon23 } };
  assert.strictEqual(AU.timeGate(u, { when: { mode: 'outside' }, state, now: mon10 }), 'scheduled');
  assert.strictEqual(AU.timeGate(u, { when: { mode: 'outside' }, state, now: mon23 + 1000 }), null);
  assert.strictEqual(AU.timeGate(u, { when: { mode: 'approve' }, state, now: mon23 + 1000 }), null);
  // a time picked inside work hours (approved by an owner or admin in central-main.js) also goes ahead at that time
  const noon = new Date(2026, 10, 30, 12, 0).getTime();
  assert.strictEqual(AU.timeGate(u, { when: { mode: 'outside' }, state: { tonight: { items: { pos: '2.11.0' }, after: noon } }, now: noon + 1 }), null);
  // an older Tonight (no time) still waits for after work
  assert.strictEqual(AU.timeGate(u, { when: { mode: 'outside' }, state: { tonight: { items: { pos: '2.11.0' } } }, now: mon10 }), 'work-hours');
});

test('Tonight (after hours) is the end of today\'s work hours, or now when it\'s already after work', () => {
  const mon10 = new Date(2026, 10, 30, 10, 0).getTime();
  assert.strictEqual(AU.afterWork(mon10, { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }), new Date(2026, 10, 30, 18, 0).getTime());
  const sat = new Date(2026, 10, 28, 10, 0).getTime();
  assert.strictEqual(AU.afterWork(sat, {}), sat);
});

test('the automatic updater remembers a picked time and the items', () => {
  const store = { d: {}, get(k, def) { return k in this.d ? this.d[k] : def; }, set(k, v) { this.d[k] = v; }, update(k, def, fn) { this.d[k] = fn(this.get(k, def)); } };
  const au = AU.createAutoUpdater({ store, when: () => ({ mode: 'outside' }), isDemo: () => false, allowed: () => true, manualBusy: () => false, cacheDir: '/tmp/x',
    status: async () => ({ updates: [] }), download: async () => {}, verify: async () => ({ ok: true }), running: async () => [], busy: async () => ({}), idle: async () => false,
    install: async () => ({ ok: true }), installBatch: async () => ({}), installSelf: () => {}, log: () => {}, onChange: () => {}, reported: () => {} }, { now: () => 1000 });
  const sum = au.tonight({ by: 'owner@example.com', items: { pos: '2.11.0' }, after: 5000 });
  assert.deepStrictEqual(sum.tonight.items, { pos: '2.11.0' }); assert.strictEqual(sum.tonight.after, 5000);
  assert.match(L9.scheduleLine(sum, 1000), /^Update scheduled for /);
});

test('the schedule line and the times read plainly', () => {
  const today = new Date(2026, 10, 30, 10, 0).getTime();
  assert.strictEqual(L9.clock(new Date(2026, 10, 30, 23, 0).getTime(), today), '11:00 pm');
  assert.strictEqual(L9.clock(new Date(2026, 11, 1, 8, 30).getTime(), today), 'tomorrow 8:30 am');
  assert.strictEqual(L9.scheduleLine({ mode: 'outside', inWork: true, hours: { end: '18:00' } }), 'Automatic updates: tonight, after 6:00 pm');
  assert.strictEqual(L9.scheduleLine({ mode: 'approve' }), 'Automatic updates: only when an owner or admin approves');
  assert.strictEqual(L9.scheduleLine({ mode: 'asap' }), 'Automatic updates: as soon as each program is closed');
  assert.strictEqual(L9.scheduleLine({ demo: true }), 'Automatic updates: off while demo mode is on');
  assert.strictEqual(L9.scheduleLine({ mode: 'outside', tonight: { after: new Date(2026, 10, 30, 23, 0).getTime(), items: { pos: '2.11.0' } } }, today), 'Update scheduled for 11:00 pm');
  assert.strictEqual(L9.scheduleLine(null), '');
});

test('the panel lists each installed program with its version, the newest and Up to date / Update available', () => {
  const rows = L9.updateRows({ versions: { installed: { central: '1.9.1', pdf: '0.26.0', pos: '2.10.1' }, latest: { central: '1.9.2', pdf: '0.26.0', pos: '2.11.0' } },
    updates: [{ id: 'central', from: '1.9.1', to: '1.9.2' }, { id: 'pos', from: '2.10.1', to: '2.11.0' }], ids: ['central', 'pdf', 'pos', 'payroll'], names: { pdf: 'Riyeser PDF', pos: 'Riyeser POS', payroll: 'Riyeser Payroll' } });
  assert.deepStrictEqual(rows.map((r) => [r.name, r.installed, r.newest, r.status]), [
    ['Riyeser Central', '1.9.1', '1.9.2', 'Update available'], ['Riyeser PDF', '0.26.0', '0.26.0', 'Up to date'],
    ['Riyeser POS', '2.10.1', '2.11.0', 'Update available'], ['Riyeser Payroll', '', '', 'Not in the latest release']]);
});
