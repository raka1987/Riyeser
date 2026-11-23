// Riyeser Central home screen ("Desk" design: navy sidebar, summary tiles, quick access, tables).
// Shows only what this customer has: sidebar entries, tiles, quick links and panels appear only for programs that are
// installed on this PC. Anything else is listed under "Get more apps". A program that isn't installed never shows data,
// even if old files from an earlier install are still on the PC.
const $ = (s, el = document) => el.querySelector(s);
const bridge = window.api;
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
  $('#hello').textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  $('#date').textContent = n.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
tick(); setInterval(tick, 60000);

// ---------- the programs ----------
const LOOK = {
  'accounting-basics': { ic: 'book', c: 'c-basics', nav: 'Accounting' }, accounting: { ic: 'book', c: 'c-acc', nav: 'Accounting' },
  payroll: { ic: 'people', c: 'c-pay', nav: 'Payroll' }, desk: { ic: 'folder', c: 'c-desk', nav: 'Desk Assistant' },
  pdf: { ic: 'pdf', c: 'c-pdf', nav: 'PDF' }, services: { ic: 'hat', c: 'c-svc', nav: 'Job records' },
};
let programs = []; let today = null; let upd = { updates: [] }; let updating = false; let view = 'home'; let rtab = 'all';
const has = (id) => programs.some((p) => p.id === id && p.status !== 'missing');
const accId = () => (has('accounting') ? 'accounting' : has('accounting-basics') ? 'accounting-basics' : null); // Plus wins when both are there
const hasAcc = () => !!accId();

// Quick access: one-click jobs, each shown only when its program is installed.
// `page` asks the program to open on that screen (programs that don't know the page just open normally).
const QUICK = [
  { p: 'acc', ic: 'store', t: 'Shop counter', s: 'Ring up a sale (POS)', page: 'pos' },
  { p: 'acc', ic: 'invoice', t: 'New invoice', s: 'Bill a customer', page: 'invoice' },
  { p: 'desk', ic: 'sort', t: 'Sort new files', s: 'Downloads, Desktop, phone', page: 'organise' },
  { p: 'desk', ic: 'search', t: 'Find a file', s: 'Search every folder', act: 'find' },
  { p: 'pdf', ic: 'pdf', t: 'Open a PDF', s: 'Fill in, sign or edit', act: 'pickpdf' },
  { p: 'pdf', ic: 'layers', t: 'Combine PDFs', s: 'Join files into one', page: 'combine' },
  { p: 'payroll', ic: 'people', t: 'Run payroll', s: 'Timesheets to payslips', page: 'payrun' },
  { p: 'services', ic: 'hat', t: 'Job records', s: 'Drawings, tests and QA', page: 'projects' },
];
const quickFor = (q) => (q.p === 'acc' ? accId() : has(q.p) ? q.p : null);

function renderNav() {
  const mine = programs.filter((p) => p.status !== 'missing' && !(p.id === 'accounting-basics' && has('accounting')));
  const upFor = new Set((upd.updates || []).map((u) => u.id));
  const missing = programs.filter((p) => p.status === 'missing' && !(p.id === 'accounting-basics' && has('accounting'))).length;
  $('#nav').innerHTML = `<button class="${view === 'home' ? 'on' : ''}" data-view="home">${icon('home')}Home</button>
    ${mine.length ? '<div class="navlbl">Your programs</div>' : ''}
    ${mine.map((p) => `<button data-open="${esc(p.id)}" title="Open ${esc(p.full)}">${icon(LOOK[p.id].ic)}${esc(LOOK[p.id].nav)}${upFor.has(p.id) ? '<span class="tag">Update</span>' : ''}</button>`).join('')}
    <hr>
    <button data-act="find">${icon('search')}Find a file</button>
    ${missing ? `<button class="${view === 'apps' ? 'on' : ''}" data-view="apps">${icon('grid')}Get more apps</button>` : ''}
    <button data-lic="open">${icon('key')}Licence</button>`;
}

