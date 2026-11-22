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
  filingLayout: 'company', // the older Company › Type layout (Type › Year is tested separately)
  ownCompanyNames: ['Riki Consulting Ltd'],
  companies: [{ name: 'Acme Plumbing', aliases: ['acme'], type: 'Clients' }, { name: 'Helm', aliases: [], type: 'Utilities' }],
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
  // "sort everything" (default): the unidentifiable file still gets a tidy home
  const all = await planOrganise({ ...settings, watchFolders: [inbox], organisedRoot: root }, { minAgeMs: 0 });
  assert.equal(all.plan.length, 3);
  assert.equal(all.review.length, 0);
  assert.equal(all.plan.find((p) => p.name === 'random.txt').to, path.join(root, 'Other', 'Text files', 'random.txt'));
  // with it switched off, unsure files wait for you instead
  const { plan, review } = await planOrganise({ ...settings, watchFolders: [inbox], organisedRoot: root, sortEverything: false }, { minAgeMs: 0 });
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
  assert.equal((await findDuplicates([inbox])).length, 1);
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
  const inv = categorise({ subject: 'Invoice INV-77 from Helm', from: 'billing@spark.co.nz', text: 'Your invoice. Amount due $90. Due date 1 Dec' }, settings);
  assert.equal(inv.category, 'Invoices & Bills');
  assert.equal(inv.company, 'Helm');
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
  assert.deepEqual(d, { date: '2026-11-03', month: '2026-11', reference: 'INV-1042', amount: '$1,200.00' });
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
    { name: 'spark', company: 'Helm', keys: extractKeys('Invoice INV-1042 electricity') },
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

test('never tidies the home folder or a whole drive', () => {
  const { scanFolders } = require('../src/core/organizer');
  const list = scanFolders({ watchFolders: [os.homedir(), path.parse(process.cwd()).root], organisedRoot: '/nowhere' });
  assert.equal(list.length, 0);
});

test('desktop folders: leave, sort inside, or move the whole folder (under the company if it is theirs)', async () => {
  const { planOrganise, scanFolders, undoBatch } = require('../src/core/organizer');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const desk = path.join(tmp, 'Desktop'); const root = path.join(tmp, 'Organised');
  const job = path.join(desk, 'Acme job'); fs.mkdirSync(path.join(job, 'photos'), { recursive: true });
  fs.writeFileSync(path.join(job, 'quote.txt'), 'Quote for Acme Plumbing QU-1');
  fs.writeFileSync(path.join(job, 'invoice.txt'), 'Invoice for Acme Plumbing INV-2 amount due $5');
  fs.writeFileSync(path.join(job, 'photos', 'site.jpg'), 'x');
  const misc = path.join(desk, 'Holiday ideas'); fs.mkdirSync(misc); fs.writeFileSync(path.join(misc, 'list.txt'), 'beach');
  const keep = path.join(desk, 'Current work'); fs.mkdirSync(keep); fs.writeFileSync(path.join(keep, 'draft.txt'), 'wip');
  const s2 = { ...settings, watchFolders: [desk], organisedRoot: root, scanSelection: { [desk]: true, [job]: 'move', [misc]: 'move', [keep]: 'leave' } };
  assert.deepEqual(scanFolders(s2).filter((f) => !f.isRoot).map((f) => [f.name, f.mode]).sort(), [['Acme job', 'move'], ['Current work', 'leave'], ['Holiday ideas', 'move']]);
  const { plan } = await planOrganise(s2, { minAgeMs: 0 });
  const folderItems = plan.filter((p) => p.isFolder);
  assert.equal(folderItems.length, 2);
  assert.equal(folderItems.find((p) => p.name === 'Acme job').to, path.join(root, 'Clients', 'Acme Plumbing', 'Acme job'));
  assert.equal(folderItems.find((p) => p.name === 'Holiday ideas').to, path.join(root, 'Folders', 'Holiday ideas'));
  assert.ok(!plan.some((p) => p.from.startsWith(keep)));
  const batch = applyPlan(folderItems);
  assert.ok(fs.existsSync(path.join(root, 'Clients', 'Acme Plumbing', 'Acme job', 'photos', 'site.jpg')));
  assert.ok(!fs.existsSync(job));
  undoBatch(batch);
  assert.ok(fs.existsSync(path.join(job, 'photos', 'site.jpg')));
});

