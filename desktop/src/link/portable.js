// Riyeser Link settings as one portable JSON file: people and extensions, ring groups, which desk phone belongs to
// whom, Do not disturb, and each extension's SIP password. Riyeser Link: Office (this PC) and Riyeser Link: Cloud
// (hosted by Riyeser, later) use the same extensions and phone set-up, so a business can move between them, or to a
// new PC, by exporting here and importing there, without setting any phone up again.
// The file holds the phones' passwords: keep it somewhere safe. Recent calls and logs aren't included.
const FORMAT = 'riyeser-link-settings';
const VERSION = 1;

/** Everything needed to carry on somewhere else. */
function exportSettings({ directory, store, now = Date.now() }) {
  const d = directory.data();
  const devices = store.get('phone-devices', null) || {};
  const dnd = store.get('phone-dnd', {}) || {};
  const people = d.people.map((p) => ({ name: p.name, ext: p.ext, source: p.source, ...(p.teamUserId ? { teamUserId: p.teamUserId } : {}), ...(p.hidden ? { hidden: true } : {}) }));
  return {
    format: FORMAT, version: VERSION, exportedAt: new Date(now).toISOString(), business: d.business || '', source: d.source || 'local',
    people, groups: d.groups.map((g) => ({ name: g.name, ext: g.ext, members: [...g.members], source: g.source || 'local' })),
    phones: (devices.phones || []).map((p) => ({ mac: p.mac, ext: p.ext, vendor: p.vendor || '', model: p.model || '' })),
    dnd: Object.keys(dnd).filter((k) => dnd[k]),
    passwords: Object.fromEntries(people.filter((p) => !p.hidden).map((p) => [p.ext, directory.password(p.ext)])),
  };
}

/** Take settings from an export. Replaces people, groups and phone assignments; recent calls on this PC are kept. */
function importSettings({ directory, store, data }) {
  if (!data || data.format !== FORMAT || typeof data.version !== 'number') throw new Error('That isn\'t a Riyeser Link settings file.');
  if (data.version > VERSION) throw new Error('That settings file is from a newer Riyeser Link. Update this one first.');
  const { validExt } = require('./dialplan');
  const s = (v, n = 60) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>"&]/g, '').trim().slice(0, n);
  const people = (data.people || []).filter((p) => p && validExt(String(p.ext)) && s(p.name)).map((p) => ({
    id: p.source === 'team' && p.teamUserId ? `team:${s(p.teamUserId, 80)}` : `local:${require('crypto').randomUUID()}`, name: s(p.name), ext: String(p.ext),
    source: p.source === 'team' ? 'team' : 'local', ...(p.teamUserId ? { teamUserId: s(p.teamUserId, 80) } : {}), ...(p.hidden ? { hidden: true } : {}) }));
  const exts = new Set(people.map((p) => p.ext));
  const groups = (data.groups || []).filter((g) => g && validExt(String(g.ext)) && !exts.has(String(g.ext))).map((g) => ({
    id: `${g.source === 'team' ? 'team' : 'local'}:${String(g.ext)}`, name: s(g.name) || `Group ${g.ext}`, ext: String(g.ext),
    members: (g.members || []).map(String).filter((m) => exts.has(m)), source: g.source === 'team' ? 'team' : 'local' }));
  const before = directory.data();
  directory.save({ ...before, business: s(data.business, 120) || before.business, source: data.source === 'team' ? 'team' : before.source, people, groups });
  for (const [ext, pw] of Object.entries(data.passwords || {})) {
    if (exts.has(ext) && typeof pw === 'string' && pw.length >= 8 && pw.length <= 64) store.update('phone-secrets', {}, (all) => ({ ...(all || {}), [ext]: directory.seal(pw) }));
  }
  store.set('phone-dnd', Object.fromEntries((data.dnd || []).map(String).filter((e) => exts.has(e)).map((e) => [e, true])));
  const devices = store.get('phone-devices', null) || {};
  const phones = (data.phones || []).filter((p) => p && /^[0-9a-f]{12}$/.test(String(p.mac)) && exts.has(String(p.ext)))
    .map((p) => ({ mac: p.mac, ext: String(p.ext), vendor: s(p.vendor, 20), model: s(p.model, 40), ip: '', addedAt: new Date().toISOString(), lastSeen: null, lastFetch: null }));
  store.set('phone-devices', { ...devices, phones, found: (devices.found || []).filter((f) => !phones.some((p) => p.mac === f.mac)) });
  return { people: people.length, groups: groups.length, phones: phones.length };
}

module.exports = { exportSettings, importSettings, FORMAT, VERSION };
