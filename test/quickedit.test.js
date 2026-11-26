// OWNER-QUICKEDIT / OWNER-NEXTRUN (Payroll 2.2.5): change or delete a day's hours in place (not on paid days), one-click
// "Start next pay run" (copy last week's hours or start empty), Approve all, and Timesheets on the pay run's dates.
// Fixed dates in 2031 (weekly, Thursday to Wednesday), so nothing depends on today's date. Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3992;
const B = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-quickedit-'));
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

let admin, ana, ben, run1;
const WEEK1 = ['2031-03-06', '2031-03-07', '2031-03-10', '2031-03-11', '2031-03-12'];   // Thu 6 – Wed 12 Mar 2031, weekdays
const bulk = list => call('POST', '/api/staff/timesheets/bulk', { entries: list.map(([user_id, clock_in, clock_out]) => ({ user_id, clock_in, clock_out })) }, admin);
const sheet = (uid, from, to) => call('GET', `/api/staff/timesheets?user_id=${uid}&from=${from}&to=${to}`, null, admin).then(r => r.data);
const paidSum = rows => Math.round(rows.reduce((a, r) => a + (r.clock_out ? r.paid_hours : 0), 0) * 100) / 100;

test('setup: weekly Thursday–Wednesday, a finalised pay run for Thu 6 – Wed 12 Mar 2031', async () => {
  admin = (await call('POST', '/api/auth/login', { username: 'admin', password: 'AdminPass123' })).cookie;
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 52, pay_cycle_start: '2031-01-02' }, admin)).status, 200);
  const add = async (name, o) => (await call('POST', '/api/staff/employees', { name, username: name.toLowerCase(), password: 'staffpass1', role: 'staff', pay_type: 'hourly', pay_rate: 10, ...o }, admin)).data;
  ana = await add('Ana'); ben = await add('Ben', { pay_rate: 12 }); await add('Cal', { pay_type: 'salary', pay_rate: 52000 });
  const r = await bulk([...WEEK1.map(d => [ana.id, `${d}T09:00`, `${d}T17:00`]), ...WEEK1.map(d => [ben.id, `${d}T09:00`, `${d}T17:00`])]);
  assert.equal(r.data.saved, 10, JSON.stringify(r.data));
  const run = await call('POST', '/api/staff/payroll/runs', { period_start: '2031-03-06', period_end: '2031-03-12', pay_date: '2031-03-13' }, admin);
  assert.equal(run.status, 200, JSON.stringify(run.data)); run1 = run.data.id;
});

test('quick edit: change and delete a line (audited), overlaps still refused', async () => {
  assert.equal((await bulk([[ana.id, '2031-03-14T09:00', '2031-03-14T17:00'], [ana.id, '2031-03-14T18:00', '2031-03-14T20:00']])).data.saved, 2);
  const [day, evening] = (await sheet(ana.id, '2031-03-14', '2031-03-14')).sort((a, b) => a.clock_in.localeCompare(b.clock_in));
  assert.equal(day.paid_run_id, null);
  const put = await call('PUT', `/api/staff/timesheets/${day.id}`, { clock_in: '2031-03-14T08:30', clock_out: '2031-03-14T15:00', notes: '' }, admin);
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const after1 = (await sheet(ana.id, '2031-03-14', '2031-03-14')).find(t => t.id === day.id);
  assert.deepEqual([after1.clock_in, after1.clock_out, after1.hours], ['2031-03-14T08:30', '2031-03-14T15:00', 6.5]);
  const au = (await call('GET', '/api/staff/audit', null, admin)).data.find(e => e.action === 'Changed a shift');
  assert.match(au.details, /Ana: 2031-03-14 9:00am–5:00pm → 2031-03-14 8:30am–3:00pm/);
  // overlap with the evening shift: refused, nothing changed
  const clash = await call('PUT', `/api/staff/timesheets/${day.id}`, { clock_in: '2031-03-14T08:30', clock_out: '2031-03-14T19:00', notes: '' }, admin);
  assert.equal(clash.status, 400); assert.match(clash.data.error, /overlaps another shift/);
  assert.equal((await call('DELETE', `/api/staff/timesheets/${evening.id}`, null, admin)).status, 200);
  assert.equal((await call('DELETE', `/api/staff/timesheets/${day.id}`, null, admin)).status, 200);
  assert.deepEqual(await sheet(ana.id, '2031-03-14', '2031-03-14'), []);
  assert.ok((await call('GET', '/api/staff/audit', null, admin)).data.some(e => e.action === 'Deleted a shift' && /Ana: 2031-03-14T08:30/.test(e.details)));
});

