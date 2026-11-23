// Riyeser admin page. Reads the Riyeser accounts database (server/supabase) as an admin.
// With no config (or ?demo) it shows generated sample data, so the page can be checked before anything is live.
const CFG = window.RIYESER_ADMIN || {};
const DEMO = !CFG.supabaseUrl || !CFG.supabaseKey || new URLSearchParams(location.search).has('demo');
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur = 'AUD') => `${cur === 'AUD' ? '$' : `${cur} `}${(Number(cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const money2 = (cents, cur = 'AUD') => `${cur === 'AUD' ? '$' : `${cur} `}${(Number(cents || 0) / 100).toFixed(2)}`;
const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
const NAMES = { basics: 'Basics', plus: 'Plus', pos: 'POS', payroll: 'Payroll', asbuilt: 'As Built', extra_user: 'Extra user', extra_company: 'Extra company' };
const WHAT = { invoices: ['Accounting Basics', 'invoices'], pos_sales: ['POS', 'sales'], pay_runs: ['Payroll', 'pay runs'], projects: ['As Built', 'projects'] };
const items = (list) => (list || []).map((i) => `${NAMES[i.product] || i.product || '?'}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ');

// ---------- data: Supabase or sample ----------
function supabaseApi(sb) {
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return {
    dashboard: async () => must(await sb.rpc('admin_dashboard', { days: 30 })),
    customers: async (q) => {
      let r = sb.from('accounts').select('id,email,country,created_at,last_seen_at,note,subscriptions(status,items,period_ends_at,cancel_at),devices(id)').order('created_at', { ascending: false }).limit(100);
      if (q) r = r.ilike('email', `%${q}%`);
      return must(await r);
    },
    customer: async (id) => must(await sb.from('accounts').select('*,subscriptions(*),payments(*),devices(*),conversations(id,subject,status,last_message_at)').eq('id', id).single()),
    saveNote: async (id, note) => must(await sb.from('accounts').update({ note }).eq('id', id).select('id')),
    conversations: async () => must(await sb.from('conversations').select('id,subject,status,last_message_at,unread_staff,accounts(email)').order('unread_staff', { ascending: false }).order('last_message_at', { ascending: false }).limit(200)),
    messages: async (id) => must(await sb.from('messages').select('id,body,from_staff,internal,created_at').eq('conversation_id', id).order('id')),
    send: async (id, body, internal) => must(await sb.from('messages').insert({ conversation_id: id, body, internal }).select('id')),
    setConversation: async (id, patch) => must(await sb.from('conversations').update(patch).eq('id', id).select('id')),
  };
}

