// Riyeser Central 1.9.1 "Just try it": a brand-new person is never pushed to register. The welcome screen's order and
// words, the try path with no account and no internet, the one "This needs a free Riyeser account" question (only at
// the points that work online, never on start), and Not now leaving everything as it was.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const vm = require('vm');
const ui = require('../src/renderer/demo-ui');
const need = require('../src/renderer/account-need');
const L = require('../src/renderer/launcher');
const online = require('../src/core/online');
const licence = require('../src/core/licence');
const fr = require('../src/central/first-run');
const cl = require('../src/central/checklist');
const { Store } = require('../src/core/store');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'central-try-'));
const order = (html, keys) => keys.map((k) => html.indexOf(`data-w="${k}"`));
const offlineFetch = async () => { throw new Error('getaddrinfo ENOTFOUND (offline)'); };

test('welcome screen: "Welcome to Riyeser", Just try it first, then the sample business and the account choices, smaller', () => {
  const html = ui.startHtml();
  assert.match(html, /<h1>Welcome to Riyeser<\/h1>/);
  assert.match(html, /class="wbig wmain wprimary" data-w="try"><span class="wi">🚀<\/span><b>Just try it — no account needed<\/b><small>Start using the programs on this PC straight away\. Free programs stay free; the others are free for 90 days\.<\/small>/);
  // order: try, demo, sign in, join, create an account, my own business, set up later, restore
  const at = order(html, ['try', 'demo', 'signin', 'join', 'signup', 'blank', 'later', 'restore']);
  assert.ok(at.every((x) => x > 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.match(html, /class="wbig wsm" data-w="demo"><span class="wi">🧪<\/span><b>Look around with a sample business<\/b><small>Try with sample data/);
  assert.match(html, /class="wbig wsm" data-w="signin"><span class="wi">🔑<\/span><b>I already use Riyeser — sign in<\/b><small>For businesses already using Riyeser\. Use the same email as riyeser\.com\.<\/small>/);
  assert.match(html, /class="wlink" data-w="join">Join with a code</);
  assert.match(html, /class="wlink" data-w="signup">Create a free account</);
  assert.match(html, /class="wlink" data-w="blank">Start with my own business</);
  assert.match(html, /data-w="later">Set up later</);
  assert.match(html, /data-w="restore">Restore everything from a backup…</);
  assert.doesNotMatch(html, /data-w="leave"/);                      // first run: nowhere to go back to
  assert.match(ui.startHtml({ back: true }), /data-w="leave">Back</);  // opened from inside Central: Back returns there
  // only one big button, and it's Just try it
  assert.equal((html.match(/wbig wmain/g) || []).length, 1);
});

test('welcome screen offline: Just try it (and the sample business, and my own business) still work; signing in is greyed with a note', () => {
  const html = ui.startHtml({ online: false });
  const btn = (k) => (html.match(new RegExp(`<button[^>]*data-w="${k}"[^>]*>`)) || [''])[0];
  for (const k of ['try', 'demo', 'blank', 'later', 'restore']) assert.doesNotMatch(btn(k), /disabled/, k);
  for (const k of ['signin', 'join', 'signup']) assert.match(btn(k), /disabled/, k);
  assert.match(html, /Signing in isn(&#39;|')t available right now \(it needs the internet\)\. Just try it/);
  assert.doesNotMatch(ui.startHtml({ online: true }), /disabled/);
});

test('try path: company.js goes straight to the programs, with an optional business name, and nothing online', () => {
  const co = src('renderer/company.js');
  const tryFns = co.slice(co.indexOf('function showTry()'), co.indexOf('// next: \'signin\''));
  assert.match(tryFns, /Business name \(optional\)/);
  assert.match(tryFns, /You can add the rest later\./);
  assert.match(tryFns, /data-w="try-skip">Skip</);
  assert.match(tryFns, /data-w="start">Back</);
  assert.match(tryFns, /steps\(1, 'individual'\)/);                 // 1 Get started · 2 Pick your programs · 3 Done
  assert.match(tryFns, /bridge\.call\('company:local', \{ name, kind: 'personal' \}, ''\)/);
  assert.match(tryFns, /bridge\.call\('company:skip'\)/);
  assert.match(tryFns, /FRun\(\)\.individual\(\)/);
  assert.doesNotMatch(tryFns, /required|onlineReady|signIn|afterSignIn|company:create|company:details|company:join/);
  assert.match(co, /if \(a === 'try'\) return showTry\(\);/);
  assert.match(co, /if \(a === 'try-skip'\) \{ CO\.tryName = ''; return run\(\(\) => tryStart\(''\)\); \}/);
  assert.match(co, /if \(a === 'blank'\) return showLocal\(\);/);   // "Start with my own business": still reachable
  assert.deepEqual(require('../src/central/first-run').INDIVIDUAL.length > 0, true);
  assert.match(src('renderer/first-run.js'), /individual: \['Get started', 'Pick your programs', 'Done'\]/);
});

test('try path offline, as the main process does it: company.json on this PC, someone on their own, never asked again', () => {
  const appData = tmp(); const store = new Store(path.join(appData, 'data'));
  const o = new online.Online({ store, fetchFn: offlineFetch, appData });
  const c = o.setupLocal({ name: 'Sample Plumbing', kind: 'personal' }, '');
  assert.equal(c.mode, 'local'); assert.equal(c.kind, 'personal'); assert.equal(c.workspace_id, '');
  const company = online.readCompany(appData);
  assert.equal(company.name, 'Sample Plumbing');
  // no business or admin screens for them, the individual first run, and the first-run question never comes back
  assert.deepEqual(L.audience({ company }), { who: 'individual', linked: false, business: '' });
  assert.equal(fr.pathFor({ company }), 'individual');
  assert.equal(ui.firstScreen({ company, skipped: false }, null), 'none');
  // Skip (no business name): nothing written but "skipped"
  const appData2 = tmp();
  assert.equal(online.readCompany(appData2), null);
  assert.equal(ui.firstScreen({ company: null, skipped: true }, null), 'none');
  assert.deepEqual(L.audience({ company: null }), { who: 'individual', linked: false, business: '' });
  // Edit details later keeps them "on their own"
  o.setupLocal({ name: 'Sample Plumbing', address: '4 Elm St' }, 'Alex');
  assert.equal(online.readCompany(appData).kind, 'personal');
});

test('the free trial needs no account and no internet: 90 days from first use, exactly as before', () => {
  const appData = tmp();
  assert.equal(online.readCompany(appData), null);
  const s = licence.status(appData);
  assert.equal(s.mode, 'trial'); assert.equal(s.daysLeft, licence.TRIAL_DAYS); assert.equal(licence.TRIAL_DAYS, 90);
  assert.equal(s.online, undefined);
  const lic = require('../src/renderer/licence-ui');
  assert.equal(lic.programStatus('payroll', s).text, `Free trial, ${licence.TRIAL_DAYS} days left`);
  assert.equal(lic.programStatus('pdf', s), null);   // free programs stay free
  // the licence code doesn't read the Riyeser account (no session, no company)
  assert.doesNotMatch(src('core/licence.js').slice(src('core/licence.js').indexOf('function localStatus'), src('core/licence.js').indexOf('function fromApi')), /session|readCompany|signIn/);
});

test('Getting started: no account steps for someone just trying it; a business still gets them', () => {
  const personal = { name: 'Sample Plumbing', mode: 'local', kind: 'personal' };
  const ids = (r) => r.items.map((i) => i.id);
  const solo = cl.build({ company: personal, lic: {}, known: ['invoices'], kind: 'personal', solo: true });
  for (const id of ['signin', 'programs', 'team']) assert.ok(!ids(solo).includes(id), id);
  assert.ok(ids(solo).includes('details'));
  const biz = cl.build({ company: { name: 'Sample Plumbing', mode: 'local' }, lic: {}, known: ['invoices'] });
  assert.deepEqual(ids(biz).slice(0, 3), ['signin', 'details', 'programs']);
  const main = src('central-main.js');
  assert.match(main, /const solo = !on\.session && \(company \? company\.mode !== 'online' && kind === 'personal' : !!setup\.skipped\);/);
});

test('the account question: one friendly sentence, Create account / Sign in / Not now', () => {
  assert.equal(need.body('buy'), 'This needs a free Riyeser account so your plan works online. Create one in a minute, or sign in.');
  assert.equal(need.body('link'), 'This needs a free Riyeser account so Riyeser Link chat and calls work online. Create one in a minute, or sign in.');
  assert.equal(need.body('online'), 'This needs a free Riyeser account so bookings and orders from your website come in online. Create one in a minute, or sign in.');
  assert.equal(need.body('people'), 'This needs a free Riyeser account so the people who help you can join you online. Create one in a minute, or sign in.');
  assert.equal(need.body('sign'), 'This needs a free Riyeser account so your signing requests work online. Create one in a minute, or sign in.');
  assert.equal(need.body('the shared folder syncs'), 'This needs a free Riyeser account so the shared folder syncs. Create one in a minute, or sign in.');
  const h = need.promptHtml('buy');
  assert.ok(h.indexOf('data-need="later">Not now') < h.indexOf('data-need="signin">Sign in') && h.indexOf('data-need="signin">Sign in') < h.indexOf('data-need="create">Create account'));
  assert.equal(need.needed({ signedIn: null }), true);
  assert.equal(need.needed({ signedIn: 'alex@sample.example' }), false);
  assert.equal(need.needed({ signedIn: null, demo: true }), false);   // demo mode: never asked
  assert.match(src('renderer/central.html'), /<script src="account-need\.js"><\/script>\s*<script src="company\.js">/);
  assert.match(src('central-main.js'), /signup: 'https:\/\/riyeser\.com\/link\/\?signup'/);
});

// ---------- company.js in a pretend Central page: what the account question really does ----------
function el(extra = {}) {
  const e = { hidden: true, innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, classList: { contains: () => false, toggle() {} },
    focus() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null, ...extra };
  return e;
}
function page({ signedIn = null, demo = false, answer = 'later', onlineReady = true } = {}) {
  const els = {}; const calls = []; const asked = []; const winClick = []; const closed = [];
  const openDialogs = [{ id: 'licdlg', close() { closed.push('licdlg'); } }];
  const form = el({ email: el(), password: el() });
  const $ = (s) => (s === '#wf-acc' ? form : (els[s] = els[s] || el()));
  const state = { company: null, signedIn, onlineReady, skipped: true };
  const bridge = { call: async (c, ...a) => { calls.push([c, ...a]); if (c === 'company:get') return JSON.parse(JSON.stringify(state)); return null; }, on() {} };
  const document = { addEventListener() {}, querySelector: () => null,
    querySelectorAll: (s) => (s === 'dialog[open]' ? openDialogs : []), body: { classList: { contains: (c) => c === 'demo' && demo } } };
  const window = { addEventListener: (t, fn, cap) => { if (t === 'click' && cap) winClick.push(fn); },
    RiyeserDemo: ui, RiyeserAccountNeed: { ...need, ask: async (what) => { asked.push(what); return answer; } } };
  const ctx = { $, esc: ui.TEXT && ((s) => String(s ?? '')), bridge, toast: (m) => calls.push(['toast', m]), safe: async (fn) => { try { return await fn(); } catch (e) { calls.push(['error', e.message]); } },
    setView() {}, renderNav() {}, document, window, localStorage: { getItem: () => null, setItem() {} }, setInterval: () => 0, clearInterval() {}, console, FormData: class {} };
  vm.createContext(ctx);
  vm.runInContext(`${src('renderer/company.js')}\n;this.__CO = CO;`, ctx);
  return { ctx, els, calls, asked, winClick, closed, openDialogs, CO: ctx.__CO, api: window.RiyeserCompany, state };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const click = (fn, attrs) => {
  const b = el({ dataset: {}, matches: (sel) => sel.split(', ').some((x) => { const m = /^\[data-([a-z]+)="([^"]+)"\]$/.exec(x); return m && attrs[`data-${m[1]}`] === m[2]; }),
    closest: (sel) => (sel === '#wizard' ? null : sel === '[data-needs]' ? (attrs['data-needs'] ? b : null) : (b.matches(sel) ? b : null)), cloneNode: () => el({ click() {}, remove() {} }) });
  if (attrs['data-needs']) b.dataset.needs = attrs['data-needs'];
  const ev = { target: b, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  fn(ev); return ev;
};

test('nothing about accounts when Central starts: the question is only ever asked from a click at one of those points', async () => {
  const p = page(); await settle();
  assert.deepEqual(p.asked, []);
  assert.ok(!p.calls.some(([c]) => /signIn|afterSignIn/.test(c)));
  const co = src('renderer/company.js');
  const start = co.slice(co.lastIndexOf('// On start:'), co.indexOf('window.RiyeserCompany = '));
  assert.doesNotMatch(start, /needAccount|RiyeserAccountNeed|\.ask\(/);
  assert.doesNotMatch(src('renderer/central.js'), /needAccount\(|RiyeserAccountNeed/);   // central.js only marks its buttons
  assert.doesNotMatch(src('renderer/account-need.js'), /\balert\(|confirm\(|DOMContentLoaded|window\.addEventListener\('load'/);
});

test('the question appears at Buy, Link chat and calls, online bookings, adding people (and Ask someone to sign), and nowhere else', async () => {
  const p = page(); await settle();
  assert.equal(p.winClick.length, 1);
  const fn = p.winClick[0];
  const points = [[{ 'data-lic': 'buy' }, 'buy'], [{ 'data-act': 'team' }, 'link'], [{ 'data-open': 'team' }, 'link'], [{ 'data-open': 'linkoffice' }, 'link'],
    [{ 'data-os': 'guide' }, 'online'], [{ 'data-web': 'people' }, 'people'], [{ 'data-web': 'requests' }, 'people'], [{ 'data-act': 'team', 'data-needs': 'people' }, 'people']];
  for (const [attrs, what] of points) {
    p.asked.length = 0;
    const ev = click(fn, attrs); await settle();
    assert.ok(ev.prevented && ev.stopped, JSON.stringify(attrs));
    assert.deepEqual(p.asked, [what], JSON.stringify(attrs));
  }
  // everything else carries on untouched: opening a free program, the licence window, the trial, Settings
  for (const attrs of [{ 'data-open': 'invoices' }, { 'data-lic': 'open' }, { 'data-lic': 'refresh' }, { 'data-os': 'trail' }, { 'data-web': 'requestsHelp' }, { 'data-w': 'try' }]) {
    p.asked.length = 0;
    const ev = click(fn, attrs); await settle();
    assert.ok(!ev.prevented, JSON.stringify(attrs)); assert.deepEqual(p.asked, []);
  }
  // Ask someone to sign (another branch): the same question through window.RiyeserCompany.needAccount('sign', { then })
  p.asked.length = 0; let sent = false;
  assert.equal(await p.api.needAccount('sign', { then: () => { sent = true; } }), false);
  assert.deepEqual(p.asked, ['sign']); assert.equal(sent, false);
  // the checklist's "Invite the people who help you" button is marked as a people point
  assert.match(src('renderer/central.js'), /data-act="team" data-needs="people"/);
});

test('signed in, or demo mode: no question, the click goes ahead', async () => {
  for (const opts of [{ signedIn: 'alex@sample.example' }, { demo: true }]) {
    const p = page(opts); await settle();
    const ev = click(p.winClick[0], { 'data-lic': 'buy' }); await settle();
    assert.equal(ev.prevented, false); assert.deepEqual(p.asked, []);
    let ran = false; assert.equal(await p.api.needAccount('buy', { then: () => { ran = true; } }), true); assert.equal(ran, true);
  }
});

test('Not now: back where they were, nothing lost (no screen drawn, dialogs left open, nothing saved or sent)', async () => {
  const p = page({ answer: 'later' }); await settle();
  p.CO.screen = 'none'; const before = JSON.stringify({ ...p.CO, state: null, poll: null });
  const sentBefore = p.calls.length;
  let ran = false;
  assert.equal(await p.api.needAccount('buy', { then: () => { ran = true; } }), false);
  assert.equal(ran, false);
  assert.deepEqual(p.closed, []);                                   // the licence window underneath is still open
  assert.equal((p.els['#wizard'] || { hidden: true }).hidden, true);   // no sign-in screen
  assert.equal(JSON.stringify({ ...p.CO, state: null, poll: null }), before);
  assert.deepEqual(p.calls.slice(sentBefore).filter(([c]) => c !== 'company:get'), []);
  // and asked again next time (Not now isn't remembered as "no")
  p.asked.length = 0; click(p.winClick[0], { 'data-lic': 'buy' }); await settle(); assert.deepEqual(p.asked, ['buy']);
});

test('Create account / Sign in: Central\'s own account screens, Back returns to Central, and what needed it carries on afterwards', async () => {
  for (const answer of ['create', 'signin']) {
    const p = page({ answer }); await settle();
    let ran = false;
    assert.equal(await p.api.needAccount('buy', { then: () => { ran = true; } }), false);
    assert.equal(p.els['#wizard'].hidden, false);
    assert.match(p.els['#wizard'].innerHTML, answer === 'create' ? /Create your free Riyeser account/ : /Sign in with your Riyeser account/);
    assert.deepEqual(p.closed, ['licdlg']);
    assert.equal(p.CO.fromCompany, true); assert.equal(p.CO.first, false); assert.equal(typeof p.CO.after, 'function'); assert.equal(ran, false);
  }
  const co = src('renderer/company.js');
  assert.match(co, /if \(a === 'done'\) \{ closeWizard\(\); afterChange\(\); const then = CO\.after; CO\.after = null; if \(then\) safe\(then\); return; \}/);
  assert.match(co, /if \(a === 'back'\) \{ if \(CO\.fromCompany\) \{ CO\.after = null; closeWizard\(\); return; \}/);
  // offline: a plain note, nothing else changes
  const off = page({ answer: 'signin', onlineReady: false }); await settle();
  assert.equal(await off.api.needAccount('buy'), false);
  assert.ok(off.calls.some(([c, m]) => c === 'toast' && /Signing in isn't available right now/.test(m)));
  assert.deepEqual(off.closed, []);
});

test('Riyeser Link keeps its own sign-in: Create account opens the Link sign-up page, Sign in opens Link; asked once', async () => {
  const p = page({ answer: 'create' }); await settle();
  assert.equal(await p.api.needAccount('link'), false);
  assert.deepEqual(p.calls.filter(([c]) => c === 'central:openWeb'), [['central:openWeb', 'signup']]);
  const q = page({ answer: 'signin' }); await settle();
  let opened = false; assert.equal(await q.api.needAccount('link', { then: () => { opened = true; } }), true); assert.equal(opened, true);
  assert.match(src('renderer/company.js'), /const NEED_KEY = 'riyeser\.accountNeed\.link';/);
});
