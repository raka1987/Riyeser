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
    // where things stand (api_status) and "Send a test": only once cloud.withStatus() (an older database has neither)
    api_status: ({ device }) => {
      if (!cfg.status) throw Object.assign(new Error('missing'), { missing: true });
      const live = items.filter((i) => !i.test);
      return { set_up: cfg.keys > 0 || live.length > 0, keys: { active: cfg.keys, widget: 0, test: 0 }, webhooks: { active: 0, failing: 0 },
        requests_24h: cfg.requests, last_request_at: cfg.requests ? '2026-11-27T00:30:00Z' : null,
        inbox: { waiting: items.filter((x) => x.status === 'waiting').length, taken: items.filter((x) => x.status === 'taken').length, failed: 0, test_waiting: 0, done_total: live.filter((x) => x.status === 'done').length },
        published: { catalog_items: published.catalog.length ? 1 : 0, catalog_at: published.catalog.length ? '2026-11-27T01:00:00Z' : null, stock_at: null, availability_at: null },
        sync_pc: cfg.syncPc ? { name: cfg.syncPc, this_pc: false } : (items.some((x) => x.taken_by) ? { name: 'Front desk', this_pc: items.some((x) => x.taken_by === device) } : null),
        allowed: { any: true, bookings: true, orders: true }, checked_at: '2026-11-27T01:00:00Z' };
    },
    api_send_test: ({ kind }) => {
      if (!cfg.status) throw Object.assign(new Error('missing'), { missing: true });
      if (kind === 'booking' && !cfg.service) throw new Error('There\'s no service published yet. Add a service in Riyeser Bookings (Riyeser Central publishes it within a minute), or send a test enquiry.');
      const it = add(kind === 'order' ? 'enquiry' : kind, kind === 'booking' ? { service: 'CUT', start: '2026-11-28T01:00:00.000Z', customer: { name: 'Test Customer (from Riyeser)' } }
        : { customer: { name: 'Test Customer (from Riyeser)' }, message: 'A test', ...(kind === 'order' ? { metadata: { order_sku: 'TEST-ITEM' } } : {}) }, { test: true, source: 'test' });
      return { id: it.id, kind: it.kind, status: 'waiting', test: true };
    },
    api_event_status: ({ event_id }) => { const it = items.find((x) => x.id === event_id); return { id: it.id, status: it.status, result: it.result || null, taken_by_pc: it.taken_by ? 'Front desk' : null }; },
  };
  const cfg = { status: false, keys: 0, requests: 0, syncPc: '', service: true };
  function add(kind, payload, extra = {}) { const it = { id: `ev-${items.length + 1}`, kind, payload, test: false, source: 'api', status: 'waiting', attempts: 0, available_at: 0, created: items.length, ...extra }; items.push(it); return it; }
  const fetchFn = async (url, opts = {}) => {
    if (down) throw new TypeError('fetch failed');
    const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.href.startsWith(on.CONFIG_URL)) return res(200, 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.co",supabaseKey:"anon"};');
    calls.push([u.pathname, body]);
    if (u.pathname === '/functions/v1/api/internal/kick') { kicks += 1; return res(200, { sent: 1, failed: 0 }); }
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(u.pathname);
    if (m && rpcs[m[1]]) {
      if (m[1].startsWith('api_') && !linked.has(body.device)) return err('Link this PC to the business first (Riyeser Central).');
      try { return res(200, rpcs[m[1]](body)); } catch (e) { return e.missing ? res(404, { code: 'PGRST202', message: 'Could not find the function public.' + m[1] + ' in the schema cache' }) : err(e.message); }
    }
    return res(404, { message: 'not found' });
  };
  return { items, calls, fetchFn, linked, notified, published, kicks: () => kicks, setDown: (v) => { down = v; },
    add, cfg, withStatus: (o = {}) => Object.assign(cfg, { status: true }, o),
    rpcCalls: (name) => calls.filter(([p]) => p === `/rest/v1/rpc/${name}`) };
}

