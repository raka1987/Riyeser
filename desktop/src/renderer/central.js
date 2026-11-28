// Riyeser Central 1.9 home screen, "App launcher": less is more, people open their programs anyway.
//   Top bar: the logo, one search box (programs and their jobs, customers, files), 🔒 Admin and the avatar menu
//   (your account, Settings, Help, Sign out). Main: a greeting with the business's name and one "All good" / "N things
//   need attention" pill, a grid of big program icons with one short live line each, "+ Add a program", and one row of
//   small status chips (only when there's something to say). Everything else lives in the Admin panel (PCs and
//   licences, people, updates, online connections, branches, backups, diagnostics, demo mode, fresh start), Settings
//   or Help. Nothing pops up by itself: "Needs attention" is only for things that are really broken and important.
// Shows only what this customer has: a tile for each program installed on this PC; anything else is under
// "Add a program". A program that isn't installed never shows data, even if old files from an earlier install are
// still on the PC. The rules for what goes on the screen are in launcher.js (plain functions, tested on their own).
const $ = (s, el = document) => el.querySelector(s);
const bridge = window.api;
const L9 = window.RiyeserLauncher;
let unread = 0;   // Riyeser Link's unread count, from its window's title: "(3) Riyeser Link" ("(3) Riyeser Team" before the rename)
if (bridge && bridge.on) bridge.on('team:title', (t) => { unread = Number((/^\((\d+)\)\s*Riyeser (?:Link|Team)\b/.exec(t || '') || [])[1]) || 0; if (programs.length) renderHome(); });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: 'short' });
const fmtDate = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
const isToday = (d) => new Date(d).toDateString() === new Date().toDateString();
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); if (m < 1) return 'Just now'; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h} h ago`; const d = Math.round(h / 24); return d === 1 ? 'Yesterday' : d < 7 ? `${d} days ago` : new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }); };
const short = (p) => p.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, '~');
const isPdf = (n) => /\.pdf$/i.test(n);
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4200); }
async function safe(fn) { try { return await fn(); } catch (e) { toast(e.message); return null; } }

// ---------- icons (simple line icons, drawn here so they work offline) ----------
const P = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  user: '<circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20c.9-3.8 3.9-6 7.5-6s6.6 2.2 7.5 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17h.01"/>',
  out: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16 6l2 2M14 8l2 2"/>',
  pc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  pdf: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M9.5 16.5h5M9.5 13h5"/>',
  img: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8.5 8.5"/>',
  sheet: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.4 0 4 1.5 4.5 4.3"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
};
const icon = (n, size) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"${size ? ` style="width:${size}px;height:${size}px"` : ''}>${P[n] || P.doc}</svg>`;
const fileIcon = (n) => {
  const [k, c] = isPdf(n) ? ['pdf', '#d6423a'] : /\.(xlsx?|xlsm|csv|ods)$/i.test(n) ? ['sheet', '#16a05a'] : /\.(jpe?g|png|heic|gif|webp)$/i.test(n) ? ['img', '#0f8bb8'] : /\.(docx?|odt|rtf)$/i.test(n) ? ['doc', '#1a5fd6'] : ['doc', 'var(--muted)'];
  return `<span class="fi" style="color:${c}">${icon(k, 18)}</span>`;
};
document.querySelectorAll('[data-ic]').forEach((el) => { el.innerHTML = icon(el.dataset.ic, 18); });

// ---------- light / dark / same as Windows (Settings → Theme; light is the default, like the website) ----------
const darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let theme = 'light';
try { theme = localStorage.getItem('central-theme-2') || 'light'; } catch { /* storage unavailable */ }
function applyTheme(t) {
  theme = ['light', 'dark', 'system'].includes(t) ? t : 'light';
  document.documentElement.dataset.theme = theme === 'system' ? (darkMq && darkMq.matches ? 'dark' : 'light') : theme;
  document.querySelectorAll('input[name="settheme"]').forEach((r) => { r.checked = r.value === theme; });
}
applyTheme(theme);
if (darkMq && darkMq.addEventListener) darkMq.addEventListener('change', () => { if (theme === 'system') applyTheme('system'); });
document.addEventListener('change', (e) => { if (e.target.name === 'settheme') { applyTheme(e.target.value); try { localStorage.setItem('central-theme-2', theme); } catch { /* ignore */ } } });

// ---------- the programs ----------
// One order everywhere (tiles, Add a program, updates), the same as riyeser.com (launcher.js ORDER).
const byOrder = L9.byOrder;
const LUI = window.RiyeserLicenceUi;
const LOOK = {
  team: { nav: 'Link', col: '#a21caf', blurb: 'Chat, calls and desk phones' },   // Riyeser Link (program id still "team")
  linkoffice: { nav: 'Link Office', col: '#0e7490', blurb: 'Your office phone system. Comes with Riyeser Link' },
  invoices: { nav: 'Invoices', col: '#0284c7', blurb: 'Send invoices and get paid' },
  bookings: { nav: 'Bookings', col: '#e11d48', blurb: 'Jobs, appointments and tables' },
  estimate: { nav: 'Estimate', col: '#ea580c', blurb: 'Measure jobs and quote them' },
  'accounting-basics': { nav: 'Accounting Basics', col: '#16a05a', blurb: 'View and manage your accounts' },
  accounting: { nav: 'Accounting Plus', col: '#1a5fd6', blurb: 'View and manage your accounts' },
  pos: { nav: 'POS', col: '#0f8f82', blurb: 'Open the till and ring up sales' },
  payroll: { nav: 'Payroll', col: '#5b54d6', blurb: 'Run payroll and manage staff' },
  desk: { nav: 'Documents', col: '#0e7c86', blurb: 'Scan, file and find documents' },   // Riyeser Documents (was Desk Assistant)
  pdf: { nav: 'PDF', col: '#d6423a', blurb: 'Fill in, sign and combine PDFs' },
  services: { col: '#d98a0b', blurb: 'Keep job records up to date' }, // services: shown by its own name (As Built)
};
const NAMES = () => Object.fromEntries(programs.map((p) => [p.id, (LOOK[p.id] && LOOK[p.id].nav) || p.name]));
// Each program's own logo (the letter-and-dot set used on riyeser.com and the program icons).
const LOGO = { team: 'team', linkoffice: 'link', invoices: 'invoices', bookings: 'bookings', estimate: 'estimate', 'accounting-basics': 'accounting-basics', accounting: 'accounting-plus', pos: 'pos', payroll: 'payroll', desk: 'desk-assistant', pdf: 'pdf', services: 'services' };
const logo = (p, size = 22) => `<img class="logo-i" src="logos/${p.id === 'services' && /as built/i.test(p.name || '') ? 'as-built' : LOGO[p.id]}.png" alt="" style="width:${size}px;height:${size}px">`;
let programs = []; let today = null; let upd = { updates: [] }; let updating = false; let view = 'home';
let sync = null; let backups = null; let updError = ''; let demoMsg = '';
let auto = null;   // the automatic updates (Admin → Updates → "Install updates automatically"): central:autoUpdate
const has = (id) => programs.some((p) => p.id === id && p.status !== 'missing');
const accId = () => (has('accounting') ? 'accounting' : has('accounting-basics') ? 'accounting-basics' : null); // Plus wins when both are there
const hasAcc = () => !!accId();
const coState = () => (window.RiyeserCompany ? window.RiyeserCompany.state() : null) || {};
const who = () => L9.audience({ company: coState().company, kind: coState().kind, role: coState().role, demo: !!demoState.on });

// ---------- the home screen ----------
let tileList = [];
const homeCtx = () => ({ programs, today: today || {}, lic, LUI, upd, cl, inst: instState, installing, unread, sync, names: NAMES(), audience: who() });
function attentionItems() {
  return L9.attention({ sync, lic, LUI, company: coState(), demoNote: demoMsg, inst: instState, programs, updError, backups, names: NAMES(), autoFailed: auto && auto.attention,
    installedIds: programs.filter((p) => p.status !== 'missing').map((p) => p.id) });
}
function renderTop() {
  const a = who(); const s = coState();
  $('#adminbtn').hidden = a.who === 'individual';
  const nm = (s.company && s.company.your_name) || (s.signedIn || '').split('@')[0] || '';
  const ini = (demoState.on ? 'Ricky' : nm).trim().split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  if (ini) $('#avtxt').textContent = ini; else $('#avtxt').innerHTML = icon('user', 20);
  $('#avbtn').title = s.signedIn ? `Signed in as ${s.signedIn}` : 'Not signed in';
  const acc = !!(hasAcc() || has('invoices')); const files = has('desk');
  $('#q').placeholder = acc && files ? 'Search programs, customers, files…' : acc ? 'Search programs and customers…' : files ? 'Search programs and files…' : 'Search programs…';
}
function renderHome() {
  if (!today) return;
  const a = who(); const s = coState();
  const name = L9.firstName(demoState.on ? 'Ricky' : (s.company && s.company.your_name) || '');
  $('#hello').textContent = L9.greeting(new Date(), name);
  const date = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  $('#sub').textContent = a.who === 'individual' ? date : `${a.business} · ${date}`;
  const att = attentionItems();
  const pill = $('#pill'); pill.className = `pill ${att.length ? 'wa' : 'ok'}`;
  $('#pilltxt').textContent = att.length ? `${att.length} thing${att.length === 1 ? ' needs' : 's need'} attention` : 'All good';
  pill.setAttribute('aria-label', att.length ? `${$('#pilltxt').textContent}. Show what` : 'All good: nothing needs attention');
  renderTiles(); renderChips();
  renderTop();
  if (popFor) drawPop(popFor, true);
}
function tileHtml(t) {
  const prog = programs.find((p) => p.id === t.id) || { id: t.id, name: t.name };
  const text = updatingIds.has(t.id) ? 'Updating…' : t.line;
  const line = `<small class="tl${t.tone && !updatingIds.has(t.id) ? ` ${t.tone}` : ''}">${text ? esc(text) : '&nbsp;'}</small>`;
  if (t.kind === 'add') return `<div class="tile" role="listitem"><button class="app add" data-view="apps"><span class="ti">${icon('plus', 26)}</span><b>Add a program</b>${line}</button></div>`;
  const dot = t.update ? `<span class="udot" title="Update ready: ${esc(t.update)}"></span>` : '';
  const main = t.kind === 'want'
    ? `<button class="app want" data-install="${esc(t.id)}" title="Install ${esc(t.full)}: it's on your plan"><span class="ti">${logo(prog, 52)}</span><b>${esc(t.name)}</b>${line}</button>`
    : `<button class="app" ${t.kind === 'team' ? 'data-act="team"' : `data-open="${esc(t.id)}"`} data-tile="${esc(t.id)}" title="Open ${esc(t.full)}${t.update ? ` (update ${esc(t.update)} ready)` : ''}"><span class="ti">${logo(prog, 52)}${dot}</span><b>${esc(t.name)}</b>${line}</button>`;
  const more = t.kind === 'want' || t.window ? '' : `<button class="more" data-tmenu="${esc(t.id)}" aria-label="More for ${esc(t.full)}" aria-haspopup="menu">${icon('more', 18)}</button>`;
  return `<div class="tile" role="listitem">${main}${more}</div>`;
}
function renderTiles() {
  tileList = L9.tiles(homeCtx());
  const box = $('#tiles'); const f = document.activeElement && box.contains(document.activeElement) ? document.activeElement : null;
  const keep = f ? (f.dataset.tile || f.dataset.tmenu || f.dataset.install || (f.dataset.view && 'add') || f.dataset.act) : null;
  box.innerHTML = tileList.map(tileHtml).join('');
  if (keep) { const again = box.querySelector(`[data-tile="${keep}"], [data-tmenu="${keep}"], [data-install="${keep}"]`) || (keep === 'add' ? box.querySelector('.app.add') : null); if (again) again.focus(); }
  const none = !programs.some((p) => p.status !== 'missing');
  box.classList.toggle('empty', none);
}
function renderChips() {
  const list = L9.chips({ programs, today: today || {}, sync, cl });
  const box = $('#chips'); box.hidden = !list.length;
  box.innerHTML = list.map((c) => `<button class="chip ${c.tone || 'mu'}" data-chip="${esc(c.id)}" aria-haspopup="${c.pop ? 'dialog' : 'false'}">${esc(c.text)}</button>`).join('');
}