test('quick edit: paid days are locked (change, delete, move into, add), and the list says which run paid them', async () => {
  const rows = await sheet(ana.id, '2031-03-06', '2031-03-12');
  assert.equal(rows.length, 5); assert.ok(rows.every(t => t.paid_run_id === run1));
  const fri = rows.find(t => t.clock_in.startsWith('2031-03-07'));
  const put = await call('PUT', `/api/staff/timesheets/${fri.id}`, { clock_in: '2031-03-07T09:00', clock_out: '2031-03-07T12:00', notes: '' }, admin);
  assert.equal(put.status, 409); assert.match(put.data.error, new RegExp(`2031-03-07 is already paid \\(pay run #${run1}, paid 2031-03-13\\)`)); assert.equal(put.data.paid.run_id, run1);
  const del = await call('DELETE', `/api/staff/timesheets/${fri.id}`, null, admin);
  assert.equal(del.status, 409); assert.match(del.data.error, /Paid days can't be changed/);
  assert.equal((await sheet(ana.id, '2031-03-07', '2031-03-07'))[0].clock_out, '2031-03-07T17:00');   // untouched
  // an unpaid shift can't be moved onto a paid day, and no new shift can be added on one
  assert.equal((await bulk([[ana.id, '2031-03-15T09:00', '2031-03-15T12:00']])).data.saved, 1);
  const sat = (await sheet(ana.id, '2031-03-15', '2031-03-15'))[0];
  assert.equal((await call('PUT', `/api/staff/timesheets/${sat.id}`, { clock_in: '2031-03-08T09:00', clock_out: '2031-03-08T12:00', notes: '' }, admin)).status, 409);
  assert.equal((await call('POST', '/api/staff/timesheets', { user_id: ana.id, clock_in: '2031-03-08T09:00', clock_out: '2031-03-08T12:00' }, admin)).status, 409);
  assert.equal((await bulk([[ana.id, '2031-03-09T09:00', '2031-03-09T12:00']])).data.failed, 1);
  assert.equal((await call('DELETE', `/api/staff/timesheets/${sat.id}`, null, admin)).status, 200);
});

test('period mismatch: Timesheets opens on the pay run\'s period, so its hours are the pay run\'s hours', async () => {
  // like the owner's: Ben has no hours on Thu 13 but has Thu 20, the first day of the period after
  assert.equal((await bulk(['2031-03-14', '2031-03-17', '2031-03-18', '2031-03-19', '2031-03-20'].map(d => [ben.id, `${d}T09:00`, `${d}T17:00`]))).data.saved, 5);
  const pp = (await call('GET', '/api/staff/payroll/period?date=2031-03-13', null, admin)).data;
  const next = (await call('GET', '/api/staff/payroll/next-period', null, admin)).data;
  assert.deepEqual(pp.open, ['2031-03-13', '2031-03-19']); assert.deepEqual(pp.open, [next.start, next.end]);
  assert.deepEqual(pp.current, pp.open);   // a whole pay period (the page shows "Pay period: Thu 13 – Wed 19 Mar 2031")
  const pv = (await call('POST', '/api/staff/payroll/preview', { period_start: pp.open[0], period_end: pp.open[1] }, admin)).data;
  const benLine = pv.lines.find(l => l.user_id === ben.id);
  assert.equal(benLine.hours, 32);
  assert.equal(paidSum(await sheet(ben.id, pp.open[0], pp.open[1])), benLine.hours);   // the same dates: the same hours
  assert.equal(paidSum(await sheet(ben.id, '2031-03-13', '2031-03-20')), 40);          // a range running into Thu 20 shows 40: the owner's mismatch
});

test('Start next pay run: "ask" needs a choice; copy opens the period and copies last week\'s hours in one step', async () => {
  assert.equal((await call('GET', '/api/staff/payroll/rules', null, admin)).data.new_payrun_hours, 'ask');
  let n = (await call('GET', '/api/staff/payroll/next-period', null, admin)).data;
  assert.deepEqual([n.start, n.end, n.started, n.last_run.id], ['2031-03-13', '2031-03-19', false, run1]);
  const ask = await call('POST', '/api/staff/payroll/next-run', {}, admin);
  assert.equal(ask.status, 400); assert.match(ask.data.error, /copy last week's hours, fill them from the roster, or start empty/);
  const r = await call('POST', '/api/staff/payroll/next-run', { mode: 'copy' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Ana: all 5 days; Ben: only Thu 13 (he has the others already); Cal is salaried
  assert.deepEqual([r.data.start, r.data.end, r.data.mode, r.data.copied_people, r.data.copied_shifts, r.data.already_started], ['2031-03-13', '2031-03-19', 'copy', 2, 6, false]);
  assert.equal(r.data.message, "Copied 2 people's hours from last week. Check and change anything that's different.");
  assert.deepEqual(r.data.salaried.map(x => x.name), ['Cal']);
  const ts = [...await sheet(ana.id, '2031-03-13', '2031-03-19'), ...await sheet(ben.id, '2031-03-13', '2031-03-19')];
  const copied = ts.filter(t => /^copied from 6–12 Mar 2031/.test(t.notes));
  assert.equal(copied.length, 6); assert.ok(copied.every(t => !t.approved_by && t.paid_run_id === null));
  n = (await call('GET', '/api/staff/payroll/next-period', null, admin)).data;
  assert.equal(n.started, true); assert.equal(n.copied_unapproved, 6); assert.equal(n.open_period.mode, 'copy');
  const pv = (await call('POST', '/api/staff/payroll/preview', { period_start: n.start, period_end: n.end }, admin)).data;
  assert.equal(pv.lines.find(l => l.user_id === ana.id).hours, 40); assert.equal(pv.lines.find(l => l.user_id === ben.id).hours, 40);
  assert.match((await call('GET', '/api/staff/audit', null, admin)).data.find(e => e.action === 'Started a pay run').details, /13–19 Mar 2031: copied 6 shifts for 2 people from last week/);
});

test('Start next pay run twice: the same period, nothing copied again', async () => {
  const count = async () => (await sheet(ana.id, '2031-03-13', '2031-03-19')).length + (await sheet(ben.id, '2031-03-13', '2031-03-19')).length;
  const before = await count();
  const [x, y] = await Promise.all([call('POST', '/api/staff/payroll/next-run', { mode: 'copy' }, admin), call('POST', '/api/staff/payroll/next-run', { mode: 'empty' }, admin)]);
  for (const r of [x, y]) { assert.equal(r.status, 200); assert.equal(r.data.already_started, true); assert.equal(r.data.copied_shifts, 0); assert.equal(r.data.start, '2031-03-13'); assert.match(r.data.message, /already started.*Nothing was copied again/); }
  assert.equal(await count(), before);
  // and the separate "Copy last week's hours" finds nothing left to copy
  const p = (await call('POST', '/api/staff/payroll/copy-hours/preview', { period_start: '2031-03-13', period_end: '2031-03-19' }, admin)).data;
  assert.ok(p.people.every(x2 => x2.rows.every(r => r.skip)));
});

test('Approve all: a summary first, then every unapproved shift in the period', async () => {
  const dry = (await call('POST', '/api/staff/timesheets/approve-all', { from: '2031-03-13', to: '2031-03-19', dry_run: true }, admin)).data;
  assert.deepEqual([dry.shifts, dry.people, dry.names, dry.hours, dry.approved], [10, 2, ['Ana', 'Ben'], 80, 0]);
  const go = (await call('POST', '/api/staff/timesheets/approve-all', { from: '2031-03-13', to: '2031-03-19' }, admin)).data;
  assert.equal(go.approved, 10);
  assert.equal((await call('POST', '/api/staff/timesheets/approve-all', { from: '2031-03-13', to: '2031-03-19', dry_run: true }, admin)).data.shifts, 0);
  assert.equal((await call('GET', '/api/staff/payroll/next-period', null, admin)).data.copied_unapproved, 0);
  assert.equal((await call('POST', '/api/staff/timesheets/approve-all', { from: '2031-03-19', to: '2031-03-13' }, admin)).status, 400);
});

test('"Always start empty": no hours copied, and "Copy last week\'s hours" still works afterwards', async () => {
  assert.equal((await call('POST', '/api/staff/payroll/runs', { period_start: '2031-03-13', period_end: '2031-03-19', pay_date: '2031-03-20' }, admin)).status, 200);
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { new_payrun_hours: 'sometimes' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/staff/settings', { new_payrun_hours: 'sometimes' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { new_payrun_hours: 'empty' }, admin)).status, 200);
  const n = (await call('GET', '/api/staff/payroll/next-period', null, admin)).data;
  assert.deepEqual([n.start, n.end, n.started, n.new_payrun_hours], ['2031-03-20', '2031-03-26', false, 'empty']);
  const r = (await call('POST', '/api/staff/payroll/next-run', {}, admin)).data;
  assert.deepEqual([r.mode, r.copied_people, r.copied_shifts], ['empty', 0, 0]);
  assert.match(r.message, /20–26 Mar 2031 started with no hours/);
  assert.equal((await sheet(ana.id, '2031-03-20', '2031-03-26')).length, 0);
  assert.equal((await sheet(ben.id, '2031-03-20', '2031-03-26')).length, 1);   // his own Thu 20, nothing added
  // copying later, by hand
  const p = (await call('POST', '/api/staff/payroll/copy-hours/preview', { period_start: '2031-03-20', period_end: '2031-03-26' }, admin)).data;
  const anaRows = p.people.find(x => x.user_id === ana.id).rows.filter(x => !x.skip);
  assert.equal(anaRows.length, 5);
  const c = (await call('POST', '/api/staff/payroll/copy-hours', { period_start: '2031-03-20', period_end: '2031-03-26', entries: anaRows.map(x => ({ user_id: ana.id, clock_in: x.clock_in, clock_out: x.clock_out })) }, admin)).data;
  assert.equal(c.saved, 5);
  // the period stays started (empty), and a second click still copies nothing
  assert.equal((await call('POST', '/api/staff/payroll/next-run', { mode: 'copy' }, admin)).data.already_started, true);
});

test('"Always copy last week": Start next pay run copies without asking', async () => {
  assert.equal((await call('POST', '/api/staff/payroll/runs', { period_start: '2031-03-20', period_end: '2031-03-26', pay_date: '2031-03-27' }, admin)).status, 200);
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { new_payrun_hours: 'copy' }, admin)).status, 200);
  // two clicks at once (a double click, or two computers): one starts it, the other just opens it
  const both = (await Promise.all([1, 2].map(() => call('POST', '/api/staff/payroll/next-run', {}, admin)))).map(x => x.data);
  const r = both.find(x => !x.already_started);
  assert.equal(both.filter(x => x.already_started).length, 1);
  assert.deepEqual([r.start, r.end, r.mode, r.copied_people, r.copied_shifts], ['2031-03-27', '2031-04-02', 'copy', 2, 6]);   // Ana's 5 copied days and Ben's Thu 20
  assert.equal((await sheet(ana.id, '2031-03-27', '2031-04-02')).length, 5);
  assert.equal((await sheet(ben.id, '2031-03-27', '2031-04-02')).length, 1);
});
