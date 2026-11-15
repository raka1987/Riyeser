// PDF viewer + editor. pdf.js draws the pages; pdf-lib writes the changes into the PDF when you save.
// Everything you add is kept as an editable object (text, boxes, signatures...) until you save.
import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle } = window.PDFLib;
const bridge = window.api;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PX_PER_PT = 96 / 72;

// ---------------- state ----------------
const st = {
  file: null,          // path on disk
  bytes: null,         // the PDF as last opened/saved (Uint8Array)
  doc: null,           // pdf.js document used for drawing
  baseRot: [],         // rotation already stored in each page
  order: [],           // pages in display order: { src, rot } (rot = extra rotation added here)
  anns: {},            // src page index -> [annotation]
  text: {},            // src page index -> text items (for Edit text + Find)
  vps: {},             // src page index -> current pdf.js viewport
  zoom: 1,
  tool: 'select',
  current: 0,          // index into order
  selPages: new Set(), // selected src indexes (thumbnails)
  selected: null,      // selected annotation id
  dirty: false,
  undo: [], redo: [],
  form: [],            // [{ name, kind, value, options }]
  formValues: {},
  flatten: false,
  encrypted: false,
};
let renderToken = 0;
let uid = 1;
const newId = () => `a${Date.now().toString(36)}${uid++}`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}
function setDirty(v = true) { st.dirty = v; $('#dirty').hidden = !v; }

// ---------------- undo ----------------
function snapshot() { return JSON.stringify({ order: st.order, anns: st.anns }); }
function pushUndo() { st.undo.push(snapshot()); if (st.undo.length > 60) st.undo.shift(); st.redo = []; setDirty(); }
function restore(snap) {
  const s = JSON.parse(snap);
  const orderChanged = JSON.stringify(s.order) !== JSON.stringify(st.order);
  st.order = s.order; st.anns = s.anns; st.selected = null;
  if (orderChanged) buildPages(); else Object.keys(st.vps).forEach((src) => drawOverlay(+src));
  setDirty();
}
function undo() { if (!st.undo.length) return; st.redo.push(snapshot()); restore(st.undo.pop()); }
function redo() { if (!st.redo.length) return; st.undo.push(snapshot()); restore(st.redo.pop()); }

// ---------------- loading ----------------
async function loadBytes(bytes, { keepState = false } = {}) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(), cMapUrl: './vendor/cmaps/', cMapPacked: true,
    standardFontDataUrl: './vendor/standard_fonts/', isEvalSupported: false,
  });
  const doc = await task.promise;
  if (st.doc) st.doc.destroy();
  st.doc = doc;
  st.baseRot = [];
  for (let i = 1; i <= doc.numPages; i++) st.baseRot.push((await doc.getPage(i)).rotate || 0);
  if (!keepState) {
    st.order = st.baseRot.map((_, i) => ({ src: i, rot: 0 }));
    st.anns = {}; st.text = {}; st.undo = []; st.redo = []; st.selected = null; st.current = 0; st.selPages = new Set();
  }
  $('#empty').hidden = true;
  buildPages();
}

async function openFile(file) {
  try {
    const bytes = await bridge.call('pdf:read', file);
    st.file = file;
    st.bytes = bytes;
    document.title = `${file.split(/[\\/]/).pop()} - PDF Editor`;
    $('#docname').textContent = file.split(/[\\/]/).pop();
    $('#docname').title = file;
    await readForm();
    await loadBytes(bytes);
    setDirty(false);
    if (st.encrypted) toast('This PDF is password-protected. You can view it, but saving changes may not work.');
    requestAnimationFrame(fitWidth);
  } catch (e) {
    toast(`Couldn't open this PDF: ${e.message}`);
  }
}

// ---------------- page layout & drawing ----------------
function viewportFor(page, entry) {
  return page.getViewport({ scale: st.zoom * PX_PER_PT, rotation: (st.baseRot[entry.src] + entry.rot) % 360 });
}

async function buildPages() {
  const token = ++renderToken;
  const wrap = $('#pages');
  wrap.innerHTML = '';
  st.vps = {};
  for (let i = 0; i < st.order.length; i++) {
    const entry = st.order[i];
    const page = await st.doc.getPage(entry.src + 1);
    if (token !== renderToken) return;
    const vp = viewportFor(page, entry);
    st.vps[entry.src] = vp;
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.src = entry.src;
    el.dataset.idx = i;
    el.style.width = `${vp.width}px`; el.style.height = `${vp.height}px`;
    el.innerHTML = '<canvas></canvas><div class="overlay"><svg></svg></div>';
    wrap.appendChild(el);
    pageObserver.observe(el);
    drawOverlay(entry.src);
  }
  buildThumbs();
  updatePageInfo();
}

const pageObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting && !e.target.dataset.drawn) drawPage(e.target);
}, { root: $('#viewer'), rootMargin: '600px 0px' });

