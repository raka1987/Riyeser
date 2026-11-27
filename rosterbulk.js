// OWNER-BULKROSTER (Payroll 2.4.0): rostering many people at once, so planning a week isn't one shift at a time.
//
//  - Shift templates ("standard shifts"): named shifts such as "Open 7:00am–3:00pm, 30 min break", with a role or area
//    and a colour. A few sensible ones are there to start with; change them under Roster → Shift templates.
//  - Usual week: each person's standard pattern (which days, which template or times). "Fill week from usual weeks" puts
//    them on the roster for everyone (or the people chosen) in one go, skipping leave already booked, people who have
//    left (or haven't started yet), and days that already have a shift (unless "replace" is chosen).
//  - Select many cells on the grid and apply once: a template, typed times, clear, or a role.
//  - Import shifts from a CSV file (Excel: Save as CSV): a preview shows who each line matched and any problems before
//    anything is saved. A template file to fill in can be downloaded.
//  - Copy last week, and copy this week to the next 1–12 weeks.
//  - Each bulk change can be undone (the last one, per person signed in). Bulk changes are drafts until published, like
//    any other change. The same warnings as one shift (overlaps, leave, long shifts) come back in a summary.
// Permissions as for the roster: Add & edit access to Timesheets; a supervisor only their own team (open shifts: anyone
// who can plan). Payroll doesn't keep a list of public holidays, so none are skipped (a shift on one is a normal shift).
module.exports = function rosterBulk(app, h, R) {
  const { db, requireStaff, requireArea, wrap, bad, HttpError, isDate, isTime, str, addDays, getSettings, setSetting, todayIn, inScope, audit } = h;
  const { ins, clean, warningsFor, weekOf, weekLabel, dayLong, dow, t12, spanMin, mustEdit, leaveStmt, LEAVE, peopleFor, changed } = R;

  db.exec(`
  CREATE TABLE IF NOT EXISTS roster_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, start TEXT NOT NULL, finish TEXT NOT NULL, break_min INTEGER NOT NULL DEFAULT 0,
    role TEXT DEFAULT '', colour TEXT DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS roster_patterns (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, dow INTEGER NOT NULL,   -- 0 Sunday … 6 Saturday
    template_id INTEGER, start TEXT NOT NULL, finish TEXT NOT NULL, break_min INTEGER NOT NULL DEFAULT 0, role TEXT DEFAULT '',
    PRIMARY KEY (user_id, dow)
  );
  CREATE TABLE IF NOT EXISTS roster_undo (user_id INTEGER PRIMARY KEY, label TEXT, at TEXT, week_start TEXT, ops TEXT);
  `);
  const COLOURS = ['#2f7d5b', '#2563eb', '#c2410c', '#7c3aed', '#0e7490', '#b45309', '#be185d', '#4b5563'];
  if (getSettings().roster_templates_seeded !== '1') {
    if (!db.prepare('SELECT COUNT(*) AS n FROM roster_templates').get().n) {
      const at = new Date().toISOString(), t = db.prepare('INSERT INTO roster_templates(name, start, finish, break_min, role, colour, sort, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
      [['Open', '07:00', '15:00', 30, COLOURS[0]], ['Day', '09:00', '17:00', 30, COLOURS[1]], ['Close', '14:00', '22:00', 30, COLOURS[3]], ['Half day', '09:00', '13:00', 0, COLOURS[4]]]
        .forEach(([n, a, b, br, c], i) => t.run(n, a, b, br, '', c, i + 1, at, at));
    }
    if (setSetting) setSetting('roster_templates_seeded', '1');
  }

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const now = () => new Date().toISOString();
  const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
  const rowOf = id => db.prepare('SELECT * FROM roster_shifts WHERE id = ?').get(id);
  const userOf = id => db.prepare("SELECT id, name, active, COALESCE(end_date, '') AS end_date, COALESCE(start_date, '') AS start_date FROM users WHERE id = ?").get(id);
  const templates = () => db.prepare('SELECT id, name, start, finish, break_min, COALESCE(role, \'\') AS role, COALESCE(colour, \'\') AS colour FROM roster_templates ORDER BY sort, name, id').all();
  const templateOf = id => (+id > 0 ? db.prepare('SELECT * FROM roster_templates WHERE id = ?').get(+id) : null);

  /** a dry run (preview) is done for real inside a transaction, then rolled back */
  function atomic(fn, keep = true) {
    db.exec('BEGIN');
    try { const r = fn(); if (keep) db.exec('COMMIT'); else db.exec('ROLLBACK'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { } throw e; }
  }

  // ---- the journal of one bulk change, so it can be undone (the last one, per person signed in)
  const FIELDS = ['user_id', 'date', 'start', 'finish', 'break_min', 'role', 'note', 'template_id', 'deleted'];
  function journal(req) {
    const ops = [], touched = new Set();
    return {
      ops, touched,
      add(v) { const id = ins(req, v); ops.push({ k: 'ins', id }); touched.add(id); return id; },
      change(r, patch) {
        ops.push({ k: 'upd', id: r.id, before: Object.fromEntries(FIELDS.map(f => [f, r[f] ?? null])) });
        const v = { ...r, ...patch, deleted: 0 };
        db.prepare('UPDATE roster_shifts SET user_id = ?, date = ?, start = ?, finish = ?, break_min = ?, role = ?, note = ?, template_id = ?, deleted = 0, updated_at = ? WHERE id = ?')
          .run(v.user_id ?? null, v.date, v.start, v.finish, v.break_min, v.role || '', v.note || '', v.template_id || null, now(), r.id);
        touched.add(r.id);
      },
      // a published shift stays (marked removed) until the roster is published again, so staff are told
      remove(r) {
        if (r.published) { db.prepare('UPDATE roster_shifts SET deleted = 1, updated_at = ? WHERE id = ?').run(now(), r.id); ops.push({ k: 'mark', id: r.id }); }
        else { db.prepare('DELETE FROM roster_shifts WHERE id = ?').run(r.id); ops.push({ k: 'del', row: r }); }
      },
    };
  }
  function keepUndo(req, label, J, week) {
    if (!J.ops.length) return null;
    db.prepare('INSERT INTO roster_undo(user_id, label, at, week_start, ops) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET label = excluded.label, at = excluded.at, week_start = excluded.week_start, ops = excluded.ops')
      .run(req.user.id, label, now(), week || null, JSON.stringify(J.ops));
    return { label, at: now(), week_start: week || null };
  }
  const undoOf = uid => { const u = db.prepare('SELECT label, at, week_start FROM roster_undo WHERE user_id = ?').get(uid); return u ? { label: u.label, at: u.at, week_start: u.week_start } : null; };
  app.post('/api/staff/roster/undo', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const u = db.prepare('SELECT * FROM roster_undo WHERE user_id = ?').get(req.user.id);
    if (!u) bad('There is nothing to undo.');
    let ops = []; try { ops = JSON.parse(u.ops) || []; } catch { }
    let undone = 0;
    atomic(() => {
      for (const op of ops.slice().reverse()) {
        if (op.k === 'ins') {
          const r = rowOf(op.id); if (!r) continue;
          if (r.published) db.prepare('UPDATE roster_shifts SET deleted = 1, updated_at = ? WHERE id = ?').run(now(), r.id); else db.prepare('DELETE FROM roster_shifts WHERE id = ?').run(r.id);
        } else if (op.k === 'upd') {
          if (!rowOf(op.id)) continue;
          const b = op.before;
          db.prepare('UPDATE roster_shifts SET user_id = ?, date = ?, start = ?, finish = ?, break_min = ?, role = ?, note = ?, template_id = ?, deleted = ?, updated_at = ? WHERE id = ?')
            .run(b.user_id, b.date, b.start, b.finish, b.break_min, b.role || '', b.note || '', b.template_id || null, b.deleted ? 1 : 0, now(), op.id);
        } else if (op.k === 'mark') {
          db.prepare('UPDATE roster_shifts SET deleted = 0, updated_at = ? WHERE id = ?').run(now(), op.id);
        } else if (op.k === 'del') {
          if (rowOf(op.row.id)) continue;
          const cols = Object.keys(op.row).filter(c => /^\w+$/.test(c));
          db.prepare(`INSERT INTO roster_shifts(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')})`).run(...cols.map(c => op.row[c] ?? null));
        } else continue;
        undone++;
      }
      db.prepare('DELETE FROM roster_undo WHERE user_id = ?').run(req.user.id);
    });
    audit(req, 'Undid a roster change', u.label);
    changed();
    res.json({ ok: true, label: u.label, undone, week_start: u.week_start });
  }));

  // ---- the summary every bulk change returns: added / changed / removed, skipped (and why), and the warnings
  function summary(J, extra = {}) {
    const names = new Map(), name = id => { if (!id) return 'Open shift'; if (!names.has(id)) names.set(id, (userOf(id) || {}).name || ''); return names.get(id); };
    const warnings = [];
    for (const id of J.touched) {
      const r = rowOf(id); if (!r || r.deleted) continue;
      for (const w of warningsFor(id)) warnings.push({ id, user_id: r.user_id, name: name(r.user_id), date: r.date, times: `${t12(r.start)}–${t12(r.finish)}`, text: w });
    }
    warnings.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    return {
      added: J.ops.filter(o => o.k === 'ins').length, changed: J.ops.filter(o => o.k === 'upd').length, removed: J.ops.filter(o => o.k === 'mark' || o.k === 'del').length,
      warnings, ...extra,
    };
  }
  const why = (u, d, lv) => {
    if (!u) return '';
    if (!u.active) return 'no longer working';
    if (u.end_date && u.end_date < d) return `finished on ${dayLong(u.end_date)}`;
    if (u.start_date && u.start_date > d) return `starts on ${dayLong(u.start_date)}`;
    return lv && lv.all(u.id, d, d).length ? 'on leave that day' : '';
  };
  const liveIn = (uid, d) => db.prepare('SELECT * FROM roster_shifts WHERE user_id IS ? AND date = ? AND deleted = 0 ORDER BY start, id').all(uid, d);
  const canTouch = (req, uid) => !uid || inScope(req.user, 'timesheets', uid, 2);

  // ---- shift templates
  function cleanTemplate(b) {
    const v = { name: str(b.name, 40), start: b.start, finish: b.finish, break_min: Math.round(+b.break_min || 0), role: str(b.role, 40), colour: String(b.colour || '') };
    if (!v.name) bad('Give the shift a name, e.g. Open or Close.');
    if (!isTime(v.start) || !isTime(v.finish)) bad('Enter the start and finish times.');
    if (v.start === v.finish) bad('The finish is the same as the start.');
    const span = spanMin(v.start, v.finish);
    if (span > 16 * 60) bad('A shift can be 16 hours at most.');
    if (v.break_min < 0 || v.break_min > 240 || v.break_min >= span) bad('The break can be 0 to 240 minutes, and shorter than the shift.');
    if (!/^#[0-9a-f]{6}$/i.test(v.colour)) v.colour = COLOURS[db.prepare('SELECT COUNT(*) AS n FROM roster_templates').get().n % COLOURS.length];
    return v;
  }
  app.get('/api/staff/roster/templates', requireArea('timesheets', 1), wrap((req, res) => res.json({ templates: templates(), colours: COLOURS })));
  app.post('/api/staff/roster/templates', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const v = cleanTemplate(req.body || {}), sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM roster_templates').get().n;
    if (db.prepare('SELECT 1 FROM roster_templates WHERE lower(name) = lower(?)').get(v.name)) bad(`There is already a shift template called ${v.name}.`);
    const id = db.prepare('INSERT INTO roster_templates(name, start, finish, break_min, role, colour, sort, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(v.name, v.start, v.finish, v.break_min, v.role, v.colour, sort, now(), now()).lastInsertRowid;
    audit(req, 'Added a shift template', `${v.name} ${t12(v.start)}–${t12(v.finish)}`); changed();
    res.json({ ok: true, id, templates: templates() });
  }));
  app.put('/api/staff/roster/templates/:id', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const t = templateOf(req.params.id); if (!t) throw new HttpError(404, 'That shift template is no longer there.');
    const v = cleanTemplate({ ...t, ...(req.body || {}) });
    if (db.prepare('SELECT 1 FROM roster_templates WHERE lower(name) = lower(?) AND id != ?').get(v.name, t.id)) bad(`There is already a shift template called ${v.name}.`);
    db.prepare('UPDATE roster_templates SET name = ?, start = ?, finish = ?, break_min = ?, role = ?, colour = ?, updated_at = ? WHERE id = ?').run(v.name, v.start, v.finish, v.break_min, v.role, v.colour, now(), t.id);
    // usual weeks that use it follow it (shifts already on the roster keep their own times)
    db.prepare('UPDATE roster_patterns SET start = ?, finish = ?, break_min = ?, role = ? WHERE template_id = ?').run(v.start, v.finish, v.break_min, v.role, t.id);
    audit(req, 'Changed a shift template', `${v.name} ${t12(v.start)}–${t12(v.finish)}`); changed();
    res.json({ ok: true, id: t.id, templates: templates() });
  }));
  app.delete('/api/staff/roster/templates/:id', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const t = templateOf(req.params.id); if (!t) throw new HttpError(404, 'That shift template is no longer there.');
    // shifts and usual weeks made from it keep their times; they just aren't linked to it any more
    atomic(() => {
      db.prepare('UPDATE roster_shifts SET template_id = NULL WHERE template_id = ?').run(t.id);
      db.prepare('UPDATE roster_patterns SET template_id = NULL WHERE template_id = ?').run(t.id);
      db.prepare('DELETE FROM roster_templates WHERE id = ?').run(t.id);
    });
    audit(req, 'Deleted a shift template', t.name); changed();
    res.json({ ok: true, templates: templates() });
  }));

  // ---- usual weeks (each person's standard pattern)
  const patternsOf = uid => db.prepare('SELECT dow, template_id, start, finish, break_min, COALESCE(role, \'\') AS role FROM roster_patterns WHERE user_id = ? ORDER BY dow').all(uid);
  /** the shift a pattern day stands for (a template's current times, else the day's own) */
  function resolve(p) {
    const t = p.template_id ? templateOf(p.template_id) : null;
    return t ? { start: t.start, finish: t.finish, break_min: t.break_min, role: p.role || t.role || '', template_id: t.id } : { start: p.start, finish: p.finish, break_min: p.break_min, role: p.role || '', template_id: null };
  }
  function cleanDay(d) {
    const day = +d.dow; if (!(day >= 0 && day <= 6) || String(d.dow).trim() === '') bad('Choose the day of the week.');
    const t = d.template_id ? templateOf(d.template_id) : null;
    if (d.template_id && !t) bad('That shift template is no longer there.');
    const v = t ? { start: t.start, finish: t.finish, break_min: t.break_min, role: str(d.role, 40) || t.role || '' } : { start: d.start, finish: d.finish, break_min: Math.round(+d.break_min || 0), role: str(d.role, 40) };
    if (!isTime(v.start) || !isTime(v.finish) || v.start === v.finish) bad(`${DOW[day]}: enter the start and finish times.`);
    if (v.break_min < 0 || v.break_min >= spanMin(v.start, v.finish)) bad(`${DOW[day]}: the break is as long as the shift.`);
    return { dow: day, template_id: t ? t.id : null, ...v };
  }
  function savePattern(req, uid, days) {
    const u = db.prepare('SELECT id, name, active FROM users WHERE id = ?').get(+uid);
    if (!u) bad('Choose the person.');
    if (!inScope(req.user, 'timesheets', u.id, 2)) throw new HttpError(403, `${u.name} isn't in your team.`);
    const list = (Array.isArray(days) ? days : []).filter(d => d && (d.template_id || d.start)).map(cleanDay);
    if (new Set(list.map(d => d.dow)).size !== list.length) bad(`${u.name}: one shift per day in the usual week.`);
    db.prepare('DELETE FROM roster_patterns WHERE user_id = ?').run(u.id);
    const p = db.prepare('INSERT INTO roster_patterns(user_id, dow, template_id, start, finish, break_min, role) VALUES(?,?,?,?,?,?,?)');
    for (const d of list) p.run(u.id, d.dow, d.template_id, d.start, d.finish, d.break_min, d.role);
    return { user_id: u.id, name: u.name, days: list.length };
  }
  app.get('/api/staff/roster/patterns', requireArea('timesheets', 1), wrap((req, res) => {
    const [a, b] = weekOf(req.query.week);
    res.json({ people: peopleFor(req, a, b).filter(p => p.active).map(p => ({ id: p.id, name: p.name, position: p.position || '', usual: patternsOf(p.id) })), templates: templates() });
  }));
  // { people: [{ user_id, days: [{ dow, template_id } or { dow, start, finish, break_min, role }] }] }: each person's usual week, replaced
  app.put('/api/staff/roster/patterns', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const list = Array.isArray(req.body && req.body.people) ? req.body.people : [];
    if (!list.length) bad('Choose the people.');
    const saved = atomic(() => list.slice(0, 500).map(p => savePattern(req, p.user_id, p.days)));
    audit(req, 'Changed usual weeks', saved.map(s => `${s.name} (${plural(s.days, 'day')})`).join(', ')); changed();
    res.json({ ok: true, saved });
  }));
  // this week's shifts become each person's usual week (the first shift of each day)
  app.post('/api/staff/roster/patterns/from-week', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const [a, b] = weekOf(req.body.week), only = Array.isArray(req.body.user_ids) ? new Set(req.body.user_ids.map(Number)) : null;
    const people = peopleFor(req, a, b).filter(p => p.active && (!only || only.has(p.id)));
    const saved = atomic(() => people.map(p => {
      const rows = db.prepare('SELECT * FROM roster_shifts WHERE user_id = ? AND date BETWEEN ? AND ? AND deleted = 0 ORDER BY date, start').all(p.id, a, b);
      if (!rows.length) return null;
      const days = new Map(); for (const r of rows) if (!days.has(dow(r.date))) days.set(dow(r.date), { dow: dow(r.date), template_id: r.template_id && templateOf(r.template_id) ? r.template_id : null, start: r.start, finish: r.finish, break_min: r.break_min, role: r.role });
      // keep the shift's own times when it was changed after being made from a template
      for (const d of days.values()) if (d.template_id) { const t = templateOf(d.template_id); if (t.start !== d.start || t.finish !== d.finish || t.break_min !== d.break_min) d.template_id = null; }
      return savePattern(req, p.id, [...days.values()]);
    }).filter(Boolean));
    if (!saved.length) bad('Nobody has shifts this week to make into a usual week.');
    audit(req, 'Set usual weeks from the roster', `${weekLabel(a, b)}: ${saved.map(s => s.name).join(', ')}`); changed();
    res.json({ ok: true, saved });
  }));

  // ---- fill the week from usual weeks
  app.post('/api/staff/roster/fill-usual', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const b0 = req.body || {}, [a, b] = weekOf(b0.week), only = Array.isArray(b0.user_ids) && b0.user_ids.length ? new Set(b0.user_ids.map(Number)) : null;
    const replace = b0.replace === true, dry = b0.dry_run === true, lv = leaveStmt();
    const people = peopleFor(req, a, b).filter(p => !only || only.has(p.id));
    const out = atomic(() => {
      const J = journal(req), skipped = []; let usual = 0, same = 0;
      for (const p of people) {
        const pat = patternsOf(p.id); if (!pat.length) continue;
        usual++;
        const u = userOf(p.id);
        for (let i = 0; i < 7; i++) {
          const d = addDays(a, i), day = pat.find(x => x.dow === dow(d)); if (!day) continue;
          const v = resolve(day), w = why(u, d, lv);
          if (w) { skipped.push({ user_id: p.id, name: p.name, date: d, why: w }); continue; }
          const have = liveIn(p.id, d);
          if (have.length && !replace) { skipped.push({ user_id: p.id, name: p.name, date: d, why: have.some(r => r.start === v.start && r.finish === v.finish) ? 'already on the roster' : 'already has a shift' }); continue; }
          if (have.length === 1 && have[0].start === v.start && have[0].finish === v.finish && have[0].break_min === v.break_min && (have[0].role || '') === v.role) { same++; continue; }
          for (const r of have) J.remove(r);
          J.add({ ...v, user_id: p.id, date: d, note: '' });
        }
      }
      return { J, s: summary(J, { skipped, people: usual, unchanged: same, no_usual: people.filter(p => !patternsOf(p.id).length).map(p => p.name) }) };
    }, !dry);
    if (!dry && out.J.ops.length) {
      const label = `Filled ${weekLabel(a, b)} from usual weeks (${plural(out.s.added, 'shift')})`;
      out.s.undo = keepUndo(req, label, out.J, a);
      audit(req, 'Filled the roster from usual weeks', `${weekLabel(a, b)}: ${out.s.added} added${out.s.removed ? `, ${out.s.removed} replaced` : ''}, ${out.s.skipped.length} skipped`); changed();
    }
    res.json({ ok: true, dry_run: dry, week_start: a, ...out.s });
  }));

  // ---- select many cells, apply once: { cells: [{ user_id (null: open shift), date }], action: set | add | clear | role, shift: {…}, role }
  app.post('/api/staff/roster/bulk', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const b0 = req.body || {}, action = b0.action, dry = b0.dry_run === true, lv = leaveStmt();
    if (!['set', 'add', 'clear', 'role'].includes(action)) bad('Choose what to do with the selected days.');
    const seen = new Set(), cells = (Array.isArray(b0.cells) ? b0.cells : []).map(c => ({ user_id: c && +c.user_id > 0 ? +c.user_id : null, date: c && c.date }))
      .filter(c => isDate(c.date) && !seen.has(`${c.user_id}|${c.date}`) && seen.add(`${c.user_id}|${c.date}`));
    if (!cells.length) bad('Select the days first (click a day, or drag across several).');
    if (cells.length > 3000) bad('Select fewer days at once (3,000 at most).');
    for (const c of cells) if (!canTouch(req, c.user_id)) { const u = userOf(c.user_id); throw new HttpError(403, `${u ? u.name : 'That person'} isn't in your team.`); }
    let shift = null;
    if (action === 'set' || action === 'add') {
      const t = templateOf((b0.shift || {}).template_id), s0 = b0.shift || {};
      const base = t ? { start: t.start, finish: t.finish, break_min: t.break_min, role: s0.role != null && s0.role !== '' ? s0.role : t.role, template_id: t.id } : s0;
      shift = clean(req, { ...base, note: s0.note || '', date: cells[0].date, user_id: null });   // checks the times (the people are checked below)
    }
    const role = action === 'role' ? str(b0.role, 40) : null;
    const out = atomic(() => {
      const J = journal(req), skipped = []; const users = new Map(), u = id => { if (!users.has(id)) users.set(id, userOf(id)); return users.get(id); };
      for (const c of cells) {
        const have = liveIn(c.user_id, c.date), who = c.user_id ? (u(c.user_id) || {}).name : 'Open shift';
        if (action === 'clear') { for (const r of have) J.remove(r); continue; }
        if (action === 'role') { for (const r of have) if ((r.role || '') !== role) J.change(r, { role }); continue; }
        const w = c.user_id ? why(u(c.user_id), c.date, b0.include_leave === true ? null : lv) : '';
        if (w) { skipped.push({ user_id: c.user_id, name: who, date: c.date, why: w }); continue; }
        const v = { ...shift, user_id: c.user_id, date: c.date };
        if (action === 'add' || !have.length) { if (action === 'add' && have.some(r => r.start === v.start && r.finish === v.finish)) { skipped.push({ user_id: c.user_id, name: who, date: c.date, why: 'already on the roster' }); continue; } J.add(v); continue; }
        // set: the day's shift becomes this one (the first is changed, so staff see "changed"; any others come off)
        const [first, ...rest] = have;
        if (!(first.start === v.start && first.finish === v.finish && first.break_min === v.break_min && (first.role || '') === (v.role || '') && (first.template_id || null) === (v.template_id || null) && (!v.note || first.note === v.note)))
          J.change(first, { start: v.start, finish: v.finish, break_min: v.break_min, role: v.role, template_id: v.template_id, ...(v.note ? { note: v.note } : {}) });
        for (const r of rest) J.remove(r);
      }
      return { J, s: summary(J, { skipped, cells: cells.length }) };
    }, !dry);
    if (!dry && out.J.ops.length) {
      const t = shift && shift.template_id ? templateOf(shift.template_id) : null;
      const what = action === 'clear' ? `Cleared ${plural(out.s.removed, 'shift')}` : action === 'role' ? `Set the role to "${role || 'none'}" on ${plural(out.s.changed, 'shift')}`
        : `${t ? `${t.name} ` : ''}${t12(shift.start)}–${t12(shift.finish)} on ${plural(out.s.added + out.s.changed, 'day')}`;
      out.s.undo = keepUndo(req, what, out.J, weekOf(cells[0].date)[0]);
      audit(req, 'Changed the roster (selected days)', `${what}${out.s.skipped.length ? `, ${out.s.skipped.length} skipped` : ''}`); changed();
    }
    res.json({ ok: true, dry_run: dry, ...out.s });
  }));

  // ---- copy: last week into this week, or this week into the next weeks. People who have left, are on leave that day,
  // or already have the same shift are skipped. replace: the target week's shifts come off first.
  function copyWeek(req, J, fromA, toA, replace, skipped) {
    const src = db.prepare('SELECT * FROM roster_shifts WHERE date BETWEEN ? AND ? AND deleted = 0 ORDER BY date, start').all(fromA, addDays(fromA, 6)).filter(r => canTouch(req, r.user_id));
    if (replace) for (const r of db.prepare('SELECT * FROM roster_shifts WHERE date BETWEEN ? AND ? AND deleted = 0').all(toA, addDays(toA, 6))) if (canTouch(req, r.user_id)) J.remove(r);
    const lv = leaveStmt(), off = Math.round((Date.parse(toA) - Date.parse(fromA)) / 864e5);
    const same = db.prepare('SELECT 1 FROM roster_shifts WHERE user_id IS ? AND date = ? AND start = ? AND finish = ? AND deleted = 0 LIMIT 1');
    let n = 0;
    for (const r of src) {
      const d = addDays(r.date, off), u = r.user_id ? userOf(r.user_id) : null;
      const w = r.user_id && !u ? 'no longer working' : why(u, d, lv) || (same.get(r.user_id, d, r.start, r.finish) ? 'already on the roster' : '');
      if (w) { skipped.push({ user_id: r.user_id, name: u ? u.name : 'Open shift', date: d, why: w }); continue; }
      J.add({ user_id: r.user_id, date: d, start: r.start, finish: r.finish, break_min: r.break_min, role: r.role, note: r.note, template_id: r.template_id }); n++;
    }
    return { src: src.length, added: n };
  }
  app.post('/api/staff/roster/copy-week', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const [a, b] = weekOf(req.body.week), fa = addDays(a, -7), fb = addDays(a, -1);
    const out = atomic(() => {
      const J = journal(req), skipped = [], c = copyWeek(req, J, fa, a, req.body.replace === true, skipped);
      if (!c.src) bad(`There are no shifts in the week before (${weekLabel(fa, fb)}) to copy.`);
      return { J, s: summary(J, { skipped }) };
    });
    if (out.J.ops.length) {
      out.s.undo = keepUndo(req, `Copied last week into ${weekLabel(a, b)} (${plural(out.s.added, 'shift')})`, out.J, a);
      audit(req, 'Copied the roster', `${plural(out.s.added, 'shift')} from ${weekLabel(fa, fb)} into ${weekLabel(a, b)}${out.s.removed ? ` (${out.s.removed} taken off first)` : ''}`); changed();
    }
    res.json({ ok: true, ...out.s });
  }));
  app.post('/api/staff/roster/copy-weeks', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const [a, b] = weekOf(req.body.week), n = Math.round(+req.body.weeks || 0);
    if (!(n >= 1 && n <= 12)) bad('Copy to the next 1 to 12 weeks.');
    const out = atomic(() => {
      const J = journal(req), skipped = [], weeks = [];
      for (let k = 1; k <= n; k++) {
        const t = addDays(a, 7 * k), c = copyWeek(req, J, a, t, req.body.replace === true, skipped);
        if (!c.src) bad(`There are no shifts in ${weekLabel(a, b)} to copy.`);
        weeks.push({ week_start: t, label: weekLabel(t, addDays(t, 6)), added: c.added });
      }
      return { J, s: summary(J, { skipped, weeks }) };
    });
    if (out.J.ops.length) {
      const last = addDays(a, 7 * n);
      out.s.undo = keepUndo(req, `Copied ${weekLabel(a, b)} to the next ${plural(n, 'week')} (${plural(out.s.added, 'shift')})`, out.J, a);
      audit(req, 'Copied the roster to the next weeks', `${weekLabel(a, b)} into ${weekLabel(addDays(a, 7), addDays(last, 6))}: ${plural(out.s.added, 'shift')}${out.s.removed ? ` (${out.s.removed} taken off first)` : ''}`); changed();
    }
    res.json({ ok: true, ...out.s });
  }));

  // ---- import shifts from a CSV file (Excel: File → Save as → CSV). A preview first; then only the good lines are saved.
  const csv = { parse: parseCSV, date: parseDate, time: parseTime, brk: parseBreak };
  const HEAD = {
    name: /^(name|person|staff|employee|employee name|staff member|who)$/, empno: /^(emp\.? ?no\.?|employee ?(no\.?|number|#|id)|emp ?(number|#|id)|staff ?(no\.?|number|id))$/,
    date: /^(date|day|shift date)$/, start: /^(start|from|start time|begin|in)$/, finish: /^(finish|end|to|finish time|end time|out)$/,
    break: /^(break|break ?\(?min(ute)?s?\)?|unpaid break|break mins?)$/, role: /^(role|area|role ?\/ ?area|position|station)$/, note: /^(notes?|comment|comments)$/,
  };
  function importPlan(req, text, replace) {
    const rows = parseCSV(String(text || ''));
    if (!rows.length) bad('The file is empty. Use the template: one line per shift.');
    const head = rows[0].map(x => String(x).trim().toLowerCase().replace(/\s+/g, ' '));
    const col = Object.fromEntries(Object.entries(HEAD).map(([k, re]) => [k, head.findIndex(x => re.test(x))]));
    if (col.date < 0 || col.start < 0 || col.finish < 0 || (col.name < 0 && col.empno < 0)) bad('The first line must name the columns: Name (or Employee no.), Date, Start, Finish (and Break, Role, Note if you like). Download the template to see how.');
    const body = rows.slice(1).map((r, i) => ({ r, line: i + 2 })).filter(x => x.r.some(c => String(c).trim() !== ''));
    if (!body.length) bad('There are no shifts in the file, only the headings.');
    if (body.length > 2000) bad('That is more than 2,000 shifts. Split the file and import it in parts.');
    const all = db.prepare("SELECT id, name, active, COALESCE(employee_no, '') AS employee_no, COALESCE(aliases, '') AS aliases, COALESCE(end_date, '') AS end_date, COALESCE(start_date, '') AS start_date FROM users").all();
    const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const today = todayIn(getSettings().timezone), lv = leaveStmt();
    const same = db.prepare('SELECT 1 FROM roster_shifts WHERE user_id IS ? AND date = ? AND start = ? AND finish = ? AND deleted = 0 LIMIT 1');
    const g = (r, k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
    const inFile = new Set();
    const lines = body.map(({ r, line }) => {
      const L = { line, person: g(r, 'name') || g(r, 'empno'), user_id: null, name: '', date: '', start: '', finish: '', break_min: 0, role: g(r, 'role').slice(0, 40), note: g(r, 'note').slice(0, 200), errors: [], warnings: [] };
      // who: the employee no. first, then the full name, then other names (aliases), then a first name only one person has
      const nm = norm(g(r, 'name')), no = norm(g(r, 'empno'));
      let u = null;
      if (no) { u = all.find(x => norm(x.employee_no) === no); if (!u) L.errors.push(`No one has employee no. ${g(r, 'empno')}`); }
      else if (!nm || /^(open|open shift|nobody|-)$/.test(nm)) { L.name = 'Open shift'; }
      else {
        let m = all.filter(x => norm(x.name) === nm);
        if (!m.length) m = all.filter(x => x.aliases.split(',').map(norm).includes(nm));
        if (!m.length) { m = all.filter(x => norm(x.name).split(' ')[0] === nm); if (m.filter(x => x.active).length === 1) m = m.filter(x => x.active); if (m.length === 1) L.warnings.push(`"${g(r, 'name')}" matched to ${m[0].name}`); }
        if (m.length > 1) { const act = m.filter(x => x.active); if (act.length === 1) m = act; }
        if (m.length > 1) L.errors.push(`More than one person is called ${g(r, 'name')}: add their employee no.`);
        else if (!m.length) L.errors.push(`No staff member called ${g(r, 'name')}`);
        else u = m[0];
      }
      if (u) {
        L.user_id = u.id; L.name = u.name;
        if (!inScope(req.user, 'timesheets', u.id, 2)) { L.errors.push(`${u.name} isn't in your team`); u = null; }
      }
      // when
      const d = parseDate(g(r, 'date'), today), a = parseTime(g(r, 'start')), b = parseTime(g(r, 'finish'));
      if (!d) L.errors.push(g(r, 'date') ? `Date "${g(r, 'date')}" isn't a date (use 2026-11-30 or 30/11/2026)` : 'No date'); else L.date = d;
      if (!a) L.errors.push(g(r, 'start') ? `Start "${g(r, 'start')}" isn't a time (use 7:00, 07:00 or 7am)` : 'No start time'); else L.start = a;
      if (!b) L.errors.push(g(r, 'finish') ? `Finish "${g(r, 'finish')}" isn't a time` : 'No finish time'); else L.finish = b;
      if (a && b) {
        const span = spanMin(a, b), br = g(r, 'break') === '' ? null : parseBreak(g(r, 'break'));
        if (a === b) L.errors.push('The finish is the same as the start');
        else if (span > 16 * 60) L.errors.push('Longer than 16 hours');
        if (br === undefined) L.errors.push(`Break "${g(r, 'break')}" isn't a number of minutes`);
        else L.break_min = br == null ? 0 : br;
        if (br != null && br !== undefined && (br < 0 || br > 240 || br >= span)) L.errors.push('The break is longer than the shift (or over 240 minutes)');
        if (a !== b && b < a) L.warnings.push('Finishes the next morning');
      }
      if (u && L.date && !L.errors.length) {
        if (!u.active) L.errors.push(`${u.name} has left (no longer working)`);
        else if (u.end_date && u.end_date < L.date) L.errors.push(`${u.name} finished on ${dayLong(u.end_date)}`);
        else {
          if (u.start_date && u.start_date > L.date) L.warnings.push(`${u.name} starts on ${dayLong(u.start_date)}`);
          const l = lv.all(u.id, L.date, L.date)[0]; if (l) L.warnings.push(`On ${LEAVE[l.kind] || 'leave'} that day (already booked)`);
        }
      }
      if (!L.errors.length) {
        const key = `${L.user_id}|${L.date}|${L.start}|${L.finish}`;
        if (inFile.has(key)) L.skip = 'The same shift is in the file twice';
        else if (!replace && same.get(L.user_id, L.date, L.start, L.finish)) L.skip = 'Already on the roster';
        inFile.add(key);
      }
      L.status = L.errors.length ? 'error' : L.skip ? 'skip' : L.warnings.length ? 'warn' : 'ok';
      return L;
    });
    return lines;
  }
  function importRun(req, text, save, replace) {
    const lines = importPlan(req, text, replace), good = lines.filter(l => l.status === 'ok' || l.status === 'warn');
    const weeks = [...new Set(good.map(l => weekOf(l.date)[0]))].sort();
    const out = atomic(() => {
      const J = journal(req), skipped = [];
      if (replace) {
        // replace: each person's shifts on the days in the file come off first (only the people and days in the file)
        const days = new Set(good.map(l => `${l.user_id}|${l.date}`));
        for (const k of days) { const [u, d] = k.split('|'); for (const r of liveIn(u === 'null' ? null : +u, d)) J.remove(r); }
      }
      for (const l of good) { l.id = J.add({ user_id: l.user_id, date: l.date, start: l.start, finish: l.finish, break_min: l.break_min, role: l.role, note: l.note, template_id: null }); }
      const s = summary(J, { skipped });
      // the warnings a line will have on the roster (overlaps, long shifts, leave) go with the line in the preview
      for (const l of good) for (const w of s.warnings.filter(x => x.id === l.id)) if (!l.warnings.includes(w.text) && !/^On .* this day \(already booked\)$/.test(w.text)) { l.warnings.push(w.text); if (l.status === 'ok') l.status = 'warn'; }
      return { J, s };
    }, save);
    const counts = { lines: lines.length, ok: lines.filter(l => l.status === 'ok').length, warn: lines.filter(l => l.status === 'warn').length, skip: lines.filter(l => l.status === 'skip').length, error: lines.filter(l => l.status === 'error').length };
    for (const l of lines) delete l.id;
    return { out, lines, counts, weeks };
  }
  app.post('/api/staff/roster/import/preview', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const r = importRun(req, (req.body || {}).csv, false, (req.body || {}).replace === true);
    res.json({ ok: true, lines: r.lines, counts: r.counts, weeks: r.weeks.map(w => ({ week_start: w, label: weekLabel(w, addDays(w, 6)) })), removed: r.out.s.removed });
  }));
  app.post('/api/staff/roster/import', requireStaff, wrap((req, res) => {
    mustEdit(req);
    const r = importRun(req, (req.body || {}).csv, true, (req.body || {}).replace === true);
    if (!r.out.J.ops.length) bad('There are no shifts to save: fix the lines marked with a problem, or check the file.');
    const s = r.out.s;
    s.undo = keepUndo(req, `Imported ${plural(s.added, 'shift')}${r.weeks.length ? ` (${r.weeks.length === 1 ? weekLabel(r.weeks[0], addDays(r.weeks[0], 6)) : `${r.weeks.length} weeks`})` : ''}`, r.out.J, r.weeks[0]);
    audit(req, 'Imported roster shifts', `${plural(s.added, 'shift')} from a file${s.removed ? ` (${s.removed} replaced)` : ''}; ${r.counts.error} line${r.counts.error === 1 ? '' : 's'} with problems, ${r.counts.skip} skipped`); changed();
    res.json({ ok: true, ...s, counts: r.counts, weeks: r.weeks, skipped: r.lines.filter(l => l.status === 'error' || l.status === 'skip').map(l => ({ line: l.line, name: l.name || l.person, date: l.date, why: l.errors.concat(l.skip ? [l.skip] : []).join('; ') })) });
  }));
  // the template to fill in: the columns, and two example lines for people on the roster next week
  app.get('/api/staff/roster/import-template.csv', requireArea('timesheets', 2), wrap((req, res) => {
    const [a] = weekOf(addDays(todayIn(getSettings().timezone), 7)), people = peopleFor(req, a, addDays(a, 6)).filter(p => p.active).slice(0, 2);
    const q = v => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const t = templates()[0];
    const ex = people.length ? people.flatMap((p, i) => [0, 1].map(k => [p.name, p.employee_no, addDays(a, k + i * 2), t ? t.start : '09:00', t ? t.finish : '17:00', t ? t.break_min : 30, t ? t.role : '', k === 0 && i === 0 ? 'Example: delete these lines' : '']))
      : [['Ana Example', 'E001', a, '07:00', '15:00', 30, 'Cafe', 'Example: delete this line']];
    const body = [['Name', 'Employee no.', 'Date', 'Start', 'Finish', 'Break (min)', 'Role', 'Note'], ...ex].map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="roster-import-template.csv"').send('\ufeff' + body);
  }));

  // ---- what the planner's week carries (roster.js plannerWeek): templates, each person's usual week, the undo
  function weekExtras(req, people) {
    for (const p of people) p.usual = patternsOf(p.id).map(x => ({ ...x, ...resolve(x), dow: x.dow, template_id: x.template_id }));
    return { templates: templates(), colours: COLOURS, undo: undoOf(req.user.id), holidays: [] };
  }
  return { weekExtras, csv, templates };
};

