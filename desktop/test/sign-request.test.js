// Riyeser PDF "Ask someone to sign" (the sender's side): src/core/sign-client.js, src/sign-request-ipc.js and the
// window's helpers in src/renderer/sign-request.js, against a pretend Riyeser Online (no network).
//  - checks before sending (names, emails, a field for each signer, fields on the page, end date, keeping time)
//  - send: make the draft, upload the PDF exactly as on disk to <business>/<request>/original.pdf with the person's
//    sign-in, then send with its SHA-256 and page count; nothing is sent when something's wrong or the PDF is too big
//  - the statuses (Sent / Viewed / Signed / Declined / Expired / Cancelled / Finishing) and what changed (notifications)
//  - download: only when the file matches the SHA-256 Riyeser recorded; Delete files now: Storage, then the database
//  - signed in here, or through Riyeser Central's sign-in (read only); an older database says it's being switched on
//  - the IPC channels, the PDF read from disk, Save as for the signed copy; the window's field maths
//  - wording: "electronic signature with an audit trail", no claim about any e-signature law
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SignClient, problem, statusOf, keepText, changes, sha256 } = require('../src/core/sign-client');

const WS = '6a1b2c3d-0000-4000-8000-000000000001';
const REQ = '0d6c3f0e-1111-4c2b-9d1e-222233334444';
const PDF = Buffer.from('%PDF-1.7\n% synthetic test file\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const good = () => ({ title: 'Service agreement', pages: 2, expires: new Date(Date.now() + 5 * 86400e3).toISOString(), keep: 365,
  signers: [{ name: 'Pat Client', email: 'pat@client.test' }, { name: 'Jo Witness', email: 'jo@witness.test' }],
  fields: [{ id: 'f1', kind: 'signature', signer: 1, page: 1, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }, { id: 'f2', kind: 'date', signer: 2, page: 2, x: 0.5, y: 0.5, w: 0.2, h: 0.04 }] });

/** A pretend Online: records rpc calls and storage requests. */
function fakeOnline(o = {}) {
  const calls = []; const http = [];
  const on = {
    session: o.signedOut ? null : { access_token: 'tok', user: { id: 'u1', email: 'owner@a.test' } },
    lastEmail: () => 'owner@a.test',
    config: async () => ({ url: 'https://x.supabase.co', key: 'pk' }),
    token: async () => 'tok',
    myBusinesses: async () => [{ workspace_id: WS, name: 'Sample Plumbing', role: 'owner' }],
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (o.missing) { const e = new Error('Could not find the function public.sign_settings in the schema cache (PGRST202)'); e.status = 404; throw e; }
      if (name === 'sign_settings') return { max_mb: o.maxMb || 20, expiry_days: 30, keep_days: 365, max_signers: 10 };
      if (name === 'sign_request_create') return { id: REQ, path: `${WS}/${REQ}/original.pdf`, bucket: 'sign-docs' };
      if (name === 'sign_request_send') return { id: REQ, status: 'sent' };
      if (name === 'sign_request_file') return o.file || { bucket: 'sign-docs', original: `${WS}/${REQ}/original.pdf`, signed: `${WS}/${REQ}/signed.pdf`, signed_sha256: sha256(PDF), original_sha256: sha256(PDF) };
      if (name === 'sign_request_forget') return null;
      return null;
    },
    fetchFn: async (url, init) => { http.push({ url, init }); return o.http ? o.http(url, init) : new Response(PDF, { status: 200 }); },
  };
  return { on, calls, http };
}

test('checks before sending', () => {
  assert.strictEqual(problem(good()), '');
  const t = (patch) => problem({ ...good(), ...patch });
  assert.match(t({ title: ' ' }), /Give the document a name/);
  assert.match(t({ signers: [] }), /Add at least one person/);
  assert.match(t({ signers: [{ name: 'Pat', email: 'pat@client' }, good().signers[1]] }), /Check the email address for Pat/);
  assert.match(t({ signers: [{ name: 'Pat', email: 'a@b.test' }, { name: 'Jo', email: 'A@B.test' }] }), /their own email/);
  assert.match(t({ fields: [good().fields[0]] }), /Place at least one field for Jo Witness/);
  assert.match(t({ fields: [...good().fields, { id: 'f3', kind: 'signature', signer: 1, page: 3, x: 0, y: 0, w: 0.1, h: 0.1 }] }), /isn't right/);
  assert.match(t({ fields: [...good().fields, { id: 'f3', kind: 'signature', signer: 1, page: 1, x: 0.95, y: 0, w: 0.1, h: 0.1 }] }), /isn't right/);
  assert.match(t({ expires: new Date(Date.now() + 400 * 86400e3).toISOString() }), /end date/);
  assert.match(t({ keep: 12 }), /how long to keep/);
  assert.match(problem({ ...good(), signers: Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, email: `p${i}@x.test` })) }), /Up to 10 people/);
});