async function drawPage(el) {
  el.dataset.drawn = '1';
  const src = +el.dataset.src;
  const entry = st.order.find((o) => o.src === src);
  const page = await st.doc.getPage(src + 1);
  const vp = viewportFor(page, entry);
  const ratio = window.devicePixelRatio || 1;
  const canvas = el.querySelector('canvas');
  canvas.width = Math.floor(vp.width * ratio); canvas.height = Math.floor(vp.height * ratio);
  canvas.style.width = `${vp.width}px`; canvas.style.height = `${vp.height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  try { await page.render({ canvasContext: ctx, viewport: vp }).promise; } catch { /* re-render cancelled */ }
  if (!st.text[src]) {
    const tc = await page.getTextContent();
    st.text[src] = tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
      const [a, b, c, d, e, f] = it.transform;
      const h = Math.hypot(c, d) || Math.abs(d) || 10;
      return { str: it.str, x: e, y: f, w: it.width, h, upright: Math.abs(b) < 0.01 && Math.abs(c) < 0.01 && a > 0, family: tc.styles[it.fontName]?.fontFamily || 'sans-serif' };
    });
    drawOverlay(src);
  }
}

// Convert between PDF points and on-screen pixels for a page.
const toView = (src, x, y) => st.vps[src].convertToViewportPoint(x, y);
const toPdf = (src, vx, vy) => st.vps[src].convertToPdfPoint(vx, vy);

function fontCss(font) { return font === 'TimesRoman' ? '"Times New Roman", Times, serif' : font === 'Courier' ? '"Courier New", Courier, monospace' : 'Arial, Helvetica, sans-serif'; }

function drawOverlay(src) {
  const pageEl = $(`.page[data-src="${src}"]`);
  const vp = st.vps[src];
  if (!pageEl || !vp) return;
  const ov = pageEl.querySelector('.overlay');
  ov.querySelectorAll('.ann, .txtbox').forEach((n) => n.remove());
  const svg = ov.querySelector('svg');
  svg.setAttribute('width', vp.width); svg.setAttribute('height', vp.height);
  svg.innerHTML = '';

  // clickable boxes over existing text (only visible with the Edit text tool)
  if (st.tool === 'edittext') {
    for (const [i, t] of (st.text[src] || []).entries()) {
      if (!t.upright) continue;
      const p1 = toView(src, t.x, t.y - 0.25 * t.h);
      const p2 = toView(src, t.x + t.w, t.y + 0.95 * t.h);
      const box = document.createElement('div');
      box.className = 'txtbox';
      box.dataset.ti = i;
      Object.assign(box.style, { left: `${Math.min(p1[0], p2[0])}px`, top: `${Math.min(p1[1], p2[1])}px`, width: `${Math.abs(p2[0] - p1[0])}px`, height: `${Math.abs(p2[1] - p1[1])}px` });
      ov.appendChild(box);
    }
  }

  for (const a of st.anns[src] || []) {
    if (a.type === 'ink') {
      const pts = a.points.map(([x, y]) => toView(src, x, y).map((n) => n.toFixed(1)).join(',')).join(' ');
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.setAttribute('points', pts);
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', a.color);
      poly.setAttribute('stroke-width', a.width * vp.scale);
      poly.setAttribute('stroke-linecap', 'round');
      poly.setAttribute('stroke-linejoin', 'round');
      poly.dataset.id = a.id;
      poly.style.pointerEvents = st.tool === 'select' ? 'visibleStroke' : 'none';
      poly.style.cursor = 'move';
      if (st.selected === a.id) poly.setAttribute('filter', 'drop-shadow(0 0 2px #2563eb)');
      svg.appendChild(poly);
      continue;
    }
    const [left, top] = toView(src, a.ax, a.ay);
    const el = document.createElement('div');
    el.className = `ann ${a.type}${st.selected === a.id ? ' sel' : ''}`;
    el.dataset.id = a.id;
    el.style.left = `${left}px`; el.style.top = `${top}px`;
    const turn = (vp.rotation - a.rot + 360) % 360;
    if (turn) el.style.transform = `rotate(${turn}deg)`;
    if (a.type === 'text') {
      el.textContent = a.text;
      Object.assign(el.style, { fontSize: `${a.size * vp.scale}px`, color: a.color, fontFamily: fontCss(a.font), fontWeight: a.bold ? '700' : '400' });
    } else {
      el.style.width = `${a.w * vp.scale}px`; el.style.height = `${a.h * vp.scale}px`;
      if (a.type === 'highlight') Object.assign(el.style, { background: a.color, opacity: 0.35, mixBlendMode: 'multiply' });
      if (a.type === 'rect') el.style.border = `${Math.max(1, 1.5 * vp.scale)}px solid ${a.color}`;
      if (a.type === 'whiteout') { el.style.background = '#fff'; if (st.selected !== a.id) el.style.outline = '1px dashed rgba(0,0,0,.08)'; }
      if (a.type === 'image') el.innerHTML = `<img src="${a.data}" alt="">`;
      if (a.type === 'check' || a.type === 'cross') {
        const d = a.type === 'check' ? 'M15 55 L40 80 L85 20' : 'M20 20 L80 80 M80 20 L20 80';
        el.innerHTML = `<svg viewBox="0 0 100 100" width="100%" height="100%" style="pointer-events:none"><path d="${d}" fill="none" stroke="${a.color}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      }
      if (st.selected === a.id) el.insertAdjacentHTML('beforeend', '<div class="handle"></div>');
    }
    if (st.selected === a.id) el.insertAdjacentHTML('beforeend', '<button class="del" title="Delete" contenteditable="false">✕</button>');
    ov.appendChild(el);
  }
}

// ---------------- thumbnails & page info ----------------
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting && !e.target.dataset.drawn) drawThumb(e.target);
}, { root: $('#panel-pages') });

function buildThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  st.order.forEach((entry, i) => {
    const d = document.createElement('div');
    d.className = `thumb${i === st.current ? ' current' : ''}${st.selPages.has(entry.src) ? ' sel' : ''}`;
    d.dataset.idx = i; d.dataset.src = entry.src;
    d.innerHTML = `<canvas width="1" height="1"></canvas><div>${i + 1}</div>`;
    box.appendChild(d);
    thumbObserver.observe(d);
  });
}
async function drawThumb(d) {
  d.dataset.drawn = '1';
  const entry = st.order[+d.dataset.idx];
  if (!entry) return;
  const page = await st.doc.getPage(entry.src + 1);
  const base = page.getViewport({ scale: 1, rotation: (st.baseRot[entry.src] + entry.rot) % 360 });
  const vp = page.getViewport({ scale: 150 / Math.max(base.width, base.height), rotation: base.rotation });
  const c = d.querySelector('canvas');
  c.width = vp.width; c.height = vp.height;
  try { await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; } catch { /* ignore */ }
}
function updatePageInfo() {
  $('#pageinfo').textContent = st.order.length ? `Page ${st.current + 1} of ${st.order.length}` : '';
  $$('.thumb').forEach((t) => t.classList.toggle('current', +t.dataset.idx === st.current));
}
$('#viewer').addEventListener('scroll', () => {
  const vtop = $('#viewer').getBoundingClientRect().top + 80;
  let best = 0;
  for (const p of $$('.page')) { if (p.getBoundingClientRect().top <= vtop) best = +p.dataset.idx; }
  if (best !== st.current) { st.current = best; updatePageInfo(); }
});
function scrollToPage(i) { $(`.page[data-idx="${i}"]`)?.scrollIntoView({ block: 'start' }); st.current = i; updatePageInfo(); }

