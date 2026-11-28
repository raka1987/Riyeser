// synthetic sample files for screenshots
const L = require(require('path').resolve(process.argv[2], 'node_modules/@cantoo/pdf-lib'));
const fs = require('fs'); const path = require('path'); const OUT = process.argv[3];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of ['photo-exif6.jpg', 'scan.jpg']) fs.copyFileSync(path.join(__dirname, '..', '..', 'fixtures', f), path.join(OUT, f));
  // a supplier application form with fillable fields
  const d = await L.PDFDocument.create(); const f = await d.embedFont(L.StandardFonts.Helvetica); const b = await d.embedFont(L.StandardFonts.HelveticaBold);
  const p = d.addPage([595, 842]); const form = d.getForm();
  p.drawText('New supplier application', { x: 50, y: 780, size: 22, font: b });
  p.drawText('Harbourside Hardware Ltd (sample) - please complete and return.', { x: 50, y: 756, size: 11, font: f });
  const rows = [['Contact name', 'Text1'], ['Business name', 'Text2'], ['ABN / tax number', 'Text3'], ['Postal address', 'Text4'], ['Phone', 'Text5'], ['Email', 'Text6'], ['Order reference', 'Text7']];
  rows.forEach(([label, name], i) => { const y = 700 - i * 44; p.drawText(label, { x: 50, y: y + 6, size: 11, font: f }); const t = form.createTextField(name); t.addToPage(p, { x: 190, y, width: 340, height: 22 }); });
  const c = form.createCheckBox('agree'); c.addToPage(p, { x: 50, y: 360, width: 14, height: 14 }); p.drawText('I agree to the trading terms', { x: 72, y: 362, size: 11, font: f });
  p.drawText('Signed', { x: 50, y: 300, size: 11, font: f }); p.drawLine({ start: { x: 110, y: 298 }, end: { x: 330, y: 298 }, thickness: 0.8 });
  p.drawText('Date', { x: 360, y: 300, size: 11, font: f }); p.drawLine({ start: { x: 395, y: 298 }, end: { x: 530, y: 298 }, thickness: 0.8 });
  fs.writeFileSync(path.join(OUT, 'Supplier application form.pdf'), await d.save());
  // two versions of a quote for Compare
  const quote = async (name, lines, extra) => {
    const q = await L.PDFDocument.create(); const qf = await q.embedFont(L.StandardFonts.Helvetica); const qb = await q.embedFont(L.StandardFonts.HelveticaBold);
    const pg = q.addPage([595, 842]);
    pg.drawText('Quote Q-2041', { x: 50, y: 780, size: 22, font: qb });
    pg.drawText('Sample Plumbing Ltd for Harbourside Hardware Ltd', { x: 50, y: 756, size: 11, font: qf });
    lines.forEach((l, i) => pg.drawText(l, { x: 50, y: 700 - i * 22, size: 12, font: qf }));
    const p2 = q.addPage([595, 842]); p2.drawText('Terms', { x: 50, y: 780, size: 18, font: qb });
    extra.forEach((l, i) => p2.drawText(l, { x: 50, y: 740 - i * 22, size: 12, font: qf }));
    fs.writeFileSync(path.join(OUT, name), await q.save());
  };
  await quote('Quote Q-2041 v1.pdf', ['Supply and fit hot water cylinder 180 L: $1,850.00', 'Copper pipe and fittings: $240.00', 'Labour, 6 hours: $540.00', 'Total: $2,630.00 including GST', 'Valid for 30 days.'], ['Payment within 14 days of the invoice.', 'A deposit of 20% is due before work starts.']);
  await quote('Quote Q-2041 v2.pdf', ['Supply and fit hot water cylinder 250 L: $2,150.00', 'Copper pipe and fittings: $240.00', 'Labour, 7 hours: $630.00', 'Total: $3,020.00 including GST', 'Valid for 30 days.'], ['Payment within 7 days of the invoice.', 'A deposit of 20% is due before work starts.']);
  // an invoice with lines (a simple table) for PDF to Excel
  {
    const q = await L.PDFDocument.create(); const qf = await q.embedFont(L.StandardFonts.Helvetica); const qb = await q.embedFont(L.StandardFonts.HelveticaBold);
    const pg = q.addPage([595, 842]);
    pg.drawText('Tax invoice INV-1004', { x: 50, y: 780, size: 20, font: qb });
    pg.drawText('Sample Plumbing Ltd to Harbourside Hardware Ltd (sample)', { x: 50, y: 756, size: 11, font: qf });
    const rows = [['Item', 'Qty', 'Unit price', 'Amount'], ['Hot water cylinder 250 L', '1', '$2,150.00', '$2,150.00'], ['Copper pipe 15 mm (m)', '12', '$20.00', '$240.00'], ['Labour (hours)', '7', '$90.00', '$630.00'], ['Total', '', '', '$3,020.00']];
    rows.forEach((r, i) => { const y = 690 - i * 20; const font = i === 0 || i === rows.length - 1 ? qb : qf; pg.drawText(r[0], { x: 50, y, size: 11, font }); pg.drawText(r[1], { x: 300, y, size: 11, font }); for (const [k, x] of [[2, 440], [3, 545]]) pg.drawText(r[k], { x: x - font.widthOfTextAtSize(r[k], 11), y, size: 11, font }); });
    fs.writeFileSync(path.join(OUT, 'Invoice INV-1004 with lines.pdf'), await q.save());
  }
  // invoices for batch
  for (const n of [1001, 1002, 1003]) {
    const q = await L.PDFDocument.create(); const qf = await q.embedFont(L.StandardFonts.Helvetica);
    q.addPage([595, 842]).drawText(`Invoice INV-${n} (sample)`, { x: 50, y: 780, size: 20, font: qf });
    fs.writeFileSync(path.join(OUT, `Invoice INV-${n}.pdf`), await q.save());
  }
})();
