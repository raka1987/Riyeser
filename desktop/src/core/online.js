// Riyeser Online: the company this PC belongs to. Used by Riyeser Central's first-run wizard and Company page.
//
// %APPDATA%\Riyeser\company.json holds the company profile for the whole suite (Accounting, Invoices, Bookings, POS
// read it to fill in their set-up). It's written when someone sets up a new company, is approved to join one, or sets
// this PC up on its own. Nothing here ever deletes company.json or any other data.
//
// The online service is Riyeser Link's Supabase project (set up when it was called Riyeser Team). Its address and
// publishable key aren't built in: they're read from https://riyeser.com/link/config.js (the same file is still at
// riyeser.com/team/config.js for older Centrals), so switching it on needs no new Central release.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_URL = 'https://riyeser.com/link/config.js';
const RECOVER_REDIRECT = 'https://riyeser.com/link/';
const PROFILE_KEYS = ['name', 'legal_name', 'tax_number', 'address', 'phone', 'email', 'country'];

/** {url, key} from the text of config.js; empty strings when it isn't set up yet. */
function parseConfig(text) {
  const pick = (k) => { const m = new RegExp(`${k}\\s*:\\s*["']([^"']*)["']`).exec(String(text || '')); return m ? m[1].trim() : ''; };
  return { url: pick('supabaseUrl').replace(/\/+$/, ''), key: pick('supabaseKey') };
}
const usable = (c) => !!(c && /^https:\/\/[^\s/]+/.test(c.url) && c.key);

const companyFile = (appData) => path.join(appData, 'Riyeser', 'company.json');
function readCompany(appData) {
  try { const c = JSON.parse(fs.readFileSync(companyFile(appData), 'utf8')); return c && typeof c === 'object' && c.name ? c : null; } catch { return null; }
}
/** Write company.json safely (a temp file, then swap), keeping anything already in it that isn't being changed. */
function writeCompany(appData, data) {
  const f = companyFile(appData);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const clean = (v) => (v == null ? '' : String(v).trim().slice(0, 300));
  const out = { ...(readCompany(appData) || {}) };
  // currency and logo (a picture file next to company.json): from Central's first run "Your business" step
  for (const k of ['mode', 'company_code', 'workspace_id', ...PROFILE_KEYS.slice(1), 'name', 'kind', 'your_name', 'email_signed_in', 'linked_at', 'currency', 'logo']) {
    if (k in data) out[k] = k === 'mode' ? (data[k] === 'online' ? 'online' : 'local') : k === 'kind' ? (data[k] === 'personal' ? 'personal' : data[k] ? 'business' : '') : clean(data[k]);
  }
  if (!out.name) throw new Error('Enter the company name.');
  out.linked_at = out.linked_at || new Date().toISOString();
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, f);
  return out;
}

/** A plain-English message for what the online service sent back. */
function plain(status, body) {
  const m = (body && (body.msg || body.message || body.error_description || body.error || body.hint)) || '';
  if (/invalid login/i.test(m)) return 'That email or password isn\'t right.';
  if (/email not confirmed/i.test(m)) return 'Please confirm your email first: open the link we emailed you, then sign in.';
  if (/already registered/i.test(m)) return 'There\'s already an account with that email. Sign in instead.';
  if (/password should be/i.test(m)) return 'Choose a password of at least 8 characters.';
  if (/signups not allowed/i.test(m)) return 'New Riyeser accounts aren\'t open yet.';
  if (m) return m.replace(/^.*?:\s*(?=[A-Z])/, '');
  return status ? `Riyeser Online answered with an error (${status}). Please try again.` : 'Can\'t reach Riyeser. Check your internet and try again.';
}

/** The account's verified authenticator-app factor (two-step sign-in), or null. */
function mfaFactor(user) {
  const list = (user && Array.isArray(user.factors)) ? user.factors : [];
  return list.find((f) => f && f.status === 'verified' && (f.factor_type === 'totp' || !f.factor_type) && f.id) || null;
}

