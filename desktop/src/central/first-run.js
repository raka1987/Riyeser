// Riyeser Central's first run, "One installer": sign in, and Central installs every program on the business's plan by
// itself, one after another, with Windows' permission asked once (the programs that install for the whole PC are run
// together, at the end, through one permission prompt). Then "Your business" and "Done".
//
//   - A business (signed in to an organisation): the plan's programs install automatically. On a second PC of the same
//     business the same plan installs, filtered by "What is this PC for?" (Office PC / Till / Reception / Everything).
//   - Someone on their own (a personal account, no account, or "Set up later"): they tick the free and trial programs
//     they want, those install, done. No business set-up is asked of them.
//
// Plain data and an injected install driver, so the tests and the Windows runner drive the same code as Central.
const checklist = require('./checklist');
const updates = require('./updates');

// One order everywhere (the same as Central's home screen and riyeser.com).
const ORDER = ['desk', 'invoices', 'pdf', 'accounting-basics', 'accounting', 'bookings', 'estimate', 'team', 'linkoffice', 'payroll', 'pos', 'services'];
const byOrder = (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b);
// Free for everyone, so every business PC gets them with its plan.
const FREE = ['desk', 'pdf'];

/** "What is this PC for?" Each keeps only the programs that PC needs (null: everything on the plan). */
const ROLES = [
  { id: 'office', title: 'Office PC', sub: 'Accounts, payroll, documents and phones. Everything except the till.', keep: (id) => id !== 'pos' },
  { id: 'till', title: 'Till', sub: 'The POS till, and Riyeser Link to message the office.', keep: (id) => ['pos', 'team'].includes(id) },
  { id: 'reception', title: 'Reception', sub: 'Bookings, the phones and Riyeser Link.', keep: (id) => ['bookings', 'team', 'linkoffice', 'desk'].includes(id) },
  { id: 'everything', title: 'Everything', sub: 'Every program on your plan.', keep: () => true },
];
const roleOf = (id) => ROLES.find((r) => r.id === id) || ROLES.find((r) => r.id === 'everything');

/** The programs on the business's plan (licence.json "online".modules), plus the free ones, in Central's order. */
function planPrograms(lic) {
  const mods = checklist.planModules(lic);
  const ids = new Set(FREE);
  for (const m of mods) for (const id of checklist.MODULE_PROGRAMS[m] || []) ids.add(id);
  if (ids.has('accounting')) ids.delete('accounting-basics');   // Accounting Plus covers Basics
  // Free Invoices only when no Accounting app is on the plan (Accounting does invoices).
  if (!ids.has('accounting') && !ids.has('accounting-basics')) ids.add('invoices');
  return [...ids].filter((id) => ORDER.includes(id)).sort(byOrder);
}

/** The plan for this PC: filtered by what it's for. */
function forRole(ids, role) { const r = roleOf(role); return (ids || []).filter((id) => r.keep(id)); }

/** What someone on their own can pick (free and trial programs; the office phone system is for businesses). */
const INDIVIDUAL = ORDER.filter((id) => id !== 'linkoffice');
const INDIVIDUAL_DEFAULT = ['invoices', 'desk', 'pdf'];

/**
 * Which first run: 'plan' (signed in to a business: its plan installs by itself) or 'individual' (pick programs).
 * company: company.json; kind: 'personal' | 'business' | null (from Riyeser online).
 */
function pathFor({ company, kind } = {}) {
  const c = company || {};
  if (c.mode !== 'online' || !c.workspace_id) return 'individual';
  if ((kind || c.kind) === 'personal') return 'individual';
  return 'plan';
}

/**
 * The install queue: per-user programs first (no permission needed), then the ones that install for the whole PC, so
 * those run together at the end through one Windows permission prompt. Programs already on this PC are skipped.
 * ids: program ids; installed: ids on this PC; products: updates.PRODUCTS (elevate, display name).
 */
function buildQueue(ids, { installed = [], products = updates.PRODUCTS, names = {} } = {}) {
  const have = new Set(installed);
  const items = [...new Set(ids || [])].filter((id) => products.some((p) => p.id === id && !p.self)).sort(byOrder).map((id) => {
    const p = products.find((x) => x.id === id);
    return { id, name: names[id] || p.display, elevate: !!p.elevate, stage: have.has(id) ? 'skipped' : 'waiting', pct: have.has(id) ? 1 : 0 };
  });
  return [...items.filter((i) => !i.elevate), ...items.filter((i) => i.elevate)];
}

/** A new run (kept in Central's store as "first-run", so it carries on after a restart or once back online). */
function newRun({ path = 'plan', role = 'everything', ids = [], installed = [], products, names, now = Date.now() } = {}) {
  return { v: 1, path, role, ids: [...ids], items: buildQueue(ids, { installed, products, names }), step: 'install', startedAt: now, updatedAt: now, finished: false };
}

