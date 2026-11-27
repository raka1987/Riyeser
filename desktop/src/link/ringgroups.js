// Ring groups on Riyeser Link Office: who a call to a group's number rings, and in what order.
// A group (a branch's number such as 100, or one with its own number such as Sales 300) rings only the people and
// shared desk phones chosen for it in Riyeser Link (or here, by hand), never everyone in a branch by itself:
//   all     everyone chosen at once; the first to answer takes the call
//   order   one after another, ringSeconds each, in the order chosen
//   rotate  like order, but starting with the next person each time
// A person's desk phones and Riyeser Link apps ring together, as for a call to their own extension. Anyone on Do not
// disturb or already on a call is skipped. If nobody answers within timeoutSeconds: the group's fallback (another
// group's number, or one person's extension), else a missed call.
const STRATEGIES = ['all', 'order', 'rotate'];
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d; };

/** A group as saved on this PC, with its ringing settings filled in. */
function settings(g) {
  const fb = g && g.fallback && (g.fallback.type === 'group' || g.fallback.type === 'person') && g.fallback.ext ? { type: g.fallback.type, ext: String(g.fallback.ext) } : null;
  return { strategy: STRATEGIES.includes(g && g.strategy) ? g.strategy : 'all', ringSeconds: num(g && g.ringSeconds, 15, 0.05, 120),
    timeoutSeconds: num(g && g.timeoutSeconds, 0, 0.05, 300) || null, fallback: fb };
}

/**
 * plan(group, { caller, dnd(ext), busy(ext), contactsOf(ext), turn, defaultMs })
 *   -> { steps: [[{ binding, ext }]], stepMs, totalMs, skipped: [{ ext, why: 'dnd' | 'on_call' | 'not_connected' }], fallback, members }
 * Each step rings together; the next step starts when the step's phones all say no, or after stepMs.
 */
function plan(group, { caller = null, dnd = () => false, busy = () => false, contactsOf = () => [], turn = 0, defaultMs = 120000 } = {}) {
  const s = settings(group);
  let members = [...new Set((group && group.members ? group.members : []).map(String))].filter((m) => m !== String(caller));
  if (s.strategy === 'rotate' && members.length) { const k = ((turn % members.length) + members.length) % members.length; members = [...members.slice(k), ...members.slice(0, k)]; }
  const skipped = []; const ready = [];
  for (const m of members) {
    if (dnd(m)) { skipped.push({ ext: m, why: 'dnd' }); continue; }
    if (busy(m)) { skipped.push({ ext: m, why: 'on_call' }); continue; }
    const phones = contactsOf(m).map((binding) => ({ binding, ext: m }));
    if (!phones.length) { skipped.push({ ext: m, why: 'not_connected' }); continue; }
    ready.push(phones);
  }
  const totalMs = s.timeoutSeconds ? s.timeoutSeconds * 1000 : defaultMs;
  const steps = s.strategy === 'all' ? (ready.length ? [ready.flat()] : []) : ready;
  return { steps, stepMs: s.strategy === 'all' ? totalMs : Math.min(totalMs, s.ringSeconds * 1000), totalMs, skipped, fallback: s.fallback, members: members.length, strategy: s.strategy };
}

module.exports = { plan, settings, STRATEGIES };