test('safety: never touches system folders, system files or shortcuts', async () => {
  const safety = require('../src/core/safety');
  const { scanFolders, listFiles } = require('../src/core/organizer');
  const { analyseFolder } = require('../src/core/cleanup');
  // system folders and whole drives / the user folder
  const win = process.platform === 'win32';
  const sys = win ? ['C:\\Windows', 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'C:\\Program Files\\App', path.join(os.homedir(), 'AppData', 'Roaming', 'x')]
    : ['/etc', '/etc/hosts', '/usr/lib', path.join(os.homedir(), '.config', 'x')];
  const [sysA, , sysB] = sys;
  for (const p of sys) assert.ok(safety.isSystemPath(p), p);
  assert.ok(safety.isTooBroad(os.homedir()));
  assert.ok(safety.isTooBroad(win ? 'C:\\' : '/'));
  assert.match(safety.folderProblem(sysB), /Windows or program folder/);
  assert.equal(safety.folderProblem(path.join(os.tmpdir(), 'Desktop')), null);
  // protected file types
  for (const f of ['desktop.ini', 'Thumbs.db', 'Google Chrome.lnk', 'Website.url', '.hidden', '~$draft.docx', 'driver.sys', 'thing.dll']) assert.ok(safety.isProtectedFile(path.join(os.tmpdir(), f)), f);
  assert.ok(!safety.isProtectedFile(path.join(os.tmpdir(), 'invoice.pdf')));
  // a Desktop full of shortcuts and system files: only the personal file is offered for sorting
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const desk = path.join(tmp, 'Desktop'); fs.mkdirSync(desk);
  for (const f of ['desktop.ini', 'Google Chrome.lnk', 'Bank login.url', 'helper.dll', 'invoice.txt']) fs.writeFileSync(path.join(desk, f), 'x');
  assert.deepEqual(listFiles(desk).map((f) => path.basename(f)), ['invoice.txt']);
  // system folders can't be tidied or cleaned up even if they end up in the settings
  assert.equal(scanFolders({ watchFolders: [sysB, sysA, desk], organisedRoot: path.join(tmp, 'Organised') }).filter((f) => f.isRoot).length, 1);
  assert.deepEqual(await analyseFolder(sysA, {}), []);
  // and the final check before moving refuses protected files
  const batch = applyPlan([{ from: path.join(desk, 'helper.dll'), to: path.join(tmp, 'Organised', 'helper.dll') }, { from: path.join(desk, 'invoice.txt'), to: path.join(tmp, 'Organised', 'invoice.txt') }]);
  assert.equal(batch.moves.length, 1);
  assert.match(batch.errors[0].error, /protected/);
  assert.ok(fs.existsSync(path.join(desk, 'helper.dll')));
});

