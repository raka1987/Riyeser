// OWNER-PAYWEEK: "Start next pay week" and "Copy last week's hours" on the Pay runs screen.
//
// The next period starts the day after the last finalised normal pay run (not an extra run, not a final pay) and is as
// long as the business's pay frequency (Settings: weekly 7 days, fortnightly 14, twice a month / monthly to the end of
// that half-month / month). Pay frequency is one setting for the whole business in Payroll (there is no per-person one).
//
// Copying hours makes ordinary, unapproved timesheet entries (noted "copied from …") from the period before, moved on
// by the period's length: the same days and the same start and finish times. People who already have an entry that
// day, leave days, people who are switched off or finished, and dates already paid are skipped. Salaried staff need no
// hours. The entries show on Timesheets like any others (edit, approve, delete), and the pay run reads them as usual.
//
// OWNER-NEXTRUN (2.2.5): "Start next pay run" does it in one step: it opens the next period (as above) and, if the owner
// chooses (or Payroll rules say "always copy"), copies last period's hours into it as unapproved entries, with the same
// skips. Some businesses enter hours by hand, so "Start empty" is the other choice. The period it started is kept in
// the payroll_open_period setting, so a second click (or a second computer) opens the same period and copies nothing again.
module.exports = function payweek(app, h) {
  const { db, requireArea, wrap, bad, HttpError, isDate, isStamp, addDays, round2, getSettings, setSetting, todayIn, payPeriodOf, alreadyPaid, assertNoOverlap, inScope, audit, broadcast, levelOf } = h;
  const dayCount = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dm = d => `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]}`;
  /** "12–18 Nov 2026", "28 Nov–4 Dec 2026", "29 Dec 2026–4 Jan 2027" */
  const range = (a, b) => a.slice(0, 4) !== b.slice(0, 4) ? `${dm(a)} ${a.slice(0, 4)}–${dm(b)} ${b.slice(0, 4)}`
    : a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8)}–${dm(b)} ${b.slice(0, 4)}` : `${dm(a)}–${dm(b)} ${b.slice(0, 4)}`;
  const FREQ = { 52: 'weekly', 26: 'fortnightly', 24: 'twice a month', 12: 'monthly' };

  /** The period that starts on `start`, as long as the pay frequency. */
  function periodFrom(start, s = getSettings()) {
    const per = +s.pay_periods_per_year || 26;
    if (per === 52) return [start, addDays(start, 6)];
    if (per === 26) return [start, addDays(start, 13)];
    return [start, payPeriodOf(start, s)[1]];
  }
  const NORMAL = "COALESCE(extra_reason, '') = '' AND COALESCE(note, '') = ''";   // not an extra run (F11), not a final pay (S57)
  const lastRun = () => db.prepare(`SELECT id, period_start, period_end, pay_date FROM payroll_runs WHERE ${NORMAL} ORDER BY period_end DESC, id DESC LIMIT 1`).get() || null;
  const entriesIn = (a, b) => db.prepare('SELECT COUNT(*) AS n FROM timesheets t JOIN users u ON u.id = t.user_id WHERE u.active = 1 AND substr(t.clock_in, 1, 10) BETWEEN ? AND ?').get(a, b).n;
  const paidRun = (a, b) => db.prepare(`SELECT id, pay_date FROM payroll_runs WHERE ${NORMAL} AND period_start <= ? AND period_end >= ? ORDER BY id LIMIT 1`).get(b, a) || null;

  function nextPeriod() {
    const s = getSettings(), last = lastRun();
    let start, end;
    if (last) [start, end] = periodFrom(addDays(last.period_end, 1), s);
    else [start, end] = payPeriodOf(addDays(payPeriodOf(todayIn(s.timezone), s)[0], -1), s);   // no pay runs yet: the last finished period
    return { start, end, days: dayCount(start, end), frequency: FREQ[+s.pay_periods_per_year || 26] || '', last_run: last };
  }
  app.locals.nextPayPeriod = nextPeriod;

  /** The period "Start next pay run" last started, if it is still the next one to pay. */
  const openPeriod = (n = nextPeriod()) => { let o = null; try { o = JSON.parse(getSettings().payroll_open_period || 'null'); } catch { } return o && o.start === n.start && o.end === n.end ? o : null; };
  const copiedUnapproved = (a, b) => db.prepare("SELECT COUNT(*) AS n FROM timesheets t JOIN users u ON u.id = t.user_id WHERE u.active = 1 AND t.approved_by IS NULL AND t.notes LIKE 'copied from %' AND substr(t.clock_in, 1, 10) BETWEEN ? AND ?").get(a, b).n;
  const unapproved = (a, b) => db.prepare('SELECT COUNT(*) AS n FROM timesheets t JOIN users u ON u.id = t.user_id WHERE u.active = 1 AND t.approved_by IS NULL AND t.clock_out IS NOT NULL AND substr(t.clock_in, 1, 10) BETWEEN ? AND ?').get(a, b).n;

  app.get('/api/staff/payroll/next-period', requireArea('payroll', 2), wrap((req, res) => {
    const n = nextPeriod(), s = getSettings(), today = todayIn(s.timezone), o = openPeriod(n);
    // recent periods: the last few paid, then each one not paid yet up to today (at least the next one)
    const paid = db.prepare(`SELECT id, period_start, period_end, pay_date FROM payroll_runs WHERE ${NORMAL} ORDER BY period_end DESC, id DESC LIMIT 3`).all().reverse()
      .map(r => ({ start: r.period_start, end: r.period_end, label: range(r.period_start, r.period_end), paid: true, run_id: r.id, pay_date: r.pay_date, entries: entriesIn(r.period_start, r.period_end) }));
    const open = [];
    for (let [a, b] = [n.start, n.end]; open.length < 6 && (open.length === 0 || a <= today); [a, b] = periodFrom(addDays(b, 1), s)) {
      const r = paidRun(a, b);
      open.push({ start: a, end: b, label: range(a, b), paid: !!r, run_id: r ? r.id : null, entries: entriesIn(a, b), current: a <= today && today <= b });
    }
    // started: "Start next pay run" opened it, or it's over and has hours in it already (entered before 2.2.5, say)
    const entries = entriesIn(n.start, n.end);
    res.json({ ...n, label: range(n.start, n.end), periods: [...paid, ...open], started: !!o || (entries > 0 && n.end < today), open_period: o, entries,
      copied_unapproved: copiedUnapproved(n.start, n.end), unapproved: unapproved(n.start, n.end), new_payrun_hours: ['ask', 'copy', 'empty'].includes(s.new_payrun_hours) ? s.new_payrun_hours : 'ask' });
  }));

  // ---- Copy last week's hours
  function plan(start, end) {
    if (!isDate(start) || !isDate(end) || end < start) bad('Choose a valid pay period.');
    const len = dayCount(start, end);
    if (len > 31) bad('Choose one pay period (31 days at most) to copy hours into.');
    const from = addDays(start, -len), to = addDays(start, -1);
    const run = paidRun(start, end);
    if (run) throw new HttpError(409, `${range(start, end)} is already paid (pay run #${run.id}, paid ${run.pay_date}). Hours can't be copied into dates that are already paid.`, { already_paid: { run_id: run.id } });
    const people = [], salaried = [];
    const shiftsOf = db.prepare('SELECT * FROM timesheets WHERE user_id = ? AND clock_out IS NOT NULL AND substr(clock_in, 1, 10) BETWEEN ? AND ? ORDER BY clock_in');
    const daysWith = db.prepare('SELECT DISTINCT substr(clock_in, 1, 10) AS d FROM timesheets WHERE user_id = ? AND substr(clock_in, 1, 10) BETWEEN ? AND ?');
    const leaveOn = db.prepare('SELECT kind FROM staff_leave WHERE user_id = ? AND date_from <= ? AND date_to >= ? LIMIT 1');
    for (const u of db.prepare('SELECT id, name, pay_type, pay_rate, COALESCE(end_date, \'\') AS end_date FROM users WHERE active = 1 ORDER BY name').all()) {
      if (u.pay_type === 'salary') { if (u.pay_rate > 0) salaried.push({ user_id: u.id, name: u.name }); continue; }
      const src = shiftsOf.all(u.id, from, to); if (!src.length) continue;
      const has = new Set(daysWith.all(u.id, start, end).map(r => r.d));
      const personPaid = alreadyPaid(start, end, [u.id]);   // e.g. a final pay on these dates
      const rows = src.map(t => {
        const ci = addDays(t.clock_in.slice(0, 10), len) + t.clock_in.slice(10), co = addDays(t.clock_out.slice(0, 10), len) + t.clock_out.slice(10), d = ci.slice(0, 10);
        const leave = leaveOn.get(u.id, d, d);
        const skip = d > end ? 'after this period' : personPaid ? 'already paid for these dates' : u.end_date && u.end_date < d ? `finished on ${u.end_date}` : has.has(d) ? 'already has an entry that day' : leave ? `on ${leave.kind} leave` : '';
        return { date: d, clock_in: ci, clock_out: co, hours: round2((Date.parse(co + 'Z') - Date.parse(ci + 'Z')) / 36e5), from_date: t.clock_in.slice(0, 10), skip };
      });
      people.push({ user_id: u.id, name: u.name, rows, total: round2(rows.filter(r => !r.skip).reduce((a, r) => a + r.hours, 0)) });
    }
    return { start, end, from, to, from_label: range(from, to), label: range(start, end), people, salaried, entries: entriesIn(start, end), previous_entries: entriesIn(from, to) };
  }
  app.post('/api/staff/payroll/copy-hours/preview', requireArea('payroll', 2), requireArea('timesheets', 2), wrap((req, res) => {
    const b = req.body || {}, p = plan(b.period_start, b.period_end);
    p.people = p.people.filter(x => inScope(req.user, 'timesheets', x.user_id, 2));
    res.json(p);
  }));
  /** Save copied shifts (each checked against the plan again); one that fails comes back with the reason. */
  function insertCopies(req, p, list) {
    const ok = new Map(p.people.map(x => [x.user_id, x]));
    const note = `copied from ${p.from_label}`, results = [];
    const ins = db.prepare('INSERT INTO timesheets(user_id, clock_in, clock_out, notes) VALUES(?,?,?,?)');
    const dayTaken = db.prepare('SELECT 1 FROM timesheets WHERE user_id = ? AND substr(clock_in, 1, 10) = ? LIMIT 1');
    const leaveOn = db.prepare('SELECT 1 FROM staff_leave WHERE user_id = ? AND date_from <= ? AND date_to >= ? LIMIT 1');
    const added = new Set();   // several copied shifts on one day (a split shift) are fine
    list.forEach((x, i) => {
      try {
        const person = ok.get(+x.user_id);
        if (!person) bad('That person can\'t have hours copied (not on the list).');
        if (!inScope(req.user, 'timesheets', person.user_id, 2)) throw new HttpError(403, `${person.name} isn't in your team.`);
        if (!isStamp(x.clock_in) || !isStamp(x.clock_out) || x.clock_out <= x.clock_in) bad('Check the start and finish.');
        const d = x.clock_in.slice(0, 10);
        if (d < p.start || d > p.end) bad(`${d} isn't in ${p.label}.`);
        const hrs = (Date.parse(x.clock_out + 'Z') - Date.parse(x.clock_in + 'Z')) / 36e5;
        if (hrs > 16) bad('A shift can be 16 hours at most.');
        const planned = person.rows.find(r => r.date === d && !r.skip);
        if (!planned) bad(`${person.name} isn't copied on ${d} (${(person.rows.find(r => r.date === d) || {}).skip || 'no shift that day last period'}).`);
        if (dayTaken.get(person.user_id, d) && !added.has(`${person.user_id}:${d}`)) bad(`${person.name} already has an entry on ${d}.`);
        if (leaveOn.get(person.user_id, d, d)) bad(`${person.name} is on leave on ${d}.`);
        assertNoOverlap(person.user_id, x.clock_in, x.clock_out);
        ins.run(person.user_id, x.clock_in, x.clock_out, note); added.add(`${person.user_id}:${d}`);
        results.push({ i, ok: true, user_id: person.user_id });
      } catch (e) { results.push({ i, ok: false, error: e.message }); }
    });
    const saved = results.filter(r => r.ok).length;
    if (saved) { audit(req, 'Copied hours', `${saved} shift${saved === 1 ? '' : 's'} into ${p.label}, ${note}`); broadcast({ type: 'shift' }, true); }
    return { saved, failed: results.length - saved, results, note };
  }
  app.post('/api/staff/payroll/copy-hours', requireArea('payroll', 2), requireArea('timesheets', 2), wrap((req, res) => {
    const b = req.body || {}, p = plan(b.period_start, b.period_end);
    const list = Array.isArray(b.entries) ? b.entries.slice(0, 500) : [];
    if (!list.length) bad('Tick at least one shift to copy.');
    res.json(insertCopies(req, p, list));
  }));

  // ---- Start next pay run (one click): open the next period, and copy last period's hours or start empty
  app.post('/api/staff/payroll/next-run', requireArea('payroll', 2), wrap((req, res) => {
    const b = req.body || {}, s = getSettings(), n = nextPeriod(), label = range(n.start, n.end);
    const word = n.frequency === 'weekly' ? 'last week' : 'the last pay period';
    const was = openPeriod(n);
    if (was) return res.json({ ...n, label, mode: was.mode, already_started: true, copied_people: 0, copied_shifts: 0,
      message: `${label} is already started${was.mode === 'copy' ? ` (${was.copied_people || 0} people's hours were copied from ${word})` : ''}. Nothing was copied again.` });
    const setting = ['ask', 'copy', 'empty'].includes(s.new_payrun_hours) ? s.new_payrun_hours : 'ask';
    const mode = ['copy', 'empty'].includes(b.mode) ? b.mode : setting === 'ask' ? bad("Choose: copy last week's hours, or start empty.") : setting;
    if (mode === 'copy' && levelOf(req.user, 'timesheets') < 2) throw new HttpError(403, "Copying hours needs Add & edit access to Timesheets. Start empty instead, or ask an administrator.");
    let copied = { saved: 0, results: [] }, salaried = [];
    if (mode === 'copy') {
      const p = plan(n.start, n.end); salaried = p.salaried;
      const list = p.people.filter(x => inScope(req.user, 'timesheets', x.user_id, 2))
        .flatMap(x => x.rows.filter(r => !r.skip).map(r => ({ user_id: x.user_id, clock_in: r.clock_in, clock_out: r.clock_out })));
      if (list.length) copied = insertCopies(req, p, list);
    }
    const people = new Set(copied.results.filter(r => r.ok).map(r => r.user_id)).size;
    setSetting('payroll_open_period', JSON.stringify({ start: n.start, end: n.end, mode, copied_people: people, copied_shifts: copied.saved, at: new Date().toISOString(), by: req.user.id }));
    audit(req, 'Started a pay run', `${label}: ${mode === 'copy' ? `copied ${copied.saved} shift${copied.saved === 1 ? '' : 's'} for ${people} ${people === 1 ? 'person' : 'people'} from ${word}` : 'started empty'}`);
    const message = mode === 'empty' ? `${label} started with no hours. Enter each person's hours, or copy ${word}'s hours if they're the same.`
      : people ? `Copied ${people} ${people === 1 ? "person's" : "people's"} hours from ${word}. Check and change anything that's different.`
        : `Nothing to copy from ${word} (no hours then, or everyone already has hours). Enter the hours below.`;
    res.json({ ...n, label, mode, already_started: false, copied_people: people, copied_shifts: copied.saved, not_copied: copied.results.filter(r => !r.ok).map(r => r.error), salaried, message });
  }));
};
