// Riyeser Central home screen: navy sidebar, a greeting, one card per installed program, recent activity, shortcuts.
// Shows only what this customer has: sidebar entries, tiles, quick links and panels appear only for programs that are
// installed on this PC. Anything else is listed under "Get more apps". A program that isn't installed never shows data,
// even if old files from an earlier install are still on the PC.
const $ = (s, el = document) => el.querySelector(s);
const bridge = window.api;
if (bridge && bridge.on) bridge.on('team:title', (t) => { const n = (/^\((\d+)\)\s*Riyeser (?:Link|Team)\b/.exec(t || '') || [])[1];   // "(3) Riyeser Link" ("(3) Riyeser Team" before the rename)
   const el = document.getElementById('teamtag'); if (el) { el.hidden = !n; el.textContent = n || ''; } });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const moneyShort = (n) => `$${Math.round(Number(n || 0)).toLocaleString()}`;
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: 'short' });
const fmtDate = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
const fmtLong = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const isToday = (d) => new Date(d).toDateString() === new Date().toDateString();
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); if (m < 1) return 'Just now'; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h} h ago`; const d = Math.round(h / 24); return d === 1 ? 'Yesterday' : d < 7 ? `${d} days ago` : new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }); };
const short = (p) => p.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, '~');
// A folder as people say it: the last few folders, e.g. "Clients › Acme Plumbing › Invoices".
const folderName = (dir) => { const parts = String(dir || '').split(/[\\/]+/).filter(Boolean); const i = parts.findIndex((x) => /^organised$/i.test(x)); return (i >= 0 ? parts.slice(i + 1).slice(-3) : parts.slice(-1)).join(' › ') || 'Organised'; };
const isPdf = (n) => /\.pdf$/i.test(n);
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4200); }
async function safe(fn) { try { return await fn(); } catch (e) { toast(e.message); return null; } }

// ---------- icons (simple line icons, drawn here so they work offline) ----------
const P = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  book: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h3"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.4 0 4 1.5 4.5 4.3"/>',
  building: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h2a2 2 0 0 1 2 2v10M3 21h18M8 7h4M8 11h4M8 15h4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  pdf: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M9.5 16.5h5M9.5 13h5"/>',
  hat: '<path d="M4 17h16"/><path d="M5.5 17a6.5 6.5 0 0 1 13 0"/><path d="M10 10.8V8h4v2.8"/><path d="M3 17v2h18v-2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  store: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5.5 11.5V20h13v-8.5"/><path d="M10 20v-5h4v5"/>',
  invoice: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8 14h3"/>',
  sort: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 13l2 2 4-4"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  sign: '<path d="M4 20c3-1 4-6 6-6s0 4 2 4 3-3 4-3 1 2 3 2"/><path d="M15 4l5 5-8 8H7v-5z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2"/>',
  check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  alert: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M12 11v4M12 18h.01"/>',
  money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v.01M17.5 14.5v.01"/>',
  bill: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M12 7v8M14.5 8.5c-.5-.7-1.4-1-2.5-1-1.4 0-2.5.7-2.5 1.8 0 2.4 5 1.2 5 3.6 0 1.1-1.1 1.8-2.5 1.8-1.1 0-2-.4-2.5-1.1"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 13.5v6M13.5 16.5h6"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16 6l2 2M14 8l2 2"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17h.01"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  img: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8.5 8.5"/>',
  sheet: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>',
};
const icon = (n, size) => `<svg class="ic" viewBox="0 0 24 24"${size ? ` style="width:${size}px;height:${size}px"` : ''}>${P[n] || P.doc}</svg>`;
const fileIcon = (n) => {
  const [k, c] = isPdf(n) ? ['pdf', '#d6423a'] : /\.(xlsx?|xlsm|csv|ods)$/i.test(n) ? ['sheet', '#16a05a'] : /\.(jpe?g|png|heic|gif|webp)$/i.test(n) ? ['img', '#0f8bb8'] : /\.(docx?|odt|rtf)$/i.test(n) ? ['doc', '#1a5fd6'] : ['doc', 'var(--muted)'];
  return `<span class="fi" style="color:${c}">${icon(k, 18)}</span>`;
};
document.querySelectorAll('[data-ic]').forEach((el) => { el.innerHTML = icon(el.dataset.ic, 18); });

// ---------- light / dark (light is the default, like the website) ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#theme').innerHTML = icon(t === 'dark' ? 'sun' : 'moon', 18);
  $('#theme').title = t === 'dark' ? 'Switch to light' : 'Switch to dark';
}
let theme = 'light';
try { theme = localStorage.getItem('central-theme-2') || 'light'; } catch { /* storage unavailable */ }
applyTheme(theme);
$('#theme').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(theme); try { localStorage.setItem('central-theme-2', theme); } catch { /* ignore */ } });

function tick() {
  const n = new Date(); const h = n.getHours();
  $('#hello').textContent = h < 12 ? 'Good morning.' : h < 17 ? 'Good afternoon.' : 'Good evening.';
  $('#date').textContent = n.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}
tick(); setInterval(tick, 60000);

// ---------- the programs ----------
// One order everywhere (sidebar, tiles, quick access, Get more apps, updates), the same as riyeser.com.
// Free A to Z (Central first), then paid A to Z, with Riyeser Link Office right after Riyeser Link.
const ORDER = ['central', 'desk', 'invoices', 'pdf', 'accounting-basics', 'accounting', 'bookings', 'estimate', 'team', 'linkoffice', 'payroll', 'pos', 'services'];
const byOrder = (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b);
const LUI = window.RiyeserLicenceUi;
const LOOK = {
  team: { ic: 'chat', c: 'c-team', nav: 'Link', col: '#a21caf', blurb: 'Chat, calls and desk phones' },   // Riyeser Link (program id still "team")
  linkoffice: { ic: 'phone', c: 'c-link', nav: 'Link Office', col: '#0e7490', blurb: 'Your office phone system. Comes with Riyeser Link' },
  invoices: { ic: 'invoice', c: 'c-inv', nav: 'Invoices', col: '#0284c7', blurb: 'Send invoices and get paid' },
  bookings: { ic: 'calendar', c: 'c-book', nav: 'Bookings', col: '#e11d48', blurb: 'Jobs, appointments and tables' },
  estimate: { ic: 'invoice', c: 'c-est', nav: 'Estimate', col: '#ea580c', blurb: 'Measure jobs and quote them' },
  'accounting-basics': { ic: 'book', c: 'c-basics', nav: 'Books', col: '#16a05a', blurb: 'View and manage your accounts' },
  accounting: { ic: 'book', c: 'c-acc', nav: 'Books', col: '#1a5fd6', blurb: 'View and manage your accounts' },
  pos: { ic: 'store', c: 'c-pos', nav: 'POS', col: '#0f8f82', blurb: 'Open the till and ring up sales' },
  payroll: { ic: 'people', c: 'c-pay', nav: 'Payroll', col: '#5b54d6', blurb: 'Run payroll and manage staff' },
  desk: { ic: 'folder', c: 'c-desk', nav: 'Documents', col: '#0e7c86', blurb: 'Scan, file and find documents' },   // Riyeser Documents (was Desk Assistant)
  pdf: { ic: 'pdf', c: 'c-pdf', nav: 'PDF', col: '#d6423a', blurb: 'Fill in, sign and combine PDFs' },
  services: { ic: 'hat', c: 'c-svc', col: '#d98a0b', blurb: 'Keep job records up to date' }, // services: shown by its own name (As Built)
};
let programs = []; let today = null; let upd = { updates: [] }; let updating = false; let view = 'home';
const has = (id) => programs.some((p) => p.id === id && p.status !== 'missing');
const accId = () => (has('accounting') ? 'accounting' : has('accounting-basics') ? 'accounting-basics' : null); // Plus wins when both are there
const hasAcc = () => !!accId();

// Quick access: one-click jobs, each shown only when its program is installed.
// `page` asks the program to open on that screen (programs that don't know the page just open normally).
const QUICK = [
  { p: 'pos', ic: 'store', t: 'Open the till', s: 'Ring up a sale', page: 'pos' },
  { p: 'acc', ic: 'invoice', t: 'New invoice', s: 'Bill a customer', page: 'invoice' },
  { p: 'bookings', ic: 'calendar', t: 'New booking', s: 'Jobs, appointments, tables' },
  { p: 'estimate', ic: 'invoice', t: 'New estimate', s: 'Measure a job and quote it', page: 'estimate' },
  { p: 'invoices', ic: 'invoice', t: 'New invoice', s: 'Bill a customer', page: 'invoice' }, // free Invoices, when Accounting isn't installed
  { p: 'payroll', ic: 'people', t: 'Run payroll', s: 'Timesheets to payslips', page: 'payrun' },
  { p: 'desk', ic: 'folder', t: 'Documents Inbox', s: 'New scans and uploads to file' },
  { p: 'desk', ic: 'search', t: 'Find a document', s: 'Names and text inside scans', act: 'find' },
  { p: 'pdf', ic: 'pdf', t: 'Open a PDF', s: 'Fill in, sign or edit', act: 'pickpdf' },
  { p: 'pdf', ic: 'layers', t: 'Combine PDFs', s: 'Join files into one', page: 'combine' },
  { p: 'services', ic: 'hat', t: null, s: 'Projects, drawings and QA', page: 'projects' }, // titled with the program's name
];
// Each program's own logo (the letter-and-dot set used on riyeser.com and the program icons).
const LOGO = { team: 'team', linkoffice: 'link', invoices: 'invoices', bookings: 'bookings', estimate: 'estimate', 'accounting-basics': 'accounting-basics', accounting: 'accounting-plus', pos: 'pos', payroll: 'payroll', desk: 'desk-assistant', pdf: 'pdf', services: 'services' };
const logo = (p, size = 22) => `<img class="logo-i" src="logos/${p.id === 'services' && /as built/i.test(p.name || '') ? 'as-built' : LOGO[p.id]}.png" alt="" style="width:${size}px;height:${size}px">`;
const quickFor = (q) => (q.p === 'acc' ? accId() : q.p === 'invoices' && hasAcc() ? null : has(q.p) ? q.p : null);

function renderNav() {
  // Riyeser Link has its own Riyeser Link button below, so it isn't listed twice.
  const mine = programs.filter((p) => p.status !== 'missing' && p.id !== 'team' && !(p.id === 'accounting-basics' && has('accounting')));
  const upFor = new Set((upd.updates || []).map((u) => u.id));
  const missing = programs.filter((p) => p.status === 'missing' && !(p.id === 'accounting-basics' && has('accounting'))).length;
  $('#nav').innerHTML = `<button class="${view === 'home' ? 'on' : ''}" data-view="home">${icon('home')}Home</button>
    ${mine.map((p) => `<button data-open="${esc(p.id)}" title="Open ${esc(p.full)}">${icon(LOOK[p.id].ic)}${esc(LOOK[p.id].nav || p.name)}${upFor.has(p.id) ? '<span class="tag">Update</span>' : ''}</button>`).join('')}
    <hr>
    <button data-act="team">${icon('chat')}Riyeser Link<span class="tag" id="teamtag" hidden></span></button>
    <button data-act="find">${icon('search')}Find a file</button>
    ${missing ? `<button class="${view === 'apps' ? 'on' : ''}" data-view="apps">${icon('grid')}Get more apps</button>` : ''}
    <button class="${view === 'company' ? 'on' : ''}" data-view="company">${icon('building')}Company</button>
    ${demoState.on ? '' : `<button data-demo="try" title="Explore every program with made-up data">${icon('layers')}${esc(window.RiyeserDemo.TEXT.tryButton)}</button>`}
    <button data-lic="open">${icon('key')}Licence</button>
    <button data-help="central">${icon('help')}Help</button>
    <button data-act="gethelp" title="Ask Riyeser Support (opens riyeser.com)">${icon('chat')}Get help</button>
    <button data-act="report" title="Tell Riyeser Support about a problem, with this PC's technical details">${icon('alert')}Report an issue</button>`;
}

// ---------- program cards (one per installed program, with real figures when there are any) ----------
const CHEV = '<svg class="ic chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
function cardLine(id) {
  const L = LOOK[id];
  if (id === accId()) {
    const m = today.money;
    if (m && m.found) {
      const overdue = m.receivables.filter((r) => r.overdue).length;
      if (m.receivables.length) return { s: `${money(m.totals.owedToYou)} owed to you${overdue ? ` · ${overdue} overdue` : ''}`, alert: overdue > 0 };
    }
    return { s: L.blurb };
  }
  if (id === 'payroll') { const r = (today.payroll || {}).lastRun; return { s: r ? `Last pay run ${fmtDate(r.pay_date)} · ${r.employees} staff` : L.blurb }; }
  if (id === 'linkoffice') {   // its plan, like the other paid programs: Riyeser Link
    const row = lic && lic.online && (lic.online.rows || []).find((r) => r.id === 'calls');
    return row ? { s: `Riyeser Link · ${row.text}`, alert: row.tone === 'bad' } : { s: L.blurb };
  }
  if (id === 'desk') { if (today.documents) return { s: L.blurb }; const n = today.taskCount ?? today.tasks.length; return { s: n ? `${n} to-do${n === 1 ? '' : 's'} waiting` : L.blurb }; }
  return { s: L.blurb };
}
function renderCards() {
  const mine = programs.filter((p) => p.status !== 'missing' && !(p.id === 'accounting-basics' && has('accounting')));
  const missing = programs.some((p) => p.status === 'missing' && !(p.id === 'accounting-basics' && has('accounting')));
  // Programs on the plan that aren't installed yet: a tile with an Install button (it turns into the normal tile after).
  const want = ((cl && cl.planMissing) || []).map((x) => programs.find((p) => p.id === x.id)).filter((p) => p && LOOK[p.id]);
  $('#cards').hidden = !mine.length && !want.length;
  $('#cards').innerHTML = mine.map((p) => {
    const L = LOOK[p.id]; let c = cardLine(p.id);
    // a paid program's card says where it really stands (S12): paid, free trial, trial ended
    const st = p.id !== 'linkoffice' ? LUI.programStatus(p.id, lic) : null;
    if (st && (st.alert || c.s === L.blurb)) c = { s: st.text, alert: st.alert };
    return `<button class="pcard" data-open="${esc(p.id)}" title="Open ${esc(p.full)}"><span class="pi" style="color:${L.col}">${icon(L.ic, 30)}</span><b>${esc(L.nav || p.name)}</b><span class="ps${c.alert ? ' bad' : ''}">${esc(c.s)}</span>${CHEV}</button>`;
  }).join('') + want.map((p) => {
    const L = LOOK[p.id];
    return `<div class="pcard want"><span class="pi" style="color:${L.col}">${icon(L.ic, 30)}</span><b>${esc(L.nav || p.name)}</b><span class="ps">On your plan, not installed yet</span>
      <div class="instrow" data-instrow="${esc(p.id)}">${installing === p.id ? instProgress() : `<button class="btn sm" data-install="${esc(p.id)}" title="Download and install it now">Install</button>`}</div></div>`;
  }).join('') + (missing ? `<button class="pcard add" data-view="apps"><span class="pi">${icon('plus', 30)}</span><b>Add a program</b><span class="ps">Install more Riyeser apps</span>${CHEV}</button>` : '');
}
function renderQuick() {
  const list = QUICK.map((q) => ({ ...q, id: quickFor(q) })).filter((q) => q.id);
  $('#quickp').hidden = !list.length;
  $('#quick').innerHTML = list.map((q) => `<button class="qa" ${q.act ? `data-act="${q.act}"` : `data-open="${esc(q.id)}" data-page="${esc(q.page || '')}"`}><span class="qi ${LOOK[q.id].c}">${icon(q.ic)}</span><span><b>${esc(q.t || (programs.find((x) => x.id === q.id) || {}).name || '')}</b><small>${esc(q.s)}</small></span></button>`).join('');
}

// ---------- panels ----------
// Recent activity: only real things from installed programs (files opened, overdue invoices, the last pay run).
let actAll = false;
const dayOf = (v) => new Date(`${String(v).slice(0, 10)}T12:00:00`).getTime();
function whenText(t, dateOnly) {
  const d = new Date(t); const y = new Date(); y.setDate(y.getDate() - 1);
  const day = isToday(t) ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return dateOnly ? day : `${day}, ${fmtTime(t)}`;
}
function activityItems() {
  const out = [];
  for (const r of today.recent || []) if (r.when) out.push({ t: r.when, ic: fileIcon(r.name), text: `${esc(r.name)} <span class="lbl">· ${esc(folderName(r.dir))}</span>`, attr: `data-file="${esc(r.path)}" title="${esc(r.path)}"` });
  const m = today.money;
  if (hasAcc() && m && m.found) for (const r of m.receivables.filter((x) => x.overdue)) out.push({ t: dayOf(r.due || r.date), dateOnly: true, ic: `<span class="fi bad">${icon('invoice', 18)}</span>`, text: `Invoice ${esc(r.number)} for ${esc(r.contact)} is overdue · ${money(r.owing)}`, attr: `data-open="${esc(accId())}"` });
  const pr = has('payroll') && today.payroll && today.payroll.lastRun;
  if (pr) out.push({ t: dayOf(pr.pay_date), dateOnly: true, ic: `<span class="fi" style="color:#5b54d6">${icon('people', 18)}</span>`, text: `Pay run for ${pr.employees} staff · ${money(pr.total_net)} net`, attr: 'data-open="payroll"' });
  return out.sort((a, b) => b.t - a.t);
}
function renderActivity() {
  const list = activityItems(); const shown = list.slice(0, actAll ? 30 : 6);
  $('#actall').hidden = list.length <= 6;
  $('#actall').innerHTML = actAll ? 'Show less' : 'View all <span class="chev">›</span>';
  $('#activity').innerHTML = shown.length
    ? shown.map((a) => `<div class="act" ${a.attr}>${a.ic}<span class="grow">${a.text}</span><span class="lbl">${whenText(a.t, a.dateOnly)}</span></div>`).join('')
    : '<div class="empty">Nothing yet — open a program to get started.</div>';
}
function renderMoney() {
  const box = $('#moneyp'); box.hidden = !hasAcc(); // only while an Accounting app is installed
  if (box.hidden) return;
  $('#moneyopen').dataset.open = accId();
  const m = today.money;
  if (!m || !m.found) { $('#money').innerHTML = `<div class="empty">${m && m.error ? `Couldn't read your books: ${esc(m.error)}` : 'No invoices yet. Open Accounting and set up your company to see who owes you here.'}</div>`; return; }
  const rows = m.receivables.slice().sort((a, b) => (b.overdue - a.overdue) || String(a.due || a.date).localeCompare(String(b.due || b.date))).slice(0, 6);
  $('#money').innerHTML = rows.length
    ? `<table class="tbl"><colgroup><col style="width:15%"><col style="width:15%"><col style="width:35%"><col style="width:15%"><col style="width:20%"></colgroup><tr><th>Due</th><th>Reference</th><th>Customer</th><th></th><th class="r">Amount</th></tr>
      ${rows.map((r) => `<tr data-open="${esc(accId())}"><td>${esc(fmtDate(r.due || r.date))}</td><td>${esc(r.number)}</td><td>${esc(r.contact)}</td><td>${r.overdue ? '<span class="bad">Overdue</span>' : ''}</td><td class="r num">${money(r.owing)}</td></tr>`).join('')}</table>`
    : '<div class="empty">Every invoice is paid. 🎉</div>';
}
function renderToday() {
  const box = $('#todayp'); box.hidden = !has('desk') || !!today.documents; // calendars lived in Desk Assistant (not in Riyeser Documents)
  if (box.hidden) return;
  if (!today.calendars) { $('#today').innerHTML = '<div class="empty">Connect a calendar in Desk Assistant → Settings → Calendars to see your meetings here.</div>'; return; }
  $('#today').innerHTML = today.meetings.length ? today.meetings.slice(0, 5).map((m) => `<div class="li"><span class="h">${isToday(m.start) ? (m.allDay ? 'All day' : fmtTime(m.start)) : fmtDay(m.start)}</span><span class="grow">${esc(m.title)}${m.location ? ` <span class="lbl">· ${esc(m.location)}</span>` : ''}</span>${m.link ? `<a href="${esc(m.link)}" target="_blank">Join</a>` : ''}</div>`).join('')
    : '<div class="empty">No meetings today or tomorrow.</div>';
  if (today.meetingErrors.length) $('#today').innerHTML += `<div class="empty warn">Couldn't read: ${esc(today.meetingErrors.join(', '))}</div>`;
}
function renderTodo() {
  const box = $('#todop'); box.hidden = !has('desk') || !!today.documents; // the to-do list belonged to Desk Assistant (not in Riyeser Documents)
  if (box.hidden) return;
  $('#todo').innerHTML = today.tasks.length ? today.tasks.slice(0, 5).map((x) => `<div class="li"><span class="chk"></span><span class="grow">${esc(x.text)}</span>${x.due ? `<span class="lbl warn">${esc(fmtDate(x.due))}</span>` : ''}</div>`).join('')
      + ((today.taskCount ?? today.tasks.length) > 5 ? `<div class="empty" style="padding-top:8px">+ ${(today.taskCount ?? today.tasks.length) - 5} more in Desk Assistant</div>` : '')
    : '<div class="empty">Nothing outstanding.</div>';
}
function renderLayout() {
  const left = !$('#actp').hidden || !$('#moneyp').hidden; const right = !$('#quickp').hidden || !$('#todayp').hidden || !$('#todop').hidden;
  $('.cols').hidden = !left && !right;
  $('.cols').style.gridTemplateColumns = left && right ? '' : '1fr';
  // Nothing installed yet (a fresh install): no numbers, just a welcome and the apps to get.
  const none = !programs.some((p) => p.status !== 'missing');
  $('#getstarted').hidden = !none;
  $('#actp').hidden = none;
  if (none) $('#getstarted').innerHTML = `<div class="ph">Nothing yet — add a program to get started</div><div class="empty" style="font-size:14px">Riyeser Central is your home screen for every Riyeser program. Install the ones you need below; their cards, shortcuts and recent activity then show up here.</div>`;
  $('#appsv').hidden = !(view === 'apps' || (none && view === 'home')) || !$('#results').hidden;
}
function renderApps() {
  const others = programs.filter((p) => p.status === 'missing' && !(p.id === 'accounting-basics' && has('accounting')))
    .map((p) => (p.id === 'accounting' && has('accounting-basics') ? { ...p, name: 'Upgrade to Accounting Plus' } : p));
  $('#apps').innerHTML = others.length ? others.map((p) => `<div class="panel appc">${logo(p, 44)}<div><b>${esc(p.name)}</b><p>${esc(p.desc)}</p>${(() => { const st = LUI.programStatus(p.id, lic); return st ? `<p class="lbl${st.alert ? ' bad' : ''}">${esc(st.text)}</p>` : ''; })()}
      <div class="row instrow" data-instrow="${esc(p.id)}">${installing === p.id ? instProgress() : `<button class="btn" data-install="${esc(p.id)}" title="Download and install it now">Install</button>${p.online ? `<button class="btn s" data-open="${esc(p.id)}">Open online</button>` : ''}<button class="link" data-help="${esc(p.id)}">Learn more</button><button class="link" data-get="${esc(p.id)}" title="Its page on riyeser.com">Download page</button><button class="link" data-locate="${esc(p.id)}" title="Already installed somewhere else? Point me to it">Locate…</button>`}</div></div></div>`).join('')
    : '<div class="lbl">You have every Riyeser program.</div>';
}
function setView(v) {
  view = v; $('#home').hidden = v !== 'home'; $('#appsv').hidden = v !== 'apps'; $('#companyv').hidden = v !== 'company';
  if (v === 'company' && window.RiyeserCompany) window.RiyeserCompany.renderCompany();
  if (v !== 'home' && v !== 'apps' && v !== 'company') return;
  renderNav();
}
async function refresh() {
  [programs, today, cl] = await Promise.all([bridge.call('central:programs'), bridge.call('central:today'), bridge.call('central:checklist').catch(() => cl)]);
  programs.sort((a, b) => byOrder(a.id, b.id));
  renderChecklist(); renderPlanBar();
  renderNav(); renderCards(); renderQuick(); renderActivity(); renderMoney(); renderToday(); renderTodo(); renderLayout(); renderApps();
}

