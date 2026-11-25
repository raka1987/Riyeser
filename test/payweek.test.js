// OWNER-PAYWEEK: "Start next pay week" and "Copy last week's hours". Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3993;
const B = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-payweek-'));
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

let admin, ana, ben, cal, dee, run1;
const shift = (user_id, clock_in, clock_out) => call('POST', '/api/staff/timesheets/bulk', { entries: [{ user_id, clock_in, clock_out }] }, admin);

test('setup: a weekly pay run for 12–18 Nov, like the owner\'s', async () => {
  admin = (await call('POST', '/api/auth/login', { username: 'admin', password: 'AdminPass123' })).cookie;
  await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 52 }, admin);
  const add = async (name, o) => (await call('POST', '/api/staff/employees', { name, username: name.toLowerCase(), password: 'staffpass1', role: 'staff', pay_type: 'hourly', pay_rate: 10, ...o }, admin)).data;
  ana = await add('Ana'); ben = await add('Ben', { pay_rate: 12 }); cal = await add('Cal', { pay_type: 'salary', pay_rate: 52000 }); dee = await add('Dee');
  for (const [u, a, b] of [[ana, '2029-11-12T08:00', '2029-11-12T16:00'], [ana, '2029-11-14T08:00', '2029-11-14T12:00'], [ana, '2029-11-15T22:00', '2029-11-16T06:00'],
    [ben, '2029-11-12T09:00', '2029-11-12T17:00'], [ben, '2029-11-13T09:00', '2029-11-13T17:00'], [dee, '2029-11-12T08:00', '2029-11-12T16:00']]) assert.equal((await shift(u.id, a, b)).data.saved, 1);
  const r = await call('POST', '/api/staff/payroll/runs', { period_start: '2029-11-12', period_end: '2029-11-18', pay_date: '2029-11-19' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data)); run1 = r.data.id;
  // timesheets already in for 19–20 Nov (like the owner's 12–20 Nov)
  await shift(ben.id, '2029-11-20T10:00', '2029-11-20T14:00');
  await call('PUT', `/api/staff/employees/${dee.id}`, { active: false }, admin);
});

test('next period: straight after the last pay run, weekly and fortnightly, with the recent periods listed', async () => {
  let n = (await call('GET', '/api/staff/payroll/next-period', null, admin)).data;
  assert.equal(n.start, '2029-11-19'); assert.equal(n.end, '2029-11-25'); assert.equal(n.frequency, 'weekly'); assert.equal(n.last_run.id, run1);
  const paid = n.periods.find(p => p.paid);
  assert.deepEqual([paid.label, paid.run_id], ['12–18 Nov 2029', run1]);
  const next = n.periods.find(p => !p.paid);
  assert.deepEqual([next.label, next.start, next.entries], ['19–25 Nov 2029', '2029-11-19', 1]);
  await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 26 }, admin);
  n = (await call('GET', '/api/staff/payroll/next-period', null, admin)).data;
  assert.deepEqual([n.start, n.end, n.frequency, n.label], ['2029-11-19', '2029-12-02', 'fortnightly', '19 Nov–2 Dec 2029']);
  await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 52 }, admin);
  // an extra (bonus) run doesn't move the next period on
  await call('POST', '/api/staff/payroll/runs', { period_start: '2029-11-12', period_end: '2029-11-18', pay_date: '2029-11-20', extra_run: true, extra_reason: 'Bonus', adjustments: { [ana.id]: { allowances: 50 } } }, admin);
  assert.equal((await call('GET', '/api/staff/payroll/next-period', null, admin)).data.start, '2029-11-19');
  // F11 still holds: the paid week can't be paid again
  assert.equal((await call('POST', '/api/staff/payroll/preview', { period_start: '2029-11-12', period_end: '2029-11-18' }, admin)).data.already_paid.run_id, run1);
});

