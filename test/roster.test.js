// OWNER-ROSTER (Payroll 2.3.0): the week's roster, publishing it, the time clock and Timesheets against it, and filling a
// pay run's hours from it. Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3991;
const B = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-roster-'));
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

// the week of Monday 12 Nov 2029 (weekly pay, weeks start on Mondays)
const MON = '2029-11-12', TUE = '2029-11-13', WED = '2029-11-14', THU = '2029-11-15', FRI = '2029-11-16';
let admin, anaC, ana, ben, cal;
const add = (body, c = admin) => call('POST', '/api/staff/roster/shifts', body, c);
const week = (w = MON, c = admin) => call('GET', `/api/staff/roster?week=${w}`, null, c).then(r => r.data);
const person = (w, u) => w.people.find(p => p.id === u.id);

test('setup: three staff, weekly pay', async () => {
  admin = (await call('POST', '/api/auth/login', { username: 'admin', password: 'AdminPass123' })).cookie;
  await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 52 }, admin);
  const emp = async (name, o) => (await call('POST', '/api/staff/employees', { name, username: name.toLowerCase(), password: 'staffpass1', role: 'staff', pay_type: 'hourly', pay_rate: 10, ...o }, admin)).data;
  ana = await emp('Ana'); ben = await emp('Ben', { pay_rate: 12 }); cal = await emp('Cal', { pay_type: 'salary', pay_rate: 52000 });
  anaC = (await call('POST', '/api/auth/login', { username: 'ana', password: 'staffpass1' })).cookie;
});