// ---------- install a program from here (no trip to the website) ----------
let installing = null;
const instProgress = () => '<div style="flex:1;min-width:140px"><b class="instmsg" style="font-size:13px">Getting ready…</b><div class="prog"><i class="instbar"></i></div></div>';
/** Install one program with its quiet installer. quiet: no toasts (the plan banner says how it went). true when installed. */
async function installApp(id, { quiet = false, then = true } = {}) {
  if (installing) { if (!quiet) toast('One program is installing already. It won\'t be long.'); return false; }
  const p = programs.find((x) => x.id === id); installing = id;
  document.querySelectorAll(`[data-instrow="${id}"]`).forEach((row) => { row.innerHTML = instProgress(); });
  let ok = false;
  try {
    await bridge.call('central:install', id); ok = true;
    if (!quiet) toast(`${p ? p.full : 'The program'} is installed. It's on your home screen now.`);
  } catch (e) { if (!quiet) toast(e.message); }
  installing = null;
  if (then) await safe(refresh);
  return ok;
}
bridge.on('install-progress', (x) => {
  if (x.id !== installing) return;
  const text = x.stage === 'downloading' ? `Downloading… ${Math.round(x.pct * 100)}%` : x.stage === 'installing' ? 'Installing…' : 'Done';
  const width = `${Math.round((x.stage === 'downloading' ? x.pct : 1) * 100)}%`;
  document.querySelectorAll(`[data-instrow="${x.id}"]`).forEach((row) => {
    const msg = row.querySelector('.instmsg'); const bar = row.querySelector('.instbar');
    if (msg) msg.textContent = text; if (bar) bar.style.width = width;
  });
  if (planRun && planRun.id === x.id) { const bar = $('#planbar .instbar'); if (bar) bar.style.width = width; }
});