test('copy hours: dates moved on a week, existing entries, leave, inactive and salaried staff skipped; paid dates refused', async () => {
  assert.equal((await call('POST', '/api/staff/leave', { user_id: ana.id, kind: 'annual', date_from: '2029-11-21', days: 1 }, admin)).status, 200);
  const paid = await call('POST', '/api/staff/payroll/copy-hours/preview', { period_start: '2029-11-12', period_end: '2029-11-18' }, admin);
  assert.equal(paid.status, 409); assert.match(paid.data.error, /already paid \(pay run #\d+/);
  const p = (await call('POST', '/api/staff/payroll/copy-hours/preview', { period_start: '2029-11-19', period_end: '2029-11-25' }, admin)).data;
  assert.equal(p.from_label, '12–18 Nov 2029'); assert.equal(p.entries, 1); assert.equal(p.previous_entries, 5);   // Dee is switched off: not counted
  assert.deepEqual(p.people.map(x => x.name), ['Ana', 'Ben']);   // not Dee (switched off), not Cal (salary)
  assert.deepEqual(p.salaried.map(x => x.name), ['Cal']);
  const a = p.people[0];
  assert.deepEqual(a.rows.map(r => [r.clock_in, r.clock_out, r.hours, r.skip]), [
    ['2029-11-19T08:00', '2029-11-19T16:00', 8, ''], ['2029-11-21T08:00', '2029-11-21T12:00', 4, 'on annual leave'], ['2029-11-22T22:00', '2029-11-23T06:00', 8, '']]);
  assert.equal(a.total, 16);
  assert.deepEqual(p.people[1].rows.map(r => [r.date, r.skip]), [['2029-11-19', ''], ['2029-11-20', 'already has an entry that day']]);
  // into paid dates: refused
  assert.equal((await call('POST', '/api/staff/payroll/copy-hours', { period_start: '2029-11-12', period_end: '2029-11-18', entries: [{ user_id: ana.id, clock_in: '2029-11-12T08:00', clock_out: '2029-11-12T09:00' }] }, admin)).status, 409);
  // skipped days and inactive staff can't be forced in
  const forced = await call('POST', '/api/staff/payroll/copy-hours', { period_start: '2029-11-19', period_end: '2029-11-25', entries: [
    { user_id: ben.id, clock_in: '2029-11-20T09:00', clock_out: '2029-11-20T17:00' }, { user_id: ana.id, clock_in: '2029-11-21T08:00', clock_out: '2029-11-21T12:00' }, { user_id: dee.id, clock_in: '2029-11-19T08:00', clock_out: '2029-11-19T16:00' }] }, admin);
  assert.equal(forced.data.saved, 0); assert.equal(forced.data.failed, 3);
});

test('copied hours (one edited) are marked, unapproved, and flow into the pay run', async () => {
  const r = await call('POST', '/api/staff/payroll/copy-hours', { period_start: '2029-11-19', period_end: '2029-11-25', entries: [
    { user_id: ana.id, clock_in: '2029-11-19T08:00', clock_out: '2029-11-19T14:00' },   // edited: 6 hours instead of 8
    { user_id: ana.id, clock_in: '2029-11-22T22:00', clock_out: '2029-11-23T06:00' }, { user_id: ben.id, clock_in: '2029-11-19T09:00', clock_out: '2029-11-19T17:00' }] }, admin);
  assert.equal(r.status, 200); assert.equal(r.data.saved, 3, JSON.stringify(r.data));
  const ts = (await call('GET', '/api/staff/timesheets?from=2029-11-19&to=2029-11-25', null, admin)).data;
  const copied = ts.filter(t => /copied from 12–18 Nov 2029/.test(t.notes));
  assert.equal(copied.length, 3); assert.ok(copied.every(t => !t.approved_by));
  // copying again: those days are now taken
  const again = (await call('POST', '/api/staff/payroll/copy-hours/preview', { period_start: '2029-11-19', period_end: '2029-11-25' }, admin)).data;
  assert.ok(again.people.every(x => x.rows.every(row => row.skip)));
  const pv = (await call('POST', '/api/staff/payroll/preview', { period_start: '2029-11-19', period_end: '2029-11-25' }, admin)).data;
  const line = n => pv.lines.find(l => l.employee_name === n);
  assert.equal(line('Ana').hours, 14); assert.equal(line('Ana').base_pay, 140);
  assert.equal(line('Ben').hours, 12); assert.equal(line('Ben').base_pay, 144);   // 8 copied + his own 4
  assert.equal(pv.already_paid, null);
  const run2 = await call('POST', '/api/staff/payroll/runs', { period_start: '2029-11-19', period_end: '2029-11-25', pay_date: '2029-11-26' }, admin);
  assert.equal(run2.status, 200, JSON.stringify(run2.data));
  assert.equal((await call('GET', '/api/staff/payroll/next-period', null, admin)).data.start, '2029-11-26');
  assert.equal((await call('POST', '/api/staff/payroll/copy-hours/preview', { period_start: '2029-11-19', period_end: '2029-11-25' }, admin)).status, 409);
  const au = (await call('GET', '/api/staff/audit', null, admin)).data.find(e => e.action === 'Copied hours');
  assert.match(au.details, /3 shifts into 19–25 Nov 2029, copied from 12–18 Nov 2029/);
});
