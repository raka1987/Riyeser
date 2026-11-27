// Builds the Riyeser website into website/public (plain HTML, no server needed - GitHub Pages or any host).
//   node website/build.mjs
// Edit the text here; every page shares the same header, footer and download buttons.
import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { helpGuides } from './help.mjs';
import { developerPages, DEV_PAGES } from './developers.mjs';
import { connectSection, connectTeaser } from './connect.mjs';
import { PRICE, STORAGE_GB, BUNDLES, separately, planPrice, usd } from './prices.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR || join(ROOT, 'public');
const SITE = process.env.SITE_URL || 'https://riyeser.com';
// Installers are attached to the latest GitHub Release under these fixed names, so links never go stale.
const RELEASES = 'https://github.com/raka1987/Riyeser/releases/latest/download';
const EMAIL = 'info@riyeser.com';
// Early bird: 50% off the first 12 months for the first 100 businesses. Set to false once 100 businesses have it.
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
// As Built is off the website for now (its Windows app is unaffected). Set ASBUILT_WEB=1 to bring it back.
const ASBUILT = process.env.ASBUILT_WEB === '1';
const SERVICES_MOVED = !/^https:\/\/riyeser\.com\/?$/.test(SERVICES_APP);

const ALL_PROGRAMS = [
  { id: 'central', name: 'Riyeser Central', short: 'Central', icon: 'R', file: 'RiyeserCentral-Setup.exe',
    one: 'The home screen for your business: money owed, today\'s meetings, to-dos and recent files — and every Riyeser program one click away.',
    pitch: 'Start your day knowing exactly what needs doing.',
    shot: 'central-home.webp' },
  { id: 'invoices', name: 'Riyeser Invoices', short: 'Invoices', icon: '🧾', file: 'RiyeserInvoices-Setup.exe',
    one: 'Free invoicing for sole traders and small businesses: quotes, invoices, customers and getting paid. Free forever.',
    pitch: 'Send invoices and get paid. Free.' },
  { id: 'accounting-basics', name: 'Riyeser Accounting Basics', short: 'Accounting Basics', icon: '📗', file: 'RiyeserAccountingBasics-Setup.exe',
    one: `Invoicing, quotes, customers, stock reordering and expense claims for shops and sole traders. Free for 90 days, no card.`,
    pitch: 'Invoice, get paid and keep stock.' },
  { id: 'accounting', name: 'Riyeser Accounting Plus', short: 'Accounting Plus', icon: '📒', file: 'RiyeserAccountingPlus-Setup.exe',
    one: `Full double-entry books: everything in Basics plus banking, payroll, journals, jobs and budgets. Free for 90 days, no card. You pay for Plus instead of Basics, never both.`,
    pitch: 'Know who owes you, and who you owe.',
    shot: 'accounting.webp',
    note: 'Built for Australian small businesses. Have your accountant check your setup before relying on it for tax.' },
  { id: 'pos', name: 'Riyeser POS', short: 'POS', icon: '🧾', file: 'RiyeserPOS-Setup.exe',
    one: `A touch-friendly till for retail shops or cafes and restaurants, with card payments sent to your EFTPOS machine. Every sale goes straight into your books. Free for 90 days, no card.`,
    pitch: 'Sell at the counter. Books done automatically.',
    shot: 'pos-till.webp',
    note: 'Riyeser POS is its own app. It opens the same company file as Accounting Basics or Plus, but you don\'t need Accounting to use it.' },
  { id: 'bookings', name: 'Riyeser Bookings', short: 'Bookings', icon: '📅', file: 'RiyeserBookings-Setup.exe',
    one: `Book and schedule trades jobs, appointments or restaurant tables, sign jobs off on site, then invoice them in one click. Free for 90 days, no card.`,
    pitch: 'Every job and appointment, on one calendar.' },
  // Riyeser Estimate (licence module 'estimate'): free for 90 days from FIRST USE (firstUse), then PRICE.estimate a
  // month with 3 users included, like the other paid programs. It isn't part of any bundle.
  { id: 'estimate', name: 'Riyeser Estimate', short: 'Estimate', icon: '📐', file: 'RiyeserEstimate-Setup.exe', firstUse: true,
    one: `Measure jobs on a plan, a photo or the map, and turn them into quotes. Free for 90 days, then ${usd(PRICE.estimate)} a month.`,
    pitch: 'Measure the job, send the quote.',
    note: 'Sizes measured on satellite imagery are estimates: check them on site. The imagery can be years old and roof pitch can\'t be seen from above.' },
  { id: 'payroll', name: 'Riyeser Payroll', short: 'Payroll', icon: '🕒', file: PAYROLL_WIN ? 'RiyeserPayroll-Setup.exe' : null,
    one: `Rosters, time clock, timesheets, pay runs, payslips and leave — and export every payslip as a PDF in one click. Free for 90 days, no card.`,
    pitch: 'Pay day without the paperwork.',
    note: 'Check the PAYE and FNPF rates in Payroll rules against the current rules before you pay staff.' },
  // Riyeser Documents (formerly Riyeser Desk Assistant; its old pages programs/desk-assistant.html and
  // help/desk-assistant.html forward here, see "old riyeser.com addresses"). Releases carry its installer
  // as RiyeserDocuments-Setup.exe and, for old links and older Centrals, RiyeserDeskAssistant-Setup.exe: the old name
  // is used here because every release has it (the new name only from the first Riyeser Documents release).
  { id: 'documents', name: 'Riyeser Documents', short: 'Documents', icon: '🗂', file: 'RiyeserDeskAssistant-Setup.exe',
    one: 'Scan, file and find every office document. Scans from the office printer and uploads land in one Inbox, each with a suggested folder: file them in one click. Search the text inside every scan, with folder access for each person.',
    pitch: 'Every paper in its place.',
    shot: 'documents-inbox.webp' },
  // Riyeser Link (formerly Riyeser Team). Its Windows installer keeps the old file name, so installed copies update in place.
  // A paid program (module 'calls'): chat, calls, desk phones and Riyeser Link Office in one (it took in Link Plus).
  { id: 'link', name: 'Riyeser Link', short: 'Riyeser Link', icon: '💬', file: 'RiyeserTeam-Setup.exe', shot: 'team-chat.webp',
    one: `Chat and calls for your business: channels for jobs and the office, direct messages, calls between people and branches, office desk phones, and ${STORAGE_GB.link} GB for files shared in chat. Free for 90 days, no card.`,
    pitch: 'Your whole team, in one conversation.' },
  // Riyeser Link Office: the business's phone lines / office phone system (one PC at the office; desk phones that ring
  // each other). It comes with Riyeser Link, so it never shows a price of its own (comesWith).
  { id: 'link-office', name: 'Riyeser Link Office', short: 'Link Office', icon: '☎', file: 'RiyeserLinkOffice-Setup.exe', comesWith: 'link',
    one: 'Your business\'s phone lines: the office phone system. Install it on one PC at the office, plug in desk phones, and everyone gets an extension, with ring groups, and calls can be answered in the Riyeser Link app too. Staff call each other free inside the office. Comes with Riyeser Link.',
    pitch: 'Desk phones that ring each other.',
    note: 'Not yet: calls to and from outside phone numbers, and office phones away from the office. These phones can\'t call emergency services: keep a mobile or normal phone line for that.' },
  { id: 'pdf', name: 'Riyeser PDF', short: 'PDF', icon: '📕', file: 'RiyeserPDF-Setup.exe',
    one: 'Open, fill in, sign, combine and edit PDFs — even scanned ones.',
    pitch: 'Drawings and forms, done on the PC.',
    shot: 'pdf.webp' },
  { id: 'services', name: 'As Built', short: 'As Built', icon: '🏗', file: SERVICES_WIN ? 'RiyeserServices-Setup.exe' : null, link: `${SERVICES_APP}/?demo`, linkLabel: 'Try the demo',
    one: 'Map every cable, pipe and duct on your drawings as it goes in — with inspections, test results and photos — and the as-builts are done at handover.',
    pitch: 'Map every service while the building goes up.', custom: true },
];
// Short words for program cards (one line each) and the Programs menu.
const CARD = {
  central: ['Your home screen for every program.', 'Home screen and updates'],
  invoices: ['Quotes customers accept, invoices and getting paid.', 'Free invoicing'],
  'accounting-basics': ['Invoices, quotes, stock reordering and expense claims.', 'Invoicing and stock'],
  accounting: ['Full books, banking, BAS and payroll.', 'Full books and banking'],
  pos: ['A touch-friendly till for shops and cafes.', 'The till for shops and cafes'],
  bookings: ['Jobs, appointments, tables and on-site sign-off.', 'Jobs, appointments, on-site sign-off'],
  estimate: ['Measure on a plan, a photo or the map, then quote.', 'Measure and quote'],
  payroll: ['Rosters, timesheets, pay runs and payslips.', 'Rosters and pay runs'],
  documents: ['Scan, file and find every office document.', 'Scan, file and find documents'],
  link: ['Chat, calls and desk phones for your team.', 'Chat, calls and phones'],
  'link-office': ['Your office phone system: desk phones and extensions.', 'Office phone system'],
  pdf: ['Open, fill in, sign and combine PDFs.', 'Fill, sign and edit PDFs'],
  services: ['Cables, pipes and ducts on your plans.', 'Services on your drawings'],
};
for (const p of ALL_PROGRAMS) [p.card, p.tag] = CARD[p.id];
// Free programs first, then the paid ones, each group A to Z. Every list on the site (menus, finder, grids, downloads,
// footer, pricing) uses this order. Riyeser Link Office sits right after Riyeser Link (it comes with it).
const FREE_TOOLS = ['central', 'documents', 'invoices', 'pdf'];
const ORDER = ['central', 'documents', 'invoices', 'pdf', 'accounting-basics', 'accounting', 'bookings', 'estimate', 'link', 'link-office', 'payroll', 'pos', 'services'];
ALL_PROGRAMS.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
for (const p of ALL_PROGRAMS) p.free = FREE_TOOLS.includes(p.id);
const FREE_HEAD = 'Free forever';
// What each free program includes, and its real limits. null = no limits. Shown on the pricing page and on each free
// program's page.
const FREE_INFO = {
  central: { inc: 'Your home screen: installs and updates every Riyeser program, today\'s meetings, to-dos, file search and the first-day checklist.', lim: null },
  invoices: { inc: 'Unlimited quotes, invoices, customers and payments received, who owes you, and PDF copies to print or attach to your email.', lim: null,
    up: `For stock, bills, money in and out and reports, move up to Accounting Basics (${usd(PRICE.basic)}/month): it opens the same company file.` },
  pdf: { inc: 'Open, fill in, sign, edit, combine and split PDFs, and read scanned pages.', lim: null },
  documents: { inc: 'The office document library: department folders, the Inbox with suggested folders, search inside scans, scanning from the office printer, People & access, the Recycle bin and history.', lim: null },
};
// ---------- prices next to each program (every number from prices.mjs) ----------
// Each paid program's entry in PRICE (Riyeser Link is the 'calls' module).
const MOD = { 'accounting-basics': 'basic', accounting: 'plus', bookings: 'bookings', link: 'calls', payroll: 'payroll', pos: 'pos', services: 'as_built', estimate: 'estimate' };
const USERS_LINE = `${PRICE.users_included} users included · +${usd(PRICE.extra_user)} a month per extra user`;
/** What's included in each paid program's price, in plain words (all numbers from PRICE). */
const INCL = {
  pos: [`1 till (checkout counter) included · unlimited cashiers`, `+${usd(PRICE.extra_till)} a month per extra till`],
  payroll: [`${PRICE.users_included} office users included · unlimited employees`, `+${usd(PRICE.extra_user)} a month per extra office user`],
  bookings: [`${PRICE.users_included} staff calendars included`, `+${usd(PRICE.extra_user)} a month per extra calendar`],
};
const inclOf = (m) => INCL[m] || [`${PRICE.users_included} users included`, `+${usd(PRICE.extra_user)} a month per extra user`];
const inclLine = (m) => inclOf(m).join(' · ');
/** Where space is tight (menu rows): "US$39/mo · 3 users incl." */
const priceShort = (m) => `${usd(PRICE[m])}/mo · ${m === 'pos' ? '1 till incl.' : `${PRICE.users_included} users incl.`}`;
const USERS_NOTE = `Every paid program includes ${PRICE.users_included} users (POS: 1 till and unlimited cashiers); extra users ${usd(PRICE.extra_user)} a month each. Your accountant signs in free.`;
/** Where the two buttons go: create an account (or sign in), then Riyeser home opens "Add to my plan" for these programs. */
const BUY_LINK = (mods, buy, extra = '') => `/link/?signup&add=${mods}${extra}${buy ? '&buy=1' : ''}`;
/** "Start free for 90 days" and "Buy now" for a paid program (m = its PRICE key). */
const buyBtns = (m, cls = '') => `<div class="buybtns${cls ? ' ' + cls : ''}" data-buy="${m}"><a class="btn s sm" href="${BUY_LINK(m, false)}">Start free for 90 days</a><a class="btn p sm" href="${BUY_LINK(m, true)}">Buy now</a></div>`;

