// Riyeser PDF 0.26.0 ("much handier"): converters, Batch, Compare, stamps' dates, Fill my details, the right-click
// menu's command lines, saved signatures, Send to Riyeser Documents and the Print to PDF inbox.
// Synthetic files only. The PDF library is the one the editor loads (@cantoo/pdf-lib); pdf.js reads results back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { pathToFileURL } = require('url');
const L = require('@cantoo/pdf-lib');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const H = () => import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'pdf-handy.mjs')).href);
const C = require('../src/pdf/converters');
const A = require('../src/pdf/args');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-pdf-handy-'));
// read back with the same pdf.js the converters use (unpdf), as any PDF reader would
async function texts(bytes, password) {
  return (await C.readPages(bytes, { password })).map((p) => p.items.map((x) => x.str).join(' '));
}
/** A synthetic invoice with a small table: Item / Qty / Price (prices right-aligned). */
async function invoicePdf(dir, name = 'Invoice INV-1001.pdf') {
  const d = await L.PDFDocument.create(); const f = await d.embedFont(L.StandardFonts.Helvetica); const b = await d.embedFont(L.StandardFonts.HelveticaBold);
  const p = d.addPage([595, 842]);
  p.drawText('Sample Plumbing Ltd', { x: 50, y: 780, size: 20, font: b });
  p.drawText('Thank you for your business. Payment is due within fourteen days of the invoice date.', { x: 50, y: 740, size: 10, font: f });
  const rows = [['Item', 'Qty', 'Price'], ['Copper pipe 15mm', '4', '$32.00'], ['Elbow joint', '10', '$1,250.50'], ['Labour (hours)', '3', '$270.00']];
  rows.forEach((r, i) => {
    const y = 680 - i * 18; const font = i ? f : b;
    p.drawText(r[0], { x: 50, y, size: 11, font });
    p.drawText(r[1], { x: 300, y, size: 11, font });
    p.drawText(r[2], { x: 480 - font.widthOfTextAtSize(r[2], 11), y, size: 11, font });
  });
  p.drawText('Questions? Email accounts@sample.example', { x: 50, y: 560, size: 10, font: f });
  d.addPage([595, 842]).drawText('Page two: terms and conditions apply.', { x: 50, y: 700, size: 12, font: f });
  const file = path.join(dir, name); fs.writeFileSync(file, await d.save());
  return file;
}

// ---------------------------------------------------------------- converters
test('Convert: pictures to PDF, with a sideways phone photo turned the right way up (EXIF), A4 and the picture\'s own size', async () => {
  const dir = tmp();
  for (const f of ['photo-exif6.jpg', 'small.png']) fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
  assert.strictEqual(await C.orientationOf(fs.readFileSync(path.join(dir, 'photo-exif6.jpg'))), 90);
  const r = await C.imagesToPdf([path.join(dir, 'photo-exif6.jpg'), path.join(dir, 'small.png')], { pageSize: 'fit' });
  assert.strictEqual(r.outputs.length, 1); assert.strictEqual(r.rotated, 1);
  const doc = await L.PDFDocument.load(fs.readFileSync(r.outputs[0]));
  const [p1, p2] = doc.getPages().map((p) => p.getSize());
  assert.ok(p1.height > p1.width, `the 120x80 photo stored sideways becomes an upright page: ${JSON.stringify(p1)}`);
  assert.ok(Math.abs(p1.width - 80 * 72 / 150) < 0.01 && Math.abs(p2.width - 90 * 72 / 150) < 0.01);
  // A4 portrait with margins, picture centred; landscape pictures get a landscape page on "automatic"
  const a4 = C.layoutImage(1200, 800, 0, { pageSize: 'a4', orientation: 'auto' });
  assert.deepStrictEqual(a4.page.map(Math.round), [842, 595]);
  assert.ok(Math.abs(a4.box.x * 2 + a4.box.w - 841.89) < 0.01 && a4.box.x >= 18 - 1e-9);
  assert.deepStrictEqual(C.layoutImage(1200, 800, 0, { pageSize: 'letter', orientation: 'portrait' }).page, [612, 792]);
  // the turned picture lands exactly in its box, whichever way it was stored
  for (const rot of [0, 90, 180, 270]) {
    const box = { x: 10, y: 20, w: 100, h: 50 };
    const s = C.drawSpec(box, rot);
    const t = (rot === 0 ? 0 : -rot) * Math.PI / 180; // pdf-lib turns anticlockwise for positive degrees; our spec uses -rot
    const R = (s.rotate * Math.PI) / 180;
    const corners = [[0, 0], [s.width, 0], [0, s.height], [s.width, s.height]].map(([u, v]) => [s.x + u * Math.cos(R) - v * Math.sin(R), s.y + u * Math.sin(R) + v * Math.cos(R)]);
    const xs = corners.map((c) => c[0]); const ys = corners.map((c) => c[1]);
    assert.deepStrictEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((n) => Math.round(n * 1000) / 1000), [10, 110, 20, 70], `rot ${rot} (${t})`);
  }
  // separate PDFs, one per picture
  const sep = await C.imagesToPdf([path.join(dir, 'small.png'), path.join(dir, 'photo-exif6.jpg')], { combine: false, pageSize: 'a4' });
  assert.deepStrictEqual(sep.outputs.map((o) => path.basename(o)), ['small.pdf', 'photo-exif6.pdf']);
  // HEIC: said plainly, not a crash
  fs.writeFileSync(path.join(dir, 'IMG_0001.HEIC'), 'x');
  await assert.rejects(C.imagesToPdf([path.join(dir, 'IMG_0001.HEIC')]), /HEIC photos can't be converted yet/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'convert.js'), 'utf8'), /HEIC_MESSAGE/);
});

