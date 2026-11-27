// OWNER-BULKROSTER (Payroll 2.4.0): rostering many people at once. Shift templates, usual weeks and "Fill week", select
// many days and apply once, import from a CSV file (preview, problems, save), copy to the next weeks, undo the last bulk
// change, supervisors only their own team, and former staff kept off the roster (and off the Staff list by default).
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BULK = require('../rosterbulk.js');
const LV = require('../public/listview.js');

const PORT = 3993;
const B = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-bulkroster-'));
let server;
async function call(method, url, body, cookie) {
  const res = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
before(async () => {
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR, APPDATA: path.join(DATA_DIR, 'appdata'), ADMIN_PASSWORD: 'AdminPass123', RIYESER_DEMO_FILE: path.join(DATA_DIR, 'no-demo.json'), RIYESER_DEMO: '', RIYESER_DOCS: '', DESKTOP: '' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/public/info'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('Server did not start');
});
after(async () => {
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000); });
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { }
});

// weeks starting Monday 7 Jan 2030 (weekly pay, Mondays)
const W1 = '2030-01-07', W2 = '2030-01-14', W3 = '2030-01-21';
const day = (w, i) => { const d = new Date(w + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
let admin, sup, ana, ben, cal, dee, eve;
const week = (w, c = admin) => call('GET', `/api/staff/roster?week=${w}`, null, c).then(r => r.data);
const person = (w, u) => w.people.find(p => p.id === u.id);
const live = p => p.shifts.filter(s => !s.deleted);

test('setup: five staff (one in a supervisor\'s team), weekly pay', async () => {
  admin = (await call('POST', '/api/auth/login', { username: 'admin', password: 'AdminPass123' })).cookie;
  await call('PUT', '/api/staff/payroll/rules', { pay_periods_per_year: 52, pay_cycle_start: '2030-01-07' }, admin);
  const emp = async (name, o = {}) => { const r = await call('POST', '/api/staff/employees', { name, username: name.toLowerCase().replace(/\W/g, ''), password: 'staffpass1', role: 'staff', pay_type: 'hourly', pay_rate: 10, ...o }, admin); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
  ana = await emp('Ana Tuilagi', { employee_no: 'E001' }); ben = await emp('Ben Kumar', { employee_no: 'E002' }); cal = await emp('Cal Singh', { employee_no: 'E003', aliases: 'Cally' });
  // Dee is a supervisor (Add & edit on Timesheets, own team only); Eve is in Dee's team
  const presets = (await call('GET', '/api/auth/me', null, admin)).data.presets;
  dee = await emp('Dee Lomu', { employee_no: 'E004', perms: presets.supervisor.perms, preset: 'supervisor', team_only: true });
  eve = await emp('Eve Naidu', { employee_no: 'E005', supervisor_id: dee.id });
  sup = (await call('POST', '/api/auth/login', { username: 'deelomu', password: 'staffpass1' })).cookie;
});

test('shift templates: a few to start with; add, change, delete (needs Add & edit on Timesheets)', async () => {
  const r = await call('GET', '/api/staff/roster/templates', null, admin);
  assert.deepEqual(r.data.templates.map(t => [t.name, t.start, t.finish, t.break_min]), [['Open', '07:00', '15:00', 30], ['Day', '09:00', '17:00', 30], ['Close', '14:00', '22:00', 30], ['Half day', '09:00', '13:00', 0]]);
  const a = await call('POST', '/api/staff/roster/templates', { name: 'Cafe early', start: '06:00', finish: '14:00', break_min: 30, role: 'Cafe', colour: '#be185d' }, admin);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.ok(a.data.templates.some(t => t.name === 'Cafe early' && t.role === 'Cafe' && t.colour === '#be185d'));
  assert.equal((await call('POST', '/api/staff/roster/templates', { name: 'cafe EARLY', start: '06:00', finish: '14:00' }, admin)).status, 400);   // the same name
  assert.equal((await call('POST', '/api/staff/roster/templates', { name: 'Bad', start: '06:00', finish: '06:00' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/staff/roster/templates', { name: 'Bad', start: '06:00', finish: '07:00', break_min: 60 }, admin)).status, 400);
  const u = await call('PUT', `/api/staff/roster/templates/${a.data.id}`, { finish: '13:30' }, admin);
  assert.equal(u.data.templates.find(t => t.id === a.data.id).finish, '13:30');
  const tmp = await call('POST', '/api/staff/roster/templates', { name: 'Temp', start: '10:00', finish: '12:00' }, admin);
  assert.equal((await call('DELETE', `/api/staff/roster/templates/${tmp.data.id}`, null, admin)).status, 200);
  assert.ok(!(await call('GET', '/api/staff/roster/templates', null, admin)).data.templates.some(t => t.name === 'Temp'));
  // staff without Add & edit can't change them
  const anaC = (await call('POST', '/api/auth/login', { username: 'anatuilagi', password: 'staffpass1' })).cookie;
  assert.equal((await call('POST', '/api/staff/roster/templates', { name: 'Mine', start: '10:00', finish: '12:00' }, anaC)).status, 403);
  // the planner's week carries them
  assert.ok((await week(W1)).templates.some(t => t.name === 'Cafe early'));
});

let T;
test('usual weeks: set per person (template or own times), shown on the planner\'s week', async () => {
  T = Object.fromEntries((await call('GET', '/api/staff/roster/templates', null, admin)).data.templates.map(t => [t.name, t]));
  const r = await call('PUT', '/api/staff/roster/patterns', { people: [
    { user_id: ana.id, days: [1, 2, 3, 4, 5].map(d => ({ dow: d, template_id: T.Open.id })) },
    { user_id: ben.id, days: [{ dow: 1, template_id: T.Close.id }, { dow: 3, start: '12:00', finish: '18:00', break_min: 15, role: 'Till' }, { dow: 6, template_id: T.Day.id }] },
    { user_id: cal.id, days: [1, 2].map(d => ({ dow: d, template_id: T.Day.id, role: 'Office' })) },
  ] }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const w = await week(W1);
  assert.equal(person(w, ana).usual.length, 5);
  assert.deepEqual(person(w, ben).usual.find(x => x.dow === 3), { dow: 3, template_id: null, start: '12:00', finish: '18:00', break_min: 15, role: 'Till' });
  assert.equal(person(w, cal).usual[0].role, 'Office');
  assert.equal((await call('PUT', '/api/staff/roster/patterns', { people: [{ user_id: ana.id, days: [{ dow: 1, start: '09:00', finish: '09:00' }] }] }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/staff/roster/patterns', { people: [{ user_id: ana.id, days: [{ dow: 1, template_id: T.Open.id }, { dow: 1, template_id: T.Day.id }] }] }, admin)).status, 400);
  // a supervisor: only their team
  assert.equal((await call('PUT', '/api/staff/roster/patterns', { people: [{ user_id: ana.id, days: [] }] }, sup)).status, 403);
  assert.equal((await call('PUT', '/api/staff/roster/patterns', { people: [{ user_id: eve.id, days: [{ dow: 2, template_id: T['Half day'].id }] }] }, sup)).status, 200);
});

test('fill the week from usual weeks: skips leave, people who have left and days with a shift; replace; dry run; undo', async () => {
  // Ana is on leave Wednesday; Ben already has a Monday shift
  assert.equal((await call('POST', '/api/staff/leave', { user_id: ana.id, kind: 'annual', date_from: day(W1, 2), days: 1 }, admin)).status, 200);
  assert.equal((await call('POST', '/api/staff/roster/shifts', { user_id: ben.id, date: W1, start: '08:00', finish: '12:00' }, admin)).status, 200);
  const dry = await call('POST', '/api/staff/roster/fill-usual', { week: W1, dry_run: true }, admin);
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.added, 4 + 2 + 2 + 1);   // Ana 4 (not Wed), Ben Wed + Sat, Cal Mon + Tue, Eve Tue
  assert.equal(live(person(await week(W1), ana)).length, 0, 'a dry run saves nothing');
  const r = await call('POST', '/api/staff/roster/fill-usual', { week: W1 }, admin);
  assert.equal(r.data.added, 9);
  assert.deepEqual(r.data.skipped.map(s => [s.name, s.date, s.why]).sort(), [['Ana Tuilagi', day(W1, 2), 'on leave that day'], ['Ben Kumar', W1, 'already has a shift']]);
  assert.match(r.data.undo.label, /Filled Mon 7 – Sun 13 Jan 2030 from usual weeks \(9 shifts\)/);
  const w = await week(W1);
  const a = live(person(w, ana));
  assert.deepEqual(a.map(s => [s.date, s.start, s.finish, s.break_min, s.template_id]), [W1, day(W1, 1), day(W1, 3), day(W1, 4)].map(d => [d, '07:00', '15:00', 30, T.Open.id]));
  assert.deepEqual(live(person(w, cal)).map(s => s.role), ['Office', 'Office']);
  assert.equal(w.undo.label, r.data.undo.label);
  // again: nothing new (each day already has its shift)
  const again = await call('POST', '/api/staff/roster/fill-usual', { week: W1 }, admin);
  assert.equal(again.data.added, 0);
  // replace: Ben's Monday 8–12 becomes his usual Close shift; the rest stay as they are
  const rep = await call('POST', '/api/staff/roster/fill-usual', { week: W1, replace: true, user_ids: [ben.id] }, admin);
  assert.deepEqual([rep.data.added, rep.data.removed, rep.data.unchanged], [1, 1, 2]);
  assert.deepEqual(live(person(await week(W1), ben)).filter(s => s.date === W1).map(s => s.start), ['14:00']);
  // undo the replace: Ben's Monday is back as it was
  const un = await call('POST', '/api/staff/roster/undo', {}, admin);
  assert.equal(un.status, 200); assert.match(un.data.label, /from usual weeks \(1 shift\)/);
  assert.deepEqual(live(person(await week(W1), ben)).filter(s => s.date === W1).map(s => s.start), ['08:00']);
  assert.equal((await call('POST', '/api/staff/roster/undo', {}, admin)).status, 400);   // only the last bulk change
  // a supervisor fills their own team only
  const s = await call('POST', '/api/staff/roster/fill-usual', { week: W2 }, sup);
  assert.equal(s.data.added, 1);
  assert.deepEqual((await week(W2)).people.filter(p => live(p).length).map(p => p.name), ['Eve Naidu']);
  await call('POST', '/api/staff/roster/undo', {}, sup);
  assert.equal(live(person(await week(W2), eve)).length, 0);
});

test('select many days, apply once: a template, typed times, a role, clear; skips leave; warnings in the summary; undo', async () => {
  const cells = [ana, ben, cal].flatMap(p => [0, 1, 2].map(i => ({ user_id: p.id, date: day(W2, i) }))).concat([{ user_id: null, date: day(W2, 5) }]);
  assert.equal((await call('POST', '/api/staff/leave', { user_id: cal.id, kind: 'sick', date_from: day(W2, 1), days: 1 }, admin)).status, 200);
  const r = await call('POST', '/api/staff/roster/bulk', { cells, action: 'set', shift: { template_id: T.Day.id } }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added, 9);   // 3 × 3 − Cal's sick day + the open shift
  assert.deepEqual(r.data.skipped.map(s => [s.name, s.date, s.why]), [['Cal Singh', day(W2, 1), 'on leave that day']]);
  let w = await week(W2);
  assert.equal(live(person(w, ana)).length, 3); assert.equal(w.open.filter(s => !s.deleted).length, 1);
  assert.ok(live(person(w, ben)).every(s => s.template_id === T.Day.id && s.start === '09:00'));
  // set again with typed times: the same shifts are changed (not added twice)
  const t = await call('POST', '/api/staff/roster/bulk', { cells: cells.slice(0, 3), action: 'set', shift: { start: '10:00', finish: '20:00', break_min: 30 } }, admin);
  assert.deepEqual([t.data.added, t.data.changed, t.data.removed], [0, 3, 0]);
  assert.deepEqual(live(person(await week(W2), ana)).map(s => [s.start, s.template_id]), [['10:00', null], ['10:00', null], ['10:00', null]]);
  // add alongside: an overlap is a warning in the summary (saved anyway)
  const add = await call('POST', '/api/staff/roster/bulk', { cells: [{ user_id: ana.id, date: W2 }], action: 'add', shift: { start: '18:00', finish: '23:30' } }, admin);
  assert.equal(add.data.added, 1); assert.ok(add.data.warnings.some(x => x.name === 'Ana Tuilagi' && /Overlaps/.test(x.text)));
  // a role on all of them
  const role = await call('POST', '/api/staff/roster/bulk', { cells, action: 'role', role: 'Till' }, admin);
  assert.ok(role.data.changed >= 9);
  assert.ok(live(person(await week(W2), ben)).every(s => s.role === 'Till'));
  // undo the role: back to no role
  await call('POST', '/api/staff/roster/undo', {}, admin);
  assert.ok(live(person(await week(W2), ben)).every(s => s.role === ''));
  // clear
  const cl = await call('POST', '/api/staff/roster/bulk', { cells: cells.filter(c => c.user_id === ben.id), action: 'clear' }, admin);
  assert.equal(cl.data.removed, 3);
  assert.equal(live(person(await week(W2), ben)).length, 0);
  // checks: bad times, nothing selected, someone else's team
  assert.equal((await call('POST', '/api/staff/roster/bulk', { cells, action: 'set', shift: { start: '10:00', finish: '10:00' } }, admin)).status, 400);
  assert.equal((await call('POST', '/api/staff/roster/bulk', { cells: [], action: 'clear' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/staff/roster/bulk', { cells: [{ user_id: ana.id, date: W2 }], action: 'clear' }, sup)).status, 403);
  assert.equal((await call('POST', '/api/staff/roster/bulk', { cells: [{ user_id: eve.id, date: W2 }], action: 'set', shift: { template_id: T.Open.id } }, sup)).status, 200);
});

test('bulk changes are drafts until published; undo after publishing marks the shift removed (staff are told)', async () => {
  const pub = await call('POST', '/api/staff/roster/publish', { week: W2 }, admin);
  assert.equal(pub.status, 200);
  const r = await call('POST', '/api/staff/roster/bulk', { cells: [{ user_id: ben.id, date: day(W2, 3) }], action: 'set', shift: { template_id: T.Close.id } }, admin);
  assert.equal(r.data.added, 1);
  let w = await week(W2);
  assert.equal(live(person(w, ben))[0].state, 'new'); assert.equal(w.pending.new, 1);
  await call('POST', '/api/staff/roster/publish', { week: W2 }, admin);
  await call('POST', '/api/staff/roster/undo', {}, admin);
  w = await week(W2);
  assert.equal(person(w, ben).shifts[0].state, 'removed'); assert.equal(w.pending.removed, 1);
});

test('copy this week to the next N weeks (skipping leave and duplicates); replace; undo all of it', async () => {
  // W1 has Ana ×4, Ben ×3, Cal ×2 (from the usual weeks)
  const src = (await week(W1)).people.reduce((t, p) => t + live(p).length, 0) + (await week(W1)).open.length;
  assert.equal((await call('POST', '/api/staff/leave', { user_id: ana.id, kind: 'annual', date_from: day(W3, 0), days: 1 }, admin)).status, 200);
  const r = await call('POST', '/api/staff/roster/copy-weeks', { week: W1, weeks: 3 }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.weeks.map(x => x.week_start), [W2, W3, '2030-01-28']);
  assert.equal(r.data.added + r.data.skipped.length, src * 3);
  assert.ok(r.data.skipped.some(s => s.name === 'Ana Tuilagi' && s.date === day(W3, 0) && s.why === 'on leave that day'));
  assert.equal(live(person(await week('2030-01-28'), ana)).length, 4);
  assert.match(r.data.undo.label, /to the next 3 weeks/);
  const un = await call('POST', '/api/staff/roster/undo', {}, admin);
  assert.equal(un.status, 200);
  assert.equal(live(person(await week('2030-01-28'), ana)).length, 0);
  assert.equal((await call('POST', '/api/staff/roster/copy-weeks', { week: W1, weeks: 13 }, admin)).status, 400);
  // replace: the target week's shifts come off first
  const rep = await call('POST', '/api/staff/roster/copy-weeks', { week: W1, weeks: 1, replace: true }, admin);
  assert.ok(rep.data.removed > 0);
  assert.deepEqual(live(person(await week(W2), ana)).map(s => s.start), ['07:00', '07:00', '07:00', '07:00']);
});

test('CSV import: reading dates, times and breaks the way Excel writes them', () => {
  assert.deepEqual(BULK.parseCSV('\ufeffName;Date\r\n"Tuilagi, Ana";30/11/2026\n"say ""hi""";x\n'), [['Name', 'Date'], ['Tuilagi, Ana', '30/11/2026'], ['say "hi"', 'x']]);
  assert.deepEqual(BULK.parseCSV('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  for (const [v, d] of [['2026-11-30', '2026-11-30'], ['30/11/2026', '2026-11-30'], ['30/11/26', '2026-11-30'], ['3.1.2027', '2027-01-03'], ['Mon 30 Nov 2026', '2026-11-30'], ['30-Nov-26', '2026-11-30'], ['46356', '2026-11-30'], ['31/11/2026', null], ['soon', null]]) assert.equal(BULK.parseDate(v, '2026-11-27'), d, v);
  assert.equal(BULK.parseDate('2 Dec', '2026-11-27'), '2026-12-02');
  for (const [v, t] of [['7', '07:00'], ['7am', '07:00'], ['7:30 PM', '19:30'], ['12am', '00:00'], ['12pm', '12:00'], ['19:30', '19:30'], ['0730', '07:30'], ['07:30:00', '07:30'], ['7.30pm', '19:30'], ['0.3125', '07:30'], ['25:00', null], ['13pm', null], ['', null]]) assert.equal(BULK.parseTime(v), t, v);
  for (const [v, m] of [['30', 30], ['30 min', 30], ['0:30', 30], ['1h', 60], ['0.5 hours', 30], ['', 0], ['lots', undefined]]) assert.equal(BULK.parseBreak(v), m, v);
});

test('CSV import: preview shows matches and problems; save keeps only the good lines; template file; undo', async () => {
  // Eve has left (no longer active)
  assert.equal((await call('PUT', `/api/staff/employees/${eve.id}`, { active: false }, admin)).status, 200);
  const W4 = '2030-02-04';
  const csv = ['Name,Employee no.,Date,Start,Finish,Break (min),Role,Note',
    'Ana Tuilagi,,04/02/2030,7am,3pm,30,Cafe,Open up',        // 2 warn: overlaps line 12
    ',E002,2030-02-04,14:00,22:00,30,Till,',                     // 3 ok, by employee no.
    'Cally,,5/2/2030,9:00,17:00,,,',                             // 4 ok, by other name (alias)
    'Ben,,6/2/2030,9:00,17:00,30,,',                             // 5 warn: first name only
    'Eve Naidu,,04/02/2030,9:00,17:00,0,,',                      // 6 error: has left
    'Zed Nobody,,04/02/2030,9:00,17:00,0,,',                     // 7 error: no such person
    'Ana Tuilagi,,31/02/2030,9:00,17:00,0,,',                    // 8 error: not a date
    'Ana Tuilagi,,07/02/2030,9:00,9:00,0,,',                     // 9 error: same start and finish
    'Ana Tuilagi,,04/02/2030,7am,3pm,30,Cafe,again',            // 10 skip: twice in the file
    'Open,,08/02/2030,08:00,12:00,0,Cafe,Market day',            // 11 ok: open shift
    'Ana Tuilagi,,04/02/2030,14:00,18:00,0,,'].join('\r\n');     // 12 warn: overlaps line 2
  const p = await call('POST', '/api/staff/roster/import/preview', { csv }, admin);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const st = Object.fromEntries(p.data.lines.map(l => [l.line, l.status]));
  assert.deepEqual(st, { 2: 'warn', 3: 'ok', 4: 'ok', 5: 'warn', 6: 'error', 7: 'error', 8: 'error', 9: 'error', 10: 'skip', 11: 'ok', 12: 'warn' });
  const L = n => p.data.lines.find(l => l.line === n);
  assert.deepEqual([L(2).name, L(2).date, L(2).start, L(2).finish, L(2).break_min, L(2).role], ['Ana Tuilagi', '2030-02-04', '07:00', '15:00', 30, 'Cafe']);
  assert.equal(L(3).name, 'Ben Kumar'); assert.equal(L(4).name, 'Cal Singh'); assert.match(L(5).warnings.join(), /matched to Ben Kumar/);
  assert.match(L(6).errors.join(), /has left/); assert.match(L(7).errors.join(), /No staff member called Zed Nobody/);
  assert.match(L(8).errors.join(), /isn't a date/); assert.match(L(12).warnings.join(), /Overlaps/);
  assert.equal(L(11).name, 'Open shift');
  assert.deepEqual(p.data.counts, { lines: 11, ok: 3, warn: 3, skip: 1, error: 4 });
  assert.equal(live(person(await week(W4), ana)).length, 0, 'the preview saves nothing');
  // save
  const s = await call('POST', '/api/staff/roster/import', { csv }, admin);
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.added, 6); assert.equal(s.data.skipped.length, 5);
  const w = await week(W4);
  assert.deepEqual(live(person(w, ana)).map(x => [x.start, x.role, x.note]), [['07:00', 'Cafe', 'Open up'], ['14:00', '', '']]);
  assert.equal(w.open.length, 1); assert.equal(w.pending.new, 0); assert.equal(w.published, null);   // drafts, not published
  // importing the same file again: everything already there is skipped
  const again = await call('POST', '/api/staff/roster/import/preview', { csv }, admin);
  assert.equal(again.data.counts.ok + again.data.counts.warn, 0);
  // undo the import
  await call('POST', '/api/staff/roster/undo', {}, admin);
  assert.equal(live(person(await week(W4), ana)).length, 0);
  // checks: no headings, empty
  assert.equal((await call('POST', '/api/staff/roster/import/preview', { csv: 'a,b,c\n1,2,3' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/staff/roster/import/preview', { csv: '' }, admin)).status, 400);
  // the supervisor: other teams' people are a problem line
  const sp = await call('POST', '/api/staff/roster/import/preview', { csv: 'Name,Date,Start,Finish\nAna Tuilagi,2030-02-04,9,17' }, sup);
  assert.match(sp.data.lines[0].errors.join(), /isn't in your team/);
  // the template file: the columns, ready for Excel
  const t = await fetch(`${B}/api/staff/roster/import-template.csv`, { headers: { Cookie: admin } });
  assert.equal(t.status, 200); assert.match(t.headers.get('content-disposition'), /roster-import-template\.csv/);
  const buf = Buffer.from(await t.arrayBuffer()), body = buf.toString('utf8');
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);   // a BOM first, so Excel reads it as UTF-8
  assert.match(body, /^\uFEFFName,Employee no\.,Date,Start,Finish,Break \(min\),Role,Note\r\n/);
  const back = await call('POST', '/api/staff/roster/import/preview', { csv: body }, admin);
  assert.equal(back.status, 200); assert.ok(back.data.lines.every(l => l.status !== 'error'), JSON.stringify(back.data.lines));
});

test('former staff: not on the roster after their last day (still in past weeks with shifts); planning them is refused', async () => {
  // Eve left (inactive) and has no shifts after W2: not on later weeks; she is on W2 (her shift there), marked former
  assert.ok(!(await week(W3)).people.some(p => p.id === eve.id));
  const w2 = await week(W2);
  assert.ok(person(w2, eve) && person(w2, eve).former);
  assert.equal((await call('POST', '/api/staff/roster/shifts', { user_id: eve.id, date: W3, start: '09:00', finish: '17:00' }, admin)).status, 400);
  const f = await call('POST', '/api/staff/roster/bulk', { cells: [{ user_id: ana.id, date: W3 }], action: 'set', shift: { template_id: T.Day.id } }, admin);
  assert.equal(f.status, 200);
  // the people pickers (directory) list current staff; Staff lists everyone (the screen hides former staff by default)
  const dir = (await call('GET', '/api/staff/directory', null, admin)).data;
  assert.ok(!dir.some(p => p.id === eve.id));
  const all = (await call('GET', '/api/staff/directory?former=1', null, admin)).data;
  assert.ok(all.some(p => p.id === eve.id && p.former));
});

test('make this week their usual week', async () => {
  const r = await call('POST', '/api/staff/roster/patterns/from-week', { week: W1, user_ids: [cal.id] }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const w = await week(W1);
  assert.deepEqual(person(w, cal).usual.map(x => [x.dow, x.template_id, x.role]), [[1, T.Day.id, 'Office'], [2, T.Day.id, 'Office']]);
});

test('Staff list: former staff hidden by default ("Current staff"), a remembered "All" from before 2.4.0 moves to the new default once', () => {
  const mem = new Map(), store = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const spec = { fields: { name: { label: 'Name', type: 'text' } }, selects: [{ key: 'status', label: 'Status', options: [['current', 'Current staff'], ['former', 'Former staff']], test: (e, v) => (v === 'current' ? !e.former : e.former) }] };
  const defaults = { sort: 'name', sel: { status: 'current' }, v: 2 };
  const mk = () => LV.list({ id: 'employees', uid: 1, spec, defaults, migrate: s => ({ ...s, sel: { ...s.sel, status: ({ active: 'current', left: 'former' })[s.sel.status] || 'current' } }), storage: store });
  const rows = [{ name: 'Ana' }, { name: 'Eve', former: true }];
  // nothing remembered: current staff
  assert.deepEqual(mk().apply(rows).map(r => r.name), ['Ana']);
  // remembered "All" (2.3.x): the new default, once
  mem.set(LV.storeKey('employees', 1), JSON.stringify({ sort: 'name', dir: 'asc', sel: { status: '' } }));
  let c = mk(); assert.equal(c.state.sel.status, 'current');
  // they choose "All" again: kept from now on
  c.set({ sel: { status: '' } });
  c = mk(); assert.equal(c.state.sel.status, ''); assert.deepEqual(c.apply(rows).map(r => r.name), ['Ana', 'Eve']);
  // remembered "Left / inactive" (2.3.x) becomes "Former staff"
  mem.set(LV.storeKey('employees', 1), JSON.stringify({ sel: { status: 'left' } }));
  assert.equal(mk().state.sel.status, 'former');
  // the default isn't "filtered" (Clear filters stays off); "All" is
  c = mk(); c.set({ sel: { status: 'current' } }); assert.equal(LV.isFiltered(c.state, c.spec, c.defaults), false);
  c.set({ sel: { status: '' } }); assert.equal(LV.isFiltered(c.state, c.spec, c.defaults), true);
});

test('the desktop build packs rosterbulk.js and the page loads rosterbulk.js', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'prepare.js'), 'utf8'), /'rosterbulk\.js'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.html'), 'utf8'), /<script src="\/rosterbulk\.js"><\/script>/);
  assert.equal(require('../package.json').version, '2.4.0');
});
