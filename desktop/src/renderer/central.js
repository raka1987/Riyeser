// Riyser Central home screen.
const $ = (s, el = document) => el.querySelector(s);
const bridge = window.api;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDate = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
const fileIcon = (n) => /\.pdf$/i.test(n) ? '📕' : /\.(docx?|odt|rtf)$/i.test(n) ? '📘' : /\.(xlsx?|xlsm|csv|ods)$/i.test(n) ? '📗' : /\.(pptx?)$/i.test(n) ? '📙' : /\.(jpe?g|png|heic|gif|webp)$/i.test(n) ? '🖼' : /\.(dwg|dxf)$/i.test(n) ? '📐' : '📄';
const short = (p) => p.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, '~');
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4200); }
async function safe(fn) { try { return await fn(); } catch (e) { toast(e.message); return null; } }

// ---------- programs ----------
async function renderPrograms() {
  const list = await bridge.call('central:programs');
  $('#programs').innerHTML = list.map((p) => `<div class="pcard" data-open="${esc(p.id)}" title="${esc(p.where || '')}">
    <div class="pi">${p.icon}</div><h3>${esc(p.name)}</h3><div class="pd">${esc(p.desc)}</div>
    <div class="ps">${p.status === 'installed' ? '<span class="dot ok"></span> Installed' : p.status === 'online' ? `<span class="dot web"></span> Online · ${esc(p.where)}` : '<span class="dot no"></span> Not found on this computer'}
      ${p.status === 'missing' ? `<button class="link small" data-locate="${esc(p.id)}">Locate…</button>` : ''}</div></div>`).join('');
}

// ---------- today ----------
async function renderToday() {
  const t = await bridge.call('central:today');
  // meetings
  $('#meetings').className = '';
  $('#meetings').innerHTML = !t.calendars ? '<div class="empty small">No calendar connected. Add one in Desk Assistant → Settings → Calendars to see meetings here.</div>'
    : t.meetings.length ? t.meetings.map((m) => `<div class="mline"><span class="mtime">${m.allDay ? 'All day' : fmtTime(m.start)}<div class="small muted">${fmtDay(m.start)}</div></span>
        <div class="grow"><b>${esc(m.title)}</b>${m.location ? `<div class="small muted">${esc(m.location)}</div>` : ''}</div>${m.link ? `<a class="small" href="${esc(m.link)}" target="_blank">Join</a>` : ''}</div>`).join('')
      : '<div class="empty small">No meetings today or tomorrow.</div>';
  if (t.meetingErrors.length) $('#meetings').innerHTML += `<div class="small" style="color:var(--warn)">Couldn't read: ${esc(t.meetingErrors.join(', '))}</div>`;
  // to-dos
  $('#tasks').className = '';
  $('#tasks').innerHTML = !t.deskFound ? '<div class="empty small">Install Riyeser Desk Assistant to keep a to-do list (it picks up action items from your meeting notes).</div>'
    : t.tasks.length ? t.tasks.map((x) => `<div class="mline"><span>☐</span><div class="grow">${esc(x.text)}${x.meeting ? `<div class="small muted">from ${esc(x.meeting)}</div>` : ''}</div>${x.due ? `<span class="pill warn">${esc(x.due)}</span>` : ''}</div>`).join('')
        + '<div class="small muted" style="margin-top:6px">Tick items off in Desk Assistant → To-do.</div>'
      : '<div class="empty small">Nothing outstanding. 🎉</div>';
  // money
  const m = t.money;
  $('#money').className = '';
  if (!m || !m.found) {
    $('#money').innerHTML = `<div class="empty small">${m && m.error ? `Couldn't read your books: ${esc(m.error)}` : 'No company file yet. Open Accounting and set up your company to see money owed and owing here.'}</div>`;
  } else {
    const line = (r) => `<div class="mline"><div class="grow"><b>${esc(r.contact)}</b> <span class="small muted">${esc(r.number)}</span><div class="small ${r.overdue ? '' : 'muted'}" ${r.overdue ? 'style="color:var(--bad)"' : ''}>${r.due ? `${r.overdue ? 'overdue since' : 'due'} ${fmtDate(r.due)}` : 'no due date'}</div></div><span class="amount">${money(r.owing)}</span></div>`;
    const top = (list) => list.slice().sort((a, b) => (b.overdue - a.overdue) || String(a.due).localeCompare(String(b.due))).slice(0, 4);
    $('#money').innerHTML = `${m.company ? `<div class="small muted" style="margin-bottom:8px">${esc(m.company)}</div>` : ''}
      <div class="money-tot"><div><div class="k">Customers owe you</div><div class="v">${money(m.totals.owedToYou)}</div>${m.totals.overdueToYou ? `<div class="small" style="color:var(--bad)">${money(m.totals.overdueToYou)} overdue</div>` : ''}</div>
        <div><div class="k">You owe suppliers</div><div class="v">${money(m.totals.youOwe)}</div>${m.totals.overdueYouOwe ? `<div class="small" style="color:var(--bad)">${money(m.totals.overdueYouOwe)} overdue</div>` : ''}</div></div>
      ${m.receivables.length ? `<div class="small"><b>To chase</b></div>${top(m.receivables).map(line).join('')}` : ''}
      ${m.payables.length ? `<div class="small" style="margin-top:8px"><b>To pay</b></div>${top(m.payables).map(line).join('')}` : ''}
      <div style="margin-top:8px"><button class="link small" data-open="accounting">Open Accounting →</button></div>`;
  }
  // recent documents
  $('#recent').className = 'recent';
  $('#recent').innerHTML = t.recent.length ? t.recent.map((r) => `<div class="ritem" data-file="${esc(r.path)}" title="${esc(r.path)}"><span>${fileIcon(r.name)}</span><div style="min-width:0"><div class="rn">${esc(r.name)}</div><div class="rd">${esc(short(r.dir))}</div></div></div>`).join('')
    : '<div class="empty small">No recent documents yet.</div>';
}

