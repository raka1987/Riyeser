// "Message us": the customer's conversations with Riyeser, from inside Riyeser Central.
// Stored in the Riyeser server (Supabase tables conversations + messages). Row level security there means a customer
// only ever sees their own conversations, and never the staff's internal notes. Staff answer from the admin page.
const licence = require('./licence');

async function session(appData, { fetchFn = globalThis.fetch, c = licence.cloud(), box } = {}) {
  if (!licence.configured(c)) throw new Error('Messages are coming soon. For now, email info@riyeser.com.');
  const token = await licence.accessToken(appData, fetchFn, c, box);
  if (!token) throw new Error('Sign in first (Your plan), so we know who to answer.');
  const acc = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString() || '{}');
  const rest = (pathQ, opts = {}) => licence.call(fetchFn, c, `/rest/v1/${pathQ}`, { token, ...opts });
  return { rest, accountId: acc.sub };
}

/** Every conversation, newest first, with its messages: [{ id, subject, status, unread, messages: [{ body, fromStaff, at }] }] */
async function list(appData, opts = {}) {
  const { rest } = await session(appData, opts);
  const rows = await rest('conversations?select=id,subject,status,unread_customer,last_message_at,messages(id,body,from_staff,created_at)&order=last_message_at.desc&messages.order=id.asc', { method: 'GET' });
  return (rows || []).map((r) => ({ id: r.id, subject: r.subject, status: r.status, unread: !!r.unread_customer, at: r.last_message_at,
    messages: (r.messages || []).map((m) => ({ id: m.id, body: m.body, fromStaff: !!m.from_staff, at: m.created_at })) }));
}

/** Send a message: into an existing conversation, or start a new one (subject = the first line). */
async function send(appData, body, conversationId = null, opts = {}) {
  body = String(body || '').trim();
  if (!body) throw new Error('Type a message first.');
  if (body.length > 4000) throw new Error('That message is too long. Please keep it under 4,000 characters.');
  const { rest, accountId } = await session(appData, opts);
  let id = conversationId;
  if (!id) {
    const subject = body.split('\n')[0].slice(0, 80);
    const made = await rest('conversations', { body: { account_id: accountId, subject }, method: 'POST', prefer: true });
    id = Array.isArray(made) ? made[0].id : made.id;
  }
  await rest('messages', { body: { conversation_id: id, body } });
  return id;
}

/** Mark a conversation's answers as read. */
async function markRead(appData, conversationId, opts = {}) {
  const { rest } = await session(appData, opts);
  await rest(`conversations?id=eq.${encodeURIComponent(conversationId)}`, { method: 'PATCH', body: { unread_customer: false } });
  return true;
}

/** How many conversations have an answer not read yet (quietly 0 when signed out or offline). */
async function unread(appData, opts = {}) {
  try { return (await list(appData, opts)).filter((c) => c.unread).length; } catch { return 0; }
}

module.exports = { list, send, markRead, unread };