test('tidy everything: files all personal folders by company/type/year, keeps program folders and never-touch folders', async () => {
  const { planEverything, removeEmptiedFolders } = require('../src/core/everything');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const docs = path.join(tmp, 'Documents'); const pics = path.join(tmp, 'Pictures'); const dl = path.join(tmp, 'Downloads');
  const root = path.join(docs, 'Organised');
  const old = new Date(Date.now() - 5 * 86400_000);
  const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); fs.utimesSync(p, old, old); };
  const jpeg = (p, when) => { // tiny JPEG with a "taken" date inside
    const { execFileSync } = require('child_process');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    execFileSync('python3', ['-c', `from PIL import Image\nim=Image.new('RGB',(8,8));e=im.getexif();e[0x0132]='${when}';im.save(r'''${p}''',exif=e)`]);
    fs.utimesSync(p, old, old);
  };
  put(path.join(docs, 'Elm project', 'plan.txt'), 'Brightwell Limited commissioning plan. Agreement between the parties. Date: 03/10/2026');
  put(path.join(docs, 'Elm project', 'quote.txt'), 'Quotation from Brightwell Limited. Quote number QD-552. Date: 01/09/2026');
  put(path.join(docs, 'Elm project', 'notes.txt'), 'Site notes for Brightwell job');
  for (let i = 1; i <= 4; i++) jpeg(path.join(docs, 'Smith wedding', `IMG_00${i}.jpg`), '2023:02:18 14:00:00');
  put(path.join(docs, 'New folder (3)', 'doc1.txt'), 'TAX INVOICE\nBill To: Acme Plumbing\nInvoice Number: INV-3001\nInvoice Date: 05/03/2025\nTotal due $90.00');
  put(path.join(docs, 'New folder (3)', 'shopping.txt'), 'milk and eggs');
  put(path.join(docs, 'Work', 'Acme Plumbing', 'q.txt'), 'Quote for Acme Plumbing. Quote number QU-7781. Date: 12 June 2024');
  put(path.join(docs, 'Work', 'Acme Plumbing', 'i.txt'), 'Invoice for Acme Plumbing. Invoice number INV-9001. Invoice date: 20/07/2024. Amount due $50.00');
  put(path.join(docs, 'My Games', 'Skyrim', 'save1.txt'), 'game save');
  put(path.join(docs, 'website', 'package.json'), '{}'); put(path.join(docs, 'website', 'index.html'), '<p>hi</p>');
  put(path.join(docs, 'Outlook Files', 'archive.pst'), 'pst');
  put(path.join(docs, 'Private', 'diary.txt'), 'secret');
  put(path.join(root, 'already filed.txt'), 'x');
  jpeg(path.join(pics, 'Camera Roll', 'IMG_9001.jpg'), '2022:08:01 09:30:00');
  put(path.join(dl, 'SomeTool', 'tool.exe'), 'MZ'); put(path.join(dl, 'SomeTool', 'helper.dll'), 'MZ'); put(path.join(dl, 'SomeTool', 'readme.txt'), 'tool');
  const s = { ...settings, organisedRoot: root, libraryFolders: [docs, pics, dl], neverTouch: [path.join(docs, 'Private')],
    companies: [...settings.companies, { name: 'Brightwell', aliases: ['brightwell limited'], type: 'Suppliers' }] };
  const r = await planEverything(s);
  const where = (name) => { const p = r.plan.find((x) => x.name === name); return p && path.relative(root, p.to); };
  assert.equal(where('Elm project'), path.join('Suppliers', 'Brightwell', 'Projects', 'Elm project'));
  assert.equal(where('Smith wedding'), path.join('Media', 'Images', '2023', 'Smith wedding'));
  assert.equal(where('IMG_9001.jpg'), path.join('Media', 'Images', '2022', 'IMG_9001.jpg'));
  assert.equal(where('doc1.txt'), path.join('Clients', 'Acme Plumbing', 'Invoices', '2025', '2025-03-05 Acme Plumbing Invoice INV-3001.txt'));
  assert.equal(where('shopping.txt'), path.join('Other', 'Text files', new Date(old).getFullYear().toString(), 'shopping.txt'));
  assert.ok(where('q.txt').startsWith(path.join('Clients', 'Acme Plumbing', 'Quotes', '2024')));   // "Acme Plumbing" folder is sorted, not kept whole
  assert.ok(where('i.txt').startsWith(path.join('Clients', 'Acme Plumbing', 'Invoices', '2024')));
  const keptReasons = Object.fromEntries(r.kept.map((k) => [path.basename(k.path), k.reason]));
  assert.match(keptReasons['My Games'], /program/);
  assert.match(keptReasons.website, /project/);
  assert.match(keptReasons['Outlook Files'], /program|data/);
  assert.match(keptReasons.Private, /asked/);
  assert.match(keptReasons.SomeTool, /program/);
  for (const p of r.plan) {
    assert.ok(!p.from.includes(`${path.sep}My Games`) && !p.from.includes(`${path.sep}Private`) && !p.from.includes(`${path.sep}website`) && !p.from.includes('SomeTool'), p.from);
    assert.ok(!p.from.startsWith(root), 'already-filed items are left alone');
  }
  const batch = applyPlan(r.plan);
  assert.equal(batch.errors.length, 0);
  removeEmptiedFolders(batch, r.libraries);
  assert.ok(!fs.existsSync(path.join(docs, 'New folder (3)')));
  assert.ok(!fs.existsSync(path.join(docs, 'Work')));
  assert.ok(fs.existsSync(path.join(docs, 'My Games', 'Skyrim', 'save1.txt')));
  assert.ok(fs.existsSync(pics) && fs.existsSync(docs), 'personal folders themselves are never removed');
  undoBatch(batch);
  assert.ok(fs.existsSync(path.join(docs, 'Work', 'Acme Plumbing', 'q.txt')));
});

