// deno test supabase/functions/api — the public API against a pretend database (the real database side, api_* in
// website/team/team-chat.sql, is tested on PostgreSQL in website/team/test/rules-test.sql).
//  - auth: no key, a malformed key (never sent to the database), an unknown key; only the key's SHA-256 goes to the
//    database; ping; permissions (scopes); test keys answer test: true; licence errors are 402
//  - validation: plain messages with the field, 422 with details; bad JSON; not JSON; over 64 KB; booking in the past
//  - Idempotency-Key: the same request replays (200, Idempotent-Replayed), a different one is 409
//  - CORS: preflight; widget keys only from their websites; wildcard websites; secret keys refused in browsers
//  - rate limits: 429 with Retry-After, and logged; the request log has the route, never refs, queries or the key
//  - webhooks: the signature (and what receivers check), the dispatcher (headers, retries, unsafe addresses never
//    fetched), /internal/dispatch only with the service key, /internal/kick only for a linked PC
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { handle, originAllowed, routePath, type Rpc } from "./handler.ts";
import { canonical, validate } from "./validate.ts";
import { dispatch, safeEqual, safeUrl, sha256Hex, signatureHeader, verifySignature } from "./webhooks.ts";

const WS = "11111111-2222-4333-8444-555555555555";
const SECRET = "rk_live_" + "a1".repeat(24);
const TESTKEY = "rk_test_" + "b2".repeat(24);
const WIDGET = "rk_pub_live_" + "c3".repeat(24);
const NARROW = "rk_live_" + "d4".repeat(24);
const SERVICE = "service-role-key-for-tests-0123456789";
const ALL = ["bookings:write", "orders:write", "customers:write", "enquiries:write", "quotes:write", "payments:write", "stock:read", "prices:read", "availability:read", "catalog:read"];

type Key = { key_id: string; kind: "secret" | "widget"; mode: "live" | "test"; scopes: string[]; allowed_origins: string[]; name: string };
/** A pretend database: just enough of api_auth, api_submit, api_read, the log and the webhook queue. */
async function fakeDb(o: { limit?: number; gate?: string } = {}) {
  const keys = new Map<string, Key>();
  keys.set(await sha256Hex(SECRET), { key_id: "k-secret", kind: "secret", mode: "live", scopes: ALL, allowed_origins: [], name: "Shop" });
  keys.set(await sha256Hex(TESTKEY), { key_id: "k-test", kind: "secret", mode: "test", scopes: ALL, allowed_origins: ["http://localhost:3000"], name: "Test" });
  keys.set(await sha256Hex(WIDGET), { key_id: "k-widget", kind: "widget", mode: "live", scopes: ["availability:read", "bookings:write", "enquiries:write"],
    allowed_origins: ["https://salon.example.com", "https://*.example.org"], name: "Widget" });
  keys.set(await sha256Hex(NARROW), { key_id: "k-narrow", kind: "secret", mode: "live", scopes: ["enquiries:write"], allowed_origins: [], name: "Narrow" });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const inbox = new Map<string, { id: string; hash: string }>();
  const hits = new Map<string, number>();
  let n = 0;
  const rpc: Rpc = async (name, args) => {
    calls.push({ name, args });
    const ok = (body: unknown) => ({ ok: true, status: 200, body });
    if (name === "api_auth") {
      const k = keys.get(String(args.key_hash));
      if (!k) return ok({ error: { code: "invalid_key", message: "That API key isn't right." } });
      const c = (hits.get(k.key_id) ?? 0) + 1; hits.set(k.key_id, c);
      if (o.limit && c > o.limit) return ok({ error: { code: "rate_limited", message: "Too many requests with this key." }, retry_after: 42, key_id: k.key_id });
      return ok({ ...k, workspace_id: WS, rate: { limit: o.limit ?? 120, remaining: (o.limit ?? 120) - c, reset: 30 } });
    }
    if (name === "api_submit") {
      if (o.gate) return ok({ error: { code: o.gate, message: "Online bookings need Riyeser Bookings." } });
      const key = `${args.key_id}|${args.idempotency_key}`;
      const prev = args.idempotency_key ? inbox.get(key) : undefined;
      if (prev) {
        return prev.hash === args.body_hash
          ? ok({ id: prev.id, kind: args.kind, status: "waiting", test: args.key_id === "k-test", created_at: "2026-11-26T00:00:00Z", replay: true })
          : ok({ error: { code: "idempotency_conflict", message: "This Idempotency-Key was already used with a different request." } });
      }
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      if (args.idempotency_key) inbox.set(key, { id, hash: String(args.body_hash) });
      return ok({ id, kind: args.kind, status: "waiting", test: args.key_id === "k-test", created_at: "2026-11-26T00:00:00Z", replay: false });
    }
    if (name === "api_read") return ok(args.what === "event" ? { id: (args.params as { id: string }).id, status: "done", result: { reference: "BK-1" } } : { items: [], next: null });
    if (name === "api_log_request" || name === "api_webhook_result") return ok(null);
    if (name === "api_webhooks_due") return ok([]);
    if (name === "api_sweep") return ok({ inbox_removed: 0 });
    return { ok: false, status: 404, body: null };
  };
  return { rpc, calls, named: (x: string) => calls.filter((c) => c.name === x) };
}

