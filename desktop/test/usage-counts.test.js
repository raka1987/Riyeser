// Riyeser Central's anonymous usage counts (HQ → Downloads: New installs, Updates): one "new" note the first time,
// "existing" for a PC that had Central before, "add" and "update" notes after, nothing twice, marked test in demo mode,
// developer copies and CI, the Settings switch (on unless turned off), linking to the business once, and nothing
// personal ever sent (no names, emails, PC names, paths or the PC's linking id).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const uc = require('../src/central/usage-counts');
const { Store } = require('../src/core/store');

const CFG = { url: 'https://x.supabase.co', key: 'sb_publishable_test' };
function rig({ fail = false, firstKind = 'new', demo = false, packaged = true, env = {}, company = null, signedIn = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const store = new Store(path.join(dir, 'data'));
  const sent = []; const links = [];
  const fetchFn = async (url, o) => { assert.strictEqual(url, `${CFG.url}/rest/v1/rpc/track_install`); assert.strictEqual(o.headers.apikey, CFG.key);
    assert.ok(!o.headers.Authorization, 'anonymous: no sign-in sent'); if (fail) return { ok: false, status: 404 }; sent.push(JSON.parse(o.body)); return { ok: true, status: 200 }; };
  const u = uc.createUsageCounts({ store, config: async () => CFG, fetchFn, isDemo: () => demo, packaged, appVersion: '1.9.0', osVersion: 'Windows 10.0.22631',
    readCompany: () => company, firstKind, env, link: async (id, ws) => { if (!signedIn) return false; links.push([id, ws]); return true; } });
  return { store, sent, links, u };
}

test('the first run sends one "new" note; nothing again while nothing changes', async () => {
  const r = rig();
  const res = await r.u.tick({ central: '1.9.0', pos: '1.4.1' });
  assert.deepStrictEqual(res.sent, ['new']);
  assert.strictEqual(r.sent.length, 1);
  const n = r.sent[0];
  assert.strictEqual(n.kind, 'new'); assert.deepStrictEqual(n.programs, ['central', 'pos']);
  assert.match(n.install_id, /^[0-9a-f-]{36}$/); assert.strictEqual(n.central_version, '1.9.0'); assert.strictEqual(n.os_version, 'Windows 10.0.22631');
  assert.strictEqual(n.test, false); assert.strictEqual(n.country, null);
  await r.u.tick({ central: '1.9.0', pos: '1.4.1' });
  assert.strictEqual(r.sent.length, 1, 'nothing new: nothing sent');
});

test('adds and updates afterwards, each once; a downgrade or unknown version is not an update', async () => {
  const r = rig();
  await r.u.tick({ central: '1.9.0', pos: '1.4.1' });
  await r.u.tick({ central: '1.9.1', pos: '1.4.1', invoices: '1.0.0' });
  assert.deepStrictEqual(r.sent.slice(1).map((x) => [x.kind, x.detail]), [['update', 'central@1.9.1'], ['add', 'invoices']]);
  await r.u.tick({ central: '1.9.1', pos: '1.4.1', invoices: '1.0.0' });
  await r.u.tick({ central: '1.9.0', pos: null, invoices: '1.0.0' });
  assert.strictEqual(r.sent.length, 3, 'no repeats, no downgrade or unknown version updates');
  const id = r.sent[0].install_id; assert.ok(r.sent.every((x) => x.install_id === id), 'the same random install id');
  await r.u.tick({ central: '1.9.0' });            // POS and Invoices removed
  await r.u.tick({ central: '1.9.0', pos: '1.5.0' }); // POS back
  assert.deepStrictEqual(r.sent.slice(-1).map((x) => [x.kind, x.detail]), [['add', 'pos']]);
});

test('a PC that had Central before counting began is "existing"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')); const store = new Store(path.join(dir, 'data'));
  assert.strictEqual(uc.hadCentralBefore(store), false, 'a brand new PC');
  store.set('updateCheck', { at: 1 });
  assert.strictEqual(uc.hadCentralBefore(store), true, 'Central had run here');
  store.set(uc.STATE, { installId: 'x' });
  assert.strictEqual(uc.hadCentralBefore(store), false, 'once counting has started, never again');
  const r = rig({ firstKind: 'existing' }); await r.u.tick({ central: '1.9.0' });
  assert.strictEqual(r.sent[0].kind, 'existing');
});

