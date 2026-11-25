// "Forgot password?" on the Payroll sign-in screen. Two safe ways back in:
//
// 1. An emailed reset code (only when email sending is set up in Settings → Email): a 6-digit code for the person's
//    own email address, good once, for 15 minutes. At most 3 codes an hour per person, 5 wrong tries cancel the code,
//    and the answer is the same whether or not the username or email exists.
// 2. The business owner's Riyeser account (works without email): the owner signs in with their Riyeser email and
//    password (and the two-step code, when their account has one) against Riyeser Online (Supabase Auth, by REST,
//    as Riyeser Central does). Payroll then checks, as that person, that they are the 'owner' of the business this PC
//    is linked to (%APPDATA%\Riyeser\company.json, written by Central): their row in members for that workspace.
//    Only then can they choose a Super admin login and set its new password.
//
// There is deliberately no "local only" reset (no email, no Riyeser account): on a shared time-clock PC anyone could
// use it, and the business name it would ask for is printed on every payslip.
//
// After any reset: that person's other sessions are signed out and their wrong-PIN / password counters are cleared,
// and the audit trail records it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appDataDir } = require('./licence');

// Riyeser Online (Riyeser Link's Supabase project, the same one Central signs in to: website/team/config.js).
// Built in on purpose, not read from riyeser.com: this is what decides who may reset the Super admin's password.
// Both values are safe to publish (the publishable key only allows what the row rules allow).
const ONLINE = { url: 'https://goaugynxeatzqzifpoes.supabase.co', key: 'sb_publishable_-hYqz3gbSvsH-1rX_HLV4A_eSTp3XXL' };
const CODE_MINUTES = 15, CODES_PER_HOUR = 3, CODE_TRIES = 5, TICKET_MINUTES = 10;
const SENT = 'If that matches a person with an email address, we\'ve sent them a 6-digit code. It works once, for 15 minutes. Check the inbox (and the junk folder).';
const WRONG_CODE = 'That code isn\'t right, or it has expired. Check the newest email, or ask for a new code.';
const NOT_LINKED = 'This PC isn\'t linked to your business on Riyeser yet. Sign in to Riyeser Central on this PC first, then try again.';
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The business this PC is linked to (Central's company.json): { workspace_id, name } or null. */
function linkedBusiness(appData = appDataDir()) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(appData, 'Riyeser', 'company.json'), 'utf8'));
    return c && c.mode === 'online' && c.workspace_id ? { workspace_id: String(c.workspace_id), name: String(c.name || '') } : null;
  } catch { return null; }
}
/** Riyeser Online's address: built in. Tests (never the Windows program) can point it at a pretend one. */
function online(env = process.env) {
  if (env.DESKTOP !== '1' && env.RIYESER_ONLINE_URL) return { url: env.RIYESER_ONLINE_URL.replace(/\/+$/, ''), key: env.RIYESER_ONLINE_KEY || 'test' };
  return ONLINE;
}
/** The account's verified authenticator-app factor (as Central's online.js), or null. */
function mfaFactor(user) {
  const list = user && Array.isArray(user.factors) ? user.factors : [];
  return list.find(f => f && f.status === 'verified' && (f.factor_type === 'totp' || !f.factor_type) && f.id) || null;
}
/** The "aal" of a Supabase access token (aal1 = password only, aal2 = with the two-step code), or '' if unreadable. */
function aalOf(token) {
  try { return String(JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).aal || ''); } catch { return ''; }
}
function plain(status, body) {
  const m = (body && (body.msg || body.message || body.error_description || body.error)) || '';
  if (/invalid login|invalid_grant|invalid credentials/i.test(m)) return 'That email or password isn\'t right.';
  if (/email not confirmed/i.test(m)) return 'Please confirm your Riyeser account\'s email first (open the link we emailed you), then try again.';
  if (status === 429) return 'Too many tries. Wait a few minutes, then try again.';
  return status ? `Riyeser couldn't check that right now (error ${status}). Please try again.` : 'Can\'t reach Riyeser. Check the internet connection and try again.';
}

