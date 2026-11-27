/* Riyeser Estimate, "Import a scan": choose a file -> the server reads it into rooms (riyeser/measure/scan/) -> check
   and edit the rooms here -> "Use these rooms" saves them as room measurements, so trade templates price them.
   Then the 3D mock-up (three.js, served by the app: works offline) and the floor plan update.
   Sizes are kept in SI (metres) and shown in the estimate's units. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';

const RE = window.RE, RU = window.RU, cfg = RE.cfg, esc = RE.esc;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const SYS = cfg.units, LU = RU.lenUnit(SYS);
const lenIn = (v) => (v == null || v === '' ? '' : String(+RU.fromSI(+v, LU).toFixed(3)));
const areaIn = (v) => (v == null || v === '' ? '' : String(+RU.fromSI(+v, SYS === 'imperial' ? 'ft2' : 'm2').toFixed(2)));
const fmtL = (v) => RU.fmt(v, 'length', SYS), fmtA = (v) => RU.fmt(v, 'area', SYS);
const QUALITY = { rooms: ['Full rooms', 'ok'], plan: ['From a 2D plan', 'plan'], list: ['Room list', 'plan'], mesh: ['Estimated from a 3D mesh', 'warn'] };
let scans = cfg.scans || [];
let editing = null;   // {scan, rooms}

function ringArea(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return p.length < 3 ? 0 : Math.abs(s) / 2; }
function roomFigures(r) {
  const H = +r.height || 0;
  let perim = 0, gross = 0;
  (r.walls || []).forEach((w) => { if (w.open) return; const h = +(w.height || H); gross += (+w.length || 0) * h; if (!w.extra) perim += +w.length || 0; });
  const ops = (r.openings || []).reduce((s, o) => s + (+o.width || 0) * (+o.height || 0) * (+o.count || 1), 0);
  const floor = r.floor_area != null && r.floor_area !== '' ? +r.floor_area : ringArea(r.outline || []);
  return { floor, perim, walls: Math.max(0, gross - ops) };
}

// ---------------------------------------------------------------- the list of imported files
function renderScans() {
  const box = $('#scanlist'); if (!box) return;
  box.innerHTML = scans.map((s) => {
    const q = QUALITY[s.quality] || ['', ''];
    const used = RE.items.filter((i) => i.source === 'scan' && i.data && i.data.scan_id === s.id).length;
    return `<div class="scanrow" data-scan="${s.id}"><div><b>${esc(s.name)}</b> <span class="small muted">${esc(s.format)} · ${(s.size / 1048576).toFixed(s.size > 1048576 ? 1 : 2)} MB</span>
      <div><span class="qbadge ${q[1]}">${esc(q[0])}</span> <span class="small muted">${used ? used + ' room' + (used > 1 ? 's' : '') + ' in use' : 'not used yet'}</span></div></div>
      <div class="scanbtns"><button type="button" class="btn sm" data-edit="${s.id}">${used ? 'Edit rooms' : 'Check rooms'}</button>
      <a class="btn sm" href="${esc(s.urls.file)}">Download</a>${cfg.readOnly ? '' : `<button type="button" class="btn sm danger" data-rm="${s.id}" aria-label="Remove ${esc(s.name)}">Remove</button>`}</div></div>`;
  }).join('') || '<p class="muted small" style="margin:8px 0 0">No scans imported yet.</p>';
}

document.addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-edit]');
  if (ed) { const s = scans.find((x) => x.id === +ed.dataset.edit); if (s) openEditor(s); return; }
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    const s = scans.find((x) => x.id === +rm.dataset.rm);
    if (!s || !window.confirm(`Remove ${s.name} and the rooms it added?`)) return;
    try {
      await RE.api(s.urls.delete, {});
      scans = scans.filter((x) => x !== s);
      if (editing && editing.scan.id === s.id) closeEditor();
      await refresh();
      RE.toast('Scan removed.');
    } catch (err) { RE.toast(err.message, true); }
  }
});

// ---------------------------------------------------------------- upload
const input = $('#scanfile');
if (input) input.addEventListener('change', async () => {
  const f = input.files[0]; if (!f) return;
  const st = $('#scanstatus');
  if (f.size > cfg.maxMB * 1048576) { st.innerHTML = `<p class="flash error">${esc(f.name)} is over ${cfg.maxMB} MB. Export the scan at a lower detail, or export its floor plan (DXF).</p>`; input.value = ''; return; }
  st.innerHTML = `<p class="scanbusy"><span class="spin" aria-hidden="true"></span> Reading ${esc(f.name)} (${(f.size / 1048576).toFixed(1)} MB)… big scans take a little while.</p>`;
  const fd = new FormData(); fd.append('file', f);
  try {
    const r = await fetch(cfg.urls.scans, { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } });
    let j = {}; try { j = await r.json(); } catch { j = { ok: false, error: r.status === 413 ? 'That file is too big.' : 'The server didn\'t answer. Try again.' }; }
    if (!r.ok || !j.ok) throw new Error(j.error || 'Couldn\'t read that file.');
    if (j.pdf) { st.innerHTML = `<p class="flash ok">${esc(j.message)} Opening it…</p>`; window.location = j.redirect; return; }
    scans.push(j.scan);
    st.innerHTML = '';
    renderScans();
    openEditor(j.scan);
  } catch (err) { st.innerHTML = `<p class="flash error">${esc(err.message)}</p>`; }
  input.value = '';
});

// ---------------------------------------------------------------- check and edit the rooms
function openEditor(scan) {
  const saved = RE.items.filter((i) => i.source === 'scan' && i.data && i.data.scan_id === scan.id).map((i) => JSON.parse(JSON.stringify(i.data)));
  editing = { scan, rooms: saved.length ? saved : JSON.parse(JSON.stringify(scan.rooms)), saved: saved.length > 0 };
  renderEditor();
  $('#roomedit').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function closeEditor() { editing = null; const b = $('#roomedit'); b.hidden = true; b.innerHTML = ''; }

function renderEditor() {
  const box = $('#roomedit'); const s = editing.scan; const q = QUALITY[s.quality] || ['', ''];
  const u = LU === 'ft' ? 'ft' : 'm', ua = SYS === 'imperial' ? 'sq ft' : 'm²';
  box.hidden = false;
  box.innerHTML = `<h3 style="margin:14px 0 4px">Rooms from ${esc(s.name)}</h3>
    <p class="small" style="margin:0 0 6px"><span class="qbadge ${q[1]}">${esc(q[0])}</span> ${esc(s.quality_text)}</p>
    ${s.quality === 'mesh' ? '<p class="scanwarn"><b>Estimated from a 3D mesh: check on site.</b> Sizes come from flat surfaces found in the scan. Furniture, open doors and gaps in the scan can throw them out.</p>' : ''}
    ${(s.notes || []).length ? `<ul class="small muted scannotes">${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <div class="roomcards">${editing.rooms.map((r, i) => roomCard(r, i, u, ua)).join('')}</div>
    <div class="est-foot" style="flex-wrap:wrap;gap:8px"><span class="small muted" id="roomsum" aria-live="polite"></span>
      ${cfg.readOnly ? '' : `<span><button type="button" class="btn" id="re_cancel">Close</button> <button type="button" class="btn pri big" id="re_use">${editing.saved ? 'Save changes' : 'Use these rooms'}</button></span>`}</div>`;
  summary();
}

function roomCard(r, i, u, ua) {
  const fig = roomFigures(r);
  const walls = (r.walls || []).map((w, k) => w.open ? '' : `<label class="wl">Wall ${k + 1}${w.extra ? ' (inside)' : ''}<input data-r="${i}" data-wall="${k}" data-f="length" value="${lenIn(w.length)}" inputmode="decimal" aria-label="${esc(r.name)} wall ${k + 1} length (${u})"></label>`).join('');
  const wallOpts = (sel) => (r.walls || []).map((w, k) => w.open ? '' : `<option value="${k}" ${+sel === k ? 'selected' : ''}>Wall ${k + 1}</option>`).join('');
  const ops = (r.openings || []).map((o, k) => `<div class="oprow"><select data-r="${i}" data-op="${k}" data-f="kind" aria-label="Kind"><option value="door" ${o.kind === 'door' ? 'selected' : ''}>Door</option><option value="window" ${o.kind === 'window' ? 'selected' : ''}>Window</option><option value="other" ${o.kind === 'other' ? 'selected' : ''}>Opening</option></select>
      <input data-r="${i}" data-op="${k}" data-f="width" value="${lenIn(o.width)}" inputmode="decimal" aria-label="Width (${u})" placeholder="width">
      <span aria-hidden="true">×</span><input data-r="${i}" data-op="${k}" data-f="height" value="${lenIn(o.height)}" inputmode="decimal" aria-label="Height (${u})" placeholder="height">
      <select data-r="${i}" data-op="${k}" data-f="wall" aria-label="Which wall"><option value="">Any wall</option>${wallOpts(o.wall)}</select>
      <button type="button" class="btn sm" data-r="${i}" data-opdel="${k}" aria-label="Remove this ${o.kind}">✕</button></div>`).join('');
  return `<div class="roomcard" data-room="${i}"><div class="rc-head"><input class="rc-name" data-r="${i}" data-f="name" value="${esc(r.name)}" aria-label="Room name">
      <button type="button" class="btn sm danger" data-rdel="${i}">Remove room</button></div>
    ${r.note ? `<p class="small muted" style="margin:2px 0 8px">${esc(r.note)}</p>` : ''}
    <div class="rc-grid"><label>Ceiling height (${u})<input data-r="${i}" data-f="height" value="${lenIn(r.height)}" inputmode="decimal"></label>
      <label>Floor area (${ua}) <small class="muted">blank: from the shape</small><input data-r="${i}" data-f="floor_area" value="${areaIn(r.floor_area)}" placeholder="${areaIn(ringArea(r.outline || []))}" inputmode="decimal"></label></div>
    <div class="small muted" style="margin:10px 0 4px">Wall lengths (${u})</div><div class="walls-grid">${walls}</div>
    <div class="small muted" style="margin:10px 0 4px">Doors and windows (width × height, ${u})</div>${ops || '<p class="small muted" style="margin:0">None found.</p>'}
    <button type="button" class="btn sm" data-opadd="${i}" style="margin-top:6px">+ Door or window</button>
    <p class="rc-fig small" data-fig="${i}">Floor ${fmtA(fig.floor)} · walls ${fmtA(fig.walls)} (less doors and windows) · perimeter ${fmtL(fig.perim)}</p></div>`;
}

function summary() {
  const t = editing.rooms.reduce((a, r) => { const f = roomFigures(r); a.floor += f.floor; a.walls += f.walls; return a; }, { floor: 0, walls: 0 });
  const el = $('#roomsum'); if (el) el.textContent = `${editing.rooms.length} room${editing.rooms.length === 1 ? '' : 's'}: floor ${fmtA(t.floor)}, walls ${fmtA(t.walls)}`;
  editing.rooms.forEach((r, i) => { const f = roomFigures(r); const p = $(`[data-fig="${i}"]`); if (p) p.textContent = `Floor ${fmtA(f.floor)} · walls ${fmtA(f.walls)} (less doors and windows) · perimeter ${fmtL(f.perim)}`; });
}

const edit = $('#roomedit');
if (edit) {
  edit.addEventListener('change', (e) => {
    const el = e.target; if (!editing || el.dataset.r == null) return;
    const r = editing.rooms[+el.dataset.r]; const f = el.dataset.f;
    try {
      if (el.dataset.wall != null) r.walls[+el.dataset.wall].length = RU.parseLength(el.value, SYS) || 0;
      else if (el.dataset.op != null) {
        const o = r.openings[+el.dataset.op];
        if (f === 'kind') o.kind = el.value;
        else if (f === 'wall') { if (el.value === '') { delete o.wall; delete o.offset; } else { o.wall = +el.value; o.offset = (+r.walls[o.wall].length || 1) / 2; } }
        else o[f] = RU.parseLength(el.value, SYS) || 0;
      } else if (f === 'name') r.name = el.value.trim() || r.name;
      else if (f === 'height') r.height = RU.parseLength(el.value, SYS) || r.height;
      else if (f === 'floor_area') { if (el.value.trim() === '') delete r.floor_area; else r.floor_area = RU.toSI(RU.num(el.value), SYS === 'imperial' ? 'ft2' : 'm2'); }
      el.classList.remove('bad');
    } catch (err) { el.classList.add('bad'); RE.toast(err.message, true); }
    summary();
  });
  edit.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || !editing) return;
    if (b.dataset.rdel != null) { editing.rooms.splice(+b.dataset.rdel, 1); renderEditor(); return; }
    if (b.dataset.opdel != null) { editing.rooms[+b.dataset.r].openings.splice(+b.dataset.opdel, 1); renderEditor(); return; }
    if (b.dataset.opadd != null) {
      const r = editing.rooms[+b.dataset.opadd]; const wi = (r.walls || []).findIndex((w) => !w.open);
      (r.openings = r.openings || []).push({ kind: 'door', width: SYS === 'imperial' ? 32 * RU.IN : 0.82, height: SYS === 'imperial' ? 80 * RU.IN : 2.04, sill: 0, count: 1, wall: wi >= 0 ? wi : undefined, offset: wi >= 0 ? (+r.walls[wi].length || 1) / 2 : undefined });
      renderEditor(); return;
    }
    if (b.id === 're_cancel') { closeEditor(); return; }
    if (b.id === 're_use') {
      b.disabled = true;
      try {
        const j = await RE.api(editing.scan.urls.rooms, { rooms: editing.rooms });
        RE.update(j);
        setPlan(j.floorplan);
        editing.saved = true;
        RE.toast(`${editing.rooms.length} room${editing.rooms.length === 1 ? '' : 's'} added. Next: choose a template.`);
        closeEditor();
        renderScans();
        await loadModel();
        $('#view3d').scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (err) { RE.toast(err.message, true); } finally { b.disabled = false; }
    }
  });
}

function setPlan(svg) {
  const sec = $('#floorplan'), w = $('#fpwrap'); if (!sec || !w) return;
  w.innerHTML = svg || ''; sec.hidden = !svg;
}
async function refresh() {
  const j = await RE.api(cfg.urls.items); RE.update(j);
  try { const r = await fetch(cfg.urls.floorplan, { credentials: 'same-origin' }); setPlan(r.ok ? await r.text() : ''); } catch { /* offline */ }
  renderScans(); await loadModel();
}
RE.onItems(() => renderScans());

