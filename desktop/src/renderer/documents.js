// Riyeser Documents window. Everything goes through window.api.call(channel, ...) (src/documents/service.js).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shown = (rel) => String(rel || '').split('/').filter(Boolean).join(' › ');

// ---------- line icons ----------
const ICONS = {
  inbox: '<path d="M3 13h4l2 3h6l2-3h4M5 5h14l2 8v6H3v-6z"/>', folder: '<path d="M3 6h6l2 2h10v11H3z"/>', lock: '<path d="M6 11h12v9H6zM9 11V8a3 3 0 016 0v3"/>',
  clock: '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/>', share: '<path d="M8 12h8M14 8l4 4-4 4M4 5v14"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 5-6 8-6s7 2 8 6"/>',
  bin: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"/>', search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', scan: '<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M4 12h16"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>', history: '<path d="M3 12a9 9 0 103-6.7L3 8"/><path d="M3 3v5h5M12 8v4l3 2"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12l5 5 9-10"/>', print: '<path d="M7 9V4h10v5M7 17H5v-6h14v6h-2M8 14h8v6H8z"/>', move: '<path d="M3 6h6l2 2h10v11H3z"/><path d="M10 14h6M13 11l3 3-3 3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4"/>', restore: '<path d="M4 12a8 8 0 108-8 8 8 0 00-6 2.7L4 9"/><path d="M4 4v5h5"/>', open: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>', people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.7-5 6.5-5s5.7 1.5 6.5 5M16 4.5a3.5 3.5 0 010 7M18 15c2 .6 3.2 2.2 3.5 5"/>',
  rules: '<path d="M4 6h16M4 12h10M4 18h6M17 15l2 2 3-4"/>', printer: '<path d="M7 9V4h10v5M7 17H5v-6h14v6h-2M8 14h8v6H8z"/>', copy: '<path d="M9 9h11v11H9z"/><path d="M5 15H4V4h11v1"/>',
  back: '<path d="M15 5l-7 7 7 7"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>', eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>', link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  select: '<path d="M4 4h6v6H4zM14 5h6M14 8h4M4 14h6v6H4zM14 15h6M14 18h4"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};
const icon = (k, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ICONS.file}</svg>`;
const paintIcons = (root = document) => $$('[data-icon]', root).forEach((el) => { el.innerHTML = icon(el.dataset.icon); el.removeAttribute('data-icon'); });

// ---------- talking to the program ----------
async function call(ch, ...args) {
  try { return await window.api.call(ch, ...args); } catch (e) { toast(e.message || String(e)); throw e; }
}
let toastTimer;
function toast(text, action) {
  const t = $('#toast'); t.innerHTML = esc(text) + (action ? ` <button type="button">${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 3200);
}