test('Convert: PDF to plain text keeps the lines in reading order', async () => {
  const dir = tmp(); const file = await invoicePdf(dir);
  const r = await C.pdfToText(file);
  const t = fs.readFileSync(r.output, 'utf8');
  assert.strictEqual(path.basename(r.output), 'Invoice INV-1001.txt');
  assert.match(t, /^Sample Plumbing Ltd\n/);
  assert.match(t, /Elbow joint 10 \$1,250\.50/);
  assert.match(t, /\n\nPage two: terms and conditions apply\.\n$/);
  assert.strictEqual(r.pages, 2); assert.strictEqual(r.emptyPages, 0);
});

test('Convert: PDF to Excel / CSV (basic) finds the simple table, numbers as numbers', async () => {
  const dir = tmp(); const file = await invoicePdf(dir);
  const csv = await C.pdfToTable(file, { format: 'csv' });
  const text = fs.readFileSync(csv.output, 'utf8').replace(/^\ufeff/, '');
  assert.deepStrictEqual(text.trim().split('\r\n'), ['Item,Qty,Price', 'Copper pipe 15mm,4,$32.00', 'Elbow joint,10,"$1,250.50"', 'Labour (hours),3,$270.00']);
  assert.deepStrictEqual(csv.pages, [1]);
  const x = await C.pdfToTable(file, { format: 'xlsx' });
  const zip = await JSZip.loadAsync(fs.readFileSync(x.output));
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheet, /<c r="C3"><v>1250\.5<\/v><\/c>/); assert.match(sheet, /<t xml:space="preserve">Elbow joint<\/t>/);
  assert.match(await zip.file('xl/workbook.xml').async('string'), /<sheet name="Page 1"/);
  // the paragraph above the table isn't a table; a page of plain sentences gives an honest message
  const only = path.join(dir, 'letter.pdf');
  const d = await L.PDFDocument.create(); const f = await d.embedFont(L.StandardFonts.Helvetica);
  d.addPage().drawText('Dear customer, thanks for your order.', { x: 50, y: 700, size: 12, font: f }); fs.writeFileSync(only, await d.save());
  await assert.rejects(C.pdfToTable(only, { format: 'csv' }), /No simple tables were found/);
  assert.strictEqual(C.asNumber('(1,200.00)'), -1200); assert.strictEqual(C.asNumber('2026-11-28'), null); assert.strictEqual(C.asNumber('679 123 4567'), null);
});

