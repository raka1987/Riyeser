// Riyeser online connections: Riyeser Central's sync loop, on ONE PC per business (the sync PC).
//
// Every minute, while this PC is signed in, linked to the business and is the sync PC:
//   0. a cheap look at where things stand in Riyeser Online (api_status: keys, webhooks, anything ever received,
//      what's waiting, what's published, which PC syncs). Nothing set up and nothing waiting: "Not set up", and
//      nothing else runs (no program is started, nothing is published, no errors are shown);
//   1. anything filed earlier but not yet marked in the post box (we were offline) is marked now;
//   2. it claims a batch from the online post box (api_inbox_claim: a 10-minute lease, so two PCs never get the same
//      item), hands it to the program that holds the company file (local-app.js -> Riyeser Accounting's local API,
//      which files each item once, by its post-box id), then marks each item done (api_inbox_done) or turned down /
//      to try again (api_inbox_fail, retry true for a problem on this PC);
//   3. news the program has for websites (booking confirmed/cancelled, order ready/completed) goes out (api_notify);
//   4. /internal/kick, so webhooks go out at once rather than with the 5-minute job;
//   5. catalogue/prices, stock and free times are published when they changed since last time (looked at every
//      minute, so "right after a change" is within a minute) and anyway every 6 h / 24 h / 1 h. A publish that fails
//      is a problem shown with the program's plain message, but never stops items coming in.
// Offline: nothing is lost. Unclaimed items stay in the post box; claimed ones come back after their lease; filed
// ones are replayed by the program with the same answer. It waits longer between tries (30 s doubling to 15 min).
// Everything it does goes in the activity trail (online-trail.js), which the program's Online → Activity page shows too.
//
// What the panel says (status().view): not_setup · waiting ("Connected · nothing new") · working · problem ·
// offline · off (another PC syncs: which one) · paused (demo mode) · idle (not linked / signed in) · starting.
//
// Which PC: Settings → Online connections. "Automatic" (the default) = the PC that holds the company file.
// "This PC" = always this one. "Off" = never.
const crypto = require('crypto');
const path = require('path');
const { Trail } = require('./online-trail');
const { productOf } = require('./local-app');

const BATCH = 20;
const MAX_BATCHES = 5;
const AGES = { catalog: 6 * 3600e3, stock: 24 * 3600e3, availability: 3600e3 };
const MODES = ['auto', 'on', 'off'];
const NOTIFY_KINDS = { booking: 'New online booking', order: 'New online order' };
const KIND_WORD = { booking: 'booking', order: 'order', order_request: 'order request', enquiry: 'enquiry', customer: 'customer', quote_accept: 'quote acceptance', invoice_payment: 'payment' };
const PUB_WORD = { catalog: 'prices', stock: 'stock levels', availability: 'free booking times' };
const CLOUD_EVERY = { syncing: 0, other: 5 * 60e3, missing: 3600e3 };

const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const offline = (e) => !e || e.code === 'OFFLINE' || (!e.status && !e.code && !/sign in/i.test(String(e.message || '')));
const missingRpc = (e) => e && (e.status === 404 || /PGRST202|Could not find the function|schema cache/i.test(String(e.message || '')));

/** A plain fix for what went wrong. */
function fixFor(e) {
  const m = String((e && e.message) || '');
  if (e && e.code === 'NO_PROGRAM') return 'Install Riyeser Accounting, Bookings or POS on this PC, or choose another PC in Settings → Online connections.';
  if (e && e.code === 'NOT_RUNNING') return 'Open Riyeser Accounting (or Bookings, POS) on this PC once, then leave it to Central.';
  if (e && e.code === 'no_company') return 'Set up the company file in Riyeser Accounting on this PC first.';
  if (/link this pc/i.test(m)) return 'Open the Company page and sign in again, so this PC is linked to the business.';
  if (/sign in/i.test(m) || (e && e.status === 401 && !e.local)) return 'Open the Company page and sign in to your Riyeser account again.';
  if (/schema cache|PGRST202|does not exist/i.test(m)) return 'Riyeser Online is still being switched on for this. Nothing is lost; it starts by itself.';
  if (e && e.local && e.status >= 500 && !e.plain) return `Update ${String(e.program || 'the program').replace(/ \(serve\)$/, '')} (Riyeser Central shows when an update is ready), then press Sync now. If it keeps happening, use Get help: the details go with it.`;
  if (/time-zone data/i.test(m)) return 'Update the program on this PC (the new version brings its own time zones), or choose UTC under Online connections settings in it. Items still come in meanwhile.';
  return 'It will be tried again in a minute. If it keeps happening, use Get help: the details go with it.';
}

