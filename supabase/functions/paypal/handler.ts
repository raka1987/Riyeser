// The "paypal" Edge Function (index.ts serves this): Riyeser subscriptions paid through PayPal (card or PayPal balance).
//
//   GET  /functions/v1/paypal/status      -> { ready, env, credentials, webhooks, message }   (no sign-in: the website
//                                            and HQ use it to show or hide "Pay with PayPal")
//   POST /functions/v1/paypal/subscribe   { ws, modules, people, billing }   (the owner's Supabase session)
//                                         -> { approve_url, ref }   (the owner approves at PayPal, then comes back)
//   POST /functions/v1/paypal/cancel      { ws }   (the owner, with two-step sign-in) -> { ok, works_until }
//   POST /functions/v1/paypal/webhook     PayPal's webhooks: the signature is checked with PayPal's
//                                         verify-webhook-signature API, then billing_paypal_event applies it once.
//
// THE DESIGN: one PayPal subscription per business for its whole plan. PayPal has two plans per billing period
// (monthly, yearly; and the same with an early bird first year), each with a placeholder price, and each subscription
// sets its own price when it's made (the "plan" override on POST /v1/billing/subscriptions). So one approval covers
// any mix of programs and people, and the total is always the database's (billing_start uses riyeser_bill, the same
// price list as the website). Plans and the product are made the first time they're needed and remembered in the
// database (billing_paypal_config), separately for sandbox and live.
//
// The amount, the programs and who may pay are all decided by the database AS THE CALLER (billing_start checks they
// own the business). PayPal's side (the subscription id, webhooks, the cancel) is recorded with the service role.
//
// Function secrets: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV (sandbox | live), PAYPAL_WEBHOOK_ID.
// Without the first three: "PayPal isn't set up yet" (the website hides Pay with PayPal; bank transfer still works).
// Without PAYPAL_WEBHOOK_ID: webhooks aren't verified yet, so they're refused (PayPal tries again later) and nobody
// can start a PayPal payment (it could never be confirmed). Secrets are never logged or sent back.

export type Env = (name: string) => string | undefined;
export type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; status: number; body: unknown }>;
export interface Deps {
  env?: Env;
  fetch?: typeof fetch;       // PayPal's API (a fake one in the tests)
  rpcAs?: (req: Request) => Rpc;   // the database as the person who called
  rpcService?: Rpc;           // the database as the service role
}