// ---------------------------------------------------------------- the 3D mock-up
const stage = $('#three');
const V = (RE.view3d = { ready: false, walls: 0, rooms: 0, openings: 0, error: null });
let renderer, labelRenderer, scene, camera, controls, group, meshGroup, model = null;
const opts = { openings: true, labels: true, scan: false, wall: null, floor: null };

function initThree() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  } catch (err) {
    V.error = 'WebGL'; stage.innerHTML = '<p class="hint">The 3D view needs WebGL, which this browser has turned off. The rooms and floor plan still work.</p>';
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0xf3f5f8);
  stage.innerHTML = ''; stage.appendChild(renderer.domElement);
  labelRenderer = new CSS2DRenderer(); labelRenderer.domElement.className = 'v3d-labels'; stage.appendChild(labelRenderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
  controls = new OrbitControls(camera, renderer.domElement);
  V.camera = camera;
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.495; controls.screenSpacePanning = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb0a898, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(6, 12, 4); scene.add(sun);
  group = new THREE.Group(); scene.add(group); meshGroup = new THREE.Group(); scene.add(meshGroup);
  new ResizeObserver(size).observe(stage); size();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); labelRenderer.render(scene, camera); });
  return true;
}
function size() {
  if (!renderer) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false); renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
  labelRenderer.setSize(w, h); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
}
function label(text, cls, pos) {
  const d = document.createElement('div'); d.className = 'v3d-label ' + cls; d.textContent = text;
  const o = new CSS2DObject(d); o.position.copy(pos); o.userData.label = true; return o;
}
const tint = (hex, k) => new THREE.Color(hex).lerp(new THREE.Color(0xffffff), k);
function clear(g) { while (g.children.length) { const c = g.children.pop(); c.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); if (x.element) x.element.remove(); }); } }