// ---------- the popover: "Needs attention" and what a chip is about (never opens by itself) ----------
let popFor = null; let popAnchor = null;
function popHtml(kind) {
  const m = (today || {}).money;
  if (kind === 'attention') {
    const att = attentionItems(); const a = who();
    if (!att.length) return '<h3>All good</h3><p class="lbl">Nothing needs attention. Riyeser tells you here, quietly, if something stops working.</p>';
    return `<h3>Needs attention</h3><ul class="attl">${att.map((x) => `<li><div class="grow"><b>${esc(x.title)}</b>${x.detail ? `<small>${esc(x.detail)}</small>` : ''}</div>${x.act ? `<button class="btn sm" ${x.act.attrs}>${esc(x.act.label)}</button>` : ''}</li>`).join('')}</ul>
      ${a.who !== 'individual' && att.some((x) => x.admin) ? `<p class="lbl">${a.who === 'staff' ? 'An owner or admin can see more in ' : 'More in '}<button class="lnk" data-adm-go="overview">🔒 Admin</button>.</p>` : ''}`;
  }
  if (kind === 'overdue' && m && m.found) {
    const rows = m.receivables.filter((r) => r.overdue).slice(0, 6);
    return `<h3>Invoices to chase</h3><table class="tbl"><colgroup><col style="width:17%"><col style="width:21%"><col style="width:36%"><col style="width:26%"></colgroup><tr><th>Due</th><th>Invoice</th><th>Customer</th><th class="r">Owing</th></tr>${rows.map((r) => `<tr data-open="${esc(accId() || 'invoices')}"><td>${esc(fmtDate(r.due || r.date))}</td><td>${esc(r.number)}</td><td>${esc(r.contact)}</td><td class="r num">${money(r.owing)}</td></tr>`).join('')}</table>
      <div class="row end"><button class="btn sm" data-open="${esc(accId() || 'invoices')}">Open ${esc((programs.find((p) => p.id === (accId() || 'invoices')) || {}).name || 'Accounting')}</button></div>`;
  }
  if (kind === 'online') {
    const rec = ((sync && sync.recent) || []).filter((r) => !r.test && isToday(r.at)).slice(0, 6);
    return `<h3>From your website today</h3>${rec.map((r) => `<div class="li"><span class="h">${esc(fmtTime(r.at))}</span><span class="grow">${esc({ booking: 'Booking', order: 'Order', enquiry: 'Enquiry' }[r.kind] || r.kind)}${r.customer ? ` · ${esc(r.customer)}` : ''}</span></div>`).join('') || '<p class="lbl">Nothing yet.</p>'}`;
  }
  if (kind === 'meetings') {
    return `<h3>Today</h3>${(today.meetings || []).filter((x) => isToday(x.start)).slice(0, 6).map((x) => `<div class="li"><span class="h">${x.allDay ? 'All day' : esc(fmtTime(x.start))}</span><span class="grow">${esc(x.title)}${x.location ? ` <span class="lbl">· ${esc(x.location)}</span>` : ''}</span>${x.link ? `<a href="${esc(x.link)}" target="_blank">Join</a>` : ''}</div>`).join('')}`;
  }
  if (kind === 'checklist') return '<div id="checklist" class="cl"></div>';
  return '';
}
function drawPop(kind, again) {
  const pop = $('#pop');
  pop.innerHTML = popHtml(kind); pop.hidden = false; popFor = kind; pop.classList.toggle('wide', kind === 'overdue' || kind === 'checklist');
  pop.setAttribute('aria-label', { attention: 'Needs attention', overdue: 'Invoices to chase', online: 'From your website today', meetings: 'Today', checklist: 'Getting started' }[kind] || '');
  if (kind === 'checklist') renderChecklist();
  placePop();
  if (!again) { const f = pop.querySelector('button, [href]'); if (f) f.focus(); }
}
function placePop() {
  const pop = $('#pop'); if (pop.hidden || !popAnchor) return;
  const r = popAnchor.getBoundingClientRect(); const w = pop.offsetWidth; const h = pop.offsetHeight;
  let x = Math.min(Math.max(16, r.right - w), window.innerWidth - w - 16); if (popAnchor.closest('#chips')) x = Math.min(Math.max(16, r.left), window.innerWidth - w - 16);
  let y = r.bottom + 8; if (y + h > window.innerHeight - 12) y = Math.max(12, r.top - h - 8);
  pop.style.left = `${x}px`; pop.style.top = `${y}px`;
}
function openPop(kind, anchor) {
  if (popFor === kind && popAnchor === anchor) return closePop();
  closeMenus(); popAnchor = anchor; anchor.setAttribute('aria-expanded', 'true'); drawPop(kind);
}
function closePop(focusBack = false) {
  const pop = $('#pop'); if (pop.hidden) return;
  pop.hidden = true; popFor = null;
  if (popAnchor) { popAnchor.setAttribute('aria-expanded', 'false'); if (focusBack && popAnchor.isConnected) popAnchor.focus(); }
  popAnchor = null;
}
window.addEventListener('resize', placePop);

// ---------- a tile's ⋯ / right-click menu: Open, its jobs, Update, Repair, Uninstall, Help ----------
let menuFor = null;
function openTileMenu(id, at) {
  closePop(); const t = tileList.find((x) => x.id === id); if (!t) return;
  const p = programs.find((x) => x.id === id) || {};
  const items = [
    `<button role="menuitem" ${t.kind === 'team' ? 'data-act="team"' : `data-open="${esc(id)}"`}><b>Open ${esc(t.full)}</b></button>`,
    ...t.jobs.map((j) => `<button role="menuitem" ${j.act ? `data-act="${esc(j.act)}"` : `data-open="${esc(id)}" data-page="${esc(j.page)}"`}>${esc(j.t)}</button>`),
    '<hr>',
    t.update ? `<button role="menuitem" data-tact="update" data-id="${esc(id)}">Update to ${esc(t.update)}</button>` : '',
    p.status === 'installed' ? `<button role="menuitem" data-tact="repair" data-id="${esc(id)}">Repair</button>` : '',
    p.status === 'installed' ? `<button role="menuitem" data-tact="uninstall" data-id="${esc(id)}">Uninstall…</button>` : '',
    `<button role="menuitem" data-help="${esc(id)}">How to use ${esc(t.name)}</button>`,
  ].filter(Boolean);
  const m = $('#tmenu'); m.innerHTML = items.join(''); m.hidden = false; menuFor = id;
  m.setAttribute('aria-label', `${t.full}`);
  const w = m.offsetWidth; const h = m.offsetHeight;
  m.style.left = `${Math.min(Math.max(8, at.x), window.innerWidth - w - 8)}px`;
  m.style.top = `${at.y + h > window.innerHeight - 8 ? Math.max(8, at.y - h) : at.y}px`;
  const more = document.querySelector(`[data-tmenu="${id}"]`); if (more) more.setAttribute('aria-expanded', 'true');
  m.querySelector('[role=menuitem]').focus();
}
function closeMenus(focusBack = false) {
  const m = $('#tmenu');
  if (!m.hidden) { m.hidden = true; const more = document.querySelector(`[data-tmenu="${menuFor}"]`); if (more) { more.setAttribute('aria-expanded', 'false'); if (focusBack) more.focus(); } menuFor = null; }
  const a = $('#avmenu'); if (!a.hidden) { a.hidden = true; $('#avbtn').setAttribute('aria-expanded', 'false'); if (focusBack) $('#avbtn').focus(); }
}
// arrow keys inside a menu
function menuKeys(e, m) {
  const items = [...m.querySelectorAll('[role=menuitem]')]; const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
  if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  if (e.key === 'Tab') closeMenus();
}
document.addEventListener('contextmenu', (e) => {
  const t = e.target.closest('#tiles [data-tile]'); if (!t) return;
  e.preventDefault(); openTileMenu(t.dataset.tile, { x: e.clientX, y: e.clientY });
});
async function tileAction(a, id) {
  const p = programs.find((x) => x.id === id) || { full: id };
  closeMenus();
  if (a === 'update') {
    updatingIds.add(id); renderTiles();
    try { const r = await bridge.call('central:installUpdates', [id]); if (!r.restarting) toast(`${p.full} is up to date.`); updError = ''; } catch (e) { updError = e.message; toast(e.message); }
    updatingIds.delete(id); await checkForUpdates(true);
  }
  if (a === 'repair') {
    if (!(await askConfirm({ title: `Repair ${p.full}?`, body: `Central downloads ${p.full} again and installs it over the top. Your information is kept. ${p.full} closes for a moment if it's open.`, ok: 'Repair it' }))) return;
    if (await installApp(id, { quiet: true })) toast(`${p.full} is repaired.`);
  }
  if (a === 'uninstall') {
    if (who().who !== 'individual' && !(await adminReady())) { toast('Uninstalling a program is done by an owner or admin: unlock 🔒 Admin first.'); return openAdmin('overview'); }
    if (!(await askConfirm({ title: `Uninstall ${p.full}?`, body: `Windows removes the program from this PC. Your records stay on this PC and in your backups, so installing it again brings everything back.`, ok: 'Uninstall' }))) return;
    const r = await bridge.call('central:uninstall', id);
    toast(r.settings ? 'Choose it in Windows\' Installed apps to uninstall it.' : `Windows is uninstalling ${p.full}. It disappears from here once it's done.`);
    setTimeout(() => safe(refresh), 20000);
  }
}

