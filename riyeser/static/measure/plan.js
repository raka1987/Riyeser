/* Riyeser Estimate: measuring on a PDF plan or a photo. pdf.js (vendored, Apache-2.0) draws the page; the lines are an
   SVG on top, in the page's own units (PDF points at 100%, or the photo's pixels), so the scale is metres per unit.
   Works offline: nothing here needs the internet. */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

const RE = window.RE; const cfg = RE.cfg; const esc = RE.esc;
pdfjsLib.GlobalWorkerOptions.workerSrc = cfg.urls.static + 'vendor/pdfjs/pdf.worker.min.mjs';
const stage = document.getElementById('stage');
const hintEl = document.getElementById('hint');
const sel = document.getElementById('plansel');
const NS = 'http://www.w3.org/2000/svg';
const PT_M = 0.0254 / 72;   // metres in a PDF point (1/72 inch) at 1:1
const RES = 2;              // canvas pixels per page unit (sharp when zoomed in)

let plans = cfg.plans.slice(); let plan = null; let pageNo = 1; let pdf = null; let pageW = 0; let pageH = 0;
let z = 1; let tx = 0; let ty = 0; let layer = null; let svg = null; let ready = false;

const hint = (t) => { if (hintEl) { hintEl.textContent = t; hintEl.hidden = !t; } };
const key = () => (plan ? `${plan.id}:${pageNo}` : '');
const scale = () => ((cfg.pages[key()] || {}).scale) || 0;

function showScale() {
  const p = cfg.pages[key()] || {};
  document.getElementById('scaleinfo').textContent = p.scale ? (p.note || 'set') + (plan && plan.mime === 'application/pdf' ? '' : ' (photo: check it on a known size)') : 'not set: press Set scale';
  const std = document.getElementById('stdscale'); if (std) std.disabled = !plan || plan.mime !== 'application/pdf';
}

function apply() { if (layer) layer.style.transform = `translate(${tx}px,${ty}px) scale(${z})`; }
function fit() {
  if (!pageW) return;
  const r = stage.getBoundingClientRect();
  z = Math.min(r.width / pageW, r.height / pageH) * 0.96; tx = (r.width - pageW * z) / 2; ty = (r.height - pageH * z) / 2; apply();
}
function zoomAt(f, cx, cy) {
  const r = stage.getBoundingClientRect(); cx = cx == null ? r.width / 2 : cx; cy = cy == null ? r.height / 2 : cy;
  const nz = Math.max(0.05, Math.min(40, z * f)); tx = cx - ((cx - tx) * nz) / z; ty = cy - ((cy - ty) * nz) / z; z = nz; apply();
}

async function open(p, page = 1) {
  plan = p; pageNo = page; ready = false; stage.querySelectorAll('.layer').forEach((x) => x.remove());
  layer = document.createElement('div'); layer.className = 'layer'; layer.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0';
  stage.prepend(layer);
  const url = `${cfg.urls.base}${cfg.tid}/plans/${p.id}/file`;
  try {
    if (p.mime === 'application/pdf') {
      if (!pdf || pdf._rid !== p.id) { pdf = await pdfjsLib.getDocument({ url, isEvalSupported: false, standardFontDataUrl: cfg.urls.static + 'vendor/pdfjs/standard_fonts/' }).promise; pdf._rid = p.id; }
      if (pdf.numPages !== p.pages) { p.pages = pdf.numPages; RE.api(`${cfg.urls.base}${cfg.tid}/plans/${p.id}/page`, { page: pageNo, pages: pdf.numPages }).catch(() => {}); }
      const pg = await pdf.getPage(pageNo); const vp = pg.getViewport({ scale: 1 });
      pageW = vp.width; pageH = vp.height;
      const c = document.createElement('canvas'); c.width = Math.round(pageW * RES); c.height = Math.round(pageH * RES);
      c.style.width = pageW + 'px'; c.style.height = pageH + 'px'; layer.appendChild(c);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: pg.getViewport({ scale: RES }) }).promise;
    } else {
      const img = new Image(); img.className = 'planimg'; img.alt = p.name || 'Plan'; img.draggable = false;
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
      pageW = img.naturalWidth; pageH = img.naturalHeight; img.style.width = pageW + 'px'; img.style.height = pageH + 'px';
      layer.appendChild(img);
    }
  } catch (e) { hint('That plan couldn\'t be opened: ' + (e.message || e)); return; }
  svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'overlay'); svg.setAttribute('width', pageW); svg.setAttribute('height', pageH);
  svg.setAttribute('viewBox', `0 0 ${pageW} ${pageH}`); svg.style.cssText = `position:absolute;left:0;top:0;width:${pageW}px;height:${pageH}px`;
  layer.appendChild(svg);
  RE.api(`${cfg.urls.base}${cfg.tid}/plans/${p.id}/page`, { page: pageNo, width: pageW, height: pageH }).catch(() => {});
  document.getElementById('pginfo').textContent = `Page ${pageNo} of ${p.pages || 1}`;
  ready = true; fit(); showScale(); sketch.render();
  hint(scale() ? '' : 'Set the scale first: press Set scale and draw along a size you know.');
}

