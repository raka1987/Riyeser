// Riyeser Central -> "I want to subscribe to <program>". Answers with a Paddle checkout link to open in the browser.
// The account id rides along in custom_data, so the webhook knows whose payment it is.
import { admin, ensureAccount, json, paddle, userFrom } from '../_shared/env.ts';
import { ADDONS, PRODUCTS } from '../_shared/billing.mjs';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const user = await userFrom(req);
  if (!user) return json({ error: 'Please sign in again.' }, 401);
  const { items = [], interval = 'month' } = await req.json().catch(() => ({}));
  const want = (items as { product: string; quantity?: number }[]).filter((i) => PRODUCTS.includes(i.product) || ADDONS.includes(i.product));
  if (!want.length) return json({ error: 'Pick at least one program.' }, 400);

  const db = admin();
  const account = await ensureAccount(db, user);
  const { data: prices } = await db.from('prices').select('*').eq('interval', interval === 'year' ? 'year' : 'month');
  const line = want.map((i) => {
    const p = (prices || []).find((x: any) => x.product === i.product);
    if (!p) throw new Error(`No price set up for ${i.product}`);
    return { price_id: p.paddle_price_id, quantity: Math.max(1, Math.min(50, i.quantity || 1)) };
  });
  const customerId = account.paddle_customer_id || (await paddleCustomer(db, account));
  const txn = await paddle('/transactions', {
    items: line,
    customer_id: customerId,                 // fills in their email on the checkout
    custom_data: { account_id: account.id },
    collection_mode: 'automatic',
  });
  // Paddle builds this link from the "default payment link" page set in its dashboard (riyeser.com/pay.html).
  const url = txn?.checkout?.url;
  if (!url) return json({ error: 'Checkout is not set up yet.' }, 503);
  return json({ url });
});

/** The Paddle customer for this account: found by email, or made now. Saved so the webhook can match payments. */
async function paddleCustomer(db: ReturnType<typeof admin>, account: { id: string; email: string }) {
  const found = await paddle(`/customers?email=${encodeURIComponent(account.email)}`);
  const id = (Array.isArray(found) && found[0]?.id) ||
    (await paddle('/customers', { email: account.email, custom_data: { account_id: account.id } })).id;
  await db.from('accounts').update({ paddle_customer_id: id }).eq('id', account.id);
  return id;
}
