// Riyeser PDF: "Ask someone to sign" and "Sent for signing" (the sender's side).
// Loaded by the editor's Sign menu (or, while the editor has no hook for it, by src/sign-request-ipc.js). The hook can
//   import('./sign-request.js') then call  init({ menu: true })  and show  menuItems()  ([{ id, label, run }]) itself;
//   init() with no menu: true adds "Ask someone to sign" next to Sign and "Sent for signing" to the Tools menu.
// Also on window.RiyeserSignRequest: { open(), openStatus(), menuItems() }.
// Main-process side: src/sign-request-ipc.js (signreq:*). Database: sign_* in website/team/team-chat.sql.
// Wording: "electronic signature with an audit trail"; no claim of meeting any particular law.

export const COLOURS = ['#7c3aed', '#0e7c86', '#c2410c', '#1d4ed8', '#be185d', '#15803d', '#a16207', '#4338ca', '#b91c1c', '#0f766e'];
export const KIND_LABEL = { signature: 'Signature', initials: 'Initials', date: 'Date signed', name: 'Name', text: 'Text' };
export const SIZES = { signature: [0.28, 0.06], initials: [0.09, 0.045], date: [0.18, 0.035], name: [0.26, 0.035], text: [0.26, 0.035] };
export const KEEP = [[30, '30 days'], [90, '90 days'], [365, '1 year (recommended)'], [730, '2 years']];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r5 = (v) => Math.round(v * 100000) / 100000;

