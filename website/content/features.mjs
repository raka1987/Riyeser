// The Riyeser feature register: ONE list of what each program really does today, where it runs, whether it needs the
// internet and which plan it needs. The website builds from it: the "What works today" page (features.html), the
// Accounting Basics vs Plus and Riyeser Link vs Link Office comparisons, and the "At a glance", "Not yet" and
// questions boxes on every program page. Change a feature here and every page follows.
//
// Checked against the code (28 November 2026): main (riyeser/ Accounting, Invoices, Bookings, POS, Estimate 2.10.1;
// supabase/functions api, licence, paypal, download), module/desk-assistant (desktop/ Central, Documents, PDF, Link Office;
// website/team Riyeser Link; team-chat.sql billing and HQ) and module/payroll (Riyeser Payroll 2.4.0), and the latest
// release riyeser-2026.11.27-60 on GitHub. `ev` is where that was checked: keep it when you change a row.
//
// STATUS
//   available  in the current release, for everyone with that program
//   beta       in the current release, but new (November 2026): it works, and we're still watching it closely
//   planned    not in any release yet. Say so plainly; never show it as working
//   no         not supported, and not planned yet
// WHERE      win = the Windows 10 / 11 program, web = any web browser, phone = a phone's web browser
// INTERNET   offline = works with no internet at all · lan = needs the office network but not the internet ·
//            online = needs the internet
// No row may say a feature is encrypted, compliant, certified, tested on a device or tax-correct unless the code or a
// test shows it. When in doubt, say "not yet verified".

export const STATUS = {
  available: { label: 'Available', cls: 'st-ok', note: 'In the current release.' },
  beta: { label: 'Beta', cls: 'st-beta', note: 'In the current release, but new: it works, and we are still watching it closely.' },
  planned: { label: 'Planned', cls: 'st-plan', note: 'Not in any release yet.' },
  no: { label: 'Not supported', cls: 'st-no', note: 'Not supported, and not planned yet.' },
};
export const WHERE = { win: 'Windows', web: 'Web browser', phone: 'Phone browser' };
export const NET = { offline: 'Works offline', lan: 'Office network', online: 'Needs internet' };

// The release the register was checked against (the program versions are in that release's notes on GitHub).
export const CHECKED = { date: '28 November 2026', release: 'riyeser-2026.11.27-60' };