// ---------- Add a program (not installed yet; "Get more apps" before 1.9) ----------
function renderApps() {
  const others = programs.filter((p) => p.status === 'missing' && !(p.id === 'accounting-basics' && has('accounting')))
    .map((p) => (p.id === 'accounting' && has('accounting-basics') ? { ...p, name: 'Upgrade to Accounting Plus' } : p));
  $('#apps').innerHTML = others.length ? others.map((p) => `<div class="panel appc">${logo(p, 44)}<div><b>${esc(p.name)}</b><p>${esc(p.desc)}</p>${(() => { const st = LUI.programStatus(p.id, lic); return st ? `<p class="lbl${st.alert ? ' bad' : ''}">${esc(st.text)}</p>` : ''; })()}
      <div class="row instrow" data-instrow="${esc(p.id)}">${instRow(p.id, `<button class="btn" data-install="${esc(p.id)}" title="Download and install it now">Install</button>${p.online ? `<button class="btn s" data-open="${esc(p.id)}">Open online</button>` : ''}<button class="link" data-help="${esc(p.id)}">Learn more</button><button class="link" data-get="${esc(p.id)}" title="Its page on riyeser.com">Download page</button><button class="link" data-locate="${esc(p.id)}" title="Already installed somewhere else? Point me to it">Locate…</button>`)}</div></div></div>`).join('')
    : '<div class="lbl">You have every Riyeser program.</div>';
}
function setView(v) {
  if (v === 'company') { openAccount(); return; }   // the Company page lives in Your account now
  view = v === 'apps' ? 'apps' : 'home';
  const searching = !$('#results').hidden;
  $('#home').hidden = view !== 'home' || searching; $('#appsv').hidden = view !== 'apps' || searching;
  if (view === 'apps') { renderApps(); const b = $('#appsv .back'); if (b) b.focus(); }
}
// company.js and first-run.js call this after the business changes
function renderNav() { renderTop(); renderHome(); }
async function refresh() {
  [programs, today, cl] = await Promise.all([bridge.call('central:programs'), bridge.call('central:today'), bridge.call('central:checklist').catch(() => cl)]);
  programs.sort((a, b) => byOrder(a.id, b.id));
  sync = await bridge.call('onlineSync:status').catch(() => sync);
  backups = await bridge.call('backup:status').catch(() => backups);
  renderPlanBar(); renderHome(); renderApps();
  if (adminOpen()) renderAdmin();
}

// ---------- install a program from here (no trip to the website) ----------
let installing = null; const updatingIds = new Set();
// Each install's last step (install-run.js in Central has the states): downloading -> checking -> installing (Windows may
// ask for permission) -> verifying -> installed, or failed with what happened and how to fix it. A failure stays on the
// tile (Try again, Get help, Download page) until it's tried again: never just back to a plain Install button.
const instState = {};
const STAGE_TEXT = {
  downloading: (x) => `Downloading… ${Math.round((x.pct || 0) * 100)}%`,
  checking: () => 'Checking the download…',
  installing: (x) => (x.elevate ? 'Installing… Windows will ask for permission: choose Yes' : 'Installing…'),
  verifying: () => 'Finishing…',
  installed: () => 'Installed ✓',
};
const instText = (x) => (x && STAGE_TEXT[x.stage] ? STAGE_TEXT[x.stage](x) : 'Getting ready…');
const instWidth = (x) => `${Math.round((x && x.stage === 'downloading' ? x.pct || 0 : x && x.stage !== 'idle' ? 1 : 0) * 100)}%`;
const instProgress = (id) => { const x = instState[id];
  return `<div style="flex:1;min-width:140px"><b class="instmsg" style="font-size:13px">${esc(instText(x))}</b><div class="prog"><i class="instbar" style="width:${instWidth(x)}"></i></div>${x && x.stage === 'installing' && x.elevate ? '<div class="lbl">It installs for everyone on this PC, so Windows checks first. The prompt may be behind this window: look on the taskbar.</div>' : ''}</div>`; };
const instFailed = (id) => { const x = instState[id];
  return `<div class="insterr" role="alert"><b>⚠ ${esc(x.message || 'Install failed.')}</b>${x.fix ? `<div class="lbl">${esc(x.fix)}</div>` : ''}
    <div class="row"><button class="btn sm" data-install="${esc(id)}">Try again</button><button class="btn sm s" data-insthelp="${esc(id)}" title="Send Riyeser Support the details">Get help</button><button class="link" data-get="${esc(id)}">Download page</button></div></div>`; };
/** The install area for a program: progress while it installs, the problem and its fix after a failure, else `buttons`. */
const instRow = (id, buttons) => (installing === id ? instProgress(id) : instState[id] && instState[id].stage === 'failed' ? instFailed(id) : buttons);
const drawInstRows = (id) => document.querySelectorAll(`[data-instrow="${id}"]`).forEach((row) => { row.innerHTML = instRow(id, row.innerHTML); });
// Get help after a failed install: Report an issue, filled in, with Central's install log in the details.
const SUPPORT_PRODUCT = { 'accounting-basics': 'accounting', accounting: 'accounting', team: 'link', services: 'other' };
function installHelp(id) {
  const x = instState[id] || {}; const p = programs.find((q) => q.id === id);
  return reportIssue({ product: SUPPORT_PRODUCT[id] || id, what: `Installing ${p ? p.full : id} from Riyeser Central didn't work: ${x.message || ''}`.trim(),
    error: x.code != null ? `code ${x.code}${x.reason ? ` (${x.reason})` : ''}` : x.reason || '' });
}
/** Install one program with its quiet installer. quiet: no toasts (the plan banner says how it went). true when installed. */
async function installApp(id, { quiet = false, then = true } = {}) {
  if (installing) { if (!quiet) toast('One program is installing already. It won\'t be long.'); return false; }
  const p = programs.find((x) => x.id === id); installing = id;
  instState[id] = { stage: 'idle' };
  document.querySelectorAll(`[data-instrow="${id}"]`).forEach((row) => { row.innerHTML = instProgress(id); });
  renderTiles();
  let ok = false;
  try {
    await bridge.call('central:install', id); ok = true; delete instState[id];
    if (!quiet) toast(`${p ? p.full : 'The program'} is installed. It's on your home screen now.`);
  } catch (e) {
    // the failed step normally arrives first (install-progress); this covers anything that didn't send one
    if (!instState[id] || instState[id].stage !== 'failed') instState[id] = { stage: 'failed', message: e.message, reason: 'failed' };
  }
  installing = null;
  if (then) await safe(refresh); else renderHome();
  drawInstRows(id);   // the failure stays on the tile, wherever it's shown
  return ok;
}
bridge.on('install-progress', (x) => {
  if (x.id !== installing) return;
  instState[x.id] = { ...x };
  const text = instText(x); const width = instWidth(x);
  document.querySelectorAll(`[data-instrow="${x.id}"]`).forEach((row) => {
    if (x.stage === 'failed') { row.innerHTML = instFailed(x.id); return; }
    if (x.stage === 'installing' && !row.querySelector('.lbl') && x.elevate) { row.innerHTML = instProgress(x.id); return; }
    const msg = row.querySelector('.instmsg'); const bar = row.querySelector('.instbar');
    if (msg) msg.textContent = text; if (bar) bar.style.width = width;
  });
  const tl = document.querySelector(`#tiles [data-tile="${x.id}"] .tl, #tiles [data-install="${x.id}"] .tl`); if (tl) tl.textContent = x.stage === 'failed' ? 'Didn\'t install' : text;
  if (planRun && planRun.id === x.id) { const bar = $('#planbar .instbar'); if (bar) bar.style.width = width; const m = $('#planbar .lbl'); if (m && x.stage !== 'failed') m.textContent = text; }
});

// ---------- "Your plan includes Payroll and Bookings. [Install them]" (top of Add a program) ----------
let planRun = null;   // { id, n, of } while the plan's programs are installing
const andList = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
function renderPlanBar(failed) {
  const box = $('#planbar'); if (!box) return;
  const list = (cl && cl.planMissing) || [];
  if (planRun) return;   // drawn by installPlan while it runs
  if (failed && failed.length) {
    box.hidden = false;
    box.innerHTML = `<span style="font-size:24px">⚠️</span><div class="grow"><b>Couldn't install ${esc(andList(failed))}.</b><div class="lbl">${esc(failed.map((n) => { const p = programs.find((q) => q.name === n || q.full === n); const x = p && instState[p.id]; return x && x.message ? x.message : ''; }).filter(Boolean).join(' ') || 'Check your internet and try again.')}</div></div><button class="go" data-cl="plan">Try again</button>`;
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
    if (!(await installApp(list[i].id, { quiet: true, then: false }))) failed.push(list[i].name);   // each tile keeps its reason
  }
  planRun = null;
  await safe(refresh);
  renderPlanBar(failed);
  toast(failed.length ? `Couldn't install ${andList(failed)}. The reason is on ${failed.length === 1 ? 'its tile' : 'their tiles'}.` : `${andList(list.map((p) => p.name))} ${list.length === 1 ? 'is' : 'are'} installed.`);
}

