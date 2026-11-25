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

function pdf(pages) {
  const objs = [];
  const add = body => { objs.push(body); return objs.length; };
  const catalog = add(''), pagesId = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const items of pages) {
    const ops = [];
    for (const it of items) {
      if (it.line) { const [x1, y1, x2, y2] = it.line; ops.push(`${it.width || 0.6} w ${x1.toFixed(2)} ${(H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(H - y2).toFixed(2)} l S`); continue; }
      const size = it.size || 10, x = it.right ? it.x - width(it.text, size, it.bold) : it.x;
      ops.push(`BT /${it.bold ? 'F2' : 'F1'} ${size} Tf ${it.gray ? '0.4 g ' : '0 g '}${x.toFixed(2)} ${(H - it.y).toFixed(2)} Td (${esc(it.text)}) Tj ET`);
    }
    const stream = ops.join('\n'), content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R /F2 ${fontB} 0 R >> >> /Contents ${content} 0 R >>`));
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

// A payslip page: a heading block, then rows of [label, amount] (bold rows and rules where asked)
function payslipPage({ title, lines = [], rows = [] }) {
  const L = 56, R = W - 56, items = [{ text: title, x: L, y: 70, size: 16, bold: true }];
  let y = 92;
  for (const l of lines) { items.push({ text: l, x: L, y, size: 10, gray: true }); y += 14; }
  y += 10; items.push({ line: [L, y, R, y] }); y += 18;
  for (const r of rows) {
    if (r.heading) { y += 8; items.push({ text: r.heading, x: L, y, size: 11, bold: true }); y += 16; continue; }
    if (r.rule) { items.push({ line: [L, y - 11, R, y - 11], width: 1.2 }); y += 4; }
    items.push({ text: r[0], x: L, y, size: r.big ? 12 : 10, bold: !!r.bold, gray: !!r.gray }, { text: r[1], x: R, y, size: r.big ? 12 : 10, bold: !!r.bold, gray: !!r.gray, right: true });
    y += r.big ? 20 : 16;
    if (y > H - 60) break; // one page per payslip
  }
  return items;
}

module.exports = { pdf, payslipPage, clean };