// ---------- each program at a glance ----------
// runs: where it runs · net: internet in one line · account: is a Riyeser account needed · hw: hardware in one line
// countries: what it is set up for · version: in the release above
export const FACTS = {
  central: { version: '1.8.12', runs: 'Windows 10 and 11 PCs', net: 'Works offline. Needs the internet to download and update programs, and for Online connections.',
    account: 'Not needed. Sign in with a free Riyeser account only to link the PC to your business (Riyeser Link, Online connections, a paid plan).',
    hw: 'Any PC that runs Windows 10 or 11.', countries: 'Any country.' },
  documents: { version: '1.0.0', runs: 'Windows 10 and 11 PCs; the library can sit on a shared network folder',
    net: 'Works offline. A shared library needs the office network.', account: 'Not needed.',
    hw: 'Scanners through Windows\' own scan window; scan-to-folder steps for HP, Canon, Brother, Ricoh, Kyocera and Epson office printers (not yet verified on each model).',
    countries: 'Any country. Reading scans (OCR) is set up for English text.' },
  invoices: { version: '2.10.1', runs: 'Windows 10 and 11 PCs', net: 'Works offline. Emailing an invoice needs the internet and your email settings.',
    account: 'Not needed.', hw: 'Any printer Windows can print to.', countries: 'Set up for Australian GST by default; tax codes, ABN field and currency code can be changed. Not tailored to other countries yet.' },
  pdf: { version: '0.25.0', runs: 'Windows 10 and 11 PCs', net: 'Works offline.', account: 'Not needed.', hw: 'Any PC that runs Windows 10 or 11.', countries: 'Any country.' },
  'accounting-basics': { version: '2.10.1', runs: 'Windows 10 and 11 PCs', net: 'Works offline. Online orders and bookings from your website need the internet.',
    account: 'Not needed for the 90-day trial. A free Riyeser account is needed to buy.', hw: 'Any printer Windows can print to.',
    countries: 'Set up for Australian GST and BAS by default (10% GST, ABN). Tax codes and the currency code can be changed; other countries\' tax rules are not built in.' },
  accounting: { version: '2.10.1', runs: 'Windows 10 and 11 PCs', net: 'Works offline. Online orders and bookings from your website need the internet.',
    account: 'Not needed for the 90-day trial. A free Riyeser account is needed to buy.', hw: 'Any printer Windows can print to.',
    countries: 'Set up for Australian GST and BAS by default. Its own payroll is an Australian estimate only (see below). Other countries\' tax rules are not built in.' },
  bookings: { version: '2.10.1', runs: 'Windows 10 and 11 PCs; on-site sign-off on a phone or tablet on the same network',
    net: 'Works offline. Online bookings from your website or booking page need the internet.', account: 'Not needed for the 90-day trial. Online bookings need a Riyeser account.',
    hw: 'A phone or tablet camera for job photos and signatures.', countries: 'Any country (your own time zone and currency code).' },
  estimate: { version: '2.10.1', runs: 'Windows 10 and 11 PCs', net: 'Works offline, except measuring on the map (satellite imagery needs the internet).',
    account: 'Not needed for the 90-day trial (counted from the first time you use it).', hw: 'A laser measurer is optional: you type its readings in.',
    countries: 'Any country: metric or imperial, your own currency, tax name and date format.' },
  link: { version: '1.1.2', runs: 'Windows PCs (the Riyeser Link app), any web browser, and phones through the browser',
    net: 'Needs the internet: chat, files and calls go through Riyeser\'s online service.', account: 'Yes: everyone signs in with a Riyeser account.',
    hw: 'A headset or the PC\'s microphone and speakers; a camera for video.', countries: 'Any country. Calls are between your own people only (no phone numbers).' },
  'link-office': { version: '1.3.0', runs: 'One Windows 10 or 11 PC at the office that stays on', net: 'Desk phones inside the office call each other over the office network, even when the internet is down (the plan is checked at least every 30 days). Branches, phones at home and answering in the Riyeser Link app need the internet.',
    account: 'Yes: the office PC signs in with your Riyeser account, and your business needs Riyeser Link.',
    hw: 'Desk phones that use SIP. Automatic set-up for Yealink, Grandstream, Snom and Polycom; others by hand. Not yet verified model by model.',
    countries: 'Any country. No outside lines and no emergency calls.' },
  payroll: { version: '2.4.0', runs: 'Windows 10 and 11 PCs (staff use the time clock on a shared PC)', net: 'Works offline. Emailing payslips needs the internet and your email settings.',
    account: 'Not needed for the 90-day trial. A free Riyeser account is needed to buy.', hw: 'A shared PC or tablet for the time clock.',
    countries: 'Built around Fiji\'s PAYE and FNPF: you enter the rates in Payroll rules. Australian (PAYG, super, Single Touch Payroll) and New Zealand (PAYE, KiwiSaver) payroll are not built in.' },
  pos: { version: '2.10.1', runs: 'Windows 10 and 11 PCs (touch screens work)', net: 'Works offline. Online shop orders need the internet.',
    account: 'Not needed for the 90-day trial. A free Riyeser account is needed to buy.',
    hw: 'Receipts print through Windows (80 mm layout); barcode scanners that type like a keyboard; your own EFTPOS machine, not linked. See the hardware page.',
    countries: 'Receipts are set up as Australian tax invoices (GST, ABN) by default.' },
};

