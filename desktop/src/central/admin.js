// Riyeser Central 1.9: the 🔒 Admin panel's lock, and what the panel shows about the business.
//
// On a PC linked to an online business the Admin panel (PCs and licences, people, updates, online connections,
// branches, backups, diagnostics, demo mode, fresh start) opens only for the business's owner or an admin: their
// Riyeser account's email and password, then a fresh 6-digit code from their authenticator app (two-step sign-in is
// required). The unlocked session is held in memory only (never saved, never the PC's own sign-in) and the panel locks
// again after 15 minutes without anything done in it, the same as Riyeser Link's Management and Link Office's
// Advanced checks (link/relaychecks.js). A PC that isn't linked to an online business has no one to ask, so its
// panel opens straight away (it only has this PC's things in it).
// Demo mode: any email and the code 123456, and made-up PCs and people for Sample Trading Co.
const IDLE_LOCK = 15 * 60 * 1000;
const DEMO_CODE = '123456';

class AdminLock {
  /** opts: { makeOnline: () => Online (fresh, unsaved), readCompany: () => company.json | null, isDemo: () => bool, now } */
  constructor(opts = {}) {
    Object.assign(this, opts);
    this.now = opts.now || Date.now;
    this.admin = null;        // { online, email, ws, until, demo }
    this.pending = null;      // after the password, before the code
  }
  /** Does this PC need the lock? Only when it's linked to an online business (and not in demo mode). */
  needed() {
    if (this.isDemo && this.isDemo()) return true;
    const c = this.readCompany ? this.readCompany() : null;
    return !!(c && c.mode === 'online' && c.workspace_id);
  }
  state() {
    if (this.admin && this.now() > this.admin.until) this.admin = null;
    const needed = this.needed();
    if (this.admin && !this.isDemoNow() && this.admin.demo) this.admin = null;   // demo unlock ends with demo mode
    return { needed, open: !needed || !!this.admin, email: this.admin ? this.admin.email : null, until: this.admin ? this.admin.until : null,
      idle: IDLE_LOCK, demo: this.isDemoNow(), pendingCode: !!this.pending };
  }
  isDemoNow() { return !!(this.isDemo && this.isDemo()); }
  /** Something was done in the panel: the 15 minutes start again. */
  touch() { if (this.admin && this.now() <= this.admin.until) this.admin.until = this.now() + IDLE_LOCK; return this.state(); }
  lock() { this.admin = null; this.pending = null; return this.state(); }
  /** For the things only the Admin panel does (fresh start, restore, online mode…): throws while it's locked. */
  require() {
    const s = this.state();
    if (!s.open) throw new Error('Unlock the Admin panel first: an owner or admin signs in with two-step sign-in.');
    this.touch();
    return this.admin;
  }

  /** Step 1: the Riyeser account's email and password. Two-step sign-in has to be on for it. */
  async unlock(email, password) {
    email = String(email || '').trim();
    if (this.isDemoNow()) { this.pending = { demo: true, email: email || 'owner@sample.test' }; return { needsCode: true, demo: true }; }
    if (!email || !password) throw new Error('Type the email and password of the business\'s owner or an admin.');
    const o = this.makeOnline();
    const r = await o.signIn(email, String(password || ''));
    if (!r || !r.needsCode) { o.signOut(); this.pending = null; throw new Error('The Admin panel needs two-step sign-in on that Riyeser account. Turn it on in Riyeser Link (your name → Two-step sign-in), then try again.'); }
    this.pending = { online: o, email: r.email };
    return { needsCode: true };
  }
  /** Step 2: the 6-digit code. Then: is this person the owner or an admin of this PC's business? */
  async unlockCode(code) {
    const p = this.pending; if (!p) throw new Error('Sign in again.');
    if (p.demo) {
      if (String(code || '').replace(/\s+/g, '') !== DEMO_CODE) throw new Error('That code isn\'t right. In demo mode the code is 123456.');
      this.pending = null; this.admin = { email: p.email, demo: true, until: this.now() + IDLE_LOCK };
      return this.state();
    }
    await p.online.verifyCode(code);
    const c = this.readCompany ? this.readCompany() : null;
    if (!c || !c.workspace_id) { this.pending = null; throw new Error('This PC isn\'t linked to a business.'); }
    const rows = await p.online.memberships().catch(() => []);
    const me = rows.find((r) => r.workspaces && r.workspaces.id === c.workspace_id);
    if (!me || !['owner', 'admin'].includes(me.role)) { this.pending = null; p.online.signOut(); throw new Error(`Only ${c.name || 'the business'}'s owner or an admin can open the Admin panel.`); }
    this.pending = null;
    this.admin = { online: p.online, email: p.email, ws: c.workspace_id, role: me.role, until: this.now() + IDLE_LOCK };
    return this.state();
  }

