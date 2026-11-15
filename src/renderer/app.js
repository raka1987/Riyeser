// Main window UI. Plain JavaScript, no framework. All work is done in the main process via window.bridge.call().
const $ = (s, el = document) => el.querySelector(s);
const page = $('#page');
const bridge = window.api;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtSize = (b) => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
const short = (p) => p.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, '~');

let current = 'today';
let settings = null;
let plan = null;      // last organise plan
let selected = new Set();
let emailFilter = 'All';
let cleanup = null;   // last clean-up check
let cleanSel = new Set();

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

async function safe(fn) {
  try { return await fn(); } catch (e) { toast(e.message); console.error(e); }
}

const confPill = (c) => c === 'high' ? '<span class="pill good">sure</span>' : c === 'medium' ? '<span class="pill">likely</span>' : '<span class="pill warn">unsure</span>';

// ---------------- pages ----------------
const pages = {
  async today() {
    const t = await bridge.call('today');
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const meetings = t.meetings.map((m) => `<li><span class="meeting-time">${m.allDay ? 'All day' : fmtTime(m.start)}</span>
      <div class="grow"><b>${esc(m.title)}</b>${m.companies?.length ? ' ' + m.companies.map((c) => `<span class="pill">${esc(c)}</span>`).join(' ') : ''}
      ${m.actionItems.length ? `<div class="small" style="color:var(--warn)">⚑ ${m.actionItems.length} item(s) to check before this</div>` : ''}
      ${m.relatedFiles?.length ? `<div class="small muted">${m.relatedFiles.length} related file(s)</div>` : ''}</div>
      ${m.link ? `<button class="link" data-act="link" data-url="${esc(m.link)}">Join</button>` : ''}</li>`).join('');
    const tasks = t.tasks.slice(0, 8).map(taskRow).join('');
    page.innerHTML = `
      <h1>${greet}</h1><p class="sub">${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })} · here's what needs you today.</p>
      <div class="grid">
        <div class="card"><h2>Today's meetings</h2>${meetings ? `<ul class="list">${meetings}</ul>` : `<div class="empty">${settings.calendars.length ? 'No more meetings today.' : 'Connect a calendar in <a href="#settings">Settings</a> to see your meetings here.'}</div>`}</div>
        <div class="card"><h2>Needs checking</h2>${tasks ? `<ul class="list">${tasks}</ul>` : '<div class="empty">Nothing outstanding. 🎉</div>'}
          <div class="row" style="margin-top:8px"><a href="#tasks" class="small">All to-dos →</a></div></div>
      </div>
      <div class="grid">
        <div class="card"><h2>Files waiting to be sorted</h2>
          <div class="stat">${t.toSort === null ? '–' : t.toSort}</div>
          <p class="muted small">In ${settings.watchFolders.map((f) => esc(short(f))).join(', ') || 'no folders yet'}</p>
          <button class="primary" data-act="go" data-page="organise">Review &amp; tidy</button></div>
        <div class="card"><h2>Emails needing a reply</h2>
          ${t.needsReply.length ? `<ul class="list">${t.needsReply.map((e) => `<li><div class="grow"><b class="ellipsis">${esc(e.subject)}</b><div class="small muted ellipsis">${esc(e.from)}</div></div></li>`).join('')}</ul>` : `<div class="empty">${settings.email.host ? 'None right now. (Check the Email page to refresh.)' : 'Email not connected (optional).'}</div>`}</div>
        <div class="card"><h2>Search index</h2><div class="stat">${t.indexSize.toLocaleString()}</div><p class="muted small">files searchable with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd></p>
          <button data-act="reindex">Re-scan now</button></div>
      </div>`;
  },

  async organise() {
    plan = await bridge.call('organise:last');
    const history = await bridge.call('organise:history');
    const groups = {};
    for (const p of plan?.plan || []) {
      const key = p.company ? `${p.companyType} › ${p.company}` : p.category === 'Media' ? 'Photos, videos & other media' : 'General documents';
      (groups[key] = groups[key] || []).push(p);
    }
    const facts = (p) => [p.details?.date && `📅 ${esc(p.details.date)}`, p.details?.reference && `# ${esc(p.details.reference)}`, p.details?.amount && `💲 ${esc(p.details.amount)}`].filter(Boolean).map((f) => `<span class="pill">${f}</span>`).join(' ');
    const readBox = (p) => p.preview ? `<details class="small"><summary class="muted">What I read</summary><div class="readbox">${esc(p.preview)}…</div></details>` : '';
    const rows = (items) => items.map((p) => `<tr>
      <td><input type="checkbox" data-sel="${esc(p.from)}" ${selected.has(p.from) ? 'checked' : ''}></td>
      <td><b>${esc(p.name)}</b>
        ${p.newName ? `<div class="row small" style="margin-top:4px"><span class="muted">rename to</span><input class="rename" data-rename="${esc(p.from)}" value="${esc(p.to.split(/[\\/]/).pop())}" title="Edit the new name if you like"></div>` : ''}
        ${p.warning ? `<div class="small" style="color:var(--warn);margin-top:4px">⚠ ${esc(p.warning)}</div>` : ''}
        <div style="margin-top:4px">${facts(p)}</div>
        <div class="small muted">${esc(p.reasons.slice(0, 2).join(' · '))}</div>${readBox(p)}</td>
      <td>${esc(p.docType)}</td><td>${confPill(p.warning ? 'low' : p.confidence)}</td>
      <td class="path">${p.currentDir ? `<span class="pill ${p.change === 'rename' ? '' : 'warn'}">${esc(p.change)}</span><div class="muted">now in ${esc(short(p.currentDir))}</div>${p.change === 'rename' ? '' : `→ ${esc(short(p.dir))}`}` : esc(short(p.dir || p.to))}</td>
      <td><button class="link" data-act="open" data-path="${esc(p.from)}">Open</button></td></tr>`).join('');
    page.innerHTML = `
      <div class="row"><div><h1>Organise files</h1><p class="sub">Scans ${settings.watchFolders.map((f) => esc(short(f))).join(', ') || '(add folders in Settings)'} and files everything into <span class="path">${esc(short(settings.organisedRoot))}</span> by company and document type. Nothing moves until you approve it, and every batch can be undone.</p></div></div>
      <div class="row" style="margin-bottom:16px">
        <button class="primary" data-act="scan">${plan?.mode === 'tidy' ? 'Scan again' : 'Scan my folders'}</button>
        <button data-act="recheck" title="Go through files already in your Organised folder and suggest better names and folders">Re-check my Organised folder</button>
        <span id="scan-status" class="muted small"></span><span class="spacer"></span>
        <button data-act="dupes">Find duplicate files</button>
      </div>
      ${!plan ? '<div class="card empty">Press “Scan my folders” to see what can be tidied.</div>' : `
      <div class="card">
        <div class="row"><h2 style="margin:0">${plan.mode === 'recheck' ? `Re-check: suggested fixes (${plan.plan.length} of ${plan.scanned} filed items)` : `Ready to file (${plan.plan.length})`}</h2><span class="spacer"></span>
          <button class="link" data-act="selall">Select all</button><button class="link" data-act="selsure">Select only “sure”</button><button class="link" data-act="selnone">Clear</button>
          <button class="primary" data-act="apply" ${selected.size ? '' : 'disabled'}>Move ${selected.size} selected</button></div>
        ${plan.plan.length ? Object.entries(groups).map(([g, items]) => `<h3 style="margin:18px 0 4px;font-size:14px">${esc(g)} <span class="muted small">(${items.length})</span></h3>
          <table><tr><th></th><th>File</th><th>Type</th><th>Confidence</th><th>${plan.mode === 'recheck' ? 'Change' : 'Will go to'}</th><th></th></tr>${rows(items)}</table>`).join('') : `<div class="empty">${plan.mode === 'recheck' ? 'Everything in your Organised folder already has a good name and is in the right place. 👍' : 'Nothing to file — your folders are tidy.'}</div>`}
      </div>
      ${plan.mode === 'recheck' ? '' : `<div class="card"><h2>Needs your help (${plan.review.length})</h2>
        <p class="muted small">I couldn't tell who these are for. Open one to check, or add the company in <a href="#companies">Companies</a> and scan again so I recognise it next time.</p>
        ${plan.review.length ? `<table><tr><th>File</th><th>Best guess</th><th></th></tr>${plan.review.map((r) => `<tr><td><b>${esc(r.name)}</b><div class="path">${esc(short(r.from))}</div>${r.warning ? `<div class="small" style="color:var(--warn)">⚠ ${esc(r.warning)}</div>` : ''}${readBox(r)}</td>
          <td>${esc(r.docType)}${r.company ? ` · ${esc(r.company)}` : ''}</td>
          <td class="row"><button class="link" data-act="open" data-path="${esc(r.from)}">Open</button>${r.company ? `<button class="link" data-act="addco" data-name="${esc(r.company)}">Add “${esc(r.company)}” as a company</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">None.</div>'}
      </div>`}`}
      <div id="dupes"></div>
      <div class="card"><h2>Recent tidy-ups</h2>${history.length ? `<ul class="list">${history.slice(0, 10).map((b) => `<li><div class="grow">${new Date(b.at).toLocaleString()} — moved ${b.moves.length} file(s)${b.errors.length ? `, <span style="color:var(--bad)">${b.errors.length} failed</span>` : ''}</div><button data-act="undo" data-id="${esc(b.id)}">Undo</button></li>`).join('')}</ul>` : '<div class="empty">No tidy-ups yet.</div>'}</div>`;
  },

  async cleanup() {
    const folder = settings.cleanupFolder || settings.watchFolders.find((f) => /downloads$/i.test(f)) || 'Downloads';
    const groups = { delete: [], review: [], keep: [] };
    for (const it of cleanup?.items || []) groups[it.verdict].push(it);
    const total = (list) => fmtSize(list.reduce((n, i) => n + i.size, 0));
    const selSize = (cleanup?.items || []).filter((i) => cleanSel.has(i.path)).reduce((n, i) => n + i.size, 0);
    const ago = (d) => d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : d < 730 ? `${Math.round(d / 30)} months ago` : `${Math.round(d / 365)} years ago`;
    const rows = (list, canSelect) => list.length ? `<table><tr>${canSelect ? '<th></th>' : ''}<th>Item</th><th>Size</th><th>Last used</th><th>Why</th><th></th></tr>${list.map((i) => `<tr>
      ${canSelect ? `<td><input type="checkbox" data-csel="${esc(i.path)}" ${cleanSel.has(i.path) ? 'checked' : ''}></td>` : ''}
      <td><b>${i.isDir ? '📁 ' : ''}${esc(i.name)}</b>${i.copyOf ? `<div class="path">already at ${esc(short(i.copyOf))}</div>` : ''}</td>
      <td>${fmtSize(i.size)}</td><td>${ago(i.ageDays)}</td><td class="small">${esc(i.reason)}</td>
      <td class="row" style="flex-wrap:nowrap"><button class="link" data-act="${i.isDir ? 'reveal' : 'open'}" data-path="${esc(i.path)}">${i.isDir ? 'Show' : 'Open'}</button>${canSelect ? `<button class="link" data-act="cleankeep" data-path="${esc(i.path)}">Keep</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">None.</div>';
    page.innerHTML = `<h1>Clean up Downloads</h1>
      <p class="sub">Checks <span class="path">${esc(short(folder))}</span> <button class="link" data-act="cleansetfolder">change</button> for things you probably don't need. Nothing is deleted without your OK, and anything you remove goes to the <b>Recycle Bin</b>, so you can get it back.</p>
      <div class="row" style="margin-bottom:16px"><button class="primary" data-act="cleanscan">${cleanup ? 'Check again' : 'Check my Downloads'}</button>
        <span class="small muted">Treat as unused after</span><select id="stale">${[30, 60, 90, 180, 365].map((d) => `<option value="${d}" ${d === (settings.staleDays || 90) ? 'selected' : ''}>${d} days</option>`).join('')}</select>
        <span class="spacer"></span>${cleanup ? `<button class="primary" data-act="cleantrash" ${cleanSel.size ? '' : 'disabled'}>Move ${cleanSel.size} to Recycle Bin (${fmtSize(selSize)})</button>` : ''}</div>
      ${!cleanup ? '<div class="card empty">Press “Check my Downloads” to start.</div>' : `
      <div class="card"><div class="row"><h2 style="margin:0">Safe to delete (${groups.delete.length} · ${total(groups.delete)})</h2><span class="spacer"></span><button class="link" data-act="cleanselall" data-v="delete">Select all</button></div>
        <p class="muted small">Old installers, zips you've already unzipped, unfinished downloads and exact copies of files already in your Organised folder.</p>${rows(groups.delete, true)}</div>
      <div class="card"><div class="row"><h2 style="margin:0">Not used in a while — your call (${groups.review.length} · ${total(groups.review)})</h2><span class="spacer"></span><button class="link" data-act="cleanselall" data-v="review">Select all</button></div>
        <p class="muted small">Not opened or changed for a long time. Open anything you're not sure about first. Click <b>Keep</b> and I won't ask about it again.</p>${rows(groups.review, true)}</div>
      <div class="card"><h2>Keeping (${groups.keep.length})</h2><p class="muted small">Recently used, or looks important (invoices, contracts, statements…). Important documents are better filed than deleted — use <a href="#organise">Organise files</a>.</p>${rows(groups.keep, false)}</div>`}`;
    $('#stale').addEventListener('change', (e) => saveSettings({ staleDays: +e.target.value }));
  },

  async search() {
    page.innerHTML = `<h1>Search</h1><p class="sub">Searches file names, folder names, companies and the text inside PDFs, Word docs, emails and text files. Tip: press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> from anywhere.</p>
      <input id="sq" style="width:100%;font-size:17px;padding:11px 14px" placeholder="e.g. acme invoice october" autofocus>
      <div id="sres" class="card" style="margin-top:14px"><div class="empty">Start typing…</div></div>`;
    let timer;
    $('#sq').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(async () => {
      const res = await bridge.call('search', e.target.value);
      $('#sres').innerHTML = !e.target.value.trim() ? '<div class="empty">Start typing…</div>' : res.length ? `<ul class="list">${res.map((r) => `<li><div class="grow">
        <div class="row"><b>${esc(r.name)}</b>${r.company ? `<span class="pill">${esc(r.company)}</span>` : ''}${r.docType ? `<span class="pill good">${esc(r.docType)}</span>` : ''}<span class="small muted">${fmtDay(r.mtime)} · ${fmtSize(r.size)}</span></div>
        <div class="path">${esc(short(r.dir))}</div>${r.snippet ? `<div class="small muted">…${esc(r.snippet)}…</div>` : ''}</div>
        <button class="link" data-act="open" data-path="${esc(r.path)}">Open</button><button class="link" data-act="reveal" data-path="${esc(r.path)}">Show in folder</button></li>`).join('')}</ul>` : '<div class="empty">No matches.</div>';
    }, 150); });
    $('#sq').focus();
  },

  async meetings(force) {
    page.innerHTML = '<h1>Meetings</h1><p class="sub">Loading your calendars…</p>';
    const { meetings, errors } = await bridge.call('meetings:get', !!force);
    const byDay = {};
    for (const m of meetings) (byDay[fmtDay(m.start)] = byDay[fmtDay(m.start)] || []).push(m);
    page.innerHTML = `<div class="row"><div><h1>Meetings</h1><p class="sub">Next 14 days. Before each meeting you'll get a reminder ${settings.reminderMinutes} min ahead with anything that needs checking and related files for that company.</p></div><span class="spacer"></span><button data-act="meetrefresh">Refresh</button></div>
      ${errors.map((e) => `<div class="card" style="color:var(--bad)">Couldn't read calendar “${esc(e.source)}”: ${esc(e.error)}</div>`).join('')}
      ${!settings.calendars.length ? '<div class="card empty">No calendars connected yet. Add one in <a href="#settings">Settings → Calendars</a>.</div>' : ''}
      ${Object.entries(byDay).map(([day, ms]) => `<div class="card"><h2>${esc(day)}</h2><ul class="list">${ms.map((m) => `<li>
        <span class="meeting-time">${m.allDay ? 'All day' : `${fmtTime(m.start)}<div class="small muted">${fmtTime(m.end)}</div>`}</span>
        <div class="grow"><b>${esc(m.title)}</b> <span class="small muted">${esc(m.calendar)}${m.location ? ' · ' + esc(m.location) : ''}</span>
          ${m.companies?.length ? `<div>${m.companies.map((c) => `<span class="pill">${esc(c)}</span>`).join(' ')}</div>` : ''}
          ${m.actionItems.length ? `<div style="margin-top:6px"><b class="small" style="color:var(--warn)">⚑ To check:</b>${m.actionItems.map((a) => `<div class="small">☐ ${esc(a.text)}${a.due ? ` <span class="pill warn">${esc(a.due)}</span>` : ''}</div>`).join('')}</div>` : ''}
          ${m.openTasks?.length ? `<div class="small"><b>Open to-dos for this company:</b> ${m.openTasks.map((t) => esc(t.text)).join('; ')}</div>` : ''}
          ${m.relatedFiles?.length ? `<div class="small" style="margin-top:4px"><b>Related files:</b> ${m.relatedFiles.map((f) => `<button class="link" data-act="open" data-path="${esc(f.path)}">${esc(f.name)}</button>`).join('')}</div>` : ''}
        </div>
        ${m.actionItems.length ? `<button class="link" data-act="meettasks" data-id="${esc(m.id)}">Add to to-do</button>` : ''}
        ${m.link ? `<button class="primary" data-act="link" data-url="${esc(m.link)}">Join</button>` : ''}</li>`).join('')}</ul></div>`).join('')}
      ${settings.calendars.length && !meetings.length && !errors.length ? '<div class="card empty">No meetings in the next 14 days.</div>' : ''}`;
    pages._meetings = meetings;
  },

  async tasks() {
    const tasks = await bridge.call('tasks:get');
    const open = tasks.filter((t) => !t.done);
    const done = tasks.filter((t) => t.done);
    page.innerHTML = `<h1>To-do</h1><p class="sub">Collected automatically from meeting agendas, meeting notes and emails — plus anything you add.</p>
      <div class="card"><form id="addtask" class="row"><input id="newtask" style="flex:1" placeholder="Add something to check…"><button class="primary">Add</button></form></div>
      <div class="card"><h2>Open (${open.length})</h2>${open.length ? `<ul class="list">${open.map(taskRow).join('')}</ul>` : '<div class="empty">All clear.</div>'}</div>
      ${done.length ? `<div class="card"><div class="row"><h2 style="margin:0">Done (${done.length})</h2><span class="spacer"></span><button class="link" data-act="cleardone">Clear done</button></div><ul class="list">${done.slice(0, 30).map(taskRow).join('')}</ul></div>` : ''}`;
    $('#addtask').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = $('#newtask').value.trim();
      if (v) { await bridge.call('tasks:add', v); render(); }
    });
  },

  async email() {
    const emails = await bridge.call('email:get');
    const cats = ['All', 'Needs reply', 'Invoices & Bills', 'Receipts', 'Meetings', 'Newsletters & Promotions', 'Other'];
    const count = (c) => c === 'All' ? emails.length : c === 'Needs reply' ? emails.filter((e) => e.needsReply).length : emails.filter((e) => e.category === c).length;
    const shown = emails.filter((e) => emailFilter === 'All' || (emailFilter === 'Needs reply' ? e.needsReply : e.category === emailFilter));
    page.innerHTML = `<div class="row"><div><h1>Email</h1><p class="sub">Optional. Sorts your latest 150 emails, flags ones that need a reply, and saves invoice/receipt attachments into the right company folder. Read-only — nothing in your mailbox is moved or deleted.</p></div><span class="spacer"></span>
      <button class="primary" data-act="emailrefresh" ${settings.email.host ? '' : 'disabled'}>Check email</button></div>
      ${!settings.email.host ? '<div class="card empty">Connect a mailbox in <a href="#settings">Settings → Email</a>.</div>' : ''}
      ${emails.length ? `<div class="tabs">${cats.map((c) => `<button data-act="efilter" data-c="${esc(c)}" class="${c === emailFilter ? 'active' : ''}">${esc(c)} (${count(c)})</button>`).join('')}</div>
      <div class="card"><ul class="list">${shown.map((e) => `<li><div class="grow">
        <div class="row">${e.unread ? '<b>●</b>' : ''}<b class="ellipsis">${esc(e.subject)}</b>${e.urgent ? '<span class="pill bad">urgent</span>' : ''}${e.needsReply ? '<span class="pill warn">reply</span>' : ''}${e.company ? `<span class="pill">${esc(e.company)}</span>` : ''}<span class="spacer"></span><span class="small muted">${fmtDay(e.date)}</span></div>
        <div class="small muted">${esc(e.from)} · ${esc(e.category)}${e.attachments.length ? ` · 📎 ${e.attachments.map((a) => esc(a.filename)).join(', ')}` : ''}</div>
        <div class="small muted ellipsis">${esc(e.preview)}</div></div></li>`).join('') || '<div class="empty">Nothing here.</div>'}</ul></div>` : ''}`;
  },

  async companies() {
    const cos = settings.companies;
    page.innerHTML = `<h1>Companies</h1><p class="sub">The businesses you deal with. Files get sorted into <span class="path">${esc(short(settings.organisedRoot))}/&lt;Type&gt;/&lt;Company&gt;/&lt;Document type&gt;</span>. Add other spellings (e.g. “ACME”, “acmeplumbing.co.nz”) as aliases so they're always recognised.</p>
      <div class="card"><h2>Your own business</h2><p class="muted small">So I don't file your own invoices under your own name. Separate multiple names with commas.</p>
        <div class="row"><input id="own" style="flex:1" value="${esc(settings.ownCompanyNames.join(', '))}" placeholder="e.g. Smith Consulting Ltd"><button data-act="saveown">Save</button></div></div>
      <div class="card"><h2>Add a company</h2>
        <form id="addco" class="row"><input id="coname" placeholder="Company name" required style="flex:1">
          <select id="cotype">${settings.companyTypes.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
          <input id="coalias" placeholder="Aliases (comma separated)" style="flex:1"><button class="primary">Add</button></form></div>
      <div class="card"><h2>Companies (${cos.length})</h2>${cos.length ? `<table><tr><th>Name</th><th>Type</th><th>Aliases</th><th></th></tr>${cos.map((c, i) => `<tr><td><b>${esc(c.name)}</b></td>
        <td><select data-cotype="${i}">${settings.companyTypes.map((t) => `<option ${t === c.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></td>
        <td>${esc((c.aliases || []).join(', ')) || '<span class="muted">–</span>'}</td><td><button class="link" data-act="delco" data-i="${i}">Remove</button></td></tr>`).join('')}</table>` : '<div class="empty">No companies yet. Unknown companies are still detected from documents (e.g. names ending in Ltd/Inc/LLC), but adding them here makes sorting much more accurate.</div>'}</div>
      <div class="card"><h2>Company types</h2><div class="chips">${settings.companyTypes.map((t, i) => `<span class="chip">${esc(t)}<button data-act="deltype" data-i="${i}">×</button></span>`).join('')}</div>
        <form id="addtype" class="row" style="margin-top:10px"><input id="newtype" placeholder="New type, e.g. Contractors"><button>Add type</button></form></div>`;
    $('#addco').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#coname').value.trim();
      if (!name) return;
      await saveSettings({ companies: [...cos, { name, type: $('#cotype').value, aliases: $('#coalias').value.split(',').map((s) => s.trim()).filter(Boolean) }] });
      toast(`Added ${name}`); render();
    });
    $('#addtype').addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = $('#newtype').value.trim();
      if (t && !settings.companyTypes.includes(t)) { await saveSettings({ companyTypes: [...settings.companyTypes, t] }); render(); }
    });
    page.querySelectorAll('[data-cotype]').forEach((sel) => sel.addEventListener('change', async () => {
      const list = settings.companies.map((c, i) => i === +sel.dataset.cotype ? { ...c, type: sel.value } : c);
      await saveSettings({ companies: list }); toast('Saved');
    }));
  },

  async settings() {
    const s = settings;
    const folderList = (key) => `<div class="chips">${s[key].map((f, i) => `<span class="chip path">${esc(short(f))}<button data-act="delfolder" data-key="${key}" data-i="${i}">×</button></span>`).join('') || '<span class="muted small">None</span>'}</div>
      <button style="margin-top:8px" data-act="addfolder" data-key="${key}">+ Add folder</button>`;
    page.innerHTML = `<h1>Settings</h1><p class="sub">Everything stays on this computer. Passwords and keys are encrypted with your system keychain.</p>
      <div class="grid">
      <div class="card"><h2>Folders to tidy</h2><p class="muted small">Where new files land: Downloads, Desktop, and your phone's synced folder (e.g. OneDrive / Google Drive / iCloud “Camera Roll” or “Scans”).</p>${folderList('watchFolders')}
        <label class="row small" style="margin-top:10px"><input type="checkbox" id="recursive" ${s.recursiveScan ? 'checked' : ''}> Include sub-folders</label>
        <label class="row small"><input type="checkbox" id="rename" ${s.renameFiles ? 'checked' : ''}> Rename files from their contents (e.g. “2026-11-03 Acme Plumbing Invoice 1042.pdf”)</label>
        <label class="row small"><input type="checkbox" id="byyear" ${s.groupByYear ? 'checked' : ''}> Put files in a folder for each year (…/Invoices/2026/)</label>
        <label class="row small">Dates like 03/04/2026 mean <select id="datefmt"><option value="1" ${s.dayFirstDates ? 'selected' : ''}>3 April (NZ/AU/UK)</option><option value="0" ${s.dayFirstDates ? '' : 'selected'}>March 4 (US)</option></select></label>
        <label class="row small"><input type="checkbox" id="auto" ${s.autoOrganise ? 'checked' : ''}> Tidy automatically every hour (only files I'm sure about)</label></div>
      <div class="card"><h2>Organised folder</h2><p class="muted small">Where sorted files go.</p><div class="path">${esc(s.organisedRoot)}</div><button style="margin-top:8px" data-act="setroot">Change…</button>
        <h2 style="margin-top:18px">Folders to search</h2>${folderList('searchFolders')}</div>
      <div class="card"><h2>Calendars</h2><p class="muted small">Paste your calendar's secret iCal address — Google Calendar: Settings → your calendar → “Secret address in iCal format”. Outlook: Settings → Calendar → Shared calendars → Publish → ICS link. Or import an .ics file.</p>
        <ul class="list">${s.calendars.map((c, i) => `<li><div class="grow"><b>${esc(c.name)}</b><div class="path ellipsis">${esc(c.url ? c.url.replace(/(private-|secret)[^/]*/i, '$1…') : short(c.path))}</div></div><button class="link" data-act="delcal" data-i="${i}">Remove</button></li>`).join('')}</ul>
        <form id="addcal" class="row"><input id="calname" placeholder="Name" style="width:110px"><input id="calurl" placeholder="https://… .ics" style="flex:1"><button>Add</button></form>
        <button class="link" style="margin-top:6px" data-act="addics">or import an .ics file…</button>
        <div class="field" style="margin-top:12px"><label>Remind me before meetings (minutes)</label><input id="remind" type="number" min="1" max="120" value="${s.reminderMinutes}" style="width:90px"></div></div>
      <div class="card"><h2>Email (optional)</h2><p class="muted small">Any IMAP mailbox. For Gmail/Outlook/iCloud create an “app password” in your account security settings and use it here. Gmail: imap.gmail.com · Outlook: outlook.office365.com · iCloud: imap.mail.me.com</p>
        <form id="emailform">
          <div class="row"><input id="ehost" placeholder="IMAP server" value="${esc(s.email.host)}" style="flex:1"><input id="eport" type="number" value="${esc(s.email.port)}" style="width:80px"></div>
          <div class="row" style="margin-top:8px"><input id="euser" placeholder="Email address" value="${esc(s.email.user)}" style="flex:1"></div>
          <div class="row" style="margin-top:8px"><input id="epass" type="password" placeholder="${s.hasEmailPassword ? 'Password saved (type to change)' : 'App password'}" style="flex:1"></div>
          <label class="row small" style="margin-top:8px"><input type="checkbox" id="eatt" ${s.email.saveAttachments ? 'checked' : ''}> Save invoice & receipt attachments into company folders</label>
          <label class="row small"><input type="checkbox" id="eauto" ${s.email.autoCheck ? 'checked' : ''}> Check automatically every 20 minutes</label>
          <button class="primary" style="margin-top:8px">Save email settings</button></form></div>
      <div class="card"><h2>Smarter sorting with AI (optional)</h2><p class="muted small">Add an Anthropic API key and files I'm unsure about are sent to Claude to identify (first ~4,000 characters of text only). Leave blank to keep everything 100% offline.</p>
        <form id="aiform" class="row"><input id="aikey" type="password" style="flex:1" placeholder="${s.hasAiKey ? 'Key saved (type to replace)' : 'sk-ant-…'}"><button>Save</button>${s.hasAiKey ? '<button type="button" data-act="clearai">Remove key</button>' : ''}</form></div>
      <div class="card"><h2>General</h2><label class="row"><input type="checkbox" id="login" ${s.openAtLogin ? 'checked' : ''}> Start when I log in (runs quietly in the tray)</label></div>
      </div>`;
    const bindCheck = (id, fn) => $(id).addEventListener('change', async (e) => { await saveSettings(fn(e.target.checked)); toast('Saved'); });
    bindCheck('#recursive', (v) => ({ recursiveScan: v }));
    bindCheck('#rename', (v) => ({ renameFiles: v }));
    bindCheck('#byyear', (v) => ({ groupByYear: v }));
    $('#datefmt').addEventListener('change', async (e) => { await saveSettings({ dayFirstDates: e.target.value === '1' }); toast('Saved'); });
    bindCheck('#auto', (v) => ({ autoOrganise: v }));
    bindCheck('#login', (v) => ({ openAtLogin: v }));
    $('#remind').addEventListener('change', async (e) => { await saveSettings({ reminderMinutes: Math.max(1, +e.target.value || 10) }); toast('Saved'); });
    $('#addcal').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('#calurl').value.trim();
      if (!/^(https?|webcal):\/\//i.test(url)) return toast('Paste a link starting with https:// or webcal://');
      await saveSettings({ calendars: [...s.calendars, { name: $('#calname').value.trim() || 'Calendar', url }] });
      await bridge.call('meetings:get', true).catch((err) => toast(err.message));
      toast('Calendar added'); render();
    });
    $('#emailform').addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveSettings({ email: { ...s.email, host: $('#ehost').value.trim(), port: +$('#eport').value || 993, user: $('#euser').value.trim(), saveAttachments: $('#eatt').checked, autoCheck: $('#eauto').checked }, emailPassword: $('#epass').value });
      toast('Email settings saved'); render();
    });
    $('#aiform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const k = $('#aikey').value.trim();
      if (!k) return;
      await saveSettings({ aiKey: k }); toast('AI key saved'); render();
    });
  },
};

