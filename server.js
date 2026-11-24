// Riyeser Payroll: time clock, timesheets, payroll, payslips, leave and reports.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { db, DATA_DIR, DEMO, DEFAULT_SETTINGS, hashPassword, verifyPassword, getSettings, setSetting, todayIn, addDays } = require('./db');

const PORT = process.env.PORT || 3000;
const app = express();
app.disable('x-powered-by');
// Behind a hosting proxy (Render sets RENDER=true), use the visitor's real IP so the login limits apply per person.
if (process.env.RENDER || process.env.TRUST_PROXY) app.set('trust proxy', 1);
const smallJson = express.json({ limit: '200kb' }), bigJson = express.json({ limit: '12mb' });
app.use((req, res, next) => (['/api/staff/import/wages', '/api/staff/import/wages/preview', '/api/staff/bank/preview', '/api/staff/bank/save'].includes(req.path) ? bigJson : smallJson)(req, res, next));
app.get('/', (req, res) => res.redirect('/staff'));
// reading PDF bank statements in the browser: pdf.js, and Tesseract text recognition (OCR) for statements that are pictures
{
  const dir = m => path.dirname(require.resolve(m)), long = { maxAge: '30d', immutable: true };
  app.use('/vendor/pdfjs', express.static(path.join(dir('pdfjs-dist/package.json'), 'build'), long));
  app.use('/vendor/tesseract', express.static(path.join(dir('tesseract.js/package.json'), 'dist'), long));
  app.use('/vendor/tesseract-core', express.static(dir('tesseract.js-core/package.json'), long));
  app.use('/vendor/tessdata', express.static(path.join(dir('@tesseract.js-data/eng/package.json'), '4.0.0_best_int'), long));
}
// demo mode: the yellow banner on every screen, and the demo sign-in on the login screen
if (DEMO) {
  // Riyeser Central left demo mode while Payroll was open: nothing more is done with the practice records
  const ENDED = 'Demo mode has ended. Close this program and open it again.';
  let checked = 0, ended = false;
  app.use((req, res, next) => {
    if (Date.now() - checked > 3000) { checked = Date.now(); ended = !require('./demo').isOn(); }
    if (!ended) return next();
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: ENDED });
    if (req.method === 'GET' && /^\/(staff(\.html)?)?$/.test(req.path)) return res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"><title>Riyeser Payroll</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0"><p style="font-size:18px">${ENDED}</p></body>`);
    next();
  });
  const demoPage = require('./demo').page(require('fs').readFileSync(path.join(__dirname, 'public', 'staff.html'), 'utf8'));
  app.get(['/staff', '/staff.html'], (req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(demoPage); });
}
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------------------------------------------------------------- helpers
const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isTime = s => /^\d{2}:\d{2}$/.test(String(s || ''));
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };

// ---------------------------------------------------------------- licence (licence.js)
// The Windows program follows the company's Riyeser plan: after the free trial (or with an edited, copied or expired
// licence) new pay runs and pay-rate changes are locked here on the server. Viewing, printing and the time clock
// always work, and nothing is deleted. The hosted site and demo mode (practice records) aren't checked.
// app.locals.payrollLicence can be swapped in tests.
const payLicence = require('./licence');
app.locals.payrollLicence = payLicence.checker({ enforce: process.env.DESKTOP === '1' && !DEMO, ownDir: process.env.DATA_DIR || DATA_DIR });
const licenceNow = () => app.locals.payrollLicence();
class LockedError extends HttpError { constructor(l) { super(402, l.message || payLicence.ENDED); this.locked = { home_url: l.homeUrl, price: l.price }; } }
const needLicence = () => { const l = licenceNow(); if (!l.licensed) throw new LockedError(l); };
const requireLicence = (req, res, next) => { try { needLicence(); next(); } catch (e) { next(e); } };
const wrap = fn => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.then) r.catch(next); } catch (e) { next(e); } };

function localNowISO(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

// Simple in-memory rate limit for public POSTs
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path, now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests — please try again shortly.' });
    arr.push(now); hits.set(key, arr); next();
  };
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg, staffOnly = false) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1 && (!staffOnly || c.user)) c.send(data);
}
function onlineStaff() {
  const m = new Map();
  for (const c of wss.clients) if (c.user) m.set(c.user.id, { id: c.user.id, name: c.user.name, position: c.user.position });
  return [...m.values()];
}
wss.on('connection', (ws, req) => {
  ws.user = userFromCookie(req.headers.cookie);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { if (ws.user) broadcast({ type: 'presence', online: onlineStaff() }, true); });
  if (ws.user) broadcast({ type: 'presence', online: onlineStaff() }, true);
});
setInterval(() => { for (const c of wss.clients) { if (!c.isAlive) c.terminate(); else { c.isAlive = false; c.ping(); } } }, 30000).unref();

// ---------------------------------------------------------------- auth
function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function userFromCookie(cookieHeader) {
  const token = parseCookies(cookieHeader).sid;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.name, u.username, u.role, u.position, u.active, s.expires_at, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row || row.expires_at < Date.now() || !row.active) return null;
  // last active (for the login report), at most once a minute
  if (!row.last_seen || Date.now() - row.last_seen > 60000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
  delete row.last_seen;
  return row;
}
// Login history: device in plain words, from the browser's user-agent
const deviceOf = ua => {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
};
const clientIp = req => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().replace(/^::ffff:/, '');
function logLogin(req, event, u, username) {
  try { db.prepare('INSERT INTO login_log(user_id, username, event, at, ip, device) VALUES(?,?,?,?,?,?)')
    .run(u ? u.id : null, u ? u.username : str(username, 60), event, localNowISO(getSettings().timezone), clientIp(req), deviceOf(req.headers['user-agent'])); } catch { }
}
function requireStaff(req, res, next) {
  const u = userFromCookie(req.headers.cookie);
  if (!u) return res.status(401).json({ error: 'Please log in.' });
  req.user = u; next();
}
const ROLE_RANK = { staff: 1, manager: 2, admin: 3 };
// what each level is called: Staff (view + enter timesheets), Admin (view, enter, edit, reports), Super admin (all, incl. delete)
const ROLE_NAME = { staff: 'Staff', manager: 'Admin', admin: 'Super admin' };
const requireRole = role => (req, res, next) => requireStaff(req, res, () => {
  if ((ROLE_RANK[req.user.role] || 0) < ROLE_RANK[role]) return res.status(403).json({ error: `Requires ${ROLE_NAME[role]} access.` });
  next();
});

// Access by area (perms.js): Hidden / View / Add & edit / Full for each part of Payroll; Administrators have Full.
const P = require('./perms')({ db, requireStaff, HttpError });
const { requireArea, must, inScope, scopeSql, audit } = P;
const canArea = (req, area, need = 1) => P.levelOf(req.user, area) >= need;
// can add and edit timesheets for other people (their team only, for a supervisor)
function canTimesheets(user) { return !!user && P.levelOf(user, 'timesheets') >= 2; }
// Timesheet PIN: on the shared office PC, someone with timesheet access types their time-clock PIN to enter /
// edit everyone's timesheets for 15 minutes (recorded as done by them), without changing who is logged in.
const tsUnlocks = new Map(); // token -> { user_id, name, until }
const tsUnlockOf = req => {
  const t = String(req.headers['x-ts-unlock'] || ''); if (!t) return null;
  const u = tsUnlocks.get(t); if (!u || u.until < Date.now()) { tsUnlocks.delete(t); return null; }
  return u;
};
const canTimesheetsReq = req => canTimesheets(req.user) || !!tsUnlockOf(req);
// whose timesheets this request may add or change: someone in the person's scope (or anyone, for a timesheet PIN unlock)
const tsScope = (req, uid) => +uid === +req.user.id || (canTimesheets(req.user) && inScope(req.user, 'timesheets', uid, 2)) || (!!tsUnlockOf(req) && inScope({ id: tsUnlockOf(req).user_id }, 'timesheets', uid, 2));
const requireTimesheets = (req, res, next) => requireStaff(req, res, () => {
  if (!canTimesheetsReq(req)) return res.status(403).json({ error: 'You need timesheet access to do that. Ask a manager, or unlock with a timesheet PIN.' });
  next();
});


// ---- privileges (Settings & privileges): lowest level for each action
const PERMISSION_LABELS = {
  'timeclock.use': 'Use the shared time clock (anyone clocks in/out with their own PIN)',
};
const NEW_PERMISSION_DEFAULTS = { 'timeclock.use': 'staff' };
function perms() { try { return { ...NEW_PERMISSION_DEFAULTS, ...JSON.parse(getSettings().booking_permissions) }; } catch { return { ...NEW_PERMISSION_DEFAULTS }; } }
function can(user, action) {
  if (!user) return false;
  const need = perms()[action] || 'admin';
  return (ROLE_RANK[user.role] || 0) >= (ROLE_RANK[need] || 3);
}
const requirePerm = action => (req, res, next) => requireStaff(req, res, () => {
  if (!can(req.user, action)) return res.status(403).json({ error: `You don't have permission to ${(PERMISSION_LABELS[action] || action).toLowerCase()}. Ask a manager.` });
  next();
});

