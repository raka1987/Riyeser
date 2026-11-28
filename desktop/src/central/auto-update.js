// Automatic updates in Riyeser Central ("plug, play and forget", but never during work). Admin panel → Updates (Manage
// this PC → Updates for a person on their own) → "When to install updates":
//   - "Outside work hours" (the default): updates install by themselves only outside this PC's work hours (Mon–Fri
//     8:00–18:00 unless changed; weekends can be ticked as work days), in the PC's own time zone.
//   - "Only when I approve": nothing installs by itself.
//   - "As soon as possible": as soon as each program is closed, any time.
// During work hours NOTHING installs, Central's own update at start and the Windows permission prompt included,
// unless an owner or admin approves: the quiet "N updates ready" item (needs-attention pill and Admin → Updates) has
// "Install now" (the approval, recorded in the history with who and when: closed programs now, open ones as soon as
// they close, still never interrupting anyone) and "Tonight" (wait for the next time outside work hours). Staff see
// "Updates are waiting for an administrator". A PC that's been off every night for a week gets a quiet "Updates have
// been waiting a week: install now or leave the PC on overnight". Downloading in the background happens any time.
// The manual "Update all" stays as it was.
//
// What happens, in order:
//   1. Central checks the release its channel follows (Stable or Early access; updates.js) a minute after it starts
//      and every 6 hours, and downloads each newer installer into a cache folder (%APPDATA%\Riyeser Central\updates),
//      checked the same way as today (installer-check.js). Each file is checked again just before it runs.
//   2. When the time is right (above), every few minutes it installs the other programs' updates, quietly, one by
//      one, only while that program is NOT running and isn't busy (see BUSY below). An open one waits until it closes.
//   3. A program that installs for the whole PC (Riyeser Link Office) needs the Windows permission prompt: asked
//      outside work hours while the PC is idle with no Riyeser program open, at most once a day, with every such
//      update in one prompt (after an approval: as soon as no Riyeser program is open). "No" isn't a failure.
//   4. Riyeser Central's own update goes last, and never interrupts anyone: at its next start when that's outside
//      work hours (or approved), before its window shows, under a small "Updating Riyeser Central…" splash; or while
//      the PC is idle with no Riyeser program open. A start during work hours doesn't update: it waits.
//   5. An update that fails is tried again an hour later; one that fails twice shows under "Needs attention" with
//      Try again (no pop-ups). Each automatic update and approval is written to Central's install log and to this
//      history, and the program list Riyeser HQ sees (program-reports.js, usage-counts.js) goes out soon after.
// Never while demo mode is on and never in a developer's copy.
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
  weekMs: 7 * 24 * 3600 * 1000,          // "waiting a week" reminder
};