test('Convert: PDF to Word (basic) writes the headings and paragraphs of each page', async () => {
  const dir = tmp(); const file = await invoicePdf(dir);
  const r = await C.pdfToDocx(file);
  const xml = await (await JSZip.loadAsync(fs.readFileSync(r.output))).file('word/document.xml').async('string');
  assert.match(xml, /Heading2[\s\S]*Sample Plumbing Ltd/);
  assert.match(xml, /Payment is due within fourteen days/);
  assert.match(xml, /w:br w:type="page"/);
  assert.match(xml, /Page two: terms and conditions apply\./);
  const paras = C.paragraphsFromLines([{ text: 'One line of a para-', y: 700, size: 10 }, { text: 'graph that carries on.', y: 688, size: 10 }, { text: 'A new one after a gap.', y: 640, size: 10 }]);
  assert.deepStrictEqual(paras.map((p) => p.text), ['One line of a paragraph that carries on.', 'A new one after a gap.']);
});

// ---------------------------------------------------------------- stamps, Fill my details
test('Stamps: the date in the business\'s format, or Windows\' own', async () => {
  const T = await H(); const d = new Date(2026, 10, 28);
  assert.strictEqual(T.formatStampDate(d, 'dmy'), '28/11/2026');
  assert.strictEqual(T.formatStampDate(d, 'mdy'), '11/28/2026');
  assert.strictEqual(T.formatStampDate(d, 'ymd'), '2026-11-28');
  assert.strictEqual(T.formatStampDate(new Date(2026, 0, 5), 'dmmmy'), '5 Jan 2026');
  assert.strictEqual(T.formatStampDate(d, 'system', 'en-AU'), '28/11/2026');
  assert.strictEqual(T.formatStampDate(d, 'system', 'en-US'), '11/28/2026');
  assert.deepStrictEqual(T.STAMP_PRESETS.map((s) => s.text), ['PAID', 'RECEIVED', 'APPROVED', 'COPY', 'DRAFT', 'CONFIDENTIAL']);
  const P = require('../src/pdf/profile');
  assert.strictEqual(P.dateFormatFor('system', { date_format: 'mdy' }), 'mdy');
  assert.strictEqual(P.dateFormatFor('system', { date_format: 'iso' }), 'ymd');
  assert.strictEqual(P.dateFormatFor('dmy', { date_format: 'mdy' }), 'dmy');
  assert.strictEqual(P.dateFormatFor(undefined, null), 'system');
});

test('Fill my details: fields are matched by their names and labels; filled ones and unrelated ones are left alone', async () => {
  const T = await H();
  const profile = { name: 'Jo Sample', business: 'Sample Plumbing Ltd', taxLabel: 'ABN', taxNumber: '12 345 678 901', address: '1 Sample St, Suva', phone: '+679 555 0100', email: 'jo@sample.example' };
  const fields = [
    { name: 'txtFullName', kind: 'text', value: '' },
    { name: 'Text1', label: 'Business name', kind: 'text', value: '' },
    { name: 'company_abn', kind: 'text', value: '' },
    { name: 'EmailAddress', kind: 'text', value: '' },
    { name: 'Text5', label: 'Postal address', kind: 'text', value: '' },
    { name: 'mobile_no', kind: 'text', value: '' },
    { name: 'given_name', kind: 'text', value: '' },
    { name: 'Surname', kind: 'text', value: '' },
    { name: 'Name', kind: 'text', value: 'Already typed' },
    { name: 'Signature', kind: 'text', value: '' },
    { name: 'Date', kind: 'text', value: '' },
    { name: 'InvoiceTotal', kind: 'text', value: '' },
    { name: 'agree', kind: 'check', value: false },
  ];
  const m = Object.fromEntries(T.matchFields(fields, profile).map((x) => [x.name, x.value]));
  assert.deepStrictEqual(m, { txtFullName: 'Jo Sample', Text1: 'Sample Plumbing Ltd', company_abn: '12 345 678 901', EmailAddress: 'jo@sample.example', Text5: '1 Sample St, Suva', mobile_no: '+679 555 0100', given_name: 'Jo', Surname: 'Sample' });
  // a custom tax label ("TIN") is recognised too, and the label beats a meaningless name
  assert.strictEqual(T.fieldKey({ name: 'f12', label: 'Your TIN' }, { taxLabel: 'TIN' }), 'taxNumber');
  assert.strictEqual(T.fieldKey({ name: 'f13', label: 'Company email' }, {}), 'email');
  // the words printed beside a box on the page
  const items = [{ str: 'Phone:', x: 50, y: 503, w: 34, h: 11 }, { str: 'Unrelated', x: 300, y: 600, w: 40, h: 11 }, { str: 'Email address', x: 200, y: 470, w: 60, h: 10 }];
  assert.strictEqual(T.nearbyLabel({ x: 95, y: 498, w: 150, h: 18 }, items), 'Phone:');
  assert.strictEqual(T.nearbyLabel({ x: 200, y: 440, w: 150, h: 18 }, items), 'Email address');
  // prefilled from Central's company.json; what was saved in Riyeser PDF wins
  const P = require('../src/pdf/profile');
  const { profile: p, fromCompany } = P.mergeProfile({ phone: '555 1234' }, { name: 'Sample Trading Co', your_name: 'Alex Sample', tax_number: 'TIN-1', address: '2 Main Rd', phone: '999', email: 'office@sample.example' });
  assert.deepStrictEqual(p, { name: 'Alex Sample', business: 'Sample Trading Co', taxLabel: 'Tax number', taxNumber: 'TIN-1', address: '2 Main Rd', phone: '555 1234', email: 'office@sample.example' });
  assert.deepStrictEqual(fromCompany, ['name', 'business', 'taxNumber', 'address', 'email']);
});

