// Riyeser PDF "Ask someone to sign": the sender's side, talking to Riyeser Online (the Riyeser Link Supabase project)
// with the Riyeser account signed in on this PC (core/online.js, the same sign-in as Riyeser Central and Link Office).
//   send:     sign_request_create (a draft and its upload path) -> the PDF to the private "sign-docs" bucket ->
//             sign_request_send (its SHA-256; the database emails each signer their own link)
//   list:     sign_requests_mine; remind / cancel / keep / history; download the signed copy (checked against its
//             recorded SHA-256); delete the files now (Storage, then sign_request_forget)
// Only the sender can do any of this (the database checks), and Riyeser HQ can't read the files.
// Electronic signature with an audit trail: no claim of meeting any particular country's e-signature law.
const crypto = require('crypto');

const BUCKET = 'sign-docs';
const KINDS = ['signature', 'initials', 'date', 'name', 'text'];
const KEEP_CHOICES = [[30, '30 days'], [90, '90 days'], [365, '1 year'], [730, '2 years']];
const EMAIL_RE = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;
const sha256 = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/** What's wrong with a request before it's sent ('' when it's fine). The database checks the same again. */
function problem({ title, signers, fields, pages, expires, keep, maxSigners = 10, now = Date.now() }) {
  if (!String(title || '').trim()) return 'Give the document a name.';
  if (String(title).trim().length > 120) return 'Keep the document\'s name under 120 characters.';
  if (!Array.isArray(signers) || !signers.length) return 'Add at least one person to sign.';
  if (signers.length > maxSigners) return `Up to ${maxSigners} people can sign one document.`;
  const seen = new Set();
  for (const s of signers) {
    const name = String(s.name || '').trim(); const email = String(s.email || '').trim().toLowerCase();
    if (!name) return 'Type each signer\'s name.';
    if (name.length > 80) return 'Keep each name under 80 characters.';
    if (!EMAIL_RE.test(email)) return `Check the email address for ${name}.`;
    if (seen.has(email)) return 'Each signer needs their own email address.';
    seen.add(email);
  }
  if (!Array.isArray(fields) || !fields.length) return 'Place at least one field for each signer.';
  for (let i = 1; i <= signers.length; i++) {
    if (!fields.some((f) => f.signer === i)) return `Place at least one field for ${String(signers[i - 1].name).trim()}.`;
  }
  for (const f of fields) {
    if (!KINDS.includes(f.kind) || !(f.page >= 1 && f.page <= pages) || !(f.w > 0 && f.h > 0) || f.x < 0 || f.y < 0 || f.x + f.w > 1.001 || f.y + f.h > 1.001) {
      return 'One of the fields isn\'t right. Place it on the page again.';
    }
  }
  if (expires) {
    const t = new Date(expires).getTime();
    if (!(t > now + 3600e3) || t > now + 366 * 86400e3) return 'Choose an end date between tomorrow and a year from now.';
  }
  if (keep != null && !KEEP_CHOICES.some(([d]) => d === keep)) return 'Choose how long to keep the files.';
  return '';
}

/**
 * The status the sender sees for one request: Sent / Viewed / Signed / Declined / Expired / Cancelled, plus
 * "Finishing" for the moment between the last signature and the signed copy being ready.
 */
