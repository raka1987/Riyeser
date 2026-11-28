// Riyeser Central's automatic updates (central/auto-update.js): the scheduler, the "is it running" and busy checks,
// retry and backoff, one Windows permission prompt a day, Central's own update at start, the setting and demo mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/central/auto-update');
const { newer } = require('../src/central/updates');
const L9 = require('../src/renderer/launcher');

const HOUR = 3600 * 1000; const DAY = 24 * HOUR;
const memStore = () => { const m = {}; return { get: (k, f) => (k in m ? m[k] : f), set: (k, v) => { m[k] = JSON.parse(JSON.stringify(v)); return v; }, m }; };
const U = (id, from, to, extra = {}) => ({ id, name: `Riyeser ${id}`, from, to, url: `https://github.com/raka1987/riyeser-downloads/releases/download/t/${id}.exe`, file: `${id}.exe`, args: ['/S'], self: id === 'central', elevate: false, digest: null, ...extra });
const cached = (...ups) => ({ ...A.read(memStore()), cache: Object.fromEntries(ups.map((u) => [u.id, { version: u.to, file: `/c/${u.id}.exe` }])) });

test('decide: a closed program installs, an open one waits, and "couldn\'t tell" counts as open', () => {
  const pdf = U('pdf', '0.25.0', '0.26.0'); const desk = U('desk', '1.0.0', '1.1.0');
  const st = cached(pdf, desk);
  let d = A.decide({ updates: [pdf, desk], state: st, running: new Set(['desk']), now: 0 });
  assert.deepEqual(d.install.map((u) => u.id), ['pdf']);
  assert.equal(d.waiting.desk, 'running');
  d = A.decide({ updates: [pdf], state: st, running: null, now: 0 });
  assert.deepEqual(d.install, []); assert.equal(d.waiting.pdf, 'running');
  // not downloaded yet
  d = A.decide({ updates: [U('payroll', '2.0.0', '2.1.0')], state: st, running: new Set(), now: 0 });
  assert.equal(d.waiting.payroll, 'downloading');
});

test('decide: busy signals hold a program back (open till, unsent website news)', () => {
  const pos = U('pos', '1.0.0', '1.1.0'); const inv = U('invoices', '1.0.0', '1.1.0'); const pdf = U('pdf', '0.25.0', '0.26.0');
  const busy = A.busyFrom({ company: { tillOpen: true, unsent: 2 } });
  assert.equal(busy.pos, 'till-open'); assert.equal(busy.invoices, 'unsent'); assert.equal(busy.accounting, 'unsent'); assert.equal(busy.pdf, undefined);
  const d = A.decide({ updates: [pos, inv, pdf], state: cached(pos, inv, pdf), running: new Set(), busy, now: 0 });
  assert.deepEqual(d.install.map((u) => u.id), ['pdf']);
  assert.equal(d.waiting.pos, 'till-open'); assert.equal(d.waiting.invoices, 'unsent');
  assert.deepEqual(A.busyFrom({ company: { tillOpen: false, unsent: 0 }, centralPending: 3 }), { central: 'unsent' });
  assert.deepEqual(A.busyFrom({}), {});
});

test('runningIds: Windows\' list of running programs -> the Riyeser programs that are open', () => {
  const programs = [{ id: 'pdf', exes: ['Riyeser PDF.exe', 'Desk PDF.exe'] }, { id: 'payroll', exes: ['Riyeser Payroll.exe'] }];
  assert.deepEqual([...A.runningIds(['explorer.exe', 'riyeser pdf.exe'], programs)], ['pdf']);
  assert.equal(A.runningIds(null, programs), null);
  assert.equal(A.runningIds([], programs).size, 0);
});

