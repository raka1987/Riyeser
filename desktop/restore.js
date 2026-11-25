// Restoring payroll records (OWNER-RESTORE), kept apart from main.js so it can be tested without Electron:
// check and copy a records file, describe it, and find the records Riyeser Central put away in a fresh start.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// A payroll records file (a backup, an archive, or an earlier program's records) copied in as one complete file:
// changes still in its -wal companion are included, and it must really be a payroll records file. Archive and
// fresh-start copies can be read-only, so the working copy is made writable before it's opened.
function payrollCopy(src, dest, tmpRoot = os.tmpdir()) {
  if (!src || !fs.existsSync(src)) throw new Error("That file isn't there any more.");
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'riyeser-in-'));
  try {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(src + ext)) { const t = path.join(tmp, 'in.db' + ext); fs.copyFileSync(src + ext, t); fs.chmodSync(t, 0o644); }
    let d; try { d = new DatabaseSync(path.join(tmp, 'in.db')); } catch { throw new Error("That file can't be opened as payroll records."); }
    try {
      let t; try { t = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'timesheets', 'settings')").all(); } catch { t = []; }
      if (t.length < 3) throw new Error("That file isn't payroll records. Choose a backup (payroll-….db) or a records file (payroll.db).");
      fs.rmSync(dest, { force: true });
      d.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    } finally { d.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
// what's in a records file, in plain words (null if it can't be read)
function summary(file) {
  let d; try { d = new DatabaseSync(file, { readOnly: true }); } catch { return null; }
  try {
    const n = q => { try { return d.prepare(q).get().n; } catch { return 0; } };
    return { staff: n('SELECT COUNT(*) AS n FROM users'), shifts: n('SELECT COUNT(*) AS n FROM timesheets'), runs: n('SELECT COUNT(*) AS n FROM payroll_runs'), history: n('SELECT COUNT(*) AS n FROM pay_history') };
  } catch { return null; } finally { d.close(); }
}
const describe = s => s ? `${s.staff} staff, ${s.shifts} shifts, ${s.runs} pay runs, ${s.history} weeks of pay history` : '';
// Riyeser Central's "Fresh start on this PC" renames %APPDATA%\Riyeser Payroll to
// "Riyeser Payroll (before fresh start 2026-11-24 0912)": its records are in payroll\payroll.db. Newest first.
function freshStartRecords(userData) {
  const parent = path.dirname(userData), base = path.basename(userData);
  let names = []; try { names = fs.readdirSync(parent); } catch { return []; }
  return names.filter(n => n.startsWith(`${base} (before fresh start `) && n.endsWith(')'))
    .map(n => ({ name: n, when: n.slice(base.length + ' (before fresh start '.length, -1), file: path.join(parent, n, 'payroll', 'payroll.db') }))
    .filter(x => fs.existsSync(x.file)).map(x => ({ ...x, sum: summary(x.file) })).filter(x => x.sum && (x.sum.runs || x.sum.shifts || x.sum.staff > 1 || x.sum.history))
    .sort((a, b) => b.when.localeCompare(a.when));
}
// a backup named from the Settings list: only a plain file name inside the backups folder
function backupFile(dir, name) {
  const n = String(name || '');
  if (!/^(payroll|ark)-[\w.-]+\.db$/.test(n) || n !== path.basename(n)) throw new Error("That isn't one of the backups.");
  const f = path.join(dir, n); if (!fs.existsSync(f)) throw new Error("That backup isn't in the backups folder any more.");
  return f;
}

module.exports = { payrollCopy, summary, describe, freshStartRecords, backupFile };