function demoApi() {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const DAY = 86400000; const now = Date.now(); const iso = (ms) => new Date(ms).toISOString();
  const towns = ['suva', 'nadi', 'lautoka', 'labasa', 'auckland', 'brisbane', 'sigatoka', 'savusavu'];
  const kinds = ['hardware', 'cafe', 'electrical', 'motors', 'pharmacy', 'bakery', 'plumbing', 'fashion', 'builders', 'grocer'];
  const accounts = Array.from({ length: 64 }, (_, i) => {
    const created = now - Math.floor(Math.pow(rnd(), 1.6) * 120) * DAY - Math.floor(rnd() * DAY);
    return { id: `acc-${i}`, email: `${pick(kinds)}.${pick(towns)}${i}@example.com`, country: pick(['FJ', 'FJ', 'FJ', 'NZ', 'AU']), created_at: iso(created), last_seen_at: iso(now - Math.floor(rnd() * 9) * DAY), note: i === 3 ? 'Wants training for 2 staff in January.' : '' };
  });
  const subs = []; const pays = []; const devices = [];
  accounts.forEach((a, i) => {
    const age = (now - Date.parse(a.created_at)) / DAY;
    devices.push({ account_id: a.id, id: `pc-${i}`, name: `${a.email.split('.')[0].toUpperCase()}-PC`, os: 'win32 10.0.22631', versions: { central: pick(['1.4.0', '1.4.0', '1.4.0', '1.3.2']) },
      usage: { invoices: Math.min(50, Math.floor(rnd() * 70)), ...(rnd() < 0.4 ? { pos_sales: Math.min(500, Math.floor(rnd() * 560)) } : {}), ...(rnd() < 0.2 ? { pay_runs: Math.min(4, Math.floor(rnd() * 6)) } : {}) }, last_seen: a.last_seen_at });
    if (age < 12 || rnd() < 0.45) return;
    const prods = [{ product: 'basics', price: 'pri_b', quantity: 1 }, ...(rnd() < 0.4 ? [{ product: 'pos', price: 'pri_pos', quantity: 1 }] : []), ...(rnd() < 0.25 ? [{ product: 'plus', price: 'pri_plus', quantity: 1 }] : []), ...(rnd() < 0.15 ? [{ product: 'extra_company', price: 'pri_co', quantity: 1 + Math.floor(rnd() * 2) }] : [])];
    const started = Date.parse(a.created_at) + Math.floor(rnd() * 10) * DAY;
    const status = rnd() < 0.08 ? 'past_due' : rnd() < 0.06 ? 'canceled' : 'active';
    let ends = started; while (ends < now) ends += 30 * DAY;
    subs.push({ id: `sub_${i}`, account_id: a.id, status, items: prods, period_ends_at: iso(ends), cancel_at: status === 'canceled' ? iso(ends) : rnd() < 0.05 ? iso(ends) : null, updated_at: iso(now - 2 * DAY) });
    const per = prods.reduce((n, p) => n + ({ basics: 2000, pos: 2000, plus: 2000, extra_company: 1000 }[p.product] || 0) * p.quantity, 0);
    for (let t = started, k = 0; t < now; t += 30 * DAY, k++) {
      if (status === 'past_due' && t + 30 * DAY > now) { pays.push({ id: `txn_${i}_${k}`, account_id: a.id, status: 'past_due', total: Math.round(per * 1.1), tax: Math.round(per * 0.1), currency: 'AUD', origin: 'subscription_recurring', billed_at: iso(t) }); break; }
      pays.push({ id: `txn_${i}_${k}`, account_id: a.id, status: 'completed', total: Math.round(per * 1.1), tax: Math.round(per * 0.1), currency: 'AUD', origin: k ? 'subscription_recurring' : 'web', billed_at: iso(t) });
    }
  });
  const mail = (id) => accounts.find((a) => a.id === id).email;
  const convs = [
    { id: 'c1', account_id: 'acc-5', subject: 'Receipts print twice on the till', status: 'open', unread_staff: true, last_message_at: iso(now - 40 * 60000) },
    { id: 'c2', account_id: 'acc-12', subject: 'Can I pay by M-PAiSA?', status: 'open', unread_staff: true, last_message_at: iso(now - 3 * 3600000) },
    { id: 'c3', account_id: 'acc-3', subject: 'Moving to a new computer', status: 'open', unread_staff: false, last_message_at: iso(now - DAY) },
    { id: 'c4', account_id: 'acc-21', subject: 'VAT on the invoice template', status: 'closed', unread_staff: false, last_message_at: iso(now - 4 * DAY) },
  ];
  const msgs = {
    c1: [{ id: 1, body: 'Hi, every sale prints two receipts since yesterday. Epson TM-T20.', from_staff: false, internal: false, created_at: iso(now - 50 * 60000) }, { id: 2, body: 'Also happens on the second till.', from_staff: false, internal: false, created_at: iso(now - 40 * 60000) }],
    c2: [{ id: 3, body: 'Can I pay by M-PAiSA? I don\'t have a card.', from_staff: false, internal: false, created_at: iso(now - 3 * 3600000) }],
    c3: [{ id: 4, body: 'I bought a new laptop. How do I move my books?', from_staff: false, internal: false, created_at: iso(now - 2 * DAY) }, { id: 5, body: 'Install Central on the new laptop and sign in, then Backup → Restore. I can call you to help.', from_staff: true, internal: false, created_at: iso(now - 1.5 * DAY) }, { id: 6, body: 'Called, booked for Thursday 10am.', from_staff: true, internal: true, created_at: iso(now - DAY) }],
    c4: [{ id: 7, body: 'Where do I change the VAT line?', from_staff: false, internal: false, created_at: iso(now - 5 * DAY) }, { id: 8, body: 'Setup → Company → Tax. Fixed!', from_staff: true, internal: false, created_at: iso(now - 4 * DAY) }],
  };
  const PRICE = { basics: 2000, pos: 2000, plus: 2000, extra_company: 1000 };
  const live = subs.filter((s) => ['active', 'past_due'].includes(s.status));
  const caps = { basic: 50, pos: 500, payroll: 4, asbuilt: 3 };
  const paidFor = (id, p) => live.some((s) => s.account_id === id && s.items.some((i) => i.product === p || (p === 'basics' && i.product === 'plus')));
  const near = [];
  devices.forEach((d) => Object.entries(d.usage).forEach(([k, used]) => {
    const [cap, prod] = { invoices: ['basic', 'basics'], pos_sales: ['pos', 'pos'], pay_runs: ['payroll', 'payroll'] }[k] || [];
    if (cap && used >= 0.8 * caps[cap] && !paidFor(d.account_id, prod)) near.push({ email: mail(d.account_id), what: k, used, cap: caps[cap] });
  }));
  near.sort((a, b) => b.used / b.cap - a.used / a.cap);
  const dash = {
    generatedAt: iso(now),
    kpis: { mrrCents: live.reduce((n, s) => n + s.items.reduce((m, i) => m + (PRICE[i.product] || 0) * i.quantity, 0), 0), paying: new Set(live.map((s) => s.account_id)).size, accounts: accounts.length,
      signups: accounts.filter((a) => Date.parse(a.created_at) > now - 30 * DAY).length, activePcs: devices.filter((d) => Date.parse(d.last_seen) > now - 7 * DAY).length,
      pastDue: subs.filter((s) => s.status === 'past_due').length, openChats: convs.filter((c) => c.status === 'open').length, unreadChats: convs.filter((c) => c.unread_staff).length },
    signupsByDay: Array.from({ length: 30 }, (_, k) => { const d = new Date(now - (29 - k) * DAY).toISOString().slice(0, 10); return { day: d, n: accounts.filter((a) => a.created_at.slice(0, 10) === d).length }; }),
    revenueByMonth: Array.from({ length: 12 }, (_, k) => { const m = new Date(); m.setDate(1); m.setMonth(m.getMonth() - (11 - k)); const key = m.toISOString().slice(0, 7); return { month: key, cents: pays.filter((p) => p.status === 'completed' && p.billed_at.slice(0, 7) === key).reduce((n, p) => n + p.total - p.tax, 0) }; }),
    renewalsDue: live.filter((s) => s.status === 'active' && Date.parse(s.period_ends_at) < now + 14 * DAY).map((s) => ({ email: mail(s.account_id), at: s.period_ends_at, items: s.items, cancelling: !!s.cancel_at })).sort((a, b) => a.at.localeCompare(b.at)),
    pastDueList: subs.filter((s) => s.status === 'past_due').map((s) => ({ email: mail(s.account_id), since: s.updated_at, items: s.items })),
    recentPayments: pays.slice().sort((a, b) => b.billed_at.localeCompare(a.billed_at)).slice(0, 15).map((p) => ({ email: mail(p.account_id), total: p.total, currency: p.currency, status: p.status, origin: p.origin, at: p.billed_at })),
    nearCap: near.slice(0, 12),
    versions: devices.reduce((o, d) => { const k = `central ${d.versions.central}`; o[k] = (o[k] || 0) + 1; return o; }, {}),
  };
  const withEmail = (c) => ({ ...c, accounts: { email: mail(c.account_id) } });
  return {
    dashboard: async () => dash,
    customers: async (q) => accounts.filter((a) => !q || a.email.includes(q.toLowerCase())).sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((a) => ({ ...a, subscriptions: subs.filter((s) => s.account_id === a.id), devices: devices.filter((d) => d.account_id === a.id) })),
    customer: async (id) => ({ ...accounts.find((a) => a.id === id), subscriptions: subs.filter((s) => s.account_id === id), payments: pays.filter((p) => p.account_id === id),
      devices: devices.filter((d) => d.account_id === id), conversations: convs.filter((c) => c.account_id === id) }),
    saveNote: async (id, note) => { accounts.find((a) => a.id === id).note = note; },
    conversations: async () => convs.slice().sort((a, b) => (b.unread_staff - a.unread_staff) || b.last_message_at.localeCompare(a.last_message_at)).map(withEmail),
    messages: async (id) => msgs[id] || [],
    send: async (id, body, internal) => { (msgs[id] = msgs[id] || []).push({ id: Date.now(), body, from_staff: true, internal, created_at: iso(Date.now()) }); const c = convs.find((x) => x.id === id); c.last_message_at = iso(Date.now()); if (!internal) c.status = 'open'; },
    setConversation: async (id, patch) => Object.assign(convs.find((c) => c.id === id), patch),
  };
}

