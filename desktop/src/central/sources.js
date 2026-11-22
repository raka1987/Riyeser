// Riyeser Central reads (never writes) what the other Riyeser programs keep on this PC:
//  - Riyeser Desk Assistant: to-do list, calendars, settings and the file search index (%APPDATA%\Desk Assistant\data)
//  - Riyeser Accounting: invoices and bills still to be paid (~/.riyeser/company.db)
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

module.exports = { deskAssistant, accountingDbPath, pendingPayments, recentDocuments, readJson };
