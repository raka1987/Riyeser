// Demo mode: %APPDATA%\Riyeser\demo.json (here RIYESER_DEMO_FILE) switches Payroll to practice records in <DATA_DIR>/demo.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 3996, B = `http://127.0.0.1:${PORT}`;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-demo-'));
const DATA_DIR = path.join(ROOT, 'payroll'), DEMO_FILE = path.join(ROOT, 'Riyeser', 'demo.json');
fs.mkdirSync(path.dirname(DEMO_FILE), { recursive: true });
let server = null;

async function call(method, url, body, cookie) {
  const res = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function start() {
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')],
    { env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR, DESKTOP: '1', ADMIN_PASSWORD: 'RealAdmin123', RIYESER_DEMO_FILE: DEMO_FILE, RIYESER_DEMO: '' }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { await fetch(B + '/api/public/info'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('Server did not start');
}
async function stop() {
  if (server && server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); setTimeout(r, 5000); });
  server = null;
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
after(async () => { await stop(); try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp folder */ } });

test('no demo file: nothing changes (real records, no banner, no demo folder)', async () => {
  await start();
  const info = (await call('GET', '/api/public/info')).data;
  assert.equal(info.demo, false); assert.equal(info.company_name, 'My Company');
  const page = (await call('GET', '/staff')).data;
  assert.ok(!page.includes('Demo mode'));
  const admin = (await call('POST', '/api/auth/login', { username: 'admin', password: 'RealAdmin123' })).cookie;
  assert.equal((await call('POST', '/api/staff/employees', { name: 'Real Person', username: 'real', password: 'realpass1', role: 'staff', pay_rate: 5 }, admin)).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { username: 'demo', password: 'demo' })).status, 401);
  await stop();
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'payroll.db')));
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'demo')));
});

test('demo on: the demo folder is used and filled with Sample Trading Co; demo / demo logs in; banner shows; real records untouched', async () => {
  const realDb = path.join(DATA_DIR, 'payroll.db'), before = sha(realDb);
  fs.writeFileSync(DEMO_FILE, JSON.stringify({ on: true, since: new Date().toISOString(), business: 'Sample Trading Co' }));
  await start();
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'demo', 'payroll.db')));
  assert.equal((await call('GET', '/api/public/info')).data.demo, true);
  assert.equal((await call('GET', '/api/public/setup')).data.setup_needed, false);   // no first-run screen
  const page = (await call('GET', '/staff')).data;
  assert.ok(page.includes('Demo mode: practice data, not real pay. Leave demo mode from Riyeser Central.'));
  assert.ok(page.includes('Demo mode: sign in with demo / demo'));
  assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'RealAdmin123' })).status, 401);
  const r = await call('POST', '/api/auth/login', { username: 'demo', password: 'demo' });
  assert.equal(r.status, 200);
  const me = (await call('GET', '/api/auth/me', null, r.cookie)).data;
  assert.equal(me.user.role, 'admin');
  assert.equal(me.settings.company_name, 'Sample Trading Co (demo)'); assert.equal(me.settings.setup_done, '1');
  assert.match(me.settings.address, /Suva, Fiji/); assert.doesNotMatch(me.settings.address, /Sydney/); // M7: a Fiji address in the email footer
  const staff = (await call('GET', '/api/staff/employees', null, r.cookie)).data.filter(u => u.role === 'staff');
  assert.deepEqual(staff.map(u => u.name).sort(), ['Alex Sample', 'Casey Placeholder', 'Jamie Example', 'Morgan Testwell', 'Robin Demo']);
  assert.ok(staff.some(u => u.pay_type === 'salary') && staff.some(u => u.pay_type === 'hourly'));
  assert.ok(!staff.some(u => u.name === 'Real Person'));
  const runs = (await call('GET', '/api/staff/payroll/runs', null, r.cookie)).data;
  assert.equal(runs.length, 1); assert.equal(runs[0].employees, 5); assert.ok(runs[0].total_net > 0);
  const run = (await call('GET', `/api/staff/payroll/runs/${runs[0].id}`, null, r.cookie)).data;
  assert.equal(run.payslips.length, 5);
  const ts = (await call('GET', `/api/staff/timesheets?from=${runs[0].period_start}&to=${runs[0].period_end}`, null, r.cookie)).data;
  assert.equal(ts.length, 50);   // 10 weekdays x 5 staff
  // Central leaves demo mode while Payroll is open: it says so, and does nothing more with the practice records
  const on = fs.readFileSync(DEMO_FILE, 'utf8');
  fs.writeFileSync(DEMO_FILE, JSON.stringify({ on: false }));
  await new Promise(res => setTimeout(res, 3300));
  const gone = await call('GET', '/api/staff/payroll/runs', null, r.cookie);
  assert.equal(gone.status, 503); assert.equal(gone.data.error, 'Demo mode has ended. Close this program and open it again.');
  assert.match((await call('GET', '/staff')).data, /Demo mode has ended/);
  fs.writeFileSync(DEMO_FILE, on);
  await stop();
  // a second start doesn't fill it again
  await start();
  const c2 = (await call('POST', '/api/auth/login', { username: 'demo', password: 'demo' })).cookie;
  assert.equal((await call('GET', '/api/staff/payroll/runs', null, c2)).data.length, 1);
  await stop();
  assert.equal(sha(realDb), before, 'the real records file was not changed');
});

test('demo turned off: back to the real records; a demo folder left behind is put away (renamed, not deleted)', async () => {
  fs.writeFileSync(DEMO_FILE, JSON.stringify({ on: false, since: new Date().toISOString(), business: 'Sample Trading Co' }));
  await start();
  assert.equal((await call('GET', '/api/public/info')).data.demo, false);
  assert.ok(!(await call('GET', '/staff')).data.includes('Demo mode'));
  assert.equal((await call('POST', '/api/auth/login', { username: 'demo', password: 'demo' })).status, 401);
  const admin = await call('POST', '/api/auth/login', { username: 'admin', password: 'RealAdmin123' });
  assert.equal(admin.status, 200);
  assert.ok((await call('GET', '/api/staff/employees', null, admin.cookie)).data.some(u => u.name === 'Real Person'));
  await stop();
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'demo')));
  const ended = fs.readdirSync(DATA_DIR).filter(f => /^demo-ended-\d{8}T\d{6}Z$/.test(f));
  assert.equal(ended.length, 1);
  assert.ok(fs.existsSync(path.join(DATA_DIR, ended[0], 'payroll.db')));
});
