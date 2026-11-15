const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classify } = require('../src/core/classifier');
const { extractActionItems } = require('../src/core/actions');
const { planOrganise, applyPlan, undoBatch, findDuplicates } = require('../src/core/organizer');
const { Index } = require('../src/core/indexer');
const { Store } = require('../src/core/store');
const { upcomingMeetings, companiesInMeeting } = require('../src/core/calendar');
const { categorise } = require('../src/core/email');

const settings = {
  ownCompanyNames: ['Riki Consulting Ltd'],
  companies: [{ name: 'Acme Plumbing', aliases: ['acme'], type: 'Clients' }, { name: 'Spark', aliases: [], type: 'Utilities' }],
};

test('classifies an invoice for a known company', () => {
  const c = classify({ fileName: 'INV-0042.pdf', ext: '.pdf', text: 'TAX INVOICE\nRiki Consulting Ltd\nBill To: Acme Plumbing\nInvoice Number 42\nAmount Due $1,200\nDue Date 20 Nov' }, settings);
  assert.equal(c.docType, 'Invoices');
  assert.equal(c.company, 'Acme Plumbing');
  assert.equal(c.companyType, 'Clients');
  assert.equal(c.confidence, 'high');
});

test('detects an unknown company from a legal suffix and ignores own company', () => {
  const c = classify({ fileName: 'scan001.pdf', ext: '.pdf', text: 'Riki Consulting Ltd\nService Agreement between the parties\nGreen Leaf Landscaping Limited and Riki Consulting Ltd hereby agree' }, settings);
  assert.equal(c.docType, 'Contracts');
  assert.equal(c.company, 'Green Leaf Landscaping Limited');
});

test('photos are tidied by kind', () => {
  const c = classify({ fileName: 'IMG_2231.HEIC', ext: '.heic', text: '' }, settings);
  assert.equal(c.category, 'Media');
  assert.equal(c.docType, 'Images');
});

test('extracts action items', () => {
  const items = extractActionItems('Notes\n- [ ] Send revised quote to Acme by Friday\nAction: Riki to review contract\nrandom line\nCan you please sign the NDA asap');
  assert.equal(items.length, 3);
  assert.equal(items[0].due, 'Friday');
  assert.ok(items[2].urgent);
});

test('plans, applies and undoes moves', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const inbox = path.join(tmp, 'Downloads'); fs.mkdirSync(inbox);
  const root = path.join(tmp, 'Organised');
  fs.writeFileSync(path.join(inbox, 'acme invoice march.txt'), 'Invoice for Acme Plumbing. Amount due $300');
  fs.writeFileSync(path.join(inbox, 'holiday.jpg'), 'x');
  fs.writeFileSync(path.join(inbox, 'random.txt'), 'hello world');
  const { plan, review } = await planOrganise({ ...settings, watchFolders: [inbox], organisedRoot: root }, { minAgeMs: 0 });
  assert.equal(plan.length, 2);
  assert.equal(review.length, 1);
  const inv = plan.find((p) => p.name.startsWith('acme'));
  assert.equal(inv.to, path.join(root, 'Clients', 'Acme Plumbing', 'Invoices', 'acme invoice march.txt'));
  const batch = applyPlan(plan);
  assert.equal(batch.moves.length, 2);
  assert.ok(fs.existsSync(inv.to));
  undoBatch(batch);
  assert.ok(fs.existsSync(path.join(inbox, 'acme invoice march.txt')));
  fs.writeFileSync(path.join(inbox, 'a.bin'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(inbox, 'b.bin'), Buffer.alloc(4096, 1));
  assert.equal(findDuplicates([inbox]).length, 1);
});

test('search finds by content and name', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  fs.writeFileSync(path.join(tmp, 'contract-final.txt'), 'Agreement with Acme Plumbing for drain works in Henderson');
  fs.writeFileSync(path.join(tmp, 'shopping.txt'), 'milk eggs');
  const idx = new Index(new Store(path.join(tmp, 'data')));
  await idx.rebuild([tmp], settings);
  assert.equal(idx.search('henderson')[0].name, 'contract-final.txt');
  assert.equal(idx.search('contract acme')[0].name, 'contract-final.txt');
  assert.equal(idx.search('nothing-here').length, 0);
});

