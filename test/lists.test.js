// OWNER-LISTS (Payroll 2.3.2): sorting and filtering on every list. The pure helpers (public/listview.js: comparing,
// sorting, searching, date ranges, remembering; lists.js: financial / calendar years, quick periods, sort fields by
// access), then the server: the Year / Period filters on the API, voided pay runs, and pay-rate sorting only for those
// who can see pay rates (a supervisor's list is their team, sorted by name). Fixed dates in 2031. Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LV = require('../public/listview.js');
const LISTS = require('../lists.js');

// ------------------------------------------------------------------ pure: listview.js
test('compare: numbers as numbers, dates in order, text A–Z with E2 before E10, empty values last', () => {
  assert.ok(LV.compare('9', '10', 'num') < 0);            // not "10" < "9"
  assert.ok(LV.compare(12.5, '12.50', 'num') === 0);
  assert.ok(LV.compare('2031-03-09', '2031-10-01', 'date') < 0);
  assert.ok(LV.compare('E2', 'E10') < 0);
  assert.ok(LV.compare('ana', 'Ben') < 0);                  // not case-sensitive
  assert.ok(LV.compare('', 'Ana') > 0); assert.ok(LV.compare(null, 3, 'num') > 0); assert.equal(LV.compare('', null), 0);
});

test('nameKey: by first name as written, by last name "Last First"', () => {
  assert.equal(LV.nameKey('Mere  Tuilagi'), 'Mere Tuilagi');
  assert.equal(LV.nameKey('Mere Tuilagi', 'last'), 'Tuilagi Mere');
  assert.equal(LV.nameKey('Ana Lisi Vosa', 'last'), 'Vosa Ana Lisi');
  assert.equal(LV.nameKey('Sitiveni', 'last'), 'Sitiveni');
});

const PEOPLE = [
  { id: 1, name: 'Ana Vosa', employee_no: 'E10', start_date: '2024-03-01', pay_rate: 12.5, active: 1 },
  { id: 2, name: 'Ben Ali', employee_no: 'E2', start_date: '', pay_rate: 9, active: 0 },
  { id: 3, name: 'Cara Bula', employee_no: 'E3', start_date: '2025-08-01', pay_rate: 40000, active: 1 },
  { id: 4, name: 'ana Moce', employee_no: '', start_date: '2023-01-15', pay_rate: null, active: 1 },
];
const FIELDS = {
  name: { type: 'text', get: r => r.name, then: 'last_name' }, last_name: { type: 'text', get: r => LV.nameKey(r.name, 'last') },
  employee_no: { type: 'text' }, start_date: { type: 'date' }, pay_rate: { type: 'num', guard: 1 }, status: { type: 'num', get: r => (r.active ? 0 : 1), then: 'name' },
};
const ids = rows => rows.map(r => r.id);

test('sortRows: first name, last name, employee no., start date, pay rate, status; empties last both ways; stable', () => {
  assert.deepEqual(ids(LV.sortRows(PEOPLE, FIELDS, 'name')), [4, 1, 2, 3]);              // ana Moce, Ana Vosa (tie broken by last name), Ben, Cara
  assert.deepEqual(ids(LV.sortRows(PEOPLE, FIELDS, 'last_name')), [2, 3, 4, 1]);         // Ali, Bula, Moce, Vosa
  assert.deepEqual(ids(LV.sortRows(PEOPLE, FIELDS, 'employee_no')), [2, 3, 1, 4]);       // E2, E3, E10, (none)
  assert.deepEqual(ids(LV.sortRows(PEOPLE, FIELDS, 'employee_no', 'desc')), [1, 3, 2, 4]); // the blank one still last
  assert.deepEqual(ids(LV.sortRows(PEOPLE, FIELDS, 'start_date', 'desc')), [3, 1, 4, 2]);
  assert.deepEqual(ids(LV.sortRows(PEOPLE, FIELDS, 'pay_rate', 'desc')), [3, 1, 2, 4]);
  assert.deepEqual(ids(LV.sortRows(PEOPLE, FIELDS, 'status')), [4, 1, 3, 2]);            // active first, by name
  assert.deepEqual(ids(LV.sortRows(PEOPLE, FIELDS, 'nope')), [1, 2, 3, 4]);              // unknown field: as it was
  assert.deepEqual(ids(PEOPLE), [1, 2, 3, 4]);                                            // the list itself isn't changed
});

