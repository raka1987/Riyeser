// Works out WHAT a document is (invoice, contract...) and WHO it is for (company name).
// Rule-based so it works offline and for free; an optional AI pass can refine it (see ai.js).

// Document types. `folder` is where that type lives (sub-folders allowed, e.g. Payroll/Timesheets).
// Words found in the file NAME count more than words in the text.
const DOC_TYPES = [
  { type: 'Invoices', words: ['invoice', 'tax invoice', 'amount due', 'invoice number', 'invoice no', 'inv-', 'bill to', 'payment terms', 'due date', 'balance due', 'please pay'] },
  { type: 'Credit Notes', words: ['credit note', 'credit memo', 'adjustment note', 'credit adjustment'] },
  { type: 'Receipts', words: ['receipt', 'payment received', 'paid with', 'thank you for your purchase', 'order confirmation', 'transaction id', 'amount paid'] },
  { type: 'Remittances', words: ['remittance', 'remittance advice', 'payment advice', 'eft payment', 'we have paid', 'payment notification'] },
  { type: 'Quotes', words: ['quote', 'quotation', 'estimate', 'valid until', 'pricing proposal', 'quote number'] },
  { type: 'Purchase Orders', words: ['purchase order', 'po number', 'p.o.', 'order number'] },
  { type: 'Delivery Dockets', words: ['delivery docket', 'packing slip', 'delivery note', 'consignment note', 'proof of delivery', 'goods received'] },
  { type: 'Statements', words: ['statement', 'account summary', 'opening balance', 'closing balance', 'bank statement', 'statement of account'] },
  { type: 'Timesheets', folder: 'Payroll/Timesheets', words: ['timesheet', 'time sheet', 'hours worked', 'total hours', 'week ending', 'start time', 'finish time', 'clock in', 'ordinary hours', 'overtime'] },
  { type: 'Payslips', folder: 'Payroll/Payslips', words: ['payslip', 'pay slip', 'gross pay', 'net pay', 'pay period', 'ytd earnings', 'earnings statement'] },
  { type: 'Payroll', folder: 'Payroll', words: ['payroll', 'paye', 'kiwisaver', 'superannuation', 'pay run', 'wages', 'wage', 'wage sheet', 'wage book', 'employer deductions', 'employment information', 'payday filing'] },
  { type: 'Tax', words: ['tax return', 'gst return', 'vat return', 'ird', 'irs', 'hmrc', 'ato', 'w-2', '1099', 'tax year', 'provisional tax', 'income tax', 'gst'] },
  { type: 'Insurance', words: ['policy number', 'insurance', 'insured', 'premium', 'claim number', 'certificate of currency', 'policy schedule'] },
  { type: 'Contracts', words: ['agreement', 'contract', 'terms and conditions', 'hereby', 'signature', 'the parties', 'nda', 'non-disclosure', 'engagement letter', 'subcontract'] },
  { type: 'Variations', words: ['variation', 'variation order', 'change order', 'site instruction', 'variation request'] },
  { type: 'Proposals', words: ['proposal', 'scope of work', 'statement of work', 'sow', 'tender', 'request for proposal', 'rfp'] },
  { type: 'Plans & Drawings', words: ['drawing', 'drawings', 'dwg', 'floor plan', 'site plan', 'elevation', 'drawing number', 'drawing no', 'scale 1:', 'layout plan', 'as built drawing'] },
  { type: 'Specifications', words: ['specification', 'specifications', 'data sheet', 'datasheet', 'technical data', 'product data', 'submittal'] },
  { type: 'Commissioning', words: ['commissioning', 'commissioning plan', 'pre-commissioning', 'testing and commissioning', 'o&m manual', 'operation and maintenance', 'as-built', 'handover'] },
  { type: 'Certificates', words: ['certificate', 'certificate of compliance', 'coc', 'producer statement', 'ps3', 'ps4', 'code compliance', 'warrant of fitness', 'test certificate', 'compliance schedule'] },
  { type: 'Health & Safety', words: ['health and safety', 'h&s', 'swms', 'jsa', 'job safety analysis', 'risk assessment', 'incident report', 'hazard register', 'toolbox meeting', 'site safety'] },
  { type: 'Meeting Notes', words: ['meeting notes', 'minutes', 'attendees', 'agenda', 'action items', 'next steps', 'apologies'] },
  { type: 'Price Lists', words: ['price list', 'pricelist', 'schedule of rates', 'rate card', 'unit price', 'trade price'] },
  { type: 'Staff & HR', folder: 'Staff & HR', words: ['employment agreement', 'leave application', 'annual leave', 'sick leave', 'job description', 'resume', 'curriculum vitae', 'induction', 'performance review', 'letter of offer'] },
  { type: 'Reports', words: ['report', 'analysis', 'quarterly', 'annual report', 'progress report', 'monthly report'] },
  { type: 'Correspondence', words: ['dear', 'kind regards', 'yours sincerely', 'yours faithfully', 'letter'] },
];