// ---------- drawing ----------
const adapter = {
  source: 'plan', key: 'points',
  owns: (i) => i.source === 'plan' && i.plan_id === (plan && plan.id) && (i.page || 1) === pageNo,
  extra: () => ({ plan_id: plan.id, page: pageNo }),
  geometry(pts) {
    if (!plan) return null;
    if (sketch.tool !== 'markers' && sketch.tool !== 'scale' && !scale()) return null;
    return { points: pts.map((p) => [round(p[0]), round(p[1])]), scale: scale(), page: pageNo };
  },
  hint, setTool(t) { stage.style.cursor = t === 'pan' ? 'grab' : 'crosshair'; },
  render(S) {
    if (!svg) return;
    const w = 1.6 / z; const items = RE.items.filter(adapter.owns);
    let h = '';
    for (const it of items) h += shape(it.kind, it.data.points || [], it.color, it.label, it.data.holes, w);
    if (S.pts.length) h += shape(S.tool === 'hole' ? 'shape' : S.tool, S.pts, S.color, '', null, w, true);
    svg.innerHTML = h;
  },
  askScale(pts) {
    const units = cfg.units === 'imperial' ? 'feet (or 12\' 6")' : 'metres (or 2400mm)';
    const v = window.prompt(`How long is that in real life? Type it in ${units}.`);
    if (!v) return;
    let m; try { m = RU.parseLength(v, cfg.units); } catch (e) { RE.toast(e.message, true); return; }
    const d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    if (!(m > 0) || !(d > 0)) { RE.toast('Draw along something with a length.', true); return; }
    setScale(m / d, `line of ${RU.fmt(m, 'length', cfg.units)}`);
  },
};
const round = (v) => Math.round(v * 100) / 100;
function shape(kind, pts, color, label, holes, w, live) {
  if (!pts.length) return '';
  const P = (a) => a.map((p) => p.join(',')).join(' ');
  const dash = live ? ` stroke-dasharray="${4 * w} ${3 * w}"` : '';
  let s = '';
  if (kind === 'markers') s = pts.map((p, n) => `<circle cx="${p[0]}" cy="${p[1]}" r="${6 * w}" fill="${color}" stroke="#fff" stroke-width="${w}"/><text x="${p[0] + 7 * w}" y="${p[1] - 7 * w}" font-size="${11 * w}" fill="${color}" font-weight="700">${n + 1}</text>`).join('');
  else if ((kind === 'shape' || kind === 'roof') && pts.length > 2 && !live) {
    const d = [pts, ...(holes || [])].map((r) => 'M' + r.map((p) => p.join(',')).join('L') + 'Z').join(' ');
    s = `<path d="${d}" fill="${color}" fill-opacity=".22" fill-rule="evenodd" stroke="${color}" stroke-width="${2 * w}"/>`;
  } else s = `<polyline points="${P(pts)}${(kind === 'shape' || kind === 'roof' || kind === 'hole') && pts.length > 2 ? ' ' + pts[0].join(',') : ''}" fill="none" stroke="${color}" stroke-width="${2.2 * w}"${dash}/>` + pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="${3.5 * w}" fill="#fff" stroke="${color}" stroke-width="${1.4 * w}"/>`).join('');
  if (label && pts.length) { const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length; s += `<text x="${cx}" y="${cy}" font-size="${12 * w}" text-anchor="middle" fill="#0f172a" stroke="#fff" stroke-width="${3 * w}" paint-order="stroke" font-weight="700">${esc(label)}</text>`; }
  return s;
}
const sketch = RE.Sketch(adapter);
RE.onItems(() => { sketch.render(); snapshotSoon(); });

async function setScale(s, note) {
  try {
    await RE.api(`${cfg.urls.base}${cfg.tid}/plans/${plan.id}/page`, { page: pageNo, scale: s, note });
    cfg.pages[key()] = { scale: s, note }; showScale(); hint('');
    const j = await RE.api(cfg.urls.items); RE.update(j);   // lines already drawn take the new scale
    RE.toast('Scale set: ' + note);
  } catch (e) { RE.toast(e.message, true); }
}
const std = document.getElementById('stdscale');
if (std) std.addEventListener('change', () => { const r = +std.value; if (r && plan && plan.mime === 'application/pdf') setScale(PT_M * r, `1:${r} (printed at full size)`); std.value = ''; });

// ---------- pointer: tap to add points, drag to move, pinch or wheel to zoom ----------
const toPage = (e) => { const r = stage.getBoundingClientRect(); return [(e.clientX - r.left - tx) / z, (e.clientY - r.top - ty) / z]; };
const ptrs = new Map(); let drag = null; let lastTap = { t: 0, x: 0, y: 0 }; let pinch = null;
stage.addEventListener('pointerdown', (e) => {
  if (!ready) return; stage.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, e);
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) }; drag = null; return; }
  drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
});
stage.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, e);
  if (pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); const r = stage.getBoundingClientRect(); zoomAt(d / pinch.d, (a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top); pinch.d = d; return; }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 6) drag.moved = true;
  if (drag.moved && (sketch.tool === 'pan' || e.pointerType !== 'mouse' || e.buttons === 4)) { tx = drag.tx + dx; ty = drag.ty + dy; apply(); }
});
stage.addEventListener('pointerup', (e) => {
  ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
  if (!drag) return; const moved = drag.moved; drag = null;
  if (moved || sketch.tool === 'pan') return;
  const now = Date.now(); const dbl = now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 14;
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  if (dbl && sketch.tool !== 'markers') { sketch.finish(); return; }
  sketch.add(toPage(e));
});
stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); sketch.render(); }, { passive: false });
const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
on('zin', () => { zoomAt(1.25); sketch.render(); }); on('zout', () => { zoomAt(0.8); sketch.render(); }); on('zfit', () => { fit(); sketch.render(); });
on('pgprev', () => { if (plan && pageNo > 1) open(plan, pageNo - 1); });
on('pgnext', () => { if (plan && pageNo < (plan.pages || 1)) open(plan, pageNo + 1); });
if (sel) sel.addEventListener('change', () => { const p = plans.find((x) => x.id === +sel.value); if (p) open(p, 1); });

// ---------- open a new plan or photo ----------
const file = document.getElementById('planfile');
if (file) file.addEventListener('change', async () => {
  const f = file.files[0]; if (!f) return;
  const fd = new FormData(); fd.append('file', f);
  if (f.type === 'application/pdf') { try { const d = await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()), isEvalSupported: false }).promise; fd.append('pages', d.numPages); } catch { /* the server checks it */ } }
  hint('Opening ' + f.name + '…');
  try {
    const r = await fetch(cfg.urls.plans, { method: 'POST', body: fd, credentials: 'same-origin' });
    const j = await r.json(); if (!j.ok) throw new Error(j.error);
    plans.push(j.plan); const o = document.createElement('option'); o.value = j.plan.id; o.textContent = j.plan.name; sel.appendChild(o); sel.value = j.plan.id;
    await open(j.plan, 1);
  } catch (e) { RE.toast(e.message || 'Couldn\'t open that file.', true); hint('Open a plan or photo to start.'); }
  file.value = '';
});

// ---------- a picture of the page with your lines, for the quote's measurements page ----------
let snapT = null;
function snapshotSoon() { clearTimeout(snapT); snapT = setTimeout(snapshot, 1200); }
async function snapshot() {
  if (!ready || !layer || !RE.items.some(adapter.owns)) return;
  try {
    const maxW = 1600; const k = Math.min(1, maxW / pageW) * 1; const W = Math.round(pageW * k * 1), H = Math.round(pageH * k);
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const base = layer.querySelector('canvas,img'); if (base) g.drawImage(base, 0, 0, W, H);
    const s = svg.cloneNode(true); s.setAttribute('xmlns', NS);
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(s));
    await img.decode(); g.drawImage(img, 0, 0, W, H);
    await RE.api(`${cfg.urls.base}${cfg.tid}/plans/${plan.id}/page`, { page: pageNo, snapshot: c.toDataURL('image/png') });
  } catch { /* the PDF then shows the lines without the plan behind them */ }
}

window.addEventListener('resize', () => { if (ready) { fit(); sketch.render(); } });
sketch.setTool('pan');
if (plans.length) { if (sel) sel.value = plans[plans.length - 1].id; open(plans[plans.length - 1], 1); } else hint('Open a plan or photo to start.');
RE.plan = { open, setScale, fit, state: () => ({ z, tx, ty, pageW, pageH, scale: scale(), plan, pageNo }) };
