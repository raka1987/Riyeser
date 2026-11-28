// Riyeser Central 1.9 home screen, "App launcher": the tiles come from the programs installed on this PC, each with
// one short live line; "+ Add a program"; status chips only when there's something to say; "Needs attention" only for
// what's really broken; the 🔒 Admin panel's lock (owner or admin + two-step code, locks again after 15 minutes);
// and every feature of the old home screen is still reachable from the new one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const L = require('../src/renderer/launcher');
const LUI = require('../src/renderer/licence-ui');
const { AdminLock, IDLE_LOCK, shapeBusiness, sampleBusiness } = require('../src/central/admin');
const sources = require('../src/central/sources');
const updates = require('../src/central/updates');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const NOW = new Date('2026-11-25T10:00:00');   // a Wednesday
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const days = (n) => new Date(NOW.getTime() + n * 86400000);
const P = (id, status = 'installed', o = {}) => ({ id, name: { accounting: 'Accounting Plus', 'accounting-basics': 'Accounting Basics', team: 'Link', desk: 'Documents', pdf: 'PDF', pos: 'POS', payroll: 'Payroll', bookings: 'Bookings', invoices: 'Invoices', estimate: 'Estimate', linkoffice: 'Link Office', services: 'As Built' }[id] || id, full: `Riyeser ${id}`, status, ...o });
const all = (installed) => ['team', 'linkoffice', 'invoices', 'bookings', 'estimate', 'accounting-basics', 'accounting', 'pos', 'payroll', 'desk', 'pdf', 'services'].map((id) => P(id, installed.includes(id) ? 'installed' : 'missing'));
const owner = { who: 'owner', linked: true, business: 'Coastal Plumbing Co' };
const someone = { who: 'individual', linked: false, business: '' };

// ---------------------------------------------------------------- tiles
test('tiles: one per installed program, in riyeser.com\'s order, then "+ Add a program" last', () => {
  const t = L.tiles({ programs: all(['pdf', 'accounting', 'payroll', 'desk']), audience: someone, today: {} });
  assert.deepStrictEqual(t.map((x) => x.id), ['desk', 'pdf', 'accounting', 'payroll', 'add']);
  assert.deepStrictEqual(t.map((x) => x.kind), ['open', 'open', 'open', 'open', 'add']);
  assert.strictEqual(t[t.length - 1].name, 'Add a program');
  // a program that isn't installed never gets a tile, even with old data left on the PC
  const none = L.tiles({ programs: all([]), audience: someone, today: { money: { found: true, receivables: [{ overdue: true, owing: 5 }] } } });
  assert.deepStrictEqual(none.map((x) => x.id), ['add']);
});

test('tiles: Accounting Plus covers Basics; a business PC always has Riyeser Link; someone on their own doesn\'t', () => {
  const both = L.tiles({ programs: all(['accounting', 'accounting-basics']), audience: owner, today: {} });
  assert.ok(!both.some((x) => x.id === 'accounting-basics'));
  const link = both.find((x) => x.id === 'team');
  assert.ok(link && link.kind === 'team' && link.window, 'Central\'s own Link window when the app isn\'t installed');
  assert.ok(!L.tiles({ programs: all(['pdf']), audience: someone, today: {} }).some((x) => x.id === 'team'));
  assert.strictEqual(L.tiles({ programs: all(['team']), audience: someone, today: {} }).find((x) => x.id === 'team').kind, 'team');
});

test('tiles: programs on the plan that aren\'t installed yet get a quiet Install tile; a failed install says so', () => {
  const cl = { planMissing: [{ id: 'payroll', name: 'Payroll' }] };
  let t = L.tiles({ programs: all(['accounting']), audience: owner, cl, today: {} });
  const want = t.find((x) => x.id === 'payroll');
  assert.deepStrictEqual([want.kind, want.line], ['want', 'On your plan · Install']);
  t = L.tiles({ programs: all(['accounting']), audience: owner, cl, today: {}, inst: { payroll: { stage: 'failed', message: 'x' } } });
  assert.deepStrictEqual([t.find((x) => x.id === 'payroll').line, t.find((x) => x.id === 'payroll').tone], ['Didn\'t install · Try again', 'bad']);
});

