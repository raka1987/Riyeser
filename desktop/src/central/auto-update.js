// Automatic updates in Riyeser Central ("plug, play and forget"). Admin panel → Updates (Manage this PC → Updates for
// a person on their own) → "Install updates automatically", on unless turned off. The manual "Update all" stays.
//
// What happens, in order:
//   1. Central checks the release its channel follows (Stable or Early access; updates.js) a minute after it starts
//      and every 6 hours, and downloads each newer installer into a cache folder (%APPDATA%\Riyeser Central\updates),
//      checked the same way as today (installer-check.js). Each file is checked again just before it runs.
//   2. Every few minutes it installs the other programs' updates, quietly, one by one, only while that program is
//      NOT running and isn't busy (an open till shift in POS, website news still waiting to go out from the company
//      file; see BUSY below). A program that's open is tried again once it's closed.
//   3. A program that installs for the whole PC (Riyeser Link Office) needs the Windows permission prompt. That's
//      asked only while the PC is idle with no Riyeser program open, at most once a day, with every such update in the
//      same prompt. "No" on the prompt isn't a failure: it's asked again the next day.
//   4. Riyeser Central's own update goes last, and never interrupts anyone: the next time Central starts (before its
//      window shows, under a small "Updating Riyeser Central…" splash), or while the PC is idle with no Riyeser
//      program open. Otherwise it waits for the next start.
//   5. An update that fails is tried again an hour later; one that fails twice shows under "Needs attention" with
//      Try again (no pop-ups). Each automatic update is written to Central's install log and to this history, and
//      the program list Riyeser HQ sees (program-reports.js, usage-counts.js) goes out soon after.
// Never while demo mode is on, never in a developer's copy, and never when the setting is off.
//
// Busy signals the programs give (anything else relies on "the program isn't running"):
//   - POS: a till shift still open (pos_shifts.status = 'open' in the company file).
//   - Accounting Plus, Accounting Basics, Invoices, Bookings, POS, Estimate: website news still unsent in the company
//     file (online_outbox rows not yet sent, from the last 3 days).
//   - Riyeser Central: online-connection marks still waiting to go out (online-sync-pending).
//   - Payroll keeps no "pay run open" record (a pay run is saved only when it's finished), so Payroll is updated only
//     while it isn't running. The same for Link's messages waiting to send (they live inside Link while it runs).
const path = require('path');

const STATE = 'auto-update';
const DEFAULTS = {
  firstCheckMs: 60 * 1000,              // the first check, a minute after Central starts
  checkEveryMs: 6 * 3600 * 1000,        // then every 6 hours
  tickEveryMs: 5 * 60 * 1000,           // install what's ready every 5 minutes (a program closed since)
  retryMs: 60 * 60 * 1000,              // a failed update is tried again an hour later
  maxFails: 2,                          // ...and after two failures it waits for Try again
  promptGapMs: 24 * 3600 * 1000,        // at most one Windows permission prompt a day
  historyKeep: 30,
};

// Why an update is waiting (shown quietly in Admin → Updates)
const WAITING = {
  off: 'Automatic updates are off',
  demo: 'Not while demo mode is on',
  downloading: 'Downloading in the background',
  running: 'Installs once it\'s closed',
  'retry-later': 'Will try again soon',
  failed: 'Didn\'t install: needs a look',
  idle: 'Needs Windows permission: asked when the PC is idle',
  'prompt-today': 'Needs Windows permission: asked again tomorrow',
  'after-others': 'Installs after the other programs',
  'next-start': 'Installs the next time Riyeser Central starts',
  'till-open': 'Installs once the till shift is closed',
  unsent: 'Installs once waiting online news has gone out',
};

/** The counts for the install log (sent with "Report an issue"): "auto so far: 3 installed, 0 failed, 1 prompt". */
const tally = (s) => { const c = (s && s.counts) || {}; return `auto so far: ${c.installed || 0} installed, ${c.failed || 0} failed, ${c.prompts || 0} prompt${c.prompts === 1 ? '' : 's'}`; };
const blank = () => ({ cache: {}, items: {}, history: [], lastPrompt: 0, lastCheck: 0, lastError: '', counts: { installed: 0, failed: 0, prompts: 0 }, self: null });
const read = (store) => ({ ...blank(), ...(store.get(STATE, null) || {}) });