// ---------------------------------------------------------------- a pretend Riyeser Accounting (its local API)
function fakeProgram(dir, { tokenValue = 'tok-123' } = {}) {
  const applied = new Map(); const imports = []; const outbox = []; const reports = [];
  const data = { catalog: { items: [{ sku: 'MUG-1', name: 'Mug', price: 11 }], skipped: [] }, stock: { levels: [{ sku: 'MUG-1', quantity: 10 }], enabled: true },
    availability: { settings: { timezone: 'Pacific/Fiji', slot_minutes: 15, min_notice_minutes: 60, days_ahead: 30 }, staff: [{ ref: 'S1', name: 'Ana', services: [], active: true }],
      open_times: [{ staff_ref: 'S1', start: '2026-12-01T21:00:00.000Z', end: '2026-12-02T05:00:00.000Z', capacity: 1 }], from_at: '2026-12-01T12:00:00.000Z', to_at: '2026-12-31T12:00:00.000Z', enabled: true } };
  let flaky = 0; let failImport = false; const broken = {}; let testRequest = null;
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
      if (p === 'status') return send(200, { ok: true, company: 'Online Co', test_request: testRequest });
      if (broken[p] === 'html') { res.writeHead(500, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><h1>Sorry, something went wrong</h1>'); }
      if (broken[p]) return send(500, { error: 'internal', message: broken[p], ref: 'OA-1A2B3C', program: 'Riyeser POS', detail: 'ZoneInfoNotFoundError' });
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
    setFailImport: (v) => { failImport = v; }, broken, askTest: (r) => { testRequest = r; } };
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

// ---------------------------------------------------------------- what the panel says, the guide's test, the trail
test('online sync: nothing connected says "not set up" and stays quiet (no program started, nothing published, no error)', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  cloud.withStatus({ keys: 0 });
  const a = pc({ cloud, prog, clock });
  let spawned = 0; a.local.spawnFn = () => { spawned += 1; return null; };
  await prog.close();   // the program isn't even open
  let st = await a.sync.tick();
  assert.equal(st.view, 'not_setup'); assert.equal(st.message, ''); assert.equal(st.failures, 0);
  assert.equal(spawned, 0);
  assert.equal(cloud.rpcCalls('api_inbox_claim').length, 0);
  assert.equal(cloud.published.catalog.length + cloud.published.stock.length + cloud.published.availability.length, 0);
  assert.deepEqual(st.checklist.map((c) => c.done), [false, false, false, false, false]);
  clock.add(MIN); st = await a.sync.tick();
  assert.equal(st.view, 'not_setup');
  const lines = a.sync.trail().rows;
  assert.equal(lines.filter((r) => /aren't set up/.test(r.what)).length, 1);   // said once, not every minute
  // a key is made in Riyeser Link: from the next minute it's "connected, nothing new" (and it publishes)
  await prog.listen();
  cloud.cfg.keys = 1; cloud.cfg.requests = 0;
  clock.add(MIN); st = await a.sync.tick();
  assert.equal(st.view, 'waiting', st.message); assert.equal(cloud.published.catalog.length, 1);
  assert.ok(a.sync.trail().rows.some((r) => r.type === 'setup' && r.what === 'Online connections set up'));
  assert.equal(prog.reports.at(-1).state, 'waiting'); assert.equal(prog.reports.at(-1).cloud.keys_active, 1);
  // something comes in: "working"
  cloud.add('booking', { customer: { name: 'Mere' } });
  clock.add(MIN); st = await a.sync.tick();
  assert.equal(st.view, 'working'); assert.equal(st.receivedToday, 1);
  assert.ok(st.checklist.find((c) => c.id === 'item').done);
});

test('online sync: an item waiting in the post box is brought in even before any key exists (e.g. a test)', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  cloud.withStatus({ keys: 0 });
  cloud.add('enquiry', { customer: { name: 'Test' }, message: 'hi' }, { test: true, source: 'test' });
  const a = pc({ cloud, prog, clock });
  const st = await a.sync.tick();
  assert.equal(cloud.items[0].status, 'done'); assert.notEqual(st.view, 'not_setup');
});

test('online sync: a program error is a real problem with its plain message, reference and fix; items still come in', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  cloud.withStatus({ keys: 1 });
  prog.broken.availability = 'Riyeser POS couldn\'t publish your free booking times: this PC has no time-zone data for Pacific/Fiji.';
  cloud.add('order', { customer: { name: 'Kim' } });
  const a = pc({ cloud, prog, clock });
  let st = await a.sync.tick();
  assert.equal(cloud.items[0].status, 'done');                         // filing isn't held up by publishing
  assert.equal(cloud.published.catalog.length, 1); assert.equal(cloud.published.availability.length, 0);
  assert.equal(st.view, 'problem'); assert.equal(st.failures, 0);    // no back-off: tried again next minute
  assert.match(st.message, /^Riyeser POS couldn't publish your free booking times: this PC has no time-zone data/);
  assert.doesNotMatch(st.message, /answered 500/);
  assert.equal(st.ref, 'OA-1A2B3C'); assert.equal(st.problemProduct, 'pos'); assert.match(st.fix, /time zones|UTC/);
  assert.equal(prog.reports.at(-1).state, 'problem'); assert.equal(prog.reports.at(-1).ref, 'OA-1A2B3C');
  const probs = a.sync.trail({ status: 'problems' }).rows;
  assert.equal(probs.length, 1); assert.equal(probs[0].ref, 'OA-1A2B3C');
  // fixed: back to fine, published now
  delete prog.broken.availability;
  clock.add(MIN); st = await a.sync.tick();
  assert.equal(st.view, 'working'); assert.equal(cloud.published.availability.length, 1); assert.equal(st.message, '');
  // the same problem again a minute later isn't written to the trail every minute
  prog.broken.availability = 'Riyeser POS couldn\'t publish your free booking times: x.';
  for (let i = 0; i < 3; i++) { clock.add(MIN); await a.sync.tick(); }
  assert.equal(a.sync.trail({ status: 'error' }).rows.filter((r) => r.what.endsWith(': x.')).length, 1);
});

test('online sync: an older program\'s bare 500 says which program, what it was doing and to update it', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  prog.broken.outbox = 'html';
  fs.writeFileSync(discoveryFile(prog.dbPath), JSON.stringify({ ...JSON.parse(fs.readFileSync(discoveryFile(prog.dbPath), 'utf8')), program: 'Riyeser POS' }));
  const a = pc({ cloud, prog, clock });
  const st = await a.sync.tick();
  assert.equal(st.view, 'problem');
  assert.equal(st.message, 'Riyeser POS had a problem when it tried to read the news for your website (it answered 500).');
  assert.match(st.fix, /^Update Riyeser POS/);
  assert.equal(st.problemProduct, 'pos');
});

test('online sync: off on this PC says which PC brings items in', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  cloud.withStatus({ keys: 1, syncPc: 'OFFICE-PC' });
  const a = pc({ cloud, prog, clock, mode: 'off' });
  const st = await a.sync.tick();
  assert.equal(st.view, 'off'); assert.equal(st.syncPc, 'OFFICE-PC');
  assert.equal(cloud.rpcCalls('api_inbox_claim').length, 0);
  assert.equal(prog.reports.at(-1).state, 'off'); assert.equal(prog.reports.at(-1).cloud.sync_pc, 'OFFICE-PC');
  const other = pc({ cloud, prog, clock, name: 'Laptop', companyFile: false });   // Automatic, no company file here
  const o = await other.sync.tick();
  assert.equal(o.view, 'off'); assert.equal(o.otherPc, true); assert.equal(o.syncPc, 'OFFICE-PC');
});

