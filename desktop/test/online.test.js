const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const on = require('../src/core/online');
const { Store } = require('../src/core/store');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'co-'));

test('online: reads the address and key from riyeser.com/team/config.js', () => {
  const live = 'window.RIYESER_TEAM = {\n  supabaseUrl: "https://abc.supabase.co/",\n  supabaseKey: "sb_publishable_x1"\n};';
  assert.deepEqual(on.parseConfig(live), { url: 'https://abc.supabase.co', key: 'sb_publishable_x1' });
  const empty = 'window.RIYESER_TEAM = { supabaseUrl: "", supabaseKey: "" };';
  assert.deepEqual(on.parseConfig(empty), { url: '', key: '' });
  assert.equal(on.usable(on.parseConfig(empty)), false);
  assert.equal(on.usable(on.parseConfig('garbage')), false);
  assert.equal(on.usable(on.parseConfig(live)), true);
});

test('online: company.json is written safely, kept, and never needs a name to be re-typed', () => {
  const dir = tmp();
  assert.equal(on.readCompany(dir), null);
  assert.throws(() => on.writeCompany(dir, { name: '  ' }), /company name/);
  const c = on.writeCompany(dir, { mode: 'local', name: ' Sample Plumbing ', tax_number: '12 345 678 901', country: 'Fiji', junk: 'x' });
  assert.equal(c.name, 'Sample Plumbing'); assert.equal(c.mode, 'local'); assert.ok(c.linked_at); assert.equal(c.junk, undefined);
  assert.equal(on.companyFile(dir), path.join(dir, 'Riyeser', 'company.json'));
  const c2 = on.writeCompany(dir, { mode: 'online', company_code: 'RIY-7K3M-Q2', workspace_id: 'w1' });
  assert.equal(c2.name, 'Sample Plumbing'); assert.equal(c2.tax_number, '12 345 678 901'); assert.equal(c2.company_code, 'RIY-7K3M-Q2');
  fs.writeFileSync(on.companyFile(dir), '{not json'); assert.equal(on.readCompany(dir), null);   // a bad file is ignored, not fatal
});

// A pretend Riyeser Online that answers like the real one.
function fakeServer({ configured = true } = {}) {
  const calls = []; let joinStatus = 'pending';
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : null; calls.push([u.pathname, body, opts.headers || {}]);
    if (u.href.startsWith(on.CONFIG_URL)) return res(200, configured ? 'window.RIYESER_TEAM={supabaseUrl:"https://x.supabase.co",supabaseKey:"sb_publishable_k"};' : 'window.RIYESER_TEAM={supabaseUrl:"",supabaseKey:""};');
    if (u.pathname === '/auth/v1/token') return body.password === 'right-password'
      ? res(200, { access_token: 'tok', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: body.email } }) : res(400, { error_description: 'Invalid login credentials' });
    if (u.pathname === '/auth/v1/signup') return res(200, { id: 'u2', email: body.email });   // confirm-email projects send no session
    if (u.pathname === '/rest/v1/rpc/create_company') return res(200, { workspace_id: 'w1', company_code: 'RIY-7K3M-Q2' });
    if (u.pathname === '/rest/v1/rpc/request_join') return body.code === 'LAU-4821' ? res(200, { status: 'pending', company_name: 'Sample Plumbing', workspace_id: 'w9' }) : res(400, { message: 'That code isn\'t right.' });
    if (u.pathname === '/rest/v1/rpc/my_join_requests') return res(200, [{ id: 'r1', workspace_id: 'w9', company_name: 'Sample Plumbing', status: joinStatus, created_at: '2026-11-24T01:00:00Z' }]);
    if (u.pathname === '/rest/v1/members') return res(200, joinStatus === 'approved' ? [{ role: 'member', job_role: 'sales', display_name: 'Sam', workspaces: { id: 'w9', name: 'Sample Plumbing', company_code: 'RIY-AB12-CD', tax_number: '99', address: '1 Main St', phone: '', email: '', country: 'Fiji', legal_name: '' } }] : []);
    if (u.pathname === '/rest/v1/rpc/link_device') return res(200, '');
    if (u.pathname === '/rest/v1/rpc/device_still_linked') return res(200, 'false');
    return res(404, { message: 'not found' });
  };
  return { fetchFn, calls, approve: () => { joinStatus = 'approved'; }, decline: () => { joinStatus = 'declined'; } };
}
const make = (opts) => { const dir = tmp(); const srv = fakeServer(opts); const o = new on.Online({ store: new Store(path.join(dir, 'data')), fetchFn: srv.fetchFn, appData: dir, appVersion: '1.6.4', deviceName: 'Front desk PC' }); return { dir, srv, o }; };