// ---------- summary tiles ----------
function kpi({ ic, t, v, s, cls = '', open }) {
  return `<button class="kpi ${cls}"${open ? ` data-open="${esc(open)}"` : ''}><span class="ki">${icon(ic, 22)}</span><span><div class="kt">${esc(t)}</div><div class="kv num">${esc(v)}</div>${s ? `<div class="ks">${esc(s)}</div>` : ''}</span></button>`;
}
function renderKpis() {
  const out = [];
  if (hasAcc()) {
    const m = today.money; const ok = m && m.found; const t = ok ? m.totals : { owedToYou: 0, overdueToYou: 0, youOwe: 0 };
    const overdue = ok ? m.receivables.filter((r) => r.overdue) : [];
    out.push(kpi({ ic: 'alert', t: 'Overdue invoices', v: String(overdue.length), s: overdue.length ? `${money(t.overdueToYou)} to chase` : ok ? 'Nothing overdue' : 'Set up your company', cls: overdue.length ? 'alert' : '', open: accId() }));
    out.push(kpi({ ic: 'money', t: 'Owed to you', v: money(t.owedToYou), s: ok ? `${m.receivables.length} open invoice${m.receivables.length === 1 ? '' : 's'}` : '', open: accId() }));
    const next = ok ? m.payables.slice().sort((a, b) => (b.overdue - a.overdue) || String(a.due).localeCompare(String(b.due)))[0] : null;
    out.push(kpi({ ic: 'bill', t: 'Bills to pay', v: money(t.youOwe), s: next ? `Next: ${next.contact}${next.due ? (next.overdue ? ' (overdue)' : `, due ${fmtDate(next.due)}`) : ''}` : 'No bills waiting', open: accId() }));
  }
  if (has('payroll')) {
    const pr = today.payroll || {};
    out.push(kpi({ ic: 'cal', t: 'Last pay run', v: pr.lastRun ? fmtDate(pr.lastRun.pay_date) : 'None yet', s: pr.lastRun ? `${money(pr.lastRun.total_net)} net · ${pr.lastRun.employees} staff` : 'Run your first pay in Payroll', open: 'payroll' }));
  }
  if (has('desk')) {
    const meetingsToday = today.meetings.filter((x) => isToday(x.start)).length;
    const n = today.taskCount ?? today.tasks.length;
    out.push(kpi({ ic: 'check', t: 'To-dos', v: String(n), s: today.calendars ? `${meetingsToday} meeting${meetingsToday === 1 ? '' : 's'} today` : 'From meetings and emails', cls: n ? '' : 'good', open: 'desk' }));
  }
  $('#kpis').innerHTML = out.join('');
  $('#kpis').hidden = !out.length;
}
function renderQuick() {
  const list = QUICK.map((q) => ({ ...q, id: quickFor(q) })).filter((q) => q.id);
  $('#quickwrap').hidden = !list.length;
  $('#quick').innerHTML = list.map((q) => `<button class="qa" ${q.act ? `data-act="${q.act}"` : `data-open="${esc(q.id)}" data-page="${esc(q.page || '')}"`}><span class="qi ${LOOK[q.id].c}">${icon(q.ic)}</span><span><b>${esc(q.t)}</b><small>${esc(q.s)}</small></span></button>`).join('');
}

