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
let combine = [];     // PDFs chosen for combining
let everythingDone = null; // last "tidy everything" batch
let review = { tab: 'labels', pool: null, hasAiKey: false, useAI: false, done: null, dupeDone: null, only: 'all' };
let docTypes = [];
let sorter = { pool: null, tab: 'files', done: null, hasAiKey: false, useAI: false };
let finder = { q: '', type: null, year: null, kind: null };
let restoreFilter = '';
let restoreDone = null;
let dupeChoice = new Map(); // duplicate file path -> 'keep' | 'archive' | 'bin'
let appVersion = '';
let folderSel = new Set(); // files ticked on the Folders page
let folderSelDir = null;
let scanning = false;
let currentFolder = null;
let folderFilter = '';
let expanded = new Set();
try { expanded = new Set(JSON.parse(localStorage.getItem('da-expanded') || '[]')); } catch { /* storage unavailable */ }
const saveExpanded = () => { try { localStorage.setItem('da-expanded', JSON.stringify([...expanded])); } catch { /* ignore */ } };
const fileIcon = (ext) => ext === '.pdf' ? '📕' : /\.(docx?|odt|rtf)$/.test(ext) ? '📘' : /\.(xlsx?|csv|ods)$/.test(ext) ? '📗' : /\.(pptx?|key)$/.test(ext) ? '📙'
  : /\.(jpe?g|png|gif|heic|webp|bmp|tiff?)$/.test(ext) ? '🖼' : /\.(mp4|mov|avi|mkv)$/.test(ext) ? '🎞' : /\.(mp3|wav|m4a)$/.test(ext) ? '🎵' : /\.(zip|rar|7z|gz)$/.test(ext) ? '🗜' : /\.(exe|msi|dmg)$/.test(ext) ? '⚙' : /\.(eml|msg)$/.test(ext) ? '✉' : '📄';
const folderHash = (p) => `#folder:${encodeURIComponent(p)}`;
/** A short, readable route instead of a long path: "Organised › Clients › Acme Plumbing › Invoices". */
function route(p) {
  if (!p) return '';
  const root = settings.organisedRoot;
  const parts = p.startsWith(root) ? ['Organised', ...p.slice(root.length).split(/[\\/]/).filter(Boolean)] : short(p).split(/[\\/]/).filter(Boolean);
  return parts.map((x) => `<span class="seg">${esc(x)}</span>`).join('<span class="sep">›</span>');
}
let platform = '';
bridge.call('app:platform').then((p) => { platform = p; }).catch(() => {});

// ---------------- Folders page: tree on the left (with deep search), contents on the right ----------------
let treeRoots = [];
let folderSearch = '';
async function renderTree() {
  const box = $('#ftree');
  if (!box) return;
  try { treeRoots = await bridge.call('folder:roots'); } catch { return; }
  if (folderSearch.trim()) return renderFind();
  const node = async (n) => {
    const open = expanded.has(n.path);
    let html = `<div class="node ${currentFolder === n.path ? 'active' : ''}" data-folder-open="${esc(n.path)}" title="${esc(n.path)}">
      ${n.hasDirs ? `<button class="caret" data-folder-toggle="${esc(n.path)}" title="${open ? 'Collapse' : 'Expand'}">${open ? '▾' : '▸'}</button>` : '<span class="caret"></span>'}
      <span class="ficon">${n.icon || (open ? '📂' : '📁')}</span><span class="label">${esc(n.name)}</span></div>`;
    if (open && n.hasDirs) {
      let kids = [];
      try { kids = (await bridge.call('folder:list', n.path)).dirs; } catch { /* folder gone */ }
      html += `<div class="kids">${(await Promise.all(kids.map((k) => node(k)))).join('')}</div>`;
    }
    return html;
  };
  const html = (await Promise.all(treeRoots.map((r) => node(r)))).join('') || '<div class="muted small" style="padding:4px 12px">No folders yet</div>';
  if (!folderSearch.trim() && $('#ftree')) $('#ftree').innerHTML = html;
}
/** Deep search: every folder and file under your folders, as you type. */
let findToken = 0;
async function renderFind() {
  const q = folderSearch.trim();
  const token = ++findToken;
  const r = await bridge.call('folder:find', q).catch(() => ({ folders: [], files: [] }));
  if (token !== findToken || !$('#ftree')) return;
  const routeOf = (rel) => rel.split(' › ').map((x) => `<span class="seg">${esc(x)}</span>`).join('<span class="sep">›</span>');
  // "Organised › Suppliers › Dynamix" instead of a long path
  const relRoute = (dir) => {
    const root = treeRoots.filter((t) => dir === t.path || dir.startsWith(t.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) return esc(short(dir));
    return routeOf([root.name, ...dir.slice(root.path.length).split(/[\\/]/).filter(Boolean)].join(' › '));
  };
  $('#ftree').innerHTML = `
    <div class="fres-h">Folders ${r.total > r.folders.length ? `(top ${r.folders.length} of ${r.total})` : `(${r.folders.length})`}</div>
    ${r.folders.map((f) => `<div class="fres ${currentFolder === f.path ? 'active' : ''}" data-folder-open="${esc(f.path)}" title="${esc(f.path)}"><span class="ficon">📁</span><div class="grow"><div class="ellipsis"><b>${esc(f.name)}</b></div><div class="route small muted">${routeOf(f.parent)}</div></div></div>`).join('') || '<div class="muted small fres-empty">No folders match.</div>'}
    <div class="fres-h">Files (${r.files.length})</div>
    ${r.files.map((f) => `<div class="fres" data-file="${esc(f.path)}" data-dir="${esc(f.dir)}" data-name="${esc(f.name)}" title="${esc(f.path)} — double-click to open"><span class="ficon">${fileIcon((f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase())}</span><div class="grow"><div class="ellipsis"><b>${esc(f.name)}</b></div><div class="route small muted">${f.company ? `${esc(f.company)} · ` : ''}${relRoute(f.dir)}</div></div></div>`).join('') || '<div class="muted small fres-empty">No files match.</div>'}`;
}
/** Open a folder, and expand the tree down to it so it's visible when the search is cleared. */
function goToFolder(p) {
  const root = treeRoots.filter((r) => p === r.path || p.startsWith(r.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (root) {
    const sep = p.includes('\\') ? '\\' : '/';
    let acc = root.path; expanded.add(acc);
    for (const part of p.slice(root.path.length).split(sep).filter(Boolean)) { acc += sep + part; expanded.add(acc); }
    saveExpanded();
  }
  location.hash = folderHash(p);
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ftree')) return;
  const t = e.target.closest('[data-folder-toggle]');
  if (t) {
    e.stopPropagation();
    const p = t.dataset.folderToggle;
    expanded.has(p) ? expanded.delete(p) : expanded.add(p);
    saveExpanded(); renderTree();
    return;
  }
  const file = e.target.closest('[data-file]');
  if (file) { folderFilter = file.dataset.name; goToFolder(file.dataset.dir); return; }
  const n = e.target.closest('[data-folder-open]');
  if (n) { folderFilter = ''; goToFolder(n.dataset.folderOpen); }
});
document.addEventListener('dblclick', (e) => { const f = e.target.closest('#ftree [data-file]'); if (f) safe(async () => { const now = await bridge.call('file:open', f.dataset.file); if (now) movedNote(now); }); });

/** The two-pane layout of the Folders page. The right side is filled by `fill`. */
async function folderShell(fill) {
  if (!$('#fsplit')) {
    page.innerHTML = `<div class="fsplit" id="fsplit">
      <aside class="fpane">
        <div class="fsearch"><input id="fsearch" placeholder="🔍  Find a folder or file…" value="${esc(folderSearch)}" autocomplete="off"><button class="iconbtn" data-act="fsearchclear" title="Clear" ${folderSearch ? '' : 'hidden'}>✕</button></div>
        <div class="fpane-tools"><span class="muted small">${folderSearch ? 'Search results' : 'All folders'}</span><span class="spacer"></span><button class="iconbtn" data-act="treehide" title="Hide the folder list (more room)">◀</button><button class="iconbtn" data-act="treecollapse" title="Collapse all">⊟</button><button class="iconbtn" data-act="treerefresh" title="Refresh">⟳</button></div>
        <div id="ftree" class="ftree"></div>
      </aside>
      <section class="fmain" id="fmain"></section><button class="treeshow" data-act="treeshow" title="Show the folder list">▶ Folders</button></div>`;
    try { if (localStorage.getItem('da-tree-hidden') === '1') $('#fsplit').classList.add('notree'); } catch { /* ignore */ }
    let timer;
    $('#fsearch').addEventListener('input', (e) => {
      folderSearch = e.target.value;
      $('[data-act="fsearchclear"]').hidden = !folderSearch;
      $('.fpane-tools .muted').textContent = folderSearch ? 'Search results' : 'All folders';
      clearTimeout(timer); timer = setTimeout(renderTree, 180);
    });
    $('#fsearch').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; e.target.dispatchEvent(new Event('input')); } });
  }
  await renderTree();
  await fill($('#fmain'));
}
// Menu sections ("Tidy up", "Work") can be collapsed to give the folder list more room (remembered).
document.querySelectorAll('.navsec').forEach((b) => {
  const g = document.querySelector(`.navgroup[data-group="${b.dataset.sec}"]`);
  const label = b.textContent.slice(2);
  const apply = (closed) => { g.classList.toggle('collapsed', closed); b.textContent = `${closed ? '▸' : '▾'} ${label}`; };
  try { apply(localStorage.getItem(`da-sec-${b.dataset.sec}`) === '1'); } catch { /* ignore */ }
  b.addEventListener('click', () => { const closed = !g.classList.contains('collapsed'); apply(closed); try { localStorage.setItem(`da-sec-${b.dataset.sec}`, closed ? '1' : '0'); } catch { /* ignore */ } });
});


// Drag the edge of the side panel to make it wider or narrower (remembered).
(() => {
  const setW = (w) => document.documentElement.style.setProperty('--nav-w', `${Math.min(480, Math.max(200, w))}px`);
  try { const w = +localStorage.getItem('da-navw'); if (w) setW(w); } catch { /* ignore */ }
  const handle = $('#navresize');
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => setW(ev.clientX);
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up);
      try { localStorage.setItem('da-navw', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-w'), 10)); } catch { /* ignore */ }
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  });
})();
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

// ---------------- small modal dialogs ----------------
function modal(html, onOpen) {
  return new Promise((resolve) => {
    let box = $('#modal');
    if (!box) { document.body.insertAdjacentHTML('beforeend', '<div id="modal" class="modal"></div>'); box = $('#modal'); }
    box.innerHTML = `<div class="modalbox" id="modalbox">${html}</div>`; // fresh element each time: no leftover click handlers
    box.hidden = false;
    const done = (v) => { box.hidden = true; resolve(v); };
    $('#modalbox').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) done(b.dataset.m === 'cancel' ? null : b.dataset.m); };
    box.onkeydown = (e) => { if (e.key === 'Escape') done(null); };
    if (onOpen) onOpen(done);
  });
}
const routeHtml = (p) => (p ? `<span class="route">${route(p)}</span>` : '<span class="muted">No folder chosen yet</span>');

/**
 * Move file(s) to a folder you pick, and optionally make a rule so files like them always go there.
 * mode 'files': move now (Folders page). mode 'plan': change where a file in the Organise/Tidy list will go.
 */
