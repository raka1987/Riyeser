// Riyeser Link Office 1.2.1: the status screen always starts. 1.2.0 declared `const api` at the top of link.js while the
// preload puts a fixed (non-configurable) `api` on the window, which is a SyntaxError in Electron: no tabs, an empty status
// bar and empty cards. These tests run the real link-text.js and link.js in a sandbox shaped like that window (with a small
// stand-in page), with a backend that works, fails, or never answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R = path.join(__dirname, '..', 'src', 'renderer');
const HTML = fs.readFileSync(path.join(R, 'link.html'), 'utf8');

/** A tiny page: every id in link.html, the four tabs and their panes, and the click listeners. */
function fakePage() {
  const listeners = {};
  const make = (props = {}) => {
    const el = { innerHTML: '', textContent: '', className: '', hidden: false, open: false, value: '', dataset: {}, style: {}, attrs: {},
      classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); }, add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, focus() {}, scrollIntoView() {}, closest() { return null; }, contains() { return false; }, before() {}, nextElementSibling: null,
      querySelector: () => make(), querySelectorAll: () => [], ...props };
    return el;
  };
  const byId = {};
  for (const m of HTML.matchAll(/id="([^"]+)"/g)) byId[m[1]] = make({ id: m[1] });
  byId.manualbox.hidden = true;
  const TABS = ['overview', 'phones', 'people', 'calls', 'settings'];
  const tabs = TABS.map((t) => { const b = make({ tag: 'button', dataset: { tab: t } }); b.closest = (s) => (s === 'button' ? b : null); return b; });
  const panes = TABS.map((p) => make({ dataset: { pane: p }, hidden: p !== 'overview' }));
  const adv = make({ open: false });
  const document = {
    activeElement: null,
    querySelector(s) { if (s.startsWith('#')) return byId[s.slice(1)] || null; if (s === '.adv') return adv; if (s.startsWith('[data-pane=')) return panes.find((p) => s.includes(`"${p.dataset.pane}"`)) || null; return null; },
    querySelectorAll(s) { if (s === '.tabs button') return tabs; if (s === '[data-pane]') return panes; return []; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    createElement: () => make(),
    body: make({ appendChild() {} }),
  };
  const click = async (target) => { for (const fn of listeners.click || []) await fn({ target, preventDefault() {} }); };
  return { document, byId, tabs, panes, listeners, click };
}

