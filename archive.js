// Start again (Super admin): the whole Payroll goes back to a blank start, but nothing is ever deleted.
// First a complete copy of the records is saved as a locked (read-only) archive file, its fingerprint (SHA-256)
// is written to a log (archive/ledger.jsonl) that is only ever added to. Each log line also carries the
// fingerprint of the line before it, so a changed or removed line shows up when the archives are checked.
// There is deliberately no way here to delete an archive file or a log line.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function archive(app, h) {
  const { db, DATA_DIR, DEFAULT_SETTINGS, requireRole, rateLimit, audit, wrap, bad, str, verifyPassword, getSettings, setSetting } = h;
  const DIR = path.join(DATA_DIR, 'archive');
  const LEDGER = path.join(DIR, 'ledger.jsonl');
  const HEAD = 'archive_ledger_head';                 // fingerprint of the newest log line (catches a changed last line)
  const KEEP_SETTINGS = ['setup_done', 'last_backup', HEAD]; // internal settings that survive starting again
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  const fileSha = f => sha(fs.readFileSync(f));
  const confirmWord = () => { const n = String(getSettings().company_name || '').trim(); return n && n !== DEFAULT_SETTINGS.company_name ? n : 'START AGAIN'; };
  const lines = () => fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(l => l.length) : [];
  const stamp = d => d.toISOString().replace(/\.\d+Z$/, '').replace(/-|:/g, '').replace('T', '-'); // YYYYMMDD-HHMMSS (UTC)

  // a consistent copy of the live records, locked read-only
  function makeArchive() {
    fs.mkdirSync(DIR, { recursive: true });
    const now = new Date();
    let file = path.join(DIR, `payroll-${stamp(now)}.db`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(DIR, `payroll-${stamp(now)}-${i}.db`); // never overwrite
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); // one read of the whole database: safe while in use
    fs.chmodSync(file, 0o444);
    return { file, at: now };
  }
  function appendLedger(entry) {
    const prior = lines();
    const line = JSON.stringify({ ...entry, prev: prior.length ? sha(prior[prior.length - 1]) : 'genesis' });
    const fd = fs.openSync(LEDGER, 'a'); // append only: the log is never rewritten
    try { fs.writeSync(fd, line + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    setSetting(HEAD, sha(line));
    return line;
  }

  // back to a blank start, in one go; the acting Super admin keeps their own login
  function blankStart(userId) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
    const q = n => `"${n.replace(/"/g, '""')}"`;
    const keep = Object.fromEntries(KEEP_SETTINGS.map(k => [k, getSettings()[k]]).filter(([, v]) => v != null));
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('PRAGMA defer_foreign_keys = ON');
      for (const t of tables) if (!['users', 'settings', 'sessions'].includes(t)) db.exec(`DELETE FROM ${q(t)}`);
      db.prepare('DELETE FROM sessions WHERE user_id != ?').run(userId);
      db.prepare('DELETE FROM users WHERE id != ?').run(userId);
      // their login stays (name, username, password, access); their pay and bank details go with everything else
      db.prepare(`UPDATE users SET pay_rate = 0, tin = '', fnpf_no = '', bank_name = '', bank_account_name = '', bank_account = '', aliases = '',
        deductions = '[]', employee_no = '', supervisor_id = NULL, active = 1 WHERE id = ?`).run(userId);
      db.exec('DELETE FROM settings');
      for (const [k, v] of Object.entries({ ...DEFAULT_SETTINGS, ...keep })) setSetting(k, v);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) db.exec("DELETE FROM sqlite_sequence WHERE name != 'users'");
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { } throw e; }
  }

  // each log entry: is the file still there and unchanged, and is the log line as it was written?
  function check() {
    const L = lines(), head = getSettings()[HEAD] || '';
    const parsed = L.map(l => { try { const o = JSON.parse(l); return o && typeof o === 'object' ? o : null; } catch { return null; } });
    const entries = L.map((l, i) => {
      const e = parsed[i] || {};
      const next = i < L.length - 1 ? parsed[i + 1] : null;
      // the next line (or, for the newest line, the saved fingerprint) says what this line should be
      const expected = i < L.length - 1 ? (next ? next.prev : null) : head || null;
      const log_ok = !!parsed[i] && (expected == null || sha(l) === expected) && (i > 0 || e.prev === 'genesis');
      const name = path.basename(String(e.file || ''));
      const full = name && name === e.file ? path.join(DIR, name) : '';
      const exists = !!full && fs.existsSync(full);
      const now = exists ? fileSha(full) : '';
      const file_ok = exists && now === e.sha256;
      const status = !log_ok ? 'Log entry altered' : !exists ? 'File missing' : !file_ok ? 'File changed since it was archived' : 'Unchanged';
      return { n: i + 1, at: e.at || '', file: name, by: e.by || '', reason: e.reason || '', bytes: e.bytes || 0, sha256: e.sha256 || '', current_sha256: now, exists, file_ok, log_ok, ok: status === 'Unchanged', status };
    });
    return { checked_at: new Date().toISOString(), all_ok: entries.every(e => e.ok), chain_intact: entries.every(e => e.log_ok), entries };
  }

  app.get('/api/staff/archives', requireRole('admin'), wrap((req, res) => {
    const entries = lines().map((l, i) => { try { const e = JSON.parse(l); return { n: i + 1, at: e.at, file: e.file, by: e.by, reason: e.reason || '', bytes: e.bytes }; } catch { return { n: i + 1, at: '', file: '', by: '', reason: '', bytes: 0 }; } });
    res.json({ confirm_word: confirmWord(), folder: DIR, entries });
  }));
  app.get('/api/staff/archives/check', requireRole('admin'), wrap((req, res) => res.json(check())));

  app.post('/api/staff/start-again', rateLimit(10, 10 * 60 * 1000), requireRole('admin'), wrap((req, res) => {
    const b = req.body || {};
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!me || !verifyPassword(String(b.password || ''), me.password_hash)) bad('Your password is not right. Nothing was changed.');
    const word = confirmWord();
    if (String(b.confirm || '').trim() !== word) bad(`Type ${word} exactly to confirm. Nothing was changed.`);
    const reason = str(b.reason, 500);
    const { file, at } = makeArchive();
    const fp = fileSha(file), bytes = fs.statSync(file).size;
    appendLedger({ at: at.toISOString(), program: 'payroll', file: path.basename(file), sha256: fp, bytes, by: `${me.username} (${me.name})`, reason });
    blankStart(me.id);
    audit(req, 'Started again (blank start)', `Old records saved as ${path.basename(file)}, fingerprint SHA-256 ${fp}${reason ? `. Reason: ${reason}` : ''}`);
    res.json({ ok: true, file: path.basename(file), sha256: fp, bytes });
  }));
};
