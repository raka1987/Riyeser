const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const licence = require('../src/core/licence');
const on = require('../src/core/online');
const { Store } = require('../src/core/store');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
const NOW = Date.parse('2026-11-24T12:00:00Z');
const PLAN = {
  workspace_id: 'w1', company_code: 'RIY-7K3M-Q2', checked_at: '2026-11-24T12:00:00Z',
  modules: {
    basic: { status: 'active', active: true, trial_ends: null, paid_until: '2027-06-30', days_left: 218 },
    pos: { status: 'trial', active: true, trial_ends: '2027-01-03', paid_until: null, days_left: 40 },
    payroll: { status: 'ended', active: false, trial_ends: '2026-11-01', paid_until: null, days_left: 0 },
    bookings: { status: 'trial', active: true, trial_ends: '2026-12-01', paid_until: null, days_left: 7 },
    calls: { status: 'cancelled', active: false, trial_ends: null, paid_until: null, days_left: null },
  },
  seats: { included: 3, extra: 2, used: 4 }, extra_companies: 1, billing: 'yearly', early_bird: true,
};

test('licence: saving the online plan keeps the trial and licence key exactly as they were', () => {
  const dir = tmp();
  const f = licence.licenceFile(dir); fs.mkdirSync(path.dirname(f), { recursive: true });
  const old = { trialStart: '2026-10-01T00:00:00.000Z', key: 'ABCD-1234', licence: { status: 'active', checkedAt: '2026-11-20T00:00:00Z', plan: 'Riyeser' } };
  fs.writeFileSync(f, JSON.stringify(old));
  licence.saveOnline(dir, PLAN, NOW);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(d.trialStart, old.trialStart); assert.equal(d.key, old.key); assert.deepEqual(d.licence, old.licence);
  assert.equal(d.online.company_code, 'RIY-7K3M-Q2'); assert.equal(d.online.checkedAt, new Date(NOW).toISOString());
});

test('licence: the plan in plain words, program by program', () => {
  const dir = tmp(); licence.saveOnline(dir, PLAN, NOW - 2 * 3600 * 1000);
  const p = licence.onlinePlan(dir, NOW);
  assert.deepEqual(p.rows.map((r) => r.line), [
    'Accounting Basics: paid until 30 Jun 2027',
    'Payroll: trial ended — contact Riyeser',
    'POS: free trial, 40 days left',
    'Bookings: free trial, 7 days left',
    'Team Chat Plus: cancelled — contact Riyeser',
  ]);
  assert.deepEqual(p.rows.map((r) => r.tone), ['ok', 'bad', 'trial', 'warn', 'bad']);
  assert.equal(p.checkedAgo, '2 h ago'); assert.equal(p.stale, false); assert.equal(p.message, null);
  assert.equal(p.extraUsers, 2); assert.equal(p.usersUsed, 4); assert.equal(p.extraCompanies, 1); assert.equal(p.billing, 'yearly'); assert.equal(p.earlyBird, true);
  const st = licence.status(dir, NOW); assert.ok(st.online); assert.equal(st.online.companyCode, 'RIY-7K3M-Q2');
});

test('licence: a plan not checked for 30 days says so', () => {
  const dir = tmp(); licence.saveOnline(dir, PLAN, NOW - 31 * 86400000);
  const p = licence.onlinePlan(dir, NOW);
  assert.equal(p.stale, true); assert.match(p.message, /couldn't check your licence for 30 days/); assert.equal(p.checkedAgo, '31 days ago');
});

test('licence: without an online plan nothing changes', () => {
  const dir = tmp();
  assert.equal(licence.onlinePlan(dir, NOW), null);
  const st = licence.status(dir, NOW); assert.equal(st.mode, 'trial'); assert.equal(st.online, undefined);
});

function server(answer) {
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url); calls.push([u.pathname, opts.body ? JSON.parse(opts.body) : null]);
    if (u.href.startsWith(on.CONFIG_URL)) return res(200, 'window.RIYESER_TEAM={supabaseUrl:"https://x.supabase.co",supabaseKey:"sb_publishable_k"};');
    if (u.pathname === '/rest/v1/rpc/company_licence') return answer();
    return res(404, {});
  };
  return { fetchFn, calls, res };
}
function linked(dir, srv) {
  const o = new on.Online({ store: new Store(path.join(dir, 'data')), fetchFn: srv.fetchFn, appData: dir, appVersion: '1.6.6' });
  o.setSession({ access_token: 't', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: 'owner@sample.test' } });
  on.writeCompany(dir, { mode: 'online', name: 'Sample Plumbing', company_code: 'RIY-7K3M-Q2', workspace_id: 'w1' });
  return o;
}

test('online: fetches the plan for this company and saves it; offline keeps the last one', async () => {
  const dir = tmp(); let up = true;
  const srv = server(() => (up ? srv.res(200, PLAN) : Promise.reject(new Error('offline'))));
  const o = linked(dir, srv);
  const saved = await o.refreshLicence(NOW);
  assert.equal(saved.company_code, 'RIY-7K3M-Q2');
  assert.deepEqual(srv.calls.find((c) => c[0] === '/rest/v1/rpc/company_licence')[1], { ws: 'w1' });
  up = false;
  assert.equal(await o.refreshLicence(NOW + 86400000), null);
  assert.equal(licence.read(dir).online.checkedAt, new Date(NOW).toISOString());   // the last good one stays
});

test('online: a PC set up on its own (offline) never asks', async () => {
  const dir = tmp(); const srv = server(() => srv.res(200, PLAN));
  const o = new on.Online({ store: new Store(path.join(dir, 'data')), fetchFn: srv.fetchFn, appData: dir });
  o.setupLocal({ name: 'Corner Cafe' }, 'Kim');
  assert.equal(await o.refreshLicence(NOW), null);
  assert.equal(srv.calls.length, 0); assert.equal(licence.read(dir).online, undefined);
});
