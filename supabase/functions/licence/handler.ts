// The "licence" Edge Function (index.ts serves this): the company's Riyeser licence, signed with Ed25519, for one PC.
//
//   POST /functions/v1/licence           { ws, device }   (Authorization: the person's Supabase session)
//     -> { licence, issued_at, expires_at, workspace_id, device_id, sig }
//   GET  /functions/v1/licence/public-key -> { alg: "Ed25519", public_key }   (built into each program at build time)
//
// The licence is company_licence(ws), asked of the database AS THE CALLER (their session is passed on), so only
// someone in the business gets it. device_id is the PC from the request only when it's linked to the business
// (licence_device_linked), else null. The signature covers the canonical JSON of everything except sig.
// expires_at is issued_at + 30 days: how long the programs keep working without the internet.
// The private key is the function secret LICENCE_SIGNING_KEY (made inside the deploy workflow; never in the repo).
// Deployed with --no-verify-jwt so the public key can be fetched without signing in; POST checks the session itself.
import { loadKey, signLicence, type SigningKey } from "./sign.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

let key: Promise<SigningKey> | null = null;
function signingKey(): Promise<SigningKey> | null {
  const secret = Deno.env.get("LICENCE_SIGNING_KEY");
  if (!secret) return null;
  key ??= loadKey(secret);
  return key;
}

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; status: number; body: unknown }>;
/** PostgREST, as the person who called (their Authorization header is passed on). */
export function rpcAs(req: Request): Rpc {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const auth = req.headers.get("Authorization") ?? "";
  return async (name, args) => {
    const r = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey, Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    let body: unknown = null;
    try { body = await r.json(); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, body };
  };
}

export async function handle(req: Request, opts: { rpc?: Rpc; key?: Promise<SigningKey> | null; now?: number } = {}): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const k = opts.key !== undefined ? opts.key : signingKey();
  if (req.method === "GET" && path.endsWith("/public-key")) {
    if (!k) return json(503, { error: "Licence signing isn't set up yet." });
    return json(200, { alg: "Ed25519", public_key: (await k).publicKey });
  }
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  if (!k) return json(503, { error: "Licence signing isn't set up yet." });
  if (!/^Bearer\s+\S+/.test(req.headers.get("Authorization") ?? "")) return json(401, { error: "Sign in to your Riyeser account first." });
  let b: { ws?: unknown; device?: unknown };
  try { b = await req.json(); } catch { return json(400, { error: "Send { ws, device }." }); }
  const ws = String(b.ws ?? "");
  const device = typeof b.device === "string" && UUID.test(b.device) ? b.device.toLowerCase() : null;
  if (!UUID.test(ws)) return json(400, { error: "Send the business's id (ws)." });
  const rpc = opts.rpc ?? rpcAs(req);
  const lic = await rpc("company_licence", { ws });
  if (!lic.ok || !lic.body || typeof lic.body !== "object") {
    return json(lic.status === 401 ? 401 : 403, { error: "You're not in that company, or your sign-in has run out." });
  }
  const licence = lic.body as Record<string, unknown>;
  if (String(licence.workspace_id ?? "") !== ws) return json(403, { error: "You're not in that company." });
  let deviceId: string | null = null;
  if (device) {
    const linked = await rpc("licence_device_linked", { ws, device });
    deviceId = linked.ok && linked.body === true ? device : null;
  }
  return json(200, await signLicence(await k, licence, ws, deviceId, opts.now ?? Date.now()));
}