/** Choose programs instead: the run keeps what it already did for the programs still ticked. */
function choose(run, ids, { installed = [], products, names } = {}) {
  const keep = new Map((run.items || []).map((i) => [i.id, i]));
  const items = buildQueue(ids, { installed, products, names }).map((i) => (keep.has(i.id) && i.stage !== 'skipped' ? { ...keep.get(i.id) } : i));
  return { ...run, ids: [...ids], items, finished: false };
}

/** Try again: the failed (or paused) programs, or just the ones named, go back in the queue. */
function retry(run, ids = null) {
  const items = (run.items || []).map((i) => ((ids ? ids.includes(i.id) : ['failed', 'paused'].includes(i.stage)) && !['installed', 'skipped'].includes(i.stage)
    ? { id: i.id, name: i.name, elevate: i.elevate, stage: 'waiting', pct: 0 } : i));
  return { ...run, items, finished: false };
}

const DONE = ['installed', 'skipped'];
/** Where a run stands: counts, and whether there's anything left to do. */
function summary(run) {
  const items = (run && run.items) || [];
  const of = (s) => items.filter((i) => i.stage === s).map((i) => i.id);
  const done = items.filter((i) => DONE.includes(i.stage)).length;
  return { total: items.length, done, installed: of('installed'), skipped: of('skipped'), failed: of('failed'), paused: of('paused'),
    waiting: items.filter((i) => !DONE.includes(i.stage) && !['failed', 'paused'].includes(i.stage)).map((i) => i.id),
    allDone: items.length > 0 && done === items.length, needsPermission: items.filter((i) => i.elevate && !DONE.includes(i.stage)).map((i) => i.id) };
}

/** How full a program's bar is (0..1): downloading fills most of it, then checking, installing, finishing. */
function barPct(i) {
  switch (i && i.stage) {
    case 'downloading': return 0.04 + 0.66 * Math.max(0, Math.min(1, Number(i.pct) || 0));
    case 'checking': return 0.72;
    case 'ready': return 0.75;
    case 'installing': return 0.85;
    case 'verifying': return 0.95;
    case 'installed': case 'skipped': return 1;
    case 'failed': case 'paused': return Math.max(0, Math.min(0.7, Number(i.pct) || 0));
    default: return 0;
  }
}
/** A program's line, in plain words. */
function itemText(i) {
  switch (i && i.stage) {
    case 'waiting': return 'Waiting';
    case 'downloading': return `Downloading… ${Math.round((Number(i.pct) || 0) * 100)}%`;
    case 'checking': return 'Checking the download…';
    case 'ready': return 'Downloaded. Waiting for Windows\' permission';
    case 'installing': return i.elevate ? 'Installing… Windows asks for permission once: choose Yes' : 'Installing…';
    case 'verifying': return 'Finishing…';
    case 'installed': return 'Installed';
    case 'skipped': return 'Already on this PC';
    case 'paused': return 'Waiting for the internet';
    case 'failed': return i.message || 'Install failed.';
    default: return '';
  }
}

const OFFLINE = { reason: 'offline', message: 'No internet connection right now.', fix: 'Central carries on by itself when this PC is back online.' };
/** Network errors that mean "offline" rather than "this download failed". */
const isOffline = (e) => !!(e && (e.offline || (e.failure && e.failure.reason === 'offline')
  || /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|ERR_ADDRESS_UNREACHABLE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ERR_PROXY_CONNECTION_FAILED/.test(String((e && (e.code || '')) + ' ' + (e && e.message)))));
const failureOf = (e) => (isOffline(e) ? { ...OFFLINE } : (e && e.failure) || { reason: 'failed', message: (e && e.message) || 'Install failed.', fix: 'Try again. If it happens again, click Get help.' });
// A download that broke half way is tried once more by itself before it's shown as failed.
const RETRY_BY_ITSELF = new Set(['download', 'check-damaged']);

/**
 * Install everything still to do in the run, one after another. Never throws; resolves summary(run).
 * driver:
 *   fetch(item, onPct) -> { file, version, ... }      download and check one installer (throws an Error with .failure / offline)
 *   install(item, got) -> void                         run a per-user installer (throws with .failure)
 *   installBatch([{ item, got }]) -> { id: failure|null }   the whole-PC installers together, one permission prompt
 *   verify(item) -> bool                               is it really on this PC now?
 *   cleanup(got)                                       (optional) remove the downloaded file
 *   isOnline() -> bool                                 (optional)
 * onChange(run, id): after every step (Central saves the run and tells the window).
 */
