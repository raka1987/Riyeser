// Wage history: bring in the monthly Excel wage reports (one workbook per month, one sheet per person,
// a row per week: hours, rate, bonus, gross, FNPF, PAYE, other deductions, net), check them, and keep them
// as pay history so payslips' year-to-date totals include pay made before this system.
const ExcelJS = require('exceljs');
const crypto = require('crypto');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// the value Excel shows in a cell (formulas: the saved result)
function val(cell) {
  let v = cell && cell.value;
  if (v && typeof v === 'object') {
    if ('result' in v) v = v.result;
    else if (v.richText) v = v.richText.map(t => t.text).join('');
    else if ('text' in v) v = v.text;
    else if (v instanceof Date) v = v.toISOString().slice(0, 10);
    else if ('error' in v) v = null;
  }
  return v === undefined ? null : v;
}
const num = v => { if (v === null || v === '') return 0; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const text = v => v === null || v === undefined ? '' : String(v).trim();

// month from the file name: "OCT_Wage_2026.xlsx", "July_Wage.xlsx" (no year: this year)
function monthFromName(name, year) {
  const n = String(name || '').toLowerCase();
  const m = Object.entries(MONTHS).find(([k]) => new RegExp(`(^|[^a-z])${k}`).test(n));
  const y = (n.match(/(20\d\d)/) || [])[1] || String(year);
  return m ? `${y}-${String(m[1]).padStart(2, '0')}` : '';
}

async function readWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { throw new Error("That file couldn't be read as an Excel workbook (.xlsx)."); }
  const sheets = [];
  wb.eachSheet(ws => {
    const info = {}, weeks = []; let ytd = null;
    ws.eachRow({ includeEmpty: false }, row => {
      const c = i => val(row.getCell(i));
      const label = norm(c(1));
      if (label.startsWith('employee name')) { info.name = text(c(4)); info.account_name = text(c(8)); }
      else if (label.startsWith('fnpf')) { info.fnpf_no = text(c(4)); info.bank_account = text(c(8)); }
      else if (label.startsWith('bank')) { info.bank_name = text(c(4)) || text(c(8)); }
      else if (label.startsWith('tin')) info.tin = text(c(4));
      else if (label.startsWith('hourly rate')) info.rate = num(c(4));
      else if (label.startsWith('date started')) info.start_date = text(c(4));
      const wk = /week\s*(\d)/i.exec(text(c(3)));
      if (wk) weeks.push({ week: +wk[1], row_name: text(c(4)), hours: num(c(5)), rate: num(c(6)), bonus: num(c(7)), gross: num(c(8)),
        fnpf: num(c(9)), paye: num(c(10)), other: num(c(11)), net: num(c(12)), comment: text(c(13)) });
      else if (norm(c(4)) === 'ytd') ytd = { gross: num(c(8)), fnpf: num(c(9)), net: num(c(12)) };
    });
    sheets.push({ sheet: ws.name.trim(), ...info, weeks, ytd });
  });
  return sheets;
}

