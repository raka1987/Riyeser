// PDF viewer + editor. pdf.js draws the pages; pdf-lib writes the changes into the PDF when you save.
// Everything you add is kept as an editable object (text, boxes, signatures...) until you save.
import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle, pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, showText, setTextRenderingMode, TextRenderingMode } = window.PDFLib;
const bridge = window.api;
let appTitle = 'PDF Editor';
bridge.call('app:version').then(async (v) => {
  const info = await bridge.call('app:info').catch(() => null);
  appTitle = `${info?.standalone ? 'Riyeser PDF' : 'PDF Editor'} ${v}`;
  if (!st.file) document.title = appTitle; else document.title = `${st.file.split(/[\\/]/).pop()} — ${appTitle}`;
}).catch(() => {});
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
  pageNumbers: null,   // { format, position } when page numbers are switched on
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
  st.pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
  st.baseRot = st.pages.map((pg) => pg.rotate || 0);
  if (!keepState) {
    st.order = st.baseRot.map((_, i) => ({ src: i, rot: 0 }));
    st.anns = {}; st.text = {}; st.undo = []; st.redo = []; st.selected = null; st.current = 0; st.selPages = new Set();
  }
  $('#empty').hidden = true;
  // Work out "fit to width" before the first drawing, so a big page isn't drawn twice.
  if (!keepState && fitMode && st.pages[0]) {
    const w = st.pages[0].getViewport({ scale: PX_PER_PT, rotation: st.baseRot[0] % 360 }).width;
    st.zoom = Math.min(4, Math.max(0.25, Math.min(2, ($('#viewer').clientWidth - 60) / w)));
    $('#zoomlabel').textContent = `${Math.round(st.zoom * 100)}%`;
  }
  buildPages();
}

async function openFile(file) {
  try {
    const bytes = await bridge.call('pdf:read', file);
    st.file = file;
    st.bytes = bytes;
    document.title = `${file.split(/[\\/]/).pop()} — ${appTitle}`;
    $('#docname').textContent = file.split(/[\\/]/).pop();
    $('#docname').title = file;
    // A PDF the engine gets stuck on must not leave a grey window: give up after a while and use the backup viewer.
    const limit = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took too long`)), ms))]);
    st.firstShown = false; st.form = []; st.formValues = {}; st.encrypted = false; renderForm();
    await limit(loadBytes(bytes), 20000, 'Opening the pages');
    setDirty(false);
    watchFirstPage(file);
    requestAnimationFrame(fitWidth);
  } catch (e) {
    toast(`This PDF couldn't be drawn here (${e.message}), so it's open in the basic viewer.`);
    bridge.call('pdf:basicView', file).catch(() => {});
  }
}

/** Once the first page is showing: fillable fields, password protection and scanned pages (none of these hold up opening). */
async function afterFirstPage() {
  const doc = st.doc;
  try {
    const [fields, meta] = await Promise.all([doc.getFieldObjects().catch(() => null), doc.getMetadata().catch(() => null)]);
    if (doc !== st.doc) return;
    if (meta?.info?.EncryptFilterName) { st.encrypted = true; toast('This PDF is password-protected. You can view it, but saving changes may not work.'); }
    if (fields && Object.keys(fields).length) await readForm();
  } catch { /* not a form */ }
  checkIfScanned().catch(() => {});
}

/** If the first page comes out empty or fails to draw, show the PDF in the backup viewer as well. */
function watchFirstPage(file) {
  st.firstPageCheck = { file, done: false };
  setTimeout(() => {
    const c = st.firstPageCheck;
    if (!c || c.done || c.file !== st.file) return;
    c.done = true;
    if (c.failed || !$('.page canvas') || !pageHasInk($('.page canvas'))) offerBasicViewer(file, c.failed ? 'couldn\'t be drawn' : 'looks blank');
  }, 6000);
}
function pageHasInk(canvas) {
  try {
    const { width, height } = canvas; if (!width || !height) return false;
    const d = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    for (let i = 0; i < d.length; i += 4 * 7) if (d[i + 3] > 0 && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) return true;
    return false;
  } catch { return true; }
}
function offerBasicViewer(file, why) {
  toast(`This page ${why} here. Showing it in the basic viewer too — use that to read it.`);
  bridge.call('pdf:basicView', file).catch(() => {});
}

// ---------------- page layout & drawing ----------------
function viewportFor(page, entry) {
  return page.getViewport({ scale: st.zoom * PX_PER_PT, rotation: (st.baseRot[entry.src] + entry.rot) % 360 });
}

const liveRenders = new Set();
async function buildPages() {
  const token = ++renderToken;
  for (const t of liveRenders) { try { t.cancel(); } catch { /* finished */ } }
  liveRenders.clear();
  const wrap = $('#pages');
  wrap.innerHTML = '';
  st.vps = {};
  for (let i = 0; i < st.order.length; i++) {
    const entry = st.order[i];
    const page = st.pages?.[entry.src] || await st.doc.getPage(entry.src + 1);
    if (token !== renderToken) return;
    const vp = viewportFor(page, entry);
    st.vps[entry.src] = vp;
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.src = entry.src;
    el.dataset.idx = i;
    el.style.width = `${vp.width}px`; el.style.height = `${vp.height}px`;
    el.innerHTML = '<canvas></canvas><div class="overlay"><svg></svg></div><div class="drawing">Drawing this page…</div>';
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
  const page = st.pages?.[src] || await st.doc.getPage(src + 1);
  const vp = viewportFor(page, entry);
  const ratio = window.devicePixelRatio || 1;
  const canvas = el.querySelector('canvas');
  canvas.width = Math.floor(vp.width * ratio); canvas.height = Math.floor(vp.height * ratio);
  canvas.style.width = `${vp.width}px`; canvas.style.height = `${vp.height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const task = page.render({ canvasContext: ctx, viewport: vp });
  liveRenders.add(task);
  try { await task.promise; }
  catch (e) {
    if (/cancel/i.test(e?.name || e?.message || '')) return; // the view changed; a fresh drawing takes over
    if (src === 0 && st.firstPageCheck) st.firstPageCheck.failed = true;
  } finally { liveRenders.delete(task); }
  el.querySelector('.drawing')?.remove();
  copyToThumb(src, canvas);
  if (!st.firstShown) { st.firstShown = true; afterFirstPage(); }
  if (!st.text[src]) {
    await new Promise((r) => setTimeout(r, 30)); // let the page appear before reading its words for search
    const tc = await page.getTextContent();
    st.text[src] = tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
      const [a, b, c, d, e, f] = it.transform;
      const h = Math.hypot(c, d) || Math.abs(d) || 10;
      return { str: it.str, x: e, y: f, w: it.width, h, upright: Math.abs(b) < 0.01 && Math.abs(c) < 0.01 && a > 0, family: tc.styles[it.fontName]?.fontFamily || 'sans-serif' };
    });
    drawOverlay(src);
  }
}

