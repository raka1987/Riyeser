// Riyeser PDF: the parts of saving and opening that don't need the window, so the tests can run them too.
// The PDF library (pdf-lib, the @cantoo build with password support) is passed in as `L`; editor.js passes window.PDFLib.
//
//   S42  removeTextInBoxes: words replaced with "Edit text" are taken out of the page itself, not just covered up.
//   S46  pickFont / textFont: added text and form fields in any language (Vietnamese, Fijian, Hindi, Chinese...).
//   S47  pageHasText: "Recognise text" checks every page's own text first, shown on screen or not.
//   M16  openErrorMessage: plain words for a damaged or incomplete file.

// ---------- M16 ----------
export const DAMAGED = 'This file looks damaged or incomplete. Try downloading it again.';
/** What to tell people when a PDF won't open. 'password' when it needs (or got the wrong) password. */
export function openErrorMessage(e) {
  const name = String((e && e.name) || ''); const msg = String((e && e.message) || e || '');
  if (name === 'PasswordException' || /password/i.test(msg)) return 'password';
  if (/InvalidPDF|MissingPDF|UnexpectedResponse|FormatError/i.test(name) || /invalid pdf|pdf header|xref|trailer|unexpected end|no pdf|bad (?:xref|trailer)|corrupt|damaged|failed to parse/i.test(msg)) return DAMAGED;
  return null;
}

// ---------- S47 ----------
/** Does this page (a pdf.js page) already have its own text? Only pages without any get recognised. */
export async function pageHasText(page) {
  const tc = await page.getTextContent();
  return tc.items.some((it) => it.str && it.str.trim());
}

// ---------- S46 ----------
const WINANSI_EXTRA = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);
/** Can the standard PDF fonts (WinAnsi) write this text? */
export function winAnsiOk(text) {
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    if (c === 10 || c === 13 || c === 9) continue;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}
/** The first font (a fontkit font) that has every letter of the text. candidates: [{ key, font }]. */
export function pickFont(text, candidates) {
  const need = [...String(text || '')].map((ch) => ch.codePointAt(0)).filter((c) => c > 0x20 && c !== 0xa0 && !(c >= 0x200b && c <= 0x200d));
  return candidates.find((c) => c.font && need.every((cp) => c.font.hasGlyphForCodePoint(cp))) || null;
}
/** Which kind of font the text needs, so only that one is loaded: 'cjk', 'devanagari' or 'latin'. */
export function scriptOf(text) {
  const s = String(text || '');
  if (/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(s)) return 'cjk';
  if (/[ऀ-ॿ]/.test(s)) return 'devanagari';
  return 'latin';
}
/**
 * fontkit for pdf-lib, which also opens font collections (.ttc, e.g. Windows' Microsoft YaHei) by taking their first font.
 */
export function collectionFontkit(fontkit) {
  return { ...fontkit, create: (data, name) => { const f = fontkit.create(data, name); return f && Array.isArray(f.fonts) ? f.fonts[0] : f; } };
}

// ---------- S42: take replaced words out of the page ----------
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

