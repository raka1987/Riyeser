/* Riyeser Estimate units: the same rules as riyeser/measure/units.py (keep them in step). Everything is kept in SI. */
(function (root) {
  'use strict';
  const FT = 0.3048, IN = 0.0254, YD = 0.9144;
  const UNITS = {
    m: ['length', 1, 'm'], mm: ['length', 0.001, 'mm'], cm: ['length', 0.01, 'cm'], ft: ['length', FT, 'ft'],
    in: ['length', IN, 'in'], yd: ['length', YD, 'yd'], m2: ['area', 1, 'm²'], ft2: ['area', FT * FT, 'sq ft'],
    square: ['area', 100 * FT * FT, 'squares'], m3: ['volume', 1, 'm³'], yd3: ['volume', YD * YD * YD, 'cu yd'],
    ft3: ['volume', FT * FT * FT, 'cu ft'], each: ['count', 1, 'each'], hour: ['hours', 1, 'hrs'],
  };
  const DISPLAY = { metric: { length: 'm', area: 'm2', volume: 'm3' }, imperial: { length: 'ft', area: 'ft2', volume: 'yd3' } };
  const num = (s) => {
    s = String(s).trim();
    if ((s.match(/,/g) || []).length === 1 && s.indexOf('.') < 0 && s.split(',')[1].length !== 3) s = s.replace(',', '.');
    const v = Number(s.replace(/,/g, ''));
    if (!isFinite(v)) throw new Error('"' + s + '" isn\'t a number.');
    return v;
  };
  const NUM = '[-+]?(?:\\d+(?:[.,]\\d*)?|[.,]\\d+)';
  /** What someone typed -> metres (null when empty). Plain numbers are in the takeoff's units. */
  function parseLength(text, sys) {
    if (text == null) return null;
    let s = String(text).trim().replace(/′|’/g, "'").replace(/″|”/g, '"');
    if (!s) return null;
    s = s.replace(/(\d+)\s+(\d+)\/(\d+)/g, (_, a, b, c) => String(+a + b / c));
    let m = s.match(new RegExp('^\\s*(' + NUM + ')\\s*(mm|cm|m|ft|in|yd)?\\s*$', 'i'));
    if (m) { const u = (m[2] || '').toLowerCase() || (sys === 'imperial' ? 'ft' : 'm'); return num(m[1]) * UNITS[u][1]; }
    m = s.match(new RegExp("^\\s*(" + NUM + ")\\s*'\\s*(" + NUM + ')\\s*$'));
    if (m) return num(m[1]) * FT + num(m[2]) * IN;
    m = s.match(new RegExp("^\\s*(?:(" + NUM + ")\\s*(?:'|ft|feet|foot))?\\s*(?:(" + NUM + ')\\s*(?:"|\'\'|in|inch|inches))?\\s*$', 'i'));
    if (m && (m[1] || m[2])) return (m[1] ? num(m[1]) : 0) * FT + (m[2] ? num(m[2]) : 0) * IN;
    throw new Error('"' + text + '" isn\'t a length. Type a number, like 3.6 or 12\' 6".');
  }
  const fromSI = (v, u) => v / UNITS[u][1];
  const toSI = (v, u) => v * UNITS[u][1];
  function fmt(v, dim, sys, places = 2) {
    const u = (DISPLAY[sys] || DISPLAY.metric)[dim];
    const x = u ? fromSI(v, u) : v;
    const s = x.toLocaleString(undefined, { maximumFractionDigits: places, minimumFractionDigits: 0 });
    return s + ' ' + (u ? UNITS[u][2] : dim === 'count' ? '' : dim === 'hours' ? 'hrs' : '');
  }
  const lenUnit = (sys) => (sys === 'imperial' ? 'ft' : 'm');
  const api = { FT, IN, UNITS, parseLength, fromSI, toSI, fmt, lenUnit, num };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RU = api;
})(this);