test('learns where you file things: your folder choices and your own filing are followed for similar files', async () => {
  const { makeExample, learnedDestination } = require('../src/core/learn');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const desk = path.join(tmp, 'Desktop'); fs.mkdirSync(desk);
  const root = path.join(tmp, 'Organised');
  // 1. You once chose a folder for a timesheet...
  const chosen = path.join(root, 'Staff', 'Timesheets', '2025');
  const examples = [makeExample({ name: 'Timesheet wk45 Jo.txt', text: 'Timesheet week ending 08/11/2025 total hours 40 ordinary hours', docType: 'Timesheets', ext: '.txt' }, chosen, root, true)];
  // 2. ...and you keep the Elm comment files together in your own folder.
  const site = path.join(root, 'Site docs', 'Elm');
  for (const r of ['A', 'B']) examples.push(makeExample({ name: `Elm FHF comments rev ${r}.txt`, text: 'Brightwell commissioning plan FHF comments services coordination', company: 'Brightwell', docType: 'Commissioning', ext: '.txt' }, site, root));
  const old = new Date(Date.now() - 3 * 86400_000);
  const put = (n, body) => { fs.writeFileSync(path.join(desk, n), body); fs.utimesSync(path.join(desk, n), old, old); };
  put('Timesheet wk46 Sam.txt', 'Timesheet week ending 14/11/2026 total hours 38 ordinary hours overtime');
  put('Elm FHF comments rev C.txt', 'Brightwell Limited commissioning plan FHF comments services coordination');
  put('Acme invoice.txt', 'Invoice for Acme Plumbing. Invoice number INV-77. Amount due $10');
  const s = { ...settings, watchFolders: [desk], organisedRoot: root, groupByYear: true, companies: [...settings.companies, { name: 'Brightwell', aliases: ['brightwell limited'], type: 'Suppliers' }], _examples: examples };
  const { plan } = await planOrganise(s, { minAgeMs: 0 });
  const to = (n) => path.dirname(plan.find((p) => p.name === n).to);
  assert.equal(to('Timesheet wk46 Sam.txt'), path.join(root, 'Staff', 'Timesheets', '2026')); // same place, this year's folder
  assert.equal(to('Elm FHF comments rev C.txt'), site);
  assert.equal(to('Acme invoice.txt'), path.join(root, 'Clients', 'Acme Plumbing', 'Invoices', '2026')); // unrelated file: normal rules
  assert.match(plan.find((p) => p.name === 'Elm FHF comments rev C.txt').learned, /you keep 2 similar files here/);
  // a different company's document is never pulled into another company's folder
  const other = { name: 'Elm FHF comments.txt', company: 'Acme Plumbing', docType: 'Commissioning', ext: '.txt', nameTokens: ['elm', 'fhf', 'comments'], textTokens: ['commissioning'] };
  assert.equal(learnedDestination(other, examples.slice(1), root), null);
});

test('search matches the start of words ("elm" finds Elm, not Helm)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  fs.writeFileSync(path.join(tmp, 'Elm commissioning plan.txt'), 'commissioning');
  fs.writeFileSync(path.join(tmp, 'Helm bill.txt'), 'Helm Energy invoice');
  const idx = new Index(new Store(path.join(tmp, 'data')));
  await idx.rebuild([tmp], settings);
  assert.deepEqual(idx.search('elm').map((r) => r.name), ['Elm commissioning plan.txt']);
  assert.deepEqual(idx.search('commission').map((r) => r.name), ['Elm commissioning plan.txt']); // start of a word still works
});