function sourceOf(it) {
  if (it.test || it.source === 'test') return `Test${it.key_name ? ` · ${it.key_name}` : ''}`;
  return `${it.source === 'widget' ? 'Booking form' : 'Website'}${it.key_name ? ` · ${it.key_name}` : ''}`;
}

function createSync({ online, local, store, appData, readCompany, isDemo = () => false, notify = () => {}, onChange = () => {},
  now = () => Date.now(), timers = { setTimeout, clearTimeout }, intervalMs = 60000, pcName = '', trailFile = null }) {
  const S = () => ({ mode: 'auto', pub: {}, recent: [], received: { day: '', n: 0 }, failures: 0, ...(store.get('online-sync', {}) || {}) });
  const save = (patch) => { const s = { ...S(), ...patch }; store.set('online-sync', s); onChange(publicStatus(s)); return s; };
  const pending = () => store.get('online-sync-pending', []) || [];
  const trail = new Trail({ file: trailFile || path.join(store.dir || appData || '.', 'online-trail.json'), now });
  let timer = null; let running = null; let stopped = true;

  function eligible(s = S()) {
    const c = readCompany(appData);
    if (!c || c.mode !== 'online' || !c.workspace_id) return { ok: false, state: 'idle', message: 'This PC isn\'t linked to a business on Riyeser Online.', fix: 'Sign in on the Company page to link it.' };
    if (!online.session) return { ok: false, state: 'idle', message: 'Not signed in to Riyeser Online on this PC.', fix: 'Sign in on the Company page.' };
    if (s.mode === 'off') return { ok: false, state: 'off', ws: c.workspace_id, message: 'This PC doesn\'t bring in online orders and bookings.', fix: 'Turn it on in Settings → Online connections if this is the PC with the company file.' };
    if (isDemo()) return { ok: false, state: 'paused', message: 'Demo mode is on: online orders and bookings wait in your post box until you leave demo mode.', fix: '' };
    if (s.mode === 'auto' && !local.hasCompanyFile()) return { ok: false, state: 'off', other: true, ws: c.workspace_id, message: 'Another PC brings in online orders and bookings: the one with the company file.', fix: 'If this is that PC, choose "This PC" in Settings → Online connections.' };
    return { ok: true, ws: c.workspace_id };
  }

  /** The panel's state, from the sync state and what Riyeser Online said. */
  function viewOf(s, el) {
    if (!el.ok) return el.state;   // idle, off, paused
    const st = ['off', 'idle', 'paused'].includes(s.state) ? 'starting' : (s.state || 'starting');
    if (st === 'offline') return 'offline';
    if (st === 'error') return 'problem';
    if (st === 'not_setup') return 'not_setup';
    if (st === 'starting') return 'starting';
    const today = day(now());
    const got = s.received && s.received.day === today ? s.received.n : 0;
    return got > 0 || (s.recent || []).some((r) => day(r.at) === today && !r.test) ? 'working' : 'waiting';
  }

  function publicStatus(s = S()) {
    const el = eligible(s);
    const today = day(now());
    const c = s.cloud || null;
    return { mode: s.mode, syncing: el.ok, state: el.ok ? (s.state === 'not_setup' ? 'ok' : ['off', 'idle', 'paused'].includes(s.state) ? 'starting' : (s.state || 'starting')) : el.state, view: viewOf(s, el),
      message: el.ok ? (s.message || '') : el.message, fix: el.ok ? (s.fix || '') : el.fix, ref: el.ok ? (s.ref || '') : '', problemProduct: s.problemProduct || '',
      lastSyncAt: s.lastSyncAt || null, lastTryAt: s.lastTryAt || null, lastCheckAt: s.lastCheckAt || null, receivedToday: s.received && s.received.day === today ? s.received.n : 0,
      lastPublishAt: Math.max(0, ...Object.values(s.pub || {}).map((p) => p.at || 0)) || null, publishNote: s.publishNote || '',
      counts: s.counts || null, recent: (s.recent || []).slice(0, 10), pendingMarks: pending().length, failures: s.failures || 0,
      cloud: c, cloudMissing: !!s.cloudMissing, syncPc: c && c.sync_pc ? c.sync_pc.name : '', otherPc: !!el.other,
      test: s.test || null, checklist: checklist(s), pc: pcName || '' };
  }

  /** The guide's checklist, ticked from what really happened. */
  function checklist(s) {
    const c = s.cloud || {}; const pub = c.published || {};
    return [
      { id: 'key', text: 'A key made in Riyeser Link', done: !!(c.keys && c.keys.active) },
      { id: 'request', text: 'Your website has talked to Riyeser Online', done: !!c.last_request_at },
      { id: 'sync', text: 'A PC brings items in', done: !!(c.sync_pc || s.lastSyncAt) },
      { id: 'item', text: 'The first item arrived on this PC', done: !!(s.everReceived || (s.recent || []).length || (s.test && s.test.step === 'arrived')) },
      { id: 'publish', text: 'Prices and free times published', done: !!(pub.catalog_at || pub.availability_at || Object.keys(s.pub || {}).length) },
    ];
  }

  const rpc = (name, args) => online.rpc(name, args);

  /** Where things stand in Riyeser Online (cached; skipped for an hour on a database without api_status). */
  async function cloudStatus(ws, device, s, every) {
    if (s.cloudMissing && now() - (s.cloudAt || 0) < CLOUD_EVERY.missing) return s.cloud || null;
    if (every && s.cloudAt && now() - s.cloudAt < every) return s.cloud || null;
    try {
      const c = await rpc('api_status', { ws, device });
      if (c && s.cloud && !s.cloud.set_up && c.set_up) trail.add({ type: 'setup', status: 'info', what: 'Online connections set up', detail: `${(c.keys && c.keys.active) || 0} key(s) in Riyeser Link`, pc: pcName });
      save({ cloud: c || null, cloudAt: now(), cloudMissing: false, lastCheckAt: now() });
      return c || null;
    } catch (e) {
      if (missingRpc(e)) { save({ cloudMissing: true, cloudAt: now() }); return null; }
      throw e;
    }
  }

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
    const pub = { ...(s.pub || {}) }; const notes = []; let sent = 0; let problem = null;
    const jobs = [
      ['catalog', () => local.catalog(), (d) => rpc('api_publish_catalog', { ws, device, items: d.items || [], full_sync: true }),
        (d, r) => `Published ${(r && r.saved) != null ? r.saved : (d.items || []).length} prices${r && r.skipped && r.skipped.length ? ` (${r.skipped.length} skipped)` : ''}`],
      ['stock', () => local.stock(), (d) => rpc('api_publish_stock', { ws, device, levels: d.levels || [], full_sync: true }),
        (d) => (d.enabled === false ? 'Stock levels not shown on your website (turned off)' : `Published stock for ${(d.levels || []).length} items`)],
      ['availability', () => local.availability(), (d) => rpc('api_publish_availability', { ws, device, settings: d.settings || null,
        staff: d.enabled === false ? [] : (d.staff || []), open_times: d.enabled === false ? [] : (d.open_times || []), from_at: d.from_at || null, to_at: d.to_at || null }),
      (d) => (d.enabled === false ? 'Free booking times cleared (online bookings off)' : `Published ${(d.open_times || []).length} free times for ${(d.staff || []).length} staff`)],
    ];
    for (const [k, read, send, words] of jobs) {
      let d;
      try { d = await read(); } catch (e) {
        if (e.code === 'NOT_RUNNING' || offline(e)) throw e;
        const p = pub[k] || {};
        if (p.errorMsg !== e.message || now() - (p.errorAt || 0) > 3600e3) trail.add({ type: 'publish', status: 'error', what: e.message, detail: fixFor(e), ref: e.ref, source: e.program, pc: pcName });
        pub[k] = { ...p, error: e.message, errorMsg: e.message, errorAt: now() };
        notes.push(e.message); problem = problem || e;
        continue;
      }
      const { skipped, ...body } = d || {};
      const h = hash(body); const p = pub[k] || {};
      if (!force && p.hash === h && now() - (p.at || 0) < AGES[k] && !p.error) continue;
      try {
        const r = await send(d); pub[k] = { hash: h, at: now(), result: r || null }; sent += 1;
        if (p.hash !== h || force) trail.add({ type: 'publish', status: 'ok', what: words(d, r), source: 'Riyeser Online', pc: pcName });
      } catch (e) {
        if (offline(e)) throw e;
        const msg = `Your ${PUB_WORD[k]} couldn't be published: ${e.message}`;
        notes.push(msg);
        if (p.errorMsg !== msg) trail.add({ type: 'publish', status: 'error', what: msg, detail: fixFor(e), pc: pcName });
        pub[k] = { ...p, error: e.message, errorMsg: msg, errorAt: now() };
      }
    }
    return { pub, sent, note: notes.join(' '), problem };
  }

  /** Send a test through the post box (api_send_test). From the panel, or asked for on the program's Online page. */
  async function sendTestNow(ws, device, kind, from = 'central') {
    const r = await rpc('api_send_test', { ws, device, kind });
    const t = { id: r.id, kind, at: now(), step: 'sent', from };
    trail.add({ type: 'test', status: 'waiting', what: `Test ${KIND_WORD[kind] || kind} sent through your post box`, source: from === 'program' ? 'Online page' : 'Riyeser Central', ref: String(r.id).slice(0, 8), pc: pcName });
    save({ test: t });
    return t;
  }

  async function run({ force = false } = {}) {
    let s = S();
    const el = eligible(s);
    if (!el.ok) {
      // off (or another PC syncs): say which PC does, now and then
      if (el.state === 'off' && el.ws) { try { await cloudStatus(el.ws, online.deviceId(), s, CLOUD_EVERY.other); } catch { /* only a nicety */ } }
      if (s.state !== el.state || s.message !== el.message) save({ state: el.state, message: el.message, fix: el.fix, ref: '' });
      if (el.state === 'off' || el.state === 'paused') {
        const c = (S().cloud) || {};
        await local.peek().then((p) => p && local.report({ at: new Date(now()).toISOString(), ok: true, state: el.state, pc: pcName || null,
          cloud: { sync_pc: c.sync_pc && !c.sync_pc.this_pc ? c.sync_pc.name : null, keys_active: c.keys ? c.keys.active : null } })).catch(() => null);
      }
      trail.save();
      return publicStatus();
    }
    if (!force && s.backoffUntil && now() < s.backoffUntil) return publicStatus(s);
    const ws = el.ws; const device = online.deviceId();
    s = save({ lastTryAt: now() });
    let filed = 0; let gotNews = false; const recent = [...(s.recent || [])]; const today = day(now());
    let received = s.received && s.received.day === today ? s.received.n : 0;
    let testSent = null; let counts = s.counts || null;
    const runNote = { filed: 0, rejected: 0, retry: 0, tests: 0 };
    try {
      const cloud = await cloudStatus(ws, device, s, CLOUD_EVERY.syncing);
      s = S();
      const waiting = cloud && cloud.inbox ? (cloud.inbox.waiting || 0) + (cloud.inbox.taken || 0) : 0;
      // Not set up (and nothing waiting, and no test asked for on the program's Online page): stay quiet.
      if (cloud && !cloud.set_up && !waiting && !pending().length && !(s.test && s.test.step === 'sent')) {
        const prog = await local.peek();
        const ask = prog && prog.test_request && prog.test_request.id !== s.testRequestDone ? prog.test_request : null;
        if (!ask) {
          if (s.state !== 'not_setup') trail.add({ type: 'setup', status: 'info', what: 'Checked: online connections aren\'t set up yet', detail: 'No API keys, widgets or webhooks for this business in Riyeser Online.', pc: pcName });
          s = save({ state: 'not_setup', message: '', fix: '', ref: '', failures: 0, backoffUntil: 0, lastCheckAt: now() });
          if (prog) await reportNow(s, null);
          trail.save();
          return publicStatus(s);
        }
      }
      const st = await local.ensure();
      const ask = st && st.test_request && st.test_request.id !== s.testRequestDone ? st.test_request : null;
      if (ask) {
        try { const t = await sendTestNow(ws, device, ask.kind, 'program'); testSent = { request_id: ask.id, event_id: t.id }; } catch (e) {
          if (offline(e)) throw e;
          testSent = { request_id: ask.id, error: e.message };
          trail.add({ type: 'test', status: 'error', what: `The test couldn't be sent: ${e.message}`, source: 'Online page', pc: pcName });
        }
        save({ testRequestDone: ask.id });
      }
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
          const kind = r.order_request ? 'order_request' : it.kind;
          const ref = (r.result && r.result.reference) || '';
          const isTest = !!it.test || it.source === 'test';
          trail.add({ type: isTest ? 'test' : 'item', status: r.outcome === 'retry' ? 'retry' : r.outcome, source: sourceOf(it), ref, pc: pcName,
            what: r.outcome === 'done' ? `${isTest ? 'Test arrived: ' : ''}${r.replay ? 'Answered again (already filed) as' : 'Filed as'} ${KIND_WORD[kind] || kind}${ref ? ` ${ref}` : ''}`
              : r.outcome === 'rejected' ? `Turned down: ${(r.result && r.result.message) || r.reason || 'the business can\'t take it'}`
                : `Waiting to try again: ${r.reason || 'a problem on this PC'}`,
            detail: [r.customer, r.outcome === 'rejected' && r.reason && r.reason !== (r.result || {}).message ? r.reason : '', isTest ? 'A test: nothing was added to the books.' : ''].filter(Boolean).join(' · ') });
          runNote[r.outcome === 'done' ? 'filed' : r.outcome === 'rejected' ? 'rejected' : 'retry'] += 1;
          if (isTest) runNote.tests += 1;
          const t = S().test;
          if (t && t.id === it.id && r.outcome !== 'retry') save({ test: { ...t, step: 'arrived', outcome: r.outcome, reference: ref, message: (r.result && r.result.message) || '', arrivedAt: now() } });
          if (r.outcome !== 'retry') {
            filed += 1;
            if (!isTest && !r.replay) received += 1;
            recent.unshift({ id: it.id, kind, test: isTest, outcome: r.outcome, reference: ref, customer: r.customer || '', at: now(), marked: ok });
            const title = r.order_request ? 'New order request' : NOTIFY_KINDS[it.kind];
            if (r.outcome === 'done' && !isTest && !r.replay && title) {
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
      if (sent.length) trail.add({ type: 'run', status: 'ok', what: `Told your website: ${(out.events || []).filter((e) => sent.includes(e.id)).map((e) => e.event.replace('.', ' ')).join(', ')}`, pc: pcName });
      gotNews = sent.length > 0;
      if (filed || gotNews) { try { await online.call('/functions/v1/api/internal/kick', { method: 'POST', body: { ws, device } }); } catch { /* the 5-minute job sends them */ } }
      const p = await publish(ws, device, s, force);
      try { counts = await rpc('api_inbox_counts', { ws, device }); } catch (e) { if (offline(e)) throw e; }
      const n = runNote.filed + runNote.rejected + runNote.retry;
      if (!n && !gotNews && !p.sent && !p.problem) trail.quiet('Checked: nothing new', pcName);
      else if (n) trail.add({ type: 'run', status: runNote.retry ? 'retry' : 'ok', pc: pcName, what: `Synced: ${[runNote.filed && `${runNote.filed} filed`, runNote.rejected && `${runNote.rejected} turned down`, runNote.retry && `${runNote.retry} to try again`].filter(Boolean).join(', ')}${runNote.tests ? ` (${runNote.tests} test)` : ''}` });
      const pp = p.problem;
      s = save({ state: pp ? 'error' : 'ok', message: pp ? pp.message : '', fix: pp ? fixFor(pp) : '', ref: pp ? (pp.ref || '') : '', problemProduct: pp ? productOf(pp.program) : '',
        lastSyncAt: now(), failures: 0, backoffUntil: 0, pub: p.pub, publishNote: pp ? '' : p.note, counts,
        recent: recent.slice(0, 30), received: { day: today, n: received }, everReceived: S().everReceived || filed > 0 });
    } catch (e) {
      const failures = (S().failures || 0) + 1;
      const wait = Math.min(30000 * 2 ** (failures - 1), 15 * 60000);
      const off = offline(e);
      const msg = off ? 'No connection to Riyeser Online. Orders and bookings wait in your online post box and come in when it\'s back.' : e.message;
      const prev = S();
      if (prev.message !== msg) trail.add({ type: 'problem', status: 'error', what: msg, detail: off ? 'Nothing is lost.' : fixFor(e), ref: e.ref, source: e.program || (off ? 'Riyeser Online' : ''), pc: pcName });
      s = save({ state: off ? 'offline' : 'error', failures, backoffUntil: now() + wait, recent: recent.slice(0, 30), received: { day: today, n: received },
        message: msg, fix: off ? 'Check this PC\'s internet connection. Nothing is lost.' : fixFor(e), ref: (!off && e.ref) || '', problemProduct: e.local ? productOf(e.program) : 'central' });
    }
    await reportNow(s, testSent);
    trail.save();
    return publicStatus(s);
  }

  /** Tell the program on this PC what happened (its Online page and Activity), with the new trail lines. */
  async function reportNow(s, testSent) {
    const st = publicStatus(s); const c = s.cloud || {};
    const lines = trail.pending();
    const body = { at: new Date(now()).toISOString(), ok: s.state === 'ok' || s.state === 'not_setup', error: st.view === 'problem' || st.view === 'offline' ? s.message : null,
      fix: s.fix || null, ref: s.ref || null, pc: pcName || null, state: st.view === 'starting' ? 'waiting' : st.view,
      received_today: st.receivedToday, last_publish: st.lastPublishAt ? new Date(st.lastPublishAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null,
      waiting: s.counts ? s.counts.waiting : null, failed: s.counts ? s.counts.failed : null, offline: s.state === 'offline',
      checked_at: s.lastCheckAt ? new Date(s.lastCheckAt).toISOString() : null,
      cloud: s.cloud ? { keys_active: c.keys ? c.keys.active : 0, widget_keys: c.keys ? c.keys.widget : 0, test_keys: c.keys ? c.keys.test : 0,
        webhooks_active: c.webhooks ? c.webhooks.active : 0, webhooks_failing: c.webhooks ? c.webhooks.failing : 0, last_request_at: c.last_request_at || null,
        requests_24h: c.requests_24h || 0, done_total: c.inbox ? c.inbox.done_total : 0, catalog_items: c.published ? c.published.catalog_items : 0,
        catalog_at: c.published ? c.published.catalog_at : null, stock_at: c.published ? c.published.stock_at : null, availability_at: c.published ? c.published.availability_at : null,
        sync_pc: c.sync_pc ? c.sync_pc.name : null } : null,
      trail: lines, ...(testSent ? { test_sent: testSent } : {}) };
    try { await local.request('sync-report', { method: 'POST', body }); trail.sent(lines); } catch { /* the program isn't open: next time */ }
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
  /** "Send a test" from Central: through the real post box; this PC (or the sync PC) brings it in within a minute. */
  async function sendTest(kind) {
    if (!['booking', 'enquiry', 'order'].includes(kind)) throw new Error('Choose a test booking, enquiry or order request.');
    const c = readCompany(appData);
    if (!c || c.mode !== 'online' || !c.workspace_id || !online.session) throw new Error('Sign in on the Company page first, so this PC is linked to your business.');
    if (running) await running.catch(() => null);
    try { await sendTestNow(c.workspace_id, online.deviceId(), kind, 'central'); } catch (e) {
      trail.add({ type: 'test', status: 'error', what: `The test couldn't be sent: ${e.message}`, source: 'Riyeser Central', pc: pcName }); trail.save();
      throw e;
    }
    trail.save();
    if (eligible().ok) { const go = timers.setTimeout(() => tick(), 1500); if (go && go.unref) go.unref(); }
    return publicStatus();
  }
  /** Where the last test is (asks Riyeser Online when another PC brings it in). */
  async function testStatus() {
    const s = S(); const t = s.test;
    if (!t || t.step !== 'sent') return publicStatus(s);
    const c = readCompany(appData);
    try {
      const e = await rpc('api_event_status', { ws: c.workspace_id, device: online.deviceId(), event_id: t.id });
      if (e && ['done', 'rejected', 'failed'].includes(e.status) && !eligible(s).ok) {
        save({ test: { ...t, step: 'arrived', outcome: e.status, reference: (e.result || {}).reference || '', message: (e.result || {}).message || '', pc: e.taken_by_pc || '', arrivedAt: now() } });
      } else if (e) save({ test: { ...t, cloudStatus: e.status, pc: e.taken_by_pc || '' } });
    } catch { /* shown as still on its way */ }
    return publicStatus();
  }
  return {
    start(delayMs = 15000) { stopped = false; if (timer) timers.clearTimeout(timer); timer = timers.setTimeout(() => { timer = null; tick(); }, delayMs); if (timer && timer.unref) timer.unref(); },
    stop() { stopped = true; if (timer) timers.clearTimeout(timer); timer = null; trail.save(true); },
    tick,
    poke: () => tick({ force: true }),
    status: () => publicStatus(),
    setMode(mode) { if (!MODES.includes(mode)) throw new Error('Choose Automatic, This PC or Off.'); save({ mode, backoffUntil: 0 }); trail.add({ type: 'setup', status: 'info', what: `Settings: ${({ auto: 'Automatic', on: 'This PC', off: 'Off on this PC' })[mode]}`, pc: pcName }); trail.save(); return publicStatus(); },
    eligible: () => eligible(),
    sendTest,
    testStatus,
    trail: (q) => ({ rows: trail.list(q || {}), days: trail.days_(), total: trail.rows.length }),
    trailCsv: (q) => Trail.csv(trail.list({ ...(q || {}), limit: 100000 })),
    trailObj: trail,
  };
}

module.exports = { createSync, fixFor, MODES, BATCH, AGES };
