// Riyeser Central reads (never writes) what the other Riyeser programs keep on this PC:
//  - Riyeser Desk Assistant: to-do list, calendars, settings and the file search index (%APPDATA%\Desk Assistant\data)
//  - Riyeser Accounting: invoices and bills still to be paid (~/.riyeser/company.db)
//  - Riyeser Payroll: the last pay run (%APPDATA%\Riyeser Payroll\payroll\payroll.db)
//  - Windows: recently opened documents (%APPDATA%\Microsoft\Windows\Recent)
const fs = require('fs');
const path = require('path');
const os = require('os');

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

/** Desk Assistant's saved data (read-only). */
function deskAssistant(dataDir) {
  return {
    dataDir,
    found: fs.existsSync(dataDir),
    settings: readJson(path.join(dataDir, 'settings.json'), {}),
    tasks: readJson(path.join(dataDir, 'tasks.json'), []),
    indexFile: path.join(dataDir, 'index.json'),
  };
}

/** Where Riyeser Accounting keeps its books (same rules as the accounting app: RIYESER_DB, RIYESER_HOME, ~/.riyeser). */
function accountingDbPath(env = process.env) {
  if (env.RIYESER_DB) return env.RIYESER_DB;
  return path.join(env.RIYESER_HOME || path.join(os.homedir(), '.riyeser'), 'company.db');
}

let sqlPromise = null;
function sqlJs() {
  if (!sqlPromise) {
    const init = require('sql.js/dist/sql-wasm.js');
    const packed = require.resolve('sql.js/dist/sql-wasm.wasm');
    const unpacked = packed.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const wasm = fs.existsSync(unpacked) ? unpacked : packed;
    sqlPromise = init({ locateFile: () => wasm });
  }
  return sqlPromise;
}

/**
 * Money still owed, from the accounting company file: invoices customers haven't paid and bills still to pay.
 * Amounts are in dollars. Returns { found, company, receivables: [...], payables: [...], totals } or { found:false }.
 */
async function pendingPayments(dbPath = accountingDbPath(), { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!fs.existsSync(dbPath)) return { found: false, dbPath };
  // Accounting may be in the middle of saving: wait for its journal file to go away rather than read half a change.
  for (let i = 0; i < 10 && fs.existsSync(`${dbPath}-journal`); i++) await new Promise((r) => setTimeout(r, 200));
  const SQL = await sqlJs();
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
  try {
    const rows = (sql, params = []) => { const st = db.prepare(sql); st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
    const company = (rows('SELECT name FROM company WHERE id = 1')[0] || {}).name || null;
    const open = rows(`SELECT d.side, d.number, c.name AS contact, d.date, d.due_date AS due, (d.total - d.amount_paid) AS owing
      FROM documents d JOIN contacts c ON c.id = d.contact_id
      WHERE d.status = 'open' AND d.total > d.amount_paid ORDER BY COALESCE(d.due_date, d.date)`);
    const shape = (r) => ({ number: r.number, contact: r.contact, date: r.date, due: r.due || null, owing: r.owing / 100, overdue: !!(r.due && r.due < today) });
    const receivables = open.filter((r) => r.side === 'sale').map(shape);
    const payables = open.filter((r) => r.side === 'purchase').map(shape);
    const sum = (list) => Math.round(list.reduce((n, r) => n + r.owing, 0) * 100) / 100;
    return {
      found: true, dbPath, company, receivables, payables,
      totals: {
        owedToYou: sum(receivables), overdueToYou: sum(receivables.filter((r) => r.overdue)),
        youOwe: sum(payables), overdueYouOwe: sum(payables.filter((r) => r.overdue)),
      },
    };
  } finally { db.close(); }
}

/** Where Riyeser Payroll keeps its records. */
function payrollDbPath(appData) { return path.join(appData, 'Riyeser Payroll', 'payroll', 'payroll.db'); }

/**
 * The most recent pay run in Riyeser Payroll: { found, lastRun: { pay_date, total_net, employees } | null }.
 * Payroll writes through a -wal file; a run saved in the last few moments may only show once Payroll tidies that up
 * (it does when it closes), which is fine for a home screen.
 */
async function lastPayRun(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return { found: false, lastRun: null };
  const SQL = await sqlJs();
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
  try {
    const st = db.prepare(`SELECT r.pay_date, r.total_net, (SELECT COUNT(*) FROM payslips p WHERE p.run_id = r.id) AS employees
      FROM payroll_runs r ORDER BY r.pay_date DESC, r.id DESC LIMIT 1`);
    const row = st.step() ? st.getAsObject() : null; st.free();
    // The next pay run: the last one's pay date plus the length of its pay period (weekly, fortnightly…), when known.
    let nextRun = null;
    try {
      const p = db.prepare('SELECT period_start, period_end, pay_date FROM payroll_runs ORDER BY pay_date DESC, id DESC LIMIT 1');
      const r = p.step() ? p.getAsObject() : null; p.free();
      nextRun = r ? nextPayRun(r) : null;
    } catch { /* an older Payroll without pay periods */ }
    return { found: true, lastRun: row ? { pay_date: row.pay_date, total_net: Number(row.total_net) || 0, employees: Number(row.employees) || 0 } : null, nextRun };
  } finally { db.close(); }
}

/** The next pay date after a run: { pay_date } one pay period (period_start..period_end, 7 to 31 days) later, or null. */
function nextPayRun(r) {
  const d = (v) => new Date(`${String(v || '').slice(0, 10)}T12:00:00Z`);
  const len = Math.round((d(r.period_end) - d(r.period_start)) / 86400000) + 1;
  if (!r.pay_date || !Number.isFinite(len) || len < 7 || len > 31) return null;
  const next = d(r.pay_date);
  if (len >= 28) next.setUTCMonth(next.getUTCMonth() + 1); else next.setUTCDate(next.getUTCDate() + len);
  return { pay_date: next.toISOString().slice(0, 10), periodDays: len };
}

/** Customers whose name (or contact person or email) has every word typed, from the books (read-only copy). */
async function findCustomers(dbPath, q, { limit = 8 } = {}) {
  const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length || !dbPath || !fs.existsSync(dbPath)) return [];
  const SQL = await sqlJs();
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
  try {
    const where = words.map(() => "(lower(name) LIKE ? OR lower(coalesce(contact_person,'')) LIKE ? OR lower(coalesce(email,'')) LIKE ?)").join(' AND ');
    const st = db.prepare(`SELECT name, contact_person, email, phone FROM contacts WHERE kind = 'customer' AND active = 1 AND ${where} ORDER BY name LIMIT ${Math.max(1, Math.min(20, limit))}`);
    st.bind(words.flatMap((w) => [`%${w}%`, `%${w}%`, `%${w}%`]));
    const out = []; while (st.step()) { const r = st.getAsObject(); out.push({ name: r.name, contact: r.contact_person || '', email: r.email || '', phone: r.phone || '' }); }
    st.free();
    return out;
  } catch { return []; } finally { db.close(); }
}