function build() {
  if (!scene) return;
  clear(group); V.walls = 0; V.openings = 0; V.rooms = 0;
  if (!model || !model.rooms.length) { $('#threehint') || stage.insertAdjacentHTML('beforeend', '<p class="hint" id="threehint">The rooms show here once they\'re added.</p>'); return; }
  const hint = $('#threehint'); if (hint) hint.remove();
  const T = 0.09;   // wall thickness for the mock-up
  const box = new THREE.Box3();
  for (const r of model.rooms) {
    V.rooms++;
    const o = r.outline, n = o.length;
    const wallMat = new THREE.MeshStandardMaterial({ color: opts.wall ? new THREE.Color(opts.wall) : tint(r.color, 0.72), roughness: 0.9 });
    const floorMat = new THREE.MeshStandardMaterial({ color: opts.floor ? new THREE.Color(opts.floor) : tint(r.color, 0.45), roughness: 0.8, side: THREE.DoubleSide });
    const shape = new THREE.Shape(o.map((p) => new THREE.Vector2(p[0], -p[1])));
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), floorMat); floor.rotation.x = -Math.PI / 2; group.add(floor);
    for (let i = 0; i < n; i++) {
      const w = r.walls[i]; if (!w || w.open) continue;
      const a = o[i], b = o[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-3) continue;
      const H = +w.height || r.height, ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const ops = opts.openings ? r.openings.filter((x) => x.wall === i).sort((x, y) => x.offset - y.offset) : [];
      const pieces = []; let t = 0;   // solid pieces around the doors and windows: [from, to, bottom, top]
      for (const op of ops) {
        const s0 = Math.max(t, op.offset - op.width / 2), s1 = Math.min(L, op.offset + op.width / 2);
        if (s0 > t) pieces.push([t, s0, 0, H]);
        if (op.sill > 0.01) pieces.push([s0, s1, 0, Math.min(op.sill, H)]);
        if (op.sill + op.height < H - 0.01) pieces.push([s0, s1, op.sill + op.height, H]);
        t = Math.max(t, s1);
        const glass = op.kind === 'window', door = op.kind === 'door';
        if (glass || door) {   // a pane or a door leaf in the gap
          const m = new THREE.Mesh(new THREE.BoxGeometry(s1 - s0, op.height, glass ? 0.02 : 0.04),
            new THREE.MeshStandardMaterial({ color: glass ? 0x7cc4e4 : 0x8a5a3c, transparent: glass, opacity: glass ? 0.45 : 1, roughness: 0.4 }));
          place(m, a, ang, (s0 + s1) / 2, op.sill + op.height / 2); group.add(m); V.openings++;
        }
      }
      if (t < L) pieces.push([t, L, 0, H]);
      for (const [s0, s1, y0, y1] of pieces) {
        if (s1 - s0 < 0.005 || y1 - y0 < 0.005) continue;
        const m = new THREE.Mesh(new THREE.BoxGeometry(s1 - s0 + (s0 === 0 || s1 === L ? T / 2 : 0), y1 - y0, T), wallMat);
        place(m, a, ang, (s0 + s1) / 2 + (s0 === 0 && s1 !== L ? -T / 4 : s1 === L && s0 !== 0 ? T / 4 : 0), (y0 + y1) / 2);
        m.userData.wall = true; group.add(m);
      }
      V.walls++;
      if (opts.labels) group.add(label(w.text, 'len', new THREE.Vector3((a[0] + b[0]) / 2, H + 0.12, (a[1] + b[1]) / 2)));
    }
    const cx = o.reduce((s, p) => s + p[0], 0) / n, cz = o.reduce((s, p) => s + p[1], 0) / n;
    if (opts.labels) group.add(label(`${r.label} · ${r.area_text}${r.estimated ? ' (estimate)' : ''}`, 'room', new THREE.Vector3(cx, 0.05, cz)));
    o.forEach((p) => { box.expandByPoint(new THREE.Vector3(p[0], 0, p[1])); box.expandByPoint(new THREE.Vector3(p[0], r.height, p[1])); });
  }
  V.box = box;
  if (!V.ready) frame();
  V.ready = true; stage.dataset.ready = '1';
}
function place(m, a, ang, along, y) {   // a piece `along` metres from corner a, on the wall's line
  m.position.set(a[0] + Math.cos(ang) * along, y, a[1] + Math.sin(ang) * along);
  m.rotation.y = -ang;
}
function frame() {
  const box = V.box; if (!box || box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.z, 3) * 0.5;
  const dist = r / Math.tan((camera.fov * Math.PI) / 360) * (camera.aspect < 1 ? 1.9 / camera.aspect : 1.25);
  camera.position.set(c.x + dist * 0.55, c.y + dist * 0.85, c.z + dist * 0.75);
  controls.target.set(c.x, 0.8, c.z); controls.update();
}
async function loadScanMesh() {
  clear(meshGroup);
  if (!opts.scan || !model) return;
  for (const m of model.meshes) {
    try {
      const r = await fetch(m.url, { credentials: 'same-origin' }); if (!r.ok) continue;
      const pos = new Float32Array(await r.arrayBuffer());
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9aa3af, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      mesh.position.set(m.shift[0], 0, m.shift[1]); meshGroup.add(mesh);
    } catch { /* the rooms still show */ }
  }
}
async function loadModel() {
  if (!stage) return;
  try { model = await RE.api(cfg.urls.model); } catch { model = null; }
  if (!model || !model.rooms.length) { build(); return; }
  if (!renderer && !initThree()) return;
  build();
  const sc = $('#v_scan'); if (sc) { sc.disabled = !model.meshes.length; sc.closest('label').hidden = !model.meshes.length; }
  await loadScanMesh();
}
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
on('#v_openings', 'change', (e) => { opts.openings = e.target.checked; build(); });
on('#v_labels', 'change', (e) => { opts.labels = e.target.checked; build(); });
on('#v_scan', 'change', (e) => { opts.scan = e.target.checked; loadScanMesh(); });
on('#v_wall', 'input', (e) => { opts.wall = e.target.value; build(); });
on('#v_floor', 'input', (e) => { opts.floor = e.target.value; build(); });
on('#v_roomcol', 'click', () => { opts.wall = opts.floor = null; build(); });
on('#v_reset', 'click', () => frame());

renderScans();
loadModel();
