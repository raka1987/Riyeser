// OWNER-LISTS (Payroll 2.3.2, tidied in 2.3.3): one way to sort and filter every list (Staff, Timesheets, Pay runs, Payslips, Leave,
// Audit trail, Time clock, Roster). Click a column heading to sort (again to reverse); the filter bar has Search, Year
// (financial year from Settings, and calendar year), Period (this / last pay period, this month, this / last financial
// year, custom dates), Status and more where the list has them, "Clear filters" and "Showing 5 of 12". The choice is
// kept per list for the person signed in (this computer's browser storage).
// The pure parts (comparing, sorting, searching, date ranges, remembering) also load in Node for the tests and the server.
(function (root, factory) {
  const LV = factory();
  if (typeof module === 'object' && module.exports) module.exports = LV; else root.LV = LV;
})(typeof self !== 'undefined' ? self : this, function () {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const blank = v => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v));
  // a and b of one type: 'num' (numbers, also "12.50"), 'date' (YYYY-MM-DD or a timestamp), 'text' (A–Z, E2 before E10)
  // Empty values always go last, whichever way the list is sorted.
  function compare(a, b, type = 'text') {
    if (type === 'num') { a = blank(a) ? null : Number(a); b = blank(b) ? null : Number(b); if (Number.isNaN(a)) a = null; if (Number.isNaN(b)) b = null; }
    const ea = blank(a), eb = blank(b);
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
    if (type === 'num') return a - b;
    if (type === 'date') return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    return collator.compare(String(a), String(b));
  }
  // "Mere Tuilagi" → by last name "Tuilagi Mere"; one word stays as it is
  function nameKey(name, by = 'first') {
    const w = String(name || '').trim().split(/\s+/).filter(Boolean);
    return by === 'last' && w.length > 1 ? `${w[w.length - 1]} ${w.slice(0, -1).join(' ')}` : w.join(' ');
  }
  const valueOf = (f, key, r) => (f && f.get ? f.get(r) : r[key]);
  // fields: { key: { type, get(row), then: 'otherKey' } }. Stable; ties broken by `then`, then the list's own order.
  function sortRows(rows, fields, key, dir = 'asc') {
    const f = fields[key]; if (!f) return rows.slice();
    const sign = dir === 'desc' ? -1 : 1, then = f.then && fields[f.then] ? f.then : null;
    return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => {
      const va = valueOf(f, key, a), vb = valueOf(f, key, b), ea = blank(va), eb = blank(vb);
      if (ea || eb) { if (!(ea && eb)) return ea ? 1 : -1; }   // empties last both ways
      else { const c = compare(va, vb, f.type) * sign; if (c) return c; }
      if (then) { const t = fields[then], c = compare(valueOf(t, then, a), valueOf(t, then, b), t.type); if (c) return c; }
      return i - j;
    }).map(([r]) => r);
  }
  const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // every word typed must be somewhere in the row's search text ("ana e00" finds Ana, employee no. E002)
  function matches(text, q) {
    const words = fold(q).split(/\s+/).filter(Boolean); if (!words.length) return true;
    const t = fold(Array.isArray(text) ? text.join(' ') : text);
    return words.every(w => t.includes(w));
  }
  const inRange = (d, r) => !r || (!!d && String(d).slice(0, 10) >= r.from && String(d).slice(0, 10) <= r.to);
  // the dates a filter state means, using the meta from the server (/api/staff/lists/meta): a year, a quick period, or custom
  function rangeOf(state, meta) {
    if (!state || !meta) return null;
    if (state.year) { const y = (meta.years || []).find(x => x.key === state.year); if (y) return { from: y.from, to: y.to }; }
    if (state.period === 'custom') return state.from && state.to && state.from <= state.to ? { from: state.from, to: state.to } : null;
    if (state.period && meta.periods && meta.periods[state.period]) { const p = meta.periods[state.period]; return { from: p.from, to: p.to }; }
    return null;
  }
  // which year / period (if any) are exactly these dates (Timesheets always has dates; this shows them in the pickers)
  function pickFor(from, to, meta) {
    if (!meta || !from || !to) return { year: '', period: '' };
    const y = (meta.years || []).find(x => x.from === from && x.to === to);
    const p = Object.entries(meta.periods || {}).find(([, v]) => v.from === from && v.to === to);
    return { year: y ? y.key : '', period: p ? p[0] : y ? '' : 'custom' };
  }
  // spec: { fields, search(row) → text, date(row) → YYYY-MM-DD, selects: [{ key, test(row, value) }] }
  function apply(rows, spec, state, meta) {
    const r = spec.date && !spec.serverDates ? rangeOf(state, meta) : null, sel = (state && state.sel) || {};
    let out = rows.filter(row => (!spec.search || matches(spec.search(row), state.q)) && (!r || inRange(spec.date(row), r))
      && (spec.selects || []).every(s => !sel[s.key] || s.test(row, sel[s.key])));
    if (state.sort && spec.fields[state.sort]) out = sortRows(out, spec.fields, state.sort, state.dir);
    return out;
  }
  const isFiltered = (state, spec) => !!(state.q || state.year || state.period || Object.values(state.sel || {}).some(Boolean)) && !!spec;
  // ---- remembering (per list, per person signed in, on this computer)
  const storeKey = (list, uid) => `riyeser.payroll.list.${uid || 0}.${list}`;
  function load(list, uid, defaults = {}, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    let saved = null; try { saved = storage ? JSON.parse(storage.getItem(storeKey(list, uid)) || 'null') : null; } catch { saved = null; }
    const base = { sort: '', dir: 'asc', q: '', year: '', period: '', from: '', to: '', sel: {}, ...defaults };
    if (!saved || typeof saved !== 'object') return { ...base, sel: { ...(base.sel || {}) } };
    return { ...base, ...saved, sel: { ...(base.sel || {}), ...(saved.sel && typeof saved.sel === 'object' ? saved.sel : {}) } };
  }
  function save(list, uid, state, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    try { if (storage) storage.setItem(storeKey(list, uid), JSON.stringify(state)); } catch { /* private window: nothing kept */ }
  }
  // only sort fields this person may use (pay rate needs pay-rate access: the server's list in meta.sorts decides)
  function allowedFields(fields, list, meta) {
    const ok = meta && meta.sorts && meta.sorts[list];
    return Object.fromEntries(Object.entries(fields).filter(([k, f]) => !f.hidden && (!ok || !f.guard || ok.includes(k))));
  }

  // ------------------------------------------------------------------ on screen (browser only)
  const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PERIODS = [['this_pay', 'This pay period'], ['last_pay', 'Last pay period'], ['this_week', 'This week (Mon–Sun)'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['this_fy', 'This financial year'], ['last_fy', 'Last financial year'], ['custom', 'Custom dates…']];
  // a column heading that sorts: <th aria-sort><button>Name ▲</button></th>
  function th(label, key, state, { r = false, title = '', list = '', cls = '' } = {}) {
    const on = state && state.sort === key, dir = on ? state.dir : '';
    return `<th class="${r ? 'r ' : ''}${cls ? `${h(cls)} ` : ''}lv-th${on ? ' on' : ''}" aria-sort="${on ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}"><button type="button" class="lv-sort" data-lv-sort="${h(key)}" data-lv-of="${h(list)}" title="${h(title || `Sort by ${String(label).replace(/<[^>]*>/g, '')}`)}">${label}<span class="lv-arrow" aria-hidden="true">${on ? (dir === 'desc' ? '▼' : '▲') : '↕'}</span></button></th>`;
  }
  // the filter bar. opts: { dates: 'Pay date' (label: Year and Period filter these), datesRequired (Timesheets: no "All dates") }
  function bar(c, { shown, total, extra = '' } = {}) {
    const { spec, state, meta } = c, f = allowedFields(spec.fields, c.id, meta), sel = state.sel || {};
    const years = (meta && meta.years) || [], fy = years.filter(y => y.kind === 'fy'), cy = years.filter(y => y.kind === 'cy');
    const opt = (v, l, cur) => `<option value="${h(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${h(l)}</option>`;
    const sortOpts = Object.entries(f).filter(([, x]) => x.label);
    const dl = spec.dateLabel || 'Dates';
    // Payroll 2.3.3: one tidy row that wraps: Search grows, the selects size to their longest choice (never cut off), Sort by
    // and its direction are one joined control, and the count + Clear filters sit at the end of the same row (Sort by and
    // the count travel together, so a narrow window never leaves the count alone on a row).
    const selT = (label, attrs, inner, cur) => `<label class="lv-f lv-sel"><span class="lv-k">${label}</span><select ${attrs} title="${h(cur)}">${inner}</select></label>`;
    const curLabel = (pairs, v, dflt) => { const m = pairs.find(([k]) => String(k) === String(v)); return m ? m[1] : dflt; };
    const sortLabel = curLabel(sortOpts.map(([k, x]) => [k, x.label]), state.sort, '');
    return `<div class="lv-bar no-print" data-lv="${h(c.id)}" role="search" aria-label="Sort and filter">
      ${spec.search ? `<label class="lv-f lv-q"><span class="lv-k">Search</span><input type="search" data-lv-q value="${h(state.q)}" placeholder="${h(spec.placeholder || 'Name…')}" autocomplete="off"></label>` : ''}
      ${spec.date && meta ? `${selT(`Year <small>(${h(dl.toLowerCase())})</small>`, 'data-lv-year', `${spec.datesRequired ? opt('', 'Choose…', state.year) : opt('', 'All years', state.year)}
          ${fy.length ? `<optgroup label="Financial year (from ${h(meta.fy_start_label)})">${fy.map(y => opt(y.key, y.label, state.year)).join('')}</optgroup>` : ''}
          ${cy.length ? `<optgroup label="Calendar year">${cy.map(y => opt(y.key, y.label, state.year)).join('')}</optgroup>` : ''}`, curLabel(years.map(y => [y.key, y.label]), state.year, spec.datesRequired ? 'Choose…' : 'All years'))}
        ${selT('Period', 'data-lv-period', `${opt('', spec.datesRequired ? 'Choose…' : 'Any time', state.period)}${PERIODS.filter(([k]) => k === 'custom' || (meta.periods || {})[k]).map(([k, l]) => opt(k, l, state.period)).join('')}`, curLabel(PERIODS, state.period, spec.datesRequired ? 'Choose…' : 'Any time'))}
        ${state.period === 'custom' && !spec.datesRequired ? `<label class="lv-f lv-date"><span class="lv-k">From</span><input type="date" data-lv-from value="${h(state.from)}"></label><label class="lv-f lv-date"><span class="lv-k">To</span><input type="date" data-lv-to value="${h(state.to)}"></label>` : ''}` : ''}
      ${(spec.selects || []).map(s => selT(h(s.label), `data-lv-sel="${h(s.key)}"`, `${opt('', s.all || 'All', sel[s.key] || '')}${s.options.map(([v, l]) => opt(v, l, sel[s.key] || '')).join('')}`, curLabel(s.options, sel[s.key] || '', s.all || 'All'))).join('')}
      <div class="lv-end">${sortOpts.length ? `<div class="lv-f lv-sortbox"><label class="lv-k" for="lv-sort-${h(c.id)}">Sort by</label><div class="lv-join"><select id="lv-sort-${h(c.id)}" data-lv-sortsel title="${h(sortLabel)}">${sortOpts.map(([k, x]) => opt(k, x.label, state.sort)).join('')}</select><button type="button" class="lv-dir" data-lv-dir aria-label="${state.dir === 'desc' ? 'Descending: press for ascending' : 'Ascending: press for descending'}" title="Reverse the order"><span aria-hidden="true">${state.dir === 'desc' ? '▼' : '▲'}</span></button></div></div>` : ''}
      ${extra}
      <div class="lv-foot"><span class="lv-count" aria-live="polite">${shown == null ? '' : shown === total ? `${total} shown` : `Showing <b>${shown}</b> of ${total}`}</span>
        <button type="button" class="btn sm ghost lv-clear" data-lv-clear ${isFiltered(state, spec) ? '' : 'disabled'}>Clear filters</button></div></div></div>`;
  }
  // c = LV.list({ id, uid, spec, defaults, meta, onChange(c, { dates }) })
  function list(opts) {
    const c = { id: opts.id, uid: opts.uid, spec: opts.spec, meta: opts.meta || null, defaults: opts.defaults || {}, onChange: opts.onChange || (() => {}) };
    c.state = load(c.id, c.uid, c.defaults);
    const f = () => allowedFields(c.spec.fields, c.id, c.meta);
    if (!f()[c.state.sort]) { c.state.sort = c.defaults.sort && f()[c.defaults.sort] ? c.defaults.sort : ''; c.state.dir = c.defaults.dir || 'asc'; }
    for (const s of c.spec.selects || []) if (c.state.sel[s.key] && !s.options.some(([v]) => String(v) === String(c.state.sel[s.key]))) delete c.state.sel[s.key];
    if (c.state.year && c.meta && !(c.meta.years || []).some(y => y.key === c.state.year)) c.state.year = '';
    c.apply = rows => apply(rows, { ...c.spec, fields: f() }, c.state, c.meta);
    c.range = () => rangeOf(c.state, c.meta);
    c.th = (label, key, o) => (f()[key] ? th(label, key, c.state, { ...(o || {}), list: c.id }) : `<th class="${[o && o.r ? 'r' : '', o && o.cls ? h(o.cls) : ''].filter(Boolean).join(' ')}">${label}</th>`);
    c.bar = o => bar(c, o);
    c.save = () => save(c.id, c.uid, c.state);
    c.set = (patch, dates = false) => { Object.assign(c.state, patch); c.save(); c.onChange(c, { dates }); };
    c.sortBy = key => { if (!f()[key]) return; const flip = c.state.sort === key; c.set({ sort: key, dir: flip ? (c.state.dir === 'desc' ? 'asc' : 'desc') : (f()[key].first || 'asc') }); };
    c.clear = () => { const keep = { sort: c.state.sort, dir: c.state.dir }; c.state = { ...load('__none__', 0, c.defaults, null), ...keep, sel: { ...(c.defaults.sel || {}) } }; c.save(); c.onChange(c, { dates: true, cleared: true }); };
    // wire up the bar and headings inside root (call after each draw)
    c.bind = root => {
      if (!root) return;
      root.querySelectorAll(`[data-lv-sort][data-lv-of="${c.id}"]`).forEach(b => { b.onclick = e => { e.stopPropagation(); c.sortBy(b.dataset.lvSort); }; });
      const barEl = root.querySelector(`.lv-bar[data-lv="${c.id}"]`); if (!barEl) return;
      const q = barEl.querySelector('[data-lv-q]');
      if (q) { let t = null; q.oninput = () => { clearTimeout(t); t = setTimeout(() => { const pos = q.selectionStart; c.set({ q: q.value }); const n = root.querySelector('[data-lv-q]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch { } } }, 200); }; }
      const y = barEl.querySelector('[data-lv-year]'); if (y) y.onchange = () => c.set({ year: y.value, period: y.value ? '' : c.state.period }, true);
      const p = barEl.querySelector('[data-lv-period]'); if (p) p.onchange = () => {
        const v = p.value, r = rangeOf(c.state, c.meta) || {};
        c.set({ period: v, year: v ? '' : c.state.year, ...(v === 'custom' ? { from: c.state.from || r.from || '', to: c.state.to || r.to || '' } : {}) }, v !== 'custom' || !c.spec.datesRequired);
      };
      const fr = barEl.querySelector('[data-lv-from]'), to = barEl.querySelector('[data-lv-to]');
      if (fr) fr.onchange = () => c.set({ from: fr.value }, true); if (to) to.onchange = () => c.set({ to: to.value }, true);
      barEl.querySelectorAll('[data-lv-sel]').forEach(s => { s.onchange = () => c.set({ sel: { ...c.state.sel, [s.dataset.lvSel]: s.value } }); });
      const ss = barEl.querySelector('[data-lv-sortsel]'); if (ss) ss.onchange = () => c.set({ sort: ss.value, dir: (f()[ss.value] || {}).first || 'asc' });
      const d = barEl.querySelector('[data-lv-dir]'); if (d) d.onclick = () => c.set({ dir: c.state.dir === 'desc' ? 'asc' : 'desc' });
      const cl = barEl.querySelector('[data-lv-clear]'); if (cl) cl.onclick = () => c.clear();
    };
    return c;
  }
  // the year / period lists and allowed sort fields, fetched once per page view
  async function meta(fetcher) { try { return await fetcher('/api/staff/lists/meta'); } catch { return null; } }
  return { compare, nameKey, sortRows, matches, inRange, rangeOf, pickFor, apply, isFiltered, storeKey, load, save, allowedFields, th, bar, list, meta, PERIODS };
});
