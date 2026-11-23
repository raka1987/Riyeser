// Riyeser billing rules, shared by the Supabase functions (Deno) and the tests (Node).
// No database or network code here: only the rules, so they can be tested on their own.
//
//   verifyPaddleSignature  is this webhook really from Paddle?
//   subscriptionRow        a Paddle subscription event -> our `subscriptions` row
//   paymentRow             a Paddle transaction event  -> our `payments` row
//   entitlements           an account's subscriptions -> which programs are paid, until when
//   buildPass / signPass   the signed "plan pass" Riyeser Central keeps on the PC

export const PRODUCTS = ['basics', 'plus', 'pos', 'payroll', 'asbuilt'];
export const ADDONS = ['extra_user', 'extra_company'];

// Free allowances. The real values live in the `settings` table (key 'caps') so they can change without a new app.
export const DEFAULT_CAPS = { basic: 50, pos: 500, payroll: 4, asbuilt: 3, plusTrialDays: 90, warnAt: 0.8 };
export const GRACE_DAYS = 14;        // a failed renewal keeps working this long after the paid period ends
export const PASS_DAYS = 30;         // a pass works this long offline
const DAY = 86400000;

// ---------- Paddle webhook signature ----------
// Header:  Paddle-Signature: ts=1671552777;h1=<hex HMAC-SHA256 of "<ts>:<raw body>" with the endpoint secret>
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function verifyPaddleSignature(rawBody, header, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(';').map((p) => p.split('=').map((s) => s.trim())));
  const ts = Number(parts.ts);
  const sigs = String(header).split(';').map((p) => p.trim()).filter((p) => p.startsWith('h1=')).map((p) => p.slice(3));
  if (!ts || !sigs.length) return false;
  if (Math.abs(now / 1000 - ts) > toleranceSec) return false; // stops an old message being replayed
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${parts.ts}:${rawBody}`)));
  return sigs.some((s) => timingSafeEqual(s, want));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- Paddle events -> rows ----------
/** Paddle subscription entity -> subscriptions row. `prices` maps a Paddle price id to a product or add-on id. */
export function subscriptionRow(sub, prices, accountId = null) {
  const items = (sub.items || []).map((it) => ({ product: prices[it.price?.id || it.price_id] || null, price: it.price?.id || it.price_id, quantity: it.quantity || 1 }));
  const sched = sub.scheduled_change || null;
  return {
    id: sub.id,
    account_id: accountId || sub.custom_data?.account_id || null,
    customer_id: sub.customer_id || null,
    status: sub.status,                                    // active | trialing | past_due | paused | canceled
    items,
    period_ends_at: sub.current_billing_period?.ends_at || sub.next_billed_at || null,
    cancel_at: sched && sched.action === 'cancel' ? sched.effective_at : (sub.canceled_at || null),
    updated_at: sub.updated_at || new Date().toISOString(),
  };
}

/** Paddle transaction entity -> payments row. Amounts are in the smallest unit (cents), as Paddle sends them. */
export function paymentRow(txn, accountId = null) {
  const t = txn.details?.totals || {};
  return {
    id: txn.id,
    account_id: accountId || txn.custom_data?.account_id || null,
    customer_id: txn.customer_id || null,
    subscription_id: txn.subscription_id || null,
    status: txn.status,                                    // completed | paid | past_due | canceled ...
    total: Number(t.grand_total ?? t.total ?? 0),
    tax: Number(t.tax ?? 0),
    currency: txn.currency_code || t.currency_code || null,
    origin: txn.origin || null,                            // web | subscription_recurring | ...
    billed_at: txn.billed_at || txn.created_at || null,
  };
}

// ---------- what an account has paid for ----------
/**
 * subscriptions rows -> { products: { basics: { paid, status, until, warning } ... }, extraUsers, extraCompanies }
 *   active / trialing     paid until the end of the period
 *   past_due              still paid, with a warning, until the period end + GRACE_DAYS (Paddle retries the card meanwhile)
 *   canceled / scheduled  paid until the period they already paid for ends
 *   paused                not paid
 */
export function entitlements(subs, now = Date.now()) {
  const products = {}; let extraUsers = 0; let extraCompanies = 0;
  for (const s of subs || []) {
    const ends = s.period_ends_at ? Date.parse(s.period_ends_at) : null;
    const cancelAt = s.cancel_at ? Date.parse(s.cancel_at) : null;
    let until = null; let warning = null;
    if (s.status === 'active' || s.status === 'trialing') {
      until = cancelAt && (!ends || cancelAt < ends) ? cancelAt : ends;
      if (cancelAt) warning = 'cancelled';
    } else if (s.status === 'past_due') {
      until = (ends || now) + GRACE_DAYS * DAY; warning = 'payment_failed';
    } else if (s.status === 'canceled') {
      until = cancelAt || ends; warning = 'cancelled';
    }
    const paid = until !== null && until > now;
    for (const it of s.items || []) {
      if (!it.product) continue;
      if (it.product === 'extra_user') { if (paid) extraUsers += it.quantity || 1; continue; }
      if (it.product === 'extra_company') { if (paid) extraCompanies += it.quantity || 1; continue; }
      const prev = products[it.product];
      const cur = { paid, status: s.status, until: until ? new Date(until).toISOString() : null, warning: paid ? warning : null };
      // two subscriptions for one program (e.g. moved from monthly to yearly): keep the one that lasts longest
      if (!prev || (cur.paid && (!prev.paid || Date.parse(cur.until) > Date.parse(prev.until)))) products[it.product] = cur;
    }
  }
  // Accounting Plus includes everything in Basics
  if (products.plus?.paid && !products.basics?.paid) products.basics = { ...products.plus };
  return { products, extraUsers, extraCompanies };
}

/** The plan pass: what Central stores on the PC and every Riyeser program reads. */
export function buildPass({ account, deviceId, subs, caps, now = Date.now() }) {
  const ent = entitlements(subs, now);
  return {
    v: 1,
    account: account.id,
    email: account.email || null,
    device: deviceId || null,
    products: ent.products,
    extraUsers: ent.extraUsers,
    extraCompanies: ent.extraCompanies,
    caps: { ...DEFAULT_CAPS, ...(caps || {}) },
    issuedAt: new Date(now).toISOString(),
    validUntil: new Date(now + PASS_DAYS * DAY).toISOString(),
  };
}

// ---------- signing (Ed25519) ----------
// The private key (PKCS8, base64) is a server secret. The public key (SPKI, base64) is built into Riyeser Central,
// so a pass edited by hand on the PC no longer verifies.
const b64 = { enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))), dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };

export async function signPass(pass, privateKeyB64) {
  const key = await crypto.subtle.importKey('pkcs8', b64.dec(privateKeyB64), { name: 'Ed25519' }, false, ['sign']);
  const body = JSON.stringify(pass);
  const sig = b64.enc(await crypto.subtle.sign('Ed25519', key, enc.encode(body)));
  return { pass: body, sig };
}
export async function verifyPass(signed, publicKeyB64) {
  const key = await crypto.subtle.importKey('spki', b64.dec(publicKeyB64), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, b64.dec(signed.sig), enc.encode(signed.pass));
}

// ---------- what the PC tells us (counts and versions only, never business data) ----------
const clean = (v, max = 80) => String(v ?? '').slice(0, max);
export function deviceRow(accountId, d = {}, now = Date.now()) {
  const nums = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => /^[a-z_]{1,30}$/.test(k) && Number.isFinite(+v)).slice(0, 20).map(([k, v]) => [k, Math.max(0, Math.floor(+v))]));
  const vers = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => /^[a-z_-]{1,30}$/.test(k)).slice(0, 20).map(([k, v]) => [k, clean(v, 20)]));
  return { account_id: accountId, id: clean(d.id, 64) || 'unknown', name: clean(d.name), os: clean(d.os, 40), versions: vers(d.versions), usage: nums(d.usage), last_seen: new Date(now).toISOString() };
}