test('tiles: an update that\'s ready shows on the tile (and in its ⋯ menu), with the jobs that program can do', () => {
  const t = L.tiles({ programs: all(['payroll', 'pdf', 'invoices']), audience: someone, today: {}, upd: { updates: [{ id: 'payroll', to: '2.6.0' }] } });
  assert.strictEqual(t.find((x) => x.id === 'payroll').update, '2.6.0');
  assert.deepStrictEqual(t.find((x) => x.id === 'payroll').jobs.map((j) => [j.t, j.page]), [['Run payroll', 'payrun']]);
  assert.deepStrictEqual(t.find((x) => x.id === 'pdf').jobs.map((j) => j.t), ['Open a PDF', 'Combine PDFs']);
  assert.deepStrictEqual(t.find((x) => x.id === 'invoices').jobs.map((j) => j.t), ['New invoice']);   // free Invoices: only without Accounting
  const withAcc = L.tiles({ programs: all(['invoices', 'accounting']), audience: someone, today: {} });
  assert.deepStrictEqual(withAcc.find((x) => x.id === 'invoices').jobs, []);
  assert.deepStrictEqual(withAcc.find((x) => x.id === 'accounting').jobs.map((j) => j.t), ['New invoice']);
});

// ---------------------------------------------------------------- live lines
test('live lines: "2 overdue", "$12,480 owed", "Wed pay run" / "Paid Mon", "3 today", "2 unread", "5 to file", "Trial · 87 days"', () => {
  const at = (h) => { const d = new Date(NOW); d.setHours(h); return d.getTime(); };
  const money = { found: true, receivables: [{ overdue: true, owing: 2140 }, { overdue: true, owing: 1000 }, { overdue: false, owing: 4200 }], totals: { owedToYou: 7340 } };
  const ctx = (o = {}) => ({ now: NOW, accId: 'accounting', LUI, lic: { mode: 'trial', daysLeft: 87 }, today: {}, ...o });
  assert.deepStrictEqual(L.liveLine('accounting', ctx({ today: { money } })), { text: '2 overdue', tone: 'warn' });
  assert.deepStrictEqual(L.liveLine('accounting', ctx({ today: { money: { found: true, receivables: [{ overdue: false, owing: 12480 }], totals: { owedToYou: 12480 } } } })).text, '$12,480 owed');
  assert.strictEqual(L.liveLine('payroll', ctx({ today: { payroll: { lastRun: { pay_date: ymd(days(-6)) }, nextRun: { pay_date: ymd(days(1)) } } } })).text, 'Thu pay run');
  assert.strictEqual(L.liveLine('payroll', ctx({ today: { payroll: { nextRun: { pay_date: ymd(NOW) } } } })).text, 'Pay run today');
  assert.strictEqual(L.liveLine('payroll', ctx({ today: { payroll: { lastRun: { pay_date: ymd(days(-2)) }, nextRun: { pay_date: ymd(days(5)) } } } })).text, 'Paid Mon');
  const sync = { recent: [{ kind: 'booking', at: at(8) }, { kind: 'booking', at: at(9) }, { kind: 'booking', at: at(9) }, { kind: 'booking', at: at(9), test: true }, { kind: 'booking', at: days(-1).getTime() }] };
  assert.strictEqual(L.liveLine('bookings', ctx({ sync })).text, '3 today');
  assert.strictEqual(L.liveLine('team', ctx({ unread: 2 })).text, '2 unread');
  assert.strictEqual(L.liveLine('desk', ctx({ today: { documents: true, inbox: 5 } })).text, '5 to file');
  assert.strictEqual(L.liveLine('desk', ctx({ today: { documents: false, tasks: [{}, {}], taskCount: 4 } })).text, '4 to-dos');
  assert.deepStrictEqual(L.liveLine('estimate', ctx()), { text: 'Trial · 87 days', tone: '' });
  assert.deepStrictEqual(L.liveLine('pos', ctx({ lic: { mode: 'trial', daysLeft: 9 } })), { text: 'Trial · 9 days', tone: 'warn' });
  assert.deepStrictEqual(L.liveLine('pdf', ctx()), { text: '', tone: '' });   // free and nothing to say: no line
});

