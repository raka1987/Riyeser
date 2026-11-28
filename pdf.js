// A small PDF writer for payslips attached to emails (M7): A4 pages of text in Helvetica, no other packages needed.
// Each page is a list of items: { text, x, y, size, bold, right } (x/y in points from the top-left; right = align the
// text's right edge to x) and { line: [x1, y1, x2, y2] }.
const W = 595.28, H = 841.89;
// Helvetica widths (per 1000) for the characters payslips use most; others count as 556
const WIDTHS = { ' ': 278, '.': 278, ',': 278, ':': 278, '-': 333, '(': 333, ')': 333, '/': 278, '$': 556, '%': 889, '@': 1015, 'I': 278, 'J': 500, 'F': 611, 'i': 222, 'l': 222, 'j': 222, 't': 278, 'f': 278, 'r': 333, 'm': 833, 'w': 722, 'W': 944, 'M': 833 };
const BOLD = { ...WIDTHS, '-': 333, 'I': 278, 'J': 556, 'i': 278, 'l': 278, 'j': 278, 't': 333, 'f': 333, 'r': 389, 'm': 889, 'w': 778 };
// keep to the PDF's WinAnsi characters: dashes and minus signs become '-', anything else unknown becomes '?'
const clean = s => String(s ?? '').replace(/[‒-―−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
const width = (s, size, bold) => [...clean(s)].reduce((a, c) => a + ((bold ? BOLD : WIDTHS)[c] || 556), 0) * size / 1000;
const esc = s => clean(s).replace(/([\\()])/g, '\\$1');

// an image XObject (and its soft mask for transparency) for a logo { mime, data, w, h }
function imageObjects(add, logo) {
  if (logo.mime === 'image/jpeg') {
    const { jpegInfo } = require('./brand'), j = jpegInfo(logo.data) || { comps: 3 };
    const cs = j.comps === 1 ? '/DeviceGray' : j.comps === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
    return add(`<< /Type /XObject /Subtype /Image /Width ${logo.w} /Height ${logo.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.data.length} >>\nstream\n${Buffer.from(logo.data).toString('latin1')}\nendstream`);
  }
  const img = require('./brand').decodePng(Buffer.from(logo.data)); if (!img) return null;
  const zlib = require('zlib'), rgb = zlib.deflateSync(img.rgb);
  let smask = '';
  if (img.alpha) { const a = zlib.deflateSync(img.alpha); smask = ` /SMask ${add(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${a.length} >>\nstream\n${a.toString('latin1')}\nendstream`)} 0 R`; }
  return add(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask} /Length ${rgb.length} >>\nstream\n${rgb.toString('latin1')}\nendstream`);
}

