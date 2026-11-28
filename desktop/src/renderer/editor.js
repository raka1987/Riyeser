// PDF viewer + editor. pdf.js draws the pages; pdf-lib writes the changes into the PDF when you save.
// Everything you add is kept as an editable object (text, boxes, signatures...) until you save.
import * as pdfjsLib from './vendor/pdf.min.mjs';
import * as T from './pdf-tools.mjs';
import * as Hy from './pdf-handy.mjs';
import { initHome } from './pdf-home.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle, pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, showText, setTextRenderingMode, TextRenderingMode } = window.PDFLib;
const bridge = window.api;
let appTitle = 'PDF Editor';
bridge.call('app:version').then(async (v) => {
  const info = await bridge.call('app:info').catch(() => null);
  appTitle = `${info?.standalone ? 'Riyeser PDF' : 'PDF Editor'} ${v}`;
  updateTitle();
}).catch(() => {});
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PX_PER_PT = 96 / 72;
// The PDF library is the @cantoo build of pdf-lib, which opens and saves password-protected PDFs (S41).
// A PDF opened with a password is read with it, and saved protected with the same password.
const loadLib = (bytes) => (st.password != null || st.encrypted
  ? PDFDocument.load(bytes, { password: st.password || '' })
  : PDFDocument.load(bytes, { ignoreEncryption: true }));
const pdfjsOpts = (bytes) => ({ data: bytes.slice(), cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/', isEvalSupported: false,
  ...(st.password != null ? { password: st.password } : {}) });

// ---------------- state ----------------
// 0.26.0: one of these per open PDF (a tab). `st` is the PDF in the tab you're looking at.
const newState = () => ({
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
  password: null,      // the password this PDF was opened with (S41)
  protect: null,       // { password } to protect the file with when it's next saved (S41)
  pageNumbers: null,   // { format, position } when page numbers are switched on
  banner: null,        // the message shown above the pages (scanned pages, redacted pages), or null
  scrollTop: 0,        // where you were in this PDF when you switched to another tab
});
let st = newState();
const fileName = (f) => String(f || '').split(/[\\/]/).pop();
function updateTitle() { document.title = tabs.view === 'doc' && st.file ? `${fileName(st.file)} — ${appTitle}` : appTitle; }
let renderToken = 0;
let uid = 1;
const newId = () => `a${Date.now().toString(36)}${uid++}`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}
function setDirty(v = true) { st.dirty = v; renderTabs(); }

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
  const task = pdfjsLib.getDocument(pdfjsOpts(bytes));
  const doc = await task.promise;
  if (st.doc) st.doc.destroy();
  st.doc = doc;
  st.pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
  st.baseRot = st.pages.map((pg) => pg.rotate || 0);
  if (!keepState) {
    st.order = st.baseRot.map((_, i) => ({ src: i, rot: 0 }));
    st.anns = {}; st.text = {}; st.undo = []; st.redo = []; st.selected = null; st.current = 0; st.selPages = new Set();
  }
  // Work out "fit to width" before the first drawing, so a big page isn't drawn twice.
  if (!keepState && fitMode && st.pages[0]) {
    const w = st.pages[0].getViewport({ scale: PX_PER_PT, rotation: st.baseRot[0] % 360 }).width;
    st.zoom = Math.min(4, Math.max(0.25, Math.min(2, ($('#viewer').clientWidth - 76) / w)));
    $('#zoomlabel').textContent = `${Math.round(st.zoom * 100)}%`;
  }
  buildPages();
}

