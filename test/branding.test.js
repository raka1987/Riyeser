// Business details & branding on payslips: the logo, name and tax number, from Riyeser Central or Payroll's settings.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BR = require('../brand');
const { pdf, payslipPage } = require('../pdf');

// a made-up logo: a 200 x 100 coloured block in the middle of a 600 x 300 white picture
function logoPng(w = 600, h = 300, box = [200, 100, 400, 200], alpha = false) {
  const rgb = Buffer.alloc(w * h * 3, 255), a = alpha ? Buffer.alloc(w * h, 0) : null;
  for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) { const k = y * w + x; rgb[k * 3] = 232; rgb[k * 3 + 1] = 93; rgb[k * 3 + 2] = 74; if (a) a[k] = 255; }
  return BR.encodePng({ w, h, rgb, alpha: a });
}
const BRAND = { name: 'Coral Coast Bakehouse', legal_name: 'Coral Coast Holdings Ltd', tax_label: 'TIN', tax_number: '50-12345-0-1', tax_line: 'TIN 50-12345-0-1', address_lines: ['14 Beach Road', 'Suva'], contact_lines: ['+679 330 0000', 'pay@coral.example'] };

test('a PNG logo is trimmed to its picture, never stretched', () => {
  const lg = BR.processLogo(logoPng());
  assert.equal(lg.mime, 'image/png');
  assert.ok(lg.w >= 200 && lg.w <= 212 && lg.h >= 100 && lg.h <= 110, `${lg.w}x${lg.h}`);
  const t = BR.processLogo(logoPng(400, 400, [100, 150, 300, 250], true));   // transparent margins
  assert.ok(t.w <= 212 && t.h <= 110);
  const back = BR.decodePng(t.data);
  assert.equal(back.w, t.w); assert.ok(back.alpha);
  const f = BR.fit(lg, 170, 56);
  assert.ok(Math.abs(f.w / f.h - lg.w / lg.h) < 0.001 && f.w <= 170 && f.h <= 56);
});

test('bad logos are explained', () => {
  assert.throws(() => BR.processLogo(Buffer.alloc(0)), /Choose a picture/);
  assert.throws(() => BR.processLogo(Buffer.from('GIF89a........')), /isn't a PNG or JPG/);
  assert.throws(() => BR.processLogo(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(BR.MAX_LOGO)])), /under 2 MB/);
  assert.throws(() => BR.processLogo(logoPng(50, 50, [0, 0, 0, 0])), /empty/);
});

test('the payslip PDF carries the logo, the name and the tax number', () => {
  const logo = BR.processLogo(logoPng());
  const out = pdf([payslipPage({ brand: { ...BRAND, logo }, rows: [['Gross pay', 'FJ$500.00']], lines: ['Mere Tuilagi', 'Period: 1 - 7 Nov'] })]).toString('latin1');
  assert.match(out, /\/Subtype \/Image/);
  assert.match(out, /\/Im1 Do/);
  for (const t of ['Coral Coast Bakehouse', 'Coral Coast Holdings Ltd', 'TIN 50-12345-0-1', '14 Beach Road', 'Payslip', 'Mere Tuilagi', 'Produced with Riyeser Payroll']) assert.ok(out.includes(t), t);
  // no logo: a clean letterhead without an image
  const plain = pdf([payslipPage({ brand: BRAND, rows: [], lines: ['Mere'] })]).toString('latin1');
  assert.doesNotMatch(plain, /\/Subtype \/Image/);
  assert.ok(plain.includes('Coral Coast Bakehouse'));
  // a long name wraps instead of running off the page
  const long = pdf([payslipPage({ brand: { ...BRAND, name: 'The Extraordinarily Long-Named Coral Coast Artisan Sourdough Bakehouse and Pastry Kitchen' }, rows: [], lines: [] })]).toString('latin1');
  const { wrap } = require('../pdf'), name = 'The Extraordinarily Long-Named Coral Coast Artisan Sourdough Bakehouse and Pastry Kitchen';
  const lines = wrap(name, 14, true, 300);
  assert.ok(lines.length >= 2 && lines.join(' ') === name);
  for (const l of lines) assert.ok(long.includes(`(${l}) Tj`), l);
  assert.ok(!long.includes(`(${name}) Tj`));
});

