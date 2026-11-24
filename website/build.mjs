// Builds the Riyeser website into website/public (plain HTML, no server needed - GitHub Pages or any host).
//   node website/build.mjs
// Edit the text here; every page shares the same header, footer and download buttons.
import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { helpGuides } from './help.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR || join(ROOT, 'public');
const SITE = process.env.SITE_URL || 'https://riyeser.com';
// Installers are attached to the latest GitHub Release under these fixed names, so links never go stale.
const RELEASES = 'https://github.com/raka1987/Riyeser/releases/latest/download';
const EMAIL = 'info@riyeser.com';
// Early bird: 50% off the first year for the first 100 paid users. Set to false once 100 users have it.
const EARLY_BIRD = true;
// Turn on once a release with RiyeserServices-Setup.exe is published.
const SERVICES_WIN = process.env.SERVICES_WIN !== '0';
// Riyeser Payroll's installer is in the release from the first release after module/payroll was added.
const PAYROLL_WIN = process.env.PAYROLL_WIN !== '0'; // in the release since riyeser-2026.11.22-9
// Where the site lives: '/' on riyeser.com, '/Riyeser/' on the temporary github.io address (set by the publish workflow).
const BASE = process.env.SITE_BASE || '/';
const TERMS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'content', 'terms.html'), 'utf8');
// As Built (the web app). It runs at riyeser.com today; when it moves to app.riyeser.com, change this one line.
const SERVICES_APP = process.env.SERVICES_APP || 'https://riyeser.com';
const SERVICES_MOVED = !/^https:\/\/riyeser\.com\/?$/.test(SERVICES_APP);