function lex(s) {
  const out = []; let i = 0; const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }   // % comment
    const start = i;
    if (c === 40) {   // ( literal string )
      let depth = 1; i++; const bytes = [];
      while (i < n && depth) {
        const ch = s[i];
        if (ch === '\\') {
          const nx = s[i + 1];
          const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
          if (nx in map) { bytes.push(map[nx]); i += 2; } else if (/[0-7]/.test(nx)) { let o = ''; i++; while (o.length < 3 && /[0-7]/.test(s[i])) o += s[i++]; bytes.push(parseInt(o, 8) & 255); } else if (nx === '\r') { i += s[i + 2] === '\n' ? 3 : 2; } else if (nx === '\n') { i += 2; } else { i++; }
          continue;
        }
        if (ch === '(') depth++;
        if (ch === ')') { depth--; if (!depth) { i++; break; } }
        bytes.push(s.charCodeAt(i) & 255); i++;
      }
      out.push({ t: 'str', v: bytes, start, end: i }); continue;
    }
    if (c === 60 && s[i + 1] === '<') { out.push({ t: '<<', start, end: i + 2 }); i += 2; continue; }
    if (c === 62 && s[i + 1] === '>') { out.push({ t: '>>', start, end: i + 2 }); i += 2; continue; }
    if (c === 60) {   // <hex>
      i++; let h = '';
      while (i < n && s[i] !== '>') { if (/[0-9a-fA-F]/.test(s[i])) h += s[i]; i++; }
      i++; if (h.length % 2) h += '0';
      const bytes = []; for (let k = 0; k < h.length; k += 2) bytes.push(parseInt(h.slice(k, k + 2), 16));
      out.push({ t: 'str', v: bytes, start, end: i }); continue;
    }
    if (c === 91) { out.push({ t: '[', start, end: i + 1 }); i++; continue; }
    if (c === 93) { out.push({ t: ']', start, end: i + 1 }); i++; continue; }
    if (c === 123 || c === 125) { i++; continue; }
    if (c === 47) {   // /Name
      i++; while (i < n && !WS.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++;
      out.push({ t: 'name', v: s.slice(start + 1, i), start, end: i }); continue;
    }
    while (i < n && !WS.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++;
    if (i === start) { i++; continue; }
    const word = s.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { out.push({ t: 'num', v: parseFloat(word), start, end: i }); continue; }
    out.push({ t: 'op', v: word, start, end: i });
    if (word === 'ID') {   // inline image data: skip to EI
      let j = i + 1;
      const m = /[\s\0]EI(?=[\s\0]|$)/g; m.lastIndex = j;
      const hit = m.exec(s);
      j = hit ? hit.index + hit[0].length : n;
      out.push({ t: 'op', v: 'EI', start: i, end: j }); i = j;
    }
  }
  return out;
}
/** Operations: { op, args, start, end }. Arrays become JS arrays; dictionaries are kept as a marker. */
function parse(s) {
  const toks = lex(s); const ops = []; let args = []; let argStart = null; const stack = [];
  for (const tk of toks) {
    if (argStart == null) argStart = tk.start;
    if (tk.t === '[') { stack.push([]); continue; }
    if (tk.t === ']') { const a = stack.pop() || []; (stack.length ? stack[stack.length - 1] : args).push(a); continue; }
    if (tk.t === '<<') { stack.push({ dict: true, items: [] }); continue; }
    if (tk.t === '>>') { const d = stack.pop(); (stack.length ? (Array.isArray(stack[stack.length - 1]) ? stack[stack.length - 1] : stack[stack.length - 1].items) : args).push(d || {}); continue; }
    if (stack.length) { const top = stack[stack.length - 1]; (Array.isArray(top) ? top : top.items).push(tk.t === 'str' ? { str: tk.v } : tk.v); continue; }
    if (tk.t === 'op') { ops.push({ op: tk.v, args, start: argStart, end: tk.end }); args = []; argStart = null; continue; }
    args.push(tk.t === 'str' ? { str: tk.v } : tk.v);
  }
  return ops;
}

const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const apply = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const fmt = (v) => (Math.abs(v) < 1e-6 ? '0' : String(Math.round(v * 1000) / 1000));
const hex = (bytes) => `<${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}>`;