// ---------- every advertised capability ----------
// [program, feature, status, where[], internet, plan, evidence]
const W = ['win'];
export const FEATURES = [
  // Riyeser Central (free)
  ['central', 'Home screen with every Riyeser program you have', 'available', W, 'offline', 'Free', 'desktop/src/renderer/launcher.js'],
  ['central', 'Installs and updates Riyeser programs', 'available', W, 'online', 'Free', 'desktop/src/central/install-run.js, updates.js'],
  ['central', 'Money owed, overdue invoices and bills to pay, from Riyeser Accounting', 'available', W, 'offline', 'Free (needs Accounting)', 'desktop/src/renderer/launcher.js'],
  ['central', 'Demo mode with a sample business, kept apart from your real records', 'available', W, 'offline', 'Free', 'desktop/src/central/demo.js; riyeser/demo_mode.py'],
  ['central', 'Online connections: bookings, orders and enquiries from your website collected every minute', 'beta', W, 'online', 'Needs Bookings, POS or Accounting', 'desktop/src/central/online-sync.js; supabase/functions/api (main)'],
  ['central', 'Mac and Linux versions', 'no', [], 'offline', '—', 'desktop/package.json (Windows NSIS builds only)'],
  // Riyeser Documents (free)
  ['documents', 'Shared document library with department folders', 'available', W, 'lan', 'Free', 'desktop/src/documents/library.js'],
  ['documents', 'Inbox with a suggested folder for each new document', 'available', W, 'offline', 'Free', 'desktop/src/documents/suggest.js'],
  ['documents', 'Reads scans and photos (OCR) so search finds the words inside', 'available', W, 'offline', 'Free', 'desktop/src/core/ocr.js'],
  ['documents', 'People & access for each folder', 'available', W, 'offline', 'Free', 'desktop/src/documents/access.js'],
  ['documents', 'Recycle bin (30 days) and history of who did what', 'available', W, 'offline', 'Free', 'website/build.mjs INCLUDES; desktop/src/documents/library.js'],
  ['documents', 'Riyeser cloud sync, offices on different sites and share links', 'planned', [], 'online', 'Free', 'website/help.mjs "Coming later"'],
  // Riyeser Invoices (free)
  ['invoices', 'Unlimited quotes, invoices, customers and payments', 'available', W, 'offline', 'Free', 'riyeser/views/documents.py'],
  ['invoices', 'Turn an accepted quote into an invoice or a Bookings job', 'available', W, 'offline', 'Free', 'riyeser/views/documents.py'],
  ['invoices', 'Part payments and one payment across several invoices', 'available', W, 'offline', 'Free', 'riyeser/views/banking.py, documents.py'],
  ['invoices', 'Credit notes', 'available', W, 'offline', 'Free', 'riyeser/views/documents.py'],
  ['invoices', 'Print or save invoices and quotes as PDFs', 'available', W, 'offline', 'Free', 'riyeser/views/documents.py'],
  ['invoices', 'Email an invoice or quote with its PDF (your own email settings)', 'available', W, 'online', 'Free', 'riyeser/views/documents.py, riyeser/mailer.py'],
  ['invoices', 'Turns an accepted quote into an invoice; GST worked out and rounded on each line', 'available', W, 'offline', 'Free', 'riyeser/views/quotes.py, documents.py (apps QA register)'],
  ['invoices', 'Recurring invoices', 'no', [], 'offline', '—', 'no recurring invoices in riyeser/ (main); apps QA register'],
  ['invoices', 'Automatic overdue reminder emails', 'no', [], 'online', '—', 'apps QA register: statements are emailed by hand only'],
  ['invoices', 'Your logo on invoice PDFs', 'no', [], 'offline', '—', 'apps QA register: no logo code in riyeser/'],
  // Riyeser PDF (free)
  ['pdf', 'Edit words, add text, highlight and mark up', 'available', W, 'offline', 'Free', 'desktop/src/renderer/editor.js'],
  ['pdf', 'Fill in forms, sign, tick and date', 'available', W, 'offline', 'Free', 'desktop/src/renderer/editor.js'],
  ['pdf', 'Redact: removes what is underneath for good', 'available', W, 'offline', 'Free', 'desktop/src/renderer/editor.js'],
  ['pdf', 'Combine, split, reorder and rotate pages', 'available', W, 'offline', 'Free', 'desktop/src/renderer/pdf-tools.mjs'],
  ['pdf', 'Compress PDF files (make them smaller)', 'available', W, 'offline', 'Free', 'desktop/src/renderer/editor.js compress()'],
  ['pdf', 'Recognise the text in scanned pages', 'available', W, 'offline', 'Free', 'desktop/src/renderer/ocr-render.js'],
  ['pdf', 'Password-protect a PDF', 'available', W, 'offline', 'Free', 'desktop/src/renderer/editor.js (doc.encrypt)'],
  // Accounting Basics
  ['accounting-basics', 'Quotes, orders and invoices with GST', 'available', W, 'offline', 'Basics or Plus', 'riyeser/views/documents.py'],
  ['accounting-basics', 'Suppliers, bills and paying bills', 'available', W, 'offline', 'Basics or Plus', 'riyeser/views/documents.py, contacts.py'],
  ['accounting-basics', 'Stock with average cost, stocktake and purchase orders for low stock', 'available', W, 'offline', 'Basics or Plus', 'riyeser/views/inventory.py'],
  ['accounting-basics', 'Staff expense claims with receipts', 'available', W, 'offline', 'Basics or Plus', 'riyeser/views/expenses.py'],
  ['accounting-basics', 'Reports: Profit & Loss, GST summary, who owes you, sales and stock', 'available', W, 'offline', 'Basics or Plus', 'riyeser/views/reports.py'],
  ['accounting-basics', 'Till sales from Riyeser POS land as paid invoices', 'available', W, 'offline', 'Basics or Plus (and POS)', 'riyeser/views/pos.py'],
  ['accounting-basics', 'Online orders from your website or shop', 'beta', W, 'online', 'Basics, Plus or POS', 'riyeser/online.py; supabase/functions/api (main)'],
  ['accounting-basics', 'Live bank feeds from your bank', 'no', [], 'online', '—', 'statement import (CSV) only in riyeser/ (main)'],
  // Accounting Plus
  ['accounting', 'Bank reconciliation and bank statement import (CSV)', 'available', W, 'offline', 'Plus', 'riyeser/views/banking.py'],
  ['accounting', 'General journal, reversing entries, jobs and budgets', 'available', W, 'offline', 'Plus', 'riyeser/views/core.py, reports.py'],
  ['accounting', 'BAS / GST summary and locking a period once lodged', 'available', W, 'offline', 'Plus', 'riyeser/views/reports.py'],
  ['accounting', 'Balance Sheet, Trial Balance and General Ledger', 'available', W, 'offline', 'Plus', 'riyeser/views/reports.py'],
  ['accounting', 'Bank statement import spots lines already imported', 'available', W, 'offline', 'Plus', 'riyeser/views/banking.py (apps QA register)'],
  ['accounting', 'Year roll-over', 'available', W, 'offline', 'Plus', 'apps QA register'],
  ['accounting', 'Cash flow statement (there is a Cash Movement by Account report)', 'no', [], 'offline', '—', 'apps QA register'],
  ['accounting', 'Fixed assets and depreciation schedules (use a general journal)', 'no', [], 'offline', '—', 'apps QA register'],
  ['accounting', 'More than one company with one sign-in', 'available', W, 'offline', `Extra companies charged`, 'riyeser/licence.py EXTRA_COMPANY_PRICE'],
  ['accounting', 'Payroll inside Accounting Plus (an Australian PAYG estimate; not for real pay runs yet)', 'beta', W, 'offline', 'Plus', 'riyeser/payroll_calc.py NOT_FOR_REAL_PAY'],
  ['accounting', 'Single Touch Payroll (Australia) lodgement', 'no', [], 'online', '—', 'riyeser/payroll_calc.py (STP not included)'],
  // Bookings
  ['bookings', 'Day and week calendar for staff or tables, with double-booking warnings', 'available', W, 'offline', 'Bookings', 'riyeser/views/bookings.py, bookings_site.py'],
  ['bookings', 'Trades jobs with visits, checklists, photos and on-screen customer signature', 'available', W, 'lan', 'Bookings', 'riyeser/views/bookings.py, bookings_site.py'],
  ['bookings', 'Invoice a finished job in one click', 'available', W, 'offline', 'Bookings', 'riyeser/views/bookings.py, bookings_site.py'],
  ['bookings', 'Customers book online: a booking form on your website or your own riyeser.com/book page', 'beta', ['win', 'web', 'phone'], 'online', 'Bookings (and a Riyeser account)', 'supabase/functions/api routes /v1/bookings, /v1/pages; website/book; website/widget'],
  ['bookings', 'Reminder emails the day before (your own email settings)', 'available', W, 'online', 'Bookings', 'riyeser/views/bookings.py reminder() (S51)'],
  ['bookings', 'Booking reminders by text message', 'no', [], 'online', '—', 'no SMS sending in riyeser/ (main)'],
  ['bookings', 'Recurring bookings', 'no', [], 'offline', '—', 'apps QA register'],
  ['bookings', 'Cancellation policy (fees or rules)', 'no', [], 'online', '—', 'apps QA register'],
  ['bookings', 'Separate check-in and check-out (visits have statuses instead)', 'no', [], 'offline', '—', 'apps QA register'],
  ['bookings', 'Sync with Google, Outlook or iCal calendars', 'no', [], 'online', '—', 'no calendar sync in riyeser/ (main); apps QA register'],
  // Estimate
  ['estimate', 'Type in sizes: rooms, areas, lengths, counts and volumes', 'available', W, 'offline', 'Estimate', 'riyeser/measure/engine.py'],
  ['estimate', 'Measure on a PDF plan or a photo after setting the scale', 'available', W, 'offline', 'Estimate', 'riyeser/measure/drawing.py'],
  ['estimate', 'Measure roofs, fences and driveways on the map (satellite imagery)', 'available', W, 'online', 'Estimate', 'riyeser/views/estimate.py (Esri World Imagery)'],
  ['estimate', 'Trade templates with waste, pack sizes and your rates', 'available', W, 'offline', 'Estimate', 'riyeser/measure/seeds.py'],
  ['estimate', 'Markup on costs, with your margin shown (no target-margin box)', 'available', W, 'offline', 'Estimate', 'riyeser/measure/engine.py; apps QA register'],
  ['estimate', 'Quote PDF with a measurements page; it opens in Invoices, Bookings and Accounting', 'available', W, 'offline', 'Estimate', 'riyeser/measure/quote.py'],
  // Riyeser Link
  ['link', 'Channels, private chats and direct messages', 'available', ['win', 'web', 'phone'], 'online', 'Riyeser Link', 'website/team/team.js; team-chat.sql'],
  ['link', 'Files shared in chat (20 GB per business, up to 25 MB a file)', 'available', ['win', 'web', 'phone'], 'online', 'Riyeser Link', 'website/prices.mjs STORAGE_GB'],
  ['link', 'Voice and video calls between your people and branches', 'available', ['win', 'web', 'phone'], 'online', 'Riyeser Link', 'website/team/team.js'],
  ['link', 'Calls to and from outside phone numbers', 'no', [], 'online', '—', 'desktop/src/link/dialplan.js ("Internal calls only")'],
  ['link', 'Emergency calls', 'no', [], 'online', '—', 'desktop/src/link/dialplan.js EMERGENCY'],
  ['link', 'Website connections: API keys, booking page and webhooks (Management → Connections)', 'beta', ['web'], 'online', 'Riyeser Link admins', 'website/team/team.js; supabase/functions/api'],
  // Riyeser Link Office
  ['link-office', 'Office phone system on one PC: an extension for each person', 'available', W, 'lan', 'Comes with Riyeser Link', 'desktop/src/link/pbx.js, directory.js'],
  ['link-office', 'Desk phones set themselves up (Yealink, Grandstream, Snom, Polycom)', 'available', W, 'lan', 'Comes with Riyeser Link', 'desktop/src/link/provision.js'],
  ['link-office', 'Ring groups: ring all, in order, or rotate', 'available', W, 'lan', 'Comes with Riyeser Link', 'desktop/src/link/ringgroups.js'],
  ['link-office', 'Answer office calls in the Riyeser Link app (My phone)', 'available', ['win', 'web', 'phone'], 'online', 'Comes with Riyeser Link', 'website/help.mjs my-phone'],
  ['link-office', 'Branches at other sites and phones at home, through the Riyeser relay', 'beta', W, 'online', 'Comes with Riyeser Link', 'desktop/src/link/relay.js, trunks.js (Link Office 1.3.0)'],
  ['link-office', 'Calls to and from outside phone numbers (phone lines, SIP trunks)', 'no', [], 'online', '—', 'desktop/src/link/dialplan.js ("Internal calls only")'],
  ['link-office', 'Emergency calls (000, 111, 112, 911, 999…)', 'no', [], 'lan', '—', 'desktop/src/link/dialplan.js EMERGENCY'],
  ['link-office', 'Voicemail and call recording', 'no', [], 'lan', '—', 'no voicemail or recording in desktop/src/link'],
  // Payroll
  ['payroll', 'Weekly roster, published to staff (screen, print, WhatsApp / SMS text to copy)', 'available', W, 'offline', 'Payroll', 'module/payroll roster.js'],
  ['payroll', 'Time clock with a 4-digit PIN, timesheets and approval', 'available', W, 'offline', 'Payroll', 'module/payroll server.js, payweek.js'],
  ['payroll', 'Pay runs with PAYE and FNPF from the rates you enter', 'available', W, 'offline', 'Payroll', 'module/payroll wages.js, server.js'],
  ['payroll', 'Payslips with year-to-date totals: print, PDF or email', 'available', W, 'offline', 'Payroll', 'module/payroll pdf.js, mailer.js'],
  ['payroll', 'Annual and sick leave balances', 'available', W, 'offline', 'Payroll', 'module/payroll README'],
  ['payroll', 'A backup every day (the last 30 kept)', 'available', W, 'offline', 'Payroll', 'module/payroll README'],
  ['payroll', 'Australian payroll (PAYG tables, superannuation, Single Touch Payroll)', 'no', [], 'online', '—', 'module/payroll (no PAYG/super/STP)'],
  ['payroll', 'New Zealand payroll (PAYE, KiwiSaver, payday filing)', 'no', [], 'online', '—', 'module/payroll (no KiwiSaver)'],
  // POS
  ['pos', 'Retail setup: product tiles, barcode search, held sales', 'available', W, 'offline', 'POS', 'riyeser/templates/pos/front.html'],
  ['pos', 'Restaurant setup: tables, kitchen dockets (printed) and takeaway', 'available', W, 'offline', 'POS', 'riyeser/templates/pos/front.html, docket.html'],
  ['pos', 'Cash with change, card recorded with your own EFTPOS machine (not linked)', 'available', W, 'offline', 'POS', 'riyeser/terminals/manual.py'],
  ['pos', 'Practice card terminal on screen for training and demos (no money moves)', 'available', W, 'offline', 'POS', 'riyeser/terminals/practice.py'],
  ['pos', 'Linked card terminals (Windcave, Stripe Terminal)', 'planned', [], 'online', 'POS', 'riyeser/terminals/windcave.py, stripe_terminal.py ("coming soon", disabled)'],
  ['pos', 'Manager PIN for refunds, voids and big discounts; close the till with a Z-report', 'available', W, 'offline', 'POS', 'riyeser/views/pos.py'],
  ['pos', 'Every sale lands in your books with stock and GST updated', 'available', W, 'offline', 'POS', 'riyeser/views/pos.py'],
  ['pos', 'Split a payment between card and cash', 'available', W, 'offline', 'POS', 'riyeser/templates/pos/front.html; apps QA register'],
  ['pos', 'Product variants (size or colour)', 'no', [], 'offline', '—', 'apps QA register'],
  ['pos', 'Stock transfers between locations', 'no', [], 'offline', '—', 'apps QA register'],
  ['pos', 'Moving an order to another table, or splitting a bill between guests', 'no', [], 'offline', '—', 'apps QA register'],
  ['pos', 'Opening the cash drawer automatically', 'no', [], 'offline', '—', 'riyeser/templates/pos/front.html sends riyeser:open-drawer, nothing handles it'],
  ['pos', 'Kitchen display screen', 'no', [], 'offline', '—', 'kitchen dockets print only (riyeser/templates/pos/docket.html)'],
];

