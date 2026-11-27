// Riyeser Central's "Online connections" panel and its "Connect your website" guide, drawn from the sync's status:
// grey "not set up" with Set up (never red when nothing is connected), "Connected · nothing new", working, a real
// problem with its fix / Details / Get help, offline, and "Off on this PC" naming the PC that syncs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const vm = require('vm');

function load() {
  const el = () => ({ hidden: false, innerHTML: '', disabled: false, addEventListener() {}, appendChild() {}, scrollIntoView() {}, style: {} });
  const nodes = { '#onlinep': el(), '#online': el(), '#onlinenow': el() };
  const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: el, body: el() };
  const ctx = { window: {}, document, setInterval: () => 0, clearInterval() {}, console,
    $: (s) => nodes[s] || null, esc: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    ago: (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'Just now' : `${m} min ago`; }, fmtTime: () => '9:05 am', toast() {}, safe: (f) => f(),
    bridge: { call: async () => null, on() {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'online-sync-ui.js'), 'utf8'), ctx);
  return { ui: ctx.window.RiyeserOnlineSync, nodes };
}
const base = (o) => ({ mode: 'auto', syncing: true, state: 'ok', view: 'waiting', message: '', fix: '', ref: '', receivedToday: 0, lastSyncAt: Date.now() - 60000,
  lastCheckAt: Date.now() - 60000, lastTryAt: Date.now() - 60000, lastPublishAt: null, counts: { waiting: 0, failed: 0 }, recent: [], checklist: [], test: null, ...o });

test('online panel: not set up is grey with Set up, and says nothing about errors or syncing', () => {
  const { ui, nodes } = load();
  ui.render(base({ view: 'not_setup', counts: null }));
  const h = nodes['#online'].innerHTML;
  assert.match(h, /Online connections aren't set up\.<\/b> Connect your website or online shop so bookings and orders come in by themselves\./);
  assert.match(h, /id="ossetup"[^>]*>|data-os="guide" id="ossetup">Set up</);
  assert.match(h, /os-dot off/); assert.doesNotMatch(h, /os-dot bad|500|received today|last sync|os-problem/);
  assert.equal(nodes['#onlinenow'].hidden, true);   // no "Sync now" when there's nothing to sync
});

test('online panel: connected and waiting, working, problem, offline, off, paused', () => {
  const { ui } = load();
  let h = ui.panelBody(base({}));
  assert.match(h, /<b>Connected<\/b> · last checked 1 min ago · nothing new/); assert.match(h, /os-dot ok/); assert.doesNotMatch(h, /os-problem/);
  h = ui.panelBody(base({ view: 'working', receivedToday: 3, recent: [{ kind: 'booking', customer: 'Mere', reference: 'BK-1', outcome: 'done', at: Date.now() }, { kind: 'order', test: true, at: Date.now() }] }));
  assert.match(h, /<b>3 received today<\/b> · last sync 1 min ago/); assert.match(h, /Booking · Mere/); assert.doesNotMatch(h, /Order ·/);
  h = ui.panelBody(base({ view: 'problem', state: 'error', message: 'Riyeser POS couldn\'t publish your prices: bad <price>.', fix: 'It will be tried again in a minute.', ref: 'OA-1A2B3C' }));
  assert.match(h, /os-dot bad/); assert.match(h, /Riyeser POS couldn&#39;t publish your prices: bad &lt;price&gt;\./);
  assert.match(h, /Reference OA-1A2B3C/); assert.match(h, /data-os="details">Details/); assert.match(h, /data-os="help">Get help/);
  h = ui.panelBody(base({ view: 'offline', state: 'offline' }));
  assert.match(h, /os-dot idle/); assert.match(h, /No connection to Riyeser Online/); assert.doesNotMatch(h, /os-problem/);
  h = ui.panelBody(base({ view: 'off', syncing: false, syncPc: 'OFFICE-PC' }));
  assert.match(h, /<b>Off on this PC\.<\/b> OFFICE-PC brings in what your website sends\./); assert.match(h, /os-dot off/);
  h = ui.panelBody(base({ view: 'off', syncing: false, syncPc: '' }));
  assert.match(h, /Another PC brings in/);
  assert.match(ui.panelBody(base({ view: 'paused' })), /demo mode is on/);
});

test('online panel: hidden on a PC that isn\'t linked', () => {
  const { ui, nodes } = load();
  ui.render(base({ view: 'idle', syncing: false }));
  assert.equal(nodes['#onlinep'].hidden, true);
});

test('online guide: five steps, a checklist from real status, snippet and where to paste it, Send a test progress', () => {
  const { ui } = load();
  const cl = [{ id: 'key', text: 'A key made', done: true }, { id: 'request', text: 'Talked', done: false }, { id: 'sync', text: 'PC', done: true }, { id: 'item', text: 'First', done: false }, { id: 'publish', text: 'Published', done: false }];
  let h = ui.guideHtml(base({ checklist: cl }), 'booking');
  for (const w of ['Choose what you want on your website', 'Make the key in Riyeser Link', 'Copy the code into your website', 'Send a test', 'Done',
    'WordPress', 'Wix', 'Squarespace', 'Shopify', 'Plain HTML', 'Website booking widget', 'Open Management → Connections', 'never touches your books']) assert.ok(h.includes(w), w);
  assert.match(h, /&lt;script src=&quot;https:\/\/riyeser.com\/widget\/book.js&quot; data-key=&quot;rk_pub_live_…&quot; async&gt;/);
  assert.equal((h.match(/class="on" data-check/g) || []).length, 2);
  assert.match(h, /id="ogs2"/); assert.match(h, /og-step done" id="ogs2"/);   // key made: step 2 ticked
  assert.doesNotMatch(h, /og-step done" id="ogs5"/);
  h = ui.guideHtml(base({ checklist: cl }), 'enquiry');
  assert.match(h, /data-type=&quot;enquiry&quot;/); assert.match(h, /<option value="enquiry" selected>/);
  h = ui.guideHtml(base({ checklist: cl }), 'shop');
  assert.match(h, /Online shop orders/); assert.match(h, /POST \/v1\/orders/); assert.doesNotMatch(h, /WordPress/);
  h = ui.guideHtml(base({ checklist: cl, test: { id: 'ev-1', step: 'sent', at: Date.now() } }), 'booking');
  assert.match(h, /Sent just now\.<\/b> It's in your post box/); assert.match(h, /id="ogsend" disabled/);
  h = ui.guideHtml(base({ checklist: cl.map((c) => ({ ...c, done: true })), test: { id: 'ev-1', step: 'arrived', reference: 'TEST-BK-1', message: 'Thanks (test)', pc: 'FRONT-PC' } }), 'booking');
  assert.match(h, /✓ It arrived on FRONT-PC\.<\/b> TEST-BK-1 · Thanks \(test\) Nothing was added to your books\./);
  assert.match(h, /og-step done" id="ogs4"/); assert.match(h, /og-step done" id="ogs5"/);
});
