/* Riyeser HQ: the back office for running Riyeser. Riyeser staff only, with two-step sign-in.
   Shows account information (companies, people counts, branches, linked PCs and versions, trials, Team Chat Plus,
   downloads, notes), support tickets, refunds, free periods and the staff history. It never sees customers' chat
   messages, calls or books: the database only offers hq_ summaries. Support tickets are written to Riyeser, so HQ sees those.
   Every button is checked again by the database (hq_need); the website only hides what you can't do.
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
  const day = (t) => (t ? new Date(String(t).length === 10 ? t + 'T00:00:00' : t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : Math.round(m / 1440) === 1 ? '1 day ago' : `${Math.round(m / 1440)} days ago`; };
  const hours = (a, b = Date.now()) => (new Date(b) - new Date(a)) / 3600000;
  const dur = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);
  const ROLES = [['owner', 'Owner'], ['finance', 'Finance'], ['support', 'Support'], ['senior', 'Senior support'], ['sales', 'Sales'], ['developer', 'Developer']];
  const roleName = (r) => (ROLES.find((x) => x[0] === r) || [r, r])[1];
  const MODULES = [['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['payroll', 'Payroll'], ['pos', 'POS'], ['bookings', 'Bookings'], ['as_built', 'As Built'], ['calls', 'Team Chat Plus']];
  const modName = (m) => (MODULES.find((x) => x[0] === m) || [m, m])[1];
  const money = (n) => '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const cur = (n, c) => `${esc(c || 'FJD')} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const statusPill = (v) => (v.status === 'active' ? `<span class="pill ok">Paid${v.paid_until ? ` to ${day(v.paid_until)}` : ''}</span>`
    : v.status === 'trial' ? `<span class="pill${v.days_left <= 14 ? ' warn' : ''}">Trial · ${v.days_left} days</span>`
    : v.status === 'cancelled' ? (v.active ? `<span class="pill warn">Cancelled · works to ${day(v.paid_until)}</span>` : '<span class="pill bad">Cancelled</span>')
    : v.status === 'closed' ? '<span class="pill bad">Business closed</span>' : '<span class="pill bad">Ended</span>');
  // Which program each installer is (older file names included).
  const PRODUCT = [[/Central/i, 'Riyeser Central'], [/AccountingBasics/i, 'Accounting Basics'], [/Accounting(Plus)?-Setup|AccountingPlus/i, 'Accounting Plus'],
    [/POS/i, 'POS'], [/Invoices/i, 'Invoices'], [/Bookings/i, 'Bookings'], [/Payroll/i, 'Payroll'], [/DeskAssistant/i, 'Desk Assistant'],
    [/PDF/i, 'PDF'], [/Services|AsBuilt/i, 'As Built']];
  const productOf = (asset) => (PRODUCT.find(([re]) => re.test(asset)) || [null, 'Other'])[1];
  const plain = (e) => { const m = (e && (e.message || e.msg || e.error_description)) || String(e);
    if (/Invalid login/i.test(m)) return 'That email or password isn\'t right.';
    if (/Invalid TOTP|mfa_verification_failed/i.test(m)) return 'That code isn\'t right. Type the 6 numbers your authenticator app shows now.';
    if (missing(e)) return 'Run the latest team-chat.sql to switch this on.';
    return m; };
  // The live database may not have this release's functions yet (until team-chat.sql is re-run).
  function missing(e) { const m = (e && (e.message || '')) + ' ' + ((e && e.code) || ''); return /PGRST202|Could not find the function|schema cache|does not exist/i.test(m); }
  const SWITCH_ON = '<div class="card"><p class="muted">Run the latest <b>team-chat.sql</b> in Supabase (SQL Editor) to switch this on. See ops/RUNBOOK.md.</p></div>';

  // Permissions (the same list and role defaults as the database: hq_all_perms / hq_role_perms).
  const PERMS = [['overview.view', 'See the overview'], ['downloads.view', 'See downloads'], ['customers.view', 'See businesses'], ['customers.notes', 'Add notes'],
    ['customers.edit', 'Edit business details'], ['people.reset_2fa', 'Reset two-step sign-in'], ['people.change_owner', 'Change a business\'s owner'],
    ['business.close', 'Close, suspend or reopen businesses'], ['licences.view', 'See licences'], ['licences.manage', 'Change licences and plans'],
    ['support.view', 'See support tickets'], ['support.reply', 'Reply to tickets (level 1)'], ['support.assign', 'Assign tickets'],
    ['support.saved_replies', 'Manage saved replies'], ['support.escalate', 'Escalate tickets'], ['support.level2', 'Work level 2 (senior) tickets'],
    ['support.level3', 'Work level 3 (management) tickets'], ['refunds.view', 'See refunds'], ['refunds.request', 'Enter a refund request for a customer'],
    ['refunds.approve', 'Approve refunds'], ['refunds.pay', 'Mark refunds paid'], ['offers.grant', 'Give free periods'], ['offers.approve', 'Approve free periods (supervisor)'],
    ['emails.view', 'See the email outbox'], ['emails.manage', 'Send held or failed emails again'], ['accounts.inactive', 'Approve removing inactive accounts'],
    ['staff.manage', 'Manage the HQ team'], ['audit.view', 'See the HQ history'], ['settings.manage', 'Change HQ settings']];
  const BASE = ['overview.view', 'downloads.view'];
  const ROLE_PERMS = {
    owner: PERMS.map((p) => p[0]),
    finance: [...BASE, 'customers.view', 'customers.notes', 'licences.view', 'licences.manage', 'support.view', 'support.reply', 'support.level2', 'support.level3',
      'support.escalate', 'refunds.view', 'refunds.approve', 'refunds.pay', 'offers.grant', 'offers.approve', 'emails.view'],
    support: [...BASE, 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa', 'licences.view', 'support.view', 'support.reply', 'support.assign',
      'support.saved_replies', 'support.escalate', 'refunds.view', 'refunds.request', 'offers.grant', 'emails.view'],
    senior: [...BASE, 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa', 'people.change_owner', 'business.close', 'licences.view', 'support.view',
      'support.reply', 'support.assign', 'support.saved_replies', 'support.escalate', 'support.level2', 'refunds.view', 'refunds.request', 'offers.grant', 'emails.view', 'emails.manage'],
    sales: [...BASE, 'customers.view', 'customers.notes', 'licences.view', 'support.view', 'offers.grant'],
    developer: [...BASE],
  };
  const permsOf = (s) => (s.role === 'owner' ? ROLE_PERMS.owner : [...new Set([...(ROLE_PERMS[s.role] || []), ...(s.perms_add || [])])].filter((p) => !(s.perms_remove || []).includes(p)));
  const LEVELS = { 1: 'Support', 2: 'Senior', 3: 'Management' };
  const LEVEL_PERM = { 1: 'support.reply', 2: 'support.level2', 3: 'support.level3' };
  const TOPICS = { billing: 'Billing', signin: 'Signing in', program: 'A program problem', other: 'Something else' };
  const TSTAT = { new: ['New', 'warn'], waiting_us: ['Waiting on us', 'warn'], waiting_customer: ['Waiting on customer', ''], done: ['Done', 'ok'] };
  const RSTAT = { submitted: ['New', 'warn'], reviewing: ['Reviewing', ''], approved: ['Approved', 'ok'], partly_approved: ['Partly approved', 'ok'], declined: ['Declined', 'bad'], paid: ['Paid', 'ok'] };
  const RWHY = { mistake: 'Charged by mistake', didnt_work: 'Didn\'t work', cancelled: 'Cancelled', duplicate: 'Duplicate payment', other: 'Other' };
  const PAID_HOW = [['card', 'Card refund'], ['bank', 'Bank transfer'], ['mpaisa', 'M-PAiSA'], ['credit', 'Credit on account']];
  const OFFER_WHY = [['retention', 'Retention'], ['goodwill', 'Goodwill after a problem'], ['promotion', 'Sales promotion'], ['other', 'Other']];
  const OFFER_KIND = { trial: 'Longer free trial', paid: 'Free time on a paid program', account: 'Whole account (all paid programs)' };
  const BSTAT = { active: ['Open', 'ok'], suspended: ['Suspended', 'warn'], closed: ['Closed', 'bad'] };
  const pill = (map, k, extra = '') => { const [l, c] = map[k] || [k, '']; return `<span class="pill${c ? ' ' + c : ''}">${esc(l)}${extra}</span>`; };
  const creditText = (c) => Object.entries(c || {}).filter(([, v]) => Number(v)).map(([k, v]) => cur(v, k)).join(' + ');

  // ------------------------------------------------------------------ online
  function online() {
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, storageKey: 'riyeser.hq.session' } });
    const ok = ({ data, error }) => { if (error) throw error; return data; };
    const rpc = async (f, a) => ok(await sb.rpc(f, a || {}));
    const fix = (reason, ticket) => ({ reason, ticket_ref: ticket || null });
    return {
      async session() { return ok(await sb.auth.getSession()).session; },
      async signIn(email, password) { ok(await sb.auth.signInWithPassword({ email, password })); },
      async signOut() { await sb.auth.signOut(); },
      async aal() { return ok(await sb.auth.mfa.getAuthenticatorAssuranceLevel()); },
      async factors() { const f = ok(await sb.auth.mfa.listFactors()); return (f.totp || []).filter((x) => x.status === 'verified'); },
      async verify(factorId, code) { ok(await sb.auth.mfa.challengeAndVerify({ factorId, code })); },
      me: () => rpc('hq_me'), overview: () => rpc('hq_overview'),
      async companies(search, status) {
        try { return await rpc('hq_business_list', { search: search || '', status_filter: status || 'all' }); }
        catch (e) { if (!missing(e)) throw e; return rpc('hq_companies', { search: search || '' }); }
      },
      company: (ws) => rpc('hq_company', { ws }), setCallsPaid: (ws, until) => rpc('hq_set_calls_paid', { ws, until }),
      addNote: (ws, body) => rpc('hq_add_note', { ws, body }),
      async staff() { try { return (await rpc('hq_team')).staff; } catch (e) { if (!missing(e)) throw e; return rpc('hq_staff_list'); } },
      team: () => rpc('hq_team'),
      addStaff: (email, name, role) => rpc('hq_add_staff', { staff_email: email, staff_name: name, staff_role: role }),
      setStaff: (staff, role, active) => rpc('hq_set_staff', { staff, staff_role: role, is_active: active }),
      setStaffPerms: (staff, on, off) => rpc('hq_set_staff_perms', { staff, perms_on: on, perms_off: off }),
      async history(f = {}) {
        try { return await rpc('hq_audit_search', { who: f.who || null, action_like: f.action || null, ws: f.ws || null, from_day: f.from || null, to_day: f.to || null, for_export: !!f.exp }); }
        catch (e) { if (!missing(e) || f.exp) throw e; return rpc('hq_history'); }
      },
      downloadsDaily: (days) => rpc('hq_downloads', { days }),
      licences: () => rpc('hq_licences'), companyLicence: (ws) => rpc('hq_company_licence', { ws }),
      setModule: (ws, mod, status, trialEnd, paidTo) => rpc('hq_set_module', { ws, mod, new_status: status, trial_end: trialEnd || null, paid_to: paidTo || null }),
      setPlan: (ws, users, cos, billing, eb) => rpc('hq_set_plan', { ws, users_extra: users, companies_extra: cos, billing_period: billing, is_early_bird: eb }),
      settings: () => rpc('hq_get_settings'), setSetting: (k, v) => rpc('hq_set_setting', { setting: k, val: v }),
      // support
      tickets: (box, q) => rpc('hq_tickets', { box, search: q || '' }), ticket: (id) => rpc('hq_ticket', { ticket: id }),
      ticketReply: (id, msg, note, st) => rpc('hq_ticket_reply', { ticket: id, message: msg, as_note: !!note, then_status: st || null }),
      ticketStatus: (id, st) => rpc('hq_ticket_status', { ticket: id, new_status: st }), ticketPriority: (id, p) => rpc('hq_ticket_priority', { ticket: id, new_priority: p }),
      ticketAssign: (id, staff) => rpc('hq_ticket_assign', { ticket: id, staff: staff || null }),
      ticketEscalate: (id, level, reason, assign) => rpc('hq_ticket_escalate', { ticket: id, to_level: level, reason, assign_to: assign || null }),
      savedReplies: () => rpc('hq_saved_replies'), saveReply: (id, title, body) => rpc('hq_save_reply', { reply_id: id || null, title, body }),
      retireReply: (id) => rpc('hq_retire_reply', { reply_id: id }),
      // fix-up tools
      editBusiness: (ws, profile, reason, ticket) => rpc('hq_edit_business', { ws, profile, ...fix(reason, ticket) }),
      reset2fa: (ws, person, how, reason, ticket) => rpc('hq_reset_2fa', { ws, person, identity_checked: how, ...fix(reason, ticket) }),
      changeOwner: (ws, person, reason, ticket) => rpc('hq_change_owner', { ws, new_owner: person, ...fix(reason, ticket) }),
      setBusinessStatus: (ws, st, reason, ticket) => rpc('hq_set_business_status', { ws, new_status: st, ...fix(reason, ticket) }),
      closeDuplicate: (ws, dup, reason, ticket) => rpc('hq_close_duplicate', { ws, duplicate_of_ws: dup, ...fix(reason, ticket) }),
      // inactive accounts, emails
      inactive: () => rpc('hq_inactive_accounts'), removeAccounts: (ids, reason) => rpc('hq_remove_accounts', { ids, reason }),
      emails: () => rpc('hq_emails'), emailResend: (id) => rpc('hq_email_resend', { email_id: id }),
      // refunds, free periods, approvals
      refunds: (box) => rpc('hq_refunds', { box }),
      refundCreate: (ticket, r) => rpc('hq_refund_create', { ticket, for_what: r.for_what, period: r.period, invoice_ref: r.invoice_ref, amount: r.amount, currency: r.currency, reason_category: r.reason_category, explanation: r.explanation }),
      refundReview: (id) => rpc('hq_refund_review', { refund: id }),
      refundDecide: (id, decision, amount, reason) => rpc('hq_refund_decide', { refund: id, decision, approved_amount: amount || null, reason }),
      refundSecond: (id, reason) => rpc('hq_refund_second', { refund: id, reason }), refundPaid: (id, method, ref) => rpc('hq_refund_paid', { refund: id, method, reference: ref }),
      grantOffer: (ws, o) => rpc('hq_grant_offer', { ws, kind: o.kind, modules: o.modules, length_amount: o.amount, length_unit: o.unit, reason_category: o.why, reason: o.reason, ticket_ref: o.ticket || null }),
      decideOffer: (id, approve, reason) => rpc('hq_decide_offer', { offer: id, approve, reason: reason || null }),
      approvals: () => rpc('hq_approvals'),
    };
  }
  // ------------------------------------------------------------------ demo (sample data, nothing real)
  function demo() {
    const t = (d) => new Date(Date.now() - d * 864e5).toISOString();
    const h = (n) => new Date(Date.now() - n * 3600e3).toISOString();
    const now = () => new Date().toISOString();
    const cos = [
      { id: 'w1', name: 'Sample Plumbing', company_code: 'RIY-7K3M-Q2', country: 'Fiji', created_at: t(80), people: 5, branches: 2, pcs: 3, last_seen: t(0.01), calls_paid_until: null, trial_days_left: 10, owner_name: 'Alex', owner_email: 'alex@sample.test', status: 'active', kind: 'business', last_active_at: t(0.01) },
      { id: 'w2', name: 'Harbour Cafe', company_code: 'RIY-H4RB-9C', country: 'Fiji', created_at: t(40), people: 9, branches: 1, pcs: 2, last_seen: t(0.2), calls_paid_until: t(-200), trial_days_left: 50, owner_name: 'Mere', owner_email: 'mere@harbour.test', status: 'active', kind: 'business', last_active_at: t(0.2) },
      { id: 'w3', name: 'Northside Dental', company_code: 'RIY-N7DL-4T', country: 'Australia', created_at: t(12), people: 4, branches: 1, pcs: 4, last_seen: t(1), calls_paid_until: null, trial_days_left: 78, owner_name: 'Priya', owner_email: 'priya@northside.test', status: 'active', kind: 'business', last_active_at: t(1) },
      { id: 'w4', name: 'Island Traders', company_code: 'RIY-1SLD-T8', country: 'Fiji', created_at: t(3), people: 2, branches: 2, pcs: 1, last_seen: t(3), calls_paid_until: null, trial_days_left: 87, owner_name: 'Jone', owner_email: 'jone@island.test', status: 'active', kind: 'business', last_active_at: t(3) },
      { id: 'w5', name: 'Quiet Joinery', company_code: 'RIY-QJ8N-2R', country: 'New Zealand', created_at: t(700), people: 1, branches: 1, pcs: 0, last_seen: null, calls_paid_until: null, trial_days_left: 0, owner_name: 'Sam', owner_email: 'sam@joinery.test', status: 'active', kind: 'personal', last_active_at: t(345) },
      { id: 'w6', name: 'Old Corner Store', company_code: 'RIY-0CS7-4M', country: 'Fiji', created_at: t(1200), people: 2, branches: 1, pcs: 0, last_seen: null, calls_paid_until: null, trial_days_left: 0, owner_name: 'Lee', owner_email: 'lee@corner.test', status: 'closed', kind: 'business', last_active_at: t(1130), closed_at: t(765), closed_reason: 'inactive' },
      { id: 'w7', name: 'Sample Plumbing (2)', company_code: 'RIY-7K3X-Q9', country: 'Fiji', created_at: t(60), people: 1, branches: 1, pcs: 0, last_seen: null, calls_paid_until: null, trial_days_left: 30, owner_name: 'Alex', owner_email: 'alex@sample.test', status: 'closed', kind: 'business', last_active_at: t(59), closed_at: t(50), closed_reason: 'Duplicate: signed up twice', duplicate_of: 'w1' }];
    const staff = [{ user_id: 's1', display_name: 'Riki', role: 'owner', active: true, email: 'riki@riyeser.test', added_at: t(30), perms_add: [], perms_remove: [] },
      { user_id: 's2', display_name: 'Help Desk', role: 'support', active: true, email: 'help@riyeser.test', added_at: t(5), perms_add: [], perms_remove: [] },
      { user_id: 's3', display_name: 'Finance Fi', role: 'finance', active: true, email: 'money@riyeser.test', added_at: t(4), perms_add: [], perms_remove: [] },
      { user_id: 's4', display_name: 'Senior Sione', role: 'senior', active: true, email: 'senior@riyeser.test', added_at: t(3), perms_add: [], perms_remove: [] }];
    let actor = 's1';
    const me = () => staff.find((s) => s.user_id === actor); const nameOf = (id) => (staff.find((s) => s.user_id === id) || {}).display_name || null;
    const need = (p) => { if (!permsOf(me()).includes(p)) throw new Error('Your HQ role can\'t do that.'); };
    const mods = { w2: { basic: { status: 'active', paid_until: t(-300).slice(0, 10) }, pos: { status: 'active', paid_until: t(-300).slice(0, 10) }, calls: { status: 'active', paid_until: t(-200).slice(0, 10) } },
      w1: { basic: { status: 'active', paid_until: t(-20).slice(0, 10) }, payroll: { status: 'cancelled', paid_until: t(5).slice(0, 10) } } };
    const plans = { w2: { extra_users: 6, extra_companies: 0, billing: 'yearly', early_bird: true } };
    const settings = { 'support.overdue_hours': 24, 'support.escalate_hours': 48, 'refunds.two_person_threshold': 200, 'offers.self_limit_days': 31 };
    const today = () => new Date(new Date().toISOString().slice(0, 10));
    const dd = (a) => Math.round((new Date(a) - today()) / 864e5);
    const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5).toISOString().slice(0, 10);
    const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x.toISOString().slice(0, 10); };
    function demoLicence(ws) { const c = cos.find((x) => x.id === ws); const joined = c.created_at.slice(0, 10);
      const modules = {}; MODULES.forEach(([m]) => { const r = (mods[ws] || {})[m];
        if (c.status !== 'active') { modules[m] = { status: 'closed', active: false, trial_ends: null, paid_until: null, days_left: null }; return; }
        if (!r || r.status === 'trial') { const te = r && r.trial_ends ? r.trial_ends : new Date(new Date(joined).getTime() + 90 * 864e5).toISOString().slice(0, 10); const left = dd(te);
          modules[m] = { status: left >= 0 ? 'trial' : 'ended', active: left >= 0, trial_ends: te, paid_until: null, days_left: left >= 0 ? left : null }; }
        else if (r.status === 'active') { const left = dd(r.paid_until); modules[m] = { status: left >= 0 ? 'active' : 'ended', active: left >= 0, trial_ends: null, paid_until: r.paid_until, days_left: left >= 0 ? left : null }; }
        else { const left = r.paid_until ? dd(r.paid_until) : -1; modules[m] = { status: 'cancelled', active: left >= 0, trial_ends: null, paid_until: r.paid_until, days_left: left >= 0 ? left : null }; } });
      const pl = plans[ws] || {}; return { workspace_id: ws, company_code: c.company_code, modules, seats: { included: 3, extra: pl.extra_users || 0, used: c.people }, extra_companies: pl.extra_companies || 0, billing: pl.billing || 'monthly', early_bird: !!pl.early_bird }; }
    function demoMonthly(ws) { const l = demoLicence(ws); const n = Object.values(l.modules).filter((v) => v.status === 'active').length;
      let m = n * 20 + l.seats.extra * 5 + l.extra_companies * 10; if (l.billing === 'yearly') m *= 10 / 12; if (l.early_bird) m *= 0.5; return Math.round(m * 100) / 100; }
    const notes = { w1: [{ body: 'Called Alex: wants POS for the Lautoka branch next month.', at: t(2), by: 'Riki' }] };
    const hist = [{ at: t(0.1), actor: 's1', who: 'Riki', action: 'customer.viewed', workspace_id: 'w1', details: { workspace_id: 'w1' } }, { at: t(2), actor: 's1', who: 'Riki', action: 'note.added', workspace_id: 'w1', details: { workspace_id: 'w1' } },
      { at: t(3), actor: 's2', who: 'Help Desk', action: 'ticket.replied', workspace_id: 'w2', ticket: 'T-10235', details: { workspace_id: 'w2', ticket: 'T-10235' } },
      { at: t(5), actor: 's1', who: 'Riki', action: 'staff.added', details: { email: 'help@riyeser.test', role: 'support' } }, { at: t(30), actor: null, who: 'Riyeser', action: 'staff.owner_made', details: { email: 'riki@riyeser.test' } }];
    const log = (action, details = {}) => hist.unshift({ at: now(), actor, who: me().display_name, action, workspace_id: details.workspace_id || null, ticket: details.ticket || null, details });
    const daily = []; const assets = ['RiyeserCentral-Setup.exe', 'RiyeserAccountingBasics-Setup.exe', 'RiyeserPOS-Setup.exe', 'RiyeserInvoices-Setup.exe', 'RiyeserBookings-Setup.exe'];
    for (let d = 29; d >= 0; d--) assets.forEach((a, i) => daily.push({ day: t(d).slice(0, 10), asset: a, total: Math.round((30 - d) * (6 - i) * 1.7 + 20 * (6 - i)) }));
    // support
    let tn = 10234; const mk = (ws, by, email, topic, subject, status, level, created, msgs, extra = {}) => ({ id: 'tk' + tn, ref: 'T-' + tn++, workspace_id: ws, opened_by_name: by, opened_by_email: email, topic, subject, status, priority: 'normal', level,
      assignee: null, created_at: created, updated_at: msgs.length ? msgs[msgs.length - 1].at : created, first_reply_at: (msgs.find((m) => m.staff && !m.internal) || {}).at || null, last_customer_at: created, messages: msgs, escalations: [], ...extra });
    const cm = (from, body, at) => ({ staff: false, internal: false, from, body, at }); const sm = (from, body, at, internal = false) => ({ staff: true, internal, from, body, at });
    const tickets = [
      mk('w1', 'Alex', 'alex@sample.test', 'program', 'Receipt printer stopped after the update', 'new', 1, h(30), [cm('Alex', 'Since the 1.7.0 update the POS receipt printer prints nothing. Kitchen printer is fine.', h(30))]),
      mk('w2', 'Mere', 'mere@harbour.test', 'billing', 'Charged twice in November', 'waiting_us', 1, h(5), [cm('Mere', 'Our card was charged twice for November. Can you check?', h(5))]),
      mk('w3', 'Priya', 'priya@northside.test', 'signin', 'Lost my phone, can\'t sign in', 'waiting_customer', 1, t(1), [cm('Priya', 'New phone, and the authenticator app is gone. How do I get back in?', t(1)), sm('Help Desk', 'Sorry about that, Priya. We\'ll call you on the number on file to check it\'s you, then reset it.', h(20))]),
      mk('w4', 'Jone', 'jone@island.test', 'program', 'Payroll totals don\'t match the bank', 'waiting_us', 2, t(3), [cm('Jone', 'The pay run total is $12 more than what left the bank.', t(3)), sm('Help Desk', 'Escalated to Senior by Help Desk: needs a look at the rounding', t(2), true), sm(null, 'We\'ve passed this to our senior team. They\'ll reply here.', t(2))],
        { escalations: [{ from: 1, to: 2, by: 'Help Desk', reason: 'needs a look at the rounding', at: t(2) }] }),
      mk(null, 'someone@example.test', 'someone@example.test', 'other', 'Do you support NZ GST?', 'done', 1, t(6), [cm('Customer', 'Thinking of switching. Do you handle NZ GST returns?', t(6)), sm('Riki', 'Yes: Accounting Plus does NZ GST returns.', t(5.8))])];
    tickets[1].assignee = 's2';
    const saved = [{ id: 1, title: 'Two-step reset: identity check', body: 'Thanks for letting us know. To keep your account safe we\'ll call you back on the phone number we have on file before we reset two-step sign-in.' },
      { id: 2, title: 'Printer: turn it off and on', body: 'Please turn the printer off and on again, then print a test page from POS → Settings → Printers. Let us know what happens.' }];
    // refunds, offers, credit, emails
    let rn = 1042; const refunds = [
      { id: 'rf' + rn, ref: 'R-' + rn++, workspace_id: 'w2', business: 'Harbour Cafe', requested_by_name: 'Mere', ticket_id: 'tk10235', ticket_ref: 'T-10235', for_what: 'Accounting Basics', period: 'November 2026', invoice_ref: 'INV-2211', amount: 350, currency: 'FJD', reason_category: 'duplicate', explanation: 'Charged twice in November.', status: 'submitted', created_at: h(5), needs_second: false },
      { id: 'rf' + rn, ref: 'R-' + rn++, workspace_id: 'w3', business: 'Northside Dental', requested_by_name: 'Priya', ticket_id: null, ticket_ref: null, for_what: 'POS', period: 'October 2026', invoice_ref: null, amount: 40, currency: 'AUD', reason_category: 'didnt_work', explanation: 'Didn\'t use it.', status: 'reviewing', created_at: t(2), needs_second: false },
      { id: 'rf' + rn, ref: 'R-' + rn++, workspace_id: 'w1', business: 'Sample Plumbing', requested_by_name: 'Alex', ticket_id: null, ticket_ref: null, for_what: 'Payroll', period: 'September 2026', invoice_ref: null, amount: 20, currency: 'FJD', reason_category: 'cancelled', explanation: '', status: 'paid', created_at: t(40), decided_by_name: 'Riki', decision_reason: 'Cancelled on the 1st', amount_approved: 20, paid_at: t(38), paid_method: 'credit', needs_second: false }];
    const credits = { w1: { FJD: 20 } };
    let on = 1002; const offers = [{ id: 'of1001', ref: 'O-1001', workspace_id: 'w3', business: 'Northside Dental', modules: ['pos'], kind: 'trial', length_amount: 14, length_unit: 'days', days: 14, reason_category: 'goodwill', reason: 'Printer trouble last week', status: 'applied', requested_by: 's2', requested_by_name: 'Help Desk', created_at: t(4), applied_at: t(4), ends_at: addDays(today(), 92) }];
    let en = 9; const emails = [
      { id: 1, to_address: 'priya@northside.test', subject: 'We\'ve got your help request (T-10236)', template: 'ticket_received', status: 'queued', attempts: 0, created_at: t(1) },
      { id: 2, to_address: null, subject: 'Your two-step sign-in was reset', template: 'mfa_reset', status: 'held', attempts: 0, created_at: t(2), last_error: 'No email address' },
      { id: 3, to_address: 'mere@harbour.test', subject: 'Re: Charged twice in November (T-10235)', template: 'ticket_reply', status: 'failed', attempts: 3, created_at: t(3), last_error: 'HTTP 422' },
      { id: 4, to_address: 'sam@joinery.test', subject: 'Quiet Joinery will close in 20 days', template: 'inactive_warning_30', status: 'queued', attempts: 0, created_at: t(0.5) }];
    const queue = (to, subject, template) => emails.unshift({ id: en++, to_address: to, subject, template, status: 'queued', attempts: 0, created_at: now() });
    const owner = (ws) => (cos.find((c) => c.id === ws) || {}).owner_email;
    const tk = (id) => tickets.find((x) => x.id === id);
    const reasonOk = (r) => { if (String(r || '').trim().length < 4) throw new Error('Give a reason (a few words is fine).'); };
    const ticketOk = (r) => { if (r && !tickets.some((x) => x.ref === r.toUpperCase().replace(/^(\d)/, 'T-$1'))) throw new Error(`There's no ticket ${r}.`); return r ? r.toUpperCase() : null; };
    function applyOffer(o) { const l = demoLicence(o.workspace_id); let end = null;
      o.modules.forEach((m) => { const v = l.modules[m]; const base = (o.kind === 'trial' ? v.trial_ends : v.paid_until) || today().toISOString().slice(0, 10);
        const from = base < today().toISOString().slice(0, 10) ? today().toISOString().slice(0, 10) : base;
        const to = o.length_unit === 'months' ? addMonths(from, o.length_amount) : addDays(from, o.length_amount);
        (mods[o.workspace_id] = mods[o.workspace_id] || {})[m] = o.kind === 'trial' ? { status: 'trial', trial_ends: to } : { status: 'active', paid_until: to }; end = !end || to > end ? to : end; });
      o.applied_at = now(); o.ends_at = end; queue(owner(o.workspace_id), `Good news: ${o.days} free days added`, 'free_period'); }
    const rowOf = (f) => ({ ...f, decided_by_name: nameOf(f.decided_by) || f.decided_by_name, second_approver_name: nameOf(f.second_approver), waiting_second: !!(f.needs_second && !f.second_approver && ['approved', 'partly_approved'].includes(f.status)) });
    return {
      async session() { return { user: { email: 'riki@riyeser.test' } }; }, async signIn() {}, async signOut() { location.href = '/hq/'; },
      async aal() { return { currentLevel: 'aal2', nextLevel: 'aal2' }; }, async factors() { return [{ id: 'f' }]; }, async verify() {},
      async me() { const s = me(); return { role: s.role, name: s.display_name, active: true, two_step: true, perms: permsOf(s), id: s.user_id }; },
      asStaff(id) { actor = id; }, staffList: () => staff.slice(),
      async overview() { return { companies: cos.length, companies_7d: 1, companies_30d: 2, people: 24, pcs: 10, pcs_active_7d: 8, pcs_active_30d: 10, requests_waiting: 1, calls_paid: 1, calls_trial: 3,
        trials_ending: [{ id: 'w1', name: 'Sample Plumbing', company_code: 'RIY-7K3M-Q2', days_left: 10 }],
        versions: [{ version: '1.6.4', pcs: 6 }, { version: '1.6.3', pcs: 3 }, { version: '1.5.1', pcs: 1 }],
        countries: [{ country: 'Fiji', companies: 5 }, { country: 'Australia', companies: 1 }, { country: 'New Zealand', companies: 1 }],
        signups_by_week: [8, 7, 6, 5, 4, 3, 2, 1].map((w, i) => ({ week: t(w * 7).slice(0, 10), companies: [0, 1, 0, 1, 0, 1, 0, 1][i] })) }; },
      async companies(s, status) { const q = (s || '').toLowerCase(); return cos.filter((c) => (!status || status === 'all' || c.status === status) && (!q || [c.name, c.company_code, c.owner_email].some((x) => x.toLowerCase().includes(q)))); },
      async company(ws) { need('customers.view'); const c = cos.find((x) => x.id === ws); log('customer.viewed', { workspace_id: ws }); const P = permsOf(me());
        return { profile: { ...c, legal_name: c.name + ' Pty Ltd', tax_number: c.tax_number || '50-12345-0-1', address: c.address || 'Suva', phone: c.phone || '330 1234', email: c.email || c.owner_email, require_approval: true,
            duplicate_of_name: c.duplicate_of ? (cos.find((x) => x.id === c.duplicate_of) || {}).name : null },
          people: c.people_list || (c.people_list = [{ user_id: ws + '-p1', name: c.owner_name, role: 'owner', job_role: 'owner', extension: 101, email: c.owner_email, joined: c.created_at, two_step: true },
            { user_id: ws + '-p2', name: 'Sam Taylor', role: 'admin', job_role: 'manager', extension: 102, email: 'sam@sample.test', joined: t(20), two_step: true },
            { user_id: ws + '-p3', name: 'Jordan Lee', role: 'member', job_role: 'staff', extension: 201, email: 'jordan@sample.test', joined: t(10), two_step: false }]),
          branches: [{ name: 'Head office', extension: 100, people: 2 }, { name: 'Lautoka branch', extension: 200, people: 1 }],
          pcs: [{ name: 'Head office PC', platform: 'Windows', version: '1.6.4', last_seen: t(0.01), person: c.owner_name }, { name: 'Lautoka front desk', platform: 'Windows', version: '1.6.3', last_seen: t(1), person: 'Jordan Lee' }],
          requests_waiting: 1, notes: notes[ws] || [],
          extra: { credit: credits[ws] || {}, tickets: P.includes('support.view') ? tickets.filter((x) => x.workspace_id === ws) : null,
            refunds: P.includes('refunds.view') ? refunds.filter((f) => f.workspace_id === ws).map(rowOf) : null, offers: offers.filter((o) => o.workspace_id === ws),
            history: P.includes('audit.view') ? hist.filter((x) => x.workspace_id === ws) : null } }; },
      async setCallsPaid(ws, until) { cos.find((x) => x.id === ws).calls_paid_until = until + 'T23:59:59Z'; log('calls.paid_until', { workspace_id: ws, until }); },
      async addNote(ws, body) { (notes[ws] = notes[ws] || []).unshift({ body, at: now(), by: me().display_name }); log('note.added', { workspace_id: ws }); },
      async staff() { return staff.map((s) => ({ ...s, perms: permsOf(s) })); },
      async team() { return { all: PERMS.map((p) => p[0]), roles: ROLE_PERMS, staff: staff.map((s) => ({ ...s, perms: permsOf(s) })) }; },
      async addStaff(email, name, role) { need('staff.manage'); staff.push({ user_id: 's' + (staff.length + 1), display_name: name, role, active: true, email, added_at: now(), perms_add: [], perms_remove: [] }); log('staff.added', { email, role }); },
      async setStaff(id, role, active) { need('staff.manage'); Object.assign(staff.find((x) => x.user_id === id), { role, active }); log('staff.changed', { user_id: id, role, active }); },
      async setStaffPerms(id, on2, off) { need('staff.manage'); if (me().role !== 'owner') throw new Error('Only an HQ owner can tick permissions on or off.');
        if (id === actor) throw new Error('You can\'t change your own HQ access. Ask another owner.'); Object.assign(staff.find((x) => x.user_id === id), { perms_add: on2, perms_remove: off }); log('staff.permissions', { user_id: id, on: on2, off }); },
      async history(f = {}) { need('audit.view'); const rows = hist.filter((x) => (!f.who || x.actor === f.who) && (!f.action || x.action.startsWith(f.action)) && (!f.ws || x.workspace_id === f.ws)
          && (!f.from || x.at.slice(0, 10) >= f.from) && (!f.to || x.at.slice(0, 10) <= f.to)).map((x) => ({ ...x, business: (cos.find((c) => c.id === x.workspace_id) || {}).name }));
        if (f.exp) log('audit.exported', { who: f.who || null, action: f.action || null }); return rows; },
      async downloadsDaily() { return daily; },
      async licences() { const list = cos.map((c) => ({ c, l: demoLicence(c.id) }));
        const ending = []; list.forEach(({ c, l }) => Object.entries(l.modules).forEach(([m, v]) => { if (v.days_left != null && v.days_left <= 14) ending.push({ id: c.id, name: c.name, company_code: c.company_code, module: m, status: v.status, days_left: v.days_left }); }));
        return { monthly_estimate: list.reduce((a, x) => a + demoMonthly(x.c.id), 0), paying_companies: list.filter((x) => demoMonthly(x.c.id) > 0).length,
          early_bird_used: Object.values(plans).filter((x) => x.early_bird).length + 37, early_bird_left: 100 - 37 - Object.values(plans).filter((x) => x.early_bird).length,
          modules: MODULES.map(([m]) => ({ module: m, active_paid: list.filter((x) => x.l.modules[m].status === 'active').length, on_trial: list.filter((x) => x.l.modules[m].status === 'trial').length,
            ended: list.filter((x) => ['ended', 'cancelled', 'closed'].includes(x.l.modules[m].status)).length })), ending_soon: ending.sort((a, b) => a.days_left - b.days_left) }; },
      async companyLicence(ws) { return { licence: demoLicence(ws), monthly: demoMonthly(ws) }; },
      async setModule(ws, mod, status, te, pt) { need('licences.manage'); (mods[ws] = mods[ws] || {})[mod] = { status, trial_ends: te || null, paid_until: pt || null }; log('licence.module', { workspace_id: ws, module: mod, status }); },
      async setPlan(ws, users, cosx, billing, eb) { need('licences.manage'); plans[ws] = { extra_users: users, extra_companies: cosx, billing, early_bird: eb }; log('licence.plan', { workspace_id: ws }); },
      async settings() { return { ...settings }; },
      async setSetting(k, v) { need('settings.manage'); settings[k] = Number(v); log('settings.changed', { setting: k, value: v }); },
      // support
      async tickets(box = 'open', q = '') { need('support.view'); const od = settings['support.overdue_hours']; const s = q.toLowerCase();
        const all = tickets.map((x) => ({ ...x, business: (cos.find((c) => c.id === x.workspace_id) || {}).name || null, assignee_name: nameOf(x.assignee), escalated: x.escalations.length > 0,
          overdue: x.status !== 'done' && !x.first_reply_at && hours(x.created_at) > od })).filter((x) => !s || [x.ref, x.subject, x.business, x.opened_by_email, ...x.messages.map((m) => m.body)].some((v) => String(v || '').toLowerCase().includes(s)));
        const f = { new: (x) => x.status === 'new', waiting_us: (x) => x.status === 'waiting_us', waiting_customer: (x) => x.status === 'waiting_customer', done: (x) => x.status === 'done',
          mine: (x) => x.status !== 'done' && x.assignee === actor, unassigned: (x) => x.status !== 'done' && !x.assignee, escalated: (x) => x.status !== 'done' && x.level > 1,
          level2: (x) => x.status !== 'done' && x.level === 2, level3: (x) => x.status !== 'done' && x.level === 3, overdue: (x) => x.status !== 'done' && x.overdue, all: () => true, open: (x) => x.status !== 'done' };
        const counts = {}; Object.keys(f).forEach((k) => { counts[k] = all.filter(f[k]).length; });
        return { tickets: all.filter(f[box] || f.open).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((x) => ({ ...x, messages: undefined })), counts, overdue_hours: od }; },
      async ticket(id) { need('support.view'); const x = tk(id); log('ticket.viewed', { ticket: x.ref, workspace_id: x.workspace_id }); const c = cos.find((y) => y.id === x.workspace_id);
        const l = c ? demoLicence(c.id) : null;
        return { ticket: { ...x, assignee_name: nameOf(x.assignee), messages: undefined }, messages: x.messages.map((m, i) => ({ ...m, id: i + 1, from: m.from || 'Riyeser (automatic)' })), escalations: x.escalations,
          business: c ? { id: c.id, name: c.name, company_code: c.company_code, status: c.status, people: c.people, pcs: c.pcs, last_active_at: c.last_active_at,
            paid: Object.keys(l.modules).filter((m) => l.modules[m].status === 'active'), trial: Object.keys(l.modules).filter((m) => l.modules[m].status === 'trial'), monthly: demoMonthly(c.id),
            credit: credits[c.id] || {}, notes: notes[c.id] || [] } : null,
          refunds: refunds.filter((f) => f.ticket_id === id), can_work: permsOf(me()).includes(LEVEL_PERM[x.level]) }; },
      async ticketReply(id, msg, note, st) { need('support.reply'); const x = tk(id); if (!permsOf(me()).includes(LEVEL_PERM[x.level])) throw new Error(`This ticket is with ${LEVELS[x.level]} (level ${x.level}). Someone who works that level needs to reply.`);
        x.messages.push(sm(me().display_name, msg, now(), !!note)); x.updated_at = now();
        if (!note) { x.first_reply_at = x.first_reply_at || now(); x.status = st || 'waiting_customer'; x.assignee = x.assignee || actor; queue(x.opened_by_email, `Re: ${x.subject} (${x.ref})`, 'ticket_reply'); }
        log(note ? 'ticket.note' : 'ticket.replied', { ticket: x.ref, workspace_id: x.workspace_id }); },
      async ticketStatus(id, st) { need('support.reply'); const x = tk(id); const was = x.status; x.status = st; x.updated_at = now(); log('ticket.status', { ticket: x.ref, workspace_id: x.workspace_id, was, now: st }); },
      async ticketPriority(id, p) { const x = tk(id); const was = x.priority; x.priority = p; log('ticket.priority', { ticket: x.ref, workspace_id: x.workspace_id, was, now: p }); },
      async ticketAssign(id, s) { const x = tk(id); if (!(permsOf(me()).includes('support.assign') || s === actor)) throw new Error('Your HQ role can\'t do that.');
        if (s && !permsOf(staff.find((y) => y.user_id === s)).includes(LEVEL_PERM[x.level])) throw new Error(`${nameOf(s)} can't work ${LEVELS[x.level]} tickets (level ${x.level}).`);
        x.assignee = s || null; log('ticket.assigned', { ticket: x.ref, workspace_id: x.workspace_id, to: nameOf(s) }); },
      async ticketEscalate(id, level, reason, assign) { need('support.escalate'); reasonOk(reason); const x = tk(id); const up = level > x.level;
        if (assign && !permsOf(staff.find((y) => y.user_id === assign)).includes(LEVEL_PERM[level])) throw new Error(`${nameOf(assign)} can't work ${LEVELS[level]} tickets.`);
        x.escalations.push({ from: x.level, to: level, by: me().display_name, reason, at: now() });
        x.messages.push(sm(me().display_name, `${up ? 'Escalated' : 'De-escalated'} to ${LEVELS[level]} by ${me().display_name}: ${reason}`, now(), true));
        if (up) x.messages.push(sm(null, 'We\'ve passed this to our senior team. They\'ll reply here.', now()));
        x.assignee = assign || (x.assignee && permsOf(staff.find((y) => y.user_id === x.assignee)).includes(LEVEL_PERM[level]) ? x.assignee : null);
        log(up ? 'ticket.escalated' : 'ticket.deescalated', { ticket: x.ref, workspace_id: x.workspace_id, from: x.level, to: level, reason }); x.level = level; x.updated_at = now(); },
      async savedReplies() { return saved.slice(); },
      async saveReply(id, title, body) { need('support.saved_replies'); if (id) Object.assign(saved.find((s) => s.id === id), { title, body }); else saved.push({ id: saved.length + 10, title, body }); log('saved_reply.saved', { title }); },
      async retireReply(id) { need('support.saved_replies'); saved.splice(saved.findIndex((s) => s.id === id), 1); log('saved_reply.retired', { id }); },
      // fix-up tools
      async editBusiness(ws, pr, reason, ticket) { need('customers.edit'); reasonOk(reason); const tr = ticketOk(ticket); Object.assign(cos.find((c) => c.id === ws), pr); log('business.edited', { workspace_id: ws, ticket: tr, reason, fields: Object.keys(pr) }); },
      async reset2fa(ws, person, how, reason, ticket) { need('people.reset_2fa'); reasonOk(reason); if (String(how || '').trim().length < 6) throw new Error('Say how you checked who they are (for example "called back on the number on file").');
        const tr = ticketOk(ticket); const p = cos.find((c) => c.id === ws).people_list.find((x) => x.user_id === person); p.two_step = false; queue(p.email, 'Your two-step sign-in was reset', 'mfa_reset');
        log('people.reset_2fa', { workspace_id: ws, ticket: tr, reason, identity_checked: how }); return 1; },
      async changeOwner(ws, person, reason, ticket) { need('people.change_owner'); reasonOk(reason); const tr = ticketOk(ticket); const c = cos.find((x) => x.id === ws);
        c.people_list.forEach((p) => { if (p.role === 'owner') { p.role = 'admin'; p.job_role = 'manager'; } if (p.user_id === person) { p.role = 'owner'; p.job_role = 'owner'; c.owner_name = p.name; c.owner_email = p.email; } });
        log('people.change_owner', { workspace_id: ws, ticket: tr, reason }); },
      async setBusinessStatus(ws, st, reason, ticket) { need('business.close'); reasonOk(reason); const tr = ticketOk(ticket); const c = cos.find((x) => x.id === ws); const was = c.status;
        Object.assign(c, { status: st, closed_at: st === 'active' ? null : now(), closed_reason: st === 'active' ? null : reason, duplicate_of: st === 'active' ? null : c.duplicate_of, last_active_at: st === 'active' ? now() : c.last_active_at });
        queue(c.owner_email, st === 'active' ? `${c.name} is open again on Riyeser` : `${c.name} has been ${st} on Riyeser`, st === 'active' ? 'business_reopened' : 'business_closed');
        log(st === 'active' ? 'business.reopened' : st === 'suspended' ? 'business.suspended' : 'business.closed', { workspace_id: ws, ticket: tr, reason, was }); },
      async closeDuplicate(ws, dup, reason, ticket) { await this.setBusinessStatus(ws, 'closed', reason, ticket); Object.assign(cos.find((x) => x.id === ws), { duplicate_of: dup, closed_reason: 'Duplicate: ' + reason }); log('business.duplicate', { workspace_id: ws, duplicate_of: dup }); },
      // inactive accounts
      async inactive() { const a = cos.filter((c) => c.status === 'active' && hours(c.last_active_at) / 24 > 365 - 60 && demoMonthly(c.id) === 0);
        return { approaching: a.map((c) => ({ ...c, closes_at: new Date(new Date(c.last_active_at).getTime() + 365 * 864e5).toISOString() })),
          closed: cos.filter((c) => c.status === 'closed' && c.closed_reason === 'inactive' && !c.removal_state && hours(c.closed_at) / 24 < 730).map((c) => ({ ...c, ready_at: new Date(new Date(c.closed_at).getTime() + 730 * 864e5).toISOString() })),
          ready: cos.filter((c) => c.removal_state === 'ready' || (c.status === 'closed' && !c.removal_state && hours(c.closed_at) / 24 >= 730)).map((c) => ({ ...c, removal_ready_at: c.closed_at })),
          removed: cos.filter((c) => c.removal_state === 'removed').length, can_remove: permsOf(me()).includes('accounts.inactive') }; },
      async removeAccounts(ids, reason) { need('accounts.inactive'); if (me().role !== 'owner') throw new Error('Only an HQ owner can approve removing accounts.'); reasonOk(reason);
        ids.forEach((id) => Object.assign(cos.find((c) => c.id === id), { name: 'Removed business', owner_name: 'Removed person', owner_email: '', removal_state: 'removed' })); log('accounts.removed', { count: ids.length, reason }); return ids.length; },
      // emails
      async emails() { const c = (s) => emails.filter((e) => e.status === s).length;
        return { counts: { queued: c('queued'), sent: c('sent'), failed: c('failed'), held: c('held'), sent_7d: c('sent') }, recent: emails.slice(0, 60), problems: emails.filter((e) => ['held', 'failed'].includes(e.status)) }; },
      async emailResend(id) { need('emails.manage'); const e = emails.find((x) => x.id === id); if (!e.to_address) throw new Error('That email has no address to send to.'); Object.assign(e, { status: 'queued', attempts: 0, last_error: null }); log('email.resend', { email_id: id }); },
      // refunds, free periods, approvals
      async refunds(box = 'open') { need('refunds.view'); const f = { new: (r) => r.status === 'submitted', reviewing: (r) => r.status === 'reviewing', second: (r) => r.waiting_second,
          to_pay: (r) => ['approved', 'partly_approved'].includes(r.status) && !r.waiting_second, paid: (r) => r.status === 'paid', declined: (r) => r.status === 'declined', all: () => true, open: (r) => !['paid', 'declined'].includes(r.status) };
        const rows = refunds.map(rowOf); const counts = {}; Object.keys(f).forEach((k) => { counts[k] = rows.filter(f[k]).length; });
        return { refunds: rows.filter(f[box] || f.open), counts, threshold: settings['refunds.two_person_threshold'] }; },
      async refundCreate(ticketId, r) { if (!['refunds.request', 'refunds.approve'].some((p) => permsOf(me()).includes(p))) throw new Error('Your HQ role can\'t do that.'); const x = tk(ticketId);
        if (!x.workspace_id) throw new Error('This ticket isn\'t linked to a business, so there\'s nothing to refund.');
        const f = { id: 'rf' + rn, ref: 'R-' + rn++, workspace_id: x.workspace_id, business: (cos.find((c) => c.id === x.workspace_id) || {}).name, requested_by_name: x.opened_by_name, on_behalf_by: me().display_name, ticket_id: x.id, ticket_ref: x.ref, ...r, status: 'submitted', created_at: now(), needs_second: false };
        refunds.unshift(f); log('refund.created', { workspace_id: x.workspace_id, ticket: x.ref, refund: f.ref }); return { ref: f.ref }; },
      async refundReview(id) { need('refunds.approve'); const f = refunds.find((x) => x.id === id); f.status = 'reviewing'; log('refund.reviewing', { workspace_id: f.workspace_id, refund: f.ref }); },
      async refundDecide(id, decision, amount, reason) { need('refunds.approve'); reasonOk(reason); const f = refunds.find((x) => x.id === id);
        if (!['submitted', 'reviewing'].includes(f.status)) throw new Error('That request has already been decided.');
        const amt = decision === 'decline' ? 0 : decision === 'approve' ? f.amount : Number(amount); if (decision === 'partly' && !(amt > 0 && amt < f.amount)) throw new Error(`For a part refund, enter an amount between 0 and ${f.amount}.`);
        Object.assign(f, { status: decision === 'decline' ? 'declined' : decision === 'approve' ? 'approved' : 'partly_approved', amount_approved: amt, decided_by: actor, decided_at: now(), decision_reason: reason, needs_second: decision !== 'decline' && amt > settings['refunds.two_person_threshold'] });
        if (!f.needs_second) queue(owner(f.workspace_id), `About your refund request (${f.ref})`, decision === 'decline' ? 'refund_declined' : 'refund_approved');
        log('refund.' + (decision === 'decline' ? 'declined' : decision === 'approve' ? 'approved' : 'partly_approved'), { workspace_id: f.workspace_id, refund: f.ref, amount: amt, needs_second: f.needs_second }); },
      async refundSecond(id, reason) { need('refunds.approve'); const f = refunds.find((x) => x.id === id); if (f.decided_by === actor) throw new Error('The same person can\'t give both approvals. Ask another staff member with refunds.approve.');
        Object.assign(f, { second_approver: actor, second_approved_at: now() }); queue(owner(f.workspace_id), `Your refund is approved (${f.ref})`, 'refund_approved'); log('refund.second_approved', { workspace_id: f.workspace_id, refund: f.ref, reason }); },
      async refundPaid(id, method, ref) { need('refunds.pay'); const f = refunds.find((x) => x.id === id); if (f.needs_second && !f.second_approver) throw new Error('This refund needs a second approval before it\'s paid.');
        if (method !== 'credit' && !String(ref || '').trim()) throw new Error('Add the payment reference.');
        Object.assign(f, { status: 'paid', paid_at: now(), paid_method: method, paid_reference: ref }); if (method === 'credit') { const c = credits[f.workspace_id] = credits[f.workspace_id] || {}; c[f.currency] = (c[f.currency] || 0) + f.amount_approved; }
        queue(owner(f.workspace_id), `Your refund has been paid (${f.ref})`, 'refund_paid'); log('refund.paid', { workspace_id: f.workspace_id, refund: f.ref, method }); },
      async grantOffer(ws, o) { need('offers.grant'); reasonOk(o.reason); const tr = ticketOk(o.ticket); const l = demoLicence(ws);
        const modsx = o.kind === 'account' ? Object.keys(l.modules).filter((m) => l.modules[m].status === 'active') : o.modules;
        if (!modsx.length) throw new Error(o.kind === 'account' ? 'This business has no paid programs. Extend a trial instead.' : 'Choose a program.');
        modsx.forEach((m) => { const st = l.modules[m].status; if (o.kind === 'trial' && !['trial', 'ended'].includes(st)) throw new Error(`${modName(m)} isn't on a free trial. Add free time to its paid period instead.`);
          if (o.kind !== 'trial' && st !== 'active') throw new Error(`${modName(m)} isn't paid right now, so there's no paid period to extend.`); });
        const days = o.unit === 'months' ? Math.round((new Date(addMonths(today(), o.amount)) - today()) / 864e5) : o.amount;
        const x = { id: 'of' + on, ref: 'O-' + on++, workspace_id: ws, business: (cos.find((c) => c.id === ws) || {}).name, modules: modsx, kind: o.kind, length_amount: o.amount, length_unit: o.unit, days, reason_category: o.why, reason: o.reason, ticket: tr,
          status: days <= settings['offers.self_limit_days'] ? 'applied' : 'waiting', requested_by: actor, requested_by_name: me().display_name, created_at: now() };
        offers.unshift(x); if (x.status === 'applied') applyOffer(x);
        log(x.status === 'applied' ? 'offer.applied' : 'offer.requested', { workspace_id: ws, offer: x.ref, ticket: tr, days, reason_category: o.why }); return { ref: x.ref, status: x.status, days, limit: settings['offers.self_limit_days'] }; },
      async decideOffer(id, approve, reason) { need('offers.approve'); const o = offers.find((x) => x.id === id); if (o.status !== 'waiting') throw new Error('That free period isn\'t waiting for approval.');
        if (o.requested_by === actor) throw new Error('The same person can\'t ask for and approve a free period. Ask another supervisor.'); if (!approve) reasonOk(reason);
        Object.assign(o, { status: approve ? 'approved' : 'declined', approved_by_name: me().display_name, decided_at: now(), decline_reason: approve ? null : reason }); if (approve) applyOffer(o);
        log(approve ? 'offer.approved' : 'offer.declined', { workspace_id: o.workspace_id, offer: o.ref, days: o.days }); },
      async approvals() { if (!['refunds.approve', 'offers.approve', 'refunds.view'].some((p) => permsOf(me()).includes(p))) throw new Error('Your HQ role can\'t do that.');
        const month = offers.filter((o) => ['applied', 'approved'].includes(o.status) && (o.applied_at || o.created_at).slice(0, 7) === now().slice(0, 7)); const by = {};
        month.forEach((o) => { by[o.reason_category] = (by[o.reason_category] || 0) + o.days; });
        return { refunds: refunds.map(rowOf).filter((r) => r.waiting_second), offers: offers.filter((o) => o.status === 'waiting'), month: { count: month.length, days: month.reduce((a, o) => a + o.days, 0), by_reason: by },
          limit_days: settings['offers.self_limit_days'], threshold: settings['refunds.two_person_threshold'], me: actor }; },
    };
  }
  const api = DEMO ? demo() : online();
  const S = { me: null, tab: 'overview', companies: [], perms: [] };
  // can('a.b', 'c.d'): has at least one of these permissions. Older databases (no permissions yet): from the role.
  const can = (...perms) => !!S.me && perms.some((p) => S.perms.includes(p));

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

  async function loadMe() {
    S.me = await api.me();
    S.perms = S.me && S.me.active ? (S.me.perms || permsOf({ role: S.me.role })) : [];
  }
  async function start() {
    try {
      const s = await api.session(); if (!s) return gate();
      const lv = await api.aal();
      if (lv.currentLevel !== 'aal2') {
        if (lv.nextLevel === 'aal2') return gate('', 'code');
        return blocked('<h1>Turn on two-step sign-in first</h1><p>Riyeser HQ needs two-step sign-in. Open <a href="/team/">Riyeser Team</a>, click <b>🔐 Security</b> and turn it on, then come back and sign in again.</p>');
      }
      await loadMe();
      if (!S.me || !S.me.active) return blocked('<h1>Not Riyeser HQ staff</h1><p>This account isn\'t on the Riyeser HQ team. Ask a Riyeser HQ owner to add you.</p>');
      shell();
    } catch (err) { blocked(`<div class="err">${esc(plain(err))}</div>`); }
  }

  // ------------------------------------------------------------------ the shell
  const TABS = () => [['overview', 'Overview', can('overview.view')], ['companies', 'Companies', can('customers.view')], ['support', 'Support', can('support.view')],
    ['refunds', 'Refunds', can('refunds.view')], ['approvals', 'Approvals', can('refunds.approve', 'offers.approve')], ['licences', 'Licences', can('licences.view')],
    ['inactive', 'Inactive accounts', can('customers.view', 'accounts.inactive')], ['emails', 'Emails', can('emails.view')], ['downloads', 'Downloads', can('downloads.view')],
    ['team', 'HQ team', true], ['history', 'History', can('audit.view')]].filter((x) => x[2]);
  const VIEWS = () => ({ overview, companies, support, refunds, approvals, licences, inactive, emails, downloads, team, history });
  function shell() {
    if (!TABS().some((x) => x[0] === S.tab)) S.tab = TABS()[0][0];
    $app.innerHTML = `${DEMO ? `<div class="demo">Demo with sample data. Nothing here is real. <label>Acting as <select id="demoAs" aria-label="Demo staff member">${api.staffList().map((s) => `<option value="${s.user_id}"${s.display_name === S.me.name ? ' selected' : ''}>${esc(s.display_name)} (${esc(roleName(s.role))})</option>`).join('')}</select></label></div>` : ''}
      <header class="top"><div class="brand"><img src="../assets/logo-r.png" alt="">Riyeser HQ <small>staff only</small></div>
      <nav class="tabs">${TABS().map(([k, l]) => `<button data-tab="${k}"${S.tab === k ? ' class="on"' : ''}>${l}<span class="tb" data-badge="${k}"></span></button>`).join('')}</nav>
      <div class="me">${esc(S.me.name)} <small>${esc(roleName(S.me.role))}</small><button id="so">Sign out</button></div></header><main id="main"></main>`;
    $app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; S.ticket = null; shell(); });
    $app.querySelector('#so').onclick = async () => { await api.signOut(); gate(); };
    const das = $app.querySelector('#demoAs'); if (das) das.onchange = async () => { api.asStaff(das.value); await loadMe(); closePanel(); shell(); };
    VIEWS()[S.tab]().catch((err) => { document.getElementById('main').innerHTML = missing(err) ? SWITCH_ON : `<div class="err">${esc(plain(err))}</div>`; });
    badges();
  }
  // Counts on the tabs: new support tickets and things waiting for a second approval.
  async function badges() {
    const set = (k, n) => { const el = $app.querySelector(`[data-badge="${k}"]`); if (el) el.textContent = n ? String(n) : ''; };
    if (can('support.view')) api.tickets('open', '').then((r) => set('support', (r.counts || {}).new + (r.counts || {}).waiting_us || 0)).catch(() => {});
    if (can('refunds.approve', 'offers.approve')) api.approvals().then((r) => set('approvals', (r.refunds || []).length + (r.offers || []).length)).catch(() => {});
  }
  const main = (html) => { document.getElementById('main').innerHTML = html; return document.getElementById('main'); };

  // A small dialog. wire(d, close) sets up its buttons.
  function dlg(html, wire) {
    const d = document.createElement('div'); d.className = 'modal'; d.innerHTML = `<div class="mcard" role="dialog" aria-modal="true">${html}</div>`;
    d.onclick = (e) => { if (e.target === d) d.remove(); }; document.body.appendChild(d);
    const close = () => d.remove(); const cl = d.querySelector('[data-close]'); if (cl) cl.onclick = close; wire(d, close);
    const first = d.querySelector('input:not([type=hidden]),select,textarea'); if (first) first.focus();
  }
  // Every fix-up tool asks for a reason, and optionally the ticket it's for. run(form) does the work.
  function fixForm(title, intro, fields, run, button = 'Save') {
    dlg(`<h3>${title}</h3>${intro ? `<p class="muted small">${intro}</p>` : ''}<form id="fx">${fields}
      <label class="f"><span>Reason <small class="muted">(required: it goes in the HQ history for good, so no personal details)</small></span><input name="reason" required minlength="4" maxlength="300"></label>
      <label class="f"><span>Ticket number <small class="muted">(optional)</small></span><input name="ticket" placeholder="T-10234" maxlength="20"></label>
      <div id="fxerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">${button}</button></div></form>`, (d, close) => {
      d.querySelector('#fx').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        try { await run(f, String(f.get('reason')).trim(), String(f.get('ticket') || '').trim()); close(); }
        catch (err) { d.querySelector('#fxerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
    });
  }
  const askReason = (title, intro, run, button = 'Save', extra = '') => dlg(`<h3>${title}</h3>${intro ? `<p class="muted small">${intro}</p>` : ''}<form id="ar">${extra}
      <label class="f"><span>Reason</span><input name="reason" required minlength="4" maxlength="500"></label>
      <div id="arerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">${button}</button></div></form>`, (d, close) => {
    d.querySelector('#ar').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
      try { await run(String(f.get('reason')).trim(), f); close(); } catch (err) { d.querySelector('#arerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });

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
  const chips = (list, on, counts = {}) => `<div class="chips">${list.map(([k, l]) => `<button class="chip${on === k ? ' on' : ''}" data-box="${k}">${l}${counts[k] != null ? ` <b>${num(counts[k])}</b>` : ''}</button>`).join('')}</div>`;

  // ------------------------------------------------------------------ overview
  async function overview() {
    main('<p class="muted">Loading…</p>');
    const o = await api.overview();
    const wk = (o.signups_by_week || []).map((w) => ({ ...w, label: new Date(w.week).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }));
    main(`<h2>Overview</h2><p class="sub">How Riyeser is doing. Account information only: HQ never sees customers' messages or books.</p>
      <div class="tiles">${tile('Companies', num(o.companies), `+${num(o.companies_7d)} this week · +${num(o.companies_30d)} in 30 days`)}
        ${tile('People', num(o.people), 'in all companies')}${tile('Linked PCs', num(o.pcs), `${num(o.pcs_active_7d)} active this week`)}
        ${tile('Team Chat Plus', num(o.calls_paid) + ' paid', `${num(o.calls_trial)} on the free trial`)}</div>
      <div class="grid g2"><div class="card"><h3>New companies per week</h3>${columnChart(wk, (r) => r.label, (r) => Number(r.companies), 'companies')}</div>
        <div class="card"><h3>Riyeser Central versions in use <small>· PCs seen in 30 days</small></h3>${barList(o.versions || [], (r) => r.version, (r) => Number(r.pcs))}</div>
        <div class="card"><h3>Team Chat Plus trials ending soon <small>· 14 days or less, not paid</small></h3>
          ${(o.trials_ending || []).length ? `<table class="tbl"><tr><th>Company</th><th class="n">Days left</th></tr>${o.trials_ending.map((t) => `<tr class="click" data-co="${t.id}"><td><b>${esc(t.name)}</b><small>${esc(t.company_code)}</small></td><td class="n"><span class="pill warn">${t.days_left}</span></td></tr>`).join('')}</table>` : '<p class="muted small">None right now.</p>'}</div>
        <div class="card"><h3>Companies by country</h3>${barList(o.countries || [], (r) => r.country, (r) => Number(r.companies))}
          <p class="muted small" style="margin-top:12px">${num(o.requests_waiting)} join request${o.requests_waiting === 1 ? '' : 's'} waiting for a company admin · ${num(o.pcs_active_30d)} PCs active in 30 days</p></div></div>`)
      .querySelectorAll('[data-co]').forEach((r) => r.onclick = () => openCompany(r.dataset.co));
  }

  // ------------------------------------------------------------------ companies
  async function companies(q = S.coQ || '', st = S.coSt || 'all') {
    S.coQ = q; S.coSt = st;
    const m = main(`<h2>Companies</h2><p class="sub">Every company using Riyeser online. Search by name, Company ID, ABN/TIN or an owner's email.</p>
      <form class="search" id="sf"><input name="q" value="${esc(q)}" placeholder="Search…" aria-label="Search companies">
        <select name="st" aria-label="Status">${[['all', 'All'], ['active', 'Open'], ['suspended', 'Suspended'], ['closed', 'Closed']].map(([k, l]) => `<option value="${k}"${k === st ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn">Search</button></form><div id="cl" class="card scroll"><p class="muted">Loading…</p></div>`);
    m.querySelector('#sf').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); companies(String(f.get('q')), String(f.get('st'))); };
    m.querySelector('#sf select').onchange = () => m.querySelector('#sf').requestSubmit();
    S.companies = await api.companies(q, st);
    const callsPill = (c) => (c.calls_paid_until && new Date(c.calls_paid_until) > new Date() ? `<span class="pill ok">Paid to ${day(c.calls_paid_until)}</span>`
      : c.trial_days_left > 0 ? `<span class="pill${c.trial_days_left <= 14 ? ' warn' : ''}">Trial · ${c.trial_days_left} days</span>` : '<span class="pill bad">Trial ended</span>');
    m.querySelector('#cl').innerHTML = S.companies.length ? `<table class="tbl"><tr><th>Company</th><th>Owner</th><th>Country</th><th class="n">People</th><th class="n">PCs</th><th>Last active</th><th>Team Chat Plus</th><th>Joined</th></tr>
      ${S.companies.map((c) => `<tr class="click" data-co="${c.id}"><td><b>${esc(c.name)}</b>${c.status && c.status !== 'active' ? ' ' + pill(BSTAT, c.status) : ''}<small class="code">${esc(c.company_code || '')}</small></td><td>${esc(c.owner_name || '')}<small>${esc(c.owner_email || '')}</small></td>
        <td>${esc(c.country || '')}</td><td class="n">${num(c.people)}</td><td class="n">${num(c.pcs)}</td><td>${ago(c.last_active_at || c.last_seen)}</td><td>${callsPill(c)}</td><td>${day(c.created_at)}</td></tr>`).join('')}</table>`
      : '<p class="muted">No companies match.</p>';
    m.querySelectorAll('[data-co]').forEach((r) => r.onclick = () => openCompany(r.dataset.co));
  }

  function closePanel() { document.querySelectorAll('.panel,.scrim').forEach((x) => x.remove()); }
  const HIST_ACTS = { 'customer.viewed': 'opened the company', 'company.viewed': 'opened the company', 'note.added': 'added a note', 'calls.paid_until': 'changed Team Chat Plus paid-until',
    'licence.module': 'changed a licence', 'licence.plan': 'changed a plan', 'staff.added': 'added HQ staff', 'staff.changed': 'changed HQ staff', 'staff.permissions': 'changed HQ permissions',
    'staff.owner_made': 'made an HQ owner (SQL Editor)', 'ticket.viewed': 'opened a ticket', 'ticket.replied': 'replied to a ticket', 'ticket.note': 'added an internal note',
    'ticket.status': 'changed a ticket\'s status', 'ticket.priority': 'changed a ticket\'s priority', 'ticket.assigned': 'assigned a ticket', 'ticket.escalated': 'escalated a ticket',
    'ticket.deescalated': 'de-escalated a ticket', 'saved_reply.saved': 'saved a reply', 'saved_reply.retired': 'removed a saved reply', 'business.edited': 'edited business details',
    'people.reset_2fa': 'reset two-step sign-in', 'people.change_owner': 'changed the owner', 'business.closed': 'closed a business', 'business.suspended': 'suspended a business',
    'business.reopened': 'reopened a business', 'business.duplicate': 'closed as a duplicate', 'business.closed_inactive': 'closed (inactive 12 months)', 'accounts.removed': 'removed personal details of closed accounts',
    'refund.created': 'entered a refund request', 'refund.reviewing': 'started reviewing a refund', 'refund.approved': 'approved a refund', 'refund.partly_approved': 'partly approved a refund',
    'refund.declined': 'declined a refund', 'refund.second_approved': 'gave the second approval', 'refund.paid': 'marked a refund paid', 'offer.applied': 'gave a free period',
    'offer.requested': 'asked to give a free period', 'offer.approved': 'approved a free period', 'offer.declined': 'declined a free period', 'email.resend': 'sent an email again',
    'settings.changed': 'changed an HQ setting', 'audit.exported': 'downloaded the HQ history', 'sweep.support': 'support sweep (automatic)', 'sweep.inactivity': 'inactivity sweep (automatic)' };
  const histExtra = (h) => { const d = h.details || {}; return [h.ticket || d.ticket, d.refund, d.offer, d.module ? modName(d.module) : null, d.status, d.reason, d.email, d.until, d.role, d.to ? 'to ' + (LEVELS[d.to] || d.to) : null].filter(Boolean).join(' · '); };

  async function openCompany(id) {
    const [c, lic] = await Promise.all([api.company(id), api.companyLicence(id).catch(() => null)]); const p = c.profile; const L = lic && lic.licence; const X = c.extra || null;
    closePanel();
    const scrim = document.createElement('div'); scrim.className = 'scrim'; const panel = document.createElement('aside'); panel.className = 'panel';
    const close = () => { panel.remove(); scrim.remove(); }; scrim.onclick = close;
    const reopen = () => openCompany(id);
    const closedNote = p.status && p.status !== 'active' ? `<div class="banner bad">${p.status === 'closed' ? 'Closed' : 'Suspended'} ${day(p.closed_at)}${p.closed_reason ? ` · ${esc(p.closed_reason)}` : ''}
      ${p.duplicate_of ? ` · duplicate of <a href="#" data-goco="${esc(p.duplicate_of)}">${esc(p.duplicate_of_name || 'the other business')}</a>` : ''}${p.removal_state === 'removed' ? ' · personal details removed' : ''}</div>` : '';
    const credit = X ? creditText(X.credit) : '';
    const tools = [can('customers.edit') && '<button class="btn sm" data-fix="edit">✏️ Edit details</button>',
      can('people.change_owner') && '<button class="btn sm" data-fix="owner">👑 Change owner</button>',
      can('business.close') && (p.status === 'active' || !p.status ? '<button class="btn sm" data-fix="close">⛔ Close or suspend</button><button class="btn sm" data-fix="dup">🔁 Close as duplicate</button>' : '<button class="btn sm" data-fix="reopen">✅ Reopen</button>'),
      can('offers.grant') && L && (p.status === 'active' || !p.status) && '<button class="btn sm" data-fix="offer">🎁 Give a free period</button>'].filter(Boolean).join('');
    panel.innerHTML = `<div class="phead"><div style="flex:1;min-width:0"><h2>${esc(p.name)} ${p.status ? pill(BSTAT, p.status) : ''}</h2><span class="code">${esc(p.company_code || '')}</span>
      ${p.last_active_at ? ` <span class="muted small">· last active ${ago(p.last_active_at)}</span>` : ''}</div><button class="btn sm" id="x">Close</button></div>
      ${closedNote}
      ${tools && X ? `<div class="card"><h3>Fix-up tools <small>· each needs a reason and is written to the HQ history</small></h3><div class="row">${tools}</div></div>` : ''}
      <div class="card"><h3>Details</h3><dl class="kv"><dt>Legal name</dt><dd>${esc(p.legal_name || '—')}</dd><dt>ABN / TIN</dt><dd>${esc(p.tax_number || '—')}</dd>
        <dt>Country</dt><dd>${esc(p.country || '—')}</dd><dt>Address</dt><dd>${esc(p.address || '—')}</dd><dt>Phone</dt><dd>${esc(p.phone || '—')}</dd><dt>Email</dt><dd>${esc(p.email || '—')}</dd>
        <dt>Joined Riyeser</dt><dd>${day(p.created_at)}</dd><dt>New people need</dt><dd>${p.require_approval ? 'Approval (recommended)' : 'No approval'}</dd>
        <dt>Waiting to join</dt><dd>${num(c.requests_waiting)}</dd>${credit ? `<dt>Credit</dt><dd id="credit"><b>Credit: ${credit}</b></dd>` : ''}</dl></div>
      ${L ? `<div class="card" id="licCard"><h3>Licence <small>· ${money(lic.monthly)} a month (list price estimate)</small></h3>
        <div class="scroll"><table class="tbl lic"><tr><th>Program</th><th>Now</th>${can('licences.manage') ? '<th>Change to</th><th></th>' : ''}</tr>
        ${MODULES.map(([m, name]) => { const v = L.modules[m]; return `<tr data-mod="${m}"><td><b>${name}</b></td><td>${statusPill(v)}</td>${can('licences.manage') ? `<td><div class="row">
          <select name="st" aria-label="${name} status"><option value="trial"${v.status === 'trial' ? ' selected' : ''}>Free trial until</option><option value="active"${v.status === 'active' || v.status === 'ended' ? ' selected' : ''}>Paid until</option><option value="cancelled"${v.status === 'cancelled' ? ' selected' : ''}>Cancelled (works until)</option></select>
          <input type="date" name="dt" value="${(v.status === 'trial' ? v.trial_ends : v.paid_until) || ''}" aria-label="${name} date"></div></td><td><button class="btn sm" data-save="${m}">Save</button></td>` : ''}</tr>`; }).join('')}</table></div>
        <form id="plan" class="grid g3" style="margin-top:12px"><label class="f"><span>Extra users <small class="muted">(${L.seats.used} people, ${L.seats.included} included)</small></span><input type="number" min="0" name="users" value="${L.seats.extra}"${can('licences.manage') ? '' : ' disabled'}></label>
          <label class="f"><span>Extra companies</span><input type="number" min="0" name="cos" value="${L.extra_companies}"${can('licences.manage') ? '' : ' disabled'}></label>
          <label class="f"><span>Billing</span><select name="billing"${can('licences.manage') ? '' : ' disabled'}><option value="monthly"${L.billing === 'monthly' ? ' selected' : ''}>Monthly</option><option value="yearly"${L.billing === 'yearly' ? ' selected' : ''}>Yearly (2 months free)</option></select></label>
          <label class="opt"><input type="checkbox" name="eb"${L.early_bird ? ' checked' : ''}${can('licences.manage') ? '' : ' disabled'}> Early bird: half price for the first 12 months</label>
          ${can('licences.manage') ? '<div><button class="btn p sm">Save plan</button></div>' : '<p class="muted small">Owners and Finance can change licences.</p>'}</form>
        <p class="muted small">Changes reach the company's PCs the next time Riyeser Central checks in (at start-up and daily).</p></div>` : ''}
      ${X && X.offers && X.offers.length ? `<div class="card scroll" id="offCard"><h3>Free periods <small>· ${X.offers.length}</small></h3><table class="tbl"><tr><th>Offer</th><th>What</th><th>Status</th><th>By</th></tr>
        ${X.offers.map((o) => `<tr><td class="code">${esc(o.ref)}<small>${day(o.created_at)}</small></td><td>${o.days} days · ${esc(o.kind === 'account' ? 'all paid programs' : o.modules.map(modName).join(', '))}<small>${esc(OFFER_KIND[o.kind] || o.kind)} · ${esc((OFFER_WHY.find((w) => w[0] === o.reason_category) || [0, o.reason_category])[1])}: ${esc(o.reason)}</small></td>
          <td>${offerPill(o)}${o.ends_at ? `<small>to ${day(o.ends_at)}</small>` : ''}</td><td>${esc(o.requested_by_name || '')}${o.approved_by_name ? `<small>${o.status === 'declined' ? 'declined' : 'approved'} by ${esc(o.approved_by_name)}</small>` : ''}</td></tr>`).join('')}</table></div>` : ''}
      <div class="card scroll"><h3>People <small>· ${c.people.length}</small></h3><table class="tbl" id="ppl"><tr><th>Name</th><th>Role</th><th class="n">Ext</th><th>Joined</th>${can('people.reset_2fa') && X ? '<th></th>' : ''}</tr>
        ${c.people.map((x) => `<tr><td>${esc(x.name)}<small>${esc(x.email || '')}</small></td><td>${esc(x.role === 'owner' ? 'Owner' : x.job_role)}${x.role === 'admin' ? ' · admin' : ''}${x.two_step ? '<small>🔐 two-step on</small>' : ''}</td><td class="n">${x.extension || ''}</td><td>${day(x.joined)}</td>
          ${can('people.reset_2fa') && X ? `<td>${x.user_id && x.two_step !== false ? `<button class="btn sm" data-r2fa="${esc(x.user_id)}">Reset two-step</button>` : ''}</td>` : ''}</tr>`).join('')}</table></div>
      <div class="grid g2"><div class="card"><h3>Branches</h3>${c.branches.map((b) => `<div class="small">${esc(b.name)} <span class="muted">· ${b.extension || ''} · ${b.people} people</span></div>`).join('') || '<p class="muted small">None.</p>'}</div>
        <div class="card"><h3>Linked PCs</h3>${c.pcs.map((d) => `<div class="small"><b>${esc(d.name || 'A PC')}</b> <span class="muted">· ${esc(d.person || '')} · Central ${esc(d.version || '?')} · ${ago(d.last_seen)}</span></div>`).join('') || '<p class="muted small">None linked.</p>'}</div></div>
      ${X && X.tickets ? `<div class="card scroll"><h3>Support tickets <small>· ${X.tickets.length}</small></h3>${X.tickets.length ? `<table class="tbl">${X.tickets.map((t) => `<tr class="click" data-tk="${esc(t.id)}"><td class="code">${esc(t.ref)}</td><td>${esc(t.subject)}</td><td>${pill(TSTAT, t.status)}${t.level > 1 ? ` <span class="pill">L${t.level}</span>` : ''}</td><td>${ago(t.updated_at)}</td></tr>`).join('')}</table>` : '<p class="muted small">None.</p>'}</div>` : ''}
      ${X && X.refunds ? `<div class="card scroll" id="coRefunds"><h3>Refunds <small>· ${X.refunds.length}</small></h3>${X.refunds.length ? `<table class="tbl">${X.refunds.map((f) => `<tr><td class="code">${esc(f.ref)}<small>${day(f.created_at)}</small></td><td>${cur(f.amount, f.currency)}<small>${esc(f.for_what)}</small></td><td>${refundPill(f)}</td><td>${f.amount_approved != null ? cur(f.amount_approved, f.currency) : ''}<small>${esc(f.paid_method ? (PAID_HOW.find((x) => x[0] === f.paid_method) || [0, f.paid_method])[1] : '')}</small></td></tr>`).join('')}</table>` : '<p class="muted small">None.</p>'}</div>` : ''}
      <div class="card notes"><h3>HQ notes <small>· only Riyeser staff see these</small></h3>
        ${can('customers.notes') ? '<form id="nf" class="row" style="margin-bottom:8px"><input name="body" required maxlength="2000" placeholder="e.g. Called the owner about POS" style="flex:1;min-width:0;padding:8px 10px;border:1px solid #cfd6e4;border-radius:9px"><button class="btn sm">Add note</button></form>' : ''}
        ${c.notes.map((n) => `<div class="nt">${esc(n.body)}<small>${esc(n.by || 'Riyeser')} · ${ago(n.at)}</small></div>`).join('')}</div>
      ${X && X.history ? `<div class="card scroll"><h3>HQ history for this business <small>· who looked and what was done</small></h3>${X.history.length ? `<table class="tbl" id="coHist">${X.history.slice(0, 50).map((h) => `<tr><td>${ago(h.at)}<small>${day(h.at)}</small></td><td>${esc(h.who)}</td><td>${esc(HIST_ACTS[h.action] || h.action)}${histExtra(h) ? `<small>${esc(histExtra(h))}</small>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted small">Nothing yet.</p>'}</div>` : ''}
      <p class="privacy">🔒 HQ shows account information only. Customers' messages, calls and books are never shown here.</p>`;
    document.body.append(scrim, panel);
    panel.querySelector('#x').onclick = close;
    panel.querySelectorAll('[data-goco]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openCompany(a.dataset.goco); });
    panel.querySelectorAll('[data-tk]').forEach((r) => r.onclick = () => { close(); S.tab = 'support'; S.ticket = r.dataset.tk; shell(); });
    panel.querySelectorAll('[data-save]').forEach((btn) => btn.onclick = async () => {
      const row = btn.closest('tr'); const st = row.querySelector('[name=st]').value; const dt = row.querySelector('[name=dt]').value;
      if (!dt) { alert('Choose a date.'); return; }
      try { await api.setModule(id, btn.dataset.save, st, st === 'trial' ? dt : null, st === 'trial' ? null : dt); reopen(); } catch (err) { alert(plain(err)); } });
    const pf = panel.querySelector('#plan'); if (pf && can('licences.manage')) pf.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
      try { await api.setPlan(id, Number(f.get('users') || 0), Number(f.get('cos') || 0), String(f.get('billing')), !!f.get('eb')); reopen(); } catch (err) { alert(plain(err)); } };
    const nf = panel.querySelector('#nf'); if (nf) nf.onsubmit = async (e) => { e.preventDefault();
      try { await api.addNote(id, String(new FormData(e.target).get('body'))); reopen(); } catch (err) { alert(plain(err)); } };
    // fix-up tools
    const inp = (name, label, val = '', extra = '') => `<label class="f"><span>${label}</span><input name="${name}" value="${esc(val || '')}" ${extra}></label>`;
    const fixes = {
      edit: () => fixForm('✏️ Edit business details', 'Only change what the customer asked for. The customer\'s own change history will show "Riyeser".',
        `<div class="grid g2">${inp('name', 'Name', p.name, 'required maxlength="80"')}${inp('tax_number', 'ABN / TIN / Tax ID', p.tax_number, 'maxlength="40"')}${inp('phone', 'Phone', p.phone, 'maxlength="40"')}
          ${inp('email', 'Email', p.email, 'maxlength="120"')}${inp('country', 'Country', p.country, 'maxlength="60"')}${inp('address', 'Address', p.address, 'maxlength="300"')}</div>`,
        async (f, reason, ticket) => { const pr = {}; ['name', 'tax_number', 'address', 'phone', 'email', 'country'].forEach((k) => { const v = String(f.get(k) || '').trim(); if (v !== String(p[k] || '')) pr[k] = v; });
          if (!Object.keys(pr).length) throw new Error('Nothing has changed.'); await api.editBusiness(id, pr, reason, ticket); reopen(); }),
      owner: () => fixForm('👑 Change owner', 'The new owner gets every admin power. The old owner becomes an admin.',
        `<label class="f"><span>New owner</span><select name="person">${c.people.filter((x) => x.role !== 'owner').map((x) => `<option value="${esc(x.user_id)}">${esc(x.name)} (${esc(x.email || '')})</option>`).join('')}</select></label>`,
        async (f, reason, ticket) => { await api.changeOwner(id, String(f.get('person')), reason, ticket); reopen(); }, 'Make them the owner'),
      close: () => fixForm('⛔ Close or suspend', 'Nothing is deleted. Its people can\'t open it, and its programs\' online licence reads as not active. The books on their PCs are never touched. The owner is emailed.',
        '<label class="f"><span>Make it</span><select name="st"><option value="closed">Closed</option><option value="suspended">Suspended (for now)</option></select></label>',
        async (f, reason, ticket) => { await api.setBusinessStatus(id, String(f.get('st')), reason, ticket); reopen(); }, 'Close it'),
      reopen: () => fixForm('✅ Reopen', 'Its people can use it again straight away. The owner is emailed.', '',
        async (f, reason, ticket) => { await api.setBusinessStatus(id, 'active', reason, ticket); reopen(); }, 'Reopen'),
      dup: async () => { const all = (await api.companies('', 'active')).filter((x) => x.id !== id);
        fixForm('🔁 Close as duplicate', 'For a business that was signed up twice. It\'s closed (never deleted) and links to the one to keep.',
          `<label class="f"><span>It duplicates</span><select name="dup">${all.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.company_code || '')}</option>`).join('')}</select></label>`,
          async (f, reason, ticket) => { await api.closeDuplicate(id, String(f.get('dup')), reason, ticket); reopen(); }, 'Close as duplicate'); },
      offer: async () => { const set = await api.settings().catch(() => ({})); const lim = set['offers.self_limit_days'] || 31;
        dlg(`<h3>🎁 Give a free period</h3><p class="muted small">Up to <b>${lim} days</b> applies straight away. Longer waits for a supervisor (someone else with offers.approve). The customer is emailed when it applies; they never see the reason.</p>
          <form id="of"><label class="f"><span>What</span><select name="kind">${Object.entries(OFFER_KIND).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
          <div class="pick" id="ofmods">${MODULES.map(([m, n]) => `<label class="opt"><input type="checkbox" name="m" value="${m}"> ${n} <small class="muted">${L ? esc(L.modules[m].status) : ''}</small></label>`).join('')}</div>
          <div class="grid g2"><label class="f"><span>How long</span><input type="number" name="amount" min="1" max="1000" value="14" required></label>
          <label class="f"><span>&nbsp;</span><select name="unit"><option value="days">days</option><option value="months">months</option></select></label></div>
          <label class="f"><span>Reason</span><select name="why">${OFFER_WHY.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
          <label class="f"><span>Reason note <small class="muted">(staff only)</small></span><input name="reason" required minlength="4" maxlength="500"></label>
          <label class="f"><span>Ticket number <small class="muted">(optional)</small></span><input name="ticket" placeholder="T-10234" maxlength="20"></label>
          <div id="oferr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Give it</button></div></form>`, (d, closeD) => {
          const kind = d.querySelector('[name=kind]'); const sync = () => { d.querySelector('#ofmods').hidden = kind.value === 'account'; }; kind.onchange = sync; sync();
          d.querySelector('#of').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
            try { const r = await api.grantOffer(id, { kind: String(f.get('kind')), modules: f.getAll('m').map(String), amount: Number(f.get('amount')), unit: String(f.get('unit')),
                why: String(f.get('why')), reason: String(f.get('reason')).trim(), ticket: String(f.get('ticket') || '').trim() });
              closeD(); await reopen(); flash(r.status === 'applied' ? `${r.ref}: ${r.days} free days applied.` : `${r.ref}: ${r.days} days is over the ${r.limit}-day limit, so it's waiting for a supervisor in Approvals.`);
            } catch (err) { d.querySelector('#oferr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; }); },
    };
    panel.querySelectorAll('[data-fix]').forEach((b) => b.onclick = () => fixes[b.dataset.fix]());
    panel.querySelectorAll('[data-r2fa]').forEach((b) => b.onclick = () => { const x = c.people.find((y) => y.user_id === b.dataset.r2fa);
      fixForm(`🔐 Reset two-step sign-in for ${esc(x.name)}`, '<b>Check who they are first.</b> Never reset it just because someone asks by email or chat: call them back on the phone number already on file, or check another way you trust.',
        '<label class="f"><span>How did you check who they are?</span><input name="how" required minlength="6" maxlength="200" placeholder="e.g. called back on the number on file"></label>',
        async (f, reason, ticket) => { await api.reset2fa(id, x.user_id, String(f.get('how')).trim(), reason, ticket); reopen(); flash(`Two-step sign-in reset for ${x.name}. They've been emailed.`); }, 'Reset it'); });
  }
  function flash(msg) { document.querySelectorAll('.flash').forEach((x) => x.remove()); const el = document.createElement('div'); el.className = 'flash'; el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 4500); }
  const offerPill = (o) => (o.status === 'applied' ? '<span class="pill ok">Applied</span>' : o.status === 'approved' ? '<span class="pill ok">Approved + applied</span>'
    : o.status === 'waiting' ? '<span class="pill warn">Waiting for approval</span>' : '<span class="pill bad">Declined</span>');
  const refundPill = (f) => (f.waiting_second ? '<span class="pill warn">Waiting for second approval</span>' : pill(RSTAT, f.status));

  // ------------------------------------------------------------------ support
  const BOXES = [['new', 'New'], ['waiting_us', 'Waiting on us'], ['waiting_customer', 'Waiting on customer'], ['done', 'Done'], ['mine', 'Mine'], ['unassigned', 'Unassigned'],
    ['overdue', 'Overdue'], ['escalated', 'Escalated'], ['level2', 'Level 2'], ['level3', 'Level 3'], ['all', 'All']];
  const timer = (t, od) => { if (t.first_reply_at) return `<span class="tmr">First reply in ${dur(hours(t.created_at, t.first_reply_at))}</span>`;
    if (t.status === 'done') return '';
    const hh = hours(t.created_at); return `<span class="tmr${hh > od ? ' late' : ''}">No reply yet · ${dur(hh)}</span>`; };
  async function support() {
    S.box = S.box || 'open'; S.tq = S.tq || '';
    const m = main(`<h2>Support</h2><p class="sub">Help requests from customers. Replies are emailed to them and show on their Riyeser home page. Internal notes are never shown to customers.</p>
      <div class="sup"><div class="sup-list"><form class="search" id="tsf"><input name="q" value="${esc(S.tq)}" placeholder="Search tickets, businesses, emails, text…" aria-label="Search tickets"><button class="btn">Search</button></form>
      <div id="boxes"></div><div id="tl" class="card tlist"><p class="muted">Loading…</p></div></div><div class="sup-view" id="tv"></div></div>`);
    m.querySelector('#tsf').onsubmit = (e) => { e.preventDefault(); S.tq = String(new FormData(e.target).get('q')); loadInbox(); };
    await loadInbox();
    if (S.ticket) await openTicket(S.ticket); else m.querySelector('#tv').innerHTML = '<div class="card"><p class="muted">Choose a ticket.</p></div>';
  }
  async function loadInbox() {
    const r = await api.tickets(S.box, S.tq); const od = Number(r.overdue_hours || 24);
    const bx = document.getElementById('boxes'); if (!bx) return;
    bx.innerHTML = chips(BOXES, S.box, r.counts || {});
    bx.querySelectorAll('[data-box]').forEach((b) => b.onclick = () => { S.box = S.box === b.dataset.box ? 'open' : b.dataset.box; loadInbox(); });
    const tl = document.getElementById('tl');
    tl.innerHTML = (r.tickets || []).length ? r.tickets.map((t) => `<button class="tk${S.ticket === t.id ? ' on' : ''}" data-t="${esc(t.id)}">
        <span class="tk1"><span class="code">${esc(t.ref)}</span> ${pill(TSTAT, t.status)}${t.level > 1 ? ` <span class="pill">L${t.level} ${LEVELS[t.level]}</span>` : ''}${['high', 'urgent'].includes(t.priority) ? ` <span class="pill bad">${esc(t.priority)}</span>` : ''}${t.overdue ? ' <span class="pill bad">Overdue</span>' : ''}</span>
        <b>${esc(t.subject)}</b><small>${esc(t.business || t.opened_by_email || 'No business')} · ${esc(TOPICS[t.topic] || t.topic)} · opened ${ago(t.created_at)}${t.assignee_name ? ` · ${esc(t.assignee_name)}` : ' · unassigned'}</small>${timer(t, od)}</button>`).join('')
      : `<p class="muted">${S.box === 'open' ? 'No open tickets. 🎉' : 'Nothing here.'}</p>`;
    tl.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => openTicket(b.dataset.t));
  }
  async function openTicket(id) {
    S.ticket = id; document.querySelectorAll('.tk').forEach((b) => b.classList.toggle('on', b.dataset.t === id));
    const tv = document.getElementById('tv'); if (!tv) return;
    const [r, staff, saved] = await Promise.all([api.ticket(id), api.staff().catch(() => []), api.savedReplies().catch(() => [])]);
    const t = r.ticket; const B = r.business; const workers = (lvl) => staff.filter((s) => s.active && (s.perms || permsOf(s)).includes(LEVEL_PERM[lvl]));
    const myId = (staff.find((s) => s.display_name === S.me.name) || {}).user_id;
    tv.innerHTML = `<div class="card tview"><div class="phead"><div style="flex:1;min-width:0"><h2>${esc(t.subject)}</h2>
        <div class="row small"><span class="code">${esc(t.ref)}</span>${pill(TSTAT, t.status)}<span class="pill">Level ${t.level} · ${LEVELS[t.level]}</span>${t.overdue_at ? '<span class="pill bad">Overdue</span>' : ''}
        <span class="muted">${esc(TOPICS[t.topic] || t.topic)} · from ${esc(t.opened_by_name || '')} ${esc(t.opened_by_email || '')} · opened ${ago(t.created_at)}</span></div></div>
        <button class="btn sm sup-back" id="tback">← Inbox</button></div>
      <div class="tgrid"><div><div class="conv">${r.messages.map((x) => `<div class="msg${x.internal ? ' note' : x.staff ? ' staff' : ''}"><small><b>${esc(x.from)}</b>${x.internal ? ' · internal note' : x.staff ? ' · to the customer' : ''} · ${ago(x.at)}</small><div>${esc(x.body).replace(/\n/g, '<br>')}</div></div>`).join('')}</div>
        ${r.can_work ? `<form id="rf" class="card rbox"><div class="row"><label class="opt"><input type="radio" name="kind" value="reply" checked> Reply to customer</label><label class="opt"><input type="radio" name="kind" value="note"> Internal note</label>
          ${saved.length ? `<select id="ins" aria-label="Insert a saved reply"><option value="">Insert a saved reply…</option>${saved.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select>` : ''}</div>
          <textarea name="msg" rows="5" required maxlength="5000" placeholder="Write your reply…"></textarea>
          <div class="row"><label class="small" id="thenl">Then <select name="then"><option value="waiting_customer">wait for the customer</option><option value="done">mark done</option><option value="waiting_us">keep it with us</option></select></label>
          <span style="flex:1"></span><button class="btn p" id="send">Send reply</button></div></form>`
          : `<div class="card"><p class="muted small">This ticket is with <b>${LEVELS[t.level]}</b> (level ${t.level}). Only staff who work that level can reply or add notes${can('support.escalate') ? ', or you can escalate it' : ''}.</p></div>`}
        ${r.escalations.length ? `<div class="card small"><h3>Escalations</h3>${r.escalations.map((e) => `<div>${e.to > e.from ? '⬆' : '⬇'} ${LEVELS[e.from]} → <b>${LEVELS[e.to]}</b> by ${esc(e.by)} · ${ago(e.at)}<br><span class="muted">${esc(e.reason)}</span></div>`).join('')}</div>` : ''}</div>
      <div class="tside"><div class="card"><h3>Ticket</h3>
        <label class="f"><span>Status</span><select id="tst"${r.can_work ? '' : ' disabled'}>${Object.entries(TSTAT).map(([k, [l]]) => `<option value="${k}"${k === t.status ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f"><span>Priority</span><select id="tpr"${can('support.reply', 'support.assign') ? '' : ' disabled'}>${['low', 'normal', 'high', 'urgent'].map((k) => `<option${k === t.priority ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
        <label class="f"><span>Assigned to</span><select id="tas"${can('support.assign') || r.can_work ? '' : ' disabled'}><option value="">Nobody yet</option>${workers(t.level).map((s) => `<option value="${esc(s.user_id)}"${s.user_id === t.assignee ? ' selected' : ''}${!can('support.assign') && s.user_id !== myId && s.user_id !== t.assignee ? ' disabled' : ''}>${esc(s.display_name)}</option>`).join('')}</select></label>
        <div class="row">${can('support.escalate') ? '<button class="btn sm" id="tesc">⬆ Escalate / ⬇ send back</button>' : ''}${can('support.saved_replies') ? '<button class="btn sm" id="tsr">Saved replies…</button>' : ''}
          ${t.workspace_id && can('refunds.request', 'refunds.approve') ? '<button class="btn sm" id="trf">↩️ Refund request</button>' : ''}</div></div>
        ${B ? `<div class="card" id="tbiz"><h3>${esc(B.name)} ${pill(BSTAT, B.status || 'active')}</h3><dl class="kv"><dt>Business ID</dt><dd class="code">${esc(B.company_code || '')}</dd>
          <dt>Plan</dt><dd>${(B.paid || []).length ? B.paid.map(modName).map(esc).join(', ') : 'Nothing paid'}${(B.trial || []).length ? `<small class="muted"> · trial: ${B.trial.map(modName).map(esc).join(', ')}</small>` : ''}</dd>
          <dt>A month</dt><dd>${money(B.monthly)}</dd><dt>People · PCs</dt><dd>${num(B.people)} · ${num(B.pcs)}</dd><dt>Last active</dt><dd>${ago(B.last_active_at)}</dd>
          ${creditText(B.credit) ? `<dt>Credit</dt><dd>${creditText(B.credit)}</dd>` : ''}</dl>
          ${(B.notes || []).length ? `<div class="notes">${B.notes.slice(0, 3).map((n) => `<div class="nt">${esc(n.body)}<small>${esc(n.by || 'Riyeser')} · ${ago(n.at)}</small></div>`).join('')}</div>` : ''}
          <button class="btn sm" id="tco" style="margin-top:8px">Open company panel</button></div>` : '<div class="card"><p class="muted small">Not linked to a business.</p></div>'}
        ${(r.refunds || []).length ? `<div class="card small"><h3>Refund requests</h3>${r.refunds.map((f) => `<div><span class="code">${esc(f.ref)}</span> ${cur(f.amount, f.currency)} · ${pill(RSTAT, f.status)}</div>`).join('')}</div>` : ''}</div></div></div>`;
    const done = async () => { await loadInbox(); await openTicket(id); };
    const act = async (fn) => { try { await fn(); await done(); } catch (err) { alert(plain(err)); await done(); } };
    tv.querySelector('#tback').onclick = () => { S.ticket = null; tv.innerHTML = ''; document.querySelector('.sup').classList.remove('open'); };
    document.querySelector('.sup').classList.add('open');
    const rf = tv.querySelector('#rf');
    if (rf) {
      const sync = () => { const note = rf.querySelector('[name=kind]:checked').value === 'note'; rf.classList.toggle('isnote', note); tv.querySelector('#send').textContent = note ? 'Add internal note' : 'Send reply'; tv.querySelector('#thenl').hidden = note; };
      rf.querySelectorAll('[name=kind]').forEach((x) => x.onchange = sync);
      const ins = rf.querySelector('#ins'); if (ins) ins.onchange = () => { const s = saved.find((x) => String(x.id) === ins.value); if (!s) return; const ta = rf.querySelector('textarea');
        const at = ta.selectionStart || ta.value.length; ta.value = ta.value.slice(0, at) + s.body + ta.value.slice(at); ins.value = ''; ta.focus(); };
      rf.onsubmit = (e) => { e.preventDefault(); const f = new FormData(rf); const note = f.get('kind') === 'note';
        act(() => api.ticketReply(id, String(f.get('msg')).trim(), note, note ? null : String(f.get('then')))); };
    }
    tv.querySelector('#tst').onchange = (e) => act(() => api.ticketStatus(id, e.target.value));
    tv.querySelector('#tpr').onchange = (e) => act(() => api.ticketPriority(id, e.target.value));
    tv.querySelector('#tas').onchange = (e) => act(() => api.ticketAssign(id, e.target.value || null));
    const co = tv.querySelector('#tco'); if (co) co.onclick = () => openCompany(B.id);
    const esb = tv.querySelector('#tesc'); if (esb) esb.onclick = () => dlg(`<h3>Escalate or send back</h3><p class="muted small">Now: level ${t.level} (${LEVELS[t.level]}). The reason is an internal note; the customer only sees "We've passed this to our senior team".</p>
      <form id="ef"><label class="f"><span>Move to</span><select name="level">${[1, 2, 3].filter((l) => l !== t.level).map((l) => `<option value="${l}"${l === t.level + 1 ? ' selected' : ''}>Level ${l} · ${LEVELS[l]}</option>`).join('')}</select></label>
      <label class="f"><span>Assign to <small class="muted">(optional)</small></span><select name="assign"><option value="">Whoever picks it up</option></select></label>
      <label class="f"><span>Reason</span><input name="reason" required minlength="4" maxlength="500" placeholder="e.g. Needs a developer to check the printer driver"></label>
      <div id="eferr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Move it</button></div></form>`, (d, close) => {
      const lv = d.querySelector('[name=level]'); const as = d.querySelector('[name=assign]');
      const fill = () => { as.innerHTML = '<option value="">Whoever picks it up</option>' + workers(Number(lv.value)).map((s) => `<option value="${esc(s.user_id)}">${esc(s.display_name)}</option>`).join(''); };
      lv.onchange = fill; fill();
      d.querySelector('#ef').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        try { await api.ticketEscalate(id, Number(f.get('level')), String(f.get('reason')).trim(), String(f.get('assign') || '') || null); close(); await done(); }
        catch (err) { d.querySelector('#eferr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
    const srb = tv.querySelector('#tsr'); if (srb) srb.onclick = () => manageSaved(() => openTicket(id));
    const rfb = tv.querySelector('#trf'); if (rfb) rfb.onclick = () => dlg(`<h3>↩️ Refund request for this customer</h3><p class="muted small">Entered on their behalf from ${esc(t.ref)}. It goes to the Refunds queue for approval; they're emailed that we've got it.</p>
      <form id="rq"><label class="f"><span>What it's for</span><input name="for_what" required maxlength="120" placeholder="e.g. Accounting Basics"></label>
      <div class="grid g2"><label class="f"><span>Period</span><input name="period" maxlength="80" placeholder="e.g. November 2026"></label><label class="f"><span>Invoice reference</span><input name="invoice_ref" maxlength="80"></label>
      <label class="f"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" required></label><label class="f"><span>Currency</span><select name="currency"><option>FJD</option><option>AUD</option><option>NZD</option><option>USD</option></select></label></div>
      <label class="f"><span>Reason</span><select name="reason_category">${Object.entries(RWHY).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="f"><span>What the customer said</span><textarea name="explanation" rows="3" maxlength="2000"></textarea></label>
      <div id="rqerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Enter request</button></div></form>`, (d, close) => {
      d.querySelector('#rq').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const v = (k) => String(f.get(k) || '').trim();
        try { const x = await api.refundCreate(id, { for_what: v('for_what'), period: v('period'), invoice_ref: v('invoice_ref'), amount: Number(v('amount')), currency: v('currency'), reason_category: v('reason_category'), explanation: v('explanation') });
          close(); flash(`Refund request ${x.ref} entered.`); await done(); } catch (err) { d.querySelector('#rqerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
  }
  async function manageSaved(after) {
    const list = await api.savedReplies();
    dlg(`<h3>Saved replies</h3><p class="muted small">Ready-made answers anyone can insert into a reply. Keep them friendly and plain.</p>
      <div class="srl">${list.map((s) => `<details><summary>${esc(s.title)}</summary><form data-sr="${s.id}"><input name="title" value="${esc(s.title)}" required maxlength="80"><textarea name="body" rows="4" required maxlength="5000">${esc(s.body)}</textarea>
        <div class="row"><button class="btn sm p">Save</button><button type="button" class="btn sm" data-retire="${s.id}">Remove</button></div></form></details>`).join('') || '<p class="muted small">None yet.</p>'}</div>
      <form id="srn" class="card"><b class="small">Add one</b><input name="title" required maxlength="80" placeholder="Title"><textarea name="body" rows="3" required maxlength="5000" placeholder="The reply"></textarea><button class="btn sm p">Add</button></form>
      <div class="mfoot"><button class="btn" data-close>Close</button></div>`, (d, close) => {
      const again = async () => { close(); await manageSaved(after); if (after) after(); };
      const run = async (fn) => { try { await fn(); await again(); } catch (err) { alert(plain(err)); } };
      d.querySelectorAll('form[data-sr]').forEach((f) => f.onsubmit = (e) => { e.preventDefault(); const x = new FormData(f); run(() => api.saveReply(Number(f.dataset.sr), String(x.get('title')), String(x.get('body')))); });
      d.querySelectorAll('[data-retire]').forEach((b) => b.onclick = () => { if (confirm('Remove this saved reply?')) run(() => api.retireReply(Number(b.dataset.retire))); });
      d.querySelector('#srn').onsubmit = (e) => { e.preventDefault(); const x = new FormData(e.target); run(() => api.saveReply(null, String(x.get('title')), String(x.get('body')))); };
    });
  }

  // ------------------------------------------------------------------ refunds
  const RBOXES = [['new', 'New'], ['reviewing', 'Reviewing'], ['second', 'Waiting for second approval'], ['to_pay', 'Approved – to pay'], ['paid', 'Paid'], ['declined', 'Declined'], ['all', 'All']];
  async function refunds() {
    S.rbox = S.rbox || 'open';
    const r = await api.refunds(S.rbox);
    const m = main(`<h2>Refunds</h2><p class="sub">Refund requests from customers. Over ${cur(r.threshold, '')} (any currency) a second person with refunds.approve must also approve.
      Card refunds are done by hand for now (the payment provider comes in phase 2): pay it, then mark it paid here.</p>
      ${chips(RBOXES, S.rbox, r.counts || {})}<div id="rl">${(r.refunds || []).map(refundCard).join('') || `<div class="card"><p class="muted">${S.rbox === 'open' ? 'Nothing waiting.' : 'Nothing here.'}</p></div>`}</div>`);
    m.querySelectorAll('[data-box]').forEach((b) => b.onclick = () => { S.rbox = S.rbox === b.dataset.box ? 'open' : b.dataset.box; refunds(); });
    wireRefunds(m, refunds);
  }
  function refundCard(f) {
    const canPay = ['approved', 'partly_approved'].includes(f.status) && !f.waiting_second;
    return `<div class="card rcard" data-rf="${esc(f.id)}"><div class="row"><span class="code">${esc(f.ref)}</span>${refundPill(f)}<b>${cur(f.amount, f.currency)}</b><span class="muted small">· ${esc(f.business || '')} · ${ago(f.created_at)}</span>
      ${f.ticket_ref ? `<span class="muted small">· ticket ${esc(f.ticket_ref)}</span>` : ''}</div>
      <dl class="kv small"><dt>For</dt><dd>${esc(f.for_what)}${f.period ? ` · ${esc(f.period)}` : ''}${f.invoice_ref ? ` · ${esc(f.invoice_ref)}` : ''}</dd><dt>Why</dt><dd>${esc(RWHY[f.reason_category] || f.reason_category)}${f.explanation ? `: ${esc(f.explanation)}` : ''}</dd>
        <dt>Asked by</dt><dd>${esc(f.requested_by_name || '')}${f.on_behalf_by ? ` (entered by ${esc(f.on_behalf_by)})` : ''}</dd>
        ${f.decided_by_name ? `<dt>Decision</dt><dd>${esc(f.decided_by_name)}: ${f.amount_approved != null ? cur(f.amount_approved, f.currency) : ''} · ${esc(f.decision_reason || '')}${f.second_approver_name ? `<br>Second approval: ${esc(f.second_approver_name)}` : ''}</dd>` : ''}
        ${f.paid_at ? `<dt>Paid</dt><dd>${day(f.paid_at)} · ${esc((PAID_HOW.find((x) => x[0] === f.paid_method) || [0, f.paid_method])[1])}${f.paid_reference ? ` · ${esc(f.paid_reference)}` : ''}</dd>` : ''}</dl>
      <div class="row">${f.status === 'submitted' && can('refunds.approve') ? '<button class="btn sm" data-ract="review">Start reviewing</button>' : ''}
        ${['submitted', 'reviewing'].includes(f.status) && can('refunds.approve') ? '<button class="btn sm p" data-ract="approve">Approve</button><button class="btn sm" data-ract="partly">Partly approve</button><button class="btn sm" data-ract="decline">Decline</button>' : ''}
        ${f.waiting_second && can('refunds.approve') ? '<button class="btn sm p" data-ract="second">Give second approval</button>' : ''}
        ${canPay && can('refunds.pay') ? '<button class="btn sm p" data-ract="paid">Mark as paid</button>' : ''}</div></div>`;
  }
  function wireRefunds(root, again) {
    root.querySelectorAll('[data-ract]').forEach((b) => b.onclick = () => { const id = b.closest('[data-rf]').dataset.rf; const a = b.dataset.ract;
      const run = async (fn) => { await fn(); await again(); badges(); };
      if (a === 'review') return run(() => api.refundReview(id)).catch((err) => alert(plain(err)));
      if (a === 'approve') return askReason('Approve the full amount', 'The customer sees this reason in their email. Over the threshold, someone else must also approve.', (reason) => run(() => api.refundDecide(id, 'approve', null, reason)), 'Approve');
      if (a === 'decline') return askReason('Decline', 'The customer sees this reason in their email, so keep it kind and clear.', (reason) => run(() => api.refundDecide(id, 'decline', null, reason)), 'Decline');
      if (a === 'partly') return askReason('Partly approve', 'Approve part of it. The customer sees the amount and the reason.', (reason, f) => run(() => api.refundDecide(id, 'partly', Number(f.get('amount')), reason)), 'Approve this amount',
        '<label class="f"><span>Amount to refund</span><input name="amount" type="number" min="0.01" step="0.01" required></label>');
      if (a === 'second') return dlg('<h3>Second approval</h3><p class="muted small">You\'re the second person to approve this refund. You can\'t give both approvals.</p><form id="sa"><label class="f"><span>Note <small class="muted">(optional)</small></span><input name="note" maxlength="300"></label><div id="saerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Approve</button></div></form>',
        (d, close) => { d.querySelector('#sa').onsubmit = async (e) => { e.preventDefault(); try { await api.refundSecond(id, String(new FormData(e.target).get('note') || '')); close(); await again(); badges(); } catch (err) { d.querySelector('#saerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
      if (a === 'paid') return dlg(`<h3>Mark as paid</h3><p class="muted small">Pay it first (card refund, bank transfer or M-PAiSA), then record it here. Credit on account is recorded and shows on the company panel.</p>
        <form id="pd"><label class="f"><span>How it was paid</span><select name="method">${PAID_HOW.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="f"><span>Payment reference</span><input name="ref" maxlength="120" placeholder="e.g. bank transfer TX-1234"></label>
        <div id="pderr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Mark as paid</button></div></form>`, (d, close) => {
        d.querySelector('#pd').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
          try { await api.refundPaid(id, String(f.get('method')), String(f.get('ref') || '').trim()); close(); await again(); } catch (err) { d.querySelector('#pderr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
      return null; });
  }

  // ------------------------------------------------------------------ approvals (refunds over the threshold, free periods over the limit)
  async function approvals() {
    const a = await api.approvals(); const myId = a.me;
    const by = Object.entries(a.month.by_reason || {});
    const m = main(`<h2>Approvals</h2><p class="sub">Things that need a second person. Nobody can approve their own request.</p>
      <div class="tiles">${tile('Refunds waiting', num(a.refunds.length), `over ${cur(a.threshold, '')}`)}${tile('Free periods waiting', num(a.offers.length), `over ${num(a.limit_days)} days`)}
        ${tile('Free periods this month', num(a.month.count), `${num(a.month.days)} free days in all`)}${tile('Free days by reason', by.length ? '' : '0', by.map(([k, v]) => `${esc((OFFER_WHY.find((w) => w[0] === k) || [0, k])[1])}: ${num(v)}`).join(' · ') || 'none this month')}</div>
      <h3 class="h3">Free periods over the limit <span class="badge">${a.offers.length}</span></h3>
      <div id="ao">${a.offers.map((o) => `<div class="card rcard" data-of="${esc(o.id)}"><div class="row"><span class="code">${esc(o.ref)}</span>${offerPill(o)}<b>${o.days} free days</b>
        <span class="muted small">· ${esc(o.business || '')} · ${esc(o.kind === 'account' ? 'all paid programs' : o.modules.map(modName).join(', '))} · asked by ${esc(o.requested_by_name || '')} ${ago(o.created_at)}</span></div>
        <p class="small">${esc((OFFER_WHY.find((w) => w[0] === o.reason_category) || [0, o.reason_category])[1])}: ${esc(o.reason)}${o.ticket ? ` · ticket ${esc(o.ticket)}` : ''}</p>
        ${can('offers.approve') ? (o.requested_by === myId ? '<p class="muted small">You asked for this one, so someone else needs to approve it.</p>' : '<div class="row"><button class="btn sm p" data-oact="yes">Approve and apply</button><button class="btn sm" data-oact="no">Decline</button></div>') : ''}</div>`).join('') || '<div class="card"><p class="muted small">Nothing waiting.</p></div>'}</div>
      <h3 class="h3">Refunds waiting for a second approval <span class="badge">${a.refunds.length}</span></h3><div id="ar2">${a.refunds.map(refundCard).join('') || '<div class="card"><p class="muted small">Nothing waiting.</p></div>'}</div>`);
    m.querySelectorAll('[data-oact]').forEach((b) => b.onclick = async () => { const id = b.closest('[data-of]').dataset.of;
      if (b.dataset.oact === 'no') return askReason('Decline the free period', 'Staff only: the customer never hears about it.', async (reason) => { await api.decideOffer(id, false, reason); approvals(); badges(); }, 'Decline');
      try { await api.decideOffer(id, true, null); flash('Approved and applied. The customer has been emailed.'); approvals(); badges(); } catch (err) { alert(plain(err)); } return null; });
    wireRefunds(m, approvals);
  }

  // ------------------------------------------------------------------ inactive accounts
  async function inactive() {
    const r = await api.inactive();
    const row = (c, extra) => `<tr><td><b>${esc(c.name)}</b><small class="code">${esc(c.company_code || '')}</small></td><td>${esc(c.kind === 'personal' ? 'Just me' : 'Business')}</td><td>${ago(c.last_active_at)}<small>${day(c.last_active_at)}</small></td>${extra}</tr>`;
    const m = main(`<h2>Inactive accounts</h2><p class="sub">The rule: free accounts close after 12 months without use (warning emails 30 and 7 days before). Two years after closing they're ready
      for removal, which an HQ owner approves here. Removal blanks personal details and messages but keeps the rows. Paid businesses are never closed for this, and the books on customers' PCs are never touched.</p>
      <div class="card scroll"><h3>Closing soon <small>· free, not used for over 10 months</small></h3>${r.approaching.length ? `<table class="tbl"><tr><th>Account</th><th>Kind</th><th>Last active</th><th>Closes</th><th>Warned</th></tr>
        ${r.approaching.map((c) => row(c, `<td>${day(c.closes_at)}</td><td>${c.warned_7_at ? '7-day' : c.warned_30_at ? '30-day' : '—'}</td>`)).join('')}</table>` : '<p class="muted small">None.</p>'}</div>
      <div class="card scroll" style="margin-top:14px"><h3>Closed for being inactive</h3>${r.closed.length ? `<table class="tbl"><tr><th>Account</th><th>Kind</th><th>Last active</th><th>Closed</th><th>Ready for removal</th></tr>
        ${r.closed.map((c) => row(c, `<td>${day(c.closed_at)}</td><td>${day(c.ready_at)}</td>`)).join('')}</table>` : '<p class="muted small">None.</p>'}</div>
      <div class="card scroll" style="margin-top:14px" id="ready"><h3>Ready for removal <small>· closed 2 years or more · ${num(r.removed)} removed so far</small></h3>${r.ready.length ? `<form id="rm"><table class="tbl"><tr>${r.can_remove ? '<th></th>' : ''}<th>Account</th><th>Kind</th><th>Last active</th><th>Closed</th></tr>
        ${r.ready.map((c) => `<tr>${r.can_remove ? `<td><input type="checkbox" name="id" value="${esc(c.id)}" aria-label="Remove ${esc(c.name)}"></td>` : ''}<td><b>${esc(c.name)}</b><small class="code">${esc(c.company_code || '')}</small></td><td>${esc(c.kind === 'personal' ? 'Just me' : 'Business')}</td><td>${ago(c.last_active_at)}</td><td>${day(c.closed_at)}${c.closed_reason ? `<small>${esc(c.closed_reason)}</small>` : ''}</td></tr>`).join('')}</table>
        ${r.can_remove ? `<div class="row" style="margin-top:10px"><input name="reason" required minlength="4" maxlength="300" placeholder="Reason, e.g. closed 2 years, owner's rule" style="flex:1;min-width:200px;padding:8px 10px;border:1px solid #cfd6e4;border-radius:9px">
          <button class="btn p">Remove personal details of the ticked accounts</button></div><p class="muted small">Messages become "[removed]", names "Removed person", business details are cleared, help requests are blanked. An anonymous record goes in the HQ history. Login accounts are deleted later with the service key (see ops/RUNBOOK.md).</p>` : '<p class="muted small">Only an HQ owner with accounts.inactive can approve removal.</p>'}</form>` : '<p class="muted small">None.</p>'}</div>`);
    const rm = m.querySelector('#rm'); if (rm && r.can_remove) rm.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(rm); const ids = f.getAll('id').map(String);
      if (!ids.length) { alert('Tick the accounts to remove.'); return; }
      if (!confirm(`Remove the personal details of ${ids.length} account${ids.length === 1 ? '' : 's'}? This can't be undone.`)) return;
      try { const n = await api.removeAccounts(ids, String(f.get('reason')).trim()); flash(`Removed the personal details of ${n} account${n === 1 ? '' : 's'}.`); inactive(); } catch (err) { alert(plain(err)); } };
  }

  // ------------------------------------------------------------------ emails
  const TPL = { ticket_received: 'Help request received', ticket_reply: 'Reply to a help request', mfa_reset: 'Two-step reset notice', inactive_warning_30: 'Inactive: 30-day warning',
    inactive_warning_7: 'Inactive: 7-day warning', business_closed: 'Business closed', business_reopened: 'Business reopened', refund_received: 'Refund request received',
    refund_approved: 'Refund approved', refund_declined: 'Refund declined', refund_paid: 'Refund paid', free_period: 'Free period added' };
  async function emails() {
    const r = await api.emails(); const c = r.counts || {};
    const st = (s) => (s === 'sent' ? '<span class="pill ok">Sent</span>' : s === 'queued' ? '<span class="pill">Queued</span>' : s === 'held' ? '<span class="pill warn">Held</span>' : '<span class="pill bad">Failed</span>');
    const table = (rows, act) => `<table class="tbl"><tr><th>When</th><th>To</th><th>What</th><th>Status</th>${act ? '<th></th>' : ''}</tr>${rows.map((e) => `<tr><td>${ago(e.created_at)}</td><td>${esc(e.to_address || '(no address)')}</td>
      <td>${esc(e.subject)}<small>${esc(TPL[e.template] || e.template)}</small></td><td>${st(e.status)}${e.last_error ? `<small>${esc(e.last_error)}</small>` : ''}</td>${act ? `<td>${can('emails.manage') ? `<button class="btn sm" data-resend="${e.id}">Send again</button>` : ''}</td>` : ''}</tr>`).join('')}</table>`;
    const m = main(`<h2>Emails</h2><p class="sub">Emails to customers wait here, branded Riyeser and from "Riyeser Support". A daily job sends them once an email provider is set up
      (see ops/RUNBOOK.md, Email sending). Until then they stay queued: nothing is lost.</p>
      <div class="tiles">${tile('Queued', num(c.queued), 'waiting to send')}${tile('Sent', num(c.sent), `${num(c.sent_7d)} in the last 7 days`)}${tile('Held', num(c.held), 'no usable address')}${tile('Failed', num(c.failed), 'after 3 tries')}</div>
      <div class="card scroll"><h3>Held or failed</h3>${(r.problems || []).length ? table(r.problems, true) : '<p class="muted small">None.</p>'}</div>
      <div class="card scroll" style="margin-top:14px"><h3>Recent</h3>${(r.recent || []).length ? table(r.recent, false) : '<p class="muted small">Nothing yet.</p>'}</div>`);
    m.querySelectorAll('[data-resend]').forEach((b) => b.onclick = async () => { try { await api.emailResend(Number(b.dataset.resend)); emails(); } catch (err) { alert(plain(err)); } });
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

  // ------------------------------------------------------------------ HQ team: staff, roles, per-person permissions, settings
  async function team() {
    let T = null; try { T = await api.team(); } catch (e) { if (!missing(e)) throw e; }
    const staff = T ? T.staff : await api.staff(); const owner = can('staff.manage'); const ownerRole = S.me.role === 'owner';
    const settings = can('settings.manage') ? await api.settings().catch(() => null) : null;
    const defaults = (role) => (T && T.roles && T.roles[role]) || ROLE_PERMS[role] || [];
    const m = main(`<h2>HQ team</h2><p class="sub">Riyeser staff who can use HQ. Everyone needs two-step sign-in. Each role has default permissions; an HQ owner can tick extra ones on or off for a person.</p>
      <div class="card scroll"><table class="tbl" id="staff"><tr><th>Name</th><th>Role</th><th>Status</th><th>Added</th>${owner ? '<th></th>' : ''}</tr>
      ${staff.map((s) => `<tr><td><b>${esc(s.display_name)}</b><small>${esc(s.email)}</small></td><td>${owner && s.display_name !== S.me.name ? `<select data-role="${s.user_id}" aria-label="Role for ${esc(s.display_name)}">${ROLES.map(([k, l]) => `<option value="${k}"${k === s.role ? ' selected' : ''}>${l}</option>`).join('')}</select>` : esc(roleName(s.role))}
          ${(s.perms_add || []).length || (s.perms_remove || []).length ? `<small>${(s.perms_add || []).length ? `+${s.perms_add.length} ticked on` : ''}${(s.perms_remove || []).length ? ` −${s.perms_remove.length} ticked off` : ''}</small>` : ''}</td>
        <td>${s.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Switched off</span>'}</td><td>${day(s.added_at)}</td>
        ${owner ? `<td><div class="row">${s.display_name !== S.me.name ? `<button class="btn sm" data-toggle="${s.user_id}" data-active="${s.active}">${s.active ? 'Switch off' : 'Switch on'}</button>${T && ownerRole && s.role !== 'owner' ? `<button class="btn sm" data-perms="${s.user_id}">Permissions</button>` : ''}` : '<span class="muted small">you</span>'}</div></td>` : ''}</tr>
        <tr class="permrow" data-permrow="${s.user_id}" hidden><td colspan="5"></td></tr>`).join('')}</table></div>
      ${owner ? `<div class="card" style="margin-top:14px"><h3>Add someone to the HQ team</h3><p class="muted small">They need a Riyeser account first (riyeser.com/team), and must turn on two-step sign-in there.</p>
        <form id="as" class="grid g3"><label class="f"><span>Email</span><input type="email" name="email" required></label><label class="f"><span>Name</span><input name="name" required maxlength="60"></label>
        <label class="f"><span>Role</span><select name="role">${ROLES.map(([k, l]) => `<option value="${k}"${k === 'support' ? ' selected' : ''}>${l}</option>`).join('')}</select></label><div><button class="btn p">Add</button></div></form></div>` : ''}
      <div class="card scroll" style="margin-top:14px"><h3>What each role can do <small>· the defaults</small></h3><table class="tbl small rolegrid"><tr><th>Permission</th>${ROLES.map(([, l]) => `<th>${l}</th>`).join('')}</tr>
        ${PERMS.map(([k, l]) => `<tr><td>${esc(l)}<small class="code">${k}</small></td>${ROLES.map(([r]) => `<td>${defaults(r).includes(k) ? '✓' : ''}</td>`).join('')}</tr>`).join('')}</table>
        <p class="muted small">Support levels: level 1 Support, level 2 Senior / technical (Senior support, or anyone with "Work level 2"), level 3 Management (Owner and Finance).</p></div>
      ${settings ? `<div class="card" style="margin-top:14px" id="settings"><h3>HQ settings <small>· owners only</small></h3><form id="setf" class="grid g2">
        <label class="f"><span>Ticket overdue after (hours without a first reply)</span><input type="number" min="1" name="support.overdue_hours" value="${esc(settings['support.overdue_hours'])}"></label>
        <label class="f"><span>Escalate automatically after (hours waiting on us)</span><input type="number" min="1" name="support.escalate_hours" value="${esc(settings['support.escalate_hours'])}"></label>
        <label class="f"><span>Refunds over this need two approvals (any currency)</span><input type="number" min="1" name="refunds.two_person_threshold" value="${esc(settings['refunds.two_person_threshold'])}"></label>
        <label class="f"><span>Free periods up to this many days apply straight away</span><input type="number" min="1" name="offers.self_limit_days" value="${esc(settings['offers.self_limit_days'])}"></label>
        <div><button class="btn p">Save settings</button></div></form></div>` : ''}`);
    m.querySelectorAll('[data-role]').forEach((sel) => sel.onchange = async () => { const s = staff.find((x) => x.user_id === sel.dataset.role);
      try { await api.setStaff(s.user_id, sel.value, s.active); team(); } catch (err) { alert(plain(err)); team(); } });
    m.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => { const s = staff.find((x) => x.user_id === b.dataset.toggle);
      if (s.active && !confirm(`Switch off ${s.display_name}'s HQ access?`)) return;
      try { await api.setStaff(s.user_id, s.role, !s.active); team(); } catch (err) { alert(plain(err)); } });
    m.querySelectorAll('[data-perms]').forEach((b) => b.onclick = () => { const s = staff.find((x) => x.user_id === b.dataset.perms); const row = m.querySelector(`[data-permrow="${s.user_id}"]`);
      if (!row.hidden) { row.hidden = true; return; } row.hidden = false; const def = defaults(s.role); const eff = s.perms || permsOf(s);
      row.firstElementChild.innerHTML = `<form class="permgrid" data-pf="${s.user_id}"><p class="small muted">Ticked = ${esc(s.display_name)} can do it. <b>Bold</b> = the ${esc(roleName(s.role))} default.</p>
        <div class="pgrid">${PERMS.map(([k, l]) => `<label class="opt"><input type="checkbox" name="p" value="${k}"${eff.includes(k) ? ' checked' : ''}> ${def.includes(k) ? `<b>${esc(l)}</b>` : esc(l)}</label>`).join('')}</div>
        <div class="row"><button class="btn p sm">Save permissions</button><button type="button" class="btn sm" data-reset>Back to the role's defaults</button></div></form>`;
      const pf = row.querySelector('form');
      pf.querySelector('[data-reset]').onclick = async () => { try { await api.setStaffPerms(s.user_id, [], []); team(); } catch (err) { alert(plain(err)); } };
      pf.onsubmit = async (e) => { e.preventDefault(); const on = new FormData(pf).getAll('p').map(String);
        try { await api.setStaffPerms(s.user_id, on.filter((p) => !def.includes(p)), def.filter((p) => !on.includes(p))); flash(`Permissions saved for ${s.display_name}.`); team(); } catch (err) { alert(plain(err)); } }; });
    const as = m.querySelector('#as'); if (as) as.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
      try { await api.addStaff(String(f.get('email')), String(f.get('name')), String(f.get('role'))); team(); } catch (err) { alert(plain(err)); } };
    const sf = m.querySelector('#setf'); if (sf) sf.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(sf);
      try { for (const [k, v] of f.entries()) if (Number(v) !== Number(settings[k])) await api.setSetting(k, Number(v)); flash('Settings saved.'); team(); } catch (err) { alert(plain(err)); } };
  }

  // ------------------------------------------------------------------ HQ history: filters and CSV
  const ACT_GROUPS = [['', 'Everything'], ['customer.viewed', 'Opened a company'], ['ticket.viewed', 'Opened a ticket'], ['ticket.', 'Support tickets'], ['business.', 'Business fix-ups'],
    ['people.', 'People fix-ups (owner, two-step)'], ['refund.', 'Refunds'], ['offer.', 'Free periods'], ['licence.', 'Licences'], ['note.', 'Notes'], ['staff.', 'HQ team'],
    ['accounts.', 'Account removal'], ['email.', 'Emails'], ['settings.', 'Settings'], ['sweep.', 'Automatic jobs'], ['audit.', 'History downloads']];
  async function history() {
    S.hf = S.hf || {};
    const [staff, cos] = await Promise.all([api.staff().catch(() => []), S.companies.length ? S.companies : api.companies('', 'all').catch(() => [])]);
    if (!S.companies.length) S.companies = cos;
    const f = S.hf;
    const m = main(`<h2>HQ history</h2><p class="sub">Everything done in HQ (and every company or ticket opened), by whom and when. It can't be changed or deleted, even by the database owner.</p>
      <form class="card filters" id="hf"><label class="f"><span>Who</span><select name="who"><option value="">Anyone</option>${staff.map((s) => `<option value="${esc(s.user_id)}"${f.who === s.user_id ? ' selected' : ''}>${esc(s.display_name)}</option>`).join('')}</select></label>
        <label class="f"><span>What</span><select name="action">${ACT_GROUPS.map(([k, l]) => `<option value="${k}"${(f.action || '') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f"><span>Business</span><select name="ws"><option value="">Any</option>${cos.map((c) => `<option value="${esc(c.id)}"${f.ws === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="f"><span>From</span><input type="date" name="from" value="${esc(f.from || '')}"></label><label class="f"><span>To</span><input type="date" name="to" value="${esc(f.to || '')}"></label>
        <div class="row"><button class="btn p">Show</button><button type="button" class="btn" id="csv">⬇ Download CSV</button></div></form>
      <div class="card scroll" id="hl"><p class="muted">Loading…</p></div>`);
    const read = () => { const x = new FormData(m.querySelector('#hf')); return { who: String(x.get('who') || ''), action: String(x.get('action') || ''), ws: String(x.get('ws') || ''), from: String(x.get('from') || ''), to: String(x.get('to') || '') }; };
    m.querySelector('#hf').onsubmit = (e) => { e.preventDefault(); S.hf = read(); history(); };
    m.querySelector('#csv').onclick = async () => { try { const rows = await api.history({ ...read(), exp: true }); downloadCsv(rows); } catch (err) { alert(plain(err)); } };
    const rows = await api.history(f); const coName = (id) => (cos.find((c) => c.id === id) || {}).name;
    m.querySelector('#hl').innerHTML = rows.length ? `<table class="tbl"><tr><th>When</th><th>Who</th><th>What</th><th>Business</th></tr>
      ${rows.map((h) => { const d = h.details || {}; const ws = h.workspace_id || d.workspace_id; const extra = histExtra(h);
        return `<tr><td>${ago(h.at)}<small>${day(h.at)}</small></td><td>${esc(h.who)}</td><td>${esc(HIST_ACTS[h.action] || h.action)}${extra ? ` <small>${esc(extra)}</small>` : ''}</td><td>${ws ? `<a href="#" data-goco="${esc(ws)}">${esc(h.business || coName(ws) || 'a business')}</a>` : ''}</td></tr>`; }).join('')}</table>`
      : '<p class="muted">Nothing matches.</p>';
    m.querySelectorAll('[data-goco]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openCompany(a.dataset.goco); });
  }
  function downloadCsv(rows) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['When (UTC)', 'Who', 'Action', 'What', 'Business', 'Ticket', 'Details'].map(q).join(',')].concat(rows.map((h) => [h.at, h.who, h.action, HIST_ACTS[h.action] || '',
      h.business || (S.companies.find((c) => c.id === (h.workspace_id || (h.details || {}).workspace_id)) || {}).name || '', h.ticket || (h.details || {}).ticket || '', JSON.stringify(h.details || {})].map(q).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `riyeser-hq-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  window.RiyeserHQ = { state: S, demo: DEMO, openCompany };
  start();
})();
