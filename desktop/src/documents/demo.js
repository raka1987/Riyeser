// Riyeser Documents in demo mode (Riyeser Central › Try the demo): a made-up library for Sample Trading Co, kept in
// the program's demo folder so real documents are never touched. Real PDF and picture files are made, so preview,
// search (text inside the "scans"), filing, moving and the Recycle bin all work like the real thing.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Library } = require('./library');
const access = require('./access');

const DEMO_ME = { id: 'demo:rosa', name: 'Rosa Mendes', email: 'rosa@sampletrading.example' };
const PEOPLE = [
  { id: 'demo:rosa', name: 'Rosa Mendes', groups: ['managers'] },
  { id: 'demo:jamie', name: 'Jamie Lee', groups: ['accounts'] },
  { id: 'demo:ana', name: 'Ana Ruiz', groups: ['payroll'] },
  { id: 'demo:sam', name: 'Sam Patel', groups: [] },
];

/** A tiny PNG (a "photo"): a sky, a wall and a few shapes, so the preview shows something real. */
function photoPng(seed = 1, w = 480, h = 360) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      let r; let g; let b;
      if (y < h * 0.45) { r = 150 + (y % 40); g = 190 + (seed * 7) % 40; b = 230; }
      else { r = 190 - ((x * seed) % 30); g = 170 - (y % 20); b = 140; }
      if (x > w * 0.3 && x < w * 0.6 && y > h * 0.35 && y < h * 0.85) { r = 90 + seed * 20; g = 110; b = 130 - seed * 10; }
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
let CRC;
function crc32(buf) {
  if (!CRC) { CRC = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; } }
  let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return c ^ -1;
}

/** A one-page PDF with a heading and lines of text (real text, so search finds words inside it). */
async function textPdf(title, from, lines) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica); const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText(from, { x: 50, y: 780, size: 16, font: bold, color: rgb(0.06, 0.1, 0.24) });
  page.drawText(title, { x: 50, y: 752, size: 12, font, color: rgb(0.35, 0.4, 0.5) });
  let y = 700;
  for (const l of lines) { page.drawText(l, { x: 50, y, size: 11, font }); y -= 22; page.drawRectangle({ x: 50, y: y + 12, width: 495, height: 0.5, color: rgb(0.85, 0.87, 0.9) }); }
  return Buffer.from(await doc.save());
}

const day = (now, n, hh = 9, mm = 0) => { const d = new Date(now); d.setDate(d.getDate() - n); d.setHours(hh, mm, 0, 0); return d.toISOString(); };

/** The sample documents: [file name, folder ('' = Inbox), source, sourceLabel, daysAgo, hh, mm, kind, lines, extra] */
function samples() {
  return [
    ['Invoice INV-2291.pdf', '', 'printer', 'Office printer', 0, 9, 12, 'pdf', ['TAX INVOICE', 'Pacific Hardware Ltd, Nadi', 'Invoice number: INV-2291', 'Bill to: Sample Trading Co', 'Timber 90x45 H3 x 24', 'Galv nails 75mm x 6 boxes', 'Delivery Nadi', 'Total due: $1,284.50 by 12 Dec 2026'],
      { deptHint: 'Accounts', suggestion: { folder: 'Accounts/Suppliers/Pacific Hardware/2026', because: 'You filed 2 similar documents here', name: '2026-11-26 Pacific Hardware Invoice INV-2291.pdf' }, company: 'Pacific Hardware Ltd', docType: 'Invoices' }],
    ['Fuel receipt.png', '', 'phone', 'Phone · Jamie', 0, 8, 40, 'png', null,
      { suggestion: { folder: 'Accounts/Expense claims/Jamie', because: 'Looks like a receipt', name: null }, docType: 'Receipts', addedBy: 'demo:jamie', addedByName: 'Jamie Lee', text: 'Unleaded 48.3 L Pump 4 Total $94.15' }],
    ['Employment contract - Ana Ruiz.pdf', '', 'email', 'Emailed by HR', 0, 8, 2, 'pdf', ['EMPLOYMENT AGREEMENT', 'Between Sample Trading Co and Ana Ruiz', 'Position: Cafe supervisor', 'Start date: 2 Dec 2026', 'Hours: 38 per week', 'Signed by both parties'],
      { deptHint: 'Payroll & HR', suggestion: { folder: 'Payroll & HR/Staff/Ana Ruiz', because: 'Looks like a staff document', name: null }, docType: 'Staff & HR', private: true }],
    ['Signed job sheet 1047.pdf', '', 'program', 'Riyeser Bookings', 1, 16, 55, 'pdf', ['JOB SHEET 1047', 'Customer: Bayside Cafe', 'Hot water unit replaced', 'Checklist: 6 of 6 done', 'Signed: S. Bayside'],
      { suggestion: { folder: 'Jobs/1047 · Bayside Cafe', because: 'Looks like a job document', name: null }, docType: 'Job sheet' }],
    ['BSP statement October 2026.pdf', 'Accounts/Bank statements/2026', 'printer', 'Office printer', 23, 10, 20, 'pdf', ['BANK SOUTH PACIFIC (BSP)', 'Statement of account: Sample Trading Co', 'Opening balance $18,240.11', 'Closing balance $21,904.65']],
    ['Invoice INV-2214 - Pacific Hardware.pdf', 'Accounts/Suppliers/Pacific Hardware/2026', 'printer', 'Office printer', 29, 14, 5, 'pdf', ['TAX INVOICE', 'Pacific Hardware Ltd', 'Invoice number: INV-2214', 'Total due: $612.00']],
    ['Invoice INV-2188 - Pacific Hardware.pdf', 'Accounts/Suppliers/Pacific Hardware/2026', 'email', 'Email', 43, 9, 31, 'pdf', ['TAX INVOICE', 'Pacific Hardware Ltd', 'Invoice number: INV-2188', 'Total due: $388.20']],
    ['Vodafone bill October.pdf', 'Accounts/Suppliers/Vodafone Fiji/2026', 'email', 'Email', 48, 11, 12, 'pdf', ['Vodafone Fiji', 'Your bill for October 2026', 'Amount due: $129.00']],
    ['VAT return Q3 2026.pdf', 'Accounts/Tax/2026', 'email', 'Email', 37, 15, 44, 'pdf', ['FRCS VAT RETURN', 'Period: July to September 2026', 'VAT payable: $3,412.00']],
    ['Staff handbook 2026.pdf', 'Payroll & HR/Policies', 'upload', 'Upload', 148, 9, 0, 'pdf', ['STAFF HANDBOOK 2026', 'Leave, hours, uniforms and safety', 'Sample Trading Co']],
    ['Job 1042 - before photo.png', 'Jobs/1042 · Harbour Cafe', 'phone', 'Phone', 3, 10, 2, 'png', null, { seed: 2 }],
    ['Job 1042 - after photo.png', 'Jobs/1042 · Harbour Cafe', 'phone', 'Phone', 3, 12, 40, 'png', null, { seed: 4 }],
    ['Quote Q-0318 accepted.pdf', 'Sales/Quotes/2026', 'program', 'Riyeser Bookings', 6, 16, 11, 'pdf', ['QUOTE Q-0318', 'For: Northshore Fitness', 'Accepted on 20 Nov 2026', 'Total: $4,860.00']],
    ['Lease renewal 2027.pdf', 'Admin/Property', 'printer', 'Office printer', 2, 13, 30, 'pdf', ['LEASE RENEWAL', 'Shop 4, Main Street, Nadi', 'Term: 1 Jan 2027 to 31 Dec 2029', 'Signed by the landlord']],
  ];
}

