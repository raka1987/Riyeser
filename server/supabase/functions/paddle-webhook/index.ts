// Paddle -> Riyeser. Paddle calls this for every payment, renewal, failed card, cancellation and refund.
// Set the endpoint in Paddle (Developer tools -> Notifications) to
//   https://<project>.supabase.co/functions/v1/paddle-webhook
// and copy its secret key into PADDLE_WEBHOOK_SECRET.
import { admin, env, json } from '../_shared/env.ts';
import { paymentRow, subscriptionRow, verifyPaddleSignature } from '../_shared/billing.mjs';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const raw = await req.text();
  if (!(await verifyPaddleSignature(raw, req.headers.get('Paddle-Signature'), env('PADDLE_WEBHOOK_SECRET')))) {
    return json({ error: 'bad signature' }, 401);
  }
  const evt = JSON.parse(raw);
  const db = admin();

  // Store it first. A repeat (Paddle retries until it gets a 200) is ignored.
  const { error: dup } = await db.from('webhook_events').insert({ id: evt.event_id, type: evt.event_type, occurred_at: evt.occurred_at, payload: evt });
  if (dup) {
    const { data: seen } = await db.from('webhook_events').select('processed_at').eq('id', evt.event_id).maybeSingle();
    if (seen?.processed_at) return json({ ok: true, repeat: true });
  }

  try {
    await handle(db, evt);
    await db.from('webhook_events').update({ processed_at: new Date().toISOString(), error: null }).eq('id', evt.event_id);
    return json({ ok: true });
  } catch (e) {
    await db.from('webhook_events').update({ error: String((e as Error).message || e) }).eq('id', evt.event_id);
    return json({ error: 'not processed' }, 500); // Paddle will retry
  }
});

async function accountFor(db: ReturnType<typeof admin>, data: any) {
  const id = data.custom_data?.account_id;
  if (id) {
    if (data.customer_id) await db.from('accounts').update({ paddle_customer_id: data.customer_id }).eq('id', id).is('paddle_customer_id', null);
    return id;
  }
  if (!data.customer_id) return null;
  const { data: acc } = await db.from('accounts').select('id').eq('paddle_customer_id', data.customer_id).maybeSingle();
  return acc?.id || null;
}

async function handle(db: ReturnType<typeof admin>, evt: any) {
  const type: string = evt.event_type; const data = evt.data || {};
  if (type.startsWith('subscription.')) {
    const { data: priceRows } = await db.from('prices').select('paddle_price_id, product');
    const prices = Object.fromEntries((priceRows || []).map((p: any) => [p.paddle_price_id, p.product]));
    const row = subscriptionRow(data, prices, await accountFor(db, data));
    // Events can arrive out of order: never let an older update overwrite a newer one.
    const { data: cur } = await db.from('subscriptions').select('updated_at').eq('id', row.id).maybeSingle();
    if (cur && Date.parse(cur.updated_at) > Date.parse(row.updated_at)) return;
    const { error } = await db.from('subscriptions').upsert(row);
    if (error) throw error;
  } else if (type.startsWith('transaction.')) {
    const row = paymentRow(data, await accountFor(db, data));
    const { error } = await db.from('payments').upsert(row);
    if (error) throw error;
  } else if (type.startsWith('customer.') && data.id && data.custom_data?.account_id) {
    await db.from('accounts').update({ paddle_customer_id: data.id }).eq('id', data.custom_data.account_id);
  }
  // Anything else is kept in webhook_events for the admin page.
}
