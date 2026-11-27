// "Report an issue" in Riyeser Central: the diagnostic details sent to Riyeser Support with a problem report.
//
// What's collected (and nothing else):
//   - which program it's about, and the version of it installed on this PC
//   - Riyeser Central's version, and every Riyeser program installed on this PC with its version (updates.js)
//   - the Windows version (e.g. "Windows 11 Pro (10.0.22631)")
//   - when the report was made
//   - the error message or code, if the person types one
//   - the last 200 lines (64 KB at most) of that program's technical log, if it has one Central can find
//     (Riyeser Link Office: %APPDATA%\Riyeser Link Office\logs\link.log; Desk Assistant: its smart-review.log).
//     For Accounting, Invoices, POS and Bookings: the end of online-api.log (next to the company file), where the
//     program notes what went wrong in online connections (with the OA-… reference it showed). For Riyeser Central:
//     the problems in its online-connections activity trail. Other programs don't keep a log Central can read yet.
// Never collected: invoices, payroll, customers, sales, bookings, files, chat messages, folder paths or the PC's user name.
// Before anything is shown or sent, emails are masked (x***@domain), long numbers (bank, tax and card numbers) are
// replaced, and anything after "password" (or "secret", "token", "api key") on a line is removed. Riyeser's database
// scrubs it again when it's saved. The person sees exactly what will be sent (preview) before sending it.
const path = require('path');
const fs = require('fs');

// The products Support knows (support_products() in team-chat.sql), with Central's program ids for each.
const PRODUCTS = [
  { id: 'central', name: 'Riyeser Central', apps: ['central'] },
  { id: 'accounting', name: 'Accounting', apps: ['accounting', 'accounting-basics'] },
  { id: 'invoices', name: 'Invoices', apps: ['invoices'] },
  { id: 'pos', name: 'POS', apps: ['pos'] },
  { id: 'bookings', name: 'Bookings', apps: ['bookings'] },
  { id: 'estimate', name: 'Estimate', apps: ['estimate'] },
  { id: 'payroll', name: 'Payroll', apps: ['payroll'] },
  { id: 'link', name: 'Riyeser Link', apps: ['team'] },
  { id: 'linkoffice', name: 'Riyeser Link Office', apps: ['linkoffice'] },
  { id: 'pdf', name: 'Riyeser PDF', apps: ['pdf'] },
  { id: 'desk', name: 'Desk Assistant', apps: ['desk'] },
  { id: 'website', name: 'riyeser.com', apps: [] },
  { id: 'other', name: 'Something else', apps: [] },
];
const MAX_LINES = 200;
const MAX_BYTES = 64 * 1024;