// ---------- Accounting Basics vs Plus (both columns from the code; nothing guessed) ----------
// [feature, basics, plus]: true, false or a short text
export const COMPARE_ACCOUNTING = [
  ['Price per business', 'US$:basic/month', 'US$:plus/month'],
  ['Users included', '3 (+US$:extra_user/month each)', '3 (+US$:extra_user/month each)'],
  ['Free trial', '90 days, no card', '90 days, no card'],
  ['Quotes, invoices, credit notes and payments', true, true],
  ['Customers, suppliers and bills', true, true],
  ['Stock, stocktake and purchase orders', true, true],
  ['Staff expense claims', true, true],
  ['Profit & Loss, GST summary, sales and stock reports', true, true],
  ['Riyeser POS till sales as paid invoices', true, true],
  ['Bank statement import (CSV) and bank reconciliation', false, true],
  ['General journal and reversing entries', false, true],
  ['Jobs (job costing) and budgets', false, true],
  ['BAS / GST summary labels and period lock', false, true],
  ['Balance Sheet, Trial Balance, General Ledger', false, true],
  ['Payroll inside Accounting', false, 'Australian estimate only: not for real pay runs yet'],
  ['Pay runs from Riyeser Payroll brought into the books', true, true],
  ['Live bank feeds', false, false],
  ['Extra companies', 'US$:extra_company/month each', 'US$:extra_company/month each'],
  ['Works offline', true, true],
];

