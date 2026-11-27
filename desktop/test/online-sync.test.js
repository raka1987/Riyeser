// Riyeser online connections: Central's sync loop against a pretend Riyeser Online (the post box RPCs, with the
// 10-minute claim lease) and a pretend Riyeser Accounting (its local API, over real HTTP on 127.0.0.1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const on = require('../src/core/online');
const { Store } = require('../src/core/store');
const { LocalApp, discoveryFile } = require('../src/central/local-app');
const { createSync, fixFor } = require('../src/central/online-sync');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'osync-'));
const MIN = 60000;

// ---------------------------------------------------------------- a pretend Riyeser Online
function fakeCloud(clock) {
  const items = []; const calls = []; const linked = new Set(); const notified = []; const published = { catalog: [], stock: [], availability: [] };
  let down = false; let kicks = 0;
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const err = (m) => res(400, { message: m });
  const mine = (it, device) => it && it.status === 'taken' && it.taken_by === device;
  const rpcs = {
    api_inbox_claim: ({ device, max_items }) => {
      const t = clock.now();
      const free = items.filter((it) => (it.status === 'waiting' && it.available_at <= t) || (it.status === 'taken' && it.lease_until <= t))
        .sort((a, b) => a.created - b.created).slice(0, max_items || 20);
      for (const it of free) Object.assign(it, { status: 'taken', taken_by: device, lease_until: t + 10 * MIN });
      return free.map(({ id, kind, test: tst, source, attempts, payload }) => ({ id, kind, test: tst, source, key_name: 'Shop', attempts, created_at: '2026-11-27T00:00:00Z', payload }));
    },
    api_inbox_done: ({ device, event_id, result }) => {
      const it = items.find((x) => x.id === event_id);
      if (!mine(it, device)) throw new Error('That item isn\'t taken by this PC.');
      Object.assign(it, { status: 'done', result }); return { id: it.id, status: 'done' };
    },
    api_inbox_fail: ({ device, event_id, reason, retry, result }) => {
      const it = items.find((x) => x.id === event_id);
      if (!mine(it, device)) throw new Error('That item isn\'t taken by this PC.');
      if (retry) { it.attempts += 1; Object.assign(it, it.attempts >= 5 ? { status: 'failed' } : { status: 'waiting', available_at: clock.now() + 2 ** (it.attempts - 1) * MIN }); }
      else Object.assign(it, { status: 'rejected', result });
      it.reason = reason; return { id: it.id, status: it.status, attempts: it.attempts };
    },
    api_inbox_counts: () => ({ waiting: items.filter((x) => x.status === 'waiting').length, taken: items.filter((x) => x.status === 'taken').length, failed: items.filter((x) => x.status === 'failed').length, test_waiting: 0 }),
    api_notify: (a) => { notified.push(a); return { queued: 1 }; },
    api_publish_catalog: (a) => { published.catalog.push(a); return { saved: a.items.length, removed: 0, skipped: [] }; },
    api_publish_stock: (a) => { published.stock.push(a); return { saved: a.levels.length, removed: 0, skipped: [], changed: 0 }; },
    api_publish_availability: (a) => { published.availability.push(a); return { open_times_saved: (a.open_times || []).length }; },
  };
  const fetchFn = async (url, opts = {}) => {
    if (down) throw new TypeError('fetch failed');
    const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.href.startsWith(on.CONFIG_URL)) return res(200, 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.co",supabaseKey:"anon"};');
    calls.push([u.pathname, body]);
    if (u.pathname === '/functions/v1/api/internal/kick') { kicks += 1; return res(200, { sent: 1, failed: 0 }); }
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(u.pathname);
    if (m && rpcs[m[1]]) {
      if (m[1].startsWith('api_') && !linked.has(body.device)) return err('Link this PC to the business first (Riyeser Central).');
      try { return res(200, rpcs[m[1]](body)); } catch (e) { return err(e.message); }
    }
    return res(404, { message: 'not found' });
  };
  return { items, calls, fetchFn, linked, notified, published, kicks: () => kicks, setDown: (v) => { down = v; },
    add: (kind, payload, extra = {}) => { const it = { id: `ev-${items.length + 1}`, kind, payload, test: false, source: 'api', status: 'waiting', attempts: 0, available_at: 0, created: items.length, ...extra }; items.push(it); return it; },
    rpcCalls: (name) => calls.filter(([p]) => p === `/rest/v1/rpc/${name}`) };
}

