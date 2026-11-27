// Riyeser Central's "Getting started with Riyeser" checklist, and the programs on the company's plan that aren't
// installed yet. Every item ticks itself from real records on this PC; nothing here ever writes to another program's
// files. The Accounting and Payroll files are opened as copies in memory (sql.js), so they're never changed or locked.
const fs = require('fs');

// ---------- the plan (licence.json "online".modules) -> programs ----------
// The same names Central uses everywhere: basic = Accounting Basics, plus = Accounting Plus, calls = Riyeser Link:
// the Riyeser Link app (program id still "team") and Riyeser Link Office (id "linkoffice", once it's in Central's PROGRAMS),
// as_built = As Built (its program id is still "services").
const MODULE_PROGRAMS = { basic: ['accounting-basics'], plus: ['accounting'], pos: ['pos'], bookings: ['bookings'], payroll: ['payroll'], estimate: ['estimate'],
  calls: ['team', 'linkoffice'], as_built: ['services'] };

/** Module ids that are on the plan right now (active, which includes a running free trial). */
function planModules(lic) {
  const mods = (lic && lic.online && lic.online.modules) || {};
  // A trial that starts on first use (Riyeser Estimate) isn't on the plan until the business has used it.
  return Object.keys(MODULE_PROGRAMS).filter((m) => mods[m] && mods[m].active === true && !(mods[m].starts_on_first_use && !mods[m].trial_ends));
}

/**
 * Programs on the plan that aren't installed yet, in Central's order.
 * known: the program ids Central knows about (so "linkoffice" only appears once Central has it); installed: ids installed.
 * names: id -> display name. Accounting Plus covers Accounting Basics.
 */
function planToInstall(lic, { known = [], installed = [], names = {} } = {}) {
  const have = new Set(installed); const out = [];
  for (const m of planModules(lic)) {
    for (const id of MODULE_PROGRAMS[m]) {
      if (!known.includes(id) || have.has(id) || out.some((x) => x.id === id)) continue;
      if (id === 'accounting-basics' && (have.has('accounting') || planModules(lic).includes('plus'))) continue;
      out.push({ id, module: m, name: names[id] || id });
    }
  }
  return out.sort((a, b) => known.indexOf(a.id) - known.indexOf(b.id));
}

