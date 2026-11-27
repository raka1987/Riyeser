// People, extensions and ring groups for Riyeser Link Office, kept on this PC so calls work with no internet.
//   phone-directory.json  people, ring groups (branches), the business name, where they came from, when last synced
//   phone-secrets.json    each extension's SIP password (sealed with Windows' own data protection when available)
//   phone-dnd.json        which extensions have Do not disturb on
// People come from Riyeser Link (members with an extension, branches as ring groups) when this PC is signed in to
// Riyeser, or are added here by hand. A sync only ever replaces the Team people; nothing is deleted otherwise.
const crypto = require('crypto');
const { validExt, EMERGENCY, MIN_EXT, MAX_EXT } = require('./dialplan');
const { settings: ringSettings } = require('./ringgroups');

// Easy to read and type on a phone keypad screen: no 0/O, 1/l/I.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function strongPassword(len = 16) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
const clean = (v, n = 60) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>"&]/g, '').trim().slice(0, n);

/**
 * Riyeser Link's members and ring groups as people and ring groups.
 * members:  [{ user_id, display_name, extension }]
 * ringGroups (ring_groups_list): [{ id, name, extension, strategy, ring_seconds, timeout_seconds, fallback, fallback_group, fallback_user,
 *             members: [{ user_id } | { phone_ext }] }] - only the people and shared desk phones chosen for each number.
 * branches: [{ id, name, extension, branch_members: [{ user_id }] }] - only from an online database without ring groups yet,
 *           where a branch's number still rings everyone in it.
 * -> { business, people: [{ id, name, ext, source: 'team', teamUserId }], groups: [{ id, name, ext, members: [ext], strategy, … }], skipped: [{ name, why }] }
 */
function mapTeam({ members = [], branches = [], ringGroups = null, business = '' } = {}) {
  const people = []; const groups = []; const skipped = []; const used = new Set();
  const byUser = new Map();
  const numbers = Array.isArray(ringGroups) ? ringGroups : Array.isArray(branches) ? branches : [];
  for (const b of numbers) if (b && b.extension != null && validExt(String(b.extension))) used.add(String(b.extension));
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || !m.user_id) continue;
    const name = clean(m.display_name) || 'Team member';
    const ext = m.extension == null ? '' : String(m.extension);
    if (!ext) { skipped.push({ name, why: 'No extension yet - give them one in Riyeser Link' }); continue; }
    if (!validExt(ext)) { skipped.push({ name, why: `Extension ${ext} isn't between ${MIN_EXT} and ${MAX_EXT}` }); continue; }
    if (used.has(ext)) { skipped.push({ name, why: `Extension ${ext} is already used` }); continue; }
    used.add(ext);
    const p = { id: `team:${m.user_id}`, name, ext, source: 'team', teamUserId: String(m.user_id) };
    people.push(p); byUser.set(String(m.user_id), p);
  }
  if (Array.isArray(ringGroups)) {
    const extOfGroup = new Map(ringGroups.filter((g) => g && g.extension != null).map((g) => [String(g.id), String(g.extension)]));
    for (const g of ringGroups) {
      if (!g || g.extension == null) continue;
      const ext = String(g.extension);
      if (!validExt(ext)) { skipped.push({ name: clean(g.name), why: `Group number ${ext} isn't between ${MIN_EXT} and ${MAX_EXT}` }); continue; }
      const mem = (Array.isArray(g.members) ? g.members : []).map((x) => (x && x.user_id ? (byUser.get(String(x.user_id)) || {}).ext : x && x.phone_ext ? String(x.phone_ext) : null))
        .filter((e) => e && validExt(e));
      const fbExt = g.fallback === 'group' ? extOfGroup.get(String(g.fallback_group)) : g.fallback === 'person' ? (byUser.get(String(g.fallback_user)) || {}).ext : null;
      groups.push({ id: `team:${g.id || ext}`, name: clean(g.name) || `Group ${ext}`, ext, members: [...new Set(mem)], source: 'team',
        ...ringSettings({ strategy: g.strategy, ringSeconds: g.ring_seconds, timeoutSeconds: g.timeout_seconds, fallback: fbExt ? { type: g.fallback, ext: fbExt } : null }) });
    }
  }
  for (const b of Array.isArray(ringGroups) ? [] : Array.isArray(branches) ? branches : []) {
    if (!b || b.extension == null) continue;
    const ext = String(b.extension);
    if (!validExt(ext)) { skipped.push({ name: clean(b.name), why: `Branch number ${ext} isn't between ${MIN_EXT} and ${MAX_EXT}` }); continue; }
    const mem = (Array.isArray(b.branch_members) ? b.branch_members : []).map((x) => byUser.get(String(x && x.user_id))).filter(Boolean).map((p) => p.ext);
    groups.push({ id: `team:${b.id || ext}`, name: clean(b.name) || `Branch ${ext}`, ext, members: [...new Set(mem)], source: 'team' });
  }
  people.sort((a, b) => a.ext.localeCompare(b.ext)); groups.sort((a, b) => a.ext.localeCompare(b.ext));
  return { business: clean(business, 120), people, groups, skipped };
}

