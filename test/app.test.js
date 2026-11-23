// Run with: npm test
// Starts the server on a spare port with a throwaway database, then checks the main features.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const ExcelJS = require('exceljs');

const PORT = 3998;
const B = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-test-'));
let server;

function futureWeekday(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 864e5);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = futureWeekday(3);
function addDaysISO(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const round = n => Math.round(n * 100) / 100;

async function call(method, url, body, cookie) {
  const res = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function login(username, password) {
  const r = await call('POST', '/api/auth/login', { username, password });
  assert.equal(r.status, 200, `login ${username} failed: ${JSON.stringify(r.data)}`);
  return r.cookie;
}

before(async () => {
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR, ADMIN_PASSWORD: 'AdminPass123', TRUST_PROXY: '1' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(B + '/api/public/info'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('Server did not start');
});
after(async () => {
  // Wait for the test server to close before removing its folder: on Windows an open database file can't be deleted.
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000); });
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp folder; Windows tidies it later */ }
});

let admin, staff;

test('staff pages need a login; wrong password refused', async () => {
  assert.equal((await call('GET', '/api/staff/timesheets')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
});

test('admin can log in and create a staff member; old pages are gone', async () => {
  admin = await login('admin', 'AdminPass123');
  const r = await call('POST', '/api/staff/employees', { name: 'Sera Tui', username: 'sera', password: 'staffpass1', role: 'staff', pay_type: 'hourly', pay_rate: 6 }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  staff = await login('sera', 'staffpass1');
  for (const u of ['/api/staff/teesheet', '/api/public/slots', '/api/staff/carts', '/api/staff/members', '/api/staff/chat']) assert.equal((await call('GET', u, null, admin)).status, 404, u);
});

test('Defaults: 40-hour week, 9 to 5, weekly pay, no unpaid break, FNPF 8% / 10%', async () => {
  const s = (await call('GET', '/api/staff/settings', null, admin)).data;
  assert.equal(s.company_name, 'My Company');
  assert.equal(s.normal_week_hours, '40'); assert.equal(s.normal_start, '09:00'); assert.equal(s.normal_finish, '17:00');
  assert.equal(s.pay_periods_per_year, '52'); assert.equal(s.payroll_breaks, '[]');
  assert.equal(s.fnpf_employee_rate, '8'); assert.equal(s.fnpf_employer_rate, '10');
  // a 9am–5pm day is 8 paid hours
  const sera = (await call('GET', '/api/staff/employees', null, admin)).data.find(u => u.username === 'sera');
  const d = futureWeekday(200);
  await call('POST', '/api/staff/timesheets', { user_id: sera.id, clock_in: `${d}T09:00`, clock_out: `${d}T17:00` }, admin);
  assert.equal((await call('GET', `/api/staff/timesheets?user_id=${sera.id}&from=${d}&to=${d}`, null, admin)).data[0].paid_hours, 8);
  // only a Super admin changes settings; bad values refused
  assert.equal((await call('PUT', '/api/staff/settings', { normal_week_hours: '38' }, staff)).status, 403);
  assert.equal((await call('PUT', '/api/staff/settings', { normal_week_hours: '0' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/staff/settings', { normal_start: '9am' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/staff/settings', { normal_week_hours: '40' }, admin)).status, 200);
});
test('payroll calculates FNPF and net pay', async () => {
  const users = await call('GET', '/api/staff/employees', null, admin);
  const sera = users.data.find(u => u.username === 'sera');
  await call('POST', '/api/staff/timesheets', { user_id: sera.id, clock_in: `${DAY}T07:00`, clock_out: `${DAY}T15:00` }, admin);
  const r = await call('POST', '/api/staff/payroll/preview', { period_start: DAY, period_end: DAY }, admin);
  const line = r.data.lines.find(l => l.user_id === sera.id);
  assert.equal(line.hours, 8);
  assert.equal(line.gross, 48);
  assert.equal(line.fnpf_employee, 3.84);
  assert.equal(line.net, 48 - 3.84 - line.paye);
});

test('time clock: any staff member clocks in/out on the office login with their own PIN', async () => {
  // the "office" login is an ordinary staff-level account
  const r = await call('POST', '/api/staff/employees', { name: 'Office PC', username: 'office', password: 'officepass1', role: 'staff' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const office = await login('office', 'officepass1');
  const emps = (await call('GET', '/api/staff/employees', null, admin)).data;
  const sera = emps.find(e => e.username === 'sera');
  assert.match(sera.clock_pin, /^\d{4}$/);                     // everyone gets a PIN automatically
  assert.match(r.data.clock_pin, /^\d{4}$/);
  const board = (await call('GET', '/api/staff/timeclock', null, office)).data;
  assert.ok(board.staff.some(s => s.name === 'Sera Tui'));
  assert.ok(!('clock_pin' in board.staff[0]));                  // PINs never shown on the shared screen
  const wrong = sera.clock_pin === '0000' ? '1111' : '0000';
  assert.equal((await call('POST', '/api/staff/timeclock/punch', { user_id: sera.id, pin: wrong }, office)).status, 403);
  const inn = await call('POST', '/api/staff/timeclock/punch', { user_id: sera.id, pin: sera.clock_pin }, office);
  assert.equal(inn.status, 200); assert.equal(inn.data.on_shift, true);
  assert.equal((await call('GET', '/api/staff/timeclock', null, office)).data.staff.find(s => s.id === sera.id).on_shift, true);
  // clocking straight back out (double tap) cancels the clock-in: no 0-hour entry
  const tap = await call('POST', '/api/staff/timeclock/punch', { user_id: sera.id, pin: sera.clock_pin }, office);
  assert.equal(tap.data.on_shift, false); assert.equal(tap.data.cancelled, true);
  assert.ok(!(await call('GET', `/api/staff/timesheets?user_id=${sera.id}`, null, admin)).data.some(t => t.notes === 'time clock'));
  // a real shift: clock in, (started 3 hours ago), clock out
  await call('POST', '/api/staff/timeclock/punch', { user_id: sera.id, pin: sera.clock_pin }, office);
  let open = (await call('GET', `/api/staff/timesheets?user_id=${sera.id}`, null, admin)).data.find(t => !t.clock_out);
  const earlier = new Date(Date.parse(open.clock_in + 'Z') - 3 * 36e5).toISOString().slice(0, 16);
  const put = await call('PUT', `/api/staff/timesheets/${open.id}`, { clock_in: earlier, clock_out: '', notes: 'time clock' }, admin); assert.equal(put.status, 200, JSON.stringify(put.data));
  const out = await call('POST', '/api/staff/timeclock/punch', { user_id: sera.id, pin: sera.clock_pin }, office);
  assert.equal(out.data.on_shift, false); assert.ok(out.data.shift_hours >= 2.9);
  const ts = (await call('GET', `/api/staff/timesheets?user_id=${sera.id}`, null, admin)).data;
  assert.ok(ts.some(t => t.notes === 'time clock' && t.clock_out));
  // one shift per day: a second clock-in today is refused
  const again = await call('POST', '/api/staff/timeclock/punch', { user_id: sera.id, pin: sera.clock_pin }, office);
  assert.equal(again.status, 400); assert.match(again.data.error, /One shift per day/);
  // a manager can't add a shift that overlaps one already recorded
  const day = ts[0].clock_in.slice(0, 10);
  assert.equal((await call('POST', '/api/staff/timesheets', { user_id: sera.id, clock_in: earlier, clock_out: ts.find(t => t.notes === 'time clock').clock_out }, admin)).status, 400);
  // managers can change a PIN; duplicates and bad PINs are refused
  assert.equal((await call('PUT', `/api/staff/employees/${sera.id}`, { clock_pin: '12' }, admin)).status, 400);
  const other = emps.find(e => e.username === 'admin');
  assert.equal((await call('PUT', `/api/staff/employees/${sera.id}`, { clock_pin: other.clock_pin }, admin)).status, 400);
  assert.equal((await call('PUT', `/api/staff/employees/${sera.id}`, { clock_pin: '4826' === other.clock_pin ? '4827' : '4826' }, admin)).status, 200);
  // not logged in = no access
  assert.equal((await call('GET', '/api/staff/timeclock')).status, 401);
});

test('front-of-house staff ticked for timesheets can enter and change times for everyone (deleting needs Full)', async () => {
  const r = await call('POST', '/api/staff/employees', { name: 'Litia FOH', username: 'foh', password: 'fohpass12', role: 'staff', timesheet_admin: true }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.timesheet_admin, 1);
  const foh = await login('foh', 'fohpass12');
  const me = (await call('GET', '/api/auth/me', null, foh)).data;
  assert.equal(me.user.role, 'staff');
  assert.equal(me.user.timesheets, true);
  const emps = (await call('GET', '/api/staff/employees', null, admin)).data;
  const sera = emps.find(e => e.username === 'sera');
  const day = futureWeekday(10);
  // add, see and fix another person's shift
  { const q = (await call('POST', '/api/staff/timesheets', { user_id: sera.id, clock_in: `${day}T08:00`, clock_out: `${day}T12:00`, notes: 'paper roster' }, foh)); assert.equal(q.status, 200, JSON.stringify(q.data)); }
  const list = (await call('GET', `/api/staff/timesheets?user_id=${sera.id}&from=${day}&to=${day}`, null, foh)).data;
  const shift = list.find(t => t.notes === 'paper roster');
  assert.equal(shift.hours, 4);
  assert.equal((await call('PUT', `/api/staff/timesheets/${shift.id}`, { clock_in: `${day}T08:00`, clock_out: `${day}T13:00`, notes: 'fixed' }, foh)).status, 200); // Add & edit: can change
  assert.equal((await call('DELETE', `/api/staff/timesheets/${shift.id}`, null, foh)).status, 403);
  assert.equal((await call('POST', '/api/staff/timesheets/email', { from: day, to: day, to_admin: true }, foh)).status, 403); // reports: Admin
  const mgr = (await call('POST', '/api/staff/employees', { name: 'Admin Level', username: 'adminlvl', password: 'adminlvl12', role: 'manager' }, admin)).data;
  const am = (await (async () => { const x = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.9.9' }, body: JSON.stringify({ username: 'adminlvl', password: 'adminlvl12' }) }); assert.equal(x.status, 200); return x.headers.get('set-cookie').split(';')[0]; })());
  assert.equal((await call('PUT', `/api/staff/timesheets/${shift.id}`, { clock_in: `${day}T08:00`, clock_out: `${day}T13:00`, notes: 'fixed' }, am)).status, 200); // Admin edits
  assert.equal((await call('DELETE', `/api/staff/timesheets/${shift.id}`, null, am)).status, 403); // only Super admin deletes
  assert.equal(mgr.role, 'manager');
  // plain staff can enter their own shift, not someone else's
  const meStaff = (await call('GET', '/api/auth/me', null, staff)).data.user;
  const d2 = futureWeekday(45);
  assert.equal((await call('POST', '/api/staff/timesheets', { user_id: meStaff.id, clock_in: `${d2}T08:00`, clock_out: `${d2}T12:00` }, staff)).status, 200);
  assert.equal((await call('POST', '/api/staff/timesheets', { user_id: r.data.id, clock_in: `${d2}T08:00`, clock_out: `${d2}T12:00` }, staff)).status, 403);
  // clock someone in/out on the office PC without their PIN (clear today's shift from the earlier test first: one shift a day)
  const todayISO = (await call('GET', '/api/public/info')).data.today;
  for (const t of (await call('GET', `/api/staff/timesheets?user_id=${sera.id}&from=${todayISO}&to=${todayISO}`, null, foh)).data) await call('DELETE', `/api/staff/timesheets/${t.id}`, null, admin);
  const p1 = await call('POST', '/api/staff/timeclock/punch', { user_id: sera.id, override: true }, foh);
  assert.equal(p1.status, 200); assert.equal(p1.data.on_shift, true);
  await call('POST', '/api/staff/timeclock/punch', { user_id: sera.id, override: true }, foh);
  // still no manager powers
  assert.equal((await call('GET', '/api/staff/employees', null, foh)).status, 403);
  assert.equal((await call('POST', '/api/staff/payroll/preview', { period_start: day, period_end: day }, foh)).status, 403);
  // ordinary staff can't enter for someone else or punch them in
  assert.equal((await call('POST', '/api/staff/timesheets', { user_id: r.data.id, clock_in: `${day}T08:00`, clock_out: `${day}T09:00` }, staff)).status, 403);
  assert.equal((await call('POST', '/api/staff/timeclock/punch', { user_id: sera.id, override: true }, staff)).status, 403);
  const own = (await call('GET', '/api/staff/timesheets', null, staff)).data;
  assert.ok(own.every(t => t.name === 'Sera Tui'));
});

test('time clock and timesheets show front-of-house staff (or ticked) only', async () => {
  const mgr = (await call('POST', '/api/staff/employees', { name: 'Office Manager', username: 'offmgr', password: 'offmgrpass1', role: 'manager' }, admin)).data;
  assert.equal(mgr.on_timeclock, 0);
  const foh = (await call('POST', '/api/staff/employees', { name: 'Bar Staff', username: 'barstaff', password: 'barstaff12', role: 'staff' }, admin)).data;
  assert.equal(foh.on_timeclock, 1);
  let board = (await call('GET', '/api/staff/timeclock', null, admin)).data.staff;
  assert.ok(board.some(s => s.id === foh.id)); assert.ok(!board.some(s => s.id === mgr.id));
  // a manager's shift added by hand doesn't show under 'All staff' until they're ticked
  const day = futureWeekday(3);
  await call('POST', '/api/staff/timesheets', { user_id: mgr.id, clock_in: `${day}T09:00`, clock_out: `${day}T10:00` }, admin);
  assert.ok(!(await call('GET', `/api/staff/timesheets?from=${day}&to=${day}`, null, admin)).data.some(t => t.user_id === mgr.id));
  assert.equal((await call('PUT', `/api/staff/employees/${mgr.id}`, { on_timeclock: true }, admin)).status, 200);
  assert.ok((await call('GET', `/api/staff/timesheets?from=${day}&to=${day}`, null, admin)).data.some(t => t.user_id === mgr.id));
  board = (await call('GET', '/api/staff/timeclock', null, admin)).data.staff;
  assert.ok(board.some(s => s.id === mgr.id));
});

test('login history: logins, failed attempts and log outs are recorded; report is admin only', async () => {
  assert.equal((await call('POST', '/api/auth/login', { username: 'sera', password: 'wrong-password' })).status, 401);
  await call('POST', '/api/auth/login', { username: 'nobody-here', password: 'x' });
  const r = (await call('GET', '/api/staff/admin/logins', null, admin)).data;
  assert.ok(r.events.some(e => e.event === 'login'));
  assert.ok(r.events.some(e => e.event === 'failed' && e.username === 'sera'));
  assert.ok(r.unknown_failed >= 1);
  const me = r.users.find(u => u.username === 'admin');
  assert.ok(me.logins >= 1); assert.ok(me.last_login); assert.equal(me.active_now, true);
  assert.equal((await call('GET', '/api/staff/admin/logins', null, staff)).status, 403);
  const csvText = await fetch(`${B}/api/staff/export/logins.csv`, { headers: { Cookie: admin } }).then(x => x.text());
  assert.match(csvText.split('\n')[0], /Date,Time,Name,Username,Access,Event,Device,IP address/);
});

test('payroll rules: unpaid breaks come off paid hours; regular deductions on the payslip; admin edits', async () => {
  const emp = (await call('POST', '/api/staff/employees', { name: 'Break Tester', username: 'breaktest', password: 'breaktest1', role: 'staff', pay_type: 'hourly', pay_rate: 10 }, admin)).data;
  const day = futureWeekday(30);
  // two shifts: 8h (over 5h: 30 min break) and 4h (no break)
  await call('POST', '/api/staff/timesheets', { user_id: emp.id, clock_in: `${day}T08:00`, clock_out: `${day}T16:00` }, admin);
  const d2 = futureWeekday(31);
  await call('POST', '/api/staff/timesheets', { user_id: emp.id, clock_in: `${d2}T08:00`, clock_out: `${d2}T12:00` }, admin);
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { breaks: [{ after_hours: 5, minutes: 30 }] }, staff)).status, 403);
  const save = await call('PUT', '/api/staff/payroll/rules', { breaks: [{ after_hours: 5, minutes: 30 }], deductions: [{ id: emp.id, deductions: [{ name: 'Staff loan', amount: 20 }] }] }, admin);
  assert.equal(save.status, 200, JSON.stringify(save.data));
  const from = day < d2 ? day : d2, to = day < d2 ? d2 : day;
  const prev = (await call('POST', '/api/staff/payroll/preview', { period_start: from, period_end: to, adjustments: { [emp.id]: { other_deductions: 5 } } }, admin)).data;
  const l = prev.lines.find(x => x.user_id === emp.id);
  assert.equal(l.worked_hours, 12); assert.equal(l.break_hours, 0.5); assert.equal(l.hours, 11.5); assert.equal(l.base_pay, 115);
  assert.equal(l.other_deductions, 25); assert.deepEqual(l.deduction_lines.map(d => d.name), ['Staff loan', 'Other (this pay)']);
  const ts = (await call('GET', `/api/staff/timesheets?user_id=${emp.id}&from=${day}&to=${day}`, null, admin)).data[0];
  assert.equal(ts.break_hours, 0.5); assert.equal(ts.paid_hours, 7.5);
});

test('timesheet PIN: someone with timesheet access unlocks entering all staff timesheets for 15 minutes', async () => {
  const sup = (await call('POST', '/api/staff/employees', { name: 'FOH Supervisor', username: 'fohsup', password: 'fohsup1234', role: 'staff', timesheet_admin: true, clock_pin: '7311' }, admin)).data;
  const plain = (await call('POST', '/api/staff/employees', { name: 'Plain Staff', username: 'plainst', password: 'plainst123', role: 'staff', clock_pin: '7312' }, admin)).data;
  const day = futureWeekday(40);
  // the logged-in staff account can't
  assert.equal((await call('POST', '/api/staff/timesheets', { user_id: plain.id, clock_in: `${day}T08:00`, clock_out: `${day}T12:00` }, staff)).status, 403);
  assert.equal((await call('POST', '/api/staff/timesheets/unlock', { pin: '7312' }, staff)).status, 403); // no timesheet access
  const un = await call('POST', '/api/staff/timesheets/unlock', { pin: '7311' }, staff);
  assert.equal(un.status, 200); assert.equal(un.data.name, 'FOH Supervisor');
  const r = await fetch(B + '/api/staff/timesheets', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: staff, 'X-TS-Unlock': un.data.token },
    body: JSON.stringify({ user_id: plain.id, clock_in: `${day}T08:00`, clock_out: `${day}T12:00` }) });
  assert.equal(r.status, 200);
  const ts = (await call('GET', `/api/staff/timesheets?user_id=${plain.id}&from=${day}&to=${day}`, null, admin)).data;
  assert.match(ts[0].notes, /entered by FOH Supervisor \(PIN\)/);
  assert.equal(sup.timesheet_admin, 1);
});

test('email over the provider limit is kept and resent later, with a plain message', async () => {
  const net = require('node:net');
  const smtp = net.createServer(sock => { let buf = ''; sock.write('220 t\r\n');
    sock.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); const c4 = l.slice(0, 4).toUpperCase();
      if (c4 === 'EHLO' || c4 === 'HELO') sock.write('250-t\r\n250 AUTH PLAIN\r\n');
      else if (c4 === 'DATA') sock.write('554 5.7.1 <DATA>: Data command rejected: Reject: too many messages from sender in last 60 minutes\r\n');
      else if (c4 === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 OK\r\n'); } }); });
  await new Promise(r => smtp.listen(0, r));
  try {
    await call('PUT', '/api/staff/email', { smtp_host: '127.0.0.1', smtp_port: String(smtp.address().port), smtp_secure: 'none', email_from: 'bookings@club.test' }, admin);
    const r = await call('POST', '/api/staff/email/test', { to: 'me@club.test' }, admin);
    assert.equal(r.status, 400); assert.match(r.data.error, /limit on emails per hour/); assert.match(r.data.error, /send again automatically/);
    const e = (await call('GET', '/api/staff/email', null, admin)).data;
    assert.ok(e.waiting >= 1); assert.equal(e.log[0].status, 'waiting');
  } finally { smtp.close(); }
});

test('daily timesheets report: sent to the people ticked for it', async () => {
  const net = require('node:net'); const got = [];
  const smtp = net.createServer(sock => { let data = false, buf = '', msg = { to: [] }; sock.write('220 t\r\n');
    sock.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data) { if (l === '.') { data = false; got.push(msg); msg = { to: [] }; sock.write('250 OK\r\n'); } else msg.body = (msg.body || '') + l + '\n'; continue; }
      const c4 = l.slice(0, 4).toUpperCase();
      if (c4 === 'EHLO' || c4 === 'HELO') sock.write('250-t\r\n250 AUTH PLAIN\r\n'); else if (c4 === 'RCPT') { msg.to.push(l.slice(8).replace(/[<>]/g, '')); sock.write('250 OK\r\n'); }
      else if (c4 === 'DATA') { data = true; sock.write('354 go\r\n'); } else if (c4 === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 OK\r\n'); } }); });
  await new Promise(r => smtp.listen(0, r));
  try {
    await call('PUT', '/api/staff/email', { smtp_host: '127.0.0.1', smtp_port: String(smtp.address().port), smtp_secure: 'none', email_from: 'bookings@club.test',
      email_club_copy: 'office@club.test', email_subs: JSON.stringify({ club: ['timesheets_daily'] }) }, admin);
    const r = await call('POST', '/api/staff/email/report', { kind: 'timesheets_daily' }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.sent_to, ['office@club.test']);
    const t0 = Date.now(); while (!got.length && Date.now() - t0 < 4000) await new Promise(x => setTimeout(x, 50));
    assert.match(got[0].body, /Daily timesheets/);
  } finally { smtp.close(); }
});

test('staff email their timesheet: to the timesheet recipients and a copy to themselves; staff only their own', async () => {
  const net = require('node:net'); const got = [];
  const smtp = net.createServer(sock => { let data = false, buf = '', msg = { to: [] }; sock.write('220 t\r\n');
    sock.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data) { if (l === '.') { data = false; got.push(msg); msg = { to: [] }; sock.write('250 OK\r\n'); } else msg.body = (msg.body || '') + l + '\n'; continue; }
      const c4 = l.slice(0, 4).toUpperCase();
      if (c4 === 'EHLO' || c4 === 'HELO') sock.write('250-t\r\n250 AUTH PLAIN\r\n'); else if (c4 === 'RCPT') { msg.to.push(l.slice(8).replace(/[<>]/g, '')); sock.write('250 OK\r\n'); }
      else if (c4 === 'DATA') { data = true; sock.write('354 go\r\n'); } else if (c4 === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 OK\r\n'); } }); });
  await new Promise(r => smtp.listen(0, r));
  try {
    await call('PUT', '/api/staff/email', { smtp_host: '127.0.0.1', smtp_port: String(smtp.address().port), smtp_secure: 'none', email_from: 'bookings@club.test',
      email_club_copy: 'office@club.test', email_subs: JSON.stringify({ club: ['timesheets'] }) }, admin);
    const emps = (await call('GET', '/api/staff/employees', null, admin)).data, sera = emps.find(e => e.username === 'sera');
    await call('PUT', `/api/staff/employees/${sera.id}`, { email: 'sera@club.test' }, admin);
    const day = futureWeekday(45);
    await call('POST', '/api/staff/timesheets', { user_id: sera.id, clock_in: `${day}T08:00`, clock_out: `${day}T12:00` }, admin);
    const r = await call('POST', '/api/staff/timesheets/email', { from: day, to: day, user_id: 999999 }, staff); // staff: user_id ignored, own only
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.sent_to.sort(), ['office@club.test', 'sera@club.test']);
    assert.equal(r.data.copy_to_me, true); assert.equal(r.data.shifts, 1);
    const t0 = Date.now(); while (!got.length && Date.now() - t0 < 4000) await new Promise(x => setTimeout(x, 50));
    assert.match(got[0].body, /Timesheet: Sera/);
  } finally { smtp.close(); }
});

test('printable timesheet shows pay (gross, deductions, amount to pay) to managers or for your own; hours only otherwise', async () => {
  const emp = (await call('POST', '/api/staff/employees', { name: 'Pay Sheet', username: 'paysheet', password: 'paysheet12', role: 'staff', pay_type: 'hourly', pay_rate: 10 }, admin)).data;
  const day = futureWeekday(50);
  await call('POST', '/api/staff/timesheets', { user_id: emp.id, clock_in: `${day}T08:00`, clock_out: `${day}T12:00` }, admin);
  const a = (await call('GET', `/api/staff/timesheets/sheet?from=${day}&to=${day}&user_id=${emp.id}`, null, admin)).data;
  assert.equal(a.with_pay, true); assert.match(a.html, /Pay (week|fortnight|month|period): /); assert.match(a.html, /To pay/); assert.match(a.html, /40\.00/);
  // someone with timesheet access but not a manager: hours, no pay
  const foh = await login('foh', 'fohpass12');
  const f = (await call('GET', `/api/staff/timesheets/sheet?from=${day}&to=${day}&user_id=${emp.id}`, null, foh)).data;
  assert.equal(f.with_pay, false); assert.doesNotMatch(f.html, /Pay (week|fortnight|month|period): /); assert.match(f.html, /Paid hours/);
});

test('timesheet pay for any dates: deductions per pay period, a part period in proportion; weekly running total', async () => {
  const emp = (await call('POST', '/api/staff/employees', { name: 'Range Pay', username: 'rangepay', password: 'rangepay12', role: 'staff', pay_type: 'hourly', pay_rate: 20 }, admin)).data;
  await call('PUT', '/api/staff/payroll/rules', { deductions: [{ id: emp.id, deductions: [{ name: 'Loan', amount: 28 }] }], pay_periods_per_year: 26 }, admin);
  const mon = futureWeekday(60), d0 = new Date(mon + 'T00:00:00Z'); d0.setUTCDate(d0.getUTCDate() - (d0.getUTCDay() + 6) % 7); const wk = d0.toISOString().slice(0, 10);
  const add = n => { const x = new Date(wk + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  await call('PUT', '/api/staff/payroll/rules', { pay_cycle_start: wk }, admin); // fortnights start on wk
  await call('POST', '/api/staff/timesheets', { user_id: emp.id, clock_in: `${add(0)}T08:00`, clock_out: `${add(0)}T12:00` }, admin);
  await call('POST', '/api/staff/timesheets', { user_id: emp.id, clock_in: `${add(7)}T08:00`, clock_out: `${add(7)}T12:00` }, admin);
  // one week (half a fortnight): loan is half
  const w = (await call('GET', `/api/staff/timesheets/sheet?from=${add(0)}&to=${add(6)}&user_id=${emp.id}`, null, admin)).data.html;
  assert.match(w, /Loan FJ\$14\.00/);
  // two weeks: one fortnight, full loan, week by week with a running total of 8 hours
  const f2 = (await call('GET', `/api/staff/timesheets/sheet?from=${add(0)}&to=${add(13)}&user_id=${emp.id}`, null, admin)).data.html;
  assert.match(f2, /Loan FJ\$28\.00/); assert.match(f2, /Days and hours worked/); assert.match(f2, />Days</); assert.match(f2, /8\.00/);
  assert.match(f2, /Pay fortnight: /); assert.match(f2, /Full pay period/); assert.match(w, /Part of this fortnight only/); // headed with the pay period's dates
  await call('PUT', '/api/staff/payroll/rules', { pay_cycle_start: '' }, admin);
});

test('pay cycle: periods follow the start date and frequency; pay run and timesheets use them', async () => {
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { pay_cycle_start: '2026-11-05', pay_periods_per_year: 26 }, admin)).status, 200); // a Thursday, fortnightly
  const p = (await call('GET', '/api/staff/payroll/period?date=2026-11-16', null, staff)).data;
  assert.deepEqual(p.current, ['2026-11-05', '2026-11-18']); assert.deepEqual(p.previous, ['2026-10-22', '2026-11-04']); assert.deepEqual(p.next, ['2026-11-19', '2026-12-02']);
  await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 52 }, admin);
  assert.deepEqual((await call('GET', '/api/staff/payroll/period?date=2026-11-16', null, staff)).data.current, ['2026-11-12', '2026-11-18']); // weekly from Thursday
  await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 24 }, admin);
  assert.deepEqual((await call('GET', '/api/staff/payroll/period?date=2026-11-16', null, staff)).data.current, ['2026-11-16', '2026-11-30']);
  await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 26, pay_cycle_start: '' }, admin); // back to the default
});

test('multi-shift entry saves many shifts; rows with a problem come back with the reason; employee number', async () => {
  const a = (await call('POST', '/api/staff/employees', { name: 'Multi A', username: 'multia', password: 'multia1234', role: 'staff', employee_no: 'E010' }, admin)).data;
  const b = (await call('POST', '/api/staff/employees', { name: 'Multi B', username: 'multib', password: 'multib1234', role: 'staff', employee_no: 'E002' }, admin)).data;
  assert.equal(a.employee_no, 'E010');
  const day = futureWeekday(80);
  const r = (await call('POST', '/api/staff/timesheets/bulk', { entries: [
    { user_id: a.id, clock_in: `${day}T07:00`, clock_out: `${day}T15:00` },
    { user_id: b.id, clock_in: `${day}T08:00`, clock_out: `${day}T12:00` },
    { user_id: a.id, clock_in: `${day}T14:00`, clock_out: `${day}T16:00` },   // overlaps A's first shift
    { user_id: b.id, clock_in: `${day}T13:00`, clock_out: `${day}T12:00` } ] }, admin)).data; // finish before start
  assert.equal(r.saved, 2); assert.equal(r.failed, 2);
  assert.match(r.results[2].error, /overlaps/); assert.match(r.results[3].error, /Finish must be after start/);
  const ts = (await call('GET', `/api/staff/timesheets?from=${day}&to=${day}`, null, admin)).data;
  assert.equal(ts.filter(t => [a.id, b.id].includes(t.user_id)).length, 2); assert.ok(ts.some(t => t.employee_no === 'E002'));
  assert.equal((await call('POST', '/api/staff/timesheets/bulk', { entries: [{ user_id: a.id, clock_in: `${day}T17:00`, clock_out: `${day}T18:00` }] }, staff)).status, 403);
});

test('Staff form: an empty "on the time clock" value comes back ticked, so saving the form keeps them on timesheets', async () => {
  const e = (await call('POST', '/api/staff/employees', { name: 'Clock Keep', username: 'clockkeep', password: 'clockkeep1', role: 'staff' }, admin)).data;
  const listed = (await call('GET', '/api/staff/employees', null, admin)).data.find(x => x.id === e.id);
  assert.equal(listed.on_timeclock, 1); assert.equal(listed.timesheet_admin, 0);
  // saving the form as shown (box ticked) keeps them on the timesheets
  await call('PUT', `/api/staff/employees/${e.id}`, { name: 'Clock Keep', role: 'manager', on_timeclock: listed.on_timeclock ? true : false }, admin);
  assert.ok((await call('GET', '/api/staff/directory', null, admin)).data.find(x => x.id === e.id).on_timeclock);
});

test('reports per person, payslips for any dates with year to date, and leave (paid leave adds to pay)', async () => {
  const emp = (await call('POST', '/api/staff/employees', { name: 'Ytd Person', username: 'ytdperson', password: 'ytdperson1', role: 'staff', pay_type: 'hourly', pay_rate: 10 }, admin)).data;
  await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 52, pay_cycle_start: '2027-03-01', breaks: [] }, admin); // weekly from Monday
  await call('POST', '/api/staff/timesheets', { user_id: emp.id, clock_in: '2027-03-01T08:00', clock_out: '2027-03-01T16:00' }, admin);
  await call('POST', '/api/staff/timesheets', { user_id: emp.id, clock_in: '2027-03-08T08:00', clock_out: '2027-03-08T12:00' }, admin);
  // leave: Admin level can add, staff can't; sick day paid 8 h × $10
  assert.equal((await call('POST', '/api/staff/leave', { user_id: emp.id, kind: 'sick', date_from: '2027-03-09', days: 1 }, staff)).status, 403);
  assert.equal((await call('POST', '/api/staff/leave', { user_id: emp.id, kind: 'sick', date_from: '2027-03-09', days: 1, notes: 'flu' }, admin)).status, 200);
  const lv = (await call('GET', '/api/staff/leave?year=2027', null, admin)).data;
  const me = lv.people.find(p => p.id === emp.id); assert.equal(me.sick_taken, 1); assert.equal(me.sick_left, 9); assert.equal(me.annual_left, 10);
  // finalise week 1, then payslips for both weeks: week 1 final, week 2 draft with leave pay and year to date
  assert.equal((await call('POST', '/api/staff/payroll/runs', { period_start: '2027-03-01', period_end: '2027-03-07', pay_date: '2027-03-08' }, admin)).status, 200);
  const ps = (await call('GET', `/api/staff/payslips/build?from=2027-03-01&to=2027-03-14&user_id=${emp.id}`, null, admin)).data.payslips;
  assert.equal(ps.length, 2); assert.equal(ps[0].status, 'final'); assert.equal(ps[1].status, 'draft');
  assert.equal(ps[0].gross, 80); assert.equal(ps[1].leave_pay, 80); assert.equal(ps[1].gross, 120); // 4 h worked + 8 h sick
  assert.equal(ps[1].ytd.gross, 200); assert.equal(ps[1].ytd.sick_taken, 1); assert.equal(ps[1].ytd.pays, 2); assert.ok(ps[1].ytd.fnpf_total > 0);
  assert.equal(ps[0].ytd.gross, 80); // the first payslip's year to date doesn't include later pay
  // staff can't build payslips; each-person timesheet has a page per person
  assert.equal((await call('GET', `/api/staff/payslips/build?from=2027-03-01&to=2027-03-14`, null, staff)).status, 403);
  const each = (await call('GET', '/api/staff/timesheets/sheet?from=2027-03-01&to=2027-03-14&each=1', null, admin)).data;
  assert.ok(each.people >= 1); assert.match(each.html, /Timesheet: Ytd Person/);
  // accruals: Admin level edits a leave record and the days left (carry-over); staff can't
  const rec = lv.rows.find(r => r.user_id === emp.id);
  assert.equal((await call('PUT', `/api/staff/leave/${rec.id}`, { days: 0.5 }, staff)).status, 403);
  assert.equal((await call('PUT', `/api/staff/leave/${rec.id}`, { days: 0.5, notes: 'half day' }, admin)).status, 200);
  assert.equal((await call('PUT', '/api/staff/leave/balances', { year: '2027', people: [{ id: emp.id, annual_left: 13 }] }, staff)).status, 403);
  assert.equal((await call('PUT', '/api/staff/leave/balances', { year: '2027', leave_sick_days: 10, people: [{ id: emp.id, annual_left: 13, sick_left: 9.5 }] }, admin)).status, 200);
  const lv2 = (await call('GET', '/api/staff/leave?year=2027', null, admin)).data.people.find(p => p.id === emp.id);
  assert.equal(lv2.annual_left, 13); assert.equal(lv2.annual_adj, 3); assert.equal(lv2.sick_taken, 0.5); assert.equal(lv2.sick_left, 9.5);
  const ps2 = (await call('GET', `/api/staff/payslips/build?from=2027-03-08&to=2027-03-14&user_id=${emp.id}`, null, admin)).data.payslips;
  assert.equal(ps2[0].ytd.annual_left, 13); assert.equal(ps2[0].leave_pay, 40); // half a sick day now
  // only Super admin removes leave
  assert.equal((await call('DELETE', `/api/staff/leave/${rec.id}`, null, admin)).status, 200);
  await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 26, pay_cycle_start: '' }, admin);
});
// ---------- monthly Excel wage reports ----------
// A workbook laid out like the company's monthly wage report: details at the top, a row per week, YTD at the bottom
// (the YTD formula only adds weeks 1–4, like the real sheets).
async function wageBook(people) {
  const wb = new ExcelJS.Workbook();
  for (const p of people) {
    const ws = wb.addWorksheet(p.sheet);
    ws.getCell('D2').value = 'WAGES REPORT';
    ws.getRow(6).values = ['Employee Name ', null, null, p.name, null, 'Account Name:', null, p.account_name || p.name];
    ws.getRow(7).values = ['FNPF No.', null, null, p.fnpf || null, null, 'Account Number:', null, p.acct || null];
    ws.getRow(8).values = ['Bank ', null, null, p.bank || 'BSP', null, 'Bank:', null, p.bank || 'BSP'];
    ws.getRow(10).values = ['Hourly Rate', null, null, p.rate];
    ws.getRow(12).values = ['DATE PREPARED', 'TIME', 'PERIOD FOR WAGES', 'NAME', 'HRS', 'RATE', 'Bonus', 'GROSS', 'FNPF', 'PAYE', 'Other Deductions', 'NET WAGES', 'Comments'];
    p.hours.forEach((h, i) => {
      const r = 14 + i, gross = round(h * p.rate);
      ws.getRow(r).values = ['01.01.26', '9am - 5pm', `week ${i + 1}`, p.row_name || p.name, h, p.rate, 0,
        { formula: `((E${r}*F${r})+G${r})`, result: gross }, { formula: `H${r}*0.08`, result: round(gross * 0.08) }, 0, 0, { formula: `H${r}-I${r}-J${r}-K${r}`, result: round(gross * 0.92) }, i === 2 ? p.comment || null : null];
    });
    const ytd = round(p.hours.slice(0, 4).reduce((a, h) => a + h * p.rate, 0));
    ws.getRow(20).values = [null, null, null, 'YTD', null, null, 0, { formula: 'SUM(H14:H17)', result: ytd }, { formula: 'SUM(I14:I17)', result: round(ytd * 0.08) }, 0, 0, { formula: 'SUM(L14:L17)', result: round(ytd * 0.92) }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

test('wage reports: check the files, see the problems, import as pay history, year to date includes it', async () => {
  const oct = await wageBook([
    { sheet: 'Anil', name: 'Anill Prasad', fnpf: 'MN1', acct: '111', rate: 7, hours: [40, 40, 31.9, 39, 40] },
    { sheet: 'Kele', name: 'Ratu Jone Vosa', acct: '222', rate: 6, hours: [40, 40, 0, 0, 0] },
    { sheet: 'Tevi', name: 'Tevita Tuidraki', account_name: 'Ratu Jone Vosa', acct: '222', rate: 6, hours: [0, 0, 0, 40, 40], row_name: 'Tevi Tuidraki' },
  ]);
  const nov = await wageBook([
    { sheet: 'Anil', name: 'Anill Prasad', fnpf: 'MN1', acct: '111', rate: 7, hours: [35, 35] },
    { sheet: 'Kele', name: 'Ratu Jone Vosa', acct: '222', rate: 6, hours: [32, 40] },
    { sheet: 'tevi ', name: 'Tevi', rate: 6, hours: [40, 0] },
  ]);
  const files = [{ name: 'OCT_Wage_2026.xlsx', data: oct }, { name: 'nov_wage_2026.xlsx', data: nov }, { name: 'copy of OCT_Wage_2026.xlsx', data: oct, month: '2026-10' }];
  // staff can't import or see pay history
  assert.equal((await call('POST', '/api/staff/import/wages/preview', { files }, staff)).status, 403);
  assert.equal((await call('GET', '/api/staff/pay-history', null, staff)).status, 403);
  const p = await call('POST', '/api/staff/import/wages/preview', { files }, admin);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.deepEqual(p.data.months.map(m => m.month), ['2026-10', '2026-11']);            // the copy is counted once
  assert.ok(p.data.problems.some(x => /same file/.test(x.text)));
  assert.ok(p.data.problems.some(x => /Same bank account \(222\)/.test(x.text)));        // Kele and Tevi share an account number
  assert.equal(p.data.people.length, 3);                                                  // 'Tevi' and 'tevi ' are one person
  const auy = p.data.people.find(x => x.sheet === 'Anil'), sam = p.data.people.find(x => x.key === 'tevi');
  assert.equal(auy.totals.weeks, 7); assert.equal(auy.totals.gross, round((190.9 + 70) * 7));
  assert.ok(auy.issues.some(t => /leaves out week 5/.test(t)), auy.issues.join(' | '));  // the sheet's YTD misses week 5
  assert.equal(sam.name, 'Tevita Tuidraki');
  assert.ok(sam.issues.some(t => /bank account name is “Ratu Jone Vosa”/.test(t)));
  // import: Anil and Kele new, Tevi new under a corrected name
  const people = { [sam.key]: { action: 'new', name: 'Tevita Vula Tuidraki' } };
  const r = await call('POST', '/api/staff/import/wages', { files, people }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created, 3); assert.equal(r.data.rows, 7 + 4 + 3);
  const emps = (await call('GET', '/api/staff/employees', null, admin)).data;
  const a = emps.find(e => e.name === 'Anill Prasad');
  assert.equal(a.pay_rate, 7); assert.equal(a.fnpf_no, 'MN1'); assert.equal(a.bank_account, '111'); assert.match(a.clock_pin, /^\d{4}$/); assert.match(a.aliases, /Anil/);
  assert.ok(emps.some(e => e.name === 'Tevita Vula Tuidraki'));
  // importing again replaces, never doubles; the second time it matches the staff already there
  const p2 = (await call('POST', '/api/staff/import/wages/preview', { files }, admin)).data;
  assert.equal(p2.people.find(x => x.sheet === 'Anil').user_id, a.id);
  assert.deepEqual(p2.people.find(x => x.sheet === 'Anil').already, ['2026-10', '2026-11']);
  // choosing "new" again for someone already on Staff is refused (no doubles); left as matched, it replaces
  const dup = await call('POST', '/api/staff/import/wages', { files, people }, admin);
  assert.equal(dup.status, 400); assert.match(dup.data.error, /already on Staff/);
  const r2 = await call('POST', '/api/staff/import/wages', { files, people: {} }, admin);
  assert.equal(r2.data.created, 0); assert.equal(r2.data.rows, 0); assert.equal(r2.data.replaced, 14);
  const h = (await call('GET', '/api/staff/pay-history?year=2026', null, admin)).data;
  assert.equal(h.rows.length, 14);
  const ah = h.rows.filter(x => x.user_id === a.id);
  assert.equal(round(ah.reduce((s, x) => s + x.gross, 0)), round((190.9 + 70) * 7));
  assert.equal(ah.find(x => x.month === '2026-10' && x.week === 1).fnpf_employer, 28);   // company FNPF 10% worked out
  // payslips for later dates count the imported pay in the year to date
  const d = '2026-12-01';
  await call('POST', '/api/staff/timesheets', { user_id: a.id, clock_in: `${d}T09:00`, clock_out: `${d}T17:00` }, admin);
  const ps = (await call('GET', `/api/staff/payslips/build?from=${d}&to=${d}&user_id=${a.id}`, null, admin)).data.payslips[0];
  assert.equal(ps.ytd.history_weeks, 7);
  assert.equal(ps.ytd.gross, round((190.9 + 70) * 7 + ps.gross));
  // CSV, then a Super admin removes a month (an Admin can't)
  const csv = await fetch(B + '/api/staff/export/pay-history.csv', { headers: { Cookie: admin } }); assert.match(await csv.text(), /Anill Prasad/);
  const mgr = await call('POST', '/api/staff/employees', { name: 'Admin Two', username: 'admin2', password: 'adminpass2', role: 'manager' }, admin);
  const am = await login('admin2', 'adminpass2');
  assert.equal((await call('GET', '/api/staff/pay-history?year=2026', null, am)).status, 200);
  assert.equal((await call('DELETE', `/api/staff/pay-history?user_id=${a.id}&month=2026-11`, null, am)).status, 403);
  assert.equal((await call('DELETE', `/api/staff/pay-history?user_id=${a.id}&month=2026-11`, null, admin)).data.removed, 2);
  assert.ok(mgr.data.id);
});

test('wage reports: two sheets for one person can be joined ("same person"), bad files are refused', async () => {
  const f = await wageBook([{ sheet: 'Makereta', name: 'Makereta Koroi', rate: 6, hours: [40, 32] }, { sheet: 'Makerete', name: 'Makerete', rate: 6, hours: [0, 0, 40] }]);
  const files = [{ name: 'Sep wages 2026.xlsx', data: f }];
  const r = await call('POST', '/api/staff/import/wages', { files, people: { makerete: { action: 'same', same_as: 'makereta' } } }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.created, 1); assert.equal(r.data.rows, 3);
  const e = (await call('GET', '/api/staff/employees', null, admin)).data.find(x => x.name === 'Makereta Koroi');
  assert.match(e.aliases, /Makerete/);
  assert.equal((await call('GET', `/api/staff/pay-history?year=2026`, null, admin)).data.rows.filter(x => x.user_id === e.id).length, 3);
  assert.equal((await call('POST', '/api/staff/import/wages/preview', { files: [{ name: 'notes.xlsx', data: Buffer.from('hello').toString('base64'), month: '2026-09' }] }, admin)).status, 400);
  assert.equal((await call('POST', '/api/staff/import/wages/preview', { files: [{ name: 'wages.xlsx', data: f }] }, admin)).status, 400); // no month in the name
});

// ---------- bank statements ----------
// Lines as copied from a bank statement: wages mixed with other payments, a deposit and fees
const STATEMENT = `Statement Begins 01 Nov 2025
01 Nov BEGINNING BALANCE 5,000.00
03 Nov Tomasi Pay 230.00 4,770.00
03 Nov Insurance Co 118.40 4,651.60
04 Nov CUSTOMER INV-0001 2,450.00 7,101.60
04 Nov Supplier One 612.75 6,488.85
07 Nov Josefa Pay 190.00 6,298.85
07 Nov Tomasi Pay 230.00 6,068.85
07 Nov Kele Pay 230.00 5,838.85
07 Nov Isikele Pay 260.00 5,578.85
07 Nov Penaia Pay 300.00 5,278.85
07 Nov Kamal Pay 460.00 4,818.85
10 Nov Mechanic 95.00 4,723.85
14 Nov Isikele 260.00 4,463.85
17 Nov Payment To Director 200.00 4,263.85
26 Nov DEPOSIT 1,500.00 5,763.85
28 Nov MAINTENANCE FEE 5.00 5,758.85
28 Nov ENDING BALANCE 5,758.85`;

test('bank statements: wage payments are found and matched to staff (near spellings too), saved once, shown next to pay history', async () => {
  const mk = async (name, aliases = '') => (await call('POST', '/api/staff/employees', { name, username: name.split(' ')[0].toLowerCase() + 'b', password: 'password12', role: 'staff', pay_rate: 7, aliases }, admin)).data;
  const tomasi = await mk('Tomasi Ravu Kete'), josefa = await mk('Josefa Naivalu'), ben = (await call('GET', '/api/staff/employees', null, admin)).data.find(e => e.name === 'Ratu Jone Vosa'), // from the wage report import (sheet "Kele")
    isikeli = await mk('Isikeli Waqa'), penaia = await mk('Penaia Bale'), kamal = await mk('Ahmed Kamal');
  assert.equal((await call('POST', '/api/staff/bank/preview', { text: STATEMENT }, staff)).status, 403);
  const p = await call('POST', '/api/staff/bank/preview', { text: STATEMENT, year: 2026 }, admin);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const L = p.data.lines, who = d => L.filter(l => l.description === d).map(l => l.user_id);
  assert.equal(L[0].date, '2025-11-03');                                   // the statement's own year is used
  assert.deepEqual(who('Tomasi Pay'), [tomasi.id, tomasi.id]);
  assert.deepEqual(who('Kele Pay'), [ben.id]);                              // "Kele" (his wage sheet's name) is one of his other names
  assert.deepEqual(who('Isikele Pay'), [isikeli.id]);                        // near spelling of Isikeli on a pay line
  assert.ok(L.find(l => l.description === 'Isikele Pay').near);
  assert.deepEqual(who('Kamal Pay'), [kamal.id]); assert.deepEqual(who('Penaia Pay'), [penaia.id]); assert.deepEqual(who('Josefa Pay'), [josefa.id]);
  for (const d of ['Insurance Co', 'CUSTOMER INV-0001', 'Mechanic', 'Payment To Director', 'DEPOSIT', 'MAINTENANCE FEE']) assert.ok(!L.some(l => l.description === d), d);
  assert.ok(!L.some(l => l.description === 'Isikele'));                     // no "pay" and not a known name yet
  // save: the near spelling is remembered, so the bare "Isikele" line matches next time
  const s1 = await call('POST', '/api/staff/bank/save', { lines: L.map(l => ({ ...l, remember: l.near })) }, admin);
  assert.equal(s1.status, 200); assert.equal(s1.data.saved, 7); assert.equal(s1.data.learned, 1);
  assert.match((await call('GET', '/api/staff/employees', null, admin)).data.find(e => e.id === isikeli.id).aliases, /Isikele/);
  const p2 = (await call('POST', '/api/staff/bank/preview', { text: STATEMENT }, admin)).data.lines;
  assert.equal(p2.find(l => l.description === 'Isikele').user_id, isikeli.id);
  assert.ok(p2.filter(l => l.description !== 'Isikele').every(l => l.already));
  await call('POST', '/api/staff/bank/save', { lines: p2 }, admin);       // saving again doesn't double up
  const pay = (await call('GET', '/api/staff/bank/payments?year=2025', null, admin)).data.rows;
  assert.equal(pay.length, 8);
  assert.equal(pay.filter(r => r.user_id === tomasi.id).reduce((a, r) => a + r.amount, 0), 460);
  // shown on Pay history for the month
  const h = (await call('GET', '/api/staff/pay-history?year=2025', null, admin)).data;
  assert.equal(h.bank.find(b => b.user_id === isikeli.id && b.month === '2025-11').paid, 520);
  // a picture PDF gets a plain message
  const pdf = await call('POST', '/api/staff/bank/preview', { files: [{ name: 'statement.pdf', data: Buffer.from('%PDF-1.7').toString('base64') }] }, admin);
  assert.equal(pdf.status, 400); assert.match(pdf.data.error, /PDF statements are read on this computer/);
  // a PDF statement read on the computer (text, or OCR of a picture PDF): every line checked against the running balance
  const pdfText = ['Statement Begins 01 Nov 2025', '01 Nov BEGINNING BALANCE 1,000.00', '07 Nov lsikele Pay 260.00 740.00', '07 Nov Kele Pay 230.00 510.00',
    '10 Nov DEPOSIT 500.00 1,010.00', '14 Nov Kamal Pay 460.00 550.00', '28 Nov ENDING BALANCE 550.00'].join('\n');     // OCR read capital I as l in lsikele
  const t = (await call('POST', '/api/staff/bank/preview', { texts: [{ source: 'Statement 35.pdf', text: pdfText }] }, admin)).data;
  assert.deepEqual(t.check, { checked: 4, ok: 4, wrong: [] });
  assert.equal(t.lines.find(l => l.description === 'lsikele Pay').user_id, isikeli.id);
  assert.equal(t.lines.find(l => l.description === 'lsikele Pay').source, 'Statement 35.pdf');
  assert.ok(!t.lines.some(l => l.description === 'DEPOSIT'));
  const misread = (await call('POST', '/api/staff/bank/preview', { texts: [{ source: 's.pdf', text: pdfText.replace('Kele Pay 230.00', 'Kele Pay 280.00') }] }, admin)).data;
  assert.equal(misread.check.ok, 3); assert.match(misread.check.wrong[0], /Kele Pay 280.00/);
  // a CSV download works too (Date, Description, Debit, Credit, Balance)
  const csv = 'Date,Description,Debit,Credit,Balance\n05/12/2025,Kamal Pay,460.00,,9440.50\n05/12/2025,DEPOSIT,,100.00,9540.50\n';
  const c = (await call('POST', '/api/staff/bank/preview', { files: [{ name: 'dec.csv', data: Buffer.from(csv).toString('base64') }] }, admin)).data;
  assert.equal(c.lines.length, 1); assert.equal(c.lines[0].user_id, kamal.id); assert.equal(c.lines[0].date, '2025-12-05'); assert.equal(c.lines[0].amount, 460);
});

test('access by area: supervisor sees only their team, no pay rates; self-service sees only their own; access changes are admin-only and audited', async () => {
  const ip = n => async (u, p) => { const x = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.7.7.${n}` }, body: JSON.stringify({ username: u, password: p }) }); assert.equal(x.status, 200); return x.headers.get('set-cookie').split(';')[0]; };
  const add = async b => { const r = await call('POST', '/api/staff/employees', { password: 'permpass12', role: 'staff', ...b }, admin); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
  const presets = (await call('GET', '/api/auth/me', null, admin)).data.presets;
  const sup = await add({ name: 'Vika Supervisor', username: 'vika', pay_rate: 9, perms: presets.supervisor.perms, preset: 'supervisor', team_only: true });
  const t1 = await add({ name: 'Jone Team', username: 'jone', pay_rate: 5, supervisor_id: sup.id });
  const out = await add({ name: 'Mere Other', username: 'mere', pay_rate: 5 });
  assert.equal(sup.access.pay_rates, 0); assert.equal(sup.team_only, 1);
  const sc = await ip(1)('vika', 'permpass12');
  const me = (await call('GET', '/api/auth/me', null, sc)).data.user;
  assert.equal(me.perms.timesheets, 2); assert.equal(me.perms.payroll, 0); assert.equal(me.team_only, true);
  // only the team, and no pay rates or bank details
  const emps = (await call('GET', '/api/staff/employees', null, sc)).data;
  assert.deepEqual(emps.map(e => e.name).sort(), ['Jone Team', 'Vika Supervisor']);
  assert.ok(emps.every(e => e.pay_rate === undefined && e.bank_account === undefined));
  assert.deepEqual((await call('GET', '/api/staff/directory', null, sc)).data.map(e => e.name).sort(), ['Jone Team', 'Vika Supervisor']);
  // enter and approve their team's shifts, not anyone else's
  const day = futureWeekday(90);
  assert.equal((await call('POST', '/api/staff/timesheets', { user_id: t1.id, clock_in: `${day}T08:00`, clock_out: `${day}T12:00` }, sc)).status, 200);
  assert.equal((await call('POST', '/api/staff/timesheets', { user_id: out.id, clock_in: `${day}T08:00`, clock_out: `${day}T12:00` }, sc)).status, 403);
  assert.equal((await call('GET', `/api/staff/timesheets?user_id=${out.id}&from=${day}&to=${day}`, null, sc)).status, 403);
  const shift = (await call('GET', `/api/staff/timesheets?from=${day}&to=${day}`, null, sc)).data.find(t => t.user_id === t1.id);
  assert.ok(shift);
  const ap = await call('POST', `/api/staff/timesheets/${shift.id}/approve`, {}, sc); assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.equal((await call('GET', `/api/staff/timesheets?user_id=${t1.id}&from=${day}&to=${day}`, null, admin)).data[0].approved_by_name, 'Vika Supervisor');
  assert.equal((await call('DELETE', `/api/staff/timesheets/${shift.id}`, null, sc)).status, 403); // no delete at Add & edit
  // hidden areas are refused on the server
  for (const [m, u] of [['GET', '/api/staff/payroll/runs'], ['GET', '/api/staff/pay-history'], ['GET', '/api/staff/payroll/rules'], ['POST', '/api/staff/payroll/preview']]) assert.equal((await call(m, u, m === 'GET' ? null : {}, sc)).status, 403, u);
  // can't change pay rates or anyone's access, can't edit someone outside the team
  assert.equal((await call('PUT', `/api/staff/employees/${t1.id}`, { pay_rate: 50 }, sc)).status, 403);
  assert.equal((await call('PUT', `/api/staff/employees/${sup.id}`, { perms: { payroll: 3 } }, sc)).status, 403);
  assert.equal((await call('PUT', `/api/staff/employees/${out.id}`, { position: 'x' }, sc)).status, 403);
  // a payroll officer (old "Admin") can change pay but not access
  const po = await add({ name: 'Pita Payroll', username: 'pita', perms: presets.payroll_officer.perms, preset: 'payroll_officer' });
  const pc = await ip(2)('pita', 'permpass12');
  assert.equal((await call('PUT', `/api/staff/employees/${t1.id}`, { pay_rate: 6 }, pc)).status, 200);
  assert.equal((await call('PUT', `/api/staff/employees/${t1.id}`, { perms: presets.read_only.perms }, pc)).status, 403);
  assert.equal((await call('PUT', `/api/staff/employees/${t1.id}`, { role: 'admin' }, pc)).status, 403);
  assert.equal((await call('PUT', `/api/staff/employees/${t1.id}`, { active: false }, pc)).status, 403); // switching off needs Full
  assert.equal((await call('GET', '/api/staff/audit', null, pc)).status, 403);
  // self-service: own payslips only, nothing else
  const jc = await ip(3)('jone', 'permpass12');
  assert.equal((await call('GET', '/api/staff/payslips/mine', null, jc)).status, 200);
  assert.equal((await call('GET', '/api/staff/employees', null, jc)).status, 403);
  assert.deepEqual((await call('GET', '/api/staff/directory', null, jc)).data.map(e => e.name), ['Jone Team']);
  // the last active administrator can't be removed
  const admins = (await call('GET', '/api/staff/employees', null, admin)).data.filter(e => e.role === 'admin' && e.active);
  if (admins.length === 1) {
    assert.equal((await call('PUT', `/api/staff/employees/${admins[0].id}`, { role: 'manager' }, admin)).status, 400);
    assert.equal((await call('PUT', `/api/staff/employees/${admins[0].id}`, { active: false }, admin)).status, 400);
  }
  // the administrator changes access; it's in the audit trail (with before and after), along with the pay change
  assert.equal((await call('PUT', `/api/staff/employees/${t1.id}`, { perms: presets.read_only.perms, preset: 'read_only' }, admin)).status, 200);
  const log = (await call('GET', '/api/staff/audit', null, admin)).data;
  const ch = log.find(l => l.action === 'Changed access' && l.details.startsWith('Jone Team'));
  assert.ok(ch && /employees Hidden.*→.*employees View/.test(ch.details), JSON.stringify(ch));
  assert.ok(log.find(l => l.action === 'Changed pay or bank details' && l.details === 'Jone Team: pay_rate' && l.user_name === 'Pita Payroll'));
  assert.equal((await call('GET', '/api/staff/employees', null, jc)).status, 200); // takes effect straight away
});
