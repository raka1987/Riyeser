// Riyeser Documents: where should a new document go? Suggests a folder such as
// "Accounts/Suppliers/Pacific Hardware/2026", with a plain-English reason, in this order:
//   1. your filing rules ("anything that mentions BSP goes in Accounts › Bank statements")
//   2. what you did before with similar documents (learned from every filing, more from "Change")
//   3. what the document looks like (invoice, payslip, quote...) and who it's from
//   4. the scan folder it came in through (scanned to Accounts: it stays in Accounts)
// Reuses the Desk Assistant's classifier, date/reference reader and learning maths (core/).
const { classify } = require('../core/classifier');
const { extractDetails, suggestName } = require('../core/details');
const { featureTokens, similarity } = require('../core/learn');

const YEAR = '{year}';
const LEGAL = /\s+(ltd|limited|llc|inc|incorporated|corp|corporation|plc|pty ltd|pty|gmbh|llp|co\.?|company|group|holdings)\.?$/i;
const cleanSeg = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 60);
// "TAX INVOICE Pacific Hardware Ltd" (a heading run into the name on a scan) -> "Pacific Hardware Ltd"
const HEADING = /^((tax\s+)?invoice|statement( of account)?|receipt|quot(e|ation)|credit note|remittance( advice)?|purchase order|delivery (docket|note)|bill|from|to|supplier)\s+/i;
function cleanCompany(c) { let s = String(c || '').replace(/\s+/g, ' ').trim(); for (let i = 0; i < 3 && HEADING.test(s); i++) s = s.replace(HEADING, ''); return s || null; }
const companyFolder = (c) => cleanSeg(String(cleanCompany(c) || '').replace(LEGAL, '').replace(LEGAL, ''));

