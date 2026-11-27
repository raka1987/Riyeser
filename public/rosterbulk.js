// OWNER-BULKROSTER (Payroll 2.4.0): rostering many people at once on the Roster page (roster.js draws the page).
//  - Select many days on the grid: drag across them, Shift + click (a block), Ctrl / ⌘ + click (one more), click a name
//    (their week), a day heading (everyone that day) or "Staff" (everything). Keyboard: arrow keys move, Space selects,
//    Shift + arrows select a block, Ctrl+A everything, Esc nothing, Enter goes to the actions, Delete clears. On a phone
//    or tablet: "☑ Select" shows a tick box on each day.
//  - Then, in the bar at the bottom: a shift template (one click), typed times, a role, or Clear.
//  - "↻ Fill from usual weeks", More → Shift templates, Usual weeks, Import shifts from a file, Copy last week, Copy to
//    the next weeks. Every bulk change shows a summary (added, skipped and why, warnings) and can be undone (↶ Undo, Ctrl+Z).
// Uses the page's helpers (common.js, staff.js, roster.js: RO, RO_W, renderRoster, roDay, roTimes…). The server checks everything.
const RB_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const rbPlural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
const rbCells = () => [...RO.sel].map(k => { const [u, d] = k.split('|'); return { user_id: u ? +u : null, date: d }; });
let RB_DRAG = null;
// while dragging across days the bar below waits (so it doesn't appear over the days being dragged across)
window.addEventListener('mouseup', () => { const d = RB_DRAG; RB_DRAG = null; if (d && d.moved) { try { window.getSelection().removeAllRanges(); } catch { } if (d.done) d.done(); } });

// ---- the summary after a bulk change: "Added 42 shifts, skipped 3: on leave that day (Ana Wed 2 Dec, …)", warnings, Undo
function rosterSummary(r, verb) {
  const parts = [r.added && `added ${rbPlural(r.added, 'shift')}`, r.changed && `changed ${rbPlural(r.changed, 'shift')}`, r.removed && `took off ${rbPlural(r.removed, 'shift')}`].filter(Boolean);
  const head = `${verb}: ${parts.length ? parts.join(', ') : 'nothing to change'}`;
  const sk = (r.skipped || []), by = {};
  for (const x of sk) (by[x.why] = by[x.why] || []).push(`${x.name}${x.date ? ` ${roDay(x.date)}` : ''}`);
  const list = (a, n = 5) => `${a.slice(0, n).map(esc).join(', ')}${a.length > n ? `, +${a.length - n} more` : ''}`;
  const skipped = sk.length ? ` <span class="ro-sum-k">Skipped ${sk.length}:</span> ${Object.entries(by).map(([w, a]) => `${esc(w)} (${list(a)})`).join('; ')}.` : '';
  const ws = r.warnings || [];
  const warns = ws.length ? `<br><span class="ro-sum-w">⚠ ${rbPlural(ws.length, 'warning')}:</span> ${ws.slice(0, 4).map(w => `${esc(w.name)} ${esc(roDay(w.date))}: ${esc(w.text)}`).join('; ')}${ws.length > 4 ? `; +${ws.length - 4} more (see Things to check)` : ''}.` : '';
  return { text: `${head}${sk.length ? `, skipped ${sk.length}` : ''}`, html: `<b>✓ ${esc(head)}.</b>${skipped}${warns}${r.added || r.changed || r.removed ? ` <span class="muted">A draft until you publish.</span>` : ''}${r.undo ? ` <button type="button" class="btn sm ghost ro-undo-inl" data-ro-undo>↶ Undo</button>` : ''}` };
}
function rosterDone(r, verb, state = {}) {
  const s = rosterSummary(r, verb);
  toast(s.text, 4000);
  return renderRoster({ flash: s.html, ...state });
}
async function rosterUndo() {
  try {
    const r = await api('/api/staff/roster/undo', { body: {} });
    toast(`Undone: ${r.label}`, 4000);
    renderRoster({ flash: `<b>↶ Undone:</b> ${esc(r.label)}.` });
  } catch (e) { toast(e.message, 5000); }
}
// On the Roster page (not while typing, not with a window open): Ctrl+Z (⌘Z) undoes the last bulk change, Esc selects nothing
document.addEventListener('keydown', e => {
  if (typeof VIEW === 'undefined' || VIEW !== 'roster' || !RO_W || !RO_W.can_edit) return;
  if (document.querySelector('.modal-bg') || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) return;
  if (e.key === 'Escape' && RO.sel.size && !document.querySelector('.rm-list:not([hidden])')) { RO.sel = new Set(); RO.anchor = null; const page = document.querySelector('.ro-page'); if (page) rosterPaintSel(RO_W, page); return; }
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z' || !RO_W.undo) return;
  e.preventDefault(); rosterUndo();
});

// ---- the More menu (the toolbar's other actions)
function rosterMoreMenu(W) {
  const items = W.can_edit ? [['templates', '🗂 Shift templates…'], ['usual', '↻ Usual weeks…'], ['import', '⇪ Import shifts from a file…'], ['copy', '⧉ Copy last week…'], ['copyn', '⧉ Copy to the next weeks…'], ['print', '🖨 Print or PDF'], ['text', '💬 WhatsApp / SMS text'], ['staff', '👀 What staff see']] : [];
  if (!items.length) return '';
  return `<div class="rm ro-more"><button type="button" class="rm-btn btn sm ghost" aria-haspopup="menu" aria-expanded="false" aria-label="More roster actions">More <span aria-hidden="true">▾</span></button>`
    + `<div class="rm-list" role="menu" aria-label="More roster actions" hidden>${items.map(([k, l]) => `<button type="button" role="menuitem" tabindex="-1" class="rm-item" data-mm="${k}">${l}</button>`).join('')}</div></div>`;
}
function rosterMoreBind(W, page) {
  const act = {
    templates: () => rosterTemplatesModal(W), usual: () => rosterUsualModal(W), import: () => rosterImportModal(W), copy: () => rosterCopyWeek(W), copyn: () => rosterCopyNModal(W),
    print: () => rosterShare(W.week_start, 'print'), text: () => rosterShare(W.week_start, 'text'), staff: () => renderRoster({ mode: 'staff' }),
  };
  $$('[data-mm]', page).forEach(b => b.onclick = () => act[b.dataset.mm]());
  for (const k of ['print', 'text', 'staff']) { const b = $(`#ro-${k}`, page); if (b) b.onclick = act[k]; }
}

