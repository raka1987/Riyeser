// OWNER-LISTS (Payroll 2.3.2): what the lists' Year and Period filters mean, and which sort fields each person may use.
// Financial year: Settings → "Financial year starts" (MM-DD, default 01-01: Fiji's tax year is the calendar year).
// The screens sort and filter with public/listview.js; the server works out the dates (from the company's settings and
// pay periods) and the sort fields allowed (pay rate only with pay-rate access), and sorts the Staff list the same way.
const LV = require('./public/listview.js');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
// "MM-DD", a day every year has (29 February isn't: leap years only); anything else is 1 January
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const validFyStart = v => { const m = /^(\d{2})-(\d{2})$/.exec(String(v || '').trim()); return !!m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= MONTH_DAYS[+m[1] - 1]; };
const fyStart = v => (validFyStart(v) ? String(v).trim() : '01-01');
const fyStartLabel = s => { const [m, d] = fyStart(s).split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
const dayBefore = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
// the financial year starting in `year`: 1 Aug 2025 – 31 Jul 2026 is "FY 2025–26"; with a 1 January start just "FY 2025"
function financialYear(year, start = '01-01') {
  const s = fyStart(start), from = `${year}-${s}`, to = dayBefore(`${year + 1}-${s}`);
  return { key: `fy:${year}`, kind: 'fy', year, from, to, label: s === '01-01' ? `FY ${year}` : `FY ${year}–${String(year + 1).slice(2)}` };
}
// the financial year a date is in
function financialYearOf(date, start = '01-01') {
  const s = fyStart(start), y = +String(date).slice(0, 4);
  return financialYear(String(date).slice(5, 10) >= s ? y : y - 1, s);
}
const calendarYear = year => ({ key: `cy:${year}`, kind: 'cy', year, from: `${year}-01-01`, to: `${year}-12-31`, label: String(year) });
// "fy:2025" / "cy:2025" → the year, or null
function yearRange(key, start = '01-01') {
  const m = /^(fy|cy):(\d{4})$/.exec(String(key || '')); if (!m) return null;
  return m[1] === 'fy' ? financialYear(+m[2], start) : calendarYear(+m[2]);
}
// Year choices: from the earliest record's year to this one (or to the latest record's, e.g. a pay date next year),
// newest first: financial years, then calendar years (at most `max` of each)
function yearOptions(today, start = '01-01', earliest = null, max = 15, latest = null) {
  const s = fyStart(start), first = isDate(earliest) && earliest < today ? earliest : today, last = isDate(latest) && latest > today ? latest : today;
  const fy1 = financialYearOf(last, s).year, cy1 = +last.slice(0, 4);
  const fy0 = Math.max(financialYearOf(first, s).year, fy1 - max + 1), cy0 = Math.max(+first.slice(0, 4), cy1 - max + 1);
  const out = [];
  for (let y = fy1; y >= fy0; y--) out.push(financialYear(y, s));
  for (let y = cy1; y >= cy0; y--) out.push(calendarYear(y));
  return out;
}
// Period quick picks for a day: this / last pay period (the company's pay periods), this / last month, this / last financial year
function quickPeriods(today, start = '01-01', payPeriodOf = null) {
  const s = fyStart(start), first = today.slice(0, 8) + '01', lastEnd = dayBefore(first);
  const monthEnd = (() => { const d = new Date(first + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); })();
  const fy = financialYearOf(today, s), lfy = financialYear(fy.year - 1, s);
  const mon = (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const plus = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const p = { this_week: { from: mon, to: plus(mon, 6) }, last_week: { from: plus(mon, -7), to: plus(mon, -1) }, this_month: { from: first, to: monthEnd }, last_month: { from: lastEnd.slice(0, 8) + '01', to: lastEnd }, this_fy: { from: fy.from, to: fy.to, label: fy.label }, last_fy: { from: lfy.from, to: lfy.to, label: lfy.label } };
  if (payPeriodOf) { const [a, b] = payPeriodOf(today), [c, d] = payPeriodOf(dayBefore(a)); p.this_pay = { from: a, to: b }; p.last_pay = { from: c, to: d }; }
  return p;
}
// a request's ?year=fy:2025 or ?period=last_fy or ?from=&to= → { from, to } (or null: all dates)
function rangeFromQuery(q, today, start = '01-01', payPeriodOf = null) {
  const y = yearRange(q.year, start); if (y) return { from: y.from, to: y.to };
  const p = q.period && quickPeriods(today, start, payPeriodOf)[q.period]; if (p) return { from: p.from, to: p.to };
  if (isDate(q.from) && isDate(q.to) && q.from <= q.to) return { from: q.from, to: q.to };
  return null;
}

// ---- sort fields per list; `area`: the access needed to sort by it (sorting by pay would show who earns more)
const NAME = { type: 'text', get: r => r.name, then: 'last_name' }, LAST = { type: 'text', get: r => LV.nameKey(r.name, 'last') };
const SORTS = {
  employees: { name: NAME, last_name: LAST, employee_no: { type: 'text' }, position: { type: 'text' }, start_date: { type: 'date' }, pay_rate: { type: 'num', area: 'pay_rates' }, status: { type: 'num', get: r => (r.active ? 0 : 1) } },
  timesheets: { date: { type: 'date', get: r => r.clock_in }, name: NAME, last_name: LAST, employee_no: { type: 'text' }, hours: { type: 'num' }, paid_hours: { type: 'num' }, status: { type: 'text' } },
  payruns: { pay_date: { type: 'date' }, period_start: { type: 'date' }, employees: { type: 'num' }, total_gross: { type: 'num' }, total_net: { type: 'num' }, total_fnpf_employer: { type: 'num' }, status: { type: 'text' } },
  runslips: { name: { type: 'text', get: r => r.employee_name }, last_name: { type: 'text', get: r => LV.nameKey(r.employee_name, 'last') }, hours: { type: 'num' }, gross: { type: 'num' }, paye: { type: 'num' }, net: { type: 'num' }, pay_rate: { type: 'num', area: 'pay_rates' } },
  payslips: { pay_date: { type: 'date' }, period_start: { type: 'date' }, hours: { type: 'num' }, gross: { type: 'num' }, net: { type: 'num' } },
  leave: { date_from: { type: 'date' }, name: NAME, last_name: LAST, kind: { type: 'text' }, days: { type: 'num' } },
  balances: { name: NAME, last_name: LAST, annual_left: { type: 'num' }, sick_left: { type: 'num' }, annual_taken: { type: 'num' }, sick_taken: { type: 'num' } },
  audit: { at: { type: 'date' }, user_name: { type: 'text' }, action: { type: 'text' } },
  timeclock: { name: NAME, last_name: LAST, position: { type: 'text' }, on_shift: { type: 'num', get: r => (r.on_shift ? 0 : 1) } },
  roster: { name: NAME, last_name: LAST, employee_no: { type: 'text' }, position: { type: 'text' }, hours: { type: 'num' } },
};
// the sort fields a person may use, list by list (levelOf: area → their level)
function allowedSorts(levelOf) {
  return Object.fromEntries(Object.entries(SORTS).map(([list, f]) => [list, Object.keys(f).filter(k => !f[k].area || levelOf(f[k].area) >= 1)]));
}
// sort rows on the server; a field the person may not use (or doesn't exist) sorts by name instead
function sortFor(list, rows, key, dir, levelOf) {
  const f = SORTS[list] || {}, ok = allowedSorts(levelOf)[list] || [];
  const k = ok.includes(key) ? key : f.name ? 'name' : ok[0];
  return k ? LV.sortRows(rows, f, k, dir === 'desc' ? 'desc' : 'asc') : rows;
}

function register(app, { db, requireStaff, wrap, getSettings, todayIn, payPeriodOf, levelOf }) {
  // the Year / Period choices for this company and the sort fields this person may use
  app.get('/api/staff/lists/meta', requireStaff, wrap((req, res) => {
    const s = getSettings(), today = todayIn(s.timezone), start = fyStart(s.financial_year_start);
    const one = sql => { try { const r = db.prepare(sql).get(); return r && isDate(String(r.d || '').slice(0, 10)) ? String(r.d).slice(0, 10) : null; } catch { return null; } };
    const ends = fn => [one(`SELECT ${fn}(pay_date) AS d FROM payroll_runs`), one(`SELECT ${fn}(clock_in) AS d FROM timesheets`), one(`SELECT ${fn}(start_date) AS d FROM users WHERE start_date != ''`),
      one(`SELECT ${fn}(date_from) AS d FROM staff_leave`), one(`SELECT ${fn}(at) AS d FROM audit_log`)].filter(Boolean).sort();
    const earliest = ends('MIN')[0] || null, latest = ends('MAX').pop() || null;
    res.json({ today, fy_start: start, fy_start_label: fyStartLabel(start), current_fy: financialYearOf(today, start), years: yearOptions(today, start, earliest, 15, latest),
      periods: quickPeriods(today, start, payPeriodOf), sorts: allowedSorts(a => levelOf(req.user, a)) });
  }));
}

module.exports = { fyStart, validFyStart, fyStartLabel, financialYear, financialYearOf, calendarYear, yearRange, yearOptions, quickPeriods, rangeFromQuery, SORTS, allowedSorts, sortFor, register };