app.post('/api/auth/login', rateLimit(10, 10 * 60 * 1000), wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE lower(username) = lower(?) AND active = 1').get(str(req.body.username, 60));
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
    logLogin(req, 'failed', u || db.prepare('SELECT id, username FROM users WHERE lower(username) = lower(?)').get(str(req.body.username, 60)), req.body.username);
    throw new HttpError(401, 'Incorrect username or password.');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const days = 14;
  db.prepare('INSERT INTO sessions(token, user_id, expires_at, last_seen, device) VALUES(?,?,?,?,?)').run(token, u.id, Date.now() + days * 864e5, Date.now(), deviceOf(req.headers['user-agent']));
  logLogin(req, 'login', u);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.round(days * 86400)}${secure}`);
  res.json({ ok: true });
}));
app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) { const s = db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token); if (s) logLogin(req, 'logout', s); db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/auth/me', requireStaff, (req, res) => {
  const onShift = db.prepare('SELECT * FROM timesheets WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(req.user.id);
  const p = perms();
  const mine = db.prepare('SELECT clock_pin FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: { ...req.user, clock_pin: mine ? mine.clock_pin : '', timesheets: canTimesheets(req.user), perms: P.levelsFor(req.user), team_only: P.teamOnly(req.user), administrator: req.user.role === 'admin' },
    areas: P.AREAS, levels: P.LEVELS, presets: P.PRESETS, on_shift: onShift || null, settings: getSettings(),
    can: Object.keys(PERMISSION_LABELS).filter(a => can(req.user, a)), permission_labels: PERMISSION_LABELS, permissions: p });
});
app.post('/api/auth/password', requireStaff, wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body.current || ''), u.password_hash)) bad('Current password is incorrect.');
  const pw = String(req.body.password || '');
  if (pw.length < 8) bad('New password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), u.id);
  res.json({ ok: true });
}));

const BUILD = process.env.RENDER_GIT_COMMIT || String(Date.now());
app.get('/api/staff/licence', requireStaff, (req, res) => {
  const l = licenceNow();
  res.json({ licensed: l.licensed, mode: l.mode, days_left: l.daysLeft ?? null, source: l.source, message: l.message || null, home_url: l.homeUrl, price: l.price });
});
app.get('/api/version', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ v: BUILD }); });
app.get('/api/public/info', (req, res) => { const s = getSettings(); res.json({ company_name: s.company_name, today: todayIn(s.timezone), demo: DEMO }); });

// ---------------------------------------------------------------- staff: employees
// on_timeclock left empty counts as "on the time clock": send it as 1 so the Staff form shows the box ticked
// (an empty value showed unticked, and saving the form then took the person off the timesheets)
const EMP_FIELDS = "id, name, username, role, position, phone, email, pay_type, pay_rate, tin, fnpf_no, bank_name, bank_account_name, bank_account, aliases, start_date, active, created_at, clock_pin, COALESCE(timesheet_admin, 0) AS timesheet_admin, COALESCE(on_timeclock, 1) AS on_timeclock, employee_no, perms, COALESCE(preset, '') AS preset, supervisor_id, COALESCE(team_only, 0) AS team_only";
// pay rates and bank details: only for people with access to them
const SENSITIVE = ['pay_type', 'pay_rate', 'tin', 'fnpf_no', 'bank_name', 'bank_account_name', 'bank_account', 'deductions'];
const shapeEmp = (req, e) => { if (!e) return e; const o = { ...e, access: P.permsOf(e) }; delete o.perms; if (!canArea(req, 'pay_rates')) for (const k of SENSITIVE) delete o[k]; return o; };
// names for pickers: the people in this person's scope (contact details only with Employees access)
app.get('/api/staff/directory', requireStaff, (req, res) => {
  const wide = canArea(req, 'employees') || canArea(req, 'timesheets');
  const [w, p] = wide ? scopeSql(req.user, 'id') : ['id = ?', [req.user.id]];
  res.json(db.prepare(`SELECT id, name, position, phone, email, role, COALESCE(on_timeclock, 1) AS on_timeclock, COALESCE(employee_no, '') AS employee_no FROM users WHERE active=1 AND ${w} ORDER BY name`).all(...p)
    .map(u => canArea(req, 'employees') ? u : { ...u, phone: '', email: '' }));
});
app.get('/api/staff/employees', requireArea('employees'), (req, res) => {
  const [w, p] = scopeSql(req.user, 'id');
  res.json(db.prepare(`SELECT ${EMP_FIELDS} FROM users WHERE ${w} ORDER BY active DESC, name`).all(...p).map(e => shapeEmp(req, e)));
});
function saveEmployee(req, id) {
  const b = req.body, o = {};
  must(req, 'employees', 2);
  if (id && !inScope(req.user, 'employees', id, 2)) throw new HttpError(403, "That person isn't in your team.");
  if (SENSITIVE.some(k => b[k] !== undefined) && !canArea(req, 'pay_rates', 2)) throw new HttpError(403, "You don't have access to change pay rates or bank details. Ask an administrator.");
  const isAdministrator = req.user.role === 'admin', before = id ? db.prepare(`SELECT ${EMP_FIELDS} FROM users WHERE id = ?`).get(id) : null;
  for (const k of ['name', 'username', 'position', 'phone', 'email', 'tin', 'fnpf_no', 'bank_name', 'bank_account_name', 'bank_account', 'aliases', 'start_date', 'employee_no']) if (b[k] !== undefined) o[k] = str(b[k], 120);
  if (b.role !== undefined) { if (!ROLE_RANK[b.role]) bad('Bad role'); if (b.role === 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Only an admin can create admins.'); if (!before || b.role !== before.role) { if (!isAdministrator) throw new HttpError(403, "Only an administrator can change someone's access."); } o.role = b.role; }
  // access by area, a preset name, team only, and supervisor: administrators only
  if (b.perms !== undefined || b.preset !== undefined || b.team_only !== undefined || b.supervisor_id !== undefined) {
    const changed = (b.perms !== undefined && JSON.stringify(P.clean(typeof b.perms === 'string' ? JSON.parse(b.perms || '{}') : b.perms)) !== JSON.stringify(before ? P.permsOf(before) : null))
      || (b.preset !== undefined && String(b.preset || '') !== String(before ? before.preset : '')) || (b.team_only !== undefined && (b.team_only ? 1 : 0) !== (before ? before.team_only : 0))
      || (b.supervisor_id !== undefined && String(+b.supervisor_id || '') !== String(before && before.supervisor_id || ''));
    if (changed && !isAdministrator) throw new HttpError(403, "Only an administrator can change someone's access.");
    if (b.perms !== undefined) o.perms = JSON.stringify(P.clean(typeof b.perms === 'string' ? JSON.parse(b.perms || '{}') : b.perms));
    if (b.preset !== undefined) o.preset = P.PRESETS[b.preset] || !b.preset ? String(b.preset || '') : bad('Unknown preset.');
    if (b.team_only !== undefined) o.team_only = b.team_only ? 1 : 0;
    if (b.supervisor_id !== undefined) { const s = +b.supervisor_id || null; if (s && (s === id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(s))) bad('Choose a different supervisor.'); o.supervisor_id = s; }
  }
  if (b.pay_type !== undefined) o.pay_type = b.pay_type === 'salary' ? 'salary' : 'hourly';
  if (b.pay_rate !== undefined) o.pay_rate = Number(b.pay_rate) || 0;
  // a new or changed pay rate needs Payroll's licence (the rest of the staff record can still be kept up to date)
  if ((o.pay_type !== undefined && o.pay_type !== (before ? before.pay_type : 'hourly')) || (o.pay_rate !== undefined && o.pay_rate !== (before ? Number(before.pay_rate) || 0 : 0))) needLicence();
  if (b.clock_pin !== undefined) {
    const pin = String(b.clock_pin).trim();
    if (pin && !/^\d{4}$/.test(pin)) bad('Time-clock PIN must be 4 digits.');
    if (pin && db.prepare('SELECT 1 FROM users WHERE clock_pin = ? AND id != ? AND active = 1').get(pin, id || 0)) bad('That time-clock PIN is already used by someone else. Choose another.');
    o.clock_pin = pin;
  }
  if (!id && !o.clock_pin) o.clock_pin = newClockPin();
  if (b.active !== undefined) { o.active = b.active ? 1 : 0; if (before && before.active && !o.active) must(req, 'employees', 3); }
  if (b.timesheet_admin !== undefined) { o.timesheet_admin = b.timesheet_admin ? 1 : 0; if ((!before || o.timesheet_admin !== before.timesheet_admin) && o.timesheet_admin && !isAdministrator) throw new HttpError(403, "Only an administrator can change someone's access."); }
  if (b.on_timeclock !== undefined) o.on_timeclock = b.on_timeclock ? 1 : 0;
  else if (!id) o.on_timeclock = (o.role || 'staff') === 'staff' ? 1 : 0;
  if (b.password) { if (String(b.password).length < 8) bad('Password must be at least 8 characters.'); o.password_hash = hashPassword(String(b.password)); }
  if (!id) { if (!o.name || !o.username) bad('Name and username are required.'); if (!o.password_hash) bad('Set an initial password.'); }
  if (o.username && db.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?) AND id != ?').get(o.username, id || 0)) bad('That username is taken.');
  if (id) {
    const target = db.prepare('SELECT role FROM users WHERE id=?').get(id);
    if (target && target.role === 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Only an admin can edit an admin.');
  }
  // the last active administrator can't be removed (made a non-administrator or switched off)
  if (before && before.role === 'admin' && before.active && ((o.role && o.role !== 'admin') || o.active === 0)
    && !db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(id)) bad('This is the last active administrator. Make someone else an administrator first.');
  const keys = Object.keys(o);
  if (id) { if (keys.length) db.prepare(`UPDATE users SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => o[k]), id); if (o.active === 0) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }
  else id = db.prepare(`INSERT INTO users(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(k => o[k])).lastInsertRowid;
  const after = db.prepare(`SELECT ${EMP_FIELDS} FROM users WHERE id=?`).get(id);
  // audit trail: access changes (before → after) and which pay / bank details changed (not the values)
  const lv = e => e ? (e.role === 'admin' ? 'Administrator' : Object.entries(P.permsOf(e)).map(([k, v]) => `${k} ${P.LEVELS[v]}`).join(', ') + (e.team_only ? ' (own team only)' : '')) : '';
  if (!before) audit(req, 'Added staff member', `${after.name}: ${lv(after)}`);
  else {
    if (lv(before) !== lv(after) || before.supervisor_id !== after.supervisor_id) audit(req, 'Changed access', `${after.name}: ${lv(before)} → ${lv(after)}${before.supervisor_id !== after.supervisor_id ? `; supervisor ${(db.prepare('SELECT name FROM users WHERE id = ?').get(after.supervisor_id) || {}).name || 'none'}` : ''}`);
    const pay = SENSITIVE.filter(k => k !== 'deductions' && String(before[k] ?? '') !== String(after[k] ?? ''));
    if (pay.length) audit(req, 'Changed pay or bank details', `${after.name}: ${pay.join(', ')}`);
    if (before.active !== after.active) audit(req, after.active ? 'Switched staff member on' : 'Switched staff member off', after.name);
  }
  return shapeEmp(req, after);
}
// Login history report (admin only): per person summary + every login / failed attempt / log out
function loginReport(q) {
  const tz = getSettings().timezone, today = localNowISO(tz).slice(0, 10);
  const from = isDate(q.from) ? q.from : addDays(today, -30), to = isDate(q.to) ? q.to : today;
  const w = ['substr(l.at,1,10) BETWEEN ? AND ?'], p = [from, to];
  if (q.user_id) { w.push('l.user_id = ?'); p.push(+q.user_id); }
  if (['login', 'failed', 'logout'].includes(q.event)) { w.push('l.event = ?'); p.push(q.event); }
  const events = db.prepare(`SELECT l.*, u.name, u.role FROM login_log l LEFT JOIN users u ON u.id = l.user_id WHERE ${w.join(' AND ')} ORDER BY l.at DESC, l.id DESC LIMIT 2000`).all(...p);
  const nowMs = Date.now();
  const users = db.prepare('SELECT id, name, username, role, active FROM users ORDER BY active DESC, name').all().map(u => {
    const mine = db.prepare(`SELECT event, COUNT(*) AS n FROM login_log WHERE user_id = ? AND substr(at,1,10) BETWEEN ? AND ? GROUP BY event`).all(u.id, from, to);
    const n = e => (mine.find(x => x.event === e) || {}).n || 0;
    const last = db.prepare("SELECT at, device FROM login_log WHERE user_id = ? AND event = 'login' ORDER BY id DESC LIMIT 1").get(u.id);
    const sess = db.prepare('SELECT MAX(last_seen) AS seen, COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(u.id, nowMs);
    return { ...u, logins: n('login'), failed: n('failed'), logouts: n('logout'), last_login: last ? last.at : null, last_device: last ? last.device : '',
      last_active: sess.seen ? new Date(sess.seen).toISOString() : null, active_now: !!(sess.seen && nowMs - sess.seen < 15 * 60000), sessions: sess.n };
  });
  const unknown = db.prepare("SELECT COUNT(*) AS n FROM login_log WHERE user_id IS NULL AND event = 'failed' AND substr(at,1,10) BETWEEN ? AND ?").get(from, to).n;
  return { from, to, users, events, unknown_failed: unknown };
}
app.get('/api/staff/admin/logins', requireRole('admin'), wrap((req, res) => res.json(loginReport(req.query))));
app.get('/api/staff/export/logins.csv', requireRole('admin'), wrap((req, res) => {
  const r = loginReport(req.query), label = { login: 'Logged in', failed: 'Failed login', logout: 'Logged out' };
  csv(res, `login-history_${r.from}_to_${r.to}.csv`, r.events.map(e => ({ 'Date': e.at.slice(0, 10), 'Time': e.at.slice(11, 16), 'Name': e.name || '', 'Username': e.username || '', 'Access': e.role || '', 'Event': label[e.event] || e.event, 'Device': e.device, 'IP address': e.ip })));
}));
app.post('/api/staff/employees', requireArea('employees', 2), wrap((req, res) => res.json(saveEmployee(req, null))));
app.put('/api/staff/employees/:id', requireArea('employees', 2), wrap((req, res) => res.json(saveEmployee(req, +req.params.id))));
// audit trail (administrators): access changes, pay / bank detail changes, deletions
app.get('/api/staff/audit', requireRole('admin'), (req, res) => res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all()));

// ---------------------------------------------------------------- staff: timesheets / clock
const hoursOf = t => t.clock_out ? Math.max(0, (Date.parse(t.clock_out + 'Z') - Date.parse(t.clock_in + 'Z')) / 36e5) : 0;
// Unpaid break for a shift (payroll rules): the biggest rule whose 'after_hours' the shift is longer than
const breakRules = () => { try { return (JSON.parse(getSettings().payroll_breaks || '[]') || []).filter(r => +r.after_hours > 0 && +r.minutes > 0); } catch { return []; } };
const breakOf = (t, rules = breakRules()) => { const h = hoursOf(t); const r = rules.filter(x => h > +x.after_hours).sort((a, b) => b.minutes - a.minutes)[0]; return r ? Math.min(h, r.minutes / 60) : 0; };
const deductionsOf = e => { try { return (JSON.parse(e.deductions || '[]') || []).filter(d => d && d.name && +d.amount > 0).map(d => ({ name: String(d.name).slice(0, 60), amount: round2(d.amount) })); } catch { return []; } };
// Clock in / out rules (time clock PIN screen and the staff 'Clock in' button):
//  - one shift per person per day: a second clock-in the same day is refused (a manager adjusts the timesheet)
//  - no clocking in during a shift that's already recorded (e.g. 8:00am–5:00pm entered by a manager)
//  - clocking out within 2 minutes of clocking in is a double tap: that clock-in is cancelled, not saved as 0 hours
const fmt12h = s => { const [h, m] = s.slice(11, 16).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
function punch(userId, now, notes) {
  const open = db.prepare('SELECT * FROM timesheets WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(userId);
  if (open) {
    if (Date.parse(now + 'Z') - Date.parse(open.clock_in + 'Z') < 2 * 60 * 1000) {
      db.prepare('DELETE FROM timesheets WHERE id = ?').run(open.id);
      return { on_shift: false, cancelled: true, open };
    }
    db.prepare('UPDATE timesheets SET clock_out = ? WHERE id = ?').run(now, open.id);
    return { on_shift: false, open };
  }
  const day = now.slice(0, 10);
  const covering = db.prepare('SELECT * FROM timesheets WHERE user_id = ? AND clock_in <= ? AND clock_out > ? LIMIT 1').get(userId, now, now);
  if (covering) bad(`A shift is already recorded ${fmt12h(covering.clock_in)}–${fmt12h(covering.clock_out)} today. Ask a manager to adjust the timesheet.`);
  const done = db.prepare('SELECT * FROM timesheets WHERE user_id = ? AND substr(clock_in,1,10) = ? ORDER BY clock_in LIMIT 1').get(userId, day);
  if (done) bad(`Already clocked in today (${fmt12h(done.clock_in)}${done.clock_out ? '–' + fmt12h(done.clock_out) : ''}). One shift per day: ask a manager to adjust the timesheet.`);
  db.prepare('INSERT INTO timesheets(user_id, clock_in, notes) VALUES(?,?,?)').run(userId, now, notes);
  return { on_shift: true };
}
// a manager's entry can't overlap another shift for the same person
function assertNoOverlap(userId, clockIn, clockOut, exceptId = 0) {
  // a shift still open counts to the end of its day
  const o = db.prepare(`SELECT * FROM timesheets WHERE user_id = ? AND id != ? AND clock_in < ? AND COALESCE(clock_out, substr(clock_in,1,10) || 'T23:59') > ? LIMIT 1`)
    .get(userId, exceptId, clockOut || clockIn.slice(0, 10) + 'T23:59', clockIn);
  if (o) bad(`That overlaps another shift (${o.clock_in.slice(0, 10)} ${fmt12h(o.clock_in)}–${o.clock_out ? fmt12h(o.clock_out) : 'still on shift'}). Edit that one instead.`);
}
app.post('/api/staff/clock', requireStaff, wrap((req, res) => {
  const now = localNowISO(getSettings().timezone);
  const r = punch(req.user.id, now, str(req.body.notes, 200));
  broadcast({ type: 'shift' }, true);
  res.json({ on_shift: r.on_shift, at: now, cancelled: !!r.cancelled });
}));
// Shared time clock (one office PC): any staff member clocks in/out with their own 4-digit PIN.
function newClockPin() {
  for (let i = 0; i < 200; i++) { const p = String(crypto.randomInt(1000, 10000)); if (!db.prepare('SELECT 1 FROM users WHERE clock_pin = ?').get(p)) return p; }
  return String(crypto.randomInt(1000, 10000));
}
for (const u of db.prepare("SELECT id FROM users WHERE clock_pin IS NULL OR clock_pin = ''").all()) db.prepare('UPDATE users SET clock_pin = ? WHERE id = ?').run(newClockPin(), u.id);
const clockFails = new Map();
app.get('/api/staff/timeclock', requirePerm('timeclock.use'), wrap((req, res) => {
  const tz = getSettings().timezone, now = localNowISO(tz), today = now.slice(0, 10);
  const rows = db.prepare(`SELECT id, name, position FROM users WHERE active = 1 AND (COALESCE(on_timeclock, 1) = 1
      OR id IN (SELECT user_id FROM timesheets WHERE clock_out IS NULL)) ORDER BY name`).all().map(u => {
    const open = db.prepare('SELECT clock_in FROM timesheets WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(u.id);
    const done = db.prepare('SELECT * FROM timesheets WHERE user_id = ? AND clock_out IS NOT NULL AND substr(clock_in,1,10) = ?').all(u.id, today);
    const todayHours = done.reduce((a, t) => a + hoursOf(t), 0) + (open ? hoursOf({ clock_in: open.clock_in, clock_out: now }) : 0);
    return { ...u, on_shift: !!open, since: open ? open.clock_in : null, today_hours: round2(todayHours) };
  });
  res.json({ now, staff: rows });
}));
app.post('/api/staff/timeclock/punch', requirePerm('timeclock.use'), wrap((req, res) => {
  const key = req.ip, nowMs = Date.now();
  const fails = (clockFails.get(key) || []).filter(x => nowMs - x < 10 * 60 * 1000);
  if (fails.length >= 10) throw new HttpError(429, 'Too many wrong PINs. Please wait 10 minutes or ask a manager.');
  const u = db.prepare('SELECT id, name, clock_pin FROM users WHERE id = ? AND active = 1').get(+req.body.user_id);
  const override = req.body.override === true && canTimesheets(req.user) && inScope(req.user, 'timesheets', +req.body.user_id, 2);
  if (!u || (!override && (!u.clock_pin || String(req.body.pin || '').trim() !== u.clock_pin))) {
    fails.push(nowMs); clockFails.set(key, fails);
    throw new HttpError(403, 'Wrong PIN. Try again, or ask a manager to check your time-clock PIN.');
  }
  const now = localNowISO(getSettings().timezone);
  const r = punch(u.id, now, override ? `time clock (by ${req.user.name})` : 'time clock');
  const open = r.open;
  if (open && override && !r.cancelled) db.prepare("UPDATE timesheets SET notes = trim(coalesce(notes,'') || ' · out by ' || ?) WHERE id = ?").run(req.user.name, open.id);
  broadcast({ type: 'shift' }, true);
  const shift = open && !r.cancelled ? round2(hoursOf({ clock_in: open.clock_in, clock_out: now })) : null;
  res.json({ name: u.name, on_shift: r.on_shift, at: now, shift_hours: shift, cancelled: !!r.cancelled });
}));

app.post('/api/staff/timesheets/email', requireStaff, wrap(async (req, res) => {
  const from = isDate(req.body.from) ? req.body.from : bad('Choose the dates.'), to = isDate(req.body.to) ? req.body.to : from;
  if (to < from) bad('The end date is before the start date.');
  const mgr = canArea(req, 'timesheets') || canTimesheetsReq(req), userId = mgr ? (req.body.user_id ? +req.body.user_id : null) : req.user.id; // staff: only their own
  const isAdm = canArea(req, 'reports') && !P.teamOnly(req.user);
  if (!isAdm && (userId === null || req.body.to_admin)) throw new HttpError(403, 'All-staff timesheet reports need Reports access. Choose one person.');
  if (userId !== null && !inScope(req.user, 'timesheets', userId)) throw new HttpError(403, "That person isn't in your team.");
  const me = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.user.id);
  // pay (rates, deductions, amount to pay): managers / admins, or someone's own timesheet
  const withPay = (canArea(req, 'payroll') && canArea(req, 'pay_rates')) || userId === req.user.id;
  try { res.json(await mail().emailTimesheet({ from, to, userId, sender: me, withPay, toAdmin: !!req.body.to_admin })); }
  catch (e) { if (e instanceof HttpError) throw e; bad(`The timesheet didn't send yet: ${e.message}`); }
}));
// printable timesheet (same as the email)
app.get('/api/staff/timesheets/sheet', requireStaff, wrap((req, res) => {
  const from = isDate(req.query.from) ? req.query.from : bad('Choose the dates.'), to = isDate(req.query.to) ? req.query.to : from;
  const mgr = canArea(req, 'timesheets') || canTimesheetsReq(req), userId = mgr ? (req.query.user_id ? +req.query.user_id : null) : req.user.id;
  if (userId === null && !(canArea(req, 'reports') && !P.teamOnly(req.user))) throw new HttpError(403, 'All-staff timesheet reports need Reports access. Choose one person.');
  if (userId !== null && !inScope(req.user, 'timesheets', userId)) throw new HttpError(403, "That person isn't in your team.");
  const withPay = (canArea(req, 'payroll') && canArea(req, 'pay_rates')) || userId === req.user.id;
  if (req.query.each === '1' && userId === null) { // each person on their own page
    const ids = db.prepare(`SELECT DISTINCT t.user_id AS id, u.name FROM timesheets t JOIN users u ON u.id = t.user_id WHERE substr(t.clock_in,1,10) BETWEEN ? AND ? AND COALESCE(u.on_timeclock, 1) = 1 ORDER BY u.name`).all(from, to);
    if (!ids.length) return res.json({ html: '<p>No shifts in these dates.</p>', with_pay: withPay, people: 0 });
    return res.json({ html: ids.map((u, i) => `<div style="${i ? 'page-break-before:always;break-before:page;' : ''}padding-top:${i ? 24 : 0}px">${mail().timesheetHtml(from, to, u.id, { withPay }).html}</div>`).join(''), with_pay: withPay, people: ids.length });
  }
  res.json({ html: mail().timesheetHtml(from, to, userId, { withPay }).html, with_pay: withPay });
}));
const tsPinFails = new Map();
app.post('/api/staff/timesheets/unlock', requireStaff, wrap((req, res) => {
  const key = req.ip, nowMs = Date.now();
  const fails = (tsPinFails.get(key) || []).filter(x => nowMs - x < 10 * 60 * 1000);
  if (fails.length >= 8) throw new HttpError(429, 'Too many wrong PINs. Please wait 10 minutes.');
  const pin = String(req.body.pin || '').trim();
  const u = /^\d{4}$/.test(pin) ? db.prepare('SELECT id, name, role, timesheet_admin, perms FROM users WHERE active = 1 AND clock_pin = ?').get(pin) : null;
  if (!u || P.levelOf(u, 'timesheets') < 2) { fails.push(nowMs); tsPinFails.set(key, fails); throw new HttpError(403, "That PIN doesn't have timesheet access."); }
  const token = crypto.randomBytes(18).toString('hex'), until = nowMs + 15 * 60 * 1000;
  tsUnlocks.set(token, { user_id: u.id, name: u.name, until });
  res.json({ token, name: u.name, until });
}));
app.get('/api/staff/timesheets', requireStaff, wrap((req, res) => {
  // with Timesheets access: everyone's (or their team's); otherwise only their own
  const mgr = canArea(req, 'timesheets') || canTimesheetsReq(req), by = tsUnlockOf(req) && !canArea(req, 'timesheets') ? { id: tsUnlockOf(req).user_id } : req.user;
  const w = [], p = [];
  if (!mgr) { w.push('t.user_id = ?'); p.push(req.user.id); } else if (req.query.user_id) { if (!inScope(by, 'timesheets', +req.query.user_id) && !inScope(req.user, 'timesheets', +req.query.user_id)) throw new HttpError(403, "That person isn't in your team."); w.push('t.user_id = ?'); p.push(+req.query.user_id); }
  else { w.push('COALESCE(u.on_timeclock, 1) = 1'); const [sw, sp] = scopeSql(by, 't.user_id'); w.push(sw); p.push(...sp); } // all staff = those on the time clock
  if (isDate(req.query.from)) { w.push('substr(t.clock_in,1,10) >= ?'); p.push(req.query.from); }
  if (isDate(req.query.to)) { w.push('substr(t.clock_in,1,10) <= ?'); p.push(req.query.to); }
  const rows = db.prepare(`SELECT t.*, u.name, COALESCE(u.employee_no, '') AS employee_no, (SELECT name FROM users a WHERE a.id = t.approved_by) AS approved_by_name FROM timesheets t JOIN users u ON u.id=t.user_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY t.clock_in DESC LIMIT 1000`).all(...p);
  const rules = breakRules();
  res.json(rows.map(r => { const b = breakOf(r, rules); return { ...r, hours: round2(hoursOf(r)), break_hours: round2(b), paid_hours: round2(hoursOf(r) - b) }; }));
}));
const isStamp = s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(s || ''));
const ownOnly = (req, uid) => { if (!tsScope(req, uid)) throw new HttpError(403, 'You can enter your own shifts. Entering for other staff needs the timesheet tick (or Admin).'); };
app.post('/api/staff/timesheets', requireStaff, wrap((req, res) => {
  const { user_id, clock_in, clock_out, notes } = req.body;
  ownOnly(req, user_id);
  if (!isStamp(clock_in) || (clock_out && !isStamp(clock_out))) bad('Use valid start/finish times.');
  if (clock_out && clock_out <= clock_in) bad('Finish must be after start.');
  assertNoOverlap(+user_id, clock_in, clock_out);
  const by = tsUnlockOf(req), note = str(notes, 200) + (by ? `${notes ? ' · ' : ''}entered by ${by.name} (PIN)` : '');
  db.prepare('INSERT INTO timesheets(user_id, clock_in, clock_out, notes) VALUES(?,?,?,?)').run(+user_id, clock_in, clock_out || null, note.slice(0, 250));
  res.json({ ok: true });
}));
// Multi-shift entry: many shifts at once (each row: staff member, start, finish, note). Rows that are fine are saved;
// rows with a problem (overlap, bad times) come back with the reason.
app.post('/api/staff/timesheets/bulk', requireStaff, wrap((req, res) => {
  const list = Array.isArray(req.body.entries) ? req.body.entries.slice(0, 300) : [];
  if (!list.length) bad('Add at least one shift.');
  if (list.some(x => !tsScope(req, x.user_id))) throw new HttpError(403, 'Multi-shift entry for other staff needs the timesheet tick (or Admin).');
  const by = tsUnlockOf(req), results = [];
  list.forEach((x, i) => {
    try {
      const u = db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(+x.user_id); if (!u) bad('Choose the staff member.');
      ownOnly(req, u.id);
      if (!isStamp(x.clock_in) || !isStamp(x.clock_out)) bad('Enter the date, start and finish times.');
      if (x.clock_out <= x.clock_in) bad('Finish must be after start.');
      assertNoOverlap(u.id, x.clock_in, x.clock_out);
      const note = (str(x.notes, 200) + (by ? `${x.notes ? ' · ' : ''}entered by ${by.name} (PIN)` : '')).slice(0, 250);
      db.prepare('INSERT INTO timesheets(user_id, clock_in, clock_out, notes) VALUES(?,?,?,?)').run(u.id, x.clock_in, x.clock_out, note);
      results.push({ i, ok: true });
    } catch (e) { results.push({ i, ok: false, error: e.message }); }
  });
  broadcast({ type: 'shift' }, true);
  res.json({ saved: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
}));
app.put('/api/staff/timesheets/:id', requireStaff, wrap((req, res) => {
  const owner = db.prepare('SELECT user_id FROM timesheets WHERE id = ?').get(+req.params.id);
  if (!owner) throw new HttpError(404, 'Not found');
  if (!(canTimesheets(req.user) && inScope(req.user, 'timesheets', owner.user_id, 2)) && !(tsUnlockOf(req) && inScope({ id: tsUnlockOf(req).user_id }, 'timesheets', owner.user_id, 2))) throw new HttpError(403, "You don't have add & edit access to these timesheets. Ask an administrator.");
  const { clock_in, clock_out, notes } = req.body;
  if (!isStamp(clock_in) || (clock_out && !isStamp(clock_out))) bad('Use valid start/finish times.');
  if (clock_out && clock_out <= clock_in) bad('Finish must be after start.');
  const cur = db.prepare('SELECT user_id FROM timesheets WHERE id = ?').get(+req.params.id);
  if (cur) assertNoOverlap(cur.user_id, clock_in, clock_out, +req.params.id);
  const by = tsUnlockOf(req); if (by && !String(notes || '').includes(`by ${by.name} (PIN)`)) req.body.notes = `${notes ? notes + ' · ' : ''}edited by ${by.name} (PIN)`;
  db.prepare('UPDATE timesheets SET clock_in=?, clock_out=?, notes=?, approved_by = NULL, approved_at = NULL WHERE id=?').run(clock_in, clock_out || null, str(req.body.notes, 250), +req.params.id);
  res.json({ ok: true });
}));
app.delete('/api/staff/timesheets/:id', requireArea('timesheets', 3), wrap((req, res) => {
  const t = db.prepare('SELECT t.*, u.name FROM timesheets t JOIN users u ON u.id = t.user_id WHERE t.id = ?').get(+req.params.id); if (!t) throw new HttpError(404, 'Not found');
  if (!inScope(req.user, 'timesheets', t.user_id, 3)) throw new HttpError(403, "That person isn't in your team.");
  db.prepare('DELETE FROM timesheets WHERE id=?').run(t.id); audit(req, 'Deleted a shift', `${t.name}: ${t.clock_in} – ${t.clock_out || 'open'}`); res.json({ ok: true });
}));
// a supervisor (or anyone with add & edit access) approves shifts; approval is shown on the timesheets and cleared if the shift changes
app.post('/api/staff/timesheets/:id/approve', requireArea('timesheets', 2), wrap((req, res) => {
  const t = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(+req.params.id); if (!t) throw new HttpError(404, 'Not found');
  if (!inScope(req.user, 'timesheets', t.user_id, 2)) throw new HttpError(403, "That person isn't in your team.");
  if (!t.clock_out) bad("This shift hasn't finished yet.");
  const on = req.body.approved !== false;
  db.prepare('UPDATE timesheets SET approved_by = ?, approved_at = ? WHERE id = ?').run(on ? req.user.id : null, on ? new Date().toISOString() : null, t.id);
  res.json({ ok: true, approved: on });
}));

// ---------------------------------------------------------------- staff: payroll
function annualTax(income, brackets) {
  let tax = 0;
  for (const b of brackets) {
    const top = b.to == null ? Infinity : b.to;
    if (income > b.from) tax += (Math.min(income, top) - b.from) * (b.rate / 100);
  }
  return tax;
}
// Pay periods: from the pay cycle (a date a period started on + how often). Weekly / fortnightly count on from that
// date; twice a month = 1st–15th and 16th–end; monthly = calendar month (a pay cycle date's day-of-month sets the start).
function payPeriodOf(date, s = getSettings()) {
  const periods = +s.pay_periods_per_year || 26, dd = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  if (periods === 24) { const day = +date.slice(8); if (day <= 15) return [date.slice(0, 8) + '01', date.slice(0, 8) + '15'];
    const last = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7), 0)).toISOString().slice(0, 10); return [date.slice(0, 8) + '16', last]; }
  if (periods === 12) { const sd = isDate(s.pay_cycle_start) ? Math.min(28, +s.pay_cycle_start.slice(8)) : 1;
    let st = date.slice(0, 8) + String(sd).padStart(2, '0'); if (st > date) { const x = new Date(st + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() - 1); st = x.toISOString().slice(0, 10); }
    const e = new Date(st + 'T00:00:00Z'); e.setUTCMonth(e.getUTCMonth() + 1); e.setUTCDate(e.getUTCDate() - 1); return [st, e.toISOString().slice(0, 10)]; }
  const len = periods === 52 ? 7 : 14;
  const anchor = isDate(s.pay_cycle_start) ? s.pay_cycle_start : '2024-01-01'; // 1 Jan 2024 was a Monday
  const n = Math.floor((Date.parse(date) - Date.parse(anchor)) / 864e5 / len);
  const st = dd(anchor, n * len); return [st, dd(st, len - 1)];
}
app.get('/api/staff/payroll/period', requireStaff, wrap((req, res) => {
  const d = isDate(req.query.date) ? req.query.date : todayIn(getSettings().timezone);
  const cur = payPeriodOf(d), prev = payPeriodOf(addDays(cur[0], -1)), next = payPeriodOf(addDays(cur[1], 1));
  res.json({ current: cur, previous: prev, next });
}));
// Pay for any dates (timesheet print / email): split into pay periods from the start date (a weekly / fortnightly / …
// length), work each out (a part period in proportion), and add them up per person
function payForRange(from, to) {
  const periods = +getSettings().pay_periods_per_year || 26, len = { 52: 7, 26: 14, 24: 15, 12: 30 }[periods] || Math.round(365 / periods);
  const sum = {};
  for (let cs = from; cs <= to; ) {
    const [ps, pe] = payPeriodOf(cs), plen = Math.round((Date.parse(pe) - Date.parse(ps)) / 864e5) + 1; // the pay period this falls in
    const ce = pe < to ? pe : to;
    const days = Math.round((Date.parse(ce) - Date.parse(cs)) / 864e5) + 1;
    for (const l of computePayroll(cs, ce, {}, Math.min(1, days / plen))) {
      const t = sum[l.user_id] || (sum[l.user_id] = { ...l, hours: 0, worked_hours: 0, break_hours: 0, base_pay: 0, allowances: 0, gross: 0, fnpf_employee: 0, fnpf_employer: 0, paye: 0, other_deductions: 0, net: 0, deduction_lines: [], periods: 0 });
      for (const k of ['hours', 'worked_hours', 'break_hours', 'base_pay', 'allowances', 'gross', 'fnpf_employee', 'fnpf_employer', 'paye', 'other_deductions', 'net']) t[k] = round2(t[k] + (+l[k] || 0));
      for (const d of l.deduction_lines || []) { const e = t.deduction_lines.find(y => y.name === d.name); if (e) e.amount = round2(e.amount + d.amount); else t.deduction_lines.push({ ...d }); }
      t.periods++;
    }
    const n = new Date(ce + 'T00:00:00Z'); n.setUTCDate(n.getUTCDate() + 1); cs = n.toISOString().slice(0, 10);
  }
  return Object.values(sum).filter(l => l.hours > 0 || l.pay_type === 'salary');
}
app.locals.computePayroll = (from, to) => payForRange(from, to);
app.locals.payPeriodOf = d => payPeriodOf(d); // timesheet emails / print show pay to those allowed
function computePayroll(start, end, adjustments = {}, fraction = 1) { // fraction: share of a pay period (part periods)
  if (!isDate(start) || !isDate(end) || end < start) bad('Choose a valid pay period.');
  const s = getSettings();
  const periods = +s.pay_periods_per_year || 26, eeRate = +s.fnpf_employee_rate || 0, erRate = +s.fnpf_employer_rate || 0;
  let brackets; try { brackets = JSON.parse(s.paye_brackets); } catch { brackets = []; }
  const emps = db.prepare(`SELECT * FROM users WHERE active = 1 AND pay_rate > 0 ORDER BY name`).all();
  const tsStmt = db.prepare(`SELECT * FROM timesheets WHERE user_id=? AND clock_out IS NOT NULL AND substr(clock_in,1,10) BETWEEN ? AND ?`);
  const rules = breakRules();
  return emps.map(e => {
    const shifts = tsStmt.all(e.id, start, end);
    const worked = round2(shifts.reduce((a, t) => a + hoursOf(t), 0)), breaks = round2(shifts.reduce((a, t) => a + breakOf(t, rules), 0));
    const adj = adjustments[e.id] || {};
    // paid hours: unpaid breaks taken off; an admin can adjust them for this pay run (reconciling), with a reason
    const fromSheets = round2(worked - breaks), adjusted = adj.hours !== undefined && adj.hours !== '' && adj.hours !== null && e.pay_type !== 'salary';
    if (adjusted && !(+adj.hours >= 0 && +adj.hours <= 400)) bad(`Check the hours for ${e.name}.`);
    if (adjusted && str(adj.hours_note, 200).trim().length < 3) bad(`Add a reason for changing ${e.name}'s hours.`);
    const hours = adjusted ? round2(+adj.hours) : fromSheets;
    const base = round2(e.pay_type === 'salary' ? e.pay_rate / periods * fraction : hours * e.pay_rate);
    // paid leave in these dates (annual, sick, other paid): hourly staff are paid leave days × hours a day; salary carries on as normal
    const leaveRows = db.prepare('SELECT kind, days FROM staff_leave WHERE user_id = ? AND paid = 1 AND date_from BETWEEN ? AND ?').all(e.id, start, end);
    const leave_lines = Object.values(leaveRows.reduce((a, l) => { const k = l.kind; (a[k] = a[k] || { kind: k, days: 0, hours: 0, amount: 0 }).days = round2(a[k].days + l.days); return a; }, {}))
      .map(l => ({ ...l, hours: round2(l.days * (+s.leave_day_hours || 8)), amount: e.pay_type === 'salary' ? 0 : round2(l.days * (+s.leave_day_hours || 8) * e.pay_rate) }));
    const leave_hours = round2(leave_lines.reduce((a, l) => a + l.hours, 0)), leave_pay = round2(leave_lines.reduce((a, l) => a + l.amount, 0));
    // regular deductions set on the staff member (loan, union …) + anything added for this pay run
    const lines = deductionsOf(e).map(d => ({ ...d, amount: round2(d.amount * fraction) })).filter(d => d.amount > 0);
    if (round2(adj.other_deductions)) lines.push({ name: str(adj.deduction_note, 60) || 'Other (this pay)', amount: round2(adj.other_deductions) });
    const allowances = round2(adj.allowances), other = round2(lines.reduce((a, d) => a + d.amount, 0));
    const gross = round2(base + allowances + leave_pay);
    const fnpf_employee = round2(gross * eeRate / 100), fnpf_employer = round2(gross * erRate / 100);
    const paye = round2(annualTax(gross * periods / fraction, brackets) / periods * fraction); // a part period is taxed in proportion
    return { user_id: e.id, employee_name: e.name, employee_no: e.employee_no || '', position: e.position, pay_type: e.pay_type, pay_rate: e.pay_rate, tin: e.tin, fnpf_no: e.fnpf_no,
      bank_account: e.bank_account, hours, worked_hours: worked, break_hours: breaks, base_pay: base, allowances, gross, fnpf_employee, fnpf_employer, paye, other_deductions: other,
      deduction_lines: lines, leave_lines, leave_hours, leave_pay, regular_deductions: round2(other - round2(adj.other_deductions)),
      timesheet_hours: fromSheets, hours_adjusted: adjusted, hours_note: adjusted ? str(adj.hours_note, 200).trim() : '',
      net: round2(gross - fnpf_employee - paye - other),
      notes: [adjusted ? `Hours adjusted ${fromSheets} → ${round2(+adj.hours)}: ${str(adj.hours_note, 200).trim()}` : '', str(adj.notes, 200)].filter(Boolean).join(' · ') };
  });
}
app.get('/api/staff/payroll/rules', requireArea('payroll'), (req, res) => {
  const s = getSettings();
  const t = todayIn(s.timezone), cur = payPeriodOf(t, s);
  res.json({ breaks: breakRules(), fnpf_employee_rate: +s.fnpf_employee_rate || 0, fnpf_employer_rate: +s.fnpf_employer_rate || 0, pay_periods_per_year: +s.pay_periods_per_year || 26,
    pay_cycle_start: s.pay_cycle_start || '', period_now: cur, period_last: payPeriodOf(addDays(cur[0], -1), s), period_next: payPeriodOf(addDays(cur[1], 1), s),
    deductions: canArea(req, 'pay_rates') ? db.prepare('SELECT id, name, deductions FROM users WHERE active = 1 AND pay_rate > 0 ORDER BY name').all().map(u => ({ id: u.id, name: u.name, deductions: deductionsOf(u) })) : [] });
});
const leaveAdj = (uid, y, k) => round2((db.prepare('SELECT days FROM leave_adjust WHERE user_id = ? AND year = ? AND kind = ?').get(uid, String(y), k) || {}).days || 0);
// Accruals (leave): Admin and Super admin enter, edit and save balances; Super admin removes a record. Staff: no access. Balances = yearly entitlement − taken this calendar year.
const LEAVE_KINDS = { annual: 'Annual leave', sick: 'Sick leave', other: 'Other paid leave', unpaid: 'Unpaid leave' };
app.get('/api/staff/leave', requireArea('leave'), wrap((req, res) => {
  const y = /^\d{4}$/.test(req.query.year || '') ? req.query.year : todayIn(getSettings().timezone).slice(0, 4), s = getSettings();
  const rows = db.prepare(`SELECT l.*, u.name FROM staff_leave l JOIN users u ON u.id = l.user_id WHERE substr(l.date_from, 1, 4) = ? ORDER BY l.date_from DESC, l.id DESC`).all(y);
  const people = db.prepare("SELECT id, name FROM users WHERE active = 1 AND COALESCE(on_timeclock, 1) = 1 ORDER BY name").all().map(u => {
    const t = k => round2(rows.filter(r => r.user_id === u.id && r.kind === k).reduce((a, r) => a + r.days, 0));
    const aa = leaveAdj(u.id, y, 'annual'), sa = leaveAdj(u.id, y, 'sick');
    return { ...u, annual_adj: aa, sick_adj: sa, annual_taken: t('annual'), annual_left: round2((+s.leave_annual_days || 0) + aa - t('annual')), sick_taken: t('sick'), sick_left: round2((+s.leave_sick_days || 0) + sa - t('sick')), other_taken: t('other'), unpaid_taken: t('unpaid') };
  });
  res.json({ year: y, rows, people, kinds: LEAVE_KINDS, settings: { leave_annual_days: s.leave_annual_days, leave_sick_days: s.leave_sick_days, leave_day_hours: s.leave_day_hours } });
}));
app.post('/api/staff/leave', requireArea('leave', 2), wrap((req, res) => {
  const b = req.body || {};
  if (!LEAVE_KINDS[b.kind]) bad('Choose the type of leave.');
  if (!isDate(b.date_from)) bad('Choose the first day of leave.');
  const to = isDate(b.date_to) ? b.date_to : b.date_from; if (to < b.date_from) bad('The last day is before the first day.');
  const days = round2(b.days); if (!(days > 0 && days <= 60)) bad('Enter the number of days (e.g. 1, 0.5, 3).');
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(+b.user_id)) bad('Choose the staff member.');
  db.prepare('INSERT INTO staff_leave(user_id, kind, date_from, date_to, days, paid, notes, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(+b.user_id, b.kind, b.date_from, to, days, b.kind === 'unpaid' ? 0 : 1, str(b.notes, 200), req.user.id, new Date().toISOString());
  res.json({ ok: true });
}));
// save edited balances: the "left" each person should have this year (stored as an adjustment on the yearly allowance)
app.put('/api/staff/leave/balances', requireArea('leave', 2), wrap((req, res) => {
  const b = req.body || {}, y = /^\d{4}$/.test(String(b.year || '')) ? String(b.year) : bad('Choose the year.'), s = getSettings();
  for (const k of ['leave_annual_days', 'leave_sick_days', 'leave_day_hours']) if (b[k] !== undefined && b[k] !== '') { const v = +b[k]; if (!(v >= 0 && v <= 60)) bad('Check the leave numbers.'); setSetting(k, String(v)); }
  const s2 = getSettings();
  const up = db.prepare('INSERT INTO leave_adjust(user_id, year, kind, days) VALUES(?,?,?,?) ON CONFLICT(user_id, year, kind) DO UPDATE SET days = excluded.days');
  for (const p of Array.isArray(b.people) ? b.people : []) for (const [k, ent] of [['annual', +s2.leave_annual_days || 0], ['sick', +s2.leave_sick_days || 0]]) {
    const want = p[k + '_left']; if (want === undefined || want === '' || want === null) continue;
    if (!(+want >= -60 && +want <= 200)) bad('Check the days left.');
    const taken = round2(db.prepare("SELECT COALESCE(SUM(days), 0) AS d FROM staff_leave WHERE user_id = ? AND kind = ? AND substr(date_from, 1, 4) = ?").get(+p.id, k, y).d);
    up.run(+p.id, y, k, round2(+want - ent + taken));
  }
  res.json({ ok: true });
}));
app.put('/api/staff/leave/:id', requireArea('leave', 2), wrap((req, res) => {
  const b = req.body || {}, cur = db.prepare('SELECT * FROM staff_leave WHERE id = ?').get(+req.params.id); if (!cur) throw new HttpError(404, 'Not found');
  const kind = b.kind !== undefined ? b.kind : cur.kind; if (!LEAVE_KINDS[kind]) bad('Choose the type of leave.');
  const from = b.date_from !== undefined ? b.date_from : cur.date_from, to = b.date_to !== undefined ? b.date_to : cur.date_to;
  if (!isDate(from) || !isDate(to) || to < from) bad('Check the dates.');
  const days = b.days !== undefined ? round2(b.days) : cur.days; if (!(days > 0 && days <= 60)) bad('Enter the number of days (e.g. 1, 0.5, 3).');
  db.prepare('UPDATE staff_leave SET kind = ?, date_from = ?, date_to = ?, days = ?, paid = ?, notes = ? WHERE id = ?').run(kind, from, to, days, kind === 'unpaid' ? 0 : 1, str(b.notes !== undefined ? b.notes : cur.notes, 200), cur.id);
  res.json({ ok: true });
}));
app.delete('/api/staff/leave/:id', requireArea('leave', 3), (req, res) => { const l = db.prepare('SELECT l.*, u.name FROM staff_leave l JOIN users u ON u.id = l.user_id WHERE l.id = ?').get(+req.params.id); db.prepare('DELETE FROM staff_leave WHERE id = ?').run(+req.params.id); if (l) audit(req, 'Deleted leave', `${l.name}: ${l.kind} ${l.date_from} (${l.days} days)`); res.json({ ok: true }); });
// (allowances are saved with the balances: PUT /api/staff/leave/balances)
app.put('/api/staff/payroll/rules', requireArea('setup', 2), wrap((req, res) => {
  const b = req.body || {};
  if (Array.isArray(b.deductions) && b.deductions.length) must(req, 'pay_rates', 2);
  if (b.breaks !== undefined) {
    const list = (Array.isArray(b.breaks) ? b.breaks : []).map(r => ({ after_hours: round2(r.after_hours), minutes: Math.round(+r.minutes || 0) })).filter(r => r.after_hours > 0 && r.minutes > 0);
    if (list.some(r => r.minutes > 180 || r.after_hours > 24)) bad('Check the break rules (minutes up to 180, hours up to 24).');
    setSetting('payroll_breaks', JSON.stringify(list));
  }
  for (const k of ['fnpf_employee_rate', 'fnpf_employer_rate']) if (b[k] !== undefined) { const v = +b[k]; if (!(v >= 0 && v <= 50)) bad('FNPF % must be between 0 and 50.'); setSetting(k, String(v)); }
  if (b.pay_periods_per_year !== undefined) { const v = +b.pay_periods_per_year; if (![12, 24, 26, 52].includes(v)) bad('Pay periods per year: 12, 24, 26 or 52.'); setSetting('pay_periods_per_year', String(v)); }
  if (b.pay_cycle_start !== undefined) { if (b.pay_cycle_start && !isDate(b.pay_cycle_start)) bad('Pay period start must be a date.'); setSetting('pay_cycle_start', b.pay_cycle_start || ''); }
  if (Array.isArray(b.deductions)) for (const d of b.deductions) {
    const list = (Array.isArray(d.deductions) ? d.deductions : []).map(x => ({ name: str(x.name, 60).trim(), amount: round2(x.amount) })).filter(x => x.name && x.amount > 0);
    db.prepare('UPDATE users SET deductions = ? WHERE id = ?').run(JSON.stringify(list), +d.id);
  }
  res.json({ ok: true });
}));
const adminOnlyHours = (req, adjustments = {}) => {
  if (canArea(req, 'payroll', 3)) return adjustments;
  for (const a of Object.values(adjustments || {})) if (a && a.hours !== undefined && a.hours !== '') throw new HttpError(403, 'Changing hours in a pay run needs full Pay runs access.');
  return adjustments;
};
app.post('/api/staff/payroll/preview', requireArea('payroll', 2), requireLicence, wrap((req, res) =>
  res.json({ lines: computePayroll(req.body.period_start, req.body.period_end, adminOnlyHours(req, req.body.adjustments)), settings: getSettings() })));