async function openFile(file) {
  try {
    const bytes = await bridge.call('pdf:read', file);
    st.file = file;
    st.bytes = bytes;
    updateTitle(); renderTabs();
    // A PDF the engine gets stuck on must not leave a grey window: give up after a while and use the backup viewer.
    const limit = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took too long`)), ms))]);
    st.firstShown = false; st.form = []; st.formValues = {}; st.encrypted = false; st.password = null; st.protect = null; renderForm();
    // S41: a password-protected PDF asks for its password (and again if it's wrong)
    for (let wrong = false; ; wrong = true) {
      try { await limit(loadBytes(bytes), 20000, 'Opening the pages'); break; } catch (e) {
        if (T.openErrorMessage(e) !== 'password') throw e;
        const pw = await askPassword(file.split(/[\\/]/).pop(), wrong && st.password != null);
        if (pw == null) { st.password = null; toast('This PDF needs its password to open.'); return; }
        st.password = pw; st.encrypted = true;
      }
    }
    setDirty(false);
    watchFirstPage(file);
    requestAnimationFrame(fitWidth);
  } catch (e) {
    // M16: a damaged or incomplete file says so in plain words
    const plain = T.openErrorMessage(e);
    if (plain && plain !== 'password') { toast(plain); return; }
    toast(`This PDF couldn't be drawn here (${e.message}), so it's open in the basic viewer.`);
    bridge.call('pdf:basicView', file).catch(() => {});
  }
}
/** S41: ask for a PDF's password. null when cancelled. */
async function askPassword(name, wrong) {
  const r = await dialog(`<h2 style="margin-top:0">🔒 This PDF is password-protected</h2>
    <p class="muted">${wrong ? '<b>That password isn\'t right.</b> ' : ''}Type the password for <b>${esc(name)}</b> to open it.</p>
    <form id="pwform" class="dlgrow"><input id="pwin" type="password" style="flex:1" autocomplete="off"><button class="primary" data-dlg="ok">Open</button></form>
    <div class="row"><span class="spacer"></span><button data-dlg="cancel">Cancel</button></div>`, (done) => {
    const inp = $('#pwin'); inp.focus();
    $('#pwform').onsubmit = (e) => { e.preventDefault(); done('ok'); };
  });
  return r === 'ok' ? $('#pwin').value : null;
}

/** Once the first page is showing: fillable fields, password protection and scanned pages (none of these hold up opening). */
async function afterFirstPage() {
  const doc = st.doc;
  try {
    const [fields, meta] = await Promise.all([doc.getFieldObjects().catch(() => null), doc.getMetadata().catch(() => null)]);
    if (doc !== st.doc) return;
    if (meta?.info?.EncryptFilterName) { st.encrypted = true; if (st.password == null) st.password = ''; toast('This PDF is protected. When you save, it stays protected the same way.'); }
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
  const mine = st;
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
  if (mine !== st) return; // you switched to another tab meanwhile
  el.querySelector('.drawing')?.remove();
  copyToThumb(src, canvas);
  if (!st.firstShown) { st.firstShown = true; afterFirstPage(); }
  if (!st.text[src]) {
    await new Promise((r) => setTimeout(r, 30)); // let the page appear before reading its words for search
    const tc = await page.getTextContent();
    if (mine !== st) return;
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
  // text being typed is finished first (its blur saves it and redraws), so it isn't pulled out from under the typing
  const typing = document.activeElement;
  if (typing && typing.isContentEditable && ov.contains(typing)) typing.blur();
  ov.querySelectorAll('.ann, .txtbox, .fillhl, .pnum, .wm').forEach((n) => n.remove());
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
  // Fill my details: the boxes it filled in, highlighted until you change them or save
  for (const f of st.form) {
    if (!f.autofilled) continue;
    for (const r of f.rects || []) {
      if (r.page !== src) continue;
      const p1 = toView(src, r.x, r.y); const p2 = toView(src, r.x + r.w, r.y + r.h);
      const hl = document.createElement('div');
      hl.className = 'fillhl';
      Object.assign(hl.style, { left: `${Math.min(p1[0], p2[0])}px`, top: `${Math.min(p1[1], p2[1])}px`, width: `${Math.abs(p2[0] - p1[0])}px`, height: `${Math.abs(p2[1] - p1[1])}px` });
      ov.appendChild(hl);
    }
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
  setZoom(Math.min(2, ($('#viewer').clientWidth - 76) / w), { fromFit: true });
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
    // replaces: on save, the old words under it are taken out of the page itself (S42), not just covered
    addAnn(src, { id: newId(), type: 'whiteout', ax: t.x - 1, ay: t.y + 0.95 * t.h + 1, w: t.w + 2, h: 1.2 * t.h + 2, rot: 0, replaces: t.ocrLine ? null : t.str });
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
    if (st.tool === 'redact') toast('Blacked out. When you save, whatever is underneath is permanently removed: that page becomes a picture (its other words can\'t be searched or copied, and the file gets bigger). Its document properties (title, author, subject, keywords) are cleared too. Use Recognise text afterwards to make it searchable again.');
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
  $$('[data-tool]').forEach((b) => { b.classList.toggle('active', b.dataset.tool === t); if (b.closest('#tools') && !b.closest('.menu')) b.setAttribute('aria-pressed', String(b.dataset.tool === t)); });
  // a shape picked from the Shapes menu lights up the Shapes button, showing which one
  const shape = $(`#shapesmenu [data-tool="${t}"]`);
  $('#shapesbtn').classList.toggle('active', !!shape);
  $('#shapesbtn .ic').textContent = shape ? shape.querySelector('.ic').textContent : '◇';
  closeMenus();
  if (t !== 'select') select(null);
  Object.keys(st.vps).forEach((s) => drawOverlay(+s));
  if (t === 'edittext') toast('Click any text to change it. When you save, the old words are taken out of the file too. To hide private information, use Redact.');
}
$('#tools').addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
if (!document.body.dataset.view) document.body.dataset.view = 'home';

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
  const base = await loadLib(st.bytes);
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
  st.form = []; st.formValues = {}; st.encrypted = false; st.fillUndo = null;
  const mine = st;
  try {
    const doc = await loadLib(st.bytes);
    if (mine !== st) return;
    st.encrypted = doc.isEncrypted;
    const L = window.PDFLib;
    const pages = doc.getPages();
    // where each field's boxes are (for Fill my details: the words beside them, and the highlight)
    const rectsOf = (f) => {
      const out = [];
      try {
        for (const w of f.acroField.getWidgets()) {
          const r = w.getRectangle(); const pref = w.P();
          let page = pref ? pages.findIndex((p) => p.ref === pref) : -1;
          if (page < 0) { const ref = doc.context.getObjectRef(w.dict); page = pages.findIndex((p) => { const an = p.node.Annots(); return an && an.asArray().some((x) => x === ref); }); }
          if (page >= 0) out.push({ page, x: r.x, y: r.y, w: r.width, h: r.height });
        }
      } catch { /* no boxes */ }
      return out;
    };
    const tooltip = (f) => { try { const t = f.acroField.dict.lookup(L.PDFName.of('TU')); return t && t.decodeText ? t.decodeText().trim() : ''; } catch { return ''; } };
    for (const f of doc.getForm().getFields()) {
      const name = f.getName();
      const base = { name, label: tooltip(f), rects: rectsOf(f) };
      if (f instanceof L.PDFTextField) st.form.push({ ...base, kind: 'text', value: f.getText() || '' });
      else if (f instanceof L.PDFCheckBox) st.form.push({ ...base, kind: 'check', value: f.isChecked() });
      else if (f instanceof L.PDFDropdown) st.form.push({ ...base, kind: 'select', value: f.getSelected()[0] || '', options: f.getOptions() });
      else if (f instanceof L.PDFRadioGroup) st.form.push({ ...base, kind: 'radio', value: f.getSelected() || '', options: f.getOptions() });
      else if (f instanceof L.PDFOptionList) st.form.push({ ...base, kind: 'select', value: f.getSelected()[0] || '', options: f.getOptions() });
    }
    // the words printed beside each box ("Contact name") name it better than its internal name ("Text1")
    for (const f of st.form) {
      if (f.label || !f.rects.length || !st.doc) continue;
      const r = f.rects[0];
      try { if (!st.text[r.page]) st.text[r.page] = await readPageText(r.page); f.nearLabel = Hy.nearbyLabel(r, st.text[r.page]).replace(/[:*\s]+$/, ''); } catch { f.nearLabel = ''; }
      if (mine !== st) return;
    }
  } catch { /* not a form, or unreadable */ }
  if (mine === st) renderForm();
}
function renderForm() {
  $('#formcount').textContent = st.form.length ? `(${st.form.length})` : '';
  const box = $('#formfields');
  if (!st.form.length) { box.innerHTML = '<p class="muted">This PDF has no fillable fields. Use <b>Add text</b> and <b>Tick</b> to fill it in instead.</p>'; return; }
  const hasText = st.form.some((f) => f.kind === 'text');
  const filled = st.form.filter((f) => f.autofilled).length;
  const intro = filled
    ? `<p class="fillnote">Filled ${filled} field${filled === 1 ? '' : 's'} with your details (highlighted). Check them before you save.</p>`
    : '<p class="muted">Fill in the fields below — they update on the page.</p>';
  box.innerHTML = `${hasText ? `<div class="fillbar"><button class="primary" data-cmd="filldetails">Fill my details</button>${st.fillUndo ? '<button data-cmd="fillundo">Undo</button>' : ''}</div>` : ''}${intro}${st.form.map((f, i) => {
    const title = f.label || f.nearLabel || f.name;
    const label = `<label for="ff${i}" title="${esc(f.name)}">${esc(title)}</label>`;
    const auto = f.autofilled ? ' class="autofilled"' : '';
    if (f.kind === 'text') return `${label}<input type="text" id="ff${i}" data-ff="${i}" value="${esc(f.value)}"${auto}>`;
    if (f.kind === 'check') return `<label class="ffcheck"><input type="checkbox" data-ff="${i}" ${f.value ? 'checked' : ''}> ${esc(title)}</label>`;
    return `${label}<select id="ff${i}" data-ff="${i}"><option value=""></option>${f.options.map((o) => `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }).join('')}<label class="ffcheck" style="margin-top:14px"><input type="checkbox" id="flatten"${st.flatten ? ' checked' : ''}> Lock the answers when saving (no longer editable)</label>`;
  $('#flatten').addEventListener('change', (e) => { st.flatten = e.target.checked; });
}
async function refreshFormPreview() { const keep = st.current; await loadBytes(await formFilled(st.bytes), { keepState: true }); scrollToPage(keep); }
/** Fill my details: your saved details (Settings › My details) into the form's empty fields that ask for them. */
async function fillMyDetails() {
  if (!st.form.length) { toast('This PDF has no fillable fields.'); return; }
  const { profile } = await bridge.call('profile:get');
  if (!['name', 'business', 'email', 'phone', 'address', 'taxNumber'].some((k) => profile[k])) {
    const r = await dialog(`<h2>Your details aren't saved yet</h2><p class="muted">Save your name, business, tax number, address, phone and email once, and <b>Fill my details</b> puts them into forms for you.</p>
      <div class="dlgbtns"><button data-dlg="cancel">Not now</button><button class="primary" data-dlg="ok">Add my details</button></div>`);
    if (r === 'ok') home.openPage('settings', { section: 'details' });
    return;
  }
  for (const f of st.form) {
    if (f.label || f.nearLabel != null || !f.rects.length) continue;
    const r = f.rects[0];
    try { if (!st.text[r.page]) st.text[r.page] = await readPageText(r.page); f.nearLabel = Hy.nearbyLabel(r, st.text[r.page]); } catch { f.nearLabel = ''; }
  }
  const matches = Hy.matchFields(st.form.map((f) => ({ name: f.name, label: f.label || f.nearLabel || '', kind: f.kind, value: f.value })), profile);
  if (!matches.length) { toast('None of the empty fields asked for your details (name, business, tax number, address, phone or email).'); return; }
  st.fillUndo = [];
  for (const m of matches) {
    const f = st.form.find((x) => x.name === m.name);
    st.fillUndo.push({ name: f.name, value: f.value });
    f.value = m.value; f.autofilled = true; st.formValues[f.name] = f;
  }
  setDirty(); renderForm(); showSidePanel('forms');
  await refreshFormPreview();
  toast(`Filled ${matches.length} field${matches.length === 1 ? '' : 's'} with your details. They're highlighted: check them, then save.`);
}
async function undoFill() {
  if (!st.fillUndo) return;
  for (const u of st.fillUndo) { const f = st.form.find((x) => x.name === u.name); if (f) { f.value = u.value; f.autofilled = false; st.formValues[f.name] = f; } }
  st.fillUndo = null;
  renderForm(); await refreshFormPreview();
  toast('Your details were taken out again.');
}
let formTimer;
$('#formfields').addEventListener('input', (e) => {
  const i = e.target.dataset.ff;
  if (i === undefined) return;
  const f = st.form[+i];
  f.value = f.kind === 'check' ? e.target.checked : e.target.value;
  if (f.autofilled) { f.autofilled = false; e.target.classList.toggle('autofilled', false); Object.keys(st.vps).forEach((x) => drawOverlay(+x)); }
  st.formValues[f.name] = f;
  setDirty();
  clearTimeout(formTimer);
  formTimer = setTimeout(async () => { const keep = st.current; await loadBytes(await formFilled(st.bytes), { keepState: true }); scrollToPage(keep); }, 700);
});
// S46: fonts for text in any language come from the PC (core/pdf-fonts.js), only when the standard ones can't write it
const fontChooser = (doc) => T.fontChooser(window.PDFLib, doc, window.fontkit, (script) => bridge.call('pdf:font', script));
function fillFormInto(doc, fontFor = fontChooser(doc)) {
  return T.fillForm(window.PDFLib, doc, Object.values(st.formValues), fontFor);
}
async function formFilled(bytes) {
  if (!Object.keys(st.formValues).length) return bytes;
  const doc = await loadLib(bytes);
  await fillFormInto(doc);
  return doc.save();
}

/** A page's own words with where they are (for Find, Edit text and Recognise text). */
async function readPageText(src) {
  const page = await st.doc.getPage(src + 1);
  const tc = await page.getTextContent();
  return tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
    const [a, b, c, d, e, f] = it.transform;
    return { str: it.str, x: e, y: f, w: it.width, h: Math.hypot(c, d) || 10, upright: Math.abs(b) < 0.01 && Math.abs(c) < 0.01 && a > 0, family: tc.styles[it.fontName]?.fontFamily || 'sans-serif' };
  });
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
    if (!st.text[src]) st.text[src] = await readPageText(src);
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
function showSidePanel(name) {
  st.panel = name;
  $$('.side .tabs button').forEach((x) => { x.classList.toggle('active', x.dataset.panel === name); x.setAttribute('aria-selected', String(x.dataset.panel === name)); });
  $$('.panel').forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
}
$$('.side .tabs button').forEach((b) => b.addEventListener('click', () => {
  showSidePanel(b.dataset.panel);
  if (b.dataset.panel === 'find') $('#findq').focus();
}));

// ---------------- signature ----------------
// 0.26.0: your signature and your initials are saved once (sealed on this PC: src/pdf/signatures.js) and placed with
// one click from the Sign menu. Each placed one can be dragged into place and resized with its blue corner.
const pad = $('#sigpad');
const pctx = pad.getContext('2d');
let sigTab = 'draw'; let sigUpload = null; let padDrawn = false; let sigKind = 'signature';
const SIG_WIDTH = { signature: 160, initials: 64 };
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
async function renderSavedSigs() {
  const saved = await bridge.call('sig:list', sigKind);
  const what = sigKind === 'initials' ? 'initials' : 'signatures';
  $('#sigsaved').innerHTML = saved.length
    ? `<p class="small muted sighead">Your saved ${what}: click one to place it. ★ is the one <b>${sigKind === 'initials' ? 'My initials' : 'My signature'}</b> places.</p>${saved.map((s) => `<div class="s${s.isDefault ? ' def' : ''}"><button class="pick" data-sig="${s.id}" aria-label="Place this ${sigKind === 'initials' ? 'set of initials' : 'signature'}"><img src="${s.data}" alt=""></button><button class="star" data-sigdef="${s.id}" title="${s.isDefault ? 'Placed by one click' : 'Use this one for one-click placing'}" aria-label="Use this one for one-click placing" aria-pressed="${s.isDefault}">${s.isDefault ? '★' : '☆'}</button><button class="x" data-sigdel="${s.id}" title="Forget it" aria-label="Forget it">✕</button></div>`).join('')}`
    : `<p class="small muted sighead">No ${what} saved yet. Make one below: it's kept on this PC for next time.</p>`;
  $('#sigsaved').onclick = async (e) => {
    const del = e.target.closest('[data-sigdel]');
    if (del) { await bridge.call('sig:delete', del.dataset.sigdel); return renderSavedSigs(); }
    const def = e.target.closest('[data-sigdef]');
    if (def) { await bridge.call('sig:setDefault', def.dataset.sigdef); return renderSavedSigs(); }
    const s = e.target.closest('[data-sig]');
    if (s) { closeSigModal(); placeImage(saved.find((x) => x.id === s.dataset.sig).data, SIG_WIDTH[sigKind]); }
    return null;
  };
}
async function openSignature(kind = 'signature') {
  if (!st.doc) return toast('Open a PDF first.');
  sigKind = kind === 'initials' ? 'initials' : 'signature';
  resetPad(); sigUpload = null; $('#sigimg').removeAttribute('src');
  $$('[data-sigkind]').forEach((b) => { b.classList.toggle('active', b.dataset.sigkind === sigKind); b.setAttribute('aria-pressed', String(b.dataset.sigkind === sigKind)); });
  $('#sigtitle').textContent = sigKind === 'initials' ? 'Your initials' : 'Your signature';
  $('#sigtext').placeholder = sigKind === 'initials' ? 'Type your initials' : 'Type your name';
  const status = await bridge.call('sig:status').catch(() => ({ protected: false }));
  $('#sigprivacy').textContent = status.protected ? 'Kept on this PC only, locked to your Windows sign-in.' : 'Kept on this PC only.';
  await renderSavedSigs();
  $('#sigmodal').hidden = false;
  ($('#sigsaved .pick') || $('[data-sigtab].active')).focus();
  return null;
}
function closeSigModal() { $('#sigmodal').hidden = true; const b = $('#signbtn'); if (b) b.focus(); }
$$('[data-sigkind]').forEach((b) => b.addEventListener('click', () => openSignature(b.dataset.sigkind)));
$$('[data-sigtab]').forEach((b) => b.addEventListener('click', () => {
  sigTab = b.dataset.sigtab;
  $$('[data-sigtab]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b)); });
  $$('[data-sigpane]').forEach((p) => { p.hidden = p.dataset.sigpane !== sigTab; });
  if (sigTab === 'type') { $('#sigtext').focus(); drawTyped(); }
}));
async function placeSignature() {
  let data = null;
  if (sigTab === 'draw') data = padDrawn ? trimmed(pad) : null;
  if (sigTab === 'type') { drawTyped(); data = $('#sigtext').value.trim() ? trimmed($('#sigtyped')) : null; }
  if (sigTab === 'upload') data = sigUpload;
  if (!data) return toast(sigTab === 'draw' ? 'Draw it first.' : sigTab === 'type' ? 'Type it first.' : 'Choose a picture first.');
  if ($('#sigremember').checked) await bridge.call('sig:save', { kind: sigKind, data, makeDefault: true });
  closeSigModal();
  placeImage(data, SIG_WIDTH[sigKind]);
  return null;
}
/** One click: My signature / My initials. The first time, it asks you to make one. */
async function placeMine(kind) {
  if (!st.doc) return toast('Open a PDF first.');
  const d = await bridge.call('sig:default', kind);
  if (!d) return openSignature(kind);
  placeImage(d.data, SIG_WIDTH[kind]);
  return null;
}

// ---------------- building the saved PDF ----------------
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

async function buildPdf(orderList = st.order) {
  const doc = await loadLib(st.bytes);
  const fonts = {};
  const stdName = (name, bold) => ({ Helvetica: StandardFonts.Helvetica, HelveticaBold: StandardFonts.HelveticaBold, TimesRoman: StandardFonts.TimesRoman, TimesRomanBold: StandardFonts.TimesRomanBold, Courier: StandardFonts.Courier, CourierBold: StandardFonts.CourierBold }[`${name}${bold ? 'Bold' : ''}`] || StandardFonts.Helvetica);
  const font = async (name, bold) => {
    const key = `${name}${bold ? 'Bold' : ''}`;
    return (fonts[key] = fonts[key] || await doc.embedFont(stdName(name, bold)));
  };
  // S46: text in any language: a font from the PC when the standard one can't write it
  const fontFor = fontChooser(doc);
  const missing = new Set();
  const textFont = async (text, name, bold) => { const r = await fontFor(text, stdName(name, bold)); if (r.missing) missing.add(text); return r.font; };
  // S42: words replaced with "Edit text" are taken out of the page itself first (before anything new is drawn on it)
  const replaced = {};
  for (const [srcStr, list] of Object.entries(st.anns)) {
    const boxes = list.filter((a) => a.type === 'whiteout' && a.replaces).map((a) => ({ x0: a.ax, y0: a.ay - a.h, x1: a.ax + a.w, y1: a.ay, old: a.replaces }));
    if (!boxes.length || !doc.getPage(+srcStr)) continue;
    try { T.removeTextInBoxes(window.PDFLib, doc, +srcStr, boxes); } catch (e) { console.warn('edit text', e); }
    replaced[+srcStr] = boxes;
  }
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
        const f = await textFont(a.text, 'Helvetica', true);
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
        const f = await textFont(a.text, a.font, a.bold);
        const safe = (line) => T.safeText(f, line);
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
        const main = a.text.toUpperCase();
        const f = await textFont(main, 'Helvetica', true);
        const size = Math.min(a.h * 0.42, (a.w * 0.86) / Math.max(1, f.widthOfTextAtSize(main, 1)));
        const mw = f.widthOfTextAtSize(main, size);
        const mo = P((a.w - mw) / 2, a.sub ? a.h * 0.55 : a.h * 0.64);
        page.drawText(main, { x: mo.x, y: mo.y, size, font: f, color: hexToRgb(a.color), rotate });
        if (a.sub) {
          const f2 = await textFont(a.sub, 'Helvetica', false);
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

  const form = await fillFormInto(doc, fontFor);
  if (st.flatten) { try { form.flatten(); } catch (e) { console.warn('flatten', e); } }

  // Rebuild the page list in the new order, applying rotations and dropping deleted pages.
  const keep = new Set(orderList.map((e) => e.src));
  pages.forEach((pg, i) => { if (!keep.has(i)) dropPageWidgets(doc, pg); });
  T.setPageOrder(window.PDFLib, doc, orderList.map((entry) => pages[entry.src]));
  for (const entry of orderList) pages[entry.src].setRotation(degrees((st.baseRot[entry.src] + entry.rot) % 360));
  if (st.pageNumbers) {
    const f = await font('Helvetica', false);
    doc.getPages().forEach((pg, i) => {
      const label = st.pageNumbers.format.replace('{n}', i + 1).replace('{total}', orderList.length);
      const { width, height } = pg.getSize();
      const tw = f.widthOfTextAtSize(label, 10);
      pg.drawText(label, { x: (width - tw) / 2, y: st.pageNumbers.position === 'top' ? height - 26 : 18, size: 10, font: f, color: rgb(0.2, 0.2, 0.2) });
    });
  }
  // QA (PDF-RED-02): a redacted file also loses its document properties (title, author, subject, keywords) and the
  // XMP metadata copy of them: they often repeat the private details (a name, an account number) the redaction hides.
  st.lastRedacted = orderList.some((e) => (st.anns[e.src] || []).some((a) => a.type === 'redact'));
  if (st.lastRedacted) T.clearDocInfo(window.PDFLib, doc);
  removeUnused(doc); // deleted pages and replaced content are really gone from the file
  // S41: a PDF opened with its password is saved with the same password; "Password…" sets a new one
  const protectWith = st.protect ? st.protect.password : (st.password || null);
  if (protectWith) doc.encrypt({ userPassword: protectWith, ownerPassword: protectWith, permissions: { printing: 'highResolution', copying: true, modifying: true, annotating: true, fillingForms: true } });
  let bytes = await doc.save();
  if (protectWith) { st.password = protectWith; st.encrypted = true; }
  if (missing.size) toast(`Some letters couldn't be saved (no font on this PC has them): ${[...missing].join(', ').slice(0, 80)}`);
  // S42: check the old words really are gone from each edited page; a page where they aren't is made a picture, like Redact
  const flatten = new Set(orderList.map((e, i) => ((st.anns[e.src] || []).some((a) => a.type === 'redact') ? i : -1)).filter((i) => i >= 0));
  const edited = orderList.map((e, i) => (replaced[e.src] ? i : -1)).filter((i) => i >= 0 && !flatten.has(i));
  if (edited.length) {
    const check = await pdfjsLib.getDocument(pdfjsOpts(bytes)).promise;
    for (const i of edited) {
      const items = (await (await check.getPage(i + 1)).getTextContent()).items;
      const added = new Set((st.anns[orderList[i].src] || []).filter((a) => a.type === 'text').flatMap((a) => a.text.split('\n').map((l) => l.trim())));
      const still = replaced[orderList[i].src].some((b) => items.some((it) => it.str && it.str.trim() && !added.has(it.str.trim()) && b.old.includes(it.str.trim()) && it.transform[4] >= Math.min(b.x0, b.x1) - 1 && it.transform[4] <= Math.max(b.x0, b.x1) && it.transform[5] >= Math.min(b.y0, b.y1) - 1 && it.transform[5] <= Math.max(b.y0, b.y1)));
      if (still) flatten.add(i);
    }
    check.destroy();
  }
  // Redaction (and edited text that couldn't be taken out): those pages are turned into pictures, so the hidden text is really gone.
  st.lastFlattened = [...flatten];
  return flatten.size ? flattenPages(bytes, [...flatten].sort((x, y) => x - y)) : bytes;
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
  const src = await pdfjsLib.getDocument(pdfjsOpts(bytes)).promise;
  const out = await loadLib(bytes);
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
    updateTitle(); renderTabs();
    await readForm();
    await loadBytes(out);
    setDirty(false);
    st.protect = null;
    toast(st.lastRedacted ? `Saved to ${target}. The previous version, before redacting, was kept in Tools › Copies kept when saving over a file: delete it there if it mustn't be kept.` : `Saved to ${target}. (The previous version was backed up.)`);
    // M15: pages made into pictures (Redact) can't be searched any more: offer Recognise text for them
    if ((st.lastFlattened || []).length) {
      setBanner(`📷 ${st.lastFlattened.length === 1 ? 'The page you redacted is' : `The ${st.lastFlattened.length} pages you redacted are`} now a picture, so its words can't be searched or copied. <button class="primary" data-cmd="ocr">Recognise text</button>`);
    }
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
  // S47: every page's own text is read first (not only the pages drawn on screen), so pages that already have words
  // aren't recognised again (that doubled every word in searches and copies)
  for (const o of st.order) {
    if (st.text[o.src] || (st.anns[o.src] || []).some((a) => a.type === 'ocr')) continue;
    st.text[o.src] = (await T.pageHasText(await st.doc.getPage(o.src + 1))) ? await readPageText(o.src) : [];
  }
  const todo = st.order.map((o, i) => ({ ...o, i })).filter((o) => !(st.text[o.src] || []).length || (st.anns[o.src] || []).some((a) => a.type === 'ocr'));
  if (!todo.length) { toast('This PDF already contains text — nothing to recognise.'); return; }
  ocrBusy = true;
  setBanner(null);
  const btn = $('#tools [data-cmd="ocr"]'); btn.disabled = true;
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
    ocrBusy = false; btn.disabled = false; btn.innerHTML = '<span class="ic" aria-hidden="true">🔍</span><span class="lbl">Recognise text</span>';
  }
}

async function checkIfScanned() {
  const doc = st.doc;
  let empty = 0;
  const n = Math.min(st.doc.numPages, 3);
  for (let i = 1; i <= n; i++) {
    const known = st.text[i - 1];
    const has = known ? known.length > 0 : (await (await st.doc.getPage(i)).getTextContent()).items.some((it) => it.str && it.str.trim());
    if (!has) empty++;
  }
  if (doc !== st.doc) return;
  setBanner(empty === 0 ? null : SCANNED_BANNER);
}
const SCANNED_BANNER = '📷 This looks like a scanned document — the words are a picture, so you can\'t search or edit them yet. <button class="primary" data-cmd="ocr">Recognise text</button>';
function setBanner(html) { st.banner = html; renderBanner(); }
function renderBanner() { const b = $('#scanbanner'); b.hidden = !st.banner; if (st.banner) b.innerHTML = st.banner; }

// ---------------- dialogs ----------------
/** A small window inside the page. Buttons with data-dlg close it with that value ("cancel": null). Esc cancels. */
function dialog(html, onOpen) {
  return new Promise((resolve) => {
    const back = document.activeElement;
    $('#dlgbox').innerHTML = html;
    $('#dlg').hidden = false;
    const done = (v) => { $('#dlg').hidden = true; $('#dlg').onkeydown = null; resolve(v); if (back && back.focus && document.contains(back)) back.focus(); };
    $('#dlgbox').onclick = (e) => { const b = e.target.closest('[data-dlg]'); if (b) { e.preventDefault(); done(b.dataset.dlg === 'cancel' ? null : b.dataset.dlg); } };
    $('#dlg').onkeydown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      if (e.key === 'Tab') { // keep the keyboard inside the dialog
        const f = $$('button, input, select, textarea, [tabindex]', $('#dlgbox')).filter((x) => !x.disabled && x.offsetParent);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    if (onOpen) onOpen(done);
    if (!$('#dlgbox').contains(document.activeElement)) ($('#dlgbox input, #dlgbox select, #dlgbox .primary, #dlgbox button')).focus();
  });
}
// The date on stamps, in the business's format (Settings › Dates on stamps), or Windows' own.
const prefs = { dateFormat: 'system', locale: undefined, stamps: [], stampDate: true };
const stampDate = () => Hy.formatStampDate(new Date(), prefs.dateFormat, prefs.locale);
async function loadPrefs() {
  const first = !prefs.platform;
  try { const s = await bridge.call('pdfset:get'); Object.assign(prefs, { dateFormat: s.dateFormatUsed, locale: s.locale || undefined, stamps: s.stamps || [], stampDate: s.stampDate !== false, platform: s.platform }); } catch { /* defaults */ }
  renderStampMenu();
  if (first && tabs.view === 'home') home.renderHome();
}
async function needSaved(what) {
  if (!st.file) { toast(`Save the PDF first, then ${what}.`); return false; }
  if (st.dirty) {
    const r = await dialog(`<h2>Save your changes first?</h2><p class="muted">To ${esc(what)}, the PDF needs to be saved.</p><div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Save</button></div>`);
    if (r !== 'ok') return false;
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

// ---------------- stamps ----------------
const MORE_STAMPS = [{ text: 'CHECKED', color: '#1d4ed8' }, { text: 'REJECTED', color: '#b91c1c' }, { text: 'VOID', color: '#6b7280' }];
function renderStampMenu() {
  const item = (s, i, custom) => `<button role="menuitem" data-stamp="${custom ? `c${i}` : `p${i}`}"><span class="swatch" style="border-color:${esc(s.color)};color:${esc(s.color)}">${esc(s.text.slice(0, 1))}</span>${esc(s.text)}</button>`;
  $('#stampmenu').innerHTML = `<div class="mh">Stamps</div>${[...Hy.STAMP_PRESETS, ...MORE_STAMPS].map((s, i) => item(s, i, false)).join('')}
    ${prefs.stamps.length ? `<div class="mh">Your stamps</div>${prefs.stamps.map((s, i) => item(s, i, true)).join('')}` : ''}
    <div class="msep"></div>
    <button role="menuitemcheckbox" aria-checked="${prefs.stampDate}" data-cmd="stampdatetoggle"><span class="ic" aria-hidden="true">${prefs.stampDate ? '☑' : '☐'}</span>Add today's date (${esc(stampDate())})</button>
    <button role="menuitem" data-cmd="newstamp"><span class="ic" aria-hidden="true">＋</span>New stamp…</button>`;
}
function placeStamp(s) {
  if (!st.doc) return toast('Open a PDF first.');
  const withDate = s.date !== false && prefs.stampDate;
  const text = String(s.text).toUpperCase();
  placeBox({ type: 'stamp', text, color: s.color, sub: withDate ? stampDate() : '' }, Math.max(120, text.length * 13), withDate ? 54 : 44);
  toast('Drag the stamp into place. Use the blue corner to resize.');
  return null;
}
async function newStamp() {
  const r = await dialog(`<h2>New stamp</h2><p class="muted">It's added to the Stamp menu on this PC.</p>
    <div class="dlgrow"><label for="nstxt">Words</label><input id="nstxt" maxlength="40" placeholder="e.g. ENTERED IN ACCOUNTS" style="flex:1"></div>
    <div class="dlgrow"><label for="nscol">Colour</label><input type="color" id="nscol" value="#1d4ed8"><span id="nsprev" class="stampprev">STAMP</span></div>
    <div class="dlgrow"><label></label><label class="ffcheck"><input type="checkbox" id="nsdate" checked> Show the date (${esc(stampDate())})</label></div>
    <div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button data-dlg="place">Add and place it</button><button class="primary" data-dlg="ok">Add</button></div>`, () => {
    const prev = () => { const p = $('#nsprev'); p.textContent = ($('#nstxt').value.trim() || 'STAMP').toUpperCase(); p.style.color = $('#nscol').value; p.style.borderColor = $('#nscol').value; };
    $('#nstxt').addEventListener('input', prev); $('#nscol').addEventListener('input', prev); prev();
    $('#nstxt').focus();
  });
  if (!r) return;
  const s = { text: $('#nstxt').value.trim().toUpperCase(), color: $('#nscol').value, date: $('#nsdate').checked };
  if (!s.text) { toast('Type the words for the stamp.'); return; }
  const saved = await bridge.call('pdfset:set', { stamps: [...prefs.stamps, s] });
  prefs.stamps = saved.stamps; renderStampMenu();
  if (r === 'place') placeStamp(s); else toast(`“${s.text}” is in the Stamp menu now.`);
}
$('#stampmenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-stamp]'); if (!b) return;
  const k = b.dataset.stamp; const all = [...Hy.STAMP_PRESETS, ...MORE_STAMPS];
  closeMenus();
  placeStamp(k[0] === 'c' ? prefs.stamps[+k.slice(1)] : all[+k.slice(1)]);
});

// ---------------- menus (Shapes, Sign, Stamp, Tools) ----------------
function closeMenus(except = null) {
  $$('.menu').forEach((m) => { if (m !== except && !m.hidden) { m.hidden = true; const b = m.parentElement.querySelector('[aria-haspopup]'); if (b) b.setAttribute('aria-expanded', 'false'); } });
}
// opened with the keyboard (Enter, Space, or Down on its button): the first entry gets the focus
let keyboardUsed = false;
window.addEventListener('keydown', () => { keyboardUsed = true; }, true);
window.addEventListener('pointerdown', () => { keyboardUsed = false; }, true);
function toggleMenu(id, { focusFirst = keyboardUsed } = {}) {
  const m = document.getElementById(id); if (!m) return;
  const open = m.hidden;
  closeMenus(m);
  m.hidden = !open;
  const b = m.parentElement.querySelector('[aria-haspopup]'); if (b) b.setAttribute('aria-expanded', String(open));
  if (open) {
    // keep it on screen: open to the left if it would go past the right edge
    m.classList.remove('left'); const r = m.getBoundingClientRect(); if (r.right > innerWidth - 8) m.classList.add('left');
    if (focusFirst) { const f = m.querySelector('button:not([hidden])'); if (f) f.focus(); }
  }
}
document.addEventListener('keydown', (e) => {
  const opener = e.target.closest && e.target.closest('[aria-haspopup]');
  if (opener && e.key === 'ArrowDown') { e.preventDefault(); const m2 = opener.parentElement.querySelector('.menu'); if (m2 && m2.hidden) toggleMenu(m2.id, { focusFirst: true }); else m2?.querySelector('button:not([hidden])')?.focus(); return; }
  const m = e.target.closest && e.target.closest('.menu');
  if (!m) return;
  const items = $$('button:not([hidden])', m);
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const b = m.parentElement.querySelector('[aria-haspopup]'); closeMenus(); if (b) b.focus(); }
}, true);

// ---------------- the "Ask someone to sign…" hook ----------------
// HOOK (sign-request): "Ask someone to sign…" (online, feat/pdf-sign-request). When its module
// src/renderer/sign-request.js is installed next to this file, the Sign menu shows the entry and calls it:
//   export async function askToSign(ctx)  with ctx = { file, dirty, save(), buildPdf(), toast(msg), dialog(html), bridge }
//   export function isAvailable()         optional: return false to keep the entry hidden
//   export function openStatus()          optional: "Sent for signing" (the requests sent from here) below it
// window.__signMenuHook tells the module this menu shows its entries, so it adds no buttons of its own.
// Without the module the entries stay hidden and nothing else changes.
let signRequest = null;
async function loadSignRequest() {
  window.__signMenuHook = true;
  try {
    if (!(await bridge.call('pdf:hasModule', 'sign-request.js'))) return;
    const mod = await import('./sign-request.js');
    if (typeof mod.askToSign !== 'function') return;
    if (typeof mod.isAvailable === 'function' && !(await mod.isAvailable())) return;
    if (typeof mod.init === 'function') mod.init({ menu: true });
    signRequest = mod;
    $('#signrequestsep').hidden = false; $('[data-cmd="signrequest"]').hidden = false;
    if (typeof mod.openStatus === 'function') $('[data-cmd="signstatus"]').hidden = false;
  } catch (e) { console.warn('sign-request', e.message); }
}
async function askSomeoneToSign() {
  if (!signRequest) return;
  if (!st.doc) { toast('Open a PDF first.'); return; }
  await signRequest.askToSign({ file: st.file, dirty: st.dirty, save: () => save(false), buildPdf: () => buildPdf(), toast, dialog, bridge });
}

// ---------------- tools ----------------
const kb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
/** Pages as pictures at a lower quality (Compress). quality: 'balanced' | 'small' | 'high' */
const COMPRESS = { balanced: [150, 0.72], small: [110, 0.6], high: [200, 0.82] };
async function compressBytes(bytes, quality = 'balanced') {
  const [dpi, q] = COMPRESS[quality] || COMPRESS.balanced;
  const d = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/' }).promise;
  const n = d.numPages; d.destroy();
  const saved = st; const tmp = newState(); st = tmp; // flattenPages reads the password from the current state
  try { return await flattenPages(bytes, Array.from({ length: n }, (_, i) => i), { dpi, quality: q }); } finally { st = saved; }
}
const tools = {
  help: () => bridge.call('pdf:help'),
  basicview: async () => { if (!st.file) throw new Error('Open a PDF first.'); await bridge.call('pdf:basicView', st.file); },
  stamp: () => toggleMenu('stampmenu'),
  newstamp: newStamp,
  async stampdatetoggle() { prefs.stampDate = !prefs.stampDate; await bridge.call('pdfset:set', { stampDate: prefs.stampDate }); renderStampMenu(); toggleMenu('stampmenu'); },
  async watermark() {
    if (!st.doc) return;
    const existing = Object.values(st.anns).flat().find((a) => a.type === 'watermark');
    const r = await dialog(`<h2>Watermark</h2>
      <div class="dlgrow"><label for="wtxt">Text</label><input id="wtxt" value="${esc(existing?.text || 'CONFIDENTIAL')}" style="flex:1"></div>
      <div class="dlgrow"><label for="wcol">Colour</label><input type="color" id="wcol" value="${existing?.color || '#9ca3af'}"><label for="wop" style="min-width:auto">Strength</label><input type="range" id="wop" min="0.08" max="0.6" step="0.02" value="${existing?.opacity || 0.22}"></div>
      <div class="dlgrow"><label for="wpages">Pages</label><select id="wpages"><option value="all">All pages</option><option value="this">This page only</option></select></div>
      <div class="dlgbtns">${existing ? '<button data-dlg="remove" class="leftbtn">Remove watermark</button>' : ''}<button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Apply</button></div>`);
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
    const r = await dialog(`<h2>Page numbers</h2>
      <div class="dlgrow"><label for="pfmt">Style</label><select id="pfmt"><option value="Page {n} of {total}">Page 1 of 5</option><option value="{n}">1</option><option value="{n} / {total}">1 / 5</option><option value="- {n} -">- 1 -</option></select></div>
      <div class="dlgrow"><label for="ppos">Position</label><select id="ppos"><option value="bottom">Bottom centre</option><option value="top">Top centre</option></select></div>
      <div class="dlgbtns">${st.pageNumbers ? '<button data-dlg="remove" class="leftbtn">Remove page numbers</button>' : ''}<button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Apply</button></div>`);
    if (!r) return;
    st.pageNumbers = r === 'ok' ? { format: $('#pfmt').value, position: $('#ppos').value } : null;
    setDirty();
    Object.keys(st.vps).forEach((x) => drawOverlay(+x));
  },
  async blankpage() {
    if (!st.doc) return;
    const cur = await st.doc.getPage(st.order[st.current].src + 1);
    const [x0, y0, x1, y1] = cur.view;
    const base = await loadLib(st.bytes);
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
  /** Split: every page, every few pages, or the page ranges you type. */
  async split() {
    if (!st.doc) return;
    const n = st.order.length;
    const r = await dialog(`<h2>Split into separate files</h2><p class="muted">This PDF has ${n} page${n === 1 ? '' : 's'}. The original stays as it is.</p>
      <div class="radios" role="radiogroup" aria-label="How to split">
        <label><input type="radio" name="sp" value="each" checked> Every page as its own PDF</label>
        <label><input type="radio" name="sp" value="every"> Every <input id="spn" type="number" min="1" max="${n}" value="2" class="num"> pages</label>
        <label><input type="radio" name="sp" value="ranges"> These pages: <input id="spr" placeholder="e.g. 1-3, 4-6, 7-" class="grow"></label>
      </div>
      <div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Split…</button></div>`, () => {
      $('#spn').addEventListener('focus', () => { $('input[name=sp][value=every]').checked = true; });
      $('#spr').addEventListener('focus', () => { $('input[name=sp][value=ranges]').checked = true; });
    });
    if (r !== 'ok') return;
    const how = $('input[name=sp]:checked').value;
    const ranges = how === 'each' ? Hy.everyN(1, n) : how === 'every' ? Hy.everyN(Math.max(1, +$('#spn').value || 1), n) : Hy.parseRanges($('#spr').value, n);
    const base = st.file ? fileName(st.file).replace(/\.pdf$/i, '') : 'document';
    toast('Preparing the files…');
    const items = [];
    for (const [a, b] of ranges) items.push({ name: `${base} - ${a === b ? `page ${a}` : `pages ${a}-${b}`}.pdf`, bytes: await buildPdf(st.order.slice(a - 1, b)) });
    const folder = st.file ? st.file.replace(/[\\/][^\\/]+$/, '') : undefined;
    const res = await bridge.call('pdf:saveMany', folder, items);
    if (res) { toast(`Saved ${res.saved.length} separate PDF${res.saved.length === 1 ? '' : 's'}.`); bridge.call('file:showPath', res.saved[0]); }
  },
  async compress() {
    if (!st.doc) return;
    const r = await dialog(`<h2>Compress PDF</h2>
      <p class="small muted">Pages are turned into pictures at a lower quality. Great for emailing scans and photos. The text won't be selectable afterwards (you can run <b>Recognise text</b> again). A smaller copy is saved; the original stays as it is.</p>
      <div class="dlgrow"><label for="cq">Quality</label><select id="cq"><option value="balanced">Balanced (recommended)</option><option value="small">Smallest (for email)</option><option value="high">High quality</option></select></div>
      <div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Compress PDF</button></div>`);
    if (r !== 'ok') return;
    const q = $('#cq').value;
    const [dpi, quality] = COMPRESS[q];
    toast('Compressing the PDF…');
    const full = await buildPdf();
    const small = await flattenPages(full, st.order.map((_, i) => i), { dpi, quality });
    if (small.length >= full.length * 0.95) { toast(`Couldn't make this one smaller (${kb(full.length)}) — it's already well compressed.`); return; }
    const name = st.file ? st.file.replace(/\.pdf$/i, ' (smaller).pdf') : 'document (smaller).pdf';
    const target = await bridge.call('pdf:save', name, small, true);
    if (target) toast(`Saved a smaller copy: ${kb(full.length)} → ${kb(small.length)}.`);
  },
  async exportimages() {
    if (!(await needSaved('save pages as pictures'))) return;
    const r = await dialog(`<h2>Save pages as pictures</h2><p class="muted">A picture of each page goes into a new folder next to the PDF.</p>
      <div class="dlgrow"><label for="eif">Type</label><select id="eif"><option value="png">PNG (sharp text)</option><option value="jpg">JPG (smaller, for photos)</option></select></div>
      <div class="dlgrow"><label for="eid">Resolution</label><select id="eid"><option value="96">Screen (96 dpi)</option><option value="150" selected>Standard (150 dpi)</option><option value="300">Print (300 dpi)</option></select></div>
      <div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Save pictures</button></div>`);
    if (r !== 'ok') return;
    toast('Saving pages as pictures…');
    const res = await bridge.call('convert:pdfToImages', st.file, { dpi: +$('#eid').value, format: $('#eif').value });
    toast(`Saved ${res.count} picture${res.count === 1 ? '' : 's'}.`); bridge.call('file:openPath', res.folder);
  },
  async toword() {
    if (!(await needSaved('convert it to Word'))) return;
    toast('Converting to Word… (scanned pages are read with text recognition, which takes a little longer)');
    const r = await bridge.call('convert:pdfToWord', st.file);
    toast(`Created ${fileName(r.output)}${r.usedOffice ? ' using Microsoft Word' : ' (basic: the layout may change)'}. Opening it…`);
    bridge.call('file:openPath', r.output);
  },
  async createpdf() {
    const files = await bridge.call('files:pick', 'convert');
    if (!files || !files.length) return;
    let combine = false;
    if (files.length > 1) combine = (await dialog(`<h2>${files.length} files</h2><p class="muted">Make one PDF with all of them, or a separate PDF for each?</p><div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button data-dlg="sep">Separate PDFs</button><button class="primary" data-dlg="one">One PDF</button></div>`)) === 'one';
    toast('Converting…');
    const r = await bridge.call('convert:toPdf', files, { combine });
    toast(`Created ${r.outputs.length} PDF${r.outputs.length === 1 ? '' : 's'}${r.usedOffice ? ' using Microsoft Office' : ''}.`);
    await openFiles(r.outputs.slice(0, 5));
  },
  convertpage: () => home.openPage('convert', { files: st.file ? [st.file] : [] }),
  compare: () => home.openPage('compare', { files: st.file ? [st.file] : [] }),
  async senddocs() {
    if (!st.doc) return;
    if (!(await needSaved('send it to Riyeser Documents'))) return;
    await home.sendToDocuments([st.file]);
  },
};

// ---------------- tabs: several PDFs open at once ----------------
// tabs.list: [{ id, st }]; tabs.view: 'home' (start screen) | 'doc' (a PDF) | 'task' (Convert, Batch, Compare...)
const tabs = { list: [], active: null, view: 'home', seq: 1 };
function setView(v) {
  tabs.view = v;
  document.body.dataset.view = v;
  if (v !== 'doc') closeMenus();
  renderTabs(); updateTitle();
}
function renderTabs() {
  const bar = $('#tabstrip'); if (!bar) return;
  bar.innerHTML = tabs.list.map((t) => {
    const name = t.st.file ? fileName(t.st.file) : 'New PDF';
    const on = tabs.view === 'doc' && t === tabs.active;
    return `<div class="tab${on ? ' active' : ''}${t.st.dirty ? ' dirty' : ''}" data-tabid="${t.id}" title="${esc(t.st.file || name)}">
      <button class="tabname" role="tab" aria-selected="${on}" data-tabgo="${t.id}"><span class="tabtext">${esc(name)}</span></button>
      ${t.st.dirty ? '<span class="dot" role="img" aria-label="unsaved changes" title="Unsaved changes">●</span>' : ''}
      <button class="tabx" data-tabclose="${t.id}" aria-label="Close ${esc(name)}" title="Close (Ctrl+W)">✕</button></div>`;
  }).join('');
  $('#hometab').classList.toggle('active', tabs.view === 'home');
  $('#hometab').setAttribute('aria-selected', String(tabs.view === 'home'));
}
function activate(tab) {
  if (tabs.active && tabs.active !== tab) tabs.active.st.scrollTop = $('#viewer').scrollTop;
  for (const t of liveRenders) { try { t.cancel(); } catch { /* finished */ } }
  tabs.active = tab; st = tab.st;
  closeMenus(); setView('doc');
  $('#zoomlabel').textContent = `${Math.round(st.zoom * 100)}%`;
  $('#findres').innerHTML = ''; $('#findq').value = '';
  renderForm(); renderBanner(); showSidePanel(st.panel || 'pages');
  $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === st.tool));
  document.body.className = `tool-${st.tool}`;
  if (st.doc) buildPages().then(() => { $('#viewer').scrollTop = st.scrollTop || 0; });
  else { $('#pages').innerHTML = ''; $('#thumbs').innerHTML = ''; updatePageInfo(); }
}
function showHome() {
  if (tabs.active && tabs.view === 'doc') tabs.active.st.scrollTop = $('#viewer').scrollTop;
  setView('home'); home.renderHome();
}
/** Open a PDF in a tab (the tab it's already in, if it's open). Returns the tab, or null if it couldn't open. */
async function openTab(file) {
  const have = tabs.list.find((t) => t.st.file === file || t.opening === file);
  if (have) { activate(have); return have; }
  const tab = { id: `t${tabs.seq++}`, st: newState(), opening: file };
  tabs.list.push(tab);
  activate(tab);
  await openFile(file);
  tab.opening = null;
  if (!tab.st.doc) { dropTab(tab); return null; }
  return tab;
}
async function openFiles(files) {
  let last = null;
  for (const f of files) { const t = await openTab(f); if (t) last = t; }
  return last;
}
function dropTab(tab) {
  const i = tabs.list.indexOf(tab);
  if (i < 0) return;
  tabs.list.splice(i, 1);
  try { tab.st.doc && tab.st.doc.destroy(); } catch { /* gone */ }
  if (tabs.active === tab) {
    tabs.active = null; st = newState();
    const next = tabs.list[i] || tabs.list[i - 1];
    if (next) activate(next); else showHome();
  } else renderTabs();
}
/** Close a tab; asks only if it has unsaved changes. */
async function closeTab(tab) {
  if (!tab) return;
  if (tab.st.dirty) {
    if (tabs.active !== tab) activate(tab);
    const r = await dialog(`<h2>Save the changes to ${esc(fileName(tab.st.file) || 'this PDF')}?</h2><p class="muted">If you don't, the changes are lost.</p>
      <div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button data-dlg="discard">Don't save</button><button class="primary" data-dlg="save">Save</button></div>`);
    if (!r) return;
    if (r === 'save') { await save(false); if (st.dirty) return; }
  }
  dropTab(tab);
}
$('#tabbar').addEventListener('click', (e) => {
  const go = e.target.closest('[data-tabgo]'); const x = e.target.closest('[data-tabclose]');
  if (x) { closeTab(tabs.list.find((t) => t.id === x.dataset.tabclose)); return; }
  if (go) activate(tabs.list.find((t) => t.id === go.dataset.tabgo));
});
$('#tabbar').addEventListener('auxclick', (e) => { const t = e.target.closest('[data-tabid]'); if (t && e.button === 1) closeTab(tabs.list.find((x) => x.id === t.dataset.tabid)); });

// ---------------- jobs (start screen tiles, the right-click menu) ----------------
/** Run a job. job: 'edit'|'form'|'combine'|'split'|'compress'|'convert'|'protect'|'scan'|'batch'|'compare' (tiles) or a
 *  right-click task ('open'|'sign'|'toimages'|'topdf'). files: already chosen (dropped, or from File Explorer), else it asks. */
async function runJob(job, files = null) {
  const pick = async (kind = 'pdf', multi = false, title) => files && files.length ? files : (await bridge.call('pdf:pickFiles', kind, multi, title)) || [];
  const pdfs = (list) => list.filter((f) => /\.pdf$/i.test(f));
  const openOne = async (title) => { const f = pdfs(await pick('pdf', false, title))[0]; return f ? openTab(f) : null; };
  switch (job) {
    case 'open': { const list = pdfs(await pick('pdf', true)); if (list.length) await openFiles(list); return; }
    case 'edit': { const t = await openOne('Choose the PDF to edit or sign'); if (t) { setTool('select'); $('#signbtn').focus(); toast('Add text, ticks and your signature with the tools at the top. Save when you\'re done.'); } return; }
    case 'sign': { const t = await openOne('Choose the PDF to sign'); if (t) { setTimeout(() => placeMine('signature'), 400); } return; }
    case 'form': { const t = await openOne('Choose the form to fill in'); if (t) { showSidePanel('forms'); setTimeout(() => { if (!st.form.length) toast('This PDF has no fillable boxes. Use Add text and Tick to fill it in.'); }, 1500); } return; }
    case 'split': { const t = await openOne('Choose the PDF to split'); if (t) await tools.split(); return; }
    case 'protect': { const t = await openOne('Choose the PDF to protect'); if (t) await commands.protect(); return; }
    case 'compress': {
      const list = pdfs(await pick('pdf', true, 'Choose the PDF(s) to compress'));
      if (list.length > 1) { home.openPage('batch', { files: list, actions: ['compress'] }); return; }
      if (list.length && await openTab(list[0])) await tools.compress();
      return;
    }
    case 'combine': home.openPage('combine', { files: files || [] }); return;
    case 'convert': home.openPage('convert', { files: files || [] }); return;
    case 'toimages': home.openPage('convert', { files: files || [], mode: 'images' }); return;
    case 'topdf': home.openPage('convert', { files: files || [], mode: 'pictures' }); return;
    case 'scan': home.openPage('scan', { files: files || [] }); return;
    case 'batch': home.openPage('batch', { files: files || [] }); return;
    case 'compare': home.openPage('compare', { files: files || [] }); return;
    default: toast('That isn\'t something Riyeser PDF can do yet.');
  }
}
/** A task handed over by Windows (right-click menu, "Open with") or the Print to PDF inbox. */
async function runTask(task) {
  if (!task || !task.files || !task.files.length) return;
  if (task.from === 'inbox') toast(`Opened ${fileName(task.files[0])} from your Riyeser PDF inbox.`);
  if (task.task === 'compress' && task.files.length === 1) { if (await openTab(task.files[0])) await tools.compress(); return; }
  if (task.task === 'toimages') { await home.pdfsToImages(task.files.filter((f) => /\.pdf$/i.test(f))); return; }
  // several files selected in File Explorer: Windows hands them over in no fixed order, so they're put in name order
  if (task.files.length > 1) task.files.sort((a, b) => fileName(a).localeCompare(fileName(b), undefined, { numeric: true }));
  await runJob(task.task, task.files);
}

// ---------------- commands ----------------
const commands = {
  shapesmenu: () => toggleMenu('shapesmenu'),
  signmenu: () => toggleMenu('signmenu'),
  stampmenu: () => toggleMenu('stampmenu'),
  toolsmenu: () => toggleMenu('toolsmenu'),
  ...Object.fromEntries(Object.entries(tools).filter(([k]) => !['stamp'].includes(k)).map(([k, fn]) => [k, async () => { closeMenus(); try { await fn(); } catch (e) { toast(e.message); } }])),
  stamp: () => toggleMenu('stampmenu'),
  open: () => runJob('open'),
  home: showHome,
  settings: () => home.openPage('settings'),
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
    const text = stampDate();
    const { src, vx, vy } = centerOfCurrentPage(text.length * s.size * 0.5, s.size * 1.2);
    pushUndo();
    const a = addAnn(src, { id: newId(), type: 'text', text, ...s, ...boxFromView(src, vx, vy, 0, 0) });
    setTool('select'); select(a.id);
    toast('Drag the date into place.');
  },
  signature: () => { closeMenus(); return openSignature('signature'); },
  initialsnew: () => { closeMenus(); return openSignature('initials'); },
  mysignature: () => { closeMenus(); return placeMine('signature'); },
  myinitials: () => { closeMenus(); return placeMine('initials'); },
  signrequest: () => { closeMenus(); return askSomeoneToSign(); },
  signstatus: () => { closeMenus(); return signRequest && signRequest.openStatus(); },
  sigclose: closeSigModal,
  sigclear: resetPad,
  sigplace: placeSignature,
  sigupload: async () => { const d = await bridge.call('image:openDialog'); if (d) { sigUpload = await knockOutWhite(d); $('#sigimg').src = sigUpload; } },
  filldetails: fillMyDetails,
  fillundo: undoFill,
  ocr: recognisePages,
  // OWNER-BACKUP: the program's own backups (Riyeser PDF: signatures and recent files; in Desk Assistant, Desk Assistant's)
  backupnow: async () => { const f = await bridge.call('backup:now'); toast(`Backed up: ${String(f).split(/[\\/]/).pop()}`); },
  backuprestore: () => bridge.call('backup:restore'),
  backupfolder: () => bridge.call('backup:folder'),
  pdfbackups: () => bridge.call('pdf:backups'),
  // S41: "Protect with a password" (payslips, invoices): the file needs the password to open once it's saved
  async protect() {
    if (!st.doc) return;
    const r = await dialog(`<h2>🔒 Protect with a password</h2>
      <p class="muted">Anyone opening the saved PDF will need this password. Keep it safe: it can't be recovered.</p>
      <div class="dlgrow"><label for="pw1">Password</label><input id="pw1" type="password" style="flex:1" autocomplete="new-password"></div>
      <div class="dlgrow"><label for="pw2">Again</label><input id="pw2" type="password" style="flex:1" autocomplete="new-password"></div>
      <div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Protect when I save</button></div>`, () => $('#pw1').focus());
    if (r !== 'ok') return;
    const a = $('#pw1').value; const b = $('#pw2').value;
    if (!a) throw new Error('Type a password.');
    if (a !== b) throw new Error('The two passwords don\'t match.');
    st.protect = { password: a }; setDirty();
    toast('Now save the PDF: it will need this password to open.');
  },
  makedefault: async () => {
    const name = await bridge.call('pdf:makeDefault');
    toast(`Windows Settings is opening: choose “${name}” for .pdf and you're done.`);
  },
  image: async () => { if (!st.doc) return toast('Open a PDF first.'); const d = await bridge.call('image:openDialog'); if (d) placeImage(d, 220); return null; },
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (b && commands[b.dataset.cmd]) { e.preventDefault(); Promise.resolve(commands[b.dataset.cmd]()).catch((err) => toast(err.message)); }
});