// ---------- what each program includes ----------
// Checked against the programs themselves (November 2026): Accounting Basics / Plus, Invoices, POS and Bookings on main
// (riyeser/), Payroll on module/payroll, Central, PDF, Riyeser Documents and Link Office in desktop/, Riyeser Link in
// website/team/. Only what the program does today; "coming soon" only where the site already says so.
const INCLUDES = {
  estimate: ['Six easy steps: customer, how to measure, measure, trade template, price, send', 'Type in sizes: rooms (walls less doors and windows), areas, lengths, counts, volumes and hours, from a tape or a laser measurer',
    'Plans and photos: open a PDF or a picture, set the scale from one known size, then draw areas (with cut-outs), lengths and counts',
    'The map: draw roofs with their pitch (ridges, hips, valleys, eaves and barges), fences with posts and gates, driveways and lawns',
    'Metric or imperial (m², sq ft, roofing squares, cu yd), in your own currency, tax name and date format',
    'Trade templates for roofing, fencing, decking, painting, flooring, tiling, plastering, concreting, paving, landscaping, cleaning, gutters, insulation, electrical and plumbing: waste, pack sizes and your rates',
    'Your profit and margin on every estimate (only you see it), a supplier price list import, and Duplicate to reuse a past job',
    'One click makes the quote, with a measurements page and your drawing; it opens in Riyeser Invoices, Bookings and Accounting to become an invoice or a job'],
  central: ['Every Riyeser program you have, one click away', 'Installs and updates Riyeser programs (Add a program)',
    'Money owed to you, overdue invoices and bills to pay, from Riyeser Accounting', 'Your last pay run, from Riyeser Payroll',
    'Recent activity, invoices to chase and shortcuts (open the till, new invoice, new booking, run payroll)',
    'One search box for your documents: by name or the words inside, from Riyeser Documents', 'Recent documents: pick up the files you opened last', 'A getting-started checklist',
    'Demo mode: try every program with a made-up sample business', 'Your company and Riyeser licence in one place', 'Light and dark look'],
  invoices: ['Today, your home screen: unpaid invoices (overdue first), money in this week and the calls you said you\'d make', 'Quotes and tax invoices with your business details',
    'Quotes with a valid-until date: mark them accepted or declined, and late ones show as expired', 'Turn an accepted quote into an invoice in one click, or into a Riyeser Bookings job',
    'A page for each customer: every quote, invoice, payment and booking in one list, with notes and call-back reminders', 'Customers and customer statements',
    'Receive payments, including part payments and one payment across several invoices', 'Who owes me: what each customer owes and what is overdue',
    'Print, download or save any invoice or quote as a PDF', 'Users with their own sign-in', 'Unlimited invoices, customers and payments',
    'Works on your PC with no internet', 'Accounting Basics or Plus opens the same company file when you need more'],
  'accounting-basics': ['Everything in Riyeser Invoices', 'Today, your home screen: today\'s sales, money in this week, unpaid invoices, bills due, low stock, follow-ups and claims to approve',
    'Quotes, orders and invoices, with GST', 'Quotes customers accept: valid-until date, accepted, declined or expired, then the invoice in one click',
    'Customers, credit limits and statements', 'A page for each customer and supplier: everything with them in one list, with notes and "call back on" reminders',
    'Suppliers, bills and paying bills', 'Stock items with average cost and stocktake',
    'Low stock and reorder: set a reorder-up-to level and a preferred supplier, then Order these makes one purchase order per supplier',
    'Receive deliveries in full or in parts: the stock comes in and the bill is made for you',
    'Expense claims: staff claim with a photo or PDF of the receipt, a manager approves or declines, and it goes in the books as a bill owed to them or paid from the bank',
    'Money in and money out, with GST worked out',
    'Pay runs brought in from Riyeser Payroll, with rostered and paid hours side by side', 'Works with Riyeser POS: till sales land as paid invoices',
    'Reports: Profit & Loss, GST summary, who owes you, what you owe, sales by customer and item, purchases by supplier, stock value and items to reorder',
    'Print any report or export it to CSV for Excel', 'Business overview: income, expenses, cash, overdue invoices, bills to pay and low stock',
    'Users and roles, and an audit trail', 'More than one company with one sign-in (extra companies charged separately)'],
  accounting: ['Everything in Accounting Basics', 'The Today screen, customer pages, expense claims and stock reordering, as in Basics', 'Bank reconciliation, with undo', 'Bank statement import (CSV): allocate or split each line in one click',
    'Transfer money between accounts', 'Payroll in your books: employees, pay runs, payslips with year-to-date totals and leave',
    'General journal, reversing entries and search transactions', 'Jobs (job costing) and monthly budgets', 'Tax codes and a BAS / GST summary (G1, 1A, 1B, W1, W2 and more)',
    'Lock a period once it is lodged', 'Every report: Balance Sheet, Trial Balance, General Ledger, Budget vs Actual, cash movement, Job P&L and payroll summary'],
  pos: ['Retail or restaurant setup', 'Product tiles with photos, categories, Favourites, search and barcode scanning', 'Hold a sale and come back to it',
    'Tables, kitchen dockets and takeaway (restaurant setup)', 'Cash with the change worked out, or card',
    'Card payments: press Card and the amount goes to the EFTPOS machine; when it\'s approved the receipt shows the card type, last 4 digits and auth code', 'Declined? Nothing is charged: try again or take another way to pay',
    'Tips, cash out and surcharges on card, and split a sale between card and cash', 'Card refunds go back through the card machine',
    'Protected against charging a card twice; if the till closes mid-payment, it picks up where it left off', 'Close of day: card totals by card type, to match the card machine\'s settlement',
    'Each till set up its own way: Not linked, Manual (your own unlinked machine) or a Practice terminal for training and demos', 'Connections to card machine providers such as Windcave and Stripe are coming',
    'Tax-invoice receipts to print',
    'Named tills (Till 1, Bar, Front counter), each opened with a float; every sale records its till', 'Refunds, voids and big discounts need a manager PIN or card, and stay in the audit trail', 'Close the till: count the drawer and print the Z-report',
    "Today's sales: takings, sales by hour, best sellers and how people paid", 'Today in the menu: today\'s sales, money in this week, low stock and the calls you said you\'d make',
    'Products, stock and stocktake', 'Managers see a low-stock note on the till when a product reaches its reorder level (it never stops a sale)',
    'A page for each customer: everything they\'ve bought, with notes and call-back reminders',
    'Every sale lands in your books as a paid invoice, with stock and GST updated'],
  bookings: ['Trades & site jobs, appointments, or restaurant tables', 'Day and week calendar, with a column for each staff member or table',
    'Warns you before double-booking a person or a table, and checks a table has enough seats', 'Booked, confirmed, in progress, done, cancelled and no-show, colour-coded',
    'Trades jobs with several visits, time and parts, at a fixed price or time and materials',
    'On site: big Start and Finish buttons record the time on site', 'A checklist for each job type, ticked off on site', 'Before and after photos from the phone or tablet camera',
    'The customer signs on screen, and the job sheet locks (a manager can unlock it)', 'A job sheet PDF to view, download or email to the customer',
    'Invoice this job: labour at the job type\'s or staff member\'s rate, plus parts', 'Jobs made from an accepted quote, already priced', 'Invoice a job in one click, in Riyeser Accounting or Invoices',
    'One list of finished jobs still waiting for an invoice', 'Today, your home screen: today\'s bookings and the calls you said you\'d make',
    'A page for each customer: bookings, quotes, invoices and payments in one list, with notes and call-back reminders',
    'Opens the same company file as Accounting, Invoices and POS, so customers are shared', 'Customers booking online: coming soon'],
  payroll: ['Weekly roster: shifts for each person and day, open shifts, copy last week, and drag a shift to move it',
    'Roster warnings for overlapping shifts, leave already booked, shifts over 12 hours and long weeks', 'Hours and estimated wages for each person and the week',
    'Publish the roster: staff see their shifts on the time clock and the Roster page, printed, or as a WhatsApp / SMS text',
    'Time clock on a shared PC: staff tap their name and a 4-digit PIN', 'Timesheets by person or as a list, with several shifts a day and supervisor approval',
    'Timesheets show early and late starts and finishes against the published roster', 'Fill a pay run\'s hours from the roster for staff who don\'t clock in',
    'Rostered and paid hours side by side on each pay run, and in the pay run sent to Riyeser Accounting',
    'Pay runs weekly, fortnightly, twice a month or monthly: preview, then finalise', 'PAYE and FNPF from the rates in your pay rules, unpaid break rules and regular deductions',
    'Payslips with year-to-date totals: print, save as PDFs or email', 'Staff can see their own payslips and timesheets',
    'Annual and sick leave: entitlement, taken and left', 'Bring in monthly Excel wage reports', 'Bank statement check: wage payments matched to staff (PDF, CSV or Excel)',
    'Access by area: Owner, Payroll officer, Supervisor, Employee and Read-only', 'Audit trail and login history', 'A backup every day (the last 30 kept)'],
  documents: ['One shared library for the office, on this PC or a shared network folder', 'Department folders (Accounts, Admin, Jobs, Payroll & HR, Sales…), real Windows folders',
    'An Inbox for new documents, each with a suggested folder: from your filing rules, where you filed similar ones, and what the document is',
    'File it in one click, change the folder (it learns), or File all as suggested', 'Reads scans and photos (OCR), so search finds the words inside them',
    'Upload, or drag files onto the window: your original stays where it was', 'Scan from a scanner on this PC (Windows\' own scan window)',
    'Scan to folder from the office printer, with steps for HP, Canon, Brother, Ricoh, Kyocera and Epson', 'Show scans, photos or documents, filter by who it came from, and sort',
    'Preview PDFs and pictures; open, print, move, rename or delete one document or several', 'Recycle bin: deleted documents kept for 30 days, then restore with one click',
    'History: who added, filed, moved, renamed, printed, deleted and restored what', 'People & access for each folder: No access, View, Add, Edit or Full, for everyone, groups or one person',
    'Private documents, and the owner always has Full access', 'Light and dark look',
    'Coming: Riyeser cloud sync, connecting offices on different sites, and share links'],
  link: ['Channels for each topic, job or site', 'Private chats: only the people you choose can see them', 'Direct messages between two people',
    'Reactions, pinned chats and files shared in chat', 'INV-1047 or Booking 12 stands out in a message', 'Unread counts on every chat',
    'Call a person, dial an extension, or call a whole branch', 'Turn the camera on for video in any call',
    'Branches with their own number and join code; extensions given automatically',
    'Office desk phones with Riyeser Link Office, your office phone system (Yealink, Grandstream, Snom and Polycom)',
    "Answer on any PC or phone you're signed in on, with no call charges", 'A list of recent calls',
    'Invite your team with one link', 'On your PC (the Riyeser Link app starts with Windows), in any web browser and on phones', 'Each business only ever sees its own team',
    `${STORAGE_GB.link} GB of space per business for files shared in chat, up to 25 MB a file (not hosting)`],
  'link-office': ['Install it on one Windows PC at the office that stays on, and sign in with your Riyeser account',
    'It brings in your people, extensions and branches from Riyeser Link', 'Plug in Yealink, Grandstream, Snom and Polycom desk phones: they show up by themselves and set themselves up',
    'Each person gets an extension number, like 101', 'Staff call each other free inside the office',
    'Ring groups: "Front desk" rings several phones, and the first to answer gets the call', 'Staff can also answer office calls in the Riyeser Link app (My phone)',
    'Other desk phones and phone apps can be set up by hand', 'Owners and admins see and manage every phone from the Phones page in Riyeser Link',
    'Comes with Riyeser Link: no separate price'],
  pdf: ['Open and view any PDF, and make Riyeser PDF your PDF app', 'Change the words in a PDF, add text, highlight, underline and strike through',
    'Fill in forms', 'Sign, tick, cross, add the date or a stamp (Approved, Paid, Received…)', 'Draw, boxes, circles, lines and arrows for marking up drawings',
    "White-out, and Redact that removes what's underneath for good", 'Combine PDFs, reorder, rotate, delete, extract and split pages',
    'Page numbers and watermarks', 'Recognise the text in scanned pages', 'Make PDFs from pictures, Word and Excel, turn a PDF into Word, or save pages as pictures',
    'Make a PDF smaller', 'Find words in a PDF'],
};
/** A ✓ checklist, in the same style as the Accounting Basics / Plus comparison. */
const inclList = (key) => `<ul class="edlist incl">${(INCLUDES[key] || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
/** "What's included ▾" on the pricing page: opens the checklist under the program's name. */
const inclDetails = (key, name) => `<details class="incd"><summary>What's included</summary><div class="incd-in" aria-label="What ${esc(name)} includes">${inclList(key)}</div></details>`;

// ---------- screenshots: the real programs with a made-up sample business (assets/shots, each also as -900.webp) ----------
// Taken with sample data only ("Coral Coast Trading (sample)", Riyeser Link's "Sample Plumbing" demo): no real people or customers.
const SHOTS = {
  central: [['central-home', 1280, 800, 'Riyeser Central home screen in demo mode: tiles for Link, Invoices, Bookings, Books, POS, Payroll, Documents and PDF, with money owed, recent activity and shortcuts', 'Home screen, with money owed and recent activity'],
    ['central-home-dark', 1280, 800, 'The same Riyeser Central home screen in the dark look', 'The dark look']],
  invoices: [['invoices-list', 1440, 675, 'Riyeser Invoices sales register listing open and overdue invoices for sample customers', 'Your invoices, with what is open and overdue'],
    ['invoices-invoice', 1440, 495, 'An overdue invoice in Riyeser Invoices with a part payment applied and buttons to download a PDF or receive a payment', 'An invoice with a part payment'],
    ['invoices-quote', 1032, 860, "An accepted quote, signed by the customer, with its valid-until date and buttons to make the invoice or a booking job", 'A quote the customer accepted']],
  'accounting-basics': [['basics-dash', 1440, 900, 'Accounting Basics dashboard: income, expenses, cash at bank, money owed, overdue invoices and bills to pay', 'The dashboard'],
    ['basics-stock', 1440, 900, 'Accounting Basics stock items with categories, quantity on hand, average cost and sell price', 'Stock items with average cost'],
    ['basics-invoice', 1440, 495, 'An invoice in Accounting Basics with stock and labour lines, GST and a part payment', 'An invoice with GST'],
    ['basics-today', 1032, 900, "The Today screen: today's sales, money in this week, what customers owe, bills due, unpaid invoices and follow-ups due", 'Today, the home screen'],
    ['basics-lowstock', 1032, 900, 'Low stock list: items at or below their reorder level, how many to order and the supplier, with an Order these button', 'Low stock, ready to order'],
    ['basics-claim', 1032, 840, "A staff member's expense claim for fuel with the receipt, waiting for a manager to approve it as a bill owed to them or as already paid", 'An expense claim to approve']],
  accounting: [['plus-dash', 1440, 900, 'Accounting Plus dashboard with income vs expenses by month, bank accounts and money owed', 'The dashboard'],
    ['plus-reconcile', 1440, 900, 'Bank reconciliation in Accounting Plus: tick each deposit and withdrawal that appears on the bank statement', 'Bank reconciliation'],
    ['plus-pnl', 1440, 900, 'Profit and Loss report in Accounting Plus with income, cost of sales and expenses', 'Profit & Loss'],
    ['plus-today', 1280, 900, "Accounting Plus Today screen: today's sales, money in this week, what customers owe, bills due, unpaid invoices and follow-ups due", 'Today, the home screen'],
    ['plus-lowstock', 1280, 900, 'Accounting Plus low stock list: items at or below their reorder level, how many to order and the supplier, with an Order these button', 'Low stock, ready to order'],
    ['plus-claim', 1280, 840, "A staff member's expense claim for fuel with the receipt, waiting for a manager to approve it as a bill owed to them or as already paid", 'An expense claim to approve']],
  pos: [['pos-till', 1440, 585, 'Riyeser POS till with product tiles by category and a current sale ready to pay', 'Selling at the till'],
    ['pos-sales', 1440, 900, "Riyeser POS Today screen: sales, GST collected, cash in drawer, sales by hour and best sellers", "Today's sales"],
    ['pos-card-waiting', 1280, 800, 'Riyeser POS card payment: Waiting for customer with the amount and a Cancel button, next to the on-screen practice terminal used in demo mode', 'Card payment: waiting for the customer'],
    ['pos-card-approved', 1280, 800, 'An approved card payment in Riyeser POS showing the card type, last 4 digits, auth code and reference, with the card slip and a Continue button', 'Card approved, with the card details'],
    ['pos-done', 1440, 472, 'A finished sale in Riyeser POS, paid by card, with print receipt and no receipt buttons', 'Sale complete'],
    ['pos-card-totals', 1280, 800, "Close till in Riyeser POS: card sales, cash out on the card machine and card terminal totals by card type, with a box for the card machine's settlement total", 'Close till: card totals by card type']],
  bookings: [['bookings-week', 1440, 585, 'Riyeser Bookings week view with a job each day for sample customers and technicians', 'The week at a glance'],
    ['bookings-jobs', 1440, 900, 'Riyeser Bookings jobs list: jobs needing a visit and jobs in hand, with addresses and next visit', 'Jobs and visits'],
    ['bookings-edit', 1440, 900, 'A booked visit in Riyeser Bookings with customer, time, job type, staff member and address, and an Invoice this job button', 'A visit, ready to invoice'],
    ['bookings-onsite', 940, 1055, 'The On site page for a visit: time on site with a Finish work button, and the job type\'s checklist being ticked off', 'On site: start, finish and the checklist'],
    ['bookings-signoff', 920, 620, "A customer's signature on the finished job: the job sheet is locked, with the job sheet PDF and an Invoice this job button", 'Signed off, with the job sheet'],
    ['bookings-sign-phone', 716, 1224, 'The customer signing the job sheet on a phone with a finger, then Sign and lock the job sheet', 'The customer signs on the phone', 'tall']],
  payroll: [['payroll-run', 1440, 630, 'A finished pay run in Riyeser Payroll: hours, gross pay, FNPF, PAYE and net pay for each person, with payslip buttons', 'A pay run with payslips'],
    ['payroll-timesheets', 1440, 900, 'Riyeser Payroll timesheets: paid hours for each person and a week grid of days and hours', 'Timesheets'],
    ['payroll-timeclock', 1440, 472, 'Riyeser Payroll time clock: staff tap their name to clock in or out', 'The time clock'],
    ['payroll-roster', 1280, 1143, "Riyeser Payroll roster: the week's shifts for each person, an open shift, hours and estimated wages, and buttons to publish, print or send it as a WhatsApp or SMS text", 'The weekly roster'],
    ['payroll-roster-staff', 780, 1388, 'The published roster on a phone: the shifts for each day, with Print or PDF and WhatsApp / SMS text buttons', 'What staff see on a phone', 'tall'],
    ['payroll-roster-print', 1280, 800, 'The printed roster: a table of people and days with each shift, its area and the hours for the week', 'The roster, printed']],
  documents: [['documents-inbox', 1440, 900, 'Riyeser Documents Inbox in demo mode: an invoice scanned at the office printer with its suggested folder, Accounts, Suppliers, Pacific Hardware, 2026, and File it and Change buttons', 'The Inbox, with a suggested folder'],
    ['documents-search', 1440, 900, 'A search for "pacific" finds three invoices and a bank statement scanned at the office printer, with the matching words from inside the scan', 'Search finds words inside scans'],
    ['documents-folder', 1440, 900, 'The Accounts folder in the dark look, showing only scans sorted by name, with sub-folders for bank statements, expense claims, suppliers and tax', 'A department folder, scans only'],
    ['documents-scan-folders', 1440, 900, 'Settings, Scan folders: the network path for each department to type into the office printer, with Copy buttons', 'Scan folders for the office printer'],
    ['documents-access', 1440, 900, 'Settings, People & access: a level for each folder for everyone, managers, the accounts team and the payroll and HR team, with Payroll & HR locked', 'People & access for each folder'],
    ['documents-phone', 390, 844, 'Riyeser Documents in a narrow window like a phone: the Inbox with a fuel receipt, a contract and a signed job sheet', 'In a small window', 'tall']],
  link: [['link-chat', 1440, 900, 'Riyeser Link demo: one list of chats and people on the left, the jobs channel with messages, reactions and a shared job sheet, and your status at the top', 'Team chat'],
    ['link-calls', 1440, 900, 'Riyeser Link calls: dial an extension or call a branch, with recent calls', 'Calls'],
    ['link-desk-phones', 1440, 900, 'Riyeser Link desk phones page: set-up steps for Riyeser Link Office and the server address to type into phones', 'Desk phones'],
    ['link-phone', 600, 1298, 'Riyeser Link on a phone: pinned chats, channels and direct messages', 'On a phone', 'tall']],
  // The desk phones page in Riyeser Link (shown in a Riyeser Link window: shotOf), where Link Office's phones are managed.
  'link-office': [['link-desk-phones', 1440, 900, 'Riyeser Link desk phones page: set-up steps for Riyeser Link Office and the server address to type into phones', 'Desk phones in Riyeser Link']],
  pdf: [['pdf-markup', 1280, 800, 'Riyeser PDF with a site plan marked up: a red circle, an arrow, a note and a tick', 'Marking up a drawing'],
    ['pdf-tools', 1280, 800, 'The Riyeser PDF Tools menu: convert, split, page numbers, watermark and make smaller', 'More tools']],
};
// Not lazy: there are only two to four small pictures, and lazy ones showed blank in full-page captures.
const shotImg = (up, [f, w, h, alt]) => `<img src="${up}assets/shots/${f}-900.webp" srcset="${up}assets/shots/${f}-900.webp ${w > 900 ? 900 : w}w, ${up}assets/shots/${f}.webp ${w}w" sizes="(max-width: 640px) 92vw, (max-width: 1000px) 46vw, 560px" width="${w}" height="${h}" alt="${esc(alt)}" decoding="async">`;
/** A small gallery; each picture opens bigger in the lightbox (no libraries). */
const gallery = (id, up) => { const list = SHOTS[id]; if (!list || list.length < 2) return ''; /* one picture: it's already at the top */ return `<section class="c blk gal-sec" id="screens">${shead('See it in use', 'The real program, filled in with a made-up sample business. Click a picture to see it bigger.', 'Screenshots')}
  <div class="gal g${list.length % 3 ? 2 : 3}">${list.map((s) => `<figure${s[5] ? ` class="${s[5]}"` : ''}><button type="button" class="shot" data-full="${up}assets/shots/${s[0]}.webp" data-cap="${esc(s[4])}" aria-label="${esc(`See bigger: ${s[4]}`)}">${shotImg(up, s)}</button><figcaption>${esc(s[4])}</figcaption></figure>`).join('')}</div>
</section>
<dialog class="lightbox" id="lb" aria-label="Screenshot"><button type="button" class="lb-x" aria-label="Close">×</button><button type="button" class="lb-nav lb-prev" aria-label="Previous picture">‹</button><figure><img alt=""><figcaption></figcaption></figure><button type="button" class="lb-nav lb-next" aria-label="Next picture">›</button></dialog>
<script>(function(){var d=document.getElementById('lb');if(!d||!d.showModal)return;var b=[].slice.call(document.querySelectorAll('.gal .shot')),i=0,im=d.querySelector('img'),cap=d.querySelector('figcaption');
function show(n){i=(n+b.length)%b.length;var x=b[i];im.src=x.dataset.full;im.alt=x.querySelector('img').alt;cap.textContent=x.dataset.cap;d.querySelectorAll('.lb-nav').forEach(function(z){z.hidden=b.length<2})}
b.forEach(function(x,n){x.addEventListener('click',function(){show(n);d.showModal()})});
d.querySelector('.lb-x').addEventListener('click',function(){d.close()});d.querySelector('.lb-prev').addEventListener('click',function(){show(i-1)});d.querySelector('.lb-next').addEventListener('click',function(){show(i+1)});
d.addEventListener('click',function(e){if(e.target===d)d.close()});d.addEventListener('keydown',function(e){if(e.key==='ArrowLeft')show(i-1);if(e.key==='ArrowRight')show(i+1)});
d.addEventListener('close',function(){var x=b[i];if(x)x.focus()})})()</script>`; };
const freeInfo = (id) => { const f = FREE_INFO[id]; if (!f) return '';
  return `<div class="freeinfo"><div><b>Included free:</b> ${esc(f.inc)}</div>
    <div><b>Limits <span class="ii" title="${esc(f.lim ? 'The only limit on this free program' : 'No limits on this free program: no time limit, no card')}">ⓘ</span>:</b> ${f.lim ? `<span class="lim">${esc(f.lim)}</span>` : '<span class="nolim">No limits</span>'}${f.note ? ` <span class="muted">${esc(f.note)}</span>` : ''}</div>
    ${f.up ? `<div class="muted">${esc(f.up)}</div>` : ''}</div>`; };