// ---------- "Getting started with Riyeser": a checklist that ticks itself from your real records ----------
// On the home screen it's one small chip ("Getting started · 2 of 6"); the list opens from it.
let cl = null;
const CL_BTN = { wizard: 'Sign in', company: 'Check details', apps: 'Install them', team: 'Open Riyeser Link' };
function clAction(it) {
  const a = it.action || {}; const p = programs.find((x) => x.id === a.id); const name = p ? p.name : '';
  if (a.kind === 'wizard') return `<button class="btn sm" data-w="link">${CL_BTN.wizard}</button>`;
  if (a.kind === 'view' && a.view === 'apps') return (cl.planMissing || []).length ? `<button class="btn sm" data-cl="plan">${CL_BTN.apps}</button>` : '<button class="btn sm s" data-view="apps">Add a program</button>';
  if (a.kind === 'view') return `<button class="btn sm" data-view="${esc(a.view)}">${CL_BTN.company}</button>`;
  if (a.kind === 'team') return `<button class="btn sm" data-act="team" data-needs="people">${CL_BTN.team}</button>`;   // inviting people needs an account
  if (a.kind === 'open') return `<button class="btn sm" data-open="${esc(a.id)}" data-page="${esc(a.page || '')}">Open ${esc(name)}</button>`;
  if (a.kind === 'install') return `<span class="instrow" data-instrow="${esc(a.id)}">${instRow(a.id, `<button class="btn sm" data-install="${esc(a.id)}">Install ${esc(name || 'it')}</button>`)}</span>`;
  return '';
}
function renderChecklist() {
  const box = $('#checklist'); if (!box) return;
  if (!cl) { box.innerHTML = ''; return; }
  const head = (right) => `<div class="ph"><span class="grow">Getting started with Riyeser</span>${right}</div>`;
  if (cl.demo) {   // demo mode: practice data, so there's nothing real to tick
    box.className = 'cl off';
    box.innerHTML = `${head('<button class="lnk" data-cl="hide">Hide getting started</button>')}<div class="empty">Leave demo mode to start your own checklist.</div>`;
    return;
  }
  if (cl.allDone) {
    box.className = 'cl alldone';
    box.innerHTML = `<div class="cldone"><span style="font-size:26px">🎉</span><div class="grow"><b>You're all set up</b><div class="lbl">Everything on your getting-started list is done. Nice work.</div></div><button class="btn s" data-cl="hide">Hide this</button></div>`;
    return;
  }
  box.className = 'cl';
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
  if (today) renderHome();
}
async function setChecklistHidden(hidden) {
  const r = await bridge.call('central:checklistHide', hidden);
  if (cl) cl.hidden = r.hidden;
  if (hidden) closePop();
  renderHome();
  const box = $('#sethide'); if (box) box.checked = !r.hidden;
  toast(hidden ? 'Getting started is hidden. You can show it again in Settings.' : 'Getting started is back on your home screen.');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cl]'); if (!b) return;
  const a = b.dataset.cl;
  if (a === 'hide') safe(() => setChecklistHidden(true));
  if (a === 'skip' || a === 'unskip') safe(async () => { await bridge.call('central:checklistSkip', b.dataset.id, a === 'skip'); await loadChecklist(); });
  if (a === 'plan') { closePop(); $('#qclear').click(); setView('apps'); safe(installPlan); }
});

// ---------- Settings (this person's): theme, start with Windows, notifications, getting started, usage counts, language ----------
async function openSettings() {
  closeMenus(); applyTheme(theme);
  $('#sethide').checked = !(cl && cl.hidden);
  $('#setdlg').showModal();
  safe(async () => { const r = await bridge.call('central:usageGet'); $('#setusage').checked = !!r.on; });
  safe(async () => { const p = await bridge.call('central:prefs'); $('#setstart').checked = !!p.startWithWindows; $('#setstart').disabled = !p.canStart; $('#setnotify').checked = !!p.notify;
    $('#setstartnote').textContent = p.canStart ? 'Opens when you sign in to Windows, so your programs are one click away.' : 'Works in the installed Riyeser Central on Windows.'; });
}
// Settings: "Send anonymous usage counts" (central/usage-counts.js). On unless turned off.
$('#setusage').addEventListener('change', (e) => safe(async () => {
  const r = await bridge.call('central:usageSet', e.target.checked); e.target.checked = !!r.on;
  toast(r.on ? 'Thanks: anonymous usage counts are on.' : 'Anonymous usage counts are off. Nothing more is sent from this PC.');
}));
$('#sethide').addEventListener('change', (e) => safe(() => setChecklistHidden(!e.target.checked)));
$('#setstart').addEventListener('change', (e) => safe(async () => { e.target.checked = await bridge.call('central:startWithWindows', e.target.checked); }));
$('#setnotify').addEventListener('change', (e) => safe(async () => { e.target.checked = await bridge.call('central:notify', e.target.checked); toast(e.target.checked ? 'Notifications are on.' : 'Notifications are off.'); }));