document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menuwrap')) closeMenus(); });
document.addEventListener('keydown', (e) => {
  const typing = e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (!$('#dlg').hidden || !$('#sigmodal').hidden) { if (e.key === 'Escape' && !$('#sigmodal').hidden) closeSigModal(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); commands.open(); return; }
  if (mod && e.key === 'Tab') { e.preventDefault(); const i = tabs.list.indexOf(tabs.active); const n = tabs.list[(i + (e.shiftKey ? -1 : 1) + tabs.list.length) % tabs.list.length]; if (n) activate(n); return; }
  if (tabs.view !== 'doc') return;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); return; }
  if (mod && e.key.toLowerCase() === 'w') { e.preventDefault(); closeTab(tabs.active); return; }
  if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(st.zoom * 1.2); return; }
  if (mod && e.key === '-') { e.preventDefault(); setZoom(st.zoom / 1.2); return; }
  if (e.target.closest && e.target.closest('button, a, .menu')) return; // keys on a button belong to the button
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
  if (e.key === 'Escape') { setTool('select'); select(null); return; }
  const keys = { v: 'select', t: 'text', e: 'edittext', h: 'highlight', p: 'draw' };
  if (!mod && keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
});

// Ask before closing with unsaved work (in any tab).
let closing = false;
window.addEventListener('beforeunload', (e) => {
  const dirty = tabs.list.filter((t) => t.st.dirty);
  if (!dirty.length || closing) return;
  e.returnValue = false;
  const names = dirty.map((t) => fileName(t.st.file) || 'a new PDF');
  bridge.call('confirm', 'Close without saving?', `Your changes to ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} will be lost.`).then((ok) => { if (ok) { closing = true; window.close(); } });
});

