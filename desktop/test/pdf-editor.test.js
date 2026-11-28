// Riyeser PDF: S41 (passwords), S42 (edited words really gone), S46 (any language), S47 (no doubled text), M15, M16.
// The editor's saving code (src/renderer/pdf-tools.mjs) runs here with the same PDF library the editor loads
// (@cantoo/pdf-lib) and pdf.js reads the results back, as any PDF reader would.
require('regenerator-runtime/runtime');   // fontkit's Indic (Hindi) shaping needs it; the editor loads it too
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { pathToFileURL } = require('url');
const L = require('@cantoo/pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { findFont } = require('../src/core/pdf-fonts');

const tools = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'pdf-tools.mjs')).href);
const pdfjs = () => import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
async function texts(bytes, password) {
  const { getDocument } = await pdfjs();
  const d = await getDocument({ data: new Uint8Array(bytes), password, verbosity: 0 }).promise; const out = [];
  for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).filter((s) => s.trim()).join(' '));
  await d.destroy();
  return out;
}
async function invoice() {
  const d = await L.PDFDocument.create(); const f = await d.embedFont(L.StandardFonts.Helvetica); const p = d.addPage([595, 842]);
  p.drawText('Invoice total: $1,000.00', { x: 50, y: 700, size: 14, font: f });
  p.drawText('Thank you', { x: 50, y: 600, size: 14, font: f });
  return { bytes: await d.save(), prefix: f.widthOfTextAtSize('Invoice total: ', 14) };
}

test('S42: words replaced with Edit text are taken out of the page; the rest stays where it was', async () => {
  const T = await tools(); const { bytes } = await invoice();
  // the editor covers the whole replaced line (the pdf.js text item) and draws the new words over it
  const doc = await L.PDFDocument.load(bytes);
  const r = T.removeTextInBoxes(L, doc, 0, [{ x0: 49, y0: 695, x1: 230, y1: 717 }]);
  assert.ok(r.removed >= 20); assert.strictEqual(r.guessed, false);
  const f = await doc.embedFont(L.StandardFonts.Helvetica);
  doc.getPage(0).drawText('Invoice total: $900.00', { x: 50, y: 700, size: 14, font: f });
  const t = (await texts(await doc.save()))[0];
  assert.doesNotMatch(t, /1,000/); assert.match(t, /\$900\.00/); assert.match(t, /Thank you/);
});
test('S42: only the letters inside the box go; the words before them keep their place', async () => {
  const T = await tools(); const { bytes, prefix } = await invoice();
  const doc = await L.PDFDocument.load(bytes);
  T.removeTextInBoxes(L, doc, 0, [{ x0: 50 + prefix - 1, y0: 695, x1: 300, y1: 715 }]);
  const { getDocument } = await pdfjs();
  const d = await getDocument({ data: await doc.save(), verbosity: 0 }).promise;
  const items = (await (await d.getPage(1)).getTextContent()).items.filter((i) => i.str.trim());
  assert.deepStrictEqual(items.map((i) => i.str), ['Invoice total:', 'Thank you']);
  assert.deepStrictEqual(items.map((i) => [Math.round(i.transform[4]), Math.round(i.transform[5])]), [[50, 700], [50, 600]]);
});

test('S46: names in Vietnamese, Fijian, Hindi and Chinese save (added text and a form field) and read back', async (t) => {
  const T = await tools();
  const d = await L.PDFDocument.create(); const p = d.addPage([595, 842]);
  const fld = d.getForm().createTextField('name'); fld.addToPage(p, { x: 50, y: 100, width: 300, height: 24 });
  const fontFor = T.fontChooser(L, d, fontkit, async (script) => { const f = findFont(script); return f && f.bytes; });
  const names = { vietnamese: 'Mary Nguyễn', fijian: 'Mereani Tuimabā', hindi: 'सीता देवी', chinese: '李小龙' };
  const written = {};
  let y = 700;
  for (const [lang, n] of Object.entries(names)) {
    const { font, missing } = await fontFor(n);
    if (missing) { t.diagnostic(`no ${lang} font on this PC (${T.scriptOf(n)}): skipped`); continue; }
    p.drawText(n, { x: 50, y, size: 14, font }); y -= 40; written[lang] = n;
  }
  assert.ok(written.vietnamese && written.fijian, 'Latin letters with accents always have a font');
  await T.fillForm(L, d, [{ name: 'name', kind: 'text', value: 'Mary Nguyễn' }], fontFor);
  const bytes = await d.save();   // "WinAnsi cannot encode" used to stop the whole save here
  const text = (await texts(bytes))[0];
  for (const n of Object.values(written)) assert.ok(text.includes(n), `${n} in ${text}`);
  assert.strictEqual((await L.PDFDocument.load(bytes)).getForm().getTextField('name').getText(), 'Mary Nguyễn');
  // plain text still uses the standard font (nothing extra in the file)
  assert.strictEqual(T.winAnsiOk('Café – €5'), true); assert.strictEqual(T.winAnsiOk('Nguyễn'), false);
  assert.deepStrictEqual(['latin', 'devanagari', 'cjk'].map((s) => T.scriptOf({ latin: 'ā', devanagari: 'सी', cjk: '李' }[s])), ['latin', 'devanagari', 'cjk']);
});

