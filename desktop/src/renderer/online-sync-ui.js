// Riyeser Central: "Online connections" on the home screen (what came in from the website, last sync, problems with
// a plain fix) and its part of Settings (which PC brings the items in). The sync itself runs in the main process
// (central/online-sync.js); this only shows it.
(() => {
  const KIND = { booking: 'Booking', order: 'Order', order_request: 'Order request', enquiry: 'Enquiry', customer: 'Customer', quote_accept: 'Quote accepted', invoice_payment: 'Payment' };
  const OUT = { done: '', rejected: 'turned down', retry: 'trying again' };
  const since = (t) => (t ? ago(t).replace(/^Just now$/, 'just now') : 'not yet');
  let st = null;
  function render() {
    const box = $('#onlinep'); if (!box || !st) return;
    // only for a PC linked to an online business (sign-in problems are shown on the Company page)
    box.hidden = /isn't linked|Not signed in/.test(st.message || '') && !st.syncing;
    if (box.hidden) return;
    const dot = st.syncing ? (st.state === 'ok' ? 'ok' : st.state === 'starting' ? 'idle' : 'bad') : 'idle';
    const head = st.syncing
      ? `<b>${st.receivedToday} received today</b>, last sync ${esc(since(st.lastSyncAt))}`
      : `<b>${esc(st.message)}</b>`;
    const problem = st.syncing && st.state !== 'ok' && st.state !== 'starting' && st.message
      ? `<div class="os-problem"><b>${esc(st.message)}</b>${st.fix ? `<br>${esc(st.fix)}` : ''}</div>` : '';
    const fix = !st.syncing && st.fix ? `<div class="os-sub">${esc(st.fix)}</div>` : '';
    const waiting = st.counts && st.syncing ? `<div class="os-sub">${st.counts.waiting || 0} waiting in the post box${st.counts.failed ? ` · <span class="bad">${st.counts.failed} need a look in Riyeser Online</span>` : ''}${st.lastPublishAt ? ` · prices, stock and free times sent ${esc(since(st.lastPublishAt))}` : ''}</div>` : '';
    const note = st.publishNote ? `<div class="os-sub warn">${esc(st.publishNote)}</div>` : '';
    const recent = (st.recent || []).filter((r) => !r.test).slice(0, 5);
    $('#online').innerHTML = `<div class="os-line"><span class="os-dot ${dot}"></span><div class="grow">Online connections: ${head}${waiting}${fix}</div></div>${problem}${note}
      ${recent.length ? recent.map((r) => `<div class="li"><span class="h">${esc(fmtTime(r.at))}</span><span class="grow">${esc(KIND[r.kind] || r.kind)}${r.customer ? ` · ${esc(r.customer)}` : ''}${r.reference ? ` <span class="lbl">${esc(r.reference)}</span>` : ''}</span>${OUT[r.outcome] ? `<span class="lbl warn">${esc(OUT[r.outcome])}</span>` : ''}</div>`).join('')
        : (st.syncing ? '<div class="empty">Nothing from your website yet today. Bookings and orders show here as they come in.</div>' : '')}`;
    $('#onlinenow').hidden = !st.syncing;
    const radio = document.querySelector(`input[name="osmode"][value="${st.mode}"]`); if (radio) radio.checked = true;
  }
  async function load() { st = await bridge.call('onlineSync:status').catch(() => null); render(); }
  function settingsBox() {
    const body = $('#setdlg .setbody'); if (!body || $('#osbox')) return;
    const box = document.createElement('div'); box.id = 'osbox';
    box.style.cssText = 'margin-top:18px;padding:14px 16px;border:1px solid var(--line);border-radius:12px';
    box.innerHTML = `<b>Online connections</b>
      <p style="margin:6px 0 10px;font-size:13px;line-height:1.45">One PC in the business brings in bookings, orders and payments from your website and sends back prices, stock and free times. It needs Riyeser Accounting, Bookings or POS and the company file.</p>
      <label class="setrow"><input type="radio" name="osmode" value="auto"><span><b>Automatic</b><small>The PC that has the company file does it. Best for most businesses.</small></span></label>
      <label class="setrow" style="margin-top:8px"><input type="radio" name="osmode" value="on"><span><b>This PC</b><small>Choose this on the PC that holds the company file if Automatic doesn't pick it.</small></span></label>
      <label class="setrow" style="margin-top:8px"><input type="radio" name="osmode" value="off"><span><b>Off on this PC</b><small>Another PC does it, or you don't take orders online.</small></span></label>`;
    body.appendChild(box);
    box.addEventListener('change', (e) => { if (e.target.name === 'osmode') safe(async () => { st = await bridge.call('onlineSync:setMode', e.target.value); render(); toast('Saved.'); }); });
  }
  settingsBox();
  $('#onlinenow').addEventListener('click', () => safe(async () => { $('#onlinenow').disabled = true; try { st = await bridge.call('onlineSync:now'); render(); } finally { $('#onlinenow').disabled = false; } }));
  if (bridge && bridge.on) {
    bridge.on('online-sync', (s) => { st = s; render(); });
    bridge.on('online-sync:open', () => { if (typeof setView === 'function') setView('home'); const b = $('#onlinep'); if (b) b.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  }
  load();
  setInterval(load, 60 * 1000);
  window.RiyeserOnlineSync = { load, render: (s) => { st = s; render(); } };
})();