// ---------------------------------------------------------------- a pretend Riyeser Accounting (its local API)
function fakeProgram(dir, { tokenValue = 'tok-123' } = {}) {
  const applied = new Map(); const imports = []; const outbox = []; const reports = [];
  const data = { catalog: { items: [{ sku: 'MUG-1', name: 'Mug', price: 11 }], skipped: [] }, stock: { levels: [{ sku: 'MUG-1', quantity: 10 }], enabled: true },
    availability: { settings: { timezone: 'Pacific/Fiji', slot_minutes: 15, min_notice_minutes: 60, days_ahead: 30 }, staff: [{ ref: 'S1', name: 'Ana', services: [], active: true }],
      open_times: [{ staff_ref: 'S1', start: '2026-12-01T21:00:00.000Z', end: '2026-12-02T05:00:00.000Z', capacity: 1 }], from_at: '2026-12-01T12:00:00.000Z', to_at: '2026-12-31T12:00:00.000Z', enabled: true } };
  let flaky = 0; let failImport = false;
  const file = (it) => {
    if (applied.has(it.id)) return { ...applied.get(it.id), replay: true };
    if (it.payload.flaky && flaky++ < 1) return { id: it.id, outcome: 'retry', reason: 'database is locked', result: null };
    const r = it.payload.conflict
      ? { id: it.id, outcome: 'rejected', kind: it.kind, reason: 'Clashes with another booking.', result: { state: 'slot_taken', message: 'Sorry, that time has just been taken.' } }
      : { id: it.id, outcome: 'done', kind: it.kind, customer: (it.payload.customer || {}).name || '', order_request: !!(it.payload.metadata || {}).order_sku, result: { reference: `${it.kind === 'booking' ? 'BK' : 'INV'}-${applied.size + 1}`, state: it.kind === 'booking' ? 'pending' : 'accepted', message: 'Thanks' } };
    applied.set(it.id, r); return r;
  };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers['x-riyeser-token'] !== tokenValue) return send(401, { error: 'bad_token' });
      const body = raw ? JSON.parse(raw) : null; const p = req.url.replace('/online/api/', '');
      if (p === 'status') return send(200, { ok: true, company: 'Online Co' });
      if (p === 'import') { if (failImport) { req.socket.destroy(); return null; } imports.push(body.items.map((i) => i.id)); return send(200, { results: body.items.map(file) }); }
      if (p in data) return send(200, data[p]);
      if (p === 'outbox') return send(200, { events: outbox.filter((e) => !e.sent) });
      if (p === 'outbox/done') { for (const id of body.sent) outbox.find((e) => e.id === id).sent = true; return send(200, { ok: true }); }
      if (p === 'sync-report') { reports.push(body); return send(200, { ok: true }); }
      return send(404, { error: 'not_found' });
    });
  });
  const dbPath = path.join(dir, 'company.db');
  fs.writeFileSync(dbPath, 'pretend books');
  const listen = () => new Promise((r) => server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(discoveryFile(dbPath), JSON.stringify({ port: server.address().port, token: tokenValue, pid: process.pid }));
    r();
  }));
  return { server, listen, close: () => new Promise((r) => server.close(r)), applied, imports, outbox, reports, data, dbPath,
    setFailImport: (v) => { failImport = v; } };
}

function pc({ cloud, prog, clock, name = 'Front desk', mode = null, companyFile = true, demo = false }) {
  const dir = tmp(); const store = new Store(path.join(dir, 'data'));
  on.writeCompany(dir, { mode: 'online', workspace_id: 'ws-1', name: 'Online Co' });
  store.set('online', { session: { access_token: 'at', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 * 24, user: { id: 'u1', email: 'o@x.co' } } });
  const online = new on.Online({ store, fetchFn: cloud.fetchFn, appData: dir });
  cloud.linked.add(online.deviceId());
  const dbPath = companyFile ? prog.dbPath : path.join(dir, 'no-books', 'company.db');
  if (!companyFile) { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); fs.copyFileSync(discoveryFile(prog.dbPath), discoveryFile(dbPath)); }
  const local = new LocalApp({ dbPath });
  const notes = [];
  const sync = createSync({ online, local, store, appData: dir, readCompany: on.readCompany, isDemo: () => demo, notify: (n) => notes.push(n), now: clock.now, pcName: name,
    timers: { setTimeout: () => null, clearTimeout: () => {} } });
  if (mode) sync.setMode(mode);
  return { dir, store, online, local, sync, notes, device: online.deviceId() };
}

