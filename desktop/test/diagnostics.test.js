// Get help → Report an issue: the diagnostic details Riyeser Central sends. Scrubbed, capped, and the preview is
// exactly what's sent (plus what the person typed in the same dialog).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dg = require('../src/central/diagnostics');
const on = require('../src/core/online');
const { Store } = require('../src/core/store');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));

test('diagnostics: emails, long numbers and passwords are masked; versions, dates and times are kept', () => {
  const s = dg.scrub([
    '10:00:01 export started for jo.bloggs@sample.test',
    '10:00:02 bank account 123456789 checked, card 4111 1111 1111 1111',
    '10:00:03 tax number 12 345 678 901 ok',
    '10:00:04 Password: hunter2 sent',
    '10:00:05 api_key=sk-abc token=xyz',
    '10:00:06 version 2.8.1 on 2026-11-24 at 192.168.1.20',
  ].join('\n'));
  assert.match(s, /j\*\*\*@sample\.test/); assert.doesNotMatch(s, /jo\.bloggs/);
  assert.doesNotMatch(s, /123456789|4111|12 345 678 901|hunter2|sk-abc|xyz/);
  assert.match(s, /Password \[removed\]/); assert.match(s, /api_key \[removed\]/);
  assert.match(s, /version 2\.8\.1 on 2026-11-24 at 192\.168\.1\.20/);
  assert.match(s, /^10:00:01 /m);   // log times stay
  assert.equal(dg.scrub(null), '');
});

test('diagnostics: at most the last 200 lines and 64 KB', () => {
  const many = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n';
  const t = dg.tail(many);
  assert.equal(t.split('\n').length, 200); assert.ok(t.startsWith('line 301\n')); assert.ok(t.endsWith('line 500'));
  const wide = Array.from({ length: 200 }, () => 'x'.repeat(1000)).join('\n');
  assert.ok(Buffer.byteLength(dg.tail(wide)) <= 64 * 1024);
});

test('diagnostics: the Link Office log is found; programs without a log are skipped', () => {
  const dir = tmp(); const env = { APPDATA: dir };
  assert.deepEqual(dg.logFiles('linkoffice', env).map((x) => path.relative(dir, x.file)), [path.join('Riyeser Link Office', 'logs', 'link.log')]);
  assert.equal(dg.readLog('linkoffice', { env }), null);              // not there yet: nothing, no error
  assert.equal(dg.readLog('payroll', { env }), null);                 // no log Central can read
  assert.deepEqual(dg.logFiles('pos', {}), []);
  const f = path.join(dir, 'Riyeser Link Office', 'logs', 'link.log'); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Array.from({ length: 300 }, (_, i) => `2026-11-24T10:00:${String(i % 60).padStart(2, '0')}Z INFO phone 10${i % 9} registered (owner sam@sample.test)`).join('\n') + '\n');
  const log = dg.readLog('linkoffice', { env });
  assert.equal(log.source, 'Riyeser Link Office log'); assert.equal(log.lines.split('\n').length, 200);
  assert.doesNotMatch(log.lines, /sam@sample/); assert.match(log.lines, /s\*\*\*@sample\.test/);
});

test('diagnostics: Windows 11 is named from its build number', () => {
  assert.equal(dg.windowsName('Windows 10 Pro', '10.0.22631'), 'Windows 11 Pro (10.0.22631)');
  assert.equal(dg.windowsName('Windows 10 Home', '10.0.19045'), 'Windows 10 Home (10.0.19045)');
  assert.equal(dg.windowsName('', '6.8.0', 'linux'), 'Linux (6.8.0)');
});

