// Riyeser Central -> "what is this customer allowed?"
// Called when Central opens and every few hours. Records the PC's check-in (counts and versions only)
// and answers with a signed plan pass that every Riyeser program on the PC reads, offline for up to 30 days.
import { admin, ensureAccount, env, json, userFrom } from '../_shared/env.ts';
import { buildPass, deviceRow, signPass } from '../_shared/billing.mjs';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const user = await userFrom(req);
  if (!user) return json({ error: 'Please sign in again.' }, 401);
  const body = await req.json().catch(() => ({}));
  const db = admin();
  const account = await ensureAccount(db, user);
  const now = Date.now();

  const dev = deviceRow(account.id, body.device || {}, now);
  await db.from('devices').upsert(dev);
  await db.from('accounts').update({ last_seen_at: new Date(now).toISOString() }).eq('id', account.id);

  const { data: subs } = await db.from('subscriptions').select('*').eq('account_id', account.id);
  const { data: caps } = await db.from('settings').select('value').eq('key', 'caps').maybeSingle();
  const pass = buildPass({ account, deviceId: dev.id, subs: subs || [], caps: caps?.value, now });
  return json(await signPass(pass, env('PASS_SIGNING_KEY')));
});