// ---------- home page "See it in action": each program's real screen with a short guided tour ----------
// Each step points at a spot on a screenshot (x, y in % of that picture, picked by looking at it) with one plain line on
// what it does for the business (checked against INCLUDES and the help guides). A step can show another screenshot of
// the same program; the frame keeps the first one's shape and taller pictures are cut off at the bottom, so every spot
// must sit inside the first picture's height (checked below; `frame` picks another picture's shape). `prog` is the program page, `m` its PRICE key.
const DEMO = [
  { id: 'invoices', label: 'Invoices', prog: 'invoices', finder: ['invoices'],
    head: 'Send invoices and get paid. Free.', ticks: ['Free forever: unlimited quotes, invoices and customers', 'Print or save any invoice as a PDF to attach to your email', 'Works on your PC, even with no internet'],
    steps: [['invoices-list', 57, 17, 'Make a quote or an invoice in a few clicks.'],
      ['invoices-quote', 11, 35, 'Customer said yes? Mark the quote accepted and make the invoice in one click.'],
      ['invoices-list', 74, 74, "See who's paid and who's overdue at a glance."],
      ['invoices-list', 79, 17, 'Record payments as they come in, even part payments.']] },
  { id: 'accounting', label: 'Accounting', prog: 'accounting-basics', m: 'basic', finder: ['accounting-basics', 'accounting'], frame: 'basics-dash',
    head: 'Know where your money is.', ticks: ['Quotes, invoices, bills and stock, with GST worked out', 'Order what\'s running low, and approve staff expense claims', 'Till sales from Riyeser POS land as paid invoices'],
    steps: [['basics-today', 62, 47, "Today: sales, money in, who to chase and who to call back."],
      ['basics-dash', 46, 31, 'Income, expenses and profit for the year, at a glance.'],
      ['basics-dash', 80, 52, 'Know who owes you money, and who you owe.'],
      ['basics-dash', 71, 13, 'Add an invoice, a bill or money in and out from the top.']] },
  { id: 'bookings', label: 'Bookings', prog: 'bookings', m: 'bookings', finder: ['bookings'],
    head: 'Every job and appointment, on one calendar.', ticks: ['Trades jobs, appointments or restaurant tables', 'On site: checklists, before and after photos, and the customer signs on screen', 'Invoice a finished job in one click'],
    steps: [['bookings-week', 37, 50, "The week's jobs on one calendar: who's going, and where."],
      ['bookings-week', 73, 5, 'Book a job with the customer, time, staff member and address.'],
      ['bookings-signoff', 30, 17, 'On site, the customer signs on screen and the job sheet locks.'],
      ['bookings-edit', 92, 13, "When the job's done, invoice it in one click."]] },
  { id: 'pos', label: 'POS', prog: 'pos', m: 'pos', finder: ['pos'],
    head: 'Sell at the counter. Books done automatically.', ticks: ['For retail shops, or cafes and restaurants with tables and kitchen dockets', 'Cash with the change worked out, or card sent to your EFTPOS machine', 'Every sale lands in your books, with stock and GST updated'],
    steps: [['pos-till', 22, 55, 'Tap a product to sell it, or scan its barcode.'],
      ['pos-till', 79, 24, 'The sale adds up as you go. Hold it and come back later.'],
      ['pos-card-waiting', 34, 38, "Press Card: the amount goes to the EFTPOS machine, and the sale finishes when it's approved."],
      ['pos-sales', 24, 28, "Today's takings, GST and best sellers, as you go."]] },
  { id: 'payroll', label: 'Payroll', prog: 'payroll', m: 'payroll', finder: ['payroll'], frame: 'payroll-run',
    head: 'Pay day without the paperwork.', ticks: ['A weekly roster, published to staff, and a time clock with a 4-digit PIN', 'Weekly, fortnightly or monthly pay runs, for unlimited employees', 'Payslips with year-to-date totals, printed, emailed or saved as PDFs'],
    steps: [['payroll-roster', 27, 20, "Plan the week's roster, then publish it to staff."],
      ['payroll-timesheets', 47, 44, 'Staff clock in with a 4-digit PIN; hours land in timesheets.'],
      ['payroll-run', 60, 26, 'Run pay with PAYE and FNPF worked out for you.'],
      ['payroll-run', 77, 47, 'Payslips for everyone: print, email or save as PDFs.']] },
  { id: 'link', label: 'Riyeser Link', prog: 'link', m: 'calls', finder: ['link'], phone: 'link-phone', live: '/link/?demo',
    head: 'Your whole team, in one conversation.', ticks: ['Team chat and calls on the PC, in the browser and on phones', 'Office desk phones with Riyeser Link Office, included', 'Invite your team with one link'],
    steps: [['link-chat', 13, 23, 'A channel for each job, site or topic, plus direct messages.'],
      ['link-chat', 37, 29, 'Type Booking 12 or INV-1047 and it stands out.'],
      ['link-chat', 40, 64, `Share job sheets, photos and files (${STORAGE_GB.link} GB included).`],
      ['link-calls', 81, 60, 'Call a person or a whole branch, with no call charges.']] },
  { id: 'link-office', label: 'Link Office', prog: 'link-office', m: 'calls', finder: ['link-office'],
    head: 'Desk phones that ring each other.', ticks: ['Each person gets an extension, like 101', 'Ring groups: "Front desk" rings several phones at once', 'Answer office calls in the Riyeser Link app too'],
    note: 'Not yet: calls to and from outside phone numbers.',
    steps: [['link-desk-phones', 34, 28, 'Install it on one PC at the office and sign in.'],
      ['link-desk-phones', 30, 41, 'Plug in desk phones: they show up by themselves.'],
      ['link-desk-phones', 30, 48, 'Give each phone to a person: staff call each other free.'],
      ['link-desk-phones', 63, 66, "See that it's running and how many phones are connected."]] },
  { id: 'documents', label: 'Documents', prog: 'documents', finder: ['documents'],
    head: 'Scan, file and find every office document.', ticks: ['Free forever', 'Scans from the office printer land in one Inbox', 'Search finds the words inside every scan'],
    steps: [['documents-inbox', 23, 38, 'Scans from the office printer land in the Inbox.'],
      ['documents-inbox', 84, 86, 'Each one gets a suggested folder: File it in one click.'],
      ['documents-search', 28, 58, 'Search finds the words inside every scan.'],
      ['documents-access', 29, 87, 'Choose who can see each folder, like Payroll & HR.']] },
  { id: 'pdf', label: 'PDF', prog: 'pdf', finder: ['pdf'],
    head: 'Drawings and forms, done on the PC.', ticks: ['Free forever', 'Fill in forms, and Redact removes what is underneath for good', 'Reads the text in scanned pages'],
    steps: [['pdf-markup', 44, 70, 'Mark up drawings with circles, arrows and notes.'],
      ['pdf-markup', 4, 12, 'Sign, tick and date forms without printing.'],
      ['pdf-markup', 17, 7, 'Change the words in a PDF, or add your own.'],
      ['pdf-tools', 21, 52, 'Combine, split, convert to Word or make smaller.']] },
  { id: 'central', label: 'Central', prog: 'central', finder: ['central'],
    head: 'Start your day knowing exactly what needs doing.', ticks: ['Free forever', "Today's meetings and to-dos, and money owed to you", 'Try every program with a made-up sample business'],
    steps: [['central-home', 39, 28, 'Every Riyeser program you have, one click away.'],
      ['central-home', 73, 31, 'Money owed and overdue invoices, as soon as you open it.'],
      ['central-home', 72, 50, 'Add a program: it installs and updates itself.'],
      ['central-home', 82, 78, 'Shortcuts to the till, a new invoice, booking or pay run.']] },
];
const SHOT_DIM = Object.fromEntries(Object.values(SHOTS).flat().map(([f, w, h, alt]) => [f, { w, h, alt }]));
for (const d of DEMO) {
  const first = SHOT_DIM[d.frame || d.steps[0][0]];
  for (const s of d.steps) {
    const k = SHOT_DIM[s[0]];
    if (!k) throw new Error(`DEMO ${d.id}: no screenshot ${s[0]} in SHOTS`);
    // the spot's height in the frame (taller pictures are cut at the frame's bottom)
    s.fy = s[2] * (k.h / k.w) / (first.h / first.w);
    if (k.h / k.w < first.h / first.w - 0.001 || s.fy > 94) throw new Error(`DEMO ${d.id}: ${s[0]} step falls outside the frame`);
  }
}
const demoTabOf = Object.fromEntries(DEMO.flatMap((d) => d.finder.map((f) => [f, d.id])));
/** The price line under a demo's name (every number from PRICE). */
const demoPrice = (d) => {
  const p = prog(d.prog);
  if (p.comesWith) return `<b>Comes with Riyeser Link</b> · free for 90 days, then <b>${usd(PRICE[d.m])}</b> a month`;
  if (!d.m) return '<b class="free">Free</b> forever · no card, no time limit';
  return `<b class="ok">Free for 90 days</b>, then <b>${usd(PRICE[d.m])}</b> a month · ${esc(inclOf(d.m)[0])}`;
};
// ---------- "Watch the demo": a short screen recording of each program (assets/videos/<id>.mp4 and a .webp poster) ----------
// Recorded from the real program filled in with the made-up sample business, with captions and no sound. [seconds, title]
// The video and its poster only load when someone opens the player.
const VIDEOS = {
  invoices: [48, 'Riyeser Invoices: a quote, accepted, made into an invoice and printed'],
  accounting: [41, 'Riyeser Accounting: Today, ordering low stock and approving an expense claim'],
  bookings: [50, 'Riyeser Bookings: a job on site, a photo, the customer signs, then the invoice'],
  pos: [41, 'Riyeser POS: ringing up a sale and paying by card on the practice terminal'],
  payroll: [52, 'Riyeser Payroll: roster, timesheets and a pay run with rostered and paid hours'],
  link: [43, 'Riyeser Link: team chat, your status and a call'],
  'link-office': [35, 'Riyeser Link Office: a new desk phone, given to a person, and a call'],
  documents: [54, 'Riyeser Documents: file a scan from the office printer, search inside scans, and People & access'],
  pdf: [51, 'Riyeser PDF: mark up a drawing, tick, sign and date it, and more tools'],
  central: [42, 'Riyeser Central: demo mode and your home screen for the business'],
};
// Which video each program page shows (both Accounting editions share one).
const videoOf = (id) => (id === 'accounting-basics' ? 'accounting' : VIDEOS[id] ? id : null);
const mmss = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
const videoBtn = (vid, up, cls = 'btn s') => (VIDEOS[vid] ? `<button type="button" class="${cls} vbtn" data-src="${up}assets/videos/${vid}.mp4" data-poster="${up}assets/videos/${vid}.webp" data-title="${esc(VIDEOS[vid][1])}" aria-haspopup="dialog">${PLAY} Watch the demo <span class="vlen">${mmss(VIDEOS[vid][0])}</span></button>` : '');
/** The video player (one per page): a modal dialog with the browser's own controls; Esc or × closes it and stops the video. */
const videoBox = () => `<dialog class="vbox" id="vbox" aria-labelledby="vbox-h"><div class="vbox-top"><h2 id="vbox-h">Demo</h2><button type="button" class="vbox-x" aria-label="Close the video">×</button></div>
<video controls playsinline preload="none" width="1280" height="800"></video><p class="vbox-note">No sound. A made-up sample business.</p></dialog>
<script>(function(){var d=document.getElementById('vbox');if(!d)return;var v=d.querySelector('video'),h=document.getElementById('vbox-h'),x=d.querySelector('.vbox-x'),from=null;
function open(b){from=b;h.textContent=b.getAttribute('data-title');var s=b.getAttribute('data-src');if(v.getAttribute('src')!==s){v.poster=b.getAttribute('data-poster');v.src=s}
if(d.showModal)d.showModal();else d.setAttribute('open','');x.focus();var p=v.play();if(p&&p.catch)p.catch(function(){})}
function close(){if(d.close&&d.open)d.close();else{d.removeAttribute('open');v.pause()}}
d.addEventListener('close',function(){v.pause();if(from)from.focus()});
x.addEventListener('click',close);d.addEventListener('click',function(e){if(e.target===d)close()});
d.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();close();return}if(e.key!=='Tab')return;var f=[x,v],i=f.indexOf(document.activeElement);
if(e.shiftKey&&i<=0){e.preventDefault();f[f.length-1].focus()}else if(!e.shiftKey&&i===f.length-1){e.preventDefault();f[0].focus()}});
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.vbtn');if(b){e.preventDefault();open(b)}})})()</script>`;
function demoSection(up) {
  const img = (f, i, lazy, on, sizes) => { const k = SHOT_DIM[f];
    return `<img class="dm-img${on ? ' on' : ''}" data-k="${f}" src="${up}assets/shots/${f}-900.webp" srcset="${up}assets/shots/${f}-900.webp ${Math.min(900, k.w)}w, ${up}assets/shots/${f}.webp ${k.w}w" sizes="${sizes}" width="${k.w}" height="${k.h}" alt="${esc(k.alt)}"${lazy ? ' loading="lazy"' : ''} decoding="async">`; };
  return `<section class="demo" id="demo" aria-labelledby="demo-h"><div class="c">
  <div class="shead"><span class="eyebrow">See it in action</span><h2 class="h2" id="demo-h">Watch each program do the work</h2><p class="sub">Real screens with a made-up sample business. Pick a program.</p></div>
  <div class="dm-tabs" role="tablist" aria-label="Programs">${DEMO.map((d, i) => `<button type="button" role="tab" id="dm-t-${d.id}" aria-controls="dm-p-${d.id}" aria-selected="${i === 0}" tabindex="${i ? -1 : 0}" data-id="${d.id}"><img src="${up}assets/apps/${d.prog}.png" alt="" width="28" height="28">${esc(d.label)}</button>`).join('')}</div>
  ${DEMO.map((d, i) => { const p = prog(d.prog); const shots = [...new Set(d.steps.map((s) => s[0]))]; const k0 = SHOT_DIM[d.frame || shots[0]];
    const start = d.m ? `<a class="btn p" href="${BUY_LINK(d.m, false)}">Start free</a>` : `<a class="btn p" href="${dl(p)}">${WINLOGO} Download free</a>`;
    return `<div class="dm-panel" role="tabpanel" id="dm-p-${d.id}" aria-labelledby="dm-t-${d.id}" data-id="${d.id}">
    <div class="dm-stage">
      <div class="dm-shots${d.phone ? ' has-phone' : ''}">
        <div class="dm-win"><div class="dm-bar"><i></i><i></i><i></i><span><img src="${up}assets/apps/${(prog(p.comesWith || d.prog)).id}.png" alt="" width="18" height="18">${esc(prog(p.comesWith || d.prog).name)}</span></div>
          <div class="dm-scr" style="aspect-ratio:${k0.w} / ${k0.h}"><div class="dm-zoom">${shots.map((f, n) => img(f, n, i > 0 || n > 0, n === 0, d.phone ? '(max-width: 760px) 70vw, 600px' : '(max-width: 760px) 92vw, 760px')).join('')}
            ${d.steps.map((s, n) => `<span class="dm-hot${n === 0 ? ' on' : ''}${s[1] > 58 ? ' r' : ''}${s.fy > 55 ? ' up' : ''}" style="left:${s[1]}%;top:${+s.fy.toFixed(1)}%" data-x="${s[1]}" data-y="${+s.fy.toFixed(1)}" aria-hidden="true"><b></b><i>${n + 1}</i><em>${esc(s[3])}</em></span>`).join('')}</div></div></div>
        ${d.phone ? `<div class="dm-phone">${img(d.phone, 0, i > 0, true, '(max-width: 760px) 24vw, 180px').replace('dm-img on', 'dm-pimg')}</div>` : ''}
      </div>
      <div class="dm-ctl"><ol class="dm-steps">${d.steps.map((s, n) => `<li class="dm-step${n === 0 ? ' on' : ''}" data-k="${s[0]}"><button type="button"${n === 0 ? ' aria-current="step"' : ''}><span class="n">${n + 1}</span><span class="t">${esc(s[3])}</span><span class="dm-prog"><i></i></span></button></li>`).join('')}</ol>
        <button type="button" class="dm-pause" aria-label="Pause the tour"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="pa" d="M8 5v14M16 5v14"/><path class="pl" d="M7 5l12 7-12 7z"/></svg></button></div>
    </div>
    <div class="dm-info">
      <div class="dm-name"><img src="${up}assets/apps/${d.prog}.png" alt="" width="52" height="52"><div><h3>${esc(p.name)}</h3><span>${esc(p.tag)}</span></div></div>
      <p class="dm-head">${esc(d.head)}</p>
      <ul class="ticks">${d.ticks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <p class="dm-price">${demoPrice(d)}</p>${d.id === 'accounting' ? `<p class="dm-alt">Need full books, bank reconciliation and BAS? <a href="${up}programs/accounting.html">Accounting Plus</a> is ${usd(PRICE.plus)} a month.</p>` : ''}${d.note ? `<p class="dm-alt">${esc(d.note)}</p>` : ''}
      <div class="dm-btns">${start}${videoBtn(d.id, up)}<a class="btn s" href="${up}programs/${d.prog}.html">Learn more ${ARR}</a>${d.live ? `<a class="btn s dm-live" href="${d.live}">${PLAY} Try the live demo</a>` : ''}</div>
    </div>
  </div>`; }).join('')}
</div></section>
<script>(function(){var R=document.getElementById('demo');if(!R)return;
var tabs=[].slice.call(R.querySelectorAll('[role=tab]')),list=R.querySelector('[role=tablist]'),P=tabs.map(function(t){return document.getElementById(t.getAttribute('aria-controls'))});
var mm=function(q){return window.matchMedia&&matchMedia(q).matches},paused=mm('(prefers-reduced-motion: reduce)'),hold=0,seen=!('IntersectionObserver' in window),cur=0,step=0;
function state(){R.classList.toggle('play',!paused&&!hold&&seen&&!document.hidden);R.classList.toggle('paused',paused);P.forEach(function(p){var b=p.querySelector('.dm-pause');b.setAttribute('aria-label',paused?'Play the tour':'Pause the tour')})}
function go(s){var p=P[cur],st=p.querySelectorAll('.dm-step'),h=p.querySelectorAll('.dm-hot');step=(s+st.length)%st.length;var k=st[step].getAttribute('data-k');
for(var i=0;i<st.length;i++){st[i].classList.remove('on');h[i].classList.remove('on');st[i].querySelector('button').removeAttribute('aria-current')}
void p.offsetWidth;st[step].classList.add('on');h[step].classList.add('on');st[step].querySelector('button').setAttribute('aria-current','step');
[].forEach.call(p.querySelectorAll('.dm-img'),function(im){im.classList.toggle('on',im.getAttribute('data-k')===k)});zoom()}
/* phones: the picture is small, so it zooms in on the step's spot */
function zoom(){var p=P[cur],z=p.querySelector('.dm-zoom'),h=p.querySelectorAll('.dm-hot')[step],s=mm('(max-width: 760px)')?(p.querySelector('.has-phone')?1.7:1.9):1;
var c=function(v){return Math.min(0,Math.max(100-100*s,v))},x=c(50-s*h.getAttribute('data-x')),y=c(50-s*h.getAttribute('data-y'));
z.style.transform=s>1?'translate('+x+'%,'+y+'%) scale('+s+')':'';z.style.setProperty('--s',s)}
addEventListener('resize',function(){zoom()});
function sel(n,focus){cur=(n+tabs.length)%tabs.length;tabs.forEach(function(t,i){var on=i===cur;t.setAttribute('aria-selected',on);t.tabIndex=on?0:-1;P[i].hidden=!on});
var t=tabs[cur];if(list.scrollWidth>list.clientWidth){try{list.scrollTo({left:t.offsetLeft-(list.clientWidth-t.offsetWidth)/2,behavior:'smooth'})}catch(e){list.scrollLeft=t.offsetLeft}}
if(focus)t.focus();go(0)}
tabs.forEach(function(t,i){t.addEventListener('click',function(){sel(i)})});
list.addEventListener('keydown',function(e){var k=e.key,n=k==='ArrowRight'||k==='ArrowDown'?cur+1:k==='ArrowLeft'||k==='ArrowUp'?cur-1:k==='Home'?0:k==='End'?tabs.length-1:null;if(n===null)return;e.preventDefault();sel(n,true)});
P.forEach(function(p){[].forEach.call(p.querySelectorAll('.dm-step button'),function(b,i){b.addEventListener('click',function(){go(i)})});
[].forEach.call(p.querySelectorAll('.dm-prog i'),function(x){x.addEventListener('animationend',function(){if(x.closest('.dm-step.on'))go(step+1)})});
p.querySelector('.dm-pause').addEventListener('click',function(){paused=!paused;state()});
var stage=p.querySelector('.dm-shots');stage.addEventListener('click',function(){paused=!paused;state()});
p.addEventListener('mouseenter',function(e){if(mm('(hover: hover)')){hold++;state()}});p.addEventListener('mouseleave',function(){if(mm('(hover: hover)')){hold=Math.max(0,hold-1);state()}});
p.addEventListener('focusin',function(e){var v=false;try{v=e.target.matches(':focus-visible')}catch(x){}if(!v)return;p.dataset.f||(p.dataset.f=1,hold++);state()});p.addEventListener('focusout',function(e){if(!p.contains(e.relatedTarget)&&p.dataset.f){delete p.dataset.f;hold=Math.max(0,hold-1);state()}})});
if(!seen)new IntersectionObserver(function(es){seen=es[0].isIntersecting;state()},{threshold:.3}).observe(R);
document.addEventListener('visibilitychange',state);
function fromHash(){var m=/^#demo-([\\w-]+)$/.exec(location.hash),i=m?tabs.map(function(t){return t.getAttribute('data-id')}).indexOf(m[1]):-1;if(i>=0){sel(i);R.scrollIntoView()}}
/* Find your program: a click shows that program here (a new tab or window still opens its page) */
[].forEach.call(document.querySelectorAll('#find a[data-demo]'),function(a){a.addEventListener('click',function(e){if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey||e.button)return;
var i=tabs.map(function(t){return t.getAttribute('data-id')}).indexOf(a.getAttribute('data-demo'));if(i<0)return;e.preventDefault();sel(i);
try{history.replaceState(null,'','#demo-'+a.getAttribute('data-demo'))}catch(x){}R.scrollIntoView({behavior:mm('(prefers-reduced-motion: reduce)')?'auto':'smooth'});tabs[i].focus({preventScroll:true})})});
sel(0);fromHash();addEventListener('hashchange',fromHash);state();})();</script>
${videoBox()}`;
}
/** Phones: a small "Start free" bar once the hero has scrolled away (closed with ×, for this visit). */
const MBAR = `<div class="mbar" id="mbar" hidden><span><b>Riyeser</b><small>Free tools forever · paid programs free for 90 days</small></span><a class="btn p sm" href="/link/?signup">Start free</a><button type="button" class="mbar-x" aria-label="Close">×</button></div>
<script>(function(){var b=document.getElementById('mbar'),h=document.querySelector('.hero3');if(!b||!h||!('IntersectionObserver' in window))return;var x=false;try{x=sessionStorage.getItem('mbar-x')==='1'}catch(e){}if(x)return;
var past=false,foot=false,f=document.querySelector('footer');function show(){var on=past&&!foot&&!x&&matchMedia('(max-width: 760px)').matches;b.hidden=!on;document.body.classList.toggle('has-mbar',on)}
new IntersectionObserver(function(es){past=!es[0].isIntersecting&&es[0].boundingClientRect.top<0;show()}).observe(h);
if(f)new IntersectionObserver(function(es){foot=es[0].isIntersecting;show()}).observe(f);
b.querySelector('.mbar-x').addEventListener('click',function(){x=true;try{sessionStorage.setItem('mbar-x','1')}catch(e){}show()});addEventListener('resize',show)})();</script>`;
// No single "from" price: each paid program shows its own price next to its name.
const PAID_HEAD = 'Free for 90 days, then:';
rmSync(OUT, { recursive: true, force: true });
// Help guides: Getting started first, then the programs in the site's order (free A to Z, then paid A to Z).
const guidesFor = (o) => helpGuides(o).filter((g) => ASBUILT || g.id !== 'services')
  .sort((a, b) => (a.id === 'start' ? -1 : b.id === 'start' ? 1 : ORDER.indexOf(a.id) - ORDER.indexOf(b.id)));
const PROGRAMS = ALL_PROGRAMS.filter((p) => ASBUILT || p.id !== 'services');
const prog = (id) => ALL_PROGRAMS.find((p) => p.id === id);
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
  documents: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12.5" cy="13.5" r="2.6"/><path d="M14.5 15.5l2 2"/>',
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
      ['accounting-basics', ['Every till sale lands as a paid invoice, with GST right', 'Stock with average cost, stocktakes, and purchase orders for what\'s running low', 'Free for 90 days, no card']],
      ['payroll', ['A weekly roster, published to staff on the time clock or as a WhatsApp text', 'Staff clock in and out with a 4-digit PIN', 'Timesheets flow straight into the pay run', 'Payslips with year-to-date totals, printed, emailed or saved as PDFs']],
      ['central', ['What customers owe and what you owe, as soon as you open it', "Today's meetings and your to-do list", 'Every Riyeser program one click away']]] },
  { id: 'accounting', name: 'Accounting practices', icon: 'practice', photo: 'team-office.webp', short: 'Keep client books and pay runs organised.',
    title: 'Accounting Practices', lead: "Keep every client's books, pay runs and paperwork organised, with one sign-in.",
    h: 'Client books, one sign-in', p: "Run a separate company file for each client, switch between them from the top of the screen, and see everyone's cash, money owed and profit on one page.",
    shot: 'accounting.webp', shotName: 'Riyeser Accounting Plus', shotApp: 'accounting', cta: ['accounting', 'Explore Accounting Plus'],
    progs: [['accounting', ['Several companies with one sign-in, and an overview of them all', 'Bank reconciliation, statement import and BAS / GST figures', 'Lock a period after the BAS is lodged', 'Quick access sets: Owner, Bookkeeper, Payroll officer, Read-only']],
      ['documents', ['Scans from the office printer land in one Inbox, with a suggested folder', 'Find any document by a word inside the scan', 'Lock folders like Payroll & HR to the people who need them']],
      ['pdf', ['Fill in and sign forms', 'Combine, split and reorder pages', 'Black out bank details before you send']]] },
  { id: 'trades', name: 'Trades & construction', icon: 'trades', photo: 'trades.webp', short: 'Track installations, inspections and handovers.',
    title: 'Trades & Construction', lead: 'Service mapping and inspections for trades and construction projects, with clear plans and on-site markups.',
    h: 'Service mapping and inspections', p: 'Map services on your plans as they go in, and carry out inspections with clear, marked-up drawings for the job.',
    shot: 'services-trace.webp', shotName: 'As Built', shotApp: 'services', cta: ['services', 'Explore As Built'], photoTall: 'team-site-plans.webp',
    ...(ASBUILT ? {} : { lead: 'Book jobs, mark up drawings and keep every site file in order, from one Windows PC.', h: 'Jobs, drawings and paperwork',
      p: 'Book jobs at the customer\'s address, give them to your team, invoice in one click, and mark up and sign site drawings and forms.',
      shot: 'pdf.webp', shotName: 'Riyeser PDF', shotApp: 'pdf', cta: ['bookings', 'Explore Bookings'] }),
    progs: [['bookings', ['Jobs at the customer\'s address, given to your staff', 'A day view for every tradie, with no double-booking', 'On site: checklists, before and after photos, and the customer signs on screen', 'Invoice the job in one click when it\'s done']],
      ['services', ['Cables, pipes and ducts drawn on your PDF plans, end to end', 'Inspections, test results and photos on every item', 'Works with no signal on site; as-builts ready at handover']],
      ['pdf', ['Mark up drawings with clouds, arrows, boxes and stamps', 'Fill in and sign site forms', 'Read scanned drawings so they can be searched']],
      ['documents', ['A folder for every job, with quotes, job sheets and photos', 'Scan site paperwork at the office printer and file it in one click', 'Find any document by a word inside it']]] },
];
if (!ASBUILT) for (const i of INDUSTRIES) i.progs = i.progs.filter(([id]) => id !== 'services');
// ---------- home page hero: "Take it anywhere with you" — four real-life scenes that slowly take turns ----------
const HERO_SLIDES = [
  { img: 'hero-trades', alt: 'A tradie checking his phone on the back of his ute', where: 'On the road',
    pops: [['bookings', 'Riyeser Bookings', 'Jo Smith · 10:00 tomorrow', 'Hot water service · Confirmed', ''], ['invoices', 'Riyeser Invoices', 'INV-1047 paid', '$880.00 received', 'ok']] },
  { img: 'hero-cafe-call', alt: 'A café owner on the desk phone at her counter', where: 'At the counter',
    pops: [['link', 'Riyeser Link', 'Call from Kitchen · ext 102', 'Answered on the desk phone', ''], ['link', 'Riyeser Link', 'Supplier delivery at 2pm', 'Message from the back office', '']] },
  { img: 'hero-florist', alt: 'A florist checking her phone beside her car full of bouquets', where: 'Out on deliveries',
    pops: [['invoices', 'Riyeser Invoices', 'Order paid', '$85.00 received', 'ok'], ['bookings', 'Riyeser Bookings', 'Wedding flowers · Sat 8:00', 'Delivery booked', '']] },
  { img: 'hero-cafe-till', alt: 'A café owner taking a payment on a tablet at the counter', where: 'Serving customers',
    pops: [['pos', 'Riyeser POS', 'Sale complete · $12.50', 'Stock updated', 'ok'], ['accounting-basics', 'Riyeser Accounting', "Today's takings", '$1,240.00 · in your books', '']] },
];
function homeHero(up) {
  const pop = ([app, k, b, sub, tone], n) => `<div class="hfloat hp${n}"><img src="${up}assets/apps/${app}.png" alt="" width="40" height="40"><div><small>${esc(k)}</small><b>${esc(b)}</b><span class="${tone}">${esc(sub)}</span></div></div>`;
  return `<section class="hero3" aria-label="Riyeser: take it anywhere with you">
  <div class="h3slides">${HERO_SLIDES.map((sl, i) => `<figure class="h3slide${i === 0 ? ' on' : ''}" data-i="${i}">
    <img src="${up}assets/photos/${sl.img}.webp" srcset="${up}assets/photos/${sl.img}-900.webp 900w, ${up}assets/photos/${sl.img}.webp 1672w" sizes="100vw" alt="${esc(sl.alt)}" width="1672" height="941"${i ? ' loading="lazy"' : ' fetchpriority="high"'}>
    <div class="h3pops">${sl.pops.map((p, n) => pop(p, n + 1)).join('')}</div></figure>`).join('')}</div>
  <div class="c h3text">
    <span class="eyebrow">Riyeser</span>
    <h1>Your whole office.<br><span>Take it anywhere with you.</span></h1>
    <p class="lead">Invoices, books, pay, bookings, the till, team chat and phones. All linked, on your PC and on the go.</p>
    <div class="ctas"><a class="btn p big" href="${up}downloads.html">${WINDL}</a><a class="btn s big" href="/link/?signup">Create a free account</a></div>
    <p class="fine">Free tools forever · Paid programs free for 90 days · No card needed</p>
    <div class="h3dots" role="tablist" aria-label="Scenes">${HERO_SLIDES.map((sl, i) => `<button role="tab" aria-selected="${i === 0}" aria-label="${esc(sl.where)}" data-go="${i}"${i === 0 ? ' class="on"' : ''}><i></i><span>${esc(sl.where)}</span></button>`).join('')}</div>
  </div>
</section>
<script>(function(){var r=document.querySelector('.hero3');if(!r)return;var s=r.querySelectorAll('.h3slide'),d=r.querySelectorAll('.h3dots button'),i=0,t=null;
function go(n){s[i].classList.remove('on');d[i].classList.remove('on');d[i].setAttribute('aria-selected','false');i=(n+s.length)%s.length;s[i].classList.add('on');d[i].classList.add('on');d[i].setAttribute('aria-selected','true');}
var still=matchMedia('(prefers-reduced-motion: reduce)').matches||matchMedia('(max-width: 640px)').matches;   /* phones: one still picture */function play(){if(!still&&!t)t=setInterval(function(){go(i+1)},8000);}function stop(){clearInterval(t);t=null;}
d.forEach(function(b){b.addEventListener('click',function(){stop();go(+b.dataset.go);});});r.addEventListener('mouseenter',stop);r.addEventListener('mouseleave',play);
document.addEventListener('visibilitychange',function(){document.hidden?stop():play();});play();})();</script>`;
}
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
    <span class="on">${ci('home')}Home</span><span>${ci('book')}Books</span><span>${ci('people')}Payroll</span><span>${ci('invoice')}Invoices</span><span>${ci('folder')}Documents</span><span>${ci('pdf')}PDF</span>
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
const winFrame = (up, app, name, img, alt, w = 1400, h = 900) => `<div class="win"><div class="bar"><img src="${up}assets/${app === 'logo' ? 'logo-r.png' : `apps/${app}.png`}" alt="">${esc(name)}<span class="ctl">${svg('<path d="M5 12h14"/>')}${svg('<rect x="5" y="5" width="14" height="14" rx="1"/>')}${svg('<path d="M6 6l12 12M18 6L6 18"/>')}</span></div><img src="${up}assets/${img}" alt="${esc(alt)}" width="${w}" height="${h}"></div>`;
/** Free programs, a heading, then the paid ones: grp(list, (items) => html, (title) => heading html).
    Riyeser Link Office (comesWith) is in the paid group right after Riyeser Link, with "With Riyeser Link" where a price would be. */