const later: Promise<unknown>[] = [];
const opts = (rpc: Rpc, extra: Record<string, unknown> = {}) => ({ rpc, env: () => undefined, waitUntil: (p: Promise<unknown>) => { later.push(p); }, ...extra });
const BASE = "https://goaugynxeatzqzifpoes.supabase.co/functions/v1/api";
function req(method: string, path: string, o: { key?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const h: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.key) h.Authorization = `Bearer ${o.key}`;
  if (o.body !== undefined || o.raw !== undefined) h["Content-Type"] ??= "application/json";
  return new Request(BASE + path, { method, headers: h, body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined) });
}
const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
const booking = { service: "CUT", staff: "amy", start: future, customer: { name: "Kai", email: "Kai@Example.com" } };
const order = { customer: { name: "Pat", phone: "021 555 0101" }, items: [{ sku: "MUG", quantity: 2, unit_price: 12.5 }], currency: "nzd",
  fulfilment: { type: "pickup" }, payment: { status: "paid", method: "card", amount: 25 } };

Deno.test("routes: /functions/v1/api/v1/orders and /api/v1/orders are /v1/orders", () => {
  assertEquals(routePath("/functions/v1/api/v1/orders"), "/v1/orders");
  assertEquals(routePath("/api/v1/orders/"), "/v1/orders");
  assertEquals(routePath("/api"), "/");
});

Deno.test("auth: ping, missing, malformed and unknown keys; only the hash reaches the database", async () => {
  const db = await fakeDb();
  let r = await handle(req("GET", "/v1/ping"), opts(db.rpc));
  assertEquals(r.status, 200); assertEquals((await r.json()).ok, true);
  r = await handle(req("POST", "/v1/orders", { body: order }), opts(db.rpc));
  assertEquals(r.status, 401); assertEquals((await r.json()).error.code, "missing_key");
  r = await handle(req("POST", "/v1/orders", { key: "rk_live_short", body: order }), opts(db.rpc));
  assertEquals(r.status, 401); assertEquals((await r.json()).error.code, "invalid_key");
  assertEquals(db.calls.length, 0, "a malformed key never reaches the database");
  r = await handle(req("GET", "/v1/ping", { key: "rk_live_" + "0".repeat(48) }), opts(db.rpc));
  assertEquals(r.status, 401);
  r = await handle(req("GET", "/v1/ping", { key: SECRET }), opts(db.rpc));
  const b = await r.json();
  assertEquals(r.status, 200); assertEquals(b.workspace_id, WS); assertEquals(b.key.mode, "live");
  const sent = JSON.stringify(db.calls);
  assertFalse(sent.includes(SECRET.slice(8)), "the key itself is never sent to the database");
  assert(sent.includes(await sha256Hex(SECRET)), "its SHA-256 is");
  assertEquals(r.headers.get("RateLimit-Limit"), "120");
});

Deno.test("scopes, test mode and licence errors", async () => {
  const db = await fakeDb();
  let r = await handle(req("POST", "/v1/orders", { key: NARROW, body: order }), opts(db.rpc));
  assertEquals(r.status, 403);
  const e = await r.json();
  assertEquals(e.error.code, "missing_scope"); assertStringIncludes(e.error.message, "orders:write");
  assertEquals(db.named("api_submit").length, 0);
  r = await handle(req("POST", "/v1/orders", { key: TESTKEY, body: order }), opts(db.rpc));
  assertEquals(r.status, 202); assertEquals((await r.json()).test, true);
  r = await handle(req("GET", "/v1/stock", { key: TESTKEY }), opts(db.rpc));
  assertEquals((await r.json()).test, true);
  const gated = await fakeDb({ gate: "bookings_licence_required" });
  r = await handle(req("POST", "/v1/bookings", { key: SECRET, body: booking }), opts(gated.rpc));
  assertEquals(r.status, 402); assertEquals((await r.json()).error.code, "bookings_licence_required");
});

