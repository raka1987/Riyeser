// Bank statements: find the wage payments ("Tomasi Pay 230.00", "<Company> pay Seru" …) in a bank statement,
// match each to a staff member (names, other names on Staff, near spellings), and keep them as bank payments so
// Pay history can show what actually left the bank next to the wage reports.
// Reads the CSV or Excel download from internet banking, or lines copied from a statement and pasted in.
const ExcelJS = require('exceljs');

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const money = s => { const n = Number(String(s ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
// letters OCR mixes up (I / l / 1, O / 0) count as the same when matching names
const ocr = s => String(s).replace(/[l1|]/g, 'i').replace(/0/g, 'o');
// words on statement lines that are never someone's name
const COMMON = new Set(['pay', 'wage', 'wages', 'salary', 'sal', 'payment', 'staff', 'the', 'and', 'for', 'transfer', 'trf', 'deposit', 'fee', 'cash']);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// "07 Nov", "07/11/2025", "2025-11-07", "7-Nov-25", Excel dates
function toDate(v, year) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim(); let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/.exec(s))) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if ((m = /^(\d{1,2})[\s\-]([A-Za-z]{3,4})[a-z]*[\s\-]?(\d{2,4})?$/.exec(s)) && MON[m[2].toLowerCase()]) {
    const y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(year);
    return `${y}-${String(MON[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}
// lines copied from a statement: "07 Nov  Elijah Pay  190.00  33,813.33" (debit then balance), a balance on the line before
// tells whether the amount went out or came in
function fromText(text, year) {
  const out = []; let bal = null;
  // every line with a balance is checked against the running balance: a number read wrongly (e.g. by OCR) shows up here
  out.check = { checked: 0, ok: 0, wrong: [] };
  const yr = (/Statement Begins\s+\d{1,2}\s+[A-Za-z]{3}\s+(\d{4})/i.exec(text) || [])[1] || year;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ').trim(); if (!line) continue;
    const m = /^(\d{1,2}\s+[A-Za-z]{3,4}(?:\s+\d{4})?|\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})\s+(.+?)\s+(-?[\d,]+\.\d{2})(?:\s+(-?[\d,]+\.\d{2}))?(?:\s+(-?[\d,]+\.\d{2}))?\s*$/.exec(line);
    if (!m) continue;
    const date = toDate(m[1], yr); if (!date) continue;
    const nums = [m[3], m[4], m[5]].filter(Boolean).map(money), desc = m[2].trim();
    if (/beginning balance|opening balance|ending balance|closing balance/i.test(desc)) { bal = nums[nums.length - 1]; continue; }
    let debit = null;
    if (nums.length >= 2) {
      const amt = nums[0], nb = nums[nums.length - 1];
      if (bal != null) { out.check.checked++; if (r2(bal - amt) === nb || r2(bal + amt) === nb) out.check.ok++; else out.check.wrong.push(`${m[1]} ${desc} ${m[3]}`); }
      debit = bal != null && r2(bal + amt) === nb ? null : amt; bal = nb; // money in (the balance went up by it) is skipped
    }
    else debit = nums[0] < 0 ? -nums[0] : nums[0];
    if (debit) out.push({ date, description: desc, amount: Math.abs(debit) });
  }
  return out;
}
// a table (CSV or Excel): find the date, description and money-out columns from the headings
function fromRows(rows, year) {
  const hi = rows.findIndex(r => r.some(c => /date/i.test(String(c ?? ''))) && r.some(c => /desc|narr|detail|particular|transaction|reference/i.test(String(c ?? ''))));
  if (hi < 0) return [];
  const h = rows[hi].map(c => norm(c));
  const col = re => h.findIndex(x => re.test(x));
  const cDate = col(/date/), cDesc = col(/desc|narr|detail|particular|transaction|reference/);
  const cDebit = col(/debit|withdraw|money out|paid out/), cAmt = col(/^amount$|amount/), cCredit = col(/credit|deposit|money in/);
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const date = toDate(r[cDate], year); if (!date) continue;
    const desc = String(r[cDesc] ?? '').trim(); if (!desc) continue;
    let amt = null;
    if (cDebit >= 0 && cDebit !== cCredit) amt = money(r[cDebit]);
    else if (cAmt >= 0) { const a = money(r[cAmt]); amt = a != null && a < 0 ? -a : null; }
    if (amt) out.push({ date, description: desc, amount: Math.abs(amt) });
  }
  return out;
}
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
async function readFile(f, year) {
  const buf = Buffer.from(String(f.data || ''), 'base64'), name = String(f.name || '').toLowerCase();
  if (name.endsWith('.pdf')) throw new Error(`${f.name}: PDF statements are read on this computer before they're sent. Refresh the page and choose the PDF again.`);
  if (name.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); const rows = [];
    wb.eachSheet(ws => ws.eachRow({ includeEmpty: false }, r => rows.push((r.values || []).slice(1).map(v => v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? '') : v))));
    return fromRows(rows, year);
  }
  const text = buf.toString('utf8');
  const t = fromRows(parseCsv(text), year);
  return t.length ? t : fromText(text, year);
}

