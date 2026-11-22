// Builds the Riyser website into website/public (plain HTML, no server needed - GitHub Pages or any host).
//   node website/build.mjs
// Edit the text here; every page shares the same header, footer and download buttons.
import { mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'public');
const SITE = 'https://riyeser.com';
// Installers are attached to the latest GitHub Release under these fixed names, so links never go stale.
const RELEASES = 'https://github.com/raka1987/Riyeser/releases/latest/download';
const EMAIL = 'info@riyeser.com';
// Where the site lives: '/' on riyeser.com, '/Riyeser/' on the temporary github.io address (set by the publish workflow).
const BASE = process.env.SITE_BASE || '/';

const PROGRAMS = [
  { id: 'central', name: 'Riyser Central', short: 'Central', icon: 'R', file: 'RiyserCentral-Setup.exe',
    one: 'The home screen for your business: money owed, today\'s meetings, to-dos and recent files — and every Riyser program one click away.',
    pitch: 'Start your day knowing exactly what needs doing.',
    shot: 'central-light.webp', shot2: 'central-dark.webp',
    features: [
      ['Money at a glance', 'What customers owe you, what\'s overdue, and the bills you need to pay — straight from Riyser Accounting.'],
      ['Today & to-dos', 'Your meetings and to-do list in one place, so nothing slips.'],
      ['Find any file', 'One search box finds invoices, drawings and payslips by name, by the words inside, or by an old name.'],
      ['Recent documents', 'Pick up where you left off with the files you opened last.'],
      ['Only what you have', 'Shows just the programs you use — add more any time.'],
      ['Light or dark', 'A modern look that\'s easy on the eyes, day or night.'],
    ] },
  { id: 'accounting', name: 'Riyser Accounting', short: 'Accounting', icon: '📒', file: 'RiyeserAccounting-Setup.exe',
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
  { id: 'payroll', name: 'Riyser Payroll', short: 'Payroll', icon: '🕒', file: null,
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
    note: 'Payroll is part of the Riyser hub. Get in touch for early access.' },
  { id: 'desk-assistant', name: 'Riyser Desk Assistant', short: 'Desk Assistant', icon: '🗂', file: 'RiyeserDeskAssistant-Setup.exe',
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
  { id: 'pdf', name: 'Riyser PDF', short: 'PDF', icon: '📕', file: 'RiyserPDF-Setup.exe',
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
  { id: 'services', name: 'Riyser Services', short: 'Services', icon: '🏗', file: null,
    one: 'Building services mapped on your drawings, with photos, tests and QA records in one place.',
    pitch: 'Every service, on the drawing, with the proof.',
    features: [
      ['On the drawing', 'Pin services to the exact spot on your plans.'],
      ['Photos', 'Attach site photos to each item as the job goes.'],
      ['Tests & QA', 'Record tests and sign-offs against each service.'],
      ['Handover ready', 'Everything you need for commissioning and handover, together.'],
    ],
    note: 'Riyser Services is online. Get in touch to set up your projects.' },
];
rmSync(OUT, { recursive: true, force: true });
const prog = (id) => PROGRAMS.find((p) => p.id === id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dl = (p) => (p.file ? `${RELEASES}/${p.file}` : `mailto:${EMAIL}?subject=${encodeURIComponent(`Early access: ${p.name}`)}`);
const iconBox = (p, extra = '') => `<div class="icon i-${p.id === 'desk-assistant' ? 'desk' : p.id}" ${extra}>${p.icon}</div>`;

function page({ path, title, description, active, body }) {
  const depth = path.split('/').length - 1;
  const up = depth ? '../'.repeat(depth) : '';
  const nav = [['programs', 'Programs', `${up}#programs`], ['downloads', 'Downloads', `${up}downloads.html`], ['pricing', 'Pricing', `${up}pricing.html`], ['support', 'Support', `${up}support.html`]];
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
</head>
<body>
<header class="nav" id="nav"><div class="c">
  <a class="logo" href="${up}index.html"><img src="${up}assets/logo.png" alt="">Riyser</a>
  <nav class="links">${nav.map(([k, l, h]) => `<a href="${h}"${k === active ? ' class="on"' : ''}>${l}</a>`).join('')}</nav>
  <a class="btn p" href="${up}downloads.html">Free download</a>
  <button class="menu" aria-label="Menu" onclick="document.getElementById('nav').classList.toggle('open')">☰</button>
</div></header>
<main>${body(up)}</main>
<footer><div class="c"><b>Riyser Group</b>
  ${PROGRAMS.map((p) => `<a href="${up}programs/${p.id}.html">${p.short}</a>`).join('')}
  <a href="${up}downloads.html">Downloads</a><a href="${up}support.html">Support</a>
  <span class="r">© ${new Date().getFullYear()} Riyser Group</span></div></footer>
<script>addEventListener('scroll',()=>document.getElementById('nav').classList.toggle('scrolled',scrollY>8),{passive:true})</script>
</body>
</html>
`;
  const file = join(OUT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

const freeLine = 'Free download · no sign-up · no card · works offline';
const ctaBlock = (up, title = 'Try Riyser free', text = 'Download, install in one click, and keep everything on your own computer.') => `
<section class="c"><div class="cta"><h2>${title}</h2><p>${text}</p>
<a class="btn t" href="${dl(prog('central'))}">⬇ Download Riyser Central — free</a>
<p style="font-size:13px;margin:14px 0 0;opacity:.75">${freeLine} · Windows 10 & 11</p></div></section>`;

// ---------- home ----------
page({
  path: 'index.html', title: 'Riyser — your whole business, in one place', active: '',
  description: 'Free Windows programs for small business: accounting, payroll, files, PDFs and building services, with one home screen. No sign-up, works offline.',
  body: (up) => `
<div class="c hero">
  <span class="eyebrow">NEW · Riyser Central 1.1 · free</span>
  <h1>Your whole business, <span class="grad">in one place</span></h1>
  <p class="lead">Accounting, payroll, files, PDFs and building services — simple Windows programs that work together, with one home screen that tells you what needs doing today.</p>
  <div class="ctas"><a class="btn p" href="${dl(prog('central'))}">⬇ Download free for Windows</a><a class="btn s" href="#programs">See the programs</a></div>
  <p style="font-size:13px;color:var(--faint);margin:14px 0 0">${freeLine}</p>
  <div class="shot"><picture><source srcset="${up}assets/central-dark.webp" media="(prefers-color-scheme: dark)"><img src="${up}assets/central-light.webp" alt="Riyser Central home screen showing money owed, today's meetings, to-dos and recent files" width="1600" height="1000"></picture></div>
</div>
<div class="c trust"><span>WORKS OFFLINE</span><span>YOUR DATA STAYS ON YOUR PC</span><span>NO ADMIN RIGHTS NEEDED</span><span>EVERY CHANGE CAN BE UNDONE</span></div>
<section id="programs" class="c">
  <h2 class="h2">Pick the programs you need</h2>
  <p class="sub">Start with one. Add more any time — they all show up in Riyser Central.</p>
  <div class="grid">${PROGRAMS.map((p) => `<a class="card" href="${up}programs/${p.id}.html">${iconBox(p)}<h3>${p.short === 'Central' ? 'Riyser Central' : p.short}</h3><p>${esc(p.one)}</p><span class="more">Learn more →</span></a>`).join('')}</div>
</section>
<div class="c">
  <div class="feat"><div class="t"><div class="k">Accounting</div><h3>Know who owes you — and who you owe</h3><p>Real double-entry books without the jargon. Riyser Central shows what's overdue the moment you sit down.</p>
    <ul class="ticks"><li>Quotes → invoices → payments</li><li>Bank reconciliation & statement import</li><li>GST/BAS summary, P&L and balance sheet</li></ul>
    <p style="margin-top:18px"><a class="btn s" href="${up}programs/accounting.html">More about Accounting</a></p></div>
    <img src="${up}assets/accounting.webp" alt="Riyser Accounting dashboard" loading="lazy" width="1400" height="1050"></div>
  <div class="feat r"><div class="t"><div class="k">Desk Assistant</div><h3>Never lose a file again</h3><p>Everything filed by type and year — invoices, drawings, payroll — and one search that finds it by name, contents or an old name.</p>
    <ul class="ticks"><li>Sort by type, with a preview and Undo</li><li>Finds duplicates, even Word + PDF copies</li><li>Where are my files? — every move recorded</li></ul>
    <p style="margin-top:18px"><a class="btn s" href="${up}programs/desk-assistant.html">More about Desk Assistant</a></p></div>
    <img src="${up}assets/desk-find.webp" alt="Riyser Desk Assistant search with type and year filters" loading="lazy" width="1400" height="1100"></div>
</div>
${ctaBlock(up)}`,
});

// ---------- program pages ----------
for (const p of PROGRAMS) {
  page({
    path: `programs/${p.id}.html`, title: `${p.name} — ${p.pitch}`, active: 'programs',
    description: `${p.name}: ${p.one}`,
    body: (up) => `
<div class="c phead"><div>
  ${iconBox(p)}<div class="k" style="margin-top:14px">${esc(p.name)}</div>
  <h1>${esc(p.pitch)}</h1><p class="lead">${esc(p.one)}</p>
  <div class="ctas" style="justify-content:flex-start">${p.file ? `<a class="btn p" href="${dl(p)}">⬇ Download ${esc(p.short)} — free</a>` : `<a class="btn p" href="${dl(p)}">Get early access</a>`}<a class="btn s" href="${up}downloads.html">All downloads</a></div>
  ${p.file ? `<p style="font-size:13px;color:var(--faint);margin:14px 0 0">${freeLine}</p>` : ''}
</div>
${p.shot ? `<img class="pshot" src="${up}assets/${p.shot}" alt="${esc(p.name)} screenshot" width="1400" height="1000">` : `<div class="placeholder i-${p.id}">${p.icon}</div>`}
</div>
<section class="c"><h2 class="h2">What it does</h2><p class="sub">${esc(p.one)}</p>
  <div class="fgrid">${p.features.map(([h, t]) => `<div class="f"><h4>${esc(h)}</h4><p>${esc(t)}</p></div>`).join('')}</div>
  ${p.shot2 ? `<img class="pshot" style="margin-top:40px" src="${up}assets/${p.shot2}" alt="${esc(p.name)} screenshot" loading="lazy" width="1600" height="1000">` : ''}
  ${p.note ? `<p class="note" style="margin-top:28px">${esc(p.note)}</p>` : ''}
</section>
<section class="c"><h2 class="h2">Works even better together</h2><p class="sub">Every Riyser program shows up in Riyser Central, your home screen for the whole business.</p>
  <div class="grid">${PROGRAMS.filter((o) => o.id !== p.id).slice(0, 3).map((o) => `<a class="card" href="${up}programs/${o.id}.html">${iconBox(o)}<h3>${esc(o.short === 'Central' ? 'Riyser Central' : o.short)}</h3><p>${esc(o.one)}</p><span class="more">Learn more →</span></a>`).join('')}</div>
</section>
${ctaBlock(up, p.file ? `Get ${p.name} free` : 'Start with Riyser Central — free')}`,
  });
}

// ---------- downloads ----------
page({
  path: 'downloads.html', title: 'Download Riyser — free for Windows', active: 'downloads',
  description: 'Download Riyser Central, Accounting, Desk Assistant and PDF free for Windows 10 and 11. No sign-up, no card.',
  body: (up) => `
<div class="c" style="padding-top:56px">
  <h1 style="font-size:clamp(32px,5vw,48px);letter-spacing:-1px">Downloads</h1>
  <p class="lead" style="margin:10px 0 30px;text-align:left">${freeLine}. For Windows 10 and 11. Each installs in one click and updates over the old version — your data is kept.</p>
  ${PROGRAMS.map((p) => `<div class="dl">${iconBox(p)}<div><h3>${esc(p.name)}</h3><p>${esc(p.one)}</p></div>${p.file ? `<a class="btn p" href="${dl(p)}">⬇ Download</a>` : `<a class="btn s" href="${dl(p)}">Early access</a>`}</div>`).join('')}
  <section style="padding:40px 0 0"><h2 style="font-size:24px;margin-bottom:8px">Installing</h2>
    <ol class="steps"><li>Click <b>Download</b> and open the file when it finishes.</li>
    <li>If Windows shows <b>“Windows protected your PC”</b>, click <b>More info → Run anyway</b>. (We're getting our programs signed so this goes away.)</li>
    <li>That's it — it installs for you in a few seconds and adds a desktop icon. No admin rights needed.</li></ol></section>
</div>
${ctaBlock(up, 'New here? Start with Riyser Central', 'It\'s the home screen for everything — and it shows you what else you can add.')}`,
});

// ---------- pricing ----------
page({
  path: 'pricing.html', title: 'Riyser pricing — free during early access', active: 'pricing',
  description: 'Every Riyser program is free to download and use during early access.',
  body: (up) => `
<div class="c hero"><span class="eyebrow">EARLY ACCESS</span><h1>Free while we're in <span class="grad">early access</span></h1>
  <p class="lead">Download any Riyser program and use it free — no sign-up, no card, no time limit during early access. Tell us what you'd like next and help shape it.</p>
  <div class="ctas"><a class="btn p" href="${up}downloads.html">⬇ Download free</a><a class="btn s" href="mailto:${EMAIL}?subject=Riyser%20feedback">Send feedback</a></div></div>
<section class="c faq" style="max-width:820px">
  <details open><summary>Is it really free?</summary><p>Yes. During early access every program is free to download and use. If paid plans come later, you'll hear about it first — and early users will be looked after.</p></details>
  <details><summary>Do I need an account?</summary><p>No. Download, install and go. Your information stays on your own computer.</p></details>
  <details><summary>Does it work without internet?</summary><p>Yes. Everything runs on your PC. You only need internet to download and to get updates.</p></details>
  <details><summary>Can I use it for my whole team?</summary><p>Yes — install it on each computer. Riyser Accounting can also run for several people on your office network.</p></details>
</section>
${ctaBlock(up)}`,
});

// ---------- support ----------
page({
  path: 'support.html', title: 'Riyser support', active: 'support',
  description: 'Help with installing and using Riyser programs.',
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

// ---------- extras ----------
cpSync(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true });
writeFileSync(join(OUT, 'CNAME'), 'riyeser.com\n');
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
const urls = ['', 'downloads.html', 'pricing.html', 'support.html', ...PROGRAMS.map((p) => `programs/${p.id}.html`)];
writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}/${u}</loc></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(OUT, '404.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found — Riyser</title><link rel="stylesheet" href="${BASE}assets/site.css"><div class="c hero"><h1>That page isn't here</h1><p class="lead">It may have moved.</p><a class="btn p" href="${BASE}">Go to the home page</a></div>`);
console.log('Built', urls.length, 'pages into', OUT);