const MEDIA = {
  Images: ['.jpg', '.jpeg', '.png', '.gif', '.heic', '.webp', '.bmp', '.tiff', '.svg', '.raw'],
  Videos: ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'],
  Audio: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'],
  Installers: ['.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.apk'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'],
};

const LEGAL_SUFFIX = '(?:Ltd|Limited|LLC|L\\.L\\.C\\.|Inc|Incorporated|Corp|Corporation|PLC|Pty Ltd|Pty|GmbH|LLP|Co\\.|Company|Group|Holdings|Trust|AG|SA|BV)';
const COMPANY_RE = new RegExp(`\\b((?:[A-Z][A-Za-z0-9&'\\-]*\\.?\\s){0,4}[A-Z][A-Za-z0-9&'\\-]*\\s${LEGAL_SUFFIX})(?![A-Za-z])`, 'g');
const CONTEXT_RE = /(?:bill(?:ed)? to|invoice to|customer|client|sold to|prepared for|from|supplier|vendor)\s*[:\-]?\s*\n?\s*([A-Z][^\n,]{2,60})/gi;
const EMAIL_DOMAIN_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+)\.[A-Za-z.]{2,}/g;
const GENERIC_DOMAINS = new Set(['gmail', 'outlook', 'hotmail', 'yahoo', 'icloud', 'live', 'me', 'protonmail', 'aol', 'xtra', 'googlemail', 'mail', 'msn']);

