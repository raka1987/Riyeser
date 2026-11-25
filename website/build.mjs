// Builds the Riyeser website into website/public (plain HTML, no server needed - GitHub Pages or any host).
//   node website/build.mjs
// Edit the text here; every page shares the same header, footer and download buttons.
import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { helpGuides } from './help.mjs';
import { PRICE, STORAGE_GB, usd } from './prices.mjs';

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
    one: `Invoicing, quotes, customers and stock for shops and sole traders. Free for 90 days, no card.`,
    pitch: 'Invoice, get paid and keep stock.' },
  { id: 'accounting', name: 'Riyeser Accounting Plus', short: 'Accounting Plus', icon: '📒', file: 'RiyeserAccountingPlus-Setup.exe',
    one: `Full double-entry books: everything in Basics plus banking, payroll, journals, jobs and budgets. Free for 90 days, no card. You pay for Plus instead of Basics, never both.`,
    pitch: 'Know who owes you, and who you owe.',
    shot: 'accounting.webp',
    note: 'Built for Australian small businesses. Have your accountant check your setup before relying on it for tax.' },
  { id: 'pos', name: 'Riyeser POS', short: 'POS', icon: '🧾', file: 'RiyeserPOS-Setup.exe',
    one: `A touch-friendly till for retail shops or cafes and restaurants. Every sale goes straight into your books. Free for 90 days, no card.`,
    pitch: 'Sell at the counter. Books done automatically.',
    shot: 'pos-till.webp',
    note: 'Riyeser POS is its own app. It opens the same company file as Accounting Basics or Plus, but you don\'t need Accounting to use it.' },
  { id: 'bookings', name: 'Riyeser Bookings', short: 'Bookings', icon: '📅', file: 'RiyeserBookings-Setup.exe',
    one: `Book and schedule trades jobs, appointments or restaurant tables, then invoice them in one click. Free for 90 days, no card.`,
    pitch: 'Every job and appointment, on one calendar.' },
  { id: 'payroll', name: 'Riyeser Payroll', short: 'Payroll', icon: '🕒', file: PAYROLL_WIN ? 'RiyeserPayroll-Setup.exe' : null,
    one: `Time clock, timesheets, pay runs, payslips and leave — and export every payslip as a PDF in one click. Free for 90 days, no card.`,
    pitch: 'Pay day without the paperwork.',
    note: 'Check the PAYE and FNPF rates in Payroll rules against the current rules before you pay staff.' },
  { id: 'desk-assistant', name: 'Riyeser Desk Assistant', short: 'Desk Assistant', icon: '🗂', file: 'RiyeserDeskAssistant-Setup.exe',
    one: 'Sorts every file by type and year, finds anything in seconds, finds duplicates, and keeps your to-dos.',
    pitch: 'Never lose a file again.',
    shot: 'desk-find.webp' },
  // Riyeser Link (formerly Riyeser Team). Its Windows installer keeps the old file name, so installed copies update in place.
  { id: 'link', name: 'Riyeser Link', short: 'Riyeser Link', icon: '💬', file: 'RiyeserTeam-Setup.exe', shot: 'team-chat.webp',
    one: 'Chat for your business: channels for jobs and the office, direct messages, and live updates on your PC and phone. Free. Add Link Plus for calls.',
    // A free program with a paid upgrade: shows the gold "★ Plus" marker wherever the program is listed.
    plus: { name: 'Riyeser Link Plus', module: 'calls', anchor: 'link-plus',
      what: `calls, desk phones and ${STORAGE_GB.plus} GB of chat file space`, line: `calls between people and branches, office desk phones, ${STORAGE_GB.plus} GB of space for files shared in chat (not hosting).` },
    pitch: 'Your whole team, in one conversation.' },
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
  invoices: ['Quotes, invoices and getting paid.', 'Free invoicing'],
  'accounting-basics': ['Invoices, quotes, customers and stock.', 'Invoicing and stock'],
  accounting: ['Full books, banking, BAS and payroll.', 'Full books and banking'],
  pos: ['A touch-friendly till for shops and cafes.', 'The till for shops and cafes'],
  bookings: ['Jobs, appointments and table bookings.', 'Jobs, appointments, tables'],
  payroll: ['Timesheets, pay runs, payslips and leave.', 'Pay runs and payslips'],
  'desk-assistant': ['Sorts and finds every file in seconds.', 'Sort and find your files'],
  link: ['Team chat: channels and direct messages.', 'Chat and calls'],
  pdf: ['Open, fill in, sign and combine PDFs.', 'Fill, sign and edit PDFs'],
  services: ['Cables, pipes and ducts on your plans.', 'Services on your drawings'],
};
for (const p of ALL_PROGRAMS) [p.card, p.tag] = CARD[p.id];
// Free programs first, then the paid ones. Every list on the site (menus, finder, grids, downloads, footer) uses this order.
const FREE_TOOLS = ['central', 'invoices', 'link', 'pdf', 'desk-assistant'];
const ORDER = [...FREE_TOOLS, 'accounting-basics', 'accounting', 'pos', 'bookings', 'payroll', 'services'];
ALL_PROGRAMS.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
for (const p of ALL_PROGRAMS) p.free = FREE_TOOLS.includes(p.id);
const FREE_HEAD = 'Free forever';
// What each free program includes, and its real limits (checked against the code: only Riyeser Link has one, file storage,
// plus 25 MB a file). null = no limits. Shown on the pricing page and on each free program's page.
const FREE_INFO = {
  central: { inc: 'Your home screen: installs and updates every Riyeser program, today\'s meetings, to-dos, file search and the first-day checklist.', lim: null },
  invoices: { inc: 'Unlimited quotes, invoices, customers and payments received, who owes you, and PDF copies to print or attach to your email.', lim: null,
    up: `For stock, bills, money in and out and reports, move up to Accounting Basics (${usd(PRICE.basic)}/month): it opens the same company file.` },
  link: { inc: 'Unlimited people, messages, channels and direct messages, on your PC, in a web browser and on your phone.',
    lim: `${STORAGE_GB.free} GB of space per business for files shared in chat (up to 25 MB a file). Not a hosting service.` },
  pdf: { inc: 'Open, fill in, sign, edit, combine and split PDFs, and read scanned pages.', lim: null },
  'desk-assistant': { inc: 'Sorts your files by type and year, finds anything by name or by the words inside, spots copies, and keeps your to-dos.', lim: null,
    note: 'Optional AI sorting uses your own AI key, if you add one.' },
};
// ---------- prices next to each program (every number from prices.mjs) ----------
// Each paid program's entry in PRICE. Riyeser Link is free; its paid upgrade (Link Plus) is p.plus.module.
const MOD = { 'accounting-basics': 'basic', accounting: 'plus', pos: 'pos', bookings: 'bookings', payroll: 'payroll', services: 'as_built' };
const USERS_LINE = `${PRICE.users_included} users included · +${usd(PRICE.extra_user)} a month per extra user`;
/** e.g. "US$39 a month · 3 users included · +US$x a month per extra user" (all from PRICE) */
const priceLong = (m) => `${usd(PRICE[m])} a month · ${USERS_LINE}`;
/** Where space is tight (menu rows): "US$39/mo · 3 users incl." */
const priceShort = (m) => `${usd(PRICE[m])}/mo · ${PRICE.users_included} users incl.`;
const USERS_NOTE = `Every paid program includes ${PRICE.users_included} users; extra users ${usd(PRICE.extra_user)} a month each.`;
/** Where the two buttons go: create an account (or sign in), then Riyeser home opens "Add to my plan" for these programs. */
const BUY_LINK = (mods, buy, extra = '') => `/link/?signup&add=${mods}${extra}${buy ? '&buy=1' : ''}`;
/** "Start free for 90 days" and "Buy now" for a paid program (m = its PRICE key). */
const buyBtns = (m, cls = '') => `<div class="buybtns${cls ? ' ' + cls : ''}" data-buy="${m}"><a class="btn s sm" href="${BUY_LINK(m, false)}">Start free for 90 days</a><a class="btn p sm" href="${BUY_LINK(m, true)}">Buy now</a></div>`;