/** Is the setting on? prefs: Central's prefs ("autoUpdate" false = off; on by default). */
const settingOn = (prefs) => !(prefs && prefs.autoUpdate === false);

// The programs that open the business's company file (the books): its busy signals hold them back.
const COMPANY_FILE = ['accounting', 'accounting-basics', 'invoices', 'bookings', 'pos', 'estimate'];
/**
 * The busy signals as { id: why }: company (sources.companyBusy: { tillOpen, unsent }), centralPending (Central's own
 * online marks still waiting to go out). Payroll and the others have none: they wait only while they're running.
 */
function busyFrom({ company = null, centralPending = 0 } = {}) {
  const out = {};
  if (company && company.tillOpen) out.pos = 'till-open';
  if (company && company.unsent) for (const id of COMPANY_FILE) if (!out[id]) out[id] = 'unsent';
  if (centralPending) out.central = 'unsent';
  return out;
}

/** Which programs are open, from Windows' list of running programs (freshstart.runningImages): a Set of ids, or null. */
function runningIds(images, programs) {
  if (!images) return null;
  const live = new Set(images.map((n) => String(n).toLowerCase()));
  return new Set((programs || []).filter((p) => (p.exes || []).some((e) => live.has(e.toLowerCase()))).map((p) => p.id));
}

/**
 * Why one update can't install right now (null: it can). Checks that apply to every program, Central included.
 * state: the saved state; running: Set of program ids running (null: couldn't tell); busy: { id: reason }.
 */
function blockedBy(u, { state, running, busy = {}, now, opts = DEFAULTS }) {
  const item = state.items[u.id];
  if (item && item.version === u.to) {
    if ((item.fails || 0) >= opts.maxFails) return 'failed';
    if (item.nextTry && item.nextTry > now) return 'retry-later';
  }
  const c = state.cache[u.id];
  if (!c || c.version !== u.to || !c.file) return 'downloading';
  if (!u.self && (running === null || running === undefined || running.has(u.id))) return 'running';   // can't tell = treat as open
  if (busy[u.id]) return busy[u.id];
  return null;
}

/**
 * What to do now, from the updates waiting (updates.availableUpdates) -> { install, elevate, self, waiting: { id: why } }.
 * install: quiet installs one by one; elevate: together through one Windows permission prompt; self: Central's own
 * update (only when nothing else is left to do now, the PC is idle and no Riyeser program is open).
 */
function decide({ updates, state, running, busy = {}, idle = false, now = Date.now(), opts = DEFAULTS, on = true, demo = false }) {
  const out = { install: [], elevate: [], self: null, waiting: {} };
  const list = updates || [];
  if (!on || demo) { for (const u of list) out.waiting[u.id] = demo ? 'demo' : 'off'; return out; }
  for (const u of list.filter((x) => !x.self)) {
    const why = blockedBy(u, { state, running, busy, now, opts });
    if (why) out.waiting[u.id] = why; else (u.elevate ? out.elevate : out.install).push(u);
  }
  if (out.elevate.length) {
    const why = !idle || running === null || (running && running.size) ? 'idle' : state.lastPrompt && now - state.lastPrompt < opts.promptGapMs ? 'prompt-today' : null;
    if (why) { for (const u of out.elevate) out.waiting[u.id] = why; out.elevate = []; }
  }
  const me = list.find((x) => x.self);
  if (me) {
    let why = blockedBy(me, { state, running, busy, now, opts });
    if (!why && (out.install.length || out.elevate.length)) why = 'after-others';
    if (!why && (!idle || running === null || (running && running.size))) why = 'next-start';
    if (why) out.waiting[me.id] = why; else out.self = me;
  }
  return out;
}

/** Central's own update at start: the cached installer to run before the window shows, or null. */
function selfAtStart({ state, appVersion, newer, on = true, demo = false, busy = {}, opts = DEFAULTS, exists = () => true, now = Date.now() }) {
  if (!on || demo) return null;
  const c = state.cache.central;
  if (!c || !c.file || !c.version || !newer(c.version, appVersion) || !exists(c.file)) return null;
  const item = state.items.central;
  if (item && item.version === c.version && ((item.fails || 0) >= opts.maxFails || (item.nextTry && item.nextTry > now))) return null;
  if (busy.central) return null;
  return c;
}