test('decide: whole-PC updates go together, only while idle with nothing open, at most one prompt a day', () => {
  const lo = U('linkoffice', '1.2.0', '1.3.0', { elevate: true }); const x = U('other', '1.0.0', '1.1.0', { elevate: true });
  const st = cached(lo, x); const now = 10 * DAY;
  let d = A.decide({ updates: [lo, x], state: st, running: new Set(), idle: false, now });
  assert.deepEqual(d.elevate, []); assert.equal(d.waiting.linkoffice, 'idle');
  d = A.decide({ updates: [lo, x], state: st, running: new Set(['pdf']), idle: true, now });
  assert.deepEqual(d.elevate, [], 'another Riyeser program open: not now');
  d = A.decide({ updates: [lo, x], state: st, running: new Set(), idle: true, now });
  assert.deepEqual(d.elevate.map((u) => u.id), ['linkoffice', 'other'], 'both in one prompt');
  d = A.decide({ updates: [lo, x], state: { ...st, lastPrompt: now - 5 * HOUR }, running: new Set(), idle: true, now });
  assert.deepEqual(d.elevate, []); assert.equal(d.waiting.other, 'prompt-today');
  d = A.decide({ updates: [lo], state: { ...st, lastPrompt: now - 25 * HOUR }, running: new Set(), idle: true, now });
  assert.equal(d.elevate.length, 1, 'a day later: asked again');
});

test('decide: Central goes last, only while idle with no Riyeser program open; otherwise the next start', () => {
  const me = U('central', '1.9.1', '1.9.3'); const pdf = U('pdf', '0.25.0', '0.26.0');
  const st = cached(me, pdf);
  let d = A.decide({ updates: [me, pdf], state: st, running: new Set(), idle: true, now: 0 });
  assert.equal(d.self, null); assert.equal(d.waiting.central, 'after-others'); assert.equal(d.install[0].id, 'pdf');
  d = A.decide({ updates: [me], state: st, running: new Set(), idle: false, now: 0 });
  assert.equal(d.waiting.central, 'next-start');
  d = A.decide({ updates: [me], state: st, running: new Set(['payroll']), idle: true, now: 0 });
  assert.equal(d.waiting.central, 'next-start');
  d = A.decide({ updates: [me], state: st, running: new Set(), idle: true, now: 0 });
  assert.equal(d.self.id, 'central');
  d = A.decide({ updates: [me], state: st, running: new Set(), idle: true, busy: { central: 'unsent' }, now: 0 });
  assert.equal(d.self, null); assert.equal(d.waiting.central, 'unsent');
});

test('decide: the setting off, or demo mode, installs nothing', () => {
  const pdf = U('pdf', '0.25.0', '0.26.0');
  assert.deepEqual(A.decide({ updates: [pdf], state: cached(pdf), running: new Set(), on: false }).waiting, { pdf: 'off' });
  assert.deepEqual(A.decide({ updates: [pdf], state: cached(pdf), running: new Set(), demo: true }).waiting, { pdf: 'demo' });
  assert.equal(A.settingOn({}), true, 'on by default');
  assert.equal(A.settingOn({ autoUpdate: false }), false);
});

/** A scheduler with stand-ins for Windows: a temp cache folder and a fake release. */
function rig(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riy-auto-'));
  const store = memStore(); let now = 100 * DAY;
  const t = { updates: [U('pdf', '0.25.0', '0.26.0')], open: new Set(), busy: {}, idle: false, on: true, demo: false, allowed: true, manual: false,
    installs: [], batches: [], selfRuns: [], logs: [], downloads: 0, reported: 0, verifyOk: true, installResult: () => ({ ok: true }), batchResult: (list) => Object.fromEntries(list.map(({ u }) => [u.id, { ok: true }])) };
  Object.assign(t, over);
  const au = A.createAutoUpdater({
    store, now: () => now, enabled: () => t.on, isDemo: () => t.demo, allowed: () => t.allowed, manualBusy: () => t.manual, cacheDir: dir,
    status: async () => ({ updates: t.updates.filter((u) => !u.done), latest: { manifest: { kind: 'test' } } }),
    download: async (u, file) => { t.downloads++; fs.writeFileSync(file, `installer ${u.id} ${u.to}`); },
    verify: async () => ({ ok: t.verifyOk, error: t.verifyOk ? null : 'not genuine' }),
    running: async () => t.open, busy: async () => t.busy, idle: async () => t.idle,
    install: async (u, file) => { t.installs.push({ id: u.id, file }); const r = t.installResult(u); if (r.ok) u.done = true; return r; },
    installBatch: async (list) => { t.batches.push(list.map(({ u }) => u.id)); const r = t.batchResult(list); for (const { u } of list) if (r[u.id] && r[u.id].ok) u.done = true; return r; },
    installSelf: (u, file, when) => t.selfRuns.push({ v: u.to, file, when }),
    log: (e) => t.logs.push(e), reported: () => { t.reported++; },
  });
  return { au, t, store, dir, advance: (ms) => { now += ms; }, now: () => now };
}