const clockAt = (t = Date.UTC(2026, 10, 27, 1, 0)) => { const c = { t, now: () => c.t, add: (ms) => { c.t += ms; } }; return c; };

async function setup(opts = {}) {
  const clock = clockAt(); const cloud = fakeCloud(clock); const prog = fakeProgram(tmp(), opts); await prog.listen();
  return { clock, cloud, prog };
}

// ---------------------------------------------------------------- tests
test('online sync: files a batch, marks done / turned down / try again, kicks webhooks and notifies', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  cloud.add('booking', { customer: { name: 'Mere' } });
  cloud.add('order', { customer: { name: 'Kim' } });
  cloud.add('booking', { conflict: true, customer: { name: 'Late' } });
  cloud.add('enquiry', { flaky: true, customer: { name: 'Asks' } });
  cloud.add('order', { customer: { name: 'Tester' } }, { test: true });
  cloud.add('enquiry', { customer: { name: 'Cake fan' }, metadata: { order_sku: 'CAKE-CHOC', order_quantity: 2 } }, { source: 'widget' });
  const a = pc({ cloud, prog, clock });
  const st = await a.sync.tick();
  assert.equal(st.state, 'ok', st.message);
  assert.deepEqual(cloud.items.map((i) => i.status), ['done', 'done', 'rejected', 'waiting', 'done', 'done']);
  assert.equal(cloud.items[0].result.reference, 'BK-1');
  assert.equal(cloud.items[2].result.state, 'slot_taken');
  assert.equal(cloud.items[3].attempts, 1); assert.equal(cloud.items[3].available_at, clock.now() + MIN);   // back in 1 minute
  assert.equal(cloud.kicks(), 1);
  assert.deepEqual(a.notes.map((n) => n.title), ['New online booking', 'New online order', 'New order request']);   // not the test order
  assert.equal(st.receivedToday, 4);   // the test one doesn't count
  assert.equal(st.recent[0].kind, 'order_request');
  assert.equal(prog.reports.at(-1).ok, true); assert.equal(prog.reports.at(-1).pc, 'Front desk');
  // a minute later the enquiry is tried again and filed
  clock.add(MIN + 1000);
  await a.sync.tick();
  assert.equal(cloud.items[3].status, 'done');
  assert.equal(prog.applied.size, 6);   // the pretend program counts the test one too (the real one keeps it apart)
});

test('online sync: two PCs never file the same item twice (claim lease + filing once by id)', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  for (let i = 0; i < 45; i++) cloud.add('booking', { customer: { name: `C${i}` } });
  const a = pc({ cloud, prog, clock, name: 'A', mode: 'on' }); const b = pc({ cloud, prog, clock, name: 'B', mode: 'on' });
  await Promise.all([a.sync.tick(), b.sync.tick()]);
  assert.ok(cloud.items.every((i) => i.status === 'done'));
  const all = prog.imports.flat();
  assert.equal(all.length, 45); assert.equal(new Set(all).size, 45);   // nobody was handed an item twice
  // A files one, then loses its connection before marking it; its lease runs out and B gets the same item again
  const x = cloud.add('order', { customer: { name: 'Edge' } });
  const realRpc = a.online.rpc.bind(a.online);
  a.online.rpc = async (name, args) => { if (name === 'api_inbox_done') { cloud.setDown(true); } return realRpc(name, args); };
  const st = await a.sync.tick();
  cloud.setDown(false); a.online.rpc = realRpc;
  assert.equal(st.state, 'offline'); assert.equal(st.pendingMarks, 1); assert.equal(x.status, 'taken');
  clock.add(11 * MIN);
  await b.sync.tick();
  assert.equal(x.status, 'done'); assert.equal(x.taken_by, b.device);
  assert.equal([...prog.applied.keys()].filter((k) => k === x.id).length, 1);
  assert.equal(prog.imports.flat().filter((k) => k === x.id).length, 2);   // handed over twice, filed once (replay)
  // A comes back: its old mark is refused (B has it) and dropped, nothing breaks
  clock.add(MIN);
  const back = await a.sync.tick({ force: true });
  assert.equal(back.state, 'ok'); assert.equal(back.pendingMarks, 0);
});

