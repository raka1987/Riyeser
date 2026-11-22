const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const lic = require('../src/core/licence');
const DAY = 86400000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
const fakeFetch = (body) => async () => ({ ok: true, json: async () => body });

test('licence: 90-day trial, counts down, then expires without losing anything', () => {
  const dir = tmp(); const t0 = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(lic.status(dir, t0).mode, 'trial');
  assert.equal(lic.status(dir, t0).daysLeft, 90);
  assert.equal(lic.status(dir, t0 + 80 * DAY).daysLeft, 10);
  const end = lic.status(dir, t0 + 91 * DAY);
  assert.equal(end.mode, 'expired'); assert.match(end.message, /still here/);
  assert.ok(fs.existsSync(lic.licenceFile(dir)));
});

test('licence: activate a key, works offline for 30 days, then asks to re-check', async () => {
  const dir = tmp(); const t0 = Date.parse('2026-03-01T00:00:00Z');
  const ok = { activated: true, instance: { id: 'i1' }, license_key: { status: 'active', activation_limit: 5, activation_usage: 1 }, meta: { product_name: 'Riyeser', variant_name: '5 users + 2 extra companies', customer_email: 'a@b.c', store_id: 1 } };
  const s = await lic.activate(dir, 'ABCD-1234-EFGH-5678', { fetchFn: fakeFetch(ok), now: t0 });
  assert.equal(s.mode, 'licensed'); assert.equal(s.plan, 'Riyeser · 5 users + 2 extra companies'); assert.equal(s.extraCompanies, 2); assert.equal(s.key, 'ABCD…5678');
  assert.equal(lic.status(dir, t0 + 20 * DAY).mode, 'licensed');
  assert.equal(lic.status(dir, t0 + 31 * DAY).mode, 'expired');
  // back online: a successful check renews it
  const back = await lic.recheck(dir, { fetchFn: fakeFetch({ valid: true, license_key: { status: 'active' }, meta: {} }), now: t0 + 31 * DAY });
  assert.equal(back.mode, 'licensed');
  // offline re-check changes nothing
  const off = await lic.recheck(dir, { fetchFn: async () => { throw new Error('offline'); }, now: t0 + 32 * DAY });
  assert.equal(off.mode, 'licensed');
});

test('licence: refused keys and cancelled subscriptions', async () => {
  const dir = tmp(); const t0 = Date.parse('2026-03-01T00:00:00Z');
  await assert.rejects(lic.activate(dir, 'ABCD-1234', { fetchFn: fakeFetch({ activated: false, error: 'This license key has reached the activation limit.' }), now: t0 }), /maximum number of computers/);
  await assert.rejects(lic.activate(dir, 'x', { fetchFn: fakeFetch({}), now: t0 }), /doesn't look like/);
  await lic.activate(dir, 'ABCD-1234-EFGH', { fetchFn: fakeFetch({ activated: true, instance: { id: 'i' }, license_key: { status: 'active' }, meta: {} }), now: t0 });
  const gone = await lic.recheck(dir, { fetchFn: fakeFetch({ valid: false, license_key: { status: 'expired' }, meta: {} }), now: t0 + 5 * DAY });
  assert.equal(gone.mode, 'expired'); assert.match(gone.message, /ended/);
  const removed = await lic.remove(dir, { fetchFn: fakeFetch({ deactivated: true }), now: t0 + 5 * DAY });
  assert.equal(removed.mode, 'trial'); // trial date kept: still inside the first 90 days here
});
