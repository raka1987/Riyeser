// Finds duplicates even when the names differ:
//  - exact copies (byte-for-byte the same file, e.g. "Wage.xlsx" and "Wage - Copy (2).xlsx")
//  - the same document with small changes or in another format (Word vs PDF, a re-saved or re-scanned copy),
//    found by comparing the words inside them.
// For each set it recommends which one to keep; the rest are suggested for the Archive (nothing is lost).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
const SEEDS = Array.from({ length: 32 }, (_, i) => (Math.imul(i + 1, 0x9e3779b1) >>> 0) | 1);

function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9$.,/-]+/g, ' ').split(' ').filter((w) => w.length > 1);
}
/** Fingerprint of a document's wording (MinHash over 4-word shingles). */
function signature(text) {
  const w = words(text);
  if (w.length < 30) return null; // too little text to compare reliably
  const sh = new Set();
  for (let i = 0; i + 4 <= w.length && sh.size < 4000; i++) sh.add(fnv(w.slice(i, i + 4).join(' ')));
  const sig = SEEDS.map((seed) => { let min = 0xffffffff; for (const h of sh) { const v = (Math.imul(h ^ seed, 0x85ebca6b) >>> 0); if (v < min) min = v; } return min; });
  return sig;
}
const estimate = (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 1 : 0), 0) / a.length;
function fileHash(file) { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } }

const COPYISH = /(\bcopy\b|\(\d+\)|- copy|\bfinal final\b|\bduplicate\b|~\d+)/i;

/**
 * items: [{ from, name, size, mtime, _text }]
 * Returns groups: [{ kind: 'exact'|'similar', similarity, differentFormats, files: [{ path, name, size, mtime, recommend: 'keep'|'archive', why }] }]
 */
function findDuplicateGroups(items, { organisedRoot = '' } = {}) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const exactPair = new Set(); const simScore = new Map(); const hashes = new Map();
  const hashOf = (i) => { if (!hashes.has(i)) hashes.set(i, fileHash(items[i].from)); return hashes.get(i); };

  // 1. exact copies: same size, then same content hash
  const bySize = new Map();
  items.forEach((it, i) => { if (it.size > 0) { if (!bySize.has(it.size)) bySize.set(it.size, []); bySize.get(it.size).push(i); } });
  for (const idx of bySize.values()) {
    if (idx.length < 2) continue;
    const byHash = new Map();
    for (const i of idx) { const h = hashOf(i); if (!h) continue; if (!byHash.has(h)) byHash.set(h, []); byHash.get(h).push(i); }
    for (const g of byHash.values()) for (let k = 1; k < g.length; k++) { join(g[0], g[k]); exactPair.add(`${g[0]}|${g[k]}`); }
  }

  // 2. same document with different bytes: compare wording; only compare files that share a band of the fingerprint
  const sigs = items.map((it) => signature(it._text));
  const buckets = new Map();
  sigs.forEach((sig, i) => { if (!sig) return; for (let b = 0; b < 8; b++) { const key = `${b}:${sig.slice(b * 4, b * 4 + 4).join(',')}`; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(i); } });
  const tried = new Set();
  for (const g of buckets.values()) {
    if (g.length < 2 || g.length > 200) continue;
    for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) {
      const a = g[x]; const b = g[y]; const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (tried.has(key)) continue; tried.add(key);
      const s = estimate(sigs[a], sigs[b]);
      if (s >= 0.8) { join(a, b); simScore.set(key, s); }
    }
  }

  // 3. build the groups and recommend what to keep
  const groups = new Map();
  items.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  const out = [];
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const allExact = idx.every((i) => items[i].size === items[idx[0]].size) && idx.every((i) => hashOf(i) && hashOf(i) === hashOf(idx[0]));
    const exts = new Set(idx.map((i) => path.extname(items[i].name).toLowerCase()));
    const differentFormats = exts.size > 1;
    const sims = [...simScore.entries()].filter(([k]) => { const [a, b] = k.split('|').map(Number); return idx.includes(a) && idx.includes(b); }).map(([, v]) => v);
    const similarity = allExact ? 1 : (sims.length ? Math.min(...sims) : 0.8);
    const inOrganised = (p) => organisedRoot && p.startsWith(organisedRoot + path.sep);
    const score = (it) => (inOrganised(it.from) ? 4 : 0) + (COPYISH.test(it.name) ? -3 : 1)
      + (allExact ? -it.mtime / 1e13 : it.mtime / 1e13); // exact copies: keep the original (oldest); revisions: keep the newest
    const files = idx.map((i) => items[i]).sort((a, b) => score(b) - score(a));
    // Keep the best copy of each format (e.g. the Word original and the PDF you sent); suggest archiving the rest.
    const seenExt = new Set();
    out.push({
      kind: allExact ? 'exact' : 'similar', similarity: Math.round(similarity * 100), differentFormats,
      files: files.map((f, k) => {
        const ext = path.extname(f.name).toLowerCase();
        const keep = !seenExt.has(ext); seenExt.add(ext);
        const why = keep
          ? (k === 0 ? (inOrganised(f.from) ? 'already filed' : allExact ? 'the original' : 'the latest version') : `the same document as a ${ext.slice(1).toUpperCase()} - kept in case you need both formats`)
          : (COPYISH.test(f.name) ? 'looks like a copy' : allExact || hashOf(items.indexOf(f)) === hashOf(items.indexOf(files.find((x) => path.extname(x.name).toLowerCase() === ext))) ? 'identical copy' : 'older or near-identical version');
        return { path: f.from, name: f.name, size: f.size, mtime: f.mtime, recommend: keep ? 'keep' : 'archive', why };
      }),
    });
  }
  return out.sort((a, b) => b.files.length - a.files.length);
}

module.exports = { findDuplicateGroups, signature };
