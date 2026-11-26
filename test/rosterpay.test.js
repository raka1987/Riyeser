// Payroll 2.3.1: rostered hours vs paid hours in the pay run file for Riyeser Accounting (riyeser.payrun.v1, optional
// fields), on the pay run preview and on a finalised pay run. Only when the period has a published roster.
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3989;
const B = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-rosterpay-'));
const INBOX = path.join(DATA_DIR, 'docs', 'Inbox', 'Payroll');
let server;

async function call(method, url, body, cookie) {
  const res = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
before(async () => {
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR, APPDATA: path.join(DATA_DIR, 'appdata'), ADMIN_PASSWORD: 'AdminPass123', RIYESER_DEMO_FILE: path.join(DATA_DIR, 'no-demo.json'), RIYESER_DEMO: '', RIYESER_DOCS: path.join(DATA_DIR, 'docs'), DESKTOP: '' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/public/info'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('Server did not start');
});
after(async () => {
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000); });
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { }
});

// weekly pay; week 1 (Mon 25 Feb 2030) has no roster, week 2 (Mon 4 Mar 2030) has a published one
const W1 = ['2030-02-25', '2030-03-03'], W2 = ['2030-03-04', '2030-03-10'];
const DAYS2 = ['2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08'];
const ROSTER_KEYS = ['rostered_hours', 'paid_hours', 'hours_difference', 'hours_source', 'hours_sources'];
let admin, ana, ben, cal;
const readFile = name => JSON.parse(fs.readFileSync(path.join(INBOX, name), 'utf8'));

test('setup: two hourly staff and one on salary, weekly pay, no break rules', async () => {
  admin = (await call('POST', '/api/auth/login', { username: 'admin', password: 'AdminPass123' })).cookie;
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 52, breaks: [] }, admin)).status, 200);
  const emp = async (name, o) => (await call('POST', '/api/staff/employees', { name, username: name.toLowerCase(), password: 'staffpass1', role: 'staff', pay_type: 'hourly', pay_rate: 10, ...o }, admin)).data;
  ana = await emp('Ana'); ben = await emp('Ben', { pay_rate: 12 }); cal = await emp('Cal', { pay_type: 'salary', pay_rate: 52000 });
});