// ------------------------------------------------------------------ reading CSV files (also used by the tests)
/** CSV text → rows of cells. Commas, semicolons (some Excel set-ups) or tabs; quoted cells with "" inside; a BOM is ignored. */
function parseCSV(text) {
  const s = String(text).replace(/^\ufeff/, '');
  const first = s.split(/\r?\n/, 1)[0] || '';
  const count = ch => { let n = 0, q = false; for (const c of first) { if (c === '"') q = !q; else if (!q && c === ch) n++; } return n; };
  const sep = [',', ';', '\t'].sort((x, y) => count(y) - count(x))[0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ymd = (y, m, d) => { const x = new Date(Date.UTC(y, m - 1, d)); return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? x.toISOString().slice(0, 10) : null; };
/** 2026-11-30, 30/11/2026, 30/11/26, 30-11-2026, 30 Nov 2026, Mon 30 Nov (this year), or an Excel date number → YYYY-MM-DD (day first, as in Fiji) */
function parseDate(v, today = new Date().toISOString().slice(0, 10)) {
  const s = String(v || '').trim(); let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  if ((m = s.match(/^(?:[a-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?,?(?:[\s-]+(\d{2}|\d{4}))?$/i))) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (mo < 0) return null;
    return ymd(m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +today.slice(0, 4), mo + 1, +m[1]);
  }
  if ((m = s.match(/^(\d{5})(?:\.\d+)?$/))) { const x = new Date(Date.UTC(1899, 11, 30) + +m[1] * 864e5); return x.toISOString().slice(0, 10); }
  return null;
}
/** 7, 7am, 7:30, 07:30, 7.30pm, 19:30, 0730, 7:30:00, an Excel time (0.3125) → HH:MM */
function parseTime(v) {
  const s = String(v || '').trim().toLowerCase().replace(/\s+/g, ''); let m;
  const hm = (h, mi) => (h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null);
  if ((m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?(a|p)\.?m?\.?$/))) { let h = +m[1]; if (h < 1 || h > 12) return null; h = (h % 12) + (m[3] === 'p' ? 12 : 0); return hm(h, +(m[2] || 0)); }
  if ((m = s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/))) return hm(+m[1], +m[2]);
  if ((m = s.match(/^(\d{1,2})$/))) return hm(+m[1], 0);
  if ((m = s.match(/^(\d{3,4})$/))) return hm(Math.floor(+m[1] / 100), +m[1] % 100);
  if ((m = s.match(/^0?\.\d+$/))) { const t = Math.round(parseFloat(s) * 1440); return hm(Math.floor(t / 60) % 24, t % 60); }
  return null;
}
/** 30, 30min, 30 mins, 0:30, 1h, 0.5h → minutes; '' → 0; not a break → undefined */
function parseBreak(v) {
  const s = String(v || '').trim().toLowerCase().replace(/\s+/g, ''); let m;
  if (s === '' || s === '-' || s === 'none') return 0;
  if ((m = s.match(/^(\d{1,3})(?:m|min|mins|minutes?)?$/))) return +m[1];
  if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) return +m[1] * 60 + +m[2];
  if ((m = s.match(/^(\d*\.?\d+)(?:h|hr|hrs|hours?)$/))) return Math.round(parseFloat(m[1]) * 60);
  return undefined;
}
module.exports.parseCSV = parseCSV; module.exports.parseDate = parseDate; module.exports.parseTime = parseTime; module.exports.parseBreak = parseBreak;