// ---------- panels ----------
function renderRecent() {
  // Recent files come from Desk Assistant (and Windows' recent list) so they're only shown while it's installed.
  const box = $('#recentp'); box.hidden = !has('desk') && !has('pdf');
  if (box.hidden) return;
  if (!has('desk')) rtab = 'pdf'; // with only Riyeser PDF, this is a list of recent PDFs
  $('#rtabs').hidden = !has('desk'); $('#recentp .ph .grow').textContent = has('desk') ? 'Recent files' : 'Recent PDFs';
  const root = (today.organisedRoot || '').toLowerCase();
  const list = (today.recent || []).filter((r) => rtab === 'pdf' ? isPdf(r.name) : rtab === 'sorted' ? root && r.path.toLowerCase().startsWith(root) : true).slice(0, 8);
  document.querySelectorAll('#rtabs button').forEach((b) => b.classList.toggle('on', b.dataset.rt === rtab));
  $('#recent').innerHTML = list.length
    ? `<table class="tbl"><colgroup><col style="width:48%"><col style="width:34%"><col style="width:18%"></colgroup><tr><th>Name</th><th>Folder</th><th class="r">Opened</th></tr>
      ${list.map((r) => `<tr data-file="${esc(r.path)}" title="${esc(r.path)}"><td>${fileIcon(r.name)}${esc(r.name)}</td><td class="muted">${esc(folderName(r.dir))}</td><td class="r muted">${r.when ? ago(r.when) : ''}</td></tr>`).join('')}</table>`
    : `<div class="empty">${rtab === 'pdf' ? 'PDFs you open will show up here.' : rtab === 'sorted' ? 'Files Desk Assistant sorts for you will show up here.' : 'Files you open will show up here.'}</div>`;
}
function renderMoney() {
  const box = $('#moneyp'); box.hidden = !hasAcc(); // only while an Accounting app is installed
  if (box.hidden) return;
  $('#moneyopen').dataset.open = accId();
  const m = today.money;
  if (!m || !m.found) { $('#money').innerHTML = `<div class="empty">${m && m.error ? `Couldn't read your books: ${esc(m.error)}` : 'No invoices yet. Open Accounting and set up your company to see who owes you here.'}</div>`; return; }
  const rows = m.receivables.slice().sort((a, b) => (b.overdue - a.overdue) || String(a.due || a.date).localeCompare(String(b.due || b.date))).slice(0, 6);
  $('#money').innerHTML = rows.length
    ? `<table class="tbl"><colgroup><col style="width:17%"><col style="width:17%"><col style="width:36%"><col style="width:12%"><col style="width:18%"></colgroup><tr><th>Due</th><th>Reference</th><th>Customer</th><th></th><th class="r">Amount</th></tr>
      ${rows.map((r) => `<tr data-open="${esc(accId())}"><td>${esc(fmtDate(r.due || r.date))}</td><td>${esc(r.number)}</td><td>${esc(r.contact)}</td><td>${r.overdue ? '<span class="bad">Overdue</span>' : ''}</td><td class="r num">${money(r.owing)}</td></tr>`).join('')}</table>`
    : '<div class="empty">Every invoice is paid. 🎉</div>';
}
function renderToday() {
  const box = $('#todayp'); box.hidden = !has('desk'); // calendars live in Desk Assistant
  if (box.hidden) return;
  if (!today.calendars) { $('#today').innerHTML = '<div class="empty">Connect a calendar in Desk Assistant → Settings → Calendars to see your meetings here.</div>'; return; }
  $('#today').innerHTML = today.meetings.length ? today.meetings.slice(0, 5).map((m) => `<div class="li"><span class="h">${isToday(m.start) ? (m.allDay ? 'All day' : fmtTime(m.start)) : fmtDay(m.start)}</span><span class="grow">${esc(m.title)}${m.location ? ` <span class="lbl">· ${esc(m.location)}</span>` : ''}</span>${m.link ? `<a href="${esc(m.link)}" target="_blank">Join</a>` : ''}</div>`).join('')
    : '<div class="empty">No meetings today or tomorrow.</div>';
  if (today.meetingErrors.length) $('#today').innerHTML += `<div class="empty warn">Couldn't read: ${esc(today.meetingErrors.join(', '))}</div>`;
}
function renderTodo() {
  const box = $('#todop'); box.hidden = !has('desk'); // the to-do list belongs to Desk Assistant
  if (box.hidden) return;
  $('#todo').innerHTML = today.tasks.length ? today.tasks.slice(0, 5).map((x) => `<div class="li"><span class="chk"></span><span class="grow">${esc(x.text)}</span>${x.due ? `<span class="lbl warn">${esc(fmtDate(x.due))}</span>` : ''}</div>`).join('')
      + ((today.taskCount ?? today.tasks.length) > 5 ? `<div class="empty" style="padding-top:8px">+ ${(today.taskCount ?? today.tasks.length) - 5} more in Desk Assistant</div>` : '')
    : '<div class="empty">Nothing outstanding.</div>';
}
function renderLayout() {
  const left = !$('#recentp').hidden || !$('#moneyp').hidden; const right = !$('#todayp').hidden || !$('#todop').hidden;
  $('.cols').hidden = !left && !right;
  $('.cols').style.gridTemplateColumns = left && right ? '' : '1fr';
  // Nothing installed yet (a fresh install): no numbers, just a welcome and the apps to get.
  const none = !programs.some((p) => p.status !== 'missing');
  $('#getstarted').hidden = !none;
  if (none) $('#getstarted').innerHTML = `<div class="ph">Welcome to Riyeser Central</div><div class="empty" style="font-size:14px">Central is your home screen for every Riyeser program. Add the programs you need below. Their money, files, pay runs and quick links then show up here.</div>`;
  $('#appsv').hidden = !(view === 'apps' || (none && view === 'home')) || !$('#results').hidden;
}
function renderApps() {
  const others = programs.filter((p) => p.status === 'missing' && !(p.id === 'accounting-basics' && has('accounting')))
    .map((p) => (p.id === 'accounting' && has('accounting-basics') ? { ...p, name: 'Upgrade to Accounting Plus' } : p));
  $('#apps').innerHTML = others.length ? others.map((p) => `<div class="panel appc"><span class="qi ${LOOK[p.id].c}">${icon(LOOK[p.id].ic)}</span><div><b>${esc(p.name)}</b><p>${esc(p.desc)}</p>
      <div class="row"><button class="btn" data-get="${esc(p.id)}">Get it</button>${p.online ? `<button class="btn s" data-open="${esc(p.id)}">Open online</button>` : ''}<button class="link" data-locate="${esc(p.id)}" title="Already installed somewhere else? Point me to it">Locate…</button></div></div></div>`).join('')
    : '<div class="lbl">You have every Riyeser program.</div>';
}
function setView(v) {
  view = v; $('#home').hidden = v !== 'home'; $('#appsv').hidden = v !== 'apps';
  if (v !== 'home' && v !== 'apps') return;
  renderNav();
}
async function refresh() {
  [programs, today] = await Promise.all([bridge.call('central:programs'), bridge.call('central:today')]);
  renderNav(); renderKpis(); renderQuick(); renderRecent(); renderMoney(); renderToday(); renderTodo(); renderLayout(); renderApps();
}

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
  renderUpdates(); renderNav();
  if (!quiet) toast(upd.updates.length ? `${upd.updates.length} update${upd.updates.length === 1 ? '' : 's'} available.` : upd.note || 'Everything is up to date.');
}
bridge.on('update-progress', (p) => {
  const msg = $('#updmsg'); const bar = $('#updbar'); if (!msg) return;
  msg.textContent = p.stage === 'downloading' ? `Downloading ${p.name}… ${Math.round(p.pct * 100)}%` : p.stage === 'installing' ? `Installing ${p.name}…` : `Restarting Riyeser Central…`;
  bar.style.width = `${Math.round((p.stage === 'downloading' ? p.pct : 1) * 100)}%`;
});
$('#checkupd').addEventListener('click', () => checkForUpdates(true, false));