// ---------- "Your plan includes Payroll and Bookings. [Install them]" (top of Get more apps) ----------
let planRun = null;   // { id, n, of } while the plan's programs are installing
const andList = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
function renderPlanBar(failed) {
  const box = $('#planbar'); if (!box) return;
  const list = (cl && cl.planMissing) || [];
  if (planRun) return;   // drawn by installPlan while it runs
  if (failed && failed.length) {
    box.hidden = false;
    box.innerHTML = `<span style="font-size:24px">⚠️</span><div class="grow"><b>Couldn't install ${esc(andList(failed))}.</b><div class="lbl">Check your internet and try again.</div></div><button class="go" data-cl="plan">Try again</button>`;
    return;
  }
  box.hidden = !list.length;
  if (list.length) box.innerHTML = `<span style="font-size:24px">📦</span><div class="grow"><b>Your plan includes ${esc(andList(list.map((p) => p.name)))}.</b><div class="lbl">${list.length === 1 ? 'It isn\'t' : 'They aren\'t'} on this PC yet. One click installs ${list.length === 1 ? 'it' : 'them'}.</div></div><button class="go" data-cl="plan">Install ${list.length === 1 ? 'it' : 'them'}</button>`;
}
async function installPlan() {
  if (planRun || installing) { toast('One program is installing already. It won\'t be long.'); return; }
  const list = ((cl && cl.planMissing) || []).slice(); if (!list.length) return;
  const box = $('#planbar'); const failed = [];
  for (let i = 0; i < list.length; i++) {
    planRun = { id: list[i].id, n: i + 1, of: list.length };
    box.hidden = false;
    box.innerHTML = `<span style="font-size:24px">⬇</span><div class="grow"><b>Installing ${esc(list[i].name)}… ${i + 1} of ${list.length}</b><div class="prog"><i class="instbar"></i></div><div class="lbl">You can keep using Central while it installs.</div></div>`;
    if (!(await installApp(list[i].id, { quiet: true, then: false }))) failed.push(list[i].name);
  }
  planRun = null;
  await safe(refresh);
  renderPlanBar(failed);
  toast(failed.length ? `Couldn't install ${andList(failed)}. Check your internet and try again.` : `${andList(list.map((p) => p.name))} ${list.length === 1 ? 'is' : 'are'} installed.`);
}