test('send: draft, the PDF uploaded with the sign-in to its own path, then sent with its SHA-256', async () => {
  const f = fakeOnline({ http: () => new Response('{}', { status: 200 }) });
  const c = new SignClient({ clients: () => [f.on], own: f.on });
  const r = await c.send({ ws: WS, bytes: PDF, message: 'Please sign by Friday.', ordered: true, ...good() });
  assert.deepStrictEqual(r, { id: REQ, status: 'sent' });
  assert.deepStrictEqual(f.calls.map((x) => x.name), ['sign_settings', 'sign_request_create', 'sign_request_send']);
  const made = f.calls[1].args;
  assert.strictEqual(made.ws, WS); assert.strictEqual(made.ordered, true); assert.strictEqual(made.note, 'Please sign by Friday.'); assert.strictEqual(made.keep, 365);
  assert.deepStrictEqual(made.signers, good().signers);
  assert.deepStrictEqual(Object.keys(made.fields[0]).sort(), ['h', 'id', 'kind', 'page', 'signer', 'w', 'x', 'y']);
  assert.strictEqual(f.http.length, 1);
  assert.strictEqual(f.http[0].url, `https://x.supabase.co/storage/v1/object/sign-docs/${WS}/${REQ}/original.pdf`);
  assert.strictEqual(f.http[0].init.method, 'POST');
  assert.strictEqual(f.http[0].init.headers.Authorization, 'Bearer tok');
  assert.strictEqual(f.http[0].init.headers['Content-Type'], 'application/pdf');
  assert.strictEqual(f.http[0].init.headers['x-upsert'], 'false', 'never overwrites');
  assert.ok(Buffer.from(f.http[0].init.body).equals(PDF), 'exactly the bytes from disk');
  assert.deepStrictEqual(f.calls[2].args, { req: REQ, sha256: crypto.createHash('sha256').update(PDF).digest('hex'), bytes: PDF.length, pages: 2 });
});