test('reads calendar with recurring events and links companies', async () => {
  const now = new Date('2026-11-16T08:00:00Z');
  const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:1\nDTSTART:20261116T100000Z\nDTEND:20261116T110000Z\nSUMMARY:Catch-up with Acme\nDESCRIPTION:Agenda\\n- [ ] Bring signed contract\\nhttps://zoom.us/j/123\nEND:VEVENT\nBEGIN:VEVENT\nUID:2\nDTSTART:20261102T090000Z\nDTEND:20261102T093000Z\nRRULE:FREQ=WEEKLY\nSUMMARY:Weekly standup\nEND:VEVENT\nEND:VCALENDAR`;
  const { meetings } = await upcomingMeetings([{ text: ics }], { now, days: 8 });
  assert.equal(meetings.filter((m) => m.title === 'Weekly standup').length, 2);
  const acme = meetings.find((m) => m.title.includes('Acme'));
  assert.equal(acme.actionItems[0].text, 'Bring signed contract');
  assert.ok(acme.link.includes('zoom.us'));
  assert.equal(companiesInMeeting(acme, settings.companies)[0].name, 'Acme Plumbing');
});

test('email sorting', () => {
  const inv = categorise({ subject: 'Invoice INV-77 from Spark', from: 'billing@spark.co.nz', text: 'Your invoice. Amount due $90. Due date 1 Dec' }, settings);
  assert.equal(inv.category, 'Invoices & Bills');
  assert.equal(inv.company, 'Spark');
  const ask = categorise({ subject: 'Quick question', from: 'jo@acme.co.nz', text: 'Can you send the plans by Friday?' }, settings);
  assert.ok(ask.needsReply);
  const news = categorise({ subject: 'Big sale!', from: 'news@shop.com', text: 'Deals. Unsubscribe here', listUnsubscribe: 'x' }, settings);
  assert.equal(news.category, 'Newsletters & Promotions');
  assert.ok(!news.needsReply);
});

test('extracts text from PDF and Word files', async () => {
  const { extractText } = require('../src/core/extract');
  const pdfText = await extractText(path.join(__dirname, 'fixtures', 'Statement_Nov2026.pdf'));
  assert.match(pdfText, /ASB Bank Limited/);
  const c = classify({ fileName: 'Statement_Nov2026.pdf', ext: '.pdf', text: pdfText }, settings);
  assert.equal(c.docType, 'Statements');
  assert.equal(c.company, 'ASB Bank Limited');
  const docx = await extractText(path.join(__dirname, 'fixtures', 'acme-bathroom-quote.docx'));
  assert.equal(classify({ fileName: 'acme-bathroom-quote.docx', ext: '.docx', text: docx }, settings).docType, 'Quotes');
});

test('reads date, reference and amount and suggests a clean name', () => {
  const { extractDetails, suggestName, typeMismatch } = require('../src/core/details');
  const text = 'TAX INVOICE\nBill To: Acme Plumbing\nInvoice Number: INV-1042\nInvoice Date: 03/11/2026\nDue Date: 20/11/2026\nTotal due $1,200.00';
  const d = extractDetails(text, 'scan0042.pdf');
  assert.deepEqual(d, { date: '2026-11-03', reference: 'INV-1042', amount: '$1,200.00' });
  assert.equal(extractDetails('Invoice Date: 03/11/2026', 'x', { dayFirst: false }).date, '2026-03-11');
  const c = classify({ fileName: 'scan0042.pdf', ext: '.pdf', text }, settings);
  assert.equal(suggestName({ fileName: 'scan0042.pdf', ext: '.pdf', classification: c, details: d }), '2026-11-03 Acme Plumbing Invoice INV-1042.pdf');
  assert.equal(suggestName({ fileName: 'IMG_1.jpg', ext: '.jpg', classification: { category: 'Media', docType: 'Images' }, details: {} }), null);
  assert.match(typeMismatch('invoice-acme.pdf', 'QUOTATION\nThis quote is valid until 30 Dec. Estimate for works. Quote number 5'), /contents read like Quote/);
  assert.equal(typeMismatch('acme-invoice.pdf', text), null);
});