// ---------------- drag and drop: anywhere in the window ----------------
const droppedPaths = (e) => [...(e.dataTransfer?.files || [])].map((f) => bridge.pathForFile(f)).filter(Boolean);
window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
window.addEventListener('drop', async (e) => {
  document.body.classList.remove('dropping');
  if (e.defaultPrevented) return; // a tile or a task page took it
  const files = droppedPaths(e); if (!files.length) return;
  e.preventDefault();
  const pdfs = files.filter((f) => /\.pdf$/i.test(f)); const pics = files.filter((f) => /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i.test(f));
  if (pdfs.length) await openFiles(pdfs);
  else if (pics.length) home.openPage('convert', { files: pics, mode: 'pictures' });
  else toast('Drop PDFs or pictures here.');
});

// ---------------- start ----------------
const editorApi = {
  bridge, toast, dialog, esc, Hy, pdfjsLib, runJob, openFiles, openTab, setView, showHome, fileName, compressBytes, kb,
  get st() { return st; }, get tabs() { return tabs; }, get platform() { return prefs.platform; },
  reloadPrefs: loadPrefs,
  ocrFile: async (f) => { if (await openTab(f)) await recognisePages(); },
};
const home = initHome(editorApi);
window.__editor = { get st() { return st; }, buildPdf, openFile, openTab, openFiles, setTool, commands, runJob, runTask, tabs, home, closeTab, fillMyDetails }; // used by automated tests
bridge.call('app:platform').then((p) => { if (p === 'win32') $$('.windows-only').forEach((el) => { el.hidden = false; }); });
bridge.on('pdf:task', (task) => runTask(task));
loadPrefs();
loadSignRequest();
showHome();
(async () => {
  const file = new URLSearchParams(location.search).get('file');
  if (file) await openTab(file);
  const waiting = await bridge.call('pdf:pendingTask').catch(() => []);
  for (const t of waiting || []) await runTask(t);
})();
