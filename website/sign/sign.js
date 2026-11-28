// riyeser.com/sign/?t=… : sign a PDF someone sent from Riyeser PDF ("Ask someone to sign").
// The link in the email is the only key: this page sends it to Riyeser's "sign" function (never anywhere else), which
// keeps only its SHA-256. The PDF is drawn here with pdf.js; nothing is stored in the browser (no cookies, no storage).
// Electronic signature with an audit trail: no claim about any particular country's e-signature law.
import * as pdfjsLib from './vendor/pdf.min.mjs';

const API = '__RIYESER_SIGN__';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const live = $('#live');
const say = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };
const day = (t) => { try { return new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return ''; } };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const todayText = () => new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\./g, '');
const KIND = { signature: 'Signature', initials: 'Initials', date: 'Date signed', name: 'Full name', text: 'Text' };

const token = (() => {
  const q = new URLSearchParams(location.search).get('t') || new URLSearchParams(location.hash.slice(1)).get('t') || '';
  return /^[0-9a-f]{64}$/i.test(q.trim()) ? q.trim().toLowerCase() : '';
})();

async function call(action, body) {
  let r;
  try { r = await fetch(`${API}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token, ...body }), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }); }
  catch { throw new Error('Can\'t reach Riyeser. Check your internet connection and try again.'); }
  if (action === 'doc' && r.ok) return { bytes: new Uint8Array(await r.arrayBuffer()), sha: r.headers.get('X-Doc-Sha256') || '' };
  let j = {}; try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok && !j.state) { const e = new Error(j.error || 'Something went wrong. Try again in a minute.'); e.state = j.state; throw e; }
  if (j.error) throw new Error(j.error);
  return j;
}

// ---------- the screens that aren't signing
const shell = (inner, cls = '') => `<main id="main" class="card msg ${cls}" tabindex="-1">${inner}</main>`;
function who(req) { return req && req.sender ? `${esc(req.sender)}${req.company ? ` at ${esc(req.company)}` : ''}` : 'the sender'; }
function screen(state, d = {}) {
  const req = d.request || {}; const title = req.title ? `“${esc(req.title)}”` : 'this document';
  const icons = { done: '✓', no: '!', wait: '⏳', info: 'i' };
  const box = (icon, h, p, extra = '') => shell(`<div class="ic ic-${icon}" aria-hidden="true">${icons[icon]}</div><h1>${h}</h1>${p}${extra}`, `st-${state}`);
  switch (state) {
    case 'unknown': return box('no', 'This link isn\'t working', `<p>It may have been typed or copied wrongly, or replaced by a newer email (a reminder sends a new link and the old one stops).</p>
      <p>Open the newest email you were sent and use its link. If you still can't sign, ask the person who sent it to send it again.</p>`);
    case 'expired': return box('no', 'This request has expired', `<p>The time to sign ${title} ended on ${esc(day(req.expires_at))}, so it can't be signed now.</p><p>Ask ${who(req)} to send it to you again.</p>`);
    case 'cancelled': return box('info', 'This request was cancelled', `<p>${who(req)} cancelled the request to sign ${title}. You don't need to do anything.</p>`);
    case 'declined': return box('info', 'This request is closed', `<p>Someone asked to sign ${title} declined, so it can't be signed now. ${who(req)} has been told.</p>`);
    case 'you_declined': return box('info', 'You declined to sign', `<p>You declined to sign ${title}. We've told ${who(req)}${d.reason ? ', with your reason:' : '.'}</p>${d.reason ? `<blockquote>${esc(d.reason)}</blockquote>` : ''}
      <p class="muted">If that was a mistake, ask them to send it to you again.</p>`);
    case 'signed': return box('done', `Thanks${d.signer && d.signer.name ? `, ${esc(d.signer.name.split(' ')[0])}` : ''}. You've signed`, `<p>You signed ${title}${d.signer && d.signer.signed_at ? ` on ${esc(day(d.signer.signed_at))}` : ''}.</p>
      <p>We're waiting for the others to sign. When everyone has, we'll email you a link to download the signed copy with its certificate of completion.</p>`);
    case 'finishing': return box('wait', 'Everyone has signed', `<p>The signed copy of ${title} is being made. This page will update in a moment.</p>`, '<p><button class="btn" data-act="reload">Check again</button></p>');
    case 'completed': return box('done', 'Everyone has signed', `<p>${title} is signed by everyone. Download your copy: it has a certificate of completion at the end, with who signed, when, and the document's fingerprints.</p>`,
      `<p class="acts"><button class="btn p" data-act="download">Download the signed copy (PDF)</button></p>${d.signed_sha256 ? `<p class="fp">SHA-256 of the signed file: <code>${esc(d.signed_sha256)}</code></p>` : ''}`);
    case 'gone': return box('info', 'This document isn\'t available any more', '<p>The sender\'s files for it have been deleted, or the download link has expired. Ask the sender for a copy.</p>');
    case 'busy': return box('wait', 'Too many tries', '<p>There have been a lot of tries from your internet connection. Wait a few minutes, then try again.</p>', '<p><button class="btn" data-act="reload">Try again</button></p>');
    case 'changed': return box('no', 'This document has changed', '<p>The document doesn\'t match the one that was sent, so it isn\'t shown. Ask the sender to send it again.</p>');
    case 'missing': return box('no', 'There\'s no link here', '<p>Open the link in the email you were sent. It ends with a long code after <b>?t=</b>.</p>');
    default: return box('no', 'Couldn\'t load this', `<p>${esc(d.error || 'Something went wrong.')}</p>`, '<p><button class="btn" data-act="reload">Try again</button></p>');
  }
}
function show(state, d) {
  app.innerHTML = screen(state, d);
  document.title = `${$('h1', app).textContent} · Riyeser`;
  $('#main').focus();
  app.onclick = async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'reload') start();
    if (b.dataset.act === 'download') download(b, d.request && d.request.title);
  };
}
async function download(btn, title) {
  btn.disabled = true; const was = btn.textContent; btn.textContent = 'Downloading…';
  try {
    const { bytes } = await call('doc', {});
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a'); a.href = url; a.download = `${String(title || 'document').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)} (signed).pdf`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    say('The signed copy is downloading.');
  } catch (e) { say(e.message); alertBox(e.message); }
  btn.disabled = false; btn.textContent = was;
}
function alertBox(text) { const p = $('#err') || Object.assign(document.createElement('p'), { id: 'err', className: 'err', role: 'alert' }); p.textContent = text; ($('#main') || app).appendChild(p); }

