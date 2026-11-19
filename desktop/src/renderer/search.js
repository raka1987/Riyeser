const q = document.getElementById('q');
const list = document.getElementById('results');
let results = [];
let sel = 0;
let timer;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render() {
  if (!q.value.trim()) { list.innerHTML = '<li class="muted">Try “acme invoice” or “contract 2026”.</li>'; return; }
  if (!results.length) { list.innerHTML = '<li class="muted">No matches.</li>'; return; }
  list.innerHTML = results.map((r, i) => `<li class="${i === sel ? 'sel' : ''}" data-i="${i}">
    <div class="row"><span class="name ellipsis">${esc(r.name)}</span>${r.company ? `<span class="pill">${esc(r.company)}</span>` : ''}${r.docType ? `<span class="pill good">${esc(r.docType)}</span>` : ''}</div>
    <div class="path ellipsis">${esc(r.dir)}</div>${(r.formerNames || []).length ? `<div class="small muted ellipsis">used to be called ${esc(r.formerNames[r.formerNames.length - 1])}</div>` : ''}${r.snippet ? `<div class="small muted ellipsis">…${esc(r.snippet)}…</div>` : ''}</li>`).join('');
  list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

async function run() {
  results = await window.api.call('search', q.value);
  sel = 0;
  render();
}
async function open(i, reveal) {
  const r = results[i];
  if (!r) return;
  await window.api.call(reveal ? 'file:reveal' : 'file:open', r.path);
  window.api.call('search:hide');
}

q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, results.length - 1); render(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
  else if (e.key === 'Enter') open(sel, e.ctrlKey || e.metaKey);
  else if (e.key === 'Escape') { q.value = ''; render(); window.api.call('search:hide'); }
});
list.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) open(+li.dataset.i, e.ctrlKey || e.metaKey); });
window.api.on('search-focus', () => { q.select(); q.focus(); });
render();