/** A quiet line for Admin → Updates: "Updated PDF to 0.26.0 · 2 hours ago" (ago: the window's own wording). */
function lastLine(history, names = {}, ago = (t) => new Date(t).toISOString()) {
  const h = (history || [])[0];
  if (!h) return '';
  return `Updated ${names[h.id] || h.name || h.id} to ${h.to} · ${ago(h.at)}`;
}

/**
 * The scheduler. deps (all functions, so the tests can stand in for Windows):
 *   store; now(); enabled(); isDemo(); allowed() (an installed copy on Windows);
 *   status({ fresh }) -> { updates, latest } (the release's updates for this PC; fresh: ask the release, not the cache); download(u, file) -> saves the installer;
 *   verify(file, u, manifest) -> { ok, error }; running() -> Set of program ids open (null: couldn't tell);
 *   busy() -> { id: reason }; idle() -> the PC has been idle with no Riyeser program in use;
 *   install(u, file) -> { ok, reason, message }; installBatch([{ u, file }]) -> { id: { ok, reason, message } };
 *   installSelf(u, file, when) -> starts Central's own installer (Central closes and opens again);
 *   log(entry); onChange(summary); reported() (tell Riyeser the new versions); manualBusy() (Update all is running);
 *   cacheDir; fsx (fs).
 */