function pdf(pages) {
  const objs = [];
  const add = body => { objs.push(body); return objs.length; };
  const catalog = add(''), pagesId = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [], images = new Map();   // the same logo on every page is stored once
  for (const items of pages) {
    const ops = [], used = new Set();
    for (const it of items) {
      if (it.line) { const [x1, y1, x2, y2] = it.line; ops.push(`${it.color ? it.color.map(c => (c / 255).toFixed(3)).join(' ') + ' RG ' : '0 G '}${it.width || 0.6} w ${x1.toFixed(2)} ${(H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(H - y2).toFixed(2)} l S`); continue; }
      if (it.image) {
        if (!images.has(it.image.data)) images.set(it.image.data, { id: imageObjects(add, it.image), name: `Im${images.size + 1}` });
        const im = images.get(it.image.data); if (!im.id) continue;
        used.add(im);
        ops.push(`q ${it.w.toFixed(2)} 0 0 ${it.h.toFixed(2)} ${it.x.toFixed(2)} ${(H - it.y - it.h).toFixed(2)} cm /${im.name} Do Q`);
        continue;
      }
      const size = it.size || 10, x = it.right ? it.x - width(it.text, size, it.bold) : it.x;
      const fill = it.color ? it.color.map(c => (c / 255).toFixed(3)).join(' ') + ' rg ' : it.gray ? '0.4 g ' : '0 g ';
      ops.push(`BT /${it.bold ? 'F2' : 'F1'} ${size} Tf ${fill}${x.toFixed(2)} ${(H - it.y).toFixed(2)} Td (${esc(it.text)}) Tj ET`);
    }
    const stream = ops.join('\n'), content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    const xobj = used.size ? ` /XObject << ${[...used].map(im => `/${im.name} ${im.id} 0 R`).join(' ')} >>` : '';
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R /F2 ${fontB} 0 R >>${xobj} >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = objs.map((body, i) => { const at = Buffer.byteLength(out, 'latin1'); out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// words onto lines no wider than maxW (a word longer than a line is cut where it must be)
function wrap(text, size, bold, maxW) {
  const out = []; let cur = '';
  for (let word of clean(text).split(/\s+/).filter(Boolean)) {
    while (width(word, size, bold) > maxW) { let n = word.length; while (n > 1 && width(word.slice(0, n), size, bold) > maxW) n--; if (cur) { out.push(cur); cur = ''; } out.push(word.slice(0, n)); word = word.slice(n); }
    const next = cur ? `${cur} ${word}` : word;
    if (cur && width(next, size, bold) > maxW) { out.push(cur); cur = word; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

const NAVY = [16, 35, 68];
// The business's letterhead (brand.js): logo, name, legal name, tax number, address and contacts on the left; the
// title and draft note on the right; a navy rule under. Returns the y below it.
function letterhead(items, b, title, sub) {
  const L = 56, R = W - 56, LW = 300, top = 48;
  let y = top;
  if (b.logo) { const { fit } = require('./brand'), f = fit(b.logo, 170, 56); items.push({ image: b.logo, x: L, y, w: f.w, h: f.h }); y += f.h + 10; }
  y += 12;
  for (const l of wrap(b.name || '', 14, true, LW)) { items.push({ text: l, x: L, y, size: 14, bold: true }); y += 16; }
  const small = [b.legal_name, b.tax_line, ...(b.address_lines || [])].filter(Boolean);
  let cur = '';
  for (const c of b.contact_lines || []) { const j = cur ? `${cur}  ·  ${c}` : c; if (cur && width(j, 9) > LW) { small.push(cur); cur = c; } else cur = j; }
  if (cur) small.push(cur);
  for (const s of small) for (const l of wrap(s, 9, false, LW)) { items.push({ text: l, x: L, y, size: 9, gray: true }); y += 12; }
  items.push({ text: title, x: R, y: top + 18, size: 20, bold: true, right: true, color: NAVY });
  let ry = top + 34;
  for (const l of wrap(sub || '', 9, true, R - L - LW - 20)) { items.push({ text: l, x: R, y: ry, size: 9, bold: true, right: true, color: [179, 38, 30] }); ry += 12; }
  y = Math.max(y, ry) + 6;
  items.push({ line: [L, y, R, y], width: 1.4, color: NAVY });
  return y + 22;
}

// A payslip page: the business's letterhead (when brand is given) or a heading, then rows of [label, amount]
function payslipPage({ title, lines = [], rows = [], brand = null, draft = '' }) {
  const L = 56, R = W - 56, items = [];
  let y;
  if (brand) {
    y = letterhead(items, brand, 'Payslip', draft);
    for (const l of lines) { items.push({ text: l, x: L, y, size: 10, gray: l !== lines[0], bold: l === lines[0] }); y += 14; }
  } else {
    items.push({ text: title, x: L, y: 70, size: 16, bold: true });
    y = 92;
    for (const l of lines) { items.push({ text: l, x: L, y, size: 10, gray: true }); y += 14; }
  }
  y += 10; items.push({ line: [L, y, R, y] }); y += 18;
  for (const r of rows) {
    if (r.heading) { y += 8; items.push({ text: r.heading, x: L, y, size: 11, bold: true }); y += 16; continue; }
    if (r.rule) { items.push({ line: [L, y - 11, R, y - 11], width: 1.2 }); y += 4; }
    items.push({ text: r[0], x: L, y, size: r.big ? 12 : 10, bold: !!r.bold, gray: !!r.gray }, { text: r[1], x: R, y, size: r.big ? 12 : 10, bold: !!r.bold, gray: !!r.gray, right: true });
    y += r.big ? 20 : 16;
    if (y > H - 60) break; // one page per payslip
  }
  items.push({ text: 'Produced with Riyeser Payroll', x: W / 2 - width('Produced with Riyeser Payroll', 7) / 2, y: H - 24, size: 7, gray: true });
  return items;
}

module.exports = { pdf, payslipPage, letterhead, wrap, clean };