// ---------- what each program includes ----------
// Checked against the programs themselves (November 2026): Accounting Basics / Plus, Invoices, POS and Bookings on main
// (riyeser/), Payroll on module/payroll, Central, PDF, Desk Assistant and Link Office in desktop/, Riyeser Link in
// website/team/. Only what the program does today; "coming soon" only where the site already says so.
const INCLUDES = {
  central: ['Every Riyeser program you have, one click away', 'Installs and updates Riyeser programs (Add a program)',
    'Money owed to you, overdue invoices and bills to pay, from Riyeser Accounting', 'Your last pay run, from Riyeser Payroll',
    "Today's meetings and to-dos, from Desk Assistant", 'Recent activity, invoices to chase and shortcuts (open the till, new invoice, new booking, run payroll)',
    'One search box for all your files: by name, words inside, company or an old name', 'Recent documents: pick up the files you opened last', 'A getting-started checklist',
    'Demo mode: try every program with a made-up sample business', 'Your company and Riyeser licence in one place', 'Light and dark look'],
  invoices: ['Quotes and tax invoices with your business details', 'Turn a quote into an invoice in one click', 'Customers and customer statements',
    'Receive payments, including part payments and one payment across several invoices', 'Who owes me: what each customer owes and what is overdue',
    'Print, download or save any invoice or quote as a PDF', 'Users with their own sign-in', 'Unlimited invoices, customers and payments',
    'Works on your PC with no internet', 'Accounting Basics or Plus opens the same company file when you need more'],
  'accounting-basics': ['Everything in Riyeser Invoices', 'Quotes, orders and invoices, with GST', 'Customers, credit limits and statements',
    'Suppliers, bills and paying bills', 'Stock items with average cost, stocktake and reorder alerts', 'Money in and money out, with GST worked out',
    'Pay runs brought in from Riyeser Payroll', 'Works with Riyeser POS: till sales land as paid invoices',
    'Reports: Profit & Loss, GST summary, who owes you, what you owe, sales by customer and item, purchases by supplier, stock value and items to reorder',
    'Print any report or export it to CSV for Excel', 'Dashboard: income, expenses, cash, overdue invoices, bills to pay and low stock',
    'Users and roles, and an audit trail', 'More than one company with one sign-in (extra companies charged separately)'],
  accounting: ['Everything in Accounting Basics', 'Bank reconciliation, with undo', 'Bank statement import (CSV): allocate or split each line in one click',
    'Transfer money between accounts', 'Payroll in your books: employees, pay runs, payslips with year-to-date totals and leave',
    'General journal, reversing entries and search transactions', 'Jobs (job costing) and monthly budgets', 'Tax codes and a BAS / GST summary (G1, 1A, 1B, W1, W2 and more)',
    'Lock a period once it is lodged', 'Every report: Balance Sheet, Trial Balance, General Ledger, Budget vs Actual, cash movement, Job P&L and payroll summary'],
  pos: ['Retail or restaurant setup', 'Product tiles with photos, categories, Favourites, search and barcode scanning', 'Hold a sale and come back to it',
    'Tables, kitchen dockets and takeaway (restaurant setup)', 'Cash with the change worked out, or card', 'Tax-invoice receipts to print',
    'Named tills (Till 1, Bar, Front counter), each opened with a float; every sale records its till', 'Refunds, voids and big discounts need a manager PIN or card, and stay in the audit trail', 'Close the till: count the drawer and print the Z-report',
    "Today's sales: takings, sales by hour, best sellers and how people paid", 'Products, stock and stocktake',
    'Every sale lands in your books as a paid invoice, with stock and GST updated'],
  bookings: ['Trades & site jobs, appointments, or restaurant tables', 'Day and week calendar, with a column for each staff member or table',
    'Warns you before double-booking a person or a table, and checks a table has enough seats', 'Booked, confirmed, in progress, done, cancelled and no-show, colour-coded',
    'Trades jobs with several visits, time and parts, at a fixed price or time and materials', 'Invoice a job in one click, in Riyeser Accounting or Invoices',
    'One list of finished jobs still waiting for an invoice', 'Opens the same company file as Accounting, Invoices and POS, so customers are shared', 'Customers booking online: coming soon'],
  payroll: ['Time clock on a shared PC: staff tap their name and a 4-digit PIN', 'Timesheets by person or as a list, with several shifts a day and supervisor approval',
    'Pay runs weekly, fortnightly, twice a month or monthly: preview, then finalise', 'PAYE and FNPF from the rates in your pay rules, unpaid break rules and regular deductions',
    'Payslips with year-to-date totals: print, save as PDFs or email', 'Staff can see their own payslips and timesheets',
    'Annual and sick leave: entitlement, taken and left', 'Bring in monthly Excel wage reports', 'Bank statement check: wage payments matched to staff (PDF, CSV or Excel)',
    'Access by area: Owner, Payroll officer, Supervisor, Employee and Read-only', 'Audit trail and login history', 'A backup every day (the last 30 kept)'],
  'desk-assistant': ['Sort by type: files into Organised › Type › Year, with a preview first', "Undo, and \"Where are my files?\" for every move, or put everything back",
    'Find a file by name, by the words inside, by company or by an old name, with type and year filters', 'Copies of the same file found, even a Word file and its PDF; extras archived, never deleted',
    'Reads scanned PDFs and photos so they can be filed and found', 'Organise new files, tidy the Desktop and clean up Downloads',
    "Today: meetings from your calendar and the to-dos from your meeting notes", 'A built-in PDF editor', 'Optional AI sorting with your own AI key', 'Only your own documents: never Windows or program files'],
  link: ['Channels for each topic, job or site', 'Private chats: only the people you choose can see them', 'Direct messages between two people',
    'Reactions, pinned chats and files shared in chat', 'INV-1047 or Booking 12 stands out in a message', 'Unread counts on every chat',
    'Invite your team with one link', 'On your PC (the Riyeser Link app starts with Windows), in any web browser and on phones', 'Each business only ever sees its own team',
    `${STORAGE_GB.free} GB of chat file space per business, up to 25 MB a file`],
  'link-plus': ['Everything in free Riyeser Link', 'Call a person, dial an extension, or call a whole branch', 'Turn the camera on for video in any call',
    'Branches with their own number and join code; extensions given automatically', 'Office desk phones with Riyeser Link Office (Yealink, Grandstream, Snom and Polycom)',
    "Answer on any PC or phone you're signed in on, with no call charges", 'A list of recent calls', `${STORAGE_GB.plus} GB of chat file space (not hosting)`],
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
  central: [['central-home', 1280, 800, 'Riyeser Central home screen in demo mode: tiles for Link, Invoices, Bookings, Books, POS, Payroll, Desk Assistant and PDF, with money owed, recent activity and shortcuts', 'Home screen, with money owed and recent activity'],
    ['central-home-dark', 1280, 800, 'The same Riyeser Central home screen in the dark look', 'The dark look']],
  invoices: [['invoices-list', 1440, 675, 'Riyeser Invoices sales register listing open and overdue invoices for sample customers', 'Your invoices, with what is open and overdue'],
    ['invoices-invoice', 1440, 495, 'An overdue invoice in Riyeser Invoices with a part payment applied and buttons to download a PDF or receive a payment', 'An invoice with a part payment']],
  'accounting-basics': [['basics-dash', 1440, 900, 'Accounting Basics dashboard: income, expenses, cash at bank, money owed, overdue invoices and bills to pay', 'The dashboard'],
    ['basics-stock', 1440, 900, 'Accounting Basics stock items with categories, quantity on hand, average cost and sell price', 'Stock items with average cost'],
    ['basics-invoice', 1440, 495, 'An invoice in Accounting Basics with stock and labour lines, GST and a part payment', 'An invoice with GST']],
  accounting: [['plus-dash', 1440, 900, 'Accounting Plus dashboard with income vs expenses by month, bank accounts and money owed', 'The dashboard'],
    ['plus-reconcile', 1440, 900, 'Bank reconciliation in Accounting Plus: tick each deposit and withdrawal that appears on the bank statement', 'Bank reconciliation'],
    ['plus-pnl', 1440, 900, 'Profit and Loss report in Accounting Plus with income, cost of sales and expenses', 'Profit & Loss']],
  pos: [['pos-till', 1440, 585, 'Riyeser POS till with product tiles by category and a current sale ready to pay', 'Selling at the till'],
    ['pos-sales', 1440, 900, "Riyeser POS Today screen: sales, GST collected, cash in drawer, sales by hour and best sellers", "Today's sales"],
    ['pos-done', 1440, 472, 'A finished sale in Riyeser POS, paid by card, with print receipt and no receipt buttons', 'Sale complete']],
  bookings: [['bookings-week', 1440, 585, 'Riyeser Bookings week view with a job each day for sample customers and technicians', 'The week at a glance'],
    ['bookings-jobs', 1440, 900, 'Riyeser Bookings jobs list: jobs needing a visit and jobs in hand, with addresses and next visit', 'Jobs and visits'],
    ['bookings-edit', 1440, 900, 'A booked visit in Riyeser Bookings with customer, time, job type, staff member and address, and an Invoice this job button', 'A visit, ready to invoice']],
  payroll: [['payroll-run', 1440, 630, 'A finished pay run in Riyeser Payroll: hours, gross pay, FNPF, PAYE and net pay for each person, with payslip buttons', 'A pay run with payslips'],
    ['payroll-timesheets', 1440, 900, 'Riyeser Payroll timesheets: paid hours for each person and a week grid of days and hours', 'Timesheets'],
    ['payroll-timeclock', 1440, 472, 'Riyeser Payroll time clock: staff tap their name to clock in or out', 'The time clock']],
  'desk-assistant': [['desk-search', 1280, 560, 'Desk Assistant Find a file: a search for a customer name finds two invoices, filed under Organised, Invoices, 2026', 'Find a file'],
    ['desk-today', 1280, 300, "Desk Assistant Today screen with meetings and the to-dos taken from meeting notes", "Today's to-dos"]],
  link: [['link-chat', 1440, 900, 'Riyeser Link demo: the jobs channel with messages, reactions and a shared job sheet, and the team list with extensions', 'Team chat'],
    ['link-calls', 1440, 900, 'Riyeser Link Plus calls: dial an extension or call a branch, with recent calls', 'Calls (Link Plus)'],
    ['link-desk-phones', 1440, 900, 'Riyeser Link desk phones page: set-up steps for Riyeser Link Office and the server address to type into phones', 'Desk phones (Link Plus)'],
    ['link-phone', 600, 1298, 'Riyeser Link on a phone: pinned chats, channels and direct messages', 'On a phone', 'tall']],
  pdf: [['pdf-markup', 1280, 800, 'Riyeser PDF with a site plan marked up: a red circle, an arrow, a note and a tick', 'Marking up a drawing'],
    ['pdf-tools', 1280, 800, 'The Riyeser PDF Tools menu: convert, split, page numbers, watermark and make smaller', 'More tools']],
};
// Not lazy: there are only two to four small pictures, and lazy ones showed blank in full-page captures.
const shotImg = (up, [f, w, h, alt]) => `<img src="${up}assets/shots/${f}-900.webp" srcset="${up}assets/shots/${f}-900.webp ${w > 900 ? 900 : w}w, ${up}assets/shots/${f}.webp ${w}w" sizes="(max-width: 640px) 92vw, (max-width: 1000px) 46vw, 560px" width="${w}" height="${h}" alt="${esc(alt)}" decoding="async">`;
/** A small gallery; each picture opens bigger in the lightbox (no libraries). */
const gallery = (id, up) => { const list = SHOTS[id]; if (!list) return ''; return `<section class="c blk gal-sec" id="screens">${shead('See it in use', 'The real program, filled in with a made-up sample business. Click a picture to see it bigger.', 'Screenshots')}
  <div class="gal g${list.length % 3 ? 2 : 3}">${list.map((s) => `<figure${s[5] ? ` class="${s[5]}"` : ''}><button type="button" class="shot" data-full="${up}assets/shots/${s[0]}.webp" data-cap="${esc(s[4])}" aria-label="${esc(`See bigger: ${s[4]}`)}">${shotImg(up, s)}</button><figcaption>${esc(s[4])}</figcaption></figure>`).join('')}</div>
</section>
<dialog class="lightbox" id="lb" aria-label="Screenshot"><button type="button" class="lb-x" aria-label="Close">×</button><button type="button" class="lb-nav lb-prev" aria-label="Previous picture">‹</button><figure><img alt=""><figcaption></figcaption></figure><button type="button" class="lb-nav lb-next" aria-label="Next picture">›</button></dialog>
<script>(function(){var d=document.getElementById('lb');if(!d||!d.showModal)return;var b=[].slice.call(document.querySelectorAll('.gal .shot')),i=0,im=d.querySelector('img'),cap=d.querySelector('figcaption');
function show(n){i=(n+b.length)%b.length;var x=b[i];im.src=x.dataset.full;im.alt=x.querySelector('img').alt;cap.textContent=x.dataset.cap;d.querySelectorAll('.lb-nav').forEach(function(z){z.hidden=b.length<2})}
b.forEach(function(x,n){x.addEventListener('click',function(){show(n);d.showModal()})});
d.querySelector('.lb-x').addEventListener('click',function(){d.close()});d.querySelector('.lb-prev').addEventListener('click',function(){show(i-1)});d.querySelector('.lb-next').addEventListener('click',function(){show(i+1)});
d.addEventListener('click',function(e){if(e.target===d)d.close()});d.addEventListener('keydown',function(e){if(e.key==='ArrowLeft')show(i-1);if(e.key==='ArrowRight')show(i+1)});
d.addEventListener('close',function(){var x=b[i];if(x)x.focus()})})()</script>`; };
const freeInfo = (id, up) => { const f = FREE_INFO[id]; if (!f) return ''; const p = prog(id);
  return `<div class="freeinfo"><div><b>Included free:</b> ${esc(f.inc)}</div>
    <div><b>Limits <span class="ii" title="${esc(f.lim ? 'The only limit on this free program' : 'No limits on this free program: no time limit, no card')}">ⓘ</span>:</b> ${f.lim ? `<span class="lim">${esc(f.lim)}</span>` : '<span class="nolim">No limits</span>'}${f.note ? ` <span class="muted">${esc(f.note)}</span>` : ''}</div>
    ${f.up ? `<div class="muted">${esc(f.up)}</div>` : ''}${p && p.plus ? plusLine(p, up, true) : ''}</div>`; };