// Admin panel: "Fresh start on this PC". Every Riyeser folder on this PC is renamed away (never deleted), then Central
// restarts at "How would you like to start?". Brought back from "Bring back a fresh start…".
const FRESH_WORDS = 'START FRESH';
const freshDate = (iso) => { try { return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; } };
function freshBox() {
  const body = $('#adm-fresh'); if (!body || $('#freshbox')) return;
  const box = document.createElement('div'); box.id = 'freshbox';
  box.style.cssText = 'padding:14px 16px;border:1.5px solid var(--bad);border-radius:12px;background:var(--bad-soft)';
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
// Admin panel: Backups (OWNER-BACKUP). "Back up everything…" makes one file with every Riyeser program's data on this PC;
// "Restore everything from a backup…" puts it all back (before-restore copies first) and restarts Central.
function backupBox() {
  const body = $('#adm-backups'); if (!body || $('#backupbox')) return;
  const box = document.createElement('div'); box.id = 'backupbox';
  box.innerHTML = `<p class="admp">Riyeser backs up every program on this PC once a day (the last 30 are kept) into <b>Documents\\Riyeser</b>, outside the programs, so uninstalling or reinstalling never removes them. Moving to a new PC? Copy that folder (or one backup file) to a USB stick or OneDrive.</p>
    <div class="row bkrow"><button data-bk="all">Back up everything…</button> <button data-bk="restore">Restore everything from a backup…</button> <button data-bk="folder">Open the backups folder</button></div>
    <p id="bkmsg" style="font-size:13px;margin:8px 0 0" hidden></p><div id="bklist"></div>`;
  body.appendChild(box);
}
const bkMsg = (t, bad) => { const m = $('#bkmsg'); if (m && adminOpen()) { m.hidden = false; m.className = bad ? 'bad' : ''; m.textContent = t; } else toast(t); };
async function restoreEverything() {
  const pick = await bridge.call('backup:pick'); if (!pick) return;
  if (!(await askConfirm({ title: 'Restore from this backup?', body: `${pick.summary}\n\nEvery Riyeser program in it goes back to how it was then. A copy of everything as it is now is saved first ("before restore"). Close the other Riyeser programs; Riyeser Central restarts.`, ok: 'Restore and restart' }))) return;
  const r = await bridge.call('backup:restoreAll', pick.file);
  if (!r.ok) { bkMsg(`${r.message} Then try again.`, true); return; }
  bkMsg('Restoring… Riyeser Central is restarting.');
}
window.RiyeserBackup = { restoreEverything: () => safe(restoreEverything) };
document.addEventListener('click', (e) => {
  const k = e.target.closest('[data-bk]'); if (!k) return;
  if (k.dataset.bk === 'all') safe(async () => { k.disabled = true; try { const r = await bridge.call('backup:all'); bkMsg(`Backed up ${r.parts.length} part${r.parts.length === 1 ? '' : 's'} into ${r.file}`); backups = await bridge.call('backup:status').catch(() => backups); renderHome(); if (adminOpen()) renderAdmin(); } finally { k.disabled = false; } });
  if (k.dataset.bk === 'restore') safe(restoreEverything);
  if (k.dataset.bk === 'folder') safe(() => bridge.call('backup:folder'));
});
// after a restore, say how it went (once)
bridge.call('backup:result').then((r) => { if (r) toast(r.ok ? `Restored from your backup. What was here before is saved in ${r.before}` : `The restore didn't work: ${r.error} Nothing was changed.`); }).catch(() => {});

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

// ---------- updates (Admin panel → Updates; a tile's ⋯ → Update) ----------
let versions = null;
const progName = (id) => (id === 'central' ? 'Riyeser Central' : NAMES()[id] || id);
/** Admin → Updates: the "Install updates automatically" setting and one quiet line about the last automatic update. */
function autoHtml(au) {
  const line = au.demo ? 'Demo mode is on, so nothing updates by itself.' : !au.on ? 'Off: updates wait for Update all.'
    : au.last ? L9.autoLine(au.last, progName(au.last.id)) : 'Nothing updated by itself yet.';
  return `<label class="setrow autorow"><input type="checkbox" id="admauto"${au.on ? ' checked' : ''}${au.demo ? ' disabled' : ''}><span><b>Install updates automatically</b>
    <small>Each program updates quietly while it’s closed. Riyeser Central updates the next time it starts. Your information is kept, and nothing pops up.</small></span></label>
    <p class="lbl autolast" id="admautolast">${esc(line)}</p>`;
}
function renderUpdates() {
  const box = $('#updates');
  const list = upd.updates || [];
  if (!list.length && !updating) { box.hidden = true; return; }
  box.hidden = false;
  if (updating) return; // progress is drawn by the update-progress events
  box.innerHTML = `<div style="font-size:24px">⬆</div><div class="grow"><b>${list.length === 1 ? 'An update is ready' : `${list.length} updates are ready`}</b>
    <div class="lbl">${list.map((u) => `${esc(u.name)}${u.self ? ' (this app)' : ''} ${esc(u.from)} → ${esc(u.to)}`).join(' · ')}${auto && auto.on && !auto.demo ? '<br>These install by themselves while each program is closed.' : ''}</div></div>
    <button class="go" id="updall">Update ${list.length === 1 ? '' : 'all'}</button>`;
  $('#updall').addEventListener('click', () => safe(async () => {
    updating = true;
    box.innerHTML = '<div style="font-size:24px">⬇</div><div class="grow"><b id="updmsg">Getting ready…</b><div class="prog"><i id="updbar"></i></div><div class="lbl">Your information is kept. Programs being updated will close for a moment.</div></div>';
    try {
      const r = await bridge.call('central:installUpdates', null);
      if (r.restarting) { $('#updmsg').textContent = 'Riyeser Central is restarting to finish updating…'; return; }
      toast(`Updated ${r.done.length} program${r.done.length === 1 ? '' : 's'}.`); updError = '';
    } catch (e) { updError = e.message; toast(e.message); }
    updating = false;
    await checkForUpdates(true);
  }));
}
async function checkForUpdates(force, quiet = true) {
  try { upd = await bridge.call('central:updates', force); } catch (e) { if (!quiet) toast(e.message); return; }
  (upd.updates || []).sort((a, b) => byOrder(a.id, b.id));
  renderUpdates(); renderHome();
  if (adminOpen()) { versions = await bridge.call('central:versions', false).catch(() => versions); renderAdminSection('updates'); }
  if (!quiet) toast(upd.updates.length ? `${upd.updates.length} update${upd.updates.length === 1 ? '' : 's'} available.` : upd.note || 'Everything is up to date.');
}
bridge.on('update-progress', (p) => {
  const tl = document.querySelector(`#tiles [data-tile="${p.id}"] .tl`);
  if (tl && updatingIds.has(p.id)) tl.textContent = p.stage === 'downloading' ? `Updating… ${Math.round(p.pct * 100)}%` : 'Updating…';
  const msg = $('#updmsg'); const bar = $('#updbar'); if (!msg) return;
  msg.textContent = p.stage === 'downloading' ? `Downloading ${p.name}… ${Math.round(p.pct * 100)}%` : p.stage === 'installing' ? (p.elevate ? `Installing ${p.name}… Windows will ask for permission: choose Yes` : `Installing ${p.name}…`) : `Restarting Riyeser Central…`;
  bar.style.width = `${Math.round((p.stage === 'downloading' ? p.pct : 1) * 100)}%`;
});

// ---------- demo mode: practice data for Sample Trading Co (%APPDATA%\Riyeser\demo.json) ----------
let demoState = { on: false };
function renderDemo() {
  const bar = $('#demobar'); const html = window.RiyeserDemo.bannerHtml(demoState);
  bar.hidden = !html; bar.innerHTML = html;
  document.body.classList.toggle('demo', !!demoState.on);
}
async function loadDemo() { try { demoState = await bridge.call('demo:get'); } catch { demoState = { on: false }; } renderDemo(); renderHome(); return demoState; }
function demoNote(msg) { demoMsg = msg || ''; renderHome(); }
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
  await bridge.call('admin:lock').catch(() => null);
  await loadDemo(); await safe(refresh);
  // never set up a company: offer the normal set-up now
  if (r.neverSetUp && !retry && window.RiyeserCompany) window.RiyeserCompany.offerSetup();
}
window.RiyeserCentralDemo = { startDemo, loadDemo, askConfirm, state: () => demoState };
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-demo]'); if (!b) return;
  const a = b.dataset.demo; const T = window.RiyeserDemo.TEXT;
  if (a === 'try') safe(async () => { if ($('#admdlg').open) $('#admdlg').close(); await startDemo(); });
  if (a === 'leave') safe(async () => { if (await askConfirm({ title: 'Leave demo mode?', body: T.confirmLeave, ok: 'Leave demo mode' })) { if ($('#admdlg').open) $('#admdlg').close(); await leaveDemo(false); } });
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
// the paid programs' tiles say where they stand on the plan; anything that stops work is under "Needs attention"
function renderLicence() { if (today) renderHome(); if (adminOpen()) renderAdminSection('pcs'); }
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
  closePop();
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
  if (a === 'signin') { $('#licdlg').close(); $('#qclear').click(); setView('company'); }   // Your account's Riyeser account sign-in
  if (a === 'remove') safe(async () => { if (!(await askConfirm({ title: 'Remove the licence from this PC?', body: 'You can type the licence key in again any time.', ok: 'Remove it' }))) return; lic = await bridge.call('central:licenceRemove'); renderLicence(); openLicence(); });
});

// ---------- search: programs and their jobs, customers, files (one box) ----------
const finder = { q: '', type: null, year: null, kind: null };
let searchSeq = 0;
async function runSearch() {
  const active = finder.q.trim() || finder.type || finder.year || finder.kind;
  $('#results').hidden = !active; $('#home').hidden = !!active || view !== 'home'; $('#appsv').hidden = !!active || view !== 'apps'; $('#qclear').hidden = !active;
  closePop(); closeMenus();
  if (!active) return;
  const seq = ++searchSeq;
  const local = L9.searchLocal(finder.q, tileList);
  const acc = hasAcc() || has('invoices');
  const [people, r] = await Promise.all([
    acc && finder.q.trim().length > 1 && !finder.type && !finder.year && !finder.kind ? bridge.call('central:customers', finder.q).catch(() => []) : [],
    has('desk') ? bridge.call('search:find', { ...finder, limit: 150 }) : null,
  ]);
  if (seq !== searchSeq) return;   // a newer search is on its way
  const chipRow = (label, key, counts, order) => {
    const entries = Object.entries(counts).sort(order);
    if (!entries.length) return '';
    return `<div class="frow"><span class="flabel">${label}</span>${finder[key] ? `<button class="fchip on" data-f="${key}" data-v="">${esc(finder[key])} ✕</button>` : entries.slice(0, 20).map(([v, n]) => `<button class="fchip" data-f="${key}" data-v="${esc(v)}">${esc(v)} <span class="muted">${n}</span></button>`).join('')}</div>`;
  };
  const progRow = (x) => {
    const p = programs.find((q) => q.id === x.id) || { id: x.id, name: x.title };
    const attrs = x.kind === 'add' ? 'data-view="apps"' : x.kind === 'want' ? `data-install="${esc(x.id)}"` : x.act ? `data-act="${esc(x.act)}"` : x.id === 'team' && x.kind === 'program' ? 'data-act="team"' : `data-open="${esc(x.id)}" data-page="${esc(x.page || '')}"`;
    return `<button class="sres" ${attrs}>${x.kind === 'add' ? `<span class="sico">${icon('plus', 18)}</span>` : logo(p, 28)}<span class="grow"><b>${esc(x.title)}</b><small>${esc(x.sub || '')}</small></span><span class="go">Open</span></button>`;
  };
  const sections = [];
  if (local.length) sections.push(`<div class="panel rlist"><h3 class="rh">Programs</h3>${local.map(progRow).join('')}</div>`);
  if (people.length) sections.push(`<div class="panel rlist"><h3 class="rh">Customers</h3>${people.map((c) => `<button class="sres" data-open="${esc(accId() || 'invoices')}"><span class="sico">${icon('user', 18)}</span><span class="grow"><b>${esc(c.name)}</b><small>${esc([c.contact, c.email, c.phone].filter(Boolean).join(' · ') || 'Customer')}</small></span><span class="go">Open ${esc((programs.find((p) => p.id === (accId() || 'invoices')) || {}).name || '')}</span></button>`).join('')}</div>`);
  if (r) {
    sections.push(`<div class="filters">${chipRow('Type', 'type', r.facets.type, (a, b) => b[1] - a[1])}${chipRow('Year', 'year', r.facets.year, (a, b) => b[0].localeCompare(a[0]))}${chipRow('Kind', 'kind', r.facets.kind, (a, b) => b[1] - a[1])}</div>
    <div class="panel rlist"><h3 class="rh">Files <span class="lbl">${r.total.toLocaleString()} match${r.total === 1 ? '' : 'es'}${r.total > r.results.length ? ` — showing the best ${r.results.length}` : ''}</span></h3>
    ${r.results.length ? r.results.map((x) => `<div class="res">${fileIcon(x.name)}<div class="grow"><b>${esc(x.name)}</b>${x.formerNames.length ? ` <span class="lbl">· used to be ${esc(x.formerNames[x.formerNames.length - 1])}</span>` : ''}
        <div style="margin:3px 0"><span class="pill2">${esc(x.type)}</span><span class="pill2">${esc(x.year)}</span><span class="pill2">${esc(x.kind)}</span>${x.company ? `<span class="pill2">${esc(x.company)}</span>` : ''}</div>
        <div class="p">${esc(short(x.dir))}${x.snippet ? ` · …${esc(x.snippet)}…` : ''}</div></div>
        <button data-file="${esc(x.path)}">Open</button><button data-reveal="${esc(x.path)}">Show</button></div>`).join('')
      : `<div class="lbl" style="padding:4px 0 14px">No files match.${today && today.documents ? ' Search covers the documents in Riyeser Documents.' : ' If you just saved it, open Desk Assistant → Find a file → “Re-scan my folders”.'}</div>`}</div>`);
  } else if (!local.length && !people.length) {
    sections.push(`<div class="panel rlist"><p class="lbl" style="padding:14px 0">Nothing matches “${esc(finder.q)}”.${has('desk') ? '' : ' To search your files too, add Riyeser Documents.'}</p></div>`);
  }
  $('#results').innerHTML = `<div class="rtop"><h2>Results for “${esc(finder.q.trim() || 'your filters')}”</h2><button class="lnk" id="rclose">Back to your programs</button></div>${sections.join('')}`;
}