// ---------- licence: one free 90-day trial, then one licence for every Riyeser program ----------
let lic = null;
async function loadLicence() { try { lic = await bridge.call('central:licence'); } catch { lic = null; } renderLicence(); }
function licLine(s) {
  if (!s) return 'Licence';
  if (s.mode === 'trial') return `Free trial · ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left`;
  if (s.mode === 'licensed') return `Licensed${s.plan ? ` · ${s.plan}` : ''}`;
  return 'Licence needed';
}
function renderLicence() {
  $('#licbtn').textContent = licLine(lic);
  const bar = $('#licbar');
  const show = lic && (lic.mode === 'expired' || (lic.mode === 'trial' && lic.daysLeft <= 14) || lic.message);
  bar.hidden = !show;
  if (show) {
    const text = lic.mode === 'trial' ? `<b>${lic.daysLeft} day${lic.daysLeft === 1 ? '' : 's'} left in your free trial</b><div class="lbl">Get a licence any time — everything you've made stays exactly where it is.</div>`
      : `<b>${lic.mode === 'licensed' ? 'Licence check due' : 'Licence needed'}</b><div class="lbl">${esc(lic.message || '')}</div>`;
    bar.innerHTML = `<span style="font-size:24px">🔑</span><div class="grow">${text}</div><button class="go" data-lic="open">${lic.mode === 'licensed' ? 'Details' : 'Get a licence'}</button>`;
  }
}
function openLicence() {
  const s = lic || {}; const body = $('#licbody');
  const state = s.mode === 'licensed'
    ? `<div class="state"><span class="big">✅</span><div><b>Licensed${s.plan ? ` — ${esc(s.plan)}` : ''}</b>${s.email ? `${esc(s.email)} · ` : ''}key ${esc(s.key || '')}<div>Companies in Riyeser Accounting: ${1 + (s.extraCompanies || 0)} (1 included${s.extraCompanies ? ` + ${s.extraCompanies} extra` : ''})</div><div class="muted">Checked ${s.checkedAt ? new Date(s.checkedAt).toLocaleDateString() : '—'}. Works offline; it's re-checked now and then when you're online.</div></div></div>`
    : s.mode === 'trial'
      ? `<div class="state"><span class="big">🎁</span><div><b>Free trial — ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left</b>Every Riyeser program is included until ${new Date(s.trialEnds).toLocaleDateString()}. No card needed.</div></div>`
      : `<div class="state bad"><span class="big">🔑</span><div><b>Licence needed</b>${esc(s.message || '')}</div></div>`;
  body.innerHTML = `${state}
    ${s.mode === 'licensed' ? `<div class="row"><button class="btn s" data-lic="remove">Remove licence from this PC</button><button class="btn s" data-lic="buy">Manage plan</button></div>
      <p class="muted">Removing frees this computer's place so you can use the licence on another PC.</p>`
    : `<label for="lickey"><b>Have a licence key?</b> It's in your receipt email.</label>
      <input id="lickey" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">
      <div class="row"><button class="btn" data-lic="activate">Turn on licence</button><button class="btn s" data-lic="buy">See plans &amp; buy</button></div>
      <p class="muted">$20 per user a month for every Riyeser program, less for 5+ users. 🐣 Early bird: 50% off your first year for the first 100 users. Accounting Basics is free without a licence; Accounting Plus is included in your licence. Extra companies in Accounting: $10 a month each. Turning on a key needs the internet once; after that it works offline.</p>`}`;
  $('#licdlg').showModal();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lic]'); if (!b) return;
  const a = b.dataset.lic;
  if (a === 'open') openLicence();
  if (a === 'buy') safe(() => bridge.call('central:buy'));
  if (a === 'activate') safe(async () => { b.disabled = true; try { lic = await bridge.call('central:licenceActivate', $('#lickey').value); renderLicence(); openLicence(); toast('Licence turned on — thank you!'); } finally { b.disabled = false; } });
  if (a === 'remove') safe(async () => { if (!confirm('Remove the licence from this PC?')) return; lic = await bridge.call('central:licenceRemove'); renderLicence(); openLicence(); });
});
$('#licbtn').addEventListener('click', openLicence);

// ---------- search ----------
const finder = { q: '', type: null, year: null, kind: null };
async function runSearch() {
  const active = finder.q.trim() || finder.type || finder.year || finder.kind;
  $('#results').hidden = !active; $('#home').hidden = !!active || view !== 'home'; $('#appsv').hidden = !!active || view !== 'apps'; $('#qclear').hidden = !active;
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
      : `<div class="lbl" style="padding:12px 0 16px">No matches.${has('desk') ? ' If you just saved it, open Desk Assistant → Find a file → “Re-scan my folders”.' : ' Search uses Riyeser Desk Assistant’s file list — install it to search all your files.'}</div>`}</div>`;
}