test('add shifts: hours less the break, estimated wages, totals; the week starts on the Monday', async () => {
  const r = await add({ user_id: ana.id, date: MON, start: '09:00', finish: '17:00', break_min: 30, role: 'Cafe', note: 'Open up' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.warnings, []);
  await add({ user_id: cal.id, date: MON, start: '08:00', finish: '16:00' });
  const w = await week(WED);
  assert.equal(w.week_start, MON); assert.equal(w.week_end, '2029-11-18'); assert.equal(w.days.length, 7);
  assert.equal(w.label, 'Mon 12 – Sun 18 Nov 2029');
  const a = person(w, ana);
  assert.deepEqual([a.shifts[0].hours, a.shifts[0].role, a.shifts[0].note, a.hours, a.wages], [7.5, 'Cafe', 'Open up', 7.5, 75]);
  assert.equal(person(w, cal).wages, null);   // salaried: no estimate from hours
  assert.deepEqual([w.totals.hours, w.totals.wages, w.totals.shifts, w.totals.salaried], [15.5, 75, 2, 1]);
  assert.equal(w.published, null); assert.ok(w.roles.includes('Cafe'));
  // a night shift: finishes the next morning
  const n = await add({ user_id: ben.id, date: FRI, start: '22:00', finish: '06:00' });
  assert.equal(n.status, 200);
  assert.equal(person(await week(), ben).hours, 8);
  // checks
  assert.equal((await add({ user_id: ana.id, date: MON, start: '09:00', finish: '09:00' })).status, 400);
  assert.equal((await add({ user_id: ana.id, date: MON, start: '09:00', finish: '10:00', break_min: 90 })).status, 400);
  assert.equal((await add({ user_id: 9999, date: MON, start: '09:00', finish: '10:00' })).status, 400);
});

test('warnings: overlaps, leave already booked, long shifts, over the normal week; shown but still saved', async () => {
  const o = await add({ user_id: ana.id, date: MON, start: '16:00', finish: '20:00' });
  assert.equal(o.status, 200); assert.match(o.data.warnings.join(), /Overlaps 9:00am–5:00pm on Mon 12 Nov/);
  assert.equal((await call('POST', '/api/staff/leave', { user_id: ben.id, kind: 'annual', date_from: TUE, days: 1 }, admin)).status, 200);
  const l = await add({ user_id: ben.id, date: TUE, start: '09:00', finish: '17:00' });
  assert.match(l.data.warnings.join(), /On annual leave this day \(already booked\)/);
  const lg = await add({ user_id: ben.id, date: WED, start: '05:00', finish: '19:00' });
  assert.match(lg.data.warnings.join(), /A long shift: 14 hours/);
  for (const d of [THU, '2029-11-17', '2029-11-18']) await add({ user_id: ben.id, date: d, start: '06:00', finish: '18:00' });
  const w = await week();
  const b = person(w, ben);
  assert.equal(b.leave[TUE], 'annual');
  assert.match(b.warnings.join(), /over the normal 40-hour week/);
  assert.ok(w.totals.warnings >= 3);
  // the overlap goes once the extra shift moves
  const extra = person(w, ana).shifts.find(s => s.start === '16:00');
  const mv = await call('PUT', `/api/staff/roster/shifts/${extra.id}`, { date: TUE, start: '12:00', finish: '16:00' }, admin);
  assert.deepEqual(mv.data.warnings, []);
});

test('open shifts, then given to someone; repeat a shift on other days', async () => {
  const o = await add({ user_id: null, date: WED, start: '10:00', finish: '14:00', role: 'Till' });
  let w = await week();
  assert.equal(w.open.length, 1); assert.equal(w.totals.open, 1); assert.equal(w.open[0].role, 'Till');
  await call('PUT', `/api/staff/roster/shifts/${o.data.id}`, { user_id: cal.id }, admin);
  w = await week(); assert.equal(w.open.length, 0); assert.ok(person(w, cal).shifts.some(s => s.role === 'Till'));
  const monShift = person(w, ana).shifts.find(s => s.date === MON && s.start === '09:00');
  const rep = await call('POST', `/api/staff/roster/shifts/${monShift.id}/repeat`, { dates: [TUE, WED, THU, FRI] }, admin);
  assert.equal(rep.data.added, 4);
  const again = await call('POST', `/api/staff/roster/shifts/${monShift.id}/repeat`, { dates: [TUE, WED] }, admin);
  assert.deepEqual([again.data.added, again.data.skipped], [0, [TUE, WED]]);
  w = await week();
  assert.equal(person(w, ana).shifts.filter(s => s.start === '09:00' && s.role === 'Cafe' && s.break_min === 30).length, 5);
});

test('only people with Add & edit access to Timesheets plan the roster', async () => {
  assert.equal((await add({ user_id: ana.id, date: MON, start: '09:00', finish: '10:00' }, anaC)).status, 403);
  assert.equal((await call('GET', `/api/staff/roster?week=${MON}`, null, anaC)).status, 403);
  assert.equal((await call('POST', '/api/staff/roster/publish', { week: MON }, anaC)).status, 403);
  // before publishing, staff see nothing for the week
  const p = (await call('GET', `/api/staff/roster/published?week=${MON}`, null, anaC)).data;
  assert.equal(p.published, null); assert.equal(p.people.length, 0); assert.match(p.text, /isn't published yet/);
});

let firstPub;
test('publish: staff see the published roster (no pay), as text for WhatsApp too; later changes are a draft until published again', async () => {
  const r = await call('POST', '/api/staff/roster/publish', { week: TUE }, admin);
  assert.equal(r.status, 200); assert.equal(r.data.again, false); firstPub = r.data.shifts;
  const p = (await call('GET', `/api/staff/roster/published?week=${MON}`, null, anaC)).data;
  assert.ok(p.published); assert.equal(p.me, ana.id);
  const a = p.people.find(x => x.id === ana.id);
  assert.equal(a.shifts.length, 6); assert.ok(a.shifts.every(s => !s.changed)); assert.equal(a.pay_rate, undefined); assert.equal(a.wages, undefined);
  assert.match(p.text, /\*My Company roster: Mon 12 – Sun 18 Nov 2029\*/);
  assert.match(p.text, /\*Mon 12 Nov\*\n- Cal: 8:00am-4:00pm\n- Ana: 9:00am-5:00pm Cafe \(30 min break\)\. Open up/);
  let w = await week();
  assert.ok(w.published.at); assert.deepEqual(w.pending, { new: 0, changed: 0, removed: 0 });
  // change one, remove one, add one: staff still see the published roster
  const monA = person(w, ana).shifts.find(s => s.date === MON && s.start === '09:00'), tueA = person(w, ana).shifts.find(s => s.date === TUE && s.start === '12:00');
  await call('PUT', `/api/staff/roster/shifts/${monA.id}`, { start: '10:00' }, admin);
  assert.equal((await call('DELETE', `/api/staff/roster/shifts/${tueA.id}`, null, admin)).data.removed, true);
  await add({ user_id: ben.id, date: MON, start: '12:00', finish: '16:00' });
  w = await week();
  assert.deepEqual(w.pending, { new: 1, changed: 1, removed: 1 });
  assert.equal(person(w, ana).shifts.find(s => s.id === monA.id).state, 'changed');
  assert.equal(person(w, ana).shifts.find(s => s.id === tueA.id).state, 'removed');
  assert.equal(person(w, ana).hours, 36.5);   // removed shifts aren't counted
  const still = (await call('GET', `/api/staff/roster/published?week=${MON}`, null, anaC)).data.people.find(x => x.id === ana.id);
  assert.equal(still.shifts.find(s => s.id === monA.id).start, '09:00'); assert.ok(still.shifts.some(s => s.id === tueA.id));
  // put back, and remove again
  await call('PUT', `/api/staff/roster/shifts/${tueA.id}`, { restore: true }, admin);
  assert.equal((await week()).pending.removed, 0);
  await call('DELETE', `/api/staff/roster/shifts/${tueA.id}`, null, admin);
  // publish again: staff see the change, marked "changed"
  const r2 = await call('POST', '/api/staff/roster/publish', { week: MON }, admin);
  assert.deepEqual([r2.data.again, r2.data.added, r2.data.changed, r2.data.removed], [true, 1, 1, 1]);
  const p2 = (await call('GET', `/api/staff/roster/published?week=${MON}`, null, anaC)).data;
  const a2 = p2.people.find(x => x.id === ana.id);
  assert.equal(a2.shifts.find(s => s.id === monA.id).start, '10:00'); assert.equal(a2.shifts.find(s => s.id === monA.id).changed, true);
  assert.ok(!a2.shifts.some(s => s.id === tueA.id));
  assert.ok(p2.people.find(x => x.id === ben.id).shifts.find(s => s.date === MON && s.start === '12:00').changed);
  assert.match(p2.text, /Ana: 10:00am-5:00pm Cafe \(30 min break\)\. Open up \(changed\)/);
  assert.match(p2.text, /Changes are marked \(changed\)/);
  assert.deepEqual((await week()).pending, { new: 0, changed: 0, removed: 0 });
  const au = (await call('GET', '/api/staff/audit', null, admin)).data.filter(e => e.action === 'Published the roster');
  assert.equal(au.length, 2); assert.match(au[0].details, /published again: 1 new, 1 changed, 1 removed/);
});

test('copy last week: a week on, skipping leave and shifts already there; replace takes the week off first', async () => {
  const NEXT = '2029-11-19';
  assert.equal((await call('POST', '/api/staff/leave', { user_id: ana.id, kind: 'sick', date_from: '2029-11-21', days: 1 }, admin)).status, 200);
  const before = await week(MON), n = before.people.reduce((t, p) => t + p.shifts.filter(s => !s.deleted).length, 0);
  const r = await call('POST', '/api/staff/roster/copy-week', { week: NEXT }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added + r.data.skipped.length, n);
  assert.ok(r.data.skipped.some(s => s.name === 'Ana' && s.date === '2029-11-21' && s.why === 'on leave that day'));
  const w = await week(NEXT);
  assert.equal(person(w, ana).shifts.find(s => s.date === NEXT).start, '10:00');
  const again = await call('POST', '/api/staff/roster/copy-week', { week: NEXT }, admin);
  assert.equal(again.data.added, 0); assert.ok(again.data.skipped.every(s => ['already on the roster', 'on leave that day'].includes(s.why)));
  const rep = await call('POST', '/api/staff/roster/copy-week', { week: NEXT, replace: true }, admin);
  assert.equal(rep.data.removed, r.data.added); assert.equal(rep.data.added, r.data.added);
  assert.equal((await call('POST', '/api/staff/roster/copy-week', { week: '2031-01-06' }, admin)).status, 400);   // nothing the week before
});

test('Timesheets show early / late against the published roster', async () => {
  // Ben: rostered Mon 12:00–4:00pm (published), clocked 11:50am–4:20pm
  await call('POST', '/api/staff/timesheets', { user_id: ben.id, clock_in: `${MON}T11:50`, clock_out: `${MON}T16:20` }, admin);
  // Ana: rostered Mon 10:00am (published again), clocked 10:07am–4:45pm
  await call('POST', '/api/staff/timesheets', { user_id: ana.id, clock_in: `${MON}T10:07`, clock_out: `${MON}T16:45` }, admin);
  const ts = (await call('GET', `/api/staff/timesheets?from=${MON}&to=${MON}`, null, admin)).data;
  const b = ts.find(t => t.user_id === ben.id), a = ts.find(t => t.user_id === ana.id);
  assert.deepEqual([b.roster.start, b.roster.finish, b.roster.in_min, b.roster.out_min], ['12:00', '16:00', -10, 20]);
  assert.deepEqual([a.roster.start, a.roster.in_min, a.roster.out_min], ['10:00', 7, -15]);
  // a shift with nothing rostered near it
  await call('POST', '/api/staff/timesheets', { user_id: cal.id, clock_in: '2029-11-25T09:00', clock_out: '2029-11-25T10:00' }, admin);
  assert.equal((await call('GET', `/api/staff/timesheets?user_id=${cal.id}&from=2029-11-25&to=2029-11-25`, null, admin)).data[0].roster, null);
});

test('time clock: after tapping a name, their published shifts; clocking in says early or late', async () => {
  const now = new Date(), fiji = d => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Pacific/Fiji', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  const s = fiji(new Date(now.getTime() - 20 * 60000)), f = fiji(new Date(now.getTime() + 3 * 3600000));
  const date = `${s.year}-${s.month}-${s.day}`, start = `${s.hour}:${s.minute}`, finish = `${f.hour}:${f.minute}`;
  const dee = (await call('POST', '/api/staff/employees', { name: 'Dee', username: 'dee', password: 'staffpass1', role: 'staff', pay_type: 'hourly', pay_rate: 10 }, admin)).data;
  const pin = (await call('GET', '/api/staff/employees', null, admin)).data.find(e => e.id === dee.id).clock_pin;
  await add({ user_id: dee.id, date, start, finish, role: 'Kitchen' });
  // not published yet: nothing on the time clock
  assert.deepEqual((await call('GET', `/api/staff/timeclock/roster?user_id=${dee.id}`, null, admin)).data.shifts, []);
  await call('POST', '/api/staff/roster/publish', { week: date }, admin);
  const tc = (await call('GET', `/api/staff/timeclock/roster?user_id=${dee.id}`, null, anaC)).data;
  assert.equal(tc.shifts.length, 1); assert.deepEqual([tc.shifts[0].start, tc.shifts[0].role], [start, 'Kitchen']);
  const p = await call('POST', '/api/staff/timeclock/punch', { user_id: dee.id, pin }, admin);
  assert.equal(p.status, 200, JSON.stringify(p.data)); assert.equal(p.data.on_shift, true);
  assert.equal(p.data.roster.start, start); assert.ok(p.data.roster.in_min >= 19 && p.data.roster.in_min <= 21, JSON.stringify(p.data.roster));
  const ts = (await call('GET', `/api/staff/timesheets?user_id=${dee.id}`, null, admin)).data[0];
  assert.ok(ts.roster && ts.roster.in_min >= 19 && ts.roster.in_min <= 21);
});

test('pay run: "Fill from the roster" for hourly staff with no clock times; people who clocked in keep their own hours', async () => {
  // a pay run for the week before, so the next one is the roster's week
  const r0 = await call('POST', '/api/staff/payroll/runs', { period_start: '2029-11-05', period_end: '2029-11-11', pay_date: '2029-11-12' }, admin);
  assert.equal(r0.status, 200, JSON.stringify(r0.data));
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { new_payrun_hours: 'roster' }, admin)).status, 200);
  const pre = (await call('POST', '/api/staff/payroll/roster-hours/preview', { period_start: MON, period_end: '2029-11-18' }, admin)).data;
  assert.deepEqual(pre.clocked.map(x => x.name).sort(), ['Ana', 'Ben']);   // they have timesheets that week (from the test above)
  // take Ana's clock times off, so she is filled from the roster
  for (const t of (await call('GET', `/api/staff/timesheets?user_id=${ana.id}&from=${MON}&to=2029-11-18`, null, admin)).data) await call('DELETE', `/api/staff/timesheets/${t.id}`, null, admin);
  const n = await call('POST', '/api/staff/payroll/next-run', {}, admin);   // Payroll rules: always fill from the roster
  assert.equal(n.status, 200, JSON.stringify(n.data));
  assert.deepEqual([n.data.start, n.data.mode, n.data.copied_people], [MON, 'roster', 1]);
  assert.deepEqual(n.data.clocked.map(x => x.name), ['Ben']);
  assert.match(n.data.message, /Filled 1 person's hours from the roster/);
  const ts = (await call('GET', `/api/staff/timesheets?user_id=${ana.id}&from=${MON}&to=2029-11-18`, null, admin)).data;
  assert.equal(ts.length, 5); assert.ok(ts.every(t => /^from the roster/.test(t.notes) && !t.approved_by));
  assert.ok(ts.some(t => t.notes === 'from the roster (Cafe)'));
  // Mon 10–5 and Tue–Fri 9–5 (start to finish: Payroll's own break rules apply, none here); the removed Tue 12–4 isn't filled
  const pv = (await call('POST', '/api/staff/payroll/preview', { period_start: MON, period_end: '2029-11-18' }, admin)).data;
  assert.equal(pv.lines.find(l => l.employee_name === 'Ana').hours, 7 + 8 * 4);
  const again = await call('POST', '/api/staff/payroll/next-run', {}, admin);
  assert.equal(again.data.already_started, true); assert.match(again.data.message, /filled from the roster/);
  const au = (await call('GET', '/api/staff/audit', null, admin)).data.find(e => e.action === 'Filled hours from the roster');
  assert.match(au.details, /5 shifts for 1 person/);
  // paid dates can't be filled
  assert.equal((await call('POST', '/api/staff/payroll/roster-hours/preview', { period_start: '2029-11-05', period_end: '2029-11-11' }, admin)).status, 409);
});

test('the desktop build packs roster.js (every file the back office loads)', () => {
  const root = path.join(__dirname, '..'), prep = fs.readFileSync(path.join(root, 'desktop', 'prepare.js'), 'utf8');
  const list = prep.match(/for \(const f of \[([^\]]+)\]\) fs\.copyFileSync/)[1];
  for (const f of fs.readdirSync(root).filter(x => x.endsWith('.js'))) {
    for (const [, dep] of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/require\('\.\/([\w-]+)(?:\.js)?'\)/g)) assert.ok(list.includes(`'${dep}.js'`), `${f} needs ${dep}.js in desktop/prepare.js`);
  }
  assert.match(list, /'roster\.js'/);
});