// ---------------------------------------------------------------- Batch
test('Batch: compress, watermark, page numbers, password and rename, in order; originals untouched', async () => {
  const T = await H(); const dir = tmp(); const out = path.join(dir, 'out'); fs.mkdirSync(out);
  const files = [await invoicePdf(dir, 'a.pdf'), await invoicePdf(dir, 'b.pdf')];
  const before = files.map((f) => fs.readFileSync(f));
  const order = [];
  const io = {
    L, now: new Date(2026, 10, 28),
    read: async (p) => new Uint8Array(fs.readFileSync(p)),
    compress: async (bytes) => { order.push('compress'); return bytes; },
    write: async (f, name, bytes) => { const dest = path.join(out, name); fs.writeFileSync(dest, bytes); return dest; },
  };
  const progress = [];
  const steps = [{ type: 'compress', quality: 'balanced' }, { type: 'watermark', text: 'COPY', opacity: 0.3, angle: 45, color: '#ff0000' }, { type: 'pagenumbers', format: 'Page {n} of {total}', position: 'bottom-right' },
    { type: 'password', password: 'batch-pass-1' }, { type: 'rename', pattern: '{date} {name} ({n})' }];
  const r = await T.runBatch(files.map((p) => ({ path: p, name: path.basename(p) })), steps, io, (x) => progress.push(x.done));
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.deepStrictEqual(r.map((x) => path.basename(x.output)), ['2026-11-28 a (1).pdf', '2026-11-28 b (2).pdf']);
  assert.deepStrictEqual(order, ['compress', 'compress']); assert.deepStrictEqual(progress, [0, 1, 2]);
  await assert.rejects(texts(fs.readFileSync(r[0].output)), /password/i);
  const t = await texts(fs.readFileSync(r[0].output), 'batch-pass-1');
  assert.match(t[0], /COPY/); assert.match(t[0], /Page 1 of 2/); assert.match(t[1], /Page 2 of 2/);
  files.forEach((f, i) => assert.ok(fs.readFileSync(f).equals(before[i]), 'the original is unchanged'));
  // page numbers go where asked; the watermark fits the page at any angle
  assert.deepStrictEqual(T.pageNumberXY('bottom-right', 595, 842, 50), { x: 509, y: 18 });
  assert.strictEqual(T.pageNumberXY('top-left', 595, 842, 50).x, 36);
  for (const angle of [0, 35, 90]) { const g = T.watermarkGeometry(595, 842, 5, angle); assert.ok(g.size >= 8 && g.size <= 120, `${angle}: ${g.size}`); }
  // rename patterns
  assert.strictEqual(T.renamePattern('{name}-{n}', { name: 'Q3: report?.pdf', n: 7, total: 120 }), 'Q3- report--007.pdf');
  assert.strictEqual(T.renamePattern('', { name: 'x.pdf' }), 'x.pdf');
  // a protected input is reported, the rest carry on
  const locked = await L.PDFDocument.create(); locked.addPage(); locked.encrypt({ userPassword: 'x', ownerPassword: 'x' });
  fs.writeFileSync(path.join(dir, 'locked.pdf'), await locked.save());
  const r2 = await T.runBatch([{ path: path.join(dir, 'locked.pdf'), name: 'locked.pdf' }, { path: files[0], name: 'a.pdf' }], [{ type: 'watermark', text: 'DRAFT' }], io);
  assert.strictEqual(r2[0].ok, false); assert.match(r2[0].error, /has a password/); assert.strictEqual(r2[1].ok, true);
});