app.post('/api/staff/payroll/runs', requireArea('payroll', 2), requireLicence, wrap((req, res) => {
  const { period_start, period_end, pay_date } = req.body, adjustments = adminOnlyHours(req, req.body.adjustments);
  if (!isDate(pay_date)) bad('Choose a pay date.');
  const lines = computePayroll(period_start, period_end, adjustments);
  if (!lines.length) bad('No paid employees to include. Set pay rates under Staff first.');
  const sum = k => round2(lines.reduce((a, l) => a + l[k], 0));
  db.exec('BEGIN');
  try {
    const runId = db.prepare(`INSERT INTO payroll_runs(period_start, period_end, pay_date, created_by, total_gross, total_net, total_fnpf_employer) VALUES(?,?,?,?,?,?,?)`)
      .run(period_start, period_end, pay_date, req.user.id, sum('gross'), sum('net'), sum('fnpf_employer')).lastInsertRowid;
    const ins = db.prepare(`INSERT INTO payslips(run_id, user_id, employee_name, position, pay_type, pay_rate, hours, base_pay, allowances, gross, fnpf_employee, fnpf_employer, paye, other_deductions, net, notes, worked_hours, break_hours, deduction_lines, leave_hours, leave_pay, leave_lines)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const l of lines) ins.run(runId, l.user_id, l.employee_name, l.position, l.pay_type, l.pay_rate, l.hours, l.base_pay, l.allowances, l.gross, l.fnpf_employee, l.fnpf_employer, l.paye, l.other_deductions, l.net, l.notes, l.worked_hours, l.break_hours, JSON.stringify(l.deduction_lines), l.leave_hours || 0, l.leave_pay || 0, JSON.stringify(l.leave_lines || []));
    db.exec('COMMIT');
    res.json({ id: runId });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}));
app.get('/api/staff/payroll/runs', requireArea('payroll'), (req, res) =>
  res.json(db.prepare(`SELECT r.*, u.name AS created_by_name, (SELECT COUNT(*) FROM payslips p WHERE p.run_id=r.id) AS employees FROM payroll_runs r LEFT JOIN users u ON u.id=r.created_by ORDER BY r.pay_date DESC, r.id DESC`).all()));
app.get('/api/staff/payroll/runs/:id', requireArea('payroll'), wrap((req, res) => {
  const run = db.prepare('SELECT * FROM payroll_runs WHERE id=?').get(+req.params.id);
  if (!run) throw new HttpError(404, 'Not found');
  res.json({ run, payslips: db.prepare(`SELECT p.*, u.tin, u.fnpf_no, u.bank_account FROM payslips p LEFT JOIN users u ON u.id=p.user_id WHERE run_id=? ORDER BY employee_name`).all(run.id)
    .map(p => ({ ...p, ytd: ytdOf(p.user_id, run.period_end, null, run.id) })) });
}));
app.delete('/api/staff/payroll/runs/:id', requireArea('payroll', 3), (req, res) => { const r = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(+req.params.id); db.prepare('DELETE FROM payroll_runs WHERE id=?').run(+req.params.id); if (r) audit(req, 'Deleted a pay run', `Paid ${r.pay_date} (${r.period_start} to ${r.period_end})`); res.json({ ok: true }); });
// Year to date (calendar / tax year of the period end): finalised payslips in that year up to this one (+ this draft),
// and leave taken this year against the yearly entitlement
function ytdOf(userId, periodEnd, draft = null, runId = null) {
  const y = String(periodEnd).slice(0, 4), s = getSettings();
  const rows = db.prepare(`SELECT p.* FROM payslips p JOIN payroll_runs r ON r.id = p.run_id WHERE p.user_id = ? AND substr(r.period_end, 1, 4) = ? AND (r.period_end < ? OR r.id = ?)`).all(userId, y, periodEnd, runId || 0);
  // pay made before this system (imported wage reports) in that year, up to the month of this pay
  const hist = db.prepare(`SELECT hours, gross, paye, fnpf_employee, fnpf_employer, other_deductions, net FROM pay_history WHERE user_id = ? AND substr(month, 1, 4) = ? AND month <= ?`).all(userId, y, String(periodEnd).slice(0, 7));
  const all = [...hist, ...rows, ...(draft ? [draft] : [])], sum = k => round2(all.reduce((a, p) => a + (+p[k] || 0), 0));
  const lv = db.prepare(`SELECT kind, SUM(days) AS days FROM staff_leave WHERE user_id = ? AND substr(date_from, 1, 4) = ? AND date_from <= ? GROUP BY kind`).all(userId, y, periodEnd);
  const taken = k => round2((lv.find(l => l.kind === k) || {}).days || 0), adj = k => leaveAdj(userId, y, k);
  return { year: y, pays: rows.length + (draft ? 1 : 0), history_weeks: hist.length, hours: sum('hours'), gross: sum('gross'), paye: sum('paye'), fnpf_employee: sum('fnpf_employee'), fnpf_employer: sum('fnpf_employer'),
    fnpf_total: round2(sum('fnpf_employee') + sum('fnpf_employer')), deductions: sum('other_deductions'), net: sum('net'), leave_pay: sum('leave_pay'),
    annual_taken: taken('annual'), annual_left: round2((+s.leave_annual_days || 0) + adj('annual') - taken('annual')), sick_taken: taken('sick'), sick_left: round2((+s.leave_sick_days || 0) + adj('sick') - taken('sick')),
    other_taken: taken('other'), unpaid_taken: taken('unpaid') };
}
// Payslips for any dates and any person: per pay period, the finalised payslip from a pay run if there is one,
// otherwise a draft worked out now from the timesheets (marked DRAFT; a part pay period is in proportion).
const dayAdd = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayCount = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
function payslipsFor(from, to, userId, drafts = true) {
  if (!isDate(from) || !isDate(to) || to < from) bad('Choose the dates.');
  if (dayCount(from, to) > 400) bad('Choose a shorter range (up to about a year).');
  const out = [], seen = new Set();
  for (let cs = from; cs <= to; ) {
    const [ps, pe] = payPeriodOf(cs), a = ps > from ? ps : from, b = pe < to ? pe : to;
    const finals = db.prepare(`SELECT p.*, r.period_start, r.period_end, r.pay_date, u.tin, u.fnpf_no, u.bank_account FROM payslips p JOIN payroll_runs r ON r.id = p.run_id
      LEFT JOIN users u ON u.id = p.user_id WHERE r.period_start <= ? AND r.period_end >= ? ${userId ? 'AND p.user_id = ?' : ''} ORDER BY r.id DESC`).all(b, a, ...(userId ? [userId] : []));
    const have = new Set();
    for (const p of finals) { if (have.has(p.user_id)) continue; have.add(p.user_id); if (!seen.has('f' + p.id)) { seen.add('f' + p.id); out.push({ ...p, status: 'final', ytd: ytdOf(p.user_id, p.period_end, null, p.run_id) }); } }
    for (const l of drafts ? computePayroll(a, b, {}, Math.min(1, dayCount(a, b) / dayCount(ps, pe))) : []) {
      if ((userId && l.user_id !== userId) || have.has(l.user_id) || !(l.hours > 0 || l.pay_type === 'salary')) continue;
      const u = db.prepare('SELECT tin, fnpf_no, bank_account FROM users WHERE id = ?').get(l.user_id) || {};
      const d = { ...l, ...u, period_start: a, period_end: b, pay_date: '', status: 'draft', part: a !== ps || b !== pe, full_period: [ps, pe] };
      out.push({ ...d, ytd: ytdOf(l.user_id, b, d) });
    }
    cs = dayAdd(pe, 1);
  }
  return out.sort((x, y) => String(x.employee_name).localeCompare(String(y.employee_name)) || String(x.period_start).localeCompare(String(y.period_start)));
}
app.get('/api/staff/payslips/build', requireArea('payroll'), wrap((req, res) =>
  // without Payroll's licence: the payslips from finished pay runs (to see and print), but no new draft ones
  res.json({ payslips: payslipsFor(req.query.from, req.query.to, req.query.user_id ? +req.query.user_id : null, licenceNow().licensed) })));
// email each person their own payslip(s) for the dates (to the email on their Staff record)
app.post('/api/staff/payslips/email', requireArea('payroll', 2), wrap(async (req, res) => {
  const list = payslipsFor(req.body.from, req.body.to, req.body.user_id ? +req.body.user_id : null, licenceNow().licensed);
  if (!list.length) bad('No payslips for these dates (no paid hours, or no pay rate set under Staff).');
  const by = {}; list.forEach(p => (by[p.user_id] = by[p.user_id] || []).push(p));
  const sent = [], missing = [];
  for (const [uid, ps] of Object.entries(by)) {
    const u = db.prepare('SELECT name, email FROM users WHERE id = ?').get(+uid) || {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email || '')) { missing.push(u.name || ps[0].employee_name); continue; }
    try { await mail().emailPayslips(u, ps); sent.push(u.name); }
    catch (e) { if (e instanceof HttpError) throw e; bad(`Payslips didn't send yet: ${e.message}`); }
  }
  res.json({ sent, missing });
}));
// everyone sees their own finalised payslips (employee self-service)
app.get('/api/staff/payslips/mine', requireStaff, (req, res) =>
  res.json(db.prepare(`SELECT p.*, r.period_start, r.period_end, r.pay_date FROM payslips p JOIN payroll_runs r ON r.id=p.run_id WHERE p.user_id=? ORDER BY r.pay_date DESC`).all(req.user.id)));

// ---------------------------------------------------------------- staff: settings & exports
app.get('/api/staff/settings', requireStaff, (req, res) => res.json(getSettings()));
app.put('/api/staff/settings', requireArea('setup', 2), wrap((req, res) => {
  const allowed = Object.keys(getSettings());
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed.includes(k)) continue;
    if (k === 'paye_brackets') { try { const b = JSON.parse(v); if (!Array.isArray(b)) throw 0; } catch { bad('PAYE brackets must be a JSON list.'); } }
    if (['normal_start', 'normal_finish'].includes(k) && !isTime(v)) bad('Times must be like 09:00.');
    if (k === 'normal_week_hours' && !(+v > 0 && +v <= 100)) bad('Normal week hours must be between 1 and 100.');
    if (k === 'booking_permissions') {
      let p; try { p = typeof v === 'string' ? JSON.parse(v) : v; } catch { bad('Permissions must be JSON.'); }
      for (const [a, r] of Object.entries(p || {})) if (!PERMISSION_LABELS[a] || !ROLE_RANK[r]) bad(`Bad permission ${a}=${r}`);
      setSetting(k, JSON.stringify(p)); continue;
    }
    setSetting(k, str(v, 5000));
  }
  res.json(getSettings());
}));
function csv(res, filename, rows) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send([cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n'));
}
require('./mailer')(app, { db, requireRole: () => requireArea('setup', 2), wrap, bad, str, getSettings, setSetting });
const mail = () => app.locals.mail || {};
require('./desktop')(app, { db, requireRole, requireArea, wrap, bad, str, getSettings, setSetting, hashPassword });
require('./bank')(app, { db, requireRole, requireArea, audit, wrap, bad, str, isDate });
require('./archive')(app, { db, DATA_DIR, DEFAULT_SETTINGS, requireRole, rateLimit, audit, wrap, bad, str, verifyPassword, getSettings, setSetting });
require('./wages')(app, { db, requireRole, requireArea, must, audit, wrap, bad, HttpError, str, round2, isDate, getSettings, ROLE_RANK, newClockPin, hashPassword, requireLicence });
// demo mode: the first time, fill the demo records with the made-up business (Sample Trading Co)
if (DEMO) require('./demo').seed({ db, hashPassword, getSettings, setSetting, computePayroll, payPeriodOf, todayIn, addDays });

app.get('/api/staff/export/:what.csv', requireStaff, wrap((req, res) => {
  const from = isDate(req.query.from) ? req.query.from : '0000-01-01', to = isDate(req.query.to) ? req.query.to : '9999-12-31';
  const mgr = canArea(req, 'payroll') && canArea(req, 'reports');
  switch (req.params.what) {
    case 'payslips': if (!mgr) throw new HttpError(403, 'Needs Pay runs and Reports access.');
      return csv(res, 'payslips.csv', db.prepare('SELECT r.pay_date, r.period_start, r.period_end, p.* FROM payslips p JOIN payroll_runs r ON r.id=p.run_id WHERE r.pay_date BETWEEN ? AND ? ORDER BY r.pay_date, p.employee_name').all(from, to));
    case 'pay-history': if (!mgr) throw new HttpError(403, 'Needs Pay runs and Reports access.');
      return csv(res, 'pay-history.csv', db.prepare('SELECT h.month, h.week, u.name, h.hours, h.rate, h.bonus, h.gross, h.fnpf_employee, h.fnpf_employer, h.paye, h.other_deductions, h.net, h.comment, h.source FROM pay_history h JOIN users u ON u.id = h.user_id ORDER BY h.month, u.name, h.week').all());
    default: throw new HttpError(404, 'Unknown export');
  }
}));

// ---------------------------------------------------------------- errors
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof LockedError) return res.status(402).json({ error: err.message, locked: true, ...err.locked });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

if (require.main === module) server.listen(PORT, process.env.HOST || undefined, () => console.log(`Riyeser Payroll running on http://localhost:${PORT}`));
module.exports = { app, server };