  /**
   * What the panel shows about the business: its PCs, people (and join requests waiting), branches and the relay.
   * Read with the unlocked admin's session. Each part is null when it can't be read (offline, an older database).
   */
  async business() {
    const a = this.require();
    if (!a || a.demo || this.isDemoNow()) return sampleBusiness(this.now());
    const ws = encodeURIComponent(a.ws); const get = (p) => a.online.call(p).catch(() => null);
    const [pcs, people, requests, branches, relay] = await Promise.all([
      get(`/rest/v1/devices?select=id,device_name,platform,app_version,linked_at,last_seen&workspace_id=eq.${ws}&order=last_seen.desc`),
      get(`/rest/v1/members?select=display_name,role,joined_at&workspace_id=eq.${ws}&order=joined_at`),
      get(`/rest/v1/join_requests?select=id,display_name,created_at&workspace_id=eq.${ws}&status=eq.pending&order=created_at`),
      get(`/rest/v1/branches?select=id,name&workspace_id=eq.${ws}&order=name`),
      a.online.call('/rest/v1/rpc/link_relay_status', { method: 'POST', body: { ws: a.ws } }).catch(() => null),
    ]);
    return shapeBusiness({ pcs, people, requests, branches, relay });
  }
}

/** Only what the panel shows, in plain shapes (and never more than it needs). */
function shapeBusiness({ pcs, people, requests, branches, relay } = {}) {
  const arr = (x) => (Array.isArray(x) ? x : null);
  const P = arr(people);
  return {
    pcs: arr(pcs) && pcs.map((d) => ({ id: d.id, name: d.device_name || 'A PC', platform: d.platform || '', version: d.app_version || '', linkedAt: d.linked_at || null, lastSeen: d.last_seen || null })),
    people: P && { total: P.length, owners: P.filter((m) => m.role === 'owner').length, admins: P.filter((m) => m.role === 'admin').length,
      list: P.slice(0, 50).map((m) => ({ name: m.display_name || '', role: m.role || 'member' })) },
    requests: arr(requests) && requests.map((r) => ({ name: r.display_name || '', at: r.created_at || null })),
    branches: arr(branches) && branches.map((b) => ({ name: b.name || '' })),
    relay: relay && typeof relay === 'object' ? {
      enabled: !!relay.enabled,
      offices: (relay.offices || []).map((o) => ({ name: o.pc_name || '', version: o.version || '', lastSeen: o.last_seen || null, relay: !!o.relay, revoked: !!o.revoked })),
      relays: Array.isArray(relay.relays) ? relay.relays.length : 0,
    } : null,
  };
}

/** Made-up PCs, people and branches for Sample Trading Co (demo mode). */
function sampleBusiness(now = Date.now()) {
  const ago = (min) => new Date(now - min * 60000).toISOString();
  return shapeBusiness({
    pcs: [{ id: 'd1', device_name: 'FRONT-DESK', platform: 'win32', app_version: '1.9.0', last_seen: ago(2), linked_at: ago(60 * 24 * 90) },
      { id: 'd2', device_name: 'OFFICE-PC', platform: 'win32', app_version: '1.9.0', last_seen: ago(25), linked_at: ago(60 * 24 * 120) },
      { id: 'd3', device_name: 'TILL-1', platform: 'win32', app_version: '1.8.13', last_seen: ago(60 * 26), linked_at: ago(60 * 24 * 40) }],
    people: [{ display_name: 'Ricky M', role: 'owner' }, { display_name: 'Ana T', role: 'admin' }, { display_name: 'Josefa K', role: 'member' }, { display_name: 'Mere L', role: 'member' }, { display_name: 'Sam P', role: 'member' }],
    requests: [{ display_name: 'Litia V', created_at: ago(90) }],
    branches: [{ name: 'Lautoka' }, { name: 'Suva' }],
    relay: { enabled: true, relays: [{}], offices: [{ pc_name: 'OFFICE-PC', version: '1.3.1', last_seen: ago(1), relay: true }, { pc_name: 'LAUTOKA-PC', version: '1.3.1', last_seen: ago(3), relay: false }] },
  });
}

module.exports = { AdminLock, IDLE_LOCK, DEMO_CODE, shapeBusiness, sampleBusiness };