// ---------- Riyeser Link vs Riyeser Link Office ----------
export const COMPARE_LINK = [
  ['What it is', 'Team chat and calls app', 'The office phone system for desk phones'],
  ['Price', 'US$:calls/month (3 users included)', 'Comes with Riyeser Link: no separate price'],
  ['Runs on', 'Windows app, any web browser, phones (browser)', 'One Windows PC at the office that stays on'],
  ['Chat, channels, direct messages and files', true, false],
  ['Calls between your people and branches', 'In the app (internet)', 'On desk phones (office network)'],
  ['Desk phones with extension numbers', false, true],
  ['Ring groups', true, true],
  ['Works when the internet is down', false, 'Desk phones in the office keep calling each other'],
  ['Branches and phones at home', 'Yes (app)', 'Beta, through the Riyeser relay'],
  ['Calls to and from outside phone numbers', false, false],
  ['Emergency calls', false, false],
  ['Voicemail and call recording', false, false],
];

// ---------- questions on each program page (only what is true today) ----------
export const FAQ = {
  central: [['Do I need Central?', 'It is the easiest way to start: it installs and updates the other programs, and shows them on one home screen. Each program can also be downloaded on its own.'],
    ['Does it work without the internet?', 'Yes. You need the internet only to download or update programs and for Online connections.']],
  documents: [['Where are my documents kept?', 'In ordinary Windows folders on your PC or on a shared network folder you choose. Nothing is uploaded to Riyeser.'],
    ['Can I share a link to a document?', 'Not yet. Share links and cloud sync are planned. For now, print it or attach it to an email.']],
  invoices: [['Is it really free?', 'Yes: unlimited quotes, invoices, customers and payments, with no time limit and no card.'],
    ['Can it send recurring invoices?', 'No, not yet. Make a copy of last month\'s invoice instead.'],
    ['What tax does it use?', 'It starts set up for Australian GST (10%). You can change the tax codes and the currency code to suit your country; check the setup with your accountant.']],
  pdf: [['Is it really free?', 'Yes: no time limit, no card and no account.'],
    ['Does Redact really remove the text?', 'Yes: Redact removes what is underneath, not just covers it. White-out only covers it. Check the saved file before you send it.']],
  'accounting-basics': [['Basics or Plus?', 'Basics covers invoices, bills, stock and simple money in and out. Choose Plus for bank reconciliation, journals, jobs, budgets and the full set of reports. You pay for one, never both.'],
    ['Does it connect to my bank?', 'Not directly. Live bank feeds are not supported. Accounting Plus imports bank statements saved as CSV files.'],
    ['Which countries is it for?', 'It starts set up for Australia (GST and ABN). You can change tax codes and the currency code, but other countries\' tax rules are not built in. Have your accountant check your setup.']],
  accounting: [['Can I run payroll in Accounting Plus?', 'Its built-in payroll is an Australian estimate only (not the ATO tax tables, and no Single Touch Payroll), so it is not for real pay runs yet. Riyeser Payroll is the separate payroll program (set up for Fiji\'s PAYE and FNPF).'],
    ['Does it connect to my bank?', 'Not directly. Import your bank statement as a CSV file, then reconcile it.'],
    ['Can I keep books for more than one company?', `Yes: one company is included and each extra company is a set monthly price, with one sign-in.`]],
  bookings: [['Can customers book online?', 'Yes, with a Riyeser account: a booking form on your website, or your own booking page on riyeser.com. Bookings arrive on your PC for you to confirm. This needs the internet and Riyeser Central running on one PC. It is new (beta).'],
    ['Does it send reminders?', 'Yes, by email the day before (through your own email settings). Not by text message.'],
    ['Can I set up repeating bookings?', 'Not yet: recurring bookings, cancellation fees and calendar sync (Google, Outlook) are not supported.']],
  estimate: [['When does the free trial start?', 'The 90 days start the first time you use Riyeser Estimate, not when you install it.'],
    ['How accurate is measuring on the map?', 'Satellite imagery can be years old and roof pitch can\'t be seen from above: check sizes on site before you order materials.'],
    ['Is it in a bundle?', 'No. Riyeser Estimate is priced on its own and is not part of any bundle.']],
  link: [['Can I call outside phone numbers?', 'No. Riyeser Link calls are between your own people and branches. Keep a mobile or normal phone line for customers and for emergencies.'],
    ['Does it need the internet?', 'Yes. Chat, files and calls go through Riyeser\'s online service.'],
    ['What is the difference with Riyeser Link Office?', 'Riyeser Link is the chat and calls app. Riyeser Link Office is the office phone system for desk phones, on one PC at the office. It comes with Riyeser Link.']],
  'link-office': [['Can it make outside calls?', 'No. It has no phone lines (SIP trunks): desk phones call each other, and people in the Riyeser Link app. It cannot call emergency services: keep a mobile or normal phone line for that.'],
    ['What happens if the internet goes down?', 'Desk phones in the office keep calling each other over the office network. Calls to branches, phones at home and the Riyeser Link app wait for the internet.'],
    ['Which desk phones work?', 'Yealink, Grandstream, Snom and Polycom SIP phones set themselves up. Other SIP phones can be set up by hand. We have not yet published a list of tested models.']],
  payroll: [['Which countries is it for?', 'It is built around Fiji\'s PAYE and FNPF, with the rates you enter in Payroll rules. Australian and New Zealand payroll (PAYG, super, STP, KiwiSaver) are not built in. Check every rate against the current rules before you pay staff.'],
    ['Is it the same as payroll in Accounting Plus?', 'No. Riyeser Payroll is its own program and its own price. Pay runs can be brought into Riyeser Accounting. It is not part of the Shop bundle; it is in the Office and Business bundles.']],
  pos: [['Does it connect to my EFTPOS machine?', 'Not yet. Today you key the amount into your own card machine and tap Approved or Declined on the till. A practice terminal is built in for training. Linked terminals (Windcave, Stripe) are planned.'],
    ['Retail or restaurant?', 'Both, chosen in setup: retail has product tiles, barcodes and held sales; restaurant adds tables, kitchen dockets and takeaway.'],
    ['Which hardware works?', 'Receipts print through Windows on an 80 mm layout, and barcode scanners that type like a keyboard can be used. We have not yet published a list of tested printers, scanners or cash drawers, and the cash drawer does not open by itself.']],
};