/** A new field of this kind centred where the page was clicked (fractions of the page, from its top-left), kept on the page. */
export function placeAt(kind, fx, fy, signer, id) {
  const [w, h] = SIZES[kind] || SIZES.text;
  return { id, kind, signer, x: r5(clamp(fx - w / 2, 0, 1 - w)), y: r5(clamp(fy - h / 2, 0, 1 - h)), w, h };
}
/** Moved by (dx, dy), still on the page. */
export function moved(f, dx, dy) { return { ...f, x: r5(clamp(f.x + dx, 0, 1 - f.w)), y: r5(clamp(f.y + dy, 0, 1 - f.h)) }; }
/** Resized from its bottom-right corner, at least a small size, still on the page. */
export function resized(f, dw, dh) { return { ...f, w: r5(clamp(f.w + dw, 0.03, 1 - f.x)), h: r5(clamp(f.h + dh, 0.015, 1 - f.y)) }; }
/** "Service agreement.pdf" -> "Service agreement" */
export function titleFrom(file) { return String(file || '').split(/[\\/]/).pop().replace(/\.pdf$/i, '').trim().slice(0, 120) || 'Document'; }
/** yyyy-mm-dd, days from now (local time) */
export function dayFromNow(days, now = new Date()) { const d = new Date(now.getTime() + days * 86400e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
/** The end of the chosen day (local), as an ISO time. */
export function endOfDay(ymd) { const [y, m, d] = String(ymd).split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 0).toISOString(); }
/** What's missing before it can be sent, step by step ('' when ready). */
export function missing(step, s) {
  if (step >= 1) {
    for (let i = 1; i <= s.signers.length; i++) if (!s.fields.some((f) => f.signer === i)) return `Place at least one field for ${s.signers[i - 1].name || `signer ${i}`}.`;
  }
  if (step >= 2) {
    const seen = new Set();
    for (const [i, p] of s.signers.entries()) {
      if (!String(p.name || '').trim()) return `Type the name of signer ${i + 1}.`;
      const e = String(p.email || '').trim().toLowerCase();
      if (!/^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/.test(e)) return `Check the email address for ${p.name.trim()}.`;
      if (seen.has(e)) return 'Each signer needs their own email address.';
      seen.add(e);
    }
  }
  if (step >= 3 && !String(s.title || '').trim()) return 'Give the document a name.';
  return '';
}

// ---------------------------------------------------------------- the window (only in the editor)
const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';
const call = (...a) => window.api.call(...a);
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (t) => (t ? new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const when = (t) => (t ? new Date(t).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
let pdfjs = null;
const S = { step: 0, signers: [{ name: '', email: '' }], fields: [], kind: 'signature', signer: 1, ordered: false, title: '', message: '', expires: '', keep: 365,
  pages: [], numPages: 0, me: null, ws: null, quota: null, busy: false, n: 1 };

function toast(msg) { const t = $('#toast'); if (t) { t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3600); } }
function overlay(id, html) {
  let o = $(`#${id}`); if (!o) { o = document.createElement('div'); o.id = id; o.className = 'sr-overlay'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); document.body.appendChild(o); }
  o.innerHTML = html; o.hidden = false; return o;
}
function closeAll() { for (const id of ['sr-flow', 'sr-list']) { const o = $(`#${id}`); if (o) o.remove(); } }
function ask(message, yes = 'OK', danger = false) {
  return new Promise((res) => {
    const d = document.createElement('div'); d.className = 'sr-ask'; d.setAttribute('role', 'alertdialog');
    d.innerHTML = `<div class="sr-askbox"><p>${message}</p><div class="sr-row end"><button data-no>Go back</button><button class="${danger ? 'sr-danger' : 'primary'}" data-yes>${esc(yes)}</button></div></div>`;
    document.body.appendChild(d); $('[data-yes]', d).focus();
    $('[data-no]', d).onclick = () => { d.remove(); res(false); }; $('[data-yes]', d).onclick = () => { d.remove(); res(true); };
  });
}

// ---- signed in? (the same Riyeser account as Riyeser Central and Link)
async function account(after) {
  let st;
  try { st = await call('signreq:status'); } catch (e) {
    overlay('sr-flow', frame('Ask someone to sign', `<div class="sr-center"><h2>Not available here</h2><p class="muted">${/No handler|signreq/i.test(e.message) ? 'Ask someone to sign is in Riyeser PDF. Open this PDF there.' : esc(e.message)}</p></div>`)); wireClose(); return;
  }
  if (!st.signedIn) { signInScreen(st, after); return; }
  S.me = st;
  const list = st.businesses || [];
  if (!list.length) {
    overlay('sr-flow', frame('Ask someone to sign', `<div class="sr-center"><h2>Set up your business first</h2><p class="muted">Signing requests are sent from your business on Riyeser. Open Riyeser Central and set up or join your business online, then come back here.</p><p class="muted small">Signed in as ${esc(st.email)}.</p></div>`)); wireClose(); return;
  }
  S.ws = list.some((b) => b.workspace_id === st.chosen) ? st.chosen : list[0].workspace_id;
  after();
}
function signInScreen(st, after) {
  const o = overlay('sr-flow', frame('Ask someone to sign', `<form class="sr-signin" id="sr-si">
    <h2>Sign in to your Riyeser account</h2>
    <p class="muted">Sending a document for signing uses your Riyeser account, the same one you use in Riyeser Central and Riyeser Link.</p>
    <label class="sr-f"><span>Email</span><input id="sr-email" type="email" autocomplete="username" value="${esc(st.email || '')}" required></label>
    <label class="sr-f"><span>Password</span><input id="sr-pass" type="password" autocomplete="current-password" required></label>
    <label class="sr-f" id="sr-codewrap" hidden><span>6-digit code from your authenticator app</span><input id="sr-code" inputmode="numeric" maxlength="7" autocomplete="one-time-code"></label>
    <p class="sr-err" id="sr-sierr" role="alert" hidden></p>
    <div class="sr-row"><button class="primary" id="sr-sigo">Sign in</button><button type="button" class="link" id="sr-forgot">Forgot your password?</button></div>
    <p class="muted small">No account yet? Make one free at riyeser.com, or in Riyeser Central.</p></form>`));
  wireClose();
  let needCode = false;
  const err = (t) => { const e = $('#sr-sierr'); e.hidden = !t; e.textContent = t || ''; };
  $('#sr-si').onsubmit = async (e) => {
    e.preventDefault(); err(''); $('#sr-sigo').disabled = true;
    try {
      if (needCode) { await call('signreq:code', $('#sr-code').value); account(after); return; }
      const r = await call('signreq:signIn', $('#sr-email').value, $('#sr-pass').value);
      if (r && r.needsCode) { needCode = true; $('#sr-codewrap').hidden = false; $('#sr-code').focus(); $('#sr-sigo').textContent = 'Check the code'; }
      else if (r && r.needsConfirm) err('Confirm your email first: open the link we emailed you.');
      else account(after);
    } catch (x) { err(x.message); }
    $('#sr-sigo').disabled = false;
  };
  $('#sr-forgot').onclick = async () => { try { await call('signreq:forgot', $('#sr-email').value); err(''); toast('If there\'s an account for that email, we\'ve sent a link to reset the password.'); } catch (x) { err(x.message); } };
  $('#sr-email').focus();
}
function frame(title, body, steps = '') {
  return `<div class="sr-shell"><header class="sr-head"><h1>${esc(title)}</h1>${steps}<span class="sr-sp"></span><button class="sr-x" id="sr-close" title="Close (Esc)" aria-label="Close">✕</button></header>${body}</div>`;
}
function wireClose() { const b = $('#sr-close'); if (b) b.onclick = () => closeAll(); }

// ---- 1. Place fields  2. Who's signing  3. Message and send
export async function open() {
  if (!hasDom) return;
  const ed = window.__editor && window.__editor.st;
  if (!ed || !ed.file) { toast('Open a saved PDF first, then choose Ask someone to sign.'); return; }
  if (ed.dirty) { toast('Save your changes first, so the people signing see this version.'); return; }
  if (ed.encrypted || ed.password != null) { toast('Take the password off this PDF first (save a copy without it), then ask for signatures.'); return; }
  await account(async () => {
    if (S.file !== ed.file) Object.assign(S, { file: ed.file, step: 1, signers: [{ name: '', email: '' }], fields: [], signer: 1, ordered: false, title: titleFrom(ed.file), message: '', expires: dayFromNow(30), keep: 365, n: 1 });
    S.step = Math.max(1, S.step);
    S.quota = await call('signreq:quota', S.ws).catch(() => null);
    S.settings = await call('signreq:settings').catch(() => ({ expiry_days: 30, keep_days: 365, max_signers: 10 }));
    render();
    await drawPages(ed.file);
  });
}
const STEPS = ['Place the fields', 'Who\'s signing', 'Message and send'];
function render() {
  const steps = `<ol class="sr-steps">${STEPS.map((t, i) => `<li class="${S.step === i + 1 ? 'on' : S.step > i + 1 ? 'done' : ''}"><span>${i + 1}</span>${t}</li>`).join('')}</ol>`;
  const o = overlay('sr-flow', frame('Ask someone to sign', `<div class="sr-body"><aside class="sr-panel" id="sr-panel">${panel()}</aside>
    <main class="sr-pages" id="sr-pages" aria-label="The PDF">${S.pagesHtml || '<p class="muted sr-center">Drawing the pages…</p>'}</main></div>`, steps));
  wireClose(); wirePanel(o); paintFields();
}
function signerChip(i) { const p = S.signers[i - 1]; return `<span class="sr-dot" style="background:${COLOURS[(i - 1) % 10]}"></span>${esc(p.name || `Signer ${i}`)}`; }
function panel() {
  const quota = S.quota ? `<p class="sr-quota ${S.quota.left ? '' : 'bad'}">${S.quota.used} of ${S.quota.limit} free signing requests used this month${S.quota.left ? '' : '. More can be sent from the 1st.'}</p>` : '';
  const bizName = ((S.me && S.me.businesses) || []).find((b) => b.workspace_id === S.ws);
  const biz = (S.me && S.me.businesses || []).length > 1
    ? `<label class="sr-f"><span>Send from</span><select id="sr-ws">${S.me.businesses.map((b) => `<option value="${esc(b.workspace_id)}"${b.workspace_id === S.ws ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>`
    : `<p class="muted small">From ${esc(bizName ? bizName.name : '')} · ${esc(S.me && S.me.email)}</p>`;
  if (S.step === 1) {
    return `<h2>Place the fields</h2><p class="muted small">Choose who it's for and what to add, then click on the page. Drag a field to move it; drag its corner to resize.</p>
      <div class="sr-lbl">For</div><div class="sr-chips" role="radiogroup" aria-label="Who the field is for">${S.signers.map((_, k) => `<button role="radio" aria-checked="${S.signer === k + 1}" class="sr-chip ${S.signer === k + 1 ? 'on' : ''}" data-signer="${k + 1}">${signerChip(k + 1)}</button>`).join('')}
        ${S.signers.length < (S.settings && S.settings.max_signers || 10) ? '<button class="sr-chip add" id="sr-addsigner">+ Another signer</button>' : ''}</div>
      <div class="sr-lbl">Add</div><div class="sr-kinds">${['signature', 'initials', 'date', 'name', 'text'].map((k) => `<button class="sr-kind ${S.kind === k ? 'on' : ''}" data-kind="${k}" aria-pressed="${S.kind === k}">${{ signature: '✍', initials: 'AB', date: '📅', name: '👤', text: 'T' }[k]} ${KIND_LABEL[k]}</button>`).join('')}</div>
      <div class="sr-lbl">Placed (${S.fields.length})</div>
      <ul class="sr-placed">${S.fields.map((f) => `<li><span class="sr-dot" style="background:${COLOURS[(f.signer - 1) % 10]}"></span>${KIND_LABEL[f.kind]} · page ${f.page}<span class="sr-sp"></span><button class="link" data-del="${esc(f.id)}" aria-label="Remove">Remove</button></li>`).join('') || '<li class="muted">Nothing yet: click on a page.</li>'}</ul>
      ${nav(1)}`;
  }
  if (S.step === 2) {
    return `<h2>Who's signing</h2><p class="muted small">Each person gets their own link by email. Nobody needs a Riyeser account to sign.</p>
      ${S.signers.map((p, k) => `<fieldset class="sr-signer"><legend>${signerChip(k + 1)}</legend>
        <label class="sr-f"><span>Name</span><input data-sn="${k}" value="${esc(p.name)}" maxlength="80" autocomplete="off"></label>
        <label class="sr-f"><span>Email</span><input data-se="${k}" type="email" value="${esc(p.email)}" maxlength="320" autocomplete="off"></label>
        ${S.signers.length > 1 ? `<button class="link" data-rm="${k}">Remove this signer and their fields</button>` : ''}</fieldset>`).join('')}
      ${S.signers.length > 1 ? `<label class="sr-check"><input type="checkbox" id="sr-ordered"${S.ordered ? ' checked' : ''}> <span>Sign in this order (the next person is emailed when the one before has signed)</span></label>` : ''}
      ${nav(2)}`;
  }
  const keepLabel = (KEEP.find(([d]) => d === S.keep) || KEEP[2])[1].replace(' (recommended)', '');
  return `<h2>Message and send</h2>${biz}
    <label class="sr-f"><span>Document name (in the email)</span><input id="sr-title" value="${esc(S.title)}" maxlength="120"></label>
    <label class="sr-f"><span>Message (optional)</span><textarea id="sr-msg" rows="3" maxlength="2000" placeholder="For example: Please sign by Friday. Thanks!">${esc(S.message)}</textarea></label>
    <label class="sr-f"><span>Links work until</span><input type="date" id="sr-exp" value="${esc(S.expires)}" min="${dayFromNow(1)}" max="${dayFromNow(365)}"></label>
    <label class="sr-f"><span>Keep the files for</span><select id="sr-keep">${KEEP.map(([d, l]) => `<option value="${d}"${S.keep === d ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="muted small" id="sr-keepnote">Riyeser keeps the PDF and the signed copy for ${esc(keepLabel)} after the request finishes, then deletes them (the record of who signed and when stays). You can delete them sooner in Sent for signing.</p>
    <div class="sr-sum"><b>${S.signers.length} signer${S.signers.length > 1 ? 's' : ''}</b>${S.ordered && S.signers.length > 1 ? ', in order' : ''} · ${S.fields.length} field${S.fields.length > 1 ? 's' : ''}
      <ul>${S.signers.map((p, k) => `<li>${signerChip(k + 1)} <span class="muted">${esc(p.email)}</span></li>`).join('')}</ul></div>
    ${quota}
    <p class="muted small sr-legal">This is an electronic signature with an audit trail: Riyeser records when each person opened and signed, their internet address and browser, and the document's fingerprint, and adds a certificate of completion to the signed copy. Whether an electronic signature is accepted for a particular kind of document, or in a particular country, depends on the rules there.</p>
    ${nav(3)}`;
}
function nav(step) {
  return `<p class="sr-err" id="sr-err" role="alert" hidden></p><div class="sr-row sr-nav">${step > 1 ? '<button id="sr-back">Back</button>' : ''}<span class="sr-sp"></span>
    ${step < 3 ? '<button class="primary" id="sr-next">Next</button>' : `<button class="primary" id="sr-send"${S.quota && !S.quota.left ? ' disabled' : ''}>Send for signing</button>`}</div>`;
}
function readInputs() {
  $$('[data-sn]').forEach((i) => { S.signers[+i.dataset.sn].name = i.value; });
  $$('[data-se]').forEach((i) => { S.signers[+i.dataset.se].email = i.value.trim(); });
  const g = (id) => $(`#${id}`);
  if (g('sr-ordered')) S.ordered = g('sr-ordered').checked;
  if (g('sr-title')) S.title = g('sr-title').value;
  if (g('sr-msg')) S.message = g('sr-msg').value;
  if (g('sr-exp')) S.expires = g('sr-exp').value;
  if (g('sr-keep')) S.keep = Number(g('sr-keep').value);
  if (g('sr-ws')) S.ws = g('sr-ws').value;
}
function showErr(t) { const e = $('#sr-err'); if (e) { e.hidden = !t; e.textContent = t || ''; } }
function wirePanel(o) {
  const p = $('#sr-panel', o);
  p.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.signer) { S.signer = +b.dataset.signer; rerenderPanel(); }
    else if (b.dataset.kind) { S.kind = b.dataset.kind; rerenderPanel(); }
    else if (b.id === 'sr-addsigner') { readInputs(); S.signers.push({ name: '', email: '' }); S.signer = S.signers.length; rerenderPanel(); }
    else if (b.dataset.del) { S.fields = S.fields.filter((f) => f.id !== b.dataset.del); rerenderPanel(); paintFields(); }
    else if (b.dataset.rm) {
      readInputs(); const k = +b.dataset.rm + 1;
      S.signers.splice(k - 1, 1); S.fields = S.fields.filter((f) => f.signer !== k).map((f) => (f.signer > k ? { ...f, signer: f.signer - 1 } : f)); S.signer = 1;
      rerenderPanel(); paintFields();
    } else if (b.id === 'sr-back') { readInputs(); S.step--; rerenderPanel(); }
    else if (b.id === 'sr-next') { readInputs(); const m = missing(S.step, S); if (m) return showErr(m); S.step++; rerenderPanel(); }
    else if (b.id === 'sr-send') send();
  };
  p.onchange = (e) => {
    if (e.target.id === 'sr-ws') { readInputs(); call('signreq:choose', S.ws).catch(() => {}); call('signreq:quota', S.ws).then((q) => { S.quota = q; rerenderPanel(); }).catch(() => {}); }
    if (e.target.id === 'sr-keep') { readInputs(); rerenderPanel(); }
  };
}
function rerenderPanel() {
  const p = $('#sr-panel'); if (!p) return; p.innerHTML = panel();
  const steps = $('.sr-steps'); if (steps) $$('li', steps).forEach((li, i) => { li.className = S.step === i + 1 ? 'on' : S.step > i + 1 ? 'done' : ''; });
  $('#sr-pages').classList.toggle('placing', S.step === 1);
  paintFields();
}
async function send() {
  readInputs();
  const m = missing(3, S); if (m) return showErr(m);
  if (!(await ask(`Send “${esc(S.title.trim())}” to ${S.signers.map((p) => esc(p.name.trim())).join(', ')} for signing?`, 'Send for signing'))) return;
  const btn = $('#sr-send'); btn.disabled = true; btn.textContent = 'Sending…'; showErr('');
  try {
    await call('signreq:send', { file: S.file, ws: S.ws, pages: S.numPages, title: S.title.trim(), message: S.message.trim(), ordered: S.signers.length > 1 && S.ordered,
      expires: endOfDay(S.expires), keep: S.keep, fields: S.fields.map(({ id, kind, signer, page, x, y, w, h }) => ({ id, kind, signer, page, x, y, w, h })),
      signers: S.signers.map((p) => ({ name: p.name.trim(), email: p.email.trim() })) });
    S.file = null; S.pagesHtml = null;
    closeAll(); toast('Sent. Each person gets an email with their own link.');
    openStatus();
  } catch (e) { showErr(e.message); btn.disabled = false; btn.textContent = 'Send for signing'; }
}

// ---- the pages, with the fields on them
async function drawPages(file) {
  if (!pdfjs) { pdfjs = await import('./vendor/pdf.min.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs'; }
  const bytes = await call('pdf:read', file);
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/' }).promise;
  S.numPages = doc.numPages;
  const host = $('#sr-pages'); if (!host) return;
  host.innerHTML = '';
  host.classList.toggle('placing', S.step === 1);
  const width = Math.min(Math.max(host.clientWidth - 48, 320), 860);
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i); const vp1 = page.getViewport({ scale: 1 }); const scale = width / vp1.width;
    const vp = page.getViewport({ scale: scale * Math.min(window.devicePixelRatio || 1, 2) });
    const wrap = document.createElement('div'); wrap.className = 'sr-page'; wrap.dataset.page = String(i); wrap.style.width = `${width}px`; wrap.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    wrap.innerHTML = `<span class="sr-pno">Page ${i} of ${doc.numPages}</span>`; wrap.prepend(c); host.appendChild(wrap);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
  S.pagesHtml = null;
  host.onpointerdown = pagePointer;
  paintFields();
}
function paintFields() {
  $$('.sr-fld').forEach((x) => x.remove());
  for (const f of S.fields) {
    const pg = $(`.sr-page[data-page="${f.page}"]`); if (!pg) continue;
    const el = document.createElement('div'); el.className = `sr-fld k-${f.kind}`; el.dataset.id = f.id; el.tabIndex = 0;
    const col = COLOURS[(f.signer - 1) % 10];
    Object.assign(el.style, { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, borderColor: col, background: `${col}22`, color: col });
    el.innerHTML = `<span class="sr-ftxt">${KIND_LABEL[f.kind]} · ${esc(S.signers[f.signer - 1] && S.signers[f.signer - 1].name || `Signer ${f.signer}`)}</span>${S.step === 1 ? '<button class="sr-fx" title="Remove" aria-label="Remove this field">×</button><span class="sr-grip" aria-hidden="true"></span>' : ''}`;
    el.setAttribute('aria-label', `${KIND_LABEL[f.kind]} for ${S.signers[f.signer - 1] ? S.signers[f.signer - 1].name || `signer ${f.signer}` : ''}, page ${f.page}`);
    pg.appendChild(el);
  }
}
function pagePointer(e) {
  if (S.step !== 1) return;
  const pg = e.target.closest('.sr-page'); if (!pg) return;
  const box = pg.getBoundingClientRect();
  const fx = (e.clientX - box.left) / box.width; const fy = (e.clientY - box.top) / box.height;
  const fe = e.target.closest('.sr-fld');
  if (e.target.closest('.sr-fx')) { S.fields = S.fields.filter((f) => f.id !== fe.dataset.id); rerenderPanel(); return; }
  if (fe) {   // move, or resize from the corner
    const f0 = S.fields.find((f) => f.id === fe.dataset.id); const grip = !!e.target.closest('.sr-grip');
    const sx = e.clientX, sy = e.clientY; pg.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      const dx = (ev.clientX - sx) / box.width, dy = (ev.clientY - sy) / box.height;
      const nf = grip ? resized(f0, dx, dy) : moved(f0, dx, dy);
      Object.assign(fe.style, { left: `${nf.x * 100}%`, top: `${nf.y * 100}%`, width: `${nf.w * 100}%`, height: `${nf.h * 100}%` }); fe._nf = nf;
    };
    const up = () => { pg.removeEventListener('pointermove', mv); pg.removeEventListener('pointerup', up); if (fe._nf) S.fields = S.fields.map((f) => (f.id === f0.id ? fe._nf : f)); };
    pg.addEventListener('pointermove', mv); pg.addEventListener('pointerup', up);
    return;
  }
  S.fields.push({ ...placeAt(S.kind, fx, fy, S.signer, `f${S.n++}`), page: +pg.dataset.page });
  rerenderPanel();
}

// ---------------------------------------------------------------- Sent for signing
export async function openStatus() {
  if (!hasDom) return;
  await account(async () => {
    overlay('sr-list', frame('Sent for signing', '<div class="sr-listbody" id="sr-lb"><p class="muted sr-center">Loading…</p></div>')); wireClose();
    await refreshList();
  });
}
const PILL = { good: 'good', bad: 'bad', warn: 'warn', accent: '', muted: 'muted' };
async function refreshList() {
  const lb = $('#sr-lb'); if (!lb) return;
  let rows; let quota = null;
  try { [rows, quota] = await Promise.all([call('signreq:list', S.ws), call('signreq:quota', S.ws).catch(() => null)]); } catch (e) { lb.innerHTML = `<p class="sr-err">${esc(e.message)}</p>`; return; }
  const biz = ((S.me && S.me.businesses) || []).find((b) => b.workspace_id === S.ws);
  lb.innerHTML = `<div class="sr-listhead"><p class="muted">Documents you've sent for signing from ${esc(biz ? biz.name : 'your business')}. Only you can see them here.</p>
      ${quota ? `<span class="pill">${quota.used} of ${quota.limit} free this month</span>` : ''}<button class="primary" id="sr-new">✉ Ask someone to sign</button></div>
    ${rows.length ? `<div class="sr-table" role="table" aria-label="Signing requests"><div class="sr-tr sr-th" role="row"><span role="columnheader">Document</span><span role="columnheader">Signers</span><span role="columnheader">Status</span><span role="columnheader">Files</span><span role="columnheader"></span></div>
      ${rows.map((r) => row(r)).join('')}</div>` : '<div class="sr-empty"><h2>Nothing sent yet</h2><p class="muted">Open a PDF, then choose Ask someone to sign.</p></div>'}`;
  $('#sr-new').onclick = () => { closeAll(); open(); };
  lb.onclick = async (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const id = b.dataset.id; const r = rows.find((x) => x.id === id);
    try {
      if (b.dataset.a === 'dl') { b.disabled = true; const p = await call('signreq:download', id, r.title); b.disabled = false; if (p) toast(`Saved to ${p}`); }
      if (b.dataset.a === 'remind' && await ask(`Send a reminder for “${esc(r.title)}”? Everyone who hasn't signed yet gets an email with a new link (the earlier link stops working).`, 'Send reminder')) { const n = await call('signreq:remind', id); toast(`Reminder sent to ${n} ${n === 1 ? 'person' : 'people'}.`); }
      if (b.dataset.a === 'cancel' && await ask(`Cancel the request to sign “${esc(r.title)}”? The links stop working and everyone who was sent one is told.`, 'Cancel request', true)) { await call('signreq:cancel', id); toast('Cancelled.'); }
      if (b.dataset.a === 'delete' && await ask(`Delete the PDF and the signed copy of “${esc(r.title)}” from Riyeser now? Download the signed copy first if you need it. The record of who signed stays.`, 'Delete files', true)) { await call('signreq:deleteFiles', id); toast('Files deleted.'); }
      if (b.dataset.a === 'hist') { const h = await call('signreq:history', id); const box = $(`#sr-h-${id}`); box.hidden = !box.hidden; box.innerHTML = h.map((x) => `<li>${esc(when(x.at))} · ${esc(HIST[x.event] || x.event)}${x.signer ? ` · ${esc(x.signer)}` : ''}</li>`).join(''); return; }
    } catch (x) { toast(x.message); b.disabled = false; return; }
    refreshList();
  };
  lb.onchange = async (e) => { if (!e.target.dataset.keep) return; try { await call('signreq:keep', e.target.dataset.keep, Number(e.target.value)); toast('Saved.'); } catch (x) { toast(x.message); } refreshList(); };
}
const HIST = { created: 'Made', sent: 'Sent', emailed: 'Link emailed', viewed: 'Opened', signed: 'Signed', declined: 'Declined', reminded: 'Reminder sent', cancelled: 'Cancelled', expired: 'Expired', completed: 'Signed copy made', files_deleted: 'Files deleted', keep_changed: 'Keeping time changed' };
const SIGNER = { waiting: ['Waiting their turn', 'muted'], sent: ['Sent', ''], viewed: ['Viewed', ''], signed: ['Signed', 'good'], declined: ['Declined', 'bad'] };
function row(r) {
  const s = r._status || { label: r.status, tone: 'accent', detail: '' };
  const open = r.status === 'sent';
  return `<div class="sr-tr" role="row">
    <span role="cell"><b class="sr-doc">${esc(r.title)}</b><small class="muted">Sent ${esc(day(r.sent_at))}${open ? ` · links work until ${esc(day(r.expires_at))}` : r.finished_at ? ` · finished ${esc(day(r.finished_at))}` : ''}</small></span>
    <span role="cell"><ul class="sr-signers">${(r.signers || []).map((p) => `<li><span class="pill ${(SIGNER[p.status] || ['', ''])[1]}">${(SIGNER[p.status] || [p.status])[0]}</span> ${esc(p.name)}</li>`).join('')}</ul></span>
    <span role="cell"><span class="pill ${PILL[s.tone] || ''} sr-st">${esc(s.label)}</span><small class="muted sr-detail">${esc(s.detail)}</small></span>
    <span role="cell"><small class="muted">${esc(r._keep || '')}</small>${!r.files_deleted_at ? `<select data-keep="${esc(r.id)}" aria-label="Keep the files for">${KEEP.map(([d, l]) => `<option value="${d}"${r.keep_days === d ? ' selected' : ''}>Keep ${l.replace(' (recommended)', '')}</option>`).join('')}</select>` : ''}</span>
    <span role="cell" class="sr-acts">
      ${r.has_signed && !r.files_deleted_at ? `<button class="primary" data-a="dl" data-id="${esc(r.id)}">⬇ Signed copy</button>` : ''}
      ${open ? `<button data-a="remind" data-id="${esc(r.id)}">Send a reminder</button><button data-a="cancel" data-id="${esc(r.id)}">Cancel</button>` : ''}
      ${!open && !r.files_deleted_at ? `<button class="link" data-a="delete" data-id="${esc(r.id)}">Delete files now</button>` : ''}
      <button class="link" data-a="hist" data-id="${esc(r.id)}">History</button></span>
    <ul class="sr-hist" id="sr-h-${esc(r.id)}" hidden></ul></div>`;
}

// ---------------------------------------------------------------- hooking into the editor
export function menuItems() {
  return [{ id: 'sign-request', label: '✉ Ask someone to sign…', run: open }, { id: 'sign-status', label: '📋 Sent for signing', run: openStatus }];
}
export function init(ctx = {}) {
  if (!hasDom || window.__signRequestLoaded) return window.RiyeserSignRequest;
  window.__signRequestLoaded = true;
  if (!$('link[href="sign-request.css"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'sign-request.css'; document.head.appendChild(l); }
  window.RiyeserSignRequest = { open, openStatus, menuItems };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('.sr-ask') && ($('#sr-flow') || $('#sr-list'))) { e.stopPropagation(); closeAll(); } }, true);
  if (window.api && window.api.on) window.api.on('signreq:changed', () => { if ($('#sr-list')) refreshList(); });
  if (!ctx.menu) {   // no Sign menu hook in this editor: add the two entries ourselves
    const sign = $('[data-cmd="signature"]');
    if (sign && !$('#sr-askbtn')) { const b = document.createElement('button'); b.id = 'sr-askbtn'; b.title = 'Send this PDF to people to sign, and follow it'; b.textContent = '✉ Ask someone to sign'; b.onclick = () => open(); sign.after(b); }
    const menu = $('#toolsmenu');
    if (menu && !$('#sr-menuitem')) {
      const h = document.createElement('div'); h.className = 'mh'; h.textContent = 'Signing';
      const b1 = document.createElement('button'); b1.id = 'sr-menuitem'; b1.textContent = '📋 Sent for signing'; b1.onclick = () => { menu.hidden = true; openStatus(); };
      const help = [...menu.querySelectorAll('.mh')].find((x) => /Help/.test(x.textContent));
      menu.insertBefore(h, help || null); menu.insertBefore(b1, help || null);
    }
  }
  return window.RiyeserSignRequest;
}
export default init;