test('matches: every word somewhere, any case, accents ignored', () => {
  assert.ok(LV.matches(['Ana Vosa', 'E10', 'Driver'], 'vosa e1'));
  assert.ok(LV.matches('Mélia Ratu', 'melia'));
  assert.ok(!LV.matches(['Ana Vosa'], 'ana ben'));
  assert.ok(LV.matches(['anything'], '  '));
});

const META = {
  years: [LISTS.financialYear(2030, '08-01'), LISTS.calendarYear(2031)],
  periods: { this_pay: { from: '2031-03-06', to: '2031-03-12' }, last_fy: { from: '2029-08-01', to: '2030-07-31' } },
  sorts: { employees: ['name', 'last_name', 'employee_no', 'start_date', 'status'] },   // no pay_rate (no pay-rate access)
};
test('rangeOf / pickFor: a year, a quick period, custom dates; and which pick a pair of dates is', () => {
  assert.deepEqual(LV.rangeOf({ year: 'fy:2030' }, META), { from: '2030-08-01', to: '2031-07-31' });
  assert.deepEqual(LV.rangeOf({ year: 'cy:2031' }, META), { from: '2031-01-01', to: '2031-12-31' });
  assert.deepEqual(LV.rangeOf({ period: 'this_pay' }, META), { from: '2031-03-06', to: '2031-03-12' });
  assert.deepEqual(LV.rangeOf({ period: 'custom', from: '2031-02-01', to: '2031-02-10' }, META), { from: '2031-02-01', to: '2031-02-10' });
  assert.equal(LV.rangeOf({ period: 'custom', from: '2031-02-10', to: '2031-02-01' }, META), null);   // backwards: no filter
  assert.equal(LV.rangeOf({ year: 'fy:1999' }, META), null);
  assert.deepEqual(LV.pickFor('2030-08-01', '2031-07-31', META), { year: 'fy:2030', period: '' });
  assert.deepEqual(LV.pickFor('2031-03-06', '2031-03-12', META), { year: '', period: 'this_pay' });
  assert.deepEqual(LV.pickFor('2031-03-01', '2031-03-12', META), { year: '', period: 'custom' });
});

test('apply: search, status, year by start date and sort together; inRange is inclusive', () => {
  const spec = { fields: FIELDS, search: r => [r.name, r.employee_no], date: r => r.start_date,
    selects: [{ key: 'status', test: (r, v) => (v === 'active' ? !!r.active : !r.active) }] };
  assert.deepEqual(ids(LV.apply(PEOPLE, spec, { q: 'ana', sel: {}, sort: 'last_name' }, META)), [4, 1]);
  assert.deepEqual(ids(LV.apply(PEOPLE, spec, { q: '', sel: { status: 'left' } }, META)), [2]);
  // 1 Aug 2025 is the first day of FY 2025–26 (from 1 August)
  const meta = { years: [LISTS.financialYear(2025, '08-01'), LISTS.financialYear(2024, '08-01')] };
  assert.deepEqual(ids(LV.apply(PEOPLE, spec, { year: 'fy:2025', sel: {} }, meta)), [3]);
  assert.deepEqual(ids(LV.apply(PEOPLE, spec, { year: 'fy:2024', sel: {} }, meta)), []);
  assert.ok(LV.inRange('2031-03-12T23:59', { from: '2031-03-06', to: '2031-03-12' }));
  assert.ok(!LV.inRange('2031-03-13T00:00', { from: '2031-03-06', to: '2031-03-12' }));
  // serverDates (Timesheets, Audit trail): the server already picked the dates, so no date filter here
  assert.equal(LV.apply(PEOPLE, { ...spec, serverDates: true }, { year: 'fy:2024', sel: {} }, meta).length, 4);
});