// ---------- formatting ----------
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso); const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d >= startToday) return `Today ${hm}`;
  if (d >= new Date(startToday - 864e5)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
const longWhen = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const thumbClass = (tag) => (/^(JPG|PNG|HEIC|GIF|BMP|WEBP|TIF|TIFF)$/.test(tag) ? 'img' : tag === 'PDF' ? '' : 'doc');
const PLACES = { inbox: ['Inbox', 'inbox'], recent: ['Recent', 'clock'], shared: ['Shared with me', 'share'], mine: ['My documents', 'user'] };

// ---------- state ----------
const S = { place: 'inbox', folder: '', q: '', type: 'All', from: '', sort: 'new', items: [], counts: {}, total: 0, sel: new Set(), current: null, anchor: null, selecting: false, nav: null, doc: null };
try { const saved = JSON.parse(localStorage.getItem('docs.view') || '{}'); if (saved.sort) S.sort = saved.sort; } catch { /* private window */ }
const remember = () => { try { localStorage.setItem('docs.view', JSON.stringify({ sort: S.sort })); } catch { /* fine */ } };

function setTheme(t) {
  const r = document.documentElement;
  if (t === 'light' || t === 'dark') r.dataset.theme = t; else delete r.dataset.theme;
}

async function loadState() {
  S.nav = await call('docs:state');
  const n = S.nav;
  setTheme(n.settings.theme);
  $('#avatar').textContent = n.me.initials || '?';
  $('#avatar').title = `${n.me.name}${n.me.owner ? ' (owner)' : ''}: settings and help`;
  $('#demobar').hidden = !n.demo;
  const off = $('#offline');
  off.hidden = n.status.online;
  if (!n.status.online) off.innerHTML = `<b>Can't reach the library.</b> ${esc(n.status.error)}`;
  renderNav();
}

function renderNav() {
  const n = S.nav;
  const btn = (key, label, ic, extra = '', on = false) => `<button type="button" data-place="${esc(key)}" class="${on ? 'on' : ''}"><span class="fi">${icon(ic)}${esc(label)}</span>${extra}</button>`;
  const top = S.place === 'folder' ? S.folder.split('/')[0] : null;
  let h = Object.entries(PLACES).map(([k, [label, ic]]) => btn(k, label, ic, k === 'inbox' && n.inboxCount ? `<span class="cnt">${n.inboxCount}</span>` : '', S.place === k && !S.q)).join('');
  h += '<div class="f-sec">Folders</div>';
  h += n.departments.map((d) => `<button type="button" data-folder="${esc(d.rel)}" class="${top === d.rel && !S.q ? 'on' : ''}" title="${d.locked ? 'Locked: only people given access can open it' : esc(d.rel)}"><span class="fi">${icon(d.locked ? 'lock' : 'folder')}${esc(d.rel)}</span></button>`).join('');
  if (n.lockedHidden > 0) h += `<div class="note" style="padding:2px 10px;font-size:.75rem">${n.lockedHidden} locked folder${n.lockedHidden === 1 ? '' : 's'} you can't open</div>`;
  h += `<button type="button" class="add" data-act="newfolder"><span class="fi">${icon('plus')}New folder</span></button>`;
  h += '<div class="f-sec">More</div>';
  h += btn('history', 'History', 'history', '', S.place === 'history');
  h += btn('bin', 'Recycle bin', 'bin', n.binCount ? `<span class="cnt" style="background:var(--bg);color:var(--muted)">${n.binCount}</span>` : '', S.place === 'bin');
  $('#nav').innerHTML = h;
}

// ---------- the list ----------
async function loadList({ keep = true } = {}) {
  if (S.place === 'history') return renderHistoryPage();
  $('#pageview').hidden = true; $('#table').hidden = false; $('#tools').hidden = false;
  const r = await call('docs:list', { place: S.place, folder: S.folder, q: S.q, type: S.type, from: S.from, sort: S.sort });
  S.items = r.items; S.counts = r.counts; S.total = r.total;
  const ids = new Set(S.items.map((i) => i.id));
  for (const id of [...S.sel]) if (!ids.has(id)) S.sel.delete(id);
  if (!keep || !S.current || !ids.has(S.current)) S.current = null;
  if (!S.current && S.items[0] && window.innerWidth > 700) S.current = S.items[0].id;
  if (S.current && !S.sel.size) S.sel.add(S.current);
  renderHead(); renderList();
  await showDoc(S.current);
}

function renderHead() {
  const n = S.nav; const q = S.q.trim();
  let crumbs; let title; let sub;
  if (q) { crumbs = 'Search · all folders you can open'; title = `Results for “${q}”`; sub = `${S.total} document${S.total === 1 ? '' : 's'}`; }
  else if (S.place === 'folder') {
    const parts = S.folder.split('/');
    crumbs = `<button type="button" data-crumb="">Folders</button>${parts.slice(0, -1).map((p, i) => ` › <button type="button" data-crumb="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`).join('')}`;
    title = parts[parts.length - 1];
    sub = `${S.total} document${S.total === 1 ? '' : 's'}${(n.folders.find((f) => f.rel === S.folder) || {}).locked ? ' · locked folder' : ''}`;
  } else {
    crumbs = 'Riyeser Documents';
    title = { inbox: 'Inbox', recent: 'Recent', shared: 'Shared with me', mine: 'My documents', bin: 'Recycle bin' }[S.place];
    sub = S.place === 'inbox' ? `${S.total} new from the printer, scanner, phones and uploads · each has a suggested folder`
      : S.place === 'bin' ? `${S.total} deleted document${S.total === 1 ? '' : 's'} · each is kept for 30 days, then removed for good`
        : S.place === 'recent' ? 'Filed in the last 30 days' : S.place === 'shared' ? 'Documents other people added that you can open' : 'Documents you added';
  }
  $('#crumbs').innerHTML = crumbs; $('#title').textContent = title; $('#sub').textContent = sub;
  // sub-folders of the open folder
  const subs = S.place === 'folder' && !q ? n.folders.filter((f) => f.rel.startsWith(`${S.folder}/`) && !f.rel.slice(S.folder.length + 1).includes('/')) : [];
  $('#subfolders').hidden = !subs.length;
  $('#subfolders').innerHTML = subs.map((f) => `<button type="button" class="chip" data-folder="${esc(f.rel)}">${icon(f.locked ? 'lock' : 'folder')}${esc(f.rel.split('/').pop())}</button>`).join('');
  const acts = [];
  if (S.place === 'inbox' && !q && S.items.some((i) => i.suggested)) acts.push(`<button class="btn" type="button" data-act="fileall">${icon('check')}File all as suggested</button>`);
  if (S.place === 'bin' && !q && S.total) acts.push(`<button class="btn danger" type="button" data-act="emptybin">${icon('bin')}Empty the Recycle bin</button>`);
  acts.push(`<button class="btn ghost" type="button" data-act="selectmode" aria-pressed="${S.selecting}" title="Pick several documents">${icon('select')}${S.selecting ? 'Done' : 'Select'}</button>`);
  $('#headact').innerHTML = acts.join('');
  $('#types').innerHTML = ['All', 'Scans', 'Photos', 'Documents'].map((t) => `<button type="button" data-type="${t}" aria-pressed="${t === S.type}">${t}</button>`).join('');
  $('#from').value = S.from; $('#sort').value = S.sort;
}

function renderList() {
  const inboxView = S.place === 'inbox' && !S.q;
  $('#main').classList.toggle('selecting', S.selecting);
  $('#rows').innerHTML = S.items.length ? S.items.map((d) => `<div role="row" tabindex="0" class="f-tr${S.sel.has(d.id) ? (S.sel.size > 1 || S.selecting ? ' sel' : ' on') : ''}" data-id="${d.id}" draggable="false">
      <span class="f-name" role="cell"><span class="thumb ${thumbClass(d.tag)}"><i>${esc(d.tag)}</i><span class="tick">${icon('check')}</span></span><span style="min-width:0"><b>${esc(d.name)}${d.private ? ` <span class="lockic" title="Private">${icon('lock')}</span>` : ''}</b><small class="${d.snippet ? 'snip' : ''}">${d.snippet ? highlight(d.snippet) : esc(d.from)}</small></span></span>
      <span class="f-loc" role="cell">${d.status === 'inbox' ? `<span class="new">${d.suggested ? 'Suggested:' : ''}</span> ${esc(d.loc)}` : esc(d.loc)}</span>
      <span class="f-date" role="cell">${esc(d.status === 'deleted' ? `${d.daysLeft} days left` : when(d.added))}</span>
      <span class="f-r" role="cell">${esc(size(d.size))}</span></div>`).join('')
    : `<div class="f-empty">${emptyText()}</div>`;
  renderSelbar();
  void inboxView;
}
function highlight(s) { let h = esc(s); for (const t of S.q.trim().split(/\s+/).filter((x) => x.length > 1)) h = h.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>'); return h; }
function emptyText() {
  if (S.q) return `<b>Nothing matches “${esc(S.q)}”.</b>Try fewer words. Search looks at names and the text inside scans, in every folder you can open.`;
  if (S.type !== 'All' || S.from) return '<b>No documents here match.</b>Set Show to All and From to Anyone to see everything here.';
  return { inbox: '<b>All filed. Nice work.</b>New scans from the printer and scanner, and anything you upload or drag onto this window, appear here.',
    bin: '<b>The Recycle bin is empty.</b>Deleted documents wait here for 30 days, so they can be put back.', recent: '<b>Nothing filed in the last 30 days.</b>', shared: '<b>Nothing yet.</b>Documents other people add appear here.',
    mine: '<b>You haven\'t added anything yet.</b>Click Upload, or drag files onto this window.' }[S.place] || '<b>This folder is empty.</b>File documents here from the Inbox, or drag files onto the window.';
}

function renderSelbar() {
  const bar = $('#selbar');
  if (S.sel.size < 2 && !S.selecting) { bar.hidden = true; return; }
  const n = S.sel.size; const bin = S.place === 'bin';
  const inbox = [...S.sel].some((id) => (S.items.find((i) => i.id === id) || {}).status === 'inbox');
  bar.hidden = false;
  bar.innerHTML = `<b>${n} selected</b><span class="f-grow"></span>${n ? (bin ? `<button class="btn sm" type="button" data-act="restore">${icon('restore')}Restore</button>`
    : `${inbox ? `<button class="btn sm" type="button" data-act="filesel">${icon('check')}File as suggested</button>` : ''}<button class="btn sm" type="button" data-act="move">${icon('move')}Move</button><button class="btn sm" type="button" data-act="print">${icon('print')}Print</button>${n === 1 ? `<button class="btn sm" type="button" data-act="rename">${icon('edit')}Rename</button>` : ''}<button class="btn sm danger" type="button" data-act="delete">${icon('bin')}Delete</button>`) : ''}
    <button class="btn sm ghost" type="button" data-act="clearsel">Clear</button>`;
}

// ---------- the selected document ----------
let previewToken = 0;
async function showDoc(id) {
  const side = $('#side');
  if (!id) { S.doc = null; side.classList.remove('open'); side.innerHTML = `<div class="note">${S.items.length ? 'Select a document to see it here.' : 'Documents you select show here, with a preview and what you can do with them.'}</div>`; return; }
  let d;
  try { d = await window.api.call('docs:get', id); } catch (e) { side.innerHTML = `<div class="note">${esc(e.message)}</div>`; return; }
  S.doc = d;
  const inbox = d.status === 'inbox'; const bin = d.status === 'deleted';
  const parts = d.folderParts.length ? d.folderParts : ['Inbox'];
  const path = parts.map((p) => `<span>${esc(p)}</span>`).join('<em>›</em>');
  const pdf = d.tag === 'PDF';
  side.innerHTML = `<button class="btn ghost back" type="button" data-act="closeside">${icon('back')}Back to the list</button>
    <div class="preview" id="preview"><div class="ph">Loading the preview…</div></div>
    <h3>${esc(d.name)}${d.private ? ` <span class="pill lock">${icon('lock')} Private</span>` : ''}</h3>
    <div><div class="note" style="margin-bottom:4px">${inbox ? (d.suggestion ? 'Suggested location' : 'Location') : bin ? 'Was in' : 'Location'}</div><div class="f-path">${inbox && !d.suggestion ? `<span>${d.textDone ? 'Pick a folder' : 'Reading it…'}</span>` : bin ? `<span>${esc(d.restoreTo)}</span>` : path}</div>
      ${inbox && d.suggestion ? `<div class="note" style="margin-top:4px">${esc(d.suggestion.because)}</div>` : ''}</div>
    ${inbox ? `<div class="f-card"><span>${d.suggestion ? 'Looks right? File it there, or pick another folder.' : 'Pick the folder it belongs in.'}</span>
      ${d.suggestion && d.suggestion.name ? `<label><input type="checkbox" id="renameit"> <span>Also rename it to <b>${esc(d.suggestion.name)}</b></span></label>` : ''}
      <div class="f-acts">${d.suggestion ? `<button class="btn pri" type="button" data-act="fileit">${icon('check')}File it</button>` : ''}<button class="btn${d.suggestion ? '' : ' pri wide'}" type="button" data-act="change">${d.suggestion ? 'Change' : `${icon('folder')}Choose a folder`}</button></div></div>` : ''}
    ${bin ? `<div class="f-card bin"><span>Deleted ${esc(when(d.deletedAt))}. It's removed for good in ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}.</span><div class="f-acts"><button class="btn pri wide" type="button" data-act="restore">${icon('restore')}Restore to ${esc(d.restoreTo)}</button></div></div>` : ''}
    <dl class="meta"><dt>From</dt><dd>${esc(d.from)}</dd><dt>Added by</dt><dd>${esc(d.addedByName)}</dd><dt>Added</dt><dd>${esc(longWhen(d.added))}</dd><dt>Size</dt><dd>${esc(size(d.size))} · ${esc(d.tag)}</dd>
      <dt>Access</dt><dd>${d.private ? 'Private: whoever added it, the owner and people with Full access' : esc(d.access)}</dd>${d.formerNames.length ? `<dt>Was called</dt><dd>${esc(d.formerNames.join(', '))}</dd>` : ''}</dl>
    ${bin ? '' : `<div class="f-acts">
      <button class="btn" type="button" data-act="open">${icon('open')}Open</button><button class="btn" type="button" data-act="print">${icon('print')}Print</button>
      <button class="btn" type="button" data-act="share" title="Share links are coming soon">${icon('share')}Share</button><button class="btn" type="button" data-act="move" ${inbox ? 'hidden' : ''}>${icon('move')}Move</button>
      <button class="btn" type="button" data-act="rename">${icon('edit')}Rename</button><button class="btn danger" type="button" data-act="delete">${icon('bin')}Delete</button>
      ${pdf ? `<button class="btn wide" type="button" data-act="openpdf">${icon('file')}Open in Riyeser PDF</button>` : ''}
      ${d.link ? `<button class="btn wide" type="button" data-act="program" data-program="${esc(d.link.program)}">${icon('link')}${esc(d.link.label)}</button>` : ''}
    </div>
    <label class="check"><input type="checkbox" data-act="private" ${d.private ? 'checked' : ''}> <span>Private: only me, the owner and people with Full access can see it</span></label>`}
    <details class="more"><summary>History (${d.history.length})</summary>${histList(d.history)}</details>
    ${d.textPreview ? `<details class="more"><summary>Text found inside</summary><div class="textprev">${esc(d.textPreview)}</div></details>` : ''}`;
  if (window.innerWidth <= 700 && S.openSide) side.classList.add('open');
  renderPreview(d);
}
function histList(h) {
  if (!h.length) return '<p class="note">Nothing yet.</p>';
  return `<ul class="hist">${h.map((x) => `<li><time title="${esc(longWhen(x.at))}">${esc(when(x.at))}</time><span><b>${esc(x.whoName || 'Someone')}</b> ${esc(lowerFirst(x.detail || x.action))}</span></li>`).join('')}</ul>`;
}
const lowerFirst = (s) => String(s).charAt(0).toLowerCase() + String(s).slice(1);

let pdfjs = null;
async function renderPreview(d) {
  const token = ++previewToken; const box = $('#preview'); if (!box) return;
  const isImg = thumbClass(d.tag) === 'img'; const isPdf = d.tag === 'PDF';
  if (!isImg && !isPdf) { box.innerHTML = `<div class="ph">${icon('file')}<br>No preview for ${esc(d.tag)} files. Click Open.</div>`; return; }
  try {
    const bytes = await window.api.call('docs:bytes', d.id);
    if (token !== previewToken) return;
    if (isImg) { const url = URL.createObjectURL(new Blob([bytes])); box.innerHTML = `<img alt="" src="${url}">`; return; }
    if (!pdfjs) { pdfjs = await import('./vendor/pdf.min.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs'; }
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/' }).promise;
    const page = await doc.getPage(1);
    const vp0 = page.getViewport({ scale: 1 }); const w = Math.max(280, box.clientWidth) * (window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: w / vp0.width });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    if (token !== previewToken) return;
    box.innerHTML = ''; box.appendChild(c);
    if (doc.numPages > 1) box.insertAdjacentHTML('beforeend', `<span class="pages">${doc.numPages} pages</span>`);
    doc.destroy();
  } catch (e) { if (token === previewToken && box.isConnected) box.innerHTML = `<div class="ph">No preview (${esc(e.message)}). Click Open.</div>`; }
}

// ---------- doing things ----------
const selIds = () => (S.sel.size ? [...S.sel] : S.current ? [S.current] : []);
async function refresh() { await loadState(); await loadList(); }

async function fileIt() {
  const d = S.doc; const rename = $('#renameit') && $('#renameit').checked;
  await call('docs:file', d.id, d.suggestion.folder, rename ? { name: d.suggestion.name } : {});
  toast(`Filed in ${shown(d.suggestion.folder)}`, { label: 'Show', run: () => go('folder', d.suggestion.folder) });
  S.current = null; S.sel.clear(); await refresh();
}
async function change() {
  const d = S.doc;
  const folder = await pickFolder({ title: `File “${d.name}”`, start: d.suggestion ? d.suggestion.folder : '', action: 'File it here' });
  if (!folder) return;
  await call('docs:file', d.id, folder, { explicit: true });
  toast(`Filed in ${shown(folder)}. Riyeser Documents will suggest it for similar documents.`);
  S.current = null; S.sel.clear(); await refresh();
}
async function moveSel() {
  const ids = selIds(); if (!ids.length) return;
  const folder = await pickFolder({ title: ids.length > 1 ? `Move ${ids.length} documents` : `Move “${S.doc ? S.doc.name : ''}”`, action: 'Move here' });
  if (!folder) return;
  const r = await call('docs:move', ids, folder);
  toast(r.failed.length ? `${r.done} moved. ${r.failed[0].reason}` : `Moved to ${shown(folder)}`);
  S.sel.clear(); await refresh();
}
async function deleteSel() {
  const ids = selIds(); if (!ids.length) return;
  const r = await call('docs:delete', ids);
  S.sel.clear(); S.current = null; await refresh();
  toast(r.failed.length ? `${r.done} moved to the Recycle bin. ${r.failed[0].reason}` : `${r.done === 1 ? 'Moved' : `${r.done} documents moved`} to the Recycle bin`, { label: 'Undo', run: async () => { await call('docs:restore', ids); await refresh(); } });
}
async function restoreSel() {
  const ids = selIds(); const r = await call('docs:restore', ids);
  toast(r.failed.length ? `${r.done} restored. ${r.failed[0].reason}` : `${r.done === 1 ? 'Restored' : `${r.done} documents restored`}`);
  S.sel.clear(); S.current = null; await refresh();
}
async function renameDoc() {
  const d = S.doc; if (!d) return;
  const v = await ask({ title: 'Rename', label: 'New name', value: d.name, hint: `It stays a ${d.tag} file. The old name still finds it in search.`, ok: 'Rename' });
  if (!v || v === d.name) return;
  await call('docs:rename', d.id, v); toast('Renamed'); await refresh();
}
async function printSel() {
  const ids = selIds(); if (!ids.length) return;
  const printers = await call('docs:printers');
  const st = await call('settings:get');
  const def = (printers.find((p) => p.name === st.lastPrinter) || printers.find((p) => p.isDefault) || printers[0] || {}).name || '';
  const r = await dialog(`<h2>Print ${ids.length > 1 ? `${ids.length} documents` : `“${esc(S.doc ? S.doc.name : '')}”`}</h2>
    ${printers.length ? `<label class="field"><span>Printer</span><select name="printer">${printers.map((p) => `<option value="${esc(p.name)}" ${p.name === def ? 'selected' : ''}>${esc(p.label)}${p.isDefault ? ' (default)' : ''}</option>`).join('')}</select></label>` : '<p class="note">No printers found on this PC. Windows\' print window will open instead.</p>'}
    <label class="field"><span>Copies</span><input name="copies" type="number" min="1" max="99" value="1" style="width:100px"></label>
    <p class="note">PDFs and pictures print from here. Word and Excel files open in their own program to print.</p>
    <div class="dlgacts"><button class="btn" value="">Cancel</button><button class="btn pri" value="ok">${icon('print')}Print</button></div>`);
  if (r.value !== 'ok') return;
  toast('Sending to the printer…');
  await call('docs:print', ids, { printer: r.data.printer || '', copies: +r.data.copies || 1 });
  toast(`Sent to ${r.data.printer || 'the printer'}`);
}
async function fileAll(ids) {
  const list = ids || S.items.filter((i) => i.suggested).map((i) => i.id);
  if (!list.length) return toast('Nothing has a suggested folder yet.');
  const ok = await confirmBox(`File ${list.length} document${list.length === 1 ? '' : 's'} as suggested?`, 'Each one goes to the folder shown in its Location. You can move any of them later.', 'File them');
  if (!ok) return;
  const r = await call('docs:fileAll', list);
  toast(`${r.filed} filed${r.skipped.length ? `, ${r.skipped.length} left in the Inbox (${r.skipped[0].reason})` : ''}`);
  S.sel.clear(); S.current = null; await refresh();
}
async function programLink(program) {
  const r = await call('program:open', program);
  if (r.opened) toast(`Opening ${r.name}. Linking documents to its records is coming soon; for now attach the file there.`);
  else dialog(`<h2>Coming soon</h2><p>Making records straight from a document (bills, expense claims, staff files, jobs) is coming in a later update.</p><p class="note">${esc(r.name || 'That program')} isn't installed on this PC. Install it from Riyeser Central.</p><div class="dlgacts"><button class="btn pri" value="">OK</button></div>`);
}

async function upload(paths) {
  const r = await call('docs:upload', paths || []);
  if (r.added) { toast(`${r.added} added to the Inbox${r.failed.length ? `; ${r.failed.length} couldn't be added (${r.failed[0].reason})` : ''}. Reading ${r.added === 1 ? 'it' : 'them'} now…`); go('inbox'); }
}

// ---------- scanning ----------
async function scanDialog() {
  const deps = S.nav.departments;
  const r = await dialog(`<h2>Scan</h2>
    <div class="box"><b>${icon('scan')} Scanner on this PC</b><p class="note" style="margin:0">Uses Windows' scan window: pick the scanner and click Scan. The page arrives in the Inbox as a PDF.</p>
      <label class="field"><span>It's for</span><select name="dept"><option value="">Not sure (Inbox)</option>${deps.map((d) => `<option>${esc(d.rel)}</option>`).join('')}</select></label>
      <div class="row2"><button class="btn pri" value="pc">${icon('scan')}Scan now</button></div></div>
    <div class="box"><b>${icon('printer')} At the office printer</b><p class="note" style="margin:0">Scan to a department's scan folder on the printer's screen. It appears in the Inbox within seconds, with the department already set.</p>
      <div class="row2"><button class="btn" value="setup">Set up scan folders</button></div></div>
    <div class="dlgacts"><button class="btn" value="">Close</button></div>`);
  if (r.value === 'setup') return openSettings('scan');
  if (r.value !== 'pc') return;
  toast('Opening Windows\' scan window…');
  const s = await call('docs:scan', { dept: r.data.dept || null });
  if (s.ok) { toast('Scanned. It\'s in the Inbox.'); go('inbox'); return; }
  if (s.reason === 'cancelled') return;
  dialog(`<h2>No scanner answered</h2><p>${esc(s.message)}</p>
    ${s.fallback === 'wfs' ? `<div class="box info"><b>Windows Fax and Scan is open instead.</b><ol class="steps"><li>Click <b>New Scan</b>, pick your scanner, then <b>Scan</b>.</li><li>Click <b>Save as</b> and save it into this folder:</li></ol><div class="row2"><span class="path">${esc(s.saveTo)}</span><button class="btn sm" type="button" data-copy="${esc(s.saveTo)}">${icon('copy')}Copy</button></div><p class="note" style="margin:0">It then arrives in the Inbox by itself.</p></div>`
    : '<p class="note">Check the scanner is switched on and connected, and that its Windows driver is installed. Some scanners only work with their maker\'s own app: save the scan into a scan folder (Settings › Scan folders) and it arrives in the Inbox.</p>'}
    <div class="dlgacts"><button class="btn pri" value="">OK</button></div>`);
}

// ---------- dialogs ----------
function dialog(html, { wide = false, onOpen } = {}) {
  const dlg = $('#dlg'); const form = $('#dlgform');
  dlg.classList.toggle('wide', wide);
  form.innerHTML = html; paintIcons(form);
  return new Promise((resolve) => {
    let clicked = '';
    form.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.copy != null) { e.preventDefault(); call('docs:copy', b.dataset.copy).then(() => toast('Copied')); return; }
      if (b.type !== 'button') clicked = b.value;
    };
    dlg.onclose = () => { const data = Object.fromEntries(new FormData(form)); resolve({ value: dlg.returnValue || clicked, data }); };
    dlg.returnValue = '';
    dlg.showModal();
    if (onOpen) onOpen(form);
    const first = form.querySelector('input:not([type=checkbox]),select'); if (first) first.focus();
  });
}
async function confirmBox(title, text, ok) {
  const r = await dialog(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="dlgacts"><button class="btn" value="">Cancel</button><button class="btn pri" value="ok">${esc(ok)}</button></div>`);
  return r.value === 'ok';
}
async function ask({ title, label, value = '', hint = '', ok = 'OK' }) {
  const r = await dialog(`<h2>${esc(title)}</h2><label class="field"><span>${esc(label)}</span><input name="v" value="${esc(value)}" required>${hint ? `<small>${esc(hint)}</small>` : ''}</label><div class="dlgacts"><button class="btn" value="" formnovalidate>Cancel</button><button class="btn pri" value="ok">${esc(ok)}</button></div>`);
  return r.value === 'ok' ? String(r.data.v || '').trim() : null;
}

/** Folder picker: the folders you can add to, a filter, and "New folder" inside the chosen one. */
async function pickFolder({ title, start = '', action = 'Choose' }) {
  let folders = await call('docs:folders');
  let chosen = start;
  const draw = (form) => {
    const q = (form.querySelector('[name=filter]').value || '').toLowerCase();
    const list = folders.filter((f) => !q || f.rel.toLowerCase().includes(q));
    const extra = start && !folders.some((f) => f.rel === start) && (!q || start.toLowerCase().includes(q)) ? `<button type="button" data-rel="${esc(start)}" aria-pressed="${chosen === start}">${icon('plus')}${esc(shown(start))} <span class="pill">new folder</span></button>` : '';
    form.querySelector('.tree').innerHTML = extra + list.map((f) => {
      const depth = f.rel.split('/').length - 1;
      return `<button type="button" data-rel="${esc(f.rel)}" aria-pressed="${chosen === f.rel}" ${f.canAdd ? '' : 'disabled title="You can only view this folder"'} style="padding-left:${10 + depth * 18}px">${icon(f.locked ? 'lock' : 'folder')}${esc(f.rel.split('/').pop())}${f.canAdd ? '' : ' <span class="pill">view only</span>'}</button>`;
    }).join('') || '<div class="f-empty">No folders match.</div>';
    form.querySelector('[data-chosen]').textContent = chosen ? shown(chosen) : 'Nothing chosen yet';
  };
  const r = await dialog(`<h2>${esc(title)}</h2>
    <input class="input" name="filter" placeholder="Type to find a folder" autocomplete="off">
    <div class="tree" role="listbox"></div>
    <div class="note">Chosen: <b data-chosen></b></div>
    <div class="row2"><input class="input" name="newname" placeholder="New folder name (inside the chosen one)" style="flex:1"><button class="btn" type="button" data-newfolder>${icon('plus')}New folder</button></div>
    <div class="dlgacts"><button class="btn" value="">Cancel</button><button class="btn pri" value="ok">${esc(action)}</button></div>`, {
    onOpen: (form) => {
      draw(form);
      form.querySelector('[name=filter]').oninput = () => draw(form);
      form.querySelector('.tree').addEventListener('click', (e) => { const b = e.target.closest('[data-rel]'); if (b && !b.disabled) { chosen = b.dataset.rel; draw(form); } });
      form.querySelector('[data-newfolder]').onclick = async () => {
        const name = form.querySelector('[name=newname]').value.trim(); if (!name) return toast('Type the new folder\'s name first.');
        try { const rel = await call('folders:create', chosen ? `${chosen}/${name}` : name); folders = await call('docs:folders'); chosen = rel; form.querySelector('[name=newname]').value = ''; draw(form); await loadState(); } catch { /* toast shown */ }
      };
    },
  });
  return r.value === 'ok' && chosen ? chosen : null;
}

// ---------- menu (avatar) ----------
function openMenu() {
  const n = S.nav; const m = $('#menu'); const t = n.settings.theme || 'system';
  m.innerHTML = `<div class="who"><b>${esc(n.me.name)}</b>${n.me.owner ? 'Owner of this library' : `${esc(n.me.email || 'On this PC')}`}</div>
    <button type="button" data-act="settings">${icon('settings')}Settings</button>
    <button type="button" data-act="scansetup">${icon('printer')}Scan folders</button>
    <button type="button" data-act="access">${icon('people')}People &amp; access</button>
    <button type="button" data-act="rules">${icon('rules')}Filing rules</button>
    <button type="button" data-place="history">${icon('history')}History</button>
    <button type="button" data-act="help">${icon('help')}Help</button>
    <div class="themes" role="group" aria-label="Theme">${['system', 'light', 'dark'].map((x) => `<button type="button" data-theme-set="${x}" aria-pressed="${t === x}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div>`;
  const a = $('#avatar').getBoundingClientRect();
  m.style.top = `${a.bottom + 6}px`; m.style.right = `${Math.max(8, window.innerWidth - a.right)}px`; m.style.left = 'auto';
  m.hidden = false; $('#avatar').setAttribute('aria-expanded', 'true');
}
const closeMenu = () => { $('#menu').hidden = true; $('#avatar').setAttribute('aria-expanded', 'false'); };

// ---------- settings ----------
async function openSettings(tab = 'library', after = null) {
  const tabs = [['library', 'Library'], ['scan', 'Scan folders'], ['access', 'People & access'], ['rules', 'Filing rules'], ['look', 'Appearance'], ['backup', 'Backups & about']];
  const body = async (form, which) => {
    form.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === which));
    const el = form.querySelector('#stab');
    el.innerHTML = '<p class="note">Loading…</p>';
    el.innerHTML = await TABS[which]();
    paintIcons(el);
    if (TAB_WIRE[which]) TAB_WIRE[which](el, () => body(form, which));
    if (after) { const f = after; after = null; f(el); }
  };
  await dialog(`<h2>Settings</h2><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}">${esc(l)}</button>`).join('')}</div><div id="stab" style="display:grid;gap:14px"></div>
    <div class="dlgacts"><button class="btn pri" value="">Done</button></div>`, {
    wide: true,
    onOpen: (form) => { form.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) body(form, b.dataset.tab); }; body(form, tab); },
  });
  await refresh();
}

const TABS = {
  async library() {
    const s = await call('settings:get');
    const net = /^\\\\/.test(s.root);
    return `<div class="box"><b>Where the library is</b><div class="row2"><span class="path">${esc(s.root)}</span>${s.demo ? '<span class="pill">demo</span>' : ''}</div>
      <p class="note" style="margin:0">${net ? 'A shared office folder: every PC that uses this path sees the same documents, Inbox and history.' : 'A folder on this PC. To share one library between several PCs, share this folder (below) or pick a shared folder.'}</p>
      <div class="row2"><button class="btn" type="button" data-lib="choose">${icon('folder')}Choose a folder…</button><button class="btn ghost" type="button" data-lib="default">Use Documents\\Riyeser Documents</button></div>
      <label class="field"><span>Or type a network folder</span><div class="row2"><input class="input" id="netpath" placeholder="\\\\OFFICE-PC\\Riyeser Documents" style="flex:1"><button class="btn pri" type="button" data-lib="net">Use this folder</button></div><small>Type it the way it opens in File Explorer. Several PCs can share one library this way.</small></label></div>
      <details class="box"><summary><b>How to share the library from the main office PC</b></summary><ol class="steps">
        <li>On the office PC that stays on, open File Explorer and find the <b>Riyeser Documents</b> folder (in Documents).</li>
        <li>Right-click it › <b>Properties</b> › <b>Sharing</b> › <b>Advanced Sharing</b> › tick <b>Share this folder</b>. Keep the share name <b>Riyeser Documents</b>.</li>
        <li>Click <b>Permissions</b> and give the staff who use it <b>Change</b>. Click OK.</li>
        <li>On each other PC: Settings › Library › type <b>\\\\THAT-PC-NAME\\Riyeser Documents</b> › Use this folder.</li></ol>
        <p class="note">If the office PC is off or the network drops, the other PCs show the documents they saw last and wait; nothing is lost.</p></details>
      <label class="check"><input type="checkbox" id="startwin" ${s.startWithWindows !== false ? 'checked' : ''}> <span>Start with Windows (in the background), so scans from the office printer arrive in the Inbox even when the window is closed</span></label>`;
  },
  async scan() {
    const s = await call('docs:scanSetup');
    return `<div class="box info"><b>Scan to folder from the office printer</b><p class="note" style="margin:0;color:var(--ink)">Each department has its own scan folder. Add them to the printer as "Scan to folder" (SMB) destinations. Anything scanned there appears in the Inbox within seconds, with the department already set.</p></div>
      ${s.shared ? '' : `<div class="box tip"><b>First, share the library folder</b><p class="note" style="margin:0;color:var(--ink)">The printer saves over the network, so the library folder has to be shared: Settings › Library › How to share the library. The paths below assume it's shared as <b>Riyeser Documents</b> from this PC (${esc(s.computer)}).</p></div>`}
      <div class="ptable"><div class="ph" style="--cols:1;grid-template-columns:minmax(0,160px) minmax(0,1fr) auto"><span>Department</span><span>Path to type into the printer</span><span></span></div>
      ${s.folders.map((f) => `<div style="grid-template-columns:minmax(0,160px) minmax(0,1fr) auto"><span><b>${esc(f.dept || f.label)}</b>${f.later ? '<br><span class="pill">for scan-to-email, later</span>' : ''}</span><span class="path">${esc(f.network)}</span><span class="row2"><button class="btn sm" type="button" data-copy="${esc(f.network)}" title="Copy">${icon('copy')}Copy</button><button class="btn sm ghost" type="button" data-openscan="${esc(f.dept || '')}" title="Open the folder">${icon('open')}</button></span></div>`).join('')}</div>
      <p class="note">The printer also needs a Windows user name and password that can save into the folder (often a "scanner" user set up for it). Ask whoever looks after your network if you're not sure.</p>
      <div class="grid2">${s.brands.map((b) => `<details class="box"><summary><b>${esc(b.name)}</b></summary><ol class="steps">${b.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></details>`).join('')}</div>
      <div class="box"><b>Scanner connected to this PC</b><p class="note" style="margin:0">Click <b>Scan</b> at the top. Riyeser Documents opens Windows' own scan window (any scanner with a Windows driver). If Windows can't find one, Windows Fax and Scan opens with steps to save into a scan folder.</p></div>`;
  },
  async access() {
    const a = await call('access:get');
    const lvl = (sel, name, attrs = '') => `<select ${attrs} aria-label="${esc(name)}">${['', ...a.levels.map((l) => l.id)].map((l) => `<option value="${l}" ${sel === l ? 'selected' : ''}>${l ? esc(a.levels.find((x) => x.id === l).label) : 'As above'}</option>`).join('')}</select>`;
    const cols = [{ key: 'everyone', name: 'Everyone' }, ...a.groups.map((g) => ({ key: `g:${g.id}`, name: g.name }))];
    const personRules = []; for (const f of a.folders) for (const [k, v] of Object.entries(f.rule)) if (k.startsWith('p:')) personRules.push({ folder: f.rel, id: k.slice(2), level: v });
    const pname = (id) => (a.people.find((p) => p.id === id) || {}).name || id;
    return `<div class="box tip"><b>${icon('lock')} What this protects</b><p class="note" style="margin:0;color:var(--ink)">These settings decide what Riyeser Documents shows and lets each person do. ${a.network ? 'Your library is on a shared network folder: anyone with Windows access to that folder can still open it in File Explorer. For a hard lock (for example on Payroll & HR), also set the Windows folder permissions: right-click the folder › Properties › Security, on the PC that shares it.' : 'The library is on this PC: anyone who can sign in to this Windows account can open the folder in File Explorer.'} Company-wide Riyeser sign-ins will make this tighter in a later update.</p></div>
      <div class="row2"><b>Owner:</b> ${esc(a.ownerName)} <span class="pill ok">Full access everywhere</span>${a.canManage ? '' : '<span class="note">Only the owner can change these settings.</span>'}</div>
      <h3 style="font-size:1rem">Folders</h3>
      <div class="ptable-wrap"><div class="ptable" style="--cols:${cols.length};min-width:${200 + cols.length * 110}px"><div class="ph"><span>Folder</span>${cols.map((c) => `<span>${esc(c.name)}</span>`).join('')}</div>
      ${a.folders.map((f) => `<div><span style="padding-left:${f.rel.includes('/') ? 16 : 0}px">${icon(f.locked ? 'lock' : 'folder')} ${esc(f.rel.split('/').pop())}${f.locked && !f.rel.includes('/') ? ' <span class="pill lock">locked</span>' : ''}</span>${cols.map((c) => `<span>${lvl(f.rule[c.key] || (c.key === 'everyone' && !f.rel.includes('/') ? '' : ''), `${f.rel}: ${c.name}`, `data-rule="${esc(f.rel)}" data-who="${esc(c.key)}" ${f.canChange ? '' : 'disabled'}`)}</span>`).join('')}</div>`).join('')}</div></div>
      <p class="note">“As above” uses the folder above it; at the top it's ${esc((a.levels.find((l) => l.id === a.everyone) || {}).label)} for everyone. No access hides the folder. View: open and print. Add: also upload and file. Edit: also move, rename and delete. Full: also change access.</p>
      <h3 style="font-size:1rem">People</h3>
      <div class="ptable"><div class="ph" style="grid-template-columns:minmax(0,1.3fr) minmax(0,2fr) auto"><span>Name</span><span>Groups</span><span></span></div>
      ${a.people.map((p) => `<div style="grid-template-columns:minmax(0,1.3fr) minmax(0,2fr) auto"><span><b>${esc(p.name)}</b>${p.id === a.owner ? ' <span class="pill ok">owner</span>' : ''}${p.id === a.me ? ' <span class="pill">you</span>' : ''}<br><small class="note">${esc(p.email || (p.id.startsWith('local:') ? 'This PC\'s Windows user' : ''))}</small></span>
        <span class="row2">${a.groups.map((g) => `<label class="check" style="font-size:.8rem"><input type="checkbox" data-pgroup="${esc(p.id)}" value="${esc(g.id)}" ${(p.groups || []).includes(g.id) ? 'checked' : ''} ${a.canManage ? '' : 'disabled'}> ${esc(g.name)}</label>`).join('')}</span>
        <span>${a.canManage && p.id !== a.owner ? `<button class="btn sm ghost" type="button" data-rmperson="${esc(p.id)}">Remove</button>` : ''}</span></div>`).join('')}</div>
      ${a.canManage ? `<div class="row2"><input class="input" id="pname" placeholder="Name" style="flex:1;min-width:140px"><input class="input" id="pemail" placeholder="Email (their Riyeser sign-in, if they have one)" style="flex:2;min-width:180px"><button class="btn" type="button" data-addperson>${icon('plus')}Add person</button></div>` : ''}
      <h3 style="font-size:1rem">One person's own access</h3>
      ${personRules.length ? `<ul class="hist">${personRules.map((r) => `<li><span>${esc(shown(r.folder))}</span><span>${esc(pname(r.id))}: <b>${esc((a.levels.find((l) => l.id === r.level) || {}).label)}</b> ${a.canManage ? `<button class="btn sm ghost" type="button" data-rmrule="${esc(r.folder)}" data-who="p:${esc(r.id)}">Remove</button>` : ''}</span></li>`).join('')}</ul>` : '<p class="note">None. A person\'s own access beats their groups.</p>'}
      ${a.canManage ? `<div class="row2"><select class="input" id="xp" style="flex:1;min-width:120px">${a.people.filter((p) => p.id !== a.owner).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><select class="input" id="xf" style="flex:1;min-width:120px">${a.folders.map((f) => `<option value="${esc(f.rel)}">${esc(shown(f.rel))}</option>`).join('')}</select><select class="input" id="xl" style="flex:none;width:auto">${a.levels.map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join('')}</select><button class="btn" type="button" data-addrule>Add</button></div>` : ''}`;
  },
  async rules() {
    const rules = await call('rules:list');
    return `<p class="note" style="margin:0">Rules come first when Riyeser Documents suggests a folder. It also learns from where you file things, so most of the time you won't need one.</p>
      <div class="ptable"><div class="ph" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1.6fr) auto"><span>If the name or text mentions</span><span>File in</span><span></span></div>
      ${rules.map((r) => `<div style="grid-template-columns:minmax(0,1.6fr) minmax(0,1.6fr) auto"><span><b>${esc(r.name)}</b><br><small class="note">${esc(r.words.join(', '))}</small></span><span>${esc(r.where)}</span><span><button class="btn sm ghost" type="button" data-rmrule2="${esc(r.id)}">Remove</button></span></div>`).join('') || '<div><span class="note">No rules yet.</span></div>'}</div>
      <div class="box"><b>New rule</b><label class="field"><span>If the name or text mentions</span><input class="input" id="rwords" placeholder="For example: BSP, Bank South Pacific"><small>Separate several with commas: any of them counts.</small></label>
        <div class="row2"><span class="path" id="rfolder" data-rel="">No folder chosen</span><button class="btn" type="button" data-rpick>${icon('folder')}Choose folder</button></div>
        <label class="check"><input type="checkbox" id="ryear" checked> <span>Put each year in its own folder (2026, 2027…)</span></label>
        <div class="row2"><button class="btn pri" type="button" data-rsave>Add rule</button></div></div>`;
  },
  async look() {
    const t = (S.nav.settings.theme) || 'system';
    return `<div class="field"><span>Theme</span><div class="f-seg" role="group" aria-label="Theme">${[['system', 'Same as Windows'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" data-theme-set="${k}" aria-pressed="${t === k}">${l}</button>`).join('')}</div></div>`;
  },
  async backup() {
    const s = await call('settings:get');
    return `<div class="box"><b>Backups</b><p class="note" style="margin:0">Riyeser Documents backs up its settings on this PC every day. Your documents are ordinary files in the library folder: include that folder in your office backup.</p>
      <div class="row2"><button class="btn" type="button" data-bk="now">Back up now</button><button class="btn" type="button" data-bk="restore">Restore from a backup…</button><button class="btn ghost" type="button" data-bk="folder">Open the backups folder</button></div></div>
      <div class="box"><b>About</b><p class="note" style="margin:0">Riyeser Documents ${esc(S.nav.version)} by Riyeser Group. Formerly Riyeser Desk Assistant. Free for 3 users.</p>
      <div class="row2"><button class="btn" type="button" data-act="help">${icon('help')}Help</button><button class="btn ghost" type="button" data-weblink="https://riyeser.com/help/">Help on riyeser.com</button></div></div>
      <div class="box info"><b>Coming next</b><p class="note" style="margin:0;color:var(--ink)">Riyeser cloud sync between offices, share links, links for customers to send you files, and access for your accountant.</p></div>${s.demo ? '' : ''}`;
  },
};
const TAB_WIRE = {
  library(el, again) {
    el.onclick = async (e) => {
      const b = e.target.closest('[data-lib]'); if (!b) return;
      let root = null;
      if (b.dataset.lib === 'choose') root = await call('settings:chooseRoot');
      if (b.dataset.lib === 'default') root = (await call('settings:get')).defaultRoot;
      if (b.dataset.lib === 'net') root = el.querySelector('#netpath').value.trim();
      if (!root) return;
      try { const r = await call('settings:setRoot', root); toast(r.online ? 'Library folder changed' : 'Saved. The folder can\'t be reached right now.'); again(); await refresh(); } catch { /* toast shown */ }
    };
    el.querySelector('#startwin').onchange = (e) => call('settings:set', { startWithWindows: e.target.checked });
  },
  scan(el) {
    el.onclick = (e) => {
      const c = e.target.closest('[data-copy]'); if (c) { e.preventDefault(); call('docs:copy', c.dataset.copy).then(() => toast('Copied: paste it into the printer\'s settings')); return; }
      const o = e.target.closest('[data-openscan]'); if (o) call('docs:openScanFolder', o.dataset.openscan || null);
    };
  },
  access(el, again) {
    el.onchange = async (e) => {
      const s = e.target.closest('[data-rule]');
      if (s) { try { await call('access:setRule', s.dataset.rule, s.dataset.who, s.value); toast('Access changed'); } catch { /* toast */ } again(); return; }
      const g = e.target.closest('[data-pgroup]');
      if (g) {
        const boxes = $$(`[data-pgroup="${CSS.escape(g.dataset.pgroup)}"]`, el).filter((x) => x.checked).map((x) => x.value);
        const a = await call('access:get'); const p = a.people.find((x) => x.id === g.dataset.pgroup);
        await call('access:savePerson', { ...p, groups: boxes }); toast('Groups saved');
      }
    };
    el.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.dataset.addperson != null) { await call('access:savePerson', { name: el.querySelector('#pname').value, email: el.querySelector('#pemail').value }); toast('Added. Give them groups, or their own access below.'); again(); }
        if (b.dataset.rmperson) { if (await confirmInline(b, 'Remove?')) { await call('access:removePerson', b.dataset.rmperson); again(); } }
        if (b.dataset.rmrule) { await call('access:setRule', b.dataset.rmrule, b.dataset.who, ''); again(); }
        if (b.dataset.addrule != null) { await call('access:setRule', el.querySelector('#xf').value, `p:${el.querySelector('#xp').value}`, el.querySelector('#xl').value); toast('Access changed'); again(); }
      } catch { /* toast shown */ }
    };
  },
  rules(el, again) {
    el.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.dataset.rmrule2) { await call('rules:delete', b.dataset.rmrule2); again(); }
        if (b.dataset.rpick != null) {
          const words = el.querySelector('#rwords').value; const year = el.querySelector('#ryear').checked;
          const f = await pickFolderInline();
          openSettings('rules', (el2) => { el2.querySelector('#rwords').value = words; el2.querySelector('#ryear').checked = year; if (f) { el2.querySelector('#rfolder').dataset.rel = f; el2.querySelector('#rfolder').textContent = shown(f); } });
        }
        if (b.dataset.rsave != null) {
          const words = el.querySelector('#rwords').value.split(',').map((w) => w.trim()).filter(Boolean);
          await call('rules:save', { words, folder: el.querySelector('#rfolder').dataset.rel, year: el.querySelector('#ryear').checked });
          toast('Rule added. The Inbox suggestions are updated.'); again();
        }
      } catch { /* toast shown */ }
    };
  },
  look(el) { el.onclick = async (e) => { const b = e.target.closest('[data-theme-set]'); if (b) { await setThemeChoice(b.dataset.themeSet); $$('[data-theme-set]', el).forEach((x) => x.setAttribute('aria-pressed', x === b)); } }; },
  backup(el) {
    el.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.weblink) call('link:open', b.dataset.weblink);
      if (b.dataset.bk === 'now') { try { await call('backup:now'); toast('Backed up'); } catch { /* toast */ } }
      if (b.dataset.bk === 'restore') call('backup:restore').catch(() => {});
      if (b.dataset.bk === 'folder') call('backup:folder').catch(() => {});
    };
  },
};
async function confirmInline(btn, text) { if (btn.dataset.sure) return true; btn.dataset.sure = '1'; btn.textContent = text; return false; }
/** The folder picker while Settings is open: Settings closes for a moment and opens again. */
async function pickFolderInline() { $('#dlg').close(); return pickFolder({ title: 'File matching documents in', action: 'Choose' }); }
async function setThemeChoice(t) { await call('settings:set', { theme: t }); S.nav.settings.theme = t; setTheme(t); }

