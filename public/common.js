// Shared helpers for the public site and the staff portal
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur = 'FJD') => n == null || n === '' ? '—' : `${cur === 'FJD' ? 'FJ$' : cur + ' '}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtTime = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
const fmtDate = (d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-FJ', opts) : '';
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(window.__tsUnlock && window.__tsUnlock.until > Date.now() ? { 'X-TS-Unlock': window.__tsUnlock.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null; try { data = await res.json(); } catch { }
  // Staff portal: if the login has expired (e.g. after the site restarted), go back to the login screen.
  // (only for someone who was logged in: on the login screen a 401 is expected and must not reload the page)
  if (res.status === 401 && location.pathname.startsWith('/staff') && !url.startsWith('/api/auth/') && window.__loggedIn) {
    if (!window.__relogin) { window.__relogin = true; toast('Your login has expired — please log in again.'); setTimeout(() => location.reload(), 1500); }
  }
  if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

function toast(msg, ms = 3200) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}

function openModal(html, { wide = false, onClose } = {}) {
  const root = document.getElementById('modal-root') || document.body;
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><button class="x" aria-label="Close">×</button>${html}</div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', key); onClose && onClose(); };
  const key = e => { if (e.key === 'Escape') close(); };
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  $('.x', bg).onclick = close;
  document.addEventListener('keydown', key);
  root.appendChild(bg);
  const first = $('input, select, textarea', bg); if (first) setTimeout(() => first.focus(), 30);
  return { el: $('.modal', bg), close };
}

function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value;
  }
  return o;
}

// Live connection with auto-reconnect
function connectLive(onMessage, onStatus) {
  let ws, retry = 1000;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { retry = 1000; onStatus && onStatus(true); };
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch { } };
    ws.onclose = () => { onStatus && onStatus(false); setTimeout(open, retry); retry = Math.min(retry * 2, 15000); };
  };
  open();
  return () => ws;
}

// Sponsor logos for an event. Returns '' when there are none (nothing is shown).
function sponsorStrip(list, { title = 'Sponsored by', cls = '' } = {}) {
  if (!list || !list.length) return '';
  const one = s => {
    const inner = s.logo ? `<img src="${esc(s.logo)}" alt="${esc(s.name || 'Sponsor')}" loading="lazy">` : `<span class="sp-name">${esc(s.name)}</span>`;
    const body = `${inner}${s.label ? `<small>${esc(s.label)}</small>` : ''}`;
    return s.url ? `<a class="sp-item" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.name)}">${body}</a>` : `<span class="sp-item" title="${esc(s.name)}">${body}</span>`;
  };
  return `<div class="sponsors ${cls}"><span class="sp-title">${title}</span><div class="sp-logos">${list.map(one).join('')}</div></div>`;
}
