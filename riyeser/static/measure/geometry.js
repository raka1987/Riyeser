/* Riyeser Estimate geometry for the live figures while drawing: the same maths as riyeser/measure/geometry.py
   (the server works the saved figures out again; keep them in step). */
(function (root) {
  'use strict';
  const A = 6378137.0, E2 = 0.00669437999014;
  const rad = (d) => (d * Math.PI) / 180;
  function ringArea(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return p.length < 3 ? 0 : Math.abs(s) / 2; }
  function pathLengths(p, closed) { const o = []; for (let i = 0; i < p.length - 1; i++) o.push(Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1])); if (closed && p.length > 2) o.push(Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1])); return o; }
  /** lat/lng -> metres on a plane touching the earth at origin (WGS84 radii at that latitude). */
  function localXY(ll, origin) {
    if (!ll.length) return [];
    const o = origin || [ll.reduce((s, p) => s + p[0], 0) / ll.length, ll.reduce((s, p) => s + p[1], 0) / ll.length];
    const phi = rad(o[0]); const w = 1 - E2 * Math.sin(phi) ** 2;
    const M = (A * (1 - E2)) / w ** 1.5, N = A / Math.sqrt(w);
    return ll.map((p) => [rad(p[1] - o[1]) * N * Math.cos(phi), rad(p[0] - o[0]) * M]);
  }
  function plane(d) {
    if (d.latlngs && d.latlngs.length) {
      const all = d.latlngs.concat(...(d.holes || []));
      const o = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length];
      return [localXY(d.latlngs, o), (d.holes || []).map((h) => localXY(h, o))];
    }
    const s = +d.scale || 0;
    return [(d.points || []).map((p) => [p[0] * s, p[1] * s]), (d.holes || []).map((h) => h.map((p) => [p[0] * s, p[1] * s]))];
  }
  function pitchDeg(p) { if (!p) return 0; if (typeof p === 'number') return p; if (p.rise != null && p.rise !== '' && +p.run > 0) return (Math.atan(+p.rise / +p.run) * 180) / Math.PI; return +p.deg || 0; }
  const pitchFactor = (deg) => 1 / Math.cos(rad(deg));
  const hipFactor = (deg) => Math.sqrt(1 + Math.tan(rad(deg)) ** 2 / 2);
  function edgeTrue(kind, L, deg) { return kind === 'rake' ? L * pitchFactor(deg) : kind === 'hip' || kind === 'valley' ? L * hipFactor(deg) : L; }
  const ceil = (x) => (x > 0 ? Math.ceil(x - 1e-9) : 0);
  function fencePosts(segs, spacing, gates, closed) { segs = segs.filter((s) => s > 0); if (!(spacing > 0) || !segs.length) return 0; return segs.reduce((n, s) => n + ceil(s / spacing), 0) + (closed ? 0 : 1) + (gates | 0); }
  /** The live figures for a drawn shape: {area, perimeter, length, count, roof_area, posts, ...} in SI. */
  function quantities(kind, d) {
    const q = {};
    if (kind === 'shape' || kind === 'roof') {
      const [o, h] = plane(d); const a = Math.max(0, ringArea(o) - h.reduce((s, r) => s + ringArea(r), 0));
      q.perimeter = pathLengths(o, true).reduce((s, x) => s + x, 0);
      if (kind === 'roof') { const deg = pitchDeg(d.pitch); q.roof_plan_area = a; q.roof_area = a * pitchFactor(deg); q.pitch_deg = deg;
        const segs = pathLengths(o, true); (d.edges || []).forEach((t, i) => { if (t && segs[i] != null) q[t] = (q[t] || 0) + edgeTrue(t, segs[i], deg); });
      } else q.area = a;
    } else if (kind === 'line' || kind === 'fence') {
      const [p] = plane(d); const segs = pathLengths(p, !!d.closed); const L = segs.reduce((s, x) => s + x, 0);
      if (kind === 'line') q.length = L; else {
        const gates = (d.gates || []).reduce((n, g) => n + (+g.count || 1), 0); const gw = (d.gates || []).reduce((n, g) => n + (+g.width || 0) * (+g.count || 1), 0);
        q.fence_length = L; q.panel_length = Math.max(0, L - gw); q.gates = gates; q.posts = fencePosts(segs, +d.spacing, gates, !!d.closed);
      }
    } else if (kind === 'markers') q.count = (d.points || d.latlngs || []).length;
    return q;
  }
  function segLengths(d, closed) { const [p] = plane(d); return pathLengths(p, closed); }
  const api = { ringArea, pathLengths, localXY, plane, pitchDeg, pitchFactor, hipFactor, edgeTrue, fencePosts, quantities, segLengths };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RG = api;
})(this);
