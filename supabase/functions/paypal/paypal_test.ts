// deno test supabase/functions/paypal — the paypal function against a pretend PayPal and a pretend database.
// (The database side, billing_paypal_event and friends, is tested on real PostgreSQL in website/team/test/rules-test.sql.)
//  - not set up: "PayPal isn't set up yet"; keys but no webhook id: webhooks refused, paying refused
//  - subscribe: the database decides the price; one product and plan made once; the plan's price set for this
//    subscription (plan override); early bird first year; the approve link; the subscription id saved
//  - webhooks: the signature checked with PayPal (the event passed on byte for byte); a bad signature refused;
//    each event handed to the database (which ignores repeats); a failed payment then its grace; cancel
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { forgetTokens, handle, startTime, type Rpc } from "./handler.ts";

const WS = "11111111-2222-4333-8444-555555555555";
const ORDER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KEYS = { PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret", PAYPAL_ENV: "sandbox", PAYPAL_WEBHOOK_ID: "WH-ID-1", PAYPAL_ALLOW_PRACTICE: "1" };

/** A pretend PayPal: just enough of the REST API, remembering every call. */
function fakePayPal(opts: { signatureOk?: boolean; cancelStatus?: number } = {}) {
  const calls: { method: string; path: string; body: string; headers: Headers }[] = [];
  const subs = new Map<string, Record<string, unknown>>();
  let n = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", path: u.pathname, body, headers });
    const j = (status: number, b: unknown) => new Response(b === null ? null : JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    assertEquals(u.origin, "https://api-m.sandbox.paypal.com", "sandbox keys go to PayPal's sandbox");
    if (u.pathname === "/v1/oauth2/token") {
      return headers.get("Authorization") === `Basic ${btoa("test-client:test-secret")}` ? j(200, { access_token: "A21-token", expires_in: 3600 }) : j(401, { error: "invalid_client" });
    }
    if (headers.get("Authorization") !== "Bearer A21-token") return j(401, {});
    if (u.pathname === "/v1/catalogs/products") return j(201, { id: "PROD-1" });
    if (u.pathname === "/v1/billing/plans") { n++; return j(201, { id: `P-PLAN${n}`, status: "ACTIVE" }); }
    if (u.pathname === "/v1/billing/subscriptions") {
      const b = JSON.parse(body); const id = `I-SUB${String(subs.size + 1).padStart(6, "0")}`;
      subs.set(id, { ...b, status: "APPROVAL_PENDING" });
      return j(201, { id, status: "APPROVAL_PENDING", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${id}` }, { rel: "self", href: "x" }] });
    }
    const cm = /^\/v1\/billing\/subscriptions\/([^/]+)\/cancel$/.exec(u.pathname);
    if (cm) { if (opts.cancelStatus) return j(opts.cancelStatus, { name: "UNPROCESSABLE_ENTITY" }); subs.get(cm[1])!.status = "CANCELLED"; return j(204, null); }
    if (u.pathname === "/v1/notifications/verify-webhook-signature") {
      const b = JSON.parse(body);
      const good = opts.signatureOk !== false && b.transmission_sig === "good-sig" && b.webhook_id === "WH-ID-1";
      return j(200, { verification_status: good ? "SUCCESS" : "FAILURE" });
    }
    return j(404, {});
  }) as typeof fetch;
  return { f, calls, subs, approve: (id: string) => { subs.get(id)!.status = "ACTIVE"; } };
}

/** A pretend database: billing_start (as the owner), the service-role functions, and events applied once. */
function fakeDb(opts: { owner?: boolean; early?: boolean; startsOn?: string } = {}) {
  const st = { config: {} as Record<string, string>, created: [] as unknown[], events: new Map<string, string>(), applied: [] as string[],
    cancelled: [] as string[], grace: null as string | null, status: "pending", asCalls: [] as string[] };
  const rpcAs = (req: Request): Rpc => async (name, args) => {
    st.asCalls.push(`${name}:${req.headers.get("Authorization")}`);
    if (opts.owner === false) return { ok: false, status: 400, body: { message: "Only the business owner can pay for Riyeser." } };
    if (name === "billing_start") {
      assertEquals(args.pay_method, "paypal");
      const people = Number(args.people);
      const amount = (args.mods as string[]).reduce((a, m) => a + ({ plus: 39, payroll: 25, calls: 39 } as Record<string, number>)[m] + 7 * Math.max(0, people - 3), 0) * (args.billing_period === "yearly" ? 10 : 1);
      return { ok: true, status: 200, body: { id: ORDER, ref: "RI-10001", amount, first_amount: opts.early ? amount / 2 : null, early_bird: !!opts.early, early_cycles: opts.early ? (args.billing_period === "yearly" ? 1 : 12) : 0, module_names: [], starts_on: opts.startsOn ?? null } };
    }
    if (name === "billing_cancel_start") return { ok: true, status: 200, body: { order_id: ORDER, subscription_id: "I-SUB000001", env: "sandbox", paid_through: "2027-03-22" } };
    return { ok: false, status: 404, body: null };
  };
  const rpcService: Rpc = async (name, args) => {
    if (name === "billing_paypal_config") return { ok: true, status: 200, body: { ...st.config } };
    if (name === "billing_paypal_config_set") { st.config[String(args.k)] = String(args.v); return { ok: true, status: 200, body: null }; }
    if (name === "billing_paypal_created") { st.created.push(args); return { ok: true, status: 200, body: null }; }
    if (name === "billing_paypal_cancelled") { st.cancelled.push(String(args.order_id)); st.status = "cancelled"; return { ok: true, status: 200, body: null }; }
    if (name === "billing_paypal_event") {
      const id = String(args.event_id);
      if (st.events.has(id)) return { ok: true, status: 200, body: "duplicate" };
      const t = String(args.event_type); let r = "ignored";
      if (t === "BILLING.SUBSCRIPTION.ACTIVATED") { st.status = "active"; r = "activated"; }
      if (t === "PAYMENT.SALE.COMPLETED") { st.status = "active"; st.grace = null; r = "paid"; }
      if (t === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") { st.status = "payment_failed"; st.grace = "today + 7"; r = "payment failed"; }
      if (t === "BILLING.SUBSCRIPTION.CANCELLED") { st.status = "cancelled"; r = "cancelled"; }
      st.events.set(id, r); st.applied.push(t);
      assertEquals(args.env, "sandbox");
      return { ok: true, status: 200, body: r };
    }
    return { ok: false, status: 404, body: null };
  };
  return { st, rpcAs, rpcService };
}

const env = (o: Record<string, string>) => (k: string) => o[k];
const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://x.supabase.co/functions/v1/paypal/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const owner = { Authorization: "Bearer owner-session", Origin: "https://riyeser.com" };
const hook = (ev: unknown, sig = "good-sig") => {
  const raw = typeof ev === "string" ? ev : JSON.stringify(ev);
  return post("webhook", raw, { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tx-" + raw.length, "paypal-transmission-sig": sig, "paypal-transmission-time": "2026-11-24T10:00:00Z" });
};

Deno.test("not set up: status says so, paying and webhooks are refused, nothing reaches PayPal", async () => {
  forgetTokens(); const p = fakePayPal(); const db = fakeDb();
  const d = { env: env({}), fetch: p.f, ...db };
  const s = await (await handle(new Request("https://x/functions/v1/paypal/status"), d)).json();
  assertEquals([s.ready, s.credentials, s.webhooks, s.message], [false, false, false, "PayPal isn't set up yet."]);
  const r = await handle(post("subscribe", { ws: WS, modules: ["plus"], people: 3, billing: "monthly" }, owner), d);
  assertEquals(r.status, 503); assertStringIncludes((await r.json()).error, "PayPal isn't set up yet");
  assertEquals((await handle(hook({ id: "WH-1", event_type: "PAYMENT.SALE.COMPLETED" }), d)).status, 503);
  assertEquals(p.calls.length, 0); assertEquals(db.st.asCalls.length, 0);
});

Deno.test("keys but no PAYPAL_WEBHOOK_ID: webhooks aren't verified yet, so events and new payments are refused", async () => {
  forgetTokens(); const p = fakePayPal(); const db = fakeDb();
  const d = { env: env({ ...KEYS, PAYPAL_WEBHOOK_ID: "" }), fetch: p.f, ...db };
  const s = await (await handle(new Request("https://x/functions/v1/paypal/status"), d)).json();
  assertEquals([s.ready, s.credentials, s.webhooks, s.env], [false, true, false, "sandbox"]);
  assertStringIncludes(s.message, "Webhooks aren't verified yet");
  const w = await handle(hook({ id: "WH-1", event_type: "PAYMENT.SALE.COMPLETED", resource: {} }), d);
  assertEquals(w.status, 503); assertStringIncludes((await w.json()).error, "PAYPAL_WEBHOOK_ID isn't set");
  assertEquals((await handle(post("subscribe", { ws: WS, modules: ["plus"], people: 3, billing: "monthly" }, owner), d)).status, 503);
  assertEquals(db.st.events.size, 0); assertEquals(p.calls.length, 0);
});

Deno.test("subscribe: the database's price, one product and plan made once, the price set per subscription, the approve link", async () => {
  forgetTokens(); const p = fakePayPal(); const db = fakeDb();
  const d = { env: env(KEYS), fetch: p.f, ...db };
  assertEquals((await (await handle(new Request("https://x/functions/v1/paypal/status"), d)).json()).ready, true);
  assertEquals((await handle(post("subscribe", { ws: WS, modules: ["plus"] }), d)).status, 401, "signed in only");
  const r = await handle(post("subscribe", { ws: WS, modules: ["plus", "payroll"], people: 5, billing: "monthly" }, owner), d);
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.ref, "RI-10001"); assertStringIncludes(b.approve_url, "https://www.sandbox.paypal.com/");
  assertEquals(db.st.asCalls[0], "billing_start:Bearer owner-session", "the database is asked as the owner");
  const sub = JSON.parse(p.calls.find((c) => c.path === "/v1/billing/subscriptions")!.body);
  assertEquals(sub.plan_id, "P-PLAN1"); assertEquals(sub.custom_id, ORDER);
  assertEquals(sub.plan.billing_cycles, [{ sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: "92.00", currency_code: "USD" } } }], "US$92: (39 + 14) + (25 + 14)");
  assertEquals(sub.application_context.return_url, "https://riyeser.com/link/?paid=RI-10001");
  assertEquals(p.calls.find((c) => c.path === "/v1/billing/subscriptions")!.headers.get("PayPal-Request-Id"), `riyeser-${ORDER}`, "safe to retry");
  assertEquals(db.st.created, [{ order_id: ORDER, subscription_id: "I-SUB000001", env: "sandbox" }]);
  assertEquals(db.st.config, { product: "PROD-1", "plan.monthly": "P-PLAN1" });
  const plan = JSON.parse(p.calls.find((c) => c.path === "/v1/billing/plans")!.body);
  assertEquals(plan.billing_cycles.length, 1); assertEquals(plan.billing_cycles[0].frequency.interval_unit, "MONTH");
  // a second business: the same plan, no new product
  await handle(post("subscribe", { ws: WS, modules: ["calls"], people: 4, billing: "monthly" }, owner), d);
  assertEquals(p.calls.filter((c) => c.path === "/v1/catalogs/products").length, 1);
  assertEquals(p.calls.filter((c) => c.path === "/v1/billing/plans").length, 1);
  assertEquals(p.calls.filter((c) => c.path === "/v1/oauth2/token").length, 1, "the token is reused");
  // yearly: its own plan
  await handle(post("subscribe", { ws: WS, modules: ["calls"], people: 3, billing: "yearly" }, owner), d);
  assertEquals(db.st.config["plan.yearly"], "P-PLAN2");
  const y = JSON.parse(p.calls.filter((c) => c.path === "/v1/billing/subscriptions").pop()!.body);
  assertEquals(y.plan.billing_cycles[0].pricing_scheme.fixed_price.value, "390.00", "Link Plus yearly = 10 months");
  // nothing secret in any answer
  assert(!JSON.stringify(b).includes("test-secret") && !JSON.stringify(b).includes("A21-token"));
});

Deno.test("subscribe with the early bird: half for the first 12 months, then the full price", async () => {
  forgetTokens(); const p = fakePayPal(); const db = fakeDb({ early: true });
  const r = await handle(post("subscribe", { ws: WS, modules: ["calls"], people: 4, billing: "monthly" }, owner), { env: env(KEYS), fetch: p.f, ...db });
  assertEquals(r.status, 200);
  const sub = JSON.parse(p.calls.find((c) => c.path === "/v1/billing/subscriptions")!.body);
  assertEquals(sub.plan.billing_cycles.map((c: { total_cycles: number; pricing_scheme: { fixed_price: { value: string } } }) => [c.total_cycles, c.pricing_scheme.fixed_price.value]), [[12, "23.00"], [0, "46.00"]]);
  const plan = JSON.parse(p.calls.find((c) => c.path === "/v1/billing/plans")!.body);
  assertEquals(plan.billing_cycles.map((c: { tenure_type: string }) => c.tenure_type), ["TRIAL", "REGULAR"]);
  assertEquals(db.st.config["plan.monthly.eb"], "P-PLAN1");
});

Deno.test("S10: on a free trial the first charge waits for its end (start_time); today means straight away", async () => {
  forgetTokens(); const p = fakePayPal();
  const later = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  const r = await handle(post("subscribe", { ws: WS, modules: ["plus"], people: 3, billing: "monthly" }, owner), { env: env(KEYS), fetch: p.f, ...fakeDb({ startsOn: later }) });
  assertEquals(r.status, 200);
  const sub = JSON.parse(p.calls.find((c) => c.path === "/v1/billing/subscriptions")!.body);
  assertEquals(sub.start_time, `${later}T00:00:00Z`, "PayPal starts billing when the trial ends");
  const today = new Date().toISOString().slice(0, 10);
  await handle(post("subscribe", { ws: WS, modules: ["plus"], people: 3, billing: "monthly" }, owner), { env: env(KEYS), fetch: p.f, ...fakeDb({ startsOn: today }) });
  assertEquals(JSON.parse(p.calls.filter((c) => c.path === "/v1/billing/subscriptions").pop()!.body).start_time, undefined, "trial over: charged now");
  assertEquals(startTime(null), null); assertEquals(startTime("2020-01-01"), null); assertEquals(startTime("not a date"), null);
  assertEquals(startTime("2027-02-22", Date.parse("2026-11-25T00:00:00Z")), "2027-02-22T00:00:00Z");
});

Deno.test("not the owner: the database's answer, and PayPal is never asked", async () => {
  forgetTokens(); const p = fakePayPal(); const db = fakeDb({ owner: false });
  const r = await handle(post("subscribe", { ws: WS, modules: ["plus"], people: 3, billing: "monthly" }, owner), { env: env(KEYS), fetch: p.f, ...db });
  assertEquals(r.status, 403); assertEquals((await r.json()).error, "Only the business owner can pay for Riyeser.");
  assertEquals(p.calls.length, 0);
  assertEquals((await handle(post("subscribe", { ws: "not-a-uuid" }, owner), { env: env(KEYS), fetch: p.f, ...db })).status, 400);
});

Deno.test("webhooks: approve, activated, paid; a repeat ignored; a bad signature refused; a failed payment then grace; cancel", async () => {
  forgetTokens(); const p = fakePayPal(); const db = fakeDb();
  const d = { env: env(KEYS), fetch: p.f, ...db };
  await handle(post("subscribe", { ws: WS, modules: ["plus"], people: 3, billing: "monthly" }, owner), d);
  p.approve("I-SUB000001");   // the owner approves at PayPal
  const activated = { id: "WH-10", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: "I-SUB000001", custom_id: ORDER, status: "ACTIVE" } };
  // the event is passed to PayPal for checking exactly as it came, spaces and all
  const raw = JSON.stringify(activated, null, 2);
  let r = await handle(hook(raw), d);
  assertEquals([r.status, (await r.json()).result], [200, "activated"]);
  const v = p.calls.filter((c) => c.path === "/v1/notifications/verify-webhook-signature").pop()!;
  assert(v.body.endsWith(`"webhook_event":${raw}}`), "raw event in the verify call");
  const vb = JSON.parse(v.body);
  assertEquals([vb.webhook_id, vb.transmission_sig, vb.auth_algo], ["WH-ID-1", "good-sig", "SHA256withRSA"]);
  const sale = { id: "WH-11", event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "SALE-1", billing_agreement_id: "I-SUB000001", amount: { total: "39.00", currency: "USD" } } };
  r = await handle(hook(sale), d); assertEquals((await r.json()).result, "paid");
  r = await handle(hook(sale), d); assertEquals([r.status, (await r.json()).result], [200, "duplicate"], "the same event again: 200 so PayPal stops, and nothing applied");
  assertEquals(db.st.applied, ["BILLING.SUBSCRIPTION.ACTIVATED", "PAYMENT.SALE.COMPLETED"]);
  // a forged event: refused, the database never sees it
  r = await handle(hook({ id: "WH-EVIL", event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "SALE-X", billing_agreement_id: "I-SUB000001", amount: { total: "39.00", currency: "USD" } } }, "forged"), d);
  assertEquals(r.status, 401); assert(!db.st.events.has("WH-EVIL"));
  r = await handle(post("webhook", JSON.stringify(sale)), d); assertEquals(r.status, 400, "no signature headers");
  r = await handle(hook("not json"), d); assertEquals(r.status, 400);
  // a failed payment: grace (the database gives the date), then the retry works
  r = await handle(hook({ id: "WH-12", event_type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED", resource: { id: "I-SUB000001" } }), d);
  assertEquals((await r.json()).result, "payment failed"); assertEquals([db.st.status, db.st.grace], ["payment_failed", "today + 7"]);
  r = await handle(hook({ ...sale, id: "WH-13", resource: { ...sale.resource, id: "SALE-2" } }), d);
  assertEquals((await r.json()).result, "paid"); assertEquals([db.st.status, db.st.grace], ["active", null]);
  // the owner cancels on riyeser.com: PayPal is told, then the database
  r = await handle(post("cancel", { ws: WS }, owner), d);
  assertEquals(r.status, 200); assertEquals((await r.json()).works_until, "2027-03-22");
  assertEquals(p.subs.get("I-SUB000001")!.status, "CANCELLED"); assertEquals(db.st.cancelled, [ORDER]);
  // and PayPal's own CANCELLED webhook afterwards is fine
  r = await handle(hook({ id: "WH-14", event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: "I-SUB000001" } }), d);
  assertEquals((await r.json()).result, "cancelled");
});

Deno.test("cancel when PayPal says it's already cancelled (422) still records it", async () => {
  forgetTokens(); const p = fakePayPal({ cancelStatus: 422 }); const db = fakeDb();
  const r = await handle(post("cancel", { ws: WS }, owner), { env: env(KEYS), fetch: p.f, ...db });
  assertEquals(r.status, 200); assertEquals(db.st.cancelled, [ORDER]);
});

Deno.test("wrong PayPal keys: a plain message, no details", async () => {
  forgetTokens(); const p = fakePayPal(); const db = fakeDb();
  const r = await handle(post("subscribe", { ws: WS, modules: ["plus"], people: 3, billing: "monthly" }, owner), { env: env({ ...KEYS, PAYPAL_CLIENT_SECRET: "wrong" }), fetch: p.f, ...db });
  assertEquals(r.status, 502); assertStringIncludes((await r.json()).error, "PayPal didn't accept Riyeser's PayPal keys");
});

Deno.test("CORS: the website can call it", async () => {
  const r = await handle(new Request("https://x/functions/v1/paypal/subscribe", { method: "OPTIONS" }), { env: env({}) });
  assertEquals(r.status, 204); assertStringIncludes(r.headers.get("Access-Control-Allow-Headers")!, "authorization");
});

Deno.test("practice (sandbox) mode is closed to customers unless PAYPAL_ALLOW_PRACTICE=1; live is open; webhooks still work", async () => {
  forgetTokens(); const p = fakePayPal(); const db = fakeDb();
  const { PAYPAL_ALLOW_PRACTICE: _, ...SANDBOX } = KEYS;
  const d = { env: env(SANDBOX), fetch: p.f, ...db };
  const st = await (await handle(new Request("https://x/functions/v1/paypal/status"), d)).json();
  assertEquals([st.ready, st.credentials, st.webhooks, st.env], [false, true, true, "sandbox"]);
  assertEquals((await handle(post("subscribe", { ws: WS, modules: ["plus"], people: 3, billing: "monthly" }, owner), d)).status, 503);
  assertEquals(p.calls.length, 0, "nothing was sent to PayPal");
  const live = { env: env({ ...SANDBOX, PAYPAL_ENV: "live" }), fetch: p.f, ...db };
  assertEquals((await (await handle(new Request("https://x/functions/v1/paypal/status"), live)).json()).ready, true);
});