const grouped = (list, wrap, head) => [[FREE_HEAD, list.filter((p) => p.free)], [PAID_HEAD, list.filter((p) => !p.free)]]
  .filter(([, l]) => l.length).map(([t, l]) => head(t) + wrap(l)).join('');
// A program that comes with another (Riyeser Link Office with Riyeser Link) has no price of its own: these say so and
// link to that program's row on the pricing page.
const withName = (p) => prog(p.comesWith).name;
const withHref = (p, up) => `${up}pricing.html#${p.comesWith}`;
const withShort = (p) => `With ${withName(p)}`;
/** A paid program's price, users included and extra-user price (all from PRICE). */
const priceTag = (p) => `<b>${usd(PRICE[MOD[p.id]])}</b> a month · ${esc(inclLine(MOD[p.id]))}`;
/** A section heading: optional eyebrow, the title and an optional one-line summary (the same on every section). */
const shead = (title, sub = '', eyebrow = '') => `<div class="shead">${eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : ''}<h2 class="h2">${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>`;
const firstSentence = (t) => t.split(/(?<=\.)\s+/)[0];
/** A checklist card (program pages). With m (a PRICE key) it shows that price and the buy buttons. */
const includedCard = (key, name, m, up, cls = '') => `<div class="inclcard${cls ? ` ${cls}` : ''}"${m ? ` id="${key}"` : ''}><div class="ih"><b>${esc(name)}</b><span class="ihp">${m ? `<b>${usd(PRICE[m])}</b> /month` : '<b class="free">Free</b> forever'}</span></div>
  <small class="ihq">${m ? `${esc(inclLine(m))} · free for 90 days` : 'No time limit, no card, no user charges'}</small>${inclList(key)}${m ? buyBtns(m) : ''}</div>`;
