// The "api" Edge Function (index.ts serves this): Riyeser's public API for websites and online shops.
// The contract is docs/api/openapi.yaml. Everything here is tested by api_test.ts against a pretend database; the
// database side (api_* in website/team/team-chat.sql on module/desk-assistant) is tested on real PostgreSQL.
//
//   GET  /v1/ping                                   no key: {ok}; with a key: which business, mode and permissions
//   POST /v1/bookings | /v1/orders | /v1/enquiries | /v1/customers
//   POST /v1/quotes/{ref}/accept | /v1/invoices/{ref}/payments
//   GET  /v1/catalog | /v1/prices | /v1/stock | /v1/availability | /v1/availability/slots | /v1/events/{id}
//   GET  /v1/pages/{address} | …/slots | …/events/{id}, POST …/bookings
//                                                   the hosted booking page (riyeser.com/book/{address}): no key in the
//                                                   browser; the address finds the page's own key (api_page_auth)
//   POST /internal/dispatch   the webhook dispatcher + tidy-up (the service role key, from api-webhooks.yml)
//   POST /internal/kick       a linked PC asks for its business's webhooks to go now ({ws, device}, its own sign-in)
//
// Keys: "Authorization: Bearer rk_…". Only the key's SHA-256 is sent to the database (api_auth), with the service
// role, which also checks the internet address list and counts the request (rate limits). The key itself is never
// logged or stored. Browsers: only from the key's allowed websites (CORS); a secret key with no allowed websites is
// refused from a browser. Writes: JSON up to 64 KB, checked (validate.ts), with an optional Idempotency-Key.
// Errors are always {"error": {"code", "message", "details"?}}. Every request with a known key is logged (the route,
// never the query or references; the address truncated).
// Deployed with --no-verify-jwt: API keys aren't Supabase sign-ins (this checks them itself).
import { canonical, SKU, validate, type Kind } from "./validate.ts";
import { dispatch, safeEqual, sha256Hex, type Rpc } from "./webhooks.ts";

export type { Rpc };
type Env = (k: string) => string | undefined;
export interface Opts {
  rpc?: Rpc;                               // the database as the service role
  rpcAs?: (req: Request) => Rpc;           // the database as the caller (for /internal/kick)
  env?: Env;
  now?: () => number;
  fetch?: typeof fetch;                    // for webhooks
  waitUntil?: (p: Promise<unknown>) => void;
}

export const VERSION = "2026-11-26";
export const MAX_BODY = 65536;
export const KEY_RE = /^rk_(?:pub_)?(?:live|test)_[0-9a-f]{48}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEM = /^[A-Za-z0-9._:-]{1,100}$/;

export const STATUS: Record<string, number> = {
  missing_key: 401, invalid_key: 401, key_revoked: 401,
  ip_not_allowed: 403, origin_not_allowed: 403, secret_key_in_browser: 403, missing_scope: 403, business_closed: 403,
  plan_required: 402, bookings_licence_required: 402, pos_or_accounting_licence_required: 402,
  rate_limited: 429, daily_limit: 429,
  invalid_json: 400, invalid_request: 400, invalid_idempotency_key: 400,
  invalid_payload: 422, idempotency_conflict: 409, slot_not_available: 409,
  payload_too_large: 413, unsupported_media_type: 415, not_found: 404, method_not_allowed: 405,
  unavailable: 503, internal: 500, page_not_found: 404,
};
/** A booking page's address (riyeser.com/book/{address}): what api_page_auth accepts. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/** Where the booking page lives, for the booking's metadata.source_page (BOOKING_PAGE_URL overrides it). */
const PAGE_URL = "https://riyeser.com/book/";

