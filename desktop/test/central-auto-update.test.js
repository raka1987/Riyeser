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
const ASAP = { mode: 'asap' };   // the mechanics below, without the time rules (those have their own tests)
const memStore = () => { const m = {}; return { get: (k, f) => (k in m ? m[k] : f), set: (k, v) => { m[k] = JSON.parse(JSON.stringify(v)); return v; }, m }; };
const U = (id, from, to, extra = {}) => ({ id, name: `Riyeser ${id}`, from, to, url: `https://github.com/raka1987/riyeser-downloads/releases/download/t/${id}.exe`, file: `${id}.exe`, args: ['/S'], self: id === 'central', elevate: false, digest: null, ...extra });
const cached = (...ups) => ({ ...A.read(memStore()), cache: Object.fromEntries(ups.map((u) => [u.id, { version: u.to, file: `/c/${u.id}.exe` }])) });

test('decide: a closed program installs, an open one waits, and "couldn\'t tell" counts as open', () => {
  const pdf = U('pdf', '0.25.0', '0.26.0'); const desk = U('desk', '1.0.0', '1.1.0');
  const st = cached(pdf, desk);
  let d = A.decide({ when: ASAP, updates: [pdf, desk], state: st, running: new Set(['desk']), now: 0 });
  assert.deepEqual(d.install.map((u) => u.id), ['pdf']);
  assert.equal(d.waiting.desk, 'running');
  d = A.decide({ when: ASAP, updates: [pdf], state: st, running: null, now: 0 });
  assert.deepEqual(d.install, []); assert.equal(d.waiting.pdf, 'running');
  // not downloaded yet
  d = A.decide({ when: ASAP, updates: [U('payroll', '2.0.0', '2.1.0')], state: st, running: new Set(), now: 0 });
  assert.equal(d.waiting.payroll, 'downloading');
});

test('decide: busy signals hold a program back (open till, unsent website news)', () => {
  const pos = U('pos', '1.0.0', '1.1.0'); const inv = U('invoices', '1.0.0', '1.1.0'); const pdf = U('pdf', '0.25.0', '0.26.0');
  const busy = A.busyFrom({ company: { tillOpen: true, unsent: 2 } });
  assert.equal(busy.pos, 'till-open'); assert.equal(busy.invoices, 'unsent'); assert.equal(busy.accounting, 'unsent'); assert.equal(busy.pdf, undefined);
  const d = A.decide({ when: ASAP, updates: [pos, inv, pdf], state: cached(pos, inv, pdf), running: new Set(), busy, now: 0 });
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
  let d = A.decide({ when: ASAP, updates: [lo, x], state: st, running: new Set(), idle: false, now });
  assert.deepEqual(d.elevate, []); assert.equal(d.waiting.linkoffice, 'idle');
  d = A.decide({ when: ASAP, updates: [lo, x], state: st, running: new Set(['pdf']), idle: true, now });
  assert.deepEqual(d.elevate, [], 'another Riyeser program open: not now');
  d = A.decide({ when: ASAP, updates: [lo, x], state: st, running: new Set(), idle: true, now });
  assert.deepEqual(d.elevate.map((u) => u.id), ['linkoffice', 'other'], 'both in one prompt');
  d = A.decide({ when: ASAP, updates: [lo, x], state: { ...st, lastPrompt: now - 5 * HOUR }, running: new Set(), idle: true, now });
  assert.deepEqual(d.elevate, []); assert.equal(d.waiting.other, 'prompt-today');
  d = A.decide({ when: ASAP, updates: [lo], state: { ...st, lastPrompt: now - 25 * HOUR }, running: new Set(), idle: true, now });
  assert.equal(d.elevate.length, 1, 'a day later: asked again');
});