const firstName = (name, email) => String(name || '').trim().split(/\s+/)[0] || String(email || '').split('@')[0] || '';
/** riyeser_signup from the account (riyeser.com's sign-up form) as the fields of the "A few details" form. */
function signupDetails(user) {
  const md = (user && user.user_metadata && user.user_metadata.riyeser_signup) || {};
  const biz = md.biz && typeof md.biz === 'object' ? md.biz : { name: md.biz };
  const s = (v) => (v == null ? '' : String(v).trim());
  return { your_name: s(md.you), name: s(biz.name), tax_number: s(biz.tax_number || md.tax_number), address: s(biz.address || md.address),
    email: s(biz.email || md.email), phone: s(md.phone), country: s(md.country) };
}
/**
 * The "A few details" form as a new workspace: named after the business when one is given, else after the person,
 * and marked personal or business.
 */
function detailsToProfile(f) {
  const s = (v) => (v == null ? '' : String(v).trim());
  const business = s(f.name);
  return { name: business || s(f.your_name), kind: business ? 'business' : 'personal', tax_number: s(f.tax_number), address: s(f.address),
    phone: s(f.phone), email: s(f.email), country: s(f.country) };
}

class Online {
  /**
   * store: Central's Store; fetchFn: (url, opts) => Response; appData: Electron's appData folder;
   * programsFn: async () => {programId: version} — the Riyeser programs installed on this PC (from updates.js).
   */
  /** shareDevice: Riyeser Central only: it writes this PC's id to %APPDATA%\Riyeser\device.json for the other programs. */
  constructor({ store, fetchFn, appData, appVersion = '', deviceName = '', platform = process.platform, programsFn = null, shareDevice = false }) {
    Object.assign(this, { store, fetchFn, appData, appVersion, deviceName, platform, programsFn, shareDevice });
  }

  // ---------- the online service's address ----------
  async config(force = false) {
    const cached = this.store.get('online-config', null);
    if (!force && cached && cached.at && Date.now() - cached.at < 6 * 3600 * 1000) return cached;
    try {
      const r = await this.fetchFn(`${CONFIG_URL}?t=${Date.now()}`);
      if (r.ok) { const c = { ...parseConfig(await r.text()), at: Date.now() }; this.store.set('online-config', c); return c; }
    } catch { /* offline: use the last good one */ }
    return cached || { url: '', key: '', at: 0 };
  }
  async ready() { return usable(await this.config()); }