/** Mask personal details in technical text: emails, long digit runs, and anything after "password". */
function scrub(text) {
  return String(text == null ? '' : text)
    .replace(/([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2')
    .replace(/\b(password|passwd|pwd|secret|token|api[_ -]?key)\b.*$/gim, '$1 [removed]')
    .replace(/\b\d{4}(?:[ -]\d{4}){3}\b/g, '[number removed]')
    .replace(/\b\d{2,3}(?:[ -]\d{3}){2,}\b/g, '[number removed]')
    .replace(/\d{7,}/g, '[number removed]');
}

/** The last lines of a log: at most 200 lines and 64 KB, scrubbed. */
function tail(text, maxLines = MAX_LINES, maxBytes = MAX_BYTES) {
  let lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines = lines.slice(-maxLines).map(scrub);
  while (lines.length && Buffer.byteLength(lines.join('\n'), 'utf8') > maxBytes) lines.shift();
  return lines.join('\n');
}

/** Where each program keeps a log Central can read (none for most programs yet). */
function logFiles(product, env = process.env) {
  const appData = env.APPDATA || '';
  if (!appData) return [];
  if (product === 'linkoffice') return [{ file: path.join(appData, 'Riyeser Link Office', 'logs', 'link.log'), label: 'Riyeser Link Office log' }];
  if (product === 'desk') return [{ file: path.join(appData, 'Desk Assistant', 'smart-review.log'), label: 'Desk Assistant log' }];
  return [];
}

/** The program's recent log lines, or null when it has none. Reads only the end of a big file.
 * extra: more places for this product ({file, label} or {text, label}), e.g. online-api.log next to the company file. */
function readLog(product, { env = process.env, fsMod = fs, extra = [] } = {}) {
  for (const x of extra || []) if (x && typeof x.text === 'string' && x.text.trim()) { const lines = tail(x.text); if (lines) return { lines, source: x.label }; }
  for (const { file, label } of [...logFiles(product, env), ...(extra || []).filter((x) => x && x.file)]) {
    try {
      const st = fsMod.statSync(file);
      if (!st.isFile() || !st.size) continue;
      const want = Math.min(st.size, 256 * 1024);
      const fd = fsMod.openSync(file, 'r');
      const buf = Buffer.alloc(want);
      try { fsMod.readSync(fd, buf, 0, want, st.size - want); } finally { fsMod.closeSync(fd); }
      let text = buf.toString('utf8');
      if (want < st.size) text = text.slice(text.indexOf('\n') + 1);   // drop the cut-off first line
      const lines = tail(text);
      if (lines) return { lines, source: label };
    } catch { /* no log there: skip it */ }
  }
  return null;
}

/** "Windows 11 Pro (10.0.22631)". os.version() still says "Windows 10" on Windows 11, so the build number decides. */
function windowsName(version, release, platform = 'win32') {
  if (platform !== 'win32') return `${platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform}${release ? ` (${release})` : ''}`;
  const build = Number(String(release || '').split('.')[2]) || 0;
  let name = String(version || 'Windows').trim() || 'Windows';
  if (build >= 22000) name = name.replace(/Windows 10/i, 'Windows 11');
  return `${name}${release ? ` (${release})` : ''}`.slice(0, 120);
}

/**
 * The diagnostic details for one report: exactly what the preview shows and what's sent.
 * programs: {programId: version} installed on this PC; log: { lines, source } or null.
 */
function build({ product, programs = {}, centralVersion = '', osName = '', now = new Date(), log = null }) {
  const p = PRODUCTS.find((x) => x.id === product) || PRODUCTS.find((x) => x.id === 'other');
  const list = Object.entries(programs || {}).filter(([id]) => /^[a-z0-9-]{1,40}$/.test(id))
    .map(([id, version]) => ({ id, version: version == null ? null : String(version).slice(0, 40) })).sort((a, b) => a.id.localeCompare(b.id));
  const mine = p.apps.map((id) => programs && programs[id]).find(Boolean);
  return {
    product: p.id,
    product_version: mine ? String(mine).slice(0, 40) : null,
    central_version: centralVersion ? String(centralVersion).slice(0, 40) : null,
    os: osName ? String(osName).slice(0, 120) : null,
    programs: list,
    reported_at: new Date(now).toISOString(),
    log_lines: log && log.lines ? log.lines : null,
    log_source: log && log.lines ? log.source : null,
  };
}

/** What's sent: the diagnostic details unchanged, plus what the person typed (error text scrubbed). */
function payload(diag, form = {}) {
  const what = String(form.what_happened || '').trim();
  if (!what) throw new Error('Say what happened, then send it again.');
  if (form.blocked !== true && form.blocked !== false) throw new Error('Choose whether your work is blocked: Yes or No.');
  return { ...diag, source: 'central', what_happened: what.slice(0, 4000), blocked: form.blocked,
    error_text: form.error_text ? scrub(String(form.error_text).trim()).slice(0, 500) || null : null };
}

/** The preview rows (label, value) the dialog shows. Every field that's sent, nothing else. */
function preview(diag, names = {}) {
  const p = PRODUCTS.find((x) => x.id === diag.product);
  return [
    ['Program', p ? p.name : diag.product],
    ['Its version', diag.product_version || 'Not installed on this PC'],
    ['Riyeser Central', diag.central_version || 'Not known'],
    ['Windows', diag.os || 'Not known'],
    ['When', diag.reported_at],
    ['Installed Riyeser programs', diag.programs.length ? diag.programs.map((x) => `${names[x.id] || x.id} ${x.version || '?'}`).join(', ') : 'None found'],
    ['Log lines', diag.log_lines ? `${diag.log_lines.split('\n').length} from the ${diag.log_source}` : 'None (this program has no log Central can read)'],
  ];
}

module.exports = { PRODUCTS, MAX_LINES, MAX_BYTES, scrub, tail, logFiles, readLog, windowsName, build, payload, preview };