test('online sync: only one sync PC per business, demo mode and Off pause it', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  cloud.add('booking', { customer: { name: 'Mere' } });
  const other = pc({ cloud, prog, clock, name: 'Laptop', companyFile: false });   // Automatic, no company file here
  let st = await other.sync.tick();
  assert.equal(st.syncing, false); assert.match(st.message, /Another PC/); assert.equal(cloud.rpcCalls('api_inbox_claim').length, 0);
  assert.match(other.sync.setMode('on').state, /starting|idle|ok/);
  const demo = pc({ cloud, prog, clock, demo: true });
  st = await demo.sync.tick();
  assert.equal(st.state, 'paused'); assert.match(st.message, /Demo mode/);
  const off = pc({ cloud, prog, clock, mode: 'off' });
  assert.equal((await off.sync.tick()).state, 'off');
  assert.equal(cloud.rpcCalls('api_inbox_claim').length, 0);
  const main = pc({ cloud, prog, clock });   // Automatic and it holds the company file
  st = await main.sync.tick();
  assert.equal(st.state, 'ok'); assert.equal(cloud.items[0].status, 'done');
  assert.throws(() => main.sync.setMode('sometimes'), /Automatic/);
});

test('online sync: offline backs off and resumes where it left off', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  const a = pc({ cloud, prog, clock });
  cloud.add('booking', { customer: { name: 'Mere' } });
  cloud.setDown(true);
  let st = await a.sync.tick();
  assert.equal(st.state, 'offline'); assert.match(st.message, /wait in your online post box/); assert.equal(st.failures, 1);
  const n = cloud.calls.length;
  clock.add(10 * 1000);
  await a.sync.tick();   // still waiting (30 s): nothing tried
  assert.equal(cloud.calls.length, n); assert.equal(a.sync.status().failures, 1);
  clock.add(25 * 1000);
  st = await a.sync.tick();
  assert.equal(st.failures, 2);                                  // then 60 s, 120 s ... up to 15 minutes
  assert.equal(a.store.get('online-sync').backoffUntil, clock.now() + 60 * 1000);
  cloud.setDown(false);
  clock.add(61 * 1000);
  st = await a.sync.tick();
  assert.equal(st.state, 'ok'); assert.equal(st.failures, 0); assert.equal(cloud.items[0].status, 'done');
  // the program closed and none is installed to start: items stay in the post box, with a plain fix
  cloud.add('order', { customer: { name: 'Kim' } });
  await prog.close();
  st = await a.sync.tick({ force: true });
  assert.equal(st.state, 'error'); assert.match(st.fix, /Install Riyeser Accounting/);
  assert.equal(cloud.items[1].status, 'waiting');
});

test('online sync: the program going away mid-batch puts items back to try again', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  const a = pc({ cloud, prog, clock });
  cloud.add('order', { customer: { name: 'Kim' } });
  prog.setFailImport(true);
  const st = await a.sync.tick();
  assert.equal(st.state, 'error');
  assert.equal(cloud.items[0].status, 'waiting'); assert.match(cloud.items[0].reason, /couldn't file it just now/);
  prog.setFailImport(false);
  clock.add(2 * MIN);
  await a.sync.tick({ force: true });
  assert.equal(cloud.items[0].status, 'done');
});

