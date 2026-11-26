// Database layer — uses Node's built-in SQLite (node:sqlite, Node 22.5+). One file (data/payroll.db) on the persistent disk.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const demo = require('./demo');
// Demo mode (%APPDATA%\Riyeser\demo.json says on): records go in <DATA_DIR>/demo, so the real ones are never touched.
const REAL_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(REAL_DATA_DIR, { recursive: true });
const { dir: DATA_DIR, demo: DEMO } = demo.dataDir(REAL_DATA_DIR);
fs.mkdirSync(DATA_DIR, { recursive: true });
// records from before the rename (ark.db) carry on as payroll.db, with any changes still in the -wal file
const OLD = path.join(DATA_DIR, 'ark.db'), DB_FILE = path.join(DATA_DIR, 'payroll.db');
if (!fs.existsSync(DB_FILE) && fs.existsSync(OLD)) {
  const old = new DatabaseSync(OLD); old.exec(`VACUUM INTO '${DB_FILE.replace(/'/g, "''")}'`); old.close();
  for (const f of ['ark.db', 'ark.db-wal', 'ark.db-shm']) { try { fs.renameSync(path.join(DATA_DIR, f), path.join(DATA_DIR, f.replace('ark.db', 'ark.db.before-rename'))); } catch { } }
}
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',          -- staff (Staff) | manager (Admin) | admin (Super admin)
  position TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  pay_type TEXT NOT NULL DEFAULT 'hourly',     -- hourly | salary
  pay_rate REAL NOT NULL DEFAULT 0,            -- FJD per hour, or FJD per year if salary
  tin TEXT DEFAULT '',
  fnpf_no TEXT DEFAULT '',
  bank_account TEXT DEFAULT '',
  start_date TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  clock_pin TEXT DEFAULT '',                   -- 4-digit PIN for the shared time clock
  employee_no TEXT DEFAULT '',
  deductions TEXT DEFAULT '[]',                -- regular deductions each pay: [{name, amount}]
  timesheet_admin INTEGER DEFAULT 0,           -- can enter/edit everyone's timesheets
  on_timeclock INTEGER,                        -- on the time clock and timesheets
  bank_name TEXT DEFAULT '',
  bank_account_name TEXT DEFAULT '',
  aliases TEXT DEFAULT ''                      -- other names on the wage sheets / bank statement, comma separated
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER,
  device TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS timesheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in TEXT NOT NULL,                      -- local time YYYY-MM-DDTHH:MM
  clock_out TEXT,                              -- NULL while on shift
  notes TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ts_user_in ON timesheets(user_id, clock_in);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  total_gross REAL, total_net REAL, total_fnpf_employer REAL
);
CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  employee_name TEXT, position TEXT, pay_type TEXT, pay_rate REAL,
  hours REAL, base_pay REAL, allowances REAL, gross REAL,
  fnpf_employee REAL, fnpf_employer REAL, paye REAL, other_deductions REAL, net REAL,
  notes TEXT DEFAULT '',
  break_hours REAL DEFAULT 0, worked_hours REAL DEFAULT 0, deduction_lines TEXT DEFAULT '[]',
  leave_hours REAL DEFAULT 0, leave_pay REAL DEFAULT 0, leave_lines TEXT DEFAULT '[]'
);

-- Pay already made before this system (brought in from the monthly Excel wage reports): one row per person per week
CREATE TABLE IF NOT EXISTS pay_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                         -- YYYY-MM
  week INTEGER NOT NULL,                       -- week 1–5 of the month, as on the sheet
  hours REAL DEFAULT 0, rate REAL DEFAULT 0, bonus REAL DEFAULT 0, gross REAL DEFAULT 0,
  fnpf_employee REAL DEFAULT 0, fnpf_employer REAL DEFAULT 0, paye REAL DEFAULT 0, other_deductions REAL DEFAULT 0, net REAL DEFAULT 0,
  comment TEXT DEFAULT '', source TEXT DEFAULT '', imported_by INTEGER, imported_at TEXT,
  UNIQUE (user_id, month, week)
);

CREATE TABLE IF NOT EXISTS login_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, event TEXT NOT NULL, at TEXT NOT NULL, ip TEXT DEFAULT '', device TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_login_log_at ON login_log(at);
-- accrual adjustments per person and year (carried over, or a balance corrected by an admin): left = yearly allowance + adjustment − taken
CREATE TABLE IF NOT EXISTS leave_adjust (user_id INTEGER NOT NULL, year TEXT NOT NULL, kind TEXT NOT NULL, days REAL NOT NULL DEFAULT 0, note TEXT DEFAULT '', PRIMARY KEY (user_id, year, kind));
-- leave taken: annual, sick, other paid (bereavement, family…) or unpaid; paid leave is added to the pay for hourly staff
CREATE TABLE IF NOT EXISTS staff_leave (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, date_from TEXT NOT NULL, date_to TEXT NOT NULL,
  days REAL NOT NULL, paid INTEGER DEFAULT 1, notes TEXT DEFAULT '', created_by INTEGER, created_at TEXT);
