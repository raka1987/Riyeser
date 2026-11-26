// OWNER-ROSTER (Payroll 2.3.0): the Roster page.
//  - Planning (Add & edit access to Timesheets): a week grid of people × days. Click + in a day (or "Add shift") to add a
//    shift, click a shift to change it, drag it to another day or person (hold Ctrl to copy), "Repeat" it on other days,
//    "Copy last week", open shifts (nobody yet). Warnings for overlaps, leave already booked and long hours. Totals per
//    person (hours, estimated wages with pay rate access) and for the week. On a phone: one day at a time.
//  - "Publish roster": staff see the published copy (this page, the time clock after tapping their name, printed, or as
//    plain text for WhatsApp / SMS). Changes after publishing show as "changed" / "new" / "removed" until published again.
//  - Everyone else: the published roster, with their own shifts at the top.
// Uses the page's helpers (common.js, staff.js: S, L, ME, view, today, money, cur, QE). The server checks every change.
let RO = { week: '', mode: 'plan', day: '', flash: '' }, RO_LAST = null;
const roMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const roSpan = (a, b) => { let m = roMin(b) - roMin(a); if (m <= 0) m += 1440; return m; };
const roShort = t => fmtTime(t).replace(':00', '');                       // 9am, 5:30pm
const roTimes = s => `${roShort(s.start)}–${roShort(s.finish)}`;
const roDay = d => QE.dayLong(d);                                         // Mon 23 Nov
const roRuleBreak = span => { let br = []; try { br = JSON.parse(S.payroll_breaks || '[]'); } catch { } const r = br.filter(x => span / 60 > +x.after_hours).sort((a, b) => b.minutes - a.minutes)[0]; return r ? Math.min(span, +r.minutes) : 0; };
const roLeave = { annual: 'Annual leave', sick: 'Sick leave', other: 'Paid leave', unpaid: 'Unpaid leave' };
const roWhen = iso => iso ? new Date(iso).toLocaleString('en-FJ', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';

async function renderRoster(state = {}) {
  Object.assign(RO, state);
  if (L('timesheets') < 1 || RO.mode === 'staff') return renderRosterStaff();
  const W = await api(`/api/staff/roster?week=${RO.week || today()}`);
  RO.week = W.week_start;
  if (!W.days.includes(RO.day)) RO.day = W.days.includes(W.today) ? W.today : W.days[0];
  const ed = W.can_edit, flash = RO.flash; RO.flash = '';
  const live = list => list.filter(s => !s.deleted);
  const dayHours = d => [...W.people.flatMap(p => live(p.shifts)), ...live(W.open)].filter(s => s.date === d).reduce((t, s) => t + s.hours, 0);
  const dayPeople = d => W.people.filter(p => live(p.shifts).some(s => s.date === d)).length;
  const pend = W.pending.new + W.pending.changed + W.pending.removed;
  const tip = s => [`${fmtTime(s.start)}–${fmtTime(s.finish)}`, `${s.hours.toFixed(2)} h paid${s.break_min ? ` (${s.break_min} min break)` : ''}`, s.role, s.note,
    s.state === 'new' ? 'New: not published yet' : s.state === 'changed' ? 'Changed since it was published: publish again to tell staff' : s.state === 'removed' ? 'Removed: staff still see it until you publish again' : '', ...(s.warnings || []).map(w => '⚠ ' + w)].filter(Boolean).join('\n');
  const chip = s => `<div class="ro-shift${s.state ? ' st-' + s.state : ''}${(s.warnings || []).length && !s.deleted ? ' warn' : ''}${s.user_id ? '' : ' open'}" data-sid="${s.id}" ${ed && !s.deleted ? 'draggable="true"' : ''} tabindex="0" role="button" title="${esc(tip(s))}" aria-label="${esc(tip(s).replace(/\n/g, ', '))}">
      <b>${roShort(s.start)}–<wbr>${roShort(s.finish)}</b>${s.role ? `<span class="ro-role">${esc(s.role)}</span>` : ''}${s.note ? `<span class="ro-note-c">${esc(s.note)}</span>` : ''}${s.state ? `<span class="ro-st">${s.state}</span>` : ''}${(s.warnings || []).length && !s.deleted ? '<span class="ro-w" aria-hidden="true">⚠</span>' : ''}</div>`;
  const cell = (uid, d, shifts, leave) => `<td class="ro-cell${d === W.today ? ' today' : ''}${leave ? ' lv' : ''}" data-u="${uid || ''}" data-d="${d}">
      ${leave ? `<div class="ro-leave">🌴 ${esc(roLeave[leave] || 'Leave')}</div>` : ''}${shifts.filter(s => s.date === d).map(chip).join('')}
      ${ed ? `<button type="button" class="ro-add" data-add="${uid || ''}|${d}" aria-label="Add a shift on ${esc(roDay(d))}" title="Add a shift">+</button>` : ''}</td>`;
  const who = p => `<div class="ro-who"><b>${esc(p.name)}</b>${p.position ? `<span class="small muted">${esc(p.position)}</span>` : ''}
      <span class="ro-tot"><b>${p.hours.toFixed(2)}</b> h${W.sees_pay ? (p.pay_type === 'hourly' ? ` · ${money(p.wages, cur())}` : p.hours ? ' · salary' : '') : ''}${p.warnings.length ? ` <span class="ro-w" title="${esc(p.warnings.join('\n'))}">⚠</span>` : ''}</span></div>`;
  const openRow = W.open.length || ed;
  const allWarn = [...W.people.flatMap(p => [...p.warnings.map(w => ({ n: p.name, w })), ...live(p.shifts).flatMap(s => s.warnings.map(w => ({ n: p.name, d: s.date, t: roTimes(s), w })))]),
    ...live(W.open).flatMap(s => s.warnings.map(w => ({ n: 'Open shift', d: s.date, t: roTimes(s), w })))];
  // phone: one day at a time
  const phoneDay = d => {
    const openToday = W.open.filter(s => s.date === d);
    return `${openToday.length || ed ? `<div class="ro-pcard open"><div class="ro-pc-h"><b>Open shifts</b><span class="small muted">nobody yet</span></div>
        <div class="ro-pc-s">${openToday.map(chip).join('') || '<span class="small muted">None</span>'}</div>${ed ? `<button type="button" class="btn sm ghost ro-padd" data-add="|${d}">+ Open shift</button>` : ''}</div>` : ''}
      ${W.people.map(p => { const sh = p.shifts.filter(s => s.date === d), lv = p.leave[d];
        return `<div class="ro-pcard"><div class="ro-pc-h"><b>${esc(p.name)}</b><span class="small muted">week ${p.hours.toFixed(2)} h${W.sees_pay && p.pay_type === 'hourly' ? ` · ${money(p.wages, cur())}` : ''}${p.warnings.length ? ' ⚠' : ''}</span></div>
          <div class="ro-pc-s">${lv ? `<div class="ro-leave">🌴 ${esc(roLeave[lv] || 'Leave')}</div>` : ''}${sh.map(chip).join('') || (lv ? '' : '<span class="small muted">Off</span>')}</div>
          ${ed ? `<button type="button" class="btn sm ghost ro-padd" data-add="${p.id}|${d}">+ Add</button>` : ''}</div>`; }).join('')}`;
  };

  view().innerHTML = `<div class="ro-page">
    ${flash ? `<div class="note ro-flash">${flash}</div>` : ''}
    <div class="ro-top">
      <div class="ts-period ro-weeknav"><button type="button" class="btn sm ghost" id="ro-prev" aria-label="Previous week" title="Previous week">‹</button>
        <div class="ts-period-mid"><span class="ts-period-k">Roster for the week</span><b>${esc(W.label)}</b>${W.days.includes(W.today) ? '<span class="chip">this week</span>' : `<button type="button" class="chip gray ro-thisweek" id="ro-today">Go to this week</button>`}</div>
        <button type="button" class="btn sm ghost" id="ro-next" aria-label="Next week" title="Next week">›</button></div>
      <div class="ro-pub ${!W.published ? 'draft' : pend ? 'pending' : 'ok'}" role="status">
        ${!W.published ? '<b>Not published yet.</b> Staff can\'t see this week until you publish it.'
          : pend ? `<b>${pend} change${pend === 1 ? '' : 's'} not published yet</b> (${[W.pending.new && `${W.pending.new} new`, W.pending.changed && `${W.pending.changed} changed`, W.pending.removed && `${W.pending.removed} removed`].filter(Boolean).join(', ')}). Staff still see the roster as it was published ${esc(roWhen(W.published.at))}.`
          : `<b>✓ Published</b> ${esc(roWhen(W.published.at))}${W.published.by ? ` by ${esc(W.published.by)}` : ''}. Staff see it on the time clock and on this page.`}</div>
    </div>
    <div class="bar-tools ro-tools">
      ${ed ? `<button type="button" class="btn coral" id="ro-publish">${W.published ? (pend ? '📣 Publish again' : '📣 Publish roster') : '📣 Publish roster'}</button>
        <button type="button" class="btn sm ghost" id="ro-new">+ Add shift</button><button type="button" class="btn sm ghost" id="ro-copy">⧉ Copy last week</button>` : ''}
      <button type="button" class="btn sm ghost" id="ro-print">🖨 Print or PDF</button><button type="button" class="btn sm ghost" id="ro-text">💬 WhatsApp / SMS text</button>
      <button type="button" class="btn sm ghost" id="ro-staff">👀 What staff see</button></div>
    <div class="tiles ro-tiles">
      <div class="tile"><div class="k">Hours this week</div><div class="v">${W.totals.hours.toFixed(2)}</div><div class="s">${W.totals.shifts} shift${W.totals.shifts === 1 ? '' : 's'} · ${W.totals.people} ${W.totals.people === 1 ? 'person' : 'people'}</div></div>
      ${W.sees_pay ? `<div class="tile"><div class="k">Estimated wages</div><div class="v">${money(W.totals.wages, cur())}</div><div class="s">hourly staff, before tax${W.totals.salaried ? ` · ${W.totals.salaried} on salary` : ''}</div></div>` : ''}
      <div class="tile"><div class="k">Open shifts</div><div class="v">${W.totals.open}</div><div class="s">${W.totals.open ? `${W.totals.open_hours.toFixed(2)} h, nobody yet` : 'all shifts have someone'}</div></div>
      <div class="tile"><div class="k">Warnings</div><div class="v${W.totals.warnings ? ' ro-wv' : ''}">${W.totals.warnings}</div><div class="s">${W.totals.warnings ? 'see the list below' : 'nothing to check'}</div></div></div>
    <div class="panel ro-gridpanel">
      <div class="scroll ro-gridwrap"><table class="ro-grid"><thead><tr><th class="ro-p">Staff</th>${W.days.map(d => `<th class="${d === W.today ? 'today' : ''}">${QE.dayShort(d).split(' ')[0]} <span>${+d.slice(8)}</span></th>`).join('')}</tr></thead><tbody>
        ${openRow ? `<tr class="ro-openrow"><th class="ro-p"><div class="ro-who"><b>Open shifts</b><span class="small muted">nobody yet</span></div></th>${W.days.map(d => cell(null, d, W.open, null)).join('')}</tr>` : ''}
        ${W.people.map(p => `<tr><th class="ro-p">${who(p)}</th>${W.days.map(d => cell(p.id, d, p.shifts, p.leave[d])).join('')}</tr>`).join('') || `<tr><td colspan="8" class="empty">Nobody on the time clock yet. Add staff under Staff.</td></tr>`}
      </tbody><tfoot><tr><th class="ro-p">Day total</th>${W.days.map(d => `<td><b>${dayHours(d).toFixed(2)}</b> h<span class="small muted"> · ${dayPeople(d)} ${dayPeople(d) === 1 ? 'person' : 'people'}</span></td>`).join('')}</tr></tfoot></table></div>
      ${ed ? '<p class="small muted ro-hint">Click <b>+</b> to add a shift, click a shift to change it, or drag it to another day or person (hold <b>Ctrl</b> to copy instead of move).</p>' : ''}
    </div>
    <div class="ro-phone">
      <div class="ro-daytabs" role="tablist">${W.days.map(d => `<button type="button" role="tab" aria-selected="${d === RO.day}" class="ro-dt${d === RO.day ? ' on' : ''}${d === W.today ? ' today' : ''}" data-day="${d}"><span>${QE.dayShort(d).split(' ')[0]}</span><b>${+d.slice(8)}</b><small>${dayHours(d) ? dayHours(d).toFixed(1) + 'h' : '–'}</small></button>`).join('')}</div>
      <h3 class="ro-dayh">${esc(roDay(RO.day))} <span class="small muted">${dayHours(RO.day).toFixed(2)} h · ${dayPeople(RO.day)} working</span></h3>
      <div class="ro-daylist">${phoneDay(RO.day)}</div>
    </div>
    ${W.hidden ? `<p class="small muted">${W.hidden} shift${W.hidden === 1 ? '' : 's'} for other teams this week aren't shown (you see your own team).</p>` : ''}
    ${allWarn.length ? `<div class="panel ro-warns"><h3>⚠ Things to check</h3><ul>${allWarn.map(x => `<li><b>${esc(x.n)}</b>${x.d ? `, ${esc(roDay(x.d))} ${esc(x.t)}` : ''}: ${esc(x.w)}</li>`).join('')}</ul>
      <p class="small muted" style="margin:6px 0 0">These are warnings only: the roster saves anyway. Leave is booked in Timesheets → Accruals.</p></div>` : ''}
    <details class="panel ro-help"><summary><b>How the roster works</b></summary>
      <ol class="small">
        <li><b>Plan the week.</b> Click <b>+</b> on a day to add a shift: who, start and finish, the unpaid break, the role or area (e.g. Cafe, Till) and a note. <b>Copy last week</b> brings in last week's shifts. Click a shift to change it, or <b>Repeat</b> it on other days.</li>
        <li><b>Open shifts</b> have nobody yet. Give one to someone by clicking it and choosing who, or drag it onto their row.</li>
        <li><b>Warnings</b> show when one person has two shifts at the same time, a shift on a day they have leave booked, a shift over ${W.long_shift_hours} hours, or more than the normal ${W.normal_week_hours}-hour week.</li>
        <li><b>Hours and wages</b> are estimates: start to finish less the break, times the person's hourly rate. Payroll still pays from Timesheets.</li>
        <li><b>Publish roster</b> when it's ready. Staff then see their shifts on the <b>Time clock</b> (after tapping their name) and here under <b>Roster</b>. Print it, or copy it for WhatsApp or a text message.</li>
        <li><b>Changes after publishing</b> are marked <span class="ro-st inl">changed</span>, <span class="ro-st inl">new</span> or <span class="ro-st inl">removed</span> until you publish again. Staff then see those shifts marked "changed".</li>
        <li><b>Into pay:</b> Timesheets show if someone clocked in early or late against the published roster. When you <b>Start next pay run</b>, you can fill hours from the roster for people who don't clock in.</li>
      </ol></details>
    <datalist id="ro-roles">${W.roles.map(r => `<option value="${esc(r)}">`).join('')}</datalist></div>`;

  const all = () => [...W.people.flatMap(p => p.shifts), ...W.open];
  const go2 = st => renderRoster(st);
  $('#ro-prev').onclick = () => go2({ week: addDays(W.week_start, -7), day: addDays(RO.day, -7) });
  $('#ro-next').onclick = () => go2({ week: addDays(W.week_start, 7), day: addDays(RO.day, 7) });
  if ($('#ro-today')) $('#ro-today').onclick = () => go2({ week: today(), day: today() });
  $('#ro-staff').onclick = () => go2({ mode: 'staff' });
  $('#ro-print').onclick = () => rosterShare(W.week_start, 'print');
  $('#ro-text').onclick = () => rosterShare(W.week_start, 'text');
  $$('[data-day]').forEach(b => b.onclick = () => go2({ day: b.dataset.day }));
  const openShift = id => { const s = all().find(x => String(x.id) === String(id)); if (s) rosterEditor(W, { shift: s }); };
  const page = $('.ro-page', view());
  page.addEventListener('click', e => {
    const a = e.target.closest('[data-add]'); if (a) { const [u, d] = a.dataset.add.split('|'); return rosterEditor(W, { user_id: u ? +u : null, date: d }); }
    const c = e.target.closest('.ro-shift'); if (c) openShift(c.dataset.sid);
  });
  page.addEventListener('keydown', e => { const c = e.target.closest('.ro-shift'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openShift(c.dataset.sid); } });
  if (!ed) return;
  $('#ro-new').onclick = () => rosterEditor(W, { user_id: W.people[0] ? W.people[0].id : null, date: RO.day });
  $('#ro-publish').onclick = () => rosterPublish(W, pend);
  $('#ro-copy').onclick = () => rosterCopyWeek(W);
  // drag a shift to another day or person (Ctrl / Alt / ⌘: copy)
  const grid = $('.ro-grid');
  grid.addEventListener('dragstart', e => { const c = e.target.closest('.ro-shift'); if (!c) return; e.dataTransfer.setData('text/plain', c.dataset.sid); e.dataTransfer.effectAllowed = 'copyMove'; c.classList.add('dragging'); });
  grid.addEventListener('dragend', e => { const c = e.target.closest('.ro-shift'); if (c) c.classList.remove('dragging'); $$('.ro-cell.over').forEach(x => x.classList.remove('over')); });
  grid.addEventListener('dragover', e => { const td = e.target.closest('.ro-cell'); if (!td) return; e.preventDefault(); e.dataTransfer.dropEffect = e.ctrlKey || e.altKey || e.metaKey ? 'copy' : 'move'; $$('.ro-cell.over').forEach(x => x !== td && x.classList.remove('over')); td.classList.add('over'); });
  grid.addEventListener('drop', async e => {
    const td = e.target.closest('.ro-cell'); if (!td) return; e.preventDefault(); td.classList.remove('over');
    const s = all().find(x => String(x.id) === e.dataTransfer.getData('text/plain')); if (!s) return;
    const uid = td.dataset.u ? +td.dataset.u : null, d = td.dataset.d, copy = e.ctrlKey || e.altKey || e.metaKey;
    if (!copy && s.date === d && (s.user_id || null) === uid) return;
    try {
      const r = copy ? await api('/api/staff/roster/shifts', { body: { user_id: uid, date: d, start: s.start, finish: s.finish, break_min: s.break_min, role: s.role, note: s.note } })
        : await api(`/api/staff/roster/shifts/${s.id}`, { method: 'PUT', body: { user_id: uid, date: d } });
      toast(`${copy ? 'Copied' : 'Moved'} to ${roDay(d)}${r.warnings.length ? ` · ⚠ ${r.warnings.join('; ')}` : ''}`, r.warnings.length ? 7000 : 3000);
      renderRoster();
    } catch (err) { toast(err.message, 6000); }
  });
}

// ---- add or change one shift
function rosterEditor(W, { shift = null, user_id = null, date }) {
  const s = shift, ed = W.can_edit;
  if (!ed && s) return toast(`${roTimes(s)}${s.role ? ' · ' + s.role : ''}${s.note ? ' · ' + s.note : ''}`, 5000);
  const people = W.people, p0 = s ? s.user_id : user_id, last = RO_LAST || {};
  const v = s ? { ...s } : { user_id: p0, date, start: last.start || W.normal_start, finish: last.finish || W.normal_finish, role: last.role || '', note: '' };
  if (!s) v.break_min = last.break_min != null && last.start === v.start && last.finish === v.finish ? last.break_min : roRuleBreak(roSpan(v.start, v.finish));
  const dayOpts = W.days.includes(v.date) ? W.days : [v.date, ...W.days];
  const m = openModal(`<h2 style="font-size:1.35rem">${s ? (s.deleted ? 'Removed shift' : 'Change shift') : 'Add a shift'}</h2>
    ${s && s.state ? `<p class="small" style="margin:-4px 0 10px"><span class="ro-st inl">${s.state}</span> ${s.state === 'removed' ? 'Staff still see this shift until you publish again.' : 'Not published yet: staff see the earlier version until you publish again.'}</p>` : ''}
    <form id="ro-f" class="ro-form" novalidate>
      <label class="ts-box ro-full"><span>Who</span><select name="user_id"><option value="">Open shift (nobody yet)</option>${people.map(p => `<option value="${p.id}" ${p.id === v.user_id ? 'selected' : ''}>${esc(p.name)}${p.position ? ' · ' + esc(p.position) : ''}</option>`).join('')}</select></label>
      <label class="ts-box ro-full"><span>Day</span><select name="date">${dayOpts.map(d => `<option value="${d}" ${d === v.date ? 'selected' : ''}>${esc(roDay(d))}</option>`).join('')}</select></label>
      <label class="ts-box"><span>Start</span><input type="time" name="start" value="${v.start}" required></label>
      <label class="ts-box"><span>Finish</span><input type="time" name="finish" value="${v.finish}" required></label>
      <label class="ts-box"><span>Unpaid break (min)</span><input type="number" name="break_min" min="0" max="240" step="5" value="${v.break_min || 0}"></label>
      <label class="ts-box"><span>Role or area</span><input name="role" list="ro-roles" maxlength="40" value="${esc(v.role || '')}" placeholder="e.g. Cafe, Till"></label>
      <label class="ts-box ro-full"><span>Note for staff</span><input name="note" maxlength="200" value="${esc(v.note || '')}" placeholder="Optional, e.g. Stocktake"></label>
      <p class="small ro-full ro-live" id="ro-live"></p>
      ${s && (s.warnings || []).length && !s.deleted ? `<div class="note ro-full" style="margin:0"><b>⚠ Check:</b> ${s.warnings.map(esc).join('; ')}. <span class="muted">(A warning only: it saves anyway.)</span></div>` : ''}
      <div class="err ro-full"></div>
      <div class="ro-full sh-btns">${s && s.deleted ? '<button type="button" class="btn coral" id="ro-restore">Put it back</button>' : `<button class="btn coral">${s ? 'Save' : 'Add shift'}</button>`}
        ${s && !s.deleted ? '<button type="button" class="btn ghost" id="ro-rep">Repeat…</button>' : ''}
        ${s && !s.deleted ? `<button type="button" class="btn danger" id="ro-del">${s.state === '' && W.published ? 'Remove' : 'Delete'}</button>` : ''}</div>
      <div class="ro-full ro-repeat" id="ro-repbox" hidden><b class="small">Repeat on</b><div class="ro-repdays">${W.days.filter(d => !s || d !== s.date).map(d => `<label class="check small"><input type="checkbox" value="${d}" ${!['Sat', 'Sun'].includes(QE.dayShort(d).slice(0, 3)) ? 'checked' : ''}> ${esc(QE.dayShort(d))}</label>`).join('')}</div>
        <button type="button" class="btn sm" id="ro-repgo">Repeat this shift</button><span class="small muted"> Same person, times, role and note. Days that already have it are skipped.</span></div>
    </form>`);
  m.el.style.maxWidth = '520px';
  const F = $('#ro-f', m.el), person = () => people.find(p => String(p.id) === F.user_id.value);
  let breakTouched = !!s;
  F.break_min.oninput = () => { breakTouched = true; liveText(); };
  const liveText = () => {
    const a = F.start.value, b = F.finish.value; if (!a || !b) { $('#ro-live', m.el).textContent = 'Enter the start and finish.'; return; }
    const span = roSpan(a, b), br = +F.break_min.value || 0, paid = Math.max(0, span - br) / 60, rule = roRuleBreak(span), p = person();
    const pay = W.sees_pay && p && p.pay_type === 'hourly' ? ` · about <b>${money(Math.round(paid * p.pay_rate * 100) / 100, cur())}</b>` : '';
    $('#ro-live', m.el).innerHTML = `${(span / 60).toFixed(2)} h shift${br ? ` − ${br} min break` : ''} = <b>${paid.toFixed(2)} h</b>${pay}${b <= a ? ' · finishes the next day' : ''}${span > 12 * 60 ? ' · <span class="ts-flag">a long shift</span>' : ''}
      ${rule !== br ? `<br><span class="muted">When paying, Payroll's rules take off ${rule ? `${rule} min` : 'no break'} for a shift this long (Payroll → Payroll rules).</span>` : ''}`;
  };
  const times = () => { if (!breakTouched) F.break_min.value = roRuleBreak(roSpan(F.start.value || '09:00', F.finish.value || '17:00')); liveText(); };
  F.start.oninput = F.finish.oninput = times; F.user_id.onchange = liveText; liveText();
  const body = () => ({ user_id: F.user_id.value ? +F.user_id.value : null, date: F.date.value, start: F.start.value, finish: F.finish.value, break_min: +F.break_min.value || 0, role: F.role.value, note: F.note.value });
  const fail = err => { $('.err', F).innerHTML = `<div class="error">${esc(err.message)}</div>`; };
  const done = (r, what) => { m.close(); toast(`${what}${r && r.warnings && r.warnings.length ? ` · ⚠ ${r.warnings.join('; ')}` : ''}`, r && r.warnings && r.warnings.length ? 7000 : 3000); renderRoster(); };
  F.onsubmit = async e => {
    e.preventDefault(); if (F.dataset.busy) return; F.dataset.busy = '1';
    const b = body();
    try {
      const r = s ? await api(`/api/staff/roster/shifts/${s.id}`, { method: 'PUT', body: b }) : await api('/api/staff/roster/shifts', { body: b });
      RO_LAST = { start: b.start, finish: b.finish, break_min: b.break_min, role: b.role };
      done(r, s ? 'Shift saved' : 'Shift added');
    } catch (err) { fail(err); delete F.dataset.busy; }
  };
  if ($('#ro-restore', m.el)) $('#ro-restore', m.el).onclick = async () => { try { done(await api(`/api/staff/roster/shifts/${s.id}`, { method: 'PUT', body: { restore: true } }), 'Shift put back'); } catch (err) { fail(err); } };
  if ($('#ro-del', m.el)) $('#ro-del', m.el).onclick = async () => {
    if (!confirm(`${s.state === '' && W.published ? 'Remove' : 'Delete'} ${s.user_id ? (person() || {}).name || '' : 'this open shift'}${s.user_id ? "'s" : ''} shift on ${roDay(s.date)}, ${roTimes(s)}?`)) return;
    try { const r = await api(`/api/staff/roster/shifts/${s.id}`, { method: 'DELETE' }); done(null, r.removed ? 'Shift removed: staff are told when you publish again' : 'Shift deleted'); } catch (err) { fail(err); }
  };
  if ($('#ro-rep', m.el)) $('#ro-rep', m.el).onclick = () => { const box = $('#ro-repbox', m.el); box.hidden = !box.hidden; };
  if ($('#ro-repgo', m.el)) $('#ro-repgo', m.el).onclick = async () => {
    const dates = $$('#ro-repbox input:checked', m.el).map(i => i.value);
    if (!dates.length) return fail(new Error('Tick the days to repeat it on.'));
    try { const r = await api(`/api/staff/roster/shifts/${s.id}/repeat`, { body: { dates } }); done(null, `Repeated on ${r.added} day${r.added === 1 ? '' : 's'}${r.skipped.length ? ` (${r.skipped.length} already had it)` : ''}`); } catch (err) { fail(err); }
  };
}

// ---- copy last week
function rosterCopyWeek(W) {
  const has = W.totals.shifts + W.totals.open > 0, prev = QE.period(addDays(W.week_start, -7), addDays(W.week_start, -1), false);
  const m = openModal(`<h2 style="font-size:1.35rem">Copy last week</h2><p class="muted" style="margin:0 0 14px">From ${esc(prev)} into ${esc(W.label)}: the same people, days, times, roles and notes.</p>
    <div class="pr-choices">${has ? `<button type="button" class="pr-choice" data-cw="add"><b>Add to this week</b><span>keep what's here</span><small>Shifts already on this week stay. The same shift isn't added twice.</small></button>
      <button type="button" class="pr-choice" data-cw="replace"><b>Replace this week</b><span>start again from last week</span><small>This week's shifts come off first${W.published ? ' (staff are told when you publish again)' : ''}.</small></button>`
      : `<button type="button" class="pr-choice" data-cw="add"><b>Copy last week's shifts</b><span>into this week</span><small>People who have left, or who have leave booked that day, are skipped.</small></button>`}</div><div class="err"></div>`);
  m.el.style.maxWidth = '560px';
  $$('[data-cw]', m.el).forEach(b => b.onclick = async () => {
    $$('[data-cw]', m.el).forEach(x => { x.disabled = true; });
    try {
      const r = await api('/api/staff/roster/copy-week', { body: { week: W.week_start, replace: b.dataset.cw === 'replace' } });
      m.close();
      const sk = r.skipped.filter(x => x.why !== 'already on the roster');
      renderRoster({ flash: `<b>✓ Copied ${r.added} shift${r.added === 1 ? '' : 's'} from ${esc(prev)}.</b>${r.removed ? ` ${r.removed} taken off first.` : ''}${sk.length ? ` Not copied: ${sk.map(x => `${esc(x.name)} ${esc(roDay(x.date))} (${esc(x.why)})`).join(', ')}.` : ''} Check it, then <b>Publish roster</b>.` });
    } catch (err) { $('.err', m.el).innerHTML = `<div class="error" style="margin-top:10px">${esc(err.message)}</div>`; $$('[data-cw]', m.el).forEach(x => { x.disabled = false; }); }
  });
}

// ---- publish
function rosterPublish(W, pend) {
  const n = W.totals.shifts + W.totals.open;
  const m = openModal(`<h2 style="font-size:1.35rem">${W.published ? 'Publish the roster again' : 'Publish the roster'}</h2>
    <p><b>${esc(W.label)}</b>: ${n} shift${n === 1 ? '' : 's'}${W.totals.open ? `, ${W.totals.open} of them open` : ''}.</p>
    <p class="small muted">${W.published ? `Staff will see the ${pend} change${pend === 1 ? '' : 's'}, marked "changed".` : "Staff will see their shifts on the time clock (after tapping their name) and on the Roster page."} Next, you can print it or copy it for WhatsApp.</p>
    ${W.totals.warnings ? `<div class="note">⚠ ${W.totals.warnings} warning${W.totals.warnings === 1 ? '' : 's'} on this week (see "Things to check"). You can still publish.</div>` : ''}
    <div class="err"></div><div class="actions"><button type="button" class="btn coral" id="ro-pub-go">📣 Publish</button><button type="button" class="btn ghost" id="ro-pub-no">Not yet</button></div>`);
  m.el.style.maxWidth = '500px';
  $('#ro-pub-no', m.el).onclick = m.close;
  $('#ro-pub-go', m.el).onclick = async () => {
    $('#ro-pub-go', m.el).disabled = true;
    try {
      const r = await api('/api/staff/roster/publish', { body: { week: W.week_start } });
      m.close();
      await renderRoster({ flash: `<b>✓ Roster published${r.again ? ' again' : ''}.</b> ${r.again ? `${r.added} new, ${r.changed} changed, ${r.removed} removed. ` : ''}Staff can see it now.` });
      rosterTextModal(r.text, true);
    } catch (err) { $('.err', m.el).innerHTML = `<div class="error">${esc(err.message)}</div>`; $('#ro-pub-go', m.el).disabled = false; }
  };
}

// ---- share: the plain text (WhatsApp / SMS), and print / PDF, of the published roster
function rosterTextModal(text, justPublished = false) {
  const phone = /Android|iPhone|iPad/.test(navigator.userAgent);
  const m = openModal(`<h2 style="font-size:1.35rem">${justPublished ? 'Send the roster to staff' : 'Roster as text'}</h2>
    <p class="small muted" style="margin:-4px 0 8px">Copy it and paste it into your staff WhatsApp group or a text message.</p>
    <textarea class="ro-text" readonly rows="12">${esc(text)}</textarea>
    <div class="actions"><button type="button" class="btn coral" id="ro-tcopy">📋 Copy</button>
      <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">WhatsApp</a>
      ${phone ? `<a class="btn ghost" href="sms:?&body=${encodeURIComponent(text)}">Text message</a>` : ''}
      ${navigator.share ? '<button type="button" class="btn ghost" id="ro-tshare">Share…</button>' : ''}</div>`);
  m.el.style.maxWidth = '560px';
  $('#ro-tcopy', m.el).onclick = async () => {
    const ta = $('.ro-text', m.el);
    try { await navigator.clipboard.writeText(text); } catch { ta.focus(); ta.select(); try { document.execCommand('copy'); } catch { } }
    toast('Copied: paste it into WhatsApp or a message');
  };
  if ($('#ro-tshare', m.el)) $('#ro-tshare', m.el).onclick = () => navigator.share({ text }).catch(() => {});
}
async function rosterShare(week, how) {
  let P; try { P = await api(`/api/staff/roster/published?week=${week}`); } catch (e) { return toast(e.message); }
  if (!P.published) return toast("This week's roster isn't published yet. Publish it first, then print or share it.", 6000);
  if (how === 'text') return rosterTextModal(P.text);
  const all = [...P.people.flatMap(p => p.shifts), ...P.open], line = s => `${roTimes(s)}${s.role ? `<br><small>${esc(s.role)}</small>` : ''}${s.note ? `<br><small><i>${esc(s.note)}</i></small>` : ''}${s.changed ? ' <b>*</b>' : ''}`;
  const cellsFor = list => P.days.map(d => `<td>${list.filter(s => s.date === d).map(line).join('<hr>') || '<span class="off">–</span>'}</td>`).join('');
  const html = `<h1>${esc(P.company)} roster</h1><p class="sub">${esc(P.label)} · published ${esc(roWhen(P.published.at))}${all.some(s => s.changed) ? ' · <b>*</b> changed since first published' : ''}</p>
    <table><thead><tr><th>Staff</th>${P.days.map(d => `<th>${esc(QE.dayShort(d))}</th>`).join('')}<th>Hours</th></tr></thead><tbody>
    ${P.open.length ? `<tr class="open"><th>Open shifts<br><small>ask to take one</small></th>${cellsFor(P.open)}<td></td></tr>` : ''}
    ${P.people.map(p => `<tr><th>${esc(p.name)}${p.position ? `<br><small>${esc(p.position)}</small>` : ''}</th>${cellsFor(p.shifts)}<td class="h">${p.hours.toFixed(2)}</td></tr>`).join('')}</tbody></table>`;
  const w = window.open('', '_blank'); if (!w) return toast('Allow pop-ups to print the roster');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Roster ${esc(P.label)}</title><style>
    @page{size:A4 landscape;margin:12mm} body{font:12px/1.35 Inter,system-ui,sans-serif;color:#16202b;margin:0;padding:16px} h1{font-size:20px;margin:0} .sub{color:#5a6573;margin:2px 0 12px}
    table{border-collapse:collapse;width:100%;table-layout:fixed} th,td{border:1px solid #c9d1db;padding:5px 6px;vertical-align:top;text-align:left} thead th{background:#e4eef9}
    tbody th{width:15%;background:#f6f8fb} td.h{text-align:right;width:6%} small{color:#5a6573} hr{border:0;border-top:1px dashed #c9d1db;margin:4px 0} .off{color:#b8c0ca} tr.open th,tr.open td{background:#fff8e6}
  </style></head><body>${html}<script>setTimeout(()=>print(),300)<\/script></body></html>`);
  w.document.close();
}

