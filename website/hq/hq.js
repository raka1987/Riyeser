/* Riyeser HQ: the back office for running Riyeser. Riyeser staff only, with two-step sign-in.
   Shows account information (companies, people counts, branches, linked PCs and versions, trials, Riyeser Link Plus,
   downloads, notes), support tickets, refunds, free periods and the staff history. It never sees customers' chat
   messages, calls or books: the database only offers hq_ summaries. Support tickets are written to Riyeser, so HQ sees those.
   Every button is checked again by the database (hq_need); the website only hides what you can't do.
   Runs on the Riyeser Link (formerly Riyeser Team) Supabase project (../link/config.js). With ?demo, or before it's set up, sample data. */
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
  const MODULES = [['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['payroll', 'Payroll'], ['pos', 'POS'], ['bookings', 'Bookings'], ['as_built', 'As Built'], ['calls', 'Riyeser Link Plus']];
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
    ['staff.manage', 'Manage the HQ team'], ['audit.view', 'See the HQ history'], ['settings.manage', 'Change HQ settings'], ['reports.view', 'See reports'],
    ['link.support', 'Riyeser Link phone support']];
  const BASE = ['overview.view', 'downloads.view'];
  const ROLE_PERMS = {
    owner: PERMS.map((p) => p[0]),
    finance: [...BASE, 'customers.view', 'customers.notes', 'licences.view', 'licences.manage', 'support.view', 'support.reply', 'support.level2', 'support.level3',
      'support.escalate', 'refunds.view', 'refunds.approve', 'refunds.pay', 'offers.grant', 'offers.approve', 'emails.view', 'reports.view'],
    support: [...BASE, 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa', 'licences.view', 'support.view', 'support.reply', 'support.assign',
      'support.saved_replies', 'support.escalate', 'refunds.view', 'refunds.request', 'offers.grant', 'emails.view', 'link.support'],
    senior: [...BASE, 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa', 'people.change_owner', 'business.close', 'licences.view', 'support.view',
      'support.reply', 'support.assign', 'support.saved_replies', 'support.escalate', 'support.level2', 'refunds.view', 'refunds.request', 'offers.grant', 'emails.view', 'emails.manage', 'link.support', 'reports.view'],
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
      // the customer page, the Companies list, Reports and the home's "Needs attention" (newer team-chat.sql; older
      // databases fall back to what they have, or the page says how to switch it on)
      async companyPage(ws) {
        try { return await rpc('hq_company_page', { ws }); } catch (e) { if (!missing(e)) throw e; }
        const [c, lic] = await Promise.all([rpc('hq_company', { ws }), rpc('hq_company_licence', { ws }).catch(() => null)]);
        return { ...c, old: true, licence: lic && lic.licence, monthly: lic && lic.monthly, owner: (c.people || []).find((x) => x.role === 'owner') || null,
          tickets_open: ((c.extra || {}).tickets || []).filter((t) => t.status !== 'done').length, timeline: null };
      },
      async companiesPage(o) {
        try { return await rpc('hq_companies_page', { search: o.q || '', filters: o.f || {}, sort_by: o.sort || null, sort_desc: o.desc == null ? null : !!o.desc,
          page_no: o.page || 1, per_page: o.per || 50, for_export: !!o.exp }); } catch (e) { if (!missing(e)) throw e; }
        const all = await this.companies(o.q, (o.f || {}).status || 'all');
        return { old: true, total: all.length, page: 1, per_page: Math.max(1, all.length), rows: all };
      },
      quickLicence: (ws, mod, act, x) => rpc('hq_quick_licence', { ws, mod, act, days: x.days || null, until_day: x.until || null, reason_category: x.why, reason: x.reason, ticket_ref: x.ticket || null }),
      messageCustomer: (ws, person, topic, subject, body) => rpc('hq_message_customer', { ws, to_person: person || null, msg_topic: topic, msg_subject: subject, msg_body: body }),
      async noteAdd(ws, n) {
        try { return await rpc('hq_note_add', { ws, note_kind: n.kind || 'note', note_body: n.body, call_direction: n.direction || null, call_with: n.contact || null, follow_up_on: n.follow_up || null, pin: !!n.pinned }); }
        catch (e) { if (!missing(e) || n.kind === 'call' || n.follow_up || n.pinned) throw e; return rpc('hq_add_note', { ws, body: n.body }); }
      },
      notePin: (id, pin) => rpc('hq_note_pin', { note_id: id, pin }), followUpDone: (id) => rpc('hq_follow_up_done', { note_id: id }),
      myFollowUps: () => rpc('hq_my_follow_ups'), reports: (from, to) => rpc('hq_reports', { from_day: from, to_day: to }), attention: () => rpc('hq_attention'),
      setOwner: (ws, staff) => rpc('hq_set_owner', { ws, staff: staff || null }), workQueue: () => rpc('hq_work_queue'), signups: (days) => rpc('hq_signups', { days }),
      handover: () => rpc('hq_handover'), handoverAdd: (note, shiftDay) => rpc('hq_handover_add', { note, shift_day: shiftDay || null }), handoverDone: (id) => rpc('hq_handover_done', { note_id: id }),
      // Riyeser Link Office (added separately): only used when the database has these functions
      companyLink: (ws) => rpc('hq_company_link', { ws }), linkOffline: () => rpc('hq_link_offline'),
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
    // More sample businesses (made-up names), so the list has pages, filters and sorting to show.
    const KINDS = ['Plumbing', 'Cafe', 'Joinery', 'Dental', 'Traders', 'Electrical', 'Bakery', 'Motors', 'Florist', 'Builders', 'Cleaning', 'Print'];
    const PLACES = ['Fiji', 'Australia', 'New Zealand', 'Samoa', 'Tonga'];
    for (let i = 1; i <= 118; i++) {
      const age = ({ 3: 88, 4: 87, 5: 84, 6: 83 })[i] || ((i * 7) % 80) + 1;
      cos.push({ id: 'g' + i, name: `Demo ${KINDS[i % KINDS.length]} ${i}`, company_code: `RIY-D${String(i).padStart(3, '0')}-${'ABCDEFGHJK'[i % 10]}${i % 9}`, country: PLACES[i % PLACES.length],
        created_at: t(age), people: 1 + (i % 6), branches: 1, pcs: i % 4, last_seen: i % 4 ? t(i % 50) : null, calls_paid_until: null, trial_days_left: 90 - age,
        owner_name: `Owner ${i}`, owner_email: `owner${i}@demo.test`, status: 'active', kind: i % 5 ? 'business' : 'personal', last_active_at: t((i * 3) % 75) });
    }
    cos.forEach((c, i) => { c.owner_phone = c.owner_phone || `555 0${String(100 + i).padStart(3, '0')}`; c.hq_owner = ({ w1: 's2', w2: 's1', w3: 's1', w4: 's4' })[c.id] || (i % 3 === 0 ? 's2' : null);
      c.address = c.address || ({ Fiji: ['Suva', 'Nadi', 'Lautoka'][i % 3], Australia: 'Brisbane', 'New Zealand': 'Auckland', Samoa: 'Apia', Tonga: 'Nuku\'alofa' })[c.country] || ''; });
    let hn = 3; const handover = [{ id: 1, note: 'Northside Dental: call Priya back about the POS printer after 3 pm.', shift_date: new Date().toISOString().slice(0, 10), done: false, by: 'Help Desk', author: 's2', at: t(0.3) },
      { id: 2, note: 'Two trials end in the next 3 days: check they have what they need.', shift_date: new Date().toISOString().slice(0, 10), done: false, by: 'Riki', author: 's1', at: t(0.2) }];
    const staff = [{ user_id: 's1', display_name: 'Riki', role: 'owner', active: true, email: 'riki@riyeser.test', added_at: t(30), perms_add: [], perms_remove: [] },
      { user_id: 's2', display_name: 'Help Desk', role: 'support', active: true, email: 'help@riyeser.test', added_at: t(5), perms_add: [], perms_remove: [] },
      { user_id: 's3', display_name: 'Finance Fi', role: 'finance', active: true, email: 'money@riyeser.test', added_at: t(4), perms_add: [], perms_remove: [] },
      { user_id: 's4', display_name: 'Senior Sione', role: 'senior', active: true, email: 'senior@riyeser.test', added_at: t(3), perms_add: [], perms_remove: [] }];
    let actor = 's1';
    const me = () => staff.find((s) => s.user_id === actor); const nameOf = (id) => (staff.find((s) => s.user_id === id) || {}).display_name || null;
    const need = (p) => { if (!permsOf(me()).includes(p)) throw new Error('Your HQ role can\'t do that.'); };
    const mods = { w2: { basic: { status: 'active', paid_until: t(-300).slice(0, 10) }, pos: { status: 'active', paid_until: t(-300).slice(0, 10) }, calls: { status: 'active', paid_until: t(-200).slice(0, 10) } },
      w1: { basic: { status: 'active', paid_until: t(-20).slice(0, 10) }, payroll: { status: 'cancelled', paid_until: t(5).slice(0, 10) } } };
    for (let i = 6; i <= 118; i += 6) mods['g' + i] = { basic: { status: 'active', paid_until: t(-20 - i).slice(0, 10), paid_since: t(i % 50).slice(0, 10) }, ...(i % 12 ? {} : { pos: { status: 'active', paid_until: t(-40 - i).slice(0, 10), paid_since: t(i % 30).slice(0, 10) } }) };
    mods.w1.basic.paid_since = t(120).slice(0, 10); mods.w2.basic.paid_since = t(200).slice(0, 10); mods.w2.pos.paid_since = t(20).slice(0, 10); mods.w2.calls.paid_since = t(35).slice(0, 10);
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
    let nid = 3;
    const notes = { w1: [{ id: 1, kind: 'note', body: 'Called Alex: wants POS for the Lautoka branch next month.', at: t(2), by: 'Riki', author: 's1', pinned: false }],
      w2: [{ id: 2, kind: 'call', direction: 'in', contact: 'Mere', body: 'Asked about yearly billing for the second cafe.', at: t(1), by: 'Riki', author: 's1', follow_up: new Date().toISOString().slice(0, 10), pinned: false }] };
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
      { id: 1, to_address: 'priya@northside.test', subject: 'We\'ve got your help request (T-10236)', template: 'ticket_received', status: 'queued', attempts: 0, created_at: t(1), workspace_id: 'w3' },
      { id: 2, to_address: null, subject: 'Your two-step sign-in was reset', template: 'mfa_reset', status: 'held', attempts: 0, created_at: t(2), last_error: 'No email address', workspace_id: 'w3' },
      { id: 3, to_address: 'mere@harbour.test', subject: 'Re: Charged twice in November (T-10235)', template: 'ticket_reply', status: 'failed', attempts: 3, created_at: t(3), last_error: 'HTTP 422', workspace_id: 'w2' },
      { id: 4, to_address: 'sam@joinery.test', subject: 'Quiet Joinery will close in 20 days', template: 'inactive_warning_30', status: 'queued', attempts: 0, created_at: t(0.5), workspace_id: 'w5' }];
    const wsOf = (addr) => (cos.find((c) => c.owner_email === addr) || {}).id || null;
    const queue = (to, subject, template, ws = wsOf(to)) => emails.unshift({ id: en++, to_address: to, subject, template, status: 'queued', attempts: 0, created_at: now(), workspace_id: ws });
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
    function peopleOf(ws) { const c = cos.find((x) => x.id === ws);
      return c.people_list || (c.people_list = [{ user_id: ws + '-p1', name: c.owner_name, role: 'owner', job_role: 'owner', extension: 101, email: c.owner_email, joined: c.created_at, two_step: true, phone: c.owner_phone, last_sign_in: c.last_active_at },
        { user_id: ws + '-p2', name: 'Sam Taylor', role: 'admin', job_role: 'manager', extension: 102, email: 'sam@sample.test', joined: t(20), two_step: true, phone: '555 0201', last_sign_in: t(4) },
        { user_id: ws + '-p3', name: 'Jordan Lee', role: 'member', job_role: 'staff', extension: 201, email: 'jordan@sample.test', joined: t(10), two_step: false, phone: null, last_sign_in: t(40) }]); }
    const APPS = [['central', '1.8.1'], ['accounting-basics', '2.3.0'], ['pos', '1.4.0'], ['invoices', '1.2.0'], ['team', '1.1.0'], ['payroll', '1.6.0'], ['pdf', '1.3.2']];
    function pcsOf(c) { const names = ['Head office PC', 'Front counter', 'Lautoka front desk', 'Manager laptop']; const owner = c.owner_name;
      return Array.from({ length: c.id.startsWith('g') ? c.pcs : Math.max(1, Math.min(4, c.pcs)) }, (_, i) => ({ id: c.id + '-d' + i, name: names[i], platform: 'Windows', version: i === 1 ? '1.8.0' : '1.8.1',
        last_seen: t(i * 1.5 + 0.01), linked_at: t(30 + i), person: i % 2 ? 'Jordan Lee' : owner,
        programs: i === 3 ? null : APPS.slice(0, 3 + ((i + c.name.length) % 4)).map(([id, v]) => ({ id, version: i === 1 && id === 'pos' ? '1.3.9' : v })), programs_at: i === 3 ? null : t(i + 0.1) })); }
    const noteRow = (n) => ({ follow_up: null, follow_up_done_at: null, direction: null, contact: null, pinned: false, kind: 'note', ...n });
    function timelineOf(ws) { const P = permsOf(me()); const out = [];
      if (P.includes('support.view')) tickets.filter((x) => x.workspace_id === ws).forEach((x) => out.push({ kind: 'ticket', at: x.created_at, id: x.id, ref: x.ref, title: x.subject, status: x.status, by_staff: !!x.staff_started, detail: x.topic, who: x.staff_started ? x.started_by_name : x.opened_by_name, extra: String(x.level) }));
      emails.filter((e) => e.workspace_id === ws).forEach((e) => out.push({ kind: 'email', at: e.created_at, id: String(e.id), title: e.subject, status: e.status, by_staff: true, detail: e.template, who: e.to_address }));
      (notes[ws] || []).map(noteRow).forEach((n) => out.push({ kind: n.kind, at: n.at, id: String(n.id), title: n.body, status: n.follow_up && !n.follow_up_done_at ? 'follow_up' : null, by_staff: true, detail: n.direction, who: n.by, follow_up: n.follow_up, extra: n.contact }));
      if (P.includes('refunds.view')) refunds.filter((f) => f.workspace_id === ws).forEach((f) => out.push({ kind: 'refund', at: f.created_at, id: f.id, ref: f.ref, title: f.for_what, status: f.status, by_staff: !!f.on_behalf_by, detail: `${f.currency} ${f.amount}`, who: f.on_behalf_by || f.requested_by_name }));
      offers.filter((o) => o.workspace_id === ws).forEach((o) => out.push({ kind: 'offer', at: o.created_at, id: o.id, ref: o.ref, title: `${o.days} free days · ${o.modules.map(modName).join(', ')}`, status: o.status, by_staff: true, detail: o.reason_category, who: o.requested_by_name, follow_up: o.ends_at }));
      return out.sort((a, b) => String(b.at).localeCompare(String(a.at))); }
    const QWHY_PAID = ['payment', 'customer_asked', 'non_payment', 'correction', 'other'];
    const iso = (d) => new Date(d).toISOString().slice(0, 10);
    function myFollowUps() { return Object.entries(notes).flatMap(([ws, list]) => list.map(noteRow).filter((n) => n.author === actor && n.follow_up && !n.follow_up_done_at)
      .map((n) => { const c = cos.find((x) => x.id === ws) || {}; const td = iso(Date.now());
        return { id: n.id, workspace_id: ws, business: c.name, company_code: c.company_code, kind: n.kind, body: n.body.slice(0, 200), contact: n.contact, direction: n.direction, follow_up: n.follow_up, due: n.follow_up <= td, overdue: n.follow_up < td, at: n.at }; }))
      .sort((a, b) => a.follow_up.localeCompare(b.follow_up) || a.id - b.id); }
    function listRows() { return cos.map((c) => { const l = demoLicence(c.id); const vs = Object.entries(l.modules); const paid = vs.filter(([, v]) => v.status === 'active').map(([m]) => m);
      const tr = vs.filter(([, v]) => v.status === 'trial'); const te = tr.length ? tr.map(([, v]) => v.trial_ends).sort()[0] : null;
      return { id: c.id, name: c.name, company_code: c.company_code, country: c.country, created_at: c.created_at, status: c.status, kind: c.kind, last_active_at: c.last_active_at,
        paid_n: paid.length, paid, trial_n: tr.length, trial_end: te, trial_days: te ? dd(te) : null, owner_name: c.owner_name, owner_email: c.owner_email, phone: c.owner_phone,
        tickets_open: tickets.filter((x) => x.workspace_id === c.id && x.status !== 'done').length, people: c.people, pcs: c.pcs, hq_owner: c.hq_owner, hq_owner_name: nameOf(c.hq_owner),
        next_follow_up: nextFu(c.id) ? nextFu(c.id).date : null }; }); }
    function nextFu(ws) { const n = (notes[ws] || []).map(noteRow).filter((x) => x.follow_up && !x.follow_up_done_at).sort((a, b) => a.follow_up.localeCompare(b.follow_up))[0];
      return n ? { id: n.id, date: n.follow_up, body: n.body.slice(0, 200), by: n.by, kind: n.kind } : null; }
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
          people: peopleOf(ws),
          branches: [{ name: 'Head office', extension: 100, people: 2 }, { name: 'Lautoka branch', extension: 200, people: 1 }],
          pcs: [{ name: 'Head office PC', platform: 'Windows', version: '1.6.4', last_seen: t(0.01), person: c.owner_name }, { name: 'Lautoka front desk', platform: 'Windows', version: '1.6.3', last_seen: t(1), person: 'Jordan Lee' }],
          requests_waiting: 1, notes: notes[ws] || [],
          extra: { credit: credits[ws] || {}, tickets: P.includes('support.view') ? tickets.filter((x) => x.workspace_id === ws) : null,
            refunds: P.includes('refunds.view') ? refunds.filter((f) => f.workspace_id === ws).map(rowOf) : null, offers: offers.filter((o) => o.workspace_id === ws),
            history: P.includes('audit.view') ? hist.filter((x) => x.workspace_id === ws) : null } }; },
      async setCallsPaid(ws, until) { cos.find((x) => x.id === ws).calls_paid_until = until + 'T23:59:59Z'; log('calls.paid_until', { workspace_id: ws, until }); },
      async addNote(ws, body) { return this.noteAdd(ws, { kind: 'note', body }); },
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
      // the customer page
      async companyPage(ws) { const c = await this.company(ws); const co = cos.find((x) => x.id === ws); const P = permsOf(me()); const od = settings['support.overdue_hours'];
        const people = c.people.map((x) => ({ ...x, country: co.country, signed_up: x.joined, email_confirmed: true, branches: x.extension >= 200 ? ['Lautoka branch'] : ['Head office'],
          signup: x.role === 'owner' ? { you: x.name, phone: co.owner_phone, country: co.country, email: x.email, biz: co.name, tax_number: '50-12345-0-1' } : {} }));
        const open = tickets.filter((x) => x.workspace_id === ws && x.status !== 'done');
        c.profile = { ...c.profile, hq_owner: co.hq_owner, hq_owner_name: nameOf(co.hq_owner) };
        return { ...c, people, next_follow_up: nextFu(ws), staff: staff.filter((x) => x.active).map((x) => ({ user_id: x.user_id, name: x.display_name })), owner: people.find((x) => x.role === 'owner') || null, pcs: pcsOf(co), licence: P.includes('licences.view') ? demoLicence(ws) : null, monthly: demoMonthly(ws),
          notes: (notes[ws] || []).map(noteRow).sort((a, b) => (b.pinned - a.pinned) || String(b.at).localeCompare(String(a.at))),
          tickets_open: open.length, tickets_overdue: open.filter((x) => !x.first_reply_at && hours(x.created_at) > od).length, timeline: timelineOf(ws) }; },
      async messageCustomer(ws, person, topic, subject, body) { need('support.reply');
        const p = peopleOf(ws).find((x) => x.user_id === person) || peopleOf(ws).find((x) => x.role === 'owner');
        if (!p) throw new Error('Choose someone who is in this business.');
        if (!String(subject || '').trim() || !String(body || '').trim()) throw new Error('Add a subject and a message, then send it again.');
        const x = mk(ws, p.name, p.email, topic || 'other', subject.trim(), 'waiting_customer', 1, now(), [sm(me().display_name, body.trim(), now())], { staff_started: true, started_by_name: me().display_name, assignee: actor });
        tickets.unshift(x); queue(p.email, `${x.subject} (${x.ref})`, 'staff_message', ws); log('ticket.started', { workspace_id: ws, ticket: x.ref }); return { id: x.id, ref: x.ref }; },
      async noteAdd(ws, n) { need('customers.notes'); const k = n.kind || 'note';
        if (!String(n.body || '').trim()) throw new Error('Write what it was about first.');
        if (k === 'call' && !['in', 'out'].includes(n.direction)) throw new Error('Choose whether they called us or we called them.');
        if (n.follow_up && n.follow_up < iso(Date.now())) throw new Error('Choose a follow-up date from today on.');
        const row = { id: nid++, kind: k, body: n.body.trim(), at: now(), by: me().display_name, author: actor, direction: k === 'call' ? n.direction : null, contact: (n.contact || '').trim() || null,
          follow_up: n.follow_up || null, follow_up_done_at: null, pinned: !!n.pinned };
        (notes[ws] = notes[ws] || []).unshift(row); log(k === 'call' ? 'call.logged' : 'note.added', { workspace_id: ws, note: row.id, follow_up: row.follow_up }); return row.id; },
      async notePin(id, pin) { need('customers.notes'); const [ws, n] = Object.entries(notes).map(([w, l]) => [w, l.find((x) => x.id === id)]).find(([, x]) => x) || [];
        if (!n) throw new Error('That note doesn\'t exist.'); n.pinned = !!pin; log(pin ? 'note.pinned' : 'note.unpinned', { workspace_id: ws, note: id }); },
      async followUpDone(id) { need('customers.notes'); const [ws, n] = Object.entries(notes).map(([w, l]) => [w, l.find((x) => x.id === id)]).find(([, x]) => x) || [];
        if (!n || !n.follow_up || n.follow_up_done_at) throw new Error('That follow-up is already done.'); n.follow_up_done_at = now(); log('follow_up.done', { workspace_id: ws, note: id }); },
      async myFollowUps() { return myFollowUps(); },
      async quickLicence(ws, mod, act, x) {
        if (!['offers.grant', 'licences.manage'].some((p) => permsOf(me()).includes(p))) throw new Error('Your HQ role can\'t do that.');
        const l = demoLicence(ws); const v = l.modules[mod]; const r = (mods[ws] || {})[mod]; const td = iso(Date.now());
        if (v.status === 'closed') throw new Error('This business is closed or suspended. Reopen it first.');
        const trialish = ['trial', 'ended'].includes(v.status) && (!r || r.status === 'trial');
        if (['extend', 'unlock'].includes(act) && !OFFER_WHY.some((w) => w[0] === x.why)) throw new Error('Choose a reason.');
        if (['paid_until', 'pause', 'cancel'].includes(act) && !QWHY_PAID.includes(x.why)) throw new Error('Choose a reason.');
        const offer = async (kind, days) => ({ ...(await this.grantOffer(ws, { kind, modules: [mod], amount: days, unit: 'days', why: x.why, reason: x.reason, ticket: x.ticket })), action: act, module: mod });
        if (act === 'extend') { if (trialish) return offer('trial', x.days); if (v.status === 'active') return offer('paid', x.days);
          throw new Error(`${modName(mod)} isn't on a trial or paid right now. Use Unlock now or Mark paid until.`); }
        const lic = () => { need('licences.manage'); reasonOk(x.reason); return ticketOk(x.ticket); };
        const set = (row) => { (mods[ws] = mods[ws] || {})[mod] = row; };
        let until; let tr;
        if (act === 'unlock') {
          if (trialish) { const base = v.trial_ends && v.trial_ends > td ? v.trial_ends : td; const target = addDays(td, 30);
            if (base >= target) throw new Error(`${modName(mod)} is already on its trial until ${day(base)}.`); return offer('trial', Math.round((new Date(target) - new Date(base)) / 864e5)); }
          if (v.status === 'active') throw new Error(`${modName(mod)} is already paid${v.paid_until ? ' until ' + day(v.paid_until) : ''}.`);
          tr = lic(); until = x.until || addDays(td, 30); if (until < td) throw new Error('Choose a date from today on.'); set({ status: 'active', paid_until: until, paid_since: td });
        } else if (act === 'paid_until') { tr = lic(); if (!x.until || x.until < td) throw new Error('Choose a date from today on.'); until = x.until;
          set({ status: 'active', paid_until: until, paid_since: (r && r.status === 'active' && r.paid_since) || td });
        } else { tr = lic(); const y = addDays(td, -1);
          if (v.status === 'trial') { until = y; set({ status: 'trial', trial_ends: y }); }
          else if (v.status === 'active') { until = act === 'pause' ? y : v.paid_until; set({ ...r, status: 'cancelled', paid_until: until }); }
          else if (v.status === 'cancelled' && act === 'pause' && v.active) { until = y; set({ ...r, paid_until: y }); }
          else throw new Error(`${modName(mod)} isn't running, so there's nothing to ${act}.`); }
        log('licence.' + ({ unlock: 'unlocked', paid_until: 'paid_until', pause: 'paused', cancel: 'cancelled' })[act], { workspace_id: ws, module: mod, ticket: tr, reason_category: x.why, reason: x.reason, until });
        return { status: 'done', action: act, module: mod, until }; },
      // the Companies list: filters, sorting and pages, as the database does them
      async companiesPage(o) { need('customers.view'); const q = String(o.q || '').toLowerCase(); const f = o.f || {}; const td = iso(Date.now());
        let rows = listRows().filter((c) => (!q || [c.name, c.company_code, c.owner_email, c.owner_name, c.phone].some((v) => String(v || '').toLowerCase().includes(q)))
          && (!f.status || c.status === f.status) && (!f.mine || c.hq_owner === actor) && (!f.country || (c.country || 'Not set') === f.country) && (!f.kind || c.kind === f.kind)
          && (!f.inactive_days || hours(c.last_active_at || c.created_at) / 24 > Number(f.inactive_days))
          && (!f.plan || (f.plan === 'paid' && c.paid_n > 0) || (f.plan === 'trial' && !c.paid_n && c.trial_n > 0) || (f.plan === 'free' && !c.paid_n && !c.trial_n))
          && (!f.trial_days || (c.trial_end && dd(c.trial_end) <= Number(f.trial_days))) && (!f.open_tickets || c.tickets_open > 0)
          && (!f.follow_up || (notes[c.id] || []).some((n) => n.follow_up && !n.follow_up_done_at) || tickets.some((x) => x.workspace_id === c.id && ['new', 'waiting_us'].includes(x.status))));
        const sk = o.sort || 'created'; const desc = o.desc == null ? sk === 'created' : !!o.desc;
        const key = { name: (c) => c.name.toLowerCase(), owner: (c) => (c.owner_name || '').toLowerCase() || null, phone: (c) => c.phone || null, plan: (c) => c.paid_n, trial: (c) => c.trial_days,
          last_active: (c) => c.last_active_at, tickets: (c) => c.tickets_open, status: (c) => c.status, country: (c) => c.country, created: (c) => c.created_at }[sk] || ((c) => c.created_at);
        rows = rows.sort((a, b) => { const x = key(a); const y = key(b); if (x == null && y == null) return b.created_at.localeCompare(a.created_at); if (x == null) return 1; if (y == null) return -1;
          const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y)); return (desc ? -c : c) || b.created_at.localeCompare(a.created_at); });
        const per = Math.min(Math.max(o.per || 50, 1), o.exp ? 5000 : 200); const page = Math.max(o.page || 1, 1);
        if (o.exp && page === 1) log('customers.exported', { filters: f, rows: rows.length });
        const cn = {}; cos.forEach((c) => { const k = c.country || 'Not set'; cn[k] = (cn[k] || 0) + 1; });
        void td; return { total: rows.length, page, per_page: per, sort_by: sk, sort_desc: desc, rows: rows.slice((page - 1) * per, page * per),
          countries: Object.entries(cn).map(([country, n]) => ({ country, n })).sort((a, b) => b.n - a.n) }; },
      // Reports, worked out from the sample data
      async reports(from, to) { need('reports.view'); const F = new Date(from + 'T00:00:00Z'); const T = new Date(to + 'T23:59:59Z'); const td = iso(Date.now());
        const inR = (d) => d && new Date(d) >= F && new Date(d) <= T;
        const wk = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return iso(x); };
        const byWeek = (list) => { const m = {}; list.forEach((d) => { m[wk(d)] = (m[wk(d)] || 0) + 1; }); return Object.keys(m).sort().map((week) => ({ week, n: m[week] })); };
        const months = []; for (let d = new Date(Date.UTC(F.getUTCFullYear(), F.getUTCMonth(), 1)); d <= T; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(iso(d));
        const mEnd = (ms) => iso(new Date(Date.UTC(Number(ms.slice(0, 4)), Number(ms.slice(5, 7)), 0)));
        const fresh = cos.filter((c) => inR(c.created_at)); const L = Object.fromEntries(cos.map((c) => [c.id, demoLicence(c.id)]));
        const paidRows = Object.entries(mods).flatMap(([ws, ms]) => Object.entries(ms).filter(([, r]) => ['active', 'cancelled'].includes(r.status) && r.paid_until)
          .map(([m, r]) => ({ ws, m, since: r.paid_since || iso((cos.find((c) => c.id === ws) || {}).created_at), until: r.paid_until })));
        const ending = cos.filter((c) => c.status === 'active').map((c) => { const tr = Object.entries(L[c.id].modules).filter(([, v]) => v.status === 'trial' && v.days_left <= 30);
          return tr.length ? { id: c.id, name: c.name, company_code: c.company_code, owner_name: c.owner_name, modules: tr.map(([m]) => m), trial_ends: tr.map(([, v]) => v.trial_ends).sort()[0], days_left: Math.min(...tr.map(([, v]) => v.days_left)) } : null; })
          .filter(Boolean).sort((a, b) => a.days_left - b.days_left || a.name.localeCompare(b.name));
        const conv = (n) => (m) => { const paid = paidRows.filter((r) => r.m === m && hours(r.since) / 24 <= n).length;
          const ended = cos.filter((c) => { const v = L[c.id].modules[m]; const te = iso(new Date(new Date(c.created_at).getTime() + 90 * 864e5)); return v.status === 'ended' && !(mods[c.id] || {})[m] && hours(te) / 24 <= n && hours(te) > 0; }).length;
          return [paid, paid + ended]; };
        const fs = (list) => { const s2 = list.map((x) => hours(x.created_at, x.first_reply_at)).sort((a, b) => a - b); return s2.length ? Math.round(s2[Math.floor((s2.length - 1) / 2)] * 10) / 10 : null; };
        const od = settings['support.overdue_hours']; const open = tickets.filter((x) => x.status !== 'done'); const cnt = (list, k) => list.reduce((a, x) => { a[x[k]] = (a[x[k]] || 0) + 1; return a; }, {});
        const monday = wk(Date.now()); const staffOf = (list) => Object.values(list.filter((h) => h.actor).reduce((a, h) => { const x = a[h.actor] = a[h.actor] || { who: h.who, total: 0, changes: 0 }; x.total++; if (!/\.viewed$/.test(h.action)) x.changes++; return a; }, {})).sort((a, b) => b.changes - a.changes || b.total - a.total);
        return { from, to, today: td,
          signups_by_week: byWeek(fresh.map((c) => c.created_at)),
          funnel: { signed_up: fresh.length + 4, confirmed: fresh.length + 2, business: fresh.length, pc_linked: fresh.filter((c) => c.pcs > 0).length, program_used: fresh.filter((c) => c.pcs > 0 && c.last_seen).length },
          trials_by_week: byWeek([...fresh.map((c) => c.created_at), ...offers.filter((o) => o.kind === 'trial' && ['applied', 'approved'].includes(o.status) && inR(o.created_at)).map((o) => o.created_at)]),
          trials_ending: ending,
          conversion: MODULES.map(([m]) => { const [p30, e30] = conv(30)(m); const [p90, e90] = conv(90)(m); return { module: m, paid_30: p30, ended_30: e30, paid_90: p90, ended_90: e90 }; }),
          revenue_by_month: months.map((ms) => { const me2 = mEnd(ms); const per = {}; paidRows.filter((r) => r.since <= me2 && r.until >= ms).forEach((r) => { per[r.ws] = (per[r.ws] || 0) + 1; });
            const est = Object.entries(per).reduce((a, [ws, n]) => { const pl = plans[ws] || {}; let v = n * 20 + (pl.extra_users || 0) * 5 + (pl.extra_companies || 0) * 10; if (pl.billing === 'yearly') v *= 10 / 12; if (pl.early_bird) v *= 0.5; return a + v; }, 0);
            return { month: ms, estimate: Math.round(est * 100) / 100, paying: Object.keys(per).length, new_paid: paidRows.filter((r) => r.since >= ms && r.since <= me2).length,
              lost: paidRows.filter((r) => r.until >= ms && r.until <= me2 && r.until < td).length }; }),
          revenue_by_program: MODULES.map(([m]) => { const n = cos.filter((c) => L[c.id].modules[m].status === 'active').length; return { module: m, paying: n, estimate: n * 20 }; }).sort((a, b) => b.paying - a.paying),
          monthly_now: cos.reduce((a, c) => a + demoMonthly(c.id), 0),
          leaving_by_month: months.map((ms) => { const me2 = mEnd(ms) + 'T23:59:59Z'; const inM = (d) => d && d >= ms && d <= me2;
            return { month: ms, closed: cos.filter((c) => c.status !== 'active' && inM(c.closed_at)).length, closed_inactive: cos.filter((c) => c.status !== 'active' && c.closed_reason === 'inactive' && inM(c.closed_at)).length,
              cancelled: ms === iso(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))) ? Object.values(mods).filter((x) => Object.values(x).some((r) => r.status === 'cancelled')).length : 0,
              went_quiet: cos.filter((c) => c.status === 'active' && inM(c.last_active_at) && hours(c.last_active_at) / 24 > 60).length }; }),
          support: { open_by_status: cnt(open, 'status'), open_by_level: cnt(open, 'level'), overdue: open.filter((x) => !x.first_reply_at && hours(x.created_at) > od).length,
            median_first_reply_hours: fs(tickets.filter((x) => x.first_reply_at && !x.staff_started && inR(x.created_at))), opened: tickets.filter((x) => inR(x.created_at)).length,
            by_topic: Object.entries(cnt(tickets.filter((x) => inR(x.created_at)), 'topic')).map(([topic, n]) => ({ topic, n })).sort((a, b) => b.n - a.n), satisfaction: null },
          staff_week: staffOf(hist.filter((h) => iso(h.at) >= monday)), staff_range: staffOf(hist.filter((h) => inR(h.at))) }; },
      async setOwner(ws, who) { if (!['customers.edit', 'support.assign', 'licences.manage'].some((p) => permsOf(me()).includes(p))) throw new Error('Your HQ role can\'t do that.');
        const c = cos.find((x) => x.id === ws); const was = nameOf(c.hq_owner); c.hq_owner = who || null; log('customer.owner_set', { workspace_id: ws, was, now: nameOf(who) }); },
      async handover() { return handover.slice().sort((a, b) => (a.done - b.done) || b.id - a.id); },
      async handoverAdd(note, d) { if (!String(note || '').trim()) throw new Error('Write the handover note first.'); const x = { id: hn++, note: note.trim(), shift_date: d || iso(Date.now()), done: false, by: me().display_name, author: actor, at: now() };
        handover.unshift(x); log('handover.added', { handover: x.id }); return x.id; },
      async handoverDone(id) { const x = handover.find((h) => h.id === id); if (!x || x.done) throw new Error('That handover note is already done.'); Object.assign(x, { done: true, done_by: me().display_name }); log('handover.done', { handover: id }); },
      async workQueue() { const P = permsOf(me()); const od = settings['support.overdue_hours']; const q = []; const co = (ws) => cos.find((c) => c.id === ws) || {};
        const add = (prio, kind, ws, issue, detail, owner, action, ref, at) => q.push({ prio, kind, workspace_id: ws, business: co(ws).name, country: co(ws).country, address: co(ws).address, issue, detail, owner: owner || nameOf(co(ws).hq_owner) || 'Unassigned', action, ref, at });
        if (P.includes('support.view')) tickets.filter((x) => ['new', 'waiting_us'].includes(x.status) && x.workspace_id && (!x.assignee || x.assignee === actor || (!x.first_reply_at && hours(x.created_at) > od)))
          .forEach((x) => add(1, 'complaint', x.workspace_id, !x.first_reply_at && hours(x.created_at) > od ? 'Overdue complaint' : 'Open complaint', x.subject, nameOf(x.assignee) || 'Unassigned', 'Reply', x.id, x.created_at));
        if (P.includes('offers.approve')) offers.filter((o) => o.status === 'waiting').forEach((o) => add(2, 'approval', o.workspace_id, 'Approval needed', `${o.days} free days · ${o.modules.map(modName).join(', ')}`, o.requested_by_name, 'Approve', o.id, o.created_at));
        if (P.includes('refunds.approve')) refunds.filter((f) => ['submitted', 'reviewing'].includes(f.status)).forEach((f) => add(3, 'refund', f.workspace_id, 'Refund waiting', `${f.currency} ${f.amount} · ${f.for_what}`, 'Finance', 'Review', f.id, f.created_at));
        myFollowUps().filter((f) => f.due).forEach((f) => add(4, 'follow_up', f.workspace_id, 'Follow-up due', f.body, me().display_name, 'Follow up', String(f.id), f.follow_up));
        const ending = []; cos.filter((c) => c.status === 'active').forEach((c) => { const l = demoLicence(c.id); const e = Object.entries(l.modules).filter(([, v]) => ['trial', 'active'].includes(v.status) && v.days_left != null && v.days_left <= 7);
          if (e.length) { const d = Math.min(...e.map(([, v]) => v.days_left)); ending.push(c.id); add(5, 'renewal', c.id, e.some(([, v]) => v.status === 'active') ? 'Renewal due' : 'Trial ending', `${d === 0 ? 'Ends today' : `Ends in ${d} day${d === 1 ? '' : 's'}`} · ${e.length === 7 ? 'every program' : e.map(([m]) => modName(m)).join(', ')}`, null, 'Extend', null, addDays(today(), d)); } });
        cos.filter((c) => c.status === 'active' && !c.pcs && hours(c.created_at) / 24 >= 3 && hours(c.created_at) / 24 <= 30).forEach((c) => add(6, 'signup', c.id, 'Stuck signup', `Signed up ${Math.round(hours(c.created_at) / 24)} days ago, no PC linked yet`, null, 'Message', null, c.created_at));
        const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
        return { counts: { new_signups: cos.filter((c) => new Date(c.created_at) >= monday).length, failed_payments: null, renewals_due: ending.length, open_complaints: P.includes('support.view') ? tickets.filter((x) => x.status !== 'done').length : null },
          queue: q.sort((a, b) => a.prio - b.prio || String(a.at).localeCompare(String(b.at))).slice(0, 60) }; },
      async signups(days) { need('customers.view'); return cos.filter((c) => hours(c.created_at) / 24 <= days).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((c, i) => { const l = demoLicence(c.id); const pcs = pcsOf(c);
        return { id: c.id, name: c.name, company_code: c.company_code, country: c.country, kind: c.kind, created_at: c.created_at, status: c.status, hq_owner_name: nameOf(c.hq_owner), owner_name: c.owner_name, owner_email: c.owner_email,
          email_verified: i % 7 !== 3, on_trial: Object.values(l.modules).some((v) => ['trial', 'active'].includes(v.status)), pc_linked: c.pcs > 0, program_used: pcs.some((d) => (d.programs || []).some((x) => x.id !== 'central')),
          paying: Object.values(l.modules).some((v) => v.status === 'active'), installed: [...new Set(pcs.flatMap((d) => (d.programs || []).map((x) => x.id)))], people: c.people, next_follow_up: nextFu(c.id) }; }); },
      async attention() { const P = permsOf(me()); const od = settings['support.overdue_hours']; const open = tickets.filter((x) => x.status !== 'done');
        const sup = P.includes('support.view'); const L = (c) => demoLicence(c.id);
        return { unassigned: sup ? open.filter((x) => !x.assignee).length : null, overdue: sup ? open.filter((x) => !x.first_reply_at && hours(x.created_at) > od).length : null,
          mine: sup ? open.filter((x) => ['new', 'waiting_us'].includes(x.status) && x.assignee === actor).length : null,
          approvals: P.includes('offers.approve') || P.includes('refunds.approve') ? offers.filter((o) => o.status === 'waiting').length + refunds.map(rowOf).filter((f) => f.waiting_second).length : null,
          refunds_waiting: P.includes('refunds.view') ? refunds.filter((f) => ['submitted', 'reviewing'].includes(f.status)).length : null,
          emails_failed: P.includes('emails.view') ? emails.filter((e) => ['failed', 'held'].includes(e.status)).length : null,
          trials_3d: cos.filter((c) => c.status === 'active' && !Object.values(L(c).modules).some((v) => v.status === 'active')).map((c) => { const tr = Object.entries(L(c).modules).filter(([, v]) => v.status === 'trial' && v.days_left <= 3);
            return tr.length ? { id: c.id, name: c.name, company_code: c.company_code, days_left: Math.min(...tr.map(([, v]) => v.days_left)), modules: tr.map(([m]) => m) } : null; }).filter(Boolean).sort((a, b) => a.days_left - b.days_left),
          follow_ups: myFollowUps() }; },
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
        return blocked('<h1>Turn on two-step sign-in first</h1><p>Riyeser HQ needs two-step sign-in. Open <a href="/link/">Riyeser Link</a>, click <b>🔐 Security</b> and turn it on, then come back and sign in again.</p>');
      }
      await loadMe();
      if (!S.me || !S.me.active) return blocked('<h1>Not Riyeser HQ staff</h1><p>This account isn\'t on the Riyeser HQ team. Ask a Riyeser HQ owner to add you.</p>');
      shell();
    } catch (err) { blocked(`<div class="err">${esc(plain(err))}</div>`); }
  }

  // ------------------------------------------------------------------ the shell
  // Every page HQ has (its address is #/<key>), and who can open it.
  const TABS = () => [['overview', 'Overview', can('overview.view')], ['companies', 'Customers', can('customers.view')], ['signups', 'Signups', can('customers.view')],
    ['licences', 'Licences', can('licences.view')], ['approvals', 'Approvals', can('refunds.approve', 'offers.approve')], ['refunds', 'Refunds', can('refunds.view')],
    ['payments', 'Invoices & payments', can('licences.view', 'refunds.view')], ['support', 'Support', can('support.view')], ['inbox', 'Team Inbox', can('overview.view')],
    ['inactive', 'Inactive accounts', can('customers.view', 'accounts.inactive')], ['health', 'System health', can('overview.view')], ['emails', 'Emails', can('emails.view')],
    ['downloads', 'Downloads', can('downloads.view')], ['reports', 'Reports', can('reports.view')], ['team', 'HQ team', true], ['history', 'History', can('audit.view')],
    ['settings', 'Settings', can('settings.manage')]].filter((x) => x[2]);
  const VIEWS = () => ({ overview, companies, signups, licences, approvals, refunds, payments, support, inbox, inactive, health, emails, downloads, reports, team, history, settings });
  // The left-hand menu: the same on every screen, showing only what this person's permissions allow.
  const NAV = [['Overview', '🏠', ['overview']], ['Customers', '👥', ['companies']], ['Signups', '🌱', ['signups']],
    ['Billing & Licences', '💳', ['licences', 'approvals', 'refunds', 'payments']], ['Support', '🎧', ['support']], ['Team Inbox', '💬', ['inbox']],
    ['Retention', '🔁', ['inactive']], ['System Operations', '🛠️', ['health', 'emails', 'downloads']], ['Reports', '📊', ['reports']], ['Admin', '⚙️', ['team', 'history', 'settings']]];
  const SOON = { inbox: 'soon', payments: 'phase 2' };
  function navHtml() {
    const ok = TABS(); const label = (k) => (ok.find((x) => x[0] === k) || [k, k])[1];
    return NAV.map(([name, icon, views]) => { const v = views.filter((k) => ok.some((x) => x[0] === k)); if (!v.length) return '';
      const head = `<button class="nv" data-tab="${v[0]}" data-sec="${views.join(' ')}"><span class="ni" aria-hidden="true">${icon}</span><span class="nl">${name}</span>${v.length === 1 && SOON[v[0]] ? `<em class="soon">${SOON[v[0]]}</em>` : ''}<span class="tb" data-badge="${v.length === 1 ? v[0] : ''}"></span></button>`;
      return v.length === 1 ? head : head + v.map((k) => `<button class="nv nsub" data-tab="${k}"><span class="nl">${label(k)}</span>${SOON[k] ? `<em class="soon">${SOON[k]}</em>` : ''}<span class="tb" data-badge="${k}"></span></button>`).join(''); }).join('');
  }
  function shell() {
    if (!TABS().some((x) => x[0] === S.tab)) S.tab = TABS()[0][0];
    const ini = initials(S.me.name);
    $app.innerHTML = `${DEMO ? `<div class="demo">Demo with sample data. Nothing here is real. <label>Acting as <select id="demoAs" aria-label="Demo staff member">${api.staffList().map((s) => `<option value="${s.user_id}"${s.display_name === S.me.name ? ' selected' : ''}>${esc(s.display_name)} (${esc(roleName(s.role))})</option>`).join('')}</select></label></div>` : ''}
      <div class="frame"><aside class="side"><div class="brand"><img src="../assets/logo-r.png" alt="">Riyeser HQ</div><nav class="snav" aria-label="HQ">${navHtml()}</nav>
        <p class="sfoot">Staff only · account information, never customers' messages or books</p></aside>
      <div class="mcol"><header class="mtop"><form id="gsearch" class="gsearch" role="search"><input name="q" placeholder="Search customers by name, Company ID, ABN, phone or email…" aria-label="Search customers"></form>
        <div class="me"><span class="av">${esc(ini)}</span><span class="mn">${esc(S.me.name)} <small>${esc(roleName(S.me.role))}</small></span><button id="so" class="btn sm">Sign out</button></div></header>
      <main id="main"></main></div></div>`;
    $app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { S.ticket = null; go('#/' + b.dataset.tab); });
    $app.querySelector('#so').onclick = async () => { await api.signOut(); gate(); };
    $app.querySelector('#gsearch').onsubmit = (e) => { e.preventDefault(); const q = String(new FormData(e.target).get('q') || '').trim();
      S.cl = { ...(S.cl || { f: {}, sort: 'created', desc: true, view: 'all' }), q, page: 1 }; e.target.reset(); go('#/companies'); };
    const das = $app.querySelector('#demoAs'); if (das) das.onchange = async () => { api.asStaff(das.value); await loadMe(); closePanel(); shell(); };
    route();
    badges();
  }
  const initials = (n) => String(n || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map((w) => w[0]).join('').toUpperCase() || '?';
  // Pages have addresses (#/companies, #/company/<id>/programs, …), so they can be linked to and Back works.
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  const showErr = (err) => { const m = document.getElementById('main'); if (m) m.innerHTML = missing(err) ? SWITCH_ON : `<div class="err">${esc(plain(err))}</div>`; };
  function route() {
    if (!document.getElementById('main')) return;
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const mark = (k) => $app.querySelectorAll('.snav [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.sec ? b.dataset.sec.split(' ').includes(k) : b.dataset.tab === k));
    const cm = /^company\/([^/]+)(?:\/([a-z]+))?/.exec(h);
    if (cm && can('customers.view')) { closePanel(); mark('companies'); companyPage(cm[1], cm[2]).catch(showErr); return; }
    const t = h.split('/')[0];
    if (TABS().some((x) => x[0] === t)) S.tab = t; else if (!TABS().some((x) => x[0] === S.tab)) S.tab = TABS()[0][0];
    mark(S.tab); closePanel(); VIEWS()[S.tab]().catch(showErr);
  }
  window.addEventListener('hashchange', () => { if (S.me && S.me.active) route(); });
  // Links to a business (data-goco, optionally data-cptab) and copy buttons (data-copy), anywhere in HQ.
  document.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-goco]'); if (a) { e.preventDefault(); openCompany(a.dataset.goco, a.dataset.cptab); return; }
    const c = e.target.closest('[data-copy]'); if (c) { e.preventDefault(); e.stopPropagation(); try { await navigator.clipboard.writeText(c.dataset.copy); flash('Copied.'); } catch { flash(c.dataset.copy); } }
  });
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

  // ------------------------------------------------------------------ Operations overview: counts, one work queue, system health, team handover
  const cityOf = (c) => { const city = String(c.address || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean).pop(); return [city && city !== c.country ? city : null, c.country].filter(Boolean).join(', '); };
  const avatar = (name, cls = '') => `<span class="avatar${cls ? ' ' + cls : ''}" aria-hidden="true">${esc(initials(name))}</span>`;
  const ISSUE = { complaint: 'blue', approval: 'violet', refund: 'warn', follow_up: 'warn', renewal: 'warn', signup: 'violet' };
  const card = (icon, cls, k, v, d) => `<div class="ccard"><span class="cic ${cls}" aria-hidden="true">${icon}</span><div><div class="k">${k}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div></div>`;
  async function overview() {
    main('<p class="muted">Loading…</p>');
    const soft = (p) => p.catch((e) => (missing(e) ? { missing: true } : null));
    const [o, wq, a, ho, off] = await Promise.all([api.overview().catch(() => null), soft(api.workQueue()), soft(api.attention()), soft(api.handover()),
      api.linkOffline ? api.linkOffline().catch(() => undefined) : undefined]);
    const cn = (wq && !wq.missing && wq.counts) || {}; const q = (wq && !wq.missing && wq.queue) || [];
    const wk = o ? (o.signups_by_week || []).map((w) => ({ ...w, label: new Date(w.week).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) })) : [];
    const m = main(`<h2>Operations overview</h2><p class="sub">Good to see you, ${esc(String(S.me.name || '').split(' ')[0])}. Account information only: HQ never sees customers' messages or books.</p>
      <div class="ops"><div class="opsl">
        <div class="ccards">${card('👤', 'blue', 'New signups', num(cn.new_signups ?? (o && o.companies_7d)), 'this week')}${card('💳', 'red', 'Failed payments', '0', 'payments not connected yet')}
          ${card('🔄', 'green', 'Renewals due', cn.renewals_due == null ? '—' : num(cn.renewals_due), 'trials and paid, next 7 days')}${card('⚠️', 'amber', 'Open complaints', cn.open_complaints == null ? '—' : num(cn.open_complaints), 'open support tickets')}</div>
        <div class="card" id="queueCard"><h3>Needs attention <small>· ${q.length ? `${q.length} item${q.length === 1 ? '' : 's'} for you` : 'nothing waiting'}</small></h3>
          ${wq && wq.missing ? '<p class="muted small">Run the latest <b>team-chat.sql</b> in Supabase (SQL Editor) to switch on the work queue.</p>'
            : q.length ? `<div class="scroll"><table class="tbl queue" id="queue"><tr><th>Customer</th><th>Issue</th><th>Owner</th><th>Next action</th></tr>
            ${q.map((x, i) => `<tr data-kind="${esc(x.kind)}"><td><div class="cust">${avatar(x.business, 'sq')}<div><button class="lnk" data-goco="${esc(x.workspace_id)}"><b>${esc(x.business || '')}</b></button><small>${esc(cityOf(x))}</small></div></div></td>
              <td><span class="pill ${ISSUE[x.kind] || ''}">${esc(x.issue)}</span><small>${esc(x.detail || '')}</small></td><td class="nowrap">${avatar(x.owner, 'sm')} ${esc(x.owner)}</td>
              <td><div class="nact"><button class="btn sm p" data-qi="${i}">${esc(x.action)}</button><details class="dd"><summary class="btn sm" aria-label="More actions">▾</summary><div class="ddm">
                <button data-qm="open" data-qi="${i}">Open customer</button><button data-qm="conversations" data-qi="${i}">Conversations</button>
                ${can('support.reply') ? `<button data-qm="message" data-qi="${i}">Send customer reply</button>` : ''}${can('customers.notes') ? `<button data-qm="call" data-qi="${i}">Log a call</button><button data-qm="note" data-qi="${i}">Add internal note</button>` : ''}
                ${can('licences.view') ? `<button data-qm="programs" data-qi="${i}">Programs and licence</button>` : ''}</div></details></div></td></tr>`).join('')}</table></div>`
            : '<p class="muted small">Nothing needs you right now. 🎉</p>'}</div>
        ${attentionHtml(a, off)}
        ${o ? `<h3 class="h3">Riyeser at a glance</h3><div class="tiles">${tile('Companies', num(o.companies), `+${num(o.companies_7d)} this week · +${num(o.companies_30d)} in 30 days`)}
          ${tile('People', num(o.people), 'in all companies')}${tile('Linked PCs', num(o.pcs), `${num(o.pcs_active_7d)} active this week`)}
          ${tile('Riyeser Link Plus', num(o.calls_paid) + ' paid', `${num(o.calls_trial)} on the free trial`)}</div>
        <div class="grid g2"><div class="card"><h3>New companies per week</h3>${columnChart(wk, (r) => r.label, (r) => Number(r.companies), 'companies')}</div>
          <div class="card"><h3>Riyeser Central versions in use <small>· PCs seen in 30 days</small></h3>${barList(o.versions || [], (r) => r.version, (r) => Number(r.pcs))}</div>
          <div class="card"><h3>Companies by country</h3>${barList(o.countries || [], (r) => r.country, (r) => Number(r.companies))}
            <p class="muted small" style="margin-top:12px">${num(o.requests_waiting)} join request${o.requests_waiting === 1 ? '' : 's'} waiting for a company admin · ${num(o.pcs_active_30d)} PCs active in 30 days</p></div></div>` : ''}
      </div><div class="opsr">${systemHealthCard(off, a)}${handoverCard(ho)}</div></div>`);
    wireAttention(m, overview); wireHealth(m);
    m.querySelectorAll('[data-qi]').forEach((b) => b.onclick = () => { const x = q[Number(b.dataset.qi)]; const mm = b.dataset.qm; b.closest('details') && b.closest('details').removeAttribute('open');
      if (mm) { if (['message', 'call', 'note'].includes(mm)) S.cpAfter = mm; return openCompany(x.workspace_id, mm === 'programs' ? 'programs' : ['open', 'note'].includes(mm) ? null : 'conversations'); }
      if (x.kind === 'complaint') { S.ticket = x.ref; return go('#/support'); }
      if (x.kind === 'approval') return go('#/approvals');
      if (x.kind === 'refund') return go('#/refunds');
      if (x.kind === 'renewal') return openCompany(x.workspace_id, 'programs');
      if (x.kind === 'signup') { S.cpAfter = 'message'; return openCompany(x.workspace_id, 'conversations'); }
      return openCompany(x.workspace_id, 'conversations'); });
    const hb = m.querySelector('#hoAdd'); if (hb) hb.onclick = addHandover;
    m.querySelectorAll('[data-hodone]').forEach((b) => b.onclick = async () => { try { await api.handoverDone(Number(b.dataset.hodone)); overview(); } catch (err) { alert(plain(err)); } });
  }
  // Backups and restore tests: the last run of each GitHub job (public repo, no token). Rate limits only make it say "couldn't check".
  async function ghRun(file) {
    const key = 'riyeser.hq.gh.' + file;
    try { const c = JSON.parse(sessionStorage.getItem(key) || 'null'); if (c && Date.now() - c.t < 10 * 60e3) return c.v; } catch { /* no storage */ }
    let v;
    try { const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${file}/runs?per_page=1`, { headers: { Accept: 'application/vnd.github+json' } });
      if (r.status === 404) v = { state: 'none' };
      else if (!r.ok) v = { state: 'unknown', note: r.status === 403 || r.status === 429 ? 'GitHub is busy (rate limit); try again later' : `GitHub said ${r.status}` };
      else { const run = ((await r.json()).workflow_runs || [])[0];
        v = !run ? { state: 'none' } : { state: run.status !== 'completed' ? 'running' : run.conclusion === 'success' ? 'ok' : 'failed', at: run.updated_at || run.run_started_at || run.created_at, url: run.html_url }; }
    } catch { v = { state: 'unknown', note: 'couldn\'t reach GitHub' }; }
    try { if (v.state !== 'unknown') sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch { /* fine */ }
    return v;
  }
  const whenFull = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  function systemHealthCard(off, a) {
    const link = off === undefined ? ['Per customer', '', 'Each business\'s Link Office (phones, last check-in) is on its customer page, Link tab'] : Array.isArray(off) && off.length ? [`${off.length} offline`, 'bad', off.slice(0, 3).map((x) => x.name || x.business).join(', ')]
      : ['Online', 'ok', 'Every Link Office has checked in'];
    const em = a && !a.missing ? a.emails_failed : null;
    return `<div class="card shealth" id="syshealth"><h3>System health</h3>
      <div class="hrow" data-gh="backup.yml" data-ok="Healthy" data-what="Last backup"><span class="hic" aria-hidden="true">🗄️</span><div><b>Backups</b><small class="ghw">Checking…</small></div><span class="pill">…</span></div>
      <div class="hrow" data-gh="restore-drill.yml" data-ok="Passed" data-what="Last restore test"><span class="hic" aria-hidden="true">🛡️</span><div><b>Last restore test</b><small class="ghw">Checking…</small></div><span class="pill">…</span></div>
      <div class="hrow" id="hLink"><span class="hic" aria-hidden="true">🔗</span><div><b>Riyeser Link Office</b><small>${esc(link[2])}</small></div><span class="pill ${link[1]}">${esc(link[0])}</span></div>
      ${em != null ? `<div class="hrow"><span class="hic" aria-hidden="true">✉️</span><div><b>Emails</b><small>${em ? `${num(em)} failed or held` : 'Nothing failed'}</small></div><span class="pill ${em ? 'warn' : 'ok'}">${em ? 'Check' : 'Healthy'}</span></div>` : ''}</div>`;
  }
  function wireHealth(root) {
    root.querySelectorAll('[data-gh]').forEach(async (row) => { const v = await ghRun(row.dataset.gh); const p = row.querySelector('.pill'); const w = row.querySelector('.ghw');
      const [l, c] = { ok: [row.dataset.ok, 'ok'], failed: ['Failed', 'bad'], running: ['Running', ''], none: ['Not set up yet', ''], unknown: ['Couldn\'t check', 'warn'] }[v.state];
      p.className = `pill ${c}`; p.textContent = l;
      w.innerHTML = v.at ? `${esc(row.dataset.what)}: ${v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(whenFull(v.at))}</a>` : esc(whenFull(v.at))}` : esc(v.note || (v.state === 'none' ? 'No runs yet' : '')); });
  }
  const SHIFTS = [[8, 16, 'Day (8 am – 4 pm)'], [16, 24, 'Evening (4 pm – midnight)'], [0, 8, 'Night (midnight – 8 am)']];
  function handoverCard(ho) {
    const h = new Date().getHours(); const i = SHIFTS.findIndex(([a, b]) => h >= a && h < b); const list = Array.isArray(ho) ? ho : [];
    return `<div class="card handover" id="handover"><h3>Team handover</h3>
      <div class="hrow"><span class="hic" aria-hidden="true">📅</span><div><b>Current shift</b><small>${SHIFTS[i][2]}</small></div></div>
      <div class="hrow"><span class="hic" aria-hidden="true">👥</span><div><b>Handover to</b><small>${SHIFTS[(i + 1) % 3][2]}</small></div></div>
      <div class="hrow hrtop"><span class="hic" aria-hidden="true">📝</span><div style="flex:1;min-width:0"><b>Key notes</b>
        ${ho && ho.missing ? '<small>Run the latest team-chat.sql to switch this on.</small>' : list.filter((x) => !x.done).length ? `<ul class="hnotes">${list.filter((x) => !x.done).map((x) => `<li>${esc(x.note)} <small>${esc(x.by || '')} · ${ago(x.at)}</small> <button class="lnk" data-hodone="${esc(x.id)}">Done</button></li>`).join('')}</ul>` : '<small>Nothing handed over yet.</small>'}</div></div>
      ${ho && ho.missing ? '' : '<button class="btn w" id="hoAdd">Add handover note</button>'}</div>`;
  }
  function addHandover() {
    dlg(`<h3>Add handover note</h3><p class="muted small">For whoever is on next. Every note is kept in the HQ history.</p><form id="hof"><label class="f"><span>Note</span><textarea name="note" rows="3" required maxlength="1000" placeholder="e.g. Harbour Cafe complaint: update the customer after 3 pm"></textarea></label>
      <label class="f"><span>Shift date</span><input type="date" name="day" value="${today()}"></label><div id="hoerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Add note</button></div></form>`, (d, close) => {
      d.querySelector('#hof').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        try { await api.handoverAdd(String(f.get('note')).trim(), String(f.get('day') || '') || null); close(); flash('Handover note added.'); overview(); } catch (err) { d.querySelector('#hoerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
  }

  // ------------------------------------------------------------------ Signups and onboarding
  const STAGES = [['signed_up', 'Signed up'], ['email_verified', 'Email verified'], ['trial', 'Trial'], ['set_up', 'Set up'], ['activated', 'Activated']];
  const BLOCK = { email_verified: 'Waiting for them to confirm their email', trial: 'No trial running: unlock a program', set_up: 'No PC linked yet: help them install Riyeser Central', activated: 'No program used yet on a linked PC' };
  const stagesOf = (x) => ({ signed_up: true, email_verified: !!x.email_verified, trial: !!(x.on_trial || x.paying), set_up: !!x.pc_linked, activated: !!(x.program_used || x.paying) });
  async function signups() {
    S.sd = S.sd || 30;
    const m = main(`<h2>Signups</h2><p class="sub">New businesses from sign-up to go-live: signed up → email verified → trial → set up → activated. Each shows the step blocking go-live and its Riyeser owner.
      Product checklists only show what Riyeser can see: anything the programs don't report yet says so, rather than guessing.</p>
      <div class="chips" id="sranges">${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(([n, l]) => `<button class="chip${S.sd === n ? ' on' : ''}" data-sd="${n}">${l}</button>`).join('')}
        <label class="opt small" style="margin-left:6px"><input type="checkbox" id="stuck"${S.sStuck ? ' checked' : ''}> Not live yet only</label></div><div id="sl"><p class="muted">Loading…</p></div>`);
    m.querySelectorAll('[data-sd]').forEach((b) => b.onclick = () => { S.sd = Number(b.dataset.sd); signups(); });
    m.querySelector('#stuck').onchange = (e) => { S.sStuck = e.target.checked; signups(); };
    const all = await api.signups(S.sd); const rows = all.filter((x) => !S.sStuck || !stagesOf(x).activated);
    const done = (k) => all.filter((x) => stagesOf(x)[k]).length;
    const check = (v) => (v === true ? '<span class="ck ok">✓</span>' : v === false ? '<span class="ck no">✗</span>' : '<span class="ck un">?</span>');
    const has = (x, ids) => ids.some((id) => (x.installed || []).includes(id));
    const lists = (x) => [['POS', ['pos'], [['Outlet set up', null], ['Products added', null], ['Test sale', null]]],
      ['Riyeser Link', ['team'], [['Extensions registered', null], ['Test call', null]]], ['Accounting', ['accounting-basics', 'accounting'], [['First invoice', null]]]]
      .map(([n, ids, items]) => `<div class="chk"><b>${n}</b><div>${check(has(x, ids))} Installed on a PC</div>${items.map(([l]) => `<div>${check(null)} ${l} <small class="muted">${n === 'Riyeser Link' ? 'unknown until Link Office reports it' : 'not reported yet'}</small></div>`).join('')}</div>`).join('');
    m.querySelector('#sl').innerHTML = `<div class="tiles">${STAGES.slice(1).map(([k, l]) => tile(l, num(done(k)), `of ${num(all.length)} sign-ups (${all.length ? Math.round((done(k) / all.length) * 100) : 0}%)`)).join('')}</div>
      <div class="card scroll"><table class="tbl sutbl" id="sutbl"><tr><th>Business</th>${STAGES.map(([, l]) => `<th class="c">${l}</th>`).join('')}<th>Blocking go-live</th><th>Owner</th><th></th></tr>
      ${rows.map((x) => { const st = stagesOf(x); const blk = STAGES.find(([k]) => !st[k]);
        return `<tr data-su="${esc(x.id)}"><td><button class="lnk" data-goco="${esc(x.id)}"><b>${esc(x.name)}</b></button><small>${esc(x.owner_name || '')}${x.owner_email ? ` · ${esc(x.owner_email)}` : ''} · ${ago(x.created_at)}</small></td>
          ${STAGES.map(([k]) => `<td class="c">${check(st[k])}</td>`).join('')}<td>${blk ? `<span class="pill warn">${esc(blk[1])}</span><small>${esc(BLOCK[blk[0]] || '')}</small>` : '<span class="pill ok">Live</span>'}</td>
          <td class="nowrap">${x.hq_owner_name ? `${avatar(x.hq_owner_name, 'sm')} ${esc(x.hq_owner_name)}` : '<span class="muted">Unassigned</span>'}${x.next_follow_up ? `<small>follow up ${day(x.next_follow_up.date)}</small>` : ''}</td>
          <td><details class="dd chkdd"><summary class="btn sm">Checklists</summary><div class="ddm wide">${lists(x)}</div></details></td></tr>`; }).join('') || `<tr><td colspan="9" class="muted">No sign-ups in this range.</td></tr>`}</table></div>`;
  }

  // ------------------------------------------------------------------ System Operations → System health; pages still to come
  async function health() {
    const soft = (p) => p.catch((e) => (missing(e) ? { missing: true } : null));
    const [a, off] = await Promise.all([soft(api.attention()), api.linkOffline ? api.linkOffline().catch(() => undefined) : undefined]);
    const m = main(`<h2>System health</h2><p class="sub">Backups, restore tests, Riyeser Link Office and email delivery. Backups and restore tests are the nightly GitHub jobs (see ops/RUNBOOK.md).</p>
      <div class="grid g2">${systemHealthCard(off, a)}<div class="card"><h3>Also here</h3><div class="row">${can('emails.view') ? '<button class="btn" data-tab2="emails">✉️ Emails</button>' : ''}
        ${can('downloads.view') ? '<button class="btn" data-tab2="downloads">⬇ Downloads</button>' : ''}<a class="btn" href="https://github.com/${REPO}/actions" target="_blank" rel="noopener">GitHub jobs</a></div>
        <p class="muted small">A restore is always tested in a separate place first; a live restore needs an HQ owner. Failed jobs and payment updates show here once payments are connected (phase 2).</p></div></div>`);
    wireHealth(m); m.querySelectorAll('[data-tab2]').forEach((b) => b.onclick = () => go('#/' + b.dataset.tab2));
  }
  const soon = (title, what, when) => `<h2>${title}</h2><div class="card soonc"><p><b>${when}.</b> ${what}</p><p class="muted small">See ops/HQ-DESIGN.md for the plan.</p></div>`;
  async function payments() { main(soon('Invoices & payments', 'Invoices (open, overdue, paid), payment states (pending, approved, settled, declined, refunded, disputed), retries, payment links and reconciliation arrive once a payment provider is connected. Until then, licences are managed by hand under Licences, and refunds under Refunds.', 'Coming with payments (phase 2)')); }
  async function inbox() { main(soon('Team Inbox', 'Internal discussions linked to a customer, case or invoice, handovers that become tasks with an owner and due time, and commitments saved to the customer timeline. For now, use the Team handover on the Overview and internal notes on each customer page.', 'Coming soon')); }
  async function settings() { await team(); const el = document.getElementById('settings'); if (el) el.scrollIntoView({ block: 'start' }); }
  // "Needs attention": only what this person can act on. Each item opens the right page.
  function attentionHtml(a, off) {
    if (!a) return '';
    if (a.missing) return '<div class="card attn"><h3>Queue at a glance</h3><p class="muted small">Run the latest <b>team-chat.sql</b> in Supabase (SQL Editor) to switch this on.</p></div>';
    const items = [[a.unassigned, 'Unassigned tickets', 'support:unassigned'], [a.overdue, 'Overdue tickets', 'support:overdue', 'bad'], [a.mine, 'My open tickets', 'support:mine'],
      [a.approvals, 'Approvals waiting', 'approvals'], [a.refunds_waiting, 'Refunds waiting', 'refunds'], [(a.trials_3d || []).length, 'Trials ending in 3 days', 'trials'],
      [(a.follow_ups || []).filter((f) => f.due).length, 'My follow-ups due', 'followups'], [a.emails_failed, 'Failed or held emails', 'emails', 'bad'],
      [Array.isArray(off) ? off.length : null, 'Link Offices offline', 'linkoff', 'bad']].filter((x) => x[0] != null);
    const fu = a.follow_ups || [];
    return `<div class="card attn" id="attn"><h3>Queue at a glance <small>· overdue and unassigned work, for ${esc(S.me.name)}</small></h3>
      <div class="alist">${items.map(([n, l, g, bad]) => `<button class="aitem${n ? ` on${bad ? ' bad' : ''}` : ''}" data-go="${g}"><b>${num(n)}</b><span>${l}</span></button>`).join('')}</div>
      ${(a.trials_3d || []).length ? `<div class="alrow" id="attnTrials"><h4>Trials ending in 3 days</h4>${a.trials_3d.slice(0, 12).map((t) => `<button class="lnk" data-goco="${esc(t.id)}" data-cptab="programs">${esc(t.name)} <small>${t.days_left === 0 ? 'today' : `in ${t.days_left} day${t.days_left === 1 ? '' : 's'}`}</small></button>`).join('')}</div>` : ''}
      ${Array.isArray(off) && off.length ? `<div class="alrow"><h4>Link Offices offline</h4>${off.slice(0, 12).map((t) => `<button class="lnk" data-goco="${esc(t.id || t.workspace_id)}" data-cptab="link">${esc(t.name || t.business || 'A business')}</button>`).join('')}</div>` : ''}
      </div>
      <div class="card" id="myfu" style="margin-bottom:14px"><h3>My follow-ups <small>· ${fu.length ? `${fu.filter((f) => f.due).length} due` : 'none yet'}</small></h3>${followUpList(fu)}</div>`;
  }
  function followUpList(fu, here) {
    if (!fu || !fu.length) return '<p class="muted small">Nothing to follow up. Add a follow-up date when you log a call or add a note.</p>';
    return `<div class="fulist">${fu.map((f) => `<div class="fu${f.overdue ? ' late' : f.due ? ' due' : ''}${here && f.workspace_id === here ? ' here' : ''}"><span class="fud">${f.overdue ? 'Overdue · ' : f.due ? 'Today · ' : ''}${day(f.follow_up)}</span>
      <button class="lnk" data-goco="${esc(f.workspace_id)}" data-cptab="conversations"><b>${esc(f.business || '')}</b></button><span class="small">${f.kind === 'call' ? '📞 ' : '📝 '}${esc(f.body)}${f.contact ? ` <span class="muted">· ${esc(f.contact)}</span>` : ''}</span>
      <button class="btn sm" data-fudone="${esc(f.id)}">Done</button></div>`).join('')}</div>`;
  }
  function wireAttention(root, again) {
    root.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => { const [t, box] = b.dataset.go.split(':');
      if (t === 'support') { S.box = box; S.ticket = null; return go('#/support'); }
      if (t === 'trials' || t === 'followups' || t === 'linkoff') { const el = root.querySelector(t === 'trials' ? '#attnTrials' : t === 'followups' ? '#myfu' : '.alrow:last-child'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return null; }
      return go('#/' + t); });
    root.querySelectorAll('[data-fudone]').forEach((b) => b.onclick = async () => { try { await api.followUpDone(Number(b.dataset.fudone)); flash('Follow-up ticked off.'); again(); } catch (err) { alert(plain(err)); } });
  }

  // ------------------------------------------------------------------ companies: filters, sorting, pages (50 at a time, from the database)
  const CVIEWS = [['all', 'All businesses', {}, 'created', true], ['trials_week', 'Trials ending this week', { plan: 'trial', trial_days: 7 }, 'trial', false],
    ['paying', 'Paying customers', { plan: 'paid' }, 'plan', true], ['follow_up', 'Needs follow-up', { follow_up: true }, 'last_active', true], ['mine', 'My customers', { mine: true }, 'name', false]];
  const CCOLS = [['name', 'Business'], ['owner', 'Owner'], ['phone', 'Phone'], ['plan', 'Plan'], ['trial', 'Trial ends'], ['last_active', 'Last active'], ['tickets', 'Tickets'], ['status', 'Status']];
  const SORT_DESC_FIRST = { plan: true, last_active: false, tickets: true, created: true };
  const PER_PAGE = 50;
  const planCell = (c) => (c.paid_n == null ? (c.calls_paid_until && new Date(c.calls_paid_until) > new Date() ? '<span class="pill ok">Link Plus paid</span>' : '<span class="pill">—</span>')
    : c.paid_n > 0 ? `<span class="pill ok">${c.paid_n} paid</span><small>${esc((c.paid || []).map(modName).join(', '))}</small>`
    : c.trial_n > 0 ? '<span class="pill">Trial</span>' : '<span class="pill">Free</span>');
  async function companies() {
    const st = S.cl = S.cl || { q: '', f: {}, sort: 'created', desc: true, page: 1, view: 'all' };
    const f = st.f; const opt = (list, val) => list.map(([k, l]) => `<option value="${k}"${String(val ?? '') === String(k) ? ' selected' : ''}>${l}</option>`).join('');
    const m = main(`<h2>Companies</h2><p class="sub">Every business using Riyeser online. Search by name, Company ID, ABN/TIN, phone, or an owner's name or email. Click a business to open its page.</p>
      <div class="chips" id="views">${CVIEWS.map(([k, l]) => `<button class="chip${st.view === k ? ' on' : ''}" data-view="${k}">${l}</button>`).join('')}</div>
      <form class="search" id="sf"><input name="q" value="${esc(st.q)}" placeholder="Search…" aria-label="Search companies">
        <select name="st" aria-label="Status">${opt([['all', 'Any status'], ['active', 'Open'], ['suspended', 'Suspended'], ['closed', 'Closed']], f.status || 'all')}</select>
        <button class="btn">Search</button></form>
      <form class="card filters cfilters" id="cf">
        <label class="f"><span>Plan</span><select name="plan">${opt([['', 'Any'], ['paid', 'Any paid'], ['trial', 'Trial only'], ['free', 'Free (nothing on)']], f.plan)}</select></label>
        <label class="f"><span>Trial ends</span><select name="trial_days">${opt([['', 'Any time'], ['7', 'In 7 days'], ['14', 'In 14 days'], ['30', 'In 30 days']], f.trial_days)}</select></label>
        <label class="f"><span>Country</span><select name="country"><option value="">Any</option>${(S.clCountries || []).map((c) => `<option${f.country === c.country ? ' selected' : ''}>${esc(c.country)}</option>`).join('')}</select></label>
        <label class="f"><span>Inactive for</span><select name="inactive_days">${opt([['', 'Any'], ['30', '30+ days'], ['60', '60+ days'], ['90', '90+ days']], f.inactive_days)}</select></label>
        <div class="row cfchecks"><label class="opt"><input type="checkbox" name="open_tickets"${f.open_tickets ? ' checked' : ''}> Has open tickets</label>
          <label class="opt"><input type="checkbox" name="follow_up"${f.follow_up ? ' checked' : ''}> Needs follow-up</label><label class="opt"><input type="checkbox" name="mine"${f.mine ? ' checked' : ''}> My customers</label></div>
        <div class="row"><button type="button" class="btn sm" id="cclear">Clear filters</button><button type="button" class="btn sm" id="ccsv">⬇ Download CSV</button></div></form>
      <div id="cl" class="card scroll"><p class="muted">Loading…</p></div><div id="pager" class="pager"></div>`);
    const read = () => { const a = new FormData(m.querySelector('#sf')); const b = new FormData(m.querySelector('#cf'));
      const nf = { status: a.get('st') === 'all' ? '' : String(a.get('st')), plan: String(b.get('plan') || ''), trial_days: String(b.get('trial_days') || ''), country: String(b.get('country') || ''),
        inactive_days: String(b.get('inactive_days') || ''), open_tickets: !!b.get('open_tickets'), follow_up: !!b.get('follow_up'), mine: !!b.get('mine') };
      Object.keys(nf).forEach((k) => { if (!nf[k]) delete nf[k]; }); return { q: String(a.get('q') || '').trim(), f: nf }; };
    const apply = () => { const x = read(); Object.assign(st, x, { page: 1, view: viewOf(x.f) }); companies(); };
    m.querySelector('#sf').onsubmit = (e) => { e.preventDefault(); apply(); };
    m.querySelector('#sf select').onchange = apply;
    m.querySelectorAll('#cf select, #cf input').forEach((x) => { x.onchange = apply; });
    m.querySelector('#cclear').onclick = () => { Object.assign(st, { f: {}, page: 1, view: 'all', sort: 'created', desc: true }); companies(); };
    m.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { const v = CVIEWS.find((x) => x[0] === b.dataset.view);
      Object.assign(st, { f: { ...v[2] }, sort: v[3], desc: v[4], page: 1, view: v[0] }); companies(); });
    m.querySelector('#ccsv').onclick = () => exportCompanies().catch((err) => alert(plain(err)));
    const r = await api.companiesPage({ q: st.q, f: clean(st.f), sort: st.sort, desc: st.desc, page: st.page, per: PER_PAGE });
    if (!document.body.contains(m.querySelector('#cl'))) return;
    S.companies = r.rows || []; if (r.countries && !(S.clCountries || []).length) { S.clCountries = r.countries; const cs = m.querySelector('#cf [name=country]');
      cs.innerHTML = `<option value="">Any</option>${r.countries.map((c) => `<option${f.country === c.country ? ' selected' : ''}>${esc(c.country)}</option>`).join('')}`; }
    if (r.old) m.querySelector('#cf').insertAdjacentHTML('afterbegin', '<p class="muted small" style="grid-column:1/-1">Filters, sorting and pages switch on once the latest <b>team-chat.sql</b> is run in Supabase (SQL Editor).</p>');
    const arrow = (k) => (st.sort === k ? (st.desc ? ' ↓' : ' ↑') : '');
    const rows = r.rows || [];
    m.querySelector('#cl').innerHTML = rows.length ? `<table class="tbl ctbl"><tr>${CCOLS.map(([k, l]) => `<th${k === 'tickets' ? ' class="n"' : ''}><button class="sortb${st.sort === k ? ' on' : ''}" data-sort="${k}">${l}${arrow(k)}</button></th>`).join('')}<th>Riyeser owner</th><th>Follow-up</th></tr>
      ${rows.map((c) => `<tr class="click" data-co="${esc(c.id)}"><td><b>${esc(c.name)}</b><small class="code">${esc(c.company_code || '')}</small></td>
        <td>${esc(c.owner_name || '')}<small>${esc(c.owner_email || '')}</small></td><td class="nowrap">${esc(c.phone || '')}</td><td>${planCell(c)}</td>
        <td>${c.trial_days != null ? `${daysPill(c.trial_days)}<small>${day(c.trial_end)}</small>` : c.trial_days_left != null && c.paid_n == null ? `${daysPill(c.trial_days_left)}` : '<span class="muted">—</span>'}</td>
        <td>${ago(c.last_active_at || c.last_seen)}</td><td class="n">${c.tickets_open != null ? (c.tickets_open ? `<span class="pill warn">${num(c.tickets_open)}</span>` : '0') : ''}</td>
        <td>${pill(BSTAT, c.status || 'active')}</td><td class="nowrap">${c.hq_owner_name ? esc(c.hq_owner_name) : '<span class="muted">—</span>'}</td>
        <td class="nowrap">${c.next_follow_up ? `<span class="pill${c.next_follow_up <= today() ? ' warn' : ''}">${day(c.next_follow_up)}</span>` : '<span class="muted">—</span>'}</td></tr>`).join('')}</table>`
      : '<p class="muted">No companies match.</p>';
    const total = Number(r.total || 0); const from = total ? (st.page - 1) * PER_PAGE + 1 : 0; const to = Math.min(total, (st.page - 1) * PER_PAGE + rows.length);
    const pages = Math.max(1, Math.ceil(total / (r.old ? Math.max(1, total) : PER_PAGE)));
    m.querySelector('#pager').innerHTML = `<span id="ctotal">${num(from)}–${num(to)} of ${num(total)} business${total === 1 ? '' : 'es'}</span>
      <button class="btn sm" data-page="prev"${st.page <= 1 ? ' disabled' : ''}>← Previous</button><span class="muted small">Page ${num(st.page)} of ${num(pages)}</span>
      <button class="btn sm" data-page="next"${st.page >= pages ? ' disabled' : ''}>Next →</button>`;
    m.querySelectorAll('[data-page]').forEach((b) => b.onclick = () => { st.page += b.dataset.page === 'next' ? 1 : -1; companies(); window.scrollTo(0, 0); });
    m.querySelectorAll('[data-sort]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); const k = b.dataset.sort;
      if (st.sort === k) st.desc = !st.desc; else { st.sort = k; st.desc = !!SORT_DESC_FIRST[k]; } st.page = 1; companies(); });
    m.querySelectorAll('tr[data-co]').forEach((x) => x.onclick = () => openCompany(x.dataset.co));
  }
  const clean = (f) => Object.fromEntries(Object.entries(f || {}).filter(([, v]) => v !== '' && v != null && v !== false).map(([k, v]) => [k, /^\d+$/.test(String(v)) ? Number(v) : v]));
  const viewOf = (f) => { const cf = JSON.stringify(clean(f)); const v = CVIEWS.find((x) => JSON.stringify(clean(x[2])) === cf); return v ? v[0] : 'custom'; };
  async function exportCompanies() {
    const st = S.cl; let rows = []; let page = 1;
    for (;;) { const r = await api.companiesPage({ q: st.q, f: clean(st.f), sort: st.sort, desc: st.desc, page, per: 5000, exp: true });
      rows = rows.concat(r.rows || []); if (r.old || !(r.rows || []).length || rows.length >= Number(r.total || 0) || page >= 10) break; page += 1; }
    csvFile('companies', ['Business', 'Company ID', 'Owner', 'Owner email', 'Phone', 'Country', 'Status', 'Kind', 'Paid programs', 'Trial ends', 'Trial days left', 'Last active', 'Open tickets', 'People', 'PCs', 'Joined', 'Riyeser owner', 'Next follow-up'],
      rows.map((c) => [c.name, c.company_code, c.owner_name, c.owner_email, c.phone, c.country, c.status, c.kind === 'personal' ? 'Just me' : 'Business', (c.paid || []).map(modName).join('; '),
        c.trial_end || '', c.trial_days ?? '', c.last_active_at || '', c.tickets_open ?? '', c.people ?? '', c.pcs ?? '', c.created_at, c.hq_owner_name || '', c.next_follow_up || '']));
    flash(`Downloaded ${num(rows.length)} business${rows.length === 1 ? '' : 'es'}.`);
  }
  function csvFile(name, header, rows) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [header.map(q).join(',')].concat(rows.map((r) => r.map(q).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `riyeser-hq-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function closePanel() { document.querySelectorAll('.modal').forEach((x) => x.remove()); }
  const HIST_ACTS = { 'customer.viewed': 'opened the company', 'company.viewed': 'opened the company', 'note.added': 'added a note', 'calls.paid_until': 'changed Riyeser Link Plus paid-until',
    'licence.module': 'changed a licence', 'licence.plan': 'changed a plan', 'staff.added': 'added HQ staff', 'staff.changed': 'changed HQ staff', 'staff.permissions': 'changed HQ permissions',
    'staff.owner_made': 'made an HQ owner (SQL Editor)', 'ticket.viewed': 'opened a ticket', 'ticket.replied': 'replied to a ticket', 'ticket.note': 'added an internal note',
    'ticket.status': 'changed a ticket\'s status', 'ticket.priority': 'changed a ticket\'s priority', 'ticket.assigned': 'assigned a ticket', 'ticket.escalated': 'escalated a ticket',
    'ticket.deescalated': 'de-escalated a ticket', 'saved_reply.saved': 'saved a reply', 'saved_reply.retired': 'removed a saved reply', 'business.edited': 'edited business details',
    'people.reset_2fa': 'reset two-step sign-in', 'people.change_owner': 'changed the owner', 'business.closed': 'closed a business', 'business.suspended': 'suspended a business',
    'business.reopened': 'reopened a business', 'business.duplicate': 'closed as a duplicate', 'business.closed_inactive': 'closed (inactive 12 months)', 'accounts.removed': 'removed personal details of closed accounts',
    'refund.created': 'entered a refund request', 'refund.reviewing': 'started reviewing a refund', 'refund.approved': 'approved a refund', 'refund.partly_approved': 'partly approved a refund',
    'refund.declined': 'declined a refund', 'refund.second_approved': 'gave the second approval', 'refund.paid': 'marked a refund paid', 'offer.applied': 'gave a free period',
    'offer.requested': 'asked to give a free period', 'offer.approved': 'approved a free period', 'offer.declined': 'declined a free period', 'email.resend': 'sent an email again',
    'settings.changed': 'changed an HQ setting', 'audit.exported': 'downloaded the HQ history', 'sweep.support': 'support sweep (automatic)', 'sweep.inactivity': 'inactivity sweep (automatic)',
    'ticket.started': 'messaged the customer', 'call.logged': 'logged a call', 'note.pinned': 'pinned a note', 'note.unpinned': 'unpinned a note', 'follow_up.done': 'ticked off a follow-up',
    'licence.unlocked': 'unlocked a program', 'licence.paid_until': 'marked a program paid', 'licence.paused': 'paused a program', 'licence.cancelled': 'cancelled a program',
    'customers.exported': 'downloaded the businesses list', 'customer.owner_set': 'set the Riyeser owner', 'handover.added': 'added a handover note', 'handover.done': 'ticked off a handover note' };
  const histExtra = (h) => { const d = h.details || {}; return [h.ticket || d.ticket, d.refund, d.offer, d.module ? modName(d.module) : null, d.status, d.reason, d.email, d.until, d.role, LEVELS[d.to] ? 'to ' + LEVELS[d.to] : null].filter(Boolean).join(' · '); };

  // ------------------------------------------------------------------ the customer page (#/company/<id>/<tab>)
  const CPTABS = [['overview', 'Overview'], ['programs', 'Programs'], ['pcs', 'PCs & programs'], ['people', 'People'], ['conversations', 'Conversations'],
    ['money', 'Money'], ['history', 'History'], ['link', 'Link']];
  const FREE_PROGRAMS = [['central', 'Riyeser Central'], ['invoices', 'Invoices'], ['pdf', 'PDF'], ['desk', 'Desk Assistant'], ['team', 'Riyeser Link']];
  // Riyeser Central's name for each program (desktop/src/central/updates.js)
  const MOD_APP = { basic: 'accounting-basics', plus: 'accounting', payroll: 'payroll', pos: 'pos', bookings: 'bookings', as_built: 'services', calls: 'team' };
  const APP_NAME = { central: 'Central', 'accounting-basics': 'Accounting Basics', accounting: 'Accounting Plus', payroll: 'Payroll', pos: 'POS', bookings: 'Bookings',
    services: 'As Built', team: 'Riyeser Link', linkoffice: 'Link Office', invoices: 'Invoices', pdf: 'PDF', desk: 'Desk Assistant' };
  const QWHY_PAID = [['payment', 'Payment received'], ['customer_asked', 'The customer asked'], ['non_payment', 'Not paid'], ['correction', 'Fixing a mistake'], ['other', 'Other']];
  const daysPill = (n) => (n == null ? '' : `<span class="pill ${n <= 7 ? 'bad' : n <= 30 ? 'warn' : 'ok'}">${n <= 0 ? 'today' : `${num(n)} day${n === 1 ? '' : 's'}`}</span>`);
  const daysSince = (t) => (t ? Math.floor((Date.now() - new Date(t)) / 864e5) : null);
  const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
  const plusDays = (d, n) => isoDay(new Date(String(d).slice(0, 10) + 'T00:00:00Z').getTime() + n * 864e5);
  const today = () => isoDay(Date.now());
  const modState = (v) => (v.status === 'active' ? ['Paid', 'ok'] : v.status === 'trial' ? ['Trial', v.days_left <= 14 ? 'warn' : ''] : v.status === 'cancelled' ? ['Cancelled', v.active ? 'warn' : 'bad']
    : v.status === 'closed' ? ['Business closed', 'bad'] : ['Ended', 'bad']);
  const trialish = (v) => v.status === 'trial' || (v.status === 'ended' && !v.paid_until);

  function openCompany(id, tab) {
    if (!/^#\/company\//.test(location.hash)) S.cpFrom = location.hash || '#/companies';
    go(`#/company/${encodeURIComponent(id)}${tab ? '/' + tab : ''}`);
  }
  async function companyPage(id, tab) {
    S.cpId = id; S.cpTab = CPTABS.some((x) => x[0] === tab) ? tab : 'overview';
    main('<p class="muted">Loading…</p>');
    const [c, link, set] = await Promise.all([api.companyPage(id), api.companyLink ? api.companyLink(id).catch(() => null) : null,
      S.limitDays ? null : api.settings().catch(() => null)]);
    if (S.cpId !== id || !document.getElementById('main')) return;
    if (set) S.limitDays = Number(set['offers.self_limit_days']) || 31;
    S.cp = c; S.cpLink = link; drawCompany();
  }
  async function reloadCompany() { const c = await api.companyPage(S.cpId); S.cp = c; drawCompany(); }
  // What staff need to know at a glance.
  function healthChips(c) {
    const out = []; const L = c.licence; const p = c.profile;
    if (p.status && p.status !== 'active') out.push(['bad', p.status === 'closed' ? 'Closed' : 'Suspended']);
    if (L && p.status === 'active') {
      const trials = MODULES.map(([m]) => L.modules[m]).filter((v) => v.status === 'trial'); const paid = MODULES.some(([m]) => L.modules[m].status === 'active');
      const soon = trials.length ? Math.min(...trials.map((v) => v.days_left)) : null;
      if (soon != null && soon <= 14 && !paid) out.push([soon <= 3 ? 'bad' : 'warn', soon <= 0 ? 'Trial ends today' : `Trial ends in ${soon} day${soon === 1 ? '' : 's'}`]);
      else if (soon != null && soon <= 14) out.push(['warn', `A trial ends in ${soon} day${soon === 1 ? '' : 's'}`]);
      if (MODULES.some(([m]) => L.modules[m].status === 'ended' && L.modules[m].paid_until)) out.push(['bad', 'Payment overdue']);
    }
    const last = (c.people || []).map((x) => x.last_sign_in).filter(Boolean).sort().pop() || p.last_active_at; const d = daysSince(last);
    if (d == null) out.push(['warn', 'Never signed in']); else if (d >= 30) out.push([d >= 90 ? 'bad' : 'warn', `No sign-in for ${d} days`]);
    if (c.tickets_open) out.push([c.tickets_overdue ? 'bad' : 'warn', `${c.tickets_open} open ticket${c.tickets_open === 1 ? '' : 's'}${c.tickets_overdue ? ` · ${c.tickets_overdue} overdue` : ''}`]);
    const fu = (c.notes || []).filter((n) => n.follow_up && !n.follow_up_done_at && n.follow_up <= today()).length; if (fu) out.push(['warn', `Follow-up due`]);
    const rw = (((c.extra || {}).refunds) || []).filter((f) => ['submitted', 'reviewing'].includes(f.status)).length; if (rw) out.push(['warn', `${rw} refund${rw === 1 ? '' : 's'} waiting`]);
    if (linkOffline(S.cpLink)) out.push(['bad', 'Link Office offline']);
    if (!out.length) out.push(['ok', 'All good']);
    return out.map(([cl, l]) => `<span class="pill ${cl}">${esc(l)}</span>`).join('');
  }
  function planSummary(c) {
    const L = c.licence; if (!L) return '';
    const by = (st) => MODULES.filter(([m]) => L.modules[m].status === st).map(([, n]) => n);
    const paid = by('active'); const trial = by('trial'); const soon = MODULES.map(([m]) => L.modules[m]).filter((v) => v.status === 'trial').map((v) => v.days_left);
    return `<div class="cpplan"><b>${paid.length ? `Paid: ${esc(paid.join(', '))}` : 'Nothing paid yet'}</b>${trial.length ? ` · Trial: ${trial.length === 7 ? 'every program' : esc(trial.join(', '))} (${Math.min(...soon)} days left)` : ''}
      ${c.monthly != null ? ` · <span title="List price estimate until payments are connected">${money(c.monthly)} a month (estimate)</span>` : ''}${L.seats ? ` · ${L.seats.used} of ${L.seats.included + L.seats.extra} people` : ''}</div>`;
  }
  function drawCompany() {
    const c = S.cp; const p = c.profile; const o = c.owner || {}; const id = p.id || S.cpId; const open = !p.status || p.status === 'active';
    const back = S.cpFrom && !/^#\/company\//.test(S.cpFrom) ? S.cpFrom : '#/companies';
    const backName = (TABS().find((x) => '#/' + x[0] === back) || [0, 'Companies'])[1];
    const L = c.licence; const ren = L ? MODULES.map(([mm]) => L.modules[mm]).filter((v) => v.active).map((v) => (v.status === 'trial' ? v.trial_ends : v.paid_until)).filter(Boolean).sort()[0] : null;
    const nf = c.next_follow_up;
    const menu = [can('customers.edit', 'support.assign', 'licences.manage') && !c.old && '<button data-menu="owner">👤 Set the Riyeser owner</button>',
      can('support.reply') && !c.old && '<button data-menu="message">✉️ Send customer reply</button>', can('customers.notes') && !c.old && '<button data-menu="call">📞 Log a call</button>',
      can('customers.notes') && '<button data-menu="note">📝 Add internal note</button>', can('offers.grant') && c.licence && open && '<button data-fix="offer">🎁 Give a free period</button>',
      can('customers.edit') && c.extra && '<button data-fix="edit">✏️ Edit details</button>', can('people.change_owner') && c.extra && '<button data-fix="owner">👑 Change the business owner</button>',
      can('business.close') && c.extra && (open ? '<button data-fix="close">⛔ Close or suspend</button><button data-fix="dup">🔁 Close as duplicate</button>' : '<button data-fix="reopen">✅ Reopen</button>'),
      `<button data-copy="${esc(p.company_code || '')}">📋 Copy Company ID</button>`].filter(Boolean).join('');
    const m = main(`<div class="cpage" data-ws="${esc(id)}">
      <a class="cpback" id="cpBack" href="${esc(back)}">← ${esc(backName)}</a>
      <header class="cphead"><div class="cpid"><div class="cptitle"><h2>${esc(p.name)}</h2>${p.country ? `<span class="sep">${esc(p.country)}</span>` : ''}${pill(BSTAT, p.status || 'active')}</div>
        <div class="cpline"><span>Owner: <b id="cpOwner">${esc(p.hq_owner_name || 'Unassigned')}</b></span><span>Next renewal: <b>${ren ? day(ren) : '—'}</b></span>
          <span>Next follow-up: <b id="cpNextFu">${nf ? `${day(nf.date)}${nf.date < today() ? ' (overdue)' : ''}` : 'none promised'}</b>${nf ? ` <small class="muted">${esc(nf.body)}</small>` : ''}</span></div>
        <div class="cpmeta"><span class="code">${esc(p.company_code || '')}</span>${copyBtn(p.company_code)}<span>${p.kind === 'personal' ? 'Just me' : 'Business'}</span>
          <span>Joined ${day(p.created_at)}</span>${p.last_active_at ? `<span>Last active ${ago(p.last_active_at)}</span>` : ''}</div>
        <div class="cpowner">${o.name ? `<span>👤 <b>${esc(o.name)}</b> <small class="muted">business owner</small></span>` : '<span class="muted">No business owner</span>'}
          ${o.phone ? `<span>📞 <a href="tel:${esc(String(o.phone).replace(/[^\d+]/g, ''))}">${esc(o.phone)}</a>${copyBtn(o.phone)}</span>` : ''}
          ${o.email ? `<span>✉️ <a href="mailto:${esc(o.email)}">${esc(o.email)}</a>${copyBtn(o.email)}</span>` : ''}</div>
        ${planSummary(c)}<div class="chips health" id="health">${healthChips(c)}</div></div>
        <div class="cpacts">${can('support.reply') && !c.old ? '<button class="btn sm p" id="cpMsg">✉️ Message customer</button>' : ''}
          ${can('customers.notes') ? `${!c.old ? '<button class="btn sm" id="cpCall">📞 Log a call</button>' : ''}<button class="btn sm" id="cpNote">📝 Add internal note</button>` : ''}
          ${can('offers.grant') && c.licence && open ? '<button class="btn sm" data-fix="offer">🎁 Give a free period</button>' : ''}
          <details class="dd cpmenu"><summary class="btn sm" aria-label="More actions" id="cpMore">⋯</summary><div class="ddm right">${menu}</div></details></div></header>
      ${p.status && p.status !== 'active' ? `<div class="banner bad">${p.status === 'closed' ? 'Closed' : 'Suspended'} ${day(p.closed_at)}${p.closed_reason ? ` · ${esc(p.closed_reason)}` : ''}
        ${p.duplicate_of ? ` · duplicate of <a href="#" data-goco="${esc(p.duplicate_of)}">${esc(p.duplicate_of_name || 'the other business')}</a>` : ''}${p.removal_state === 'removed' ? ' · personal details removed' : ''}</div>` : ''}
      ${c.old ? '<div class="card" style="margin-bottom:12px"><p class="muted small">Some parts of this page (contact details, conversations, PCs\' programs, one-click licence actions) switch on once the latest <b>team-chat.sql</b> is run in Supabase (SQL Editor).</p></div>' : ''}
      <nav class="cptabs" id="cptabs">${CPTABS.map(([k, l]) => `<button data-cptab="${k}"${S.cpTab === k ? ' class="on"' : ''}>${l}${k === 'conversations' && c.tickets_open ? ` <span class="badge">${c.tickets_open}</span>` : ''}</button>`).join('')}</nav>
      <div class="cplayout"><div id="cpBody"></div><aside class="card cptl" id="cptl"><h3>Customer timeline</h3>${miniTimeline(c)}
        <div class="tlacts">${can('customers.notes') ? '<button class="btn w" id="tlNote">💬 Add internal note</button>' : ''}${can('support.reply') && !c.old ? '<button class="btn w p" id="tlReply">✉️ Send customer reply</button>' : ''}</div></aside></div>
      <p class="privacy">🔒 HQ shows account information only. Customers' messages, calls and books are never shown here.</p></div>`);
    m.querySelectorAll('[data-menu]').forEach((b) => b.onclick = () => { b.closest('details').removeAttribute('open');
      ({ owner: setOwner, message: () => messageCustomer(), call: logCall, note: () => addNote() })[b.dataset.menu](); });
    m.querySelectorAll('.cpmenu [data-fix], .cpmenu [data-copy]').forEach((b) => b.addEventListener('click', () => b.closest('details').removeAttribute('open')));
    m.querySelector('#cptl').querySelectorAll('[data-tk]').forEach((r) => r.onclick = () => { S.ticket = r.dataset.tk; go('#/support'); });
    m.querySelector('#cpBack').onclick = (e) => { e.preventDefault(); go(back); };
    m.querySelectorAll('#cptabs [data-cptab]').forEach((b) => b.onclick = () => { S.cpTab = b.dataset.cptab;
      window.history.replaceState(null, '', `#/company/${encodeURIComponent(id)}/${S.cpTab}`); m.querySelectorAll('#cptabs button').forEach((x) => x.classList.toggle('on', x === b)); drawBody(); });
    const on = (sel, fn) => { const el = m.querySelector(sel); if (el) el.onclick = fn; };
    on('#cpMsg', () => messageCustomer()); on('#cpCall', logCall); on('#cpNote', () => addNote()); on('#tlNote', () => addNote()); on('#tlReply', () => messageCustomer());
    wireFixes(m.querySelector('.cphead'));
    drawBody();
    const after = S.cpAfter; S.cpAfter = null; if (after) ({ message: () => messageCustomer(), call: logCall, note: () => addNote() })[after]();
  }
  function drawBody() {
    const c = S.cp; const el = document.getElementById('cpBody'); if (!el) return;
    const T = { overview: tabOverview, programs: tabPrograms, pcs: tabPcs, people: tabPeople, conversations: tabConversations, money: tabMoney, history: tabHistory, link: tabLink };
    el.innerHTML = T[S.cpTab](c); el.dataset.tab = S.cpTab;
    wireBody(el);
  }

  // The right-hand Customer timeline: the latest of everything, newest first.
  function miniTimeline(c) {
    const items = (c.timeline || oldTimeline(c)).slice(0, 8);
    const dot = { ticket: 'blue', email: 'grey', note: 'amber', call: 'green', refund: 'red', offer: 'violet' };
    const what = { ticket: (x) => (x.by_staff ? 'Message from Riyeser' : 'Help request'), email: () => 'Email sent', note: () => 'Internal note', call: (x) => (x.detail === 'in' ? 'Customer called' : 'We called them'), refund: () => 'Refund request', offer: () => 'Free period' };
    return items.length ? `<ol class="mtl">${items.map((x) => `<li class="${dot[x.kind] || 'grey'}${x.kind === 'ticket' ? ' click' : ''}"${x.kind === 'ticket' ? ` data-tk="${esc(x.id)}"` : ''}><b>${esc((what[x.kind] || (() => x.kind))(x))}</b>
      <small>${esc(whenFull(x.at))}</small><span>${x.ref ? `${esc(x.ref)} · ` : ''}${esc(String(x.title || '').slice(0, 90))}</span></li>`).join('')}</ol>` : '<p class="muted small">Nothing yet.</p>';
  }
  function setOwner() {
    const c = S.cp; const staff = c.staff || [];
    dlg(`<h3>👤 Riyeser owner for ${esc(c.profile.name)}</h3><p class="muted small">The person at Riyeser who looks after this customer. It shows on the customer page and under "My customers".</p>
      <form id="sof"><label class="f"><span>Owner</span><select name="staff"><option value="">Nobody (unassigned)</option>${staff.map((x) => `<option value="${esc(x.user_id)}"${x.user_id === c.profile.hq_owner ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div id="soerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Save</button></div></form>`, (d, close) => {
      d.querySelector('#sof').onsubmit = async (e) => { e.preventDefault();
        try { await api.setOwner(c.profile.id || S.cpId, String(new FormData(e.target).get('staff') || '') || null); close(); await reloadCompany(); flash('Riyeser owner saved.'); }
        catch (err) { d.querySelector('#soerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
  }
  const MOD_ICON = { basic: '📗', plus: '📒', payroll: '🧾', pos: '🛒', bookings: '📅', as_built: '🏗️', calls: '📞' };
  function enabledModules(c) {
    const L = c.licence; if (!L) return '';
    return `<div class="card" id="modsCard"><h3>Enabled modules</h3><div class="mods">${MODULES.map(([m, n]) => { const v = L.modules[m]; const on = !!v.active;
      return `<button class="mod${on ? ' on' : ''}" data-cpgo="programs"><span class="mic" aria-hidden="true">${MOD_ICON[m]}</span><span><b>${n}</b><small>${v.status === 'active' ? 'Paid' : v.status === 'trial' ? `Trial · ${v.days_left} days` : v.status === 'cancelled' && on ? 'Cancelled, still on' : 'Not active'}</small></span><span class="mck" aria-hidden="true">${on ? '✓' : '–'}</span></button>`; }).join('')}</div></div>`;
  }
  // --- Overview: business details, the contact person, notes, quick actions, follow-ups
  function tabOverview(c) {
    const p = c.profile; const o = c.owner || {}; const s = o.signup || {}; const credit = c.extra ? creditText(c.extra.credit) : ''; const open = !p.status || p.status === 'active';
    const dl = (rows) => `<dl class="kv">${rows.filter((r) => r).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    const dash = (v) => (v ? esc(v) : '<span class="muted">—</span>');
    const notes = c.notes || []; const pinned = notes.filter((n) => n.pinned);
    const tools = [can('customers.edit') && c.extra && '<button class="btn sm" data-fix="edit">✏️ Edit details</button>',
      can('people.change_owner') && c.extra && '<button class="btn sm" data-fix="owner">👑 Change owner</button>',
      can('business.close') && c.extra && (open ? '<button class="btn sm" data-fix="close">⛔ Close or suspend</button><button class="btn sm" data-fix="dup">🔁 Close as duplicate</button>' : '<button class="btn sm" data-fix="reopen">✅ Reopen</button>'),
      can('licences.view') && '<button class="btn sm" data-cpgo="programs">🧩 Programs and licence</button>',
      can('support.view') && '<button class="btn sm" data-cpgo="conversations">💬 Conversations</button>'].filter(Boolean).join('');
    return `${pinned.length ? `<div class="card pinned">${pinned.map((n) => `<div class="pin">📌 ${esc(n.body)} <small class="muted">${esc(n.by || 'Riyeser')} · ${ago(n.at)}</small></div>`).join('')}</div>` : ''}
      ${enabledModules(c)}<div class="grid g2 cpgrid"><div class="card" id="bizCard"><h3>Business details ${can('customers.edit') && c.extra ? '<button class="btn sm right" data-fix="edit">✏️ Edit</button>' : ''}</h3>
        ${dl([['Legal name', dash(p.legal_name)], ['ABN / TIN', dash(p.tax_number)], ['Country', dash(p.country)], ['Address', dash(p.address)], ['Phone', dash(p.phone)], ['Email', dash(p.email)],
          ['Kind', p.kind === 'personal' ? 'Just me' : 'Business'], ['Joined Riyeser', day(p.created_at)], ['New people need', p.require_approval ? 'Approval (recommended)' : 'No approval'],
          ['Waiting to join', num(c.requests_waiting)], credit && ['Credit', `<b id="credit">Credit: ${credit}</b>`]])}</div>
        <div class="card" id="contactCard"><h3>Contact person <small>· the owner</small></h3>${o.name ? dl([['Name', esc(o.name)], ['Email', o.email ? `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : dash()],
          ['Phone', o.phone ? `<a href="tel:${esc(String(o.phone).replace(/[^\d+]/g, ''))}">${esc(o.phone)}</a>` : dash()], ['Country', dash(o.country)], ['Signed up', o.signed_up ? day(o.signed_up) : dash()],
          ['Last sign-in', o.last_sign_in ? `${ago(o.last_sign_in)} <small class="muted">${day(o.last_sign_in)}</small>` : (c.old ? dash() : 'Never')],
          ['Two-step sign-in', o.two_step ? '🔐 On' : o.two_step === false ? 'Off' : dash()], o.email_confirmed === false && ['Email', '<span class="pill warn">Not confirmed yet</span>']])
          + (Object.keys(s).length ? `<h4 class="h4">What they typed at sign-up</h4>${dl([['Name', dash(s.you)], ['Phone', dash(s.phone)], ['Country', dash(s.country)], ['Email', dash(s.email)], ['Business', dash(s.biz)],
            s.tax_number && ['ABN / TIN', esc(s.tax_number)], s.address && ['Address', esc(s.address)]])}` : '') : '<p class="muted small">No owner on file.</p>'}</div>
        <div class="card notes" id="notesCard"><h3>HQ notes <small>· only Riyeser staff see these</small></h3>
          ${can('customers.notes') ? `<form id="nf" class="nform"><input name="body" required maxlength="2000" placeholder="e.g. Called the owner about POS"><button class="btn sm">Add internal note</button>
            ${c.old ? '' : '<label class="opt small"><input type="checkbox" name="pin"> Pin to the top</label><label class="opt small">Follow up on <input type="date" name="fu" min="' + today() + '"></label>'}</form>` : ''}
          ${notes.length ? notes.slice(0, 30).map(noteHtml).join('') : '<p class="muted small">No notes yet.</p>'}</div>
        <div class="card" id="quickCard"><h3>Quick actions <small>· fix-ups need a reason and go in the HQ history</small></h3><div class="row">${tools || '<span class="muted small">Nothing your HQ role can change here.</span>'}</div></div>
        ${c.old ? '' : `<div class="card" id="myFollowUps"><h3>My follow-ups</h3><div id="fuBox"><p class="muted small">Loading…</p></div></div>`}</div>`;
  }
  const noteHtml = (n) => `<div class="nt${n.kind === 'call' ? ' call' : ''}">${esc(n.body)}<small>${n.pinned ? '📌 pinned · ' : ''}${n.kind === 'call' ? `📞 ${n.direction === 'in' ? 'They called us' : 'We called them'}${n.contact ? ` · ${esc(n.contact)}` : ''} · ` : ''}${esc(n.by || 'Riyeser')} · ${ago(n.at)}${n.follow_up ? ` · follow up ${n.follow_up_done_at ? '✓ done' : day(n.follow_up)}` : ''}
    ${n.id && can('customers.notes') && n.pinned != null ? ` · <button class="lnk" data-pin="${esc(n.id)}" data-on="${n.pinned ? '' : '1'}">${n.pinned ? 'Unpin' : 'Pin'}</button>` : ''}${n.id && n.follow_up && !n.follow_up_done_at && can('customers.notes') ? ` · <button class="lnk" data-fudone="${esc(n.id)}">Follow-up done</button>` : ''}</small></div>`;

  // --- Programs: one row per program, with one-click actions
  function tabPrograms(c) {
    const L = c.licence; if (!L) return '<div class="card"><p class="muted">Your HQ role can\'t see licences.</p></div>';
    const X = c.extra; const open = !c.profile.status || c.profile.status === 'active'; const lim = S.limitDays || 31;
    const installs = (app) => (c.pcs || []).filter((d) => (d.programs || []).some((x) => x.id === app)).length; const reported = (c.pcs || []).some((d) => d.programs_at);
    const pcsCell = (app) => (reported ? (installs(app) ? `${installs(app)} PC${installs(app) === 1 ? '' : 's'}` : '<span class="muted">none</span>') : '<span class="muted">—</span>');
    const grant = can('offers.grant') && !c.old; const manage = can('licences.manage');
    const acts = (m, v) => { if (!open) return '';
      const b = (act, label, extra = '', cls = '') => `<button class="btn sm${cls}" data-q="${act}" data-mod="${m}"${extra}>${label}</button>`; const out = [];
      if (grant && (trialish(v) || v.status === 'active')) [7, 30, 90].forEach((n) => out.push(b('extend', `+${n} days`, ` data-days="${n}"`, n > lim ? ' over' : '')));
      if ((grant && trialish(v) && !(v.status === 'trial' && v.days_left >= 30)) || (manage && !trialish(v) && v.status !== 'active')) out.push(b('unlock', 'Unlock now', '', ' p'));
      if (manage) out.push(b('paid_until', 'Mark paid until…'));
      if (manage && v.active) out.push(b('pause', 'Pause'));
      if (manage && (v.status === 'active' || v.status === 'trial')) out.push(b('cancel', 'Cancel'));
      return out.join(''); };
    return `<div class="card scroll" id="licCard"><h3>Programs <small>· ${c.monthly != null ? `${money(c.monthly)} a month (list price estimate)` : ''}${grant ? ` · free time up to ${lim} days applies straight away; more goes to Approvals` : ''}</small></h3>
      <table class="tbl lic"><tr><th>Program</th><th>Status</th><th>Until</th><th>Days left</th><th>Installed on</th>${open && (grant || manage) ? '<th>Actions</th>' : ''}</tr>
      ${MODULES.map(([m, name]) => { const v = L.modules[m]; const [lbl, cl] = modState(v); const until = v.status === 'trial' || (v.status === 'ended' && !v.paid_until) ? v.trial_ends : v.paid_until;
        return `<tr data-mod="${m}"><td><b>${name}</b></td><td><span class="pill${cl ? ' ' + cl : ''}">${lbl}</span>${v.status === 'cancelled' && v.active ? '<small>works until the end</small>' : ''}</td>
          <td class="nowrap">${until ? day(until) : '<span class="muted">—</span>'}</td><td>${v.active ? daysPill(v.days_left) : '<span class="muted">—</span>'}</td><td>${pcsCell(MOD_APP[m])}</td>
          ${open && (grant || manage) ? `<td><div class="qbtns">${acts(m, v)}</div></td>` : ''}</tr>`; }).join('')}
      ${FREE_PROGRAMS.map(([app, name]) => `<tr class="free"><td>${name}</td><td><span class="pill ok">Free</span></td><td><span class="muted">—</span></td><td><span class="muted">—</span></td><td>${pcsCell(app)}</td>${open && (grant || manage) ? '<td></td>' : ''}</tr>`).join('')}</table>
      ${!reported ? '<p class="muted small">"Installed on" fills in once their PCs run Riyeser Central 1.8.1 or later.</p>' : ''}
      <p class="muted small">Changes reach the business's PCs the next time Riyeser Central checks in (at start-up and daily).</p></div>
      <div class="card" style="margin-top:14px"><h3>Plan settings</h3><form id="plan" class="grid g3 planf">
        <label class="f"><span>Extra users <small class="muted">(${L.seats.used} people, ${L.seats.included} included)</small></span><input type="number" min="0" name="users" value="${L.seats.extra}"${manage ? '' : ' disabled'}></label>
        <label class="f"><span>Extra companies</span><input type="number" min="0" name="cos" value="${L.extra_companies}"${manage ? '' : ' disabled'}></label>
        <label class="f"><span>Billing</span><select name="billing"${manage ? '' : ' disabled'}><option value="monthly"${L.billing === 'monthly' ? ' selected' : ''}>Monthly</option><option value="yearly"${L.billing === 'yearly' ? ' selected' : ''}>Yearly (2 months free)</option></select></label>
        <label class="opt"><input type="checkbox" name="eb"${L.early_bird ? ' checked' : ''}${manage ? '' : ' disabled'}> Early bird: half price for the first 12 months</label>
        ${manage ? '<div><button class="btn p sm">Save plan</button></div>' : '<p class="muted small">Owners and Finance can change plans.</p>'}</form></div>
      ${X && X.offers && X.offers.length ? `<div class="card scroll" id="offCard" style="margin-top:14px"><h3>Free periods <small>· ${X.offers.length}</small></h3>${offersTable(X.offers)}</div>` : ''}`;
  }
  const offersTable = (list) => `<table class="tbl"><tr><th>Offer</th><th>What</th><th>Status</th><th>By</th></tr>
    ${list.map((o) => `<tr><td class="code">${esc(o.ref)}<small>${day(o.created_at)}</small></td><td>${o.days} days · ${esc(o.kind === 'account' ? 'all paid programs' : o.modules.map(modName).join(', '))}<small>${esc(OFFER_KIND[o.kind] || o.kind)} · ${esc((OFFER_WHY.find((w) => w[0] === o.reason_category) || [0, o.reason_category])[1])}: ${esc(o.reason)}</small></td>
      <td>${offerPill(o)}${o.ends_at ? `<small>to ${day(o.ends_at)}</small>` : ''}</td><td>${esc(o.requested_by_name || '')}${o.approved_by_name ? `<small>${o.status === 'declined' ? 'declined' : 'approved'} by ${esc(o.approved_by_name)}</small>` : ''}</td></tr>`).join('')}</table>`;
  // The small confirm for a one-click action: what it does, a reason (category and note) and an optional ticket.
  function quickAction(mod, act, days) {
    const c = S.cp; const v = c.licence.modules[mod]; const name = modName(mod); const lim = S.limitDays || 31; const td = today();
    const paidish = ['paid_until', 'pause', 'cancel'].includes(act) || (act === 'unlock' && !trialish(v));
    const base = (v.status === 'active' ? v.paid_until : v.trial_ends) || td; const from = base > td ? base : td;
    const title = { extend: `+${days} days for ${name}`, unlock: `Unlock ${name} now`, paid_until: `Mark ${name} paid until…`, pause: `Pause ${name}`, cancel: `Cancel ${name}` }[act];
    const intro = act === 'extend' ? `${v.status === 'active' ? `Adds ${days} free days to the paid period` : `Adds ${days} days to the free trial`}, to <b>${day(plusDays(from, days))}</b>. `
        + (days > lim ? `<b>That's over the ${lim}-day limit, so it goes to Approvals</b> for a supervisor (someone else with offers.approve).` : `Up to ${lim} days applies straight away.`) + ' The customer is emailed when it applies; they never see the reason.'
      : act === 'unlock' ? (paidish ? 'Turns it back on, paid until the date below (for a customer who is paying soon). Needs licences.manage.' : `Gives the free trial 30 days from today, to <b>${day(plusDays(td, 30))}</b>. The customer is emailed.`)
      : act === 'paid_until' ? 'For when they\'ve paid. Their programs unlock at the next check-in.'
      : act === 'pause' ? 'Stops it now. The books on their PCs are never touched, and you can unlock it again any time.'
      : v.status === 'active' ? `It keeps working until <b>${day(v.paid_until)}</b>, then stops.` : 'The free trial ends now.';
    const why = paidish ? QWHY_PAID : OFFER_WHY;
    const dateField = act === 'paid_until' || (act === 'unlock' && paidish) ? `<label class="f"><span>Paid until</span><input type="date" name="until" required min="${td}" value="${act === 'unlock' ? plusDays(td, 30) : v.paid_until && v.paid_until >= td ? plusDays(v.paid_until, 30) : plusDays(td, 30)}"></label>` : '';
    dlg(`<h3>${title}</h3><p class="muted small">${intro}</p><form id="qa">${dateField}
      <div class="grid g2"><label class="f"><span>Reason</span><select name="why">${why.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="f"><span>Ticket number <small class="muted">(optional)</small></span><input name="ticket" placeholder="T-10234" maxlength="20"></label></div>
      <label class="f"><span>Note <small class="muted">(required, staff only: it goes in the HQ history for good, so no personal details)</small></span><input name="reason" required minlength="4" maxlength="300"></label>
      <div id="qaerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">${act === 'extend' ? (days > lim ? 'Ask for approval' : `Add ${days} days`) : act === 'unlock' ? 'Unlock now' : act === 'paid_until' ? 'Mark paid' : act === 'pause' ? 'Pause it' : 'Cancel it'}</button></div></form>`, (d, close) => {
      d.querySelector('#qa').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const btn = e.target.querySelector('.btn.p'); btn.disabled = true;
        try { const r = await api.quickLicence(c.profile.id || S.cpId, mod, act, { days, until: String(f.get('until') || '') || null, why: String(f.get('why')), reason: String(f.get('reason')).trim(), ticket: String(f.get('ticket') || '').trim() });
          close(); await reloadCompany();
          flash(r.status === 'waiting' ? `${r.ref}: ${r.days} days is over the ${r.limit}-day limit, so it's waiting for a supervisor in Approvals.`
            : r.status === 'applied' ? `${r.ref}: ${r.days} free days applied to ${name}.`
            : act === 'pause' || (act === 'cancel' && (!r.until || r.until < today())) ? `${name}: ${act === 'pause' ? 'paused' : 'cancelled'}. It's stopped now.`
            : `${name}: ${({ unlock: 'unlocked, paid until', paid_until: 'paid until', cancel: 'cancelled; it works until' })[act]} ${day(r.until)}.`);
          badges();
        } catch (err) { btn.disabled = false; d.querySelector('#qaerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
    });
  }

  // --- PCs & programs
  function tabPcs(c) {
    const pcs = c.pcs || [];
    return `<div class="card scroll" id="pcsCard"><h3>Linked PCs <small>· ${pcs.length}</small></h3>${pcs.length ? `<table class="tbl" id="pcsTbl"><tr><th>PC</th><th>Person</th><th>Central</th><th>Last seen</th><th>Riyeser programs installed</th></tr>
      ${pcs.map((d) => `<tr><td><b>${esc(d.name || 'A PC')}</b><small>${esc(d.platform === 'win32' ? 'Windows' : d.platform || '')}${d.linked_at ? ` · linked ${day(d.linked_at)}` : ''}</small></td><td>${esc(d.person || '')}</td>
        <td class="nowrap">${esc(d.version || '?')}</td><td>${ago(d.last_seen)}</td>
        <td>${d.programs ? `<div class="progs">${d.programs.filter((x) => x.id !== 'central').map((x) => `<span class="prog">${esc(APP_NAME[x.id] || x.id)}${x.version ? ` <small>${esc(x.version)}</small>` : ''}</span>`).join('') || '<span class="muted small">Only Central</span>'}</div>${d.programs_at ? `<small>as of ${ago(d.programs_at)}</small>` : ''}`
          : '<span class="muted small">Not reported yet (Riyeser Central 1.8.1 sends this)</span>'}</td></tr>`).join('')}</table>` : '<p class="muted small">No PCs linked yet.</p>'}</div>
      <div class="card" style="margin-top:14px"><h3>Branches</h3>${(c.branches || []).map((b) => `<div class="small">${esc(b.name)} <span class="muted">· ${b.extension || ''} · ${b.people} people</span></div>`).join('') || '<p class="muted small">None.</p>'}</div>`;
  }
  // --- People
  function tabPeople(c) {
    const X = c.extra; const ppl = c.people || [];
    return `<div class="card scroll"><h3>People <small>· ${ppl.length}</small></h3><table class="tbl" id="ppl"><tr><th>Name</th><th>Phone</th><th>Role</th><th class="n">Ext</th><th>Branches</th><th>Two-step</th><th>Last sign-in</th><th>Joined</th>${X ? '<th></th>' : ''}</tr>
      ${ppl.map((x) => `<tr><td>${esc(x.name)}<small>${x.email ? `<a href="mailto:${esc(x.email)}">${esc(x.email)}</a>` : ''}</small></td><td class="nowrap">${x.phone ? `<a href="tel:${esc(String(x.phone).replace(/[^\d+]/g, ''))}">${esc(x.phone)}</a>` : '<span class="muted">—</span>'}</td>
        <td>${esc(x.role === 'owner' ? 'Owner' : x.job_role)}${x.role === 'admin' ? ' · admin' : ''}</td><td class="n">${x.extension || ''}</td><td>${esc((x.branches || []).join(', '))}</td>
        <td>${x.two_step ? '🔐 On' : x.two_step === false ? 'Off' : ''}</td><td>${x.last_sign_in ? ago(x.last_sign_in) : c.old ? '' : '<span class="muted">never</span>'}</td><td>${day(x.joined)}</td>
        ${X ? `<td><div class="row">${can('people.reset_2fa') && x.user_id && x.two_step !== false ? `<button class="btn sm" data-r2fa="${esc(x.user_id)}">Reset two-step</button>` : ''}
          ${can('people.change_owner') && x.role !== 'owner' ? `<button class="btn sm" data-mkowner="${esc(x.user_id)}">Make owner</button>` : ''}
          ${can('support.reply') && !c.old ? `<button class="btn sm" data-msgto="${esc(x.user_id)}">Message</button>` : ''}</div></td>` : ''}</tr>`).join('')}</table></div>`;
  }
  // --- Conversations: one timeline, newest first
  function tabConversations(c) {
    const items = c.timeline || oldTimeline(c);
    const icon = { ticket: '💬', email: '✉️', note: '📝', call: '📞', refund: '↩️', offer: '🎁' };
    const kindName = { ticket: 'Ticket', email: 'Email', note: 'Note', call: 'Call', refund: 'Refund', offer: 'Free period' };
    const stat = (x) => (x.kind === 'ticket' ? pill(TSTAT, x.status) : x.kind === 'email' ? (x.status === 'sent' ? '<span class="pill ok">Sent</span>' : x.status === 'queued' ? '<span class="pill">Queued</span>' : x.status === 'held' ? '<span class="pill warn">Held</span>' : '<span class="pill bad">Failed</span>')
      : x.kind === 'refund' ? pill(RSTAT, x.status) : x.kind === 'offer' ? offerPill(x) : x.status === 'follow_up' ? `<span class="pill${x.follow_up <= today() ? ' warn' : ''}">Follow up ${day(x.follow_up)}</span>` : '');
    return `<div class="card"><div class="row cvbar"><h3 style="margin:0;flex:1">Conversations <small>· tickets, emails, notes, calls, refunds and free periods</small></h3>
        ${can('support.reply') && !c.old ? '<button class="btn sm p" id="cvMsg">✉️ Send customer reply</button>' : ''}${can('customers.notes') ? `${!c.old ? '<button class="btn sm" id="cvCall">📞 Log a call</button>' : ''}<button class="btn sm" id="cvNote">📝 Add internal note</button>` : ''}</div>
      <div class="timeline" id="timeline">${items.length ? items.map((x) => `<div class="tli k-${esc(x.kind)}${x.kind === 'ticket' ? ' click' : ''}"${x.kind === 'ticket' ? ` data-tk="${esc(x.id)}"` : ''}><span class="tic" aria-hidden="true">${icon[x.kind] || '•'}</span>
        <div class="tlb"><div class="tlt">${x.kind === 'ticket' && x.by_staff ? '<span class="pill">Message from Riyeser</span> ' : ''}${x.ref ? `<span class="code">${esc(x.ref)}</span> ` : ''}<b>${esc(x.kind === 'note' || x.kind === 'call' ? '' : x.title)}</b>${x.kind === 'note' || x.kind === 'call' ? esc(x.title) : ''} ${stat(x)}</div>
          <small>${kindName[x.kind] || x.kind}${x.kind === 'call' ? ` · ${x.detail === 'in' ? 'they called us' : 'we called them'}${x.extra ? ` · ${esc(x.extra)}` : ''}` : ''}${x.kind === 'email' ? ` · to ${esc(x.who || '(no address)')}` : x.who ? ` · ${esc(x.who)}` : ''}${x.kind === 'refund' && x.detail ? ` · ${esc(x.detail)}` : ''} · ${ago(x.at)} <span class="muted">${day(x.at)}</span>
          ${(x.kind === 'call' || x.kind === 'note') && x.status === 'follow_up' && can('customers.notes') ? ` · <button class="lnk" data-fudone="${esc(x.id)}">Follow-up done</button>` : ''}</small></div></div>`).join('')
        : '<p class="muted small">Nothing yet.</p>'}</div></div>`;
  }
  function oldTimeline(c) {   // an older database: build it from what the company panel had
    const X = c.extra || {}; const out = [];
    (X.tickets || []).forEach((t) => out.push({ kind: 'ticket', at: t.updated_at, id: t.id, ref: t.ref, title: t.subject, status: t.status }));
    (c.notes || []).forEach((n) => out.push({ kind: 'note', at: n.at, title: n.body, who: n.by }));
    (X.refunds || []).forEach((f) => out.push({ kind: 'refund', at: f.created_at, ref: f.ref, title: f.for_what, status: f.status, detail: `${f.currency} ${f.amount}` }));
    (X.offers || []).forEach((o) => out.push({ kind: 'offer', at: o.created_at, ref: o.ref, title: `${o.days} free days`, status: o.status, who: o.requested_by_name }));
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  // --- Money: refunds, credit, free periods
  function tabMoney(c) {
    const X = c.extra; if (!X) return SWITCH_ON; const credit = creditText(X.credit);
    return `<div class="tiles mtiles">${tile('A month (estimate)', c.monthly != null ? money(c.monthly) : '—', 'list price, until payments are connected')}${tile('Credit on account', credit || '0', 'from refunds paid as credit')}
        ${tile('Refunds', X.refunds ? num(X.refunds.length) : '—', X.refunds ? `${X.refunds.filter((f) => !['paid', 'declined'].includes(f.status)).length} open` : 'your role can\'t see refunds')}${tile('Free periods', num((X.offers || []).length), `${(X.offers || []).filter((o) => o.status === 'waiting').length} waiting for approval`)}</div>
      ${X.refunds ? `<div class="card scroll" id="coRefunds"><h3>Refunds <small>· ${X.refunds.length} · approve and pay them in Refunds</small></h3>${X.refunds.length ? `<table class="tbl">${X.refunds.map((f) => `<tr><td class="code">${esc(f.ref)}<small>${day(f.created_at)}</small></td><td>${cur(f.amount, f.currency)}<small>${esc(f.for_what)}</small></td><td>${refundPill(f)}</td><td>${f.amount_approved != null ? cur(f.amount_approved, f.currency) : ''}<small>${esc(f.paid_method ? (PAID_HOW.find((x) => x[0] === f.paid_method) || [0, f.paid_method])[1] : '')}</small></td></tr>`).join('')}</table>` : '<p class="muted small">None.</p>'}
        ${can('refunds.view') ? '<button class="btn sm" data-gotab="refunds" style="margin-top:8px">Open Refunds</button>' : ''}</div>` : ''}
      <div class="card scroll" id="moneyOffers" style="margin-top:14px"><h3>Free periods and credits <small>· ${(X.offers || []).length}</small></h3>${(X.offers || []).length ? offersTable(X.offers) : '<p class="muted small">None.</p>'}</div>`;
  }
  // --- History: this business's HQ history
  function tabHistory(c) {
    const X = c.extra; if (!X || !X.history) return '<div class="card"><p class="muted">Your HQ role can\'t see the HQ history.</p></div>';
    return `<div class="card scroll"><h3>HQ history for this business <small>· who looked and what was done</small></h3>${X.history.length ? `<table class="tbl" id="coHist">${X.history.slice(0, 100).map((h) => `<tr><td>${ago(h.at)}<small>${day(h.at)}</small></td><td>${esc(h.who)}</td><td>${esc(HIST_ACTS[h.action] || h.action)}${histExtra(h) ? `<small>${esc(histExtra(h))}</small>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted small">Nothing yet.</p>'}</div>`;
  }
  // --- Link: Riyeser Link Office for this business. hq-link.js fills #cpLink by itself from hq_company_link(ws) (data-ws says which business).
  function tabLink(c) {
    return `<div class="card"><h3>Riyeser Link Office</h3><div id="cpLink" data-ws="${esc(c.profile.id || S.cpId)}">Link Office: not set up</div></div>`;
  }
  // Is this business's Link Office offline? (hq_company_link: an office not seen for 12 minutes)
  const linkOffline = (k) => !!(k && Array.isArray(k.offices) && k.offices.length && k.offices.some((o) => !o.last_seen || Date.now() - new Date(o.last_seen) > 12 * 60000));

  function wireBody(el) {
    const c = S.cp; const id = c.profile.id || S.cpId;
    el.querySelectorAll('[data-cpgo]').forEach((b) => b.onclick = () => { const x = document.querySelector(`#cptabs [data-cptab="${b.dataset.cpgo}"]`); if (x) x.click(); });
    el.querySelectorAll('[data-gotab]').forEach((b) => b.onclick = () => go('#/' + b.dataset.gotab));
    el.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => quickAction(b.dataset.mod, b.dataset.q, Number(b.dataset.days) || null));
    el.querySelectorAll('[data-tk]').forEach((r) => r.onclick = () => { S.ticket = r.dataset.tk; go('#/support'); });
    el.querySelectorAll('[data-pin]').forEach((b) => b.onclick = async () => { try { await api.notePin(Number(b.dataset.pin), !!b.dataset.on); await reloadCompany(); } catch (err) { alert(plain(err)); } });
    el.querySelectorAll('[data-fudone]').forEach((b) => b.onclick = async (e) => { e.stopPropagation(); try { await api.followUpDone(Number(b.dataset.fudone)); flash('Follow-up ticked off.'); await reloadCompany(); } catch (err) { alert(plain(err)); } });
    el.querySelectorAll('[data-msgto]').forEach((b) => b.onclick = () => messageCustomer(b.dataset.msgto));
    const on = (sel, fn) => { const x = el.querySelector(sel); if (x) x.onclick = fn; };
    on('#cvMsg', () => messageCustomer()); on('#cvCall', logCall); on('#cvNote', () => addNote());
    const nf = el.querySelector('#nf'); if (nf) nf.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(nf);
      try { await api.noteAdd(id, { kind: 'note', body: String(f.get('body')).trim(), pinned: !!f.get('pin'), follow_up: String(f.get('fu') || '') || null }); await reloadCompany(); } catch (err) { alert(plain(err)); } };
    const pf = el.querySelector('#plan'); if (pf && can('licences.manage')) pf.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
      try { await api.setPlan(id, Number(f.get('users') || 0), Number(f.get('cos') || 0), String(f.get('billing')), !!f.get('eb')); await reloadCompany(); flash('Plan saved.'); } catch (err) { alert(plain(err)); } };
    const fb = el.querySelector('#fuBox'); if (fb) api.myFollowUps().then((fu) => { fb.innerHTML = followUpList(fu, id); wireAttention(fb, reloadCompany); }).catch((err) => { fb.innerHTML = missing(err) ? '<p class="muted small">Run the latest team-chat.sql to switch this on.</p>' : `<p class="muted small">${esc(plain(err))}</p>`; });
    wireFixes(el);
  }
  // Message customer: a ticket from Riyeser to someone in the business (the owner unless you choose someone else).
  function messageCustomer(to) {
    const c = S.cp; const ppl = c.people || []; const owner = (c.owner || {}).user_id; const sel = typeof to === 'string' ? to : owner;
    dlg(`<h3>✉️ Message ${esc(c.profile.name)}</h3><p class="muted small">This starts a help request from Riyeser. They see it on their Riyeser home page (under Help, as "Message from Riyeser") and by email, and can reply there.</p>
      <form id="mc"><label class="f"><span>To</span><select name="to">${ppl.map((x) => `<option value="${esc(x.user_id)}"${x.user_id === sel ? ' selected' : ''}>${esc(x.name)}${x.role === 'owner' ? ' (owner)' : ''}${x.email ? ` · ${esc(x.email)}` : ''}</option>`).join('')}</select></label>
      <label class="f"><span>About</span><select name="topic">${Object.entries(TOPICS).map(([k, l]) => `<option value="${k}"${k === 'other' ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f"><span>Subject</span><input name="subject" required maxlength="150" placeholder="e.g. Your free trial ends next week"></label>
      <label class="f"><span>Message</span><textarea name="body" rows="6" required maxlength="5000" placeholder="Hi, …"></textarea></label>
      <div id="mcerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Send customer reply</button></div></form>`, (d, close) => {
      d.querySelector('#mc').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const btn = e.target.querySelector('.btn.p'); btn.disabled = true;
        try { const r = await api.messageCustomer(c.profile.id || S.cpId, String(f.get('to') || '') || null, String(f.get('topic')), String(f.get('subject')).trim(), String(f.get('body')).trim());
          close(); S.cpTab = 'conversations'; window.history.replaceState(null, '', `#/company/${encodeURIComponent(c.profile.id || S.cpId)}/conversations`); await reloadCompany();
          flash(`Sent as ${r.ref}. They'll see it on their Riyeser home page and by email.`); badges();
        } catch (err) { btn.disabled = false; d.querySelector('#mcerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
    });
  }
  function logCall() {
    const c = S.cp; const ppl = c.people || [];
    dlg(`<h3>📞 Log a call with ${esc(c.profile.name)}</h3><p class="muted small">Only Riyeser staff see this. Add a follow-up date and it shows on your "My follow-ups" list.</p>
      <form id="lc"><div class="row"><label class="opt"><input type="radio" name="direction" value="in" checked> They called us</label><label class="opt"><input type="radio" name="direction" value="out"> We called them</label></div>
      <label class="f"><span>Who</span><input name="contact" list="lcppl" maxlength="120" value="${esc((c.owner || {}).name || '')}"><datalist id="lcppl">${ppl.map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist></label>
      <label class="f"><span>What it was about</span><textarea name="body" rows="4" required maxlength="2000" placeholder="e.g. Asked how to add a second till"></textarea></label>
      <label class="f"><span>Follow up on <small class="muted">(optional)</small></span><input type="date" name="fu" min="${today()}"></label>
      <div id="lcerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Save call</button></div></form>`, (d, close) => {
      d.querySelector('#lc').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        try { await api.noteAdd(c.profile.id || S.cpId, { kind: 'call', direction: String(f.get('direction')), contact: String(f.get('contact') || '').trim(), body: String(f.get('body')).trim(), follow_up: String(f.get('fu') || '') || null });
          close(); await reloadCompany(); flash(f.get('fu') ? `Call saved. Follow-up on ${day(String(f.get('fu')))} is on your list.` : 'Call saved.');
        } catch (err) { d.querySelector('#lcerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
    });
  }
  function addNote() {
    const c = S.cp;
    dlg(`<h3>📝 Add internal note</h3><p class="muted small">Only Riyeser staff see internal notes. The customer never does.</p><form id="an"><label class="f"><span>Note</span><textarea name="body" rows="4" required maxlength="2000"></textarea></label>
      ${c.old ? '' : `<label class="opt"><input type="checkbox" name="pin"> Pin it to the top of the page</label><label class="f"><span>Follow up on <small class="muted">(optional)</small></span><input type="date" name="fu" min="${today()}"></label>`}
      <div id="anerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Add internal note</button></div></form>`, (d, close) => {
      d.querySelector('#an').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        try { await api.noteAdd(c.profile.id || S.cpId, { kind: 'note', body: String(f.get('body')).trim(), pinned: !!f.get('pin'), follow_up: String(f.get('fu') || '') || null }); close(); await reloadCompany(); flash('Note added.'); }
        catch (err) { d.querySelector('#anerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
    });
  }
  // The fix-up tools (edit details, owner, close, duplicate, reopen, free period, two-step reset, make owner).
  function wireFixes(root) {
    const c = S.cp; const p = c.profile; const id = p.id || S.cpId; const L = c.licence; const reopen = () => reloadCompany();
    const inp = (name, label, val = '', extra = '') => `<label class="f"><span>${label}</span><input name="${name}" value="${esc(val || '')}" ${extra}></label>`;
    const ownerForm = (person) => fixForm('👑 Change owner', 'The new owner gets every admin power. The old owner becomes an admin.',
      `<label class="f"><span>New owner</span><select name="person">${c.people.filter((x) => x.role !== 'owner').map((x) => `<option value="${esc(x.user_id)}"${x.user_id === person ? ' selected' : ''}>${esc(x.name)} (${esc(x.email || '')})</option>`).join('')}</select></label>`,
      async (f, reason, ticket) => { await api.changeOwner(id, String(f.get('person')), reason, ticket); await reopen(); flash('Owner changed.'); }, 'Make them the owner');
    const fixes = {
      edit: () => fixForm('✏️ Edit business details', 'Only change what the customer asked for. The customer\'s own change history will show "Riyeser".',
        `<div class="grid g2">${inp('name', 'Name', p.name, 'required maxlength="80"')}${inp('tax_number', 'ABN / TIN / Tax ID', p.tax_number, 'maxlength="40"')}${inp('phone', 'Phone', p.phone, 'maxlength="40"')}
          ${inp('email', 'Email', p.email, 'maxlength="120"')}${inp('country', 'Country', p.country, 'maxlength="60"')}${inp('address', 'Address', p.address, 'maxlength="300"')}</div>`,
        async (f, reason, ticket) => { const pr = {}; ['name', 'tax_number', 'address', 'phone', 'email', 'country'].forEach((k) => { const v = String(f.get(k) || '').trim(); if (v !== String(p[k] || '')) pr[k] = v; });
          if (!Object.keys(pr).length) throw new Error('Nothing has changed.'); await api.editBusiness(id, pr, reason, ticket); await reopen(); }),
      owner: () => ownerForm(),
      close: () => fixForm('⛔ Close or suspend', 'Nothing is deleted. Its people can\'t open it, and its programs\' online licence reads as not active. The books on their PCs are never touched. The owner is emailed.',
        '<label class="f"><span>Make it</span><select name="st"><option value="closed">Closed</option><option value="suspended">Suspended (for now)</option></select></label>',
        async (f, reason, ticket) => { await api.setBusinessStatus(id, String(f.get('st')), reason, ticket); await reopen(); }, 'Close it'),
      reopen: () => fixForm('✅ Reopen', 'Its people can use it again straight away. The owner is emailed.', '',
        async (f, reason, ticket) => { await api.setBusinessStatus(id, 'active', reason, ticket); await reopen(); }, 'Reopen'),
      dup: async () => { const all = (await api.companies('', 'active')).filter((x) => x.id !== id);
        fixForm('🔁 Close as duplicate', 'For a business that was signed up twice. It\'s closed (never deleted) and links to the one to keep.',
          `<label class="f"><span>It duplicates</span><select name="dup">${all.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.company_code || '')}</option>`).join('')}</select></label>`,
          async (f, reason, ticket) => { await api.closeDuplicate(id, String(f.get('dup')), reason, ticket); await reopen(); }, 'Close as duplicate'); },
      offer: async () => { const lim = S.limitDays || 31;
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
              closeD(); await reopen(); flash(r.status === 'applied' ? `${r.ref}: ${r.days} free days applied.` : `${r.ref}: ${r.days} days is over the ${r.limit}-day limit, so it's waiting for a supervisor in Approvals.`); badges();
            } catch (err) { d.querySelector('#oferr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; }); },
    };
    root.querySelectorAll('[data-fix]').forEach((b) => b.onclick = () => fixes[b.dataset.fix]());
    root.querySelectorAll('[data-mkowner]').forEach((b) => b.onclick = () => ownerForm(b.dataset.mkowner));
    root.querySelectorAll('[data-r2fa]').forEach((b) => b.onclick = () => { const x = c.people.find((y) => y.user_id === b.dataset.r2fa);
      fixForm(`🔐 Reset two-step sign-in for ${esc(x.name)}`, '<b>Check who they are first.</b> Never reset it just because someone asks by email or chat: call them back on the phone number already on file, or check another way you trust.',
        '<label class="f"><span>How did you check who they are?</span><input name="how" required minlength="6" maxlength="200" placeholder="e.g. called back on the number on file"></label>',
        async (f, reason, ticket) => { await api.reset2fa(id, x.user_id, String(f.get('how')).trim(), reason, ticket); await reopen(); flash(`Two-step sign-in reset for ${x.name}. They've been emailed.`); }, 'Reset it'); });
  }
  const copyBtn = (text) => (text ? `<button class="btn sm cp" type="button" data-copy="${esc(text)}" title="Copy" aria-label="Copy ${esc(text)}">Copy</button>` : '');

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
        ${r.can_work ? `<form id="rf" class="card rbox"><div class="row"><label class="opt"><input type="radio" name="kind" value="reply" checked> Send customer reply <small class="muted">(they see it)</small></label><label class="opt"><input type="radio" name="kind" value="note"> Add internal note <small class="muted">(staff only)</small></label>
          ${saved.length ? `<select id="ins" aria-label="Insert a saved reply"><option value="">Insert a saved reply…</option>${saved.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select>` : ''}</div>
          <textarea name="msg" rows="5" required maxlength="5000" placeholder="Write your reply…"></textarea>
          <div class="row"><label class="small" id="thenl">Then <select name="then"><option value="waiting_customer">wait for the customer</option><option value="done">mark done</option><option value="waiting_us">keep it with us</option></select></label>
          <span style="flex:1"></span><button class="btn p" id="send">Send customer reply</button></div></form>`
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
          <button class="btn sm" id="tco" style="margin-top:8px">Open customer page</button></div>` : '<div class="card"><p class="muted small">Not linked to a business.</p></div>'}
        ${(r.refunds || []).length ? `<div class="card small"><h3>Refund requests</h3>${r.refunds.map((f) => `<div><span class="code">${esc(f.ref)}</span> ${cur(f.amount, f.currency)} · ${pill(RSTAT, f.status)}</div>`).join('')}</div>` : ''}</div></div></div>`;
    const done = async () => { await loadInbox(); await openTicket(id); };
    const act = async (fn) => { try { await fn(); await done(); } catch (err) { alert(plain(err)); await done(); } };
    tv.querySelector('#tback').onclick = () => { S.ticket = null; tv.innerHTML = ''; document.querySelector('.sup').classList.remove('open'); };
    document.querySelector('.sup').classList.add('open');
    const rf = tv.querySelector('#rf');
    if (rf) {
      const sync = () => { const note = rf.querySelector('[name=kind]:checked').value === 'note'; rf.classList.toggle('isnote', note); tv.querySelector('#send').textContent = note ? 'Add internal note' : 'Send customer reply'; tv.querySelector('#thenl').hidden = note; };
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
    return `<div class="card rcard" data-rf="${esc(f.id)}"><div class="row"><span class="code">${esc(f.ref)}</span>${refundPill(f)}<b>${cur(f.amount, f.currency)}</b><span class="muted small">· ${f.workspace_id ? `<a href="#" data-goco="${esc(f.workspace_id)}" data-cptab="money">${esc(f.business || 'the business')}</a>` : esc(f.business || '')} · ${ago(f.created_at)}</span>
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
        <span class="muted small">· <a href="#" data-goco="${esc(o.workspace_id)}" data-cptab="programs">${esc(o.business || 'the business')}</a> · ${esc(o.kind === 'account' ? 'all paid programs' : o.modules.map(modName).join(', '))} · asked by ${esc(o.requested_by_name || '')} ${ago(o.created_at)}</span></div>
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
    const row = (c, extra) => `<tr class="click" data-co="${esc(c.id)}"><td><b>${esc(c.name)}</b><small class="code">${esc(c.company_code || '')}</small></td><td>${esc(c.kind === 'personal' ? 'Just me' : 'Business')}</td><td>${ago(c.last_active_at)}<small>${day(c.last_active_at)}</small></td>${extra}</tr>`;
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
    m.querySelectorAll('tr[data-co]').forEach((x) => x.onclick = (e) => { if (!e.target.closest('input,button,label')) openCompany(x.dataset.co); });
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
      ${owner ? `<div class="card" style="margin-top:14px"><h3>Add someone to the HQ team</h3><p class="muted small">They need a Riyeser account first (riyeser.com/link), and must turn on two-step sign-in there.</p>
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

  // ------------------------------------------------------------------ reports (reports.view): every table downloads as CSV
  const RANGES = [[30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 365 days']];
  async function reports() {
    S.rr = S.rr || 90;
    const to = today(); const from = plusDays(to, -S.rr);
    const m = main(`<h2>Reports</h2><p class="sub">How Riyeser is going: sign-ups, trials, money, who's leaving, support and the HQ team. Every table downloads as CSV.</p>
      <div class="chips" id="ranges">${RANGES.map(([n, l]) => `<button class="chip${S.rr === n ? ' on' : ''}" data-range="${n}">${l}</button>`).join('')}<span class="muted small rr">${day(from)} to ${day(to)}</span></div>
      <div id="rep"><p class="muted">Loading…</p></div>`);
    m.querySelectorAll('[data-range]').forEach((b) => b.onclick = () => { S.rr = Number(b.dataset.range); reports(); });
    const r = await api.reports(from, to);
    const T = {}; // CSV tables by name
    const table = (key, header, rows, opts = {}) => { T[key] = { header, rows: rows.map((x) => x.map((v) => (v && typeof v === 'object' ? v.csv : v))) };
      return `<div class="scroll"><table class="tbl rtbl" data-table="${key}"><tr>${header.map((h, i) => `<th${opts.num && opts.num.includes(i) ? ' class="n"' : ''}>${esc(h)}</th>`).join('')}</tr>
        ${rows.length ? rows.map((x, ri) => `<tr${opts.co ? ` class="click" data-co="${esc(opts.co(ri))}"` : ''}>${x.map((v, i) => `<td${opts.num && opts.num.includes(i) ? ' class="n"' : ''}>${v && typeof v === 'object' ? v.html : typeof v === 'number' ? num(v) : esc(v ?? '')}</td>`).join('')}</tr>`).join('')
          : `<tr><td colspan="${header.length}" class="muted">Nothing in this range.</td></tr>`}</table></div>`; };
    const csvBtn = (key) => `<button class="btn sm right" data-csv="${key}">⬇ CSV</button>`;
    const wkLabel = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const moLabel = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
    const fn = r.funnel || {}; const steps = [['Signed up', fn.signed_up], ['Email confirmed', fn.confirmed], ['Business set up', fn.business], ['PC linked', fn.pc_linked], ['A program used', fn.program_used]];
    const te = r.trials_ending || []; const tb = (n) => te.filter((x) => x.days_left <= n).length;
    const rev = r.revenue_by_month || []; const sup = r.support || {}; const lv = r.leaving_by_month || [];
    const by = (o, map) => Object.entries(o || {}).map(([k, v]) => [map ? map(k) : k, Number(v)]);
    const box = (id, title, sub, body, key) => `<div class="card rcard2" id="${id}"><h3>${title}${sub ? ` <small>· ${sub}</small>` : ''}${key ? csvBtn(key) : ''}</h3>${body}</div>`;
    m.querySelector('#rep').innerHTML = `
      <h3 class="h3">Sign-ups</h3><div class="grid g2">
        ${box('rSignups', 'New businesses per week', '', columnChart(r.signups_by_week || [], (x) => wkLabel(x.week), (x) => Number(x.n), 'businesses')
          + table('signups', ['Week starting', 'New businesses'], (r.signups_by_week || []).map((x) => [day(x.week), Number(x.n)]), { num: [1] }), 'signups')}
        ${box('rFunnel', 'Sign-up funnel', 'people who signed up in this range', barList(steps.map(([l, v]) => ({ l, v: Number(v || 0) })), (x) => x.l, (x) => x.v)
          + table('funnel', ['Step', 'People', 'Of those who signed up'], steps.map(([l, v]) => [l, Number(v || 0), pct(Number(v || 0), Number(fn.signed_up || 0))]), { num: [1, 2] }), 'funnel')}</div>
      <h3 class="h3">Trials</h3><div class="grid g2">
        ${box('rTrials', 'Trials started per week', 'a new business starts free trials of every paid program', columnChart(r.trials_by_week || [], (x) => wkLabel(x.week), (x) => Number(x.n), 'businesses')
          + table('trials', ['Week starting', 'Businesses starting trials'], (r.trials_by_week || []).map((x) => [day(x.week), Number(x.n)]), { num: [1] }), 'trials')}
        ${box('rEnding', 'Trials ending soon', 'not paying yet: follow these up', `<div class="tiles t3">${tile('In 7 days', num(tb(7)))}${tile('In 14 days', num(tb(14)))}${tile('In 30 days', num(tb(30)))}</div>`
          + table('trials_ending', ['Business', 'Programs', 'Ends', 'Days left'], te.slice(0, 200).map((x) => [{ html: `<b>${esc(x.name)}</b><small class="code">${esc(x.company_code || '')}</small>`, csv: x.name },
            { html: esc((x.modules || []).length === 7 ? 'Every program' : (x.modules || []).map(modName).join(', ')), csv: (x.modules || []).map(modName).join('; ') }, day(x.trial_ends), { html: daysPill(x.days_left), csv: x.days_left }]),
          { co: (i) => te[i].id }), 'trials_ending')}
        ${box('rConv', 'Trials that became paid', 'by program', table('conversion', ['Program', 'Paid (30 days)', 'Trials ended or paid (30 days)', 'Rate', 'Paid (90 days)', 'Trials ended or paid (90 days)', 'Rate'],
          (r.conversion || []).map((x) => [modName(x.module), Number(x.paid_30), Number(x.ended_30), pct(Number(x.paid_30), Number(x.ended_30)), Number(x.paid_90), Number(x.ended_90), pct(Number(x.paid_90), Number(x.ended_90))]), { num: [1, 2, 3, 4, 5, 6] }), 'conversion')}</div>
      <h3 class="h3">Revenue estimate <small class="muted">· list prices, an estimate until payments are connected</small></h3>
      <div class="banner est">Estimate until payments are connected: worked out from paid-until dates and plans at list prices, not from money received.</div>
      <div class="grid g2">
        ${box('rRevenue', 'Monthly estimate by month', `now about ${money(r.monthly_now)} a month`, columnChart(rev, (x) => moLabel(x.month), (x) => Number(x.estimate), 'dollars (estimate)')
          + table('revenue', ['Month', 'Estimate', 'Paying businesses', 'New paid programs', 'Lost programs'], rev.map((x) => [moLabel(x.month), { html: money(x.estimate), csv: x.estimate }, Number(x.paying), Number(x.new_paid), Number(x.lost)]), { num: [1, 2, 3, 4] }), 'revenue')}
        ${box('rProgram', 'By program', 'paying now', barList(r.revenue_by_program || [], (x) => modName(x.module), (x) => Number(x.paying))
          + table('revenue_program', ['Program', 'Paying businesses', 'A month (estimate)'], (r.revenue_by_program || []).map((x) => [modName(x.module), Number(x.paying), { html: money(x.estimate), csv: x.estimate }]), { num: [1, 2] }), 'revenue_program')}</div>
      <h3 class="h3">Leaving</h3><div class="grid g2">
        ${box('rLeaving', 'Businesses closed by month', 'closed or suspended, including for being inactive', columnChart(lv, (x) => moLabel(x.month), (x) => Number(x.closed), 'businesses'), '')}
        ${box('rLeaving2', 'Leaving by month', '', table('leaving', ['Month', 'Closed', 'Closed for being inactive', 'Programs cancelled', 'Went quiet (60+ days)'],
          lv.map((x) => [moLabel(x.month), Number(x.closed), Number(x.closed_inactive), Number(x.cancelled), Number(x.went_quiet)]), { num: [1, 2, 3, 4] }), 'leaving')}</div>
      <h3 class="h3">Support</h3>
      <div class="tiles">${tile('Open tickets', num(by(sup.open_by_status).reduce((a, x) => a + x[1], 0)), `${num(sup.opened)} opened in this range`)}${tile('Overdue', num(sup.overdue), 'no first reply in time')}
        ${tile('Median first reply', sup.median_first_reply_hours != null ? dur(Number(sup.median_first_reply_hours)) : '—', 'tickets opened in this range')}${tile('Satisfaction', '—', 'coming: asking customers after a ticket is done')}</div>
      <div class="grid g2">
        ${box('rSupStatus', 'Open tickets by status and level', '', table('support_open', ['Status or level', 'Open tickets'],
          [...by(sup.open_by_status, (k) => (TSTAT[k] || [k])[0]), ...by(sup.open_by_level, (k) => `Level ${k} · ${LEVELS[k] || ''}`)].map(([k, v]) => [k, v]), { num: [1] }), 'support_open')}
        ${box('rTopics', 'Tickets by topic', 'opened in this range', barList(sup.by_topic || [], (x) => TOPICS[x.topic] || x.topic, (x) => Number(x.n))
          + table('support_topics', ['Topic', 'Tickets'], (sup.by_topic || []).map((x) => [TOPICS[x.topic] || x.topic, Number(x.n)]), { num: [1] }), 'support_topics')}</div>
      <h3 class="h3">HQ team</h3><div class="grid g2">
        ${box('rStaff', 'Actions per staff member this week', 'changes, not counting opening pages', barList(r.staff_week || [], (x) => x.who, (x) => Number(x.changes))
          + table('staff_week', ['Staff', 'Changes', 'Everything (with pages opened)'], (r.staff_week || []).map((x) => [x.who, Number(x.changes), Number(x.total)]), { num: [1, 2] }), 'staff_week')}
        ${box('rStaff2', 'Actions per staff member in this range', '', table('staff_range', ['Staff', 'Changes', 'Everything (with pages opened)'], (r.staff_range || []).map((x) => [x.who, Number(x.changes), Number(x.total)]), { num: [1, 2] }), 'staff_range')}</div>`;
    m.querySelectorAll('[data-csv]').forEach((b) => b.onclick = () => { const t = T[b.dataset.csv]; if (t) csvFile(`report-${b.dataset.csv}-${S.rr}d`, t.header, t.rows); });
    m.querySelectorAll('tr[data-co]').forEach((x) => x.onclick = () => openCompany(x.dataset.co, 'programs'));
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
  }
  function downloadCsv(rows) {
    csvFile('history', ['When (UTC)', 'Who', 'Action', 'What', 'Business', 'Ticket', 'Details'], rows.map((h) => [h.at, h.who, h.action, HIST_ACTS[h.action] || '',
      h.business || (S.companies.find((c) => c.id === (h.workspace_id || (h.details || {}).workspace_id)) || {}).name || '', h.ticket || (h.details || {}).ticket || '', JSON.stringify(h.details || {})]));
  }

  window.RiyeserHQ = { state: S, demo: DEMO, openCompany };
  start();
})();