// No single "from" price: each paid program shows its own price next to its name.
const PAID_HEAD = 'Free for 90 days, then:';
rmSync(OUT, { recursive: true, force: true });
const guidesFor = (o) => helpGuides(o).filter((g) => ASBUILT || g.id !== 'services');
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
    ...(ASBUILT ? {} : { lead: 'Book jobs, mark up drawings and keep every site file in order, from one Windows PC.', h: 'Jobs, drawings and paperwork',
      p: 'Book jobs at the customer\'s address, give them to your team, invoice in one click, and mark up and sign site drawings and forms.',
      shot: 'pdf.webp', shotName: 'Riyeser PDF', shotApp: 'pdf', cta: ['bookings', 'Explore Bookings'] }),
    progs: [['bookings', ['Jobs at the customer\'s address, given to your staff', 'A day view for every tradie, with no double-booking', 'Invoice the job in one click when it\'s done']],
      ['services', ['Cables, pipes and ducts drawn on your PDF plans, end to end', 'Inspections, test results and photos on every item', 'Works with no signal on site; as-builts ready at handover']],
      ['pdf', ['Mark up drawings with clouds, arrows, boxes and stamps', 'Fill in and sign site forms', 'Read scanned drawings so they can be searched']],
      ['desk-assistant', ['Files drawings, quotes and invoices by type and year', 'Spots duplicate copies of the same drawing', 'Find any file in seconds']]] },
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
var still=matchMedia('(prefers-reduced-motion: reduce)').matches;function play(){if(!still&&!t)t=setInterval(function(){go(i+1)},8000);}function stop(){clearInterval(t);t=null;}
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
const winFrame = (up, app, name, img, alt, w = 1400, h = 900) => `<div class="win"><div class="bar"><img src="${up}assets/${app === 'logo' ? 'logo-r.png' : `apps/${app}.png`}" alt="">${esc(name)}<span class="ctl">${svg('<path d="M5 12h14"/>')}${svg('<rect x="5" y="5" width="14" height="14" rx="1"/>')}${svg('<path d="M6 6l12 12M18 6L6 18"/>')}</span></div><img src="${up}assets/${img}" alt="${esc(alt)}" width="${w}" height="${h}"></div>`;
/** Free programs, a heading, then the paid ones: grp(list, (items) => html, (title) => heading html). */
const grouped = (list, wrap, head) => [[FREE_HEAD, list.filter((p) => p.free)], [PAID_HEAD, list.filter((p) => !p.free)]]
  .filter(([, l]) => l.length).map(([t, l]) => head(t) + wrap(l)).join('');