test('diagnostics: the preview is exactly what is sent', () => {
  const log = { lines: dg.tail('a\nb password=x\nc'), source: 'Riyeser Link Office log' };
  const programs = { central: '1.8.3', linkoffice: '1.1.1', payroll: '2.8.1', 'Bad Id': '9' };
  const diag = dg.build({ product: 'linkoffice', programs, centralVersion: '1.8.3', osName: 'Windows 11 Pro (10.0.22631)', now: new Date('2026-11-24T05:00:00Z'), log });
  assert.deepEqual(Object.keys(diag).sort(), ['central_version', 'log_lines', 'log_source', 'os', 'product', 'product_version', 'programs', 'reported_at']);
  assert.equal(diag.product_version, '1.1.1');
  assert.deepEqual(diag.programs, [{ id: 'central', version: '1.8.3' }, { id: 'linkoffice', version: '1.1.1' }, { id: 'payroll', version: '2.8.1' }]);
  const rows = Object.fromEntries(dg.preview(diag, { linkoffice: 'Riyeser Link Office', central: 'Riyeser Central', payroll: 'Riyeser Payroll' }));
  assert.equal(rows.Program, 'Riyeser Link Office'); assert.equal(rows['Its version'], '1.1.1'); assert.equal(rows['Riyeser Central'], '1.8.3');
  assert.equal(rows.Windows, 'Windows 11 Pro (10.0.22631)'); assert.equal(rows.When, '2026-11-24T05:00:00.000Z');
  assert.equal(rows['Installed Riyeser programs'], 'Riyeser Central 1.8.3, Riyeser Link Office 1.1.1, Riyeser Payroll 2.8.1');
  assert.equal(rows['Log lines'], '3 from the Riyeser Link Office log');
  const sent = dg.payload(diag, { what_happened: '  Desk phones stopped ringing  ', blocked: true, error_text: 'SIP 503 for ops@sample.test' });
  for (const k of Object.keys(diag)) assert.deepEqual(sent[k], diag[k], `${k} is sent as previewed`);
  assert.deepEqual(Object.keys(sent).filter((k) => !(k in diag)).sort(), ['blocked', 'error_text', 'source', 'what_happened']);
  assert.equal(sent.what_happened, 'Desk phones stopped ringing'); assert.equal(sent.source, 'central'); assert.equal(sent.error_text, 'SIP 503 for o***@sample.test');
  assert.throws(() => dg.payload(diag, { what_happened: ' ', blocked: false }), /Say what happened/);
  assert.throws(() => dg.payload(diag, { what_happened: 'x' }), /work is blocked/);
  const none = dg.build({ product: 'pos', programs: {}, log: null });
  assert.equal(none.product_version, null); assert.equal(none.log_lines, null);
  assert.equal(dg.build({ product: 'spaceship' }).product, 'other');
});

test('diagnostics: sent with the signed-in account to support_report, or "Sign in … first"', async () => {
  const dir = tmp(); const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url); calls.push([u.pathname, opts.body ? JSON.parse(opts.body) : null, opts.headers || {}]);
    if (u.href.startsWith(on.CONFIG_URL)) return { ok: true, status: 200, text: async () => 'window.RIYESER_TEAM={supabaseUrl:"https://x.supabase.co",supabaseKey:"k"};' };
    if (u.pathname === '/auth/v1/token') return res(200, { access_token: 'tok', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: 'a@b.test' } });
    if (u.pathname === '/rest/v1/rpc/support_report') return res(200, { id: 't1', ref: 'T-10234', diag_ref: 'DG-4821' });
    return res(404, {});
  };
  const o = new on.Online({ store: new Store(path.join(dir, 'data')), fetchFn, appData: dir });
  const diag = dg.build({ product: 'payroll', programs: { payroll: '2.8.1' } });
  await assert.rejects(o.reportIssue(dg.payload(diag, { what_happened: 'x', blocked: false })), /Sign in with your Riyeser account first/);
  assert.equal(o.canReport(), false);
  await o.signIn('a@b.test', 'pw');
  on.writeCompany(dir, { mode: 'online', name: 'Sample Plumbing', workspace_id: 'w1', company_code: 'RIY-7K3M-Q2' });
  assert.equal(o.canReport(), true);
  const body = dg.payload(diag, { what_happened: 'Export times out', blocked: true });
  assert.deepEqual(await o.reportIssue(body), { id: 't1', ref: 'T-10234', diag_ref: 'DG-4821' });
  const c = calls.find((x) => x[0] === '/rest/v1/rpc/support_report');
  assert.deepEqual(c[1], { ws: 'w1', payload: body }); assert.equal(c[2].Authorization, 'Bearer tok');
});

test('Central: Report an issue uses in-page dialogs, never confirm() or alert()', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'central.js'), 'utf8');
  const part = src.slice(src.indexOf('async function reportIssue('), src.indexOf('window.RiyeserCentralReport'));
  assert.ok(part.length > 500);
  assert.doesNotMatch(part, /\b(confirm|alert|prompt)\(/);
  assert.match(part, /Sign in with your Riyeser account first/);
  assert.match(part, /Thanks — your request number is/);
});