// ---------- "Getting started with Riyeser": a checklist that ticks itself from your real records ----------
let cl = null;
const CL_BTN = { wizard: 'Sign in', company: 'Check details', apps: 'Install them', team: 'Open Riyeser Link' };
function clAction(it) {
  const a = it.action || {}; const p = programs.find((x) => x.id === a.id); const name = p ? p.name : '';
  if (a.kind === 'wizard') return `<button class="btn sm" data-w="link">${CL_BTN.wizard}</button>`;
  if (a.kind === 'view' && a.view === 'apps') return (cl.planMissing || []).length ? `<button class="btn sm" data-cl="plan">${CL_BTN.apps}</button>` : '<button class="btn sm s" data-view="apps">Get more apps</button>';
  if (a.kind === 'view') return `<button class="btn sm" data-view="${esc(a.view)}">${CL_BTN.company}</button>`;
  if (a.kind === 'team') return `<button class="btn sm" data-act="team">${CL_BTN.team}</button>`;
  if (a.kind === 'open') return `<button class="btn sm" data-open="${esc(a.id)}" data-page="${esc(a.page || '')}">Open ${esc(name)}</button>`;
  if (a.kind === 'install') return `<span class="instrow" data-instrow="${esc(a.id)}">${installing === a.id ? instProgress() : `<button class="btn sm" data-install="${esc(a.id)}">Install ${esc(name || 'it')}</button>`}</span>`;
  return '';
}
function renderChecklist() {
  const box = $('#checklist'); if (!box) return;
  box.hidden = !cl || cl.hidden;
  if (box.hidden) return;
  const head = (right) => `<div class="ph"><span class="grow">Getting started with Riyeser</span>${right}</div>`;
  if (cl.demo) {   // demo mode: practice data, so there's nothing real to tick
    box.className = 'panel cl off';
    box.innerHTML = `${head('<button class="lnk" data-cl="hide">Hide getting started</button>')}<div class="empty">Leave demo mode to start your own checklist.</div>`;
    return;
  }
  if (cl.allDone) {
    box.className = 'panel cl alldone';
    box.innerHTML = `<div class="cldone"><span style="font-size:26px">🎉</span><div class="grow"><b>You're all set up</b><div class="lbl">Everything on your getting-started list is done. Nice work.</div></div><button class="btn s" data-cl="hide">Hide this</button></div>`;
    return;
  }
  box.className = 'panel cl';
  const pct = cl.total ? Math.round((cl.done / cl.total) * 100) : 0;
  box.innerHTML = `${head('<button class="lnk" data-cl="hide">Hide getting started</button>')}
    <div class="clbar"><div class="prog"><i style="width:${pct}%"></i></div><span class="lbl">${cl.done} of ${cl.total} done</span></div>
    <div class="clitems">${cl.items.map((it) => `<div class="cli${it.done ? ' done' : ''}${it.skipped ? ' skipped' : ''}">
      <span class="clchk">${it.done ? '✓' : ''}</span>
      <div class="grow"><b>${esc(it.title)}</b><small>${it.skipped ? 'Skipped' : esc(it.hint)}</small></div>
      ${it.done ? '' : it.skipped ? `<button class="link" data-cl="unskip" data-id="${esc(it.id)}">Undo</button>` : `${clAction(it)}<button class="link" data-cl="skip" data-id="${esc(it.id)}" title="Not for me">Skip</button>`}
    </div>`).join('')}</div>`;
}
async function loadChecklist() {
  try { cl = await bridge.call('central:checklist'); } catch { return; }
  renderChecklist(); renderPlanBar();
  if (today) renderCards();
}
async function setChecklistHidden(hidden) {
  const r = await bridge.call('central:checklistHide', hidden);
  if (cl) cl.hidden = r.hidden;
  renderChecklist();
  const box = $('#sethide'); if (box) box.checked = !r.hidden;
  toast(hidden ? 'Getting started is hidden. You can show it again in Settings.' : 'Getting started is back on your home screen.');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cl]'); if (!b) return;
  const a = b.dataset.cl;
  if (a === 'hide') safe(() => setChecklistHidden(true));
  if (a === 'skip' || a === 'unskip') safe(async () => { await bridge.call('central:checklistSkip', b.dataset.id, a === 'skip'); await loadChecklist(); });
  if (a === 'plan') { $('#qclear').click(); setView('apps'); safe(installPlan); }
});
// Settings (sidebar footer): show "Getting started" again.
$('#setbtn').addEventListener('click', () => { $('#sethide').checked = !(cl && cl.hidden); $('#setdlg').showModal(); });
$('#sethide').addEventListener('change', (e) => safe(() => setChecklistHidden(!e.target.checked)));