/** Two short lines forming an arrow head at p1 (works in any coordinate space). */
function arrowHead(p0, p1, len) {
  const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  const a = (d) => [p1[0] - len * Math.cos(ang + d), p1[1] - len * Math.sin(ang + d)];
  return [a(Math.PI / 7), p1, a(-Math.PI / 7)];
}
/** Font size so a diagonal watermark fills a page nicely. */
const wmSize = (text, w, h) => Math.min(120, (Math.hypot(w, h) * 0.62) / Math.max(4, text.length * 0.74));

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

  // page number preview
  if (st.pageNumbers) {
    const idx = st.order.findIndex((o) => o.src === src);
    const pn = document.createElement('div');
    pn.className = 'pnum';
    pn.textContent = st.pageNumbers.format.replace('{n}', idx + 1).replace('{total}', st.order.length);
    Object.assign(pn.style, { fontSize: `${10 * vp.scale}px`, [st.pageNumbers.position === 'top' ? 'top' : 'bottom']: `${18 * vp.scale}px` });
    ov.appendChild(pn);
  }
  for (const a of st.anns[src] || []) {
    if (a.type === 'ocr') continue; // invisible text layer
    if (a.type === 'watermark') {
      const wm = document.createElement('div');
      wm.className = 'wm';
      wm.innerHTML = `<span style="color:${a.color};opacity:${a.opacity};font-size:${wmSize(a.text, vp.width / vp.scale, vp.height / vp.scale) * vp.scale}px">${esc(a.text)}</span>`;
      ov.appendChild(wm);
      continue;
    }
    if (a.points) {
      let pts = a.points.map(([x, y]) => toView(src, x, y));
      if (a.type === 'arrow') pts = [...pts, ...arrowHead(pts[0], pts[1], 12 * vp.scale)];
      const ptsStr = pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.setAttribute('points', ptsStr);
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
      if (a.type === 'underline') el.style.borderBottom = `${Math.max(1, 1.4 * vp.scale)}px solid ${a.color}`;
      if (a.type === 'strike') el.style.background = `linear-gradient(transparent calc(50% - ${0.7 * vp.scale}px), ${a.color} calc(50% - ${0.7 * vp.scale}px), ${a.color} calc(50% + ${0.7 * vp.scale}px), transparent calc(50% + ${0.7 * vp.scale}px))`;
      if (a.type === 'ellipse') Object.assign(el.style, { border: `${Math.max(1, 1.5 * vp.scale)}px solid ${a.color}`, borderRadius: '50%' });
      if (a.type === 'stamp') {
        Object.assign(el.style, { color: a.color, fontSize: `${a.h * vp.scale * 0.42}px` });
        el.innerHTML = `${esc(a.text)}${a.sub ? `<small style="font-size:${a.h * vp.scale * 0.2}px">${esc(a.sub)}</small>` : ''}`;
      }
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
function copyToThumb(src, from) {
  const d = document.querySelector(`.thumb[data-src="${src}"]`);
  if (!d || !from.width) return;
  const k = 150 / Math.max(from.width, from.height);
  const c = d.querySelector('canvas');
  c.width = Math.max(1, Math.round(from.width * k)); c.height = Math.max(1, Math.round(from.height * k));
  c.getContext('2d').drawImage(from, 0, 0, c.width, c.height);
  d.dataset.drawn = '1';
}
async function drawThumb(d) {
  d.dataset.drawn = '1';
  // Pages on screen are drawn anyway: their thumbnail is copied from that, so a big drawing isn't drawn twice.
  await new Promise((r) => setTimeout(r, 400));
  const entry = st.order[+d.dataset.idx];
  if (!entry) return;
  const main = document.querySelector(`.page[data-src="${entry.src}"]`);
  if (main?.dataset.drawn) return;
  const page = st.pages?.[entry.src] || await st.doc.getPage(entry.src + 1);
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
let fitMode = true; // keep fitting the page to the window until the user zooms by hand
function setZoom(z, { fromFit = false } = {}) {
  if (!fromFit) fitMode = false;
  const nz = Math.min(4, Math.max(0.25, z));
  if (fromFit && Math.abs(nz - st.zoom) < 0.005) return; // already that size: don't redraw
  st.zoom = nz;
  $('#zoomlabel').textContent = `${Math.round(st.zoom * 100)}%`;
  if (st.doc) { const cur = st.current; buildPages().then(() => scrollToPage(cur)); }
}
async function fitWidth() {
  if (!st.doc) return;
  const entry = st.order[st.current] || st.order[0];
  const page = await st.doc.getPage(entry.src + 1);
  const w = page.getViewport({ scale: PX_PER_PT, rotation: (st.baseRot[entry.src] + entry.rot) % 360 }).width;
  fitMode = true;
  setZoom(Math.min(2, ($('#viewer').clientWidth - 60) / w), { fromFit: true });
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (fitMode && st.doc) fitWidth(); }, 250); });

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
    if (!f.a.points) { const [l, t] = toView(src, f.a.ax, f.a.ay); drag.l = l; drag.t = t; } else drag.points = f.a.points.map((p) => [...p]);
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
    // Text we recognised ourselves: drop the old words from the hidden text layer so only the new ones remain.
    if (t.ocrLine) {
      const layer = (st.anns[src] || []).find((a) => a.type === 'ocr');
      if (layer) layer.lines = layer.lines.filter((l) => !(l.text === t.ocrLine.text && Math.abs(l.ax - t.ocrLine.ax) < 0.5 && Math.abs(l.ay - t.ocrLine.ay) < 0.5));
    }
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

  if (st.tool === 'line' || st.tool === 'arrow') {
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('fill', 'none'); poly.setAttribute('stroke', $('#color').value); poly.setAttribute('stroke-width', 2 * st.vps[src].scale); poly.setAttribute('stroke-linecap', 'round');
    ov.querySelector('svg').appendChild(poly);
    drag = { kind: 'seg', src, ov, p0: [vx, vy], p1: [vx, vy], poly, arrow: st.tool === 'arrow' };
    e.preventDefault(); return;
  }

  if (['highlight', 'rect', 'whiteout', 'underline', 'strike', 'ellipse', 'redact'].includes(st.tool)) {
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
    if (a.points) {
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
  } else if (drag.kind === 'seg') {
    const r = drag.ov.getBoundingClientRect();
    drag.p1 = [e.clientX - r.left, e.clientY - r.top];
    const pts = drag.arrow ? [drag.p0, drag.p1, ...arrowHead(drag.p0, drag.p1, 12 * st.vps[drag.src].scale)] : [drag.p0, drag.p1];
    drag.poly.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
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
  } else if (d.kind === 'seg') {
    if (Math.hypot(d.p1[0] - d.p0[0], d.p1[1] - d.p0[1]) > 5) {
      pushUndo();
      addAnn(d.src, { id: newId(), type: d.arrow ? 'arrow' : 'line', color: $('#color').value, width: 2, points: [toPdf(d.src, ...d.p0), toPdf(d.src, ...d.p1)] });
    }
    drawOverlay(d.src);
  } else if (d.kind === 'box') {
    d.prev.remove();
    if (d.x1 === undefined || Math.abs(d.x1 - d.x0) < 4 || Math.abs(d.y1 - d.y0) < 4) return;
    pushUndo();
    const color = st.tool === 'highlight' ? '#facc15' : st.tool === 'redact' ? '#000000' : $('#color').value;
    if (st.tool === 'redact') toast('Blacked out. When you save, whatever is underneath is permanently removed from the file.');
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
      if (a.type === 'ocr') {
        // Invisible text placed exactly over the words in the scan, so the PDF becomes searchable and selectable.
        const f = await font('Helvetica', false);
        const fontKey = page.node.newFontDictionary(f.name, f.ref);
        const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
        for (const l of a.lines) {
          const safe = [...l.text].map((ch) => { try { f.encodeText(ch); return ch; } catch { return ' '; } }).join('');
          if (!safe.trim()) continue;
          const size = Math.max(4, l.h * 0.85);
          const natural = f.widthOfTextAtSize(safe, size) || 1;
          const sx = l.w / natural;
          const R = (l.rot * Math.PI) / 180;
          const down = [Math.sin(R), -Math.cos(R)];
          const ox = l.ax + down[0] * l.h * 0.8; const oy = l.ay + down[1] * l.h * 0.8; // baseline start
          ops.push(setFontAndSize(fontKey, size), setTextMatrix(sx * Math.cos(R), sx * Math.sin(R), -Math.sin(R), Math.cos(R), ox, oy), showText(f.encodeText(safe)));
        }
        ops.push(endText(), popGraphicsState());
        page.pushOperators(...ops);
        continue;
      }
      if (a.type === 'watermark') {
        const f = await font('Helvetica', true);
        const { width: pw, height: ph } = page.getSize();
        // as big as fits diagonally with a margin, measured with the real font
        const size = Math.min(120, (Math.hypot(pw, ph) * 0.62) / Math.max(1, f.widthOfTextAtSize(a.text, 1)));
        const tw = f.widthOfTextAtSize(a.text, size);
        const ang = (35 * Math.PI) / 180;
        // centre the rotated text on the page
        const x = pw / 2 - (Math.cos(ang) * tw) / 2 + (Math.sin(ang) * size * 0.35);
        const y = ph / 2 - (Math.sin(ang) * tw) / 2 - (Math.cos(ang) * size * 0.35);
        page.drawText(a.text, { x, y, size, font: f, color: hexToRgb(a.color), opacity: a.opacity, rotate: degrees(35) });
        continue;
      }
      if (a.type === 'line' || a.type === 'arrow') {
        const [p0, p1] = a.points;
        const segs = [[p0, p1]];
        if (a.type === 'arrow') { const h = arrowHead(p0, p1, 9); segs.push([h[0], h[1]], [h[1], h[2]]); }
        for (const [s0, s1] of segs) page.drawLine({ start: { x: s0[0], y: s0[1] }, end: { x: s1[0], y: s1[1] }, thickness: a.width, color: hexToRgb(a.color), lineCap: LineCapStyle.Round });
        continue;
      }
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
      } else if (a.type === 'underline' || a.type === 'strike') {
        const v = a.type === 'underline' ? a.h : a.h / 2;
        page.drawLine({ start: P(0, v), end: P(a.w, v), thickness: 1.3, color: hexToRgb(a.color) });
      } else if (a.type === 'ellipse') {
        const c = P(a.w / 2, a.h / 2);
        page.drawEllipse({ x: c.x, y: c.y, xScale: a.w / 2, yScale: a.h / 2, borderColor: hexToRgb(a.color), borderWidth: 1.5, rotate });
      } else if (a.type === 'redact') {
        const o = P(0, a.h);
        page.drawRectangle({ x: o.x, y: o.y, width: a.w, height: a.h, rotate, color: rgb(0, 0, 0) });
      } else if (a.type === 'stamp') {
        const o = P(0, a.h);
        page.drawRectangle({ x: o.x, y: o.y, width: a.w, height: a.h, rotate, borderColor: hexToRgb(a.color), borderWidth: 2.5, color: rgb(1, 1, 1), opacity: 0.35, borderOpacity: 1 });
        const f = await font('Helvetica', true);
        const main = a.text.toUpperCase();
        const size = Math.min(a.h * 0.42, (a.w * 0.86) / Math.max(1, f.widthOfTextAtSize(main, 1)));
        const mw = f.widthOfTextAtSize(main, size);
        const mo = P((a.w - mw) / 2, a.sub ? a.h * 0.55 : a.h * 0.64);
        page.drawText(main, { x: mo.x, y: mo.y, size, font: f, color: hexToRgb(a.color), rotate });
        if (a.sub) {
          const f2 = await font('Helvetica', false);
          const s2 = Math.min(a.h * 0.2, (a.w * 0.86) / Math.max(1, f2.widthOfTextAtSize(a.sub, 1)));
          const so = P((a.w - f2.widthOfTextAtSize(a.sub, s2)) / 2, a.h * 0.85);
          page.drawText(a.sub, { x: so.x, y: so.y, size: s2, font: f2, color: hexToRgb(a.color), rotate });
        }
      } else if (a.type === 'check' || a.type === 'cross') {
        const segs = a.type === 'check' ? [[0.15, 0.55, 0.4, 0.8], [0.4, 0.8, 0.85, 0.2]] : [[0.2, 0.2, 0.8, 0.8], [0.8, 0.2, 0.2, 0.8]];
        for (const [u1, v1, u2, v2] of segs) page.drawLine({ start: P(u1 * a.w, v1 * a.h), end: P(u2 * a.w, v2 * a.h), thickness: a.w * 0.12, color: hexToRgb(a.color), lineCap: LineCapStyle.Round });
      }
    }
  }

  const form = fillFormInto(doc);
  if (st.flatten) { try { form.flatten(); } catch (e) { console.warn('flatten', e); } }

  // Rebuild the page list in the new order, applying rotations and dropping deleted pages.
  const keep = new Set(orderList.map((e) => e.src));
  pages.forEach((pg, i) => { if (!keep.has(i)) dropPageWidgets(doc, pg); });
  for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
  for (const entry of orderList) {
    const pg = pages[entry.src];
    doc.addPage(pg);
    pg.setRotation(degrees((st.baseRot[entry.src] + entry.rot) % 360));
  }
  if (st.pageNumbers) {
    const f = await font('Helvetica', false);
    doc.getPages().forEach((pg, i) => {
      const label = st.pageNumbers.format.replace('{n}', i + 1).replace('{total}', orderList.length);
      const { width, height } = pg.getSize();
      const tw = f.widthOfTextAtSize(label, 10);
      pg.drawText(label, { x: (width - tw) / 2, y: st.pageNumbers.position === 'top' ? height - 26 : 18, size: 10, font: f, color: rgb(0.2, 0.2, 0.2) });
    });
  }
  removeUnused(doc); // deleted pages and replaced content are really gone from the file
  const bytes = await doc.save();
  // Redaction: pages with blacked-out areas are turned into pictures, so the hidden text is really gone.
  const redacted = orderList.map((e, i) => ((st.anns[e.src] || []).some((a) => a.type === 'redact') ? i : -1)).filter((i) => i >= 0);
  return redacted.length ? flattenPages(bytes, redacted) : bytes;
}

