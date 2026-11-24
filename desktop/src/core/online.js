// Riyeser Online: the company this PC belongs to. Used by Riyeser Central's first-run wizard and Company page.
//
// %APPDATA%\Riyeser\company.json holds the company profile for the whole suite (Accounting, Invoices, Bookings, POS
// read it to fill in their set-up). It's written when someone sets up a new company, is approved to join one, or sets
// this PC up on its own. Nothing here ever deletes company.json or any other data.
//
// The online service is Riyeser Team's Supabase project. Its address and publishable key aren't built in: they're
// read from https://riyeser.com/team/config.js, so switching it on needs no new Central release.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_URL = 'https://riyeser.com/team/config.js';
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
  for (const k of ['mode', 'company_code', 'workspace_id', ...PROFILE_KEYS.slice(1), 'name', 'your_name', 'email_signed_in', 'linked_at']) {
    if (k in data) out[k] = k === 'mode' ? (data[k] === 'online' ? 'online' : 'local') : clean(data[k]);
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
  return status ? `Riyeser Online answered with an error (${status}). Please try again.` : 'Can\'t reach Riyeser Online. Check the internet connection.';
}

class Online {
  /** store: Central's Store; fetchFn: (url, opts) => Response; appData: Electron's appData folder. */
  constructor({ store, fetchFn, appData, appVersion = '', deviceName = '', platform = process.platform }) {
    Object.assign(this, { store, fetchFn, appData, appVersion, deviceName, platform });
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
      expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600), user: { id: s.user && s.user.id, email: s.user && s.user.email } } : null;
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
  async signIn(email, password, create = false) {
    if (create) {
      const r = await this.call('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password } });
      if (!r || !r.access_token) return { needsConfirm: true, email };
      this.setSession(r); return { email };
    }
    const r = await this.call('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password } });
    this.setSession(r); return { email };
  }
  signOut() { this.setSession(null); }
  rpc(name, args) { return this.call(`/rest/v1/rpc/${name}`, { method: 'POST', body: args || {} }); }

  // ---------- this PC ----------
  deviceId() {
    let d = this.store.get('device', null);
    if (!d || !d.id) d = this.store.set('device', { id: crypto.randomUUID(), created: new Date().toISOString() });
    return d.id;
  }
  async linkDevice(ws) {
    await this.rpc('link_device', { ws, device: this.deviceId(), device_name: this.deviceName || 'This PC', platform: this.platform, app_version: this.appVersion });
  }
  /** true / false, or null when it can't be checked (offline, not signed in, not an online company). */
  async stillLinked() {
    const c = readCompany(this.appData);
    if (!c || c.mode !== 'online' || !c.workspace_id || !this.session) return null;
    try { return !!(await this.rpc('device_still_linked', { ws: c.workspace_id, device: this.deviceId() })); } catch { return null; }
  }

  // ---------- set up or join ----------
  /** profile: {name, legal_name, tax_number, address, phone, email, country}; yourName: the person setting it up. */
  async createCompany(profile, yourName) {
    const p = Object.fromEntries(PROFILE_KEYS.slice(1).map((k) => [k, String(profile[k] || '').trim()]));
    const r = await this.rpc('create_company', { company_name: String(profile.name || '').trim(), your_name: String(yourName || '').trim(), profile: p });
    const out = writeCompany(this.appData, { mode: 'online', company_code: r.company_code, workspace_id: r.workspace_id, ...profile, your_name: yourName,
      email_signed_in: this.session && this.session.user.email, linked_at: new Date().toISOString() });
    await this.linkDevice(r.workspace_id).catch(() => {});
    this.store.update('company-setup', {}, (o) => ({ ...(o || {}), pendingJoin: null, skipped: false }));
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
  async finishJoin(ws, yourName) {
    const uid = this.session && this.session.user.id;
    const rows = await this.call(`/rest/v1/members?select=role,job_role,display_name,workspaces(id,name,company_code,legal_name,tax_number,address,phone,email,country)&user_id=eq.${encodeURIComponent(uid)}`);
    const row = (rows || []).find((r) => r.workspaces && r.workspaces.id === ws);
    if (!row) throw new Error('You\'re not in that company yet.');
    const w = row.workspaces;
    const out = writeCompany(this.appData, { mode: 'online', company_code: w.company_code, workspace_id: w.id, name: w.name, legal_name: w.legal_name,
      tax_number: w.tax_number, address: w.address, phone: w.phone, email: w.email, country: w.country, your_name: row.display_name || yourName,
      email_signed_in: this.session.user.email, linked_at: new Date().toISOString() });
    await this.linkDevice(w.id).catch(() => {});
    this.store.update('company-setup', {}, (o) => ({ ...(o || {}), pendingJoin: null, skipped: false }));
    return out;
  }
  setupLocal(profile, yourName) {
    const out = writeCompany(this.appData, { ...profile, your_name: yourName || '', mode: 'local', company_code: '', workspace_id: '' });
    this.store.update('company-setup', {}, (o) => ({ ...(o || {}), skipped: false }));
    return out;
  }
}

module.exports = { Online, parseConfig, usable, companyFile, readCompany, writeCompany, CONFIG_URL, PROFILE_KEYS };