test("Riyeser Central's company.json and logo come first; Payroll's own settings fill the gaps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-brand-'));
  const env = { APPDATA: dir };
  const own = { company_name: 'Own Name', address: 'Own address', phone: '111', company_tax_number: 'OWN-1', company_website: 'own.example' };
  let b = BR.brand(own, null, env);
  assert.equal(b.name, 'Own Name'); assert.equal(b.tax_line, 'Tax number OWN-1'); assert.equal(b.logo, null); assert.equal(b.from_central, false);
  fs.mkdirSync(path.join(dir, 'Riyeser'));
  fs.writeFileSync(path.join(dir, 'Riyeser', 'logo.png'), logoPng());
  fs.writeFileSync(path.join(dir, 'Riyeser', 'company.json'), JSON.stringify({ name: 'Coral Coast Bakehouse', country: 'FJ', tax_number: '50-12345-0-1', logo: path.join(dir, 'Riyeser', 'logo.png') }));
  b = BR.brand(own, null, env);
  assert.equal(b.name, 'Coral Coast Bakehouse'); assert.equal(b.tax_line, 'TIN 50-12345-0-1');
  assert.ok(b.logo && b.logo.uri.startsWith('data:image/png;base64,') && b.logo_from_central);
  assert.deepEqual(b.address_lines, ['Own address']);           // Central has none: Payroll's
  assert.deepEqual(b.contact_lines, ['111', 'own.example']);
  fs.writeFileSync(path.join(dir, 'Riyeser', 'company.json'), JSON.stringify({ name: 'NZ Co', country: 'NZ', tax_number: '123' }));
  assert.equal(BR.brand({}, null, env).tax_line, 'IRD number 123');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- through the program: Settings saves the details and the logo (kept in Payroll's database)
const PORT = 3977, B = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-brand-app-'));
let server, cookie;
async function call(method, url, body) {
  const res = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { }
  return { status: res.status, data, setCookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
before(async () => {
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR, APPDATA: path.join(DATA_DIR, 'appdata'), ADMIN_PASSWORD: 'AdminPass123', RIYESER_DEMO_FILE: path.join(DATA_DIR, 'no-demo.json'), RIYESER_DEMO: '', RIYESER_DOCS: path.join(DATA_DIR, 'docs') }, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) { try { await fetch(B + '/api/public/info'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  cookie = (await call('POST', '/api/auth/login', { username: 'admin', password: 'AdminPass123' })).setCookie;
});
after(async () => {
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000); });
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { }
});

test('Settings: business details and a logo upload show on the brand payslips use', async () => {
  const r = await call('PUT', '/api/staff/settings', { company_name: 'Coral Coast Bakehouse', company_legal_name: 'Coral Coast Holdings Ltd', company_tax_number: '50-12345-0-1', company_tax_label: 'TIN', company_website: 'coral.example' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let b = (await call('GET', '/api/staff/brand')).data;
  assert.equal(b.name, 'Coral Coast Bakehouse'); assert.equal(b.tax_line, 'TIN 50-12345-0-1'); assert.equal(b.logo, null);
  const bad = await call('PUT', '/api/staff/brand/logo', { data: Buffer.from('not a picture').toString('base64') });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /isn't a PNG or JPG/);
  const ok = await call('PUT', '/api/staff/brand/logo', { data: 'data:image/png;base64,' + logoPng().toString('base64') });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  b = (await call('GET', '/api/staff/brand')).data;
  assert.ok(b.logo.uri.startsWith('data:image/png;base64,') && b.own_logo && b.logo.w <= 212);
  assert.equal((await call('DELETE', '/api/staff/brand/logo')).status, 200);
  assert.equal((await call('GET', '/api/staff/brand')).data.logo, null);
});