// ---------- hardware: what the code supports, and what has been tested on real devices ----------
// [kind, how it connects today, programs, tested models]
export const HARDWARE = [
  ['Desk phones (SIP)', 'Automatic set-up for Yealink, Grandstream, Snom and Polycom on the office network; other SIP phones by hand', 'Riyeser Link Office', 'Not yet verified: no tested model list yet'],
  ['Phone apps (softphones)', 'Linphone and other SIP apps through the Riyeser relay (TLS)', 'Riyeser Link Office', 'Not yet verified'],
  ['Receipt printers', 'Printed through Windows on an 80 mm receipt layout (no direct printer commands)', 'Riyeser POS', 'Not yet verified: no tested model list yet'],
  ['Kitchen printers', 'Kitchen dockets print through Windows on an 80 mm layout', 'Riyeser POS (restaurant)', 'Not yet verified'],
  ['Barcode scanners', 'Scanners that type like a keyboard into the till\'s search', 'Riyeser POS', 'Not yet verified'],
  ['Cash drawers', 'Not supported: the drawer does not open by itself', 'Riyeser POS', '—'],
  ['Kitchen display screens', 'Not supported (dockets print instead)', 'Riyeser POS', '—'],
  ['EFTPOS / card terminals', 'Your own machine, not linked: key in the amount, tap Approved or Declined. Linked Windcave and Stripe terminals are planned', 'Riyeser POS', 'No linked terminal yet'],
  ['Scanners and office printers', 'Windows\' own scan window, or scan-to-folder from HP, Canon, Brother, Ricoh, Kyocera and Epson printers (set-up steps)', 'Riyeser Documents', 'Not yet verified model by model'],
  ['Touch screens and tablets', 'Windows touch screens on the till; phone or tablet browser for on-site sign-off', 'Riyeser POS, Bookings', 'Not yet verified'],
];