type Route = { method: "GET" | "POST"; re: RegExp; path: string; kind?: Kind; read?: string; scope: string | null; page?: "profile" | "slots" | "booking" | "event" };
const ROUTES: Route[] = [
  { method: "GET", re: /^\/v1\/ping$/, path: "/v1/ping", scope: null },
  { method: "POST", re: /^\/v1\/bookings$/, path: "/v1/bookings", kind: "booking", scope: "bookings:write" },
  { method: "POST", re: /^\/v1\/orders$/, path: "/v1/orders", kind: "order", scope: "orders:write" },
  { method: "POST", re: /^\/v1\/enquiries$/, path: "/v1/enquiries", kind: "enquiry", scope: "enquiries:write" },
  { method: "POST", re: /^\/v1\/customers$/, path: "/v1/customers", kind: "customer", scope: "customers:write" },
  { method: "POST", re: /^\/v1\/quotes\/([^/]+)\/accept$/, path: "/v1/quotes/{ref}/accept", kind: "quote_accept", scope: "quotes:write" },
  { method: "POST", re: /^\/v1\/invoices\/([^/]+)\/payments$/, path: "/v1/invoices/{ref}/payments", kind: "invoice_payment", scope: "payments:write" },
  { method: "GET", re: /^\/v1\/catalog$/, path: "/v1/catalog", read: "catalog", scope: "catalog:read" },
  { method: "GET", re: /^\/v1\/prices$/, path: "/v1/prices", read: "prices", scope: "prices:read" },
  { method: "GET", re: /^\/v1\/stock$/, path: "/v1/stock", read: "stock", scope: "stock:read" },
  { method: "GET", re: /^\/v1\/availability$/, path: "/v1/availability", read: "availability", scope: "availability:read" },
  { method: "GET", re: /^\/v1\/availability\/slots$/, path: "/v1/availability/slots", read: "slots", scope: "availability:read" },
  { method: "GET", re: /^\/v1\/events\/([^/]+)$/, path: "/v1/events/{id}", read: "event", scope: null },
  // the hosted booking page: the same as the widget's routes, with the page's address instead of a key
  { method: "GET", re: /^\/v1\/pages\/([^/]+)$/, path: "/v1/pages/{address}", page: "profile", scope: "availability:read" },
  { method: "GET", re: /^\/v1\/pages\/([^/]+)\/slots$/, path: "/v1/pages/{address}/slots", page: "slots", read: "slots", scope: "availability:read" },
  { method: "POST", re: /^\/v1\/pages\/([^/]+)\/bookings$/, path: "/v1/pages/{address}/bookings", page: "booking", kind: "booking", scope: "bookings:write" },
  { method: "GET", re: /^\/v1\/pages\/([^/]+)\/events\/([^/]+)$/, path: "/v1/pages/{address}/events/{id}", page: "event", read: "event", scope: null },
];

const BASE_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

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
const serviceRpc = (env: Env): Rpc => { const k = env("SUPABASE_SERVICE_ROLE_KEY") ?? ""; return rpcWith(k, `Bearer ${k}`, env); };
const callerRpc = (env: Env) => (req: Request): Rpc =>
  rpcWith(req.headers.get("apikey") || env("SUPABASE_ANON_KEY") || "", req.headers.get("Authorization") ?? "", env);

/** The part after the function's name: /functions/v1/api/v1/orders and /api/v1/orders are both /v1/orders. */
export function routePath(pathname: string): string {
  let p = pathname.replace(/\/+$/, "") || "/";
  p = p.replace(/^\/functions\/v1(?=\/)/, "");
  p = p.replace(/^\/api(?=\/|$)/, "");
  return p || "/";
}

/** Is this browser origin one of the key's websites? https://*.example.com allows any subdomain (not example.com itself). */
export function originAllowed(origin: string, allowed: string[]): boolean {
  const o = origin.toLowerCase();
  let u: URL;
  try { u = new URL(o); } catch { return false; }
  if (u.origin !== o) return false;
  return allowed.some((a) => {
    if (a === o) return true;
    const m = /^(https?):\/\/\*\.([^/:]+)(:\d+)?$/.exec(a);
    if (!m) return false;
    return u.protocol === `${m[1]}:` && u.hostname.endsWith(`.${m[2]}`) && (u.port ? `:${u.port}` : "") === (m[3] ?? "");
  });
}

export function clientIp(req: Request): string | null {
  const raw = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
  return /^[0-9a-fA-F:.]{2,45}$/.test(raw) ? raw : null;
}