// ---------- history page ----------
async function renderHistoryPage() {
  $('#table').hidden = true; $('#tools').hidden = true; $('#selbar').hidden = true; $('#subfolders').hidden = true;
  $('#crumbs').textContent = 'Riyeser Documents'; $('#title').textContent = 'History'; $('#headact').innerHTML = '';
  const h = await call('docs:history', { limit: 300 });
  $('#sub').textContent = 'Who added, filed, moved, renamed, printed, deleted and restored what (newest first)';
  const pv = $('#pageview'); pv.hidden = false;
  pv.innerHTML = h.length ? `<div class="histview">${h.map((x) => `<div><time title="${esc(longWhen(x.at))}">${esc(longWhen(x.at))}</time><span><b>${esc(x.whoName || 'Someone')}</b> ${esc(lowerFirst(x.detail || x.action))}${x.name ? `<small>${x.doc ? `<a href="#" data-doclink="${esc(x.doc)}">${esc(x.name)}</a>` : esc(x.name)}</small>` : ''}</span></div>`).join('')}</div>` : '<div class="f-empty"><b>Nothing yet.</b></div>';
  S.items = []; await showDoc(null);
}

// ---------- help ----------
function openHelp() {
  const h = $('#help');
  const sec = (t, body, open = false) => `<details ${open ? 'open' : ''}><summary>${t}</summary>${body}</details>`;
  h.innerHTML = `<div class="row2" style="justify-content:space-between"><h2>Help</h2><button class="btn ghost" type="button" data-act="closehelp">${icon('close')}Close</button></div>
    ${sec('Getting documents in', '<ul><li><b>Upload</b> (top right), or drag files onto the window. A copy goes to the Inbox; your original stays where it was.</li><li><b>Scan</b>: from a scanner on this PC (Windows\' scan window opens), or at the office printer into a scan folder (Settings › Scan folders). Printer scans arrive in the Inbox within seconds.</li><li>Files put straight into a department folder in File Explorer are picked up too.</li></ul>', true)}
    ${sec('The Inbox and filing', '<p>Each new document is read (scans too) and gets a <b>suggested folder</b>, for example Accounts › Suppliers › Pacific Hardware › 2026. Click <b>File it</b> to move it there, or <b>Change</b> to pick another folder. It learns from what you choose, and from your <b>Filing rules</b> (“anything that mentions BSP goes in Bank statements”).</p><p><b>File all as suggested</b> files everything that has a suggestion in one go.</p>')}
    ${sec('Finding documents', '<p>The search box looks at names and the text inside scans and PDFs, in every folder you can open. Narrow a list with <b>Show</b> (Scans, Photos, Documents), <b>From</b> and <b>Sort</b>.</p>')}
    ${sec('Several at once', '<p>Ctrl-click or Shift-click rows, or click <b>Select</b>. Then Move, Print or Delete them together.</p>')}
    ${sec('Recycle bin and history', '<p>Deleted documents wait in the <b>Recycle bin</b> for 30 days: select one and click Restore. <b>History</b> shows who added, filed, moved, renamed, printed, deleted and restored what. Each document\'s own history is at the bottom of its panel.</p>')}
    ${sec('Folders and access', '<p>The owner sets who can see each folder in <b>Settings › People & access</b>: No access (hidden), View, Add, Edit or Full. The owner always has Full access. Tick <b>Private</b> on a document to keep it to yourself, the owner and people with Full access.</p><p>On a shared network folder, Windows\' own folder permissions are the hard lock: set them too for folders like Payroll & HR.</p>')}
    ${sec('One library for the whole office', '<p>Put the library on a shared folder (Settings › Library), for example <b>\\\\OFFICE-PC\\Riyeser Documents</b>. Every PC that uses it sees the same documents. If that PC is off for a while, the others show what they saw last and catch up when it\'s back.</p>')}
    ${sec('Coming later', '<p>Riyeser cloud sync and linking offices, share links, links for customers to send you files, access for your accountant, and making bills and staff records straight from a document.</p>')}
    <button class="btn" type="button" data-weblink="https://riyeser.com/help/">${icon('open')}More help on riyeser.com</button>`;
  h.hidden = false;
}