function norm(s) {
  return (s || '').toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countMatches(haystack, needle) {
  if (!needle) return 0;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}(?=$|[^a-z0-9])`, 'g');
  return (haystack.match(re) || []).length;
}

function cleanCompanyName(name) {
  return name.replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
}

function isOwnCompany(name, ownNames) {
  const n = norm(name);
  return ownNames.some((o) => { const on = norm(o); return on && (n === on || n.includes(on) || on.includes(n)); });
}

// Money documents (quotes, invoices...) always show prices. Without any, a stray word like "quote" in a note isn't enough.
const MONEY_TYPES = new Set(['Invoices', 'Quotes', 'Purchase Orders', 'Price Lists']);
const MONEY_RE = /([$€£]\s?\d)|\b(nzd|aud|usd|gbp|eur)\s?\d|\b\d{1,3}(,\d{3})*\.\d{2}\b|\b(sub ?total|total|gst|vat|amount|excl|incl)\b/i;
// What the title block and notes of a technical drawing look like (architectural, services, structural...).
const DRAWING_CUES = ['drawing title', 'drawing no', 'drawing number', 'dwg no', 'dwg', 'drg', 'drawn', 'drawn by', 'checked', 'checked by', 'approved',
  'designed', 'do not scale', 'scale', 'sheet', 'sheet no', 'revision', 'rev', 'amendment', 'for construction', 'issued for construction',
  'not for construction', 'for tender', 'for consent', 'building consent', 'preliminary', 'project no', 'job no', 'north', 'legend', 'general arrangement',
  'layout', 'schematic', 'single line diagram', 'riser diagram', 'reflected ceiling plan', 'ceiling plan', 'floor plan', 'section', 'detail', 'elevation',
  'mechanical services', 'electrical services', 'hydraulic services', 'fire services', 'plumbing and drainage', 'services layout', 'ductwork', 'cable tray',
  'lighting layout', 'power layout', 'switchboard', 'ground floor', 'first floor', 'level 1', 'level 2', 'a0', 'a1', 'a3', 'nts', 'dimensions in mm'];
// Cues that only appear on drawings (a contract or report can mention "section" or "approved", but not these).
const DRAWING_STRONG = new Set(['drawing title', 'drawing no', 'drawing number', 'dwg no', 'dwg', 'drg', 'drawn by', 'checked by', 'do not scale',
  'for construction', 'issued for construction', 'not for construction', 'for tender', 'for consent', 'sheet no', 'nts', 'dimensions in mm',
  'general arrangement', 'schematic', 'single line diagram', 'riser diagram', 'reflected ceiling plan', 'mechanical services', 'electrical services',
  'hydraulic services', 'fire services', 'services layout', 'lighting layout', 'power layout', 'ductwork', 'cable tray', 'a0', 'a1']);
// File names like "M-201 Rev C", "E101", "ARK-MS-DWG-004", "H-100_B".
const DRAWING_NAME_RE = /(\b(dwg|drg|drawings?|plans?|layout|schematic|ga)\b)|(^|[\s_-])[a-z]{1,3}[-_ ]?\d{2,4}([\s_-]*(rev|r)?[\s_-]*[a-z0-9]{1,2})?($|[\s_.-])/i;

function detectDocType(fileName, text) {
  const name = norm(fileName);
  const body = norm(text).slice(0, 8000);
  const raw = String(text || '').slice(0, 8000);
  const hasMoney = MONEY_RE.test(raw);
  const scores = [];
  for (const dt of DOC_TYPES) {
    let score = 0;
    const hits = [];
    for (const w of dt.words) {
      const wn = norm(w);
      const inName = countMatches(name, wn);
      const inBody = Math.min(countMatches(body, wn), 3);
      if (inName) { score += 4; hits.push(`"${w}" in file name`); }
      if (inBody) { score += inBody; hits.push(`"${w}" in text`); }
    }
    if (dt.type === 'Plans & Drawings') {
      const cues = DRAWING_CUES.filter((c) => countMatches(body, norm(c)));
      const strong = cues.filter((c) => DRAWING_STRONG.has(c)).length;
      if (cues.length >= 4 && strong >= 2) { score += Math.min(cues.length, 10); hits.unshift(`looks like a drawing (${cues.slice(0, 4).join(', ')}…)`); }
      if (DRAWING_NAME_RE.test(String(fileName || '').replace(/\.[a-z0-9]+$/i, '')) && (strong >= 1 || /\b(dwg|drg|drawings?)\b/i.test(fileName))) { score += 4; hits.unshift('file name looks like a drawing number'); }
    }
    if (MONEY_TYPES.has(dt.type) && score > 0 && !hasMoney && !hits.some((h) => h.endsWith('in file name') || /^"[^"]+ [^"]+" in text$/.test(h))) {
      score = Math.floor(score / 2);
      if (score < 2) continue; // just a passing mention ("we need to quote") - not evidence of what the document is
      hits.push('no prices or totals found');
    }
    if (score > 0) scores.push({ type: dt.type, score, hits });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0] || null;
  if (best) best.runnerUp = scores[1] || null;
  return best;
}

/**
 * Find the company a document belongs to.
 * companies: [{ name, aliases: [], type: 'Client' }]
 */
function detectCompany(fileName, text, companies = [], ownNames = []) {
  const name = norm(fileName);
  const body = norm(text).slice(0, 10000);

  // 1. Companies the user has told us about win - they are the most reliable. An email address counts too, written
  // without the spaces (M25: mere@coastalcafe.com.fj is the known customer "Coastal Cafe").
  let best = null;
  const mailDomains = [...String(text || '').slice(0, 10000).matchAll(EMAIL_DOMAIN_RE)].map((m) => m[1].toLowerCase().replace(/-/g, ''));
  for (const c of companies) {
    if (isOwnCompany(c.name, ownNames)) continue;
    const terms = [c.name, ...(c.aliases || [])].map(norm).filter(Boolean);
    let score = 0;
    for (const t of terms) score += countMatches(name, t) * 5 + Math.min(countMatches(body, t), 5);
    for (const t of terms) { const compact = t.replace(/[^a-z0-9]/g, ''); if (compact.length >= 4 && mailDomains.includes(compact)) score += 3; }
    if (score > 0 && (!best || score > best.score)) best = { company: c.name, companyType: c.type || 'Companies', score, known: true };
  }
  if (best) return best;

  // 2. Look for "Bill to: X", "Client: X" etc.
  const raw = (text || '').slice(0, 10000);
  for (const m of raw.matchAll(CONTEXT_RE)) {
    const candidate = cleanCompanyName(m[1]);
    const legal = candidate.match(new RegExp(`^(.*?\\b${LEGAL_SUFFIX})(?![A-Za-z])`));
    if (legal && !isOwnCompany(legal[1], ownNames)) {
      return { company: cleanCompanyName(legal[1]), companyType: 'Companies', score: 3, known: false };
    }
  }

  // 3. Any name ending in Ltd / Inc / LLC ... - most frequent wins.
  const counts = {};
  for (const m of raw.matchAll(COMPANY_RE)) {
    const c = cleanCompanyName(m[1]).replace(/^(?:The|From|To|Bill|Invoice|Dear|Attention|Attn)\s+/i, '');
    if (c.split(' ').length < 2 || isOwnCompany(c, ownNames)) continue;
    counts[c] = (counts[c] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top) return { company: top[0], companyType: 'Companies', score: 2, known: false };

  // 4. Business email domains (accounts@acmeplumbing.co.nz -> Acmeplumbing).
  const domains = {};
  for (const m of raw.matchAll(EMAIL_DOMAIN_RE)) {
    const d = m[1].toLowerCase();
    if (GENERIC_DOMAINS.has(d) || ownNames.some((o) => norm(o).replace(/ /g, '') === d)) continue;
    domains[d] = (domains[d] || 0) + 1;
  }
  const topDomain = Object.entries(domains).sort((a, b) => b[1] - a[1])[0];
  if (topDomain) {
    const pretty = topDomain[0].charAt(0).toUpperCase() + topDomain[0].slice(1);
    return { company: pretty, companyType: 'Companies', score: 1, known: false };
  }
  return null;
}

function mediaCategory(ext) {
  for (const [cat, exts] of Object.entries(MEDIA)) if (exts.includes(ext)) return cat;
  return null;
}

/**
 * Classify one file. Returns where it should live and why.
 * { category, docType, company, companyType, confidence: 'high'|'medium'|'low', reasons: [] }
 */
function classify({ fileName, ext, text }, settings = {}) {
  const companies = settings.companies || [];
  const ownNames = settings.ownCompanyNames || [];
  ext = (ext || '').toLowerCase();

  const dt = detectDocType(fileName, text || '');
  let co = detectCompany(fileName, text || '', companies, ownNames);
  // Only your own business is mentioned (payroll, your tax, staff files...): file it under your business.
  const OWN_TYPES = ['Payroll', 'Timesheets', 'Payslips', 'Tax', 'Staff & HR', 'Insurance', 'Statements', 'Health & Safety'];
  if (!co && dt && OWN_TYPES.includes(dt.type) && ownNames.length) {
    const hay = norm(`${fileName} ${(text || '').slice(0, 10000)}`);
    const own = ownNames.find((o) => norm(o) && hay.includes(norm(o)));
    if (own) co = { company: own, companyType: 'My business', score: 3, known: true };
  }
  const media = mediaCategory(ext);

  // Images/videos etc. with no business meaning just get tidied by kind.
  if (media && !(dt && dt.score >= 4) && !(co && co.known)) {
    return { category: 'Media', docType: media, company: null, companyType: null, confidence: 'high', reasons: [`${ext} file`] };
  }

  const reasons = [];
  if (dt) reasons.push(...dt.hits.slice(0, 3));
  if (co) reasons.push(co.known ? `mentions ${co.company} (your company list)` : `looks like it's from/for ${co.company}`);

  let confidence = 'low';
  const typeStrong = dt && dt.score >= 4 && !(dt.runnerUp && dt.runnerUp.score >= dt.score - 1);
  if (dt && dt.runnerUp && dt.runnerUp.score >= dt.score - 1) reasons.push(`could also be ${dt.runnerUp.type}`);
  if (co && co.known && dt) confidence = typeStrong ? 'high' : 'medium';
  else if (co && dt && typeStrong) confidence = 'medium';
  else if (co || typeStrong) confidence = 'low';

  return {
    category: co ? 'Company' : (dt ? 'General' : 'Unsorted'),
    docType: dt ? dt.type : (media || 'Other'),
    company: co ? co.company : null,
    companyType: co ? co.companyType : null,
    companyKnown: !!(co && co.known),
    confidence,
    reasons,
  };
}

/** Folder (relative, may contain '/') for a document type. */
function folderFor(docType) {
  const d = DOC_TYPES.find((x) => x.type === docType);
  return (d && d.folder) || docType;
}

module.exports = { classify, detectDocType, detectCompany, folderFor, DOC_TYPES, MEDIA };