test('decide: Central goes last, only while idle with no Riyeser program open; otherwise the next start', () => {
  const me = U('central', '1.9.1', '1.9.3'); const pdf = U('pdf', '0.25.0', '0.26.0');
  const st = cached(me, pdf);
  let d = A.decide({ when: ASAP, updates: [me, pdf], state: st, running: new Set(), idle: true, now: 0 });
  assert.equal(d.self, null); assert.equal(d.waiting.central, 'after-others'); assert.equal(d.install[0].id, 'pdf');
  d = A.decide({ when: ASAP, updates: [me], state: st, running: new Set(), idle: false, now: 0 });
  assert.equal(d.waiting.central, 'next-start');
  d = A.decide({ when: ASAP, updates: [me], state: st, running: new Set(['payroll']), idle: true, now: 0 });
  assert.equal(d.waiting.central, 'next-start');
  d = A.decide({ when: ASAP, updates: [me], state: st, running: new Set(), idle: true, now: 0 });
  assert.equal(d.self.id, 'central');
  d = A.decide({ when: ASAP, updates: [me], state: st, running: new Set(), idle: true, busy: { central: 'unsent' }, now: 0 });
  assert.equal(d.self, null); assert.equal(d.waiting.central, 'unsent');
});

test('decide: "Only when I approve", or demo mode, installs nothing by itself', () => {
  const pdf = U('pdf', '0.25.0', '0.26.0'); const night = new Date(2026, 10, 30, 23, 0).getTime();
  assert.deepEqual(A.decide({ when: { mode: 'approve' }, updates: [pdf], state: cached(pdf), running: new Set(), now: night }).waiting, { pdf: 'approval' });
  assert.deepEqual(A.decide({ when: ASAP, updates: [pdf], state: cached(pdf), running: new Set(), demo: true }).waiting, { pdf: 'demo' });
  assert.equal(A.modeOf({}), 'outside', 'outside work hours by default');
  assert.equal(A.modeOf({ autoUpdate: false }), 'approve', 'an earlier "off" means only when approved');
  assert.equal(A.modeOf({ updateWhen: 'asap' }), 'asap');
});