$('#thumbs').addEventListener('click', (e) => {
  const t = e.target.closest('.thumb');
  if (!t) return;
  const src = +t.dataset.src;
  if (e.ctrlKey || e.metaKey) { st.selPages.has(src) ? st.selPages.delete(src) : st.selPages.add(src); t.classList.toggle('sel'); return; }
  st.selPages = new Set([src]);
  $$('.thumb').forEach((x) => x.classList.toggle('sel', x === t));
  scrollToPage(+t.dataset.idx);
});

// ---------------- zoom ----------------
function setZoom(z) {
  st.zoom = Math.min(4, Math.max(0.25, z));
  $('#zoomlabel').textContent = `${Math.round(st.zoom * 100)}%`;
  if (st.doc) { const cur = st.current; buildPages().then(() => scrollToPage(cur)); }
}
async function fitWidth() {
  if (!st.doc) return;
  const entry = st.order[st.current] || st.order[0];
  const page = await st.doc.getPage(entry.src + 1);
  const w = page.getViewport({ scale: PX_PER_PT, rotation: (st.baseRot[entry.src] + entry.rot) % 360 }).width;
  setZoom(Math.min(2, ($('#viewer').clientWidth - 60) / w));
}

// ---------------- annotations ----------------
function findAnn(id) {
  for (const [src, list] of Object.entries(st.anns)) { const a = list.find((x) => x.id === id); if (a) return { a, src: +src }; }
  return null;
}
function addAnn(src, ann) {
  (st.anns[src] = st.anns[src] || []).push(ann);
  return ann;
}
function select(id) {
  const prev = st.selected;
  st.selected = id;
  const srcs = new Set([prev && findAnn(prev)?.src, id && findAnn(id)?.src].filter((x) => x !== undefined && x !== null));
  srcs.forEach((s) => drawOverlay(s));
  const f = id && findAnn(id);
  if (f?.a.type === 'text') { $('#fontsize').value = String(f.a.size); $('#font').value = f.a.font; $('#color').value = f.a.color; $('#boldbtn').classList.toggle('active', !!f.a.bold); }
}
function deleteSelected() {
  const f = st.selected && findAnn(st.selected);
  if (!f) return;
  pushUndo();
  st.anns[f.src] = st.anns[f.src].filter((x) => x.id !== st.selected);
  st.selected = null;
  drawOverlay(f.src);
}

/** A box drawn on screen -> stored in PDF points, remembering how the page was turned at the time. */
function boxFromView(src, vx, vy, vw, vh) {
  const [ax, ay] = toPdf(src, vx, vy);
  const s = st.vps[src].scale;
  return { ax, ay, w: vw / s, h: vh / s, rot: st.vps[src].rotation };
}

function textStyle() {
  return { size: +$('#fontsize').value, font: $('#font').value, bold: $('#boldbtn').classList.contains('active'), color: $('#color').value };
}

function editText(id, { selectAll = false } = {}) {
  const el = $(`.ann[data-id="${id}"]`);
  if (!el) return;
  el.querySelector('.del')?.remove();
  el.contentEditable = 'true';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  if (!selectAll) range.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  const before = snapshot();
  el.addEventListener('blur', () => {
    el.contentEditable = 'false';
    const f = findAnn(id);
    if (!f) return;
    const text = el.innerText.replace(/\n$/, '');
    if (text !== f.a.text) { st.undo.push(before); st.redo = []; setDirty(); }
    f.a.text = text;
    if (!text.trim()) st.anns[f.src] = st.anns[f.src].filter((x) => x.id !== id);
    drawOverlay(f.src);
  }, { once: true });
}

function centerOfCurrentPage(w, h) {
  const entry = st.order[st.current];
  const vp = st.vps[entry.src];
  const pageEl = $(`.page[data-src="${entry.src}"]`);
  const vr = $('#viewer').getBoundingClientRect();
  const pr = pageEl.getBoundingClientRect();
  const cy = Math.min(Math.max((vr.top + vr.height / 2) - pr.top, h * vp.scale / 2), vp.height - h * vp.scale / 2);
  return { src: entry.src, vx: vp.width / 2 - (w * vp.scale) / 2, vy: cy - (h * vp.scale) / 2 };
}

function placeImage(data, widthPt = 170) {
  if (!st.doc) return;
  const img = new Image();
  img.onload = () => {
    const w = widthPt; const h = widthPt * (img.naturalHeight / img.naturalWidth);
    const { src, vx, vy } = centerOfCurrentPage(w, h);
    pushUndo();
    const a = addAnn(src, { id: newId(), type: 'image', data, ...boxFromView(src, vx, vy, w * st.vps[src].scale, h * st.vps[src].scale) });
    setTool('select');
    select(a.id);
    toast('Drag it into place. Use the blue corner to resize.');
  };
  img.src = data;
}

// ---------------- mouse handling on pages ----------------
let drag = null;

