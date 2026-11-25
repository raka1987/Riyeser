// Optional: connects to any mailbox over IMAP (Gmail, Outlook, iCloud, Yahoo, work mail).
// Read-only: it sorts and flags mail inside the app, and can save attachments (e.g. invoices) into the organised folders.
// imapflow and mailparser are loaded only when email is checked (M8: a quicker first start)
const { classify } = require('./classifier');
const { extractActionItems, URGENT_RE } = require('./actions');

const NOREPLY_RE = /no-?reply|do-?not-?reply|notifications?@|mailer-daemon|newsletter|marketing@|news@/i;
const ASK_RE = /\?|\b(can you|could you|please|let me know|thoughts|would you|are you able|need your|waiting on|any update)\b/i;
// M25: a question asking you to come and do something ("could you come Thursday to fix the leaking pipe?") is a to-do
const REQUEST_RE = /\b(?:can|could|would|will) you\s+(?:please\s+)?((?:come|pop|drop|call|ring|visit|fix|look|repair|quote|install|send|book|pick|bring|deliver|check|help)\b[^?.!\n]{2,140})\?/i;
// "Please find attached your invoice" / statements: not a question for you to answer
const PAPERWORK = ['Invoices', 'Statements', 'Receipts'];

// M25: lookalike senders. A bank or a known company's name inside a domain that isn't theirs, or a sign-in / "verify"
// domain on a throwaway ending, with words that push you to act. Marked "check the sender", never just "urgent".
const BANK_WORDS = ['bsp', 'anz', 'westpac', 'commbank', 'nab', 'hfc', 'bred', 'kiwibank', 'asb', 'bnz', 'paypal', 'stripe', 'mpaisa', 'vodafone', 'microsoft', 'apple', 'google', 'amazon', 'ato', 'frcs', 'mygov'];
const BAIT_RE = /\b(account (?:is )?(?:locked|suspended|on hold|disabled)|verify your|confirm your (?:account|identity|details)|unusual (?:sign[- ]?in|activity)|password (?:expires|expired)|reset your password|update your (?:payment|bank) details|click (?:here|below) (?:to|within))\b/i;
const ODD_TLD = /\.(?:xyz|top|click|link|live|online|site|icu|buzz|rest|fit|work|support|info|shop|loan|win)$/i;
function senderDomain(from) { const m = /@([A-Za-z0-9.-]+)/.exec(String(from || '')); return m ? m[1].toLowerCase().replace(/\.$/, '') : ''; }
function senderWarning(from, subject, text, settings = {}) {
  const dom = senderDomain(from);
  if (!dom) return null;
  const labels = dom.split('.'); const base = labels.slice(0, -1).join('.');
  const words = base.split(/[.-]/).filter(Boolean);
  const bait = BAIT_RE.test(`${subject}\n${String(text || '').slice(0, 3000)}`);
  const known = (settings.companies || []).map((c) => String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')).filter((n) => n.length >= 4);
  const borrowed = [...BANK_WORDS, ...known].find((w) => words.includes(w) || (w.length >= 5 && base.replace(/[.-]/g, '').includes(w)));
  const realDomain = borrowed && (words[0] === borrowed || base.replace(/[.-]/g, '') === borrowed) && !/[-]/.test(labels[0]) && !ODD_TLD.test(dom);
  const fishy = /(?:^|[.-])(?:verify|secure|login|signin|account|update|support|alert|confirm)(?:[.-]|$)/.test(base);
  if ((borrowed && !realDomain && (bait || fishy)) || (bait && (fishy || ODD_TLD.test(dom)))) {
    return `Check the sender: ${dom} ${borrowed ? `isn't ${borrowed.toUpperCase()}'s own address` : 'looks like a lookalike address'}. Don't click links or sign in from this email; contact them the usual way.`;
  }
  return null;
}

function categorise(msg, settings) {
  const subject = msg.subject || '';
  const text = (msg.text || '').slice(0, 8000);
  const from = msg.from || '';
  const c = classify({ fileName: subject, ext: '.eml', text: `${from}\n${subject}\n${text}` }, settings);
  const isBulk = !!msg.listUnsubscribe || /unsubscribe/i.test(text.slice(-2000));
  let category = 'Other';
  if (msg.hasInvite || /invitation:|meeting|calendar invite|zoom|teams meeting/i.test(subject)) category = 'Meetings';
  else if (['Invoices', 'Statements', 'Quotes', 'Purchase Orders'].includes(c.docType) && c.confidence !== 'low') category = 'Invoices & Bills';
  else if (c.docType === 'Receipts') category = 'Receipts';
  else if (isBulk) category = 'Newsletters & Promotions';
  // invoices, statements and receipts aren't questions for you to answer (quotes and orders can be)
  const paperwork = PAPERWORK.includes(c.docType) && (category === 'Invoices & Bills' || category === 'Receipts');
  const warning = senderWarning(from, subject, text, settings);
  const actionItems = isBulk || warning ? [] : extractActionItems(text.slice(0, 4000), { source: 'email' });
  const ask = !isBulk && !warning && REQUEST_RE.exec(`${subject}\n${text.slice(0, 4000)}`);
  if (ask && !actionItems.some((a) => a.text.toLowerCase().includes(ask[1].trim().toLowerCase().slice(0, 20)))) {
    const t = ask[1].trim().replace(/\s+/g, ' ');
    const due = /\b(today|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i.exec(t);
    actionItems.push({ text: t.charAt(0).toUpperCase() + t.slice(1), due: due ? due[1] : null, urgent: URGENT_RE.test(t), source: 'email' });
  }
  const needsReply = !isBulk && !warning && !paperwork && !NOREPLY_RE.test(from) && ASK_RE.test(`${subject}\n${text.slice(0, 1500)}`);
  return {
    category,
    company: c.company,
    docType: c.docType,
    needsReply,
    urgent: !warning && URGENT_RE.test(`${subject} ${text.slice(0, 2000)}`),
    warning,
    actionItems,
  };
}

/** Fetch recent messages and sort them. Returns lightweight summaries (no full bodies kept). */
async function fetchAndSort(cfg, settings, { limit = 150, onAttachment = null } = {}) {
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({
    host: cfg.host, port: Number(cfg.port) || 993, secure: cfg.secure !== false,
    auth: { user: cfg.user, pass: cfg.password }, logger: false,
  });
  await client.connect();
  const out = [];
  const lock = await client.getMailboxLock(cfg.mailbox || 'INBOX');
  try {
    const exists = client.mailbox.exists || 0;
    if (exists === 0) return out;
    const range = `${Math.max(1, exists - limit + 1)}:*`;
    for await (const m of client.fetch(range, { uid: true, flags: true, envelope: true, source: true })) {
      if (m.source.length > 20 * 1024 * 1024) continue;
      const parsed = await simpleParser(m.source);
      const summary = {
        uid: m.uid,
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.text || '',
        date: (parsed.date || new Date()).toISOString(),
        unread: !m.flags.has('\\Seen'),
        text: parsed.text || '',
        listUnsubscribe: parsed.headers.get('list-unsubscribe'),
        hasInvite: (parsed.attachments || []).some((a) => /calendar/i.test(a.contentType)),
        attachments: (parsed.attachments || []).filter((a) => a.filename && !/calendar/i.test(a.contentType)).map((a) => ({ filename: a.filename, size: a.size })),
      };
      const sorted = categorise(summary, settings);
      if (onAttachment && parsed.attachments?.length) {
        for (const a of parsed.attachments) if (a.filename && a.content) await onAttachment(a, summary, sorted);
      }
      delete summary.text;
      delete summary.listUnsubscribe;
      out.push({ ...summary, ...sorted, preview: (parsed.text || '').replace(/\s+/g, ' ').slice(0, 200) });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

module.exports = { fetchAndSort, categorise, senderWarning };