// ---- the bar for the selected days
function rosterBulkBar(W) {
  const n = RO.sel.size, cells = rbCells(), people = new Set(cells.map(c => c.user_id)).size, days = new Set(cells.map(c => c.date)).size;
  if (!n && !RO.selMode) return '<div class="ro-bulk" id="ro-bulk" hidden></div>';
  const T = W.templates || [];
  return `<div class="ro-bulk" id="ro-bulk" role="region" aria-label="Change the selected days">
    <div class="ro-bb-n" aria-live="polite">${n ? `<b>${rbPlural(n, 'day')}</b><span class="muted"> · ${rbPlural(people, 'row')} × ${rbPlural(days, 'day')}</span>` : '<span class="muted">Tick the days to change</span>'}</div>
    <div class="ro-bb-acts"${n ? '' : ' hidden'}>
      <div class="ro-tbtns ro-bb-t" role="group" aria-label="Put this shift on the selected days">${T.map(t => `<button type="button" class="ro-tbtn" data-bb-t="${t.id}" style="--tc:${esc(t.colour)}" title="${esc(`${t.name}: ${fmtTime(t.start)}–${fmtTime(t.finish)}${t.break_min ? `, ${t.break_min} min break` : ''}${t.role ? `, ${t.role}` : ''}. Replaces the shift already on a selected day.`)}"><i aria-hidden="true"></i>${esc(t.name)} <small>${esc(roTimes(t))}</small></button>`).join('')}</div>
      <select class="ro-bb-more" aria-label="More shift templates" hidden><option value="">More shifts…</option>${T.map(t => `<option value="${t.id}">${esc(t.name)} · ${esc(roTimes(t))}</option>`).join('')}</select>
      <span class="ro-bb-sep" aria-hidden="true"></span>
      <button type="button" class="btn sm ghost" data-bb="times" title="Type the start and finish for the selected days">Times…</button>
      <button type="button" class="btn sm ghost" data-bb="role" title="Set the role or area on the shifts on the selected days">Role…</button>
      <button type="button" class="btn sm ghost ro-bb-clear" data-bb="clear" title="Take the shifts off the selected days (Delete)">Clear</button></div>
    <button type="button" class="ro-bb-x" data-bb="none" aria-label="Select nothing (Esc)" title="Select nothing (Esc)">✕</button></div>`;
}
function rosterBulkBarBind(W, page) {
  const bar = $('#ro-bulk', page); if (!bar) return;
  rosterBulkBarFit(bar);
  const mo = $('.ro-bb-more', bar);
  if (mo) mo.onchange = () => { const t = W.templates.find(x => x.id === +mo.value); if (t) rosterApply(W, 'set', { shift: { template_id: t.id } }, t.name); };
  $$('[data-bb-t]', bar).forEach(b => b.onclick = () => rosterApply(W, 'set', { shift: { template_id: +b.dataset.bbT } }, (W.templates.find(t => t.id === +b.dataset.bbT) || {}).name));
  $$('[data-bb]', bar).forEach(b => b.onclick = () => {
    const k = b.dataset.bb;
    if (k === 'none') { RO.sel = new Set(); RO.anchor = null; return rosterPaintSel(W, page); }
    if (k === 'times') return rosterTimesModal(W);
    if (k === 'role') return rosterRoleModal(W);
    if (k === 'clear') return rosterClearSel(W);
  });
}
// the template buttons that fit on the bar's one line stay; the others go in the "More shifts…" list
function rosterBulkBarFit(bar) {
  const acts = $('.ro-bb-acts', bar), box = $('.ro-bb-t', bar), mo = $('.ro-bb-more', bar); if (!box || !mo || bar.hidden || acts.hidden) return;
  const btns = $$('.ro-tbtn', box); btns.forEach(b => { b.hidden = false; }); mo.hidden = true;
  $$('option[value]:not([value=""])', mo).forEach(o => { o.hidden = true; });
  if (getComputedStyle(bar).flexWrap === 'wrap') return;   // a phone: the buttons scroll sideways on their own row
  // the room left for the template buttons: the bar, less everything else on it and the gaps between
  const gap = el => parseFloat(getComputedStyle(el).columnGap) || 0, pad = el => { const c = getComputedStyle(el); return parseFloat(c.paddingLeft) + parseFloat(c.paddingRight); };
  const others = [...bar.children].filter(c => c !== acts && !c.hidden), mine = [...acts.children].filter(c => c !== box && c !== mo && !c.hidden);
  let room = bar.clientWidth - pad(bar) - others.reduce((t, c) => t + c.offsetWidth, 0) - gap(bar) * others.length - mine.reduce((t, c) => t + c.offsetWidth, 0) - gap(acts) * mine.length - pad(box);
  const widths = () => btns.map(b => b.offsetWidth + gap(box)), sum = a => a.reduce((t, x) => t + x, 0);
  box.classList.remove("compact"); let w = widths();
  if (sum(w) <= room) return;
  box.classList.add("compact"); w = widths();   // first the times come off the buttons (they are in each one's tooltip)
  if (sum(w) <= room) return;
  mo.hidden = false; room -= mo.offsetWidth + gap(acts);
  let used = 0;
  const off = b => { b.hidden = true; const o = mo.querySelector(`option[value="${b.dataset.bbT}"]`); if (o) o.hidden = false; };
  let full = false;   // in order: once one does not fit, the rest go in the list too
  btns.forEach((b, i) => { if (!full && used + w[i] <= room) used += w[i]; else { full = true; off(b); } });
  // and never a button cut in half
  for (let v = btns.filter(b => !b.hidden); v.length && box.scrollWidth > box.clientWidth + 1; v = btns.filter(b => !b.hidden)) off(v[v.length - 1]);
}
window.addEventListener('resize', () => { const bar = document.getElementById('ro-bulk'); if (bar) rosterBulkBarFit(bar); });
function rosterClearSel(W) {
  const n = RO.sel.size; if (!n) return;
  if (!confirm(`Take the shifts off the ${rbPlural(n, 'selected day')}?${W.published ? ' Published shifts stay for staff (marked removed) until you publish again.' : ''}`)) return;
  rosterApply(W, 'clear', {}, 'Cleared');
}
async function rosterApply(W, action, extra, what) {
  const cells = rbCells(); if (!cells.length) return toast('Select the days first');
  $$('#ro-bulk button').forEach(b => { b.disabled = true; });
  try {
    const r = await api('/api/staff/roster/bulk', { body: { action, cells, ...extra } });
    const verb = action === 'clear' ? 'Cleared the selected days' : action === 'role' ? 'Set the role' : `${what || 'Shift'} on ${rbPlural(cells.length, 'selected day')}`;
    rosterDone(r, verb);
  } catch (e) { toast(e.message, 6000); $$('#ro-bulk button').forEach(b => { b.disabled = false; }); }
}
function rosterTimesModal(W) {
  const n = RO.sel.size, last = RO_LAST || {}, a = last.start || W.normal_start, b = last.finish || W.normal_finish;
  const m = openModal(`<h2 style="font-size:1.35rem">Times for ${rbPlural(n, 'selected day')}</h2>
    <form class="ro-form" id="rb-tf" novalidate>
      <label class="ts-box"><span>Start</span><input type="time" name="start" value="${a}" required></label>
      <label class="ts-box"><span>Finish</span><input type="time" name="finish" value="${b}" required></label>
      <label class="ts-box"><span>Unpaid break (min)</span><input type="number" name="break_min" min="0" max="240" step="5" value="${roRuleBreak(roSpan(a, b))}"></label>
      <label class="ts-box"><span>Role or area</span><input name="role" list="ro-roles" maxlength="40" placeholder="e.g. Cafe, Till"></label>
      <label class="ts-box ro-full"><span>Note for staff</span><input name="note" maxlength="200" placeholder="Optional"></label>
      <fieldset class="ro-full ro-radios"><legend class="small muted">Days that already have a shift</legend>
        <label class="check"><input type="radio" name="mode" value="set" checked> Change it to these times</label>
        <label class="check"><input type="radio" name="mode" value="add"> Add this as another shift</label></fieldset>
      <div class="err ro-full"></div>
      <div class="ro-full actions"><button class="btn coral">Apply to ${rbPlural(n, 'day')}</button><button type="button" class="btn ghost" data-x>Cancel</button></div></form>`);
  m.el.style.maxWidth = '520px';
  const F = $('#rb-tf', m.el); let touched = false;
  F.break_min.oninput = () => { touched = true; };
  F.start.oninput = F.finish.oninput = () => { if (!touched && F.start.value && F.finish.value) F.break_min.value = roRuleBreak(roSpan(F.start.value, F.finish.value)); };
  $('[data-x]', m.el).onclick = m.close;
  F.onsubmit = async e => {
    e.preventDefault();
    const shift = { start: F.start.value, finish: F.finish.value, break_min: +F.break_min.value || 0, role: F.role.value, note: F.note.value };
    try {
      const r = await api('/api/staff/roster/bulk', { body: { action: F.mode.value, cells: rbCells(), shift } });
      RO_LAST = { ...shift, template_id: null }; m.close();
      rosterDone(r, `${roTimes(shift)} on ${rbPlural(n, 'selected day')}`);
    } catch (err) { $('.err', F).innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  };
}
function rosterRoleModal(W) {
  const n = RO.sel.size;
  const m = openModal(`<h2 style="font-size:1.35rem">Role for ${rbPlural(n, 'selected day')}</h2>
    <form id="rb-rf" novalidate><label class="ts-box"><span>Role or area</span><input name="role" list="ro-roles" maxlength="40" placeholder="e.g. Cafe, Till (empty: no role)"></label>
      <p class="small muted">Changes the shifts already on those days. Days with no shift are left as they are.</p>
      <div class="err"></div><div class="actions"><button class="btn coral">Set the role</button><button type="button" class="btn ghost" data-x>Cancel</button></div></form>`);
  m.el.style.maxWidth = '440px';
  const F = $('#rb-rf', m.el); $('[data-x]', m.el).onclick = m.close;
  F.onsubmit = async e => {
    e.preventDefault();
    try { const r = await api('/api/staff/roster/bulk', { body: { action: 'role', cells: rbCells(), role: F.role.value } }); m.close(); rosterDone(r, F.role.value ? `Role "${F.role.value}"` : 'Role taken off'); }
    catch (err) { $('.err', F).innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  };
}

// ---- selecting days on the grid (mouse, keyboard, touch) and on the phone's day cards
function rosterPaintSel(W, page) {
  $$('.ro-cell', page).forEach(td => { const on = RO.sel.has(td.dataset.k); td.classList.toggle('sel', on); td.setAttribute('aria-selected', on); const ck = $('.ro-ck', td); if (ck) ck.checked = on; });
  $$('.ro-pcard[data-k]', page).forEach(c => { const on = RO.sel.has(c.dataset.k); c.classList.toggle('sel', on); const ck = $('.ro-pck', c); if (ck) ck.checked = on; });
  const total = $$('.ro-cell', page).length, all = $('#ro-all', page);
  if (all) { all.checked = !!total && RO.sel.size >= total; all.indeterminate = RO.sel.size > 0 && RO.sel.size < total; }
  const pall = $('#ro-pall', page); if (pall) pall.checked = W.people.length > 0 && W.people.every(p => RO.sel.has(`${p.id}|${RO.day}`));
  const old = $('#ro-bulk', page);
  if (old && !(RB_DRAG && RB_DRAG.moved)) { old.outerHTML = rosterBulkBar(W); rosterBulkBarBind(W, page); }
}
function rosterSelectBind(W, page) {
  const grid = $('.ro-grid', page); if (!grid) return;
  const rows = () => $$('tbody tr[data-row]', grid).map(tr => tr.dataset.row);
  const pos = k => { const [u, d] = k.split('|'); return [rows().indexOf(u), W.days.indexOf(d)]; };
  const rect = (a, b) => { const R = rows(), [r1, c1] = pos(a), [r2, c2] = pos(b), out = []; if (r1 < 0 || r2 < 0) return [b];
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) out.push(`${R[r]}|${W.days[c]}`); return out; };
  const paint = () => rosterPaintSel(W, page);
  const setFocus = (k, move = true) => {
    RO.focus = k; $$('.ro-cell[tabindex="0"]', grid).forEach(td => td.setAttribute('tabindex', '-1'));
    const td = grid.querySelector(`.ro-cell[data-k="${CSS.escape(k)}"]`); if (td) { td.setAttribute('tabindex', '0'); if (move) td.focus({ preventScroll: false }); }
  };
  if (!grid.querySelector('.ro-cell[tabindex="0"]')) { const f = grid.querySelector('.ro-cell'); if (f) f.setAttribute('tabindex', '0'); }
  // one cell: plain (just it; again: nothing), Ctrl / ⌘ (add or take away), Shift (the block from the last one)
  const pick = (k, { ctrl = false, shift = false } = {}) => {
    if (shift && RO.anchor) RO.sel = new Set([...(ctrl ? RO.sel : []), ...rect(RO.anchor, k)]);
    else if (ctrl || RO.selMode) { RO.sel.has(k) ? RO.sel.delete(k) : RO.sel.add(k); RO.anchor = k; }
    else { RO.sel = RO.sel.size === 1 && RO.sel.has(k) ? new Set() : new Set([k]); RO.anchor = k; }
    setFocus(k, false); paint();
  };
  const group = (keys, ctrl) => {
    if (ctrl) { const allOn = keys.every(k => RO.sel.has(k)); keys.forEach(k => (allOn ? RO.sel.delete(k) : RO.sel.add(k))); }
    else RO.sel = new Set(keys);
    RO.anchor = keys[0] || null; paint();
  };
  grid.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const td = e.target.closest('.ro-cell'); if (!td) return;
    if (!RO.selMode && e.target.closest('.ro-shift')) return;   // a shift: open it, or drag it to another day (Ctrl: copy)
    // + : a click adds a shift; dragging from it to other days selects them (an empty day is mostly its + button)
    if (!RO.selMode && e.target.closest('.ro-add')) { if (!e.shiftKey) RB_DRAG = { base: e.ctrlKey || e.metaKey ? new Set(RO.sel) : new Set(), anchor: td.dataset.k, add: true, moved: false, done: paint }; return; }
    e.preventDefault();
    const k = td.dataset.k, ctrl = e.ctrlKey || e.metaKey;
    pick(k, { ctrl, shift: e.shiftKey });
    if (!e.shiftKey) RB_DRAG = { base: new Set([...RO.sel].filter(x => x !== k)), anchor: k, add: RO.sel.has(k), moved: false, done: paint };
  });
  grid.addEventListener('mouseover', e => {
    if (!RB_DRAG) return; if (!(e.buttons & 1)) { RB_DRAG = null; return; }
    const td = e.target.closest('.ro-cell'); if (!td || (td.dataset.k === RB_DRAG.anchor && !RB_DRAG.moved)) return;
    if (!RB_DRAG.moved) { RB_DRAG.moved = true; RO.anchor = RB_DRAG.anchor; }
    const r = rect(RB_DRAG.anchor, td.dataset.k);
    RO.sel = RB_DRAG.add ? new Set([...RB_DRAG.base, ...r]) : new Set([...RB_DRAG.base].filter(x => !r.includes(x)));
    paint();
  });
  // a shift with Ctrl / ⌘ / Shift held: select its day instead of opening it
  grid.addEventListener('click', e => {
    const c = e.target.closest('.ro-shift'); if (!c || RO.selMode || !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
    pick(c.closest('.ro-cell').dataset.k, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
  });
  // a name: their week; a day heading: everyone that day; Staff: everything
  $$('tbody th.ro-p', grid).forEach(th => th.onclick = e => { const u = th.closest('tr').dataset.row; group(W.days.map(d => `${u}|${d}`), e.ctrlKey || e.metaKey); });
  $$('thead th[data-col]', grid).forEach(th => th.onclick = e => { const d = th.dataset.col; group(rows().map(u => `${u}|${d}`), e.ctrlKey || e.metaKey); });
  const all = $('#ro-all', page);
  if (all) { all.onclick = e => e.stopPropagation(); all.onchange = () => { RO.sel = all.checked ? new Set(rows().flatMap(u => W.days.map(d => `${u}|${d}`))) : new Set(); paint(); }; all.indeterminate = RO.sel.size > 0 && !all.checked; }
  // the keyboard
  grid.addEventListener('keydown', e => {
    const td = e.target.closest('.ro-cell'); if (!td) return;
    const onChip = !!e.target.closest('.ro-shift'), k = td.dataset.k, [r, c] = pos(k), R = rows();
    const go = (rr, cc) => { rr = Math.max(0, Math.min(R.length - 1, rr)); cc = Math.max(0, Math.min(6, cc)); return `${R[rr]}|${W.days[cc]}`; };
    const mv = { ArrowUp: [r - 1, c], ArrowDown: [r + 1, c], ArrowLeft: [r, c - 1], ArrowRight: [r, c + 1], Home: [r, 0], End: [r, 6] }[e.key];
    if (mv) {
      e.preventDefault(); const n = go(...mv);
      if (e.shiftKey) { if (!RO.anchor) RO.anchor = k; RO.sel = new Set(rect(RO.anchor, n)); paint(); } else if (!RO.anchor || !RO.sel.size) RO.anchor = n;
      return setFocus(n);
    }
    if (onChip && (e.key === 'Enter' || (e.key === ' ' && !RO.selMode))) return;   // the shift opens (roster.js)
    if (e.key === ' ') { e.preventDefault(); return pick(k, { ctrl: true, shift: e.shiftKey }); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); RO.sel = new Set(R.flatMap(u => W.days.map(d => `${u}|${d}`))); return paint(); }
    if (e.key === 'Escape') return;   // selects nothing (the page's own key, above)
    if (e.key === 'Enter') {
      e.preventDefault();
      if (RO.sel.size) { const b = $('#ro-bulk button:not([disabled])', page); if (b) b.focus(); return; }
      const [u, d] = k.split('|'); return rosterEditor(W, { user_id: u ? +u : null, date: d });
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && RO.sel.size) { e.preventDefault(); rosterClearSel(W); }
  });
  grid.addEventListener('focusin', e => { const td = e.target.closest('.ro-cell'); if (td && e.target === td) setFocus(td.dataset.k, false); });
  // the phone's day cards (Select mode): tap a card
  $$('.ro-pcard[data-k]', page).forEach(cd => cd.addEventListener('click', e => {
    if (!RO.selMode || e.target.closest('.ro-pck')) return;
    e.preventDefault(); const k = cd.dataset.k; RO.sel.has(k) ? RO.sel.delete(k) : RO.sel.add(k); paint();
  }));
  $$('.ro-pck', page).forEach(ck => ck.onchange = () => { ck.checked ? RO.sel.add(ck.dataset.k) : RO.sel.delete(ck.dataset.k); paint(); });
  const pall = $('#ro-pall', page);
  if (pall) pall.onchange = () => { W.people.forEach(p => (pall.checked ? RO.sel.add(`${p.id}|${RO.day}`) : RO.sel.delete(`${p.id}|${RO.day}`))); paint(); };
  rosterBulkBarBind(W, page);
}