// The "★ Plus" marker for a free program with a paid upgrade (p.plus). Inside another link (a card or menu item) it can't be
// a link itself, so it's a span with data-href (the page script follows it); elsewhere it's a normal link.
const plusTitle = (p) => `Premium version available: ${p.plus.name} adds ${p.plus.what} for ${usd(PRICE[p.plus.module])}/month`;
const plusHref = (p, up) => `${up}pricing.html#${p.plus.anchor}`;
const plusPill = (p, up, asLink = false) => (!p.plus ? '' : asLink
  ? `<a class="pluspill" href="${plusHref(p, up)}" title="${esc(plusTitle(p))}">★ Plus</a>`
  : `<span class="pluspill" role="link" tabindex="0" data-href="${plusHref(p, up)}" title="${esc(plusTitle(p))}">★ Plus</span>`);
const plusLine = (p, up, asLink = false) => (!p.plus ? '' : asLink
  ? `<a class="plusline" href="${plusHref(p, up)}">★ <b>${esc(p.plus.name)}</b> available: ${esc(p.plus.line)}</a>`
  : `<span class="plusline" role="link" tabindex="0" data-href="${plusHref(p, up)}">★ <b>${esc(p.plus.name)}</b> available: ${esc(p.plus.line)}</span>`);
/** A paid program's price, users included and extra-user price (all from PRICE). */
const priceTag = (p) => `<b>${usd(PRICE[MOD[p.id]])}</b> a month · ${esc(USERS_LINE)}`;
/** A section heading: optional eyebrow, the title and an optional one-line summary (the same on every section). */
const shead = (title, sub = '', eyebrow = '') => `<div class="shead">${eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : ''}<h2 class="h2">${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>`;
const firstSentence = (t) => t.split(/(?<=\.)\s+/)[0];
/** A checklist card (program pages). With m (a PRICE key) it shows that price and the buy buttons. */
const includedCard = (key, name, m, up, cls = '') => `<div class="inclcard${cls ? ` ${cls}` : ''}"${m ? ` id="${key}"` : ''}><div class="ih"><b>${esc(name)}</b><span class="ihp">${m ? `<b>${usd(PRICE[m])}</b> /month` : '<b class="free">Free</b> forever'}</span></div>
  <small class="ihq">${m ? `${PRICE.users_included} users incl. · +${usd(PRICE.extra_user)} per extra user · free for 90 days` : 'No time limit, no card, no user charges'}</small>${inclList(key)}${m ? buyBtns(m) : ''}</div>`;
/** The price card at the top of a program page. */
const heroPrice = (p, up) => { const m = MOD[p.id];
  if (m) return `<div class="hprice"><div class="hp-main"><b>${usd(PRICE[m])}</b><span>/month per business</span></div>
    <div class="hp-sub">${PRICE.users_included} users included · +${usd(PRICE.extra_user)} a month per extra user</div><div class="hp-sub ok">Free for 90 days, no card</div>${buyBtns(m)}</div>`;
  const f = FREE_INFO[p.id] || {};
  return `<div class="hprice free"><div class="hp-main"><b>Free</b><span>forever</span></div>
    <div class="hp-sub">No time limit, no card, no user charges</div>${f.lim ? `<div class="hp-sub">Only limit: ${esc(f.lim)}</div>` : ''}${f.up ? `<div class="hp-sub">${esc(f.up)}</div>` : ''}${p.plus ? `<a class="hp-plus" href="#${p.plus.anchor}">★ <b>${esc(p.plus.name)}</b>: ${esc(p.plus.what)}, ${usd(PRICE[p.plus.module])}/month ${ARR}</a>` : ''}</div>`; };
// "Works with" on each program page: only links the programs really have (checked against INCLUDES and the industry pages).
const RELATED = {
  central: [['accounting-basics', 'Money owed and overdue invoices on your home screen'], ['payroll', 'Your last pay run on your home screen'], ['desk-assistant', "Today's meetings and to-dos on your home screen"]],
  invoices: [['accounting-basics', 'Opens the same company file when you need more'], ['bookings', 'Invoice a finished job in one click'], ['central', 'Your home screen for every program']],
  'accounting-basics': [['pos', 'Till sales land as paid invoices'], ['payroll', 'Pay runs brought into your books'], ['bookings', 'Invoice a finished job in one click']],
  accounting: [['pos', 'Till sales land as paid invoices'], ['bookings', 'Invoice a finished job in one click'], ['central', 'Money owed, on your home screen']],
  pos: [['accounting-basics', 'Every sale lands as a paid invoice'], ['bookings', 'Customers shared with the till'], ['central', 'Your home screen for every program']],
  bookings: [['invoices', 'Invoice a finished job in one click'], ['accounting-basics', 'Job invoices land in your books'], ['pos', 'Customers shared with the till']],
  payroll: [['accounting-basics', 'Pay runs brought into your books'], ['central', 'Your last pay run on your home screen']],
  'desk-assistant': [['central', "Today's meetings and to-dos on your home screen"], ['pdf', 'Fill in, sign and edit the PDFs it finds']],
  link: [['central', 'Unread counts on your home screen'], ['invoices', 'Type INV-1047 and it stands out'], ['bookings', 'Type Booking 12 and it stands out']],
  pdf: [['desk-assistant', 'Sorts and finds your PDFs, even scanned ones'], ['central', 'Your home screen for every program']],
};
/** A program card: icon, name, one line, then the price and "Learn more" pinned to the bottom (every card the same height). */
const progCard = (p, up) => `<a class="card pcard2" href="${up}programs/${p.id}.html">${iconBox(p, up)}<h3>${esc(p.short === 'Central' ? 'Riyeser Central' : p.short)}${p.plus ? ` ${plusPill(p, up)}` : ''}</h3><p>${esc(p.card || p.one)}</p>
<div class="cfoot"><span class="cp">${p.free ? '<b class="free">Free</b>' : `<b>${usd(PRICE[MOD[p.id]])}</b> /month`}</span><span class="more">Learn more ${ARR}</span>
<small class="cq">${p.plus ? `<span class="plusq" role="link" tabindex="0" data-href="${plusHref(p, up)}">★ ${esc(p.plus.name)} available</span>` : p.free ? 'No time limit, no card' : `${PRICE.users_included} users incl. · +${usd(PRICE.extra_user)} per extra user`}</small></div></a>`;
/** The last tile in each group, so the 3-column grid has no gaps: a quiet summary with a link to the prices. */
const groupTile = (free, up) => free
  ? `<a class="card ptile" href="${up}pricing.html"><b>Free, for good</b><p>No time limit, no card and no user charges. The only limit is Riyeser Link's ${STORAGE_GB.free} GB of chat file space.</p><span class="more">See every price ${ARR}</span></a>`
  : `<a class="card ptile" href="${up}pricing.html#calc"><b>Free for 90 days, no card</b><p>Then one price per business, with ${PRICE.users_included} users included. Pay yearly and get 2 months free.</p><span class="more">Work out your price ${ARR}</span></a>`;
/** Free programs, then paid ones, each in a 3-column grid (2 on tablets, 1 on phones). */
const progGrid = (list, up, head = (t) => `<h3 class="ghead">${esc(t)}</h3>`) => grouped(list, (l) => `<div class="grid pgrid">${l.map((p) => progCard(p, up)).join('')}${l.length % 3 ? groupTile(l[0].free, up) : ''}</div>`, head);

