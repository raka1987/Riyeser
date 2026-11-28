/* Riyeser HQ: the back office for running Riyeser. Riyeser staff only, with two-step sign-in.
   Shows account information (companies, people counts, branches, linked PCs and versions, trials, Riyeser Link,
   downloads, notes), support tickets, refunds, free periods and the staff history. It never sees customers' chat
   messages, calls or books: the database only offers hq_ summaries. Support tickets are written to Riyeser, so HQ sees those.
   Every button is checked again by the database (hq_need); the website only hides what you can't do.
   Runs on the Riyeser Link (formerly Riyeser Team) Supabase project (../link/config.js). With ?demo, or before it's set up, sample data. */
(() => {
  'use strict';
  const CFG = window.RIYESER_TEAM || {};
  const CONFIGURED = !!(CFG.supabaseUrl && CFG.supabaseKey);
  const DEMO = new URLSearchParams(location.search).has('demo') || !CONFIGURED;
  // HQ V2 (a prototype of the new layout, Phase 0): only with ?v2=1 (remembered on this browser; ?v2=0 switches it off).
  // Without it nothing below changes: hq-v2.js and hq-v2.css aren't even loaded.
  const V2 = (() => { const q = new URLSearchParams(location.search).get('v2');
    try { if (q === '1') localStorage.setItem('hq.v2', '1'); else if (q === '0') localStorage.removeItem('hq.v2'); return localStorage.getItem('hq.v2') === '1'; } catch { return q === '1'; } })();
  const SELF = (document.currentScript && document.currentScript.src) || '';
  // The code repository (GitHub jobs: backups, restore tests). Once it's private, GitHub only shows its jobs to
  // signed-in members, so "System health" says they're not shown here and the GitHub jobs button still opens them.
  const REPO = 'raka1987/Riyeser';
  // The public downloads repository, where releases are published (docs/GOING-PRIVATE.md on main): change its name here.
  // Raw GitHub counts add up both: older releases (and copies during the switch) are in the code repository.
  const DOWNLOADS_REPO = 'raka1987/riyeser-downloads';
  const $app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // The Riyeser wordmark (assets/logo-wordmark.svg, the same paths, drawn inline): the letters take the text colour,
  // the swoosh is brand blue (lighter on dark backgrounds, see .wm-sw in the CSS). wordmark(false) when a link around it carries the name.
  const WM_SW = 'M2 29C62 15 172 8 266 11C178 15 78 23 7 41Z';
  const WM_WORD = 'M-0.3 0H20L23.7 -22.8H33.2L40.3 0H61L52.1 -27.1C60 -31.3 65.2 -38.3 66.7 -47.4C69.2 -62.9 60 -72.8 42.6 -72.8H11.7ZM26.4 -38.5 29.3 -56.2H38.4C44.5 -56.2 47.8 -52.7 46.9 -47.4C46 -42 41.5 -38.5 35.4 -38.5ZM65 0H84.6L93.1 -51.6H73.6ZM84 -55.8C89.6 -55.8 94.7 -60 95.6 -65.3C96.5 -70.7 92.8 -74.9 87.2 -74.9C81.5 -74.9 76.5 -70.7 75.6 -65.3C74.7 -60 78.4 -55.8 84 -55.8ZM90.1 20.4H103.4C112.7 20.4 118.2 16.6 123.6 6.5L155 -51.6H134.1L123.8 -29.7C122.2 -26.4 120.7 -23 119.2 -19.6C118.9 -23 118.5 -26.4 118.1 -29.7L115.2 -51.6H95.7L106.9 0L106.5 0.8C104.7 4.3 104 5.6 100.4 5.6H92.6ZM176 1.2C191.1 1.2 200.6 -6.2 204.3 -17.6H186.5C185.5 -14.5 183 -12.5 177.6 -12.5C171.5 -12.5 169.8 -15.1 169.8 -19.6C192.2 -19.9 206.2 -21.8 206.2 -35.6C206.2 -47.4 196 -52.7 183.6 -52.7C166.7 -52.7 154.1 -42.7 151.3 -25.8C148.4 -8.1 158.4 1.2 176 1.2ZM171.2 -31.1C172.2 -35.4 174.5 -39 181.5 -39C185.9 -39 188.4 -37.6 188.4 -35.4C188.4 -33 185.7 -31.5 171.2 -31.1ZM231.1 1.3C247.3 1.3 259 -7.3 259 -18.6C259 -25.5 254.4 -29.4 244.5 -31.2L233.8 -33C231.4 -33.4 230.3 -34.3 230.3 -35.7C230.3 -38 233.1 -39.7 236.8 -39.7C240.7 -39.7 242.9 -37.7 242.6 -34.4H260.4C260.5 -35.3 260.6 -36.3 260.6 -37.1C260.6 -46.6 251.7 -52.6 237.4 -52.6C221.5 -52.6 210.5 -44.9 210.5 -33.6C210.5 -26.3 215.5 -21.5 224.9 -20L234.3 -18.4C237.5 -17.9 238.8 -17 238.8 -15.5C238.8 -13.3 235.8 -11.7 231.9 -11.7C227.8 -11.7 225.5 -13.5 225.6 -16.8H206.5V-16.4C206.5 -5.6 216.6 1.3 231.1 1.3ZM287.5 1.2C302.6 1.2 312.1 -6.2 315.9 -17.6H298C297.1 -14.5 294.5 -12.5 289.2 -12.5C283 -12.5 281.3 -15.1 281.3 -19.6C303.8 -19.9 317.7 -21.8 317.7 -35.6C317.7 -47.4 307.5 -52.7 295.1 -52.7C278.2 -52.7 265.6 -42.7 262.8 -25.8C259.9 -8.1 270 1.2 287.5 1.2ZM282.8 -31.1C283.7 -35.4 286 -39 293.1 -39C297.5 -39 300 -37.6 300 -35.4C300 -33 297.2 -31.5 282.8 -31.1ZM317.7 0H337.3L341.4 -24.7C342.5 -31.6 347.1 -35.9 353.2 -35.9H360.3L362.9 -51.6H358C350.9 -51.6 346.8 -49.1 343.8 -42.2H343.7L345.2 -51.6H326.3ZM369.8 0.9C374.9 0.9 379.6 -3 380.5 -8C381.5 -14.2 377.3 -19.4 371.2 -19.4C366.1 -19.4 361.4 -15.5 360.5 -10.5C359.5 -4.2 363.7 0.9 369.8 0.9Z';
  const wordmark = (named = true) => `<svg class="wm" viewBox="-3 -78 388 121" ${named ? 'role="img" aria-label="Riyeser"' : 'aria-hidden="true"'} focusable="false"><path class="wm-sw" fill="#0b5cff" d="${WM_SW}"/><path fill="currentColor" d="${WM_WORD}"/></svg>`;
  const num = (n) => Number(n || 0).toLocaleString();
  const day = (t) => (t ? new Date(String(t).length === 10 ? t + 'T00:00:00' : t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : Math.round(m / 1440) === 1 ? '1 day ago' : `${Math.round(m / 1440)} days ago`; };
  const hours = (a, b = Date.now()) => (new Date(b) - new Date(a)) / 3600000;
  const dur = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);
  const ROLES = [['owner', 'Owner'], ['admin', 'Admin'], ['finance', 'Finance'], ['support', 'Support'], ['senior', 'Senior support'], ['sales', 'Sales'], ['developer', 'Developer']];
  // Role names by key: the built-in ones, plus custom roles from the database once HQ team or hq_me has loaded them.
  const ROLE_NAMES = Object.fromEntries(ROLES);
  const roleName = (r) => ROLE_NAMES[r] || (r && String(r).startsWith('c_') ? 'Custom role' : r);
  // The paid programs A to Z (as everywhere else). 'calls' is Riyeser Link (chat, calls, desk phones, Link Office).
  // Riyeser Estimate ('estimate'): free for 90 days from first use, then US$20 a month (not part of any bundle).
  const MODULES = [['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['bookings', 'Bookings'], ['calls', 'Riyeser Link'], ['payroll', 'Payroll'], ['pos', 'POS'], ['as_built', 'As Built'], ['estimate', 'Riyeser Estimate']];
  const modName = (m) => (MODULES.find((x) => x[0] === m) || [m, m])[1];
  // List prices: US dollars a month per business (the same as riyeser_price() in team-chat.sql and website/prices.mjs).
  // Each paid program includes 3 users, then US$7 a month each for that program; Plus includes Basics (never both).
  // POS: 1 till included (unlimited cashiers), US$15 a till after. Bundles replace their programs' prices (riyeser_plan).
  const PRICE = { basic: 25, plus: 39, bookings: 25, calls: 20, payroll: 25, pos: 29, as_built: 29, estimate: 20, users_included: 3, extra_user: 7, tills_included: 1, extra_till: 15, extra_company: 10 };
  const BUNDLES = [{ id: 'shop', name: 'Shop', mods: ['basic', 'pos', 'calls'], price: 59 }, { id: 'office', name: 'Office', mods: ['basic', 'payroll', 'calls'], price: 59 },
    { id: 'business', name: 'Business', mods: ['plus', 'bookings', 'calls', 'payroll', 'pos'], price: 99 }];
  /** The same sums as riyeser_plan in team-chat.sql: each program + US$7 per user over 3 (POS: tills), the best bundle. */
  function planOf(mods, users, tills) {
    const m = MODULES.map((x) => x[0]).filter((k) => mods.includes(k) && !(k === 'basic' && mods.includes('plus')));
    const u = (k) => Math.max(1, Number(typeof users === 'number' ? users : (users || {})[k]) || PRICE.users_included); const t = Math.max(1, Number(tills) || 1);
    let best = null; let save = 0;
    BUNDLES.forEach((b) => { if (!b.mods.every((x) => m.includes(x))) return; const v = b.mods.reduce((a, x) => a + PRICE[x], 0) - b.price; if (v > save) { save = v; best = b; } });
    const ex = (list) => list.reduce((a, x) => a + (x === 'pos' ? (t - 1) * PRICE.extra_till : Math.max(0, u(x) - PRICE.users_included) * PRICE.extra_user), 0);
    const lines = [];
    if (best) lines.push({ name: `${best.name} bundle (${best.mods.map(modName).join(', ')})`, bundle: best.id, monthly: best.price + ex(best.mods) });
    m.filter((k) => !best || !best.mods.includes(k)).forEach((k) => lines.push({ name: modName(k), module: k, monthly: PRICE[k] + ex([k]) }));
    return { mods: m, bundle: best ? best.id : null, lines, total: lines.reduce((a, l) => a + l.monthly, 0) };
  }
  const GB = 1073741824;
  const gbText = (n) => { const g = Number(n || 0) / GB; return `${g >= 10 || Number.isInteger(g) ? Math.round(g) : g.toFixed(1)} GB`; };
  const money = (n) => 'US$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const cur = (n, c) => `${esc(c || 'USD')} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const statusPill = (v) => (v.status === 'active' ? `<span class="pill ok">Paid${v.paid_until ? ` to ${day(v.paid_until)}` : ''}</span>`
    : v.status === 'trial' ? `<span class="pill${v.days_left <= 14 ? ' warn' : ''}">Trial · ${v.days_left} days</span>`
    : v.status === 'cancelled' ? (v.active ? `<span class="pill warn">Cancelled · works to ${day(v.paid_until)}</span>` : '<span class="pill bad">Cancelled</span>')
    : v.status === 'closed' ? '<span class="pill bad">Business closed</span>' : '<span class="pill bad">Ended</span>');
  // Which program each installer is (older file names included).
  const PRODUCT = [[/Central/i, 'Riyeser Central'], [/AccountingBasics/i, 'Accounting Basics'], [/Accounting(Plus)?-Setup|AccountingPlus/i, 'Accounting Plus'],
    [/POS/i, 'POS'], [/Invoices/i, 'Invoices'], [/Bookings/i, 'Bookings'], [/Payroll/i, 'Payroll'], [/DeskAssistant|Documents-Setup/i, 'Riyeser Documents'],
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

  // Permissions (the same list as the database's hq_all_perms), in plain English, in groups, each with what it allows.
  // The database is the source of truth for every role's ticks (hq_roles / hq_role_permissions); ROLE_PERMS below are the
  // shipped built-in ticks (hq_builtin_perms), used by the demo and by a database that hasn't had the latest team-chat.sql.
  const PERM_GROUPS = [
    ['Everyday', [
      ['overview.view', 'See the overview', 'The HQ home: counts, the work queue, system health and the team handover.'],
      ['downloads.view', 'See downloads', 'How many times each program has been downloaded.']]],
    ['Customers', [
      ['customers.view', 'See customer accounts', 'Business name, Company ID, country, the owner\'s contact details, linked PCs and versions. Never their books, chats or files.'],
      ['customers.notes', 'Add internal notes', 'Write notes on a customer page. Only HQ staff see them.'],
      ['customers.edit', 'Edit business details', 'Correct a business\'s name, address or contact email (with a reason, kept in the HQ history).'],
      ['people.reset_2fa', 'Reset a customer\'s two-step sign-in', 'For someone who has lost their phone. It never shows their password.'],
      ['people.change_owner', 'Change a business\'s owner', 'Hand a business over to another of its people.'],
      ['business.close', 'Close, suspend or reopen a business', 'Stop or restart a business\'s account, with a reason.'],
      ['accounts.inactive', 'Approve removing inactive accounts', 'Remove accounts that have been closed and unused for a long time.'],
      ['test_accounts.manage', 'Mark test accounts', 'Mark an account as test, demo or internal so business figures leave it out.']]],
    ['Licences and money', [
      ['licences.view', 'See customer licences', 'Licences, plans, Riyeser\'s invoices and payments, and monthly revenue.'],
      ['licences.manage', 'Change licences', 'Change plans and paid-until dates, mark bank transfers paid and give extra storage.'],
      ['invoices.email', 'Email invoices and receipts', 'Send a customer\'s invoice or receipt again. Finance and the Owner have it; only the Owner can give it to anyone else.'],
      ['refunds.view', 'See refunds', 'Refund requests and what was decided.'],
      ['refunds.request', 'Enter a refund request', 'Start a refund for a customer. Someone else approves it.'],
      ['refunds.approve', 'Approve refunds', 'Say yes or no to refunds. Big refunds need a second person too.'],
      ['refunds.pay', 'Mark refunds paid', 'Record that an approved refund has been paid.'],
      ['offers.grant', 'Give free periods', 'Short free periods apply straight away; longer ones wait for approval.'],
      ['offers.approve', 'Approve free periods', 'Approve longer free periods (supervisor).']]],
    ['Support', [
      ['support.view', 'See tickets', 'Read customers\' help requests.'],
      ['support.reply', 'Answer tickets (level 1)', 'Reply to customers and add internal notes on level 1 tickets.'],
      ['support.level2', 'Work level 2 tickets (senior)', 'Work tickets passed up to senior or technical support.'],
      ['support.level3', 'Work level 3 tickets (management)', 'Work tickets passed up to management.'],
      ['support.assign', 'Assign tickets', 'Give a ticket to someone on the team.'],
      ['support.escalate', 'Escalate tickets', 'Pass a ticket up a level, or send it back down.'],
      ['support.saved_replies', 'Manage saved replies', 'Add, change and retire the team\'s saved replies.'],
      ['support.diagnostics', 'Look up diagnostic reports', 'Read the report a PC sends with a ticket. Passwords and keys are already removed from it.'],
      ['link.support', 'Riyeser Link phone help', 'Help with a customer\'s phones while they allow it (1 hour). Never shows a phone password.'],
      ['trials.view', 'See trial history', 'A PC\'s free-trial dates, from a ticket\'s report.']]],
    ['Emails and reports', [
      ['emails.view', 'See the email outbox', 'Which emails HQ has sent, and any that are held or failed.'],
      ['emails.manage', 'Send held or failed emails again', 'Try a held or failed email again.'],
      ['reports.view', 'See reports and website traffic', 'Sign-ups, trials, the revenue estimate, leaving, support and website visits.']]],
    ['Running HQ', [
      ['staff.manage', 'Manage the HQ team', 'Add people, choose their role and ticks, and make roles. Never more than they can do themselves.'],
      ['settings.manage', 'Change HQ settings', 'Ticket timings, refund and free-period limits, and similar settings.'],
      ['audit.view', 'See the HQ history', 'Every HQ action: who did what, and when.'],
      ['ops.view', 'See system operations', 'Integrations, backups and restore tests.']]]];
  const PERMS = PERM_GROUPS.flatMap(([, list]) => list.map(([k, l]) => [k, l]));
  const PERM_HINT = Object.fromEntries(PERM_GROUPS.flatMap(([, list]) => list.map(([k, , h]) => [k, h])));
  const permLabel = (k) => (PERMS.find((x) => x[0] === k) || [k, k])[1];
  // Only the Owner can give these (SEC-010), and nobody can ever be given what's on NEVER (the database refuses it too).
  const OWNER_ONLY = ['invoices.email'];
  const NEVER = ['See any password, phone (SIP) password or secret', 'Change Riyeser\'s bank details (only the Owner)', 'Make or change an Owner (only an Owner)', 'Get past two-step sign-in'];
  const ROLE_DESC = { owner: 'Everything, always, including Riyeser\'s billing and bank details. Only an Owner makes another Owner.',
    admin: 'Runs the HQ team, settings, the HQ history and operations. No money, licences, refunds or bank details.',
    finance: 'Licences, invoices and payments, refunds and free periods, and emailing invoices and receipts.',
    support: 'Level 1 help: tickets, customer details, diagnostics, two-step sign-in resets and Link phone help.',
    senior: 'Everything Support does, plus level 2 tickets, owner changes, closing businesses and resending emails.',
    sales: 'Customer accounts and licence state, notes, and free periods within the limit.',
    developer: 'The overview, downloads, sanitised diagnostic reports and system operations. No customer list.' };
  const BASE = ['overview.view', 'downloads.view'];
  const ROLE_PERMS = {
    owner: PERMS.map((p) => p[0]),
    // Finance: money, and billing tickets at level 1 (owner's decision: not level 2/3 ticket work by default)
    finance: [...BASE, 'customers.view', 'customers.notes', 'licences.view', 'licences.manage', 'support.view', 'support.reply',
      'support.escalate', 'refunds.view', 'refunds.approve', 'refunds.pay', 'offers.grant', 'offers.approve', 'emails.view', 'reports.view', 'trials.view', 'invoices.email'],
    // Admin: the HQ team, settings, history and operations; no money, licences, refunds or bank details
    admin: [...BASE, 'customers.view', 'customers.notes', 'emails.view', 'emails.manage', 'audit.view', 'staff.manage', 'settings.manage', 'ops.view', 'test_accounts.manage'],
    support: [...BASE, 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa', 'licences.view', 'support.view', 'support.reply', 'support.assign',
      'support.saved_replies', 'support.escalate', 'refunds.view', 'refunds.request', 'offers.grant', 'emails.view', 'link.support', 'support.diagnostics', 'ops.view', 'trials.view'],
    senior: [...BASE, 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa', 'people.change_owner', 'business.close', 'licences.view', 'support.view',
      'support.reply', 'support.assign', 'support.saved_replies', 'support.escalate', 'support.level2', 'refunds.view', 'refunds.request', 'offers.grant', 'emails.view', 'emails.manage', 'link.support', 'reports.view',
      'support.diagnostics', 'ops.view', 'test_accounts.manage'],
    sales: [...BASE, 'customers.view', 'customers.notes', 'licences.view', 'support.view', 'offers.grant'],
    developer: [...BASE, 'support.diagnostics', 'ops.view'],
  };
  const permsOf = (s) => (s.role === 'owner' ? ROLE_PERMS.owner : [...new Set([...(ROLE_PERMS[s.role] || []), ...(s.perms_add || [])])].filter((p) => !(s.perms_remove || []).includes(p)));
  const LEVELS = { 1: 'Support', 2: 'Senior', 3: 'Management' };
  const LEVEL_PERM = { 1: 'support.reply', 2: 'support.level2', 3: 'support.level3' };
  const TOPICS = { billing: 'Billing', signin: 'Signing in', program: 'A program problem', other: 'Something else' };
  // Ticket statuses. waiting_us is "In progress": back with Riyeser (e.g. the customer replied or said it's still happening).
  const TSTAT = { new: ['New', 'warn'], investigating: ['Investigating', 'blue'], waiting_us: ['In progress', 'violet'], waiting_customer: ['Waiting on customer', ''], done: ['Resolved', 'ok'] };
  const TSTAT_ORDER = ['new', 'investigating', 'waiting_us', 'waiting_customer', 'done'];
  // The products a ticket can be about (support_products() in team-chat.sql), with an icon for the inbox.
  const PRODUCTS = [['central', 'Riyeser Central', '🏠'], ['accounting', 'Accounting', '📒'], ['invoices', 'Invoices', '🧾'], ['pos', 'POS', '🛒'], ['bookings', 'Bookings', '📅'],
    ['payroll', 'Payroll', '🕒'], ['link', 'Riyeser Link', '💬'], ['linkoffice', 'Link Office', '☎️'], ['pdf', 'Riyeser PDF', '📕'], ['desk', 'Riyeser Documents', '🗂'],
    ['website', 'riyeser.com', '🌐'], ['other', 'Something else', '❔']];
  const prodName = (p) => (PRODUCTS.find((x) => x[0] === p) || [p, p ? 'Something else' : 'Not set'])[1];
  const prodIcon = (p) => (PRODUCTS.find((x) => x[0] === p) || [0, 0, '🎧'])[2];
  // Program ids in devices.programs (from Riyeser Central) for each product.
  const PRODUCT_APPS = { central: ['central'], accounting: ['accounting', 'accounting-basics'], invoices: ['invoices'], pos: ['pos'], bookings: ['bookings'], payroll: ['payroll'],
    link: ['team'], linkoffice: ['linkoffice'], pdf: ['pdf'], desk: ['desk'] };
  const APP_NAMES = { central: 'Central', accounting: 'Accounting Plus', 'accounting-basics': 'Accounting Basics', invoices: 'Invoices', pos: 'POS', bookings: 'Bookings', payroll: 'Payroll',
    team: 'Riyeser Link', linkoffice: 'Link Office', pdf: 'PDF', desk: 'Documents', services: 'As Built', estimate: 'Estimate' };
  // "3:00 pm Fri" (this week) or "3:00 pm Fri 5 Dec"
  const dueText = (t) => { const d = new Date(t); const tm = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(/\s?([ap])\.?m\.?/i, ' $1m').toLowerCase();
    const wd = d.toLocaleDateString('en-AU', { weekday: 'short' }); const soon = Math.abs(d - Date.now()) < 6 * 864e5;
    return `${tm} ${wd}${soon ? '' : ' ' + d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`; };
  const RSTAT = { submitted: ['New', 'warn'], reviewing: ['Reviewing', ''], approved: ['Approved', 'ok'], partly_approved: ['Partly approved', 'ok'], declined: ['Declined', 'bad'], paid: ['Paid', 'ok'] };
  const RWHY = { mistake: 'Charged by mistake', didnt_work: 'Didn\'t work', cancelled: 'Cancelled', duplicate: 'Duplicate payment', other: 'Other' };
  const PAID_HOW = [['card', 'Card refund'], ['bank', 'Bank transfer'], ['mpaisa', 'M-PAiSA'], ['credit', 'Credit on account']];
  const OFFER_WHY = [['retention', 'Retention'], ['goodwill', 'Goodwill after a problem'], ['promotion', 'Sales promotion'], ['other', 'Other']];
  const OFFER_KIND = { trial: 'Longer free trial', paid: 'Free time on a paid program', account: 'Whole account (all paid programs)' };
  const BSTAT = { active: ['Open', 'ok'], suspended: ['Suspended', 'warn'], closed: ['Closed', 'bad'] };
  const pill = (map, k, extra = '') => { const [l, c] = map[k] || [k, '']; return `<span class="pill${c ? ' ' + c : ''}">${esc(l)}${extra}</span>`; };
  // Close as duplicate: what could make closing this account a mistake (the same list hq_dup_risks makes in the
  // database, which checks it again). a = this account, k = the account being kept (optional).
  function dupRisks(a, k) {
    const r = []; const paid = (x) => Number(x.paid_invoices) > 0 || (x.paid_programs || []).length > 0; const n = Number(a.paid_invoices) || 0;
    if (n > 0) r.push({ code: 'paid_invoices', text: `This account has ${n} paid invoice${n === 1 ? '' : 's'}.` });
    if ((a.paid_programs || []).length) r.push({ code: 'paid_programs', text: 'This account is paying for programs right now.' });
    if (a.last_activity && Date.now() - new Date(a.last_activity) < 14 * 864e5) r.push({ code: 'recent', text: 'Someone used this account in the last 14 days.' });
    if (k) {
      if ((a.owner_id || null) !== (k.owner_id || null)) r.push({ code: 'owner', text: 'The account you\'re keeping has a different owner.' });
      if (paid(a) && !paid(k)) r.push({ code: 'backwards', text: 'This account has payments and the one you\'re keeping has none. You may be closing the wrong one.' });
      if (Number(a.members) > Number(k.members) || Number(a.pcs) > Number(k.pcs)) r.push({ code: 'bigger', text: 'This account has more people or PCs than the one you\'re keeping.' });
    }
    return r;
  }
  const dupName = (t) => String(t || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\b(pty|ltd|limited|inc|co|company|the|and|copy|new|test|old)\b|[0-9]+\s*$/g, ' ').replace(/[^a-z]/g, '');
  const creditText = (c) => Object.entries(c || {}).filter(([, v]) => Number(v)).map(([k, v]) => cur(v, k)).join(' + ');

  // ------------------------------------------------------------------ online
  function online() {
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, storageKey: 'riyeser.hq.session' } });
    const ok = ({ data, error }) => { if (error) throw error; return data; };
    const rpc = async (f, a) => { try { return ok(await sb.rpc(f, a || {})); } catch (e) { if (ENDED.test(plain(e))) sessionEnded(); throw e; } };
    const fix = (reason, ticket) => ({ reason, ticket_ref: ticket || null });
    return {
      async session() { return ok(await sb.auth.getSession()).session; },
      async signIn(email, password) { ok(await sb.auth.signInWithPassword({ email, password })); },
      // 'local' = this browser only; 'global' = every device this account is signed in on (Supabase ends all its sessions)
      async signOut(scope) { await sb.auth.signOut({ scope: scope === 'global' ? 'global' : 'local' }); },
      async aal() { return ok(await sb.auth.mfa.getAuthenticatorAssuranceLevel()); },
      async factors() { const f = ok(await sb.auth.mfa.listFactors()); return (f.totp || []).filter((x) => x.status === 'verified'); },
      async verify(factorId, code) { ok(await sb.auth.mfa.challengeAndVerify({ factorId, code })); },
      me: () => rpc('hq_me'),
      // with include_test (newer team-chat.sql: test, demo and internal accounts left out unless asked); older databases count everything
      async overview(inc) { try { return await rpc('hq_overview', { include_test: !!inc }); } catch (e) { if (!missing(e)) throw e; return rpc('hq_overview'); } },
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
      // custom HQ roles (each answers "missing" on a database without the latest team-chat.sql)
      setStaffAccess: (staff, role, perms) => rpc('hq_set_staff_access', { staff, staff_role: role, perms }),
      roleSave: (key, name, description, perms) => rpc('hq_role_save', { role_key: key || null, role_name: name, role_description: description, perms }),
      roleDelete: (key, moveTo) => rpc('hq_role_delete', { role_key: key, move_to: moveTo || null }),
      async history(f = {}) {
        try { return await rpc('hq_audit_search', { who: f.who || null, action_like: f.action || null, ws: f.ws || null, from_day: f.from || null, to_day: f.to || null, for_export: !!f.exp }); }
        catch (e) { if (!missing(e) || f.exp) throw e; return rpc('hq_history'); }
      },
      downloadsDaily: (days) => rpc('hq_downloads', { days }), realDownloads: (days) => rpc('hq_real_downloads', { days }),
      licences: () => rpc('hq_licences'), companyLicence: (ws) => rpc('hq_company_licence', { ws }),
      licenceBusinesses: (mod, st) => rpc('hq_licence_businesses', { mod, st }),
      setModule: (ws, mod, status, trialEnd, paidTo) => rpc('hq_set_module', { ws, mod, new_status: status, trial_end: trialEnd || null, paid_to: paidTo || null }),
      grantStorage: (ws, gb, why) => rpc('hq_grant_storage', { ws, gb, why }),
      setPlan: (ws, users, cos, billing, eb) => rpc('hq_set_plan', { ws, users_extra: users, companies_extra: cos, billing_period: billing, is_early_bird: eb }),
      settings: () => rpc('hq_get_settings'), setSetting: (k, v) => rpc('hq_set_setting', { setting: k, val: v }),
      // payments: PayPal subscriptions and bank transfer invoices (team-chat.sql), and the paypal function's status
      billing: () => rpc('hq_billing'), markPaid: (ref, bankRef, amount) => rpc('hq_billing_mark_paid', { invoice_ref: ref, bank_reference: bankRef, paid_amount: amount }),
      setBillingEntity: (d) => rpc('hq_set_billing_entity', { details: d }),
      resendDoc: (ref, to, update) => rpc('hq_billing_resend', { doc_ref: ref, to_email: to || null, update_contact: !!update }),
      // payments received in the last few days; an older database: worked out from the latest payments
      async paymentsReceived(days) {
        try { return await rpc('hq_payments_received', { days }); } catch (e) { if (!missing(e)) throw e; }
        const b = await rpc('hq_billing'); const since = Date.now() - days * 864e5; const ps = (b.payments || []).filter((p) => p.status === 'completed' && new Date(p.at) >= since);
        return { days, count: ps.length, total: ps.reduce((a, p) => a + Number(p.amount || 0), 0) };
      },
      async paypalStatus() { try { const r = await fetch(`${CFG.supabaseUrl}/functions/v1/paypal/status`, { headers: { apikey: CFG.supabaseKey } }); return r.ok ? await r.json() : { deployed: false }; } catch { return { deployed: false }; } },
      // support
      tickets: (box, q) => rpc('hq_tickets', { box, search: q || '' }), ticket: (id) => rpc('hq_ticket', { ticket: id }),
      ticketReply: (id, msg, note, st) => rpc('hq_ticket_reply', { ticket: id, message: msg, as_note: !!note, then_status: st || null }),
      ticketStatus: (id, st) => rpc('hq_ticket_status', { ticket: id, new_status: st }), ticketPriority: (id, p) => rpc('hq_ticket_priority', { ticket: id, new_priority: p }),
      ticketAssign: (id, staff) => rpc('hq_ticket_assign', { ticket: id, staff: staff || null }),
      ticketEscalate: (id, level, reason, assign) => rpc('hq_ticket_escalate', { ticket: id, to_level: level, reason, assign_to: assign || null }),
      // the Support workspace (newer team-chat.sql; before it's re-run the inbox falls back to hq_tickets and the new buttons say how to switch them on)
      async supportInbox(box, q, f) {
        f = f || {};
        try { return await rpc('hq_support_inbox', { box, search: q || '', filters: f || {} }); } catch (e) { if (!missing(e)) throw e; }
        const r = await rpc('hq_tickets', { box: ({ all: f && f.status === 'open' ? 'open' : 'all' })[box] || box, search: q || '' });
        const rows = (r.tickets || []).filter((x) => (!f.owner || (f.owner === 'me' ? x.assignee === (S.me || {}).id : f.owner === 'none' ? !x.assignee : x.assignee === f.owner))
          && (!f.status || (f.status === 'open' ? x.status !== 'done' : x.status === f.status)) && (!f.level || String(x.level) === String(f.level)) && (!f.topic || x.topic === f.topic) && !f.product);
        return { ...r, tickets: rows.map((x) => ({ ...x, who_acts: x.status === 'done' ? null : x.status === 'waiting_customer' ? 'customer' : 'riyeser' })), old: true };
      },
      ticketSet: (id, fields) => rpc('hq_ticket_set', { ticket: id, fields }),
      ticketNextUpdate: (id, due, owner) => rpc('hq_ticket_next_update', { ticket: id, due: due || null, owner: owner || null }),
      ticketLogCall: (id, dir, who, body) => rpc('hq_ticket_log_call', { ticket: id, direction: dir, call_with: who || null, body }),
      // a PC's free-trial history, from the ticket's own report (trials.view), and a goodwill extension (licences.manage)
      ticketTrial: (id) => rpc('hq_ticket_trial', { ticket: id }), trialPcs: () => rpc('hq_trial_pcs'),
      trialExtend: (id, program, days, reason) => rpc('hq_trial_extend', { ticket: id, program, days, reason }),
      diagnostic: (ref) => rpc('hq_diagnostic', { diag_ref: ref }), noteEdit: (id, body) => rpc('hq_note_edit', { note_id: id, note_body: body }),
      savedReplies: () => rpc('hq_saved_replies'), saveReply: (id, title, body) => rpc('hq_save_reply', { reply_id: id || null, title, body }),
      retireReply: (id) => rpc('hq_retire_reply', { reply_id: id }),
      // fix-up tools
      editBusiness: (ws, profile, reason, ticket) => rpc('hq_edit_business', { ws, profile, ...fix(reason, ticket) }),
      reset2fa: (ws, person, how, reason, ticket) => rpc('hq_reset_2fa', { ws, person, identity_checked: how, ...fix(reason, ticket) }),
      changeOwner: (ws, person, reason, ticket) => rpc('hq_change_owner', { ws, new_owner: person, ...fix(reason, ticket) }),
      setBusinessStatus: (ws, st, reason, ticket) => rpc('hq_set_business_status', { ws, new_status: st, ...fix(reason, ticket) }),
      // Close as duplicate closes THIS account; the account kept (keep) is optional. The database re-checks everything.
      dupCheck: (ws) => rpc('hq_dup_check', { ws }), dupSearch: (ws, q) => rpc('hq_dup_search', { ws, search: q }),
      closeDuplicate: (ws, keep, reason, ticket, code, accept) => rpc('hq_close_duplicate', { ws, duplicate_of_ws: keep || null, ...fix(reason, ticket), confirm_code: code, accept_risks: !!accept }),
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
      myFollowUps: () => rpc('hq_my_follow_ups'), reports: (from, to) => rpc('hq_reports', { from_day: from, to_day: to }),
      async attention(inc) { try { return await rpc('hq_attention', { include_test: !!inc }); } catch (e) { if (!missing(e)) throw e; return rpc('hq_attention'); } },
      traffic: (from, to) => rpc('hq_traffic', { from_day: from, to_day: to }),
      // HQ V2 first slice (each answers "missing" on a database without the latest team-chat.sql)
      touch: () => rpc('hq_touch'), kpis: (includeTest) => rpc('hq_kpis', { include_test: !!includeTest }), opsRuns: () => rpc('hq_ops_runs'),
      testAccounts: () => rpc('hq_test_accounts'), setAccountKind: (ws, kind, reason) => rpc('hq_set_account_kind', { ws, new_kind: kind, reason }),
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
    // Riyeser's own accounts in the demo: business figures leave them out unless asked (HQ V2)
    Object.entries({ g12: 'test', g30: 'demo', g45: 'internal' }).forEach(([id, k]) => { const c = cos.find((x) => x.id === id); if (c) c.account_kind = k; });
    cos.forEach((c, i) => { c.owner_phone = c.owner_phone || `555 0${String(100 + i).padStart(3, '0')}`; c.hq_owner = ({ w1: 's2', w2: 's1', w3: 's1', w4: 's4' })[c.id] || (i % 3 === 0 ? 's2' : null);
      c.address = c.address || ({ Fiji: ['Suva', 'Nadi', 'Lautoka'][i % 3], Australia: 'Brisbane', 'New Zealand': 'Auckland', Samoa: 'Apia', Tonga: 'Nuku\'alofa' })[c.country] || ''; });
    let hn = 3; const handover = [{ id: 1, note: 'Northside Dental: call Priya back about the POS printer after 3 pm.', shift_date: new Date().toISOString().slice(0, 10), done: false, by: 'Help Desk', author: 's2', at: t(0.3) },
      { id: 2, note: 'Two trials end in the next 3 days: check they have what they need.', shift_date: new Date().toISOString().slice(0, 10), done: false, by: 'Sam', author: 's1', at: t(0.2) }];
    const staff = [{ user_id: 's1', display_name: 'Sam', role: 'owner', active: true, email: 'sam@riyeser.test', added_at: t(30), perms_add: [], perms_remove: [] },
      { user_id: 's2', display_name: 'Help Desk', role: 'support', active: true, email: 'help@riyeser.test', added_at: t(5), perms_add: [], perms_remove: [] },
      { user_id: 's3', display_name: 'Finance Fi', role: 'finance', active: true, email: 'money@riyeser.test', added_at: t(4), perms_add: [], perms_remove: [] },
      { user_id: 's4', display_name: 'Senior Sione', role: 'senior', active: true, email: 'senior@riyeser.test', added_at: t(3), perms_add: [], perms_remove: [] },
      { user_id: 's5', display_name: 'Admin Ana', role: 'admin', active: true, email: 'admin@riyeser.test', added_at: t(2), perms_add: [], perms_remove: [] }];
    // staff emails: only for whoever manages the HQ team (and your own), as hq_team() in the database
    const staffOut = () => { const all = permsOf(me()).includes('staff.manage'); return staff.map((s) => ({ ...s, role_name: roleName(s.role), email: all || s.user_id === actor ? s.email : null, perms: permsOf(s) })); };
    // custom HQ roles, as hq_roles / hq_role_permissions and the checks in team-chat.sql (hq_access_check, hq_role_save, hq_role_delete)
    const STD = JSON.parse(JSON.stringify(ROLE_PERMS));
    const droles = ROLES.map(([key, name], i) => ({ key, name, description: ROLE_DESC[key], builtin: true, sort: i }));
    const permsFor = (role, add = [], rem = []) => (role === 'owner' ? PERMS.map((p) => p[0]) : [...new Set([...(ROLE_PERMS[role] || []), ...add])].filter((p) => !rem.includes(p)).sort());
    const dCheckList = (list) => { const bad = (list || []).find((p) => !PERMS.some((x) => x[0] === p)); if (bad) throw new Error(/password|secret|bank|bypass|owner\.|two_step|mfa/i.test(bad) ? `That can never be given to anyone (${bad}).` : 'Unknown permission: ' + bad); };
    const dGrant = (nw, old) => { if (me().role === 'owner') return; const extra = nw.filter((p) => !old.includes(p));
      const oo = extra.filter((p) => OWNER_ONLY.includes(p)); if (oo.length) throw new Error(`Only the HQ Owner can give "Email invoices and receipts" (${oo.join(', ')}, SEC-010).`);
      const mine = permsOf(me()); const nh = extra.filter((p) => !mine.includes(p)).sort(); if (nh.length) throw new Error(`You can only give permissions you have yourself (${nh.join(', ')}).`); };
    const dCheck = (target, role, nw, old) => { if (target === actor) throw new Error('You can\'t change your own HQ access. Ask another owner.'); dCheckList(nw);
      if (me().role === 'owner') return; const cur = staff.find((x) => x.user_id === target);
      if (['owner', 'admin'].includes(role) || (cur && ['owner', 'admin'].includes(cur.role))) throw new Error('Only an HQ owner can make or change an owner or an admin.'); dGrant(nw, old); };
    let actor = 's1';
    const me = () => staff.find((s) => s.user_id === actor); const nameOf = (id) => (staff.find((s) => s.user_id === id) || {}).display_name || null;
    const need = (p) => { if (!permsOf(me()).includes(p)) throw new Error('Your HQ role can\'t do that.'); };
    const mods = { g20: { bookings: { status: 'active', paid_until: t(-26).slice(0, 10) } }, w2: { basic: { status: 'active', paid_until: t(-300).slice(0, 10) }, pos: { status: 'active', paid_until: t(-300).slice(0, 10) }, calls: { status: 'active', paid_until: t(-200).slice(0, 10) } },
      w1: { basic: { status: 'active', paid_until: t(-20).slice(0, 10) }, payroll: { status: 'cancelled', paid_until: t(5).slice(0, 10) } } };
    for (let i = 6; i <= 118; i += 6) mods['g' + i] = { basic: { status: 'active', paid_until: t(-20 - i).slice(0, 10), paid_since: t(i % 50).slice(0, 10) }, ...(i % 12 ? {} : { pos: { status: 'active', paid_until: t(-40 - i).slice(0, 10), paid_since: t(i % 30).slice(0, 10) } }) };
    mods.w1.basic.paid_since = t(120).slice(0, 10); mods.w2.basic.paid_since = t(200).slice(0, 10); mods.w2.pos.paid_since = t(20).slice(0, 10); mods.w2.calls.paid_since = t(35).slice(0, 10);
    const plans = { w2: { extra_users: 6, extra_companies: 0, billing: 'yearly', early_bird: true } };
    const settings = { 'support.overdue_hours': 24, 'support.escalate_hours': 48, 'refunds.two_person_threshold': 200, 'offers.self_limit_days': 31, 'billing.grace_days': 7, 'sign.free_per_month': 10 };
    // payments in the demo: Harbour Cafe pays by PayPal, Sample Plumbing has a bank transfer invoice waiting, one PayPal payment failed
    let entity = { name: 'Riyeser', address: '', tax_label: 'ABN', tax_number: '', email: 'info@riyeser.com', bank: { account_name: '', bank_name: '', bsb: '', account_number: '', swift: '', note: '' } };
    const bOrders = [
      { id: 'o1', workspace_id: 'w2', ref: 'RI-10002', method: 'paypal', modules: ['basic', 'pos', 'calls'], module_names: ['Accounting Basics', 'POS', 'Riyeser Link'], bundle: 'shop', people: 9, billing: 'monthly', amount: 143, first_amount: null, total: 143, status: 'active', paypal_id: '…7Q2X9K', paypal_env: 'sandbox', next_charge_at: t(-12), paid_through: t(-12).slice(0, 10), created_at: t(18) },
      { id: 'o2', workspace_id: 'w1', ref: 'RI-10003', method: 'bank', modules: ['plus', 'payroll'], module_names: ['Accounting Plus', 'Payroll'], people: 5, billing: 'monthly', amount: 92, first_amount: 46, early_bird: true, total: 46, status: 'pending', due_date: t(-9).slice(0, 10), created_at: t(5) },
      { id: 'o3', workspace_id: 'g12', ref: 'RI-10001', method: 'paypal', modules: ['basic'], module_names: ['Accounting Basics'], people: 3, billing: 'monthly', amount: 25, total: 25, status: 'payment_failed', paypal_id: '…H8LM3P', paypal_env: 'sandbox', grace_until: t(-5).slice(0, 10), paid_through: t(1).slice(0, 10), next_charge_at: t(-2), created_at: t(40), updated_at: t(2) }];
    const bPays = [{ id: 1, workspace_id: 'w2', order_ref: 'RI-10002', ref: 'RR-10002', method: 'paypal', status: 'completed', amount: 143, currency: 'USD', at: t(18), period_to: t(-12).slice(0, 10), provider_ref: '…4T7Y2A', module_names: ['Accounting Basics', 'POS', 'Riyeser Link'] },
      { id: 2, workspace_id: 'g12', order_ref: 'RI-10001', ref: 'RR-10001', method: 'paypal', status: 'completed', amount: 25, currency: 'USD', at: t(31), period_to: t(1).slice(0, 10), provider_ref: '…9K2W1D', module_names: ['Accounting Basics'] },
      { id: 3, workspace_id: 'g12', order_ref: 'RI-10001', ref: null, method: 'paypal', status: 'failed', amount: 25, currency: 'USD', at: t(2), note: 'PayPal couldn\'t take the payment.', module_names: ['Accounting Basics'] },
      { id: 4, workspace_id: 'g20', order_ref: 'RI-10004', ref: 'RR-10003', method: 'bank', status: 'completed', amount: 25, currency: 'USD', at: t(4), period_to: t(-26).slice(0, 10), provider_ref: 'ANZ 55120', module_names: ['Bookings'] }];
    bOrders.push({ id: 'o4', workspace_id: 'g20', ref: 'RI-10004', method: 'bank', modules: ['bookings'], module_names: ['Bookings'], people: 1, billing: 'monthly', amount: 25, first_amount: null, total: 25, status: 'paid', due_date: t(-5).slice(0, 10), paid_at: t(4), paid_through: t(-26).slice(0, 10), paid_reference: 'ANZ 55120', marked_paid_by: 'Finance Fi', created_at: t(9) });
    const bizOf = (o) => ({ ...o, business: (cos.find((c) => c.id === o.workspace_id) || {}).name, workspace_id: o.workspace_id });
    // The customer's copy of each invoice and receipt, made once (as the database keeps them when they're issued).
    const bDocs = {};
    const whatOf = (o) => `${(o.module_names || []).join(', ')} · ${o.people} ${o.people === 1 ? 'person' : 'people'} · ${o.billing}`;
    const dmy = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const buyerOf = (ws) => { const c = cos.find((x) => x.id === ws) || {};
      return { name: c.name, legal_name: c.name + ' Pty Ltd', address: c.address || 'Suva', tax_number: c.tax_number || '50-12345-0-1', email: c.email || c.owner_email, company_code: c.company_code, contact: { name: c.owner_name, email: c.owner_email } }; };
    const linesOf = (o) => { const k = o.billing === 'yearly' ? 10 : 1;
      const rows = planOf(o.modules, o.users || o.people, o.tills).lines.map((l) => ({ text: `${l.name}${k === 10 ? ' (a year: 10 months)' : ' (a month)'}`, amount: l.monthly * k }));
      if (Math.abs(rows.reduce((a, r) => a + r.amount, 0) - o.amount) > 0.005) return [{ text: 'Riyeser: ' + whatOf(o), amount: o.amount }];
      if (o.first_amount != null && o.first_amount < o.amount) rows.push({ text: '🐣 Early bird: half price for the first 12 months', amount: o.first_amount - o.amount }); return rows; };
    const docOrder = (o) => (o.method !== 'bank' ? null : bDocs[o.ref] || (bDocs[o.ref] = { kind: 'invoice', ref: o.ref, issued_at: o.created_at, due_date: o.due_date, seller: JSON.parse(JSON.stringify(entity)),
      buyer: buyerOf(o.workspace_id), what: whatOf(o), lines: linesOf(o), total: o.total, currency: 'USD', method: 'bank', reference: o.ref }));
    const orderOf = (p) => bOrders.find((o) => o.ref === p.order_ref) || {};
    const periodFrom = (p, o) => (p.period_to ? addMonths(p.period_to, o.billing === 'yearly' ? -12 : -1) : null);
    const docPay = (p) => { if (p.status !== 'completed' || !p.ref) return null; if (bDocs[p.ref]) return bDocs[p.ref]; const o = orderOf(p); const pf = periodFrom(p, o);
      return (bDocs[p.ref] = { kind: 'receipt', ref: p.ref, issued_at: p.at, order_ref: o.ref, seller: JSON.parse(JSON.stringify(entity)), buyer: buyerOf(p.workspace_id), what: whatOf(o),
        period_from: pf, period_to: p.period_to, lines: [{ text: `Riyeser: ${whatOf(o)}${pf ? `, ${dmy(pf)} – ${dmy(p.period_to)}` : ''}${p.amount < o.amount - 0.005 ? ' (early bird)' : ''}`, amount: p.amount }],
        total: p.amount, currency: 'USD', method: p.method, method_ref: p.method === 'paypal' ? p.provider_ref : null }); };
    const orderOut = (o) => ({ ...o, next_amount: o.method === 'paypal' && o.first_amount != null ? o.first_amount : o.amount, doc: docOrder(o) });
    const payOut = (p) => { const o = orderOf(p); return { ...p, modules: o.modules, module_names: o.module_names || p.module_names, people: o.people, billing: o.billing, period_from: periodFrom(p, o), doc: docPay(p) }; };
    const contactsOf = (ws) => { const c = cos.find((x) => x.id === ws) || {}; return [...new Set([c.owner_email, c.email].filter(Boolean).map((x) => x.toLowerCase()))]; };
    const maskEmail = (e) => `${e.split('@')[0].slice(0, 2)}…@${e.split('@')[1]}`;
    const paypalSeen = { env: 'sandbox', last_webhook_at: h(3), last_webhook_type: 'PAYMENT.SALE.COMPLETED' };
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
    function demoMonthly(ws) { const l = demoLicence(ws); let mods = Object.keys(l.modules).filter((m) => l.modules[m].status === 'active');
      if (mods.includes('plus')) mods = mods.filter((m) => m !== 'basic');   // Plus includes Basics
      const people = Math.max(l.seats.used || 0, PRICE.users_included + (l.seats.extra || 0));
      let m = planOf(mods, people, l.seats.tills || 1).total; if (l.early_bird) m *= 0.5;
      if (mods.some((x) => x === 'basic' || x === 'plus')) m += l.extra_companies * PRICE.extra_company;
      if (l.billing === 'yearly') m *= 10 / 12; return Math.round(m * 100) / 100; }
    // Demo file storage (Riyeser Link files): 20 GB, plus extra granted here (nothing new uploads while Link is off).
    const extraGb = {};
    function demoStorage(ws) { const c = cos.find((x) => x.id === ws); const l = demoLicence(ws); const plus = !!(l.modules.calls && l.modules.calls.active);
      const used = ws === 'w2' ? Math.round(20 * 0.875 * GB)   // Harbour Cafe: nearly full, for "Storage over 80%"
        : Math.round(([...String(ws)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 10 + (c && c.people > 3 ? 8 : 1)) * 0.19 * GB);
      const limit = (20 + (extraGb[ws] || 0)) * GB; return { used, limit, pct: Math.round(used * 1000 / limit) / 10, plus, extra_gb: extraGb[ws] || 0 }; }
    let nid = 4;
    const notes = { w1: [{ id: 1, kind: 'note', body: 'Called Alex: wants POS for the Lautoka branch next month.', at: t(2), by: 'Sam', author: 's1', pinned: false }],
      w2: [{ id: 2, kind: 'call', direction: 'in', contact: 'Mere', body: 'Asked about yearly billing for the second cafe.', at: t(1), by: 'Sam', author: 's1', follow_up: new Date().toISOString().slice(0, 10), pinned: false },
        { id: 3, kind: 'note', body: 'Call Mere on the cafe landline before 10 am. Payroll runs on Thursdays. Ask for the PC name (Back office PC).', at: t(20), by: 'Help Desk', author: 's2', pinned: true }] };
    const hist = [{ at: t(0.1), actor: 's1', who: 'Sam', action: 'customer.viewed', workspace_id: 'w1', details: { workspace_id: 'w1' } }, { at: t(2), actor: 's1', who: 'Sam', action: 'note.added', workspace_id: 'w1', details: { workspace_id: 'w1' } },
      { at: t(3), actor: 's2', who: 'Help Desk', action: 'ticket.replied', workspace_id: 'w2', ticket: 'T-10235', details: { workspace_id: 'w2', ticket: 'T-10235' } },
      { at: t(5), actor: 's1', who: 'Sam', action: 'staff.added', details: { email: 'help@riyeser.test', role: 'support' } }, { at: t(30), actor: null, who: 'Riyeser', action: 'staff.owner_made', details: { email: 'sam@riyeser.test' } }];
    const log = (action, details = {}) => hist.unshift({ at: now(), actor, who: me().display_name, action, workspace_id: details.workspace_id || null, ticket: details.ticket || null, details });
    const daily = []; const assets = ['RiyeserCentral-Setup.exe', 'RiyeserAccountingBasics-Setup.exe', 'RiyeserPOS-Setup.exe', 'RiyeserInvoices-Setup.exe', 'RiyeserBookings-Setup.exe'];
    for (let d = 29; d >= 0; d--) assets.forEach((a, i) => daily.push({ day: t(d).slice(0, 10), asset: a, total: Math.round((30 - d) * (6 - i) * 1.7 + 20 * (6 - i)) }));
    // support
    let tn = 10234; const mk = (ws, by, email, topic, subject, status, level, created, msgs, extra = {}) => ({ id: 'tk' + tn, ref: 'T-' + tn++, workspace_id: ws, opened_by_name: by, opened_by_email: email, topic, subject, status, priority: 'normal', level,
      assignee: null, created_at: created, updated_at: msgs.length ? msgs[msgs.length - 1].at : created, first_reply_at: (msgs.find((m) => m.staff && !m.internal) || {}).at || null, last_customer_at: created, messages: msgs, escalations: [],
      product: null, next_update_due: null, next_update_owner: null, planned_release: null, bug_ref: null, bug_url: null, diag: null, work_blocked: false, rating: null, rating_comment: null, resolved_at: null, ...extra });
    const cm = (from, body, at) => ({ staff: false, internal: false, from, body, at }); const sm = (from, body, at, internal = false) => ({ staff: true, internal, from, body, at });
    const call = (from, dir, who, body, at) => ({ staff: true, internal: true, kind: 'call', call_direction: dir, call_with: who, from, body, at });
    const ahead = (hrs) => { const d = new Date(Date.now() + hrs * 3600e3); d.setMinutes(0, 0, 0); return d.toISOString(); };   // on the hour
    // Diagnostic reports, as Riyeser Central sends them (technical details only, already scrubbed)
    const diags = {
      'DG-4821': { ref: 'DG-4821', source: 'central', workspace_id: 'w2', product: 'payroll', product_version: '2.8.1', error_text: 'Export timed out', os: 'Windows 11 Pro (10.0.22631)', central_version: '1.8.3',
        programs: [{ id: 'central', version: '1.8.3' }, { id: 'payroll', version: '2.8.1' }, { id: 'pos', version: '1.4.0' }], log_source: 'Riyeser Payroll log', reported_at: h(26), created_at: h(26),
        log_lines: ['09:12:01 INFO export: started (pay run 2026-11-21, 9 staff)', '09:12:04 INFO export: building bank file', '09:13:30 INFO export: 90% done', '09:14:00 WARN export: no answer from the export job after 30 s',
          '09:14:00 ERROR export: Export timed out', '09:14:00 INFO emailed payslip to m***@harbour.test', '09:14:01 INFO bank account [number removed] skipped'].join('\n') },
      'DG-4822': { ref: 'DG-4822', source: 'central', workspace_id: 'w1', product: 'pos', product_version: '1.7.0', error_text: 'Printer not responding (P-12)', os: 'Windows 10 Pro (10.0.19045)', central_version: '1.8.1',
        programs: [{ id: 'central', version: '1.8.1' }, { id: 'pos', version: '1.7.0' }], log_source: null, log_lines: null, reported_at: h(30), created_at: h(30) } };
    Object.values(diags).forEach((d) => { d.line_count = d.log_lines ? d.log_lines.split('\n').length : 0; });
    // The free trial's record on Harbour Cafe's back-office PC, as Central sends it with Report an issue (core/trial-guard.js),
    // and Riyeser online's anonymous record for that PC code (pc_trials). Made-up PC code.
    const PC1 = '5f3c9a7e21b04d6f8a1e3c5b7d9f0a2c4e6b8d0f1a3c5e7b9d1f3a5c7e9b0d2f';
    const tStart = new Date(new Date(t(40)).setUTCHours(0, 0, 0, 0)).toISOString();
    const tEnd = new Date(Date.parse(tStart) + 90 * 864e5).toISOString();
    diags['DG-4821'].trial = { pc_id: PC1, latest_seen: h(26), clock_back: false, installs: 3, programs: [
      { program: 'suite', start: tStart, ends: tEnd, days_left: Math.max(0, Math.ceil((Date.parse(tEnd) - Date.parse(h(26))) / 864e5)), extra_days: 0,
        sources: { licence_json: tStart, marker: tStart, registry: tStart, company_file: tStart, online: tStart } }] };
    const pcTrials = [{ pc_id: PC1, program: 'suite', trial_start: tStart, first_seen: t(40), last_seen: h(26), extra_days: 0 },
      { pc_id: '9e8d7c6b5a49382716051f2e3d4c5b6a79881726354a5b6c7d8e9f0a1b2c3d4e', program: 'suite', trial_start: t(12), first_seen: t(12), last_seen: t(1), extra_days: 0 },
      { pc_id: '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9', program: 'estimate', trial_start: t(95), first_seen: t(95), last_seen: t(3), extra_days: 0 }];
    const tickets = [
      mk('w1', 'Alex', 'alex@sample.test', 'program', 'Receipt printer stopped after the update', 'new', 1, h(30), [cm('Alex', 'Since the 1.7.0 update the POS receipt printer prints nothing. Kitchen printer is fine.', h(30))]),
      mk('w2', 'Mere', 'mere@harbour.test', 'billing', 'Charged twice in November', 'waiting_us', 1, h(5), [cm('Mere', 'Our card was charged twice for November. Can you check?', h(5))]),
      mk('w3', 'Priya', 'priya@northside.test', 'signin', 'Lost my phone, can\'t sign in', 'waiting_customer', 1, t(1), [cm('Priya', 'New phone, and the authenticator app is gone. How do I get back in?', t(1)), sm('Help Desk', 'Sorry about that, Priya. We\'ll call you on the number on file to check it\'s you, then reset it.', h(20))]),
      mk('w4', 'Jone', 'jone@island.test', 'program', 'Payroll totals don\'t match the bank', 'waiting_us', 2, t(3), [cm('Jone', 'The pay run total is $12 more than what left the bank.', t(3)), sm('Help Desk', 'Escalated to Senior by Help Desk: needs a look at the rounding', t(2), true), sm(null, 'We\'ve passed this to our senior team. They\'ll reply here.', t(2))],
        { escalations: [{ from: 1, to: 2, by: 'Help Desk', reason: 'needs a look at the rounding', at: t(2) }] }),
      mk(null, 'someone@example.test', 'someone@example.test', 'other', 'Do you support NZ GST?', 'done', 1, t(6), [cm('Customer', 'Thinking of switching. Do you handle NZ GST returns?', t(6)), sm('Sam', 'Yes: Accounting Plus does NZ GST returns.', t(5.8))], { product: 'accounting', resolved_at: t(5.8), rating: 5 }),
      mk('w2', 'Mere', 'mere@harbour.test', 'program', 'Payroll export fails after update', 'investigating', 1, h(26), [
        cm('Mere', 'Since the 2.8.1 update yesterday, our payroll export fails with a timeout. It gets to around 90% then stops with "Export timed out".', h(26)),
        sm('Sam', 'Thanks Mere. We can see the diagnostic report (DG-4821) and we\'re checking it now. We\'ll update you here by this afternoon.', h(25)),
        cm('Mere', 'Just confirming this is still happening for us this morning. We need to run payroll today, so a fix or workaround would be really helpful.', h(5)),
        sm('Sam', 'Reproduced in a test workspace on Payroll 2.8.1. Export reaches ~90% then times out with the same error. Likely the export job changes in 2.8.1. Linked to the existing bug.', h(4.5), true),
        call('Sam', 'out', 'Mere', 'Rang Mere: they can export by pay group for now. Promised an update after lunch.', h(4))],
        { product: 'payroll', assignee: 's1', diag: 'DG-4821', work_blocked: true, priority: 'high', next_update_due: ahead(0), next_update_owner: 's1', planned_release: 'Payroll 2.8.2', bug_ref: 'BUG-7719', bug_url: 'https://github.com/raka1987/Riyeser/issues' }),
      mk('w3', 'Priya', 'priya@northside.test', 'program', 'Leave balance not updating', 'waiting_customer', 1, t(2), [cm('Priya', 'Annual leave balances didn\'t change after the last pay run.', t(2)),
        sm('Help Desk', 'Thanks Priya. Could you check Payroll → Settings → Leave and tell us whether "Accrue each pay run" is ticked?', t(1.5))], { product: 'payroll', assignee: 's2', next_update_due: ahead(30), next_update_owner: 's2' }),
      mk('w4', 'Jone', 'jone@island.test', 'program', 'Timesheet approval error', 'waiting_us', 1, t(1), [cm('Jone', 'Approving a timesheet says "Something went wrong (T-40)".', t(1)), sm('Senior Sione', 'Thanks Jone, we\'re on it.', t(0.8)), cm('Jone', 'Still the same today.', h(3))],
        { product: 'payroll', assignee: 's4' })];
    tickets[1].assignee = 's2'; tickets[1].product = 'other'; tickets[0].product = 'pos'; tickets[0].diag = 'DG-4822'; tickets[2].product = 'central'; tickets[3].product = 'payroll';
    const saved = [{ id: 1, title: 'Two-step reset: identity check', body: 'Thanks for letting us know. To keep your account safe we\'ll call you back on the phone number we have on file before we reset two-step sign-in.' },
      { id: 2, title: 'Printer: turn it off and on', body: 'Please turn the printer off and on again, then print a test page from POS → Settings → Printers. Let us know what happens.' }];
    // refunds, offers, credit, emails
    let rn = 1042; const refunds = [
      { id: 'rf' + rn, ref: 'R-' + rn++, workspace_id: 'w2', business: 'Harbour Cafe', requested_by_name: 'Mere', ticket_id: 'tk10235', ticket_ref: 'T-10235', for_what: 'Accounting Basics', period: 'November 2026', invoice_ref: 'INV-2211', amount: 350, currency: 'FJD', reason_category: 'duplicate', explanation: 'Charged twice in November.', status: 'submitted', created_at: h(5), needs_second: false },
      { id: 'rf' + rn, ref: 'R-' + rn++, workspace_id: 'w3', business: 'Northside Dental', requested_by_name: 'Priya', ticket_id: null, ticket_ref: null, for_what: 'POS', period: 'October 2026', invoice_ref: null, amount: 40, currency: 'AUD', reason_category: 'didnt_work', explanation: 'Didn\'t use it.', status: 'reviewing', created_at: t(2), needs_second: false },
      { id: 'rf' + rn, ref: 'R-' + rn++, workspace_id: 'w1', business: 'Sample Plumbing', requested_by_name: 'Alex', ticket_id: null, ticket_ref: null, for_what: 'Payroll', period: 'September 2026', invoice_ref: null, amount: 20, currency: 'FJD', reason_category: 'cancelled', explanation: '', status: 'paid', created_at: t(40), decided_by_name: 'Sam', decision_reason: 'Cancelled on the 1st', amount_approved: 20, paid_at: t(38), paid_method: 'credit', needs_second: false }];
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
    const whoActs = (x) => (x.status === 'done' ? null : x.status === 'waiting_customer' ? 'customer' : 'riyeser');
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
    const APPS = [['central', '1.8.1'], ['accounting-basics', '2.3.0'], ['pos', '1.4.0'], ['invoices', '1.2.0'], ['team', '1.1.0'], ['payroll', '2.8.1'], ['pdf', '1.3.2']];
    function pcsOf(c) { const names = ['Head office PC', 'Front counter', 'Lautoka front desk', 'Manager laptop']; const owner = c.owner_name;
      return Array.from({ length: c.id.startsWith('g') ? c.pcs : Math.max(1, Math.min(4, c.pcs)) }, (_, i) => ({ id: c.id + '-d' + i, name: names[i], platform: 'Windows', version: i === 1 ? '1.8.0' : '1.8.1',
        last_seen: t(i * 1.5 + 0.01), linked_at: t(30 + i), person: i % 2 ? 'Jordan Lee' : owner,
        programs: i === 3 ? null : APPS.filter(([id], k) => k < 3 + ((i + c.name.length) % 4) || (c.id === 'w2' && id === 'payroll')).map(([id, v]) => ({ id, version: i === 1 && id === 'pos' ? '1.3.9' : i === 1 && id === 'payroll' ? '2.8.0' : v })), programs_at: i === 3 ? null : t(i + 0.1), active: true })); }
    // PCs HQ no longer counts (the customer page lists them as Older PCs): Sample Plumbing's head office PC as it was
    // linked before a Fresh start in Riyeser Central (replaced by its new link), and a PC not seen for 75 days.
    function olderPcsOf(c) { if (c.id !== 'w1') return [];
      return [{ id: 'w1-old0', name: 'Head office PC', platform: 'Windows', version: '1.8.0', last_seen: t(21), linked_at: t(200), person: c.owner_name, retired_at: t(20), replaced_by: 'w1-d0', active: false,
          programs: [{ id: 'central', version: '1.8.0' }, { id: 'accounting-basics', version: '2.2.0' }, { id: 'pos', version: '1.3.9' }], programs_at: t(21) },
        { id: 'w1-old1', name: 'Old reception PC', platform: 'Windows', version: '1.7.2', last_seen: t(75), linked_at: t(300), person: 'Jordan Lee', retired_at: null, active: false,
          programs: [{ id: 'central', version: '1.7.2' }, { id: 'invoices', version: '1.1.0' }], programs_at: t(75) }]; }
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
        paid_n: paid.length, paid, trial_n: tr.length, trial_end: te, trial_days: te ? dd(te) : null, storage_pct: demoStorage(c.id).pct, owner_name: c.owner_name, owner_email: c.owner_email, phone: c.owner_phone,
        tickets_open: tickets.filter((x) => x.workspace_id === c.id && x.status !== 'done').length, people: c.people, pcs: c.pcs, hq_owner: c.hq_owner, hq_owner_name: nameOf(c.hq_owner),
        next_follow_up: nextFu(c.id) ? nextFu(c.id).date : null }; }); }
    function nextFu(ws) { const n = (notes[ws] || []).map(noteRow).filter((x) => x.follow_up && !x.follow_up_done_at).sort((a, b) => a.follow_up.localeCompare(b.follow_up))[0];
      return n ? { id: n.id, date: n.follow_up, body: n.body.slice(0, 200), by: n.by, kind: n.kind } : null; }
    function dupCard(c) { const L = demoLicence(c.id); const pays = bPays.filter((x) => x.workspace_id === c.id && x.status === 'completed');
      const pp = Object.entries(L.modules).filter(([, v]) => (v.status === 'active' || v.status === 'cancelled') && v.active).map(([m]) => m);
      if (c.calls_paid_until && new Date(c.calls_paid_until) > Date.now() && !pp.includes('calls')) pp.push('calls');
      return { id: c.id, name: c.name, company_code: c.company_code, status: c.status, kind: c.kind, created_at: c.created_at, removal_state: c.removal_state || null, duplicate_of: c.duplicate_of || null,
        owner_id: c.owner_email || null, owner_name: c.owner_name, owner_email: c.owner_email, members: c.people, pcs: c.pcs, paid_invoices: pays.length,
        paid_total: pays.reduce((a, x) => a + Number(x.amount || 0), 0), paid_programs: pp, trial_programs: Object.values(L.modules).filter((v) => v.status === 'trial').length,
        last_activity: [c.last_active_at, c.last_seen].filter(Boolean).sort().pop() || null }; }
    const keepProblem = (ws, k) => (!k ? 'That business doesn\'t exist.' : k.id === ws ? 'That\'s this account. Choose the other one.' : k.removal_state ? 'That account\'s details were removed.'
      : k.status === 'closed' ? 'That account is closed. Keep an open one.' : k.duplicate_of === ws ? 'That account is linked as a duplicate of this one.' : null);
    const rowOf = (f) => ({ ...f, decided_by_name: nameOf(f.decided_by) || f.decided_by_name, second_approver_name: nameOf(f.second_approver), waiting_second: !!(f.needs_second && !f.second_approver && ['approved', 'partly_approved'].includes(f.status)) });
    return {
      async session() { return { user: { email: 'sam@riyeser.test' } }; }, async signIn() {}, async signOut() {},
      async aal() { return { currentLevel: 'aal2', nextLevel: 'aal2' }; }, async factors() { return [{ id: 'f' }]; }, async verify() {},
      async me() { const s = me(); return { role: s.role, role_name: roleName(s.role), name: s.display_name, active: true, two_step: true, perms: permsOf(s), id: s.user_id, customised: !!((s.perms_add || []).length || (s.perms_remove || []).length) }; },
      asStaff(id) { actor = id; }, staffList: () => staff.slice(),
      async overview(inc) { return { include_test: !!inc, companies: cos.filter((c) => inc || !c.account_kind || c.account_kind === 'customer').length, companies_7d: 1, companies_30d: 2, people: 24, pcs: 10, pcs_active_7d: 8, pcs_active_30d: 10, requests_waiting: 1, calls_paid: 1, calls_trial: 3,
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
            billing: P.includes('licences.view') ? { orders: bOrders.filter((o) => o.workspace_id === ws).map(orderOut), payments: bPays.filter((x) => x.workspace_id === ws).map(payOut), can_mark_paid: P.includes('licences.manage'), contacts: contactsOf(ws) } : null,
            history: P.includes('audit.view') ? hist.filter((x) => x.workspace_id === ws) : null } }; },
      async setCallsPaid(ws, until) { cos.find((x) => x.id === ws).calls_paid_until = until + 'T23:59:59Z'; log('calls.paid_until', { workspace_id: ws, until }); },
      async addNote(ws, body) { return this.noteAdd(ws, { kind: 'note', body }); },
      async staff() { return staffOut(); },
      async team() { return { all: PERMS.map((p) => p[0]), roles: Object.fromEntries(droles.map((r) => [r.key, permsFor(r.key)])), owner_only: OWNER_ONLY,
        role_list: droles.slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)).map((r) => ({ ...r, perms: permsFor(r.key), standard: r.builtin ? (r.key === 'owner' ? permsFor('owner') : STD[r.key]) : null, people: staff.filter((x) => x.role === r.key).length })),
        staff: staffOut() }; },
      // HQ V2 first slice: sessions aren't timed in the demo; test accounts; the overview figures; backup and restore-test records
      async touch() { return { ok: true, timed: false, idle_minutes: 30, max_hours: 12 }; },
      async testAccounts() { if (!['customers.view', 'test_accounts.manage'].some((x) => permsOf(me()).includes(x))) throw new Error('Your HQ role can\'t do that.');
        return cos.filter((c) => c.account_kind && c.account_kind !== 'customer').map((c) => ({ id: c.id, name: c.name, company_code: c.company_code, country: c.country, account_kind: c.account_kind, created_at: c.created_at, status: c.status })); },
      async setAccountKind(ws, kind, reason) { need('test_accounts.manage'); if (!['customer', 'test', 'demo', 'internal'].includes(kind)) throw new Error('Choose customer, test, demo or internal.');
        if (String(reason || '').trim().length < 3) throw new Error('Say why (a few words).'); const c = cos.find((x) => x.id === ws); if (!c) throw new Error('There\'s no business with that id.');
        const before = c.account_kind || 'customer'; if (before === kind) return; c.account_kind = kind; log('account.kind', { workspace_id: ws, before, after: kind, reason: reason.trim() }); },
      async kpis(inc) { need('overview.view'); const P = permsOf(me()); const cv = P.includes('customers.view'); const sv = P.includes('support.view'); const lv = P.includes('licences.view');
        const W = cos.filter((c) => inc || !c.account_kind || c.account_kind === 'customer'); const ids = new Set(W.map((c) => c.id));
        const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
        const wk = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return iso(x); };
        const weeks = {}; W.filter((c) => hours(c.created_at) / 24 <= 84).forEach((c) => { const k = wk(c.created_at); weeks[k] = (weeks[k] || 0) + 1; });
        const ending = W.filter((c) => c.status === 'active' && Object.values(demoLicence(c.id).modules).some((v) => ['trial', 'active'].includes(v.status) && v.days_left != null && v.days_left <= 7)).length;
        const rec = bOrders.filter((o) => ids.has(o.workspace_id) && ((o.method === 'paypal' && ['active', 'payment_failed'].includes(o.status)) || (o.method === 'bank' && o.status === 'paid')));
        const amt = (o) => Number(o.first_amount != null ? o.first_amount : o.amount); const pays = bPays.filter((p) => ids.has(p.workspace_id) && p.status === 'completed' && hours(p.at) <= 168);
        return { as_of: now(), include_test: !!inc, currency: 'USD', test_accounts: cv ? cos.filter((c) => c.account_kind && c.account_kind !== 'customer').length : null,
          businesses: cv ? W.filter((c) => c.status === 'active').length : null, new_signups_week: cv ? W.filter((c) => new Date(c.created_at) >= monday).length : null,
          signups_by_week: cv ? Object.entries(weeks).sort().map(([week, companies]) => ({ week, companies })) : null, renewals_due_7d: cv ? ending : null,
          open_tickets: sv ? tickets.filter((x) => x.status !== 'done' && (!x.workspace_id || ids.has(x.workspace_id))).length : null,
          failed_payments: lv ? bOrders.filter((o) => ids.has(o.workspace_id) && ['payment_failed', 'suspended'].includes(o.status)).length : null,
          mrr: lv ? Math.round(rec.reduce((a, o) => a + (o.billing === 'yearly' ? amt(o) / 12 : amt(o)), 0) * 100) / 100 : null, recurring_count: lv ? rec.length : null,
          payments_7d: lv ? { count: pays.length, total: pays.reduce((a, p) => a + Number(p.amount), 0) } : null }; },
      async opsRuns() { need('ops.view'); return [
        { job: 'backup', target: 'team', ok: true, started_at: h(5.2), finished_at: h(5), detail: { bytes: 48213337, fingerprint: 'demo' }, last_ok_at: h(5) },
        { job: 'hq_jobs', target: 'team', ok: true, started_at: h(0.4), finished_at: h(0.38), detail: { emails_sent: 0, note: 'email sending isn\'t set up yet' }, last_ok_at: h(0.38) },
        { job: 'restore_drill', target: 'team', ok: true, started_at: t(26.01), finished_at: t(26), detail: { rows_backup: 18233, rows_restored: 18233 }, last_ok_at: t(26) }]; },
      async addStaff(email, name, role) { need('staff.manage'); if (!droles.some((r) => r.key === role)) throw new Error('Choose a role');
        if (['owner', 'admin'].includes(role) && me().role !== 'owner') throw new Error('Only an HQ owner can make an owner or an admin.');
        dGrant(permsFor(role), []); staff.push({ user_id: 's' + (staff.length + 1), display_name: name, role, active: true, email, added_at: now(), perms_add: [], perms_remove: [] }); log('staff.added', { email, role }); },
      async setStaff(id, role, active) { need('staff.manage'); const s = staff.find((x) => x.user_id === id); if (!droles.some((r) => r.key === role)) throw new Error('Choose a role');
        const before = s.active ? permsFor(s.role, s.perms_add, s.perms_remove) : []; dCheck(id, role, active ? permsFor(role, s.perms_add, s.perms_remove) : [], before);
        if (s.role === 'owner' && (role !== 'owner' || !active) && !staff.some((x) => x !== s && x.role === 'owner' && x.active)) throw new Error('At least one HQ Owner must keep full access. Make someone else an Owner first.');
        const pr = s.role; Object.assign(s, { role, active }); log('staff.changed', { user_id: id, role, active, before: { role: pr, perms: before }, after: { role, active, perms: active ? permsOf(s) : [] } }); },
      async setStaffPerms(id, on2, off) { need('staff.manage'); const s = staff.find((x) => x.user_id === id); dCheckList([...on2, ...off]);
        const before = permsFor(s.role, s.perms_add, s.perms_remove); dCheck(id, s.role, permsFor(s.role, on2, off), before);
        Object.assign(s, { perms_add: on2, perms_remove: off }); log('staff.permissions', { user_id: id, on: on2, off, before: { role: s.role, perms: before }, after: { role: s.role, perms: permsOf(s) } }); },
      async setStaffAccess(id, role, perms) { need('staff.manage'); if (id === actor) throw new Error('You can\'t change your own HQ access. Ask another owner.');
        const s = staff.find((x) => x.user_id === id); if (!s) throw new Error('That person isn\'t on the HQ team.'); if (!droles.some((r) => r.key === role)) throw new Error('Choose a role'); dCheckList(perms);
        const rp = permsFor(role); const want = role === 'owner' ? rp : perms || rp; const add = role === 'owner' ? [] : want.filter((p) => !rp.includes(p)).sort(); const rem = role === 'owner' ? [] : rp.filter((p) => !want.includes(p)).sort();
        const before = permsFor(s.role, s.perms_add, s.perms_remove); const after = permsFor(role, add, rem); dCheck(id, role, after, before);
        if (s.role === 'owner' && role !== 'owner' && !staff.some((x) => x !== s && x.role === 'owner' && x.active)) throw new Error('At least one HQ Owner must keep full access. Make someone else an Owner first.');
        log('staff.access', { user_id: id, before: { role: s.role, added: s.perms_add, removed: s.perms_remove, perms: before }, after: { role, added: add, removed: rem, perms: after } });
        Object.assign(s, { role, perms_add: add, perms_remove: rem }); return { role, perms: after, perms_add: add, perms_remove: rem }; },
      async roleSave(key, name, description, perms) { need('staff.manage'); const own = me().role === 'owner'; dCheckList(perms); perms = [...new Set(perms || [])].sort();
        const nm = String(name || '').trim(); const ds = String(description || '').trim(); let r = null; let old = [];
        if (key) { r = droles.find((x) => x.key === key); if (!r) throw new Error('That role isn\'t there any more. Reload the page.');
          if (key === 'owner') throw new Error('The Owner role always has every permission, so nobody is ever locked out. It can\'t be changed.');
          if (key === 'admin' && !own) throw new Error('Only the HQ Owner can change the Owner and Admin roles.');
          if (!own && me().role === key) throw new Error('You can\'t change the role you have yourself. Ask the HQ Owner.');
          if (r.builtin && nm !== r.name) throw new Error('Built-in roles keep their names. Duplicate it to make a new role.'); old = permsFor(key); }
        if (!nm || nm.length > 40) throw new Error('Give the role a name (up to 40 letters).'); if (ds.length > 300) throw new Error('Keep the description under 300 letters.');
        if (droles.some((x) => x.name.toLowerCase() === nm.toLowerCase() && x !== r)) throw new Error(`There's already a role called ${nm}.`);
        dGrant(perms, old);
        if (!r) { const k = 'c_' + Math.random().toString(16).slice(2, 14); droles.push({ key: k, name: nm, description: ds, builtin: false, sort: 100 }); ROLE_PERMS[k] = perms; ROLE_NAMES[k] = nm;
          log('role.created', { role: k, name: nm, after: { name: nm, description: ds, perms } }); return k; }
        log('role.changed', { role: key, name: nm, before: { name: r.name, description: r.description, perms: old }, after: { name: nm, description: ds, perms } });
        Object.assign(r, { name: nm, description: ds }); ROLE_PERMS[key] = perms; ROLE_NAMES[key] = nm; return key; },
      async roleDelete(key, moveTo) { need('staff.manage'); const r = droles.find((x) => x.key === key); if (!r) throw new Error('That role isn\'t there any more. Reload the page.');
        if (r.builtin) throw new Error('Built-in HQ roles can\'t be removed. You can change their ticks instead.'); const ppl = staff.filter((x) => x.role === key);
        if (ppl.length && !moveTo) throw new Error(`Some people still have this role (${ppl.length}). Choose a role to move them to first.`);
        if (ppl.length && (moveTo === key || !droles.some((x) => x.key === moveTo))) throw new Error('Choose another role to move them to.');
        ppl.forEach((s) => dCheck(s.user_id, moveTo, permsFor(moveTo), permsFor(s.role, s.perms_add, s.perms_remove)));
        ppl.forEach((s) => { log('staff.access', { user_id: s.user_id, why: 'role.deleted', before: { role: key, perms: permsFor(key, s.perms_add, s.perms_remove) }, after: { role: moveTo, perms: permsFor(moveTo) } }); Object.assign(s, { role: moveTo, perms_add: [], perms_remove: [] }); });
        log('role.deleted', { role: key, name: r.name, moved_to: moveTo || null, moved: ppl.length, before: { perms: permsFor(key) } }); droles.splice(droles.indexOf(r), 1); delete ROLE_PERMS[key]; return ppl.length; },
      async history(f = {}) { need('audit.view'); const rows = hist.filter((x) => (!f.who || x.actor === f.who) && (!f.action || x.action.startsWith(f.action)) && (!f.ws || x.workspace_id === f.ws)
          && (!f.from || x.at.slice(0, 10) >= f.from) && (!f.to || x.at.slice(0, 10) <= f.to)).map((x) => ({ ...x, business: (cos.find((c) => c.id === x.workspace_id) || {}).name }));
        if (f.exp) log('audit.exported', { who: f.who || null, action: f.action || null }); return rows; },
      async downloadsDaily() { return daily; },
      // Real downloads and installs, made up: a steady pattern growing over time, quieter at weekends
      async realDownloads(days) { need('downloads.view'); const n = Math.min(365, Math.max(7, Number(days) || 30)); const rnd = (k) => ((k * 9301 + 49297) % 233280) / 233280;
        const PR = [['central', 0.46], ['accounting-basics', 0.12], ['pos', 0.1], ['invoices', 0.09], ['payroll', 0.07], ['documents', 0.05], ['pdf', 0.04], ['bookings', 0.03], ['link-office', 0.02], ['estimate', 0.02]];
        const end = Date.parse(iso(Date.now()) + 'T00:00:00Z'); const series = []; const ps = []; const per = {}; let real = 0; let inst = 0; let upd = 0;
        for (let i = n - 1; i >= 0; i--) { const t = end - i * 864e5; const k = Math.floor(t / 864e5); const wd = new Date(t).getUTCDay(); const age = (Date.now() - t) / 864e5;
          const tot = Math.max(0, Math.round((22 + (120 - age) * 0.08) * (wd === 0 ? 0.5 : wd === 6 ? 0.7 : 1) * (0.75 + rnd(k) * 0.5)));
          let left = tot; PR.forEach(([id, f], j) => { const v = j === PR.length - 1 ? left : Math.min(left, Math.round(tot * f * (0.8 + rnd(k + j) * 0.4))); left -= v; if (v) { ps.push({ program: id, d: iso(t), real: v }); per[id] = (per[id] || 0) + v; } });
          const ni = Math.round(tot * (0.62 + rnd(k + 3) * 0.12)); const nu = Math.round(6 + rnd(k + 5) * 10 + (k % 14 === 0 ? 40 : 0));
          series.push({ d: iso(t), real: tot, installs: ni, updates: nu }); real += tot; inst += ni; upd += nu; }
        const share = (list) => list.map(([k, f]) => ({ k, v: Math.round(real * f) }));
        return { from: series[0].d, to: series[series.length - 1].d, days: n, real, raw: Math.round(real * 1.62),
          hidden: { tests: Math.round(real * 0.21), staff: Math.round(real * 0.04), bots: Math.round(real * 0.26), repeats: Math.round(real * 0.11), install_tests: 14 },
          installs: { new: inst, existing: 38, updates: upd, added: Math.round(inst * 0.7), linked: Math.round(inst * 0.41) }, series, program_series: ps,
          programs: PR.map(([id]) => ({ program: id, real: per[id] || 0, raw: Math.round((per[id] || 0) * 1.6), installs: id === 'central' ? inst : Math.round((per[id] || 0) * 0.8), updates: Math.round(upd * (id === 'central' ? 0.4 : 0.6 * PR.find((x) => x[0] === id)[1])) })),
          countries: share([['FJ', 0.49], ['AU', 0.17], ['NZ', 0.1], ['WS', 0.05], ['TO', 0.04], ['PG', 0.03], ['VU', 0.02], ['US', 0.02], ['IN', 0.02], ['', 0.06]]).map((x) => ({ country: x.k, real: x.v })),
          referrers: share([['/downloads', 0.34], ['/', 0.22], ['/programs/central', 0.1], ['/programs/accounting-basics', 0.07], ['/programs/pos', 0.06], ['/pricing', 0.05], ['/help/start', 0.04], ['google.com', 0.05], ['facebook.com', 0.03], ['', 0.04]]).map((x) => ({ referrer: x.k, real: x.v })),
          releases: [{ tag: 'riyeser-2026.11.27-60', real: Math.round(real * 0.38) }, { tag: 'riyeser-2026.11.24-58', real: Math.round(real * 0.33) }, { tag: 'riyeser-2026.11.18-55', real: Math.round(real * 0.29) }],
          install_countries: [['Fiji', 0.31], ['Australia', 0.08], ['New Zealand', 0.05], ['', 0.56]].map(([country, f]) => ({ country, n: Math.round(inst * f) })),
          central_versions: [{ version: '1.9.0', n: Math.round(inst * 0.7) }, { version: '1.8.4', n: Math.round(inst * 0.3) }] }; },
      async licences() { const list = cos.map((c) => ({ c, l: demoLicence(c.id) }));
        const ending = []; list.forEach(({ c, l }) => Object.entries(l.modules).forEach(([m, v]) => { if (v.days_left != null && v.days_left <= 14) ending.push({ id: c.id, name: c.name, company_code: c.company_code, module: m, status: v.status, days_left: v.days_left }); }));
        return { monthly_estimate: list.reduce((a, x) => a + demoMonthly(x.c.id), 0), paying_companies: list.filter((x) => demoMonthly(x.c.id) > 0).length,
          early_bird_used: Object.values(plans).filter((x) => x.early_bird).length + 37, early_bird_left: 100 - 37 - Object.values(plans).filter((x) => x.early_bird).length,
          modules: MODULES.map(([m]) => ({ module: m, active_paid: list.filter((x) => x.l.modules[m].status === 'active').length, on_trial: list.filter((x) => x.l.modules[m].status === 'trial').length,
            ended: list.filter((x) => ['ended', 'cancelled', 'closed'].includes(x.l.modules[m].status)).length,
            installed: list.filter((x) => pcsOf(x.c).some((d) => (d.programs || []).some((p) => p.id === ({ basic: 'accounting-basics', plus: 'accounting', as_built: 'services', calls: 'team' }[m] || m)))).length })),
          ending_soon: ending.sort((a, b) => a.days_left - b.days_left), ...(() => { const td = iso(Date.now());
            const rec = bOrders.filter((o) => (o.method === 'paypal' && ['active', 'payment_failed'].includes(o.status)) || (o.method === 'bank' && o.status === 'paid' && o.paid_through >= td));
            return { recurring_count: rec.length, monthly_recurring: Math.round(rec.reduce((a, o) => { const x = o.method === 'paypal' ? (o.first_amount != null ? o.first_amount : o.amount) : o.total; return a + (o.billing === 'yearly' ? x / 12 : x); }, 0) * 100) / 100 }; })() }; },
      async licenceBusinesses(mod, st) { need('licences.view'); const want = { paid: ['active'], trial: ['trial'], ended: ['ended', 'cancelled', 'closed'] }[st];
        return cos.map((c) => ({ c, v: demoLicence(c.id).modules[mod] })).filter((x) => x.v && want.includes(x.v.status)).sort((a, b) => a.c.name.localeCompare(b.c.name))
          .map(({ c, v }) => ({ id: c.id, name: c.name, company_code: c.company_code, country: c.country, status: v.status, until: v.paid_until || v.trial_ends, days_left: v.days_left })); },
      async companyLicence(ws) { return { licence: demoLicence(ws), monthly: demoMonthly(ws) }; },
      async setModule(ws, mod, status, te, pt) { need('licences.manage'); (mods[ws] = mods[ws] || {})[mod] = { status, trial_ends: te || null, paid_until: pt || null }; log('licence.module', { workspace_id: ws, module: mod, status }); },
      async grantStorage(ws, gb, why) { need('licences.manage'); if (!(gb >= 0 && gb <= 10000)) throw new Error('Choose 0 to 10000 GB of extra storage.');
        if (String(why || '').trim().length < 3) throw new Error('Say why, so the team knows later.');
        log('licence.storage', { workspace_id: ws, extra_gb: { was: extraGb[ws] || 0, now: gb }, reason: why }); extraGb[ws] = gb; return demoStorage(ws); },
      async setPlan(ws, users, cosx, billing, eb) { need('licences.manage'); plans[ws] = { extra_users: users, extra_companies: cosx, billing, early_bird: eb }; log('licence.plan', { workspace_id: ws }); },
      async settings() { return { ...settings }; },
      async setSetting(k, v) { need('settings.manage'); settings[k] = Number(v); log('settings.changed', { setting: k, value: v }); },
      async billing() { need('licences.view'); const P = permsOf(me());
        return { failed: bOrders.filter((o) => ['payment_failed', 'suspended'].includes(o.status)).map(orderOut).map(bizOf), unpaid: bOrders.filter((o) => o.method === 'bank' && o.status === 'pending').map(orderOut).map(bizOf),
          payments: bPays.slice().sort((a, b) => b.at.localeCompare(a.at)).map(payOut).map(bizOf), paypal: { ...paypalSeen, events_7d: 14, subscriptions: bOrders.filter((o) => o.method === 'paypal' && o.status !== 'cancelled').length },
          entity: JSON.parse(JSON.stringify(entity)), bank_ready: !!entity.bank.account_number, grace_days: settings['billing.grace_days'],
          can_mark_paid: P.includes('licences.manage'), can_edit_entity: me().role === 'owner', entity_pending: null,
          can_send_docs: P.includes('licences.manage') }; },
      async markPaid(ref, bankRef, amount) { need('licences.manage'); const o = bOrders.find((x) => x.ref === String(ref).trim().toUpperCase() && x.method === 'bank');
        if (!o) throw new Error('There\'s no bank transfer invoice with that number.'); if (o.status !== 'pending') throw new Error('That invoice is already paid.');
        if (String(bankRef || '').trim().length < 3) throw new Error('Type the bank\'s reference for the payment (from your bank statement).');
        if (!(Number(amount) >= o.total - 0.005)) throw new Error(`The invoice is for ${money(o.total)}. Check the amount on the bank statement.`);
        const l = demoLicence(o.workspace_id); let upto = null;
        o.modules.forEach((m) => { const v = l.modules[m]; const base = [today().toISOString().slice(0, 10), v.status === 'trial' ? v.trial_ends : null, ['active', 'cancelled'].includes(v.status) ? v.paid_until : null].filter(Boolean).sort().pop();
          const to = addMonths(base, o.billing === 'yearly' ? 12 : 1); (mods[o.workspace_id] = mods[o.workspace_id] || {})[m] = { status: 'active', paid_until: to, paid_since: iso(Date.now()) }; upto = !upto || to > upto ? to : upto; });
        Object.assign(o, { status: 'paid', paid_at: now(), paid_through: upto, paid_reference: String(bankRef).trim(), marked_paid_by: me().display_name });
        const rc = 'RR-' + (10001 + bPays.length); bPays.unshift({ id: bPays.length + 1, workspace_id: o.workspace_id, order_ref: o.ref, ref: rc, method: 'bank', status: 'completed', amount: Number(amount), currency: 'USD', at: now(), period_to: upto, provider_ref: String(bankRef).trim(), module_names: o.module_names });
        log('billing.bank_paid', { workspace_id: o.workspace_id, invoice: o.ref, receipt: rc, amount: Number(amount), paid_until: upto });
        docPay(bPays[0]); contactsOf(o.workspace_id).forEach((a) => queue(a, 'Thanks, your Riyeser payment is in', 'billing_paid', o.workspace_id)); return { receipt: rc, paid_until: upto }; },
      async paymentsReceived(days) { need('licences.view'); const ps = bPays.filter((p) => p.status === 'completed' && (Date.now() - new Date(p.at)) / 864e5 <= days); return { days, count: ps.length, total: ps.reduce((a, p) => a + p.amount, 0) }; },
      async resendDoc(ref, to, update) { need('invoices.email'); const P = permsOf(me()); const r = String(ref || '').trim().toUpperCase();
        bOrders.forEach(docOrder); bPays.forEach(docPay); const d = bDocs[r]; if (!d) throw new Error('There\'s no invoice or receipt with that number.');
        const ws = (bOrders.find((o) => o.ref === (d.kind === 'invoice' ? d.ref : d.order_ref)) || {}).workspace_id; const addr = String(to || '').trim().toLowerCase();
        if (addr && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) || addr.length > 120)) throw new Error('Check the email address.');
        if (addr && update) { if (!['customers.edit', 'licences.manage'].some((x) => P.includes(x))) throw new Error('Your HQ role can\'t do that.'); cos.find((x) => x.id === ws).email = addr; }
        const sent = addr ? [addr] : contactsOf(ws); if (!sent.length) throw new Error('This business has no email to send it to. Use "Send to a different email".');
        sent.forEach((a) => queue(a, d.kind === 'receipt' ? `Your Riyeser receipt ${d.ref}` : `Your Riyeser invoice ${d.ref}`, 'billing_resend', ws));
        log('billing.doc_resent', { workspace_id: ws, ref: d.ref, kind: d.kind, to: sent.map(maskEmail), other_address: !!addr, contact_updated: !!(addr && update) });
        return { ref: d.ref, to: sent, contact_updated: !!(addr && update) }; },
      // SEC-011 (the owner's decision): only the HQ Owner enters or changes it; it's in force straight away
      async setBillingEntity(d) { if (me().role !== 'owner') throw new Error('Your HQ role can\'t do that. Only the Riyeser HQ Owner can change Riyeser\'s billing and bank details.');
        if (String(d.name || '').trim().length < 2) throw new Error('Type the business name that sells Riyeser.');
        const details = { name: d.name.trim(), address: (d.address || '').trim(), tax_label: (d.tax_label || '').trim() || 'ABN', tax_number: (d.tax_number || '').trim(), email: (d.email || '').trim(),
          bank: Object.fromEntries(['account_name', 'bank_name', 'bsb', 'account_number', 'swift', 'note'].map((k) => [k, String((d.bank || {})[k] || '').trim()])) };
        if (JSON.stringify(entity) === JSON.stringify(details)) return;
        const before = entity; entity = details;
        log('billing.entity_changed', { name: details.name, before, after: details, bank_set: !!details.bank.account_number }); },
      async paypalStatus() { return { ready: false, credentials: true, webhooks: false, env: 'sandbox', message: 'Webhooks aren\'t verified yet: add PAYPAL_WEBHOOK_ID and deploy again.' }; },
      // support
      async tickets(box = 'open', q = '') { need('support.view'); const od = settings['support.overdue_hours']; const s = q.toLowerCase();
        const all = tickets.map((x) => ({ ...x, business: (cos.find((c) => c.id === x.workspace_id) || {}).name || null, assignee_name: nameOf(x.assignee), escalated: x.escalations.length > 0,
          overdue: x.status !== 'done' && !x.first_reply_at && hours(x.created_at) > od })).filter((x) => !s || [x.ref, x.subject, x.business, x.opened_by_email, ...x.messages.map((m) => m.body)].some((v) => String(v || '').toLowerCase().includes(s)));
        const f = { new: (x) => x.status === 'new', waiting_us: (x) => x.status === 'waiting_us', waiting_customer: (x) => x.status === 'waiting_customer', done: (x) => x.status === 'done',
          mine: (x) => x.status !== 'done' && x.assignee === actor, unassigned: (x) => x.status !== 'done' && !x.assignee, escalated: (x) => x.status !== 'done' && x.level > 1,
          level2: (x) => x.status !== 'done' && x.level === 2, level3: (x) => x.status !== 'done' && x.level === 3, overdue: (x) => x.status !== 'done' && x.overdue, all: () => true, open: (x) => x.status !== 'done' };
        const counts = {}; Object.keys(f).forEach((k) => { counts[k] = all.filter(f[k]).length; });
        return { tickets: all.filter(f[box] || f.open).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((x) => ({ ...x, messages: undefined })), counts, overdue_hours: od }; },
      async supportInbox(box = 'all', q = '', f = {}) { need('support.view'); const od = settings['support.overdue_hours']; const s = String(q || '').toLowerCase();
        const all = tickets.map((x) => ({ ...x, business: (cos.find((c) => c.id === x.workspace_id) || {}).name || null, assignee_name: nameOf(x.assignee), escalated: x.escalations.length > 0,
          overdue: x.status !== 'done' && !x.first_reply_at && hours(x.created_at) > od, update_overdue: x.status !== 'done' && !!x.next_update_due && new Date(x.next_update_due) < new Date(),
          who_acts: whoActs(x), next_update_owner_name: nameOf(x.next_update_owner), messages: undefined }))
          .filter((x) => !s || [x.ref, x.subject, x.business, x.opened_by_email, x.diag, ...tk(x.id).messages.map((m) => m.body)].some((v) => String(v || '').toLowerCase().includes(s)));
        const base = all.filter((x) => (!f.product || x.product === f.product) && (!f.owner || (f.owner === 'me' ? x.assignee === actor : f.owner === 'none' ? !x.assignee : x.assignee === f.owner))
          && (!f.status || (f.status === 'open' ? x.status !== 'done' : x.status === f.status)) && (!f.level || String(x.level) === String(f.level)) && (!f.topic || x.topic === f.topic));
        const B = { open: (x) => x.status !== 'done', mine: (x) => x.status !== 'done' && x.assignee === actor, waiting_customer: (x) => x.status === 'waiting_customer', unassigned: (x) => x.status !== 'done' && !x.assignee,
          overdue: (x) => x.status !== 'done' && (x.overdue || x.update_overdue), all: () => true };
        const counts = { open: base.filter((x) => x.status !== 'done').length }; Object.keys(B).forEach((k) => { counts[k] = base.filter(B[k]).length; });
        return { tickets: base.filter(B[box] || B.all).sort((a, b) => (b.update_overdue - a.update_overdue) || b.updated_at.localeCompare(a.updated_at)), counts, overdue_hours: od,
          staff: staff.filter((x) => x.active).map((x) => ({ user_id: x.user_id, name: x.display_name })) }; },
      async ticket(id) { need('support.view'); const x = tk(id); const P = permsOf(me()); const dg = x.diag && P.includes('support.diagnostics') ? diags[x.diag] : null;
        log('ticket.viewed', { ticket: x.ref, workspace_id: x.workspace_id, diagnostic: dg ? dg.ref : null }); const c = cos.find((y) => y.id === x.workspace_id);
        const l = c ? demoLicence(c.id) : null;
        return { ticket: { ...x, assignee_name: nameOf(x.assignee), next_update_owner_name: nameOf(x.next_update_owner), who_acts: whoActs(x), messages: undefined,
            update_overdue: x.status !== 'done' && !!x.next_update_due && new Date(x.next_update_due) < new Date(), diag_id: x.diag },
          diagnostic: dg ? (({ trial, ...rest }) => rest)(dg) : null, diag_hidden: !!x.diag && !dg, pcs: c ? pcsOf(c) : null,
          trial: x.diag && diags[x.diag] && diags[x.diag].trial ? (P.includes('trials.view') ? 'yes' : 'hidden') : null,
          support_notes: c ? (notes[c.id] || []).filter((n) => n.pinned).map((n) => ({ id: n.id, body: n.body, at: n.at, by: n.by })) : null,
          staff: staff.filter((y) => y.active).map((y) => ({ user_id: y.user_id, name: y.display_name, can_work: permsOf(y).includes(LEVEL_PERM[x.level]) })),
          messages: x.messages.map((m, i) => ({ kind: 'message', ...m, id: i + 1, from: m.from || 'Riyeser (automatic)' })), escalations: x.escalations,
          business: c ? { id: c.id, name: c.name, company_code: c.company_code, status: c.status, people: c.people, pcs: c.pcs, last_active_at: c.last_active_at,
            paid: Object.keys(l.modules).filter((m) => l.modules[m].status === 'active'), trial: Object.keys(l.modules).filter((m) => l.modules[m].status === 'trial'), monthly: demoMonthly(c.id),
            credit: credits[c.id] || {}, notes: notes[c.id] || [] } : null,
          refunds: refunds.filter((f) => f.ticket_id === id), can_work: permsOf(me()).includes(LEVEL_PERM[x.level]) }; },
      async ticketReply(id, msg, note, st) { need('support.reply'); const x = tk(id); if (!permsOf(me()).includes(LEVEL_PERM[x.level])) throw new Error(`This ticket is with ${LEVELS[x.level]} (level ${x.level}). Someone who works that level needs to reply.`);
        x.messages.push(sm(me().display_name, msg, now(), !!note)); x.updated_at = now();
        if (!note) { x.first_reply_at = x.first_reply_at || now(); x.status = st || 'waiting_customer'; x.resolved_at = x.status === 'done' ? (x.resolved_at || now()) : null; x.assignee = x.assignee || actor; queue(x.opened_by_email, `Re: ${x.subject} (${x.ref})`, 'ticket_reply'); }
        log(note ? 'ticket.note' : 'ticket.replied', { ticket: x.ref, workspace_id: x.workspace_id }); },
      async ticketStatus(id, st) { need('support.reply'); const x = tk(id); const was = x.status; x.status = st; x.updated_at = now(); x.resolved_at = st === 'done' ? (x.resolved_at || now()) : null;
        log('ticket.status', { ticket: x.ref, workspace_id: x.workspace_id, was, now: st }); },
      async ticketSet(id, f) { need('support.reply'); const x = tk(id); if (!permsOf(me()).includes(LEVEL_PERM[x.level])) throw new Error(`This ticket is with ${LEVELS[x.level]} (level ${x.level}).`);
        if ('bug_url' in f && f.bug_url && !/^https:\/\/\S{3,300}$/.test(f.bug_url)) throw new Error('The bug link must start with https://');
        if ('product' in f && f.product && !PRODUCTS.some(([k]) => k === f.product)) throw new Error('Choose a product.');
        Object.entries(f).forEach(([k, v]) => { x[k] = String(v || '').trim() || null; }); x.updated_at = now(); log('ticket.updated', { ticket: x.ref, workspace_id: x.workspace_id, fields: Object.keys(f) }); },
      async ticketNextUpdate(id, due, who) { need('support.reply'); const x = tk(id);
        if (!due) { Object.assign(x, { next_update_due: null, next_update_owner: null }); log('ticket.next_update', { ticket: x.ref, workspace_id: x.workspace_id, due: null }); return; }
        if (new Date(due) < new Date(Date.now() - 5 * 60e3)) throw new Error('Choose a time from now on.');
        Object.assign(x, { next_update_due: new Date(due).toISOString(), next_update_owner: who || actor, updated_at: now() }); log('ticket.next_update', { ticket: x.ref, workspace_id: x.workspace_id, due, owner: nameOf(who || actor) }); },
      async ticketLogCall(id, dir, who, body) { need('support.reply'); const x = tk(id); if (!['in', 'out'].includes(dir)) throw new Error('Choose whether they called us or we called them.');
        if (!String(body || '').trim()) throw new Error('Write what the call was about first.');
        x.messages.push(call(me().display_name, dir, String(who || '').trim() || null, String(body).trim(), now())); x.updated_at = now(); log('ticket.call', { ticket: x.ref, workspace_id: x.workspace_id, direction: dir }); },
      async diagnostic(ref) { need('support.diagnostics'); const d = diags[String(ref || '').trim().toUpperCase()]; if (!d) throw new Error(`There's no diagnostic report ${String(ref || '').trim().toUpperCase()}.`);
        const c = cos.find((y) => y.id === d.workspace_id); log('diagnostic.viewed', { workspace_id: d.workspace_id, diagnostic: d.ref });
        return { diagnostic: { ...d }, business: c ? { id: c.id, name: c.name, company_code: c.company_code } : null,
          tickets: permsOf(me()).includes('support.view') ? tickets.filter((x) => x.diag === d.ref).map((x) => ({ id: x.id, ref: x.ref, subject: x.subject, status: x.status })) : null }; },
      async ticketTrial(id) { need('trials.view'); const x = tk(id); const d = x.diag ? diags[x.diag] : null;
        if (!d || !d.trial) throw new Error('This ticket has no diagnostic report with a free-trial record. Ask the customer to use Get help → Report an issue in Riyeser Central.');
        log('trial.viewed', { ticket: x.ref, workspace_id: x.workspace_id, diagnostic: d.ref });
        const l = x.workspace_id ? demoLicence(x.workspace_id) : null;
        return { diag_ref: d.ref, reported_at: d.reported_at, report: JSON.parse(JSON.stringify(d.trial)),
          online: pcTrials.filter((p) => p.pc_id === d.trial.pc_id).map(({ pc_id, ...r }) => ({ ...r })),
          business: l ? Object.fromEntries(Object.entries(l.modules).map(([m, v]) => [m, { status: v.status, trial_ends: v.trial_ends, paid_until: v.paid_until, days_left: v.days_left }])) : null,
          can_extend: permsOf(me()).includes('licences.manage') }; },
      async trialExtend(id, program, days, reason) { need('licences.manage'); const x = tk(id); const d = x.diag ? diags[x.diag] : null;
        if (!['suite', 'estimate'].includes(program)) throw new Error('Choose a program.');
        if (!(days >= 1 && days <= 90)) throw new Error('Choose between 1 and 90 days.');
        if (String(reason || '').trim().length < 5) throw new Error('Say why (a few words).');
        if (!d || !d.trial || !d.trial.pc_id) throw new Error('This ticket has no report with a PC code, so there\'s no PC trial to extend.');
        let r = pcTrials.find((p) => p.pc_id === d.trial.pc_id && p.program === program);
        if (!r) { r = { pc_id: d.trial.pc_id, program, trial_start: ((d.trial.programs || []).find((p) => p.program === program) || {}).start || now(), first_seen: now(), last_seen: now(), extra_days: 0 }; pcTrials.push(r); }
        r.extra_days = Math.min(365, r.extra_days + days);
        log('trial.extended', { ticket: x.ref, workspace_id: x.workspace_id, diagnostic: d.ref, program, days, extra_days: r.extra_days, reason: String(reason).trim(), pc: d.trial.pc_id.slice(0, 8) });
        return { program, trial_start: r.trial_start, extra_days: r.extra_days, trial_ends: new Date(Date.parse(r.trial_start) + (90 + r.extra_days) * 864e5).toISOString() }; },
      async trialPcs() { need('licences.view'); const by = {}; pcTrials.forEach((p) => { const b = by[p.program] || (by[p.program] = { program: p.program, pcs: 0, on_trial: 0, seen_30d: 0 }); b.pcs += 1;
          if (Date.parse(p.trial_start) + (90 + p.extra_days) * 864e5 > Date.now()) b.on_trial += 1; if (Date.parse(p.last_seen) > Date.now() - 30 * 864e5) b.seen_30d += 1; });
        return Object.values(by).sort((a, b) => a.program.localeCompare(b.program)); },
      async noteEdit(id, body) { need('customers.notes'); if (!String(body || '').trim()) throw new Error('Write the note first.'); const [ws, n] = Object.entries(notes).map(([w, l]) => [w, l.find((x) => x.id === id)]).find(([, x]) => x) || [];
        if (!n) throw new Error('That note doesn\'t exist.'); n.body = body.trim(); log('note.edited', { workspace_id: ws, note: id }); },
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
      async setBusinessStatus(ws, st, reason, ticket) { need('business.close'); reasonOk(reason); const tr = ticketOk(ticket); const c = cos.find((x) => x.id === ws); const was = c.status; const wasDup = c.duplicate_of || null;
        Object.assign(c, { status: st, closed_at: st === 'active' ? null : now(), closed_reason: st === 'active' ? null : reason, duplicate_of: st === 'active' ? null : c.duplicate_of, last_active_at: st === 'active' ? now() : c.last_active_at });
        queue(c.owner_email, st === 'active' ? `${c.name} is open again on Riyeser` : `${c.name} has been ${st} on Riyeser`, st === 'active' ? 'business_reopened' : 'business_closed');
        log(st === 'active' ? 'business.reopened' : st === 'suspended' ? 'business.suspended' : 'business.closed', { workspace_id: ws, ticket: tr, reason, was, ...(st === 'active' && wasDup ? { was_duplicate_of: wasDup } : {}) }); },
      async dupCheck(ws) { need('business.close'); const c = cos.find((x) => x.id === ws); if (!c) throw new Error('That business doesn\'t exist.');
        const dig = (x) => String(x || '').replace(/\D/g, ''); const tax = (x) => String(x || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
        const nk = dupName(c.name); const ph = dig(c.owner_phone || c.phone);
        const matches = cos.filter((o) => o.id !== ws && o.status !== 'closed' && !o.removal_state).map((o) => { const on = dupName(o.name);
          const why = [o.owner_email && c.owner_email && o.owner_email.toLowerCase() === c.owner_email.toLowerCase() && 'Same owner email',
            ph.length >= 6 && dig(o.owner_phone || o.phone) === ph && 'Same phone', tax(c.tax_number) && tax(o.tax_number) === tax(c.tax_number) && 'Same tax number',
            nk.length >= 3 && (on === nk || (nk.length >= 5 && on.length >= 5 && (on.startsWith(nk) || nk.startsWith(on)))) && 'Similar name'].filter(Boolean);
          const gap = Math.abs(new Date(o.created_at) - new Date(c.created_at)) / 864e5;
          return { o, gap, why: why.length && gap < 14 ? [...why, gap < 1 ? 'Signed up the same day' : `Signed up ${Math.ceil(gap)} days apart`] : why, n: why.length }; })
          .filter((x) => x.n).sort((x, y) => y.n - x.n || x.gap - y.gap).slice(0, 6).map((x) => ({ ...dupCard(x.o), why: x.why }));
        return { this: dupCard(c), risks: dupRisks(dupCard(c)), matches }; },
      async dupSearch(ws, q) { need('business.close'); q = String(q || '').trim().toLowerCase(); if (q.length < 2) return [];
        return cos.filter((c) => c.id !== ws && [c.name, c.company_code, c.owner_email, c.tax_number].some((x) => String(x || '').toLowerCase().includes(q)))
          .sort((x, y) => (x.status === 'closed') - (y.status === 'closed')).slice(0, 8).map((c) => ({ ...dupCard(c), problem: keepProblem(ws, c) })); },
      async closeDuplicate(ws, keep, reason, ticket, code, accept) { need('business.close'); const c = cos.find((x) => x.id === ws); if (!c) throw new Error('That business doesn\'t exist.');
        if (c.status === 'closed') throw new Error('This account is already closed.');
        if (String(code || '').trim().toUpperCase() !== c.company_code.toUpperCase()) throw new Error(`Type this account's Company ID (${c.company_code}) to confirm.`);
        const k = keep ? cos.find((x) => x.id === keep) : null; if (keep) { const pr = keepProblem(ws, k); if (pr) throw new Error(pr); }
        const risks = dupRisks(dupCard(c), k && dupCard(k)); if (risks.length && !accept) throw new Error('Check the warnings first: ' + risks.map((x) => x.text).join(' '));
        const before = { status: c.status, closed_reason: c.closed_reason || null, duplicate_of: c.duplicate_of || null };
        await this.setBusinessStatus(ws, 'closed', reason, ticket); Object.assign(c, { duplicate_of: keep || null, closed_reason: 'Duplicate: ' + reason });
        log('business.duplicate', { workspace_id: ws, duplicate_of: keep || null, ticket: ticket ? ticket.toUpperCase() : null, reason, before, after: { status: c.status, closed_reason: c.closed_reason, duplicate_of: c.duplicate_of }, risks_accepted: risks.map((x) => x.code), data_deleted: false });
        return { closed: ws, duplicate_of: keep || null }; },
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
        return { ...c, people, next_follow_up: nextFu(ws), staff: staff.filter((x) => x.active).map((x) => ({ user_id: x.user_id, name: x.display_name })), owner: people.find((x) => x.role === 'owner') || null, pcs: pcsOf(co).concat(olderPcsOf(co)), licence: P.includes('licences.view') ? demoLicence(ws) : null, storage: P.includes('licences.view') ? demoStorage(ws) : null, monthly: demoMonthly(ws),
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
          && (!f.storage_80 || c.storage_pct >= 80)
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
            const est = Object.entries(per).reduce((a, [ws, n]) => { const pl = plans[ws] || {}; let v = n * 20 + (pl.extra_users || 0) * PRICE.extra_user + (pl.extra_companies || 0) * 10; if (pl.billing === 'yearly') v *= 10 / 12; if (pl.early_bird) v *= 0.5; return a + v; }, 0);
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
      // Website traffic, made up: a steady daily pattern (quieter at weekends) growing over the year
      async traffic(from, to) { need('reports.view'); const F = Date.parse(from + 'T00:00:00Z'); const T = Date.parse(to + 'T00:00:00Z');
        if (T < F) throw new Error('Choose a start date before the end date.');
        const rnd = (n) => ((n * 9301 + 49297) % 233280) / 233280;
        const dayOf = (t) => { const n = Math.floor(t / 864e5); const age = (Date.now() - t) / 864e5; const wd = new Date(t).getUTCDay();
          const visits = Math.max(0, Math.round((34 + (420 - age) * 0.1) * (wd === 0 ? 0.55 : wd === 6 ? 0.7 : 1) * (0.78 + rnd(n) * 0.44) + (n % 41 === 0 ? 60 : 0)));
          return { d: iso(t), visits, views: Math.round(visits * (2.1 + rnd(n + 7) * 0.7)) }; };
        const days = (a, b) => { const out = []; for (let t = a; t <= b; t += 864e5) out.push(dayOf(t)); return out; };
        const cur = days(F, T); const n = cur.length; const prev = days(F - n * 864e5, F - 864e5); const sum = (l, k) => l.reduce((a, x) => a + x[k], 0);
        const wk = n > 92; const mon = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return iso(x); };
        const series = wk ? Object.values(cur.reduce((a, x) => { const k = mon(x.d); const w = a[k] = a[k] || { d: k, visits: 0, views: 0 }; w.visits += x.visits; w.views += x.views; return a; }, {})) : cur;
        const V = sum(cur, 'visits'); const PV = sum(cur, 'views'); const share = (list) => list.map(([k, f]) => ({ k, visits: Math.round(V * f) })).filter((x) => x.visits);
        const inR = (c) => { const t = Date.parse(c.created_at); return t >= F && t < T + 864e5; }; const biz = cos.filter((c) => inR(c) && c.kind === 'business');
        return { from, to, today: iso(Date.now()), bucket: wk ? 'week' : 'day', visits: V, views: PV,
          prev: { from: iso(F - n * 864e5), to: iso(F - 864e5), visits: sum(prev, 'visits'), views: sum(prev, 'views') }, series,
          pages: [['/', 0.31], ['/pricing', 0.13], ['/programs', 0.1], ['/programs/accounting', 0.08], ['/downloads', 0.075], ['/programs/payroll', 0.06], ['/programs/pos', 0.05],
            ['/help', 0.04], ['/industries/trades', 0.035], ['/programs/link', 0.03], ['/help/start', 0.025], ['/terms', 0.01]].map(([path, f], i) => ({ path, views: Math.round(PV * f), visits: Math.round(V * f * (1.4 - i * 0.04)) })),
          referrers: share([['', 0.42], ['google.com', 0.31], ['facebook.com', 0.12], ['l.instagram.com', 0.05], ['bing.com', 0.035], ['linkedin.com', 0.02], ['fijisun.com.fj', 0.015]]).map((x) => ({ host: x.k, visits: x.visits })),
          campaigns: [['facebook', 'social', 'Early bird'], ['newsletter', 'email', 'November update'], ['google', 'cpc', 'Payroll Fiji']].map(([source, medium, campaign], i) => ({ source, medium, campaign, visits: Math.round(V * [0.06, 0.025, 0.012][i]) })),
          devices: share([['phone', 0.54], ['desktop', 0.38], ['tablet', 0.08]]), browsers: share([['Chrome', 0.58], ['Safari', 0.24], ['Edge', 0.1], ['Samsung', 0.05], ['Firefox', 0.03]]),
          regions: share([['Fiji', 0.52], ['Australia', 0.2], ['New Zealand', 0.11], ['Samoa', 0.04], ['Tonga', 0.03], ['Asia', 0.04], ['Americas', 0.03], ['Europe', 0.02], ['Pacific', 0.01]]),
          funnel: { visits: V, pricing: Math.round(V * 0.21), pricing_views: Math.round(V * 0.27), signups: Math.min(Math.round(V * 0.21), cos.filter(inR).length + Math.round(V * 0.004)),
            trials: biz.length, paid: biz.filter((c) => Object.values(demoLicence(c.id).modules).some((m) => m.status === 'active')).length } }; },
      async setOwner(ws, who) { if (!['customers.edit', 'support.assign', 'licences.manage'].some((p) => permsOf(me()).includes(p))) throw new Error('Your HQ role can\'t do that.');
        const c = cos.find((x) => x.id === ws); const was = nameOf(c.hq_owner); c.hq_owner = who || null; log('customer.owner_set', { workspace_id: ws, was, now: nameOf(who) }); },
      async handover() { return handover.slice().sort((a, b) => (a.done - b.done) || b.id - a.id); },
      async handoverAdd(note, d) { if (!String(note || '').trim()) throw new Error('Write the handover note first.'); const x = { id: hn++, note: note.trim(), shift_date: d || iso(Date.now()), done: false, by: me().display_name, author: actor, at: now() };
        handover.unshift(x); log('handover.added', { handover: x.id }); return x.id; },
      async handoverDone(id) { const x = handover.find((h) => h.id === id); if (!x || x.done) throw new Error('That handover note is already done.'); Object.assign(x, { done: true, done_by: me().display_name }); log('handover.done', { handover: id }); },
      async workQueue() { const P = permsOf(me()); const od = settings['support.overdue_hours']; const q = []; const co = (ws) => cos.find((c) => c.id === ws) || {};
        const add = (prio, kind, ws, issue, detail, owner, action, ref, at) => q.push({ prio, kind, workspace_id: ws, business: co(ws).name, country: co(ws).country, address: co(ws).address, account_kind: co(ws).account_kind || 'customer', issue, detail, owner: owner || nameOf(co(ws).hq_owner) || 'Unassigned', action, ref, at });
        if (P.includes('support.view')) tickets.filter((x) => x.status !== 'done' && x.workspace_id && x.next_update_due && new Date(x.next_update_due) < new Date())
          .forEach((x) => add(1, 'update', x.workspace_id, 'Update overdue', `${x.ref} · ${x.subject} · was due ${dueText(x.next_update_due)}`, nameOf(x.next_update_owner) || nameOf(x.assignee) || 'Unassigned', 'Update', x.id, x.next_update_due));
        if (P.includes('support.view')) tickets.filter((x) => ['new', 'investigating', 'waiting_us'].includes(x.status) && x.workspace_id && (!x.assignee || x.assignee === actor || (!x.first_reply_at && hours(x.created_at) > od)))
          .forEach((x) => add(1, 'complaint', x.workspace_id, !x.first_reply_at && hours(x.created_at) > od ? 'Overdue complaint' : 'Open complaint', x.subject, nameOf(x.assignee) || 'Unassigned', 'Reply', x.id, x.created_at));
        if (P.includes('offers.approve')) offers.filter((o) => o.status === 'waiting').forEach((o) => add(2, 'approval', o.workspace_id, 'Approval needed', `${o.days} free days · ${o.modules.map(modName).join(', ')}`, o.requested_by_name, 'Approve', o.id, o.created_at));
        if (P.includes('refunds.approve')) refunds.filter((f) => ['submitted', 'reviewing'].includes(f.status)).forEach((f) => add(3, 'refund', f.workspace_id, 'Refund waiting', `${f.currency} ${f.amount} · ${f.for_what}`, null, 'Review', f.id, f.created_at));
        if (P.includes('licences.view')) bOrders.filter((o) => ['payment_failed', 'suspended'].includes(o.status)).forEach((o) => add(2, 'payment', o.workspace_id, o.status === 'suspended' ? 'Payments stopped' : 'Payment failed', `${o.ref} · ${money(o.amount)}${o.grace_until ? ` · works until ${day(o.grace_until)}` : ''}`, null, 'Review', o.ref, o.updated_at || o.created_at));
        if (P.includes('licences.view')) bOrders.filter((o) => o.method === 'bank' && o.status === 'pending').forEach((o) => add(3, 'invoice', o.workspace_id, o.due_date < iso(Date.now()) ? 'Invoice overdue' : 'Invoice unpaid', `${o.ref} · ${money(o.total)} · due ${day(o.due_date)}`, null, 'Mark paid', o.ref, o.created_at));
        myFollowUps().filter((f) => f.due).forEach((f) => add(4, 'follow_up', f.workspace_id, 'Follow-up due', f.body, me().display_name, 'Follow up', String(f.id), f.follow_up));
        const ending = []; cos.filter((c) => c.status === 'active').forEach((c) => { const l = demoLicence(c.id); const e = Object.entries(l.modules).filter(([, v]) => ['trial', 'active'].includes(v.status) && v.days_left != null && v.days_left <= 7);
          if (e.length) { const d = Math.min(...e.map(([, v]) => v.days_left)); ending.push(c.id); add(5, 'renewal', c.id, e.some(([, v]) => v.status === 'active') ? 'Renewal due' : 'Trial ending', `${d === 0 ? 'Ends today' : `Ends in ${d} day${d === 1 ? '' : 's'}`} · ${e.length === 7 ? 'every program' : e.map(([m]) => modName(m)).join(', ')}`, null, 'Extend', null, addDays(today(), d)); } });
        cos.filter((c) => c.status === 'active' && !c.pcs && hours(c.created_at) / 24 >= 3 && hours(c.created_at) / 24 <= 30).forEach((c) => add(6, 'signup', c.id, 'Stuck signup', `Signed up ${Math.round(hours(c.created_at) / 24)} days ago, no PC linked yet`, null, 'Message', null, c.created_at));
        const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
        return { counts: { new_signups: cos.filter((c) => new Date(c.created_at) >= monday).length, failed_payments: P.includes('licences.view') ? bOrders.filter((o) => ['payment_failed', 'suspended'].includes(o.status)).length : null, renewals_due: ending.length, open_complaints: P.includes('support.view') ? tickets.filter((x) => x.status !== 'done').length : null },
          queue: q.sort((a, b) => a.prio - b.prio || String(a.at).localeCompare(String(b.at))).slice(0, 60) }; },
      async signups(days) { need('customers.view'); return cos.filter((c) => hours(c.created_at) / 24 <= days).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((c, i) => { const l = demoLicence(c.id); const pcs = pcsOf(c);
        return { id: c.id, name: c.name, company_code: c.company_code, country: c.country, kind: c.kind, created_at: c.created_at, status: c.status, hq_owner_name: nameOf(c.hq_owner), owner_name: c.owner_name, owner_email: c.owner_email,
          email_verified: i % 7 !== 3, on_trial: Object.values(l.modules).some((v) => ['trial', 'active'].includes(v.status)), pc_linked: c.pcs > 0, program_used: pcs.some((d) => (d.programs || []).some((x) => x.id !== 'central')),
          paying: Object.values(l.modules).some((v) => v.status === 'active'), installed: [...new Set(pcs.flatMap((d) => (d.programs || []).map((x) => x.id)))], people: c.people, next_follow_up: nextFu(c.id) }; }); },
      async attention(inc) { const P = permsOf(me()); const od = settings['support.overdue_hours']; const kindOf = (ws) => (cos.find((c) => c.id === ws) || {}).account_kind;
        const real = (ws) => inc || !ws || !kindOf(ws) || kindOf(ws) === 'customer'; const open = tickets.filter((x) => x.status !== 'done' && real(x.workspace_id));
        const sup = P.includes('support.view'); const L = (c) => demoLicence(c.id);
        return { unassigned: sup ? open.filter((x) => !x.assignee).length : null, overdue: sup ? open.filter((x) => !x.first_reply_at && hours(x.created_at) > od).length : null,
          updates_overdue: sup ? open.filter((x) => x.next_update_due && new Date(x.next_update_due) < new Date()).length : null,
          mine: sup ? open.filter((x) => ['new', 'investigating', 'waiting_us'].includes(x.status) && x.assignee === actor).length : null,
          approvals: P.includes('offers.approve') || P.includes('refunds.approve') ? offers.filter((o) => o.status === 'waiting' && real(o.workspace_id)).length + refunds.filter((f) => real(f.workspace_id)).map(rowOf).filter((f) => f.waiting_second).length : null,
          refunds_waiting: P.includes('refunds.view') ? refunds.filter((f) => ['submitted', 'reviewing'].includes(f.status) && real(f.workspace_id)).length : null,
          emails_failed: P.includes('emails.view') ? emails.filter((e) => ['failed', 'held'].includes(e.status)).length : null,
          trials_3d: cos.filter((c) => c.status === 'active' && real(c.id) && !Object.values(L(c).modules).some((v) => v.status === 'active')).map((c) => { const tr = Object.entries(L(c).modules).filter(([, v]) => v.status === 'trial' && v.days_left <= 3);
            return tr.length ? { id: c.id, name: c.name, company_code: c.company_code, days_left: Math.min(...tr.map(([, v]) => v.days_left)), modules: tr.map(([m]) => m) } : null; }).filter(Boolean).sort((a, b) => a.days_left - b.days_left),
          follow_ups: myFollowUps() }; },
    };
  }
  const api = DEMO ? demo() : online();
  const S = { me: null, tab: 'overview', companies: [], perms: [] };
  // can('a.b', 'c.d'): has at least one of these permissions. Older databases (no permissions yet): from the role.
  const can = (...perms) => !!S.me && perms.some((p) => S.perms.includes(p));
  // SEC-010: emailing invoices is its own permission (invoices.email); a database from before custom roles still uses licences.manage
  const canEmailDocs = () => can('invoices.email') || (!!S.me && S.me.role_name === undefined && can('licences.manage'));

  // ------------------------------------------------------------------ sign-in
  function gate(note = '', step = 'password') {
    $app.innerHTML = `<div class="gate"><form class="gcard" id="g"><div class="glogo">${wordmark()}<span class="glbl">HQ</span></div>
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
    $app.innerHTML = `<div class="gate"><div class="gcard"><div class="glogo">${wordmark()}<span class="glbl">HQ</span></div>${msg}
      <button class="btn w" id="so" style="margin-top:8px">Sign out</button></div></div>`;
    $app.querySelector('#so').onclick = () => signOutNow();
  }

  // Sign out (the account menu, the phone menu, the foot of the left-hand menu): ends the Supabase session (this browser,
  // or every device), forgets everything HQ loaded and shows the sign-in screen in this same page, so Back shows nothing.
  async function signOutNow(scope) {
    SESS.on = false; clearInterval(SESS.timer); closePanel();
    try { await api.signOut(scope); } catch { /* signed out here even if the server can't be reached */ }
    try { localStorage.removeItem('riyeser.hq.session'); } catch { /* no storage */ }
    try { Object.keys(sessionStorage).filter((k) => /^riyeser\.hq|^hq\./.test(k)).forEach((k) => sessionStorage.removeItem(k)); } catch { /* no storage */ }
    Object.keys(S).forEach((k) => delete S[k]); Object.assign(S, { me: null, tab: 'overview', companies: [], perms: [] });
    document.body.classList.remove('hqv2', 'mmopen'); document.title = 'Riyeser HQ';
    if (DEMO) { location.replace('/hq/'); return; }
    window.history.replaceState(null, '', location.pathname + location.search);
    gate(`<div class="note">${scope === 'global' ? 'You\'ve signed out of Riyeser HQ on every device.' : 'You\'ve signed out of Riyeser HQ.'}</div>`);
  }
  async function loadMe() {
    S.me = await api.me();
    // hq_me doesn't say who you are by id: the signed-in session does ("Assign to me", "You")
    if (S.me && !S.me.id) { try { const ss = await api.session(); if (ss && ss.user) S.me.id = ss.user.id; } catch { /* not needed to show HQ */ } }
    S.perms = S.me && S.me.active ? (S.me.perms || permsOf({ role: S.me.role })) : [];
    if (S.me && S.me.role_name) ROLE_NAMES[S.me.role] = S.me.role_name;
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
      if (!(await sessionStart())) return;
      if (V2 && !window.RiyeserHQv2) await loadV2();
      shell();
    } catch (err) { blocked(`<div class="err">${esc(plain(err))}</div>`); }
  }

  // ------------------------------------------------------------------ HQ sessions (owner's decision)
  // An HQ session ends after 30 minutes without activity and 12 hours after signing in. The database enforces it
  // (hq_role / hq_touch in team-chat.sql); here HQ tells the database you're active (at most once a minute while you use
  // it) and signs you out on time, with a plain note on the sign-in screen. Demo mode isn't timed.
  const ENDED = /HQ session has ended/;
  const SESS = { idle: 30, max: 12, signedIn: 0, last: 0, sent: 0, timer: 0, on: false };
  function sessionEnded(why) {
    if (!SESS.on) return; SESS.on = false; clearInterval(SESS.timer);
    const note = why === 'max' ? `You've been signed in for ${SESS.max} hours, so HQ signed you out. Sign in again to carry on.`
      : `HQ signed you out after ${SESS.idle} minutes without activity. Sign in again to carry on.`;
    closePanel(); S.v2 = null; document.body.classList.remove('hqv2');
    Promise.resolve(api.signOut()).catch(() => {}).then(() => gate(`<div class="note">${esc(note)}</div>`));
  }
  async function sessionStart() {
    if (DEMO || !api.touch) return true;
    let r; try { r = await api.touch(); } catch (e) { if (missing(e)) return true; throw e; }   // an older database: not timed yet
    SESS.idle = Number(r && r.idle_minutes) || 30; SESS.max = Number(r && r.max_hours) || 12;
    if (r && r.ok === false) { SESS.on = true; sessionEnded(r.ended); return false; }
    SESS.signedIn = r && r.signed_in_at ? Date.parse(r.signed_in_at) : Date.now(); SESS.last = SESS.sent = Date.now(); SESS.on = true;
    if (!SESS.wired) { SESS.wired = true;
      const active = () => { if (!SESS.on) return; SESS.last = Date.now();
        if (Date.now() - SESS.sent > 60e3) { SESS.sent = Date.now(); api.touch().then((x) => { if (x && x.ok === false) sessionEnded(x.ended); }).catch(() => {}); } };
      ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => document.addEventListener(ev, active, { passive: true, capture: true })); }
    clearInterval(SESS.timer);
    SESS.timer = setInterval(() => { if (!SESS.on) return;
      if (Date.now() - SESS.signedIn > SESS.max * 3600e3) sessionEnded('max'); else if (Date.now() - SESS.last > SESS.idle * 60e3) sessionEnded('idle'); }, 30e3);
    return true;
  }

  // ------------------------------------------------------------------ the shell
  // Every page HQ has (its address is #/<key>), and who can open it.
  const TABS = () => [['overview', 'Overview', can('overview.view')], ['companies', 'Customers', can('customers.view')], ['signups', 'Signups', can('customers.view')],
    ['licences', 'Licences', can('licences.view')], ['approvals', 'Approvals', can('refunds.approve', 'offers.approve')], ['refunds', 'Refunds', can('refunds.view')],
    ['payments', 'Invoices & payments', can('licences.view')], ['support', 'Support', can('support.view', 'support.diagnostics')], ['inbox', 'Team Inbox', can('overview.view')],
    ['inactive', 'Inactive accounts', can('customers.view', 'accounts.inactive')], ['health', 'System health', can('overview.view')], ['emails', 'Emails', can('emails.view')],
    ['downloads', 'Downloads', can('downloads.view')], ['reports', 'Business reports', can('reports.view')], ['traffic', 'Website traffic', can('reports.view')], ['team', 'HQ team', true], ['history', 'History', can('audit.view')],
    ['settings', 'Settings', can('settings.manage')], ['test-accounts', 'Test accounts', can('test_accounts.manage')]].filter((x) => x[2]);
  const VIEWS = () => ({ overview, companies, signups, licences, approvals, refunds, payments, support, inbox, inactive, health, emails, downloads, reports, traffic, team, history, settings, 'test-accounts': testAccounts });
  // The left-hand menu: the same on every screen, showing only what this person's permissions allow.
  const NAV = [['Overview', '🏠', ['overview']], ['Customers', '👥', ['companies']], ['Signups', '🌱', ['signups']],
    ['Billing & Licences', '💳', ['licences', 'approvals', 'refunds', 'payments']], ['Support', '🎧', ['support']], ['Team Inbox', '💬', ['inbox']],
    ['Retention', '🔁', ['inactive']], ['System Operations', '🛠️', ['health', 'emails', 'downloads']], ['Reports', '📊', ['reports', 'traffic']], ['Admin', '⚙️', ['team', 'history', 'settings', 'test-accounts']]];
  const SOON = { inbox: 'soon' };
  // A group (Billing & Licences, System Operations, Admin) is a heading that folds its pages away (remembered); it isn't a
  // page itself, so only the page you're on is highlighted.
  const navClosed = () => { try { return JSON.parse(localStorage.getItem('hq.navClosed') || '[]'); } catch { return []; } };
  function navHtml() {
    const ok = TABS(); const label = (k) => (ok.find((x) => x[0] === k) || [k, k])[1]; const shut = navClosed();
    return NAV.map(([name, icon, views]) => { const v = views.filter((k) => ok.some((x) => x[0] === k)); if (!v.length) return '';
      if (v.length === 1) return `<button class="nv" data-tab="${v[0]}"><span class="ni" aria-hidden="true">${icon}</span><span class="nl">${v.length === 1 && views.length > 1 ? label(v[0]) : name}</span>${SOON[v[0]] ? `<em class="soon">${SOON[v[0]]}</em>` : ''}<span class="tb" data-badge="${v[0]}"></span></button>`;
      const open = !shut.includes(name); const id = 'ng-' + name.toLowerCase().replace(/[^a-z]+/g, '-');
      return `<button type="button" class="nv ngrp" data-grp="${esc(name)}" aria-expanded="${open}" aria-controls="${id}"><span class="ni" aria-hidden="true">${icon}</span><span class="nl">${name}</span><span class="tb" data-gbadge="${esc(name)}"></span><span class="ncar" aria-hidden="true">▾</span></button>
        <div class="nkids" id="${id}" data-of="${esc(name)}"${open ? '' : ' hidden'}>${v.map((k) => `<button class="nv nsub" data-tab="${k}"><span class="nl">${label(k)}</span>${SOON[k] ? `<em class="soon">${SOON[k]}</em>` : ''}<span class="tb" data-badge="${k}"></span></button>`).join('')}</div>`; }).join('');
  }
  // On a phone the left-hand menu is a compact bar (logo, the page you're on, Menu, you) and the Menu button opens every
  // page in its group, the current one marked.
  function phoneMenuHtml() {
    const ok = TABS(); const label = (k) => (ok.find((x) => x[0] === k) || [k, k])[1];
    return NAV.map(([name, icon, views]) => { const v = views.filter((k) => ok.some((x) => x[0] === k)); if (!v.length) return '';
      const item = (k, txt, ic) => `<button class="mmi" data-tab="${k}"><span class="ni" aria-hidden="true">${ic}</span><span class="nl">${txt}</span>${SOON[k] ? `<em class="soon">${SOON[k]}</em>` : ''}<span class="tb" data-badge="${k}"></span></button>`;
      if (v.length === 1) return item(v[0], views.length > 1 ? label(v[0]) : name, icon);
      return `<div class="mmg"><div class="mmh">${icon} ${name}</div>${v.map((k) => item(k, label(k), '')).join('')}</div>`; }).join('');
  }
  function shell() {
    // the V2 layout (only with ?v2=1); if it fails to start, the current layout below is used instead
    if (V2 && window.RiyeserHQv2) { try { S.v2 = window.RiyeserHQv2.mount(v2ctx()); return; } catch (err) { S.v2 = null; console.error('HQ V2:', err); document.body.classList.remove('hqv2'); } }
    if (!TABS().some((x) => x[0] === S.tab)) S.tab = TABS()[0][0];
    const ini = initials(S.me.name);
    $app.innerHTML = `${DEMO ? `<div class="demo">Demo with sample data. Nothing here is real. <label>Acting as <select id="demoAs" aria-label="Demo staff member">${api.staffList().map((s) => `<option value="${s.user_id}"${s.display_name === S.me.name ? ' selected' : ''}>${esc(s.display_name)} (${esc(roleName(s.role))})</option>`).join('')}</select></label></div>` : ''}
      <div class="frame"><aside class="side"><div class="brand" role="img" aria-label="Riyeser HQ">${wordmark(false)}<span class="glbl">HQ</span></div><nav class="snav" aria-label="HQ">${navHtml()}</nav>
        <p class="sfoot">Staff only · account information, never customers' messages or books</p><button type="button" class="sout" data-signout>Sign out</button></aside>
      <header class="mbar"><span class="mlogo" role="img" aria-label="Riyeser HQ">${wordmark(false)}</span><span class="mbt" id="mbarT"></span>
        <button type="button" id="mnav" class="mnav" aria-expanded="false" aria-controls="mmenu">Menu <span class="tb" data-mbadge></span></button>
        <button type="button" class="av mav2" id="mme" aria-label="${esc(S.me.name)}, open the menu">${esc(ini)}</button></header>
      <div class="mmenu" id="mmenu" hidden><nav class="mml" aria-label="HQ sections">${phoneMenuHtml()}</nav>
        <div class="mmfoot"><span class="av">${esc(ini)}</span><span class="mmwho">${esc(S.me.name)} <small>${esc(roleName(S.me.role))}</small></span><button type="button" id="so2" class="btn sm" data-signout>Sign out</button>
          <button type="button" class="btn sm" data-signout="global">Sign out of all devices</button></div></div>
      <div class="mcol"><header class="mtop"><form id="gsearch" class="gsearch" role="search"><input name="q" placeholder="Search customers by name, Company ID, ABN, phone or email…" aria-label="Search customers"></form>
        ${acctMenu()}</header>
      <main id="main"></main></div></div>`;
    $app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { S.ticket = null; go('#/' + b.dataset.tab); });
    $app.querySelectorAll('.ngrp').forEach((g) => g.onclick = () => { const open = g.getAttribute('aria-expanded') !== 'true'; g.setAttribute('aria-expanded', String(open));
      $app.querySelector(`.nkids[data-of="${CSS.escape(g.dataset.grp)}"]`).hidden = !open;
      const shut = navClosed().filter((x) => x !== g.dataset.grp); if (!open) shut.push(g.dataset.grp); try { localStorage.setItem('hq.navClosed', JSON.stringify(shut)); } catch { /* not remembered */ } });
    $app.querySelectorAll('[data-signout]').forEach((b) => b.onclick = () => signOutNow(b.dataset.signout || 'local'));
    const mm = $app.querySelector('#mmenu'); const mb = $app.querySelector('#mnav');
    const menu = (open) => { if (open) mm.style.top = Math.max(0, $app.querySelector('.mbar').getBoundingClientRect().bottom) + 'px'; mm.hidden = !open; mb.setAttribute('aria-expanded', String(open)); document.body.classList.toggle('mmopen', open);
      if (open) { const cur = mm.querySelector('.mmi.on') || mm.querySelector('.mmi'); if (cur) cur.focus(); } };
    mb.onclick = () => menu(mm.hidden); $app.querySelector('#mme').onclick = () => menu(mm.hidden);
    mm.onclick = (e) => { if (e.target === mm || e.target.closest('[data-tab]')) menu(false); };
    document.onkeydown = (e) => { if (e.key === 'Escape' && !mm.hidden) { menu(false); mb.focus(); } };
    document.onclick = (e) => { if (!mm.hidden && !e.target.closest('#mmenu, #mnav, #mme')) menu(false); };
    S.menu = menu;
    $app.querySelector('#gsearch').onsubmit = (e) => { e.preventDefault(); const q = String(new FormData(e.target).get('q') || '').trim();
      S.cl = { ...(S.cl || { f: {}, sort: 'created', desc: true, view: 'all' }), q, page: 1 }; e.target.reset(); go('#/companies'); };
    const das = $app.querySelector('#demoAs'); if (das) das.onchange = async () => { api.asStaff(das.value); await loadMe(); closePanel(); shell(); };
    if (matchMedia('(max-width: 640px)').matches) $app.querySelector('#gsearch input').placeholder = 'Search customers…';
    route();
    badges();
  }
  // The account menu at the top right of every page: who you are and Sign out.
  const acctMenu = () => `<details class="dd acct" id="acct"><summary class="acs" aria-label="${esc(S.me.name)}, ${esc(roleName(S.me.role))}: account menu"><span class="av">${esc(initials(S.me.name))}</span><span class="mn">${esc(S.me.name)} · ${esc(roleName(S.me.role))}</span><span class="car" aria-hidden="true">▾</span></summary>
    <div class="ddm right"><div class="acwho"><b>${esc(S.me.name)}</b><small>${esc(roleName(S.me.role))} · Riyeser HQ</small></div>
      <button type="button" id="so" data-signout>Sign out</button><button type="button" data-signout="global">Sign out of all devices</button></div></details>`;
  const initials = (n) => String(n || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map((w) => w[0]).join('').toUpperCase() || '?';
  // Pages have addresses (#/companies, #/company/<id>/programs, …), so they can be linked to and Back works.
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  const showErr = (err) => { const m = document.getElementById('main'); if (m) m.innerHTML = missing(err) ? SWITCH_ON : `<div class="err">${esc(plain(err))}</div>`; };
  function route() {
    if (S.v2) return S.v2.route();
    if (!document.getElementById('main')) return;
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const mark = (k) => { const t = $app.querySelector('#mbarT'); if (t) t.textContent = (TABS().find((x) => x[0] === k) || [k, k])[1];
      if (S.menu) S.menu(false);
      $app.querySelectorAll('.snav [data-tab], .mml [data-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.tab === k); if (b.dataset.tab === k) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
      // a folded group with the current page in it shows a quiet marker
      $app.querySelectorAll('.ngrp').forEach((g) => g.classList.toggle('cur', !!$app.querySelector(`.nkids[data-of="${CSS.escape(g.dataset.grp)}"] [data-tab="${k}"]`))); };
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
    const set = (k, n) => { $app.querySelectorAll(`[data-badge="${k}"]`).forEach((el) => { el.textContent = n ? String(n) : ''; });
      const mb = $app.querySelector('[data-mbadge]'); if (mb) { const t = [...$app.querySelectorAll('.mml [data-badge]')].reduce((a, x) => a + (Number(x.textContent) || 0), 0); mb.textContent = t ? String(t) : ''; }
      // a group heading adds up its pages' counts (shown while it's folded)
      $app.querySelectorAll('[data-gbadge]').forEach((g) => { const t = [...$app.querySelectorAll(`.nkids[data-of="${CSS.escape(g.dataset.gbadge)}"] [data-badge]`)].reduce((a, x) => a + (Number(x.textContent) || 0), 0); g.textContent = t ? String(t) : ''; }); };
    if (can('support.view')) api.tickets('open', '').then((r) => set('support', (r.counts || {}).new + (r.counts || {}).waiting_us || 0)).catch(() => {});
    if (can('refunds.approve', 'offers.approve')) api.approvals().then((r) => set('approvals', (r.refunds || []).length + (r.offers || []).length)).catch(() => {});
  }
  // On a phone every table shows each row as a card: the first cell is the title, the others are "Label: value" lines
  // (labels from the header cells), and a cell of buttons sits full width at the bottom. The CSS does the layout.
  const cardTables = (root) => root.querySelectorAll('table.tbl:not(.progtbl)').forEach((t) => {
    const rows = [...t.rows]; const head = rows.find((r) => r.cells.length && [...r.cells].every((c) => c.tagName === 'TH')); t.classList.add('tcards');
    const names = []; if (head) { head.classList.add('thr'); [...head.cells].forEach((c) => { for (let i = 0; i < (c.colSpan || 1); i++) names.push(c.textContent.replace(/[▲▼↑↓⇅]/g, '').trim()); }); }
    rows.forEach((r) => { if (r === head || r.dataset.cardOk === String(r.cells.length)) return; r.dataset.cardOk = String(r.cells.length); let col = 0;
      // the title: the business or person (a link to it, or the bold name) among the first columns, else the first cell
      const cells = [...r.cells]; const who = (c) => c && c.querySelector('[data-goco], .cust, b, strong');
      // a tick-box column on its own goes to the card's top right corner
      if (cells.length > 1 && !cells[0].textContent.trim() && cells[0].querySelector('input[type=checkbox]')) { cells[0].classList.add('tchk'); cells.shift(); col = 1; }
      let ti = who(cells[0]) || !cells[0] || cells[0].colSpan > 1 ? 0 : cells.slice(1, 3).findIndex((c) => c.querySelector('[data-goco], .cust')) + 1;
      if (ti > 0 && cells[ti].querySelector('.btn:not(.cp)')) ti = 0;
      cells.forEach((c, i) => { const span = c.colSpan || 1; const name = span === 1 ? names[col] || '' : ''; col += span;
        if (i === ti) { c.classList.add('tttl'); if (c.tagName === 'TH') c.classList.add('tth'); return; }
        const ctl = c.querySelector('button:not(.cp):not(.lnk), .btn:not(.cp), select, details, input:not([type=checkbox]):not([type=radio])');
        const txt = c.textContent.trim();
        if (span > 1 && r.cells.length === 1) c.classList.add('tfull');
        else if (ctl && (!name || !txt || [...c.children].every((k) => k.matches('button, .btn, details, form, .nact, .qbtns, .row')))) c.classList.add('tacts');
        else if (!txt && !c.querySelector('img, svg, input, .ck, .pill, .avatar')) c.classList.add('tempty');
        else if (name && !c.hasAttribute('data-label')) c.setAttribute('data-label', name); }); });
  });
  // A box that scrolls sideways is only ever a wide data table (marked data-wide: a tidy scrollbar and a sticky first
  // column, see hq.css); everything else fits its box.
  const wideTables = (root) => root.querySelectorAll('.scroll, .tw2').forEach((el) => { if (el.querySelector('table') && !el.hasAttribute('data-wide')) el.setAttribute('data-wide', ''); });
  let cardQ = 0;
  new MutationObserver(() => { if (!cardQ) cardQ = requestAnimationFrame(() => { cardQ = 0; cardTables(document); wideTables(document); }); }).observe(document.body, { childList: true, subtree: true });
  // Row menus (⋯, ▾, Filters…: <details class="dd">) float above the page: fixed to the window next to their button,
  // flipped up or left when there's no room, so they're never cut off by a table or card and never add a scrollbar.
  // One open at a time; a click elsewhere or Esc closes it.
  function placeMenu(d) {
    const m = d.querySelector(':scope > .ddm'); const sm = d.querySelector(':scope > summary'); if (!m || !sm) return;
    const pad = 8; const vw = document.documentElement.clientWidth; const vh = window.innerHeight;
    Object.assign(m.style, { position: 'fixed', left: '0px', top: '0px', right: 'auto', bottom: 'auto', maxHeight: '', overflowY: '', maxWidth: `${vw - 2 * pad}px`, visibility: 'hidden' });
    const s = sm.getBoundingClientRect(); const w = m.offsetWidth; let h = m.offsetHeight;
    if (h > vh - 2 * pad) { m.style.maxHeight = `${vh - 2 * pad}px`; m.style.overflowY = 'auto'; h = vh - 2 * pad; }
    const alignRight = m.classList.contains('right') || s.left + s.width / 2 > vw / 2;
    const left = Math.max(pad, Math.min(alignRight ? s.right - w : s.left, vw - w - pad));
    let top = s.bottom + 4; if (top + h > vh - pad) top = s.top - 4 - h >= pad ? s.top - 4 - h : Math.max(pad, vh - pad - h);
    Object.assign(m.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, visibility: '' });
  }
  const openMenus = () => [...document.querySelectorAll('details.dd[open]')];
  document.addEventListener('toggle', (e) => { const d = e.target; if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('dd')) return;
    if (d.open) { openMenus().forEach((x) => { if (x !== d && !x.contains(d)) x.open = false; }); placeMenu(d); }
    else { const m = d.querySelector(':scope > .ddm'); if (m) m.removeAttribute('style'); } }, true);
  document.addEventListener('click', (e) => { openMenus().forEach((d) => { if (!d.contains(e.target)) d.open = false; }); }, true);
  document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; openMenus().forEach((d) => { d.open = false; const sm = d.querySelector('summary'); if (sm && d.contains(document.activeElement)) sm.focus(); }); });
  const replace = () => openMenus().forEach(placeMenu);
  window.addEventListener('scroll', replace, true); window.addEventListener('resize', replace);
  const main = (html) => { const m = document.getElementById('main'); m.className = ''; m.innerHTML = html; return m; };

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
      <div class="xlab">${(() => { const st = Math.max(1, Math.ceil(rows.length / 6)); const rest = rows.length % st;
        return rows.map((r, i) => (i % st === 0 && i + st <= rows.length ? `<span style="flex-grow:${st}">${esc(label(r))}</span>` : '')).join('') + (rest ? `<span style="flex-grow:${rest}"></span>` : ''); })()}</div>`;
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
  const ISSUE = { update: 'bad', complaint: 'blue', approval: 'violet', refund: 'warn', follow_up: 'warn', renewal: 'warn', signup: 'violet', payment: 'bad', invoice: 'warn' };
  const card = (icon, cls, k, v, d, href, id) => `<${href ? `a class="ccard click" href="${href}"${id ? ` id="${id}"` : ''}` : 'div class="ccard"'}><span class="cic ${cls}" aria-hidden="true">${icon}</span><div class="cbody"><div class="k">${k}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div></${href ? 'a' : 'div'}>`;
  // "Assigned to" on every HQ list: the person looking after it ("You" when that's you), or "Unassigned" with the team whose
  // queue it's in. Older databases answer a team name ("Finance") or "Unassigned" in place of a person; that's a queue, not a person.
  const TEAM_OF = { complaint: 'Support', update: 'Support', approval: 'Approvers', refund: 'Finance', payment: 'Finance', invoice: 'Finance', renewal: 'Sales', signup: 'Sales' };
  const NOT_A_PERSON = ['', 'Unassigned', 'Nobody', 'Finance', 'Support', 'Sales', 'Riyeser', 'Approvers'];
  function assignedTo(x) {
    const raw = x.kind === 'approval' ? null : (x.assignee_name !== undefined ? x.assignee_name : x.owner);
    const who = raw && !NOT_A_PERSON.includes(String(raw).trim()) ? String(raw).trim() : null;
    const team = x.team || TEAM_OF[x.kind] || (raw && NOT_A_PERSON.includes(raw) && raw !== 'Unassigned' ? raw : '');
    return { who, you: !!who && !!S.me && who === S.me.name, team };
  }
  const assignedHtml = (a, assignBtn = '') => (a.who ? `<span class="asg">${avatar(a.you ? S.me.name : a.who, 'sm')} <span>${a.you ? '<b>You</b>' : esc(a.who)}</span></span>`
    : `<span class="asg none"><span class="muted">Unassigned</span>${a.team ? `<small class="tteam">${esc(a.team)} team</small>` : ''}${assignBtn}</span>`);
  // "Assign to me" on a work-queue item: a ticket is assigned to you; anything else makes you the person looking after that customer.
  const canAssign = (x) => !!x.workspace_id && x.kind !== 'follow_up' && (['complaint', 'update'].includes(x.kind) ? can('support.assign', 'support.reply') : can('customers.edit', 'support.assign', 'licences.manage'));
  async function assignToMe(x) {
    if (['complaint', 'update'].includes(x.kind)) await api.ticketAssign(x.ref, S.me.id); else await api.setOwner(x.workspace_id, S.me.id);
    flash(['complaint', 'update'].includes(x.kind) ? 'Ticket assigned to you.' : `${x.business || 'The customer'} is now assigned to you.`);
  }
  // Test, demo and internal accounts are left out of the figures unless "Include test accounts" is ticked (the same setting as HQ V2).
  const inclTest = () => { try { return localStorage.getItem('hq.v2.inclTest') === '1'; } catch { return false; } };
  const setInclTest = (on) => { try { if (on) localStorage.setItem('hq.v2.inclTest', '1'); else localStorage.removeItem('hq.v2.inclTest'); } catch { /* not remembered */ } };
  const realAccount = (x) => !x.account_kind || x.account_kind === 'customer';
  const QUEUE_SHOWN = 10;
  async function overview() {
    main('<p class="muted">Loading…</p>');
    const inc = inclTest();
    const soft = (p) => p.catch((e) => (missing(e) ? { missing: true } : null));
    const [o, wq, a, ho, off, pr, k] = await Promise.all([api.overview(inc).catch(() => null), soft(api.workQueue()), soft(api.attention(inc)), soft(api.handover()),
      api.linkOffline ? api.linkOffline().catch(() => undefined) : undefined, can('licences.view') && api.paymentsReceived ? api.paymentsReceived(7).catch(() => null) : null,
      api.kpis ? api.kpis(inc).catch(() => null) : null]);
    const cn = (wq && !wq.missing && wq.counts) || {}; const q = ((wq && !wq.missing && wq.queue) || []).filter((x) => inc || realAccount(x));
    const hiddenQ = ((wq && !wq.missing && wq.queue) || []).length - q.length;
    // the count cards: from hq_kpis (test accounts left out) when the database has it, else the work queue's counts
    const K = k && !k.missing ? k : null; const pick = (kv, old) => (K ? kv : old);
    const pay = K && K.payments_7d ? K.payments_7d : pr; const dash = (v) => (v == null ? '—' : num(v));
    const wk = o ? (o.signups_by_week || []).map((w) => ({ ...w, label: new Date(w.week).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) })) : [];
    const testNote = K && Number(K.test_accounts) ? (inc ? 'Test accounts included' : `${num(K.test_accounts)} test account${Number(K.test_accounts) === 1 ? '' : 's'} left out`) : '';
    const m = main(`<div class="phead"><div><h2>Operations overview</h2><p class="sub">Good to see you, ${esc(String(S.me.name || '').split(' ')[0])}. Account information only: HQ never sees customers' messages or books.</p></div>
        <div class="pacts">${testNote ? `<span class="muted small">${esc(testNote)}</span>` : ''}<label class="swl"><input type="checkbox" id="inclTest"${inc ? ' checked' : ''}> Include test accounts</label></div></div>
      <div class="ccards">${card('👤', 'blue', 'New signups', dash(pick(K && K.new_signups_week, cn.new_signups ?? (o && o.companies_7d))), 'this week', can('customers.view') ? '#/signups' : '')}
        ${card('💳', 'red', 'Failed payments', dash(pick(K && K.failed_payments, cn.failed_payments)), 'PayPal, in their grace period', can('licences.view') ? '#/payments' : '')}
        ${pay ? card('💵', 'green', 'Payments received', money(pay.total), `${num(pay.count)} payment${Number(pay.count) === 1 ? '' : 's'} in the last 7 days`, '#/payments', 'payRecv') : ''}
        ${card('🔄', 'green', 'Renewals due', dash(pick(K && K.renewals_due_7d, cn.renewals_due)), 'trials and paid, next 7 days', can('licences.view') ? '#/licences' : '')}
        ${card('⚠️', 'amber', 'Open complaints', dash(pick(K && K.open_tickets, cn.open_complaints)), 'open support tickets', can('support.view') ? '#/support' : '')}</div>
      <div class="ops"><div class="opsl">
        <div class="card" id="queueCard"><h3>Needs attention <small>· ${q.length ? `${q.length} item${q.length === 1 ? '' : 's'} for you` : 'nothing waiting'}${hiddenQ ? ` · ${hiddenQ} from test accounts hidden` : ''}</small></h3>
          ${wq && wq.missing ? '<p class="muted small">Run the latest <b>team-chat.sql</b> in Supabase (SQL Editor) to switch on the work queue.</p>'
            : q.length ? `<table class="tbl queue" id="queue"><thead><tr><th>Customer</th><th>Issue</th><th>Assigned to</th><th class="r">Next action</th></tr></thead><tbody>
            ${q.map((x, i) => `<tr data-kind="${esc(x.kind)}"${i >= QUEUE_SHOWN ? ' class="qmore" hidden' : ''}><td><div class="cust">${avatar(x.business, 'sq')}<div><button class="lnk" data-goco="${esc(x.workspace_id)}"><b>${esc(x.business || '')}</b></button><small>${esc(cityOf(x))}</small>${realAccount(x) ? '' : `<small class="akind">${esc(x.account_kind)} account</small>`}</div></div></td>
              <td><span class="pill ${ISSUE[x.kind] || ''}">${esc(x.issue)}</span><small>${esc(x.detail || '')}${x.kind === 'approval' && x.owner && !NOT_A_PERSON.includes(x.owner) ? ` · asked by ${esc(x.owner)}` : ''}</small></td>
              <td>${assignedHtml(assignedTo(x), canAssign(x) && !assignedTo(x).who ? `<button class="lnk asgme" data-assignme="${i}">Assign to me</button>` : '')}</td>
              <td class="r"><div class="nact"><button class="btn sm p" data-qi="${i}">${esc(x.action)}</button><details class="dd"><summary class="btn sm" aria-label="More actions for ${esc(x.business || 'this customer')}">⋯</summary><div class="ddm right">
                <button data-qm="open" data-qi="${i}">Open customer</button><button data-qm="conversations" data-qi="${i}">Conversations</button>
                ${can('support.reply') ? `<button data-qm="message" data-qi="${i}">Send customer reply</button>` : ''}${can('customers.notes') ? `<button data-qm="call" data-qi="${i}">Log a call</button><button data-qm="note" data-qi="${i}">Add internal note</button>` : ''}
                ${can('licences.view') ? `<button data-qm="programs" data-qi="${i}">Programs and licence</button>` : ''}${can('test_accounts.manage') && realAccount(x) ? `<button data-qm="test" data-qi="${i}">Mark as a test account…</button>` : ''}</div></details></div></td></tr>`).join('')}</tbody></table>
            ${q.length > QUEUE_SHOWN ? `<div class="qfoot"><button type="button" class="btn sm" id="queueAll" aria-expanded="false">Show all ${q.length}</button></div>` : ''}`
            : `<p class="muted small">Nothing needs you right now. 🎉${hiddenQ ? ` (${hiddenQ} item${hiddenQ === 1 ? '' : 's'} from test accounts hidden.)` : ''}</p>`}</div>
        ${attentionHtml(a, off)}
      </div><div class="opsr">${systemHealthCard(off, a)}${handoverCard(ho)}</div></div>
      ${o ? `<h3 class="h3 sect">Riyeser at a glance${o.include_test === false ? ' <small class="muted">· test accounts left out</small>' : ''}</h3><div class="tiles">${tile('Companies', num(o.companies), `+${num(o.companies_7d)} this week · +${num(o.companies_30d)} in 30 days`)}
          ${tile('People', num(o.people), 'in all companies')}${tile('Linked PCs', num(o.pcs), `${num(o.pcs_active_7d)} active this week`)}
          ${tile('Riyeser Link', num(o.calls_paid) + ' paid', `${num(o.calls_trial)} on the free trial`)}</div>
        <div class="grid g3 ovcharts"><div class="card"><h3>New companies per week</h3>${columnChart(wk, (r) => r.label, (r) => Number(r.companies), 'companies')}</div>
          <div class="card"><h3>Riyeser Central versions in use <small>· PCs seen in 30 days</small></h3>${barList(o.versions || [], (r) => r.version, (r) => Number(r.pcs))}</div>
          <div class="card"><h3>Companies by country</h3>${barList(o.countries || [], (r) => r.country, (r) => Number(r.companies))}
            <p class="muted small" style="margin-top:12px">${num(o.requests_waiting)} join request${o.requests_waiting === 1 ? '' : 's'} waiting for a company admin · ${num(o.pcs_active_30d)} PCs active in 30 days</p></div></div>` : ''}`);
    wireAttention(m, overview); wireHealth(m);
    m.querySelector('#inclTest').onchange = (e) => { setInclTest(e.target.checked); overview(); };
    const all = m.querySelector('#queueAll'); if (all) all.onclick = () => { const open = all.getAttribute('aria-expanded') !== 'true'; m.querySelectorAll('#queue tr.qmore').forEach((r) => { r.hidden = !open; });
      all.setAttribute('aria-expanded', String(open)); all.textContent = open ? `Show the first ${QUEUE_SHOWN}` : `Show all ${q.length}`; };
    m.querySelectorAll('[data-assignme]').forEach((b) => b.onclick = async () => { b.disabled = true; try { await assignToMe(q[Number(b.dataset.assignme)]); overview(); } catch (err) { b.disabled = false; alert(plain(err)); } });
    m.querySelectorAll('[data-qi]').forEach((b) => b.onclick = () => { const x = q[Number(b.dataset.qi)]; const mm = b.dataset.qm; b.closest('details') && b.closest('details').removeAttribute('open');
      if (mm === 'test') { S.taPrefill = x.business || ''; return go('#/test-accounts'); }
      if (mm) { if (['message', 'call', 'note'].includes(mm)) S.cpAfter = mm; return openCompany(x.workspace_id, mm === 'programs' ? 'programs' : ['open', 'note'].includes(mm) ? null : 'conversations'); }
      if (x.kind === 'complaint' || x.kind === 'update') { S.ticket = x.ref; return go('#/support'); }
      if (x.kind === 'approval') return go('#/approvals');
      if (x.kind === 'refund') return go('#/refunds');
      if (x.kind === 'invoice') { S.markPaid = x.ref; return go('#/payments'); }
      if (x.kind === 'payment') return openCompany(x.workspace_id, 'money');
      if (x.kind === 'renewal') return openCompany(x.workspace_id, 'programs');
      if (x.kind === 'signup') { S.cpAfter = 'message'; return openCompany(x.workspace_id, 'conversations'); }
      return openCompany(x.workspace_id, 'conversations'); });
    const hb = m.querySelector('#hoAdd'); if (hb) hb.onclick = addHandover;
    m.querySelectorAll('[data-hodone]').forEach((b) => b.onclick = async () => { try { await api.handoverDone(Number(b.dataset.hodone)); overview(); } catch (err) { alert(plain(err)); } });
  }
  // Backups and restore tests: the last run of each GitHub job (read without a token, so only while the code repository
  // is public). Rate limits only make it say "couldn't check".
  async function ghRun(file) {
    const key = 'riyeser.hq.gh.' + file;
    try { const c = JSON.parse(sessionStorage.getItem(key) || 'null'); if (c && Date.now() - c.t < 10 * 60e3) return c.v; } catch { /* no storage */ }
    let v;
    try { const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${file}/runs?per_page=1`, { headers: { Accept: 'application/vnd.github+json' } });
      // 404: the job isn't there yet, or (once the code repository is private) GitHub won't show it without signing in
      if (r.status === 404) v = { state: 'unknown', note: 'Not shown here (private repository, or not set up yet): see GitHub jobs' };
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
    dlg(`<h3>Add handover note</h3><p class="muted small">For whoever is on next. Every note is kept in the HQ history.</p><form id="hof"><label class="f"><span>Note</span><textarea name="note" rows="2" required maxlength="1000" placeholder="e.g. Harbour Cafe complaint: update the customer after 3 pm"></textarea></label>
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
      <div class="card scroll"><table class="tbl sutbl" id="sutbl"><tr><th>Business</th>${STAGES.map(([, l]) => `<th class="c">${l}</th>`).join('')}<th>Blocking go-live</th><th>Assigned to</th><th></th></tr>
      ${rows.map((x) => { const st = stagesOf(x); const blk = STAGES.find(([k]) => !st[k]);
        return `<tr data-su="${esc(x.id)}"><td><button class="lnk" data-goco="${esc(x.id)}"><b>${esc(x.name)}</b></button><small>${esc(x.owner_name || '')}${x.owner_email ? ` · ${esc(x.owner_email)}` : ''} · ${ago(x.created_at)}</small></td>
          ${STAGES.map(([k]) => `<td class="c">${check(st[k])}</td>`).join('')}<td>${blk ? `<span class="pill warn">${esc(blk[1])}</span><small>${esc(BLOCK[blk[0]] || '')}</small>` : '<span class="pill ok">Live</span>'}</td>
          <td>${assignedHtml({ who: x.hq_owner_name || null, you: !!x.hq_owner_name && x.hq_owner_name === S.me.name, team: 'Sales' })}${x.next_follow_up ? `<small>follow up ${day(x.next_follow_up.date)}</small>` : ''}</td>
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
  // ------------------------------------------------------------------ Invoices & payments: PayPal, bank transfers, the Billing entity
  const ORDER_ST = { pending: ['Waiting', 'warn'], active: ['Active', 'ok'], paid: ['Paid', 'ok'], payment_failed: ['Payment failed', 'bad'], suspended: ['Payments stopped', 'bad'], cancelled: ['Cancelled', ''], void: ['Cancelled', ''] };
  const orderPill = (o) => { const [l, c] = ORDER_ST[o.status] || [o.status, '']; return `<span class="pill ${c}">${esc(l)}</span>`; };
  const people = (n) => `${n} ${Number(n) === 1 ? 'person' : 'people'}`;
  const orderWhat = (o) => `${(o.module_names || o.modules || []).join(', ')} · ${people(o.people)} · ${o.billing}`;
  // "22 Feb – 22 Mar 2027"
  const dayRange = (a, b) => { if (!a || !b) return ''; const A = new Date(a + 'T00:00:00'); const Bd = new Date(b + 'T00:00:00');
    return `${A.toLocaleDateString(undefined, A.getFullYear() === Bd.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })} – ${day(b)}`; };
  const perWord = (o) => (o.billing === 'yearly' ? 'a year' : 'a month');
  // "US$52 (early bird) · then US$104 a month"
  const orderAmount = (o) => (o.first_amount != null && Number(o.first_amount) < Number(o.amount)
    ? `<span class="nowrap">${money(o.first_amount)} (early bird)</span><small>then ${money(o.amount)} ${perWord(o)}</small>` : `${money(o.total)}<small>${perWord(o)}</small>`);
  // An invoice or receipt number: it opens the customer's copy (when the database has kept one).
  const docRef = (ref, doc, extra) => { if (!ref) return '<span class="code">—</span>'; if (!doc) return `<span class="code">${esc(ref)}</span>`;
    S.docs = S.docs || {}; S.docs[ref] = { doc, ...extra }; return `<button class="lnk doc" data-doc="${esc(ref)}" title="Open the customer's copy">${esc(ref)}</button>`; };
  const ordersTable = (list, id, biz, mark) => `<table class="tbl" id="${id}"><tr>${biz ? '<th>Business</th>' : ''}<th>Invoice</th><th>What</th><th>Amount</th><th>How</th><th>State</th>${mark ? '<th></th>' : ''}</tr>
    ${list.map((o) => `<tr>${biz ? `<td><button class="lnk" data-goco="${esc(o.workspace_id)}" data-cptab="money"><b>${esc(o.business || '')}</b></button></td>` : ''}<td class="nowrap">${docRef(o.ref, o.doc, { ws: o.workspace_id, paid: o.status === 'paid', paidAt: o.paid_at })}<small>${day(o.created_at)}</small></td>
      <td>${esc(orderWhat(o))}</td><td>${orderAmount(o)}</td>
      <td>${o.method === 'paypal' ? `PayPal${o.paypal_id ? `<small class="code">${esc(o.paypal_id)}</small>` : ''}` : 'Bank transfer'}</td>
      <td>${orderPill(o)}<small>${o.status === 'pending' && o.due_date ? `due ${day(o.due_date)}` : o.status === 'payment_failed' && o.grace_until ? `works until ${day(o.grace_until)}` : o.paid_through ? `paid to ${day(o.paid_through)}` : ''}${o.paid_reference ? ` · ref ${esc(o.paid_reference)}` : ''}${o.marked_paid_by ? ` · by ${esc(o.marked_paid_by)}` : ''}</small></td>
      ${mark ? `<td>${o.method === 'bank' && o.status === 'pending' ? `<button class="btn sm p" data-markpaid="${esc(o.ref)}" data-amount="${esc(o.total)}">Mark bank transfer paid</button>` : ''}</td>` : ''}</tr>`).join('')}</table>`;
  // What a payment was for: "Accounting Basics, Payroll · 3 people · monthly · 22 Feb – 22 Mar 2027"
  const payFor = (p) => [(p.module_names || []).join(', '), p.people ? people(p.people) : '', p.billing || '', dayRange(p.period_from, p.period_to)].filter(Boolean).join(' · ');
  const paysTable = (list, id, biz) => `<table class="tbl" id="${id}"><tr><th>When</th>${biz ? '<th>Business</th>' : ''}<th>Receipt</th><th>For</th><th>Amount</th><th>How</th><th>State</th></tr>
    ${list.map((p) => `<tr><td class="nowrap">${day(p.at)}</td>${biz ? `<td><button class="lnk" data-goco="${esc(p.workspace_id)}" data-cptab="money">${esc(p.business || '')}</button></td>` : ''}<td class="nowrap">${docRef(p.ref, p.doc, { ws: p.workspace_id })}<small class="code">${esc(p.order_ref || '')}</small></td>
      <td class="forc">${esc(payFor(p))}</td>
      <td>${p.amount != null ? money(p.amount) : ''}</td><td>${p.method === 'paypal' ? 'PayPal' : 'Bank transfer'}${p.provider_ref ? `<small class="code">${esc(p.provider_ref)}</small>` : ''}</td>
      <td>${p.status === 'completed' ? '<span class="pill ok">Paid</span>' : `<span class="pill bad">Failed</span>${p.note ? `<small>${esc(p.note)}</small>` : ''}`}</td></tr>`).join('')}</table>`;
  // The customer's copy of an invoice or receipt, exactly as they see it, with Print / Save as PDF and Resend.
  function docView(ref) {
    const x = (S.docs || {})[ref]; if (!x) return; const d = x.doc; const R = window.RiyeserBillDoc;
    dlg(`<div class="printdoc" id="printdoc">${R ? R.html(d, { paid: x.paid, paidAt: x.paidAt }) : '<p>Couldn\'t load the document view.</p>'}</div>
      <p class="muted small noprint" style="margin:10px 0 0">The customer's copy, kept exactly as issued on ${day(d.issued_at)}. The owner sees the same under Billing on their Riyeser home.</p>
      <div class="mfoot noprint docacts"><button type="button" class="btn" data-close>Close</button>${canEmailDocs() ? `<button type="button" class="btn" id="docResend">✉️ Resend to customer</button>
        <button type="button" class="btn" id="docOther">Send to a different email…</button>` : '<span class="muted small" id="docNoSend">Only Finance and the Owner (or someone the Owner allows) can email invoices and receipts.</span>'}<button type="button" class="btn p" id="docPrint">🖨 Print or save as PDF</button></div>`, (m) => {
      m.classList.add('printing'); m.querySelector('.mcard').classList.add('paper');
      m.querySelector('#docPrint').onclick = () => { const t = document.title; document.title = `${d.kind === 'receipt' ? 'Receipt' : 'Invoice'} ${d.ref}`; window.print(); document.title = t; };
      if (m.querySelector('#docResend')) m.querySelector('#docResend').onclick = () => resendDoc(ref, x.ws);
      if (m.querySelector('#docOther')) m.querySelector('#docOther').onclick = () => resendOther(ref, x.ws);
    });
  }
  const knownContacts = (ws) => { const c = S.cp; return c && (c.profile.id || S.cpId) === ws && c.extra && c.extra.billing && c.extra.billing.contacts ? c.extra.billing.contacts : null; };
  function resendDoc(ref, ws) {
    const to = knownContacts(ws);
    dlg(`<h3>✉️ Resend ${esc(ref)}</h3><p class="small">It goes to ${to && to.length ? to.map((a) => `<b>${esc(a)}</b>`).join(', ') : 'the business\'s billing emails (the owner and the business\'s email)'}, with a link to view and print it.</p>
      <p class="muted small">It's recorded in the HQ history: who sent it, where to, and when.</p><div id="rserr"></div>
      <div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn p" id="rsGo">Send it</button></div>`, (d, close) => {
      d.querySelector('#rsGo').onclick = async (e) => { e.target.disabled = true;
        try { const r = await api.resendDoc(ref, null, false); close(); flash(`${r.ref} sent to ${r.to.join(', ')}.`); }
        catch (err) { e.target.disabled = false; d.querySelector('#rserr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
    });
  }
  function resendOther(ref, ws) {
    const canFix = can('customers.edit', 'licences.manage');
    dlg(`<h3>Send ${esc(ref)} to a different email</h3><p class="muted small">For when the customer's email is wrong or they want a copy somewhere else.</p>
      <form id="rsf"><div id="rsStep1"><label class="f"><span>Email address</span><input type="email" name="to" required maxlength="120" placeholder="accounts@business.com" autocomplete="off"></label>
        ${canFix ? '<label class="opt"><input type="checkbox" name="fix"> Also make this the business\'s billing email (for future invoices and receipts)</label>' : ''}</div>
      <div id="rsStep2" hidden><div class="impact" id="rsCheck"></div></div><div id="rserr"></div>
      <div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn" id="rsBack" hidden>Change it</button><button class="btn p" id="rsGo">Next</button></div></form>`, (d, close) => {
      const f = d.querySelector('#rsf'); let sure = false;
      d.querySelector('#rsBack').onclick = () => { sure = false; d.querySelector('#rsStep1').hidden = false; d.querySelector('#rsStep2').hidden = true; d.querySelector('#rsBack').hidden = true; d.querySelector('#rsGo').textContent = 'Next'; };
      f.onsubmit = async (e) => { e.preventDefault(); const to = String(f.to.value).trim(); const fix = !!(f.fix && f.fix.checked);
        if (!sure) { sure = true; d.querySelector('#rsStep1').hidden = true; d.querySelector('#rsStep2').hidden = false; d.querySelector('#rsBack').hidden = false;
          d.querySelector('#rsCheck').innerHTML = `<div>Send <b>${esc(ref)}</b> to <b id="rsAddr">${esc(to)}</b>?</div>${fix ? '<div>This also becomes the business\'s billing email.</div>' : ''}<div class="muted small">Check the address carefully: it's recorded in the HQ history.</div>`;
          d.querySelector('#rsGo').textContent = 'Yes, send it'; return; }
        const btn = d.querySelector('#rsGo'); btn.disabled = true;
        try { const r = await api.resendDoc(ref, to, fix); close(); document.querySelectorAll('.modal.printing').forEach((x) => x.remove());
          if (r.contact_updated && S.cp && document.getElementById('cpBody')) await reloadCompany();
          flash(`${r.ref} sent to ${r.to.join(', ')}.${r.contact_updated ? ' The business\'s billing email is updated.' : ''}`); }
        catch (err) { btn.disabled = false; d.querySelector('#rserr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
    });
  }
  function markPaidDlg(ref, amount, after) {
    dlg(`<h3>Mark bank transfer paid</h3><p class="muted small">Only when the money is in Riyeser's bank account. This switches the programs on straight away, emails the owner a receipt, and goes in the HQ history.</p>
      <form id="mp"><label class="f"><span>Invoice</span><input name="ref" value="${esc(ref)}" readonly></label>
      <label class="f"><span>Amount received (US$)</span><input name="amount" type="number" step="0.01" min="0" value="${esc(amount)}" required></label>
      <label class="f"><span>The bank's reference <small class="muted">(from the bank statement)</small></span><input name="bankref" required minlength="3" maxlength="200"></label>
      <div id="mperr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Mark paid</button></div></form>`, (d, close) => {
      d.querySelector('#mp').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        try { const r = await api.markPaid(String(f.get('ref')), String(f.get('bankref')).trim(), Number(f.get('amount'))); close(); flash(`${ref} is paid: receipt ${r.receipt}, programs paid until ${day(r.paid_until)}.`); after(); }
        catch (err) { d.querySelector('#mperr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
  }
  function paypalCard(st, pp) {
    const s = st || {}; const deployed = s.deployed !== false;
    const [l, c, msg] = !deployed ? ['Not deployed', '', 'The paypal function isn\'t deployed yet: run Actions → Deploy PayPal payments.']
      : s.ready ? [s.env === 'live' ? 'Live' : 'Sandbox (test money)', s.env === 'live' ? 'ok' : 'warn', s.env === 'live' ? 'Customers can pay with PayPal.' : 'Test mode: payments use sandbox accounts, not real money.']
      : s.credentials ? ['Webhooks not verified yet', 'bad', 'The PayPal keys are in, but PAYPAL_WEBHOOK_ID isn\'t: webhook events are refused, so customers can\'t pay with PayPal yet. Add the webhook (RUNBOOK: Set up PayPal), then deploy again.']
      : ['Not set up yet', '', 'Customers only see bank transfer until PayPal is set up (RUNBOOK: Set up PayPal).'];
    return `<div class="card" id="ppcard"><h3>PayPal</h3><div class="hrow"><span class="hic" aria-hidden="true">🅿️</span><div><b>${esc(l)}</b><small>${esc(msg)}</small></div><span class="pill ${c}">${esc(s.env || '—')}</span></div>
      <p class="small" style="margin:10px 0 0">Last webhook: <b>${pp && pp.last_webhook_at ? `${esc(ago(pp.last_webhook_at))}` : 'none yet'}</b>${pp && pp.last_webhook_type ? ` <span class="muted">(${esc(pp.last_webhook_type)})</span>` : ''} · ${num(pp ? pp.events_7d : 0)} in 7 days · ${num(pp ? pp.subscriptions : 0)} PayPal subscription${pp && pp.subscriptions === 1 ? '' : 's'}</p></div>`;
  }
  function entityCard(b) {
    const e = b.entity || {}; const bk = e.bank || {}; const ed = b.can_edit_entity;
    const fld = (k, label, v, max = 120) => `<label class="f"><span>${label}</span><input name="${k}" value="${esc(v || '')}" maxlength="${max}"${ed ? '' : ' readonly'}></label>`;
    return `<div class="card" id="entity"><h3>Billing entity <small>· who sells Riyeser: on every invoice and receipt</small></h3>
      ${b.bank_ready ? '' : '<div class="err" id="addbank">Add your bank details. Until then, bank transfer invoices tell customers Riyeser will email the details.</div>'}
      <form id="entf" class="grid g2">${fld('name', 'Business name', e.name)}${fld('email', 'Contact email', e.email)}${fld('address', 'Address', e.address, 300)}
        ${fld('tax_label', 'Tax number label', e.tax_label || 'ABN', 40)}${fld('tax_number', 'ABN (or tax number)', e.tax_number, 40)}
        ${fld('bank.account_name', 'Bank account name', bk.account_name, 80)}${fld('bank.bank_name', 'Bank', bk.bank_name, 80)}${fld('bank.bsb', 'BSB', bk.bsb, 80)}
        ${fld('bank.account_number', 'Account number', bk.account_number, 80)}${fld('bank.swift', 'SWIFT / BIC (for overseas payers)', bk.swift, 80)}${fld('bank.note', 'Note for customers (optional)', bk.note, 300)}
        ${ed ? '<div><button class="btn p">Save billing entity</button></div>' : '<p class="muted small" id="entOwnerOnly">Only the Owner can change these.</p>'}</form>
      <p class="muted small">Each change is in the HQ history (who, when, before and after) and kept as a new version: invoices and receipts already made keep the details they were made with.</p></div>`;
  }
  async function payments() {
    main('<p class="muted">Loading…</p>');
    const [b, st] = await Promise.all([api.billing(), api.paypalStatus()]);
    const m = main(`<h2>Invoices &amp; payments</h2><p class="sub">PayPal subscriptions and bank transfers. All amounts in US dollars. PayPal ids show only their last 6 characters.</p>
      <div class="grid g2">${paypalCard(st, b.paypal)}<div class="card"><h3>At a glance</h3><div class="tiles mtiles">${tile('Failed payments', num(b.failed.length), `grace ${num(b.grace_days)} days`)}${tile('Unpaid invoices', num(b.unpaid.length), 'bank transfer')}${tile('Payments', num(b.payments.filter((p) => p.status === 'completed').length), 'latest 100')}</div></div></div>
      <div class="card scroll" id="failedCard"><h3>Failed payments <small>· PayPal couldn't take the money; the programs work until the date shown</small></h3>${b.failed.length ? ordersTable(b.failed, 'failedTbl', true, false) : '<p class="muted small">None. 🎉</p>'}</div>
      <div class="card scroll" id="unpaidCard"><h3>Unpaid invoices <small>· bank transfer; mark paid when the money is in the bank</small></h3>${b.unpaid.length ? ordersTable(b.unpaid, 'unpaidTbl', true, b.can_mark_paid) : '<p class="muted small">None.</p>'}</div>
      <div class="card scroll" id="paysCard"><h3>Payments</h3>${b.payments.length ? paysTable(b.payments, 'paysTbl', true) : '<p class="muted small">No payments yet.</p>'}</div>
      ${entityCard(b)}`);
    m.querySelectorAll('[data-markpaid]').forEach((x) => x.onclick = () => markPaidDlg(x.dataset.markpaid, x.dataset.amount, payments));
    m.querySelectorAll('[data-doc]').forEach((x) => x.onclick = () => docView(x.dataset.doc));
    const ef = m.querySelector('#entf'); if (ef && b.can_edit_entity) ef.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(ef); const d = { bank: {} };
      for (const [k, v] of f.entries()) { if (k.startsWith('bank.')) d.bank[k.slice(5)] = String(v); else d[k] = String(v); }
      try { await api.setBillingEntity(d); flash('Billing entity saved. New invoices use it.'); payments(); } catch (err) { flash(plain(err)); } };
    if (S.markPaid) { const ref = S.markPaid; S.markPaid = null; const o = b.unpaid.find((x) => x.ref === ref); if (o && b.can_mark_paid) markPaidDlg(o.ref, o.total, payments); }
  }
  // Admin → Test accounts: Riyeser's own test, demo and internal businesses, which the Overview leaves out unless
  // "Include test accounts" is ticked. Nothing is marked automatically: staff mark each one, with a reason (HQ history).
  const AKINDS = [['test', 'Test'], ['demo', 'Demo'], ['internal', 'Internal'], ['customer', 'Customer (real)']];
  async function testAccounts() {
    const pre = S.taPrefill || ''; S.taPrefill = null;
    const m = main(`<h2>Test accounts</h2><p class="sub">Riyeser's own test, demo and internal businesses. The Overview's figures, Needs attention and Queue at a glance leave them out unless you tick “Include test accounts”. Every change goes in the HQ history.</p>
      <div class="card" style="margin-bottom:16px"><h3>Mark a business</h3><form id="tak" class="takf"><label class="f"><span>Company ID or name</span><input name="q" required placeholder="e.g. RIY-7K3M-Q2" autocomplete="off" value="${esc(pre)}"></label>
        <label class="f"><span>It is</span><select name="kind">${AKINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="f grow"><span>Why</span><input name="reason" required minlength="3" maxlength="200" placeholder="e.g. Our own QA business"></label><button class="btn p">Save</button></form><div id="takmsg"></div></div>
      <div class="card" id="tal"><p class="muted">Loading…</p></div>`);
    const f0 = m.querySelector('#tak'); if (pre) { f0.kind.value = 'test'; f0.reason.focus(); }
    f0.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const msg = m.querySelector('#takmsg');
      const q = String(f.get('q') || '').trim(); const kind = String(f.get('kind')); const reason = String(f.get('reason') || '').trim();
      try { const list = await api.companies(q, 'all'); const rows = Array.isArray(list) ? list : (list && list.rows) || [];
        const hit = rows.find((c) => String(c.company_code || '').toLowerCase() === q.toLowerCase()) || rows.find((c) => String(c.name || '').toLowerCase() === q.toLowerCase()) || (rows.length === 1 ? rows[0] : null);
        if (!hit) { msg.innerHTML = `<p class="err">${rows.length ? 'More than one business matches: type its Company ID (for example RIY-7K3M-Q2).' : 'No business matches. Check the Company ID or name.'}</p>`; return; }
        await api.setAccountKind(hit.id, kind, reason); flash(`${hit.name} is now marked ${(AKINDS.find((x) => x[0] === kind) || [0, kind])[1].toLowerCase()}.`); testAccounts(); }
      catch (err) { msg.innerHTML = `<p class="err">${esc(plain(err))}</p>`; } };
    let list; try { list = await api.testAccounts(); } catch (err) { const el = m.querySelector('#tal'); if (el) el.innerHTML = missing(err) ? '<p class="muted small">Run the latest <b>team-chat.sql</b> in Supabase (SQL Editor) to switch on test accounts.</p>' : `<div class="err">${esc(plain(err))}</div>`; return; }
    const el = m.querySelector('#tal'); if (!el) return; list = list || [];
    el.innerHTML = `<h3>Marked accounts <small>· ${num(list.length)}</small></h3>${list.length ? `<table class="tbl"><thead><tr><th>Business</th><th>Company ID</th><th>Kind</th><th>Joined Riyeser</th><th class="r"></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><button class="lnk" data-goco="${esc(c.id)}"><b>${esc(c.name)}</b></button><small>${esc(c.country || '')}</small></td><td class="nowrap">${esc(c.company_code || '')}</td>
        <td><span class="pill">${esc((AKINDS.find((x) => x[0] === c.account_kind) || [0, c.account_kind])[1])}</span></td><td class="nowrap">${esc(day(c.created_at))}</td>
        <td class="r"><button class="btn sm" data-real="${esc(c.company_code || c.name)}">Mark as a real customer</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted small">No test accounts marked yet. Every business counts in the figures.</p>'}`;
    el.querySelectorAll('[data-real]').forEach((b) => b.onclick = () => { f0.q.value = b.dataset.real; f0.kind.value = 'customer'; f0.reason.value = ''; f0.reason.focus(); f0.scrollIntoView({ block: 'nearest' }); });
  }
  async function inbox() { main(soon('Team Inbox', 'Internal discussions linked to a customer, case or invoice, handovers that become tasks with an owner and due time, and commitments saved to the customer timeline. For now, use the Team handover on the Overview and internal notes on each customer page.', 'Coming soon')); }
  async function settings() { TT.tab = 'people'; TT.person = null; TT.role = null; await team(); const el = document.getElementById('settings'); if (el) el.scrollIntoView({ block: 'start' }); }
  // "Needs attention": only what this person can act on. Each item opens the right page.
  function attentionHtml(a, off) {
    if (!a) return '';
    if (a.missing) return '<div class="card attn"><h3>Queue at a glance</h3><p class="muted small">Run the latest <b>team-chat.sql</b> in Supabase (SQL Editor) to switch this on.</p></div>';
    const items = [[a.unassigned, 'Unassigned tickets', 'support:unassigned'], [a.overdue, 'Overdue tickets', 'support:overdue', 'bad'], [a.updates_overdue, 'Overdue updates to customers', 'support:overdue', 'bad'], [a.mine, 'My open tickets', 'support:mine'],
      [a.approvals, 'Approvals waiting', 'approvals'], [a.refunds_waiting, 'Refunds waiting', 'refunds'], [(a.trials_3d || []).length, 'Trials ending in 3 days', 'trials'],
      [(a.follow_ups || []).filter((f) => f.due).length, 'My follow-ups due', 'followups'], [a.emails_failed, 'Failed or held emails', 'emails', 'bad'],
      [Array.isArray(off) ? off.length : null, 'Link Offices offline', 'linkoff', 'bad']].filter((x) => x[0] != null);
    const fu = a.follow_ups || [];
    return `<div class="card attn" id="attn"><h3>Queue at a glance <small>· overdue and unassigned work, for ${esc(S.me.name)}</small></h3>
      <div class="alist" style="--cols:${[3, 4, 2].find((c) => items.length % c === 0) || 3}">${items.map(([n, l, g, bad]) => `<button class="aitem${n ? ` on${bad ? ' bad' : ''}` : ''}" data-go="${g}"><b>${num(n)}</b><span>${l}</span></button>`).join('')}</div>
      ${(a.trials_3d || []).length ? `<div class="alrow" id="attnTrials"><h4>Trials ending in 3 days</h4>${a.trials_3d.slice(0, 12).map((t) => `<button class="lnk" data-goco="${esc(t.id)}" data-cptab="programs">${esc(t.name)} <small>${t.days_left === 0 ? 'today' : `in ${t.days_left} day${t.days_left === 1 ? '' : 's'}`}</small></button>`).join('')}</div>` : ''}
      ${Array.isArray(off) && off.length ? `<div class="alrow"><h4>Link Offices offline</h4>${off.slice(0, 12).map((t) => `<button class="lnk" data-goco="${esc(t.id || t.workspace_id)}" data-cptab="link">${esc(t.name || t.business || 'A business')}</button>`).join('')}</div>` : ''}
      </div>
      <div class="card" id="myfu"><h3>My follow-ups <small>· ${fu.length ? `${fu.filter((f) => f.due).length} due` : 'none yet'}</small></h3>${followUpList(fu)}</div>`;
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
  const CCOLS = [['name', 'Business'], ['owner', 'Business owner'], ['phone', 'Phone'], ['plan', 'Plan'], ['trial', 'Trial ends'], ['last_active', 'Last active'], ['tickets', 'Tickets'], ['status', 'Status']];
  const SORT_DESC_FIRST = { plan: true, last_active: false, tickets: true, created: true };
  const PER_PAGE = 50;
  const planCell = (c) => (c.paid_n == null ? (c.calls_paid_until && new Date(c.calls_paid_until) > new Date() ? '<span class="pill ok">Riyeser Link paid</span>' : '<span class="pill">—</span>')
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
          <label class="opt"><input type="checkbox" name="follow_up"${f.follow_up ? ' checked' : ''}> Needs follow-up</label><label class="opt"><input type="checkbox" name="mine"${f.mine ? ' checked' : ''}> My customers</label>
          <label class="opt"><input type="checkbox" name="storage_80"${f.storage_80 ? ' checked' : ''}> Storage over 80%</label></div>
        <div class="row"><button type="button" class="btn sm" id="cclear">Clear filters</button><button type="button" class="btn sm" id="ccsv">⬇ Download CSV</button></div></form>
      <div id="cl" class="card scroll"><p class="muted">Loading…</p></div><div id="pager" class="pager"></div>`);
    const read = () => { const a = new FormData(m.querySelector('#sf')); const b = new FormData(m.querySelector('#cf'));
      const nf = { status: a.get('st') === 'all' ? '' : String(a.get('st')), plan: String(b.get('plan') || ''), trial_days: String(b.get('trial_days') || ''), country: String(b.get('country') || ''),
        inactive_days: String(b.get('inactive_days') || ''), open_tickets: !!b.get('open_tickets'), follow_up: !!b.get('follow_up'), mine: !!b.get('mine'), storage_80: !!b.get('storage_80') };
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
    m.querySelector('#cl').innerHTML = rows.length ? `<table class="tbl ctbl"><tr>${CCOLS.map(([k, l]) => `<th${k === 'tickets' ? ' class="n"' : ''}><button class="sortb${st.sort === k ? ' on' : ''}" data-sort="${k}">${l}${arrow(k)}</button></th>`).join('')}<th>Assigned to</th><th>Follow-up</th>${rows.some((c) => c.storage_pct != null) ? '<th class="n">Storage</th>' : ''}</tr>
      ${rows.map((c) => `<tr class="click" data-co="${esc(c.id)}"><td><b>${esc(c.name)}</b><small class="code">${esc(c.company_code || '')}</small></td>
        <td>${esc(c.owner_name || '')}<small>${esc(c.owner_email || '')}</small></td><td class="nowrap">${esc(c.phone || '')}</td><td>${planCell(c)}</td>
        <td>${c.trial_days != null ? `${daysPill(c.trial_days)}<small>${day(c.trial_end)}</small>` : c.trial_days_left != null && c.paid_n == null ? `${daysPill(c.trial_days_left)}` : '<span class="muted">—</span>'}</td>
        <td>${ago(c.last_active_at || c.last_seen)}</td><td class="n">${c.tickets_open != null ? (c.tickets_open ? `<span class="pill warn">${num(c.tickets_open)}</span>` : '0') : ''}</td>
        <td>${pill(BSTAT, c.status || 'active')}</td><td class="nowrap">${c.hq_owner_name ? (c.hq_owner_name === S.me.name ? '<b>You</b>' : esc(c.hq_owner_name)) : '<span class="muted">Unassigned</span>'}</td>
        <td class="nowrap">${c.next_follow_up ? `<span class="pill${c.next_follow_up <= today() ? ' warn' : ''}">${day(c.next_follow_up)}</span>` : '<span class="muted">—</span>'}</td>${rows.some((x) => x.storage_pct != null) ? `<td class="n">${c.storage_pct != null ? `<span class="pill${Number(c.storage_pct) >= 80 ? ' warn' : ''}">${Math.round(Number(c.storage_pct))}%</span>` : ''}</td>` : ''}</tr>`).join('')}</table>`
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
    csvFile('companies', ['Business', 'Company ID', 'Owner', 'Owner email', 'Phone', 'Country', 'Status', 'Kind', 'Paid programs', 'Trial ends', 'Trial days left', 'Last active', 'Open tickets', 'People', 'PCs', 'Joined', 'Assigned to', 'Next follow-up'],
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
  const HIST_ACTS = { 'account.kind': 'marked an account as test, demo, internal or customer', 'billing.bank_paid': 'marked a bank transfer paid', 'billing.doc_resent': 'sent an invoice or receipt again', 'billing.entity_changed': 'changed the billing entity (bank details)',
    'billing.entity_proposed': 'proposed a billing entity change (old two-person rule)', 'billing.entity_rejected': 'turned down a billing entity change (old two-person rule)',
    'billing.entity_replaced': 'replaced a waiting billing entity change (old two-person rule)', 'link.new_password': 'asked Link Office for a new phone password (nobody sees it)', 'customer.viewed': 'opened the company', 'company.viewed': 'opened the company', 'note.added': 'added a note', 'calls.paid_until': 'changed Riyeser Link paid-until',
    'licence.module': 'changed a licence', 'licence.plan': 'changed a plan', 'licence.storage': 'granted extra file storage', 'staff.added': 'added HQ staff', 'staff.changed': 'changed HQ staff', 'staff.permissions': 'changed HQ permissions',
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
    'customers.exported': 'downloaded the businesses list', 'customer.owner_set': 'changed who the customer is assigned to', 'handover.added': 'added a handover note', 'handover.done': 'ticked off a handover note' };
  const histExtra = (h) => { const d = h.details || {}; return [h.ticket || d.ticket, d.refund, d.offer, d.module ? modName(d.module) : null, d.status, d.reason, d.email, d.until, d.role, LEVELS[d.to] ? 'to ' + LEVELS[d.to] : null,
    h.action === 'billing.doc_resent' ? [d.ref, Array.isArray(d.to) ? 'to ' + d.to.join(', ') : '', d.contact_updated ? 'billing email updated' : ''].filter(Boolean).join(' ') : null].filter(Boolean).join(' · '); };

  // ------------------------------------------------------------------ the customer page (#/company/<id>/<tab>)
  const CPTABS = [['overview', 'Overview'], ['programs', 'Programs'], ['pcs', 'PCs & programs'], ['people', 'People'], ['conversations', 'Conversations'],
    ['money', 'Money'], ['history', 'History'], ['link', 'Link']];
  // Free programs (Riyeser Link is a paid program since pricing v2: it's the 'calls' row in the paid list)
  const FREE_PROGRAMS = [['central', 'Riyeser Central'], ['invoices', 'Invoices'], ['pdf', 'PDF'], ['desk', 'Documents']];
  // Riyeser Central's name for each program (desktop/src/central/updates.js)
  const MOD_APP = { basic: 'accounting-basics', plus: 'accounting', payroll: 'payroll', pos: 'pos', bookings: 'bookings', as_built: 'services', calls: 'team', estimate: 'estimate' };
  const APP_NAME = { central: 'Central', 'accounting-basics': 'Accounting Basics', accounting: 'Accounting Plus', payroll: 'Payroll', pos: 'POS', bookings: 'Bookings',
    services: 'As Built', team: 'Riyeser Link', linkoffice: 'Link Office', invoices: 'Invoices', pdf: 'PDF', desk: 'Documents', estimate: 'Estimate' };
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
      const trials = MODULES.map(([m]) => L.modules[m] || {}).filter((v) => v.status === 'trial' && !v.starts_on_first_use); const paid = MODULES.some(([m]) => (L.modules[m] || {}).status === 'active');
      const soon = trials.length ? Math.min(...trials.map((v) => v.days_left)) : null;
      if (soon != null && soon <= 14 && !paid) out.push([soon <= 3 ? 'bad' : 'warn', soon <= 0 ? 'Trial ends today' : `Trial ends in ${soon} day${soon === 1 ? '' : 's'}`]);
      else if (soon != null && soon <= 14) out.push(['warn', `A trial ends in ${soon} day${soon === 1 ? '' : 's'}`]);
      if (MODULES.some(([m]) => (L.modules[m] || {}).status === 'ended' && L.modules[m].paid_until)) out.push(['bad', 'Payment overdue']);
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
    const shown = MODULES.filter(([m]) => showMod(c, m));
    const by = (st) => shown.filter(([m]) => L.modules[m].status === st).map(([, n]) => n);
    const paid = by('active'); const trial = by('trial'); const soon = shown.map(([m]) => L.modules[m]).filter((v) => v.status === 'trial').map((v) => v.days_left);
    return `<div class="cpplan"><b>${paid.length ? `Paid: ${esc(paid.join(', '))}` : 'Nothing paid yet'}</b>${trial.length ? ` · Trial: ${trial.length === shown.length ? 'every program' : esc(trial.join(', '))} (${Math.min(...soon)} days left)` : ''}
      ${c.monthly != null ? ` · <span title="List price estimate until payments are connected">${money(c.monthly)} a month (estimate)</span>` : ''}${L.seats ? ` · ${L.seats.used} people (${L.seats.included} included in each program${L.seats.extra ? `, ${L.seats.extra} extra set` : ''})` : ''}</div>`;
  }
  function drawCompany() {
    const c = S.cp; const p = c.profile; const o = c.owner || {}; const id = p.id || S.cpId; const open = !p.status || p.status === 'active';
    const back = S.cpFrom && !/^#\/company\//.test(S.cpFrom) ? S.cpFrom : '#/companies';
    const backName = (TABS().find((x) => '#/' + x[0] === back) || [0, 'Companies'])[1];
    const L = c.licence; const ren = L ? MODULES.map(([mm]) => L.modules[mm] || {}).filter((v) => v.active).map((v) => (v.status === 'trial' ? v.trial_ends : v.paid_until)).filter(Boolean).sort()[0] : null;
    const nf = c.next_follow_up;
    const menu = [can('customers.edit', 'support.assign', 'licences.manage') && !c.old && '<button data-menu="owner">👤 Assign to someone at Riyeser</button>',
      can('support.reply') && !c.old && '<button data-menu="message">✉️ Send customer reply</button>', can('customers.notes') && !c.old && '<button data-menu="call">📞 Log a call</button>',
      can('customers.notes') && '<button data-menu="note">📝 Add internal note</button>', can('offers.grant') && c.licence && open && '<button data-fix="offer">🎁 Give a free period</button>',
      can('customers.edit') && c.extra && '<button data-fix="edit">✏️ Edit details</button>', can('people.change_owner') && c.extra && '<button data-fix="owner">👑 Change the business owner</button>',
      can('business.close') && c.extra && (open ? '<button data-fix="close">⛔ Close or suspend</button><button data-fix="dup">🔁 Close as duplicate</button>' : '<button data-fix="reopen">✅ Reopen</button>'),
      `<button data-copy="${esc(p.company_code || '')}">📋 Copy Company ID</button>`].filter(Boolean).join('');
    const m = main(`<div class="cpage" data-ws="${esc(id)}">
      <a class="cpback" id="cpBack" href="${esc(back)}">← ${esc(backName)}</a>
      <header class="cphead"><div class="cpid"><div class="cptitle"><h2>${esc(p.name)}</h2>${p.country ? `<span class="sep">${esc(p.country)}</span>` : ''}${pill(BSTAT, p.status || 'active')}</div>
        <div class="cpline"><span>Assigned to: <b id="cpOwner">${esc(p.hq_owner_name ? (p.hq_owner_name === S.me.name ? 'You' : p.hq_owner_name) : 'Unassigned')}</b></span><span>Next renewal: <b>${ren ? day(ren) : '—'}</b></span>
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
    dlg(`<h3>👤 Who looks after ${esc(c.profile.name)}</h3><p class="muted small">The person at Riyeser who looks after this customer. It shows on the customer page and under "My customers".</p>
      <form id="sof"><label class="f"><span>Assigned to</span><select name="staff"><option value="">Unassigned</option>${staff.map((x) => `<option value="${esc(x.user_id)}"${x.user_id === c.profile.hq_owner ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div id="soerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Save</button></div></form>`, (d, close) => {
      d.querySelector('#sof').onsubmit = async (e) => { e.preventDefault();
        try { await api.setOwner(c.profile.id || S.cpId, String(new FormData(e.target).get('staff') || '') || null); close(); await reloadCompany(); flash('Saved: who looks after this customer.'); }
        catch (err) { d.querySelector('#soerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
  }
  const MOD_ICON = { basic: '📗', plus: '📒', payroll: '🧾', pos: '🛒', bookings: '📅', as_built: '🏗️', calls: '💬', estimate: '📐' };
  function enabledModules(c) {
    const L = c.licence; if (!L) return '';
    return `<div class="card" id="modsCard"><h3>Enabled modules</h3><div class="mods">${MODULES.filter(([m]) => showMod(c, m)).map(([m, n]) => { const v = L.modules[m]; const on = !!v.active;
      return `<button class="mod${on ? ' on' : ''}" data-cpgo="programs"><span class="mic" aria-hidden="true">${MOD_ICON[m]}</span><span><b>${n}</b><small>${v.status === 'active' ? 'Paid' : v.status === 'trial' && v.starts_on_first_use ? 'Trial starts on first use' : v.status === 'trial' ? `Trial · ${v.days_left} days` : v.status === 'cancelled' && on ? 'Cancelled, still on' : 'Not active'}</small></span><span class="mck" aria-hidden="true">${on ? '✓' : '–'}</span></button>`; }).join('')}</div></div>`;
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

  // --- Programs: a summary of the plan, one tidy row per paid or trial program (Manage opens the actions), free programs folded
  const untilOf = (v) => (v.status === 'trial' || (v.status === 'ended' && !v.paid_until) ? v.trial_ends : v.paid_until);
  const pcsText = (n) => (n ? `${n} PC${n === 1 ? '' : 's'}` : 'Not installed');
  // A PC HQ counts: not replaced by a newer link of the same PC (Central's Fresh start), and seen in the last 60 days.
  // The database says so (active); for an older database, worked out the same way here.
  const pcActive = (d) => (d.active != null ? !!d.active : !d.retired_at && !!d.last_seen && daysSince(d.last_seen) <= 60);
  const pcHas = (app) => (d) => (d.programs || []).some((x) => x.id === app);
  // "today", "yesterday", "3 days ago" (calendar days)
  const seenWords = (t) => { if (!t) return 'never'; const a = new Date(t); const b = new Date(); a.setHours(0, 0, 0, 0); b.setHours(0, 0, 0, 0);
    const n = Math.round((b - a) / 864e5); return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${num(n)} days ago`; };
  const pcProgs = (d, app) => (d.programs ? `<div class="progs">${d.programs.filter((x) => x.id !== 'central').map((x) => `<span class="prog${x.id === app ? ' on' : ''}">${esc(APP_NAME[x.id] || x.id)}${x.version ? ` <small>${esc(x.version)}</small>` : ''}</span>`).join('') || '<span class="muted small">Only Central</span>'}</div>`
    : '<span class="muted small">Programs not reported yet</span>');
  // One PC in a list: its Windows name, who linked it, when it was last seen, and the programs (with versions) it reported.
  const pcLine = (d, app) => `<li><div class="pcl1"><b>${esc(d.name || 'A PC')}</b> <span class="muted">· linked by ${esc(d.person || 'someone who has left')} · seen ${seenWords(d.last_seen)}</span></div>${pcProgs(d, app)}</li>`;
  // The PCs that don't count any more, in one quiet line: "Older PCs (not seen since 6 Nov 2026): Head office PC (linked again since)".
  const olderLine = (old) => (old.length ? `<p class="muted small oldpcs">Older PCs (not seen since ${day(old.map((d) => d.last_seen).filter(Boolean).sort().pop())}): ${old.map((d) => `${esc(d.name || 'A PC')}${d.retired_at ? ' <span class="nowrap">(linked again since)</span>' : ''}`).join(', ')}</p>` : '');
  // As Built is hidden on the website: only show it when this business has it paid or installed.
  // A program the database doesn't send yet (team-chat.sql not run since it was added) isn't shown.
  const showMod = (c, m) => { const v = c.licence.modules[m]; if (!v) return false; if (m !== 'as_built') return true;
    return ['active', 'cancelled'].includes(v.status) || !!v.paid_until || (c.pcs || []).some((d) => (d.programs || []).some((x) => x.id === MOD_APP[m])); };
  // The plan in plain words, from the payments data (never made up): PayPal subscription, bank invoices, or the trial.
  function planWords(c) {
    const L = c.licence; const B = (c.extra && c.extra.billing) || {}; const orders = B.orders || []; const out = [];
    const sub = orders.find((o) => o.method === 'paypal' && ['active', 'payment_failed', 'suspended'].includes(o.status));
    const per = (o) => (o.billing === 'yearly' ? 'a year' : 'a month');
    if (sub) {
      if (sub.status === 'active') out.push(`Paying <b>${money(sub.next_amount != null ? sub.next_amount : sub.amount)} ${per(sub)}</b> by PayPal${sub.next_charge_at ? ` · next charge ${day(sub.next_charge_at)}` : ''}`);
      else if (sub.status === 'payment_failed') out.push(`<span class="pill bad">PayPal payment failed</span> works until ${day(sub.grace_until || sub.works_until || sub.paid_through)}`);
      else out.push('<span class="pill bad">PayPal stopped the subscription</span>');
    }
    const paidBank = orders.filter((o) => o.method === 'bank' && o.status === 'paid').sort((a, b) => String(b.paid_at || b.created_at).localeCompare(String(a.paid_at || a.created_at)))[0];
    if (paidBank && !sub) out.push(`Paid <b>${money(paidBank.total)}</b> by bank transfer${paidBank.paid_through ? ` · paid until ${day(paidBank.paid_through)}` : ''}`);
    orders.filter((o) => o.method === 'bank' && o.status === 'pending').forEach((o) => out.push(`Invoice ${esc(o.ref)} for <b>${money(o.total)}</b> waiting · due ${day(o.due_date)}`));
    const vals = MODULES.filter(([m]) => showMod(c, m)).map(([m]) => L.modules[m]);
    if (!out.length) {
      const paid = vals.filter((v) => v.status === 'active').map((v) => v.paid_until).filter(Boolean).sort();
      const trials = vals.filter((v) => v.status === 'trial').map((v) => v.trial_ends).filter(Boolean).sort();
      if (paid.length) out.push(`Paid until <b>${day(paid[0])}</b> <span class="muted">(marked paid in HQ; no online payment)</span>`);
      else if (trials.length) out.push(`On free trial · ends <b>${day(trials[0])}</b>`);
      else out.push('No paid programs and no trial running');
    }
    return out;
  }
  function tabPrograms(c) {
    const L = c.licence; if (!L) return '<div class="card"><p class="muted">Your HQ role can\'t see licences.</p></div>';
    const X = c.extra; const open = !c.profile.status || c.profile.status === 'active'; const lim = S.limitDays || 31;
    const all = c.pcs || []; const pcs = all.filter(pcActive); const older = all.filter((d) => !pcActive(d)); const reported = all.some((d) => d.programs_at);
    const installs = (app) => pcs.filter(pcHas(app)).length;
    // "2 PCs" opens the list of those PCs underneath (and any older PC that had it)
    const pcsCell = (app) => { if (!reported) return '<span class="muted">—</span>'; const n = installs(app); const any = n || older.some(pcHas(app));
      return any ? `<button class="lnk pcsbtn${n ? '' : ' muted'}" data-pcsfor="${esc(app)}" aria-expanded="false">${pcsText(n)} <span class="caret" aria-hidden="true">▾</span></button>` : `<span class="muted">${pcsText(n)}</span>`; };
    const pcsRow = (app, cols) => (reported && (installs(app) || older.some(pcHas(app))) ? `<tr class="pcsrow" data-pcsof="${esc(app)}" hidden><td colspan="${cols}">
        ${installs(app) ? `<ul class="pcl pclist">${pcs.filter(pcHas(app)).map((d) => pcLine(d, app)).join('')}</ul>` : ''}${olderLine(older.filter(pcHas(app)))}</td></tr>` : '');
    const grant = can('offers.grant') && !c.old; const manage = can('licences.manage');
    const rows = MODULES.filter(([m]) => showMod(c, m));
    const vals = rows.map(([m]) => L.modules[m]);
    const nPaid = vals.filter((v) => v.status === 'active').length; const nTrial = vals.filter((v) => v.status === 'trial').length;
    const nEnded = vals.filter((v) => ['ended', 'cancelled'].includes(v.status) && !v.active).length;
    const counts = [`${nPaid} paid`, `${nTrial} on trial`, nEnded ? `${nEnded} ended` : ''].filter(Boolean).join(' · ');
    const freePcs = reported ? pcs.filter((d) => (d.programs || []).some((x) => FREE_PROGRAMS.some(([a]) => a === x.id))).length : null;   // active PCs only
    return `<div class="card progsum" id="progSum"><div class="psmain"><h3>Plan</h3>${planWords(c).map((l) => `<p class="psline">${l}</p>`).join('')}
        <p class="pscount" id="progCounts">${counts}</p></div>
        <div class="psacts">${grant && open && nTrial ? '<button class="btn sm" id="addFree">🎁 Add free time…</button>' : ''}</div></div>
      <div class="card scroll" id="licCard"><h3>Paid and trial programs</h3>
      <table class="tbl lic progtbl"><tr><th>Program</th><th>Status</th><th>Until</th><th>Installed on</th>${open && manage ? '<th class="r"></th>' : ''}</tr>
      ${rows.map(([m, name]) => { const v = L.modules[m]; const [lbl, cl] = modState(v); const until = untilOf(v);
        return `<tr data-mod="${m}"><td><b>${name}</b></td><td><span class="pill${cl ? ' ' + cl : ''}">${lbl}</span>${v.status === 'cancelled' && v.active ? '<small>works until the end</small>' : ''}</td>
          <td class="nowrap">${until ? `Until ${day(until)}${v.active && v.days_left != null ? `<small>${v.days_left <= 0 ? 'ends today' : `${num(v.days_left)} day${v.days_left === 1 ? '' : 's'} left`}</small>` : ''}` : '<span class="muted">—</span>'}</td>
          <td>${pcsCell(MOD_APP[m])}</td>${open && manage ? `<td class="r"><button class="btn sm" data-manage="${m}">Manage</button></td>` : ''}</tr>${pcsRow(MOD_APP[m], open && manage ? 5 : 4)}`; }).join('')}</table>
      <details class="freeprogs" id="freeProgs"><summary><span class="muted">Free programs:</span> ${FREE_PROGRAMS.map(([, n]) => n).join(', ')}${freePcs != null ? ` · <span class="muted">installed on ${pcsText(freePcs).replace('Not installed', 'no PCs yet')}</span>` : ''}</summary>
        <table class="tbl"><tr><th>Program</th><th>Installed on</th></tr>${FREE_PROGRAMS.map(([app, name]) => `<tr class="free"><td>${name}</td><td>${pcsCell(app)}</td></tr>${pcsRow(app, 2)}`).join('')}</table></details>
      <p class="muted small progfoot">${!reported ? '"Installed on" fills in once their PCs run Riyeser Central 1.8.1 or later. ' : ''}Changes reach the business's PCs the next time Riyeser Central checks in (at start-up and daily).${grant ? ` Free time up to ${lim} days applies straight away; more goes to Approvals.` : ''}</p></div>
      <div class="card" style="margin-top:14px"><h3>Plan settings</h3><form id="plan" class="grid g3 planf">
        <label class="f"><span>Extra users <small class="muted">(${L.seats.used} people now; ${L.seats.included} included in each program, then US$${PRICE.extra_user} each per program)</small></span><input type="number" min="0" name="users" value="${L.seats.extra}"${manage ? '' : ' disabled'}></label>
        <label class="f"><span>Extra companies</span><input type="number" min="0" name="cos" value="${L.extra_companies}"${manage ? '' : ' disabled'}></label>
        <label class="f"><span>Billing</span><select name="billing"${manage ? '' : ' disabled'}><option value="monthly"${L.billing === 'monthly' ? ' selected' : ''}>Monthly</option><option value="yearly"${L.billing === 'yearly' ? ' selected' : ''}>Yearly (2 months free)</option></select></label>
        <label class="opt"><input type="checkbox" name="eb"${L.early_bird ? ' checked' : ''}${manage ? '' : ' disabled'}> Early bird: half price for the first 12 months</label>
        ${manage ? '<div><button class="btn p sm">Save plan</button></div>' : '<p class="muted small">Owners and Finance can change plans.</p>'}</form></div>
      ${storageCard(c.storage, manage)}
      ${X && X.offers && X.offers.length ? `<div class="card scroll" id="offCard" style="margin-top:14px"><h3>Free periods <small>· ${X.offers.length}</small></h3>${offersTable(X.offers)}</div>` : ''}`;
  }
  // Riyeser Link file storage: used out of the limit, and Grant extra storage (licences.manage, with a reason).
  function storageCard(st, manage) {
    if (!st) return '';
    const pct = Math.max(0, Math.min(100, Number(st.pct) || 0));
    return `<div class="card" id="storCard" style="margin-top:14px"><h3>File storage <small>· Riyeser Link chat files · ${st.plus ? '20 GB with Riyeser Link' : '20 GB, read-only while Riyeser Link is off'}${st.extra_gb ? ` + ${num(st.extra_gb)} GB extra` : ''}</small></h3>
      <div class="storrow"><b>${gbText(st.used)} of ${gbText(st.limit)} used</b><span class="pill${pct >= 80 ? ' warn' : ' ok'}">${Math.round(pct)}%</span></div>
      <div class="sbar${pct >= 80 ? ' warn' : ''}"><i style="width:${pct}%"></i></div>
      <p class="muted small">Over the limit, new uploads are refused with a plain message. Nothing is ever deleted automatically.</p>
      ${manage ? '<button class="btn sm" id="grantStor">Grant extra storage</button>' : '<p class="muted small">Owners and Finance can grant extra storage.</p>'}</div>`;
  }
  const offersTable = (list) => `<table class="tbl"><tr><th>Offer</th><th>What</th><th>Status</th><th>By</th></tr>
    ${list.map((o) => `<tr><td class="code">${esc(o.ref)}<small>${day(o.created_at)}</small></td><td>${o.days} days · ${esc(o.kind === 'account' ? 'all paid programs' : o.modules.map(modName).join(', '))}<small>${esc(OFFER_KIND[o.kind] || o.kind)} · ${esc((OFFER_WHY.find((w) => w[0] === o.reason_category) || [0, o.reason_category])[1])}: ${esc(o.reason)}</small></td>
      <td>${offerPill(o)}${o.ends_at ? `<small>to ${day(o.ends_at)}</small>` : ''}</td><td>${esc(o.requested_by_name || '')}${o.approved_by_name ? `<small>${o.status === 'declined' ? 'declined' : 'approved'} by ${esc(o.approved_by_name)}</small>` : ''}</td></tr>`).join('')}</table>`;
  // Manage one program: the actions in one small dialog. Each opens the confirm below (reason, ticket, HQ history).
  function manageProgram(mod) {
    const c = S.cp; const v = c.licence.modules[mod]; const name = modName(mod); const lim = S.limitDays || 31; const td = today();
    const grant = can('offers.grant') && !c.old; const manage = can('licences.manage'); const [lbl, cl] = modState(v); const until = untilOf(v);
    const base = (v.status === 'active' ? v.paid_until : v.trial_ends) || td; const from = base > td ? base : td;
    const canExtend = grant && (trialish(v) || v.status === 'active');
    const canUnlock = (grant && trialish(v) && !(v.status === 'trial' && v.days_left >= 30)) || (manage && !trialish(v) && v.status !== 'active');
    const row = (title, note, btns) => `<div class="mgrow"><div><b>${title}</b><small>${note}</small></div><div class="mgbtns">${btns}</div></div>`;
    dlg(`<h3>Manage ${esc(name)}</h3><p class="mgnow"><span class="pill${cl ? ' ' + cl : ''}">${lbl}</span> ${until ? `until <b>${day(until)}</b>` : ''}${v.active && v.days_left != null ? ` <span class="muted">· ${num(v.days_left)} days left</span>` : ''}</p>
      <div class="mglist" id="mgl">
      ${canExtend ? row('Add free time', `From ${day(from)}. Up to ${lim} days applies straight away; more goes to Approvals.`,
        [7, 30, 90].map((n) => `<button class="btn sm${n > lim ? ' over' : ''}" data-q="extend" data-days="${n}">+${n} days</button>`).join('')
        + `<span class="mgcustom"><span class="muted small">or until</span><input type="date" id="mgDate" min="${plusDays(from, 1)}" aria-label="Free time until"><button class="btn sm" id="mgDateGo">Add to date</button></span>`) : ''}
      ${canUnlock ? row('Unlock now', trialish(v) ? 'A 30-day free trial from today.' : 'Turns it back on, paid until a date you choose.', '<button class="btn sm p" data-q="unlock">Unlock now</button>') : ''}
      ${manage ? row('Mark paid until…', 'For when they\'ve paid another way. Unlocks at the next check-in.', '<button class="btn sm" data-q="paid_until">Mark paid until…</button>') : ''}
      ${manage && v.active ? row('Pause', 'Stops it now. Their books are never touched; unlock it again any time.', '<button class="btn sm" data-q="pause">Pause</button>') : ''}
      ${manage && (v.status === 'active' || v.status === 'trial') ? row('Cancel / end access', v.status === 'active' ? `Keeps working until ${day(v.paid_until)}, then stops.` : 'The free trial ends now.', '<button class="btn sm danger" data-q="cancel">Cancel…</button>') : ''}
      </div><div id="mgerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Close</button></div>`, (d, close) => {
      d.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => { close(); quickAction(mod, b.dataset.q, Number(b.dataset.days) || null); });
      const go = d.querySelector('#mgDateGo'); if (go) go.onclick = () => { const to = d.querySelector('#mgDate').value;
        const n = to ? Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 864e5) : 0;
        if (n < 1) { d.querySelector('#mgerr').innerHTML = `<div class="err">Choose a date after ${esc(day(from))}.</div>`; return; }
        close(); quickAction(mod, 'extend', n); };
    });
  }
  // Add free time to several trial programs at once (one free period, through the same 31-day rule and Approvals).
  function addFreeTime() {
    const c = S.cp; const L = c.licence; const lim = S.limitDays || 31; const td = today();
    const trials = MODULES.filter(([m]) => showMod(c, m) && L.modules[m].status === 'trial');
    dlg(`<h3>🎁 Add free time</h3><p class="muted small">Adds days to each chosen free trial. Up to <b>${lim} days</b> applies straight away; more waits for a supervisor in Approvals. The customer is emailed when it applies; they never see the reason.</p>
      <form id="aft"><div class="pick">${trials.map(([m, n]) => `<label class="opt"><input type="checkbox" name="m" value="${m}" checked> ${n} <small class="muted">${L.modules[m].trial_ends ? `until ${day(L.modules[m].trial_ends)}` : 'starts on first use'}</small></label>`).join('')}</div>
      <div class="chips daychips" role="radiogroup" aria-label="How long">${[7, 30, 90].map((n) => `<label class="chip"><input type="radio" name="days" value="${n}"${n === 30 ? ' checked' : ''}> +${n} days</label>`).join('')}
        <label class="chip"><input type="radio" name="days" value="custom"> Other <input type="number" name="custom" min="1" max="1000" value="14" aria-label="Number of days"> days</label></div>
      <div class="impact" id="aftImpact"></div>
      <div class="grid g2"><label class="f"><span>Reason</span><select name="why">${OFFER_WHY.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="f"><span>Ticket number <small class="muted">(optional)</small></span><input name="ticket" placeholder="T-10234" maxlength="20"></label></div>
      <label class="f"><span>Note <small class="muted">(required, staff only: it goes in the HQ history for good, so no personal details)</small></span><input name="reason" required minlength="4" maxlength="300"></label>
      <div id="afterr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p" id="aftGo">Add free time</button></div></form>`, (d, close) => {
      const f = d.querySelector('#aft');
      const days = () => { const x = f.querySelector('[name=days]:checked').value; return x === 'custom' ? Math.max(0, parseInt(f.custom.value, 10) || 0) : Number(x); };
      const sync = () => { const n = days(); const chosen = [...f.querySelectorAll('[name=m]:checked')].map((x) => x.value);
        d.querySelector('#aftImpact').innerHTML = chosen.length && n ? `${chosen.map((m) => { const te = L.modules[m].trial_ends; const b = te > td ? te : td; return `<div><b>${esc(modName(m))}</b> will run until <b>${day(plusDays(b, n))}</b></div>`; }).join('')}
          ${n > lim ? `<div class="warnline">${n} days is over the ${lim}-day limit, so it goes to Approvals first.</div>` : ''}` : '<div class="muted">Choose at least one program and a number of days.</div>';
        d.querySelector('#aftGo').textContent = n > lim ? 'Ask for approval' : 'Add free time'; };
      f.oninput = sync; f.onchange = sync; sync();
      f.onsubmit = async (e) => { e.preventDefault(); const fd = new FormData(f); const mods = fd.getAll('m').map(String); const n = days();
        if (!mods.length || !n) { d.querySelector('#afterr').innerHTML = '<div class="err">Choose at least one program and a number of days.</div>'; return; }
        try { const r = await api.grantOffer(c.profile.id || S.cpId, { kind: 'trial', modules: mods, amount: n, unit: 'days', why: String(fd.get('why')), reason: String(fd.get('reason')).trim(), ticket: String(fd.get('ticket') || '').trim() });
          close(); await reloadCompany(); badges();
          flash(r.status === 'applied' ? `${r.ref}: ${r.days} free days applied to ${mods.length} program${mods.length === 1 ? '' : 's'}.` : `${r.ref}: ${r.days} days is over the ${r.limit}-day limit, so it's waiting for a supervisor in Approvals.`);
        } catch (err) { d.querySelector('#afterr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
    });
  }
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
    // What the customer will see happen (the service impact), in one plain line.
    const impact = act === 'extend' ? `${name} will run until <b>${day(plusDays(from, days))}</b>${days > lim ? ' (once approved)' : ''}.`
      : act === 'unlock' ? (paidish ? `${name} switches on at the next check-in.` : `${name} will run until <b>${day(plusDays(td, 30))}</b>.`)
      : act === 'paid_until' ? `${name} will run until the date below.`
      : act === 'pause' ? `${name} will stop today (${day(td)}).`
      : v.status === 'active' ? `${name} will stop on <b>${day(v.paid_until)}</b>.` : `${name} will stop today (${day(td)}).`;
    const dateField = act === 'paid_until' || (act === 'unlock' && paidish) ? `<label class="f"><span>Paid until</span><input type="date" name="until" required min="${td}" value="${act === 'unlock' ? plusDays(td, 30) : v.paid_until && v.paid_until >= td ? plusDays(v.paid_until, 30) : plusDays(td, 30)}"></label>` : '';
    dlg(`<h3>${title}</h3><p class="muted small">${intro}</p><div class="impact" id="qaImpact">${impact}</div><form id="qa">${dateField}
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
    const pcs = (c.pcs || []).filter(pcActive); const older = (c.pcs || []).filter((d) => !pcActive(d));
    return `<div class="card scroll" id="pcsCard"><h3>Linked PCs <small>· ${pcs.length}</small></h3>${pcs.length ? `<table class="tbl" id="pcsTbl"><tr><th>PC</th><th>Person</th><th>Central</th><th>Last seen</th><th>Riyeser programs installed</th></tr>
      ${pcs.map((d) => `<tr><td><b>${esc(d.name || 'A PC')}</b><small>${esc(d.platform === 'win32' ? 'Windows' : d.platform || '')}${d.linked_at ? ` · linked ${day(d.linked_at)}` : ''}</small></td><td>${esc(d.person || '')}</td>
        <td class="nowrap">${esc(d.version || '?')}</td><td>${ago(d.last_seen)}</td>
        <td>${d.programs ? `<div class="progs">${d.programs.filter((x) => x.id !== 'central').map((x) => `<span class="prog">${esc(APP_NAME[x.id] || x.id)}${x.version ? ` <small>${esc(x.version)}</small>` : ''}</span>`).join('') || '<span class="muted small">Only Central</span>'}</div>${d.programs_at ? `<small>as of ${ago(d.programs_at)}</small>` : ''}`
          : '<span class="muted small">Not reported yet (Riyeser Central 1.8.1 sends this)</span>'}</td></tr>`).join('')}</table>` : `<p class="muted small">${older.length ? 'No PCs seen in the last 60 days.' : 'No PCs linked yet.'}</p>`}
      ${older.length ? `<div id="olderPcs">${olderLine(older)}</div>` : ''}</div>
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
  function billingCards(X) {
    const B = X.billing; if (!B) return '';
    return `<div class="card scroll" id="coBilling" style="margin-top:14px"><h3>Invoices and subscriptions <small>· ${B.orders.length} · PayPal ids show only their last 6 characters</small></h3>${B.orders.length ? ordersTable(B.orders, 'coOrders', false, B.can_mark_paid) : '<p class="muted small">None yet: they haven\'t paid online.</p>'}</div>
      <div class="card scroll" id="coPays" style="margin-top:14px"><h3>Payments <small>· ${B.payments.length}</small></h3>${B.payments.length ? paysTable(B.payments, 'coPayTbl', false) : '<p class="muted small">None yet.</p>'}</div>`;
  }
  function tabMoney(c) {
    const X = c.extra; if (!X) return SWITCH_ON; const credit = creditText(X.credit);
    return `<div class="tiles mtiles">${tile('A month (estimate)', c.monthly != null ? money(c.monthly) : '—', 'at list prices')}${tile('Credit on account', credit || '0', 'from refunds paid as credit')}
        ${tile('Refunds', X.refunds ? num(X.refunds.length) : '—', X.refunds ? `${X.refunds.filter((f) => !['paid', 'declined'].includes(f.status)).length} open` : 'your role can\'t see refunds')}${tile('Free periods', num((X.offers || []).length), `${(X.offers || []).filter((o) => o.status === 'waiting').length} waiting for approval`)}</div>
      ${X.refunds ? `<div class="card scroll" id="coRefunds"><h3>Refunds <small>· ${X.refunds.length} · approve and pay them in Refunds</small></h3>${X.refunds.length ? `<table class="tbl">${X.refunds.map((f) => `<tr><td class="code">${esc(f.ref)}<small>${day(f.created_at)}</small></td><td>${cur(f.amount, f.currency)}<small>${esc(f.for_what)}</small></td><td>${refundPill(f)}</td><td>${f.amount_approved != null ? cur(f.amount_approved, f.currency) : ''}<small>${esc(f.paid_method ? (PAID_HOW.find((x) => x[0] === f.paid_method) || [0, f.paid_method])[1] : '')}</small></td></tr>`).join('')}</table>` : '<p class="muted small">None.</p>'}
        ${can('refunds.view') ? '<button class="btn sm" data-gotab="refunds" style="margin-top:8px">Open Refunds</button>' : ''}</div>` : ''}
      ${billingCards(X)}
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
    el.querySelectorAll('[data-markpaid]').forEach((b) => b.onclick = () => markPaidDlg(b.dataset.markpaid, b.dataset.amount, reloadCompany));
    el.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => quickAction(b.dataset.mod, b.dataset.q, Number(b.dataset.days) || null));
    el.querySelectorAll('[data-manage]').forEach((b) => b.onclick = () => manageProgram(b.dataset.manage));
    el.querySelectorAll('[data-pcsfor]').forEach((b) => b.onclick = () => {
      const row = b.closest('table').querySelector(`tr.pcsrow[data-pcsof="${b.dataset.pcsfor}"]`); if (!row) return;
      row.hidden = !row.hidden; b.setAttribute('aria-expanded', String(!row.hidden)); });
    el.querySelectorAll('[data-doc]').forEach((b) => b.onclick = () => docView(b.dataset.doc));
    el.querySelectorAll('[data-tk]').forEach((r) => r.onclick = () => { S.ticket = r.dataset.tk; go('#/support'); });
    el.querySelectorAll('[data-pin]').forEach((b) => b.onclick = async () => { try { await api.notePin(Number(b.dataset.pin), !!b.dataset.on); await reloadCompany(); } catch (err) { alert(plain(err)); } });
    el.querySelectorAll('[data-fudone]').forEach((b) => b.onclick = async (e) => { e.stopPropagation(); try { await api.followUpDone(Number(b.dataset.fudone)); flash('Follow-up ticked off.'); await reloadCompany(); } catch (err) { alert(plain(err)); } });
    el.querySelectorAll('[data-msgto]').forEach((b) => b.onclick = () => messageCustomer(b.dataset.msgto));
    const on = (sel, fn) => { const x = el.querySelector(sel); if (x) x.onclick = fn; };
    on('#cvMsg', () => messageCustomer()); on('#cvCall', logCall); on('#cvNote', () => addNote()); on('#addFree', addFreeTime);
    const nf = el.querySelector('#nf'); if (nf) nf.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(nf);
      try { await api.noteAdd(id, { kind: 'note', body: String(f.get('body')).trim(), pinned: !!f.get('pin'), follow_up: String(f.get('fu') || '') || null }); await reloadCompany(); } catch (err) { alert(plain(err)); } };
    on('#grantStor', () => dlg(`<h3>Grant extra storage</h3><p class="muted small">The total extra GB on top of the 20 GB that comes with Riyeser Link. It's in the HQ history.</p>
      <form id="gsf"><label class="f"><span>Extra storage (GB)</span><input name="gb" type="number" min="0" max="10000" step="1" required value="${(S.cp.storage && S.cp.storage.extra_gb) || 5}"></label>
      <label class="f"><span>Why</span><input name="why" required minlength="3" maxlength="300" placeholder="e.g. Lots of site drawings"></label><div id="gserr"></div>
      <div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Grant</button></div></form>`, (d, close) => {
      d.querySelector('#gsf').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        try { await api.grantStorage(id, Number(f.get('gb')), String(f.get('why')).trim()); close(); await reloadCompany(); flash('Extra storage granted.'); }
        catch (err) { d.querySelector('#gserr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; }));
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
  // 🔁 Close as duplicate. It closes THIS account (the one open on screen) and never asks which account to close.
  // Nothing is moved or deleted, and ✅ Reopen undoes it. Linking it to the account being kept is optional: likely
  // matches are offered (same owner email, phone, tax number, similar name), others only by searching; none is
  // picked for you. Its Company ID must be typed, and every warning (payments, paid programs, recent use, a kept
  // account with another owner or nothing paid) must be ticked. The database checks all of it again.
  async function dupForm(id, done) {
    let r; try { r = await api.dupCheck(id); } catch (e) {
      if (!missing(e)) { flash(plain(e)); return; }
      dlg(`<h3>🔁 Close as duplicate</h3><p class="muted small">This needs the latest <b>team-chat.sql</b>. Run it in Supabase (SQL Editor), then try again. Until then, use ⛔ Close or suspend.</p>
        <div class="mfoot"><button type="button" class="btn" data-close>Close</button></div>`, () => {}); return; }
    const a = r.this; const known = {}; let keep = null;
    const progs = (x) => { const pp = [...new Set(x.paid_programs || [])]; return pp.length ? pp.map(modName).join(', ') : x.trial_programs ? 'Free trial' : 'Nothing paid'; };
    const facts = (x) => `<dl class="dupkv"><dt>Company ID</dt><dd><span class="code">${esc(x.company_code || '')}</span></dd>
      <dt>Owner</dt><dd>${x.owner_name ? `${esc(x.owner_name)}${x.owner_email ? ` <small>${esc(x.owner_email)}</small>` : ''}` : '<span class="muted">No owner</span>'}</dd>
      <dt>Signed up</dt><dd>${day(x.created_at)}</dd><dt>Plan</dt><dd>${esc(progs(x))}</dd>
      <dt>Paid invoices</dt><dd>${num(x.paid_invoices)}${Number(x.paid_invoices) ? ` · ${money(x.paid_total)}` : ''}</dd>
      <dt>People · PCs</dt><dd>${num(x.members)} · ${num(x.pcs)}</dd><dt>Last activity</dt><dd>${x.last_activity ? ago(x.last_activity) : 'never'}</dd></dl>`;
    const row = (x, why) => { known[x.id] = x; const bad = x.problem;
      return `<label class="dupm${bad ? ' off' : ''}"><input type="radio" name="keep" value="${esc(x.id)}"${bad ? ' disabled' : ''}>
        <span class="dupmb"><b>${esc(x.name)}</b> <span class="code">${esc(x.company_code || '')}</span>${x.status !== 'active' ? ` ${pill(BSTAT, x.status)}` : ''}
          <small>${esc(x.owner_name || 'No owner')}${x.owner_email ? ` · ${esc(x.owner_email)}` : ''} · signed up ${day(x.created_at)} · ${esc(progs(x))}${Number(x.paid_invoices) ? ` · ${num(x.paid_invoices)} paid invoice${Number(x.paid_invoices) === 1 ? '' : 's'}` : ''}</small>
          ${why && why.length ? `<span class="why">${why.map((w) => `<i>${esc(w)}</i>`).join('')}</span>` : ''}${bad ? `<small class="no">${esc(bad)}</small>` : ''}</span></label>`; };
    const m = r.matches || [];
    dlg(`<h3>🔁 Close this account as a duplicate</h3>
      <p class="muted small">This closes <b>this account only</b>. Nothing is deleted or moved: its people, programs, invoices and history stay, and <b>✅ Reopen</b> undoes it. The owner is emailed.</p>
      <form id="dupf" autocomplete="off">
      <section class="dupthis" aria-label="The account being closed"><div class="duptag">Closing</div><h4>${esc(a.name)}</h4>${facts(a)}</section>
      <fieldset class="dupkeep"><legend>Link to the account we're keeping <small>(optional)</small></legend>
        <label class="dupm none"><input type="radio" name="keep" value="" checked><span class="dupmb"><b>Don't link it</b><small>Just close this account.</small></span></label>
        ${m.length ? `<p class="duph">Possible matches</p><div id="dupMatches">${m.map((x) => row(x, x.why)).join('')}</div>` : '<p class="muted small" id="dupMatches">No likely matches (same owner email, phone, tax number or a similar name).</p>'}
        <details class="dupfind" id="dupFind"><summary>Not listed? Search</summary>
          <div class="search"><input type="search" id="dupQ" placeholder="Name, Company ID or email" aria-label="Search for the account to keep" enterkeyhint="search"><button type="button" class="btn sm" id="dupGo">Search</button></div>
          <div id="dupRes"></div></details>
      </fieldset>
      <div id="dupRisks" aria-live="polite"></div>
      <label class="f"><span>Reason <small class="muted">(required: it goes in the HQ history for good, so no personal details)</small></span><input name="reason" required minlength="4" maxlength="300"></label>
      <label class="f"><span>Ticket number <small class="muted">(optional)</small></span><input name="ticket" placeholder="T-10234" maxlength="20"></label>
      <label class="f"><span>To confirm, type this account's Company ID: <span class="code">${esc(a.company_code || '')}</span></span><input name="code" id="dupCode" required autocapitalize="characters" spellcheck="false" placeholder="${esc(a.company_code || '')}"></label>
      <div id="fxerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p bad" id="dupGoBtn" disabled>Close ${esc(a.company_code || 'this account')}</button></div></form>`, (d, close) => {
      const f = d.querySelector('#dupf'); const btn = d.querySelector('#dupGoBtn'); let risks = [];
      const sync = () => { const ok = String(f.code.value).trim().toUpperCase() === String(a.company_code || '').toUpperCase();
        const acc = f.accept; btn.disabled = !ok || (risks.length > 0 && !(acc && acc.checked)); };
      const showRisks = () => { const was = f.accept && f.accept.checked; risks = dupRisks(a, keep);
        d.querySelector('#dupRisks').innerHTML = (keep ? `<p class="dupsel">Keeping <b>${esc(keep.name)}</b> <span class="code">${esc(keep.company_code || '')}</span></p>` : '')
          + (risks.length ? `<div class="dupwarn"><b>⚠️ Check before closing</b><ul>${risks.map((x) => `<li${['backwards', 'owner'].includes(x.code) ? ' class="hi"' : ''}>${esc(x.text)}</li>`).join('')}</ul>
            <label class="opt"><input type="checkbox" name="accept"${was ? ' checked' : ''}> I've checked these, and this is the account to close</label></div>` : '');
        if (f.accept) f.accept.onchange = sync; sync(); };
      f.addEventListener('change', (e) => { if (e.target.name === 'keep') { keep = e.target.value ? known[e.target.value] : null; showRisks(); } });
      f.code.oninput = sync;
      const find = async () => { const q = String(d.querySelector('#dupQ').value).trim(); const out = d.querySelector('#dupRes');
        if (q.length < 2) { out.innerHTML = '<p class="muted small">Type at least 2 characters.</p>'; return; }
        try { const rs = await api.dupSearch(id, q); out.innerHTML = rs.length ? rs.map((x) => row(x, null)).join('') : '<p class="muted small">Nothing found.</p>';
          if (keep && !rs.some((x) => x.id === keep.id) && !m.some((x) => x.id === keep.id)) { keep = null; f.querySelector('input[name=keep][value=""]').checked = true; showRisks(); }
        } catch (err) { out.innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
      d.querySelector('#dupGo').onclick = find; d.querySelector('#dupQ').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } };
      showRisks();
      f.onsubmit = async (e) => { e.preventDefault(); const fd = new FormData(f);
        try { await api.closeDuplicate(id, keep ? keep.id : null, String(fd.get('reason')).trim(), String(fd.get('ticket') || '').trim(), String(fd.get('code')).trim(), !!fd.get('accept'));
          close(); await done(); flash(`${a.name} is closed${keep ? ` and linked to ${keep.name}` : ''}. Reopen undoes it.`);
        } catch (err) { d.querySelector('#fxerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
    });
  }
  // The fix-up tools (edit details, owner, close, duplicate, reopen, free period, two-step reset, make owner).
  function wireFixes(root) {
    const c = S.cp; const p = c.profile; const id = p.id || S.cpId; const L = c.licence; const reopen = () => reloadCompany();
    const inp = (name, label, val = '', extra = '') => `<label class="f"><span>${label}</span><input name="${name}" value="${esc(val || '')}" ${extra}></label>`;
    // Change owner: someone already in THIS business. Nobody is picked for you (unless you pressed Make owner on
    // their row), and the form shows who the owner is now and who it will be before anything changes.
    const ownerForm = (person) => { const cur = c.people.find((x) => x.role === 'owner'); const ppl = c.people.filter((x) => x.role !== 'owner');
      const who = (x) => (x ? `<b>${esc(x.name)}</b>${x.email ? ` <small class="muted">${esc(x.email)}</small>` : ''}` : '<span class="muted">nobody yet</span>');
      fixForm('👑 Change owner', 'The new owner gets every admin power. The old owner becomes an admin. Only people already in this business can be chosen.',
        `<label class="f"><span>New owner</span><select name="person" id="ownSel" required><option value=""${person ? '' : ' selected'} disabled>Choose the new owner…</option>${ppl.map((x) => `<option value="${esc(x.user_id)}"${x.user_id === person ? ' selected' : ''}>${esc(x.name)} (${esc(x.email || '')})</option>`).join('')}</select></label>
        <div class="ownchg" id="ownChg"><div><small class="lbl">Owner now</small>${who(cur)}</div><span aria-hidden="true">→</span><div><small class="lbl">New owner</small><span id="ownNew">${who(ppl.find((x) => x.user_id === person))}</span></div></div>`,
        async (f, reason, ticket) => { if (!f.get('person')) throw new Error('Choose the new owner.'); await api.changeOwner(id, String(f.get('person')), reason, ticket); await reopen(); flash('Owner changed.'); }, 'Make them the owner');
      const sel = document.querySelector('#ownSel'); if (sel) sel.onchange = () => { document.querySelector('#ownNew').innerHTML = who(ppl.find((x) => x.user_id === sel.value)); }; };
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
      reopen: () => fixForm('✅ Reopen', `Its people can use it again straight away. The owner is emailed.${p.duplicate_of ? ` The link to <b>${esc(p.duplicate_of_name || 'the other business')}</b> (closed as a duplicate) is removed.` : ''}`, '',
        async (f, reason, ticket) => { await api.setBusinessStatus(id, 'active', reason, ticket); await reopen(); }, 'Reopen'),
      dup: () => dupForm(id, reopen),
      offer: async () => { const lim = S.limitDays || 31;
        dlg(`<h3>🎁 Give a free period</h3><p class="muted small">Up to <b>${lim} days</b> applies straight away. Longer waits for a supervisor (someone else with offers.approve). The customer is emailed when it applies; they never see the reason.</p>
          <form id="of"><label class="f"><span>What</span><select name="kind">${Object.entries(OFFER_KIND).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
          <div class="pick" id="ofmods">${MODULES.filter(([m]) => !L || L.modules[m]).map(([m, n]) => `<label class="opt"><input type="checkbox" name="m" value="${m}"> ${n} <small class="muted">${L ? esc(L.modules[m].status) : ''}</small></label>`).join('')}</div>
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

  // ------------------------------------------------------------------ support: the Support workspace
  // Laid out like an email program: folders on the left (with live counts), the folder's tickets in the middle, and
  // the open ticket on the right, with its details in a panel that folds away. On phones: a folder drop-down, the list,
  // then the ticket (← back to the list).
  const FOLDERS = [['open', 'Open'], ['mine', 'My tickets'], ['unassigned', 'Unassigned'], ['waiting_customer', 'Waiting on customer'], ['waiting_us', 'Waiting on Riyeser'],
    ['overdue', 'Overdue update'], ['resolved', 'Resolved'], ['all', 'All']];
  // Folders the database doesn't have by name: which box to ask for, and which of its tickets to keep.
  const FOLDER_Q = { waiting_us: ['open', (t) => t.status !== 'waiting_customer'], resolved: ['all', (t) => t.status === 'done'] };
  const folderCount = (k, c) => (k === 'waiting_us' ? (c.open != null && c.waiting_customer != null ? c.open - c.waiting_customer : null)
    : k === 'resolved' ? (c.all != null && c.open != null ? c.all - c.open : null) : c[k]);
  const folderName = (k) => (FOLDERS.find((f) => f[0] === k) || [0, 'Tickets'])[1];
  const SF0 = { product: '', owner: '', level: '', topic: '' };
  const FILTERS = () => [['product', 'Product', [['', 'All products'], ...PRODUCTS.map(([k, l]) => [k, l])]],
    ['owner', 'Assigned to', [['', 'Anyone'], ['me', 'Me'], ['none', 'Unassigned'], ...(S.supStaff || []).map((x) => [x.user_id, x.name])]],
    ['level', 'Level', [['', 'Any level'], ['1', 'Level 1 · Support'], ['2', 'Level 2 · Senior'], ['3', 'Level 3 · Management']]],
    ['topic', 'Topic', [['', 'Any topic'], ...Object.entries(TOPICS)]]];
  const keep = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window: not remembered */ } } };
  const phoneWidth = () => window.matchMedia('(max-width: 900px)').matches;
  const timer = (t, od) => { if (t.first_reply_at || t.status === 'done') return '';
    const hh = hours(t.created_at); return `<span class="tmr${hh > od ? ' late' : ''}">No reply yet · ${dur(hh)}</span>`; };
  const actBadge = (w) => (w === 'riyeser' ? '<span class="act r">Riyeser to act</span>' : w === 'customer' ? '<span class="act c">Customer to act</span>' : '');
  const S_DRAFTS = {};   // each ticket's drafts: { reply, note } (kept while HQ is open)
  const localInput = (t) => { if (!t) return ''; const d = new Date(t); const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
  async function support() {
    S.box = S.box || keep.get('hq.supFolder') || 'open'; if (!FOLDERS.some((f) => f[0] === S.box)) S.box = 'open';
    S.tq = S.tq || ''; S.sf = { ...SF0, ...(S.sf || {}) }; delete S.sf.status;
    if (S.detOpen == null) S.detOpen = keep.get('hq.supDetails') !== '0';
    if (!can('support.view')) return diagnosticsOnly();
    const m = main(`<div class="sws" id="sws">
      <nav class="card sw-rail" aria-label="Ticket folders"><h2>Support inbox</h2><div id="boxes" class="folders"></div></nav>
      <section class="card sw-in" id="swList">
        <label class="foldsel"><span>Folder</span><select id="folderSel"></select></label>
        <div class="swhead"><h3 id="folderName">${esc(folderName(S.box))}</h3>${can('support.diagnostics') ? '<button class="btn sm" id="dglook" title="Look up a diagnostic reference">🔎 DG-…</button>' : ''}</div>
        <form class="search" id="tsf" role="search"><input name="q" type="search" value="${esc(S.tq)}" placeholder="Search tickets, businesses, DG-…" aria-label="Search tickets"><button class="btn sm">Search</button></form>
        <div class="fbar"><div class="fdd"><button type="button" class="btn sm" id="filtBtn" aria-expanded="false" aria-controls="fpop">Filters</button>
          <div class="fpop" id="fpop" hidden><form class="sfil" id="sfil"></form><div class="fpfoot"><button type="button" class="lnk" id="fclear2">Clear all</button><button type="button" class="btn sm p" id="fdone">Done</button></div></div></div>
          <div class="fchips" id="fchips"></div></div>
        <div id="tl" class="tlist" data-vscroll><p class="muted">Loading…</p></div></section>
      <section class="sw-conv" id="tv"></section></div>`);
    m.classList.add('wide');
    m.querySelector('#tsf').onsubmit = (e) => { e.preventDefault(); S.tq = String(new FormData(e.target).get('q')); loadInbox(true); };
    const pop = m.querySelector('#fpop'); const fb = m.querySelector('#filtBtn');
    const popShow = (on) => { pop.hidden = !on; fb.setAttribute('aria-expanded', String(on)); };
    fb.onclick = () => popShow(pop.hidden); m.querySelector('#fdone').onclick = () => popShow(false);
    m.querySelector('#fclear2').onclick = () => { S.sf = { ...SF0 }; popShow(false); loadInbox(true); };
    m.querySelector('#sws').addEventListener('click', (e) => { if (!pop.hidden && !e.target.closest('.fdd')) popShow(false); });
    m.querySelector('#sfil').onchange = (e) => { S.sf[e.target.name] = e.target.value; loadInbox(true); };
    const dl = m.querySelector('#dglook'); if (dl) dl.onclick = () => lookupDiag();
    await loadInbox(!S.ticket);
    if (S.ticket) await openTicket(S.ticket);
  }
  function openFolder(k) { S.box = k; keep.set('hq.supFolder', k); S.ticket = null; loadInbox(true); }
  // Developers (and anyone with support.diagnostics but not tickets): just the diagnostic lookup.
  async function diagnosticsOnly() {
    const m = main(`<h2>Support</h2><p class="sub">Look up a diagnostic report by its reference (it looks like DG-4821). Technical details only: never the customer's records.</p>
      <div class="card" style="max-width:640px"><form class="search" id="dgf"><input name="ref" placeholder="DG-4821" aria-label="Diagnostic reference"><button class="btn p">Look up</button></form><div id="dgout"></div></div>`);
    m.classList.remove('wide');
    m.querySelector('#dgf').onsubmit = async (e) => { e.preventDefault(); const out = m.querySelector('#dgout');
      try { const r = await api.diagnostic(String(new FormData(e.target).get('ref')).trim()); out.innerHTML = diagCard(r.diagnostic, null, r.business); }
      catch (err) { out.innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
  }
  function lookupDiag() {
    dlg(`<h3>🔎 Look up a diagnostic report</h3><p class="muted small">The reference is on the customer's screen after they use Report an issue (it looks like DG-4821).</p>
      <form id="dgf"><label class="f"><span>Reference</span><input name="ref" required maxlength="20" placeholder="DG-4821"></label><div id="dgout"></div>
      <div class="mfoot"><button type="button" class="btn" data-close>Close</button><button class="btn p">Look up</button></div></form>`, (d) => {
      d.querySelector('#dgf').onsubmit = async (e) => { e.preventDefault(); const out = d.querySelector('#dgout');
        try { const r = await api.diagnostic(String(new FormData(e.target).get('ref')).trim());
          out.innerHTML = `${diagCard(r.diagnostic, null, r.business)}${(r.tickets || []).length ? `<p class="small">Tickets: ${r.tickets.map((x) => `<button type="button" class="lnk" data-dgt="${esc(x.id)}">${esc(x.ref)}</button> ${esc(x.subject)}`).join(' · ')}</p>` : ''}`;
          out.querySelectorAll('[data-dgt]').forEach((b) => b.onclick = () => { d.remove(); S.ticket = b.dataset.dgt; S.box = 'all'; S.sf = { ...SF0 }; go('#/support'); });
        } catch (err) { out.innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
  }
  // The Filters popover (Product, Owner, Level, Topic) and the active ones as chips you can remove.
  function drawFilters() {
    const f = document.getElementById('sfil'); const ch = document.getElementById('fchips'); if (!f || !ch) return;
    f.innerHTML = FILTERS().map(([name, label, opts]) => `<label class="sfl"><span>${label}</span><select name="${name}" aria-label="${label}">${opts.map(([k, l]) => `<option value="${esc(k)}"${String(S.sf[name] || '') === String(k) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`).join('');
    const on = FILTERS().filter(([name]) => S.sf[name]).map(([name, label, opts]) => [name, label, (opts.find(([k]) => String(k) === String(S.sf[name])) || [0, S.sf[name]])[1]]);
    document.getElementById('filtBtn').textContent = on.length ? `Filters (${on.length})` : 'Filters';
    ch.innerHTML = on.map(([name, label, v]) => `<button type="button" class="fchip" data-unf="${name}" title="Remove this filter">${esc(label)}: ${esc(v)} <span aria-hidden="true">✕</span></button>`).join('')
      + (on.length ? '<button type="button" class="lnk" id="fclear">Clear</button>' : '');
    ch.querySelectorAll('[data-unf]').forEach((b) => b.onclick = () => { S.sf[b.dataset.unf] = ''; loadInbox(true); });
    const cl = ch.querySelector('#fclear'); if (cl) cl.onclick = () => { S.sf = { ...SF0 }; loadInbox(true); };
  }
  async function loadInbox(autoOpen) {
    const fq = FOLDER_Q[S.box] || [S.box, null];
    const r = await api.supportInbox(fq[0], S.tq, { ...S.sf, status: '' }); const od = Number(r.overdue_hours || 24);
    const bx = document.getElementById('boxes'); if (!bx) return;
    if (r.staff) S.supStaff = r.staff;
    const c = r.counts || {};
    bx.innerHTML = FOLDERS.map(([k, l]) => { const n = folderCount(k, c);
      return `<button class="fold${S.box === k ? ' on' : ''}${k === 'overdue' && n ? ' late' : ''}" data-box="${k}"${S.box === k ? ' aria-current="true"' : ''}><span>${l}</span>${n != null ? `<b>${num(n)}</b>` : ''}</button>`; }).join('')
      + '<button class="fold soon" disabled title="Coming in a later release"><span>Known issues</span><small>soon</small></button>'
      + (r.old ? '<p class="muted small">Run the latest <b>team-chat.sql</b> to switch on products, promised updates and the product filter.</p>' : '');
    bx.querySelectorAll('[data-box]').forEach((b) => b.onclick = () => openFolder(b.dataset.box));
    const fs = document.getElementById('folderSel');
    fs.innerHTML = FOLDERS.map(([k, l]) => { const n = folderCount(k, c); return `<option value="${k}"${S.box === k ? ' selected' : ''}>${l}${n != null ? ` (${num(n)})` : ''}</option>`; }).join('');
    fs.onchange = () => openFolder(fs.value);
    document.getElementById('folderName').textContent = folderName(S.box);
    drawFilters();
    const list = (r.tickets || []).filter(fq[1] || (() => true)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const tl = document.getElementById('tl');
    tl.innerHTML = list.length ? list.map((t) => `<button class="tk${S.ticket === t.id ? ' on' : ''}${t.update_overdue ? ' late' : ''}" data-t="${esc(t.id)}">
        <span class="tkic" aria-hidden="true">${prodIcon(t.product)}</span><span class="tkb">
        <span class="tkt"><b>${esc(t.subject)}</b><time datetime="${esc(t.updated_at)}">${ago(t.updated_at)}</time></span>
        <small>${esc(t.business || t.opened_by_email || 'No business')} · <span class="code">${esc(t.ref)}</span>${t.product ? ` · ${esc(prodName(t.product))}` : ''}</small>
        <span class="tk1">${pill(TSTAT, t.status)}${actBadge(t.who_acts)}${t.work_blocked && t.status !== 'done' ? ' <span class="pill bad">Work blocked</span>' : ''}${t.level > 1 ? ` <span class="pill">L${t.level}</span>` : ''}${t.overdue ? ' <span class="pill bad">Overdue</span>' : ''}
          <span class="tkown">${t.assignee_name ? `Assigned to: ${t.assignee_name === S.me.name ? 'You' : esc(t.assignee_name)}` : 'Unassigned · Support team'}</span></span>
        ${t.next_update_due && t.status !== 'done' ? `<span class="tnu${t.update_overdue ? ' late' : ''}">${t.update_overdue ? '● Update overdue' : 'Update due'} ${esc(dueText(t.next_update_due))}${t.next_update_owner_name ? ` · ${esc(t.next_update_owner_name)}` : ''}</span>` : ''}
        ${timer(t, od)}</span></button>`).join('')
      : `<p class="muted small tlnone">Nothing in ${esc(folderName(S.box))}${S.tq || Object.values(S.sf).some(Boolean) ? ' with this search or these filters' : ''}.</p>`;
    tl.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => openTicket(b.dataset.t));
    // the right-hand side: the first ticket when a folder opens (not on a phone, where the list comes first), or a friendly empty state
    const tv = document.getElementById('tv');
    if (!list.length && (autoOpen || !S.ticket)) { S.ticket = null; document.getElementById('sws').classList.remove('open'); tv.innerHTML = emptyFolder(); return; }
    if (autoOpen && list.length && !phoneWidth()) await openTicket(list[0].id);
    else if (!S.ticket) tv.innerHTML = '<div class="card swempty"><div><p class="emo" aria-hidden="true">📨</p><h3>Choose a ticket</h3><p class="muted small">Pick one from the list to read it and reply.</p></div></div>';
  }
  const emptyFolder = () => { const k = S.box; const filtered = S.tq || Object.values(S.sf).some(Boolean);
    const msg = filtered ? 'Nothing matches your search or filters here. Try clearing them.'
      : ({ mine: 'Nothing is assigned to you right now.', unassigned: 'Every open ticket has an owner.', waiting_customer: 'No tickets are waiting for a customer to reply.',
        waiting_us: 'Nothing is waiting on Riyeser. All caught up.', overdue: 'No promised updates are overdue. Nice work.', resolved: 'No resolved tickets yet.' })[k] || 'No tickets here.';
    return `<div class="card swempty" id="swEmpty"><div><p class="emo" aria-hidden="true">${filtered ? '🔍' : '🎉'}</p><h3>${esc(folderName(k))}: all clear</h3><p class="muted">${msg}</p></div></div>`; };
  // ---------- Trial history (a ticket's report: the PC's free-trial record, Riyeser online's record, the business's licence) ----------
  const TRIAL_PROGS = { suite: 'Riyeser programs (shared trial)', estimate: 'Riyeser Estimate' };
  const TRIAL_SRC = [['licence_json', 'licence.json'], ['marker', 'Hidden marker'], ['registry', 'Windows registry'], ['company_file', 'Company file'], ['online', 'Riyeser online']];
  const sameDay = (a, b) => a && b && Math.abs(Date.parse(a) - Date.parse(b)) < 864e5;
  const dayShort = (t) => (t ? new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '');
  const dayAu = (t) => (t ? new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
  /** A plain-English verdict for one program, e.g. "Consistent: trial started 3 Sep on this PC; reinstalled twice; dates agree." */
  function trialVerdict(p, rep, online) {
    const got = TRIAL_SRC.map(([k]) => p.sources && p.sources[k]).filter(Boolean);
    const agree = got.every((d) => sameDay(d, p.start));
    const bits = [`trial started ${dayShort(p.start)} on this PC`];
    if (rep.installs != null) bits.push(rep.installs <= 1 ? 'installed once' : `reinstalled ${times(rep.installs - 1)}`);
    const off = online && online.trial_start && !sameDay(online.trial_start, p.start);
    bits.push(agree ? (got.length > 1 ? 'dates agree' : 'only one place has a date') : 'some places hold a different date (the earliest counts)');
    if (rep.clock_back) bits.push(`the PC clock was seen going backwards${rep.clock_back_at ? ` on ${dayShort(rep.clock_back_at)}` : ''} (no days were gained)`);
    if (off) bits.push(Date.parse(online.trial_start) < Date.parse(p.start) ? `Riyeser online has an earlier start (${dayShort(online.trial_start)}): the PC uses it next time it's online`
      : `Riyeser online has ${dayShort(online.trial_start)} (the PC's earlier date replaces it next time it's online)`);
    if (!online) bits.push('not seen online yet');
    if ((online && online.extra_days) || p.extra_days) bits.push(`+${(online && online.extra_days) || p.extra_days} goodwill days`);
    return `${agree && !rep.clock_back && !off ? 'Consistent' : 'Check'}: ${bits.join('; ')}.`;
  }
  function trialHistory(x, B) {
    const rep = x.report || {}; const progs = rep.programs || [];
    const onl = (prog) => (x.online || []).find((o) => o.program === prog) || null;
    const rows = progs.map((p) => { const o = onl(p.program); const ends = o && o.extra_days ? new Date(Date.parse(p.start) + (90 + o.extra_days) * 864e5).toISOString() : p.ends;
      const left = Math.max(0, Math.ceil((Date.parse(ends) - Date.now()) / 864e5));
      return `<div class="trow" data-trial="${esc(p.program)}"><h4>${esc(TRIAL_PROGS[p.program] || p.program)}</h4>
        <p class="tverdict ${/^Consistent/.test(trialVerdict(p, rep, o)) ? 'ok' : 'warn'}">${esc(trialVerdict(p, rep, o))}</p>
        <dl class="kv dkv"><dt>Trial started</dt><dd><b>${esc(dayAu(p.start))}</b></dd>
        <dt>${Date.parse(ends) < Date.now() ? 'Ended' : 'Ends'}</dt><dd><b>${esc(dayAu(ends))}</b></dd>
        <dt>Days left</dt><dd><b>${num(left)}</b>${o && o.extra_days ? ` <span class="pill violet">+${num(o.extra_days)} goodwill</span>` : ''} <small class="muted">(${num(p.days_left)} when reported)</small></dd>
        <dt>First seen online</dt><dd>${o ? esc(dayAu(o.first_seen)) : '<span class="muted">Not seen online yet</span>'}</dd>
        <dt>Last seen</dt><dd>${o ? `${esc(dayAu(o.last_seen))} <span class="muted">(${ago(o.last_seen)})</span>` : '—'}</dd></dl>
        <table class="tsrc"><thead><tr><th>Where</th><th>Date</th></tr></thead><tbody>${TRIAL_SRC.map(([k, label]) => { const v = p.sources && p.sources[k];
          return `<tr><td>${label}</td><td>${v ? `${esc(dayAu(v))}${sameDay(v, p.start) ? '' : ' <span class="pill warn">differs</span>'}` : '<span class="muted">—</span>'}</td></tr>`; }).join('')}</tbody></table></div>`; }).join('');
    const biz = x.business ? Object.entries(x.business).filter(([, v]) => v && (v.status === 'trial' || v.trial_ends)).map(([m, v]) =>
      `<li>${esc(modName(m))}: ${v.status === 'trial' ? `trial until <b>${esc(dayAu(v.trial_ends))}</b> (${num(v.days_left)} days left)` : `trial ended ${esc(dayAu(v.trial_ends))}`}</li>`).join('') : '';
    return `<p class="small muted">From the customer's report ${esc(x.diag_ref)} (${ago(x.reported_at)}). PC code <span class="code">${esc(String(rep.pc_id || 'none').slice(0, 8))}…</span>: a one-way code, it can't identify a person. Read-only.</p>
      ${rows || '<p class="muted small">No trial on that PC.</p>'}
      <p class="small">${rep.latest_seen ? `Latest time seen on the PC: ${esc(new Date(rep.latest_seen).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }))}. ` : ''}Clock seen going backwards: <b>${rep.clock_back ? `yes${rep.clock_back_at ? `, ${esc(dayAu(rep.clock_back_at))}` : ''}` : 'no'}</b>. Installs of Riyeser Central: <b>${rep.installs != null ? num(rep.installs) : 'not known'}</b>.</p>
      ${x.business ? `<h4>Signed-in business (the server's licence decides)</h4>${biz ? `<ul class="small tbiz">${biz}</ul>` : '<p class="muted small">No programs on a trial.</p>'}
        <p class="small muted">${B ? 'To extend the business\'s own programs, use the customer page → Programs → Extend.' : ''}</p>` : ''}
      ${x.can_extend && progs.length ? `<form id="trx" class="trx"><b>Goodwill extension for this PC</b>
        <div class="row"><select name="program" aria-label="Program">${progs.map((p) => `<option value="${esc(p.program)}">${esc(TRIAL_PROGS[p.program] || p.program)}</option>`).join('')}</select>
        <select name="days" aria-label="Days">${[7, 14, 30].map((n) => `<option value="${n}"${n === 14 ? ' selected' : ''}>+${n} days</option>`).join('')}</select></div>
        <label class="f"><span>Reason</span><input name="reason" maxlength="500" required placeholder="e.g. Goodwill: the trial ended while they were away"></label>
        <div class="trxerr"></div><button class="btn sm">Extend</button></form>` : ''}`;
  }
  function wireTrial(body, x, id, reload) {
    const f = body.querySelector('#trx'); if (!f) return;
    f.onsubmit = async (e) => { e.preventDefault(); const v = new FormData(f);
      try { const r = await api.trialExtend(id, String(v.get('program')), Number(v.get('days')), String(v.get('reason') || '').trim());
        flash(`Extended: the trial on that PC now ends ${dayAu(r.trial_ends)} (when it's next online).`); await reload(); }
      catch (err) { f.querySelector('.trxerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
  }
  // The Product diagnostics card (also used by the lookup).
  function diagCard(d, product, business) {
    if (!d) return '';
    const progs = (d.programs || []).map((p) => `${esc(APP_NAMES[p.id] || p.id)} ${esc(p.version || '?')}`).join(' · ');
    return `<div class="dgcard"><dl class="kv dkv"><dt>Product</dt><dd><b>${esc(prodName(d.product || product))}</b></dd><dt>Version</dt><dd><b>${esc(d.product_version || 'Not known')}</b></dd>
      <dt>Error</dt><dd><b>${esc(d.error_text || 'None given')}</b></dd><dt>Reference</dt><dd><b class="code">${esc(d.ref)}</b> ${copyBtn(d.ref)}</dd>
      ${business ? `<dt>Business</dt><dd><button type="button" class="lnk" data-goco="${esc(business.id)}">${esc(business.name)}</button></dd>` : ''}
      <dt>Windows</dt><dd>${esc(d.os || 'Not known')}</dd><dt>Central</dt><dd>${esc(d.central_version || '—')}</dd><dt>Reported</dt><dd>${esc(whenFull(d.reported_at || d.created_at))} <span class="muted">(${ago(d.reported_at || d.created_at)})</span></dd></dl>
      ${progs ? `<p class="small muted dprogs">On that PC: ${progs}</p>` : ''}
      ${d.log_lines ? `<details class="dlog"><summary>Log lines (${num(d.line_count || d.log_lines.split('\n').length)})${d.log_source ? ` · ${esc(d.log_source)}` : ''}</summary><pre>${esc(d.log_lines)}</pre></details>` : '<p class="small muted">No log lines in this report.</p>'}</div>`;
  }
  async function openTicket(id) {
    S.ticket = id; document.querySelectorAll('.tk').forEach((b) => b.classList.toggle('on', b.dataset.t === id));
    const tv = document.getElementById('tv'); if (!tv) return;
    const r = await api.ticket(id);
    const t = r.ticket; const B = r.business; const staff = r.staff || (await api.staff().catch(() => [])).filter((x) => x.active).map((x) => ({ user_id: x.user_id, name: x.display_name, can_work: (x.perms || permsOf(x)).includes(LEVEL_PERM[t.level]) }));
    const workers = (lvl) => staff.filter((x) => (lvl === t.level ? x.can_work : true));
    const myId = S.me.id || (staff.find((x) => x.name === S.me.name) || {}).user_id;
    const dr = S_DRAFTS[id] = S_DRAFTS[id] || { reply: '', note: '', tab: 'reply' };
    const body = (x) => `<div class="mb">${esc(x.body).replace(/\n/g, '<br>')}</div>`;
    const thread = r.messages.map((x) => (x.kind === 'call'
      ? `<div class="msg call"><small><b>📞 Call · ${x.call_direction === 'in' ? 'they called us' : 'we called them'}${x.call_with ? ` · ${esc(x.call_with)}` : ''}</b> · ${esc(x.from)} · ${ago(x.at)} <span class="aud">only staff see this</span></small>${body(x)}</div>`
      : x.internal ? `<div class="msg note"><small><b>Internal note: only staff see this</b> · ${esc(x.from)} · ${ago(x.at)}</small>${body(x)}</div>`
        : `<div class="msg${x.staff ? ' staff' : ' mcust'}"><small><span class="mav" aria-hidden="true">${esc(initials(x.from))}</span><b>${esc(x.from)}</b>${x.staff ? ' · to the customer' : ''} · ${ago(x.at)} <span class="muted">${esc(whenFull(x.at))}</span></small>${body(x)}</div>`)).join('');
    const ownerOpts = `<option value="">Unassigned</option>${workers(t.level).map((x) => `<option value="${esc(x.user_id)}"${x.user_id === t.assignee ? ' selected' : ''}${!can('support.assign') && x.user_id !== myId && x.user_id !== t.assignee ? ' disabled' : ''}>${esc(x.name)}</option>`).join('')}`;
    const prop = (label, html) => `<label class="tprop"><span>${label}</span>${html}</label>`;
    const more = [can('support.escalate') && '<button type="button" id="tesc">⬆ Escalate / ⬇ send back</button>',
      t.workspace_id && can('refunds.request', 'refunds.approve') && '<button type="button" id="trf">↩️ Refund request</button>',
      '<button type="button" data-more="bug">🐞 Link a bug</button>', r.can_work && '<button type="button" id="tcall">📞 Log a call</button>',
      t.status !== 'done' && '<button type="button" data-more="nu">🗓️ Set next update</button>'].filter(Boolean).join('');
    const drawerMode = () => window.matchMedia('(max-width: 1679px)').matches;
    tv.innerHTML = `<div class="tpane${S.detOpen ? '' : ' nodet'}" id="tpane"><div class="card tview">
      <div class="thead"><button class="btn sm sup-back" id="tback">← ${esc(folderName(S.box))}</button>
        <div class="ttl"><h2>${esc(t.subject)}</h2>
          <div class="tsub">${B ? `<button class="lnk" data-goco="${esc(B.id)}">${esc(B.name)}</button>` : `<span>${esc(t.opened_by_email || 'No business')}</span>`}<span>·</span><span class="code">${esc(t.ref)}</span><span>·</span><span>opened ${ago(t.created_at)}</span><span>·</span><span>${esc(TOPICS[t.topic] || t.topic)}</span>
            ${t.opened_by_name || t.opened_by_email ? `<span class="muted">· from ${esc(t.opened_by_name || '')} ${esc(t.opened_by_email || '')}</span>` : ''}</div></div>
        <div class="tacts">${actBadge(t.who_acts)}<button type="button" class="btn sm" id="detBtn" aria-controls="tdx">Details</button>
          <details class="dd tmore"><summary class="btn sm" id="tmore">⋯ More</summary><div class="ddm right">${more}</div></details></div></div>
      <div class="tprops" id="tprops">${prop('Status', `<select id="tst"${r.can_work ? '' : ' disabled'}>${TSTAT_ORDER.map((k) => `<option value="${k}"${k === t.status ? ' selected' : ''}>${TSTAT[k][0]}</option>`).join('')}</select>`)}
        ${prop('Assigned to', `<select id="tas"${can('support.assign') || r.can_work ? '' : ' disabled'}>${ownerOpts}</select>`)}
        ${prop('Priority', `<select id="tpr"${can('support.reply', 'support.assign') ? '' : ' disabled'}>${['low', 'normal', 'high', 'urgent'].map((k) => `<option value="${k}"${k === t.priority ? ' selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select>`)}
        ${prop('Product', `<select id="tprod"${r.can_work ? '' : ' disabled'}><option value="">Not set</option>${PRODUCTS.map(([k, l]) => `<option value="${k}"${k === t.product ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
        <span class="tflags">Level ${t.level} · ${LEVELS[t.level]}${t.work_blocked && t.status !== 'done' ? ' <span class="pill bad">Work blocked</span>' : ''}${t.overdue_at ? ' <span class="pill bad">Overdue</span>' : ''}${t.rating ? ` <span class="pill ok">Rated ${'★'.repeat(t.rating)}${'☆'.repeat(5 - t.rating)}</span>` : ''}</span></div>
      ${t.rating_comment ? `<p class="small rcomment">“${esc(t.rating_comment)}”</p>` : ''}
      <div class="conv" id="thread" data-vscroll>${thread}</div>
      ${r.can_work ? `<form id="rf" class="rbox${dr.tab === 'note' ? ' isnote' : ''}"><div class="ctabs" role="tablist">
          <button type="button" class="ctab${dr.tab === 'reply' ? ' on' : ''}" data-ctab="reply" role="tab" aria-selected="${dr.tab === 'reply'}">✉️ Reply to customer</button>
          <button type="button" class="ctab${dr.tab === 'note' ? ' on' : ''}" data-ctab="note" role="tab" aria-selected="${dr.tab === 'note'}">📝 Internal note</button>
          <p class="aud" id="aud"></p></div>
        <textarea name="reply" rows="2" maxlength="5000" placeholder="Type your reply to the customer…" aria-label="Reply to customer"${dr.tab === 'reply' ? '' : ' hidden'}>${esc(dr.reply)}</textarea>
        <textarea name="note" rows="2" maxlength="5000" placeholder="For Riyeser staff: what you found, what's next…" aria-label="Internal note"${dr.tab === 'note' ? '' : ' hidden'}>${esc(dr.note)}</textarea>
        <div class="row cfoot" id="cfoot"></div></form>`
        : `<div class="cantwork"><p class="muted small">This ticket is with <b>${LEVELS[t.level]}</b> (level ${t.level}). Only staff who work that level can reply or add notes${can('support.escalate') ? ', or you can escalate it (⋯ More)' : ''}.</p></div>`}
      </div><aside class="tdet" id="tdx" aria-label="Ticket details"></aside></div>`;
    const tdx = tv.querySelector('#tdx'); tdx.innerHTML = diagPanel(r);
    const pane = tv.querySelector('#tpane');
    const conv = tv.querySelector('#thread'); if (conv && conv.scrollHeight > conv.clientHeight) conv.scrollTop = conv.scrollHeight;
    const done = async () => { await loadInbox(); await openTicket(id); };
    const act = async (fn, ok) => { try { await fn(); if (ok) flash(ok); await done(); } catch (err) { flash(plain(err)); await done(); } };
    tv.querySelector('#tback').onclick = () => { S.ticket = null; tv.innerHTML = ''; document.querySelector('.sws').classList.remove('open'); document.querySelectorAll('.tk.on').forEach((b) => b.classList.remove('on')); };
    document.querySelector('.sws').classList.add('open');
    // Details: a column that folds away (remembered); on narrower screens a drawer
    const detBtn = tv.querySelector('#detBtn'); const detSync = () => detBtn.setAttribute('aria-expanded', String(drawerMode() ? pane.classList.contains('drawer') : !pane.classList.contains('nodet')));
    detBtn.onclick = () => { if (drawerMode()) pane.classList.toggle('drawer'); else { S.detOpen = !S.detOpen; keep.set('hq.supDetails', S.detOpen ? '1' : '0'); pane.classList.toggle('nodet', !S.detOpen); } detSync(); };
    detSync();
    const dc = tdx.querySelector('#detClose'); if (dc) dc.onclick = () => { pane.classList.remove('drawer'); detSync(); };
    // ⋯ More
    const menu = tv.querySelector('.tmore'); menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => menu.removeAttribute('open')));
    menu.querySelectorAll('[data-more]').forEach((b) => b.onclick = () => { const x = tdx.querySelector(b.dataset.more === 'bug' ? '#bugEdit' : '#nuEdit'); if (x) x.click(); });
    const tcall = tv.querySelector('#tcall'); if (tcall) tcall.onclick = () => logTicketCall(t, B, () => done());
    const rf = tv.querySelector('#rf');
    if (rf) {
      const saved = await api.savedReplies().catch(() => []);
      const ta = (k) => rf.querySelector(`textarea[name=${k}]`);
      const foot = () => { const note = dr.tab === 'note'; rf.classList.toggle('isnote', note);
        rf.querySelector('#aud').innerHTML = note ? '🔒 <b>Only Riyeser staff</b> see internal notes. The customer never does.' : '✉️ <b>The customer will see this and get an email.</b>';
        rf.querySelector('#cfoot').innerHTML = note ? '<span style="flex:1"></span><button class="btn p note" id="savenote">Save internal note</button>'
          : `${saved.length ? `<select id="ins" aria-label="Insert a saved reply"><option value="">Saved replies…</option>${saved.map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join('')}</select>` : ''}
            ${can('support.saved_replies') ? '<button type="button" class="btn sm" id="tsr" title="Add or change saved replies">Manage</button>' : ''}<span style="flex:1"></span>
            <label class="small" id="thenl">Then <select name="then"><option value="waiting_customer">wait for the customer</option><option value="investigating">keep investigating</option><option value="waiting_us">keep it in progress</option><option value="done">mark resolved</option></select></label>
            <button class="btn p" id="send">Send reply</button>`;
        const ins = rf.querySelector('#ins'); if (ins) ins.onchange = () => { const x = saved.find((y) => String(y.id) === ins.value); if (!x) return; const a = ta('reply');
          const at = a.selectionStart || a.value.length; a.value = a.value.slice(0, at) + x.body + a.value.slice(at); dr.reply = a.value; ins.value = ''; a.focus(); };
        const srb = rf.querySelector('#tsr'); if (srb) srb.onclick = () => manageSaved(() => openTicket(id)); };
      foot();
      rf.querySelectorAll('[data-ctab]').forEach((b) => b.onclick = () => { dr.tab = b.dataset.ctab;
        rf.querySelectorAll('[data-ctab]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
        ta('reply').hidden = dr.tab !== 'reply'; ta('note').hidden = dr.tab !== 'note'; foot(); ta(dr.tab).focus(); });
      ['reply', 'note'].forEach((k) => { ta(k).oninput = () => { dr[k] = ta(k).value; }; });
      rf.onsubmit = (e) => { e.preventDefault(); const note = dr.tab === 'note'; const text = ta(dr.tab).value.trim();
        if (!text) { flash(note ? 'Write the note first.' : 'Write your reply first.'); return; }
        const then = note ? null : String((rf.querySelector('[name=then]') || {}).value || 'waiting_customer');
        act(async () => { await api.ticketReply(id, text, note, then); dr[dr.tab] = ''; }, note ? 'Internal note saved. Only Riyeser staff see it.' : 'Reply sent. The customer gets an email.'); };
    }
    const onSel = (sel, fn) => { const x = tv.querySelector(sel); if (x) x.onchange = (e) => fn(e.target.value); };
    onSel('#tst', (v) => act(() => api.ticketStatus(id, v)));
    onSel('#tpr', (v) => act(() => api.ticketPriority(id, v)));
    onSel('#tas', (v) => act(() => api.ticketAssign(id, v || null), v ? `Assigned to ${(staff.find((x) => x.user_id === v) || {}).name || ''}.` : 'Unassigned now.'));
    onSel('#tprod', (v) => act(() => api.ticketSet(id, { product: v || null })));
    const esb = tv.querySelector('#tesc'); if (esb) esb.onclick = () => dlg(`<h3>Escalate or send back</h3><p class="muted small">Now: level ${t.level} (${LEVELS[t.level]}). The reason is an internal note; the customer only sees "We've passed this to our senior team".</p>
      <form id="ef"><label class="f"><span>Move to</span><select name="level">${[1, 2, 3].filter((l) => l !== t.level).map((l) => `<option value="${l}"${l === t.level + 1 ? ' selected' : ''}>Level ${l} · ${LEVELS[l]}</option>`).join('')}</select></label>
      <label class="f"><span>Assign to <small class="muted">(optional)</small></span><select name="assign"><option value="">Whoever picks it up</option></select></label>
      <label class="f"><span>Reason</span><input name="reason" required minlength="4" maxlength="500" placeholder="e.g. Needs a developer to check the printer driver"></label>
      <div id="eferr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Move it</button></div></form>`, (d, close) => {
      const lv = d.querySelector('[name=level]'); const as = d.querySelector('[name=assign]');
      const fill = async () => { const all = await api.staff().catch(() => []); as.innerHTML = '<option value="">Whoever picks it up</option>' + all.filter((x) => x.active && (x.perms || permsOf(x)).includes(LEVEL_PERM[Number(lv.value)])).map((x) => `<option value="${esc(x.user_id)}">${esc(x.display_name)}</option>`).join(''); };
      lv.onchange = fill; fill();
      d.querySelector('#ef').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        try { await api.ticketEscalate(id, Number(f.get('level')), String(f.get('reason')).trim(), String(f.get('assign') || '') || null); close(); await done(); }
        catch (err) { d.querySelector('#eferr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
    const rfb = tv.querySelector('#trf'); if (rfb) rfb.onclick = () => dlg(`<h3>↩️ Refund request for this customer</h3><p class="muted small">Entered on their behalf from ${esc(t.ref)}. It goes to the Refunds queue for approval; they're emailed that we've got it.</p>
      <form id="rq"><label class="f"><span>What it's for</span><input name="for_what" required maxlength="120" placeholder="e.g. Accounting Basics"></label>
      <div class="grid g2"><label class="f"><span>Period</span><input name="period" maxlength="80" placeholder="e.g. November 2026"></label><label class="f"><span>Invoice reference</span><input name="invoice_ref" maxlength="80"></label>
      <label class="f"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" required></label><label class="f"><span>Currency</span><select name="currency"><option selected>USD</option></select></label></div>
      <label class="f"><span>Reason</span><select name="reason_category">${Object.entries(RWHY).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="f"><span>What the customer said</span><textarea name="explanation" rows="3" maxlength="2000"></textarea></label>
      <div id="rqerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Enter request</button></div></form>`, (d, close) => {
      d.querySelector('#rq').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const v = (k) => String(f.get(k) || '').trim();
        try { const x = await api.refundCreate(id, { for_what: v('for_what'), period: v('period'), invoice_ref: v('invoice_ref'), amount: Number(v('amount')), currency: v('currency'), reason_category: v('reason_category'), explanation: v('explanation') });
          close(); flash(`Refund request ${x.ref} entered.`); await done(); } catch (err) { d.querySelector('#rqerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
    wireDiagPanel(tdx, r, staff, done);
  }
  // The Details panel: tidy sections (Customer, Next update & planned release, Diagnostics, Linked bug, Support notes),
  // each folded to a one-line summary when there's nothing in it.
  function diagPanel(r) {
    const t = r.ticket; const B = r.business; const d = r.diagnostic;
    const apps = PRODUCT_APPS[t.product] || [];
    const pcs = (r.pcs || []).map((p) => { const mine = (p.programs || []).filter((x) => apps.includes(x.id)); const other = (p.programs || []).filter((x) => !apps.includes(x.id));
      return `<li><b>${esc(p.name || 'A PC')}</b>${p.platform ? ` <span class="muted">${esc(p.platform === 'win32' ? 'Windows' : p.platform)}</span>` : ''}${p.version ? ` · Central ${esc(p.version)}` : ''}
        <span class="vers">${mine.map((x) => `<span class="pill blue">${esc(APP_NAMES[x.id] || x.id)} ${esc(x.version || '?')}</span>`).join('')}${other.map((x) => `<span class="vtag">${esc(APP_NAMES[x.id] || x.id)} ${esc(x.version || '?')}</span>`).join('')}${!(p.programs || []).length ? '<span class="muted">Programs not reported yet</span>' : ''}</span>
        <small class="muted">${p.programs_at ? `Reported ${ago(p.programs_at)}` : ''}${p.last_seen ? ` · last seen ${ago(p.last_seen)}` : ''}</small></li>`; }).join('');
    const sec = (id, icon, title, line, open, html, cls = '') => `<details class="dsec${cls}" id="${id}"${open ? ' open' : ''}><summary><span class="dsi" aria-hidden="true">${icon}</span><span class="dst"><b>${title}</b><small>${line}</small></span></summary><div class="dsb">${html}</div></details>`;
    const nu = t.next_update_due ? `<p class="nuline${t.update_overdue ? ' late' : ''}">${t.update_overdue ? '⚠️ Overdue: next update to customer was due' : 'Next update to customer: by'} <b>${esc(dueText(t.next_update_due))}</b>${t.next_update_owner_name ? ` (${esc(t.next_update_owner_name)})` : ''}</p>`
      : '<p class="nuline muted">No update promised yet. Set when the customer will hear from us next.</p>';
    const nuLine = t.next_update_due ? `${t.update_overdue ? 'Overdue · was due' : 'By'} ${esc(dueText(t.next_update_due))}${t.planned_release ? ` · ${esc(t.planned_release)}` : ''}` : t.planned_release ? `Release ${esc(t.planned_release)}` : 'No update promised';
    const bugLine = t.bug_ref || t.bug_url ? esc(t.bug_ref || 'Linked') : 'No bug linked';
    const notes = r.support_notes;
    return `<div class="tdhead"><b>Details</b><button type="button" class="btn sm" id="detClose">Close</button></div>
      ${sec('tbiz', '🏢', 'Customer', B ? `${esc(B.name)}${(B.paid || []).length ? ' · paying' : ''}` : 'Not linked to a business', true, B ? `<p class="dbiz"><b>${esc(B.name)}</b> ${pill(BSTAT, B.status || 'active')}</p><dl class="kv dkv"><dt>Business ID</dt><dd class="code">${esc(B.company_code || '')}</dd>
        ${t.opened_by_name || t.opened_by_email ? `<dt>Contact</dt><dd>${esc(t.opened_by_name || '')}${t.opened_by_email ? `<small class="muted"> ${esc(t.opened_by_email)}</small>` : ''}</dd>` : ''}
        <dt>Plan</dt><dd>${(B.paid || []).length ? B.paid.map(modName).map(esc).join(', ') : 'Nothing paid'}${(B.trial || []).length ? `<small class="muted"> · trial: ${B.trial.map(modName).map(esc).join(', ')}</small>` : ''}</dd>
        <dt>People · PCs</dt><dd>${num(B.people)} · ${num(B.pcs)}</dd><dt>Last active</dt><dd>${ago(B.last_active_at)}</dd>${creditText(B.credit) ? `<dt>Credit</dt><dd>${creditText(B.credit)}</dd>` : ''}</dl>
        ${r.pcs ? `<h4>Installed on their PCs</h4>${pcs ? `<ul class="pcl">${pcs}</ul>` : '<p class="muted small">No PCs linked yet.</p>'}` : ''}
        ${(r.refunds || []).length ? `<h4>Refund requests</h4>${r.refunds.map((f) => `<div class="small"><span class="code">${esc(f.ref)}</span> ${cur(f.amount, f.currency)} · ${pill(RSTAT, f.status)}</div>`).join('')}` : ''}
        <button class="btn sm" id="tco">Open customer page</button>` : '<p class="muted small">Not linked to a business.</p>')}
      ${sec('nuCard', '🗓️', 'Next update & planned release', nuLine, !!(t.next_update_due || t.planned_release), `${nu}
        ${t.status !== 'done' ? `<div class="row"><button class="btn sm" id="nuEdit">${t.next_update_due ? 'Edit' : 'Set next update'}</button>${t.next_update_due ? '<button class="btn sm" id="nuClear">Clear</button>' : ''}</div>` : ''}
        <form id="prf" class="prf"><label class="f"><span>Planned release <small class="muted">(free text for now)</small></span><input name="planned_release" maxlength="80" value="${esc(t.planned_release || '')}" placeholder="e.g. Payroll 2.8.2"></label><button class="btn sm">Save</button></form>`, t.update_overdue ? ' late' : '')}
      ${sec('diagCard', '📈', 'Diagnostics', d ? `${esc(d.ref)} · ${esc(prodName(d.product || t.product))} ${esc(d.product_version || '')}` : r.diag_hidden ? 'Needs support.diagnostics' : 'No diagnostic report', !!d || !!r.diag_hidden,
        d ? diagCard(d, t.product) : r.diag_hidden ? '<p class="muted small">This ticket has a diagnostic report. Looking at it needs the <b>support.diagnostics</b> permission.</p>'
          : `<p class="muted small">No diagnostic report on this ticket. Ask the customer to use <b>Get help → Report an issue</b> in Riyeser Central, then look up the DG- reference they give you (🔎 DG-… above the list).</p>`)}
      ${r.trial ? sec('trialCard', '⏳', 'Trial history', r.trial === 'yes' ? 'Open to see this PC\'s free-trial dates' : 'Needs trials.view', false,
        r.trial === 'yes' ? '<div id="trialBody"><p class="muted small">Loading…</p></div>' : '<p class="muted small">This ticket\'s report has the PC\'s free-trial record. Seeing it needs the <b>trials.view</b> permission.</p>') : ''}
      ${sec('bugCard', '🐞', 'Linked bug', bugLine, !!(t.bug_ref || t.bug_url), `${t.bug_ref || t.bug_url ? `<p class="bugl">${t.bug_url ? `<a href="${esc(t.bug_url)}" target="_blank" rel="noopener noreferrer"><b>${esc(t.bug_ref || 'Open the bug')}</b> ↗</a>` : `<b>${esc(t.bug_ref)}</b>`}</p>` : '<p class="muted small">No bug linked.</p>'}
        <button class="btn sm" id="bugEdit">${t.bug_ref || t.bug_url ? 'Edit' : 'Link a bug'}</button>`)}
      ${notes ? sec('snCard', '📌', 'Support notes', notes.length ? `${notes.length} pinned for ${esc(B ? B.name : 'this business')}` : 'No support notes', notes.length > 0, `<p class="muted small">Pinned for ${esc(B ? B.name : 'this business')}: they show on every ticket.</p>
        ${notes.length ? `<div class="snl">${notes.map((n) => `<div class="sn"><div>${esc(n.body)}</div><small>${esc(n.by || 'Riyeser')} · ${ago(n.at)}</small>
          ${can('customers.notes') ? `<span class="snb"><button class="lnk" data-snedit="${esc(n.id)}">Edit</button> · <button class="lnk" data-snunpin="${esc(n.id)}">Unpin</button></span>` : ''}</div>`).join('')}</div>` : '<p class="muted small">None yet.</p>'}
        ${can('customers.notes') ? '<button class="btn sm" id="snAdd">Add a support note</button>' : ''}`) : ''}
      ${r.escalations.length ? sec('tescs', '⬆', 'Escalations', `${r.escalations.length} · now ${esc(LEVELS[t.level])}`, false, r.escalations.map((e) => `<div class="small esc1">${e.to > e.from ? '⬆' : '⬇'} ${LEVELS[e.from]} → <b>${LEVELS[e.to]}</b> by ${esc(e.by)} · ${ago(e.at)}<br><span class="muted">${esc(e.reason)}</span></div>`).join('')) : ''}`;
  }
  function wireDiagPanel(el, r, staff, done) {
    const t = r.ticket; const B = r.business; const id = t.id;
    const on = (sel, fn) => { const x = el.querySelector(sel); if (x) x.onclick = fn; };
    const run = async (d, fn, ok) => { try { await fn(); if (d) d.remove(); if (ok) flash(ok); await done(); } catch (err) { if (d) d.querySelector('.derr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; else flash(plain(err)); } };
    on('#tco', () => openCompany(B.id));
    // Trial history: read only when it's opened (each look is in the HQ history)
    const tc = el.querySelector('#trialCard');
    if (tc && r.trial === 'yes') {
      const load = async () => { const body = tc.querySelector('#trialBody');
        try { const x = await api.ticketTrial(id); body.innerHTML = trialHistory(x, B); wireTrial(body, x, id, load); }
        catch (err) { body.innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
      tc.addEventListener('toggle', () => { if (tc.open && !tc.dataset.loaded) { tc.dataset.loaded = '1'; load(); } });
    }
    on('#nuEdit', () => dlg(`<h3>🗓️ Next update to the customer</h3><p class="muted small">When the customer will hear from us next, and who'll send it. If it's missed, it shows red in the inbox and on the Operations overview, and the owner gets a reminder. The customer isn't emailed about this.</p>
      <form id="nuf"><label class="f"><span>By</span><input type="datetime-local" name="due" required value="${esc(localInput(t.next_update_due || new Date(Date.now() + 4 * 3600e3)))}" min="${esc(localInput(new Date()))}"></label>
      <label class="f"><span>Who sends it</span><select name="owner">${staff.map((x) => `<option value="${esc(x.user_id)}"${x.user_id === (t.next_update_owner || t.assignee || S.me.id) || (!t.next_update_owner && !t.assignee && x.name === S.me.name) ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div class="derr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Save</button></div></form>`, (d) => {
      d.querySelector('#nuf').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); const due = new Date(String(f.get('due')));
        run(d, () => { if (Number.isNaN(due.getTime())) throw new Error('Choose a date and time.'); return api.ticketNextUpdate(id, due.toISOString(), String(f.get('owner') || '') || null); }, `Next update by ${dueText(due)}.`); }; }));
    on('#nuClear', () => run(null, () => api.ticketNextUpdate(id, null, null), 'Next update cleared.'));
    const prf = el.querySelector('#prf'); if (prf) prf.onsubmit = (e) => { e.preventDefault(); run(null, () => api.ticketSet(id, { planned_release: String(new FormData(prf).get('planned_release')).trim() }), 'Planned release saved.'); };
    on('#bugEdit', () => dlg(`<h3>🐞 Linked bug</h3><p class="muted small">The developers' bug for this problem: a short reference, and a link if there is one (for example a GitHub issue).</p>
      <form id="bgf"><label class="f"><span>Bug reference</span><input name="bug_ref" maxlength="80" value="${esc(t.bug_ref || '')}" placeholder="e.g. BUG-7719"></label>
      <label class="f"><span>Link <small class="muted">(optional, https://…)</small></span><input name="bug_url" type="url" maxlength="300" value="${esc(t.bug_url || '')}" placeholder="https://github.com/…/issues/…"></label>
      <div class="derr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Save</button></div></form>`, (d) => {
      d.querySelector('#bgf').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target);
        run(d, () => api.ticketSet(id, { bug_ref: String(f.get('bug_ref') || '').trim(), bug_url: String(f.get('bug_url') || '').trim() }), 'Bug link saved.'); }; }));
    const noteForm = (n) => dlg(`<h3>📌 ${n ? 'Edit support note' : 'Add a support note'}</h3><p class="muted small">Pinned to ${esc(B.name)}: it shows on every ticket for this business. Useful facts for troubleshooting (which office to call, which PC), never passwords.</p>
      <form id="snf"><label class="f"><span>Note</span><textarea name="body" rows="4" required maxlength="2000">${esc(n ? n.body : '')}</textarea></label>
      <div class="derr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Save note</button></div></form>`, (d) => {
      d.querySelector('#snf').onsubmit = (e) => { e.preventDefault(); const body = String(new FormData(e.target).get('body')).trim();
        run(d, () => (n ? api.noteEdit(n.id, body) : api.noteAdd(B.id, { kind: 'note', body, pinned: true })), 'Support note saved.'); }; });
    on('#snAdd', () => noteForm(null));
    el.querySelectorAll('[data-snedit]').forEach((b) => b.onclick = () => noteForm(r.support_notes.find((n) => String(n.id) === b.dataset.snedit)));
    el.querySelectorAll('[data-snunpin]').forEach((b) => b.onclick = () => run(null, () => api.notePin(Number(b.dataset.snunpin), false), 'Unpinned. It stays on the customer page.'));
  }
  function logTicketCall(t, B, after) {
    dlg(`<h3>📞 Log a call</h3><p class="muted small">It goes in this ticket's thread. Only Riyeser staff see it.</p>
      <form id="lcf"><div class="row"><label class="opt"><input type="radio" name="direction" value="in" checked> They called us</label><label class="opt"><input type="radio" name="direction" value="out"> We called them</label></div>
      <label class="f"><span>Who</span><input name="who" maxlength="120" value="${esc(t.opened_by_name || '')}"></label>
      <label class="f"><span>What was said, and the next step</span><textarea name="body" rows="4" required maxlength="5000" placeholder="e.g. Agreed to try the workaround; we'll update them by 3 pm"></textarea></label>
      <div id="lcerr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Save call</button></div></form>`, (d, close) => {
      d.querySelector('#lcf').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
        try { await api.ticketLogCall(t.id, String(f.get('direction')), String(f.get('who') || '').trim(), String(f.get('body')).trim()); close(); flash('Call saved in the thread.'); await after(); }
        catch (err) { d.querySelector('#lcerr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
    void B;
  }
  async function manageSaved(after) {
    const list = await api.savedReplies();
    dlg(`<h3>Saved replies</h3><p class="muted small">Ready-made answers anyone can insert into a reply. Keep them friendly and plain.</p>
      <div class="srl">${list.map((s) => `<details><summary>${esc(s.title)}</summary><form data-sr="${s.id}"><input name="title" value="${esc(s.title)}" required maxlength="80"><textarea name="body" rows="4" required maxlength="5000">${esc(s.body)}</textarea>
        <div class="row"><button class="btn sm p">Save</button><button type="button" class="btn sm" data-retire="${s.id}">Remove</button></div></form></details>`).join('') || '<p class="muted small">None yet.</p>'}</div>
      <form id="srn" class="card"><b class="small">Add one</b><input name="title" required maxlength="80" placeholder="Title"><textarea name="body" rows="3" required maxlength="5000" placeholder="The reply"></textarea><button class="btn sm p">Add</button></form>
      <div class="mfoot"><button class="btn" data-close>Close</button></div>`, (d, close) => {
      const again = async () => { close(); await manageSaved(after); if (after) after(); };
      const run = async (fn) => { try { await fn(); await again(); } catch (err) { flash(plain(err)); } };
      d.querySelectorAll('form[data-sr]').forEach((f) => f.onsubmit = (e) => { e.preventDefault(); const x = new FormData(f); run(() => api.saveReply(Number(f.dataset.sr), String(x.get('title')), String(x.get('body')))); });
      // asks in the page: the first click turns the button into "Remove it for good?"
      d.querySelectorAll('[data-retire]').forEach((b) => b.onclick = () => { if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Remove it for good?'; b.classList.add('danger'); return; } run(() => api.retireReply(Number(b.dataset.retire))); });
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
    const [L, pr] = await Promise.all([api.licences(), api.paymentsReceived ? api.paymentsReceived(30).catch(() => null) : null]);
    const real = L.monthly_recurring != null;
    // As Built is hidden on the website: only show its row once someone has it paid or installed
    const rows = (L.modules || []).filter((m) => m.module !== 'as_built' || Number(m.active_paid) > 0 || Number(m.installed) > 0);
    // Ending soon: one row per business (its programs together), soonest first; As Built only when its row shows
    const showAb = rows.some((x) => x.module === 'as_built'); const ends = [];
    (L.ending_soon || []).filter((x) => x.module !== 'as_built' || showAb).forEach((x) => { const g = ends.find((y) => y.id === x.id && y.status === x.status && y.days_left === x.days_left);
      if (g) g.mods.push(x.module); else ends.push({ ...x, mods: [x.module] }); });
    const cell = (m, k, st) => `<td class="n">${Number(m[k]) ? `<button class="lnk numl" data-lmod="${m.module}" data-lst="${st}" title="Show these businesses">${num(m[k])}</button>` : '<span class="muted">0</span>'}</td>`;
    const m = main(`<h2>Licences</h2><p class="sub">Who pays for what. Money figures come from real payments; the list-price estimate is shown for comparison.</p>
      <div class="tiles">${tile('Received last 30 days', pr ? money(pr.total) : '—', pr ? `${num(pr.count)} payment${Number(pr.count) === 1 ? '' : 's'} · <a href="#/payments">Invoices &amp; payments</a>` : 'payments not connected yet')}
        ${tile('Monthly recurring', real ? money(L.monthly_recurring) : '—', `${real ? `${num(L.recurring_count)} subscription${Number(L.recurring_count) === 1 ? '' : 's'} and paid invoices · ` : ''}<span class="est">list-price estimate ${money(L.monthly_estimate)}</span>`)}
        ${tile('Paying companies', num(L.paying_companies), 'at least one paid program')}
        ${tile('Early bird places left', num(L.early_bird_left), `of 100 · ${num(L.early_bird_used)} taken`)}</div>
      <div class="grid g2 licgrid"><div class="card scroll"><h3>By program <small>· click a row or a number to see the businesses</small></h3><table class="tbl lictbl" id="licTbl"><thead><tr><th>Program</th><th class="n">Paid</th><th class="n">On trial</th><th class="n">Ended</th></tr></thead><tbody>
        ${rows.map((x) => `<tr class="click" data-lrow="${x.module}"><td><b>${esc(modName(x.module))}</b></td>${cell(x, 'active_paid', 'paid')}${cell(x, 'on_trial', 'trial')}${cell(x, 'ended', 'ended')}</tr>`).join('')}</tbody></table></div>
      <div class="card" id="endSoon"><h3>Ending soon <small>· next 14 days · follow up before they lapse</small></h3>${ends.length ? `<table class="tbl endtbl"><thead><tr><th>Company</th><th>Programs</th><th class="n">Days</th></tr></thead><tbody>
        ${ends.map((x, i) => `<tr class="click${i >= 12 ? ' more' : ''}" data-co="${x.id}"${i >= 12 ? ' hidden' : ''}><td><b>${esc(x.name)}</b><small class="code">${esc(x.company_code || '')}</small></td><td>${x.mods.length >= rows.length ? 'Every program' : esc(x.mods.map(modName).join(', '))} <small>${x.status === 'trial' ? 'free trial' : 'paid period'}</small></td><td class="n"><span class="pill ${x.days_left <= 3 ? 'bad' : 'warn'}">${x.days_left}</span></td></tr>`).join('')}</tbody></table>
        ${ends.length > 12 ? `<button type="button" class="btn sm" id="endAll">Show all ${num(ends.length)}</button>` : ''}`
        : '<p class="muted small">Nothing ending in the next 14 days.</p>'}</div></div>
      <div class="card scroll" id="trialPcs"><h3>Free-trial PCs <small>· anonymous PC records (counts only), for PCs not signed in to a business</small></h3><p class="muted small">Loading…</p></div>`);
    // counts only, never a PC code; an older database (team-chat.sql not re-run yet) just says so
    (async () => { const box = m.querySelector('#trialPcs');
      try { const c = await api.trialPcs(); box.querySelector('p').outerHTML = (c || []).length ? `<table class="tbl"><thead><tr><th>Trial</th><th class="n">PCs</th><th class="n">On trial now</th><th class="n">Seen in 30 days</th></tr></thead><tbody>
          ${c.map((x) => `<tr><td><b>${esc(x.program === 'suite' ? 'Riyeser programs (shared trial)' : x.program === 'estimate' ? 'Riyeser Estimate' : x.program)}</b></td><td class="n">${num(x.pcs)}</td><td class="n">${num(x.on_trial)}</td><td class="n">${num(x.seen_30d)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted small">No PCs yet.</p>'; }
      catch (e) { box.querySelector('p').textContent = missing(e) ? 'Run the latest team-chat.sql to switch this on.' : plain(e); } })();
    const ea = m.querySelector('#endAll'); if (ea) ea.onclick = () => { m.querySelectorAll('.endtbl tr.more').forEach((r) => { r.hidden = false; }); ea.remove(); };
    m.querySelectorAll('[data-co]').forEach((r) => r.onclick = () => openCompany(r.dataset.co));
    m.querySelectorAll('[data-lst]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); licenceList(b.dataset.lmod, b.dataset.lst); });
    m.querySelectorAll('[data-lrow]').forEach((r) => r.onclick = () => { const x = rows.find((y) => y.module === r.dataset.lrow);
      licenceList(x.module, Number(x.active_paid) ? 'paid' : Number(x.on_trial) ? 'trial' : 'ended'); });
  }
  // The businesses on one program, by status (Paid / On trial / Ended); a row opens the customer's Programs tab.
  function licenceList(mod, st) {
    const ST = [['paid', 'Paid'], ['trial', 'On trial'], ['ended', 'Ended']];
    dlg(`<h3>${esc(modName(mod))}</h3><div class="chips" id="llst">${ST.map(([k, l]) => `<button type="button" class="chip${k === st ? ' on' : ''}" data-st="${k}">${l}</button>`).join('')}</div>
      <div id="llout" class="scroll llout"><p class="muted">Loading…</p></div><div class="mfoot"><button type="button" class="btn" data-close>Close</button></div>`, (d, close) => {
      const load = async (s2) => { d.querySelectorAll('#llst .chip').forEach((c) => c.classList.toggle('on', c.dataset.st === s2)); const out = d.querySelector('#llout');
        try { const list = await api.licenceBusinesses(mod, s2);
          out.innerHTML = list.length ? `<table class="tbl" id="llTbl"><thead><tr><th>Business</th><th>Until</th><th class="n">Days left</th></tr></thead><tbody>${list.map((x) => `<tr class="click" data-llco="${esc(x.id)}"><td><b>${esc(x.name)}</b><small class="code">${esc(x.company_code || '')}</small></td>
            <td>${x.until ? day(x.until) : '<span class="muted">—</span>'}${x.status === 'cancelled' ? '<small>cancelled</small>' : ''}</td><td class="n">${x.days_left != null ? num(x.days_left) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>
            <p class="muted small">${num(list.length)} business${list.length === 1 ? '' : 'es'}.</p>` : '<p class="muted small">None.</p>';
          out.querySelectorAll('[data-llco]').forEach((r) => r.onclick = () => { close(); openCompany(r.dataset.llco, 'programs'); });
        } catch (err) { out.innerHTML = `<div class="err">${esc(plain(err))}</div>`; } };
      d.querySelectorAll('#llst [data-st]').forEach((c) => c.onclick = () => load(c.dataset.st)); load(st);
    });
  }

  // ------------------------------------------------------------------ downloads (downloads.view): real downloads and installs
  // Real downloads come from riyeser.com's Download buttons (the "download" function: robots, tests and HQ staff left out,
  // one person counted once a day per program); installs from Riyeser Central's anonymous counts. GitHub's own totals
  // (which include our CI, update checks and robots) are kept in the collapsed "Raw GitHub counts" section.
  const DL_STAFF_KEY = 'riyeser-hq-nocount';   // the website's download page reads it (build.mjs, STAFF_KEY)
  const DL_PROG = { central: 'Riyeser Central', documents: 'Riyeser Documents', desk: 'Riyeser Documents', pdf: 'PDF', payroll: 'Payroll', services: 'As Built',
    'accounting-basics': 'Accounting Basics', accounting: 'Accounting Plus', pos: 'POS', invoices: 'Invoices', bookings: 'Bookings', estimate: 'Estimate',
    link: 'Riyeser Link', team: 'Riyeser Link', 'link-office': 'Link Office', linkoffice: 'Link Office' };
  const dlProg = (id) => DL_PROG[id] || id;
  const dlCountry = (() => { let dn = null; try { dn = new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }); } catch { /* old browser */ }
    return (c) => (!c ? 'Not known' : (dn && /^[A-Z]{2}$/.test(c) ? dn.of(c) : c)); })();
  const dlFrom = (r) => { if (!r) return 'Not known (direct link or no JavaScript)'; if (!r.startsWith('/')) return r;
    const pg = pageName(r); if (pg) return `${pg} page`; const m = /^\/(programs|help|industries)\/(.+)$/.exec(r);
    const t = m ? `${m[1] === 'programs' ? dlProg(m[2]) : m[2].replace(/-/g, ' ')} ${m[1] === 'help' ? 'guide' : 'page'}` : r; return t.charAt(0).toUpperCase() + t.slice(1); };
  const staffNoCount = () => { try { return localStorage.getItem(DL_STAFF_KEY) === '1'; } catch { return false; } };
  async function downloads() {
    S.dl = S.dl || { r: 30, p: '' }; const st = S.dl;
    const m = main(`<h2>Downloads</h2><p class="sub">Real downloads from riyeser.com and installs reported by Riyeser Central. Robots, tests and Riyeser staff are left out, and one person downloading a program twice in a day counts once.</p>
      <div class="trbar"><div class="chips" id="dlr">${[[30, 'Last 30 days'], [90, 'Last 90 days']].map(([k, l]) => `<button class="chip${st.r === k ? ' on' : ''}" data-dlr="${k}">${l}</button>`).join('')}</div>
        <span class="muted small" id="dldates"></span>
        <label class="dlstaff" title="Downloads you start from riyeser.com in this browser are marked staff and left out"><input type="checkbox" id="dlstaff"${staffNoCount() ? ' checked' : ''}> Don’t count downloads from this browser</label></div>
      <div id="dl"><p class="muted">Loading…</p></div>
      <details class="card dlraw" id="dlraw"><summary><b>Raw GitHub counts</b> <span class="muted small">(include tests and update checks)</span></summary><div id="dlrawb"><p class="muted small">Opening…</p></div></details>`);
    m.querySelectorAll('[data-dlr]').forEach((b) => b.onclick = () => { st.r = Number(b.dataset.dlr); downloads(); });
    m.querySelector('#dlstaff').onchange = (e) => { try { if (e.target.checked) localStorage.setItem(DL_STAFF_KEY, '1'); else localStorage.removeItem(DL_STAFF_KEY); } catch { /* private window */ }
      flash(e.target.checked ? 'Downloads from this browser are now marked staff and left out.' : 'Downloads from this browser count again.'); };
    m.querySelector('#dlraw').addEventListener('toggle', (e) => { if (e.target.open && !e.target.dataset.done) { e.target.dataset.done = '1'; rawGithub(m.querySelector('#dlrawb')); } });
    let r = null;
    try { r = await api.realDownloads(st.r); } catch (e) {
      if (!missing(e)) throw e;
      m.querySelector('#dl').innerHTML = '<div class="banner est">Real download counts need the latest team-chat.sql: run “Update the Riyeser Link database”, then “Deploy download counter” and “Publish website” (ops/RUNBOOK.md). GitHub’s raw counts are below.</div>';
      return;
    }
    m.querySelector('#dldates').textContent = `${day(r.from)} to ${day(r.to)}`;
    const H = r.hidden || {}; const I = r.installs || {};
    const merge = (rows, key, val) => Object.values(rows.reduce((a, x) => { const k = key(x); const o = a[k] = a[k] || { k, v: 0 }; o.v += Number(val(x) || 0); return a; }, {})).sort((a, b) => b.v - a.v);
    // programs: website ids and Central's ids for the same program are one row
    const progs = Object.values((r.programs || []).reduce((a, x) => { const k = dlProg(x.program); const o = a[k] = a[k] || { name: k, ids: [], real: 0, raw: 0, installs: 0, updates: 0 };
      o.ids.push(x.program); ['real', 'raw', 'installs', 'updates'].forEach((f) => { o[f] += Number(x[f] || 0); }); return a; }, {})).sort((a, b) => b.real - a.real || b.installs - a.installs);
    const pick = progs.find((p) => p.name === st.p);
    const seriesOf = () => { if (!pick) return (r.series || []).map((x) => ({ ...x, visits: Number(x.real) }));
      const per = {}; (r.program_series || []).filter((x) => pick.ids.includes(x.program)).forEach((x) => { per[x.d] = (per[x.d] || 0) + Number(x.real); });
      return (r.series || []).map((x) => ({ d: x.d, visits: per[x.d] || 0, real: per[x.d] || 0, prog: true })); };
    const series = seriesOf(); const lbl = (x) => new Date(x.d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const box = (id, title, sub, body, cls = '') => `<div class="card trcard${cls ? ' ' + cls : ''}" id="${id}"><h3>${title}${sub ? ` <small>· ${sub}</small>` : ''}</h3>${body}</div>`;
    const empty = !Number(r.raw) && !Number(I.new) && !Number(I.existing);
    m.querySelector('#dl').innerHTML = `
      ${empty ? '<div class="banner est">Nothing counted in these dates yet. Downloads count once the website is published with the download counter; installs once PCs run the new Riyeser Central.</div>' : ''}
      <div class="tiles trtiles dltiles">${tile('Real downloads', num(r.real), 'one person, one program, once a day')}
        ${tile('New installs', num(I.new), `${num(I.existing)} PC${Number(I.existing) === 1 ? '' : 's'} already had Central · ${num(I.linked)} linked to a business`)}
        ${tile('Updates', num(I.updates), `${num(I.added)} program${Number(I.added) === 1 ? '' : 's'} added to a PC`)}
        ${tile('Downloads per install', Number(I.new) ? (Number(r.real) / Number(I.new)).toFixed(1) : '—', 'real downloads ÷ new installs')}</div>
      <p class="dlhidden small" id="dlhidden">Hidden: tests ${num(H.tests)}, staff ${num(H.staff)}, bots ${num(H.bots)} · repeat downloads ${num(H.repeats)} · test installs ${num(H.install_tests)} <span class="muted">(${num(r.raw)} clicks in all)</span></p>
      ${box('dlChart', `Real downloads per day${pick ? ` · ${esc(pick.name)}` : ''}`, `${day(r.from)} to ${day(r.to)}`,
        `<div class="chips dlprogs" id="dlp"><button class="chip${pick ? '' : ' on'}" data-dlp="">All programs</button>${progs.filter((p) => p.real).map((p) => `<button class="chip${pick && pick.name === p.name ? ' on' : ''}" data-dlp="${esc(p.name)}">${esc(p.name)} <b>${num(p.real)}</b></button>`).join('')}</div>${lineChart(series, lbl)}`, 'wide')}
      <div class="grid g2 trg">
        ${box('dlProgs', 'By program', 'in these dates', progs.length ? `<div class="scroll"><table class="tbl rtbl"><tr><th>Program</th><th class="n">Real downloads</th><th class="n">New installs</th><th class="n">Updates</th><th class="n">All clicks</th></tr>
          ${progs.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td class="n">${num(p.real)}</td><td class="n">${num(p.installs)}</td><td class="n">${num(p.updates)}</td><td class="n muted">${num(p.raw)}</td></tr>`).join('')}</table></div>` : '<p class="muted small">Nothing yet.</p>')}
        ${box('dlCountries', 'By country', 'real downloads', barList(merge(r.countries || [], (x) => dlCountry(x.country), (x) => x.real).slice(0, 10), (x) => x.k, (x) => x.v))}</div>
      <div class="grid g3 trg dlg3">
        ${box('dlFrom', 'Where the button was', 'real downloads', barList(merge(r.referrers || [], (x) => dlFrom(x.referrer), (x) => x.real).slice(0, 10), (x) => x.k, (x) => x.v))}
        ${box('dlRel', 'By release', 'real downloads', barList((r.releases || []).slice(0, 8).map((x) => ({ k: x.tag ? x.tag.replace(/^riyeser-/, '') : 'Not known', v: Number(x.real) })), (x) => x.k, (x) => x.v))}
        ${box('dlInst', 'New installs by country', 'from the linked business', barList(merge(r.install_countries || [], (x) => x.country || 'Not linked yet', (x) => x.n).slice(0, 8), (x) => x.k, (x) => x.v))}</div>
      <p class="privacy trpriv"><b>How it’s counted:</b> each click on a riyeser.com Download button is one note: the program, the release, a country (from the network, or the browser’s time zone), the page the button was on, and a code made from the internet address and browser that changes every day, so a repeat download the same day counts once and nobody can be followed from day to day. No IP addresses or browser details are kept. Robots, our tests and CI, and browsers with “Don’t count downloads from this browser” ticked are counted separately and left out. Installs come from Riyeser Central (anonymous, and each PC can turn it off in Settings). Demo mode and our test PCs are left out.</p>`;
    m.querySelectorAll('[data-dlp]').forEach((b) => b.onclick = () => { st.p = b.dataset.dlp; downloads(); });
    wireLineChart(m.querySelector('#dlChart'), series, (x) => `<b>${esc(day(x.d))}</b><span>${num(x.real)} real downloads</span>${x.prog ? '' : `<span>${num(x.installs)} new installs · ${num(x.updates)} updates</span>`}`);
  }
  // GitHub's own totals: every installer download, including our CI runs, Central's update downloads and robots.
  async function rawGithub(el) {
    // Both repositories (the code repository answers 404 once it's private: then only the downloads repository counts);
    // a release in both (the same tag) is one release, its downloads added together.
    const byTag = new Map();
    for (const repo of [DOWNLOADS_REPO, REPO]) {
      try { for (let page = 1; page <= 3; page++) { const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`); if (!r.ok) break;
          const batch = await r.json(); if (!Array.isArray(batch)) break;
          for (const rel of batch) { const had = byTag.get(rel.tag_name); if (had) had.assets = (had.assets || []).concat(rel.assets || []); else byTag.set(rel.tag_name, { ...rel, assets: [...(rel.assets || [])] }); }
          if (batch.length < 100) break; } } catch { /* offline: show what we have */ }
    }
    const releases = [...byTag.values()].sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
    const byProduct = {}; const byRelease = [];
    for (const rel of releases) { let tot = 0; for (const a of rel.assets || []) { if (!/\.exe$/i.test(a.name)) continue;
      const p = productOf(a.name); byProduct[p] = (byProduct[p] || 0) + a.download_count; tot += a.download_count; }
      byRelease.push({ tag: rel.tag_name, when: rel.published_at, total: tot }); }
    const prod = Object.entries(byProduct).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
    const total = prod.reduce((a, b) => a + b.n, 0);
    // Daily trend from HQ's saved totals (hq-downloads.yml): downloads each day = today's total minus yesterday's.
    let trend = [];
    try { const rows = await api.downloadsDaily(60); const perDay = {}; rows.forEach((r) => { perDay[r.day] = (perDay[r.day] || 0) + Number(r.total); });
      const days = Object.keys(perDay).sort(); trend = days.slice(1).map((d, i) => ({ day: d, n: Math.max(0, perDay[d] - perDay[days[i]]) })); } catch { /* no saved totals yet */ }
    el.innerHTML = `<p class="muted small">Straight from GitHub: every download of an installer file, including our own build and test runs, Riyeser Central downloading updates, and robots. Use the numbers above for real downloads.</p>
      <div class="tiles">${tile('All GitHub downloads', num(total), `${releases.length} releases`)}${tile('Riyeser Central', num(byProduct['Riyeser Central']), 'GitHub total')}
        ${tile('Latest release', esc(byRelease[0] ? byRelease[0].tag.replace('riyeser-', '') : '—'), byRelease[0] ? `${num(byRelease[0].total)} downloads · ${day(byRelease[0].when)}` : '')}${tile('Programs', num(prod.length), 'with downloads')}</div>
      <div class="grid g2"><div class="card"><h3>By program <small>· all time</small></h3>${barList(prod, (r) => r.name, (r) => r.n)}</div>
        <div class="card"><h3>GitHub downloads per day <small>· from HQ's daily counts</small></h3>${trend.length ? columnChart(trend.slice(-30), (r) => new Date(r.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), (r) => r.n, 'downloads')
          : '<p class="muted small">Starts the day after the daily “HQ download counts” job first runs.</p>'}</div></div>
      <div class="card scroll" style="margin-top:14px"><h3>By release</h3><table class="tbl"><tr><th>Release</th><th>Published</th><th class="n">Downloads</th></tr>
        ${byRelease.slice(0, 15).map((r) => `<tr><td class="code">${esc(r.tag)}</td><td>${day(r.when)}</td><td class="n">${num(r.total)}</td></tr>`).join('')}</table></div>`;
  }

  // ------------------------------------------------------------------ HQ team: People (each person's role and ticks), Roles, settings
  // Owner's decision: "still have a standard selection but we can tick or untick as required". Each person has a standard role;
  // its ticks show on their page and can be ticked or unticked for them alone (shown as "Support (customised)", with Reset to
  // standard). Roles: the built-in ones are templates (view, duplicate); custom roles can be made, changed and removed. The
  // database checks all of it again (hq_set_staff_access, hq_role_save, hq_role_delete in team-chat.sql).
  const TT = { tab: 'people', person: null, role: null };   // where the HQ team page is: its tab, a person's page, a role being edited
  async function teamData() {
    let T = null; try { T = await api.team(true); } catch (e) { if (!missing(e)) throw e; }
    const staff = T ? T.staff : await api.staff();
    const fresh = !!(T && T.role_list);   // a database with custom roles (else: the built-in roles only, as before)
    const all = PERMS.map((p) => p[0]);
    const roles = (fresh ? T.role_list : ROLES.map(([key, name]) => ({ key, name, description: ROLE_DESC[key], builtin: true,
      perms: (T && T.roles && T.roles[key]) || ROLE_PERMS[key] || [], standard: ROLE_PERMS[key], people: staff.filter((x) => x.role === key).length })))
      .map((r) => ({ ...r, perms: r.key === 'owner' ? all : r.perms || [] }));
    roles.forEach((r) => { ROLE_NAMES[r.key] = r.name; });
    return { staff, roles, fresh };
  }
  const meOwner = () => !!S.me && S.me.role === 'owner';
  const isMe = (s) => (S.me.id ? s.user_id === S.me.id : s.display_name === S.me.name);
  // what you could give someone: the Owner anything; anyone else only what they have themselves, never an Owner-only one
  const canGive = (p) => meOwner() || (S.perms.includes(p) && !OWNER_ONLY.includes(p));
  const personEditable = (s, D) => can('staff.manage') && !isMe(s) && (meOwner() || (D.fresh && !['owner', 'admin'].includes(s.role)));
  const roleEditable = (r) => can('staff.manage') && r.key !== 'owner' && (meOwner() || (r.key !== 'admin' && S.me.role !== r.key));
  const rolesFor = (D, s) => D.roles.filter((r) => meOwner() || !['owner', 'admin'].includes(r.key) || (s && r.key === s.role));
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'They';
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const customised = (s) => s.role !== 'owner' && !!((s.perms_add || []).length || (s.perms_remove || []).length);
  const diffText = (s) => [(s.perms_add || []).length ? `+${s.perms_add.length} added` : '', (s.perms_remove || []).length ? `−${s.perms_remove.length} removed` : ''].filter(Boolean).join(' · ');

  // The grouped checklist of every HQ permission, each with what it allows. base (a person's page) = the role's ticks, so what
  // differs for this person is marked; a tick you can't give is greyed out with the reason.
  function permList(sel, { editable = true } = {}) {
    return `<div class="rl-groups">${PERM_GROUPS.map(([g, list]) => `<fieldset class="rl-grp"><legend>${esc(g)} <small class="rl-cnt" data-cnt="${esc(g)}"></small></legend>
      ${list.map(([k, l, h]) => { const why = !editable || sel.has(k) || canGive(k) ? '' : OWNER_ONLY.includes(k) ? 'Only the Owner can give this.' : 'You can\'t give this: you don\'t have it yourself.';
        return `<label class="rl-item" data-perm="${esc(k)}"><input type="checkbox" name="p" value="${esc(k)}"${sel.has(k) ? ' checked' : ''}${!editable || why ? ' disabled' : ''}>
          <span class="rl-txt"><span class="rl-name">${esc(l)}${OWNER_ONLY.includes(k) ? '<span class="rl-tag own">Owner gives this</span>' : ''}<span class="rl-tag rl-diff" hidden></span></span>
          <small>${esc(h)}</small>${why ? `<small class="rl-why">${esc(why)}</small>` : ''}</span></label>`; }).join('')}</fieldset>`).join('')}</div>`;
  }
  function permRefresh(root, sel, base, who) {
    root.querySelectorAll('.rl-item').forEach((it) => { const k = it.dataset.perm; const on = sel.has(k); const t = it.querySelector('.rl-diff');
      const add = !!base && on && !base.has(k); const rem = !!base && !on && base.has(k);
      it.classList.toggle('add', add); it.classList.toggle('rem', rem); t.textContent = add ? `+ added for ${who}` : rem ? `− removed for ${who}` : ''; t.hidden = !(add || rem); });
    root.querySelectorAll('[data-cnt]').forEach((c) => { const list = (PERM_GROUPS.find(([g]) => g === c.dataset.cnt) || [, []])[1];
      c.textContent = `· ${list.filter(([k]) => sel.has(k)).length} of ${list.length}`; });
  }
  // the live summary in plain English: "People with this role can…"
  function permSummary(sel, title) {
    const groups = PERM_GROUPS.map(([g, list]) => [g, list.filter(([k]) => sel.has(k))]).filter(([, l]) => l.length);
    return `<h4>${esc(title)} <small class="muted">${sel.size} of ${PERMS.length}</small></h4>
      ${groups.length ? groups.map(([g, l]) => `<p class="rl-sg">${esc(g)}</p><ul>${l.map(([, n]) => `<li>${esc(n)}</li>`).join('')}</ul>`).join('') : '<p class="muted small">Nothing yet: tick what they need.</p>'}
      <p class="rl-sg">Never, for anyone</p><ul class="rl-nv">${NEVER.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }
  const teamBack = (label) => `<p class="rl-back"><button type="button" class="lnk" id="ttBack">← ${esc(label)}</button></p>`;

  // team(true): stay where you are (after a change); from the menu: the People or Roles list
  async function team(stay) {
    if (!stay) { TT.person = null; TT.role = null; }
    const D = await teamData();
    if (TT.person) { const s = D.staff.find((x) => x.user_id === TT.person); if (s) return personPage(D, s); TT.person = null; }
    if (TT.role) { if (TT.role.key && !D.roles.some((r) => r.key === TT.role.key)) TT.role = null; else return roleEditor(D, TT.role); }
    const settings = TT.tab === 'people' && can('settings.manage') ? await api.settings().catch(() => null) : null;
    const m = main(`<h2>HQ team</h2><p class="sub">Riyeser staff who can use HQ. Everyone needs two-step sign-in. Each person has a standard role, and you can tick or untick permissions for one person on their page.</p>
      <div class="cptabs rl-tabs" role="tablist" aria-label="HQ team">${[['people', 'People'], ['roles', 'Roles']].map(([k, l]) => `<button type="button" role="tab" data-tt="${k}" aria-selected="${TT.tab === k}" class="${TT.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="ttBody"></div>`);
    m.querySelectorAll('[data-tt]').forEach((b) => b.onclick = () => { TT.tab = b.dataset.tt; team(true); });
    if (TT.tab === 'roles') rolesTab(D, m.querySelector('#ttBody')); else peopleTab(D, m.querySelector('#ttBody'), settings);
  }

  function peopleTab(D, el, settings) {
    const mng = can('staff.manage');
    el.innerHTML = `<div class="card scroll"><table class="tbl" id="staff"><tr><th>Name</th><th>Role</th><th>Status</th><th>Added</th><th></th></tr>
      ${D.staff.map((s) => `<tr><td><b>${esc(s.display_name)}</b>${s.email ? `<small>${esc(s.email)}</small>` : ''}</td>
        <td><span class="rl-rn">${esc(s.role_name || roleName(s.role))}${customised(s) ? ' <span class="pill violet">customised</span>' : ''}</span>${customised(s) ? `<small>${esc(diffText(s))}</small>` : ''}</td>
        <td>${s.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Switched off</span>'}</td><td>${day(s.added_at)}</td>
        <td><div class="row"><button type="button" class="btn sm" data-access="${esc(s.user_id)}">${personEditable(s, D) ? 'Role and access' : 'See access'}</button>
          ${isMe(s) ? '<span class="muted small">you</span>' : mng ? `<button type="button" class="btn sm" data-toggle="${esc(s.user_id)}">${s.active ? 'Switch off' : 'Switch on'}</button>` : ''}</div></td></tr>`).join('')}</table></div>
      ${mng ? `<div class="card" style="margin-top:14px"><h3>Add someone to the HQ team</h3><p class="muted small">They need a Riyeser account first (riyeser.com/link), and must turn on two-step sign-in there. You can tick or untick their permissions afterwards.</p>
        <form id="as" class="grid g3"><label class="f"><span>Email</span><input type="email" name="email" required></label><label class="f"><span>Name</span><input name="name" required maxlength="60"></label>
        <label class="f"><span>Standard role</span><select name="role">${rolesFor(D).map((r) => `<option value="${esc(r.key)}"${r.key === 'support' ? ' selected' : ''}>${esc(r.name)}${r.builtin ? '' : ' (custom)'}</option>`).join('')}</select></label><div><button class="btn p">Add</button></div></form></div>` : ''}
      ${settings ? `<div class="card" style="margin-top:14px" id="settings"><h3>HQ settings <small>· owners only</small></h3><form id="setf" class="grid g2">
        <label class="f"><span>Ticket overdue after (hours without a first reply)</span><input type="number" min="1" name="support.overdue_hours" value="${esc(settings['support.overdue_hours'])}"></label>
        <label class="f"><span>Escalate automatically after (hours waiting on us)</span><input type="number" min="1" name="support.escalate_hours" value="${esc(settings['support.escalate_hours'])}"></label>
        <label class="f"><span>Refunds over this need two approvals (any currency)</span><input type="number" min="1" name="refunds.two_person_threshold" value="${esc(settings['refunds.two_person_threshold'])}"></label>
        <label class="f"><span>Free periods up to this many days apply straight away</span><input type="number" min="1" name="offers.self_limit_days" value="${esc(settings['offers.self_limit_days'])}"></label>
        ${settings['billing.grace_days'] != null ? `<label class="f"><span>After a failed PayPal payment, programs keep working this many days</span><input type="number" min="1" name="billing.grace_days" value="${esc(settings['billing.grace_days'])}"></label>` : ''}
        ${settings['sign.free_per_month'] != null ? `<label class="f"><span>Riyeser PDF: free signing requests a business can send each month</span><input type="number" min="1" name="sign.free_per_month" value="${esc(settings['sign.free_per_month'])}"></label>` : ''}
        <div><button class="btn p">Save settings</button></div></form></div>` : ''}`;
    el.querySelectorAll('[data-access]').forEach((b) => b.onclick = () => { TT.person = b.dataset.access; team(true); });
    el.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => { const s = D.staff.find((x) => x.user_id === b.dataset.toggle);
      const run = async () => { await api.setStaff(s.user_id, s.role, !s.active); flash(`${s.display_name} ${s.active ? 'switched off' : 'switched on'}.`); team(true); };
      if (!s.active) return run().catch((err) => alert(plain(err)));
      dlg(`<h3>Switch off ${esc(s.display_name)}'s HQ access?</h3><p class="muted small">They can't use HQ until someone switches them on again. Their role and ticks are kept, and it goes in the HQ history.</p>
        <div id="swErr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn p" id="swGo">Switch off</button></div>`, (d, close) => {
        d.querySelector('#swGo').onclick = async () => { try { await run(); close(); } catch (err) { d.querySelector('#swErr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; }); });
    const as = el.querySelector('#as'); if (as) as.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
      try { await api.addStaff(String(f.get('email')), String(f.get('name')), String(f.get('role'))); flash(`${String(f.get('name'))} added to the HQ team.`); team(true); } catch (err) { alert(plain(err)); } };
    const sf = el.querySelector('#setf'); if (sf) sf.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(sf);
      try { for (const [k, v] of f.entries()) if (Number(v) !== Number(settings[k])) await api.setSetting(k, Number(v)); flash('Settings saved.'); team(true); } catch (err) { alert(plain(err)); } };
  }

  // A person's page: their standard role, its ticks, and what's ticked or unticked for them alone (the main way in).
  function personPage(D, s) {
    const ed = personEditable(s, D); const who = firstName(s.display_name);
    const roleOf = (k) => D.roles.find((r) => r.key === k) || { key: k, name: roleName(k), perms: [], builtin: true };
    let role = s.role; let sel = new Set(s.role === 'owner' ? PERMS.map((p) => p[0]) : (s.perms || permsOf(s)));
    const why = isMe(s) ? 'You can\'t change your own HQ access. Ask another owner.' : !can('staff.manage') ? 'Only someone who manages the HQ team can change this.'
      : ['owner', 'admin'].includes(s.role) ? 'Only the HQ Owner can change an Owner or an Admin.' : 'Run the latest team-chat.sql to change this here.';
    const m = main(`${teamBack('HQ team')}<h2>${esc(s.display_name)}</h2>
      <p class="sub">${s.email ? `${esc(s.email)} · ` : ''}${s.active ? 'Active' : 'Switched off'} · added ${day(s.added_at)}</p>
      <form id="paf" class="card rl-card" data-pa="${esc(s.user_id)}"><div class="rl-head"><h3>Role and access</h3><span class="rl-status" id="paStatus"></span></div>
        <div class="rl-wrap"><div class="rl-main">
          <label class="f rl-role"><span>Standard role</span><select name="role" id="paRole"${ed ? '' : ' disabled'}>${rolesFor(D, s).map((r) => `<option value="${esc(r.key)}"${r.key === role ? ' selected' : ''}>${esc(r.name)}${r.builtin ? '' : ' (custom)'}</option>`).join('')}</select></label>
          <p class="muted small" id="paIntro"></p><div id="paList"></div>
          ${ed ? `<div class="rl-acts"><button class="btn p" id="paSave">Save ${esc(who)}'s access</button><button type="button" class="btn" id="paCancel">Cancel</button>
            ${D.fresh ? '<button type="button" class="lnk" id="paAsRole">Save these ticks as a new role…</button>' : ''}</div>` : `<p class="muted small rl-ro">${esc(why)}</p>`}
        </div><aside class="rl-sum" id="paSum" aria-live="polite"></aside></div></form>`);
    const base = () => new Set(roleOf(role).perms);
    const isCustom = () => role !== 'owner' && !sameSet([...sel], [...base()]);
    const status = () => { const r = roleOf(role); m.querySelector('#paStatus').innerHTML = `${esc(r.name)}${isCustom() ? ' <span class="pill violet">customised</span>' : ''}${isCustom() && ed ? ' <button type="button" class="lnk" id="paReset">Reset to standard</button>' : ''}`;
      const rs = m.querySelector('#paReset'); if (rs) rs.onclick = () => { sel = base(); draw(); };
      m.querySelector('#paSum').innerHTML = permSummary(sel, `${who} can…`); };
    const draw = () => {
      const r = roleOf(role);
      if (role === 'owner') { m.querySelector('#paIntro').textContent = ''; m.querySelector('#paList').innerHTML = '<p class="note-ok">Owners can always do everything, including Riyeser\'s billing and bank details. Nothing can be ticked off for an Owner, so HQ always has someone with full access.</p>'; }
      else { m.querySelector('#paIntro').textContent = `The ticks show what ${r.name} can do. Tick or untick for ${who} only: anything different from ${r.name} is marked.`;
        m.querySelector('#paList').innerHTML = permList(sel, { editable: ed }); permRefresh(m, sel, base(), who); }
      status(); };
    draw();
    m.querySelector('#ttBack').onclick = () => { TT.person = null; team(true); };
    if (!ed) return;
    m.querySelector('#paRole').onchange = (e) => { role = e.target.value; sel = new Set(roleOf(role).perms); draw(); };
    m.querySelector('#paList').onchange = (e) => { if (!e.target.matches('input[name=p]')) return; if (e.target.checked) sel.add(e.target.value); else sel.delete(e.target.value); permRefresh(m, sel, base(), who); status(); };
    m.querySelector('#paCancel').onclick = () => { TT.person = null; team(true); };
    m.querySelector('#paf').onsubmit = async (e) => { e.preventDefault();
      try {
        if (D.fresh) await api.setStaffAccess(s.user_id, role, isCustom() ? [...sel] : null);
        else { const b = [...base()]; if (role !== s.role) await api.setStaff(s.user_id, role, s.active); await api.setStaffPerms(s.user_id, [...sel].filter((p) => !b.includes(p)), b.filter((p) => !sel.has(p))); }
        flash(`${s.display_name}'s access saved.`); team(true);
      } catch (err) { alert(plain(err)); } };
    const ar = m.querySelector('#paAsRole'); if (ar) ar.onclick = () => dlg(`<h3>Save these ticks as a new role</h3><p class="muted small">${sel.size} permissions, as ticked for ${esc(who)}. The new role shows under Roles and can be given to anyone.</p>
      <form id="nrf"><label class="f"><span>Name</span><input name="name" required maxlength="40" value="${esc(roleOf(role).name)} (${esc(who)})"></label><label class="f"><span>Description <small class="muted">(optional)</small></span><input name="description" maxlength="300"></label>
      <label class="opt"><input type="checkbox" name="give" checked> Give ${esc(who)} this role</label><div id="nrErr"></div>
      <div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button class="btn p">Save role</button></div></form>`, (d, close) => {
      d.querySelector('#nrf').onsubmit = async (ev) => { ev.preventDefault(); const f = new FormData(ev.target);
        try { const k = await api.roleSave(null, String(f.get('name')), String(f.get('description') || ''), [...sel]); if (f.get('give')) await api.setStaffAccess(s.user_id, k, null);
          close(); flash(`Role "${String(f.get('name')).trim()}" saved.`); team(true); } catch (err) { d.querySelector('#nrErr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
  }

  function rolesTab(D, el) {
    const mng = can('staff.manage') && D.fresh;
    el.innerHTML = `<div class="card"><div class="rl-head"><div><h3>Roles</h3><p class="muted small rl-lead">Built-in roles are templates: view or duplicate them. The Owner can change their ticks, and an Admin can change all of them except Owner and Admin. Make your own with Create a role.</p></div>
        ${mng ? '<button type="button" class="btn p" id="rlNew">+ Create a role</button>' : ''}</div>
      ${D.fresh ? '' : '<p class="muted small">Run the latest <b>team-chat.sql</b> in Supabase (SQL Editor) to make your own roles. See ops/RUNBOOK.md.</p>'}
      <div class="scroll"><table class="tbl" id="roles"><tr><th>Role</th><th>Type</th><th class="n">People</th><th class="n">Permissions</th><th></th></tr>
      ${D.roles.map((r) => `<tr data-rolerow="${esc(r.key)}"><td><b>${esc(r.name)}</b>${r.description ? `<small>${esc(r.description)}</small>` : ''}</td>
        <td>${r.builtin ? '<span class="pill">Built-in</span>' : '<span class="pill blue">Custom</span>'}</td><td class="n">${num(r.people || 0)}</td><td class="n">${r.key === 'owner' ? 'All' : `${r.perms.length} of ${PERMS.length}`}</td>
        <td><div class="row"><button type="button" class="btn sm" data-roleopen="${esc(r.key)}">${mng && roleEditable(r) ? 'Edit' : 'View'}</button>
          ${mng && (r.key !== 'owner' || meOwner()) ? `<button type="button" class="btn sm" data-roledup="${esc(r.key)}">Duplicate</button>` : ''}
          ${mng && !r.builtin ? `<button type="button" class="btn sm" data-roledel="${esc(r.key)}">Remove</button>` : ''}</div></td></tr>`).join('')}</table></div></div>
      <div class="card rl-nevercard" style="margin-top:14px"><h3>Never allowed, for anyone</h3><p class="muted small">No role and no per-person tick can give these, and the database refuses them too.</p>
        <ul>${NEVER.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p class="muted small">Emailing invoices and receipts stays with Finance and the Owner unless the Owner gives it to someone.</p></div>
      <details class="card rl-compare" style="margin-top:14px"><summary><b>Compare roles</b> <small class="muted">· every permission, every role</small></summary>
        <div class="scroll"><table class="tbl small rolegrid"><tr><th>Permission</th>${D.roles.map((r) => `<th>${esc(r.name)}</th>`).join('')}</tr>
        ${PERMS.map(([k, l]) => `<tr><td>${esc(l)}<small class="code">${esc(k)}</small></td>${D.roles.map((r) => `<td>${r.perms.includes(k) ? '✓' : ''}</td>`).join('')}</tr>`).join('')}</table></div>
        <p class="muted small">Support levels: level 1 Support, level 2 Senior / technical (anyone with "Work level 2 tickets"), level 3 Management (anyone with "Work level 3 tickets").</p></details>`;
    const nw = el.querySelector('#rlNew'); if (nw) nw.onclick = () => { TT.role = { key: null }; team(true); };
    el.querySelectorAll('[data-roleopen]').forEach((b) => b.onclick = () => { TT.role = { key: b.dataset.roleopen }; team(true); });
    el.querySelectorAll('[data-roledup]').forEach((b) => b.onclick = () => { TT.role = { key: null, from: b.dataset.roledup }; team(true); });
    el.querySelectorAll('[data-roledel]').forEach((b) => b.onclick = () => roleRemove(D, D.roles.find((r) => r.key === b.dataset.roledel)));
  }

  // Create a role (from nothing, or a copy of another), or view / change one.
  function roleEditor(D, st) {
    const r = st.key ? D.roles.find((x) => x.key === st.key) : null; const src = !r && st.from ? D.roles.find((x) => x.key === st.from) : null;
    const ed = D.fresh && (r ? roleEditable(r) : can('staff.manage'));
    const dropped = src ? src.perms.filter((p) => !canGive(p)) : [];
    let sel = new Set(r ? r.perms : src ? src.perms.filter((p) => canGive(p)) : ['overview.view']);
    const name = r ? r.name : src ? `${src.name} (copy)` : ''; const desc = r ? r.description || '' : src ? src.description || '' : '';
    const why = !D.fresh ? 'Run the latest team-chat.sql to change roles here.' : r && r.key === 'owner' ? 'The Owner role always has every permission, so HQ always has someone with full access. It can\'t be changed.'
      : !can('staff.manage') ? 'Only someone who manages the HQ team can change roles.' : r && r.key === 'admin' ? 'Only the HQ Owner can change the Admin role.' : 'You can\'t change the role you have yourself. Ask the HQ Owner.';
    const title = r ? (ed ? `Edit ${r.name}` : r.name) : 'Create a role';
    const m = main(`${teamBack('Roles')}<h2>${esc(title)}</h2>
      <p class="sub">${r ? `${r.builtin ? 'Built-in role' : 'Custom role'} · ${num(r.people || 0)} ${r.people === 1 ? 'person has' : 'people have'} it${r.people && ed ? ': changes reach them straight away' : ''}.` : 'Choose a name, then tick what people with this role can do. Each one says what it allows.'}</p>
      <form id="rlf" class="card rl-card"><div class="rl-wrap"><div class="rl-main">
        <div class="grid g2"><label class="f"><span>Name</span><input name="name" required maxlength="40" value="${esc(name)}"${!ed || (r && r.builtin) ? ' readonly' : ''}></label>
        <label class="f"><span>Description <small class="muted">(optional)</small></span><input name="description" maxlength="300" value="${esc(desc)}"${ed ? '' : ' readonly'}></label></div>
        ${r && r.builtin && ed ? '<p class="muted small">A built-in role keeps its name. To make a different one, duplicate it.</p>' : ''}
        ${dropped.length ? `<p class="muted small rl-why">Left out of the copy, because you can't give them: ${esc(dropped.map(permLabel).join(', '))}.</p>` : ''}
        <div id="rlList">${permList(sel, { editable: ed && !(r && r.key === 'owner') })}</div>
        ${ed ? `<div class="rl-acts"><button class="btn p" id="rlSave">${r ? 'Save changes' : 'Create role'}</button><button type="button" class="btn" id="rlCancel">Cancel</button>
          ${r && r.builtin && r.standard && !sameSet(r.perms, r.standard) ? '<button type="button" class="lnk" id="rlStd">Back to the standard ticks</button>' : ''}</div>`
          : `<p class="muted small rl-ro">${esc(why)}</p>${can('staff.manage') && D.fresh && r && (r.key !== 'owner' || meOwner()) ? '<button type="button" class="btn" id="rlDup">Duplicate this role</button>' : ''}`}
      </div><aside class="rl-sum" id="rlSum" aria-live="polite"></aside></div></form>`);
    const refresh = () => { permRefresh(m, sel, null, ''); m.querySelector('#rlSum').innerHTML = permSummary(sel, 'People with this role can…'); };
    refresh();
    m.querySelector('#ttBack').onclick = () => { TT.role = null; TT.tab = 'roles'; team(true); };
    const dp = m.querySelector('#rlDup'); if (dp) dp.onclick = () => { TT.role = { key: null, from: r.key }; team(true); };
    if (!ed) return;
    m.querySelector('#rlList').onchange = (e) => { if (!e.target.matches('input[name=p]')) return; if (e.target.checked) sel.add(e.target.value); else sel.delete(e.target.value); refresh(); };
    m.querySelector('#rlCancel').onclick = () => { TT.role = null; TT.tab = 'roles'; team(true); };
    const sd = m.querySelector('#rlStd'); if (sd) sd.onclick = () => { sel = new Set(r.standard); m.querySelector('#rlList').innerHTML = permList(sel, { editable: true }); refresh(); };
    m.querySelector('#rlf').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target);
      try { await api.roleSave(r ? r.key : null, String(f.get('name')), String(f.get('description') || ''), [...sel]);
        flash(r ? `${String(f.get('name')).trim()} saved.` : `Role "${String(f.get('name')).trim()}" created.`); TT.role = null; TT.tab = 'roles'; team(true); } catch (err) { alert(plain(err)); } };
  }

  // Removing a role that people still have asks where to move them (they get that role's standard ticks).
  function roleRemove(D, r) {
    const to = D.roles.filter((x) => x.key !== r.key && (meOwner() || !['owner', 'admin'].includes(x.key)));
    dlg(`<h3>Remove the ${esc(r.name)} role?</h3>${r.people ? `<p>${r.people === 1 ? '1 person still has' : `${num(r.people)} people still have`} this role. Where should ${r.people === 1 ? 'they' : 'they all'} move?</p>
      <label class="f"><span>Move them to</span><select id="rmTo">${to.map((x) => `<option value="${esc(x.key)}"${x.key === 'support' ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <p class="muted small">They get that role's standard ticks. Each move goes in the HQ history.</p>` : '<p class="muted small">Nobody has this role. Removing it goes in the HQ history.</p>'}
      <div id="rmErr"></div><div class="mfoot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn p" id="rmGo">Remove role</button></div>`, (d, close) => {
      d.querySelector('#rmGo').onclick = async () => { try { const n = await api.roleDelete(r.key, r.people ? d.querySelector('#rmTo').value : null); close();
        flash(n ? `${r.name} removed. ${n === 1 ? '1 person' : `${n} people`} moved.` : `${r.name} removed.`); team(true); } catch (err) { d.querySelector('#rmErr').innerHTML = `<div class="err">${esc(plain(err))}</div>`; } }; });
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
        ${box('rRevenue', 'Monthly estimate by month', `now about ${money(r.monthly_now)} a month`, columnChart(rev, (x) => moLabel(x.month), (x) => Number(x.estimate), 'US dollars (estimate)')
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

  // ------------------------------------------------------------------ Website traffic (reports.view): riyeser.com visits, from hq_traffic
  const TR_RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '12 months'], ['custom', 'Custom']];
  const TR_DEVICE = { phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop', '': 'Not known' };
  const pageName = (p) => ({ '/': 'Home', '/pricing': 'Pricing', '/programs': 'All programs', '/downloads': 'Downloads', '/help': 'Help Centre', '/terms': 'Terms of use' })[p] || '';
  // One measure over time: a 2px line with a soft area, recessive grid, and a crosshair with the numbers on hover or arrow keys.
  // The SVG stretches to the card; the labels are HTML so they stay readable at any width.
  function lineChart(rows, label, tip) {
    const n = rows.length; const vals = rows.map((r) => Number(r.visits) || 0); const raw = Math.max(1, ...vals);
    const mag = 10 ** Math.floor(Math.log10(raw / 4 || 1)); const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x * 4 >= raw) || mag * 10; const max = step * 4;
    const X = (i) => (n === 1 ? 500 : (i / (n - 1)) * 1000); const Y = (v) => 200 - (v / max) * 200;
    const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const every = Math.max(1, Math.ceil(n / 6));
    return `<div class="lc"><div class="lc-y" aria-hidden="true">${[4, 3, 2, 1, 0].map((k) => `<span style="top:${100 - k * 25}%">${num(step * k)}</span>`).join('')}</div>
      <div class="lc-plot" tabindex="0" role="img" aria-label="Visits chart: ${esc(label(rows[0] || {}))} to ${esc(label(rows[n - 1] || {}))}, highest ${num(raw)}. Arrow keys step through it.">
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">${[1, 2, 3, 4].map((k) => `<line class="g" x1="0" x2="1000" y1="${200 - k * 50}" y2="${200 - k * 50}"/>`).join('')}<line class="base" x1="0" x2="1000" y1="200" y2="200"/>
          ${n ? `<polygon class="area" points="0,200 ${pts} ${X(n - 1)},200"/><polyline class="ln" points="${pts}"/>` : ''}</svg>
        <i class="lc-cross" hidden></i><i class="lc-dot" hidden></i><div class="lc-tip" hidden></div></div>
      <div class="lc-x" aria-hidden="true">${rows.map((r, i) => (i % every === 0 ? `<span style="left:${X(i) / 10}%">${esc(label(r))}</span>` : '')).join('')}</div></div>`;
  }
  function wireLineChart(el, rows, tip) {
    const plot = el.querySelector('.lc-plot'); if (!plot || !rows.length) return; const n = rows.length; const vals = rows.map((r) => Number(r.visits) || 0);
    const max = (() => { const t = el.querySelectorAll('.lc-y span'); return Number(String(t[0].textContent).replace(/[^\d.]/g, '')) || 1; })();
    const cross = plot.querySelector('.lc-cross'); const dot = plot.querySelector('.lc-dot'); const tp = plot.querySelector('.lc-tip'); let at = -1;
    const show = (i) => { at = Math.max(0, Math.min(n - 1, i)); const x = n === 1 ? 50 : (at / (n - 1)) * 100; const y = 100 - (vals[at] / max) * 100;
      cross.hidden = dot.hidden = tp.hidden = false; cross.style.left = dot.style.left = `${x}%`; dot.style.top = `${y}%`; tp.innerHTML = tip(rows[at]);
      tp.style.left = `${x}%`; tp.classList.toggle('flip', x > 70); tp.classList.toggle('mid', x >= 30 && x <= 70); };
    const hide = () => { cross.hidden = dot.hidden = tp.hidden = true; };
    plot.addEventListener('pointermove', (e) => { const r = plot.getBoundingClientRect(); show(Math.round(((e.clientX - r.left) / r.width) * (n - 1))); });
    plot.addEventListener('pointerleave', hide); plot.addEventListener('blur', hide);
    plot.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show(at < 0 ? n - 1 : at + (e.key === 'ArrowRight' ? 1 : -1)); } });
  }
  async function traffic() {
    const t0 = today(); S.tr = S.tr || { r: 30 }; const tr = S.tr;
    const to = tr.r === 'custom' ? (tr.to || t0) : t0; const from = tr.r === 'custom' ? (tr.from || plusDays(t0, -29)) : plusDays(t0, -(tr.r - 1));
    const m = main(`<h2>Website traffic</h2><p class="sub">Visits to riyeser.com: how many, which pages, where visitors come from, and how many go on to sign up and pay.</p>
      <div class="trbar"><div class="chips" id="trr">${TR_RANGES.map(([k, l]) => `<button class="chip${tr.r === k ? ' on' : ''}" data-trr="${k}">${l}</button>`).join('')}</div>
        <span class="muted small" id="trdates">${day(from)} to ${day(to)}</span><button class="btn sm" id="trcsv" disabled>⬇ Export CSV</button></div>
      <form class="card trcustom" id="trc"${tr.r === 'custom' ? '' : ' hidden'}><label class="f"><span>From</span><input type="date" name="from" value="${esc(from)}" max="${esc(t0)}" required></label>
        <label class="f"><span>To</span><input type="date" name="to" value="${esc(to)}" max="${esc(t0)}" required></label><button class="btn p">Show</button></form>
      <div id="trp"><p class="muted">Loading…</p></div>`);
    m.querySelectorAll('[data-trr]').forEach((b) => b.onclick = () => { const k = b.dataset.trr; S.tr = k === 'custom' ? { r: 'custom', from, to } : { r: Number(k) }; traffic(); });
    m.querySelector('#trc').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); const a = String(f.get('from')); const z = String(f.get('to'));
      if (z < a) { alert('Choose a start date before the end date.'); return; } S.tr = { r: 'custom', from: a, to: z }; traffic(); };
    const r = await api.traffic(from, to);
    const V = Number(r.visits || 0); const PV = Number(r.views || 0); const pv = r.prev || {}; const PVV = Number(pv.visits || 0); const PVW = Number(pv.views || 0);
    const ppv = (a, b) => (b ? a / b : 0); const nDays = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1; const span = r.bucket === 'week' ? 'week' : 'day';
    const change = (now, was, dec) => { if (!was) return now ? '<span class="chg">new: none in the previous period</span>' : '<span class="chg">same as the previous period</span>';
      const d = dec ? Math.round((now - was) * 100) / 100 : Math.round(((now - was) / was) * 100); if (!d) return '<span class="chg">same as the previous period</span>';
      return `<span class="chg ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${dec ? Math.abs(d).toFixed(1) : `${Math.abs(d)}%`}</span> <span>vs the previous ${num(nDays)} days</span>`; };
    const fn = r.funnel || {}; const lbl = (x) => new Date(x.d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const steps = [['Website visits', fn.visits, 'every visit in these dates'], ['Saw the pricing page', fn.pricing, `${num(fn.pricing_views)} pricing page views`],
      ['Signed up', fn.signups, 'Riyeser accounts created'], ['Started a free trial', fn.trials, 'new businesses (trials start when a business is set up)'], ['Paid', fn.paid, 'of those new businesses, paying now or before']].map(([l, v, d]) => [l, Number(v || 0), d]);
    const ofPrev = (i) => (i && steps[i - 1][1] ? `${(Math.round((steps[i][1] / steps[i - 1][1]) * 1000) / 10).toLocaleString()}% of the step before` : '');
    const top = Math.max(1, steps[0][1]);
    const list = (rows, name, key = 'visits') => barList(rows.map((x) => ({ l: name(x), v: Number(x[key] || 0) })), (x) => x.l, (x) => x.v);
    const host = (h) => h || 'Direct or unknown';
    const box = (id, title, sub, body, cls = '') => `<div class="card trcard${cls ? ' ' + cls : ''}" id="${id}"><h3>${title}${sub ? ` <small>· ${sub}</small>` : ''}</h3>${body}</div>`;
    const pages = r.pages || []; const camps = r.campaigns || [];
    m.querySelector('#trp').innerHTML = `
      ${V ? '' : '<div class="banner est">No visits recorded in these dates yet. The website counts page views once it\'s published with this release.</div>'}
      <div class="tiles trtiles">${tile('Visits', num(V), change(V, PVV))}${tile('Page views', num(PV), change(PV, PVW))}
        ${tile('Pages per visit', V ? ppv(PV, V).toFixed(1) : '—', V && PVV ? change(ppv(PV, V), ppv(PVW, PVV), true) : '<span class="chg">a visit is one browser tab</span>')}
        ${tile('Signed up', num(fn.signups), V ? `${(Math.round((Number(fn.signups || 0) / V) * 1000) / 10).toLocaleString()}% of visits` : 'Riyeser accounts created')}</div>
      ${box('trChart', `Visits per ${span}`, `${day(from)} to ${day(to)}`, lineChart(r.series || [], lbl), 'wide')}
      <div class="grid g2 trg">
        ${box('trFunnel', 'From a visit to paying', '', `<ol class="fnl">${steps.map(([l, v, d], i) => `<li><div class="fl"><b>${l}</b><small>${esc(d)}</small></div>
          <div class="ft"><i style="width:${Math.max(1.5, (v / top) * 100)}%"></i></div><div class="fv"><b>${num(v)}</b><small>${ofPrev(i)}</small></div></li>`).join('')}</ol>
          <p class="muted small fnote">Visits are counted on the website; sign-ups, trials and payments are accounts and businesses created in these dates. Nothing links a visit to a person, so this compares totals, not individual journeys.</p>`)}
        ${box('trPages', 'Top pages', 'page views', pages.length ? `<div class="scroll"><table class="tbl rtbl"><tr><th>Page</th><th class="n">Views</th><th class="n">Visits</th></tr>
          ${pages.slice(0, 12).map((x) => `<tr><td><span class="pth">${esc(x.path)}</span>${pageName(x.path) ? ` <small class="pn">${esc(pageName(x.path))}</small>` : ''}</td><td class="n">${num(x.views)}</td><td class="n">${num(x.visits)}</td></tr>`).join('')}</table></div>` : '<p class="muted small">Nothing yet.</p>')}</div>
      <h3 class="h3">Where visitors came from</h3><div class="grid g2 trg">
        ${box('trRefs', 'Websites that linked here', 'visits', list((r.referrers || []).slice(0, 10), (x) => host(x.host)))}
        ${box('trCamps', 'Campaigns', 'from utm_ links', camps.length ? `<div class="scroll"><table class="tbl rtbl"><tr><th>Campaign</th><th>Source · medium</th><th class="n">Visits</th></tr>
          ${camps.slice(0, 10).map((x) => `<tr><td>${esc(x.campaign || '—')}</td><td>${esc([x.source, x.medium].filter(Boolean).join(' · ') || '—')}</td><td class="n">${num(x.visits)}</td></tr>`).join('')}</table></div>`
          : '<p class="muted small">No campaign links used in these dates. Add <span class="code">?utm_source=…&amp;utm_campaign=…</span> to links you share to see them here.</p>')}</div>
      <h3 class="h3">Visitors</h3><div class="grid g3 trg">
        ${box('trDev', 'Devices', 'visits', list(r.devices || [], (x) => TR_DEVICE[x.k] || x.k))}
        ${box('trReg', 'Regions', 'from the time zone', list((r.regions || []).slice(0, 8), (x) => x.k || 'Not known'))}
        ${box('trBr', 'Browsers', 'visits', list(r.browsers || [], (x) => x.k || 'Not known'))}</div>
      <p class="privacy trpriv"><b>What's collected:</b> for each page view, the page, the website that linked to it (its name only), any utm_ campaign tags, phone, tablet or desktop, the browser's name, the language and a rough region from the time zone. No cookies, no IP addresses and nothing that follows a person between visits: a visit is one browser tab. Browsers set to Do Not Track or Global Privacy Control aren't counted. Kept 13 months.</p>`;
    wireLineChart(m.querySelector('#trChart'), r.series || [], (x) => `<b>${r.bucket === 'week' ? 'Week of ' : ''}${esc(day(x.d))}</b><span>${num(x.visits)} visits</span><span>${num(x.views)} page views</span>`);
    const csv = m.querySelector('#trcsv'); csv.disabled = false;
    csv.onclick = () => csvFile(`website-traffic-${from}-to-${to}`, ['Section', 'Item', 'Visits', 'Page views'], [
      ['Total', `${from} to ${to}`, V, PV], ['Previous period', `${pv.from || ''} to ${pv.to || ''}`, PVV, PVW],
      ...(r.series || []).map((x) => [r.bucket === 'week' ? 'Week starting' : 'Day', x.d, x.visits, x.views]),
      ...pages.map((x) => ['Page', x.path, x.visits, x.views]), ...(r.referrers || []).map((x) => ['Came from', host(x.host), x.visits, '']),
      ...camps.map((x) => ['Campaign', [x.campaign, x.source, x.medium].map((y) => y || '-').join(' / '), x.visits, '']),
      ...(r.devices || []).map((x) => ['Device', TR_DEVICE[x.k] || x.k, x.visits, '']), ...(r.regions || []).map((x) => ['Region', x.k || 'Not known', x.visits, '']),
      ...(r.browsers || []).map((x) => ['Browser', x.k || 'Not known', x.visits, '']), ...steps.map(([l, v]) => ['Funnel', l, v, ''])]);
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

  // ------------------------------------------------------------------ HQ V2 (prototype, only with ?v2=1)
  // Loads hq-v2.js and hq-v2.css next to this file (same version stamp). If they can't load, the current layout is used.
  function loadV2() {
    const url = (f) => { try { const u = new URL(f, SELF || location.href); u.search = SELF ? new URL(SELF).search : ''; return u.href; } catch { return f; } };
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = url('hq-v2.css'); document.head.appendChild(css);
    return new Promise((ok) => { const js = document.createElement('script'); js.src = url('hq-v2.js'); js.onload = ok; js.onerror = ok; document.head.appendChild(js); });
  }
  // What the V2 layout may use: the same api, permissions and pages as the current HQ (nothing extra on the server).
  const v2ctx = () => ({ api, S, can, DEMO, esc, num, money, day, ago, plain, missing, main, go, closePanel, badges, loadMe, roleName, initials, ROLES, PERMS, ROLE_PERMS,
    MODULES, PRODUCTS, ghRun, whenFull, tabs: TABS, views: VIEWS(), companyPage, openCompany, permsOf, assignedTo, assignedHtml, canAssign, assignToMe,
    signOut: (scope) => signOutNow(scope),
    remount: () => { S.v2 = null; shell(); } });

  window.RiyeserHQ = { state: S, demo: DEMO, openCompany };
  start();
})();
