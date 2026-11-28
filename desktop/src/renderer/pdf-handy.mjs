// Riyeser PDF 0.26.0: the everyday helpers behind the start screen, stamps, Fill my details, Batch, Split and Compare.
// No window, no Electron: the editor imports this, and the tests run it as it is (with the same PDF library, passed in as L).

// ---------------------------------------------------------------- dates on stamps
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');
/** The date formats a business can choose (Settings › Dates on stamps). 'system' is Windows' own setting. */
export const DATE_FORMATS = [['system', 'Windows setting'], ['dmy', 'Day/month/year'], ['mdy', 'Month/day/year'], ['ymd', 'Year-month-day'], ['dmmmy', 'Day month year']];
/** A stamp's date. fmt: 'dmy' 28/11/2026 | 'mdy' 11/28/2026 | 'ymd' 2026-11-28 | 'dmmmy' 28 Nov 2026 | 'system' (locale) */
export function formatStampDate(date = new Date(), fmt = 'system', locale = undefined) {
  const d = date instanceof Date ? date : new Date(date);
  const [y, m, day] = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  if (fmt === 'dmy') return `${pad2(day)}/${pad2(m)}/${y}`;
  if (fmt === 'mdy') return `${pad2(m)}/${pad2(day)}/${y}`;
  if (fmt === 'ymd') return `${y}-${pad2(m)}-${pad2(day)}`;
  if (fmt === 'dmmmy') return `${day} ${MONTHS[m - 1]} ${y}`;
  try { return d.toLocaleDateString(locale || undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return `${pad2(day)}/${pad2(m)}/${y}`; }
}

/** The ready-made stamps (custom ones are added in the Stamp menu and kept on this PC). */
export const STAMP_PRESETS = [
  { text: 'PAID', color: '#15803d' }, { text: 'RECEIVED', color: '#1d4ed8' }, { text: 'APPROVED', color: '#15803d' },
  { text: 'COPY', color: '#6b7280' }, { text: 'DRAFT', color: '#b91c1c' }, { text: 'CONFIDENTIAL', color: '#b91c1c' },
];

// ---------------------------------------------------------------- Fill my details
/** "txtEmailAddress_1" -> "txt email address 1" */
export const words = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.\-[\]():#/\\]+/g, ' ').replace(/\d+/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
// In this order: the first that matches wins ("Business email" is the email, "Company name" is the business).
const RULES = [
  ['email', /\be ?mail\b/],
  ['phone', /\b(phone|mobile|mob|tel|telephone|cell|contact (no|number))\b/],
  ['taxNumber', /\b(abn|acn|tin|tfn|gst|vat|ein|ird|nzbn|uen|pan|tax|business number|registration (no|number)|company number)\b/],
  ['business', /\b(company|business|organi[sz]ation|employer|trading|firm|entity|supplier|vendor)\b/],
  ['firstName', /\b(first|given|fore) ?name\b/],
  ['lastName', /\b(last|family|sur) ?name\b|\bsurname\b/],
  ['name', /\b(full name|your name|name|contact person|applicant|signatory name|print name)\b/],
  ['address', /\b(address|street|postal|mailing)\b/],
];
const NOT_MINE = /\b(signature|sign here|date|amount|total|qty|quantity|price|description|reference|ref|invoice|account|bsb|bank|code|city|suburb|state|post ?code|zip|country|password)\b/;

/** Which saved detail a field wants ('' when none). field: { name, label } — the label (a tooltip or the words next to it) counts first. */
export function fieldKey(field, profile = {}) {
  const custom = words(profile.taxLabel);
  for (const text of [words(field.label), words(field.name)]) {
    if (!text) continue;
    if (custom && custom !== 'tax number' && text.includes(custom)) return 'taxNumber';
    if (NOT_MINE.test(text) && !/\b(e ?mail|address|phone|name)\b/.test(text)) continue;
    for (const [key, re] of RULES) if (re.test(text)) return key;
  }
  return '';
}
/**
 * Fill my details: what goes in each empty text field. fields: [{ name, label, kind, value }].
 * Returns [{ name, key, value }] (fields that already have something in them are left alone).
 */
export function matchFields(fields, profile = {}) {
  const parts = String(profile.name || '').trim().split(/\s+/).filter(Boolean);
  const values = { ...profile, firstName: parts[0] || '', lastName: parts.length > 1 ? parts.slice(1).join(' ') : '' };
  const out = [];
  for (const f of fields) {
    if (f.kind !== 'text' || String(f.value || '').trim()) continue;
    const key = fieldKey(f, profile);
    const value = key ? String(values[key] || '').trim() : '';
    if (value) out.push({ name: f.name, key, value });
  }
  return out;
}
/**
 * The words printed next to a form box on the page (to the left on the same line, else just above).
 * rect: { x, y, w, h } in PDF points (y up); items: the page's text pieces { str, x, y, w, h } (y = baseline).
 */
export function nearbyLabel(rect, items) {
  const cy = rect.y + rect.h / 2;
  let best = null; let bestD = Infinity;
  for (const it of items || []) {
    if (!it.str || !it.str.trim()) continue;
    const mid = it.y + it.h * 0.35;
    const right = it.x + it.w;
    if (right <= rect.x + 2 && rect.x - right < 220 && Math.abs(mid - cy) < Math.max(rect.h * 0.75, it.h)) {
      const d = rect.x - right; if (d < bestD) { bestD = d; best = it; }
    }
  }
  if (best) return best.str.trim();
  for (const it of items || []) {
    if (!it.str || !it.str.trim()) continue;
    const above = it.y - (rect.y + rect.h);
    const overlap = Math.min(rect.x + rect.w, it.x + it.w) - Math.max(rect.x, it.x);
    if (above >= -1 && above < it.h * 2.4 && overlap > 0) { const d = above; if (d < bestD) { bestD = d; best = it; } }
  }
  return best ? best.str.trim() : '';
}

// ---------------------------------------------------------------- Batch
const BAD_NAME = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Rename pattern: {name} (original name, no .pdf), {date} (yyyy-mm-dd), {n} (1, 2, 3… padded to the count). Always ends in .pdf. */
export function renamePattern(pattern, { name, date = new Date(), n = 1, total = 1 }) {
  const d = date instanceof Date ? date : new Date(date);
  const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const base = String(name || 'document').replace(/\.pdf$/i, '');
  const width = String(total).length;
  let out = String(pattern || '{name}').replace(/\{name\}/gi, base).replace(/\{date\}/gi, iso).replace(/\{n\}/gi, String(n).padStart(width, '0'));
  out = out.replace(/\.pdf$/i, '').replace(BAD_NAME, '-').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
  return `${out || base}.pdf`;
}
export const pageLabel = (format, n, total) => String(format || '{n}').replace(/\{n\}/g, n).replace(/\{total\}/g, total);
export const PAGE_NUMBER_POSITIONS = [['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-center', 'Top centre'], ['top-right', 'Top right'], ['top-left', 'Top left']];
/** Where a page number's text starts. position: 'bottom-center' | 'top-right' | ... ('top'/'bottom' mean centre). */
export function pageNumberXY(position, pw, ph, textW, size = 10) {
  const [v, h = 'center'] = String(position || 'bottom-center').split('-');
  const margin = 36;
  const x = h === 'left' ? margin : h === 'right' ? pw - margin - textW : (pw - textW) / 2;
  const y = v === 'top' ? ph - 26 - size * 0.2 : 18;
  return { x, y };
}
/** Page numbers on every page. opts: { format: 'Page {n} of {total}', position, size }. font: an embedded font. */
export function applyPageNumbers(L, doc, font, { format = 'Page {n} of {total}', position = 'bottom-center', size = 10 } = {}) {
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    const label = pageLabel(format, i + 1, pages.length);
    const { width, height } = pg.getSize();
    const tw = font.widthOfTextAtSize(label, size);
    const { x, y } = pageNumberXY(position, width, height, tw, size);
    pg.drawText(label, { x, y, size, font, color: L.rgb(0.2, 0.2, 0.2) });
  });
  return pages.length;
}
/** Where a watermark goes: { x, y, size } for text of width w1 at size 1, turned angle degrees, centred on the page. */
export function watermarkGeometry(pw, ph, w1, angle = 35) {
  const a = (Number(angle) * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)); const s = Math.abs(Math.sin(a));
  const room = Math.min(c > 0.01 ? pw / c : Infinity, s > 0.01 ? ph / s : Infinity) * 0.78;
  const size = Math.max(8, Math.min(120, room / Math.max(1, w1)));
  const tw = w1 * size;
  const x = pw / 2 - (Math.cos(a) * tw) / 2 + Math.sin(a) * size * 0.35;
  const y = ph / 2 - (Math.sin(a) * tw) / 2 - Math.cos(a) * size * 0.35;
  return { x, y, size };
}
export function hexColor(L, hex) {
  const n = parseInt(String(hex || '#9ca3af').replace('#', ''), 16) || 0;
  return L.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
/** A text watermark across every page. opts: { text, opacity (0-1), angle (degrees), color } */
export function applyWatermark(L, doc, font, { text = 'CONFIDENTIAL', opacity = 0.22, angle = 35, color = '#9ca3af' } = {}) {
  const t = String(text || '').trim() || 'CONFIDENTIAL';
  for (const pg of doc.getPages()) {
    const { width, height } = pg.getSize();
    const g = watermarkGeometry(width, height, font.widthOfTextAtSize(t, 1), angle);
    pg.drawText(t, { x: g.x, y: g.y, size: g.size, font, color: hexColor(L, color), opacity: Math.max(0.03, Math.min(1, +opacity || 0.22)), rotate: L.degrees(Number(angle) || 0) });
  }
  return t;
}

/** The batch actions, in the order they're offered. */
export const BATCH_ACTIONS = ['compress', 'watermark', 'pagenumbers', 'password', 'rename'];
/**
 * Run the batch. files: [{ path, name }]; steps: [{ type, ...options }] in the order chosen (a password is always put on
 * last, after everything else, because a protected file can't be changed). io:
 *   { L, read(path) -> bytes, compress(bytes, step) -> bytes, write(file, name, bytes) -> saved path, now: Date }
 * onProgress({ done, total, file }). Returns [{ file, ok, output, before, after, error }]. Originals are never touched
 * here: write() decides where the file goes (and only replaces an original when the person ticked that).
 */
export async function runBatch(files, steps, io, onProgress = () => {}) {
  const { L } = io;
  const results = [];
  const rename = steps.find((s) => s.type === 'rename');
  const password = steps.find((s) => s.type === 'password' && s.password);
  const work = steps.filter((s) => ['compress', 'watermark', 'pagenumbers'].includes(s.type));
  for (const [i, f] of files.entries()) {
    onProgress({ done: i, total: files.length, file: f.name });
    try {
      let bytes = await io.read(f.path);
      const before = bytes.length;
      for (const s of work) {
        if (s.type === 'compress') { const small = await io.compress(bytes, s); if (small && small.length < bytes.length) bytes = small; continue; }
        const doc = await L.PDFDocument.load(bytes);
        const font = await doc.embedFont(s.type === 'watermark' ? L.StandardFonts.HelveticaBold : L.StandardFonts.Helvetica);
        if (s.type === 'watermark') applyWatermark(L, doc, font, s);
        if (s.type === 'pagenumbers') applyPageNumbers(L, doc, font, s);
        bytes = await doc.save();
      }
      if (password) {
        const doc = await L.PDFDocument.load(bytes);
        doc.encrypt({ userPassword: password.password, ownerPassword: password.password, permissions: { printing: 'highResolution', copying: true, modifying: true, annotating: true, fillingForms: true } });
        bytes = await doc.save();
      }
      const name = rename ? renamePattern(rename.pattern, { name: f.name, date: io.now || new Date(), n: i + 1, total: files.length }) : f.name;
      const output = await io.write(f, name, bytes);
      results.push({ file: f.path, name: f.name, ok: true, output, before, after: bytes.length });
    } catch (e) {
      const msg = /encrypt/i.test(e.message) ? 'This PDF has a password. Open it in Riyeser PDF with its password first.' : e.message;
      results.push({ file: f.path, name: f.name, ok: false, error: msg });
    }
  }
  onProgress({ done: files.length, total: files.length, file: '' });
  return results;
}

// ---------------------------------------------------------------- Split
/** "1-3, 5, 8-" -> [[1,3],[5,5],[8,total]]. Throws a plain message when it can't be read. */
export function parseRanges(text, total) {
  const out = [];
  for (const raw of String(text || '').split(/[,;]+/)) {
    const t = raw.trim(); if (!t) continue;
    const m = /^(\d+)?\s*(?:-|–|to)\s*(\d+)?$/i.exec(t) || /^(\d+)$/.exec(t);
    if (!m) throw new Error(`"${t}" isn't a page or a range (use something like 1-3, 5, 8-).`);
    const a = m[1] ? +m[1] : 1; const b = m.length > 2 ? (m[2] ? +m[2] : (/[-–]|to/i.test(t) ? total : a)) : a;
    if (a < 1 || b < a || b > total) throw new Error(`Pages ${t} aren't in this PDF (it has ${total} page${total === 1 ? '' : 's'}).`);
    out.push([a, b]);
  }
  if (!out.length) throw new Error('Type the pages, for example 1-3, 4-6.');
  return out;
}
/** Every n pages: [[1,n],[n+1,2n],...] */
export function everyN(n, total) { const out = []; for (let a = 1; a <= total; a += n) out.push([a, Math.min(total, a + n - 1)]); return out; }

// ---------------------------------------------------------------- Compare
/** A page's text pieces -> words with where each one is (the width shared out by letters). */
export function wordsFromItems(items) {
  const out = [];
  for (const it of items || []) {
    const s = String(it.str || ''); if (!s.trim()) continue;
    const cw = (it.w || 0) / Math.max(1, s.length);
    const re = /\S+/g; let m;
    while ((m = re.exec(s))) out.push({ text: m[0], x: it.x + m.index * cw, y: it.y, w: m[0].length * cw, h: it.h || 10 });
  }
  return out;
}
/**
 * Word-by-word differences: [{ op: 'same' | 'del' | 'add', a?: index in a, b?: index in b }].
 * The longest common run (dynamic programming) after taking off what's the same at both ends.
 */
export function diffWords(a, b, { limit = 4_000_000 } = {}) {
  const A = a.map((w) => (typeof w === 'string' ? w : w.text)); const B = b.map((w) => (typeof w === 'string' ? w : w.text));
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0; while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const ops = [];
  for (let i = 0; i < s; i++) ops.push({ op: 'same', a: i, b: i });
  const a1 = A.slice(s, A.length - e); const b1 = B.slice(s, B.length - e);
  const n = a1.length; const m = b1.length;
  if (n * m > limit) { // too big to line up word by word: everything in the middle counts as changed
    for (let i = 0; i < n; i++) ops.push({ op: 'del', a: s + i });
    for (let j = 0; j < m; j++) ops.push({ op: 'add', b: s + j });
  } else {
    const w = m + 1; const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a1[i] === b1[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0; let j = 0;
    while (i < n && j < m) {
      if (a1[i] === b1[j]) { ops.push({ op: 'same', a: s + i, b: s + j }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { ops.push({ op: 'del', a: s + i }); i++; }
      else { ops.push({ op: 'add', b: s + j }); j++; }
    }
    for (; i < n; i++) ops.push({ op: 'del', a: s + i });
    for (; j < m; j++) ops.push({ op: 'add', b: s + j });
  }
  for (let k = 0; k < e; k++) ops.push({ op: 'same', a: A.length - e + k, b: B.length - e + k });
  return ops;
}
/**
 * Compare two PDFs page by page. pagesA/pagesB: [[word, ...], ...] (wordsFromItems of each page).
 * Returns [{ page, status: 'same' | 'changed' | 'added' | 'removed' | 'notext', removed: [i in A], added: [j in B] }].
 * 'notext': neither copy has words on that page (a scan): only a picture comparison can tell, so the screen offers
 * Recognise text first.
 */
export function comparePages(pagesA, pagesB) {
  const out = [];
  for (let p = 0; p < Math.max(pagesA.length, pagesB.length); p++) {
    const a = pagesA[p]; const b = pagesB[p];
    if (!a) { out.push({ page: p + 1, status: 'added', removed: [], added: (b || []).map((_, j) => j) }); continue; }
    if (!b) { out.push({ page: p + 1, status: 'removed', removed: a.map((_, i) => i), added: [] }); continue; }
    if (!a.length && !b.length) { out.push({ page: p + 1, status: 'notext', removed: [], added: [] }); continue; }
    const ops = diffWords(a, b);
    const removed = ops.filter((o) => o.op === 'del').map((o) => o.a);
    const added = ops.filter((o) => o.op === 'add').map((o) => o.b);
    out.push({ page: p + 1, status: removed.length || added.length ? 'changed' : 'same', removed, added });
  }
  return out;
}
/** How different two pictures of a page are (0 = the same, 1 = every pixel). a/b: RGBA data of the same size. */
export function pixelDifference(a, b, threshold = 48) {
  if (!a || !b || a.length !== b.length) return 1;
  let diff = 0; const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > threshold) diff++;
  return diff / n;
}