$('#pages').addEventListener('pointerdown', (e) => {
  const pageEl = e.target.closest('.page');
  if (!pageEl || e.button !== 0) return;
  const src = +pageEl.dataset.src;
  const ov = pageEl.querySelector('.overlay');
  const r = ov.getBoundingClientRect();
  const vx = e.clientX - r.left; const vy = e.clientY - r.top;
  st.current = +pageEl.dataset.idx; updatePageInfo();

  // delete button
  if (e.target.classList.contains('del')) { e.preventDefault(); deleteSelected(); return; }

  const annEl = e.target.closest('.ann');
  const inkEl = e.target.closest('polyline');
  if (annEl && annEl.isContentEditable) return; // typing inside text

  // resize handle
  if (e.target.classList.contains('handle')) {
    const f = findAnn(annEl.dataset.id);
    pushUndo();
    drag = { kind: 'resize', f, startX: e.clientX, startY: e.clientY, w: f.a.w, h: f.a.h, keep: f.a.type === 'image' && !e.shiftKey };
    e.preventDefault(); return;
  }

  if ((st.tool === 'select' || annEl?.classList.contains('text')) && (annEl || inkEl)) {
    const id = (annEl || inkEl).dataset.id;
    const f = findAnn(id);
    if (st.selected !== id) select(id);
    drag = { kind: 'move', f, src, startX: e.clientX, startY: e.clientY, moved: false, snap: snapshot() };
    if (f.a.type !== 'ink') { const [l, t] = toView(src, f.a.ax, f.a.ay); drag.l = l; drag.t = t; } else drag.points = f.a.points.map((p) => [...p]);
    e.preventDefault(); return;
  }

  if (st.tool === 'select') { select(null); return; }

  if (st.tool === 'text') {
    e.preventDefault();
    pushUndo();
    const s = textStyle();
    const top = vy - (s.size * st.vps[src].scale * 0.6);
    const a = addAnn(src, { id: newId(), type: 'text', text: '', ...s, ...boxFromView(src, vx, top, 0, 0) });
    st.selected = a.id; drawOverlay(src);
    editText(a.id);
    return;
  }

  if (st.tool === 'edittext') {
    const box = e.target.closest('.txtbox');
    if (!box) { toast('Click on a piece of text in the document to change it.'); return; }
    e.preventDefault();
    const t = st.text[src][+box.dataset.ti];
    pushUndo();
    const family = /serif/i.test(t.family) && !/sans/i.test(t.family) ? 'TimesRoman' : /mono/i.test(t.family) ? 'Courier' : 'Helvetica';
    addAnn(src, { id: newId(), type: 'whiteout', ax: t.x - 1, ay: t.y + 0.95 * t.h + 1, w: t.w + 2, h: 1.2 * t.h + 2, rot: 0 });
    const size = Math.round(t.h * 10) / 10;
    const a = addAnn(src, { id: newId(), type: 'text', text: t.str, size, font: family, bold: false, color: '#000000', ax: t.x, ay: t.y + 0.93 * size, rot: 0 });
    st.selected = a.id; drawOverlay(src);
    editText(a.id);
    return;
  }

  if (st.tool === 'check' || st.tool === 'cross') {
    pushUndo();
    const size = Math.max(10, +$('#fontsize').value * 1.4) * st.vps[src].scale;
    addAnn(src, { id: newId(), type: st.tool, color: $('#color').value, ...boxFromView(src, vx - size / 2, vy - size / 2, size, size) });
    drawOverlay(src);
    return;
  }

  if (st.tool === 'draw') {
    drag = { kind: 'ink', src, ov, points: [[vx, vy]] };
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('fill', 'none'); poly.setAttribute('stroke', $('#color').value);
    poly.setAttribute('stroke-width', 2 * st.vps[src].scale); poly.setAttribute('stroke-linecap', 'round'); poly.setAttribute('stroke-linejoin', 'round');
    ov.querySelector('svg').appendChild(poly);
    drag.poly = poly;
    e.preventDefault(); return;
  }

  if (['highlight', 'rect', 'whiteout'].includes(st.tool)) {
    const prev = document.createElement('div');
    prev.className = 'drag-preview';
    ov.appendChild(prev);
    drag = { kind: 'box', src, ov, x0: vx, y0: vy, prev, r };
    e.preventDefault();
  }
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'move') {
    const dx = e.clientX - drag.startX; const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    const { a } = drag.f;
    if (a.type === 'ink') {
      const [ox, oy] = toPdf(drag.src, 0, 0); const [nx, ny] = toPdf(drag.src, dx, dy);
      a.points = drag.points.map(([x, y]) => [x + nx - ox, y + ny - oy]);
    } else {
      [a.ax, a.ay] = toPdf(drag.src, drag.l + dx, drag.t + dy);
    }
    drawOverlay(drag.src);
  } else if (drag.kind === 'resize') {
    const { a, src } = drag.f;
    const s = st.vps[src].scale;
    let w = Math.max(6, drag.w + (e.clientX - drag.startX) / s);
    let h = Math.max(6, drag.h + (e.clientY - drag.startY) / s);
    if (drag.keep) h = w * (drag.h / drag.w);
    a.w = w; a.h = h;
    drawOverlay(src);
  } else if (drag.kind === 'ink') {
    const r = drag.ov.getBoundingClientRect();
    drag.points.push([e.clientX - r.left, e.clientY - r.top]);
    drag.poly.setAttribute('points', drag.points.map((p) => p.join(',')).join(' '));
  } else if (drag.kind === 'box') {
    const x = e.clientX - drag.r.left; const y = e.clientY - drag.r.top;
    Object.assign(drag.prev.style, { left: `${Math.min(x, drag.x0)}px`, top: `${Math.min(y, drag.y0)}px`, width: `${Math.abs(x - drag.x0)}px`, height: `${Math.abs(y - drag.y0)}px` });
    drag.x1 = x; drag.y1 = y;
  }
});