test('remembered per list and per person; bad saved data is ignored; pay rate only offered when the server allows it', () => {
  const box = new Map(), storage = { getItem: k => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) };
  LV.save('employees', 7, { sort: 'last_name', dir: 'desc', q: 'ana', sel: { status: 'active' } }, storage);
  assert.equal(LV.load('employees', 7, {}, storage).sort, 'last_name');
  assert.equal(LV.load('employees', 7, {}, storage).sel.status, 'active');
  assert.equal(LV.load('employees', 8, { sort: 'name' }, storage).sort, 'name');      // someone else signed in: their own
  assert.equal(LV.load('payruns', 7, { sort: 'pay_date' }, storage).sort, 'pay_date');  // another list: its own
  box.set(LV.storeKey('audit', 7), '{not json'); assert.equal(LV.load('audit', 7, { sort: 'at' }, storage).sort, 'at');
  const thrower = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(LV.load('employees', 7, { sort: 'name' }, thrower).sort, 'name'); LV.save('employees', 7, {}, thrower);   // no error
  assert.ok(!('pay_rate' in LV.allowedFields(FIELDS, 'employees', META)));
  assert.ok('pay_rate' in LV.allowedFields(FIELDS, 'employees', { sorts: { employees: ['name', 'pay_rate'] } }));
  assert.ok(!('pay_rate' in LV.allowedFields({ ...FIELDS, pay_rate: { ...FIELDS.pay_rate, hidden: true } }, 'employees', null)));
});

// ------------------------------------------------------------------ pure: lists.js (years and periods)
test('financial year: 1 August start (FY 2025–26), 1 January start (= calendar year), and the boundary days', () => {
  assert.deepEqual([LISTS.financialYearOf('2026-07-31', '08-01').label, LISTS.financialYearOf('2026-08-01', '08-01').label], ['FY 2025–26', 'FY 2026–27']);
  const fy = LISTS.financialYear(2025, '08-01'); assert.deepEqual([fy.from, fy.to], ['2025-08-01', '2026-07-31']);
  const jul = LISTS.financialYear(2023, '07-01'); assert.deepEqual([jul.from, jul.to], ['2023-07-01', '2024-06-30']);
  const mar = LISTS.financialYear(2023, '03-01'); assert.equal(mar.to, '2024-02-29');      // ends on a leap day
  const cal = LISTS.financialYearOf('2031-12-31', '01-01'); assert.deepEqual([cal.label, cal.from, cal.to], ['FY 2031', '2031-01-01', '2031-12-31']);
  assert.equal(LISTS.financialYearOf('2031-01-01', '01-01').year, 2031);
  assert.deepEqual([LISTS.yearRange('cy:2030').from, LISTS.yearRange('cy:2030').to], ['2030-01-01', '2030-12-31']);
  assert.equal(LISTS.yearRange('fy:2030', '08-01').to, '2031-07-31');
  assert.equal(LISTS.yearRange('2030'), null);
  // a start that isn't a day every year has (29 Feb, 31 Apr) or isn't a date at all: 1 January
  for (const bad of ['02-29', '04-31', '13-01', '00-10', '8-1', '', null]) { assert.equal(LISTS.validFyStart(bad), false, String(bad)); assert.equal(LISTS.fyStart(bad), '01-01'); }
  assert.equal(LISTS.fyStartLabel('08-01'), '1 Aug');
});

test('year choices: financial and calendar years from the earliest record to now, newest first', () => {
  const ys = LISTS.yearOptions('2031-03-10', '08-01', '2029-09-15');
  assert.deepEqual(ys.filter(y => y.kind === 'fy').map(y => y.label), ['FY 2030–31', 'FY 2029–30']);
  assert.deepEqual(ys.filter(y => y.kind === 'cy').map(y => y.label), ['2031', '2030', '2029']);
  assert.deepEqual(LISTS.yearOptions('2031-03-10', '01-01').map(y => y.key), ['fy:2031', 'cy:2031']);   // nothing older: this year only
  assert.equal(LISTS.yearOptions('2031-03-10', '01-01', '1990-01-01', 15).filter(y => y.kind === 'cy').length, 15);   // at most 15 years back
});

