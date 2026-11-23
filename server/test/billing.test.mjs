import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyPaddleSignature, subscriptionRow, paymentRow, entitlements, buildPass, signPass, verifyPass, deviceRow, DEFAULT_CAPS } from '../supabase/functions/_shared/billing.mjs';

const DAY = 86400000;
const t0 = Date.parse('2027-01-10T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('paddle signature: genuine, tampered, old and missing', async () => {
  const secret = 'pdl_ntfset_secret'; const body = '{"event_id":"evt_1"}'; const ts = Math.floor(t0 / 1000);
  const h1 = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  assert.equal(await verifyPaddleSignature(body, `ts=${ts};h1=${h1}`, secret, { now: t0 }), true);
  assert.equal(await verifyPaddleSignature(body + ' ', `ts=${ts};h1=${h1}`, secret, { now: t0 }), false);
  assert.equal(await verifyPaddleSignature(body, `ts=${ts};h1=${h1}`, 'other', { now: t0 }), false);
  assert.equal(await verifyPaddleSignature(body, `ts=${ts};h1=${h1}`, secret, { now: t0 + 3600e3 }), false); // replayed an hour later
  assert.equal(await verifyPaddleSignature(body, null, secret, { now: t0 }), false);
  // Paddle can send two h1 values while a secret is being rotated
  assert.equal(await verifyPaddleSignature(body, `ts=${ts};h1=deadbeef;h1=${h1}`, secret, { now: t0 }), true);
});

const prices = { pri_basics_m: 'basics', pri_pos_m: 'pos', pri_co: 'extra_company' };
const paddleSub = (over = {}) => ({
  id: 'sub_1', status: 'active', customer_id: 'ctm_1', custom_data: { account_id: 'acc-1' },
  items: [{ price: { id: 'pri_basics_m' }, quantity: 1 }, { price: { id: 'pri_co' }, quantity: 2 }],
  current_billing_period: { starts_at: iso(t0 - 10 * DAY), ends_at: iso(t0 + 20 * DAY) },
  scheduled_change: null, updated_at: iso(t0), ...over,
});

test('subscription event becomes a row', () => {
  const r = subscriptionRow(paddleSub(), prices);
  assert.equal(r.account_id, 'acc-1'); assert.equal(r.status, 'active'); assert.equal(r.period_ends_at, iso(t0 + 20 * DAY));
  assert.deepEqual(r.items.map((i) => [i.product, i.quantity]), [['basics', 1], ['extra_company', 2]]);
  const c = subscriptionRow(paddleSub({ scheduled_change: { action: 'cancel', effective_at: iso(t0 + 20 * DAY) } }), prices);
  assert.equal(c.cancel_at, iso(t0 + 20 * DAY));
});

test('transaction event becomes a payment', () => {
  const p = paymentRow({ id: 'txn_1', status: 'completed', customer_id: 'ctm_1', subscription_id: 'sub_1', currency_code: 'AUD', origin: 'subscription_recurring',
    billed_at: iso(t0), custom_data: { account_id: 'acc-1' }, details: { totals: { grand_total: '2200', tax: '200' } } });
  assert.deepEqual([p.total, p.tax, p.currency, p.origin, p.account_id], [2200, 200, 'AUD', 'subscription_recurring', 'acc-1']);
});

test('entitlements: active, failed card grace, cancelled, paused', () => {
  const row = (over) => ({ ...subscriptionRow(paddleSub(), prices), ...over });
  let e = entitlements([row({})], t0);
  assert.equal(e.products.basics.paid, true); assert.equal(e.extraCompanies, 2); assert.equal(e.products.basics.warning, null);
  assert.equal(entitlements([row({})], t0 + 21 * DAY).products.basics.paid, false); // period over, nothing renewed it

  // card failed: still works, with a warning, for 14 days after the period ends
  e = entitlements([row({ status: 'past_due' })], t0 + 25 * DAY);
  assert.equal(e.products.basics.paid, true); assert.equal(e.products.basics.warning, 'payment_failed');
  assert.equal(entitlements([row({ status: 'past_due' })], t0 + 35 * DAY).products.basics.paid, false);

  // cancelled: keeps what they paid for, then stops
  const cut = row({ status: 'canceled', cancel_at: iso(t0 + 20 * DAY) });
  assert.equal(entitlements([cut], t0 + 5 * DAY).products.basics.paid, true);
  assert.equal(entitlements([cut], t0 + 5 * DAY).products.basics.warning, 'cancelled');
  assert.equal(entitlements([cut], t0 + 21 * DAY).products.basics.paid, false);

  assert.equal(entitlements([row({ status: 'paused' })], t0).products.basics.paid, false);
  assert.equal(entitlements([row({ status: 'paused' })], t0).extraCompanies, 0);
});

test('entitlements: Plus includes Basics; the longest of two subscriptions wins', () => {
  const plus = { id: 's2', status: 'active', items: [{ product: 'plus', quantity: 1 }], period_ends_at: iso(t0 + 300 * DAY) };
  const old = { id: 's3', status: 'canceled', items: [{ product: 'plus', quantity: 1 }], cancel_at: iso(t0 + 2 * DAY) };
  const e = entitlements([old, plus], t0);
  assert.equal(e.products.plus.until, iso(t0 + 300 * DAY)); assert.equal(e.products.basics.paid, true);
});

test('plan pass: signed, verifies, and refuses edits', async () => {
  const { subtle } = globalThis.crypto; const b64 = (b) => Buffer.from(b).toString('base64');
  const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const priv = b64(await subtle.exportKey('pkcs8', pair.privateKey)); const pub = b64(await subtle.exportKey('spki', pair.publicKey));
  const pass = buildPass({ account: { id: 'acc-1', email: 'a@b.c' }, deviceId: 'pc1', subs: [subscriptionRow(paddleSub(), prices)], caps: { basic: 60 }, now: t0 });
  assert.equal(pass.caps.basic, 60); assert.equal(pass.caps.pos, DEFAULT_CAPS.pos); assert.equal(pass.validUntil, iso(t0 + 30 * DAY));
  const signed = await signPass(pass, priv);
  assert.equal(await verifyPass(signed, pub), true);
  const forged = { ...signed, pass: signed.pass.replace('"paid":true', '"paid":false').replace('"basics"', '"pos"') };
  assert.equal(await verifyPass(forged, pub), false);
});

test('device check-in keeps only counts and versions', () => {
  const d = deviceRow('acc-1', { id: 'pc1', name: 'FRONT-DESK', versions: { central: '1.4.0', 'bad key!': 'x' }, usage: { invoices: 37.9, pos_sales: '120', customer_name: 'Bob', notes: 'x' } }, t0);
  assert.deepEqual(d.versions, { central: '1.4.0' });
  assert.deepEqual(d.usage, { invoices: 37, pos_sales: 120 });
});
