// Settings and clients shared by the functions. Secrets are set with `supabase secrets set` (see server/README.md).
import { createClient } from 'jsr:@supabase/supabase-js@2';

export const env = (k: string) => Deno.env.get(k) || '';
export const PADDLE_API = env('PADDLE_ENV') === 'live' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';

/** Database client with the service role: skips row level security, so only use it inside functions. */
export const admin = () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

/** The signed-in customer from the request's Authorization header, or null. */
export async function userFrom(req: Request) {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data, error } = await admin().auth.getUser(jwt);
  return error ? null : data.user;
}

export async function paddle(path: string, body?: unknown) {
  const res = await fetch(`${PADDLE_API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${env('PADDLE_API_KEY')}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.detail || `Paddle said ${res.status}`);
  return json.data;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Make sure the signed-in user has an accounts row. */
export async function ensureAccount(db: ReturnType<typeof admin>, user: { id: string; email?: string }) {
  const { data } = await db.from('accounts').select('*').eq('id', user.id).maybeSingle();
  if (data) return data;
  const { data: made, error } = await db.from('accounts').insert({ id: user.id, email: user.email || '' }).select().single();
  if (error) throw error;
  return made;
}
