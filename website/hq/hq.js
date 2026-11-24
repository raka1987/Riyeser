/* Riyeser HQ: the back office for running Riyeser. Riyeser staff only, with two-step sign-in.
   Shows account information (companies, people counts, branches, linked PCs and versions, trials, Team Calls,
   downloads, notes). It never sees customers' messages, calls or books: the database only offers hq_ summaries.
   Runs on the Riyeser Team Supabase project (../team/config.js). With ?demo, or before it's set up, sample data. */
(() => {
  'use strict';
  const CFG = window.RIYESER_TEAM || {};
  const CONFIGURED = !!(CFG.supabaseUrl && CFG.supabaseKey);
  const DEMO = new URLSearchParams(location.search).has('demo') || !CONFIGURED;
  const REPO = 'raka1987/Riyeser';
  const $app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString();
  const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const ROLES = [['owner', 'Owner'], ['finance', 'Finance'], ['support', 'Support'], ['sales', 'Sales'], ['developer', 'Developer']];
  const roleName = (r) => (ROLES.find((x) => x[0] === r) || [r, r])[1];
  const MODULES = [['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['payroll', 'Payroll'], ['pos', 'POS'], ['bookings', 'Bookings'], ['as_built', 'As Built'], ['calls', 'Team Calls']];
  const modName = (m) => (MODULES.find((x) => x[0] === m) || [m, m])[1];
  const money = (n) => '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const statusPill = (v) => (v.status === 'active' ? `<span class="pill ok">Paid${v.paid_until ? ` to ${day(v.paid_until)}` : ''}</span>`
    : v.status === 'trial' ? `<span class="pill${v.days_left <= 14 ? ' warn' : ''}">Trial · ${v.days_left} days</span>`
    : v.status === 'cancelled' ? (v.active ? `<span class="pill warn">Cancelled · works to ${day(v.paid_until)}</span>` : '<span class="pill bad">Cancelled</span>')
    : '<span class="pill bad">Ended</span>');
  // Which program each installer is (older file names included).
  const PRODUCT = [[/Central/i, 'Riyeser Central'], [/AccountingBasics/i, 'Accounting Basics'], [/Accounting(Plus)?-Setup|AccountingPlus/i, 'Accounting Plus'],
    [/POS/i, 'POS'], [/Invoices/i, 'Invoices'], [/Bookings/i, 'Bookings'], [/Payroll/i, 'Payroll'], [/DeskAssistant/i, 'Desk Assistant'],
    [/PDF/i, 'PDF'], [/Services|AsBuilt/i, 'As Built']];
  const productOf = (asset) => (PRODUCT.find(([re]) => re.test(asset)) || [null, 'Other'])[1];
  const plain = (e) => { const m = (e && (e.message || e.msg || e.error_description)) || String(e);
    if (/Invalid login/i.test(m)) return 'That email or password isn\'t right.';
    if (/Invalid TOTP|mfa_verification_failed/i.test(m)) return 'That code isn\'t right. Type the 6 numbers your authenticator app shows now.';
    return m; };

  // ------------------------------------------------------------------ online
  function online() {
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, storageKey: 'riyeser.hq.session' } });
    const ok = ({ data, error }) => { if (error) throw error; return data; };
    const rpc = async (f, a) => ok(await sb.rpc(f, a || {}));
    return {
      async session() { return ok(await sb.auth.getSession()).session; },
      async signIn(email, password) { ok(await sb.auth.signInWithPassword({ email, password })); },
      async signOut() { await sb.auth.signOut(); },
      async aal() { return ok(await sb.auth.mfa.getAuthenticatorAssuranceLevel()); },
      async factors() { const f = ok(await sb.auth.mfa.listFactors()); return (f.totp || []).filter((x) => x.status === 'verified'); },
      async verify(factorId, code) { ok(await sb.auth.mfa.challengeAndVerify({ factorId, code })); },
      me: () => rpc('hq_me'), overview: () => rpc('hq_overview'), companies: (search) => rpc('hq_companies', { search: search || '' }),
      company: (ws) => rpc('hq_company', { ws }), setCallsPaid: (ws, until) => rpc('hq_set_calls_paid', { ws, until }),
      addNote: (ws, body) => rpc('hq_add_note', { ws, body }), staff: () => rpc('hq_staff_list'),
      addStaff: (email, name, role) => rpc('hq_add_staff', { staff_email: email, staff_name: name, staff_role: role }),
      setStaff: (staff, role, active) => rpc('hq_set_staff', { staff, staff_role: role, is_active: active }),
      history: () => rpc('hq_history'), downloadsDaily: (days) => rpc('hq_downloads', { days }),
      licences: () => rpc('hq_licences'), companyLicence: (ws) => rpc('hq_company_licence', { ws }),
      setModule: (ws, mod, status, trialEnd, paidTo) => rpc('hq_set_module', { ws, mod, new_status: status, trial_end: trialEnd || null, paid_to: paidTo || null }),
      setPlan: (ws, users, cos, billing, eb) => rpc('hq_set_plan', { ws, users_extra: users, companies_extra: cos, billing_period: billing, is_early_bird: eb }),
    };
  }
  // ------------------------------------------------------------------ demo (sample data, nothing real)
  function demo() {
    const t = (d) => new Date(Date.now() - d * 864e5).toISOString();
    const cos = [
      { id: 'w1', name: 'Sample Plumbing', company_code: 'RIY-7K3M-Q2', country: 'Fiji', created_at: t(80), people: 5, branches: 2, pcs: 3, last_seen: t(0.01), calls_paid_until: null, trial_days_left: 10, owner_name: 'Alex', owner_email: 'alex@sample.test' },
      { id: 'w2', name: 'Harbour Cafe', company_code: 'RIY-H4RB-9C', country: 'Fiji', created_at: t(40), people: 9, branches: 1, pcs: 2, last_seen: t(0.2), calls_paid_until: t(-200), trial_days_left: 50, owner_name: 'Mere', owner_email: 'mere@harbour.test' },
      { id: 'w3', name: 'Northside Dental', company_code: 'RIY-N7DL-4T', country: 'Australia', created_at: t(12), people: 4, branches: 1, pcs: 4, last_seen: t(1), calls_paid_until: null, trial_days_left: 78, owner_name: 'Priya', owner_email: 'priya@northside.test' },
      { id: 'w4', name: 'Island Traders', company_code: 'RIY-1SLD-T8', country: 'Fiji', created_at: t(3), people: 2, branches: 2, pcs: 1, last_seen: t(3), calls_paid_until: null, trial_days_left: 87, owner_name: 'Jone', owner_email: 'jone@island.test' }];
    const staff = [{ user_id: 's1', display_name: 'Riki', role: 'owner', active: true, email: 'riki@riyeser.test', added_at: t(30) },
      { user_id: 's2', display_name: 'Help Desk', role: 'support', active: true, email: 'help@riyeser.test', added_at: t(5) }];
    const mods = { w2: { basic: { status: 'active', paid_until: t(-300).slice(0, 10) }, pos: { status: 'active', paid_until: t(-300).slice(0, 10) }, calls: { status: 'active', paid_until: t(-200).slice(0, 10) } },
      w1: { basic: { status: 'active', paid_until: t(-20).slice(0, 10) }, payroll: { status: 'cancelled', paid_until: t(5).slice(0, 10) } } };
    const plans = { w2: { extra_users: 6, extra_companies: 0, billing: 'yearly', early_bird: true } };
    const today = () => new Date(new Date().toISOString().slice(0, 10));
    const dd = (a) => Math.round((new Date(a) - today()) / 864e5);
    function demoLicence(ws) { const c = cos.find((x) => x.id === ws); const joined = c.created_at.slice(0, 10);
      const modules = {}; MODULES.forEach(([m]) => { const r = (mods[ws] || {})[m];
        if (!r || r.status === 'trial') { const te = r && r.trial_ends ? r.trial_ends : new Date(new Date(joined).getTime() + 90 * 864e5).toISOString().slice(0, 10); const left = dd(te);
          modules[m] = { status: left >= 0 ? 'trial' : 'ended', active: left >= 0, trial_ends: te, paid_until: null, days_left: left >= 0 ? left : null }; }
        else if (r.status === 'active') { const left = dd(r.paid_until); modules[m] = { status: left >= 0 ? 'active' : 'ended', active: left >= 0, trial_ends: null, paid_until: r.paid_until, days_left: left >= 0 ? left : null }; }
        else { const left = r.paid_until ? dd(r.paid_until) : -1; modules[m] = { status: 'cancelled', active: left >= 0, trial_ends: null, paid_until: r.paid_until, days_left: left >= 0 ? left : null }; } });
      const pl = plans[ws] || {}; return { workspace_id: ws, company_code: c.company_code, modules, seats: { included: 3, extra: pl.extra_users || 0, used: c.people }, extra_companies: pl.extra_companies || 0, billing: pl.billing || 'monthly', early_bird: !!pl.early_bird }; }
    function demoMonthly(ws) { const l = demoLicence(ws); const n = Object.values(l.modules).filter((v) => v.status === 'active').length;
      let m = n * 20 + l.seats.extra * 5 + l.extra_companies * 10; if (l.billing === 'yearly') m *= 10 / 12; if (l.early_bird) m *= 0.5; return Math.round(m * 100) / 100; }
    const notes = { w1: [{ body: 'Called Alex: wants POS for the Lautoka branch next month.', at: t(2), by: 'Riki' }] };
    const hist = [{ at: t(0.1), who: 'Riki', action: 'company.viewed', details: { workspace_id: 'w1' } }, { at: t(2), who: 'Riki', action: 'note.added', details: { workspace_id: 'w1' } },
      { at: t(5), who: 'Riki', action: 'staff.added', details: { email: 'help@riyeser.test', role: 'support' } }, { at: t(30), who: 'Riyeser', action: 'staff.owner_made', details: { email: 'riki@riyeser.test' } }];
    const daily = []; const assets = ['RiyeserCentral-Setup.exe', 'RiyeserAccountingBasics-Setup.exe', 'RiyeserPOS-Setup.exe', 'RiyeserInvoices-Setup.exe', 'RiyeserBookings-Setup.exe'];
    for (let d = 29; d >= 0; d--) assets.forEach((a, i) => daily.push({ day: t(d).slice(0, 10), asset: a, total: Math.round((30 - d) * (6 - i) * 1.7 + 20 * (6 - i)) }));
    return {
      async session() { return { user: { email: 'riki@riyeser.test' } }; }, async signIn() {}, async signOut() { location.href = '/hq/'; },
      async aal() { return { currentLevel: 'aal2', nextLevel: 'aal2' }; }, async factors() { return [{ id: 'f' }]; }, async verify() {},
      async me() { return { role: 'owner', name: 'Riki', active: true, two_step: true }; },
      async overview() { return { companies: 4, companies_7d: 1, companies_30d: 2, people: 20, pcs: 10, pcs_active_7d: 8, pcs_active_30d: 10, requests_waiting: 1, calls_paid: 1, calls_trial: 3,
        trials_ending: [{ id: 'w1', name: 'Sample Plumbing', company_code: 'RIY-7K3M-Q2', days_left: 10 }],
        versions: [{ version: '1.6.4', pcs: 6 }, { version: '1.6.3', pcs: 3 }, { version: '1.5.1', pcs: 1 }],
        countries: [{ country: 'Fiji', companies: 3 }, { country: 'Australia', companies: 1 }],
        signups_by_week: [8, 7, 6, 5, 4, 3, 2, 1].map((w, i) => ({ week: t(w * 7).slice(0, 10), companies: [0, 1, 0, 1, 0, 1, 0, 1][i] })) }; },
      async companies(s) { const q = (s || '').toLowerCase(); return cos.filter((c) => !q || [c.name, c.company_code, c.owner_email].some((x) => x.toLowerCase().includes(q))); },
      async company(ws) { const c = cos.find((x) => x.id === ws);
        return { profile: { ...c, legal_name: c.name + ' Pty Ltd', tax_number: '50-12345-0-1', address: 'Suva', phone: '330 1234', email: c.owner_email, require_approval: true },
          people: [{ name: c.owner_name, role: 'owner', job_role: 'owner', extension: 101, email: c.owner_email, joined: c.created_at },
            { name: 'Sam Taylor', role: 'admin', job_role: 'manager', extension: 102, email: 'sam@sample.test', joined: t(20) },
            { name: 'Jordan Lee', role: 'member', job_role: 'staff', extension: 201, email: 'jordan@sample.test', joined: t(10) }],
          branches: [{ name: 'Head office', extension: 100, people: 2 }, { name: 'Lautoka branch', extension: 200, people: 1 }],
          pcs: [{ name: 'Head office PC', platform: 'Windows', version: '1.6.4', last_seen: t(0.01), person: c.owner_name }, { name: 'Lautoka front desk', platform: 'Windows', version: '1.6.3', last_seen: t(1), person: 'Jordan Lee' }],
          requests_waiting: 1, notes: notes[ws] || [] }; },
      async setCallsPaid(ws, until) { cos.find((x) => x.id === ws).calls_paid_until = until + 'T23:59:59Z'; hist.unshift({ at: new Date().toISOString(), who: 'Riki', action: 'calls.paid_until', details: { workspace_id: ws, until } }); },
      async addNote(ws, body) { (notes[ws] = notes[ws] || []).unshift({ body, at: new Date().toISOString(), by: 'Riki' }); hist.unshift({ at: new Date().toISOString(), who: 'Riki', action: 'note.added', details: { workspace_id: ws } }); },
      async staff() { return staff.slice(); },
      async addStaff(email, name, role) { staff.push({ user_id: 's' + (staff.length + 1), display_name: name, role, active: true, email, added_at: new Date().toISOString() }); },
      async setStaff(id, role, active) { Object.assign(staff.find((x) => x.user_id === id), { role, active }); },
      async history() { return hist.slice(); }, async downloadsDaily() { return daily; },
      async licences() { const list = cos.map((c) => ({ c, l: demoLicence(c.id) }));
        const ending = []; list.forEach(({ c, l }) => Object.entries(l.modules).forEach(([m, v]) => { if (v.days_left != null && v.days_left <= 14) ending.push({ id: c.id, name: c.name, company_code: c.company_code, module: m, status: v.status, days_left: v.days_left }); }));
        return { monthly_estimate: list.reduce((a, x) => a + demoMonthly(x.c.id), 0), paying_companies: list.filter((x) => demoMonthly(x.c.id) > 0).length,
          early_bird_used: Object.values(plans).filter((x) => x.early_bird).length + 37, early_bird_left: 100 - 37 - Object.values(plans).filter((x) => x.early_bird).length,
          modules: MODULES.map(([m]) => ({ module: m, active_paid: list.filter((x) => x.l.modules[m].status === 'active').length, on_trial: list.filter((x) => x.l.modules[m].status === 'trial').length,
            ended: list.filter((x) => ['ended', 'cancelled'].includes(x.l.modules[m].status)).length })), ending_soon: ending.sort((a, b) => a.days_left - b.days_left) }; },
      async companyLicence(ws) { return { licence: demoLicence(ws), monthly: demoMonthly(ws) }; },
      async setModule(ws, mod, status, te, pt) { (mods[ws] = mods[ws] || {})[mod] = { status, trial_ends: te || null, paid_until: pt || null };
        hist.unshift({ at: new Date().toISOString(), who: 'Riki', action: 'licence.module', details: { workspace_id: ws, module: mod, status } }); },
      async setPlan(ws, users, cosx, billing, eb) { plans[ws] = { extra_users: users, extra_companies: cosx, billing, early_bird: eb };
        hist.unshift({ at: new Date().toISOString(), who: 'Riki', action: 'licence.plan', details: { workspace_id: ws } }); },
    };
  }
  const api = DEMO ? demo() : online();
  const S = { me: null, tab: 'overview', companies: [] };
  const can = (...roles) => !!S.me && (S.me.role === 'owner' || roles.includes(S.me.role));

  // ------------------------------------------------------------------ sign-in
  function gate(note = '', step = 'password') {
    $app.innerHTML = `<div class="gate"><form class="gcard" id="g"><div class="glogo"><img src="../assets/logo-r.png" alt="">Riyeser HQ</div>
      <h1>${step === 'code' ? '🔐 Enter your code' : 'Staff sign in'}</h1>
      <p>${step === 'code' ? 'Type the 6 numbers from your authenticator app.' : 'For Riyeser staff. Use your Riyeser account; two-step sign-in is required.'}</p>${note}
      ${step === 'code' ? '<label class="f"><span>Code</span><input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label>'
        : '<label class="f"><span>Email</span><input type="email" name="email" required autocomplete="email"></label><label class="f"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>'}
      <button class="btn p w">${step === 'code' ? 'Continue' : 'Sign in'}</button></form></div>`;
    $app.querySelector('input').focus();
    $app.querySelector('#g').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      try {
        if (step === 'code') { const fac = (await api.factors())[0]; await api.verify(fac.id, String(f.get('code')).trim()); }
        else await api.signIn(String(f.get('email')), String(f.get('password')));
        await start();
      } catch (err) { gate(`<div class="err">${esc(plain(err))}</div>`, step); }
    };
  }
  function blocked(msg) {
    $app.innerHTML = `<div class="gate"><div class="gcard"><div class="glogo"><img src="../assets/logo-r.png" alt="">Riyeser HQ</div>${msg}
      <button class="btn w" id="so" style="margin-top:8px">Sign out</button></div></div>`;
    $app.querySelector('#so').onclick = async () => { await api.signOut(); gate(); };
  }

  async function start() {
    try {
      const s = await api.session(); if (!s) return gate();
      const lv = await api.aal();
      if (lv.currentLevel !== 'aal2') {
        if (lv.nextLevel === 'aal2') return gate('', 'code');
        return blocked('<h1>Turn on two-step sign-in first</h1><p>Riyeser HQ needs two-step sign-in. Open <a href="/team/">Riyeser Team</a>, click <b>🔐 Security</b> and turn it on, then come back and sign in again.</p>');
      }
      S.me = await api.me();
      if (!S.me || !S.me.active) return blocked('<h1>Not Riyeser HQ staff</h1><p>This account isn\'t on the Riyeser HQ team. Ask a Riyeser HQ owner to add you.</p>');
      shell();
    } catch (err) { blocked(`<div class="err">${esc(plain(err))}</div>`); }
  }

  // ------------------------------------------------------------------ the shell
  const TABS = () => [['overview', 'Overview', true], ['companies', 'Companies', can('finance', 'support', 'sales')], ['licences', 'Licences', can('finance', 'support', 'sales')], ['downloads', 'Downloads', true],
    ['team', 'HQ team', true], ['history', 'History', can()]].filter((x) => x[2]);
  function shell() {
    $app.innerHTML = `${DEMO ? '<div class="demo">Demo with sample data. Nothing here is real.</div>' : ''}
      <header class="top"><div class="brand"><img src="../assets/logo-r.png" alt="">Riyeser HQ <small>staff only</small></div>
      <nav class="tabs">${TABS().map(([k, l]) => `<button data-tab="${k}"${S.tab === k ? ' class="on"' : ''}>${l}</button>`).join('')}</nav>
      <div class="me">${esc(S.me.name)} <small>${esc(roleName(S.me.role))}</small><button id="so">Sign out</button></div></header><main id="main"></main>`;
    $app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; shell(); });
    $app.querySelector('#so').onclick = async () => { await api.signOut(); gate(); };
    ({ overview, companies, licences, downloads, team, history })[S.tab]().catch((err) => { document.getElementById('main').innerHTML = `<div class="err">${esc(plain(err))}</div>`; });
  }
  const main = (html) => { document.getElementById('main').innerHTML = html; return document.getElementById('main'); };

  // Single-measure charts: one hue, value on hover, labels in text colours.
  function columnChart(rows, label, value, unit) {
    const max = Math.max(1, ...rows.map(value));
    return `<div class="bars" role="img" aria-label="${esc(unit)} chart">${rows.map((r) => `<div class="b" tabindex="0"><span class="tip">${esc(label(r))}: ${num(value(r))} ${esc(unit)}</span><i style="height:${Math.max(1.5, (value(r) / max) * 100)}%"></i></div>`).join('')}</div>
      <div class="xlab">${rows.map((r, i) => `<span>${i % Math.max(1, Math.ceil(rows.length / 6)) === 0 ? esc(label(r)) : ''}</span>`).join('')}</div>`;
  }
  function barList(rows, label, value) {
    const max = Math.max(1, ...rows.map(value));
    return `<div class="hbars">${rows.map((r) => `<div class="hb"><span class="lab" title="${esc(label(r))}">${esc(label(r))}</span><span class="track"><i style="width:${(value(r) / max) * 100}%"></i></span><span class="num">${num(value(r))}</span></div>`).join('') || '<p class="muted small">Nothing yet.</p>'}</div>`;
  }
  const tile = (k, v, d = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;

  // ------------------------------------------------------------------ overview
  async function overview() {
    main('<p class="muted">Loading…</p>');
    const o = await api.overview();
    const wk = (o.signups_by_week || []).map((w) => ({ ...w, label: new Date(w.week).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }));
    main(`<h2>Overview</h2><p class="sub">How Riyeser is doing. Account information only: HQ never sees customers' messages or books.</p>
      <div class="tiles">${tile('Companies', num(o.companies), `+${num(o.companies_7d)} this week · +${num(o.companies_30d)} in 30 days`)}
        ${tile('People', num(o.people), 'in all companies')}${tile('Linked PCs', num(o.pcs), `${num(o.pcs_active_7d)} active this week`)}
        ${tile('Team Calls', num(o.calls_paid) + ' paid', `${num(o.calls_trial)} on the free trial`)}</div>
      <div class="grid g2"><div class="card"><h3>New companies per week</h3>${columnChart(wk, (r) => r.label, (r) => Number(r.companies), 'companies')}</div>
        <div class="card"><h3>Riyeser Central versions in use <small>· PCs seen in 30 days</small></h3>${barList(o.versions || [], (r) => r.version, (r) => Number(r.pcs))}</div>
        <div class="card"><h3>Team Calls trials ending soon <small>· 14 days or less, not paid</small></h3>
          ${(o.trials_ending || []).length ? `<table class="tbl"><tr><th>Company</th><th class="n">Days left</th></tr>${o.trials_ending.map((t) => `<tr class="click" data-co="${t.id}"><td><b>${esc(t.name)}</b><small>${esc(t.company_code)}</small></td><td class="n"><span class="pill warn">${t.days_left}</span></td></tr>`).join('')}</table>` : '<p class="muted small">None right now.</p>'}</div>
        <div class="card"><h3>Companies by country</h3>${barList(o.countries || [], (r) => r.country, (r) => Number(r.companies))}
          <p class="muted small" style="margin-top:12px">${num(o.requests_waiting)} join request${o.requests_waiting === 1 ? '' : 's'} waiting for a company admin · ${num(o.pcs_active_30d)} PCs active in 30 days</p></div></div>`)
      .querySelectorAll('[data-co]').forEach((r) => r.onclick = () => openCompany(r.dataset.co));
  }

  // ------------------------------------------------------------------ companies
  async function companies(q = '') {
    const m = main(`<h2>Companies</h2><p class="sub">Every company using Riyeser online. Search by name, Company ID, ABN/TIN or an owner's email.</p>
      <form class="search" id="sf"><input name="q" value="${esc(q)}" placeholder="Search…" aria-label="Search companies"><button class="btn">Search</button></form><div id="cl" class="card scroll"><p class="muted">Loading…</p></div>`);
    m.querySelector('#sf').onsubmit = (e) => { e.preventDefault(); companies(String(new FormData(e.target).get('q'))); };
    S.companies = await api.companies(q);
    const callsPill = (c) => (c.calls_paid_until && new Date(c.calls_paid_until) > new Date() ? `<span class="pill ok">Paid to ${day(c.calls_paid_until)}</span>`
      : c.trial_days_left > 0 ? `<span class="pill${c.trial_days_left <= 14 ? ' warn' : ''}">Trial · ${c.trial_days_left} days</span>` : '<span class="pill bad">Trial ended</span>');
    m.querySelector('#cl').innerHTML = S.companies.length ? `<table class="tbl"><tr><th>Company</th><th>Owner</th><th>Country</th><th class="n">People</th><th class="n">PCs</th><th>Last seen</th><th>Team Calls</th><th>Joined</th></tr>
      ${S.companies.map((c) => `<tr class="click" data-co="${c.id}"><td><b>${esc(c.name)}</b><small class="code">${esc(c.company_code || '')}</small></td><td>${esc(c.owner_name || '')}<small>${esc(c.owner_email || '')}</small></td>
        <td>${esc(c.country || '')}</td><td class="n">${num(c.people)}</td><td class="n">${num(c.pcs)}</td><td>${ago(c.last_seen)}</td><td>${callsPill(c)}</td><td>${day(c.created_at)}</td></tr>`).join('')}</table>`
      : '<p class="muted">No companies match.</p>';
    m.querySelectorAll('[data-co]').forEach((r) => r.onclick = () => openCompany(r.dataset.co));
  }

  async function openCompany(id) {
    const [c, lic] = await Promise.all([api.company(id), api.companyLicence(id)]); const p = c.profile; const L = lic.licence;
    document.querySelectorAll('.panel,.scrim').forEach((x) => x.remove());
    const scrim = document.createElement('div'); scrim.className = 'scrim'; const panel = document.createElement('aside'); panel.className = 'panel';
    const close = () => { panel.remove(); scrim.remove(); }; scrim.onclick = close;
    panel.innerHTML = `<div class="phead"><div style="flex:1"><h2>${esc(p.name)}</h2><span class="code">${esc(p.company_code || '')}</span></div><button class="btn sm" id="x">Close</button></div>
      <div class="card"><h3>Details</h3><dl class="kv"><dt>Legal name</dt><dd>${esc(p.legal_name || '—')}</dd><dt>ABN / TIN</dt><dd>${esc(p.tax_number || '—')}</dd>
        <dt>Country</dt><dd>${esc(p.country || '—')}</dd><dt>Address</dt><dd>${esc(p.address || '—')}</dd><dt>Phone</dt><dd>${esc(p.phone || '—')}</dd><dt>Email</dt><dd>${esc(p.email || '—')}</dd>
        <dt>Joined Riyeser</dt><dd>${day(p.created_at)}</dd><dt>New people need</dt><dd>${p.require_approval ? 'Approval (recommended)' : 'No approval'}</dd>
        <dt>Waiting to join</dt><dd>${num(c.requests_waiting)}</dd></dl></div>
      <div class="card" id="licCard"><h3>Licence <small>· ${money(lic.monthly)} a month (list price estimate)</small></h3>
        <table class="tbl lic"><tr><th>Program</th><th>Now</th>${can('finance') ? '<th>Change to</th><th></th>' : ''}</tr>
        ${MODULES.map(([m, name]) => { const v = L.modules[m]; return `<tr data-mod="${m}"><td><b>${name}</b></td><td>${statusPill(v)}</td>${can('finance') ? `<td><div class="row">
          <select name="st" aria-label="${name} status"><option value="trial"${v.status === 'trial' ? ' selected' : ''}>Free trial until</option><option value="active"${v.status === 'active' || v.status === 'ended' ? ' selected' : ''}>Paid until</option><option value="cancelled"${v.status === 'cancelled' ? ' selected' : ''}>Cancelled (works until)</option></select>
          <input type="date" name="dt" value="${(v.status === 'trial' ? v.trial_ends : v.paid_until) || ''}" aria-label="${name} date"></div></td><td><button class="btn sm" data-save="${m}">Save</button></td>` : ''}</tr>`; }).join('')}</table>
        <form id="plan" class="grid g3" style="margin-top:12px"><label class="f"><span>Extra users <small class="muted">(${L.seats.used} people, ${L.seats.included} included)</small></span><input type="number" min="0" name="users" value="${L.seats.extra}"${can('finance') ? '' : ' disabled'}></label>
          <label class="f"><span>Extra companies</span><input type="number" min="0" name="cos" value="${L.extra_companies}"${can('finance') ? '' : ' disabled'}></label>
          <label class="f"><span>Billing</span><select name="billing"${can('finance') ? '' : ' disabled'}><option value="monthly"${L.billing === 'monthly' ? ' selected' : ''}>Monthly</option><option value="yearly"${L.billing === 'yearly' ? ' selected' : ''}>Yearly (2 months free)</option></select></label>
          <label class="opt"><input type="checkbox" name="eb"${L.early_bird ? ' checked' : ''}${can('finance') ? '' : ' disabled'}> Early bird: half price for the first 12 months</label>
          ${can('finance') ? '<div><button class="btn p sm">Save plan</button></div>' : '<p class="muted small">Owners and Finance can change licences.</p>'}</form>
        <p class="muted small">Changes reach the company's PCs the next time Riyeser Central checks in (at start-up and daily).</p></div>
      <div class="card scroll"><h3>People <small>· ${c.people.length}</small></h3><table class="tbl"><tr><th>Name</th><th>Role</th><th class="n">Ext</th><th>Joined</th></tr>
        ${c.people.map((x) => `<tr><td>${esc(x.name)}<small>${esc(x.email || '')}</small></td><td>${esc(x.role === 'owner' ? 'Owner' : x.job_role)}${x.role === 'admin' ? ' · admin' : ''}</td><td class="n">${x.extension || ''}</td><td>${day(x.joined)}</td></tr>`).join('')}</table></div>
      <div class="grid g2"><div class="card"><h3>Branches</h3>${c.branches.map((b) => `<div class="small">${esc(b.name)} <span class="muted">· ${b.extension || ''} · ${b.people} people</span></div>`).join('') || '<p class="muted small">None.</p>'}</div>
        <div class="card"><h3>Linked PCs</h3>${c.pcs.map((d) => `<div class="small"><b>${esc(d.name || 'A PC')}</b> <span class="muted">· ${esc(d.person || '')} · Central ${esc(d.version || '?')} · ${ago(d.last_seen)}</span></div>`).join('') || '<p class="muted small">None linked.</p>'}</div></div>
      <div class="card notes"><h3>HQ notes <small>· only Riyeser staff see these</small></h3>
        <form id="nf" class="row" style="margin-bottom:8px"><input name="body" required maxlength="2000" placeholder="e.g. Called the owner about POS" style="flex:1;padding:8px 10px;border:1px solid #cfd6e4;border-radius:9px"><button class="btn sm">Add note</button></form>
        ${c.notes.map((n) => `<div class="nt">${esc(n.body)}<small>${esc(n.by || 'Riyeser')} · ${ago(n.at)}</small></div>`).join('')}</div>
      <p class="privacy">🔒 HQ shows account information only. Customers' messages, calls and books are never shown here.</p>`;
    document.body.append(scrim, panel);
    panel.querySelector('#x').onclick = close;
    panel.querySelectorAll('[data-save]').forEach((btn) => btn.onclick = async () => {
      const row = btn.closest('tr'); const st = row.querySelector('[name=st]').value; const dt = row.querySelector('[name=dt]').value;
      if (!dt) { alert('Choose a date.'); return; }
      try { await api.setModule(id, btn.dataset.save, st, st === 'trial' ? dt : null, st === 'trial' ? null : dt); openCompany(id); } catch (err) { alert(plain(err)); } });
    const pf = panel.querySelector('#plan'); if (pf && can('finance')) pf.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
      try { await api.setPlan(id, Number(f.get('users') || 0), Number(f.get('cos') || 0), String(f.get('billing')), !!f.get('eb')); openCompany(id); } catch (err) { alert(plain(err)); } };
    panel.querySelector('#nf').onsubmit = async (e) => { e.preventDefault();
      try { await api.addNote(id, String(new FormData(e.target).get('body'))); openCompany(id); } catch (err) { alert(plain(err)); } };
  }


  // ------------------------------------------------------------------ licences
  async function licences() {
    main('<p class="muted">Loading…</p>');
    const L = await api.licences();
    main(`<h2>Licences</h2><p class="sub">Who pays for what. The money figure is an estimate at list prices until payments are connected.</p>
      <div class="tiles">${tile('Monthly income (estimate)', money(L.monthly_estimate), `${money(L.monthly_estimate * 12)} a year`)}${tile('Paying companies', num(L.paying_companies), 'at least one paid program')}
        ${tile('Early bird places left', num(L.early_bird_left), `of 100 · ${num(L.early_bird_used)} taken`)}${tile('Ending in 14 days', num((L.ending_soon || []).length), 'trials and paid periods')}</div>
      <div class="grid g2"><div class="card scroll"><h3>By program</h3><table class="tbl"><tr><th>Program</th><th class="n">Paid</th><th class="n">On trial</th><th class="n">Ended</th></tr>
        ${(L.modules || []).map((m) => `<tr><td>${esc(modName(m.module))}</td><td class="n">${num(m.active_paid)}</td><td class="n">${num(m.on_trial)}</td><td class="n">${num(m.ended)}</td></tr>`).join('')}</table></div>
      <div class="card scroll"><h3>Ending soon <small>· follow up before they lapse</small></h3>${(L.ending_soon || []).length ? `<table class="tbl"><tr><th>Company</th><th>Program</th><th class="n">Days</th></tr>
        ${L.ending_soon.map((x) => `<tr class="click" data-co="${x.id}"><td><b>${esc(x.name)}</b><small class="code">${esc(x.company_code || '')}</small></td><td>${esc(modName(x.module))} <small>${x.status === 'trial' ? 'free trial' : 'paid period'}</small></td><td class="n"><span class="pill warn">${x.days_left}</span></td></tr>`).join('')}</table>`
        : '<p class="muted small">Nothing ending in the next 14 days.</p>'}</div></div>`).querySelectorAll('[data-co]').forEach((r) => r.onclick = () => openCompany(r.dataset.co));
  }

  // ------------------------------------------------------------------ downloads
  async function downloads() {
    const m = main('<h2>Downloads</h2><p class="sub">Installer downloads from riyeser.com and Riyeser Central (from GitHub releases).</p><div id="dl"><p class="muted">Loading…</p></div>');
    let releases = [];
    try { for (let page = 1; page <= 3; page++) { const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`); if (!r.ok) break;
        const batch = await r.json(); releases = releases.concat(batch); if (batch.length < 100) break; } } catch { /* offline: show what we have */ }
    const byProduct = {}; const byRelease = [];
    for (const rel of releases) { let tot = 0; for (const a of rel.assets || []) { if (!/\.exe$/i.test(a.name)) continue;
      const p = productOf(a.name); byProduct[p] = (byProduct[p] || 0) + a.download_count; tot += a.download_count; }
      byRelease.push({ tag: rel.tag_name, when: rel.published_at, total: tot }); }
    const prod = Object.entries(byProduct).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
    const total = prod.reduce((a, b) => a + b.n, 0);
    // Daily trend from HQ's saved totals: downloads each day = today's total minus yesterday's.
    let trend = [];
    try { const rows = await api.downloadsDaily(60); const perDay = {}; rows.forEach((r) => { perDay[r.day] = (perDay[r.day] || 0) + Number(r.total); });
      const days = Object.keys(perDay).sort(); trend = days.slice(1).map((d, i) => ({ day: d, n: Math.max(0, perDay[d] - perDay[days[i]]) })); } catch { /* no saved totals yet */ }
    m.querySelector('#dl').innerHTML = `<div class="tiles">${tile('All downloads', num(total), `${releases.length} releases`)}${tile('Riyeser Central', num(byProduct['Riyeser Central']), 'the first install')}
        ${tile('Latest release', esc(byRelease[0] ? byRelease[0].tag.replace('riyeser-', '') : '—'), byRelease[0] ? `${num(byRelease[0].total)} downloads · ${day(byRelease[0].when)}` : '')}${tile('Programs', num(prod.length), 'with downloads')}</div>
      <div class="grid g2"><div class="card"><h3>By program <small>· all time</small></h3>${barList(prod, (r) => r.name, (r) => r.n)}</div>
        <div class="card"><h3>Downloads per day <small>· from HQ's daily counts</small></h3>${trend.length ? columnChart(trend.slice(-30), (r) => new Date(r.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), (r) => r.n, 'downloads')
          : '<p class="muted small">Starts once the daily download job is set up (see ops/RUNBOOK.md). Totals on the left are live.</p>'}</div></div>
      <div class="card scroll" style="margin-top:14px"><h3>By release</h3><table class="tbl"><tr><th>Release</th><th>Published</th><th class="n">Downloads</th></tr>
        ${byRelease.slice(0, 15).map((r) => `<tr><td class="code">${esc(r.tag)}</td><td>${day(r.when)}</td><td class="n">${num(r.total)}</td></tr>`).join('')}</table></div>`;
  }

  // ------------------------------------------------------------------ HQ team
  async function team() {
    const staff = await api.staff(); const owner = can();
    const m = main(`<h2>HQ team</h2><p class="sub">Riyeser staff who can use HQ. Everyone needs two-step sign-in.</p>
      <div class="card scroll"><table class="tbl"><tr><th>Name</th><th>Role</th><th>Status</th><th>Added</th>${owner ? '<th></th>' : ''}</tr>
      ${staff.map((s) => `<tr><td><b>${esc(s.display_name)}</b><small>${esc(s.email)}</small></td><td>${owner && s.display_name !== S.me.name ? `<select data-role="${s.user_id}">${ROLES.map(([k, l]) => `<option value="${k}"${k === s.role ? ' selected' : ''}>${l}</option>`).join('')}</select>` : esc(roleName(s.role))}</td>
        <td>${s.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Switched off</span>'}</td><td>${day(s.added_at)}</td>
        ${owner ? `<td>${s.display_name !== S.me.name ? `<button class="btn sm" data-toggle="${s.user_id}" data-active="${s.active}">${s.active ? 'Switch off' : 'Switch on'}</button>` : '<span class="muted small">you</span>'}</td>` : ''}</tr>`).join('')}</table></div>
      ${owner ? `<div class="card" style="margin-top:14px"><h3>Add someone to the HQ team</h3><p class="muted small">They need a Riyeser account first (riyeser.com/team), and must turn on two-step sign-in there.</p>
        <form id="as" class="grid g3"><label class="f"><span>Email</span><input type="email" name="email" required></label><label class="f"><span>Name</span><input name="name" required maxlength="60"></label>
        <label class="f"><span>Role</span><select name="role">${ROLES.map(([k, l]) => `<option value="${k}"${k === 'support' ? ' selected' : ''}>${l}</option>`).join('')}</select></label><div><button class="btn p">Add</button></div></form>
        <p class="muted small"><b>Owner</b>: everything. <b>Finance</b>: companies and billing. <b>Support</b> and <b>Sales</b>: companies and notes. <b>Developer</b>: overview and downloads.</p></div>` : ''}`);
    m.querySelectorAll('[data-role]').forEach((sel) => sel.onchange = async () => { const s = staff.find((x) => x.user_id === sel.dataset.role);
      try { await api.setStaff(s.user_id, sel.value, s.active); team(); } catch (err) { alert(plain(err)); team(); } });
    m.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => { const s = staff.find((x) => x.user_id === b.dataset.toggle);
      if (s.active && !confirm(`Switch off ${s.display_name}'s HQ access?`)) return;
      try { await api.setStaff(s.user_id, s.role, !s.active); team(); } catch (err) { alert(plain(err)); } });
    const as = m.querySelector('#as'); if (as) as.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
      try { await api.addStaff(String(f.get('email')), String(f.get('name')), String(f.get('role'))); team(); } catch (err) { alert(plain(err)); } };
  }

  // ------------------------------------------------------------------ HQ history
  const ACTS = { 'company.viewed': 'opened a company', 'note.added': 'added a note', 'calls.paid_until': 'changed Team Calls paid-until',
    'licence.module': 'changed a licence', 'licence.plan': 'changed a plan',
    'staff.added': 'added HQ staff', 'staff.changed': 'changed HQ staff', 'staff.owner_made': 'made an HQ owner (SQL Editor)' };
  async function history() {
    const rows = await api.history(); const coName = (id) => (S.companies.find((c) => c.id === id) || {}).name;
    main(`<h2>HQ history</h2><p class="sub">Everything done in HQ, by whom and when. It can't be edited.</p>
      <div class="card scroll"><table class="tbl"><tr><th>When</th><th>Who</th><th>What</th></tr>
      ${rows.map((h) => { const d = h.details || {}; const extra = [coName(d.workspace_id), d.module ? modName(d.module) : null, d.status, d.email, d.until, d.role].filter(Boolean).join(' · ');
        return `<tr><td>${ago(h.at)}<small>${day(h.at)}</small></td><td>${esc(h.who)}</td><td>${esc(ACTS[h.action] || h.action)}${extra ? ` <small>${esc(extra)}</small>` : ''}</td></tr>`; }).join('')}</table></div>`);
  }

  window.RiyeserHQ = { state: S, demo: DEMO, openCompany };
  start();
})();
