// Riyeser Link Office 1.2.1: adding and managing many desk phones at once. Plain functions with no window, Electron or
// network, so the same file runs in Riyeser Link Office's main process, in its window, and on the website's Phones page
// (website/team/link-bulk.js must stay a byte-for-byte copy; a test checks).
//   MAC addresses   any format (001565aabbcc, 00:15:65:AA:BB:CC, 00-15-65-…, 0015.65aa.bbcc) -> 12 lower-case hex digits
//   Makers          from the label or CSV column when given, else from the MAC's first 6 digits (the maker's OUI prefix)
//   Lists and CSV   one MAC per line, or a CSV (MAC, model or maker, extension, person, phone name, location) -> rows
//   Preview         each row: valid or not, a duplicate, the maker, the extension it would get, who it's for
//   Phone settings  what each maker's settings file can carry (only those controls are shown)
(function (root) {
  const VENDORS = { yealink: 'Yealink', grandstream: 'Grandstream', snom: 'Snom', polycom: 'Polycom' };
  // Makers Riyeser Link Office recognises but can't set up by itself (they work when typed in by hand).
  const OTHER = { cisco: 'Cisco', fanvil: 'Fanvil', htek: 'Htek', gigaset: 'Gigaset', panasonic: 'Panasonic', avaya: 'Avaya', alcatel: 'Alcatel-Lucent', mitel: 'Mitel', ubiquiti: 'Ubiquiti' };
  const OUI = {
    yealink: ['001565', '249ad8', '805ec0', '805e0c', '44dbd2', '001fc1'],
    grandstream: ['000b82', 'c074ad', 'ec74d7'],
    snom: ['000413'],
    polycom: ['0004f2', '64167f', '482567', '00e0db'],
    cisco: ['00070e', '001b54', '0021a0', '00e0f7', '001ee7', '0024c4', 'f8a5c5', '6c416a'],
    fanvil: ['0c383e'],
    htek: [],
    gigaset: ['7c2f80'],
    panasonic: ['0080f0', '080023'],
    avaya: ['00040d', '001b4f', '2cf4c5'],
    alcatel: ['00809f', '0080f4'],
    mitel: ['08000f'],
    ubiquiti: ['24a43c', '788a20', 'f09fc2', 'b4fbe4'],
  };
  const NAMES = { ...VENDORS, ...OTHER };
  const MIN_EXT = 100; const MAX_EXT = 899;
  const EMERGENCY = new Set(['000', '111', '112', '911', '910', '917', '999']);
  const validExt = (n) => /^\d{3}$/.test(String(n)) && Number(n) >= MIN_EXT && Number(n) <= MAX_EXT;
  const freeExt = (n, used) => validExt(n) && Number(n) % 100 !== 0 && !used.has(String(n)) && !EMERGENCY.has(String(n));

  /** "00:15:65:AA:BB:CC" (any separators, any case) -> "001565aabbcc", or null. */
  function normaliseMac(s) { const m = String(s == null ? '' : s).trim().replace(/[\s:.\-_]/g, '').toLowerCase(); return /^[0-9a-f]{12}$/.test(m) ? m : null; }
  const prettyMac = (m) => (m ? String(m).match(/../g).join(':').toUpperCase() : '');
  /** The maker from a MAC's first 6 digits: 'yealink' … or '' when not known. */
  function ouiVendor(mac) { const o = String(normaliseMac(mac) || '').slice(0, 6); if (!o) return ''; for (const [k, list] of Object.entries(OUI)) if (list.includes(o)) return k; return ''; }
  /** The maker from words ("Yealink T31P", "Poly VVX 250", "GRP2601P"). */
  function vendorFromText(t) {
    const v = String(t || '').toLowerCase();
    if (!v) return '';
    for (const k of Object.keys(NAMES)) if (v.includes(k)) return k;
    if (/\bpoly\b|vvx|ccx|edge e/.test(v)) return 'polycom';
    if (/^\s*(t\d\d|sip-t|w\d\dp|cp9\d\d)/.test(v)) return 'yealink';
    if (/^\s*(grp|gxp|gxv|ht8|wp8)/.test(v)) return 'grandstream';
    if (/^\s*d\d{3}\b|\bm\d{2,3}\b/.test(v)) return 'snom';
    if (/^\s*(spa|cp-)\d/.test(v)) return 'cisco';
    return '';
  }
  const vendorName = (k) => NAMES[k] || '';
  const supported = (k) => Object.prototype.hasOwnProperty.call(VENDORS, k);

  // ---------- CSV ----------
  /** Split CSV text into rows of cells: commas, semicolons or tabs (whichever the first line uses), "quoted, cells". */
  function parseCsv(text) {
    const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const first = src.split('\n').find((l) => l.trim()) || '';
    const delim = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
      if (c === '"' && !cell.trim()) { q = true; cell = ''; } else if (c === delim) { row.push(cell.trim()); cell = ''; } else if (c === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; } else cell += c;
    }
    row.push(cell.trim()); rows.push(row);
    return rows.filter((r) => r.some((x) => x !== ''));
  }
  const HEAD = {
    mac: /^(mac|mac ?address|hardware|ethernet)/i, model: /^(model|maker|make|vendor|brand|type)/i, ext: /^(ext|extension|number)/i,
    person: /^(person|user|owner|email|e-mail|staff|for|who)/i, name: /^(phone ?name|label|name|desk)/i, location: /^(location|branch|site|room|place|office)/i,
  };
  const TEMPLATE_HEAD = ['MAC address', 'Model or maker', 'Extension', 'Person (name or email)', 'Phone name', 'Location'];
  /** The CSV template to download (a header and two examples). */
  const csvTemplate = () => `${TEMPLATE_HEAD.join(',')}\r\n00:15:65:12:34:56,Yealink T31P,101,Alex Sample,Front desk,Head office\r\n000B82123457,Grandstream GRP2601P,,,Meeting room,Head office\r\n`;

  /**
   * What was pasted or imported -> { rows: [{ line, macText, model, ext, person, name, location }], csv }. A plain list
   * (one MAC per line, extra words after it ignored) or a CSV, with or without its header row.
   */
  function parseInput(text) {
    const src = String(text || '');
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const looksCsv = lines.some((l) => /[,;\t]/.test(l));
    if (!looksCsv) {
      const rows = [];
      lines.forEach((l, i) => { const t = l.trim(); if (!t || /^#/.test(t)) return; const [macText, ...rest] = t.split(/\s+/); rows.push({ line: i + 1, macText, model: rest.join(' '), ext: '', person: '', name: '', location: '' }); });
      return { rows, csv: false };
    }
    const cells = parseCsv(src);
    let map = { mac: 0, model: 1, ext: 2, person: 3, name: 4, location: 5 }; let start = 0;
    const h = cells[0] || [];
    if (h.length && !normaliseMac(h[0]) && h.some((x) => HEAD.mac.test(x))) {
      map = {}; start = 1;
      h.forEach((x, i) => { for (const [k, re] of Object.entries(HEAD)) if (map[k] == null && re.test(x)) { map[k] = i; break; } });
      if (map.name == null && map.location == null) { const i = h.findIndex((x) => /name/i.test(x) && !HEAD.person.test(x)); if (i >= 0) map.name = i; }
    }
    const at = (r, k) => (map[k] == null ? '' : String(r[map[k]] == null ? '' : r[map[k]]).trim());
    return { rows: cells.slice(start).map((r, i) => ({ line: i + 1 + start, macText: at(r, 'mac'), model: at(r, 'model'), ext: at(r, 'ext'), person: at(r, 'person'), name: at(r, 'name'), location: at(r, 'location') })), csv: true };
  }

  // ---------- extensions ----------
  /** n free extensions from `start` up, skipping used ones, the x00 group numbers and emergency numbers. */
  function nextFree(start, used, n = 1) {
    const u = new Set([...(used || [])].map(String)); const out = [];
    for (let e = Math.max(MIN_EXT, Number(start) || 101); e <= MAX_EXT && out.length < n; e++) if (freeExt(String(e), u)) { out.push(String(e)); u.add(String(e)); }
    return out;
  }
  /** The person a typed name, email or extension means. people: [{ ext, name, email? }] */
  function matchPerson(text, people) {
    const t = String(text || '').trim().toLowerCase(); if (!t) return null;
    const list = people || [];
    return list.find((p) => String(p.ext) === t) || list.find((p) => p.email && String(p.email).toLowerCase() === t)
      || list.find((p) => String(p.name || '').toLowerCase() === t)
      || (() => { const m = list.filter((p) => String(p.name || '').toLowerCase().split(/\s+/)[0] === t); return m.length === 1 ? m[0] : null; })();
  }

  /**
   * Check every row before anything is added.
   * ctx: { phones: [{ mac, ext }] (given to someone), found: [{ mac, ignored }] (new phones), people: [{ ext, name, email }],
   *        used: [ext] (people and ring groups), start: '201' (first number for new extensions), auto: true (number phones
   *        with no person or extension), shared: true (a phone with no person gets its own extension, named after it) }
   * -> { rows: [{ ...row, mac, vendor, vendorName, supported, dup, already, ext, person, newExt, extName, state: 'ok'|'warn'|'error'|'skip', notes: [] }],
   *      counts: { add, skip, error, warn } }
   */
  function preview(input, ctx = {}) {
    const people = ctx.people || []; const phones = ctx.phones || []; const found = ctx.found || [];
    const used = new Set([...(ctx.used || []), ...people.map((p) => String(p.ext))].map(String));
    const seen = new Map(); const taken = new Set();
    let next = Number(ctx.start) || 101;
    const rows = (input || []).map((r) => {
      const notes = []; let state = 'ok'; let nErr = 0;
      const bad = (t) => { notes.splice(nErr++, 0, t); state = 'error'; };   // what to fix comes first
      const warn = (t) => { notes.push(t); if (state === 'ok') state = 'warn'; };
      const mac = normaliseMac(r.macText);
      const out = { ...r, mac, vendor: '', vendorName: '', supported: false, dup: false, already: null, ext: '', person: null, newExt: false, extName: '', state, notes };
      if (!mac) { bad(r.macText ? `${r.macText} isn't a MAC address (12 letters and numbers)` : 'No MAC address'); out.state = state; return out; }
      if (seen.has(mac)) { out.dup = true; out.state = 'skip'; notes.push(`Twice in this list (line ${seen.get(mac)})`); return out; }
      seen.set(mac, r.line);
      const given = phones.find((p) => p.mac === mac);
      if (given) { out.already = given; out.state = 'skip'; notes.push(`Already added${given.ext ? ` (extension ${given.ext})` : ''}`); return out; }
      if (found.some((f) => f.mac === mac && !f.ignored)) notes.push('Already found on the network');
      out.vendor = vendorFromText(r.model) || ouiVendor(mac);
      out.vendorName = vendorName(out.vendor);
      out.supported = supported(out.vendor);
      if (!out.vendor) warn('Maker not known: choose it, or the phone is set up by hand');
      else if (!out.supported) warn(`${out.vendorName} phones are set up by hand (Riyeser Link Office sets up Yealink, Grandstream, Snom and Polycom)`);
      const typedExt = String(r.ext || '').trim();
      const person = matchPerson(r.person, people);
      if (r.person && !person && !typedExt) warn(`No one called "${r.person}": ${ctx.auto ? 'a new extension is made for them' : 'choose who it is for'}`);
      if (typedExt && person && String(person.ext) !== typedExt) { warn(`${person.name} is extension ${person.ext}: the phone goes to ${person.ext} (${typedExt} is ignored)`); out.ext = String(person.ext); out.person = person; }
      else if (typedExt) {
        if (!validExt(typedExt)) bad(`Extension ${typedExt} isn't 3 digits from ${MIN_EXT} to ${MAX_EXT}`);
        else if (EMERGENCY.has(typedExt)) bad(`${typedExt} is an emergency number`);
        else {
          const owner = people.find((p) => String(p.ext) === typedExt);
          if (owner) { out.ext = typedExt; out.person = owner; }
          else if (used.has(typedExt) && !taken.has(typedExt)) bad(`${typedExt} is a ring group number`);
          else { out.ext = typedExt; out.newExt = true; out.extName = r.person || r.name || r.location || `Phone ${typedExt}`; if (taken.has(typedExt)) notes.push(`Shares the new extension ${typedExt} with another phone in this list`); }
        }
      } else if (person) { out.ext = String(person.ext); out.person = person; }
      else if (ctx.auto || ctx.shared) {
        const [e] = nextFree(next, new Set([...used, ...taken])); if (!e) bad('No free extensions left');
        else { out.ext = e; out.newExt = true; out.extName = r.person || r.name || r.location || `Phone ${e}`; next = Number(e) + 1; }
      } else notes.push('Not given to anyone yet: it waits under New phones');
      if (out.newExt && out.ext) taken.add(out.ext);
      out.state = state;
      return out;
    });
    const counts = { add: rows.filter((x) => x.state === 'ok' || x.state === 'warn').length, skip: rows.filter((x) => x.state === 'skip').length,
      error: rows.filter((x) => x.state === 'error').length, warn: rows.filter((x) => x.state === 'warn').length };
    return { rows, counts };
  }

  /** "Added 12 phones, 2 skipped: duplicates." from { added, skipped: [{ why }], failed: [{ why }] } */
  function summary(r) {
    const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
    const parts = [];
    const verb = r.verb || 'Added';
    parts.push(`${verb} ${n(r.done != null ? r.done : r.added || 0, 'phone')}`);
    const why = (list) => [...new Set(list.map((x) => x.why || x.reason || 'not changed'))].join(', ');
    if ((r.skipped || []).length) parts.push(`${r.skipped.length} skipped: ${why(r.skipped)}`);
    if ((r.failed || []).length) parts.push(`${r.failed.length} didn't work: ${why(r.failed)}`);
    return `${parts.join(', ')}.`;
  }

  // ---------- each phone's own settings: only what its maker's settings file can carry ----------
  const LANGS = [['English', 'English'], ['French', 'Français'], ['Spanish', 'Español'], ['German', 'Deutsch'], ['Portuguese', 'Português'], ['Chinese', '中文']];
  const CAPS = {
    yealink: { label: true, displayName: true, timezone: true, timeFormat: true, language: true, ringtone: 8, ringVolume: true, lineKeys: 10, dnd: true },
    grandstream: { label: true, displayName: true, timeFormat: true, language: true },
    snom: { displayName: true, timezone: true, timeFormat: true, language: true, ringtone: 10, ringVolume: true, lineKeys: 12, dnd: true },
    polycom: { label: true, displayName: true, timezone: true, timeFormat: true, language: true, ringtone: 10, lineKeys: 6 },
  };
  const caps = (vendor) => CAPS[vendor] || {};
  /** Keep only settings this maker supports, each checked. -> { settings, dropped: [names] } */
  function cleanSettings(vendor, s) {
    const c = caps(vendor); const out = {}; const dropped = []; const src = s || {};
    const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>"&=]/g, '').trim().slice(0, n);
    for (const [k, v] of Object.entries(src)) {
      if (v === '' || v == null) continue;
      if (!c[k]) { dropped.push(k); continue; }
      if (k === 'label' || k === 'displayName') { const t = text(v, k === 'label' ? 20 : 40); if (t) out[k] = t; }
      else if (k === 'timezone') { if (/^[+-](\d|1[0-4])(:(00|30|45))?$/.test(String(v))) out[k] = String(v); else dropped.push(k); }
      else if (k === 'timeFormat') { if (v === '12' || v === '24') out[k] = v; else dropped.push(k); }
      else if (k === 'language') { if (LANGS.some(([x]) => x === v)) out[k] = v; else dropped.push(k); }
      else if (k === 'ringtone') { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= c.ringtone) out[k] = n; else dropped.push(k); }
      else if (k === 'ringVolume') { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= 15) out[k] = n; else dropped.push(k); }
      else if (k === 'dnd') { if (v === 'person' || v === 'off') out[k] = v; else dropped.push(k); }
      else if (k === 'lineKeys') {
        const keys = (Array.isArray(v) ? v : []).slice(0, c.lineKeys).map((x) => ({ type: 'speed', value: String((x && x.value) || '').replace(/[^0-9*#]/g, '').slice(0, 8), label: text(x && x.label, 20) }))
          .filter((x) => x.value);
        if (keys.length) out[k] = keys;
      }
    }
    return { settings: out, dropped };
  }

  const api = { VENDORS, OTHER, NAMES, OUI, LANGS, CAPS, TEMPLATE_HEAD, normaliseMac, prettyMac, ouiVendor, vendorFromText, vendorName, supported, parseCsv, parseInput, csvTemplate,
    nextFree, matchPerson, preview, summary, caps, cleanSettings, validExt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LinkBulk = api;
}(this));