test('Split: page ranges and every N pages', async () => {
  const T = await H();
  assert.deepStrictEqual(T.parseRanges('1-3, 5, 8-', 10), [[1, 3], [5, 5], [8, 10]]);
  assert.deepStrictEqual(T.parseRanges('-2', 4), [[1, 2]]);
  assert.throws(() => T.parseRanges('4-12', 10), /aren't in this PDF \(it has 10 pages\)/);
  assert.throws(() => T.parseRanges('abc', 10), /isn't a page or a range/);
  assert.deepStrictEqual(T.everyN(2, 5), [[1, 2], [3, 4], [5, 5]]);
});

// ---------------------------------------------------------------- Compare
test('Compare: words added and removed per page, extra pages, and scanned pages with no words', async () => {
  const T = await H();
  const ops = T.diffWords('Pay the total of $100 by Friday'.split(' '), 'Pay the total of $120 by next Friday'.split(' '));
  assert.deepStrictEqual(ops.filter((o) => o.op !== 'same'), [{ op: 'del', a: 4 }, { op: 'add', b: 4 }, { op: 'add', b: 6 }]);
  const w = (s) => T.wordsFromItems([{ str: s, x: 50, y: 700, w: s.length * 5, h: 10 }]);
  const a = [w('Invoice total $100'), w('Terms apply'), [], w('Last page')];
  const b = [w('Invoice total $100'), w('Terms and conditions apply'), [], ];
  const r = T.comparePages(a, b);
  assert.deepStrictEqual(r.map((p) => p.status), ['same', 'changed', 'notext', 'removed']);
  assert.deepStrictEqual(r[1].added, [1, 2]);
  assert.deepStrictEqual(T.comparePages([w('x')], [w('x'), w('new page')]).map((p) => p.status), ['same', 'added']);
  // word boxes share the piece's width by letters
  assert.deepStrictEqual(w('ab cd').map((x) => [x.text, x.x, x.w]), [['ab', 50, 10], ['cd', 65, 10]]);
  // pictures of scanned pages: the share of pixels that differ
  const px = (v) => new Uint8ClampedArray([v, v, v, 255, 255, 255, 255, 255]);
  assert.strictEqual(T.pixelDifference(px(255), px(255)), 0); assert.strictEqual(T.pixelDifference(px(0), px(255)), 0.5);
  // a very long page still answers quickly (everything in the middle counts as changed)
  const big = Array.from({ length: 3000 }, (_, i) => `w${i}`);
  assert.ok(T.diffWords(big, [...big].reverse(), { limit: 1000 }).length > 0);
});

// ---------------------------------------------------------------- right-click menu
test('Right-click menu: command lines are read the same way the installer writes them, and multi-select is gathered', async () => {
  const exists = (f) => /\.(pdf|jpe?g|png|heic)$/i.test(f);
  const exe = 'C:\\Users\\jo\\AppData\\Local\\Programs\\desk-pdf\\Riyeser PDF.exe';
  for (const m of A.MENU) {
    const argv = A.splitCommandLine(A.menuCommand(exe, m.task).replace('%1', 'C:\\Invoices\\INV 1001.pdf'));
    assert.strictEqual(argv[0], exe);
    const r = A.parseArgs(argv, { exists });
    assert.deepStrictEqual(r, { task: m.task === 'topdf' ? 'topdf' : m.task, files: [path.resolve('C:\\Invoices\\INV 1001.pdf')] });
  }
  // a double-click / "Open with" (no task), Chromium switches ignored, pictures open as "make a PDF"
  assert.deepStrictEqual(A.parseArgs(['exe', '--allow-file-access-from-files', '/x/a.pdf'], { exists }), { task: 'open', files: [path.resolve('/x/a.pdf')] });
  assert.deepStrictEqual(A.parseArgs(['exe', '/x/a.jpg'], { exists }), { task: 'topdf', files: [path.resolve('/x/a.jpg')] });
  assert.deepStrictEqual(A.parseArgs(['electron', 'src/pdf-main.js'], { exists }), { task: null, files: [] });
  assert.deepStrictEqual(A.parseArgs(['exe', '--task=format-c', '/x/a.pdf'], { exists }).task, 'open');
  // five files selected: five starts, one job
  const jobs = []; const timers = []; const fake = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} };
  const g = A.createGatherer({ run: (j) => jobs.push(j), quiet: 700, max: 4000, timers: fake });
  for (const [i, f] of ['a', 'b', 'c', 'd', 'a'].entries()) g.add({ task: 'combine', files: [`/x/${f}.pdf`] }, 1000 + i * 50);
  g.add({ task: 'compress', files: ['/x/z.pdf'] }, 1300);
  timers[timers.length - 1].fn();
  assert.deepStrictEqual(jobs, [{ task: 'combine', files: ['/x/a.pdf', '/x/b.pdf', '/x/c.pdf', '/x/d.pdf'] }, { task: 'compress', files: ['/x/z.pdf'] }]);
  // the installer script has exactly these entries, per user (HKCU), and removes them on uninstall
  const nsh = fs.readFileSync(path.join(ROOT, 'build', 'pdf', 'installer.nsh'), 'utf8');
  for (const m of A.MENU) for (const t of m.types) for (const ext of A.MENU_EXTS[t]) {
    assert.ok(nsh.includes(`!insertmacro riyeserPdfMenuEntry "${ext}" "${m.key}" "${m.label}" "${m.task}"`), `${ext} ${m.label}`);
  }
  assert.strictEqual((nsh.match(/riyeserPdfMenuEntry "/g) || []).length, A.MENU.reduce((n, m) => n + m.types.reduce((k, t) => k + A.MENU_EXTS[t].length, 0), 0));
  assert.match(nsh, /'"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --task=\$\{TASK\} "%1"'/);
  assert.doesNotMatch(nsh, /HKLM|HKCR/);
  for (const ext of ['.pdf', '.jpg', '.jpeg', '.png']) assert.ok(nsh.includes(`DeleteRegKey HKCU "Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\RiyeserPDF"`), ext);
  const cfg = fs.readFileSync(path.join(ROOT, 'scripts', 'builder.config.js'), 'utf8');
  assert.match(cfg, /include: 'build\/pdf\/installer\.nsh'/);
  assert.match(cfg, /fileAssociations: \[\{ ext: 'pdf'/);
});

// ---------------------------------------------------------------- saved signatures
test('Saved signatures: kept sealed on this PC, initials too, one default each; old ones are sealed on first read', async () => {
  const { createSignatureStore, makeSealer } = require('../src/pdf/signatures');
  const { Store } = require('../src/core/store');
  const dir = tmp(); const store = new Store(dir);
  // a stand-in for Windows' DPAPI: reversible, but nothing readable is left on disk
  const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(Buffer.from(s).map((c) => c ^ 0x5a)), decryptString: (b) => Buffer.from(b.map((c) => c ^ 0x5a)).toString() };
  const S = createSignatureStore({ store, ...makeSealer(fakeSafe) });
  const sig = 'data:image/png;base64,SIGNATUREPIXELS1'; const ini = 'data:image/png;base64,INITIALSPIXELS';
  // a signature saved by 0.25 (in the clear)
  store.set('signatures', [{ id: 'old1', data: 'data:image/png;base64,OLDSIGNATURE' }]);
  assert.deepStrictEqual(S.list().map((s) => [s.id, s.kind, s.data, s.isDefault]), [['old1', 'signature', 'data:image/png;base64,OLDSIGNATURE', true]]);
  const id = S.save({ kind: 'signature', data: sig });
  S.save({ kind: 'initials', data: ini });
  assert.strictEqual(S.getDefault('signature').data, sig);
  assert.strictEqual(S.getDefault('initials').data, ini);
  S.setDefault('old1'); assert.strictEqual(S.getDefault('signature').id, 'old1');
  const onDisk = fs.readFileSync(path.join(dir, 'signatures.json'), 'utf8');
  for (const secret of ['SIGNATUREPIXELS1', 'INITIALSPIXELS', 'OLDSIGNATURE']) assert.ok(!onDisk.includes(secret), `${secret} isn't readable on disk`);
  assert.match(onDisk, /"sealed": "enc:/);
  S.remove(id); assert.deepStrictEqual(S.list('signature').map((s) => s.id), ['old1']);
  assert.throws(() => S.save({ kind: 'initials', data: 'javascript:alert(1)' }), /isn't a signature picture/);
  assert.deepStrictEqual(S.status(), { protected: true, count: 2 });
  // no safe storage on this PC: still works, and says it isn't locked
  const plain = createSignatureStore({ store: new Store(tmp()), ...makeSealer({ isEncryptionAvailable: () => false }) });
  plain.save({ data: sig }); assert.strictEqual(plain.getDefault().data, sig); assert.strictEqual(plain.status().protected, false);
  // the main process uses Electron's safeStorage for it
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'pdf-ipc.js'), 'utf8'), /makeSealer\(safeStorage\)/);
});

// ---------------------------------------------------------------- Send to Riyeser Documents
test('Send to Riyeser Documents: a copy lands in the library\'s Inbox, with Documents\' access rules', async () => {
  const { createSender, libraryRoot } = require('../src/pdf/send-to-documents');
  const { Library } = require('../src/documents/library');
  const access = require('../src/documents/access');
  const appData = tmp(); const docsDir = tmp();
  const root = path.join(docsDir, 'Riyeser Documents');
  assert.strictEqual(libraryRoot({ appData, documentsDir: docsDir }), root);
  const sender = createSender({ appData, documentsDir: docsDir, readCompany: () => ({ name: 'Sample Co', your_name: 'Jo Sample', email_signed_in: 'jo@sample.example' }) });
  assert.match(sender.target().reason, /isn't set up on this PC yet/);
  const owner = new Library({ root, cacheDir: null, me: { id: 'u:owner@sample.example', name: 'Owner' } });
  owner.ensureLayout();
  const file = await invoicePdf(tmp());
  const t = sender.target();
  assert.strictEqual(t.ok, true); assert.strictEqual(t.who, 'Jo Sample');
  assert.ok(t.departments.some((d) => d.rel === 'Accounts' && d.canAdd));
  assert.ok(!t.departments.some((d) => d.rel === 'Payroll & HR'), 'a locked folder isn\'t offered');
  const r = sender.send([file], { dept: 'Accounts' });
  assert.strictEqual(r.added.length, 1);
  const docs = owner.docs();
  assert.strictEqual(docs.length, 1);
  assert.deepStrictEqual([docs[0].status, docs[0].sourceLabel, docs[0].addedBy, docs[0].deptHint], ['inbox', 'Riyeser PDF', 'u:jo@sample.example', 'Accounts']);
  assert.ok(fs.existsSync(path.join(root, '_Inbox', 'Invoice INV-1001.pdf')) && fs.existsSync(file), 'a copy: the original stays');
  assert.throws(() => sender.send([file], { dept: 'Payroll & HR' }), /don't have access to add documents to Payroll & HR/);
  // the owner makes the library view-only for everyone: sending is refused
  owner.updateAccess((a) => ({ ...a, owner: 'u:owner@sample.example', everyone: 'view' }), { force: true });
  assert.strictEqual(sender.target().canAddInbox, false);
  assert.throws(() => sender.send([file]), /don't have access to add documents to the library/);
  // Documents' own setting for where the library is wins; demo mode never writes to the real library
  fs.mkdirSync(path.join(appData, 'Desk Assistant', 'data'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Desk Assistant', 'data', 'documents.json'), JSON.stringify({ root: '\\\\127.0.0.1\\riyeser-test-missing' }));
  assert.match(createSender({ appData, documentsDir: docsDir }).target().reason, /Can't reach the shared library at \\\\127.0.0.1/);
  assert.match(createSender({ appData, documentsDir: docsDir, isDemo: () => true }).target().reason, /demo mode/);
  assert.ok(access.can);
});

test('Print to PDF inbox: a PDF saved into the folder opens once it has finished being written', async () => {
  const { watchInbox } = require('../src/pdf/inbox');
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'already-there.pdf'), '%PDF-1.4 old');
  const opened = [];
  const w = watchInbox(dir, (f) => opened.push(path.basename(f)), { settleMs: 60, pollMs: 80 });
  fs.writeFileSync(path.join(dir, 'Printed from Word.pdf'), '%PDF-1.4 new');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a pdf');
  for (let i = 0; i < 40 && !opened.length; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  w.stop();
  assert.deepStrictEqual(opened, ['Printed from Word.pdf']);
});