test('scheduler: the first check a minute after start, a check every 6 hours, a look every 5 minutes', () => {
  const calls = [];
  const timers = { setTimeout: (fn, ms) => { calls.push(['once', ms]); return { fn }; }, setInterval: (fn, ms) => { calls.push(['every', ms]); return { fn }; }, clearTimeout() {}, clearInterval() {} };
  const au = A.createAutoUpdater({ store: memStore(), status: async () => ({ updates: [] }) }, { timers });
  au.start();
  assert.deepEqual(calls, [['once', 60 * 1000], ['every', 6 * HOUR], ['every', 5 * 60 * 1000]]);
});

test('check: downloads into the cache, checks it, installs a closed program quietly, logs it and tells Riyeser', async () => {
  const { au, t, store } = rig();
  const r = await au.check();
  assert.deepEqual(r.installed, ['pdf']);
  assert.equal(t.downloads, 1); assert.equal(t.installs.length, 1);
  assert.ok(!fs.existsSync(t.installs[0].file), 'the cached installer is removed once it went in');
  const s = store.get(A.STATE);
  assert.equal(s.history[0].id, 'pdf'); assert.equal(s.history[0].to, '0.26.0'); assert.equal(s.counts.installed, 1);
  assert.ok(t.logs.some((e) => e.stage === 'installed' && e.how === 'auto' && /auto so far: 1 installed, 0 failed/.test(e.detail)));
  assert.equal(t.reported, 1);
  assert.equal(L9.autoLine(s.history[0], 'PDF', s.history[0].at + 2 * HOUR), 'Updated PDF to 0.26.0 · 2 hours ago');
  assert.equal(au.summary().last.to, '0.26.0');
});

test('a program that\'s open waits, and installs once it\'s closed (the 5-minute look)', async () => {
  const { au, t } = rig({ open: new Set(['pdf']) });
  let r = await au.check();
  assert.deepEqual(r.installed, []); assert.equal(au.summary().waiting.pdf, A.WAITING.running);
  assert.equal(t.installs.length, 0);
  t.open = new Set();
  r = await au.tick();
  assert.deepEqual(r.installed, ['pdf']); assert.equal(t.downloads, 1, 'not downloaded again');
});

test('busy: an open till shift holds POS back until it\'s closed', async () => {
  const { au, t } = rig({ updates: [U('pos', '1.0.0', '1.1.0')], busy: { pos: 'till-open' } });
  await au.check();
  assert.equal(t.installs.length, 0); assert.equal(au.summary().waiting.pos, A.WAITING['till-open']);
  t.busy = {};
  assert.deepEqual((await au.tick()).installed, ['pos']);
});

test('retry and backoff: tried again an hour later; after two failures it needs a look, Try again starts over', async () => {
  const { au, t, advance, store } = rig({ installResult: () => ({ ok: false, reason: 'failed', message: 'The installer stopped (code 2).' }) });
  await au.check();
  assert.equal(t.installs.length, 1);
  await au.tick(); assert.equal(t.installs.length, 1, 'not again straight away');
  assert.equal(au.summary().waiting.pdf, A.WAITING['retry-later']);
  advance(61 * 60 * 1000); await au.tick();
  assert.equal(t.installs.length, 2);
  advance(2 * HOUR); await au.tick();
  assert.equal(t.installs.length, 2, 'stops after two failures');
  const att = au.summary().attention;
  assert.equal(att.length, 1); assert.equal(att[0].id, 'pdf'); assert.match(att[0].error, /code 2/);
  const pill = L9.attention({ autoFailed: att, names: { pdf: 'PDF' } });
  assert.equal(pill[0].title, 'PDF didn\'t update to 0.26.0'); assert.equal(pill[0].act.label, 'Try again'); assert.match(pill[0].act.attrs, /data-autoretry="pdf"/);
  assert.equal(store.get(A.STATE).counts.failed, 2);
  t.installResult = () => ({ ok: true });
  await au.retry('pdf');
  assert.equal(t.installs.length, 3); assert.deepEqual(au.summary().attention, []);
});

