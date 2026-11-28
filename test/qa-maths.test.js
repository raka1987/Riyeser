// QA pass (independent checks): pay maths worked out by hand with synthetic staff, pay period boundaries,
// duplicate pay runs, voiding (reversal) incl. a final pay, rounding, and who can see payslips.
// These check the program's own arithmetic. They do NOT validate statutory rates (PAYE / FNPF / PAYG / super /
// KiwiSaver): the default PAYE brackets are placeholders that must be checked against the tax office.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3979;
const B = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-qa-'));
let server, admin;
const r2 = n => Math.round(n * 100) / 100;

async function call(method, url, body, cookie, ip) {
  const res = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...(ip && { 'X-Forwarded-For': ip }) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
let ipn = 0;
async function login(u, p) { const r = await call('POST', '/api/auth/login', { username: u, password: p }, null, `10.88.0.${++ipn}`); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.cookie; }
async function addStaff(b) { const r = await call('POST', '/api/staff/employees', { password: 'qapass1234', role: 'staff', ...b }, admin); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
const shift = (id, d, a, b) => call('POST', '/api/staff/timesheets', { user_id: id, clock_in: `${d}T${a}`, clock_out: `${d}T${b}` }, admin);
// the default (placeholder) PAYE brackets, worked out independently of the program
const BR = [[0, 30000, 0], [30000, 50000, 18], [50000, 270000, 20], [270000, Infinity, 33]];
const annualTax = inc => BR.reduce((t, [f, to, r]) => t + (inc > f ? (Math.min(inc, to) - f) * r / 100 : 0), 0);

before(async () => {
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR, ADMIN_PASSWORD: 'AdminPass123', TRUST_PROXY: '1', RIYESER_DEMO_FILE: path.join(DATA_DIR, 'no-demo.json'), RIYESER_DEMO: '', RIYESER_DOCS: path.join(DATA_DIR, 'docs') }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { await fetch(B + '/api/public/info'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  admin = await login('admin', 'AdminPass123');
  // weekly pay, periods start on Mondays (1 Jan 2024 anchor), FNPF 8% / 10% (the defaults)
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 52, pay_cycle_start: '' }, admin)).status, 200);
});
after(async () => {
  if (server.exitCode === null) await new Promise(r => { server.once('exit', r); server.kill(); setTimeout(r, 5000); });
  const arc = path.join(DATA_DIR, 'archive'); if (fs.existsSync(arc)) for (const f of fs.readdirSync(arc)) { try { fs.chmodSync(path.join(arc, f), 0o644); } catch { } }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { }
});

test('QA-PAY-01 hourly pay: hours x rate, FNPF 8%/10%, PAYE from the annualised gross, net = gross - FNPF - PAYE - deductions', async () => {
  const e = await addStaff({ name: 'Qa Hourly', username: 'qahourly', pay_type: 'hourly', pay_rate: 12.5 });
  // Mon 2040-01-02 .. Sun 2040-01-08 is one weekly period (anchor 2024-01-01 is a Monday)
  for (const d of ['2040-01-02', '2040-01-03', '2040-01-04', '2040-01-05', '2040-01-06']) await shift(e.id, d, '08:00', '16:30'); // 8.5 h x 5 = 42.5 h
  const p = (await call('POST', '/api/staff/payroll/preview', { period_start: '2040-01-02', period_end: '2040-01-08' }, admin)).data;
  const l = p.lines.find(x => x.user_id === e.id);
  assert.equal(l.hours, 42.5);
  assert.equal(l.gross, 531.25);                      // 42.5 x 12.50 (no overtime loading: hours over 40 are paid at the normal rate)
  assert.equal(l.fnpf_employee, r2(531.25 * 0.08));   // 42.50
  assert.equal(l.fnpf_employer, r2(531.25 * 0.10));   // 53.13 (53.125 rounds half up)
  assert.equal(l.paye, r2(annualTax(531.25 * 52) / 52));
  assert.equal(l.net, r2(l.gross - l.fnpf_employee - l.paye - l.other_deductions));
});

test('QA-PAY-02 salary: annual salary / 52 a week whatever the hours; tax bands applied progressively', async () => {
  const e = await addStaff({ name: 'Qa Salary', username: 'qasalary', pay_type: 'salary', pay_rate: 78000 });
  const p = (await call('POST', '/api/staff/payroll/preview', { period_start: '2040-01-02', period_end: '2040-01-08' }, admin)).data;
  const l = p.lines.find(x => x.user_id === e.id);
  assert.equal(l.base_pay, 1500);                     // 78000 / 52
  assert.equal(l.gross, 1500);
  // 78000 a year: 0 on 30000, 18% of 20000 = 3600, 20% of 28000 = 5600 -> 9200 / 52 = 176.92
  assert.equal(l.paye, 176.92);
  assert.equal(l.fnpf_employee, 120); assert.equal(l.fnpf_employer, 150);
  assert.equal(l.net, r2(1500 - 120 - 176.92));
});