// Settings: "Fresh start on this PC". Every Riyeser folder on this PC is renamed away (never deleted), then Central
// restarts at "How would you like to start?". Brought back from "Bring back a fresh start…".
const FRESH_WORDS = 'START FRESH';
const freshDate = (iso) => { try { return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; } };
function freshBox() {
  const body = $('#setdlg .setbody'); if (!body || $('#freshbox')) return;
  const box = document.createElement('div'); box.id = 'freshbox';
  box.style.cssText = 'margin-top:18px;padding:14px 16px;border:1.5px solid var(--bad);border-radius:12px;background:var(--bad-soft)';
  box.innerHTML = `<b class="bad">Fresh start on this PC</b>
    <p style="margin:6px 0 10px;font-size:13px;line-height:1.45">Puts away everything Riyeser has saved on this PC — every program’s records, settings and sign-ins — so Riyeser starts like it’s brand new. <b>Nothing is deleted</b>: it’s all moved to folders named “before fresh start” and today’s date, and can be brought back. Your Riyeser account online isn’t affected.</p>
    <div id="freshstep"><button id="freshgo" style="border:1px solid var(--bad);color:var(--bad);background:var(--panel);border-radius:9px;padding:7px 14px;font-weight:600">Start fresh…</button>
    <button id="freshback" style="border:0;background:none;padding:0 0 0 12px;color:var(--muted);font-size:12.5px;text-decoration:underline">Bring back a fresh start…</button></div>`;
  body.appendChild(box);
}
function freshReset() { const st = $('#freshstep'); if (!st) return; $('#freshbox').remove(); freshBox(); }
// Riyeser Link stays by the clock when its window is closed, so say how to quit it (or Central can close it).
const FRESH_LINK_HINT = '<b>Riyeser Link</b> keeps running by the clock so calls reach you: right-click its icon near the clock and choose Quit, or press <b>Close them for me</b>.';
async function freshStart(note = '') {
  const st = $('#freshstep');
  st.innerHTML = '<span style="font-size:13px">Checking what’s open…</span>';
  const c = await bridge.call('fresh:check');
  if (c.open.length) {
    st.innerHTML = `<p class="bad" style="font-size:13px;margin:0 0 8px"><b>Close these first: ${c.open.map(esc).join(', ')}.</b></p>
      ${c.open.includes('Riyeser Link') ? `<p style="font-size:12.5px;margin:0 0 8px">${FRESH_LINK_HINT}</p>` : ''}
      ${note ? `<p class="bad" style="font-size:12.5px;margin:0 0 8px">${esc(note)}</p>` : ''}
      <button data-fresh="go">Check again</button> <button data-fresh="close">Close them for me</button> <button data-fresh="cancel">Cancel</button>`;
    return;
  }
  st.innerHTML = `<div style="font-size:12.5px;margin-bottom:8px">These will be put away:<ul style="margin:4px 0 0 18px;padding:0">${c.folders.map((f) => `<li>${esc(f.name)} <span style="color:var(--muted)">${esc(short(f.dir))}</span></li>`).join('')}</ul></div>
    <label style="display:block;font-size:13px;margin-bottom:6px">Type <b>${FRESH_WORDS}</b> to go ahead<br><input id="freshtype" autocomplete="off" spellcheck="false" style="margin-top:4px;width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text)"></label>
    <label class="setrow" style="margin:8px 0 10px"><input type="checkbox" id="freshout" checked><span><b>Also sign out of my Riyeser account on this PC</b><small>Untick to stay signed in to Riyeser Central.</small></span></label>
    <button id="freshdo" disabled style="border:0;border-radius:9px;padding:8px 14px;font-weight:600;background:var(--bad);color:#fff">Put it all away and restart</button> <button data-fresh="cancel">Cancel</button>
    <p id="freshmsg" class="bad" style="font-size:13px;margin:8px 0 0" hidden></p>`;
  const type = $('#freshtype'); type.focus();
  type.addEventListener('input', () => { $('#freshdo').disabled = type.value.trim() !== FRESH_WORDS; });
  $('#freshdo').addEventListener('click', () => safe(async () => {
    $('#freshdo').disabled = true;
    const r = await bridge.call('fresh:start', type.value.trim(), $('#freshout').checked);
    if (!r.ok) { const m = $('#freshmsg'); m.hidden = false; m.textContent = r.message; $('#freshdo').disabled = false; return; }
    st.innerHTML = '<p style="font-size:13px;margin:0"><b>All put away.</b> Riyeser Central is restarting like it’s brand new…</p>';
  }));
}
async function freshBringBack() {
  const st = $('#freshstep');
  const c = await bridge.call('fresh:check');
  if (!c.sets.length) { st.innerHTML = '<p style="font-size:13px;margin:0 0 8px">There’s no earlier fresh start on this PC to bring back.</p><button data-fresh="cancel">OK</button>'; return; }
  st.innerHTML = `<div style="font-size:13px;margin-bottom:8px">Bring back what Riyeser had saved before a fresh start. What’s saved now is put away first (in folders named “before bringing back”), so nothing is lost.</div>
    ${c.open.length ? `<p class="bad" style="font-size:13px;margin:0 0 8px"><b>Close these first: ${c.open.map(esc).join(', ')}.</b></p>` : ''}
    ${c.sets.map((s) => `<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--line);font-size:13px"><span class="grow" style="flex:1">${esc(freshDate(s.at))} · ${s.items.length} folder${s.items.length === 1 ? '' : 's'}</span><button data-fresh="restore" data-id="${esc(s.id)}">Bring back</button></div>`).join('')}
    <button data-fresh="cancel" style="margin-top:6px">Cancel</button><p id="freshmsg" class="bad" style="font-size:13px;margin:8px 0 0" hidden></p>`;
}
async function freshRestore(id) {
  if (!(await askConfirm({ title: 'Bring this back?', body: 'What Riyeser has saved now is put away first, and Riyeser Central restarts.', ok: 'Bring it back' }))) return;
  const r = await bridge.call('fresh:bringBack', id);
  if (!r.ok) { const m = $('#freshmsg'); if (m) { m.hidden = false; m.textContent = r.message; } return; }
  $('#freshstep').innerHTML = '<p style="font-size:13px;margin:0"><b>Brought back.</b> Riyeser Central is restarting…</p>';
}
// Settings: Backups (OWNER-BACKUP). "Back up everything…" makes one file with every Riyeser program's data on this PC;
// "Restore everything from a backup…" puts it all back (before-restore copies first) and restarts Central.
function backupBox() {
  const body = $('#setdlg .setbody'); if (!body || $('#backupbox')) return;
  const box = document.createElement('div'); box.id = 'backupbox';
  box.style.cssText = 'margin-top:18px;padding:14px 16px;border:1px solid var(--line);border-radius:12px';
  box.innerHTML = `<b>Backups</b>
    <p style="margin:6px 0 10px;font-size:13px;line-height:1.45">Riyeser backs up every program on this PC once a day (the last 30 are kept) into <b>Documents\\Riyeser</b>, outside the programs, so uninstalling or reinstalling never removes them. Moving to a new PC? Copy that folder (or one backup file) to a USB stick or OneDrive.</p>
    <button data-bk="all">Back up everything…</button> <button data-bk="restore">Restore everything from a backup…</button> <button data-bk="folder">Open the backups folder</button>
    <p id="bkmsg" style="font-size:13px;margin:8px 0 0" hidden></p>`;
  body.appendChild(box);
}
const bkMsg = (t, bad) => { const m = $('#bkmsg'); if (m) { m.hidden = false; m.className = bad ? 'bad' : ''; m.textContent = t; } else toast(t); };
async function restoreEverything() {
  const pick = await bridge.call('backup:pick'); if (!pick) return;
  if (!(await askConfirm({ title: 'Restore from this backup?', body: `${pick.summary}\n\nEvery Riyeser program in it goes back to how it was then. A copy of everything as it is now is saved first ("before restore"). Close the other Riyeser programs; Riyeser Central restarts.`, ok: 'Restore and restart' }))) return;
  const r = await bridge.call('backup:restoreAll', pick.file);
  if (!r.ok) { bkMsg(`${r.message} Then try again.`, true); return; }
  bkMsg('Restoring… Riyeser Central is restarting.');
}
window.RiyeserBackup = { restoreEverything: () => safe(restoreEverything) };
backupBox();
document.addEventListener('click', (e) => {
  const k = e.target.closest('[data-bk]'); if (!k) return;
  if (k.dataset.bk === 'all') safe(async () => { k.disabled = true; try { const r = await bridge.call('backup:all'); bkMsg(`Backed up ${r.parts.length} part${r.parts.length === 1 ? '' : 's'} into ${r.file}`); } finally { k.disabled = false; } });
  if (k.dataset.bk === 'restore') safe(restoreEverything);
  if (k.dataset.bk === 'folder') safe(() => bridge.call('backup:folder'));
});
// after a restore, say how it went (once)
bridge.call('backup:result').then((r) => { if (r) toast(r.ok ? `Restored from your backup. What was here before is saved in ${r.before}` : `The restore didn't work: ${r.error} Nothing was changed.`); }).catch(() => {});

