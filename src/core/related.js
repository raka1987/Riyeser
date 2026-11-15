// Finds documents that belong together - a quote, the invoice that follows it and the receipt for it -
// by looking for things they share: reference numbers, a site/street address or a project/job name.
const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const STREET = '(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Place|Pl|Crescent|Cres|Terrace|Tce|Way|Court|Ct|Boulevard|Blvd|Highway|Hwy|Close|Parade|Pde|Grove|Gr|Square|Sq)';
const ADDRESS_RE = new RegExp(`(?<![\\w-])(\\d{1,5}[A-Za-z]?(?:[/-]\\d{1,5})?\\s+(?:[A-Z][a-z']+\\s+){1,3}${STREET})\\b\\.?`, 'g');
const REF_RE = /\b(?:invoice|inv|quotation|quote|estimate|purchase order|p\.?o\.?|receipt|order|job|work order|claim|policy|contract|reference|ref|account|acct)\s*(?:no\b\.?|number\b|num\b|#|id\b)?\s*[:#.\-]?\s*([A-Z]{0,5}[-/]?\d[A-Z0-9\-/]{2,18})\b/gi;
const CODE_RE = /\b((?:INV|QU|QT|QUO|PO|RCPT|REC|JOB|WO|ORD|SO|CN)[-_ ]?\d{3,})\b/gi;
const PROJECT_RE = /(?:^|\n)\s*(?:project|job|site|property|re|subject|for)\s*[:\-–]\s*([^\n]{4,70})/gi;

const STREET_SHORT = { street: 'st', road: 'rd', avenue: 'ave', drive: 'dr', lane: 'ln', place: 'pl', crescent: 'cres', terrace: 'tce', court: 'ct', boulevard: 'blvd', highway: 'hwy', parade: 'pde', grove: 'gr', square: 'sq' };

function normRef(r) { return r.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(INVOICE|QUOTE|QUOTATION|ORDER)/, ''); }
function normAddress(a) {
  return a.toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '').trim()
    .replace(/\b(street|road|avenue|drive|lane|place|crescent|terrace|court|boulevard|highway|parade|grove|square)$/, (m) => STREET_SHORT[m]);
}

/** The things in a document that could tie it to other documents. */
function extractKeys(text, fileName = '') {
  const t = `${fileName.replace(/[_]/g, ' ')}\n${(text || '').slice(0, 12000)}`;
  const keys = new Map(); // key -> label shown to the user
  for (const m of t.matchAll(REF_RE)) {
    const raw = m[1].replace(/[-/.]+$/, '');
    const n = normRef(raw);
    if (n.replace(/\D/g, '').length < 3 || MONTHS.test(raw) || /^(19|20)\d{2}$/.test(n) || /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(raw)) continue;
    keys.set(`ref:${n}`, raw.toUpperCase());
  }
  for (const m of t.matchAll(CODE_RE)) keys.set(`ref:${normRef(m[1])}`, m[1].toUpperCase().replace(/[_ ]/, '-'));
  for (const m of t.matchAll(ADDRESS_RE)) {
    const label = m[1].replace(/\s+/g, ' ').trim();
    keys.set(`addr:${normAddress(label)}`, label);
  }
  for (const m of t.matchAll(PROJECT_RE)) {
    const label = m[1].replace(/\s+/g, ' ').replace(/[.,;:]+$/, '').trim();
    if (label.length < 4 || /^(invoice|quote|payment|your|the|this)\b/i.test(label) || /\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}/.test(label)) continue;
    keys.set(`proj:${label.toLowerCase().slice(0, 50)}`, label.slice(0, 50));
  }
  return [...keys].map(([key, label]) => ({ key, label }));
}

/**
 * Group items that share a key. Each item needs { keys, company }.
 * Keys found in lots of documents (e.g. your own business address on every invoice) are ignored.
 * Documents for two different companies are never joined.
 * Sets item.group = { name, size, because } on items that belong to a group of 2+.
 */
function linkRelated(items) {
  const docs = items.filter((it) => it.keys && it.keys.length && it.category !== 'Media');
  if (docs.length < 2) return items;
  const count = new Map();
  for (const d of docs) for (const k of new Set(d.keys.map((x) => x.key))) count.set(k, (count.get(k) || 0) + 1);
  const tooCommon = (k) => { const c = count.get(k); return docs.length >= 4 && c > Math.max(3, docs.length * 0.4); };

  // union-find
  const parent = docs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const company = docs.map((d) => d.company || null);
  const byKey = new Map();
  docs.forEach((d, i) => d.keys.forEach(({ key }) => { if (!tooCommon(key) && count.get(key) > 1) { if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(i); } }));
  const reasons = new Map(); // root -> Set(labels)
  for (const [key, idxs] of byKey) {
    for (let k = 1; k < idxs.length; k++) {
      const a = find(idxs[0]); const b = find(idxs[k]);
      if (a === b) continue;
      const ca = company[a]; const cb = company[b];
      if (ca && cb && ca.toLowerCase() !== cb.toLowerCase()) continue; // different businesses: keep apart
      parent[b] = a;
      company[a] = ca || cb;
    }
    const label = docs[idxs[0]].keys.find((x) => x.key === key).label;
    const r = find(idxs[0]);
    if (!reasons.has(r)) reasons.set(r, new Map());
    reasons.get(r).set(key, label);
  }

  const groups = new Map();
  docs.forEach((d, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(d); });
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    // reasons may have been recorded against an old root before merges; collect from all
    const shared = new Map();
    for (const [r, m] of reasons) if (find(r) === root) for (const [k, l] of m) shared.set(k, l);
    const pick = (prefix) => [...shared].filter(([k]) => k.startsWith(prefix)).map(([, l]) => l)[0];
    // If only one member mentions the site address / project, it still makes the best folder name,
    // as long as there's exactly one in the whole group.
    const onlyOne = (prefix) => {
      const found = new Map();
      for (const m of members) for (const { key, label } of m.keys) if (key.startsWith(prefix) && !tooCommon(key)) found.set(key, label);
      return found.size === 1 ? [...found.values()][0] : null;
    };
    const name = pick('addr:') || onlyOne('addr:') || pick('proj:') || onlyOne('proj:') || pick('ref:') || 'Related documents';
    const because = [...shared.values()].slice(0, 3);
    const groupCompany = company[root];
    for (const m of members) {
      m.group = { name: name.replace(/[<>:"/\\|?*]/g, '-'), size: members.length, because };
      if (!m.company && groupCompany) { m.company = groupCompany; m.companyFromGroup = true; }
    }
  }
  return items;
}

module.exports = { extractKeys, linkRelated };