// ---------- 🔒 Admin panel (owner or admin + two-step code; locks again after 15 minutes without use) ----------
let adm = { state: null, sec: 'overview', biz: null, bizAt: 0, msg: '' };
const adminOpen = () => $('#admdlg').open;
const SECS = [
  ['overview', 'Overview'], ['pcs', 'PCs & licences'], ['people', 'People & access'], ['updates', 'Updates'], ['online', 'Online connections'],
  ['branches', 'Branches & relay'], ['backups', 'Backups'], ['help', 'Get help & diagnostics'], ['demo', 'Demo mode'], ['fresh', 'Fresh start'], ['advanced', 'Advanced'],
];
/** The sections this PC has: someone on their own (or a PC set up on its own) has no business sections. */
function admSections() {
  const a = who(); const biz = a.who !== 'individual' && (a.linked || a.demo);
  return SECS.filter(([id]) => (biz ? true : !['people', 'online', 'branches'].includes(id)))
    .map(([id, t]) => [id, id === 'pcs' && !biz ? 'Plan & licence' : t]);
}
async function adminReady() { try { adm.state = await bridge.call('admin:state'); } catch { return false; } return !!adm.state.open; }
async function openAdmin(sec) {
  closePop(); closeMenus();
  if (sec) adm.sec = sec;
  await adminReady();
  const d = $('#admdlg'); if (!d.open) d.showModal();
  backupBox(); freshBox();
  renderAdmin();
}
function renderAdmin() {
  const s = adm.state || { open: false, needed: true };
  const a = who();
  $('#admh').textContent = a.who === 'individual' ? 'Manage this PC' : '🔒 Admin';
  $('#admlockv').hidden = s.open; $('#admopen').hidden = !s.open; $('#admdlg').classList.toggle('locked', !s.open);
  $('#admlock').hidden = !(s.open && s.needed);
  $('#admwho').textContent = s.open && s.needed && s.email ? `Unlocked by ${s.email}` : a.who === 'individual' ? '' : !s.needed ? 'This PC isn\'t linked to an online business, so the panel isn\'t locked.' : '';
  if (!s.open) return renderLockView();
  const secs = admSections(); if (!secs.some(([id]) => id === adm.sec)) adm.sec = 'overview';
  const att = attentionItems().length;
  $('#admnav').innerHTML = secs.map(([id, t]) => `<button data-adm="${id}"${adm.sec === id ? ' aria-current="page" class="on"' : ''}>${esc(t)}${id === 'overview' && att ? ` <span class="nb">${att}</span>` : id === 'updates' && (upd.updates || []).length ? ` <span class="nb">${upd.updates.length}</span>` : ''}</button>`).join('');
  document.querySelectorAll('#admmain .admsec').forEach((x) => { x.hidden = x.dataset.sec !== adm.sec; });
  renderAdminSection(adm.sec);
}
function renderLockView(err = '') {
  const s = adm.state || {}; const co = coState(); const box = $('#admlockv');
  const email = co.role === 'owner' || co.role === 'admin' ? co.signedIn || '' : '';
  const biz = (co.company && co.company.name) || 'this business';
  if (s.pendingCode || adm.step === 'code') {
    box.innerHTML = `<div class="lockcard"><div class="lockic" aria-hidden="true">🔒</div><h3>Type your two-step code</h3><p class="lbl">Open your authenticator app and type the 6 numbers for Riyeser.</p>
      <form id="admcodef"><label class="wf"><span>Code</span><input name="code" id="admcode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required></label>
      ${s.demo ? '<p class="lbl">Demo mode: the code is <b>123456</b>.</p>' : ''}${err ? `<div class="werr" role="alert">${esc(err)}</div>` : ''}
      <div class="wrow"><button type="button" class="btn s" data-admback>Back</button><button class="btn">Unlock</button></div></form></div>`;
    $('#admcode').focus();
    $('#admcodef').onsubmit = (e) => { e.preventDefault(); const c = $('#admcode').value; safe(async () => {
      try { adm.state = await bridge.call('admin:code', c); adm.step = null; adm.biz = null; renderAdmin(); } catch (x) { renderLockView(x.message); } }); };
    return;
  }
  box.innerHTML = `<div class="lockcard"><div class="lockic" aria-hidden="true">🔒</div><h3>The Admin panel is locked</h3>
    <p class="lbl">PCs, people, updates, backups and the other settings for ${esc(biz)}. An owner or admin signs in with their Riyeser account and two-step code. It locks again after 15 minutes without use.</p>
    <form id="admunf">${s.demo ? '<p class="lbl">Demo mode: just press Next, then type <b>123456</b>.</p>' : `<label class="wf"><span>Owner or admin email</span><input name="email" type="email" autocomplete="username" required value="${esc(email)}" spellcheck="false" autocapitalize="none"></label>
      <label class="wf"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>`}
      ${err ? `<div class="werr" role="alert">${esc(err)}</div>` : ''}
      <div class="wrow"><button type="button" class="btn s" data-close>Cancel</button><button class="btn">Next</button></div></form></div>`;
  const f = $('#admunf'); const first = f.querySelector(email ? 'input[name=password]' : 'input'); (first || f.querySelector('.btn:not(.s)')).focus();
  f.onsubmit = (e) => { e.preventDefault(); const x = new FormData(f); safe(async () => {
    try { await bridge.call('admin:unlock', String(x.get('email') || ''), String(x.get('password') || '')); adm.step = 'code'; adm.state = await bridge.call('admin:state'); renderLockView(); } catch (z) { renderLockView(z.message); } }); };
}
const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`;
const whenAgo = (t) => (t ? ago(new Date(t).getTime()) : '—');
async function admBiz(force) {
  if (!force && adm.biz && Date.now() - adm.bizAt < 60000) return adm.biz;
  try { adm.biz = await bridge.call('admin:business'); adm.bizAt = Date.now(); } catch { adm.biz = null; }
  return adm.biz;
}
async function renderAdminSection(sec) {
  if (!adminOpen() || !(adm.state && adm.state.open)) return;
  const a = who(); const co = coState(); const c = co.company || {};
  const put = (id, html) => { const el = $(`#adm-${id}`); if (el) el.innerHTML = html; };
  if (sec === 'overview') {
    const att = attentionItems(); const n = programs.filter((p) => p.status !== 'missing').length;
    put('overview', `${att.length ? `<div class="attbox"><b>Needs attention</b><ul class="attl">${att.map((x) => `<li><div class="grow"><b>${esc(x.title)}</b>${x.detail ? `<small>${esc(x.detail)}</small>` : ''}</div>${x.act ? `<button class="btn sm" ${x.act.attrs}>${esc(x.act.label)}</button>` : ''}</li>`).join('')}</ul></div>` : '<div class="okbox">✓ Nothing needs attention. Everything on this PC is working.</div>'}
      <div class="kvs">${kv('This PC', `Riyeser Central ${esc(appVersion)}`)}${kv('Programs installed', String(n))}${a.who !== 'individual' ? kv('Business', esc(a.business || '—')) : ''}${kv('Signed in', esc(co.signedIn || (demoState.on ? 'Demo mode' : 'Not signed in')))}${kv('Updates', (upd.updates || []).length ? `${upd.updates.length} ready · <button class="lnk" data-adm="updates">See updates</button>` : 'Up to date')}${kv('Last backup', backups && backups.backups && backups.backups[0] ? esc(whenAgo(backups.backups[0].when)) : 'Not yet')}</div>`);
  }
  if (sec === 'pcs') {
    const o = lic && lic.online;
    const plan = o ? `<ul class="planrows sm">${o.rows.map((r) => `<li class="t-${r.tone}"><span></span><b>${esc(r.name)}</b><span class="pt">${esc(r.text)}</span></li>`).join('') || '<li><span></span><b>No paid programs yet</b><span class="pt">The free programs are always free.</span></li>'}</ul>`
      : `<p class="admp">${esc(licLine(lic))}.</p>`;
    put('pcs', `<h4>Your plan</h4>${plan}<div class="row"><button class="btn sm" data-lic="open">${o ? 'Plan details' : 'Licence'}</button>${o ? '<button class="btn sm s" data-lic="refresh">Check now</button>' : ''}</div>
      ${a.linked || a.demo ? '<h4>PCs linked to the business</h4><div id="admpcs" class="lbl">Reading…</div>' : ''}`);
    if (a.linked || a.demo) {
      const b = await admBiz();
      const el = $('#admpcs'); if (!el) return;
      el.outerHTML = b && b.pcs ? `<table class="tbl wide"><tr><th>PC</th><th>Riyeser Central</th><th>Last seen</th></tr>${b.pcs.map((p) => `<tr><td>${icon('pc', 16)} ${esc(p.name)}</td><td>${esc(p.version || '—')}</td><td>${esc(whenAgo(p.lastSeen))}</td></tr>`).join('') || '<tr><td colspan="3" class="lbl">No PCs yet.</td></tr>'}</table>
        <p class="lbl">To take a PC off the business, remove it in Riyeser Link → Management → PCs.</p>`
        : '<p class="lbl">Couldn\'t read the PCs right now. Check the internet and try again.</p>';
    }
  }
  if (sec === 'people') {
    const code = demoState.on ? 'RIY-7K3M-Q2' : c.company_code || '';
    put('people', `${code ? `<h4>Access link</h4><div class="wid sm"><span>${esc(code)}</span><button class="btn" data-copy="${esc(code)}">Copy</button></div><p class="lbl">Staff and other PCs join with this Company ID (or a branch code), and an owner or admin approves them.</p>` : ''}
      <h4>People</h4><div id="admppl" class="lbl">Reading…</div>
      <div class="row"><button class="btn sm" data-web="people">Manage people in Riyeser Link</button><button class="btn sm s" data-web="requests">Join requests</button></div>`);
    const b = await admBiz(); const el = $('#admppl'); if (!el) return;
    el.outerHTML = b && b.people ? `<p class="admp">${b.people.total} ${b.people.total === 1 ? 'person' : 'people'} · ${b.people.owners} owner${b.people.owners === 1 ? '' : 's'}, ${b.people.admins} admin${b.people.admins === 1 ? '' : 's'}${b.requests && b.requests.length ? ` · <b class="warn">${b.requests.length} waiting to join</b>` : ''}</p>
      <div class="ppl">${b.people.list.map((m) => `<span class="pp"><b>${esc(m.name)}</b> <small>${esc(m.role === 'member' ? 'staff' : m.role)}</small></span>`).join('')}</div>`
      : '<p class="lbl">Couldn\'t read the people right now.</p>';
  }
  if (sec === 'updates') {
    if (!versions) versions = await bridge.call('central:versions', false).catch(() => null);
    const v = versions || { installed: {}, latest: {}, channel: 'stable' };
    const ids = [...new Set(['central', ...Object.keys(v.installed), ...programs.filter((p) => p.status === 'installed').map((p) => p.id)])].filter((id) => id === 'central' || programs.some((p) => p.id === id)).sort(byOrder);
    if (!v.installed.central && appVersion) v.installed.central = appVersion;
    const nm = (id) => (id === 'central' ? 'Riyeser Central' : (programs.find((p) => p.id === id) || {}).full || id);
    if (!auto) auto = await bridge.call('central:autoUpdate').catch(() => null);
    const au = auto || { on: true, waiting: {} };
    const waitWhy = (id) => (au.on && !au.demo && au.waiting && au.waiting[id]) || '';
    put('updates', `${autoHtml(au)}<table class="tbl wide"><tr><th>Program</th><th>On this PC</th><th>Latest</th><th></th></tr>${ids.map((id) => { const u = (upd.updates || []).find((x) => x.id === id);
      return `<tr><td>${esc(nm(id))}</td><td>${esc(v.installed[id] || '—')}</td><td>${esc(v.latest[id] || '—')}</td><td${u && waitWhy(id) ? ` title="${esc(waitWhy(id))}"` : ''}>${u ? `<span class="warn">Update ready</span>${waitWhy(id) ? `<small class="uwhy">${esc(waitWhy(id))}</small>` : ''}` : v.latest[id] ? '<span class="ok">Up to date</span>' : ''}</td></tr>`; }).join('') || `<tr><td colspan="4" class="lbl">Versions show here once Central has checked.</td></tr>`}</table>
      <div class="row"><button class="btn sm s" id="admcheck">Check now</button><label class="inl">Updates channel <select id="admchan"><option value="stable"${v.channel === 'stable' ? ' selected' : ''}>Stable (recommended)</option><option value="early"${v.channel === 'early' ? ' selected' : ''}>Early access</option></select></label></div>
      <p class="lbl">${v.note ? `${esc(v.note)} ` : v.release ? `Release: ${esc(v.release)}. ` : ''}Early access gets new versions a little sooner, before everyone else.</p>`);
    $('#admcheck').onclick = () => safe(async () => { versions = await bridge.call('central:versions', true); await checkForUpdates(false, false); renderAdminSection('updates'); });
    const box = $('#admauto');
    if (box) box.onchange = (e) => safe(async () => { auto = await bridge.call('central:setAutoUpdate', e.target.checked); toast(e.target.checked ? 'Updates install by themselves now.' : 'Automatic updates are off. Use Update all when you\'re ready.'); renderAdminSection('updates'); renderHome(); });
    $('#admchan').onchange = (e) => safe(async () => { await bridge.call('central:setChannel', e.target.value); versions = null; toast(e.target.value === 'early' ? 'Early access is on for this PC.' : 'Back on the stable channel.'); await checkForUpdates(true); renderAdminSection('updates'); });
  }
  if (sec === 'online') put('online', '<p class="lbl">Bookings, orders and payments from your website come in through one PC. <button class="lnk" data-os="guide">Connect your website</button> · <button class="lnk" data-os="trail">Activity</button></p>');
  if (sec === 'branches') {
    put('branches', '<div id="admbr" class="lbl">Reading…</div>');
    const b = await admBiz(); const el = $('#admbr'); if (!el) return;
    const r = b && b.relay;
    el.outerHTML = !b ? '<p class="lbl">Couldn\'t read the branches right now.</p>' : `<h4>Branches</h4>${b.branches && b.branches.length ? `<div class="ppl">${b.branches.map((x) => `<span class="pp"><b>${esc(x.name)}</b></span>`).join('')}</div>` : '<p class="lbl">No branches. Everyone is in one place.</p>'}
      <h4>Calls between sites (relay)</h4>${r ? `<p class="admp">${r.enabled ? `On · ${r.relays} relay${r.relays === 1 ? '' : 's'}` : 'Off'}</p>${r.offices.length ? `<table class="tbl wide"><tr><th>Office PC</th><th>Link Office</th><th>Last seen</th><th>Relay</th></tr>${r.offices.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.version || '—')}</td><td>${esc(whenAgo(o.lastSeen))}</td><td>${o.revoked ? '<span class="bad">Removed</span>' : o.relay ? 'This PC is the relay' : ''}</td></tr>`).join('')}</table>` : ''}` : '<p class="lbl">Riyeser Link Office isn\'t set up for this business.</p>'}
      <div class="row">${has('linkoffice') ? '<button class="btn sm" data-open="linkoffice">Open Riyeser Link Office</button>' : ''}<button class="btn sm s" data-web="phones">Phones and sites in Riyeser Link</button></div>`;
  }
  if (sec === 'backups') {
    const el = $('#bklist'); const list = (backups && backups.backups) || [];
    if (el) el.innerHTML = list.length ? `<h4>Latest backups</h4><table class="tbl wide"><tr><th>Backup</th><th>When</th></tr>${list.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(whenAgo(b.when))}</td></tr>`).join('')}</table>`
      : '<p class="lbl">The first backup is made a minute or two after Riyeser Central starts.</p>';
  }
  if (sec === 'help') put('help', `<p class="admp">Something not working? Report it with this PC's technical details (never your records), or ask Riyeser Support.</p>
      <div class="row"><button class="btn sm" data-act="report">Report an issue</button><button class="btn sm s" data-act="gethelp">Get help</button><button class="btn sm s" data-web="requestsHelp">Your help requests</button><button class="btn sm s" data-help="central">Help pages</button></div>`);
  if (sec === 'demo') put('demo', demoState.on ? `<p class="admp"><b>Demo mode is on.</b> Every program shows practice data for ${esc(window.RiyeserDemo.BUSINESS)}. Your own records are safe and separate.</p><div class="row"><button class="btn sm" data-demo="leave">Leave demo mode</button></div>`
    : `<p class="admp">${esc(window.RiyeserDemo.TEXT.demoSub)}</p><div class="row"><button class="btn sm s" data-demo="try">${esc(window.RiyeserDemo.TEXT.tryButton)}</button></div>`);
  if (sec === 'advanced') put('advanced', `<div class="kvs">${kv('Riyeser Central', esc(appVersion))}${kv('Getting started', cl && cl.hidden ? '<button class="lnk" data-advshow>Show it again</button>' : 'Shown on the home screen')}</div>
      <p class="admp">A program installed somewhere unusual? Point Central to it from <button class="lnk" data-view="apps">Add a program</button> → Locate….</p>
      ${adm.state && adm.state.needed ? '<div class="row"><button class="btn sm s" data-admlock>Lock the Admin panel now</button></div>' : ''}`);
}
async function admLock(msg = '') {
  await bridge.call('admin:lock').catch(() => null); adm.state = await bridge.call('admin:state').catch(() => adm.state); adm.step = null; adm.biz = null;
  renderAdmin(); if (msg) renderLockView(msg);
}
// re-locks after 15 minutes without use (the main process keeps the time; anything done in the panel restarts it)
let admTouchAt = 0;
['pointerdown', 'keydown'].forEach((ev) => $('#admdlg').addEventListener(ev, () => { if (adm.state && adm.state.open && adm.state.needed && Date.now() - admTouchAt > 20000) { admTouchAt = Date.now(); bridge.call('admin:touch').then((s) => { adm.state = s; }).catch(() => {}); } }, true));
setInterval(async () => {
  if (!adminOpen() || !adm.state || !adm.state.needed || !adm.state.open) return;
  const s = await bridge.call('admin:state').catch(() => null);
  if (s && !s.open) { adm.state = s; adm.step = null; renderAdmin(); renderLockView('Locked again after 15 minutes without use. Sign in to carry on.'); }
}, 20000);
$('#admdlg').addEventListener('close', freshReset);
$('#admdlg').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) { $('#admdlg').close(); return; }
  const n = e.target.closest('[data-adm]'); if (n) { adm.sec = n.dataset.adm; renderAdmin(); const f = $(`#admnav [data-adm="${adm.sec}"]`); if (f) f.focus(); return; }
  if (e.target.closest('#admlock, [data-admlock]')) { admLock(); return; }
  if (e.target.closest('[data-admback]')) { adm.step = null; safe(async () => { await bridge.call('admin:lock'); adm.state = await bridge.call('admin:state'); renderAdmin(); }); return; }
  if (e.target.closest('[data-advshow]')) { safe(async () => { await setChecklistHidden(false); renderAdminSection('advanced'); }); }
});
$('#admnav').addEventListener('keydown', (e) => {
  const items = [...$('#admnav').querySelectorAll('button')]; const i = items.indexOf(document.activeElement); if (i < 0) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const j = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[j].focus(); items[j].click(); }
});