/** A scheduler with stand-ins for Windows: a temp cache folder and a fake release. */
function rig(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riy-auto-'));
  const store = memStore(); let now = over.start || 100 * DAY; delete over.start;
  const t = { updates: [U('pdf', '0.25.0', '0.26.0')], open: new Set(), busy: {}, idle: false, when: ASAP, demo: false, allowed: true, manual: false,
    installs: [], batches: [], selfRuns: [], logs: [], downloads: 0, reported: 0, verifyOk: true, installResult: () => ({ ok: true }), batchResult: (list) => Object.fromEntries(list.map(({ u }) => [u.id, { ok: true }])) };
  Object.assign(t, over);
  const au = A.createAutoUpdater({
    store, now: () => now, when: () => t.when, isDemo: () => t.demo, allowed: () => t.allowed, manualBusy: () => t.manual, cacheDir: dir,
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

test('Central\'s update at start: never in demo mode, while waiting for approval, with unsent online marks, or after two tries', async () => {
  const me = U('central', '1.9.1', '1.9.3');
  const { au, t } = rig({ updates: [me] });
  await au.check();
  t.demo = true; assert.equal(au.atStart({ appVersion: '1.9.1', newer }), null);
  t.demo = false; t.when = { mode: 'approve' }; assert.equal(au.atStart({ appVersion: '1.9.1', newer }), null);
  t.when = ASAP; assert.equal(au.atStart({ appVersion: '1.9.1', newer, busy: { central: 'unsent' } }), null);
  t.allowed = false; assert.equal(au.atStart({ appVersion: '1.9.1', newer }), null, 'a developer copy never updates itself');
  t.allowed = true;
  assert.ok(au.atStart({ appVersion: '1.9.1', newer }), 'first try');
  // it didn't take (still 1.9.1): counted as a failure, and the next try waits an hour, not straight away
  assert.equal(au.atStart({ appVersion: '1.9.1', newer }), null);
  assert.equal(au.state().items.central.fails, 1);
});

test('"Only when I approve": downloads in the background, installs nothing until approved', async () => {
  const { au, t } = rig({ when: { mode: 'approve' } });
  await au.check();
  assert.equal(t.downloads, 1, 'downloading is fine any time'); assert.equal(t.installs.length, 0);
  assert.equal(au.summary().ready.length, 1);
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

// ---------- when updates may install: work hours, approval, "As soon as possible", the week reminder ----------
// Local times on this PC (Monday 30 November 2026 is a Monday).
const at = (day, h, m = 0) => new Date(2026, 10, 30 + day, h, m).getTime();   // day 0 = Mon … 5 = Sat, 6 = Sun
const OUTSIDE = { mode: 'outside' };

test('work hours: Mon–Fri 8:00–18:00 by default, in the PC\'s local time', () => {
  assert.equal(A.inWorkHours(at(0, 10), {}), true);
  assert.equal(A.inWorkHours(at(0, 7, 59), {}), false);
  assert.equal(A.inWorkHours(at(0, 8), {}), true);
  assert.equal(A.inWorkHours(at(0, 18), {}), false, '18:00 is after work');
  assert.equal(A.inWorkHours(at(4, 17, 59), {}), true, 'Friday');
  assert.equal(A.inWorkHours(at(5, 10), {}), false, 'Saturday');
  assert.equal(A.inWorkHours(at(6, 10), {}), false, 'Sunday');
  assert.equal(A.inWorkHours(at(5, 10), { days: [1, 2, 3, 4, 5, 6] }), true, 'Saturday ticked as a work day');
  assert.deepEqual(A.workHours({ days: [9, 'x', 1], start: '25:00', end: '17:30' }), { days: [1], start: '08:00', end: '17:30' });
});

test('work hours across midnight belong to the day they start on (a Friday night shift runs into Saturday)', () => {
  const night = { days: [5], start: '22:00', end: '06:00' };
  assert.equal(A.inWorkHours(at(4, 23), night), true, 'Friday 23:00');
  assert.equal(A.inWorkHours(at(5, 5, 59), night), true, 'Saturday 05:59, still Friday\'s shift');
  assert.equal(A.inWorkHours(at(5, 6), night), false, 'Saturday 06:00');
  assert.equal(A.inWorkHours(at(5, 23), night), false, 'Saturday night is not a work night');
  assert.equal(A.inWorkHours(at(4, 5), night), false, 'Friday 05:00: Thursday has no shift');
  assert.equal(A.inWorkHours(at(3, 12), night), false);
  assert.equal(A.inWorkHours(at(2, 3), { days: [3], start: '00:00', end: '00:00' }), true, 'start = end: the whole Wednesday');
});

test('work hours follow the time zone: the same moment is work time in Fiji and evening in London', () => {
  const t = Date.UTC(2026, 10, 30, 21, 0);   // Monday 21:00 UTC
  assert.deepEqual(A.localParts(t, 'Pacific/Fiji'), { day: 2, minutes: 9 * 60 });          // Tuesday 09:00
  assert.deepEqual(A.localParts(t, 'Europe/London'), { day: 1, minutes: 21 * 60 });         // Monday 21:00
  assert.deepEqual(A.localParts(t, 'America/New_York'), { day: 1, minutes: 16 * 60 });      // Monday 16:00
  assert.equal(A.inWorkHours(t, {}, 'Pacific/Fiji'), true);
  assert.equal(A.inWorkHours(t, {}, 'Europe/London'), false);
  assert.equal(A.inWorkHours(t, {}, 'America/New_York'), true);
  // Saturday morning in Sydney is still Friday evening in UTC
  assert.equal(A.inWorkHours(Date.UTC(2026, 11, 4, 23, 0), {}, 'Australia/Sydney'), false);
});

test('outside work hours (the default): nothing installs during work, everything goes in after work', async () => {
  const { au, t, advance } = rig({ when: OUTSIDE, start: at(0, 10), updates: [U('pdf', '0.25.0', '0.26.0'), U('central', '1.9.1', '1.9.3')], idle: true });
  const r = await au.check();
  assert.equal(t.downloads, 2, 'downloads during work are fine');
  assert.deepEqual(r.installed, []); assert.equal(t.installs.length, 0); assert.equal(t.selfRuns.length, 0);
  assert.equal(r.waiting.pdf, 'work-hours'); assert.equal(au.summary().waiting.pdf, A.WAITING['work-hours']);
  assert.equal(au.summary().inWork, true); assert.equal(au.summary().ready.length, 2);
  advance(8 * HOUR + 30 * 60 * 1000);   // 18:30
  assert.deepEqual((await au.tick()).installed, ['pdf']);
  assert.deepEqual((await au.tick()).installed, ['central'], 'then Central, last');
});

test('the Windows permission prompt never appears during work hours, even when the PC is idle', async () => {
  const lo = U('linkoffice', '1.2.0', '1.3.0', { elevate: true });
  const { au, t, advance } = rig({ when: OUTSIDE, start: at(1, 11), updates: [lo], idle: true });
  await au.check();
  assert.deepEqual(t.batches, []); assert.equal(au.summary().waiting.linkoffice, A.WAITING['work-hours']);
  advance(9 * HOUR);   // 20:00
  await au.tick();
  assert.deepEqual(t.batches, [['linkoffice']]);
});

test('Central doesn\'t update itself at a start during work hours; it waits for a start after work', async () => {
  const { au, advance } = rig({ when: OUTSIDE, start: at(2, 9), updates: [U('central', '1.9.1', '1.9.3')] });
  await au.check();
  assert.equal(au.atStart({ appVersion: '1.9.1', newer }), null, 'a 9 am start opens straight away');
  advance(11 * HOUR);   // 20:00
  assert.ok(au.atStart({ appVersion: '1.9.1', newer }), 'an evening start installs it first');
});

test('"Install now": the approval installs during work hours, open programs once they close, and is in the history', async () => {
  const lo = U('linkoffice', '1.2.0', '1.3.0', { elevate: true });
  const { au, t, store } = rig({ when: OUTSIDE, start: at(0, 10), updates: [U('pdf', '0.25.0', '0.26.0'), U('payroll', '2.4.0', '2.4.1'), lo], open: new Set(['payroll']), idle: false });
  await au.check();
  assert.equal(t.installs.length, 0);
  const r = await au.approve({ by: 'sam@coastal.example' });
  assert.deepEqual(r.installed, ['pdf'], 'closed programs now');
  assert.equal(r.waiting.payroll, 'running', 'Payroll is open: it waits, never closed for you');
  assert.equal(r.waiting.linkoffice, 'idle', 'the permission prompt waits until no Riyeser program is open');
  const h = store.get(A.STATE).history;
  const ap = h.find((x) => x.kind === 'approval');
  assert.equal(ap.by, 'sam@coastal.example'); assert.ok(ap.at); assert.deepEqual(ap.ids.sort(), ['linkoffice', 'payroll', 'pdf']);
  assert.equal(h.find((x) => x.id === 'pdf').approvedBy, 'sam@coastal.example');
  assert.equal(au.summary().ready.length, 0, 'the "updates ready" item goes once approved');
  t.open = new Set();
  assert.deepEqual((await au.tick()).installed, ['payroll', 'linkoffice'], 'closed later the same morning: installs, then the one prompt (no idle wait, no daily limit: approved)');
  assert.deepEqual(t.batches, [['linkoffice']]);
  const last = au.state().history.find((x) => x.id === 'payroll');
  assert.equal(L9.autoLine(last, 'Payroll', last.at + 60000), 'Updated Payroll to 2.4.1 · 1 min ago');
});

test('"Tonight": the item goes quiet and the updates wait for after work (in "Only when I approve" too)', async () => {
  const { au, t, advance } = rig({ when: { mode: 'approve' }, start: at(0, 10) });
  await au.check();
  assert.equal(au.summary().ready.length, 1);
  au.tonight({ by: 'sam@coastal.example' });
  assert.equal(au.summary().ready.length, 0);
  assert.equal(au.state().history[0].kind, 'tonight');
  await au.tick(); assert.equal(t.installs.length, 0, 'not during work');
  advance(10 * HOUR); await au.tick();
  assert.equal(t.installs.length, 1, 'that evening');
});

test('approval is for owners and admins only; staff see "Updates are waiting for an administrator"', () => {
  assert.equal(A.approverFrom({ adminState: { needed: false } }), 'the owner on this PC', 'a person on their own');
  assert.equal(A.approverFrom({ adminState: { needed: true, open: true, email: 'owner@x.example' } }), 'owner@x.example');
  assert.equal(A.approverFrom({ adminState: { needed: true, open: false }, role: 'admin', email: 'admin@x.example' }), 'admin@x.example');
  assert.equal(A.approverFrom({ adminState: { needed: true, open: false }, role: 'member', email: 'staff@x.example' }), null);
  assert.equal(A.approverFrom({ adminState: { needed: true, open: false }, role: null, email: '' }), null);
  assert.equal(A.approverFrom({ adminState: { needed: true, open: true, demo: true, email: 'd@x' } }), null, 'demo mode');
  const au = { mode: 'outside', hours: A.WORK_DEFAULT, ready: [{ id: 'pdf' }, { id: 'payroll' }], pending: [{ id: 'pdf' }, { id: 'payroll' }] };
  const owner = L9.attention({ autoUpd: au, canApprove: true })[0];
  assert.equal(owner.title, '2 updates ready');
  assert.deepEqual(owner.acts.map((a) => a.label), ['Install now', 'Tonight']);
  assert.match(owner.detail, /after work hours \(after 18:00\)/);
  const staff = L9.attention({ autoUpd: au, canApprove: false })[0];
  assert.equal(staff.title, 'Updates are waiting for an administrator'); assert.deepEqual(staff.acts, []);
  assert.deepEqual(L9.attention({ autoUpd: { ...au, ready: [] } }), [], 'nothing waiting: nothing to say');
});

test('"As soon as possible": installs during work hours as soon as each program is closed, no "ready" item', async () => {
  const { au, t } = rig({ when: { mode: 'asap' }, start: at(0, 10), open: new Set(['pdf']) });
  await au.check();
  assert.equal(t.installs.length, 0); assert.equal(au.summary().ready.length, 0);
  t.open = new Set();
  assert.deepEqual((await au.tick()).installed, ['pdf']);
});

test('a PC switched off every night for a week: "Updates have been waiting a week", with Install now', async () => {
  const { au, advance } = rig({ when: OUTSIDE, start: at(0, 9) });
  await au.check();
  for (let d = 1; d <= 6; d++) { advance(DAY); if (d <= 4) await au.tick(); }   // on at 9:00 Tue–Fri, off by evening and all weekend
  assert.equal(au.summary().week, false, '6 days: not yet');
  advance(DAY); await au.tick();   // the next Monday 9:00
  const s = au.summary();
  assert.equal(s.week, true);
  const item = L9.attention({ autoUpd: s, canApprove: true })[0];
  assert.equal(item.title, 'Updates have been waiting a week: install now or leave the PC on overnight');
  assert.deepEqual(item.acts.map((a) => a.label), ['Install now']);
  assert.deepEqual(L9.attention({ autoUpd: s, canApprove: false })[0].acts, [], 'staff: no button');
});

test('the week reminder stays away while the PC is on after work some nights', async () => {
  const { au, advance } = rig({ when: OUTSIDE, start: at(0, 9), open: new Set(['pdf']) });   // PDF left open: it can't install
  await au.check();
  advance(10 * HOUR); await au.tick();   // Monday 19:00: the PC was on after work
  advance(5 * DAY); await au.tick();
  assert.equal(au.summary().week, false);
});