test('online sync: Send a test goes through the post box and shows it arriving on this PC', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  cloud.withStatus({ keys: 0 });
  const timers = []; const a = pc({ cloud, prog, clock });
  await a.sync.tick();
  assert.equal(a.sync.status().view, 'not_setup');
  let st = await a.sync.sendTest('enquiry');
  assert.equal(st.test.step, 'sent'); assert.equal(cloud.items.length, 1); assert.ok(cloud.items[0].test);
  st = await a.sync.tick();
  assert.equal(st.test.step, 'arrived'); assert.equal(st.test.outcome, 'done'); assert.equal(cloud.items[0].status, 'done');
  assert.equal(st.receivedToday, 0);                                  // a test isn't counted as received
  assert.equal(a.notes.length, 0);                                    // and pops no notification
  const tests = a.sync.trail({ type: 'test' }).rows;
  assert.deepEqual(tests.map((r) => r.status), ['done', 'waiting']);
  assert.match(tests[0].what, /^Test arrived: Filed as enquiry/); assert.match(tests[0].detail, /nothing was added to the books/);
  await assert.rejects(a.sync.sendTest('refund'), /Choose a test/);
  cloud.cfg.service = false;
  await assert.rejects(a.sync.sendTest('booking'), /no service published yet/);
  assert.equal(a.sync.trail({ type: 'test', status: 'error' }).rows.length, 1);
  void timers;
});