Deno.test("writes: accepted into the post box, cleaned, with a Location; webhooks dispatched for that business", async () => {
  const db = await fakeDb();
  const r = await handle(req("POST", "/v1/orders", { key: SECRET, body: { ...order, extra_field: "dropped" } }), opts(db.rpc));
  assertEquals(r.status, 202);
  const b = await r.json();
  assertEquals(b.status, "waiting"); assertEquals(r.headers.get("Location"), `/v1/events/${b.id}`);
  const p = db.named("api_submit")[0].args.payload as Record<string, unknown>;
  assertEquals(p.currency, "NZD"); assertFalse("extra_field" in p);
  await Promise.all(later.splice(0));
  assertEquals(db.named("api_webhooks_due")[0].args.only_ws, WS);
  // quotes and invoices take their reference from the address
  await handle(req("POST", "/v1/quotes/Q-1042/accept", { key: SECRET, body: { accepted_by: { name: "Lee" } } }), opts(db.rpc));
  await handle(req("POST", "/v1/invoices/INV%2F77/payments", { key: SECRET, body: { amount: 120.5, method: "card" } }), opts(db.rpc));
  const s = db.named("api_submit");
  assertEquals((s[1].args.payload as Record<string, unknown>).quote_ref, "Q-1042");
  assertEquals((s[2].args.payload as Record<string, unknown>).invoice_ref, "INV/77");
});