freshBox();
document.addEventListener('click', (e) => {
  if (e.target.closest('#freshgo')) return safe(freshStart);
  if (e.target.closest('#freshback')) return safe(freshBringBack);
  const b = e.target.closest('[data-fresh]'); if (!b) return;
  const a = b.dataset.fresh;
  if (a === 'go') safe(() => freshStart());
  if (a === 'close') safe(async () => {
    b.disabled = true; b.textContent = 'Closing…';
    try { const r = await bridge.call('fresh:close'); await freshStart(r.message || ''); } finally { if (b.isConnected) { b.disabled = false; b.textContent = 'Close them for me'; } }
  });
  if (a === 'cancel') freshReset();
  if (a === 'restore') safe(() => freshRestore(b.dataset.id));
});
$('#setdlg').addEventListener('close', freshReset);

// ---------- updates ----------
function renderUpdates() {
  const box = $('#updates');
  const list = upd.updates || [];
  if (!list.length && !updating) { box.hidden = true; return; }
  box.hidden = false;
  if (updating) return; // progress is drawn by the update-progress events
  box.innerHTML = `<div style="font-size:24px">⬆</div><div class="grow"><b>${list.length === 1 ? 'An update is ready' : `${list.length} updates are ready`}</b>
    <div class="lbl">${list.map((u) => `${esc(u.name)}${u.self ? ' (this app)' : ''} ${esc(u.from)} → ${esc(u.to)}`).join(' · ')}</div></div>
    <button class="go" id="updall">Update ${list.length === 1 ? '' : 'all'}</button>`;
  $('#updall').addEventListener('click', () => safe(async () => {
    updating = true;
    box.innerHTML = '<div style="font-size:24px">⬇</div><div class="grow"><b id="updmsg">Getting ready…</b><div class="prog"><i id="updbar"></i></div><div class="lbl">Your information is kept. Programs being updated will close for a moment.</div></div>';
    try {
      const r = await bridge.call('central:installUpdates', null);
      if (r.restarting) { $('#updmsg').textContent = 'Riyeser Central is restarting to finish updating…'; return; }
      toast(`Updated ${r.done.length} program${r.done.length === 1 ? '' : 's'}.`);
    } catch (e) { toast(e.message); }
    updating = false;
    await checkForUpdates(true);
  }));
}
async function checkForUpdates(force, quiet = true) {
  try { upd = await bridge.call('central:updates', force); } catch (e) { if (!quiet) toast(e.message); return; }
  (upd.updates || []).sort((a, b) => byOrder(a.id, b.id));
  renderUpdates(); renderNav();
  if (!quiet) toast(upd.updates.length ? `${upd.updates.length} update${upd.updates.length === 1 ? '' : 's'} available.` : upd.note || 'Everything is up to date.');
}
bridge.on('update-progress', (p) => {
  const msg = $('#updmsg'); const bar = $('#updbar'); if (!msg) return;
  msg.textContent = p.stage === 'downloading' ? `Downloading ${p.name}… ${Math.round(p.pct * 100)}%` : p.stage === 'installing' ? `Installing ${p.name}…` : `Restarting Riyeser Central…`;
  bar.style.width = `${Math.round((p.stage === 'downloading' ? p.pct : 1) * 100)}%`;
});
$('#checkupd').addEventListener('click', () => checkForUpdates(true, false));

// ---------- demo mode: practice data for Sample Trading Co (%APPDATA%\Riyeser\demo.json) ----------
let demoState = { on: false };
function renderDemo() {
  const bar = $('#demobar'); const html = window.RiyeserDemo.bannerHtml(demoState);
  bar.hidden = !html; bar.innerHTML = html;
  document.body.classList.toggle('demo', !!demoState.on);
}
async function loadDemo() { try { demoState = await bridge.call('demo:get'); } catch { demoState = { on: false }; } renderDemo(); renderNav(); return demoState; }
function demoNote(msg) {
  const box = $('#demonote'); box.hidden = !msg;
  box.innerHTML = msg ? `<span style="font-size:24px">🧪</span><div class="grow"><b>Practice data not put away yet</b><div class="lbl">${esc(msg)}</div></div><button class="go" data-demo="retry">Try again</button>` : '';
}
// A plain yes/no box with real button words (not the browser's OK/Cancel). Resolves true only for the yes button.
function askConfirm({ title, body, ok, cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog'); d.className = 'licdlg askdlg';
    d.innerHTML = `<div class="askbody"><h2>${esc(title)}</h2><p style="white-space:pre-line">${esc(body)}</p>
      <div class="wrow"><button class="btn s" value="no">${esc(cancel)}</button><button class="btn" value="yes">${esc(ok)}</button></div></div>`;
    let answer = false;
    d.addEventListener('click', (e) => { const b = e.target.closest('button[value]'); if (b) { answer = b.value === 'yes'; d.close(); } });
    d.addEventListener('close', () => { d.remove(); resolve(answer); });
    document.body.appendChild(d); d.showModal(); d.querySelector('button[value="no"]').focus();   // Enter on its own never says yes
  });
}
// Demo mode only ever starts here, after "Turn on demo mode?" is answered yes. true when it was turned on.
async function startDemo() {
  const T = window.RiyeserDemo.TEXT;
  if (!(await askConfirm({ title: T.confirmTitle, body: T.confirmBody, ok: T.confirmOk, cancel: T.confirmCancel }))) return false;
  await bridge.call('demo:start', { confirmed: true });
  await loadDemo(); await safe(refresh);
  toast(`Demo mode is on. Open any program to explore ${window.RiyeserDemo.BUSINESS}.`);
  return true;
}
async function leaveDemo(retry) {
  const r = await bridge.call('demo:leave');
  const m = window.RiyeserDemo.leaveMessage(r);
  demoNote(m.ok ? '' : m.text);
  toast(m.ok ? (retry ? 'The practice data is put away.' : m.text) : m.text);
  await loadDemo(); await safe(refresh);
  // never set up a company: offer the normal set-up now
  if (r.neverSetUp && !retry && window.RiyeserCompany) window.RiyeserCompany.offerSetup();
}
window.RiyeserCentralDemo = { startDemo, loadDemo, askConfirm, state: () => demoState };
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-demo]'); if (!b) return;
  const a = b.dataset.demo; const T = window.RiyeserDemo.TEXT;
  if (a === 'try') safe(startDemo);
  if (a === 'leave') safe(async () => { if (await askConfirm({ title: 'Leave demo mode?', body: T.confirmLeave, ok: 'Leave demo mode' })) await leaveDemo(false); });
  if (a === 'retry') safe(() => leaveDemo(true));
});

