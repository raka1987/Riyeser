// Demo mode (shared by every Riyeser program): %APPDATA%\Riyeser\demo.json says {"on": true, "since": "<ISO>", "business": "Sample Trading Co"}.
// While it's on, Payroll keeps its records in <DATA_DIR>/demo/ and fills them with a made-up business, so real records
// are never touched. Riyeser Central turns demo mode off and renames the demo folder to demo-ended-<UTC stamp>/
// (never deleted). Programs pick the change up the next time they start.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUSINESS = 'Sample Trading Co';

/** Where demo.json lives: RIYESER_DEMO_FILE (tests), else %APPDATA%\Riyeser (the same folder as company.json and licence.json). */
function demoFile(env = process.env) {
  if (env.RIYESER_DEMO_FILE) return env.RIYESER_DEMO_FILE;
  const appData = env.APPDATA || path.join(os.homedir(), '.config'); // the same lookup as Riyeser Accounting
  return path.join(appData, 'Riyeser', 'demo.json');
}
function readDemo(env = process.env) {
  try { return JSON.parse(fs.readFileSync(demoFile(env), 'utf8')) || null; } catch { return null; }
}
/** Demo mode is on when demo.json says so. With no demo.json, RIYESER_DEMO=1 (set by Riyeser Central when it starts us) also counts. */
function isOn(env = process.env) {
  const d = readDemo(env);
  if (d && typeof d.on === 'boolean') return d.on;
  return env.RIYESER_DEMO === '1';
}
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261124T031500Z

/**
 * The folder this program's records go in. In demo mode, <base>/demo. After demo mode was left (demo.json on:false)
 * a demo folder still lying there (Central couldn't rename it because Payroll was open) is put away now: renamed, never deleted.
 */
function dataDir(base, env = process.env) {
  if (isOn(env)) return { dir: path.join(base, 'demo'), demo: true };
  const d = readDemo(env); const left = path.join(base, 'demo');
  if (d && d.on === false && fs.existsSync(left)) { try { fs.renameSync(left, path.join(base, `demo-ended-${stamp()}`)); } catch { /* in use: tried again next start */ } }
  return { dir: base, demo: false };
}

// ---------- the made-up business ----------
// The same people, pay types, rates and hours as Riyeser Accounting's demo company (DEMO_STAFF and DEMO_DETAILS in
// riyeser/demo.py), so both programs show the same team. Keep the two in step: change one, change the other.
const DETAILS = { company_name: `${BUSINESS} (demo)`, address: '12 Victoria Parade, Suva, Fiji', phone: '+679 330 1234', email: 'accounts@sampletrading.example' };
// day: one weekday shift, so a week matches each person's standard hours (38, or 20 and 25 part time)
const STAFF = [
  { name: 'Alex Sample', username: 'alex', position: 'Store manager', pay_type: 'salary', pay_rate: 78000, email: 'alex.sample@sampletrading.example', day: ['08:30', '16:06'] },
  { name: 'Jamie Example', username: 'jamie', position: 'Service technician', pay_type: 'hourly', pay_rate: 34.5, email: 'jamie.example@sampletrading.example', day: ['07:30', '15:06'] },
  { name: 'Robin Demo', username: 'robin', position: 'Service technician', pay_type: 'hourly', pay_rate: 33, email: 'robin.demo@sampletrading.example', day: ['08:00', '15:36'] },
  { name: 'Casey Placeholder', username: 'casey', position: 'Shop assistant', pay_type: 'hourly', pay_rate: 31, email: 'casey.placeholder@sampletrading.example', day: ['09:00', '13:00'] },
  { name: 'Morgan Testwell', username: 'morgan', position: 'Cafe barista', pay_type: 'hourly', pay_rate: 30, email: 'morgan.testwell@sampletrading.example', day: ['07:00', '12:00'] },
];

