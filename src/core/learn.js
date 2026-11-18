// Learns where YOU like things filed - like an assistant who notices how you keep your filing cabinet.
// Examples come from (1) folders you chose with "Change folder…" and (2) files you put in your Organised folder yourself.
// A new file that looks like those examples (same company, same kind of document, similar name/wording) goes to the same place.
const path = require('path');

const STOP = new Set(('the and for with from this that your you our are was were have has had not but all any can will into per out via' +
  ' pdf docx xlsx doc xls copy final draft new version updated scan scanned page pages file document documents image img dsc' +
  ' january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec' +
  ' monday tuesday wednesday thursday friday saturday sunday total date amount number please thank thanks regards dear limited ltd inc llc').split(' '));

const words = (s) => (String(s || '').toLowerCase().match(/[a-z][a-z&]+/g) || []).filter((w) => w.length >= 3 && !STOP.has(w));

/** What a document "looks like": words from its name, and the most frequent words in its text. */
function featureTokens(name, text) {
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '');
  const nameTokens = [...new Set(words(base))];
  const freq = new Map();
  for (const w of words(String(text || '').slice(0, 4000))) if (w.length >= 4) freq.set(w, (freq.get(w) || 0) + 1);
  const textTokens = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([w]) => w);
  return { nameTokens, textTokens };
}

const jaccard = (a = [], b = []) => {
  if (!a.length || !b.length) return 0;
  const B = new Set(b); let both = 0;
  for (const x of a) if (B.has(x)) both++;
  return both / (a.length + b.length - both);
};
const extGroup = (ext) => (/^\.(xlsx?|xlsm|csv|ods|numbers)$/i.test(ext || '') ? 'sheet' : /^\.(docx?|odt|rtf|pages)$/i.test(ext || '') ? 'word' : /^\.pdf$/i.test(ext || '') ? 'pdf' : 'other');

/** Turn a folder into a reusable pattern: year folders become {year} so next year's files go to next year's folder. */
function templateFor(dir, root) {
  const rel = root && (dir === root || dir.startsWith(root + path.sep)) ? path.relative(root, dir) : null;
  const parts = (rel !== null ? rel : dir).split(/[\\/]/).filter((p, i) => p || i === 0).map((p) => (/^(19|20)\d{2}$/.test(p) ? '{year}' : p));
  return { template: parts.join('/'), inRoot: rel !== null };
}
function folderFromTemplate(t, root, year) {
  const parts = t.template.split('/').map((p) => (p === '{year}' ? (year || String(new Date().getFullYear())) : p));
  return t.inRoot ? path.join(root, ...parts) : path.join(...parts);
}

/** Build an example from a document and the folder it lives in (or was put in). */
function makeExample({ name, text, nameTokens, textTokens, company, docType, ext }, dir, root, explicit = false) {
  const tokens = nameTokens ? { nameTokens, textTokens } : featureTokens(name, text);
  return { ...tokens, company: company || null, docType: docType || null, ext: ext || path.extname(name || ''), ...templateFor(dir, root), explicit, at: Date.now() };
}

function similarity(item, ex) {
  let score = 0;
  if (item.company && ex.company && item.company.toLowerCase() === ex.company.toLowerCase()) score += 2;
  else if (item.company && ex.company) score -= 1.5; // different businesses: don't mix them up
  if (item.docType && ex.docType && item.docType === ex.docType && item.docType !== 'Other') score += 1.5;
  if (extGroup(item.ext) === extGroup(ex.ext)) score += 0.4;
  score += jaccard(item.nameTokens, ex.nameTokens) * 3 + jaccard(item.textTokens, ex.textTokens) * 2;
  return score;
}

/**
 * Where would you put this file, judging by the examples? Returns { dir, because, support } or null.
 * Needs a clear winner: one destination with most of the similar examples behind it.
 */
function learnedDestination(item, examples, root) {
  if (!examples || !examples.length || item.category === 'Media' || item.isFolder) return null;
  const votes = new Map();
  let total = 0;
  for (const ex of examples) {
    const s = similarity(item, ex);
    if (s < 3) continue;
    const w = s * (ex.explicit ? 2 : 1);
    const key = `${ex.inRoot ? 'r' : 'a'}|${ex.template}`;
    const v = votes.get(key) || { ex, weight: 0, count: 0, explicit: false, best: 0 };
    v.weight += w; v.count++; v.explicit = v.explicit || ex.explicit; v.best = Math.max(v.best, s);
    votes.set(key, v); total += w;
  }
  const top = [...votes.values()].sort((a, b) => b.weight - a.weight)[0];
  if (!top || top.weight / total < 0.6) return null;
  if (top.count < 2 && !(top.explicit && top.best >= 3.5)) return null;
  const year = (item.details?.date || item.aiDate || item.details?.month || item.fileDate || '').slice(0, 4);
  return {
    dir: folderFromTemplate(top.ex, root, year),
    because: top.explicit ? 'you chose this folder for similar files' : `you keep ${top.count} similar file${top.count === 1 ? '' : 's'} here`,
    support: top.count,
  };
}

module.exports = { featureTokens, makeExample, learnedDestination, templateFor, folderFromTemplate, similarity };