// ---- what staff see: the published roster (their own shifts first)
async function renderRosterStaff() {
  const P = await api(`/api/staff/roster/published?week=${RO.week || today()}`);
  RO.week = P.week_start;
  const t = today(), mine = (P.people.find(p => p.id === P.me) || { shifts: [], hours: 0 });
  const all = [...P.people.flatMap(p => p.shifts), ...P.open];
  const row = (s, me) => `<div class="ro-line${me ? ' me' : ''}${s.user_id ? '' : ' open'}"><span class="ro-lt">${roTimes(s)}</span><span class="ro-ln"><b>${s.user_id ? esc(s.name) : 'Open shift'}</b>${s.role ? ` · ${esc(s.role)}` : ''}${s.break_min ? ` <span class="small muted">(${s.break_min} min break)</span>` : ''}${s.note ? `<span class="small muted ro-note">${esc(s.note)}</span>` : ''}</span>${s.changed ? '<span class="ro-st">changed</span>' : ''}</div>`;
  view().innerHTML = `
    <div class="ro-top"><div class="ts-period ro-weeknav"><button type="button" class="btn sm ghost" id="ro-prev" aria-label="Previous week" title="Previous week">‹</button>
      <div class="ts-period-mid"><span class="ts-period-k">Roster for the week</span><b>${esc(P.label)}</b>${P.days.includes(t) ? '<span class="chip">this week</span>' : '<button type="button" class="chip gray ro-thisweek" id="ro-today">Go to this week</button>'}</div>
      <button type="button" class="btn sm ghost" id="ro-next" aria-label="Next week" title="Next week">›</button></div>
      ${P.published ? `<div class="ro-pub ok" role="status"><b>Published</b> ${esc(roWhen(P.published.at))}${all.some(s => s.changed) ? '. Shifts marked <span class="ro-st inl">changed</span> are different from when it was first published.' : '.'}</div>` : ''}</div>
    <div class="bar-tools ro-tools">${L('timesheets') >= 1 ? '<button type="button" class="btn sm" id="ro-plan">← Back to planning</button>' : ''}
      ${P.published ? '<button type="button" class="btn sm ghost" id="ro-print">🖨 Print or PDF</button><button type="button" class="btn sm ghost" id="ro-text">💬 WhatsApp / SMS text</button>' : ''}</div>
    ${!P.published ? `<div class="empty">The roster for ${esc(P.label)} isn't published yet.${L('timesheets') >= 2 ? ' Plan it, then press <b>Publish roster</b>.' : ' Check again later, or ask your manager.'}</div>` : `
      <div class="panel ro-mine"><h3>My shifts <span class="small muted">${mine.hours ? `${mine.hours.toFixed(2)} h this week` : ''}</span></h3>
        ${mine.shifts.length ? mine.shifts.map(s => `<div class="ro-line me${s.date === t ? ' now' : ''}"><span class="ro-lt">${esc(roDay(s.date))}</span><span class="ro-ln"><b>${fmtTime(s.start)}–${fmtTime(s.finish)}</b>${s.role ? ` · ${esc(s.role)}` : ''}${s.break_min ? ` <span class="small muted">(${s.break_min} min break)</span>` : ''}${s.note ? `<span class="small muted ro-note">${esc(s.note)}</span>` : ''}</span>${s.changed ? '<span class="ro-st">changed</span>' : ''}</div>`).join('') : '<p class="small muted" style="margin:0">You have no shifts this week.</p>'}</div>
      <div class="ro-week">${P.days.map(d => { const list = all.filter(s => s.date === d).sort((a, b) => a.start.localeCompare(b.start));
        return `<div class="panel ro-dayp${d === t ? ' today' : ''}"><h3>${esc(roDay(d))}${d === t ? ' <span class="chip">today</span>' : ''}</h3>${list.map(s => row(s, s.user_id === P.me)).join('') || '<p class="small muted" style="margin:0">Nobody rostered</p>'}</div>`; }).join('')}</div>
      ${P.open.length ? '<p class="small muted">Open shifts have nobody yet. Ask your manager if you would like one.</p>' : ''}`}`;
  $('#ro-prev').onclick = () => renderRoster({ week: addDays(P.week_start, -7) });
  $('#ro-next').onclick = () => renderRoster({ week: addDays(P.week_start, 7) });
  if ($('#ro-today')) $('#ro-today').onclick = () => renderRoster({ week: today() });
  if ($('#ro-plan')) $('#ro-plan').onclick = () => renderRoster({ mode: 'plan' });
  if ($('#ro-print')) $('#ro-print').onclick = () => rosterShare(P.week_start, 'print');
  if ($('#ro-text')) $('#ro-text').onclick = () => rosterTextModal(P.text);
}