const PROGRAMS = [
  { id: 'central', name: 'Riyeser Central', short: 'Central', icon: 'R', file: 'RiyeserCentral-Setup.exe',
    one: 'The home screen for your business: money owed, today\'s meetings, to-dos and recent files — and every Riyeser program one click away.',
    pitch: 'Start your day knowing exactly what needs doing.',
    shot: 'central-home.webp', shot2: 'central-home-dark.webp',
    features: [
      ['Money at a glance', 'What customers owe you, what\'s overdue, and the bills you need to pay — straight from Riyeser Accounting.'],
      ['Today & to-dos', 'Your meetings and to-do list in one place, so nothing slips.'],
      ['Find any file', 'One search box finds invoices, drawings and payslips by name, by the words inside, or by an old name.'],
      ['Recent documents', 'Pick up where you left off with the files you opened last.'],
      ['Only what you have', 'Shows just the programs you use — add more any time.'],
      ['Light or dark', 'A modern look that\'s easy on the eyes, day or night.'],
    ] },
  { id: 'invoices', name: 'Riyeser Invoices', short: 'Invoices', icon: '🧾', file: 'RiyeserInvoices-Setup.exe',
    one: 'Free invoicing for sole traders and small businesses: quotes, invoices, customers and getting paid. Free forever.',
    pitch: 'Send invoices and get paid. Free.',
    features: [
      ['Quotes and invoices', 'Professional quotes and tax invoices with your business details, and turn a quote into an invoice in one click.'],
      ['Customers', 'Keep every customer\'s details, invoices and statement in one place.'],
      ['Getting paid', 'Record payments, part payments and payments against several invoices at once.'],
      ['Who owes me', 'See who owes you and what\'s overdue at a glance.'],
      ['PDF copies', 'Save any invoice or quote as a PDF to send or print.'],
      ['Grows with you', 'Need stock, bills or reports? Accounting Basics opens the same company file, with everything already there.'],
    ],
    note: 'Riyeser Invoices is free forever: no time limit, no card and no invoice limit. It works on your PC, with no internet needed.' },
  { id: 'accounting-basics', name: 'Riyeser Accounting Basics', short: 'Accounting Basics', icon: '📗', file: 'RiyeserAccountingBasics-Setup.exe',
    one: 'Invoicing, quotes, customers and stock for shops and sole traders. Free for 90 days, then $20 a month per business.',
    pitch: 'Invoice, get paid and keep stock.',
    features: [
      ['Quotes → invoices → payments', 'Send quotes, turn them into invoices, and record payments against several invoices at once.'],
      ['Customers & suppliers', 'Contacts, bills and paying bills, with who owes you at a glance.'],
      ['Stock', 'Stock items with average cost, stocktakes and reorder alerts.'],
      ['Works with Riyeser POS', 'Selling at a counter? Add Riyeser POS, the till app. Every till sale shows here as a paid invoice, with stock and GST right.'],
      ['Money in & out', 'Record what you spend and receive, with GST worked out for you.'],
      ['Key reports', 'Profit & Loss, GST summary, who owes you, sales by customer and item, and stock reports.'],
    ],
    note: 'Need bank reconciliation, payroll or a Balance Sheet? Install Accounting Plus: it replaces Basics and opens your books exactly as they are.' },
  { id: 'accounting', name: 'Riyeser Accounting Plus', short: 'Accounting Plus', icon: '📒', file: 'RiyeserAccountingPlus-Setup.exe',
    one: 'Full double-entry books: everything in Basics plus banking, payroll, journals, jobs and budgets. +$20 a month on top of Basics, free for 90 days.',
    pitch: 'Know who owes you, and who you owe.',
    shot: 'accounting.webp',
    features: [
      ['Everything in Basics', 'Quotes, invoices, payments, customers, suppliers and stock. Works with Riyeser POS too.'],
      ['Banking', 'Spend and receive money, transfers, bank reconciliation and bank statement import.'],
      ['Payroll', 'Pay runs that post straight to the books, payslips and leave.'],
      ['GST / BAS', 'GST tax codes and a BAS summary (G1, 1A, 1B, W1, W2 and more).'],
      ['Journals, jobs & budgets', 'General journal, job costing and monthly budgets with Budget vs Actual.'],
      ['Every report', 'Profit & Loss, Balance Sheet, Trial Balance, aged receivables and payables, job P&L — print or export to Excel.'],
    ],
    note: 'Built for Australian small businesses. Have your accountant check your setup before relying on it for tax.' },
  { id: 'pos', name: 'Riyeser POS', short: 'POS', icon: '🧾', file: 'RiyeserPOS-Setup.exe',
    one: 'A touch-friendly till for retail shops or cafes and restaurants. Every sale goes straight into your books. Free for 90 days, then +$20 a month.',
    pitch: 'Sell at the counter. Books done automatically.',
    shot: 'pos-till.webp',
    features: [
      ['Retail or restaurant', 'Choose your setup in POS setup: barcode scanning and returns for shops, or tables, kitchen dockets and takeaway for cafes.'],
      ['Fast selling', 'Photo product tiles, Favourites, categories, search or scan, and Hold a sale to come back to it.'],
      ['Cash or card', 'A cash keypad that works out the change, card payments, and GST tax-invoice receipts.'],
      ['Named tills', 'Till 1, Bar, Front counter — each sale records which till took it.'],
      ['Straight into Accounting', 'Every sale is a proper invoice and payment, so stock, GST/BAS and reports update by themselves.'],
      ['Sales & Today', 'Today\'s takings, sales by hour and best sellers, with receipts and voids kept in the audit trail.'],
      ['Managers & close till', 'Manager PIN or card for voids, refunds and big discounts, then count the drawer and print the Z-report.'],
    ],
    note: 'Riyeser POS is its own app with its own installer. It opens the same company file as Riyeser Accounting Basics or Plus, so till sales show there as paid invoices. You don\'t need Accounting to use POS.' },
  { id: 'bookings', name: 'Riyeser Bookings', short: 'Bookings', icon: '📅', file: 'RiyeserBookings-Setup.exe',
    one: 'Book and schedule trades jobs, appointments or restaurant tables, then invoice them in one click. Free for 90 days, then +$20 a month.',
    pitch: 'Every job and appointment, on one calendar.',
    features: [
      ['Three kinds of business', 'Trades & site jobs at the customer\'s address, appointments at your place, or restaurant tables. Pick yours in Bookings setup.'],
      ['Day and week calendar', 'A column for each staff member or table. Click an empty time to book it.'],
      ['No double-booking', 'Riyeser warns you when a staff member or table is already taken, and checks a table has enough seats.'],
      ['Status at a glance', 'Booked, confirmed, in progress, done, cancelled or no-show, colour-coded on the calendar.'],
      ['Invoice in one click', '“Invoice this job” makes a real invoice, with the price of the service, in Riyeser Accounting or Invoices.'],
      ['Done, not invoiced yet', 'One list shows every finished job still waiting for an invoice, so nothing slips.'],
    ],
    note: 'Riyeser Bookings is its own app. It opens the same company file as Riyeser Accounting, Invoices and POS, so customers are shared and invoices land there straight away. Customers booking online is coming next.' },
  { id: 'payroll', name: 'Riyeser Payroll', short: 'Payroll', icon: '🕒', file: PAYROLL_WIN ? 'RiyeserPayroll-Setup.exe' : null,
    one: 'Time clock, timesheets, pay runs, payslips and leave — and export every payslip as a PDF in one click.',
    pitch: 'Pay day without the paperwork.',
    features: [
      ['Time clock', 'Staff tap their name and a 4-digit PIN to clock in and out; hours flow straight into timesheets.'],
      ['Timesheets', 'Review and approve each week\'s hours before the pay run.'],
      ['Pay runs', 'Weekly, fortnightly or monthly pay runs: preview first, then finalise, with PAYE and FNPF worked out from your pay rules.'],
      ['Payslips', 'Payslips with year-to-date totals. Print, email, or save them all as PDFs — one each or all in one.'],
      ['Leave', 'Annual and sick leave taken and left for every person.'],
      ['Bank statement check', 'Reads your bank statement and matches the wage payments that went out.'],
    ],
    note: 'Records stay on your computer, with a backup made every day. Check the PAYE and FNPF rates in Payroll rules against the current rules before you pay staff.' },
  { id: 'desk-assistant', name: 'Riyeser Desk Assistant', short: 'Desk Assistant', icon: '🗂', file: 'RiyeserDeskAssistant-Setup.exe',
    one: 'Sorts every file by type and year, finds anything in seconds, finds duplicates, and keeps your to-dos.',
    pitch: 'Never lose a file again.',
    shot: 'desk-find.webp',
    features: [
      ['Sort by type', 'Everything into Invoices › 2026, Drawings › 2026, Payroll › 2026… with a preview first and Undo after.'],
      ['Find a file', 'Search by name, by the words inside, by company, or by a name it used to have — with type and year filters.'],
      ['Copies found', 'Spots duplicates, even when one is a Word file and the other a PDF, and lets you archive the extras.'],
      ['Where are my files?', 'Every move is recorded. See where anything went — or put everything back with one button.'],
      ['Reads scans', 'Reads scanned PDFs and photos of receipts, so they can be filed and found too.'],
      ['Meetings & to-dos', 'Connect your calendar; action items from meeting notes land on your to-do list.'],
    ],
    note: 'Desk Assistant never touches Windows or program files — only your own documents.' },
  { id: 'team', name: 'Riyeser Team', short: 'Team chat', icon: '💬', file: 'RiyeserTeam-Setup.exe', link: '/team/?demo', linkLabel: 'Try the demo', shot: 'team-chat.webp',
    one: 'Team chat for your business: channels for jobs and the office, direct messages, and live updates on your PC and phone. Free.',
    pitch: 'Your whole team, in one conversation.',
    features: [
      ['Channels', 'A place for each topic: #jobs, #office, or one per site, for everyone in the team.'],
      ['Private chats', 'Executives, sales or managers only: choose exactly who is in. Nobody else can see the chat, or even that it exists.'],
      ['Direct messages', 'Private one-to-one chats. Only the two of you can read them.'],
      ['On the PC and the phone', 'The Riyeser Team app for Windows sits by the clock and starts with Windows, so calls and messages always reach you. On phones and tablets, use any web browser.'],
      ['Points at your work', 'Type INV-1047 or Booking 12 and it stands out, so everyone knows which invoice or job you mean.'],
      ['Unread at a glance', 'Unread counts on every channel and person, and on Team chat in Riyeser Central.'],
      ['Invite with a link', 'Send your team one link. They make a free account and they\'re in. You can make a new link any time.'],
      ['⭐ Team Chat Plus: branches and extensions', 'Each branch gets a number (Head office 100, your next branch 200) and its own join code. Staff who join with it get the next extension automatically.'],
      ['⭐ Team Chat Plus: call anyone', 'Call a person, dial an extension, or call a branch to ring everyone there: the first to answer takes it. Turn the camera on any time.'],
    ],
    note: 'Chat is free. Team Chat Plus is +$20 a month per business, free for 90 days: call any person or a whole branch, answer on any PC or phone you\'re signed in on, with no call charges. Each business only ever sees its own team.' },
  { id: 'pdf', name: 'Riyeser PDF', short: 'PDF', icon: '📕', file: 'RiyeserPDF-Setup.exe',
    one: 'Open, fill in, sign, combine and edit PDFs — even scanned ones.',
    pitch: 'Drawings and forms, done on the PC.',
    shot: 'pdf.webp',
    features: [
      ['Edit text', 'Change the words in a PDF, add text, highlight, underline and strike out.'],
      ['Fill & sign', 'Fill in forms, add your signature, ticks, crosses and today\'s date.'],
      ['Mark up drawings', 'Boxes, circles, arrows, lines and stamps — perfect for site drawings.'],
      ['Pages', 'Combine PDFs, reorder, rotate, extract and delete pages.'],
      ['Scans', 'Turn scanned pages into searchable, editable text.'],
      ['Convert', 'Make PDFs from pictures, Word and Excel — or turn a PDF back into Word.'],
    ] },
  { id: 'services', name: 'As Built', short: 'As Built', icon: '🏗', file: SERVICES_WIN ? 'RiyeserServices-Setup.exe' : null, link: `${SERVICES_APP}/?demo`, linkLabel: 'Try the demo',
    one: 'Map every cable, pipe and duct on your drawings as it goes in — with inspections, test results and photos — and the as-builts are done at handover.',
    pitch: 'Map every service while the building goes up.', custom: true },
];
// Short words for program cards and the Programs menu.
const CARD = {
  central: ['Your home screen: money owed, meetings, to-dos and every Riyeser program.', 'Home screen and updates'],
  invoices: ['Quotes, invoices, customers and getting paid. Free forever.', 'Free invoicing'],
  'accounting-basics': ['Invoices, quotes, customers and stock. Free for 90 days.', 'Invoicing and stock'],
  accounting: ['Full books: banking, reconciliation, BAS, payroll, journals, jobs and budgets.', 'Full books and banking'],
  pos: ['A touch-friendly till for shops, cafes and restaurants. Free for 90 days.', 'The till for shops and cafes'],
  bookings: ['Jobs, appointments and table bookings on one calendar, then invoice them.', 'Jobs, appointments, tables'],
  payroll: ['Time clock, timesheets, pay runs, payslips and leave.', 'Pay runs and payslips'],
  'desk-assistant': ['Sorts your files by type and year, and finds anything in seconds.', 'Sort and find your files'],
  team: ['Channels, direct messages and live updates for your whole team. Free.', 'Team chat'],
  pdf: ['Open, fill in, sign, mark up and combine PDFs, even scanned ones.', 'Fill, sign and edit PDFs'],
  services: ['Map cables, pipes and ducts on your plans, with inspections and photos.', 'Services on your drawings'],
};
for (const p of PROGRAMS) [p.card, p.tag] = CARD[p.id];
rmSync(OUT, { recursive: true, force: true });
const prog = (id) => PROGRAMS.find((p) => p.id === id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dl = (p) => (p.file ? `${RELEASES}/${p.file}` : p.link ? p.link : `mailto:${EMAIL}?subject=${encodeURIComponent(`Early access: ${p.name}`)}`);
const appImg = (id, up, cls = '') => `<img class="appicon i-${id}${cls ? ` ${cls}` : ''}" src="${up}assets/apps/${id}.png" alt="" width="80" height="80">`;
const iconBox = (p, up = '') => `<div class="icon i-${p.id}"><img src="${up}assets/apps/${p.id}.png" alt="" width="80" height="80"></div>`;
// Small inline icons for buttons (no emoji, so they look the same on every PC).
const svg = (d, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const DL = svg('<path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M5 20h14"/>');
const ARR = svg('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>', 'arr');
const WIN = svg('<path d="M3 5.5l7.5-1v7H3z"/><path d="M12.5 4.2L21 3v8.5h-8.5z"/><path d="M3 13h7.5v7L3 19z"/><path d="M12.5 13H21v8l-8.5-1.2z"/>');
const PLAY = svg('<path d="M7 5l12 7-12 7z"/>');
const MAIL = svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>');
const SEARCH = svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>');
const BOOK = svg('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>');
// Line icons (outlined, like the sample layouts). Each is the inside of a 24×24 SVG.
const LI = {
  pos: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 20h10M12 16v4M7 8h4M7 11h7"/>',
  central: '<rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 20.5h8M12 16.5v4"/><path d="M10 13V7h2.6a1.8 1.8 0 0 1 0 3.6H10M12.4 10.6L14.4 13"/>',
  'accounting-basics': '<rect x="4.5" y="2.5" width="15" height="19" rx="2"/><rect x="7" y="5" width="10" height="4" rx=".8"/><path d="M8 12.5h.01M12 12.5h.01M16 12.5h.01M8 15.5h.01M12 15.5h.01M16 15.5h.01M8 18.5h.01M12 18.5h.01M16 18.5h.01"/>',
  accounting: '<ellipse cx="15" cy="6" rx="6" ry="2.5"/><path d="M9 6v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6"/><path d="M21 10v4c0 1.4-2.7 2.5-6 2.5"/><ellipse cx="9" cy="14" rx="6" ry="2.5"/><path d="M3 14v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4"/>',
  payroll: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/><path d="M7.5 13h.01M12 13h.01M16.5 13h.01M7.5 16.5h.01M12 16.5h.01M16.5 16.5h.01"/>',
  'desk-assistant': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12.5" cy="13.5" r="2.6"/><path d="M14.5 15.5l2 2"/>',
  pdf: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/><path d="M7.5 17v-4h1.3a1.2 1.2 0 0 1 0 2.4H7.5M11.5 13v4h.9a2 2 0 0 0 0-4zM16.8 13h-1.9v4M14.9 15h1.6"/>',
  services: '<path d="M3 17.5h18"/><path d="M5 17.5a7 7 0 0 1 14 0"/><path d="M10 10.8V8a2 2 0 0 1 4 0v2.8"/><path d="M4 17.5v2h16v-2"/>',
  retail: '<path d="M3.5 9.5l1.5-5h14l1.5 5"/><path d="M3.5 9.5a2.2 2.2 0 0 0 4.3 0 2.2 2.2 0 0 0 4.2 0 2.2 2.2 0 0 0 4.2 0 2.2 2.2 0 0 0 4.3 0"/><path d="M5 11.5v9h14v-9"/><path d="M10 20.5v-5h4v5"/>',
  practice: '<rect x="4.5" y="2.5" width="15" height="19" rx="2"/><rect x="7" y="5" width="10" height="4" rx=".8"/><path d="M8 12.5h.01M12 12.5h.01M16 12.5h.01M8 15.5h.01M12 15.5h.01M16 15.5h.01M8 18.5h.01M12 18.5h.01M16 18.5h.01"/>',
  trades: '<path d="M3 17.5h18"/><path d="M5 17.5a7 7 0 0 1 14 0"/><path d="M10 10.8V8a2 2 0 0 1 4 0v2.8"/><path d="M4 17.5v2h16v-2"/>',
  rocket: '<path d="M5 15c-1.5 1.5-2 4.5-2 4.5s3-.5 4.5-2"/><path d="M14.5 4.5c2-1.5 5-2 6-1.5.5 1 0 4-1.5 6l-6.5 6.5-4.5-4.5z"/><path d="M8 11.5H4.5l2.5-3.5h4M12.5 16v3.5l3.5-2.5v-4"/><circle cx="16" cy="8" r="1.4"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 16.5l9 5 9-5"/>',
  download: '<path d="M12 3.5v11"/><path d="M7 10l5 5 5-5"/><path d="M4 19.5h16"/>',
  monitor: '<rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 20.5h8M12 16.5v4"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
};
const li = (k, cls = 'li') => svg(LI[k] || LI.layers, cls).replace('stroke-width="2.2"', 'stroke-width="1.7"');
const WINLOGO = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M2.5 4.6l8-1.1v7.9h-8zM11.6 3.4L21.5 2v9.4h-9.9zM2.5 12.6h8v7.9l-8-1.1zM11.6 12.6h9.9V22l-9.9-1.4z"/></svg>';
const WINDL = `${WINLOGO} Download for Windows`;
// Blue swooshes for the right-hand side of each page's top band.
const SWOOSH = `<svg class="swoosh" viewBox="0 0 600 300" preserveAspectRatio="xMaxYMid slice" aria-hidden="true"><defs><linearGradient id="sw1" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#7fb0ff"/><stop offset="1" stop-color="#2f7bff"/></linearGradient><linearGradient id="sw2" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#2f7bff"/><stop offset="1" stop-color="#0846d8"/></linearGradient></defs>
<path d="M330 300C380 170 450 60 600 40V0H560C430 20 340 150 270 300z" fill="#bcd5ff" opacity=".7"/><path d="M420 300C460 190 520 110 600 95V40C470 60 390 170 340 300z" fill="url(#sw1)" opacity=".85"/><path d="M500 300C530 230 565 185 600 170V95C530 115 470 200 430 300z" fill="url(#sw2)"/></svg>`;
const bandHero = ({ eyebrow, title, lead, img = '', up = '', extra = '' }) => `<div class="band-hero">${img ? `<img class="bgimg" src="${up}assets/photos/${img}" alt="">` : SWOOSH}<div class="c"><div class="inner">${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ''}<h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}${extra}</div></div></div>`;
// The three industries: real photos, and only what the programs really do.
const INDUSTRIES = [
  { id: 'retail', name: 'Retail & hospitality', icon: 'retail', photo: 'team-cafe.webp', short: 'Manage stock, sales records and staff pay.',
    title: 'Retail & Hospitality', lead: 'Sell at the counter, keep stock under control and pay your staff, from one Windows PC.',
    h: 'Sales, stock and staff pay', p: 'Ring up sales on Riyeser POS, keep count of stock as it sells, and pay your team from their clock-in hours.',
    shot: 'accounting.webp', shotName: 'Riyeser Accounting', shotApp: 'accounting-basics', cta: ['accounting-basics', 'Explore Accounting Basics'],
    progs: [['bookings', ['Table bookings with party size and seats checked', 'See tonight at a glance, table by table', 'Customers shared with Riyeser POS']],
      ['pos', ['A till for retail or restaurant: tables, kitchen dockets and held sales', 'Receipts print by themselves; close the till with cash and card totals', 'Manager PIN or card for voids, refunds and big discounts', 'Free for 90 days, no card']],
      ['accounting-basics', ['Every till sale lands as a paid invoice, with GST right', 'Stock with average cost, stocktakes and reorder alerts', 'Free for 90 days, no card']],
      ['payroll', ['Staff clock in and out with a 4-digit PIN', 'Timesheets flow straight into the pay run', 'Payslips with year-to-date totals, printed, emailed or saved as PDFs']],
      ['central', ['What customers owe and what you owe, as soon as you open it', "Today's meetings and your to-do list", 'Every Riyeser program one click away']]] },
  { id: 'accounting', name: 'Accounting practices', icon: 'practice', photo: 'team-office.webp', short: 'Keep client books and pay runs organised.',
    title: 'Accounting Practices', lead: "Keep every client's books, pay runs and paperwork organised, with one sign-in.",
    h: 'Client books, one sign-in', p: "Run a separate company file for each client, switch between them from the top of the screen, and see everyone's cash, money owed and profit on one page.",
    shot: 'accounting.webp', shotName: 'Riyeser Accounting Plus', shotApp: 'accounting', cta: ['accounting', 'Explore Accounting Plus'],
    progs: [['accounting', ['Several companies with one sign-in, and an overview of them all', 'Bank reconciliation, statement import and BAS / GST figures', 'Lock a period after the BAS is lodged', 'Quick access sets: Owner, Bookkeeper, Payroll officer, Read-only']],
      ['desk-assistant', ['Files every invoice and statement by company, type and year', 'Find any file by a word inside it or an old name', 'Undo any tidy-up, and nothing is ever deleted']],
      ['pdf', ['Fill in and sign forms', 'Combine, split and reorder pages', 'Black out bank details before you send']]] },
  { id: 'trades', name: 'Trades & construction', icon: 'trades', photo: 'trades.webp', short: 'Track installations, inspections and handovers.',
    title: 'Trades & Construction', lead: 'Service mapping and inspections for trades and construction projects, with clear plans and on-site markups.',
    h: 'Service mapping and inspections', p: 'Map services on your plans as they go in, and carry out inspections with clear, marked-up drawings for the job.',
    shot: 'services-trace.webp', shotName: 'As Built', shotApp: 'services', cta: ['services', 'Explore As Built'], photoTall: 'team-site-plans.webp',
    progs: [['bookings', ['Jobs at the customer\'s address, given to your staff', 'A day view for every tradie, with no double-booking', 'Invoice the job in one click when it\'s done']],
      ['services', ['Cables, pipes and ducts drawn on your PDF plans, end to end', 'Inspections, test results and photos on every item', 'Works with no signal on site; as-builts ready at handover']],
      ['pdf', ['Mark up drawings with clouds, arrows, boxes and stamps', 'Fill in and sign site forms', 'Read scanned drawings so they can be searched']],
      ['desk-assistant', ['Files drawings, quotes and invoices by type and year', 'Spots duplicate copies of the same drawing', 'Find any file in seconds']]] },
];
const indLink = (i, up) => `${up}industries/${i.id}.html`;
// The Riyeser Central window on the home page, drawn in HTML so it stays sharp at any size (sample figures).
const CI = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.6 3-5.5 6-5.5s5.4 1.9 6 5.5M16 4.5a3 3 0 0 1 0 6M18 14.5c1.7.6 2.8 2.4 3 5.5"/>',
  invoice: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  pdf: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7M12 17h.01"/>',
};
const ci = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${CI[k]}</svg>`;
const centralMock = (up) => `<div class="cmock-wrap" aria-label="Riyeser Central home screen" role="img"><div class="cmock">
  <div class="cm-side"><div class="cm-logo"><img src="${up}assets/logo-r.png" alt="">Riyeser Central</div>
    <span class="on">${ci('home')}Home</span><span>${ci('book')}Books</span><span>${ci('people')}Payroll</span><span>${ci('invoice')}Invoices</span><span>${ci('folder')}Desk Assistant</span><span>${ci('pdf')}PDF</span>
    <hr><span>${ci('key')}Licence</span><span>${ci('help')}Help</span></div>
  <div class="cm-main"><div class="cm-ctl"><i></i><i></i><i></i></div>
    <b class="cm-hi">Good morning.</b><small class="cm-sub">Your business at a glance in Riyeser Central.</small>
    <div class="cm-cards">
      <div><em class="k1">${ci('book')}</em><b>Books</b><small>$2,450 owed to you</small></div>
      <div><em class="k2">${ci('people')}</em><b>Payroll</b><small>Run payroll and manage staff</small></div>
      <div><em class="k3">${ci('pdf')}</em><b>PDF</b><small>Fill in, sign and combine</small></div>
    </div>
    <div class="cm-act"><div class="cm-h"><b>Recent activity</b><span>View all ›</span></div>
      <div class="cm-row">${ci('invoice')}<span>Invoice INV-1047 created</span><small>Today, 10:24 AM</small></div>
      <div class="cm-row">${ci('people')}<span>Pay run for week ending 21 Nov prepared</span><small>Today, 9:17 AM</small></div>
      <div class="cm-row">${ci('pdf')}<span>Site plan level 2 signed</span><small>Yesterday, 4:32 PM</small></div>
    </div></div>
</div></div>`;
// The home page picture: the real Riyeser Central 1.6 home screen on a laptop, with two moments from Bookings and Invoices.
const heroShot = (up) => `<div class="hshot">
  <div class="lap"><div class="lap-scr"><img src="${up}assets/central-hero.webp" alt="Riyeser Central home screen: bookings, money owed, POS, payroll and PDF in one place, with recent activity and shortcuts" width="2560" height="1600" fetchpriority="high"></div><div class="lap-base"></div></div>
  <div class="hfloat f1"><img src="${up}assets/apps/bookings.png" alt="" width="40" height="40"><div><small>Riyeser Bookings</small><b>Jo Smith · 10:00 today</b><span>Hot water service · Confirmed</span></div></div>
  <div class="hfloat f2"><img src="${up}assets/apps/invoices.png" alt="" width="40" height="40"><div><small>Riyeser Invoices</small><b>INV-1047 paid</b><span class="ok">$880.00 received</span></div></div>
</div>`;
// Real-life photos with little pop-ups from the programs (sample figures). One scene per program and industry.
const SCENES = {
  home: { img: 'team-workshop.webp', alt: 'Two people in a workshop checking their business on a laptop', pops: [
    ['bookings', 'Riyeser Bookings', 'Jo Smith · 10:00 today', 'Hot water service · Confirmed', ''],
    ['invoices', 'Riyeser Invoices', 'INV-1047 paid', '$880.00 received', 'ok'],
    ['payroll', 'Riyeser Payroll', 'Pay run done', '4 staff · $6,240.50 net', '']] },
  bookings: { img: 'team-site-plans.webp', alt: 'Two tradespeople on site checking the day\'s jobs on a tablet', pops: [
    ['bookings', 'New job booked', 'Thu 7:30 · Lot 7 Hill Rd', 'Jordan · Hot water service', ''],
    ['invoices', 'Job done', 'Invoice INV-1053 made', '$450.00 · sent to customer', 'ok']] },
  invoices: { img: 'team-workshop.webp', alt: 'Two people in a workshop sending an invoice from a laptop', pops: [
    ['invoices', 'Quote accepted', 'Q-0042 → INV-1054', 'Harbour Cafe · $1,320.00', ''],
    ['invoices', 'Payment received', 'INV-1047 paid', '$880.00 · thank you sent', 'ok']] },
  'accounting-basics': { img: 'team-warehouse.webp', alt: 'A shop owner packing orders next to a laptop', pops: [
    ['accounting-basics', 'Stock received', '24 × Gift box (large)', 'Average cost updated', ''],
    ['accounting-basics', 'Reorder alert', 'Packing tape is low', '6 left · reorder at 10', 'warn']] },
  accounting: { img: 'team-office.webp', alt: 'A bookkeeper and a business owner going through the books on a laptop', pops: [
    ['accounting', 'GST / BAS', 'BAS figures ready', 'Oct–Dec · G1, 1A and 1B worked out', ''],
    ['accounting', 'Bank reconciled', 'Everything matched', '0 left to match · Nov', 'ok']] },
  pos: { img: 'team-cafe.webp', alt: 'Two cafe owners checking the day\'s takings on a laptop', pops: [
    ['pos', 'Riyeser POS', 'Sale · $14.50 · Card', 'Flat white, banana bread', ''],
    ['bookings', 'Riyeser Bookings', 'Table 4 · 7:00 pm', '6 people · Confirmed', 'ok']] },
  team: { img: 'team-site-laptop.webp', alt: 'A site supervisor and an electrician catching up with the team on a laptop', pops: [
    ['team', '#jobs · Jordan Lee', 'Booking 12 done ✅', 'New unit installed and tested', ''],
    ['team', 'Direct message · Sam', 'Can you approve timesheets?', 'Pay run goes tonight', '']] },
  payroll: { img: 'team-site-laptop.webp', alt: 'A site supervisor and an electrician approving timesheets on a laptop', pops: [
    ['payroll', 'Timesheets approved', 'Week ending 21 Nov', '4 staff · 152 hours', ''],
    ['payroll', 'Pay run done', '$6,240.50 net', 'Payslips saved as PDFs', 'ok']] },
};
const photoPop = (key, up, cls = '') => { const sc = SCENES[key]; if (!sc) return ''; return `<div class="pscene ${cls}">
  <img class="pscene-img" src="${up}assets/photos/${sc.img}" alt="${esc(sc.alt)}" width="1206" height="530"${cls === 'big' ? ' fetchpriority="high"' : ' loading="lazy"'}>
  ${sc.pops.map(([app, k, b, sub, tone], i) => `<div class="hfloat pf${i + 1}"><img src="${up}assets/apps/${app}.png" alt="" width="40" height="40"><div><small>${esc(k)}</small><b>${esc(b)}</b><span class="${tone}">${esc(sub)}</span></div></div>`).join('')}
</div>`; };
const winFrame = (up, app, name, img, alt, w = 1400, h = 900) => `<div class="win"><div class="bar"><img src="${up}assets/${app === 'logo' ? 'logo-r.png' : `apps/${app}.png`}" alt="">${esc(name)}<span class="ctl">${svg('<path d="M5 12h14"/>')}${svg('<rect x="5" y="5" width="14" height="14" rx="1"/>')}${svg('<path d="M6 6l12 12M18 6L6 18"/>')}</span></div><img src="${up}assets/${img}" alt="${esc(alt)}" width="${w}" height="${h}"></div>`;
const progCard = (p, up) => `<a class="card" href="${up}programs/${p.id}.html">${badgeOf(p)}${iconBox(p, up)}<h3>${esc(p.short === 'Central' ? 'Riyeser Central' : p.short)}</h3><p>${esc(p.card || p.one)}</p><span class="go">${ARR}</span></a>`;

const more = (t) => `<span class="more">${t} ${ARR}</span>`;
const FREE_TOOLS = ['central', 'invoices', 'team', 'desk-assistant', 'pdf'];
const badgeOf = (p) => FREE_TOOLS.includes(p.id) ? '<span class="badge free">Free forever</span>' : '<span class="badge">Free trial</span>';

/** assets/x.webp -> assets/x.webp?v=<content hash>, so browsers fetch new pictures and styles as soon as they change. */
const versionOf = {};
function withVersions(html) {
  return html.replace(/(assets\/[\w./-]+\.(?:webp|png|css))(?=["'\s)])/g, (m, a) => {
    if (!(a in versionOf)) { try { versionOf[a] = createHash('sha1').update(readFileSync(join(ROOT, a))).digest('hex').slice(0, 8); } catch { versionOf[a] = ''; } }
    return versionOf[a] ? `${a}?v=${versionOf[a]}` : a;
  });
}

function page({ path, title, description, active, body }) {
  const depth = path.split('/').length - 1;
  const up = depth ? '../'.repeat(depth) : '';
    const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8"><meta name="color-scheme" content="light">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/assets/central-home.webp"><meta property="og:url" content="${SITE}/${path === 'index.html' ? '' : path}">
<link rel="canonical" href="${SITE}/${path === 'index.html' ? '' : path}">
<link rel="icon" href="${up}assets/logo-r.png">
<link rel="stylesheet" href="${up}assets/site.css">
${path === 'index.html' && SERVICES_MOVED ? `<script>/* As Built now lives at ${SERVICES_APP}/ - forward its old links: demo and sign-in links,
   project and QR links (#/p/...), sign-in emails (#access_token, ?code=) and the installed app (start screen icon). */
(function(){var s=location.search,h=location.hash,app=false;try{app=matchMedia('(display-mode: standalone)').matches}catch(e){}
if(/[?&](demo|signin|code|error|token_hash|type)\\b/.test(s)||/^#(\\/|access_token|error|type=|refresh_token)/.test(h)||/[&#](access_token|type=recovery)/.test(h)||app)
location.replace(${JSON.stringify(SERVICES_APP)}+'/'+s+h)})()</script>` : ''}
</head>
<body>
<header class="nav" id="nav"><div class="c">
  <a class="logo" href="${up}index.html"><img src="${up}assets/logo-r.png" alt="">Riyeser</a>
  <nav class="links">
    <div class="dd"><a href="${up}programs.html"${active === 'programs' ? ' class="on"' : ''}>Programs ${svg(LI.down)}</a><div class="menu-pop">${PROGRAMS.map((p) => `<a href="${up}programs/${p.id}.html">${appImg(p.id, up, 'mi')}<span>${esc(p.short === 'Central' ? 'Riyeser Central' : p.short)}<small>${esc(p.tag || '')}</small></span></a>`).join('')}<a class="all" href="${up}programs.html">All programs ${ARR}</a></div></div>
    <div class="dd"><a href="${indLink(INDUSTRIES[0], up)}"${active === 'industries' ? ' class="on"' : ''}>Industries ${svg(LI.down)}</a><div class="menu-pop">${INDUSTRIES.map((i) => `<a href="${indLink(i, up)}"><span class="li">${li(i.icon, '')}</span><span>${esc(i.name)}<small>${esc(i.short)}</small></span></a>`).join('')}</div></div>
    <a href="${up}pricing.html"${active === 'pricing' ? ' class="on"' : ''}>Pricing</a>
    <div class="dd"><a href="${up}help.html"${active === 'help' ? ' class="on"' : ''}>Help ${svg(LI.down)}</a><div class="menu-pop">${helpGuides({ EMAIL, SERVICES_APP, up }).map((g) => `<a href="${up}help/${g.id}.html"><img class="appicon i-${g.app}" src="${up}assets/apps/${g.app}.png" alt="" style="width:30px;height:30px;border-radius:8px">${esc(g.name)}</a>`).join('')}<a class="all" href="${up}help.html">Help Centre ${ARR}</a></div></div>
    <a href="${up}downloads.html"${active === 'downloads' ? ' class="on"' : ''}>Downloads</a>
    <a class="mob-only" href="/team/">Sign in / Create account</a>
  </nav>
  <div class="right"><a class="signin" href="/team/">Sign in<span class="sx"> / Create account</span></a><a class="btn p" href="${up}downloads.html">${WINDL}</a></div>
  <button class="menu" aria-label="Menu" aria-expanded="false" onclick="var n=document.getElementById('nav');n.classList.toggle('open');this.setAttribute('aria-expanded',n.classList.contains('open'))">☰</button>
</div></header>
<script>/* phone menu: a tap on Programs, Industries or Help opens its list right there (a second tap goes to the page) */
document.querySelectorAll('.links > .dd > a').forEach(function(a){a.addEventListener('click',function(e){
  var nav=document.getElementById('nav');if(!nav.classList.contains('open'))return;var d=a.parentNode;
  if(!d.classList.contains('show')){e.preventDefault();document.querySelectorAll('.links > .dd.show').forEach(function(x){if(x!==d)x.classList.remove('show')});d.classList.add('show')}})});
</script>
<main>${body(up)}</main>
<footer><div class="c">
  <div class="fcols">
    <div><a class="logo" href="${up}index.html"><img src="${up}assets/logo-r.png" alt="">Riyeser</a><p style="margin:0;max-width:300px">Windows software for small businesses. Work offline and keep your records on your PC.</p></div>
    <div><h4>Programs</h4>${PROGRAMS.map((p) => `<a href="${up}programs/${p.id}.html">${p.short === 'Central' ? 'Riyeser Central' : p.short}</a>`).join('')}</div>
    <div><h4>Industries</h4>${INDUSTRIES.map((i) => `<a href="${indLink(i, up)}">${esc(i.name)}</a>`).join('')}</div>
    <div><h4>Help</h4><a href="${up}help.html">Help Centre</a><a href="${up}help/start.html">Getting started</a><a href="${up}downloads.html">Downloads</a><a href="mailto:${EMAIL}">${EMAIL}</a></div>
    <div><h4>Riyeser</h4><a href="${up}pricing.html">Pricing</a><a href="/team/?signup">Create an account</a><a href="${up}terms.html">Terms of use</a></div>
  </div>
  <div class="fbase"><span>© ${new Date().getFullYear()} Riyeser Group</span><span>For Windows 10 &amp; 11 · Works offline · No account or card needed</span></div></div></footer>
<script>/* Download buttons always point at the newest release file, whatever its exact name. */
(function(){var a=[].slice.call(document.querySelectorAll('a[href*="/releases/latest/download/"]'));if(!a.length||!window.fetch)return;
fetch('https://api.github.com/repos/raka1987/Riyeser/releases/latest').then(function(r){return r.ok?r.json():null}).then(function(rel){if(!rel)return;
a.forEach(function(el){var want=el.href.split('/').pop().replace(/^Riye?ser/i,'').toLowerCase();
var hit=(rel.assets||[]).filter(function(x){return x.name.replace(/^Riye?ser/i,'').toLowerCase()===want})[0];if(hit)el.href=hit.browser_download_url;});}).catch(function(){});})();</script>
</body>
</html>
`;
  const file = join(OUT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, withVersions(html));
}

const freeLine = 'Free download · no sign-up · no card · works offline';

// Riyeser Accounting comes in two editions: one download, the licence decides which one you get.
const EDITIONS = [
  { name: 'Accounting Basics', price: '$20', small: 'a month per business · 3 users included', tag: 'Free for 90 days',
    blurb: 'Everything a small shop or sole trader needs to invoice and keep stock.',
    has: ['Quotes, invoices and receiving payments', 'Customers, suppliers and bills', 'Stock items, stocktake and reorder alerts',
      'Simple money in and money out', 'Works with Riyeser POS, the till app', 'Profit & Loss, GST summary, who owes you, sales and stock reports'] },
  { name: 'Accounting Plus', price: '+$20', small: 'a month on top of Basics', tag: 'Free for 90 days',
    blurb: 'Everything in Basics, plus the tools for full books.',
    has: ['Everything in Accounting Basics', 'Bank reconciliation and bank statement import', 'Payroll and pay runs',
      'General journal and search transactions', 'Jobs and budgets', 'Balance Sheet, Trial Balance and every report'] },
];
const editionsBlock = (up, { download = true } = {}) => `
<div class="plans eds">${EDITIONS.map((e, i) => `<div class="plan${i ? ' best' : ''}"><span class="tag">${esc(e.tag)}</span><div class="k">${appImg(i ? 'accounting' : 'accounting-basics', up)}${esc(e.name)}</div>
  <div class="price">${esc(e.price)}<small> ${esc(e.small)}</small></div><p>${esc(e.blurb)}</p>
  <ul class="edlist">${e.has.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>`).join('')}</div>
<p class="sub" style="margin-top:16px">Two separate apps that open the same books. Move up to Plus or back down to Basics any time: install the other one and it replaces the first, with all your customers, invoices and stock carried over. Plus-only records (payroll, journals, jobs, budgets) are kept safe in Basics and come back in Plus.</p>
${download ? `<div class="ctas" style="justify-content:flex-start;margin-top:6px"><a class="btn s" href="${RELEASES}/RiyeserAccountingBasics-Setup.exe">${DL} Download Accounting Basics — 90 days free</a><a class="btn p" href="${RELEASES}/RiyeserAccountingPlus-Setup.exe">${DL} Download Accounting Plus — 90 days free</a></div>` : ''}`;
const ctaBlock = (up, title = 'Try Riyeser free', text = 'Download, install in one click, and keep everything on your own computer.') => `
<section class="c" style="padding-bottom:0"><div class="cta"><h2>${title}</h2><p>${text}</p>
<div class="ctas"><a class="btn t big" href="${up}downloads.html">${WINDL}</a><a class="btn glass big" href="${up}help.html">Help Centre</a></div>
<p class="fine">Windows 10 &amp; 11 · Free tools forever · paid programs free to start · no card</p></div></section>`;

// ---------- home ----------
page({
  path: 'index.html', title: 'Riyeser — the everyday tools your business runs on', active: '',
  description: 'Windows software for small businesses: accounting, payroll, file finding, PDFs and job records. Work offline and keep your records on your PC. No account or card needed.',
  body: (up) => `
<div class="hero hero2"><div class="c">
  <div>
    <h1>The everyday tools your business runs on.</h1>
    <p class="lead">Books, payroll and job records. On your Windows PC.</p>
    <div class="ctas"><a class="btn p big" href="${up}downloads.html">${WINDL}</a><a class="tlink" href="#find">Explore programs</a></div>
    <p class="fine">Windows 10 &amp; 11 · No account or card needed · Works offline</p>
    <div class="badges"><span class="chip">${svg('<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>')}Free tools + 90-day trials</span><span class="chip">${svg('<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>')}Your data stays on your PC</span>${EARLY_BIRD ? `<a class="chip gold" href="${up}pricing.html#early">🐣 Early bird: 50% off your first year</a>` : ''}</div>
  </div>
  ${photoPop('home', up, 'big')}
</div></div>

<section class="finder" id="find"><div class="c">
  <h2 class="h2">Find your program</h2>
  <div class="frow">${PROGRAMS.map((p) => `<a href="${up}programs/${p.id}.html"><img src="${up}assets/apps/${p.id}.png" alt="" width="96" height="96" loading="lazy"><span>${esc(p.short === 'Central' ? 'Central' : p.short)}</span></a>`).join('')}</div>
</div></section>

<section class="c">
  <h2 class="h2">Built for your industry</h2>
  <p class="sub">Pick what sounds like you. Install only what you need; every program shares one home screen.</p>
  <div class="inds2">${INDUSTRIES.map((i) => `<a class="ind2" href="${indLink(i, up)}"><img src="${up}assets/photos/${i.photoTall || i.photo}" alt="" loading="lazy" width="500" height="300"><div class="t"><h3>${esc(i.title)}</h3><i></i></div><p>${esc(i.short)} <b>Learn more ${ARR}</b></p></a>`).join('')}</div>
</section>

<section class="c" style="padding-top:0" id="programs">
  <span class="eyebrow">Programs</span>
  <h2 class="h2">One home screen. Every program you need.</h2>
  <p class="sub">Start with Riyeser Central, then add the programs you use. They all show up in Central.</p>
  <div class="grid">${PROGRAMS.map((p) => progCard(p, up)).join('')}
    <a class="card" href="${up}help.html">${li('rocket')}<h3>Help Centre</h3><p>Plain-English, step-by-step guides for every program.</p><span class="go">${ARR}</span></a></div>
</section>

<section class="band-hero" id="how" style="border-top:1px solid var(--line)"><div class="c">
  <span class="eyebrow">How it works</span>
  <h2 class="h2">Up and running in three minutes</h2>
  <p class="sub">No account, no card and no admin password.</p>
  <div class="steps3">
    <div class="step"><span class="n">1</span>${li('download')}<div><h3>Download</h3><p>Get Riyeser Central for Windows.</p></div></div><span class="to">${ARR}</span>
    <div class="step"><span class="n">2</span>${li('monitor')}<div><h3>Install</h3><p>It installs itself in a few seconds, just for you.</p></div></div><span class="to">${ARR}</span>
    <div class="step"><span class="n">3</span>${li('layers')}<div><h3>Add programs</h3><p>Choose the Riyeser programs you need. Central keeps them updated.</p></div></div>
  </div>
</div></section>

<section class="c">
  <div class="safe">
    <div><span class="k">Your business, your computer</span><h2>Safe by design</h2>
      <p>Your books, staff records and files stay on your own PC, not on someone else's server. Nothing is deleted without asking, and almost everything can be undone.</p></div>
    <ul class="ticks" style="margin:0"><li>Works with no internet: on site, in the car, anywhere</li><li>Forgot your password? Reset it on the PC without losing anything</li><li>Payroll keeps a backup every day</li><li>Desk Assistant records every file it moves, with “Put everything back”</li><li>Want online access too? As Built can sync to an online account when you choose</li></ul>
  </div>
</section>

<section class="c" style="padding-top:0;max-width:920px">
  <h2 class="h2 center">Frequently asked questions</h2>
  <div class="faq" style="margin-top:26px">
  <details><summary>What does it cost?</summary><p>Riyeser Central, Riyeser Invoices, PDF and the Desk Assistant file organiser are free forever. Every paid program is free for 90 days with no card. After that, Accounting Basics is $20 a month per business — not per person — and Accounting Plus, Payroll, POS and Bookings are +$20 a month each. As Built, for the building industry, is $20 a month on its own. 2 months are free if you pay yearly. See <a class="more" href="${up}pricing.html">Pricing</a>.</p></details>
  <details><summary>Does it need the internet?</summary><p>No. Everything works offline. As Built can optionally sync to an online account so phones, clients and staff can see your projects.</p></details>
  <details><summary>What computer do I need?</summary><p>A PC with Windows 10 or 11. As Built also works in any web browser, on phones and tablets.</p></details>
  <details><summary>Where do I start?</summary><p>Download Riyeser Central. It's the home screen for every program and shows you what else you can add. The <a class="more" href="${up}help/start.html">Getting started guide</a> walks you through it.</p></details>
  <details><summary>What if I get stuck?</summary><p>The <a class="more" href="${up}help.html">Help Centre</a> has a step-by-step guide for every program, or email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a> and a real person will reply.</p></details>
  </div>
</section>
${ctaBlock(up, 'Get started free today', 'Download Riyeser Central, add the programs you need, and keep everything on your own computer.')}`,
});

// ---------- all programs ----------
page({
  path: 'programs.html', title: 'All programs — Riyeser', active: 'programs',
  description: 'Every Riyeser program: Central, Invoices, Bookings, Team chat, Accounting Basics, Accounting Plus, Payroll, Desk Assistant, PDF and As Built.',
  body: (up) => `${bandHero({ eyebrow: 'Programs', title: 'All programs', lead: 'A complete range of Riyeser programs to run and support your business. Start with Riyeser Central and add what you need.' })}
<section class="c" style="padding-top:44px"><div class="grid">${PROGRAMS.filter((p) => p.id !== 'services').map((p) => progCard(p, up)).join('')}</div></section>
<section class="c" style="padding-top:0"><h2 class="h2">For the building industry</h2><p class="sub">A separate program for trades and construction, priced on its own.</p><div class="grid">${progCard(prog('services'), up)}</div></section>
<section class="c" style="padding-top:0"><h2 class="h2">Accounting Basics or Accounting Plus?</h2>${editionsBlock(up)}</section>
${ctaBlock(up, 'Start with Riyeser Central', "It's the home screen for every program, and it keeps them all up to date.")}`,
});

// ---------- industries ----------
for (const ind of INDUSTRIES) {
  page({
    path: `industries/${ind.id}.html`, title: `${ind.name} — Riyeser`, active: 'industries',
    description: `${ind.title}: ${ind.lead}`,
    body: (up) => `${bandHero({ eyebrow: 'Industries', title: esc(ind.title), lead: esc(ind.lead) })}
<div class="c">
  <div class="itabs">${INDUSTRIES.map((o) => `<a href="${indLink(o, up)}"${o.id === ind.id ? ' class="on" aria-current="page"' : ''}>${li(o.icon, '')}${esc(o.title)}</a>`).join('')}</div>
  <div class="ind-split">
    <div class="t"><h2>${esc(ind.h)}</h2><p>${esc(ind.p)}</p>
      <a class="btn p" href="${up}programs/${ind.cta[0]}.html">${esc(ind.cta[1])} ${ARR}</a>
      <div class="photo-card"><img src="${up}assets/photos/${ind.photoTall || ind.photo}" alt="" width="500" height="300" style="width:100%;max-height:300px;object-fit:cover"></div></div>
    ${winFrame(up, ind.shotApp, ind.shotName, ind.shot, `${ind.shotName} screenshot`)}
  </div>
</div>
<section class="c"><h2 class="h2">The programs that help</h2><p class="sub">What each one does for ${esc(ind.name.toLowerCase())}.</p>
  <div class="progrow">${[...ind.progs].sort((x, y) => PROGRAMS.findIndex((p) => p.id === x[0]) - PROGRAMS.findIndex((p) => p.id === y[0])).map(([id, pts]) => { const p = prog(id); return `<a class="card" href="${up}programs/${id}.html">${badgeOf(p)}${iconBox(p, up)}<h3>${esc(p.short === 'Central' ? 'Riyeser Central' : p.short)}</h3><ul class="ticks">${pts.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>${more('Learn more')}</a>`; }).join('')}</div>
</section>
${ctaBlock(up, `Try Riyeser for ${esc(ind.name.toLowerCase())}`, 'Download Riyeser Central, add the programs above, and keep everything on your own computer.')}`,
  });
}

// ---------- As Built sign in (hands over to the real sign-in in the Services app) ----------
// ---------- program pages ----------
for (const p of PROGRAMS.filter((x) => !x.custom)) {
  page({
    path: `programs/${p.id}.html`, title: `${p.name} — ${p.pitch}`, active: 'programs',
    description: `${p.name}: ${p.one}`,
    body: (up) => `
<div class="hero"><div class="c">
  <div>
    <div class="phead-who" style="display:flex;align-items:center;gap:18px;margin-bottom:18px">${iconBox(p, up)}<div><span class="eyebrow" style="margin:0">${esc(p.name)}</span>${badgeOf(p)}</div></div>
    <h1>${esc(p.pitch)}</h1><p class="lead">${esc(p.one)}</p>
    <div class="ctas">${p.file ? `<a class="btn p big" href="${dl(p)}">${WINDL}</a>` : `<a class="btn p big" href="${dl(p)}">${p.link ? esc(p.linkLabel) : 'Get early access'}</a>`}<a class="tlink" href="${up}help/${p.id}.html">How to use it</a></div>
    ${p.file ? `<p class="fine">Windows 10 &amp; 11 · No account or card needed</p>` : ''}
  </div>
  ${p.shot ? winFrame(up, p.id, p.name, p.shot, `${p.name} screenshot`, ...(p.id === 'central' ? [1440, 900] : [])) : `<div class="placeholder">${appImg(p.id, up)}</div>`}
</div></div>
${SCENES[p.id] ? `<section class="c scene-sec"><span class="eyebrow">In real life</span>${photoPop(p.id, up)}</section>` : ''}
${p.id.startsWith('accounting') ? `<section class="c" id="editions"><h2 class="h2">Accounting Basics or Accounting Plus</h2>${editionsBlock(up, { download: false })}</section>` : ''}
<section class="c"${p.id.startsWith('accounting') ? ' style="padding-top:0"' : ''}><span class="eyebrow">Features</span><h2 class="h2">What it does</h2><p class="sub">${esc(p.one)}</p>
  <div class="fgrid">${p.features.map(([h, t], i) => `<div class="f"><div class="fi">${i + 1}</div><h4>${esc(h)}</h4><p>${esc(t)}</p></div>`).join('')}</div>
  ${p.shot2 ? `<div style="margin-top:40px">${winFrame(up, p.id, p.name, p.shot2, `${p.name} in dark mode`, 1440, 900)}</div>` : ''}
  ${p.note ? `<p class="note" style="margin-top:28px">${esc(p.note)}</p>` : ''}
</section>
<section class="c" style="padding-top:0"><h2 class="h2">Works even better together</h2><p class="sub">Every Riyeser program shows up in Riyeser Central, your home screen for the whole business.</p>
  <div class="grid three">${PROGRAMS.filter((o) => o.id !== p.id).slice(0, 3).map((o) => progCard(o, up)).join('')}</div>
</section>
${ctaBlock(up, p.file ? `Get ${p.name}` : 'Start with Riyeser Central')}`,
  });
}

// ---------- As Built (content carried over from the original riyeser.com homepage and FAQ) ----------
{
  const p = prog('services');
  const TRADES = [['Data and comms', 'Fibre, copper, racks and every port'], ['Electrical', 'Boards, circuits, outlets and test results'], ['Fire', 'Detection, sprinklers, hydrants and panels'],
    ['Water', 'Mains, valves, meters and fixtures'], ['Drainage', 'Sewer, stormwater, pits and falls'], ['Mechanical', 'Ducts, refrigerant, plant and controls'], ['Security', 'Cameras, readers, locks and alarms'],
    ['Audio visual', 'Speakers, displays and control'], ['Gas', 'Mains, meters and shut-offs'], ['Risers and trenches', 'How services move between levels']];
  const STEPS = [['Put your drawings in', 'Upload PDF or image plans for each level, then set the scale with two taps.'], ['Mark up as it goes in', 'Add outlets, boards, pits and racks. Draw each cable or pipe, connect its ends and pick the port it lands on.'],
    ['Check, test and photograph', 'Run the checklist on each item, record test results and add photos before the wall or trench closes.'], ['Hand it over', 'Print the handover pack, as-builts, schematics and port schedules. Everything is already in them.']];
  const HANDOVER = [['services-schematic.webp', 'Schematics for any service', 'See what connects to what, port by port, for one item, one area or the whole site.', 'A schematic with outlets linked to a comms cabinet'],
    ['services-trace.webp', 'Follow any run, end to end', 'Pick a port, outlet or valve and the route lights up on the plan.', 'A water main route highlighted on a floor plan'],
    ['services-report.webp', 'Test reports for every trade', 'Checklists, readings, defects and photos in one clean report.', 'Two pages of a power test report'],
    ['services-asbuilt.webp', 'As-builts as you go', 'Mark up what went in as it goes in, and the as-built is ready when the job is.', 'An as-built drawing with a title block']];
  const FAQ = [
    ['About As Built', [
      ['What is it?', 'An app for marking up building services on your drawings while they\'re installed. You record every cable, pipe and duct, connect each one from end to end, run inspections, add photos and test results, and print the handover pack, as-builts, schematics and port schedules at the end.'],
      ['Who is it for?', 'Electrical, data and comms, fire, plumbing, drainage, mechanical, security and AV contractors, plus the project managers, supervisors and clients who need to see what\'s been installed and checked.'],
      ['Can I try it first?', 'Yes. Open the demo to explore a marked-up resort with a guided tour. Nothing is saved, and it resets each time you visit.']]],
    ['Using it on site', [
      ['Which devices does it work on?', 'Phones, tablets and computers, in any modern browser. On a phone or tablet you can add it to your home screen so it opens like an app.'],
      ['Does it work without signal?', 'Yes. Everything you record is saved on your device straight away, and it syncs with your team when you\'re back in range. The status at the top shows when everything is saved.'],
      ['What drawings can I use?', 'PDF files and images such as PNG or JPG. Each page becomes a level you can mark up. Set the scale once and lengths are measured for you.'],
      ['Do the symbols follow Australian Standards?', 'The plan symbols are based on AS/NZS 1102.11 conventions for electrical and communications items and AS 1670 for fire. You can also switch on AS 5488 service colours in Settings. Tap Key on the plan to see what each symbol means.'],
      ['Can I connect an outlet to a specific patch panel port?', 'Yes. Open the outlet, choose how many ports it has, then pick the rack, panel and port number for each one. The cable, terminations and test results are recorded end to end, and they show up in the schematic and port schedule.']]],
    ['Sharing and handover', [
      ['What can I print or export?', 'A full handover pack, as-built drawings, schematics for any service, item or area, port and circuit schedules, labels, RFIs, defect reports and test reports. Each prints straight to PDF.'],
      ['Can a client answer an RFI without an account?', 'Yes. Send them a client link for that RFI or defect. They can see it and reply, but nothing else in your project.'],
      ['Who can see my projects?', 'Only people your admin adds to your team, at the access level they\'re given.']]],
    ['Your information and accounts', [
      ['Who owns my project information?', 'You do, or your client does, as you\'ve agreed between you. We only store and process it to run As Built for you. See the terms of use.'],
      ['How do I get it for my team?', `Email ${EMAIL} with your company name and roughly how many people will use it, and we'll set you up.`],
      ['I\'ve forgotten my password', `Ask your admin to reset it, or email ${EMAIL}.`],
      ['How do I get help?', `Tap the ? button in the app for help on the screen you're on, read the help guide, or email ${EMAIL}.`]]],
  ];
  page({
    path: 'programs/services.html', title: 'As Built — map every service while the building goes up', active: 'programs',
    description: 'Cables, pipes and ducts marked on your drawings as they go in, linked end to end, with inspections, test results and photos. As-builts done at handover.',
    body: (up) => `
<div class="hero"><div class="c"><div>
  <div class="phead-who" style="display:flex;align-items:center;gap:18px;margin-bottom:18px">${iconBox(p, up)}<span class="eyebrow" style="margin:0">As Built</span></div>
  <h1>Map every service while the building goes up</h1>
  <p class="lead">Cables, pipes and ducts marked on your drawings as they go in, linked end to end, with the inspections, test results and photos on each item. At handover, the as-builts are already done.</p>
  <div class="ctas" style="justify-content:flex-start"><a class="btn p big" href="${SERVICES_APP}/?demo">${PLAY} Try it now, free</a>${SERVICES_WIN ? `<a class="btn s big" href="${RELEASES}/RiyeserServices-Setup.exe">${DL} Windows app</a>` : ''}<a class="btn s big" href="${SERVICES_APP}/">Sign in</a></div>
  ${SERVICES_WIN ? '<p class="fine">Works in any web browser, on phones and tablets — or install the Windows app: it works on your PC with no account and no internet, and can sync to your online account.</p>' : ''}
  <p class="fine">No sign-up for the demo. Explore a marked-up resort with a guided tour.</p>
</div>${winFrame(up, 'services', 'As Built', 'services-trace.webp', 'A water main route highlighted on a floor plan', 1500, 783)}</div></div>
<section class="c"><h2 class="h2">How it works</h2><p class="sub">From the first drawing to the handover pack.</p>
  <div class="fgrid steps4">${STEPS.map(([h, t], i) => `<div class="f"><div class="k">Step ${i + 1}</div><h4 style="margin-top:6px">${esc(h)}</h4><p>${esc(t)}</p></div>`).join('')}</div></section>
<section class="c"><h2 class="h2">One drawing for every trade</h2><p class="sub">Each trade gets its own symbols, checklists and reports.</p>
  <div class="fgrid trades">${TRADES.map(([h, t]) => `<div class="f"><h4>${esc(h)}</h4><p>${esc(t)}</p></div>`).join('')}</div></section>
<section class="c"><h2 class="h2">What you hand over</h2><p class="sub">Everything is already in them — no rework at the end of the job.</p>
  <div class="grid two">${HANDOVER.map(([img, h, t, alt]) => `<div class="card"><img src="${up}assets/${img}" alt="${esc(alt)}" loading="lazy" style="border-radius:12px;margin-bottom:14px;border:1px solid var(--line)"><h3>${esc(h)}</h3><p>${esc(t)}</p></div>`).join('')}</div></section>
<section class="c"><div class="ind-split" style="padding:0"><div class="t"><span class="k">On site</span><h2 style="margin-top:8px">Built for the people doing the work</h2>
  <p>Big buttons, works with no signal, and syncs when you're back in range. Phones, tablets and computers — add it to your home screen and it opens like an app.</p>
  <ul class="ticks"><li>Electrical: boards, circuits and test results on record</li><li>IT and comms: racks, fibre and copper, port by port</li><li>Plumbing: pipe routes and pressure tests before the wall closes</li><li>Every trade working from the same drawing</li></ul></div>
  <img class="pshot" src="${up}assets/services-report.webp" alt="Two pages of a power test report" loading="lazy"></div></section>
<section class="c" id="faq" style="max-width:920px"><h2 class="h2">Questions and answers</h2>
  ${FAQ.map(([g, qs]) => `<h3 style="margin:28px 0 12px;font-size:19px">${esc(g)}</h3><div class="faq">${qs.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>`).join('')}
  <p class="note" style="margin-top:24px">More help: the <a class="more" href="${SERVICES_APP}/help.html">help guide</a> · <a class="more" href="${up}terms.html">Terms of use</a> · <a class="more" href="mailto:${EMAIL}">${EMAIL}</a></p></section>
<section class="c"><div class="cta"><h2>See it on a real job</h2><p>Try the demo now, or email us to set As Built up for your team.</p>
  <div class="ctas"><a class="btn t big" href="${SERVICES_APP}/?demo">${PLAY} Try the demo</a><a class="btn glass big" href="mailto:${EMAIL}?subject=${encodeURIComponent('As Built enquiry')}">${EMAIL}</a></div></div></section>`,
  });
}

// ---------- terms of use (as published on riyeser.com, 8 November 2026) ----------
page({
  path: 'terms.html', title: 'Terms of use — Riyeser', active: '',
  description: 'Terms of use for Riyeser and As Built.',
  body: () => `<div class="c legal" style="max-width:820px;padding:56px 24px 64px">${TERMS}</div>`,
});

// ---------- downloads ----------
page({
  path: 'downloads.html', title: 'Download Riyeser for Windows', active: 'downloads',
  description: 'Download Riyeser Central for Windows 10 and 11, then add the programs you need. No account, no card.',
  body: (up) => `${bandHero({ title: 'Download Riyeser for Windows', lead: 'Get Riyeser Central, then add the programs you need.' })}
<section class="c" style="padding-top:44px">
  <div class="central-dl"><img src="${up}assets/logo-r.png" alt="">
    <div><h2>Riyeser Central</h2><p>The home screen and installer for Riyeser programs. It shows what else you can add and keeps everything up to date.</p></div>
    <span class="sep"></span>
    <div class="act"><a class="btn p big" href="${dl(prog('central'))}">${WINDL}</a><small>${WINLOGO} Windows 10 &amp; 11</small></div>
  </div>
  <div class="steps3" style="margin-top:40px">
    <div class="step"><span class="n">1</span>${li('download')}<div><h3>Download</h3><p>Get Riyeser Central for Windows.</p></div></div><span class="to">${ARR}</span>
    <div class="step"><span class="n">2</span>${li('monitor')}<div><h3>Install</h3><p>Open the file. It installs in a few seconds; no admin rights needed.</p></div></div><span class="to">${ARR}</span>
    <div class="step"><span class="n">3</span>${li('layers')}<div><h3>Add programs</h3><p>Choose and install the Riyeser programs you need.</p></div></div>
  </div>
</section>
<section class="c" style="padding-top:0">
  <h2 class="h2">Every program</h2><p class="sub">Or download a program on its own. Each one installs in one click and updates over the old version, so your information is kept.</p>
  ${PROGRAMS.filter((p) => p.id !== 'central').map((p) => `<div class="dl">${iconBox(p, up)}<div><h3>${esc(p.name)} ${badgeOf(p)}</h3><p>${esc(p.one)} <a class="more" href="${up}programs/${p.id}.html">More</a></p></div>${p.file ? `<a class="btn p" href="${dl(p)}">${WINLOGO} Download</a>` : `<a class="btn s" href="${dl(p)}">${p.link ? esc(p.linkLabel) : 'Early access'}</a>`}</div>`).join('')}
  <div class="note" style="margin-top:26px"><b>Windows says “Windows protected your PC”?</b> Click <b>More info</b>, then <b>Run anyway</b>. We're getting our programs signed so this goes away. The <a class="more" href="${up}help/start.html">Getting started guide</a> covers installing, updates and your licence.</div>
</section>
${ctaBlock(up, 'Need a hand getting started?', 'Our step-by-step guides use the same button names you see on screen.')}`,
});

// ---------- pricing ----------
page({
  path: 'pricing.html', title: 'Riyeser pricing — free tools, then $20 a month per business', active: 'pricing',
  description: 'Riyeser Central, Invoices, PDF and Desk Assistant are free forever. Accounting Basics is $20 a month per business; Accounting Plus, Payroll, POS, Bookings and Team Chat Plus are +$20 each. As Built, for the building industry, is $20 a month on its own. Every paid program is free for 90 days, no card.',
  body: (up) => `
${bandHero({ title: 'Pricing', lead: 'Start free. Add what you need for $20 a month — per business, not per person.' })}
<section class="c" style="padding-bottom:20px">
  ${EARLY_BIRD ? `<div class="earlybox" id="early"><div class="big">🐣</div><div><b>Early bird: 50% off your first year</b><p>For the first 100 businesses to buy. That's <b>$10 a month</b> for each program for 12 months, then the normal price. The offer ends when 100 businesses have it.</p></div></div>` : ''}
  <div class="plans plans3">
    <div class="plan"><span class="tag free">Free forever</span><div class="k">Free tools</div><div class="price">$0</div>
      <ul class="ticks"><li>Riyeser Central — your home screen</li><li>Riyeser Invoices — quotes, invoices, getting paid</li><li>Riyeser Team — team chat</li><li>Riyeser PDF — fill, sign, combine, edit</li><li>Desk Assistant — sort and find every file</li></ul></div>
    <div class="plan best"><span class="tag">Start here</span><div class="k">Accounting Basics</div><div class="price">$20<small> / month per business</small></div>
      <ul class="ticks"><li><b>Free for 90 days</b></li><li>Invoices, quotes, customers and stock</li><li>Money in &amp; out, GST summary, profit &amp; loss</li><li>3 users included</li></ul></div>
    <div class="plan"><div class="k">Add programs</div><div class="price">+$20<small> / month each</small></div>
      <ul class="ticks"><li><b>Accounting Plus</b> — reconciling, bank import, BAS, jobs, budgets</li><li><b>Payroll</b> — timesheets, pay runs, payslips, leave</li><li><b>POS</b> — the till app for shops and cafes</li><li><b>Bookings</b> — jobs, appointments and table bookings</li><li><b>Team Chat Plus</b> — calls between your people and branches</li></ul></div>
  </div>
  <div class="addon"><div class="big">➕</div><div><b>Extras</b><p>More than 3 people: <b>$5 a month</b> per extra user. Another company, trust or client's books: <b>$10 a month</b> per extra company. Every paid program is free for 90 days. No card.</p></div></div>
  <p class="sub" style="margin-top:22px"><b>Pay yearly and get 2 months free.</b> Prices in Australian dollars; any GST or local tax is shown before you pay.</p>
</section>

<section class="c" id="calc">
  <div class="calc">
    <div><h2>Work out your price</h2><p class="muted">Pick what your business needs.</p>
      <div class="mods">
        <label class="check"><input type="checkbox" data-m="basic" checked> Accounting Basics</label>
        <label class="check"><input type="checkbox" data-m="plus"> Accounting Plus</label>
        <label class="check"><input type="checkbox" data-m="payroll"> Payroll</label>
        <label class="check"><input type="checkbox" data-m="pos"> POS</label>
        <label class="check"><input type="checkbox" data-m="bookings"> Bookings</label>
        <label class="check"><input type="checkbox" data-m="calls"> Team Chat Plus</label>
      </div>
      <p class="muted" style="margin:14px 0 4px">People using Riyeser</p>
      <div class="users"><button type="button" data-d="-1" aria-label="Fewer users">−</button><input id="users" type="number" min="1" max="500" value="3" aria-label="Number of users"><button type="button" data-d="1" aria-label="More users">+</button></div>
      <p class="muted" style="margin:10px 0 4px">Companies in Accounting</p>
      <div class="users"><button type="button" data-c="-1" aria-label="Fewer companies">−</button><input id="cos" type="number" min="1" max="200" value="1" aria-label="Number of companies"><button type="button" data-c="1" aria-label="More companies">+</button></div>
      <label class="yr" style="margin-top:12px"><input id="yearly" type="checkbox"> Pay yearly (2 months free)</label></div>
    <div class="out"><div class="muted" id="per"></div><div class="total" id="total"></div><div class="muted" id="note"></div></div>
  </div>
</section>

<section class="c" id="accounting">
  <h2 class="h2">Accounting Basics vs Accounting Plus</h2>
  ${editionsBlock(up)}
</section>

<section class="c" id="as-built" style="padding-top:0">
  <h2 class="h2">For the building industry</h2><p class="sub">As Built is a separate program for trades and construction. It isn't part of the business programs above, and doesn't need Accounting.</p>
  <div class="plans eds"><div class="plan best"><span class="tag">Free for 90 days</span><div class="k">${appImg('services', up)}As Built</div>
    <div class="price">$20<small> a month per business · 3 users included</small></div><p>Map every cable, pipe and duct on your drawings as it goes in, with inspections, test results and photos.</p>
    <ul class="edlist"><li>Services marked on your PDF plans, end to end</li><li>Inspections, test results and photos on every item</li><li>Works on site with no signal; online sync optional</li><li>Handover pack and as-builts ready when the job is</li></ul>
    <div class="ctas" style="justify-content:flex-start;margin-top:10px"><a class="btn s" href="${up}programs/services.html">About As Built ${ARR}</a></div></div></div>
</section>

<section class="c faq" style="max-width:860px">
  <h2 class="h2">Questions</h2>
  <details open><summary>What's free?</summary><p>Riyeser Central, Riyeser Invoices, Riyeser Team (team chat), Riyeser PDF and the Desk Assistant file organiser are free forever — no time limit, no account, no card.</p></details>
  <details><summary>How does the free trial work?</summary><p>Every paid program — Accounting Basics, Accounting Plus, Payroll, POS, Bookings, and As Built for the building industry — is free for 90 days from when you first open Riyeser Central. No card. The programs show how many days are left, and when the trial ends nothing is deleted: you keep every record and can still look and print; only adding new work waits for a licence.</p></details>
  <details><summary>What happens when the free part runs out?</summary><p>Nothing is deleted and nothing is charged. Everything you made stays on your computer and can still be opened, and quotes, payments and reports keep working. Only new invoices (Basics), new till sales (POS) or that program's screens (the others) wait until you buy it and enter the key in Riyeser Central. They unlock straight away.</p></details>
  <details><summary>Is it per person?</summary><p>No — per business. Each program is $20 a month for the whole business, with 3 people included. A 4th person and beyond is $5 a month each, for all your programs.</p></details>
  <details><summary>How do extra companies work?</summary><p>Your plan includes one company in Riyeser Accounting. Groups, trusts and bookkeepers can add more for $10 a month per extra company, with one sign-in. If you stop paying for one, its books stay — they open read-only until you add it back.</p></details>
  ${EARLY_BIRD ? `<details><summary>How does the early bird offer work?</summary><p>The first 100 businesses to buy pay half price for their first 12 months — $10 instead of $20 a month for each program. After 12 months the normal price applies. Once 100 businesses have it, the offer ends; we won't extend it or run a fake countdown.</p></details>` : ''}
  <details><summary>Is As Built part of the business programs?</summary><p>No. As Built is a separate program for trades and construction, priced on its own at $20 a month per business after its 90-day free trial. You don't need Accounting or any other program to use it, and it works on its own Windows app or in a web browser.</p></details>
  <details><summary>Can I cancel?</summary><p>Yes, any time. You keep everything you made, and can always open and export it.</p></details>
  <details><summary>How do I buy?</summary><p>Online checkout is opening soon. Until then, email <a class="more" href="mailto:${EMAIL}?subject=${encodeURIComponent('Riyeser licence')}">${EMAIL}</a> with your business name and the programs you want, and we'll send your licence key.</p></details>
</section>
${ctaBlock(up, 'Start free today', 'Install Riyeser Central — the free tools are yours to keep, and every paid program is free to start.')}
<script>(function(){var EB=${EARLY_BIRD ? 'true' : 'false'},u=document.getElementById('users'),c=document.getElementById('cos'),y=document.getElementById('yearly');
var NAMES={basic:'Accounting Basics',plus:'Accounting Plus',payroll:'Payroll',pos:'POS',bookings:'Bookings',calls:'Team Chat Plus'};
function money(v){return '$'+v.toLocaleString('en-AU',{minimumFractionDigits:v%1?2:0,maximumFractionDigits:2})}
function draw(){
  var plus=document.querySelector('[data-m=plus]'),pos=document.querySelector('[data-m=pos]'),basic=document.querySelector('[data-m=basic]');
  if(plus.checked&&!basic.checked)basic.checked=true; // Plus adds to Basics; POS is its own app
  var mods=[].slice.call(document.querySelectorAll('[data-m]')).filter(function(x){return x.checked}).map(function(x){return x.dataset.m});
  var n=Math.max(1,Math.min(500,parseInt(u.value,10)||1)),k=Math.max(1,Math.min(200,parseInt(c.value,10)||1));
  var prog=mods.length*20,users=mods.length?Math.max(0,n-3)*5:0,cos=mods.indexOf('basic')>=0?(k-1)*10:0,m=prog+users+cos;
  var parts=[]; if(mods.length)parts.push(mods.map(function(x){return NAMES[x]}).join(' + ')+' ('+money(prog)+')'); else parts.push('Free tools only');
  if(users)parts.push((n-3)+' extra user'+(n-3>1?'s':'')+' ('+money(users)+')'); if(cos)parts.push((k-1)+' extra compan'+(k-1>1?'ies':'y')+' ('+money(cos)+')');
  document.getElementById('per').textContent=parts.join(' · ');
  if(!m){document.getElementById('total').textContent='$0';document.getElementById('note').textContent='Central, Invoices, PDF and Desk Assistant are free forever.';return}
  if(y.checked){document.getElementById('total').textContent=money(m*10)+' a year';document.getElementById('note').textContent="That's "+money(m*10/12)+' a month — 2 months free.'}
  else{document.getElementById('total').textContent=money(m)+' a month';document.getElementById('note').textContent='After the 90-day free trial. Free tools are always $0.'}
  if(EB){document.getElementById('note').textContent+=' Early bird: '+(y.checked?money(m*10/2)+' for your first year':money(m/2)+' a month for your first year')+'.'}
}
document.querySelectorAll('[data-d]').forEach(function(x){x.addEventListener('click',function(){u.value=Math.max(1,(parseInt(u.value,10)||1)+parseInt(x.dataset.d,10));draw()})});
document.querySelectorAll('[data-c]').forEach(function(x){x.addEventListener('click',function(){c.value=Math.max(1,(parseInt(c.value,10)||1)+parseInt(x.dataset.c,10));draw()})});
document.querySelectorAll('[data-m]').forEach(function(x){x.addEventListener('change',draw)});
u.addEventListener('input',draw);c.addEventListener('input',draw);y.addEventListener('change',draw);draw()})()</script>`,
});

// ---------- help centre: a front page with search, and one guide per program (text in help.mjs) ----------
{
  const guides = (up) => helpGuides({ EMAIL, SERVICES_APP, up });
  const G0 = guides('');
  const gIcon = (g, up) => appImg(g.app, up);
  const gName = (g) => (g.id === 'accounting-basics' || g.id === 'accounting' ? `Accounting ${g.name.replace('Accounting ', '')}` : g.name);
  const countQ = (g) => g.groups.reduce((n, x) => n + x.items.length, 0);
  const plain = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  const searchBox = (ph) => `<div class="hsearch-wrap">${SEARCH}<input class="hsearch" id="hq" type="search" placeholder="${ph}" autocomplete="off" aria-label="Search help"><button class="go" type="button" aria-label="Search" onclick="var a=document.querySelector('#hres a');if(a)location.href=a.href;else document.getElementById('hq').focus()">${SEARCH}</button></div>`;
  // Every question in every guide, for the search box (title, guide, link, words).
  const INDEX = (up) => guides(up).flatMap((g) => g.groups.flatMap((grp) => grp.items.map(([id, q, a]) => [q, gName(g), g.app, `${up}help/${g.id}.html#${id}`, plain(a).slice(0, 400)])));
  const searchScript = (up) => `<script>(function(){var IX=${JSON.stringify(INDEX(up)).replace(/</g, '\\u003c')},box=document.getElementById('hq'),out=document.getElementById('hres');
function esc(t){return t.replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
box.addEventListener('input',function(){var t=box.value.trim().toLowerCase();if(!t){out.classList.remove('on');out.innerHTML='';return}
var w=t.split(/\\s+/),hits=IX.map(function(r){var q=r[0].toLowerCase(),all=(q+' '+r[1]+' '+r[4]).toLowerCase(),s=0;for(var i=0;i<w.length;i++){if(all.indexOf(w[i])<0)return null;s+=q.indexOf(w[i])>=0?3:1}return[s,r]}).filter(Boolean).sort(function(a,b){return b[0]-a[0]}).slice(0,8);
out.innerHTML=hits.length?hits.map(function(h){var r=h[1];return '<a href="'+r[3]+'"><img src="${up}assets/apps/'+r[2]+'.png" alt=""><span>'+esc(r[0])+'<small>'+esc(r[1])+'</small></span></a>'}).join(''):'<div class="none">Nothing matches that. Try another word, or email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a>.</div>';out.classList.add('on')});
box.addEventListener('keydown',function(e){if(e.key==='Enter'){var a=out.querySelector('a');if(a)location.href=a.href}})})()</script>`;
  const contact = (up) => `<div class="contactbox"><div class="big">${MAIL}</div><div><h3>Still stuck? Ask a real person</h3><p>Email <a class="more" href="mailto:${EMAIL}?subject=${encodeURIComponent('Help with Riyeser')}">${EMAIL}</a>. Tell us which program, what you clicked and what you saw (a screenshot helps). Please don't send passwords, bank details or staff pay information.</p></div><a class="btn p" href="mailto:${EMAIL}?subject=${encodeURIComponent('Help with Riyeser')}">${MAIL} Email us</a></div>`;

  page({
    path: 'help.html', title: 'Help Centre — Riyeser', active: 'help',
    description: 'Step-by-step help for every Riyeser program: Central, Accounting Basics, Accounting Plus, Payroll, Desk Assistant, PDF and As Built.',
    body: (up) => {
      const G = guides(up);
      const popular = G.flatMap((g) => g.groups.flatMap((grp) => grp.items.filter((it) => it[3]).map((it) => [g, it]))).filter((_, i) => i % 2 === 0).slice(0, 8);
      return `
${bandHero({ eyebrow: 'Help Centre', title: 'How can we help?', img: 'blueprint.webp', up, extra: `<div class="hres-wrap" style="margin-top:22px">${searchBox('Search help — e.g. password, payslip, update, sign a PDF')}<div class="hresults" id="hres"></div></div>` })}
<section class="c" style="padding-top:40px;padding-bottom:20px">
  <div class="hcats">${G.map((g) => `<a class="hcat" href="${up}help/${g.id}.html"><div>${g.id === 'start' ? li('rocket') : `<div class="icon" style="width:48px;height:48px;margin-bottom:12px">${gIcon(g, up)}</div>`}<h3>${esc(gName(g))}</h3><p>${esc(g.blurb || g.intro)}</p></div>${svg(LI.chev, 'chev')}</a>`).join('')}</div>
</section>
<section class="c" style="padding-top:30px;max-width:1000px">
  <h2 class="h2" style="font-size:34px">Frequently asked questions</h2>
  <div class="faq" style="margin-top:18px">${popular.map(([g, [id, q, a]]) => `<details><summary>${q}</summary>${a}<p><a class="more" href="${up}help/${g.id}.html#${id}">More in the ${esc(gName(g))} guide ${ARR}</a></p></details>`).join('')}</div>
</section>
<section class="c" style="padding-top:8px;max-width:1000px">${contact(up)}</section>
${searchScript(up)}
<script>/* old Help Centre links (help.html#payroll) go to the new guide pages */(function(){var m={start:'start',central:'central',accounting:'accounting-basics',payroll:'payroll',services:'services',desk:'desk-assistant',pdf:'pdf'},h=location.hash.slice(1);if(m[h])location.replace('${up}help/'+m[h]+'.html')})()</script>`;
    },
  });

  G0.forEach((g0, gi) => {
    page({
      path: `help/${g0.id}.html`, title: `${gName(g0)} help — Riyeser Help Centre`, active: 'help',
      description: `${gName(g0)} help: ${g0.intro}`,
      body: (up) => {
        const G = guides(up); const g = G[gi]; const prev = G[gi - 1]; const next = G[gi + 1];
        const p = PROGRAMS.find((x) => x.id === g.id);
        return `
<div class="c hpage">
  <aside class="hside"><h4>Guides</h4>${G.map((o) => `<a href="${up}help/${o.id}.html"${o.id === g.id ? ' class="on"' : ''}>${gIcon(o, up)}${esc(gName(o))}</a>`).join('')}
    <div class="toc"><h4 style="margin-top:6px">On this page</h4>${g.groups.map((grp, i) => `<a href="#s${i + 1}">${esc(grp.title)}</a>`).join('')}</div></aside>
  <div>
    <div class="crumbs"><a href="${up}help.html">Help Centre</a> › ${esc(gName(g))}</div>
    <div class="hhead"><div class="icon i-${g.app}">${gIcon(g, up)}</div><div><h1>${esc(gName(g))}</h1><p>${esc(g.intro)}</p>
      <div class="row">${p && p.file ? `<a class="btn p sm" href="${dl(p)}">${DL} Download</a><a class="btn s sm" href="${up}programs/${p.id}.html">About ${esc(p.short === 'Central' ? 'Central' : p.short)}</a>` : g.id === 'team' ? `<a class="btn p sm" href="/team/">Open Riyeser Team</a><a class="btn s sm" href="/team/?demo">Try the demo</a>`: g.id === 'services' ? `<a class="btn s sm" href="${SERVICES_APP}/help.html">${BOOK} Full As Built guide</a>` : `<a class="btn p sm" href="${up}downloads.html">${DL} Downloads</a>`}</div></div></div>
    ${searchBox(`Search the ${gName(g)} guide`)}
    ${g.groups.map((grp, i) => `<div class="hgroup" id="s${i + 1}"><h2><span class="num">${i + 1}</span>${esc(grp.title)}</h2><div class="faq">${grp.items.map(([id, q, a], j) => `<details id="${id}"${i === 0 && j === 0 ? ' open' : ''}><summary>${q}</summary>${a}</details>`).join('')}</div></div>`).join('')}
    <p class="hnone" id="hnone">Nothing in this guide matches that. Try the <a class="more" href="${up}help.html">Help Centre</a> search, or email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a>.</p>
    <div class="hnext">${prev ? `<a class="btn s" href="${up}help/${prev.id}.html">← ${esc(gName(prev))}</a>` : '<span></span>'}${next ? `<a class="btn s" href="${up}help/${next.id}.html">${esc(gName(next))} ${ARR}</a>` : ''}</div>
    <div style="margin-top:36px">${contact(up)}</div>
  </div>
</div>
<script>(function(){function openHash(){var h=location.hash.slice(1),d=h&&document.getElementById(h);if(d&&d.tagName==='DETAILS'){d.open=true}}openHash();addEventListener('hashchange',openHash);
var box=document.getElementById('hq');box.addEventListener('input',function(){var t=box.value.trim().toLowerCase(),any=false;
document.querySelectorAll('.hgroup').forEach(function(sec){var shown=0;sec.querySelectorAll('details').forEach(function(d){var hit=!t||d.textContent.toLowerCase().indexOf(t)>=0;d.style.display=hit?'':'none';if(t&&hit)d.open=true;if(hit)shown++});sec.style.display=shown?'':'none';if(shown)any=true});
document.getElementById('hnone').style.display=any?'none':'block'})})()</script>`;
      },
    });
  });
}

// ---------- old riyeser.com addresses keep working ----------
const redirect = (path, to, label) => { const f = join(OUT, path); mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `<!doctype html><meta charset="utf-8"><title>${label} — Riyeser</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${to}"><p>Moved to <a href="${to}">${label}</a>.</p>`); };
redirect('faq.html', `${BASE}programs/services.html#faq`, 'As Built questions and answers');
redirect('support.html', `${BASE}help.html`, 'Riyeser Help Centre');

// ---------- extras ----------
cpSync(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true });
const SUBFOLDER = BASE !== '/';
if (!SUBFOLDER) writeFileSync(join(OUT, 'CNAME'), 'riyeser.com\n');
if (!SUBFOLDER) writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
const urls = ['', 'programs.html', 'downloads.html', 'pricing.html', 'help.html', 'terms.html', ...INDUSTRIES.map((i) => `industries/${i.id}.html`), ...PROGRAMS.map((p) => `programs/${p.id}.html`), ...helpGuides({ EMAIL, SERVICES_APP, up: '' }).map((g) => `help/${g.id}.html`)];
writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}/${u}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(OUT, '404.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — Riyeser</title><link rel="stylesheet" href="${BASE}assets/site.css"><div class="c hero"><h1>That page isn't here</h1><p class="lead">It may have moved.</p><a class="btn p" href="${BASE}">Go to the home page</a></div>`);
console.log('Built', urls.length, 'pages into', OUT);
