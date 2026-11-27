/* Riyeser Estimate, the Measure step: the list of measurements and the totals panel (a bottom sheet on phones), the
   "type in sizes" form, first-use tips, and the drawing engine (RE.Sketch) shared by the plan (plan.js) and the map
   (map.js). Every finished shape is saved straight away; Undo and Redo work on points while drawing and on whole
   measurements after they're saved. */
(function () {
  'use strict';
  const cfg = JSON.parse(document.getElementById('cfg').textContent);
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } } };

  // ---------- server ----------
  async function api(url, body) {
    const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    let j = {}; try { j = await r.json(); } catch { j = { ok: false, error: 'The server didn\'t answer. Check you\'re signed in, then try again.' }; }
    if (!r.ok || j.ok === false) throw new Error(j.error || 'Couldn\'t save that.');
    return j;
  }
  const RE = (window.RE = { cfg, api, esc, items: [], listeners: [] });
  RE.saveItem = (item) => api(cfg.urls.items, item).then((j) => { RE.update(j); return j; });
  RE.deleteItem = (id) => api(cfg.urls.items + '/' + id + '/delete', {}).then((j) => { RE.update(j); return j; });
  RE.onItems = (fn) => RE.listeners.push(fn);
  RE.toast = function (msg, bad) {
    let t = $('#est-toast');
    if (!t) { t = document.createElement('div'); t.id = 'est-toast'; t.setAttribute('role', 'status'); t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:60;padding:10px 16px;border-radius:12px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.2);max-width:90vw'; document.body.appendChild(t); }
    t.textContent = msg; t.style.background = bad ? '#fdecea' : '#0f172a'; t.style.color = bad ? '#b42318' : '#fff'; t.hidden = false;
    clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2600);
  };
  RE.live = (txt) => { const l = $('#live'); if (l) l.textContent = txt || ''; };

  // ---------- list and totals ----------
  RE.update = function (j) {
    RE.items = j.items || [];
    const dl = $('#totals');
    if (dl) dl.innerHTML = (j.totals || []).length ? j.totals.map((x) => `<dt>${esc(x.label)}</dt><dd>${esc(x.text)}</dd>`).join('') : '<dt>Nothing measured yet</dt><dd></dd>';
    const list = $('#mlist');
    if (list) {
      list.innerHTML = RE.items.length ? RE.items.map((i) => `<div class="mitem" data-id="${i.id}"><span class="sw" style="background:${esc(i.color)}"></span><div><b>${esc(i.label)}</b> <span class="src">${esc(i.source)}</span>${i.group ? ' · <span class="small">' + esc(i.group) + '</span>' : ''}<div class="q">${i.shown.map((s) => esc(s[0]) + ': ' + esc(s[1])).join('; ')}</div></div><div>${cfg.readOnly ? '' : `<button type="button" class="btn sm danger" data-del="${i.id}" aria-label="Remove ${esc(i.label)}">Remove</button>`}</div></div>`).join('')
        : '<p class="muted" id="noitems">Nothing measured yet.</p>';
    }
    RE.listeners.forEach((fn) => fn(RE.items));
  };
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    e.preventDefault();
    const id = +b.dataset.del;
    try {
      const j = await RE.deleteItem(id);
      RE.lastDeleted = j.deleted;
      RE.toast('Removed. Press Undo to put it back.');
    } catch (err) { RE.toast(err.message, true); }
  });
  RE.restoreDeleted = async function () {
    const d = RE.lastDeleted; if (!d) return false;
    RE.lastDeleted = null;
    await RE.saveItem({ kind: d.kind, source: d.source, label: d.label, group: d.group, color: d.color, data: d.data, plan_id: d.plan_id, page: d.page, verified: d.verified });
    RE.toast('Put back.');
    return true;
  };
  // the first load (the page has the list already; this wires up the JS copy)
  api(cfg.urls.items).then(RE.update).catch(() => {});

  // ---------- first-use tips and the bottom sheet ----------
  $$('.tip[data-tip]').forEach((t) => {
    const k = 'riyeser-est-tip-' + t.dataset.tip;
    if (!store.get(k)) t.hidden = false;
    const b = $('button', t); if (b) b.addEventListener('click', () => { t.hidden = true; store.set(k, '1'); });
  });
  const side = $('#mside'), sheet = $('#sheet');
  if (side && sheet) {
    const phone = () => window.matchMedia('(max-width:900px)').matches;
    if (phone()) side.classList.add('closed');
    const label = () => { sheet.textContent = side.classList.contains('closed') ? 'Show' : 'Hide'; };
    sheet.addEventListener('click', () => { side.classList.toggle('closed'); label(); }); label();
  }

  // ---------- type in sizes ----------
  const form = $('#manual');
  if (form) {
    const kind = () => (form.querySelector('input[name=kind]:checked') || {}).value || 'room';
    const show = () => {
      const k = kind();
      $$('[data-k]', form).forEach((el) => { const on = el.dataset.k.split(' ').includes(k); el.hidden = !on; $$('input,select', el).forEach((i) => { i.disabled = !on; }); });
      preview();
    };
    const L = (name) => { const el = form.querySelector(`[name=${name}]:not([disabled])`); try { return el ? RU.parseLength(el.value, cfg.units) : null; } catch { return NaN; } };
    function preview() {
      const k = kind(); const out = $('#preview'); if (!out) return;
      const f = (v, d) => RU.fmt(v, d, cfg.units);
      let txt = '';
      try {
        if (k === 'room') {
          const l = L('length'), w = L('width'), h = L('height');
          if (l && w) {
            let ops = 0; $$('.opening-row', form).forEach((r) => { const ow = RU.parseLength($('[name=op_w]', r).value, cfg.units), oh = RU.parseLength($('[name=op_h]', r).value, cfg.units); if (ow && oh) ops += ow * oh * (+$('[name=op_n]', r).value || 1); });
            txt = `Floor ${f(l * w, 'area')}` + (h ? ` · walls ${f(Math.max(0, 2 * (l + w) * h - ops), 'area')} (less doors and windows)` : '');
          }
        } else if (k === 'rect' || k === 'volume') { const l = L('length'), w = L('width'), d = L('depth'); if (l && w) txt = `Area ${f(l * w, 'area')}` + (d ? ` · volume ${f(l * w * d, 'volume')}` : ''); }
        else if (k === 'circle') { const d = L('diameter'); if (d) txt = `Area ${f(Math.PI * d * d / 4, 'area')}`; }
        else if (k === 'length' || k === 'fence') { const l = L('length'), s = L('spacing'); if (l) txt = `Length ${f(l, 'length')}` + (s ? ` · ${RG.fencePosts([l], s, +(form.querySelector('[name=gates]:not([disabled])') || {}).value || 0, false)} posts` : ''); }
      } catch { txt = ''; }
      out.textContent = txt;
    }
    form.addEventListener('change', show); form.addEventListener('input', preview);
    const add = $('#addop');
    if (add) add.addEventListener('click', () => { const rows = $$('.opening-row', form); const n = rows[rows.length - 1].cloneNode(true); $$('input', n).forEach((i) => { i.value = ''; }); add.before(n); });
    const clear = $('#m_clear'); if (clear) clear.addEventListener('click', () => { $$('input[type=text],input:not([type]),input[inputmode]', form).forEach((i) => { i.value = ''; }); preview(); });
    // a laser measurer in keyboard mode types the number then Enter: move to the next box instead of saving early
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.name === 'label') return;
      const boxes = $$('input:not([disabled]):not([type=radio]):not([type=hidden])', form).filter((i) => !i.closest('[hidden]'));
      const i = boxes.indexOf(e.target);
      if (i >= 0 && i < boxes.length - 1 && !e.ctrlKey) { e.preventDefault(); boxes[i + 1].focus(); }
    });
    form.addEventListener('submit', (e) => {
      for (const el of $$('[data-len]:not([disabled])', form)) {
        try { RU.parseLength(el.value, cfg.units); } catch (err) { e.preventDefault(); el.focus(); RE.toast(err.message, true); return; }
      }
    });
    show();
  }

  // ---------- the drawing engine, shared by the plan and the map ----------
  const TOOL_HINT = {
    pan: 'Drag to move around. Pick a tool to draw.', shape: 'Tap each corner of the area. Double-tap or press Finish to close it.',
    line: 'Tap along the length. Double-tap or press Finish.', markers: 'Tap each thing to count it, then press Finish.',
    roof: 'Tap each corner of one roof face. Finish, then give its pitch and say what each edge is.',
    fence: 'Tap along the fence line, corner to corner. Finish to work out posts.', hole: 'Tap the corners of the bit to cut out of the last area (a pool, a stairwell).',
    scale: 'Tap both ends of something you know the size of (a door, a dimension line). Then type its real length.',
  };
  RE.Sketch = function (adapter) {
    const S = { tool: 'pan', pts: [], redo: [], savedStack: [], redoSaved: [], color: cfg.colors[0] };
    const opt = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    S.setTool = function (t) {
      if (S.pts.length && t !== S.tool) S.pts = [];
      S.tool = t; S.redo = [];
      $$('#tools .tool[data-tool], [data-tool=scale]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
      $$('#drawopts [data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(t); });
      adapter.setTool && adapter.setTool(t);
      adapter.hint && adapter.hint(TOOL_HINT[t] || '');
      S.render();
    };
    S.render = function () { adapter.render(S); S.liveFigures(); };
    S.liveFigures = function () {
      if (!S.pts.length || S.tool === 'pan') { RE.live(''); return; }
      const d = S.data(); const k = S.kind(); if (!d) return;
      const q = RG.quantities(k, d); const f = (v, dim) => RU.fmt(v, dim, cfg.units);
      const bits = [];
      if (q.area != null && S.pts.length > 2) bits.push(f(q.area, 'area'));
      if (q.roof_area != null && S.pts.length > 2) bits.push(f(q.roof_area, 'area') + ' true');
      if (q.length != null) bits.push(f(q.length, 'length'));
      if (q.fence_length != null) bits.push(f(q.fence_length, 'length') + (q.posts ? ` · ${q.posts} posts` : ''));
      if (q.count != null) bits.push(q.count + ' counted');
      if (S.tool === 'scale' && S.pts.length === 2) bits.push('Now type the real length');
      RE.live(bits.length ? 'Drawing: ' + bits.join(' · ') : '');
    };
    S.kind = () => (S.tool === 'hole' ? 'shape' : S.tool);
    S.data = function () {
      const d = adapter.geometry(S.pts);
      if (!d) return null;
      if (S.tool === 'roof') { const r = opt('d_rise'); d.pitch = r ? { rise: +r, run: +(opt('d_run') || 12) } : { deg: +(opt('d_pitch') || 0) }; d.edges = []; }
      if (S.tool === 'fence') {
        let sp = null; try { sp = RU.parseLength(opt('d_spacing') || (cfg.units === 'imperial' ? '8' : '2.4'), cfg.units); } catch { sp = null; }
        d.spacing = sp; const n = +opt('d_gates') || 0;
        if (n) { let w = 0; try { w = RU.parseLength(opt('d_gatew') || '0', cfg.units) || 0; } catch { w = 0; } d.gates = [{ count: n, width: w }]; }
      }
      if (['shape', 'line', 'markers'].includes(S.tool) && opt('d_as')) d.as = opt('d_as');
      return d;
    };
    S.add = function (pt) {
      if (S.tool === 'pan' || cfg.readOnly) return;
      S.pts.push(pt); S.redo = [];
      if (S.tool === 'scale' && S.pts.length === 2) { S.render(); adapter.askScale && adapter.askScale(S.pts.slice()); S.pts = []; S.setTool('pan'); return; }
      S.render();
    };
    S.undo = async function () {
      if (S.pts.length) { S.redo.push(S.pts.pop()); S.render(); return; }
      if (RE.lastDeleted) { await RE.restoreDeleted(); return; }
      const last = S.savedStack.pop();
      if (last) { try { await RE.deleteItem(last.id); RE.lastDeleted = null; S.redoSaved.push(last.body); RE.toast('Undone.'); } catch (e) { RE.toast(e.message, true); } }
    };
    S.redoIt = async function () {
      if (S.redo.length) { S.pts.push(S.redo.pop()); S.render(); return; }
      const body = S.redoSaved.pop();
      if (body) { try { const j = await RE.saveItem(body); S.savedStack.push({ id: j.id, body }); RE.toast('Redone.'); } catch (e) { RE.toast(e.message, true); } }
    };
    S.finish = async function () {
      const k = S.kind(); const need = k === 'markers' ? 1 : (k === 'line' || k === 'fence') ? 2 : 3;
      if (S.pts.length < need) { RE.toast(k === 'markers' ? 'Tap at least one thing to count.' : k === 'line' || k === 'fence' ? 'Tap at least two points.' : 'Tap at least three corners.', true); return; }
      const d = S.data(); if (!d) { RE.toast('Set the scale first: press Set scale.', true); return; }
      if (S.tool === 'hole') {
        const target = [...RE.items].reverse().find((i) => i.kind === 'shape' && adapter.owns(i));
        if (!target) { RE.toast('Draw the area first, then cut out of it.', true); return; }
        const td = JSON.parse(JSON.stringify(target.data)); td.holes = (td.holes || []).concat([d[adapter.key]]);
        await save({ id: target.id, kind: target.kind, source: target.source, label: target.label, group: target.group, color: target.color, data: td, plan_id: target.plan_id, page: target.page });
        return;
      }
      const label = opt('d_label') || (cfg.kinds[k] + ' ' + (RE.items.filter((i) => i.kind === k).length + 1));
      const body = Object.assign({ kind: k, source: adapter.source, label, group: opt('d_group'), color: S.color, data: d }, adapter.extra ? adapter.extra() : {});
      const j = await save(body);
      if (j && k === 'roof') S.editEdges(j.id);
      const lab = document.getElementById('d_label'); if (lab) lab.value = '';
    };
    async function save(body) {
      try {
        const j = await RE.saveItem(body);
        if (!body.id) S.savedStack.push({ id: j.id, body }); S.redoSaved = [];
        S.pts = []; S.redo = []; S.render(); RE.toast('Saved.');
        return j;
      } catch (e) { RE.toast(e.message, true); return null; }
    }
    // roof edges: say what each edge of a face is
    S.editEdges = function (id) {
      const it = RE.items.find((i) => i.id === id); const box = $('#edges'); if (!it || !box) return;
      const segs = RG.segLengths(it.data, true);
      const types = it.data.edges || [];
      $('#edgelist', box).innerHTML = segs.map((L, n) => `<div style="display:flex;gap:8px;align-items:center;margin:6px 0"><span style="min-width:110px" class="small">Edge ${n + 1}: ${esc(RU.fmt(L, 'length', cfg.units))}</span><select data-edge="${n}" style="width:auto"><option value="">Not priced</option>${Object.entries(cfg.edgeTypes).map(([k, v]) => `<option value="${k}" ${types[n] === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>`).join('');
      box.hidden = false; box.dataset.id = id;
      adapter.highlightEdges && adapter.highlightEdges(it);
    };
    const es = $('#edgesave');
    if (es) es.addEventListener('click', async () => {
      const box = $('#edges'); const it = RE.items.find((i) => i.id === +box.dataset.id); if (!it) return;
      const d = JSON.parse(JSON.stringify(it.data)); d.edges = $$('[data-edge]', box).map((s) => s.value || null);
      await save({ id: it.id, kind: it.kind, source: it.source, label: it.label, group: it.group, color: it.color, data: d, plan_id: it.plan_id, page: it.page });
      box.hidden = true;
    });
    // toolbar
    $$('#tools .tool[data-tool], [data-tool=scale]').forEach((b) => b.addEventListener('click', () => S.setTool(b.dataset.tool)));
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('undo', () => S.undo()); on('redo', () => S.redoIt()); on('finish', () => S.finish());
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input,select,textarea')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? S.redoIt() : S.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); S.redoIt(); }
      else if (e.key === 'Enter') S.finish();
      else if (e.key === 'Escape') { S.pts = []; S.render(); }
    });
    const sw = $('#swatches');
    if (sw) {
      sw.innerHTML = cfg.colors.map((c, i) => `<button type="button" class="tool" data-c="${c}" aria-label="Colour ${i + 1}" style="min-height:32px;width:32px;padding:0;background:${c};border-color:${i ? c : '#0f172a'};border-width:3px"></button>`).join('');
      sw.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; S.color = b.dataset.c; $$('[data-c]', sw).forEach((x) => { x.style.borderColor = x === b ? '#0f172a' : x.dataset.c; }); S.render(); });
    }
    const as = $('#d_as');
    if (as) as.innerHTML = Object.entries(cfg.as).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    return S;
  };
})();