`);

// ---------- password hashing (scrypt) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  company_name: 'My Company',
  address: 'Fiji',
  phone: '',
  email: '',
  // ---- privileges: lowest level for each action (staff = Staff, manager = Admin, admin = Super admin)
  booking_permissions: JSON.stringify({ 'timeclock.use': 'staff' }),
  timezone: 'Pacific/Fiji',
  currency: 'FJD',
  normal_week_hours: '40',        // normal working week for everyone (hours over this are shown as extra hours)
  normal_start: '09:00',          // normal day: 9am – 5pm (the multi-shift grid starts with these times)
  normal_finish: '17:00',
  pay_periods_per_year: '52',     // weekly, like the wage reports
  pay_cycle_start: '',            // a date a pay period started on (sets the day pay periods start); blank = Mondays
  new_payrun_hours: 'ask',        // "Start next pay run": ask | copy (always copy last week's hours) | empty (always start with no hours)
  payroll_open_period: '',        // the pay period "Start next pay run" last started: {"start","end","mode",…} (payweek.js)
  // emails (Settings → Email): off until the company's mailbox is set up and tested
  email_enabled: '0', smtp_host: '', smtp_port: '465', smtp_secure: 'ssl', smtp_user: '', email_from: '', email_from_name: '',
  email_club_copy: '', email_staff_ids: '', site_url: '',
  email_subs: '', report_time_daily: '18:30', report_time_weekly: '07:30', report_sent_daily: '', report_sent_weekly: '',
  // unpaid breaks: a shift longer than 'after_hours' has 'minutes' taken off (the biggest rule that applies).
  // None to start with: the wage reports pay 9am–5pm as 8 hours.
  payroll_breaks: '[]',
  leave_annual_days: '10',        // annual leave a year (days) — Fiji minimum is 10 working days after 12 months
  leave_sick_days: '10',          // paid sick leave a year (days)
  leave_day_hours: '8',           // hours paid for one day of leave (hourly staff)
  fnpf_employee_rate: '8',        // %
  fnpf_employer_rate: '10',       // %
  // Annual PAYE brackets — VERIFY against current FRCS tables before using for real payroll.
  paye_brackets: JSON.stringify([
    { from: 0, to: 30000, rate: 0 },
    { from: 30000, to: 50000, rate: 18 },
    { from: 50000, to: 270000, rate: 20 },
    { from: 270000, to: null, rate: 33 },
  ]),
};
// S56: the pay run that paid a leave record (leave entered after its dates were paid goes in the next pay run)
try { db.exec('ALTER TABLE staff_leave ADD COLUMN paid_in_run INTEGER'); } catch { /* already there */ }
// 2.3.1: how a timesheet entry was made: 'clock' (time clock or the staff Clock in button); '' = by its notes (from the roster, copied from …, typed)
try { db.exec("ALTER TABLE timesheets ADD COLUMN source TEXT DEFAULT ''"); } catch { /* already there */ }
// S57: a final pay (Finish employment) is labelled on its run; the person's last day is kept
for (const [t, c] of [['payroll_runs', "note TEXT DEFAULT ''"], ['users', "end_date TEXT DEFAULT ''"]]) { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch { /* already there */ } }
// F11: an extra pay run (bonus) on top of dates already paid carries its reason; '' = a normal pay run
try { db.exec("ALTER TABLE payroll_runs ADD COLUMN extra_reason TEXT DEFAULT ''"); } catch { /* already there */ }
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (!getSettingStmt.get(k)) setSettingStmt.run(k, v);
function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(k, v) { setSettingStmt.run(k, String(v)); }

// ---------- first run: one Super admin login ----------
function seed() {
  if (DEMO) return; // demo mode makes its own demo / demo login (demo.js)
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  const adminPw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  db.prepare(`INSERT INTO users(name, username, password_hash, role, position, pay_type, pay_rate, on_timeclock) VALUES(?,?,?,?,?,?,?,0)`)
    .run('Administrator', 'admin', hashPassword(adminPw), 'admin', 'Director', 'salary', 0);
  if (process.env.DESKTOP !== '1') fs.writeFileSync(path.join(DATA_DIR, 'FIRST_RUN_ADMIN_PASSWORD.txt'), `Username: admin\nPassword: ${adminPw}\n\nLog in and change this password, then delete this file.\n`);
  if (process.env.DESKTOP !== '1') console.log(`\n  First run: created login  admin / ${adminPw}\n`);
}
function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Pacific/Fiji', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
seed();
module.exports = { DATA_DIR, REAL_DATA_DIR, DEMO, DEFAULT_SETTINGS, db, hashPassword, verifyPassword, getSettings, setSetting, todayIn, addDays };
