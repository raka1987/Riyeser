// Riyeser Central's "Getting started with Riyeser" checklist: items tick themselves from small fake data folders.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const cl = require('../src/central/checklist');
const online = require('../src/core/online');
const licence = require('../src/core/licence');
const demo = require('../src/central/demo');
const { Store } = require('../src/core/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'central-cl-'));
const KNOWN = ['team', 'invoices', 'bookings', 'accounting-basics', 'accounting', 'pos', 'payroll', 'desk', 'pdf', 'services'];
const NAMES = { team: 'Riyeser Link', invoices: 'Invoices', bookings: 'Bookings', 'accounting-basics': 'Accounting Basics', accounting: 'Accounting Plus', pos: 'POS', payroll: 'Payroll', services: 'As Built' };
const on = (status = 'active') => ({ active: true, status });
const off = { active: false, status: 'ended' };
const ids = (r) => r.items.map((i) => i.id);
const item = (r, id) => r.items.find((i) => i.id === id);

async function sqlite(file, sql) {
  const init = require('sql.js/dist/sql-wasm.js');
  const SQL = await init({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const db = new SQL.Database(); db.run(sql);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(db.export())); db.close();
  return file;
}
// A cut-down Accounting company file with the tables the checklist reads.
const ACC = `CREATE TABLE company (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE contacts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE documents (id INTEGER PRIMARY KEY, side TEXT, status TEXT, number TEXT, contact_id INTEGER, date TEXT, total INTEGER DEFAULT 0, amount_paid INTEGER DEFAULT 0);
  CREATE TABLE pos_sales (id INTEGER PRIMARY KEY, document_id INTEGER, method TEXT, voided INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE booking_resources (id INTEGER PRIMARY KEY, name TEXT, kind TEXT DEFAULT 'staff', active INTEGER NOT NULL DEFAULT 1);
  INSERT INTO company VALUES (1, 'Sample Plumbing');`;
const PAY = `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, username TEXT UNIQUE, password_hash TEXT, role TEXT, active INTEGER NOT NULL DEFAULT 1);
  INSERT INTO users (name, username, password_hash, role) VALUES ('Administrator', 'admin', 'x', 'admin');`;

test('checklist: the plan from licence.json, as programs to install (Plus covers Basics, Riyeser Link Office only once Central knows it)', () => {
  const lic = { online: { modules: { basic: on(), plus: on('trial'), payroll: on('trial'), pos: off, bookings: on(), as_built: off, calls: on() } } };
  assert.deepEqual(cl.planModules(lic), ['basic', 'plus', 'bookings', 'payroll', 'calls']);   // active, including a running trial
  const want = cl.planToInstall(lic, { known: KNOWN, installed: ['payroll'], names: NAMES });
  assert.deepEqual(want.map((x) => x.id), ['team', 'bookings', 'accounting']);   // in Central's order; Payroll is installed already
  assert.deepEqual(want.map((x) => x.name), ['Riyeser Link', 'Bookings', 'Accounting Plus']);
  assert.deepEqual(cl.planToInstall(lic, { known: [...KNOWN, 'linkoffice'], installed: [], names: NAMES }).map((x) => x.id).includes('linkoffice'), true);
  // Basics on its own: installing Accounting Plus already covers it
  const basic = { online: { modules: { basic: on() } } };
  assert.deepEqual(cl.planToInstall(basic, { known: KNOWN, installed: [] }).map((x) => x.id), ['accounting-basics']);
  assert.deepEqual(cl.planToInstall(basic, { known: KNOWN, installed: ['accounting'] }), []);
  // no online plan: nothing to install from it
  assert.deepEqual(cl.planToInstall({}, { known: KNOWN }), []);
  assert.deepEqual(cl.planToInstall({ online: { modules: { payroll: off } } }, { known: KNOWN }), []);
});

test('checklist: reads the Accounting and Payroll files and ticks items from real records', async () => {
  const dir = tmp();
  const accDb = await sqlite(path.join(dir, 'acc', 'company.db'), ACC);
  const payDb = await sqlite(path.join(dir, 'pay', 'payroll.db'), PAY);
  const before = fs.readFileSync(accDb);
  let acc = await cl.accountingFacts(accDb); let pay = await cl.payrollFacts(payDb);
  assert.ok(fs.readFileSync(accDb).equals(before));   // read only: the file is exactly as it was
  assert.deepEqual({ ...acc, salesDocsAll: undefined }, { found: true, customers: 0, salesDocs: 0, salesDocsAll: undefined, posSales: 0, bookingResources: 0 });
  assert.equal(pay.staff, 0);   // only the built-in admin login

  const lic = { online: { modules: { payroll: on(), bookings: on(), pos: on() }, seats: { used: 1 } } };
  const base = { company: { name: 'Sample Plumbing', mode: 'online' }, lic, installed: ['accounting', 'payroll', 'bookings', 'pos'], known: KNOWN, names: NAMES };
  let r = cl.build({ ...base, acc, payroll: pay, members: 1 });
  for (const id of ['customer', 'invoice', 'team', 'payroll', 'bookings', 'sale']) assert.equal(item(r, id).done, false, id);

  await sqlite(accDb, `${ACC}
    INSERT INTO contacts (kind, name) VALUES ('supplier', 'Sample Wholesale'), ('customer', 'Sample Customer');
    INSERT INTO documents (side, status, number, contact_id, date) VALUES ('sale', 'paid', 'POS-1', 2, '2026-11-24');
    INSERT INTO pos_sales (document_id, method) VALUES (1, 'cash');
    INSERT INTO booking_resources (name) VALUES ('Van 1');`);
  await sqlite(payDb, `${PAY} INSERT INTO users (name, username, password_hash, role) VALUES ('Sample Worker', 'worker1', 'x', 'staff');`);
  fs.utimesSync(accDb, new Date(), new Date(Date.now() + 5000));   // a new save: read again
  acc = await cl.accountingFacts(accDb); pay = await cl.payrollFacts(payDb);
  r = cl.build({ ...base, acc, payroll: pay, members: 3 });
  assert.equal(item(r, 'customer').done, true);
  assert.equal(item(r, 'invoice').done, false);   // a till sale isn't an invoice or a quote
  assert.equal(item(r, 'sale').done, true);
  assert.equal(item(r, 'bookings').done, true);
  assert.equal(item(r, 'payroll').done, true);
  assert.equal(item(r, 'team').done, true);

  await sqlite(accDb, `${ACC} INSERT INTO contacts (kind, name) VALUES ('customer', 'Sample Customer');
    INSERT INTO documents (side, status, number, contact_id, date) VALUES ('sale', 'quote', 'Q-1', 1, '2026-11-24');`);
  fs.utimesSync(accDb, new Date(), new Date(Date.now() + 10000));
  r = cl.build({ ...base, acc: await cl.accountingFacts(accDb), payroll: pay });
  assert.equal(item(r, 'invoice').done, true);
  // an older company file with no till table still counts its invoices
  const old = await sqlite(path.join(dir, 'old', 'company.db'), `CREATE TABLE contacts (id INTEGER PRIMARY KEY, kind TEXT, name TEXT);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, side TEXT, status TEXT);
    INSERT INTO documents (side, status) VALUES ('sale', 'open');`);
  assert.equal((await cl.accountingFacts(old)).salesDocs, 1);
  // nothing there yet
  assert.deepEqual(await cl.accountingFacts(path.join(dir, 'none', 'company.db')), { found: false });
  assert.deepEqual(await cl.payrollFacts(path.join(dir, 'none', 'payroll.db')), { found: false });
});

test('checklist: sign-in, business details and the plan from company.json and licence.json', () => {
  const appData = tmp();
  let r = cl.build({ company: online.readCompany(appData), lic: licence.read(appData), known: KNOWN, names: NAMES });
  assert.deepEqual(ids(r).slice(0, 3), ['signin', 'details', 'programs']);   // always the first three
  assert.equal(r.items.every((i) => !i.done), true);
  assert.deepEqual(r.items[0].action, { kind: 'wizard' });

  online.writeCompany(appData, { mode: 'local', name: 'Sample Plumbing', phone: '123' });
  r = cl.build({ company: online.readCompany(appData), lic: licence.read(appData), known: KNOWN, names: NAMES });
  assert.equal(item(r, 'signin').done, false);
  assert.equal(item(r, 'details').done, false);
  assert.match(item(r, 'details').hint, /address, email, tax number/);

  online.writeCompany(appData, { mode: 'online', workspace_id: 'w1', address: '1 Main St', email: 'office@example.com', tax_number: '12-345' });
  licence.saveOnline(appData, { modules: { payroll: on('trial'), bookings: on() }, seats: { used: 1 } });
  r = cl.build({ company: online.readCompany(appData), lic: licence.read(appData), known: KNOWN, names: NAMES, installed: ['payroll'] });
  assert.equal(item(r, 'signin').done, true);
  assert.equal(item(r, 'details').done, true);
  assert.equal(item(r, 'programs').done, false);
  assert.deepEqual(r.planMissing.map((x) => x.name), ['Bookings']);
  assert.deepEqual(item(r, 'bookings').action, { kind: 'install', id: 'bookings' });   // not installed: the action installs it
  assert.deepEqual(item(r, 'payroll').action, { kind: 'open', id: 'payroll', page: null });
  r = cl.build({ company: online.readCompany(appData), lic: licence.read(appData), known: KNOWN, names: NAMES, installed: ['payroll', 'bookings'] });
  assert.equal(item(r, 'programs').done, true);
});

test('checklist: only what the business has (relevance)', () => {
  const company = { name: 'Sample Plumbing', mode: 'online' };
  let r = cl.build({ company, lic: {}, known: KNOWN });
  assert.deepEqual(ids(r), ['signin', 'details', 'programs', 'customer', 'invoice', 'team']);
  assert.deepEqual(item(r, 'customer').action, { kind: 'install', id: 'invoices' });   // nothing to bill with yet: free Invoices
  // a person on their own: nobody to invite
  r = cl.build({ company, lic: {}, known: KNOWN, kind: 'personal' });
  assert.equal(ids(r).includes('team'), false);
  // installed programs bring their own steps, and so does the plan
  r = cl.build({ company, lic: {}, known: KNOWN, installed: ['pos', 'accounting-basics'] });
  assert.deepEqual(ids(r).slice(3), ['customer', 'invoice', 'team', 'sale']);
  assert.deepEqual(item(r, 'invoice').action, { kind: 'open', id: 'accounting-basics', page: 'invoice' });
  assert.deepEqual(item(r, 'sale').action, { kind: 'open', id: 'pos', page: 'pos' });
  r = cl.build({ company, lic: { online: { modules: { payroll: on(), bookings: off } } }, known: KNOWN });
  assert.equal(ids(r).includes('payroll'), true);
  assert.equal(ids(r).includes('bookings'), false);   // trial ended: not on the plan
  assert.equal(ids(r).includes('logo'), false);       // Accounting keeps no logo: no such step
  assert.equal(ids(r).includes('deskphone'), false);  // Riyeser Link Office's desk phones: not readable yet
});

test('checklist: skipping counts as done, and everything done says so', () => {
  const company = { name: 'Sample Plumbing', mode: 'online', address: 'a', phone: 'p', email: 'e', tax_number: 't' };
  const lic = { online: { modules: {}, seats: { used: 2 } } };
  const acc = { found: true, customers: 1, salesDocs: 0, posSales: 0, bookingResources: 0 };
  let r = cl.build({ company, lic, known: KNOWN, acc, members: 2 });
  assert.equal(r.done, 5); assert.equal(r.total, 6); assert.equal(r.allDone, false);
  r = cl.build({ company, lic, known: KNOWN, acc, members: 2, skipped: ['invoice', 'customer'] });
  assert.equal(item(r, 'invoice').skipped, true);
  assert.equal(item(r, 'customer').skipped, false);   // done things aren't "skipped"
  assert.equal(r.done, 6); assert.equal(r.allDone, true);
});

test('checklist: demo mode shows no checklist of its own', () => {
  const appData = tmp();
  demo.start(appData);
  const r = cl.build({ demo: demo.isOn(appData), company: { name: 'x', mode: 'online' }, lic: {}, known: KNOWN });
  assert.equal(r.demo, true); assert.deepEqual(r.items, []); assert.equal(r.total, 0); assert.equal(r.allDone, false);
  demo.leave({ appData, folders: [] });
  assert.equal(cl.build({ demo: demo.isOn(appData), lic: {}, known: KNOWN }).demo, false);
});

test('checklist: hide and show persist on this PC; the choice goes to the Riyeser account when signed in', async () => {
  const dir = tmp(); const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push([new URL(url).pathname, opts.method, opts.body ? JSON.parse(opts.body) : null]);
    const res = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    if (url.startsWith(online.CONFIG_URL)) return res(200, 'x');
    if (new URL(url).pathname === '/auth/v1/user') return res(200, { id: 'u1', user_metadata: { riyeser_prefs: { other: 1, ...JSON.parse(opts.body).data.riyeser_prefs } } });
    return res(404, {});
  };
  // config.js answers as text
  const fetchCfg = async (url, opts) => (url.startsWith(online.CONFIG_URL)
    ? { ok: true, status: 200, text: async () => 'window.RIYESER_TEAM={supabaseUrl:"https://x.supabase.co",supabaseKey:"sb_publishable_k"};' } : fetchFn(url, opts));
  const store = new Store(path.join(dir, 'data'));
  const o = new online.Online({ store, fetchFn: fetchCfg, appData: dir });

  // not signed in: kept here only, no call
  assert.equal(cl.isHidden(store, o), false);
  assert.deepEqual(await cl.setHidden(store, o, true), { hidden: true, synced: false });
  assert.equal(calls.length, 0);
  assert.equal(cl.isHidden(new Store(path.join(dir, 'data')), o), true);   // still hidden after a restart
  assert.deepEqual(await cl.setHidden(store, o, false), { hidden: false, synced: false });
  assert.equal(cl.isHidden(new Store(path.join(dir, 'data')), o), false);

  // signed in: PUT /auth/v1/user with {data: {riyeser_prefs: {checklist_hidden}}}, other prefs kept
  o.setSession({ access_token: 'tok', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: 'owner@example.com', user_metadata: { riyeser_prefs: { other: 1 } } } });
  assert.deepEqual(await cl.setHidden(store, o, true), { hidden: true, synced: true });
  const put = calls.find((c) => c[0] === '/auth/v1/user');
  assert.deepEqual([put[1], put[2]], ['PUT', { data: { riyeser_prefs: { other: 1, checklist_hidden: true } } }]);
  assert.equal(o.prefs().checklist_hidden, true);

  // offline: still hidden here, quietly not synced
  const o2 = new online.Online({ store, fetchFn: async (u, x) => { if (u.startsWith(online.CONFIG_URL)) return fetchCfg(u, x); throw new Error('offline'); }, appData: dir });
  assert.deepEqual(await cl.setHidden(store, o2, false), { hidden: false, synced: false });
  assert.equal(cl.isHidden(store, o2), false);

  // never chosen on this PC: follow the account
  const fresh = new Store(path.join(tmp(), 'data'));
  assert.equal(cl.isHidden(fresh, o), true);

  // skip and undo
  assert.deepEqual(cl.setSkipped(store, 'team'), ['team']);
  assert.deepEqual(cl.skippedIds(new Store(path.join(dir, 'data'))), ['team']);
  assert.deepEqual(cl.setSkipped(store, 'team', false), []);
});

test('desk phone item: only with Riyeser Link Office installed, done once a phone is assigned', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const cl = require('../src/central/checklist');
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
  const base = { company: { mode: 'online', name: 'Sample Co' }, lic: {}, installed: ['central'], known: ['central', 'linkoffice'] };
  assert.ok(!cl.build(base).items.some((i) => i.id === 'deskphone'), 'not shown without Link');
  const withLink = { ...base, installed: ['central', 'linkoffice'] };
  assert.deepEqual(cl.linkFacts(appData), { found: false, phones: 0 });
  let item = cl.build({ ...withLink, link: cl.linkFacts(appData) }).items.find((i) => i.id === 'deskphone');
  assert.ok(item && !item.done);
  fs.mkdirSync(path.join(appData, 'Riyeser Link Office', 'data'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Riyeser Link Office', 'data', 'phone-devices.json'), JSON.stringify({ phones: [{ mac: '001565aabbcc', ext: '101' }], found: [] }));
  item = cl.build({ ...withLink, link: cl.linkFacts(appData) }).items.find((i) => i.id === 'deskphone');
  assert.ok(item.done);
});