// ---------- the avatar menu: your account, Settings, Help, Sign out ----------
function renderAvMenu() {
  const s = coState(); const a = who();
  const head = `<div class="mhead"><b>${esc((s.company && s.company.your_name) || (demoState.on ? 'Ricky (demo)' : s.signedIn ? s.signedIn.split('@')[0] : 'Not signed in'))}</b><small>${esc(s.signedIn || (a.who === 'individual' ? 'On this PC' : a.business))}</small></div>`;
  $('#avmenu').innerHTML = `${head}<button role="menuitem" data-av="account">${icon('user', 16)}Your account</button><button role="menuitem" data-av="settings">${icon('gear', 16)}Settings</button>
    <button role="menuitem" data-av="help">${icon('help', 16)}Help</button>${a.who === 'individual' ? `<button role="menuitem" data-av="manage">${icon('pc', 16)}Manage this PC</button>` : ''}<hr>
    ${s.signedIn ? `<button role="menuitem" data-w="signout">${icon('out', 16)}Sign out</button>` : `<button role="menuitem" data-w="link">${icon('key', 16)}Sign in</button>`}`;
}
function openAccount() { closeMenus(); if (window.RiyeserCompany) window.RiyeserCompany.renderCompany(); const d = $('#acctdlg'); if (!d.open) d.showModal(); }
function openHelp() {
  closeMenus();
  const mine = programs.filter((p) => p.status !== 'missing');
  $('#helpbody').innerHTML = `<div class="hlist"><button class="hrow" data-help="central"><b>Riyeser Central guide</b><small>Your programs, search, the Admin panel</small></button>
      ${mine.map((p) => `<button class="hrow" data-help="${esc(p.id)}">${logo(p, 22)}<span><b>${esc(p.full)}</b><small>How to use it</small></span></button>`).join('')}</div>
    <div class="row"><button class="btn sm" data-act="gethelp">Get help from Riyeser Support</button><button class="btn sm s" data-act="report">Report an issue</button>${cl && !cl.hidden && !cl.demo ? '<button class="btn sm s" data-helpcl>Getting started</button>' : ''}</div>
    <p class="lbl">Riyeser Central ${esc(appVersion)}. Shows information from your other Riyeser programs and never changes it.</p>`;
  $('#helpdlg').showModal();
}
$('#avbtn').addEventListener('click', (e) => {
  e.stopPropagation(); const m = $('#avmenu');
  if (!m.hidden) return closeMenus(true);
  closePop(); closeMenus(); renderAvMenu(); m.hidden = false; $('#avbtn').setAttribute('aria-expanded', 'true'); m.querySelector('[role=menuitem]').focus();
});
$('#avmenu').addEventListener('keydown', (e) => menuKeys(e, $('#avmenu')));
$('#tmenu').addEventListener('keydown', (e) => menuKeys(e, $('#tmenu')));
$('#adminbtn').addEventListener('click', () => openAdmin());
$('#pill').addEventListener('click', (e) => openPop('attention', e.currentTarget));
// the wizard (sign in, set up again) is drawn over the page, so the dialogs it's opened from get out of its way
document.addEventListener('click', (e) => {
  const w = e.target.closest('[data-w="link"], [data-w="restart"], [data-w="local"], [data-w="co-signup"]');
  if (w) { closePop(); closeMenus(); ['#acctdlg', '#admdlg', '#helpdlg', '#setdlg'].forEach((d) => { if ($(d).open) $(d).close(); }); }
}, true);

