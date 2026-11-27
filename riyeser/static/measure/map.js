/* Riyeser Estimate: measuring on the map. Leaflet (vendored, BSD-2-Clause) shows the imagery provider's tiles (Esri
   World Imagery by default, with its attribution); the business's own lines are drawn on top. Only those lines
   (latitude/longitude points) are saved, never the imagery: nothing is cached or exported, and the quote PDF draws
   the lines on a plain background. The map needs the internet; everything else in Estimate works offline. */
(function () {
  'use strict';
  const RE = window.RE; const cfg = RE.cfg; const M = cfg.map; const esc = RE.esc;
  const el = document.getElementById('map'); const info = document.getElementById('mapinfo');
  if (!window.L || !el) return;
  const view = M.view || { lat: 0, lng: 0, zoom: 2 };
  const map = L.map(el, { zoomControl: true, doubleClickZoom: false, tap: true, maxZoom: M.maxZoom || 21 }).setView([view.lat, view.lng], view.zoom);
  const tiles = L.tileLayer(M.tiles, { maxZoom: M.maxZoom || 21, maxNativeZoom: 19, attribution: M.attribution, crossOrigin: false }).addTo(map);
  let fails = 0;
  tiles.on('tileerror', () => { fails += 1; if (fails === 4 && info) info.innerHTML = '<b>The map needs the internet.</b> No connection right now: type in sizes or use a plan instead. Your measurements are all still here.'; });
  if (!navigator.onLine && info) info.innerHTML = '<b>You\'re offline.</b> The map needs the internet: type in sizes or use a plan instead.';
  let saveT = null;
  map.on('moveend', () => { clearTimeout(saveT); saveT = setTimeout(() => { const c = map.getCenter(); RE.api(cfg.urls.view, { lat: c.lat, lng: c.lng, zoom: map.getZoom() }).catch(() => {}); }, 800); });

  const saved = L.layerGroup().addTo(map); const live = L.layerGroup().addTo(map);
  const adapter = {
    source: 'map', key: 'latlngs',
    owns: (i) => i.source === 'map',
    geometry: (pts) => ({ latlngs: pts.map((p) => [Math.round(p[0] * 1e8) / 1e8, Math.round(p[1] * 1e8) / 1e8]) }),
    hint: (t) => { if (info && t) info.textContent = t; },
    setTool: (t) => { el.style.cursor = t === 'pan' ? '' : 'crosshair'; if (t === 'pan') map.dragging.enable(); },
    render(S) {
      live.clearLayers();
      if (!S.pts.length) return;
      const k = S.tool;
      if (k === 'markers') S.pts.forEach((p) => L.circleMarker(p, { radius: 7, color: '#fff', weight: 2, fillColor: S.color, fillOpacity: 1 }).addTo(live));
      else {
        const closed = (k === 'shape' || k === 'roof' || k === 'hole') && S.pts.length > 2;
        (closed ? L.polygon(S.pts, { color: S.color, weight: 3, dashArray: '6 5', fillOpacity: 0.15 }) : L.polyline(S.pts, { color: S.color, weight: 3, dashArray: '6 5' })).addTo(live);
        S.pts.forEach((p) => L.circleMarker(p, { radius: 5, color: S.color, weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(live));
      }
    },
    highlightEdges(it) {
      const ll = it.data.latlngs || []; live.clearLayers();
      ll.forEach((p, n) => { const q = ll[(n + 1) % ll.length]; L.polyline([p, q], { color: '#facc15', weight: 6 }).addTo(live)
        .bindTooltip('Edge ' + (n + 1), { permanent: true, direction: 'center', className: 'edge-tip' }); });
    },
  };
  function drawSaved(items) {
    saved.clearLayers();
    items.filter(adapter.owns).forEach((it) => {
      const d = it.data; const ll = d.latlngs || []; const tip = esc(it.label) + '<br>' + it.shown.map((s) => esc(s[1])).slice(0, 2).join('<br>');
      let layer;
      if (it.kind === 'markers') { ll.forEach((p) => L.circleMarker(p, { radius: 7, color: '#fff', weight: 2, fillColor: it.color, fillOpacity: 1 }).addTo(saved)); return; }
      if (it.kind === 'shape' || it.kind === 'roof') layer = L.polygon([ll, ...(d.holes || [])], { color: it.color, weight: 3, fillOpacity: 0.25 });
      else layer = L.polyline(ll, { color: it.color, weight: 4 });
      layer.bindTooltip(tip, { sticky: true }).addTo(saved);
      if (it.kind === 'roof') layer.on('click', () => { if (sketch.tool === 'pan') sketch.editEdges(it.id); });
    });
  }
  const sketch = RE.Sketch(adapter);
  RE.onItems((items) => { drawSaved(items); sketch.render(); });
  map.on('click', (e) => { if (sketch.tool !== 'pan') sketch.add([e.latlng.lat, e.latlng.lng]); });
  map.on('dblclick', (e) => { if (sketch.tool !== 'pan' && sketch.tool !== 'markers') { sketch.finish(); L.DomEvent.stop(e); } });
  sketch.setTool('pan');
  // the first time: fit to what's already drawn, else find the job address
  RE.onItems(function once(items) {
    RE.listeners.splice(RE.listeners.indexOf(once), 1);
    const pts = items.filter(adapter.owns).flatMap((i) => i.data.latlngs || []);
    if (pts.length) map.fitBounds(pts, { maxZoom: 20, padding: [30, 30] });
    else if (!M.view && document.getElementById('addr').value) find(document.getElementById('addr').value);
  });

  // ---------- address search (the provider's geocoder; nothing is stored) ----------
  async function find(q) {
    if (!q.trim()) return;
    try {
      // forStorage=false: the result only moves the map; nothing from the geocoder is kept
      const u = M.geocode + (M.geocode.includes('?') ? '&' : '?') + 'f=json&maxLocations=1&forStorage=false&outFields=Match_addr&SingleLine=' + encodeURIComponent(q) + (M.key ? '&token=' + encodeURIComponent(M.key) : '');
      const r = await fetch(u); const j = await r.json(); const c = (j.candidates || [])[0];
      if (!c) { RE.toast('That address wasn\'t found. Try the street and town.', true); return; }
      map.setView([c.location.y, c.location.x], 19);
    } catch { RE.toast('Address search needs the internet.', true); }
  }
  document.getElementById('search').addEventListener('submit', (e) => { e.preventDefault(); find(document.getElementById('addr').value); });
  RE.map = { map, find, sketch };
})();