test('QA-PAY-03 rounding: an awkward rate and minutes round to cents once per line, and net still adds up', async () => {
  const e = await addStaff({ name: 'Qa Round', username: 'qaround', pay_type: 'hourly', pay_rate: 7.333 });
  await shift(e.id, '2040-01-03', '09:07', '15:52');  // 6.75 h
  const l = (await call('POST', '/api/staff/payroll/preview', { period_start: '2040-01-02', period_end: '2040-01-08' }, admin)).data.lines.find(x => x.user_id === e.id);
  assert.equal(l.hours, 6.75);
  assert.equal(l.gross, r2(6.75 * 7.333));            // 49.50 (49.49775)
  assert.equal(l.net, r2(l.gross - l.fnpf_employee - l.paye - l.other_deductions));
  for (const k of ['gross', 'fnpf_employee', 'fnpf_employer', 'paye', 'net']) assert.equal(l[k], r2(l[k]), `${k} has at most 2 decimals`);
});

test('QA-PAY-04 deductions and allowances: regular deductions + this-pay allowance/deduction; FNPF is on gross incl. the allowance', async () => {
  const e = await addStaff({ name: 'Qa Deduct', username: 'qadeduct', pay_type: 'hourly', pay_rate: 10 });
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { deductions: [{ id: e.id, deductions: [{ name: 'Loan', amount: 25 }, { name: 'Union', amount: 5.5 }] }] }, admin)).status, 200);
  await shift(e.id, '2040-01-04', '08:00', '16:00');   // 8 h = 80
  const adj = { [e.id]: { allowances: 20, other_deductions: 4.25, deduction_note: 'Uniform' } };
  const l = (await call('POST', '/api/staff/payroll/preview', { period_start: '2040-01-02', period_end: '2040-01-08', adjustments: adj }, admin)).data.lines.find(x => x.user_id === e.id);
  assert.equal(l.gross, 100);
  assert.equal(l.fnpf_employee, 8);
  assert.equal(l.other_deductions, 34.75);
  assert.deepEqual(l.deduction_lines.map(d => d.name), ['Loan', 'Union', 'Uniform']);
  assert.equal(l.net, r2(100 - 8 - l.paye - 34.75));
});

test('QA-PAY-05 pay period boundaries: a shift on the last day is in the period, the next day is not; weekly periods run Monday to Sunday', async () => {
  const pr = (await call('GET', '/api/staff/payroll/period?date=2040-01-08', null, admin)).data;
  assert.deepEqual(pr.current, ['2040-01-02', '2040-01-08']);
  assert.deepEqual(pr.next, ['2040-01-09', '2040-01-15']);
  const e = await addStaff({ name: 'Qa Boundary', username: 'qaboundary', pay_type: 'hourly', pay_rate: 10 });
  await shift(e.id, '2040-01-08', '09:00', '13:00'); // Sunday, last day
  await shift(e.id, '2040-01-09', '09:00', '11:00'); // Monday, next period
  const l = (await call('POST', '/api/staff/payroll/preview', { period_start: '2040-01-02', period_end: '2040-01-08' }, admin)).data.lines.find(x => x.user_id === e.id);
  assert.equal(l.hours, 4);
  const n = (await call('POST', '/api/staff/payroll/preview', { period_start: '2040-01-09', period_end: '2040-01-15' }, admin)).data.lines.find(x => x.user_id === e.id);
  assert.equal(n.hours, 2);
});

test('QA-PAY-06 leave: paid annual leave adds days x hours a day x rate; unpaid leave pays nothing; balance = entitlement - taken', async () => {
  const e = await addStaff({ name: 'Qa Leave', username: 'qaleave', pay_type: 'hourly', pay_rate: 10, start_date: '2039-01-01' });
  assert.equal((await call('POST', '/api/staff/leave', { user_id: e.id, kind: 'annual', date_from: '2040-01-03', days: 2, date_to: '2040-01-04' }, admin)).status, 200);
  assert.equal((await call('POST', '/api/staff/leave', { user_id: e.id, kind: 'unpaid', date_from: '2040-01-05', days: 1 }, admin)).status, 200);
  await shift(e.id, '2040-01-02', '09:00', '17:00');
  const l = (await call('POST', '/api/staff/payroll/preview', { period_start: '2040-01-02', period_end: '2040-01-08' }, admin)).data.lines.find(x => x.user_id === e.id);
  assert.equal(l.base_pay, 80); assert.equal(l.leave_pay, 160); assert.equal(l.gross, 240); // 2 days x 8 h x 10
  assert.ok(!l.leave_lines.some(x => x.kind === 'unpaid'));
  const bal = (await call('GET', '/api/staff/leave?year=2040', null, admin)).data;
  const me = bal.people.find(p => p.id === e.id);
  assert.equal(me.annual_taken, 2); assert.equal(me.unpaid_taken, 1);
  assert.equal(me.annual_left, r2(+bal.settings.leave_annual_days + me.annual_carried + me.annual_adj - 2));
});

