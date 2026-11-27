// Riyeser online connections: Riyeser Central's sync loop, on ONE PC per business (the sync PC).
//
// Every minute, while this PC is signed in, linked to the business and is the sync PC:
//   1. anything filed earlier but not yet marked in the post box (we were offline) is marked now;
//   2. it claims a batch from the online post box (api_inbox_claim: a 10-minute lease, so two PCs never get the same
//      item), hands it to the program that holds the company file (local-app.js -> Riyeser Accounting's local API,
//      which files each item once, by its post-box id), then marks each item done (api_inbox_done) or turned down /
//      to try again (api_inbox_fail, retry true for a problem on this PC);
//   3. news the program has for websites (booking confirmed/cancelled, order ready/completed) goes out (api_notify);
//   4. /internal/kick, so webhooks go out at once rather than with the 5-minute job;
//   5. catalogue/prices, stock and free times are published when they changed since last time (looked at every
//      minute, so "right after a change" is within a minute) and anyway every 6 h / 24 h / 1 h.
// Offline: nothing is lost. Unclaimed items stay in the post box; claimed ones come back after their lease; filed
// ones are replayed by the program with the same answer. It waits longer between tries (30 s doubling to 15 min).
//
// Which PC: Settings → Online connections. "Automatic" (the default) = the PC that holds the company file.
// "This PC" = always this one. "Off" = never.
const crypto = require('crypto');

const BATCH = 20;
const MAX_BATCHES = 5;
const AGES = { catalog: 6 * 3600e3, stock: 24 * 3600e3, availability: 3600e3 };
const MODES = ['auto', 'on', 'off'];
const NOTIFY_KINDS = { booking: 'New online booking', order: 'New online order' };

const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const offline = (e) => !e || e.code === 'OFFLINE' || (!e.status && !e.code && !/sign in/i.test(String(e.message || '')));

/** A plain fix for what went wrong. */
function fixFor(e) {
  const m = String((e && e.message) || '');
  if (e && e.code === 'NO_PROGRAM') return 'Install Riyeser Accounting, Bookings or POS on this PC, or choose another PC in Settings → Online connections.';
  if (e && e.code === 'NOT_RUNNING') return 'Open Riyeser Accounting (or Bookings, POS) on this PC once, then leave it to Central.';
  if (e && e.code === 'no_company') return 'Set up the company file in Riyeser Accounting on this PC first.';
  if (/link this pc/i.test(m)) return 'Open the Company page and sign in again, so this PC is linked to the business.';
  if (/sign in/i.test(m) || (e && e.status === 401)) return 'Open the Company page and sign in to your Riyeser account again.';
  if (/schema cache|PGRST202|does not exist/i.test(m)) return 'Riyeser Online is still being switched on for this. Nothing is lost; it starts by itself.';
  return 'It will be tried again in a minute. If it keeps happening, use Get help.';
}

