// Riyeser Link's status screen: is it running, which phones are connected, people, new phones, recent calls.
const api = window.api; const T = window.LinkText;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let S = null; let shown = {}; let busy = false;

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500); }
async function safe(fn) { try { return await fn(); } catch (e) { toast(e.message); return null; } }
const when = (iso) => { const d = new Date(iso); const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
const pill = (state) => `<span class="pill ${/ready|connected/.test(state) && !/not/.test(state) ? 'ok' : /call|ringing/.test(state) ? 'busy' : /waiting/.test(state) ? 'wait' : ''}">${esc(state)}</span>`;
const who = (ext, name) => `${esc(name || '')}${name ? ' ' : ''}<span class="muted">${esc(ext || '')}</span>`;

function renderState() {
  const el = $('#state');
  $('#biz').textContent = S.business ? ` · ${S.business}` : '';
  $('#ver').textContent = `Version ${S.version}`;
  if (S.state === 'running') {
    el.className = 'state';
    el.innerHTML = `<div class="grow"><b class="big">${esc(T.running(S.host))}</b><span class="muted">${esc(T.counts(S.counts))}${S.licence.text ? ` · ${esc(S.licence.text)}` : ''}</span></div>`;
  } else if (S.state === 'waiting-licence') {
    el.className = 'state wait';
    el.innerHTML = `<div class="grow"><b class="big">${esc(T.WAITING_TITLE)}</b><span>${T.boldPlus(esc(S.licence.message || T.NEEDS_PLUS))}</span></div>
      <button class="btn" data-a="team">Open Riyeser Team</button><button class="btn s" data-a="recheck">Check again</button>`;
  } else if (S.state === 'stopping') {
    el.className = 'state wait';
    el.innerHTML = `<div class="grow"><b class="big">${esc(T.STOPPING_TITLE)}</b><span>${esc(T.STOPPING)}</span></div><button class="btn" data-a="team">Open Riyeser Team</button>`;
  } else if (S.state === 'error') {
    el.className = 'state bad';
    el.innerHTML = `<div class="grow"><b class="big">Riyeser Link isn't running</b><span>${esc(S.error)}</span></div>`;
  } else { el.className = 'state'; el.innerHTML = '<b>Starting…</b>'; }
}

function renderNotices() {
  const out = [];
  if (S.ipChanged) {
    out.push(`<div class="note warn"><b>${esc(T.ipChanged(S.ipChanged))}</b>${S.ipChanged.unstable ? `<div>${esc(T.IP_UNSTABLE)}</div>` : ''}
      <details><summary>Show me how</summary><ol>${T.ipSteps(S.adapter.mac, S.host).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${S.adapter.mac ? `<div class="row">This PC's MAC address: <code>${esc(S.adapter.mac)}</code><button class="btn s sm" data-copy="${esc(S.adapter.mac)}">Copy</button></div>` : ''}</details>
      ${S.ipChanged.unstable ? '' : '<div class="row"><button class="btn s sm" data-a="dismissip">OK</button></div>'}</div>`);
  }
  if (S.firewall === false) out.push(`<div class="note warn"><b>${esc(T.FIREWALL)}</b><div class="row"><button class="btn" data-a="firewall">Allow phones through the firewall</button></div></div>`);
  if (S.sleepNote) out.push(`<div class="note warn">${esc(S.sleepNote)}</div>`);
  for (const b of S.blocked || []) out.push(`<div class="note warn">Blocked ${esc(b.ip)} until ${esc(when(b.until))} after too many wrong passwords. If that's one of your phones, check its password.</div>`);
  if ((S.skipped || []).length) out.push(`<div class="note info">Not on the phones yet: ${S.skipped.map((x) => `${esc(x.name)} (${esc(x.why)})`).join('; ')}.</div>`);
  $('#notices').innerHTML = out.join('');
}

const personOptions = (sel) => `<option value="">Who is it for?</option>${S.people.map((p) => `<option value="${esc(p.ext)}"${sel === p.ext ? ' selected' : ''}>${esc(p.name)} (${esc(p.ext)})</option>`).join('')}`;
function renderFound() {
  $('#found').innerHTML = S.found.map((f) => `<div class="card"><div class="grow"><b>New phone found</b>${esc(f.vendorName)} ${esc(f.model || '')} · ${esc(f.macText)}${f.ip ? ` · at ${esc(f.ip)}` : ''}</div>
    <select data-found="${esc(f.mac)}">${personOptions('')}</select><button class="btn" data-give="${esc(f.mac)}">Give to this person</button><button class="btn s sm" data-ignore="${esc(f.mac)}">Not ours</button></div>`).join('');
}

function renderPeople() {
  $('#pcount').textContent = S.people.length ? `${S.people.length} · ${S.source === 'team' ? 'from Riyeser Team' : 'added on this PC'}` : '';
  if (!S.people.length) { $('#people').innerHTML = '<p class="muted">No one yet. Sign in to Riyeser below to bring in your team, or add people here.</p>'; }
  else {
    $('#people').innerHTML = `<div class="tw"><table><tr><th>Name</th><th>Extension</th><th>Device</th><th>State</th><th class="hide-sm">Do not disturb</th><th></th></tr>
      ${S.people.map((p) => `<tr><td>${esc(p.name)}</td><td><b>${esc(p.ext)}</b></td><td>${esc(T.device(p.device))}</td><td>${pill(T.personState(p))}</td>
        <td class="hide-sm"><input type="checkbox" data-dnd="${esc(p.ext)}"${p.dnd ? ' checked' : ''} aria-label="Do not disturb for ${esc(p.name)}"></td>
        <td><button class="btn s sm" data-manual="${esc(p.ext)}">Set up a phone by hand</button>${p.source === 'local' ? ` <button class="btn s sm" data-remove="${esc(p.id)}">Remove</button>` : ''}</td></tr>
        ${shown[p.ext] ? `<tr><td colspan="6"><div class="manual">Type these into any SIP phone or app:<br>Server address: <code>${esc(shown[p.ext].server)}</code> (port ${esc(shown[p.ext].port)})<br>
          Username: <code>${esc(shown[p.ext].username)}</code> &nbsp; Password: <code>${shown[p.ext].reveal ? esc(shown[p.ext].password) : '••••••••••••••••'}</code>
          <button class="btn s sm" data-reveal="${esc(p.ext)}">${shown[p.ext].reveal ? 'Hide' : 'Show'}</button><button class="btn s sm" data-copy="${esc(shown[p.ext].password)}">Copy password</button>
          <button class="btn s sm" data-reset="${esc(p.ext)}">Make a new password</button></div></td></tr>` : ''}`).join('')}</table></div>`;
  }
  $('#addperson').innerHTML = `<form id="personform" class="row"><input id="pname" placeholder="${S.source === 'team' ? 'Someone not in Riyeser Team? Their name' : 'Add a person: their name'}" autocomplete="off">
    <input id="pext" placeholder="Extension (blank = next free)" style="flex:0 1 190px" inputmode="numeric"><button class="btn">Add</button></form>`;
  $('#macwho').innerHTML = personOptions('');
}
function renderGroups() {
  $('#groupsp').hidden = !S.groups.length;
  $('#groups').innerHTML = `<div class="tw"><table>${S.groups.map((g) => `<tr><td><b>${esc(g.ext)}</b></td><td>${esc(g.name)}</td><td class="muted">${g.names.length ? esc(g.names.join(', ')) : 'No one in it yet'}</td></tr>`).join('')}</table></div>`;
}
function renderPhones() {
  $('#phones').innerHTML = S.phones.length ? `<div class="tw"><table><tr><th>Phone</th><th>For</th><th>State</th><th></th></tr>${S.phones.map((x) => `<tr>
    <td>${esc(x.vendorName)} ${esc(x.model || '')}<div class="muted">${esc(x.macText)}${x.ip ? ` · ${esc(x.ip)}` : ''}</div></td><td>${who(x.ext, x.name)}</td><td>${pill(x.state)}</td>
    <td><button class="btn s sm" data-unassign="${esc(x.mac)}">Stop setting up</button></td></tr>`).join('')}</table></div>` : '<p class="muted">No desk phones yet.</p>';
}
function renderCalls() {
  const live = S.inProgress.map((c) => `<tr><td>${esc(when(c.start))}</td><td>${who(c.from, c.fromName)}</td><td>${who(c.answeredBy || c.to, c.toName)}</td><td>${pill(c.state === 'talking' ? 'on a call now' : 'ringing')}</td><td></td></tr>`);
  const past = S.recent.slice(0, 50).map((c) => `<tr><td>${esc(when(c.start))}</td><td>${who(c.from, c.fromName)}</td><td>${who(c.to, c.toName)}${c.answeredBy && c.answeredBy !== c.to ? ` <span class="muted">(answered by ${esc(c.answeredBy)})</span>` : ''}</td><td>${esc(T.result(c.result))}</td><td>${esc(T.duration(c.duration))}</td></tr>`);
  $('#calls').innerHTML = live.length || past.length ? `<div class="tw"><table><tr><th>When</th><th>Who called</th><th>Whom</th><th>Result</th><th>How long</th></tr>${[...live, ...past].join('')}</table></div>` : '<p class="muted">No calls yet.</p>';
}
function renderAccount() {
  const s = S.sync;
  const line = S.teamSyncedAt ? `People and ring groups came from Riyeser Team, last brought in ${esc(when(S.teamSyncedAt))}. They're kept on this PC, so the phones work without the internet.` : 'Sign in to your Riyeser account to bring in your team: their names, extensions and branches.';
  $('#account').innerHTML = `<p>${line}</p>${s && s.status === 'offline' ? `<p class="muted">${esc(s.error)}</p>` : ''}${s && s.status === 'local' ? `<p class="muted">${esc(s.why)}</p>` : ''}
    <div class="row"><button class="btn s" data-a="sync">Bring in people from Riyeser Team now</button>${S.signedIn ? '<button class="btn s sm" data-a="signout">Sign out of Riyeser here</button>' : ''}</div>
    ${S.signedIn ? '' : `<form id="signin" class="row"><input id="em" type="email" placeholder="Riyeser account email" autocomplete="username"><input id="pw" type="password" placeholder="Password" autocomplete="current-password"><button class="btn">Sign in</button></form>
      <p class="muted">Already signed in on Riyeser Central? Riyeser Link uses that too when it can.</p>`}`;
}
function renderAdvanced() {
  const a = S.adapters;
  $('#advanced').innerHTML = `<p><b>Network adapter phones use.</b> This PC: ${esc(a.current.address)}${a.current.mac ? ` · MAC ${esc(a.current.mac)}` : ''}</p>
    <div class="row"><select id="adapter"><option value="">Choose automatically</option>${a.list.map((x) => `<option value="${esc(x.name)}"${a.current.chosen && a.current.name === x.name ? ' selected' : ''}>${esc(x.name)} (${esc(x.address)})</option>`).join('')}</select></div>
    <p><label><input type="checkbox" id="sww"${S.startWithWindows ? ' checked' : ''}> Start with Windows (needed so the phones work after a restart)</label></p>
    <p><label><input type="checkbox" id="pub"${S.allowPublic ? ' checked' : ''}> Allow phones from outside the office network (not recommended: it lets strangers try passwords)</label></p>
    <p><b>Settings file.</b> People, extensions, ring groups and phone assignments in one file, to move to a new PC or to Riyeser Link: Cloud later. It holds the phones' passwords, so keep it safe.</p>
    <div class="row"><button class="btn s" data-a="export">Export settings</button><button class="btn s" data-a="import">Import settings</button><button class="btn s" data-a="logs">Open the log folder</button></div>
    <p class="muted">Phones connect on port ${esc(S.sipPort)} (SIP) and fetch their settings from port ${esc(S.httpPort)}.</p>
    <div class="log">${S.logs.map((l) => `${esc(when(l.at))}  ${esc(l.text)}`).join('\n') || 'Nothing yet.'}</div>`;
}

function render() { if (!S) return; renderState(); renderNotices(); renderFound(); if (!busy) renderPeople(); renderGroups(); renderPhones(); renderCalls(); renderAccount(); if (!document.querySelector('.adv').open) renderAdvanced(); }
async function load() { const s = await safe(() => api.call('link:status')); if (s) { S = s; render(); } }
let pending = null;
api.on('link:changed', () => { clearTimeout(pending); pending = setTimeout(load, 150); });
document.querySelector('.adv').addEventListener('toggle', () => renderAdvanced());
// don't redraw the people list under someone who's typing in it
document.addEventListener('focusin', (e) => { busy = !!e.target.closest('#addperson'); });
document.addEventListener('focusout', () => { busy = false; });

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.copy != null) { await safe(() => api.call('link:copy', d.copy)); toast('Copied.'); return; }
  if (d.manual) { if (shown[d.manual]) delete shown[d.manual]; else shown[d.manual] = await safe(() => api.call('link:manual', d.manual)); renderPeople(); return; }
  if (d.reveal) { shown[d.reveal].reveal = !shown[d.reveal].reveal; renderPeople(); return; }
  if (d.reset) { const m = await safe(() => api.call('link:resetPassword', d.reset)); if (m) { shown[d.reset] = { ...m, reveal: true }; renderPeople(); toast('New password made.'); } return; }
  if (d.remove) { if (confirm('Take this person off the phones? Their call history stays.')) { await safe(() => api.call('link:removePerson', d.remove)); load(); } return; }
  if (d.give) { const ext = document.querySelector(`select[data-found="${d.give}"]`).value; if (!ext) { toast('Choose who the phone is for.'); return; }
    if (await safe(() => api.call('link:assign', d.give, ext))) toast('Done. The phone sets itself up in a minute. If it doesn\'t, restart it.'); load(); return; }
  if (d.ignore) { await safe(() => api.call('link:ignore', d.ignore)); load(); return; }
  if (d.unassign) { if (confirm('Stop giving this phone its settings? It keeps what it has until it\'s reset. To lock it out, make a new password for its person.')) { await safe(() => api.call('link:unassign', d.unassign)); load(); } return; }
  const a = d.a; if (!a) return;
  b.disabled = true;
  try {
    if (a === 'team') await safe(() => api.call('link:openTeam'));
    if (a === 'recheck') { await safe(() => api.call('link:recheck')); toast(S && S.state === 'running' ? 'Riyeser Link is on.' : 'Checked.'); }
    if (a === 'sync') { const r = await safe(() => api.call('link:sync')); if (r) toast(r.status === 'synced' ? `Brought in ${r.people} people.` : (r.error || r.why)); }
    if (a === 'signout') await safe(() => api.call('link:signOut'));
    if (a === 'firewall') { const ok = await safe(() => api.call('link:firewall')); toast(ok ? 'Phones are allowed through the firewall.' : 'The firewall rule wasn\'t added. Try again and choose Yes when Windows asks.'); }
    if (a === 'dismissip') await safe(() => api.call('link:dismissIp'));
    if (a === 'export') { const f = await safe(() => api.call('link:export')); if (f) toast('Settings saved. Keep the file safe: it holds the phones\' passwords.'); }
    if (a === 'import') { const r = await safe(() => api.call('link:import')); if (r) toast(`Imported ${r.people} people, ${r.groups} groups and ${r.phones} phones.`); }
    if (a === 'logs') await safe(() => api.call('link:openLogs'));
  } finally { b.disabled = false; load(); }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.dnd) { await safe(() => api.call('link:dnd', t.dataset.dnd, t.checked)); load(); }
  if (t.id === 'adapter') { await safe(() => api.call('link:adapter', t.value)); load(); }
  if (t.id === 'sww') await safe(() => api.call('link:startWithWindows', t.checked));
  if (t.id === 'pub') await safe(() => api.call('link:allowPublic', t.checked));
});
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'personform') {
    const r = await safe(() => api.call('link:addPerson', $('#pname').value, $('#pext').value.trim() || null));
    if (r) { toast(`${r.name} is extension ${r.ext}.`); busy = false; load(); }
  }
  if (e.target.id === 'macform') {
    const ext = $('#macwho').value; if (!ext) { toast('Choose who the phone is for.'); return; }
    const r = await safe(() => api.call('link:assign', $('#mac').value, ext));
    if (r) { $('#mac').value = ''; toast('Added. Turn the phone on (or restart it) and it sets itself up.'); load(); }
  }
  if (e.target.id === 'signin') {
    const r = await safe(() => api.call('link:signIn', $('#em').value, $('#pw').value));
    if (r) toast(r.status === 'synced' ? `Signed in. Brought in ${r.people} people.` : 'Signed in.');
    load();
  }
});
load();