window.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.kind === 'move') {
    if (d.moved) { st.undo.push(d.snap); st.redo = []; setDirty(); }
    else if (d.f.a.type === 'text' && st.selected === d.f.a.id && d.wasSelected) editText(d.f.a.id);
  } else if (d.kind === 'ink') {
    if (d.points.length > 1) {
      pushUndo();
      addAnn(d.src, { id: newId(), type: 'ink', color: $('#color').value, width: 2, points: d.points.map(([x, y]) => toPdf(d.src, x, y)) });
    }
    drawOverlay(d.src);
  } else if (d.kind === 'box') {
    d.prev.remove();
    if (d.x1 === undefined || Math.abs(d.x1 - d.x0) < 4 || Math.abs(d.y1 - d.y0) < 4) return;
    pushUndo();
    const color = st.tool === 'highlight' ? '#facc15' : $('#color').value;
    addAnn(d.src, { id: newId(), type: st.tool, color: st.tool === 'highlight' && $('#color').value !== '#1d4ed8' ? $('#color').value : color, ...boxFromView(d.src, Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)) });
    drawOverlay(d.src);
  }
});

// double-click text to edit it
$('#pages').addEventListener('dblclick', (e) => {
  const el = e.target.closest('.ann.text');
  if (el) editText(el.dataset.id, { selectAll: false });
});

// ---------------- tools & toolbar ----------------
function setTool(t) {
  st.tool = t;
  document.body.className = `tool-${t}`;
  $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  if (t !== 'select') select(null);
  Object.keys(st.vps).forEach((s) => drawOverlay(+s));
  if (t === 'edittext') toast('Click any text to change it. The old words are covered over (not removed from the file), so don\'t use this to hide private information.');
}
$('#tools').addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });

function applyStyleToSelected(patch) {
  const f = st.selected && findAnn(st.selected);
  if (!f) return;
  if (!['text', 'rect', 'check', 'cross', 'ink', 'highlight'].includes(f.a.type)) return;
  if (f.a.type !== 'text' && !('color' in patch)) return;
  pushUndo();
  Object.assign(f.a, patch);
  drawOverlay(f.src);
}
$('#color').addEventListener('change', (e) => applyStyleToSelected({ color: e.target.value }));
$('#fontsize').addEventListener('change', (e) => applyStyleToSelected({ size: +e.target.value }));
$('#font').addEventListener('change', (e) => applyStyleToSelected({ font: e.target.value }));
$('#boldbtn').addEventListener('click', () => { const b = $('#boldbtn'); b.classList.toggle('active'); applyStyleToSelected({ bold: b.classList.contains('active') }); });

// ---------------- page operations ----------------
function targets() {
  const sel = st.order.map((o, i) => i).filter((i) => st.selPages.has(st.order[i].src));
  return sel.length ? sel : [st.current];
}
function rotatePages(delta) { pushUndo(); for (const i of targets()) st.order[i].rot = (st.order[i].rot + delta + 360) % 360; buildPages(); }
function movePage(dir) {
  const i = st.current; const j = i + dir;
  if (j < 0 || j >= st.order.length) return;
  pushUndo();
  [st.order[i], st.order[j]] = [st.order[j], st.order[i]];
  st.current = j;
  buildPages().then(() => scrollToPage(j));
}
async function deletePages() {
  const idx = targets();
  if (idx.length >= st.order.length) { toast("A PDF needs at least one page."); return; }
  if (!(await bridge.call('confirm', `Delete ${idx.length} page(s)?`, 'You can undo this with Ctrl+Z until you close the document.'))) return;
  pushUndo();
  st.order = st.order.filter((_, i) => !idx.includes(i));
  st.selPages = new Set();
  st.current = Math.min(st.current, st.order.length - 1);
  buildPages();
}
async function insertPdf() {
  const file = await bridge.call('pdf:openDialog', false);
  if (!file) return;
  const other = await bridge.call('pdf:read', file);
  const base = await PDFDocument.load(st.bytes, { ignoreEncryption: true });
  const add = await PDFDocument.load(other, { ignoreEncryption: true });
  const start = base.getPageCount();
  const copied = await base.copyPages(add, add.getPageIndices());
  copied.forEach((p) => base.addPage(p));
  pushUndo();
  st.bytes = await base.save();
  const newEntries = copied.map((_, k) => ({ src: start + k, rot: 0 }));
  const at = st.current + 1;
  st.order.splice(at, 0, ...newEntries);
  await loadBytes(await formFilled(st.bytes), { keepState: true });
  st.undo = []; // page structure changed underneath; earlier steps no longer apply
  scrollToPage(at);
  toast(`Inserted ${copied.length} page(s)`);
}