class Directory {
  /** store: core/store.js Store. seal/unseal: protect passwords at rest (Electron safeStorage on Windows). */
  constructor(store, { seal = (s) => s, unseal = (s) => s } = {}) {
    Object.assign(this, { store, seal, unseal });
  }
  data() { return this.store.get('phone-directory', null) || { business: '', people: [], groups: [], teamSyncedAt: null, source: 'local', skipped: [] }; }
  save(d) { this.store.set('phone-directory', d); return d; }
  people() { return this.data().people.filter((p) => !p.hidden); }
  groups() { return this.data().groups; }
  business() { return this.data().business || ''; }
  user(ext) { const p = this.people().find((x) => x.ext === String(ext)); return p ? { ...p, password: this.password(p.ext) } : null; }
  group(ext) { return this.groups().find((g) => g.ext === String(ext)) || null; }
  person(ext) { return this.people().find((x) => x.ext === String(ext)) || null; }
  nameOf(ext) { const p = this.person(ext) || this.group(ext); return p ? p.name : ''; }

  // ---------- passwords ----------
  password(ext) {
    const all = this.store.get('phone-secrets', {}) || {};
    if (all[ext]) { try { return this.unseal(all[ext]); } catch { /* unreadable: make a new one below */ } }
    return this.resetPassword(ext);
  }
  resetPassword(ext) {
    const pw = strongPassword();
    this.store.update('phone-secrets', {}, (all) => ({ ...(all || {}), [String(ext)]: this.seal(pw) }));
    return pw;
  }

  // ---------- Do not disturb ----------
  dnd(ext) { return !!(this.store.get('phone-dnd', {}) || {})[ext]; }
  setDnd(ext, on) { this.store.update('phone-dnd', {}, (d) => ({ ...(d || {}), [String(ext)]: !!on })); }

  // ---------- Riyeser Link ----------
  /** Replace the Team people and branches with what Team says now. People added by hand stay (unless Team now uses their number). */
  applyTeam(mapped, now = Date.now()) {
    const d = this.data();
    const local = d.people.filter((p) => p.source !== 'team');
    const teamExts = new Set([...mapped.people.map((p) => p.ext), ...mapped.groups.map((g) => g.ext)]);
    for (const p of local) p.hidden = teamExts.has(p.ext);   // Team wins; the hand-added one comes back if Team frees the number
    const localGroups = d.groups.filter((g) => g.source !== 'team' && !teamExts.has(g.ext));
    return this.save({ ...d, business: mapped.business || d.business, source: 'team', teamSyncedAt: new Date(now).toISOString(),
      people: [...mapped.people, ...local].sort((a, b) => a.ext.localeCompare(b.ext)), groups: [...mapped.groups, ...localGroups].sort((a, b) => a.ext.localeCompare(b.ext)),
      skipped: mapped.skipped || [] });
  }

  // ---------- set up by hand (when not signed in to Riyeser, or for someone not in Team) ----------
  usedExts() { const d = this.data(); return new Set([...d.people.filter((p) => !p.hidden).map((p) => p.ext), ...d.groups.map((g) => g.ext)]); }
  nextFreeExt() {
    const used = this.usedExts();
    for (let n = 101; n <= MAX_EXT; n++) { const e = String(n); if (n % 100 && !used.has(e) && !EMERGENCY.has(e)) return e; }
    return null;
  }
  addPerson({ name, ext } = {}) {
    const n = clean(name);
    if (!n) throw new Error('Type the person\'s name.');
    const e = ext ? String(ext).trim() : this.nextFreeExt();
    if (!e || !validExt(e)) throw new Error(`Extensions are 3 digits, ${MIN_EXT} to ${MAX_EXT}.`);
    if (EMERGENCY.has(e)) throw new Error(`${e} is an emergency number. Choose another extension.`);
    if (this.usedExts().has(e)) throw new Error(`Extension ${e} is already used.`);
    const p = { id: `local:${crypto.randomUUID()}`, name: n, ext: e, source: 'local', addedAt: new Date().toISOString() };
    const d = this.data(); d.people.push(p); d.people.sort((a, b) => a.ext.localeCompare(b.ext)); this.save(d);
    this.password(e);
    return p;
  }
  /** Take a hand-added person off the list (their call history stays). Team people are changed in Riyeser Link. */
  removePerson(id) {
    const d = this.data(); const p = d.people.find((x) => x.id === id);
    if (!p) return false;
    if (p.source === 'team') throw new Error('This person comes from Riyeser Link. Change them there.');
    d.people = d.people.filter((x) => x.id !== id); this.save(d);
    return true;
  }
  addGroup({ name, ext, members = [], ...how } = {}) {
    const n = clean(name); const e = String(ext || '').trim();
    if (!n) throw new Error('Type a name for the group.');
    if (!validExt(e)) throw new Error(`Group numbers are 3 digits, ${MIN_EXT} to ${MAX_EXT}.`);
    if (this.usedExts().has(e)) throw new Error(`${e} is already used.`);
    const d = this.data();
    const g = { id: `local:${crypto.randomUUID()}`, name: n, ext: e, members: members.map(String).filter((m) => d.people.some((p) => p.ext === m)), source: 'local', ...ringSettings(how) };
    d.groups.push(g); d.groups.sort((a, b) => a.ext.localeCompare(b.ext)); this.save(d);
    return g;
  }
  setBusiness(name) { const d = this.data(); d.business = clean(name, 120); this.save(d); }
}

module.exports = { Directory, mapTeam, strongPassword, ALPHABET };