test('organise plan renames, groups by year and flags mismatches', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const inbox = path.join(tmp, 'Downloads'); fs.mkdirSync(inbox);
  const root = path.join(tmp, 'Organised');
  fs.writeFileSync(path.join(inbox, 'scan0042.txt'), 'TAX INVOICE\nBill To: Acme Plumbing\nInvoice Number: INV-1042\nInvoice Date: 03/11/2026\nTotal due $1,200.00');
  fs.writeFileSync(path.join(inbox, 'acme invoice.txt'), 'QUOTATION for Acme Plumbing. This quote is valid until 30 Dec 2026. Estimate total $8,400.00. Quote number QU-77');
  const { plan } = await planOrganise({ ...settings, watchFolders: [inbox], organisedRoot: root, groupByYear: true }, { minAgeMs: 0 });
  const inv = plan.find((p) => p.name === 'scan0042.txt');
  assert.equal(inv.to, path.join(root, 'Clients', 'Acme Plumbing', 'Invoices', '2026', '2026-11-03 Acme Plumbing Invoice INV-1042.txt'));
  const q = plan.find((p) => p.name === 'acme invoice.txt');
  assert.equal(q.docType, 'Quotes');
  assert.match(q.warning, /Quote/);
  assert.match(q.newName, /Acme Plumbing Quote QU-77\.txt$/);
});

test('does not mistake "Nov2026" or expiry dates for document facts', () => {
  const { extractDetails } = require('../src/core/details');
  assert.equal(extractDetails('ASB Bank Statement', 'Statement Nov2026.pdf').reference, null);
  assert.equal(extractDetails('Quote. Valid until 30 Dec 2026.', 'q.docx').date, null);
  assert.equal(extractDetails('Invoice No. 553 Due date 20/11/2026 Date 01/11/2026', 'x').date, '2026-11-01');
});

test('re-check suggests fixes for already-filed items and leaves good ones alone', async () => {
  const { planRecheck, removeEmptyDirs } = require('../src/core/organizer');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const root = path.join(tmp, 'Organised');
  const wrong = path.join(root, 'Companies', 'Acme Plumbing', 'Invoices'); fs.mkdirSync(wrong, { recursive: true });
  fs.writeFileSync(path.join(wrong, 'scan0042.txt'), 'TAX INVOICE\nBill To: Acme Plumbing\nInvoice Number: INV-1042\nInvoice Date: 03/11/2026\nTotal due $1,200.00');
  const good = path.join(root, 'Clients', 'Acme Plumbing', 'Invoices'); fs.mkdirSync(good, { recursive: true });
  fs.writeFileSync(path.join(good, '2026-10-01 Acme Plumbing Invoice INV-1000.txt'), 'TAX INVOICE\nBill To: Acme Plumbing\nInvoice Number: INV-1000\nInvoice Date: 01/10/2026');
  const mine = path.join(root, 'My stuff'); fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, 'ideas.txt'), 'random thoughts');
  const { plan, scanned } = await planRecheck({ ...settings, organisedRoot: root });
  assert.equal(scanned, 3);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].to, path.join(root, 'Clients', 'Acme Plumbing', 'Invoices', '2026-11-03 Acme Plumbing Invoice INV-1042.txt'));
  assert.equal(plan[0].change, 'move + rename');
  applyPlan(plan);
  removeEmptyDirs(root);
  assert.ok(!fs.existsSync(path.join(root, 'Companies')));
  assert.ok(fs.existsSync(path.join(mine, 'ideas.txt')));
});