function createAutoUpdater(deps, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const d = { now: Date.now, enabled: () => true, isDemo: () => false, allowed: () => true, log: () => {}, onChange: () => {}, reported: () => {}, manualBusy: () => false,
    running: async () => new Set(), busy: async () => ({}), idle: async () => false, fsx: require('fs'), ...deps };
  const timers = options.timers || { setTimeout, setInterval, clearTimeout, clearInterval };
  let running = null; let lastWaiting = {}; let lastUpdates = []; const handles = [];
  const state = () => read(d.store);
  const save = (fn) => { const s = fn(state()) || state(); d.store.set(STATE, s); return s; };
  const changed = () => { try { d.onChange(summary()); } catch { /* the window may be closed */ } };
  const rm = (f) => { if (f) { try { d.fsx.rmSync(f, { force: true }); } catch { /* left for the next tidy */ } } };
  const live = () => d.allowed() && d.enabled() && !d.isDemo();

  function fail(u, f) {
    const s = save((x) => {
      const prev = x.items[u.id] && x.items[u.id].version === u.to ? x.items[u.id] : {};
      const fails = (prev.fails || 0) + 1;
      x.items[u.id] = { version: u.to, fails, nextTry: d.now() + opts.retryMs, error: (f && (f.message || f.reason)) || 'It didn\'t install.', at: d.now() };
      x.counts.failed = (x.counts.failed || 0) + 1;
      return x;
    });
    d.log({ id: u.id, version: u.to, stage: 'failed', reason: (f && f.reason) || 'failed', how: 'auto', detail: `${(f && f.message) || ''} · ${tally(s)}` });
    return s;
  }
  function done(u) {
    const s = save((x) => {
      const c = x.cache[u.id]; if (c) rm(c.file);
      delete x.cache[u.id]; delete x.items[u.id];
      x.history = [{ id: u.id, name: u.name, from: u.from, to: u.to, at: d.now(), how: 'auto' }, ...(x.history || [])].slice(0, opts.historyKeep);
      x.counts.installed = (x.counts.installed || 0) + 1;
      return x;
    });
    d.log({ id: u.id, version: u.to, stage: 'installed', reason: 'installed', how: 'auto', detail: `${u.from} -> ${u.to} · ${tally(s)}` });
  }
  /** The cached file, checked again just before it runs (a file changed since it was downloaded is thrown away). */
  async function checked(u) {
    const c = state().cache[u.id];
    let r; try { r = await d.verify(c.file, u, c.manifest); } catch (e) { r = { ok: false, error: e.message }; }
    if (r && r.ok) return c.file;
    save((x) => { rm(c.file); delete x.cache[u.id]; return x; });
    fail(u, { reason: 'check', message: (r && r.error) || 'The download couldn\'t be checked.' });
    return null;
  }

  /** Look for updates and download them into the cache (then install what can be). Never throws. */
  async function check() {
    if (!live()) { changed(); return { skipped: true }; }
    let st;
    // the 6-hourly check asks the release itself (the 5-minute looks use what Central already knows)
    try { st = await d.status({ fresh: true }); } catch (e) { save((x) => ({ ...x, lastCheck: d.now(), lastError: e.message })); changed(); return { error: e.message }; }
    const updates = (st && st.updates) || []; lastUpdates = updates;
    const latest = st && st.latest;
    // drop cached files for versions that aren't wanted any more (installed by hand, or a newer one came out)
    save((x) => {
      for (const [id, c] of Object.entries(x.cache)) { const u = updates.find((y) => y.id === id); if (!u || u.to !== c.version) { rm(c.file); delete x.cache[id]; } }
      for (const id of Object.keys(x.items)) { const u = updates.find((y) => y.id === id); if (!u || u.to !== x.items[id].version) delete x.items[id]; }
      return { ...x, lastCheck: d.now(), lastError: '' };
    });
    for (const u of updates) {
      const s = state(); const c = s.cache[u.id];
      if (c && c.version === u.to && c.file && d.fsx.existsSync(c.file)) continue;
      const item = s.items[u.id];
      if (item && item.version === u.to && ((item.fails || 0) >= opts.maxFails || (item.nextTry && item.nextTry > d.now()))) continue;
      const file = path.join(d.cacheDir, `${u.id}-${u.to}-${u.file || path.basename(new URL(u.url).pathname)}`);
      try {
        d.fsx.mkdirSync(d.cacheDir, { recursive: true });
        await d.download(u, file);
        const r = await d.verify(file, u, latest && latest.manifest);
        if (!r || !r.ok) throw Object.assign(new Error((r && r.error) || 'The download couldn\'t be checked.'), { reason: 'check' });
        save((x) => { x.cache[u.id] = { version: u.to, file, name: u.file, digest: u.digest || null, manifest: (latest && latest.manifest) || null, at: d.now() }; return x; });
        d.log({ id: u.id, version: u.to, file: path.basename(file), stage: 'checked', how: 'auto' });
      } catch (e) {
        rm(file);
        // offline: just tried again at the next check; a download that doesn't check out counts as a failure
        if (e.reason === 'check') fail(u, { reason: 'check', message: e.message });
        else save((x) => ({ ...x, lastError: e.message }));
      }
    }
    return tick({ updates });
  }

  /** Install what's ready now. Never throws. given: { updates } to skip asking the release again. */
  async function tick(given) {
    if (running) return running;
    running = (async () => {
      if (!live() || d.manualBusy()) { changed(); return { skipped: true }; }
      let updates = given && given.updates;
      if (!updates && !Object.keys(state().cache).length) { changed(); return { installed: [], waiting: lastWaiting }; }   // nothing downloaded: nothing to do
      if (!updates) { try { updates = ((await d.status()) || {}).updates || []; } catch { updates = lastUpdates; } }
      lastUpdates = updates;
      const [open, busy, idle] = await Promise.all([d.running().catch(() => null), d.busy().catch(() => ({})), d.idle().catch(() => false)]);
      const plan = decide({ updates, state: state(), running: open, busy, idle, now: d.now(), opts });
      lastWaiting = plan.waiting;
      const did = [];
      for (const u of plan.install) {
        if (d.manualBusy()) break;
        const file = await checked(u); if (!file) continue;
        let r; try { r = await d.install(u, file); } catch (e) { r = { ok: false, reason: 'failed', message: e.message }; }
        if (r && r.ok) { done(u); did.push(u.id); } else if (r && r.reason === 'running') lastWaiting[u.id] = 'running';   // opened meanwhile: not a failure
        else fail(u, r);
      }
      if (plan.elevate.length && !d.manualBusy()) {
        const list = [];
        for (const u of plan.elevate) { const file = await checked(u); if (file) list.push({ u, file }); }
        if (list.length) {
          save((x) => ({ ...x, lastPrompt: d.now(), counts: { ...x.counts, prompts: (x.counts.prompts || 0) + 1 } }));
          let res; try { res = await d.installBatch(list); } catch (e) { res = Object.fromEntries(list.map(({ u }) => [u.id, { ok: false, reason: 'failed', message: e.message }])); }
          for (const { u } of list) {
            const r = (res || {})[u.id];
            if (r && r.ok) { done(u); did.push(u.id); } else if (r && r.reason === 'cancelled') lastWaiting[u.id] = 'prompt-today';   // "No": asked again tomorrow
            else fail(u, r);
          }
        }
      }
      if (did.length) { try { d.reported(); } catch { /* sent at the next check-in */ } }
      if (plan.self && !d.manualBusy()) {
        const u = plan.self; const file = await checked(u);
        if (file) {
          save((x) => ({ ...x, self: { version: u.to, from: u.from, tries: ((x.self && x.self.version === u.to && x.self.tries) || 0) + 1, at: d.now(), when: 'idle' } }));
          d.log({ id: 'central', version: u.to, stage: 'self', how: 'auto (idle)' });
          d.installSelf(u, file, 'idle');
          did.push('central');
        }
      }
      changed();
      return { installed: did, waiting: lastWaiting };
    })().finally(() => { running = null; });
    return running;
  }

  /**
   * At Central's start, before the window: the cached Central update to install now (the caller shows the splash
   * and runs it), or null. Also notes a Central update that finished since last time. busy: { central: reason }.
   */
  function atStart({ appVersion, newer, busy = {} }) {
    let s = state();
    if (s.self && s.self.version && !newer(s.self.version, appVersion)) {   // Central's own update went in
      const was = s.self;
      save((x) => {
        const c = x.cache.central; if (c && !newer(c.version, appVersion)) { rm(c.file); delete x.cache.central; }
        delete x.items.central;
        x.history = [{ id: 'central', name: 'Riyeser Central', from: was.from, to: appVersion, at: d.now(), how: 'auto' }, ...(x.history || [])].slice(0, opts.historyKeep);
        x.counts.installed = (x.counts.installed || 0) + 1;
        return { ...x, self: null };
      });
      d.log({ id: 'central', version: appVersion, stage: 'installed', reason: 'installed', how: 'auto', detail: `${was.from} -> ${appVersion} · ${tally(state())}` });
      s = state();
    } else if (s.self && s.self.version && newer(s.self.version, appVersion) && s.self.tries) {
      // the last try didn't take: count it as a failure (twice and it waits for Try again)
      fail({ id: 'central', to: s.self.version }, { reason: 'failed', message: 'Riyeser Central\'s update didn\'t finish.' });
      save((x) => ({ ...x, self: null }));
      s = state();
    }
    if (!d.allowed()) return null;
    const c = selfAtStart({ state: s, appVersion, newer, on: d.enabled(), demo: d.isDemo(), busy, opts, exists: (f) => d.fsx.existsSync(f), now: d.now() });
    if (!c) return null;
    save((x) => ({ ...x, self: { version: c.version, from: appVersion, tries: 1, at: d.now(), when: 'start' } }));
    d.log({ id: 'central', version: c.version, stage: 'self', how: 'auto (start)' });
    return c;
  }

  /** Try again (the "Needs attention" button): forgets the failures, then installs what can be now. */
  function retry(id) {
    save((x) => { for (const k of Object.keys(x.items)) if (!id || k === id) delete x.items[k]; return x; });
    return check();
  }

  /** For the window: the setting, the last update, what's waiting and why, and what needs a look. */
  function summary() {
    const s = state();
    const attention = Object.entries(s.items).filter(([, it]) => (it.fails || 0) >= opts.maxFails)
      .map(([id, it]) => ({ id, version: it.version, error: it.error || '', name: (lastUpdates.find((u) => u.id === id) || {}).name || id }));
    const waiting = Object.fromEntries(Object.entries(lastWaiting).map(([id, why]) => [id, WAITING[why] || why]));
    return { on: d.enabled(), demo: d.isDemo(), allowed: d.allowed(), last: s.history[0] || null, history: s.history.slice(0, 10), waiting, attention,
      lastCheck: s.lastCheck || 0, counts: { ...s.counts }, ready: Object.keys(s.cache) };
  }

  /** The timers: a first check after a minute, a check every 6 hours, a look every 5 minutes. */
  function start() {
    const unref = (h) => { if (h && typeof h.unref === 'function') h.unref(); return h; };
    handles.push(unref(timers.setTimeout(() => check(), opts.firstCheckMs)));
    handles.push(unref(timers.setInterval(() => check(), opts.checkEveryMs)));
    handles.push(unref(timers.setInterval(() => tick(), opts.tickEveryMs)));
  }
  function stop() { for (const h of handles.splice(0)) { timers.clearTimeout(h); timers.clearInterval(h); } }

  return { check, tick, atStart, retry, summary, start, stop, state, busy: () => !!running };
}

module.exports = { STATE, DEFAULTS, WAITING, COMPANY_FILE, busyFrom, runningIds, tally, settingOn, blockedBy, decide, selfAtStart, lastLine, createAutoUpdater, read };
