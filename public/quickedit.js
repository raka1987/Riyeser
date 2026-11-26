// OWNER-QUICKEDIT (Payroll 2.2.5): change a day's hours right where they're shown.
//  - Timesheets "By person" cards and the pay run's person panel list each shift as a line. Click (or Enter) opens it
//    in place: start and finish, the unpaid break the payroll rules take off, Save / Cancel (Enter saves, Esc cancels).
//  - The bin deletes, with a confirm in the line itself. Deleting needs Full access to Timesheets, as before.
//  - Paid days (a finalised pay run has a payslip for them) are locked and say why; the server refuses them too.
//  - personPanel(): a side panel with one person's days in a pay period, each editable the same way, and an "Add" on
//    the days with no hours. The totals update as you type and again from the server after each save.
// Uses the page's helpers (common.js) and S, L, canTS from staff.js. The server checks every change.
const QE = (() => {
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dow = d => DOW[new Date(d + 'T00:00:00Z').getUTCDay()];
  const dayShort = d => `${dow(d)} ${+d.slice(8)}`;                       // Thu 19
  const dayLong = d => `${dayShort(d)} ${MON[+d.slice(5, 7) - 1]}`;       // Thu 19 Nov
  /** "Thu 19 – Wed 25 Nov 2026", "Thu 26 Nov – Wed 2 Dec 2026", "Thu 31 Dec 2026 – Wed 6 Jan 2027" */
  const period = (a, b, year = true) => {
    if (!a || !b) return '';
    const y = year ? ` ${b.slice(0, 4)}` : '';
    if (a.slice(0, 4) !== b.slice(0, 4)) return `${dayLong(a)}${year ? ` ${a.slice(0, 4)}` : ''} – ${dayLong(b)}${y}`;
    return a.slice(0, 7) === b.slice(0, 7) ? `${dayShort(a)} – ${dayLong(b)}${y}` : `${dayLong(a)} – ${dayLong(b)}${y}`;
  };
  const days = (a, b) => { const out = []; for (let d = a; d <= b && out.length < 62; d = addDays(d, 1)) out.push(d); return out; };
  const mins = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const spanH = (a, b) => { let m = mins(b) - mins(a); if (m <= 0) m += 1440; return m / 60; };
  const rules = () => { try { return (JSON.parse(S.payroll_breaks || '[]') || []).filter(r => +r.after_hours > 0 && +r.minutes > 0); } catch { return []; } };
  /** the unpaid break for a shift of h hours (the biggest rule that applies), in hours */
  const breakH = h => { const r = rules().filter(x => h > +x.after_hours).sort((x, y) => y.minutes - x.minutes)[0]; return r ? Math.min(h, r.minutes / 60) : 0; };
  const stamps = (d, a, b) => ({ clock_in: `${d}T${a}`, clock_out: b ? `${b <= a ? addDays(d, 1) : d}T${b}` : '' });
  const paidH = r => r.clock_out ? (r.paid_hours ?? r.hours) : 0;
  const ICON = {
    edit: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zm17.7-10.2a1 1 0 0 0 0-1.42l-2.33-2.33a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    bin: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9z"/></svg>',
    tick: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  };
  const canEdit = r => canTS() && !r.paid_run_id;
  const canDelete = r => L('timesheets') >= 3 && !r.paid_run_id;
  const hoursText = r => !r.clock_out ? '' : `<b>${paidH(r).toFixed(2)}</b>h`;
  const hoursTitle = r => !r.clock_out ? 'Still clocked in' : r.break_hours ? `${r.hours.toFixed(2)} h worked − ${Math.round(r.break_hours * 60)} min unpaid break = ${paidH(r).toFixed(2)} h paid` : `${r.hours.toFixed(2)} h paid`;
  const flag = r => !r.clock_out ? 'still clocked in' : r.hours > 12 ? 'over 12 h: forgot to clock out?' : r.hours < 0.25 ? 'under 15 min' : '';

  /** One shift as a line. date: show the day (off in the panel, which has the day on the left). */
  function lineHTML(r, { date = true } = {}) {
    const ed = canEdit(r), paid = !!r.paid_run_id, f = flag(r);
    const state = paid ? `<span class="ql-i ql-lock" title="Paid in pay run #${r.paid_run_id}">${ICON.lock}</span>`
      : r.approved_by ? `<span class="ql-i ql-ok" title="Approved by ${esc(r.approved_by_name || '')}">${ICON.tick}</span>` : ed ? `<span class="ql-i ql-pen">${ICON.edit}</span>` : '<span class="ql-i"></span>';
    return `<div class="ql${ed ? ' tap' : ''}${paid ? ' paid' : ''}${date ? '' : ' nodate'}" data-qid="${r.id}" ${ed || paid ? `tabindex="0" role="button" aria-label="${ed ? 'Change' : 'Paid:'} ${esc(dayLong(r.clock_in.slice(0, 10)))} ${esc(fmtTime(r.clock_in.slice(11, 16)))}"` : ''}>
      ${date ? `<span class="ql-d">${dayShort(r.clock_in.slice(0, 10))}</span>` : ''}
      <span class="ql-t">${fmtTime(r.clock_in.slice(11, 16))}–${r.clock_out ? fmtTime(r.clock_out.slice(11, 16)) : '…'}</span>
      <span class="ql-h" title="${esc(hoursTitle(r))}">${hoursText(r)}</span>${state}
      ${canDelete(r) ? `<button type="button" class="ql-bin" title="Delete this shift" aria-label="Delete this shift">${ICON.bin}</button>` : '<span></span>'}
      ${f ? `<div class="ql-wide"><span class="ts-flag">${f}</span></div>` : ''}${r.notes ? `<div class="ql-wide small muted">${esc(r.notes)}</div>` : ''}</div>`;
  }

  /** The start / finish editor (in a line, or on an empty day in the panel). */
  function editorHTML({ d, a, b, label, saveText = 'Save' }) {
    return `<form class="ql-form" novalidate>
      ${label === '' ? '' : `<span class="ql-d">${label || dayShort(d)}</span>`}
      <label class="ql-in"><span>Start</span><input type="time" name="a" value="${a}" required></label>
      <label class="ql-in"><span>Finish</span><input type="time" name="b" value="${b}"></label>
      <div class="ql-btns"><button class="btn sm">${saveText}</button><button type="button" class="btn sm ghost ql-cancel">Cancel</button></div>
      <div class="ql-live small"></div><div class="ql-err"></div></form>`;
  }
  /** live: "8.00 h worked · 30 min unpaid break · 7.50 h paid" */
  function liveText(F) {
    const a = F.a.value, b = F.b.value;
    if (!a) return { text: 'Enter the start time.', paid: null };
    if (!b) return { text: 'No finish: still clocked in (not paid until there is one).', paid: 0 };
    const h = spanH(a, b), br = breakH(h), p = h - br;
    return { text: `${h.toFixed(2)} h worked${br ? ` · ${Math.round(br * 60)} min unpaid break` : ''} · <b>${p.toFixed(2)} h paid</b>${b <= a ? ' · finishes the next day' : ''}${h > 16 ? ' · <span class="ts-flag">over 16 hours: check the times</span>' : ''}`, paid: p };
  }
  function wireEditor(host, { onSave, onCancel, onDraft, more }) {
    const F = $('form', host);
    const live = () => { const l = liveText(F); $('.ql-live', F).innerHTML = l.text; if (onDraft) onDraft(l.paid); };
    F.a.oninput = F.b.oninput = live; live();
    F.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } });
    $('.ql-cancel', F).onclick = onCancel;
    if (more) { const m = document.createElement('button'); m.type = 'button'; m.className = 'btn sm ghost ql-more'; m.textContent = 'More…'; m.title = 'Notes and approval'; m.onclick = more; $('.ql-btns', F).appendChild(m); }
    F.onsubmit = async e => {
      e.preventDefault();
      if (F.dataset.busy) return;
      if (!F.a.value) { $('.ql-err', F).innerHTML = '<div class="error">Enter the start time.</div>'; F.a.focus(); return; }
      F.dataset.busy = '1'; $$('button', F).forEach(x => { x.disabled = true; });
      try { await onSave(F.a.value, F.b.value); }
      catch (err) { $('.ql-err', F).innerHTML = `<div class="error">${esc(err.message)}</div>`; delete F.dataset.busy; $$('button', F).forEach(x => { x.disabled = false; }); }
    };
    setTimeout(() => { try { F.a.focus(); } catch { } }, 20);
    return F;
  }

  let OPEN = null;   // the one editor open at a time: { close }
  const closeOpen = () => { if (OPEN) { const o = OPEN; OPEN = null; o.close(); } };

  /**
   * Make the lines in `container` editable. rows: the shifts shown (or a function that returns them). onChanged(): after a save or delete (redraw).
   * onDraft(row, paidHours|null): while typing (live totals). more(row): the full shift dialog (notes, approval).
   */
  function bind(container, rows, { onChanged = async () => {}, onDraft, more } = {}) {
    const find = el => (typeof rows === 'function' ? rows() : rows).find(r => String(r.id) === el.dataset.qid);
    const open = (line, r) => {
      closeOpen();
      const html = line.innerHTML, cls = line.className;
      const restore = () => { line.innerHTML = html; line.className = cls; if (onDraft) onDraft(r, null); };
      const nodate = line.classList.contains('nodate');
      line.className = `ql editing${nodate ? ' nodate' : ''}`;
      line.innerHTML = editorHTML({ d: r.clock_in.slice(0, 10), a: r.clock_in.slice(11, 16), b: r.clock_out ? r.clock_out.slice(11, 16) : '', label: nodate ? '' : undefined });
      OPEN = { close: restore };
      wireEditor(line, {
        onCancel: () => { OPEN = null; restore(); line.focus(); },
        onDraft: p => onDraft && onDraft(r, p),
        more: more && (() => { OPEN = null; restore(); more(r); }),
        onSave: async (a, b) => {
          const s = stamps(r.clock_in.slice(0, 10), a, b);
          await api(`/api/staff/timesheets/${r.id}`, { method: 'PUT', body: { ...s, notes: r.notes || '' } });
          OPEN = null; toast('Shift saved'); await onChanged();
        },
      });
    };
    const confirmDelete = (line, r) => {
      closeOpen();
      const html = line.innerHTML, cls = line.className;
      const restore = () => { line.innerHTML = html; line.className = cls; };
      line.className = 'ql confirming';
      line.innerHTML = `<div class="ql-confirm" role="alertdialog"><span>Delete <b>${esc(dayLong(r.clock_in.slice(0, 10)))}, ${fmtTime(r.clock_in.slice(11, 16))}–${r.clock_out ? fmtTime(r.clock_out.slice(11, 16)) : '…'}</b>${r.clock_out ? ` (${paidH(r).toFixed(2)}&nbsp;h)` : ''}?</span>
        <div class="ql-btns"><button type="button" class="btn sm danger ql-yes">Delete</button><button type="button" class="btn sm ghost ql-no">Keep</button></div><div class="ql-err"></div></div>`;
      OPEN = { close: restore };
      const box = $('.ql-confirm', line);
      box.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); OPEN = null; restore(); } });
      $('.ql-no', line).onclick = () => { OPEN = null; restore(); };
      $('.ql-yes', line).onclick = async () => {
        $$('button', line).forEach(x => { x.disabled = true; });
        try { await api(`/api/staff/timesheets/${r.id}`, { method: 'DELETE' }); OPEN = null; toast('Shift deleted'); await onChanged(); }
        catch (err) { $('.ql-err', line).innerHTML = `<div class="error">${esc(err.message)}</div>`; $$('button', line).forEach(x => { x.disabled = false; }); }
      };
      $('.ql-no', line).focus();
    };
    const why = (line, r) => {
      let w = $('.ql-why', line);
      if (w) { w.remove(); return; }
      line.insertAdjacentHTML('beforeend', `<div class="ql-wide ql-why">${ICON.lock} Paid in pay run #${r.paid_run_id}, so this day can't be changed. To change it, delete that pay run first (Payroll → Past pay runs).</div>`);
    };
    const act = (e, line) => {
      if (!line || line.classList.contains('editing') || line.classList.contains('confirming')) return;
      const r = find(line); if (!r) return;
      if (e.target.closest('.ql-bin')) { e.stopPropagation(); return confirmDelete(line, r); }
      if (r.paid_run_id) return why(line, r);
      if (canEdit(r)) open(line, r);
    };
    container.addEventListener('click', e => { const line = e.target.closest('.ql[data-qid]'); if (line && container.contains(line)) act(e, line); });
    container.addEventListener('keydown', e => {
      const line = e.target.closest('.ql[data-qid]');
      if (line && e.target === line && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); act(e, line); }
    });
  }

  /** "+ Add" on an empty day: the same editor, saved as a new shift for user_id. */
  function bindAdd(container, { user_id, onChanged = async () => {}, onDraft }) {
    container.addEventListener('click', e => {
      const slot = e.target.closest('[data-qadd]'); if (!slot || slot.classList.contains('editing')) return;
      closeOpen();
      const d = slot.dataset.qadd, html = slot.innerHTML, cls = slot.className;
      const restore = () => { slot.innerHTML = html; slot.className = cls; if (onDraft) onDraft(null, null); };
      slot.className = 'ql editing nodate';
      slot.innerHTML = editorHTML({ d, a: S.normal_start || '09:00', b: S.normal_finish || '17:00', label: '', saveText: 'Add' });
      OPEN = { close: restore };
      wireEditor(slot, {
        onCancel: () => { OPEN = null; restore(); },
        onDraft: p => onDraft && onDraft({ id: 'new' }, p),
        onSave: async (a, b) => { await api('/api/staff/timesheets', { body: { user_id, ...stamps(d, a, b) } }); OPEN = null; toast('Hours added'); await onChanged(); },
      });
    });
  }

  /**
   * Side panel: one person's days in a pay period.
   * summary(): the person's pay run line (hours, base, gross, net), or null. onChanged(): re-work the pay run and return
   * the person's new line. more(row): the full shift dialog.
   */
  async function personPanel({ user_id, name, sub = '', start, end, line = null, onChanged = async () => null, more, onClose }) {
    closeOpen();
    document.querySelectorAll('.qp-bg').forEach(x => x.remove());
    const bg = document.createElement('div'); bg.className = 'qp-bg';
    bg.innerHTML = `<aside class="qp" role="dialog" aria-modal="true" aria-label="${esc(name)}'s days">
      <div class="qp-head"><div><div class="qp-k">Days in this pay run</div><h2>${esc(name)}</h2><div class="small muted">${esc(sub)}${sub ? ' · ' : ''}${esc(period(start, end))}</div></div>
        <button type="button" class="x qp-x" aria-label="Close">×</button></div>
      <div class="qp-sum"></div><div class="qp-days"><p class="small muted">Loading…</p></div>
      <p class="small muted qp-help">Click a time to change it (Enter saves, Esc cancels). Days with no hours have an <b>Add</b>. ${L('timesheets') >= 3 ? 'The bin deletes a shift.' : ''} Paid days are locked.</p></aside>`;
    document.body.appendChild(bg);
    const P = $('.qp', bg);
    let rows = [], draft = null;
    const close = () => { closeOpen(); bg.remove(); document.removeEventListener('keydown', key); onClose && onClose(); };
    const key = e => { if (e.key === 'Escape' && !e.defaultPrevented && !OPEN) close(); };
    document.addEventListener('keydown', key);
    bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
    $('.qp-x', P).onclick = close;
    const sum = () => {
      let paid = rows.reduce((a, r) => a + paidH(r), 0);
      const dayN = new Set(rows.filter(r => r.clock_out).map(r => r.clock_in.slice(0, 10))).size;
      if (draft && draft.p != null) paid += draft.p - (draft.id === 'new' ? 0 : paidH(rows.find(r => r.id === draft.id) || {}));
      const ln = line, rate = ln && ln.pay_type === 'hourly' && !ln.hours_adjusted ? ln.pay_rate : 0, drafting = draft && draft.p != null;
      $('.qp-sum', P).innerHTML = `<div><span>Days</span><b>${dayN}</b></div><div class="${drafting ? 'qp-draft' : ''}"><span>Paid hours</span><b>${paid.toFixed(2)}</b></div>
        ${ln ? `<div class="${drafting && rate ? 'qp-draft' : ''}"><span>Base pay</span><b>${money(drafting && rate ? Math.round(paid * rate * 100) / 100 : ln.base_pay, cur())}</b></div><div><span>Net pay</span><b>${money(ln.net, cur())}</b></div>` : ''}
        ${drafting ? `<div class="qp-wide qp-note small">If you save this: <b>${paid.toFixed(2)} h</b>${rate ? `, base pay <b>${money(Math.round(paid * rate * 100) / 100, cur())}</b>` : ''}. Tax, FNPF and net pay are worked out again when you save.</div>` : ''}
        ${ln && ln.hours_adjusted ? `<div class="qp-wide small" style="color:var(--gold)">The pay run's hours were changed to ${ln.hours.toFixed(2)} by hand (${esc(ln.hours_note)}), so timesheet changes don't change this pay until that is cleared.</div>` : ''}`;
    };
    const draw = () => {
      const list = days(start, end), by = {};
      rows.forEach(r => (by[r.clock_in.slice(0, 10)] = by[r.clock_in.slice(0, 10)] || []).push(r));
      const editable = canTS();
      $('.qp-days', P).innerHTML = list.map(d => {
        const rs = (by[d] || []).sort((a, b) => a.clock_in.localeCompare(b.clock_in)), we = ['Sat', 'Sun'].includes(dow(d));
        return `<div class="qp-day${rs.length ? '' : ' none'}${we ? ' we' : ''}"><div class="qp-dl">${dayShort(d)}</div><div class="qp-lines">
          ${rs.map(r => lineHTML(r, { date: false })).join('')}
          ${!rs.length ? (editable ? `<div class="ql ql-add" data-qadd="${d}" tabindex="0" role="button"><span class="muted">No hours</span><span class="ql-addb">+ Add</span></div>` : '<div class="ql nodate"><span class="muted">No hours</span></div>') : ''}</div></div>`;
      }).join('');
      sum();
    };
    const load = async () => { rows = await api(`/api/staff/timesheets?user_id=${user_id}&from=${start}&to=${end}`); draft = null; draw(); };
    const changed = async () => { const l = await onChanged(); if (l !== undefined) line = l; await load(); };
    const days$ = $('.qp-days', P);
    bind(days$, () => rows, {
      onChanged: changed, more,
      onDraft: (r, p) => { draft = r && p != null ? { id: r.id, p } : null; sum(); },
    });
    bindAdd(days$, { user_id, onChanged: changed, onDraft: (r, p) => { draft = r && p != null ? { id: 'new', p } : null; sum(); } });
    days$.addEventListener('keydown', e => { const s = e.target.closest('[data-qadd]'); if (s && e.target === s && e.key === 'Enter') { e.preventDefault(); s.click(); } });
    try { await load(); } catch (e) { $('.qp-days', P).innerHTML = `<div class="error">${esc(e.message)}</div>`; }
    setTimeout(() => { try { $('.qp-x', P).focus(); } catch { } }, 30);
    return { close, reload: load };
  }

  return { lineHTML, bind, bindAdd, personPanel, period, dayShort, dayLong, days, closeOpen };
})();