// ---------- Get help → Report an issue: a small in-page dialog (never the browser's pop-ups) ----------
// The person picks the program, says what happened and whether work is blocked, and sees exactly what technical details
// will be sent (the log lines open underneath). Central makes those details once; Send sends them as shown.
async function reportIssue(opts = {}) {
  document.querySelectorAll('dialog.supdlg').forEach((x) => x.remove());
  const d = document.createElement('dialog'); d.className = 'licdlg supdlg'; d.setAttribute('aria-label', 'Report an issue');
  document.body.appendChild(d); d.addEventListener('close', () => d.remove());
  const head = '<h2 class="lichead">Report an issue <button class="x" data-sup="close" aria-label="Close">✕</button></h2>';
  // opened from a problem (e.g. Online connections): the program and the error are filled in, the log goes with it
  let st = await bridge.call('support:prepare', opts.product || null);
  if (!st.signedIn) {
    d.innerHTML = `${head}<div class="supbody"><div class="supstate"><span class="big">🔑</span><div><b>Sign in with your Riyeser account first</b>
      So we know which business it's for and can reply to you. Use the same email and password as riyeser.com.</div></div>
      <div class="wrow"><button class="btn s" data-sup="close">Cancel</button><button class="btn" data-w="link" data-sup="close">Sign in</button></div></div>`;
    d.addEventListener('click', (e) => { if (e.target.closest('[data-sup=close]')) d.close(); });
    d.showModal(); return;
  }
  const form = { product: opts.product || '', what: opts.what || '', blocked: null, error: opts.error || '' };
  const draw = (note = '') => {
    const pv = st.preview || [];
    d.innerHTML = `${head}<form class="supbody" id="supf">${note}
      <p class="lbl">For ${esc(st.business || 'your business')}. We'll reply by email and on riyeser.com.</p>
      <label class="wf"><span>Which program?</span><select name="product" required><option value="">Choose…</option>${st.products.map((p) => `<option value="${esc(p.id)}"${p.id === form.product ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="wf"><span>What happened?</span><textarea name="what" rows="3" maxlength="4000" required placeholder="e.g. The payroll export stops at about 90% with “Export timed out”">${esc(form.what)}</textarea></label>
      <fieldset class="supyn"><legend>Is your work blocked?</legend><label><input type="radio" name="blocked" value="yes"${form.blocked === true ? ' checked' : ''}> Yes</label><label><input type="radio" name="blocked" value="no"${form.blocked === false ? ' checked' : ''}> No</label></fieldset>
      <label class="wf"><span>Error message or code <small>(optional)</small></span><input name="error" maxlength="300" value="${esc(form.error)}"></label>
      ${st.diag ? `<div class="suppv" id="suppv"><b>What we'll send with it</b><table>${pv.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(k === 'When' ? new Date(v).toLocaleString() : v)}</td></tr>`).join('')}</table>
        ${st.diag.log_lines ? `<details id="suplog"><summary>Show the log lines (${st.diag.log_lines.split('\n').length})</summary><pre>${esc(st.diag.log_lines)}</pre></details>` : ''}
        <p class="muted">Only technical details. Never your invoices, payroll, customers, files or messages. Emails, long numbers and anything after “password” are hidden.</p></div>`
        : '<p class="muted">Choose the program to see the technical details we\'ll send with it.</p>'}
      <div id="superr"></div><div class="wrow"><button type="button" class="btn s" data-sup="close">Cancel</button><button class="btn" id="supsend"${st.diag ? '' : ' disabled'}>Send report</button></div></form>`;
    const f = d.querySelector('#supf');
    const keep = () => { const x = new FormData(f); form.what = String(x.get('what') || ''); form.error = String(x.get('error') || ''); const b = x.get('blocked'); form.blocked = b ? b === 'yes' : null; };
    f.addEventListener('input', keep);
    f.product.onchange = async () => { keep(); form.product = f.product.value; st = await bridge.call('support:prepare', form.product || null); draw(); };
    f.onsubmit = async (e) => { e.preventDefault(); keep(); const err = d.querySelector('#superr'); const btn = d.querySelector('#supsend');
      if (!form.what.trim()) { err.innerHTML = '<div class="werr">Say what happened.</div>'; return; }
      if (form.blocked === null) { err.innerHTML = '<div class="werr">Choose whether your work is blocked: Yes or No.</div>'; return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const r = await bridge.call('support:send', st.token, { what_happened: form.what, blocked: form.blocked, error_text: form.error });
        d.innerHTML = `${head}<div class="supbody"><div class="supstate ok"><span class="big">✅</span><div><b>Thanks — your request number is ${esc(r.ref)}.</b> Reference ${esc(r.diag_ref)}.
          <div>We'll reply by email and on riyeser.com under “Your help requests”.</div></div></div>
          <div class="wrow"><button class="btn s" data-sup="close">Done</button><button class="btn" data-sup="open" data-ref="${esc(r.ref)}">Open it on riyeser.com</button></div></div>`;
      } catch (x) { btn.disabled = false; btn.textContent = 'Send report'; err.innerHTML = `<div class="werr">${esc(x.message)}</div>`; }
    };
  };
  d.addEventListener('click', (e) => { if (e.target.closest('[data-sup=close]')) d.close();
    const o = e.target.closest('[data-sup=open]'); if (o) { safe(() => bridge.call('support:open', o.dataset.ref)); d.close(); } });
  draw(); d.showModal(); (form.product ? d.querySelector('textarea') : d.querySelector('select')).focus();
}
window.RiyeserCentralReport = { reportIssue };

