// The Windows program's extras: first-run setup screen and backups. Runs the back office the way the program does.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3997, B = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-desk-')), BACKUP_DIR = path.join(DATA_DIR, 'backups');
let server;
async function call(method, url, body, cookie) {
  const res = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
before(async () => {
  server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR, BACKUP_DIR, DESKTOP: '1', ADMIN_PASSWORD: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/public/info'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('Server did not start');
});
after(() => { server.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('desktop: first run asks the owner to create the Super admin login, once', async () => {
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'FIRST_RUN_ADMIN_PASSWORD.txt')));     // no password left lying in a file
  assert.deepEqual((await call('GET', '/api/public/setup')).data, { setup_needed: true, desktop: true });
  assert.equal((await call('POST', '/api/public/setup', { name: 'Owner', username: 'owner', password: 'short', password2: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/public/setup', { name: 'Owner', username: 'owner', password: 'ownerpass1', password2: 'different1' })).status, 400);
  const r = await call('POST', '/api/public/setup', { name: 'Owner', username: 'Owner', password: 'ownerpass1', password2: 'ownerpass1', company_name: 'Example Co Ltd' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.username, 'owner');
  const login = await call('POST', '/api/auth/login', { username: 'owner', password: 'ownerpass1' }); assert.equal(login.status, 200);
  const me = (await call('GET', '/api/auth/me', null, login.cookie)).data;
  assert.equal(me.user.role, 'admin'); assert.equal(me.user.name, 'Owner'); assert.equal(me.settings.company_name, 'Example Co Ltd');
  // nobody can run setup again
  assert.equal((await call('POST', '/api/public/setup', { name: 'X', username: 'xxx', password: 'xxxxxxxx1', password2: 'xxxxxxxx1' })).status, 400);
  assert.equal((await call('GET', '/api/public/setup')).data.setup_needed, false);
});

test('desktop: backups are made on demand (Super admin only) and are a full copy of the records', async () => {
  const owner = (await call('POST', '/api/auth/login', { username: 'owner', password: 'ownerpass1' })).cookie;
  await call('POST', '/api/staff/employees', { name: 'Seru Staff', username: 'seru', password: 'serupass1', role: 'staff', pay_rate: 6 }, owner);
  const staff = (await call('POST', '/api/auth/login', { username: 'seru', password: 'serupass1' })).cookie;
  assert.equal((await call('POST', '/api/staff/backups', {}, staff)).status, 403);
  const b = await call('POST', '/api/staff/backups', {}, owner);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const file = path.join(BACKUP_DIR, b.data.file);
  assert.ok(fs.existsSync(file));
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.ok(copy.prepare("SELECT 1 FROM users WHERE name = 'Seru Staff'").get());
  copy.close();
  const list = (await call('GET', '/api/staff/backups', null, owner)).data;
  assert.equal(list.desktop, true); assert.ok(list.backups.some(x => x.file === b.data.file)); assert.ok(list.last);
});
