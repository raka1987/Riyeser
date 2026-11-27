// Anonymous usage counts (Riyeser HQ → Downloads: "New installs" and "Updates"). Settings → "Send anonymous usage
// counts" (on unless turned off).
// What's sent, to track_install in Riyeser's database (website/team/team-chat.sql), with the publishable key and no
// sign-in: a random install id made on this PC (not the PC's id used for linking), what happened ("new" the first
// time Central runs here, "existing" when this PC had Central before counting began, "add" when a program is added,
// "update" when one is updated, with its new version), the Riyeser programs installed, Central's version, the Windows
// version, and the business's country when this PC is linked to one. Never a name, email, PC name, address or file.
// Demo mode, developer copies and CI machines are marked test, so HQ leaves them out.
// Once the PC is linked to a business (signed in), install_link ties the install id to it: counted once already, not again.
const crypto = require('crypto');
const { newer } = require('./updates');

const STATE = 'usage-counts';
const SETTING = 'usage-counts-setting';
// Keys Central writes once it has run: any of them means this PC had Central before usage counts began.
const EARLIER_KEYS = ['updateCheck', 'device', 'company-setup', 'locations', 'programs-reported', 'online', 'team', 'checklist'];
const CI_VARS = ['CI', 'GITHUB_ACTIONS', 'TF_BUILD', 'JENKINS_URL', 'BUILDKITE', 'GITLAB_CI', 'CIRCLECI', 'TEAMCITY_VERSION', 'RIYESER_TEST'];

const isCi = (env = process.env) => CI_VARS.some((k) => env[k] && env[k] !== 'false' && env[k] !== '0');
/** Before anything else is written on this start: had this PC run Central before usage counts existed? */
const hadCentralBefore = (store) => !store.get(STATE, null) && EARLIER_KEYS.some((k) => store.get(k, null) != null);
const enabled = (store) => { const s = store.get(SETTING, null); return !(s && s.off === true); };
function setEnabled(store, on) { store.set(SETTING, { off: !on, at: new Date().toISOString() }); return enabled(store); }

/** What to send now: the first note, then adds and updates against the versions last sent. */
function pending(state, installed, firstKind) {
  const ids = Object.keys(installed || {}).filter((id) => /^[a-z0-9-]{1,40}$/.test(id)).sort();
  if (!state.counted) return [{ kind: firstKind === 'existing' ? 'existing' : 'new', detail: '', programs: ids }];
  const out = []; const was = state.versions || {};
  for (const id of ids) {
    const v = installed[id] == null ? null : String(installed[id]).slice(0, 30);
    if (!(id in was)) out.push({ kind: 'add', detail: id, programs: [id], version: v });
    else if (v && /^[0-9][0-9a-z.+-]*$/i.test(v) && (!was[id] || newer(v, was[id]))) out.push({ kind: 'update', detail: `${id}@${v}`.toLowerCase(), programs: [id], version: v });
  }
  return out;
}

/**
 * store: Central's Store; config(): {url, key} (riyeser.com/link/config.js); fetchFn; isDemo(); packaged: an installed
 * copy (false for a developer's copy); appVersion; osVersion; readCompany(): company.json or null; link(id, ws): the
 * signed-in install_link call (or null when not signed in); firstKind: 'existing' when hadCentralBefore() at start.
 */
function createUsageCounts({ store, config, fetchFn, isDemo = () => false, packaged = true, appVersion = '', osVersion = '', readCompany = () => null,
  link = null, firstKind = 'new', env = process.env }) {
  let busy = null;
  const state = () => store.get(STATE, null) || {};
  const save = (fn) => store.update(STATE, {}, (s) => fn({ ...(s || {}) }));
  async function send(c, ev, s, test, country) {
    const r = await fetchFn(`${c.url}/rest/v1/rpc/track_install`, { method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ install_id: s.installId, kind: ev.kind, detail: ev.detail, programs: ev.programs, central_version: String(appVersion || '').slice(0, 40),
        os_version: String(osVersion || '').slice(0, 60), country: country || null, test }) });
    return r.ok;
  }
  /** installed: {programId: version} (Central's installedVersions). Returns what was sent; never throws. */
  async function tick(installed) {
    if (busy) return busy;
    busy = (async () => {
      if (!enabled(store)) return { off: true, sent: [] };
      const c = await config().catch(() => null);
      if (!c || !/^https:\/\//.test(c.url || '') || !c.key) return { sent: [] };
      let s = state();
      if (!s.installId) s = save((x) => ({ ...x, installId: crypto.randomUUID(), created: new Date().toISOString() }));
      const company = readCompany() || null;
      const linked = company && company.mode === 'online' && company.workspace_id ? company : null;
      const test = !!(isDemo() || !packaged || isCi(env));
      const sent = [];
      for (const ev of pending(s, installed, firstKind)) {
        let ok = false; try { ok = await send(c, ev, s, test, linked ? String(linked.country || '').slice(0, 40) : null); } catch { ok = false; }
        if (!ok) break;   // offline, or Riyeser's database doesn't have it yet: tried again next time
        sent.push(ev.kind === 'update' || ev.kind === 'add' ? `${ev.kind} ${ev.detail}` : ev.kind);
        s = save((x) => {
          const versions = { ...(x.versions || {}) };
          if (ev.kind === 'new' || ev.kind === 'existing') { for (const [id, v] of Object.entries(installed || {})) versions[id] = v == null ? null : String(v); return { ...x, counted: ev.kind, versions }; }
          versions[ev.programs[0]] = ev.version; return { ...x, versions };
        });
      }
      // a program that's gone is forgotten, so putting it back counts as added again
      if (s.counted && installed) s = save((x) => ({ ...x, versions: Object.fromEntries(Object.entries(x.versions || {}).filter(([id]) => id in installed)) }));
      if (s.counted && linked && s.linkedWs !== linked.workspace_id && typeof link === 'function') {
        try { if (await link(s.installId, linked.workspace_id) !== false) { save((x) => ({ ...x, linkedWs: linked.workspace_id })); sent.push('link'); } } catch { /* next time */ }
      }
      return { sent };
    })().finally(() => { busy = null; });
    return busy;
  }
  return { tick, enabled: () => enabled(store), setEnabled: (on) => setEnabled(store, on), state };
}

module.exports = { createUsageCounts, pending, hadCentralBefore, enabled, setEnabled, isCi, CI_VARS, STATE, SETTING };