test('demo mode, developer copies and CI are marked test', async () => {
  for (const o of [{ demo: true }, { packaged: false }, { env: { GITHUB_ACTIONS: 'true' } }, { env: { CI: '1' } }, { env: { TF_BUILD: 'True' } }]) {
    const r = rig(o); await r.u.tick({ central: '1.9.0' });
    assert.strictEqual(r.sent[0].test, true, JSON.stringify(o));
  }
  assert.strictEqual(uc.isCi({ CI: 'false' }), false);
  assert.strictEqual(uc.isCi({}), false);
});

test('Settings: on unless turned off; off sends nothing at all, on again carries on', async () => {
  const r = rig();
  assert.strictEqual(r.u.enabled(), true, 'on by default');
  r.u.setEnabled(false);
  const res = await r.u.tick({ central: '1.9.0' });
  assert.strictEqual(res.off, true); assert.strictEqual(r.sent.length, 0);
  r.u.setEnabled(true); await r.u.tick({ central: '1.9.0' });
  assert.strictEqual(r.sent.length, 1);
});

test('offline, or an older database: tried again next time, nothing lost or doubled', async () => {
  const r = rig({ fail: true });
  await r.u.tick({ central: '1.9.0' });
  assert.ok(!r.u.state().counted, 'not marked counted');
  const id = r.u.state().installId;
  const ok = uc.createUsageCounts({ store: r.store, config: async () => CFG, fetchFn: async (u, o) => { r.sent.push(JSON.parse(o.body)); return { ok: true }; }, packaged: true });
  await ok.tick({ central: '1.9.0' });
  assert.strictEqual(r.sent.length, 1); assert.strictEqual(r.sent[0].install_id, id, 'the same id');
  const none = uc.createUsageCounts({ store: r.store, config: async () => ({ url: '', key: '' }), fetchFn: async () => assert.fail('not set up: nothing sent') });
  assert.deepStrictEqual((await none.tick({ central: '2.0.0' })).sent, []);
});

test('linked to a business: its country, and the install is tied to it once (signed in)', async () => {
  const company = { name: 'Sample Plumbing', mode: 'online', workspace_id: 'ws-1', country: 'Fiji', email: 'alex@sample.test', phone: '330 1234', your_name: 'Alex' };
  const r = rig({ company });
  await r.u.tick({ central: '1.9.0' });
  assert.strictEqual(r.sent[0].country, 'Fiji');
  assert.deepStrictEqual(r.links, [[r.sent[0].install_id, 'ws-1']]);
  await r.u.tick({ central: '1.9.0' });
  assert.strictEqual(r.links.length, 1, 'linked once');
  const all = JSON.stringify(r.sent);
  for (const bad of ['Sample Plumbing', 'alex@', '330 1234', 'Alex', os.hostname()]) assert.ok(!all.includes(bad), `never sends ${bad}`);
  const out = rig({ company, signedIn: false }); await out.u.tick({ central: '1.9.0' });
  assert.strictEqual(out.links.length, 0); assert.ok(!out.u.state().linkedWs, 'not signed in: tried again later');
});

test('a local company (not online) sends no country and links nothing', async () => {
  const r = rig({ company: { name: 'Shop', mode: 'local', country: 'Fiji' } });
  await r.u.tick({ central: '1.9.0' });
  assert.strictEqual(r.sent[0].country, null); assert.strictEqual(r.links.length, 0);
});

test('Central wires it in: Settings switch, IPC, first-run check before anything is written', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'central-main.js'), 'utf8').replace(/\r\n/g, '\n');   // Windows checkouts use CRLF
  assert.match(main, /usageFirst = usageCounts\.hadCentralBefore\(store\)/);
  assert.ok(main.indexOf('usageCounts.hadCentralBefore(store)') < main.indexOf('registerIpc();\n  createWindow();'), 'checked before the app starts writing');
  assert.match(main, /handle\('central:usageSet'/); assert.match(main, /install_link/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'central.html'), 'utf8');
  assert.match(html, /id="setusage" checked/); assert.match(html, /Send anonymous usage counts/); assert.match(html, /About Riyeser Central and your privacy/);
});