function createSync({ online, local, store, appData, readCompany, isDemo = () => false, notify = () => {}, onChange = () => {},
  now = () => Date.now(), timers = { setTimeout, clearTimeout }, intervalMs = 60000, pcName = '' }) {
  const S = () => ({ mode: 'auto', pub: {}, recent: [], received: { day: '', n: 0 }, failures: 0, ...(store.get('online-sync', {}) || {}) });
  const save = (patch) => { const s = { ...S(), ...patch }; store.set('online-sync', s); onChange(publicStatus(s)); return s; };
  const pending = () => store.get('online-sync-pending', []) || [];
  let timer = null; let running = null; let stopped = true;

  function eligible(s = S()) {
    const c = readCompany(appData);
    if (!c || c.mode !== 'online' || !c.workspace_id) return { ok: false, state: 'idle', message: 'This PC isn\'t linked to a business on Riyeser Online.', fix: 'Sign in on the Company page to link it.' };
    if (!online.session) return { ok: false, state: 'idle', message: 'Not signed in to Riyeser Online on this PC.', fix: 'Sign in on the Company page.' };
    if (s.mode === 'off') return { ok: false, state: 'off', message: 'This PC doesn\'t bring in online orders and bookings.', fix: 'Turn it on in Settings → Online connections if this is the PC with the company file.' };
    if (isDemo()) return { ok: false, state: 'paused', message: 'Demo mode is on: online orders and bookings wait in your post box until you leave demo mode.', fix: '' };
    if (s.mode === 'auto' && !local.hasCompanyFile()) return { ok: false, state: 'idle', message: 'Another PC brings in online orders and bookings: the one with the company file.', fix: 'If this is that PC, choose "This PC" in Settings → Online connections.' };
    return { ok: true, ws: c.workspace_id };
  }

  function publicStatus(s = S()) {
    const el = eligible(s);
    const today = day(now());
    return { mode: s.mode, syncing: el.ok, state: el.ok ? (s.state || 'starting') : el.state, message: el.ok ? (s.message || '') : el.message, fix: el.ok ? (s.fix || '') : el.fix,
      lastSyncAt: s.lastSyncAt || null, lastTryAt: s.lastTryAt || null, receivedToday: s.received && s.received.day === today ? s.received.n : 0,
      lastPublishAt: Math.max(0, ...Object.values(s.pub || {}).map((p) => p.at || 0)) || null, publishNote: s.publishNote || '',
      counts: s.counts || null, recent: (s.recent || []).slice(0, 10), pendingMarks: pending().length, failures: s.failures || 0 };
  }

  const rpc = (name, args) => online.rpc(name, args);

  /** Mark one item in the post box; if we're offline it's kept and marked next time. */
  async function mark(ws, device, m) {
    try {
      if (m.how === 'done') await rpc('api_inbox_done', { ws, device, event_id: m.id, result: m.result || {} });
      else await rpc('api_inbox_fail', { ws, device, event_id: m.id, reason: String(m.reason || 'Couldn\'t be filed.').slice(0, 500), retry: !!m.retry, result: m.retry ? null : (m.result || null) });
      return true;
    } catch (e) {
      if (offline(e)) { store.set('online-sync-pending', [...pending().filter((x) => x.id !== m.id), m]); throw e; }
      return false;   // e.g. the lease ran out and another PC has it: that PC answers it (the program gives the same answer)
    }
  }
  async function flushPending(ws, device) {
    for (const m of pending()) {
      await mark(ws, device, m);   // throws when still offline
      store.set('online-sync-pending', pending().filter((x) => x.id !== m.id));
    }
  }

  async function publish(ws, device, s, force) {
    const pub = { ...(s.pub || {}) }; const notes = []; let sent = 0;
    const jobs = [
      ['catalog', () => local.catalog(), (d) => rpc('api_publish_catalog', { ws, device, items: d.items || [], full_sync: true })],
      ['stock', () => local.stock(), (d) => rpc('api_publish_stock', { ws, device, levels: d.levels || [], full_sync: true })],
      ['availability', () => local.availability(), (d) => rpc('api_publish_availability', { ws, device, settings: d.settings || null,
        staff: d.enabled === false ? [] : (d.staff || []), open_times: d.enabled === false ? [] : (d.open_times || []), from_at: d.from_at || null, to_at: d.to_at || null })],
    ];
    for (const [k, read, send] of jobs) {
      const d = await read();
      const { skipped, ...body } = d || {};
      const h = hash(body); const p = pub[k] || {};
      if (!force && p.hash === h && now() - (p.at || 0) < AGES[k]) continue;
      try { const r = await send(d); pub[k] = { hash: h, at: now(), result: r || null }; sent += 1; } catch (e) {
        if (offline(e)) throw e;
        notes.push(`${k === 'availability' ? 'Free times' : k === 'stock' ? 'Stock' : 'Prices'}: ${e.message}`);
        pub[k] = { ...p, error: e.message, errorAt: now() };
      }
    }
    return { pub, sent, note: notes.join(' ') };
  }

  async function run({ force = false } = {}) {
    let s = S();
    const el = eligible(s);
    if (!el.ok) { save({ state: el.state, message: el.message, fix: el.fix }); return publicStatus(); }
    if (!force && s.backoffUntil && now() < s.backoffUntil) return publicStatus(s);
    const ws = el.ws; const device = online.deviceId();
    s = save({ lastTryAt: now() });
    let filed = 0; let gotNews = false; const recent = [...(s.recent || [])]; const today = day(now());
    let received = s.received && s.received.day === today ? s.received.n : 0;
    try {
      await local.ensure();
      await flushPending(ws, device);
      for (let b = 0; b < MAX_BATCHES; b++) {
        const items = await rpc('api_inbox_claim', { ws, device, kinds: null, max_items: BATCH });
        if (!Array.isArray(items) || !items.length) break;
        let results;
        try { results = (await local.importItems(items)).results || []; } catch (e) {
          // the program went away mid-way: back to the post box (anything it did file is answered the same next time)
          for (const it of items) await mark(ws, device, { id: it.id, how: 'fail', retry: true, reason: `This PC couldn't file it just now: ${e.message}` });
          throw e;
        }
        const byId = new Map(results.map((r) => [r.id, r]));
        for (const it of items) {
          const r = byId.get(it.id) || { outcome: 'retry', reason: 'The program didn\'t answer for this one.' };
          const m = r.outcome === 'done' ? { id: it.id, how: 'done', result: r.result }
            : r.outcome === 'rejected' ? { id: it.id, how: 'fail', retry: false, reason: r.reason || 'Turned down.', result: r.result }
              : { id: it.id, how: 'fail', retry: true, reason: r.reason || 'A problem on this PC.' };
          const ok = await mark(ws, device, m);
          if (r.outcome !== 'retry') {
            filed += 1;
            if (!it.test && !r.replay) received += 1;
            recent.unshift({ id: it.id, kind: r.order_request ? 'order_request' : it.kind, test: !!it.test, outcome: r.outcome, reference: (r.result && r.result.reference) || '', customer: r.customer || '', at: now(), marked: ok });
            const title = r.order_request ? 'New order request' : NOTIFY_KINDS[it.kind];
            if (r.outcome === 'done' && !it.test && !r.replay && title) {
              try { notify({ title, body: [r.customer, r.result && r.result.reference, r.result && r.result.state].filter(Boolean).join(' · '), kind: it.kind, id: it.id }); } catch { /* a notification is a nice extra */ }
            }
          }
        }
        if (items.length < BATCH) break;
      }
      // news for websites
      const out = (await local.outbox()) || {};
      const sent = []; const errors = {};
      for (const ev of out.events || []) {
        try { await rpc('api_notify', { ws, device, event: ev.event, event_id: ev.event_id || null, data: ev.data || {} }); sent.push(ev.id); } catch (e) {
          if (offline(e)) { if (sent.length) await local.outboxDone(sent, errors); throw e; }
          errors[ev.id] = e.message;
        }
      }
      if (sent.length || Object.keys(errors).length) await local.outboxDone(sent, errors);
      gotNews = sent.length > 0;
      if (filed || gotNews) { try { await online.call('/functions/v1/api/internal/kick', { method: 'POST', body: { ws, device } }); } catch { /* the 5-minute job sends them */ } }
      const p = await publish(ws, device, s, force);
      let counts = s.counts || null;
      try { counts = await rpc('api_inbox_counts', { ws, device }); } catch (e) { if (offline(e)) throw e; }
      s = save({ state: 'ok', message: '', fix: '', lastSyncAt: now(), failures: 0, backoffUntil: 0, pub: p.pub, publishNote: p.note, counts,
        recent: recent.slice(0, 30), received: { day: today, n: received } });
    } catch (e) {
      const failures = (S().failures || 0) + 1;
      const wait = Math.min(30000 * 2 ** (failures - 1), 15 * 60000);
      const off = offline(e);
      s = save({ state: off ? 'offline' : 'error', failures, backoffUntil: now() + wait, recent: recent.slice(0, 30), received: { day: today, n: received },
        message: off ? 'No connection to Riyeser Online. Orders and bookings wait in your online post box and come in when it\'s back.' : e.message,
        fix: off ? 'Check this PC\'s internet connection. Nothing is lost.' : fixFor(e) });
    }
    const st = publicStatus(s);
    await local.report({ at: new Date(now()).toISOString(), ok: s.state === 'ok', error: s.state === 'ok' ? null : s.message, fix: s.fix || null, pc: pcName || null,
      received_today: st.receivedToday, last_publish: st.lastPublishAt ? new Date(st.lastPublishAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null,
      waiting: s.counts ? s.counts.waiting : null, failed: s.counts ? s.counts.failed : null, offline: s.state === 'offline' });
    return st;
  }

  function schedule() {
    if (stopped) return;
    if (timer) timers.clearTimeout(timer);
    const s = S();
    const wait = s.backoffUntil && s.backoffUntil > now() ? s.backoffUntil - now() : intervalMs;
    timer = timers.setTimeout(() => { timer = null; tick(); }, wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  /** One go now (one at a time). force: ignore the wait after a failure and publish everything again. */
  function tick(opts) {
    if (running) return running;
    running = run(opts || {}).catch(() => publicStatus()).finally(() => { running = null; schedule(); });
    return running;
  }
  return {
    start(delayMs = 15000) { stopped = false; if (timer) timers.clearTimeout(timer); timer = timers.setTimeout(() => { timer = null; tick(); }, delayMs); if (timer && timer.unref) timer.unref(); },
    stop() { stopped = true; if (timer) timers.clearTimeout(timer); timer = null; },
    tick,
    poke: () => tick({ force: true }),
    status: () => publicStatus(),
    setMode(mode) { if (!MODES.includes(mode)) throw new Error('Choose Automatic, This PC or Off.'); save({ mode, backoffUntil: 0 }); return publicStatus(); },
    eligible: () => eligible(),
  };
}

module.exports = { createSync, fixFor, MODES, BATCH, AGES };
