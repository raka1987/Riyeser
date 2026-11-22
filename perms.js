// Who can see and change what, area by area (the same model as Riyeser Accounting).
// Levels: 0 Hidden · 1 View · 2 Add & edit (no delete or void) · 3 Full. Administrators always have Full everywhere.
// Checked on the server for every request; the screens only hide what the server would refuse anyway.
const AREAS = {
  employees: 'Employees & personal details',
  pay_rates: 'Pay rates & bank details',
  timesheets: 'Timesheets & time clock',
  payroll: 'Pay runs & payslips',
  leave: 'Leave',
  reports: 'Reports',
  setup: 'Setup',
};
const LEVELS = ['Hidden', 'View', 'Add & edit', 'Full'];
const all = n => Object.fromEntries(Object.keys(AREAS).map(k => [k, n]));
// team: only their own team (people who have them as supervisor) and themselves
const PRESETS = {
  owner: { label: 'Owner', admin: true, perms: all(3), team: false },
  payroll_officer: { label: 'Payroll officer', perms: { employees: 2, pay_rates: 2, timesheets: 2, payroll: 2, leave: 2, reports: 1, setup: 1 }, team: false },
  supervisor: { label: 'Supervisor', perms: { employees: 1, pay_rates: 0, timesheets: 2, payroll: 0, leave: 1, reports: 1, setup: 0 }, team: true },
  self_service: { label: 'Employee self-service', perms: all(0), team: false },
  read_only: { label: 'Read-only', perms: all(1), team: false },
};
// people saved before access areas existed: what their old access level meant
function legacy(u) {
  if (u.role === 'admin') return all(3);
  if (u.role === 'manager') return { employees: 2, pay_rates: 2, timesheets: 2, payroll: 2, leave: 2, reports: 1, setup: 1 };
  return { ...all(0), ...(u.timesheet_admin ? { timesheets: 2 } : {}) };
}
function permsOf(u) {
  if (!u) return all(0);
  if (u.role === 'admin') return all(3);
  let p = null; try { p = JSON.parse(u.perms || 'null'); } catch { }
  const base = p && typeof p === 'object' ? p : legacy(u);
  return Object.fromEntries(Object.keys(AREAS).map(k => [k, Math.max(0, Math.min(3, Number(base[k]) || 0))]));
}
const clean = p => Object.fromEntries(Object.keys(AREAS).map(k => [k, Math.max(0, Math.min(3, Math.round(Number((p || {})[k]) || 0)))]));

module.exports = function perms(h) {
  const { db, requireStaff, HttpError } = h;
  for (const col of ["perms TEXT", "preset TEXT DEFAULT ''", 'supervisor_id INTEGER', 'team_only INTEGER DEFAULT 0']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { } }
  for (const col of ['approved_by INTEGER', 'approved_at TEXT']) { try { db.exec(`ALTER TABLE timesheets ADD COLUMN ${col}`); } catch { } }
  db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, user_name TEXT, action TEXT NOT NULL, details TEXT DEFAULT '')`);

  const row = id => db.prepare('SELECT id, name, role, perms, timesheet_admin, team_only, supervisor_id FROM users WHERE id = ?').get(id);
  const levelOf = (user, area) => permsOf(user && user.perms !== undefined ? user : row(user && user.id))[area] || 0;
  // a fresh look at the person each request (access changes take effect straight away)
  const levelsFor = user => permsOf(row(user.id));
  const teamOnly = user => { const r = row(user.id); return !!(r && r.role !== 'admin' && r.team_only); };
  // people this person may see in an area: everyone, or only their team (and themselves)
  function inScope(user, area, targetId, need = 1) {
    if (+targetId === +user.id) return true;
    if (levelOf(user, area) < need) return false;
    if (!teamOnly(user)) return true;
    const t = db.prepare('SELECT supervisor_id FROM users WHERE id = ?').get(+targetId);
    return !!(t && +t.supervisor_id === +user.id);
  }
  // SQL for "people in my scope" (for lists): returns [whereClause, params] on a users-id column
  function scopeSql(user, col) { return teamOnly(user) ? [`(${col} = ? OR ${col} IN (SELECT id FROM users WHERE supervisor_id = ?))`, [user.id, user.id]] : ['1 = 1', []]; }
  const requireArea = (area, need = 1) => (req, res, next) => requireStaff(req, res, () => {
    if (levelOf(req.user, area) < need) return res.status(403).json({ error: `You don't have ${['', 'view', 'add & edit', 'full'][need]} access to ${AREAS[area].toLowerCase()}. Ask an administrator.` });
    next();
  });
  const can = (req, area, need = 1) => levelOf(req.user, area) >= need;
  const must = (req, area, need = 1) => { if (!can(req, area, need)) throw new HttpError(403, `You don't have ${['', 'view', 'add & edit', 'full'][need]} access to ${AREAS[area].toLowerCase()}. Ask an administrator.`); };
  function audit(req, action, details = '') {
    try { db.prepare('INSERT INTO audit_log(at, user_id, user_name, action, details) VALUES(?,?,?,?,?)').run(new Date().toISOString(), req.user ? req.user.id : null, req.user ? req.user.name : '', action, String(details).slice(0, 2000)); } catch { }
  }
  return { AREAS, LEVELS, PRESETS, permsOf, clean, levelOf, levelsFor, teamOnly, inScope, scopeSql, requireArea, can, must, audit };
};
module.exports.AREAS = AREAS;
module.exports.PRESETS = PRESETS;