test('live lines: what stops work wins (trial ended, not on the plan); installing and failed installs show on the tile', () => {
  const ended = { online: { rows: [{ id: 'payroll', text: 'trial ended — contact Riyeser', tone: 'bad' }] } };
  assert.deepStrictEqual(L.liveLine('payroll', { LUI, lic: ended, today: { payroll: { nextRun: { pay_date: ymd(days(1)) } } }, now: NOW }), { text: 'Trial ended', tone: 'bad' });
  assert.deepStrictEqual(L.liveLine('pos', { LUI, lic: ended, today: {}, now: NOW }), { text: 'Not on your plan', tone: 'bad' });
  const paid = { online: { rows: [{ id: 'plus', text: 'paid until 30 Jun 2027', tone: 'ok' }] } };
  assert.deepStrictEqual(L.liveLine('accounting', { LUI, lic: paid, today: {}, now: NOW, accId: 'accounting' }), { text: '', tone: '' });   // paid: nothing to say
  assert.strictEqual(L.liveLine('pos', { installing: 'pos', inst: { pos: { stage: 'downloading', pct: 0.42 } }, today: {} }).text, 'Installing… 42%');
  assert.deepStrictEqual(L.liveLine('pos', { inst: { pos: { stage: 'failed' } }, today: {} }), { text: 'Didn\'t install', tone: 'bad' });
});

// ---------------------------------------------------------------- chips
test('chips: overdue invoices, the pay run, online bookings today, Getting started — and nothing when there\'s nothing to say', () => {
  const at = (h) => { const d = new Date(NOW); d.setHours(h); return d.getTime(); };
  const today = { money: { found: true, receivables: [{ overdue: true, owing: 2140 }, { overdue: true, owing: 1000 }, { overdue: false, owing: 99 }] }, payroll: { lastRun: { pay_date: ymd(days(-1)) } } };
  const c = L.chips({ now: NOW, programs: all(['accounting', 'payroll', 'bookings']), today, sync: { recent: [{ kind: 'booking', at: at(8) }, { kind: 'booking', at: at(9) }, { kind: 'booking', at: at(9) }] }, cl: { total: 9, done: 3 } });
  assert.deepStrictEqual(c.map((x) => x.text), ['2 invoices overdue · $3,140', 'Pay run done Tue', '3 online bookings today', 'Getting started · 3 of 9']);
  assert.deepStrictEqual(c.map((x) => x.tone), ['warn', 'ok', 'ok', '']);
  assert.deepStrictEqual(L.chips({ now: NOW, programs: all(['pdf']), today: {}, cl: { total: 6, done: 6, allDone: true } }), []);
  // the books' figures only while an Accounting app (or Invoices) is installed; hidden or finished Getting started: no chip
  assert.deepStrictEqual(L.chips({ now: NOW, programs: all(['pdf']), today, cl: { total: 6, done: 2, hidden: true } }), []);
  assert.deepStrictEqual(L.chips({ now: NOW, programs: all(['pdf']), today: {}, cl: { demo: true, total: 0 } }), []);
  assert.strictEqual(L.chips({ now: NOW, programs: all(['payroll']), today: { payroll: { nextRun: { pay_date: ymd(days(2)) } } } })[0].text, 'Pay run Fri');
});

// ---------------------------------------------------------------- needs attention
test('needs attention: only what\'s really broken and important; never an update, a trial with days left or the checklist', () => {
  const calm = L.attention({ sync: { view: 'working' }, lic: { mode: 'trial', daysLeft: 30 }, LUI, installedIds: ['payroll', 'pos'], company: { company: { name: 'X' } },
    backups: { backups: [{ when: new Date(NOW - 86400000).toISOString() }] }, now: NOW.getTime(), inst: { pos: { stage: 'downloading' } } });
  assert.deepStrictEqual(calm, []);
  const bad = L.attention({ sync: { view: 'problem', message: 'Bookings couldn\'t file a booking.' }, lic: { online: { stale: true, rows: [] } }, LUI,
    company: { unlinked: true, company: { name: 'Coastal' } }, demoNote: 'POS is still open', inst: { pos: { stage: 'failed', message: 'No internet' } }, programs: [P('pos')],
    updError: 'Download failed', backups: { backups: [{ when: new Date(NOW - 9 * 86400000).toISOString() }] }, installedIds: ['pos'], now: NOW.getTime() });
  assert.deepStrictEqual(bad.map((x) => x.id), ['online', 'plan', 'unlinked', 'demo', 'install-pos', 'updates', 'backup']);
  assert.ok(bad.every((x) => x.title && x.act && x.act.label), 'each says what to do');
  const ended = L.attention({ lic: { online: { rows: [{ id: 'payroll', tone: 'bad', text: 'trial ended' }] } }, LUI, installedIds: ['payroll'], names: { payroll: 'Payroll' } });
  assert.deepStrictEqual(ended.map((x) => x.title), ['Payroll: trial ended or not on your plan']);
  assert.deepStrictEqual(L.attention({ lic: { mode: 'expired' }, LUI, installedIds: ['pdf'] }), [], 'a free program: nothing to unlock');
  assert.strictEqual(L.attention({ lic: { mode: 'expired' }, LUI, installedIds: ['pos'] })[0].id, 'expired');
});