function statusOf(r) {
  const signers = Array.isArray(r.signers) ? r.signers : [];
  const signed = signers.filter((s) => s.status === 'signed').length;
  const of = signers.length > 1 ? ` (${signed} of ${signers.length} signed)` : '';
  if (r.status === 'completed') return { key: 'signed', label: 'Signed', tone: 'good', detail: 'Everyone has signed.' };
  if (r.status === 'declined') { const d = signers.find((s) => s.status === 'declined'); return { key: 'declined', label: 'Declined', tone: 'bad', detail: d ? `${d.name} declined${d.decline_reason ? `: “${d.decline_reason}”` : '.'}` : 'Declined.' }; }
  if (r.status === 'expired') return { key: 'expired', label: 'Expired', tone: 'muted', detail: `The links stopped working${of}.` };
  if (r.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled', tone: 'muted', detail: `You cancelled it${of}.` };
  if (signers.length && signed === signers.length) return { key: 'finishing', label: 'Finishing', tone: 'warn', detail: 'Everyone has signed. The signed copy is being made.' };
  if (signers.some((s) => s.status === 'viewed' || s.status === 'signed')) return { key: 'viewed', label: 'Viewed', tone: 'accent', detail: `Opened${of}.` };
  return { key: 'sent', label: 'Sent', tone: 'accent', detail: `Waiting for ${signers.length === 1 ? 'them' : 'everyone'} to open it.` };
}

/** "Kept until 28 Nov 2027" / "Kept for 1 year after it finishes" / "Deleted". */
function keepText(r, locale = 'en-AU') {
  const label = (KEEP_CHOICES.find(([d]) => d === r.keep_days) || [0, `${r.keep_days} days`])[1];
  if (r.files_deleted_at) return 'Files deleted';
  if (r.files_delete_at) return `Files kept until ${new Date(r.files_delete_at).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return `Files kept for ${label} after it finishes`;
}

/** What changed since the last look, for a desktop notification: [{ id, title, text }]. */
function changes(before, now) {
  const old = new Map((before || []).map((r) => [r.id, r]));
  const out = [];
  for (const r of now || []) {
    const p = old.get(r.id); if (!p) continue;
    const a = statusOf(p).key; const b = statusOf(r).key;
    if (a !== b && ['signed', 'declined', 'expired'].includes(b)) {
      out.push({ id: r.id, title: b === 'signed' ? 'Signed by everyone' : b === 'declined' ? 'Signing declined' : 'Signing request expired', text: `“${r.title}”: ${statusOf(r).detail}` });
      continue;
    }
    for (const s of r.signers || []) {
      const ps = (p.signers || []).find((x) => x.position === s.position);
      if (ps && ps.status !== 'signed' && s.status === 'signed' && b !== 'signed') out.push({ id: r.id, title: 'Signed', text: `${s.name} signed “${r.title}”.` });
    }
  }
  return out;
}

class SignClient {
  /** clients: () => [Online…] in the order to try (this app's own sign-in first, then Riyeser Central's, read only). */
  constructor({ clients, own }) { this.clients = clients; this.own = own; }
  /** The first client with a sign-in. */
  online() {
    const c = (this.clients() || []).find((x) => x && x.session);
    if (!c) { const e = new Error('Sign in to your Riyeser account first.'); e.signIn = true; throw e; }
    return c;
  }
  async rpc(name, args) {
    const c = this.online();
    try { return await c.rpc(name, args); } catch (e) {
      if (/PGRST202|Could not find the function|schema cache/i.test(e.message) || e.status === 404) throw new Error('Ask someone to sign is still being switched on at Riyeser. Try again later.');
      throw e;
    }
  }
  /** { signedIn, email, businesses: [{ workspace_id, name }] } */
  async status() {
    const c = (this.clients() || []).find((x) => x && x.session);
    if (!c) return { signedIn: false, email: this.own && this.own.lastEmail ? this.own.lastEmail() : '' };
    let businesses = [];
    try { businesses = await c.myBusinesses(); } catch (e) { if (e.status === 401) return { signedIn: false, email: c.session.user && c.session.user.email }; throw e; }
    return { signedIn: true, email: c.session.user && c.session.user.email, viaCentral: c !== this.own, businesses: businesses.map((b) => ({ workspace_id: b.workspace_id, name: b.name })) };
  }
  settings() { return this.rpc('sign_settings', {}); }
  quota(ws) { return this.rpc('sign_quota', { ws }); }
  list(ws) { return this.rpc('sign_requests_mine', { ws }); }
  history(id) { return this.rpc('sign_request_history', { req: id }); }
  remind(id) { return this.rpc('sign_request_remind', { req: id }); }
  cancel(id) { return this.rpc('sign_request_cancel', { req: id }); }
  keep(id, days) { return this.rpc('sign_request_keep', { req: id, keep: days }); }

  /** Make the request, upload the PDF, send it. bytes: the PDF exactly as it is on disk; pages: its page count. */
  async send({ ws, bytes, pages, title, message, ordered, expires, keep, fields, signers }) {
    const why = problem({ title, signers, fields, pages, expires, keep });
    if (why) throw new Error(why);
    if (!bytes || !bytes.length) throw new Error('Open a saved PDF first.');
    const st = await this.settings().catch(() => ({ max_mb: 20 }));
    if (bytes.length > (st.max_mb || 20) * 1048576) throw new Error(`The PDF can be up to ${st.max_mb || 20} MB. Try Tools → Compress PDF first.`);
    const draft = await this.rpc('sign_request_create', { ws, title: String(title).trim(), note: String(message || '').trim() || null, ordered: !!ordered,
      expires: expires ? new Date(expires).toISOString() : null, keep: keep || null,
      fields: fields.map((f) => ({ id: f.id, kind: f.kind, signer: f.signer, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, ...(f.label ? { label: f.label } : {}) })),
      signers: signers.map((s) => ({ name: String(s.name).trim(), email: String(s.email).trim() })) });
    await this.upload(draft.path, bytes);
    return this.rpc('sign_request_send', { req: draft.id, sha256: sha256(bytes), bytes: bytes.length, pages });
  }
  async storage(method, path, { body, headers = {} } = {}) {
    const c = this.online(); const cfg = await c.config();
    const url = `${cfg.url}/storage/v1/object/${BUCKET}${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`;
    let r;
    try { r = await c.fetchFn(url, { method, headers: { apikey: cfg.key, Authorization: `Bearer ${await c.token()}`, ...headers }, body }); }
    catch { throw new Error('Can\'t reach Riyeser. Check your internet and try again.'); }
    return r;
  }
  async upload(path, bytes) {
    const r = await this.storage('POST', path, { body: Buffer.from(bytes), headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false' } });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(r.status === 413 || /size/i.test(t) ? 'The PDF is too big to send.' : 'The PDF couldn\'t be uploaded. Try again.'); }
  }
  /** The signed copy (or the original), checked against the SHA-256 Riyeser recorded. */
  async download(id, which = 'signed') {
    const f = await this.rpc('sign_request_file', { req: id });
    const path = f && f[which];
    if (!path) throw new Error(f && !f.original ? 'The files for this request have been deleted.' : 'The signed copy isn\'t ready yet.');
    const r = await this.storage('GET', path);
    if (!r.ok) throw new Error('The file couldn\'t be downloaded. Try again.');
    const bytes = Buffer.from(await r.arrayBuffer());
    const want = which === 'signed' ? f.signed_sha256 : f.original_sha256;
    if (want && sha256(bytes) !== want) throw new Error('The downloaded file doesn\'t match the fingerprint Riyeser recorded, so it wasn\'t saved. Try again, or contact Riyeser support.');
    return { bytes, sha256: want };
  }
  /** Delete the PDF and the signed copy now (the history of who signed stays). */
  async deleteFiles(id) {
    const f = await this.rpc('sign_request_file', { req: id });
    const paths = [f.original, f.signed].filter(Boolean);
    if (paths.length) {
      const r = await this.storage('DELETE', '', { body: JSON.stringify({ prefixes: paths }), headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) throw new Error('The files couldn\'t be deleted. Try again.');
    }
    await this.rpc('sign_request_forget', { req: id });
    return true;
  }
}

module.exports = { SignClient, problem, statusOf, keepText, changes, sha256, KEEP_CHOICES, KINDS, BUCKET };