// ---------- events ----------

// ---------- events ----------
document.addEventListener('click', (e) => {
  const loc = e.target.closest('[data-locate]');
  if (loc) { e.stopPropagation(); safe(async () => { const f = await bridge.call('central:locate', loc.dataset.locate); if (f) { toast('Got it. It\'s on your home screen now.'); refresh(); } }); return; }
  const get = e.target.closest('[data-get]');
  if (get) { e.stopPropagation(); safe(() => bridge.call('central:get', get.dataset.get)); return; }
  const vw = e.target.closest('[data-view]');
  if (vw) { $('#qclear').click(); setView(vw.dataset.view); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    if (act.dataset.act === 'find') { setView('home'); $('#q').focus(); }
    if (act.dataset.act === 'pickpdf') safe(() => bridge.call('central:openPdf'));
    return;
  }
  const rt = e.target.closest('[data-rt]');
  if (rt) { rtab = rt.dataset.rt; renderRecent(); return; }
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
  await safe(refresh);
  checkForUpdates(false);
  loadLicence();
  setInterval(loadLicence, 6 * 3600 * 1000);
  setInterval(() => { if ($('#results').hidden) safe(refresh); }, 5 * 60 * 1000);
  setInterval(() => checkForUpdates(false), 6 * 3600 * 1000);
  window.addEventListener('focus', () => { if ($('#results').hidden) safe(refresh); });
})();