// ---------------------------------------------------------------- who is looking
test('audience: owner or admin, staff, someone on their own (no business, personal account), a PC set up on its own, demo', () => {
  const co = { mode: 'online', workspace_id: 'w', name: 'Coastal Plumbing Co' };
  assert.deepStrictEqual(L.audience({ company: co, role: 'owner' }).who, 'owner');
  assert.deepStrictEqual(L.audience({ company: co, role: 'admin' }).who, 'owner');
  assert.deepStrictEqual(L.audience({ company: co, role: 'member' }).who, 'staff');
  assert.deepStrictEqual(L.audience({ company: co, role: null }).who, 'staff');   // not known yet: the less shown, the better
  assert.deepStrictEqual(L.audience({ company: null }), { who: 'individual', linked: false, business: '' });
  assert.strictEqual(L.audience({ company: { ...co, kind: 'personal' } }).who, 'individual');
  assert.strictEqual(L.audience({ company: co, kind: 'personal', role: 'owner' }).who, 'individual');
  assert.deepStrictEqual(L.audience({ company: { mode: 'local', name: 'Bob\'s Bakery' } }), { who: 'owner', linked: false, business: 'Bob\'s Bakery' });
  assert.strictEqual(L.audience({ demo: true }).business, 'Sample Trading Co');
  assert.strictEqual(L.greeting(NOW, 'Ricky'), 'Good morning, Ricky');
  assert.strictEqual(L.greeting(new Date('2026-11-25T19:00:00'), ''), 'Good evening');
  assert.strictEqual(L.firstName('Ricky Mateo'), 'Ricky');
});

test('search box: programs and their one-click jobs (customers and files come from Central)', () => {
  const t = L.tiles({ programs: all(['payroll', 'pdf', 'accounting']), audience: someone, today: {} });
  assert.deepStrictEqual(L.searchLocal('pay', t).map((x) => [x.kind, x.title]), [['program', 'Riyeser payroll'], ['job', 'Run payroll']]);
  assert.deepStrictEqual(L.searchLocal('combine', t).map((x) => [x.kind, x.title, x.page]), [['job', 'Combine PDFs', 'combine']]);
  assert.deepStrictEqual(L.searchLocal('new invoice', t).map((x) => x.id), ['accounting']);
  assert.deepStrictEqual(L.searchLocal('install', t).map((x) => x.kind), ['add']);
  assert.deepStrictEqual(L.searchLocal('   ', t), []);
});

// ---------------------------------------------------------------- the 🔒 Admin panel's lock
function onlineFake({ code = '123456', role = 'owner', mfa = true, ws = 'w1' } = {}) {
  const calls = [];
  return {
    calls,
    async signIn(email) { calls.push(['signIn', email]); return mfa ? { email, needsCode: true } : { email }; },
    signOut() { calls.push(['signOut']); },
    async verifyCode(c) { calls.push(['verify', c]); if (c !== code) throw new Error('That code isn\'t right.'); return { email: 'x' }; },
    async memberships() { return role ? [{ role, workspaces: { id: ws } }] : []; },
    async call(p, o) { calls.push(['call', p, o && o.body]); if (/devices/.test(p)) return [{ id: 'd', device_name: 'OFFICE', app_version: '1.9.0', last_seen: 'x', secret: 's' }]; if (/members/.test(p)) return [{ display_name: 'A', role: 'owner', user_id: 'u' }, { display_name: 'B', role: 'member' }];
      if (/join_requests/.test(p)) return [{ display_name: 'C', email: 'c@x', created_at: 't' }]; if (/branches/.test(p)) return [{ name: 'Suva' }]; return { enabled: true, relays: [{}], offices: [{ pc_name: 'O', version: '1.3.1', relay: true }] }; },
  };
}
test('Admin lock: open straight away on a PC with no online business; locked on a business PC until an owner or admin unlocks it', async () => {
  let company = null;
  const a = new AdminLock({ readCompany: () => company, isDemo: () => false, makeOnline: () => onlineFake() });
  assert.deepStrictEqual([a.state().needed, a.state().open], [false, true]);
  assert.doesNotThrow(() => a.require());
  company = { mode: 'local', name: 'Bob' };
  assert.strictEqual(a.state().open, true, 'set up on this PC only: nobody to ask');
  company = { mode: 'online', workspace_id: 'w1', name: 'Coastal' };
  assert.deepStrictEqual([a.state().needed, a.state().open], [true, false]);
  assert.throws(() => a.require(), /Unlock the Admin panel first/);
  await assert.rejects(a.business(), /Unlock the Admin panel first/);
});