// ---------------- forms ----------------
async function readForm() {
  st.form = []; st.formValues = {}; st.encrypted = false;
  try {
    const doc = await PDFDocument.load(st.bytes, { ignoreEncryption: true });
    st.encrypted = doc.isEncrypted;
    for (const f of doc.getForm().getFields()) {
      const name = f.getName();
      const L = window.PDFLib;
      if (f instanceof L.PDFTextField) st.form.push({ name, kind: 'text', value: f.getText() || '' });
      else if (f instanceof L.PDFCheckBox) st.form.push({ name, kind: 'check', value: f.isChecked() });
      else if (f instanceof L.PDFDropdown) st.form.push({ name, kind: 'select', value: f.getSelected()[0] || '', options: f.getOptions() });
      else if (f instanceof L.PDFRadioGroup) st.form.push({ name, kind: 'radio', value: f.getSelected() || '', options: f.getOptions() });
      else if (f instanceof L.PDFOptionList) st.form.push({ name, kind: 'select', value: f.getSelected()[0] || '', options: f.getOptions() });
    }
  } catch { /* not a form, or unreadable */ }
  renderForm();
}
function renderForm() {
  $('#formcount').textContent = st.form.length ? `(${st.form.length})` : '';
  const box = $('#formfields');
  if (!st.form.length) { box.innerHTML = '<p class="muted">This PDF has no fillable fields. Use <b>Add text</b> and <b>Tick</b> to fill it in instead.</p>'; return; }
  box.innerHTML = `<p class="muted">Fill in the fields below — they update on the page.</p>${st.form.map((f, i) => {
    const label = `<label for="ff${i}">${esc(f.name)}</label>`;
    if (f.kind === 'text') return `${label}<input type="text" id="ff${i}" data-ff="${i}" value="${esc(f.value)}">`;
    if (f.kind === 'check') return `<label><input type="checkbox" data-ff="${i}" ${f.value ? 'checked' : ''}> ${esc(f.name)}</label>`;
    return `${label}<select id="ff${i}" data-ff="${i}"><option value=""></option>${f.options.map((o) => `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }).join('')}<label style="margin-top:14px"><input type="checkbox" id="flatten"> Lock the answers when saving (no longer editable)</label>`;
  $('#flatten').addEventListener('change', (e) => { st.flatten = e.target.checked; });
}
let formTimer;
$('#formfields').addEventListener('input', (e) => {
  const i = e.target.dataset.ff;
  if (i === undefined) return;
  const f = st.form[+i];
  f.value = f.kind === 'check' ? e.target.checked : e.target.value;
  st.formValues[f.name] = f;
  setDirty();
  clearTimeout(formTimer);
  formTimer = setTimeout(async () => { const keep = st.current; await loadBytes(await formFilled(st.bytes), { keepState: true }); scrollToPage(keep); }, 700);
});
function fillFormInto(doc) {
  const form = doc.getForm();
  for (const f of Object.values(st.formValues)) {
    try {
      if (f.kind === 'text') form.getTextField(f.name).setText(f.value);
      else if (f.kind === 'check') f.value ? form.getCheckBox(f.name).check() : form.getCheckBox(f.name).uncheck();
      else if (f.kind === 'radio') { if (f.value) form.getRadioGroup(f.name).select(f.value); }
      else if (f.kind === 'select') { const fld = form.getField(f.name); if (f.value) fld.select(f.value); }
    } catch (e) { console.warn('form field', f.name, e); }
  }
  return form;
}
async function formFilled(bytes) {
  if (!Object.keys(st.formValues).length) return bytes;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  fillFormInto(doc);
  return doc.save();
}

// ---------------- find ----------------
let findTimer;
$('#findq').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 250); });
async function runFind() {
  const q = $('#findq').value.trim().toLowerCase();
  const out = $('#findres');
  if (!q) { out.innerHTML = ''; return; }
  out.innerHTML = '<p class="muted">Searching…</p>';
  const hits = [];
  for (let i = 0; i < st.order.length; i++) {
    const src = st.order[i].src;
    if (!st.text[src]) {
      const page = await st.doc.getPage(src + 1);
      const tc = await page.getTextContent();
      st.text[src] = tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
        const [a, b, c, d, e, f] = it.transform;
        return { str: it.str, x: e, y: f, w: it.width, h: Math.hypot(c, d) || 10, upright: Math.abs(b) < 0.01 && Math.abs(c) < 0.01 && a > 0, family: tc.styles[it.fontName]?.fontFamily || 'sans-serif' };
      });
    }
    st.text[src].forEach((t, ti) => { const at = t.str.toLowerCase().indexOf(q); if (at >= 0) hits.push({ i, src, ti, snip: t.str }); });
  }
  out.innerHTML = hits.length ? `<p class="muted">${hits.length} match(es)</p>${hits.slice(0, 200).map((h, k) => `<div data-hit="${k}"><b>p.${h.i + 1}</b> ${esc(h.snip.slice(0, 80))}</div>`).join('')}` : '<p class="muted">No matches.</p>';
  out.onclick = (e) => {
    const d = e.target.closest('[data-hit]');
    if (!d) return;
    const h = hits[+d.dataset.hit];
    scrollToPage(h.i);
    setTimeout(() => {
      const t = st.text[h.src][h.ti];
      const p1 = toView(h.src, t.x, t.y - 0.25 * t.h); const p2 = toView(h.src, t.x + t.w, t.y + 0.95 * t.h);
      const mark = document.createElement('div');
      mark.className = 'findhit';
      Object.assign(mark.style, { left: `${Math.min(p1[0], p2[0])}px`, top: `${Math.min(p1[1], p2[1])}px`, width: `${Math.abs(p2[0] - p1[0])}px`, height: `${Math.abs(p2[1] - p1[1])}px` });
      $(`.page[data-src="${h.src}"] .overlay`).appendChild(mark);
      mark.scrollIntoView({ block: 'center' });
      setTimeout(() => mark.remove(), 4000);
    }, 120);
  };
}

// ---------------- side panel tabs ----------------
$$('.side .tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.side .tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.panel').forEach((p) => { p.hidden = p.id !== `panel-${b.dataset.panel}`; });
  if (b.dataset.panel === 'find') $('#findq').focus();
}));