/** Starter rules for a new library. People change them in Settings › Filing rules. */
function defaultRules() {
  const r = (id, name, words, folder, year = true) => ({ id, name, words, folder, year, enabled: true });
  return [
    r('bank-bsp', 'Anything from BSP', ['BSP', 'Bank South Pacific'], 'Accounts/Bank statements'),
    r('bank-anz', 'Anything from ANZ', ['ANZ'], 'Accounts/Bank statements'),
    r('bank-westpac', 'Anything from Westpac', ['Westpac'], 'Accounts/Bank statements'),
    r('bank-words', 'Bank statements', ['bank statement', 'statement of account'], 'Accounts/Bank statements'),
    r('tax', 'Tax returns', ['tax return', 'VAT return', 'GST return', 'FRCS', 'IRD', 'ATO'], 'Accounts/Tax'),
  ];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (w) => new RegExp(`(^|[^a-z0-9])${esc(String(w).toLowerCase().trim())}($|[^a-z0-9])`, 'i');
function ruleMatches(rule, doc) {
  if (!rule || rule.enabled === false || !(rule.words || []).length) return false;
  const hay = `${doc.name || ''}\n${doc.company || ''}\n${String(doc.text || '').slice(0, 20000)}`;
  return rule.words.some((w) => String(w).trim() && phraseRe(w).test(hay));
}

/** "Accounts/Suppliers/Pacific Hardware/2026" -> "Accounts/Suppliers/Pacific Hardware/{year}" */
const toTemplate = (rel) => String(rel || '').split('/').filter(Boolean).map((p) => (/^(19|20)\d{2}$/.test(p) ? YEAR : p)).join('/');
const fromTemplate = (t, year) => String(t || '').split('/').filter(Boolean).map((p) => (p === YEAR ? year : p)).join('/');

/** Remember where a document was filed. explicit: the person picked the folder themselves ("Change"). */
function makeExample(doc, folderRel, explicit = false) {
  const t = featureTokens(doc.name, doc.text);
  return { ...t, company: doc.company || null, docType: doc.docType || null, ext: doc.ext || '', template: toTemplate(folderRel), explicit: !!explicit, at: Date.now() };
}

/** A clear winner among the similar documents filed before, or null. */
function learnedFolder(doc, examples) {
  if (!examples || !examples.length) return null;
  const item = { ...featureTokens(doc.name, doc.text), company: doc.company, docType: doc.docType, ext: doc.ext };
  const votes = new Map(); let total = 0;
  for (const ex of examples) {
    const s = similarity(item, ex);
    if (s < 3) continue;
    const w = s * (ex.explicit ? 2 : 1);
    const v = votes.get(ex.template) || { template: ex.template, weight: 0, count: 0, explicit: false, best: 0 };
    v.weight += w; v.count++; v.explicit = v.explicit || ex.explicit; v.best = Math.max(v.best, s);
    votes.set(ex.template, v); total += w;
  }
  const top = [...votes.values()].sort((a, b) => b.weight - a.weight)[0];
  if (!top || top.weight / total < 0.6) return null;
  if (top.count < 2 && !(top.explicit && top.best >= 3.5)) return null;
  return { template: top.template, because: top.explicit && top.count < 2 ? 'You chose this folder for a similar document' : `You filed ${top.count} similar documents here` };
}

const ACCOUNTS_TYPES = new Set(['Invoices', 'Credit Notes', 'Receipts', 'Remittances', 'Purchase Orders', 'Delivery Dockets', 'Price Lists']);
const JOB_TYPES = new Set(['Variations', 'Plans & Drawings', 'Specifications', 'Commissioning', 'Certificates', 'Health & Safety']);
const SINGULAR = { Invoices: 'an invoice', 'Credit Notes': 'a credit note', Receipts: 'a receipt', Remittances: 'a remittance', 'Purchase Orders': 'a purchase order',
  'Delivery Dockets': 'a delivery docket', Statements: 'a statement', Tax: 'a tax document', Payslips: 'a payslip', Timesheets: 'a timesheet', Payroll: 'a payroll document',
  'Staff & HR': 'a staff document', Quotes: 'a quote', Proposals: 'a proposal', Contracts: 'a contract', Insurance: 'an insurance document', 'Price Lists': 'a price list' };

/** Department path from what the document is. */
function byType(doc, text) {
  const t = doc.docType; const co = companyFolder(doc.company);
  const what = SINGULAR[t] ? `Looks like ${SINGULAR[t]}${doc.company ? ` from ${doc.company}` : ''}` : null;
  if (t === 'Statements' && /\b(bank|bsb|account number|overdraft|savings|cheque account)\b/i.test(text)) return { template: `Accounts/Bank statements/${YEAR}`, because: 'Looks like a bank statement' };
  if (ACCOUNTS_TYPES.has(t) || t === 'Statements') return { template: co ? `Accounts/Suppliers/${co}/${YEAR}` : `Accounts/Suppliers/${YEAR}`, because: what };
  if (t === 'Tax') return { template: `Accounts/Tax/${YEAR}`, because: what };
  if (t === 'Payslips' || t === 'Timesheets' || t === 'Payroll') return { template: `Payroll & HR/${t === 'Timesheets' ? 'Timesheets' : 'Pay'}/${YEAR}`, because: what };
  if (t === 'Staff & HR') return { template: 'Payroll & HR/Staff', because: what };
  if (t === 'Quotes' || t === 'Proposals') return { template: `Sales/Quotes/${YEAR}`, because: what };
  if (t === 'Contracts') return { template: co ? `Admin/Contracts/${co}` : 'Admin/Contracts', because: what };
  if (t === 'Insurance') return { template: `Admin/Insurance/${YEAR}`, because: what };
  if (JOB_TYPES.has(t) || /\b(job sheet|job no|job number|work order)\b/i.test(text)) return { template: `Jobs/${YEAR}`, because: 'Looks like a job document' };
  if (['Images', 'Videos'].includes(t)) return { template: `Jobs/Photos/${YEAR}`, because: 'A photo' };
  if (t && t !== 'Other' && !['Audio', 'Installers', 'Archives'].includes(t)) return { template: `Admin/${YEAR}`, because: 'General paperwork' };
  return null;
}

/**
 * Suggest a folder (and a tidier name) for a document.
 * doc: { name, ext, text, deptHint, added, company?, docType? }
 * opts: { rules, examples, departments: ['Accounts', ...], settings: classifier settings }
 * Returns { folder, because, name|null, company, docType }.
 */
function suggest(doc, { rules = [], examples = [], departments = [], settings = {} } = {}) {
  const text = String(doc.text || '');
  const c = classify({ fileName: doc.name, ext: doc.ext, text }, settings);
  const d = extractDetails(text, doc.name, { dayFirst: settings.dayFirstDates !== false });
  const enriched = { ...doc, company: cleanCompany(doc.company || c.company), docType: doc.docType || c.docType };
  const year = (d.date || d.month || doc.added || new Date().toISOString()).slice(0, 4);
  const hint = doc.deptHint || null;
  let pick = null;

  const rule = (rules || []).find((r) => ruleMatches(r, enriched));
  if (rule) pick = { template: rule.year ? `${rule.folder}/${YEAR}` : rule.folder, because: `Your rule: ${rule.name}` };
  if (!pick) { const l = learnedFolder(enriched, examples); if (l) pick = l; }
  if (!pick) pick = byType(enriched, text);
  // Scanned into a department's scan folder: keep it in that department
  const top = (t) => String(t || '').split('/')[0];
  if (hint && (!pick || (top(pick.template) !== hint && !rule))) {
    const co = companyFolder(enriched.company);
    pick = { template: `${hint}${co && hint === 'Accounts' ? `/Suppliers/${co}` : ''}/${YEAR}`, because: `Scanned to the ${hint} scan folder` };
  }
  if (!pick) pick = { template: `${departments.includes('Admin') || !departments.length ? 'Admin' : departments[0]}/${YEAR}`, because: 'Not sure yet: check it and pick a folder' };
  // A department that doesn't exist in this library: use the scan folder's, or the first one
  if (departments.length && !departments.includes(top(pick.template))) {
    const dep = hint && departments.includes(hint) ? hint : departments[0];
    pick = { template: [dep, ...pick.template.split('/').slice(1)].join('/'), because: pick.because };
  }
  const ext = doc.ext || '';
  const name = suggestName({ fileName: doc.name, ext, classification: c, details: d, fallbackDate: (doc.added || '').slice(0, 10) });
  return { folder: fromTemplate(pick.template, year), because: pick.because || 'Suggested', name, company: enriched.company || null, docType: enriched.docType || null };
}

module.exports = { suggest, defaultRules, ruleMatches, makeExample, learnedFolder, toTemplate, fromTemplate, companyFolder, cleanSeg };