Deno.test("validation: plain messages, 422 with details, bad JSON, not JSON, too big", async () => {
  const db = await fakeDb();
  let r = await handle(req("POST", "/v1/bookings", { key: SECRET, body: { service: "CUT", start: "tomorrow at 9", customer: { name: "" } } }), opts(db.rpc));
  assertEquals(r.status, 422);
  const e = await r.json();
  assertEquals(e.error.code, "invalid_payload");
  const fields = e.error.details.map((d: { field: string }) => d.field);
  assert(fields.includes("start") && fields.includes("customer.name"), JSON.stringify(e));
  assertStringIncludes(e.error.details.find((d: { field: string }) => d.field === "start").message, "date and time with its time zone");
  r = await handle(req("POST", "/v1/orders", { key: SECRET, raw: "{not json" }), opts(db.rpc));
  assertEquals(r.status, 400); assertEquals((await r.json()).error.code, "invalid_json");
  r = await handle(req("POST", "/v1/orders", { key: SECRET, raw: "x=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } }), opts(db.rpc));
  assertEquals(r.status, 415);
  r = await handle(req("POST", "/v1/enquiries", { key: SECRET, body: { customer: { name: "A", email: "a@b.co" }, message: "x".repeat(70_000) } }), opts(db.rpc));
  assertEquals(r.status, 413);
  assertEquals(db.named("api_submit").length, 0);
  // the rules, one by one
  const past = validate("booking", { ...booking, start: "2020-01-01T09:00:00Z" });
  assert(!past.ok && past.problems[0].message === "start is in the past.");
  const noContact = validate("enquiry", { customer: { name: "A" }, message: "Hi" });
  assert(!noContact.ok && noContact.problems[0].field === "customer.email");
  const badQty = validate("order", { customer: { name: "A", email: "a@b.co" }, items: [{ sku: "X", quantity: 0 }] });
  assert(!badQty.ok && badQty.problems[0].message === "items[0].quantity must be more than 0.");
  const noItem = validate("order", { customer: { name: "A", email: "a@b.co" }, items: [{ quantity: 1 }] });
  assert(!noItem.ok && noItem.problems[0].message.includes("needs a sku or a name"));
  const money = validate("invoice_payment", { amount: 10.123456, method: "card" }, "INV-1");
  assert(!money.ok && money.problems[0].message.includes("decimal places"));
  const method = validate("invoice_payment", { amount: 10, method: "bitcoin" }, "INV-1");
  assert(!method.ok && method.problems[0].message.startsWith("method must be one of"));
  const ok = validate("customer", { name: " Max\u0000 ", email: "MAX@example.com", tags: ["vip"], metadata: { crm_id: 42 } });
  assert(ok.ok && ok.payload.name === "Max" && ok.payload.email === "max@example.com");
  const badRef = validate("quote_accept", { accepted_by: { name: "Lee" } }, "Q 1'; drop");
  assert(!badRef.ok && badRef.problems[0].field === "ref");
});

Deno.test("Idempotency-Key: same request replays, a different one is refused", async () => {
  const db = await fakeDb();
  const h = { "Idempotency-Key": "order-1001" };
  const a = await handle(req("POST", "/v1/orders", { key: SECRET, body: order, headers: h }), opts(db.rpc));
  assertEquals(a.status, 202);
  const id = (await a.json()).id;
  // the same body with its keys in another order and other spacing is the same request
  const same = JSON.stringify({ items: order.items, payment: order.payment, fulfilment: order.fulfilment, currency: "nzd", customer: order.customer }, null, 2);
  const b = await handle(req("POST", "/v1/orders", { key: SECRET, raw: same, headers: h }), opts(db.rpc));
  assertEquals(b.status, 200); assertEquals(b.headers.get("Idempotent-Replayed"), "true"); assertEquals((await b.json()).id, id);
  const c = await handle(req("POST", "/v1/orders", { key: SECRET, body: { ...order, notes: "changed" }, headers: h }), opts(db.rpc));
  assertEquals(c.status, 409); assertEquals((await c.json()).error.code, "idempotency_conflict");
  const d = await handle(req("POST", "/v1/orders", { key: SECRET, body: order, headers: { "Idempotency-Key": "has spaces" } }), opts(db.rpc));
  assertEquals(d.status, 400);
  assertEquals(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

Deno.test("CORS: preflight, widget keys only from their websites, secret keys refused in browsers", async () => {
  const db = await fakeDb();
  const pre = await handle(new Request(BASE + "/v1/bookings", { method: "OPTIONS", headers: { Origin: "https://salon.example.com" } }), opts(db.rpc));
  assertEquals(pre.status, 204); assertStringIncludes(pre.headers.get("Access-Control-Allow-Headers")!, "idempotency-key");
  let r = await handle(req("GET", "/v1/availability", { key: WIDGET, headers: { Origin: "https://salon.example.com" } }), opts(db.rpc));
  assertEquals(r.status, 200); assertEquals(r.headers.get("Access-Control-Allow-Origin"), "https://salon.example.com");
  r = await handle(req("GET", "/v1/availability", { key: WIDGET, headers: { Origin: "https://evil.example.net" } }), opts(db.rpc));
  assertEquals(r.status, 403); assertEquals(r.headers.get("Access-Control-Allow-Origin"), null);
  assertEquals((await r.json()).error.code, "origin_not_allowed");
  r = await handle(req("GET", "/v1/availability", { key: WIDGET }), opts(db.rpc));
  assertEquals(r.status, 403, "a widget key outside a browser");
  r = await handle(req("POST", "/v1/orders", { key: WIDGET, body: order, headers: { Origin: "https://salon.example.com" } }), opts(db.rpc));
  assertEquals(r.status, 403); assertEquals((await r.json()).error.code, "missing_scope");
  r = await handle(req("POST", "/v1/orders", { key: SECRET, body: order, headers: { Origin: "https://shop.example.com" } }), opts(db.rpc));
  assertEquals(r.status, 403); assertEquals((await r.json()).error.code, "secret_key_in_browser");
  r = await handle(req("POST", "/v1/orders", { key: TESTKEY, body: order, headers: { Origin: "http://localhost:3000" } }), opts(db.rpc));
  assertEquals(r.status, 202, "a secret key whose websites the owner listed");
  assertEquals(db.named("api_submit").length, 1);
  assert(originAllowed("https://book.example.org", ["https://*.example.org"]));
  assert(originAllowed("https://a.b.example.org", ["https://*.example.org"]));
  assertFalse(originAllowed("https://example.org", ["https://*.example.org"]));
  assertFalse(originAllowed("https://evilexample.org", ["https://*.example.org"]));
  assertFalse(originAllowed("http://book.example.org", ["https://*.example.org"]));
  assertFalse(originAllowed("https://salon.example.com:8443", ["https://salon.example.com"]));
  assertFalse(originAllowed("null", ["https://salon.example.com"]));
});

Deno.test("rate limits: 429 with Retry-After, logged; the log has the route, never refs or the key", async () => {
  const db = await fakeDb({ limit: 2 });
  for (let i = 0; i < 2; i++) assertEquals((await handle(req("GET", "/v1/prices?sku=MUG,CUP", { key: SECRET, headers: { "X-Forwarded-For": "203.0.113.7, 10.0.0.1" } }), opts(db.rpc))).status, 200);
  const r = await handle(req("GET", "/v1/prices", { key: SECRET }), opts(db.rpc));
  assertEquals(r.status, 429); assertEquals(r.headers.get("Retry-After"), "42"); assertEquals((await r.json()).error.code, "rate_limited");
  await handle(req("POST", "/v1/quotes/Q-SECRET-REF/accept", { key: SECRET, body: { accepted_by: { name: "Lee" } } }), opts(db.rpc));
  await Promise.all(later.splice(0));
  const logs = db.named("api_log_request").map((c) => c.args);
  assertEquals(logs.length, 4);
  assertEquals(logs[0].path, "/v1/prices"); assertEquals(logs[0].ip, "203.0.113.7"); assertEquals(logs[0].status, 200);
  assertEquals(logs[2].code, "rate_limited"); assertEquals(logs[2].status, 429);
  assertEquals(logs[3].path, "/v1/quotes/{ref}/accept");
  assertFalse(JSON.stringify(logs).includes("Q-SECRET-REF")); assertFalse(JSON.stringify(logs).includes(SECRET.slice(8)));
  assertEquals((db.named("api_read")[0].args.params as { skus: string[] }).skus, ["MUG", "CUP"]);
});

Deno.test("reads: query checks, events by id", async () => {
  const db = await fakeDb();
  assertEquals((await handle(req("GET", "/v1/catalog?limit=5000", { key: SECRET }), opts(db.rpc))).status, 400);
  assertEquals((await handle(req("GET", "/v1/availability/slots?from=2026-12-01", { key: SECRET }), opts(db.rpc))).status, 400);
  assertEquals((await handle(req("GET", "/v1/stock?sku=bad%20sku", { key: SECRET }), opts(db.rpc))).status, 400);
  assertEquals((await handle(req("GET", "/v1/events/not-an-id", { key: SECRET }), opts(db.rpc))).status, 404);
  const ok = await handle(req("GET", "/v1/availability/slots?service=CUT&from=2026-12-01&days=7&party_size=2", { key: SECRET }), opts(db.rpc));
  assertEquals(ok.status, 200);
  assertEquals(db.named("api_read").at(-1)!.args.params, { service: "CUT", from: "2026-12-01", days: 7, party_size: 2 });
  const ev = await handle(req("GET", "/v1/events/00000000-0000-4000-8000-000000000001", { key: WIDGET, headers: { Origin: "https://salon.example.com" } }), opts(db.rpc));
  assertEquals((await ev.json()).result.reference, "BK-1");
  assertEquals((await handle(req("DELETE", "/v1/orders", { key: SECRET }), opts(db.rpc))).status, 405);
  assertEquals((await handle(req("GET", "/v2/orders", { key: SECRET }), opts(db.rpc))).status, 404);
});

Deno.test("webhook signatures: what receivers check", async () => {
  const secret = "whsec_" + "e5".repeat(24);
  const body = JSON.stringify({ id: "evt", type: "booking.received", data: { a: 1 } });
  const h = await signatureHeader(secret, body, 1_800_000_000);
  assert(/^t=1800000000,v1=[0-9a-f]{64}$/.test(h));
  assert(await verifySignature(secret, body, h, 1_800_000_100));
  assertFalse(await verifySignature(secret, body + " ", h, 1_800_000_100), "a changed body");
  assertFalse(await verifySignature("whsec_" + "f6".repeat(24), body, h, 1_800_000_100), "another secret");
  assertFalse(await verifySignature(secret, body, h, 1_800_000_400), "too old (5 minutes)");
  // a known answer, so any language's receiver can be checked against it
  assertEquals(await signatureHeader("whsec_test", '{"id":"1"}', 1700000000),
    "t=1700000000,v1=" + [...new Uint8Array(await crypto.subtle.sign("HMAC",
      await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      new TextEncoder().encode('1700000000.{"id":"1"}')))].map((x) => x.toString(16).padStart(2, "0")).join(""));
  assert(safeEqual("abc", "abc")); assertFalse(safeEqual("abc", "abd")); assertFalse(safeEqual("abc", "abcd"));
  assert(safeUrl("https://hooks.example.com/riyeser"));
  for (const u of ["http://hooks.example.com", "https://localhost/x", "https://10.0.0.1/x", "https://[::1]/x", "https://printer.local/x",
    "https://user:pw@hooks.example.com/", "https://goaugynxeatzqzifpoes.supabase.co/rest/v1/", "https://intranet/x"]) assertFalse(safeUrl(u), u);
});

Deno.test("dispatcher: signed POSTs, results recorded, unsafe addresses never fetched", async () => {
  const secret = "whsec_" + "a7".repeat(24);
  const due = [
    { id: "d1", url: "https://hooks.example.com/ok", secret, event: "booking.received", attempt: 1, payload: { id: "e1", type: "booking.received", test: false, data: { event_id: "x" } } },
    { id: "d2", url: "https://hooks.example.com/down", secret, event: "stock.changed", attempt: 2, payload: { id: "e2", type: "stock.changed", data: {} } },
    { id: "d3", url: "https://169.254.169.254/latest", secret, event: "ping", attempt: 1, payload: { id: "e3" } },
    { id: "d4", url: "https://hooks.example.com/redirect", secret, event: "ping", attempt: 1, payload: { id: "e4" } },
  ];
  const results: Record<string, unknown>[] = [];
  const rpc: Rpc = async (name, args) => {
    if (name === "api_webhooks_due") return { ok: true, status: 200, body: due };
    results.push(args);
    return { ok: true, status: 200, body: null };
  };
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(u), init: init! });
    if (String(u).endsWith("/ok")) return new Response("thanks", { status: 200 });
    if (String(u).endsWith("/redirect")) return new Response(null, { status: 302, headers: { Location: "https://10.0.0.1/" } });
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
  const r = await dispatch(rpc, { fetch: f, now: () => 1_800_000_000_000 });
  assertEquals(r, { sent: 1, failed: 3 });
  assertEquals(seen.length, 3, "the bare IP address was never fetched");
  const first = seen[0];
  const h = new Headers(first.init.headers);
  assertEquals(h.get("Riyeser-Event"), "booking.received"); assertEquals(h.get("Riyeser-Delivery"), "d1");
  assertEquals(first.init.redirect, "manual");
  assert(await verifySignature(secret, String(first.init.body), h.get("Riyeser-Signature")!, 1_800_000_000));
  const byId = Object.fromEntries(results.map((x) => [x.delivery_id, x]));
  assertEquals(byId.d1.ok, true); assertEquals(byId.d2.ok, false); assertEquals(byId.d2.http_status, 500);
  assertEquals(byId.d3.err, "Address not allowed"); assertEquals(byId.d4.ok, false, "redirects aren't followed");
});

Deno.test("/internal/dispatch needs the service key; /internal/kick needs a linked PC", async () => {
  const db = await fakeDb();
  const env = (k: string) => k === "SUPABASE_SERVICE_ROLE_KEY" ? SERVICE : undefined;
  let r = await handle(req("POST", "/internal/dispatch", { headers: { Authorization: "Bearer wrong-key-0123456789abcdef" } }), { rpc: db.rpc, env });
  assertEquals(r.status, 401);
  r = await handle(req("POST", "/internal/dispatch", { headers: { Authorization: `Bearer ${SERVICE}` } }), { rpc: db.rpc, env });
  assertEquals(r.status, 200); assertEquals(db.named("api_sweep").length, 1);
  assertEquals(db.named("api_webhooks_due")[0].args.only_ws, null, "the whole queue");
  r = await handle(req("POST", "/internal/dispatch", {}), { rpc: db.rpc, env: () => undefined });
  assertEquals(r.status, 401, "no service key configured: nobody");
  let linked = false;
  const rpcAs = () => (async () => ({ ok: true, status: 200, body: linked })) as Rpc;
  const kick = () => req("POST", "/internal/kick", { body: { ws: WS, device: "a9a9a9d1-0000-4000-8000-000000000001" }, headers: { Authorization: "Bearer user-jwt" } });
  r = await handle(kick(), { rpc: db.rpc, rpcAs, env });
  assertEquals(r.status, 401);
  linked = true;
  r = await handle(kick(), { rpc: db.rpc, rpcAs, env });
  assertEquals(r.status, 200); assertEquals(db.named("api_webhooks_due").at(-1)!.args.only_ws, WS);
});

// ---- the hosted booking page (riyeser.com/book/{address}): no key in the browser, the address finds the page's key
const PAGE_ORIGINS = ["https://riyeser.com", "https://www.riyeser.com"];
async function pageDb() {
  const db = await fakeDb();
  const seen: { name: string; args: Record<string, unknown> }[] = [];
  const perIp = new Map<string, number>();
  const rpc: Rpc = (name, args) => {
    seen.push({ name, args });
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, body });
    if (name === "api_page_auth") {
      const n = (perIp.get(String(args.ip)) ?? 0) + 1; perIp.set(String(args.ip), n);
      if (n > 5) return ok({ error: { code: "rate_limited", message: "Too many requests from here." }, retry_after: 30, origins: PAGE_ORIGINS });
      if (args.slug === "closed-salon") return ok({ error: { code: "business_closed", message: "This business's Riyeser account is closed or paused." }, origins: PAGE_ORIGINS });
      if (args.slug !== "harbour-hair") return ok({ error: { code: "page_not_found", message: "This business isn't taking online bookings here." }, origins: PAGE_ORIGINS });
      return ok({ key_id: "k-page", workspace_id: WS, kind: "widget", mode: "live", scopes: ["availability:read", "bookings:write"], allowed_origins: PAGE_ORIGINS,
        name: "Booking page", slug: "harbour-hair", rate: { limit: 300, remaining: 299, reset: 30 } });
    }
    if (name === "api_page_profile") return ok({ slug: "harbour-hair", name: "Harbour Hair", colour: "#0e7c86", timezone: "Pacific/Fiji", accepting: true,
      services: [{ sku: "CUT", name: "Cut & style", duration_minutes: 45, price: 45, currency: "FJD" }], staff: [], hours: [] });
    return db.rpc(name, args);
  };
  return { rpc, seen, named: (x: string) => seen.filter((c) => c.name === x) };
}
const fromSite = (o: Record<string, string> = {}) => ({ Origin: "https://riyeser.com", "X-Forwarded-For": "198.51.100.7", ...o });

Deno.test("booking page: the profile from the address, only for riyeser.com, nothing private", async () => {
  const db = await pageDb();
  const r = await handle(req("GET", "/v1/pages/harbour-hair", { headers: fromSite() }), opts(db.rpc));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Access-Control-Allow-Origin"), "https://riyeser.com");
  const b = await r.json();
  assertEquals(b.name, "Harbour Hair"); assertEquals(b.services[0].sku, "CUT");
  assertEquals(db.named("api_page_auth")[0].args, { slug: "harbour-hair", ip: "198.51.100.7" });
  assertEquals(db.named("api_page_profile")[0].args.key_id, "k-page");
  assertEquals(db.named("api_log_request")[0].args.path, "/v1/pages/{address}", "logged as the route, never the address");
  // another website can't read it; nor can a script with no Origin (it's for the booking page only)
  const other = await handle(req("GET", "/v1/pages/harbour-hair", { headers: fromSite({ Origin: "https://evil.example.com" }) }), opts(db.rpc));
  assertEquals(other.status, 403); assertEquals((await other.json()).error.code, "origin_not_allowed");
  assertEquals(other.headers.get("Access-Control-Allow-Origin"), null);
  const curl = await handle(req("GET", "/v1/pages/harbour-hair", { headers: { "X-Forwarded-For": "198.51.100.8" } }), opts(db.rpc));
  assertEquals(curl.status, 403);
  // a key is never needed, and one sent is refused (the page must never carry one)
  const keyed = await handle(req("GET", "/v1/pages/harbour-hair", { key: WIDGET, headers: fromSite() }), opts(db.rpc));
  assertEquals(keyed.status, 400);
});

Deno.test("booking page: unknown or switched-off address, a paused business, a bad address; the page can read the answer", async () => {
  const db = await pageDb();
  let r = await handle(req("GET", "/v1/pages/no-such-salon", { headers: fromSite() }), opts(db.rpc));
  assertEquals(r.status, 404); assertEquals((await r.json()).error.code, "page_not_found");
  assertEquals(r.headers.get("Access-Control-Allow-Origin"), "https://riyeser.com", "so the page can say 'not taking online bookings'");
  r = await handle(req("GET", "/v1/pages/closed-salon", { headers: fromSite() }), opts(db.rpc));
  assertEquals(r.status, 403); assertEquals((await r.json()).error.code, "business_closed");
  const before = db.seen.length;
  r = await handle(req("GET", "/v1/pages/Bad%20Address!", { headers: fromSite() }), opts(db.rpc));
  assertEquals(r.status, 404); assertEquals(db.seen.length, before, "a malformed address never reaches the database");
  r = await handle(req("GET", "/v1/pages/x", { headers: fromSite() }), opts(db.rpc));
  assertEquals(r.status, 404);
  // a refusal for another website carries no CORS header
  r = await handle(req("GET", "/v1/pages/no-such-salon", { headers: fromSite({ Origin: "https://evil.example.com" }) }), opts(db.rpc));
  assertEquals(r.headers.get("Access-Control-Allow-Origin"), null);
});

Deno.test("booking page: free times, a booking (marked as from the page), following it; limited per visitor", async () => {
  const db = await pageDb();
  let r = await handle(req("GET", "/v1/pages/harbour-hair/slots?service=CUT&from=2026-12-01&days=7", { headers: fromSite() }), opts(db.rpc));
  assertEquals(r.status, 200);
  assertEquals(db.named("api_read")[0].args, { key_id: "k-page", what: "slots", params: { service: "CUT", from: "2026-12-01", days: 7 } });
  r = await handle(req("GET", "/v1/pages/harbour-hair/slots?service=bad%20sku", { headers: fromSite() }), opts(db.rpc));
  assertEquals(r.status, 400);
  r = await handle(req("POST", "/v1/pages/harbour-hair/bookings", { body: { ...booking, metadata: { channel: "fake" } }, headers: fromSite({ "Idempotency-Key": "pg-1" }) }), opts(db.rpc));
  assertEquals(r.status, 202);
  const id = (await r.json()).id;
  const sub = db.named("api_submit")[0].args;
  assertEquals(sub.key_id, "k-page"); assertEquals(sub.source, "page");
  assertEquals((sub.payload as { metadata: Record<string, unknown> }).metadata, { channel: "booking_page", source_page: "https://riyeser.com/book/harbour-hair" });
  // replaying the same booking gives the same answer (the page retries after a dropped connection)
  r = await handle(req("POST", "/v1/pages/harbour-hair/bookings", { body: { ...booking, metadata: { channel: "fake" } }, headers: fromSite({ "Idempotency-Key": "pg-1", "X-Forwarded-For": "198.51.100.9" }) }), opts(db.rpc));
  assertEquals(r.status, 200); assertEquals((await r.json()).id, id);
  r = await handle(req("GET", `/v1/pages/harbour-hair/events/${id}`, { headers: fromSite({ "X-Forwarded-For": "198.51.100.9" }) }), opts(db.rpc));
  assertEquals(r.status, 200); assertEquals(db.named("api_read").at(-1)!.args.what, "event");
  r = await handle(req("GET", "/v1/pages/harbour-hair/events/not-a-uuid", { headers: fromSite({ "X-Forwarded-For": "198.51.100.9" }) }), opts(db.rpc));
  assertEquals(r.status, 404);
  // only bookings: no orders or enquiries through the page; wrong method
  r = await handle(req("GET", "/v1/pages/harbour-hair/bookings", { headers: fromSite({ "X-Forwarded-For": "198.51.100.10" }) }), opts(db.rpc));
  assertEquals(r.status, 405);
  r = await handle(req("POST", "/v1/pages/harbour-hair/orders", { body: order, headers: fromSite({ "X-Forwarded-For": "198.51.100.10" }) }), opts(db.rpc));
  assertEquals(r.status, 404);
  // the sixth request from one address in the pretend minute: 429 with Retry-After, readable by the page
  for (let i = 0; i < 6; i++) r = await handle(req("GET", "/v1/pages/harbour-hair", { headers: fromSite({ "X-Forwarded-For": "203.0.113.5" }) }), opts(db.rpc));
  assertEquals(r.status, 429); assertEquals(r.headers.get("Retry-After"), "30"); assertEquals(r.headers.get("Access-Control-Allow-Origin"), "https://riyeser.com");
});