// ---------- signing
const S = { d: null, fields: [], vals: {}, sig: null, ini: null, method: null, pages: [], agreed: false };

async function start() {
  if (!token) { show('missing'); return; }
  app.innerHTML = '<main id="main" class="loading" tabindex="-1" role="status">Opening the document…</main>';
  let d;
  try { d = await call('open', {}); } catch (e) { show(e.state || 'error', { error: e.message }); return; }
  if (d.state !== 'ready') { show(d.state, d); if (d.state === 'finishing') setTimeout(start, 4000); return; }
  S.d = d; S.fields = d.fields || []; S.vals = {};
  for (const f of S.fields) { if (f.kind === 'name') S.vals[f.id] = d.signer.name || ''; if (f.kind === 'date') S.vals[f.id] = todayText(); }
  let doc;
  try { doc = await call('doc', {}); } catch (e) { show(e.state || 'error', { error: e.message, request: d.request }); return; }
  if (d.sha256 && doc.sha && doc.sha !== d.sha256) { show('changed', d); return; }
  renderSigning(d);
  try { await drawPages(doc.bytes); } catch { $('#pages').innerHTML = '<p class="err">This PDF couldn\'t be shown in your browser. Try another browser, or ask the sender for a copy.</p>'; }
}

function renderSigning(d) {
  const req = d.request; const mine = S.fields;
  const n = (k) => mine.filter((f) => f.kind === k).length;
  const need = [n('signature') && `${n('signature')} signature${n('signature') > 1 ? 's' : ''}`, n('initials') && 'your initials',
    n('name') && 'your name', n('date') && 'the date (filled in for you)', n('text') && `${n('text')} other field${n('text') > 1 ? 's' : ''}`].filter(Boolean);
  document.title = `Sign ${req.title} · Riyeser`;
  app.innerHTML = `
  <section class="card head" aria-labelledby="doc-title">
    <p class="from"><span class="co">${esc(req.company || '')}</span> · ${esc(req.sender)} asked you to sign</p>
    <h1 id="doc-title">${esc(req.title)}</h1>
    ${d.message ? `<p class="note"><span class="sr">Their message: </span>${esc(d.message)}</p>` : ''}
    <p class="meta">For <b>${esc(d.signer.name)}</b> · ${req.pages || ''} page${req.pages === 1 ? '' : 's'} · Sign by ${esc(day(req.expires_at))}${d.others ? ` · ${d.others} other${d.others > 1 ? 's' : ''} also signing` : ''}</p>
  </section>
  <div class="grid">
    <main id="main" class="card docwrap" tabindex="-1" aria-labelledby="doc-title">
      <div class="docbar"><span>Read it, then fill in the highlighted fields.</span><button class="btn sm" id="next">Next field ↓</button></div>
      <div id="pages" class="pages"><p class="loading" role="status">Drawing the pages…</p></div>
    </main>
    <aside class="card side" aria-label="Your fields">
      <h2>To finish</h2>
      <p class="muted small">You need to add ${esc(need.join(', '))}.</p>
      <ol class="todo" id="todo"></ol>
      <button class="btn wide" id="adopt">✍ ${S.sig ? 'Change' : 'Adopt'} your signature</button>
      <label class="agree"><input type="checkbox" id="agree"> <span><b>I agree to sign electronically.</b> My signature and an audit trail (the time, my internet address, my browser and the document's fingerprint) will be added to this document.</span></label>
      <button class="btn p wide" id="finish" disabled>Finish</button>
      <p class="small muted" id="why" aria-live="polite"></p>
      <button class="link" id="decline">Decline to sign</button>
      <p class="small muted legal">Electronic signature with an audit trail, made with Riyeser for ${esc(req.sender)}. Only you have this link: please don't forward it.</p>
    </aside>
  </div>
  <div class="mobar" aria-hidden="true"><span id="mocount"></span><button class="btn p" id="mofinish" tabindex="-1">Finish</button></div>`;
  $('#adopt').onclick = () => adopt();
  $('#agree').onchange = (e) => { S.agreed = e.target.checked; update(); };
  $('#finish').onclick = finish; $('#mofinish').onclick = () => (S.ready ? finish() : $('.side').scrollIntoView({ behavior: 'smooth' }));
  $('#decline').onclick = declineBox;
  $('#next').onclick = () => { const f = S.fields.find((x) => !filled(x)) || S.fields[0]; const el = $(`[data-f="${f.id}"]`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus({ preventScroll: true }); } };
  update();
}
const filled = (f) => (f.kind === 'signature' ? !!S.sig : f.kind === 'initials' ? !!S.ini : !!String(S.vals[f.id] || '').trim());