/** Glyph widths for one font resource: { bytes: 1|2, width(code) in 1/1000 em }. */
function fontMetrics(L, doc, fontDict, stdCache) {
  const { PDFName, PDFArray, PDFNumber, PDFDict } = L;
  const get = (d, k) => (d && d.lookup ? d.lookup(PDFName.of(k)) : undefined);
  const num = (v) => (v instanceof PDFNumber ? v.asNumber() : typeof v === 'number' ? v : null);
  const arr = (v) => (v instanceof PDFArray ? v.asArray().map((x) => doc.context.lookup(x) || x) : []);
  const sub = String(get(fontDict, 'Subtype') || '');
  if (sub === '/Type0') {
    const desc = arr(get(fontDict, 'DescendantFonts'))[0];
    const dw = num(get(desc, 'DW')) ?? 1000;
    const W = new Map();
    const w = arr(get(desc, 'W'));
    for (let k = 0; k < w.length;) {
      const first = num(w[k]); const nx = w[k + 1];
      if (nx instanceof PDFArray) { arr(nx).forEach((x, j) => W.set(first + j, num(x))); k += 2; }
      else { const last = num(nx); const val = num(w[k + 2]); for (let c = first; c <= last && c - first < 65536; c++) W.set(c, val); k += 3; }
    }
    return { bytes: 2, width: (c) => (W.has(c) ? W.get(c) : dw), known: true };
  }
  const first = num(get(fontDict, 'FirstChar')) ?? 0;
  const widths = arr(get(fontDict, 'Widths')).map(num);
  const fd = get(fontDict, 'FontDescriptor');
  const missing = num(fd instanceof PDFDict ? get(fd, 'MissingWidth') : null) ?? 0;
  const fm = arr(get(fontDict, 'FontMatrix')).map(num);
  const scale = sub === '/Type3' && fm.length ? fm[0] * 1000 : 1;
  if (widths.length) return { bytes: 1, width: (c) => ((widths[c - first] ?? missing) * scale), known: true };
  // one of the 14 standard fonts, with no widths in the file: the standard font's own widths
  const base = String(get(fontDict, 'BaseFont') || '').replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
  const std = Object.values(L.StandardFonts || {}).find((x) => x === base) || (/arial|helvetica/i.test(base) ? 'Helvetica' : /times/i.test(base) ? 'Times-Roman' : /courier/i.test(base) ? 'Courier' : null);
  if (std && L.StandardFontEmbedder) {
    const e = stdCache[std] || (stdCache[std] = L.StandardFontEmbedder.for(std));
    return { bytes: 1, width: (c) => { try { return e.widthOfTextAtSize(String.fromCharCode(c), 1000); } catch { return 500; } }, known: true };
  }
  return { bytes: 1, width: () => 500, known: false };
}

/**
 * Take the words that sit inside the given boxes out of a page's own content (the text a PDF reader copies and
 * searches), keeping everything else where it was. boxes: [{ x0, y0, x1, y1 }] in PDF points.
 * -> { removed: number of letters taken out, guessed: true when a font's widths had to be guessed }
 */