/** The price card at the top of a program page. */
const heroPrice = (p, up) => { const m = MOD[p.id];
  if (p.comesWith) { const w = MOD[p.comesWith]; return `<div class="hprice with"><div class="hp-main"><b>Comes with ${esc(withName(p))}</b></div>
    <div class="hp-sub">No separate price. The Windows program is free to download, and it switches on when your business has ${esc(withName(p))} (${usd(PRICE[w])} a month, free for 90 days).</div>
    <a class="hp-plus" href="${withHref(p, up)}"><b>${esc(withName(p))}</b>: chat, calls, desk phones and this office phone system, ${usd(PRICE[w])}/month ${ARR}</a>${buyBtns(w)}</div>`; }
  if (m) return `<div class="hprice"><div class="hp-main"><b>${usd(PRICE[m])}</b><span>/month per business</span></div>
    <div class="hp-sub">${esc(inclLine(m))}</div><div class="hp-sub">Or ${usd(PRICE[m] * 10)} a year: 2 months free</div><div class="hp-sub ok">${p.firstUse ? `Free for 90 days from the first time you use it, then ${usd(PRICE[m])} a month. No card` : 'Free for 90 days, no card'}</div>${buyBtns(m)}</div>`;
  const f = FREE_INFO[p.id] || {};
  return `<div class="hprice free"><div class="hp-main"><b>Free</b><span>forever</span></div>
    <div class="hp-sub">No time limit, no card, no user charges</div>${f.lim ? `<div class="hp-sub">Only limit: ${esc(f.lim)}</div>` : ''}${f.up ? `<div class="hp-sub">${esc(f.up)}</div>` : ''}</div>`; };
// "Works with" on each program page: only links the programs really have (checked against INCLUDES and the industry pages).
const RELATED = {
  central: [['accounting-basics', 'Money owed and overdue invoices on your home screen'], ['payroll', 'Your last pay run on your home screen'], ['documents', 'Search the office\'s documents from your home screen']],
  invoices: [['accounting-basics', 'Opens the same company file when you need more'], ['bookings', 'Invoice a finished job in one click'], ['central', 'Your home screen for every program']],
  'accounting-basics': [['pos', 'Till sales land as paid invoices'], ['payroll', 'Pay runs brought into your books'], ['bookings', 'Invoice a finished job in one click']],
  accounting: [['pos', 'Till sales land as paid invoices'], ['bookings', 'Invoice a finished job in one click'], ['central', 'Money owed, on your home screen']],
  pos: [['accounting-basics', 'Every sale lands as a paid invoice'], ['bookings', 'Customers shared with the till'], ['central', 'Your home screen for every program']],
  bookings: [['invoices', 'Invoice a finished job in one click'], ['accounting-basics', 'Job invoices land in your books'], ['pos', 'Customers shared with the till']],
  estimate: [['invoices', 'Its quotes become invoices in one click'], ['bookings', 'An accepted quote becomes a job'], ['central', 'Installs it and keeps it up to date']],
  payroll: [['accounting-basics', 'Pay runs brought into your books'], ['central', 'Your last pay run on your home screen']],
  documents: [['central', 'Search the office\'s documents from your home screen'], ['pdf', 'Open in Riyeser PDF: fill in, sign and edit a document']],
  link: [['link-office', 'Your office phone system: desk phones that ring each other'], ['central', 'Unread counts on your home screen'], ['invoices', 'Type INV-1047 and it stands out']],
  'link-office': [['link', 'See the desk phones, and answer office calls in the app (My phone)'], ['central', 'Installs it and keeps it up to date']],
  pdf: [['documents', 'Files and finds the office\'s PDFs, even scanned ones'], ['central', 'Your home screen for every program']],
};
/** A program card: icon, name, one line, then the price and "Learn more" pinned to the bottom (every card the same height). */
const progCard = (p, up) => `<a class="card pcard2" href="${up}programs/${p.id}.html">${iconBox(p, up)}<h3>${esc(p.short === 'Central' ? 'Riyeser Central' : p.short)}</h3><p>${esc(p.card || p.one)}</p>
<div class="cfoot"><span class="cp">${p.comesWith ? `<b class="with">${esc(withShort(p))}</b>` : p.free ? '<b class="free">Free</b>' : `<b>${usd(PRICE[MOD[p.id]])}</b> /month`}</span><span class="more">Learn more ${ARR}</span>
<small class="cq">${p.comesWith ? 'No separate price' : p.free ? 'No time limit, no card' : esc(inclOf(MOD[p.id])[0])}</small></div></a>`;
/** The last tile in each group, so the 3-column grid has no gaps: a quiet summary with a link to the prices. */
const groupTile = (free, up) => free
  ? `<a class="card ptile" href="${up}pricing.html"><b>Free, for good</b><p>No time limit, no card and no user charges.</p><span class="more">See every price ${ARR}</span></a>`
  : `<a class="card ptile" href="${up}pricing.html#calc"><b>Free for 90 days, no card</b><p>Then one price per business, with ${PRICE.users_included} users included. Pay yearly and get 2 months free.</p><span class="more">Work out your price ${ARR}</span></a>`;
/** Free programs, then paid ones, each in a 3-column grid (2 on tablets, 1 on phones). */
const progGrid = (list, up, head = (t) => `<h3 class="ghead">${esc(t)}</h3>`) => grouped(list, (l) => `<div class="grid pgrid">${l.map((p) => progCard(p, up)).join('')}${l.length % 3 ? groupTile(l[0].free, up) : ''}</div>`, head);

const more = (t) => `<span class="more">${t} ${ARR}</span>`;
const badgeOf = (p) => p.comesWith ? `<span class="badge with">${esc(withShort(p))}</span>` : p.free ? '<span class="badge free">Free forever</span>' : '<span class="badge">Free trial</span>';