test('downloads clean-up sorts items into delete / review / keep', async () => {
  const { analyseFolder } = require('../src/core/cleanup');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const dl = path.join(tmp, 'Downloads'); fs.mkdirSync(dl);
  const root = path.join(tmp, 'Organised'); fs.mkdirSync(root);
  // Pretend "now" is 200 days in the future; files written today are therefore 200 days old.
  const now = Date.now() + 200 * 86400_000;
  const mk = (name, body, isOld = true) => {
    const f = path.join(dl, name); fs.writeFileSync(f, body);
    if (!isOld) { const t = new Date(now - 86400_000); fs.utimesSync(f, t, t); }
    return f;
  };
  mk('ChromeSetup.exe', 'x'.repeat(5000));
  mk('photos.zip', 'zipdata'); fs.mkdirSync(path.join(dl, 'photos'));
  mk('movie.mp4.crdownload', 'partial');
  fs.writeFileSync(path.join(root, 'filed.pdf'), 'SAME CONTENT'); mk('filed (1).pdf', 'SAME CONTENT');
  mk('old-meme.png', 'png');
  mk('acme invoice.txt', 'Invoice for Acme Plumbing. Invoice number 77. Amount due $300');
  mk('new-thing.txt', 'hello', false);
  const items = await analyseFolder(dl, { organisedRoot: root, staleDays: 90, settings, now });
  const v = Object.fromEntries(items.map((i) => [i.name, i.verdict]));
  assert.equal(v['ChromeSetup.exe'], 'delete');
  assert.equal(v['photos.zip'], 'delete');
  assert.equal(v['movie.mp4.crdownload'], 'delete');
  assert.equal(v['filed (1).pdf'], 'delete');
  assert.equal(v['old-meme.png'], 'review');
  assert.equal(v['acme invoice.txt'], 'keep');
  assert.equal(v['new-thing.txt'], 'keep');
});

test('finds related documents by reference, address or project', () => {
  const { extractKeys, linkRelated } = require('../src/core/related');
  const k = extractKeys('Quote QU-0077 for works at 12 Smith Street, Henderson\nProject: Bathroom renovation');
  assert.deepEqual(k.map((x) => x.key).sort(), ['addr:12 smith st', 'proj:bathroom renovation', 'ref:QU0077']);
  const items = [
    { name: 'quote', company: 'Acme Plumbing', keys: extractKeys('Quote QU-0077. Site: 12 Smith Street') },
    { name: 'invoice', company: 'Acme Plumbing', keys: extractKeys('Invoice INV-1042. As per quote QU-0077') },
    { name: 'receipt', company: null, keys: extractKeys('Payment received for invoice INV-1042, thank you') },
    { name: 'other', company: 'Acme Plumbing', keys: extractKeys('Invoice INV-2000 for 99 Other Road') },
    { name: 'spark', company: 'Spark', keys: extractKeys('Invoice INV-1042 electricity') },
  ];
  linkRelated(items);
  const [q, inv, rec, other, spark] = items;
  assert.equal(q.group.size, 3);
  assert.equal(q.group.name, '12 Smith Street');
  assert.equal(inv.group.name, '12 Smith Street');
  assert.equal(rec.group.name, '12 Smith Street');
  assert.equal(rec.company, 'Acme Plumbing'); // picked up from the group
  assert.equal(other.group, undefined);
  assert.equal(spark.group, undefined);       // different company, never joined
});

