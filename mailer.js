// Emails: timesheets, payslips and the daily / weekly timesheet reports. Sent through the company's own mailbox (SMTP),
// set up by a Super admin in Settings → Email. Nothing is sent until it's switched on; every email is logged (sent or failed).
// If the provider refuses for now (too many emails this hour) or can't be reached, the email waits in a queue and is sent again later.
const nodemailer = require('nodemailer');

module.exports = function mailer(app, h) {
  const { db, requireRole, wrap, bad, str, getSettings, setSetting } = h;
  db.exec(`CREATE TABLE IF NOT EXISTS app_secrets (key TEXT PRIMARY KEY, value TEXT)`);
  // emails the provider turned away for now (e.g. too many sent this hour): sent again later
  db.exec(`CREATE TABLE IF NOT EXISTS email_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, subject TEXT, html TEXT, kind TEXT, tries INTEGER DEFAULT 0, next_at INTEGER, last_error TEXT DEFAULT '')`);
  try { db.exec('ALTER TABLE email_queue ADD COLUMN attach TEXT'); } catch { /* already there */ } // attachments kept for the resend (M7)
  // M7: payslips already emailed for a pay period, so a second send asks first
  db.exec(`CREATE TABLE IF NOT EXISTS payslip_sent (user_id INTEGER NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (user_id, period_start, period_end))`);
  db.exec(`CREATE TABLE IF NOT EXISTS email_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, to_addr TEXT, subject TEXT, kind TEXT, status TEXT, error TEXT DEFAULT '')`);
  const secret = k => (db.prepare('SELECT value FROM app_secrets WHERE key = ?').get(k) || {}).value || '';
  const KEYS = ['email_enabled', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'email_from', 'email_from_name', 'email_club_copy', 'email_staff_ids', 'email_subs', 'report_time_daily', 'report_time_weekly', 'site_url'];
  const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function transport(s = getSettings()) {
    const port = +s.smtp_port || 587;
    return nodemailer.createTransport({ host: s.smtp_host, port, secure: s.smtp_secure === 'ssl' || (port === 465 && s.smtp_secure !== 'none'), ignoreTLS: s.smtp_secure === 'none',
      auth: s.smtp_user ? { user: s.smtp_user, pass: secret('smtp_pass') } : undefined, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
  }
  const log = (to, subject, kind, status, error = '') => db.prepare('INSERT INTO email_log(at, to_addr, subject, kind, status, error) VALUES(?,?,?,?,?,?)')
    .run(new Date().toISOString(), String(to).slice(0, 300), String(subject).slice(0, 200), kind, status, String(error || '').slice(0, 300));
  // send in the background: a slow or failing email never holds up the page
  const toAtt = a => (a || []).map(x => ({ filename: x.filename, content: Buffer.isBuffer(x.content) ? x.content : Buffer.from(x.content, 'base64'), contentType: x.contentType }));
  function send(to, subject, html, kind, { force = false, attachments = [] } = {}) {
    const s = getSettings();
    const list = [...new Set((Array.isArray(to) ? to : [to]).map(x => String(x || '').trim()).filter(isEmail))];
    if (!list.length) return Promise.resolve(false);
    if (!force && s.email_enabled !== '1') return Promise.resolve(false);
    if (!s.smtp_host || !isEmail(s.email_from)) { log(list.join(', '), subject, kind, 'failed', 'Email is not set up (Settings → Email)'); return Promise.resolve(false); }
    return transport(s).sendMail({ from: { name: s.email_from_name || s.company_name, address: s.email_from }, to: list.join(', '), subject, html: wrapHtml(html, s), replyTo: s.email || s.email_from, attachments: toAtt(attachments) })
      .then(() => { log(list.join(', '), subject, kind, 'sent'); return true; })
      .catch(e => {
        // over the provider's hourly limit, a temporary refusal, or the server can't be reached (S33): keep it and send it again later
        if (isLimit(e) || isConn(e) || (+e.responseCode >= 400 && +e.responseCode < 500)) {
          db.prepare('INSERT INTO email_queue(to_addr, subject, html, kind, tries, next_at, last_error, attach) VALUES(?,?,?,?,1,?,?,?)').run(list.join(', '), subject, html, kind, Date.now() + 15 * 60000, String(e.message).slice(0, 300),
            JSON.stringify(toAtt(attachments).map(x => ({ filename: x.filename, contentType: x.contentType, content: x.content.toString('base64') }))));
          log(list.join(', '), subject, kind, 'waiting', 'Will send again in 15 minutes: ' + friendly(e, s));
          if (force) throw Object.assign(new Error(friendly(e, s) + ' It has been saved and will send again automatically in 15 minutes.'), { queued: true });
          return false;
        }
        log(list.join(', '), subject, kind, 'failed', e.message); if (force) throw Object.assign(new Error(friendly(e, s)), { raw: e.message }); return false;
      });
  }
  const isLimit = e => /too many messages|rate limit|quota|try again later|exceeded/i.test(String(e && (e.response || e.message) || ''));
  const isConn = e => ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(e && e.code)
    || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|getaddrinfo|Greeting never received|Connection timeout/i.test(String(e && e.message || ''));
  // plain words for the person, not the raw SMTP / network error (that stays in the email log)
  const friendly = (e, s = getSettings()) => isLimit(e) ? "Your email provider's limit on emails per hour has been reached."
    : isConn(e) ? `Couldn't reach the email server (${s.smtp_host}:${+s.smtp_port || 587}). Check the internet connection and Settings → Email.`
    : +e.responseCode >= 500 && /recipient|mailbox|address|user unknown|5\.1\./i.test(String(e.response || e.message)) ? 'The email address was refused by the email server. Check it on the Staff record.'
    : +e.responseCode === 535 || /auth/i.test(String(e.message)) ? 'The email server refused the username or password (Settings → Email).'
    : `The email server refused the email (${String(e.response || e.message || e).slice(0, 120)}).`;
  // resend waiting emails every few minutes (up to 8 tries, about 2 hours)
  setInterval(() => {
    const s = getSettings(); if (!s.smtp_host || !isEmail(s.email_from)) return;
    const due = db.prepare('SELECT * FROM email_queue WHERE next_at <= ? ORDER BY id LIMIT 10').all(Date.now());
    for (const q of due) {
      db.prepare('UPDATE email_queue SET next_at = ? WHERE id = ?').run(Date.now() + 10 * 60000, q.id); // don't pick it twice
      transport(s).sendMail({ from: { name: s.email_from_name || s.company_name, address: s.email_from }, to: q.to_addr, subject: q.subject, html: wrapHtml(q.html, s), replyTo: s.email || s.email_from, attachments: toAtt((() => { try { return JSON.parse(q.attach || '[]'); } catch { return []; } })()) })
        .then(() => { db.prepare('DELETE FROM email_queue WHERE id = ?').run(q.id); log(q.to_addr, q.subject, q.kind, 'sent', q.tries ? `sent after ${q.tries} wait${q.tries > 1 ? 's' : ''}` : ''); })
        .catch(e => {
          if (q.tries >= 8) { db.prepare('DELETE FROM email_queue WHERE id = ?').run(q.id); log(q.to_addr, q.subject, q.kind, 'failed', 'Gave up after 8 tries: ' + e.message); return; }
          db.prepare('UPDATE email_queue SET tries = tries + 1, next_at = ?, last_error = ? WHERE id = ?').run(Date.now() + 15 * 60000, String(e.message).slice(0, 300), q.id);
        });
    }
  }, 3 * 60 * 1000).unref();
  const wrapHtml = (body, s) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b2b22">
    <div style="background:#12355b;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0"><b style="font-size:18px">${esc(s.company_name)}</b></div>
    <div style="border:1px solid #e3e0d6;border-top:0;padding:18px 20px;border-radius:0 0 10px 10px">${body}
    <p style="color:#777;font-size:12px;margin-top:22px">${esc(s.company_name)}${s.address ? ' · ' + esc(s.address) : ''}${s.phone ? ' · ' + esc(s.phone) : ''}</p></div></div>`;
  // M7: thousands separators, as on screen (FJ$1,500.00)
  const money = v => `${getSettings().currency === 'FJD' ? 'FJ$' : getSettings().currency + ' '}${(+v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const t12 = t => { const [hh, mm] = String(t || '0:0').split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}${hh < 12 ? 'am' : 'pm'}`; };
  const dLong = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const table = rows => `<table style="width:100%;border-collapse:collapse;margin:10px 0">${rows.filter(Boolean).map(([k, v]) => `<tr><td style="padding:6px 0;color:#666;width:40%">${k}</td><td style="padding:6px 0"><b>${v}</b></td></tr>`).join('')}</table>`;
  // Who gets what: email_subs = { club: ['timesheets'], '12': ['timesheets_daily'] } (club = the company copy address)
  const TYPES = ['timesheets_daily', 'timesheets'];
  const subsOf = (s = getSettings()) => {
    try { const v = JSON.parse(s.email_subs || ''); if (v && typeof v === 'object') return v; } catch { }
    return { club: ['timesheets'] };
  };
  const copyTo = (kind = 'timesheets') => {
    const s = getSettings(), subs = subsOf(s), out = [];
    if ((subs.club || []).includes(kind)) out.push(...String(s.email_club_copy || '').split(/[,;\s]+/));
    const ids = Object.keys(subs).filter(k => k !== 'club' && (subs[k] || []).includes(kind)).map(Number).filter(Boolean);
    if (ids.length) out.push(...db.prepare(`SELECT email FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(u => u.email));
    return [...new Set(out.filter(isEmail))];
  };

  // ---- reports
  const tz = () => getSettings().timezone || 'Pacific/Fiji';
  const localNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, wd: p.weekday }; };
  const addD = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  function timesheetReport(from, to) {
    let rules = []; try { rules = (JSON.parse(getSettings().payroll_breaks || '[]') || []).filter(r => +r.after_hours > 0 && +r.minutes > 0); } catch { }
    const hrs = t => t.clock_out ? Math.max(0, (Date.parse(t.clock_out + 'Z') - Date.parse(t.clock_in + 'Z')) / 36e5) : 0;
    const brk = t => { const h = hrs(t); const r = rules.filter(x => h > +x.after_hours).sort((a, b) => b.minutes - a.minutes)[0]; return r ? Math.min(h, r.minutes / 60) : 0; };
    const rows = db.prepare(`SELECT t.*, u.name FROM timesheets t JOIN users u ON u.id = t.user_id WHERE substr(t.clock_in,1,10) BETWEEN ? AND ? AND COALESCE(u.on_timeclock, 1) = 1 ORDER BY u.name, t.clock_in`).all(from, to);
    const per = {}; for (const t of rows) { const p = per[t.name] || (per[t.name] = { shifts: 0, h: 0, b: 0, open: 0 }); p.shifts++; p.h += hrs(t); p.b += brk(t); if (!t.clock_out) p.open++; }
    const f2 = n => n.toFixed(2);
    return { subject: `Timesheets: ${dLong(from)} – ${dLong(to)}`, html: `<h2 style="margin:0 0 6px">Weekly timesheets</h2><p style="color:#666;margin:0 0 10px">${dLong(from)} – ${dLong(to)}</p>
      ${Object.keys(per).length ? `<table style="width:100%;border-collapse:collapse"><tr style="text-align:left;color:#666"><th style="padding:4px 0">Staff</th><th>Shifts</th><th>Hours</th><th>Unpaid breaks</th><th>Paid hours</th></tr>
      ${Object.entries(per).map(([n, p]) => `<tr><td style="padding:5px 0;border-top:1px solid #eee"><b>${esc(n)}</b>${p.open ? ` <span style="color:#b3261e">(${p.open} not clocked out)</span>` : ''}</td><td style="border-top:1px solid #eee">${p.shifts}</td><td style="border-top:1px solid #eee">${f2(p.h)}</td><td style="border-top:1px solid #eee">${p.b ? '−' + f2(p.b) : '—'}</td><td style="border-top:1px solid #eee"><b>${f2(p.h - p.b)}</b></td></tr>`).join('')}</table>`
      : '<p>No shifts recorded.</p>'}` };
  }
  // Daily timesheets: every shift that day (in / out, hours, unpaid break, paid hours) and who is still clocked in
  function dailyTimesheetReport(day) {
    let rules = []; try { rules = (JSON.parse(getSettings().payroll_breaks || '[]') || []).filter(r => +r.after_hours > 0 && +r.minutes > 0); } catch { }
    const hrs = t => t.clock_out ? Math.max(0, (Date.parse(t.clock_out + 'Z') - Date.parse(t.clock_in + 'Z')) / 36e5) : 0;
    const brk = t => { const h = hrs(t); const r = rules.filter(x => h > +x.after_hours).sort((a, b) => b.minutes - a.minutes)[0]; return r ? Math.min(h, r.minutes / 60) : 0; };
    const rows = db.prepare(`SELECT t.*, u.name FROM timesheets t JOIN users u ON u.id = t.user_id WHERE substr(t.clock_in,1,10) = ? AND COALESCE(u.on_timeclock, 1) = 1 ORDER BY u.name, t.clock_in`).all(day);
    const td = 'style="padding:5px 0;border-top:1px solid #eee"', f2 = n => n.toFixed(2);
    const total = rows.reduce((a, t) => a + hrs(t) - brk(t), 0), open = rows.filter(t => !t.clock_out);
    return { subject: `Timesheets today: ${dLong(day)} — ${rows.length} shift${rows.length === 1 ? '' : 's'}`, html: `<h2 style="margin:0 0 6px">Daily timesheets</h2><p style="color:#666;margin:0 0 10px">${dLong(day)}</p>
      ${rows.length ? `<table style="width:100%;border-collapse:collapse"><tr style="text-align:left;color:#666"><th style="padding:4px 0">Staff</th><th>In</th><th>Out</th><th>Hours</th><th>Unpaid break</th><th>Paid hours</th></tr>
      ${rows.map(t => `<tr><td ${td}><b>${esc(t.name)}</b>${t.notes ? `<div style="color:#888;font-size:12px">${esc(t.notes)}</div>` : ''}</td><td ${td}>${t12(t.clock_in.slice(11, 16))}</td>
        <td ${td}>${t.clock_out ? t12(t.clock_out.slice(11, 16)) : '<b style="color:#b3261e">still clocked in</b>'}</td><td ${td}>${t.clock_out ? f2(hrs(t)) : '—'}</td><td ${td}>${brk(t) ? '−' + Math.round(brk(t) * 60) + ' min' : '—'}</td><td ${td}><b>${t.clock_out ? f2(hrs(t) - brk(t)) : '—'}</b></td></tr>`).join('')}
      <tr><td style="padding:8px 0;border-top:2px solid #333" colspan="5"><b>Total paid hours</b></td><td style="padding:8px 0;border-top:2px solid #333"><b>${f2(total)}</b></td></tr></table>
      ${open.length ? `<p style="color:#b3261e"><b>${open.length} still clocked in:</b> ${open.map(t => esc(t.name)).join(', ')}. Make sure they clock out.</p>` : ''}`
      : '<p>No shifts recorded today.</p>'}` };
  }
  const lastWeek = day => { const wd = new Date(day + 'T00:00:00Z').getUTCDay(); const mon = addD(day, -((wd + 6) % 7) - 7); return [mon, addD(mon, 6)]; };
  function sendReport(kind, { force = false, to = null } = {}) {
    const d = localNow().date;
    const r = kind === 'timesheets_daily' ? dailyTimesheetReport(d) : kind === 'timesheets' ? timesheetReport(...lastWeek(d)) : null;
    if (!r) return Promise.resolve(false);
    return send(to || copyTo(kind), r.subject, r.html, 'report-' + kind, { force });
  }
  // schedule: the day's timesheets at the daily time; last week's timesheets on Monday at the weekly time
  setInterval(() => {
    try {
      const s = getSettings(); if (s.email_enabled !== '1') return;
      const n = localNow();
      if (n.hm >= (s.report_time_daily || '18:30') && s.report_sent_daily !== n.date) { setSetting('report_sent_daily', n.date); sendReport('timesheets_daily'); }
      if (n.wd === 'Mon' && n.hm >= (s.report_time_weekly || '07:30') && s.report_sent_weekly !== n.date) { setSetting('report_sent_weekly', n.date); sendReport('timesheets'); }
    } catch (e) { console.warn('report schedule:', e.message); }
  }, 60 * 1000).unref();
  app.post('/api/staff/email/report', requireRole('admin'), wrap(async (req, res) => {
    const kind = ['timesheets_daily', 'timesheets'].includes(req.body.kind) ? req.body.kind : bad('Choose a report.');
    const to = copyTo(kind); if (!to.length) bad('Nobody is ticked for this report yet. Tick who gets it, Save, then send.');
    try { await sendReport(kind, { force: true }); } catch (e) { bad(`The report didn't send yet: ${e.message}`); }
    res.json({ ok: true, sent_to: to });
  }));

  function periodTimesheet(from, to, userId, { withPay = false } = {}) {
    let rules = []; try { rules = (JSON.parse(getSettings().payroll_breaks || '[]') || []).filter(r => +r.after_hours > 0 && +r.minutes > 0); } catch { }
    const hrs = t => t.clock_out ? Math.max(0, (Date.parse(t.clock_out + 'Z') - Date.parse(t.clock_in + 'Z')) / 36e5) : 0;
    const brk = t => { const h = hrs(t); const r = rules.filter(x => h > +x.after_hours).sort((a, b) => b.minutes - a.minutes)[0]; return r ? Math.min(h, r.minutes / 60) : 0; };
    const rows = db.prepare(`SELECT t.*, u.name FROM timesheets t JOIN users u ON u.id = t.user_id WHERE substr(t.clock_in,1,10) BETWEEN ? AND ? ${userId ? 'AND t.user_id = ?' : 'AND COALESCE(u.on_timeclock, 1) = 1'} ORDER BY u.name, t.clock_in`).all(...[from, to, ...(userId ? [userId] : [])]);
    const td = 'style="padding:5px 0;border-top:1px solid #eee"', f2 = n => n.toFixed(2), who = userId ? (rows[0] ? rows[0].name : (db.prepare('SELECT name FROM users WHERE id = ?').get(userId) || {}).name) : 'All staff';
    const per = {}; for (const t of rows) per[t.name] = (per[t.name] || 0) + hrs(t) - brk(t);
    return { rows: rows.length, subject: `Timesheet: ${who}, ${dLong(from)}${from !== to ? ' – ' + dLong(to) : ''}`, html: `<h2 style="margin:0 0 6px">Timesheet: ${esc(who)}</h2><p style="color:#666;margin:0 0 10px">${dLong(from)}${from !== to ? ' – ' + dLong(to) : ''}</p>
      ${rows.length ? `<table style="width:100%;border-collapse:collapse"><tr style="text-align:left;color:#666"><th style="padding:4px 0">Date</th>${userId ? '' : '<th>Staff</th>'}<th>In</th><th>Out</th><th>Hours</th><th>Unpaid break</th><th>Paid hours</th></tr>
      ${rows.map(t => `<tr><td ${td}>${new Date(t.clock_in.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</td>${userId ? '' : `<td ${td}><b>${esc(t.name)}</b></td>`}
        <td ${td}>${t12(t.clock_in.slice(11, 16))}</td><td ${td}>${t.clock_out ? t12(t.clock_out.slice(11, 16)) : '<b style="color:#b3261e">still clocked in</b>'}</td><td ${td}>${t.clock_out ? f2(hrs(t)) : '—'}</td>
        <td ${td}>${brk(t) ? '−' + Math.round(brk(t) * 60) + ' min' : '—'}</td><td ${td}><b>${t.clock_out ? f2(hrs(t) - brk(t)) : '—'}</b></td></tr>`).join('')}</table>
      ${weeklyHtml(rows, hrs, brk)}
      ${withPay ? payHtml(from, to, userId) : `<h3 style="margin:14px 0 4px;font-size:15px">Paid hours</h3>${table(Object.entries(per).map(([n, h]) => [esc(n), f2(h)]))}`}` : '<p>No shifts in this period.</p>'}` };
  }
  // week by week (from the pay day): each person's paid hours per day, days worked, the week's total, running total
  function weeklyHtml(rows, hrs, brk) {
    const s0 = getSettings(), startDay = /^\d{4}-\d{2}-\d{2}$/.test(s0.pay_cycle_start || '') && [26, 52].includes(+s0.pay_periods_per_year || 26) ? new Date(s0.pay_cycle_start + 'T00:00:00Z').getUTCDay() : 1;
    const wkOf = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - (x.getUTCDay() - startDay + 7) % 7); return x.toISOString().slice(0, 10); };
    const W = {};
    for (const t of rows) { if (!t.clock_out) continue; const d = t.clock_in.slice(0, 10), w = wkOf(d); const p = ((W[w] = W[w] || {})[t.name] = W[w][t.name] || {}); p[d] = (p[d] || 0) + hrs(t) - brk(t); }
    const keys = Object.keys(W).sort(); if (!keys.length) return '';
    const th = 'style="text-align:right;padding:4px 5px;font-weight:normal;color:#666"', td = 'style="text-align:right;padding:5px;border-top:1px solid #eee"';
    let run = 0;
    return `<h3 style="margin:16px 0 6px;font-size:15px">Days and hours worked (paid hours)</h3>` + keys.map(w => {
      const days = Array.from({ length: 7 }, (_, i) => addD(w, i)), people = Object.keys(W[w]).sort();
      const wt = people.reduce((a, n) => a + Object.values(W[w][n]).reduce((x, y) => x + y, 0), 0); run += wt;
      return `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:10px"><tr><th style="text-align:left;padding:4px 0">Week of ${new Date(w + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</th>
        ${days.map(d => `<th ${th}>${new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}<br>${+d.slice(8)}</th>`).join('')}<th ${th}>Days</th><th ${th}>Hours</th></tr>
        ${people.map(n => { const p = W[w][n], tot = Object.values(p).reduce((x, y) => x + y, 0);
          return `<tr><td style="padding:5px 0;border-top:1px solid #eee"><b>${esc(n)}</b></td>${days.map(d => `<td ${td}>${p[d] ? p[d].toFixed(2) : '—'}</td>`).join('')}<td ${td}>${Object.keys(p).length}</td><td ${td}><b>${tot.toFixed(2)}</b></td></tr>`; }).join('')}
        <tr><td colspan="8" style="padding:6px 0;border-top:2px solid #333;color:#666">Week total · running total</td><td style="text-align:right;padding:6px 5px;border-top:2px solid #333"></td><td style="text-align:right;padding:6px 5px;border-top:2px solid #333"><b>${wt.toFixed(2)}</b> · <b>${run.toFixed(2)}</b></td></tr></table>`;
    }).join('');
  }
  // pay for the period: paid hours × rate (or salary) = gross, less FNPF, PAYE and deductions = amount to pay
  // one section per pay period (week / fortnight) the dates fall in, headed with that pay period's dates
  function payHtml(from, to, userId) {
    const per = +getSettings().pay_periods_per_year || 26;
    const name = per === 52 ? 'Pay week' : per === 26 ? 'Pay fortnight' : per === 12 ? 'Pay month' : 'Pay period';
    const nice = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const next = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
    const out = [];
    for (let cs = from; cs <= to; ) {
      const [ps, pe] = app.locals.payPeriodOf ? app.locals.payPeriodOf(cs) : [from, to];
      const a = ps > from ? ps : from, b = pe < to ? pe : to;
      const sec = payTable(a, b, userId);
      if (sec) out.push(`<h3 style="margin:18px 0 2px;font-size:15px">${name}: ${nice(ps)} – ${nice(pe)}</h3>
        ${a !== ps || b !== pe ? `<p style="margin:0 0 6px;color:#b3261e;font-size:12px">Part of this ${name.toLowerCase().replace('pay ', '')} only: ${nice(a)} – ${nice(b)} is in the dates chosen. Choose “This pay period” or “Last pay period” for the full amount.</p>` : '<p style="margin:0 0 6px;color:#666;font-size:12px">Full pay period.</p>'}${sec}`);
      if (!app.locals.payPeriodOf) break; cs = next(pe);
    }
    return out.length ? out.join('') + '<p style="color:#888;font-size:11px">FNPF, PAYE and regular deductions are worked out per pay period from Payroll rules (a part period in proportion); the pay run is the final figure.</p>'
      : '<p style="color:#666">No pay for these dates (no paid hours, or no pay rate set under Staff).</p>';
  }
  function payTable(from, to, userId) {
    let lines = []; try { lines = (app.locals.computePayroll(from, to) || []).filter(l => !userId || l.user_id === userId); } catch { }
    if (!lines.length) return '';
    const th = 'style="text-align:right;padding:4px 6px"', tdr = 'style="text-align:right;padding:6px;border-top:1px solid #eee"', tdl = 'style="padding:6px 6px 6px 0;border-top:1px solid #eee"';
    const sum = k => lines.reduce((a, l) => a + (+l[k] || 0), 0);
    return `<table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="color:#666"><th style="text-align:left">Staff</th><th ${th}>Worked</th><th ${th}>Breaks</th><th ${th}>Paid hrs</th><th ${th}>Rate</th><th ${th}>Gross</th><th ${th}>FNPF</th><th ${th}>PAYE</th><th ${th}>Deductions</th><th ${th}>To pay</th></tr>
      ${lines.map(l => `<tr><td ${tdl}><b>${esc(l.employee_name)}</b>${(l.deduction_lines || []).length ? `<div style="color:#888;font-size:11px">${l.deduction_lines.map(d => `${esc(d.name)} ${money(d.amount)}`).join(', ')}</div>` : ''}</td>
        <td ${tdr}>${(+l.worked_hours || 0).toFixed(2)}</td><td ${tdr}>${l.break_hours ? '−' + (+l.break_hours).toFixed(2) : '—'}</td><td ${tdr}>${(+l.hours).toFixed(2)}</td>
        <td ${tdr}>${l.pay_type === 'salary' ? 'Salary' : money(l.pay_rate) + '/hr'}</td><td ${tdr}>${money(l.gross)}</td><td ${tdr}>−${money(l.fnpf_employee)}</td><td ${tdr}>−${money(l.paye)}</td>
        <td ${tdr}>${l.other_deductions ? '−' + money(l.other_deductions) : '—'}</td><td ${tdr}><b>${money(l.net)}</b></td></tr>`).join('')}
      ${lines.length > 1 ? `<tr><td style="padding:8px 0;border-top:2px solid #333"><b>Total</b></td><td ${th}></td><td ${th}></td><td style="text-align:right;padding:8px 6px;border-top:2px solid #333"><b>${sum('hours').toFixed(2)}</b></td><td></td><td style="text-align:right;padding:8px 6px;border-top:2px solid #333"><b>${money(sum('gross'))}</b></td><td style="text-align:right;padding:8px 6px;border-top:2px solid #333">−${money(sum('fnpf_employee'))}</td><td style="text-align:right;padding:8px 6px;border-top:2px solid #333">−${money(sum('paye'))}</td><td style="text-align:right;padding:8px 6px;border-top:2px solid #333">−${money(sum('other_deductions'))}</td><td style="text-align:right;padding:8px 6px;border-top:2px solid #333"><b>${money(sum('net'))}</b></td></tr>` : ''}</table>`;
  }
  // staff send a timesheet from the Timesheets page: to the people ticked for timesheets, plus a copy to themselves
  const admins = () => db.prepare("SELECT email FROM users WHERE active = 1 AND role = 'admin'").all().map(u => u.email).filter(isEmail);
  async function emailTimesheet({ from, to, userId, sender, withPay = false, toAdmin = false }) {
    const r = periodTimesheet(from, to, toAdmin ? null : userId, { withPay: withPay || toAdmin });
    const list = [...new Set([...copyTo('timesheets'), ...copyTo('timesheets_daily'), ...(toAdmin ? admins() : [])])];
    const me = !toAdmin && isEmail(sender && sender.email) ? sender.email : null; // all staff hours to admin: no copy to the sender
    if (toAdmin && !list.length) bad('No admin has an email on their record yet (Staff → the admin → Email).');
    if (!list.length && !me) bad('Nobody is set up to receive timesheets (Settings → Email → Who gets what), and you have no email on your record.');
    const s = getSettings(); if (!s.smtp_host || !isEmail(s.email_from)) bad('Email is not set up yet (Settings → Email).');
    const all = [...new Set([...list, ...(me ? [me] : [])])];
    await send(all, r.subject, `${sender ? `<p style="color:#666">Sent by ${esc(sender.name)}.</p>` : ''}${r.html}`, 'timesheet', { force: true });
    return { sent_to: all, copy_to_me: !!me, shifts: r.rows };
  }

  // payslips by email: one email per person with each pay period's payslip (DRAFT ones clearly marked)
  function payslipHtml(p) {
    let ded = []; try { ded = typeof p.deduction_lines === 'string' ? JSON.parse(p.deduction_lines || '[]') : (p.deduction_lines || []); } catch { }
    const s = getSettings(), r = 'style="text-align:right;padding:5px 0"', l = 'style="padding:5px 0"';
    return `<div style="border:1px solid #ddd;border-radius:8px;padding:16px;margin:0 0 16px">
      <h3 style="margin:0 0 2px">${esc(s.company_name)} — Payslip${p.status === 'draft' ? ' <span style="color:#b3261e">(DRAFT — not finalised)</span>' : ''}</h3>
      <p style="color:#666;margin:0 0 10px"><b>${esc(p.employee_name)}</b>${p.position ? ' · ' + esc(p.position) : ''}<br>Period: ${dLong(p.period_start)} – ${dLong(p.period_end)}${p.pay_date ? `<br>Pay date: ${dLong(p.pay_date)}` : ''}${p.part ? '<br><span style="color:#b3261e">Part of a pay period (in proportion)</span>' : ''}</p>
      <table style="width:100%;border-collapse:collapse">
        ${p.pay_type === 'hourly' && +p.break_hours ? `<tr><td ${l} style="color:#666">Hours worked ${(+p.worked_hours).toFixed(2)} − unpaid breaks ${(+p.break_hours).toFixed(2)}</td><td></td></tr>` : ''}
        <tr><td ${l}>${p.pay_type === 'hourly' ? `Paid hours ${(+p.hours).toFixed(2)} × ${money(p.pay_rate)}` : 'Salary'}</td><td ${r}>${money(p.base_pay)}</td></tr>
        ${+p.allowances ? `<tr><td ${l}>Allowances</td><td ${r}>${money(p.allowances)}</td></tr>` : ''}
        ${(typeof p.leave_lines === 'string' ? JSON.parse(p.leave_lines || '[]') : (p.leave_lines || [])).map(x => `<tr><td ${l}>${({ annual: 'Annual leave', sick: 'Sick leave', other: 'Other paid leave', payout: 'Unused annual leave paid out' })[x.kind] || 'Leave'} ${x.days} day${x.days === 1 ? '' : 's'}${x.late ? ` (earlier dates: ${esc((x.dates || []).join(', '))})` : ''}</td><td ${r}>${x.amount ? money(x.amount) : 'paid in salary'}</td></tr>`).join('')}
        <tr><td ${l}><b>Gross pay</b></td><td ${r}><b>${money(p.gross)}</b></td></tr>
        <tr><td ${l}>FNPF employee contribution</td><td ${r}>−${money(p.fnpf_employee)}</td></tr>
        <tr><td ${l}>PAYE tax</td><td ${r}>−${money(p.paye)}</td></tr>
        ${ded.length ? ded.map(d => `<tr><td ${l}>${esc(d.name)}</td><td ${r}>−${money(d.amount)}</td></tr>`).join('') : +p.other_deductions ? `<tr><td ${l}>Other deductions</td><td ${r}>−${money(p.other_deductions)}</td></tr>` : ''}
        <tr><td style="padding:8px 0;border-top:2px solid #333"><b>Net pay</b></td><td style="text-align:right;padding:8px 0;border-top:2px solid #333;font-size:18px"><b>${money(p.net)}</b></td></tr>
        <tr><td style="color:#666;font-size:12px">Employer FNPF contribution</td><td style="text-align:right;color:#666;font-size:12px">${money(p.fnpf_employer)}</td></tr>
      </table>
      ${p.ytd ? `<h4 style="margin:12px 0 4px">Year to date (${p.ytd.year})</h4><table style="width:100%;border-collapse:collapse;font-size:13px">
        ${[['Gross pay', money(p.ytd.gross)], ['PAYE tax', money(p.ytd.paye)], ['FNPF — employee', money(p.ytd.fnpf_employee)], ['FNPF — employer', money(p.ytd.fnpf_employer)], ['FNPF total', money(p.ytd.fnpf_total)],
          ['Deductions', money(p.ytd.deductions)], ['Net pay', money(p.ytd.net)], ['Paid hours', (+p.ytd.hours).toFixed(2)],
          ['Annual leave', `${p.ytd.annual_taken} taken · ${p.ytd.annual_left} left`], ['Sick leave', `${p.ytd.sick_taken} taken · ${p.ytd.sick_left} left`],
          ...(p.ytd.other_taken ? [['Other paid leave', `${p.ytd.other_taken} days`]] : []), ...(p.ytd.unpaid_taken ? [['Unpaid leave', `${p.ytd.unpaid_taken} days`]] : [])]
          .map(([k, v]) => `<tr><td style="padding:3px 0;border-top:1px solid #eee">${k}</td><td style="text-align:right;padding:3px 0;border-top:1px solid #eee">${v}</td></tr>`).join('')}</table>` : ''}
    </div>`;
  }
  // M7: the same payslip as a PDF page (attached to the email)
  const { pdf, payslipPage } = require('./pdf');
  function payslipPdfPage(p) {
    const s = getSettings(), J = v => { try { return typeof v === 'string' ? JSON.parse(v || '[]') : (v || []); } catch { return []; } };
    const ded = J(p.deduction_lines), lv = J(p.leave_lines), LV = { annual: 'Annual leave', sick: 'Sick leave', other: 'Other paid leave', payout: 'Unused annual leave paid out' };
    const rows = [
      ...(p.pay_type === 'hourly' && +p.break_hours ? [[`Hours worked ${(+p.worked_hours).toFixed(2)} - unpaid breaks ${(+p.break_hours).toFixed(2)}`, '']] : []),
      [p.pay_type === 'hourly' ? `Paid hours ${(+p.hours).toFixed(2)} x ${money(p.pay_rate)}` : 'Salary', money(p.base_pay)],
      ...(+p.allowances ? [['Allowances', money(p.allowances)]] : []),
      ...lv.map(x => [`${LV[x.kind] || 'Leave'} ${x.days} day${x.days === 1 ? '' : 's'}${x.late ? ` (earlier dates: ${(x.dates || []).join(', ')})` : ''}`, x.amount ? money(x.amount) : 'paid in salary']),
      Object.assign(['Gross pay', money(p.gross)], { bold: true }),
      ['FNPF employee contribution', '-' + money(p.fnpf_employee)], ['PAYE tax', '-' + money(p.paye)],
      ...(ded.length ? ded.map(d => [d.name, '-' + money(d.amount)]) : +p.other_deductions ? [['Other deductions', '-' + money(p.other_deductions)]] : []),
      Object.assign(['Net pay', money(p.net)], { bold: true, big: true, rule: true }),
      Object.assign(['Employer FNPF contribution', money(p.fnpf_employer)], { gray: true }),
      ...(p.ytd ? [{ heading: `Year to date (${p.ytd.year})` }, ['Gross pay', money(p.ytd.gross)], ['PAYE tax', money(p.ytd.paye)], ['FNPF total', money(p.ytd.fnpf_total)], ['Net pay', money(p.ytd.net)],
        ['Annual leave', `${p.ytd.annual_taken} taken, ${p.ytd.annual_left} left`], ['Sick leave', `${p.ytd.sick_taken} taken, ${p.ytd.sick_left} left`]] : [])];
    return payslipPage({ title: `${s.company_name} - Payslip${p.status === 'draft' ? ' (DRAFT - not finalised)' : ''}`, rows,
      lines: [s.address || '', `${p.employee_name}${p.position ? ' - ' + p.position : ''}`, `Period: ${dLong(p.period_start)} - ${dLong(p.period_end)}`, p.pay_date ? `Pay date: ${dLong(p.pay_date)}` : 'Not paid yet (draft)',
        `TIN: ${p.tin || '-'}   FNPF: ${p.fnpf_no || '-'}`].filter(Boolean) });
  }
  const payslipPdf = list => pdf(list.map(payslipPdfPage));
  async function emailPayslips(u, list) {
    const s = getSettings(); if (!s.smtp_host || !isEmail(s.email_from)) bad('Email is not set up yet (Settings → Email).');
    const a = list[0].period_start, b = list[list.length - 1].period_end;
    const file = `Payslip ${u.name.replace(/[\\/:*?"<>|]/g, '')} ${a}${a !== b ? ' to ' + b : ''}.pdf`;
    await send(u.email, `Payslip: ${u.name}, ${dLong(a)}${a !== b ? ' – ' + dLong(b) : ''}`, list.map(payslipHtml).join('') + '<p style="color:#666;font-size:12px">The payslip is also attached as a PDF.</p>', 'payslip',
      { force: true, attachments: [{ filename: file, content: payslipPdf(list), contentType: 'application/pdf' }] });
    const mark = db.prepare('INSERT INTO payslip_sent(user_id, period_start, period_end, at) VALUES(?,?,?,?) ON CONFLICT(user_id, period_start, period_end) DO UPDATE SET at = excluded.at');
    for (const p of list) mark.run(p.user_id, p.period_start, p.period_end, new Date().toISOString());
  }
  // who was already sent a payslip for these pay periods (M7: ask before sending again)
  const alreadySent = list => { const q = db.prepare('SELECT at FROM payslip_sent WHERE user_id = ? AND period_start = ? AND period_end = ?');
    return list.map(p => ({ p, r: q.get(p.user_id, p.period_start, p.period_end) })).filter(x => x.r).map(x => ({ user_id: x.p.user_id, name: x.p.employee_name, period_start: x.p.period_start, period_end: x.p.period_end, at: x.r.at })); };

  app.locals.mail = { emailTimesheet, emailPayslips, alreadySent, payslipPdf, timesheetHtml: (from, to, userId, o) => periodTimesheet(from, to, userId, o) };

  // ---- admin: email settings, test, recent emails
  app.get('/api/staff/email', requireRole('admin'), (req, res) => {
    const s = getSettings();
    res.json({ ...Object.fromEntries(KEYS.map(k => [k, s[k] ?? ''])), subs: subsOf(s), has_password: !!secret('smtp_pass'),
      staff: db.prepare("SELECT id, name, email, role FROM users WHERE active = 1 ORDER BY name").all(),
      log: db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 40').all(), waiting: db.prepare('SELECT COUNT(*) AS n FROM email_queue').get().n });
  });
  app.put('/api/staff/email', requireRole('admin'), wrap((req, res) => {
    const b = req.body || {};
    for (const k of KEYS) if (b[k] !== undefined) {
      let v = str(typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k], k === 'email_subs' ? 20000 : 300).trim();
      if (k === 'email_enabled') v = v === '1' || v === 'true' || b[k] === true ? '1' : '0';
      if (k === 'smtp_port' && v && !(+v > 0 && +v < 65536)) bad('Port must be a number, e.g. 587 or 465.');
      if (k === 'email_from' && v && !isEmail(v)) bad('"Send from" must be an email address.');
      if (k === 'email_club_copy' && v && !v.split(/[,;\s]+/).filter(Boolean).every(isEmail)) bad('Send a copy to: enter email addresses, separated by commas.');
      if ((k === 'report_time_daily' || k === 'report_time_weekly') && v && !/^\d{2}:\d{2}$/.test(v)) bad('Report times must be like 18:30.');
      if (k === 'email_subs') { let o; try { o = JSON.parse(v || '{}'); } catch { bad('Bad email choices.'); } v = JSON.stringify(Object.fromEntries(Object.entries(o || {}).map(([w, l]) => [w, (Array.isArray(l) ? l : []).filter(x => TYPES.includes(x))]))); }
      setSetting(k, v);
    }
    if (typeof b.smtp_pass === 'string' && b.smtp_pass) db.prepare('INSERT INTO app_secrets(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('smtp_pass', b.smtp_pass);
    if (getSettings().email_enabled === '1' && (!getSettings().smtp_host || !isEmail(getSettings().email_from))) setSetting('email_enabled', '0');
    res.json({ ok: true });
  }));
  app.post('/api/staff/email/test', requireRole('admin'), wrap(async (req, res) => {
    // one or more people: a list, or addresses separated by commas
    const to = [...new Set((Array.isArray(req.body.to) ? req.body.to : String(req.body.to || '').split(/[,;\s]+/)).map(x => String(x).trim()).filter(Boolean))].slice(0, 20);
    if (!to.length) bad('Choose who to send the test to.');
    const badOne = to.find(x => !isEmail(x)); if (badOne) bad(`"${badOne}" isn't an email address.`);
    const s = getSettings(); if (!s.smtp_host || !isEmail(s.email_from)) bad('Fill in the email host and "Send from" address first, and save.');
    try { await send(to, `Test email from ${s.company_name}`, '<p>✅ Emails are working. Timesheets and payslips will be sent from this address.</p>', 'test', { force: true }); }
    catch (e) { bad(isLimit(e) || /saved and will send again/.test(e.message) ? e.message : `The email didn't send: ${e.message}. Check the host, port, username and password.`); }
    res.json({ ok: true, sent_to: to });
  }));
};
