// The dial plan: what a number dialled on a desk phone means.
//   100–899   a person's extension, or a branch (ring group) number such as 100 or 200
//   *78 / *79 Do not disturb on / off for the phone that dials it
//   anything else: not a number here (404 with a plain reason)
const DND_ON = '*78';
const DND_OFF = '*79';
const MIN_EXT = 100;
const MAX_EXT = 899;

// Emergency numbers in Fiji, Australia and New Zealand (and the mobile-wide 112). This system can't reach them.
const EMERGENCY = new Set(['000', '111', '112', '911', '910', '917', '999']);
const validExt = (n) => /^\d{3}$/.test(String(n)) && Number(n) >= MIN_EXT && Number(n) <= MAX_EXT;

/** Clean up what was dialled (the user part of the Request-URI). */
function normalise(dialled) {
  let s = String(dialled || '');
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  return s.replace(/[\s().-]/g, '');
}

/**
 * { type: 'ext', ext } | { type: 'group', ext } | { type: 'dnd', on } | { type: 'none', reason }
 * directory: { user(ext) -> person | null, group(ext) -> group | null }
 */
function resolve(dialled, directory) {
  const n = normalise(dialled);
  if (n === DND_ON) return { type: 'dnd', on: true };
  if (n === DND_OFF) return { type: 'dnd', on: false };
  if (validExt(n)) {
    if (directory.group(n)) return { type: 'group', ext: n };
    if (directory.user(n)) return { type: 'ext', ext: n };
    if (EMERGENCY.has(n)) return { type: 'none', emergency: true, reason: 'No emergency calls - use a mobile or normal phone' };
    return { type: 'none', reason: `No one has extension ${n}` };
  }
  if (EMERGENCY.has(n)) return { type: 'none', emergency: true, reason: 'No emergency calls - use a mobile or normal phone' };
  if (/^\d+$/.test(n) && n.length > 3) return { type: 'none', reason: 'Internal calls only - outside numbers cannot be called' };
  return { type: 'none', reason: 'Dial a 3-digit extension' };
}

module.exports = { resolve, normalise, validExt, EMERGENCY, DND_ON, DND_OFF, MIN_EXT, MAX_EXT };