  // ---------- the person signed in on this PC ----------
  get session() { return (this.store.get('online', {}) || {}).session || null; }
  setSession(s) {
    const keep = s ? { access_token: s.access_token, refresh_token: s.refresh_token,
      expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
      // user_metadata keeps what was typed when the account was made on riyeser.com (riyeser_signup), to fill in the set-up
      user: { id: s.user && s.user.id, email: s.user && s.user.email, user_metadata: (s.user && s.user.user_metadata) || (this.session && this.session.user && this.session.user.user_metadata) || {} } } : null;
    this.store.update('online', {}, (o) => ({ ...(o || {}), session: keep }));
  }
  async call(pathname, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const c = await this.config();
    if (!usable(c)) throw new Error('Online company linking is being switched on. Set up this PC on its own for now.');
    const h = { apikey: c.key, 'Content-Type': 'application/json', ...headers };
    if (auth) h.Authorization = `Bearer ${await this.token()}`;
    let r;
    try { r = await this.fetchFn(c.url + pathname, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new Error(plain(0)); }
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) { const e = new Error(plain(r.status, data)); e.status = r.status; throw e; }
    return data;
  }
  async token() {
    const s = this.session;
    if (!s) throw new Error('Sign in to your Riyeser account first.');
    if (s.expires_at - 60 > Date.now() / 1000) return s.access_token;
    const fresh = await this.call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: s.refresh_token } })
      .catch((e) => { if (e.status === 400 || e.status === 401) this.setSession(null); throw new Error('Please sign in again.'); });
    this.setSession(fresh); return fresh.access_token;
  }
  /** The email last used to sign in here, to fill in the form next time. The password is never kept. */
  lastEmail() { const v = this.store.get('last-email', null); return (v && typeof v.email === 'string') ? v.email : ''; }
  rememberEmail(email) { this.store.set('last-email', { email: String(email || '').trim().slice(0, 200) }); }
  async signIn(email, password, create = false) {
    this.rememberEmail(email);
    if (create) {
      const r = await this.call('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password } });
      if (!r || !r.access_token) return { needsConfirm: true, email };
      this.setSession(r); return { email };
    }
    const r = await this.call('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password } });
    // S11: an account with two-step sign-in turned on (a verified authenticator app) isn't signed in until its code
    // is checked. The password-only session (AAL1) is held in memory only, never saved, until verifyCode().
    const factor = mfaFactor(r && r.user);
    if (factor) {
      this.pendingMfa = { session: r, factorId: factor.id, email, at: Date.now() };
      this.setSession(null);
      return { email, needsCode: true };
    }
    this.pendingMfa = null;
    this.setSession(r); return { email };
  }
  /**
   * The second step: the 6-digit code from the authenticator app (Supabase mfa.challenge then mfa.verify, by REST).
   * The session that comes back is AAL2, and only that one is saved.
   */
  async verifyCode(code) {
    const p = this.pendingMfa;
    if (!p || Date.now() - p.at > 10 * 60 * 1000) { this.pendingMfa = null; throw new Error('Sign in again: the two-step sign-in timed out.'); }
    code = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) throw new Error('Type the 6-digit code from your authenticator app.');
    const headers = { Authorization: `Bearer ${p.session.access_token}` };
    const id = encodeURIComponent(p.factorId);
    const ch = await this.call(`/auth/v1/factors/${id}/challenge`, { method: 'POST', auth: false, headers, body: {} });
    let r;
    try {
      r = await this.call(`/auth/v1/factors/${id}/verify`, { method: 'POST', auth: false, headers, body: { challenge_id: ch && ch.id, code } });
    } catch (e) {
      if (e.status === 400 || e.status === 422 || /invalid|code/i.test(e.message)) throw new Error('That code isn\'t right. Type the newest code from your authenticator app.');
      throw e;
    }
    if (!r || !r.access_token) throw new Error('That code isn\'t right. Type the newest code from your authenticator app.');
    this.pendingMfa = null;
    this.setSession({ ...r, user: r.user || p.session.user });
    return { email: p.email };
  }
  /** Just the session (Riyeser Link Office uses this too). Central's "Sign out" is signOutOfPC below. */
  signOut() { this.setSession(null); }
  /** "Forgot password?": Supabase emails a reset link. Same answer whether or not the account exists. */
  async recover(email) {
    email = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter the email you use for your Riyeser account.');
    await this.call(`/auth/v1/recover?redirect_to=${encodeURIComponent(RECOVER_REDIRECT)}`, { method: 'POST', auth: false, body: { email } })
      .catch((e) => {
        if (e.status === 429) throw new Error('Too many tries. Wait a few minutes, then try again.');
        if (!e.status || e.status >= 500) throw e;   // offline, or the service is down
      });   // any other answer (e.g. no such account): the same message, so nobody learns who has an account
    return true;
  }
  /**
   * Central's "Sign out": this PC stops showing the business until someone signs in again. Nothing is deleted:
   * company.json (an online company's) is renamed company.signed-out.json, and licence.json's "online" part is moved
   * to "online_signed_out", so every program reads this PC as not linked. Local books and files aren't touched.
   */
  signOutOfPC(now = Date.now()) {
    this.setSession(null);
    const out = { company: null, licence: false };
    const f = companyFile(this.appData);
    const c = readCompany(this.appData);
    if (c && c.mode === 'online') {
      const to = path.join(path.dirname(f), 'company.signed-out.json');
      fs.renameSync(f, to); out.company = to;
    }
    const licence = require('./licence');
    const lf = licence.licenceFile(this.appData);
    const d = licence.read(this.appData);
    if (d && d.online) {
      d.online_signed_out = { ...d.online, signed_out_at: new Date(now).toISOString() };
      delete d.online;
      fs.writeFileSync(`${lf}.tmp`, JSON.stringify(d, null, 2)); fs.renameSync(`${lf}.tmp`, lf);
      out.licence = true;
    }
    this.store.update('company-setup', {}, (o) => ({ ...(o || {}), pendingJoin: null, unlinked: false, signedOut: true }));
    this.store.set('licence-online-at', 0);
    return out;
  }
  rpc(name, args) { return this.call(`/rest/v1/rpc/${name}`, { method: 'POST', body: args || {} }); }

  // ---------- this PC ----------
  // The PC's id: made once by Riyeser Central and kept in its store; Central also writes it to device.json, where the
  // other programs read it (a signed licence names the PC it's for). Other apps use Central's id when there is one.
  deviceId() {
    const signed = require('./signed-licence');
    const shared = this.appData ? signed.readDeviceId(this.appData) : null;
    if (!this.shareDevice && shared) return shared;
    let d = this.store.get('device', null);
    if (!d || !d.id) d = this.store.set('device', { id: crypto.randomUUID(), created: new Date().toISOString() });
    if (this.shareDevice && this.appData && shared !== d.id) { try { signed.writeDeviceId(this.appData, d.id); } catch { /* tried again next time */ } }
    return d.id;
  }
  async linkDevice(ws) {
    await this.rpc('link_device', { ws, device: this.deviceId(), device_name: this.deviceName || 'This PC', platform: this.platform, app_version: this.appVersion });
    await this.reportPrograms(ws);
  }
  /**
   * Tell Riyeser which Riyeser programs (and versions) are installed on this PC, so Riyeser Support can see them.
   * Sent when the PC links, at the daily check-in, and soon after the list changes (Riyeser Central's
   * central/program-reports.js; onlyIfChanged: not sent when it's the same list this PC last sent for this business).
   * Never throws: false when it couldn't be sent (offline, or the online service doesn't have report_programs yet),
   * null when there's nothing to send.
   */
  async reportPrograms(ws, { onlyIfChanged = false } = {}) {
    if (!ws || typeof this.programsFn !== 'function' || !this.session) return null;
    let installed;
    try { installed = await this.programsFn(); } catch { return null; }
    const programs = Object.entries(installed || {}).filter(([id]) => /^[a-z0-9-]{1,40}$/.test(id))
      .map(([id, version]) => ({ id, version: version == null ? null : String(version).slice(0, 40) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const device = this.deviceId();
    const sig = JSON.stringify({ ws, device, programs });
    const last = this.store.get('programs-reported', null);
    if (onlyIfChanged && last && last.sig === sig) return null;
    try { await this.rpc('report_programs', { ws, device, programs }); } catch { return false; }
    this.store.set('programs-reported', { sig, at: Date.now() });
    return true;
  }
  // ---------- Report an issue (Get help): a diagnostic report and a help request, for this PC's business ----------
  /** Signed in here, with this PC linked to an online business? Report an issue needs both. */
  canReport() { const c = readCompany(this.appData); return !!(this.session && c && c.mode === 'online' && c.workspace_id); }
  /** Send it (support_report): { id, ref: 'T-10234', diag_ref: 'DG-4821' }. */
  async reportIssue(payload) {
    if (!this.canReport()) { const e = new Error('Sign in with your Riyeser account first.'); e.signIn = true; throw e; }
    try { return await this.rpc('support_report', { ws: readCompany(this.appData).workspace_id, payload }); }
    catch (e) {   // Riyeser's database hasn't had this release's team-chat.sql yet
      if (e.status === 404 || /support_report|schema cache|PGRST202/i.test(e.message)) throw new Error('Report an issue is still being switched on. Use Get help for now.');
      throw e;
    }
  }
  /** true / false, or null when it can't be checked (offline, not signed in, not an online company). */
  async stillLinked() {
    const c = readCompany(this.appData);
    if (!c || c.mode !== 'online' || !c.workspace_id || !this.session) return null;
    try { return !!(await this.rpc('device_still_linked', { ws: c.workspace_id, device: this.deviceId() })); } catch { return null; }
  }

  // ---------- the company's licence (which paid programs are on), saved for every Riyeser program ----------
  /**
   * Fetch it and save it in licence.json under "online". null when it can't (offline, not an online company).
   * The signed licence comes from Riyeser's "licence" function (Ed25519, for this business and this PC) and is saved
   * as it came, under online.signed. Until that function is switched on, the plan comes unsigned from company_licence.
   */
  async refreshLicence(now = Date.now()) {
    const c = readCompany(this.appData);
    if (!c || c.mode !== 'online' || !c.workspace_id || !this.session) return null;
    // the daily check-in also reports the programs on this PC (it never holds up the licence)
    const sent = this.reportPrograms(c.workspace_id);
    const s = await this.signedLicence(c.workspace_id);
    let r = s && s.licence;
    if (!r) {
      try { r = await this.rpc('company_licence', { ws: c.workspace_id }); } catch { await sent; return null; }   // keep the last one
    }
    await sent;
    if (!r || typeof r !== 'object' || !r.modules) return null;
    return require('./licence').saveOnline(this.appData, r, now, s);
  }
  /** The signed licence from the "licence" function, or null (not switched on yet, offline, or an odd answer). */
  async signedLicence(ws) {
    try {
      const s = await this.call('/functions/v1/licence', { method: 'POST', body: { ws, device: this.deviceId() } });
      return s && typeof s === 'object' && typeof s.sig === 'string' && s.licence && s.workspace_id === ws ? s : null;
    } catch { return null; }
  }

  // ---------- set up or join ----------
  /** profile: {name, legal_name, tax_number, address, phone, email, country}; yourName: the person setting it up. */
  async createCompany(profile, yourName) {
    const p = Object.fromEntries(PROFILE_KEYS.slice(1).map((k) => [k, String(profile[k] || '').trim()]));
    if (profile.kind) p.kind = profile.kind === 'personal' ? 'personal' : 'business';
    const r = await this.rpc('create_company', { company_name: String(profile.name || '').trim(), your_name: String(yourName || '').trim(), profile: p });
    const out = writeCompany(this.appData, { mode: 'online', company_code: r.company_code, workspace_id: r.workspace_id, ...profile, your_name: yourName,
      email_signed_in: this.session && this.session.user.email, linked_at: new Date().toISOString() });
    await this.linkDevice(r.workspace_id).catch(() => {});
    this.store.update('company-setup', {}, (o) => ({ ...(o || {}), pendingJoin: null, skipped: false, signedOut: false }));
    return out;
  }
  async requestJoin(code, yourName, note) {
    const r = await this.rpc('request_join', { code: String(code || '').trim().toUpperCase(), your_name: String(yourName || '').trim(), note: String(note || '').trim() });
    if (r.status === 'member') return { status: 'approved', company: await this.finishJoin(r.workspace_id, yourName) };
    this.store.update('company-setup', {}, (o) => ({ ...(o || {}), pendingJoin: { workspace_id: r.workspace_id, company_name: r.company_name, code, your_name: yourName, at: Date.now() } }));
    return { status: 'pending', company_name: r.company_name };
  }
  /** Where a join request stands: 'pending' | 'approved' (and linked) | 'declined' | 'none'. */
  async checkJoin() {
    const pj = (this.store.get('company-setup', {}) || {}).pendingJoin;
    if (!pj) return { status: 'none' };
    const rows = await this.rpc('my_join_requests');
    const mine = (Array.isArray(rows) ? rows : []).filter((x) => x.workspace_id === pj.workspace_id)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (mine && mine.status === 'approved') return { status: 'approved', company: await this.finishJoin(pj.workspace_id, pj.your_name) };
    if (mine && mine.status === 'declined') {
      this.store.update('company-setup', {}, (o) => ({ ...(o || {}), pendingJoin: null }));
      return { status: 'declined', company_name: pj.company_name };
    }
    return { status: 'pending', company_name: pj.company_name };
  }
  /** The businesses the signed-in Riyeser account belongs to (its rows in members, with each workspace). */
  async memberships() {
    const uid = this.session && this.session.user.id;
    const rows = await this.call(`/rest/v1/members?select=role,job_role,display_name,workspaces(id,name,company_code,legal_name,tax_number,address,phone,email,country)&user_id=eq.${encodeURIComponent(uid)}`);
    return (Array.isArray(rows) ? rows : []).filter((r) => r.workspaces && r.workspaces.id);
  }
  async myBusinesses() {
    return (await this.memberships()).map((r) => ({ workspace_id: r.workspaces.id, name: r.workspaces.name || '', company_code: r.workspaces.company_code || '',
      role: r.role || '', display_name: r.display_name || '' }));
  }
  /** What was typed when the account was made on riyeser.com, ready for the "A few details" form. */
  signupDetails() { return signupDetails(this.session && this.session.user); }
  /**
   * Right after signing in: one business -> this PC is linked to it now; several -> choose one; none -> the details form.
   * { status: 'linked', company, firstName } | { status: 'choose', businesses } | { status: 'none', details }
   */
  async afterSignIn() {
    const list = await this.myBusinesses();
    if (list.length === 1) return { status: 'linked', ...(await this.linkBusiness(list[0].workspace_id)) };
    if (list.length > 1) return { status: 'choose', businesses: list };
    return { status: 'none', details: this.signupDetails() };
  }
  /** Link this PC to one of the account's businesses: company.json filled in from it, the PC linked, the licence fetched. */
  async linkBusiness(ws) {
    const company = await this.finishJoin(ws, '');
    await this.refreshLicence().catch(() => null);
    return { company, firstName: firstName(company.your_name, this.session && this.session.user.email) };
  }
  async finishJoin(ws, yourName) {
    const rows = await this.memberships();
    const row = rows.find((r) => r.workspaces.id === ws);
    if (!row) throw new Error('You\'re not in that company yet.');
    const w = row.workspaces;
    const out = writeCompany(this.appData, { mode: 'online', company_code: w.company_code, workspace_id: w.id, name: w.name, legal_name: w.legal_name,
      tax_number: w.tax_number, address: w.address, phone: w.phone, email: w.email, country: w.country, your_name: row.display_name || yourName,
      email_signed_in: this.session.user.email, linked_at: new Date().toISOString() });
    await this.linkDevice(w.id).catch(() => {});
    this.store.update('company-setup', {}, (o) => ({ ...(o || {}), pendingJoin: null, skipped: false, signedOut: false }));
    return out;
  }
  // ---------- what the person chose in Central, kept with their Riyeser account (user metadata riyeser_prefs) ----------
  /** Merge prefs into riyeser_prefs on the account (Supabase updateUser). false when not signed in or offline. */
  async savePrefs(prefs) {
    const s = this.session;
    if (!s) return false;
    const md = (s.user && s.user.user_metadata) || {};
    const next = { ...(md.riyeser_prefs && typeof md.riyeser_prefs === 'object' ? md.riyeser_prefs : {}), ...(prefs || {}) };
    let user;
    try { user = await this.call('/auth/v1/user', { method: 'PUT', body: { data: { riyeser_prefs: next } } }); } catch { return false; }
    const cur = this.session;
    if (cur) this.store.update('online', {}, (o) => ({ ...(o || {}), session: { ...cur, user: { ...cur.user, user_metadata: (user && user.user_metadata) || { ...md, riyeser_prefs: next } } } }));
    return true;
  }
  /** riyeser_prefs saved with the account (as last seen on this PC). */
  prefs() { const md = this.session && this.session.user && this.session.user.user_metadata; return (md && md.riyeser_prefs && typeof md.riyeser_prefs === 'object') ? md.riyeser_prefs : {}; }
  /** 'personal' | 'business' for the linked online business, or null when it can't be checked. */
  async workspaceKind() {
    const c = readCompany(this.appData);
    if (!c || c.mode !== 'online' || !c.workspace_id || !this.session) return null;
    try {
      const rows = await this.call(`/rest/v1/workspaces?select=kind&id=eq.${encodeURIComponent(c.workspace_id)}`);
      const k = Array.isArray(rows) && rows[0] && rows[0].kind;
      return k === 'personal' || k === 'business' ? k : null;
    } catch { return null; }
  }

  setupLocal(profile, yourName) {
    const out = writeCompany(this.appData, { ...profile, your_name: yourName || '', mode: 'local', company_code: '', workspace_id: '' });
    this.store.update('company-setup', {}, (o) => ({ ...(o || {}), skipped: false, signedOut: false }));
    return out;
  }
}

module.exports = { Online, mfaFactor, signupDetails, detailsToProfile, firstName, parseConfig, usable, companyFile, readCompany, writeCompany, CONFIG_URL, PROFILE_KEYS, RECOVER_REDIRECT };