// ---- fill the week from usual weeks
function rosterFillModal(W) {
  const selPeople = [...new Set(rbCells().map(c => c.user_id).filter(Boolean))];
  const withUsual = W.people.filter(p => !p.former && (p.usual || []).length);
  const m = openModal(`<h2 style="font-size:1.35rem">Fill ${esc(W.label)} from usual weeks</h2>
    <p class="small muted" style="margin:-4px 0 12px">Each person's usual days and shifts go on this week. Leave already booked, people who have left (or haven't started), and days that already have a shift are skipped.</p>
    ${withUsual.length ? `<form id="rb-ff">
      ${selPeople.length ? `<fieldset class="ro-radios"><legend class="small muted">Who</legend>
        <label class="check"><input type="radio" name="who" value="all" checked> Everyone with a usual week (${withUsual.length})</label>
        <label class="check"><input type="radio" name="who" value="sel"> Only the ${rbPlural(selPeople.length, 'person', 'people')} selected on the grid</label></fieldset>` : ''}
      <label class="check"><input type="checkbox" name="replace"> Replace shifts already on those days</label>
      <div class="ro-fillprev" id="rb-fp" aria-live="polite"><span class="muted small">Working it out…</span></div>
      <div class="err"></div>
      <div class="actions"><button class="btn coral" id="rb-fgo" disabled>↻ Fill the week</button><button type="button" class="btn ghost" data-usual>Usual weeks…</button><button type="button" class="btn ghost" data-x>Cancel</button></div></form>`
      : `<div class="empty" style="padding:20px">Nobody has a usual week yet.<br><button type="button" class="btn sm coral" data-usual style="margin-top:10px">Set usual weeks…</button></div>`}`);
  m.el.style.maxWidth = '600px';
  if ($('[data-x]', m.el)) $('[data-x]', m.el).onclick = m.close;
  $$('[data-usual]', m.el).forEach(b => b.onclick = () => { m.close(); rosterUsualModal(W); });
  const F = $('#rb-ff', m.el); if (!F) return;
  const body = dry => ({ week: W.week_start, replace: F.replace.checked, dry_run: dry, user_ids: F.who && F.who.value === 'sel' ? selPeople : undefined });
  const prev = async () => {
    $('#rb-fgo', m.el).disabled = true;
    try {
      const r = await api('/api/staff/roster/fill-usual', { body: body(true) }), sk = r.skipped.filter(x => x.why !== 'already on the roster');
      const by = {}; for (const x of sk) (by[x.why] = by[x.why] || []).push(`${x.name} ${roDay(x.date)}`);
      $('#rb-fp', m.el).innerHTML = `<p style="margin:0"><b>${r.added ? `Adds ${rbPlural(r.added, 'shift')}` : 'Nothing to add'}</b>${r.removed ? `, replaces ${rbPlural(r.removed, 'shift')}` : ''} for ${rbPlural(r.people, 'person', 'people')}.</p>
        ${sk.length ? `<p class="small" style="margin:6px 0 0">Skips ${sk.length}: ${Object.entries(by).map(([w, a]) => `<b>${esc(w)}</b> (${a.slice(0, 6).map(esc).join(', ')}${a.length > 6 ? `, +${a.length - 6} more` : ''})`).join('; ')}.</p>` : ''}
        ${r.warnings.length ? `<p class="small" style="margin:6px 0 0">⚠ ${rbPlural(r.warnings.length, 'warning')} (saved anyway): ${r.warnings.slice(0, 3).map(w => `${esc(w.name)} ${esc(roDay(w.date))}: ${esc(w.text)}`).join('; ')}${r.warnings.length > 3 ? '…' : ''}</p>` : ''}
        ${r.no_usual.length ? `<p class="small muted" style="margin:6px 0 0">No usual week: ${r.no_usual.slice(0, 8).map(esc).join(', ')}${r.no_usual.length > 8 ? '…' : ''}.</p>` : ''}`;
      $('#rb-fgo', m.el).disabled = !(r.added || r.removed);
      $('#rb-fgo', m.el).textContent = r.added ? `↻ Add ${rbPlural(r.added, 'shift')}` : '↻ Fill the week';
    } catch (e) { $('#rb-fp', m.el).innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  };
  F.onchange = prev; prev();
  F.onsubmit = async e => {
    e.preventDefault(); $('#rb-fgo', m.el).disabled = true;
    try { const r = await api('/api/staff/roster/fill-usual', { body: body(false) }); m.close(); rosterDone(r, 'Filled from usual weeks'); }
    catch (err) { $('.err', F).innerHTML = `<div class="error">${esc(err.message)}</div>`; $('#rb-fgo', m.el).disabled = false; }
  };
}

// ---- shift templates: add, change, delete
function rosterTemplatesModal(W) {
  let T = (W.templates || []).slice(), colours = W.colours || [], editing = null, dirty = false;
  const m = openModal('<div id="rb-tm"></div>', { onClose: () => { if (dirty) renderRoster(); } });
  m.el.style.maxWidth = '640px';
  const draw = (err = '') => {
    const v = editing ? T.find(t => t.id === editing) : { name: '', start: W.normal_start, finish: W.normal_finish, break_min: roRuleBreak(roSpan(W.normal_start, W.normal_finish)), role: '', colour: colours[T.length % colours.length] || '' };
    $('#rb-tm', m.el).innerHTML = `<h2 style="font-size:1.35rem">Shift templates</h2>
      <p class="small muted" style="margin:-4px 0 12px">Your standard shifts. Pick one when adding a shift, put one on many days at once, or use them in each person's usual week. Changing one changes the usual weeks that use it (not shifts already on the roster).</p>
      <div class="ro-tlist">${T.map(t => `<div class="ro-trow${editing === t.id ? ' on' : ''}"><i class="ro-sw" style="--tc:${esc(t.colour)}" aria-hidden="true"></i><b>${esc(t.name)}</b>
        <span class="ro-tt">${esc(roTimes(t))}${t.break_min ? ` · ${t.break_min} min break` : ''}${t.role ? ` · ${esc(t.role)}` : ''}</span>
        <span class="ro-tact"><button type="button" class="btn sm ghost" data-te="${t.id}" aria-label="Change ${esc(t.name)}">Change</button><button type="button" class="btn sm ghost" data-td="${t.id}" aria-label="Delete ${esc(t.name)}">Delete</button></span></div>`).join('') || '<p class="small muted">No shift templates yet.</p>'}</div>
      <form class="ro-form ro-tform" id="rb-tf" novalidate><h3 class="ro-full" style="margin:0;font-size:1rem">${editing ? `Change ${esc(v.name)}` : 'Add a shift template'}</h3>
        <label class="ts-box"><span>Name</span><input name="name" maxlength="40" value="${esc(v.name)}" placeholder="e.g. Open, Close, Cafe early" required></label>
        <label class="ts-box"><span>Role or area</span><input name="role" list="ro-roles" maxlength="40" value="${esc(v.role)}" placeholder="Optional, e.g. Cafe"></label>
        <label class="ts-box"><span>Start</span><input type="time" name="start" value="${v.start}" required></label>
        <label class="ts-box"><span>Finish</span><input type="time" name="finish" value="${v.finish}" required></label>
        <label class="ts-box"><span>Unpaid break (min)</span><input type="number" name="break_min" min="0" max="240" step="5" value="${v.break_min}"></label>
        <fieldset class="ts-box ro-colours"><legend>Colour</legend><div>${colours.map(c => `<label class="ro-col" title="${c}"><input type="radio" name="colour" value="${c}" ${c === v.colour ? 'checked' : ''}><i style="--tc:${c}" aria-hidden="true"></i><span class="sr-only">${c}</span></label>`).join('')}</div></fieldset>
        <div class="err ro-full">${err ? `<div class="error">${esc(err)}</div>` : ''}</div>
        <div class="ro-full actions"><button class="btn coral">${editing ? 'Save' : '+ Add template'}</button>${editing ? '<button type="button" class="btn ghost" data-tc>Cancel</button>' : ''}</div></form>`;
    const F = $('#rb-tf', m.el);
    $$('[data-te]', m.el).forEach(b => b.onclick = () => { editing = +b.dataset.te; draw(); $('#rb-tf input[name=name]', m.el).focus(); });
    $$('[data-td]', m.el).forEach(b => b.onclick = async () => {
      const t = T.find(x => x.id === +b.dataset.td); if (!confirm(`Delete the shift template "${t.name}"? Shifts and usual weeks made from it keep their times.`)) return;
      try { T = (await api(`/api/staff/roster/templates/${t.id}`, { method: 'DELETE' })).templates; dirty = true; if (editing === t.id) editing = null; draw(); } catch (e) { draw(e.message); }
    });
    if ($('[data-tc]', m.el)) $('[data-tc]', m.el).onclick = () => { editing = null; draw(); };
    let touched = !!editing; F.break_min.oninput = () => { touched = true; };
    F.start.oninput = F.finish.oninput = () => { if (!touched && F.start.value && F.finish.value) F.break_min.value = roRuleBreak(roSpan(F.start.value, F.finish.value)); };
    F.onsubmit = async e => {
      e.preventDefault();
      const b = { name: F.name.value, start: F.start.value, finish: F.finish.value, break_min: +F.break_min.value || 0, role: F.role.value, colour: (F.querySelector('input[name=colour]:checked') || {}).value };
      try { const r = editing ? await api(`/api/staff/roster/templates/${editing}`, { method: 'PUT', body: b }) : await api('/api/staff/roster/templates', { body: b }); T = r.templates; dirty = true; editing = null; draw(); toast(`Shift template ${b.name} saved`); }
      catch (err) { draw(err.message); }
    };
  };
  draw();
}

// ---- usual weeks: a grid of people × days, each day off, a template, or typed times
async function rosterUsualModal(W) {
  let D; try { D = await api(`/api/staff/roster/patterns?week=${W.week_start}`); } catch (e) { return toast(e.message, 5000); }
  const T = D.templates, days = W.days.map(d => new Date(d + 'T00:00:00Z').getUTCDay());
  const model = new Map(D.people.map(p => [p.id, new Map(p.usual.map(x => [x.dow, { ...x }]))]));
  const label = x => { const t = x.template_id && T.find(y => y.id === x.template_id); return t ? t.name : roTimes(x); };
  const sel = (p, dw) => { const x = model.get(p.id).get(dw), custom = x && !x.template_id;
    return `<select data-p="${p.id}" data-dw="${dw}" aria-label="${esc(`${p.name}, ${RB_DOW[dw]}`)}" class="${x ? 'on' : ''}" ${x && x.template_id ? `style="--tc:${esc((T.find(t => t.id === x.template_id) || {}).colour || '')}"` : ''}>
      <option value="">Off</option>${T.map(t => `<option value="t${t.id}" ${x && x.template_id === t.id ? 'selected' : ''} title="${esc(roTimes(t))}">${esc(t.name)}</option>`).join('')}
      ${custom ? `<option value="c" selected>${esc(label(x))}</option>` : ''}<option value="new">Type times…</option></select>`; };
  let dirty = false;
  const m = openModal(`<h2 style="font-size:1.35rem">Usual weeks</h2>
    <p class="small muted" style="margin:-4px 0 8px">Each person's standard days and shifts. <b>↻ Fill from usual weeks</b> puts them on a week in one go. Choose a shift template, or "Type times…".</p>
    <p class="ro-ukey small">${T.map(t => `<span><i class="ro-sw" style="--tc:${esc(t.colour)}" aria-hidden="true"></i><b>${esc(t.name)}</b> ${esc(roTimes(t))}</span>`).join('')}</p>
    <div class="scroll ro-uwrap"><table class="t ro-utable"><thead><tr><th>Staff</th>${days.map(dw => `<th>${RB_DOW[dw]}</th>`).join('')}<th class="r">Hours</th></tr></thead>
      <tbody>${D.people.map(p => `<tr data-row="${p.id}"><td data-l=""><b>${esc(p.name)}</b>${p.position ? `<div class="small muted">${esc(p.position)}</div>` : ''}</td>${days.map(dw => `<td data-l="${RB_DOW[dw]}">${sel(p, dw)}</td>`).join('')}<td class="r" data-l="Hours" data-h="${p.id}"></td></tr>`).join('') || `<tr><td colspan="9" class="muted">Nobody on the time clock yet.</td></tr>`}</tbody></table></div>
    <div class="err"></div>
    <div class="actions"><button type="button" class="btn coral" id="rb-us">Save usual weeks</button>
      <button type="button" class="btn ghost" id="rb-uw" title="Each person's shifts on ${esc(W.label)} become their usual week">Copy from this week's roster</button><button type="button" class="btn ghost" data-x>Cancel</button></div>`, { wide: true, onClose: () => { if (dirty) renderRoster(); } });
  m.el.classList.add('ro-xwide');
  const hours = () => D.people.forEach(p => { const td = $(`[data-h="${p.id}"]`, m.el); if (!td) return; const h = [...model.get(p.id).values()].reduce((t, x) => t + Math.max(0, roSpan(x.start, x.finish) - (+x.break_min || 0)) / 60, 0); td.textContent = h ? h.toFixed(2) : '—'; });
  hours();
  $('[data-x]', m.el).onclick = m.close;
  const mark = s => { const x = model.get(+s.dataset.p).get(+s.dataset.dw); s.classList.toggle('on', !!x); s.style.setProperty('--tc', x && x.template_id ? (T.find(t => t.id === x.template_id) || {}).colour || '' : ''); hours(); };
  const back = (s, x) => { s.value = x ? (x.template_id ? `t${x.template_id}` : 'c') : ''; };
  $$('select[data-p]', m.el).forEach(s => s.onchange = async () => {
    const pm = model.get(+s.dataset.p), dw = +s.dataset.dw, v = s.value, prevX = pm.get(dw);
    if (v === '') pm.delete(dw);
    else if (v[0] === 't') { const t = T.find(x => x.id === +v.slice(1)); pm.set(dw, { dow: dw, template_id: t.id, start: t.start, finish: t.finish, break_min: t.break_min, role: t.role }); }
    else if (v === 'new') {
      const p = D.people.find(x => x.id === +s.dataset.p);
      const x = await rbAskTimes(`${p.name}, ${RB_DOW[dw]}`, prevX || { start: W.normal_start, finish: W.normal_finish, break_min: roRuleBreak(roSpan(W.normal_start, W.normal_finish)), role: '' });
      if (!x) { back(s, prevX); return; }
      pm.set(dw, { dow: dw, template_id: null, ...x });
      const old = s.querySelector('option[value="c"]'); if (old) old.parentNode.removeChild(old);
      const o = document.createElement('option'); o.value = 'c'; o.textContent = label(pm.get(dw)); s.insertBefore(o, s.querySelector('option[value="new"]')); s.value = 'c';
    }
    mark(s);
  });
  $('#rb-us', m.el).onclick = async () => {
    try {
      const r = await api('/api/staff/roster/patterns', { method: 'PUT', body: { people: D.people.map(p => ({ user_id: p.id, days: [...model.get(p.id).values()].map(x => (x.template_id ? { dow: x.dow, template_id: x.template_id, role: x.role } : x)) })) } });
      dirty = true; m.close(); toast(`Usual weeks saved (${rbPlural(r.saved.filter(x => x.days).length, 'person', 'people')})`);
    } catch (e) { $('.err', m.el).innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  };
  $('#rb-uw', m.el).onclick = async () => {
    if (!confirm(`Make each person's shifts on ${W.label} their usual week? (People with no shifts that week keep theirs.)`)) return;
    try { const r = await api('/api/staff/roster/patterns/from-week', { body: { week: W.week_start } }); dirty = true; m.close(); toast(`Usual weeks set from this week for ${rbPlural(r.saved.length, 'person', 'people')}`); rosterUsualModal(W); }
    catch (e) { $('.err', m.el).innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  };
}
/** a small window for typed times (start, finish, break, role) → { start, finish, break_min, role } or null */
function rbAskTimes(title, v) {
  return new Promise(resolve => {
    let done = false;
    const m = openModal(`<h2 style="font-size:1.2rem">${esc(title)}</h2><form class="ro-form" novalidate>
      <label class="ts-box"><span>Start</span><input type="time" name="start" value="${v.start}" required></label><label class="ts-box"><span>Finish</span><input type="time" name="finish" value="${v.finish}" required></label>
      <label class="ts-box"><span>Unpaid break (min)</span><input type="number" name="break_min" min="0" max="240" step="5" value="${+v.break_min || 0}"></label><label class="ts-box"><span>Role or area</span><input name="role" list="ro-roles" maxlength="40" value="${esc(v.role || '')}"></label>
      <div class="err ro-full"></div><div class="ro-full actions"><button class="btn coral">OK</button><button type="button" class="btn ghost" data-x>Cancel</button></div></form>`, { onClose: () => { if (!done) resolve(null); } });
    m.el.style.maxWidth = '440px';
    const F = $('form', m.el); $('[data-x]', m.el).onclick = m.close;
    F.onsubmit = e => {
      e.preventDefault();
      const x = { start: F.start.value, finish: F.finish.value, break_min: +F.break_min.value || 0, role: F.role.value.trim() };
      if (!x.start || !x.finish || x.start === x.finish) { $('.err', F).innerHTML = '<div class="error">Enter the start and finish.</div>'; return; }
      if (x.break_min >= roSpan(x.start, x.finish)) { $('.err', F).innerHTML = '<div class="error">The break is as long as the shift.</div>'; return; }
      done = true; m.close(); resolve(x);
    };
  });
}

// ---- import shifts from a CSV file: choose or paste, preview (matches, problems), save
function rosterImportModal(W) {
  let text = '', P = null, onlyProblems = false;
  const m = openModal('<div id="rb-im"></div>', { wide: true });
  m.el.classList.add('ro-xwide');
  const step1 = (err = '') => {
    $('#rb-im', m.el).innerHTML = `<h2 style="font-size:1.35rem">Import shifts from a file</h2>
      <ol class="small ro-steps"><li><a href="/api/staff/roster/import-template.csv" download="roster-import-template.csv">Download the template</a> and open it in Excel (or Google Sheets).</li>
        <li>One line per shift: <b>Name</b> (or <b>Employee no.</b>), <b>Date</b>, <b>Start</b>, <b>Finish</b>, and if you like <b>Break (min)</b>, <b>Role</b>, <b>Note</b>. Dates like 30/11/2026, times like 7:00 or 7am. Leave the name empty (or write Open) for an open shift.</li>
        <li>Save it as <b>CSV</b>, choose it here, and check the preview. Nothing is saved until you press Save.</li></ol>
      <div class="ro-imp"><label class="btn ghost file-btn">📄 Choose a CSV file…<input type="file" id="rb-file" accept=".csv,.txt,text/csv" hidden></label><span class="small muted" id="rb-fname">${text ? 'File ready' : 'or paste the lines below'}</span></div>
      <textarea id="rb-paste" class="ro-text" rows="6" placeholder="Name,Date,Start,Finish,Break (min),Role,Note&#10;Ana Tuilagi,30/11/2026,7:00,15:00,30,Cafe,">${esc(text)}</textarea>
      <label class="check small"><input type="checkbox" id="rb-rep"> Replace shifts already on those days (only the people and days in the file)</label>
      <div class="err">${err ? `<div class="error">${esc(err)}</div>` : ''}</div>
      <div class="actions"><button type="button" class="btn coral" id="rb-prev">Preview</button><button type="button" class="btn ghost" data-x>Cancel</button></div>`;
    $('[data-x]', m.el).onclick = m.close;
    $('#rb-file', m.el).onchange = async e => { const f = e.target.files[0]; if (!f) return; if (f.size > 2e6) return step1('That file is too big (2 MB at most).'); text = await f.text(); $('#rb-paste', m.el).value = text; $('#rb-fname', m.el).textContent = f.name; };
    $('#rb-prev', m.el).onclick = async () => {
      text = $('#rb-paste', m.el).value; const replace = $('#rb-rep', m.el).checked;
      if (!text.trim()) return step1('Choose a file, or paste the lines.');
      try { P = await api('/api/staff/roster/import/preview', { body: { csv: text, replace } }); P.replace = replace; step2(); } catch (e) { step1(e.message); }
    };
  };
  const ST = { ok: ['ok', 'Ready'], warn: ['warn', 'Ready, check'], skip: ['skip', 'Skipped'], error: ['err', 'Problem'] };
  const step2 = (err = '') => {
    const c = P.counts, good = c.ok + c.warn, rows = P.lines.filter(l => !onlyProblems || l.status !== 'ok');
    $('#rb-im', m.el).innerHTML = `<h2 style="font-size:1.35rem">Check the shifts before saving</h2>
      <div class="ro-impsum"><span class="ro-pill ok">${c.ok} ready</span>${c.warn ? `<span class="ro-pill warn">${c.warn} to check</span>` : ''}${c.skip ? `<span class="ro-pill skip">${c.skip} skipped</span>` : ''}${c.error ? `<span class="ro-pill err">${c.error} with a problem</span>` : ''}
        <span class="small muted">${P.weeks.length ? `Weeks: ${P.weeks.map(w => esc(w.label)).join(', ')}` : ''}${P.replace && P.removed ? ` · replaces ${rbPlural(P.removed, 'shift')}` : ''}</span>
        <label class="check small ro-onlyp"><input type="checkbox" id="rb-only" ${onlyProblems ? 'checked' : ''}> Only lines to check</label></div>
      <div class="scroll ro-impwrap"><table class="t ro-imptable"><thead><tr><th class="r">Line</th><th>Person</th><th>Date</th><th>Time</th><th class="r">Break</th><th>Role · note</th><th>Status</th></tr></thead>
        <tbody>${rows.map(l => `<tr class="st-${ST[l.status][0]}"><td class="r" data-l="Line">${l.line}</td><td data-l="Person"><b>${esc(l.name || l.person || '—')}</b>${l.name && l.person && l.name !== l.person && l.name !== 'Open shift' ? ` <span class="small muted">(${esc(l.person)})</span>` : ''}</td>
          <td data-l="Date">${l.date ? esc(roDay(l.date)) : '<span class="none">—</span>'}</td><td data-l="Time">${l.start && l.finish ? esc(roTimes(l)) : '<span class="none">—</span>'}</td><td class="r" data-l="Break">${l.break_min ? `${l.break_min} min` : '<span class="none">—</span>'}</td>
          <td data-l="Role · note"><span class="ell" title="${esc([l.role, l.note].filter(Boolean).join(' · '))}">${esc([l.role, l.note].filter(Boolean).join(' · ')) || '<span class="none">—</span>'}</span></td>
          <td class="wrap" data-l="Status"><span class="ro-pill ${ST[l.status][0]}">${ST[l.status][1]}</span> <span class="small">${esc([...l.errors, ...(l.skip ? [l.skip] : []), ...l.warnings].join('; '))}</span></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Every line is ready.</td></tr>'}</tbody></table></div>
      <div class="err">${err ? `<div class="error">${esc(err)}</div>` : ''}</div>
      <div class="actions"><button type="button" class="btn coral" id="rb-save" ${good ? '' : 'disabled'}>Save ${rbPlural(good, 'shift')}</button><button type="button" class="btn ghost" id="rb-back">← Change the file</button><span class="small muted">${c.error + c.skip ? `Lines with a problem or skipped aren't saved.` : ''} Saved shifts are a draft until you publish.</span></div>`;
    $('#rb-only', m.el).onchange = e => { onlyProblems = e.target.checked; step2(); };
    $('#rb-back', m.el).onclick = () => step1();
    $('#rb-save', m.el).onclick = async () => {
      $('#rb-save', m.el).disabled = true;
      try {
        const r = await api('/api/staff/roster/import', { body: { csv: text, replace: P.replace } }); m.close();
        const wk = r.weeks.includes(RO.week) || !r.weeks.length ? {} : { week: r.weeks[0], day: r.weeks[0] };
        rosterDone(r, 'Imported from the file', wk);
      } catch (e) { step2(e.message); }
    };
  };
  step1();
}

// ---- copy this week to the next 1–12 weeks
function rosterCopyNModal(W) {
  const n0 = W.totals.shifts + W.totals.open;
  const m = openModal(`<h2 style="font-size:1.35rem">Copy this week to the next weeks</h2>
    <p class="small muted" style="margin:-4px 0 12px">${esc(W.label)}: ${rbPlural(n0, 'shift')}, the same people, days, times, roles and notes. People who have left, have leave booked that day, or already have the same shift are skipped.</p>
    ${n0 ? `<form id="rb-cn"><label class="ts-box" style="max-width:240px"><span>How many weeks</span><select name="n">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i === 3 ? 'selected' : ''}>${rbPlural(i + 1, 'week')}</option>`).join('')}</select></label>
      <p class="small" id="rb-cnw" style="margin:8px 0"></p>
      <label class="check"><input type="checkbox" name="replace"> Replace the shifts already on those weeks</label>
      <div class="err"></div><div class="actions"><button class="btn coral">⧉ Copy</button><button type="button" class="btn ghost" data-x>Cancel</button></div></form>`
      : '<div class="empty" style="padding:20px">There are no shifts on this week to copy.</div>'}`);
  m.el.style.maxWidth = '540px';
  const F = $('#rb-cn', m.el); if (!F) return;
  $('[data-x]', m.el).onclick = m.close;
  const wl = () => { const n = +F.n.value, a = addDays(W.week_start, 7), b = addDays(W.week_start, 7 * n + 6); $('#rb-cnw', m.el).innerHTML = `Into <b>${esc(QE.period(a, b, false))}</b>${n > 1 ? ` (${n} weeks)` : ''}.`; };
  F.n.onchange = wl; wl();
  F.onsubmit = async e => {
    e.preventDefault();
    try { const r = await api('/api/staff/roster/copy-weeks', { body: { week: W.week_start, weeks: +F.n.value, replace: F.replace.checked } }); m.close(); rosterDone(r, `Copied to the next ${rbPlural(+F.n.value, 'week')}`); }
    catch (err) { $('.err', F).innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  };
}