/** Run link-text.js and link.js like the Electron window does: `api` is a fixed property of the window. */
function boot(call) {
  const page = fakePage(); const errors = [];
  const ctx = vm.createContext({ document: page.document, console: { error: (...a) => errors.push(a.join(' ')), log() {} }, setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; }, clearTimeout, Promise, Date, Error, String, Object, Map, Set,
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const g = vm.runInContext('this', ctx);
  g.window = g;
  Object.defineProperty(g, 'api', { value: Object.freeze({ call, on() {} }), configurable: false, enumerable: true, writable: false });
  vm.runInContext(fs.readFileSync(path.join(R, 'link-text.js'), 'utf8'), ctx, { filename: 'link-text.js' });
  vm.runInContext(fs.readFileSync(path.join(R, 'link-bulk.js'), 'utf8'), ctx, { filename: 'link-bulk.js' });
  vm.runInContext(fs.readFileSync(path.join(R, 'link.js'), 'utf8'), ctx, { filename: 'link.js' });
  return { ...page, errors, ctx };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const STATUS = { state: 'running', host: '192.168.1.20', sipPort: 5060, httpPort: 5080, version: '1.2.1', business: 'Sample Plumbing', licence: { active: true, text: 'Riyeser Link' },
  counts: { phones: 1, onCalls: 0, connected: 1 }, addressStable: true, cloud: null, source: 'local', people: [{ id: 'a', name: 'Alex Sample', ext: '101', device: 'desk phone', state: 'ready', dnd: false }],
  groups: [], phones: [], found: [], inProgress: [], recent: [], blocked: [], skipped: [], logs: [], names: { mdns: 'riyeser-office.local', router: null, useName: false, mode: 'address', server: '192.168.1.20' },
  addressChanges: [], adapters: { current: { name: 'Ethernet', address: '192.168.1.20', mac: '3C:52:82:1A:2B:3C' }, list: [] }, signedIn: false, platform: 'win32' };

test('link.js never declares a top-level `api` (the preload\'s window.api is fixed; that was the 1.2.0 blank screen)', () => {
  const src = fs.readFileSync(path.join(R, 'link.js'), 'utf8');
  assert.doesNotMatch(src, /^(const|let|var|function|class)\s+api\b/m);
});

test('the screen starts with a backend that answers: status filled in, tabs switch', async () => {
  const p = boot(async (c) => (c === 'link:status' ? STATUS : true));
  await tick();
  assert.match(p.byId.state.innerHTML, /running on this PC \(192\.168\.1\.20\)/);
  assert.match(p.byId.hero.innerHTML, /192\.168\.1\.20/);
  assert.match(p.byId.tiles.innerHTML, /Phones/);
  await p.click(p.tabs[2]);
  assert.equal(p.panes.find((x) => x.dataset.pane === 'people').hidden, false);
  assert.equal(p.panes.find((x) => x.dataset.pane === 'overview').hidden, true);
  assert.deepEqual(p.errors, []);
});

test('a backend that never answers: "Starting…" at the top, never an empty bar, and the tabs still work', async () => {
  const p = boot(() => new Promise(() => {}));
  await tick();
  assert.match(p.byId.state.innerHTML, /Starting Riyeser Link Office/);
  assert.equal(p.byId.setup.innerHTML, '');   // empty boxes are hidden by link.css (:empty)
  await p.click(p.tabs[4]);
  assert.equal(p.panes.find((x) => x.dataset.pane === 'settings').hidden, false);
});

test('a backend that fails: the problem is said at the top with Try again, it keeps trying, and recovers', async () => {
  let fail = true; let asked = 0;
  const p = boot(async (c) => { if (c === 'link:status') { asked++; if (fail) throw new Error('No handler registered for link:status'); return STATUS; } return true; });
  await tick();
  assert.match(p.byId.state.innerHTML, /couldn't be read/);
  assert.match(p.byId.state.innerHTML, /data-a="reload"/);
  await p.click(p.tabs[3]);
  assert.equal(p.panes.find((x) => x.dataset.pane === 'calls').hidden, false);
  fail = false;
  const reload = { dataset: { a: 'reload' }, disabled: false }; reload.closest = (s) => (s === 'button' ? reload : null);
  await p.click(reload); await tick();
  assert.ok(asked >= 2);
  assert.match(p.byId.state.innerHTML, /running on this PC/);
});

test('one part that can\'t be drawn shows its own note; the rest of the screen still fills in', async () => {
  const bad = { ...STATUS, adapters: null };   // Settings → This PC's address can't be drawn
  const p = boot(async (c) => (c === 'link:status' ? bad : true));
  await tick();
  assert.match(p.byId.state.innerHTML, /running on this PC/);
  assert.match(p.byId.hero.innerHTML, /192\.168\.1\.20/);
  assert.match(p.byId.address.innerHTML, /couldn't be shown/);
  assert.ok(p.errors.some((e) => /this PC's address/.test(e)));
});

test('link.css hides empty boxes instead of leaving grey bars', () => {
  const css = fs.readFileSync(path.join(R, 'link.css'), 'utf8');
  for (const id of ['state', 'setup', 'hero']) assert.match(css, new RegExp(`#${id}:empty`));
});

// ---------- 1.3.0: the Riyeser relay in the control panel ----------
const RELAY_OK = { state: 'connected', connected: true, relay: 'syd1', region: 'Sydney', host: 'relay.riyeser.com', rtt: 42, backup: false, primary: { id: 'syd1', region: 'Sydney' },
  sites: [{ name: 'Nadi', exts: 2, via: 'here' }], remote: 3, remoteExts: ['201', '202', '301'], phones: 1, udp: 'ok', since: new Date().toISOString(), error: null, reconnects: 0, draining: [], relays: [{ id: 'syd1', region: 'Sydney' }, { id: 'mel1', region: 'Melbourne' }] };
const withRelay = (relay, more = {}) => ({ ...STATUS, version: '1.3.0', relay, siteName: 'Suva', registrations: [{ ext: '101', ip: '192.168.1.50', device: 'desk phone' }],
  people: [...STATUS.people, { id: 'b', name: 'Ned Nadi', ext: '201', device: 'desk phone', state: 'not connected', dnd: false }], ...more });

test('Overview → Branches and relay shows the relay\'s real state; the top line says it too', async () => {
  const p = boot(async (c) => (c === 'link:status' ? withRelay(RELAY_OK) : true));
  await tick();
  assert.match(p.byId.tiles.innerHTML, /Branches and relay<\/h3><div class="big">Connected · Sydney · 42 ms/);
  assert.match(p.byId.tiles.innerHTML, /1 other site: Nadi · 1 phone at home/);
  assert.doesNotMatch(p.byId.tiles.innerHTML, /coming soon/);
  assert.match(p.byId.state.innerHTML, /class="relayline ok" id="relayline">Connected to Riyeser relay · Sydney · 42 ms · 1 other site/);
  assert.match(p.byId.relay.innerHTML, /Connect your branches|Other sites/);
  assert.match(p.byId.relay.innerHTML, /This PC as the relay/);   // win32
  // People: which site each extension's phone is at
  assert.match(p.byId.people.innerHTML, /data-prow="101"[\s\S]*?class="sitetag here"[^>]*>Suva</);
  assert.match(p.byId.people.innerHTML, /data-prow="201"[\s\S]*?Another site or at home/);
  assert.doesNotMatch(p.byId.attn.innerHTML, /relay/i);
  assert.deepEqual(p.errors, []);
});

test('Branches and relay: backup relay, not set up, and a problem with its fix (in Needs attention)', async () => {
  const backup = boot(async (c) => (c === 'link:status' ? withRelay({ ...RELAY_OK, relay: 'mel1', region: 'Melbourne', rtt: 61, backup: true }) : true));
  await tick();
  assert.match(backup.byId.tiles.innerHTML, /tile info" id="relaytile"[\s\S]*Using backup relay · Melbourne · 61 ms[\s\S]*main relay \(Sydney\) isn(?:'|&#39;)t answering/);
  assert.match(backup.byId.state.innerHTML, /Using backup relay · Melbourne · 61 ms/);

  const none = boot(async (c) => (c === 'link:status' ? withRelay({ state: 'off', connected: false }) : true));
  await tick();
  assert.match(none.byId.tiles.innerHTML, /tile off" id="relaytile"[\s\S]*<div class="big">Not set up/);
  assert.match(none.byId.state.innerHTML, /relayline muted[^>]*>Branches and relay: not set up/);
  assert.doesNotMatch(none.byId.people.innerHTML, /sitetag/);   // one site: no site tags
  assert.doesNotMatch(none.byId.attn.innerHTML, /relay/i);

  const down = boot(async (c) => (c === 'link:status' ? withRelay({ state: 'connecting', connected: false, error: 'connection lost', relays: RELAY_OK.relays }) : true));
  await tick();
  assert.match(down.byId.tiles.innerHTML, /tile warn" id="relaytile"[\s\S]*Problem: not connected[\s\S]*port 443[\s\S]*data-a="relayretry"/);
  assert.match(down.byId.attn.innerHTML, /Other sites can(?:'|&#39;)t be reached[\s\S]*data-a="relayretry">Reconnect now/);

  const refused = boot(async (c) => (c === 'link:status' ? withRelay({ state: 'refused', connected: false, error: 'an admin disconnected this office' }) : true));
  await tick();
  assert.match(refused.byId.tiles.innerHTML, /tile bad" id="relaytile"[\s\S]*Refused by the relay[\s\S]*allows it again/);
  assert.match(refused.byId.attn.innerHTML, /<li class="bad">[\s\S]*refused this office/);

  const udp = boot(async (c) => (c === 'link:status' ? withRelay({ ...RELAY_OK, udp: 'blocked' }) : true));
  await tick();
  assert.match(udp.byId.attn.innerHTML, /block UDP to the relay/);
  for (const x of [backup, none, down, refused, udp]) assert.deepEqual(x.errors, []);
});

test('a status from before 1.3.0 (no relay): every section still draws, the tile says Not set up', async () => {
  const p = boot(async (c) => (c === 'link:status' ? STATUS : true));
  await tick();
  assert.match(p.byId.tiles.innerHTML, /Branches and relay<\/h3><div class="big">Not set up/);
  assert.match(p.byId.relay.innerHTML, /Link this PC to your business/);
  assert.deepEqual(p.errors, []);
});