test('desktop clean-up: ticked sub-folders, related project folder, empty folders removed', async () => {
  const { planOrganise, scanFolders, removeEmptyDirs } = require('../src/core/organizer');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const desk = path.join(tmp, 'Desktop'); const root = path.join(tmp, 'Organised');
  const old = path.join(desk, 'Old stuff', 'more'); fs.mkdirSync(old, { recursive: true });
  const keep = path.join(desk, 'Keep me'); fs.mkdirSync(keep);
  fs.writeFileSync(path.join(desk, 'quote.txt'), 'QUOTATION for Acme Plumbing\nQuote number QU-0077\nDate: 1 October 2026\nSite: 12 Smith Street\nEstimate total $8,400.00');
  fs.writeFileSync(path.join(old, 'inv.txt'), 'TAX INVOICE\nBill To: Acme Plumbing\nInvoice Number: INV-1042\nInvoice Date: 03/11/2026\nRe quote QU-0077, 12 Smith Street\nTotal due $8,400.00');
  fs.writeFileSync(path.join(desk, 'Old stuff', 'paid.txt'), 'Receipt\nPayment received for invoice INV-1042\nDate: 10/11/2026\nThank you for your purchase');
  fs.writeFileSync(path.join(keep, 'acme invoice.txt'), 'Invoice for Acme Plumbing INV-1042');
  const settings2 = { ...settings, watchFolders: [desk], organisedRoot: root, scanSelection: { [path.join(desk, 'Old stuff')]: true } };
  const folders = scanFolders(settings2);
  assert.deepEqual(folders.map((f) => [f.name, f.checked]).sort(), [['Desktop', true], ['Keep me', false], ['Old stuff', true]]);
  const { plan, emptyFolderCleanup } = await planOrganise(settings2, { minAgeMs: 0 });
  const project = path.join(root, 'Clients', 'Acme Plumbing', 'Projects', '12 Smith Street');
  assert.equal(plan.length, 3);
  for (const p of plan) assert.equal(path.dirname(p.to), project);
  assert.ok(plan.find((p) => p.name === 'paid.txt').to.endsWith('2026-11-10 Acme Plumbing Receipt INV-1042.txt'));
  assert.ok(!plan.some((p) => p.from.startsWith(keep)));
  applyPlan(plan);
  for (const sub of emptyFolderCleanup) removeEmptyDirs(sub, { includeRoot: true });
  assert.ok(!fs.existsSync(path.join(desk, 'Old stuff')));
  assert.ok(fs.existsSync(path.join(keep, 'acme invoice.txt')));
});

test('address reading is not fooled by reference numbers', () => {
  const { extractKeys } = require('../src/core/related');
  const addr = (t) => extractKeys(t).filter((k) => k.key.startsWith('addr:')).map((k) => k.label);
  assert.deepEqual(addr('As per quote QU-0077 - 12 Smith Street'), ['12 Smith Street']);
  assert.deepEqual(addr('Site: 2/14 Queen St, Auckland'), ['2/14 Queen St']);
});

test('scanned PDFs are read with OCR and then sorted like any other document', async () => {
  const ex = require('../src/core/extract');
  const ocr = require('../src/core/ocr');
  const scan = path.join(__dirname, 'fixtures', 'scanned-invoice.pdf');
  ex.setOcrProvider(null);
  assert.equal((await ex.extractText(scan)).trim(), ''); // just a picture
  let asked = 0;
  ex.setOcrProvider({ pdf: async () => { asked++; return 'TAX INVOICE\nBill To: Acme Plumbing\nInvoice Number: INV-2050\nInvoice Date: 05/11/2026'; } });
  const text = await ex.extractText(scan);
  assert.equal(asked, 1);
  const c = classify({ fileName: 'scanned-invoice.pdf', ext: '.pdf', text }, settings);
  assert.equal(c.docType, 'Invoices');
  assert.equal(c.company, 'Acme Plumbing');
  // a normal PDF with real text never goes to OCR
  await ex.extractText(path.join(__dirname, 'fixtures', 'Statement_Nov2026.pdf'));
  assert.equal(asked, 1);
  ex.setOcrProvider(null);
  // the OCR engine itself reads a real scan image
  const img = fs.readFileSync(path.join(__dirname, 'fixtures', 'scan.jpg'));
  const r = await ocr.recognize(img);
  assert.match(r.text, /INV-2050/);
  assert.ok(r.lines.length >= 5);
});