test('quick periods: this / last pay period (the company\'s pay periods), weeks, months (Feb in a leap year, across January), financial years', () => {
  const weeklyThu = d => { const n = Math.floor((Date.parse(d) - Date.parse('2031-01-02')) / 864e5 / 7), s = new Date(Date.parse('2031-01-02') + n * 7 * 864e5).toISOString().slice(0, 10); return [s, new Date(Date.parse(s) + 6 * 864e5).toISOString().slice(0, 10)]; };
  const p = LISTS.quickPeriods('2031-03-10', '08-01', weeklyThu);
  assert.deepEqual([p.this_pay.from, p.this_pay.to, p.last_pay.from, p.last_pay.to], ['2031-03-06', '2031-03-12', '2031-02-27', '2031-03-05']);
  assert.deepEqual([p.this_week.from, p.this_week.to, p.last_week.from], ['2031-03-10', '2031-03-16', '2031-03-03']);   // Mon–Sun
  assert.deepEqual([p.this_month.from, p.this_month.to, p.last_month.from, p.last_month.to], ['2031-03-01', '2031-03-31', '2031-02-01', '2031-02-28']);
  assert.deepEqual([p.this_fy.from, p.this_fy.to, p.last_fy.from, p.last_fy.to], ['2030-08-01', '2031-07-31', '2029-08-01', '2030-07-31']);
  assert.equal(LISTS.quickPeriods('2032-03-01', '01-01').last_month.to, '2032-02-29');
  const jan = LISTS.quickPeriods('2031-01-05', '01-01'); assert.deepEqual([jan.last_month.from, jan.last_month.to, jan.last_fy.label], ['2030-12-01', '2030-12-31', 'FY 2030']);
  assert.equal(p.this_pay && LISTS.quickPeriods('2031-03-10').this_pay, undefined);   // no pay periods given: no pay-period picks
  assert.deepEqual(LISTS.rangeFromQuery({ period: 'last_fy' }, '2031-03-10', '08-01'), { from: '2029-08-01', to: '2030-07-31' });
  assert.deepEqual(LISTS.rangeFromQuery({ year: 'cy:2030', period: 'last_fy' }, '2031-03-10', '08-01'), { from: '2030-01-01', to: '2030-12-31' });   // year wins
  assert.equal(LISTS.rangeFromQuery({ from: '2031-02-02', to: '2031-02-01' }, '2031-03-10'), null);
});

test('sort fields by access: pay rate only with pay-rate access; the server sorts by name instead', () => {
  const none = () => 0, all = () => 3;
  assert.ok(!LISTS.allowedSorts(none).employees.includes('pay_rate'));
  assert.ok(!LISTS.allowedSorts(none).runslips.includes('pay_rate'));
  assert.ok(LISTS.allowedSorts(all).employees.includes('pay_rate'));
  assert.ok(LISTS.allowedSorts(none).employees.includes('start_date'));
  assert.deepEqual(ids(LISTS.sortFor('employees', PEOPLE, 'pay_rate', 'desc', all)), [3, 1, 2, 4]);
  assert.deepEqual(ids(LISTS.sortFor('employees', PEOPLE, 'pay_rate', 'desc', none)), [3, 2, 1, 4]);   // by name (desc), not by pay
  assert.deepEqual(ids(LISTS.sortFor('employees', PEOPLE, 'drop table', 'asc', all)), [4, 1, 2, 3]);
});

// ------------------------------------------------------------------ the server
const PORT = 3989, B = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-lists-'));
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

let admin, sup, people = {};
test('server setup: weekly Thursday pay periods, 1 August financial year, staff with a supervisor and a team', async () => {
  admin = (await call('POST', '/api/auth/login', { username: 'admin', password: 'AdminPass123' })).cookie;
  assert.equal((await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 52, pay_cycle_start: '2031-01-02' }, admin)).status, 200);
  const bad = await call('PUT', '/api/staff/settings', { financial_year_start: '02-29' }, admin);
  assert.equal(bad.status, 400); assert.match(bad.data.error, /financial year/);
  assert.equal((await call('PUT', '/api/staff/settings', { financial_year_start: '08-01' }, admin)).data.financial_year_start, '08-01');
  const presets = (await call('GET', '/api/auth/me', null, admin)).data.presets;
  const add = async (name, o = {}) => (people[name] = (await call('POST', '/api/staff/employees', { name, username: name.split(' ')[0].toLowerCase(), password: 'staffpass1', role: 'staff', pay_type: 'hourly', ...o }, admin)).data);
  await add('Vika Supervisor', { pay_rate: 15, perms: presets.supervisor.perms, preset: 'supervisor', team_only: true });
  await add('Zed Adams', { pay_rate: 30, employee_no: 'E10', start_date: '2030-08-01', supervisor_id: people['Vika Supervisor'].id });
  await add('Ana Young', { pay_rate: 8, employee_no: 'E2', start_date: '2030-07-31', supervisor_id: people['Vika Supervisor'].id });
  await add('Bob Outside', { pay_rate: 50, employee_no: 'E3' });
  sup = (await call('POST', '/api/auth/login', { username: 'vika', password: 'staffpass1' })).cookie;
});