// ---------------- signature ----------------
const pad = $('#sigpad');
const pctx = pad.getContext('2d');
let sigTab = 'draw'; let sigUpload = null; let padDrawn = false;
function resetPad() { pctx.clearRect(0, 0, pad.width, pad.height); padDrawn = false; }
pad.addEventListener('pointerdown', (e) => {
  const r = pad.getBoundingClientRect(); const k = pad.width / r.width;
  pctx.lineWidth = 4.5; pctx.lineCap = 'round'; pctx.lineJoin = 'round'; pctx.strokeStyle = '#111827';
  pctx.beginPath(); pctx.moveTo((e.clientX - r.left) * k, (e.clientY - r.top) * k);
  const move = (ev) => { pctx.lineTo((ev.clientX - r.left) * k, (ev.clientY - r.top) * k); pctx.stroke(); padDrawn = true; };
  const up = () => { pad.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  pad.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
function drawTyped() {
  const c = $('#sigtyped'); const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = '#111827'; x.textBaseline = 'middle';
  let size = 110;
  x.font = `${size}px ${$('#sigfont').value}`;
  while (x.measureText($('#sigtext').value).width > c.width - 40 && size > 30) { size -= 6; x.font = `${size}px ${$('#sigfont').value}`; }
  x.fillText($('#sigtext').value, 20, c.height / 2);
}
$('#sigtext').addEventListener('input', drawTyped);
$('#sigfont').addEventListener('change', drawTyped);

/** Crop a canvas to its ink and return a transparent PNG. */
function trimmed(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 <= x0 || y1 <= y0) return null;
  const pad2 = 6;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + pad2 * 2; out.height = y1 - y0 + pad2 * 2;
  out.getContext('2d').drawImage(canvas, x0 - pad2, y0 - pad2, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
/** Make the white paper behind an uploaded signature transparent. */
function knockOutWhite(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const scale = Math.min(1, 1200 / img.naturalWidth);
      c.width = img.naturalWidth * scale; c.height = img.naturalHeight * scale;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const lum = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3;
        if (lum > 200) d.data[i + 3] = 0; else if (lum > 150) d.data[i + 3] = Math.round(255 * (200 - lum) / 50);
      }
      x.putImageData(d, 0, 0);
      resolve(trimmed(c) || dataUrl);
    };
    img.src = dataUrl;
  });
}
async function openSignature() {
  if (!st.doc) return toast('Open a PDF first.');
  resetPad(); sigUpload = null; $('#sigimg').removeAttribute('src');
  const saved = await bridge.call('sig:list');
  $('#sigsaved').innerHTML = saved.length ? `<span class="small muted" style="width:100%">Your saved signatures — click to use:</span>${saved.map((s) => `<div class="s" data-sig="${s.id}"><img src="${s.data}" alt=""><button class="x" data-sigdel="${s.id}" title="Forget">✕</button></div>`).join('')}` : '';
  $('#sigsaved').onclick = async (e) => {
    const del = e.target.closest('[data-sigdel]');
    if (del) { e.stopPropagation(); await bridge.call('sig:delete', del.dataset.sigdel); return openSignature(); }
    const s = e.target.closest('[data-sig]');
    if (s) { $('#sigmodal').hidden = true; placeImage(saved.find((x) => x.id === s.dataset.sig).data); }
  };
  $('#sigmodal').hidden = false;
}
$$('[data-sigtab]').forEach((b) => b.addEventListener('click', () => {
  sigTab = b.dataset.sigtab;
  $$('[data-sigtab]').forEach((x) => x.classList.toggle('active', x === b));
  $$('[data-sigpane]').forEach((p) => { p.hidden = p.dataset.sigpane !== sigTab; });
  if (sigTab === 'type') { $('#sigtext').focus(); drawTyped(); }
}));
async function placeSignature() {
  let data = null;
  if (sigTab === 'draw') data = padDrawn ? trimmed(pad) : null;
  if (sigTab === 'type') { drawTyped(); data = $('#sigtext').value.trim() ? trimmed($('#sigtyped')) : null; }
  if (sigTab === 'upload') data = sigUpload;
  if (!data) return toast(sigTab === 'draw' ? 'Draw your signature first.' : sigTab === 'type' ? 'Type your name first.' : 'Choose an image first.');
  if ($('#sigremember').checked) await bridge.call('sig:save', { data });
  $('#sigmodal').hidden = true;
  placeImage(data, 160);
}

// ---------------- building the saved PDF ----------------
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

async function buildPdf(orderList = st.order) {
  const doc = await PDFDocument.load(st.bytes, { ignoreEncryption: true });
  const fonts = {};
  const font = async (name, bold) => {
    const key = `${name}${bold ? 'Bold' : ''}`;
    const std = { Helvetica: StandardFonts.Helvetica, HelveticaBold: StandardFonts.HelveticaBold, TimesRoman: StandardFonts.TimesRoman, TimesRomanBold: StandardFonts.TimesRomanBold, Courier: StandardFonts.Courier, CourierBold: StandardFonts.CourierBold }[key] || StandardFonts.Helvetica;
    return (fonts[key] = fonts[key] || await doc.embedFont(std));
  };
  const images = {};
  const pages = doc.getPages();

  for (const [srcStr, list] of Object.entries(st.anns)) {
    const page = pages[+srcStr];
    if (!page) continue;
    for (const a of list) {
      if (a.type === 'ink') {
        for (let k = 1; k < a.points.length; k++) {
          page.drawLine({ start: { x: a.points[k - 1][0], y: a.points[k - 1][1] }, end: { x: a.points[k][0], y: a.points[k][1] }, thickness: a.width, color: hexToRgb(a.color), lineCap: LineCapStyle.Round });
        }
        continue;
      }
      // Local frame of the box: right/down directions in PDF space for the rotation it was made at.
      const R = (a.rot * Math.PI) / 180;
      const right = [Math.cos(R), Math.sin(R)]; const down = [Math.sin(R), -Math.cos(R)];
      const P = (u, v) => ({ x: a.ax + right[0] * u + down[0] * v, y: a.ay + right[1] * u + down[1] * v });
      const rotate = degrees(a.rot);
      if (a.type === 'text') {
        const f = await font(a.font, a.bold);
        const safe = (line) => [...line].map((ch) => { try { f.encodeText(ch); return ch; } catch { return '?'; } }).join('');
        a.text.split('\n').forEach((line, i) => {
          if (!line) return;
          const o = P(0, a.size * (0.93 + 1.2 * i));
          page.drawText(safe(line), { x: o.x, y: o.y, size: a.size, font: f, color: hexToRgb(a.color), rotate });
        });
      } else if (a.type === 'highlight' || a.type === 'whiteout' || a.type === 'rect') {
        const o = P(0, a.h);
        const opts = { x: o.x, y: o.y, width: a.w, height: a.h, rotate };
        if (a.type === 'highlight') Object.assign(opts, { color: hexToRgb(a.color), opacity: 0.35, blendMode: BlendMode.Multiply });
        if (a.type === 'whiteout') Object.assign(opts, { color: rgb(1, 1, 1) });
        if (a.type === 'rect') Object.assign(opts, { borderColor: hexToRgb(a.color), borderWidth: 1.5 });
        page.drawRectangle(opts);
      } else if (a.type === 'image') {
        if (!images[a.data]) {
          const bin = Uint8Array.from(atob(a.data.split(',')[1]), (c) => c.charCodeAt(0));
          images[a.data] = a.data.startsWith('data:image/png') ? await doc.embedPng(bin) : await doc.embedJpg(bin);
        }
        const o = P(0, a.h);
        page.drawImage(images[a.data], { x: o.x, y: o.y, width: a.w, height: a.h, rotate });
      } else if (a.type === 'check' || a.type === 'cross') {
        const segs = a.type === 'check' ? [[0.15, 0.55, 0.4, 0.8], [0.4, 0.8, 0.85, 0.2]] : [[0.2, 0.2, 0.8, 0.8], [0.8, 0.2, 0.2, 0.8]];
        for (const [u1, v1, u2, v2] of segs) page.drawLine({ start: P(u1 * a.w, v1 * a.h), end: P(u2 * a.w, v2 * a.h), thickness: a.w * 0.12, color: hexToRgb(a.color), lineCap: LineCapStyle.Round });
      }
    }
  }

  const form = fillFormInto(doc);
  if (st.flatten) { try { form.flatten(); } catch (e) { console.warn('flatten', e); } }

  // Rebuild the page list in the new order, applying rotations and dropping deleted pages.
  for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
  for (const entry of orderList) {
    const pg = pages[entry.src];
    doc.addPage(pg);
    pg.setRotation(degrees((st.baseRot[entry.src] + entry.rot) % 360));
  }
  return doc.save();
}