function taskRow(t) {
  const src = t.source === 'meeting' ? 'meeting' : t.source === 'email' ? `email${t.from ? ' from ' + t.from : ''}` : t.source === 'notes' ? 'meeting notes' : 'added by you';
  return `<li><input type="checkbox" data-task="${esc(t.id)}" ${t.done ? 'checked' : ''}>
    <div class="grow"><span class="${t.done ? 'done' : ''}">${esc(t.text)}</span> ${t.urgent ? '<span class="pill bad">urgent</span>' : ''}${t.due ? `<span class="pill warn">${esc(t.due)}</span>` : ''}
    <div class="small muted ellipsis">${esc(src)}${t.meeting ? ' · ' + esc(t.meeting) : ''}${t.subject ? ' · ' + esc(t.subject) : ''}</div></div>
    ${t.file ? `<button class="link" data-act="open" data-path="${esc(t.file)}">Open notes</button>` : ''}</li>`;
}

async function saveSettings(patch) {
  await bridge.call('settings:set', patch);
  settings = await bridge.call('settings:get');
}

// ---------------- actions (event delegation) ----------------
const actions = {
  go: (el) => { location.hash = el.dataset.page; },
  link: (el) => bridge.call('link:open', el.dataset.url),
  open: (el) => bridge.call('file:open', el.dataset.path),
  reveal: (el) => bridge.call('file:reveal', el.dataset.path),
  reindex: async () => { toast('Re-scanning files in the background…'); await bridge.call('index:rebuild'); toast('Search index updated'); render(); },
  recheck: async (el) => {
    el.disabled = true; $('#scan-status').textContent = 'Re-checking filed items…';
    const p = await bridge.call('organise:recheck');
    selected = new Set(p.plan.filter((x) => x.confidence === 'high' && !x.warning).map((x) => x.from));
    render();
  },
  cleanscan: async (el) => {
    el.disabled = true; el.textContent = 'Checking…';
    cleanup = await bridge.call('cleanup:scan', +$('#stale').value || 90);
    cleanSel = new Set(cleanup.items.filter((i) => i.verdict === 'delete').map((i) => i.path));
    render();
  },
  cleantrash: async () => {
    const paths = [...cleanSel];
    const size = cleanup.items.filter((i) => cleanSel.has(i.path)).reduce((n, i) => n + i.size, 0);
    if (!confirm(`Move ${paths.length} item(s) (${fmtSize(size)}) to the Recycle Bin?\n\nYou can restore them from the Recycle Bin if you change your mind.`)) return;
    const r = await bridge.call('cleanup:trash', paths);
    cleanup.items = cleanup.items.filter((i) => !r.done.includes(i.path));
    cleanSel = new Set();
    toast(`Moved ${r.done.length} item(s) to the Recycle Bin${r.failed.length ? `, ${r.failed.length} couldn't be moved (in use?)` : ''}`);
    render();
  },
  cleankeep: async (el) => {
    await bridge.call('cleanup:keep', el.dataset.path);
    cleanup.items = cleanup.items.filter((i) => i.path !== el.dataset.path);
    cleanSel.delete(el.dataset.path);
    toast('OK — I won\'t suggest that one again'); render();
  },
  cleanselall: (el) => { cleanup.items.filter((i) => i.verdict === el.dataset.v).forEach((i) => cleanSel.add(i.path)); render(); },
  cleansetfolder: async () => { const f = await bridge.call('dialog:folder'); if (f) { await saveSettings({ cleanupFolder: f }); cleanup = null; render(); } },
  scan: async (el) => {
    el.disabled = true; $('#scan-status').textContent = 'Scanning…';
    const p = await bridge.call('organise:scan');
    selected = new Set(p.plan.filter((x) => (x.confidence === 'high' && !x.warning) || x.category === 'Media').map((x) => x.from));
    render();
  },
  selall: () => { selected = new Set(plan.plan.map((p) => p.from)); render(); },
  selsure: () => { selected = new Set(plan.plan.filter((p) => (p.confidence === 'high' && !p.warning) || p.category === 'Media').map((p) => p.from)); render(); },
  selnone: () => { selected = new Set(); render(); },
  apply: async () => {
    const items = plan.plan.filter((p) => selected.has(p.from));
    const batch = await bridge.call('organise:apply', items);
    toast(`Moved ${batch.moves.length} file(s)${batch.errors.length ? `, ${batch.errors.length} failed` : ''}. You can undo below.`);
    selected = new Set();
    await bridge.call(plan.mode === 'recheck' ? 'organise:recheck' : 'organise:scan');
    render();
  },
  undo: async (el) => { const r = await bridge.call('organise:undo', el.dataset.id); toast(r.errors.length ? `Undone, but ${r.errors.length} file(s) couldn't be moved back` : 'Undone — files are back where they were'); render(); },
  addco: async (el) => { await saveSettings({ companies: [...settings.companies, { name: el.dataset.name, type: 'Clients', aliases: [] }] }); toast(`Added ${el.dataset.name} as a client — change its type in Companies`); },
  dupes: async (el) => {
    el.disabled = true; el.textContent = 'Looking…';
    const groups = await bridge.call('organise:duplicates');
    el.disabled = false; el.textContent = 'Find duplicate files';
    const waste = groups.reduce((n, g) => n + g.size * (g.files.length - 1), 0);
    $('#dupes').innerHTML = `<div class="card"><h2>Duplicates (${groups.length} sets · ${fmtSize(waste)} could be freed)</h2>
      ${groups.length ? groups.slice(0, 50).map((g) => `<div style="margin:10px 0"><b>${fmtSize(g.size)}</b><ul class="list">${g.files.map((f, i) => `<li><div class="grow path">${esc(short(f))}</div>${i > 0 ? `<button class="link" data-act="trash" data-path="${esc(f)}">Move to bin</button>` : '<span class="pill good">keep</span>'}</li>`).join('')}</ul></div>`).join('') : '<div class="empty">No duplicates found.</div>'}</div>`;
  },
  trash: async (el) => { await bridge.call('file:trash', el.dataset.path); el.closest('li').remove(); toast('Moved to the recycle bin'); },
  meetrefresh: () => pages.meetings(true),
  meettasks: async (el) => {
    const m = pages._meetings.find((x) => x.id === el.dataset.id);
    await bridge.call('tasks:add', m.actionItems.map((a) => ({ ...a, meeting: m.title })));
    toast('Added to your to-do list');
  },
  cleardone: async () => { await bridge.call('tasks:clearDone'); render(); },
  emailrefresh: async (el) => {
    el.disabled = true; el.textContent = 'Checking…';
    try { const r = await bridge.call('email:refresh'); toast(`Sorted ${r.emails.length} emails${r.saved.length ? `, filed ${r.saved.length} attachment(s)` : ''}`); }
    finally { render(); }
  },
  efilter: (el) => { emailFilter = el.dataset.c; render(); },
  saveown: async () => { await saveSettings({ ownCompanyNames: $('#own').value.split(',').map((s) => s.trim()).filter(Boolean) }); toast('Saved'); },
  delco: async (el) => { await saveSettings({ companies: settings.companies.filter((_, i) => i !== +el.dataset.i) }); render(); },
  deltype: async (el) => { await saveSettings({ companyTypes: settings.companyTypes.filter((_, i) => i !== +el.dataset.i) }); render(); },
  addfolder: async (el) => {
    const f = await bridge.call('dialog:folder');
    if (f && !settings[el.dataset.key].includes(f)) { await saveSettings({ [el.dataset.key]: [...settings[el.dataset.key], f] }); render(); }
  },
  delfolder: async (el) => { await saveSettings({ [el.dataset.key]: settings[el.dataset.key].filter((_, i) => i !== +el.dataset.i) }); render(); },
  setroot: async () => { const f = await bridge.call('dialog:folder'); if (f) { await saveSettings({ organisedRoot: f }); render(); } },
  addics: async () => {
    const f = await bridge.call('dialog:ics');
    if (f) { await saveSettings({ calendars: [...settings.calendars, { name: f.split(/[\\/]/).pop().replace(/\.ics$/i, ''), path: f }] }); await bridge.call('meetings:get', true); render(); }
  },
  delcal: async (el) => { await saveSettings({ calendars: settings.calendars.filter((_, i) => i !== +el.dataset.i) }); render(); },
  clearai: async () => { await saveSettings({ aiKey: '__clear__' }); toast('AI key removed'); render(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  safe(() => actions[el.dataset.act](el));
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.sel !== undefined) {
    e.target.checked ? selected.add(e.target.dataset.sel) : selected.delete(e.target.dataset.sel);
    const btn = page.querySelector('[data-act="apply"]');
    if (btn) { btn.disabled = !selected.size; btn.textContent = `Move ${selected.size} selected`; }
  }
  if (e.target.dataset.rename !== undefined && plan) {
    const item = plan.plan.find((p) => p.from === e.target.dataset.rename);
    const ext = item.name.includes('.') ? item.name.slice(item.name.lastIndexOf('.')) : '';
    let v = e.target.value.trim().replace(/[<>:"/\\|?*]/g, '-') || item.name;
    if (ext && !v.toLowerCase().endsWith(ext.toLowerCase())) v += ext;
    e.target.value = v;
    item.to = `${item.dir}${item.dir.includes('\\') ? '\\' : '/'}${v}`;
  }
  if (e.target.dataset.csel !== undefined) {
    e.target.checked ? cleanSel.add(e.target.dataset.csel) : cleanSel.delete(e.target.dataset.csel);
    const btn = page.querySelector('[data-act="cleantrash"]');
    const size = cleanup.items.filter((i) => cleanSel.has(i.path)).reduce((n, i) => n + i.size, 0);
    if (btn) { btn.disabled = !cleanSel.size; btn.textContent = `Move ${cleanSel.size} to Recycle Bin (${fmtSize(size)})`; }
  }
  if (e.target.dataset.task) safe(async () => { await bridge.call('tasks:toggle', e.target.dataset.task); if (current === 'tasks') render(); });
});

// ---------------- routing ----------------
async function render() {
  current = (location.hash || '#today').slice(1);
  if (!pages[current]) current = 'today';
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === current));
  await safe(() => pages[current]());
  updateBadges();
}

async function updateBadges() {
  const tasks = (await bridge.call('tasks:get').catch(() => [])).filter((t) => !t.done).length;
  const b = $('#badge-tasks'); b.hidden = !tasks; b.textContent = tasks;
  const p = plan || await bridge.call('organise:last').catch(() => null);
  const n = p ? p.plan.length + p.review.length : 0;
  const o = $('#badge-organise'); o.hidden = !n; o.textContent = n;
}

window.addEventListener('hashchange', render);
bridge.on('navigate', (p) => { location.hash = p; });
bridge.on('tasks-changed', () => { if (current === 'tasks' || current === 'today') render(); else updateBadges(); });
bridge.on('meetings-changed', () => { if (current === 'today') render(); });
bridge.on('plan-changed', () => { if (current === 'today') render(); else updateBadges(); });
bridge.on('scan-progress', ({ i, n }) => { const s = $('#scan-status'); if (s) s.textContent = `Checking ${i} of ${n}…`; });

(async () => {
  settings = await bridge.call('settings:get');
  if (navigator.platform.startsWith('Mac')) $('#hotkey').textContent = '⌘';
  if (!settings.onboarded) { await saveSettings({ onboarded: true }); location.hash = 'companies'; toast('Welcome! Start by adding your own business name and the companies you work with.'); }
  render();
})();