test('online sync: publishes catalogue, stock and free times when they change, and on schedule', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  const a = pc({ cloud, prog, clock });
  await a.sync.tick();
  assert.equal(cloud.published.catalog.length, 1); assert.equal(cloud.published.stock.length, 1); assert.equal(cloud.published.availability.length, 1);
  assert.equal(cloud.published.catalog[0].full_sync, true);
  assert.deepEqual(cloud.published.availability[0].open_times, prog.data.availability.open_times);
  assert.equal(cloud.published.availability[0].settings.timezone, 'Pacific/Fiji');
  clock.add(MIN); await a.sync.tick();
  assert.deepEqual([cloud.published.catalog.length, cloud.published.stock.length, cloud.published.availability.length], [1, 1, 1]);   // nothing changed
  prog.data.stock.levels[0].quantity = 9;   // a sale
  clock.add(MIN); await a.sync.tick();
  assert.deepEqual([cloud.published.catalog.length, cloud.published.stock.length, cloud.published.availability.length], [1, 2, 1]);
  assert.equal(cloud.published.stock[1].levels[0].quantity, 9);
  clock.add(61 * MIN); await a.sync.tick();   // free times at least hourly
  assert.deepEqual([cloud.published.catalog.length, cloud.published.stock.length, cloud.published.availability.length], [1, 2, 2]);
  prog.data.availability.enabled = false;   // no online bookings any more: the published times are cleared
  clock.add(MIN); await a.sync.tick();
  assert.deepEqual(cloud.published.availability.at(-1).open_times, []);
  assert.ok(a.sync.status().lastPublishAt);
});

test('online sync: news for websites goes out with api_notify, then a kick', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  const a = pc({ cloud, prog, clock });
  await a.sync.tick();
  assert.equal(cloud.kicks(), 0);   // nothing filed or sent: no kick
  prog.outbox.push({ id: 1, event: 'booking.confirmed', event_id: 'ev-9', data: { reference: 'BK-9', state: 'confirmed' } });
  prog.outbox.push({ id: 2, event: 'order.ready', event_id: null, data: { reference: 'INV-2' } });
  clock.add(MIN); await a.sync.tick();
  assert.deepEqual(cloud.notified.map((n) => [n.event, n.event_id]), [['booking.confirmed', 'ev-9'], ['order.ready', null]]);
  assert.ok(prog.outbox.every((e) => e.sent)); assert.equal(cloud.kicks(), 1);
  const kick = cloud.calls.find(([p]) => p === '/functions/v1/api/internal/kick');
  assert.deepEqual(kick[1], { ws: 'ws-1', device: a.device });
});

test('online sync: an unlinked PC or signed-out account says how to fix it', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  const a = pc({ cloud, prog, clock });
  cloud.linked.delete(a.device);
  let st = await a.sync.tick();
  assert.equal(st.state, 'error'); assert.match(st.message, /Link this PC/); assert.match(st.fix, /Company page/);
  a.online.setSession(null);
  st = await a.sync.tick({ force: true });
  assert.equal(st.syncing, false); assert.match(st.fix, /Sign in/);
  assert.match(fixFor({ code: 'NO_PROGRAM', message: '' }), /Install/);
});

test('local app: starts the program quietly when it isn\'t running, and closes only its own copy', async (t) => {
  const dir = tmp(); const prog = fakeProgram(dir); t.after(prog.close);
  fs.rmSync(discoveryFile(prog.dbPath), { force: true });
  const spawned = [];
  const child = { exitCode: null, killed: false, on: () => {}, kill() { this.killed = true; } };
  const local = new LocalApp({ dbPath: prog.dbPath, findExe: (id) => (id === 'bookings' ? '/apps/Riyeser Bookings.exe' : null), pollMs: 5,
    spawnFn: (exe, args) => { spawned.push([exe, args]); prog.listen(); return child; } });
  assert.equal(local.program().id, 'bookings');
  const st = await local.ensure();
  assert.equal(st.company, 'Online Co'); assert.deepEqual(spawned, [['/apps/Riyeser Bookings.exe', ['--no-window']]]);
  await local.ensure(); assert.equal(spawned.length, 1);   // running now: not started again
  local.stop(); assert.equal(child.killed, true);
  const none = new LocalApp({ dbPath: path.join(tmp(), 'company.db'), findExe: () => null, spawnFn: () => child });
  await assert.rejects(none.ensure(), (e) => e.code === 'NO_PROGRAM');
  const wrong = new LocalApp({ dbPath: prog.dbPath, findExe: () => '/apps/x.exe' });   // no way to start it here
  fs.writeFileSync(discoveryFile(prog.dbPath), JSON.stringify({ port: prog.server.address().port, token: 'stale', pid: 1 }));
  await assert.rejects(wrong.ensure(), (e) => e.code === 'NOT_RUNNING');   // an old token: treated as not running
});