async function runQueue(run, driver, { onChange = () => {}, retries = 1, now = Date.now } = {}) {
  const set = (id, patch) => {
    run.items = run.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
    run.updatedAt = now(); onChange(run, id);
  };
  const item = (id) => run.items.find((i) => i.id === id);
  const fail = (id, f) => set(id, { stage: f.reason === 'offline' ? 'paused' : 'failed', reason: f.reason, message: f.message, fix: f.fix || '', code: f.code ?? null });
  const todo = run.items.filter((i) => !DONE.includes(i.stage)).map((i) => i.id);
  const held = [];
  let offline = driver.isOnline && driver.isOnline() === false;
  const tidy = (got) => { try { if (driver.cleanup && got) driver.cleanup(got); } catch { /* temp file */ } };
  const verify = async (id, got) => {
    set(id, { stage: 'verifying' });
    let ok = false; try { ok = await driver.verify(item(id)); } catch { ok = false; }
    if (ok) set(id, { stage: 'installed', pct: 1, reason: null, message: '', fix: '' });
    else fail(id, { reason: 'not-found', message: `The installer finished, but Central can't find ${item(id).name} on this PC.`, fix: 'Click Try again, or Get help.' });
    tidy(got);
  };

  for (const id of todo) {
    if (offline) { fail(id, OFFLINE); continue; }
    let got = null;
    for (let attempt = 0; ; attempt++) {
      set(id, { stage: 'downloading', pct: 0, reason: null, message: '', fix: '', attempts: attempt });
      try { got = await driver.fetch(item(id), (pct) => set(id, { stage: 'downloading', pct }), () => set(id, { stage: 'checking' })); break; } catch (e) {
        const f = failureOf(e);
        if (f.reason === 'offline') { offline = true; fail(id, f); break; }
        if (attempt < retries && RETRY_BY_ITSELF.has(f.reason)) continue;
        fail(id, f); break;
      }
    }
    if (!got) continue;
    if (got.version) set(id, { version: got.version });
    if (item(id).elevate) { set(id, { stage: 'ready' }); held.push({ id, got }); continue; }
    set(id, { stage: 'installing' });
    try { await driver.install(item(id), got); } catch (e) { fail(id, failureOf(e)); tidy(got); continue; }
    await verify(id, got);
  }

  // The programs that install for the whole PC: together, through one Windows permission prompt.
  if (held.length) {
    for (const h of held) set(h.id, { stage: 'installing' });
    let res = {};
    try { res = (await driver.installBatch(held.map((h) => ({ item: item(h.id), got: h.got })))) || {}; } catch (e) {
      const f = failureOf(e); res = Object.fromEntries(held.map((h) => [h.id, f]));
    }
    for (const h of held) {
      const f = res[h.id];
      if (f && f.ok === false) { fail(h.id, f); tidy(h.got); } else await verify(h.id, h.got);
    }
  }
  const s = summary(run);
  run.finished = s.allDone;
  run.updatedAt = now(); onChange(run, null);
  return s;
}

/** The program to open first when it's all done: the one that PC is mostly for. */
function mainProgram(ids, role) {
  const have = (id) => (ids || []).includes(id);
  const pref = role === 'till' ? ['pos'] : role === 'reception' ? ['bookings', 'linkoffice'] : [];
  return [...pref, 'accounting', 'accounting-basics', 'invoices', 'pos', 'bookings', 'payroll', 'estimate', 'desk', 'pdf', 'team', 'linkoffice', 'services'].find(have) || null;
}

/** "Your business": the currencies offered (the business's country picks the first one). */
const CURRENCIES = [['FJD', 'Fiji dollar'], ['AUD', 'Australian dollar'], ['NZD', 'New Zealand dollar'], ['WST', 'Samoan tālā'], ['TOP', 'Tongan paʻanga'],
  ['VUV', 'Vanuatu vatu'], ['PGK', 'Papua New Guinean kina'], ['SBD', 'Solomon Islands dollar'], ['USD', 'US dollar']];
const COUNTRY_CURRENCY = { Fiji: 'FJD', Australia: 'AUD', 'New Zealand': 'NZD', Samoa: 'WST', Tonga: 'TOP', Vanuatu: 'VUV', 'Papua New Guinea': 'PGK', 'Solomon Islands': 'SBD' };
const currencyFor = (country) => COUNTRY_CURRENCY[country] || 'USD';

module.exports = { ORDER, FREE, ROLES, roleOf, planPrograms, forRole, INDIVIDUAL, INDIVIDUAL_DEFAULT, pathFor, buildQueue, newRun, choose, retry,
  summary, barPct, itemText, runQueue, isOffline, failureOf, OFFLINE, mainProgram, CURRENCIES, COUNTRY_CURRENCY, currencyFor };