async function save(saveAs = false) {
  if (!st.doc) return;
  document.activeElement?.blur?.();
  try {
    const out = await buildPdf();
    const target = await bridge.call('pdf:save', st.file, out, saveAs);
    if (!target) return;
    st.file = target;
    st.bytes = out;
    $('#docname').textContent = target.split(/[\\/]/).pop();
    document.title = `${target.split(/[\\/]/).pop()} - PDF Editor`;
    await readForm();
    await loadBytes(out);
    setDirty(false);
    toast(`Saved to ${target}. (The previous version was backed up.)`);
  } catch (e) {
    console.error(e);
    toast(`Couldn't save: ${e.message}`);
  }
}

async function extractPages() {
  const idx = targets();
  const out = await buildPdf(idx.map((i) => st.order[i]));
  const base = st.file ? st.file.replace(/\.pdf$/i, '') : 'document';
  const target = await bridge.call('pdf:save', `${base} (pages ${idx.map((i) => i + 1).join(',')}).pdf`, out, true);
  if (target) toast(`Saved ${idx.length} page(s) to ${target}`);
}

// ---------------- commands ----------------
const commands = {
  open: async () => { if (st.dirty && !(await bridge.call('confirm', 'Discard unsaved changes?'))) return; const f = await bridge.call('pdf:openDialog', false); if (f) openFile(f); },
  save: () => save(false),
  saveas: () => save(true),
  undo, redo,
  zoomin: () => setZoom(st.zoom * 1.2),
  zoomout: () => setZoom(st.zoom / 1.2),
  fitwidth: fitWidth,
  rotl: () => rotatePages(-90),
  rotr: () => rotatePages(90),
  up: () => movePage(-1),
  down: () => movePage(1),
  delpage: deletePages,
  insert: insertPdf,
  extract: extractPages,
  date: () => {
    if (!st.doc) return;
    const s = textStyle();
    const text = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    const { src, vx, vy } = centerOfCurrentPage(text.length * s.size * 0.5, s.size * 1.2);
    pushUndo();
    const a = addAnn(src, { id: newId(), type: 'text', text, ...s, ...boxFromView(src, vx, vy, 0, 0) });
    setTool('select'); select(a.id);
    toast('Drag the date into place.');
  },
  signature: openSignature,
  sigclose: () => { $('#sigmodal').hidden = true; },
  sigclear: resetPad,
  sigplace: placeSignature,
  sigupload: async () => { const d = await bridge.call('image:openDialog'); if (d) { sigUpload = await knockOutWhite(d); $('#sigimg').src = sigUpload; } },
  image: async () => { if (!st.doc) return toast('Open a PDF first.'); const d = await bridge.call('image:openDialog'); if (d) placeImage(d, 220); },
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (b) { e.preventDefault(); Promise.resolve(commands[b.dataset.cmd]()).catch((err) => toast(err.message)); }
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); commands.open(); return; }
  if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(st.zoom * 1.2); return; }
  if (mod && e.key === '-') { e.preventDefault(); setZoom(st.zoom / 1.2); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
  if (e.key === 'Escape') { setTool('select'); select(null); return; }
  const keys = { v: 'select', t: 'text', e: 'edittext', h: 'highlight', p: 'draw' };
  if (!mod && keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
});

// Ask before closing with unsaved work.
let closing = false;
window.addEventListener('beforeunload', (e) => {
  if (!st.dirty || closing) return;
  e.returnValue = false;
  bridge.call('confirm', 'Close without saving?', 'Your changes to this PDF will be lost.').then((ok) => { if (ok) { closing = true; window.close(); } });
});

// ---------------- start ----------------
window.__editor = { st, buildPdf, openFile, setTool, commands }; // used by automated tests
const file = new URLSearchParams(location.search).get('file');
if (file) openFile(file);