test('S41: a password-protected PDF opens with its password and is saved protected; "Password…" protects a new one', async () => {
  const d = await L.PDFDocument.create(); d.addPage().drawText('Net pay $1,040.00');
  d.encrypt({ userPassword: 'secret1', ownerPassword: 'secret1' });
  const locked = await d.save();
  await assert.rejects(L.PDFDocument.load(locked), /encrypted/i);
  await assert.rejects(texts(locked), /password/i);
  const doc = await L.PDFDocument.load(locked, { password: 'secret1' });   // what the editor does after asking
  doc.getPage(0).drawText('Checked', { y: 500 });
  doc.encrypt({ userPassword: 'secret1', ownerPassword: 'secret1' });
  const saved = await doc.save();
  assert.match((await texts(saved, 'secret1'))[0], /Net pay.*Checked|Checked.*Net pay/);
  await assert.rejects(texts(saved), /password/i);
  const e = src('renderer/editor.js');
  assert.match(e, /askPassword\(/); assert.match(e, /PDFDocument\.load\(bytes, \{ password: st\.password/);
  assert.match(e, /async protect\(\)/); assert.match(src('renderer/editor.html'), /data-cmd="protect"/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'vendor.js'), 'utf8'), /@cantoo\/pdf-lib\/dist\/pdf-lib\.min\.js/);
});

test('S41/S42: pages can be reordered and dropped (this PDF library deletes removed pages, so the page tree is set directly)', async () => {
  const T = await tools();
  const d = await L.PDFDocument.create(); for (const t of ['one', 'two', 'three']) d.addPage().drawText(t);
  const x = await L.PDFDocument.load(await d.save());
  const p = x.getPages(); T.setPageOrder(L, x, [p[2], p[0]]);
  assert.deepStrictEqual(await texts(await x.save()), ['three', 'one']);
  assert.doesNotMatch(src('renderer/editor.js'), /doc\.removePage\(i\);\s*\n\s*for \(const entry of orderList\)/);
});

test('S47: Recognise text checks every page\'s own text first, not just the pages shown', async () => {
  const T = await tools(); const { getDocument } = await pdfjs();
  const d = await L.PDFDocument.create(); d.addPage(); for (const t of ['Page two words', 'Page three words']) d.addPage().drawText(t);
  const pd = await getDocument({ data: await d.save(), verbosity: 0 }).promise;
  assert.deepStrictEqual(await Promise.all([1, 2, 3].map(async (i) => T.pageHasText(await pd.getPage(i)))), [false, true, true]);
  const e = src('renderer/editor.js');
  const body = e.slice(e.indexOf('async function recognisePages'), e.indexOf('const todo', e.indexOf('async function recognisePages')));
  assert.match(body, /for \(const o of st\.order\)/); assert.match(body, /T\.pageHasText/);
});

test('M16: a damaged file says "This file looks damaged or incomplete. Try downloading it again."', async () => {
  const T = await tools(); const { getDocument } = await pdfjs(); const { bytes } = await invoice();
  let err; try { await getDocument({ data: bytes.slice(0, 200), verbosity: 0 }).promise; } catch (e) { err = e; }
  assert.ok(err, 'pdf.js refuses the cut-off file');
  assert.strictEqual(T.openErrorMessage(err), 'This file looks damaged or incomplete. Try downloading it again.');
  assert.strictEqual(T.openErrorMessage({ name: 'PasswordException', message: 'No password given' }), 'password');
  assert.match(src('renderer/editor.js'), /if \(plain && plain !== 'password'\) \{ toast\(plain\); return; \}/);
});

test('M15: Redact says the page becomes a picture, and offers Recognise text after saving', () => {
  const e = src('renderer/editor.js');
  assert.match(e, /that page becomes a picture \(its other words can\\'t be searched or copied, and the file gets bigger\)\. Its document properties \(title, author, subject, keywords\) are cleared too\. Use Recognise text afterwards/);
  assert.match(e, /now a picture, so its words can't be searched or copied\. <button class="primary" data-cmd="ocr">Recognise text<\/button>/);
});

test('QA PDF-RED-02: redacting clears the document properties and XMP metadata, which can repeat the hidden details', async () => {
  const T = await tools();
  const d = await L.PDFDocument.create(); d.addPage([595, 842]);
  d.setTitle('Payslip Jo Sample'); d.setAuthor('HR'); d.setSubject('ACCT 12-3456-7890'); d.setKeywords(['tfn 123 456 789']);
  d.catalog.set(L.PDFName.of('Metadata'), d.context.register(d.context.stream('<x:xmpmeta>ACCT 12-3456-7890</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));
  T.clearDocInfo(L, d);
  const out = await L.PDFDocument.load(await d.save({ useObjectStreams: false }), { updateMetadata: false });
  assert.strictEqual(out.getTitle(), undefined); assert.strictEqual(out.getAuthor(), undefined);
  assert.strictEqual(out.getSubject(), undefined); assert.strictEqual(out.getKeywords(), undefined);
  assert.strictEqual(out.catalog.get(L.PDFName.of('Metadata')), undefined);
  // the editor uses it for redacted files, before removeUnused() drops the unlinked XMP stream
  const e = src('renderer/editor.js');
  assert.match(e, /st\.lastRedacted = orderList\.some\(\(e\) => \(st\.anns\[e\.src\] \|\| \[\]\)\.some\(\(a\) => a\.type === 'redact'\)\);\n  if \(st\.lastRedacted\) T\.clearDocInfo\(window\.PDFLib, doc\);\n  removeUnused\(doc\);/);
});