test('send: nothing happens when something is wrong, the PDF is too big, or the upload fails', async () => {
  const f = fakeOnline();
  const c = new SignClient({ clients: () => [f.on], own: f.on });
  await assert.rejects(c.send({ ws: WS, bytes: PDF, ...good(), title: '' }), /Give the document a name/);
  assert.strictEqual(f.calls.length, 0);
  const big = fakeOnline({ maxMb: 0.00001 });
  await assert.rejects(new SignClient({ clients: () => [big.on] }).send({ ws: WS, bytes: PDF, ...good() }), /can be up to/);
  assert.deepStrictEqual(big.calls.map((x) => x.name), ['sign_settings']);
  const bad = fakeOnline({ http: () => new Response('nope', { status: 403 }) });
  await assert.rejects(new SignClient({ clients: () => [bad.on] }).send({ ws: WS, bytes: PDF, ...good() }), /couldn't be uploaded/);
  assert.ok(!bad.calls.some((x) => x.name === 'sign_request_send'), 'not sent when the upload failed');
});

test('statuses the sender sees', () => {
  const s = (status, list) => statusOf({ status, signers: list.map((st, i) => ({ position: i + 1, name: `P${i + 1}`, status: st })) });
  assert.strictEqual(s('sent', ['sent', 'waiting']).label, 'Sent');
  assert.strictEqual(s('sent', ['viewed', 'waiting']).label, 'Viewed');
  assert.strictEqual(s('sent', ['signed', 'sent']).detail, 'Opened (1 of 2 signed).');
  assert.strictEqual(s('sent', ['signed', 'signed']).label, 'Finishing');
  assert.strictEqual(s('completed', ['signed', 'signed']).label, 'Signed');
  assert.strictEqual(s('expired', ['signed', 'sent']).label, 'Expired');
  assert.strictEqual(s('cancelled', ['sent']).label, 'Cancelled');
  const d = statusOf({ status: 'declined', signers: [{ position: 1, name: 'Pat', status: 'declined', decline_reason: 'Wrong price' }] });
  assert.deepStrictEqual([d.label, d.detail], ['Declined', 'Pat declined: “Wrong price”']);
  assert.match(keepText({ keep_days: 365 }), /Files kept for 1 year after it finishes/);
  assert.match(keepText({ keep_days: 90, files_delete_at: '2027-02-26T00:00:00Z' }), /Files kept until 26 Feb 2027/);
  assert.strictEqual(keepText({ keep_days: 90, files_deleted_at: '2027-01-01T00:00:00Z' }), 'Files deleted');
});

test('what changed, for desktop notifications', () => {
  const r = (status, a, b) => ({ id: REQ, title: 'Lease', status, signers: [{ position: 1, name: 'Pat', status: a }, { position: 2, name: 'Jo', status: b }] });
  assert.deepStrictEqual(changes([r('sent', 'viewed', 'waiting')], [r('sent', 'signed', 'sent')]), [{ id: REQ, title: 'Signed', text: 'Pat signed “Lease”.' }]);
  assert.strictEqual(changes([r('sent', 'signed', 'viewed')], [r('completed', 'signed', 'signed')])[0].title, 'Signed by everyone');
  assert.strictEqual(changes([r('sent', 'signed', 'viewed')], [r('declined', 'signed', 'declined')])[0].title, 'Signing declined');
  assert.deepStrictEqual(changes([r('sent', 'sent', 'waiting')], [r('sent', 'viewed', 'waiting')]), [], 'opening it is shown in the list, not as a pop-up');
  assert.deepStrictEqual(changes([], [r('sent', 'signed', 'sent')]), [], 'nothing for requests not seen before');
});

test('download: only a file that matches its recorded SHA-256', async () => {
  const f = fakeOnline();
  const c = new SignClient({ clients: () => [f.on] });
  const d = await c.download(REQ);
  assert.ok(d.bytes.equals(PDF));
  assert.strictEqual(f.http[0].url, `https://x.supabase.co/storage/v1/object/sign-docs/${WS}/${REQ}/signed.pdf`);
  assert.strictEqual(f.http[0].init.headers.Authorization, 'Bearer tok');
  const wrong = fakeOnline({ file: { original: 'a', signed: `${WS}/${REQ}/signed.pdf`, signed_sha256: 'f'.repeat(64) } });
  await assert.rejects(new SignClient({ clients: () => [wrong.on] }).download(REQ), /doesn't match the fingerprint/);
  const notYet = fakeOnline({ file: { original: 'a', signed: null } });
  await assert.rejects(new SignClient({ clients: () => [notYet.on] }).download(REQ), /isn't ready yet/);
  const gone = fakeOnline({ file: { original: null, signed: null } });
  await assert.rejects(new SignClient({ clients: () => [gone.on] }).download(REQ), /have been deleted/);
});

test('Delete files now: both files from Storage, then the database is told', async () => {
  const f = fakeOnline({ http: () => new Response('[]', { status: 200 }) });
  await new SignClient({ clients: () => [f.on] }).deleteFiles(REQ);
  assert.strictEqual(f.http[0].init.method, 'DELETE');
  assert.strictEqual(f.http[0].url, 'https://x.supabase.co/storage/v1/object/sign-docs');
  assert.deepStrictEqual(JSON.parse(f.http[0].init.body), { prefixes: [`${WS}/${REQ}/original.pdf`, `${WS}/${REQ}/signed.pdf`] });
  assert.deepStrictEqual(f.calls.map((x) => x.name), ['sign_request_file', 'sign_request_forget']);
  const fail = fakeOnline({ http: () => new Response('no', { status: 500 }) });
  await assert.rejects(new SignClient({ clients: () => [fail.on] }).deleteFiles(REQ), /couldn't be deleted/);
  assert.ok(!fail.calls.some((x) => x.name === 'sign_request_forget'));
});

test('signed in here, through Riyeser Central, or not at all; an older database', async () => {
  const out = fakeOnline({ signedOut: true }); const central = fakeOnline();
  assert.deepStrictEqual(await new SignClient({ clients: () => [out.on], own: out.on }).status(), { signedIn: false, email: 'owner@a.test' });
  const st = await new SignClient({ clients: () => [out.on, central.on], own: out.on }).status();
  assert.strictEqual(st.signedIn, true); assert.strictEqual(st.viaCentral, true);
  assert.deepStrictEqual(st.businesses, [{ workspace_id: WS, name: 'Sample Plumbing' }]);
  await assert.rejects(new SignClient({ clients: () => [out.on] }).list(WS), /Sign in to your Riyeser account first/);
  await assert.rejects(new SignClient({ clients: () => [fakeOnline({ missing: true }).on] }).settings(), /still being switched on/);
});

test('the IPC channels: the PDF read from disk, the signed copy saved with Save as', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-ipc-'));
  const file = path.join(dir, 'Lease.pdf'); fs.writeFileSync(file, PDF);
  const handlers = {}; const opened = []; const http = [];
  const mem = {}; const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; return v; }, update: (k, d, fn) => { mem[k] = fn(k in mem ? mem[k] : d); return mem[k]; } };
  store.set('online', { session: { access_token: 'tok', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'owner@a.test' } } });
  store.set('online-config', { url: 'https://x.supabase.co', key: 'pk', at: Date.now() });
  const fetchFn = async (url, init) => {
    http.push({ url, init });
    const name = (/\/rpc\/(\w+)/.exec(url) || [])[1];
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (name === 'sign_settings') return json({ max_mb: 20 });
    if (name === 'sign_request_create') return json({ id: REQ, path: `${WS}/${REQ}/original.pdf` });
    if (name === 'sign_request_send') return json({ id: REQ, status: 'sent' });
    if (name === 'sign_request_file') return json({ signed: `${WS}/${REQ}/signed.pdf`, original: 'x', signed_sha256: sha256(PDF) });
    if (name === 'sign_requests_mine') return json([{ id: REQ, title: 'Lease', status: 'sent', keep_days: 365, signers: [{ position: 1, name: 'Pat', status: 'viewed' }] }]);
    if (/storage/.test(url)) return init.method === 'GET' ? new Response(PDF) : json({});
    return json(null);
  };
  const created = [];
  const electron = { app: { getPath: (k) => (k === 'appData' ? path.join(dir, 'appdata') : dir), on: (ev, fn) => created.push(ev) },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, Notification: { isSupported: () => false },
    dialog: { showSaveDialog: async (_w, o) => ({ canceled: false, filePath: path.join(dir, path.basename(o.defaultPath)) }) } };
  const { registerSignRequest } = require('../src/sign-request-ipc');
  registerSignRequest({ handle: (n, fn) => { handlers[n] = fn; }, store, electron, openEditor: (f) => opened.push(f), fetchFn });
  for (const ch of ['status', 'signIn', 'code', 'signOut', 'forgot', 'choose', 'settings', 'quota', 'list', 'history', 'remind', 'cancel', 'keep', 'deleteFiles', 'send', 'download']) {
    assert.ok(handlers[`signreq:${ch}`], `signreq:${ch}`);
  }
  assert.deepStrictEqual(created, ['browser-window-created'], 'loads the window part into editors with no hook');
  await assert.rejects(handlers['signreq:send']({ file: path.join(dir, 'missing.pdf'), ...good() }), /Save the PDF first/);
  await handlers['signreq:choose'](WS);
  const r = await handlers['signreq:send']({ file, ...good() });
  assert.strictEqual(r.status, 'sent');
  const up = http.find((h) => /storage\/v1\/object\/sign-docs\//.test(h.url));
  assert.ok(Buffer.from(up.init.body).equals(PDF), 'the file on disk is what is uploaded');
  assert.strictEqual(JSON.parse(http.find((h) => /sign_request_create/.test(h.url)).init.body).ws, WS, 'from the chosen business');
  const list = await handlers['signreq:list'](WS);
  assert.strictEqual(list[0]._status.label, 'Viewed'); assert.match(list[0]._keep, /1 year/);
  const saved = await handlers['signreq:download'](REQ, 'Lease: final/v2');
  assert.strictEqual(path.basename(saved), 'Lease  final v2 (signed).pdf');
  assert.ok(fs.readFileSync(saved).equals(PDF)); assert.deepStrictEqual(opened, [saved], 'and opened in Riyeser PDF');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the window: field maths and steps', async () => {
  const m = await import('../src/renderer/sign-request.js');
  assert.deepStrictEqual(m.placeAt('signature', 0.5, 0.5, 1, 'f1'), { id: 'f1', kind: 'signature', signer: 1, x: 0.36, y: 0.47, w: 0.28, h: 0.06 });
  const edge = m.placeAt('signature', 0.99, 0.99, 2, 'f2');
  assert.ok(edge.x + edge.w <= 1 && edge.y + edge.h <= 1, 'a field clicked at the edge stays on the page');
  assert.deepStrictEqual(m.moved({ x: 0.9, y: 0.1, w: 0.2, h: 0.1 }, 0.5, -0.5), { x: 0.8, y: 0, w: 0.2, h: 0.1 });
  assert.deepStrictEqual(m.resized({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, 0.6, -0.5), { x: 0.5, y: 0.5, w: 0.5, h: 0.015 });
  assert.strictEqual(m.titleFrom('C:\\Users\\Sam\\Documents\\Service agreement.PDF'), 'Service agreement');
  assert.strictEqual(m.dayFromNow(30, new Date(2026, 10, 28)), '2026-12-28');
  const s = { signers: [{ name: 'Pat', email: 'pat@x.test' }, { name: '', email: '' }], fields: [{ signer: 1 }], title: 'X' };
  assert.match(m.missing(1, s), /Place at least one field for signer 2/);
  s.fields.push({ signer: 2 });
  assert.strictEqual(m.missing(1, s), '');
  assert.match(m.missing(2, s), /Type the name of signer 2/);
  s.signers[1] = { name: 'Jo', email: 'PAT@x.test' };
  assert.match(m.missing(2, s), /their own email/);
  s.signers[1].email = 'jo@x.test'; s.title = ' ';
  assert.match(m.missing(3, s), /Give the document a name/);
  assert.deepStrictEqual(m.menuItems().map((x) => x.label), ['✉ Ask someone to sign…', '📋 Sent for signing']);
  assert.strictEqual(typeof m.init, 'function'); assert.strictEqual(m.default, m.init);
});

test('wording: an electronic signature with an audit trail, and no claim about any law', () => {
  const src = ['src/renderer/sign-request.js', 'src/core/sign-client.js', 'src/sign-request-ipc.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.match(src, /electronic signature with an audit trail/);
  assert.doesNotMatch(src, /ESIGN|eIDAS|UETA|legally binding|compliant|complies with/i);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'pdf-main.js'), 'utf8'), /registerSignRequest/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'editor.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]*sign-request|<link[^>]*sign-request/, 'the editor loads it only through its Sign menu hook');
});

// A very small pretend window: enough for init() and the first screen of open().
function fakeWindow(extra = {}) {
  const made = [];
  const el = (tag) => { const e = { tag, attrs: {}, children: [], hidden: false, setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); made.push(c); }, after(c) { made.push(c); }, remove() {}, querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {} } }; return e; };
  const document = { head: el('head'), body: el('body'), querySelector: () => null, querySelectorAll: () => [], createElement: el, addEventListener() {} };
  const calls = [];
  const window = { api: { call: async (...a) => { calls.push(a); throw new Error('No handler for signreq:status'); }, on() {} }, ...extra };
  return { window, document, calls, made };
}
async function freshModule(fake) {
  globalThis.window = fake.window; globalThis.document = fake.document;
  try { return await import(`../src/renderer/sign-request.js?t=${Math.random()}`); } finally { /* globals removed by the caller */ }
}
const clearFake = () => { delete globalThis.window; delete globalThis.document; };

