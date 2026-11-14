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
