// Riyeser Central 1.9 home screen, "App launcher": what goes on it, as plain functions (no window or Electron), so the
// tests load this file too. central.js draws what these return, through window.RiyeserLauncher.
//
//   audience()   who is looking: 'owner' (or admin), 'staff', or 'individual' (someone on their own: just programs)
//   tiles()      one big icon per installed program, each with one short live line ("3 today", "Fri pay run",
//                "2 unread", "Trial · 87 days"); programs on the plan that aren't here yet; and "+ Add a program"
//   chips()      the small status chips under the grid, only when there is something worth saying
//   attention()  only things that are really broken and important (the "N things need attention" pill)
//   searchLocal() programs and their one-click jobs that match what was typed (files and customers come from Central)
(function (root) {
  // One order everywhere (tiles, Add a program, updates), the same as riyeser.com.
  const ORDER = ['central', 'desk', 'invoices', 'pdf', 'accounting-basics', 'accounting', 'bookings', 'estimate', 'team', 'linkoffice', 'payroll', 'pos', 'services'];
  const byOrder = (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b);

  // One-click jobs, each only while its program is installed. They're in the search box and in each tile's ⋯ menu.
  // page: the program opens on that screen (programs that don't know the page just open normally).
  const JOBS = [
    { p: 'pos', t: 'Open the till', s: 'Ring up a sale', page: 'pos' },
    { p: 'acc', t: 'New invoice', s: 'Bill a customer', page: 'invoice' },
    { p: 'bookings', t: 'New booking', s: 'Jobs, appointments, tables' },
    { p: 'estimate', t: 'New estimate', s: 'Measure a job and quote it', page: 'estimate' },
    { p: 'invoices', t: 'New invoice', s: 'Bill a customer', page: 'invoice' },   // free Invoices, when Accounting isn't installed
    { p: 'payroll', t: 'Run payroll', s: 'Timesheets to payslips', page: 'payrun' },
    { p: 'desk', t: 'Documents Inbox', s: 'New scans and uploads to file' },
    { p: 'desk', t: 'Find a document', s: 'Names and text inside scans', act: 'find' },
    { p: 'pdf', t: 'Open a PDF', s: 'Fill in, sign or edit', act: 'pickpdf' },
    { p: 'pdf', t: 'Combine PDFs', s: 'Join files into one', page: 'combine' },
    { p: 'services', t: 'Projects', s: 'Projects, drawings and QA', page: 'projects' },
  ];

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const dayOf = (s) => new Date(`${String(s).slice(0, 10)}T12:00:00`);
  const daysBetween = (a, b) => Math.round((dayOf(ymd(b)) - dayOf(ymd(a))) / 86400000);
  const weekday = (s) => dayOf(s).toLocaleDateString('en-AU', { weekday: 'short' });
  const moneyShort = (n) => `$${Math.round(Number(n || 0)).toLocaleString('en-AU')}`;

  function firstName(name, email) {
    return String(name || '').trim().split(/\s+/)[0] || '';
  }
  function greeting(now = new Date(), name = '') {
    const h = now.getHours(); const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    return name ? `${part}, ${name}` : part;
  }

  /**
   * Who is looking at this PC. company: company.json (or null); kind: 'personal'|'business'|null; role: the signed-in
   * person's role in the business ('owner'|'admin'|'member'|null); demo: demo mode is on (Sample Trading Co).
   * -> { who: 'owner'|'staff'|'individual', linked: an online business, business: its name }
   */
  function audience({ company = null, kind = null, role = null, demo = false } = {}) {
    if (demo) return { who: 'owner', linked: false, business: 'Sample Trading Co', demo: true };
    const c = company || null;
    if (!c || !c.name) return { who: 'individual', linked: false, business: '' };
    const k = kind || c.kind || null;
    if (k === 'personal') return { who: 'individual', linked: false, business: '' };
    if (c.mode !== 'online' || !c.workspace_id) return { who: 'owner', linked: false, business: c.name };   // set up on this PC only
    return { who: role === 'owner' || role === 'admin' ? 'owner' : 'staff', linked: true, business: c.name, role: role || null };
  }

  /** A paid program's plan state, in a few words for its tile ('' when there's nothing worth saying, e.g. paid up). */
  function planLine(st) {
    if (!st) return null;
    const t = String(st.text || '');
    let m = /^Free trial, (\d+) days? left/i.exec(t);
    if (m) return { text: `Trial · ${m[1]} day${m[1] === '1' ? '' : 's'}`, tone: Number(m[1]) <= 14 ? 'warn' : '' };
    if (/^Free (trial|for 90 days)/i.test(t)) return { text: 'Free trial', tone: '' };
    if (st.alert && /not on your plan/i.test(t)) return { text: 'Not on your plan', tone: 'bad' };
    if (st.alert && /ended/i.test(t)) return { text: 'Trial ended', tone: 'bad' };
    if (st.alert) return { text: t.split(/[:—]/)[0].trim().slice(0, 28), tone: 'bad' };
    m = /(\d+) days? left/i.exec(t);
    if (m) return { text: `Trial · ${m[1]} day${m[1] === '1' ? '' : 's'}`, tone: '' };
    return null;   // paid, licensed: nothing to say
  }

  /** Online bookings / orders that came in today (online connections' recent list). */
  function onlineToday(sync, kind, now = new Date()) {
    const today = ymd(now);
    return ((sync && sync.recent) || []).filter((r) => !r.test && r.kind === kind && r.outcome !== 'rejected' && r.at && ymd(r.at) === today).length;
  }

  /** The pay run line: "Pay run today", "Fri pay run" (in the next week) or "Paid Fri" (in the last 3 days). */
  function payLine(payroll, now = new Date()) {
    const p = payroll || {};
    const next = p.nextRun && p.nextRun.pay_date; const last = p.lastRun && p.lastRun.pay_date;
    if (last) { const ago = daysBetween(last, now); if (ago >= 0 && ago <= 3) return { text: ago === 0 ? 'Paid today' : `Paid ${weekday(last)}`, tone: 'ok', last: true }; }
    if (next) {
      const d = daysBetween(now, next);
      if (d === 0) return { text: 'Pay run today', tone: 'warn' };
      if (d > 0 && d <= 7) return { text: `${weekday(next)} pay run`, tone: '' };
      if (d < 0 && d >= -7) return { text: 'Pay run due', tone: 'warn' };
    }
    return null;
  }

  /**
   * The one short line under a program's icon. ctx: { today, lic, LUI, unread, sync, inst, installing, accId, now }
   * -> { text, tone } (tone: '' | 'ok' | 'warn' | 'bad').
   */
  function liveLine(id, ctx = {}) {
    const today = ctx.today || {}; const now = ctx.now || new Date();
    const x = (ctx.inst || {})[id];
    if (ctx.installing === id) return { text: x && x.stage === 'downloading' ? `Installing… ${Math.round((x.pct || 0) * 100)}%` : 'Installing…', tone: '' };
    if (x && x.stage === 'failed') return { text: 'Didn\'t install', tone: 'bad' };
    const st = ctx.LUI && id !== 'linkoffice' ? ctx.LUI.programStatus(id, ctx.lic) : null;
    const plan = planLine(st);
    if (plan && plan.tone === 'bad') return plan;   // trial ended / not on the plan wins: it's what stops work
    let live = null;
    const m = today.money;
    if ((id === ctx.accId || (id === 'invoices' && !ctx.accId)) && m && m.found) {
      const overdue = (m.receivables || []).filter((r) => r.overdue).length;
      if (overdue) live = { text: `${overdue} overdue`, tone: 'warn' };
      else if ((m.receivables || []).length) live = { text: `${moneyShort(m.totals && m.totals.owedToYou)} owed`, tone: '' };
    }
    if (id === 'payroll') live = payLine(today.payroll, now);
    if (id === 'bookings') { const n = onlineToday(ctx.sync, 'booking', now); if (n) live = { text: `${n} today`, tone: '' }; }
    if (id === 'pos') { const n = onlineToday(ctx.sync, 'order', now); if (n) live = { text: plural(n, 'online order'), tone: '' }; }
    if (id === 'team' && ctx.unread) live = { text: `${ctx.unread} unread`, tone: 'warn' };
    if (id === 'linkoffice') {
      const row = ctx.lic && ctx.lic.online && (ctx.lic.online.rows || []).find((r) => r.id === 'calls');
      if (row && row.tone === 'bad') return { text: 'Trial ended', tone: 'bad' };
    }
    if (id === 'desk') {
      if (today.documents && today.inbox) live = { text: `${today.inbox} to file`, tone: '' };
      else if (!today.documents) { const n = today.taskCount ?? (today.tasks || []).length; if (n) live = { text: plural(n, 'to-do'), tone: '' }; }
    }
    return live || plan || { text: '', tone: '' };
  }

  /**
   * The tiles, in order. ctx: { programs, cl (checklist, with planMissing), upd, names: id -> short name,
   *   audience, ... and everything liveLine reads }.
   * -> [{ kind: 'open'|'team'|'want'|'add', id, name, full, line, tone, update, jobs }]
   */
  function tiles(ctx = {}) {
    const programs = (ctx.programs || []).slice().sort((a, b) => byOrder(a.id, b.id));
    const has = (id) => programs.some((p) => p.id === id && p.status !== 'missing');
    const accId = has('accounting') ? 'accounting' : has('accounting-basics') ? 'accounting-basics' : null;
    const c = { ...ctx, accId };
    const names = ctx.names || {};
    const upFor = new Map(((ctx.upd && ctx.upd.updates) || []).map((u) => [u.id, u]));
    const mine = programs.filter((p) => p.status !== 'missing' && !(p.id === 'accounting-basics' && has('accounting')));
    const out = mine.map((p) => {
      const l = liveLine(p.id, c);
      return { kind: p.id === 'team' ? 'team' : 'open', id: p.id, name: names[p.id] || p.name, full: p.full, line: l.text, tone: l.tone,
        update: upFor.has(p.id) ? upFor.get(p.id).to : null, jobs: jobsFor(p.id, has) };
    });
    // A business PC always has Riyeser Link (its own app when installed, else Central's Link window), as before.
    const who = ctx.audience && ctx.audience.who;
    if (who && who !== 'individual' && !has('team')) {
      const l = liveLine('team', c);
      const at = out.findIndex((t) => ORDER.indexOf(t.id) > ORDER.indexOf('team'));
      const t = { kind: 'team', id: 'team', name: names.team || 'Link', full: 'Riyeser Link', line: l.text, tone: l.tone, update: null, jobs: [], window: true };
      if (at < 0) out.push(t); else out.splice(at, 0, t);
    }
    // On the plan, not on this PC yet: a quiet tile that installs it.
    for (const x of ((ctx.cl && ctx.cl.planMissing) || [])) {
      const p = programs.find((q) => q.id === x.id);
      if (!p || out.some((t) => t.id === p.id)) continue;
      const inst = (ctx.inst || {})[p.id];
      const line = ctx.installing === p.id ? liveLine(p.id, c).text : inst && inst.stage === 'failed' ? 'Didn\'t install · Try again' : 'On your plan · Install';
      out.push({ kind: 'want', id: p.id, name: names[p.id] || p.name, full: p.full, line, tone: inst && inst.stage === 'failed' ? 'bad' : '', update: null, jobs: [] });
    }
    out.push({ kind: 'add', id: 'add', name: 'Add a program', full: 'Add a program', line: '', tone: '', update: null, jobs: [] });
    return out;
  }

  /** The one-click jobs for a program's ⋯ menu and the search box. */
  function jobsFor(id, has) {
    const accId = has('accounting') ? 'accounting' : has('accounting-basics') ? 'accounting-basics' : null;
    return JOBS.filter((j) => (j.p === 'acc' ? accId === id : j.p === 'invoices' ? id === 'invoices' && !accId : j.p === id))
      .map((j) => ({ t: j.t, s: j.s, page: j.page || '', act: j.act || '' }));
  }

  /**
   * The small chips under the grid. Only what's worth saying: overdue invoices, the pay run, online bookings today,
   * meetings today (Desk Assistant before Documents) and "Getting started" while it isn't finished.
   * -> [{ id, text, tone, pop }] (pop: what the chip's little popover shows)
   */
  function chips(ctx = {}) {
    const today = ctx.today || {}; const now = ctx.now || new Date(); const out = [];
    const programs = ctx.programs || [];
    const has = (id) => programs.some((p) => p.id === id && p.status !== 'missing');
    const accId = has('accounting') ? 'accounting' : has('accounting-basics') ? 'accounting-basics' : has('invoices') ? 'invoices' : null;
    const m = today.money;
    if (accId && m && m.found) {
      const od = (m.receivables || []).filter((r) => r.overdue);
      if (od.length) out.push({ id: 'overdue', tone: 'warn', text: `${plural(od.length, 'invoice')} overdue · ${moneyShort(od.reduce((n, r) => n + (Number(r.owing) || 0), 0))}`, pop: 'overdue', open: accId });
    }
    if (has('payroll')) {
      const p = payLine(today.payroll, now);
      if (p) out.push({ id: 'payrun', tone: p.tone === 'warn' ? 'warn' : 'ok', text: p.last ? `Pay run done ${p.text.replace(/^Paid /, '')}`.replace('done today', 'done today') : p.text.replace(/^(\w{3}) pay run$/, 'Pay run $1'), open: 'payroll' });
    }
    const nb = onlineToday(ctx.sync, 'booking', now); const no = onlineToday(ctx.sync, 'order', now);
    if (nb) out.push({ id: 'bookings', tone: 'ok', text: `${plural(nb, 'online booking')} today`, pop: 'online', open: has('bookings') ? 'bookings' : null });
    if (no) out.push({ id: 'orders', tone: 'ok', text: `${plural(no, 'online order')} today`, pop: 'online', open: has('pos') ? 'pos' : accId });
    const mt = (today.meetings || []).filter((x) => ymd(x.start) === ymd(now));
    if (has('desk') && !today.documents && mt.length) out.push({ id: 'meetings', tone: '', text: `${plural(mt.length, 'meeting')} today`, pop: 'meetings' });
    const cl = ctx.cl;
    if (cl && !cl.hidden && !cl.demo && !cl.allDone && cl.total) out.push({ id: 'started', tone: '', text: `Getting started · ${cl.done} of ${cl.total}`, pop: 'checklist' });
    return out;
  }

  /**
   * Things that are really broken and important. Nothing else: an update that's ready, a trial with days left or a
   * checklist aren't "attention". ctx: { sync, lic, company (CO.state), demoNote, inst, programs, updError, backups,
   * installedIds, now } -> [{ id, title, detail, act: { label, attrs }, admin: true when it's fixed in the Admin panel }]
   */
  function attention(ctx = {}) {
    const out = []; const now = ctx.now || Date.now();
    const s = ctx.sync;
    if (s && s.view === 'problem') out.push({ id: 'online', title: 'Online connections need a look', detail: s.message || '', act: { label: 'Details', attrs: 'data-os="details"' }, admin: true });
    const lic = ctx.lic;
    const installed = new Set(ctx.installedIds || []);
    if (lic && lic.online) {
      const o = lic.online;
      if (o.stale) out.push({ id: 'plan', title: 'Your plan needs checking', detail: o.message || 'Riyeser couldn\'t check your plan for a while.', act: { label: 'See your plan', attrs: 'data-lic="open"' } });
      const LUI = ctx.LUI; const ended = [];
      if (LUI) for (const id of installed) { const st = LUI.programStatus(id, lic); if (st && st.alert && st.tone === 'bad') ended.push(id); }
      if (ended.length && !o.stale) out.push({ id: 'ended', title: ended.length === 1 ? `${(ctx.names || {})[ended[0]] || ended[0]}: trial ended or not on your plan` : `${ended.length} programs aren't on your plan`, detail: 'Everything you\'ve made stays exactly where it is.', act: { label: 'See your plan', attrs: 'data-lic="open"' } });
    } else if (lic && lic.mode === 'expired' && [...installed].some((id) => ctx.LUI && ctx.LUI.MODULE[id])) {
      out.push({ id: 'expired', title: 'Your free trial has ended', detail: 'Sign in to your Riyeser account to unlock your plan.', act: { label: 'Unlock your plan', attrs: 'data-lic="open"' } });
    }
    const co = ctx.company || {};
    if (co.unlinked && co.company) out.push({ id: 'unlinked', title: `This PC was unlinked from ${co.company.name}`, detail: 'An admin removed it, or you left the business. Everything on this PC is still here.', act: { label: 'Set up again', attrs: 'data-w="restart"' } });
    if (ctx.demoNote) out.push({ id: 'demo', title: 'Practice data not put away yet', detail: ctx.demoNote, act: { label: 'Try again', attrs: 'data-demo="retry"' } });
    for (const [id, x] of Object.entries(ctx.inst || {})) {
      if (!x || x.stage !== 'failed') continue;
      const p = (ctx.programs || []).find((q) => q.id === id);
      out.push({ id: `install-${id}`, title: `${p ? p.full : id} didn't install`, detail: x.message || '', act: { label: 'Try again', attrs: `data-install="${id}"` } });
    }
    if (ctx.updError) out.push({ id: 'updates', title: 'Updates didn\'t finish', detail: ctx.updError, act: { label: 'Try again', attrs: 'data-adm-go="updates"' }, admin: true });
    // updates waiting for a time or an approval (central/auto-update.js): one quiet item; owners and admins approve
    const au = ctx.autoUpd;
    if (au && !au.demo && (au.week || (au.ready && au.ready.length))) {
      const n = au.week ? (au.pending || []).length : au.ready.length; const can = ctx.canApprove !== false;
      const install = { label: 'Install now', attrs: 'data-autoapprove' }; const later = { label: 'Tonight', attrs: 'data-autotonight' };
      if (au.week) out.push({ id: 'auto-week', title: 'Updates have been waiting a week: install now or leave the PC on overnight', detail: can ? '' : 'An owner or admin can install them.', acts: can ? [install] : [], admin: true });
      else if (!can) out.push({ id: 'auto-ready', title: 'Updates are waiting for an administrator', detail: `${n} update${n === 1 ? '' : 's'} ready. An owner or admin can install them.`, acts: [], admin: true });
      else {
        const end = (au.hours && au.hours.end) || '18:00';
        const detail = au.mode === 'approve' ? 'They wait for your approval. Programs that are open update once they\'re closed.'
          : `They install by themselves after work hours (after ${end}). Install now, or leave them for tonight.`;
        out.push({ id: 'auto-ready', title: `${n} update${n === 1 ? '' : 's'} ready`, detail, acts: [install, later], admin: true });
      }
    }
    // an automatic update that didn't install twice (central/auto-update.js): one line each, with Try again
    for (const f of ctx.autoFailed || []) {
      const nm = f.id === 'central' ? 'Riyeser Central' : (ctx.names || {})[f.id] || f.name || f.id;
      out.push({ id: `auto-${f.id}`, title: `${nm} didn't update to ${f.version}`, detail: f.error || 'It was tried twice.', act: { label: 'Try again', attrs: `data-autoretry="${f.id}"` }, admin: true });
    }
    const b = ctx.backups;
    if (b && b.backups && b.backups.length && installed.size) {
      const last = new Date(b.backups[0].when).getTime();
      if (last && now - last > 7 * 86400000) out.push({ id: 'backup', title: 'No backup for over a week', detail: 'Riyeser backs up every day while this PC is on. Check Documents\\Riyeser has room.', act: { label: 'Back up now', attrs: 'data-bk="all"' }, admin: true });
    }
    return out;
  }

  /** Programs and jobs that match the search box. tilesList: tiles(); -> [{ kind: 'program'|'job', id, title, sub, page, act }] */
  function searchLocal(q, tilesList) {
    const t = String(q || '').trim().toLowerCase(); if (!t) return [];
    const words = t.split(/\s+/);
    const hit = (s) => { const x = String(s || '').toLowerCase(); return words.every((w) => x.includes(w)); };
    const out = [];
    for (const tl of tilesList || []) {
      if (tl.kind === 'add') { if (hit('add a program install get more apps')) out.push({ kind: 'add', id: 'add', title: 'Add a program', sub: 'Install more Riyeser programs' }); continue; }
      if (hit(`${tl.name} ${tl.full}`)) out.push({ kind: tl.kind === 'want' ? 'want' : 'program', id: tl.id, title: tl.full, sub: tl.kind === 'want' ? 'On your plan · Install' : tl.line || 'Open' });
      for (const j of tl.jobs || []) if (hit(`${j.t} ${j.s} ${tl.name}`)) out.push({ kind: 'job', id: tl.id, title: j.t, sub: `${tl.full} · ${j.s}`, page: j.page, act: j.act });
    }
    return out.slice(0, 8);
  }

  /** The quiet line in Admin → Updates: "Updated PDF to 0.26.0 · 2 hours ago". last: { id, to, at }. */
  function autoLine(last, name, now = Date.now()) {
    if (!last) return '';
    const m = Math.max(0, Math.round((now - last.at) / 60000)); const h = Math.round(m / 60); const dd = Math.round(h / 24);
    const when = m < 1 ? 'just now' : m < 60 ? `${m} min ago` : h < 24 ? `${h} hour${h === 1 ? '' : 's'} ago` : dd === 1 ? 'yesterday'
      : dd < 7 ? `${dd} days ago` : `on ${new Date(last.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
    return `Updated ${name || last.id} to ${last.to} · ${when}`;
  }
  /** Update all's banner line for one step (update-progress from central-main.js installUpdates). */
  function updateStep(p) {
    const x = p || {}; const n = x.name || 'the program';
    switch (x.stage) {
      case 'downloading': return `Downloading ${n}… ${Math.round((x.pct || 0) * 100)}%`;
      case 'checking': return `Checking the ${n} download…`;
      case 'installing': return x.elevate ? `Installing ${n}… Windows is asking for permission — look for the prompt on the taskbar` : `Installing ${n}…`;
      case 'restarting': return 'Restarting Riyeser Central to finish updating…';
      case 'failed': return x.message || `${n} didn't update.`;
      default: return '';
    }
  }
  const api = { updateStep, ORDER, JOBS, byOrder, autoLine, firstName, greeting, audience, planLine, payLine, onlineToday, liveLine, tiles, jobsFor, chips, attention, searchLocal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RiyeserLauncher = api;
}(typeof window !== 'undefined' ? window : null));