// ---------- when updates may install ----------
const MODES = ['outside', 'approve', 'asap'];
const WORK_DEFAULT = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };   // Mon–Fri 8:00–18:00 (0 = Sunday)
/** "When to install updates" from Central's prefs (an older "automatic updates off" counts as "Only when I approve"). */
function modeOf(prefs) {
  const m = prefs && prefs.updateWhen;
  if (MODES.includes(m)) return m;
  return prefs && prefs.autoUpdate === false ? 'approve' : 'outside';
}
const hhmm = (t, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || '')) ? String(t) : d);
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Work hours, tidied: { days: [0..6], start: 'HH:MM', end: 'HH:MM' } (Mon–Fri 8:00–18:00 when not set). */
function workHours(h) {
  const x = h && typeof h === 'object' ? h : {};
  const days = Array.isArray(x.days) ? [...new Set(x.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : WORK_DEFAULT.days;
  return { days, start: hhmm(x.start, WORK_DEFAULT.start), end: hhmm(x.end, WORK_DEFAULT.end) };
}
/** The day of the week (0 = Sunday) and minutes past midnight at `now`, in a time zone (the PC's own when not given). */
function localParts(now, tz) {
  const d = new Date(now);
  if (!tz) return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
/**
 * Is `now` inside the work hours? A shift that ends before it starts (22:00–06:00) runs past midnight: it belongs to
 * the day it starts on, so Friday 22:00–Saturday 06:00 is work time when Friday is a work day. start = end: all day.
 */
function inWorkHours(now, hours, tz) {
  const h = workHours(hours); const { day, minutes } = localParts(now, tz);
  const s = mins(h.start); const e = mins(h.end); const work = (dd) => h.days.includes((dd + 7) % 7);
  if (s === e) return work(day);
  if (s < e) return work(day) && minutes >= s && minutes < e;
  return (work(day) && minutes >= s) || (work(day - 1) && minutes < e);
}
/**
 * Who may approve ("Install now" / "Tonight"): -> the name recorded in the history, or null (staff, or nobody who can).
 * adminState: AdminLock.state(); role: the signed-in person's role in the linked business; email: who's signed in.
 */
function approverFrom({ adminState = {}, role = null, email = '' } = {}) {
  if (adminState.demo) return null;
  if (!adminState.needed) return 'the owner on this PC';            // a person on their own (or a business set up on this PC only)
  if (adminState.open && adminState.email) return adminState.email;  // the unlocked Admin panel
  if ((role === 'owner' || role === 'admin') && email) return email;
  return null;
}
/** An approval ({ items: { id: version } }) covers this update? */
const covers = (a, u) => !!(a && a.items && a.items[u.id] === u.to);
/**
 * May this update install now, as far as the time goes? null when it may, else why ('work-hours' or 'approval').
 * when: { mode, hours, tz }; state: approval (Install now) and tonight (Tonight).
 */
function timeGate(u, { when = {}, state, now }) {
  const mode = MODES.includes(when.mode) ? when.mode : 'outside';
  if (mode === 'asap' || covers(state.approval, u)) return null;
  // "Set a time…" (the Update now? box): a time someone picked; from then on it may install, work hours or not
  if (covers(state.tonight, u) && state.tonight.after) return now >= state.tonight.after ? null : 'scheduled';
  const work = inWorkHours(now, when.hours, when.tz);
  if (mode === 'outside') return work ? 'work-hours' : null;
  return covers(state.tonight, u) && !work ? null : 'approval';   // "Only when I approve" (Tonight: the next window)
}

/**
 * "Tonight (after hours)": the end of today's work hours in the PC's time zone (ms), or now when that's past or today
 * isn't a work day. A shift past midnight (22:00–06:00) ends tomorrow morning.
 */
function afterWork(now, hours) {
  const h = workHours(hours);
  if (!inWorkHours(now, h)) return now;
  const d = new Date(now); const [eh, em] = h.end.split(':').map(Number);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em, 0, 0).getTime();
  return end > now ? end : end + 24 * 3600 * 1000;
}

// Why an update is waiting (shown quietly in Admin → Updates)
const WAITING = {
  off: 'Automatic updates are off',
  'work-hours': 'Installs after work hours',
  approval: 'Waits for an owner or admin to approve it',
  demo: 'Not while demo mode is on',
  downloading: 'Downloading in the background',
  running: 'Installs once it\'s closed',
  'retry-later': 'Will try again soon',
  failed: 'Didn\'t install: needs a look',
  idle: 'Needs Windows permission: asked when the PC is idle',
  'prompt-today': 'Needs Windows permission: asked again tomorrow',
  'after-others': 'Installs after the other programs',
  'next-start': 'Installs the next time Riyeser Central starts',
  scheduled: 'Scheduled',
  'till-open': 'Installs once the till shift is closed',
  unsent: 'Installs once waiting online news has gone out',
};

/** The counts for the install log (sent with "Report an issue"): "auto so far: 3 installed, 0 failed, 1 prompt". */
const tally = (s) => { const c = (s && s.counts) || {}; return `auto so far: ${c.installed || 0} installed, ${c.failed || 0} failed, ${c.prompts || 0} prompt${c.prompts === 1 ? '' : 's'}`; };
const blank = () => ({ cache: {}, items: {}, history: [], lastPrompt: 0, lastCheck: 0, lastError: '', counts: { installed: 0, failed: 0, prompts: 0 }, self: null,
  pending: [], approval: null, tonight: null, waitingSince: 0, lastWindowAt: 0 });
const read = (store) => ({ ...blank(), ...(store.get(STATE, null) || {}) });


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
 * when: { mode, hours, tz } ("When to install updates"); state.approval / state.tonight: Install now / Tonight.
 */
function decide({ updates, state, running, busy = {}, idle = false, now = Date.now(), opts = DEFAULTS, when = {}, demo = false }) {
  const out = { install: [], elevate: [], self: null, waiting: {} };
  const list = updates || [];
  if (demo) { for (const u of list) out.waiting[u.id] = 'demo'; return out; }
  const why1 = (u) => { const b = blockedBy(u, { state, running, busy, now, opts }); return b === 'failed' ? b : timeGate(u, { when, state, now }) || b; };
  const nothingOpen = running !== null && running !== undefined && !running.size;
  for (const u of list.filter((x) => !x.self)) {
    const why = why1(u);
    if (why) out.waiting[u.id] = why; else (u.elevate ? out.elevate : out.install).push(u);
  }
  if (out.elevate.length) {
    // approved by an owner or admin: asked as soon as no Riyeser program is open; otherwise idle, once a day
    const ok = out.elevate.filter((u) => covers(state.approval, u)); const rest = out.elevate.filter((u) => !covers(state.approval, u));
    const restWhy = !rest.length ? null : !idle || !nothingOpen ? 'idle' : state.lastPrompt && now - state.lastPrompt < opts.promptGapMs ? 'prompt-today' : null;
    const okWhy = ok.length && !nothingOpen ? 'idle' : null;
    out.elevate = [...(okWhy ? [] : ok), ...(restWhy ? [] : rest)];
    for (const u of okWhy ? ok : []) out.waiting[u.id] = okWhy;
    for (const u of restWhy ? rest : []) out.waiting[u.id] = restWhy;
  }
  const me = list.find((x) => x.self);
  if (me) {
    let why = why1(me);
    if (!why && (out.install.length || out.elevate.length)) why = 'after-others';
    if (!why && (!idle || !nothingOpen)) why = 'next-start';
    if (why) out.waiting[me.id] = why; else out.self = me;
  }
  return out;
}

/** Central's own update at start: the cached installer to run before the window shows, or null (never in work hours). */
function selfAtStart({ state, appVersion, newer, when = {}, demo = false, busy = {}, opts = DEFAULTS, exists = () => true, now = Date.now() }) {
  if (demo) return null;
  const c = state.cache.central;
  if (!c || !c.file || !c.version || !newer(c.version, appVersion) || !exists(c.file)) return null;
  const item = state.items.central;
  if (item && item.version === c.version && ((item.fails || 0) >= opts.maxFails || (item.nextTry && item.nextTry > now))) return null;
  if (busy.central) return null;
  if (timeGate({ id: 'central', to: c.version }, { when, state, now })) return null;   // a start during work hours: it waits
  return c;
}

/** A quiet line for Admin → Updates: "Updated PDF to 0.26.0 · 2 hours ago" (ago: the window's own wording). */
function lastLine(history, names = {}, ago = (t) => new Date(t).toISOString()) {
  const h = (history || []).find((x) => x.kind !== 'approval' && x.kind !== 'tonight');
  if (!h) return '';
  return `Updated ${names[h.id] || h.name || h.id} to ${h.to} · ${ago(h.at)}`;
}

/**
 * The scheduler. deps (all functions, so the tests can stand in for Windows):
 *   store; now(); when() -> { mode, hours, tz } ("When to install updates"); isDemo(); allowed() (an installed copy on Windows);
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
  const d = { now: Date.now, when: () => ({ mode: 'outside' }), isDemo: () => false, allowed: () => true, log: () => {}, onChange: () => {}, reported: () => {}, manualBusy: () => false,
    running: async () => new Set(), busy: async () => ({}), idle: async () => false, fsx: require('fs'), ...deps };
  const timers = options.timers || { setTimeout, setInterval, clearTimeout, clearInterval };
  let running = null; let lastWaiting = {}; let lastUpdates = []; const handles = [];
  const state = () => read(d.store);
  const save = (fn) => { const s = fn(state()) || state(); d.store.set(STATE, s); return s; };
  const changed = () => { try { d.onChange(summary()); } catch { /* the window may be closed */ } };
  const rm = (f) => { if (f) { try { d.fsx.rmSync(f, { force: true }); } catch { /* left for the next tidy */ } } };
  const live = () => d.allowed() && !d.isDemo();
  const outsideWork = () => !inWorkHours(d.now(), (d.when() || {}).hours, (d.when() || {}).tz);
  /** Note that Central was on outside work hours (for the "waiting a week" reminder). */
  const seenWindow = () => { if (outsideWork()) save((x) => ({ ...x, lastWindowAt: d.now() })); };
  /** The updates waiting, kept so the window can show them before the next check. */
  const remember = (updates) => save((x) => {
    const pending = (updates || []).map((u) => ({ id: u.id, name: u.name, from: u.from, to: u.to, self: !!u.self, elevate: !!u.elevate }));
    const keep = (a) => (a && a.items ? { ...a, items: Object.fromEntries(Object.entries(a.items).filter(([id, v]) => pending.some((p) => p.id === id && p.to === v))) } : null);
    const approval = keep(x.approval); const tonight = keep(x.tonight);
    return { ...x, pending, approval: approval && Object.keys(approval.items).length ? approval : null, tonight: tonight && Object.keys(tonight.items).length ? tonight : null,
      waitingSince: pending.length ? x.waitingSince || d.now() : 0 };
  });

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
      const approvedBy = covers(x.approval, u) ? x.approval.by : null;
      x.pending = (x.pending || []).filter((p) => p.id !== u.id);
      if (!x.pending.length) x.waitingSince = 0;
      x.history = [{ id: u.id, name: u.name, from: u.from, to: u.to, at: d.now(), how: approvedBy ? 'approved' : 'auto', ...(approvedBy ? { approvedBy } : {}) }, ...(x.history || [])].slice(0, opts.historyKeep);
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
    remember(updates); seenWindow();
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
      seenWindow();
      let updates = given && given.updates;
      if (!updates && !Object.keys(state().cache).length) { changed(); return { installed: [], waiting: lastWaiting }; }   // nothing downloaded: nothing to do
      if (!updates) { try { updates = ((await d.status()) || {}).updates || []; } catch { updates = lastUpdates; } }
      lastUpdates = updates; if (!given) remember(updates);
      const [open, busy, idle] = await Promise.all([d.running().catch(() => null), d.busy().catch(() => ({})), d.idle().catch(() => false)]);
      const plan = decide({ updates, state: state(), running: open, busy, idle, now: d.now(), opts, when: d.when() || {} });
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
    const c = selfAtStart({ state: s, appVersion, newer, when: d.when() || {}, demo: d.isDemo(), busy, opts, exists: (f) => d.fsx.existsSync(f), now: d.now() });
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

  /**
   * "Install now": an owner's or admin's approval for every update waiting now (the caller checks who may). Recorded
   * in the history with who and when; closed programs install now, open ones as soon as they're closed.
   */
  function approve({ by = '' } = {}) {
    const s = state(); const items = Object.fromEntries((s.pending || []).map((p) => [p.id, p.to]));
    if (!Object.keys(items).length) return Promise.resolve({ installed: [] });
    save((x) => ({ ...x, approval: { by: by || 'this PC', at: d.now(), items }, tonight: null,
      history: [{ kind: 'approval', by: by || 'this PC', at: d.now(), ids: Object.keys(items), how: 'install now' }, ...(x.history || [])].slice(0, opts.historyKeep) }));
    d.log({ id: 'central', stage: 'approved', how: 'install now', detail: `${Object.entries(items).map(([id, v]) => `${id}@${v}`).join(', ')} by ${by || 'this PC'}` });
    // clear earlier failures of these, then install what can be now
    save((x) => { for (const k of Object.keys(items)) delete x.items[k]; return x; });
    return tick();
  }
  /**
   * "Tonight": leave them for the next time outside work hours (the item goes quiet). From the Update now? box's
   * "Set a time…": items ({ id: version }, default every update waiting) and after (the time picked, ms): they install
   * from then on, as soon as each program is closed.
   */
  function tonight({ by = '', items: only = null, after = null } = {}) {
    const s = state(); const items = only && typeof only === 'object' ? { ...only } : Object.fromEntries((s.pending || []).map((p) => [p.id, p.to]));
    const at = Number(after) > 0 ? Number(after) : null;
    save((x) => ({ ...x, tonight: { by: by || 'this PC', at: d.now(), items, ...(at ? { after: at } : {}) },
      history: [{ kind: 'tonight', by: by || 'this PC', at: d.now(), ids: Object.keys(items), how: at ? `scheduled for ${new Date(at).toISOString()}` : 'tonight' }, ...(x.history || [])].slice(0, opts.historyKeep) }));
    d.log({ id: 'central', stage: 'tonight', how: at ? 'scheduled' : 'tonight', detail: `by ${by || 'this PC'}${at ? ` for ${new Date(at).toISOString()}` : ''}` });
    changed();
    return summary();
  }

  /** For the window: the setting, the last update, what's waiting and why, what needs approving, what needs a look. */
  function summary() {
    const s = state(); const now = d.now(); const when = d.when() || {}; const mode = MODES.includes(when.mode) ? when.mode : 'outside';
    const attention = Object.entries(s.items).filter(([, it]) => (it.fails || 0) >= opts.maxFails)
      .map(([id, it]) => ({ id, version: it.version, error: it.error || '', name: ((s.pending || []).find((u) => u.id === id) || lastUpdates.find((u) => u.id === id) || {}).name || id }));
    const waiting = Object.fromEntries(Object.entries(lastWaiting).map(([id, why]) => [id, WAITING[why] || why]));
    const pending = d.isDemo() ? [] : (s.pending || []);
    // "N updates ready": waiting for a time or an approval (not in "As soon as possible", not once approved or left for tonight)
    const ready = mode === 'asap' ? [] : pending.filter((u) => !covers(s.approval, u) && !covers(s.tonight, u));
    const since = Math.max(s.waitingSince || 0, 0);
    const week = mode === 'outside' && pending.length > 0 && !!since && now - since >= opts.weekMs && now - (s.lastWindowAt || 0) >= opts.weekMs;
    const hours = workHours(when.hours);
    return { mode, hours, inWork: inWorkHours(now, when.hours, when.tz), demo: d.isDemo(), allowed: d.allowed(),
      last: s.history.find((h) => h.kind !== 'approval' && h.kind !== 'tonight') || null, history: s.history.slice(0, 10), waiting, attention,
      pending, ready, week, approval: s.approval, tonight: s.tonight, lastCheck: s.lastCheck || 0, counts: { ...s.counts }, cached: Object.keys(s.cache) };
  }

  /** The timers: a first check after a minute, a check every 6 hours, a look every 5 minutes. */
  function start() {
    const unref = (h) => { if (h && typeof h.unref === 'function') h.unref(); return h; };
    handles.push(unref(timers.setTimeout(() => check(), opts.firstCheckMs)));
    handles.push(unref(timers.setInterval(() => check(), opts.checkEveryMs)));
    handles.push(unref(timers.setInterval(() => tick(), opts.tickEveryMs)));
  }
  function stop() { for (const h of handles.splice(0)) { timers.clearTimeout(h); timers.clearInterval(h); } }

  return { check, tick, atStart, retry, approve, tonight, summary, start, stop, state, busy: () => !!running };
}

module.exports = { afterWork, STATE, DEFAULTS, WAITING, MODES, WORK_DEFAULT, COMPANY_FILE, busyFrom, runningIds, tally, modeOf, approverFrom, workHours, localParts, inWorkHours, timeGate, covers,
  blockedBy, decide, selfAtStart, lastLine, createAutoUpdater, read };