async function readLimited(req: Request, max: number): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > max) return null;
  if (!req.body) return "";
  const r = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    n += value.length;
    if (n > max) { await r.cancel(); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return new TextDecoder().decode(all);
}

class Out {
  headers: Record<string, string>;
  constructor(public requestId: string) { this.headers = { ...BASE_HEADERS, "X-Request-Id": requestId }; }
  json(status: number, body: unknown, extra: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { ...this.headers, ...extra } });
  }
  err(code: string, message: string, extra: Record<string, string> = {}, details?: unknown) {
    return this.json(STATUS[code] ?? 400, { error: details ? { code, message, details } : { code, message } }, extra);
  }
}

// GET query -> what api_read takes (checked here, so the database only sees clean values)
function readParams(what: string, q: URLSearchParams, idPart: string | undefined): { params: Record<string, unknown> } | { problem: string } {
  const p: Record<string, unknown> = {};
  const lim = q.get("limit");
  if (lim !== null) { const n = Number(lim); if (!Number.isInteger(n) || n < 1 || n > 500) return { problem: "limit is a whole number from 1 to 500." }; p.limit = n; }
  const after = q.get("after");
  if (after !== null) { if (!SKU.test(after)) return { problem: "after is the last SKU of the page before (\"next\")." }; p.after = after; }
  const sku = q.get("sku");
  if (sku !== null) {
    const list = sku.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length || list.length > 200 || !list.every((s) => SKU.test(s))) return { problem: "sku is up to 200 SKUs, separated by commas." };
    p.skus = list;
  }
  if (what === "catalog") {
    const t = q.get("type");
    if (t !== null) { if (t !== "product" && t !== "service") return { problem: "type is product or service." }; p.type = t; }
    const s = q.get("updated_since");
    if (s !== null) { if (Number.isNaN(Date.parse(s))) return { problem: "updated_since is a date and time (ISO 8601)." }; p.updated_since = new Date(s).toISOString(); }
  }
  if (what === "slots") {
    const svc = q.get("service");
    if (!svc || !SKU.test(svc)) return { problem: "service is the SKU of a service from GET /v1/availability." };
    p.service = svc;
    const from = q.get("from");
    if (from !== null) { if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from))) return { problem: "from is a date: YYYY-MM-DD." }; p.from = from; }
    const days = q.get("days");
    if (days !== null) { const n = Number(days); if (!Number.isInteger(n) || n < 1 || n > 31) return { problem: "days is from 1 to 31." }; p.days = n; }
    const staff = q.get("staff");
    if (staff !== null) { if (!SKU.test(staff)) return { problem: "staff is a staff ref from GET /v1/availability." }; p.staff = staff; }
    const ps = q.get("party_size");
    if (ps !== null) { const n = Number(ps); if (!Number.isInteger(n) || n < 1 || n > 1000) return { problem: "party_size is from 1 to 1000." }; p.party_size = n; }
  }
  if (what === "event") p.id = idPart;
  return { params: p };
}

type Auth = { key_id: string; workspace_id: string; kind: "secret" | "widget"; mode: "live" | "test"; scopes: string[];
  allowed_origins: string[]; name: string; rate?: { limit: number; remaining: number; reset: number } };