test('your filing rules win, match on company/type/words/kind, and file by year', async () => {
  const rules = require('../src/core/rules');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const desk = path.join(tmp, 'Desktop'); fs.mkdirSync(desk);
  const root = path.join(tmp, 'Organised');
  const rule = rules.makeRule({ folder: path.join(root, 'Staff', 'Timesheets'), root, conditions: { docType: 'Timesheets' }, useYear: true });
  const byWords = rules.makeRule({ folder: path.join(root, 'Site docs', 'Elm'), root, conditions: { words: ['elm', 'fhf'] }, useYear: false });
  assert.equal(rules.describeDest(rule), 'Organised/Staff/Timesheets/(year)');
  const old = new Date(Date.now() - 3 * 86400_000);
  const put = (n, body) => { fs.writeFileSync(path.join(desk, n), body); fs.utimesSync(path.join(desk, n), old, old); };
  put('Book1.txt', 'Timesheet\nWeek ending 07/11/2025\nTotal hours 40');
  put('notes.txt', 'Elm project FHF comments on the commissioning plan');
  put('inv.txt', 'Invoice for Acme Plumbing. Invoice number INV-1. Amount due $5');
  const { plan } = await planOrganise({ ...settings, watchFolders: [desk], organisedRoot: root, _rules: [rule, byWords] }, { minAgeMs: 0 });
  const dir = (n) => path.dirname(plan.find((p) => p.name === n).to);
  assert.equal(dir('Book1.txt'), path.join(root, 'Staff', 'Timesheets', '2025'));   // the file's own year
  assert.equal(dir('notes.txt'), path.join(root, 'Site docs', 'Elm'));
  assert.equal(dir('inv.txt'), path.join(root, 'Clients', 'Acme Plumbing', 'Invoices')); // no rule: normal filing
  assert.match(plan.find((p) => p.name === 'Book1.txt').learned, /your rule/);
  // "elm" must match a whole word start: "Helm" doesn't count; a turned-off rule does nothing
  assert.equal(rules.ruleMatches(byWords, { name: 'Helm fhf.txt', text: '' }), false);
  assert.equal(rules.ruleMatches({ ...rule, enabled: false }, { docType: 'Timesheets' }), false);
  assert.equal(rules.kindOf('.xlsx'), 'Excel');
});

test('smart review: labels, dated names, and duplicates with different names or formats', async () => {
  const { reviewFiles } = require('../src/core/review');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const pool = path.join(tmp, 'Desktop'); fs.mkdirSync(pool);
  const org = path.join(tmp, 'Organised');
  const body = 'TAX INVOICE\nAcme Plumbing\nInvoice Number INV-1042\nInvoice Date: 3 November 2026\n' +
    Array.from({ length: 60 }, (_, i) => `Line ${i} labour and materials for the bathroom renovation at 12 Smith Street item ${i}`).join('\n') + '\nTotal $1,200.00';
  fs.writeFileSync(path.join(pool, 'scan0042.txt'), body);
  fs.writeFileSync(path.join(pool, 'scan0042 - Copy (2).txt'), body);                 // exact copy, other name
  fs.writeFileSync(path.join(pool, 'acme thing.md'), body.replace('Total $1,200.00', 'Total $1,200.00 thank you'));  // same doc, other format
  fs.writeFileSync(path.join(pool, 'notes.txt'), 'Shopping list: milk, bread');
  const old = Date.now() - 86400000; for (const f of fs.readdirSync(pool)) fs.utimesSync(path.join(pool, f), old / 1000, old / 1000);
  const r = await reviewFiles([pool], { ...settings, organisedRoot: org });
  const inv = r.plan.find((p) => p.name === 'scan0042.txt');
  assert.equal(inv.label.type, 'Invoices');
  assert.equal(inv.label.company, 'Acme Plumbing');
  assert.equal(inv.label.date, '2026-11-03');
  assert.match(inv.newName, /^2026-11-03 Acme Plumbing Invoice INV-1042/);
  assert.ok(inv.to.includes(path.join('Clients', 'Acme Plumbing')));
  assert.ok(!('_text' in inv));
  assert.equal(r.dupes.length, 1);
  const g = r.dupes[0];
  assert.equal(g.files.length, 3);
  assert.equal(g.kind, 'similar');
  const copy = g.files.find((f) => f.name.includes('Copy (2)'));
  assert.equal(copy.recommend, 'archive');
  assert.ok(g.files.some((f) => f.recommend === 'keep'));
  assert.ok(!r.dupes.some((d) => d.files.some((f) => f.name === 'notes.txt')));
});