test('lists meta: financial years from 1 August and calendar years, quick periods, sort fields by access', async () => {
  const m = (await call('GET', '/api/staff/lists/meta', null, admin)).data;
  assert.equal(m.fy_start, '08-01'); assert.equal(m.fy_start_label, '1 Aug');
  const fy = m.years.filter(y => y.kind === 'fy'), cy = m.years.filter(y => y.kind === 'cy');
  assert.ok(fy.length >= 1 && cy.length >= 1);
  for (const y of fy) { assert.equal(y.from.slice(5), '08-01'); assert.equal(y.to.slice(5), '07-31'); }
  assert.ok(fy.some(y => y.key === 'fy:2030') && fy.some(y => y.key === 'fy:2029'));   // the start dates (31 Jul / 1 Aug 2030) count as records
  assert.ok(cy.some(y => y.key === 'cy:2030'));
  assert.ok(m.years.some(y => y.key === m.current_fy.key));
  for (const k of ['this_pay', 'last_pay', 'this_month', 'last_month', 'this_fy', 'last_fy']) assert.ok(m.periods[k] && m.periods[k].from <= m.periods[k].to, k);
  assert.ok(m.sorts.employees.includes('pay_rate'));
  const ms = (await call('GET', '/api/staff/lists/meta', null, sup)).data;
  assert.ok(!ms.sorts.employees.includes('pay_rate')); assert.ok(ms.sorts.employees.includes('last_name'));
  assert.equal((await call('GET', '/api/staff/lists/meta')).status, 401);
});

test('staff list: sorted on the server; pay rate only for those who see it; a supervisor sees only their team', async () => {
  const names = r => r.data.map(e => e.name);
  assert.deepEqual(names(await call('GET', '/api/staff/employees?sort=pay_rate&dir=desc', null, admin)).slice(0, 3), ['Bob Outside', 'Zed Adams', 'Vika Supervisor']);
  const byLast = names(await call('GET', '/api/staff/employees?sort=last_name', null, admin));
  assert.deepEqual(byLast, byLast.slice().sort((a, b) => LV.compare(LV.nameKey(a, 'last'), LV.nameKey(b, 'last'))));
  assert.ok(byLast.indexOf('Zed Adams') < byLast.indexOf('Bob Outside') && byLast.indexOf('Vika Supervisor') < byLast.indexOf('Ana Young'));
  assert.deepEqual(names(await call('GET', '/api/staff/employees?sort=employee_no', null, admin)).slice(0, 3), ['Ana Young', 'Bob Outside', 'Zed Adams']);   // E2, E3, E10
  assert.deepEqual(names(await call('GET', '/api/staff/employees?sort=start_date&dir=desc', null, admin)).slice(0, 2), ['Zed Adams', 'Ana Young']);
  // the supervisor: their team (and themselves), no pay rates, and ?sort=pay_rate is by name instead (it would show who earns more)
  const s = await call('GET', '/api/staff/employees?sort=pay_rate&dir=asc', null, sup);
  assert.equal(s.status, 200);
  assert.deepEqual(names(s), ['Ana Young', 'Vika Supervisor', 'Zed Adams']);
  assert.ok(s.data.every(e => !('pay_rate' in e)));
});