export async function handle(req: Request, opts: Opts = {}): Promise<Response> {
  const env: Env = opts.env ?? ((k) => Deno.env.get(k));
  const now = opts.now ?? Date.now;
  const started = now();
  const out = new Out(crypto.randomUUID());
  const url = new URL(req.url);
  const path = routePath(url.pathname);
  const origin = req.headers.get("origin");
  const edge = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const later = opts.waitUntil ?? (edge ? (p: Promise<unknown>) => edge.waitUntil(p) : null);
  const run = async (p: Promise<unknown>) => { const q = p.catch(() => {}); if (later) later(q); else await q; };

  // CORS preflight: answered for any website (browsers send no key with it); the request itself is then checked.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": origin ?? "*", "Vary": "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key", "Access-Control-Max-Age": "600",
    } });
  }

  if (path.startsWith("/internal/")) return internal(req, path, out, env, opts);

  const matches = ROUTES.filter((r) => r.re.test(path));
  if (!matches.length) return out.err("not_found", "There's nothing here. The API's addresses start with /v1/ (see riyeser.com/developers).");
  const route = matches.find((r) => r.method === req.method);
  if (!route) return out.err("method_not_allowed", `Use ${matches.map((r) => r.method).join(" or ")} here.`, { Allow: matches.map((r) => r.method).join(", ") });
  const idPart = route.re.exec(path)?.[1];
  if (route.page) return pageRequest(req, url, route, out, env, opts, origin, started, now, run);

  const authz = req.headers.get("authorization") ?? "";
  if (route.path === "/v1/ping" && !authz) return out.json(200, { ok: true, version: VERSION });
  if (!authz) return out.err("missing_key", "Send your API key: Authorization: Bearer rk_…");
  const key = /^Bearer\s+(\S+)$/i.exec(authz)?.[1] ?? "";
  if (!KEY_RE.test(key)) return out.err("invalid_key", "That API key isn't right.");
  if (!env("SUPABASE_URL") && !opts.rpc) return out.err("unavailable", "The Riyeser API isn't set up yet.");
  const rpc = opts.rpc ?? serviceRpc(env);
  const ip = clientIp(req);

  let a: { ok: boolean; status: number; body: unknown };
  try { a = await rpc("api_auth", { key_hash: await sha256Hex(key), ip }); } catch { a = { ok: false, status: 0, body: null }; }
  if (!a.ok || !a.body || typeof a.body !== "object") return out.err("unavailable", "The Riyeser API is busy. Try again in a minute.", { "Retry-After": "30" });
  const ab = a.body as { error?: { code: string; message: string }; retry_after?: number; key_id?: string };
  const log = (status: number, code: string | null, keyId: string) =>
    run(rpc("api_log_request", { key_id: keyId, method: req.method, path: route.path, status, ms: Math.max(0, Math.round(now() - started)), ip, code }));
  if (ab.error) {
    const extra: Record<string, string> = ab.retry_after ? { "Retry-After": String(ab.retry_after) } : {};
    if (ab.key_id) await log(STATUS[ab.error.code] ?? 400, ab.error.code, ab.key_id);
    return out.err(ab.error.code, ab.error.message, extra);
  }
  const auth = a.body as Auth;
  const res = await withKey(req, url, route, idPart, auth, origin, out, rpc, run, opts, env);
  const code = res.status >= 400 ? ((await res.clone().json().catch(() => null))?.error?.code ?? null) : null;
  await log(res.status, code, auth.key_id);
  return res;
}

