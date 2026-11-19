// Spots things that need doing inside text: meeting notes, calendar descriptions, emails.
const PATTERNS = [
  /^\s*(?:[-*•]\s*)?\[\s\]\s*(.+)$/i,                                   // - [ ] task
  /^\s*(?:[-*•]\s*)?(?:todo|to do|action|action item|ai|follow[ -]?up|task)\s*[:\-–]\s*(.+)$/i,
  /^\s*(?:[-*•]\s*)?@?(?:me|i)\s+(?:to|will|need to|should)\s+(.+)$/i,
  /\b((?:please|pls|can you|could you|need you to|make sure|don't forget to|remember to)\s+(?:review|check|send|sign|approve|confirm|pay|call|email|update|prepare|follow up|reply)[^.?!\n]{0,120})/i,
];
const DUE_RE = /\b(?:by|before|due|on)\s+((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|today|tomorrow|eod|end of (?:day|week|month)|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}|[a-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?)/i;
const URGENT_RE = /\b(urgent|asap|immediately|overdue|final notice|past due|action required|deadline)\b/i;

function extractActionItems(text, source = {}) {
  if (!text) return [];
  const seen = new Set();
  const items = [];
  for (const line of String(text).split(/\r?\n/)) {
    for (const re of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const t = m[1].trim().replace(/\s+/g, ' ').slice(0, 200);
      const key = t.toLowerCase();
      if (t.length < 4 || seen.has(key)) break;
      seen.add(key);
      const due = t.match(DUE_RE) || line.match(DUE_RE);
      items.push({ text: t, due: due ? due[1] : null, urgent: URGENT_RE.test(line), ...source });
      break;
    }
  }
  return items;
}

module.exports = { extractActionItems, URGENT_RE };
