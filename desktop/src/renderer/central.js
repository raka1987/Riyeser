// Riyser Central home screen ("Launcher" design).
// Shows only what this customer has: tiles for installed programs, panels only when their program's data is there,
// and one "More Riyser apps" tile for anything not installed.
const $ = (s, el = document) => el.querySelector(s);
const bridge = window.api;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const moneyShort = (n) => `$${Math.round(Number(n || 0)).toLocaleString()}`;
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: 'short' });
const fmtDate = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
const isToday = (d) => new Date(d).toDateString() === new Date().toDateString();
const fileIcon = (n) => /\.pdf$/i.test(n) ? '📕' : /\.(docx?|odt|rtf)$/i.test(n) ? '📘' : /\.(xlsx?|xlsm|csv|ods)$/i.test(n) ? '📗' : /\.(pptx?)$/i.test(n) ? '📙' : /\.(jpe?g|png|heic|gif|webp)$/i.test(n) ? '🖼' : /\.(dwg|dxf)$/i.test(n) ? '📐' : '📄';
const short = (p) => p.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, '~');
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4200); }
async function safe(fn) { try { return await fn(); } catch (e) { toast(e.message); return null; } }

// ---------- light / dark ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#theme').textContent = t === 'light' ? '☾' : '☀';
  $('#theme').title = t === 'light' ? 'Switch to dark' : 'Switch to light';
}
let theme = 'dark';
try { theme = localStorage.getItem('central-theme') || 'dark'; } catch { /* storage unavailable */ }
applyTheme(theme);
$('#theme').addEventListener('click', () => { theme = theme === 'light' ? 'dark' : 'light'; applyTheme(theme); try { localStorage.setItem('central-theme', theme); } catch { /* ignore */ } });

// ---------- clock ----------
function tick() {
  const n = new Date();
  $('#time').textContent = n.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
  $('#date').textContent = n.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}
tick(); setInterval(tick, 15000);

// ---------- home ----------
let programs = []; let today = null; let upd = { updates: [] }; let updating = false;
const has = (id) => programs.some((p) => p.id === id && p.status !== 'missing');

