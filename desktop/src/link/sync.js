// Bring people, extensions and branches in from Riyeser Link (the company's Riyeser Online account).
// Uses the PC's link to the company (%APPDATA%\Riyeser\company.json, written by Riyeser Central) and a signed-in
// Riyeser account: this app's own sign-in, or Central's while its access is still current (read only: this app never
// renews Central's sign-in, so the two can't trip each other up). What comes back is saved on this PC, so the phones
// keep working with no internet for as long as needed.
const fs = require('fs');
const path = require('path');
const { Online, readCompany } = require('../core/online');
const { mapTeam } = require('./directory');

/**
 * A view of Riyeser Central's sign-in that can only use the current access (never renews or changes it).
 * phoneStore keeps the online service's address (config.js) for this app.
 */
function centralOnline({ appData, phoneStore, fetchFn }) {
  const file = path.join(appData, 'Riyeser Central', 'data', 'online.json');
  const store = {
    get: (name, fallback) => {
      if (name !== 'online') return phoneStore.get(name, fallback);
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
    },
    set: (name, value) => (name === 'online' ? value : phoneStore.set(name, value)),
    update: (name, fallback, fn) => (name === 'online' ? fn(store.get(name, fallback)) : phoneStore.update(name, fallback, fn)),
  };
  const on = new Online({ store, fetchFn, appData, appVersion: '', deviceName: '' });
  on.token = async () => {
    const s = on.session;
    if (!s || !s.access_token || !(s.expires_at - 60 > Date.now() / 1000)) throw new Error('Riyeser Central\'s sign-in needs renewing: open Riyeser Central, or sign in here.');
    return s.access_token;
  };
  return on;
}

const missingFn = (e) => /PGRST202|Could not find the function|schema cache|404/i.test(String(e && e.message));
/**
 * Members (with extensions) and the ring groups: each branch's number and any group's own number, with only the people
 * and shared desk phones chosen for it. An online database without ring groups yet: branches with everyone in them.
 */
async function teamData(online, ws) {
  const w = encodeURIComponent(ws);
  const members = await online.call(`/rest/v1/members?select=user_id,display_name,extension&workspace_id=eq.${w}`);
  let ringGroups = null;
  try { ringGroups = await online.call('/rest/v1/rpc/ring_groups_list', { method: 'POST', body: { ws } }); } catch (e) { if (!missingFn(e)) throw e; }
  if (Array.isArray(ringGroups)) return { members: Array.isArray(members) ? members : [], ringGroups };
  const branches = await online.call(`/rest/v1/branches?select=id,name,extension,branch_members(user_id)&workspace_id=eq.${w}`);
  return { members: Array.isArray(members) ? members : [], branches: Array.isArray(branches) ? branches : [] };
}

/**
 * Sync now. clients: Online-like objects ({ call, session, refreshLicence }) to try in turn.
 * -> { status: 'synced', people, groups, skipped } | { status: 'local', why } | { status: 'offline', error }
 */
async function syncFromTeam({ clients, appData, directory, now = Date.now() }) {
  const company = readCompany(appData);
  if (!company || company.mode !== 'online' || !company.workspace_id) return { status: 'local', why: 'This PC isn\'t linked to a Riyeser Online company. Add people here, or link the PC in Riyeser Central.' };
  let lastError = null;
  for (const online of clients.filter(Boolean)) {
    if (!online.session) continue;
    try {
      const data = await teamData(online, company.workspace_id);
      const mapped = mapTeam({ ...data, business: company.name });
      directory.applyTeam(mapped, now);
      await Promise.resolve(online.refreshLicence ? online.refreshLicence(now) : null).catch(() => null);
      return { status: 'synced', people: mapped.people.length, groups: mapped.groups.length, skipped: mapped.skipped };
    } catch (e) { lastError = e.message; }
  }
  return { status: 'offline', error: lastError || 'Sign in to your Riyeser account to bring in your team.' };
}

module.exports = { centralOnline, teamData, syncFromTeam };