const more = (t) => `<span class="more">${t} ${ARR}</span>`;
const badgeOf = (p) => p.free ? '<span class="badge free">Free forever</span>' : '<span class="badge">Free trial</span>';

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
    <div class="dd"><a href="${up}programs.html"${active === 'programs' ? ' class="on"' : ''}>Programs ${svg(LI.down)}</a><div class="menu-pop progs">${grouped(PROGRAMS, (l) => `${l.map((p) => `<a href="${up}programs/${p.id}.html">${appImg(p.id, up, 'mi')}<span>${esc(p.short === 'Central' ? 'Riyeser Central' : p.short)}${p.plus ? ` ${plusPill(p, up)}` : ''}<small>${esc(p.tag || '')}</small><em class="mprice${p.free ? ' free' : ''}">${p.free ? `Free${p.plus ? ` <i>· ${esc(p.plus.name.replace('Riyeser ', ''))} ${usd(PRICE[p.plus.module])}/mo</i>` : ''}` : esc(priceShort(MOD[p.id]))}</em></span></a>`).join('')}${l[0].free ? '' : `<p class="mnote">${esc(USERS_NOTE)}</p>`}</div>`, (t) => `<div class="mcol"><div class="mgrp">${esc(t)}</div>`)}<a class="all" href="${up}programs.html">All programs ${ARR}</a></div></div>
    <div class="dd"><a href="${indLink(INDUSTRIES[0], up)}"${active === 'industries' ? ' class="on"' : ''}>Industries ${svg(LI.down)}</a><div class="menu-pop">${INDUSTRIES.map((i) => `<a href="${indLink(i, up)}"><span class="li">${li(i.icon, '')}</span><span>${esc(i.name)}<small>${esc(i.short)}</small></span></a>`).join('')}</div></div>
    <a href="${up}pricing.html"${active === 'pricing' ? ' class="on"' : ''}>Pricing</a>
    <div class="dd"><a href="${up}help.html"${active === 'help' ? ' class="on"' : ''}>Help ${svg(LI.down)}</a><div class="menu-pop">${guidesFor({ EMAIL, SERVICES_APP, up }).map((g) => `<a href="${up}help/${g.id}.html"><img class="appicon i-${g.app}" src="${up}assets/apps/${g.app}.png" alt="" style="width:30px;height:30px;border-radius:8px">${esc(g.name)}</a>`).join('')}<a class="all" href="${up}help.html">Help Centre ${ARR}</a></div></div>
    <a href="${up}downloads.html"${active === 'downloads' ? ' class="on"' : ''}>Downloads</a>
    <a class="mob-only" href="/link/">Sign in / Create account</a>
  </nav>
  <div class="right"><a class="signin" href="/link/">Sign in<span class="sx"> / Create account</span></a><a class="btn p" href="${up}downloads.html">${WINDL}</a></div>
  <button class="menu" aria-label="Menu" aria-expanded="false" onclick="var n=document.getElementById('nav');n.classList.toggle('open');this.setAttribute('aria-expanded',n.classList.contains('open'))">☰</button>
</div></header>
<script>/* phone menu: a tap on Programs, Industries or Help opens its list right there (a second tap goes to the page) */
document.querySelectorAll('.links > .dd > a').forEach(function(a){a.addEventListener('click',function(e){
  var nav=document.getElementById('nav');if(!nav.classList.contains('open'))return;var d=a.parentNode;
  if(!d.classList.contains('show')){e.preventDefault();document.querySelectorAll('.links > .dd.show').forEach(function(x){if(x!==d)x.classList.remove('show')});d.classList.add('show')}})});
</script>
<main id="main" tabindex="-1">${body(up)}</main>
<footer><div class="c">
  <div class="fcols">
    <div><a class="logo" href="${up}index.html"><img src="${up}assets/logo-r.png" alt="">Riyeser</a><p style="margin:0;max-width:300px">Windows software for small businesses. Work offline and keep your records on your PC.</p></div>
    <div><h2 class="fh">Programs</h2>${PROGRAMS.map((p) => `<a href="${up}programs/${p.id}.html">${p.short === 'Central' ? 'Riyeser Central' : p.short}</a>`).join('')}</div>
    <div><h2 class="fh">Industries</h2>${INDUSTRIES.map((i) => `<a href="${indLink(i, up)}">${esc(i.name)}</a>`).join('')}</div>
    <div><h2 class="fh">Help</h2><a href="${up}help.html">Help Centre</a><a href="${up}help/start.html">Getting started</a><a href="${up}downloads.html">Downloads</a><a href="/link/?contact">Contact support</a><a href="mailto:${EMAIL}">${EMAIL}</a></div>
    <div><h2 class="fh">Riyeser</h2><a href="${up}pricing.html">Pricing</a><a href="/link/?signup">Create an account</a><a href="${up}terms.html">Terms of use</a></div>
  </div>
  <div class="fbase"><span>© ${new Date().getFullYear()} Riyeser Group</span><span>For Windows 10 &amp; 11 · Works offline · No account or card needed</span></div></div></footer>
<script>/* the "★ Plus" markers inside cards and menus open the pricing page's section */
document.addEventListener('click',function(e){var x=e.target.closest&&e.target.closest('[data-href]');if(!x)return;e.preventDefault();e.stopPropagation();location.href=x.getAttribute('data-href')},true);
document.addEventListener('keydown',function(e){var x=e.target.closest&&e.target.closest('[data-href]');if(x&&(e.key==='Enter'||e.key===' ')){e.preventDefault();location.href=x.getAttribute('data-href')}});</script>
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
  writeFileSync(file, withVersions(html));
}

const freeLine = 'Free download · no sign-up · no card · works offline';