const NOT_SET_UP = "PayPal isn't set up yet. You can pay by bank transfer instead.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** PostgREST with someone's key: the caller's session, or the service role. */
function rpcWith(apikey: string, auth: string, env: Env): Rpc {
  const url = env("SUPABASE_URL") ?? "";
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
const defaultRpcAs = (env: Env) => (req: Request): Rpc =>
  rpcWith(req.headers.get("apikey") || env("SUPABASE_ANON_KEY") || "", req.headers.get("Authorization") ?? "", env);
const defaultRpcService = (env: Env): Rpc => {
  const k = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return rpcWith(k, `Bearer ${k}`, env);
};

export interface Setup { env: "sandbox" | "live" | null; clientId: string; secret: string; webhookId: string; credentials: boolean; webhooks: boolean; ready: boolean }
export function setup(env: Env): Setup {
  const e = (env("PAYPAL_ENV") ?? "").trim().toLowerCase();
  const mode = e === "live" ? "live" : e === "sandbox" ? "sandbox" : null;
  const clientId = (env("PAYPAL_CLIENT_ID") ?? "").trim();
  const secret = (env("PAYPAL_CLIENT_SECRET") ?? "").trim();
  const webhookId = (env("PAYPAL_WEBHOOK_ID") ?? "").trim();
  const credentials = !!(mode && clientId && secret);
  // Customers can only start paying in live mode. Practice (sandbox) mode stays closed to the public unless
  // PAYPAL_ALLOW_PRACTICE=1 is set, so nobody is sent to PayPal's practice site by mistake. Webhooks still work.
  const allowPractice = (env("PAYPAL_ALLOW_PRACTICE") ?? "").trim() === "1";
  const open = credentials && !!webhookId && (mode === "live" || allowPractice);
  return { env: mode, clientId, secret, webhookId, credentials, webhooks: credentials && !!webhookId, ready: open };
}
export const apiBase = (mode: "sandbox" | "live") => (mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");

// ---------------------------------------------------------------- PayPal's API
class PayPalError extends Error { constructor(public status: number, public detail: unknown) { super(`PayPal ${status}`); } }
const tokens = new Map<string, { token: string; until: number }>();
export function forgetTokens() { tokens.clear(); }
async function token(s: Setup, f: typeof fetch): Promise<string> {
  const key = `${s.env}:${s.clientId}`;
  const t = tokens.get(key);
  if (t && t.until > Date.now() + 60_000) return t.token;
  const r = await f(`${apiBase(s.env!)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${s.clientId}:${s.secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new PayPalError(r.status, "token");
  const b = await r.json();
  tokens.set(key, { token: b.access_token, until: Date.now() + (Number(b.expires_in) || 300) * 1000 });
  return b.access_token;
}
async function pp(s: Setup, f: typeof fetch, method: string, path: string, body?: unknown | string, extra: Record<string, string> = {}) {
  const r = await f(`${apiBase(s.env!)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token(s, f)}`, "Content-Type": "application/json", Accept: "application/json", ...extra },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let b: unknown = null;
  try { b = r.status === 204 ? null : await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new PayPalError(r.status, b);
  return b as Record<string, unknown>;
}

const PLACEHOLDER = { fixed_price: { value: "1.00", currency_code: "USD" } };
const cycle = (seq: number, unit: "MONTH" | "YEAR", tenure: "TRIAL" | "REGULAR", total: number) =>
  ({ frequency: { interval_unit: unit, interval_count: 1 }, tenure_type: tenure, sequence: seq, total_cycles: total, pricing_scheme: PLACEHOLDER });

/** The product and plan for this billing period (made once, then remembered in the database). */
async function planFor(s: Setup, f: typeof fetch, svc: Rpc, period: "monthly" | "yearly", early: boolean): Promise<string> {
  const cfgR = await svc("billing_paypal_config", { env: s.env });
  const cfg = (cfgR.ok && cfgR.body && typeof cfgR.body === "object" ? cfgR.body : {}) as Record<string, string>;
  const key = `plan.${period}${early ? ".eb" : ""}`;
  if (cfg[key]) return cfg[key];
  let product = cfg.product;
  if (!product) {
    const p = await pp(s, f, "POST", "/v1/catalogs/products", { name: "Riyeser", description: "Riyeser programs for your business", type: "SERVICE", category: "SOFTWARE" },
      { "PayPal-Request-Id": `riyeser-product-${s.env}` });
    product = String(p.id);
    await svc("billing_paypal_config_set", { env: s.env, k: "product", v: product });
  }
  const unit = period === "yearly" ? "YEAR" : "MONTH";
  const cycles = early ? [cycle(1, unit, "TRIAL", period === "yearly" ? 1 : 12), cycle(2, unit, "REGULAR", 0)] : [cycle(1, unit, "REGULAR", 0)];
  const plan = await pp(s, f, "POST", "/v1/billing/plans", {
    product_id: product, name: `Riyeser ${period}${early ? " (early bird first year)" : ""}`, status: "ACTIVE",
    description: "The price is set for each business when it subscribes.",
    billing_cycles: cycles,
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: "CONTINUE", payment_failure_threshold: 3 },
  }, { "PayPal-Request-Id": `riyeser-${key}-${s.env}-${product}` });
  await svc("billing_paypal_config_set", { env: s.env, k: key, v: String(plan.id) });
  return String(plan.id);
}

/** PayPal's start_time for a first-charge date (YYYY-MM-DD, UTC midnight), or null when that's not in the future. */
export function startTime(day: unknown, now = Date.now()): string | null {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && t > now + 60_000 ? new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}
const price = (n: unknown) => ({ fixed_price: { value: Number(n).toFixed(2), currency_code: "USD" } });
const SITES = ["https://riyeser.com", "https://www.riyeser.com"];
function returnBase(req: Request, env: Env): string {
  const allowed = [...SITES, ...(env("SITE_URL") ? [env("SITE_URL")!.replace(/\/+$/, "")] : [])];
  const o = req.headers.get("Origin") ?? "";
  return (allowed.includes(o) ? o : allowed[0]) + "/link/";
}
const plainDbError = (b: unknown) => {
  const m = b && typeof b === "object" ? String((b as Record<string, unknown>).message ?? "") : "";
  return m || "Riyeser couldn't start that payment. Try again, or contact Riyeser.";
};

// ---------------------------------------------------------------- the routes
export async function handle(req: Request, deps: Deps = {}): Promise<Response> {
  const env: Env = deps.env ?? ((k) => Deno.env.get(k));
  const f = deps.fetch ?? fetch;
  const s = setup(env);
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const route = path.split("/").pop();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // Practice (sandbox) mode is open only to Riyeser HQ staff who manage licences (the owner), signed in,
  // so the owner can still test while customers never reach PayPal's practice site.
  const hasBearer = /^Bearer\s+\S+/.test(req.headers.get("Authorization") ?? "");
  let practice = false;
  if (!s.ready && s.env === "sandbox" && s.webhooks && hasBearer) {
    try { const r = await (deps.rpcAs ?? defaultRpcAs(env))(req)("hq_can", { perm: "licences.manage" }); practice = r.ok && r.body === true; }
    catch { practice = false; }
  }
  const open = s.ready || practice;

  if (req.method === "GET" && route === "status") {
    if (practice) return json(200, { ready: true, practice: true, env: s.env, credentials: s.credentials, webhooks: s.webhooks,
      message: "Practice mode: only you (Riyeser HQ) can see Pay with PayPal. Use a PayPal sandbox buyer account." });
    return json(200, { ready: s.ready, env: s.env, credentials: s.credentials, webhooks: s.webhooks,
      message: s.ready ? "PayPal is set up." : !s.credentials ? "PayPal isn't set up yet." : !s.webhooks ? "Webhooks aren't verified yet: add PAYPAL_WEBHOOK_ID and deploy again."
        : "PayPal is in practice mode, so customers can't start paying. Switch PAYPAL_ENV to live (or set PAYPAL_ALLOW_PRACTICE=1 to test)." });
  }
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  const svc = deps.rpcService ?? defaultRpcService(env);

  if (route === "webhook") {
    if (!s.credentials) return json(503, { error: "PayPal isn't set up yet." });
    if (!s.webhookId) return json(503, { error: "Webhooks aren't verified yet: PAYPAL_WEBHOOK_ID isn't set, so this event was refused." });
    const raw = await req.text();
    const h = (n: string) => req.headers.get(n) ?? "";
    const sig = { auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time") };
    if (Object.values(sig).some((v) => !v)) return json(400, { error: "Not a PayPal webhook (signature headers missing)." });
    let ev: { id?: string; event_type?: string; resource?: unknown };
    try { ev = JSON.parse(raw); } catch { return json(400, { error: "Not JSON." }); }
    if (!ev.id || !ev.event_type) return json(400, { error: "Not a PayPal event." });
    // The event goes to PayPal exactly as it came (re-encoding it could change the bytes the signature covers).
    const verifyBody = `{${Object.entries({ ...sig, webhook_id: s.webhookId }).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")},"webhook_event":${raw}}`;
    let ok = false;
    try { ok = (await pp(s, f, "POST", "/v1/notifications/verify-webhook-signature", verifyBody)).verification_status === "SUCCESS"; }
    catch (e) { if (e instanceof PayPalError && e.status >= 500) return json(502, { error: "PayPal didn't answer. It will send the event again." }); }
    if (!ok) return json(401, { error: "The signature didn't check out, so this event was ignored." });
    const r = await svc("billing_paypal_event", { event_id: ev.id, event_type: ev.event_type, resource: ev.resource ?? {}, env: s.env });
    if (!r.ok) return json(500, { error: "Riyeser couldn't record it. PayPal will send it again." });
    return json(200, { result: r.body });
  }

  // subscribe and cancel: the owner, signed in
  if (route !== "subscribe" && route !== "cancel") return json(404, { error: "Not found." });
  // Cancelling an existing subscription always works once PayPal is set up; starting one needs `open`.
  if (route === "cancel" ? !s.webhooks : !open) return json(503, { error: NOT_SET_UP });
  if (!/^Bearer\s+\S+/.test(req.headers.get("Authorization") ?? "")) return json(401, { error: "Sign in to your Riyeser account first." });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(400, { error: "Send { ws, modules, people, billing }." }); }
  const ws = String(b.ws ?? "");
  if (!UUID.test(ws)) return json(400, { error: "Send the business's id (ws)." });
  const rpc = (deps.rpcAs ?? defaultRpcAs(env))(req);

  try {
    if (route === "cancel") {
      const c = await rpc("billing_cancel_start", { ws });
      if (!c.ok) return json(c.status === 401 ? 401 : 403, { error: plainDbError(c.body) });
      const x = c.body as { order_id: string; subscription_id: string; paid_through?: string };
      try {
        await pp(s, f, "POST", `/v1/billing/subscriptions/${encodeURIComponent(x.subscription_id)}/cancel`, { reason: "Cancelled by the business owner on riyeser.com" });
      } catch (e) {
        // 422: PayPal says it's already cancelled or expired. Record that too.
        if (!(e instanceof PayPalError && e.status === 422)) throw e;
      }
      await svc("billing_paypal_cancelled", { order_id: x.order_id });
      return json(200, { ok: true, works_until: x.paid_through ?? null });
    }

    const mods = Array.isArray(b.modules) ? b.modules.map(String).slice(0, 10) : [];
    const period = b.billing === "yearly" ? "yearly" : "monthly";
    const st = await rpc("billing_start", { ws, mods, people: Math.trunc(Number(b.people) || 3), billing_period: period, pay_method: "paypal" });
    if (!st.ok) return json(st.status === 401 ? 401 : 403, { error: plainDbError(st.body) });
    const o = st.body as { id: string; ref: string; amount: number; first_amount: number | null; early_bird: boolean; early_cycles: number; module_names: string[]; starts_on?: string | null };
    const early = !!o.early_bird && o.first_amount != null && o.early_cycles > 0;
    const plan = await planFor(s, f, svc, period, early);
    const base = returnBase(req, env);
    const cycles = early
      ? [{ sequence: 1, total_cycles: o.early_cycles, pricing_scheme: price(o.first_amount) }, { sequence: 2, total_cycles: 0, pricing_scheme: price(o.amount) }]
      : [{ sequence: 1, total_cycles: 0, pricing_scheme: price(o.amount) }];
    // The first charge waits for the end of the free trial (the database's starts_on, S10): PayPal's start_time.
    // Today (or a date that isn't later than now) means PayPal charges straight away, as before.
    const start = startTime(o.starts_on);
    const sub = await pp(s, f, "POST", "/v1/billing/subscriptions", {
      plan_id: plan,
      custom_id: o.id,
      ...(start ? { start_time: start } : {}),
      plan: { billing_cycles: cycles },
      application_context: {
        brand_name: "Riyeser", locale: "en-AU", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW",
        payment_method: { payer_selected: "PAYPAL", payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED" },
        return_url: `${base}?paid=${encodeURIComponent(o.ref)}`,
        cancel_url: `${base}?paycancel=${encodeURIComponent(o.ref)}`,
      },
    }, { "PayPal-Request-Id": `riyeser-${o.id}` });
    const approve = ((sub.links as { rel: string; href: string }[]) ?? []).find((l) => l.rel === "approve");
    if (!sub.id || !approve) return json(502, { error: "PayPal didn't give a link to approve. Try again in a minute." });
    const saved = await svc("billing_paypal_created", { order_id: o.id, subscription_id: String(sub.id), env: s.env });
    if (!saved.ok) return json(500, { error: "Riyeser couldn't save the PayPal subscription. Try again." });
    return json(200, { approve_url: approve.href, ref: o.ref });
  } catch (e) {
    if (e instanceof PayPalError) {
      console.error(`paypal ${route}: PayPal answered ${e.status}`);   // never the request, the token or the secrets
      return json(502, { error: e.status === 401 ? "PayPal didn't accept Riyeser's PayPal keys. Contact Riyeser." : "PayPal didn't answer. Try again in a minute." });
    }
    console.error(`paypal ${route}: ${(e as Error).message}`);
    return json(500, { error: "Something went wrong. Try again in a minute." });
  }
}