/**
 * Make the demo library at root (once). Returns a Library opened as the demo owner.
 * now: for tests.
 */
async function seedDemo(root, { cacheDir, now = new Date() } = {}) {
  const lib = new Library({ root, cacheDir, me: DEMO_ME, now: () => new Date() });
  if (fs.existsSync(lib.meta('library.json'))) return lib;
  lib.ensureLayout({ folders: ['Accounts/Suppliers', 'Accounts/Bank statements', 'Accounts/Tax', 'Accounts/Expense claims', 'Payroll & HR/Staff', 'Payroll & HR/Policies', 'Sales/Quotes', 'Jobs', 'Admin/Property'] });
  lib.updateAccess((a) => {
    let out = { ...a, owner: DEMO_ME.id };
    for (const p of PEOPLE) out = access.upsertPerson(out, p);
    out = access.setRule(out, DEMO_ME, 'Accounts', access.EVERYONE, 'view');
    out = access.setRule(out, DEMO_ME, 'Accounts', access.groupKey('accounts'), 'edit');
    return out;
  });
  const docs = {};
  const history = [];
  for (const [name, folder, source, label, ago, hh, mm, kind, lines, extra = {}] of samples()) {
    const rel = `${folder || '_Inbox'}/${name}`;
    fs.mkdirSync(path.dirname(lib.abs(rel)), { recursive: true });
    const bytes = kind === 'png' ? photoPng(extra.seed || 1) : await textPdf(name.replace(/\.pdf$/, ''), lines[1] || lines[0], lines);
    fs.writeFileSync(lib.abs(rel), bytes);
    const added = day(now, ago, hh, mm);
    const id = `demo${String(Object.keys(docs).length + 1).padStart(8, '0')}`;
    const by = extra.addedBy || DEMO_ME.id;
    docs[id] = {
      id, name, rel, ext: path.extname(name).toLowerCase(), size: bytes.length * (kind === 'png' ? 3 : 40), type: kind === 'png' ? 'Photos' : (['printer', 'scanner'].includes(source) ? 'Scans' : 'Documents'),
      status: folder ? 'filed' : 'inbox', added, addedBy: by, addedByName: extra.addedByName || (by === DEMO_ME.id ? DEMO_ME.name : by), source, sourceLabel: label,
      deptHint: extra.deptHint || null, private: !!extra.private, text: extra.text || (lines || []).join('\n'), textDone: true,
      suggestion: folder ? undefined : extra.suggestion, company: extra.company || null, docType: extra.docType || null,
      ...(folder ? { filed: added, filedBy: DEMO_ME.id } : {}),
    };
    history.push({ at: added, who: by, whoName: docs[id].addedByName, action: 'added', doc: id, name, detail: `Added from ${label}` });
    if (folder) history.push({ at: day(now, ago, hh, mm + 5), who: DEMO_ME.id, whoName: DEMO_ME.name, action: 'filed', doc: id, name, to: rel, detail: `Filed in ${folder.split('/').join(' › ')}` });
  }
  lib.mutate((d) => {
    d.docs = docs;
    // So "File it" on the Pacific Hardware invoice is a learned suggestion
    const { makeExample } = require('./suggest');
    d.examples = Object.values(docs).filter((x) => x.status === 'filed').map((x) => makeExample(x, x.rel.split('/').slice(0, -1).join('/')));
  });
  history.sort((a, b) => a.at.localeCompare(b.at));
  fs.writeFileSync(lib.meta('history.jsonl'), history.map((h) => JSON.stringify(h)).join('\n') + '\n');
  return lib;
}

module.exports = { seedDemo, DEMO_ME, PEOPLE, photoPng, textPdf };