test('the installer says the program was opened meanwhile: not a failure, just waits', async () => {
  const { au } = rig({ installResult: () => ({ ok: false, reason: 'running', message: 'PDF is open.' }) });
  await au.check();
  assert.deepEqual(au.summary().attention, []);
  assert.equal(au.state().items.pdf, undefined);
});

test('a download that isn\'t a genuine Riyeser installer is thrown away and counts as a failure', async () => {
  const { au, t, dir } = rig({ verifyOk: false });
  await au.check();
  assert.equal(t.installs.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(au.state().items.pdf.fails, 1);
});

test('at most one Windows permission prompt a day, with every whole-PC update in it; "No" just waits a day', async () => {
  const lo = U('linkoffice', '1.2.0', '1.3.0', { elevate: true }); const x = U('other', '1.0.0', '1.1.0', { elevate: true });
  const { au, t, advance } = rig({ updates: [lo, x], idle: false, batchResult: (list) => Object.fromEntries(list.map(({ u }) => [u.id, { ok: false, reason: 'cancelled' }])) });
  await au.check();
  assert.deepEqual(t.batches, [], 'not while someone is using the PC');
  t.idle = true;
  await au.tick();
  assert.deepEqual(t.batches, [['linkoffice', 'other']], 'one prompt for both');
  await au.tick(); advance(3 * HOUR); await au.tick();
  assert.equal(t.batches.length, 1, 'not asked again the same day');
  assert.deepEqual(au.summary().attention, [], '"No" isn\'t a failure');
  assert.equal(au.summary().waiting.linkoffice, A.WAITING['prompt-today']);
  advance(DAY); t.batchResult = (list) => Object.fromEntries(list.map(({ u }) => [u.id, { ok: true }]));
  const r = await au.tick();
  assert.equal(t.batches.length, 2); assert.deepEqual(r.installed.sort(), ['linkoffice', 'other']);
  assert.equal(au.state().counts.prompts, 2);
});

test('order: other programs first, Central last (while idle, nothing open)', async () => {
  const { au, t } = rig({ updates: [U('central', '1.9.1', '1.9.3'), U('pdf', '0.25.0', '0.26.0')], idle: true });
  await au.check();
  assert.deepEqual(t.installs.map((x) => x.id), ['pdf']);
  assert.equal(t.selfRuns.length, 0, 'Central waits until the next look, after the others');
  await au.tick();
  assert.equal(t.selfRuns.length, 1); assert.equal(t.selfRuns[0].when, 'idle');
});

test('Central\'s own update while someone works: waits for the next start, then installs before the window', async () => {
  const me = U('central', '1.9.1', '1.9.3');
  const { au, t, store } = rig({ updates: [me], idle: false });
  await au.check();
  assert.equal(t.selfRuns.length, 0); assert.equal(au.summary().waiting.central, A.WAITING['next-start']);
  // next start, still 1.9.1: the cached installer is handed back to run under the splash
  const c = au.atStart({ appVersion: '1.9.1', newer });
  assert.ok(c && c.version === '1.9.3' && fs.existsSync(c.file));
  assert.equal(store.get(A.STATE).self.when, 'start');
  // the start after that, now 1.9.3: noted in the history, cache tidied
  assert.equal(au.atStart({ appVersion: '1.9.3', newer }), null);
  const s = store.get(A.STATE);
  assert.equal(s.history[0].id, 'central'); assert.equal(s.history[0].from, '1.9.1'); assert.equal(s.history[0].to, '1.9.3');
  assert.equal(s.cache.central, undefined); assert.ok(!fs.existsSync(c.file));
});

test('Central\'s update at start: never in demo mode, with the setting off, with unsent online marks, or after two tries', async () => {
  const me = U('central', '1.9.1', '1.9.3');
  const { au, t } = rig({ updates: [me] });
  await au.check();
  t.demo = true; assert.equal(au.atStart({ appVersion: '1.9.1', newer }), null);
  t.demo = false; t.on = false; assert.equal(au.atStart({ appVersion: '1.9.1', newer }), null);
  t.on = true; assert.equal(au.atStart({ appVersion: '1.9.1', newer, busy: { central: 'unsent' } }), null);
  t.allowed = false; assert.equal(au.atStart({ appVersion: '1.9.1', newer }), null, 'a developer copy never updates itself');
  t.allowed = true;
  assert.ok(au.atStart({ appVersion: '1.9.1', newer }), 'first try');
  // it didn't take (still 1.9.1): counted as a failure, and the next try waits an hour, not straight away
  assert.equal(au.atStart({ appVersion: '1.9.1', newer }), null);
  assert.equal(au.state().items.central.fails, 1);
});

test('the setting off: nothing is downloaded or installed', async () => {
  const { au, t } = rig({ on: false });
  const r = await au.check();
  assert.ok(r.skipped); assert.equal(t.downloads, 0); assert.equal(t.installs.length, 0);
  assert.equal(au.summary().on, false);
});

test('demo mode: never updates by itself', async () => {
  const { au, t } = rig({ demo: true, idle: true, updates: [U('central', '1.9.1', '1.9.3'), U('pdf', '0.25.0', '0.26.0')] });
  await au.check(); await au.tick();
  assert.equal(t.downloads, 0); assert.equal(t.installs.length, 0); assert.equal(t.selfRuns.length, 0);
  assert.equal(au.atStart({ appVersion: '1.9.1', newer }), null);
});

test('"Update all" running: the automatic updates wait for it', async () => {
  const { au, t } = rig({ manual: true });
  await au.check();
  assert.equal(t.installs.length, 0);
  t.manual = false;
  assert.deepEqual((await au.check()).installed, ['pdf']);
});

test('a newer release replaces the cached download; an update installed by hand drops it', async () => {
  const pdf = U('pdf', '0.25.0', '0.26.0');
  const { au, t, dir } = rig({ updates: [pdf], open: new Set(['pdf']) });
  await au.check();
  assert.equal(fs.readdirSync(dir).length, 1);
  t.updates = [U('pdf', '0.25.0', '0.27.0')];
  await au.check();
  assert.deepEqual(fs.readdirSync(dir), ['pdf-0.27.0-pdf.exe']);
  t.updates = [];
  await au.check();
  assert.deepEqual(fs.readdirSync(dir), []);
});

// needs the app's dependencies (sql.js); the Windows install job runs these tests without npm install
const hasSqlJs = (() => { try { require.resolve('sql.js/dist/sql-wasm.js'); return true; } catch { return false; } })();
test('Central\'s company-file busy check reads an open till and unsent website news (read-only)', { skip: !hasSqlJs && 'sql.js is not installed here' }, async () => {
  const sources = require('../src/central/sources');
  const initSql = require('sql.js/dist/sql-wasm.js');
  const SQL = await initSql({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riy-busy-'));
  const make = (sql) => { const db = new SQL.Database(); db.run(sql); const f = path.join(dir, `${Math.random()}.db`); fs.writeFileSync(f, Buffer.from(db.export())); db.close(); return f; };
  const local = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`; };
  const now = new Date();
  const f1 = make(`CREATE TABLE pos_shifts (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO pos_shifts (status) VALUES ('closed'), ('open');
    CREATE TABLE online_outbox (id INTEGER PRIMARY KEY, created_at TEXT, sent_at TEXT, tries INTEGER DEFAULT 0);
    INSERT INTO online_outbox (created_at, sent_at, tries) VALUES ('${local(now)}', NULL, 0), ('${local(new Date(now - 10 * DAY))}', NULL, 0), ('${local(now)}', '${local(now)}', 1);`);
  assert.deepEqual(await sources.companyBusy(f1, { now }), { found: true, tillOpen: true, unsent: 1 });
  const f2 = make('CREATE TABLE company (id INTEGER PRIMARY KEY)');   // an older program: no till, no outbox
  assert.deepEqual(await sources.companyBusy(f2, { now }), { found: true, tillOpen: false, unsent: 0 });
  assert.deepEqual(await sources.companyBusy(path.join(dir, 'none.db')), { found: false, tillOpen: false, unsent: 0 });
});