test('the Sign menu hook: askToSign(ctx) and isAvailable(), no buttons of its own', async (t) => {
  t.after(clearFake);
  // Riyeser PDF: no shared account question, so this module's own sign-in (it asks the main process who is signed in)
  const pdf = fakeWindow({ __signMenuHook: true, __editor: { st: { file: 'C:\\Docs\\Lease.pdf', dirty: false } } });
  const m = await freshModule(pdf);
  assert.strictEqual(m.isAvailable(), true, 'the entry is always offered; the account is asked for when it is chosen');
  const toasts = [];
  assert.strictEqual(await m.askToSign({ file: null, toast: (x) => toasts.push(x) }), false);
  assert.strictEqual(await m.askToSign({ file: 'x.pdf', dirty: true, toast: (x) => toasts.push(x) }), false);
  assert.match(toasts.join(' | '), /Save this PDF first.*Save your changes first/);
  assert.strictEqual(pdf.calls.length, 0, 'nothing asked online before it can go ahead');
  assert.strictEqual(await m.askToSign({ file: 'C:\\Docs\\Lease.pdf', dirty: false, toast: (x) => toasts.push(x) }), true);
  assert.deepStrictEqual(pdf.calls[0], ['signreq:status'], 'Riyeser PDF: its own sign-in check');
  assert.ok(pdf.window.__signRequestLoaded && pdf.window.RiyeserSignRequest.askToSign, 'set up once');
  assert.ok(!pdf.made.some((e) => ['sr-askbtn', 'sr-menuitem', 'sr-menuhead'].includes(e.id)), 'no extra buttons next to Sign or in Tools');

  // Riyeser Central: its shared account question is used
  const asked = [];
  const central = fakeWindow({ __signMenuHook: true, RiyeserCompany: { needAccount: async (what, o) => { asked.push([what, typeof o.then]); return false; } } });
  const m2 = await freshModule(central);
  assert.strictEqual(await m2.askToSign({ file: 'Lease.pdf', dirty: false }), false, 'Not now: nothing else happens');
  assert.deepStrictEqual(asked, [['sign', 'function']]);
  assert.strictEqual(central.calls.length, 0, 'the flow starts only once there is an account (needAccount runs then())');
});
