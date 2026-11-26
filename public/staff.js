// Staff portal
let ME = null, CAN = new Set(), S = {}, ON_SHIFT = null, LABELS = {}, AREAS = {}, LEVELS = [], PRESETS = {};
let VIEW = 'dashboard';
const rank = r => ({ staff: 1, manager: 2, admin: 3 })[r] || 0;
// access by area: 0 Hidden · 1 View · 2 Add & edit · 3 Full (the server checks every request; this only tidies the screens)
const L = a => (ME && ME.perms && ME.perms[a]) || 0;
const isAdmin = () => ME.role === 'admin';             // Administrator: Full everywhere, and the only one who changes access
const wide = () => !ME.team_only;                      // sees everyone (not only their own team)
const roleName = r => ({ staff: 'Everyone', manager: 'Managers', admin: 'Administrators' })[r] || r;
const accessName = e => e.role === 'admin' ? 'Administrator' : (PRESETS[e.preset] || {}).label || (e.access && Object.values(e.access).every(v => !v) ? 'Employee self-service' : 'Custom');
const accessChip = e => `<span class="chip ${e.role === 'admin' ? 'coral' : e.access && Object.values(e.access).some(v => v) ? '' : 'gray'}">${esc(accessName(e))}</span>`;
const tsUnlocked = () => !!(window.__tsUnlock && window.__tsUnlock.until > Date.now());
const canTS = () => L('timesheets') >= 2 || tsUnlocked(); // can enter/edit other people's timesheets (their team's, for a supervisor; or unlocked by PIN)
const cur = () => S.currency || 'FJD';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: S.timezone || 'Pacific/Fiji' }).format(new Date());
const view = () => $('#view');

// ------------------------------------------------------------------ views registry
const VIEWS = {
  dashboard: { title: 'Dashboard', group: 'Today', render: renderDashboard },
  timeclock: { title: 'Time clock', group: 'Today', render: renderTimeclock, show: () => CAN.has('timeclock.use') },
  timesheets: { title: 'Timesheets', group: 'People', render: renderTimesheets },
  roster: { title: 'Roster', group: 'People', render: () => renderRoster() },   // OWNER-ROSTER (roster.js)
  employees: { title: 'Staff', group: 'People', render: renderEmployees, show: () => L('employees') >= 1 },
  payroll: { title: 'Payroll', group: 'Pay', render: renderPayroll, show: () => L('payroll') >= 1 },
  history: { title: 'Pay history', group: 'Pay', render: renderHistory, show: () => L('payroll') >= 1 },
  import: { title: 'Import wage reports', group: 'Pay', render: renderImport, show: () => L('payroll') >= 2 && L('employees') >= 2 && L('pay_rates') >= 2 },
  bank: { title: 'Bank statements', group: 'Pay', render: renderBank, show: () => L('payroll') >= 1 },
  mypay: { title: 'My payslips', group: 'Pay', render: renderMyPayslips },
  logins: { title: 'Login history', group: 'Admin', render: renderLogins, show: () => isAdmin() },
  audit: { title: 'Audit trail', group: 'Admin', render: renderAudit, show: () => isAdmin() },
  settings: { title: 'Settings & access', group: 'Admin', render: renderSettings, show: () => L('setup') >= 1 },
  account: { title: 'My account', group: 'Admin', render: renderAccount },
};

