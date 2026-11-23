// Riyeser Central -> "Manage plan". A one-time Paddle customer portal link: change card, see invoices, cancel.
import { admin, ensureAccount, json, paddle, userFrom } from '../_shared/env.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const user = await userFrom(req);
  if (!user) return json({ error: 'Please sign in again.' }, 401);
  const account = await ensureAccount(admin(), user);
  if (!account.paddle_customer_id) return json({ error: "You don't have a subscription yet." }, 404);
  const session = await paddle(`/customers/${account.paddle_customer_id}/portal-sessions`, {});
  return json({ url: session?.urls?.general?.overview });
});