test('online: not switched on yet -> only the offline set-up works', async () => {
  const { dir, o } = make({ configured: false });
  assert.equal(await o.ready(), false);
  await assert.rejects(o.signIn('a@b.test', 'right-password'), /being switched on/);
  const c = o.setupLocal({ name: 'Corner Cafe', country: 'Fiji' }, 'Kim');
  assert.equal(c.mode, 'local'); assert.equal(on.readCompany(dir).name, 'Corner Cafe');
});

test('online: set up a new company -> Company ID saved, this PC linked', async () => {
  const { dir, srv, o } = make();
  await assert.rejects(o.signIn('owner@a.test', 'wrong'), /email or password isn't right/);
  await o.signIn('owner@a.test', 'right-password');
  const c = await o.createCompany({ name: 'Sample Plumbing', tax_number: '12 345', country: 'Fiji', address: '4 Elm St' }, 'Alex');
  assert.equal(c.company_code, 'RIY-7K3M-Q2'); assert.equal(c.mode, 'online'); assert.equal(c.email_signed_in, 'owner@a.test');
  assert.equal(on.readCompany(dir).workspace_id, 'w1');
  const create = srv.calls.find((x) => x[0] === '/rest/v1/rpc/create_company');
  assert.deepEqual(create[1].profile, { legal_name: '', tax_number: '12 345', address: '4 Elm St', phone: '', email: '', country: 'Fiji' });
  assert.equal(create[2].Authorization, 'Bearer tok');
  const link = srv.calls.find((x) => x[0] === '/rest/v1/rpc/link_device');
  assert.equal(link[1].ws, 'w1'); assert.equal(link[1].device_name, 'Front desk PC'); assert.equal(link[1].device, o.deviceId());
  assert.equal(o.deviceId(), o.deviceId());   // made once, then kept
});

test('online: new account that must confirm its email first', async () => {
  const { o } = make();
  assert.deepEqual(await o.signIn('new@a.test', 'right-password', true), { needsConfirm: true, email: 'new@a.test' });
  assert.equal(o.session, null);
});

test('online: join with a branch code -> waits -> approved and linked; or declined', async () => {
  const { dir, srv, o } = make();
  await o.signIn('sam@a.test', 'right-password');
  await assert.rejects(o.requestJoin('NOPE-1', 'Sam', ''), /code isn't right/);
  const r = await o.requestJoin('lau-4821', 'Sam', 'New at Lautoka');
  assert.deepEqual(r, { status: 'pending', company_name: 'Sample Plumbing' });
  assert.equal(srv.calls.find((x) => x[0] === '/rest/v1/rpc/request_join' && x[1].code === 'LAU-4821')[1].note, 'New at Lautoka');
  assert.equal((await o.checkJoin()).status, 'pending');
  assert.equal(on.readCompany(dir), null);   // nothing linked until approved
  srv.approve();
  const ok = await o.checkJoin();
  assert.equal(ok.status, 'approved'); assert.equal(ok.company.company_code, 'RIY-AB12-CD'); assert.equal(on.readCompany(dir).name, 'Sample Plumbing');
  assert.equal((await o.checkJoin()).status, 'none');   // the request is finished
  // an admin removes this PC later: Central notices, and keeps everything
  assert.equal(await o.stillLinked(), false); assert.ok(on.readCompany(dir));
  const d = make(); await d.o.signIn('x@a.test', 'right-password'); await d.o.requestJoin('LAU-4821', 'X', ''); d.srv.decline();
  assert.deepEqual(await d.o.checkJoin(), { status: 'declined', company_name: 'Sample Plumbing' });
});