// Riyeser Accounting comes in two editions: one download, the licence decides which one you get.
const EDITIONS = [
  { name: 'Accounting Basics', m: 'basic', app: 'accounting-basics',
    blurb: 'Everything a small shop or sole trader needs to invoice and keep stock.',
    has: ['Quotes, invoices and receiving payments', 'Customers, suppliers and bills', 'Stock items, stocktake and reorder alerts',
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
  ${grouped(PROGRAMS, (l) => `<div class="frow">${l.map((p) => `<a href="${up}programs/${p.id}.html"><img src="${up}assets/apps/${p.id}.png" alt="" width="96" height="96" loading="lazy"><span>${esc(p.short === 'Central' ? 'Central' : p.short)}${p.plus ? ` ${plusPill(p, up)}` : ''}</span><small class="fprice">${p.free ? 'Free' : `${usd(PRICE[MOD[p.id]])} a month`}</small></a>`).join('')}</div>${l[0].free ? '' : `<p class="fnote">${esc(USERS_NOTE)}</p>`}`, (t) => `<p class="ghead">${esc(t)}</p>`)}
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
    <ul class="ticks" style="margin:0"><li>Works with no internet: on site, in the car, anywhere</li><li>Forgot your password? Reset it on the PC without losing anything</li><li>Payroll keeps a backup every day</li><li>Desk Assistant records every file it moves, with “Put everything back”</li>${ASBUILT ? '<li>Want online access too? As Built can sync to an online account when you choose</li>' : '<li>Riyeser Link chat and calls work online, on the PC and on phones</li>'}</ul>
  </div>
</section>

<section class="c" style="padding-top:0;max-width:920px">
  <h2 class="h2 center">Frequently asked questions</h2>
  <div class="faq" style="margin-top:26px">
  <details><summary>What does it cost?</summary><p>Riyeser Central, Riyeser Invoices, Riyeser Link chat, PDF and the Desk Assistant file organiser are free forever. Every paid program is free for 90 days with no card. After that, each one is a set price per business — not per person — with 3 users included: Accounting Basics ${usd(PRICE.basic)} a month, Accounting Plus $${PRICE.plus} (it includes Basics), Payroll $${PRICE.payroll}, POS $${PRICE.pos}, Bookings $${PRICE.bookings} and Riyeser Link Plus $${PRICE.calls}.${ASBUILT ? ` As Built, for the building industry, is $${PRICE.as_built}.` : ''} More people are $${PRICE.extra_user} a month each, for each program. All prices are in US dollars, and 2 months are free if you pay yearly. See <a class="more" href="${up}pricing.html">Pricing</a>.</p></details>
  <details><summary>Does it need the internet?</summary><p>No. Everything works offline.${ASBUILT ? ' As Built can optionally sync to an online account so phones, clients and staff can see your projects.' : ' Riyeser Link (chat and calls) is the one part that runs online.'}</p></details>
  <details><summary>What computer do I need?</summary><p>A PC with Windows 10 or 11.${ASBUILT ? ' As Built also works in any web browser, on phones and tablets.' : ' Riyeser Link also works in any web browser, on phones and tablets.'}</p></details>
  <details><summary>Where do I start?</summary><p>Download Riyeser Central. It's the home screen for every program and shows you what else you can add. The <a class="more" href="${up}help/start.html">Getting started guide</a> walks you through it.</p></details>
  <details><summary>What if I get stuck?</summary><p>The <a class="more" href="${up}help.html">Help Centre</a> has a step-by-step guide for every program, or email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a> and a real person will reply.</p></details>
  </div>
</section>
${ctaBlock(up, 'Get started free today', 'Download Riyeser Central, add the programs you need, and keep everything on your own computer.')}`,
});

// ---------- all programs ----------
page({
  path: 'programs.html', title: 'All programs — Riyeser', active: 'programs',
  description: `Every Riyeser program: Central, Invoices, Bookings, Riyeser Link, Accounting Basics, Accounting Plus, Payroll, Desk Assistant${ASBUILT ? ', PDF and As Built' : ' and PDF'}.`,
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
    <div class="ctas">${p.file ? `<a class="btn p big" href="${dl(p)}">${WINDL}</a>` : `<a class="btn p big" href="${dl(p)}">${p.link ? esc(p.linkLabel) : 'Get early access'}</a>`}<a class="tlink" href="${up}help/${p.id}.html">How to use it</a></div>
    ${p.file ? `<p class="fine">Windows 10 &amp; 11 · No account or card needed</p>` : ''}
  </div>
  ${p.shot ? winFrame(up, p.id, p.name, p.shot, `${p.name} screenshot`, ...(p.id === 'central' ? [1440, 900] : [])) : SHOTS[p.id] ? winFrame(up, p.id, p.name, `shots/${SHOTS[p.id][0][0]}.webp`, SHOTS[p.id][0][3], SHOTS[p.id][0][1], SHOTS[p.id][0][2]) : `<div class="placeholder">${appImg(p.id, up)}</div>`}
</div></div>
<section class="c blk" id="included">${shead('What you get', p.plus ? `${p.name} is free. ${p.plus.name} adds ${p.plus.what}.` : '', "What's included")}
  ${p.plus ? `<div class="inclgrid two">${includedCard(p.id, p.name, null, up)}${includedCard(p.plus.anchor, p.plus.name, p.plus.module, up, 'plus')}</div>` : `<div class="inclcard wide">${inclList(p.id)}</div>`}
  ${p.note ? `<p class="pnote">${esc(p.note)}</p>` : ''}
</section>
${gallery(p.id, up)}
${p.id.startsWith('accounting') ? `<section class="c blk" id="editions">${shead('Accounting Basics or Accounting Plus?', 'Two editions of the same books. Pick the one that fits today, and switch any time.', 'Compare')}${editionsBlock(up)}</section>` : ''}
${rel.length ? `<section class="c blk">${shead('Works with', 'Every Riyeser program shows up in Riyeser Central, your home screen for the whole business.')}
  <div class="wrow">${rel.map(([o, why]) => `<a href="${up}programs/${o.id}.html">${appImg(o.id, up)}<span><b>${esc(o.short === 'Central' ? 'Riyeser Central' : o.short)}</b><small>${esc(why)}</small></span>${ARR}</a>`).join('')}</div>
</section>` : ''}
${ctaBlock(up, p.file ? `Get ${p.name}` : 'Start with Riyeser Central')}`,
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
  ${grouped(PROGRAMS.filter((p) => p.id !== 'central'), (l) => l.map((p) => `<div class="dl">${iconBox(p, up)}<div><h3>${esc(p.name)} ${badgeOf(p)}${plusPill(p, up, true)}</h3><p>${esc(p.one)} <a class="more" href="${up}programs/${p.id}.html">More</a></p>${p.free ? '' : `<p class="cprice">${priceTag(p)}</p>`}${plusLine(p, up, true)}</div>${p.file ? `<a class="btn p" href="${dl(p)}">${WINLOGO} Download</a>` : `<a class="btn s" href="${dl(p)}">${p.link ? esc(p.linkLabel) : 'Early access'}</a>`}</div>`).join(''), (t) => `<h3 class="ghead">${esc(t)}</h3>`)}
  <div class="note" style="margin-top:26px"><b>Windows says “Windows protected your PC”?</b> Click <b>More info</b>, then <b>Run anyway</b>. We're getting our programs signed so this goes away. The <a class="more" href="${up}help/start.html">Getting started guide</a> covers installing, updates and your licence.</div>
</section>
${ctaBlock(up, 'Need a hand getting started?', 'Our step-by-step guides use the same button names you see on screen.')}`,
});

// ---------- pricing ----------
// Every number comes from PRICE (website/prices.mjs). The calculator works the same way as HQ's estimate (riyeser_bill in team-chat.sql).
{
  const P = PRICE;
  const ROWS = [
    ['basic', 'Accounting Basics', 'accounting-basics', 'Invoices, quotes, customers, stock, money in and out, GST and profit &amp; loss.'],
    ['plus', 'Accounting Plus', 'accounting', 'Everything in Basics, plus bank reconciliation, statement import, payroll, BAS, journals, jobs and budgets. You pay for Plus <b>instead of</b> Basics, never both.'],
    ['pos', 'POS', 'pos', 'The till for shops, cafes and restaurants. Every sale goes into your books.'],
    ['bookings', 'Bookings', 'bookings', 'Jobs, appointments and table bookings on one calendar.'],
    ['payroll', 'Payroll', 'payroll', 'Time clock, timesheets, pay runs, payslips and leave.'],
    ['calls', 'Riyeser Link Plus', 'link', `Calls between your people and branches, office desk phones with Riyeser Link Office, and ${STORAGE_GB.plus} GB of space for files shared in chat (not hosting).`],
    ...(ASBUILT ? [['as_built', 'As Built', 'services', 'Services on your drawings, for the building industry. Doesn\'t need Accounting.']] : []),
  ];
  const FREE = [['central', 'Riyeser Central', 'Your home screen, and it installs and updates the rest'], ['invoices', 'Riyeser Invoices', 'Quotes, invoices and getting paid'],
    ['link', 'Riyeser Link', `Chat for your team, with ${STORAGE_GB.free} GB of file storage per business`], ['pdf', 'Riyeser PDF', 'Fill, sign, combine and edit PDFs'],
    ['desk-assistant', 'Desk Assistant', 'Sort and find every file']];
  const half = (n) => usd(n / 2);
  page({
    path: 'pricing.html', title: 'Riyeser pricing — free tools, and one price per program per business', active: 'pricing',
    description: `All prices in US dollars, per business per month, with 3 users included in each program. Riyeser Central, Invoices, Link chat, PDF and Desk Assistant are free forever. Accounting Basics is ${usd(P.basic)}, Accounting Plus ${usd(P.plus)}, Payroll ${usd(P.payroll)}, POS ${usd(P.pos)}, Bookings ${usd(P.bookings)} and Riyeser Link Plus ${usd(P.calls)}. Every paid program is free for 90 days, no card.`,
    body: (up) => `
${bandHero({ title: 'Pricing', lead: `Start free. Each paid program has its own price per business per month, shown next to it below, with ${P.users_included} users included.` })}
<section class="c" style="padding-bottom:10px">
  <p class="usdnote" id="usd"><b>All prices in US dollars (US$)</b>, per business, per month. Any GST or local tax is shown before you pay.</p>
  ${EARLY_BIRD ? `<div class="earlybox" id="early"><div class="big">🐣</div><div><b>Early bird: 50% off for your first 12 months</b><p>For the first 100 businesses to buy. Half price on each program and its extra users for 12 months (extra companies in Accounting stay full price) — for example Accounting Basics is ${half(P.basic)} a month instead of $${P.basic} — then the normal price. The offer ends when 100 businesses have it.</p></div></div>` : ''}

  <h2 class="h2" style="margin-top:8px">Price list</h2>
  <div class="ptable-wrap"><table class="ptable">
    <thead><tr><th>Program</th><th>Price per business</th></tr></thead>
    <tbody class="gh">
      <tr class="grp"><th colspan="2">${esc(FREE_HEAD)} <span class="swipe" aria-hidden="true">Swipe for more →</span></th></tr></tbody>
    <tbody class="gcards">
      ${FREE.map(([id, n]) => `<tr data-free="${id}"><td><span class="pn">${appImg(id, up, 'ti')}<span><b>${n}</b>${id === 'link' ? ` ${plusPill(prog('link'), up, true)}` : ''}${freeInfo(id, up)}${inclDetails(id, n)}</span></span></td><td class="pr"><b>Free forever</b><small>No user charges</small></td></tr>`).join('')}
    </tbody><tbody class="gh">
      <tr class="grp"><th colspan="2">${esc(PAID_HEAD)} <span class="gnote">${esc(USERS_NOTE)}</span> <span class="swipe" aria-hidden="true">Swipe for more →</span></th></tr></tbody>
    <tbody class="gcards">
      ${ROWS.map(([m, n, id, d]) => `<tr${m === 'calls' ? ' id="link-plus"' : ''} data-row="${m}"><td><span class="pn">${appImg(id, up, 'ti')}<span><b>${n}</b><small>${d}</small>${inclDetails(m === 'calls' ? 'link-plus' : id, n)}</span></span></td><td class="pr"><b>${usd(P[m])}</b> a month<small>${P.users_included} users included<br>+${usd(P.extra_user)} a month per extra user</small>${buyBtns(m, 'row')}</td></tr>`).join('')}
    </tbody></table></div>
  <details class="phfold addfold" open><summary>Good to know: extra people, companies and paying yearly</summary>
  <div class="addon"><div class="big">➕</div><div><b>Good to know</b><p>Each paid program includes ${P.users_included} users. Each extra person is <b>$${P.extra_user} a month for each paid program</b> they use. Another company, trust or client's books in Accounting: <b>$${P.extra_company} a month</b> each. Pay yearly: pay for 10 months and get 12. Riyeser Link chat: space for files shared in chat, ${STORAGE_GB.free} GB of file storage per business free; ${STORAGE_GB.plus} GB with Link Plus. Every paid program is free for 90 days, no card.</p></div></div>
  </details>
</section>

<section class="c" id="calc">
  <details class="phfold" open><summary>Work out your price (calculator)</summary>
  <div class="calc">
    <div><h2>Work out your price</h2><p class="muted">Tick the programs and enter how many people will use them.</p>
      <div class="mods">${ROWS.map(([m, n]) => `<label class="check"><input type="checkbox" data-m="${m}"${m === 'basic' ? ' checked' : ''}> ${n} <small class="muted">$${P[m]}</small></label>`).join('')}</div>
      <p class="muted small" id="plusnote" hidden>Accounting Plus includes everything in Basics, so Basics isn't charged as well.</p>
      <p class="muted" style="margin:14px 0 4px">People using Riyeser</p>
      <div class="users"><button type="button" data-d="-1" aria-label="Fewer people">−</button><input id="users" type="number" min="1" max="500" value="3" aria-label="Number of people"><button type="button" data-d="1" aria-label="More people">+</button></div>
      <p class="muted small" id="usersmax" hidden>More than 500 people? <a class="more" href="/link/?contact">Contact us</a> for a price.</p>
      <p class="muted" style="margin:10px 0 4px">Companies in Accounting</p>
      <div class="users"><button type="button" data-c="-1" aria-label="Fewer companies">−</button><input id="cos" type="number" min="1" max="200" value="1" aria-label="Number of companies"><button type="button" data-c="1" aria-label="More companies">+</button></div>
      <label class="yr" style="margin-top:12px"><input id="yearly" type="checkbox"> Pay yearly (10 months for 12)</label></div>
    <div class="out"><ul class="brk" id="per"></ul><div class="total" id="total"></div><div class="muted" id="note"></div>${EARLY_BIRD ? '<div class="ebline" id="eb"></div>' : ''}
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
  <details open><summary>Is it per person?</summary><p>No — per business. Each paid program is one price for the whole business, with ${P.users_included} users included. After that, each extra person is $${P.extra_user} a month for each paid program. For example, 5 people using Accounting Plus and Payroll is ($${P.plus} + 2 × $${P.extra_user}) + ($${P.payroll} + 2 × $${P.extra_user}) = <b>${usd(P.plus + P.payroll + 4 * P.extra_user)} a month</b>. The free programs have no user charges.</p></details>
  <details><summary>Why US dollars?</summary><p>Riyeser is used by businesses in more than one country, so one price in one currency keeps it simple and fair for everyone. Your bank or card changes it into your own currency when you pay. Any GST or local tax is shown before you pay.</p></details>
  <details><summary>Basics or Plus?</summary><p>Start with Accounting Basics (${usd(P.basic)} a month) if you need invoices, stock and simple money in and out. Choose Accounting Plus (${usd(P.plus)} a month) for bank reconciliation, payroll in your books, BAS, journals, jobs and budgets. Plus includes everything in Basics, so you only ever pay for one: moving up is $${P.plus - P.basic} a month more, and your books carry straight over.</p></details>
  <details><summary>Are the free programs really free?</summary><p>Yes. Riyeser Central, Riyeser Invoices, Riyeser Link chat, Riyeser PDF and Desk Assistant are free forever, with no card and no time limit. The only limit is Riyeser Link's ${STORAGE_GB.free} GB of file storage per business (up to 25 MB a file). The paid programs are optional: add them only if you need them.</p></details>
  <details><summary>What's free?</summary><p>Riyeser Central, Riyeser Invoices, Riyeser Link chat (with ${STORAGE_GB.free} GB of file storage per business), Riyeser PDF and the Desk Assistant file organiser are free forever — no time limit and no card.</p></details>
  <details><summary>How does the free trial work?</summary><p>Every paid program — Accounting Basics, Accounting Plus, POS, Bookings, Payroll and Riyeser Link Plus${ASBUILT ? ', and As Built for the building industry' : ''} — is free for 90 days. No card. The programs show how many days are left, and when the trial ends nothing is deleted: you keep every record and can still look and print; only adding new work waits for a licence.</p></details>
  <details><summary>What happens when the free part runs out?</summary><p>Nothing is deleted and nothing is charged. Everything you made stays on your computer and can still be opened, and quotes, payments and reports keep working. Only new invoices (Basics), new till sales (POS) or that program's screens (the others) wait until you buy it. They unlock straight away.</p></details>
  <details><summary>How much file storage do I get in Riyeser Link?</summary><p>${STORAGE_GB.free} GB of chat files per business on free chat, and ${STORAGE_GB.plus} GB with Riyeser Link Plus. Owners and admins can see how much is used in Billing &amp; Subscription. This is only space for the files people send in Link chats (photos, PDFs, documents). It is not website hosting, email hosting, cloud backup or a cloud phone system, and no plan includes those. Nothing is ever deleted for you: when you're full, new uploads wait until you upgrade to Link Plus or contact Riyeser support.</p></details>
  <details><summary>Is hosting included?</summary><p>No. Riyeser programs run on your own PCs, and your company files stay with you. The file space in Riyeser Link is only for files shared in chat. Website hosting, email hosting and hosted (cloud) phone systems are not part of any plan. If Riyeser offers them later, they will be separate services with their own prices.</p></details>
  <details><summary>How do extra companies work?</summary><p>Your plan includes one company in Riyeser Accounting. Groups, trusts and bookkeepers can add more for $${P.extra_company} a month per extra company, with one sign-in. If you stop paying for one, its books stay — they open read-only until you add it back.</p></details>
  <details><summary>How does paying yearly work?</summary><p>Pay for 10 months and get 12: the yearly price is 10 times the monthly price.</p></details>
  ${EARLY_BIRD ? `<details><summary>How does the early bird offer work?</summary><p>The first 100 businesses to buy pay half price for their first 12 months, on each program and its extra users (not on extra companies) — for example ${half(P.basic)} instead of $${P.basic} a month for Accounting Basics. After 12 months the normal price applies. Once 100 businesses have it, the offer ends; we won't extend it or run a fake countdown.</p></details>` : ''}
  <details><summary>Can I cancel?</summary><p>Yes, any time. You keep everything you made, and can always open and export it.</p></details>
  <details><summary>How do I buy?</summary><p>Press <b>Buy now</b> next to a program (or <b>Buy this plan</b> in the price calculator). Create your free Riyeser account, or sign in, and choose how many people and monthly or yearly. Then pay with <b>PayPal</b> (a card or your PayPal balance; it renews by itself until you cancel) or by <b>bank transfer</b> (we give you an invoice with the bank details and a reference; the program switches on when the money arrives). Your free days aren't lost: paid time starts when your 90-day trial ends. Questions? Email <a class="more" href="mailto:${EMAIL}?subject=${encodeURIComponent('Buying Riyeser')}">${EMAIL}</a>.</p></details>
  </details>
</section>
<script>/* S2: on a phone the long parts start folded (a link to one of them opens it) */
if(matchMedia('(max-width: 640px)').matches)document.querySelectorAll('details.phfold').forEach(function(d){var keep=false;try{keep=!!location.hash&&(!!d.querySelector(location.hash)||d.parentNode.matches(location.hash))}catch(e){}if(!keep)d.open=false});</script>
${ctaBlock(up, 'Start free today', 'Install Riyeser Central — the free tools are yours to keep, and every paid program is free to start.')}
<script>(function(){var EB=${EARLY_BIRD ? 'true' : 'false'},P=${JSON.stringify(P)},u=document.getElementById('users'),c=document.getElementById('cos'),y=document.getElementById('yearly');
var NAMES=${JSON.stringify(Object.fromEntries(ROWS.map(([m, n]) => [m, n])))};
function money(v){v=Math.round(v*100)/100;return 'US$'+v.toLocaleString('en-AU',{minimumFractionDigits:v%1?2:0,maximumFractionDigits:2})}
function li(t,v){var l=document.createElement('li');var a=document.createElement('span');a.textContent=t;var b=document.createElement('b');b.textContent=v;l.appendChild(a);l.appendChild(b);return l}
function box(m){return document.querySelector('[data-m='+m+']')}
// M1: whole numbers from 1 to the most; the box shows what's charged (a blank box waits until you leave it)
function whole(el,max,soft){var raw=String(el.value).trim(),v=Math.round(Number(raw));if(el===u){if(Number(raw)>max)el.dataset.over=1;else if(Number(raw)<max)delete el.dataset.over;document.getElementById('usersmax').hidden=!el.dataset.over}
  if(raw===''||!isFinite(v)){if(!soft)el.value=1;return 1}v=Math.max(1,Math.min(max,v));if(String(v)!==raw&&(!soft||Number(raw)>max||Number(raw)<1||/[.,e]/i.test(raw)))el.value=v;return v}
function draw(e){
  var basic=box('basic'),plus=box('plus');
  if(e&&e.target===plus&&plus.checked)basic.checked=false;   // Plus includes Basics: one or the other
  if(e&&e.target===basic&&basic.checked)plus.checked=false;
  if(basic.checked&&plus.checked)basic.checked=false;
  document.getElementById('plusnote').hidden=!plus.checked;
  var mods=[].slice.call(document.querySelectorAll('[data-m]')).filter(function(x){return x.checked}).map(function(x){return x.dataset.m});
  var n=whole(u,500,true),k=whole(c,200,true);
  var extra=Math.max(0,n-P.users_included),progs=0,per=document.getElementById('per');per.innerHTML='';
  mods.forEach(function(m){var v=P[m]+extra*P.extra_user;progs+=v;
    per.appendChild(li(NAMES[m]+(extra?' ('+money(P[m])+' + '+extra+' extra user'+(extra>1?'s':'')+' × '+money(P.extra_user)+')':' ('+P.users_included+' users included)'),money(v)))});
  var acc=mods.indexOf('basic')>=0||mods.indexOf('plus')>=0,cos=acc?(k-1)*P.extra_company:0;
  if(cos)per.appendChild(li((k-1)+' extra compan'+(k-1>1?'ies':'y')+' × '+money(P.extra_company),money(cos)));
  var m=progs+cos,t=document.getElementById('total'),note=document.getElementById('note'),eb=document.getElementById('eb');
  var q='/link/?signup&add='+mods.join(',')+(n!==P.users_included?'&users='+n:'')+(y.checked?'&period=yearly':''),cb=document.getElementById('calcbuy');
  cb.hidden=!mods.length;document.getElementById('calcfree').href=q;document.getElementById('calcpay').href=q+'&buy=1';
  if(!mods.length){per.appendChild(li('Free tools only','US$0'));t.textContent='US$0 a month';note.textContent='Central, Invoices, Link chat, PDF and Desk Assistant are free forever.';if(eb)eb.textContent='';return}
  if(y.checked){t.textContent=money(m*10)+' a year';note.textContent=money(m)+' a month × 10: 2 months free.'}
  else{t.textContent=money(m)+' a month';note.textContent='After the 90-day free trial. Per business, not per person.'}
  if(EB&&eb){var e1=progs/2+cos;eb.textContent='🐣 Early bird: '+(y.checked?money(e1*10)+' for your first year':money(e1)+' a month for your first 12 months')+'.'}
}
document.querySelectorAll('[data-d]').forEach(function(x){x.addEventListener('click',function(){u.value=Math.max(1,Math.min(500,whole(u,500)+parseInt(x.dataset.d,10)));draw()})});
document.querySelectorAll('[data-c]').forEach(function(x){x.addEventListener('click',function(){c.value=Math.max(1,Math.min(200,whole(c,200)+parseInt(x.dataset.c,10)));draw()})});
u.addEventListener('change',function(){whole(u,500);draw()});c.addEventListener('change',function(){whole(c,200);draw()});
document.querySelectorAll('[data-m]').forEach(function(x){x.addEventListener('change',draw)});
u.addEventListener('input',function(){draw()});c.addEventListener('input',function(){draw()});y.addEventListener('change',function(){draw()});draw()})()</script>`,
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
  const searchBox = (ph) => `<div class="hsearch-wrap">${SEARCH}<input class="hsearch" id="hq" type="search" placeholder="${ph}" autocomplete="off" aria-label="Search help"><button class="go" type="button" aria-label="Search" onclick="var a=document.querySelector('#hres a');if(a)location.href=a.href;else document.getElementById('hq').focus()">${SEARCH}</button></div>`;
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
    description: `Step-by-step help for every Riyeser program: Central, Accounting Basics, Accounting Plus, Payroll, Desk Assistant${ASBUILT ? ', PDF and As Built' : ' and PDF'}.`,
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

// ---------- old riyeser.com addresses keep working ----------
const redirect = (path, to, label) => { const f = join(OUT, path); mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `<!doctype html><meta charset="utf-8"><title>${label} — Riyeser</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${to}"><p>Moved to <a href="${to}">${label}</a>.</p>`); };
redirect('faq.html', ASBUILT ? `${BASE}programs/services.html#faq` : `${BASE}help.html`, ASBUILT ? 'As Built questions and answers' : 'Riyeser Help Centre');
redirect('support.html', `${BASE}help.html`, 'Riyeser Help Centre');
// Riyeser Team is called Riyeser Link now: its old pages forward to the new ones (keeping any #section).
const redirectKeep = (path, to, label) => { const f = join(OUT, path); mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `<!doctype html><meta charset="utf-8"><title>${label} — Riyeser</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${SITE}/${to.replace(/^(\.\.\/)+/, '')}"><script>location.replace(${JSON.stringify(to)}+location.search+location.hash)</script><p>Moved to <a href="${to}">${label}</a>.</p>`); };
redirectKeep('programs/team.html', '../programs/link.html', 'Riyeser Link');
redirectKeep('help/team.html', '../help/link.html', 'Riyeser Link help');

// ---------- extras ----------
cpSync(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true });
const SUBFOLDER = BASE !== '/';
if (!SUBFOLDER) writeFileSync(join(OUT, 'CNAME'), 'riyeser.com\n');
if (!SUBFOLDER) writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
const urls = ['', 'programs.html', 'downloads.html', 'pricing.html', 'help.html', 'terms.html', ...INDUSTRIES.map((i) => `industries/${i.id}.html`), ...PROGRAMS.map((p) => `programs/${p.id}.html`), ...guidesFor({ EMAIL, SERVICES_APP, up: '' }).map((g) => `help/${g.id}.html`)];
writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}/${u}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(OUT, '404.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — Riyeser</title><link rel="stylesheet" href="${BASE}assets/site.css"><div class="c hero"><h1>That page isn't here</h1><p class="lead">It may have moved.</p><a class="btn p" href="${BASE}">Go to the home page</a></div>`);
console.log('Built', urls.length, 'pages into', OUT);