test('no roster for the period: the pay run file has no roster fields (as before 2.3.1)', async () => {
  await call('POST', '/api/staff/timesheets', { user_id: ana.id, clock_in: `${W1[0]}T09:00`, clock_out: `${W1[0]}T17:00` }, admin);
  // a draft (unpublished) roster shift doesn't count as a roster
  assert.equal((await call('POST', '/api/staff/roster/shifts', { user_id: ana.id, date: W1[0], start: '09:00', finish: '15:00' }, admin)).status, 200);
  const pv = (await call('POST', '/api/staff/payroll/preview', { period_start: W1[0], period_end: W1[1] }, admin)).data;
  assert.equal(pv.roster, null);
  const r = await call('POST', '/api/staff/payroll/runs', { period_start: W1[0], period_end: W1[1], pay_date: '2030-03-04' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const doc = readFile(r.data.accounting_file);
  assert.equal(doc.roster_summary, undefined);
  for (const e of doc.employees) for (const k of ROSTER_KEYS) assert.equal(e[k], undefined, `${e.name} ${k}`);
  assert.equal((await call('GET', `/api/staff/payroll/runs/${r.data.id}`, null, admin)).data.roster, null);
});

test('published roster: each payslip has rostered / paid / difference and how the hours were sourced, plus a total', async () => {
  // Ana: Mon–Fri 9–5 with a 30 min break (7.5 h a day, 37.5 h); Ben: Mon 9–5, no break (8 h); Cal (salary) rostered too
  for (const d of DAYS2) assert.equal((await call('POST', '/api/staff/roster/shifts', { user_id: ana.id, date: d, start: '09:00', finish: '17:00', break_min: 30 }, admin)).status, 200);
  await call('POST', '/api/staff/roster/shifts', { user_id: ben.id, date: DAYS2[0], start: '09:00', finish: '17:00' }, admin);
  await call('POST', '/api/staff/roster/shifts', { user_id: cal.id, date: DAYS2[0], start: '08:00', finish: '16:00' }, admin);
  assert.equal((await call('POST', '/api/staff/roster/publish', { week: W2[0] }, admin)).status, 200);
  // a shift added after publishing is a draft: not rostered for pay
  await call('POST', '/api/staff/roster/shifts', { user_id: ben.id, date: DAYS2[1], start: '09:00', finish: '17:00' }, admin);
  // Ben's hours are typed in (9 h); Ana's are filled from the roster (start to finish: 8 h a day, 40 h)
  assert.equal((await call('POST', '/api/staff/timesheets', { user_id: ben.id, clock_in: `${DAYS2[0]}T09:00`, clock_out: `${DAYS2[0]}T18:00` }, admin)).status, 200);
  const f = await call('POST', '/api/staff/payroll/roster-hours', { period_start: W2[0], period_end: W2[1], user_ids: [ana.id] }, admin);
  assert.equal(f.status, 200, JSON.stringify(f.data)); assert.equal(f.data.saved, 5);

  const pv = (await call('POST', '/api/staff/payroll/preview', { period_start: W2[0], period_end: W2[1] }, admin)).data;
  const pa = pv.roster.rows.find(x => x.user_id === ana.id);
  assert.deepEqual([pa.rostered_hours, pa.paid_hours, pa.hours_difference, pa.hours_source], [37.5, 40, 2.5, 'roster']);
  assert.ok(!pv.roster.rows.some(x => x.user_id === cal.id));   // salary isn't paid by the hour

  const r = await call('POST', '/api/staff/payroll/runs', { period_start: W2[0], period_end: W2[1], pay_date: '2030-03-11' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const doc = readFile(r.data.accounting_file);
  assert.equal(doc.format, 'riyeser.payrun.v1');
  const a = doc.employees.find(e => e.name === 'Ana'), b = doc.employees.find(e => e.name === 'Ben'), c = doc.employees.find(e => e.name === 'Cal');
  assert.deepEqual([a.rostered_hours, a.paid_hours, a.hours_difference, a.hours_source], [37.5, 40, 2.5, 'roster']);
  assert.deepEqual([b.rostered_hours, b.paid_hours, b.hours_difference, b.hours_source], [8, 9, 1, 'typed']);
  for (const k of ROSTER_KEYS) assert.equal(c[k], undefined, `Cal ${k}`);
  assert.deepEqual(doc.roster_summary, { rostered_hours: 45.5, paid_hours: 49, hours_difference: 3.5, employees: 2, from_roster: 1 });
  // the money is the same as without the roster fields
  for (const e of doc.employees) assert.equal(e.net, Math.round((e.gross - e.tax_withheld - e.other_deductions) * 100) / 100);
  assert.equal(a.gross, 400); assert.equal(b.gross, 108);
  // the finalised pay run shows the same
  const run = (await call('GET', `/api/staff/payroll/runs/${r.data.id}`, null, admin)).data;
  assert.deepEqual(run.roster.total, doc.roster_summary);
  // the same in a pay run whose hours an admin changed: those are typed
  assert.equal((await call('DELETE', `/api/staff/payroll/runs/${r.data.id}`, null, admin)).status, 200);
  const pv2 = (await call('POST', '/api/staff/payroll/preview', { period_start: W2[0], period_end: W2[1], adjustments: { [ana.id]: { hours: 36, hours_note: 'left early Friday' } } }, admin)).data;
  const a2 = pv2.roster.rows.find(x => x.user_id === ana.id);
  assert.deepEqual([a2.rostered_hours, a2.paid_hours, a2.hours_difference, a2.hours_source], [37.5, 36, -1.5, 'typed']);
});

test('an extra pay run (bonus) has no hours, so no roster fields', async () => {
  const r = await call('POST', '/api/staff/payroll/runs', { period_start: W2[0], period_end: W2[1], pay_date: '2030-03-12', extra_run: true, extra_reason: 'Bonus', adjustments: { [ana.id]: { allowances: 50 } } }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const doc = readFile(r.data.accounting_file);
  assert.equal(doc.roster_summary, undefined); assert.equal(doc.employees[0].rostered_hours, undefined);
});
