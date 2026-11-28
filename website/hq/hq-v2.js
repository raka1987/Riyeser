/* Riyeser HQ V2: a PROTOTYPE of the new layout (Phase 0 of the HQ V2 plan). Only loaded with ?v2=1 (hq.js loadV2);
   ?v2=0 goes back to the current layout. It uses the same api, permissions and pages as the current HQ and adds nothing
   on the server: pages that already exist open inside the new frame; Overview, My work queue, Integrations and
   Security & access are new views over data HQ already has; every other page says "Not built yet — planned in Phase N".
   Rules kept here: every number says where it comes from and how fresh it is; anything HQ can't see is "Unknown", never
   healthy or zero; the database still checks every action (hq_need), the menu only hides what a role can't open. */
(() => {
  'use strict';
  let X = null;            // the context from hq.js (api, S, can, views, …)
  const V = {};
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* not remembered */ } } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = (t) => new Date(t).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(/\s?([ap])\.?m\.?/i, ' $1m').toLowerCase();

  // The Riyeser wordmark (the same drawing as assets/logo-wordmark on feat/logo-desk): letters in the text colour, swoosh in blue.
  const WM_SW = 'M2 29C62 15 172 8 266 11C178 15 78 23 7 41Z';
  const WM_WORD = 'M-0.3 0H20L23.7 -22.8H33.2L40.3 0H61L52.1 -27.1C60 -31.3 65.2 -38.3 66.7 -47.4C69.2 -62.9 60 -72.8 42.6 -72.8H11.7ZM26.4 -38.5 29.3 -56.2H38.4C44.5 -56.2 47.8 -52.7 46.9 -47.4C46 -42 41.5 -38.5 35.4 -38.5ZM65 0H84.6L93.1 -51.6H73.6ZM84 -55.8C89.6 -55.8 94.7 -60 95.6 -65.3C96.5 -70.7 92.8 -74.9 87.2 -74.9C81.5 -74.9 76.5 -70.7 75.6 -65.3C74.7 -60 78.4 -55.8 84 -55.8ZM90.1 20.4H103.4C112.7 20.4 118.2 16.6 123.6 6.5L155 -51.6H134.1L123.8 -29.7C122.2 -26.4 120.7 -23 119.2 -19.6C118.9 -23 118.5 -26.4 118.1 -29.7L115.2 -51.6H95.7L106.9 0L106.5 0.8C104.7 4.3 104 5.6 100.4 5.6H92.6ZM176 1.2C191.1 1.2 200.6 -6.2 204.3 -17.6H186.5C185.5 -14.5 183 -12.5 177.6 -12.5C171.5 -12.5 169.8 -15.1 169.8 -19.6C192.2 -19.9 206.2 -21.8 206.2 -35.6C206.2 -47.4 196 -52.7 183.6 -52.7C166.7 -52.7 154.1 -42.7 151.3 -25.8C148.4 -8.1 158.4 1.2 176 1.2ZM171.2 -31.1C172.2 -35.4 174.5 -39 181.5 -39C185.9 -39 188.4 -37.6 188.4 -35.4C188.4 -33 185.7 -31.5 171.2 -31.1ZM231.1 1.3C247.3 1.3 259 -7.3 259 -18.6C259 -25.5 254.4 -29.4 244.5 -31.2L233.8 -33C231.4 -33.4 230.3 -34.3 230.3 -35.7C230.3 -38 233.1 -39.7 236.8 -39.7C240.7 -39.7 242.9 -37.7 242.6 -34.4H260.4C260.5 -35.3 260.6 -36.3 260.6 -37.1C260.6 -46.6 251.7 -52.6 237.4 -52.6C221.5 -52.6 210.5 -44.9 210.5 -33.6C210.5 -26.3 215.5 -21.5 224.9 -20L234.3 -18.4C237.5 -17.9 238.8 -17 238.8 -15.5C238.8 -13.3 235.8 -11.7 231.9 -11.7C227.8 -11.7 225.5 -13.5 225.6 -16.8H206.5V-16.4C206.5 -5.6 216.6 1.3 231.1 1.3ZM287.5 1.2C302.6 1.2 312.1 -6.2 315.9 -17.6H298C297.1 -14.5 294.5 -12.5 289.2 -12.5C283 -12.5 281.3 -15.1 281.3 -19.6C303.8 -19.9 317.7 -21.8 317.7 -35.6C317.7 -47.4 307.5 -52.7 295.1 -52.7C278.2 -52.7 265.6 -42.7 262.8 -25.8C259.9 -8.1 270 1.2 287.5 1.2ZM282.8 -31.1C283.7 -35.4 286 -39 293.1 -39C297.5 -39 300 -37.6 300 -35.4C300 -33 297.2 -31.5 282.8 -31.1ZM317.7 0H337.3L341.4 -24.7C342.5 -31.6 347.1 -35.9 353.2 -35.9H360.3L362.9 -51.6H358C350.9 -51.6 346.8 -49.1 343.8 -42.2H343.7L345.2 -51.6H326.3ZM369.8 0.9C374.9 0.9 379.6 -3 380.5 -8C381.5 -14.2 377.3 -19.4 371.2 -19.4C366.1 -19.4 361.4 -15.5 360.5 -10.5C359.5 -4.2 363.7 0.9 369.8 0.9Z';
  const wordmark = () => `<svg class="wm2" viewBox="-3 -78 388 121" aria-hidden="true" focusable="false"><path class="wm2-sw" d="${WM_SW}"/><path fill="currentColor" d="${WM_WORD}"/></svg>`;

  // ------------------------------------------------------------------ the menu: every page, its group, who can open it
  // kind: 'old' = the current HQ page, shown in the new frame; 'v2' = a new view over existing data; 'plan' = not built yet.
  // perm: permissions that open it (one of). For 'old' pages the current HQ's own rule (hq.js TABS) decides.
  const plan = (phase, pri, what, needs, today = []) => ({ phase, pri, what, needs, today });
  const GROUPS = [
    ['workspace', 'Workspace', '🏠', [
      { k: 'overview', t: 'Overview', kind: 'v2', perm: ['overview.view'] },
      { k: 'queue', t: 'My work queue', kind: 'v2', perm: ['overview.view'] },
      { k: 'notifications', t: 'Notifications', kind: 'plan', perm: ['overview.view'], plan: plan(2, 'P1', 'One quiet list of what is waiting for you: tickets assigned to you, approvals, failed payments and service alerts. No pop-ups; you choose what reaches you.', ['A notifications list and per-person delivery choices (neither exists yet)'], [['queue', 'My work queue']]) },
      { k: 'insights', t: 'AI insights', kind: 'plan', perm: ['reports.view'], plan: plan(3, 'P2', 'Suggestions built only from allowed account information, each showing its evidence and how sure it is. Anything that changes an account needs a person to approve it.', ['The account-information contract and data-quality checks (Phase 1–2)', 'Owner decision: whether to use an AI provider, and its cost'], [['reports', 'Reports & analytics']]) },
      { k: 'reports', t: 'Reports & analytics', kind: 'old' }]],
    ['customers', 'Customers', '👥', [
      { k: 'companies', t: 'Customers', kind: 'old' },
      { k: 'signups', t: 'Signups & onboarding', kind: 'old' },
      { k: 'health-scores', t: 'Customer health', kind: 'plan', perm: ['customers.view'], plan: plan(2, 'P1', 'A health score for each business that explains itself: activity, unfinished setup, failed renewals and open tickets. Missing information counts as neutral, never as bad, and a score never suspends anyone.', ['Activity reports from each program (not reported yet; only "last seen" and linked PCs today)', 'Test and demo accounts can now be marked, so they are left out (Administration → Test accounts)'], [['signups', 'Signups & onboarding'], ['inactive', 'Retention']]) },
      { k: 'inactive', t: 'Retention', kind: 'old' },
      { k: 'feedback', t: 'Feedback & requests', kind: 'plan', perm: ['customers.view'], plan: plan(3, 'P2', 'Feature requests and feedback, merged when they repeat, with votes and an owner. Customer names stay private.', ['A requests list linked to tickets (none today); support ratings 1–5 already exist'], [['support', 'Support desk']]) }]],
    ['sales', 'Sales & marketing', '📣', [
      { k: 'campaigns', t: 'Marketing & acquisition', kind: 'plan', perm: ['reports.view'], plan: plan(3, 'P2', 'Which campaigns bring sign-ups and paying customers, and what each customer cost to win (spend ÷ new paying accounts). Unknown sources stay "unknown".', ['Link a website visit to the sign-up it led to, with consent (visits and UTM tags are already counted anonymously, but not linked)', 'Ad spend imports (none today)', 'Owner decision: first-touch or last-touch, and the attribution window'], [['traffic', 'Website traffic']]) },
      { k: 'traffic', t: 'Website traffic', kind: 'old' },
      { k: 'announcements', t: 'Announcements', kind: 'plan', perm: ['customers.view'], plan: plan(3, 'P2', 'Messages to chosen customers (by product, country, plan or stage) by email or inside the programs, with a preview, a test send and approval. Service notices are kept separate from marketing.', ['Email sending set up (the outbox exists; no provider is connected yet)', 'Marketing consent, unsubscribe and bounce handling (none today)'], [['emails', 'Email delivery']]) },
      { k: 'partners', t: 'Partners & referrals', kind: 'plan', perm: ['licences.view'], plan: plan(3, 'P2', 'Resellers and referral codes, commission rules, payouts and reversals for refunds. Partners only ever see their own records.', ['Owner decision: partner terms and commission rates', 'Referral codes at sign-up (none today)'], []) }]],
    ['finance', 'Finance', '💳', [
      { k: 'licences', t: 'Subscriptions & licences', kind: 'old' },
      { k: 'payments', t: 'Invoices & payments', kind: 'old' },
      { k: 'refunds', t: 'Refunds', kind: 'old' },
      { k: 'pricing', t: 'Plans & pricing', kind: 'plan', perm: ['licences.view'], plan: plan(2, 'P1', 'The price list as a versioned record: preview the effect, approve, choose a start date. Existing subscriptions keep the price they agreed to.', ['Today prices are in code (website/prices.mjs and riyeser_price()), all in US dollars; billing only accepts USD', 'Owner decision: whether to add FJD, AUD or NZD price lists (the spec mentions them; not decided)'], [['licences', 'Subscriptions & licences']]) },
      { k: 'profitability', t: 'Profitability', kind: 'plan', perm: ['reports.view'], plan: plan(3, 'P2', 'Revenue against what it costs to run: hosting, storage, AI, phone lines and payment fees, per product. Estimates and unallocated costs are labelled.', ['Cost imports from each provider (none today)', 'Owner to provide: the provider accounts and bills to import', 'Owner decision: how shared costs are split'], [['reports', 'Reports & analytics']]) }]],
    ['products', 'Products', '🧩', [
      { k: 'catalogue', t: 'Product catalogue', kind: 'plan', perm: ['overview.view'], plan: plan(2, 'P1', 'Every Riyeser program with its versions in use, licences, open bugs and incidents in one place.', ['One product list in the database (today it is a list in the code)', 'Versions in use come from linked PCs (already on Overview in the current HQ)'], [['downloads', 'Downloads']]) },
      { k: 'downloads', t: 'Downloads', kind: 'old' },
      { k: 'flags', t: 'Feature controls', kind: 'plan', perm: ['settings.manage'], plan: plan(2, 'P1', 'Turn features on for a test group first, then more customers, and switch them off fast if something goes wrong. A switch can never unlock something a customer hasn’t paid for.', ['A server-side feature switch service (none exists)', 'The programs need to read it (they don’t today)'], []) },
      { k: 'releases', t: 'Releases & bugs', kind: 'plan', perm: ['support.diagnostics', 'support.view'], plan: plan(2, 'P1', 'Bugs linked to the tickets they caused, the version with the fix, and who has updated.', ['Tickets already hold "planned release" and "linked bug" as free text, and a fixed-in version field is ready', 'A bugs and releases list (none today)'], [['support', 'Support desk'], ['downloads', 'Downloads']]) },
      { k: 'devboard', t: 'Developer & incident board', kind: 'plan', perm: ['support.diagnostics'], plan: plan(2, 'P1', 'Triage, reproduce in the sandbox, test, approve the fix, release and tell affected customers. Never raw customer records or secrets.', ['A sandbox with made-up data (Phase 1)', 'Bugs and releases list (above)'], []) }]],
    ['service', 'Customer service', '🎧', [
      { k: 'support', t: 'Support desk', kind: 'old' },
      { k: 'inbox', t: 'Team inbox', kind: 'plan', perm: ['overview.view'], plan: plan(2, 'P1', 'Shared support email and chat with an owner, unread state, templates and handovers. Internal talk linked to a customer or ticket.', ['Incoming support email (none today: customers write from inside the programs)', 'Team handover notes already exist (Overview)'], [['support', 'Support desk']]) },
      { k: 'knowledge', t: 'Knowledge base', kind: 'plan', perm: ['support.view'], plan: plan(3, 'P2', 'Help articles and internal procedures with versions, linked to the tickets they answer. Public and internal kept apart.', ['Public help articles live in the website (help.mjs); there is no internal procedures list'], []) },
      { k: 'incidents', t: 'Incidents', kind: 'plan', perm: ['overview.view'], plan: plan(1, 'P0', 'When a service goes wrong: a timeline, who is on it, which customers are affected and the update on the public status page. Fixing the incident is separate from closing tickets.', ['An incidents list (none today)', 'A public status page (none today)'], [['integrations', 'Integrations'], ['health', 'System health']]) }]],
    ['operations', 'Operations', '🛠️', [
      { k: 'health', t: 'System health', kind: 'old' },
      { k: 'integrations', t: 'Integrations', kind: 'v2', perm: ['ops.view'] },
      { k: 'backups', t: 'Backups & recovery', kind: 'plan', perm: ['settings.manage', 'audit.view'], plan: plan(1, 'P0', 'Each service’s last backup, its last restore test, and how much data and time a recovery could cost. Restores are asked for, approved and practised in a separate place. HQ never browses or downloads the database.', ['Nightly encrypted backups and a monthly restore test already run, and record their results in the database (shown on Integrations)', 'Written recovery targets for each service (not written yet)', 'As Built photos and files aren’t backed up yet', 'Restore requests with approval (none today: a runbook only)'], [['health', 'System health'], ['integrations', 'Integrations']]) },
      { k: 'emails', t: 'Email delivery', kind: 'old' },
      { k: 'automation', t: 'Automation', kind: 'plan', perm: ['settings.manage'], plan: plan(2, 'P1', 'Rules such as "when a trial ends, remind the customer" that are drafted, tested on sample customers, approved and paused. Never twice for the same event.', ['Fixed rules already run hourly or daily (support sweep, inactivity warnings, website traffic)', 'A rule builder with run history (none today)'], []) },
      { k: 'usage', t: 'Usage limits & settings', kind: 'plan', perm: ['settings.manage'], plan: plan(2, 'P1', 'Storage, AI and phone allowances, product defaults and regional settings, each change previewed, approved and reversible. Limits are enforced by the server, with a warning first.', ['HQ settings and storage grants already exist', 'Usage counts per business for AI and phone lines (none today)'], [['settings', 'Settings']]) },
      { k: 'sandbox', t: 'Sandbox & status', kind: 'plan', perm: ['overview.view'], plan: plan(1, 'P0', 'A separate test copy of Riyeser online with made-up businesses for trying releases, and a public status page with approved updates. Test accounts are left out of every business number.', ['A separate staging database (none: there is one live project)', 'Test accounts can be marked already (Administration → Test accounts)', 'Owner to provide: a second Supabase project (cost) and a status page address'], [['integrations', 'Integrations']]) }]],
    ['admin', 'Administration', '⚙️', [
      { k: 'team', t: 'HQ team', kind: 'old' },
      { k: 'security', t: 'Security & access', kind: 'v2', perm: ['overview.view'] },
      { k: 'compliance', t: 'Privacy & compliance', kind: 'plan', perm: ['staff.manage', 'audit.view'], plan: plan(1, 'P0', 'Privacy requests (see, correct, delete) with the requester checked, legal deadlines and a record of every step. Retention dates for each kind of record.', ['A privacy requests list (none today)', 'Owner to arrange: legal advice on each country’s rules'], [['history', 'Audit history']]) },
      { k: 'history', t: 'Audit history', kind: 'old' },
      { k: 'approvals', t: 'Approvals', kind: 'old' },
      { k: 'settings', t: 'Settings', kind: 'old' },
      { k: 'test-accounts', t: 'Test accounts', kind: 'v2', perm: ['test_accounts.manage'] },
      { k: 'states', t: 'Page states', kind: 'v2', perm: ['overview.view'], demoOnly: true }]],
  ];
  const PAGES = GROUPS.flatMap(([gk, gt, gi, items]) => items.map((p) => ({ ...p, group: gk, groupT: gt, icon: gi })));
  const page = (k) => PAGES.find((p) => p.k === k);
  const visible = (p) => !(p.demoOnly && !X.DEMO);
  // Can this person open it? Old pages: exactly the current HQ's rule. Others: the permissions listed.
  const allowed = (p) => (p.kind === 'old' ? X.tabs().some((x) => x[0] === p.k) : X.can(...(p.perm || [])));
  const VIEWS2 = { overview, queue, integrations, security, states, 'test-accounts': testAccounts };

  // ------------------------------------------------------------------ small parts: KPI cards, states, page header
  // A KPI card always says where its number came from and how fresh it is. state: ok | loading | denied | error | unknown | stale | empty
  function kpi(o) {
    const st = o.state || 'ok';
    const val = st === 'loading' ? '<span class="sk sk-v"></span>' : st === 'denied' ? 'No access' : st === 'error' ? 'Couldn’t load' : st === 'unknown' ? 'Unknown' : esc(o.value);
    const foot = st === 'loading' ? '<span class="sk sk-l"></span>' : st === 'denied' ? `Your role doesn’t include ${esc(o.needs || 'this')}.`
      : st === 'error' ? `${esc(o.error || 'The server didn’t answer.')} <button class="lnk2" data-retry>Try again</button>`
        : `${esc(o.source || '')}${o.fresh ? ` · <span class="fr">${esc(o.fresh)}</span>` : ''}`;
    const tag = o.href ? 'a' : 'div';
    return `<${tag} class="k2 s-${st}"${o.href ? ` href="${esc(o.href)}"` : ''}${o.id ? ` id="${esc(o.id)}"` : ''}><div class="k2l">${esc(o.label)}${st === 'stale' ? ' <span class="chip2 warn">Stale</span>' : ''}</div>
      <div class="k2v">${val}</div>${o.detail && !['loading', 'denied', 'error'].includes(st) ? `<div class="k2d">${o.detail}</div>` : ''}<div class="k2s">${foot}</div></${tag}>`;
  }
  // A whole-panel state (empty, loading, error, stale, permission denied, not built).
  function stateBox(kind, title, text, action = '') {
    const icon = { empty: '📭', loading: '⏳', error: '⚠️', stale: '🕘', denied: '🔒', plan: '🧭', unknown: '❔' }[kind] || 'ℹ️';
    return `<div class="st2 st2-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"><span class="st2i" aria-hidden="true">${icon}</span><div><b>${esc(title)}</b><p>${text}</p>${action}</div></div>`;
  }
  const skeletonRows = (n = 4) => `<div class="skt" aria-hidden="true">${Array.from({ length: n }, () => '<span class="sk sk-row"></span>').join('')}</div>`;
  function head(title, sub, actions = '') {
    return `<div class="ph2"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="ph2a">${actions}</div>` : ''}</div>`;
  }
  const loadedAt = (t) => `loaded ${time(t)}`;
  const pill2 = (cls, txt) => `<span class="pill2 ${cls}">${esc(txt)}</span>`;
  const soft = (p) => Promise.resolve(p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e, missing: X.missing(e) }));
  const roleSays = (perm) => ({ 'licences.view': 'billing and licences', 'support.view': 'support tickets', 'customers.view': 'customers', 'emails.view': 'the email outbox',
    'reports.view': 'reports', 'audit.view': 'the HQ history', 'staff.manage': 'managing the HQ team', 'settings.manage': 'HQ settings', 'overview.view': 'the overview',
    'ops.view': 'integrations and backups', 'test_accounts.manage': 'marking test accounts' }[perm] || perm);

  // ------------------------------------------------------------------ the frame
  function mount(ctx) {
    X = ctx; const me = X.S.me; const ini = X.initials(me.name);
    document.body.classList.add('hqv2');
    const closed = JSON.parse(store.get('hq.v2.closed') || '[]'); const rail = store.get('hq.v2.rail') === '1';
    const app = document.getElementById('app');
    app.innerHTML = `<a class="skip2" href="#main">Skip to the page</a>
      <div class="v2${rail ? ' rail' : ''}" id="v2">
      <aside class="side2" id="side2" aria-label="HQ menu"><div class="brand2"><a href="#/overview" class="bl2" aria-label="Riyeser HQ, Overview">${wordmark()}<span class="hq2">HQ</span></a>
          <button type="button" class="ib2 railbtn" id="railBtn" aria-label="${rail ? 'Expand the menu' : 'Collapse the menu'}" title="${rail ? 'Expand the menu' : 'Collapse the menu'}">${rail ? '»' : '«'}</button>
          <button type="button" class="ib2 closebtn" id="closeNav" aria-label="Close the menu">✕</button></div>
        <nav class="nav2" id="nav2">${GROUPS.map(([gk, gt, gi, items]) => { const its = items.map((x) => page(x.k)).filter((p) => visible(p) && allowed(p));   // only what this role can open (like the current HQ)
          const open = !closed.includes(gk); if (!its.length) return '';
          return `<div class="ng2"><button type="button" class="ngh2" data-g="${gk}" aria-expanded="${open}" aria-controls="ng2-${gk}" title="${esc(gt)}"><span class="gi2" aria-hidden="true">${gi}</span><span class="gt2">${esc(gt)}</span><span class="car2" aria-hidden="true">▾</span></button>
            <div class="ngk2" id="ng2-${gk}"${open ? '' : ' hidden'}>${its.map((p) => `<a href="#/${p.k}" class="ni2" data-k="${p.k}"><span class="nt2">${esc(p.t)}</span>${p.kind === 'plan' ? `<span class="tag2" title="Not built yet — planned in Phase ${p.plan.phase}">Phase ${p.plan.phase}</span>` : ''}<span class="tb" data-badge="${p.k}"></span></a>`).join('')}</div></div>`; }).join('')}</nav>
        <div class="sfoot2">Staff only · account information, never customers’ books, payroll, documents, sales, messages or call recordings.<button type="button" class="sout2" data-signout2>Sign out</button></div></aside>
      <div class="scrim2" id="scrim2" hidden></div>
      <div class="col2"><header class="top2"><button type="button" class="ib2 menubtn" id="menuBtn" aria-controls="side2" aria-expanded="false" aria-label="Open the menu">☰</button>
          <a href="#/overview" class="mlogo2" aria-label="Riyeser HQ, Overview">${wordmark()}<span class="hq2">HQ</span></a>
          <form class="search2" id="search2" role="search"><input id="q2" name="q" type="search" autocomplete="off" placeholder="Search customers, Company ID, email… or a page" aria-label="Search customers or pages" aria-controls="sr2" aria-expanded="false"><div class="sr2" id="sr2" role="listbox" hidden></div></form>
          ${X.DEMO ? `<label class="demo2" title="Demo with made-up data. Nothing here is real.">Demo data · acting as <select id="demoAs2" aria-label="Demo staff member">${X.api.staffList().map((s) => `<option value="${esc(s.user_id)}"${s.display_name === me.name ? ' selected' : ''}>${esc(s.display_name)} (${esc(X.roleName(s.role))})</option>`).join('')}</select></label>` : ''}
          <details class="me2"><summary aria-label="${esc(me.name)}: your menu"><span class="av2">${esc(ini)}</span><span class="mn2">${esc(me.name)} · ${esc(X.roleName(me.role))}</span><span class="mcar2" aria-hidden="true">▾</span></summary>
            <div class="mem2"><div class="mwho2"><b>${esc(me.name)}</b><small>${esc(X.roleName(me.role))} · Riyeser HQ</small></div><a href="?v2=0${X.DEMO ? '&demo' : ''}" id="oldHq">Switch back to the current HQ</a><button type="button" id="so2v" data-signout2>Sign out</button><button type="button" data-signout2="global">Sign out of all devices</button></div></details></header>
        <div class="proto2" role="note">Prototype of the new HQ layout. Pages marked “Phase” aren’t built yet. <a href="?v2=0${X.DEMO ? '&demo' : ''}">Back to the current HQ</a></div>
        <main id="main" tabindex="-1"></main></div></div>`;
    wire(app);
    route();
    X.badges();
    return { route };
  }
  function wire(app) {
    const v2 = app.querySelector('#v2'); const side = app.querySelector('#side2'); const scrim = app.querySelector('#scrim2'); const mb = app.querySelector('#menuBtn');
    const drawer = (open) => { v2.classList.toggle('open', open); scrim.hidden = !open; mb.setAttribute('aria-expanded', String(open)); if (open) { const c = side.querySelector('.ni2.on') || side.querySelector('.ni2'); if (c) c.focus(); } };
    V.drawer = drawer;
    mb.onclick = () => drawer(!v2.classList.contains('open')); scrim.onclick = () => drawer(false); app.querySelector('#closeNav').onclick = () => { drawer(false); mb.focus(); };
    app.querySelector('#railBtn').onclick = () => { const r = !v2.classList.contains('rail'); v2.classList.toggle('rail', r); store.set('hq.v2.rail', r ? '1' : null);
      const b = app.querySelector('#railBtn'); b.textContent = r ? '»' : '«'; b.setAttribute('aria-label', r ? 'Expand the menu' : 'Collapse the menu'); b.title = b.getAttribute('aria-label'); };
    app.querySelectorAll('.ngh2').forEach((g) => g.onclick = () => {
      if (v2.classList.contains('rail')) { v2.classList.remove('rail'); store.set('hq.v2.rail', null); app.querySelector('#railBtn').textContent = '«'; }
      const open = g.getAttribute('aria-expanded') !== 'true'; g.setAttribute('aria-expanded', String(open)); app.querySelector('#ng2-' + g.dataset.g).hidden = !open;
      const c = JSON.parse(store.get('hq.v2.closed') || '[]').filter((x) => x !== g.dataset.g); if (!open) c.push(g.dataset.g); store.set('hq.v2.closed', JSON.stringify(c)); });
    app.querySelectorAll('.ni2').forEach((a) => a.addEventListener('click', () => drawer(false)));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && v2.classList.contains('open')) { drawer(false); mb.focus(); } });
    app.querySelectorAll('[data-signout2]').forEach((x) => x.onclick = () => X.signOut(x.dataset.signout2 || 'local'));
    const das = app.querySelector('#demoAs2'); if (das) das.onchange = async () => { X.api.asStaff(das.value); await X.loadMe(); X.closePanel(); X.remount(); };
    if (matchMedia('(max-width: 640px)').matches) app.querySelector('#q2').placeholder = 'Search customers or pages';   // nothing cut off on a phone
    searchBox(app);
  }
  // Top search: pages by name as you type; Enter searches customers (name, Company ID, ABN, phone or email) like the current HQ.
  function searchBox(app) {
    const f = app.querySelector('#search2'); const q = app.querySelector('#q2'); const box = app.querySelector('#sr2'); let sel = -1;
    const items = () => [...box.querySelectorAll('[role=option]')];
    const close = () => { box.hidden = true; q.setAttribute('aria-expanded', 'false'); sel = -1; };
    const show = () => { const t = q.value.trim().toLowerCase(); if (!t) return close();
      const pages = PAGES.filter(visible).filter((p) => allowed(p) && (p.t.toLowerCase().includes(t) || p.groupT.toLowerCase().includes(t))).slice(0, 6);
      box.innerHTML = (X.can('customers.view') ? `<button type="button" role="option" class="sro2" data-cust="1">🔎 Search customers for “${esc(q.value.trim())}”</button>` : '')
        + (pages.length ? `<div class="srh2">Pages</div>${pages.map((p) => `<button type="button" role="option" class="sro2" data-go="${p.k}">${esc(p.t)} <small>${esc(p.groupT)}${p.kind === 'plan' ? ` · Phase ${p.plan.phase}` : ''}</small></button>`).join('')}` : '');
      box.hidden = !box.innerHTML; q.setAttribute('aria-expanded', String(!box.hidden)); sel = -1;
      items().forEach((b) => b.onmousedown = (e) => { e.preventDefault(); pick(b); }); };
    const pick = (b) => { if (b.dataset.go) { close(); q.value = ''; X.go('#/' + b.dataset.go); } else f.requestSubmit(); };
    q.oninput = show; q.onblur = () => setTimeout(close, 150);
    q.onkeydown = (e) => { const it = items(); if (!it.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + it.length) % it.length; it.forEach((x, i) => x.classList.toggle('on', i === sel)); }
      else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); pick(it[sel]); } else if (e.key === 'Escape') close(); };
    f.onsubmit = (e) => { e.preventDefault(); const t = q.value.trim(); close(); if (!t) return;
      if (!X.can('customers.view')) { const p = PAGES.find((x) => allowed(x) && x.t.toLowerCase().includes(t.toLowerCase())); if (p) X.go('#/' + p.k); return; }
      X.S.cl = { ...(X.S.cl || { f: {}, sort: 'created', desc: true, view: 'all' }), q: t, page: 1 }; q.value = ''; X.go('#/companies'); };
  }

  // ------------------------------------------------------------------ routing: the current HQ's addresses all still work
  function mark(k) {
    const p = page(k);
    document.querySelectorAll('#nav2 .ni2').forEach((a) => { const on = a.dataset.k === k; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    document.querySelectorAll('#nav2 .ngh2').forEach((g) => g.classList.toggle('cur', !!p && p.group === g.dataset.g));
    if (p) { const g = document.getElementById('ng2-' + p.group); const h = document.querySelector(`.ngh2[data-g="${p.group}"]`); if (g && g.hidden) { g.hidden = false; h.setAttribute('aria-expanded', 'true'); } }
    document.title = `${p ? p.t : 'Customer'} · Riyeser HQ`;
  }
  function route() {
    const m = document.getElementById('main'); if (!m || !X) return;
    if (V.drawer) V.drawer(false);
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const cm = /^company\/([^/]+)(?:\/([a-z]+))?/.exec(h);
    if (cm) { mark('companies'); X.closePanel();
      if (!X.can('customers.view')) return denied(page('companies'));
      X.companyPage(cm[1], cm[2]).catch(showErr); return; }
    let k = h.split('/')[0] || 'overview'; if (!page(k) || !visible(page(k))) k = 'overview';
    const p = page(k); mark(k); X.closePanel(); window.scrollTo(0, 0);
    if (!allowed(p)) return denied(p);
    if (p.kind === 'old') { X.S.tab = k; return X.views[k]().catch(showErr); }
    if (p.kind === 'plan') return notBuilt(p);
    VIEWS2[k]().catch(showErr);
  }
  const main = (html) => { const m = document.getElementById('main'); m.className = 'm2'; m.innerHTML = html; return m; };
  function showErr(err) {
    const m = document.getElementById('main'); if (!m) return;
    m.innerHTML = X.missing(err) ? stateBox('unknown', 'This page needs a database update', 'Run the latest <b>team-chat.sql</b> in Supabase (SQL Editor) to switch it on.')
      : stateBox('error', 'Couldn’t load this page', esc(X.plain(err)), '<button class="btn2" id="again">Try again</button>');
    const a = m.querySelector('#again'); if (a) a.onclick = route;
  }
  function denied(p) {
    main(`${head(p.t, '')}${stateBox('denied', 'You don’t have access to this page', `Your HQ role (${esc(X.roleName(X.S.me.role))}) doesn’t include ${esc(p.kind === 'old' ? 'this page' : (p.perm || []).map(roleSays).join(' or '))}. An HQ owner can change permissions in <b>HQ team</b>. The database checks this too, so hiding the menu item isn’t the only lock.`)}`);
  }
  function notBuilt(p) {
    const P = p.plan;
    main(`${head(p.t, `${esc(p.groupT)} · priority ${esc(P.pri)} (${P.pri === 'P0' ? 'launch gate' : P.pri === 'P1' ? 'core operations' : 'growth'})`)}
      ${stateBox('plan', `Not built yet — planned in Phase ${P.phase}`, esc(P.what))}
      <div class="g2c"><section class="card2"><h2>What it needs first</h2><ul class="ul2">${P.needs.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>
        <section class="card2"><h2>Until then</h2>${P.today.length ? `<p class="mut2">These pages already cover part of it:</p><div class="row2">${P.today.filter(([k]) => page(k) && allowed(page(k))).map(([k, t]) => `<a class="btn2" href="#/${k}">${esc(t)}</a>`).join('') || '<span class="mut2">None you can open with your role.</span>'}</div>`
          : '<p class="mut2">Nothing in HQ covers this yet.</p>'}<p class="mut2 sm2">Numbers here will only ever come from real records. Anything HQ can’t see will say “Unknown”.</p></section></div>`);
  }

  // ------------------------------------------------------------------ Overview: real KPIs, each with its source and freshness
  // Test, demo and internal accounts are left out of the figures unless this is ticked (remembered on this browser).
  const inclTest = () => store.get('hq.v2.inclTest') === '1';
  const testSwitch = (id) => `<label class="sw2l"><input type="checkbox" id="${id}"${inclTest() ? ' checked' : ''}> Include test accounts</label>`;
  const wireTestSwitch = (root, id, again) => { const b = root.querySelector('#' + id); if (b) b.onchange = () => { store.set('hq.v2.inclTest', b.checked ? '1' : null); again(); }; };
  async function overview() {
    const t0 = Date.now();
    const cards = (list) => `<div class="kg2">${list.map(kpi).join('')}</div>`;
    const L = (label) => ({ label, state: 'loading' });
    const m = main(`${head('Overview', 'Your business at a glance. Account information only: HQ never sees customers’ books, payroll, documents, sales or messages.', `${testSwitch('incl')}<button class="btn2" id="refresh">↻ Refresh</button>`)}
      <div id="ovk">${cards([L('New sign-ups this week'), L('Monthly recurring revenue'), L('Open support tickets'), L('Trials and renewals ending (7 days)'), L('Failed payments'), L('Payments received (7 days)')])}</div>
      <div class="g2c wide"><section class="card2" id="ovq"><h2>Needs attention</h2>${skeletonRows()}</section>${X.can('ops.view') ? `<section class="card2" id="ovs"><h2>Service status</h2>${skeletonRows(3)}</section>` : ''}</div>
      <section class="card2" id="ovw"><h2>New businesses per week</h2>${skeletonRows(2)}</section>`);
    m.querySelector('#refresh').onclick = overview; wireTestSwitch(m, 'incl', overview);
    const inc = inclTest();
    const [k, wq, att] = await Promise.all([X.api.kpis ? soft(X.api.kpis(inc)) : { ok: false, missing: true, e: new Error('missing') }, soft(X.api.workQueue()), soft(X.api.attention(inc))]);
    if (!document.getElementById('ovk')) return;
    const at = loadedAt(t0); const live = `Live · ${at}`; const K = k.ok ? k.v : null;
    const scope = K ? (K.include_test ? ' (test accounts included)' : `${Number(K.test_accounts) ? ` · ${X.num(K.test_accounts)} test account${Number(K.test_accounts) === 1 ? '' : 's'} left out` : ''}`) : '';
    // each figure: from hq_kpis; null = your role can't see it; an older database (no hq_kpis) says so
    const fig = (label, v, perm, source, detail, href, fmt = X.num) => (!k.ok ? (k.missing ? { label, state: 'unknown', source: 'Needs the latest team-chat.sql (hq_kpis)' } : { label, state: 'error', error: X.plain(k.e) })
      : v == null ? { label, state: 'denied', needs: roleSays(perm) } : { label, value: fmt(v), source: source + scope, fresh: live, detail, href });
    document.getElementById('ovk').innerHTML = cards([
      fig('New sign-ups this week', K && K.new_signups_week, 'customers.view', 'Source: businesses registered since Monday', '', '#/signups'),
      fig('Monthly recurring revenue', K && K.mrr, 'licences.view', 'Source: PayPal subscriptions and paid bank invoices',
        K && K.recurring_count != null ? `US dollars · ${X.num(K.recurring_count)} active subscription${Number(K.recurring_count) === 1 ? '' : 's'} and paid invoices; yearly ÷ 12` : '', '#/licences', X.money),
      fig('Open support tickets', K && K.open_tickets, 'support.view', 'Source: support tickets not resolved', '', '#/support'),
      fig('Trials and renewals ending (7 days)', K && K.renewals_due_7d, 'customers.view', 'Source: program licences (trial end or paid-until date)', '', '#/queue'),
      fig('Failed payments', K && K.failed_payments, 'licences.view', 'Source: PayPal subscriptions in their grace period or stopped', '', '#/payments'),
      fig('Payments received (7 days)', K && K.payments_7d ? K.payments_7d.total : K && K.payments_7d, 'licences.view', 'Source: completed payments',
        K && K.payments_7d ? `${X.num(K.payments_7d.count)} payment${Number(K.payments_7d.count) === 1 ? '' : 's'} · US dollars` : '', '#/payments', X.money)]);
    document.querySelectorAll('#ovk [data-retry]').forEach((b) => b.onclick = (e) => { e.preventDefault(); overview(); });
    // Needs attention: the first items of the work queue (test accounts' items left out unless included)
    const q = ((wq.ok && wq.v && wq.v.queue) || []).filter((x) => inc || !x.account_kind || x.account_kind === 'customer');
    document.getElementById('ovq').innerHTML = `<h2>Needs attention <small>${wq.ok ? `${X.num(q.length)} item${q.length === 1 ? '' : 's'} · ${esc(at)}` : ''}</small></h2>
      ${!wq.ok ? stateBox(wq.missing ? 'unknown' : 'error', wq.missing ? 'Needs a database update' : 'Couldn’t load the work queue', esc(wq.missing ? 'Run the latest team-chat.sql to switch on the work queue.' : X.plain(wq.e)))
        : q.length ? `${queueTable(q.slice(0, 6), true)}<div class="row2 end2"><a class="btn2" href="#/queue">Open My work queue (${X.num(q.length)})</a></div>` : stateBox('empty', 'Nothing needs you right now', 'New items appear here as tickets, approvals, payments and renewals come in.')}`;
    wireQueue(document.getElementById('ovq'), q);
    // Service status: a short version of Integrations (ops.view)
    if (document.getElementById('ovs')) {
      const svc = await services(att);
      if (document.getElementById('ovs')) {
        const n = (...st) => svc.filter((x) => st.includes(x.state)).length;
        document.getElementById('ovs').innerHTML = `<h2>Service status <small>${esc(loadedAt(Date.now()))}</small></h2>
          <ul class="svl2">${svc.slice(0, 6).map((x) => `<li>${statePill(x.state)}<span><b>${esc(x.name)}</b><small>${esc(x.note)}</small></span></li>`).join('')}</ul>
          <p class="mut2 sm2">${n('ok')} healthy · ${n('degraded', 'failed', 'stale')} need a look · ${n('unknown', 'none')} unknown or not monitored. Unknown is never shown as healthy.</p>
          <div class="row2 end2"><a class="btn2" href="#/integrations">All integrations</a></div>`;
      }
    }
    // New businesses per week (a real chart: units, a legend, real values)
    const wk = K ? K.signups_by_week : null;
    if (!document.getElementById('ovw')) return;
    document.getElementById('ovw').innerHTML = `<h2>New businesses per week <small>last 12 weeks · ${esc(at)}</small></h2>${!k.ok ? stateBox(k.missing ? 'unknown' : 'error', k.missing ? 'Needs a database update' : 'Couldn’t load', esc(k.missing ? 'Run the latest team-chat.sql to switch on these figures.' : X.plain(k.e)))
      : wk == null ? stateBox('denied', 'No access', 'Your HQ role doesn’t include customers.') : !wk.length ? stateBox('empty', 'No sign-ups in the last 12 weeks', 'The chart fills in as businesses register.')
        : bars(wk.map((w) => ({ l: new Date(w.week + (String(w.week).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }), v: Number(w.companies) })), 'businesses registered')}
      <p class="mut2 sm2">Source: businesses by the week they registered${esc(scope)}.</p>`;
  }
  function bars(rows, unit) {
    const max = Math.max(1, ...rows.map((r) => r.v));
    return `<figure class="bars2" role="img" aria-label="${esc(rows.map((r) => `${r.l}: ${r.v} ${unit}`).join('; '))}"><div class="bw2">${rows.map((r) => `<div class="bc2"><span class="bv2">${r.v}</span><span class="b2" style="height:${Math.max(2, Math.round((r.v / max) * 100))}%"></span><span class="bl2x">${esc(r.l)}</span></div>`).join('')}</div>
      <figcaption class="lg2"><span class="sw2" aria-hidden="true"></span>${esc(unit)} per week (count)</figcaption></figure>`;
  }
  const ISSUE = { complaint: 'bad', update: 'bad', approval: 'warn', refund: 'warn', payment: 'bad', invoice: 'warn', follow_up: 'blue', renewal: 'blue', signup: '' };
  const PRIO = { complaint: 'High', update: 'High', payment: 'High', approval: 'Medium', invoice: 'Medium', refund: 'Medium', follow_up: 'Normal', renewal: 'Normal', signup: 'Normal' };
  function queueTable(q, short) {
    return `<div class="tw2"><table class="tbl t2"><tr><th>Priority</th><th>Customer</th><th>What</th>${short ? '' : '<th>Assigned to</th><th>When</th>'}<th>Next action</th></tr>
      ${q.map((x, i) => `<tr><td>${pill2(PRIO[x.kind] === 'High' ? 'bad' : PRIO[x.kind] === 'Medium' ? 'warn' : '', PRIO[x.kind] || 'Normal')}</td>
        <td>${x.workspace_id ? `<button class="lnk" data-goco="${esc(x.workspace_id)}"><b>${esc(x.business || 'A business')}</b></button>` : '<b>—</b>'}<small>${esc(x.country || '')}</small></td>
        <td><span class="pill2 ${ISSUE[x.kind] || ''}">${esc(x.issue)}</span><small>${esc(x.detail || '')}</small></td>
        ${short ? '' : `<td>${X.assignedHtml(X.assignedTo(x), X.canAssign(x) && !X.assignedTo(x).who ? `<button class="lnk asgme" data-assignme="${i}">Assign to me</button>` : '')}</td><td class="nowrap">${x.at ? esc(X.ago(x.at)) : ''}</td>`}
        <td><button class="btn2 sm p" data-qi="${i}">${esc(x.action)}</button></td></tr>`).join('')}</table></div>`;
  }
  function wireQueue(root, q) {
    root.querySelectorAll('[data-assignme]').forEach((b) => b.onclick = async () => { b.disabled = true; try { await X.assignToMe(q[Number(b.dataset.assignme)]); queue(); } catch (err) { b.disabled = false; alert(X.plain(err)); } });
    root.querySelectorAll('[data-qi]').forEach((b) => b.onclick = () => { const x = q[Number(b.dataset.qi)];
      if (x.kind === 'complaint' || x.kind === 'update') { X.S.ticket = x.ref; return X.go('#/support'); }
      if (x.kind === 'approval') return X.go('#/approvals');
      if (x.kind === 'refund') return X.go('#/refunds');
      if (x.kind === 'invoice') { X.S.markPaid = x.ref; return X.go('#/payments'); }
      if (x.kind === 'payment') return X.openCompany(x.workspace_id, 'money');
      if (x.kind === 'renewal') return X.openCompany(x.workspace_id, 'programs');
      if (x.kind === 'signup') { X.S.cpAfter = 'message'; return X.openCompany(x.workspace_id, 'conversations'); }
      return X.openCompany(x.workspace_id, 'conversations'); });
  }

  // ------------------------------------------------------------------ My work queue (hq_work_queue: the same list the current Overview shows)
  async function queue() {
    const t0 = Date.now(); const F = V.qf || 'all';
    const m = main(`${head('My work queue', 'Everything waiting for you or your team, most urgent first: tickets, approvals, payments, follow-ups, renewals and stuck sign-ups.', `${testSwitch('inclq')}<button class="btn2" id="refresh">↻ Refresh</button>`)}
      <div id="qk">${`<div class="kg2">${['Waiting in the queue', 'High priority', 'My open tickets', 'Follow-ups due'].map((l) => kpi({ label: l, state: 'loading' })).join('')}</div>`}</div><section class="card2" id="ql">${skeletonRows(6)}</section>`);
    m.querySelector('#refresh').onclick = queue; wireTestSwitch(m, 'inclq', queue);
    const [wq, att] = await Promise.all([soft(X.api.workQueue()), soft(X.api.attention(inclTest()))]);
    if (!document.getElementById('ql')) return;
    if (!wq.ok) { document.getElementById('qk').innerHTML = ''; document.getElementById('ql').innerHTML = stateBox(wq.missing ? 'unknown' : 'error', wq.missing ? 'Needs a database update' : 'Couldn’t load the work queue', esc(wq.missing ? 'Run the latest team-chat.sql to switch on the work queue.' : X.plain(wq.e)), '<button class="btn2" id="again">Try again</button>');
      const a = document.getElementById('again'); if (a) a.onclick = queue; return; }
    const inc = inclTest(); const raw = wq.v.queue || []; const all = raw.filter((x) => inc || !x.account_kind || x.account_kind === 'customer');
    const live = `Live · ${loadedAt(t0)}${raw.length > all.length ? ` · ${raw.length - all.length} test-account item${raw.length - all.length === 1 ? '' : 's'} left out` : ''}`; const a = att.ok ? att.v : {};
    document.getElementById('qk').innerHTML = `<div class="kg2">${[
      kpi({ label: 'Waiting in the queue', value: X.num(all.length), source: 'Source: tickets, approvals, payments, notes, licences, sign-ups', fresh: live }),
      kpi({ label: 'High priority', value: X.num(all.filter((x) => PRIO[x.kind] === 'High').length), detail: 'complaints, overdue updates, failed payments', source: 'Source: the queue below', fresh: live }),
      a.mine == null ? kpi({ label: 'My open tickets', state: 'denied', needs: roleSays('support.view') }) : kpi({ label: 'My open tickets', value: X.num(a.mine), source: 'Source: support tickets assigned to you', fresh: live, href: '#/support' }),
      kpi({ label: 'Follow-ups due', value: X.num(all.filter((x) => x.kind === 'follow_up').length), detail: 'your own notes with a follow-up date', source: 'Source: HQ notes', fresh: live })].join('')}</div>`;
    const kinds = [['all', 'All'], ['tickets', 'Tickets'], ['money', 'Payments & approvals'], ['customers', 'Renewals & sign-ups'], ['follow_up', 'Follow-ups']];
    const of = { tickets: ['complaint', 'update'], money: ['approval', 'refund', 'payment', 'invoice'], customers: ['renewal', 'signup'], follow_up: ['follow_up'] };
    const q = F === 'all' ? all : all.filter((x) => (of[F] || []).includes(x.kind));
    const el = document.getElementById('ql');
    el.innerHTML = `<div class="chips2" role="group" aria-label="Show">${kinds.map(([k, l]) => `<button type="button" class="chip2${F === k ? ' on' : ''}" aria-pressed="${F === k}" data-qf="${k}">${l}</button>`).join('')}</div>
      ${q.length ? queueTable(q, false) : stateBox('empty', F === 'all' ? 'Nothing needs you right now' : 'Nothing of this kind', 'New items appear here as they come in.')}`;
    el.querySelectorAll('[data-qf]').forEach((b) => b.onclick = () => { V.qf = b.dataset.qf; queue(); });
    wireQueue(el, q);
  }

  // ------------------------------------------------------------------ Integrations: what HQ can check today, and honestly what it can't
  const STATE = { ok: ['Healthy', 'ok'], degraded: ['Needs a look', 'warn'], failed: ['Failed', 'bad'], unknown: ['Unknown', 'unk'], none: ['Not monitored yet', 'unk'], stale: ['Stale', 'warn'] };
  const statePill = (s) => { const [l, c] = STATE[s] || [s, '']; return pill2(c, l); };
  async function services(att) {
    const out = [];
    // Backups, restore tests and HQ jobs: what the jobs recorded in the database (hq_ops_runs). Only if nothing is recorded
    // yet (an older database, or before the jobs' next run) does HQ ask GitHub, and says so.
    const runs = X.api.opsRuns ? await soft(X.api.opsRuns()) : null;
    const rec = runs && runs.ok ? runs.v || [] : [];
    const job = async (key, file, name, okWord, maxH) => {
      const r = rec.find((x) => x.job === key);
      if (r) { const when = r.finished_at || r.started_at; const age = (Date.now() - new Date(when)) / 3600e3;
        const state = r.ok === false ? 'failed' : age > maxH ? 'stale' : 'ok';
        return { name, state, note: state === 'failed' ? `Last run failed ${X.ago(when)}${r.last_ok_at ? ` · last good ${X.ago(r.last_ok_at)}` : ' · no good run recorded'}`
          : `${state === 'stale' ? 'Last good run is old: ' : okWord + ': '}${X.ago(when)}`, last: when, url: r.run_url, source: 'Recorded by the job (database)' }; }
      const v = await X.ghRun(file); const age = v.at ? (Date.now() - new Date(v.at)) / 3600e3 : null;
      const state = v.state === 'ok' ? (age != null && age > maxH ? 'stale' : 'ok') : v.state === 'failed' ? 'failed' : v.state === 'running' ? 'ok' : v.state === 'none' ? 'none' : 'unknown';
      return { name, state, note: v.at ? `${state === 'stale' ? 'Last good run is old: ' : okWord + ': '}${X.ago(v.at)}` : (v.note || 'No runs yet'), last: v.at, source: `GitHub (${file}): nothing recorded in the database yet`, url: v.url }; };
    out.push({ name: 'HQ database and sign-in', state: X.DEMO ? 'unknown' : 'ok', note: X.DEMO ? 'Demo: not checked' : 'Answered when this page loaded', last: X.DEMO ? null : new Date().toISOString(), source: 'Supabase (this page’s own requests)' });
    out.push(...await Promise.all([job('backup', 'backup.yml', 'Nightly backups', 'Last backup', 26), job('restore_drill', 'restore-drill.yml', 'Restore test', 'Last restore test', 24 * 35),
      job('hq_jobs', 'hq-jobs.yml', 'HQ jobs (sweeps, email sending)', 'Last run', 2)]));
    if (X.can('emails.view')) {
      const e = await soft(X.api.emails()); const c = e.ok ? e.v.counts || {} : {};
      out.push(!e.ok ? { name: 'Email delivery', state: 'unknown', note: 'Couldn’t read the outbox', source: 'email_outbox' }
        : { name: 'Email delivery', state: (c.failed || 0) + (c.held || 0) ? 'degraded' : (c.queued || 0) && !(c.sent_7d || 0) ? 'unknown' : 'ok',
          note: `${X.num(c.failed || 0)} failed · ${X.num(c.held || 0)} held · ${X.num(c.queued || 0)} waiting${(c.queued || 0) && !(c.sent_7d || 0) ? ' · nothing sent this week (is sending set up?)' : ''}`, last: null, source: 'Email outbox (email_outbox)' });
    } else out.push({ name: 'Email delivery', state: 'unknown', note: 'Your role can’t see the email outbox', source: 'email_outbox' });
    if (X.can('licences.view') && X.api.paypalStatus) {
      const p = await soft(X.api.paypalStatus()); const v = p.ok ? p.v || {} : {};
      out.push({ name: 'Payments (PayPal)', state: !p.ok || v.deployed === false ? 'unknown' : v.ready ? 'ok' : 'degraded', note: !p.ok ? 'Couldn’t check' : v.deployed === false ? 'Payment service not reachable or not deployed' : v.ready ? `Ready (${v.env || 'live'})` : (v.message || 'Not ready'), source: 'PayPal function status' });
    } else out.push({ name: 'Payments (PayPal)', state: 'unknown', note: 'Your role can’t see billing', source: 'PayPal function status' });
    const off = X.api.linkOffline ? await soft(X.api.linkOffline()) : null;
    out.push(!off ? { name: 'Riyeser Link Office (desk phones)', state: 'unknown', note: 'Not reported in this database', source: 'Link Office check-ins' }
      : !off.ok ? { name: 'Riyeser Link Office (desk phones)', state: 'unknown', note: 'Couldn’t check', source: 'Link Office check-ins' }
        : { name: 'Riyeser Link Office (desk phones)', state: (off.v || []).length ? 'degraded' : 'ok', note: (off.v || []).length ? `${off.v.length} office${off.v.length === 1 ? '' : 's'} not checked in` : 'Every office has checked in', source: 'Link Office check-ins' });
    out.push({ name: 'Support and diagnostics', state: att && att.ok && att.v && att.v.overdue != null ? (att.v.overdue ? 'degraded' : 'ok') : 'unknown', note: att && att.ok && att.v && att.v.overdue != null ? `${X.num(att.v.overdue)} ticket${att.v.overdue === 1 ? '' : 's'} past the first-reply time` : 'Your role can’t see tickets', source: 'Support tickets' });
    for (const [name, why] of [['Phone lines (SIP)', 'no SIP provider check'], ['AI services', 'no AI usage or error feed'], ['Push notifications', 'no delivery feed'], ['Customer webhooks (Online API)', 'deliveries are stored, but HQ has no summary yet'],
      ['File storage', 'no storage check'], ['Certificates and domains', 'no expiry check'], ['Provider quotas', 'no quota feed']]) out.push({ name, state: 'none', note: `Not monitored yet: ${why}`, source: '—' });
    return out;
  }
  async function integrations() {
    const t0 = Date.now();
    const m = main(`${head('Integrations', 'Each outside service Riyeser relies on, its last check and what it said. Anything HQ can’t check says “Unknown” or “Not monitored yet”, never “Healthy”.', '<button class="btn2" id="refresh">↻ Check again</button>')}
      <div id="ik"><div class="kg2">${['Healthy', 'Need a look', 'Unknown or not monitored'].map((l) => kpi({ label: l, state: 'loading' })).join('')}</div></div><section class="card2" id="il">${skeletonRows(8)}</section>`);
    m.querySelector('#refresh').onclick = () => { try { Object.keys(sessionStorage).filter((k) => k.startsWith('riyeser.hq.gh.')).forEach((k) => sessionStorage.removeItem(k)); } catch { /* fine */ } integrations(); };
    const att = await soft(X.api.attention()); const svc = await services(att);
    if (!document.getElementById('il')) return;
    const n = (...s) => svc.filter((x) => s.includes(x.state)).length; const fr = `Checked ${time(t0)}`;
    document.getElementById('ik').innerHTML = `<div class="kg2">${kpi({ label: 'Healthy', value: X.num(n('ok')), detail: `of ${svc.length} services`, source: 'Source: the checks below', fresh: fr })}
      ${kpi({ label: 'Need a look', value: X.num(n('degraded', 'failed', 'stale')), detail: 'degraded, failed or stale', source: 'Source: the checks below', fresh: fr })}
      ${kpi({ label: 'Unknown or not monitored', value: X.num(n('unknown', 'none')), detail: 'no check yet, or no access', source: 'Source: the checks below', fresh: fr })}</div>`;
    document.getElementById('il').innerHTML = `<h2>Services <small>${esc(fr)}</small></h2><div class="tw2"><table class="tbl t2"><tr><th>Service</th><th>State</th><th>Last check</th><th>What it said</th><th>Source</th></tr>
      ${svc.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${statePill(s.state)}</td><td class="nowrap">${s.last ? `${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(X.ago(s.last))}</a>` : esc(X.ago(s.last))}` : '<span class="mut2">—</span>'}</td><td>${esc(s.note)}</td><td class="mut2">${esc(s.source)}</td></tr>`).join('')}</table></div>
      <p class="mut2 sm2">Error details are never shown here in full: only counts and short reasons. Retrying a payment job needs its own safe-to-repeat check (Phase 1).</p>`;
  }

  // ------------------------------------------------------------------ Security & access: what exists (roles, two-step sign-in, history) and what doesn't yet
  async function security() {
    const t0 = Date.now();
    const m = main(`${head('Security & access', 'Who can use HQ, what each role can see, and the protections in place. Signing someone out of every device, sign-in alerts and privacy requests are planned for Phase 1.')}
      <div id="sk2"><div class="kg2">${['HQ staff', 'Two-step sign-in', 'HQ sessions', 'Approvals waiting', 'Security alerts'].map((l) => kpi({ label: l, state: 'loading' })).join('')}</div></div>
      <section class="card2" id="sr"><h2>Roles</h2>${skeletonRows(5)}</section>`);
    const [tm, att] = await Promise.all([soft(X.api.team()), soft(X.api.attention())]);
    if (!document.getElementById('sr')) return;
    const live = `Live · ${loadedAt(t0)}`; const staff = tm.ok ? (tm.v.staff || []) : []; const active = staff.filter((s) => s.active);
    const a = att.ok ? att.v : {};
    document.getElementById('sk2').innerHTML = `<div class="kg2">${[
      !tm.ok ? kpi({ label: 'HQ staff', state: 'error', error: X.plain(tm.e) }) : kpi({ label: 'HQ staff', value: X.num(active.length), detail: `${X.num(staff.length - active.length)} switched off`, source: 'Source: HQ team list', fresh: live, href: '#/team' }),
      kpi({ label: 'Two-step sign-in', value: 'Required', detail: 'every HQ action checks it in the database', source: 'Source: database rule (hq_role needs two-step)', fresh: 'always on' }),
      kpi({ label: 'HQ sessions', value: '30 min · 12 h', detail: 'signed out after 30 minutes without activity, and 12 hours after signing in', source: 'Source: database rule (hq_role / hq_touch)', fresh: 'always on' }),
      a.approvals == null ? kpi({ label: 'Approvals waiting', state: 'denied', needs: 'approving refunds or free periods' }) : kpi({ label: 'Approvals waiting', value: X.num(a.approvals), source: 'Source: refunds and free periods', fresh: live, href: '#/approvals' }),
      kpi({ label: 'Security alerts', state: 'unknown', source: 'Not monitored yet: no sign-in alert feed (Phase 1)' })].join('')}</div>`;
    const roles = X.ROLES.map(([r, name]) => ({ r, name, perms: r === 'owner' ? X.PERMS.map((p) => p[0]) : ((tm.ok && tm.v.roles && tm.v.roles[r]) || X.ROLE_PERMS[r] || []), people: active.filter((s) => s.role === r).length }));
    const has = (ps, p) => ps.includes(p);
    const yes = (b) => (b ? '<span class="ck2 y" aria-label="yes">✓</span>' : '<span class="ck2 n" aria-label="no">—</span>');
    const cols = [['customers.view', 'Customers'], ['support.view', 'Tickets'], ['licences.view', 'Billing'], ['licences.manage', 'Change licences'], ['refunds.approve', 'Approve refunds'], ['support.diagnostics', 'Diagnostics'], ['audit.view', 'Audit history'], ['staff.manage', 'Manage staff']];
    document.getElementById('sr').innerHTML = `<h2>Roles and what they can open <small>${esc(live)}</small></h2><div class="tw2"><table class="tbl t2"><tr><th>Role</th><th>People</th>${cols.map(([, l]) => `<th class="c">${l}</th>`).join('')}</tr>
      ${roles.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${tm.ok ? X.num(x.people) : '—'}</td>${cols.map(([p]) => `<td class="c">${yes(has(x.perms, p))}</td>`).join('')}</tr>`).join('')}</table></div>
      <p class="mut2 sm2">Role defaults; an HQ owner can tick extra permissions on or off for one person (HQ team). Only the Owner can change Riyeser’s bank details and make owners or admins; only Finance and the Owner email invoices; no role can see or set a phone password. Staff emails show only to whoever manages the HQ team.</p>`;
    m.insertAdjacentHTML('beforeend', `<div class="g2c"><section class="card2"><h2>In place today</h2><ul class="ul2">
        <li>Two-step sign-in for everyone in HQ, checked by the database on every action.</li><li>HQ signs you out after 30 minutes without activity, and 12 hours after signing in (the database refuses an older session too).</li><li>Every action and every customer page or ticket opened is written to the HQ history, which nobody can change or delete.</li>
        <li>HQ reads account information only: never customers’ books, payroll, documents, POS sales, private messages or call recordings.</li><li>Refunds over the set amount need a second person.</li></ul></section>
      <section class="card2"><h2>Planned for Phase 1</h2>${stateBox('plan', 'Not built yet — planned in Phase 1', 'Sign a staff member out of every device; alerts for unusual sign-ins; a quarterly access review; privacy requests with deadlines.')}</section></div>`);
  }


  // ------------------------------------------------------------------ Test accounts: Riyeser's own businesses, left out of the figures
  const KINDS = [['test', 'Test'], ['demo', 'Demo'], ['internal', 'Internal'], ['customer', 'Customer (real)']];
  async function testAccounts() {
    const t0 = Date.now();
    const m = main(`${head('Test accounts', 'Riyeser’s own test, demo and internal businesses. Overview and My work queue leave them out unless you tick “Include test accounts”. Every change is in the HQ history.')}
      <section class="card2"><h2>Mark a business</h2><form id="tak" class="tak2"><label class="f2"><span>Company ID or name</span><input name="q" required placeholder="e.g. RIY-7K3M-Q2" autocomplete="off"></label>
        <label class="f2"><span>It is</span><select name="kind">${KINDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="f2 grow2"><span>Why</span><input name="reason" required minlength="3" maxlength="200" placeholder="e.g. Our own QA business"></label><button class="btn2 p">Save</button></form><div id="takmsg"></div></section>
      <section class="card2" id="tal">${skeletonRows(4)}</section>`);
    m.querySelector('#tak').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const msg = m.querySelector('#takmsg');
      const q = String(f.get('q') || '').trim(); const kind = String(f.get('kind')); const reason = String(f.get('reason') || '').trim();
      try { const list = await X.api.companies(q, 'all'); const rows = Array.isArray(list) ? list : (list && list.rows) || [];
        const hit = rows.find((c) => String(c.company_code || '').toLowerCase() === q.toLowerCase()) || (rows.length === 1 ? rows[0] : null);
        if (!hit) { msg.innerHTML = stateBox('empty', rows.length ? 'More than one business matches' : 'No business matches', rows.length ? 'Type its Company ID (for example RIY-7K3M-Q2).' : 'Check the Company ID or name.'); return; }
        await X.api.setAccountKind(hit.id, kind, reason); msg.innerHTML = ''; testAccounts(); }
      catch (err) { msg.innerHTML = stateBox('error', 'Couldn’t save', esc(X.plain(err))); } };
    const r = await soft(X.api.testAccounts()); const el = document.getElementById('tal'); if (!el) return;
    if (!r.ok) { el.innerHTML = stateBox(r.missing ? 'unknown' : 'error', r.missing ? 'Needs a database update' : 'Couldn’t load', esc(r.missing ? 'Run the latest team-chat.sql to switch on test accounts.' : X.plain(r.e))); return; }
    const list = r.v || [];
    el.innerHTML = `<h2>Marked accounts <small>${X.num(list.length)} · Live · ${esc(loadedAt(t0))}</small></h2>${list.length ? `<div class="tw2"><table class="tbl t2"><tr><th>Business</th><th>Company ID</th><th>Kind</th><th>Joined Riyeser</th><th></th></tr>
      ${list.map((c) => `<tr><td><button class="lnk" data-goco="${esc(c.id)}"><b>${esc(c.name)}</b></button><small>${esc(c.country || '')}</small></td><td class="nowrap">${esc(c.company_code || '')}</td>
        <td>${pill2('unk', (KINDS.find((x) => x[0] === c.account_kind) || [0, c.account_kind])[1])}</td><td class="nowrap">${esc(X.day(c.created_at))}</td>
        <td><button class="btn2 sm" data-real="${esc(c.id)}" data-code="${esc(c.company_code || '')}" data-name="${esc(c.name)}">Mark as a real customer</button></td></tr>`).join('')}</table></div>`
      : stateBox('empty', 'No test accounts marked', 'Every business counts in the figures. Mark Riyeser’s own test businesses above.')}`;
    // "Mark as a real customer" fills the form above (no pop-up): say why, then Save
    el.querySelectorAll('[data-real]').forEach((b) => b.onclick = () => { const f = m.querySelector('#tak'); f.q.value = b.dataset.code || b.dataset.name; f.kind.value = 'customer';
      f.reason.value = ''; f.reason.focus(); f.scrollIntoView({ block: 'nearest' }); });
  }

  // ------------------------------------------------------------------ Page states (demo only): how every page shows loading, empty, error, stale and no access
  async function states() {
    const now = Date.now();
    main(`${head('Page states', 'How HQ V2 shows each situation, so nothing ever looks healthy or zero when it isn’t known. Demo page: the cards below are examples, not data.')}
      <div class="kg2">${kpi({ label: 'Loaded', value: '42', source: 'Source: example', fresh: `Live · ${loadedAt(now)}` })}${kpi({ label: 'Loading', state: 'loading' })}
        ${kpi({ label: 'Stale', value: '42', state: 'stale', source: 'Source: example', fresh: 'last updated 3 days ago' })}${kpi({ label: 'Unknown', state: 'unknown', source: 'Not reported by the programs yet' })}
        ${kpi({ label: 'Error', state: 'error', error: 'The server didn’t answer.' })}${kpi({ label: 'No access', state: 'denied', needs: 'billing and licences' })}</div>
      <div class="g2c">${stateBox('empty', 'Empty', 'Nothing here yet. New items appear as they come in.')}${stateBox('loading', 'Loading', 'Getting the latest figures…')}
        ${stateBox('error', 'Error', 'Couldn’t load this page: the server didn’t answer.', '<button class="btn2">Try again</button>')}${stateBox('stale', 'Stale', 'These figures are from 3 days ago. The nightly job hasn’t run since.', '<button class="btn2">Check again</button>')}
        ${stateBox('denied', 'No access', 'Your HQ role doesn’t include this page. An HQ owner can change permissions.')}${stateBox('plan', 'Not built yet — planned in Phase 2', 'What it will do, and what it needs first.')}</div>`);
  }

  V.mount = mount;
  window.RiyeserHQv2 = V;
})();