function renderMenu() {
  let html = '', g = '';
  for (const [k, v] of Object.entries(VIEWS)) {
    if (v.show && !v.show()) continue;
    if (v.group !== g) { g = v.group; html += `<div class="grp">${g}</div>`; }
    html += `<a href="#/${k}" class="${k === VIEW ? 'on' : ''}">${v.title}</a>`;
  }

  $('#menu').innerHTML = html;

}
// Phone toolbars are a two-column grid: if the last row has a single item, stretch it across so nothing sits alone
function evenToolbars(root = document) {
  if (window.innerWidth > 600) return;
  root.querySelectorAll('.bar-tools').forEach(bar => {
    let col = 0, last = null;
    for (const el of bar.children) {
      el.classList.remove('bt-span');
      const cs = getComputedStyle(el); if (cs.display === 'none') continue;
      if (cs.gridColumnEnd === '-1') { col = 0; last = null; continue; }
      col ^= 1; last = el;
    }
    if (col === 1 && last) last.classList.add('bt-span');
  });
}
new MutationObserver(() => { clearTimeout(window.__evT); window.__evT = setTimeout(evenToolbars, 30); }).observe(document.documentElement, { childList: true, subtree: true });
async function go() {
  if (!ME) return;
  const k = location.hash.replace(/^#\/?/, '') || 'dashboard';
  VIEW = VIEWS[k] && (!VIEWS[k].show || VIEWS[k].show()) ? k : 'dashboard';
  $('#view-title').textContent = VIEWS[VIEW].title;
  if (window.closeSideMenu) window.closeSideMenu(); else $('#side').classList.remove('open');
  $$('.modal-bg .x').forEach(x => x.click()); // close any open dialog when changing page
  window.scrollTo(0, 0);
  renderMenu();
  await drawLicence();
  try { await VIEWS[VIEW].render(); } catch (e) { view().innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', go);

// ------------------------------------------------------------------ licence (the server decides; this only shows it)
// Without Payroll's licence: everything can still be seen and printed and the time clock works; new pay runs and
// pay-rate changes are locked, with what to do and a button to the Riyeser home page.
let LIC = { licensed: true };
async function drawLicence() {
  try { LIC = await api('/api/staff/licence'); } catch { LIC = { licensed: true }; }
  const b = $('#lic-banner'); if (!b) return;
  // OWNER-BANNER: on the Dashboard and Payroll pages only; a notice (Payroll still works) can be hidden for the day
  const hideKey = () => `${today()}|${LIC.message || ''}`;
  let hiddenToday = false; try { hiddenToday = localStorage.getItem('lic-banner-hidden') === hideKey(); } catch { }
  const show = ['dashboard', 'payroll'].includes(VIEW) && (!LIC.licensed || (!!LIC.message && !hiddenToday));
  b.hidden = !show;
  b.className = `lic-banner${LIC.licensed ? ' soon' : ''}`;
  b.innerHTML = show ? `<span>${LIC.licensed ? 'ℹ️' : '🔒'}</span><div class="grow">${esc(LIC.message || '')}${LIC.licensed && LIC.grace_until ? '<div class="small">Pay runs carry on as normal until then.</div>' : ''}</div>${LIC.licensed ? '<button type="button" class="btn sm ghost" id="lic-hide">Hide for today</button>' : `<a class="btn sm" href="${esc(LIC.home_url)}" target="_blank" rel="noopener">Open Riyeser home</a>`}` : '';
  if ($('#lic-hide')) $('#lic-hide').onclick = () => { try { localStorage.setItem('lic-banner-hidden', hideKey()); } catch { } b.hidden = true; };
}

// ------------------------------------------------------------------ generic form helpers
// def: { n: name, l: label, t: type, o: options, req, step, ph, full, dis }
function fieldsHTML(defs, v = {}) {
  return `<div class="grid2">${defs.map(d => {
    const val = v[d.n] ?? d.def ?? '';
    const attrs = `name="${d.n}" ${d.req ? 'required' : ''} ${d.dis ? 'disabled' : ''} ${d.step ? `step="${d.step}"` : ''} ${d.min != null ? `min="${d.min}"` : ''} ${d.max != null ? `max="${d.max}"` : ''} placeholder="${esc(d.ph || '')}"`;
    let input;
    if (d.t === 'select') input = `<select ${attrs}>${d.o.map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}" ${String(ov) === String(val) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
    else if (d.t === 'textarea') input = `<textarea ${attrs} rows="${d.rows || 4}">${esc(val)}</textarea>`;
    else if (d.t === 'checkbox') return `<div class="field" style="${d.full ? 'grid-column:1/-1' : ''}"><label class="check"><input type="checkbox" name="${d.n}" ${val ? 'checked' : ''} ${d.dis ? 'disabled' : ''}> ${esc(d.l)}</label></div>`;
    else input = `<input type="${d.t || 'text'}" value="${esc(val)}" ${attrs}>`;
    return `<div class="field" style="${d.full ? 'grid-column:1/-1' : ''}"><label>${esc(d.l)}</label>${input}${d.help ? `<div class="small muted">${d.help}</div>` : ''}</div>`;
  }).join('')}</div>`;
}
function editModal(title, defs, values, onSave, { onDelete, extra = '', wide = false, readOnly = false } = {}) {
  const m = openModal(`<h2 style="font-size:1.5rem">${esc(title)}</h2><form><div class="err"></div>${fieldsHTML(readOnly ? defs.map(d => ({ ...d, dis: true })) : defs, values)}${extra}
    <div class="actions">${readOnly ? '' : '<button class="btn">Save</button>'}${onDelete ? '<button type="button" class="btn danger del">Delete</button>' : ''}</div></form>`, { wide });
  const f = $('form', m.el);
  f.onsubmit = async e => {
    e.preventDefault();
    if (f.dataset.busy) return; // a double press saves once (no duplicates)
    f.dataset.busy = '1'; const sb = $('.actions > .btn:not(.danger):not([type=button])', f); if (sb) sb.disabled = true;
    try { await onSave(formData(f), m); m.close(); } catch (err) { $('.err', f).innerHTML = `<div class="error">${esc(err.message)}</div>`; }
    finally { delete f.dataset.busy; if (sb) sb.disabled = false; }
  };
  if (onDelete) $('.del', f).onclick = async () => { if (!confirm('Delete this permanently?')) return; try { await onDelete(); m.close(); } catch (err) { $('.err', f).innerHTML = `<div class="error">${esc(err.message)}</div>`; } };
  return m;
}
const table = (cols, rows, { onRow, empty = 'Nothing here yet.' } = {}) => rows.length ? `<div class="scroll"><table class="t"><thead><tr>${cols.map(c => `<th class="${c.r ? 'r' : ''}">${c.h}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r, i) => `<tr class="${onRow ? 'click' : ''}" data-i="${i}">${cols.map(c => `<td class="${c.r ? 'r' : ''}" data-l="${esc(String(c.h || '').replace(/<[^>]*>/g, ''))}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : `<div class="empty">${empty}</div>`;
function bindRows(container, rows, fn) { $$('tr.click', container).forEach(tr => tr.onclick = e => { if (e.target.closest('button,input,select,a')) return; fn(rows[tr.dataset.i]); }); }
const initials = n => n.split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
const colorFor = id => `hsl(${(id * 67) % 360} 45% 38%)`;

// ------------------------------------------------------------------ phone menu: open / close
(() => {
  const side = $('#side'), bd = $('#side-backdrop');
  const set = open => { side.classList.toggle('open', open); bd.classList.toggle('on', open); document.body.classList.toggle('menu-open', open); };
  $('#menu-btn').onclick = () => set(!side.classList.contains('open'));
  $('#side-close').onclick = () => set(false);
  bd.onclick = () => set(false);
  // tapping any menu link closes it, even the page you're already on
  $('#menu').addEventListener('click', e => { if (e.target.closest('a')) set(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') set(false); });
  // swipe left on the menu to close it
  let x0 = null;
  side.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  side.addEventListener('touchend', e => { if (x0 != null && x0 - e.changedTouches[0].clientX > 60) set(false); x0 = null; }, { passive: true });
  window.closeSideMenu = () => set(false);
})();

// ------------------------------------------------------------------ timesheets
// Multi-shift entry (like a schedule grid): a row per shift — date, staff member, start, finish, paid hours, note
function multiShiftModal(emps, day, after) {
  let br = []; try { br = JSON.parse(S.payroll_breaks || '[]'); } catch { }
  const paid = (a, b) => { if (!a || !b) return ''; const [h1, m1] = a.split(':').map(Number), [h2, m2] = b.split(':').map(Number); const h = (h2 * 60 + m2 - h1 * 60 - m1) / 60; if (!(h > 0)) return '';
    const r = br.filter(x => h > +x.after_hours).sort((x, y) => y.minutes - x.minutes)[0]; return (h - (r ? Math.min(h, r.minutes / 60) : 0)).toFixed(2); };
  const empSel = id => `<select data-c="user"><option value="">Staff member…</option>${emps.map(e => `<option value="${e.id}" ${e.id == id ? 'selected' : ''}>${esc(e.name)}${e.employee_no ? ' · ' + esc(e.employee_no) : ''}</option>`).join('')}</select>`;
  const row = (r = {}) => `<tr class="ms-row"><td><input type="date" data-c="date" value="${r.date || day}"></td><td>${empSel(r.user)}</td>
    <td><input type="time" data-c="in" value="${r.in || ''}"></td><td><input type="time" data-c="out" value="${r.out || ''}"></td>
    <td class="r"><b data-c="paid">${paid(r.in, r.out)}</b></td><td><input data-c="note" placeholder="Note" value="${esc(r.note || '')}"></td>
    <td><button type="button" class="btn sm ghost" data-copy title="Copy this row">⧉</button> <button type="button" class="btn sm ghost" data-rm title="Remove">✕</button></td></tr>
    <tr class="ms-err"><td colspan="7" class="small" style="color:var(--red)"></td></tr>`;
  const m = openModal(`<h2 style="font-size:1.4rem">🗓 Multi-shift entry</h2>
    <p class="small muted">Pick the date, times and staff (or All staff) at the top and press <b>Add</b>; change any row below. Paid hours take off the unpaid break. Rows that save disappear; any with a problem stay with the reason.</p>
    <div class="bar-tools" style="margin:6px 0"><label class="small">Date <input type="date" id="ms-day" value="${day}"></label>
      <label class="small">Start <input type="time" id="ms-in" value="${S.normal_start || '09:00'}"></label><label class="small">Finish <input type="time" id="ms-out" value="${S.normal_finish || '17:00'}"></label>
      <label class="small">Staff <select id="ms-who"><option value="all">All staff</option>${emps.map(e => `<option value="${e.id}">${esc(e.name)}${e.employee_no ? ' · ' + esc(e.employee_no) : ''}</option>`).join('')}</select></label>
      <button type="button" class="btn sm" id="ms-all">Add</button><button type="button" class="btn sm ghost" id="ms-add">+ Blank row</button></div>
    <div class="scroll"><table class="t ms-table"><thead><tr><th>Date</th><th>Staff</th><th>Start</th><th>Finish</th><th class="r">Paid hrs</th><th>Note</th><th></th></tr></thead><tbody id="ms-body"></tbody></table></div>
    <div class="actions"><button type="button" class="btn coral" id="ms-save">Save changes</button><span class="small muted" id="ms-count" style="align-self:center"></span></div>`, { wide: true });
  m.el.style.maxWidth = '1050px';
  const body = $('#ms-body', m.el);
  const count = () => { const rs = $$('.ms-row', m.el); const tot = rs.reduce((a, r) => a + (+$('[data-c=paid]', r).textContent || 0), 0); $('#ms-count', m.el).textContent = `${rs.length} shift${rs.length === 1 ? '' : 's'} · ${tot.toFixed(2)} paid hours`; };
  const bind = () => {
    $$('.ms-row', m.el).forEach(r => {
      const upd = () => { $('[data-c=paid]', r).textContent = paid($('[data-c=in]', r).value, $('[data-c=out]', r).value); count(); };
      ['in', 'out'].forEach(k => $(`[data-c=${k}]`, r).oninput = upd);
      $('[data-rm]', r).onclick = () => { r.nextElementSibling.remove(); r.remove(); count(); };
      $('[data-copy]', r).onclick = () => { r.nextElementSibling.insertAdjacentHTML('afterend', row({ date: $('[data-c=date]', r).value, in: $('[data-c=in]', r).value, out: $('[data-c=out]', r).value, note: $('[data-c=note]', r).value })); bind(); };
    });
    count();
  };
  bind();
  const defaults = () => ({ date: $('#ms-day', m.el).value, in: $('#ms-in', m.el).value, out: $('#ms-out', m.el).value });
  $('#ms-add', m.el).onclick = () => { body.insertAdjacentHTML('beforeend', row(defaults())); bind(); };
  $('#ms-all', m.el).onclick = () => {
    // drop empty rows, then a row for everyone not already listed for that date
    $$('.ms-row', m.el).forEach(r => { if (!$('[data-c=user]', r).value) { r.nextElementSibling.remove(); r.remove(); } });
    const d = defaults(), who = $('#ms-who', m.el).value, have = $$('.ms-row', m.el).filter(r => $('[data-c=date]', r).value === d.date).map(r => $('[data-c=user]', r).value);
    const pick = who === 'all' ? emps.filter(e => !have.includes(String(e.id))) : emps.filter(e => String(e.id) === who);
    if (!pick.length) return toast(who === 'all' ? 'Everyone already has a row for that date' : 'Choose a staff member');
    body.insertAdjacentHTML('beforeend', pick.map(e => row({ ...d, user: e.id })).join('')); bind();
  };
  $('#ms-save', m.el).onclick = async () => {
    const rs = $$('.ms-row', m.el);
    const entries = rs.map(r => { const d = $('[data-c=date]', r).value, a = $('[data-c=in]', r).value, b = $('[data-c=out]', r).value;
      return { user_id: $('[data-c=user]', r).value, clock_in: d && a ? `${d}T${a}` : '', clock_out: d && b ? `${b < a ? addDays(d, 1) : d}T${b}` : '', notes: $('[data-c=note]', r).value }; });
    if (!entries.length) return toast('Add a shift first');
    const btn = $('#ms-save', m.el); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await api('/api/staff/timesheets/bulk', { body: { entries } });
      r.results.forEach(x => { const tr = rs[x.i]; if (x.ok) { tr.nextElementSibling.remove(); tr.remove(); } else tr.nextElementSibling.firstElementChild.textContent = '⚠ ' + x.error; });
      toast(`✅ ${r.saved} shift${r.saved === 1 ? '' : 's'} saved${r.failed ? ` · ${r.failed} need fixing` : ''}`, 5000); after(); count();
      if (!r.failed) m.close();
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = 'Save changes';
  };
}
// Timesheets by person: a card each — days worked, paid hours, each shift on one line (tap to edit), warnings, quick add
function tsPersonCards(rows, emps, f) {
  const by = {}; rows.forEach(r => (by[r.user_id] = by[r.user_id] || { name: r.name, no: r.employee_no, list: [] }).list.push(r));
  // people with timesheet access see everyone on the clock (so a shift can be added for someone with none yet)
  if (canTS() && !f.user_id) emps.forEach(e => { if (!by[e.id]) by[e.id] = { name: e.name, no: e.employee_no, list: [] }; });
  const ids = Object.keys(by).sort((a, b) => by[a].name.localeCompare(by[b].name));
  if (!ids.length) return '<div class="empty">No shifts in this period. Use "Clock in" in the sidebar to start a shift.</div>';
  const day = f.to && f.to <= today() ? f.to : today();
  return `<div class="ts-cards">${ids.map(id => {
    const P = by[id], list = P.list.slice().sort((a, b) => a.clock_in.localeCompare(b.clock_in));
    const paid = list.reduce((a, r) => a + (r.clock_out ? (r.paid_hours ?? r.hours) : 0), 0), days = new Set(list.map(r => r.clock_in.slice(0, 10))).size;
    const flag = r => !r.clock_out ? '<span class="ts-flag">still clocked in</span>' : r.hours > 12 ? '<span class="ts-flag">over 12 h — forgot to clock out?</span>' : r.hours < 0.25 ? '<span class="ts-flag">under 15 min</span>' : '';
    const warn = list.filter(r => flag(r)).length;
    const span = f.from && f.to ? Math.round((Date.parse(f.to) - Date.parse(f.from)) / 864e5) + 1 : 99;
    // the Add row picks a day of these dates (the first weekday with no hours), or any date when the dates are long
    const have = new Set(list.map(r => r.clock_in.slice(0, 10))), dl = span <= 31 ? QE.days(f.from, f.to) : [];
    const pick = dl.find(d => !have.has(d) && ![0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()) && d <= today()) || (dl.includes(day) ? day : dl[dl.length - 1]);
    const dateBox = dl.length ? `<select name="d" aria-label="Day">${dl.map(d => `<option value="${d}" ${d === pick ? 'selected' : ''}>${QE.dayShort(d)}</option>`).join('')}</select>` : `<input type="date" name="d" value="${day}" aria-label="Date">`;
    return `<div class="panel ts-card" data-card="${id}"><div class="ts-head"><div><b>${esc(P.name)}</b>${P.no ? ` <span class="small muted">${esc(P.no)}</span>` : ''}</div>
        <div class="ts-sum"><span><b>${days}</b> day${days === 1 ? '' : 's'}</span><span><b>${paid.toFixed(2)}</b> paid h</span>${warn ? `<span class="ts-flag">⚠ ${warn}</span>` : ''}</div></div>
      ${list.length ? `<div class="ts-lines">${list.map(r => QE.lineHTML(r)).join('')}</div>` : '<p class="small muted" style="margin:6px 0">No shifts in these dates.</p>'}
      ${canTS() && !(list.length && list.every(r => r.paid_run_id)) ? `<div class="ts-cardfoot">${span <= 31 ? `<button type="button" class="btn sm ghost ts-wk" data-wk="${id}" title="All the days in these dates, each one editable">${span <= 7 ? 'Edit week' : 'Edit days'}</button>` : ''}
        <form class="ts-add" data-qu="${id}" aria-label="Add a shift for ${esc(P.name)}">${dateBox}<input type="time" name="a" value="${S.normal_start || '09:00'}" aria-label="Start"><span class="muted">–</span><input type="time" name="b" value="${S.normal_finish || '17:00'}" aria-label="Finish"><button class="btn sm">+ Add</button></form></div>` : ''}</div>`;
  }).join('')}</div>`;
}
// Accruals: annual / sick leave balances this year. Admin and Super admin: Edit → change allowances and days left → Save;
// add or edit leave taken. Removing a record: Super admin. Staff have no access.
async function leaveModal(emps, year, editing = false) {
  const L = await api(`/api/staff/leave${year ? '?year=' + year : ''}`), y = L.year, st = L.settings;
  const num = (n, v, w = 70) => `<input type="number" step="0.5" name="${n}" value="${v}" style="width:${w}px;text-align:right;padding:6px">`;
  const m = openModal(`<h2 style="font-size:1.4rem">🌴 Accruals — ${y}</h2>
    <form id="ac">
    <p class="small muted">${editing
      ? `Each year: ${num('leave_annual_days', st.leave_annual_days)} days annual leave · ${num('leave_sick_days', st.leave_sick_days)} days sick leave · ${num('leave_day_hours', st.leave_day_hours)} hours paid per leave day (hourly staff). Change anyone's <b>days left</b> below (e.g. days carried over), then Save.`
      : `Each year: <b>${esc(st.leave_annual_days)}</b> days annual leave, <b>${esc(st.leave_sick_days)}</b> days sick leave. Paid leave is added to the pay (hourly staff: days × ${esc(st.leave_day_hours)} h × rate) and shows on payslips with the year to date.`}</p>
    <div class="scroll"><table class="t"><thead><tr><th>Staff</th><th class="r">Annual taken</th><th class="r">Annual left</th><th class="r">Sick taken</th><th class="r">Sick left</th><th class="r">Other / unpaid</th></tr></thead><tbody>
      ${L.people.map(p => `<tr data-pid="${p.id}"><td><b>${esc(p.name)}</b>${!editing && (p.annual_adj || p.sick_adj) ? `<div class="small muted">adjusted${p.annual_adj ? ` annual ${p.annual_adj > 0 ? '+' : ''}${p.annual_adj}` : ''}${p.sick_adj ? ` sick ${p.sick_adj > 0 ? '+' : ''}${p.sick_adj}` : ''}</div>` : ''}</td>
        <td class="r">${p.annual_taken}</td><td class="r">${editing ? num('annual_left', p.annual_left) : `<b>${p.annual_left}</b>`}</td>
        <td class="r">${p.sick_taken}</td><td class="r">${editing ? num('sick_left', p.sick_left) : `<b>${p.sick_left}</b>`}</td><td class="r">${p.other_taken} / ${p.unpaid_taken}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No staff on the time clock.</td></tr>'}</tbody></table></div>
    <div class="rp-btns" style="margin-top:10px">${editing ? '<button type="button" class="btn ghost" id="ac-cancel">Cancel</button><button class="btn coral">💾 Save</button>' : '<button type="button" class="btn coral" id="ac-edit" style="grid-column:1/-1">✏️ Edit</button>'}</div>
    </form>
    ${editing ? '' : `<h3 style="font-size:1.05rem;margin-top:16px">Add leave taken</h3>
    <form id="lv" class="rp">
      <label class="small"><b>Staff</b><select name="user_id">${(emps.length ? emps : L.people).map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></label>
      <label class="small"><b>Type</b><select name="kind">${Object.entries(L.kinds).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      <div class="rp-dates"><label class="ts-date"><span>From</span><input type="date" name="date_from" value="${today()}"></label><label class="ts-date"><span>To</span><input type="date" name="date_to" value="${today()}"></label></div>
      <label class="small"><b>Days</b> <span class="muted">(working days off — e.g. 1, 0.5, 3)</span><input type="number" name="days" step="0.5" min="0.5" value="1"></label>
      <label class="small"><b>Note</b><input name="notes" placeholder="e.g. medical certificate seen"></label>
      <button class="btn coral">Save leave</button>
    </form>
    <h3 style="font-size:1.05rem;margin-top:16px">Leave taken in ${y}</h3>
    ${L.rows.length ? `<div class="scroll"><table class="t"><tbody>${L.rows.map(r => `<tr><td>${fmtDate(r.date_from, { day: 'numeric', month: 'short' })}${r.date_to !== r.date_from ? '–' + fmtDate(r.date_to, { day: 'numeric', month: 'short' }) : ''}</td><td><b>${esc(r.name)}</b><div class="small muted">${esc(L.kinds[r.kind] || r.kind)}${r.notes ? ' · ' + esc(r.notes) : ''}</div></td><td class="r">${r.days} d</td><td style="white-space:nowrap"><button class="btn sm ghost" data-lvedit="${r.id}">Edit</button>${isAdmin() ? ` <button class="btn sm ghost" data-lvdel="${r.id}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">None yet.</p>'}
    <div class="actions" style="justify-content:space-between"><button class="btn sm ghost" id="lv-prev">← ${+y - 1}</button><button class="btn sm ghost" id="lv-next">${+y + 1} →</button></div>`}`, { wide: true });
  const again = (yy = y, ed = false) => { m.close(); leaveModal(emps, yy, ed); };
  const A = $('#ac', m.el);
  if ($('#ac-edit', m.el)) $('#ac-edit', m.el).onclick = () => again(y, true);
  if ($('#ac-cancel', m.el)) $('#ac-cancel', m.el).onclick = () => again(y, false);
  A.onsubmit = async e => {
    e.preventDefault(); if (!editing) return;
    const body = { year: y, leave_annual_days: A.leave_annual_days.value, leave_sick_days: A.leave_sick_days.value, leave_day_hours: A.leave_day_hours.value,
      people: $$('tr[data-pid]', A).map(tr => ({ id: tr.dataset.pid, annual_left: $('[name=annual_left]', tr).value, sick_left: $('[name=sick_left]', tr).value })) };
    try { await api('/api/staff/leave/balances', { method: 'PUT', body }); toast('Accruals saved'); again(y, false); } catch (err) { toast(err.message, 6000); }
  };
  if (editing) return;
  const F = $('#lv', m.el);
  const days = () => { const a = F.date_from.value, b = F.date_to.value; if (!a || !b || b < a) return; let n = 0; for (let d = a; d <= b; d = addDays(d, 1)) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); if (w !== 0 && w !== 6) n++; } F.days.value = n || 1; };
  F.date_from.onchange = () => { if (F.date_to.value < F.date_from.value) F.date_to.value = F.date_from.value; days(); }; F.date_to.onchange = days;
  // S56: more than the balance asks first (the server refuses it otherwise)
  const overOk = (fn, body) => fn(body).catch(err => { if (err.data && err.data.over_balance && confirm(err.message)) return fn({ ...body, allow_over: true }); throw err; });
  F.onsubmit = async e => { e.preventDefault(); try { await overOk(b => api('/api/staff/leave', { body: b }), Object.fromEntries(new FormData(F))); toast('Leave saved'); again(); } catch (err) { toast(err.message, 6000); } };
  $$('[data-lvedit]', m.el).forEach(b => b.onclick = () => {
    const r = L.rows.find(x => x.id == b.dataset.lvedit);
    editModal(`Edit leave — ${r.name}`, [{ n: 'kind', l: 'Type', t: 'select', o: Object.entries(L.kinds) }, { n: 'days', l: 'Days', t: 'number', step: '0.5' }, { n: 'date_from', l: 'From', t: 'date' }, { n: 'date_to', l: 'To', t: 'date' }, { n: 'notes', l: 'Note', full: 1 }],
      r, v => overOk(b => api(`/api/staff/leave/${r.id}`, { method: 'PUT', body: b }), v).then(() => again()));
  });
  $$('[data-lvdel]', m.el).forEach(b => b.onclick = async () => { if (!confirm('Remove this leave?')) return; await api(`/api/staff/leave/${b.dataset.lvdel}`, { method: 'DELETE' }); again(); });
  $('#lv-prev', m.el).onclick = () => again(+y - 1); $('#lv-next', m.el).onclick = () => again(+y + 1);
}
// Reports: timesheet or payslip, for everyone / each person on their own page / one person, for any dates
async function quickRange(v) {
  const t = today(), mon = addDays(t, -((new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7)), first = t.slice(0, 8) + '01', lmEnd = addDays(first, -1);
  if (v === 'pp' || v === 'lp') { const pp = await api('/api/staff/payroll/period'); return v === 'pp' ? pp.current : pp.previous; }
  return { tw: [mon, addDays(mon, 6)], lw: [addDays(mon, -7), addDays(mon, -1)], tm: [first, t], lm: [lmEnd.slice(0, 8) + '01', lmEnd] }[v];
}
function reportsModal(emps, cur) {
  const adm = L('reports') >= 1 && wide(), people = emps.length ? emps : [{ id: ME.id, name: ME.name }];
  const m = openModal(`<h2 style="font-size:1.4rem">Reports</h2>
    <form id="rp" class="rp">
      <label class="small"><b>Report</b><select name="kind"><option value="ts">Timesheet</option>${adm ? '<option value="ps">Payslip</option>' : ''}</select></label>
      <label class="small"><b>Who</b><select name="who">${adm ? `<option value="all">All staff on one sheet</option><option value="each">Each person on their own page</option>` : ''}${people.map(e => `<option value="${e.id}" ${String(cur.user_id) === String(e.id) ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
      <label class="small"><b>Dates</b><select name="q"><option value="">Dates on screen</option><option value="pp">This pay period</option><option value="lp">Last pay period</option><option value="tw">This week (Mon–Sun)</option><option value="lw">Last week</option><option value="tm">This month</option><option value="lm">Last month</option></select></label>
      <div class="rp-dates"><label class="ts-date"><span>From</span><input type="date" name="from" value="${cur.from}"></label><label class="ts-date"><span>To</span><input type="date" name="to" value="${cur.to}"></label></div>
      <p class="small muted" id="rp-note" style="margin:0"></p>
      <div class="rp-btns"><button type="button" class="btn coral" id="rp-print">🖨 Print</button>${window.riyser ? '<button type="button" class="btn" id="rp-pdf">Save PDF</button>' : ''}<button type="button" class="btn ghost" id="rp-email">📧 Email</button></div>
    </form>`);
  m.el.style.maxWidth = '480px';
  const F = $('#rp', m.el);
  const note = () => {
    const k = F.kind.value, w = F.who.value;
    $('#rp-note', m.el).textContent = k === 'ps'
      ? `Payslips per pay period. A finalised pay run's payslip is used if there is one; otherwise a DRAFT is worked out from the timesheets. Email sends each person their own payslip (to the email on their Staff record).`
      : w === 'each' ? 'Each person on their own page (prints one after another). Email sends one sheet with everyone.' : 'Email goes to the people set up for timesheets, with a copy to you.';
  };
  F.kind.onchange = F.who.onchange = note; note();
  F.q.onchange = async () => { if (!F.q.value) return; const [a, b] = await quickRange(F.q.value); F.from.value = a; F.to.value = b; };
  const q = () => { const w = F.who.value; if (!F.from.value || !F.to.value) throw new Error('Choose the dates'); return { from: F.from.value, to: F.to.value, ...(w !== 'all' && w !== 'each' ? { user_id: w } : {}), ...(w === 'each' ? { each: '1' } : {}) }; };
  const open = (title, html) => { const w = window.open('', '_blank'); if (!w) return toast('Allow pop-ups to print');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/staff.css"><style>body{font-family:Arial,sans-serif;margin:24px;color:#111;max-width:900px;background:#fff}h2{margin:0}th{text-align:left}.payslip{page-break-after:always;max-width:640px;margin:0 auto 40px}@media print{button{display:none}}</style><p style="color:#666;margin:0 0 4px">${esc(S.company_name)}</p>${html}`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 400); };
  // the payslips or timesheet for the choices, as HTML (printed, or saved as a PDF in the desktop program)
  const build = async () => {
    const p = q(), who = p.user_id ? ' ' + ((people.find(e => String(e.id) === String(p.user_id)) || {}).name || '') : '';
    if (F.kind.value === 'ps') {
      const { payslips } = await api(`/api/staff/payslips/build?${new URLSearchParams({ from: p.from, to: p.to, ...(p.user_id ? { user_id: p.user_id } : {}) })}`);
      if (!payslips.length) throw new Error('No payslips for these dates (no paid hours, or no pay rate under Staff)');
      return { title: `Payslips${who} ${p.from} to ${p.to}`, html: payslips.map(x => (x.status === 'draft' ? `<p style="color:#b3261e;font-weight:700;margin:0 auto 4px;max-width:640px">DRAFT — not from a finalised pay run${x.part ? ' · part of a pay period (in proportion)' : ''}</p>` : '') + payslipHTML(x, x)).join('') };
    }
    const r = await api(`/api/staff/timesheets/sheet?${new URLSearchParams(p)}`);
    return { title: `Timesheet${who} ${p.from} to ${p.to}`, html: r.html };
  };
  $('#rp-print', m.el).onclick = async () => { try { const d = await build(); open(d.title, d.html); } catch (e) { toast(e.message, 6000); } };
  if ($('#rp-pdf', m.el)) $('#rp-pdf', m.el).onclick = async () => { try { const d = await build(); await savePdf(d.title, d.html); } catch (e) { toast(e.message, 6000); } };
  $('#rp-email', m.el).onclick = async () => {
    const b = $('#rp-email', m.el); b.disabled = true;
    try {
      const p = q();
      if (F.kind.value === 'ps') {
        if (!confirm(p.user_id ? 'Email this person their payslip(s) for these dates?' : 'Email every staff member their own payslip(s) for these dates?')) { b.disabled = false; return; }
        const r = await emailPayslips({ from: p.from, to: p.to, ...(p.user_id ? { user_id: p.user_id } : {}) });
        toast(emailResult(r), 12000);
      } else {
        const r = await api('/api/staff/timesheets/email', { body: { from: p.from, to: p.to, ...(p.user_id ? { user_id: p.user_id } : {}) } });
        toast(`✅ Timesheet sent to ${r.sent_to.join(', ')}`, 7000);
      }
    } catch (e) { toast(e.message, 8000); }
    b.disabled = false;
  };
}
// OWNER-QUICKEDIT (2.2.5): Timesheets opens on the pay period the pay run is on (the day after the last finalised pay
// run), the same dates as Payroll, so the hours on the cards match the pay run. Payroll's "Timesheets for these dates"
// opens it on that pay run's dates.
async function tsDefaultRange() {
  if (window.__tsRange) { const r = window.__tsRange; window.__tsRange = null; return r; }
  try {
    const pp = await api('/api/staff/payroll/period'), o = pp.open;
    return o && o[1] >= addDays(today(), -35) && o[0] <= addDays(today(), 31) ? o : pp.current;   // a long-unpaid period: this one instead
  } catch { return [addDays(today(), -13), today()]; }
}
async function renderTimesheets(f) {
  if (!f || !f.from) { const [a, b] = await tsDefaultRange(); f = { ...(f || {}), from: a, to: b }; }
  let PP = null; try { PP = await api(`/api/staff/payroll/period?date=${f.from}`); } catch { }
  const isPeriod = PP && PP.current[0] === f.from && PP.current[1] === f.to, isOpen = isPeriod && PP.open && PP.open[0] === f.from && PP.open[1] === f.to;
  const qs = new URLSearchParams(f).toString();
  const qsNoSort = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'sort'))).toString();
  const rows = await api(`/api/staff/timesheets?${qsNoSort}`);
  const byNo = (a, b) => String(a.employee_no || '').localeCompare(String(b.employee_no || ''), undefined, { numeric: true }) || a.name.localeCompare(b.name);
  rows.sort({ date_asc: (a, b) => a.clock_in.localeCompare(b.clock_in), name: (a, b) => a.name.localeCompare(b.name) || a.clock_in.localeCompare(b.clock_in),
    empno: (a, b) => byNo(a, b) || a.clock_in.localeCompare(b.clock_in) }[f.sort] || ((a, b) => b.clock_in.localeCompare(a.clock_in)));
  if (window.__tsUnlock && !tsUnlocked()) window.__tsUnlock = null; // 15 minutes are up
  const emps = canTS() ? (await api('/api/staff/directory')).filter(e => e.on_timeclock) : [];
  const byEmp = {}; rows.forEach(r => byEmp[r.name] = (byEmp[r.name] || 0) + (r.paid_hours ?? r.hours)); // paid hours (unpaid breaks taken off)
  view().innerHTML = `<div class="ts-filters">
      ${canTS() ? `<select id="t-emp"><option value="">All staff</option>${emps.map(e => `<option value="${e.id}" ${f.user_id == e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>` : ''}
      <label class="ts-date"><span>From</span><input type="date" id="t-from" value="${f.from}"></label><label class="ts-date"><span>To</span><input type="date" id="t-to" value="${f.to}"></label>
      <select id="t-quick" title="Quick dates"><option value="">Quick dates…</option><option value="pp">This pay period</option><option value="lp">Last pay period</option><option value="tw">This week</option><option value="lw">Last week</option><option value="tf">This fortnight</option><option value="tm">This month</option><option value="lm">Last month</option></select>
      <select id="t-sort" title="Order">${[['date_desc', 'Newest'], ['date_asc', 'Oldest'], ['name', 'Name A–Z'], ['empno', 'Emp. no.']].map(([k, l]) => `<option value="${k}" ${(f.sort || 'date_desc') === k ? 'selected' : ''}>Sort: ${l}</option>`).join('')}</select>
      </div>
    ${PP ? (isPeriod ? `<div class="ts-period"><button type="button" class="btn sm ghost" id="t-pprev" title="Previous pay period" aria-label="Previous pay period">‹</button>
        <div class="ts-period-mid"><span class="ts-period-k">Pay period</span><b>${esc(QE.period(f.from, f.to))}</b>${isOpen ? '<span class="chip">the pay run you\'re working on</span>' : ''}</div>
        <button type="button" class="btn sm ghost" id="t-pnext" title="Next pay period" aria-label="Next pay period">›</button></div>`
      : `<div class="ts-period off"><div class="ts-period-mid"><span class="ts-period-k">Dates</span><b>${esc(QE.period(f.from, f.to))}</b><span class="small muted">not one pay period, so these totals can differ from the pay run</span></div>
        <button type="button" class="btn sm" id="t-pp">Show the pay period (${esc(QE.period(PP.open[0], PP.open[1], false))})</button></div>`) : ''}
    <div class="ts-actions">
      ${tsUnlocked() ? `<span class="chip">🔓 ${esc(window.__tsUnlock.name)} · until ${new Date(window.__tsUnlock.until).toLocaleTimeString('en-FJ', { hour: 'numeric', minute: '2-digit' })}</span><button class="btn sm ghost" id="t-lock">Lock</button>`
        : ''}
      <button class="btn sm ghost" id="t-print">🧾 Reports</button>
      <button class="btn sm ghost" id="t-email" title="Send this timesheet to the people set up for timesheets, and a copy to you">📧 Email timesheet</button>
      ${L('reports') >= 1 && wide() ? `<button class="btn sm ghost" id="t-admin" title="Every staff member's hours and pay for these dates, to the admin">📧 All hours to admin</button>` : ''}
      ${canTS() ? '<button class="btn sm coral" id="t-multi">🗓 Multi-shift</button>' : ''}${L('leave') >= 1 ? '<button class="btn sm ghost" id="t-leave">🌴 Accruals</button>' : ''}<button class="btn sm ghost" id="t-add">+ ${canTS() ? 'One shift' : 'Enter my shift'}</button></div>
    <p class="small muted no-print" style="margin:-6px 0 10px">${L('timesheets') >= 3 ? 'Full access: view, enter, change and delete shifts' : L('timesheets') >= 2 ? 'Add & edit: view, enter and change shifts (deleting needs Full access)' : L('timesheets') >= 1 ? 'View: see shifts; enter your own' : 'Your own shifts: view and enter them. To change one, ask your supervisor'}${ME.team_only && L('timesheets') ? ' · your team only' : ''}.</p>
    ${(() => { let br = []; try { br = JSON.parse(S.payroll_breaks || '[]'); } catch { } return `<p class="small muted" style="margin:0 0 8px">${br.length ? `Payroll rule: ${br.map(b => `shifts over ${b.after_hours}h have a ${b.minutes}-minute unpaid break`).join('; ')}. Paid hours = hours − unpaid break.` : 'No unpaid break rule set (Payroll → Payroll rules).'}</p>`; })()}
    <div class="tiles">${Object.entries(byEmp).map(([n, h]) => `<div class="tile"><div class="k">${esc(n)}</div><div class="v">${h.toFixed(2)}</div><div class="s">paid hours</div></div>`).join('') || ''}</div>
    ${(() => { // week by week (from the pay day): each person's paid hours per day, days worked, week total, running total
      const sd = /^\d{4}-\d{2}-\d{2}$/.test(S.pay_cycle_start || '') && ['26', '52'].includes(String(S.pay_periods_per_year || '26')) ? new Date(S.pay_cycle_start + 'T00:00:00Z').getUTCDay() : 1;
      const wk = d => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() - sd + 7) % 7)), W = {};
      rows.filter(r => r.clock_out).forEach(r => { const d = r.clock_in.slice(0, 10), w = wk(d); const p = ((W[w] = W[w] || {})[r.name] = W[w][r.name] || {}); p[d] = (p[d] || 0) + (r.paid_hours ?? r.hours); });
      const ks = Object.keys(W).sort(); if (!ks.length) return '';
      let run = 0;
      return `<div class="panel" style="padding:0"><h3 style="padding:14px 16px 0;font-size:1rem">Days and hours worked <span class="small muted">(paid hours per day)</span></h3>` + ks.map(w => {
        const days = Array.from({ length: 7 }, (_, i) => addDays(w, i)), people = Object.keys(W[w]).sort();
        const wt = people.reduce((a, n) => a + Object.values(W[w][n]).reduce((x, y) => x + y, 0), 0); run += wt;
        return `<div class="scroll"><table class="t days-t"><thead><tr><th>Week of ${fmtDate(w)}</th>${days.map(d => `<th class="r">${fmtDate(d, { weekday: 'short' })}<div class="small muted">${+d.slice(8)}</div></th>`).join('')}<th class="r">Days</th><th class="r">Hours</th></tr></thead><tbody>
          ${people.map(n => { const p = W[w][n], tot = Object.values(p).reduce((x, y) => x + y, 0); return `<tr><td><b>${esc(n)}</b></td>${days.map(d => `<td class="r">${p[d] ? p[d].toFixed(2) : '<span class="muted">·</span>'}</td>`).join('')}<td class="r">${Object.keys(p).length}</td><td class="r"><b>${tot.toFixed(2)}</b></td></tr>`; }).join('')}
          <tr class="cu-sum"><td colspan="8">Week total <span class="muted">· running total</span></td><td></td><td class="r"><b>${wt.toFixed(2)}</b> <span class="muted">·</span> <b>${run.toFixed(2)}</b></td></tr></tbody></table></div>`;
      }).join('') + '</div>'; })()}
    <div class="chips no-print" style="margin:4px 0 10px"><button class="chip ${(f.view || 'person') === 'person' ? '' : 'gray'}" data-tv="person">By person</button><button class="chip ${f.view === 'list' ? '' : 'gray'}" data-tv="list">All shifts</button></div>
    ${(f.view || 'person') === 'list' ? `<div class="panel" style="padding:0">${table([{ h: 'Staff', f: r => `${esc(r.name)}${r.employee_no ? ` <span class="small muted">${esc(r.employee_no)}</span>` : ''}` }, { h: 'Date', f: r => fmtDate(r.clock_in.slice(0, 10)) }, { h: 'In', f: r => fmtTime(r.clock_in.slice(11)) },
      { h: 'Out', f: r => r.clock_out ? fmtTime(r.clock_out.slice(11)) : '<span class="status open">on shift</span>' }, { h: 'Hours', f: r => r.hours.toFixed(2), r: 1 }, { h: 'Unpaid break', f: r => r.break_hours ? `−${(r.break_hours * 60).toFixed(0)} min` : '·', r: 1 }, { h: 'Paid hours', f: r => `<b>${(r.paid_hours ?? r.hours).toFixed(2)}</b>`, r: 1 }, { h: 'Roster', f: r => QE.rosterText(r) || '<span class="muted">·</span>' }, { h: 'Notes', k: 'notes' }],
      rows, { onRow: canTS(), empty: 'No shifts in this period. Use "Clock in" in the sidebar to start a shift.' })}</div>` : tsPersonCards(rows, emps, f)}`;
  if ($('#t-lock')) $('#t-lock').onclick = () => { window.__tsUnlock = null; toast('Timesheets locked'); renderTimesheets(f); };
  if ($('#t-pin')) $('#t-pin').onclick = () => {
    const m = openModal(`<h2 style="font-size:1.3rem">🔐 Enter timesheets for all staff</h2>
      <p class="small muted">Type the 4-digit time-clock PIN of someone with timesheet access (or an Admin). It stays unlocked for 15 minutes on this screen, and entries are recorded as done by them.</p>
      <form id="tp"><input name="pin" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="PIN" style="font-size:1.4rem;letter-spacing:.4em;text-align:center;max-width:160px" required>
      <div class="err"></div><div class="actions"><button class="btn coral">Unlock</button></div></form>`);
    m.el.style.maxWidth = '420px';
    $('#tp', m.el).onsubmit = async e => {
      e.preventDefault();
      try { const r = await api('/api/staff/timesheets/unlock', { body: { pin: e.target.pin.value } }); window.__tsUnlock = r; m.close(); toast(`Unlocked for ${r.name} (15 minutes)`); renderTimesheets(f);
        setTimeout(() => { if (VIEW === 'timesheets' && window.__tsUnlock && window.__tsUnlock.token === r.token) { window.__tsUnlock = null; toast('Timesheets locked again'); renderTimesheets(f); } }, r.until - Date.now() + 500); }
      catch (err) { $('.err', e.target).innerHTML = `<div class="error">${esc(err.message)}</div>`; e.target.pin.value = ''; }
    };
  };
  $('#t-quick').onchange = async e => {
    const t = today(), mon = addDays(t, -((new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7)), v = e.target.value; if (!v) return;
    if (v === 'pp' || v === 'lp') { const pp = await api('/api/staff/payroll/period'); const [a, b] = v === 'pp' ? pp.current : pp.previous; return renderTimesheets({ ...f, from: a, to: b }); }
    const first = t.slice(0, 8) + '01', lmEnd = addDays(first, -1);
    const [a, b] = v === 'tw' ? [mon, addDays(mon, 6)] : v === 'lw' ? [addDays(mon, -7), addDays(mon, -1)] : v === 'tf' ? [addDays(mon, -7), addDays(mon, 6)] : v === 'tm' ? [first, t] : [lmEnd.slice(0, 8) + '01', lmEnd];
    renderTimesheets({ ...f, from: a, to: b });
  };
  const tsQuery = () => ({ from: $('#t-from').value, to: $('#t-to').value, ...($('#t-emp') && $('#t-emp').value ? { user_id: $('#t-emp').value } : {}) });
  if ($('#t-leave')) $('#t-leave').onclick = () => leaveModal(emps);
  $('#t-print').onclick = () => reportsModal(emps, { from: $('#t-from').value, to: $('#t-to').value, user_id: $('#t-emp') ? $('#t-emp').value : '' });
  if ($('#t-admin')) $('#t-admin').onclick = async () => {
    if (!confirm('Email every staff member\'s hours and pay for these dates to the admin?')) return;
    const b = $('#t-admin'); b.disabled = true;
    try { const r = await api('/api/staff/timesheets/email', { body: { from: $('#t-from').value, to: $('#t-to').value, to_admin: true } }); toast(`✅ All staff hours sent to ${r.sent_to.join(', ')}`, 7000); }
    catch (e) { toast(e.message, 8000); }
    b.disabled = false;
  };
  $('#t-email').onclick = async () => {
    const b = $('#t-email'); b.disabled = true; b.textContent = 'Sending…';
    try {
      const r = await api('/api/staff/timesheets/email', { body: { from: $('#t-from').value, to: $('#t-to').value, ...($('#t-emp') && $('#t-emp').value ? { user_id: $('#t-emp').value } : {}) } });
      toast(`✅ Timesheet sent to ${r.sent_to.join(', ')}${r.copy_to_me ? ' (including a copy to you)' : ' — add your email under Staff to get a copy'}`, 7000);
    } catch (e) { toast(e.message, 8000); }
    b.disabled = false; b.textContent = '📧 Email timesheet';
  };
  const refilter = () => renderTimesheets({ from: $('#t-from').value, to: $('#t-to').value, ...($('#t-emp') && $('#t-emp').value && { user_id: $('#t-emp').value }) });
  ['#t-from', '#t-to', '#t-emp'].forEach(s => $(s) && ($(s).onchange = refilter));
  const defs = [{ n: 'clock_in', l: 'Start', t: 'datetime-local', req: 1 }, { n: 'clock_out', l: 'Finish', t: 'datetime-local' }, { n: 'notes', l: 'Notes', full: 1 }];
  $('#t-sort').onchange = e => renderTimesheets({ ...f, sort: e.target.value });
  $$('[data-tv]').forEach(b => b.onclick = () => renderTimesheets({ ...f, view: b.dataset.tv }));
  // quick add on a person's card
  $$('[data-qu]').forEach(fm => fm.onsubmit = async e => {
    e.preventDefault(); const d = fm.d.value, a = fm.a.value, b = fm.b.value;
    if (!d || !a || !b) return toast('Enter the date, start and finish');
    const btn = $('button', fm); btn.disabled = true;
    try { await api('/api/staff/timesheets', { body: { user_id: fm.dataset.qu, clock_in: `${d}T${a}`, clock_out: `${b < a ? addDays(d, 1) : d}T${b}` } }); toast('Shift added'); renderTimesheets(f); }
    catch (err) { toast(err.message, 6000); btn.disabled = false; }
  });
  if ($('#t-multi')) $('#t-multi').onclick = () => multiShiftModal(emps, $('#t-to').value > today() ? today() : $('#t-to').value, () => renderTimesheets(f));
  // One shift: Date across, then Start | Finish, then notes (same boxes as the quick add on each card).
  // A finish earlier than the start is the next morning (night shift). Finish blank = still clocked in.
  const shiftModal = ({ title, r = null, staffPick = false, mine = false }) => {
    const d0 = r ? r.clock_in.slice(0, 10) : (f.to && f.to < today() ? f.to : today());
    const a0 = r ? r.clock_in.slice(11, 16) : (S.normal_start || '09:00'), b0 = r ? (r.clock_out ? r.clock_out.slice(11, 16) : '') : (S.normal_finish || '17:00');
    const m = openModal(`<h2 style="font-size:1.35rem">${esc(title)}</h2>
      <form id="sh" class="sh-form">
        ${staffPick ? `<label class="small sh-full"><b>Staff member</b><select name="user_id">${emps.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></label>` : ''}
        <label class="ts-box sh-full"><span>Date</span><input type="date" name="d" value="${d0}" required></label>
        <label class="ts-box"><span>Start</span><input type="time" name="a" value="${a0}" required></label>
        <label class="ts-box"><span>Finish</span><input type="time" name="b" value="${b0}"></label>
        <p class="small muted sh-full" id="sh-hours" style="margin:0"></p>
        <label class="small sh-full"><b>Notes</b><input name="notes" value="${esc(r ? r.notes || '' : '')}" placeholder="Optional"></label>
        <div class="sh-full sh-btns"><button class="btn coral">Save</button>${r && r.clock_out && L('timesheets') >= 2 && r.user_id !== ME.id ? `<button type="button" class="btn ghost" id="sh-ok">${r.approved_by ? 'Undo approval' : '✓ Approve'}</button>` : ''}${r && L('timesheets') >= 3 ? '<button type="button" class="btn danger" id="sh-del">Delete</button>' : ''}${r && r.approved_by ? `<div class="small muted" style="width:100%">Approved by ${esc(r.approved_by_name || '')}. Changing the shift clears the approval.</div>` : ''}</div>
      </form>`);
    m.el.style.maxWidth = '440px';
    const F = $('#sh', m.el);
    const hrs = () => { const a = F.a.value, b = F.b.value; if (!a || !b) { $('#sh-hours', m.el).textContent = b ? '' : 'No finish: still clocked in.'; return; }
      let mins = (+b.slice(0, 2) * 60 + +b.slice(3)) - (+a.slice(0, 2) * 60 + +a.slice(3)); if (mins <= 0) mins += 1440;
      $('#sh-hours', m.el).textContent = `${(mins / 60).toFixed(2)} hours worked${b <= a ? ' (finishes the next day)' : ''} · unpaid break taken off when paid`; };
    F.a.oninput = F.b.oninput = hrs; hrs();
    F.onsubmit = async e => {
      e.preventDefault();
      const d = F.d.value, a = F.a.value, b = F.b.value;
      const body = { clock_in: `${d}T${a}`, clock_out: b ? `${b <= a ? addDays(d, 1) : d}T${b}` : '', notes: F.notes.value };
      try {
        if (r) await api(`/api/staff/timesheets/${r.id}`, { method: 'PUT', body });
        else await api('/api/staff/timesheets', { body: { ...body, user_id: staffPick ? F.user_id.value : ME.id } });
        m.close(); toast('Shift saved'); renderTimesheets(f);
      } catch (err) { toast(err.message, 6000); }
    };
    if ($('#sh-ok', m.el)) $('#sh-ok', m.el).onclick = async () => { try { await api(`/api/staff/timesheets/${r.id}/approve`, { body: { approved: !r.approved_by } }); m.close(); toast(r.approved_by ? 'Approval removed' : 'Shift approved'); renderTimesheets(f); } catch (e) { toast(e.message); } };
    if ($('#sh-del', m.el)) $('#sh-del', m.el).onclick = async () => { if (!confirm('Delete this shift?')) return; await api(`/api/staff/timesheets/${r.id}`, { method: 'DELETE' }); m.close(); renderTimesheets(f); };
  };
  if ($('#t-add')) $('#t-add').onclick = () => canTS() ? shiftModal({ title: 'Add a shift', staffPick: true }) : shiftModal({ title: 'Enter my shift', mine: true });
  // change a shift: Admin and up; delete: Super admin only
  const editShift = r => shiftModal({ title: `Shift — ${r.name}`, r });
  if (canTS() && f.view === 'list') bindRows(view(), rows, editShift);
  // OWNER-QUICKEDIT: click a line to change it in place; the bin deletes; Edit week opens the person's days side by side
  const redraw = () => renderTimesheets(f);
  $$('.ts-lines', view()).forEach(box => QE.bind(box, rows, { onChanged: redraw, more: editShift }));
  $$('[data-wk]').forEach(b => b.onclick = () => { const e = emps.find(x => x.id == b.dataset.wk) || {}, r0 = rows.find(r => r.user_id == b.dataset.wk) || {};
    QE.personPanel({ user_id: +b.dataset.wk, name: e.name || r0.name || '', sub: e.position || '', start: f.from, end: f.to, onChanged: async () => { await redraw(); return null; }, more: editShift }); });
  if ($('#t-pprev')) $('#t-pprev').onclick = () => renderTimesheets({ ...f, from: PP.previous[0], to: PP.previous[1] });
  if ($('#t-pnext')) $('#t-pnext').onclick = () => renderTimesheets({ ...f, from: PP.next[0], to: PP.next[1] });
  if ($('#t-pp')) $('#t-pp').onclick = () => renderTimesheets({ ...f, from: PP.open[0], to: PP.open[1] });
}

// ------------------------------------------------------------------ shared time clock (office PC)
let CLOCK_TIMER = null;
async function renderTimeclock() {
  const d = await api('/api/staff/timeclock');
  const toMin = s => { const [h, m] = s.slice(11, 16).split(':').map(Number); return h * 60 + m; };
  const dur = since => { const m = Math.max(0, toMin(d.now) - toMin(since) + (since.slice(0, 10) < d.now.slice(0, 10) ? 1440 : 0)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const on = d.staff.filter(s => s.on_shift).length;
  view().innerHTML = `
    <div class="clock-head"><div><div class="clock-now">${fmtTime(d.now.slice(11, 16))}</div><div class="muted">${fmtDate(d.now.slice(0, 10), { weekday: 'long', day: 'numeric', month: 'long' })} · ${on} on shift</div></div>
      <p class="small muted" style="max-width:420px;margin:0">Tap your name and enter your 4-digit PIN to <b>clock in</b> or <b>clock out</b>. Hours go straight into Timesheets and Payroll.</p></div>
    <div class="clock-grid">${d.staff.map(s => `<button class="clock-tile ${s.on_shift ? 'on' : ''}" data-u="${s.id}">
      <span class="av" style="background:${colorFor(s.id)}">${esc(initials(s.name))}</span>
      <b>${esc(s.name)}</b><span class="small muted">${esc(s.position || '')}</span>
      <span class="clock-status">${s.on_shift ? `● On shift since ${fmtTime(s.since.slice(11, 16))} · ${dur(s.since)}` : `Off${s.today_hours ? ` · ${s.today_hours}h today` : ''}`}</span>
    </button>`).join('')}</div>`;
  $$('.clock-tile').forEach(b => b.onclick = () => pinPad(d.staff.find(s => s.id == b.dataset.u)));
  clearInterval(CLOCK_TIMER);
  CLOCK_TIMER = setInterval(() => { if (VIEW === 'timeclock' && !document.querySelector('.pinpad')) renderTimeclock(); else if (VIEW !== 'timeclock') clearInterval(CLOCK_TIMER); }, 60000);
}
function pinPad(s) {
  let pin = '';
  const m = openModal(`<div class="pinpad">
    <div style="text-align:center"><div class="eyebrow">${s.on_shift ? 'Clock out' : 'Clock in'}</div><h2 style="font-size:1.6rem;margin:4px 0">${esc(s.name)}</h2>
      <div class="muted small">${s.on_shift ? `On shift since ${fmtTime(s.since.slice(11, 16))}` : 'Enter your 4-digit PIN'}</div></div>
    <div class="pin-dots">${'<i></i>'.repeat(4)}</div><div class="pin-err"></div>
    <div class="pin-keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, '⌫'].map(k => `<button type="button" data-k="${k}">${k}</button>`).join('')}</div>
    <div class="ro-clock" id="ro-clock" aria-live="polite"></div>
    ${canTS() ? `<button type="button" class="btn ghost sm" id="no-pin" style="width:100%;margin-top:14px">${s.on_shift ? 'Clock out' : 'Clock in'} without their PIN (${esc(ME.name.split(' ')[0])} enters their own PIN)</button>` : ''}
  </div>`);
  m.el.style.maxWidth = '380px';
  rosterOnClock($('#ro-clock', m.el), s.id);   // OWNER-ROSTER: their published shifts
  const dots = () => $$('.pin-dots i', m.el).forEach((d, i) => d.classList.toggle('f', i < pin.length));
  let byManager = false; // S32: "without their PIN" = the signed-in manager types their own PIN on the same pad
  const submit = async () => {
    const body = byManager ? { user_id: s.id, override: true, manager_pin: pin } : { user_id: s.id, pin };
    try {
      const r = await api('/api/staff/timeclock/punch', { body }).catch(e => {
        if (e.data && e.data.long_shift && confirm(e.message)) return api('/api/staff/timeclock/punch', { body: { ...body, confirm_long: true } });
        throw e;
      });
      m.close();
      toast(r.cancelled ? `${r.name}: clock-in cancelled (tapped twice). Not on shift.` : r.on_shift ? `✓ ${r.name} clocked IN at ${fmtTime(r.at.slice(11, 16))}${rosterPunchText(r)}` : `✓ ${r.name} clocked OUT at ${fmtTime(r.at.slice(11, 16))} (${r.shift_hours}h shift)${rosterPunchText(r)}`, r.roster ? 6000 : 4500);
      renderTimeclock();
    } catch (e) { pin = ''; dots(); $('.pin-err', m.el).textContent = e.message; $('.pin-dots', m.el).classList.add('shake'); setTimeout(() => $('.pin-dots', m.el) && $('.pin-dots', m.el).classList.remove('shake'), 500); }
  };
  const press = k => {
    if (k === 'C') pin = ''; else if (k === '⌫') pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
    $('.pin-err', m.el).textContent = ''; dots();
    if (pin.length === 4) submit();
  };
  $$('.pin-keys button', m.el).forEach(b => b.onclick = () => press(b.dataset.k));
  if ($('#no-pin', m.el)) $('#no-pin', m.el).onclick = () => { byManager = true; pin = ''; dots(); $('.pinpad .muted.small', m.el).textContent = `${ME.name}: enter YOUR PIN to do this for ${s.name}`; $('#no-pin', m.el).remove(); };
  const keyh = e => { if (!document.body.contains(m.el)) return document.removeEventListener('keydown', keyh); if (/^\d$/.test(e.key)) press(e.key); if (e.key === 'Backspace') press('⌫'); };
  document.addEventListener('keydown', keyh);
}

// ------------------------------------------------------------------ employees
// Login history report (admin only)
let LG = {};
async function renderLogins(f = LG) {
  LG = f;
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const d = await api(`/api/staff/admin/logins${qs ? '?' + qs : ''}`);
  const EV = { login: ['Logged in', 'confirmed'], failed: ['Failed login', 'cancelled'], logout: ['Logged out', ''] };
  const when = s => s ? `${fmtDate(s.slice(0, 10))} ${fmtTime(s.slice(11, 16))}` : '—';
  const ago = iso => { if (!iso) return '—'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const failedTotal = d.users.reduce((a, u) => a + u.failed, 0) + d.unknown_failed;
  view().innerHTML = `
    <div class="bar-tools no-print">
      <select id="lg-user"><option value="">All staff</option>${d.users.map(u => `<option value="${u.id}" ${f.user_id == u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
      <select id="lg-ev"><option value="">All events</option>${Object.entries(EV).map(([k, v]) => `<option value="${k}" ${f.event === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
      <input type="date" id="lg-from" value="${d.from}"><span class="muted">to</span><input type="date" id="lg-to" value="${d.to}">
      <span class="grow"></span><a class="btn sm ghost" href="/api/staff/export/logins.csv?${qs}">⬇ CSV</a><button class="btn sm ghost" onclick="print()">🖨 Print</button></div>
    <div class="print-only"><h3>${esc(S.company_name)}: login history ${fmtDate(d.from)} – ${fmtDate(d.to)}</h3></div>
    <div class="tiles">
      <div class="tile"><div class="k">Logins</div><div class="v">${d.users.reduce((a, u) => a + u.logins, 0)}</div><div class="s">${fmtDate(d.from)} – ${fmtDate(d.to)}</div></div>
      <div class="tile"><div class="k">Signed in now</div><div class="v" style="color:var(--green-700)">${d.users.filter(u => u.active_now).length}</div><div class="s">active in the last 15 min</div></div>
      <div class="tile"><div class="k">Failed logins</div><div class="v" style="color:${failedTotal ? 'var(--red)' : 'inherit'}">${failedTotal}</div><div class="s">${d.unknown_failed ? `${d.unknown_failed} with an unknown username` : 'wrong password'}</div></div></div>
    <div class="panel" style="padding:0"><h3 style="padding:14px 16px 0">Staff</h3>${table([
      { h: 'Name', f: u => `<b>${esc(u.name)}</b><div class="small muted">@${esc(u.username)}${u.active ? '' : ' · inactive'}</div>` },
      { h: 'Access', f: u => `<span class="chip ${u.role === 'staff' ? 'gray' : u.role === 'admin' ? 'coral' : ''}">${u.role === 'admin' ? 'Administrator' : 'Staff'}</span>` },
      { h: 'Last login', f: u => `${when(u.last_login)}${u.last_device ? `<div class="small muted">${esc(u.last_device)}</div>` : ''}` },
      { h: 'Last active', f: u => u.active_now ? '<span class="status confirmed">signed in now</span>' : ago(u.last_active) },
      { h: 'Logins', f: u => u.logins || '·', r: 1 }, { h: 'Failed', f: u => u.failed ? `<b style="color:var(--red)">${u.failed}</b>` : '·', r: 1 }], d.users.filter(u => !f.user_id || u.id == f.user_id))}</div>
    <div class="panel" style="padding:0"><h3 style="padding:14px 16px 0">Every login (${d.events.length})</h3>${table([
      { h: 'When', f: e => when(e.at) }, { h: 'Who', f: e => e.name ? `<b>${esc(e.name)}</b>` : `<span class="muted">${esc(e.username || '?')} (no such user)</span>` },
      { h: 'Event', f: e => `<span class="status ${EV[e.event] ? EV[e.event][1] : ''}">${EV[e.event] ? EV[e.event][0] : esc(e.event)}</span>` },
      { h: 'Device', k: 'device' }, { h: 'IP address', k: 'ip' }], d.events, { empty: 'No logins in this period. (Login history starts from when this report was added.)' })}</div>`;
  const go2 = () => renderLogins({ user_id: $('#lg-user').value, event: $('#lg-ev').value, from: $('#lg-from').value, to: $('#lg-to').value });
  ['#lg-user', '#lg-ev', '#lg-from', '#lg-to'].forEach(id => $(id).onchange = go2);
}
async function renderEmployees() {
  const rows = await api('/api/staff/employees');
  const PAYF = ['pay_type', 'pay_rate', 'tin', 'fnpf_no', 'bank_name', 'bank_account', 'bank_account_name'], canEdit = L('employees') >= 2;
  const defs = isNew => [{ n: 'name', l: 'Full name', req: 1 }, { n: 'username', l: 'Login username', req: 1 }, { n: 'position', l: 'Position', ph: 'e.g. Technician, Office, Manager' },
    { n: 'phone', l: 'Phone' }, { n: 'email', l: 'Email', t: 'email' },
    { n: 'pay_type', l: 'Pay type', t: 'select', o: [['hourly', 'Hourly wage'], ['salary', 'Annual salary']] }, { n: 'pay_rate', l: `Rate (${cur()}/hour or /year)`, t: 'number', step: '0.01' },
    { n: 'employee_no', l: 'Employee no.', ph: 'e.g. E001' }, { n: 'tin', l: 'FRCS TIN' }, { n: 'fnpf_no', l: 'FNPF number' }, { n: 'bank_name', l: 'Bank', ph: 'e.g. BSP, ANZ, BRED' }, { n: 'bank_account', l: 'Bank account number' }, { n: 'bank_account_name', l: 'Bank account name' }, { n: 'start_date', l: 'Start date', t: 'date' }, { n: 'aliases', l: 'Other names (wage sheets, bank statement)', ph: 'e.g. Ben, Sam', help: 'Comma separated. Used to match imported wage reports to this person.' },
    { n: 'clock_pin', l: 'Time-clock PIN (4 digits)', ph: isNew ? 'Leave blank to create one' : '', help: 'Used to clock in/out on the shared office PC.' },
    { n: 'password', l: isNew ? 'Initial password (min 8)' : 'Reset password (leave blank to keep)', t: 'password', req: isNew }, { n: 'active', l: 'Active (can log in, included in payroll)', t: 'checkbox' },
    { n: 'on_timeclock', l: 'Shows on the time clock and timesheets. Untick for office logins that don\'t clock in.', t: 'checkbox', full: 1 }]
    .filter(d => L('pay_rates') >= 1 || !PAYF.includes(d.n)).filter(d => d.n !== 'active' || isNew || L('employees') >= 3)
    .map(d => (PAYF.includes(d.n) && L('pay_rates') < 2) || !canEdit ? { ...d, dis: true } : d);
  view().innerHTML = `<div class="bar-tools"><p class="small muted grow" style="margin:0">${isAdmin() ? 'Press <b>Access</b> to choose what each person can see and change.' : ME.team_only ? 'Your team (people with you as their supervisor).' : 'Only an administrator can change what people can see and do.'}</p>${isAdmin() ? '<a class="btn sm ghost" href="#/audit">🧾 Audit trail</a><a class="btn sm ghost" href="#/logins">🔐 Login history</a>' : ''}${canEdit ? '<button class="btn sm coral" id="e-new">+ Staff member</button>' : ''}</div>
    <div class="panel" style="padding:0">${table([{ h: 'Name', f: e => `<b>${esc(e.name)}</b><div class="small muted">@${esc(e.username)}</div>` }, { h: 'Position', k: 'position' },
      { h: 'Access', f: e => `${accessChip(e)}${e.team_only && e.role !== 'admin' ? ' <span class="small muted">own team</span>' : ''}${e.supervisor_id ? `<div class="small muted">Supervisor: ${esc((rows.find(x => x.id === e.supervisor_id) || {}).name || '—')}</div>` : ''}${isAdmin() ? ` <button class="btn sm ghost" data-acc="${e.id}">Access</button>` : ''}` },
      ...(L('pay_rates') >= 1 ? [{ h: 'Pay', f: e => e.pay_rate ? `${money(e.pay_rate, cur())}${e.pay_type === 'hourly' ? '/hr' : '/yr'}` : '—', r: 1 }] : []), { h: 'Phone', k: 'phone' },
      { h: 'Status', f: e => (e.active ? '<span class="status open">active</span>' : `<span class="status cancelled">${e.end_date ? `finished ${esc(fmtDate(e.end_date))}` : 'inactive'}</span>`)
        + (e.active && e.pay_rate && L('employees') >= 3 && L('payroll') >= 2 ? ` <button class="btn sm ghost" data-fin="${e.id}" title="Final pay with unused annual leave paid out">Finish employment…</button>` : '') }], rows, { onRow: 1 })}</div>`;
  if ($('#e-new')) $('#e-new').onclick = () => editModal('New staff member', defs(true), { pay_type: 'hourly', active: 1, on_timeclock: 1 }, v => api('/api/staff/employees', { body: v }).then(e => { renderEmployees(); if (isAdmin()) accessModal(e, rows); }), { wide: true });
  $$('[data-acc]').forEach(b => b.onclick = () => accessModal(rows.find(e => e.id == b.dataset.acc), rows));
  $$('[data-fin]').forEach(b => b.onclick = ev => { ev.stopPropagation(); finishModal(rows.find(e => e.id == b.dataset.fin)); });
  bindRows(view(), rows, e => editModal(e.name, defs(false), { ...e, password: '' }, v => { if (!v.password) delete v.password; if (!v.clock_pin) delete v.clock_pin; return api(`/api/staff/employees/${e.id}`, { method: 'PUT', body: v }).then(renderEmployees); }, { wide: true, readOnly: !canEdit }));
}
// S57: Finish employment: their last day, the final pay (from the day after their last pay run) with unused annual leave paid out
function finishModal(e) {
  const m = openModal(`<h2 style="font-size:1.4rem">Finish employment: ${esc(e.name)}</h2>
    <form id="fin" class="bar-tools" style="margin:0"><label class="small">Last day <input type="date" name="end_date" value="${today()}" required></label>
      <label class="small">Pay date <input type="date" name="pay_date" value="${today()}" required></label><button class="btn sm">Work out final pay</button></form>
    <div id="fin-out"></div>
    <p class="small muted">The final pay is saved as a pay run (labelled "Final pay"). ${esc(e.name)} is then marked as finished: they can't log in and aren't in later pay runs. FNPF and FRCS returns aren't made here.</p>`, { wide: true });
  const F = $('#fin', m.el);
  F.onsubmit = async ev => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(F));
    try {
      const p = await api(`/api/staff/employees/${e.id}/finish/preview`, { body }), l = p.line || {};
      const lv = (l.leave_lines || []).find(x => x.kind === 'payout');
      $('#fin-out', m.el).innerHTML = `<table class="t" style="margin-top:10px"><tbody>
        <tr><td>Final period</td><td class="r">${fmtDate(p.period_start)} – ${fmtDate(p.period_end)}</td></tr>
        <tr><td>Pay for the period</td><td class="r">${money(l.base_pay || 0, cur())}</td></tr>
        <tr><td>Unused annual leave paid out</td><td class="r">${p.unused_annual_days} days${lv ? ` · ${money(lv.amount, cur())}` : ''}</td></tr>
        <tr><td><b>Gross</b></td><td class="r"><b>${money(l.gross || 0, cur())}</b></td></tr><tr><td>FNPF (employee) / PAYE</td><td class="r">−${money(l.fnpf_employee || 0, cur())} / −${money(l.paye || 0, cur())}</td></tr>
        <tr><td><b>Net</b></td><td class="r"><b>${money(l.net || 0, cur())}</b></td></tr></tbody></table>
        ${p.warnings.length ? `<div class="note"><b>⚠ Check these shifts:</b> ${p.warnings.map(w => esc(w.text)).join(' ')}</div>` : ''}
        ${p.already_paid ? `<div class="note"><b>${esc(p.already_paid.message)}</b></div>` : `<div class="actions"><button class="btn coral" id="fin-go">Finalise final pay and finish employment</button></div>`}`;
      if ($('#fin-go', m.el)) $('#fin-go', m.el).onclick = async () => {
        if (!confirm(`Finish ${e.name}'s employment on ${body.end_date} and save the final pay of ${money(l.net || 0, cur())}?${p.warnings.length ? '\n\nThe shift warnings above will be paid as they are.' : ''}`)) return;
        try { const r = await api(`/api/staff/employees/${e.id}/finish`, { body: { ...body, confirm_warnings: p.warnings.length > 0 } }); m.close(); toast(`${e.name}: final pay saved and employment finished`); renderEmployees(); location.hash = '#/payroll'; setTimeout(() => runModal(r.id), 300); }
        catch (err) { toast(err.message, 8000); }
      };
    } catch (err) { toast(err.message, 8000); }
  };
}
// Administrator: what this person can see and change, area by area (or a preset), and their supervisor
function accessModal(e, everyone) {
  const lv = e.access || {}, others = everyone.filter(x => x.id !== e.id && x.active);
  const m = openModal(`<h2 style="font-size:1.4rem">Access: ${esc(e.name)}</h2><form id="acc"><div class="err"></div>
    <label class="small"><b>Start from</b> <select name="preset"><option value="">Custom</option>${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${(e.role === 'admin' ? 'owner' : e.preset) === k ? 'selected' : ''}>${esc(p.label)}${p.admin ? ' (Administrator)' : ''}</option>`).join('')}</select></label>
    <label class="check" style="margin:10px 0"><input type="checkbox" name="admin" ${e.role === 'admin' ? 'checked' : ''}> <b>Administrator</b>: Full access everywhere, and can change other people's access</label>
    <div class="scroll"><table class="t acc-grid"><thead><tr><th>Area</th>${LEVELS.map(l => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>
    ${Object.entries(AREAS).map(([a, label]) => `<tr><td data-l="Area">${esc(label)}</td>${LEVELS.map((l, n) => `<td data-l="${esc(l)}"><input type="radio" name="a_${a}" value="${n}" ${(lv[a] || 0) === n ? 'checked' : ''} aria-label="${esc(label)}: ${esc(l)}"></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    <p class="small muted">View: see only. Add & edit: add and change, but not delete. Full: everything, including deleting. Hidden areas are left out of menus, the dashboard and reports.</p>
    <label class="check"><input type="checkbox" name="team_only" ${e.team_only ? 'checked' : ''}> Only their own team (people who have them as their supervisor) and themselves</label>
    <label class="small" style="display:block;margin-top:10px"><b>Supervisor</b> (approves this person's timesheets) <select name="supervisor_id"><option value="">None</option>${others.map(x => `<option value="${x.id}" ${e.supervisor_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <div class="actions"><button class="btn">Save access</button></div></form>`, { wide: true });
  const f = $('#acc', m.el), sync = () => { const ad = f.admin.checked; $$('.acc-grid input', f).forEach(i => { i.disabled = ad; if (ad) i.checked = i.value === '3'; }); f.team_only.disabled = ad; };
  f.preset.onchange = () => { const p = PRESETS[f.preset.value]; if (!p) return; f.admin.checked = !!p.admin; for (const a of Object.keys(AREAS)) $$(`[name=a_${a}]`, f).forEach(i => i.checked = +i.value === (p.perms[a] || 0)); f.team_only.checked = !!p.team; sync(); };
  $$('.acc-grid input', f).forEach(i => i.onchange = () => { f.preset.value = ''; });
  f.admin.onchange = () => { if (!f.admin.checked && f.preset.value === 'owner') f.preset.value = ''; sync(); }; sync();
  f.onsubmit = async ev => {
    ev.preventDefault();
    const perms = Object.fromEntries(Object.keys(AREAS).map(a => [a, +((f.querySelector(`[name=a_${a}]:checked`) || {}).value || 0)]));
    const body = { role: f.admin.checked ? 'admin' : (e.role === 'admin' ? 'staff' : e.role), perms, preset: f.admin.checked ? 'owner' : f.preset.value, team_only: f.team_only.checked && !f.admin.checked, supervisor_id: f.supervisor_id.value || null };
    try { await api(`/api/staff/employees/${e.id}`, { method: 'PUT', body }); m.close(); toast('Access saved'); if (e.id === ME.id) await refreshMe(); renderEmployees(); }
    catch (err) { $('.err', f).innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  };
}
// Administrator: who changed access, pay or bank details, and what was deleted
async function renderAudit() {
  const rows = await api('/api/staff/audit');
  view().innerHTML = `<p class="small muted">Access changes (before → after), pay and bank detail changes (which details, not the values) and deletions. Newest first.</p>
    <div class="panel" style="padding:0">${table([{ h: 'When', f: r => `${fmtDate(r.at.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })} <span class="small muted">${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>` },
      { h: 'Who', f: r => `<b>${esc(r.user_name || '—')}</b>` }, { h: 'What', f: r => esc(r.action) }, { h: 'Details', f: r => `<span class="small">${esc(r.details)}</span>` }], rows, { empty: 'Nothing yet. Changes to access, pay rates and bank details, and deletions, will show here.' })}</div>`;
}

// ------------------------------------------------------------------ payroll
// OWNER-NEXTRUN (2.2.5): the Payroll page starts with the pay period in big letters. When the last pay run is finalised
// and the next period hasn't been started, a big "Start next pay run (Thu 26 Nov – Wed 2 Dec)" button does it in one
// click: it opens the next period and copies last week's hours (or starts empty: the owner's choice, or Payroll rules'
// "When starting a new pay run"), then shows the pay run table for it. Finalising shows the same button straight away.
// state: { period: [from, to], flash: 'message', finalised: { id, start, end, pay_date, people, net } }
async function renderPayroll(state = {}) {
  const runs = await api('/api/staff/payroll/runs');
  let N = null; if (L('payroll') >= 2) { try { N = await api('/api/staff/payroll/next-period'); } catch { } }
  let start, end;
  if (state.period) [start, end] = state.period;
  else if (N) [start, end] = [N.start, N.end];   // the period straight after the last pay run (the one to pay next)
  else { end = addDays(today(), -1); start = addDays(end, -13); try { const pp = await api('/api/staff/payroll/period'); [start, end] = pp.previous; } catch { } }
  const word = N && N.frequency === 'weekly' ? 'week' : 'pay period';
  const canCopy = L('timesheets') >= 2 && L('payroll') >= 2;
  const waiting = !!(N && !N.started && N.last_run && !state.period);   // last run finalised, next one not started yet
  view().innerHTML = `
    <div class="note">PAYE and FNPF are calculated from the rates in <a href="#/settings">Settings</a> (defaults: FNPF 8% employee / 10% employer, PAYE resident brackets). <b>Check these against current FRCS & FNPF rules before paying staff.</b></div>
    <div id="pr-hero"></div>
    <div class="panel"><h3>Pay run</h3>
      <form id="pr-form" class="bar-tools" style="margin:0">
        <label class="small">Period from <input type="date" name="period_start" value="${start}" required></label>
        <label class="small">to <input type="date" name="period_end" value="${end}" required></label>
        <label class="small">Pay date <input type="date" name="pay_date" value="${today()}" required></label>
        <button class="btn sm">${waiting ? 'Preview' : 'Show pay run'}</button>
        <label class="small" title="Only for a deliberate extra payment (e.g. a bonus) on dates already paid"><input type="checkbox" name="extra_run" id="pr-extra"> Extra pay run (bonus) on dates already paid</label>
        <label class="small" id="pr-extra-why" hidden>What for <input name="extra_reason" maxlength="200" placeholder="e.g. Christmas bonus"></label>
      </form>
      <p class="small muted" id="pr-extra-note" hidden style="margin:6px 0 0"><b>Extra pay run:</b> no wages, leave or regular deductions are paid again. Enter the bonus in Allowances for each person (PAYE and FNPF are worked out on it). It's labelled "Extra" in Past pay runs.</p>
      <div id="pr-next"></div><div id="pr-preview"></div></div>
    <div class="panel" id="pr-export"></div>
    <div class="panel"><h3>Past pay runs <a class="btn sm ghost" href="/api/staff/export/payslips.csv">Export all payslips CSV</a></h3>
      ${table([{ h: 'Pay date', f: r => fmtDate(r.pay_date, { day: 'numeric', month: 'short', year: 'numeric' }) + (r.extra_reason ? ` <span class="chip" title="${esc(r.extra_reason)}">Extra: ${esc(r.extra_reason)}</span>` : '') + (r.note ? ` <span class="chip gray" title="${esc(r.note)}">${esc(r.note.split(' (')[0])}</span>` : '') }, { h: 'Period', f: r => `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}` },
        { h: 'Staff', k: 'employees', r: 1 }, { h: 'Gross', f: r => money(r.total_gross, cur()), r: 1 }, { h: 'Net', f: r => money(r.total_net, cur()), r: 1 }, { h: 'Employer FNPF', f: r => money(r.total_fnpf_employer, cur()), r: 1 }, { h: 'By', k: 'created_by_name' }],
        runs, { onRow: 1, empty: 'No pay runs yet.' })}</div>
    <div class="panel" id="pr-rules"></div>`;
  bindRows(view(), runs, r => runModal(r.id));
  if (!LIC.licensed) {   // new pay runs are locked (the server refuses them too); past pay runs stay open to see and print
    $$('#pr-form input, #pr-form button').forEach(x => { x.disabled = true; });
    $('#pr-preview').innerHTML = `<p class="small" style="margin:8px 0 0"><b>🔒 ${esc(LIC.message)}</b></p>`;
  }
  drawPayRules();
  drawExport(runs);
  const adj = {};
  let LINES = [];
  const period = () => [$('#pr-form').period_start.value, $('#pr-form').period_end.value];
  $('#pr-extra').onchange = () => { const on = $('#pr-extra').checked; $('#pr-extra-why').hidden = $('#pr-extra-note').hidden = !on; $('#pr-preview').innerHTML = ''; };

  // ---- the top of the page: what to do next
  const startBtn = (n, id = 'pr-start') => `<button type="button" class="btn coral pr-big" id="${id}">▶ Start next pay run (${esc(QE.period(n.start, n.end, false))})</button>`;
  const drawHero = async () => {
    const host = $('#pr-hero'); if (!host) return;
    if (state.finalised) {   // straight after "Finalise pay run"
      const F = state.finalised;
      host.innerHTML = `<div class="panel pr-done"><div class="pr-done-tick" aria-hidden="true">✓</div><div class="grow">
          <div class="pr-k">Pay run finalised</div><h2>${esc(QE.period(F.start, F.end))}</h2>
          <p class="muted">${F.people} payslip${F.people === 1 ? '' : 's'} saved · net pay ${money(F.net, cur())} · pay date ${esc(fmtDate(F.pay_date, { day: 'numeric', month: 'short', year: 'numeric' }))}</p>
          <div class="pr-hero-btns">${N && !N.started ? startBtn(N) : ''}<button type="button" class="btn ghost" id="pr-slips">Print or email payslips</button></div>
          ${N && !N.started ? `<p class="small muted" style="margin:8px 0 0">Next: the ${esc(N.frequency || '')} pay period straight after this one. You choose whether to copy this ${word}'s hours.</p>` : ''}</div></div>`;
      $('#pr-slips').onclick = () => runModal(F.id);
      if ($('#pr-start')) $('#pr-start').onclick = () => startNext(N);
      return;
    }
    const [a, b] = period(), onNext = N && a === N.start && b === N.end;
    let ap = null; if (L('timesheets') >= 2 && a && b && !waiting) { try { ap = await api('/api/staff/timesheets/approve-all', { body: { from: a, to: b, dry_run: true } }); } catch { } }
    const paidRun = runs.find(r => !r.extra_reason && !r.note && r.period_start <= b && r.period_end >= a);
    host.innerHTML = `${waiting ? `<div class="panel pr-hero pr-wait"><div class="grow"><div class="pr-k">Last pay run</div>
          <h2><span class="pr-ok">✓</span> ${esc(QE.period(N.last_run.period_start, N.last_run.period_end))} is finalised</h2>
          <p class="muted" style="margin:2px 0 14px">Paid ${esc(fmtDate(N.last_run.pay_date, { day: 'numeric', month: 'short', year: 'numeric' }))}. The next ${esc(N.frequency || '')} pay period is ${esc(QE.period(N.start, N.end))}${N.entries ? ` (${N.entries} timesheet entr${N.entries === 1 ? 'y' : 'ies'} in it already)` : ''}.</p>
          ${startBtn(N)}<p class="small muted" style="margin:10px 0 0">${N.new_payrun_hours === 'copy' ? `Copies last ${word}'s hours (you can edit them).` : N.new_payrun_hours === 'roster' ? "Fills hours from the roster for people who don't clock in (you can edit them)." : N.new_payrun_hours === 'empty' ? "Starts with no hours (you enter them)." : `You choose: copy last ${word}'s hours, fill them from the roster, or start empty.`} <a href="#/payroll" id="pr-to-rules">Change this in Payroll rules</a>.</p></div></div>`
      : `<div class="panel pr-hero"><div class="pr-hero-top"><div class="grow"><div class="pr-k">Pay period</div><h2>${esc(QE.period(a, b))}</h2>
          <div class="small muted">${paidRun ? `<b>paid</b> in pay run #${paidRun.id}` : `${N && N.frequency ? esc(N.frequency) + ' · ' : ''}not paid yet`}${onNext && N.last_run ? ` · straight after pay run #${N.last_run.id}` : ''}</div></div>
          <div class="pr-hero-btns">${canCopy && !paidRun ? `<button type="button" class="btn sm ghost" id="pr-copy-go">⧉ Copy last ${word}'s hours</button><button type="button" class="btn sm ghost" id="pr-roster-go" title="Hours from the published roster, for people who don't clock in">📅 Fill from roster</button>` : ''}
            ${ap && ap.shifts ? `<button type="button" class="btn sm ghost" id="pr-approve">✓ Approve all (${ap.shifts})</button>` : ''}
            <button type="button" class="btn sm ghost" id="pr-ts">Timesheets for these dates →</button></div></div>
        ${onNext && N.copied_unapproved ? `<div class="note pr-copied">${state.flash ? `<b>✓ ${esc(state.flash)}</b><br>The ${N.copied_unapproved} copied shift${N.copied_unapproved === 1 ? " isn't" : "s aren't"} approved yet.` : `<b>${N.copied_unapproved} shift${N.copied_unapproved === 1 ? ' was' : 's were'} copied from last ${word} and ${N.copied_unapproved === 1 ? "isn't" : "aren't"} approved yet.</b>`} Click a name below to see and change that person's days.${ap && ap.shifts ? ' When they look right, <b>Approve all</b>.' : ''}</div>`
          : state.flash ? `<div class="note pr-flash">✓ ${esc(state.flash)}</div>` : ''}
        <div id="pr-approve-box"></div></div>`}`;
    if ($('#pr-start')) $('#pr-start').onclick = () => startNext(N);
    if ($('#pr-to-rules')) $('#pr-to-rules').onclick = e => { e.preventDefault(); const r = $('#pr-newrun') || $('#pr-rules'); if (r) { r.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (r.focus) setTimeout(() => r.focus(), 400); } };
    if ($('#pr-ts')) $('#pr-ts').onclick = () => { window.__tsRange = period(); location.hash = '#/timesheets'; };
    if ($('#pr-copy-go')) $('#pr-copy-go').onclick = async () => {
      const [x, y] = period();
      try { copyModal(await api('/api/staff/payroll/copy-hours/preview', { body: { period_start: x, period_end: y } })); } catch (e) { toast(e.message, 6000); }
    };
    if ($('#pr-roster-go')) $('#pr-roster-go').onclick = async () => {
      const [x, y] = period();
      try { rosterFillModal(await api('/api/staff/payroll/roster-hours/preview', { body: { period_start: x, period_end: y } })); } catch (e) { toast(e.message, 6000); }
    };
    if ($('#pr-approve')) $('#pr-approve').onclick = () => {
      const box = $('#pr-approve-box');
      box.innerHTML = `<div class="pr-confirm"><span>Approve <b>${ap.shifts} shift${ap.shifts === 1 ? '' : 's'}</b> for <b>${ap.people} ${ap.people === 1 ? 'person' : 'people'}</b> (${ap.hours.toFixed(2)} hours) in ${esc(QE.period(a, b, false))}?<span class="small muted"> ${esc(ap.names.join(', '))}.</span></span>
        <button type="button" class="btn sm" id="pr-ap-yes">Approve all</button><button type="button" class="btn sm ghost" id="pr-ap-no">Cancel</button></div>`;
      $('#pr-ap-no').onclick = () => { box.innerHTML = ''; };
      $('#pr-ap-yes').onclick = async () => {
        $('#pr-ap-yes').disabled = true;
        try { const r = await api('/api/staff/timesheets/approve-all', { body: { from: a, to: b } }); toast(`✓ ${r.approved} shift${r.approved === 1 ? '' : 's'} approved`); state.flash = '';
          try { N = await api('/api/staff/payroll/next-period'); } catch { } drawHero(); }
        catch (e) { toast(e.message, 6000); $('#pr-ap-yes').disabled = false; }
      };
    };
  };
  // "Start next pay run": copy last week's hours, or start empty (asked, unless Payroll rules say which)
  const chooseMode = n => new Promise(resolve => {
    let done = false;
    const m = openModal(`<h2 style="font-size:1.4rem;margin-bottom:2px">Start next pay run</h2><p class="muted" style="margin:0 0 16px">${esc(QE.period(n.start, n.end))}</p>
      <div class="pr-choices">
        <button type="button" class="pr-choice" data-m="copy" ${canCopy ? '' : 'disabled'}><b>Copy last ${word}'s hours</b><span>(you can edit them)</span>
          <small>${canCopy ? `The same days and times as ${esc(QE.period(n.last_run ? n.last_run.period_start : '', n.last_run ? n.last_run.period_end : '', false))}, saved as unapproved timesheet entries. People on leave, finished staff and anyone with hours already are skipped.` : 'Needs Add & edit access to Timesheets.'}</small></button>
        <button type="button" class="pr-choice" data-m="roster" ${canCopy ? '' : 'disabled'}><b>Fill from the roster</b><span>(for people who don't clock in)</span>
          <small>${canCopy ? "Hourly staff with no clock times in these dates get the hours of their published roster shifts, saved as unapproved timesheet entries. Anyone who clocked in keeps their own hours." : 'Needs Add & edit access to Timesheets.'}</small></button>
        <button type="button" class="pr-choice" data-m="empty"><b>Start empty</b><span>(I'll enter hours myself)</span><small>No hours are added. Enter them in Timesheets, or click a name in the pay run. You can still copy last ${word}'s hours later.</small></button>
      </div>
      <p class="small muted" style="margin:14px 0 0">To stop being asked, choose in <b>Payroll rules → When starting a new pay run</b>.</p>`, { onClose: () => { if (!done) resolve(null); } });
    m.el.style.maxWidth = '780px';
    $$('[data-m]', m.el).forEach(b => b.onclick = () => { done = true; m.close(); resolve(b.dataset.m); });
  });
  const startNext = async n => {
    let pref = n.new_payrun_hours; try { pref = (await api('/api/staff/payroll/rules')).new_payrun_hours || pref; } catch { }   // as saved just now in Payroll rules
    const mode = pref === 'ask' || !pref ? await chooseMode({ ...n, new_payrun_hours: pref }) : pref;
    if (!mode) return;
    $$('.pr-big').forEach(b => { b.disabled = true; b.textContent = mode === 'copy' ? 'Copying hours…' : mode === 'roster' ? 'Filling hours from the roster…' : 'Starting…'; });
    try { const r = await api('/api/staff/payroll/next-run', { body: { mode } }); await renderPayroll({ period: [r.start, r.end], flash: r.message }); window.scrollTo(0, 0); }
    catch (e) { toast(e.message, 7000); renderPayroll(state); }
  };

  const preview = async () => {
    const body = { ...formData($('#pr-form')), adjustments: adj };
    const { lines, already_paid: paid, warnings = [] } = await api('/api/staff/payroll/preview', { body });
    LINES = lines;
    const ord = (window.__prSort = $('#pr-sort') ? $('#pr-sort').value : (window.__prSort || 'name'));
    lines.sort({ empno: (a, b) => String(a.employee_no || '').localeCompare(String(b.employee_no || ''), undefined, { numeric: true }) || a.employee_name.localeCompare(b.employee_name),
      hours: (a, b) => b.hours - a.hours, net: (a, b) => b.net - a.net }[ord] || ((a, b) => a.employee_name.localeCompare(b.employee_name)));
    const sum = k => lines.reduce((a, l) => a + l[k], 0);
    const hrsCell = l => isAdmin() && l.pay_type === 'hourly'
      ? `<input class="inline" type="number" step="0.25" min="0" data-h="${l.user_id}" value="${l.hours.toFixed(2)}" title="Admin: change the hours paid (a reason is asked)"><button type="button" class="pr-days" data-pp="${l.user_id}" title="See and change ${esc(l.employee_name)}'s days">days ›</button>`
      : `<button type="button" class="pr-hrs" data-pp="${l.user_id}" title="See and change ${esc(l.employee_name)}'s days">${l.hours.toFixed(2)}</button>`;
    $('#pr-preview').innerHTML = lines.length ? `<div class="bar-tools" style="margin:12px 0 0"><select id="pr-sort">${[['name', 'Person A–Z'], ['empno', 'Employee no.'], ['hours', 'Most hours'], ['net', 'Highest pay']].map(([k, l]) => `<option value="${k}" ${ord === k ? 'selected' : ''}>Order: ${l}</option>`).join('')}</select><span class="small muted" style="align-self:center">Click a name to see and change that person's days.</span></div><div class="scroll" style="margin-top:8px"><table class="t pr-table"><thead><tr><th>Employee</th><th class="r">Hours</th><th class="r">Base</th><th class="r">Allowances</th><th class="r">Gross</th><th class="r">FNPF (ee)</th><th class="r">PAYE</th><th class="r">Other ded.</th><th class="r">Net</th><th class="r">FNPF (er)</th></tr></thead><tbody>
      ${lines.map(l => `<tr data-row="${l.user_id}"><td><button type="button" class="pr-name" data-pp="${l.user_id}">${esc(l.employee_name)}</button>${l.employee_no ? ` <span class="small muted">${esc(l.employee_no)}</span>` : ''}<div class="small muted">${l.pay_type === 'hourly' ? `${money(l.pay_rate, cur())}/hr` : 'Salary'}</div></td><td class="r">${hrsCell(l)}
          ${l.hours_adjusted ? `<div class="small" style="color:var(--gold)">adjusted from ${l.timesheet_hours.toFixed(2)}: ${esc(l.hours_note)}</div>` : l.break_hours ? `<div class="small muted">${l.worked_hours.toFixed(2)} − ${l.break_hours.toFixed(2)} break</div>` : ''}</td><td class="r">${money(l.base_pay, cur())}</td>
        <td class="r"><input class="inline" type="number" step="0.01" data-a="${l.user_id}" value="${l.allowances || ''}"></td><td class="r">${money(l.gross, cur())}</td><td class="r">${money(l.fnpf_employee, cur())}</td><td class="r">${money(l.paye, cur())}</td>
        <td class="r">${l.regular_deductions ? `<div class="small muted" title="${esc(l.deduction_lines.map(d => d.name + ' ' + d.amount).join(', '))}">${money(l.regular_deductions, cur())} regular</div>` : ''}<input class="inline" type="number" step="0.01" data-o="${l.user_id}" value="${(adj[l.user_id] && adj[l.user_id].other_deductions) || ''}" placeholder="+ this pay"></td><td class="r"><b>${money(l.net, cur())}</b></td><td class="r">${money(l.fnpf_employer, cur())}</td></tr>`).join('')}
      <tr><td><b>Totals</b></td><td class="r">${sum('hours').toFixed(2)}</td><td></td><td></td><td class="r"><b>${money(sum('gross'), cur())}</b></td><td class="r">${money(sum('fnpf_employee'), cur())}</td><td class="r">${money(sum('paye'), cur())}</td><td></td><td class="r"><b>${money(sum('net'), cur())}</b></td><td class="r">${money(sum('fnpf_employer'), cur())}</td></tr>
      </tbody></table></div>${warnings.length ? `<div class="note" style="margin-top:10px;border-color:var(--gold)"><b>⚠ Check these shifts before paying</b> (click the name to fix them, or change the hours here):<ul style="margin:4px 0 0">${warnings.map(w => `<li><b>${esc(w.name)}</b>: ${esc(w.text)}</li>`).join('')}</ul></div>` : ''}${paid ? `<div class="note" style="margin-top:10px"><b>${esc(paid.message)}</b> To pay a bonus on these dates instead, tick <b>Extra pay run (bonus)</b> above.</div>` : ''}<div class="actions">${paid ? '' : `<button class="btn coral" id="pr-final">${body.extra_run ? 'Finalise extra pay run' : 'Finalise pay run'}</button>`}<span class="small muted" style="align-self:center">Edit allowances/deductions and the totals recalculate.</span></div>`
      : `<div class="empty" style="margin-top:14px">No active staff with a pay rate. Set rates under <a href="#/employees">Staff</a>.</div>`;
    if ($('#pr-sort')) $('#pr-sort').onchange = () => preview();
    $$('[data-h]', $('#pr-preview')).forEach(i => i.onchange = () => {
      const id = i.dataset.h, l = lines.find(x => x.user_id == id); adj[id] = adj[id] || {};
      if (i.value === '' || Math.abs(+i.value - l.timesheet_hours) < 0.001) { delete adj[id].hours; delete adj[id].hours_note; return preview(); }
      const why = prompt(`Change ${l.employee_name}'s hours from ${l.timesheet_hours.toFixed(2)} (timesheets) to ${(+i.value).toFixed(2)} for this pay run.\n\nReason (required):`, adj[id].hours_note || '');
      if (!why || why.trim().length < 3) { i.value = (+l.hours).toFixed(2); return toast('Hours not changed: a reason is needed'); }
      adj[id].hours = i.value; adj[id].hours_note = why.trim(); preview();
    });
    $$('[data-a],[data-o]', $('#pr-preview')).forEach(i => i.onchange = () => { const id = i.dataset.a || i.dataset.o; adj[id] = adj[id] || {}; adj[id][i.dataset.a ? 'allowances' : 'other_deductions'] = i.value; preview(); });
    // OWNER-QUICKEDIT: a person's days in this pay period, editable in a side panel; the pay run behind it re-works after each change
    $$('[data-pp]', $('#pr-preview')).forEach(b => b.onclick = () => {
      const l = lines.find(x => x.user_id == b.dataset.pp); if (!l) return;
      const [x, y] = period();
      $$('tr.pr-on').forEach(t => t.classList.remove('pr-on')); const tr = $(`tr[data-row="${l.user_id}"]`); if (tr) tr.classList.add('pr-on');
      QE.personPanel({ user_id: l.user_id, name: l.employee_name, sub: l.pay_type === 'hourly' ? `${money(l.pay_rate, cur())}/hr` : 'Salary', start: x, end: y, line: l,
        onChanged: async () => { await preview(); drawHero(); const t2 = $(`tr[data-row="${l.user_id}"]`); if (t2) t2.classList.add('pr-on'); return LINES.find(z => z.user_id === l.user_id) || null; },
        onClose: () => $$('tr.pr-on').forEach(t => t.classList.remove('pr-on')) });
    });
    if ($('#pr-final')) $('#pr-final').onclick = async () => {
      if (warnings.length && !confirm(`These shifts look wrong:\n\n${warnings.map(w => `• ${w.name}: ${w.text}`).join('\n')}\n\nPay them as they are?`)) return;
      if (warnings.length) body.confirm_warnings = true;
      if (!confirm(body.extra_run ? `Finalise an EXTRA pay run (${body.extra_reason || 'no reason given'}) for dates that may already be paid? Only the allowances entered are paid.` : 'Finalise this pay run? Payslips will be saved (print or email them from the pay run).')) return;
      $('#pr-final').disabled = true;
      try {
        const r = await api('/api/staff/payroll/runs', { body });
        toast('Pay run saved');
        await renderPayroll({ finalised: { id: r.id, start: body.period_start, end: body.period_end, pay_date: body.pay_date, people: lines.length, net: Math.round(sum('net') * 100) / 100 } });
        window.scrollTo(0, 0);
      } catch (e) { toast(e.message); $('#pr-final').disabled = false; }
    };
  };
  $('#pr-form').onsubmit = e => { e.preventDefault(); drawHero(); preview().catch(err => toast(err.message)); };
  // other recent pay periods (paid or not), to pick a different one
  const setPeriod = (a, b) => { const f = $('#pr-form'); f.period_start.value = a; f.period_end.value = b; };
  const drawOther = () => {
    if (!N) return;
    $('#pr-next').innerHTML = `<details class="pr-other"><summary class="small">Other pay periods</summary>
      <ul class="small" style="margin:6px 0 4px;padding-left:18px">${N.periods.map(p => `<li>${esc(p.label)}: ${p.paid ? `<b>paid</b> (run #${p.run_id})` : `<b>not paid yet</b>${p.current ? ' (this period)' : ''}`} · ${p.entries} timesheet entr${p.entries === 1 ? 'y' : 'ies'}${p.paid ? '' : ` · <a href="#" data-per="${p.start}|${p.end}">choose</a>`}</li>`).join('')}</ul></details>`;
    $$('[data-per]', $('#pr-next')).forEach(a => a.onclick = e => { e.preventDefault(); const [s, t] = a.dataset.per.split('|'); renderPayroll({ period: [s, t] }); });
  };
  const stampPlus = (ci, h) => new Date(Date.parse(ci + 'Z') + Math.round(h * 60) * 60000).toISOString().slice(0, 16);
  const copyModal = p => {
    const m = openModal(`<h3>Copy hours into ${esc(p.label)}</h3>
      <p class="small muted">From ${esc(p.from_label)}: the same days, start and finish times. Untick anyone or any shift you don't want, and change the hours if they're different this time. They're saved as normal, unapproved timesheet entries marked "copied from ${esc(p.from_label)}", so you can still edit or approve them in Timesheets.</p>
      ${p.salaried.length ? `<p class="small"><b>Salaried staff don't need hours</b> (their salary is paid as usual): ${p.salaried.map(s => esc(s.name)).join(', ')}.</p>` : ''}
      <div class="scroll"><table class="t"><thead><tr><th></th><th>Person / day</th><th>Start – finish</th><th class="r">Hours</th></tr></thead><tbody>
      ${p.people.map(x => `<tr class="cp-person" data-u="${x.user_id}"><td><input type="checkbox" data-pu="${x.user_id}" ${x.rows.some(r => !r.skip) ? 'checked' : 'disabled'}></td><td colspan="2"><b>${esc(x.name)}</b></td><td class="r"><b data-tot="${x.user_id}">${x.total.toFixed(2)}</b></td></tr>
        ${x.rows.map((r, i) => r.skip ? `<tr class="muted"><td></td><td>${esc(fmtDate(r.date))}</td><td colspan="2" class="small">Skipped: ${esc(r.skip)}</td></tr>`
          : `<tr><td><input type="checkbox" data-row="${x.user_id}:${i}" checked></td><td>${esc(fmtDate(r.date))}</td><td>${fmtTime(r.clock_in.slice(11))} – <span data-end="${x.user_id}:${i}">${fmtTime(r.clock_out.slice(11))}</span></td>
            <td class="r"><input class="inline" type="number" step="0.25" min="0.25" max="16" data-hr="${x.user_id}:${i}" value="${r.hours.toFixed(2)}"></td></tr>`).join('')}`).join('') || '<tr><td colspan="4" class="muted">Nobody worked hours in the period before.</td></tr>'}
      </tbody></table></div><div class="err"></div>
      <div class="actions"><button class="btn coral" id="cp-save">Save as timesheet entries</button><button class="btn ghost" id="cp-cancel">Cancel</button><span class="small muted" id="cp-count" style="align-self:center"></span></div>`, { wide: true });
    const el = m.el, row = k => { const [u, i] = k.split(':'); return p.people.find(x => x.user_id == u).rows[+i]; };
    const chosen = () => $$('[data-row]', el).filter(c => c.checked && !c.disabled).map(c => ({ k: c.dataset.row, r: row(c.dataset.row), h: +$(`[data-hr="${c.dataset.row}"]`, el).value }));
    const redraw = () => {
      for (const x of p.people) { const t = $(`[data-tot="${x.user_id}"]`, el); if (t) t.textContent = chosen().filter(c => c.k.startsWith(x.user_id + ':')).reduce((a, c) => a + (c.h || 0), 0).toFixed(2); }
      const n = chosen().length; $('#cp-count', el).textContent = `${n} shift${n === 1 ? '' : 's'}, ${chosen().reduce((a, c) => a + (c.h || 0), 0).toFixed(2)} hours`; $('#cp-save', el).disabled = !n;
    };
    $$('[data-pu]', el).forEach(c => c.onchange = () => { $$(`[data-row^="${c.dataset.pu}:"]`, el).forEach(r => { r.checked = c.checked; }); redraw(); });
    $$('[data-row]', el).forEach(c => c.onchange = redraw);
    $$('[data-hr]', el).forEach(i => i.oninput = () => { const r = row(i.dataset.hr); if (+i.value > 0) $(`[data-end="${i.dataset.hr}"]`, el).textContent = fmtTime(stampPlus(r.clock_in, +i.value).slice(11)); redraw(); });
    $('#cp-cancel', el).onclick = m.close;
    $('#cp-save', el).onclick = async () => {
      const list = chosen();
      if (list.some(c => !(c.h > 0 && c.h <= 16))) { $('.err', el).innerHTML = '<div class="error">Hours must be between 0.25 and 16.</div>'; return; }
      $('#cp-save', el).disabled = true;
      try {
        const r = await api('/api/staff/payroll/copy-hours', { body: { period_start: p.start, period_end: p.end, entries: list.map(c => ({ user_id: +c.k.split(':')[0], clock_in: c.r.clock_in, clock_out: stampPlus(c.r.clock_in, c.h) })) } });
        if (r.failed) { $('.err', el).innerHTML = `<div class="error">${r.saved} saved. Not saved: ${r.results.filter(x => !x.ok).map(x => esc(x.error)).join(' ')}</div>`; $('#cp-save', el).disabled = false; return; }
        m.close(); toast(`${r.saved} shift${r.saved === 1 ? '' : 's'} copied`);
        const people = new Set(r.results.filter(x => x.ok).map(x => x.user_id)).size;
        renderPayroll({ period: [p.start, p.end], flash: `Copied ${people} ${people === 1 ? "person's" : "people's"} hours from ${p.from_label}. Check and change anything that's different.` });
      } catch (e) { $('.err', el).innerHTML = `<div class="error">${esc(e.message)}</div>`; $('#cp-save', el).disabled = false; }
    };
    if (!p.people.some(x => x.rows.some(r => !r.skip))) $('.err', el).innerHTML = `<div class="note" style="margin-top:10px">Nothing to copy: ${p.people.length ? 'everyone already has hours on those days (or is on leave)' : `nobody has hours in ${esc(p.from_label)}`}.</div>`;
    redraw();
  };
  // OWNER-ROSTER: hours from the published roster for hourly staff with no clock times in these dates
  const rosterFillModal = p => {
    const can = p.people.filter(x => x.rows.some(r => !r.skip));
    const m = openModal(`<h3>Fill hours from the roster</h3><p class="small muted">${esc(QE.period(p.start, p.end))}. For hourly staff with no clock times in these dates: the start and finish of each published roster shift, saved as unapproved timesheet entries noted "from the roster". Payroll's unpaid break rules apply as usual. Change them in Timesheets or by clicking a name in the pay run.</p>
      ${p.clocked.length ? `<p class="small"><b>Keep their own clock times:</b> ${p.clocked.map(c => esc(c.name)).join(', ')}.</p>` : ''}
      <div class="scroll"><table class="t"><thead><tr><th></th><th>Person / day</th><th>Start – finish</th><th class="r">Hours</th></tr></thead><tbody>
      ${p.people.map(x => `<tr><td><input type="checkbox" data-fu="${x.user_id}" ${x.rows.some(r => !r.skip) ? 'checked' : 'disabled'}></td><td colspan="2"><b>${esc(x.name)}</b></td><td class="r"><b>${x.total.toFixed(2)}</b></td></tr>
        ${x.rows.map(r => `<tr class="${r.skip ? 'muted' : ''}"><td></td><td>${esc(fmtDate(r.date))}${r.role ? ` <span class="small muted">${esc(r.role)}</span>` : ''}</td><td>${r.skip ? `<span class="small">Skipped: ${esc(r.skip)}</span>` : `${fmtTime(r.clock_in.slice(11))} – ${fmtTime(r.clock_out.slice(11))}`}</td><td class="r">${r.skip ? '' : r.hours.toFixed(2)}</td></tr>`).join('')}`).join('')
        || `<tr><td colspan="4" class="muted">${p.published_weeks ? 'Nobody to fill: everyone on the roster has clock times, or is salaried.' : 'There is no published roster for these dates. Plan and publish it on the Roster page first.'}</td></tr>`}
      </tbody></table></div><div class="err"></div>
      <div class="actions"><button class="btn coral" id="rf-save" ${can.length ? '' : 'disabled'}>Fill hours</button><button class="btn ghost" id="rf-cancel">Cancel</button></div>`, { wide: true });
    const el = m.el;
    $('#rf-cancel', el).onclick = m.close;
    $('#rf-save', el).onclick = async () => {
      const ids = $$('[data-fu]', el).filter(c => c.checked && !c.disabled).map(c => +c.dataset.fu);
      if (!ids.length) return toast('Tick at least one person');
      $('#rf-save', el).disabled = true;
      try {
        const r = await api('/api/staff/payroll/roster-hours', { body: { period_start: p.start, period_end: p.end, user_ids: ids } });
        m.close();
        renderPayroll({ period: [p.start, p.end], flash: `Filled ${r.people} ${r.people === 1 ? "person's" : "people's"} hours from the roster (${r.saved} shift${r.saved === 1 ? '' : 's'}).${r.failed.length ? ` Not filled: ${r.failed.join(' ')}` : ''} Check and change anything that's different.` });
      } catch (e) { $('.err', el).innerHTML = `<div class="error">${esc(e.message)}</div>`; $('#rf-save', el).disabled = false; }
    };
  };
  drawOther();
  await drawHero();
  // the pay run table for the period, ready to edit (not while waiting for "Start next pay run", or straight after finalising)
  if (LIC.licensed && !waiting && !state.finalised && L('payroll') >= 2) await preview().catch(err => { $('#pr-preview').innerHTML = `<div class="error" style="margin-top:12px">${esc(err.message)}</div>`; });
}
// Payroll rules: unpaid breaks, FNPF %, regular deductions per person (admin edits, managers see)
async function drawPayRules() {
  const host = $('#pr-rules'); if (!host) return;
  const R = await api('/api/staff/payroll/rules');
  const ro = L('setup') < 2;
  const brRow = (r = {}) => `<div class="br-row"><label class="ts-box"><span>Shift longer than (hours)</span><input type="number" step="0.25" min="0" data-bh value="${r.after_hours ?? ''}" placeholder="e.g. 4" ${ro ? 'disabled' : ''}></label><label class="ts-box"><span>Unpaid break (minutes)</span><input type="number" step="5" min="0" data-bm value="${r.minutes ?? ''}" placeholder="e.g. 45" ${ro ? 'disabled' : ''}></label>${ro ? '' : '<button type="button" class="btn sm ghost" data-brx aria-label="Remove rule">✕</button>'}</div>`;
  const dedText = list => list.map(d => `${d.name}: ${d.amount}`).join('\n');
  const breakTxt = R.breaks.length ? R.breaks.map(b => `shifts over ${b.after_hours}h: ${b.minutes} min unpaid break`).join('; ') : 'no unpaid breaks';
  const dedTxt = R.deductions.filter(u => u.deductions.length).map(u => `${u.name}: ${u.deductions.map(d => `${d.name} ${money(d.amount, cur())}`).join(', ')}`);
  host.innerHTML = `<h3>Payroll rules ${ro ? '<span class="chip gray">View only</span>' : ''}</h3>
    <div class="note in-effect"><b>✓ In effect now:</b> ${esc(breakTxt)} · pay period ${fmtDate(R.period_now[0])} – ${fmtDate(R.period_now[1])} · FNPF ${R.fnpf_employee_rate}% employee / ${R.fnpf_employer_rate}% employer · ${({ 52: 'weekly', 26: 'fortnightly', 24: 'twice a month', 12: 'monthly' })[R.pay_periods_per_year] || R.pay_periods_per_year + ' pays a year'}${dedTxt.length ? `<br>Regular deductions: ${dedTxt.map(esc).join(' · ')}` : ''}
      <div class="small muted" style="margin-top:4px">You'll see them on <a href="#/timesheets">Timesheets</a> (Unpaid break, Paid hours) and in the pay run <b>Preview</b> below (hours shown as worked − break, deductions under Other ded.), then on the payslips.</div></div>
    <div class="grid2">
      <div><b class="small">Unpaid breaks</b><p class="small muted" style="margin:2px 0 6px">Taken off each shift's hours before pay (the biggest rule that applies).</p>
        <div id="br-list">${(R.breaks.length ? R.breaks : [{}]).map(brRow).join('')}</div>${ro ? '' : '<button type="button" class="btn sm ghost" id="br-add">+ Add a break rule</button>'}</div>
      <div><b class="small">FNPF and pay periods</b>
        <div class="grid2" style="margin-top:6px"><div class="field"><label>FNPF employee %</label><input type="number" step="0.1" id="pr-ee" value="${R.fnpf_employee_rate}" ${ro ? 'disabled' : ''}></div>
          <div class="field"><label>FNPF employer %</label><input type="number" step="0.1" id="pr-er" value="${R.fnpf_employer_rate}" ${ro ? 'disabled' : ''}></div>
          <div class="field"><label>Pay period starts on <span class="muted">(any date a period began)</span></label><input type="date" id="pr-cycle" value="${esc(R.pay_cycle_start || '')}" ${ro ? 'disabled' : ''}></div>
          <div class="field"><label>How often (pay periods a year)</label><select id="pr-pp" ${ro ? 'disabled' : ''}>${[[52, 'Weekly (52)'], [26, 'Fortnightly (26)'], [24, 'Twice a month (24)'], [12, 'Monthly (12)']].map(([v, l]) => `<option value="${v}" ${R.pay_periods_per_year === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        <p class="small" style="margin:4px 0">📅 This pay period: <b>${fmtDate(R.period_now[0])} – ${fmtDate(R.period_now[1])}</b> · last: ${fmtDate(R.period_last[0])} – ${fmtDate(R.period_last[1])} · next: ${fmtDate(R.period_next[0])} – ${fmtDate(R.period_next[1])}</p>
        <div class="field" style="margin-top:8px"><label>When starting a new pay run</label><select id="pr-newrun" ${ro ? 'disabled' : ''}>${[['ask', 'Ask me each time'], ['copy', "Always copy last week's hours"], ['roster', "Always fill from the roster (people who don't clock in)"], ['empty', 'Always start empty']].map(([v, l]) => `<option value="${v}" ${(R.new_payrun_hours || 'ask') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <div class="small muted">"Start next pay run" on this page. Copied or filled hours are unapproved timesheet entries you can change. With "start empty", you can still copy them later.</div></div>
        <p class="small muted">PAYE tax brackets are in <a href="#/settings">Settings → Payroll</a>.</p></div></div>
    <b class="small">Regular deductions each pay</b><p class="small muted" style="margin:2px 0 6px">One per line, e.g. <code>Staff loan: 20</code>. Taken automatically every pay run and shown on the payslip.</p>
    <div class="ded-grid">${R.deductions.map(u => `<div class="field"><label>${esc(u.name)}</label><textarea rows="2" data-ded="${u.id}" placeholder="None" ${ro ? 'disabled' : ''}>${esc(dedText(u.deductions))}</textarea></div>`).join('') || '<p class="small muted">Staff with a pay rate show here.</p>'}</div>
    ${ro ? '' : '<div class="actions"><button type="button" class="btn sm coral" id="pr-save">Save payroll rules</button></div>'}`;
  if (ro) return;
  const bindX = () => $$('[data-brx]', host).forEach(b => b.onclick = () => b.closest('.br-row').remove()); bindX();
  $('#br-add', host).onclick = () => { $('#br-list', host).insertAdjacentHTML('beforeend', brRow()); bindX(); };
  $('#pr-save', host).onclick = async () => {
    const breaks = $$('.br-row', host).map(r => ({ after_hours: $('[data-bh]', r).value, minutes: $('[data-bm]', r).value })).filter(r => r.after_hours && r.minutes);
    const deductions = $$('[data-ded]', host).map(t => ({ id: +t.dataset.ded, deductions: t.value.split('\n').map(l => { const m = l.match(/^(.+?)[:=\-–]\s*\$?\s*([\d.]+)\s*$/); return m ? { name: m[1].trim(), amount: +m[2] } : null; }).filter(Boolean) }));
    const bad = $$('[data-ded]', host).some(t => t.value.split('\n').some(l => l.trim() && !/^(.+?)[:=\-–]\s*\$?\s*([\d.]+)\s*$/.test(l)));
    if (bad) return toast('Write each deduction as "Name: amount", e.g. Staff loan: 20');
    try { await api('/api/staff/payroll/rules', { method: 'PUT', body: { breaks, deductions, fnpf_employee_rate: $('#pr-ee', host).value, fnpf_employer_rate: $('#pr-er', host).value, pay_periods_per_year: $('#pr-pp', host).value, pay_cycle_start: $('#pr-cycle', host).value, new_payrun_hours: $('#pr-newrun', host).value } }); toast('Payroll rules saved: now in effect'); await drawPayRules(); try { await refreshMe(); } catch { } if ($('#pr-preview') && $('#pr-preview').innerHTML.trim()) $('#pr-form button').click(); }
    catch (e) { toast(e.message); }
  };
}
function payslipHTML(p, run) {
  let ded = []; try { ded = typeof p.deduction_lines === 'string' ? JSON.parse(p.deduction_lines || '[]') : (p.deduction_lines || []); } catch { }
  return `<div class="payslip"><div style="display:flex;gap:14px;align-items:center"><h3 style="margin:0">${esc(S.company_name)} — Payslip</h3></div><p class="small muted">${esc(S.address || '')}</p>
    <table><tr><td><b>${esc(p.employee_name)}</b><br><span class="small muted">${esc(p.position || '')}</span></td><td class="r small">${run.extra_reason ? `<b>Extra pay: ${esc(run.extra_reason)}</b><br>` : ''}Pay date: ${esc(run.pay_date || "not paid yet (draft)")}<br>Period: ${esc(run.period_start)} to ${esc(run.period_end)}<br>TIN: ${esc(p.tin || '—')} · FNPF: ${esc(p.fnpf_no || '—')}</td></tr></table>
    <table style="margin-top:10px">
      ${p.pay_type === 'hourly' && p.break_hours ? `<tr><td class="small muted">Hours worked ${p.worked_hours} − unpaid breaks ${p.break_hours}</td><td></td></tr>` : ''}
      ${/Hours adjusted /.test(p.notes || '') ? `<tr><td class="small" style="color:#8a5a00">${esc((p.notes.match(/Hours adjusted [^·]*/) || [''])[0].trim())}</td><td></td></tr>` : ''}
      <tr><td>${p.pay_type === 'hourly' ? `Paid hours ${p.hours} × ${money(p.pay_rate, cur())}` : 'Salary'}</td><td class="r">${money(p.base_pay, cur())}</td></tr>
      ${p.allowances ? `<tr><td>Allowances</td><td class="r">${money(p.allowances, cur())}</td></tr>` : ''}
      ${(() => { let lv = []; try { lv = typeof p.leave_lines === 'string' ? JSON.parse(p.leave_lines || '[]') : (p.leave_lines || []); } catch { } return lv.map(x => `<tr><td>${({ annual: 'Annual leave', sick: 'Sick leave', other: 'Other paid leave', payout: 'Unused annual leave paid out' })[x.kind] || 'Leave'} ${x.days} day${x.days === 1 ? '' : 's'}${x.late ? ` <span class="small muted">(earlier dates: ${esc((x.dates || []).join(', '))})</span>` : ''}${x.amount ? ` (${x.hours} h)` : ''}</td><td class="r">${x.amount ? money(x.amount, cur()) : '<span class="small muted">in salary</span>'}</td></tr>`).join(''); })()}
      <tr><td><b>Gross pay</b></td><td class="r"><b>${money(p.gross, cur())}</b></td></tr>
      <tr><td>FNPF employee contribution</td><td class="r">−${money(p.fnpf_employee, cur())}</td></tr>
      <tr><td>PAYE tax</td><td class="r">−${money(p.paye, cur())}</td></tr>
      ${ded.length ? ded.map(d => `<tr><td>${esc(d.name)}</td><td class="r">−${money(d.amount, cur())}</td></tr>`).join('') : p.other_deductions ? `<tr><td>Other deductions</td><td class="r">−${money(p.other_deductions, cur())}</td></tr>` : ''}
      <tr><td><b>Net pay</b>${p.bank_account ? `<br><span class="small muted">To account ${esc(p.bank_account)}</span>` : ''}</td><td class="r" style="font-size:1.2rem"><b>${money(p.net, cur())}</b></td></tr>
      <tr><td class="small muted">Employer FNPF contribution</td><td class="r small muted">${money(p.fnpf_employer, cur())}</td></tr>
    </table>
    ${p.ytd ? `<h4 style="margin:14px 0 4px;font-size:.95rem">Year to date (${esc(p.ytd.year)})</h4><table class="ytd">
      ${[['Gross pay', money(p.ytd.gross, cur())], ['PAYE tax', money(p.ytd.paye, cur())], ['FNPF — employee', money(p.ytd.fnpf_employee, cur())], ['FNPF — employer', money(p.ytd.fnpf_employer, cur())], ['FNPF total', money(p.ytd.fnpf_total, cur())],
        ['Deductions', money(p.ytd.deductions, cur())], ['Net pay', money(p.ytd.net, cur())], ['Paid hours', (+p.ytd.hours).toFixed(2)],
        ['Annual leave (days)', `${p.ytd.annual_taken} taken · <b>${p.ytd.annual_left} left</b>`], ['Sick leave (days)', `${p.ytd.sick_taken} taken · <b>${p.ytd.sick_left} left</b>`],
        ...(p.ytd.other_taken ? [['Other paid leave (days)', p.ytd.other_taken]] : []), ...(p.ytd.unpaid_taken ? [['Unpaid leave (days)', p.ytd.unpaid_taken]] : [])]
        .map(([k, v]) => `<tr><td class="small">${k}</td><td class="r small">${v}</td></tr>`).join('')}</table>` : ''}</div>`;
}
// M7: email payslips (any dates, or a pay run's); asks before sending a pay period again
const emailPayslips = body => api('/api/staff/payslips/email', { body }).catch(e => {
  if (e.data && e.data.already_sent && confirm(`${e.message}\n\n${e.data.already_sent.map(x => `• ${x.name}: sent ${new Date(x.at).toLocaleString()}`).join('\n')}`)) return api('/api/staff/payslips/email', { body: { ...body, resend: true } });
  throw e;
});
const emailResult = r => { const why = l => [...new Set(l.map(x => x.reason))].join(' ');
  return [r.sent.length ? `✅ Sent to ${r.sent.join(', ')}.` : 'No payslips sent yet.', (r.waiting || []).length ? `⏳ Will send again automatically: ${r.waiting.map(x => x.name).join(', ')}. ${why(r.waiting)}` : '',
    (r.failed || []).length ? `❌ Not sent: ${r.failed.map(x => `${x.name} (${x.reason})`).join('; ')}` : '', r.missing.length ? `No email on record for ${r.missing.join(', ')} (Staff → Email).` : ''].filter(Boolean).join(' · '); };
function printHTML(html) { const w = window.open('', '_blank'); w.document.write(`<html><head><title>Payslip</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/staff.css"><style>body{background:#fff;padding:30px}.payslip{page-break-after:always;max-width:640px;margin:0 auto 40px}</style></head><body>${html}<script>setTimeout(()=>print(),400)<\/script></body></html>`); w.document.close(); }
async function runModal(id) {
  const { run, payslips } = await api(`/api/staff/payroll/runs/${id}`);
  const m = openModal(`<h2 style="font-size:1.5rem">Pay run — ${fmtDate(run.pay_date, { day: 'numeric', month: 'long', year: 'numeric' })}</h2>
    <p class="muted">${run.extra_reason ? `<span class="chip">Extra pay run: ${esc(run.extra_reason)}</span> ` : ''}${run.note ? `<span class="chip gray">${esc(run.note)}</span> ` : ''}${run.period_start} to ${run.period_end} · Gross ${money(run.total_gross, cur())} · Net ${money(run.total_net, cur())} · Employer FNPF ${money(run.total_fnpf_employer, cur())}</p>
    ${table([{ h: 'Employee', k: 'employee_name' }, { h: 'Hours', k: 'hours', r: 1 }, { h: 'Gross', f: p => money(p.gross, cur()), r: 1 }, { h: 'FNPF', f: p => money(p.fnpf_employee, cur()), r: 1 }, { h: 'PAYE', f: p => money(p.paye, cur()), r: 1 }, { h: 'Net', f: p => `<b>${money(p.net, cur())}</b>`, r: 1 }, { h: '', f: p => `<button class="btn sm ghost" data-ps="${p.id}">Payslip</button>` }], payslips)}
    <div class="actions"><button class="btn sm" id="print-all">Print all payslips</button>${window.riyser ? '<button class="btn sm ghost" id="pdf-all">Save all as PDF</button>' : ''}<button class="btn sm ghost" id="mail-run">Email payslips</button>${L('payroll') >= 3 ? '<button class="btn sm danger" id="del-run">Void (delete) run</button>' : ''}</div>`, { wide: true });
  $('#mail-run', m.el).onclick = async () => { if (!confirm('Email each person in this pay run their payslip (with a PDF)?')) return; try { toast(emailResult(await emailPayslips({ run_id: id })), 12000); } catch (e) { toast(e.message, 8000); } };
  $$('[data-ps]', m.el).forEach(b => b.onclick = () => printHTML(payslipHTML(payslips.find(p => p.id == b.dataset.ps), run)));
  $('#print-all', m.el).onclick = () => printHTML(payslips.map(p => payslipHTML(p, run)).join(''));
  if ($('#pdf-all', m.el)) $('#pdf-all', m.el).onclick = () => savePdf(`Payslips paid ${run.pay_date} (${run.period_start} to ${run.period_end})`, payslips.map(p => payslipHTML(p, run)).join(''));
  if ($('#del-run', m.el)) $('#del-run', m.el).onclick = async () => { if (confirm('Void this pay run? It and its payslips are deleted, so these dates can be paid again.')) { await api(`/api/staff/payroll/runs/${id}`, { method: 'DELETE' }); m.close(); renderPayroll(); } };
}
async function renderMyPayslips() {
  const rows = await api('/api/staff/payslips/mine');
  view().innerHTML = `<div class="panel" style="padding:0">${table([{ h: 'Pay date', f: p => fmtDate(p.pay_date, { day: 'numeric', month: 'short', year: 'numeric' }) }, { h: 'Period', f: p => `${fmtDate(p.period_start)} – ${fmtDate(p.period_end)}` },
    { h: 'Hours', k: 'hours', r: 1 }, { h: 'Gross', f: p => money(p.gross, cur()), r: 1 }, { h: 'Net', f: p => `<b>${money(p.net, cur())}</b>`, r: 1 }], rows, { onRow: 1, empty: 'No payslips yet.' })}</div>`;
  bindRows(view(), rows, p => { const m = openModal(payslipHTML(p, p) + `<div class="actions"><button class="btn sm">Print</button></div>`); $('.actions .btn', m.el).onclick = () => printHTML(payslipHTML(p, p)); });
}

// ------------------------------------------------------------------ settings & privileges
// Settings → Email (Super admin): the company's mailbox, what to send, who gets copies
async function drawEmailSettings() {
  const host = $('#s-email'); if (!host) return;
  const E = await api('/api/staff/email');
  const on = k => E[k] === '1';
  const staffIds = String(E.email_staff_ids || '').split(',').filter(Boolean);
  const subs = E.subs || {};
  const SUBS = [['timesheets_daily', 'Daily timesheets', 'End of each day: every shift in / out, hours, unpaid break, paid hours, and who is still clocked in'],
    ['timesheets', 'Weekly timesheets', 'Monday morning: last week\'s shifts, hours, breaks and paid hours']];
  host.innerHTML = `<h3>📧 Emails <span class="chip ${on('email_enabled') ? '' : 'gray'}">${on('email_enabled') ? 'On' : 'Off'}</span></h3>
    <p class="small muted" style="margin-top:-4px">Timesheets and payslips are sent from the company's own mailbox. Use the SMTP details from your email provider (look for "SMTP settings" in its help): usually port <code>465</code> (SSL) or <code>587</code> (STARTTLS), username = the full email address, password = that mailbox's password (or an "app password" for Gmail and Microsoft 365).</p>
    <form id="em-form">
      <div class="grid2">
        <div class="field"><label>Send from (email address)</label><input name="email_from" value="${esc(E.email_from)}" placeholder="payroll@yourcompany.com"></div>
        <div class="field"><label>Name shown</label><input name="email_from_name" value="${esc(E.email_from_name)}" placeholder="${esc(S.company_name)}"></div>
        <div class="field"><label>Email host (SMTP)</label><input name="smtp_host" value="${esc(E.smtp_host || '')}" placeholder="e.g. mail.privateemail.com, smtp.gmail.com"></div>
        <div class="field"><label>Port &amp; security</label><div style="display:flex;gap:6px"><input name="smtp_port" value="${esc(E.smtp_port || '465')}" style="width:90px">
          <select name="smtp_secure">${[['ssl', 'SSL (465)'], ['starttls', 'STARTTLS (587)'], ['none', 'None']].map(([v, l]) => `<option value="${v}" ${(E.smtp_secure || 'ssl') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        <div class="field"><label>Username</label><input name="smtp_user" value="${esc(E.smtp_user)}" placeholder="payroll@yourcompany.com" autocomplete="off"></div>
        <div class="field"><label>Password</label><input name="smtp_pass" type="password" autocomplete="new-password" placeholder="${E.has_password ? '•••••••• saved (type to change)' : 'Mailbox password'}"></div>
      </div>
      <div class="field"><label>Send a copy to (email addresses)</label><input name="email_club_copy" value="${esc(E.email_club_copy)}" placeholder="office@yourcompany.com" style="max-width:420px"></div>
      <div class="field"><b class="small">Who gets what</b> <span class="small muted">— tick the emails each person gets</span>
        <div class="scroll"><table class="t subs-table"><thead><tr><th>Who</th>${SUBS.map(([k, l, d]) => `<th class="c" title="${esc(d)}">${l}</th>`).join('')}</tr></thead><tbody>
          <tr><td><b>Send a copy to</b><div class="small muted">${esc(E.email_club_copy || 'not set')}</div></td>${SUBS.map(([k]) => `<td class="c"><input type="checkbox" data-sub="club:${k}" ${(subs.club || []).includes(k) ? 'checked' : ''}></td>`).join('')}</tr>
          ${E.staff.filter(u => u.email).map(u => `<tr><td><b>${esc(u.name)}</b> <span class="chip ${u.role === 'admin' ? 'coral' : u.role === 'manager' ? '' : 'gray'}" style="font-size:.7rem">${u.role === 'admin' ? 'Administrator' : 'Staff'}</span><div class="small muted">${esc(u.email)}</div></td>${SUBS.map(([k]) => `<td class="c"><input type="checkbox" data-sub="${u.id}:${k}" ${(subs[u.id] || []).includes(k) ? 'checked' : ''}></td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
        <div class="bar-tools" style="margin-top:8px"><label class="small">Daily timesheets at <input name="report_time_daily" type="time" value="${esc(E.report_time_daily || '18:30')}"></label>
          <label class="small">Weekly reports (Mondays) at <input name="report_time_weekly" type="time" value="${esc(E.report_time_weekly || '07:30')}"></label>
          <span class="grow"></span>${SUBS.map(([k, l]) => `<button type="button" class="btn sm ghost" data-rep="${k}">Send ${l.toLowerCase()} now</button>`).join('')}</div></div>
      <label class="check" style="font-weight:600;margin:8px 0"><input type="checkbox" name="email_enabled" ${on('email_enabled') ? 'checked' : ''}> Turn emails on</label>
      <div class="actions"><button class="btn sm coral">Save</button>
        </div>
      <div class="field" style="margin-top:12px"><label>Send a test email to <span class="muted">(tick one or more)</span></label>
        <div class="em-staff">${E.staff.filter(u => u.email).map(u => `<label class="check" style="font-weight:500"><input type="checkbox" data-tto="${esc(u.email)}"> ${esc(u.name)} <span class="chip ${u.role === 'admin' ? 'coral' : u.role === 'manager' ? '' : 'gray'}" style="font-size:.7rem">${u.role === 'admin' ? 'Administrator' : 'Staff'}</span> <span class="small muted">${esc(u.email)}</span></label>`).join('') || '<span class="small muted">No staff or admins with an email yet.</span>'}</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input id="em-to" placeholder="Other emails, separated by commas" style="flex:1;min-width:220px"><button type="button" class="btn sm ghost" id="em-test">Send test email</button></div></div>
      ${E.staff.some(u => !u.email) ? `<p class="small muted">Staff without an email (${E.staff.filter(u => !u.email).map(u => esc(u.name)).join(', ')}) can be added under <a href="#/employees">Staff</a>, then they show here.</p>` : ''}
    </form>
    ${E.waiting ? `<div class="note" style="margin-top:10px">⏳ <b>${E.waiting} email${E.waiting > 1 ? 's are' : ' is'} waiting</b> to send again (your email provider's hourly limit was reached). ${E.waiting > 1 ? 'They go' : 'It goes'} out automatically; nothing to do.</div>` : ''}
    ${E.log.length ? `<details style="margin-top:10px"><summary class="small"><b>Recent emails</b> (${E.log.filter(l => l.status === 'failed').length} failed)</summary>${table([
      { h: 'When', f: l => new Date(l.at).toLocaleString('en-FJ', { timeZone: S.timezone || 'Pacific/Fiji', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) },
      { h: 'To', k: 'to_addr' }, { h: 'Email', k: 'subject' }, { h: 'Status', f: l => l.status === 'sent' ? `<span class="status confirmed">sent</span>${l.error ? `<div class="small muted">${esc(l.error)}</div>` : ''}` : l.status === 'waiting' ? `<span class="status maintenance">waiting</span><div class="small">${esc(l.error)}</div>` : `<span class="status cancelled">failed</span><div class="small">${esc(l.error)}</div>` }], E.log)}</details>` : ''}`;
  const f = $('#em-form', host);
  const body = () => { const v = formData(f); v.email_enabled = f.email_enabled.checked ? '1' : '0';
    const o = {}; $$('[data-sub]', host).filter(x => x.checked).forEach(x => { const [w, k] = x.dataset.sub.split(':'); (o[w] = o[w] || []).push(k); });
    v.email_subs = JSON.stringify(o);  if (!v.smtp_pass) delete v.smtp_pass; return v; };
  $$('[data-rep]', host).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await api('/api/staff/email', { method: 'PUT', body: body() }); const r = await api('/api/staff/email/report', { body: { kind: b.dataset.rep } }); toast(`✅ Sent to ${r.sent_to.join(', ')}`, 6000); drawEmailSettings(); }
    catch (err) { toast(err.message, 8000); b.disabled = false; }
  });
  f.onsubmit = async e => { e.preventDefault(); try { await api('/api/staff/email', { method: 'PUT', body: body() }); toast('Email settings saved'); drawEmailSettings(); } catch (err) { toast(err.message); } };
  $('#em-test', host).onclick = async () => {
    const to = [...$$('[data-tto]', host).filter(x => x.checked).map(x => x.dataset.tto), ...$('#em-to', host).value.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean)];
    if (!to.length) return toast('Tick who to send the test to (or type an email)');
    const b = $('#em-test', host); b.disabled = true; b.textContent = 'Sending…';
    try { await api('/api/staff/email', { method: 'PUT', body: body() }); const r = await api('/api/staff/email/test', { body: { to } }); toast(`✅ Test email sent to ${r.sent_to.length} ${r.sent_to.length === 1 ? 'person' : 'people'}: ${r.sent_to.join(', ')}`, 6000); drawEmailSettings(); }
    catch (err) { toast(err.message, 8000); b.disabled = false; b.textContent = 'Send test email'; }
  };
}
// ------------------------------------------------------------------ dashboard
const weekHours = () => +S.normal_week_hours || 40;
const monthName = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-FJ', { month: 'long', year: 'numeric' });
const monthShort = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-FJ', { month: 'short', year: 'numeric' });
async function renderDashboard() {
  let pp = null; try { pp = await api('/api/staff/payroll/period'); } catch { }
  const [ps, pe] = pp ? pp.current : [addDays(today(), -6), today()];
  const [clock, shifts] = await Promise.all([CAN.has('timeclock.use') ? api('/api/staff/timeclock').catch(() => null) : null, api(`/api/staff/timesheets?from=${ps}&to=${pe}`)]);
  const per = {}; for (const r of shifts) { const p = per[r.user_id] || (per[r.user_id] = { name: r.name, h: 0, days: new Set() }); p.h += r.clock_out ? r.paid_hours : 0; p.days.add(r.clock_in.slice(0, 10)); }
  const people = Object.values(per).sort((a, b) => a.name.localeCompare(b.name));
  const on = clock ? clock.staff.filter(s => s.on_shift) : [];
  const wk = weekHours(), periodLen = Math.round((Date.parse(pe) - Date.parse(ps)) / 864e5) + 1, target = Math.round(wk * periodLen / 7 * 100) / 100;
  view().innerHTML = `
    <div class="tiles">
      ${clock ? `<div class="tile"><div class="k">On shift now</div><div class="v" style="color:var(--green-700)">${on.length}</div><div class="s">${on.length ? on.map(s => esc(s.name.split(' ')[0])).join(', ') : 'nobody clocked in'}</div></div>` : ''}
      <div class="tile"><div class="k">${canTS() ? 'Paid hours this pay period' : 'My paid hours this pay period'}</div><div class="v">${people.reduce((a, p) => a + p.h, 0).toFixed(2)}</div><div class="s">${fmtDate(ps)} – ${fmtDate(pe)}</div></div>
      ${clock ? `<div class="tile"><div class="k">Staff</div><div class="v">${clock.staff.length}</div><div class="s">on the time clock</div></div>` : ''}
      <div class="tile"><div class="k">Normal week</div><div class="v">${wk}h</div><div class="s">${fmtTime(S.normal_start || '09:00')} – ${fmtTime(S.normal_finish || '17:00')}, ${Math.round(wk / 8)} days</div></div>
    </div>
    <div class="bar-tools">${CAN.has('timeclock.use') ? '<a class="btn sm" href="#/timeclock">⏱ Time clock</a>' : ''}<a class="btn sm ghost" href="#/timesheets">🗓 Timesheets</a>${L('payroll') >= 1 ? '<a class="btn sm ghost" href="#/payroll">💵 Payroll</a><a class="btn sm ghost" href="#/import">⬆ Import wage reports</a>' : ''}</div>
    <div class="panel"><h3>Hours this pay period</h3><p class="small muted" style="margin-top:-4px">${fmtDate(ps)} – ${fmtDate(pe)} · ${target}h is a normal ${periodLen === 7 ? 'week' : 'pay period'}</p>
      ${people.length ? `<div class="hours-list">${people.map(p => { const pct = Math.min(100, p.h / target * 100), over = p.h > target + 0.01;
        return `<div class="hours-row"><div class="hr-name"><b>${esc(p.name)}</b><span class="small muted">${p.days.size} day${p.days.size === 1 ? '' : 's'}</span></div>
          <div class="hr-bar"><i style="width:${pct}%;${over ? 'background:var(--gold)' : ''}"></i></div><div class="hr-num"><b>${p.h.toFixed(2)}</b> / ${target}h${over ? `<div class="small" style="color:var(--gold)">+${(p.h - target).toFixed(2)} extra</div>` : ''}</div></div>`; }).join('')}</div>`
        : '<div class="empty">No shifts yet this pay period.</div>'}</div>`;
}

// ------------------------------------------------------------------ pay history (imported wage reports)
let PH = {};
async function renderHistory(f = PH) {
  PH = f;
  const d = await api(`/api/staff/pay-history?year=${f.year || ''}`);
  const emps = [...new Map(d.rows.map(r => [r.user_id, r.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const rows = d.rows.filter(r => !f.user_id || r.user_id == f.user_id);
  const K = ['hours', 'gross', 'fnpf_employee', 'fnpf_employer', 'paye', 'other_deductions', 'net'];
  const sumOf = list => Object.fromEntries(K.map(k => [k, list.reduce((a, r) => a + (+r[k] || 0), 0)]));
  const byPerson = {}; for (const r of rows) ((byPerson[r.user_id] = byPerson[r.user_id] || { name: r.name, months: {} }).months[r.month] = byPerson[r.user_id].months[r.month] || []).push(r);
  const tot = sumOf(rows), m2 = v => money(v, cur());
  view().innerHTML = `
    <div class="bar-tools no-print">
      <select id="ph-year">${(d.years.length ? d.years : [d.year]).map(y => `<option ${y === d.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <select id="ph-user"><option value="">All staff</option>${emps.map(([id, n]) => `<option value="${id}" ${f.user_id == id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <a class="btn sm ghost" href="/api/staff/export/pay-history.csv">⬇ CSV</a><button class="btn sm ghost" onclick="print()">🖨 Print</button></div>
    <div class="print-only"><h3>${esc(S.company_name)}: pay history ${esc(d.year)}</h3></div>
    ${rows.length ? `<div class="tiles">
      <div class="tile"><div class="k">Gross pay</div><div class="v">${m2(tot.gross)}</div><div class="s">${new Set(rows.map(r => r.month)).size} months · ${rows.length} weekly pays</div></div>
      <div class="tile"><div class="k">Net paid</div><div class="v">${m2(tot.net)}</div><div class="s">after FNPF, PAYE and deductions</div></div>
      <div class="tile"><div class="k">FNPF</div><div class="v">${m2(tot.fnpf_employee + tot.fnpf_employer)}</div><div class="s">${m2(tot.fnpf_employee)} staff · ${m2(tot.fnpf_employer)} company</div></div>
      <div class="tile"><div class="k">Hours</div><div class="v">${tot.hours.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div><div class="s">paid hours</div></div></div>
    <p class="small muted">Tap a person to see their months. From the monthly wage reports. The company FNPF (${esc(S.fnpf_employer_rate || 10)}%) wasn't on the sheets, so it's worked out here. These count in each person's year-to-date totals on payslips.</p>
    ${Object.entries(byPerson).map(([uid, p]) => { const all = Object.values(p.months).flat(), t = sumOf(all);
      return `<details class="panel ph-person" ${f.user_id || Object.keys(byPerson).length === 1 ? 'open' : ''}><summary><b>${esc(p.name)}</b><span class="small muted">${m2(t.gross)} gross · ${m2(t.net)} net · ${t.hours.toFixed(2)} hrs</span></summary>${table([
        { h: 'Month', f: x => `<b>${monthShort(x.month)}</b><div class="small muted">${x.weeks.length} week${x.weeks.length === 1 ? '' : 's'}${x.rates.length ? ' · ' + x.rates.map(r => money(r, cur()) + '/hr').join(', ') : ''}</div>` },
        { h: 'Hours', f: x => x.s.hours.toFixed(2), r: 1 }, { h: 'Gross', f: x => m2(x.s.gross), r: 1 }, { h: 'FNPF staff', f: x => m2(x.s.fnpf_employee), r: 1 }, { h: 'FNPF company', f: x => m2(x.s.fnpf_employer), r: 1 },
        { h: 'PAYE', f: x => m2(x.s.paye), r: 1 }, { h: 'Deductions', f: x => m2(x.s.other_deductions), r: 1 }, { h: 'Net', f: x => `<b>${m2(x.s.net)}</b>`, r: 1 },
        ...(d.bank && d.bank.length ? [{ h: 'Paid from bank', f: x => { const bk = d.bank.find(z => z.user_id == uid && z.month === x.month); if (!bk) return '<span class="muted">—</span>'; const diff = Math.round((bk.paid - x.s.net) * 100) / 100;
          return `${m2(bk.paid)}${Math.abs(diff) >= 0.01 ? `<div class="small" style="color:var(--red)">${diff > 0 ? '+' : '−'}${m2(Math.abs(diff))} vs net</div>` : '<div class="small" style="color:var(--green-700)">✓ matches</div>'}`; }, r: 1 }] : []),
        { h: '', f: x => `<button class="btn sm ghost" data-wk="${uid}|${x.month}">Weeks</button>${L('payroll') >= 3 ? ` <button class="btn sm ghost" data-rm="${uid}|${x.month}" title="Remove this month">✕</button>` : ''}` }],
        Object.entries(p.months).sort().map(([month, weeks]) => ({ month, weeks, s: sumOf(weeks), rates: [...new Set(weeks.map(w => w.rate).filter(Boolean))] })))}</details>`; }).join('')}`
      : `<div class="empty">No pay history for ${esc(d.year)} yet. ${VIEWS.import.show() ? 'Bring in the monthly wage reports on <a href="#/import">Import wage reports</a>.' : ''}</div>`}`;
  $('#ph-year').onchange = () => renderHistory({ ...PH, year: $('#ph-year').value });
  $('#ph-user').onchange = () => renderHistory({ ...PH, user_id: $('#ph-user').value });
  $$('[data-wk]').forEach(b => b.onclick = () => { const [uid, month] = b.dataset.wk.split('|'); const list = byPerson[uid].months[month];
    openModal(`<h2 style="font-size:1.4rem">${esc(byPerson[uid].name)} — ${monthName(month)}</h2>${table([{ h: 'Week', f: w => `Week ${w.week}${w.comment ? `<div class="small muted">${esc(w.comment)}</div>` : ''}` }, { h: 'Hours', k: 'hours', r: 1 }, { h: 'Rate', f: w => money(w.rate, cur()), r: 1 },
      { h: 'Bonus', f: w => w.bonus ? m2(w.bonus) : '—', r: 1 }, { h: 'Gross', f: w => m2(w.gross), r: 1 }, { h: 'FNPF', f: w => m2(w.fnpf_employee), r: 1 }, { h: 'PAYE', f: w => m2(w.paye), r: 1 }, { h: 'Deductions', f: w => w.other_deductions ? m2(w.other_deductions) : '—', r: 1 }, { h: 'Net', f: w => `<b>${m2(w.net)}</b>`, r: 1 }], list)}
      <p class="small muted">From ${esc(list[0].source || 'the wage report')}.</p>`, { wide: true }); });
  $$('[data-rm]').forEach(b => b.onclick = async () => { const [uid, month] = b.dataset.rm.split('|');
    if (!confirm(`Remove ${byPerson[uid].name}'s pay history for ${monthName(month)}? (You can import the file again.)`)) return;
    try { await api(`/api/staff/pay-history?user_id=${uid}&month=${month}`, { method: 'DELETE' }); toast('Removed'); renderHistory(); } catch (e) { toast(e.message); } });
}

// ------------------------------------------------------------------ import the monthly Excel wage reports
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const guessMonth = name => { const n = name.toLowerCase(), i = MONTH_KEYS.findIndex(k => new RegExp(`(^|[^a-z])${k}`).test(n)); if (i < 0) return ''; return `${(n.match(/20\d\d/) || [today().slice(0, 4)])[0]}-${String(i + 1).padStart(2, '0')}`; };
const fileB64 = file => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => no(new Error(`Couldn't read ${file.name}`)); r.readAsDataURL(file); });
let IMP = { files: [], preview: null };
async function renderImport() {
  view().innerHTML = `
    <div class="panel"><h3>1. Choose the monthly wage reports</h3>
      <p class="small muted" style="margin-top:-4px">The Excel files with one sheet per person and a row per week (hours, rate, bonus, gross, FNPF, PAYE, other deductions, net). Choose several months at once. Nothing is saved until you press <b>Import</b>.</p>
      <label class="btn sm file-btn">📂 Choose Excel files<input type="file" id="im-files" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple hidden></label>
      <div id="im-list"></div></div>
    <div id="im-preview"></div>`;
  const drawList = () => {
    $('#im-list').innerHTML = IMP.files.length ? `<div class="im-files">${IMP.files.map((f, i) => `<div class="im-file"><span class="im-name">📄 ${esc(f.name)}</span>
      <label class="small">Month<input type="month" data-mo="${i}" value="${esc(f.month)}"></label><button type="button" class="btn sm ghost" data-rmf="${i}" aria-label="Remove">✕</button></div>`).join('')}</div>
      <div class="actions"><button class="btn" id="im-check">Check files</button></div>` : '';
    $$('[data-mo]').forEach(i => i.onchange = () => { IMP.files[i.dataset.mo].month = i.value; });
    $$('[data-rmf]').forEach(b => b.onclick = () => { IMP.files.splice(+b.dataset.rmf, 1); IMP.preview = null; $('#im-preview').innerHTML = ''; drawList(); });
    if ($('#im-check')) $('#im-check').onclick = check;
  };
  $('#im-files').onchange = async e => {
    for (const file of e.target.files) { if (file.size > 3e6) { toast(`${file.name} is too big (over 3 MB)`); continue; } IMP.files.push({ name: file.name, month: guessMonth(file.name), data: await fileB64(file) }); }
    IMP.files.sort((a, b) => (a.month || 'z').localeCompare(b.month || 'z')); e.target.value = ''; IMP.preview = null; $('#im-preview').innerHTML = ''; drawList();
  };
  const check = async () => {
    const b = $('#im-check'); b.disabled = true; b.textContent = 'Checking…';
    try { IMP.preview = await api('/api/staff/import/wages/preview', { body: { files: IMP.files } }); drawPreview(); }
    catch (e) { toast(e.message, 7000); } finally { b.disabled = false; b.textContent = 'Check files'; }
  };
  const drawPreview = () => {
    const P = IMP.preview, m2 = v => money(v, cur());
    const tot = P.people.reduce((a, p) => ({ weeks: a.weeks + p.totals.weeks, gross: a.gross + p.totals.gross, net: a.net + p.totals.net }), { weeks: 0, gross: 0, net: 0 });
    const issues = P.people.reduce((a, p) => a + p.issues.length, 0) + P.problems.filter(x => x.level === 'warn').length;
    $('#im-preview').innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="k">Months</div><div class="v">${P.months.length}</div><div class="s">${P.months.map(m => monthShort(m.month)).join(', ')}</div></div>
        <div class="tile"><div class="k">People</div><div class="v">${P.people.length}</div><div class="s">${tot.weeks} weekly pays</div></div>
        <div class="tile"><div class="k">Gross · net</div><div class="v">${m2(tot.gross)}</div><div class="s">${m2(tot.net)} net paid</div></div>
        <div class="tile"><div class="k">To check</div><div class="v" style="color:${issues ? 'var(--red)' : 'var(--green-700)'}">${issues}</div><div class="s">${issues ? 'things that look wrong on the sheets' : 'all looks right'}</div></div></div>
      ${P.problems.length ? `<div class="panel"><h3>Across the files</h3><ul class="im-issues">${P.problems.map(x => `<li class="${x.level}">${esc(x.text)}</li>`).join('')}</ul></div>` : ''}
      <div class="panel"><h3>2. Check each person</h3><p class="small muted" style="margin-top:-4px">Each sheet name is one person. Choose who it is: a new staff member, someone already on Staff, or the same person as another sheet (e.g. a misspelt name). Figures are taken as they are on the sheets; the sheets' own YTD totals aren't used.</p>
        <div class="im-people">${P.people.map((p, i) => `<div class="im-person" data-key="${esc(p.key)}">
          <div class="im-head"><div><b>${esc(p.sheet)}</b> <span class="small muted">sheet</span><div class="small">${esc(p.name)}${p.rate ? ` · ${money(p.rate, cur())}/hr now` : ''}</div></div>
            <div class="im-sum small"><b>${m2(p.totals.gross)}</b> gross<br>${p.totals.weeks} weeks · ${p.totals.hours.toFixed(2)} hrs</div></div>
          <div class="im-choose">
            <label class="small">This is<select data-act>
              <option value="new" ${p.user_id ? '' : 'selected'}>A new staff member</option>
              ${P.staff.length ? `<option value="existing" ${p.user_id ? 'selected' : ''}>Someone on Staff</option>` : ''}
              ${P.people.length > 1 ? '<option value="same">Same person as another sheet</option>' : ''}
              <option value="skip">Don't import</option></select></label>
            <label class="small" data-for="new">Name<input data-name value="${esc(p.name)}"></label>
            <label class="small hidden" data-for="existing">Staff member<select data-user>${P.staff.map(u => `<option value="${u.id}" ${u.id === p.user_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
            <label class="small hidden" data-for="same">Same as<select data-same>${P.people.filter(o => o.key !== p.key).map(o => `<option value="${esc(o.key)}">${esc(o.sheet)} (${esc(o.name)})</option>`).join('')}</select></label>
          </div>
          <div class="small muted im-details">FNPF ${esc(p.details.fnpf_no || '—')} · ${esc(p.details.bank_name || 'Bank —')} ${esc(p.details.bank_account || '')}${p.details.bank_account_name ? ` (${esc(p.details.bank_account_name)})` : ''}</div>
          ${p.already.length ? `<div class="small" style="color:var(--gold)">Already imported for ${p.already.map(monthShort).join(', ')}: importing again replaces those weeks.</div>` : ''}
          ${p.issues.length ? `<details class="im-iss"><summary class="small"><b style="color:var(--red)">${p.issues.length} thing${p.issues.length === 1 ? '' : 's'} to check</b></summary><ul class="im-issues">${p.issues.map(t => `<li class="warn">${esc(t)}</li>`).join('')}</ul></details>` : ''}
          <details class="im-iss"><summary class="small">Months</summary>${table([{ h: 'Month', f: m => monthShort(m.month) }, { h: 'Weeks', k: 'weeks', r: 1 }, { h: 'Hours', f: m => m.hours.toFixed(2), r: 1 }, { h: 'Gross', f: m => m2(m.gross), r: 1 }, { h: 'Net', f: m => m2(m.net), r: 1 },
            { h: 'Sheet YTD', f: m => m.sheet_ytd == null ? '—' : Math.abs(m.sheet_ytd - m.gross) > 0.01 ? `<span style="color:var(--red)">${m2(m.sheet_ytd)}</span>` : m2(m.sheet_ytd), r: 1 }], p.months)}</details>
        </div>`).join('')}</div>
        <div class="actions"><button class="btn coral" id="im-go">Import</button><span class="small muted" style="align-self:center">New staff get a login username and a time-clock PIN. Set their password under Staff before they log in.</span></div></div>`;
    $$('.im-person').forEach(el => { const sel = $('[data-act]', el), sync = () => $$('[data-for]', el).forEach(x => x.classList.toggle('hidden', x.dataset.for !== sel.value)); sel.onchange = sync; sync(); });
    $('#im-go').onclick = async () => {
      const people = {};
      for (const el of $$('.im-person')) { const a = $('[data-act]', el).value; people[el.dataset.key] = { action: a, name: $('[data-name]', el).value, user_id: $('[data-user]', el) && $('[data-user]', el).value, same_as: $('[data-same]', el) && $('[data-same]', el).value }; }
      const same = Object.entries(people).filter(([, c]) => c.action === 'same');
      if (same.some(([k, c]) => !people[c.same_as] || ['same', 'skip'].includes(people[c.same_as].action))) return toast('"Same as" must point at a sheet that is being imported as a person (new or on Staff).', 6000);
      if (!confirm(`Import ${P.months.length} month${P.months.length === 1 ? '' : 's'} of wages for ${Object.values(people).filter(c => !['skip', 'same'].includes(c.action)).length} people?`)) return;
      const b = $('#im-go'); b.disabled = true; b.textContent = 'Importing…';
      try { const r = await api('/api/staff/import/wages', { body: { files: IMP.files, people } }); toast(`✓ Imported ${r.rows} weekly pays${r.replaced ? ` (${r.replaced} replaced)` : ''}${r.created ? ` · ${r.created} new staff` : ''}`, 6000); IMP = { files: [], preview: null }; location.hash = '#/history'; }
      catch (e) { toast(e.message, 7000); b.disabled = false; b.textContent = 'Import'; }
    };
  };
  drawList(); if (IMP.preview) drawPreview();
}

// ------------------------------------------------------------------ settings & privileges
async function renderSettings() {
  S = await api('/api/staff/settings');
  const me = await api('/api/auth/me'); LABELS = me.permission_labels;
  const perms = JSON.parse(S.booking_permissions || '{}');
  const ro = L('setup') < 2;
  const sect = (id, title, desc, body) => `<form class="panel" id="${id}"><h3>${title}</h3>${desc ? `<p class="small muted" style="margin-top:-4px">${desc}</p>` : ''}${body}${ro ? '' : '<div class="actions"><button class="btn sm">Save</button></div>'}</form>`;
  const dis = defs => ro ? defs.map(d => ({ ...d, dis: true })) : defs;
  view().innerHTML = `${ro ? '<div class="note">You can view these settings. Changing them needs Add & edit access to Setup.</div>' : ''}
    ${sect('s-co', 'Company details', 'Shown on payslips, timesheets and emails.', fieldsHTML(dis([{ n: 'company_name', l: 'Company name' }, { n: 'phone', l: 'Phone' }, { n: 'address', l: 'Address', full: 1 }, { n: 'email', l: 'Email (replies to payslip emails go here)', full: 1 }]), S))}
    ${sect('s-week', 'Normal working week', 'Everyone works a normal week of these hours. Hours over it are shown as extra on the Dashboard; the multi-shift grid starts with the normal day\'s times.',
      fieldsHTML(dis([{ n: 'normal_week_hours', l: 'Normal week (hours)', t: 'number', step: '0.5', min: 1 }, { n: 'normal_start', l: 'Normal day starts', t: 'time' }, { n: 'normal_finish', l: 'Normal day finishes', t: 'time' }]), S))}
    ${sect('s-pay', 'PAYE tax', 'Annual brackets (from, to, rate %). <b>Check against the current FRCS tables.</b> FNPF %, unpaid breaks and pay periods are under <a href="#/payroll">Payroll → Payroll rules</a>.',
      fieldsHTML(dis([{ n: 'paye_brackets', l: 'PAYE annual brackets', t: 'textarea', full: 1, rows: 6 }]), { paye_brackets: JSON.stringify(JSON.parse(S.paye_brackets || '[]'), null, 1) }))}
    <div class="panel"><h3>Access by area</h3><p class="small muted" style="margin-top:-4px">Each person has a level for each area: <b>Hidden</b>, <b>View</b>, <b>Add & edit</b> (no deleting) or <b>Full</b>. Administrators always have Full. ${isAdmin() ? 'Set it under <a href="#/employees">Staff</a> → Access.' : 'Only an administrator can change it.'} The server checks every request.</p>
      <div class="scroll"><table class="t"><thead><tr><th>Preset</th>${Object.values(AREAS).map(a => `<th>${esc(a)}</th>`).join('')}</tr></thead><tbody>
      ${Object.values(PRESETS).map(p => `<tr><td data-l="Preset"><b>${esc(p.label)}</b>${p.team ? '<div class="small muted">own team only</div>' : ''}</td>${Object.keys(AREAS).map(a => `<td data-l="${esc(AREAS[a])}">${esc(LEVELS[p.perms[a] || 0])}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div><p class="small muted">Your access: <b>${esc(accessName({ ...ME, access: ME.perms }))}</b>${ME.team_only ? ' (your team only)' : ''}.</p></div>
    ${sect('s-perms', 'Time clock', 'Who can open the shared office time clock.',
      `<div class="scroll"><table class="t perm-table"><thead><tr><th>Action</th><th>Everyone</th><th>Managers</th><th>Administrators only</th></tr></thead><tbody>
      ${Object.entries(LABELS).map(([a, l]) => `<tr><td data-l="Action">${esc(l)}</td>${['staff', 'manager', 'admin'].map(r => `<td data-l="${roleName(r)}"><input type="radio" name="${a}" value="${r}" ${(perms[a] || 'admin') === r ? 'checked' : ''} ${ro ? 'disabled' : ''} aria-label="${roleName(r)}"></td>`).join('')}</tr>`).join('')}
      </tbody></table></div>`)}
    ${L('setup') >= 2 ? '<div class="panel" id="s-backup"></div><div class="panel" id="s-email"></div>' : ''}
    ${isAdmin() ? '<div class="panel" id="s-archives"></div><div class="panel danger-zone" id="s-again"></div>' : ''}`;
  if (L('setup') >= 2) drawBackups();
  if (isAdmin()) drawStartAgain();
  if (ro) return;
  const save = async body => { try { S = await api('/api/staff/settings', { method: 'PUT', body }); toast('Settings saved'); await refreshMe(); } catch (e) { toast(e.message); } };
  $('#s-perms').onsubmit = e => { e.preventDefault(); save({ booking_permissions: JSON.stringify(Object.fromEntries(Object.keys(LABELS).map(a => [a, (formData(e.target)[a]) || 'admin']))) }); };
  ['#s-co', '#s-week', '#s-pay'].forEach(id => $(id).onsubmit = e => { e.preventDefault(); save(formData(e.target)); });
  drawEmailSettings();
}

async function renderAccount() {
  view().innerHTML = `<form class="panel" style="max-width:480px" id="pw"><h3>Change password</h3><div class="err"></div>
    ${fieldsHTML([{ n: 'current', l: 'Current password', t: 'password', req: 1, full: 1 }, { n: 'password', l: 'New password (min 8)', t: 'password', req: 1, full: 1 }])}
    <button class="btn">Update password</button></form>
    <div class="panel" style="max-width:480px"><h3>My time-clock PIN</h3><p>Use this on the office PC's <b>Time clock</b> to clock in and out: <code style="font-size:1.3rem;letter-spacing:.2em">${esc(ME.clock_pin || '—')}</code></p><p class="small muted">Keep it to yourself. An Admin can change it under Staff.</p></div>
    <div class="panel" style="max-width:480px"><h3>My access</h3><p><b>${esc(accessName({ ...ME, access: ME.perms }))}</b>${ME.team_only ? ' (your team only)' : ''}</p><ul class="small">${Object.entries(AREAS).map(([a, l]) => `<li>${esc(l)}: <b>${esc(LEVELS[L(a)])}</b></li>`).join('')}${[...CAN].map(a => `<li>${esc(LABELS[a] || a)}</li>`).join('')}</ul></div>`;
  $('#pw').onsubmit = async e => { e.preventDefault(); try { await api('/api/auth/password', { body: formData(e.target) }); e.target.reset(); toast('Password updated'); } catch (err) { $('.err', e.target).innerHTML = `<div class="error">${esc(err.message)}</div>`; } };
}

// ------------------------------------------------------------------ boot / auth / live
async function refreshMe() {
  const me = await api('/api/auth/me');
  ME = me.user; S = me.settings; ON_SHIFT = me.on_shift; CAN = new Set(me.can); LABELS = me.permission_labels; AREAS = me.areas || {}; LEVELS = me.levels || []; PRESETS = me.presets || {}; window.__loggedIn = !!ME;
  $('#me').innerHTML = `<b>${esc(ME.name)}</b><br><span style="opacity:.7">${esc(ME.position || '')} · ${esc(accessName({ ...ME, access: ME.perms }))}</span>`;
  $('#clock-btn').textContent = ON_SHIFT ? `Clock out (since ${fmtTime(ON_SHIFT.clock_in.slice(11))})` : 'Clock in';
  renderMenu();
}
async function boot() {
  try { await refreshMe(); } catch {
    let su = {}; try { su = await api('/api/public/setup'); } catch { }
    $(su.setup_needed ? '#setup' : '#login').classList.remove('hidden'); $('#app').classList.add('hidden'); return;
  }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  connectLive(onLive, ok => $('#live').classList.toggle('off', !ok));
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(l => l.forEach(r => r.unregister())).catch(() => {});
  go();
  watchForUpdates();
}
// After an update goes live, reload so staff always have the newest screens: straight away if nothing is
// half-done (no window open, no sale in progress), otherwise show a 'tap to refresh' bar.
async function watchForUpdates() {
  let mine = null;
  try { mine = (await api('/api/version')).v; } catch { return; }
  const check = async () => {
    let v; try { v = (await api('/api/version')).v; } catch { return; }
    if (!v || v === mine) return;
    const busy = document.querySelector('.modal-bg') || document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (!busy) return location.reload();
    if (!document.getElementById('update-bar')) document.body.insertAdjacentHTML('beforeend', '<button id="update-bar" class="update-bar" onclick="location.reload()">⟳ New update: tap to refresh</button>');
  };
  setInterval(check, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
function onLive(msg) {
  if (msg.type === 'shift' && VIEW === 'dashboard') renderDashboard();
  if (msg.type === 'shift' && VIEW === 'timeclock' && !document.querySelector('.pinpad')) renderTimeclock();
  if (msg.type === 'roster' && VIEW === 'roster' && !document.querySelector('.modal-bg')) renderRoster();
}
$('#login-form').onsubmit = async e => {
  e.preventDefault();
  try { await api('/api/auth/login', { body: formData(e.target) }); location.hash = '#/dashboard'; location.reload(); }
  catch (err) { $('#login-err').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
};
// "Forgot password?" (forgot.js on the server): an emailed code, or the business owner's Riyeser account. In-page only.
$('#forgot-link').onclick = async e => {
  e.preventDefault();
  let o = { email: false, owner_linked: false };
  try { o = await api('/api/auth/forgot'); } catch { }
  const m = openModal('<div id="fp"></div>'), box = $('#fp', m.el);
  const err = (form, x) => { $('.err', form).innerHTML = `<div class="error">${esc(x.message)}</div>`; };
  const busy = (form, on) => { for (const b of $$('button', form)) b.disabled = on; };
  const pwFields = `<div class="field"><label>New password (at least 8 characters)</label><input name="password" type="password" autocomplete="new-password" required minlength="8"></div>
    <div class="field"><label>New password again</label><input name="password2" type="password" autocomplete="new-password" required minlength="8"></div>`;
  const done = (msg, username) => {
    box.innerHTML = `<h3>Password changed</h3><div class="success">${esc(msg)}</div><div class="actions" style="margin-top:14px"><button class="btn" id="fp-ok">Back to sign in</button></div>`;
    $('#fp-ok', box).onclick = () => { m.close(); const f = $('#login-form'); f.username.value = username || ''; f.password.value = ''; $('#login-err').innerHTML = ''; f.password.focus(); };
  };
  const start = () => {
    box.innerHTML = `<h3>Forgot your password?</h3>
      ${o.email ? `<p class="small muted">Staff with an email address in Payroll can get a reset code by email.</p><button class="btn" id="fp-email" style="width:100%">Email me a reset code</button>` : '<p class="small muted">Email isn\'t set up in Payroll, so reset codes can\'t be emailed.</p>'}
      <button class="btn ghost" id="fp-owner" style="width:100%;margin-top:10px">I'm the business owner: reset with my Riyeser account</button>
      <p class="small muted" style="margin-top:14px">Not the owner? Ask your Super admin to set a new password for you (Staff → your name → Reset password).</p>`;
    if ($('#fp-email', box)) $('#fp-email', box).onclick = emailStep;
    $('#fp-owner', box).onclick = ownerStep;
  };
  // ---- 1. an emailed code
  const emailStep = () => {
    box.innerHTML = `<h3>Email me a reset code</h3><form id="fp-f"><div class="err"></div>
      <div class="field"><label>Your username or email address</label><input name="who" autocomplete="username" autocapitalize="none" required value="${esc($('#login-form').username.value)}"></div>
      <div class="actions"><button class="btn">Send the code</button><button type="button" class="btn ghost" id="fp-back">Back</button></div></form>`;
    $('#fp-back', box).onclick = start;
    $('#fp-f', box).onsubmit = async ev => {
      ev.preventDefault(); const f = ev.target, who = f.who.value.trim(); busy(f, true);
      try { const r = await api('/api/auth/forgot/email', { body: { who } }); codeStep(who, r.message); } catch (x) { err(f, x); busy(f, false); }
    };
  };
  const codeStep = (who, msg) => {
    box.innerHTML = `<h3>Type the code and a new password</h3><div class="success" style="margin-bottom:12px">${esc(msg)}</div><form id="fp-f"><div class="err"></div>
      <div class="field"><label>6-digit code from the email</label><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></div>${pwFields}
      <div class="actions"><button class="btn">Change my password</button><button type="button" class="btn ghost" id="fp-again">Send a new code</button></div></form>`;
    $('#fp-again', box).onclick = emailStep;
    $('#fp-f', box).onsubmit = async ev => {
      ev.preventDefault(); const f = ev.target; busy(f, true);
      try { const r = await api('/api/auth/forgot/email/reset', { body: { who, ...formData(f) } }); done(r.message, r.username); } catch (x) { err(f, x); busy(f, false); }
    };
  };
  // ---- 2. the business owner's Riyeser account
  const ownerStep = () => {
    if (!o.owner_linked) {
      box.innerHTML = `<h3>Reset with your Riyeser account</h3><div class="error">${esc(o.not_linked || 'Sign in to Riyeser Central on this PC first, then try again.')}</div>
        <p class="small muted">Riyeser Central links this PC to your business. Open Riyeser Central, sign in with your Riyeser account, then come back here and choose "Forgot password?" again.</p>
        <div class="actions"><button class="btn ghost" id="fp-back">Back</button></div>`;
      $('#fp-back', box).onclick = start; return;
    }
    box.innerHTML = `<h3>Reset with your Riyeser account</h3>
      <p class="small muted">Sign in with the Riyeser account you use for Riyeser Central. Payroll checks with Riyeser that you're the owner of <b>${esc(o.business || 'this business')}</b>. Your Riyeser password is only sent to Riyeser, and isn't kept.</p>
      <form id="fp-f"><div class="err"></div>
      <div class="field"><label>Riyeser account email</label><input name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label>Riyeser account password</label><input name="password" type="password" autocomplete="current-password" required></div>
      <div class="actions"><button class="btn">Continue</button><button type="button" class="btn ghost" id="fp-back">Back</button></div></form>`;
    $('#fp-back', box).onclick = start;
    $('#fp-f', box).onsubmit = async ev => {
      ev.preventDefault(); const f = ev.target; busy(f, true);
      try { const r = await api('/api/auth/forgot/owner/start', { body: formData(f) }); if (r.needs_code) mfaStep(r.ticket); else pickStep(r); } catch (x) { err(f, x); busy(f, false); }
    };
  };
  const mfaStep = ticket => {
    box.innerHTML = `<h3>Two-step sign-in</h3><p class="small muted">Type the 6-digit code from your authenticator app.</p><form id="fp-f"><div class="err"></div>
      <div class="field"><label>Code</label><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></div>
      <div class="actions"><button class="btn">Continue</button><button type="button" class="btn ghost" id="fp-back">Start again</button></div></form>`;
    $('#fp-back', box).onclick = ownerStep;
    $('#fp-f', box).onsubmit = async ev => {
      ev.preventDefault(); const f = ev.target; busy(f, true);
      try { pickStep(await api('/api/auth/forgot/owner/code', { body: { ticket, code: f.code.value } })); } catch (x) { err(f, x); busy(f, false); }
    };
  };
  const pickStep = r => {
    box.innerHTML = `<h3>Set a new Super admin password</h3><div class="success" style="margin-bottom:12px">You're confirmed as the owner of ${esc(r.business || 'this business')}.</div>
      <form id="fp-f"><div class="err"></div>
      <div class="field"><label>Which login?</label><select name="user_id" required>${r.admins.map(a => `<option value="${a.id}">${esc(a.name)} (${esc(a.username)})${a.main ? ', the main login' : ''}</option>`).join('')}</select></div>${pwFields}
      <p class="small muted">Anyone signed in with this login on another screen is signed out. The audit trail records the change.</p>
      <div class="actions"><button class="btn">Set the new password</button></div></form>`;
    $('#fp-f', box).onsubmit = async ev => {
      ev.preventDefault(); const f = ev.target; busy(f, true);
      try { const x = await api('/api/auth/forgot/owner/reset', { body: { ticket: r.ticket, ...formData(f) } }); done(x.message, x.username); } catch (x) { err(f, x); busy(f, false); }
    };
  };
  start();
};
// OWNER-RESTORE: a new PC or a reinstall starts with no records: bring them back from a backup instead of starting fresh
if (window.riyser && window.riyser.restore && $('#setup-restore')) { $('#setup-restore').hidden = false; $('#setup-restore button').onclick = () => window.riyser.restore(); }
$('#setup-form').onsubmit = async e => {
  e.preventDefault();
  const v = formData(e.target);
  try { const r = await api('/api/public/setup', { body: v }); await api('/api/auth/login', { body: { username: r.username, password: v.password } }); location.hash = '#/dashboard'; location.reload(); }
  catch (err) { $('#setup-err').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
};
$('#logout').onclick = async () => { await api('/api/auth/logout', { body: {} }); location.reload(); };
$('#clock-btn').onclick = async () => { let r; try { r = await api('/api/staff/clock', { body: {} }).catch(e => { if (e.data && e.data.long_shift && confirm(e.message)) return api('/api/staff/clock', { body: { confirm_long: true } }); throw e; }); } catch (e) { return toast(e.message, 5000); } toast(r.cancelled ? 'Clock-in cancelled (tapped twice). You are not on shift.' : r.on_shift ? 'Clocked in — have a good shift!' : 'Clocked out. Vinaka!'); await refreshMe(); if (VIEW === 'dashboard' || VIEW === 'timesheets') go(); };
boot();

// ------------------------------------------------------------------ bank statements: wage payments that left the bank
let BK = { files: [], texts: [], text: '', year: '', found: null };
async function renderBank() {
  const d = await api(`/api/staff/bank/payments?year=${BK.view_year || ''}`);
  const m2 = v => money(v, cur());
  const byMonth = {}; for (const r of d.rows) ((byMonth[r.date.slice(0, 7)] = byMonth[r.date.slice(0, 7)] || []).push(r));
  view().innerHTML = `
    <div class="panel"><h3>1. Add a bank statement</h3>
      <p class="small muted" style="margin-top:-4px">Finds the wage payments, e.g. <b>Tomasi Pay 230.00</b> or <b>(company name) pay Seru</b>, and matches each to the staff member. Choose the statement's <b>PDF</b> (even a scanned or printed one), or the <b>CSV or Excel download</b> from internet banking, or paste the lines below. PDFs are read on this computer.</p>
      <div class="bk-grid">
        <label class="btn sm file-btn">📂 Choose statement (PDF, CSV, Excel)<input type="file" id="bk-files" accept=".pdf,.csv,.xlsx,.txt,application/pdf,text/csv" multiple hidden></label>
        <label class="ts-box" title="Used only if the statement doesn't show its own dates"><span>Year, if not on the statement</span><input type="number" id="bk-year" min="2015" max="2100" value="${esc(BK.year || today().slice(0, 4))}"></label>
      </div>
      <div id="bk-list" class="small"></div>
      <div class="field"><label>Or paste statement lines</label><textarea id="bk-text" rows="5" placeholder="07 Nov  Tomasi Pay  230.00  33,583.33&#10;07 Nov  Seru Pay  260.00  33,323.33">${esc(BK.text)}</textarea></div>
      <div class="actions"><button class="btn" id="bk-find">Find wage payments</button></div></div>
    <div id="bk-found"></div>
    <div class="panel" style="padding:0"><div class="bar-tools" style="padding:14px 16px 0"><h3 style="margin:0" class="grow">Saved wage payments</h3><select id="bk-vy">${(d.years.length ? d.years : [d.year]).map(y => `<option ${y === d.year ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
      ${Object.keys(byMonth).length ? Object.entries(byMonth).sort().reverse().map(([mo, rows]) => `<details class="ph-person bk-month"><summary><b>${monthName(mo)}</b><span class="small muted">${rows.length} payments · ${m2(rows.reduce((a, r) => a + r.amount, 0))}</span></summary>
        ${table([{ h: 'Date', f: r => fmtDate(r.date) }, { h: 'Staff', f: r => `<b>${esc(r.name)}</b>` }, { h: 'On the statement', k: 'description' }, { h: 'Amount', f: r => m2(r.amount), r: 1 },
          ...(L('payroll') >= 3 ? [{ h: '', f: r => `<button class="btn sm ghost" data-bdel="${r.id}" aria-label="Remove">✕</button>` }] : [])], rows)}</details>`).join('')
        : '<div class="empty" style="margin:16px">No bank payments saved for this year yet.</div>'}</div>`;
  $('#bk-vy').onchange = () => { BK.view_year = $('#bk-vy').value; renderBank(); };
  $$('[data-bdel]').forEach(b => b.onclick = async () => { if (!confirm('Remove this payment?')) return; await api(`/api/staff/bank/payments/${b.dataset.bdel}`, { method: 'DELETE' }); renderBank(); });
  const drawList = (busy = '') => { $('#bk-list').innerHTML = [...BK.texts.map(t => `📄 ${esc(t.source)} <span class="muted">· read${t.ocr ? ' (picture PDF, read with text recognition)' : ''}</span>`), ...BK.files.map(f => `📄 ${esc(f.name)}`), busy ? `<b>${esc(busy)}</b>` : ''].filter(Boolean).join('<br>'); };
  drawList();
  $('#bk-files').onchange = async e => {
    const list = [...e.target.files]; e.target.value = '';
    const fb = $('#bk-find'); fb.disabled = true;
    try {
      for (const file of list) {
        if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
          const r = await readPdfStatement(file, msg => drawList(`${file.name}: ${msg}`));
          BK.texts.push({ source: file.name, text: r.text, ocr: r.ocr });
        } else BK.files.push({ name: file.name, data: await fileB64(file) });
        drawList();
      }
    } catch (err) { drawList(); toast(`Couldn't read that file: ${err.message}`, 8000); }
    fb.disabled = false;
  };
  $('#bk-find').onclick = async () => {
    BK.text = $('#bk-text').value; BK.year = $('#bk-year').value;
    const b = $('#bk-find'); b.disabled = true; b.textContent = 'Looking…';
    try { BK.found = await api('/api/staff/bank/preview', { body: { files: BK.files, texts: BK.texts.map(t => ({ source: t.source, text: t.text })), text: BK.text, year: BK.year } }); drawFound(); }
    catch (e) { toast(e.message, 8000); } finally { b.disabled = false; b.textContent = 'Find wage payments'; }
  };
  const drawFound = () => {
    const F = BK.found, L = F.lines;
    const opts = id => `<option value="">Not wages</option>${F.staff.map(u => `<option value="${u.id}" ${u.id === id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}`;
    $('#bk-found').innerHTML = `<div class="panel"><h3>2. Check the wage payments</h3>
      ${F.check ? (F.check.ok === F.check.checked ? `<div class="note in-effect">✓ All ${F.check.checked} lines agree with the statement's running balance, so the amounts were read correctly.</div>`
        : `<div class="note" style="border-color:var(--red)">⚠ ${F.check.checked - F.check.ok} of ${F.check.checked} lines don't agree with the running balance. Check these against the statement: ${F.check.wrong.slice(0, 6).map(esc).join(' · ')}</div>`) : ''}
      <p class="small muted" style="margin-top:-4px">${F.scanned} lines read, ${L.length} look like wages. Choose who each one is for, or "Not wages". A different spelling you choose for someone (e.g. a misspelt first name) is remembered for next time.</p>
      ${L.length ? `<div class="bk-lines">${L.map((l, i) => `<div class="bk-line ${l.already ? 'done' : ''}">
        <div class="bk-what"><b>${esc(l.description)}</b><span class="small muted">${fmtDate(l.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}${l.already ? ' · already saved' : ''}${l.near ? ' · <span style="color:var(--gold)">near spelling</span>' : ''}</span></div>
        <div class="bk-amt"><b>${money(l.amount, cur())}</b></div>
        <label class="bk-who"><span class="small">Staff</span><select data-bi="${i}">${opts(l.user_id)}</select></label></div>`).join('')}</div>
        <p class="small"><b id="bk-total"></b></p>
        <div class="actions"><button class="btn coral" id="bk-save">Save wage payments</button></div>` : '<div class="empty">No wage payments found. Lines need a staff name or the word "pay".</div>'}</div>`;
    const total = () => { const sel = $$('[data-bi]').filter(s => s.value); $('#bk-total').textContent = `${sel.length} payment${sel.length === 1 ? '' : 's'} to save · ${money(sel.reduce((a, s) => a + L[s.dataset.bi].amount, 0), cur())}`; };
    $$('[data-bi]').forEach(s => s.onchange = total); if (L.length) total();
    if ($('#bk-save')) $('#bk-save').onclick = async () => {
      const lines = $$('[data-bi]').map(s => { const l = L[s.dataset.bi]; return { ...l, user_id: s.value ? +s.value : null, remember: !!s.value && (+s.value !== l.user_id || l.near) }; }).filter(l => l.user_id);
      if (!lines.length) return toast('Choose the staff member for at least one payment');
      try { const r = await api('/api/staff/bank/save', { body: { lines } }); toast(`✓ Saved ${r.saved} wage payment${r.saved === 1 ? '' : 's'}${r.learned ? ` · learned ${r.learned} new spelling${r.learned === 1 ? '' : 's'}` : ''}`, 6000); BK = { files: [], texts: [], text: '', year: BK.year, found: null }; renderBank(); }
      catch (e) { toast(e.message, 7000); }
    };
  };
  if (BK.found) drawFound();
}

// ------------------------------------------------------------------ backups (desktop program)
async function drawBackups() {
  const host = $('#s-backup'); if (!host) return;
  const B = await api('/api/staff/backups');
  if (!B.desktop) { host.remove(); return; }
  const canRestore = !!(window.riyser && window.riyser.restore);
  host.innerHTML = `<h3>💾 Backups</h3>
    <p class="small muted" style="margin-top:-4px">Your records are kept on this computer. A backup copy is made automatically once a day (the last ${B.keep} are kept). Copy the backups folder to a USB stick or cloud drive now and then, in case this computer is lost or breaks.</p>
    <p class="small">Backups folder: <code style="overflow-wrap:anywhere">${esc(B.folder)}</code><br>Last backup: <b>${B.last ? new Date(B.last).toLocaleString('en-FJ', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not yet'}</b></p>
    <div class="actions"><button class="btn sm" id="bk-now">Back up now</button>${canRestore ? '<button class="btn sm ghost" id="bk-restore">Restore from a backup…</button>' : ''}</div>
    ${B.backups.length ? `<details><summary class="small">${B.backups.length} backup${B.backups.length === 1 ? '' : 's'}</summary>${table([{ h: 'File', k: 'file' }, { h: 'Made', f: b => new Date(b.at).toLocaleString('en-FJ', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) }, { h: 'Size', f: b => (b.size / 1024).toFixed(0) + ' KB', r: 1 },
      ...(canRestore ? [{ h: '', f: b => `<button class="btn sm ghost" data-restore="${esc(b.file)}">Restore</button>` }] : [])], B.backups)}</details>` : ''}
    <p class="small muted">To bring back a backup: <b>Restore from a backup…</b> here, or the menu <b>Payroll → Restore from a backup…</b>. A copy of the records as they are now is saved first, then Payroll restarts.</p>`;
  if ($('#bk-restore', host)) $('#bk-restore', host).onclick = () => window.riyser.restore();
  $$('[data-restore]', host).forEach(b => b.onclick = () => window.riyser.restore(b.dataset.restore));
  $('#bk-now', host).onclick = async () => { try { const r = await api('/api/staff/backups', { body: {} }); toast(`✓ Backed up: ${r.file}`); drawBackups(); } catch (e) { toast(e.message); } };
}

// ------------------------------------------------------------------ start again (Super admin): archive a locked copy, then a blank start
const fmtWhen = iso => iso ? new Date(iso).toLocaleString('en-FJ', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
async function drawStartAgain() {
  const host = $('#s-again'), list = $('#s-archives'); if (!host || !list) return;
  const A = await api('/api/staff/archives');
  list.innerHTML = `<h3>🗄️ Archived copies</h3>
    <p class="small muted" style="margin-top:-4px">Each time Payroll is started again, the old records are saved here as a locked copy. They are never deleted. Each copy has a fingerprint, so you can check no-one has changed it.</p>
    ${table([{ h: 'Saved', f: e => esc(fmtWhen(e.at)) }, { h: 'File', f: e => `<code style="overflow-wrap:anywhere">${esc(e.file)}</code>` }, { h: 'By', f: e => esc(e.by) }, { h: 'Reason', f: e => esc(e.reason) }, { h: 'Check', f: e => `<span class="arc-st" data-n="${e.n}"></span>` }], A.entries, { empty: 'No archived copies yet.' })}
    ${A.entries.length ? '<div class="actions"><button class="btn sm ghost" id="arc-check">Check they haven\'t been changed</button></div><div id="arc-sum"></div>' : ''}
    <p class="small muted">Folder: <code style="overflow-wrap:anywhere">${esc(A.folder)}</code></p>`;
  const chk = $('#arc-check', list);
  if (chk) chk.onclick = async () => {
    chk.disabled = true;
    try {
      const C = await api('/api/staff/archives/check');
      for (const e of C.entries) { const el = $(`.arc-st[data-n="${e.n}"]`, list); if (el) { el.className = `arc-st ${e.ok ? 'ok' : 'bad'}`; el.textContent = (e.ok ? '✓ ' : '⚠ ') + e.status; } }
      $('#arc-sum', list).innerHTML = C.all_ok ? '<div class="note arc-ok">✓ All archived copies are unchanged and the log is intact.</div>'
        : `<div class="error">⚠ Something has changed. ${C.chain_intact ? '' : 'The log of archived copies has been altered. '}Don't start again or delete anything. Keep this computer and its files as they are, and get advice.</div>`;
    } catch (err) { toast(err.message); } finally { chk.disabled = false; }
  };
  host.innerHTML = `<h3>⚠️ Start again</h3>
    <p>This clears Payroll back to a blank start: all staff, timesheets, pay runs, payslips, leave, pay history, bank payments and settings. Only your own login stays, with the same username and password.</p>
    <p><b>Your current records are saved as a locked archive copy first. Nothing is deleted.</b> The copy is listed under Archived copies above.</p>
    <form id="again-f"><div class="err"></div>
    ${fieldsHTML([{ n: 'password', l: 'Your password', t: 'password', req: 1 }, { n: 'confirm', l: `Type ${A.confirm_word} to confirm`, req: 1, ph: A.confirm_word }, { n: 'reason', l: 'Reason (optional)', full: 1, ph: 'e.g. finished testing, starting for real' }])}
    <div class="actions"><button class="btn danger">Start again</button></div></form>`;
  const f = $('#again-f', host);
  f.querySelector('[name=confirm]').setAttribute('autocomplete', 'off');
  f.onsubmit = async e => {
    e.preventDefault();
    const b = formData(f); $('.err', f).innerHTML = '';
    if (!confirm('Start again? Your current records will be saved as a locked archive copy, then Payroll will be blank.')) return;
    const btn = $('.btn.danger', f); btn.disabled = true;
    try {
      const r = await api('/api/staff/start-again', { body: b });
      toast(`✓ Started again. Old records saved as ${r.file}`, 6000);
      await refreshMe(); renderSettings();
    } catch (err) { $('.err', f).innerHTML = `<div class="error">${esc(err.message)}</div>`; btn.disabled = false; }
  };
}

// ------------------------------------------------------------------ desktop program: save payslips / timesheets as a PDF
async function savePdf(title, html) {
  try {
    const { file } = await window.riyser.pdf(html, title);
    $$('.modal-bg .x').forEach(x => x.click()); // close the reports window first
    const name = file.split(/[\\/]/).pop();
    const m = openModal(`<h2 style="font-size:1.35rem">PDF saved</h2><p><b>${esc(name)}</b><br><span class="small muted">in Documents › Riyeser › Payroll › Payslips</span></p>
      <div class="actions"><button class="btn" id="pdf-open">Open</button><button class="btn ghost" id="pdf-show">Show in folder</button></div>`);
    m.el.style.maxWidth = '480px';
    $('#pdf-open', m.el).onclick = () => { window.riyser.openFile(file); m.close(); };
    $('#pdf-show', m.el).onclick = () => { window.riyser.show(file); m.close(); };
  } catch (e) { toast(e.message, 6000); }
}

// ------------------------------------------------------------------ read a PDF bank statement on this computer
// Text PDFs: the text is read straight from the file. Picture PDFs (scanned, or "Print to PDF"): each page is drawn
// and read with text recognition (OCR). Nothing leaves the computer except the lines of text, sent to Payroll.
async function readPdfStatement(file, progress = () => {}) {
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = Math.min(doc.numPages, 30);
  // 1) text in the file: put the words of each line back together (same height on the page), left to right
  let text = '';
  for (let i = 1; i <= pages; i++) {
    progress(`Reading page ${i} of ${pages}…`);
    const items = (await (await doc.getPage(i)).getTextContent()).items.filter(t => t.str && t.str.trim());
    const rows = [];
    for (const t of items) {
      const y = t.transform[5], x = t.transform[4];
      let r = rows.find(r => Math.abs(r.y - y) < 3); if (!r) rows.push(r = { y, parts: [] });
      r.parts.push({ x, s: t.str });
    }
    rows.sort((a, b) => b.y - a.y);
    text += rows.map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.s.trim()).join('  ')).join('\n') + '\n';
  }
  if (text.replace(/\s/g, '').length > 200) return { text, ocr: false, pages };
  // 2) a picture of the statement: OCR each page (stops after the page with the ending balance)
  if (!window.Tesseract) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/vendor/tesseract/tesseract.min.js'; s.onload = ok; s.onerror = () => no(new Error("Couldn't load the text reader.")); document.head.appendChild(s); });
  const worker = await Tesseract.createWorker('eng', 1, { workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract-core', langPath: '/vendor/tessdata', gzip: true });
  await worker.setParameters({ preserve_interword_spaces: '1' });
  text = '';
  try {
    for (let i = 1; i <= pages; i++) {
      progress(`Reading page ${i} of ${pages} (this one is a picture, so it takes a few seconds)…`);
      const page = await doc.getPage(i), vp = page.getViewport({ scale: 2.8 });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      text += (await worker.recognize(c)).data.text + '\n';
      if (/^\s*\d{1,2}[\s\/.-]+[A-Za-z0-9]{2,4}\b.*\b(ENDING|CLOSING) BALANCE\b/im.test(text)) break; // the last line of the transactions (not the summary at the top)
    }
  } finally { await worker.terminate(); }
  return { text, ocr: true, pages };
}

// ------------------------------------------------------------------ export payslips (desktop program)
// A pay run, or any dates (finalised payslips where there's a pay run, drafts from timesheets otherwise), for everyone or
// one person; one PDF per payslip, or all in one PDF; saved in a folder the person chooses.
async function drawExport(runs) {
  const host = $('#pr-export'); if (!host) return;
  if (!window.riyser) { host.remove(); return; }
  let folder = await window.riyser.payslipsFolder();
  const emps = (await api('/api/staff/employees')).filter(e => e.active);
  const pp = await api('/api/staff/payroll/period').catch(() => null);
  const [d1, d2] = pp ? pp.previous : [addDays(today(), -6), today()];
  host.innerHTML = `<h3>Export payslips</h3>
    <p class="small muted" style="margin-top:-4px">Save payslips as PDF files: one for each payslip, or all in one. Dates without a finalised pay run give DRAFT payslips worked out from the timesheets.</p>
    <form id="ex-form" class="ex-grid">
      <label class="ts-box"><span>From</span><select name="src"><option value="run">A pay run</option><option value="dates">Dates</option></select></label>
      <label class="ts-box" data-ex="run"><span>Pay run</span><select name="run">${runs.length ? runs.map(r => `<option value="${r.id}">Paid ${esc(r.pay_date)} · ${esc(r.period_start)} to ${esc(r.period_end)}</option>`).join('') : '<option value="">No pay runs yet</option>'}</select></label>
      <label class="ts-box hidden" data-ex="dates"><span>First day</span><input type="date" name="from" value="${d1}"></label>
      <label class="ts-box hidden" data-ex="dates"><span>Last day</span><input type="date" name="to" value="${d2}"></label>
      <label class="ts-box"><span>Who</span><select name="who"><option value="">Everyone</option>${emps.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></label>
      <label class="ts-box"><span>Files</span><select name="mode"><option value="each">One PDF for each payslip</option><option value="one">All in one PDF</option></select></label>
      <div class="ex-folder"><span class="small muted">Save in</span><b id="ex-path">${esc(folder)}</b><button type="button" class="btn sm ghost" id="ex-pick">Choose folder…</button></div>
      <div class="ex-go"><button class="btn coral" id="ex-go">Export payslips</button><span class="small muted" id="ex-status"></span></div>
    </form>`;
  const F = $('#ex-form', host);
  const sync = () => $$('[data-ex]', host).forEach(x => x.classList.toggle('hidden', x.dataset.ex !== F.src.value));
  F.src.onchange = sync; if (!runs.length) F.src.value = 'dates'; sync();
  $('#ex-pick', host).onclick = async () => { const f = await window.riyser.pickFolder(); if (f) { folder = f; $('#ex-path', host).textContent = f; } };
  F.onsubmit = async e => {
    e.preventDefault();
    const st = $('#ex-status', host), go = $('#ex-go', host); go.disabled = true;
    try {
      let list = [], label = '';
      if (F.src.value === 'run') {
        if (!F.run.value) throw new Error('There are no pay runs yet. Choose "Dates" instead.');
        const { run, payslips } = await api(`/api/staff/payroll/runs/${F.run.value}`);
        list = payslips.map(p => ({ ...p, period_start: run.period_start, period_end: run.period_end, pay_date: run.pay_date, status: 'final' }));
        label = `paid ${run.pay_date} (${run.period_start} to ${run.period_end})`;
      } else {
        if (!F.from.value || !F.to.value) throw new Error('Choose the dates.');
        list = (await api(`/api/staff/payslips/build?${new URLSearchParams({ from: F.from.value, to: F.to.value, ...(F.who.value ? { user_id: F.who.value } : {}) })}`)).payslips;
        label = `${F.from.value} to ${F.to.value}`;
      }
      if (F.who.value) list = list.filter(p => String(p.user_id) === F.who.value);
      if (!list.length) throw new Error('No payslips for that choice (no paid hours, or no pay rate set under Staff).');
      const one = p => (p.status === 'draft' ? `<p style="color:#b3261e;font-weight:700;margin:0 auto 4px;max-width:640px">DRAFT — not from a finalised pay run${p.part ? ' · part of a pay period (in proportion)' : ''}</p>` : '') + payslipHTML(p, p);
      let saved = 0;
      if (F.mode.value === 'one') {
        st.textContent = `Saving ${list.length} payslips…`;
        const who = F.who.value ? ' ' + list[0].employee_name : '';
        await window.riyser.pdf(list.map(one).join(''), `Payslips${who} ${label}`, folder); saved = 1;
      } else {
        for (const p of list) {
          st.textContent = `Saving ${saved + 1} of ${list.length}…`;
          await window.riyser.pdf(one(p), `Payslip ${p.employee_name} ${p.period_start} to ${p.period_end}${p.status === 'draft' ? ' DRAFT' : ''}`, folder); saved++;
        }
      }
      st.textContent = '';
      const m = openModal(`<h2 style="font-size:1.35rem">Payslips exported</h2><p>${F.mode.value === 'one' ? `${list.length} payslips in one PDF` : `${saved} PDF${saved === 1 ? '' : 's'}, one for each payslip`}, saved in<br><b style="overflow-wrap:anywhere">${esc(folder)}</b></p>
        <div class="actions"><button class="btn" id="ex-open">Open the folder</button></div>`);
      m.el.style.maxWidth = '480px';
      $('#ex-open', m.el).onclick = () => { window.riyser.openFolder(folder); m.close(); };
    } catch (err) { st.textContent = ''; toast(err.message, 7000); }
    go.disabled = false;
  };
}