async function ruleDialog(files, mode = 'files') {
  const sug = await bridge.call('rules:suggest', files[0]);
  let folder = mode === 'plan' ? (plan.plan.find((p) => p.from === files[0])?.dir || '') : '';
  const isYear = (f) => /^(19|20)\d{2}$/.test((f || '').split(/[\\/]/).pop());
  const html = `<div class="row"><h2 style="margin:0">${files.length > 1 ? `Move ${files.length} files` : `Where does “${esc(sug.name)}” belong?`}</h2><span class="spacer"></span><button class="iconbtn" data-m="cancel">✕</button></div>
    <div class="rulebox"><div class="small muted">Move to</div><div class="row" style="margin-top:4px"><div class="grow" id="rfolder">${routeHtml(folder)}</div><button data-act="rpick">Choose folder…</button></div>
      <label class="row small" style="margin-top:8px"><input type="checkbox" id="ryear" ${isYear(folder) ? 'checked' : ''}> Put into a folder for each year (…/2026)</label></div>
    <label class="row" style="margin-top:14px"><input type="checkbox" id="rmake" checked> <b>Make a rule</b> — from now on, files like this go here automatically</label>
    <div class="rulebox" id="rconds"><div class="small muted" style="margin-bottom:6px">Files that match ALL of these:</div>
      ${sug.company ? `<label class="row small"><input type="checkbox" id="rc-company" checked> From/for company <b>${esc(sug.company)}</b></label>` : ''}
      ${sug.docType ? `<label class="row small"><input type="checkbox" id="rc-type" checked> Document type <b>${esc(sug.docType)}</b></label>` : ''}
      <label class="row small"><input type="checkbox" id="rc-words" ${!sug.company && !sug.docType && sug.words.length ? 'checked' : ''}> Name or text contains <input id="rc-wordlist" value="${esc(sug.words.join(' '))}" placeholder="e.g. timesheet" style="flex:1;min-width:120px;padding:3px 8px"></label>
      ${sug.kind ? `<label class="row small"><input type="checkbox" id="rc-kind" ${!sug.company && !sug.docType && !sug.words.length ? 'checked' : ''}> File type <b>${esc(sug.kind)}</b></label>` : ''}
      <label class="row small" style="margin-top:6px">Rule name <input id="rc-name" placeholder="(automatic)" style="flex:1;padding:3px 8px"></label></div>
    <div class="row" style="margin-top:16px"><span class="spacer"></span><button data-m="cancel">Cancel</button><button class="primary" data-m="ok">${mode === 'plan' ? 'Use this folder' : 'Move'}</button></div>`;
  const result = await modal(html, () => {
    $('#rmake').addEventListener('change', (e) => { $('#rconds').style.opacity = e.target.checked ? 1 : 0.45; });
    $('#modalbox').addEventListener('click', async (e) => {
      if (!e.target.closest('[data-act="rpick"]')) return;
      e.stopPropagation();
      const f = await bridge.call('dialog:folder', folder || sug.organisedRoot);
      if (f) { folder = f; $('#rfolder').innerHTML = routeHtml(f); if (isYear(f)) $('#ryear').checked = true; }
    });
  });
  if (result !== 'ok') return;
  if (!folder) { toast('Choose a folder first.'); return; }
  const useYear = $('#ryear').checked;
  const makeIt = $('#rmake').checked;
  const conditions = {
    company: $('#rc-company')?.checked ? sug.company : null,
    docType: $('#rc-type')?.checked ? sug.docType : null,
    words: $('#rc-words')?.checked ? $('#rc-wordlist').value.toLowerCase().split(/[\s,]+/).filter(Boolean) : [],
    kind: $('#rc-kind')?.checked ? sug.kind : null,
  };
  let rule = null;
  if (makeIt) {
    const r = await bridge.call('rules:save', { folder, conditions, useYear, name: $('#rc-name').value.trim() || undefined });
    rule = r.rule;
  }
  if (mode === 'plan') {
    const r = await bridge.call('learn:choose', files[0], folder);
    plan = r.plan;
    if (rule) plan = await bridge.call('organise:last');
    toast(rule ? `Rule saved: “${rule.name}” → ${rule.where}. Files in this list that match now go there too.` : 'Got it — I\'ll file similar files there from now on.');
    render();
    return;
  }
  const batch = await bridge.call('files:moveInto', files, folder, useYear);
  folderSel = new Set();
  toast(`Moved ${batch.moves.length} file(s)${batch.errors.length ? ` (${batch.errors.length} couldn't be moved)` : ''}.${rule ? ` Rule saved: “${rule.name}”.` : ''}`);
  if (rule) await offerMatches(rule);
  render();
}

/** After making a rule: show other files that match it but are somewhere else, and move the ones you tick. */
async function offerMatches(rule) {
  const matches = await bridge.call('rules:matches', rule.id);
  if (!matches.length) { toast(`Rule “${rule.name}” saved — no other files need moving.`); return; }
  const r = await modal(`<div class="row"><h2 style="margin:0">${matches.length} other file(s) match “${esc(rule.name)}”</h2><span class="spacer"></span><button class="iconbtn" data-m="cancel">✕</button></div>
    <p class="muted small">They're in other folders. Tick the ones to move to <b>${esc(rule.where)}</b>.</p>
    <div class="row small"><button class="link" data-act="mall">Select all</button><button class="link" data-act="mnone">Clear</button></div>
    <div class="matchlist">${matches.map((m, i) => `<label class="row small mrow"><input type="checkbox" data-mi="${i}" checked><div class="grow"><b>${esc(m.name)}</b><div class="muted">${routeHtml(m.currentDir)} → ${routeHtml(m.dir)}</div></div></label>`).join('')}</div>
    <div class="row" style="margin-top:14px"><span class="spacer"></span><button data-m="cancel">Not now</button><button class="primary" data-m="ok">Move ticked files</button></div>`, () => {
    $('#modalbox').addEventListener('click', (e) => {
      const a = e.target.closest('[data-act="mall"],[data-act="mnone"]');
      if (a) { e.stopPropagation(); document.querySelectorAll('[data-mi]').forEach((c) => { c.checked = a.dataset.act === 'mall'; }); }
    });
  });
  if (r !== 'ok') return;
  const picked = matches.filter((_, i) => document.querySelector(`[data-mi="${i}"]`)?.checked);
  const batch = await bridge.call('files:moveTo', picked);
  toast(`Moved ${batch.moves.length} file(s) to ${rule.where}. You can undo this on the Organise page.`);
}

// ---------------- plan rows (shared by Organise and Tidy everything) ----------------
  const facts = (p) => [p.details?.date && `📅 ${esc(p.details.date)}`, p.details?.reference && `# ${esc(p.details.reference)}`, p.details?.amount && `💲 ${esc(p.details.amount)}`].filter(Boolean).map((f) => `<span class="pill">${f}</span>`).join(' ');
  const readBox = (p) => p.preview ? `<details class="small"><summary class="muted">What I read</summary><div class="readbox">${esc(p.preview)}…</div></details>` : '';
  const rows = (items) => items.map((p) => `<tr>
    <td><input type="checkbox" data-sel="${esc(p.from)}" ${selected.has(p.from) ? 'checked' : ''}></td>
    <td><b class="fname">${p.isFolder ? '📁 ' : ''}${esc(p.name)}</b>
      <div class="dest route" title="${esc(p.to || p.dir)}">${p.currentDir
        ? `<span class="pill ${p.change === 'rename' ? '' : 'warn'}">${esc(p.change)}</span> ${p.change === 'rename' ? `in ${route(p.dir)}` : `<span class="muted">from</span> ${route(p.currentDir)} <span class="muted">to</span> ${route(p.dir)}`}`
        : `<span class="arrow">→</span> ${route(p.dir || p.to)}`} <button class="link small changefolder" data-act="choosefolder" data-from="${esc(p.from)}" title="Pick a different folder - I'll remember it for similar files">Change folder…</button></div>
      ${p.learned ? `<div class="small learnednote">🧠 ${esc(p.learned)}</div>` : ''}
      ${p.newName ? `<div class="row small" style="margin-top:4px"><span class="muted">rename to</span><input class="rename" data-rename="${esc(p.from)}" value="${esc(p.to.split(/[\\/]/).pop())}" title="Edit the new name if you like"></div>` : ''}
      ${p.warning ? `<div class="small" style="color:var(--warn);margin-top:4px">⚠ ${esc(p.warning)}</div>` : ''}
      ${p.fallback ? `<div class="small muted" style="margin-top:3px">Filed by type for now. ${p.company ? `<button class="link small" data-act="addco" data-name="${esc(p.company)}">Add “${esc(p.company)}” as a company</button>` : 'Add the sender in <a href="#companies">Companies</a>'}, then use Re-check to file it under them.</div>` : ''}
      <div style="margin-top:4px">${facts(p)}</div>
      ${p.group ? `<div class="small" style="color:var(--good);margin-top:3px">🔗 Kept with ${p.group.size - 1} related document${p.group.size > 2 ? 's' : ''} — they share ${esc(p.group.because.join(', '))}${p.companyFromGroup ? ` (that's how I know it's for ${esc(p.company)})` : ''}</div>` : ''}
      <div class="small muted">${esc(p.reasons.slice(0, 2).join(' · '))}</div>${readBox(p)}</td>
    <td><div class="small">${esc(p.docType)}</div><div style="margin-top:4px">${confPill(p.warning ? 'low' : p.confidence)}</div></td>
    <td><button class="link" data-act="${p.isFolder ? 'reveal' : 'open'}" data-path="${esc(p.from)}">${p.isFolder ? 'Show' : 'Open'}</button></td></tr>`).join('');

// A list was out of date: the file had been moved, so it was opened from its new place. Refresh the list.
function movedNote(now) {
  toast(`That file had moved — opened it from ${now.split(/[\\/]/).slice(-3, -1).join(' › ')}`);
  setTimeout(() => render(), 300);
}

// ---------------- duplicate sets (Smart review and Sort by type) ----------------
const dupeChoiceOf = (f) => dupeChoice.get(f.path) || f.recommend;
const dupeChangeCount = (dupes) => dupes.reduce((n, g) => n + g.files.filter((f) => dupeChoiceOf(f) !== 'keep').length, 0);
function dupeCardsHtml(dupes) {
  const choice = dupeChoiceOf;
  return dupes.map((g, gi) => `<div class="card dupegroup">
      <div class="row"><b>${g.kind === 'exact' ? `Exact copies (${g.files.length})` : `Same document, different ${g.differentFormats ? 'format' : 'name or version'} — ${g.similarity >= 99 ? 'almost word-for-word the same' : `${g.similarity}% match`}`}</b><span class="spacer"></span>
        <button class="link small" data-act="dupeall" data-g="${gi}" data-v="keep">Keep all</button><button class="link small" data-act="dupeall" data-g="${gi}" data-v="rec">Use my suggestion</button></div>
      <ul class="list">${g.files.map((f) => `<li class="dupefile"><div class="grow"><b class="fname">${esc(f.name)}</b>
          <div class="small muted">${fmtSize(f.size)} · changed ${esc(new Date(f.mtime).toLocaleDateString())} · ${f.recommend === 'keep' ? '<span style="color:var(--good)">suggest keep</span>' : 'suggest archive'}: ${esc(f.why)}</div>
          <div class="route small" title="${esc(f.path)}">${route(f.path.split(/[\\/]/).slice(0, -1).join(f.path.includes('\\') ? '\\' : '/'))}</div></div>
        <div class="seg3" role="radiogroup">${[['keep', 'Keep'], ['archive', 'Archive'], ['bin', 'Recycle Bin']].map(([v, l]) => `<label class="${choice(f) === v ? 'on' : ''}"><input type="radio" name="d${gi}-${esc(f.path)}" data-dupe="${esc(f.path)}" value="${v}" ${choice(f) === v ? 'checked' : ''}>${l}</label>`).join('')}</div>
        <button class="link" data-act="open" data-path="${esc(f.path)}">Open</button></li>`).join('')}</ul></div>`).join('');
}

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
    if (plan?.mode === 'review') plan = null; // Smart review results live on their own page
    const history = await bridge.call('organise:history');
    const folders = await bridge.call('organise:folders');
    const groups = {};
    for (const p of plan?.plan || []) {
      const key = (settings.filingLayout || 'typeYear') === 'typeYear' && p.dir && p.dir.startsWith(settings.organisedRoot)
        ? p.dir.slice(settings.organisedRoot.length).split(/[\\/]/).filter(Boolean).join(' › ') + (p.fallback ? ' (type unknown — filed by format)' : '')
        : p.fallback ? `Couldn't tell who it's from › ${p.dir.split(/[\\/]/).slice(-2).join(' › ')}` : p.company ? `${p.companyType} › ${p.company}${p.group && /[\\/]Projects[\\/]/.test(p.dir) ? ` › 🔗 ${p.group.name}` : ''}` : p.category === 'Media' ? 'Photos, videos & other media' : 'General documents';
      (groups[key] = groups[key] || []).push(p);
    }
    page.innerHTML = `
      <div class="row"><div><h1>Organise files</h1><p class="sub">Sorts ${settings.watchFolders.map((f) => `<b>${esc(f.split(/[\\/]/).pop())}</b>`).join(' and ') || '(add folders in Settings)'} into your <b title="${esc(settings.organisedRoot)}">Organised</b> folder ${(settings.filingLayout || 'typeYear') === 'typeYear' ? 'by type and year (e.g. <b>Invoices › 2026</b>)' : 'by company and document type'}. Nothing moves until you approve it, and every batch can be undone.</p></div></div>
      <div class="card" id="foldercard"><h2>Folders to tidy</h2>
        <p class="muted small">Tick the loose files to sort, and choose what happens to each folder: <b>Leave</b> it alone, <b>Sort files inside</b> (each file is filed separately and the empty folder is removed), or <b>Move whole folder</b> (kept together, moved into Organised — under the company if most of it is theirs).</p>
        ${folders.length ? `<div class="folderlist">${folders.map((f) => f.isRoot
          ? `<label class="row small froot"><input type="checkbox" data-folder="${esc(f.path)}" ${f.checked ? 'checked' : ''}> <b>${esc(f.name)}</b> <span class="muted">— loose files (${f.files})</span></label>`
          : `<div class="row small fsub"><span class="grow ellipsis">📁 ${esc(f.name)} <span class="muted">(${f.files >= 500 ? '500+' : f.files} file${f.files === 1 ? '' : 's'})</span></span>
              <select data-foldermode="${esc(f.path)}" class="small"><option value="leave" ${f.mode === 'leave' ? 'selected' : ''}>Leave</option><option value="sort" ${f.mode === 'sort' ? 'selected' : ''}>Sort files inside</option><option value="move" ${f.mode === 'move' ? 'selected' : ''}>Move whole folder</option></select></div>`).join('')}</div>` : '<div class="empty">Add folders to tidy in <a href="#settings">Settings</a>.</div>'}
        ${platform === 'win32' ? `<div class="row" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)"><div class="grow small"><b>Desktop icons</b><div class="muted">Line up everything left on your desktop neatly in a grid, sorted by name. Your screen blinks for a second while Windows refreshes the desktop.</div></div>
          <button data-act="arrangedesk">Tidy desktop icons</button><button class="link small" data-act="unarrangedesk" title="Turn auto-arrange off again">Undo</button></div>` : ''}
      </div>
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
          <table class="plantable"><colgroup><col style="width:34px"><col><col style="width:128px"><col style="width:58px"></colgroup><tr><th></th><th>File → ${plan.mode === 'recheck' ? 'change' : 'where it will go'}</th><th>Type</th><th></th></tr>${rows(items)}</table>`).join('') : `<div class="empty">${plan.mode === 'recheck' ? 'Everything in your Organised folder already has a good name and is in the right place. 👍' : 'Nothing to file — your folders are tidy.'}</div>`}
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

  async pdf() {
    const recent = await bridge.call('pdf:recent');
    page.innerHTML = `<h1>PDF editor</h1><p class="sub">View, edit, fill in and sign PDFs, all on your computer. Every time you save, the previous version is backed up automatically.</p>
      <div class="grid">
        <div class="card"><h2>Open a PDF</h2><p class="muted small">Add or edit text, highlight, draw, white-out, tick boxes, sign, fill forms, and rotate, delete, reorder or extract pages.</p>
          <button class="primary" data-act="pdfopen">Open PDF…</button>
          <p class="muted small" style="margin-top:12px">Want PDFs from email, your browser and File Explorer to open here?</p>
          <button data-act="pdfdefault">Set as my PDF app</button></div>
        <div class="card"><h2>Convert</h2><p class="muted small">Turn pictures, Word, Excel, PowerPoint or text files into a PDF — or turn a PDF into an editable Word document. Uses Microsoft Office when it's installed for an exact match.</p>
          <div class="row"><button class="primary" data-act="convtopdf">Create PDF from files…</button><button data-act="convtoword">PDF → Word…</button></div></div>
        <div class="card"><h2>Combine PDFs</h2><p class="muted small">Join several PDFs into one, in the order shown.</p>
          <ul class="list" id="combinelist">${combine.map((f, i) => `<li><div class="grow path ellipsis">${esc(short(f))}</div><button class="link" data-act="cmbup" data-i="${i}">▲</button><button class="link" data-act="cmbrm" data-i="${i}">✕</button></li>`).join('') || '<li class="muted small">No files chosen yet.</li>'}</ul>
          <div class="row" style="margin-top:8px"><button data-act="cmbadd">Add PDFs…</button><button class="primary" data-act="cmbgo" ${combine.length > 1 ? '' : 'disabled'}>Combine &amp; save</button></div></div>
      </div>
      <div class="card"><div class="row"><h2 style="margin:0">Recent</h2><span class="spacer"></span><button class="link" data-act="pdfbackups">Open backups folder</button></div>
        ${recent.length ? `<ul class="list">${recent.map((f) => `<li><div class="grow"><b>${esc(f.split(/[\\/]/).pop())}</b><div class="path">${esc(short(f))}</div></div><button class="link" data-act="pdfedit" data-path="${esc(f)}">Edit</button><button class="link" data-act="open" data-path="${esc(f)}">Open in default app</button></li>`).join('')}</ul>` : '<div class="empty">No PDFs opened yet.</div>'}</div>`;
  },

  // "Tidy everything": every personal folder and sub-folder, filed like an assistant would - by company, type and year.
  async everything() {
    const last = await bridge.call('organise:last');
    plan = last && last.mode === 'everything' ? last : null;
    const libs = settings.libraryFolders || [];
    const never = settings.neverTouch || [];
    const list = (key, items, empty) => `<div class="chips">${items.map((f, i) => `<span class="chip" title="${esc(f)}">📁 ${esc(f.split(/[\\/]/).filter(Boolean).pop() || f)}<button data-act="evdel" data-key="${key}" data-i="${i}" title="Remove">×</button></span>`).join('') || `<span class="muted small">${empty}</span>`}</div>`;
    const groups = {};
    for (const p of plan?.plan || []) {
      const segs = p.dir.slice(settings.organisedRoot.length).split(/[\\/]/).filter(Boolean);
      const key = p.isFolder ? 'Folders kept together' : segs.slice(0, segs[0] === 'Media' || segs[0] === 'Other' || segs[0] === 'General' ? 2 : 2).join(' › ') || 'Organised';
      (groups[key] = groups[key] || []).push(p);
    }
    const order = Object.keys(groups).sort((a, b) => (a === 'Folders kept together' ? -1 : b === 'Folders kept together' ? 1 : a.localeCompare(b)));
    const nFiles = (plan?.plan || []).reduce((n, p) => n + (p.isFolder ? p.files : 1), 0);
    page.innerHTML = `<h1>Tidy everything</h1>
      <p class="sub">Goes through all your personal folders <b>and every sub-folder</b>, and files everything like an assistant would: ${(settings.filingLayout || 'typeYear') === 'typeYear' ? 'by type and by year — e.g. <b>Invoices › 2026</b>, <b>Drawings › 2026</b> or <b>Pictures › 2024</b>' : 'by company, by type and by year — e.g. <b>Clients › Acme Plumbing › Invoices › 2026</b> or <b>Media › Images › 2024</b>'}. Named folders whose contents belong together (like “Ark project” or “Smith wedding”) are kept together. Nothing moves until you approve it, and Undo puts everything back.</p>
      <div class="grid">
        <div class="card"><h2>Folders to go through</h2>${list('libraryFolders', libs, 'None — add a folder')}<button style="margin-top:8px" data-act="evadd" data-key="libraryFolders">+ Add folder</button></div>
        <div class="card"><h2>Never touch</h2><p class="muted small">Anything in these folders stays exactly where it is.</p>${list('neverTouch', never, 'Nothing yet')}<button style="margin-top:8px" data-act="evadd" data-key="neverTouch">+ Add folder</button>
          <p class="muted small" style="margin-top:10px">Always left alone automatically: Windows and program folders, folders programs rely on (Outlook data, accounting files like QuickBooks/MYOB, OneNote, game saves, photo-library catalogues), code projects, installed programs, shortcuts and system files.</p></div>
      </div>
      <div class="row" style="margin:6px 0 16px"><button class="primary" data-act="evscan" ${scanning ? 'disabled' : ''}>${scanning ? 'Looking…' : plan ? 'Look through everything again' : 'Look through everything'}</button>
        ${scanning ? '<button data-act="evcancel">Stop</button>' : ''}<span id="scan-status" class="muted small"></span></div>
      ${everythingDone ? `<div class="card" style="border-color:var(--good)"><b>Done — moved ${everythingDone.moves.length} item(s)${everythingDone.errors.length ? `, ${everythingDone.errors.length} couldn't be moved` : ''}.</b> <span class="muted">Changed your mind? <button class="link" data-act="undo" data-id="${esc(everythingDone.id)}">Undo all of it</button></span></div>` : ''}
      ${!plan ? '' : `
      <div class="card"><div class="row"><h2 style="margin:0">Ready to file: ${nFiles} file(s)${groups['Folders kept together'] ? `, including ${groups['Folders kept together'].length} folder(s) kept together` : ''}</h2><span class="spacer"></span>
          <button class="link" data-act="selall">Select all</button><button class="link" data-act="selnone">Clear</button>
          <button class="primary" data-act="apply" ${selected.size ? '' : 'disabled'}>Move ${selected.size} selected</button></div>
        <p class="muted small">Grouped by where things will go. Open a group to see (and untick) individual items.</p>
        ${order.map((g) => `<details class="evgroup" ${g === 'Folders kept together' ? 'open' : ''}><summary><b>${esc(g)}</b> <span class="muted">— ${groups[g].length} item(s)</span></summary>
          <table class="plantable"><colgroup><col style="width:34px"><col><col style="width:128px"><col style="width:58px"></colgroup>${rows(groups[g].slice(0, 300))}</table>${groups[g].length > 300 ? `<p class="muted small">…and ${groups[g].length - 300} more (all included).</p>` : ''}</details>`).join('')}
      </div>
      <div class="card"><details><summary><b>Kept as they are (${plan.kept.length})</b> <span class="muted small">— folders and files I left alone, and why</span></summary>
        <ul class="list">${plan.kept.slice(0, 400).map((k) => `<li><div class="grow" title="${esc(k.path)}"><b>${esc(k.path.split(/[\\/]/).pop())}</b> <span class="small muted">— ${esc(k.reason)}</span><div class="path ellipsis">in ${esc(short(k.path.split(/[\\/]/).slice(0, -1).join(k.path.includes('\\') ? '\\' : '/')))}</div></div><button class="link" data-act="reveal" data-path="${esc(k.path)}">Show</button></li>`).join('') || '<li class="muted">Nothing.</li>'}</ul></details></div>
      ${plan.review.length ? `<div class="card"><h2>Needs your help (${plan.review.length})</h2><p class="muted small">I couldn't tell where these belong, so they stay where they are.</p><ul class="list">${plan.review.slice(0, 200).map((r) => `<li><div class="grow"><b>${esc(r.name)}</b><div class="path">${esc(short(r.from))}</div></div><button class="link" data-act="open" data-path="${esc(r.from)}">Open</button></li>`).join('')}</ul></div>` : ''}`}`;
  },

  // "Where are my files?": every file the app moved, where it is now, and one button to put everything back.
  async restore() {
    const r = await bridge.call('restore:summary');
    const q = restoreFilter.trim().toLowerCase();
    const rows = r.files.filter((f) => !q || `${f.name} ${f.was} ${f.now || ''}`.toLowerCase().includes(q));
    const dirOf = (p) => p.split(/[\\/]/).slice(0, -1).join(p.includes('\\') ? '\\' : '/');
    const away = r.files.filter((f) => !f.back).length;
    page.innerHTML = `<h1>Where are my files?</h1>
      <p class="sub">Every file Desk Assistant has moved or renamed, where it used to be, and where it is now. Search by its old or new name.</p>
      ${restoreDone ? `<div class="card" style="border-color:var(--good)"><b>Put back ${restoreDone.restored} file(s) where they were.</b>
        ${restoreDone.problems.length ? `<details class="small" style="margin-top:6px"><summary>${restoreDone.problems.length} need a look</summary><ul class="list">${restoreDone.problems.map((p) => `<li><div class="grow"><b class="fname">${esc(p.file.split(/[\\/]/).pop())}</b><div class="small muted">${esc(p.error)}</div><div class="route small">${route(dirOf(p.file))}</div></div></li>`).join('')}</ul></details>` : ''}
        <div class="small muted" style="margin-top:6px">A list of where everything was is saved at <button class="link small" data-act="reveal" data-path="${esc(restoreDone.report)}">${esc(restoreDone.report.split(/[\\/]/).pop())}</button>. Automatic tidying is switched off.</div></div>` : ''}
      <div class="card"><div class="row wrap"><div class="grow"><h2 style="margin:0">Put everything back</h2>
          <p class="muted small" style="margin:4px 0 0">Moves <b>${away}</b> file(s) back to the folder they were in, with their original names, from before Desk Assistant touched them. If something new has taken a name, both are kept. Nothing is deleted.</p></div>
        <button class="primary" data-act="restoreall" ${away ? '' : 'disabled'}>Put everything back</button>
        <button data-act="namesback" ${r.files.length ? '' : 'disabled'} title="Original names back, files stay in their current folders">Only change names back</button>
        <button data-act="restorereport" ${r.files.length ? '' : 'disabled'}>Save list as spreadsheet</button></div>
        ${r.untraceable.length ? `<details class="small" style="margin-top:10px"><summary><b>${r.untraceable.length} file(s) I moved but can't trace back</b> <span class="muted">— their old location is no longer recorded, so they'll stay where they are</span></summary>
          <ul class="list">${r.untraceable.slice(0, 300).map((p) => `<li><div class="grow"><b class="fname">${esc(p.split(/[\\/]/).pop())}</b><div class="route small">${route(dirOf(p))}</div></div><button class="link" data-act="reveal" data-path="${esc(p)}">Show</button></li>`).join('')}</ul></details>` : ''}
        ${r.binned.length ? `<details class="small" style="margin-top:6px"><summary><b>${r.binned.length} file(s) were moved to the Recycle Bin</b> <span class="muted">— open the Recycle Bin on your desktop, right-click one → Restore</span></summary>
          <ul class="list">${r.binned.slice(0, 300).map((b) => `<li><div class="grow"><b class="fname">${esc(b.path.split(/[\\/]/).pop())}</b><div class="route small">from ${route(dirOf(b.path))}</div></div></li>`).join('')}</ul></details>` : ''}</div>
      <div class="card"><div class="row wrap"><h2 style="margin:0" class="grow">Files moved or renamed (${r.files.length})</h2>
        <input id="rsearch" placeholder="Search by old or new name…" value="${esc(restoreFilter)}" style="min-width:220px"></div>
        ${rows.length ? `<ul class="list">${rows.slice(0, 500).map((f) => `<li><div class="grow"><b class="fname">${esc(f.now ? f.now.split(/[\\/]/).pop() : f.name)}</b>${f.now && f.now.split(/[\\/]/).pop() !== f.name ? `<div class="small muted">was called ${esc(f.name)}</div>` : ''}
            <div class="route small"><span class="muted">was in</span> ${route(dirOf(f.was))}</div>
            <div class="route small">${f.back ? '<span style="color:var(--good)">back where it was</span>' : f.now ? `<span class="muted">now in</span> ${route(dirOf(f.now))}` : '<span style="color:var(--warn)">not found — it may have been moved or deleted outside the app</span>'}</div>
            <div class="small muted">moved ${esc(new Date(f.at).toLocaleString())}</div></div>
            ${f.now ? `<button class="link" data-act="open" data-path="${esc(f.now)}">Open</button><button class="link" data-act="reveal" data-path="${esc(f.now)}">Show</button>` : ''}</li>`).join('')}</ul>${rows.length > 500 ? `<p class="muted small">Showing 500 of ${rows.length} — search to narrow it down.</p>` : ''}` : `<div class="empty">${r.files.length ? 'No matches.' : 'Desk Assistant hasn’t moved any files (or they’ve all been put back).'}</div>`}</div>`;
    const inp = $('#rsearch');
    if (inp) inp.addEventListener('input', () => { restoreFilter = inp.value; clearTimeout(inp._t); inp._t = setTimeout(async () => { await pages.restore(); const i = $('#rsearch'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); });
  },
  // "Smart review": reads every file in the chosen folders, suggests a label, a dated name and a folder, and finds duplicates.
  async review() {
    const last = await bridge.call('organise:last');
    plan = last && last.mode === 'review' ? last : null;
    if (!docTypes.length) docTypes = await bridge.call('review:types').catch(() => []);
    if (!review.pool) { const r = await bridge.call('review:pool'); review.pool = r.pool; review.hasAiKey = r.hasAiKey; review.useAI = r.hasAiKey && !!settings.reviewUseAI; }
    const nm = (f) => f.split(/[\\/]/).filter(Boolean).pop() || f;
    const items = (plan?.plan || []).filter((p) => review.only === 'all' || (review.only === 'renames' ? p.renamed : p.moved));
    const dupes = plan?.dupes || [];
    const tabBtn = (t, label) => `<button class="${review.tab === t ? 'active' : ''}" data-act="rvtab" data-t="${t}">${label}</button>`;
    const pills = (p) => [
      `<select class="typesel ${p.label.type ? '' : 'unknown'}" data-settype="${esc(p.from)}" title="Wrong type? Pick the right one - the name and folder update to match">${p.label.type ? '' : '<option value="" selected>Type unknown…</option>'}${docTypes.map((t) => `<option ${t === p.label.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}<option value="Other">Other</option></select>`,
      p.label.company ? `<span class="pill">${esc(p.label.company)}</span>` : '',
      p.label.date ? `<span class="pill" title="Date taken from the ${esc(p.label.dateFrom)}">📅 ${esc(p.label.date)}</span>` : '<span class="pill warn" title="No date found in the document">no date</span>',
      p.details?.reference ? `<span class="pill"># ${esc(p.details.reference)}</span>` : '',
      p.details?.amount ? `<span class="pill">💲 ${esc(p.details.amount)}</span>` : '',
      p.aiChecked ? '<span class="pill good">✨ AI checked</span>' : '',
      confPill(p.warning ? 'low' : p.confidence),
    ].filter(Boolean).join(' ');
    const rvRows = items.slice(0, 500).map((p) => `<tr>
      <td><input type="checkbox" data-sel="${esc(p.from)}" ${selected.has(p.from) ? 'checked' : ''}></td>
      <td><div class="small muted">Now</div><b class="fname">${esc(p.name)}</b>
        <div style="margin:5px 0">${pills(p)}</div>
        ${p.renamed ? `<div class="row small"><span class="muted">Rename to</span><input class="rename" data-rename="${esc(p.from)}" value="${esc(p.to.split(/[\\/]/).pop())}" title="Edit the new name if you like"></div>` : '<div class="small muted">Name is fine — keeping it</div>'}
        <div class="dest route small" title="${esc(p.dir)}">${p.moved ? `<span class="arrow">→</span> ${route(p.dir)}` : `<span class="muted">Stays in</span> ${route(p.dir)}${p.keptFolder ? ' <span class="muted">(you filed it here)</span>' : ''}`}
          <button class="link small changefolder" data-act="choosefolder" data-from="${esc(p.from)}" title="Pick a different folder - I'll remember it for similar files">Change folder…</button></div>
        ${p.warning ? `<div class="small" style="color:var(--warn);margin-top:4px">⚠ ${esc(p.warning)}</div>` : ''}
        <div class="small muted" style="margin-top:3px">${esc((p.reasons || []).slice(0, 2).join(' · '))}</div>
        ${p.preview ? `<details class="small"><summary class="muted">What I read</summary><div class="readbox">${esc(p.preview)}…</div></details>` : ''}</td>
      <td><button class="link" data-act="open" data-path="${esc(p.from)}">Open</button></td></tr>`).join('');
    const dupeCards = dupeCardsHtml(dupes);
    const nChange = dupeChangeCount(dupes);
    page.innerHTML = `<h1>Smart review</h1>
      <p class="sub">I read every file in the folders below and suggest <b>what it is</b> (type, company, date), <b>a clear name that starts with its date</b> — e.g. <b>2026-11-03 Acme Plumbing Invoice INV-1042.pdf</b> — and <b>where it belongs</b>. I also find <b>duplicates</b>, even when they have different names or one is a Word file and the other a PDF, and ask what you'd like to do. Nothing changes until you approve it.</p>
      <div class="card"><h2>Folders to review</h2>
        <div class="chips">${(review.pool || []).map((f, i) => `<span class="chip" title="${esc(f)}">📁 ${esc(nm(f))}<button data-act="rvdel" data-i="${i}" title="Remove">×</button></span>`).join('') || '<span class="muted small">None — add a folder</span>'}</div>
        <button style="margin-top:8px" data-act="rvadd">+ Add folder</button>
        <label class="row small" style="margin-top:12px"><input type="checkbox" id="rvai" ${review.useAI ? 'checked' : ''} ${review.hasAiKey ? '' : 'disabled'}>
          <span><b>✨ Use AI to read each file</b> — better labels, titles and dates. ${review.hasAiKey ? 'Sends the start of each document’s text to Claude, and costs a little per file on your Anthropic account.' : 'Add an AI key in <a href="#settings">Settings → AI</a> to turn this on. Without it I use my built-in rules (works offline).'}</span></label></div>
      <div class="row" style="margin:6px 0 16px"><button class="primary" data-act="rvscan" ${scanning || !(review.pool || []).length ? 'disabled' : ''}>${scanning ? 'Reading your files…' : plan ? 'Review again' : 'Start review'}</button>
        ${scanning ? '<button data-act="evcancel">Stop</button>' : ''}<span id="scan-status" class="muted small"></span></div>
      ${review.done ? `<div class="card" style="border-color:var(--good)"><b>Done — ${review.done.moves.length} file(s) renamed or moved${review.done.errors.length ? `, ${review.done.errors.length} couldn't be` : ''}.</b> <button class="link" data-act="rvundo" data-id="${esc(review.done.id)}">Undo</button></div>` : ''}
      ${review.dupeDone ? `<div class="card" style="border-color:var(--good)"><b>Duplicates: ${review.dupeDone.archived} archived${review.dupeDone.binned ? `, ${review.dupeDone.binned} moved to the Recycle Bin` : ''}${review.dupeDone.failed.length ? `, ${review.dupeDone.failed.length} couldn't be` : ''}.</b>
        ${review.dupeDone.archived ? `<span class="muted small">Archived files are in <button class="link" data-act="reveal" data-path="${esc(review.dupeDone.archiveDir)}">Organised › Archive › Duplicates</button>.</span> <button class="link" data-act="rvundo" data-id="${esc(review.dupeDone.batchId)}">Undo archive</button>` : ''}</div>` : ''}
      ${!plan ? '' : `
      <p class="muted small">Read ${plan.scanned} file(s)${plan.stopped ? ' (stopped early)' : ''} · ${plan.fine} already well named and in the right place.</p>
      ${(() => { const cloud = (plan.skipped || []).filter((k) => k.cloud).length; return cloud ? `<p class="muted small">☁ ${cloud} file(s) are stored in OneDrive online only, so I didn't open them (that would download them all to this PC). To include one, right-click it in File Explorer → <b>Always keep on this device</b>, then review again.</p>` : ''; })()}
      ${(plan.skipped || []).filter((k) => !k.cloud).length ? `<details class="card small"><summary><b>${plan.skipped.filter((k) => !k.cloud).length} file(s) skipped</b> <span class="muted">— they took too long to read or couldn't be opened, so they were left exactly as they are</span></summary>
        <ul class="list">${plan.skipped.filter((k) => !k.cloud).slice(0, 200).map((k) => `<li><div class="grow"><b class="fname">${esc(k.name)}</b><div class="route small">${route(k.path.split(/[\\/]/).slice(0, -1).join(k.path.includes('\\') ? '\\' : '/'))}</div></div><button class="link" data-act="open" data-path="${esc(k.path)}">Open</button></li>`).join('')}</ul></details>` : ''}
      <div class="tabs">${tabBtn('labels', `Labels &amp; names (${plan.plan.length})`)}${tabBtn('dupes', `Duplicates (${dupes.length} set${dupes.length === 1 ? '' : 's'})`)}</div>
      ${review.tab === 'labels' ? `<div class="card"><div class="row wrap"><span class="small muted">Show</span>
          <select id="rvonly"><option value="all" ${review.only === 'all' ? 'selected' : ''}>Everything</option><option value="renames" ${review.only === 'renames' ? 'selected' : ''}>Only renames</option><option value="moves" ${review.only === 'moves' ? 'selected' : ''}>Only moves</option></select>
          <span class="spacer"></span><button class="link" data-act="rvselall">Select all</button><button class="link" data-act="selsure">Only sure ones</button><button class="link" data-act="selnone">Clear</button>
          <button class="primary" data-act="apply" ${selected.size ? '' : 'disabled'}>Apply ${selected.size} selected</button></div>
        ${items.length ? `<table class="plantable"><colgroup><col style="width:34px"><col><col style="width:58px"></colgroup>${rvRows}</table>${items.length > 500 ? `<p class="muted small">Showing the first 500 of ${items.length}. Apply these, then review again for the rest.</p>` : ''}` : '<div class="empty">Nothing to change here — everything is well named and filed. 🎉</div>'}</div>`
      : `${dupes.length ? `<div class="card"><div class="row wrap"><div class="grow small muted"><b>Archive</b> moves that file into Organised › Archive › Duplicates — out of the way, but not deleted (and you can undo it). <b>Recycle Bin</b> can be restored from the bin. I've picked a suggestion for each set — change any you like.</div>
          <button class="primary" data-act="dupeapply" ${nChange ? '' : 'disabled'}>Apply ${nChange} change${nChange === 1 ? '' : 's'}</button></div></div>${dupeCards}` : '<div class="card"><div class="empty">No duplicates found. 🎉</div></div>'}`}`}`;
    const ai = $('#rvai'); if (ai) ai.addEventListener('change', () => { review.useAI = ai.checked; saveSettings({ reviewUseAI: ai.checked }); });
    const only = $('#rvonly'); if (only) only.addEventListener('change', () => { review.only = only.value; render(); });
  },

  // "Tidy Desktop": the Organise page, opened at the folder choices and desktop-icon tidy-up.
  async desktop() {
    await pages.organise();
    const c = $('#foldercard');
    if (c) { c.scrollIntoView({ block: 'start' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1400); }
  },

  async folders() {
    await folderShell(async (main) => {
      main.innerHTML = `<h1>Folders</h1><p class="sub">Browse everything on the left, or type in <b>Find a folder or file</b> to search through every folder and sub-folder at once.</p>
        <div class="dirgrid">${treeRoots.map((r) => `<div class="d" data-act="gofolder" data-path="${esc(r.path)}"><span style="font-size:22px">${r.icon || '📁'}</span><div style="min-width:0"><div class="ellipsis"><b>${esc(r.name)}</b></div><div class="small muted ellipsis">${esc(short(r.path))}</div></div></div>`).join('')}</div>`;
    });
  },

  async folder() {
    await folderShell((main) => renderFolderMain(main));
  },
};

async function renderFolderMain(main) {
  {
    const page = main; // the right-hand side of the Folders page
    const dir = currentFolder;
    if (folderSelDir !== dir) { folderSel = new Set(); folderSelDir = dir; }
    let data;
    try { data = await bridge.call('folder:list', dir); }
    catch { page.innerHTML = `<h1>Folder not found</h1><p class="sub">${esc(dir)} no longer exists — it may have been moved or renamed.</p>`; return; }
    const sep = dir.includes('\\') ? '\\' : '/';
    const root = treeRoots.filter((r) => dir === r.path || dir.startsWith(r.path + sep)).sort((a, b) => b.path.length - a.path.length)[0];
    const crumbs = [];
    if (root) {
      crumbs.push({ name: root.name, path: root.path });
      let acc = root.path;
      for (const part of dir.slice(root.path.length).split(sep).filter(Boolean)) { acc += sep + part; crumbs.push({ name: part, path: acc }); }
    } else crumbs.push({ name: dir, path: dir });
    const q = folderFilter.toLowerCase();
    const files = data.files.filter((f) => !q || f.name.toLowerCase().includes(q));
    const dirs = data.dirs.filter((d) => !q || d.name.toLowerCase().includes(q));
    page.innerHTML = `
      <div class="crumbs">${crumbs.map((c, i) => `${i ? '<span>›</span>' : ''}<button data-act="gofolder" data-path="${esc(c.path)}">${esc(c.name)}</button>`).join('')}</div>
      <h1 class="foldertitle">${esc(crumbs[crumbs.length - 1].name)}</h1>
      <div class="row foldertools"><input id="ffilter" placeholder="Filter this folder…" value="${esc(folderFilter)}">
        ${folderFilter ? '<button class="link" data-act="clearffilter">Show all</button>' : ''}<span class="spacer"></span>
        <button class="primary" data-act="rulemove" id="movesel" hidden>Move / Rule…</button>
        <button data-act="open" data-path="${esc(dir)}">Open in File Explorer</button></div>
      ${dirs.length ? `<div class="dirgrid" style="margin-bottom:18px">${dirs.map((d) => `<div class="d" data-act="gofolder" data-path="${esc(d.path)}"><span style="font-size:20px">📁</span><div style="min-width:0"><div class="ellipsis"><b>${esc(d.name)}</b></div><div class="small muted">${d.count} item${d.count === 1 ? '' : 's'}</div></div></div>`).join('')}</div>` : ''}
      <div class="card">${files.length ? `<table class="filetable"><tr><th class="fcheck"><input type="checkbox" id="fselall" title="Select all"></th><th class="ficn"></th><th>Name</th><th></th></tr>${files.map((f) => `<tr class="f" data-dbl="${esc(f.path)}">
          <td class="fcheck"><input type="checkbox" data-fsel="${esc(f.path)}" ${folderSel.has(f.path) ? 'checked' : ''}></td><td class="ficn">${fileIcon(f.ext)}</td>
          <td class="fnamecell"><div class="fname">${esc(f.name)}</div><div class="small muted">${fmtDay(f.mtime)} · ${fmtSize(f.size)}</div>
            <div class="rowactions"><button class="link" data-act="open" data-path="${esc(f.path)}">Open</button>${f.ext === '.pdf' ? `<button class="link" data-act="pdfedit" data-path="${esc(f.path)}">Edit</button>` : ''}<button class="link" data-act="reveal" data-path="${esc(f.path)}">Show</button><button class="link" data-act="rulemove" data-path="${esc(f.path)}">Move…</button></div></td>
          <td class="factions"><button class="link" data-act="open" data-path="${esc(f.path)}">Open</button>${f.ext === '.pdf' ? `<button class="link" data-act="pdfedit" data-path="${esc(f.path)}">Edit</button>` : ''}<button class="link" data-act="reveal" data-path="${esc(f.path)}" title="Show in File Explorer">Show</button><button class="link" data-act="rulemove" data-path="${esc(f.path)}" title="Move this file and optionally make a rule for files like it">Move…</button></td></tr>`).join('')}</table>`
        : `<div class="empty">${q ? 'Nothing matches that filter.' : dirs.length ? 'No loose files here — open one of the folders above.' : 'This folder is empty.'}</div>`}</div>`;
    const showMoveSel = () => { const b = $('#movesel'); if (b) { b.hidden = !folderSel.size; b.textContent = `Move / Rule… (${folderSel.size})`; } };
    showMoveSel();
    main.querySelectorAll('[data-fsel]').forEach((c) => c.addEventListener('change', () => { c.checked ? folderSel.add(c.dataset.fsel) : folderSel.delete(c.dataset.fsel); showMoveSel(); }));
    $('#fselall')?.addEventListener('change', (e) => { main.querySelectorAll('[data-fsel]').forEach((c) => { c.checked = e.target.checked; e.target.checked ? folderSel.add(c.dataset.fsel) : folderSel.delete(c.dataset.fsel); }); showMoveSel(); });
    const fl = $('#ffilter');
    fl.addEventListener('input', () => { folderFilter = fl.value; const pos = fl.selectionStart; renderFolderMain($('#fmain')).then(() => { const n = $('#ffilter'); n.focus(); n.setSelectionRange(pos, pos); }); });
  }
}

Object.assign(pages, {

  // Find a file: one box (name, words inside, old names) + filters for type, year and kind of file.
  async search() {
    const st0 = await bridge.call('index:status').catch(() => ({ size: 0 }));
    page.innerHTML = `<h1>Find a file</h1>
      <p class="sub">Type any part of a file's name, words inside it, a company, or a name it used to have. Narrow it down by type, year or kind of file. Searching ${st0.size.toLocaleString()} files${st0.busy ? ' (still reading new ones…)' : ''}. Tip: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> searches from anywhere.</p>
      <input id="sq" class="bigsearch" placeholder="e.g. westin drawing, payslip march, acme invoice" value="${esc(finder.q)}" autocomplete="off">
      <div id="sfilters" class="sfilters"></div>
      <div id="sres" class="card" style="margin-top:12px"></div>
      <div class="row small muted" style="margin-top:8px"><span class="grow">Can't find something you just saved? </span><button class="link small" data-act="reindex">Re-scan my folders</button></div>`;
    const run = async () => {
      const r = await bridge.call('search:find', { q: finder.q, type: finder.type, year: finder.year, kind: finder.kind, limit: 200 });
      const chipRow = (label, key, counts, order) => {
        const entries = Object.entries(counts).sort(order);
        if (!entries.length) return '';
        return `<div class="frow"><span class="flabel">${label}</span>${finder[key] ? `<button class="fchip on" data-act="ffilter" data-k="${key}" data-v="">${esc(finder[key])} ✕</button>` : entries.slice(0, 24).map(([v, n]) => `<button class="fchip" data-act="ffilter" data-k="${key}" data-v="${esc(v)}">${esc(v)} <span class="muted">${n}</span></button>`).join('')}</div>`;
      };
      $('#sfilters').innerHTML = chipRow('Type', 'type', r.facets.type, (a, b) => b[1] - a[1])
        + chipRow('Year', 'year', r.facets.year, (a, b) => b[0].localeCompare(a[0]))
        + chipRow('Kind', 'kind', r.facets.kind, (a, b) => b[1] - a[1]);
      const any = finder.q.trim() || finder.type || finder.year || finder.kind;
      const head = `<div class="row small muted" style="margin-bottom:6px"><span class="grow">${any ? `${r.total.toLocaleString()} match${r.total === 1 ? '' : 'es'}${r.total > r.results.length ? ` — showing the best ${r.results.length}` : ''}` : 'Newest files'}</span>${any ? '<button class="link small" data-act="fclear">Clear search</button>' : ''}</div>`;
      $('#sres').innerHTML = head + (r.results.length ? `<ul class="list">${r.results.map((x) => `<li><div class="grow" data-dbl="${esc(x.path)}" title="Double-click to open">
          <b class="fname">${esc(x.name)}</b>${x.formerNames.length ? `<div class="small muted">used to be called ${esc(x.formerNames[x.formerNames.length - 1])}</div>` : ''}
          <div style="margin:3px 0"><span class="pill">${esc(x.type)}</span> <span class="pill">${esc(x.year)}</span> <span class="pill">${esc(x.kind)}</span>${x.company ? ` <span class="pill">${esc(x.company)}</span>` : ''} <span class="small muted">${fmtSize(x.size)}</span></div>
          <div class="route small">${route(x.dir)}</div>${x.snippet ? `<div class="small muted">…${esc(x.snippet)}…</div>` : ''}</div>
          <button class="link" data-act="open" data-path="${esc(x.path)}">Open</button>${/\.pdf$/i.test(x.name) ? `<button class="link" data-act="pdfedit" data-path="${esc(x.path)}">Edit PDF</button>` : ''}<button class="link" data-act="reveal" data-path="${esc(x.path)}">Show in folder</button></li>`).join('')}</ul>` : `<div class="empty">No matches.${finder.type || finder.year || finder.kind ? ' Try removing a filter.' : ''} If you moved or renamed it, try its old name, or check <a href="#restore">Where are my files?</a></div>`);
    };
    pages._findRun = run;
    let timer;
    $('#sq').addEventListener('input', (e) => { finder.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => safe(run), 150); });
    await run();
    const q = $('#sq'); q.focus(); q.setSelectionRange(q.value.length, q.value.length);
  },

  // Sort by type: every file into Organised › Type › Year (e.g. Invoices › 2026), with a preview first. Finds copies too.
  async sortall() {
    const last = await bridge.call('organise:last');
    plan = last && last.mode === 'sortall' ? last : null;
    if (!sorter.pool) { sorter.pool = await bridge.call('sortall:pool'); const r = await bridge.call('review:pool'); sorter.hasAiKey = r.hasAiKey; }
    const nm = (f) => f.split(/[\\/]/).filter(Boolean).pop() || f;
    const layoutOk = (settings.filingLayout || 'typeYear') === 'typeYear';
    const names = settings.nameStyle || 'full';
    const groups = {};
    for (const p of plan?.plan || []) {
      const segs = p.dir.startsWith(settings.organisedRoot) ? p.dir.slice(settings.organisedRoot.length).split(/[\\/]/).filter(Boolean) : [p.dir];
      const key = segs.slice(0, -1).join(' › ') || segs.join(' › ');
      (groups[key] = groups[key] || []).push(p);
    }
    const order = Object.keys(groups).sort((a, b) => a.localeCompare(b));
    const dupes = plan?.dupes || [];
    const nChange = dupeChangeCount(dupes);
    page.innerHTML = `<h1>Sort by type</h1>
      <p class="sub">Puts every file into <b>Organised › Type › Year</b> — e.g. <b>Invoices › 2026</b>, <b>Drawings › 2026</b>, <b>Payroll › 2026</b>, <b>Pictures › 2024</b> — including files already in Organised from earlier layouts. Program folders (Payroll's own Riyser folder, Outlook, accounting files…) are left alone. You see everything before it moves, and it can all be undone in <a href="#restore">Where are my files?</a></p>
      <div class="card"><h2>Folders to sort</h2>
        <div class="chips">${(sorter.pool || []).map((f, i) => `<span class="chip" title="${esc(f)}">📁 ${esc(nm(f))}<button data-act="sadel" data-i="${i}" title="Remove">×</button></span>`).join('') || '<span class="muted small">None — add a folder</span>'}</div>
        <button style="margin-top:8px" data-act="saadd">+ Add folder</button>
        <div class="row small wrap" style="margin-top:12px"><b>File names</b>
          <select id="sanames"><option value="keep" ${names === 'keep' ? 'selected' : ''}>Keep the names as they are</option><option value="date" ${names === 'date' ? 'selected' : ''}>Add the date in front</option><option value="full" ${names === 'full' ? 'selected' : ''}>Full tidy name (date, company, type)</option></select>
          <button class="link small" data-act="namesback">Change names back to the originals…</button></div>
        <label class="row small" style="margin-top:8px"><input type="checkbox" id="saai" ${sorter.useAI ? 'checked' : ''} ${sorter.hasAiKey ? '' : 'disabled'}>
          <span><b>✨ Use AI to read each file</b> — better types and dates, and checks for copies. ${sorter.hasAiKey ? 'Sends the start of each document’s text to Claude (small cost per file).' : 'Needs an AI key in <a href="#settings">Settings → AI</a>; without it the built-in rules are used (offline). Copies are found either way.'}</span></label></div>
      <div class="row" style="margin:6px 0 16px"><button class="primary" data-act="sascan" ${scanning || !(sorter.pool || []).length ? 'disabled' : ''}>${scanning ? 'Reading your files…' : plan ? 'Look again' : 'Show me the plan'}</button>
        ${scanning ? '<button data-act="evcancel">Stop</button>' : ''}<span id="scan-status" class="muted small"></span></div>
      ${sorter.done ? `<div class="card" style="border-color:var(--good)"><b>Sorted ${sorter.done.moves.length} file(s)${sorter.done.errors.length ? `, ${sorter.done.errors.length} couldn't be moved` : ''}.</b> <button class="link" data-act="saundo" data-id="${esc(sorter.done.id)}">Undo</button> · <a href="#search">Find a file →</a></div>` : ''}
      ${review.dupeDone && plan ? `<div class="card" style="border-color:var(--good)"><b>Copies: ${review.dupeDone.archived} archived${review.dupeDone.binned ? `, ${review.dupeDone.binned} to the Recycle Bin` : ''}.</b> ${review.dupeDone.batchId ? `<button class="link" data-act="rvundo" data-id="${esc(review.dupeDone.batchId)}">Undo archive</button>` : ''}</div>` : ''}
      ${!plan ? '' : `
      <p class="muted small">Read ${plan.scanned} file(s) · ${plan.fine} already in the right place${(plan.kept || []).length ? ` · ${plan.kept.length} program folder(s)/file(s) left alone` : ''}${(plan.skipped || []).length ? ` · ${plan.skipped.length} skipped (online-only or unreadable)` : ''}.</p>
      <div class="tabs"><button class="${sorter.tab === 'files' ? 'active' : ''}" data-act="satab" data-t="files">Files to sort (${plan.plan.length})</button><button class="${sorter.tab === 'dupes' ? 'active' : ''}" data-act="satab" data-t="dupes">Copies of the same file (${dupes.length} set${dupes.length === 1 ? '' : 's'})</button></div>
      ${sorter.tab === 'files' ? `<div class="card"><div class="row wrap"><h2 style="margin:0" class="grow">Where everything will go</h2>
          <button class="link" data-act="selall">Select all</button><button class="link" data-act="selnone">Clear</button>
          <button class="primary" data-act="apply" ${selected.size ? '' : 'disabled'}>Move ${selected.size} selected</button></div>
        ${order.length ? order.map((g) => `<details class="evgroup"><summary><b>${esc(g)}</b> <span class="muted">— ${groups[g].length} file(s)</span></summary>
          <ul class="list">${groups[g].slice(0, 400).map((p) => `<li><input type="checkbox" data-sel="${esc(p.from)}" ${selected.has(p.from) ? 'checked' : ''}><div class="grow"><b class="fname">${esc(p.name)}</b>${p.newName ? `<div class="small">→ ${esc(p.newName)}</div>` : ''}
            <div class="route small"><span class="muted">from</span> ${route(p.from.split(/[\\/]/).slice(0, -1).join(p.from.includes('\\') ? '\\' : '/'))}</div></div>
            <select class="typesel" data-settype="${esc(p.from)}" title="Wrong type? Pick the right one">${docTypes.map((t) => `<option ${t === p.docType ? 'selected' : ''}>${esc(t)}</option>`).join('')}<option value="Other" ${!p.docType || p.docType === 'Other' ? 'selected' : ''}>Not sure (file by kind)</option></select>
            <button class="link" data-act="open" data-path="${esc(p.from)}">Open</button></li>`).join('')}</ul>${groups[g].length > 400 ? `<p class="muted small">…and ${groups[g].length - 400} more (included).</p>` : ''}</details>`).join('') : '<div class="empty">Everything is already sorted by type. 🎉</div>'}</div>`
      : `${dupes.length ? `<div class="card"><div class="row wrap"><div class="grow small muted">Copies of the same file, even with different names or as Word + PDF. <b>Archive</b> moves a copy to Organised › Archive › Duplicates (not deleted, can be undone). I've picked a suggestion for each set.</div>
          <button class="primary" data-act="dupeapply" ${nChange ? '' : 'disabled'}>Apply ${nChange} change${nChange === 1 ? '' : 's'}</button></div></div>${dupeCardsHtml(dupes)}` : '<div class="card"><div class="empty">No copies found. 🎉</div></div>'}`}`}`;
    if (!docTypes.length) docTypes = await bridge.call('review:types').catch(() => []);
    $('#sanames')?.addEventListener('change', async (e) => { await saveSettings({ nameStyle: e.target.value, renameFiles: e.target.value !== 'keep' }); toast('Saved — press “Look again” to update the plan'); });
    $('#saai')?.addEventListener('change', (e) => { sorter.useAI = e.target.checked; });
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
    const learned = await bridge.call('learn:list').catch(() => []);
    const myRules = await bridge.call('rules:list').catch(() => []);
    const sections = [['s-sorting', '🗂 Sorting'], ['s-rules', '📐 Rules'], ['s-learned', '🧠 Learned'], ['s-appearance', '🎨 Appearance'], ['s-calendars', '📅 Calendars'], ['s-email', '✉ Email'], ['s-pdf', '📕 PDF'], ['s-ai', '✨ AI'], ['s-general', '⚙ General'], ['s-uninstall', '🗑 Uninstall']];
    page.innerHTML = `<h1>Settings</h1><p class="sub">Everything stays on this computer. Passwords and keys are encrypted with your system keychain.</p>
      <div class="settingsnav">${sections.map(([id, label]) => `<button data-act="jump" data-id="${id}">${label}</button>`).join('')}</div>
      <div class="grid">
      <div class="card" id="s-sorting"><h2>Folders to tidy</h2><p class="muted small">Where new files land: Downloads, Desktop, and your phone's synced folder (e.g. OneDrive / Google Drive / iCloud “Camera Roll” or “Scans”).</p>${folderList('watchFolders')}
        <label class="row small" style="margin-top:10px"><input type="checkbox" id="recursive" ${s.recursiveScan ? 'checked' : ''}> Tick new sub-folders automatically (you can untick them on the Organise page)</label>
        <div class="row small wrap" style="margin:4px 0"><b>Folder layout</b>
          <select id="layout"><option value="typeYear" ${(s.filingLayout || 'typeYear') === 'typeYear' ? 'selected' : ''}>Type › Year — Invoices › 2026, Drawings › 2026</option>
            <option value="company" ${s.filingLayout === 'company' ? 'selected' : ''}>Company › Type — Clients › Acme Plumbing › Invoices</option></select></div>
        <div class="row small wrap" style="margin:4px 0"><b>File names</b>
          <select id="namestyle"><option value="full" ${(s.nameStyle || 'full') === 'full' ? 'selected' : ''}>Full tidy name — 2026-11-03 Acme Plumbing Invoice INV-1042.pdf</option>
            <option value="date" ${s.nameStyle === 'date' ? 'selected' : ''}>Add the date in front — 2026-11-03 scan0042.pdf</option>
            <option value="keep" ${s.nameStyle === 'keep' ? 'selected' : ''}>Keep my names</option></select></div>
        ${s.filingLayout === 'company' ? `<label class="row small"><input type="checkbox" id="byyear" ${s.groupByYear ? 'checked' : ''}> Put files in a folder for each year (…/Invoices/2026/)</label>` : ''}
        ${s.filingLayout === 'company' ? `<label class="row small"><input type="checkbox" id="sortall" ${s.sortEverything !== false ? 'checked' : ''}> File everything — things I can't identify go into Organised\\Other (by type) instead of being left behind</label>` : ''}
        <label class="row small"><input type="checkbox" id="ocrpdf" ${s.ocrPdfs !== false ? 'checked' : ''}> Read scanned PDFs with text recognition (OCR) — a few seconds per document, done once</label>
        <label class="row small"><input type="checkbox" id="ocrimg" ${s.ocrImages ? 'checked' : ''}> Also read photos and screenshots (finds receipts you've photographed; slower)</label>
        ${s.filingLayout === 'company' ? `<label class="row small"><input type="checkbox" id="related" ${s.groupRelated !== false ? 'checked' : ''}> Keep related documents together (e.g. the quote, invoice and receipt for one job go in …/Projects/12 Smith Street/)</label>` : ''}
        <label class="row small">Dates like 03/04/2026 mean <select id="datefmt"><option value="1" ${s.dayFirstDates ? 'selected' : ''}>3 April (NZ/AU/UK)</option><option value="0" ${s.dayFirstDates ? '' : 'selected'}>March 4 (US)</option></select></label>
        <label class="row small"><input type="checkbox" id="auto" ${s.autoOrganise ? 'checked' : ''}> Tidy automatically every hour (only files I'm sure about)</label></div>
      <div class="card"><h2>Organised folder</h2><p class="muted small">Where sorted files go.</p><div class="path">${esc(s.organisedRoot)}</div><button style="margin-top:8px" data-act="setroot">Change…</button>
        <h2 style="margin-top:18px">Folders to search</h2>${folderList('searchFolders')}</div>
      <div class="card" id="s-calendars"><h2>Calendars</h2><p class="muted small">Paste your calendar's secret iCal address — Google Calendar: Settings → your calendar → “Secret address in iCal format”. Outlook: Settings → Calendar → Shared calendars → Publish → ICS link. Or import an .ics file.</p>
        <ul class="list">${s.calendars.map((c, i) => `<li><div class="grow"><b>${esc(c.name)}</b><div class="path ellipsis">${esc(c.url ? c.url.replace(/(private-|secret)[^/]*/i, '$1…') : short(c.path))}</div></div><button class="link" data-act="delcal" data-i="${i}">Remove</button></li>`).join('')}</ul>
        <form id="addcal" class="row"><input id="calname" placeholder="Name" style="width:110px"><input id="calurl" placeholder="https://… .ics" style="flex:1"><button>Add</button></form>
        <button class="link" style="margin-top:6px" data-act="addics">or import an .ics file…</button>
        <div class="field" style="margin-top:12px"><label>Remind me before meetings (minutes)</label><input id="remind" type="number" min="1" max="120" value="${s.reminderMinutes}" style="width:90px"></div></div>
      <div class="card" id="s-email"><h2>Email (optional)</h2><p class="muted small">Any IMAP mailbox. For Gmail/Outlook/iCloud create an “app password” in your account security settings and use it here. Gmail: imap.gmail.com · Outlook: outlook.office365.com · iCloud: imap.mail.me.com</p>
        <form id="emailform">
          <div class="row"><input id="ehost" placeholder="IMAP server" value="${esc(s.email.host)}" style="flex:1"><input id="eport" type="number" value="${esc(s.email.port)}" style="width:80px"></div>
          <div class="row" style="margin-top:8px"><input id="euser" placeholder="Email address" value="${esc(s.email.user)}" style="flex:1"></div>
          <div class="row" style="margin-top:8px"><input id="epass" type="password" placeholder="${s.hasEmailPassword ? 'Password saved (type to change)' : 'App password'}" style="flex:1"></div>
          <label class="row small" style="margin-top:8px"><input type="checkbox" id="eatt" ${s.email.saveAttachments ? 'checked' : ''}> Save invoice & receipt attachments into company folders</label>
          <label class="row small"><input type="checkbox" id="eauto" ${s.email.autoCheck ? 'checked' : ''}> Check automatically every 20 minutes</label>
          <button class="primary" style="margin-top:8px">Save email settings</button></form></div>
      <div class="card" id="s-pdf"><h2>PDF editor</h2><p class="muted small">Open, edit, fill in and sign PDFs. Every save keeps a backup of the previous version.</p>
        <div class="row"><button data-act="go" data-page="pdf">Open the PDF editor</button>${platform === 'win32' ? '<button data-act="pdfdefault">Set as my PDF app</button>' : ''}<button data-act="pdfbackups">Open PDF backups folder</button></div></div>
      <div class="card" id="s-ai"><h2>Smarter sorting with AI (optional)</h2><p class="muted small">Add an Anthropic API key and files I'm unsure about are sent to Claude to identify (first ~4,000 characters of text only). Leave blank to keep everything 100% offline.</p>
        <label class="row small" style="margin-bottom:8px"><input type="checkbox" id="aiall" ${s.aiCheckAll ? 'checked' : ''} ${s.hasAiKey ? '' : 'disabled'}> Double-check <b>every</b> document with AI, not just the ones I'm unsure about (slower; uses your API credit)</label>
        <form id="aiform" class="row"><input id="aikey" type="password" style="flex:1" placeholder="${s.hasAiKey ? 'Key saved (type to replace)' : 'sk-ant-…'}"><button>Save</button>${s.hasAiKey ? '<button type="button" data-act="clearai">Remove key</button>' : ''}</form></div>
      <div class="card" id="s-appearance"><h2>Appearance</h2>
        <div class="row">${['system', 'light', 'dark'].map((t) => `<label class="themeopt ${(s.theme || 'system') === t ? 'on' : ''}"><input type="radio" name="theme" value="${t}" ${(s.theme || 'system') === t ? 'checked' : ''}><span class="swatch ${t}"></span>${t === 'system' ? 'Same as Windows' : t === 'light' ? 'Light' : 'Dark'}</label>`).join('')}</div>
        <p class="muted small">Applies to the PDF editor too.</p></div>
      <div class="card" id="s-rules"><h2>Filing rules</h2><p class="muted small">Your rules always win. Make one from the <b>Folders</b> page (tick files → <b>Move / Rule…</b>) or with <b>Change folder…</b> when organising.</p>
        ${myRules.length ? `<ul class="list">${myRules.map((r) => `<li><div class="grow"><div><b>${esc(r.name)}</b> ${r.enabled === false ? '<span class="pill warn">off</span>' : ''}</div>
          <div class="small muted">${[r.conditions.docType && `type ${esc(r.conditions.docType)}`, r.conditions.company && `from ${esc(r.conditions.company)}`, r.conditions.words?.length && `contains “${esc(r.conditions.words.join(' '))}”`, r.conditions.kind && `${esc(r.conditions.kind)} files`].filter(Boolean).join(' · ')}</div>
          <div class="small">→ ${esc(r.where)}</div></div>
          <div class="row" style="flex-wrap:nowrap"><button class="link small" data-act="ruleapply" data-id="${esc(r.id)}">Apply now</button><button class="link small" data-act="ruletoggle" data-id="${esc(r.id)}">${r.enabled === false ? 'Turn on' : 'Turn off'}</button><button class="link small" data-act="ruledelete" data-id="${esc(r.id)}">Delete</button></div></li>`).join('')}</ul>` : '<div class="empty small">No rules yet.</div>'}</div>
      <div class="card" id="s-learned"><h2>What I've learned</h2><p class="muted small">Folders you chose for files with <b>Change folder…</b>. Similar files go to the same place automatically. I also follow how you've arranged your Organised folder yourself.</p>
        ${learned.length ? `<ul class="list">${learned.slice(0, 60).map((l, i) => `<li><div class="grow"><div class="small">${l.docType && l.docType !== 'Other' ? `<b>${esc(l.docType)}</b> ` : ''}${l.company ? `from <b>${esc(l.company)}</b> ` : ''}${l.words.length ? `like “${esc(l.words.join(' '))}”` : ''}</div>
          <div class="route small">→ ${l.inRoot ? `<span class="seg">Organised</span><span class="sep">›</span>` : ''}${l.template.split('/').map((x) => `<span class="seg">${esc(x === '{year}' ? '(year)' : x)}</span>`).join('<span class="sep">›</span>')}</div></div>
          <button class="link small" data-act="forgetlearned" data-i="${i}">Forget</button></li>`).join('')}</ul>` : '<div class="empty small">Nothing yet — use “Change folder…” on the Organise or Tidy everything pages.</div>'}</div>
      <div class="card" id="s-general"><h2>General</h2><label class="row"><input type="checkbox" id="login" ${s.openAtLogin ? 'checked' : ''}> Start when I log in (runs quietly in the tray)</label>
        <p class="small muted" style="margin-top:12px">Desk Assistant <b>${esc(appVersion)}</b> · Quick search from anywhere: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd></p></div>
      <div class="card" id="s-uninstall"><h2>Uninstall</h2><p class="muted small">Removes Desk Assistant and its settings from this PC. Your own files — including everything in your Organised folder — are kept. You can also uninstall from Windows <b>Settings → Apps → Installed apps</b>.</p>
        <button data-act="uninstall">Uninstall Desk Assistant…</button></div>
      </div>`;
    const bindCheck = (id, fn) => $(id).addEventListener('change', async (e) => { await saveSettings(fn(e.target.checked)); toast('Saved'); });
    bindCheck('#recursive', (v) => ({ recursiveScan: v }));
    if ($('#byyear')) bindCheck('#byyear', (v) => ({ groupByYear: v }));
    $('#layout')?.addEventListener('change', async (e) => { await saveSettings({ filingLayout: e.target.value }); toast('Folder layout saved'); render(); });
    $('#namestyle')?.addEventListener('change', async (e) => { await saveSettings({ nameStyle: e.target.value, renameFiles: e.target.value !== 'keep' }); toast('File names setting saved'); });
    if ($('#related')) bindCheck('#related', (v) => ({ groupRelated: v }));
    bindCheck('#ocrpdf', (v) => ({ ocrPdfs: v }));
    if ($('#sortall')) bindCheck('#sortall', (v) => ({ sortEverything: v }));
    bindCheck('#aiall', (v) => ({ aiCheckAll: v }));
    bindCheck('#ocrimg', (v) => ({ ocrImages: v }));
    $('#datefmt').addEventListener('change', async (e) => { await saveSettings({ dayFirstDates: e.target.value === '1' }); toast('Saved'); });
    bindCheck('#auto', (v) => ({ autoOrganise: v }));
    bindCheck('#login', (v) => ({ openAtLogin: v }));
    page.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', async () => { await saveSettings({ theme: r.value }); render(); }));
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
});

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
  open: async (el) => { const now = await bridge.call('file:open', el.dataset.path); if (now) movedNote(now); },
  reveal: async (el) => { const now = await bridge.call('file:reveal', el.dataset.path); if (now) movedNote(now); },
  reindex: async () => { toast('Re-scanning files in the background…'); await bridge.call('index:rebuild'); toast('Search index updated'); render(); },
  recheck: async (el) => {
    el.disabled = true; $('#scan-status').textContent = 'Re-checking filed items…';
    const p = await bridge.call('organise:recheck');
    selected = new Set(p.plan.filter((x) => !x.warning).map((x) => x.from));
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
  uninstall: () => bridge.call('app:uninstall'),
  jump: (el) => { const t = document.getElementById(el.dataset.id); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1200); } },
  arrangedesk: async (el) => {
    el.disabled = true; el.textContent = 'Arranging…';
    try { await bridge.call('desktop:arrange'); toast('Desktop icons lined up. (Right-click the desktop → View to change this any time.)'); }
    finally { el.disabled = false; el.textContent = 'Tidy desktop icons'; }
  },
  unarrangedesk: async () => { await bridge.call('desktop:undoArrange'); toast('Auto-arrange is off again — you can place icons wherever you like.'); },
  choosefolder: (el) => ruleDialog([el.dataset.from], 'plan'),
  rulemove: (el) => ruleDialog(el.dataset.path ? [el.dataset.path] : [...folderSel], 'files'),
  ruletoggle: async (el) => { await bridge.call('rules:toggle', el.dataset.id); render(); },
  ruledelete: async (el) => { if (await bridge.call('confirm', 'Delete this rule?', 'Files already moved stay where they are.')) { await bridge.call('rules:delete', el.dataset.id); render(); } },
  ruleapply: async (el) => { const r = (await bridge.call('rules:list')).find((x) => x.id === el.dataset.id); if (r) { await offerMatches(r); render(); } },
  forgetlearned: async (el) => { await bridge.call('learn:forget', +el.dataset.i); render(); },
  evadd: async (el) => {
    const f = await bridge.call('dialog:folder');
    const key = el.dataset.key;
    if (f && !(settings[key] || []).includes(f)) { await saveSettings({ [key]: [...(settings[key] || []), f] }); render(); }
  },
  evdel: async (el) => { const key = el.dataset.key; await saveSettings({ [key]: (settings[key] || []).filter((_, i) => i !== +el.dataset.i) }); render(); },
  evscan: async () => {
    scanning = true; everythingDone = null; render();
    try {
      const p = await bridge.call('everything:scan');
      selected = new Set(p.plan.filter((x) => !x.warning).map((x) => x.from));
      toast(`Looked through ${p.scanned} file(s).`);
    } finally { scanning = false; render(); }
  },
  evcancel: () => bridge.call('everything:cancel'),
  restoreall: async (el) => {
    if (!(await bridge.call('confirm', 'Put every file back where it was?', 'Every file Desk Assistant moved or renamed goes back to its original folder and name. Nothing is deleted. A list of where everything was is saved first.'))) return;
    el.disabled = true; el.textContent = 'Putting files back…';
    restoreDone = await bridge.call('restore:all');
    toast(`Put back ${restoreDone.restored} file(s).`);
    plan = null; render();
  },
  restorereport: async () => { const f = await bridge.call('restore:report'); toast(`Saved ${f.split(/[\\/]/).pop()}`); },
  ffilter: (el) => { finder[el.dataset.k] = el.dataset.v || null; safe(pages._findRun); },
  fclear: () => { finder = { q: '', type: null, year: null, kind: null }; render(); },
  saadd: async () => { const f = await bridge.call('dialog:folder'); if (f && !sorter.pool.includes(f)) { sorter.pool = await bridge.call('sortall:setPool', [...sorter.pool, f]); render(); } },
  sadel: async (el) => { sorter.pool = await bridge.call('sortall:setPool', sorter.pool.filter((_, i) => i !== +el.dataset.i)); render(); },
  satab: (el) => { sorter.tab = el.dataset.t; render(); },
  sascan: async () => {
    scanning = true; sorter.done = null; review.dupeDone = null; dupeChoice = new Map(); render();
    try {
      const p = await bridge.call('sortall:scan', { folders: sorter.pool, useAI: sorter.useAI });
      selected = new Set(p.plan.map((x) => x.from));
      toast(`Read ${p.scanned} file(s): ${p.plan.length} to sort, ${p.dupes.length} set(s) of copies.`);
    } finally { scanning = false; render(); }
  },
  saundo: async (el) => { const r = await bridge.call('organise:undo', el.dataset.id); toast(r.errors.length ? `Undone, but ${r.errors.length} file(s) couldn't be moved back` : 'Undone — files are back where they were'); sorter.done = null; render(); },
  namesback: async () => {
    const r = await bridge.call('restore:names', true);
    if (!r.items.length) { toast('No renamed files on record — names are already the originals.'); return; }
    const list = r.items.slice(0, 12).map((i) => `“${i.current}” → “${i.original}”`).join('\n');
    if (!(await bridge.call('confirm', `Change ${r.items.length} file name(s) back to the originals?`, `Files stay in the folder they're in now. For example:\n${list}${r.items.length > 12 ? `\n…and ${r.items.length - 12} more` : ''}\n\nYou can undo this on “Where are my files?”.`))) return;
    const done = await bridge.call('restore:names', false);
    toast(`Changed ${done.renamed} name(s) back${done.errors.length ? `, ${done.errors.length} couldn't be` : ''}.`);
    render();
  },
  rvtab: (el) => { review.tab = el.dataset.t; render(); },
  rvadd: async () => { const f = await bridge.call('dialog:folder'); if (f && !review.pool.includes(f)) { review.pool = await bridge.call('review:setPool', [...review.pool, f]); render(); } },
  rvdel: async (el) => { review.pool = await bridge.call('review:setPool', review.pool.filter((_, i) => i !== +el.dataset.i)); render(); },
  rvscan: async () => {
    scanning = true; review.done = null; review.dupeDone = null; dupeChoice = new Map(); render();
    try {
      const p = await bridge.call('review:scan', { folders: review.pool, useAI: review.useAI });
      selected = new Set(p.plan.filter((x) => !x.warning && x.confidence !== 'low').map((x) => x.from));
      toast(`Read ${p.scanned} file(s): ${p.plan.length} suggestion(s), ${p.dupes.length} duplicate set(s).`);
    } finally { scanning = false; render(); }
  },
  rvselall: () => { selected = new Set(plan.plan.map((p) => p.from)); render(); },
  rvundo: async (el) => { const r = await bridge.call('organise:undo', el.dataset.id); toast(r.errors.length ? `Undone, but ${r.errors.length} file(s) couldn't be moved back` : 'Undone — files are back where they were'); review.done = null; review.dupeDone = null; render(); },
  dupeall: (el) => { const g = plan.dupes[+el.dataset.g]; for (const f of g.files) dupeChoice.set(f.path, el.dataset.v === 'keep' ? 'keep' : f.recommend); render(); },
  dupeapply: async () => {
    const acts = plan.dupes.flatMap((g) => g.files.map((f) => ({ path: f.path, action: dupeChoice.get(f.path) || f.recommend }))).filter((a) => a.action !== 'keep');
    const bin = acts.filter((a) => a.action === 'bin').length;
    if (plan.dupes.some((g) => g.files.every((f) => (dupeChoice.get(f.path) || f.recommend) !== 'keep'))
      && !(await bridge.call('confirm', 'Some sets have no copy kept', 'In at least one set every copy will be archived or binned. Continue?'))) return;
    if (bin && !(await bridge.call('confirm', `Move ${bin} file(s) to the Recycle Bin?`, 'You can restore them from the Recycle Bin.'))) return;
    const r = await bridge.call('dupes:resolve', acts);
    review.dupeDone = r; dupeChoice = new Map();
    toast(`Archived ${r.archived}${r.binned ? `, binned ${r.binned}` : ''}.`);
    render();
  },

  gofolder: (el) => { folderFilter = ''; goToFolder(el.dataset.path); },
  clearffilter: () => { folderFilter = ''; renderFolderMain($('#fmain')); },
  fsearchclear: () => { const i = $('#fsearch'); i.value = ''; i.dispatchEvent(new Event('input')); i.focus(); },
  treehide: () => { $('#fsplit').classList.add('notree'); try { localStorage.setItem('da-tree-hidden', '1'); } catch { /* ignore */ } },
  treeshow: () => { $('#fsplit').classList.remove('notree'); try { localStorage.setItem('da-tree-hidden', '0'); } catch { /* ignore */ } },
  treecollapse: () => { expanded = new Set(); saveExpanded(); renderTree(); },
  treerefresh: () => renderTree(),
  pdfopen: async () => { const f = await bridge.call('pdf:openDialog', false); if (f) await bridge.call('pdf:edit', f); },
  convtopdf: async () => {
    const files = await bridge.call('files:pick', 'convert');
    if (!files || !files.length) return;
    const combine = files.length > 1 ? await bridge.call('confirm', `Combine the ${files.length} files into ONE PDF?`, 'Choose Cancel to make a separate PDF for each file.') : false;
    toast('Converting…');
    const r = await bridge.call('convert:toPdf', files, { combine });
    toast(`Created ${r.outputs.length} PDF(s)${r.usedOffice ? ' using Microsoft Office' : ''}.`);
    await bridge.call('pdf:edit', r.outputs[0]);
  },
  convtoword: async () => {
    const f = await bridge.call('pdf:openDialog', false);
    if (!f) return;
    toast('Converting to Word…');
    const r = await bridge.call('convert:pdfToWord', f);
    toast(`Created ${r.output.split(/[\\/]/).pop()}${r.usedOffice ? ' using Microsoft Word' : ''}.`);
    bridge.call('file:openPath', r.output);
  },
  pdfedit: (el) => bridge.call('pdf:edit', el.dataset.path),
  pdfdefault: async () => { const name = await bridge.call('pdf:makeDefault'); toast(`Windows Settings is opening: choose “${name}” for .pdf.`); },
  pdfbackups: () => bridge.call('pdf:backups'),
  cmbadd: async () => { const fs = await bridge.call('pdf:openDialog', true); if (fs) { combine = [...combine, ...fs]; render(); } },
  cmbrm: (el) => { combine.splice(+el.dataset.i, 1); render(); },
  cmbup: (el) => { const i = +el.dataset.i; if (i > 0) { [combine[i - 1], combine[i]] = [combine[i], combine[i - 1]]; render(); } },
  cmbgo: async () => { const out = await bridge.call('pdf:combine', combine); if (out) { toast(`Saved ${out}`); combine = []; await bridge.call('pdf:edit', out); render(); } },
  scan: async (el) => {
    el.disabled = true; $('#scan-status').textContent = 'Scanning…';
    const p = await bridge.call('organise:scan');
    selected = new Set(p.plan.filter((x) => !x.warning).map((x) => x.from));
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
    if (plan.mode === 'everything') { everythingDone = batch; plan = null; render(); return; }
    if (plan.mode === 'review') { review.done = batch; render(); return; }
    if (plan.mode === 'sortall') { sorter.done = batch; render(); return; }
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

document.addEventListener('dblclick', (e) => {
  const row = e.target.closest('[data-dbl]');
  if (row && !e.target.closest('button')) safe(async () => { const now = await bridge.call('file:open', row.dataset.dbl); if (now) movedNote(now); });
});
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
    if (btn) { btn.disabled = !selected.size; btn.textContent = `${plan?.mode === 'review' ? 'Apply' : 'Move'} ${selected.size} selected`; }
  }
  if (e.target.dataset.rename !== undefined && plan) {
    const item = plan.plan.find((p) => p.from === e.target.dataset.rename);
    const ext = item.name.includes('.') ? item.name.slice(item.name.lastIndexOf('.')) : '';
    let v = e.target.value.trim().replace(/[<>:"/\\|?*]/g, '-') || item.name;
    if (ext && !v.toLowerCase().endsWith(ext.toLowerCase())) v += ext;
    e.target.value = v;
    item.to = `${item.dir}${item.dir.includes('\\') ? '\\' : '/'}${v}`;
  }
  if (e.target.dataset.folder !== undefined) safe(() => bridge.call('organise:setFolder', e.target.dataset.folder, e.target.checked));
  if (e.target.dataset.foldermode !== undefined) safe(() => bridge.call('organise:setFolder', e.target.dataset.foldermode, e.target.value));
  if (e.target.dataset.csel !== undefined) {
    e.target.checked ? cleanSel.add(e.target.dataset.csel) : cleanSel.delete(e.target.dataset.csel);
    const btn = page.querySelector('[data-act="cleantrash"]');
    const size = cleanup.items.filter((i) => cleanSel.has(i.path)).reduce((n, i) => n + i.size, 0);
    if (btn) { btn.disabled = !cleanSel.size; btn.textContent = `Move ${cleanSel.size} to Recycle Bin (${fmtSize(size)})`; }
  }
  if (e.target.dataset.settype !== undefined && e.target.value) safe(async () => {
    const it = await bridge.call('review:setType', e.target.dataset.settype, e.target.value);
    const i = plan.plan.findIndex((p) => p.from === it.from); if (i >= 0) plan.plan[i] = it;
    selected.add(it.from); render();
  });
  if (e.target.dataset.dupe !== undefined) { dupeChoice.set(e.target.dataset.dupe, e.target.value); render(); }
  if (e.target.dataset.task) safe(async () => { await bridge.call('tasks:toggle', e.target.dataset.task); if (current === 'tasks') render(); });
});

// ---------------- routing ----------------
async function render() {
  const h = decodeURIComponent((location.hash || '#today').slice(1));
  if (h.startsWith('folder:')) { current = 'folder'; currentFolder = h.slice(7); } else { current = h; currentFolder = null; }
  if (!pages[current]) current = 'today';
  if (current !== 'folder' && current !== 'folders') { /* leaving the Folders page */ }
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === (current === 'folder' ? 'folders' : current)));
  await safe(() => pages[current]());
  updateBadges();
}

async function updateBadges() {
  const tasks = (await bridge.call('tasks:get').catch(() => [])).filter((t) => !t.done).length;
  const b = $('#badge-tasks'); b.hidden = !tasks; b.textContent = tasks;
  const p = plan || await bridge.call('organise:last').catch(() => null);
  const n = p && p.mode !== 'review' ? p.plan.length + p.review.length : 0;
  const o = $('#badge-organise'); o.hidden = !n; o.textContent = n;
}

window.addEventListener('hashchange', render);
bridge.on('navigate', (p) => { location.hash = p; });
bridge.on('tasks-changed', () => { if (current === 'tasks' || current === 'today') render(); else updateBadges(); });
bridge.on('meetings-changed', () => { if (current === 'today') render(); });
bridge.on('plan-changed', () => { if (current === 'today') render(); else updateBadges(); });
bridge.on('scan-progress', ({ i, n, file }) => {
  const s = $('#scan-status'); if (!s) return;
  s.textContent = file && file.endsWith('…') ? (n ? `Read ${n} file(s) — now ${file}` : `Getting ready — ${file}`) : `Reading ${i} of ${n}${file ? ` — ${file}` : ''}…`;
});

(async () => {
  settings = await bridge.call('settings:get');
  platform = await bridge.call('app:platform').catch(() => '');
  const themeIcon = () => { const t = settings.theme || 'system'; $('#themetoggle').textContent = t === 'dark' ? '☾' : t === 'light' ? '☀' : '◐'; $('#themetoggle').title = `Appearance: ${t === 'system' ? 'same as Windows' : t} (click to change)`; };
  themeIcon();
  $('#themetoggle').addEventListener('click', async () => {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(settings.theme || 'system') + 1) % 3];
    await saveSettings({ theme: next });
    themeIcon();
    toast(next === 'system' ? 'Appearance: same as Windows' : next === 'light' ? 'Light mode' : 'Dark mode');
    if (current === 'settings') render();
  });
  bridge.call('app:version').then((v) => { appVersion = v; document.title = `Riyeser Desk Assistant ${v}`; }).catch(() => {});
  if (navigator.platform.startsWith('Mac')) $('#hotkey').textContent = '⌘';
  if (!settings.onboarded) { await saveSettings({ onboarded: true }); location.hash = 'companies'; toast('Welcome! Start by adding your own business name and the companies you work with.'); }
  render();
})();
