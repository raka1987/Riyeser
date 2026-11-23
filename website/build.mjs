// Builds the Riyeser website into website/public (plain HTML, no server needed - GitHub Pages or any host).
//   node website/build.mjs
// Edit the text here; every page shares the same header, footer and download buttons.
import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
// Riyeser Services (the web app). It runs at riyeser.com today; when it moves to app.riyeser.com, change this one line.
const SERVICES_APP = process.env.SERVICES_APP || 'https://riyeser.com';
const SERVICES_MOVED = !/^https:\/\/riyeser\.com\/?$/.test(SERVICES_APP);

const PROGRAMS = [
  { id: 'central', name: 'Riyeser Central', short: 'Central', icon: 'R', file: 'RiyeserCentral-Setup.exe',
    one: 'The home screen for your business: money owed, today\'s meetings, to-dos and recent files — and every Riyeser program one click away.',
    pitch: 'Start your day knowing exactly what needs doing.',
    shot: 'central-light.webp', shot2: 'central-dark.webp',
    features: [
      ['Money at a glance', 'What customers owe you, what\'s overdue, and the bills you need to pay — straight from Riyeser Accounting.'],
      ['Today & to-dos', 'Your meetings and to-do list in one place, so nothing slips.'],
      ['Find any file', 'One search box finds invoices, drawings and payslips by name, by the words inside, or by an old name.'],
      ['Recent documents', 'Pick up where you left off with the files you opened last.'],
      ['Only what you have', 'Shows just the programs you use — add more any time.'],
      ['Light or dark', 'A modern look that\'s easy on the eyes, day or night.'],
    ] },
  { id: 'accounting', name: 'Riyeser Accounting', short: 'Accounting', icon: '📒', file: 'RiyeserAccounting-Setup.exe',
    one: 'Invoices, bills, banking, GST/BAS and reports — real double-entry books without the jargon. Accounting Basics is free; Accounting Plus adds banking, payroll and more.',
    pitch: 'Know who owes you, and who you owe.',
    shot: 'accounting.webp',
    features: [
      ['Quotes → invoices → payments', 'Turn a quote into an order and an invoice, then record payments against several invoices at once.'],
      ['Bills & suppliers', 'Purchase orders, bills and paying bills, with supplier contacts.'],
      ['Banking', 'Spend and receive money, transfers, bank reconciliation and bank statement import.'],
      ['GST / BAS', 'GST tax codes and a BAS summary (G1, 1A, 1B, W1, W2 and more).'],
      ['Reports', 'Profit & Loss, Balance Sheet, aged receivables and payables, job P&L — print or export to Excel.'],
      ['Inventory & payroll', 'Stock with average cost, stocktakes, and pay runs that post straight to the books.'],
    ],
    note: 'Built for Australian small businesses. Have your accountant check your setup before relying on it for tax.' },
  { id: 'payroll', name: 'Riyeser Payroll', short: 'Payroll', icon: '🕒', file: PAYROLL_WIN ? 'RiyeserPayroll-Setup.exe' : null,
    one: 'Time clock, timesheets, pay runs, payslips and leave — and export every payslip as a PDF in one click.',
    pitch: 'Pay day without the paperwork.',
    features: [
      ['Time clock', 'Staff clock on and off; hours flow straight into timesheets.'],
      ['Timesheets', 'Review and approve each week\'s hours before the pay run.'],
      ['Pay runs', 'Weekly, fortnightly or monthly pay runs with tax and super worked out.'],
      ['Payslips', 'Clear payslips for every employee, and export them all as PDFs — one each or all in one.'],
      ['Leave', 'Track leave balances as they build up and as they\'re taken.'],
      ['Bank statement check', 'Reads your bank statement and matches the wage payments that went out.'],
    ],
    note: 'Payroll is part of the Riyeser hub. Get in touch for early access.' },
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
  { id: 'services', name: 'Riyeser Services', short: 'Services', icon: '🏗', file: SERVICES_WIN ? 'RiyeserServices-Setup.exe' : null, link: `${SERVICES_APP}/?demo`, linkLabel: 'Try the demo',
    one: 'Map every cable, pipe and duct on your drawings as it goes in — with inspections, test results and photos — and the as-builts are done at handover.',
    pitch: 'Map every service while the building goes up.', custom: true },
];
rmSync(OUT, { recursive: true, force: true });
const prog = (id) => PROGRAMS.find((p) => p.id === id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dl = (p) => (p.file ? `${RELEASES}/${p.file}` : p.link ? p.link : `mailto:${EMAIL}?subject=${encodeURIComponent(`Early access: ${p.name}`)}`);
const iconBox = (p, extra = '') => `<div class="icon i-${p.id === 'desk-assistant' ? 'desk' : p.id}" ${extra}>${p.icon}</div>`;

/** assets/x.webp -> assets/x.webp?v=<content hash>, so browsers fetch new pictures and styles as soon as they change. */
const versionOf = {};
function withVersions(html) {
  return html.replace(/(assets\/[\w.-]+\.(?:webp|png|css))(?=["'\s)])/g, (m, a) => {
    if (!(a in versionOf)) { try { versionOf[a] = createHash('sha1').update(readFileSync(join(ROOT, a))).digest('hex').slice(0, 8); } catch { versionOf[a] = ''; } }
    return versionOf[a] ? `${a}?v=${versionOf[a]}` : a;
  });
}

function page({ path, title, description, active, body }) {
  const depth = path.split('/').length - 1;
  const up = depth ? '../'.repeat(depth) : '';
  const nav = [['programs', 'Programs', `${up}#programs`], ['downloads', 'Downloads', `${up}downloads.html`], ['pricing', 'Pricing', `${up}pricing.html`], ['help', 'Help', `${up}help.html`]];
  if (SERVICES_MOVED) nav.push(['signin', 'Services sign in', `${SERVICES_APP}/?signin`]);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/assets/central-light.webp"><meta property="og:url" content="${SITE}/${path === 'index.html' ? '' : path}">
<link rel="canonical" href="${SITE}/${path === 'index.html' ? '' : path}">
<link rel="icon" href="${up}assets/favicon.png">
<link rel="stylesheet" href="${up}assets/site.css">
${path === 'index.html' && SERVICES_MOVED ? `<script>/* Riyeser Services now lives at ${SERVICES_APP}/ - forward its old links: demo and sign-in links,
   project and QR links (#/p/...), sign-in emails (#access_token, ?code=) and the installed app (start screen icon). */
(function(){var s=location.search,h=location.hash,app=false;try{app=matchMedia('(display-mode: standalone)').matches}catch(e){}
if(/[?&](demo|signin|code|error|token_hash|type)\\b/.test(s)||/^#(\\/|access_token|error|type=|refresh_token)/.test(h)||/[&#](access_token|type=recovery)/.test(h)||app)
location.replace(${JSON.stringify(SERVICES_APP)}+'/'+s+h)})()</script>` : ''}
</head>
<body>
<header class="nav" id="nav"><div class="c">
  <a class="logo" href="${up}index.html"><img src="${up}assets/logo.png" alt="">Riyeser</a>
  <nav class="links">${nav.map(([k, l, h]) => `<a href="${h}"${k === active ? ' class="on"' : ''}>${l}</a>`).join('')}</nav>
  <a class="btn p" href="${up}downloads.html">Free download</a>
  <button class="menu" aria-label="Menu" onclick="document.getElementById('nav').classList.toggle('open')">☰</button>
</div></header>
<main>${body(up)}</main>
<footer><div class="c"><b>Riyeser Group</b>
  ${PROGRAMS.map((p) => `<a href="${up}programs/${p.id}.html">${p.short}</a>`).join('')}
  <a href="${up}downloads.html">Downloads</a><a href="${up}help.html">Help</a><a href="${up}terms.html">Terms</a>
  <span class="r">© ${new Date().getFullYear()} Riyeser Group</span></div></footer>
<script>addEventListener('scroll',()=>document.getElementById('nav').classList.toggle('scrolled',scrollY>8),{passive:true})</script>
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
  { name: 'Accounting Basics', price: 'Free', small: 'no licence needed', tag: 'Free forever',
    blurb: 'Everything a small shop or sole trader needs to invoice and keep stock.',
    has: ['Quotes, invoices and receiving payments', 'Customers, suppliers and bills', 'Stock items, stocktake and reorder alerts',
      'Simple money in and money out', 'Shop counter (POS)', 'Profit & Loss, GST summary, who owes you, sales and stock reports'] },
  { name: 'Accounting Plus', price: 'Licence', small: 'included in your Riyeser licence', tag: 'Free for 90 days',
    blurb: 'Everything in Basics, plus the tools for full books.',
    has: ['Everything in Accounting Basics', 'Bank reconciliation and bank statement import', 'Payroll and pay runs',
      'General journal and search transactions', 'Jobs and budgets', 'Balance Sheet, Trial Balance and every report'] },
];
const editionsBlock = (up, { download = true } = {}) => `
<div class="plans eds">${EDITIONS.map((e, i) => `<div class="plan${i ? ' best' : ''}"><span class="tag">${esc(e.tag)}</span><div class="k">${esc(e.name)}</div>
  <div class="price">${esc(e.price)}<small> ${esc(e.small)}</small></div><p>${esc(e.blurb)}</p>
  <ul class="edlist">${e.has.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>`).join('')}</div>
<p class="sub" style="margin-top:16px">One download for both. Pick Basics or Plus for each company when you set it up, and switch any time; your data never changes. If your free trial ends without a licence, your books open in Basics and nothing is lost.</p>
${download ? `<div class="ctas" style="justify-content:flex-start;margin-top:6px"><a class="btn p" href="${RELEASES}/RiyeserAccounting-Setup.exe">⬇ Download Riyeser Accounting — free</a></div>` : ''}`;
const ctaBlock = (up, title = 'Try Riyeser free', text = 'Download, install in one click, and keep everything on your own computer.') => `
<section class="c"><div class="cta"><h2>${title}</h2><p>${text}</p>
<a class="btn t" href="${dl(prog('central'))}">⬇ Download Riyeser Central — free</a>
<p style="font-size:13px;margin:14px 0 0;opacity:.75">${freeLine} · Windows 10 & 11</p></div></section>`;

// ---------- home ----------
page({
  path: 'index.html', title: 'Riyeser — bookkeeping, payroll and job records for small business', active: '',
  description: 'Free Windows programs for bookkeepers, small business offices and building services teams: accounting, payroll, file finding, PDFs and job records. No sign-up, works offline.',
  body: (up) => `
<div class="hero2"><div class="c hero">
  <span class="eyebrow">90 days free · no card · Windows 10 &amp; 11</span>
  <h1>Books, pay runs and job records — <span class="grad">sorted</span>.</h1>
  <p class="lead">Simple Windows programs for bookkeepers, small business offices and building services teams. Everything stays on your PC, works without internet, and there's nothing to sign up for.</p>
  <div class="ctas"><a class="btn p big" href="${dl(prog('central'))}">⬇ Download free for Windows</a><a class="btn s big" href="#who">Who it's for</a></div>
  <p style="font-size:13px;color:var(--faint);margin:14px 0 0">${freeLine}</p>
  ${EARLY_BIRD ? `<a class="early" href="${up}pricing.html#early">🐣 <b>Early bird:</b> 50% off your first year for the first 100 users <span>See pricing →</span></a>` : ''}
  <div class="shot"><picture><source srcset="${up}assets/central-dark.webp" media="(prefers-color-scheme: dark)"><img src="${up}assets/central-light.webp" alt="Riyeser Central home screen showing money owed, today's meetings, to-dos and recent files" width="1600" height="1000"></picture></div>
</div></div>
<div class="c pills"><span>📴 Works offline</span><span>🔒 Your data stays on your PC</span><span>🧑‍💼 No admin rights needed</span><span>↩️ Every change can be undone</span><span>💳 No card, no sign-up</span></div>

<section id="who" class="c">
  <h2 class="h2">Built for the way you work</h2>
  <p class="sub">Pick what sounds like you. Install only what you need — they all share one home screen.</p>
  <div class="tabs" role="tablist">
    <button class="tab on" role="tab" aria-selected="true" data-tab="books">📒 Bookkeepers &amp; accountants</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="trades">🏗 Building services &amp; trades</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="office">🗂 Small business office</button>
  </div>
  <div class="panel on" data-panel="books"><div class="t">
      <h3>Keep the books without the jargon</h3>
      <p>Double-entry accounting that reads like plain English — and a home screen that shows who's overdue the moment you sit down.</p>
      <ul class="ticks"><li>Quotes → invoices → payments, bills and purchase orders</li><li>Bank statement import and reconciliation</li><li>GST/BAS summary, profit &amp; loss and balance sheet — print or export to CSV</li><li>Pay runs and payslips with Riyeser Payroll</li></ul>
      <p class="uses">Uses: <a href="${up}programs/accounting.html">Accounting</a> · <a href="${up}programs/payroll.html">Payroll</a> · <a href="${up}programs/central.html">Central</a></p></div>
    <img src="${up}assets/accounting.webp" alt="Riyeser Accounting dashboard with income, expenses, bank accounts and money owed" loading="lazy" width="1400" height="900"></div>
  <div class="panel" data-panel="trades" hidden><div class="t">
      <h3>Every service on the drawing, as it goes in</h3>
      <p>Map cables, pipes and ducts on your PDF drawings with photos, inspections and test results on each item. The as-builts are done at handover.</p>
      <ul class="ticks"><li>Works on site with no signal — on this PC or with an online account</li><li>Trace any run from end to end</li><li>Defects, RFIs and hold points in one register</li><li>Share a read-only link with your client</li></ul>
      <p class="uses">Uses: <a href="${up}programs/services.html">Services</a> · <a href="${up}programs/pdf.html">PDF</a> · <a href="${up}programs/desk-assistant.html">Desk Assistant</a></p></div>
    <img src="${up}assets/services-trace.webp" alt="Riyeser Services tracing a water main between two points on a floor plan" loading="lazy" width="1500" height="783"></div>
  <div class="panel" data-panel="office" hidden><div class="t">
      <h3>Find any file in seconds</h3>
      <p>Invoices, drawings, payslips and photos filed by type and year — with one search that finds them by name, by the words inside, or by an old name.</p>
      <ul class="ticks"><li>Sort by type with a preview first, and Undo after</li><li>Spots duplicate copies, even a Word file and its PDF</li><li>Fill in, sign and combine PDFs</li><li>Meetings and to-dos on the home screen</li></ul>
      <p class="uses">Uses: <a href="${up}programs/desk-assistant.html">Desk Assistant</a> · <a href="${up}programs/pdf.html">PDF</a> · <a href="${up}programs/central.html">Central</a></p></div>
    <img src="${up}assets/desk-find.webp" alt="Riyeser Desk Assistant search with type and year filters" loading="lazy" width="1150" height="900"></div>
</section>

<section class="band"><div class="c">
  <h2 class="h2">Sound familiar?</h2>
  <p class="sub">The everyday jobs that eat your week — handled.</p>
  <div class="pains">
    <div class="pain"><b>“Who still owes us?”</b><p>Riyeser Central shows money owed and overdue the moment you open it, and who to chase first.</p></div>
    <div class="pain"><b>“Where did I save that?”</b><p>One search across every folder — by name, by the words inside, even by the file's old name.</p></div>
    <div class="pain"><b>“Payslips take all afternoon.”</b><p>Timesheets in, pay run done, payslips saved as PDFs and ready to send.</p></div>
    <div class="pain"><b>“The as-builts are a mess.”</b><p>Record each service on the drawing as it's installed, with photos and tests attached.</p></div>
  </div>
</div></section>

<section id="programs" class="c">
  <h2 class="h2">The programs</h2>
  <p class="sub">Start with one. Add more any time — they all show up in Riyeser Central.</p>
  <div class="grid">${PROGRAMS.map((p) => `<a class="card" href="${up}programs/${p.id}.html">${iconBox(p)}<h3>${p.short === 'Central' ? 'Riyeser Central' : p.short}</h3><p>${esc(p.one)}</p><span class="more">Learn more →</span></a>`).join('')}</div>
</section>

<section class="c">
  <h2 class="h2">Up and running in three minutes</h2>
  <div class="how">
    <div><span class="n">1</span><h3>Download</h3><p>One free file. No account, no card, no admin password.</p></div>
    <div><span class="n">2</span><h3>Install in one click</h3><p>It sets itself up for your Windows user and opens Riyeser Central.</p></div>
    <div><span class="n">3</span><h3>Add what you need</h3><p>Accounting, Payroll, Services and more appear on the home screen as you install them, and Central tells you when updates are ready.</p></div>
  </div>
</section>

<section class="c">
  <div class="safe">
    <div><div class="k">Your business, your computer</div><h2>Safe by design</h2>
      <p>Your books, staff records and files stay on your own PC — not on someone else's server. Nothing is ever deleted without asking, and almost everything can be undone.</p></div>
    <ul class="ticks"><li>Works with no internet — on site, in the car, anywhere</li><li>Forgot your password? Reset it on the PC without losing anything</li><li>Payroll keeps a backup every day</li><li>Desk Assistant records every file it moves, with “Put everything back”</li><li>Want online access too? Riyeser Services can sync to an online account when you choose</li></ul>
  </div>
</section>

<section class="c faq" style="max-width:860px">
  <h2 class="h2">Questions</h2>
  <details><summary>What does it cost?</summary><p>Every program is free for 90 days with no card. After that it's $20 per user a month for the whole suite, less for teams of 5 or more, and 2 months free if you pay yearly. Nothing is deleted when the trial ends, and Accounting Basics stays free. See <a class="more" href="${up}pricing.html">Pricing</a>.</p></details>
  <details><summary>Does it need the internet?</summary><p>No. Everything works offline. Riyeser Services can optionally sync to an online account so phones, clients and staff can see your projects.</p></details>
  <details><summary>Will it work on a Mac?</summary><p>Not yet — the programs are for Windows 10 and 11. Riyeser Services also works in any web browser at riyeser.com/app.</p></details>
  <details><summary>What if I get stuck?</summary><p>The <a class="more" href="${up}help.html">Help Centre</a> has step-by-step answers for every program, or email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a> and a real person will reply.</p></details>
</section>
${ctaBlock(up, 'Get started free today', 'Download Riyeser Central, add the programs you need, and keep everything on your own computer.')}
<script>document.querySelectorAll('.tab').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('.tab').forEach(function(x){var on=x===b;x.classList.toggle('on',on);x.setAttribute('aria-selected',on)});document.querySelectorAll('.panel').forEach(function(p){var on=p.dataset.panel===b.dataset.tab;p.hidden=!on;p.classList.toggle('on',on)})})})</script>`,
});

// ---------- program pages ----------
for (const p of PROGRAMS.filter((x) => !x.custom)) {
  page({
    path: `programs/${p.id}.html`, title: `${p.name} — ${p.pitch}`, active: 'programs',
    description: `${p.name}: ${p.one}`,
    body: (up) => `
<div class="c phead"><div>
  ${iconBox(p)}<div class="k" style="margin-top:14px">${esc(p.name)}</div>
  <h1>${esc(p.pitch)}</h1><p class="lead">${esc(p.one)}</p>
  <div class="ctas" style="justify-content:flex-start">${p.file ? `<a class="btn p" href="${dl(p)}">⬇ Download ${esc(p.short)} — free</a>` : `<a class="btn p" href="${dl(p)}">${p.link ? esc(p.linkLabel) : 'Get early access'}</a>`}<a class="btn s" href="${up}downloads.html">All downloads</a></div>
  ${p.file ? `<p style="font-size:13px;color:var(--faint);margin:14px 0 0">${freeLine}</p>` : ''}
</div>
${p.shot ? `<img class="pshot" src="${up}assets/${p.shot}" alt="${esc(p.name)} screenshot" width="1400" height="1000">` : `<div class="placeholder i-${p.id}">${p.icon}</div>`}
</div>
${p.id === 'accounting' ? `<section class="c" id="editions"><h2 class="h2">Accounting Basics or Accounting Plus</h2>${editionsBlock(up)}</section>` : ''}
<section class="c"><h2 class="h2">What it does</h2><p class="sub">${esc(p.one)}</p>
  <div class="fgrid">${p.features.map(([h, t]) => `<div class="f"><h4>${esc(h)}</h4><p>${esc(t)}</p></div>`).join('')}</div>
  ${p.shot2 ? `<img class="pshot" style="margin-top:40px" src="${up}assets/${p.shot2}" alt="${esc(p.name)} screenshot" loading="lazy" width="1600" height="1000">` : ''}
  ${p.note ? `<p class="note" style="margin-top:28px">${esc(p.note)}</p>` : ''}
</section>
<section class="c"><h2 class="h2">Works even better together</h2><p class="sub">Every Riyeser program shows up in Riyeser Central, your home screen for the whole business.</p>
  <div class="grid">${PROGRAMS.filter((o) => o.id !== p.id).slice(0, 3).map((o) => `<a class="card" href="${up}programs/${o.id}.html">${iconBox(o)}<h3>${esc(o.short === 'Central' ? 'Riyeser Central' : o.short)}</h3><p>${esc(o.one)}</p><span class="more">Learn more →</span></a>`).join('')}</div>
</section>
${ctaBlock(up, p.file ? `Get ${p.name} free` : 'Start with Riyeser Central — free')}`,
  });
}


// ---------- Riyeser Services (content carried over from the original riyeser.com homepage and FAQ) ----------
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
    ['About Riyeser Services', [
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
      ['Who owns my project information?', 'You do, or your client does, as you\'ve agreed between you. We only store and process it to run Riyeser Services for you. See the terms of use.'],
      ['How do I get it for my team?', `Email ${EMAIL} with your company name and roughly how many people will use it, and we'll set you up.`],
      ['I\'ve forgotten my password', `Ask your admin to reset it, or email ${EMAIL}.`],
      ['How do I get help?', `Tap the ? button in the app for help on the screen you're on, read the help guide, or email ${EMAIL}.`]]],
  ];
  page({
    path: 'programs/services.html', title: 'Riyeser Services — map every service while the building goes up', active: 'programs',
    description: 'Cables, pipes and ducts marked on your drawings as they go in, linked end to end, with inspections, test results and photos. As-builts done at handover.',
    body: (up) => `
<div class="c phead"><div>
  ${iconBox(p)}<div class="k" style="margin-top:14px">Riyeser Services</div>
  <h1>Map every service while the building goes up</h1>
  <p class="lead">Cables, pipes and ducts marked on your drawings as they go in, linked end to end, with the inspections, test results and photos on each item. At handover, the as-builts are already done.</p>
  <div class="ctas" style="justify-content:flex-start"><a class="btn p" href="${SERVICES_APP}/?demo">Try it now, free</a>${SERVICES_WIN ? `<a class="btn s" href="${RELEASES}/RiyeserServices-Setup.exe">⬇ Windows app</a>` : ''}<a class="btn s" href="${SERVICES_APP}/">Sign in to your projects</a></div>
  ${SERVICES_WIN ? '<p style="font-size:13px;color:var(--faint);margin:14px 0 0">Works in any web browser, on phones and tablets — or install the Windows app: it works on your PC with no account and no internet, and can sync to your online account.</p>' : ''}
  <p style="font-size:13px;color:var(--faint);margin:14px 0 0">No sign-up for the demo. Explore a marked-up resort with a guided tour.</p>
</div><img class="pshot" src="${up}assets/services-trace.webp" alt="A water main route highlighted on a floor plan" width="1200" height="900"></div>
<section class="c"><h2 class="h2">How it works</h2><p class="sub">From the first drawing to the handover pack.</p>
  <div class="fgrid steps4">${STEPS.map(([h, t], i) => `<div class="f"><div class="k">Step ${i + 1}</div><h4 style="margin-top:6px">${esc(h)}</h4><p>${esc(t)}</p></div>`).join('')}</div></section>
<section class="c"><h2 class="h2">One drawing for every trade</h2><p class="sub">Each trade gets its own symbols, checklists and reports.</p>
  <div class="fgrid trades">${TRADES.map(([h, t]) => `<div class="f"><h4>${esc(h)}</h4><p>${esc(t)}</p></div>`).join('')}</div></section>
<section class="c"><h2 class="h2">What you hand over</h2><p class="sub">Everything is already in them — no rework at the end of the job.</p>
  <div class="grid two">${HANDOVER.map(([img, h, t, alt]) => `<div class="card"><img src="${up}assets/${img}" alt="${esc(alt)}" loading="lazy" style="border-radius:12px;margin-bottom:14px;border:1px solid var(--line)"><h3>${esc(h)}</h3><p>${esc(t)}</p></div>`).join('')}</div></section>
<section class="c"><div class="feat" style="padding:24px 0"><div class="t"><div class="k">On site</div><h3>Built for the people doing the work</h3>
  <p>Big buttons, works with no signal, and syncs when you're back in range. Phones, tablets and computers — add it to your home screen and it opens like an app.</p>
  <ul class="ticks"><li>Electrical: boards, circuits and test results on record</li><li>IT and comms: racks, fibre and copper, port by port</li><li>Plumbing: pipe routes and pressure tests before the wall closes</li><li>Every trade working from the same drawing</li></ul></div>
  <img src="${up}assets/services-report.webp" alt="Two pages of a power test report" loading="lazy"></div></section>
<section class="c faq" id="faq" style="max-width:900px"><h2 class="h2">Questions and answers</h2>
  ${FAQ.map(([g, qs]) => `<h3 style="margin:28px 0 4px;font-size:18px">${esc(g)}</h3>${qs.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}`).join('')}
  <p class="note" style="margin-top:24px">More help: the <a class="more" href="${SERVICES_APP}/help.html">help guide</a> · <a class="more" href="${up}terms.html">Terms of use</a> · <a class="more" href="mailto:${EMAIL}">${EMAIL}</a></p></section>
<section class="c"><div class="cta"><h2>See it on a real job</h2><p>Try the demo now, or email us to set Riyeser Services up for your team.</p>
  <a class="btn t" href="${SERVICES_APP}/?demo">Try the demo</a> &nbsp; <a class="btn s" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.4)" href="mailto:${EMAIL}?subject=${encodeURIComponent('Riyeser Services enquiry')}">${EMAIL}</a></div></section>`,
  });
}

// ---------- terms of use (as published on riyeser.com, 8 November 2026) ----------
page({
  path: 'terms.html', title: 'Terms of use — Riyeser', active: '',
  description: 'Terms of use for Riyeser and Riyeser Services.',
  body: () => `<div class="c legal" style="max-width:820px;padding:56px 24px 64px">${TERMS}</div>`,
});

// ---------- downloads ----------
page({
  path: 'downloads.html', title: 'Download Riyeser — free for Windows', active: 'downloads',
  description: 'Download Riyeser Central, Accounting, Desk Assistant and PDF free for Windows 10 and 11. No sign-up, no card.',
  body: (up) => `
<div class="c" style="padding-top:56px">
  <h1 style="font-size:clamp(32px,5vw,48px);letter-spacing:-1px">Downloads</h1>
  <p class="lead" style="margin:10px 0 30px;text-align:left">${freeLine}. For Windows 10 and 11. Each installs in one click and updates over the old version — your data is kept.</p>
  ${PROGRAMS.map((p) => `<div class="dl">${iconBox(p)}<div><h3>${esc(p.name)}</h3><p>${esc(p.one)}</p></div>${p.file ? `<a class="btn p" href="${dl(p)}">⬇ Download</a>` : `<a class="btn s" href="${dl(p)}">${p.link ? esc(p.linkLabel) : 'Early access'}</a>`}</div>${p.id === 'accounting' ? `<div class="dl-eds"><h3 style="margin:0 0 12px">Riyeser Accounting comes in two editions</h3>${editionsBlock(up, { download: false })}</div>` : ''}`).join('')}
  <section style="padding:40px 0 0"><h2 style="font-size:24px;margin-bottom:8px">Installing</h2>
    <ol class="steps"><li>Click <b>Download</b> and open the file when it finishes.</li>
    <li>If Windows shows <b>“Windows protected your PC”</b>, click <b>More info → Run anyway</b>. (We're getting our programs signed so this goes away.)</li>
    <li>That's it — it installs for you in a few seconds and adds a desktop icon. No admin rights needed.</li></ol></section>
</div>
${ctaBlock(up, 'New here? Start with Riyeser Central', 'It\'s the home screen for everything — and it shows you what else you can add.')}`,
});

// ---------- pricing ----------
page({
  path: 'pricing.html', title: 'Riyeser pricing — 90 days free, then $20 a month per user', active: 'pricing',
  description: 'Every Riyeser program free for 90 days with no card. Then $20 a month per user for the whole suite, less for teams.',
  body: (up) => `
<div class="hero2"><div class="c hero"><span class="eyebrow">90 days free · no card · every program</span><h1>Everything, for <span class="grad">$20 a month</span></h1>
  <p class="lead">Accounting, Payroll, Services, Desk Assistant, PDF and Riyeser Central — all included. Try the lot free for 90 days, then it's $20 a month per person.</p>
  <div class="ctas"><a class="btn p big" href="${dl(prog('central'))}">⬇ Start your free trial</a><a class="btn s big" href="#calc">Work out my price</a></div>
  <p style="font-size:13px;color:var(--faint);margin:14px 0 0">No sign-up to start · nothing is charged automatically when the trial ends</p></div></div>

<section class="c">
  ${EARLY_BIRD ? `<div class="earlybox" id="early"><div class="big">🐣</div><div><b>Early bird: 50% off your first year</b><p>For the first 100 users to buy a licence. That's from <b>$6.50</b> per user a month for 12 months, then the normal price below. The offer ends when 100 users have it.</p></div></div>` : ''}
  <div class="plans">
    <div class="plan best"><span class="tag">Most popular</span><div class="k">1–4 users</div><div class="price">$20<small> per user / month</small></div><p>Everything, for sole traders and small teams.</p></div>
    <div class="plan"><div class="k">5–19 users</div><div class="price">$16<small> per user / month</small></div><p>20% off every user once you reach five.</p></div>
    <div class="plan"><div class="k">20+ users</div><div class="price">$13<small> per user / month</small></div><p>35% off every user for larger teams.</p></div>
  </div>
  <div class="addon"><div class="big">🏢</div><div><b>Add-on: extra companies — $10 a month each</b><p>Your plan includes one company in Riyeser Accounting. Run more — another company, a trust, or your clients' books — for $10 a month per extra company. Free to try during your 90 days.</p></div></div>
  <h2 class="h2" style="margin-top:40px" id="accounting">Accounting Basics vs Accounting Plus</h2>
  ${editionsBlock(up)}
  <p class="sub" style="margin-top:22px"><b>Pay yearly and get 2 months free.</b> Prices in Australian dollars; any GST or local tax is shown before you pay.</p>
</section>

<section class="c" id="calc">
  <div class="calc">
    <div><h2>Work out your price</h2><p class="muted">How many people will use Riyeser?</p>
      <div class="users"><button type="button" data-d="-1" aria-label="Fewer users">−</button><input id="users" type="number" min="1" max="500" value="3" aria-label="Number of users"><button type="button" data-d="1" aria-label="More users">+</button></div>
      <label class="yr"><input id="yearly" type="checkbox"> Pay yearly (2 months free)</label></div>
    <div class="out"><div class="muted" id="per"></div><div class="total" id="total"></div><div class="muted" id="note"></div></div>
  </div>
</section>

<section class="c">
  <h2 class="h2">What's included</h2>
  <div class="incl">
    ${PROGRAMS.map((p) => `<div>${iconBox(p)}<b>${esc(p.short === 'Central' ? 'Riyeser Central' : p.short)}</b></div>`).join('')}
  </div>
  <ul class="ticks" style="max-width:720px;margin:26px auto 0"><li>Every program and every update</li><li>Works offline; your information stays on your PC</li><li>Help by email from a real person</li><li>Riyeser Services online account for sharing with phones, clients and staff</li></ul>
</section>

<section class="c faq" style="max-width:860px">
  <h2 class="h2">Questions</h2>
  <details open><summary>How does the free trial work?</summary><p>Install Riyeser Central and every program is free for 90 days. No account and no card. Riyeser Central shows how many days are left.</p></details>
  <details><summary>What happens when the trial ends?</summary><p>Nothing is deleted and nothing is charged. Everything you made stays on your computer and can still be opened. To keep adding new work, get a licence and enter the key in Riyeser Central.</p></details>
  <details><summary>What counts as a user?</summary><p>Each person who uses Riyeser on their own computer. One licence covers every Riyeser program for that person.</p></details>
  <details><summary>Can I change the number of users later?</summary><p>Yes, add or remove users any time. Your price per user follows the table above.</p></details>
  <details><summary>How do extra companies work?</summary><p>Each licence includes one company in Riyeser Accounting. Groups, trusts and bookkeepers can add more for $10 a month per extra company, and switch between them with one sign-in. If you stop paying for an extra company, its books stay — they open read-only until you add it back.</p></details>
  <details><summary>Can I cancel?</summary><p>Yes, any time. You keep everything you made, and can always open and export it.</p></details>
  ${EARLY_BIRD ? `<details><summary>How does the early bird offer work?</summary><p>The first 100 users to buy a licence pay half price for their first 12 months — for example $10 instead of $20 per user a month. After 12 months the normal price applies. Once 100 users have the offer, it ends; we won't extend it or run a fake countdown.</p></details>` : ''}
  <details><summary>How do I buy?</summary><p>Online checkout is opening soon. Until then, email <a class="more" href="mailto:${EMAIL}?subject=${encodeURIComponent('Riyeser licence')}">${EMAIL}</a> with your business name and number of users and we'll send your licence key.</p></details>
</section>
${ctaBlock(up, 'Try everything free for 90 days', 'No card, no sign-up. Install Riyeser Central and add the programs you need.')}
<script>(function(){var EB=${EARLY_BIRD ? 'true' : 'false'},u=document.getElementById('users'),y=document.getElementById('yearly');
function price(n){return n>=20?13:n>=5?16:20}
function money(v){return '$'+v.toLocaleString('en-AU',{minimumFractionDigits:v%1?2:0,maximumFractionDigits:2})}
function draw(){var n=Math.max(1,Math.min(500,parseInt(u.value,10)||1)),p=price(n),m=p*n;
document.getElementById('per').textContent=n+' user'+(n>1?'s':'')+' × '+money(p)+' a month'+(p<20?' ('+(p===16?'20':'35')+'% off)':'');
if(y.checked){document.getElementById('total').textContent=money(m*10)+' a year';document.getElementById('note').textContent='That\\'s '+money(m*10/12)+' a month — 2 months free.'}
else{document.getElementById('total').textContent=money(m)+' a month';document.getElementById('note').textContent='After your 90-day free trial.'}
if(EB){document.getElementById('note').textContent+=' Early bird: '+(y.checked?money(m*10/2)+' for your first year':money(m/2)+' a month for your first year')+'.'}}
document.querySelectorAll('[data-d]').forEach(function(b){b.addEventListener('click',function(){u.value=Math.max(1,(parseInt(u.value,10)||1)+parseInt(b.dataset.d,10));draw()})});
u.addEventListener('input',draw);y.addEventListener('change',draw);draw()})()</script>`,
});

// ---------- support ----------
page({
  path: 'help.html', title: 'Help Centre — Riyeser', active: 'help',
  description: 'Step-by-step help for Riyeser Central, Accounting, Payroll, Services, Desk Assistant and PDF: installing, passwords, finding files, backups and more.',
  body: (up) => {
    const q = (title, html, open = false) => `<details${open ? ' open' : ''}><summary>${title}</summary>${html}</details>`;
    const SECTIONS = [
      { id: 'start', icon: '<div class="icon i-central">⬇</div>', name: 'Installing & updating', items: [
        q('Windows says “Windows protected your PC”', '<p>Click <b>More info</b>, then <b>Run anyway</b>. Windows shows this for new programs until they are digitally signed, which we are arranging. It is safe to continue if you downloaded the file from riyeser.com.</p>', true),
        q('Do I need an administrator password?', '<p>No. Each program installs just for your Windows user, so no admin rights are needed.</p>'),
        q('How do I update?', '<p>Open <b>Riyeser Central</b> — it checks for updates and shows a banner when one is ready. Click <b>Install updates</b>. Or download the newest version from <a class="more" href="' + up + 'downloads.html">Downloads</a> and run it: it installs over the old version and <b>keeps all your information</b>.</p>'),
        q('How do I uninstall a program?', '<p>Windows <b>Settings → Apps → Installed apps</b>, find the program and choose <b>Uninstall</b>. Your documents, books and records are not deleted.</p>'),
        q('Moving to a new computer', '<ol><li>Install the programs on the new computer.</li><li>Copy across your information: Accounting\'s <code>.riyeser</code> folder (in your user folder) and Payroll\'s <code>Documents\\Riyeser\\Payroll</code> folder. Email us if you\'d like a hand.</li></ol>'),
      ] },
      { id: 'central', icon: '<div class="icon i-central">R</div>', name: 'Riyeser Central', items: [
        q('A program I installed isn\'t showing', '<p>Under <b>More Riyeser apps</b>, click <b>Locate…</b> next to its name and pick the program (or its desktop shortcut). Central remembers it from then on.</p>'),
        q('The Money panel is empty', '<p>It reads from Riyeser Accounting. Open Accounting, set up your company and enter an invoice or bill — the totals then appear in Central.</p>'),
        q('My meetings don\'t show under Today', '<p>Open Desk Assistant → <b>Settings → Calendars</b> and connect your calendar.</p>'),
      ] },
      { id: 'accounting', icon: '<div class="icon i-accounting">📒</div>', name: 'Accounting', items: [
        q('I forgot my password', '<ol><li>On the sign-in screen, click <b>Forgot password?</b></li><li>Choose your username and a new password.</li></ol><p>This works in the Accounting program on the computer that holds your company file, so nobody elsewhere can use it. <b>Your books are not changed</b> — only the password. For other staff, an administrator can set a new password under <b>Setup → Users &amp; Roles</b>.</p>', true),
        q('Where are my books kept?', '<p>In one company file on your computer: <code>.riyeser\\company.db</code> in your Windows user folder. Copy that file to a USB stick or cloud drive to keep a backup.</p>'),
        q('Starting with an empty company', '<p>When you first open Accounting it asks for your company name. Leave <b>Load demo data</b> unticked to start completely empty.</p>'),
        q('Run several companies (groups, trusts or clients)', '<ol><li>Click <b>Companies</b> in the menu, then <b>Add company</b>. Each company gets its own books, users and access.</li><li>Switch company from its name at the top of the screen. <b>Companies</b> also shows cash, money owed, bills and profit for every company and in total.</li><li>To give a staff member the same sign-in in other companies, tick them under <b>Same sign-in and access in</b> on <b>Setup → Users &amp; roles</b>. Their access can then differ company by company.</li></ol><p>Already have a company file from another computer or a client? Use <b>Bring in an existing company file</b>. It is copied in; the original isn\'t changed. Archived companies are kept and can be restored any time.</p>'),
        q('Limit what each staff member can see or change', '<ol><li>Sign in as an administrator and open <b>Setup → Users &amp; roles</b>.</li><li>For each person, choose a level for every area — Sales, Purchases, Banking, Stock, Payroll, Accounts &amp; reports and Setup: <b>Hidden</b> (not shown at all), <b>View</b> (look and print), <b>Add &amp; edit</b> (but not delete or void) or <b>Full</b>.</li><li>Or click a quick set — Owner, Bookkeeper, Sales staff, Payroll officer or Read-only — then adjust and <b>Save</b>.</li></ol><p>Hidden areas really are hidden: their menus, figures, reports and wages entries don\'t appear, and their pages are refused. Every change is recorded in the audit trail.</p>'),
        q('Printing or exporting reports', '<p>Every report has <b>Print</b> and <b>Export CSV</b> buttons, so you can send figures to your accountant or open them in Excel.</p>'),
        q('More help inside Accounting', '<p>Click <b>Help</b> at the top of any Accounting screen for a guide to invoices, banking, GST/BAS and reports.</p>'),
      ] },
      { id: 'payroll', icon: '<div class="icon i-payroll">🕒</div>', name: 'Payroll', items: [
        q('Where are payslips saved?', '<p>As PDFs in <code>Documents\\Riyeser\\Payroll\\Payslips</code>. Open that folder from the Payroll menu.</p>'),
        q('Are my payroll records backed up?', '<p>Yes — Payroll saves a backup every day in <code>Documents\\Riyeser\\Payroll\\Backups</code> and keeps the last 30.</p>'),
        q('A payslip PDF looks blank', '<p>Make sure you have the newest version of Payroll, then export the payslip again. If it still looks blank, open it in Riyeser PDF or email us the payslip date (not the file).</p>'),
      ] },
      { id: 'services', icon: '<div class="icon i-services">🏗</div>', name: 'Services', items: [
        q('On this PC or with an online account?', '<p>The Windows app asks the first time you open it. <b>On this PC</b>: no account, projects saved on your computer, works with no internet. <b>With my online account</b>: sign in and projects sync with phones, the website and your team. Change it any time from the <b>Riyeser Services</b> menu → <b>How I work…</b></p>', true),
        q('Moving my PC projects online', '<p>Menu <b>Riyeser Services → Sync to my online account…</b>, then sign in. Your projects and photos upload and the copy on the PC is kept as a backup.</p>'),
        q('I forgot my online password', '<p>On the sign-in screen choose <b>Forgot password</b> and follow the email. Projects saved on your PC are not affected.</p>'),
        q('Working without signal on site', '<p>Keep working — changes are saved on the device and sync when you are back online. The status at the top shows <b>All saved</b> or how many changes are waiting.</p>'),
        q('The full Services guide', '<p>See the <a class="more" href="' + SERVICES_APP + '/help.html">Riyeser Services help guide</a> for drawings, items, runs, inspections and reports.</p>'),
      ] },
      { id: 'desk', icon: '<div class="icon i-desk">🗂</div>', name: 'Desk Assistant', items: [
        q('Desk Assistant moved a file — where is it?', '<p>Open <b>Where are my files?</b>. Every move is listed with an <b>Open</b> button, and <b>Put everything back</b> returns every file to where it was.</p>', true),
        q('Finding a file', '<p>Open <b>Find a file</b> and type part of the name, a word inside it, a company or an old name. Narrow it down by type and year.</p>'),
        q('Undoing a tidy-up', '<p>On the <b>Today</b> page under <b>Recent tidy-ups</b>, click <b>Undo</b>. Nothing is ever deleted — duplicates are moved to an Archive folder, not removed.</p>'),
      ] },
      { id: 'pdf', icon: '<div class="icon i-pdf">📕</div>', name: 'PDF', items: [
        q('A PDF opens blank or grey', '<p>Choose <b>Tools → Basic viewer</b>. It shows any PDF using Windows\' built-in viewer, so you can still read and print it.</p>', true),
        q('Make Riyeser PDF open my PDFs', '<p>Right-click a PDF → <b>Open with → Choose another app</b> → <b>Riyeser PDF</b> → tick <b>Always</b>.</p>'),
      ] },
    ];
    return `
<div class="c" style="padding:56px 24px 0;max-width:900px">
  <h1 style="font-size:clamp(32px,5vw,48px);letter-spacing:-1px">Help Centre</h1>
  <p class="lead" style="margin:10px 0 22px;text-align:left">Step-by-step answers for every Riyeser program. Can't find it? Email <a class="more" href="mailto:${EMAIL}?subject=${encodeURIComponent('Help with Riyeser')}">${EMAIL}</a> — a real person will reply.</p>
  <input class="hsearch" id="hq" type="search" placeholder="Search help — e.g. password, payslip, update, blank PDF" autocomplete="off" aria-label="Search help">
  <div class="hjump">${SECTIONS.map((s) => `<a href="#${s.id}">${s.name}</a>`).join('')}</div>
</div>
<div class="c" style="max-width:900px">
  ${SECTIONS.map((s) => `<div class="hsec" id="${s.id}"><h2>${s.icon}${s.name}</h2><div class="faq">${s.items.join('')}</div></div>`).join('')}
  <p class="hnone" id="hnone">Nothing matches that. Try another word, or email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a>.</p>
  <div class="note" style="margin:36px 0 0"><b>Emailing us?</b> Tell us which program, what you clicked, and what you saw (a screenshot helps). Please don't send passwords, bank details or staff pay information.</div>
</div>
${ctaBlock(up, 'Not installed yet?', 'Download Riyeser Central free and add the programs you need.')}
<script>(function(){var box=document.getElementById('hq');box.addEventListener('input',function(){var t=box.value.trim().toLowerCase(),any=false;
document.querySelectorAll('.hsec').forEach(function(sec){var shown=0;sec.querySelectorAll('details').forEach(function(d){var hit=!t||d.textContent.toLowerCase().indexOf(t)>=0;d.style.display=hit?'':'none';if(t&&hit)d.open=true;if(hit)shown++});sec.style.display=shown?'':'none';if(shown)any=true});
document.getElementById('hnone').style.display=any?'none':'block'})})()</script>`;
  },
});

// ---------- old riyeser.com addresses keep working ----------
const redirect = (path, to, label) => { const f = join(OUT, path); mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `<!doctype html><meta charset="utf-8"><title>${label} — Riyeser</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${to}"><p>Moved to <a href="${to}">${label}</a>.</p>`); };
redirect('faq.html', `${BASE}programs/services.html#faq`, 'Riyeser Services questions and answers');
redirect('support.html', `${BASE}help.html`, 'Riyeser Help Centre');

// ---------- extras ----------
cpSync(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true });
const SUBFOLDER = BASE !== '/';
if (!SUBFOLDER) writeFileSync(join(OUT, 'CNAME'), 'riyeser.com\n');
if (!SUBFOLDER) writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
const urls = ['', 'downloads.html', 'pricing.html', 'help.html', 'terms.html', ...PROGRAMS.map((p) => `programs/${p.id}.html`)];
writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}/${u}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(OUT, '404.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — Riyeser</title><link rel="stylesheet" href="${BASE}assets/site.css"><div class="c hero"><h1>That page isn't here</h1><p class="lead">It may have moved.</p><a class="btn p" href="${BASE}">Go to the home page</a></div>`);
console.log('Built', urls.length, 'pages into', OUT);