test('a services drawing that mentions "quote" in its notes is a drawing, not a quote', () => {
  const drawing = classify({ fileName: 'Elm Mechanical Services M-201 Rev C.pdf', ext: '.pdf', text: 'MECHANICAL SERVICES\nLEVEL 1 DUCTWORK LAYOUT\nNOTES: CONTRACTOR TO INCLUDE ALL FITTINGS IN QUOTE. REFER TO QUOTATION Q-1123.\nDRAWN: JB CHECKED: RM SCALE 1:100 @ A1\nDRAWING NO: M-201 REV: C\nSTATUS: FOR CONSTRUCTION\nDO NOT SCALE' }, settings);
  assert.equal(drawing.docType, 'Plans & Drawings');
  const quote = classify({ fileName: 'Q-1123.pdf', ext: '.pdf', text: 'QUOTATION\nAcme Plumbing\nQuote number Q-1123\nSupply and install ductwork\nSubtotal $12,400.00\nTotal $14,260.00\nValid until 30/12/2026' }, settings);
  assert.equal(quote.docType, 'Quotes');
});

test('Type › Year filing with full tidy names (the default layout)', async () => {
  const { reviewFiles } = require('../src/core/review');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typeyear-'));
  const pool = path.join(tmp, 'Desktop'); fs.mkdirSync(pool);
  const org = path.join(tmp, 'Organised');
  fs.writeFileSync(path.join(pool, 'scan0042.txt'), 'TAX INVOICE\nAcme Plumbing\nInvoice Number INV-1042\nInvoice Date: 3 November 2025\nTotal $1,200.00');
  fs.writeFileSync(path.join(pool, 'Harbourview Data schematic.txt'), 'ELECTRICAL SERVICES\nDATA SCHEMATIC\nDRAWN BY AB CHECKED BY CD\nDRAWING NO E-301 REVISION B\nNOT FOR CONSTRUCTION DO NOT SCALE\nHarbourview Hotel\nDate: 6/11/2026');
  fs.writeFileSync(path.join(pool, 'random thoughts.txt'), 'hello world');
  const old = new Date('2024-05-01').getTime() / 1000; for (const f of fs.readdirSync(pool)) fs.utimesSync(path.join(pool, f), old, old);
  const s = { ...settings, filingLayout: undefined, nameStyle: 'full', organisedRoot: org };
  const r = await reviewFiles([pool], s);
  const to = (n) => path.relative(org, r.plan.find((p) => p.name === n).to);
  assert.equal(to('scan0042.txt'), path.join('Invoices', '2025', '2025-11-03 Acme Plumbing Invoice INV-1042.txt'));
  assert.match(to('Harbourview Data schematic.txt'), /^Drawings[\\/]2026[\\/]2026-11-06 .*Drawing E-301 Rev B/);
  assert.equal(path.dirname(to('random thoughts.txt')), path.join('Text files', '2024')); // unknown type: by format, by year
  // keep names
  const k = await reviewFiles([pool], { ...s, nameStyle: 'keep' });
  assert.equal(path.relative(org, k.plan.find((p) => p.name === 'scan0042.txt').to), path.join('Invoices', '2025', 'scan0042.txt'));
});

test('Sort by type: refiles old layouts into Type › Year, leaves program folders and the Archive alone', async () => {
  const { reviewFiles } = require('../src/core/review');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sortall-'));
  const docs = path.join(tmp, 'Documents'); const org = path.join(docs, 'Organised');
  const put = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); const old = new Date('2025-03-01').getTime() / 1000; fs.utimesSync(p, old, old); };
  put(path.join(org, 'Clients', 'Acme Plumbing', 'Invoices', 'inv1.txt'), 'TAX INVOICE\nAcme Plumbing\nInvoice Number INV-1\nInvoice Date: 3 November 2025\nTotal $100.00');
  put(path.join(org, 'Archive', 'Duplicates', '2026-11-18', 'old copy.txt'), 'TAX INVOICE\nInvoice Number INV-9\nTotal $1.00');
  put(path.join(docs, 'Riyeser', 'Payroll', 'Payslips', 'Payslips paid.pdf'), '%PDF-1.4 payslip');
  put(path.join(docs, 'Riyeser', 'Payroll', 'backup.json'), '{}');
  put(path.join(docs, 'quote harbourview.txt'), 'QUOTATION\nHarbourview\nQuote number Q-5\nTotal $5,000.00');
  const r = await reviewFiles([docs], { ...settings, filingLayout: 'typeYear', nameStyle: 'keep', organisedRoot: org }, { refileAll: true });
  const to = (n) => { const p = r.plan.find((x) => x.name === n); return p && path.relative(org, p.to); };
  assert.equal(to('inv1.txt'), path.join('Invoices', '2025', 'inv1.txt'));       // old Clients/Acme layout -> Type/Year, name kept
  assert.equal(to('quote harbourview.txt'), path.join('Quotes', '2025', 'quote harbourview.txt'));
  assert.equal(to('old copy.txt'), undefined);                                     // Archive left alone
  assert.ok(!r.plan.some((x) => x.from.includes(`${path.sep}Riyeser${path.sep}`)));  // Payroll's own folder left alone
  assert.ok(r.kept.some((k) => /Riyeser$/.test(k.path)));
});