// ---------- navigation ----------
function go(place, folder = '') {
  S.place = place; S.folder = folder; S.q = ''; $('#q').value = ''; S.sel.clear(); S.current = null; S.type = 'All'; S.from = ''; S.selecting = false; S.openSide = false;
  renderNav(); loadList({ keep: false });
}

function selectRow(id, e) {
  const multi = S.selecting || e.ctrlKey || e.metaKey;
  if (e.shiftKey && S.anchor) {
    const ids = S.items.map((i) => i.id); const a = ids.indexOf(S.anchor); const b = ids.indexOf(id);
    S.sel = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (multi) { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); S.anchor = id; }
  else { S.sel = new Set([id]); S.anchor = id; S.openSide = true; }
  S.current = S.sel.has(id) ? id : [...S.sel][0] || null;
  renderList(); showDoc(S.current);
}

document.addEventListener('click', async (e) => {
  if (!$('#menu').hidden && !e.target.closest('#menu') && !e.target.closest('#avatar')) closeMenu();
  const link = e.target.closest('[data-doclink]'); if (link) { e.preventDefault(); S.current = link.dataset.doclink; return showDoc(S.current); }
  const web = e.target.closest('[data-weblink]'); if (web) return call('link:open', web.dataset.weblink);
  const row = e.target.closest('#rows .f-tr'); if (row) return selectRow(row.dataset.id, e);
  const b = e.target.closest('button'); if (!b || b.closest('dialog')) return;
  if (b.dataset.place) { closeMenu(); return go(b.dataset.place); }
  if (b.dataset.folder != null) return go('folder', b.dataset.folder);
  if (b.dataset.crumb != null) return b.dataset.crumb ? go('folder', b.dataset.crumb) : go('inbox');
  if (b.dataset.type) { S.type = b.dataset.type; return loadList(); }
  if (b.dataset.themeSet) { await setThemeChoice(b.dataset.themeSet); return openMenu(); }
  if (b.id === 'avatar') return $('#menu').hidden ? openMenu() : closeMenu();
  if (b.id === 'scanbtn') return scanDialog();
  if (b.id === 'uploadbtn') return upload();
  const act = b.dataset.act; if (!act) return;
  closeMenu();
  try {
    if (act === 'fileit') await fileIt();
    else if (act === 'change') await change();
    else if (act === 'fileall') await fileAll();
    else if (act === 'filesel') await fileAll([...S.sel]);
    else if (act === 'move') await moveSel();
    else if (act === 'rename') { if (S.sel.size === 1 && S.current !== [...S.sel][0]) { S.current = [...S.sel][0]; await showDoc(S.current); } await renameDoc(); }
    else if (act === 'delete') await deleteSel();
    else if (act === 'restore') await restoreSel();
    else if (act === 'print') await printSel();
    else if (act === 'open') { await call('docs:open', S.current); }
    else if (act === 'openpdf') await call('docs:openPdf', S.current);
    else if (act === 'share') dialog('<h2>Share links are coming soon</h2><p>Soon you\'ll be able to send someone a link to a document (view only, with an expiry date), and ask customers to send you files with a link.</p><p class="note">For now: Print it, or Open it and attach it to an email.</p><div class="dlgacts"><button class="btn pri" value="">OK</button></div>');
    else if (act === 'program') await programLink(b.dataset.program);
    else if (act === 'emptybin') { if (await confirmBox('Empty the Recycle bin?', 'Everything in it is removed for good. This can\'t be undone.', 'Empty it')) { const n = await call('docs:emptyBin'); toast(`${n} removed for good`); await refresh(); } }
    else if (act === 'selectmode') { S.selecting = !S.selecting; if (!S.selecting) { S.sel = new Set(S.current ? [S.current] : []); } renderHead(); renderList(); }
    else if (act === 'clearsel') { S.sel.clear(); S.selecting = false; renderHead(); renderList(); }
    else if (act === 'closeside') { S.openSide = false; $('#side').classList.remove('open'); }
    else if (act === 'newfolder') { const name = await ask({ title: 'New folder', label: 'Name', hint: 'A new department folder at the top. To make one inside a folder, use New folder when filing or moving.', ok: 'Make it' }); if (name) { await call('folders:create', name); await loadState(); go('folder', name); } }
    else if (act === 'settings') await openSettings('library');
    else if (act === 'scansetup') await openSettings('scan');
    else if (act === 'access') await openSettings('access');
    else if (act === 'rules') await openSettings('rules');
    else if (act === 'help') { if ($('#dlg').open) $('#dlg').close(); openHelp(); }
    else if (act === 'closehelp') $('#help').hidden = true;
  } catch { /* the toast already says what went wrong */ }
});
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-act="private"]')) call('docs:private', S.current, e.target.checked).then(() => { toast(e.target.checked ? 'Private: only you, the owner and people with Full access' : 'No longer private'); refresh(); }).catch(() => { e.target.checked = !e.target.checked; });
});
$('#help').addEventListener('click', (e) => { const b = e.target.closest('[data-act="closehelp"]'); if (b) $('#help').hidden = true; });
$('#from').onchange = (e) => { S.from = e.target.value; loadList(); };
$('#sort').onchange = (e) => { S.sort = e.target.value; remember(); loadList(); };
let qTimer;
$('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = e.target.value.trim(); S.current = null; S.sel.clear(); if (S.place === 'history') S.place = 'inbox'; renderNav(); loadList({ keep: false }); }, 200); });
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,select,textarea,dialog')) { if (e.key === 'Escape' && e.target.id === 'q') { e.target.value = ''; S.q = ''; loadList(); } return; }
  if (e.key === 'Escape') { closeMenu(); $('#help').hidden = true; }
  if ((e.key === 'Delete') && S.place !== 'bin' && selIds().length) deleteSel();
  if (e.key === 'Enter' && S.current && S.place !== 'bin') call('docs:open', S.current).catch(() => {});
  if (e.key === '/' ) { e.preventDefault(); $('#q').focus(); }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && S.items.length) {
    e.preventDefault();
    const i = Math.max(0, S.items.findIndex((x) => x.id === S.current));
    const n = S.items[Math.min(S.items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    selectRow(n.id, { shiftKey: e.shiftKey && false });
    const el = $(`#rows [data-id="${n.id}"]`); if (el) el.scrollIntoView({ block: 'nearest' });
  }
});

// drag and drop onto the window
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
  const paths = [...(e.dataTransfer?.files || [])].map((f) => (window.api.pathForFile ? window.api.pathForFile(f) : f.path)).filter(Boolean);
  if (paths.length) upload(paths);
});

// the program tells the window when something changed (a scan arrived, another PC filed something...)
let changeTimer;
window.api.on && window.api.on('docs-changed', () => { clearTimeout(changeTimer); changeTimer = setTimeout(() => refresh().catch(() => {}), 200); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {});

paintIcons();
refresh().catch((e) => { $('#rows').innerHTML = `<div class="f-empty"><b>Something went wrong opening the library.</b>${esc(e.message)}</div>`; });
window.__docs = { S, go, refresh, openSettings, openHelp, scanDialog, selectRow, pickFolder };