// ---------- events ----------
document.addEventListener('click', (e) => {
  if (!e.target.closest('#pop, #pill, [data-chip]') && !$('#pop').hidden) closePop();
  if (!e.target.closest('#tmenu, [data-tmenu]') && !e.target.closest('#avmenu, #avbtn')) closeMenus();
  const av = e.target.closest('[data-av]');
  if (av) { const a = av.dataset.av; closeMenus(); if (a === 'account') openAccount(); if (a === 'settings') openSettings(); if (a === 'help') openHelp(); if (a === 'manage') openAdmin('overview'); return; }
  const tm = e.target.closest('[data-tmenu]');
  if (tm) { e.stopPropagation(); if (menuFor === tm.dataset.tmenu) return closeMenus(true); const r = tm.getBoundingClientRect(); openTileMenu(tm.dataset.tmenu, { x: r.left, y: r.bottom + 4 }); return; }
  const ta = e.target.closest('[data-tact]');
  if (ta) { safe(() => tileAction(ta.dataset.tact, ta.dataset.id)); return; }
  const ch = e.target.closest('[data-chip]');
  if (ch) { const c = L9.chips({ programs, today: today || {}, sync, cl }).find((x) => x.id === ch.dataset.chip); if (c && c.pop) openPop(c.pop, ch); else if (c && c.open) safe(() => bridge.call('central:open', c.open, null)); return; }
  const ar = e.target.closest('[data-autoretry]');
  if (ar) { closePop(); safe(async () => { toast('Trying again in the background…'); auto = await bridge.call('central:autoRetry', ar.dataset.autoretry); renderHome(); }); return; }
  const ag = e.target.closest('[data-adm-go]');
  if (ag) { if (ag.dataset.admGo === 'updates') updError = ''; openAdmin(ag.dataset.admGo); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { safe(() => bridge.call('company:copy', cp.dataset.copy)).then(() => toast('Company ID copied')); return; }
  const wb = e.target.closest('[data-web]');
  if (wb) { safe(() => bridge.call('central:openWeb', wb.dataset.web)); return; }
  if (e.target.closest('[data-helpcl]')) { $('#helpdlg').close(); const c = document.querySelector('[data-chip="started"]'); if (c) openPop('checklist', c); return; }
  if (e.target.closest('#rclose')) { $('#qclear').click(); return; }
  const loc = e.target.closest('[data-locate]');
  if (loc) { e.stopPropagation(); safe(async () => { const f = await bridge.call('central:locate', loc.dataset.locate); if (f) { toast('Got it. It\'s on your home screen now.'); refresh(); } }); return; }
  const get = e.target.closest('[data-get]');
  if (get) { e.stopPropagation(); safe(() => bridge.call('central:get', get.dataset.get)); return; }
  const hb = e.target.closest('[data-help]');
  if (hb) { closeMenus(); safe(() => bridge.call('central:help', hb.dataset.help)); return; }
  const ih = e.target.closest('[data-insthelp]');
  if (ih) { safe(() => installHelp(ih.dataset.insthelp)); return; }
  const ib = e.target.closest('[data-install]');
  if (ib) { closePop(); installApp(ib.dataset.install); return; }
  const vw = e.target.closest('[data-view]');
  if (vw) { if ($('#admdlg').open) $('#admdlg').close(); if (!$('#results').hidden) $('#qclear').click(); setView(vw.dataset.view); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    closeMenus(); closePop();
    if (act.dataset.act === 'find') { $('#qclear').click(); setView('home'); $('#q').focus(); }
    if (act.dataset.act === 'team') safe(() => bridge.call('central:team'));
    if (act.dataset.act === 'gethelp') safe(() => bridge.call('central:getHelp'));
    if (act.dataset.act === 'report') safe(() => reportIssue());
    if (act.dataset.act === 'pickpdf') safe(() => bridge.call('central:openPdf'));
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open) { closeMenus(); closePop(); safe(() => bridge.call('central:open', open.dataset.open, open.dataset.page || null)); return; }
  const file = e.target.closest('[data-file]');
  if (file) { safe(() => bridge.call('file:open', file.dataset.file)); return; }
  const rev = e.target.closest('[data-reveal]');
  if (rev) { safe(() => bridge.call('file:reveal', rev.dataset.reveal)); return; }
  const chip = e.target.closest('[data-f]');
  if (chip) { finder[chip.dataset.f] = chip.dataset.v || null; safe(runSearch); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#tmenu').hidden || !$('#avmenu').hidden) { e.preventDefault(); closeMenus(true); return; }
    if (!$('#pop').hidden) { e.preventDefault(); closePop(true); return; }
  }
  // the tile menu from the keyboard: the Menu key or Shift+F10 on a tile
  const t = document.activeElement && document.activeElement.closest && document.activeElement.closest('#tiles [data-tile]');
  if (t && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) { e.preventDefault(); const r = t.getBoundingClientRect(); openTileMenu(t.dataset.tile, { x: r.left + 12, y: r.bottom - 8 }); }
  // Ctrl+K or / jumps to the search box
  if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || ''))) { if (!document.querySelector('dialog[open]')) { e.preventDefault(); $('#q').focus(); } }
});
let timer;
$('#q').addEventListener('input', (e) => { finder.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => safe(runSearch), 150); });
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#qclear').click();
  if (e.key === 'Enter') { const first = $('#results .sres, #results [data-file]'); if (first) { e.preventDefault(); first.click(); } }
  if (e.key === 'ArrowDown') { const first = $('#results .sres, #results button'); if (first) { e.preventDefault(); first.focus(); } }
});
$('#qclear').addEventListener('click', () => { $('#q').value = ''; Object.assign(finder, { q: '', type: null, year: null, kind: null }); safe(runSearch); $('#q').focus(); });
if (bridge && bridge.on) bridge.on('online-sync', (s) => { sync = s; renderHome(); });
// the automatic updates: quietly redrawn (an update went in, one is waiting, one needs a look)
if (bridge && bridge.on) bridge.on('auto-update', (a) => { const had = auto && auto.last && auto.last.at; auto = a; renderHome(); if (adminOpen() && adm.sec === 'updates') renderAdminSection('updates'); if (a && a.last && a.last.at !== had) checkForUpdates(true); });

let appVersion = '';
(async () => {
  appVersion = await bridge.call('app:version').catch(() => '');
  document.title = `Riyeser Central ${appVersion}`;
  $('#setver').textContent = `Riyeser Central ${appVersion}. Shows information from your other Riyeser programs and never changes it.`;
  await loadDemo();
  await safe(refresh);
  auto = await bridge.call('central:autoUpdate').catch(() => null);
  checkForUpdates(false);
  loadLicence();
  setInterval(loadLicence, 6 * 3600 * 1000);
  setInterval(() => { if ($('#results').hidden) safe(refresh); }, 5 * 60 * 1000);
  setInterval(() => checkForUpdates(false), 6 * 3600 * 1000);
  setInterval(() => { if ($('#home').hidden === false) renderHome(); }, 60 * 1000);   // the greeting and the date
  window.addEventListener('focus', () => { if ($('#results').hidden) safe(refresh); });
  setInterval(() => { if (view === 'home' && $('#results').hidden && !document.hidden && !installing) loadChecklist(); }, 60 * 1000);
  bridge.on('licence-changed', () => loadChecklist());
})();
window.RiyeserCentralHome = { renderHome, openAdmin, openSettings, openHelp, openAccount, tiles: () => tileList, attention: attentionItems };