test('QA-PAY-07 duplicate pay runs: the same dates cannot be finalised twice; voiding the first run allows it again', async () => {
  const body = { period_start: '2040-01-02', period_end: '2040-01-08', pay_date: '2040-01-09', confirm_warnings: true };
  const a = await call('POST', '/api/staff/payroll/runs', body, admin); assert.equal(a.status, 200, JSON.stringify(a.data));
  const b = await call('POST', '/api/staff/payroll/runs', body, admin); assert.equal(b.status, 409);
  // an overlapping range (half the same week) is refused too
  assert.equal((await call('POST', '/api/staff/payroll/runs', { ...body, period_start: '2040-01-05', period_end: '2040-01-11' }, admin)).status, 409);
  assert.equal((await call('DELETE', `/api/staff/payroll/runs/${a.data.id}`, null, admin)).status, 200);
  const c = await call('POST', '/api/staff/payroll/runs', body, admin); assert.equal(c.status, 200, JSON.stringify(c.data));
  // the paid leave in the voided run is paid again in the new run, once (not twice)
  const run = (await call('GET', `/api/staff/payroll/runs/${c.data.id}`, null, admin)).data;
  assert.equal(run.payslips.find(p => p.employee_name === 'Qa Leave').leave_pay, 160);
  assert.ok((await call('GET', '/api/staff/payroll/runs/voided', null, admin)).data.some(v => v.run_id === a.data.id));
});

test('QA-PAY-08 voiding a final pay puts the person back as they were (active, annual leave not lost), so the final pay can be redone', async () => {
  const e = await addStaff({ name: 'Qa Final', username: 'qafinal', pay_type: 'hourly', pay_rate: 10, start_date: '2039-01-01' });
  await call('PUT', '/api/staff/leave/balances', { year: '2041', leave_annual_days: 10, leave_day_hours: 8 }, admin);
  await shift(e.id, '2041-01-07', '08:00', '16:00');
  const fin = await call('POST', `/api/staff/employees/${e.id}/finish`, { end_date: '2041-01-08', pay_date: '2041-01-09', confirm_warnings: true }, admin);
  assert.equal(fin.status, 200, JSON.stringify(fin.data));
  const unused = fin.data.unused_annual_days; assert.ok(unused > 0);
  // void it
  assert.equal((await call('DELETE', `/api/staff/payroll/runs/${fin.data.id}`, null, admin)).status, 200);
  const me = (await call('GET', '/api/staff/employees', null, admin)).data.find(x => x.id === e.id);
  assert.equal(me.active, 1, 'voiding the final pay makes them active again');
  assert.ok(!(await call('GET', '/api/staff/leave?year=2041', null, admin)).data.rows.some(r => r.user_id === e.id && r.notes === 'Paid out on finishing'), 'the leave payout record is taken back');
  const pv = (await call('POST', `/api/staff/employees/${e.id}/finish/preview`, { end_date: '2041-01-08' }, admin)).data;
  assert.equal(pv.unused_annual_days, unused, 'the same unused leave is paid out when the final pay is redone');
  assert.ok((await call('GET', '/api/staff/audit', null, admin)).data.some(a => a.action === 'Deleted a pay run' && /Final pay/.test(a.details)));
});

test('QA-PAY-09 payslip confidentiality: a staff member sees only their own payslips; pay runs and other people\'s payslips are refused', async () => {
  const s = await login('qahourly', 'qapass1234');
  const mine = await call('GET', '/api/staff/payslips/mine', null, s);
  assert.equal(mine.status, 200);
  assert.ok(mine.data.length >= 1 && mine.data.every(p => p.employee_name === 'Qa Hourly'), JSON.stringify(mine.data.map(p => p.employee_name)));
  const runs = (await call('GET', '/api/staff/payroll/runs', null, admin)).data;
  for (const [m, u] of [['GET', '/api/staff/payroll/runs'], ['GET', `/api/staff/payroll/runs/${runs[0].id}`], ['GET', '/api/staff/payslips/build?from=2040-01-02&to=2040-01-08'],
    ['GET', '/api/staff/export/payslips.csv'], ['GET', '/api/staff/pay-history'], ['POST', '/api/staff/payslips/email']]) {
    const r = await call(m, u, m === 'POST' ? { run_id: runs[0].id } : null, s);
    assert.equal(r.status, 403, `${m} ${u} -> ${r.status}`);
  }
  // pay rates and bank details of others are not in what a staff member can read
  const dir = (await call('GET', '/api/staff/directory', null, s)).data;
  assert.ok(dir.every(p => p.pay_rate === undefined && p.bank_account === undefined));
  // signed out: nothing
  assert.equal((await call('GET', '/api/staff/payslips/mine')).status, 401);
});