// The booking page: the page's address (not a key) says which business. api_page_auth finds the page's own widget key
// (only availability:read and bookings:write, only from the booking page's websites), counts the visitor and the page
// (rate limits), and every refusal says which websites may read it, so the page can show "not taking online bookings".
async function pageRequest(req: Request, url: URL, route: Route, out: Out, env: Env, opts: Opts, origin: string | null, started: number,
  now: () => number, run: (p: Promise<unknown>) => Promise<void>): Promise<Response> {
  const m = route.re.exec(routePath(url.pathname)) ?? [];
  const slug = (m[1] ?? "").toLowerCase();
  const idPart = route.page === "event" ? m[2] : undefined;
  if (req.headers.get("authorization")) return out.err("invalid_request", "The booking page needs no key: leave out the Authorization header.");
  if (!SLUG_RE.test(slug)) return out.err("page_not_found", "This business isn't taking online bookings here.");
  if (!env("SUPABASE_URL") && !opts.rpc) return out.err("unavailable", "The Riyeser API isn't set up yet.");
  const rpc = opts.rpc ?? serviceRpc(env);
  const ip = clientIp(req);
  let a: { ok: boolean; status: number; body: unknown };
  try { a = await rpc("api_page_auth", { slug, ip }); } catch { a = { ok: false, status: 0, body: null }; }
  if (!a.ok || !a.body || typeof a.body !== "object") return out.err("unavailable", "The Riyeser API is busy. Try again in a minute.", { "Retry-After": "30" });
  const ab = a.body as { error?: { code: string; message: string }; retry_after?: number; key_id?: string; origins?: string[] };
  const log = (status: number, code: string | null, keyId: string) =>
    run(rpc("api_log_request", { key_id: keyId, method: req.method, path: route.path, status, ms: Math.max(0, Math.round(now() - started)), ip, code }));
  if (ab.error) {
    const extra: Record<string, string> = ab.retry_after ? { "Retry-After": String(ab.retry_after) } : {};
    if (origin && originAllowed(origin, ab.origins ?? [])) Object.assign(extra, { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Expose-Headers": "X-Request-Id, Retry-After" });
    if (ab.key_id) await log(STATUS[ab.error.code] ?? 400, ab.error.code, ab.key_id);
    return out.err(ab.error.code, ab.error.message, extra);
  }
  const auth = { ...(a.body as Auth), kind: "widget" as const };   // always treated as a widget key: browsers only, its websites only
  const res = await withKey(req, url, route, idPart, auth, origin, out, rpc, run, opts, env, slug);
  const code = res.status >= 400 ? ((await res.clone().json().catch(() => null))?.error?.code ?? null) : null;
  await log(res.status, code, auth.key_id);
  return res;
}

async function withKey(req: Request, url: URL, route: Route, idPart: string | undefined, auth: Auth, origin: string | null, out: Out, rpc: Rpc,
  run: (p: Promise<unknown>) => Promise<void>, opts: Opts, env: Env, slug?: string): Promise<Response> {
  if (auth.rate) {
    Object.assign(out.headers, { "RateLimit-Limit": String(auth.rate.limit), "RateLimit-Remaining": String(auth.rate.remaining), "RateLimit-Reset": String(auth.rate.reset) });
  }
  // Browsers: only from the key's websites. Widget keys only ever from them.
  if (origin) {
    if (!originAllowed(origin, auth.allowed_origins ?? [])) {
      return auth.kind === "secret" && !(auth.allowed_origins ?? []).length
        ? out.err("secret_key_in_browser", "A secret key must never be in a web page. Use a widget key (Management → Connections) for the browser.")
        : out.err("origin_not_allowed", "This key can't be used from this website. Add it to the key's websites in Riyeser.");
    }
    Object.assign(out.headers, { "Access-Control-Allow-Origin": origin, "Vary": "Origin",
      "Access-Control-Expose-Headers": "X-Request-Id, Idempotent-Replayed, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Location" });
  } else if (auth.kind === "widget") {
    return out.err("origin_not_allowed", "A widget key only works in a web browser, on the key's websites.");
  }
  if (route.scope && !auth.scopes.includes(route.scope)) {
    return out.err("missing_scope", `This key isn't allowed to do that (it needs ${route.scope}).`);
  }
  if (route.page === "profile") {
    const r = await rpc("api_page_profile", { key_id: auth.key_id });
    if (!r.ok || !r.body) return out.err("unavailable", "The Riyeser API is busy. Try again in a minute.", { "Retry-After": "30" });
    const b = r.body as { error?: { code: string; message: string } };
    if (b.error) return out.err(b.error.code, b.error.message);
    return out.json(200, r.body);
  }
  if (route.path === "/v1/ping") {
    return out.json(200, { ok: true, version: VERSION, workspace_id: auth.workspace_id, key: { name: auth.name, kind: auth.kind, mode: auth.mode, scopes: auth.scopes } });
  }

  if (route.read) {
    const rp = readParams(route.read, url.searchParams, idPart);
    if ("problem" in rp) return out.err("invalid_request", rp.problem);
    if (route.read === "event" && !UUID.test(idPart ?? "")) return out.err("not_found", "There's no event with that id.");
    const r = await rpc("api_read", { key_id: auth.key_id, what: route.read, params: rp.params });
    if (!r.ok || !r.body) return out.err("unavailable", "The Riyeser API is busy. Try again in a minute.", { "Retry-After": "30" });
    const b = r.body as { error?: { code: string; message: string } };
    if (b.error) return out.err(b.error.code, b.error.message);
    return out.json(200, { ...(r.body as object), test: auth.mode === "test" });
  }

  // a write
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("application/json")) return out.err("unsupported_media_type", "Send JSON (Content-Type: application/json).");
  const idem = req.headers.get("idempotency-key");
  if (idem !== null && !IDEM.test(idem)) return out.err("invalid_idempotency_key", "Idempotency-Key: up to 100 letters, digits and . _ : -");
  const text = await readLimited(req, MAX_BODY);
  if (text === null) return out.err("payload_too_large", "That's too big (64 KB at most).");
  let body: unknown;
  try { body = JSON.parse(text); } catch { return out.err("invalid_json", "That isn't valid JSON."); }
  const v = validate(route.kind!, body, idPart);
  if (!v.ok) {
    const more = v.problems.length > 1 ? ` (and ${v.problems.length - 1} more)` : "";
    return out.err("invalid_payload", v.problems[0].message + more, {}, v.problems);
  }
  if (route.page === "booking") {   // say where it came from (the PC shows it with the booking)
    const meta = { ...((v.payload as { metadata?: Record<string, unknown> }).metadata ?? {}) };
    meta.channel = "booking_page";
    meta.source_page = (env("BOOKING_PAGE_URL") || PAGE_URL) + slug;
    (v.payload as { metadata?: Record<string, unknown> }).metadata = meta;
  }
  const bodyHash = await sha256Hex(`${route.kind}\n${canonical(v.payload)}`);
  const r = await rpc("api_submit", { key_id: auth.key_id, kind: route.kind, payload: v.payload, idempotency_key: idem, body_hash: bodyHash, source: route.page ? "page" : "api" });
  if (!r.ok || !r.body) return out.err("unavailable", "The Riyeser API is busy. Try again in a minute (with the same Idempotency-Key).", { "Retry-After": "30" });
  const b = r.body as { error?: { code: string; message: string }; id: string; kind: string; status: string; test: boolean; created_at: string; replay: boolean };
  if (b.error) return out.err(b.error.code, b.error.message);
  if (!b.replay) await run(dispatch(rpc, { ws: auth.workspace_id, max: 10, fetch: opts.fetch, now: opts.now }));   // this business's webhooks, now
  return out.json(b.replay ? 200 : 202, { id: b.id, kind: b.kind, status: b.status, test: b.test, created_at: b.created_at },
    { Location: `/v1/events/${b.id}`, ...(b.replay ? { "Idempotent-Replayed": "true" } : {}) });
}

async function internal(req: Request, path: string, out: Out, env: Env, opts: Opts): Promise<Response> {
  if (req.method !== "POST") return out.err("method_not_allowed", "Use POST.", { Allow: "POST" });
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const rpc = opts.rpc ?? serviceRpc(env);
  if (path === "/internal/dispatch") {
    const secrets = [env("SUPABASE_SERVICE_ROLE_KEY"), env("API_CRON_SECRET")].filter((s): s is string => !!s && s.length >= 20);
    // check every secret (no early exit), so the time doesn't say which one nearly matched
    let ok = false;
    for (const s of secrets) ok = safeEqual(token, s) || ok;
    if (!token || !ok) return out.err("invalid_key", "Not allowed.");
    const d = await dispatch(rpc, { max: 100, fetch: opts.fetch, now: opts.now });
    const s = await rpc("api_sweep", {});
    return out.json(200, { ...d, sweep: s.ok ? s.body : null });
  }
  if (path === "/internal/kick") {
    if (!token) return out.err("missing_key", "Sign in first.");
    let b: { ws?: unknown; device?: unknown };
    try { b = JSON.parse((await readLimited(req, 4096)) ?? ""); } catch { return out.err("invalid_json", "Send { ws, device }."); }
    if (!UUID.test(String(b.ws ?? "")) || !UUID.test(String(b.device ?? ""))) return out.err("invalid_request", "Send { ws, device }.");
    const as = (opts.rpcAs ?? callerRpc(env))(req);
    const okPc = await as("api_pc_ok", { ws: b.ws, device: b.device });
    if (!okPc.ok || okPc.body !== true) return out.err("invalid_key", "Link this PC to the business first.");
    return out.json(200, await dispatch(rpc, { ws: String(b.ws), max: 20, fetch: opts.fetch, now: opts.now }));
  }
  return out.err("not_found", "There's nothing here.");
}