/** assets/x.webp -> assets/x.webp?v=<content hash>, so browsers fetch new pictures and styles as soon as they change. */
const versionOf = {};
function withVersions(html) {
  return html.replace(/(assets\/[\w./-]+\.(?:webp|png|css))(?=["'\s)])/g, (m, a) => {
    if (!(a in versionOf)) { try { versionOf[a] = createHash('sha1').update(readFileSync(join(ROOT, a))).digest('hex').slice(0, 8); } catch { versionOf[a] = ''; } }
    return versionOf[a] ? `${a}?v=${versionOf[a]}` : a;
  });
}

/** Website traffic (track_visit in team/team-chat.sql; HQ → Reports → Website traffic): one note per page view to Riyeser's
    own database, on riyeser.com only. No cookies and nothing that outlives the browser tab (a random id in sessionStorage
    counts visits); no IP address or full browser details are kept. Nothing is sent with Do Not Track or Global Privacy
    Control on, or for robots, and a failed call never affects the page. */
const TRAFFIC = (() => { const c = readFileSync(join(ROOT, 'team', 'config.js'), 'utf8'); const v = (k) => (new RegExp(k + ':\\s*"([^"]+)"').exec(c) || [])[1];
  const url = v('supabaseUrl'); const key = v('supabaseKey'); if (!url || !key) return '';
  return String.raw`<script>(function(){try{var n=navigator,L=location,h=L.hostname,u=n.userAgent;if(!/(^|\.)riyeser\.com$/.test(h)||(n.doNotTrack||self.doNotTrack)=='1'||n.globalPrivacyControl||n.webdriver||/bot|crawl|spider|slurp|headless|lighthouse|preview|facebook/i.test(u))return;
var s,S,R=function(){return Math.random().toString(36).slice(2,12)};try{S=sessionStorage;s=S.getItem('rv');if(!s){s=R()+R();S.setItem('rv',s)}}catch(e){s=R()+R()}
var q=new URLSearchParams(L.search),G=function(k){return q.get('utm_'+k)},r='',w=screen.width,z='',Z={Fiji:'Fiji',Auckland:'New Zealand',Apia:'Samoa',Tongatapu:'Tonga',Efate:'Vanuatu',Guadalcanal:'Solomon Islands',Port_Moresby:'Papua New Guinea'};
try{r=new URL(document.referrer).hostname}catch(e){}try{z=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}var a=z.split('/');
fetch('${url}/rest/v1/rpc/track_visit',{method:'POST',keepalive:true,headers:{apikey:'${key}','Content-Type':'application/json'},body:JSON.stringify({s:s,p:L.pathname,r:r==h?'':r,us:G('source'),um:G('medium'),uc:G('campaign'),d:w<640?'phone':w<1025?'tablet':'desktop',
b:/Edg\//.test(u)?'Edge':/SamsungBrowser/.test(u)?'Samsung':/Firefox|FxiOS/.test(u)?'Firefox':/Chrome|CriOS/.test(u)?'Chrome':/Safari/.test(u)?'Safari':'Other',l:n.language,
g:a[0]=='Australia'?a[0]:a[0]=='Pacific'?Z[a[1]]||'Pacific':/^(Asia|Europe|Africa)$/.test(a[0])?a[0]:a[0]=='America'?'Americas':'Other'})}).catch(function(){})}catch(e){}})()</script>`; })();

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
${path === 'index.html' && SERVICES_MOVED && ASBUILT ? `<script>/* As Built now lives at ${SERVICES_APP}/ - forward its old links: demo and sign-in links,
   project and QR links (#/p/...), sign-in emails (#access_token, ?code=) and the installed app (start screen icon). */
(function(){var s=location.search,h=location.hash,app=false;try{app=matchMedia('(display-mode: standalone)').matches}catch(e){}
if(/[?&](demo|signin|code|error|token_hash|type)\\b/.test(s)||/^#(\\/|access_token|error|type=|refresh_token)/.test(h)||/[&#](access_token|type=recovery)/.test(h)||app)
location.replace(${JSON.stringify(SERVICES_APP)}+'/'+s+h)})()</script>` : ''}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav" id="nav"><div class="c">
  <a class="logo" href="${up}index.html"><img src="${up}assets/logo-r.png" alt="">Riyeser</a>
  <nav class="links">
    <div class="dd"><a href="${up}programs.html"${active === 'programs' ? ' class="on"' : ''}>Programs ${svg(LI.down)}</a><div class="menu-pop progs">${grouped(PROGRAMS, (l) => `${l.map((p) => `<a href="${up}programs/${p.id}.html">${appImg(p.id, up, 'mi')}<span>${esc(p.short === 'Central' ? 'Riyeser Central' : p.short)}<small>${esc(p.tag || '')}</small><em class="mprice${p.free ? ' free' : p.comesWith ? ' with' : ''}">${p.comesWith ? esc(withShort(p)) : p.free ? 'Free' : esc(priceShort(MOD[p.id]))}</em></span></a>`).join('')}${l[0].free ? '' : `<p class="mnote">${esc(USERS_NOTE)}</p>`}</div>`, (t) => `<div class="mcol"><div class="mgrp">${esc(t)}</div>`)}<a class="all" href="${up}programs.html">All programs ${ARR}</a></div></div>
    <div class="dd"><a href="${indLink(INDUSTRIES[0], up)}"${active === 'industries' ? ' class="on"' : ''}>Industries ${svg(LI.down)}</a><div class="menu-pop">${INDUSTRIES.map((i) => `<a href="${indLink(i, up)}"><span class="li">${li(i.icon, '')}</span><span>${esc(i.name)}<small>${esc(i.short)}</small></span></a>`).join('')}</div></div>
    <a href="${up}pricing.html"${active === 'pricing' ? ' class="on"' : ''}>Pricing</a>
    <div class="dd"><a href="${up}help.html"${active === 'help' ? ' class="on"' : ''}>Help ${svg(LI.down)}</a><div class="menu-pop">${guidesFor({ EMAIL, SERVICES_APP, up }).map((g) => `<a href="${up}help/${g.id}.html"><img class="appicon i-${g.app}" src="${up}assets/apps/${g.app}.png" alt="" style="width:30px;height:30px;border-radius:8px">${esc(g.name)}</a>`).join('')}<a class="all" href="${up}help.html">Help Centre ${ARR}</a></div></div>
    <a href="${up}downloads.html"${active === 'downloads' ? ' class="on"' : ''}>Downloads</a>
    <a class="mob-only" href="/link/">Sign in / Create account</a>
  </nav>
  <div class="right"><a class="signin" href="/link/">Sign in<span class="sx"> / Create account</span></a><a class="btn p" href="${up}downloads.html">${WINDL}</a></div>
  <button class="menu" aria-label="Menu" aria-expanded="false">☰</button>
</div></header>
<script>/* the phone menu button (no inline onclick: the Content-Security-Policy allows only these listed scripts) */
document.querySelector('#nav .menu').addEventListener('click',function(){var n=document.getElementById('nav');n.classList.toggle('open');this.setAttribute('aria-expanded',n.classList.contains('open'))});
/* phone menu: a tap on Programs, Industries or Help opens its list right there (a second tap goes to the page) */
document.querySelectorAll('.links > .dd > a').forEach(function(a){a.addEventListener('click',function(e){
  var nav=document.getElementById('nav');if(!nav.classList.contains('open'))return;var d=a.parentNode;
  if(!d.classList.contains('show')){e.preventDefault();document.querySelectorAll('.links > .dd.show').forEach(function(x){if(x!==d)x.classList.remove('show')});d.classList.add('show')}})});
</script>
<main id="main" tabindex="-1">${body(up)}</main>
<footer><div class="c">
  <div class="fcols">
    <div><a class="logo" href="${up}index.html"><img src="${up}assets/logo-r.png" alt="">Riyeser</a><p style="margin:0;max-width:300px">Windows software for small businesses. Work offline and keep your records on your PC.</p></div>
    <div class="fprogs"><h2 class="fh">Programs</h2><div class="fpcols">
      <div><h3 class="fsub">Free</h3>${PROGRAMS.filter((p) => p.free).map((p) => `<a href="${up}programs/${p.id}.html">${p.short === 'Central' ? 'Riyeser Central' : p.short}</a>`).join('')}</div>
      <div><h3 class="fsub">Paid</h3>${PROGRAMS.filter((p) => !p.free).map((p) => `<a href="${up}programs/${p.id}.html">${p.short === 'Central' ? 'Riyeser Central' : p.short}</a>`).join('')}</div></div></div>
    <div class="flinks">
      <div><h2 class="fh">Industries</h2>${INDUSTRIES.map((i) => `<a href="${indLink(i, up)}">${esc(i.name)}</a>`).join('')}</div>
      <div><h2 class="fh">Help</h2><a href="${up}help.html">Help Centre</a><a href="${up}help/start.html">Getting started</a><a href="${up}downloads.html">Downloads</a><a href="/link/?contact">Contact support</a><a class="fmail" href="mailto:${EMAIL}">${EMAIL}</a></div>
      <div><h2 class="fh">Riyeser</h2><a href="${up}pricing.html">Pricing</a><a href="/link/?signup">Create an account</a><a href="${up}developers/">Developers</a><a href="${up}terms.html">Terms of use</a></div>
    </div>
  </div>
  <div class="fbase"><span>© ${new Date().getFullYear()} Riyeser Group</span><span class="fwin"><span>For Windows 10 &amp; 11</span><span>Works offline</span><span>No account or card needed</span></span></div></div></footer>
<script>/* links inside cards and menus (data-href) */
document.addEventListener('click',function(e){var x=e.target.closest&&e.target.closest('[data-href]');if(!x)return;e.preventDefault();e.stopPropagation();location.href=x.getAttribute('data-href')},true);
document.addEventListener('keydown',function(e){var x=e.target.closest&&e.target.closest('[data-href]');if(x&&(e.key==='Enter'||e.key===' ')){e.preventDefault();location.href=x.getAttribute('data-href')}});</script>
<script>/* the Help Centre search button: open the first result, or go to the box */
document.querySelectorAll('[data-gosearch]').forEach(function(b){b.addEventListener('click',function(){var a=document.querySelector('#hres a');if(a)location.href=a.href;else document.getElementById('hq').focus()})});</script>
<script>/* Download buttons always point at the newest release file, whatever its exact name. */
(function(){var a=[].slice.call(document.querySelectorAll('a[href*="/releases/latest/download/"]'));if(!a.length||!window.fetch)return;
fetch('https://api.github.com/repos/raka1987/Riyeser/releases/latest').then(function(r){return r.ok?r.json():null}).then(function(rel){if(!rel)return;
a.forEach(function(el){var want=el.href.split('/').pop().replace(/^Riye?ser/i,'').toLowerCase();
var hit=(rel.assets||[]).filter(function(x){return x.name.replace(/^Riye?ser/i,'').toLowerCase()===want})[0];if(hit)el.href=hit.browser_download_url;});}).catch(function(){});})();</script>
${TRAFFIC}
</body>
</html>
`;
  const file = join(OUT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, withCsp(withVersions(html)));
}

// A Content-Security-Policy for every page: our own files, the inline scripts on that page (by their SHA-256), and
// GitHub's API (the download buttons find the newest installer). Nothing else may load or run. (frame-ancestors and
// the other headers can't be set from a <meta>: they belong in Cloudflare, see F16.)
// Website traffic (track_visit) goes to Riyeser's own Supabase project: its address comes from team/config.js.
const SUPABASE_ORIGIN = (() => { try { const m = /supabaseUrl:\s*"([^"]+)"/.exec(readFileSync(join(ROOT, 'team', 'config.js'), 'utf8')); return m ? new URL(m[1]).origin : ''; } catch { return ''; } })();
function withCsp(html) {
  const hashes = [...new Set([...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`))];
  const csp = ["default-src 'self'", `script-src 'self' https://static.cloudflareinsights.com ${hashes.join(' ')}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self' data:",
    `connect-src 'self' https://api.github.com https://cloudflareinsights.com${SUPABASE_ORIGIN ? ' ' + SUPABASE_ORIGIN : ''}`, "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"].join('; ');
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`);
}

const freeLine = 'Free download · no sign-up · no card · works offline';

// Riyeser Accounting comes in two editions: one download, the licence decides which one you get.
const EDITIONS = [
  { name: 'Accounting Basics', m: 'basic', app: 'accounting-basics',
    blurb: 'Everything a small shop or sole trader needs to invoice and keep stock.',
    has: ['Quotes, invoices and receiving payments', 'Customers, suppliers, bills and staff expense claims', 'Stock, stocktake and purchase orders for low stock',
      'Simple money in and money out', 'Works with Riyeser POS, the till app', 'Profit & Loss, GST summary, who owes you, sales and stock reports'] },
  { name: 'Accounting Plus', m: 'plus', app: 'accounting',
    blurb: 'Everything in Basics, plus the tools for full books.',
    has: ['Everything in Accounting Basics', 'Bank reconciliation and bank statement import', 'Payroll and pay runs',
      'General journal and search transactions', 'Jobs and budgets', 'Balance Sheet, Trial Balance and every report'] },
];
/** The Accounting Basics / Plus comparison: two equal cards, each price on its own line, and a short note. */
const editionsBlock = (up) => `
<div class="plans eds">${EDITIONS.map((e, i) => `<div class="plan${i ? ' best' : ''}"><div class="k">${appImg(e.app, up)}<b>${esc(e.name)}</b><span class="badge${i ? '' : ' free'}">Free for 90 days</span></div>
  <div class="price">${usd(PRICE[e.m])}<small> /month</small></div><div class="psub">per business · ${PRICE.users_included} users incl. · +${usd(PRICE.extra_user)} per extra user</div><p>${esc(e.blurb)}</p>
  <ul class="edlist">${e.has.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>${buyBtns(e.m)}</div>`).join('')}</div>
<p class="ednote">You pay for one or the other, never both: Plus includes everything in Basics for ${usd(PRICE.plus - PRICE.basic)} a month more. Switch either way any time; your books carry over, and Plus-only records wait safely in Basics.</p>`;
const ctaBlock = (up, title = 'Try Riyeser free', text = 'Download, install in one click, and keep everything on your own computer.') => `
<section class="c" style="padding-bottom:0"><div class="cta"><h2>${title}</h2><p>${text}</p>
<div class="ctas"><a class="btn t big" href="${up}downloads.html">${WINDL}</a><a class="btn glass big" href="${up}help.html">Help Centre</a></div>
<p class="fine">Windows 10 &amp; 11 · Free tools forever · paid programs free to start · no card</p></div></section>`;

// ---------- home ----------
page({
  path: 'index.html', title: 'Riyeser — your whole office. Take it anywhere with you.', active: '',
  description: 'Riyeser is everything your small business runs on: invoices, books, payroll, bookings, the till, team chat and office phones, all linked. On your PC and on the go.',
  body: (up) => `
${homeHero(up)}

<section class="finder" id="find"><div class="c">
  <h2 class="h2">Find your program</h2>
  ${grouped(PROGRAMS, (l) => `<div class="frow">${l.map((p) => `<a href="${up}programs/${p.id}.html"${demoTabOf[p.id] ? ` data-demo="${demoTabOf[p.id]}"` : ''}><img src="${up}assets/apps/${p.id}.png" alt="" width="96" height="96" loading="lazy"><span class="fname">${esc(p.short === 'Central' ? 'Central' : p.short)}</span><span class="fmeta"><small class="fprice${p.comesWith ? ' with' : p.free ? ' free' : ''}">${p.comesWith ? esc(withShort(p)) : p.free ? 'Free' : `${usd(PRICE[MOD[p.id]])}<span class="pm"> a month</span><span class="pmo">/mo</span>`}</small></span></a>`).join('')}</div>${l[0].free ? '' : `<p class="fnote">${esc(USERS_NOTE)}</p>`}`, (t) => `<p class="ghead">${esc(t)}</p>`)}
  ${connectTeaser()}
</div></section>

${demoSection(up)}

${connectSection(up)}

<section class="c">
  <h2 class="h2">Built for your industry</h2>
  <p class="sub">Pick what sounds like you. Install only what you need; every program shares one home screen.</p>
  <div class="inds2">${INDUSTRIES.map((i) => `<a class="ind2" href="${indLink(i, up)}"><img src="${up}assets/photos/${i.photoTall || i.photo}" alt="" loading="lazy" width="500" height="300"><div class="t"><h3>${esc(i.title)}</h3><i></i></div><p>${esc(i.short)} <b>Learn more ${ARR}</b></p></a>`).join('')}</div>
</section>

<section class="c" style="padding-top:0" id="programs">
  <span class="eyebrow">Programs</span>
  <h2 class="h2">One home screen. Every program you need.</h2>
  <p class="sub">Start with Riyeser Central, then add the programs you use. They all show up in Central.</p>
  ${progGrid(PROGRAMS, up)}
  <a class="hstrip" href="${up}help.html">${li('rocket')}<span><b>Help Centre</b><small>Plain-English, step-by-step guides for every program.</small></span><span class="more">Open the Help Centre ${ARR}</span></a>
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
    <ul class="ticks" style="margin:0"><li>Works with no internet: on site, in the car, anywhere</li><li>Forgot your password? Reset it on the PC without losing anything</li><li>Payroll keeps a backup every day</li><li>Riyeser Documents keeps deleted documents for 30 days, and a history of who did what</li>${ASBUILT ? '<li>Want online access too? As Built can sync to an online account when you choose</li>' : '<li>Riyeser Link chat and calls work online, on the PC and on phones</li>'}</ul>
  </div>
</section>

<section class="c" style="padding-top:0;max-width:920px">
  <h2 class="h2 center">Frequently asked questions</h2>
  <div class="faq" style="margin-top:26px">
  <details><summary>What does it cost?</summary><p>Riyeser Central, Riyeser Documents, Riyeser Invoices and PDF are free forever. Every paid program is free for 90 days with no card. After that, each one is a set price per business — not per person — with 3 users included: Accounting Basics ${usd(PRICE.basic)} a month, Accounting Plus ${usd(PRICE.plus)} (it includes Basics), Bookings ${usd(PRICE.bookings)}, Riyeser Link ${usd(PRICE.calls)} (chat, calls and office phones), Payroll ${usd(PRICE.payroll)} (unlimited employees), POS ${usd(PRICE.pos)} (1 till, unlimited cashiers) and Riyeser Estimate ${usd(PRICE.estimate)} (free for 90 days from the first time you use it).${ASBUILT ? ` As Built, for the building industry, is ${usd(PRICE.as_built)}.` : ''} Extra users are ${usd(PRICE.extra_user)} a month each, for each program, and your accountant signs in free. Bundles save more: ${BUNDLES.map((x) => `${x.name} ${usd(x.price)}`).join(', ')}. All prices are in US dollars, and 2 months are free if you pay yearly. See <a class="more" href="${up}pricing.html">Pricing</a>.</p></details>
  <details><summary>Does it need the internet?</summary><p>No. Everything works offline.${ASBUILT ? ' As Built can optionally sync to an online account so phones, clients and staff can see your projects.' : ' Riyeser Link (chat and calls) is the one part that runs online.'}</p></details>
  <details><summary>What computer do I need?</summary><p>A PC with Windows 10 or 11.${ASBUILT ? ' As Built also works in any web browser, on phones and tablets.' : ' Riyeser Link also works in any web browser, on phones and tablets.'}</p></details>
  <details><summary>Where do I start?</summary><p>Download Riyeser Central. It's the home screen for every program and shows you what else you can add. The <a class="more" href="${up}help/start.html">Getting started guide</a> walks you through it.</p></details>
  <details><summary>What if I get stuck?</summary><p>The <a class="more" href="${up}help.html">Help Centre</a> has a step-by-step guide for every program, or email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a> and a real person will reply.</p></details>
  </div>
</section>
${ctaBlock(up, 'Get started free today', 'Download Riyeser Central, add the programs you need, and keep everything on your own computer.')}
${MBAR}`,
});

// ---------- all programs ----------
page({
  path: 'programs.html', title: 'All programs — Riyeser', active: 'programs',
  description: `Every Riyeser program: Central, Invoices, Bookings, Riyeser Link, Riyeser Link Office, Accounting Basics, Accounting Plus, Payroll, Riyeser Documents${ASBUILT ? ', PDF and As Built' : ' and PDF'}.`,
  body: (up) => `${bandHero({ eyebrow: 'Programs', title: 'All programs', lead: 'A complete range of Riyeser programs to run and support your business. Start with Riyeser Central and add what you need.' })}
<section class="c blk first">${progGrid(PROGRAMS.filter((p) => p.id !== 'services'), up, (t) => `<div class="shead small"><h2>${esc(t)}</h2></div>`)}</section>
${ASBUILT ? `<section class="c blk">${shead('For the building industry', 'A separate program for trades and construction, priced on its own.')}<div class="grid pgrid">${progCard(prog('services'), up)}</div></section>` : ''}
<section class="c blk" id="editions">${shead('Accounting Basics or Accounting Plus?', 'Two editions of the same books. Pick the one that fits today, and switch any time.', 'Accounting')}${editionsBlock(up)}</section>
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
  const m = MOD[p.id];
  const rel = (RELATED[p.id] || []).map(([id, why]) => [prog(id), why]).filter(([o]) => o && PROGRAMS.includes(o));
  page({
    path: `programs/${p.id}.html`, title: `${p.name} — ${p.pitch}`, active: 'programs',
    description: `${p.name}: ${p.one}`,
    body: (up) => `
<div class="hero phero"><div class="c">
  <div>
    <div class="phead-who">${iconBox(p, up)}<div><span class="eyebrow">${esc(p.name)}</span>${badgeOf(p)}</div></div>
    <h1>${esc(p.pitch)}</h1><p class="lead">${esc(firstSentence(p.one))}</p>
    ${heroPrice(p, up)}
    <div class="ctas">${p.file ? `<a class="btn p big" href="${dl(p)}">${WINDL}</a>` : `<a class="btn p big" href="${dl(p)}">${p.link ? esc(p.linkLabel) : 'Get early access'}</a>`}${videoOf(p.id) ? videoBtn(videoOf(p.id), up, 'btn s big') : ''}<a class="tlink" href="${up}help/${p.id}.html">How to use it</a></div>
    ${p.file ? `<p class="fine">Windows 10 &amp; 11 · ${p.comesWith ? 'Sign in with your Riyeser account' : 'No account or card needed'}</p>` : ''}
  </div>
  ${p.shot ? winFrame(up, p.id, p.name, p.shot, `${p.name} screenshot`, ...(p.id === 'central' ? [1440, 900] : [])) : SHOTS[p.id] ? winFrame(up, p.comesWith || p.id, prog(p.comesWith || p.id).name, `shots/${SHOTS[p.id][0][0]}.webp`, SHOTS[p.id][0][3], SHOTS[p.id][0][1], SHOTS[p.id][0][2]) : `<div class="placeholder">${appImg(p.id, up)}</div>`}
</div></div>
<section class="c blk" id="included">${shead('What you get', p.comesWith ? `${p.name} comes with ${withName(p)}. There's no separate price.` : '', "What's included")}
  <div class="inclcard wide">${inclList(p.id)}</div>
  ${p.note ? `<p class="pnote">${esc(p.note)}</p>` : ''}
</section>
${gallery(p.id, up)}
${p.id.startsWith('accounting') ? `<section class="c blk" id="editions">${shead('Accounting Basics or Accounting Plus?', 'Two editions of the same books. Pick the one that fits today, and switch any time.', 'Compare')}${editionsBlock(up)}</section>` : ''}
${rel.length ? `<section class="c blk">${shead('Works with', 'Every Riyeser program shows up in Riyeser Central, your home screen for the whole business.')}
  <div class="wrow">${rel.map(([o, why]) => `<a href="${up}programs/${o.id}.html">${appImg(o.id, up)}<span><b>${esc(o.short === 'Central' ? 'Riyeser Central' : o.short)}</b><small>${esc(why)}</small></span>${ARR}</a>`).join('')}</div>
</section>` : ''}
${ctaBlock(up, p.file ? `Get ${p.name}` : 'Start with Riyeser Central')}
${videoOf(p.id) ? videoBox() : ''}`,
  });
}

// ---------- As Built (content carried over from the original riyeser.com homepage and FAQ) ----------
if (ASBUILT) {
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
  ${grouped(PROGRAMS.filter((p) => p.id !== 'central'), (l) => l.map((p) => `<div class="dl">${iconBox(p, up)}<div><h3>${esc(p.name)} ${badgeOf(p)}</h3><p>${esc(p.one)} <a class="more" href="${up}programs/${p.id}.html">More</a></p>${p.comesWith ? `<p class="cprice">Comes with <a class="more" href="${withHref(p, up)}">${esc(withName(p))}</a>. No separate price: it switches on when your business has ${esc(withName(p))}.</p>` : p.free ? '' : `<p class="cprice">${priceTag(p)}</p>`}</div>${p.file ? `<a class="btn p" href="${dl(p)}">${WINLOGO} Download</a>` : `<a class="btn s" href="${dl(p)}">${p.link ? esc(p.linkLabel) : 'Early access'}</a>`}</div>`).join(''), (t) => `<h3 class="ghead">${esc(t)}</h3>`)}
  <div class="note" style="margin-top:26px"><b>Windows says “Windows protected your PC”?</b> Click <b>More info</b>, then <b>Run anyway</b>. We're getting our programs signed so this goes away. The <a class="more" href="${up}help/start.html">Getting started guide</a> covers installing, updates and your licence.</div>
</section>
${ctaBlock(up, 'Need a hand getting started?', 'Our step-by-step guides use the same button names you see on screen.')}`,
});

// ---------- pricing ----------
// Every number comes from PRICE and BUNDLES (website/prices.mjs). The calculator uses planPrice (the same sums as
// riyeser_plan in team-chat.sql, which billing and HQ use): bundles are applied by themselves.
{
  const P = PRICE;
  const ROWS = [
    ['basic', 'Accounting Basics', 'accounting-basics', 'Invoices, quotes, customers, stock, money in and out, GST and profit &amp; loss.'],
    ['plus', 'Accounting Plus', 'accounting', 'Everything in Basics, plus bank reconciliation, statement import, payroll, BAS, journals, jobs and budgets. You pay for Plus <b>instead of</b> Basics, never both.'],
    ['bookings', 'Bookings', 'bookings', 'Jobs, appointments and table bookings on one calendar.'],
    ['estimate', 'Riyeser Estimate', 'estimate', 'Measure jobs on a plan, a photo or the map, and turn them into quotes.'],
    ['calls', 'Riyeser Link', 'link', `Chat, calls between your people and branches, office desk phones with <a class="more" href="programs/link-office.html">Riyeser Link Office</a>, and ${STORAGE_GB.link} GB of space for files shared in chat (not hosting).`],
    ['link-office', 'Riyeser Link Office', 'link-office', 'Your business\'s phone lines: the office phone system, with desk phones, extensions and ring groups, answered on desk phones or in the Riyeser Link app.'],
    ['payroll', 'Payroll', 'payroll', 'Time clock, timesheets, pay runs, payslips and leave. Staff who only clock in or see their payslips are free.'],
    ['pos', 'POS', 'pos', 'The till for shops, cafes and restaurants. Every sale goes into your books.'],
    ...(ASBUILT ? [['as_built', 'As Built', 'services', 'Services on your drawings, for the building industry. Doesn\'t need Accounting.']] : []),
  ];
  const CALC = ROWS.filter(([m]) => PRICE[m] != null);
  // What the number next to each program in the calculator counts
  const UNIT = { pos: 'Tills', payroll: 'Office users', bookings: 'Staff calendars', calls: 'People' };
  const FREE = [['central', 'Riyeser Central', 'Your home screen, and it installs and updates the rest'], ['documents', 'Riyeser Documents', 'Scan, file and find every office document'],
    ['invoices', 'Riyeser Invoices', 'Quotes, invoices and getting paid'], ['pdf', 'Riyeser PDF', 'Fill, sign, combine and edit PDFs']];
  const half = (n) => usd(n / 2);
  const NAME = Object.fromEntries(CALC.map(([m, n]) => [m, n]));
  const APP = Object.fromEntries(CALC.map(([m, , id]) => [m, id]));
  const big = BUNDLES.find((x) => x.popular) || BUNDLES[BUNDLES.length - 1];
  const bundleCard = (x, up) => `<div class="plan bundle${x.popular ? ' best' : ''}" id="bundle-${x.id}">${x.popular ? '<span class="tag">Most popular</span>' : ''}
    <div class="k"><b>${esc(x.name)}</b><small>${esc(x.who)}</small></div>
    <div class="price">${usd(x.price)}<small> /month</small></div>
    <div class="psub"><s>${usd(separately(x))}</s> if bought one by one</div>
    <div class="psub"><b class="save">You save ${usd(separately(x) - x.price)} a month</b></div>
    <div class="psub">Or ${usd(x.price * 10)} a year: 2 months free</div>
    <ul class="bmods">${x.mods.map((m) => `<li>${appImg(APP[m], up, 'bi')}<span>${esc(NAME[m])}</span><small>${usd(P[m])}</small></li>`).join('')}</ul>
    <p class="bnote">${P.users_included} users included in each program. Extra users ${usd(P.extra_user)} a month${x.mods.includes('pos') ? `, extra tills ${usd(P.extra_till)}` : ''}.</p>
    ${buyBtns(x.mods.join(','))}</div>`;
  page({
    path: 'pricing.html', title: 'Riyeser pricing — free tools, one price per program, and bundles', active: 'pricing',
    description: `All prices in US dollars, per business per month, with 3 users included in each program. Riyeser Central, Riyeser Documents, Invoices and PDF are free forever. Accounting Basics is ${usd(P.basic)}, Accounting Plus ${usd(P.plus)}, Bookings ${usd(P.bookings)}, Riyeser Link ${usd(P.calls)}, Payroll ${usd(P.payroll)}, POS ${usd(P.pos)} and Riyeser Estimate ${usd(P.estimate)}. Bundles from ${usd(Math.min(...BUNDLES.map((x) => x.price)))}. Every paid program is free for 90 days, no card.`,
    body: (up) => `
${bandHero({ title: 'Pricing', lead: `Start free. Pay only for the programs you use: one price per business per month, with ${P.users_included} users included in each. Take programs together in a bundle and pay less.` })}
<section class="c" style="padding-bottom:10px">
  <p class="usdnote" id="usd"><b>All prices in US dollars (US$)</b>, per business, per month. Any GST or local tax is shown before you pay. Pay yearly and get 2 months free.</p>
  ${EARLY_BIRD ? `<div class="earlybox" id="early"><div class="big">🐣</div><div><b>Early bird: 50% off for your first 12 months</b><p>For the first 100 businesses to buy. Half price on each program, bundle and extra user for 12 months (extra companies in Accounting stay full price) — for example Accounting Basics is ${half(P.basic)} a month instead of ${usd(P.basic)}, and the ${esc(big.name)} bundle ${half(big.price)} instead of ${usd(big.price)} — then the normal price. The offer ends when 100 businesses have it.</p></div></div>` : ''}

  <div id="bundles">
  <h2 class="h2" style="margin-top:8px">Bundles</h2>
  <p class="sub">Programs that work together, for one lower price. You can move up to a bigger bundle any time, and billing always gives you the bundle price when your programs make one.</p>
  <p class="bswipe" aria-hidden="true">Swipe for more bundles →</p>
  <div class="plans bundles">${BUNDLES.map((x) => bundleCard(x, up)).join('')}</div>
  </div>

  <h2 class="h2" style="margin-top:44px">Price list</h2>
  <div class="ptable-wrap"><table class="ptable">
    <thead><tr><th>Program</th><th>Price per business</th></tr></thead>
    <tbody class="gh">
      <tr class="grp"><th colspan="2">${esc(FREE_HEAD)} <span class="swipe" aria-hidden="true">Swipe for more →</span></th></tr></tbody>
    <tbody class="gcards">
      ${FREE.map(([id, n]) => `<tr data-free="${id}"><td><span class="pn">${appImg(id, up, 'ti')}<span><b>${n}</b>${freeInfo(id)}${inclDetails(id, n)}</span></span></td><td class="pr"><b>Free forever</b><small>No user charges</small></td></tr>`).join('')}
    </tbody><tbody class="gh">
      <tr class="grp"><th colspan="2">${esc(PAID_HEAD)} <span class="gnote">${esc(USERS_NOTE)}</span> <span class="swipe" aria-hidden="true">Swipe for more →</span></th></tr></tbody>
    <tbody class="gcards">
      ${ROWS.map(([m, n, id, d]) => m === 'link-office'
        ? `<tr id="link-office" data-row="link-office"><td><span class="pn">${appImg(id, up, 'ti')}<span><b>${n}</b><small>${d}</small>${inclDetails(id, n)}</span></span></td><td class="pr"><b class="with">With Riyeser Link</b><small>No separate price: it comes with <a href="#link">Riyeser Link</a></small></td></tr>`
        : `<tr${m === 'calls' ? ' id="link"' : ''} data-row="${m}"><td><span class="pn">${appImg(id, up, 'ti')}<span><b>${n}</b><small>${d}</small>${inclDetails(id, n)}</span></span></td><td class="pr"><b>${usd(P[m])}</b> a month<small>${m === 'estimate' ? `Free for 90 days from the first time you use it, then ${usd(P[m])} a month<br>` : ''}${inclOf(m).join('<br>')}<br>Or ${usd(P[m] * 10)} a year (2 months free)</small>${buyBtns(m, 'row')}</td></tr>`).join('')}
    </tbody></table></div>
  <details class="phfold addfold" open><summary>Good to know: users, tills, your accountant, companies and paying yearly</summary>
  <div class="addon"><div class="big">➕</div><div><b>Good to know</b><ul class="gk">
    <li><b>Users:</b> each paid program includes ${P.users_included} users, then <b>${usd(P.extra_user)} a month</b> for each extra user of that program. Users are the people who use it: who signs in to the books (Accounting), whose calendar is booked (Bookings), who chats or takes calls (Riyeser Link), and who runs pay or approves timesheets (Payroll).</li>
    <li><b>Payroll:</b> unlimited employees. Staff who only clock in or see their payslips are free.</li>
    <li><b>POS:</b> unlimited cashiers, with 1 till (checkout counter) included. Each extra till is <b>${usd(P.extra_till)} a month</b>.</li>
    <li><b>Your accountant is free:</b> one login for your accountant or bookkeeper, which doesn't count as a user.</li>
    <li><b>Another company</b>, trust or client's books in Accounting: <b>${usd(P.extra_company)} a month</b> each.</li>
    <li><b>Pay yearly:</b> pay for 10 months and get 12 (2 months free).</li>
    <li><b>Every paid program is free for 90 days</b>, no card.</li></ul></div></div>
  </details>
</section>

<section class="c" id="calc">
  <details class="phfold" open><summary>Work out your price (calculator)</summary>
  <div class="calc">
    <div><h2>Work out your price</h2><p class="muted">Tick the programs you want and say how many use each one.</p>
      <div class="cmods">${CALC.map(([m, n]) => `<div class="cmod" data-row="${m}"><label class="check"><input type="checkbox" data-m="${m}"${m === 'basic' ? ' checked' : ''}> ${n} <small class="muted">${usd(P[m])}</small></label>
        <div class="users sm" data-for="${m}"><span class="ul">${esc(UNIT[m] || 'Users')}</span><button type="button" data-step="-1" aria-label="${esc(`Fewer for ${n}`)}">−</button><input type="number" min="1" max="${m === 'pos' ? 100 : 500}" value="${m === 'pos' ? 1 : P.users_included}" data-u="${m}" aria-label="${esc(`${UNIT[m] || 'Users'} for ${n}`)}"><button type="button" data-step="1" aria-label="${esc(`More for ${n}`)}">+</button></div></div>`).join('')}</div>
      <p class="muted small" id="plusnote" hidden>Accounting Plus includes everything in Basics, so Basics isn't charged as well.</p>
      <p class="muted small" id="usersmax" hidden>More than 500 users? <a class="more" href="/link/?contact">Contact us</a> for a price.</p>
      <p class="muted" style="margin:10px 0 4px">Companies in Accounting</p>
      <div class="users"><button type="button" data-c="-1" aria-label="Fewer companies">−</button><input id="cos" type="number" min="1" max="200" value="1" aria-label="Number of companies"><button type="button" data-c="1" aria-label="More companies">+</button></div>
      <label class="yr" style="margin-top:12px"><input id="yearly" type="checkbox"> Pay yearly (10 months for 12)</label></div>
    <div class="out"><ul class="brk" id="per"></ul><div class="total" id="total"></div><div class="muted" id="note"></div><div class="bundleline" id="bline"></div>${EARLY_BIRD ? '<div class="ebline" id="eb"></div>' : ''}
      <div class="buybtns calcbtns" id="calcbuy"><a class="btn s" id="calcfree" href="${BUY_LINK('basic', false)}">Start free for 90 days</a><a class="btn p" id="calcpay" href="${BUY_LINK('basic', true)}">Buy this plan</a></div>
      <p class="muted small" style="margin:10px 0 0">All prices in US dollars. Pay by PayPal (card or PayPal balance) or bank transfer.</p></div>
  </div>
  </details>
</section>

<section class="c" id="accounting">
  <h2 class="h2">Accounting Basics or Accounting Plus?</h2>
  <details class="phfold" open><summary>Compare Basics and Plus</summary>
  ${editionsBlock(up)}
  </details>
</section>

${ASBUILT ? `<section class="c" id="as-built" style="padding-top:0">
  <h2 class="h2">For the building industry</h2><p class="sub">As Built is a separate program for trades and construction. It doesn't need Accounting.</p>
  <div class="plans eds"><div class="plan best"><span class="tag">Free for 90 days</span><div class="k">${appImg('services', up)}As Built</div>
    <div class="price">${usd(P.as_built)}<small> a month per business · 3 users included</small></div><p>Map every cable, pipe and duct on your drawings as it goes in, with inspections, test results and photos.</p>
    ${buyBtns('as_built')}<div class="ctas" style="justify-content:flex-start;margin-top:10px"><a class="btn s" href="${up}programs/services.html">About As Built ${ARR}</a></div></div></div>
</section>` : ''}

<section class="c faq" style="max-width:860px">
  <h2 class="h2">Questions</h2>
  <details class="phfold" open><summary>Show the questions ▾</summary>
  <details open><summary>Is it per person?</summary><p>No — per business. Each paid program is one price for the whole business, with ${P.users_included} users included. After that, each extra user is ${usd(P.extra_user)} a month for that program. For example, a business where 5 people use Accounting Plus and Riyeser Link, and 2 office staff run Payroll for 12 employees:</p><ul class="ex"><li>Accounting Plus: ${usd(P.plus)}, plus 2 extra users at ${usd(P.extra_user)} each (${usd(2 * P.extra_user)}) = <b>${usd(P.plus + 2 * P.extra_user)}</b></li><li>Riyeser Link: ${usd(P.calls)}, plus 2 extra users at ${usd(P.extra_user)} each (${usd(2 * P.extra_user)}) = <b>${usd(P.calls + 2 * P.extra_user)}</b></li><li>Payroll: ${usd(P.payroll)}. The 2 office staff are within the ${P.users_included} included, and the 12 employees who clock in are free = <b>${usd(P.payroll)}</b></li><li>Total: <b>${usd(P.plus + P.calls + P.payroll + 4 * P.extra_user)} a month</b></li></ul><p>Their accountant signs in free. The free programs have no user charges.</p></details>
  <details><summary>How do bundles work?</summary><p>A bundle is a set of programs for one lower price: Shop (Accounting Basics, POS and Riyeser Link) ${usd(BUNDLES[0].price)}, Office (Accounting Basics, Payroll and Riyeser Link) ${usd(BUNDLES[1].price)}, and Business (Accounting Plus, Bookings, Riyeser Link, Payroll and POS) ${usd(big.price)}. Each program in a bundle still includes ${P.users_included} users; extra users are ${usd(P.extra_user)} a month and extra tills ${usd(P.extra_till)}. You don't have to choose a bundle: when the programs you pick make one, you're charged the bundle price by itself. Move up to a bigger bundle any time. The early bird half price applies to bundles too.</p></details>
  <details><summary>Why US dollars?</summary><p>Riyeser is used by businesses in more than one country, so one price in one currency keeps it simple and fair for everyone. Your bank or card changes it into your own currency when you pay. Any GST or local tax is shown before you pay.</p></details>
  <details><summary>Basics or Plus?</summary><p>Start with Accounting Basics (${usd(P.basic)} a month) if you need invoices, stock and simple money in and out. Choose Accounting Plus (${usd(P.plus)} a month) for bank reconciliation, payroll in your books, BAS, journals, jobs and budgets. Plus includes everything in Basics, so you only ever pay for one: moving up is ${usd(P.plus - P.basic)} a month more, and your books carry straight over.</p></details>
  <details><summary>Are the free programs really free?</summary><p>Yes. Riyeser Central, Riyeser Documents, Riyeser Invoices and Riyeser PDF are free forever, with no card, no time limit and no user charges. The paid programs are optional: add them only if you need them.</p></details>
  <details><summary>Is Riyeser Link free?</summary><p>Riyeser Link is now a paid program (${usd(P.calls)} a month, ${P.users_included} users included, free for 90 days). It covers everything in one: chat, calls, desk phones, Riyeser Link Office (your office phone system) and ${STORAGE_GB.link} GB of space for files shared in chat. Businesses that already used Riyeser Link get 90 free days from the change. If it isn't paid after that, your chats stay and can still be read; only sending new messages waits until Riyeser Link is added from your Riyeser home page. Nothing is deleted.</p></details>
  <details><summary>How does the free trial work?</summary><p>Every paid program — Accounting Basics, Accounting Plus, Bookings, Riyeser Link, Payroll, POS and Riyeser Estimate${ASBUILT ? ', and As Built for the building industry' : ''} — is free for 90 days (Riyeser Estimate from the first time you use it). No card. The programs show how many days are left, and when the trial ends nothing is deleted: you keep every record and can still look and print; only adding new work waits for a licence.</p></details>
  <details><summary>What happens when the free part runs out?</summary><p>Nothing is deleted and nothing is charged. Everything you made stays and can still be opened, and quotes, payments and reports keep working. Only new invoices (Basics), new till sales (POS), new messages and calls (Riyeser Link) or that program's screens (the others) wait until you buy it. They unlock straight away.</p></details>
  <details><summary>How much file storage do I get in Riyeser Link?</summary><p>${STORAGE_GB.link} GB of chat files per business. Owners and admins can see how much is used in Billing &amp; Subscription. This is only space for the files people send in Link chats (photos, PDFs, documents). It is not website hosting, email hosting or cloud backup. Nothing is ever deleted for you: when you're full, new uploads wait until you make room or contact Riyeser support.</p></details>
  <details><summary>Is hosting included?</summary><p>No. Riyeser programs run on your own PCs, and your company files stay with you. The file space in Riyeser Link is only for files shared in chat. Website hosting and email hosting are not part of any plan. If Riyeser offers them later, they will be separate services with their own prices.</p></details>
  <details><summary>How do extra companies work?</summary><p>Your plan includes one company in Riyeser Accounting. Groups, trusts and bookkeepers can add more for ${usd(P.extra_company)} a month per extra company, with one sign-in. If you stop paying for one, its books stay — they open read-only until you add it back.</p></details>
  <details><summary>How does paying yearly work?</summary><p>Pay for 10 months and get 12: the yearly price is 10 times the monthly price, so 2 months are free. It works the same for bundles.</p></details>
  ${EARLY_BIRD ? `<details><summary>How does the early bird offer work?</summary><p>The first 100 businesses to buy pay half price for their first 12 months, on each program, bundle and extra user (not on extra companies) — for example ${half(P.basic)} instead of ${usd(P.basic)} a month for Accounting Basics. After 12 months the normal price applies. Once 100 businesses have it, the offer ends; we won't extend it or run a fake countdown.</p></details>` : ''}
  <details><summary>Can I cancel?</summary><p>Yes, any time. You keep everything you made, and can always open and export it.</p></details>
  <details><summary>How do I buy?</summary><p>Press <b>Buy now</b> next to a program or bundle (or <b>Buy this plan</b> in the price calculator). Create your free Riyeser account, or sign in, and choose how many users and monthly or yearly. Then pay with <b>PayPal</b> (a card or your PayPal balance; it renews by itself until you cancel) or by <b>bank transfer</b> (we give you an invoice with the bank details and a reference; the program switches on when the money arrives). Your free days aren't lost: paid time starts when your 90-day trial ends. Questions? Email <a class="more" href="mailto:${EMAIL}?subject=${encodeURIComponent('Buying Riyeser')}">${EMAIL}</a>.</p></details>
  </details>
</section>
<script>/* S2: on a phone the long parts start folded (a link to one of them opens it) */
if(matchMedia('(max-width: 640px)').matches)document.querySelectorAll('details.phfold').forEach(function(d){var keep=false;try{keep=!!location.hash&&(!!d.querySelector(location.hash)||d.parentNode.matches(location.hash))}catch(e){}if(!keep)d.open=false});</script>
${ctaBlock(up, 'Start free today', 'Install Riyeser Central — the free tools are yours to keep, and every paid program is free to start.')}
<script>(function(){var EB=${EARLY_BIRD ? 'true' : 'false'},P=${JSON.stringify(P)},B=${JSON.stringify(BUNDLES)},c=document.getElementById('cos'),y=document.getElementById('yearly');
var NAMES=${JSON.stringify(NAME)};
var planPrice=${planPrice.toString()};
function money(v){v=Math.round(v*100)/100;return 'US$'+v.toLocaleString('en-AU',{minimumFractionDigits:v%1?2:0,maximumFractionDigits:2})}
function li(t,v,cls){var l=document.createElement('li');if(cls)l.className=cls;var a=document.createElement('span');a.textContent=t;var b=document.createElement('b');b.textContent=v;l.appendChild(a);l.appendChild(b);return l}
function box(m){return document.querySelector('[data-m='+m+']')}
function ubox(m){return document.querySelector('[data-u='+m+']')}
function plural(n,one,many){return n+' '+(n===1?one:many)}
// M1: whole numbers from 1 to the most; the box shows what's charged (a blank box waits until you leave it)
function whole(el,max,soft){var raw=String(el.value).trim(),v=Math.round(Number(raw));if(el.dataset.u){if(Number(raw)>max)el.dataset.over=1;else if(Number(raw)<max)delete el.dataset.over;document.getElementById('usersmax').hidden=!document.querySelector('[data-u][data-over]')}
  if(raw===''||!isFinite(v)){if(!soft)el.value=1;return 1}v=Math.max(1,Math.min(max,v));if(String(v)!==raw&&(!soft||Number(raw)>max||Number(raw)<1||/[.,e]/i.test(raw)))el.value=v;return v}
function draw(e){
  var basic=box('basic'),plus=box('plus');
  if(e&&e.target===plus&&plus.checked)basic.checked=false;   // Plus includes Basics: one or the other
  if(e&&e.target===basic&&basic.checked)plus.checked=false;
  if(basic.checked&&plus.checked)basic.checked=false;
  document.getElementById('plusnote').hidden=!plus.checked;
  var mods=[].slice.call(document.querySelectorAll('[data-m]')).filter(function(x){return x.checked}).map(function(x){return x.dataset.m});
  [].slice.call(document.querySelectorAll('.cmod')).forEach(function(r){r.classList.toggle('on',mods.indexOf(r.dataset.row)>=0)});
  var users={},tills=1;mods.forEach(function(m){var el=ubox(m);if(!el)return;var n=whole(el,+el.max,true);if(m==='pos')tills=n;else users[m]=n});
  var k=whole(c,200,true),pl=planPrice(P,B,mods,users,tills),per=document.getElementById('per');per.innerHTML='';
  pl.lines.forEach(function(l){var bits=[];if(l.extraUsers)bits.push(plural(l.extraUsers,'extra user','extra users')+' × '+money(P.extra_user));if(l.extraTills)bits.push(plural(l.extraTills,'extra till','extra tills')+' × '+money(P.extra_till));
    var nm=l.bundle?l.name+' ('+l.mods.map(function(m){return NAMES[m]}).join(', ')+')':NAMES[l.module];
    per.appendChild(li(nm+' ('+money(l.price)+(bits.length?' + '+bits.join(' + '):l.module==='pos'?', 1 till, unlimited cashiers':', '+P.users_included+' users included')+')',money(l.monthly),l.bundle?'bundle':''))});
  var acc=pl.mods.indexOf('basic')>=0||pl.mods.indexOf('plus')>=0,cos=acc?(k-1)*P.extra_company:0;
  if(cos)per.appendChild(li((k-1)+' extra compan'+(k-1>1?'ies':'y')+' × '+money(P.extra_company),money(cos)));
  var m=pl.total+cos,t=document.getElementById('total'),note=document.getElementById('note'),eb=document.getElementById('eb'),bl=document.getElementById('bline');
  var u=pl.mods.filter(function(x){return x!=='pos'&&users[x]!==P.users_included}).map(function(x){return x+':'+users[x]}).join(',');
  var q='/link/?signup&add='+pl.mods.join(',')+(u?'&u='+u:'')+(tills>1&&pl.mods.indexOf('pos')>=0?'&tills='+tills:'')+(y.checked?'&period=yearly':''),cb=document.getElementById('calcbuy');
  cb.hidden=!pl.mods.length;document.getElementById('calcfree').href=q;document.getElementById('calcpay').href=q+'&buy=1';
  bl.textContent='';
  if(!pl.mods.length){per.appendChild(li('Free tools only','US$0'));t.textContent='US$0 a month';note.textContent='Central, Documents, Invoices and PDF are free forever.';if(eb)eb.textContent='';return}
  if(y.checked){t.textContent=money(m*10)+' a year';note.textContent=money(m)+' a month × 10: 2 months free.'}
  else{t.textContent=money(m)+' a month';note.textContent='After the 90-day free trial. Per business, not per person.'}
  var top=B.filter(function(x){return x.popular})[0],big=planPrice(P,B,pl.mods.concat(top.mods),users,tills),msg=pl.bundle?'✓ Bundle price: you save '+money(pl.saves)+' a month.':'';
  if(pl.bundle!==top.id&&big.bundle===top.id&&big.total<=pl.total+0.001)msg+=(msg?' ':'')+'Tip: the '+top.name+' bundle has all of these and more for '+money(big.total)+' a month.';
  bl.textContent=msg;
  if(EB&&eb){var e1=pl.total/2+cos;eb.textContent='🐣 Early bird: '+(y.checked?money(e1*10)+' for your first year':money(e1)+' a month for your first 12 months')+'.'}
}
document.querySelectorAll('[data-step]').forEach(function(x){x.addEventListener('click',function(){var el=x.parentNode.querySelector('[data-u]'),mx=+el.max;el.value=Math.max(1,Math.min(mx,whole(el,mx)+parseInt(x.dataset.step,10)));var cb=box(el.dataset.u);if(!cb.checked){cb.checked=true;draw({target:cb})}else draw()})});
document.querySelectorAll('[data-c]').forEach(function(x){x.addEventListener('click',function(){c.value=Math.max(1,Math.min(200,whole(c,200)+parseInt(x.dataset.c,10)));draw()})});
document.querySelectorAll('[data-u]').forEach(function(el){el.addEventListener('change',function(){whole(el,+el.max);draw()});el.addEventListener('input',function(){draw()})});
c.addEventListener('change',function(){whole(c,200);draw()});
document.querySelectorAll('[data-m]').forEach(function(x){x.addEventListener('change',draw)});
c.addEventListener('input',function(){draw()});y.addEventListener('change',function(){draw()});draw()})()</script>`,
  });
}

// ---------- help centre: a front page with search, and one guide per program (text in help.mjs) ----------
{
  const guides = (up) => guidesFor({ EMAIL, SERVICES_APP, up });
  const G0 = guides('');
  const gIcon = (g, up) => appImg(g.app, up);
  const gName = (g) => (g.id === 'accounting-basics' || g.id === 'accounting' ? `Accounting ${g.name.replace('Accounting ', '')}` : g.name);
  const countQ = (g) => g.groups.reduce((n, x) => n + x.items.length, 0);
  const plain = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  const searchBox = (ph) => `<div class="hsearch-wrap">${SEARCH}<input class="hsearch" id="hq" type="search" placeholder="${ph}" autocomplete="off" aria-label="Search help"><button class="go" type="button" aria-label="Search" data-gosearch="1">${SEARCH}</button></div>`;
  // Every question in every guide, for the search box (title, guide, link, words).
  const INDEX = (up) => guides(up).flatMap((g) => g.groups.flatMap((grp) => grp.items.map(([id, q, a]) => [q, gName(g), g.app, `${up}help/${g.id}.html#${id}`, plain(a).slice(0, 400)])));
  const searchScript = (up) => `<script>(function(){var IX=${JSON.stringify(INDEX(up)).replace(/</g, '\\u003c')},box=document.getElementById('hq'),out=document.getElementById('hres');
function esc(t){return t.replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
box.addEventListener('input',function(){var t=box.value.trim().toLowerCase();if(!t){out.classList.remove('on');out.innerHTML='';return}
var w=t.split(/\\s+/),hits=IX.map(function(r){var q=r[0].toLowerCase(),all=(q+' '+r[1]+' '+r[4]).toLowerCase(),s=0;for(var i=0;i<w.length;i++){if(all.indexOf(w[i])<0)return null;s+=q.indexOf(w[i])>=0?3:1}return[s,r]}).filter(Boolean).sort(function(a,b){return b[0]-a[0]}).slice(0,8);
out.innerHTML=hits.length?hits.map(function(h){var r=h[1];return '<a href="'+r[3]+'"><img src="${up}assets/apps/'+r[2]+'.png" alt=""><span>'+esc(r[0])+'<small>'+esc(r[1])+'</small></span></a>'}).join(''):'<div class="none">Nothing matches that. Try another word, or email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a>.</div>';out.classList.add('on')});
box.addEventListener('keydown',function(e){if(e.key==='Enter'){var a=out.querySelector('a');if(a)location.href=a.href}})})()</script>`;
  const contact = (up) => `<div class="contactbox"><div class="big">${MAIL}</div><div><h3>Still stuck? Ask a real person</h3><p>Email <a class="more" href="mailto:${EMAIL}?subject=${encodeURIComponent('Help with Riyeser')}">${EMAIL}</a>. Tell us which program, what you clicked and what you saw (a screenshot helps). Please don't send passwords, bank details or staff pay information.</p></div><a class="btn p" href="/link/?contact">${MAIL} Send us a message</a><a class="btn" href="mailto:${EMAIL}?subject=${encodeURIComponent('Help with Riyeser')}">Email us</a></div>`;

  page({
    path: 'help.html', title: 'Help Centre — Riyeser', active: 'help',
    description: `Step-by-step help for every Riyeser program: Central, Accounting Basics, Accounting Plus, Payroll, Riyeser Documents${ASBUILT ? ', PDF and As Built' : ' and PDF'}.`,
    body: (up) => {
      const G = guides(up);
      const popular = G.flatMap((g) => g.groups.flatMap((grp) => grp.items.filter((it) => it[3]).map((it) => [g, it]))).filter((_, i) => i % 2 === 0).slice(0, 8);
      return `
${bandHero({ eyebrow: 'Help Centre', title: 'How can we help?', img: 'blueprint.webp', up, extra: `<div class="hres-wrap" style="margin-top:22px">${searchBox('Search help — e.g. password, payslip, update, sign a PDF')}<div class="hresults" id="hres"></div></div>` })}
<section class="c" style="padding-top:40px;padding-bottom:20px">
  <h2 class="sr-only">Guides by program</h2>
  <div class="hcats">${G.map((g) => `<a class="hcat" href="${up}help/${g.id}.html"><div>${g.id === 'start' ? li('rocket') : `<div class="icon" style="width:48px;height:48px;margin-bottom:12px">${gIcon(g, up)}</div>`}<h3>${esc(gName(g))}</h3><p>${esc(g.blurb || g.intro)}</p></div>${svg(LI.chev, 'chev')}</a>`).join('')}</div>
</section>
<section class="c" style="padding-top:30px;max-width:1000px">
  <h2 class="h2" style="font-size:34px">Frequently asked questions</h2>
  <div class="faq" style="margin-top:18px">${popular.map(([g, [id, q, a]]) => `<details><summary>${q}</summary>${a}<p><a class="more" href="${up}help/${g.id}.html#${id}">More in the ${esc(gName(g))} guide ${ARR}</a></p></details>`).join('')}</div>
</section>
<section class="c" style="padding-top:8px;max-width:1000px">${contact(up)}</section>
${searchScript(up)}
<script>/* old Help Centre links (help.html#payroll) go to the new guide pages */(function(){var m={start:'start',central:'central',accounting:'accounting-basics',payroll:'payroll',services:'services',desk:'documents',pdf:'pdf'},h=location.hash.slice(1);if(m[h])location.replace('${up}help/'+m[h]+'.html')})()</script>`;
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
      <div class="row">${p && p.file ? `<a class="btn p sm" href="${dl(p)}">${DL} Download</a><a class="btn s sm" href="${up}programs/${p.id}.html">About ${esc(p.short === 'Central' ? 'Central' : p.short)}</a>` : g.id === 'link' ? `<a class="btn p sm" href="/link/">Open Riyeser Link</a>`: g.id === 'services' ? `<a class="btn s sm" href="${SERVICES_APP}/help.html">${BOOK} Full As Built guide</a>` : `<a class="btn p sm" href="${up}downloads.html">${DL} Downloads</a>`}</div></div></div>
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

// ---------- developers: online connections (the API, webhooks and the booking widget), from developers.mjs ----------
const API_BASE = `${SUPABASE_ORIGIN || 'https://goaugynxeatzqzifpoes.supabase.co'}/functions/v1/api`;
for (const d of developerPages({ API: API_BASE, EMAIL, WIDGET_JS: `${SITE}/widget/book.js` })) page({ ...d, active: 'developers', body: () => d.body });
// The booking widget (riyeser.com/widget/book.js): websites load it from here; it calls the API above.
mkdirSync(join(OUT, 'widget'), { recursive: true });
writeFileSync(join(OUT, 'widget', 'book.js'), readFileSync(join(ROOT, 'widget', 'book.js'), 'utf8').replace("'__RIYESER_API__'", JSON.stringify(API_BASE)));

// ---------- old riyeser.com addresses keep working ----------
const redirect = (path, to, label) => { const f = join(OUT, path); mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `<!doctype html><meta charset="utf-8"><title>${label} — Riyeser</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${to}"><p>Moved to <a href="${to}">${label}</a>.</p>`); };
redirect('faq.html', ASBUILT ? `${BASE}programs/services.html#faq` : `${BASE}help.html`, ASBUILT ? 'As Built questions and answers' : 'Riyeser Help Centre');
redirect('support.html', `${BASE}help.html`, 'Riyeser Help Centre');
// Renamed programs: their old pages forward to the new ones (keeping any #section).
const redirectKeep = (path, to, label) => { const f = join(OUT, path); mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `<!doctype html><meta charset="utf-8"><title>${label} — Riyeser</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${SITE}/${to.replace(/^(\.\.\/)+/, '')}"><script>location.replace(${JSON.stringify(to)}+location.search+location.hash)</script><p>Moved to <a href="${to}">${label}</a>.</p>`); };
redirectKeep('programs/team.html', '../programs/link.html', 'Riyeser Link');
redirectKeep('help/team.html', '../help/link.html', 'Riyeser Link help');
// Riyeser Desk Assistant is called Riyeser Documents now (older Centrals still open programs/desk-assistant.html).
redirectKeep('programs/desk-assistant.html', '../programs/documents.html', 'Riyeser Documents');
redirectKeep('help/desk-assistant.html', '../help/documents.html', 'Riyeser Documents help');

// ---------- extras ----------
cpSync(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true });
const SUBFOLDER = BASE !== '/';
if (!SUBFOLDER) writeFileSync(join(OUT, 'CNAME'), 'riyeser.com\n');
if (!SUBFOLDER) writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
const urls = ['', 'programs.html', 'downloads.html', 'pricing.html', 'help.html', 'terms.html', ...INDUSTRIES.map((i) => `industries/${i.id}.html`), ...PROGRAMS.map((p) => `programs/${p.id}.html`), ...guidesFor({ EMAIL, SERVICES_APP, up: '' }).map((g) => `help/${g.id}.html`), ...DEV_PAGES.map(([p]) => (p === 'index' ? 'developers/' : `developers/${p}.html`))];
writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}/${u}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(OUT, '404.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — Riyeser</title><link rel="stylesheet" href="${BASE}assets/site.css"><div class="c hero"><h1>That page isn't here</h1><p class="lead">It may have moved.</p><a class="btn p" href="${BASE}">Go to the home page</a></div>`);
console.log('Built', urls.length, 'pages into', OUT);