test('Find a file: filters by type, year and kind, and finds old names', () => {
  const { Index } = require('../src/core/indexer');
  const store = { get: (k, d) => d, set: () => {} };
  const idx = new Index(store);
  const root = path.join(os.tmpdir(), 'Organised');
  const now = Date.now();
  idx.docs = {
    [path.join(root, 'Invoices', '2026', 'inv7.pdf')]: { name: 'inv7.pdf', dir: path.join(root, 'Invoices', '2026'), ext: '.pdf', mtime: now, size: 1, text: 'Harbourview hotel invoice', docType: 'Invoices' },
    [path.join(root, 'Drawings', '2025', 'E-301.pdf')]: { name: 'E-301.pdf', dir: path.join(root, 'Drawings', '2025'), ext: '.pdf', mtime: now, size: 1, text: 'Harbourview data schematic', docType: 'Plans & Drawings', formerNames: ['Harbourview Data schematic.pdf'] },
    [path.join(root, 'Payroll', '2026', 'wages.xlsx')]: { name: 'wages.xlsx', dir: path.join(root, 'Payroll', '2026'), ext: '.xlsx', mtime: now, size: 1, text: 'hours', docType: 'Payroll' },
  };
  const all = idx.find({ q: 'harbourview' }, { organisedRoot: root });
  assert.equal(all.total, 2);
  assert.deepEqual(all.facets.type, { Invoices: 1, Drawings: 1 });
  assert.equal(idx.find({ q: 'harbourview', type: 'Drawings' }, { organisedRoot: root }).results[0].name, 'E-301.pdf');
  assert.equal(idx.find({ year: '2026', kind: 'Excel' }, { organisedRoot: root }).results[0].name, 'wages.xlsx');
  assert.equal(idx.find({ q: 'schematic' }, { organisedRoot: root }).total, 1); // old name / contents
});