module.exports = function wages(app, h) {
  const { db, requireRole, requireArea, must, audit, wrap, bad, str, getSettings, newClockPin, hashPassword } = h;

  const staff = () => db.prepare('SELECT id, name, aliases, fnpf_no, bank_account FROM users ORDER BY name').all();
  const namesOf = u => [u.name, ...String(u.aliases || '').split(',')].map(norm).filter(Boolean);
  function matchUser(list, ...names) {
    const want = names.map(norm).filter(Boolean);
    return list.find(u => namesOf(u).some(n => want.includes(n))) || null;
  }

  // Read the files and group the sheets by person (sheet name), with every check that needs a person to look at it.
  async function preview(files) {
    if (!Array.isArray(files) || !files.length) bad('Choose the wage report files (.xlsx).');
    if (files.length > 24) bad('Up to 24 files at a time.');
    const year = new Date().getFullYear(), months = [], groups = {}, problems = [];
    const seen = new Map(); // identical files sent twice
    for (const f of files) {
      const buf = Buffer.from(String(f.data || ''), 'base64');
      if (!buf.length) bad(`${f.name || 'A file'} is empty.`);
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      if (seen.has(hash)) { problems.push({ level: 'info', text: `${f.name} is the same file as ${seen.get(hash)}: counted once.` }); continue; }
      seen.set(hash, f.name);
      const month = /^\d{4}-\d{2}$/.test(f.month || '') ? f.month : monthFromName(f.name, year);
      if (!month) bad(`Which month is ${f.name}? Put the month in the file name (e.g. "Oct Wage 2026.xlsx").`);
      if (months.some(m => m.month === month)) bad(`Two files are for ${month} (${months.find(m => m.month === month).file} and ${f.name}). Send one file per month.`);
      let sheets; try { sheets = await readWorkbook(buf); } catch (e) { bad(`${f.name}: ${e.message}`); }
      months.push({ month, file: f.name, sheets: sheets.length });
      for (const s of sheets) {
        const key = norm(s.sheet) || norm(s.name);
        const g = groups[key] || (groups[key] = { key, sheet: s.sheet, months: [] });
        if (g.months.some(m => m.month === month)) { problems.push({ level: 'warn', person: key, text: `${f.name} has two sheets for "${s.sheet}". Only the first is used.` }); continue; }
        const weeks = s.weeks.filter(w => w.hours || w.gross || w.net);
        g.months.push({ month, file: f.name, ...s, weeks });
      }
    }
    if (!months.length) bad('No wage reports found in those files.');
    months.sort((a, b) => a.month.localeCompare(b.month));
    const users = staff();
    const fnpfPct = +getSettings().fnpf_employee_rate || 8;
    const out = Object.values(groups).map(g => {
      g.months.sort((a, b) => a.month.localeCompare(b.month));
      // the person's name: the full name most often on their sheets that includes the sheet name; otherwise the most common one
      const count = {}; for (const m of g.months) if (m.name) count[m.name.trim()] = (count[m.name.trim()] || 0) + 1;
      const first = norm(g.sheet).split(' ')[0];
      const names = Object.keys(count).sort((a, b) => count[b] - count[a] || b.length - a.length);
      const name = names.find(n => norm(n).split(' ').includes(first) || norm(n).startsWith(first)) || names[0] || g.sheet;
      const latest = [...g.months].reverse().find(m => norm(m.name) === norm(name)) || g.months[g.months.length - 1];
      const user = matchUser(users, g.sheet, name);
      const issues = [];
      const other = names.filter(n => n !== name);
      if (other.length) issues.push(`Different names on the sheets: ${names.map(n => `“${n}” (${g.months.filter(m => (m.name || '').trim() === n).map(m => m.month).join(', ')})`).join(', ')}.`);
      let weeks = 0, gross = 0, net = 0, hours = 0;
      for (const m of g.months) {
        const sumG = r2(m.weeks.reduce((a, w) => a + w.gross, 0));
        if (m.ytd && Math.abs(sumG - m.ytd.gross) > 0.01) {
          // which last weeks the sheet's total formula missed (their pay adds up to the difference)
          let acc = 0, left = []; for (const w of [...m.weeks].reverse()) { acc = r2(acc + w.gross); left.unshift(w.week); if (Math.abs(acc - r2(sumG - m.ytd.gross)) < 0.02) break; if (acc > sumG - m.ytd.gross + 0.02) { left = []; break; } }
          if (Math.abs(acc - r2(sumG - m.ytd.gross)) >= 0.02) left = [];
          issues.push(`${m.month}: the sheet's YTD total is ${m.ytd.gross.toFixed(2)} but the weeks add up to ${sumG.toFixed(2)}${left.length ? ` (the total formula leaves out week ${left.join(' & ')})` : ''}.`);
        }
        for (const w of m.weeks) {
          weeks++; gross += w.gross; net += w.net; hours += w.hours;
          if (w.hours && !w.rate) issues.push(`${m.month} week ${w.week}: ${w.hours} hours but rate 0, so nothing was paid.`);
          else if (Math.abs(w.hours * w.rate + w.bonus - w.gross) > 0.02) issues.push(`${m.month} week ${w.week}: ${w.hours} hrs × ${w.rate} ≠ gross ${w.gross.toFixed(2)}.`);
          if (w.gross && Math.abs(w.gross * fnpfPct / 100 - w.fnpf) > 0.02) issues.push(`${m.month} week ${w.week}: FNPF ${w.fnpf.toFixed(2)} isn't ${fnpfPct}% of gross.`);
        }
        const odd = [...new Set(m.weeks.map(w => w.row_name).filter(n => n && m.name && norm(n) !== norm(m.name) && !norm(m.name).includes(norm(n)) && !norm(n).includes(norm(m.name).split(' ')[0])))];
        if (odd.length) issues.push(`${m.month}: the week rows on ${g.sheet}'s sheet say “${odd.join('”, “')}” (copied from someone else's sheet?).`);
        if (m.account_name && m.name && norm(m.account_name) !== norm(m.name) && !norm(m.name).includes(norm(m.account_name)) && !norm(m.account_name).includes(norm(m.name).split(' ')[0]))
          issues.push(`${m.month}: bank account name is “${m.account_name}”, not ${m.name}.`);
      }
      const rates = [...new Set(g.months.flatMap(m => m.weeks.map(w => w.rate)).filter(Boolean))];
      const have = user ? db.prepare('SELECT month, COUNT(*) AS n FROM pay_history WHERE user_id = ? GROUP BY month').all(user.id).filter(x => g.months.some(m => m.month === x.month)) : [];
      return { key: g.key, sheet: g.sheet, name, user_id: user ? user.id : null, user_name: user ? user.name : '',
        details: { fnpf_no: latest.fnpf_no || '', bank_name: latest.bank_name || '', bank_account: latest.bank_account || '', bank_account_name: latest.account_name || '', tin: latest.tin || '' },
        rate: (([...g.months].reverse().find(m => m.weeks.length) || latest).weeks.slice(-1)[0] || {}).rate || latest.rate || 0,
        rates, months: g.months.map(m => ({ month: m.month, weeks: m.weeks.length, hours: r2(m.weeks.reduce((a, w) => a + w.hours, 0)), gross: r2(m.weeks.reduce((a, w) => a + w.gross, 0)), net: r2(m.weeks.reduce((a, w) => a + w.net, 0)), sheet_ytd: m.ytd ? m.ytd.gross : null })),
        totals: { weeks, hours: r2(hours), gross: r2(gross), net: r2(net) }, issues: [...new Set(issues)], already: have.map(x => x.month) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    // the same FNPF number or bank account on two different people
    for (const field of [['fnpf_no', 'FNPF number'], ['bank_account', 'bank account']]) {
      const by = {}; for (const p of out) { const v = norm(p.details[field[0]]); if (v) (by[v] = by[v] || []).push(p.name); }
      for (const [v, who] of Object.entries(by)) if (who.length > 1) problems.push({ level: 'warn', text: `Same ${field[1]} (${v.toUpperCase()}) on ${who.join(', ')}. Check each person's real ${field[1]} before paying.` });
    }
    const all = months.map(m => m.month), gaps = [];
    for (let i = 1; i < all.length; i++) { const [y, mo] = all[i - 1].split('-').map(Number), nx = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; if (nx !== all[i]) gaps.push(nx); }
    if (gaps.length) problems.push({ level: 'info', text: `No file for ${gaps.join(', ')}.` });
    return { months, people: out, problems, _groups: groups };
  }

  const fromBody = b => (Array.isArray(b.files) ? b.files : []).map(f => ({ name: str(f.name, 120), month: str(f.month, 7), data: String(f.data || '') }));
  app.post('/api/staff/import/wages/preview', requireArea('payroll', 2), wrap(async (req, res) => {
    must(req, 'employees', 2); must(req, 'pay_rates', 2);
    const p = await preview(fromBody(req.body || {}));
    delete p._groups; res.json({ ...p, staff: staff().map(u => ({ id: u.id, name: u.name })) });
  }));

  // Save: for each person (sheet name) → an existing staff member, a new staff record, another person in the files (same person), or skip.
  app.post('/api/staff/import/wages', requireArea('payroll', 2), wrap(async (req, res) => {
    must(req, 'employees', 2); must(req, 'pay_rates', 2);
    const b = req.body || {}, p = await preview(fromBody(b)), choice = b.people || {};
    const dest = {}; // group key → user id
    let created = 0, rows = 0, replaced = 0;
    const uname = n => { const base = norm(n).split(' ')[0] || 'staff'; let u = base, i = 2; while (db.prepare('SELECT 1 FROM users WHERE lower(username) = ?').get(u)) u = base + i++; return u; };
    const addAlias = (id, ...names) => { const u = db.prepare('SELECT name, aliases FROM users WHERE id = ?').get(id); const list = new Set(String(u.aliases || '').split(',').map(s => s.trim()).filter(Boolean));
      for (const n of names) if (n && norm(n) !== norm(u.name)) list.add(String(n).trim()); db.prepare('UPDATE users SET aliases = ? WHERE id = ?').run([...list].join(', ').slice(0, 500), id); };
    db.exec('BEGIN');
    try {
      const isSame = k => choice[k] && choice[k].action === 'same';
      const order = [...p.people].sort((x, y) => (isSame(x.key) ? 1 : 0) - (isSame(y.key) ? 1 : 0));
      for (const person of order) {
        const c = choice[person.key] || { action: person.user_id ? 'existing' : 'new' };
        if (c.action === 'skip') continue;
        let id = null;
        if (c.action === 'same') { id = dest[c.same_as]; if (!id) bad(`Choose who "${person.sheet}" is the same person as.`); }
        else if (c.action === 'existing') { id = +c.user_id || person.user_id; if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) bad(`Choose the staff member for "${person.sheet}".`); }
        else {
          const name = str(c.name, 120) || person.name, d = person.details;
          if (db.prepare('SELECT 1 FROM users WHERE lower(trim(name)) = lower(trim(?))').get(name)) bad(`${name} is already on Staff. For "${person.sheet}", choose "Someone on Staff".`);
          id = Number(db.prepare(`INSERT INTO users(name, username, password_hash, role, position, pay_type, pay_rate, fnpf_no, tin, bank_name, bank_account, bank_account_name, clock_pin, on_timeclock)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(name, uname(name), hashPassword(crypto.randomBytes(12).toString('base64url')), 'staff', '', 'hourly', person.rate || 0,
              d.fnpf_no, d.tin, d.bank_name, d.bank_account, d.bank_account_name, newClockPin()).lastInsertRowid);
          created++;
        }
        dest[person.key] = id;
        addAlias(id, person.sheet, person.name);
        // fill in details that are blank on the staff record (never overwrite what's already there)
        const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        for (const k of ['fnpf_no', 'tin', 'bank_name', 'bank_account', 'bank_account_name']) if (!u[k] && person.details[k]) db.prepare(`UPDATE users SET ${k} = ? WHERE id = ?`).run(person.details[k], id);
        if (!u.pay_rate && person.rate) db.prepare('UPDATE users SET pay_rate = ? WHERE id = ?').run(person.rate, id);
        const erPct = +getSettings().fnpf_employer_rate || 0, at = new Date().toISOString();
        for (const m of p._groups[person.key].months) for (const w of m.weeks) {
          const had = db.prepare('SELECT 1 FROM pay_history WHERE user_id = ? AND month = ? AND week = ?').get(id, m.month, w.week);
          if (had) replaced++;
          db.prepare(`INSERT INTO pay_history(user_id, month, week, hours, rate, bonus, gross, fnpf_employee, fnpf_employer, paye, other_deductions, net, comment, source, imported_by, imported_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, month, week) DO UPDATE SET hours = excluded.hours, rate = excluded.rate, bonus = excluded.bonus, gross = excluded.gross,
            fnpf_employee = excluded.fnpf_employee, fnpf_employer = excluded.fnpf_employer, paye = excluded.paye, other_deductions = excluded.other_deductions, net = excluded.net,
            comment = excluded.comment, source = excluded.source, imported_by = excluded.imported_by, imported_at = excluded.imported_at`)
            .run(id, m.month, w.week, r2(w.hours), w.rate, r2(w.bonus), r2(w.gross), r2(w.fnpf), r2(w.gross * erPct / 100), r2(w.paye), r2(w.other), r2(w.net), w.comment.slice(0, 200), `${m.file} · ${m.sheet}`, req.user.id, at);
          rows++;
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true, created, rows: rows - replaced, replaced, people: Object.keys(dest).length });
  }));

  // Pay history: per person per month (or one person's weeks)
  app.get('/api/staff/pay-history', requireArea('payroll'), wrap((req, res) => {
    const y = /^\d{4}$/.test(req.query.year || '') ? req.query.year : String(new Date().getFullYear());
    const w = ['substr(h.month, 1, 4) = ?'], prm = [y];
    if (req.query.user_id) { w.push('h.user_id = ?'); prm.push(+req.query.user_id); }
    const rows = db.prepare(`SELECT h.*, u.name FROM pay_history h JOIN users u ON u.id = h.user_id WHERE ${w.join(' AND ')} ORDER BY u.name, h.month, h.week`).all(...prm);
    const years = db.prepare('SELECT DISTINCT substr(month, 1, 4) AS y FROM pay_history ORDER BY y DESC').all().map(r => r.y);
    // money that left the bank for each person each month (Bank statements), to compare with the net on the wage reports
    let bank = []; try { bank = db.prepare(`SELECT user_id, substr(date, 1, 7) AS month, ROUND(SUM(amount), 2) AS paid, COUNT(*) AS n FROM bank_payments WHERE substr(date, 1, 4) = ? GROUP BY user_id, month`).all(y); } catch { }
    res.json({ year: y, years, rows, bank });
  }));
  app.delete('/api/staff/pay-history', requireArea('payroll', 3), wrap((req, res) => {
    const uid = +req.query.user_id, month = String(req.query.month || '');
    if (!uid || !/^\d{4}-\d{2}$/.test(month)) bad('Choose the person and month.');
    const removed = db.prepare('DELETE FROM pay_history WHERE user_id = ? AND month = ?').run(uid, month).changes;
    audit(req, 'Removed pay history', `${(db.prepare('SELECT name FROM users WHERE id = ?').get(uid) || {}).name}: ${month} (${removed} weeks)`);
    res.json({ removed });
  }));
};
module.exports.readWorkbook = readWorkbook;
module.exports.monthFromName = monthFromName;