// ---------- countries: what the programs actually set up (configuration, not confirmed compliance) ----------
// [area, Fiji, Australia, New Zealand, other countries]
export const COUNTRIES = [
  ['Prices and billing', 'US dollars', 'US dollars', 'US dollars', 'US dollars'],
  ['Currency of your books', 'Type your currency code (Fiji dollars, for example)', 'Australia\'s currency code by default', 'Type your currency code (New Zealand dollars, for example)', 'Type your currency code'],
  ['Sales tax in Accounting, Invoices and POS', 'Change the tax codes yourself (VAT is not set up for you)', 'GST 10% and BAS labels set up for you', 'Change the tax codes yourself (NZ GST is not set up for you)', 'Change the tax codes yourself'],
  ['Business number on invoices and receipts', 'The field is labelled ABN (no TIN field)', 'ABN', 'The field is labelled ABN (no IRD number or NZBN field)', 'The field is labelled ABN'],
  ['Tax reports in Accounting', 'BAS / GST report only (Australian)', 'BAS / GST report', 'BAS / GST report only (Australian)', 'BAS / GST report only (Australian)'],
  ['Riyeser Payroll', 'PAYE and FNPF from the rates you enter', 'Not built in (no PAYG tables, super or STP)', 'Not built in (no KiwiSaver)', 'Not built in'],
  ['Payroll inside Accounting Plus', 'Not built in', 'An estimate only: not for real pay runs yet', 'Not built in', 'Not built in'],
  ['Estimate', 'Metric, your currency', 'Metric, your currency', 'Metric, your currency', 'Metric or imperial, your currency'],
  ['Riyeser Link and Link Office', 'Internal calls only; no emergency calls', 'Internal calls only; no emergency calls', 'Internal calls only; no emergency calls', 'Internal calls only; no emergency calls'],
];