// ---- the time clock: after tapping a name, that person's published shifts (shown in the PIN pad)
async function rosterOnClock(box, userId) {
  try {
    const r = await api(`/api/staff/timeclock/roster?user_id=${userId}`);
    if (!document.body.contains(box)) return;
    const tom = addDays(r.today, 1), when = d => d === r.today ? 'Today' : d === tom ? 'Tomorrow' : roDay(d);
    box.innerHTML = r.shifts.length ? `<div class="ro-clock-k">Your shifts</div>${r.shifts.slice(0, 6).map(s => `<div class="ro-cl${s.date === r.today ? ' now' : ''}"><b>${esc(when(s.date))}</b><span>${fmtTime(s.start)}–${fmtTime(s.finish)}${s.role ? ` · ${esc(s.role)}` : ''}</span>${s.changed ? '<span class="ro-st">changed</span>' : ''}${s.note ? `<small>${esc(s.note)}</small>` : ''}</div>`).join('')}`
      : '<div class="ro-clock-k">Your shifts</div><p class="small muted" style="margin:0">No shifts on the roster for the next two weeks.</p>';
  } catch { box.innerHTML = ''; }
}
/** "9:05am · rostered 9:00am (5 min late)" for the time clock message */
function rosterPunchText(r) {
  const x = r && r.roster; if (!x) return '';
  const d = x.in_min != null ? x.in_min : x.out_min, m = Math.abs(d), word = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  if (x.in_min != null) return ` · rostered ${fmtTime(x.start)}${m < 5 ? ' (on time)' : d > 0 ? ` (${word} late)` : ` (${word} early)`}`;
  return ` · rostered until ${fmtTime(x.finish)}${m < 5 ? ' (on time)' : d < 0 ? ` (${word} early)` : ` (${word} over)`}`;
}
