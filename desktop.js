// Desktop program extras (the Windows app sets DESKTOP=1 and BACKUP_DIR): a first-run screen to create the
// Super admin login, and backups of the records file: one a day automatically (the last 30 kept), or on demand.
const fs = require('fs');
const path = require('path');

module.exports = function desktop(app, h) {
  const { db, requireRole, requireArea, wrap, bad, str, getSettings, setSetting, hashPassword } = h;
  const DESKTOP = process.env.DESKTOP === '1';
  const DIR = process.env.BACKUP_DIR || '';
  const KEEP = 30;

  const setupNeeded = () => DESKTOP && getSettings().setup_done !== '1';
  const list = () => {
    if (!DIR || !fs.existsSync(DIR)) return [];
    return fs.readdirSync(DIR).filter(f => /^(payroll|ark)-.*\.db$/.test(f)).map(f => { const st = fs.statSync(path.join(DIR, f)); return { file: f, size: st.size, at: st.mtime.toISOString() }; })
      .sort((a, b) => b.at.localeCompare(a.at));
  };
  // a complete, consistent copy of the records (safe while the program is in use)
  function backup(kind = 'manual') {
    if (!DIR) bad('Backups are only for the desktop program.');
    fs.mkdirSync(DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const file = path.join(DIR, `payroll-${kind === 'auto' ? 'daily' : 'manual'}-${stamp}.db`);
    if (fs.existsSync(file)) fs.rmSync(file);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    // keep the newest daily backups (manual ones are kept until someone deletes them)
    list().filter(b => /^(payroll|ark)-daily-/.test(b.file)).slice(KEEP).forEach(b => fs.rmSync(path.join(DIR, b.file), { force: true }));
    setSetting('last_backup', new Date().toISOString());
    return path.basename(file);
  }
  if (DIR) {
    const daily = () => { try { const last = getSettings().last_backup || ''; if (Date.now() - Date.parse(last || 0) > 20 * 36e5) backup('auto'); } catch (e) { console.warn('backup:', e.message); } };
    setTimeout(daily, 5000).unref(); setInterval(daily, 60 * 60 * 1000).unref();
  }
  app.locals.backup = backup;

  app.get('/api/public/setup', (req, res) => res.json({ setup_needed: setupNeeded(), desktop: DESKTOP }));
  // first run of the desktop program: the owner chooses the Super admin's name, username and password
  app.post('/api/public/setup', wrap((req, res) => {
    if (!setupNeeded()) bad('Already set up. Log in.');
    const b = req.body || {}, name = str(b.name, 80), username = str(b.username, 40).toLowerCase(), pw = String(b.password || '');
    if (!name || !/^[a-z0-9._-]{3,40}$/.test(username)) bad('Enter your name and a username (letters and numbers, at least 3).');
    if (pw.length < 8) bad('The password needs at least 8 characters.');
    if (pw !== String(b.password2 || '')) bad("The two passwords don't match.");
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    db.prepare('UPDATE users SET name = ?, username = ?, password_hash = ?, position = ? WHERE id = ?').run(name, username, hashPassword(pw), str(b.position, 60) || 'Director', admin.id);
    if (b.company_name) setSetting('company_name', str(b.company_name, 80));
    setSetting('setup_done', '1');
    res.json({ ok: true, username });
  }));
  app.get('/api/staff/backups', requireArea('setup', 2), (req, res) => res.json({ desktop: DESKTOP, folder: DIR, last: getSettings().last_backup || '', keep: KEEP, backups: list().slice(0, 60) }));
  app.post('/api/staff/backups', requireArea('setup', 2), wrap((req, res) => res.json({ file: backup('manual'), folder: DIR })));
};