test('online sync: "Send a test" asked for on the program\'s Online page is sent by Central and reported back', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  cloud.withStatus({ keys: 0 });
  prog.askTest({ id: 'req-1', kind: 'booking', at: '2026-11-27T01:00:00+00:00' });
  const a = pc({ cloud, prog, clock });
  const st = await a.sync.tick();
  assert.equal(cloud.items.length, 1); assert.equal(cloud.items[0].kind, 'booking'); assert.equal(cloud.items[0].status, 'done');
  const rep = prog.reports.at(-1);
  assert.deepEqual(rep.test_sent, { request_id: 'req-1', event_id: cloud.items[0].id });
  assert.ok(rep.trail.some((l) => l.type === 'test' && /Test arrived/.test(l.what)));
  clock.add(MIN); await a.sync.tick();
  assert.equal(cloud.items.length, 1);                                // asked once, sent once
  assert.equal(st.test.from, 'program');
});

test('online sync: on a database without api_status it works as before', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  const a = pc({ cloud, prog, clock });
  const st = await a.sync.tick();
  assert.equal(st.view, 'waiting'); assert.equal(st.cloudMissing, true); assert.equal(cloud.published.catalog.length, 1);
  clock.add(MIN); await a.sync.tick();
  assert.equal(cloud.rpcCalls('api_status').length, 1);              // not asked again for an hour
});

test('online trail: quiet runs merge, 90 days kept, trail lines reach the program, CSV export is safe', async (t) => {
  const { clock, cloud, prog } = await setup(); t.after(prog.close);
  cloud.withStatus({ keys: 1 });
  const a = pc({ cloud, prog, clock });
  for (let i = 0; i < 5; i++) { await a.sync.tick(); clock.add(MIN); }
  const quiet = a.sync.trail({ type: 'run' }).rows.filter((r) => r.what === 'Checked: nothing new');
  assert.equal(quiet.length, 1); assert.equal(quiet[0].n, 4);   // the first run published (not quiet)
  cloud.add('booking', { customer: { name: '=cmd|calc' } });
  await a.sync.tick();
  const sentUids = new Set(prog.reports.flatMap((r) => r.trail || []).map((l) => l.uid));
  assert.ok(a.sync.trail().rows.every((r) => sentUids.has(r.uid)));   // every line went to the program
  const csv = a.sync.trailCsv({});
  assert.match(csv, /^﻿When \(this PC\)/); assert.match(csv, /Filed as booking BK-1/); assert.match(csv, /'=cmd\|calc/);
  // reopened later: lines kept; 91 days on: gone
  const { Trail } = require('../src/central/online-trail');
  const file = path.join(a.store.dir, 'online-trail.json');
  assert.ok(new Trail({ file, now: clock.now }).rows.length > 3);
  assert.equal(new Trail({ file, now: () => clock.now() + 91 * 86400e3 }).rows.length, 0);
});

test('local app: the program\'s JSON error keeps its plain message and reference', async (t) => {
  const dir = tmp(); const prog = fakeProgram(dir); t.after(prog.close); await prog.listen();
  prog.broken.catalog = 'Riyeser Accounting couldn\'t publish your prices: the company file is busy.';
  const local = new LocalApp({ dbPath: prog.dbPath });
  await assert.rejects(local.catalog(), (e) => e.message === prog.broken.catalog && e.ref === 'OA-1A2B3C' && e.status === 500 && e.plain && e.local);
  assert.equal((await local.peek()).company, 'Online Co');
  assert.equal(await new LocalApp({ dbPath: path.join(tmp(), 'company.db') }).peek(), null);
});