test('Admin lock: password, then a fresh two-step code; only the owner or an admin; no two-step sign-in, no entry', async () => {
  const company = { mode: 'online', workspace_id: 'w1', name: 'Coastal' };
  let fake = onlineFake();
  const a = new AdminLock({ readCompany: () => company, isDemo: () => false, makeOnline: () => fake });
  assert.deepStrictEqual(await a.unlock('owner@x', 'pw'), { needsCode: true });
  assert.strictEqual(a.state().open, false, 'not open on the password alone');
  await assert.rejects(a.unlockCode('000000'), /code isn't right/);
  const s = await a.unlockCode('123456');
  assert.deepStrictEqual([s.open, s.email], [true, 'owner@x']);
  // staff: refused, and signed out of the unsaved session
  fake = onlineFake({ role: 'member' }); const b = new AdminLock({ readCompany: () => company, isDemo: () => false, makeOnline: () => fake });
  await b.unlock('staff@x', 'pw');
  await assert.rejects(b.unlockCode('123456'), /Only Coastal's owner or an admin/);
  assert.strictEqual(b.state().open, false); assert.ok(fake.calls.some((c) => c[0] === 'signOut'));
  // an account without two-step sign-in can't unlock it
  fake = onlineFake({ mfa: false }); const c = new AdminLock({ readCompany: () => company, isDemo: () => false, makeOnline: () => fake });
  await assert.rejects(c.unlock('owner@x', 'pw'), /needs two-step sign-in/);
  await assert.rejects(c.unlockCode('123456'), /Sign in again/);
  // the owner of another business can't unlock this one
  fake = onlineFake({ ws: 'other' }); const d = new AdminLock({ readCompany: () => company, isDemo: () => false, makeOnline: () => fake });
  await d.unlock('owner@x', 'pw'); await assert.rejects(d.unlockCode('123456'), /owner or an admin/);
});

test('Admin lock: locks again after 15 minutes without use; using it starts the 15 minutes again; Lock now', async () => {
  let t = 1_000_000; const company = { mode: 'online', workspace_id: 'w1', name: 'Coastal' };
  const a = new AdminLock({ readCompany: () => company, isDemo: () => false, makeOnline: () => onlineFake(), now: () => t });
  await a.unlock('owner@x', 'pw'); await a.unlockCode('123456');
  assert.strictEqual(IDLE_LOCK, 15 * 60 * 1000);
  t += 14 * 60 * 1000; a.touch();
  t += 14 * 60 * 1000; assert.strictEqual(a.state().open, true, 'used 14 minutes ago');
  a.require();   // an admin action counts as use
  t += 15 * 60 * 1000 + 1; assert.strictEqual(a.state().open, false, '15 minutes without use');
  assert.throws(() => a.require());
  await a.unlock('owner@x', 'pw'); await a.unlockCode('123456');
  assert.strictEqual(a.lock().open, false);
});

test('Admin panel: the business\'s PCs, people, join requests, branches and relay — only the fields the panel shows', async () => {
  const company = { mode: 'online', workspace_id: 'w1', name: 'Coastal' }; const fake = onlineFake();
  const a = new AdminLock({ readCompany: () => company, isDemo: () => false, makeOnline: () => fake });
  await a.unlock('owner@x', 'pw'); await a.unlockCode('123456');
  const b = await a.business();
  assert.deepStrictEqual(b.pcs, [{ id: 'd', name: 'OFFICE', platform: '', version: '1.9.0', linkedAt: null, lastSeen: 'x' }]);
  assert.deepStrictEqual([b.people.total, b.people.owners, b.people.admins], [2, 1, 0]);
  assert.deepStrictEqual(b.requests, [{ name: 'C', at: 't' }]);   // never the email
  assert.deepStrictEqual(b.branches, [{ name: 'Suva' }]);
  assert.deepStrictEqual([b.relay.enabled, b.relay.relays, b.relay.offices[0].relay], [true, 1, true]);
  assert.ok(fake.calls.some((c) => c[0] === 'call' && /workspace_id=eq\.w1/.test(c[1])), 'read for this business only');
  assert.ok(!JSON.stringify(b).includes('secret') && !JSON.stringify(b).includes('c@x'));
  assert.deepStrictEqual(shapeBusiness({}), { pcs: null, people: null, requests: null, branches: null, relay: null });
});

test('Admin panel in demo mode: any email and the code 123456; Sample Trading Co\'s made-up PCs and people', async () => {
  let demo = true;
  const a = new AdminLock({ readCompany: () => null, isDemo: () => demo, makeOnline: () => { throw new Error('never online in demo mode'); } });
  assert.deepStrictEqual([a.state().needed, a.state().open, a.state().demo], [true, false, true]);
  await a.unlock('', '');
  await assert.rejects(a.unlockCode('111111'), /123456/);
  assert.strictEqual((await a.unlockCode('123456')).open, true);
  const b = await a.business();
  assert.deepStrictEqual(b.pcs.map((x) => x.name), sampleBusiness(Date.now()).pcs.map((x) => x.name));
  assert.ok(b.pcs.length && b.people.total && b.branches.length);
  demo = false;
  assert.strictEqual(a.state().needed, false, 'out of demo mode on a PC with no business: no lock');
  assert.strictEqual(a.admin, null, 'the demo unlock ends with demo mode');
});

test('central-main: what only the Admin panel does is refused by Central itself while the panel is locked', () => {
  const m = src('central-main.js');
  for (const h of ['fresh:start', 'fresh:bringBack', 'onlineSync:setMode', 'central:setChannel', 'central:uninstall', 'central:licenceRemove']) {
    const body = m.slice(m.indexOf(`handle('${h}'`), m.indexOf('\n  handle(', m.indexOf(`handle('${h}'`) + 10));
    assert.match(body, /admin\.require\(\)/, `${h} checks the lock`);
  }
  assert.match(m, /handle\('backup:restoreAll'[\s\S]{0,200}admin\.require\(\)/);
  assert.match(m, /handle\('demo:start', \(opts\) => \{\s*if \(!demoUi\.startAllowed\(opts\)\) throw[^\n]*\n\s*admin\.require\(\);/);
  for (const h of ['admin:state', 'admin:unlock', 'admin:code', 'admin:lock', 'admin:touch', 'admin:business', 'central:versions', 'central:prefs', 'central:startWithWindows', 'central:notify', 'central:customers', 'central:openWeb']) assert.ok(m.includes(`handle('${h}'`), h);
  assert.match(m, /makeOnline: \(\) => new online\.Online\(\{ store: memoryStore\(store\)/, 'the admin\'s sign-in is never saved');
});

// ---------------------------------------------------------------- nothing lost
test('nothing lost: every feature of the 1.8 home screen is reachable from the 1.9 launcher', () => {
  const html = src('renderer/central.html'); const js = src('renderer/central.js'); const company = src('renderer/company.js'); const os2 = src('renderer/online-sync-ui.js');
  const page = `${html}\n${js}`;
  const features = {
    'open each program (tile)': /data-open="\$\{esc\(t\.id\)\}"/,
    'Riyeser Link (own app or Central\'s window), unread count': /data-act="team"/,
    'find a file / search': /id="q"[^>]*Search programs, customers and files/,
    'search filters (type, year, kind), Open and Show': /chipRow\('Type'[\s\S]*data-file=[\s\S]*data-reveal=/,
    'customers in the search box': /central:customers/,
    'Get more apps → Add a program (Install, Open online, Learn more, Download page, Locate…)': /data-install=[\s\S]*Open online[\s\S]*Learn more[\s\S]*Download page[\s\S]*data-locate=/,
    'install progress, failure, Try again, Get help': /instFailed[\s\S]*Try again[\s\S]*data-insthelp/,
    'plan bar: install the plan\'s programs': /data-cl="plan">Install/,
    'programs on the plan, not installed: tile': /class="app want" data-install/,
    'Company page (in Your account)': /id="companyv"/,
    'sign in / sign out': /data-w="signout"[\s\S]*data-w="link"|data-w="link"[\s\S]*data-w="signout"/,
    'Try demo mode / Leave demo mode': /data-demo="try"[\s\S]*data-demo="leave"|data-demo="leave"[\s\S]*data-demo="try"/,
    'Licence / your plan': /data-lic="open"/,
    'Help pages': /data-help="central"/,
    'Get help (riyeser.com)': /data-act="gethelp"/,
    'Report an issue': /data-act="report"/,
    'Check for updates / Update all': /id="admcheck"[\s\S]*|id="updall"/,
    'update one program': /data-tact="update"/,
    'Settings: Getting started, usage counts, privacy': /id="sethide"[\s\S]*id="setusage" checked[\s\S]*About Riyeser Central and your privacy/,
    'theme (light / dark)': /name="settheme" value="dark"/,
    'Fresh start': /function freshBox\(\)[\s\S]*#adm-fresh/,
    'Backups': /function backupBox\(\)[\s\S]*#adm-backups/,
    'Online connections status, Sync now, mode, guide, activity': /id="onlinep"[\s\S]*id="onlinenow"[\s\S]*id="osset"/,
    'Getting started checklist (a chip)': /id="checklist"/,
    'overdue invoices (Invoices to chase)': /Invoices to chase/,
    'meetings today (Desk Assistant)': /pop: 'meetings'|kind === 'meetings'/,
    'one-click jobs (Shortcuts)': /data-page="\$\{esc\(j\.page\)\}"/,
    'first-run quiet panel': /id="frbar"/,
    'demo banner': /id="demobar"/,
    'version and "never changes it"': /Shows information from your other Riyeser programs and never changes it/,
  };
  for (const [name, re] of Object.entries(features)) assert.match(page, re, name);
  assert.match(os2, /\$\('#osset'\)/, 'Online connections\' mode lives in the Admin panel');
  assert.match(company, /function renderCompany\(\)/);
  // the jobs from 1.8's Shortcuts are all still there
  for (const t of ['Open the till', 'New invoice', 'New booking', 'New estimate', 'Run payroll', 'Documents Inbox', 'Find a document', 'Open a PDF', 'Combine PDFs']) assert.ok(L.JOBS.some((j) => j.t === t), t);
  // the old sidebar and panels are gone from the home screen
  for (const gone of ['id="nav"', 'id="cards"', 'id="activity"', 'id="quick"', 'id="licbar"', 'id="cobar"', 'id="updates" class="panel banner"']) assert.ok(!html.includes(gone), gone);
});

test('the launcher: top bar, greeting with the business, one pill, tiles, Add a program, chips; Admin hidden from someone on their own', () => {
  const html = src('renderer/central.html'); const js = src('renderer/central.js');
  for (const id of ['adminbtn', 'avbtn', 'avmenu', 'hello', 'sub', 'pill', 'tiles', 'chips', 'admdlg', 'setdlg', 'helpdlg', 'acctdlg', 'pop', 'tmenu']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.ok(html.indexOf('launcher.js') < html.indexOf('central.js') && html.indexOf('central.js') < html.indexOf('company.js'));
  assert.match(js, /\$\('#adminbtn'\)\.hidden = a\.who === 'individual'/);
  assert.match(js, /a\.who === 'individual' \? date : `\$\{a\.business\} · \$\{date\}`/, 'someone on their own sees no business');
  assert.match(js, /\['people', 'online', 'branches'\]\.includes\(id\)/, 'no business sections for someone on their own');
  // no pop-ups: nothing opens by itself, no browser dialogs
  assert.doesNotMatch(js, /\b(alert|confirm|prompt)\(/);
  assert.doesNotMatch(src('renderer/company.js'), /first === 'signedout'\) \{ if \(typeof setView/);
  // keyboard: the tile menu from the Menu key / Shift+F10, arrows in menus, Escape closes, Ctrl+K to search
  assert.match(js, /e\.key === 'ContextMenu' \|\| \(e\.shiftKey && e\.key === 'F10'\)/);
  assert.match(js, /ArrowDown[\s\S]*ArrowUp[\s\S]*Home[\s\S]*End/);
  assert.match(js, /e\.key === 'k' && \(e\.ctrlKey \|\| e\.metaKey\)/);
});

// ---------------------------------------------------------------- the main process's new readers
test('sources: the next pay run from the last pay period; customers from the books; Documents\' Inbox count', async () => {
  assert.deepStrictEqual(sources.nextPayRun({ period_start: '2026-11-10', period_end: '2026-11-16', pay_date: '2026-11-20' }), { pay_date: '2026-11-27', periodDays: 7 });
  assert.deepStrictEqual(sources.nextPayRun({ period_start: '2026-11-03', period_end: '2026-11-16', pay_date: '2026-11-20' }).pay_date, '2026-12-04');
  assert.deepStrictEqual(sources.nextPayRun({ period_start: '2026-10-01', period_end: '2026-10-31', pay_date: '2026-10-31' }).pay_date, '2026-12-01');
  assert.strictEqual(sources.nextPayRun({ period_start: '2026-11-10', period_end: '2026-11-10', pay_date: '2026-11-20' }), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const SQL = await require('sql.js')();
  const db = new SQL.Database();
  db.run(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, contact_person TEXT, email TEXT, phone TEXT, active INTEGER);
    INSERT INTO contacts VALUES (1,'customer','Bayside Cafe Group','Litia','a@bayside.example','1',1), (2,'supplier','Bay Supplies','','','',1), (3,'customer','Old Bay Co','','','',0), (4,'customer','Northshore','Tom','tom@ns.example','',1);`);
  fs.writeFileSync(path.join(dir, 'company.db'), Buffer.from(db.export()));
  assert.deepStrictEqual((await sources.findCustomers(path.join(dir, 'company.db'), 'bay')).map((c) => c.name), ['Bayside Cafe Group'], 'customers only, active only');
  assert.deepStrictEqual((await sources.findCustomers(path.join(dir, 'company.db'), 'tom')).map((c) => c.name), ['Northshore']);
  assert.deepStrictEqual(await sources.findCustomers(path.join(dir, 'company.db'), "'; DROP TABLE contacts; --"), []);
  assert.deepStrictEqual(await sources.findCustomers(path.join(dir, 'none.db'), 'bay'), []);
  fs.mkdirSync(path.join(dir, 'lib', '_Inbox'), { recursive: true });
  for (const f of ['a.pdf', 'b.jpg', '~$c.docx', '.hidden']) fs.writeFileSync(path.join(dir, 'lib', '_Inbox', f), 'x');
  assert.strictEqual(sources.inboxCount(path.join(dir, 'lib')), 2);
  assert.strictEqual(sources.inboxCount(path.join(dir, 'nowhere')), null);
  assert.strictEqual(sources.inboxCount('\\\\server\\share\\Riyeser Documents'), null, 'a network library isn\'t looked at');
});

test('updates: the channel picks a release (Early access takes pre-releases); Uninstall finds the right program\'s uninstaller', () => {
  const list = [{ tag_name: 'b', prerelease: true, published_at: '2026-11-27' }, { tag_name: 'a', prerelease: false, published_at: '2026-11-20' }, { tag_name: 'd', draft: true, published_at: '2026-11-28' }];
  assert.strictEqual(updates.pickRelease(list, 'stable').tag_name, 'a');
  assert.strictEqual(updates.pickRelease(list, 'early').tag_name, 'b');
  assert.strictEqual(updates.pickRelease([], 'early'), null);
  const reg = ['HKEY_CURRENT_USER\\...\\{a}', '    DisplayName    REG_SZ    Riyeser Link Office 1.3.1', '    UninstallString    REG_SZ    "C:\\Program Files\\Riyeser Link Office\\Uninstall Riyeser Link Office.exe"', '',
    'HKEY_CURRENT_USER\\...\\{b}', '    DisplayName    REG_SZ    Riyeser Link 1.4.0', '    UninstallString    REG_SZ    "C:\\Users\\o\\AppData\\Local\\Programs\\riyeser-team\\Uninstall Riyeser Link.exe" /currentuser',
    '    QuietUninstallString    REG_SZ    "C:\\Users\\o\\AppData\\Local\\Programs\\riyeser-team\\Uninstall Riyeser Link.exe" /currentuser /S', '',
    'HKEY_CURRENT_USER\\...\\{c}', '    DisplayName    REG_SZ    Riyeser POS', '    UninstallString    REG_EXPAND_SZ    "C:\\Users\\o\\AppData\\Local\\Programs\\Riyeser POS\\unins000.exe"'].join('\r\n');
  assert.match(updates.uninstallFromRegistry(reg, 'team').command, /riyeser-team\\Uninstall Riyeser Link\.exe" \/currentuser$/);
  assert.match(updates.uninstallFromRegistry(reg, 'team').quiet, /\/S$/);
  assert.match(updates.uninstallFromRegistry(reg, 'linkoffice').command, /Program Files\\Riyeser Link Office/);
  assert.match(updates.uninstallFromRegistry(reg, 'pos').command, /unins000\.exe/);
  assert.strictEqual(updates.uninstallFromRegistry(reg, 'payroll'), null);
});

test('a brand new PC: Central\'s program list works on the very first start (a cached null "locations" broke it)', () => {
  const { Store } = require('../src/core/store'); const uc = require('../src/central/usage-counts');
  const store = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-')), 'data'));
  assert.strictEqual(uc.hadCentralBefore(store), false);
  assert.deepStrictEqual(store.get('locations', {}), {}, 'asking first doesn\'t leave a null behind');
  assert.match(src('central-main.js'), /\(store\.get\('locations', \{\}\) \|\| \{\}\)\[p\.id\]/);
});