test('Riyeser Central reads money owed and owing from the Accounting company file (read-only)', async () => {
  const initSql = require('sql.js/dist/sql-wasm.js');
  const SQL = await initSql({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const db = new SQL.Database();
  db.run(`CREATE TABLE company (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE contacts (id INTEGER PRIMARY KEY, kind TEXT, name TEXT);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, side TEXT, status TEXT, number TEXT, contact_id INTEGER, date TEXT, due_date TEXT, total INTEGER, amount_paid INTEGER);
    INSERT INTO company VALUES (1, 'Harbourview Test Pty Ltd');
    INSERT INTO contacts VALUES (1, 'customer', 'Bayside Cafe'), (2, 'supplier', 'CityPower');
    INSERT INTO documents VALUES (1, 'sale', 'open', 'INV1', 1, '2026-10-01', '2026-10-31', 150000, 50000),
      (2, 'sale', 'paid', 'INV2', 1, '2026-10-01', '2026-10-31', 9900, 9900),
      (3, 'purchase', 'open', 'PO1', 2, '2026-11-01', '2026-12-01', 48400, 0);`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));
  const file = path.join(dir, 'company.db');
  fs.writeFileSync(file, Buffer.from(db.export()));
  const before = fs.readFileSync(file);
  const { pendingPayments } = require('../src/central/sources');
  const r = await pendingPayments(file, { today: '2026-11-22' });
  assert.equal(r.company, 'Harbourview Test Pty Ltd');
  assert.deepEqual(r.totals, { owedToYou: 1000, overdueToYou: 1000, youOwe: 484, overdueYouOwe: 0 });
  assert.equal(r.receivables[0].contact, 'Bayside Cafe');
  assert.ok(r.receivables[0].overdue);
  assert.ok(fs.readFileSync(file).equals(before)); // never changed
  assert.equal((await pendingPayments(path.join(dir, 'missing.db'))).found, false);
});

test('Riyeser Central update check: compares installed versions with the latest release', () => {
  const u = require('../src/central/updates');
  assert.ok(u.newer('1.10.0', '1.9.2')); assert.ok(!u.newer('1.1.0', '1.1.0')); assert.ok(!u.newer('0.21.9', '0.22.0'));
  const release = {
    tag_name: 'riyser-2026.11.22-1', name: 'Riyeser for Windows', published_at: '2026-11-22T11:20:00Z',
    body: '### In this release\n- Riyeser Central 1.2.0\n- Riyeser Desk Assistant 0.22.0\n- Riyeser PDF 0.23.0\n- Riyeser Accounting 1.0.0\n',
    assets: ['RiyeserCentral-Setup.exe', 'RiyeserDeskAssistant-Setup.exe', 'RiyeserPDF-Setup.exe', 'RiyeserAccounting-Setup.exe']
      .map((n) => ({ name: n, size: 10, browser_download_url: `https://github.com/raka1987/Riyeser/releases/download/riyser-2026.11.22-1/${n}` })),
  };
  const latest = u.latestFromRelease(release);
  assert.equal(latest.products.pdf.version, '0.23.0');
  const reg = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\abc',
    '    DisplayName    REG_SZ    Riyeser PDF 0.22.0', '    DisplayVersion    REG_SZ    0.22.0', '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\def',
    '    DisplayName    REG_SZ    Riyeser Desk Assistant 0.22.0', '    DisplayVersion    REG_SZ    0.22.0', '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ghi',
    '    DisplayName    REG_SZ    Some Other App', '    DisplayVersion    REG_SZ    9.9.9',
  ].join('\r\n');
  const installed = { ...u.installedFromRegistry(reg + '\r\n\r\nHKEY_CURRENT_USER\\Software\\X\r\n    DisplayName    REG_SZ    Riyser Central 1.1.0\r\n    DisplayVersion    REG_SZ    1.1.0') };
  assert.deepEqual(installed, { pdf: '0.22.0', desk: '0.22.0', central: '1.1.0' });
  const ups = u.availableUpdates(installed, latest);
  assert.deepEqual(ups.map((x) => `${x.id} ${x.from}->${x.to}`), ['central 1.1.0->1.2.0', 'pdf 0.22.0->0.23.0']); // not Accounting: not installed
  // a release that still uses the old Riyser file names is understood too
  const oldNames = u.latestFromRelease({ ...release, assets: release.assets.map((a) => ({ ...a, name: a.name.replace('RiyeserCentral', 'RiyserCentral').replace('RiyeserPDF', 'RiyserPDF') })) });
  assert.equal(oldNames.products.central.version, '1.2.0'); assert.equal(oldNames.products.pdf.version, '0.23.0');
  // downloads only from the Riyeser release
  const evil = u.latestFromRelease({ ...release, assets: release.assets.map((a) => ({ ...a, browser_download_url: 'https://evil.example/x.exe' })) });
  assert.deepEqual(evil.products, {});
});

test('Riyeser Central offers Riyeser Payroll in place of the old "Riyser" hub', () => {
  const u = require('../src/central/updates');
  const reg = 'HKEY_CURRENT_USER\\x\\a\r\n    DisplayName    REG_SZ    Riyser 1.2.0\r\n    DisplayVersion    REG_SZ    1.2.0\r\n'
    + 'HKEY_CURRENT_USER\\x\\b\r\n    DisplayName    REG_SZ    Riyser Central 1.1.0\r\n    DisplayVersion    REG_SZ    1.1.0\r\n';
  const installed = u.installedFromRegistry(reg);
  assert.deepEqual(installed, { payroll: '1.2.0', central: '1.1.0' });
  const rel = { tag_name: 't', body: '- Riyeser Payroll 2.1.1\n- Riyeser Central 1.3.2', assets: ['RiyeserPayroll-Setup.exe', 'RiyeserCentral-Setup.exe'].map((n) => ({ name: n, browser_download_url: `https://github.com/raka1987/Riyeser/releases/download/t/${n}`, size: 1 })) };
  assert.deepEqual(u.availableUpdates(installed, u.latestFromRelease(rel)).map((x) => `${x.id} ${x.from}->${x.to}`).sort(), ['central 1.1.0->1.3.2', 'payroll 1.2.0->2.1.1']);
});