async function drawPages(bytes) {
  const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const host = $('#pages'); host.innerHTML = '';
  const width = Math.min(host.clientWidth || 800, 900);
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const v1 = page.getViewport({ scale: 1 });
    const scale = width / v1.width; const vp = page.getViewport({ scale });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const wrap = document.createElement('div'); wrap.className = 'page'; wrap.style.aspectRatio = `${vp.width} / ${vp.height}`;
    wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', `Page ${i} of ${pdf.numPages}`);
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width * ratio); c.height = Math.floor(vp.height * ratio);
    c.setAttribute('aria-hidden', 'true');
    wrap.appendChild(c); host.appendChild(wrap);
    await page.render({ canvasContext: c.getContext('2d'), viewport: page.getViewport({ scale: scale * ratio }) }).promise;
    for (const f of S.fields.filter((x) => x.page === i)) wrap.appendChild(fieldEl(f));
  }
  update();
}
function fieldEl(f) {
  const el = document.createElement(f.kind === 'name' || f.kind === 'text' ? 'label' : 'button');
  el.className = `fld k-${f.kind}`; el.dataset.f = f.id;
  Object.assign(el.style, { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` });
  if (f.kind === 'name' || f.kind === 'text') {
    el.innerHTML = `<span class="sr">${KIND[f.kind]}</span><input type="text" maxlength="120" value="${esc(S.vals[f.id] || '')}" placeholder="${f.kind === 'name' ? 'Your full name' : esc(f.label || 'Type here')}" autocomplete="${f.kind === 'name' ? 'name' : 'off'}">`;
    $('input', el).oninput = (e) => { S.vals[f.id] = e.target.value; update(); };
  } else if (f.kind === 'date') {
    el.type = 'button'; el.disabled = true; el.setAttribute('aria-label', `Date signed: ${S.vals[f.id]}`);
  } else {
    el.type = 'button';
    el.onclick = () => adopt();
  }
  return el;
}
function update() {
  for (const f of S.fields) {
    const el = $(`[data-f="${f.id}"]`); if (!el) continue;
    const ok = filled(f); el.classList.toggle('ok', ok);
    if (f.kind === 'signature' || f.kind === 'initials') {
      const img = f.kind === 'signature' ? S.sig : S.ini;
      el.innerHTML = img ? `<img src="${img}" alt="">` : `<span class="tag">${f.kind === 'signature' ? 'Sign here' : 'Initial'}</span>`;
      el.setAttribute('aria-label', `${KIND[f.kind]}, page ${f.page}: ${img ? 'added (select to change)' : 'not added yet'}`);
    }
    if (f.kind === 'date') el.innerHTML = `<span class="val">${esc(S.vals[f.id])}</span>`;
  }
  const todo = $('#todo'); if (!todo) return;
  const groups = ['signature', 'initials', 'name', 'text', 'date'].map((k) => ({ k, list: S.fields.filter((f) => f.kind === k) })).filter((g) => g.list.length);
  todo.innerHTML = groups.map((g) => { const done = g.list.every(filled); return `<li class="${done ? 'ok' : ''}"><span class="tick" aria-hidden="true">${done ? '✓' : ''}</span>${KIND[g.k]}${g.list.length > 1 ? ` (${g.list.length})` : ''}<span class="sr">${done ? ': done' : ': to do'}</span></li>`; }).join('');
  const left = S.fields.filter((f) => !filled(f)).length;
  S.ready = !left && S.agreed;
  $('#finish').disabled = !S.ready;
  $('#why').textContent = left ? `${left} field${left > 1 ? 's' : ''} still to fill in.` : S.agreed ? 'Ready: press Finish to sign.' : 'Tick “I agree to sign electronically” to finish.';
  $('#mocount').textContent = left ? `${left} to fill in` : S.agreed ? 'Ready to finish' : 'Tick “I agree” below';
  $('#adopt').textContent = `✍ ${S.sig ? 'Change' : 'Adopt'} your signature`;
}

// ---------- adopt a signature (draw or type)
function trimmed(canvas) {
  const ctx = canvas.getContext('2d'); const { width: w, height: h } = canvas; const px = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
function pad(canvas) {
  const ctx = canvas.getContext('2d'); ctx.lineWidth = 3.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#13235a';
  let down = false; let last = null; canvas.dataset.ink = '';
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
  canvas.onpointerdown = (e) => { down = true; last = pos(e); canvas.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.arc(last[0], last[1], 1.4, 0, 7); ctx.fillStyle = '#13235a'; ctx.fill(); canvas.dataset.ink = '1'; canvas.dispatchEvent(new Event('ink')); };
  canvas.onpointermove = (e) => { if (!down) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); last = p; };
  canvas.onpointerup = canvas.onpointercancel = () => { down = false; };
  return () => { ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.dataset.ink = ''; canvas.dispatchEvent(new Event('ink')); };
}
const FONTS = [["'Segoe Script', 'Brush Script MT', 'Snell Roundhand', cursive", 'Script'], ["'Lucida Handwriting', 'Segoe Print', 'Bradley Hand', cursive", 'Handwriting'], ["Georgia, 'Times New Roman', serif", 'Formal']];
function typedPng(text, font, h = 150) {
  const c = document.createElement('canvas'); const ctx = c.getContext('2d'); const size = Math.round(h * 0.55);
  ctx.font = `${size}px ${font}`; const w = Math.max(40, Math.ceil(ctx.measureText(text).width) + 24);
  c.width = Math.min(w, 1400); c.height = h; ctx.font = `${size}px ${font}`; ctx.fillStyle = '#13235a'; ctx.textBaseline = 'middle'; ctx.fillText(text, 12, h / 2);
  return trimmed(c);
}
const initialsOf = (name) => String(name || '').trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 4);

function modal(html, wire) {
  const d = document.createElement('div'); d.className = 'modal'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
  d.innerHTML = `<div class="mbox">${html}</div>`;
  const back = document.activeElement; document.body.appendChild(d); document.body.classList.add('noscroll');
  const close = () => { d.remove(); document.body.classList.remove('noscroll'); if (back && back.focus) back.focus(); };
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  wire(d, close);
  const first = d.querySelector('input, textarea, button'); if (first) first.focus();
  return d;
}
function adopt() {
  const needIni = S.fields.some((f) => f.kind === 'initials');
  const name = S.d.signer.name || '';
  modal(`<h2 id="mt">Adopt your signature</h2>
    <div class="tabs" role="tablist"><button role="tab" class="tab on" aria-selected="true" data-tab="draw">Draw</button><button role="tab" class="tab" aria-selected="false" data-tab="type">Type</button></div>
    <div data-pane="draw">
      <p class="small muted">Sign with your finger, mouse or trackpad.</p>
      <div class="padbox"><canvas id="padS" width="900" height="260" aria-label="Draw your signature here"></canvas><span class="line" aria-hidden="true"></span></div>
      <div class="row"><button class="btn sm" id="clrS">Clear</button></div>
      ${needIni ? `<p class="small muted" style="margin-top:10px">Your initials</p><div class="padbox ini"><canvas id="padI" width="420" height="200" aria-label="Draw your initials here"></canvas></div><div class="row"><button class="btn sm" id="clrI">Clear</button></div>` : ''}
    </div>
    <div data-pane="type" hidden>
      <label class="f"><span>Your full name</span><input id="tName" value="${esc(name)}" maxlength="80" autocomplete="name"></label>
      ${needIni ? `<label class="f"><span>Your initials</span><input id="tIni" value="${esc(initialsOf(name))}" maxlength="6"></label>` : ''}
      <fieldset class="styles"><legend class="small muted">Style</legend>${FONTS.map(([f, l], i) => `<label class="sty"><input type="radio" name="sty" value="${i}"${i ? '' : ' checked'}><span style="font-family:${f}" data-prev="${i}">${esc(name || 'Your name')}</span><span class="sr">${l}</span></label>`).join('')}</fieldset>
    </div>
    <p class="small muted">By adopting it, you agree this mark stands for your signature${needIni ? ' and initials' : ''} on this document.</p>
    <p class="err" id="aerr" role="alert" hidden></p>
    <div class="mfoot"><button class="btn" data-x>Cancel</button><button class="btn p" id="use">Adopt and sign</button></div>`, (d, close) => {
    d.setAttribute('aria-labelledby', 'mt');
    let mode = 'draw';
    const clrS = pad($('#padS', d)); $('#clrS', d).onclick = clrS;
    const clrI = needIni ? pad($('#padI', d)) : null; if (clrI) $('#clrI', d).onclick = clrI;
    $$('[data-tab]', d).forEach((t) => t.onclick = () => {
      mode = t.dataset.tab;
      $$('[data-tab]', d).forEach((x) => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', String(x === t)); });
      $$('[data-pane]', d).forEach((p) => { p.hidden = p.dataset.pane !== mode; });
    });
    const prev = () => { const v = $('#tName', d).value || 'Your name'; $$('[data-prev]', d).forEach((s) => { s.textContent = v; }); };
    $('#tName', d).oninput = () => { prev(); if ($('#tIni', d)) $('#tIni', d).value = initialsOf($('#tName', d).value); };
    $('[data-x]', d).onclick = close;
    $('#use', d).onclick = () => {
      const err = (t) => { const e = $('#aerr', d); e.hidden = false; e.textContent = t; };
      let sig, ini = null;
      if (mode === 'draw') {
        sig = trimmed($('#padS', d)); if (!sig) return err('Draw your signature in the box first.');
        if (needIni) { ini = trimmed($('#padI', d)); if (!ini) return err('Draw your initials in the small box too.'); }
      } else {
        const nm = $('#tName', d).value.trim(); if (!nm) return err('Type your name first.');
        const font = FONTS[Number(($('input[name=sty]:checked', d) || {}).value || 0)][0];
        sig = typedPng(nm, font);
        if (needIni) { const iv = ($('#tIni', d).value || initialsOf(nm)).trim(); if (!iv) return err('Type your initials.'); ini = typedPng(iv, font); }
      }
      S.sig = sig; S.ini = ini; S.method = mode === 'draw' ? 'drawn' : 'typed';
      close(); update(); say('Signature adopted and added to every place you need to sign.');
    };
  });
}

async function finish() {
  if (!S.ready) return;
  const btn = $('#finish'); btn.disabled = true; btn.textContent = 'Signing…';
  const values = {};
  for (const f of S.fields) values[f.id] = f.kind === 'signature' ? S.sig : f.kind === 'initials' ? S.ini : S.vals[f.id];
  try {
    const r = await call('finish', { agree: S.agreed === true, values, method: S.method, day: todayIso() });
    show(r.state === 'completed' ? 'completed' : r.state === 'finishing' ? 'finishing' : 'signed', { ...S.d, ...r, signer: { ...S.d.signer, signed_at: new Date().toISOString() } });
    say('Signed.');
    if (r.state === 'finishing') setTimeout(start, 4000);
  } catch (e) { btn.disabled = false; btn.textContent = 'Finish'; $('#why').textContent = e.message; say(e.message); }
}
function declineBox() {
  const req = S.d.request;
  modal(`<h2 id="dt">Decline to sign</h2>
    <p>${who(req)} will be told you declined, with your reason. The request then closes for everyone.</p>
    <label class="f"><span>Why are you declining?</span><textarea id="why2" rows="4" maxlength="500" placeholder="For example: the price isn't what we agreed."></textarea></label>
    <p class="err" id="derr" role="alert" hidden></p>
    <div class="mfoot"><button class="btn" data-x>Go back</button><button class="btn danger" id="dgo">Decline to sign</button></div>`, (d, close) => {
    d.setAttribute('aria-labelledby', 'dt');
    $('[data-x]', d).onclick = close;
    $('#dgo', d).onclick = async () => {
      const reason = $('#why2', d).value.trim(); const err = (t) => { const e = $('#derr', d); e.hidden = false; e.textContent = t; };
      if (reason.length < 2) return err('Say briefly why you\'re declining.');
      $('#dgo', d).disabled = true;
      try { const r = await call('decline', { reason }); close(); show(r.state || 'you_declined', { ...S.d, reason }); say('You declined to sign.'); }
      catch (e) { $('#dgo', d).disabled = false; err(e.message); }
    };
  });
}

start();