let runA, runB, runC;
test('pay runs: ?year= financial or calendar year by pay date (boundary days), ?period=; voided runs kept for the Status filter', async () => {
  const z = people['Zed Adams'].id;
  const shifts = [['2031-07-24', '2031-07-30'], ['2031-07-31', '2031-08-06'], ['2031-08-07', '2031-08-13']];
  for (const [a] of shifts) assert.equal((await call('POST', '/api/staff/timesheets', { user_id: z, clock_in: `${a}T09:00`, clock_out: `${a}T17:00` }, admin)).status, 200);
  const run = async (a, b, pay) => { const r = await call('POST', '/api/staff/payroll/runs', { period_start: a, period_end: b, pay_date: pay }, admin); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.id; };
  runA = await run(...shifts[0], '2031-07-31');   // last day of FY 2030–31
  runB = await run(...shifts[1], '2031-08-01');   // first day of FY 2031–32
  runC = await run(...shifts[2], '2031-08-14');
  const pays = async q => (await call('GET', `/api/staff/payroll/runs${q}`, null, admin)).data.map(r => r.pay_date);
  assert.deepEqual(await pays('?year=fy:2030'), ['2031-07-31']);
  assert.deepEqual(await pays('?year=fy:2031'), ['2031-08-14', '2031-08-01']);
  assert.deepEqual(await pays('?year=cy:2031'), ['2031-08-14', '2031-08-01', '2031-07-31']);
  assert.deepEqual(await pays('?from=2031-08-01&to=2031-08-01'), ['2031-08-01']);
  assert.deepEqual(await pays('?year=junk'), ['2031-08-14', '2031-08-01', '2031-07-31']);   // not a year: everything
  // void one: it's gone from the runs (its dates can be paid again) but listed as voided, with who and when
  assert.equal((await call('DELETE', `/api/staff/payroll/runs/${runC}`, null, admin)).status, 200);
  assert.deepEqual(await pays(''), ['2031-08-01', '2031-07-31']);
  const v = (await call('GET', '/api/staff/payroll/runs/voided', null, admin)).data;
  assert.equal(v.length, 1);
  const adminName = (await call('GET', '/api/auth/me', null, admin)).data.user.name;
  assert.deepEqual([v[0].run_id, v[0].pay_date, v[0].status, v[0].voided_by_name], [runC, '2031-08-14', 'voided', adminName]);
  assert.ok(v[0].employees >= 1);
  assert.ok(v[0].total_net > 0);
  assert.equal((await call('GET', '/api/staff/payroll/runs/voided?year=fy:2030', null, admin)).data.length, 0);
  assert.equal((await call('GET', '/api/staff/payroll/runs/voided', null, sup)).status, 403);   // no pay-run access
  // my payslips: the same Year filter
  const zc = (await call('POST', '/api/auth/login', { username: 'zed', password: 'staffpass1' })).cookie;
  assert.deepEqual((await call('GET', '/api/staff/payslips/mine?year=fy:2031', null, zc)).data.map(p => p.pay_date), ['2031-08-01']);
  assert.equal((await call('GET', '/api/staff/payslips/mine', null, zc)).data.length, 2);
});

test('timesheets ?year= / ?period=, and the audit trail ?from=&to=', async () => {
  const days = async q => (await call('GET', `/api/staff/timesheets?${q}`, null, admin)).data.map(t => t.clock_in.slice(0, 10)).sort();
  assert.deepEqual(await days('year=fy:2031'), ['2031-08-07']);                 // FY 2031–32 starts 1 Aug 2031
  assert.deepEqual(await days('year=fy:2030'), ['2031-07-24', '2031-07-31']);   // 31 Jul is the last day of FY 2030–31
  assert.deepEqual(await days('period=this_fy&from=junk'), await days(`from=${(await call('GET', '/api/staff/lists/meta', null, admin)).data.periods.this_fy.from}&to=${(await call('GET', '/api/staff/lists/meta', null, admin)).data.periods.this_fy.to}`));
  assert.deepEqual(await days('year=fy:2031&from=2031-07-31&to=2031-07-31'), ['2031-07-31']);   // dates given: they win
  // the supervisor: their team's shifts only, whatever the year
  const st = (await call('GET', '/api/staff/timesheets?year=cy:2031', null, sup)).data;
  assert.ok(st.length === 3 && st.every(t => t.name === 'Zed Adams'));
  const today = (await call('GET', '/api/staff/lists/meta', null, admin)).data.today;
  const au = (await call('GET', `/api/staff/audit?from=${today}&to=${today}`, null, admin)).data;
  assert.ok(au.some(a => a.action === 'Deleted a pay run'));
  assert.deepEqual((await call('GET', '/api/staff/audit?from=2001-01-01&to=2001-12-31', null, admin)).data, []);
  assert.equal((await call('GET', '/api/staff/audit?year=cy:2031', null, sup)).status, 403);
});