module.exports = function bank(app, h) {
  const { db, requireRole, requireArea, audit, wrap, bad, str, isDate } = h;
  db.exec(`CREATE TABLE IF NOT EXISTS bank_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL, n INTEGER NOT NULL DEFAULT 1, source TEXT DEFAULT '', imported_by INTEGER, imported_at TEXT,
    UNIQUE (date, description, amount, n))`);

  // which staff member a statement line is for: their name or other names (exact), or a near spelling of a first name on a "pay" line
  // the company's own name on a line ("Example Co pay Seru", or a short form like "Examp pay") marks a wage payment, and isn't a staff name
  function companyWord() {
    const n = norm((db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get() || {}).value || ''), joined = n.replace(/ /g, '');
    const words = new Set(n.split(' ').filter(w => w.length >= 3 && !['ltd', 'limited', 'pte', 'inc', 'the', 'and', 'co'].includes(w)));
    return t => words.has(t) || (t.length >= 4 && joined.length >= 4 && joined.startsWith(t));
  }
  function matcher() {
    const isCo = companyWord();
    const people = db.prepare('SELECT id, name, aliases FROM users WHERE pay_rate > 0 OR id IN (SELECT user_id FROM pay_history) ORDER BY active DESC, name').all().map(u => {
      const words = new Set(), firsts = new Set(), full = [];
      for (const n of [u.name, ...String(u.aliases || '').split(',')]) { const k = norm(n); if (!k) continue; full.push(k); firsts.add(k.split(' ')[0]); k.split(' ').forEach(w => words.add(w)); }
      const ok = w => w.length >= 3 && !COMMON.has(w) && !isCo(w);
      // any part of the name matches exactly (people often go by a second name); near spellings only for first names
      return { id: u.id, name: u.name, words: [...words].filter(ok), firsts: [...firsts].filter(ok), full };
    });
    return desc => {
      const d = norm(desc), toks = d.split(' '), pay = /\b(pay|wage|wages|salary|sal)\b/.test(d) || toks.some(isCo);
      let best = null;
      for (const p of people) {
        let score = 0;
        if (p.full.some(f => f.includes(' ') && d.includes(f))) score = 3;
        else if (p.words.some(w => toks.includes(w))) score = 2;
        else if (pay && p.firsts.some(w => { const W = ocr(w); return w.length >= 4 && toks.some(t => { const T = ocr(t); return t.length >= 4 && T[0] === W[0] && lev(T, W) <= (w.length >= 6 ? 2 : 1); }); })) score = 1;
        if (score && (!best || score > best.score)) best = { ...p, score };
        else if (score && best && score === best.score) best.tie = true;
      }
      return { pay, user: best && !best.tie ? best : null, near: best && best.score === 1 };
    };
  }

  app.post('/api/staff/bank/preview', requireArea('payroll', 2), wrap(async (req, res) => {
    const b = req.body || {}, year = /^\d{4}$/.test(String(b.year || '')) ? +b.year : new Date().getFullYear();
    let lines = [];
    for (const f of (Array.isArray(b.files) ? b.files : []).slice(0, 12)) { try { lines.push(...(await readFile(f, year)).map(l => ({ ...l, source: str(f.name, 120) }))); } catch (e) { bad(e.message); } }
    // text pasted, or read from PDF statements on this computer (one entry per statement, so each running balance is checked on its own)
    const texts = [...(b.text ? [{ source: 'pasted', text: b.text }] : []), ...(Array.isArray(b.texts) ? b.texts.slice(0, 12) : [])];
    const check = { checked: 0, ok: 0, wrong: [] };
    for (const x of texts) {
      const t = fromText(String(x.text || '').slice(0, 400000), year);
      check.checked += t.check.checked; check.ok += t.check.ok; check.wrong.push(...t.check.wrong.slice(0, 20));
      lines.push(...t.map(l => ({ ...l, source: str(x.source, 120) || 'pasted' })));
    }
    if (!lines.length) bad("No transactions found. Choose the statement's CSV or Excel file, or paste the lines (date, description, amount, balance).");
    const match = matcher(), seen = {};
    const found = [];
    for (const l of lines.sort((x, y) => x.date.localeCompare(y.date))) {
      const k = `${l.date}|${l.description}|${l.amount}`; const n = seen[k] = (seen[k] || 0) + 1;
      const m = match(l.description); if (!m.pay && !m.user) continue;
      const had = db.prepare('SELECT user_id FROM bank_payments WHERE date = ? AND description = ? AND amount = ? AND n = ?').get(l.date, l.description, l.amount, n);
      found.push({ ...l, n, user_id: m.user ? m.user.id : null, user_name: m.user ? m.user.name : '', near: !!(m.user && m.near), pay_word: m.pay, already: !!had });
    }
    res.json({ lines: found, scanned: lines.length, check: check.checked ? check : null, staff: db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all() });
  }));

  // save the lines a person ticked: each to a staff member; a near spelling is remembered as one of their other names
  app.post('/api/staff/bank/save', requireArea('payroll', 2), wrap((req, res) => {
    const isCo = companyWord();
    const list = Array.isArray(req.body.lines) ? req.body.lines.slice(0, 2000) : [];
    let saved = 0, learned = 0; const at = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const l of list) {
        if (!l.user_id) continue;
        if (!isDate(l.date) || !(+l.amount > 0)) bad('A line has a bad date or amount.');
        const u = db.prepare('SELECT id, name, aliases FROM users WHERE id = ?').get(+l.user_id); if (!u) bad('Choose the staff member for each line.');
        const r = db.prepare(`INSERT INTO bank_payments(user_id, date, description, amount, n, source, imported_by, imported_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(date, description, amount, n) DO UPDATE SET user_id = excluded.user_id`).run(u.id, l.date, str(l.description, 200), r2(l.amount), Math.max(1, +l.n || 1), str(l.source, 120), req.user.id, at);
        saved += r.changes ? 1 : 0;
        // a misspelt first name on a pay line, assigned by hand: remember that spelling so next time it matches straight away
        const word = norm(l.description).split(' ').find(t => t.length >= 3 && !COMMON.has(t) && !isCo(t) && !/^\d/.test(t));
        const known = [u.name, ...String(u.aliases || '').split(',')].map(norm).flatMap(x => x.split(' '));
        if (l.remember && word && !known.includes(word)) { db.prepare('UPDATE users SET aliases = ? WHERE id = ?').run([u.aliases, word[0].toUpperCase() + word.slice(1)].filter(Boolean).join(', ').slice(0, 500), u.id); learned++; }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ saved, learned });
  }));

  app.get('/api/staff/bank/payments', requireArea('payroll'), wrap((req, res) => {
    const y = /^\d{4}$/.test(req.query.year || '') ? req.query.year : String(new Date().getFullYear());
    res.json({ year: y, years: db.prepare('SELECT DISTINCT substr(date, 1, 4) AS y FROM bank_payments ORDER BY y DESC').all().map(r => r.y),
      rows: db.prepare('SELECT b.*, u.name FROM bank_payments b JOIN users u ON u.id = b.user_id WHERE substr(b.date, 1, 4) = ? ORDER BY b.date, u.name').all(y) });
  }));
  app.delete('/api/staff/bank/payments/:id', requireArea('payroll', 3), (req, res) => { const b = db.prepare('SELECT b.*, u.name FROM bank_payments b LEFT JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(+req.params.id); db.prepare('DELETE FROM bank_payments WHERE id = ?').run(+req.params.id); if (b) audit(req, 'Removed a bank payment', `${b.name}: ${b.date} ${b.description} ${b.amount}`); res.json({ ok: true }); });
};
module.exports.fromText = fromText;