function tileSub(p) {
  if (p.status === 'missing') return 'Not on this computer';
  const m = today && today.money;
  if (p.id === 'accounting') return m && m.found ? (m.totals.owedToYou ? `${moneyShort(m.totals.owedToYou)} owed to you` : 'All invoices paid') : 'Set up your company';
  if (p.id === 'desk') return today && today.tasks.length ? `${today.tasks.length} to-do${today.tasks.length === 1 ? '' : 's'} · find & sort files` : 'Find & sort your files';
  if (p.id === 'payroll') return 'Timesheets · pay runs · payslips';
  if (p.id === 'pdf') return 'Fill · sign · edit';
  if (p.id === 'services') return p.where;
  return p.desc;
}
function renderTiles() {
  const mine = programs.filter((p) => p.status !== 'missing');
  const others = programs.filter((p) => p.status === 'missing');
  const upFor = new Set((upd.updates || []).map((u) => u.id));
  $('#tiles').innerHTML = mine.map((p) => `<button class="tile t-${esc(p.id)}" data-open="${esc(p.id)}" title="${esc(p.where || '')}">
      ${upFor.has(p.id) ? '<span class="badge">⬆ Update</span>' : ''}<div class="i">${p.icon}</div><div><b>${esc(p.name)}</b><small>${esc(tileSub(p))}</small></div></button>`).join('')
    + (others.length ? `<div class="tile glass more"><div class="i">➕</div><div><b style="color:var(--text)">More Riyser apps</b>
        <small class="muted">${others.map((p) => `${esc(p.name)} <button class="link" data-locate="${esc(p.id)}" title="Already installed somewhere else? Point me to it">Locate…</button>`).join('<br>')}</small></div></div>` : '');
}
function renderMoney() {
  const m = today.money;
  const box = $('#money').closest('.w');
  box.hidden = !has('accounting') && !(m && m.found); // no Accounting, no Money panel
  if (box.hidden) return;
  if (!m || !m.found) { $('#money').innerHTML = `<div class="lbl">${m && m.error ? `Couldn't read your books: ${esc(m.error)}` : 'Open Accounting and set up your company to see money owed and owing here.'}</div>`; return; }
  const t = m.totals; const notDue = Math.max(0, t.owedToYou - t.overdueToYou);
  const pct = t.owedToYou ? Math.round((t.overdueToYou / t.owedToYou) * 100) : 0;
  const chase = m.receivables.filter((r) => r.overdue).sort((a, b) => String(a.due).localeCompare(String(b.due))).slice(0, 2);
  const nextBill = m.payables.slice().sort((a, b) => (b.overdue - a.overdue) || String(a.due).localeCompare(String(b.due)))[0];
  $('#money').innerHTML = `<div class="big num">${money(t.owedToYou)}</div><div class="lbl">customers owe you</div>
    <div class="bar"><i style="width:${pct}%;background:var(--bad)"></i><i style="width:${100 - pct}%;background:var(--ok)"></i></div>
    <div class="lbl">${moneyShort(t.overdueToYou)} overdue · ${moneyShort(notDue)} not yet due</div>
    ${chase.map((r) => `<div class="li"><span class="grow">Chase ${esc(r.contact)} <span class="lbl">${esc(r.number)}</span></span><span class="amt num bad">${money(r.owing)}</span></div>`).join('')}
    <div class="li"><span class="h">You owe</span><span class="grow"><b class="num">${money(t.youOwe)}</b>${nextBill ? ` <span class="lbl">· next: ${esc(nextBill.contact)} ${nextBill.due ? (nextBill.overdue ? '<span class="bad">overdue</span>' : `due ${fmtDate(nextBill.due)}`) : ''}</span>` : ''}</span></div>`;
}
function renderToday() {
  const box = $('#today').closest('.w');
  box.hidden = !today.deskFound; // calendars live in Desk Assistant
  if (box.hidden) return;
  if (!today.calendars) { $('#today').innerHTML = '<div class="lbl">Connect a calendar in Desk Assistant → Settings → Calendars to see your meetings here.</div>'; return; }
  $('#today').innerHTML = today.meetings.length ? today.meetings.slice(0, 6).map((m) => `<div class="li"><span class="h">${isToday(m.start) ? (m.allDay ? 'All day' : fmtTime(m.start)) : fmtDay(m.start)}</span><span class="grow">${esc(m.title)}${m.location ? ` <span class="lbl">· ${esc(m.location)}</span>` : ''}</span>${m.link ? `<a class="link" href="${esc(m.link)}" target="_blank">Join</a>` : ''}</div>`).join('')
    : '<div class="lbl">No meetings today or tomorrow. 🎉</div>';
  if (today.meetingErrors.length) $('#today').innerHTML += `<div class="lbl warn" style="margin-top:6px">Couldn't read: ${esc(today.meetingErrors.join(', '))}</div>`;
}
function renderTodo() {
  const box = $('#todo').closest('.w');
  box.hidden = !today.deskFound; // the to-do list belongs to Desk Assistant
  if (box.hidden) return;
  $('#todo').innerHTML = today.tasks.length ? today.tasks.slice(0, 6).map((x) => `<div class="li"><span>☐</span><span class="grow">${esc(x.text)}</span>${x.due ? `<span class="lbl warn">${esc(x.due)}</span>` : ''}</div>`).join('')
      + (today.tasks.length > 6 ? `<div class="lbl" style="margin-top:6px">+ ${today.tasks.length - 6} more in Desk Assistant</div>` : '')
    : '<div class="lbl">Nothing outstanding. 🎉</div>';
}
function renderRecent() {
  $('#recent').innerHTML = today.recent.length ? today.recent.slice(0, 10).map((r) => `<div class="glass doc" data-file="${esc(r.path)}" title="${esc(r.path)}">${fileIcon(r.name)} <span>${esc(r.name)}</span></div>`).join('')
    : '<div class="lbl">Files you open will show up here.</div>';
}
function layoutWidgets() {
  // fill the row with whichever panels this customer has
  const shown = [...document.querySelectorAll('.widgets .w')].filter((w) => !w.hidden).length;
  $('.widgets').style.gridTemplateColumns = shown ? `repeat(${shown}, minmax(0, 1fr))` : '';
  $('.widgets').hidden = !shown;
}
async function refresh() {
  [programs, today] = await Promise.all([bridge.call('central:programs'), bridge.call('central:today')]);
  renderTiles(); renderMoney(); renderToday(); renderTodo(); renderRecent(); layoutWidgets();
}

// ---------- updates ----------
function renderUpdates() {
  const box = $('#updates');
  const list = upd.updates || [];
  if (!list.length && !updating) { box.hidden = true; return; }
  box.hidden = false;
  if (updating) return; // progress is drawn by the update-progress events
  box.innerHTML = `<div style="font-size:24px">⬆</div><div class="grow"><b>${list.length === 1 ? 'An update is ready' : `${list.length} updates are ready`}</b>
    <div class="lbl">${list.map((u) => `${esc(u.name)} ${esc(u.from)} → ${esc(u.to)}`).join(' · ')}</div></div>
    <button class="go" id="updall">Update ${list.length === 1 ? '' : 'all'}</button>`;
  $('#updall').addEventListener('click', () => safe(async () => {
    updating = true;
    box.innerHTML = '<div style="font-size:24px">⬇</div><div class="grow"><b id="updmsg">Getting ready…</b><div class="prog"><i id="updbar"></i></div><div class="lbl">Your information is kept. Programs being updated will close for a moment.</div></div>';
    try {
      const r = await bridge.call('central:installUpdates', null);
      if (r.restarting) { $('#updmsg').textContent = 'Riyser Central is restarting to finish updating…'; return; }
      toast(`Updated ${r.done.length} program${r.done.length === 1 ? '' : 's'}.`);
    } catch (e) { toast(e.message); }
    updating = false;
    await checkForUpdates(true);
  }));
}
async function checkForUpdates(force, quiet = true) {
  try { upd = await bridge.call('central:updates', force); } catch (e) { if (!quiet) toast(e.message); return; }
  renderUpdates(); renderTiles();
  if (!quiet) toast(upd.updates.length ? `${upd.updates.length} update${upd.updates.length === 1 ? '' : 's'} available.` : upd.note || 'Everything is up to date.');
}
bridge.on('update-progress', (p) => {
  const msg = $('#updmsg'); const bar = $('#updbar'); if (!msg) return;
  msg.textContent = p.stage === 'downloading' ? `Downloading ${p.name}… ${Math.round(p.pct * 100)}%` : p.stage === 'installing' ? `Installing ${p.name}…` : `Restarting Riyser Central…`;
  bar.style.width = `${Math.round((p.stage === 'downloading' ? p.pct : 1) * 100)}%`;
});
$('#checkupd').addEventListener('click', () => checkForUpdates(true, false));

// ---------- search ----------
const finder = { q: '', type: null, year: null, kind: null };
async function runSearch() {
  const active = finder.q.trim() || finder.type || finder.year || finder.kind;
  $('#results').hidden = !active; $('#home').hidden = !!active; $('#qclear').hidden = !active;
  if (!active) return;
  const r = await bridge.call('search:find', { ...finder, limit: 150 });
  const chipRow = (label, key, counts, order) => {
    const entries = Object.entries(counts).sort(order);
    if (!entries.length) return '';
    return `<div class="frow"><span class="flabel">${label}</span>${finder[key] ? `<button class="fchip on" data-f="${key}" data-v="">${esc(finder[key])} ✕</button>` : entries.slice(0, 20).map(([v, n]) => `<button class="fchip" data-f="${key}" data-v="${esc(v)}">${esc(v)} <span class="muted">${n}</span></button>`).join('')}</div>`;
  };
  $('#results').innerHTML = `<div class="filters">${chipRow('Type', 'type', r.facets.type, (a, b) => b[1] - a[1])}${chipRow('Year', 'year', r.facets.year, (a, b) => b[0].localeCompare(a[0]))}${chipRow('Kind', 'kind', r.facets.kind, (a, b) => b[1] - a[1])}</div>
    <div class="glass rlist"><div class="lbl" style="padding:8px 0">${r.total.toLocaleString()} match${r.total === 1 ? '' : 'es'}${r.total > r.results.length ? ` — showing the best ${r.results.length}` : ''}</div>
    ${r.results.length ? r.results.map((x) => `<div class="r"><div style="font-size:22px">${fileIcon(x.name)}</div><div class="grow"><b>${esc(x.name)}</b>${x.formerNames.length ? ` <span class="lbl">· used to be ${esc(x.formerNames[x.formerNames.length - 1])}</span>` : ''}
        <div style="margin:3px 0"><span class="pill">${esc(x.type)}</span><span class="pill">${esc(x.year)}</span><span class="pill">${esc(x.kind)}</span>${x.company ? `<span class="pill">${esc(x.company)}</span>` : ''}</div>
        <div class="p">${esc(short(x.dir))}${x.snippet ? ` · …${esc(x.snippet)}…` : ''}</div></div>
        <button data-file="${esc(x.path)}">Open</button><button data-reveal="${esc(x.path)}">Show</button></div>`).join('')
      : `<div class="lbl" style="padding:12px 0 16px">No matches.${has('desk') ? ' If you just saved it, open Desk Assistant → Find a file → “Re-scan my folders”.' : ' Search uses Riyeser Desk Assistant’s file list — install it to search all your files.'}</div>`}</div>`;
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const loc = e.target.closest('[data-locate]');
  if (loc) { e.stopPropagation(); safe(async () => { const f = await bridge.call('central:locate', loc.dataset.locate); if (f) { toast('Got it — it\'s on your home screen now.'); refresh(); } }); return; }
  const open = e.target.closest('[data-open]');
  if (open) { safe(() => bridge.call('central:open', open.dataset.open)); return; }
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
  document.title = `Riyser Central ${v}`;
  $('#foot').textContent = `Riyser Central ${v} · Riyser Group · shows information from your other Riyeser programs; it never changes it.`;
  await safe(refresh);
  checkForUpdates(false);
  setInterval(() => { if ($('#results').hidden) safe(refresh); }, 5 * 60 * 1000);
  setInterval(() => checkForUpdates(false), 6 * 3600 * 1000);
  window.addEventListener('focus', () => { if ($('#results').hidden) safe(refresh); });
})();
