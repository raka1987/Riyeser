// Riyeser Link Office's screen (1.2.3: one control panel). A menu on the left: Overview (what needs attention, and a tile
// for each part of the office phone system), Phones (every phone in one list: tick several to act on them, click one to
// manage it in the panel on the right), People, Calls and Settings.
// 1.2.1: never `const api = window.api` at the top level: the preload puts `api` on the window as a fixed (non-configurable)
// property, so a top-level `const api` is a SyntaxError in Electron and the whole screen stops (no tabs, empty cards).
const bridge = window.api || { call: async () => { throw new Error('Riyeser Link Office\'s window couldn\'t reach the phone system. Close it from the tray icon and open it again.'); }, on() {} };
const T = window.LinkText; const B = window.LinkBulk;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A yes/no box drawn in the page. Browser confirm() boxes can leave Windows unable to type into the window afterwards.
function askYes(text, ok = 'Yes', danger = false) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog'); d.className = 'askform';
    d.innerHTML = `<p style="margin:0 0 16px;white-space:pre-line;line-height:1.45">${esc(text)}</p><div class="row end"><button class="btn s" value="no">Cancel</button><button class="btn${danger ? ' danger' : ''}" value="yes">${esc(ok)}</button></div>`;
    let yes = false;
    d.addEventListener('click', (e) => { const b = e.target.closest('button[value]'); if (b) { yes = b.value === 'yes'; d.close(); } });
    d.addEventListener('close', () => { d.remove(); resolve(yes); });
    document.body.appendChild(d); d.showModal(); d.querySelector('button[value="no"]').focus();
  });
}
// A small form in an in-page dialog (no prompt()). fields: [{ name, label, value, type: 'text' | 'select', options: [[value, label]], list }].
// Resolves with { name: value } or null when cancelled.
function askForm(title, intro, fields, ok = 'Save') {
  return new Promise((resolve) => {
    const d = document.createElement('dialog'); d.className = 'askform';
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>${intro ? `<p>${esc(intro)}</p>` : ''}${fields.map((f) => `<label><span>${esc(f.label)}</span>${f.type === 'select'
      ? `<select name="${esc(f.name)}">${f.options.map(([v, l]) => `<option value="${esc(v)}"${v === f.value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
      : `<input name="${esc(f.name)}" value="${esc(f.value || '')}" maxlength="${f.max || 60}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false"${f.list ? ` list="dl-${esc(f.name)}"` : ''}>${f.list ? `<datalist id="dl-${esc(f.name)}">${f.list.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>` : ''}`}</label>`).join('')}
      ${fields.preview ? `<p class="muted">${esc(fields.preview)}</p>` : ''}
      <div class="row end"><button type="button" class="btn s" value="no">Cancel</button><button class="btn" value="yes">${esc(ok)}</button></div></form>`;
    let out = null;
    d.querySelector('[value=no]').onclick = () => d.close();
    d.querySelector('form').onsubmit = () => { out = Object.fromEntries(new FormData(d.querySelector('form'))); };
    d.addEventListener('close', () => { d.remove(); resolve(out); });
    document.body.appendChild(d); d.showModal(); const i = d.querySelector('input,select'); if (i) i.focus();
  });
}
let setupOpen = false;
let S = null; const shown = {}; let busy = false; let hand = null;   // hand: Set up a phone by hand: { ext, details, reveal }
// what's on screen: filters, sorting, ticked phones and the phone / person / call open in the panel on the right
const ui = { ph: { q: '', status: 'all', vendor: '', location: '', assigned: '', sort: 'status', dir: 1, sel: new Set(), cur: null },
  pp: { q: '', cur: null }, cc: { q: '', kind: 'all', cur: null } };

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4500); }
async function safe(fn) { try { return await fn(); } catch (e) { toast(e.message); return null; } }
const when = (iso) => { if (!iso) return ''; const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
const pill = (state) => `<span class="pill ${/ready|connected/.test(state) && !/not/.test(state) ? 'ok' : /call|ringing/.test(state) ? 'busy' : /waiting/.test(state) ? 'wait' : ''}">${esc(state)}</span>`;
const who = (ext, name) => `${esc(name || '')}${name ? ' ' : ''}<span class="muted">${esc(ext || '')}</span>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isToday = (iso) => !!iso && new Date(iso).toDateString() === new Date().toDateString();

function renderState() {
  const el = $('#state');
  $('#biz').textContent = S.business ? ` · ${S.business}` : '';
  $('#ver').textContent = `Version ${S.version}`;
  if (S.state === 'running') {
    el.className = 'state';
    const rl = T.relayLine(S.relay); const rc = !S.relay ? '' : S.relay.connected ? (S.relay.udp === 'blocked' ? 'warn' : 'ok') : !T.relaySetUp(S.relay) ? 'muted' : 'warn';
    el.innerHTML = `<div class="grow"><b class="big">${esc(T.running(S.host))}</b><span class="muted">${esc(T.counts(S.counts))}${S.licence.text ? ` · ${esc(S.licence.text)}` : ''}</span>${rl ? `<span class="relayline ${rc}" id="relayline">${esc(rl)}</span>` : ''}</div>`;
  } else if (S.state === 'waiting-licence') {
    el.className = 'state wait';
    el.innerHTML = `<div class="grow"><b class="big">${esc(T.WAITING_TITLE)}</b><span>${T.boldPlus(esc(S.licence.message || T.NEEDS_PLUS))}</span></div>
      <button class="btn" data-a="team">Open Riyeser Link</button><button class="btn s" data-a="recheck">Check again</button>`;
  } else if (S.state === 'stopping') {
    el.className = 'state wait';
    el.innerHTML = `<div class="grow"><b class="big">${esc(T.STOPPING_TITLE)}</b><span>${esc(T.STOPPING)}</span></div><button class="btn" data-a="team">Open Riyeser Link</button>`;
  } else if (S.state === 'error') {
    el.className = 'state bad';
    el.innerHTML = `<div class="grow"><b class="big">Riyeser Link Office isn't running</b><span>${esc(S.error)}</span></div>`;
  } else { el.className = 'state wait'; el.innerHTML = '<div class="grow"><b class="big">Starting Riyeser Link Office…</b></div>'; }
}

// Urgent things stay at the top of every page; everything else is in Overview → Needs attention.
function renderNotices() {
  const out = [];
  if (S.offline) out.push(`<div class="note warn"><b>${esc(T.IP_OFFLINE)}</b></div>`);
  if (S.ipChanged) {
    out.push(`<div class="note warn ipnote" id="ipnote"><b class="big">${esc(T.ipChanged(S.ipChanged))}</b><div>${esc(T.ipChangedMore(S.ipChanged))}</div>${S.ipChanged.unstable ? `<div><b>${esc(T.IP_UNSTABLE)}</b></div>` : ''}
      <div class="row"><button class="btn sm" data-a="reserve">${esc(T.RESERVE_TITLE)}</button>${S.ipChanged.unstable ? '' : '<button class="btn s sm" data-a="dismissip">OK</button>'}</div></div>`);
  }
  if (S.firewall === false) out.push(`<div class="note warn"><b>${esc(T.FIREWALL)}</b><div class="row"><button class="btn" data-a="firewall">Allow phones through the firewall</button></div></div>`);
  $('#notices').innerHTML = out.join('');
}

// ---------- every phone in one list: given to someone, new (found on the network or added by MAC) and ignored
function phoneRows() {
  const st = (x) => { if (/waiting for Riyeser Link/.test(x.state)) return ['Paused', 'wait']; return T.phoneStatus(x); };
  return [
    ...S.phones.map((x) => { const [t, c] = st(x); return { kind: 'phone', x, mac: x.mac, macText: x.macText, name: x.label || '', location: x.location || '', ext: x.ext, person: x.name || '', shared: !!x.shared,
      vendor: x.vendor || '', vendorName: x.vendorName, model: x.model || '', ip: x.ip || '', status: t, cls: c, seen: x.registered ? new Date().toISOString() : (x.lastRegistered || x.lastSeen || null) }; }),
    ...S.found.map((x) => ({ kind: 'new', x, mac: x.mac, macText: x.macText, name: x.label || '', location: x.location || '', ext: '', person: '', vendor: x.vendor || '', vendorName: x.vendorName, model: x.model || '', ip: x.ip || '',
      status: 'New', cls: 'busy', seen: x.lastSeen || null })),
    ...S.ignored.map((x) => ({ kind: 'ignored', x, mac: x.mac, macText: x.macText, name: x.label || '', location: x.location || '', ext: '', person: '', vendor: x.vendor || '', vendorName: x.vendorName, model: x.model || '', ip: x.ip || '',
      status: 'Ignored', cls: '', seen: x.lastSeen || null })),
  ];
}
// sorted by status, what needs doing comes first: new phones, then offline ones, … then online, then ignored
const STATUSES = ['New', 'Offline', 'Waiting for phone', 'Configuring', 'Paused', 'Online', 'Ignored'];
const rowTitle = (r) => r.name || (r.kind === 'phone' ? `${r.vendorName} ${r.model}`.trim() : r.kind === 'new' ? 'New phone' : 'Ignored phone');
function filtered() {
  const f = ui.ph; const q = f.q.trim().toLowerCase();
  const rows = phoneRows().filter((r) => (f.status === 'all' || r.status === f.status) && (!f.vendor || r.vendorName === f.vendor) && (!f.location || (f.location === '-' ? !r.location : r.location === f.location))
    && (!f.assigned || (f.assigned === 'yes' ? r.kind === 'phone' : r.kind !== 'phone'))
    && (!q || [r.name, r.location, r.ext, r.person, r.vendorName, r.model, r.macText, r.mac, r.ip, r.status].some((v) => String(v || '').toLowerCase().includes(q))));
  const key = { name: (r) => rowTitle(r).toLowerCase(), ext: (r) => r.ext || '~', person: (r) => (r.person || '~').toLowerCase(), model: (r) => `${r.vendorName} ${r.model}`.toLowerCase(),
    mac: (r) => r.mac, ip: (r) => (r.ip ? r.ip.split('.').map((n) => n.padStart(3, '0')).join('.') : '~'), status: (r) => STATUSES.indexOf(r.status), seen: (r) => (r.seen ? -Date.parse(r.seen) : Infinity) }[f.sort] || ((r) => rowTitle(r));
  const name = (r) => rowTitle(r).toLowerCase();
  return rows.sort((a, b) => { const x = key(a); const y = key(b); return ((x < y ? -1 : x > y ? 1 : 0) * f.dir) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0); });
}
function renderPhoneFilters() {
  const box = $('#phfilters'); if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const all = phoneRows(); const f = ui.ph;
  if (!all.length) { box.innerHTML = ''; return; }
  const vendors = [...new Set(all.map((r) => r.vendorName).filter(Boolean))].sort(); const locs = [...new Set(all.map((r) => r.location).filter(Boolean))].sort();
  const count = (s) => all.filter((r) => r.status === s).length;
  box.innerHTML = `<input type="search" id="phq" placeholder="Search name, extension, person, MAC, IP…" value="${esc(f.q)}" aria-label="Search phones">
    <select id="phst" aria-label="Status"><option value="all">All statuses</option>${STATUSES.filter((s) => count(s) || f.status === s).map((s) => `<option value="${esc(s)}"${f.status === s ? ' selected' : ''}>${esc(s)} (${count(s)})</option>`).join('')}</select>
    <select id="phvd" aria-label="Maker"><option value="">All makers</option>${vendors.map((v) => `<option${f.vendor === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
    <select id="phloc" aria-label="Location"><option value="">All locations</option>${locs.map((v) => `<option${f.location === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}<option value="-"${f.location === '-' ? ' selected' : ''}>No location</option></select>
    <select id="phas" aria-label="Given to someone"><option value="">All phones</option><option value="yes"${f.assigned === 'yes' ? ' selected' : ''}>Assigned</option><option value="no"${f.assigned === 'no' ? ' selected' : ''}>Not assigned</option></select>`;
}
function renderPhones() {
  const rows = filtered(); const f = ui.ph;
  const known = new Set(phoneRows().map((r) => r.mac)); for (const m of [...f.sel]) if (!known.has(m)) f.sel.delete(m);
  const th = (k, t, cls = '') => `<th class="sort ${cls}" data-sort="${k}" aria-sort="${f.sort === k ? (f.dir > 0 ? 'ascending' : 'descending') : 'none'}">${t}${f.sort === k ? `<span class="arr">${f.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`;
  const allOn = rows.length > 0 && rows.every((r) => f.sel.has(r.mac));
  const total = phoneRows().length;
  $('#phones').innerHTML = !total ? '<div class="empty"><p><b>No desk phones yet.</b></p><p>Plug one in on the office network and it shows up here as <b>New</b>, or add them by MAC address.</p><p><button class="btn" data-a="addmany">+ Add several phones</button> <button class="btn s" data-a="addphone">+ Add a phone</button></p></div>'
    : `<table><thead><tr><th class="ck"><input type="checkbox" id="phall" title="Select all ${rows.length} shown" aria-label="Select all ${rows.length} shown"${allOn ? ' checked' : ''}></th>${th('name', 'Name · location')}${th('ext', 'Ext.')}${th('person', 'Person')}${th('model', 'Model')}${th('mac', 'MAC', 'opt')}${th('ip', 'IP', 'opt')}${th('status', 'Status')}${th('seen', 'Last seen')}</tr></thead>
      <tbody>${rows.map((r) => `<tr data-row="${esc(r.mac)}" class="${f.sel.has(r.mac) ? 'sel' : ''}${f.cur === r.mac ? ' cur' : ''}">
        <td class="ck"><input type="checkbox" data-pick="${esc(r.mac)}"${f.sel.has(r.mac) ? ' checked' : ''} aria-label="Select ${esc(rowTitle(r))} ${esc(r.macText)}"></td>
        <td class="two"><b>${esc(rowTitle(r))}</b><small>${esc(r.location || '—')}</small></td>
        <td>${r.ext ? `<b>${esc(r.ext)}</b>` : '<span class="muted">—</span>'}</td>
        <td>${r.person ? `${esc(r.person)}${r.shared ? ' <span class="pill">shared</span>' : ''}` : '<span class="muted">—</span>'}</td>
        <td class="two"><b>${esc(r.vendorName || 'Not known')}</b><small>${esc(r.model || '—')}</small></td>
        <td class="mono opt">${esc(r.macText)}</td><td class="mono opt">${esc(r.ip || '—')}</td>
        <td><span class="pill ${esc(r.cls)}">${esc(r.status)}</span></td><td>${r.seen ? esc(when(r.seen)) : '<span class="muted">Never</span>'}</td></tr>`).join('')
        || '<tr><td colspan="9" class="empty">No phones match. <button class="linkbtn" data-a="phclear">Clear the filters</button></td></tr>'}</tbody></table>`;
  const on = S.phones.filter((x) => x.state === 'connected').length;
  $('#phcount').textContent = total ? `${T.relaySetUp(S.relay) && S.siteName ? `At ${S.siteName} · ` : ''}${plural(total, 'phone')} · ${on} online${S.found.length ? ` · ${S.found.length} new` : ''}${rows.length !== total ? ` · ${rows.length} shown` : ''}` : '';
  const nn = $('#navnew'); nn.hidden = !S.found.length; nn.textContent = S.found.length;
  renderBulkBar();
}
function selRows() { const s = ui.ph.sel; return phoneRows().filter((r) => s.has(r.mac)); }
function renderBulkBar() {
  const sel = selRows(); const bar = $('#phbulk'); bar.hidden = !sel.length; if (!sel.length) { bar.innerHTML = ''; return; }
  const n = (k) => sel.filter((r) => r.kind === k).length;
  const b = (a, t, show = true, cls = 's') => (show ? `<button class="btn ${cls} sm" data-bulk="${a}">${t}</button>` : '');
  bar.innerHTML = `<b>${plural(sel.length, 'phone')} selected</b>
    ${b('give', 'Give to…', n('new') + n('ignored') > 0, '')}${b('shared', 'Add as shared phones', n('new') + n('ignored') > 0)}${b('location', 'Move location')}
    ${b('restart', 'Restart', sel.some((r) => r.ip))}${b('resync', 'Re-send settings', sel.some((r) => r.ip && r.kind === 'phone'))}
    ${b('unassign', 'Take back', n('phone') > 0)}${b('ignore', 'Ignore', n('new') > 0)}${b('unignore', 'Bring back', n('ignored') > 0)}${b('remove', 'Remove', true, 's danger')}
    <span class="grow"></span><button class="linkbtn" data-bulk="clear">Clear</button>`;
}

// ---------- the panel on the right: everything about one phone
function renderPhonePanel() {
  const box = $('#phpanel'); const split = $('#phsplit');
  const r = phoneRows().find((x) => x.mac === ui.ph.cur);
  if (!r) { box.hidden = true; split.classList.remove('open'); ui.ph.cur = null; return; }
  if (box.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && box.dataset.mac === r.mac) return;   // don't redraw under someone typing
  box.hidden = false; split.classList.add('open'); box.dataset.mac = r.mac;
  const x = r.x; const c = B.caps(r.vendor); const s = x.settings || {};
  const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const people = S.people.filter((p) => !p.shared || p.ext === r.ext);
  const calls = r.ext ? S.recent.filter((k) => k.from === r.ext || k.to === r.ext || k.answeredBy === r.ext).slice(0, 8) : [];
  const keys = s.lineKeys || [];
  const settingsForm = r.kind !== 'phone' ? '' : !Object.keys(c).length ? `<h4>Phone settings</h4><p class="hint">${esc(r.vendorName || 'This maker')} phones aren't set up by Riyeser Link Office, so their settings are changed on the phone itself.</p>`
    : `<h4>Phone settings <small class="muted">${esc(r.vendorName)}</small></h4><form id="psform" data-mac="${esc(r.mac)}">
      <div class="two">${c.label ? `<label><span>Name on the line key</span><input name="label" maxlength="20" value="${esc(s.label || '')}" placeholder="${esc(x.name || '')}"></label>` : ''}
        ${c.displayName ? `<label><span>Name shown on calls</span><input name="displayName" maxlength="40" value="${esc(s.displayName || '')}" placeholder="${esc(x.name || '')}"></label>` : ''}
        ${c.timezone ? `<label><span>Time zone</span><select name="timezone"><option value="">Phone's own</option>${opts(['+14', '+13', '+12', '+11', '+10', '+9:30', '+9', '+8', '+5:30', '+0', '-5', '-8'].map((z) => [z, `UTC${z}`]), s.timezone)}</select></label>` : ''}
        ${c.timeFormat ? `<label><span>Clock</span><select name="timeFormat"><option value="">Phone's own</option>${opts([['12', '12-hour'], ['24', '24-hour']], s.timeFormat)}</select></label>` : ''}
        ${c.language ? `<label><span>Language</span><select name="language"><option value="">Phone's own</option>${opts(B.LANGS, s.language)}</select></label>` : ''}
        ${c.ringtone ? `<label><span>Ringtone</span><select name="ringtone"><option value="">Phone's own</option>${opts(Array.from({ length: c.ringtone }, (_, i) => [i + 1, `Ringtone ${i + 1}`]), s.ringtone)}</select></label>` : ''}
        ${c.ringVolume ? `<label><span>Ring volume</span><select name="ringVolume"><option value="">Phone's own</option>${opts(Array.from({ length: 15 }, (_, i) => [i + 1, String(i + 1)]), s.ringVolume)}</select></label>` : ''}
        ${c.dnd ? `<label><span>Do not disturb</span><select name="dnd"><option value="">Phone's own</option>${opts([['person', `Follow ${x.name || 'the person'}`], ['off', 'Off']], s.dnd)}</select></label>` : ''}</div>
      ${c.lineKeys ? `<p class="hint"><b>Speed-dial keys</b> (up to ${c.lineKeys}): an extension or ring group, called with one press. Busy lamps need a newer Riyeser Link Office.</p>
        <div class="keys">${Array.from({ length: Math.min(c.lineKeys, Math.max(3, keys.length + 1)) }, (_, i) => `<span>Key ${i + (r.vendor === 'yealink' ? 2 : 1)}</span><input name="kv${i}" value="${esc((keys[i] || {}).value || '')}" placeholder="e.g. 102" inputmode="numeric" maxlength="8" aria-label="Key ${i + 1} number"><input name="kl${i}" value="${esc((keys[i] || {}).label || '')}" placeholder="Label" maxlength="20" aria-label="Key ${i + 1} label">`).join('')}</div>` : ''}
      <p class="hint">Changes reach the phone the next time it fetches its settings. <b>Save and restart</b> does it now.</p>
      <div class="row"><button class="btn sm" name="go" value="restart">Save and restart</button><button class="btn s sm" name="go" value="save">Save</button></div></form>`;
  box.innerHTML = `<div class="sh"><div><h3>${esc(rowTitle(r))}</h3><small>${esc(r.vendorName || 'Maker not known')} ${esc(r.model)} · <span class="mono">${esc(r.macText)}</span></small></div>
      <button class="x" data-a="closepanel" aria-label="Close">✕</button></div>
    <span class="pill ${esc(r.cls)}">${esc(r.status)}</span>
    <dl class="kv">${T.relaySetUp(S.relay) ? `<dt>Site</dt><dd><span class="sitetag here">${esc(S.siteName || 'This site')}</span></dd>` : ''}${r.kind === 'phone' ? `<dt>Extension</dt><dd><b>${esc(r.ext)}</b> ${esc(r.person)}${r.shared ? ' <span class="pill">shared</span>' : ''}</dd>` : ''}
      <dt>Location</dt><dd>${esc(r.location || '—')}</dd>${x.note ? `<dt>Note</dt><dd>${esc(x.note)}</dd>` : ''}
      <dt>IP address</dt><dd class="mono">${esc(r.ip || '—')}</dd>${x.firmware ? `<dt>Firmware</dt><dd class="mono">${esc(x.firmware)}</dd>` : ''}
      ${x.registeredSince ? `<dt>Connected since</dt><dd>${esc(when(x.registeredSince))}</dd>` : ''}<dt>Last seen</dt><dd>${r.seen ? esc(when(r.seen)) : 'Never'}</dd>
      ${r.kind === 'phone' ? `<dt>Settings fetched</dt><dd>${x.lastFetch ? esc(when(x.lastFetch)) : 'Not yet'}</dd>` : x.firstSeen ? `<dt>First seen</dt><dd>${esc(when(x.firstSeen))}</dd>` : ''}</dl>
    <h4>Actions</h4><div class="acts2">
      ${r.ip ? '<button class="btn s sm" data-pa="restart">Restart</button>' : ''}${r.kind === 'phone' && r.ip ? '<button class="btn s sm" data-pa="resync">Re-send settings</button>' : ''}
      ${r.kind === 'phone' && r.status === 'Online' ? '<button class="btn s sm" data-pa="find">Find this phone</button>' : ''}${r.ip ? '<button class="btn s sm" data-pa="web">Its web page</button>' : ''}
      ${r.kind === 'phone' ? `<button class="btn s sm" data-manual2="${esc(r.ext)}">Set up by hand</button><button class="btn s sm" data-reset="${esc(r.ext)}">New SIP password</button><button class="btn s sm" data-replace="${esc(r.mac)}">Replace phone</button><button class="btn s sm" data-pa="unassign">Take back</button>` : ''}
      ${r.kind === 'new' ? '<button class="btn s sm" data-pa="ignore">Ignore (not ours)</button>' : ''}${r.kind === 'ignored' ? '<button class="btn s sm" data-pa="unignore">Bring back</button>' : ''}
      <button class="btn danger sm" data-pa="remove">Remove</button></div>
    ${r.kind === 'phone' && r.status !== 'Online' ? '<p class="hint">Find this phone (it rings for 5 seconds) works once the phone is online.</p>' : ''}
    <h4>${r.kind === 'phone' ? 'Extension or person' : 'Give it to'}</h4>
    <form id="pmove" class="row" data-mac="${esc(r.mac)}"><select name="to" aria-label="Who the phone is for"><option value="">Choose…</option>${people.map((p) => `<option value="${esc(p.ext)}"${p.ext === r.ext ? ' selected' : ''}>${esc(p.ext)} · ${esc(p.name)}${p.shared ? ' (shared)' : ''}</option>`).join('')}<option value="+shared">A new shared phone (Reception, Meeting room…)</option></select>
      <input name="shared" placeholder="Shared phone's name" maxlength="40" hidden aria-label="Shared phone's name"><button class="btn sm">${r.kind === 'phone' ? 'Change' : 'Give'}</button></form>
    <h4>Name and location</h4>
    <form id="pname" data-mac="${esc(r.mac)}"><div class="two"><label><span>Phone name</span><input name="name" maxlength="40" value="${esc(r.name)}" placeholder="e.g. Reception"></label>
      <label><span>Location</span><input name="location" maxlength="60" value="${esc(r.location)}" list="locs" placeholder="e.g. Head office"></label></div>
      ${r.kind === 'phone' ? `<label><span>Notes</span><input name="note" maxlength="60" value="${esc(x.note || '')}" placeholder="e.g. S/N 1234"></label>` : ''}
      <datalist id="locs">${[...new Set(phoneRows().map((q) => q.location).filter(Boolean))].map((l) => `<option value="${esc(l)}">`).join('')}</datalist>
      <div class="row"><button class="btn s sm">Save</button></div></form>
    ${settingsForm}
    ${r.kind === 'phone' ? `<h4>Recent calls on ${esc(r.ext)}</h4>${calls.length ? `<ul class="calls">${calls.map((k) => `<li><span>${esc(when(k.start))} · ${k.from === r.ext ? `to ${esc(k.toName || k.to)}` : `from ${esc(k.fromName || k.from)}`}</span><span class="muted">${esc(T.result(k.result))}</span></li>`).join('')}</ul>` : '<p class="hint">No calls yet.</p>'}
      <p class="hint">Do not disturb, ring groups and the password belong to the person: <button class="linkbtn" data-person="${esc(r.ext)}">open ${esc(r.person || 'them')} on People</button>.</p>` : ''}`;
}

// ---------- Overview: what needs attention, then a tile for each part
function attention() {
  const a = []; const add = (cls, text, act, label) => a.push({ cls, text, act, label });
  if (S.state === 'waiting-licence') add('bad', T.WAITING_TITLE, 'team', 'Open Riyeser Link');
  if (S.state === 'error') add('bad', S.error || 'Riyeser Link Office isn\'t running.', null);
  if (S.found.length) add('info', `${plural(S.found.length, 'new phone')} waiting to be given out`, 'givenew', `Give out ${plural(S.found.length, 'new phone')}`);
  const off = S.phones.filter((x) => T.phoneStatus(x)[0] === 'Offline');
  if (off.length) add('warn', `${plural(off.length, 'phone')} offline: ${off.slice(0, 3).map((x) => x.label || x.name || x.macText).join(', ')}${off.length > 3 ? '…' : ''}`, 'showoffline', 'Show them');
  if (S.firewall === false) add('bad', 'Windows Firewall may be blocking the desk phones.', 'firewall', 'Fix firewall');
  if (S.firewall === 'outdated') add('info', T.FIREWALL_OLD, 'firewall', 'Update the rule');
  if (S.addressStable === false) add('warn', 'This PC\'s address keeps changing, so phones may lose touch.', 'reserve', 'Reserve address');
  if (S.offline) add('bad', T.IP_OFFLINE, null);
  if (S.sleepNote) add('warn', S.sleepNote, null);
  for (const b of S.blocked || []) add('warn', `Blocked ${b.ip} until ${when(b.until)} after too many wrong passwords. If that's one of your phones, check its password.`, null);
  const eg = emptyGroups();
  if (eg.length) add('warn', `Nobody is chosen to answer ${eg.slice(0, 3).map((g) => `${g.name} (${g.ext})`).join(', ')}${eg.length > 3 ? '…' : ''}, so calls to ${eg.length === 1 ? 'it' : 'them'} are missed.`, 'rings', 'Choose who answers');
  if ((S.skipped || []).length) add('info', `Not on the phones yet: ${S.skipped.map((x) => `${x.name} (${x.why})`).join('; ')}.`, 'sync', 'Bring in people again');
  if (S.cloud && S.cloud.status === 'offline') add('warn', T.cloud(S.cloud), 'report', 'Try now');
  const rp = S.relay && T.relayTile(S.relay).problem; if (rp) add(rp.cls, rp.text, rp.act, rp.label);   // the Riyeser relay (1.3.0)
  if (!S.signedIn && S.source !== 'team') add('info', 'Sign in to bring in your team and see the phones on the website.', 'step-signin', 'Sign in');
  return a;
}
function renderOverview() {
  const a = attention();
  const na = $('#navattn'); na.hidden = !a.length; na.textContent = a.length; na.className = `badge${a.some((x) => x.cls === 'bad' || x.cls === 'warn') ? ' warn' : ''}`;
  $('#attn').className = `panel attn${a.length ? '' : ' allgood'}`;
  $('#attn').innerHTML = a.length ? `<h2>Needs attention</h2><ul>${a.map((x) => `<li class="${x.cls}"><span class="dot" aria-hidden="true"></span><span class="grow">${esc(x.text)}</span>${x.act ? `<button class="btn s sm" data-a="${esc(x.act)}">${esc(x.label)}</button>` : ''}</li>`).join('')}</ul>`
    : '<b class="okt">✓ Nothing needs attention</b><span class="muted">The phones, this PC and Riyeser Online are all fine.</span>';
  const st = S.phones.map((x) => T.phoneStatus(x)[0]);
  const on = st.filter((x) => x === 'Online').length; const off = st.filter((x) => x === 'Offline').length;
  const callsToday = S.recent.filter((c) => isToday(c.start)); const missed = callsToday.filter((c) => c.result === 'missed' || c.result === 'unavailable').length;
  const dnd = S.people.filter((p) => p.dnd);
  const n = (num, label, act) => `<button data-a="${act}"><b>${num}</b><span>${esc(label)}</span></button>`;
  const fw = S.firewall === false ? 'bad' : S.firewall === 'outdated' || S.sleepNote ? 'warn' : 'ok';
  const cl = S.cloud ? S.cloud.status : 'local';
  $('#tiles').innerHTML = [
    `<section class="tile ${off ? 'warn' : S.found.length ? 'info' : S.phones.length ? 'ok' : 'off'}"><h3>☎ Phones</h3><div class="nums">${n(on, 'online', 'f-Online')}${n(off, 'offline', 'f-Offline')}${n(S.found.length, 'new', 'f-New')}</div>
      <div class="acts">${S.found.length ? `<button class="btn sm" data-a="givenew">Give out ${plural(S.found.length, 'new phone')}</button>` : ''}<button class="btn s sm" data-a="addmany">+ Add several phones</button></div></section>`,
    `<section class="tile ${missed ? 'warn' : 'ok'}"><h3>↗ Calls today</h3><div class="nums">${n(callsToday.length, 'calls', 'calls')}${n(missed, 'missed', 'callsmissed')}${n(S.inProgress.length, 'now', 'calls')}</div>
      <p>Kept on this PC for 90 days, never sent online.</p></section>`,
    `<section class="tile ${dnd.length ? 'info' : 'ok'}"><h3>👥 People</h3><div class="nums">${n(S.people.length, 'people', 'people')}${n(dnd.length, 'do not disturb', 'people')}${n(S.groups.length, 'ring groups', 'people')}</div>
      <p>${dnd.length ? esc(`On Do not disturb: ${dnd.slice(0, 3).map((p) => p.name).join(', ')}${dnd.length > 3 ? '…' : ''}.`) : 'Nobody is on Do not disturb.'}</p></section>`,
    `<section class="tile ${S.ipChanged || S.addressStable === false ? 'warn' : 'ok'}"><h3>🖥 This PC's address</h3><div class="big"><code>${esc(S.host || '…')}</code></div>
      <p>${esc(S.names && S.names.mdns ? `Also ${S.names.mdns}${S.names.router ? ` and ${S.names.router}` : ''}.` : '')}${S.addressStable === false ? ' It keeps changing.' : ''}</p>
      <div class="acts"><button class="btn s sm" data-copy="${esc(S.host || '')}">Copy</button><button class="btn s sm" data-a="reserve">Reserve address</button></div></section>`,
    `<section class="tile ${emptyGroups().length ? 'warn' : S.groups.length ? 'ok' : 'off'}"><h3>☏ Ring groups</h3><div class="nums">${n(S.groups.length, 'numbers', 'people')}${n(emptyGroups().length, 'to check', 'people')}</div>
      <p>${S.groups.length ? esc(S.groups.slice(0, 3).map((g) => `${g.ext} ${g.name}: ${groupHow(g)}`).join(' · ')) : 'Each branch or group number (like Sales or Reception) rings the people chosen for it.'}</p>
      <div class="acts"><button class="btn s sm" data-a="rings">Manage ring groups</button></div></section>`,
    relayTileHtml(),
    `<section class="tile ${fw}"><h3>🛡 Windows check and backups</h3><div class="big">${fw === 'ok' ? 'All good' : fw === 'bad' ? 'Firewall blocks phones' : 'Needs a look'}</div>
      <p>Firewall: ${S.firewall === true ? 'phones allowed' : S.firewall === false ? 'not allowed yet' : S.firewall === 'outdated' ? 'older rule' : 'not checked here'} · Starts with Windows: ${S.startWithWindows ? 'yes' : 'no'}${S.sleepNote ? ' · may go to sleep' : ''} · Backed up every day (the last 30 kept).</p>
      <div class="acts">${S.firewall === false || S.firewall === 'outdated' ? '<button class="btn sm" data-a="firewall">Fix firewall</button>' : ''}<button class="btn s sm" data-a="recheck">Check again</button><button class="btn s sm" data-a="backupnow">Back up now</button></div></section>`,
    `<section class="tile ${cl === 'online' ? 'ok' : cl === 'offline' ? 'warn' : 'off'}"><h3>☁ Riyeser Online</h3><div class="big">${cl === 'online' ? 'Connected' : cl === 'offline' ? 'Can\'t reach it' : cl === 'local' ? 'Not linked' : 'Connecting…'}</div>
      <p>${esc(S.teamSyncedAt ? `People brought in ${when(S.teamSyncedAt)}. ` : '')}${esc(T.cloud(S.cloud))}</p>
      <div class="acts">${cl === 'online' ? '<button class="btn s sm" data-a="web">Phones page on the website</button>' : ''}<button class="btn s sm" data-a="sync">Bring in people now</button></div></section>`,
  ].join('');
}
// Overview → Branches and relay (1.3.0): the Riyeser relay's real state (link-text.js relayTile)
function relayTileHtml() {
  const t = T.relayTile(S.relay);
  return `<section class="tile ${t.cls}" id="relaytile"><h3>🏢 Branches and relay</h3><div class="big">${esc(t.big)}</div><p>${esc(t.text)}</p>
    <div class="acts">${t.act && t.act !== 'relay' ? `<button class="btn sm" data-a="${esc(t.act)}">${esc(t.label)}</button>` : ''}<button class="btn s sm" data-a="relay">${S.relay && T.relaySetUp(S.relay) ? 'Details' : 'Connect your branches'}</button></div></section>`;
}
/** Where an extension's phones are, with the relay set up (1.3.0): this site, or another site / at home. */
function siteTag(ext) {
  const w = T.extSite(S.relay, ext, (S.registrations || []).some((x) => x.ext === ext));
  return w === 'here' ? `<span class="sitetag here" title="Connected at this site">${esc(S.siteName || 'This site')}</span>` : w === 'remote' ? '<span class="sitetag" title="Reached through the Riyeser relay">Another site or at home</span>' : '';
}
const personOptions = (sel) => `<option value="">Who is it for?</option>${S.people.map((p) => `<option value="${esc(p.ext)}"${sel === p.ext ? ' selected' : ''}>${esc(p.name)} (${esc(p.ext)})</option>`).join('')}`;
// the address to type into phones, big, with the two things people come here to do
function renderHero() {
  const live = S.state === 'running';
  $('#hero').innerHTML = `<div><small>${esc(T.SERVER_LABEL)}</small>
      <div class="addr"><code id="srv">${esc(S.host || '…')}</code><span class="port">${esc(T.port(S.sipPort))}</span><button class="btn s sm" data-copy="${esc(S.host || '')}">Copy</button></div>
      ${S.names && S.names.useName ? `<div class="muted">Desk phones are given the name <code>${esc(S.names.server)}</code>, which follows this PC.</div>` : ''}
      <div class="muted">${esc(T.SERVER_HINT)}</div>
      ${S.names ? `<div class="muted small">${esc(T.namesLine(S.names))}</div>` : ''}
      ${S.addressStable === false ? `<div class="note warn" style="margin:8px 0 0">${esc(T.NOT_STABLE)}</div>` : ''}</div>
    <div class="acts"><button class="btn" data-a="hand">☎ Set up a phone by hand</button><button class="btn" data-a="addmany">+ Add several phones</button>
      ${live ? '' : `<span class="muted">${esc(T.NOT_RUNNING_HINT)}</span>`}</div>`;
  $('#srvline').innerHTML = `<span>${esc(T.SERVER_LABEL)}:</span><code>${esc(S.names && S.names.useName ? S.names.server : S.host || '…')}</code><span>${esc(T.port(S.sipPort))}</span><button class="btn s sm" data-copy="${esc(S.host || '')}">Copy</button>`;
}
function renderHand() {
  $('#manualwho').innerHTML = `<option value="">Who is the phone for?</option>${S.people.map((p) => `<option value="${esc(p.ext)}"${hand && hand.ext === p.ext ? ' selected' : ''}>${esc(p.name)} (${esc(p.ext)})</option>`).join('')}`;
  const m = hand && hand.details;
  $('#manualout').innerHTML = m ? `<div class="manual">Type these into the phone's SIP account settings:<br>
      Server address (SIP server, registrar): <code>${esc(m.server)}</code> &nbsp; Port: <code>${esc(m.port)}</code><br>
      Username (and authentication name): <code>${esc(m.username)}</code><br>
      Password: <code>${hand.reveal ? esc(m.password) : '••••••••••••••••'}</code>
      <button class="btn s sm" data-handreveal="1">${hand.reveal ? 'Hide' : 'Show'}</button><button class="btn s sm" data-copy="${esc(m.password)}">Copy password</button>
      <button class="btn s sm" data-reset="${esc(m.username)}">Make a new password</button><br>
      <span class="muted">Transport: UDP. Leave the outbound proxy empty. Display name: ${esc(m.name)}.</span></div>` : '';
}

// ---------- "Set up your office phones": 5 steps that tick themselves off; folded away once they're all done
function renderSetup() {
  const steps = T.setupSteps(S); const all = steps.every((x) => x.done);
  $('#setup').innerHTML = all && !setupOpen
    ? `<div class="row" style="margin:0"><b class="okt">${esc(T.SETUP_DONE)}</b><button class="btn s sm" data-a="setupopen">Show the steps</button></div>`
    : `<div class="ph"><h2>${esc(T.SETUP_TITLE)}</h2><span class="muted">${steps.filter((x) => x.done).length} of ${steps.length} done</span>${all ? '<button class="btn s sm" data-a="setupopen">Hide</button>' : ''}</div>
      <ol class="steps">${steps.map((x) => `<li class="${x.done ? 'done' : ''}"><span class="tick" aria-hidden="true">${x.done ? '✓' : ''}</span><span class="grow">${esc(x.text)}${x.note && !x.done ? `<small class="muted"> ${esc(x.note)}</small>` : ''}</span>
        ${!x.done && x.act ? `<button class="btn s sm" data-a="step-${x.act}">${esc(x.actText)}</button>` : ''}</li>`).join('')}</ol>`;
}
function renderFound() {
  const el = $('#found'); el.hidden = !S.found.length || ui.ph.status === 'New';
  el.innerHTML = S.found.length ? `<div class="newbar"><b>${plural(S.found.length, 'new phone')} found</b><span class="muted grow">Not given to anyone yet.</span><button class="btn sm" data-a="givenew">Give them out…</button><button class="btn s sm" data-a="f-New">Show them</button></div>` : '';
  if (el.nextElementSibling !== $('#phsplit')) $('#phsplit').before(el);
}

// ---------- People: the list, and one person in the panel on the right
function renderPeople() {
  $('#pcount').textContent = S.people.length ? `${S.people.length} · ${S.source === 'team' ? 'from Riyeser Link' : 'added on this PC'}` : '';
  const box = $('#pfilters'); if (!box.contains(document.activeElement)) box.innerHTML = S.people.length > 6 ? `<input type="search" id="pq" placeholder="Search people and extensions…" value="${esc(ui.pp.q)}" aria-label="Search people">` : '';
  const q = ui.pp.q.trim().toLowerCase();
  const list = S.people.filter((p) => !q || `${p.name} ${p.ext}`.toLowerCase().includes(q));
  $('#people').innerHTML = !S.people.length ? '<div class="empty"><p>No one yet. Sign in to Riyeser under Settings to bring in your team, or add people below.</p></div>'
    : `<table><thead><tr><th>Name</th><th>Ext.</th><th>Device</th><th>State</th><th>Do not disturb</th><th>Desk phones</th></tr></thead><tbody>
      ${list.map((p) => `<tr data-prow="${esc(p.ext)}" class="${ui.pp.cur === p.ext ? 'cur' : ''}"><td><b>${esc(p.name)}</b>${p.shared ? ' <span class="pill">shared</span>' : ''}</td><td><b>${esc(p.ext)}</b></td><td>${esc(T.device(p.device))} ${siteTag(p.ext)}</td><td>${pill(T.personState(p))}</td>
        <td><input type="checkbox" data-dnd="${esc(p.ext)}"${p.dnd ? ' checked' : ''} aria-label="Do not disturb for ${esc(p.name)}"></td><td>${S.phones.filter((x) => x.ext === p.ext).length || '<span class="muted">0</span>'}</td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">No one matches.</td></tr>'}</tbody></table>`;
  if (!busy) $('#addperson').innerHTML = `<form id="personform" class="row"><input id="pname" placeholder="${S.source === 'team' ? 'Someone not in Riyeser Link? Their name' : 'Add a person: their name'}" autocomplete="off">
    <input id="pext" placeholder="Extension (blank = next free)" style="flex:0 1 190px" inputmode="numeric"><button class="btn">Add</button></form>`;
  $('#macwho').innerHTML = personOptions('');
  renderPersonPanel();
}
function renderPersonPanel() {
  const box = $('#ppanel'); const split = $('#psplit'); const p = S.people.find((x) => x.ext === ui.pp.cur);
  if (!p) { box.hidden = true; split.classList.remove('open'); ui.pp.cur = null; return; }
  box.hidden = false; split.classList.add('open');
  const m = shown[p.ext]; const phones = S.phones.filter((x) => x.ext === p.ext); const groups = S.groups.filter((g) => (g.members || []).includes(p.ext));
  box.innerHTML = `<div class="sh"><div><h3>${esc(p.name)}</h3><small>Extension ${esc(p.ext)}${p.shared ? ' · shared phone' : ''} · ${p.source === 'team' ? 'from Riyeser Link' : 'added on this PC'}</small></div><button class="x" data-a="closeperson" aria-label="Close">✕</button></div>
    ${pill(T.personState(p))}
    <dl class="kv"><dt>Device</dt><dd>${esc(T.device(p.device))}</dd>${siteTag(p.ext) ? `<dt>Where</dt><dd>${siteTag(p.ext)}</dd>` : ''}<dt>Do not disturb</dt><dd><label><input type="checkbox" data-dnd="${esc(p.ext)}"${p.dnd ? ' checked' : ''}> ${p.dnd ? 'On' : 'Off'}</label></dd>
      <dt>Ring groups</dt><dd>${groups.length ? groups.map((g) => `${esc(g.ext)} ${esc(g.name)}`).join(', ') : 'None'}</dd></dl>
    <h4>Desk phones</h4>${phones.length ? `<ul class="calls">${phones.map((x) => `<li><button class="linkbtn" data-openphone="${esc(x.mac)}">${esc(x.label || `${x.vendorName} ${x.model || ''}`)}</button><span class="muted">${esc(T.phoneStatus(x)[0])}</span></li>`).join('')}</ul>` : '<p class="hint">None yet.</p>'}
    <h4>Set up a phone or app by hand</h4>
    ${m ? `<div class="manual">Server address: <code>${esc(m.server)}</code> (port ${esc(m.port)})<br>Username: <code>${esc(m.username)}</code><br>Password: <code>${m.reveal ? esc(m.password) : '••••••••••••••••'}</code>
      <div class="row"><button class="btn s sm" data-reveal="${esc(p.ext)}">${m.reveal ? 'Hide' : 'Show'}</button><button class="btn s sm" data-copy="${esc(m.password)}">Copy password</button><button class="btn s sm" data-reset="${esc(p.ext)}">Make a new password</button></div></div>`
      : `<button class="btn s sm" data-manual="${esc(p.ext)}">${esc(T.howSetsUp(p.name))}</button>`}
    ${p.source === 'local' ? `<h4>Remove</h4><button class="btn danger sm" data-remove="${esc(p.id)}">Take ${esc(p.name)} off the phones</button>` : '<p class="hint">Name, extension and branches are changed in Riyeser Link.</p>'}`;
}
// Ring groups (1.2.2): chosen in Riyeser Link (Management › Ring groups); shown here with how they ring.
const HOW = { all: 'all at once', order: 'one after another', rotate: 'taking turns' };
const groupHow = (g) => `${HOW[g.strategy] || HOW.all}${g.fallback ? ` · then ${g.fallback.ext}` : ''}`;
const emptyGroups = () => S.groups.filter((g) => !(g.members || []).length);
function renderGroups() {
  $('#groupsp').hidden = !S.groups.length;
  $('#groups').innerHTML = `<div class="tw"><table><tr><th>Number</th><th>Group</th><th>Who answers</th><th>How it rings</th></tr>${S.groups.map((g) => `<tr><td><b>${esc(g.ext)}</b></td><td>${esc(g.name)}</td>
    <td>${g.names.length ? esc(g.names.join(', ')) : '<span class="pill wait">Nobody chosen</span>'}</td><td class="muted">${esc(groupHow(g))}</td></tr>`).join('')}</table></div>`;
}
// ---------- Calls: the list (filter missed or answered), and one call in the panel
function callRows() { return [...S.inProgress.map((c) => ({ ...c, live: true, result: c.state === 'talking' ? 'on a call now' : 'ringing' })), ...S.recent.slice(0, 100)]; }
function renderCalls() {
  const box = $('#cfilters'); const c = ui.cc; const all = callRows();
  if (!box.contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') box.innerHTML = all.length ? `<input type="search" id="cq" placeholder="Search names and extensions…" value="${esc(c.q)}" aria-label="Search calls">
    <div class="chips">${[['all', 'All'], ['missed', 'Missed'], ['answered', 'Answered']].map(([k, l]) => `<button class="chip${c.kind === k ? ' on' : ''}" data-ck="${k}">${l}</button>`).join('')}</div>` : '';
  const q = c.q.trim().toLowerCase();
  const rows = all.map((k, i) => ({ k, i })).filter(({ k }) => (c.kind === 'all' || (c.kind === 'missed' ? /missed|unavailable|busy|declined/.test(k.result) : k.result === 'answered'))
    && (!q || [k.from, k.fromName, k.to, k.toName, k.answeredBy].some((v) => String(v || '').toLowerCase().includes(q))));
  $('#calls').innerHTML = all.length ? `<table><thead><tr><th>When</th><th>Who called</th><th>Whom</th><th>Result</th><th>How long</th></tr></thead><tbody>${rows.map(({ k, i }) => `<tr data-crow="${i}" class="${c.cur === i ? 'cur' : ''}"><td>${esc(when(k.start))}</td><td>${who(k.from, k.fromName)}</td>
      <td>${who(k.live ? (k.answeredBy || k.to) : k.to, k.toName)}${!k.live && k.answeredBy && k.answeredBy !== k.to ? ` <span class="muted">(answered by ${esc(k.answeredBy)})</span>` : ''}</td><td>${k.live ? pill(k.result) : esc(T.result(k.result))}</td><td>${esc(T.duration(k.duration))}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">No calls match.</td></tr>'}</tbody></table>` : '<div class="empty"><p>No calls yet.</p></div>';
  const p = $('#cpanel'); const k = all[c.cur];
  if (!k) { p.hidden = true; $('#csplit').classList.remove('open'); return; }
  p.hidden = false; $('#csplit').classList.add('open');
  p.innerHTML = `<div class="sh"><div><h3>${esc(k.fromName || k.from)} → ${esc(k.toName || k.to)}</h3><small>${esc(when(k.start))}</small></div><button class="x" data-a="closecall" aria-label="Close">✕</button></div>
    <dl class="kv"><dt>Result</dt><dd>${esc(k.live ? k.result : T.result(k.result))}</dd><dt>Who called</dt><dd>${who(k.from, k.fromName)}</dd><dt>Whom</dt><dd>${who(k.to, k.toName)}</dd>
      ${k.answeredBy ? `<dt>Answered by</dt><dd>${esc(k.answeredBy)}</dd>` : ''}<dt>How long</dt><dd>${esc(T.duration(k.duration) || '—')}</dd></dl>
    <p class="hint">Calls are kept on this PC only (90 days). Nothing about them is sent online.</p>
    <div class="acts2">${k.from ? `<button class="btn s sm" data-person="${esc(k.from)}">${esc(k.fromName || k.from)} on People</button>` : ''}${k.to ? `<button class="btn s sm" data-person="${esc(k.to)}">${esc(k.toName || k.to)} on People</button>` : ''}</div>`;
}
function renderAccount() {
  const s = S.sync;
  const line = S.teamSyncedAt ? `People and ring groups came from Riyeser Link, last brought in ${esc(when(S.teamSyncedAt))}. They're kept on this PC, so the phones work without the internet.` : 'Sign in to your Riyeser account to bring in your team: their names, extensions and branches.';
  $('#account').innerHTML = `<p>${line}</p>${s && s.status === 'offline' ? `<p class="muted">${esc(s.error)}</p>` : ''}${s && s.status === 'local' ? `<p class="muted">${esc(s.why)}</p>` : ''}
    <p class="muted">${esc(T.cloud(S.cloud))}</p>
    <div class="row"><button class="btn s" data-a="sync">Bring in people from Riyeser Link now</button><button class="btn s" data-a="report">Send phone details to Riyeser Link now</button>${S.signedIn ? '<button class="btn s sm" data-a="signout">Sign out of Riyeser here</button>' : ''}</div>
    ${S.signedIn ? '' : `<form id="signin" class="row"><input id="em" type="email" placeholder="Riyeser account email" autocomplete="username"><input id="pw" type="password" placeholder="Password" autocomplete="current-password"><button class="btn">Sign in</button></form>
      <p class="muted">Already signed in on Riyeser Central? Riyeser Link Office uses that too when it can.</p>`}`;
}
function renderHistory() {
  const h = S.history || [];
  $('#history').innerHTML = h.length ? `<div class="tbox" style="max-height:320px"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${h.map((x) => `<tr style="cursor:default"><td>${esc(when(x.at))}</td><td>${esc(x.by)}</td><td style="white-space:normal;min-width:260px">${esc(x.what)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">No changes yet.</p>';
}
// ---------- Settings → Connect your branches: the Riyeser relay's status and diagnostics
function renderRelay() {
  const r = S.relay || { state: 'local' };
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const intro = r.connected ? T.relayLine(r) : T.relayTile(r).text;   // not set up, or the problem and its fix
  const sites = (r.sites || []).map((x) => `<li><span class="sitetag">${esc(x.name)}</span> <span class="muted">· ${esc(x.exts)} extension${x.exts === 1 ? '' : 's'} connected${x.via && x.via !== 'here' ? ` · through ${esc(x.via)}` : ''}</span></li>`).join('');
  $('#relay').innerHTML = `<p class="muted">${esc(T.RELAY_WHY)}</p><p><b>${esc(intro)}</b></p>
    ${r.connected && r.udp === 'blocked' ? `<div class="note warn">${esc(T.RELAY_UDP_BLOCKED)}</div>` : ''}
    ${sites ? `<p><b>Other sites</b></p><ul class="sites">${sites}</ul>` : ''}
    <form id="sitename" class="row"><label style="flex:1 1 260px"><span class="muted small">${esc(T.RELAY_SITE_NAME)}</span><input id="sitenamein" value="${esc(S.siteName || '')}" maxlength="40" autocomplete="off"></label><button class="btn s">Save</button></form>
    <details class="help"><summary>Diagnostics</summary><dl class="kv">
      ${row('State', esc(r.state || '—'))}${row('Relay', r.relay ? `${esc(r.relay)} (${esc(r.region || '')})${r.backup ? ' <span class="pill wait">backup</span>' : ''}` : '—')}
      ${row('Round trip', r.rtt != null ? `${esc(r.rtt)} ms` : '—')}${row('Sound (UDP)', esc(T.udp(r.udp)))}
      ${row('Connected since', r.since ? esc(when(r.since)) : '—')}${row('Reconnects', esc(r.reconnects || 0))}
      ${row('Relays (in order)', (r.relays || []).map((x) => `${esc(x.id)} ${esc(x.region)}`).join(' → ') || '—')}
      ${row('Reachable through it', `${esc(r.remote || 0)} extension(s), ${esc(r.phones || 0)} phone(s) at home`)}
      ${row('Last problem', esc(r.error || 'none'))}</dl></details>
    <div class="row"><button class="btn s" data-a="relayretry">Reconnect now</button><button class="btn s" data-a="web">Sites and the relay on the website</button></div>
    ${S.platform === 'win32' ? relayHostHtml() : ''}`;
  if (S.platform === 'win32' && relayHost === undefined) { relayHost = null; bridge.call('link:relay-host-state').then((h) => { relayHost = h || { installed: false }; part('connect your branches', renderRelay, '#relay'); }).catch(() => { relayHost = { installed: false }; }); }
}
// ---------- the head office PC can run the Riyeser relay itself (install-relay.ps1, with Windows' permission prompt)
let relayHost;
function relayHostHtml() {
  const h = relayHost;
  if (h && h.health && h.health.ok) return `<details class="help" open><summary>${esc(T.RELAY_HOST_TITLE)}</summary><p><b>${esc(T.relayHostOn(h.health))}</b></p><p class="muted small">${esc(T.RELAY_HOST_MORE)}</p></details>`;
  return `<details class="help"><summary>${esc(T.RELAY_HOST_TITLE)}</summary><p class="muted">${esc(T.RELAY_HOST_WHY)}</p>
    ${h && h.installed ? `<div class="note warn">${esc(T.RELAY_HOST_DOWN)}</div>` : ''}
    <form id="relayhost" class="row"><label style="flex:1 1 220px"><span class="muted small">Relay's name (DNS)</span><input id="rhdomain" value="relay.riyeser.com" autocomplete="off" spellcheck="false"></label>
      <label style="flex:1 1 160px"><span class="muted small">Where</span><input id="rhregion" value="Head office" maxlength="60" autocomplete="off"></label>
      <label style="flex:0 1 110px"><span class="muted small">Id</span><input id="rhid" value="suva1" maxlength="40" autocomplete="off" spellcheck="false"></label>
      <button class="btn s">Run the relay on this PC…</button></form></details>`;
}
// ---------- Settings → This PC's address: the adapter, names, what phones are given, reserve it, fixed address
function renderAddress() {
  const a = S.adapters.current; const n = S.names || {}; const f = S.fixedAddress;
  const hist = (S.addressChanges || []).map((c) => `<li>${esc(when(c.at))}: ${esc(c.from)} → ${esc(c.to)}</li>`).join('');
  $('#address').innerHTML = `<p class="muted">${esc(T.ADDR_WHY)}</p>
    <dl class="kv"><dt>Address</dt><dd><code>${esc(S.host)}</code> ${S.addressStable === false ? '<span class="pill bad">not stable</span>' : '<span class="pill ok">stable</span>'}</dd>
      <dt>Network adapter</dt><dd>${esc(a.name || '—')}${a.description ? ` <span class="muted">(${esc(a.description)})</span>` : ''}</dd>
      <dt>MAC address</dt><dd>${a.mac ? `<code>${esc(a.mac)}</code> <button class="btn s sm" data-copy="${esc(a.mac)}">Copy</button>` : '—'}</dd>
      <dt>Router</dt><dd>${a.gateway ? esc(a.gateway) : '—'}${a.dhcp === true ? ' · address from the router (automatic)' : a.dhcp === false ? ' · fixed address on this PC' : ''}</dd>
      <dt>Names</dt><dd><code>${esc(n.mdns || '')}</code>${n.router ? ` · <code>${esc(n.router)}</code>` : ''}</dd></dl>
    <fieldset class="mode"><legend>What desk phones are given</legend>
      <label><input type="radio" name="pmode" value="address"${n.mode !== 'name' ? ' checked' : ''}> ${esc(T.MODE_ADDRESS)}</label>
      ${n.router ? `<label><input type="radio" name="pmode" value="name"${n.mode === 'name' ? ' checked' : ''}> ${esc(T.modeName(n.router))}</label>` : `<p class="muted small">${esc(T.MODE_NONAME)}</p>`}
    </fieldset>
    <div class="row"><button class="btn" data-a="reserve">${esc(T.RESERVE_TITLE)}</button><button class="btn s" data-a="recheckaddr">Check the address now</button></div>
    <p class="muted small">${esc(T.OPTION66)} <code>http://${esc(S.host)}:${esc(S.httpPort)}/</code></p>
    ${hist ? `<p><b>Recent changes</b></p><ul class="hist">${hist}</ul>` : ''}
    ${S.platform === 'win32' ? `<details class="help fixed"><summary>${esc(T.FIXED_TITLE)}</summary><p class="muted">${esc(T.FIXED_WHY)}</p>
      ${f ? `<p>${esc(T.fixedOn(f))}</p><div class="row"><button class="btn s" data-a="undofixed">Undo: back to automatic</button></div>`
        : a.dhcp === true ? `<form id="fixedform" class="row"><input id="fixedip" value="${esc(S.host)}" spellcheck="false" autocomplete="off" style="flex:0 1 200px"><button class="btn s">Use this fixed address…</button></form>`
        : '<p class="muted">Not available for this adapter.</p>'}</details>` : ''}`;
}
/** The guided "Reserve this PC's address in your router" helper, in an in-page dialog. */
function reserveHelper() {
  const a = S.adapters.current; const d = document.createElement('dialog'); d.className = 'askform reserve';
  const brand = (() => { try { return localStorage.getItem('link.router') || 'tplink'; } catch { return 'tplink'; } })();
  const steps = (id) => { const r = T.ROUTERS.find((x) => x.id === id) || T.ROUTERS[0]; return `<ol>${r.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`; };
  d.innerHTML = `<form method="dialog"><h3>${esc(T.RESERVE_TITLE)}</h3><p>${esc(T.RESERVE_INTRO)}</p>
    <div class="reservebox"><div><small>This PC's MAC address</small><b><code>${esc(a.mac || '—')}</code></b>${a.mac ? `<button type="button" class="btn s sm" data-copy="${esc(a.mac)}">Copy</button>` : ''}</div>
      <div><small>Address to reserve</small><b><code>${esc(S.host)}</code></b><button type="button" class="btn s sm" data-copy="${esc(S.host)}">Copy</button></div>
      ${a.gateway ? `<div><small>Your router</small><b><code>${esc(a.gateway)}</code></b><button type="button" class="btn s sm" data-router="${esc(a.gateway)}">Open its page</button></div>` : ''}</div>
    <p><b>${esc(T.reserveWhat(a.mac, S.host))}</b></p>
    <label><span>Your router</span><select id="rbrand">${T.ROUTERS.map((r) => `<option value="${esc(r.id)}"${r.id === brand ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
    <div id="rsteps">${steps(brand)}</div><p class="muted">${esc(T.RESERVE_AFTER)}</p>
    <div class="row end"><button class="btn" value="ok">Done</button></div></form>`;
  d.querySelector('#rbrand').onchange = (e) => { d.querySelector('#rsteps').innerHTML = steps(e.target.value); try { localStorage.setItem('link.router', e.target.value); } catch { /* fine */ } };
  d.addEventListener('close', () => d.remove());
  document.body.appendChild(d); d.showModal();
}
function renderAdvanced() {
  const a = S.adapters;
  $('#advanced').innerHTML = `<p><b>Network adapter phones use.</b> This PC: ${esc(a.current.address)}${a.current.mac ? ` · MAC ${esc(a.current.mac)}` : ''}</p>
    <div class="row"><select id="adapter"><option value="">Choose automatically</option>${a.list.map((x) => `<option value="${esc(x.name)}"${a.current.chosen && a.current.name === x.name ? ' selected' : ''}>${esc(x.name)} (${esc(x.address)})</option>`).join('')}</select></div>
    <p><label><input type="checkbox" id="sww"${S.startWithWindows ? ' checked' : ''}> Start with Windows (needed so the phones work after a restart)</label></p>
    <p><label><input type="checkbox" id="pub"${S.allowPublic ? ' checked' : ''}> Allow phones from outside the office network (not recommended: it lets strangers try passwords)</label></p>
    <p><b>Settings file.</b> People, extensions, ring groups and phone assignments in one file, to move to a new PC or to Riyeser Link Cloud later. It holds the phones' passwords, so keep it safe.</p>
    <div class="row"><button class="btn s" data-a="export">Export settings</button><button class="btn s" data-a="import">Import settings</button><button class="btn s" data-a="logs">Open the log folder</button></div>
    <div class="row"><button class="btn s" data-a="backupnow">Back up now</button><button class="btn s" data-a="backuprestore">Restore from a backup…</button><button class="btn s" data-a="backupfolder">Open the backups folder</button></div>
    <p class="muted">A backup is made every day into Documents\\Riyeser\\Link Office\\Backups (the last 30 are kept). Desk phone passwords stay encrypted for this Windows account.</p>
    <p class="muted">Phones connect on port ${esc(S.sipPort)} (SIP) and fetch their settings from port ${esc(S.httpPort)}.</p>
    <div class="log">${S.logs.map((l) => `${esc(when(l.at))}  ${esc(l.text)}`).join('\n') || 'Nothing yet.'}</div>`;
}

// ---------- Add several phones: paste a list or import a CSV, check every row, fix it in place, then add them
const firstFree = () => B.nextFree(201, S.people.map((p) => p.ext).concat(S.groups.map((g) => g.ext)))[0] || '201';
function addMany() {
  if (!S) return;
  const d = document.createElement('dialog'); d.className = 'askform big';
  const st = { rows: [], mode: 'wait', start: firstFree(), done: false };
  const ctx = () => ({ phones: S.phones.map((x) => ({ mac: x.mac, ext: x.ext })), found: S.found.map((f) => ({ mac: f.mac })), people: S.people.map((p) => ({ ext: p.ext, name: p.name })),
    used: S.groups.map((g) => g.ext), start: st.start, auto: st.mode === 'auto', shared: st.mode === 'auto' });
  const draw = () => {
    const pv = B.preview(st.rows, ctx()); const c = pv.counts;
    const badge = (r) => (r.state === 'ok' ? '<span class="pill ok">OK</span>' : r.state === 'warn' ? '<span class="pill wait">Check</span>' : r.state === 'skip' ? '<span class="pill">Skip</span>' : '<span class="pill bad">Fix</span>');
    d.querySelector('#bmprev').innerHTML = st.rows.length ? `<div class="tbox"><table><thead><tr><th>#</th><th>MAC address</th><th>Model or maker</th><th>Ext.</th><th>Person</th><th>Phone name</th><th>Location</th><th>Check</th><th></th></tr></thead><tbody>
      ${pv.rows.map((r, i) => `<tr data-i="${i}"><td class="muted">${i + 1}</td><td><input class="macin mono" data-f="macText" value="${esc(r.macText)}" aria-label="MAC address, row ${i + 1}"></td>
        <td><input data-f="model" value="${esc(r.model)}" placeholder="${esc(r.vendorName || 'Not known')}" aria-label="Model or maker, row ${i + 1}"></td>
        <td><input data-f="ext" value="${esc(st.rows[i].ext)}" placeholder="${esc(r.ext || '—')}" inputmode="numeric" maxlength="3" style="min-width:64px" aria-label="Extension, row ${i + 1}"></td>
        <td><input data-f="person" value="${esc(st.rows[i].person)}" list="bmppl" placeholder="${esc(r.person ? r.person.name : '')}" aria-label="Person, row ${i + 1}"></td>
        <td><input data-f="name" value="${esc(r.name)}" maxlength="40" aria-label="Phone name, row ${i + 1}"></td><td><input data-f="location" value="${esc(r.location)}" maxlength="60" aria-label="Location, row ${i + 1}"></td>
        <td class="st">${badge(r)}${r.vendorName ? `<b>${esc(r.vendorName)}</b>` : ''}${r.ext ? `${r.vendorName ? ' · ' : ''}ext. <b>${esc(r.ext)}</b>${r.person ? ` (${esc(r.person.name)})` : r.newExt ? ` (new: ${esc(r.extName)})` : ''}` : ''}${r.notes.length ? `<br><span class="muted">${esc(r.notes.join(' · '))}</span>` : ''}</td>
        <td><button type="button" class="btn s sm" data-del="${i}" aria-label="Remove row ${i + 1}">✕</button></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted" style="margin:4px 0">Paste MAC addresses above, or import a CSV. Each row is checked here before anything is added.</p>';
    if (!st.done) d.querySelector('#bmsum').textContent = st.rows.length ? `${plural(c.add, 'phone')} to add${c.skip ? ` · ${c.skip} skipped (already added or twice in the list)` : ''}${c.error ? ` · ${c.error} to fix` : ''}${c.warn ? ` · ${c.warn} to check` : ''}` : '';
    const go = d.querySelector('#bmgo'); go.disabled = !c.add; go.textContent = c.add ? `Add ${plural(c.add, 'phone')}` : 'Add phones';
  };
  d.innerHTML = `<form method="dialog"><h3>Add several phones</h3>
    <p class="muted" style="margin:0">Paste MAC addresses, one per line, in any format (001565aabbcc, 00:15:65:AA:BB:CC, 00-15-65-…), or import a CSV with the columns MAC address, model or maker, extension, person (name or email), phone name and location. Only the MAC is needed.</p>
    <textarea id="bmtext" spellcheck="false" placeholder="00:15:65:12:34:56&#10;000B82123457&#10;00-04-F2-AA-BB-CC" aria-label="MAC addresses or CSV"></textarea>
    <div class="row" style="margin:0"><button type="button" class="btn s sm" id="bmimport">Import a CSV…</button><button type="button" class="btn s sm" id="bmtpl">Download the CSV template</button><span class="muted small">The list is checked as you type.</span></div>
    <div class="opts"><b>Phones with no person or extension:</b>
      <label><input type="radio" name="bmmode" value="wait" checked> wait under New (give them out later)</label>
      <label><input type="radio" name="bmmode" value="auto"> each gets a new extension from <input class="n" id="bmstart" value="${esc(st.start)}" inputmode="numeric" maxlength="3" aria-label="First extension"> up</label></div>
    <datalist id="bmppl">${S.people.map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>
    <div id="bmprev"></div>
    <div class="row end" style="margin:0"><span class="sum grow" id="bmsum" role="status"></span><button type="button" class="btn s" value="no">Close</button><button type="button" class="btn" id="bmgo" disabled>Add phones</button></div></form>`;
  const parse = () => { st.rows = B.parseInput(d.querySelector('#bmtext').value).rows; st.done = false; draw(); };
  d.querySelector('#bmtext').addEventListener('input', () => { clearTimeout(parse.t); parse.t = setTimeout(parse, 300); });
  d.querySelector('#bmimport').onclick = async () => { const f = await safe(() => bridge.call('link:openFile', ['csv', 'txt'])); if (f) { d.querySelector('#bmtext').value = f.text; parse(); toast(`Read ${f.name}.`); } };
  d.querySelector('#bmtpl').onclick = async () => { const p = await safe(() => bridge.call('link:saveTemplate')); if (p) toast(`Template saved: ${p.split(/[\\/]/).pop()}`); };
  d.querySelectorAll('[name=bmmode]').forEach((r) => { r.onchange = () => { st.mode = d.querySelector('[name=bmmode]:checked').value; draw(); }; });
  d.querySelector('#bmstart').oninput = (e) => { st.start = e.target.value.replace(/\D/g, ''); draw(); };
  d.addEventListener('change', (e) => { const i = e.target.closest('tr[data-i]'); if (!i || !e.target.dataset.f) return; st.rows[Number(i.dataset.i)][e.target.dataset.f] = e.target.value; st.done = false; draw(); });
  d.addEventListener('click', (e) => { const x = e.target.closest('[data-del]'); if (x) { st.rows.splice(Number(x.dataset.del), 1); draw(); } });
  d.querySelector('[value=no]').onclick = () => d.close();
  d.querySelector('#bmgo').onclick = async () => {
    const go = d.querySelector('#bmgo'); go.disabled = true; go.textContent = 'Adding…';
    const r = await safe(() => bridge.call('link:bulkAdd', st.rows, { start: st.start, auto: st.mode === 'auto', shared: st.mode === 'auto' }));
    if (!r) { draw(); return; }
    toast(r.summary);
    const added = new Set(r.added.map((x) => x.mac)); st.rows = st.rows.filter((x) => !added.has(B.normaliseMac(x.macText)));
    d.querySelector('#bmtext').value = ''; await load(); st.done = true; draw();
    d.querySelector('#bmsum').textContent = `${r.summary}${st.rows.length ? ' The rows left below were not added.' : ''}`;
  };
  d.addEventListener('close', () => { d.remove(); load(); });
  document.body.appendChild(d); d.showModal(); d.querySelector('#bmtext').focus(); draw();
}
// ---------- Give to…: each ticked new phone to a person, or new extensions numbered in order
function giveMany(macs) {
  const list = phoneRows().filter((r) => macs.includes(r.mac) && r.kind !== 'phone');
  if (!list.length) { toast('Tick new phones to give out.'); return; }
  const d = document.createElement('dialog'); d.className = 'askform'; d.style.width = 'min(640px, calc(100% - 32px))';
  d.innerHTML = `<form method="dialog"><h3>Give ${plural(list.length, 'phone')} to…</h3>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="radio" name="gm" value="each" checked style="width:auto;flex:none"> <span>Choose a person for each</span></label>
    <div class="givelist">${list.map((r) => `<div class="gr"><span><b>${esc(r.name || r.vendorName || 'New phone')}</b> <span class="mono muted">${esc(r.macText)}</span>${r.ip ? ` <span class="muted">· ${esc(r.ip)}</span>` : ''}</span>
      <select data-to="${esc(r.mac)}" aria-label="Who ${esc(r.macText)} is for">${personOptions('')}</select></div>`).join('')}</div>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="radio" name="gm" value="auto" style="width:auto;flex:none"> <span>Give each its own new extension, in order, from</span> <input name="start" value="${esc(firstFree())}" maxlength="3" inputmode="numeric" style="width:70px;flex:none" aria-label="First extension"> <span>up</span></label>
    <p class="muted small" style="margin:0">New extensions are named after each phone (its name or location), or "Phone 201".</p>
    <div class="row end"><button type="button" class="btn s" value="no">Cancel</button><button class="btn" value="yes">Give them out</button></div></form>`;
  d.querySelector('[value=no]').onclick = () => d.close();
  d.querySelector('[name=start]').onfocus = () => { d.querySelector('[name=gm][value=auto]').checked = true; };
  d.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const auto = d.querySelector('[name=gm]:checked').value === 'auto';
    const to = {}; d.querySelectorAll('[data-to]').forEach((s) => { if (s.value) to[s.dataset.to] = s.value; });
    if (!auto && !Object.keys(to).length) { toast('Choose who each phone is for, or give them new extensions in order.'); return; }
    const r = await safe(() => bridge.call('link:bulk', 'give', list.map((x) => x.mac), auto ? { auto: true, start: d.querySelector('[name=start]').value } : { to }));
    if (r) { toast(r.summary); ui.ph.sel.clear(); d.close(); }
  };
  d.addEventListener('close', () => { d.remove(); load(); });
  document.body.appendChild(d); d.showModal();
}
async function bulkAction(a) {
  if (a === 'clear') { ui.ph.sel.clear(); renderPhones(); return; }
  const macs = [...ui.ph.sel]; if (!macs.length) return;
  if (a === 'give') { giveMany(macs); return; }
  let opts = {};
  if (a === 'location') {
    const f = await askForm(`Move ${plural(macs.length, 'phone')}`, 'Their new location (a branch, a floor or a room). Leave it empty to clear it.', [{ name: 'location', label: 'Location', value: '', max: 60, list: [...new Set(phoneRows().map((r) => r.location).filter(Boolean))] }], 'Move');
    if (!f) return; opts = { location: f.location };
  }
  const ask = { remove: [`Remove ${plural(macs.length, 'phone')}? Phones given to someone stop getting their settings, and all of them leave the list. A removed phone that asks again shows up as New.`, 'Remove'],
    unassign: [`Take back ${plural(macs.length, 'phone')}? They stop getting their settings (they keep what they have until reset). To lock them out, also make new passwords for their people.`, 'Take back'],
    restart: [`Restart ${plural(macs.length, 'phone')}? Calls on them are cut off.`, 'Restart'],
    shared: [`Add ${plural(macs.length, 'phone')} as shared phones? Each gets its own new extension, named after the phone (or its location), like Reception or Meeting room.`, 'Add as shared'] }[a];
  if (ask && !(await askYes(ask[0], ask[1], a === 'remove'))) return;
  const r = await safe(() => bridge.call('link:bulk', a, macs, a === 'shared' ? { start: firstFree() } : opts));
  if (r) { toast(r.summary); if (['remove', 'ignore', 'shared', 'unassign', 'unignore'].includes(a)) ui.ph.sel.clear(); load(); }
}
async function phoneAction(a) {
  const r = phoneRows().find((x) => x.mac === ui.ph.cur); if (!r) return;
  if (a === 'web') { await safe(() => bridge.call('link:openPhonePage', r.ip)); return; }
  if (a === 'find') { if (await safe(() => bridge.call('link:findPhone', r.mac))) toast(`${rowTitle(r)} is ringing for 5 seconds.`); load(); return; }
  if (a === 'restart' || a === 'resync') { if (await safe(() => bridge.call('link:restartPhone', r.mac, a === 'restart'))) toast(a === 'restart' ? 'Asked the phone to restart. It\'s back in about a minute.' : 'Asked the phone to fetch its settings again.'); load(); return; }
  if (a === 'unassign' && !(await askYes('Take this phone back? It stops getting its settings (it keeps what it has until it\'s reset). To lock it out, make a new password for its person.', 'Take back'))) return;
  if (a === 'remove' && !(await askYes('Remove this phone from the list? If it asks for its settings again, it shows up as New.', 'Remove', true))) return;
  const res = await safe(() => bridge.call('link:bulk', a, [r.mac], {}));
  if (res) { toast(res.summary); if (a === 'remove') ui.ph.cur = null; load(); }
}

function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
  try { localStorage.setItem('link.tab', name); } catch { /* fine */ }
}
// Each part is drawn on its own: a problem in one shows there and never leaves the rest of the screen empty.
function part(name, fn, box) {
  try { fn(); } catch (e) {
    const el = box && $(box); if (el) { el.hidden = false; el.innerHTML = `<p class="note warn">This part couldn't be shown (${esc(e.message)}). The phones keep working.</p>`; }
    if (window.console) console.error(`Riyeser Link Office: ${name}:`, e);
  }
}
function render() {
  if (!S) return;
  for (const k of ['found', 'ignored', 'phones', 'people', 'groups', 'recent', 'inProgress', 'logs']) if (!Array.isArray(S[k])) S[k] = [];
  part('status', renderState, '#state'); part('notices', renderNotices, '#notices'); part('setup', renderSetup, '#setup'); part('overview', renderOverview, '#tiles'); part('address', renderHero, '#hero');
  if (!$('#manualbox').hidden) part('by hand', renderHand, '#manualout');
  part('phone filters', renderPhoneFilters, '#phfilters'); part('phones', renderPhones, '#phones'); part('phone', renderPhonePanel, '#phpanel'); part('new phones', renderFound, '#found');
  part('people', renderPeople, '#people'); part('ring groups', renderGroups, '#groups');
  part('calls', renderCalls, '#calls'); part('account', renderAccount, '#account'); part('history', renderHistory, '#history');
  if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('#relay')) part('connect your branches', renderRelay, '#relay');
  if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('#address')) part('this PC\'s address', renderAddress, '#address');
  if (!document.querySelector('.adv').open) part('advanced', renderAdvanced, '#advanced');
}
// Before the first answer: a plain "Starting…" (never an empty card). If the phone system doesn't answer, say so here
// and keep asking every few seconds; the menu works all along.
let loadFails = 0; let retry = null;
function renderLoading(err) {
  const el = $('#state'); el.hidden = false;
  if (!err) { el.className = 'state wait'; el.innerHTML = '<div class="grow"><b class="big">Starting Riyeser Link Office…</b><span class="muted">Getting the phone system\'s status.</span></div>'; return; }
  el.className = 'state bad';
  el.innerHTML = `<div class="grow"><b class="big">Riyeser Link Office's status couldn't be read</b><span class="muted">${esc(err)} Trying again by itself.</span></div><button class="btn s" data-a="reload">Try again</button>`;
}
async function load() {
  let s = null; let err = null;
  try { s = await Promise.race([bridge.call('link:status'), new Promise((_, no) => setTimeout(() => no(new Error('The phone system didn\'t answer in time.')), 15000))]); } catch (e) { err = e.message || String(e); }
  clearTimeout(retry);
  if (s) { loadFails = 0; S = s; render(); return; }
  loadFails++;
  if (!S) renderLoading(err); else if (loadFails > 1) toast(err);
  retry = setTimeout(load, Math.min(3000 * loadFails, 15000));
}
let pending = null;
bridge.on('link:changed', () => { clearTimeout(pending); pending = setTimeout(load, 150); });
document.querySelector('.adv').addEventListener('toggle', () => { if (S) renderAdvanced(); });
// don't redraw the people list under someone who's typing in it
document.addEventListener('focusin', (e) => { busy = !!(e.target.closest && e.target.closest('#addperson')); });
document.addEventListener('focusout', () => { busy = false; });
const openPerson = (ext) => { showTab('people'); ui.pp.cur = ext; if (S) renderPeople(); };

document.addEventListener('click', async (e) => {
  // a click on a row (not on its tick box or a button) opens it in the panel on the right
  const row = e.target.closest && e.target.closest('tr[data-row],tr[data-prow],tr[data-crow]');
  if (row && !e.target.closest('input,button,a,label')) {
    if (row.dataset.row) { ui.ph.cur = ui.ph.cur === row.dataset.row ? null : row.dataset.row; renderPhones(); renderPhonePanel(); }
    if (row.dataset.prow) { ui.pp.cur = ui.pp.cur === row.dataset.prow ? null : row.dataset.prow; renderPeople(); }
    if (row.dataset.crow) { const i = Number(row.dataset.crow); ui.cc.cur = ui.cc.cur === i ? null : i; renderCalls(); }
    return;
  }
  const th = e.target.closest && e.target.closest('th[data-sort]');
  if (th) { const k = th.dataset.sort; if (ui.ph.sort === k) ui.ph.dir *= -1; else { ui.ph.sort = k; ui.ph.dir = 1; } renderPhones(); return; }
  const b = e.target.closest && e.target.closest('button'); if (!b) return;
  const d = b.dataset || {};
  if (d.copy != null) { await safe(() => bridge.call('link:copy', d.copy)); toast('Copied.'); return; }
  if (d.router) { await safe(() => bridge.call('link:openRouter', d.router)); return; }
  if (d.bulk) { await bulkAction(d.bulk); return; }
  if (d.pa) { b.disabled = true; try { await phoneAction(d.pa); } finally { b.disabled = false; } return; }
  if (d.ck) { ui.cc.kind = d.ck; ui.cc.cur = null; renderCalls(); return; }
  if (d.person) { openPerson(d.person); return; }
  if (d.openphone) { showTab('phones'); ui.ph.cur = d.openphone; renderPhones(); renderPhonePanel(); return; }
  if (d.manual) { if (shown[d.manual]) delete shown[d.manual]; else shown[d.manual] = await safe(() => bridge.call('link:manual', d.manual)); renderPeople(); return; }
  if (d.manual2) { openPerson(d.manual2); if (!shown[d.manual2]) shown[d.manual2] = await safe(() => bridge.call('link:manual', d.manual2)); renderPeople(); return; }
  if (d.replace) { const x = S.phones.find((p) => p.mac === d.replace); if (!x) return;
    const fields = [{ name: 'mac', label: 'The new phone', type: 'select', value: '', options: [['', 'Type its MAC address below'], ...S.found.map((f) => [f.mac, `New phone found: ${f.vendorName} ${f.model || ''} · ${f.macText}`])] },
      { name: 'typed', label: 'MAC address (on the label under the phone)', value: '', max: 20, placeholder: 'e.g. 00:15:65:12:34:56' }];
    fields.preview = `${T.REPLACE_PREVIEW(x.macText)} The new phone keeps extension ${x.ext}${x.label ? `, the name ${x.label}` : ''}${x.location ? ` and the location ${x.location}` : ''}.`;
    const f = await askForm(`Replace ${x.label || 'this phone'}`, `Now: ${x.vendorName} ${x.model || ''} · ${x.macText} · extension ${x.ext}`, fields, 'Replace phone');
    if (!f) return; const mac = f.mac || f.typed; if (!mac) { toast('Choose the new phone, or type its MAC address.'); return; }
    if (await safe(() => bridge.call('link:replace', x.mac, mac))) { toast('Replaced. Plug in the new phone: it sets itself up in a minute.'); ui.ph.cur = B.normaliseMac(mac); } load(); return; }
  if (d.reveal) { shown[d.reveal].reveal = !shown[d.reveal].reveal; renderPeople(); return; }
  if (d.handreveal) { hand.reveal = !hand.reveal; renderHand(); return; }
  if (d.reset) { const m = await safe(() => bridge.call('link:resetPassword', d.reset)); if (m) { shown[d.reset] = { ...m, reveal: true };
    if (hand && hand.ext === d.reset) hand = { ext: d.reset, details: m, reveal: true }; renderPeople(); renderHand(); toast('New password made. Restart desk phones set up by Riyeser Link Office so they get it.'); } return; }
  if (d.tab) { showTab(d.tab); return; }
  if (d.remove) { if (await askYes('Take this person off the phones? Their call history stays.', 'Take them off')) { await safe(() => bridge.call('link:removePerson', d.remove)); ui.pp.cur = null; load(); } return; }
  const a = d.a; if (!a) return;
  const filter = (st) => { showTab('phones'); Object.assign(ui.ph, { status: st, q: '', vendor: '', location: '', assigned: '' }); renderPhoneFilters(); renderPhones(); renderFound(); };
  const local = /^(f-|close|sos|addmany|givenew|showoffline|phclear|calls|people|reload|reserve|setupopen|step-|hand|addphone)/.test(a);
  b.disabled = true;
  try {
    if (a === 'reload') { renderLoading(); load(); return; }
    if (a === 'sosshow') { $('#sos').hidden = false; $('#soschip').hidden = true; try { sessionStorage.removeItem('link.sos'); } catch { /* fine */ } return; }
    if (a === 'soshide') { $('#sos').hidden = true; $('#soschip').hidden = false; try { sessionStorage.setItem('link.sos', '1'); } catch { /* fine */ } return; }
    if (a.startsWith('f-')) { filter(a.slice(2)); return; }
    if (a === 'showoffline') { filter('Offline'); return; }
    if (a === 'phclear') { filter('all'); return; }
    if (a === 'calls' || a === 'callsmissed') { showTab('calls'); ui.cc.kind = a === 'callsmissed' ? 'missed' : 'all'; renderCalls(); return; }
    if (a === 'people') { showTab('people'); return; }
    if (a === 'givenew') { showTab('phones'); giveMany(S.found.map((f) => f.mac)); return; }
    if (a === 'addmany') { addMany(); return; }
    if (a === 'closepanel') { ui.ph.cur = null; renderPhones(); renderPhonePanel(); return; }
    if (a === 'closeperson') { ui.pp.cur = null; renderPeople(); return; }
    if (a === 'closecall') { ui.cc.cur = null; renderCalls(); return; }
    if (a === 'team') await safe(() => bridge.call('link:openTeam'));
    if (a === 'web') await safe(() => bridge.call('link:openPhonesPage'));
    if (a === 'rings') await safe(() => bridge.call('link:openRingGroups'));
    if (a === 'relay') { showTab('settings'); const rp = $('#relaypanel'); if (rp && rp.scrollIntoView) rp.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (a === 'relayretry') { await safe(() => bridge.call('link:relay-retry')); toast('Reconnecting to the Riyeser relay…'); }
    if (a === 'report') { const r = await safe(() => bridge.call('link:report')); if (r) toast(r.ok ? 'Sent to Riyeser Link.' : r.error); }
    if (a === 'setupopen') { setupOpen = !setupOpen; renderSetup(); }
    if (a === 'step-signin') { showTab('settings'); const em = $('#em'); if (em) em.focus(); }
    if (a === 'step-addphone') { showTab('phones'); const dd = $('#addphone'); dd.open = true; dd.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (a === 'step-found') filter('New');
    if (a === 'hand') { showTab('phones'); const box = $('#manualbox'); box.hidden = !box.hidden; if (!box.hidden) { renderHand(); box.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#manualwho').focus(); } }
    if (a === 'addphone') { showTab('phones'); const dd = $('#addphone'); dd.open = true; dd.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#mac').focus(); }
    if (a === 'recheck') { await safe(() => bridge.call('link:recheck')); toast(S && S.state === 'running' ? 'Riyeser Link Office is on.' : 'Checked.'); }
    if (a === 'sync') { const r = await safe(() => bridge.call('link:sync')); if (r) toast(r.status === 'synced' ? `Brought in ${r.people} people.` : (r.error || r.why)); }
    if (a === 'signout') await safe(() => bridge.call('link:signOut'));
    if (a === 'firewall') { const ok = await safe(() => bridge.call('link:firewall')); toast(ok ? 'Phones are allowed through the firewall.' : 'The firewall rule wasn\'t added. Try again and choose Yes when Windows asks.'); }
    if (a === 'dismissip') await safe(() => bridge.call('link:dismissIp'));
    if (a === 'reserve') reserveHelper();
    if (a === 'recheckaddr') { const n = await safe(() => bridge.call('link:recheckAddress')); if (n) toast(`Checked: this PC is ${S.host}${n.router ? ` (${n.router})` : ''}.`); }
    if (a === 'undofixed') { const r = await safe(() => bridge.call('link:undoFixed')); if (r) toast(r.ok ? 'Back on automatic.' : 'Nothing was changed.'); }
    if (a === 'export') { const f = await safe(() => bridge.call('link:export')); if (f) toast('Settings saved. Keep the file safe: it holds the phones\' passwords.'); }
    if (a === 'import') { const r = await safe(() => bridge.call('link:import')); if (r) toast(`Imported ${r.people} people, ${r.groups} groups and ${r.phones} phones.`); }
    if (a === 'logs') await safe(() => bridge.call('link:openLogs'));
    if (a === 'backupnow') { const f = await safe(() => bridge.call('backup:now')); if (f) toast(`Backed up: ${f.split(/[\\/]/).pop()}`); }
    if (a === 'backuprestore') await safe(() => bridge.call('backup:restore'));
    if (a === 'backupfolder') await safe(() => bridge.call('backup:folder'));
  } finally { b.disabled = false; if (!local) load(); }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'phq') { ui.ph.q = t.value; renderPhones(); }
  if (t.id === 'pq') { ui.pp.q = t.value; renderPeople(); }
  if (t.id === 'cq') { ui.cc.q = t.value; renderCalls(); }
});
document.addEventListener('change', async (e) => {
  const t = e.target; const ds = t.dataset || {};
  if (t.id === 'phst') { ui.ph.status = t.value; renderPhones(); renderFound(); }
  if (t.id === 'phvd') { ui.ph.vendor = t.value; renderPhones(); }
  if (t.id === 'phloc') { ui.ph.location = t.value; renderPhones(); }
  if (t.id === 'phas') { ui.ph.assigned = t.value; renderPhones(); }
  if (t.id === 'phall') { const rows = filtered(); if (t.checked) rows.forEach((r) => ui.ph.sel.add(r.mac)); else rows.forEach((r) => ui.ph.sel.delete(r.mac)); renderPhones(); }
  if (ds.pick) { if (t.checked) ui.ph.sel.add(ds.pick); else ui.ph.sel.delete(ds.pick); renderPhones(); }
  if (t.name === 'to' && t.closest && t.closest('#pmove')) { const i = t.closest('#pmove').querySelector('[name=shared]'); i.hidden = t.value !== '+shared'; if (!i.hidden) i.focus(); }
  if (ds.dnd) { await safe(() => bridge.call('link:dnd', ds.dnd, t.checked)); load(); }
  if (t.id === 'manualwho') { hand = t.value ? { ext: t.value, details: await safe(() => bridge.call('link:manual', t.value)), reveal: false } : null; renderHand(); }
  if (t.id === 'adapter') { await safe(() => bridge.call('link:adapter', t.value)); load(); }
  if (t.name === 'pmode') { const n = await safe(() => bridge.call('link:phoneAddress', t.value)); if (n) toast(n.useName ? `Desk phones now get ${n.server}. They pick it up as they restart.` : `Desk phones now get ${n.server}.`); load(); }
  if (t.id === 'sww') await safe(() => bridge.call('link:startWithWindows', t.checked));
  if (t.id === 'pub') await safe(() => bridge.call('link:allowPublic', t.checked));
});
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; const v = Object.fromEntries(new FormData(f)); const done = () => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); load(); };
  if (f.id === 'pname') { if (await safe(() => bridge.call('link:label', f.dataset.mac, { name: v.name, location: v.location, note: v.note || '' }))) toast('Saved.'); done(); }
  if (f.id === 'pmove') {
    if (!v.to) { toast('Choose who the phone is for.'); return; }
    if (v.to === '+shared' && !String(v.shared || '').trim()) { toast('Type a name for the shared phone, like Reception.'); return; }
    if (await safe(() => bridge.call('link:movePhone', f.dataset.mac, v.to === '+shared' ? { sharedName: v.shared } : { ext: v.to }))) toast('Done. The phone picks it up when it next fetches its settings (restart it to do it now).');
    done();
  }
  if (f.id === 'psform') {
    const go = e.submitter && e.submitter.value;
    const keys = []; for (let i = 0; i < 12; i++) if (v[`kv${i}`]) keys.push({ value: v[`kv${i}`], label: v[`kl${i}`] || '' });
    const s = { label: v.label, displayName: v.displayName, timezone: v.timezone, timeFormat: v.timeFormat, language: v.language, ringtone: v.ringtone, ringVolume: v.ringVolume, dnd: v.dnd, lineKeys: keys };
    const r = await safe(() => bridge.call('link:phoneSettings', f.dataset.mac, s));
    if (r) {
      if (go === 'restart') { const ok = await safe(() => bridge.call('link:restartPhone', f.dataset.mac, true)); toast(ok ? 'Saved. The phone restarts and picks up its new settings.' : 'Saved. It applies when the phone next starts.'); }
      else toast('Saved. The phone picks these up when it next fetches its settings.');
    }
    done();
  }
  if (f.id === 'personform') {
    const r = await safe(() => bridge.call('link:addPerson', $('#pname').value, $('#pext').value.trim() || null));
    if (r) { toast(`${r.name} is extension ${r.ext}.`); busy = false; $('#addperson').innerHTML = ''; load(); }
  }
  if (f.id === 'macform') {
    const ext = $('#macwho').value; if (!ext) { toast('Choose who the phone is for.'); return; }
    const r = await safe(() => bridge.call('link:assign', $('#mac').value, ext));
    if (r) { $('#mac').value = ''; toast('Added. Turn the phone on (or restart it) and it sets itself up.'); load(); }
  }
  if (f.id === 'relayhost') {
    toast('Windows will ask for permission…');
    const r = await safe(() => bridge.call('link:relay-host', { domain: $('#rhdomain').value.trim(), region: $('#rhregion').value.trim(), id: $('#rhid').value.trim() }));
    relayHost = undefined;
    if (r) { toast(r.ok ? T.RELAY_HOST_DONE : `The relay wasn't set up: ${r.out || 'cancelled'}`); load(); }
  }
  if (f.id === 'sitename') {
    const n = await safe(() => bridge.call('link:site-name', $('#sitenamein').value));
    if (n) { toast(`The other sites see this office as ${n}.`); $('#sitenamein').blur(); load(); }
  }
  if (f.id === 'fixedform') {
    const r = await safe(() => bridge.call('link:fixedAddress', $('#fixedip').value.trim()));
    if (r) toast(r.ok ? `This PC now keeps ${r.address}.` : r.why === 'in-use' ? 'Another device already uses that address. Nothing was changed.' : r.why === 'no-router' ? 'The router couldn\'t be reached with that address, so it went back to automatic.' : 'Nothing was changed.');
    load();
  }
  if (f.id === 'signin') {
    const r = await safe(() => bridge.call('link:signIn', $('#em').value, $('#pw').value));
    if (r) toast(r.status === 'synced' ? `Signed in. Brought in ${r.people} people.` : 'Signed in.');
    load();
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { if (ui.ph.cur) { ui.ph.cur = null; renderPhones(); renderPhonePanel(); } else if (ui.pp.cur) { ui.pp.cur = null; renderPeople(); } } });
try { if (sessionStorage.getItem('link.sos') === '1') { $('#sos').hidden = true; $('#soschip').hidden = false; } } catch { /* shown */ }
try { const t = localStorage.getItem('link.tab'); if (t && document.querySelector(`[data-pane="${t}"]`)) showTab(t); } catch { /* the Overview */ }
renderLoading();
load();
