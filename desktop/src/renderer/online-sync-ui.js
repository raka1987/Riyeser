// Riyeser Central: "Online connections" on the home screen, the "Connect your website" guide, the activity trail,
// and its part of Settings (which PC brings the items in). The sync itself runs in the main process
// (central/online-sync.js); this only shows it.
//
// The panel says one of: Not set up (grey, with Set up) · Connected, nothing new (green) · Working (counts, recent)
// · a real Problem (red, with the fix, Details and Get help) · No connection (amber) · Off on this PC (which PC does it)
// · Paused (demo mode). Nothing red unless something is really wrong.
(() => {
  const KIND = { booking: 'Booking', order: 'Order', order_request: 'Order request', enquiry: 'Enquiry', customer: 'Customer', quote_accept: 'Quote accepted', invoice_payment: 'Payment' };
  const OUT = { done: '', rejected: 'turned down', retry: 'trying again' };
  const since = (t) => (t ? ago(t).replace(/^Just now$/, 'just now') : 'not yet');
  const STATUS = { ok: 'OK', done: 'Filed', rejected: 'Turned down', retry: 'Trying again', waiting: 'Waiting', error: 'Problem', info: 'Note' };
  const CHOICES = [
    ['booking', 'A booking form', 'Customers pick a service and a free time on your website. Needs Riyeser Bookings.'],
    ['enquiry', 'An enquiry form', 'Questions and quote requests, with a call-back reminder.'],
    ['order', 'An order button', '“Order” buttons on your products: you confirm each one.'],
    ['shop', 'An online shop', 'Your shop sends paid orders and reads prices and stock.'],
    ['developer', 'Something my developer builds', 'The full API, documented on riyeser.com/developers.'],
  ];
  const BUILDERS = [
    ['WordPress', 'Edit the page, add a <b>Custom HTML</b> block where the form should go, paste, then <b>Update</b>.'],
    ['Wix', '<b>Add Elements → Embed Code → Embed HTML</b>, choose <b>Code</b>, paste, then <b>Update</b> and publish.'],
    ['Squarespace', 'Edit the page, add a <b>Code</b> block, paste, untick <b>Display source</b>, then <b>Save</b>.'],
    ['Shopify', '<b>Online Store → Themes → Customize</b>, add a <b>Custom Liquid</b> section, paste, then <b>Save</b>.'],
    ['Plain HTML', 'Paste it in your page where the form should appear, before <code>&lt;/body&gt;</code>, and upload.'],
  ];
  let st = null;
  const dotOf = { not_setup: 'off', waiting: 'ok', working: 'ok', problem: 'bad', offline: 'idle', off: 'off', paused: 'off', starting: 'off', idle: 'off' };

  function panelBody(s) {
    const v = s.view;
    const line = (head, sub = '') => `<div class="os-line" data-view="${esc(v)}"><span class="os-dot ${dotOf[v] || 'off'}"></span><div class="grow">${head}${sub ? `<div class="os-sub">${sub}</div>` : ''}</div></div>`;
    const sent = s.lastPublishAt ? `prices, stock and free times sent ${esc(since(s.lastPublishAt))}` : '';
    const links = (extra = '') => `<div class="os-acts">${extra}<button class="lnk" data-os="trail">Activity</button><button class="lnk" data-os="guide">Set-up guide</button></div>`;
    if (v === 'not_setup') {
      return `${line('<b>Online connections aren\'t set up.</b> Connect your website or online shop so bookings and orders come in by themselves.')}
        <div class="os-acts os-cta"><button class="btn sm" data-os="guide" id="ossetup">Set up</button><button class="lnk" data-os="trail">Activity</button></div>`;
    }
    if (v === 'off') {
      const who = s.syncPc ? esc(s.syncPc) : 'Another PC';
      return `${line(`<b>Off on this PC.</b> ${who} brings in what your website sends.`, s.otherPc ? 'Automatic: the PC with the company file does it. If that\'s this PC, choose “This PC” in Settings → Online connections.' : 'Turn it on in Settings → Online connections if this PC should do it.')}${links()}`;
    }
    if (v === 'paused') return line(`<b>Paused: demo mode is on.</b>`, 'What your website sends waits in your online post box until you leave demo mode.');
    if (v === 'starting') return line('<b>Checking…</b>', 'Riyeser Central is looking at your online post box.');
    if (v === 'offline') return `${line('<b>No connection to Riyeser Online</b>', `Last tried ${esc(since(s.lastTryAt))}. Nothing is lost: orders and bookings wait in your post box and come in when the internet is back.`)}${links()}`;
    const c = s.counts || {};
    const waitingTxt = [c.waiting ? `${c.waiting} waiting in the post box` : '', c.failed ? `<span class="bad">${c.failed} need a look in Riyeser Online</span>` : '', sent].filter(Boolean).join(' · ');
    let html = '';
    if (v === 'problem') {
      html += line('<b>Online connections need a look</b>', [`Last tried ${esc(since(s.lastTryAt))}`, waitingTxt].filter(Boolean).join(' · '));
      html += `<div class="os-problem" role="alert"><b>${esc(s.message)}</b>${s.fix ? `<div class="os-fix">${esc(s.fix)}</div>` : ''}
        <div class="os-acts">${s.ref ? `<span class="lbl">Reference ${esc(s.ref)}</span>` : ''}<button class="lnk" data-os="details">Details</button><button class="lnk" data-os="help">Get help</button></div></div>`;
    } else if (v === 'waiting') {
      html += line(`<b>Connected</b> · last checked ${esc(since(s.lastCheckAt || s.lastSyncAt))} · nothing new`, waitingTxt);
    } else {
      html += line(`<b>${s.receivedToday} received today</b> · last sync ${esc(since(s.lastSyncAt))}`, waitingTxt);
    }
    if (s.publishNote) html += `<div class="os-sub warn">${esc(s.publishNote)}</div>`;
    const recent = (s.recent || []).filter((r) => !r.test).slice(0, 5);
    if (v === 'working' && recent.length) html += recent.map((r) => `<div class="li"><span class="h">${esc(fmtTime(r.at))}</span><span class="grow">${esc(KIND[r.kind] || r.kind)}${r.customer ? ` · ${esc(r.customer)}` : ''}${r.reference ? ` <span class="lbl">${esc(r.reference)}</span>` : ''}</span>${OUT[r.outcome] ? `<span class="lbl warn">${esc(OUT[r.outcome])}</span>` : ''}</div>`).join('');
    html += links(s.test && s.test.step === 'sent' ? '<span class="lbl">Test on its way…</span>' : '');
    return html;
  }

  function render() {
    const box = $('#onlinep'); if (!box || !st) return;
    // only for a PC linked to an online business (sign-in problems are shown on the Company page)
    box.hidden = st.view === 'idle';
    if (box.hidden) return;
    $('#online').innerHTML = panelBody(st);
    $('#onlinenow').hidden = !st.syncing || st.view === 'not_setup';
    const radio = document.querySelector(`input[name="osmode"][value="${st.mode}"]`); if (radio) radio.checked = true;
    if (guideOpen()) drawGuide();
  }
  async function load() { st = await bridge.call('onlineSync:status').catch(() => null); render(); }

  // ---------- "Connect your website": five steps, a checklist that ticks itself, and Send a test ----------
  let pick = 'booking'; let testKind = null; let poll = null;
  const guideOpen = () => !!document.querySelector('dialog.osguide[open]');
  function guideHtml() {
    const s = st || {}; const cl = s.checklist || []; const t = s.test; const done = (id) => (cl.find((x) => x.id === id) || {}).done;
    const widget = ['booking', 'enquiry', 'order'].includes(pick);
    const kind = testKind || (pick === 'booking' ? 'booking' : ['order', 'shop'].includes(pick) ? 'order' : 'enquiry');
    const prog = !t ? '' : t.step === 'arrived'
      ? `<div class="og-prog ok" id="ogprog" role="status"><b>✓ It arrived on ${esc(t.pc || 'this PC')}.</b> ${esc([t.reference, t.message].filter(Boolean).join(' · ') || 'Filed as a test.')} Nothing was added to your books.</div>`
      : `<div class="og-prog" id="ogprog" role="status"><b>Sent ${esc(since(t.at))}.</b> It's in your post box${t.cloudStatus === 'taken' ? `; ${esc(t.pc || 'a PC')} is filing it now` : '; the sync PC brings it in within a minute'}…</div>`;
    const step = (n, title, body, ok) => `<li class="og-step${ok ? ' done' : ''}" id="ogs${n}"><span class="og-n" aria-hidden="true">${ok ? '✓' : n}</span><div><h3>${title}</h3>${body}</div></li>`;
    return `<h2 class="lichead">Connect your website <button class="x" data-og="close" aria-label="Close">✕</button></h2>
      <div class="ogbody">
        <div class="og-top"><div class="og-flowbox">${flowSvg()}</div>
          <div class="og-check" id="ogcheck"><b>Your checklist</b><ul>${cl.map((c) => `<li class="${c.done ? 'on' : ''}" data-check="${esc(c.id)}"><span class="tk" aria-hidden="true">${c.done ? '✓' : ''}</span><span>${esc(c.text)}</span></li>`).join('')}</ul>
          <div class="lbl">${s.lastCheckAt ? `Checked with Riyeser Online ${esc(since(s.lastCheckAt))}.` : 'Ticks itself from what really happens.'}</div></div></div>
        <ol class="og-steps">
          ${step(1, 'Choose what you want on your website', `<div class="og-choices" role="radiogroup" aria-label="What you want">${CHOICES.map(([v, l, d]) => `<label><input type="radio" name="ogpick" value="${v}"${pick === v ? ' checked' : ''}><span><b>${l}</b><small>${d}</small></span></label>`).join('')}</div>`, false)}
          ${step(2, 'Make the key in Riyeser Link', `<p>An owner or admin opens <b>Riyeser Link → Management → Connections</b> (it asks for your two-step code) and makes a key: <b>+ New key → ${widget ? 'Website booking widget' : pick === 'shop' ? 'Online shop orders' : 'Custom / developer'}</b>. ${widget ? 'List your website\'s address (like https://www.yourbusiness.com) so the key only works there.' : 'It\'s secret: give it only to your shop\'s settings or your developer.'} Make a <b>Test</b> key first to try it safely.</p>
            <div class="os-acts"><button class="btn sm" data-og="connections">Open Management → Connections</button></div>`, done('key'))}
          ${step(3, widget ? 'Copy the code into your website' : 'Put the key in your shop or give it to your developer', widget
            ? `<p class="lbl">Connections → <b>Add to your website</b> fills in your key and colours. It looks like this:</p><pre class="og-snip">${esc(`<script src="https://riyeser.com/widget/book.js" data-key="rk_pub_live_…"${pick !== 'booking' ? ` data-type="${pick}"` : ''} async></script>`)}</pre>
              <dl class="og-where">${BUILDERS.map(([n, h]) => `<dt>${n}</dt><dd>${h}</dd>`).join('')}</dl>`
            : `<p>${pick === 'shop' ? 'Your shop\'s server sends each paid order to <code>POST /v1/orders</code> and reads <code>/v1/prices</code> and <code>/v1/stock</code>.' : 'Everything your developer needs, with examples.'} <button class="lnk" data-og="developers">riyeser.com/developers</button></p>`, done('request'))}
          ${step(4, 'Send a test', `<p>Sends a test through your Riyeser Online post box and shows it arriving within a minute or two. It goes through every check but <b>never touches your books</b>.</p>
            <div class="og-test"><select id="ogkind" aria-label="What to send">${[['enquiry', 'A test enquiry'], ['booking', 'A test booking'], ['order', 'A test order request']].map(([v, l]) => `<option value="${v}"${kind === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <button class="btn sm" data-og="test" id="ogsend"${t && t.step === 'sent' ? ' disabled' : ''}>Send a test</button></div>${prog}<div id="ogerr"></div>`, t && t.step === 'arrived')}
          ${step(5, 'Done', `<p>When every line of the checklist is ticked, it's linked. New bookings, orders and enquiries then show on this home screen, and every sync is in <button class="lnk" data-og="trail">Activity</button>. <button class="lnk" data-og="help">How online connections work</button></p>`, cl.length && cl.every((c) => c.done))}
        </ol>
      </div>`;
  }
  function flowSvg() {
    const box = (x, t1, t2, cls) => `<rect x="${x}" y="30" width="152" height="58" rx="11" class="${cls}"/><text x="${x + 76}" y="55" font-weight="700" class="t1">${t1}</text><text x="${x + 76}" y="74" class="t2">${t2}</text>`;
    return `<svg class="og-flow" viewBox="0 0 690 120" role="img" aria-label="Your website sends to the Riyeser Online post box; Riyeser Central on your sync PC collects it every minute and files it in your programs; prices, stock and free times go back.">
      <defs><marker id="oga" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ar"/></marker></defs>
      <g font-size="12" text-anchor="middle">${box(2, 'Your website', 'form · shop · widget', 'b1')}${box(180, 'Riyeser Online', 'post box (waits safely)', 'b2')}
      ${box(358, 'Your sync PC', 'Riyeser Central', 'b3')}${box(536, 'Your programs', 'Bookings, POS, Accounts', 'b3')}
      <path d="M156 50H176M334 50H354M512 50H532" class="ln" marker-end="url(#oga)"/><path d="M534 70H514M356 70H336M178 70H158" class="ln back" marker-end="url(#oga)"/>
      <text x="345" y="18" class="t2">bookings, orders, enquiries, payments →</text><text x="345" y="110" class="t2">← prices, stock, free times, “confirmed”, “ready”</text></g></svg>`;
  }
  function drawGuide() {
    const d = document.querySelector('dialog.osguide'); if (!d) return;
    const y = (d.querySelector('.ogbody') || {}).scrollTop || 0;
    d.innerHTML = guideHtml();
    const b = d.querySelector('.ogbody'); if (b) b.scrollTop = y;
  }
  function openGuide() {
    document.querySelectorAll('dialog.osguide').forEach((x) => x.remove());
    const d = document.createElement('dialog'); d.className = 'licdlg osguide'; d.setAttribute('aria-label', 'Connect your website');
    document.body.appendChild(d);
    d.addEventListener('close', () => { d.remove(); clearInterval(poll); poll = null; });
    d.addEventListener('change', (e) => { if (e.target.name === 'ogpick') { pick = e.target.value; testKind = null; drawGuide(); } if (e.target.id === 'ogkind') testKind = e.target.value; });
    d.addEventListener('click', (e) => {
      const a = e.target.closest('[data-og]'); if (!a) return;
      const w = a.dataset.og;
      if (w === 'close') d.close();
      else if (['connections', 'developers', 'help'].includes(w)) safe(() => bridge.call('onlineSync:open', w));
      else if (w === 'trail') { d.close(); openTrail(); }
      else if (w === 'test') sendTest(d);
    });
    drawGuide(); d.showModal();
    poll = setInterval(async () => { if (st && st.test && st.test.step === 'sent') { st = await bridge.call('onlineSync:testStatus').catch(() => st); render(); } }, 5000);
  }
  async function sendTest(d) {
    const btn = d.querySelector('#ogsend'); const kind = (d.querySelector('#ogkind') || {}).value || 'enquiry';
    btn.disabled = true; btn.textContent = 'Sending…';
    try { st = await bridge.call('onlineSync:sendTest', kind); testKind = kind; render(); drawGuide(); } catch (e) {
      btn.disabled = false; btn.textContent = 'Send a test';
      const err = d.querySelector('#ogerr'); if (err) err.innerHTML = `<div class="og-prog bad" role="alert"><b>The test couldn't be sent.</b> ${esc(e.message)}</div>`;
    }
  }

  // ---------- the activity trail: every sync and item, filter by day / status / kind, save as CSV ----------
  const tq = { day: '', status: '', type: '' };
  async function drawTrail(d) {
    const r = await bridge.call('onlineSync:trail', tq).catch(() => ({ rows: [], days: [], total: 0 }));
    const sel = (id, label, cur, opts) => `<label class="tf"><span>${label}</span><select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    const filtered = tq.day || tq.status || tq.type;
    d.innerHTML = `<h2 class="lichead">Online activity <button class="x" data-ot="close" aria-label="Close">✕</button></h2>
      <div class="otbody"><p class="lbl">Every sync on this PC and everything that came in or went out: when, from where, what happened. Kept 90 days.</p>
        <div class="ot-bar">${sel('otday', 'Day', tq.day, [['', 'Any day'], ...r.days.map((x) => [x, new Date(`${x}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })])])}
          ${sel('otst', 'Status', tq.status, [['', 'Everything'], ['problems', 'Problems'], ['done', 'Filed'], ['rejected', 'Turned down'], ['retry', 'Trying again'], ['ok', 'Checks and publishing'], ['error', 'Errors']])}
          ${sel('ottype', 'Kind', tq.type, [['', 'All kinds'], ['item', 'Items'], ['run', 'Sync runs'], ['publish', 'Publishing'], ['test', 'Tests'], ['problem', 'Problems'], ['setup', 'Setup']])}
          <div class="ot-end">${filtered ? '<button class="btn s sm" data-ot="clear">Clear filters</button>' : ''}<span class="lbl"><b>${r.rows.length}</b> of ${r.total}</span><button class="btn sm" data-ot="csv">Export CSV</button></div></div>
        <div class="ot-wrap"><table class="ot"><thead><tr><th>When</th><th>What happened</th><th>Source</th><th>Status</th><th>Ref.</th></tr></thead><tbody>
        ${r.rows.length ? r.rows.map((x) => `<tr data-type="${esc(x.type)}"><td class="w">${esc(new Date(x.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}${x.n > 1 ? `<div class="lbl">${x.n} checks</div>` : ''}</td>
          <td><b>${esc(x.what)}</b>${x.detail ? `<div class="lbl">${esc(x.detail)}</div>` : ''}</td><td>${esc(x.source || '')}</td><td class="w"><span class="ot-st ${esc(x.status)}">${esc(STATUS[x.status] || x.status)}</span></td><td class="w">${esc(x.ref || '')}</td></tr>`).join('')
          : `<tr><td colspan="5" class="lbl">${filtered ? 'Nothing matches these filters.' : 'Nothing yet. Every sync that does something shows here.'}</td></tr>`}
        </tbody></table></div></div>`;
  }
  function openTrail(preset = {}) {
    Object.assign(tq, { day: '', status: '', type: '' }, preset);
    document.querySelectorAll('dialog.ostrail').forEach((x) => x.remove());
    const d = document.createElement('dialog'); d.className = 'licdlg ostrail'; d.setAttribute('aria-label', 'Online activity');
    document.body.appendChild(d); d.addEventListener('close', () => d.remove());
    d.addEventListener('change', (e) => { const k = { otday: 'day', otst: 'status', ottype: 'type' }[e.target.id]; if (k) { tq[k] = e.target.value; drawTrail(d); } });
    d.addEventListener('click', (e) => {
      const a = e.target.closest('[data-ot]'); if (!a) return;
      if (a.dataset.ot === 'close') d.close();
      if (a.dataset.ot === 'clear') { Object.assign(tq, { day: '', status: '', type: '' }); drawTrail(d); }
      if (a.dataset.ot === 'csv') safe(async () => { const f = await bridge.call('onlineSync:exportTrail', tq); if (f) toast('Saved.'); });
    });
    drawTrail(d).then(() => { d.showModal(); const f = d.querySelector('#otst'); if (f) f.focus(); });
  }

  function getHelp() {
    const R = window.RiyeserCentralReport; if (!R) return;
    R.reportIssue({ product: st.problemProduct || 'central', what: 'Online connections on the Riyeser Central home screen show a problem.',
      error: `${st.ref ? `${st.ref} ` : ''}${st.message || ''}`.slice(0, 300) });
  }

  function settingsBox() {
    const body = $('#setdlg .setbody'); if (!body || $('#osbox')) return;
    const box = document.createElement('div'); box.id = 'osbox';
    box.style.cssText = 'margin-top:18px;padding:14px 16px;border:1px solid var(--line);border-radius:12px';
    box.innerHTML = `<b>Online connections</b>
      <p style="margin:6px 0 10px;font-size:13px;line-height:1.45">One PC in the business brings in bookings, orders and payments from your website and sends back prices, stock and free times. It needs Riyeser Accounting, Bookings or POS and the company file.</p>
      <label class="setrow"><input type="radio" name="osmode" value="auto"><span><b>Automatic</b><small>The PC that has the company file does it. Best for most businesses.</small></span></label>
      <label class="setrow" style="margin-top:8px"><input type="radio" name="osmode" value="on"><span><b>This PC</b><small>Choose this on the PC that holds the company file if Automatic doesn't pick it.</small></span></label>
      <label class="setrow" style="margin-top:8px"><input type="radio" name="osmode" value="off"><span><b>Off on this PC</b><small>Another PC does it, or you don't take orders online.</small></span></label>
      <p style="margin:10px 0 0;font-size:12.5px"><button class="lnk" type="button" data-os="guide">Connect your website (set-up guide)</button> · <button class="lnk" type="button" data-os="trail">Activity</button></p>`;
    body.appendChild(box);
    box.addEventListener('change', (e) => { if (e.target.name === 'osmode') safe(async () => { st = await bridge.call('onlineSync:setMode', e.target.value); render(); toast('Saved.'); }); });
  }
  settingsBox();
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-os]'); if (!a) return;
    const w = a.dataset.os;
    if (w === 'guide') { const sd = $('#setdlg'); if (sd && sd.open) sd.close(); openGuide(); }
    if (w === 'trail') { const sd = $('#setdlg'); if (sd && sd.open) sd.close(); openTrail(); }
    if (w === 'details') openTrail({ status: 'problems' });
    if (w === 'help') getHelp();
  });
  $('#onlinenow').addEventListener('click', () => safe(async () => { $('#onlinenow').disabled = true; try { st = await bridge.call('onlineSync:now'); render(); } finally { $('#onlinenow').disabled = false; } }));
  if (bridge && bridge.on) {
    bridge.on('online-sync', (s) => { st = s; render(); });
    bridge.on('online-sync:open', () => { if (typeof setView === 'function') setView('home'); const b = $('#onlinep'); if (b) b.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  }
  load();
  setInterval(load, 60 * 1000);
  window.RiyeserOnlineSync = { load, render: (s) => { st = s; render(); }, openGuide, openTrail, panelBody,
    guideHtml: (s, p) => { const keep = [st, pick]; st = s; if (p) pick = p; const h = guideHtml(); [st, pick] = keep; return h; } };
})();