/**
 * Permanently drop everything the document no longer uses. The PDF library keeps removed pages, replaced
 * pictures and old text inside the file (just unused) - which would leave redacted or deleted content recoverable.
 */
function removeUnused(doc) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = window.PDFLib;
  const ctx = doc.context;
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt].filter(Boolean);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      const obj = ctx.lookup(o);
      if (obj) stack.push(obj);
    } else if (o instanceof PDFDict) { for (const [, v] of o.entries()) stack.push(v); }
    else if (o instanceof PDFArray) { for (const v of o.asArray()) stack.push(v); }
    else if (o instanceof PDFStream) { stack.push(o.dict); }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

/** Detach a page's form fields from the form, so nothing keeps the (removed/replaced) page alive in the file. */
function dropPageWidgets(doc, page) {
  const { PDFName, PDFArray, PDFRef } = window.PDFLib;
  const annots = page.node.lookup(PDFName.of('Annots'));
  const gone = new Set(annots instanceof PDFArray ? annots.asArray().filter((r) => r instanceof PDFRef).map((r) => r.tag) : []);
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (!gone.size || !acro) return;
  const prune = (arr) => {
    for (let k = arr.size() - 1; k >= 0; k--) {
      const ref = arr.get(k);
      if (ref instanceof PDFRef && gone.has(ref.tag)) { arr.remove(k); continue; }
      const d = doc.context.lookup(ref);
      const kids = d && d.lookup ? d.lookup(PDFName.of('Kids')) : null;
      if (kids instanceof PDFArray) { prune(kids); if (kids.size() === 0) arr.remove(k); }
    }
  };
  const fields = acro.lookup(PDFName.of('Fields'));
  if (fields instanceof PDFArray) prune(fields);
}