/** How many documents wait in Riyeser Documents' Inbox (files in <library>\_Inbox). null when it can't be seen (a network library isn't looked at). */
function inboxCount(root) {
  if (!root || /^\\\\|^\/\//.test(root)) return null;
  try { return fs.readdirSync(path.join(root, '_Inbox'), { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.') && !/^~\$|\.tmp$/i.test(e.name)).length; } catch { return null; }
}

const PERSONAL_EXT = /\.(pdf|docx?|xlsx?|xlsm|csv|pptx?|txt|rtf|odt|ods|jpe?g|png|heic|dwg|dxf|msg|eml|zip)$/i;
/**
 * Recently opened documents. readLink(lnkPath) -> target path (Electron's shell.readShortcutLink on Windows).
 * Falls back to the newest files in Desk Assistant's search index.
 */
function recentDocuments({ recentDir, readLink, indexDocs = {}, limit = 15 } = {}) {
  const out = []; const seen = new Set();
  if (recentDir && readLink && fs.existsSync(recentDir)) {
    let links = [];
    try { links = fs.readdirSync(recentDir).filter((f) => f.toLowerCase().endsWith('.lnk')).map((f) => path.join(recentDir, f)); } catch { /* none */ }
    links = links.map((l) => { try { return { l, t: fs.statSync(l).mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.t - a.t);
    for (const { l, t } of links) {
      if (out.length >= limit) break;
      let target; try { target = readLink(l); } catch { continue; }
      if (!target || seen.has(target.toLowerCase()) || !PERSONAL_EXT.test(target)) continue;
      try { if (!fs.statSync(target).isFile()) continue; } catch { continue; }
      seen.add(target.toLowerCase());
      out.push({ path: target, name: path.basename(target), dir: path.dirname(target), when: t, source: 'opened' });
    }
  }
  if (out.length < limit) {
    const newest = Object.entries(indexDocs).sort((a, b) => b[1].mtime - a[1].mtime);
    for (const [p, d] of newest) {
      if (out.length >= limit) break;
      if (seen.has(p.toLowerCase()) || !fs.existsSync(p)) continue;
      seen.add(p.toLowerCase());
      out.push({ path: p, name: d.name, dir: d.dir, when: d.mtime, source: 'saved' });
    }
  }
  return out;
}

module.exports = { deskAssistant, accountingDbPath, pendingPayments, payrollDbPath, lastPayRun, nextPayRun, findCustomers, inboxCount, recentDocuments, readJson };