// ---------- search ----------
const finder = { q: '', type: null, year: null, kind: null };
async function runSearch() {
  const active = finder.q.trim() || finder.type || finder.year || finder.kind;
  $('#search').hidden = !active; $('#home').hidden = !!active; $('#qclear').hidden = !active;
  if (!active) return;
  const r = await bridge.call('search:find', { ...finder, limit: 150 });
  const chipRow = (label, key, counts, order) => {
    const entries = Object.entries(counts).sort(order);
    if (!entries.length) return '';
    return `<div class="frow"><span class="flabel">${label}</span>${finder[key] ? `<button class="fchip on" data-f="${key}" data-v="">${esc(finder[key])} ✕</button>` : entries.slice(0, 20).map(([v, n]) => `<button class="fchip" data-f="${key}" data-v="${esc(v)}">${esc(v)} <span class="muted">${n}</span></button>`).join('')}</div>`;
  };
  $('#search').innerHTML = `<div class="sfilters">${chipRow('Type', 'type', r.facets.type, (a, b) => b[1] - a[1])}${chipRow('Year', 'year', r.facets.year, (a, b) => b[0].localeCompare(a[0]))}${chipRow('Kind', 'kind', r.facets.kind, (a, b) => b[1] - a[1])}</div>
    <div class="card"><div class="small muted" style="margin-bottom:6px">${r.total.toLocaleString()} match${r.total === 1 ? '' : 'es'}${r.total > r.results.length ? ` — showing the best ${r.results.length}` : ''}</div>
    ${r.results.length ? `<ul class="list">${r.results.map((x) => `<li><div class="grow"><b class="fname">${fileIcon(x.name)} ${esc(x.name)}</b>${x.formerNames.length ? `<div class="small muted">used to be called ${esc(x.formerNames[x.formerNames.length - 1])}</div>` : ''}
        <div style="margin:3px 0"><span class="pill">${esc(x.type)}</span> <span class="pill">${esc(x.year)}</span> <span class="pill">${esc(x.kind)}</span>${x.company ? ` <span class="pill">${esc(x.company)}</span>` : ''}</div>
        <div class="path small">${esc(short(x.dir))}</div>${x.snippet ? `<div class="small muted">…${esc(x.snippet)}…</div>` : ''}</div>
        <button class="link" data-file="${esc(x.path)}">Open</button><button class="link" data-reveal="${esc(x.path)}">Show in folder</button></li>`).join('')}</ul>`
      : '<div class="empty">No matches. Desk Assistant keeps the search list up to date — open it and use “Re-scan my folders” if you just saved something.</div>'}</div>`;
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const loc = e.target.closest('[data-locate]');
  if (loc) { e.stopPropagation(); safe(async () => { const f = await bridge.call('central:locate', loc.dataset.locate); if (f) { toast('Got it — I\'ll open it from there.'); renderPrograms(); } }); return; }
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
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#qclear').click(); } });
$('#qclear').addEventListener('click', () => { $('#q').value = ''; Object.assign(finder, { q: '', type: null, year: null, kind: null }); safe(runSearch); $('#q').focus(); });

(async () => {
  const h = new Date().getHours();
  $('#greet').textContent = `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'} · ${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}`;
  const v = await bridge.call('app:version').catch(() => '');
  document.title = `Riyser Central ${v}`;
  $('#foot').textContent = `Riyser Central ${v} · Riyser Group · reads your other Riyeser programs' information; it never changes it.`;
  await Promise.all([safe(renderPrograms), safe(renderToday)]);
  // keep it fresh while it's open
  setInterval(() => { if ($('#search').hidden) { safe(renderToday); safe(renderPrograms); } }, 5 * 60 * 1000);
  window.addEventListener('focus', () => { if ($('#search').hidden) safe(renderPrograms); });
})();