export function removeTextInBoxes(L, doc, pageIndex, boxes) {
  const { PDFName, PDFArray, PDFStream, PDFDict, decodePDFRawStream, PDFRawStream } = L;
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  if (!contents || !boxes.length) return { removed: 0, guessed: false };
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  const decode = (st) => {
    if (st instanceof PDFRawStream) return decodePDFRawStream(st).decode();
    if (st && typeof st.getContents === 'function') return st.getContents();
    return new Uint8Array(0);
  };
  let src = '';
  for (const st of streams) { if (!(st instanceof PDFStream)) continue; const b = decode(st); let t = ''; for (let k = 0; k < b.length; k += 8192) t += String.fromCharCode.apply(null, b.subarray(k, k + 8192)); src += `${t}\n`; }
  const res = page.node.Resources();
  const fonts = res && res.lookup(PDFName.of('Font'), PDFDict);
  const metricsCache = {}; const stdCache = {};
  const metrics = (name) => {
    if (metricsCache[name]) return metricsCache[name];
    const fd = fonts && fonts.lookup(PDFName.of(name));
    return (metricsCache[name] = fd ? fontMetrics(L, doc, fd, stdCache) : { bytes: 1, width: () => 500, known: false });
  };
  const inBox = (x, y) => boxes.some((b) => x >= Math.min(b.x0, b.x1) && x <= Math.max(b.x0, b.x1) && y >= Math.min(b.y0, b.y1) && y <= Math.max(b.y0, b.y1));

  const ops = parse(src);
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
  let tm = [1, 0, 0, 1, 0, 0]; let tlm = [1, 0, 0, 1, 0, 0];
  const ts = { Tc: 0, Tw: 0, Th: 1, TL: 0, Tfs: 0, rise: 0, font: null };
  let removed = 0; let guessed = false;
  const edits = [];   // { start, end, text }
  const nextLine = () => { tlm = mul([1, 0, 0, 1, 0, -ts.TL], tlm); tm = tlm.slice(); };
  const show = (items, o, prefix) => {
    const m = metrics(ts.font || '');
    const outItems = []; let changed = false; let pendingAdj = 0; let keptBytes = [];
    const flush = () => { if (keptBytes.length) { if (pendingAdj) { outItems.push(pendingAdj); pendingAdj = 0; } outItems.push(keptBytes); keptBytes = []; } };
    for (const it of items) {
      if (typeof it === 'number') { flush(); pendingAdj += it; tm = mul([1, 0, 0, 1, (-it / 1000) * ts.Tfs * ts.Th, 0], tm); continue; }
      if (!it || !it.str) continue;
      const b = it.str;
      for (let k = 0; k + m.bytes - 1 < b.length; k += m.bytes) {
        const code = m.bytes === 2 ? (b[k] << 8) | b[k + 1] : b[k];
        const w = (m.width(code) || 0) / 1000;
        const tx = (w * ts.Tfs + ts.Tc + (m.bytes === 1 && code === 32 ? ts.Tw : 0)) * ts.Th;
        const [x, y] = apply(mul(tm, ctm), tx / 2, ts.rise + 0.3 * ts.Tfs);
        if (inBox(x, y) && ts.Tfs * ts.Th) {
          flush(); changed = true; removed++; if (!m.known) guessed = true;
          pendingAdj += (-tx * 1000) / (ts.Tfs * ts.Th);
        } else { keptBytes.push(...b.slice(k, k + m.bytes)); }
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    }
    flush(); if (pendingAdj) outItems.push(pendingAdj);
    if (changed) {
      const arrText = outItems.map((x) => (typeof x === 'number' ? fmt(x) : hex(x))).join(' ');
      edits.push({ start: o.start, end: o.end, text: `${prefix}[${arrText}] TJ` });
    }
  };
  for (const o of ops) {
    const a = o.args;
    switch (o.op) {
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
      case 'cm': if (a.length >= 6) ctm = mul(a.slice(0, 6), ctm); break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': ts.font = typeof a[0] === 'string' ? a[0] : ts.font; ts.Tfs = typeof a[1] === 'number' ? a[1] : ts.Tfs; break;
      case 'Tc': ts.Tc = a[0] || 0; break;
      case 'Tw': ts.Tw = a[0] || 0; break;
      case 'Tz': ts.Th = (a[0] ?? 100) / 100; break;
      case 'TL': ts.TL = a[0] || 0; break;
      case 'Ts': ts.rise = a[0] || 0; break;
      case 'Td': tlm = mul([1, 0, 0, 1, a[0] || 0, a[1] || 0], tlm); tm = tlm.slice(); break;
      case 'TD': ts.TL = -(a[1] || 0); tlm = mul([1, 0, 0, 1, a[0] || 0, a[1] || 0], tlm); tm = tlm.slice(); break;
      case 'Tm': if (a.length >= 6) { tlm = a.slice(0, 6); tm = tlm.slice(); } break;
      case 'T*': nextLine(); break;
      case 'Tj': show([a[0]], o, ''); break;
      case 'TJ': show(Array.isArray(a[0]) ? a[0] : [], o, ''); break;
      case "'": nextLine(); show([a[0]], o, 'T* '); break;
      case '"': ts.Tw = a[0] || 0; ts.Tc = a[1] || 0; nextLine(); show([a[2]], o, `${fmt(a[0] || 0)} Tw ${fmt(a[1] || 0)} Tc T* `); break;
      default: break;
    }
  }
  if (!edits.length) return { removed: 0, guessed };
  let out = ''; let at = 0;
  for (const e of edits.sort((x, y) => x.start - y.start)) { out += src.slice(at, e.start) + e.text; at = e.end; }
  out += src.slice(at);
  const bytes = new Uint8Array(out.length); for (let k = 0; k < out.length; k++) bytes[k] = out.charCodeAt(k) & 255;
  const ref = doc.context.register(doc.context.flateStream(bytes));
  page.node.set(PDFName.of('Contents'), ref);
  return { removed, guessed };
}

/**
 * S46: a font for each piece of text: the chosen standard font when it can write it, else a font from the PC that has
 * every letter (loadFont(script) -> bytes or null). -> async fontFor(text, standardFontName) -> { font, missing }
 */
export function fontChooser(L, doc, fontkit, loadFont) {
  let registered = false;
  const loaded = {};   // script -> { bytes, fk, pdf } | null
  const std = {};
  const load = async (script) => {
    if (script in loaded) return loaded[script];
    let bytes = null; try { bytes = await loadFont(script); } catch { bytes = null; }
    if (!bytes) return (loaded[script] = null);
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let fk = null; try { fk = collectionFontkit(fontkit).create(u8); } catch { fk = null; }
    // only fonts with outlines (TrueType or CFF) can go into a PDF; bitmap-only fonts can't
    const tables = (fk && fk.directory && fk.directory.tables) || {};
    if (fk && !tables.glyf && !tables['CFF '] && !tables.CFF2) fk = null;
    return (loaded[script] = fk ? { bytes: u8, fk, pdf: null } : null);
  };
  return async function fontFor(text, standardName = L.StandardFonts.Helvetica) {
    if (winAnsiOk(text)) return { font: std[standardName] || (std[standardName] = await doc.embedFont(standardName)), missing: false };
    const first = scriptOf(text);
    for (const script of [first, ...['latin', 'devanagari', 'cjk'].filter((x) => x !== first)]) {
      const f = await load(script);
      if (!f || !pickFont(text, [{ key: script, font: f.fk }])) continue;
      if (!registered) { doc.registerFontkit(collectionFontkit(fontkit)); registered = true; }
      if (!f.pdf) {
        // only the letters used go into the file; a font that can't be cut down is put in whole
        // tried in a scratch PDF first: a font that fails only shows it when the file is written, which mustn't stop the save
        for (const subset of [true, false]) {
          try {
            const probe = await L.PDFDocument.create(); probe.registerFontkit(collectionFontkit(fontkit));
            const pf = await probe.embedFont(f.bytes, { subset }); probe.addPage().drawText(text, { font: pf, size: 10 }); await probe.save();
            f.pdf = await doc.embedFont(f.bytes, { subset }); break;
          } catch { f.pdf = null; }
        }
        if (!f.pdf) { loaded[script] = null; continue; }
      }
      return { font: f.pdf, missing: false };
    }
    return { font: std[standardName] || (std[standardName] = await doc.embedFont(standardName)), missing: true };
  };
}
/** Letters a standard font can't write become "?" (only when no font on the PC has them). */
export const safeText = (font, text) => [...String(text)].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');

/** Fill in form fields; text in any language gets a font that has its letters (S46). values: [{ name, kind, value }] */
export async function fillForm(L, doc, values, fontFor) {
  const form = doc.getForm();
  for (const f of values) {
    try {
      if (f.kind === 'text') {
        const fld = form.getTextField(f.name);
        fld.setText(f.value);
        if (f.value && !winAnsiOk(f.value)) { const { font } = await fontFor(f.value); fld.updateAppearances(font); }
      } else if (f.kind === 'check') { if (f.value) form.getCheckBox(f.name).check(); else form.getCheckBox(f.name).uncheck(); }
      else if (f.kind === 'radio') { if (f.value) form.getRadioGroup(f.name).select(f.value); }
      else if (f.kind === 'select') {
        const fld = form.getField(f.name); if (f.value) fld.select(f.value);
        if (f.value && !winAnsiOk(f.value) && fld.updateAppearances) { const { font } = await fontFor(f.value); fld.updateAppearances(font); }
      }
    } catch (e) { if (typeof console !== 'undefined') console.warn('form field', f.name, e); }
  }
  return form;
}

/**
 * Put the document's pages in this order (pages left out are dropped), as one flat page list. Done on the page tree
 * itself: this PDF library deletes a page's object when the page is removed, so it can't be added back.
 */
export function setPageOrder(L, doc, pages) {
  const { PDFName, PDFNumber } = L;
  const tree = doc.catalog.Pages();
  const treeRef = doc.catalog.get(PDFName.of('Pages'));
  for (const pg of pages) {   // what a page took from the page tree above it, it now keeps itself
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const k = PDFName.of(key);
      if (!pg.node.get(k)) { const v = pg.node.getInheritableAttribute(k); if (v) pg.node.set(k, v); }
    }
    pg.node.set(PDFName.of('Parent'), treeRef);
  }
  tree.set(PDFName.of('Kids'), doc.context.obj(pages.map((pg) => pg.ref)));
  tree.set(PDFName.of('Count'), PDFNumber.of(pages.length));
  if (doc.pageCache && doc.pageCache.invalidate) doc.pageCache.invalidate();
  if (doc.pageMap && doc.pageMap.clear) doc.pageMap.clear();
}