// OWNER-ROSTER (2.3.0): the demo roster. This week is published (with an open Saturday cafe shift, and one shift changed
// after publishing so "changed" shows); next week is copied from it as a draft, not published yet.
const ROLE = { 'Store manager': 'Office', 'Service technician': 'Workshop', 'Shop assistant': 'Till', 'Cafe barista': 'Cafe' };
function seedRoster(h) {
  const { db, getSettings, setSetting, todayIn, addDays } = h;
  if (getSettings().demo_roster_seeded === '1') return false;
  try { db.prepare('SELECT 1 FROM roster_shifts LIMIT 1').all(); } catch { return false; }   // roster.js not loaded
  const today = todayIn(getSettings().timezone), mon = addDays(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7)), at = new Date().toISOString();
  const users = db.prepare("SELECT id, username FROM users WHERE username IN (" + STAFF.map(() => '?').join(',') + ')').all(...STAFF.map(s => s.username));
  const ins = db.prepare(`INSERT INTO roster_shifts(user_id, date, start, finish, break_min, role, note, published, pub_user_id, pub_date, pub_start, pub_finish, pub_break_min, pub_role, pub_note, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const add = (uid, d, a, b, role, note, pub) => ins.run(uid, d, a, b, 0, role, note, pub ? 1 : 0, pub ? uid : null, pub ? d : null, pub ? a : null, pub ? b : null, pub ? 0 : null, pub ? role : null, pub ? note : null, at, at).lastInsertRowid;
  db.exec('BEGIN');
  try {
    for (const [week, pub] of [[mon, true], [addDays(mon, 7), false]]) {
      for (let i = 0; i < 5; i++) {
        const d = addDays(week, i);
        STAFF.forEach(s => { const u = users.find(x => x.username === s.username); if (u) add(u.id, d, s.day[0], s.day[1], ROLE[s.position] || '', i === 4 && s.username === 'robin' ? 'Stocktake after close' : '', pub); });
      }
      add(null, addDays(week, 5), '08:00', '12:00', 'Cafe', 'Saturday market', pub);
    }
    // published, then Casey's Thursday changed (a draft until it's published again)
    db.prepare('INSERT OR IGNORE INTO roster_weeks(week_start, published_at, published_by_name, first_published_at, times) VALUES(?,?,?,?,1)').run(mon, at, 'Demo Admin', at);
    const casey = users.find(x => x.username === 'casey');
    if (casey) db.prepare("UPDATE roster_shifts SET start = '10:00', finish = '14:00' WHERE user_id = ? AND date = ?").run(casey.id, addDays(mon, 3));
    setSetting('demo_roster_seeded', '1');
    db.exec('COMMIT');
    return true;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Fill an empty demo payroll: settings, a demo/demo admin login, 5 staff, two weeks of timesheets and one finished pay run. */
function seed(h) {
  const r = seedPay(h);
  seedRoster(h);
  return r;
}
function seedPay(h) {
  const { db, hashPassword, getSettings, setSetting, computePayroll, payPeriodOf, todayIn, addDays } = h;
  if (getSettings().demo_seeded === '1') return false;
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries({ ...DETAILS, pay_periods_per_year: '26', normal_week_hours: '38', setup_done: '1', demo_seeded: '1' })) setSetting(k, v);
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    if (admin) db.prepare("UPDATE users SET name = 'Demo Admin', username = 'demo', password_hash = ?, position = 'Owner', on_timeclock = 0 WHERE id = ?").run(hashPassword('demo'), admin.id);
    else db.prepare("INSERT INTO users(name, username, password_hash, role, position, pay_type, pay_rate, on_timeclock) VALUES('Demo Admin', 'demo', ?, 'admin', 'Owner', 'salary', 0, 0)").run(hashPassword('demo'));
    const adminId = db.prepare("SELECT id FROM users WHERE username = 'demo'").get().id;
    const ins = db.prepare(`INSERT INTO users(name, username, password_hash, role, position, email, pay_type, pay_rate, start_date, on_timeclock, employee_no, clock_pin)
      VALUES(?,?,?,'staff',?,?,?,?,?,1,?,?)`);
    const today = todayIn(getSettings().timezone);
    const ids = STAFF.map((s, i) => ins.run(s.name, s.username, hashPassword(`${s.username}-demo-${i}`), s.position, s.email, s.pay_type, s.pay_rate,
      addDays(today, -200), `E${String(i + 1).padStart(3, '0')}`, String(1111 * (i + 1)).slice(0, 4)).lastInsertRowid);
    // the last full pay period (two weeks): a shift on every weekday, then the pay run for it
    const cur = payPeriodOf(today), prev = payPeriodOf(addDays(cur[0], -1));
    const ts = db.prepare('INSERT INTO timesheets(user_id, clock_in, clock_out, notes) VALUES(?,?,?,?)');
    for (let d = prev[0]; d <= prev[1]; d = addDays(d, 1)) {
      if ([0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay())) continue;
      STAFF.forEach((s, i) => ts.run(ids[i], `${d}T${s.day[0]}`, `${d}T${s.day[1]}`, ''));
    }
    const lines = computePayroll(prev[0], prev[1]);
    const sum = k => Math.round(lines.reduce((a, l) => a + (+l[k] || 0), 0) * 100) / 100;
    const runId = db.prepare('INSERT INTO payroll_runs(period_start, period_end, pay_date, created_by, total_gross, total_net, total_fnpf_employer) VALUES(?,?,?,?,?,?,?)')
      .run(prev[0], prev[1], cur[0], adminId, sum('gross'), sum('net'), sum('fnpf_employer')).lastInsertRowid;
    const slip = db.prepare(`INSERT INTO payslips(run_id, user_id, employee_name, position, pay_type, pay_rate, hours, base_pay, allowances, gross, fnpf_employee, fnpf_employer, paye, other_deductions, net, notes, worked_hours, break_hours, deduction_lines, leave_hours, leave_pay, leave_lines)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const l of lines) slip.run(runId, l.user_id, l.employee_name, l.position, l.pay_type, l.pay_rate, l.hours, l.base_pay, l.allowances, l.gross, l.fnpf_employee, l.fnpf_employer, l.paye,
      l.other_deductions, l.net, l.notes, l.worked_hours, l.break_hours, JSON.stringify(l.deduction_lines), l.leave_hours || 0, l.leave_pay || 0, JSON.stringify(l.leave_lines || []));
    db.exec('COMMIT');
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* Riyeser Central sees it once Payroll closes */ }
    return true;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- what the pages show in demo mode ----------
const BANNER = '<div class="demo-banner" role="status" style="background:#ffd84d;color:#3a2c00;padding:8px 16px;text-align:center;font:600 14px/1.4 Inter,system-ui,sans-serif;border-bottom:1px solid #e0b800">'
  + 'Demo mode: practice data, not real pay. Leave demo mode from Riyeser Central.</div>';
const LOGIN_HINT = '<p class="demo-login" style="text-align:center;background:#fff4c2;border-radius:8px;padding:6px 10px;font-weight:600">Demo mode: sign in with demo / demo</p>';
/** staff.html with the yellow banner on every screen and the demo sign-in shown on the login screen. */
function page(html) {
  return html.replace(/<body([^>]*)>/, `<body$1>\n  ${BANNER}`).replace('<div id="login-err"></div>', `${LOGIN_HINT}<div id="login-err"></div>`);
}

module.exports = { BUSINESS, DETAILS, STAFF, demoFile, readDemo, isOn, dataDir, stamp, seed, seedRoster, page, BANNER, LOGIN_HINT };
