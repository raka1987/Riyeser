const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const lic = require('../src/core/licence');
const chat = require('../src/core/chat');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const c = { url: 'https://test.supabase.co', anonKey: 'anon', passPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
const jwt = (sub) => `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.y`;

function server(log) {
  const convs = [];
  return async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null; log.push({ url: url.replace(c.url, ''), method: opts.method, body, prefer: opts.headers.Prefer });
    const ok = (data, status = 200) => ({ ok: true, status, json: async () => data });
    if (url.endsWith('/auth/v1/verify')) return ok({ access_token: jwt('acc-1'), refresh_token: 'rt', expires_in: 3600, user: { email: 'a@b.c' } });
    if (url.endsWith('/functions/v1/plan')) { const p = JSON.stringify({ v: 1, products: {}, issuedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 86400e3).toISOString() }); return ok({ pass: p, sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }); }
    if (url.includes('/rest/v1/conversations?select=')) return ok(convs);
    if (url.endsWith('/rest/v1/conversations') && opts.method === 'POST') { const r = { id: 'conv-1', ...body }; convs.push({ ...r, status: 'open', unread_customer: true, last_message_at: 'now', messages: [{ id: 1, body: 'hi', from_staff: true, created_at: 'now' }] }); return ok([r], 201); }
    if (url.endsWith('/rest/v1/messages')) return { ok: true, status: 201, json: async () => { throw new Error('empty'); } };
    if (url.includes('/rest/v1/conversations?id=eq.')) return ok([]);
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('chat: needs Riyeser accounts and a sign-in', async () => {
  const dir = tmp();
  await assert.rejects(chat.list(dir, { c: { url: '', anonKey: '', passPublicKey: '' } }), /coming soon/);
  await assert.rejects(chat.list(dir, { c, fetchFn: server([]) }), /Sign in first/);
  assert.equal(await chat.unread(dir, { c, fetchFn: server([]) }), 0);
});

test('chat: start a conversation, send, list and mark read', async () => {
  const dir = tmp(); const log = []; const fetchFn = server(log);
  await lic.finishSignIn(dir, 'a@b.c', '123456', { fetchFn, c });
  await assert.rejects(chat.send(dir, '   ', null, { fetchFn, c }), /Type a message/);
  const id = await chat.send(dir, 'Receipts won\'t print\nThe printer is an Epson.', null, { fetchFn, c });
  assert.equal(id, 'conv-1');
  const made = log.find((l) => l.url === '/rest/v1/conversations');
  assert.deepEqual(made.body, { account_id: 'acc-1', subject: "Receipts won't print" }); assert.equal(made.prefer, 'return=representation');
  assert.deepEqual(log.find((l) => l.url === '/rest/v1/messages').body, { conversation_id: 'conv-1', body: "Receipts won't print\nThe printer is an Epson." });
  const list = await chat.list(dir, { fetchFn, c });
  assert.equal(list[0].messages[0].fromStaff, true); assert.equal(await chat.unread(dir, { fetchFn, c }), 1);
  await chat.markRead(dir, 'conv-1', { fetchFn, c });
  assert.deepEqual(log.at(-1), { url: '/rest/v1/conversations?id=eq.conv-1', method: 'PATCH', body: { unread_customer: false }, prefer: undefined });
});