/** Replace the given pages with pictures of themselves (removes any text/objects underneath). */
async function flattenPages(bytes, pageIndexes, { dpi = 200, quality = 0.9 } = {}) {
  const src = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/', isEvalSupported: false }).promise;
  const out = await PDFDocument.load(bytes);
  for (const i of pageIndexes) {
    const page = await src.getPage(i + 1);
    const vp = page.getViewport({ scale: dpi / 72, rotation: 0 });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const img = await out.embedJpg(Uint8Array.from(atob(c.toDataURL('image/jpeg', quality).split(',')[1]), (ch) => ch.charCodeAt(0)));
    const old = out.getPage(i);
    const { width, height } = old.getSize();
    const rot = old.getRotation().angle;
    const fresh = out.insertPage(i, [width, height]);
    fresh.drawImage(img, { x: 0, y: 0, width, height });
    fresh.setRotation(degrees(rot));
    dropPageWidgets(out, old); // its form fields are now part of the picture
    out.removePage(i + 1);
  }
  src.destroy();
  removeUnused(out);
  return out.save();
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
    document.title = `${target.split(/[\\/]/).pop()} — ${appTitle}`;
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

// ---------------- OCR (recognise text in scanned pages) ----------------
let ocrBusy = false;
async function recognisePages() {
  if (!st.doc || ocrBusy) return;
  const todo = st.order.map((o, i) => ({ ...o, i })).filter((o) => !(st.text[o.src] || []).length || (st.anns[o.src] || []).some((a) => a.type === 'ocr'));
  if (!todo.length) { toast('This PDF already contains text — nothing to recognise.'); return; }
  ocrBusy = true;
  $('#scanbanner').hidden = true;
  const btn = $('[data-cmd="ocr"]'); btn.disabled = true;
  pushUndo();
  let lines = 0;
  try {
    for (const [n, o] of todo.entries()) {
      btn.textContent = `Reading page ${n + 1} of ${todo.length}…`;
      const page = await st.doc.getPage(o.src + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(200 / 72, 3000 / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale, rotation: (st.baseRot[o.src] + o.rot) % 360 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Render without our own additions so only the original page is read.
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const r = await bridge.call('ocr:image', canvas.toDataURL('image/png'));
      const found = r.lines.map((l) => {
        const [ax, ay] = vp.convertToPdfPoint(l.x0, l.y0);
        return { text: l.text, ax, ay, w: (l.x1 - l.x0) / scale, h: (l.y1 - l.y0) / scale, rot: vp.rotation };
      });
      st.anns[o.src] = (st.anns[o.src] || []).filter((a) => a.type !== 'ocr');
      const annId = newId();
      if (found.length) addAnn(o.src, { id: annId, type: 'ocr', lines: found });
      // Make the new text usable straight away for Find and Edit text.
      st.text[o.src] = found.map((l) => ({ str: l.text, x: l.ax, y: l.ay - l.h * 0.8, w: l.w, h: l.h * 0.9, upright: l.rot === 0, family: 'sans-serif', ocrLine: l }));
      lines += found.length;
    }
    setDirty();
    toast(`Recognised ${lines} line(s) of text on ${todo.length} page(s). Save to keep it — the PDF will then be searchable and copyable in any PDF app.`);
  } catch (e) {
    toast(`Text recognition failed: ${e.message}`);
  } finally {
    ocrBusy = false; btn.disabled = false; btn.textContent = '🔍 Recognise text';
  }
}

async function checkIfScanned() {
  let empty = 0;
  const n = Math.min(st.doc.numPages, 3);
  for (let i = 1; i <= n; i++) {
    const known = st.text[i - 1];
    const has = known ? known.length > 0 : (await (await st.doc.getPage(i)).getTextContent()).items.some((it) => it.str && it.str.trim());
    if (!has) empty++;
  }
  $('#scanbanner').hidden = empty === 0;
}

// ---------------- dialogs ----------------
function dialog(html, onOpen) {
  return new Promise((resolve) => {
    $('#dlgbox').innerHTML = html;
    $('#dlg').hidden = false;
    const done = (v) => { $('#dlg').hidden = true; resolve(v); };
    $('#dlgbox').onclick = (e) => { const b = e.target.closest('[data-dlg]'); if (b) done(b.dataset.dlg === 'cancel' ? null : b.dataset.dlg); };
    if (onOpen) onOpen(done);
  });
}
const today = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
async function needSaved(what) {
  if (!st.file) { toast(`Save the PDF first, then ${what}.`); return false; }
  if (st.dirty) {
    if (!(await bridge.call('confirm', 'Save your changes first?', `To ${what}, the PDF needs to be saved.`))) return false;
    await save(false);
    if (st.dirty) return false;
  }
  return true;
}
function placeBox(ann, wPt, hPt) {
  const { src, vx, vy } = centerOfCurrentPage(wPt, hPt);
  pushUndo();
  const a = addAnn(src, { id: newId(), ...ann, ...boxFromView(src, vx, vy, wPt * st.vps[src].scale, hPt * st.vps[src].scale) });
  setTool('select'); select(a.id);
  return a;
}

const tools = {
  basicview: async () => { if (!st.file) throw new Error('Open a PDF first.'); await bridge.call('pdf:basicView', st.file); },
  async stamp() {
    if (!st.doc) return;
    const presets = [['Approved', '#15803d'], ['Paid', '#15803d'], ['Received', '#1d4ed8'], ['Checked', '#1d4ed8'], ['Draft', '#b91c1c'], ['Rejected', '#b91c1c'], ['Confidential', '#b91c1c'], ['Copy', '#6b7280'], ['Void', '#6b7280']];
    const pick = await dialog(`<div class="row"><h2 style="margin:0">Add a stamp</h2><span class="spacer"></span><button data-dlg="cancel">✕</button></div>
      <div class="stampgrid">${presets.map(([t, c]) => `<button data-dlg="${t}|${c}" style="color:${c};border-color:${c}">${t.toUpperCase()}</button>`).join('')}</div>
      <div class="dlgrow"><label>Custom</label><input id="stxt" placeholder="e.g. Entered in accounts" style="flex:1"><button data-dlg="custom">Add</button></div>
      <label class="small"><input type="checkbox" id="sdate" checked> Show today's date (${today()})</label>`, () => {});
    if (!pick) return;
    const withDate = $('#sdate')?.checked !== false;
    let [text, color] = pick === 'custom' ? [$('#stxt').value.trim(), $('#color').value] : pick.split('|');
    if (!text) return;
    placeBox({ type: 'stamp', text, color, sub: withDate ? today() : '' }, Math.max(120, text.length * 13), withDate ? 54 : 44);
    toast('Drag the stamp into place. Use the blue corner to resize.');
  },
  async watermark() {
    if (!st.doc) return;
    const existing = Object.values(st.anns).flat().find((a) => a.type === 'watermark');
    const r = await dialog(`<h2 style="margin-top:0">Watermark</h2>
      <div class="dlgrow"><label>Text</label><input id="wtxt" value="${esc(existing?.text || 'CONFIDENTIAL')}" style="flex:1"></div>
      <div class="dlgrow"><label>Colour</label><input type="color" id="wcol" value="${existing?.color || '#9ca3af'}"><label style="min-width:auto">Strength</label><input type="range" id="wop" min="0.08" max="0.6" step="0.02" value="${existing?.opacity || 0.22}"></div>
      <div class="dlgrow"><label>Pages</label><select id="wpages"><option value="all">All pages</option><option value="this">This page only</option></select></div>
      <div class="row" style="margin-top:14px">${existing ? '<button data-dlg="remove">Remove watermark</button>' : ''}<span class="spacer"></span><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Apply</button></div>`);
    if (!r) return;
    pushUndo();
    for (const k of Object.keys(st.anns)) st.anns[k] = st.anns[k].filter((a) => a.type !== 'watermark');
    if (r === 'ok') {
      const text = $('#wtxt').value.trim() || 'CONFIDENTIAL';
      const targetsSrc = $('#wpages').value === 'all' ? st.order.map((o) => o.src) : [st.order[st.current].src];
      for (const src of targetsSrc) addAnn(src, { id: newId(), type: 'watermark', text, color: $('#wcol').value, opacity: +$('#wop').value });
    }
    Object.keys(st.vps).forEach((x) => drawOverlay(+x));
  },
  async pagenumbers() {
    if (!st.doc) return;
    const r = await dialog(`<h2 style="margin-top:0">Page numbers</h2>
      <div class="dlgrow"><label>Style</label><select id="pfmt"><option value="Page {n} of {total}">Page 1 of 5</option><option value="{n}">1</option><option value="{n} / {total}">1 / 5</option><option value="- {n} -">- 1 -</option></select></div>
      <div class="dlgrow"><label>Position</label><select id="ppos"><option value="bottom">Bottom centre</option><option value="top">Top centre</option></select></div>
      <div class="row" style="margin-top:14px">${st.pageNumbers ? '<button data-dlg="remove">Remove page numbers</button>' : ''}<span class="spacer"></span><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Apply</button></div>`);
    if (!r) return;
    st.pageNumbers = r === 'ok' ? { format: $('#pfmt').value, position: $('#ppos').value } : null;
    setDirty();
    Object.keys(st.vps).forEach((x) => drawOverlay(+x));
  },
  async blankpage() {
    if (!st.doc) return;
    const cur = await st.doc.getPage(st.order[st.current].src + 1);
    const [x0, y0, x1, y1] = cur.view;
    const base = await PDFDocument.load(st.bytes, { ignoreEncryption: true });
    const start = base.getPageCount();
    base.addPage([x1 - x0, y1 - y0]);
    pushUndo();
    st.bytes = await base.save();
    const at = st.current + 1;
    st.order.splice(at, 0, { src: start, rot: 0 });
    await loadBytes(await formFilled(st.bytes), { keepState: true });
    st.undo = [];
    scrollToPage(at);
    toast('Blank page added.');
  },
  async split() {
    if (!st.doc) return;
    const base = st.file ? st.file.split(/[\\/]/).pop().replace(/\.pdf$/i, '') : 'document';
    toast('Preparing pages…');
    const items = [];
    for (let i = 0; i < st.order.length; i++) items.push({ name: `${base} - page ${i + 1}.pdf`, bytes: await buildPdf([st.order[i]]) });
    const folder = st.file ? st.file.replace(/[\\/][^\\/]+$/, '') : undefined;
    const r = await bridge.call('pdf:saveMany', folder, items);
    if (r) { toast(`Saved ${r.saved.length} separate PDF(s).`); bridge.call('file:showPath', r.saved[0]); }
  },
  async compress() {
    if (!st.doc) return;
    const r = await dialog(`<h2 style="margin-top:0">Make the PDF smaller</h2>
      <p class="small muted">Pages are turned into pictures at a lower quality. Great for emailing scans and photos. The text won't be selectable afterwards (you can run <b>Recognise text</b> again).</p>
      <div class="dlgrow"><label>Quality</label><select id="cq"><option value="150|0.72">Balanced (recommended)</option><option value="110|0.6">Smallest (for email)</option><option value="200|0.82">High quality</option></select></div>
      <div class="row" style="margin-top:14px"><span class="spacer"></span><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Make smaller</button></div>`);
    if (r !== 'ok') return;
    const [dpi, q] = $('#cq').value.split('|').map(Number);
    toast('Making it smaller…');
    const full = await buildPdf();
    const small = await flattenPages(full, st.order.map((_, i) => i), { dpi, quality: q });
    const kb = (b) => (b.length > 1e6 ? `${(b.length / 1e6).toFixed(1)} MB` : `${Math.round(b.length / 1e3)} KB`);
    if (small.length >= full.length * 0.95) { toast(`Couldn't make this one smaller (${kb(full)}) — it's already well compressed.`); return; }
    const name = st.file ? st.file.replace(/\.pdf$/i, ' (smaller).pdf') : 'document (smaller).pdf';
    const target = await bridge.call('pdf:save', name, small, true);
    if (target) toast(`Saved a smaller copy: ${kb(full)} → ${kb(small)}.`);
  },
  async exportimages() {
    if (!(await needSaved('save pages as pictures'))) return;
    toast('Saving pages as pictures…');
    const r = await bridge.call('convert:pdfToImages', st.file, { dpi: 150, format: 'png' });
    toast(`Saved ${r.count} picture(s).`); bridge.call('file:openPath', r.folder);
  },
  async toword() {
    if (!(await needSaved('convert it to Word'))) return;
    toast('Converting to Word… (scanned pages are read with text recognition, which takes a little longer)');
    const r = await bridge.call('convert:pdfToWord', st.file);
    toast(`Created ${r.output.split(/[\\/]/).pop()}${r.usedOffice ? ' using Microsoft Word' : ''}. Opening it…`);
    bridge.call('file:openPath', r.output);
  },
  async createpdf() {
    const files = await bridge.call('files:pick', 'convert');
    if (!files || !files.length) return;
    let combine = false;
    if (files.length > 1) combine = await bridge.call('confirm', `Combine the ${files.length} files into ONE PDF?`, 'Choose Cancel to make a separate PDF for each file.');
    toast('Converting…');
    const r = await bridge.call('convert:toPdf', files, { combine });
    toast(`Created ${r.outputs.length} PDF(s)${r.usedOffice ? ' using Microsoft Office' : ''}.`);
    if (st.dirty && !(await bridge.call('confirm', 'Open the new PDF?', 'Your unsaved changes to this PDF would be lost.'))) return;
    openFile(r.outputs[0]);
  },
};

// ---------------- commands ----------------
const commands = {
  toolsmenu: () => { $('#toolsmenu').hidden = !$('#toolsmenu').hidden; },
  ...Object.fromEntries(Object.entries(tools).map(([k, fn]) => [k, async () => { $('#toolsmenu').hidden = true; try { await fn(); } catch (e) { toast(e.message); } }])),
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
  ocr: recognisePages,
  makedefault: async () => {
    const name = await bridge.call('pdf:makeDefault');
    toast(`Windows Settings is opening: choose “${name}” for .pdf and you're done.`);
  },
  image: async () => { if (!st.doc) return toast('Open a PDF first.'); const d = await bridge.call('image:openDialog'); if (d) placeImage(d, 220); },
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (b) { e.preventDefault(); Promise.resolve(commands[b.dataset.cmd]()).catch((err) => toast(err.message)); }
});

document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menuwrap')) $('#toolsmenu').hidden = true; });
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
bridge.call('theme:get').then((t) => { $('#theme').value = t || 'system'; }).catch(() => {});
$('#theme').addEventListener('change', (e) => bridge.call('theme:set', e.target.value));
bridge.call('app:platform').then((p) => { if (p === 'win32') $$('.windows-only').forEach((el) => { el.hidden = false; }); });
const file = new URLSearchParams(location.search).get('file');
if (file) openFile(file);
