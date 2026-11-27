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
      classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); }, add(c) { this.set.add(c); } },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, focus() {}, scrollIntoView() {}, closest() { return null; }, querySelector: () => make(), ...props };
    return el;
  };
  const byId = {};
  for (const m of HTML.matchAll(/id="([^"]+)"/g)) byId[m[1]] = make({ id: m[1] });
  byId.manualbox.hidden = true;
  const tabs = ['phones', 'people', 'calls', 'settings'].map((t) => { const b = make({ tag: 'button', dataset: { tab: t } }); b.closest = (s) => (s === 'button' ? b : null); return b; });
  const panes = ['phones', 'people', 'calls', 'settings'].map((p) => make({ dataset: { pane: p }, hidden: p !== 'phones' }));
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
    localStorage: { getItem: () => null, setItem() {} } });
  const g = vm.runInContext('this', ctx);
  g.window = g;
  Object.defineProperty(g, 'api', { value: Object.freeze({ call, on() {} }), configurable: false, enumerable: true, writable: false });
  vm.runInContext(fs.readFileSync(path.join(R, 'link-text.js'), 'utf8'), ctx, { filename: 'link-text.js' });
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
  await p.click(p.tabs[1]);
  assert.equal(p.panes.find((x) => x.dataset.pane === 'people').hidden, false);
  assert.equal(p.panes.find((x) => x.dataset.pane === 'phones').hidden, true);
  assert.deepEqual(p.errors, []);
});

test('a backend that never answers: "Starting…" at the top, never an empty bar, and the tabs still work', async () => {
  const p = boot(() => new Promise(() => {}));
  await tick();
  assert.match(p.byId.state.innerHTML, /Starting Riyeser Link Office/);
  assert.equal(p.byId.setup.innerHTML, '');   // empty boxes are hidden by link.css (:empty)
  await p.click(p.tabs[3]);
  assert.equal(p.panes.find((x) => x.dataset.pane === 'settings').hidden, false);
});

test('a backend that fails: the problem is said at the top with Try again, it keeps trying, and recovers', async () => {
  let fail = true; let asked = 0;
  const p = boot(async (c) => { if (c === 'link:status') { asked++; if (fail) throw new Error('No handler registered for link:status'); return STATUS; } return true; });
  await tick();
  assert.match(p.byId.state.innerHTML, /couldn't be read/);
  assert.match(p.byId.state.innerHTML, /data-a="reload"/);
  await p.click(p.tabs[2]);
  assert.equal(p.panes.find((x) => x.dataset.pane === 'calls').hidden, false);
  fail = false;
  const reload = { dataset: { a: 'reload' }, disabled: false }; reload.closest = () => reload;
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