module.exports = function forgot(app, h) {
  const { db, hashPassword, audit, rateLimit, wrap, bad, HttpError, str, clearLockouts, getAppData = () => appDataDir() } = h;
  const mail = () => app.locals.mail || {};
  db.exec(`CREATE TABLE IF NOT EXISTS password_reset_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)`);

  // ---- the same for both ways: the new password, everyone signed out, counters cleared, an audit entry
  function newPassword(b) {
    const pw = String(b.password || '');
    if (pw.length < 8) bad('The new password needs at least 8 characters.');
    if (pw !== String(b.password2 || '')) bad('The two passwords don\'t match. Type the same new password twice.');
    return pw;
  }
  function setPassword(req, u, pw, by, action, details) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);   // signed out everywhere
    db.prepare('UPDATE password_reset_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(Date.now(), u.id);
    clearLockouts(u.id, req);
    audit({ user: { id: null, name: by } }, action, details);
  }

  const emailReady = () => typeof mail().ready === 'function' && mail().ready();
  const matching = who => {
    who = str(who, 200); if (!who) return [];
    return db.prepare("SELECT id, name, username, email, role FROM users WHERE active = 1 AND (lower(username) = lower(?) OR (coalesce(email, '') <> '' AND lower(trim(email)) = lower(?))) LIMIT 5").all(who, who);
  };

  // what the sign-in screen offers
  app.get('/api/auth/forgot', (req, res) => {
    const biz = linkedBusiness(getAppData());
    res.json({ email: !!emailReady(), owner_linked: !!biz, business: biz ? biz.name : '', not_linked: biz ? null : NOT_LINKED });
  });

  // ---------------------------------------------------------------- 1. an emailed code
  app.post('/api/auth/forgot/email', rateLimit(10, 60 * 60 * 1000), wrap((req, res) => {
    if (!emailReady()) bad('Email isn\'t set up in Payroll, so a code can\'t be sent. If you\'re the business owner, reset with your Riyeser account instead, or ask your Super admin.');
    const s = h.getSettings();
    for (const u of matching(req.body && req.body.who).filter(x => isEmail(x.email))) {
      const now = Date.now();
      const lastHour = db.prepare('SELECT COUNT(*) AS n FROM password_reset_codes WHERE user_id = ? AND created_at > ?').get(u.id, now - 3600e3).n;
      if (lastHour >= CODES_PER_HOUR) continue;   // the same answer: nobody learns about the limit or the person
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      db.prepare('UPDATE password_reset_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now, u.id);   // only the newest code works
      db.prepare('INSERT INTO password_reset_codes(user_id, code_hash, created_at, expires_at) VALUES(?,?,?,?)').run(u.id, sha(`${u.id}:${code}`), now, now + CODE_MINUTES * 60e3);
      // in the background: the answer takes the same time whoever was typed
      Promise.resolve(mail().send(u.email, `Your ${s.company_name || 'Payroll'} password reset code: ${code}`,
        `<p>Hello ${String(u.name).replace(/[&<>"]/g, '')},</p><p>Someone asked to reset the Riyeser Payroll password for the login <b>${String(u.username).replace(/[&<>"]/g, '')}</b>.</p>
         <p style="font-size:28px;letter-spacing:6px;font-weight:bold">${code}</p>
         <p>Type this code on the Payroll sign-in screen. It works once, for ${CODE_MINUTES} minutes.</p>
         <p>If you didn't ask for this, you can ignore this email: your password hasn't changed.</p>`, 'password_reset')).catch(() => { });
    }
    res.json({ ok: true, message: SENT });
  }));

  app.post('/api/auth/forgot/email/reset', rateLimit(20, 15 * 60 * 1000), wrap((req, res) => {
    const b = req.body || {}, who = str(b.who, 200).toLowerCase();
    const code = String(b.code || '').replace(/\s+/g, '');
    if (!who) bad('Type your username or email address.');
    if (!/^\d{6}$/.test(code)) bad('Type the 6-digit code from the email.');
    const pw = newPassword(b);
    const tries = h.failsOf('rw' + who);   // per username / email typed, whether or not it exists
    if (tries.length >= CODE_TRIES) throw new HttpError(429, 'Too many wrong codes. Wait 10 minutes, then ask for a new code.');
    const now = Date.now();
    for (const u of matching(who)) {
      const row = db.prepare('SELECT * FROM password_reset_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1').get(u.id, now);
      if (!row) continue;
      if (same(row.code_hash, sha(`${u.id}:${code}`))) {
        db.prepare('UPDATE password_reset_codes SET used_at = ? WHERE id = ?').run(now, row.id);
        setPassword(req, u, pw, u.name, 'Password reset with an emailed code', `${u.name} (${u.username}) reset their own password with a code emailed to them.`);
        return res.json({ ok: true, username: u.username, message: `Your password has been changed. Sign in as ${u.username} with the new password.` });
      }
      // per person too (typing their username, then their email, doesn't get more tries): 5 wrong and the code is cancelled
      const mine = h.failsOf('r' + u.id); mine.push(now);
      if (mine.length >= CODE_TRIES) db.prepare('UPDATE password_reset_codes SET used_at = ? WHERE id = ?').run(now, row.id);
    }
    tries.push(now);
    throw new HttpError(400, WRONG_CODE);
  }));

  // ---------------------------------------------------------------- 2. the business owner's Riyeser account
  const tickets = new Map();   // ticket -> { stage: 'code' | 'owner', email, uid, token, factorId, at, tries }
  const ticketOf = t => {
    const k = String(t || ''), x = tickets.get(k);
    if (!x || Date.now() - x.at > TICKET_MINUTES * 60e3) { tickets.delete(k); throw new HttpError(401, 'That took too long. Start again: sign in with your Riyeser account.'); }
    return x;
  };
  const newTicket = o => {
    for (const [k, v] of tickets) if (Date.now() - v.at > TICKET_MINUTES * 60e3) tickets.delete(k);
    if (tickets.size > 200) tickets.delete(tickets.keys().next().value);
    const t = crypto.randomBytes(24).toString('hex'); tickets.set(t, { ...o, at: Date.now(), tries: 0 }); return t;
  };
  async function call(pathname, { method = 'GET', body, token } = {}) {
    const c = online();
    const headers = { apikey: c.key, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    let r;
    try { r = await fetch(c.url + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) }); }
    catch { throw new HttpError(503, plain(0)); }
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) throw Object.assign(new HttpError(r.status === 400 || r.status === 401 || r.status === 422 ? 401 : r.status === 429 ? 429 : 503, plain(r.status, data)), { upstream: r.status });
    return data;
  }
  const admins = () => db.prepare("SELECT id, name, username FROM users WHERE active = 1 AND role = 'admin' ORDER BY id").all()
    .map((u, i) => ({ ...u, main: i === 0 }));
  // the check that matters: as that person, their row in members for the business this PC is linked to says 'owner'.
  // (The row rules only let a member read members of an active business, so a closed business finds no row.)
  async function confirmOwner(x, biz) {
    const rows = await call(`/rest/v1/members?select=role,workspace_id&workspace_id=eq.${encodeURIComponent(biz.workspace_id)}&user_id=eq.${encodeURIComponent(x.uid)}`, { token: x.token });
    const ok = Array.isArray(rows) && rows.some(r => r && r.role === 'owner' && String(r.workspace_id) === biz.workspace_id);
    if (!ok) throw new HttpError(403, `That Riyeser account isn't the owner of ${biz.name || 'the business this PC is linked to'}. Only the business owner can reset a Payroll password this way. Ask the owner, or your Super admin.`);
    x.stage = 'owner'; x.at = Date.now();
    return { ok: true, business: biz.name, admins: admins() };
  }
  const business = () => { const b = linkedBusiness(getAppData()); if (!b) throw new HttpError(409, NOT_LINKED); return b; };

  app.post('/api/auth/forgot/owner/start', rateLimit(10, 15 * 60 * 1000), wrap(async (req, res) => {
    const biz = business();   // before anything is sent to Riyeser
    const email = str(req.body && req.body.email, 200), password = String((req.body && req.body.password) || '');
    if (!isEmail(email) || !password) bad('Type the email and password of your Riyeser account (the one you sign in to Riyeser Central with).');
    const fails = h.failsOf('ro' + email.toLowerCase());
    if (fails.length >= 5) throw new HttpError(429, 'Too many tries for that account. Wait 10 minutes, then try again.');
    let r;
    try { r = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }); }
    catch (e) { if (e.status === 401) fails.push(Date.now()); throw e; }
    if (!r || !r.access_token || !r.user || !r.user.id) throw new HttpError(503, plain(500));
    const factor = mfaFactor(r.user);
    const x = { stage: factor ? 'code' : 'signed-in', email, uid: r.user.id, token: r.access_token, factorId: factor ? factor.id : null };
    if (factor) return res.json({ needs_code: true, ticket: newTicket(x) });
    const t = newTicket(x);
    res.json({ ticket: t, ...(await confirmOwner(tickets.get(t), biz)) });
  }));

  app.post('/api/auth/forgot/owner/code', rateLimit(20, 15 * 60 * 1000), wrap(async (req, res) => {
    const x = ticketOf(req.body && req.body.ticket), biz = business();
    if (x.stage !== 'code') bad('Start again: sign in with your Riyeser account.');
    const code = String((req.body && req.body.code) || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) bad('Type the 6-digit code from your authenticator app.');
    if (++x.tries > CODE_TRIES) { tickets.delete(req.body.ticket); throw new HttpError(429, 'Too many wrong codes. Start again in a few minutes.'); }
    const id = encodeURIComponent(x.factorId);
    const ch = await call(`/auth/v1/factors/${id}/challenge`, { method: 'POST', token: x.token, body: {} });
    let v;
    try { v = await call(`/auth/v1/factors/${id}/verify`, { method: 'POST', token: x.token, body: { challenge_id: ch && ch.id, code } }); }
    catch (e) { if (e.status === 401) throw new HttpError(401, 'That code isn\'t right. Type the newest code from your authenticator app.'); throw e; }
    if (!v || !v.access_token || (aalOf(v.access_token) && aalOf(v.access_token) !== 'aal2')) throw new HttpError(401, 'That code isn\'t right. Type the newest code from your authenticator app.');
    Object.assign(x, { token: v.access_token, stage: 'signed-in' });
    res.json({ ticket: req.body.ticket, ...(await confirmOwner(x, biz)) });
  }));

  app.post('/api/auth/forgot/owner/reset', rateLimit(20, 15 * 60 * 1000), wrap((req, res) => {
    const b = req.body || {}, x = ticketOf(b.ticket);
    if (x.stage === 'code') throw new HttpError(403, 'Type the two-step code from your authenticator app first.');
    if (x.stage !== 'owner') throw new HttpError(403, 'Start again: sign in with your Riyeser account.');
    const u = admins().find(a => a.id === +b.user_id);
    if (!u) bad('Choose the Super admin login to reset.');
    const pw = newPassword(b);
    tickets.delete(String(b.ticket));   // good once
    setPassword(req, u, pw, `Business owner (${x.email})`, 'Password reset by the business owner through their Riyeser account',
      `${u.name} (${u.username}): new password set by the business owner, signed in to Riyeser as ${x.email}.`);
    res.json({ ok: true, username: u.username, message: `The password for ${u.username} has been changed. Sign in with it now.` });
  }));

  return { linkedBusiness, ONLINE };
};
module.exports.linkedBusiness = linkedBusiness;
module.exports.mfaFactor = mfaFactor;
module.exports.ONLINE = ONLINE;
