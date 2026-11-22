// Builds the Riyeser website into website/public (plain HTML, no server needed - GitHub Pages or any host).
//   node website/build.mjs
// Edit the text here; every page shares the same header, footer and download buttons.
import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR || join(ROOT, 'public');
const SITE = process.env.SITE_URL || 'https://riyeser.com';
// Installers are attached to the latest GitHub Release under these fixed names, so links never go stale.
const RELEASES = 'https://github.com/raka1987/Riyeser/releases/latest/download';
const EMAIL = 'info@riyeser.com';
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
    one: 'Invoices, bills, banking, GST/BAS and reports — real double-entry books without the jargon.',
    pitch: 'Know who owes you, and who you owe.',
    shot: 'accounting.webp',
    features: [
      ['Quotes → invoices → payments', 'Turn a quote into an order and an invoice, then record payments against several invoices at once.'],
      ['Bills & suppliers', 'Purchase orders, bills and Pay Bills, with a supplier card file.'],
      ['Banking', 'Spend and receive money, transfers, bank reconciliation and bank statement import.'],
      ['GST / BAS', 'GST tax codes and a BAS summary (G1, 1A, 1B, W1, W2 and more).'],
      ['Reports', 'Profit & Loss, Balance Sheet, aged receivables and payables, job P&L — print or export to Excel.'],
      ['Inventory & payroll', 'Stock with average cost, stocktakes, and pay runs that post straight to the books.'],
    ],
    note: 'Built for Australian small businesses. Have your accountant check your setup before relying on it for tax.' },
  { id: 'payroll', name: 'Riyeser Payroll', short: 'Payroll', icon: '🕒', file: null,
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
  { id: 'services', name: 'Riyeser Services', short: 'Services', icon: '🏗', file: null, link: `${SERVICES_APP}/?demo`, linkLabel: 'Try the demo',
    one: 'Map every cable, pipe and duct on your drawings as it goes in — with inspections, test results and photos — and the as-builts are done at handover.',
    pitch: 'Map every service while the building goes up.', custom: true },
];
rmSync(OUT, { recursive: true, force: true });
const prog = (id) => PROGRAMS.find((p) => p.id === id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dl = (p) => (p.file ? `${RELEASES}/${p.file}` : p.link ? p.link : `mailto:${EMAIL}?subject=${encodeURIComponent(`Early access: ${p.name}`)}`);
const iconBox = (p, extra = '') => `<div class="icon i-${p.id === 'desk-assistant' ? 'desk' : p.id}" ${extra}>${p.icon}</div>`;

function page({ path, title, description, active, body }) {
  const depth = path.split('/').length - 1;
  const up = depth ? '../'.repeat(depth) : '';
  const nav = [['programs', 'Programs', `${up}#programs`], ['downloads', 'Downloads', `${up}downloads.html`], ['pricing', 'Pricing', `${up}pricing.html`], ['support', 'Support', `${up}support.html`]];
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
  <a href="${up}downloads.html">Downloads</a><a href="${up}support.html">Support</a><a href="${up}terms.html">Terms</a>
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
  writeFileSync(file, html);
}

const freeLine = 'Free download · no sign-up · no card · works offline';
const ctaBlock = (up, title = 'Try Riyeser free', text = 'Download, install in one click, and keep everything on your own computer.') => `
<section class="c"><div class="cta"><h2>${title}</h2><p>${text}</p>
<a class="btn t" href="${dl(prog('central'))}">⬇ Download Riyeser Central — free</a>
<p style="font-size:13px;margin:14px 0 0;opacity:.75">${freeLine} · Windows 10 & 11</p></div></section>`;

// ---------- home ----------
page({
  path: 'index.html', title: 'Riyeser — your whole business, in one place', active: '',
  description: 'Free Windows programs for small business: accounting, payroll, files, PDFs and building services, with one home screen. No sign-up, works offline.',
  body: (up) => `
<div class="c hero">
  <span class="eyebrow">NEW · Riyeser Central 1.2 · free</span>
  <h1>Your whole business, <span class="grad">in one place</span></h1>
  <p class="lead">Accounting, payroll, files, PDFs and building services — simple Windows programs that work together, with one home screen that tells you what needs doing today.</p>
  <div class="ctas"><a class="btn p" href="${dl(prog('central'))}">⬇ Download free for Windows</a><a class="btn s" href="#programs">See the programs</a></div>
  <p style="font-size:13px;color:var(--faint);margin:14px 0 0">${freeLine}</p>
  <div class="shot"><picture><source srcset="${up}assets/central-dark.webp" media="(prefers-color-scheme: dark)"><img src="${up}assets/central-light.webp" alt="Riyeser Central home screen showing money owed, today's meetings, to-dos and recent files" width="1600" height="1000"></picture></div>
</div>
<div class="c trust"><span>WORKS OFFLINE</span><span>YOUR DATA STAYS ON YOUR PC</span><span>NO ADMIN RIGHTS NEEDED</span><span>EVERY CHANGE CAN BE UNDONE</span></div>
<section id="programs" class="c">
  <h2 class="h2">Pick the programs you need</h2>
  <p class="sub">Start with one. Add more any time — they all show up in Riyeser Central.</p>
  <div class="grid">${PROGRAMS.map((p) => `<a class="card" href="${up}programs/${p.id}.html">${iconBox(p)}<h3>${p.short === 'Central' ? 'Riyeser Central' : p.short}</h3><p>${esc(p.one)}</p><span class="more">Learn more →</span></a>`).join('')}</div>
</section>
<div class="c">
  <div class="feat"><div class="t"><div class="k">Accounting</div><h3>Know who owes you — and who you owe</h3><p>Real double-entry books without the jargon. Riyeser Central shows what's overdue the moment you sit down.</p>
    <ul class="ticks"><li>Quotes → invoices → payments</li><li>Bank reconciliation & statement import</li><li>GST/BAS summary, P&L and balance sheet</li></ul>
    <p style="margin-top:18px"><a class="btn s" href="${up}programs/accounting.html">More about Accounting</a></p></div>
    <img src="${up}assets/accounting.webp" alt="Riyeser Accounting dashboard" loading="lazy" width="1400" height="1050"></div>
  <div class="feat r"><div class="t"><div class="k">Desk Assistant</div><h3>Never lose a file again</h3><p>Everything filed by type and year — invoices, drawings, payroll — and one search that finds it by name, contents or an old name.</p>
    <ul class="ticks"><li>Sort by type, with a preview and Undo</li><li>Finds duplicates, even Word + PDF copies</li><li>Where are my files? — every move recorded</li></ul>
    <p style="margin-top:18px"><a class="btn s" href="${up}programs/desk-assistant.html">More about Desk Assistant</a></p></div>
    <img src="${up}assets/desk-find.webp" alt="Riyeser Desk Assistant search with type and year filters" loading="lazy" width="1400" height="1100"></div>
</div>
${ctaBlock(up)}`,
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
  <div class="ctas" style="justify-content:flex-start"><a class="btn p" href="${SERVICES_APP}/?demo">Try it now, free</a><a class="btn s" href="${SERVICES_APP}/">Sign in to your projects</a></div>
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
  ${PROGRAMS.map((p) => `<div class="dl">${iconBox(p)}<div><h3>${esc(p.name)}</h3><p>${esc(p.one)}</p></div>${p.file ? `<a class="btn p" href="${dl(p)}">⬇ Download</a>` : `<a class="btn s" href="${dl(p)}">${p.link ? esc(p.linkLabel) : 'Early access'}</a>`}</div>`).join('')}
  <section style="padding:40px 0 0"><h2 style="font-size:24px;margin-bottom:8px">Installing</h2>
    <ol class="steps"><li>Click <b>Download</b> and open the file when it finishes.</li>
    <li>If Windows shows <b>“Windows protected your PC”</b>, click <b>More info → Run anyway</b>. (We're getting our programs signed so this goes away.)</li>
    <li>That's it — it installs for you in a few seconds and adds a desktop icon. No admin rights needed.</li></ol></section>
</div>
${ctaBlock(up, 'New here? Start with Riyeser Central', 'It\'s the home screen for everything — and it shows you what else you can add.')}`,
});

// ---------- pricing ----------
page({
  path: 'pricing.html', title: 'Riyeser pricing — free during early access', active: 'pricing',
  description: 'Every Riyeser program is free to download and use during early access.',
  body: (up) => `
<div class="c hero"><span class="eyebrow">EARLY ACCESS</span><h1>Free while we're in <span class="grad">early access</span></h1>
  <p class="lead">Download any Riyeser program and use it free — no sign-up, no card, no time limit during early access. Tell us what you'd like next and help shape it.</p>
  <div class="ctas"><a class="btn p" href="${up}downloads.html">⬇ Download free</a><a class="btn s" href="mailto:${EMAIL}?subject=Riyeser%20feedback">Send feedback</a></div></div>
<section class="c faq" style="max-width:820px">
  <details open><summary>Is it really free?</summary><p>Yes. During early access every program is free to download and use. If paid plans come later, you'll hear about it first — and early users will be looked after.</p></details>
  <details><summary>Do I need an account?</summary><p>No. Download, install and go. Your information stays on your own computer.</p></details>
  <details><summary>Does it work without internet?</summary><p>Yes. Everything runs on your PC. You only need internet to download and to get updates.</p></details>
  <details><summary>Can I use it for my whole team?</summary><p>Yes — install it on each computer. Riyeser Accounting can also run for several people on your office network.</p></details>
</section>
${ctaBlock(up)}`,
});

// ---------- support ----------
page({
  path: 'support.html', title: 'Riyeser support', active: 'support',
  description: 'Help with installing and using Riyeser programs.',
  body: (up) => `
<div class="c" style="padding:56px 24px 0"><h1 style="font-size:clamp(32px,5vw,48px);letter-spacing:-1px">Support</h1>
  <p class="lead" style="margin:10px 0 30px;text-align:left">Questions, ideas or something not working? Email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a> — a real person will reply.</p></div>
<section class="c faq" style="max-width:860px;padding-top:0">
  <details open><summary>Windows says “Windows protected your PC”</summary><p>Click <b>More info → Run anyway</b>. This appears for new programs until they're digitally signed, which we're arranging.</p></details>
  <details><summary>How do I update?</summary><p>Download the latest version from <a class="more" href="${up}downloads.html">Downloads</a> and run it. It replaces the old version and keeps all your data.</p></details>
  <details><summary>Where is my information kept?</summary><p>On your own computer. Accounting keeps its books in <code>.riyeser</code> in your user folder; the other programs keep their settings in your Windows user profile.</p></details>
  <details><summary>Desk Assistant moved a file — where did it go?</summary><p>Open Desk Assistant → <b>Where are my files?</b>. Every move is listed, with an Open button and a <b>Put everything back</b> button.</p></details>
  <details><summary>How do I uninstall?</summary><p>Windows <b>Settings → Apps → Installed apps</b>, find the program, then <b>Uninstall</b>. Your documents are never deleted.</p></details>
</section>
${ctaBlock(up)}`,
});

// ---------- old riyeser.com addresses keep working ----------
const redirect = (path, to, label) => { const f = join(OUT, path); mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `<!doctype html><meta charset="utf-8"><title>${label} — Riyeser</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${to}"><p>Moved to <a href="${to}">${label}</a>.</p>`); };
redirect('faq.html', `${BASE}programs/services.html#faq`, 'Riyeser Services questions and answers');
if (SERVICES_MOVED) redirect('help.html', `${SERVICES_APP}/help.html`, 'Riyeser Services help guide');

// ---------- extras ----------
cpSync(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true });
const SUBFOLDER = BASE !== '/';
if (!SUBFOLDER) writeFileSync(join(OUT, 'CNAME'), 'riyeser.com\n');
if (!SUBFOLDER) writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
const urls = ['', 'downloads.html', 'pricing.html', 'support.html', 'terms.html', ...PROGRAMS.map((p) => `programs/${p.id}.html`)];
writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}/${u}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(OUT, '404.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — Riyeser</title><link rel="stylesheet" href="${BASE}assets/site.css"><div class="c hero"><h1>That page isn't here</h1><p class="lead">It may have moved.</p><a class="btn p" href="${BASE}">Go to the home page</a></div>`);
console.log('Built', urls.length, 'pages into', OUT);
