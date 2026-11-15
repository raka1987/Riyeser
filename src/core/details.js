// Reads key facts out of a document (date, reference number, amount) and builds a clean, consistent file name.
const { detectDocType } = require('./classifier');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const SINGULAR = {
  Invoices: 'Invoice', Receipts: 'Receipt', Quotes: 'Quote', 'Purchase Orders': 'Purchase Order', Contracts: 'Contract',
  Statements: 'Statement', Payslips: 'Payslip', Tax: 'Tax', Insurance: 'Insurance', Proposals: 'Proposal',
  'Meeting Notes': 'Meeting Notes', Reports: 'Report', Correspondence: 'Letter',
  'Credit Notes': 'Credit Note', Remittances: 'Remittance', 'Delivery Dockets': 'Delivery Docket', Timesheets: 'Timesheet', Payroll: 'Payroll',
  Variations: 'Variation', 'Plans & Drawings': 'Drawing', Specifications: 'Specification', Commissioning: 'Commissioning', Certificates: 'Certificate',
  'Health & Safety': 'Health and Safety', 'Price Lists': 'Price List', 'Staff & HR': 'HR',
};

function validDate(y, m, d) {
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt.toISOString().slice(0, 10) : null;
}

/** Find all dates in a piece of text. dayFirst=true means 03/04/2026 is 3 April (NZ/AU/UK). */
function findDates(text, dayFirst = true) {
  const out = [];
  const add = (index, iso) => { if (iso) out.push({ index, iso }); };
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) add(m.index, validDate(+m[1], +m[2], +m[3]));
  for (const m of text.matchAll(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})\b/g)) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    add(m.index, dayFirst ? (validDate(y, b, a) || validDate(y, a, b)) : (validDate(y, a, b) || validDate(y, b, a)));
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'gi'))) add(m.index, validDate(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]));
  for (const m of text.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) add(m.index, validDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]));
  return out.sort((a, b) => a.index - b.index);
}

function findDocDate(text, dayFirst) {
  const head = text.slice(0, 6000);
  const dates = findDates(head, dayFirst);
  if (!dates.length) return null;
  // Prefer a date right after a label like "Invoice date:" / "Date:" / "Issued"; avoid "Due date".
  const labelRe = /(invoice date|date of issue|issue date|issued(?: on)?|statement date|tax point|order date|dated?)\s*[:\-]?\s*/gi;
  for (const m of head.matchAll(labelRe)) {
    const before = head.slice(Math.max(0, m.index - 5), m.index).toLowerCase();
    if (/due\s*$/.test(before)) continue;
    const near = dates.find((d) => d.index >= m.index && d.index - (m.index + m[0].length) < 25);
    if (near) return near.iso;
  }
  // Otherwise the first date that isn't a due/expiry date.
  const notDeadline = dates.find((d) => !/(due|valid until|valid to|expir\w*|until|by|before|deadline)\W{0,3}(date)?\W{0,3}$/i.test(head.slice(Math.max(0, d.index - 25), d.index)));
  return notDeadline ? notDeadline.iso : null;
}

function findReference(text, fileName) {
  const re = /\b(?:tax invoice|invoice|inv|quotation|quote|estimate|purchase order|p\.?o\.?|receipt|order|statement|policy|contract|reference|ref)\s*(?:no\b\.?|number\b|num\b|#|id\b)?\s*[:#.\-]?\s*([A-Z]{0,5}[-/]?\d[A-Z0-9\-/]{1,18})\b/gi;
  for (const src of [text.slice(0, 5000), fileName.replace(/[_]/g, ' ')]) {
    for (const m of src.matchAll(re)) {
      const ref = m[1].replace(/[-/.]+$/, '');
      if (/^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(ref)) continue; // that's a date
      if (/^(19|20)\d{2}$/.test(ref)) continue;                       // just a year
      if (new RegExp(`^${MONTH_RE}[-/]?\\d{2,4}$`, 'i').test(ref)) continue;  // a month + year, e.g. Nov2026
      if (ref.replace(/\D/g, '').length >= 2) return ref.toUpperCase();
    }
  }
  const fromName = fileName.match(/\b((?:INV|QU|QT|PO|RCPT|REC)[-_ ]?\d{2,})\b/i);
  return fromName ? fromName[1].replace(/[_ ]/, '-').toUpperCase() : null;
}

function findAmount(text) {
  const m = text.slice(0, 8000).match(/(?:grand total|total due|amount due|balance due|total payable|amount payable|total \(incl[^)]*\)|total)\s*[:\-]?\s*(?:[A-Z]{3}\s*)?([$€£¥])?\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)(?![\d/.\-])/i);
  return m ? `${m[1] || '$'}${m[2]}` : null;
}

/** Facts read from the document. */
function extractDetails(text, fileName, { dayFirst = true } = {}) {
  const t = text || '';
  return {
    date: findDocDate(t, dayFirst),
    reference: findReference(t, fileName || ''),
    amount: findAmount(t),
  };
}

/** Warn when the file name says one thing but the contents say another (e.g. "invoice.pdf" that is really a quote). */
function typeMismatch(fileName, text) {
  if (!text || text.length < 40) return null;
  const byName = detectDocType(fileName, '');
  const byText = detectDocType('', text);
  if (!byName || !byText || byName.type === byText.type) return null;
  if (byText.score < 3) return null;
  return `File name suggests ${SINGULAR[byName.type] || byName.type}, but the contents read like ${SINGULAR[byText.type] || byText.type}`;
}

function clean(s) {
  return String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * Build a tidy file name, e.g. "2026-11-14 Acme Plumbing Invoice INV-1042.pdf".
 * Returns null if we don't know enough to do better than the original name.
 */
function suggestName({ fileName, ext, classification: c, details: d, fallbackDate }) {
  if (!c || c.category === 'Media' || c.category === 'Unsorted') return null;
  const type = SINGULAR[c.docType] || null;
  if (!type || (!c.company && !d.reference)) return null;
  // Only rename when the contents told us something real; otherwise the original name is more useful.
  if (!d.date && !d.reference) return null;
  const parts = [d.date || fallbackDate, c.company, type, d.reference].filter(Boolean).map(clean);
  const name = parts.join(' ').slice(0, 150) + (ext || '');
  return name.toLowerCase() === String(fileName).toLowerCase() ? null : name;
}

module.exports = { extractDetails, suggestName, typeMismatch, findDates, SINGULAR };
