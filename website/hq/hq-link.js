/* Riyeser HQ: a business's Riyeser Link Office (desk phones), shown in the customer page's <div id="cpLink">.
   Data from hq_company_link(ws) (needs customers.view): the office PC, version, last seen, the address to type into
   phones, the desk phones and extensions. Never passwords: there are none online.
   While the customer has pressed "Let Riyeser help" on their Phones page (1 hour), staff with link.support can make the
   same changes they can: give a phone to someone, take it off, Do not disturb, and Set a new password. Riyeser support
   never sees, sets or receives a password (SEC-009): "Set a new password" asks the office PC to make one itself and set
   the phones up again; it only says "done". Every change is in the HQ history and the customer's.
   Kept separate from hq.js: it fills any #cpLink that appears, finding the business from data-ws (on it or a parent),
   or call RiyeserHQLink.fill(element, ws) yourself. */
(() => {
  'use strict';
  const CFG = window.RIYESER_TEAM || {};
  const DEMO = new URLSearchParams(location.search).has('demo') || !(CFG.supabaseUrl && CFG.supabaseKey);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();
  const mac = (m) => (String(m || '').toUpperCase().match(/../g) || []).join(':');
  const missing = (e) => /PGRST202|Could not find the function|schema cache/i.test(String((e && e.message) || e));
  const OFFLINE_AFTER = 12 * 60000;

  // ---------------------------------------------------------------- talking to the database (or the demo)
  let sb = null;
  function rpc(fn, args) {
    if (DEMO) return demo(fn, args || {});
    if (!sb) sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, storageKey: 'riyeser.hq.session' } });
    return sb.rpc(fn, args || {}).then(({ data, error }) => { if (error) throw error; return data; });
  }
  const D = { cmds: {}, n: 0 };
  function demoData() {
    const t = (m) => new Date(Date.now() - m * 60000).toISOString();
    return D.data || (D.data = { now: new Date().toISOString(), calls: true, can_help: true, support: { until: new Date(Date.now() + 42 * 60000).toISOString() },
      offices: [{ office_id: 'lo-demo', pc_name: 'OFFICE-PC', version: '1.1.0', state: 'running', addresses: ['192.168.1.20'], sip_port: 5060, address_stable: true, pc_mac: '3C:52:82:1A:2B:3C',
        licence: { active: true, state: 'active', text: 'Riyeser Link' }, last_seen: t(2), counts: { calls_in_progress: 1 },
        phones: [['0015654a1b2c', 'Yealink', 'T31P', '101', true], ['0015654a1b2d', 'Yealink', 'T33G', '102', true], ['000b82c1d2e3', 'Grandstream', 'GRP2601P', '201', true],
          ['000b82c1d2e4', 'Grandstream', 'GRP2601P', '202', true], ['0004134a5b6c', 'Snom', 'D735', '103', true], ['0015657d8e9f', 'Yealink', 'T31P', '104', false]]
          .map(([m, v, mo, e, on], i) => ({ mac: m, vendor: v, model: mo, extension: e, assigned: true, registered: on, last_registered: t(on ? 0 : 200), ip: `192.168.1.${31 + i}` }))
          .concat([{ mac: '001565aa0001', vendor: 'Yealink', model: 'T33G', extension: null, assigned: false, registered: false, ip: '192.168.1.50' }]),
        extensions: [{ extension: '100', name: 'Head office', type: 'group', members: 4 }, ...[['101', 'Owner'], ['102', 'Sam Taylor'], ['103', 'Front desk'], ['104', 'Workshop'], ['201', 'Jordan Lee'], ['202', 'Alex Nguyen']]
          .map(([e, n]) => ({ extension: e, name: n, type: 'person', registered: 1, desk_phones: 1, app_users: 0, dnd: false }))] }] });
  }
  async function demo(fn, a) {
    await new Promise((r) => setTimeout(r, 150));
    if (fn === 'hq_company_link') { const d = demoData(); return a.ws === 'none' ? { ...d, offices: [], support: null } : d; }
    if (fn === 'link_command') {
      const id = 'c' + (++D.n); D.cmds[id] = { id, kind: a.kind, status: 'pending' };
      if (a.kind === 'reveal_password') throw new Error('Riyeser support can\'t see phone passwords. Use Set a new password: Riyeser Link Office makes a new one and sets the phones up again, and nobody at Riyeser sees it.');
      setTimeout(() => { D.cmds[id].status = 'done'; }, 1000);
      return id;
    }
    if (fn === 'link_command_state') { const c = D.cmds[a.command]; return { ...c, ready: false }; }
    return null;
  }

  // ---------------------------------------------------------------- what it says
  /** "Link Office: running on OFFICE-PC · v1.1.0 · last seen 2 min ago · 6 phones (5 connected) · address 192.168.1.20 (stable)" */
  function summary(data) {
    const o = data && data.offices && data.offices[0];
    if (!o) return 'Link Office: not set up';
    const now = data.now ? Date.parse(data.now) : Date.now();
    const fresh = now - new Date(o.last_seen) < OFFLINE_AFTER;
    const state = !fresh ? 'offline, last on' : o.state === 'running' ? 'running on' : o.state === 'waiting-licence' ? 'waiting for Riyeser Link on' : o.state === 'error' ? 'not running on' : 'starting on';
    const desk = (o.phones || []).filter((p) => p.assigned); const found = (o.phones || []).length - desk.length;
    return `Link Office: ${state} ${o.pc_name || 'a PC'} · v${o.version || '?'} · last seen ${ago(o.last_seen)} · ${desk.length} phone${desk.length === 1 ? '' : 's'} (${desk.filter((p) => p.registered).length} connected)`
      + `${found ? ` · ${found} new phone${found === 1 ? '' : 's'} found` : ''} · address ${(o.addresses || [])[0] || 'unknown'}${o.sip_port && o.sip_port !== 5060 ? `:${o.sip_port}` : ''} (${o.address_stable === false ? 'not stable' : 'stable'})`;
  }
  const helpLine = (data) => (data.support && new Date(data.support.until) > Date.now()
    ? `Customer allowed help until ${clock(data.support.until)}` : 'Ask the customer to press \'Let Riyeser help\' on their Phones page');

  function render(el, data, ws) {
    const o = data && data.offices && data.offices[0];
    const can = !!(data && data.can_help && data.support && new Date(data.support.until) > Date.now());
    el.dataset.filled = '1';
    if (!o) { el.innerHTML = `<p class="lnk-sum">Link Office: not set up</p>`; return; }
    const people = o.extensions.filter((x) => x.type === 'person');
    const nameOf = (e) => (o.extensions.find((x) => x.extension === e) || {}).name || '';
    const dot = (on) => `<span class="lnk-dot${on ? ' on' : ''}">${on ? '●' : '○'}</span>`;
    el.innerHTML = `<p class="lnk-sum">${esc(summary(data))}</p>
      <p class="lnk-help ${can ? 'on' : ''}">${esc(helpLine(data))}${data.can_help ? '' : ' · <span class="muted">Changing phones needs the link.support permission.</span>'}</p>
      <div class="scroll"><table class="tbl lnk"><tr><th>Phone</th><th>MAC</th><th>For</th><th>Connected</th><th>Address</th>${can ? '<th></th>' : ''}</tr>
      ${o.phones.map((p) => `<tr><td>${esc([p.vendor, p.model].filter(Boolean).join(' ') || 'Desk phone')}</td><td class="mono">${esc(mac(p.mac))}</td>
        <td>${p.assigned ? `<b>${esc(p.extension)}</b> ${esc(nameOf(p.extension))}` : '<span class="pill warn">New phone found</span>'}</td>
        <td>${dot(p.registered)} ${p.registered ? 'Yes' : p.last_registered ? `No · ${ago(p.last_registered)}` : 'No'}</td><td class="mono">${esc(p.ip || '')}</td>
        ${can ? `<td>${p.assigned ? `<button class="btn sm" data-lk="unassign_phone" data-mac="${esc(p.mac)}">Remove</button>`
          : `<select data-give="${esc(p.mac)}" aria-label="Give to"><option value="">Give to…</option>${people.map((x) => `<option value="${esc(x.extension)}">${esc(x.extension)} ${esc(x.name)}</option>`).join('')}</select>`}</td>` : ''}</tr>`).join('')}</table></div>
      <div class="scroll"><table class="tbl lnk"><tr><th>Ext.</th><th>Person or group</th><th>Devices connected</th><th>DND</th>${can ? '<th></th>' : ''}</tr>
      ${o.extensions.map((x) => `<tr><td><b>${esc(x.extension)}</b></td><td>${esc(x.name)}${x.type === 'group' ? ` <span class="muted">ring group · ${x.members || 0}</span>` : ''}</td>
        <td>${x.type === 'group' ? '—' : `${x.registered || 0}${x.app_users ? ` (${x.app_users} app)` : ''}`}</td><td>${x.type === 'group' ? '—' : x.dnd ? 'On' : 'Off'}</td>
        ${can ? `<td>${x.type === 'group' ? '' : `<button class="btn sm" data-lk="new_password" data-ext="${esc(x.extension)}">Set a new password</button>
          <button class="btn sm" data-lk="set_dnd" data-ext="${esc(x.extension)}" data-on="${x.dnd ? '' : '1'}">DND ${x.dnd ? 'off' : 'on'}</button>`}</td>` : ''}</tr>`).join('')}</table></div>
      <div class="lnk-stat" role="status"></div>`;
    const stat = el.querySelector('.lnk-stat');
    const say = (h, c = '') => { stat.className = `lnk-stat ${c}`; stat.innerHTML = h; };
    const send = async (kind, d) => {
      say('Sending to Riyeser Link Office…');
      let id; try { id = await rpc('link_command', { ws, office_id: o.office_id, kind, data: d }); } catch (e) { say(esc(e.message || e), 'bad'); return null; }
      const start = Date.now();
      while (Date.now() - start < 5 * 60000) {
        await new Promise((r) => setTimeout(r, 1500));
        let st; try { st = await rpc('link_command_state', { command: id }); } catch (e) { say(esc(e.message || e), 'bad'); return null; }
        if (st.status === 'failed') { say(esc(st.error || 'That didn\'t work.'), 'bad'); return null; }
        if (st.status === 'done') { say(kind === 'new_password' ? `Done: Riyeser Link Office made a new password for extension ${esc(d.extension)} and is setting its phones up again. Nobody at Riyeser sees it; the customer can see it on their Phones page.` : 'Done', 'ok'); return id; }
        if (Date.now() - start > 45000) say('Riyeser Link Office hasn\'t picked this up yet. It checks every 30 seconds while the office PC is on.', 'warn');
      }
      return null;
    };
    el.querySelectorAll('[data-lk]').forEach((b) => b.onclick = async () => {
      const k = b.dataset.lk; const d = k === 'unassign_phone' ? { mac: b.dataset.mac } : k === 'set_dnd' ? { extension: b.dataset.ext, on: !!b.dataset.on } : { extension: b.dataset.ext };
      if (k !== 'set_dnd' && !confirm(k === 'unassign_phone' ? 'Remove this phone from its person?' : `Ask Riyeser Link Office to make a new password for extension ${b.dataset.ext} and set its phones up again? Nobody at Riyeser sees it. Phones using the old one stop working until they get the new one.`)) return;
      if (await send(k, d) && k !== 'new_password') setTimeout(() => fill(el, ws), 800);   // a new password changes nothing shown here
    });
    el.querySelectorAll('[data-give]').forEach((s) => s.onchange = async () => { if (s.value && await send('assign_phone', { mac: s.dataset.give, extension: s.value })) setTimeout(() => fill(el, ws), 800); });
  }

  async function fill(el, ws) {
    if (!el || !ws) return;
    el.dataset.ws = ws; el.dataset.filled = 'loading';
    try { render(el, await rpc('hq_company_link', { ws }), ws); }
    catch (e) {
      el.dataset.filled = '1';
      el.innerHTML = missing(e) ? '<p class="lnk-sum">Link Office: not set up <span class="muted">(run the latest team-chat.sql to see desk phones here)</span></p>'
        : `<p class="lnk-sum">Link Office: <span class="muted">${esc(e.message || e)}</span></p>`;
    }
  }
  // Which business a #cpLink is for: data-ws on it or a parent, else what hq.js says is open.
  function wsFor(el) {
    const host = el.closest('[data-ws]'); if (host && host.dataset.ws) return host.dataset.ws;
    const S = (window.RiyeserHQ && window.RiyeserHQ.state) || {};
    return S.coId || S.companyId || (S.co && (S.co.id || S.co)) || (S.company && S.company.id) || null;
  }
  function scan() {
    const el = document.getElementById('cpLink');
    if (el && !el.dataset.filled) { const ws = wsFor(el); if (ws) fill(el, typeof ws === 'string' ? ws : String(ws)); }
  }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  if (!document.getElementById('lnk-css')) {
    const st = document.createElement('style'); st.id = 'lnk-css';
    st.textContent = `.lnk-sum{margin:0 0 4px;font-weight:600}.lnk-help{margin:0 0 10px;font-size:13.5px;color:#64708a}.lnk-help.on{color:#15803d;font-weight:600}
      .lnk .mono,.lnk td.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}.lnk-dot{color:#94a3b8}.lnk-dot.on{color:#16a34a}
      table.lnk{margin-bottom:10px}.lnk-stat:empty{display:none}.lnk-stat{padding:8px 10px;border-radius:8px;background:#eef2ff;font-size:14px;overflow-wrap:anywhere}
      .lnk-stat.ok{background:#dcfce7}.lnk-stat.bad{background:#fee2e2}.lnk-stat.warn{background:#fef3c7}`;
    document.head.appendChild(st);
  }
  window.RiyeserHQLink = { fill, render, summary, helpLine };
  scan();
})();