// ---------- charts: one series, bars from the baseline, hover tooltip, table view ----------
const tip = $('#tip');
function showTip(e, html) { tip.innerHTML = html; tip.hidden = false; const r = tip.getBoundingClientRect(); tip.style.left = `${Math.min(e.clientX + 12, innerWidth - r.width - 8)}px`; tip.style.top = `${e.clientY - r.height - 10}px`; }
function barChart({ rows, label, value, fmt, tickEvery = 1, tipLabel = label }) {
  const W = 560, H = 190, L = 44, B = 24, T = 8, n = rows.length;
  const max = Math.max(1, ...rows.map(value));
  const step = niceStep(max); const top = Math.ceil(max / step) * step;
  const bw = (W - L) / n; const gap = 2; const y = (v) => T + (H - T - B) * (1 - v / top);
  const ticks = []; for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const bars = rows.map((r, i) => {
    const v = value(r); const x = L + i * bw + gap / 2; const w = Math.max(1, bw - gap); const h = (H - B) - y(v);
    const rad = Math.min(4, w / 2, h);
    const path = h <= 0 ? '' : `M${x},${H - B} V${y(v) + rad} q0,-${rad} ${rad},-${rad} H${x + w - rad} q${rad},0 ${rad},${rad} V${H - B} Z`;
    return `<g data-i="${i}"><rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}"/><path class="bar" d="${path}"/></g>`;
  }).join('');
  const xl = rows.map((r, i) => (i % tickEvery === 0 || (i === n - 1 && i % tickEvery >= tickEvery / 2) ? `<text class="axis" x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(label(r, true))}</text>` : '')).join('');
  const yl = ticks.map((v) => `<line class="gridline" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v, true))}</text>`).join('');
  const id = `c${Math.random().toString(36).slice(2, 8)}`;
  setTimeout(() => {
    const svg = document.getElementById(id); if (!svg) return;
    svg.addEventListener('mousemove', (e) => { const g = e.target.closest('g[data-i]'); if (!g) { tip.hidden = true; return; } const r = rows[+g.dataset.i]; showTip(e, `<b>${esc(fmt(value(r)))}</b>${esc(tipLabel(r))}`); });
    svg.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
  return `<div class="chart"><svg id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">${yl}${bars}${xl}</svg></div>
    <details class="tableview"><summary>Show as table</summary><table><tbody>${rows.map((r) => `<tr><td>${esc(tipLabel(r))}</td><td class="num">${esc(fmt(value(r)))}</td></tr>`).join('')}</tbody></table></details>`;
}
function niceStep(max) { const raw = max / 4; const p = 10 ** Math.floor(Math.log10(raw)); const m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

// ---------- views ----------
let api = null; let tab = 'overview';
const views = {
  async overview() {
    const d = await api.dashboard(); const k = d.kpis;
    setChatCount(k.unreadChats);
    const tiles = [
      ['Monthly recurring revenue', money(k.mrrCents), 'before tax, from active plans', 'hero'],
      ['Paying customers', k.paying, `of ${k.accounts} accounts`],
      ['Sign-ups, last 30 days', k.signups, 'new Riyeser accounts'],
      ['PCs active this week', k.activePcs, 'checked in with Central'],
      ['Failed payments', k.pastDue, k.pastDue ? '<span class="status warn">⚠ card retrying</span>' : '<span class="status good">✓ none</span>'],
      ['Chats waiting', k.unreadChats, `${k.openChats} open`],
    ];
    const monthName = (m, short) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, short ? { month: 'short' } : { month: 'long', year: 'numeric' });
    const dayName = (dd, short) => new Date(`${dd}T00:00:00`).toLocaleDateString(undefined, short ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short' });
    const table = (rows, head, row, empty) => (rows.length ? `<table><thead><tr>${head}</tr></thead><tbody>${rows.map(row).join('')}</tbody></table>` : `<div class="empty">${empty}</div>`);
    const versions = Object.entries(d.versions || {}).sort((a, b) => b[1] - a[1]);
    const vmax = Math.max(1, ...versions.map((v) => v[1]));
    return `<div class="kpis">${tiles.map(([kk, v, s, cls]) => `<div class="tile ${cls || ''}"><div class="k">${kk}</div><div class="v">${esc(v)}</div><div class="s">${s}</div></div>`).join('')}</div>
      <div class="grid2">
        <div class="card"><h2>Sign-ups per day</h2><p class="hint">New Riyeser accounts, last 30 days</p>${barChart({ rows: d.signupsByDay, label: (r, s) => dayName(r.day, s), value: (r) => r.n, fmt: (v, short) => (short ? String(v) : `${v} sign-up${v === 1 ? '' : 's'}`), tickEvery: 7 })}</div>
        <div class="card"><h2>Revenue per month</h2><p class="hint">Payments received, before tax (AUD)</p>${barChart({ rows: d.revenueByMonth, label: (r, s) => monthName(r.month, s), value: (r) => r.cents, fmt: (v) => money(v), tickEvery: 2 })}</div>
      </div>
      <div class="grid2">
        <div class="card"><h2>Near their free limit</h2><p class="hint">Not paying for that program yet: good people to contact</p>
          ${d.nearCap.length ? `<div class="meters">${d.nearCap.map((n) => `<div class="meter"><span class="name">${esc(n.email)} <span class="muted">· ${esc((WHAT[n.what] || [n.what])[0])}</span></span><span class="fig">${n.used} of ${n.cap} ${esc((WHAT[n.what] || [, ''])[1])}</span><div class="track"><div class="fill" style="width:${Math.min(100, (n.used / n.cap) * 100)}%"></div></div></div>`).join('')}</div>` : '<div class="empty">Nobody is close to a limit.</div>'}</div>
        <div class="card"><h2>Renewals in the next 14 days</h2>
          ${table(d.renewalsDue, '<th>Customer</th><th>Plan</th><th>Renews</th>', (r) => `<tr><td>${esc(r.email)}</td><td>${esc(items(r.items))}</td><td>${r.cancelling ? '<span class="status warn">Ends</span> ' : ''}${esc(date(r.at))}</td></tr>`, 'No renewals due.')}
          <h3 style="margin-top:16px">Failed payments</h3>
          ${table(d.pastDueList, '<th>Customer</th><th>Plan</th><th>Since</th>', (r) => `<tr><td>${esc(r.email)}</td><td>${esc(items(r.items))}</td><td><span class="status bad">✕ Card failed</span> ${esc(date(r.since))}</td></tr>`, 'None. Paddle retries failed cards and emails the customer.')}</div>
      </div>
      <div class="grid2">
        <div class="card"><h2>Latest payments</h2>
          ${table(d.recentPayments, '<th>Customer</th><th>Type</th><th>Date</th><th class="num">Amount</th>', (p) => `<tr><td>${esc(p.email || '—')}</td><td>${p.status === 'past_due' ? '<span class="status bad">✕ Failed</span>' : p.origin === 'web' ? 'New' : 'Renewal'}</td><td>${esc(date(p.at))}</td><td class="num">${esc(money2(p.total, p.currency))}</td></tr>`, 'No payments yet.')}</div>
        <div class="card"><h2>Central versions in use</h2><p class="hint">PCs seen in the last 30 days</p>
          ${versions.length ? `<div class="meters">${versions.map(([v, n]) => `<div class="meter"><span class="name">${esc(v)}</span><span class="fig">${n} PC${n === 1 ? '' : 's'}</span><div class="track"><div class="fill" style="width:${(n / vmax) * 100}%"></div></div></div>`).join('')}</div>` : '<div class="empty">No PCs yet.</div>'}</div>
      </div>
      <p class="muted">Updated ${esc(dateTime(d.generatedAt))}. <button class="ghost" data-act="reload">Refresh</button></p>`;
  },

  async customers() {
    return `<div class="card"><div class="search"><input type="search" id="q" placeholder="Search by email" value="${esc(state.q)}"><button class="btn s" data-act="search">Search</button></div><div id="custlist">Loading…</div></div><div id="custdetail"></div>`;
  },

  async chats() {
    const list = await api.conversations();
    setChatCount(list.filter((c) => c.unread_staff).length);
    if (!state.conv && list.length) state.conv = list[0].id;
    const cur = list.find((c) => c.id === state.conv);
    const msgs = cur ? await api.messages(cur.id) : [];
    if (cur && cur.unread_staff) { await api.setConversation(cur.id, { unread_staff: false }); cur.unread_staff = false; setChatCount(list.filter((c) => c.unread_staff).length); }
    return `<div class="chats">
      <div class="convlist">${list.length ? list.map((c) => `<button class="conv${c.id === state.conv ? ' on' : ''}" data-act="conv" data-id="${esc(c.id)}"><span class="who"><span>${esc(c.accounts?.email || '?')}</span>${c.unread_staff ? '<span class="pill">new</span>' : c.status === 'closed' ? '<span class="muted">closed</span>' : ''}</span><span class="sub">${esc(c.subject)}</span><span class="sub muted">${esc(dateTime(c.last_message_at))}</span></button>`).join('') : '<div class="empty">No chats yet. Customers write from Riyeser Central → Message us.</div>'}</div>
      <div class="card">${cur ? `<div class="row" style="justify-content:space-between"><div><h2 style="margin:0">${esc(cur.subject)}</h2><span class="muted">${esc(cur.accounts?.email || '')}</span></div><button class="btn s" data-act="close" data-id="${esc(cur.id)}">${cur.status === 'open' ? 'Mark done' : 'Reopen'}</button></div>
        <div class="thread" id="thread">${msgs.map((m) => `<div class="msg${m.internal ? ' note' : m.from_staff ? ' staff' : ''}">${esc(m.body)}<span class="at">${m.internal ? '🔒 Internal note' : m.from_staff ? 'Riyeser' : 'Customer'} · ${esc(dateTime(m.created_at))}</span></div>`).join('')}</div>
        <textarea id="reply" rows="3" placeholder="Reply to the customer…" maxlength="4000"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn" data-act="send" data-id="${esc(cur.id)}">Send reply</button><button class="btn s" data-act="note" data-id="${esc(cur.id)}">Add internal note</button><span class="muted">Internal notes are never shown to the customer.</span></div>` : '<div class="empty">Pick a chat.</div>'}</div></div>`;
  },

  async downloads() {
    let rel = []; let err = null;
    try { const r = await fetch(`https://api.github.com/repos/${CFG.releasesRepo || 'raka1987/Riyeser'}/releases?per_page=30`); if (!r.ok) throw new Error(`GitHub said ${r.status}`); rel = await r.json(); } catch (e) { err = e.message; }
    const by = {};
    for (const r of rel) for (const a of r.assets || []) if (/\.exe$/i.test(a.name)) by[a.name] = (by[a.name] || 0) + a.download_count;
    const rows = Object.entries(by).sort((a, b) => b[1] - a[1]); const max = Math.max(1, ...rows.map((r) => r[1]));
    const nice = (f) => f.replace(/-Setup\.exe$/i, '').replace(/^Riyeser/, 'Riyeser ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return `<div class="grid2"><div class="card"><h2>Installer downloads</h2><p class="hint">All releases on GitHub, live</p>
      ${err ? `<div class="empty">Couldn't load downloads: ${esc(err)}</div>` : rows.length ? `<div class="meters">${rows.map(([f, n]) => `<div class="meter"><span class="name">${esc(nice(f))}</span><span class="fig">${n.toLocaleString()}</span><div class="track"><div class="fill" style="width:${(n / max) * 100}%"></div></div></div>`).join('')}</div>` : '<div class="empty">No installers released yet.</div>'}</div>
      <div class="card"><h2>Website traffic</h2>${CFG.trafficUrl ? `<p>Visits, top pages and where people come from are in Cloudflare Web Analytics.</p><p><a class="btn" href="${esc(CFG.trafficUrl)}" target="_blank" rel="noopener">Open traffic dashboard</a></p>` : '<p class="muted">Not set up yet. Add riyeser.com to Cloudflare Web Analytics (free, no cookie banner needed), paste its one-line script into the website, and put the dashboard link in <code>admin/config.js</code>.</p>'}</div></div>`;
  },
};
const state = { q: '', conv: new URLSearchParams(location.search).get('conv') };

async function show(name = tab) {
  tab = name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  const main = $('#main');
  try { main.innerHTML = await views[name](); } catch (e) { main.innerHTML = `<p class="pad">Couldn't load this: ${esc(e.message)}</p>`; return; }
  if (name === 'customers') listCustomers();
  if (name === 'chats') { const t = $('#thread'); if (t) t.scrollTop = t.scrollHeight; }
}
function setChatCount(n) { const p = $('#chatcount'); p.hidden = !n; p.textContent = n; }

async function listCustomers() {
  const rows = await api.customers(state.q);
  const plan = (c) => { const live = (c.subscriptions || []).filter((s) => ['active', 'trialing', 'past_due'].includes(s.status)); return live.length ? live.map((s) => `${items(s.items)}${s.status === 'past_due' ? ' <span class="status bad">✕ failed</span>' : ''}`).join('; ') : '<span class="muted">Free</span>'; };
  $('#custlist').innerHTML = rows.length ? `<table><thead><tr><th>Email</th><th>Country</th><th>Plan</th><th>Signed up</th><th>Last seen</th><th class="num">PCs</th></tr></thead><tbody>${rows.map((c) => `<tr class="click" data-act="cust" data-id="${esc(c.id)}"><td>${esc(c.email)}</td><td>${esc(c.country || '—')}</td><td>${plan(c)}</td><td>${esc(date(c.created_at))}</td><td>${esc(date(c.last_seen_at))}</td><td class="num">${(c.devices || []).length}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No customers found.</div>';
}
async function showCustomer(id) {
  const c = await api.customer(id);
  const st = (s) => ({ active: '<span class="status good">✓ Active</span>', trialing: '<span class="status good">✓ Trial</span>', past_due: '<span class="status bad">✕ Card failed</span>', canceled: '<span class="status warn">Cancelled</span>', paused: '<span class="status warn">Paused</span>' }[s] || esc(s));
  $('#custdetail').innerHTML = `<div class="card" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(c.email)}</h2><span class="muted">Signed up ${esc(date(c.created_at))} · ${esc(c.country || '')}</span></div>
    <div class="grid2" style="margin-top:12px">
      <div><h3>Subscriptions</h3>${(c.subscriptions || []).length ? `<table><tbody>${c.subscriptions.map((s) => `<tr><td>${esc(items(s.items))}</td><td>${st(s.status)}</td><td>${s.cancel_at ? `ends ${esc(date(s.cancel_at))}` : `renews ${esc(date(s.period_ends_at))}`}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">None: free allowances only.</div>'}
        <h3 style="margin-top:12px">PCs</h3>${(c.devices || []).length ? `<table><tbody>${c.devices.map((d) => `<tr><td>${esc(d.name || d.id)}</td><td>${esc(Object.entries(d.versions || {}).map(([k, v]) => `${k} ${v}`).join(', '))}</td><td>${esc(Object.entries(d.usage || {}).map(([k, v]) => `${v} ${(WHAT[k] || [, k])[1]}`).join(', '))}</td><td>${esc(date(d.last_seen))}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No PCs yet.</div>'}</div>
      <div><h3>Payments</h3>${(c.payments || []).length ? `<table><tbody>${c.payments.slice().sort((a, b) => String(b.billed_at).localeCompare(String(a.billed_at))).slice(0, 12).map((p) => `<tr><td>${esc(date(p.billed_at))}</td><td>${p.status === 'past_due' ? '<span class="status bad">✕ Failed</span>' : esc(p.status)}</td><td class="num">${esc(money2(p.total, p.currency))}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No payments.</div>'}
        <h3 style="margin-top:12px">Staff note</h3><textarea id="note" rows="3" placeholder="Only staff see this">${esc(c.note || '')}</textarea><div class="row" style="margin-top:6px"><button class="btn s" data-act="savenote" data-id="${esc(c.id)}">Save note</button></div>
        ${(c.conversations || []).length ? `<h3 style="margin-top:12px">Chats</h3>${c.conversations.map((v) => `<div><button class="ghost" data-act="openconv" data-id="${esc(v.id)}">💬 ${esc(v.subject)}</button></div>`).join('')}` : ''}</div>
    </div></div>`;
  $('#custdetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-tab]'); if (t) return show(t.dataset.tab);
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act; const id = b.dataset.id;
  try {
    if (a === 'reload') return show();
    if (a === 'search') { state.q = $('#q').value.trim(); return listCustomers(); }
    if (a === 'cust') return showCustomer(id);
    if (a === 'savenote') { b.disabled = true; await api.saveNote(id, $('#note').value); b.textContent = 'Saved'; return; }
    if (a === 'openconv') { state.conv = id; return show('chats'); }
    if (a === 'conv') { state.conv = id; return show('chats'); }
    if (a === 'send' || a === 'note') {
      const body = $('#reply').value.trim(); if (!body) return;
      b.disabled = true; await api.send(id, body, a === 'note'); return show('chats');
    }
    if (a === 'close') { const list = await api.conversations(); const c = list.find((x) => x.id === id); await api.setConversation(id, { status: c.status === 'open' ? 'closed' : 'open' }); return show('chats'); }
  } catch (err) { alert(err.message); b.disabled = false; }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'q') { state.q = e.target.value.trim(); listCustomers(); } });
$('#themebtn').addEventListener('click', () => { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; localStorage.setItem('riyeser-admin-theme', r.dataset.theme); if (tab === 'overview') show(); });
if (localStorage.getItem('riyeser-admin-theme')) document.documentElement.dataset.theme = localStorage.getItem('riyeser-admin-theme');

// ---------- sign in (email code), then check this account is an admin ----------
async function start() {
  if (DEMO) { api = demoApi(); $('#demo').hidden = false; $('#tabs').hidden = false; $('#who').textContent = 'sample data'; const t = new URLSearchParams(location.search).get('tab'); return show(views[t] ? t : 'overview'); }
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const sb = createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return signIn(sb);
  api = supabaseApi(sb);
  try { await api.dashboard(); } catch (e) {
    $('#main').innerHTML = `<div class="signin"><h2>Not an admin</h2><p>${esc(session.user.email)} isn't on the admin list. Ask the owner to add you.</p><button class="btn s" id="out">Sign out</button></div>`;
    $('#out').onclick = async () => { await sb.auth.signOut(); location.reload(); };
    return;
  }
  $('#tabs').hidden = false; $('#who').innerHTML = `${esc(session.user.email)} · <button class="ghost" id="out">Sign out</button>`;
  $('#out').onclick = async () => { await sb.auth.signOut(); location.reload(); };
  show('overview');
  setInterval(async () => { try { const d = await api.dashboard(); setChatCount(d.kpis.unreadChats); } catch { /* offline */ } }, 60000);
}
function signIn(sb) {
  let email = '';
  const draw = (sent, msg = '') => {
    $('#main').innerHTML = `<div class="signin"><h2>Sign in</h2><p class="muted">Staff only. We email you a 6-digit code.</p>
      <input type="email" id="em" placeholder="you@riyeser.com" value="${esc(email)}" ${sent ? 'disabled' : ''}>
      ${sent ? '<input type="text" id="code" inputmode="numeric" placeholder="123456" autocomplete="one-time-code">' : ''}
      <button class="btn" id="go">${sent ? 'Sign in' : 'Email me a code'}</button><p class="muted">${esc(msg)}</p></div>`;
    $('#go').onclick = async () => {
      if (!sent) { email = $('#em').value.trim(); const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } }); return draw(!error, error ? error.message : 'Code sent.'); }
      const { error } = await sb.auth.verifyOtp({ email, token: $('#code').value.trim(), type: 'email' });
      if (error) return draw(true, error.message);
      location.reload();
    };
  };
  draw(false);
}
start();
