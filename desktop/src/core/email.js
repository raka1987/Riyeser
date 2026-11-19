// Optional: connects to any mailbox over IMAP (Gmail, Outlook, iCloud, Yahoo, work mail).
// Read-only: it sorts and flags mail inside the app, and can save attachments (e.g. invoices) into the organised folders.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { classify } = require('./classifier');
const { extractActionItems, URGENT_RE } = require('./actions');

const NOREPLY_RE = /no-?reply|do-?not-?reply|notifications?@|mailer-daemon|newsletter|marketing@|news@/i;
const ASK_RE = /\?|\b(can you|could you|please|let me know|thoughts|would you|are you able|need your|waiting on|any update)\b/i;

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
  const needsReply = !isBulk && !NOREPLY_RE.test(from) && ASK_RE.test(`${subject}\n${text.slice(0, 1500)}`);
  return {
    category,
    company: c.company,
    docType: c.docType,
    needsReply,
    urgent: URGENT_RE.test(`${subject} ${text.slice(0, 2000)}`),
    actionItems: isBulk ? [] : extractActionItems(text.slice(0, 4000), { source: 'email' }),
  };
}

/** Fetch recent messages and sort them. Returns lightweight summaries (no full bodies kept). */
async function fetchAndSort(cfg, settings, { limit = 150, onAttachment = null } = {}) {
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

module.exports = { fetchAndSort, categorise };
