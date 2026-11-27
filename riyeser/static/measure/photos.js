// Riyeser Estimate: photos of the job and the markup editor (arrows, circles, boxes, freehand, text labels and
// measurement callouts), with undo and redo. Works with a mouse, a pen or a finger (pointer events). The photo is
// never changed: the markup is saved as JSON (points in fractions of the photo's width and height) and the PC draws
// the flattened picture for the quote PDF (riyeser/measure/photos.py draws it the same way as here).
(function () {
  'use strict';
  const cfg = window.RE_PHOTOS || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const base = cfg.urls.base;
  const grid = $('#ph-grid');
  const status = $('#ph-status');

  function say(msg, bad) {
    status.hidden = !msg;
    status.textContent = msg || '';
    status.classList.toggle('bad', !!bad);
  }
  async function api(url, body, method) {
    const opt = { method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
      headers: { 'X-Requested-With': 'fetch' } };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(url, opt);
    let j = {};
    try { j = await r.json(); } catch (e) { j = { ok: false, error: r.status === 413 ? 'That photo is too big.' : 'Something went wrong (' + r.status + ').' }; }
    if (!r.ok && !j.error) j.error = 'Something went wrong (' + r.status + ').';
    return j;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const imgUrl = (p, w) => `${base}/${p.id}/img?w=${w}&v=${encodeURIComponent(p.v)}`;

  // ------------------------------------------------------------ the list of photos
  function card(p) {
    const ro = cfg.readOnly;
    const name = esc(p.caption || p.name);
    return `<article class="ph-card" data-photo="${p.id}">
<button type="button" class="ph-thumb" data-edit="${p.id}" aria-label="Mark up ${name}"><img src="${imgUrl(p, 640)}" alt="${name}" loading="lazy">${p.marks ? `<span class="ph-marks">${p.marks} mark${p.marks === 1 ? '' : 's'}</span>` : ''}</button>
<div class="ph-body"><label class="sr-only" for="cap-${p.id}">Caption</label><input id="cap-${p.id}" class="ph-cap" data-id="${p.id}" value="${esc(p.caption)}" placeholder="Caption, e.g. Rot under the window" maxlength="200"${ro ? ' disabled' : ''}>
<div class="ph-row"><label class="check"><input type="checkbox" class="ph-on" data-id="${p.id}"${p.on_pdf ? ' checked' : ''}${ro ? ' disabled' : ''}> On the quote</label>
<span class="ph-btns">${ro ? '' : `<button type="button" class="btn sm" data-edit="${p.id}">✏️ Mark up</button><button type="button" class="btn sm danger" data-del="${p.id}" aria-label="Delete photo">Delete</button>`}</span></div></div></article>`;
  }
  let photos = [];
  function show(list) {
    photos = list;
    grid.innerHTML = list.map(card).join('');
    $('#ph-empty').hidden = list.length > 0;
  }
  // the photos the page came with
  photos = $$('.ph-card', grid).map((el) => ({ id: +el.dataset.photo }));

  async function upload(files) {
    files = Array.from(files || []);
    if (!files.length) return;
    const problems = [];
    let last = null;
    for (let i = 0; i < files.length; i++) {
      say(`Adding ${files.length > 1 ? `photo ${i + 1} of ${files.length}` : 'the photo'}…`);
      let f = files[i];
      if (f.size > cfg.maxMB * 1024 * 1024) {
        try { f = await shrink(f); } catch (e) { /* the PC says why */ }
      }
      const fd = new FormData();
      fd.append('file', f, f.name || 'photo.jpg');
      const j = await api(cfg.urls.upload, fd);
      if (j.photos) last = j.photos;
      (j.problems || []).forEach((p) => problems.push(p));
      if (!j.ok && !(j.problems || []).length) problems.push(j.error);
    }
    if (last) show(last);
    say(problems.length ? problems.join(' ') : (files.length > 1 ? `${files.length} photos added.` : 'Photo added. Press Mark up to draw on it.'), problems.length > 0);
  }
  // a photo over the limit: made smaller here first (the long side 2400 px)
  function shrink(file) {
    return new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        c.toBlob((b) => (b ? ok(new File([b], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })) : no()), 'image/jpeg', 0.85);
      };
      img.onerror = no;
      img.src = URL.createObjectURL(file);
    });
  }
  ['#ph-camera', '#ph-file'].forEach((s) => { const el = $(s); if (el) el.addEventListener('change', () => { upload(el.files); el.value = ''; }); });

  grid.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.classList.contains('ph-cap')) {
      const j = await api(`${base}/${el.dataset.id}`, { caption: el.value });
      say(j.ok ? 'Caption saved.' : j.error, !j.ok);
    } else if (el.classList.contains('ph-on')) {
      const j = await api(`${base}/${el.dataset.id}`, { on_pdf: el.checked });
      say(j.ok ? (el.checked ? 'It goes on the quote.' : 'Left off the quote.') : j.error, !j.ok);
    }
  });
  grid.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { if (!cfg.readOnly) open(+ed.dataset.edit); return; }
    const del = e.target.closest('[data-del]');
    if (del && confirm('Delete this photo and its markup?')) {
      const j = await api(`${base}/${del.dataset.del}/delete`, {});
      if (j.photos) show(j.photos);
      say(j.ok ? 'Photo deleted.' : j.error, !j.ok);
    }
  });

  // ------------------------------------------------------------ the markup editor
  const mk = $('#mk'), stage = $('#mk-stage'), cv = $('#mk-canvas'), ctx = cv.getContext('2d');
  const ask = $('#mk-ask'), askIn = $('#mk-text'), hint = $('#mk-hint');
  const HINTS = { arrow: 'Drag from where the arrow starts to what it points at.', circle: 'Drag across what to circle.',
    rect: 'Drag across what to box.', pen: 'Draw with your finger, pen or mouse.', text: 'Tap where the label goes, then type it.',
    measure: 'Drag along the size, then type its length.' };
  const ed = { id: null, img: null, shapes: [], past: [], future: [], tool: 'arrow', colour: (cfg.colours || ['#dc2626'])[0],
    drag: null, pending: null, dirty: false, w: 0, h: 0 };
  const W_DEF = 0.006, FS_DEF = 0.035;

  function fit() {
    if (!ed.img) return;
    const pad = 12;
    const sw = stage.clientWidth - pad * 2, sh = stage.clientHeight - pad * 2;
    const k = Math.min(sw / ed.img.naturalWidth, sh / ed.img.naturalHeight, 4);
    ed.w = Math.max(1, Math.floor(ed.img.naturalWidth * k));
    ed.h = Math.max(1, Math.floor(ed.img.naturalHeight * k));
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(ed.w * dpr); cv.height = Math.round(ed.h * dpr);
    cv.style.width = ed.w + 'px'; cv.style.height = ed.h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  function drawShape(s) {
    const L = Math.max(ed.w, ed.h);
    const P = (p) => [p[0] * ed.w, p[1] * ed.h];
    const lw = Math.max(1.5, (s.w || W_DEF) * L);
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = s.c;
    ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const pts = s.p.map(P);
    if (s.t === 'pen') {
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
    } else if (s.t === 'rect' || s.t === 'circle') {
      const [a, b] = pts;
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
      ctx.beginPath();
      if (s.t === 'rect') ctx.rect(x, y, w, h);
      else ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.t === 'arrow' || s.t === 'measure') {
      const [a, b] = pts;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (s.t === 'arrow') {
        const head = Math.max(lw * 3.6, L * 0.022);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0] - head * 0.8 * Math.cos(ang), b[1] - head * 0.8 * Math.sin(ang)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(b[0], b[1]);
        ctx.lineTo(b[0] - head * Math.cos(ang - 0.45), b[1] - head * Math.sin(ang - 0.45));
        ctx.lineTo(b[0] - head * Math.cos(ang + 0.45), b[1] - head * Math.sin(ang + 0.45));
        ctx.closePath(); ctx.fill();
      } else {
        const tick = Math.max(lw * 3, L * 0.012), nx = -Math.sin(ang) * tick, ny = Math.cos(ang) * tick;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        [a, b].forEach((p) => { ctx.moveTo(p[0] - nx, p[1] - ny); ctx.lineTo(p[0] + nx, p[1] + ny); });
        ctx.stroke();
        if (s.s) label((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, s.s, s.c, s.fs || FS_DEF, true);
      }
    } else if (s.t === 'text') {
      label(pts[0][0], pts[0][1], s.s, s.c, s.fs || FS_DEF, false);
    }
    ctx.restore();
  }
  function label(x, y, text, colour, fs, boxed) {
    const L = Math.max(ed.w, ed.h);
    const px = Math.max(10, fs * L);
    ctx.font = `700 ${px}px "DejaVu Sans", "Segoe UI", system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    ctx.textBaseline = 'middle';
    if (boxed) {
      const pad = Math.max(3, px * 0.28), w = tw + pad * 2, h = px + pad * 2;
      ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.strokeStyle = colour; ctx.lineWidth = Math.max(1.5, pad / 2.5);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, pad); else ctx.rect(x - w / 2, y - h / 2, w, h);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#111827'; ctx.textAlign = 'center'; ctx.fillText(text, x, y);
    } else {
      const rgb = parseInt(colour.slice(1), 16), dark = ((rgb >> 16) + ((rgb >> 8) & 255) + (rgb & 255)) < 380;
      ctx.textAlign = 'left'; ctx.lineWidth = Math.max(2, px * 0.18); ctx.strokeStyle = dark ? '#fff' : '#111827';
      ctx.strokeText(text, x, y - px / 2); ctx.fillStyle = colour; ctx.fillText(text, x, y - px / 2);
    }
  }
  function draw() {
    ctx.clearRect(0, 0, ed.w, ed.h);
    if (ed.img) ctx.drawImage(ed.img, 0, 0, ed.w, ed.h);
    ed.shapes.forEach(drawShape);
    if (ed.drag && ed.drag.shape) drawShape(ed.drag.shape);
    if (ed.pending) drawShape(ed.pending);
    $('#mk-undo').disabled = !ed.past.length;
    $('#mk-redo').disabled = !ed.future.length;
    $('#mk-clear').disabled = !ed.shapes.length;
  }
  function commit(shape) {
    ed.past.push(JSON.stringify(ed.shapes));
    ed.future = [];
    ed.shapes.push(shape);
    ed.dirty = true;
    draw();
  }
  function undo() { if (!ed.past.length) return; ed.future.push(JSON.stringify(ed.shapes)); ed.shapes = JSON.parse(ed.past.pop()); ed.dirty = true; closeAsk(); draw(); }
  function redo() { if (!ed.future.length) return; ed.past.push(JSON.stringify(ed.shapes)); ed.shapes = JSON.parse(ed.future.pop()); ed.dirty = true; draw(); }

  const r4 = (v) => Math.round(v * 10000) / 10000;
  function pos(e) {
    const r = cv.getBoundingClientRect();
    return [r4((e.clientX - r.left) / r.width), r4((e.clientY - r.top) / r.height)];
  }
  cv.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !ed.img) return;
    e.preventDefault();
    if (!ask.hidden) { finishAsk(); return; }
    cv.setPointerCapture(e.pointerId);
    const p = pos(e);
    if (ed.tool === 'text') { ed.drag = { id: e.pointerId, start: p, shape: null }; return; }
    ed.drag = { id: e.pointerId, start: p, shape: { t: ed.tool, c: ed.colour, w: W_DEF, p: [p, p] } };
    if (ed.tool === 'pen') ed.drag.shape.p = [p];
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!ed.drag || ed.drag.id !== e.pointerId || !ed.drag.shape) return;
    e.preventDefault();
    const p = pos(e);
    const s = ed.drag.shape;
    if (s.t === 'pen') {
      const q = s.p[s.p.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.002 && s.p.length < 2000) s.p.push(p);
    } else s.p[1] = p;
    draw();
  });
  function end(e) {
    if (!ed.drag || ed.drag.id !== e.pointerId) return;
    const d = ed.drag; ed.drag = null;
    const p = pos(e);
    if (ed.tool === 'text') { openAsk({ t: 'text', c: ed.colour, w: W_DEF, fs: FS_DEF, p: [p], s: '' }, p, 'Label'); draw(); return; }
    const s = d.shape;
    if (s.t === 'pen') { if (s.p.length === 1) s.p.push([r4(s.p[0][0] + 0.001), s.p[0][1]]); commit(s); return; }
    s.p[1] = p;
    const big = Math.hypot((p[0] - d.start[0]) * ed.w, (p[1] - d.start[1]) * ed.h) > 8;
    if (!big) { draw(); return; }   // a tap, not a drag
    if (s.t === 'measure') { s.s = ''; s.fs = FS_DEF; openAsk(s, [(s.p[0][0] + p[0]) / 2, (s.p[0][1] + p[1]) / 2], 'Length'); draw(); return; }
    commit(s);
  }
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', (e) => { if (ed.drag && ed.drag.id === e.pointerId) { ed.drag = null; draw(); } });

  // typing a label or a length, in a small box beside where it goes
  function openAsk(shape, at, what) {
    ed.pending = shape;
    $('#mk-ask-l').textContent = what;
    askIn.value = '';
    askIn.placeholder = what === 'Length' ? (cfg.units === 'imperial' ? "e.g. 12' 6\"" : 'e.g. 2.4 m') : 'e.g. Replace this board';
    askIn.maxLength = what === 'Length' ? 30 : 80;
    ask.hidden = false;
    const r = cv.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const x = r.left - sr.left + at[0] * r.width, y = r.top - sr.top + at[1] * r.height;
    const bw = ask.offsetWidth, bh = ask.offsetHeight;
    ask.style.left = Math.max(6, Math.min(sr.width - bw - 6, x - bw / 2)) + 'px';
    ask.style.top = Math.max(6, Math.min(sr.height - bh - 6, y + 14)) + 'px';
    setTimeout(() => askIn.focus(), 0);
  }
  function closeAsk() { ask.hidden = true; ed.pending = null; }
  function finishAsk() {
    const s = ed.pending;
    if (!s) { closeAsk(); return; }
    let v = askIn.value.trim();
    if (s.t === 'measure' && /^\d+([.,]\d+)?$/.test(v)) v += cfg.units === 'imperial' ? ' ft' : ' m';   // a plain number: in the estimate's units
    closeAsk();
    if (s.t === 'text' && !v) { draw(); return; }
    s.s = v;
    commit(s);
  }
  $('#mk-ok').addEventListener('click', finishAsk);
  askIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finishAsk(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAsk(); draw(); }
  });

  function pick(tool) {
    if (!ask.hidden) finishAsk();
    ed.tool = tool;
    $$('[data-tool]', mk).forEach((b) => { b.classList.toggle('on', b.dataset.tool === tool); b.setAttribute('aria-pressed', b.dataset.tool === tool ? 'true' : 'false'); });
    hint.textContent = HINTS[tool];
  }
  $$('[data-tool]', mk).forEach((b) => b.addEventListener('click', () => pick(b.dataset.tool)));
  $$('[data-colour]', mk).forEach((b) => b.addEventListener('click', () => {
    ed.colour = b.dataset.colour;
    $$('[data-colour]', mk).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
  }));
  $('#mk-undo').addEventListener('click', undo);
  $('#mk-redo').addEventListener('click', redo);
  $('#mk-clear').addEventListener('click', () => { if (!ed.shapes.length) return; ed.past.push(JSON.stringify(ed.shapes)); ed.future = []; ed.shapes = []; ed.dirty = true; draw(); });
  $('#mk-cancel').addEventListener('click', () => { if (!ed.dirty || confirm('Close without saving your markup?')) close(); });
  $('#mk-save').addEventListener('click', save);
  document.addEventListener('keydown', (e) => {
    if (mk.hidden || e.target === askIn) return;
    const z = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z';
    if (z && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((z && e.shiftKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y')) { e.preventDefault(); redo(); }
    else if (e.key === 'Escape') { $('#mk-cancel').click(); }
  });
  window.addEventListener('resize', () => { if (!mk.hidden) fit(); });

  async function open(id) {
    say('');
    const j = await api(`${base}/${id}/markup`);
    if (!j.ok) { say(j.error, true); return; }
    const img = new Image();
    img.onload = () => {
      ed.id = id; ed.img = img; ed.shapes = (j.markup && j.markup.shapes) || []; ed.past = []; ed.future = []; ed.dirty = false;
      mk.hidden = false;
      document.body.classList.add('mk-open');
      pick(ed.tool);
      requestAnimationFrame(fit);
    };
    img.onerror = () => say('That photo could not be opened.', true);
    img.src = `${base}/${id}/img?v=orig`;
  }
  function close() {
    closeAsk();
    mk.hidden = true;
    document.body.classList.remove('mk-open');
    ed.id = null; ed.img = null;
  }
  async function save() {
    if (!ask.hidden) finishAsk();
    const btn = $('#mk-save');
    btn.disabled = true;
    const j = await api(`${base}/${ed.id}/markup`, { markup: { v: 1, shapes: ed.shapes } });
    btn.disabled = false;
    if (!j.ok) { say(j.error, true); alert(j.error); return; }
    const el = grid.querySelector(`[data-photo="${ed.id}"]`);
    if (el && j.photo) {
      const tmp = document.createElement('div');
      tmp.innerHTML = card(Object.assign({}, j.photo, { caption: el.querySelector('.ph-cap') ? el.querySelector('.ph-cap').value : j.photo.caption }));
      el.replaceWith(tmp.firstElementChild);
    }
    const n = j.markup.shapes.length;
    close();
    say(n ? `Markup saved (${n} mark${n === 1 ? '' : 's'}). The quote PDF shows it.` : 'Markup cleared.');
  }

  // for the browser test: what's drawn now
  window.RE_MK = { state: () => ({ open: !mk.hidden, id: ed.id, tool: ed.tool, shapes: JSON.parse(JSON.stringify(ed.shapes)),
    canUndo: ed.past.length > 0, canRedo: ed.future.length > 0 }), open };
})();