// ---------- licence: one free 90-day trial, then one licence for every Riyeser program ----------
let lic = null;
if (bridge && bridge.on) bridge.on('licence-changed', () => loadLicence());
async function loadLicence() { try { lic = await bridge.call('central:licence'); } catch { lic = null; } renderLicence(); }
function licLine(s) {
  if (!s) return 'Licence';
  if (s.online) return s.online.stale ? 'Plan needs checking' : 'Your plan';
  if (s.mode === 'trial') return `Free trial · ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left`;
  if (s.mode === 'licensed') return `Licensed${s.plan ? ` · ${s.plan}` : ''}`;
  return 'Licence needed';
}
function renderLicence() {
  $('#licbtn').textContent = licLine(lic);
  if (today) renderCards();   // the paid programs' cards show where they stand on the plan
  const bar = $('#licbar');
  if (lic && lic.online) {   // the company's plan from Riyeser online
    const o = lic.online; const ended = o.rows.filter((r) => r.tone === 'bad'); const soon = o.rows.filter((r) => r.tone === 'warn');
    bar.hidden = !(o.stale || ended.length || soon.length);
    if (!bar.hidden) bar.innerHTML = `<span style="font-size:24px">🔑</span><div class="grow"><b>${o.stale ? 'Your plan needs checking' : ended.length ? `${esc(ended.map((r) => r.name).join(', '))}: trial ended` : `${esc(soon.map((r) => r.name).join(', '))}: free trial ending soon`}</b><div class="lbl">${esc(o.message || 'Everything you\'ve made stays exactly where it is. Contact Riyeser to change your plan.')}</div></div><button class="go" data-lic="open">See your plan</button>`;
    return;
  }
  const show = lic && (lic.mode === 'expired' || (lic.mode === 'trial' && lic.daysLeft <= 14) || lic.message);
  bar.hidden = !show;
  if (show) {
    const text = lic.mode === 'trial' ? `<b>${lic.daysLeft} day${lic.daysLeft === 1 ? '' : 's'} left in your free trial</b><div class="lbl">Get a licence any time — everything you've made stays exactly where it is.</div>`
      : `<b>${lic.mode === 'licensed' ? 'Licence check due' : 'Licence needed'}</b><div class="lbl">${esc(lic.message || '')}</div>`;
    bar.innerHTML = `<span style="font-size:24px">🔑</span><div class="grow">${text}</div><button class="go" data-lic="open">${lic.mode === 'licensed' ? 'Details' : 'Unlock your plan'}</button>`;
  }
}
function openPlan(o) {
  const icon = { ok: '✅', trial: '🎁', warn: '⏳', bad: '⛔' };
  $('#licbody').innerHTML = `<div class="state${o.stale ? ' bad' : ''}"><span class="big">${o.stale ? '🔑' : '🏢'}</span><div><b>Your Riyeser plan${o.companyCode ? ` · ${esc(o.companyCode)}` : ''}</b>
      ${o.stale ? esc(o.message) : 'Set by Riyeser for your whole company. Every Riyeser program on this PC follows it.'}</div></div>
    <ul class="planrows">${o.rows.map((r) => `<li class="t-${r.tone}"><span>${icon[r.tone] || ''}</span><b>${esc(r.name)}</b><span class="pt">${esc(r.text)}</span>${r.locked ? `<span class="lk">${esc(r.locked)}</span>` : ''}</li>`).join('')
      || '<li><span></span><b>No paid programs yet</b><span class="pt">Central, Desk Assistant, Invoices and PDF are free.</span></li>'}</ul>
    <p class="planmeta">Users: ${o.seatsIncluded} included in each paid program${o.extraUsers ? ` + ${o.extraUsers} extra` : ''}${o.usersUsed != null ? ` (${o.usersUsed} in use)` : ''} · Companies in Accounting: ${1 + o.extraCompanies} (1 included${o.extraCompanies ? ` + ${o.extraCompanies} extra` : ''})
      · Billed ${o.billing === 'yearly' ? 'yearly' : 'monthly'}${o.earlyBird ? ' · 🐣 early bird' : ''}</p>
    <p class="muted">Last checked ${esc(o.checkedAgo)}. Works offline for 30 days between checks.</p>
    <div class="row"><button class="btn" data-lic="refresh">Check now</button>${o.rows.some((r) => r.locked) ? '<button class="btn" data-lic="home">Open Riyeser home</button>' : ''}<button class="btn s" data-lic="buy">See plans</button></div>
    <p class="muted">Central, Desk Assistant, Invoices and PDF are always free. To add or change a paid program, use Add to my plan on your Riyeser home page.</p>`;
  $('#licdlg').showModal();
}
function openLicence() {
  if (lic && lic.online) return openPlan(lic.online);
  const s = lic || {}; const body = $('#licbody');
  const state = s.mode === 'licensed'
    ? `<div class="state"><span class="big">✅</span><div><b>Licensed${s.plan ? ` — ${esc(s.plan)}` : ''}</b>${s.email ? `${esc(s.email)} · ` : ''}key ${esc(s.key || '')}<div>Companies in Riyeser Accounting: ${1 + (s.extraCompanies || 0)} (1 included${s.extraCompanies ? ` + ${s.extraCompanies} extra` : ''})</div><div class="muted">Checked ${s.checkedAt ? new Date(s.checkedAt).toLocaleDateString() : '—'}. Works offline; it's re-checked now and then when you're online.</div></div></div>`
    : s.mode === 'trial'
      ? `<div class="state"><span class="big">🎁</span><div><b>Free trial — ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left</b>Every paid Riyeser program is free until ${new Date(s.trialEnds).toLocaleDateString()}. No card needed.</div></div>`
      : `<div class="state bad"><span class="big">🔑</span><div><b>Licence needed</b>${esc(s.message || '')}</div></div>`;
  body.innerHTML = `${state}
    ${s.mode === 'licensed' ? `<div class="row"><button class="btn s" data-lic="remove">Remove licence from this PC</button><button class="btn s" data-lic="buy">Manage plan</button></div>
      <p class="muted">Removing frees this computer's place so you can use the licence on another PC.</p>`
    : LUI.signInHtml(s, esc, false)}`;
  $('#licdlg').showModal();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lic]'); if (!b) return;
  const a = b.dataset.lic;
  if (a === 'open') openLicence();
  if (a === 'buy') safe(() => bridge.call('central:buy'));
  if (a === 'home') safe(() => bridge.call('central:home'));
  if (a === 'refresh') safe(async () => { b.disabled = true; try { lic = await bridge.call('central:licenceRefresh'); renderLicence(); if (lic && lic.online) openPlan(lic.online); toast(lic && lic.online && !lic.online.stale ? 'Plan checked' : 'Couldn\'t reach Riyeser right now. Try again when you\'re online.'); } finally { b.disabled = false; } });
  if (a === 'signin') { $('#licdlg').close(); $('#qclear').click(); setView('company'); }   // the Company page's Riyeser account sign-in
  if (a === 'remove') safe(async () => { if (!(await askConfirm({ title: 'Remove the licence from this PC?', body: 'You can type the licence key in again any time.', ok: 'Remove it' }))) return; lic = await bridge.call('central:licenceRemove'); renderLicence(); openLicence(); });
});
$('#licbtn').addEventListener('click', openLicence);

// ---------- search ----------
const finder = { q: '', type: null, year: null, kind: null };
async function runSearch() {
  const active = finder.q.trim() || finder.type || finder.year || finder.kind;
  $('#results').hidden = !active; $('#home').hidden = !!active || view !== 'home'; $('#appsv').hidden = !!active || view !== 'apps'; $('#companyv').hidden = !!active || view !== 'company'; $('#qclear').hidden = !active;
  if (!active) return;
  const r = await bridge.call('search:find', { ...finder, limit: 150 });
  const chipRow = (label, key, counts, order) => {
    const entries = Object.entries(counts).sort(order);
    if (!entries.length) return '';
    return `<div class="frow"><span class="flabel">${label}</span>${finder[key] ? `<button class="fchip on" data-f="${key}" data-v="">${esc(finder[key])} ✕</button>` : entries.slice(0, 20).map(([v, n]) => `<button class="fchip" data-f="${key}" data-v="${esc(v)}">${esc(v)} <span class="muted">${n}</span></button>`).join('')}</div>`;
  };
  $('#results').innerHTML = `<div class="filters">${chipRow('Type', 'type', r.facets.type, (a, b) => b[1] - a[1])}${chipRow('Year', 'year', r.facets.year, (a, b) => b[0].localeCompare(a[0]))}${chipRow('Kind', 'kind', r.facets.kind, (a, b) => b[1] - a[1])}</div>
    <div class="panel rlist"><div class="lbl" style="padding:8px 0">${r.total.toLocaleString()} match${r.total === 1 ? '' : 'es'}${r.total > r.results.length ? ` — showing the best ${r.results.length}` : ''}</div>
    ${r.results.length ? r.results.map((x) => `<div class="res">${fileIcon(x.name)}<div class="grow"><b>${esc(x.name)}</b>${x.formerNames.length ? ` <span class="lbl">· used to be ${esc(x.formerNames[x.formerNames.length - 1])}</span>` : ''}
        <div style="margin:3px 0"><span class="pill">${esc(x.type)}</span><span class="pill">${esc(x.year)}</span><span class="pill">${esc(x.kind)}</span>${x.company ? `<span class="pill">${esc(x.company)}</span>` : ''}</div>
        <div class="p">${esc(short(x.dir))}${x.snippet ? ` · …${esc(x.snippet)}…` : ''}</div></div>
        <button data-file="${esc(x.path)}">Open</button><button data-reveal="${esc(x.path)}">Show</button></div>`).join('')
      : `<div class="lbl" style="padding:12px 0 16px">No matches.${has('desk') ? (today && today.documents ? ' Search covers the documents in Riyeser Documents.' : ' If you just saved it, open Desk Assistant → Find a file → “Re-scan my folders”.') : ' Search uses Riyeser Documents’ list — install it to search your documents.'}</div>`}</div>`;
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const loc = e.target.closest('[data-locate]');
  if (loc) { e.stopPropagation(); safe(async () => { const f = await bridge.call('central:locate', loc.dataset.locate); if (f) { toast('Got it. It\'s on your home screen now.'); refresh(); } }); return; }
  const get = e.target.closest('[data-get]');
  if (get) { e.stopPropagation(); safe(() => bridge.call('central:get', get.dataset.get)); return; }
  const hb = e.target.closest('[data-help]');
  if (hb) { safe(() => bridge.call('central:help', hb.dataset.help)); return; }
  const ib = e.target.closest('[data-install]');
  if (ib) { installApp(ib.dataset.install); return; }
  const vw = e.target.closest('[data-view]');
  if (vw) { $('#qclear').click(); setView(vw.dataset.view); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    if (act.dataset.act === 'find') { setView('home'); $('#q').focus(); }
    if (act.dataset.act === 'team') safe(() => bridge.call('central:team'));
    if (act.dataset.act === 'gethelp') safe(() => bridge.call('central:getHelp'));
    if (act.dataset.act === 'report') safe(() => reportIssue());
    if (act.dataset.act === 'pickpdf') safe(() => bridge.call('central:openPdf'));
    return;
  }
  if (e.target.closest('#actall')) { actAll = !actAll; renderActivity(); return; }
  const open = e.target.closest('[data-open]');
  if (open) { safe(() => bridge.call('central:open', open.dataset.open, open.dataset.page || null)); return; }
  const file = e.target.closest('[data-file]');
  if (file) { safe(() => bridge.call('file:open', file.dataset.file)); return; }
  const rev = e.target.closest('[data-reveal]');
  if (rev) { safe(() => bridge.call('file:reveal', rev.dataset.reveal)); return; }
  const chip = e.target.closest('[data-f]');
  if (chip) { finder[chip.dataset.f] = chip.dataset.v || null; safe(runSearch); }
});
let timer;
$('#q').addEventListener('input', (e) => { finder.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => safe(runSearch), 150); });
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#qclear').click(); });
$('#qclear').addEventListener('click', () => { $('#q').value = ''; Object.assign(finder, { q: '', type: null, year: null, kind: null }); safe(runSearch); $('#q').focus(); });

(async () => {
  const v = await bridge.call('app:version').catch(() => '');
  document.title = `Riyeser Central ${v}`;
  $('#foot').textContent = `Version ${v}. Shows information from your other Riyeser programs and never changes it.`;
  await loadDemo();
  await safe(refresh);
  checkForUpdates(false);
  loadLicence();
  setInterval(loadLicence, 6 * 3600 * 1000);
  setInterval(() => { if ($('#results').hidden) safe(refresh); }, 5 * 60 * 1000);
  setInterval(() => checkForUpdates(false), 6 * 3600 * 1000);
  window.addEventListener('focus', () => { if ($('#results').hidden) safe(refresh); });
  setInterval(() => { if (view === 'home' && $('#results').hidden && !document.hidden && !installing) loadChecklist(); }, 60 * 1000);
  bridge.on('licence-changed', () => loadChecklist());
})();
