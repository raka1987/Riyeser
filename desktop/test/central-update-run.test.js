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
