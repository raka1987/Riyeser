// OWNER-ROSTER (Payroll 2.3.0): staff rostering.
//
// The roster is a week of planned shifts: a person (or nobody yet: an open shift), a day, start and finish, an unpaid
// break, a role or area, and a note. Planning it needs Add & edit access to Timesheets (a supervisor: their own team);
// View access sees it. Warnings are shown, not enforced: two shifts for one person at the same time, a shift on a day
// they have leave booked, a shift over 12 hours, a week over the normal working week, a shift after their last day.
//
// Publishing: "Publish roster" copies each shift of the week into its published columns (pub_*), and that published copy
// is what staff see: on the time clock (after tapping their name), on the roster page, printed, or as plain text for
// WhatsApp / SMS. Changes made after publishing stay as a draft (the owner sees "changed", "new" or "removed" and
// "Publish again"); once published again, shifts that differ from what staff saw first are marked "changed" for them.
//
// Into pay: clock-ins and clock-outs are compared with the published roster (early / late on Timesheets and on the time
// clock), and "Start next pay run" can fill hours from the published roster for hourly staff with no clock times in the
// period (as unapproved timesheet entries noted "from the roster", like copying last week's hours).
module.exports = function roster(app, h) {
  const { db, requireStaff, requireArea, requirePerm, wrap, bad, HttpError, isDate, isTime, str, round2, addDays, getSettings, todayIn, localNowISO,
    inScope, scopeSql, levelOf, audit, broadcast, alreadyPaid, assertNoOverlap } = h;

  db.exec(`
  CREATE TABLE IF NOT EXISTS roster_shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- NULL: an open shift (nobody yet)
    date TEXT NOT NULL, start TEXT NOT NULL, finish TEXT NOT NULL,  -- a finish at or before the start is the next morning
    break_min INTEGER NOT NULL DEFAULT 0, role TEXT DEFAULT '', note TEXT DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0,                         -- removed since it was published (gone at the next publish)
    published INTEGER NOT NULL DEFAULT 0,                       -- 1: the pub_* columns hold what staff see
    pub_user_id INTEGER, pub_date TEXT, pub_start TEXT, pub_finish TEXT, pub_break_min INTEGER, pub_role TEXT, pub_note TEXT,
    pub_changed INTEGER NOT NULL DEFAULT 0,                     -- published again with a change after staff first saw the week
    created_by INTEGER, created_at TEXT, updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_roster_date ON roster_shifts(date);
  CREATE INDEX IF NOT EXISTS idx_roster_pub ON roster_shifts(pub_user_id, pub_date);
  CREATE TABLE IF NOT EXISTS roster_weeks (week_start TEXT PRIMARY KEY, published_at TEXT, published_by INTEGER, published_by_name TEXT, first_published_at TEXT, times INTEGER NOT NULL DEFAULT 0);
  `);

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();
  const dayLong = d => `${DOW[dow(d)]} ${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]}`;
  const weekLabel = (a, b) => a.slice(0, 7) === b.slice(0, 7) ? `${DOW[dow(a)]} ${+a.slice(8)} – ${dayLong(b)} ${b.slice(0, 4)}`
    : a.slice(0, 4) === b.slice(0, 4) ? `${dayLong(a)} – ${dayLong(b)} ${b.slice(0, 4)}` : `${dayLong(a)} ${a.slice(0, 4)} – ${dayLong(b)} ${b.slice(0, 4)}`;
  const t12 = t => { const [hh, mm] = t.split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}${hh < 12 ? 'am' : 'pm'}`; };
  const mins = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const spanMin = (a, b) => { let m = mins(b) - mins(a); if (m <= 0) m += 1440; return m; };
  /** paid hours of a planned shift: start to finish, less its unpaid break */
  const hoursOf = s => round2(Math.max(0, spanMin(s.start, s.finish) - (+s.break_min || 0)) / 60);
  /** the shift as minutes from 1 Jan 1970 (for overlaps across midnight) */
  const range = s => { const a = Date.parse(s.date + 'T00:00Z') / 6e4 + mins(s.start); return [a, a + spanMin(s.start, s.finish)]; };
  const stamps = s => ({ clock_in: `${s.date}T${s.start}`, clock_out: `${s.finish <= s.start ? addDays(s.date, 1) : s.date}T${s.finish}` });
  const LONG_HOURS = 12;

  /** The first day of the roster week a date is in: the pay week's first day (weekly or fortnightly pay with a pay cycle date), else Monday. */
  function weekStart(date, s = getSettings()) {
    const sd = isDate(s.pay_cycle_start) && ['26', '52'].includes(String(s.pay_periods_per_year)) ? dow(s.pay_cycle_start) : 1;
    return addDays(date, -((dow(date) - sd + 7) % 7));
  }
  const weekOf = q => { const s = getSettings(); const a = weekStart(isDate(q) ? q : todayIn(s.timezone), s); return [a, addDays(a, 6)]; };
  const weekRow = a => db.prepare('SELECT * FROM roster_weeks WHERE week_start = ?').get(a) || null;
  const breakRules = () => { try { return (JSON.parse(getSettings().payroll_breaks || '[]') || []).filter(r => +r.after_hours > 0 && +r.minutes > 0); } catch { return []; } };
  /** the unpaid break Payroll takes off a shift this long (Payroll rules), in minutes */
  const ruleBreak = (spanM, rules = breakRules()) => { const r = rules.filter(x => spanM / 60 > +x.after_hours).sort((a, b) => b.minutes - a.minutes)[0]; return r ? Math.min(spanM, +r.minutes) : 0; };

  const canEdit = req => levelOf(req.user, 'timesheets') >= 2;
  const mustEdit = req => { if (!canEdit(req)) throw new HttpError(403, "Planning the roster needs Add & edit access to Timesheets. Ask an administrator."); };
  const seesPay = req => levelOf(req.user, 'pay_rates') >= 1;

  // ---- people on the roster: active and on the time clock (in this person's scope), plus anyone with a shift that week
  function peopleFor(req, a, b) {
    const [w, p] = scopeSql(req.user, 'id');
    return db.prepare(`SELECT id, name, position, pay_type, pay_rate, COALESCE(end_date, '') AS end_date, COALESCE(employee_no, '') AS employee_no FROM users
      WHERE active = 1 AND ${w} AND (COALESCE(on_timeclock, 1) = 1 OR id IN (SELECT user_id FROM roster_shifts WHERE date BETWEEN ? AND ? AND user_id IS NOT NULL)) ORDER BY name`).all(...p, a, b);
  }
  const leaveStmt = () => db.prepare('SELECT kind, date_from, date_to FROM staff_leave WHERE user_id = ? AND date_from <= ? AND date_to >= ?');
  const LEAVE = { annual: 'annual leave', sick: 'sick leave', other: 'paid leave', unpaid: 'unpaid leave' };

  /** Warnings for each shift and person (shown, not enforced). shifts: one person's, sorted; ctx: their leave and last day. */
  function warn(shifts, ctx) {
    for (const s of shifts) s.warnings = [];
    const live = shifts.filter(s => !s.deleted);
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const [a1, a2] = range(live[i]), [b1, b2] = range(live[j]);
      if (a1 < b2 && b1 < a2) { live[i].warnings.push(`Overlaps ${t12(live[j].start)}–${t12(live[j].finish)} on ${dayLong(live[j].date)}`); live[j].warnings.push(`Overlaps ${t12(live[i].start)}–${t12(live[i].finish)} on ${dayLong(live[i].date)}`); }
    }
    for (const s of live) {
      const l = (ctx.leave || []).find(x => x.date_from <= s.date && x.date_to >= s.date);
      if (l) s.warnings.push(`On ${LEAVE[l.kind] || 'leave'} this day (already booked)`);
      if (spanMin(s.start, s.finish) / 60 > LONG_HOURS) s.warnings.push(`A long shift: ${round2(spanMin(s.start, s.finish) / 60)} hours`);
      if (ctx.end_date && ctx.end_date < s.date) s.warnings.push(`Finished work on ${dayLong(ctx.end_date)}`);
    }
  }
  const shape = (r, weekPublished) => {
    const s = { id: r.id, user_id: r.user_id, date: r.date, start: r.start, finish: r.finish, break_min: r.break_min, role: r.role || '', note: r.note || '', deleted: !!r.deleted };
    s.hours = hoursOf(s); s.rule_break_min = ruleBreak(spanMin(s.start, s.finish));
    const same = r.published && r.pub_user_id === r.user_id && r.pub_date === r.date && r.pub_start === r.start && r.pub_finish === r.finish && r.pub_break_min === r.break_min && (r.pub_role || '') === (r.role || '') && (r.pub_note || '') === (r.note || '');
    // what the planner sees: not published yet (the week has been), changed since it was published, or removed
    s.state = r.deleted ? 'removed' : !weekPublished ? '' : !r.published ? 'new' : same ? '' : 'changed';
    return s;
  };

  /** The week for the planner: people × days, open shifts, warnings, totals (and wages, with pay rate access). */
  function plannerWeek(req, q) {
    const [a, b] = weekOf(q), days = Array.from({ length: 7 }, (_, i) => addDays(a, i)), s = getSettings(), wk = weekRow(a), pay = seesPay(req);
    const rows = db.prepare('SELECT * FROM roster_shifts WHERE date BETWEEN ? AND ? ORDER BY date, start, id').all(a, b);
    const people = peopleFor(req, a, b), seen = new Set(people.map(p => p.id)), lv = leaveStmt();
    const normal = +s.normal_week_hours || 40;
    const out = people.map(p => {
      const shifts = rows.filter(r => r.user_id === p.id).map(r => shape(r, !!wk));
      const leave = lv.all(p.id, b, a);
      // the day before the week (a night shift running into Monday) counts for overlaps, but isn't shown
      const before = db.prepare('SELECT * FROM roster_shifts WHERE user_id = ? AND date = ? AND deleted = 0').all(p.id, addDays(a, -1)).map(r => shape(r, false));
      warn([...before, ...shifts], { leave, end_date: p.end_date });
      const live = shifts.filter(x => !x.deleted), hours = round2(live.reduce((t, x) => t + x.hours, 0));
      const person = { id: p.id, name: p.name, position: p.position || '', employee_no: p.employee_no, end_date: p.end_date, shifts, hours, days: new Set(live.map(x => x.date)).size, warnings: [],
        leave: Object.fromEntries(days.map(d => [d, (leave.find(l => l.date_from <= d && l.date_to >= d) || {}).kind]).filter(([, k]) => k)) };
      if (hours > normal) person.warnings.push(`${hours} hours this week: over the normal ${normal}-hour week (extra hours)`);
      if (pay) { person.pay_type = p.pay_type; person.pay_rate = p.pay_rate; person.wages = p.pay_type === 'hourly' ? round2(hours * (+p.pay_rate || 0)) : null; }
      return person;
    });
    const open = rows.filter(r => r.user_id === null || r.user_id === undefined).map(r => shape(r, !!wk));
    for (const o of open) { o.warnings = spanMin(o.start, o.finish) / 60 > LONG_HOURS ? [`A long shift: ${round2(spanMin(o.start, o.finish) / 60)} hours`] : []; }
    const hidden = rows.filter(r => r.user_id && !seen.has(r.user_id)).length;   // other teams' shifts (a supervisor sees their own team)
    const all = [...out.flatMap(p => p.shifts), ...open];
    const pending = { new: all.filter(x => x.state === 'new').length, changed: all.filter(x => x.state === 'changed').length, removed: all.filter(x => x.state === 'removed').length };
    const live = out.flatMap(p => p.shifts.filter(x => !x.deleted));
    const roles = db.prepare("SELECT role, COUNT(*) AS n FROM roster_shifts WHERE COALESCE(role, '') != '' GROUP BY role ORDER BY n DESC, role LIMIT 30").all().map(r => r.role);
    return {
      week_start: a, week_end: b, label: weekLabel(a, b), days, today: todayIn(s.timezone), can_edit: canEdit(req), sees_pay: pay,
      normal_start: s.normal_start || '09:00', normal_finish: s.normal_finish || '17:00', normal_week_hours: normal, long_shift_hours: LONG_HOURS,
      published: wk ? { at: wk.published_at, by: wk.published_by_name, first_at: wk.first_published_at, times: wk.times } : null, pending, hidden,
      people: out, open: open.filter(o => !o.deleted).concat(open.filter(o => o.deleted)), roles,
      totals: { hours: round2(live.reduce((t, x) => t + x.hours, 0)), shifts: live.length, open: open.filter(o => !o.deleted).length,
        open_hours: round2(open.filter(o => !o.deleted).reduce((t, x) => t + x.hours, 0)), people: out.filter(p => p.hours > 0).length,
        wages: pay ? round2(out.reduce((t, p) => t + (p.wages || 0), 0)) : null, salaried: pay ? out.filter(p => p.pay_type === 'salary' && p.hours > 0).length : null,
        warnings: out.reduce((t, p) => t + p.warnings.length + p.shifts.filter(x => !x.deleted).reduce((u, x) => u + x.warnings.length, 0), 0) },
    };
  }
  app.get('/api/staff/roster', requireArea('timesheets', 1), wrap((req, res) => res.json(plannerWeek(req, req.query.week))));

  // ---- adding and changing shifts
  function clean(req, b, old = {}) {
    const v = { ...old, ...b };
    const out = { date: v.date, start: v.start, finish: v.finish, break_min: Math.round(+v.break_min || 0), role: str(v.role, 40), note: str(v.note, 200) };
    if (!isDate(out.date)) bad('Choose the day.');
    if (!isTime(out.start) || !isTime(out.finish)) bad('Enter the start and finish times.');
    if (out.start === out.finish) bad('The finish is the same as the start.');
    const span = spanMin(out.start, out.finish);
    if (span > 16 * 60) bad('A shift can be 16 hours at most.');
    if (out.break_min < 0 || out.break_min > 240) bad('The break can be 0 to 240 minutes.');
    if (out.break_min >= span) bad('The break is as long as the shift.');
    const uid = v.user_id === null || v.user_id === '' || v.user_id === undefined || +v.user_id === 0 ? null : +v.user_id;
    if (uid !== null) {
      const u = db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(uid);
      if (!u) bad('Choose who works this shift (or leave it as an open shift).');
      if (!inScope(req.user, 'timesheets', uid, 2)) throw new HttpError(403, `${u.name} isn't in your team.`);
    }
    out.user_id = uid;
    return out;
  }
  /** the warnings for one shift, among that person's other shifts that week */
  function warningsFor(id) {
    const r = db.prepare('SELECT * FROM roster_shifts WHERE id = ?').get(id); if (!r) return [];
    if (!r.user_id) return spanMin(r.start, r.finish) / 60 > LONG_HOURS ? [`A long shift: ${round2(spanMin(r.start, r.finish) / 60)} hours`] : [];
    const near = db.prepare('SELECT * FROM roster_shifts WHERE user_id = ? AND deleted = 0 AND date BETWEEN ? AND ? ORDER BY date, start').all(r.user_id, addDays(r.date, -1), addDays(r.date, 1)).map(x => shape(x, false));
    const u = db.prepare("SELECT COALESCE(end_date, '') AS end_date FROM users WHERE id = ?").get(r.user_id) || {};
    warn(near, { leave: leaveStmt().all(r.user_id, r.date, r.date), end_date: u.end_date });
    return (near.find(x => x.id === r.id) || { warnings: [] }).warnings;
  }
  const changed = () => broadcast({ type: 'roster' }, true);
  const ins = (req, v) => db.prepare('INSERT INTO roster_shifts(user_id, date, start, finish, break_min, role, note, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(v.user_id, v.date, v.start, v.finish, v.break_min, v.role, v.note, req.user.id, new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  const own = (req, id) => {
    const r = db.prepare('SELECT * FROM roster_shifts WHERE id = ?').get(+id);
    if (!r) throw new HttpError(404, 'That shift is no longer on the roster.');
    if (r.user_id && !inScope(req.user, 'timesheets', r.user_id, 2)) throw new HttpError(403, "That person isn't in your team.");
    return r;
  };
  app.post('/api/staff/roster/shifts', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const v = clean(req, req.body || {}), id = ins(req, v);
    changed(); res.json({ ok: true, id, warnings: warningsFor(id) });
  }));
  app.put('/api/staff/roster/shifts/:id', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const r = own(req, req.params.id), b = req.body || {};
    if (b.restore === true) { db.prepare('UPDATE roster_shifts SET deleted = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), r.id); changed(); return res.json({ ok: true, id: r.id, warnings: warningsFor(r.id) }); }
    const v = clean(req, b, { user_id: r.user_id, date: r.date, start: r.start, finish: r.finish, break_min: r.break_min, role: r.role, note: r.note });
    db.prepare('UPDATE roster_shifts SET user_id = ?, date = ?, start = ?, finish = ?, break_min = ?, role = ?, note = ?, deleted = 0, updated_at = ? WHERE id = ?')
      .run(v.user_id, v.date, v.start, v.finish, v.break_min, v.role, v.note, new Date().toISOString(), r.id);
    changed(); res.json({ ok: true, id: r.id, warnings: warningsFor(r.id) });
  }));
  app.delete('/api/staff/roster/shifts/:id', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const r = own(req, req.params.id);
    // a published shift stays (marked removed) until the roster is published again, so staff are told
    if (r.published) db.prepare('UPDATE roster_shifts SET deleted = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
    else db.prepare('DELETE FROM roster_shifts WHERE id = ?').run(r.id);
    changed(); res.json({ ok: true, removed: !!r.published });
  }));
  // repeat a shift on other days (the same person, times, role and note); a day that already has the same shift is skipped
  app.post('/api/staff/roster/shifts/:id/repeat', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const r = own(req, req.params.id), dates = [...new Set((Array.isArray(req.body.dates) ? req.body.dates : []).filter(isDate))].filter(d => d !== r.date).slice(0, 31);
    if (!dates.length) bad('Choose the days to repeat it on.');
    const same = db.prepare('SELECT 1 FROM roster_shifts WHERE user_id IS ? AND date = ? AND start = ? AND finish = ? AND deleted = 0 LIMIT 1');
    let added = 0; const skipped = [];
    for (const d of dates) { if (same.get(r.user_id, d, r.start, r.finish)) { skipped.push(d); continue; } ins(req, { ...r, date: d }); added++; }
    changed(); res.json({ ok: true, added, skipped });
  }));

  // copy last week: each shift of the week before, a week on; people who have left, are on leave that day, or already have
  // the same shift are skipped. replace: take this week's shifts off first.
  app.post('/api/staff/roster/copy-week', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const [a, b] = weekOf(req.body.week), fa = addDays(a, -7), fb = addDays(a, -1);
    const src = db.prepare('SELECT * FROM roster_shifts WHERE date BETWEEN ? AND ? AND deleted = 0 ORDER BY date, start').all(fa, fb).filter(r => !r.user_id || inScope(req.user, 'timesheets', r.user_id, 2));
    if (!src.length) bad(`There are no shifts in the week before (${weekLabel(fa, fb)}) to copy.`);
    const lv = leaveStmt(), user = db.prepare("SELECT id, name, active, COALESCE(end_date, '') AS end_date FROM users WHERE id = ?");
    const same = db.prepare('SELECT 1 FROM roster_shifts WHERE user_id IS ? AND date = ? AND start = ? AND finish = ? AND deleted = 0 LIMIT 1');
    let added = 0, removed = 0; const skipped = [];
    db.exec('BEGIN');
    try {
      if (req.body.replace === true) {
        for (const r of db.prepare('SELECT * FROM roster_shifts WHERE date BETWEEN ? AND ? AND deleted = 0').all(a, b)) {
          if (r.user_id && !inScope(req.user, 'timesheets', r.user_id, 2)) continue;
          if (r.published) db.prepare('UPDATE roster_shifts SET deleted = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), r.id); else db.prepare('DELETE FROM roster_shifts WHERE id = ?').run(r.id);
          removed++;
        }
      }
      for (const r of src) {
        const d = addDays(r.date, 7), u = r.user_id ? user.get(r.user_id) : null;
        const why = r.user_id && (!u || !u.active) ? 'no longer working' : u && u.end_date && u.end_date < d ? `finished on ${dayLong(u.end_date)}` : u && lv.all(u.id, d, d).length ? 'on leave that day'
          : same.get(r.user_id, d, r.start, r.finish) ? 'already on the roster' : '';
        if (why) { skipped.push({ name: u ? u.name : 'Open shift', date: d, why }); continue; }
        ins(req, { ...r, date: d }); added++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (added || removed) { audit(req, 'Copied the roster', `${added} shift${added === 1 ? '' : 's'} from ${weekLabel(fa, fb)} into ${weekLabel(a, b)}${removed ? ` (${removed} taken off first)` : ''}`); changed(); }
    res.json({ ok: true, added, removed, skipped });
  }));

  // ---- publish: what staff see
  app.post('/api/staff/roster/publish', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const [a, b] = weekOf(req.body.week), before = weekRow(a), at = new Date().toISOString();
    let shifts = 0, changedN = 0, removed = 0, added = 0;
    db.exec('BEGIN');
    try {
      // shifts moved out of this week since it was published come off its published copy
      db.prepare('UPDATE roster_shifts SET published = 0, pub_user_id = NULL, pub_date = NULL, pub_start = NULL, pub_finish = NULL, pub_break_min = NULL, pub_role = NULL, pub_note = NULL WHERE published = 1 AND pub_date BETWEEN ? AND ? AND date NOT BETWEEN ? AND ?').run(a, b, a, b);
      for (const r of db.prepare('SELECT * FROM roster_shifts WHERE date BETWEEN ? AND ?').all(a, b)) {
        if (r.deleted) { db.prepare('DELETE FROM roster_shifts WHERE id = ?').run(r.id); removed++; continue; }
        const same = r.published && r.pub_user_id === r.user_id && r.pub_date === r.date && r.pub_start === r.start && r.pub_finish === r.finish && r.pub_break_min === r.break_min && (r.pub_role || '') === (r.role || '') && (r.pub_note || '') === (r.note || '');
        const isChange = !!before && !same;   // staff saw this week before: a new or different shift is "changed" for them
        if (isChange) { if (r.published) changedN++; else added++; }
        db.prepare('UPDATE roster_shifts SET published = 1, pub_user_id = ?, pub_date = ?, pub_start = ?, pub_finish = ?, pub_break_min = ?, pub_role = ?, pub_note = ?, pub_changed = ? WHERE id = ?')
          .run(r.user_id, r.date, r.start, r.finish, r.break_min, r.role || '', r.note || '', isChange || r.pub_changed ? 1 : 0, r.id);
        shifts++;
      }
      db.prepare(`INSERT INTO roster_weeks(week_start, published_at, published_by, published_by_name, first_published_at, times) VALUES(?,?,?,?,?,1)
        ON CONFLICT(week_start) DO UPDATE SET published_at = excluded.published_at, published_by = excluded.published_by, published_by_name = excluded.published_by_name, times = times + 1`)
        .run(a, at, req.user.id, req.user.name, at);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const what = before ? `published again: ${added} new, ${changedN} changed, ${removed} removed` : 'published';
    audit(req, 'Published the roster', `${weekLabel(a, b)}: ${shifts} shift${shifts === 1 ? '' : 's'} ${what}`);
    changed();
    res.json({ ok: true, week_start: a, shifts, added, changed: changedN, removed, again: !!before, text: publishedText(a) });
  }));

  // ---- the published roster (what staff see): everyone signed in, no pay. Like the roster on the staff-room wall.
  const pubRows = (a, b, uid) => db.prepare(`SELECT r.id, r.pub_user_id AS user_id, r.pub_date AS date, r.pub_start AS start, r.pub_finish AS finish, r.pub_break_min AS break_min,
      COALESCE(r.pub_role, '') AS role, COALESCE(r.pub_note, '') AS note, r.pub_changed AS changed, u.name, COALESCE(u.position, '') AS position
    FROM roster_shifts r LEFT JOIN users u ON u.id = r.pub_user_id WHERE r.published = 1 AND r.pub_date BETWEEN ? AND ? ${uid ? 'AND r.pub_user_id = ?' : ''} ORDER BY r.pub_date, r.pub_start, u.name`)
    .all(...[a, b, ...(uid ? [uid] : [])]).map(s => ({ ...s, changed: !!s.changed, hours: hoursOf(s) }));
  function publishedWeek(q) {
    const [a, b] = weekOf(q), wk = weekRow(a), rows = wk ? pubRows(a, b) : [];
    const people = [];
    for (const s of rows.filter(x => x.user_id)) { let p = people.find(x => x.id === s.user_id); if (!p) people.push(p = { id: s.user_id, name: s.name, position: s.position, shifts: [], hours: 0 }); p.shifts.push(s); p.hours = round2(p.hours + s.hours); }
    people.sort((x, y) => x.name.localeCompare(y.name));
    return { week_start: a, week_end: b, label: weekLabel(a, b), days: Array.from({ length: 7 }, (_, i) => addDays(a, i)), published: wk ? { at: wk.published_at, by: wk.published_by_name, times: wk.times } : null,
      people, open: rows.filter(x => !x.user_id), company: getSettings().company_name || '' };
  }
  /** The roster as plain text for WhatsApp or SMS: a line per shift, by day. */
  function publishedText(q) {
    const w = publishedWeek(q);
    if (!w.published) return `${w.company ? w.company + ': ' : ''}the roster for ${w.label} isn't published yet.`;
    const all = [...w.people.flatMap(p => p.shifts), ...w.open], anyChanged = all.some(s => s.changed);
    const lines = [`*${w.company ? w.company + ' ' : ''}roster: ${w.label}*`];
    if (w.published.times > 1) lines.push(`Updated ${dayLong(w.published.at.slice(0, 10))}${anyChanged ? '. Changes are marked (changed)' : ''}.`);
    for (const d of w.days) {
      const list = all.filter(s => s.date === d).sort((x, y) => x.start.localeCompare(y.start) || String(x.name || '').localeCompare(String(y.name || '')));
      lines.push('', `*${dayLong(d)}*`);
      if (!list.length) { lines.push('Nobody rostered'); continue; }
      for (const s of list) lines.push(`- ${s.user_id ? s.name : 'OPEN SHIFT (ask to take it)'}: ${t12(s.start)}-${t12(s.finish)}${s.role ? ` ${s.role}` : ''}${s.break_min ? ` (${s.break_min} min break)` : ''}${s.note ? `. ${s.note}` : ''}${s.changed ? ' (changed)' : ''}`);
    }
    return lines.join('\n');
  }
  app.get('/api/staff/roster/published', requireStaff, wrap((req, res) => { const w = publishedWeek(req.query.week); res.json({ ...w, me: req.user.id, text: publishedText(req.query.week) }); }));

  // ---- the time clock: a person's published shifts this week and next (after tapping their name)
  app.get('/api/staff/timeclock/roster', requirePerm('timeclock.use'), wrap((req, res) => {
    const u = db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(+req.query.user_id);
    if (!u) throw new HttpError(404, 'Choose your name.');
    const now = localNowISO(getSettings().timezone), today = now.slice(0, 10);
    res.json({ today, shifts: pubRows(addDays(today, -1), addDays(today, 13), u.id).filter(s => s.date >= today || stamps(s).clock_out > now) });
  }));

  // ---- compare clocking in and out with the published roster
  /** The published shift a clock-in at stamp ci belongs to: the same person, starting within 4 hours of it (nearest first). */
  const nearStmt = () => db.prepare('SELECT pub_date AS date, pub_start AS start, pub_finish AS finish, pub_break_min AS break_min, COALESCE(pub_role, \'\') AS role FROM roster_shifts WHERE published = 1 AND pub_user_id = ? AND pub_date BETWEEN ? AND ?');
  const diffMin = (x, y) => Math.round((Date.parse(x + 'Z') - Date.parse(y + 'Z')) / 6e4);
  function rosteredFor(uid, ci, stmt = nearStmt()) {
    const d = ci.slice(0, 10);
    const best = stmt.all(uid, addDays(d, -1), addDays(d, 1)).map(s => ({ ...s, ...stamps(s) })).map(s => ({ s, gap: Math.abs(diffMin(ci, s.clock_in)) })).filter(x => x.gap <= 240).sort((p, q) => p.gap - q.gap)[0];
    return best ? best.s : null;
  }
  /** for a timesheet row: { start, finish, in_min (+ late, − early), out_min (+ stayed on, − left early) } */
  function compare(t, stmt) {
    const s = rosteredFor(t.user_id, t.clock_in, stmt); if (!s) return null;
    return { date: s.date, start: s.start, finish: s.finish, role: s.role, in_min: diffMin(t.clock_in, s.clock_in), out_min: t.clock_out ? diffMin(t.clock_out, s.clock_out) : null };
  }
  app.locals.rosterCompare = rows => { const st = nearStmt(); for (const r of rows) r.roster = compare(r, st); return rows; };
  app.locals.rosterPunch = (uid, now, onShift, open) => {
    const st = nearStmt();
    if (onShift) { const s = rosteredFor(uid, now, st); return s ? { start: s.start, finish: s.finish, in_min: diffMin(now, s.clock_in) } : null; }
    if (!open) return null;
    const c = compare({ user_id: uid, clock_in: open.clock_in, clock_out: now }, st);
    return c ? { start: c.start, finish: c.finish, out_min: c.out_min } : null;
  };

  // ---- into pay: fill hours from the published roster for hourly staff who have no clock times in the period
  const NORMAL = "COALESCE(extra_reason, '') = '' AND COALESCE(note, '') = ''";
  function fillPlan(req, start, end) {
    if (!isDate(start) || !isDate(end) || end < start) bad('Choose a valid pay period.');
    if ((Date.parse(end) - Date.parse(start)) / 864e5 > 31) bad('Choose one pay period (31 days at most) to fill.');
    const run = db.prepare(`SELECT id, pay_date FROM payroll_runs WHERE ${NORMAL} AND period_start <= ? AND period_end >= ? ORDER BY id LIMIT 1`).get(end, start);
    if (run) throw new HttpError(409, `These dates are already paid (pay run #${run.id}, paid ${run.pay_date}). Hours can't be filled into dates that are already paid.`, { already_paid: { run_id: run.id } });
    const people = [], clocked = [];
    const has = db.prepare('SELECT COUNT(*) AS n FROM timesheets WHERE user_id = ? AND substr(clock_in, 1, 10) BETWEEN ? AND ?'), lv = db.prepare('SELECT kind FROM staff_leave WHERE user_id = ? AND date_from <= ? AND date_to >= ? LIMIT 1');
    const byUser = {}; for (const s of pubRows(start, end).filter(x => x.user_id)) (byUser[s.user_id] = byUser[s.user_id] || []).push(s);
    for (const u of db.prepare("SELECT id, name, pay_type, COALESCE(end_date, '') AS end_date FROM users WHERE active = 1 AND pay_type = 'hourly' ORDER BY name").all()) {
      const list = byUser[u.id]; if (!list || !inScope(req.user, 'timesheets', u.id, 2)) continue;
      if (has.get(u.id, start, end).n) { clocked.push({ user_id: u.id, name: u.name }); continue; }
      const paid = alreadyPaid(start, end, [u.id]);
      const rows = list.map(s => { const st = stamps(s), l = lv.get(u.id, s.date, s.date);
        const skip = paid ? 'already paid for these dates' : u.end_date && u.end_date < s.date ? `finished on ${u.end_date}` : l ? `on ${l.kind} leave` : '';
        return { date: s.date, ...st, hours: round2(spanMin(s.start, s.finish) / 60), break_min: s.break_min, role: s.role, skip }; });
      people.push({ user_id: u.id, name: u.name, rows, total: round2(rows.filter(r => !r.skip).reduce((t, r) => t + r.hours, 0)) });
    }
    const weeks = db.prepare('SELECT COUNT(*) AS n FROM roster_weeks WHERE week_start BETWEEN ? AND ?').get(weekStart(start), end).n;
    return { start, end, people, clocked, published_weeks: weeks };
  }
  function fill(req, start, end, only = null) {
    const p = fillPlan(req, start, end), ins2 = db.prepare('INSERT INTO timesheets(user_id, clock_in, clock_out, notes) VALUES(?,?,?,?)');
    const results = [];
    for (const x of p.people) {
      if (only && !only.includes(x.user_id)) continue;
      for (const r of x.rows.filter(z => !z.skip)) {
        try { assertNoOverlap(x.user_id, r.clock_in, r.clock_out); ins2.run(x.user_id, r.clock_in, r.clock_out, `from the roster${r.role ? ` (${r.role})` : ''}`); results.push({ ok: true, user_id: x.user_id }); }
        catch (e) { results.push({ ok: false, user_id: x.user_id, error: `${x.name}, ${r.date}: ${e.message}` }); }
      }
    }
    const saved = results.filter(r => r.ok).length, people = new Set(results.filter(r => r.ok).map(r => r.user_id)).size;
    if (saved) { audit(req, 'Filled hours from the roster', `${saved} shift${saved === 1 ? '' : 's'} for ${people} ${people === 1 ? 'person' : 'people'}, ${start} to ${end}`); broadcast({ type: 'shift' }, true); }
    return { saved, people, failed: results.filter(r => !r.ok).map(r => r.error), clocked: p.clocked, published_weeks: p.published_weeks };
  }
  app.locals.rosterFill = fill;
  app.post('/api/staff/payroll/roster-hours/preview', requireArea('payroll', 2), requireArea('timesheets', 2), wrap((req, res) => { const b = req.body || {}; res.json(fillPlan(req, b.period_start, b.period_end)); }));
  app.post('/api/staff/payroll/roster-hours', requireArea('payroll', 2), requireArea('timesheets', 2), wrap((req, res) => {
    const b = req.body || {}, only = Array.isArray(b.user_ids) ? b.user_ids.map(Number) : null;
    res.json(fill(req, b.period_start, b.period_end, only));
  }));

  return { weekStart, publishedText, hoursOf };
};