// ---------- reading the other programs' records (read-only, cheap) ----------
let sqlPromise = null;
function sqlJs() {
  if (!sqlPromise) {
    const init = require('sql.js/dist/sql-wasm.js');
    const packed = require.resolve('sql.js/dist/sql-wasm.wasm');
    const path = require('path');
    const unpacked = packed.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    sqlPromise = init({ locateFile: () => (fs.existsSync(unpacked) ? unpacked : packed) });
  }
  return sqlPromise;
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took too long`)), ms).unref?.())]);

/** Open a copy of a SQLite file and run count queries; a missing table counts as 0. */
async function counts(dbPath, queries) {
  const SQL = await sqlJs();
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
  try {
    const out = {};
    for (const [k, sql] of Object.entries(queries)) {
      try { const st = db.prepare(sql); out[k] = st.step() ? Number(st.get()[0]) || 0 : 0; st.free(); } catch { out[k] = 0; }
    }
    return out;
  } finally { db.close(); }
}

const cache = new Map();   // path -> { mtime, size, facts }: the file is only read again when it changes
async function cached(dbPath, read) {
  let st; try { st = fs.statSync(dbPath); } catch { return { found: false }; }
  const hit = cache.get(dbPath);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.facts;
  const facts = { found: true, ...(await withTimeout(read(), 4000, 'Reading your records')) };
  cache.set(dbPath, { mtime: st.mtimeMs, size: st.size, facts });
  return facts;
}

/** Accounting's company file (shared by Accounting, Invoices, POS and Bookings). */
function accountingFacts(dbPath) {
  return cached(dbPath, () => counts(dbPath, {
    customers: "SELECT COUNT(*) FROM contacts WHERE kind = 'customer'",
    // invoices and quotes, not till sales (the till makes a sale document for each sale too)
    salesDocs: "SELECT COUNT(*) FROM documents d WHERE d.side = 'sale' AND d.status IN ('quote','order','open','paid') AND NOT EXISTS (SELECT 1 FROM pos_sales s WHERE s.document_id = d.id)",
    salesDocsAll: "SELECT COUNT(*) FROM documents WHERE side = 'sale' AND status IN ('quote','order','open','paid')",   // older files with no till
    posSales: 'SELECT COUNT(*) FROM pos_sales WHERE voided = 0',
    bookingResources: 'SELECT COUNT(*) FROM booking_resources WHERE active = 1',
  })).then((f) => (f.found ? { ...f, salesDocs: f.salesDocs || (f.posSales ? 0 : f.salesDocsAll) } : f));
}

/** Riyeser Payroll: staff other than the built-in admin login. */
function payrollFacts(dbPath) {
  return cached(dbPath, () => counts(dbPath, { staff: "SELECT COUNT(*) FROM users WHERE active = 1 AND username <> 'admin'" }));
}

// ---------- the checklist ----------
const filled = (v) => v != null && String(v).trim() !== '';
const DETAIL_KEYS = ['name', 'address', 'phone', 'email', 'tax_number'];

/**
 * The checklist. Plain data in, plain data out, so it can be tested without Electron.
 *   company: company.json | null; lic: licence.json; demo: true in demo mode; installed: ids installed; known: ids Central knows;
 *   names: id -> name; acc / payroll: facts from the readers above; kind: 'personal' | 'business' | null;
 *   members: people in the company online (null when unknown); skipped: ids skipped; hidden: the card is hidden.
 */
/** Riyeser Link Office's desk phones, from its settings file (%APPDATA%\\Riyeser Link Office\\data\\phone-devices.json). Read-only. */
function linkFacts(appData) {
  try {
    const d = JSON.parse(require('fs').readFileSync(require('path').join(appData, 'Riyeser Link Office', 'data', 'phone-devices.json'), 'utf8')) || {};
    return { found: true, phones: Array.isArray(d.phones) ? d.phones.length : 0 };
  } catch { return { found: false, phones: 0 }; }
}

function build({ company = null, lic = {}, demo = false, installed = [], known = [], names = {}, acc = {}, payroll = {}, link = {}, kind = null,
  members = null, skipped = [], hidden = false } = {}) {
  if (demo) return { demo: true, hidden, items: [], done: 0, total: 0, allDone: false, planMissing: [] };
  const has = (id) => installed.includes(id);
  const plan = planModules(lic);
  const onPlan = (m) => plan.includes(m);
  const planMissing = planToInstall(lic, { known, installed, names });
  const accApp = has('accounting') ? 'accounting' : has('accounting-basics') ? 'accounting-basics' : has('invoices') ? 'invoices' : null;
  const run = (id, page) => (has(id) ? { kind: 'open', id, page: page || null } : { kind: 'install', id });
  const c = company || {};
  const items = [];
  const add = (id, title, hint, done, action) => items.push({ id, title, hint, done: !!done, action });

  add('signin', 'Sign in with your Riyeser account', 'One account for every Riyeser program, so your details fill themselves in.',
    c.mode === 'online', { kind: 'wizard' });
  const missing = DETAIL_KEYS.filter((k) => !filled(c[k]));
  add('details', 'Check your business details',
    missing.length && company ? `Still to add: ${missing.map((k) => ({ name: 'business name', address: 'address', phone: 'phone', email: 'email', tax_number: 'tax number' }[k])).join(', ')}.` : 'Your name, address, phone, email and tax number go on every invoice.',
    !!company && !missing.length, { kind: 'view', view: 'company' });
  add('programs', 'Install the programs on your plan',
    !lic || !lic.online ? 'Sign in first and we\'ll know which programs are on your plan.' : planMissing.length ? `Still to install: ${planMissing.map((p) => p.name).join(', ')}.` : 'Everything on your plan is installed.',
    !!(lic && lic.online) && !planMissing.length, { kind: 'view', view: 'apps' });
  // (No "Add your logo" item: Riyeser Accounting doesn't keep a company logo yet.)

  const books = { found: false, ...(acc || {}) };
  add('customer', 'Add your first customer', 'Their name and email, so invoices go straight to them.',
    books.found && books.customers > 0, accApp ? { kind: 'open', id: accApp } : { kind: 'install', id: 'invoices' });
  add('invoice', 'Send your first invoice or quote', 'Make one, check it, send it. Getting paid starts here.',
    books.found && books.salesDocs > 0, accApp ? { kind: 'open', id: accApp, page: 'invoice' } : { kind: 'install', id: 'invoices' });
  if (kind !== 'personal') {
    add('team', 'Invite the people who help you', 'Staff, family or your bookkeeper. They chat with you in Riyeser Link.',
      members != null && members > 1, { kind: 'team' });
  }
  if (onPlan('payroll') || has('payroll')) {
    add('payroll', 'Add your staff to Payroll', 'Their pay rate and bank details, ready for your first pay run.',
      payroll && payroll.found && payroll.staff > 0, run('payroll'));
  }
  if (onPlan('bookings') || has('bookings')) {
    add('bookings', 'Set up Bookings', 'Add who or what gets booked: staff, rooms, tables or vans.',
      books.found && books.bookingResources > 0, run('bookings'));
  }
  if (onPlan('pos') || has('pos')) {
    add('sale', 'Make your first sale', 'Open the till and ring something up.', books.found && books.posSales > 0, run('pos', 'pos'));
  }
  if (has('linkoffice')) {
    add('deskphone', 'Connect a desk phone to Riyeser Link Office', 'Plug a desk phone into the office network. Riyeser Link Office finds it, then you choose who it\'s for.',
      !!(link && link.found && link.phones > 0), run('linkoffice'));
  }

  for (const it of items) it.skipped = !it.done && skipped.includes(it.id);
  const done = items.filter((i) => i.done || i.skipped).length;
  return { demo: false, hidden, items, done, total: items.length, allDone: done === items.length, planMissing };
}

// ---------- hide / show and skip, kept in Central's store ("checklist.json") ----------
const prefsOf = (store) => store.get('checklist', {}) || {};
/** Hidden on this PC? The choice made here wins; otherwise what the Riyeser account says (riyeser_prefs.checklist_hidden). */
function isHidden(store, online) {
  const s = prefsOf(store);
  if (typeof s.hidden === 'boolean') return s.hidden;
  try { return !!(online && online.prefs().checklist_hidden === true); } catch { return false; }
}
/** Hide or show the card here, then with the Riyeser account when signed in. Offline is fine: synced is just false. */
async function setHidden(store, online, hidden) {
  store.update('checklist', {}, (o) => ({ ...(o || {}), hidden: !!hidden }));
  let synced = false;
  try { synced = !!(online && online.session && await online.savePrefs({ checklist_hidden: !!hidden })); } catch { synced = false; }
  return { hidden: !!hidden, synced };
}
function setSkipped(store, id, skip = true) {
  const o = prefsOf(store); const s = new Set(o.skipped || []);
  if (skip) s.add(String(id)); else s.delete(String(id));
  store.set('checklist', { ...o, skipped: [...s] });
  return [...s];
}
const skippedIds = (store) => prefsOf(store).skipped || [];

module.exports = { isHidden, setHidden, setSkipped, skippedIds, MODULE_PROGRAMS, planModules, planToInstall, accountingFacts, payrollFacts, linkFacts, build, counts, _cache: cache };
