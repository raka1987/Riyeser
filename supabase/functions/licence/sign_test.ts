// deno test supabase/functions/licence  — signing, canonical JSON and the function itself, with the shared vectors.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { b64, canonical, fromB64url, loadKey, signLicence } from "./sign.ts";
import { handle } from "./handler.ts";

const V = JSON.parse(await Deno.readTextFile(new URL("./licence-vectors.json", import.meta.url)));
const hex = (h: string): Uint8Array<ArrayBuffer> => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// RFC 8032 test key 1 (published; only for tests), as the LICENCE_SIGNING_KEY secret would hold it
const T1 = V.rfc8032[0];
const SECRET = b64url(new TextEncoder().encode(JSON.stringify({ kty: "OKP", crv: "Ed25519", d: b64url(hex(T1.secret)), x: b64url(hex(T1.public)) })));
const verify = async (pub: string, msg: Uint8Array<ArrayBuffer>, sig: Uint8Array<ArrayBuffer>) =>
  crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", fromB64url(pub.replace(/\+/g, "-").replace(/\//g, "_")), { name: "Ed25519" }, false, ["verify"]), sig, msg);

Deno.test("canonical JSON matches the shared vectors byte for byte", () => {
  for (const c of V.canonical) assertEquals(canonical(c.input), c.expected);
  const { sig: _sig, ...rest } = V.sample.envelope;
  assertEquals(canonical(rest), V.sample.canonical);
});

Deno.test("RFC 8032 test vectors: WebCrypto signs them exactly", async () => {
  for (const t of V.rfc8032) {
    const k = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: b64url(hex(t.secret)), x: b64url(hex(t.public)) }, { name: "Ed25519" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k, hex(t.message)));
    assertEquals(Array.from(sig), Array.from(hex(t.signature)));
  }
});

Deno.test("a signed licence verifies, and any change to it doesn't", async () => {
  const key = await loadKey(SECRET);
  assertEquals(key.publicKey, V.sample.public_key);
  const env = await signLicence(key, V.sample.envelope.licence, V.sample.envelope.workspace_id, V.sample.envelope.device_id, Date.parse(V.sample.envelope.issued_at));
  assertEquals(env.sig, V.sample.envelope.sig); // Ed25519 is deterministic: the same bytes as the Node and Python tests
  assertEquals(env.expires_at, "2026-12-24T12:00:00.000Z");
  const { sig, ...rest } = env;
  assert(await verify(key.publicKey, new TextEncoder().encode(canonical(rest)), fromB64url(sig!.replace(/\+/g, "-").replace(/\//g, "_"))));
  const edited = { ...rest, licence: { ...rest.licence, modules: { payroll: { status: "active", active: true } } } };
  assert(!(await verify(key.publicKey, new TextEncoder().encode(canonical(edited)), fromB64url(sig!.replace(/\+/g, "-").replace(/\//g, "_")))));
});

const WS = "11111111-1111-4111-8111-111111111111";
const DEV = "22222222-2222-4222-8222-222222222222";
const post = (body: unknown, auth = "Bearer user-token") =>
  new Request("https://x.supabase.co/functions/v1/licence", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });

Deno.test("the function: signs the caller's licence, names the PC only when it's linked", async () => {
  const key = loadKey(SECRET);
  const calls: string[] = [];
  const rpc = async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === "company_licence") return { ok: true, status: 200, body: { ...V.sample.envelope.licence, workspace_id: args.ws } };
    return { ok: true, status: 200, body: args.device === DEV };
  };
  let r = await handle(post({ ws: WS, device: DEV }), { rpc, key, now: Date.parse("2026-11-24T12:00:00Z") });
  assertEquals(r.status, 200);
  const env = await r.json();
  assertEquals([env.workspace_id, env.device_id, env.expires_at], [WS, DEV, "2026-12-24T12:00:00.000Z"]);
  assertEquals(env.sig, V.sample.envelope.sig);
  r = await handle(post({ ws: WS, device: "33333333-3333-4333-8333-333333333333" }), { rpc, key });
  assertEquals((await r.json()).device_id, null);
  assertEquals(calls.filter((c) => c === "licence_device_linked").length, 2);
});

Deno.test("the function: not a member, not signed in, no key, and the public key", async () => {
  const key = loadKey(SECRET);
  const no = async () => ({ ok: false, status: 400, body: { message: "You're not in that company" } });
  assertEquals((await handle(post({ ws: WS }), { rpc: no, key })).status, 403);
  assertEquals((await handle(post({ ws: WS }, ""), { rpc: no, key })).status, 401);
  assertEquals((await handle(post({ ws: "not-a-uuid" }), { rpc: no, key })).status, 400);
  assertEquals((await handle(post({ ws: WS }), { rpc: no, key: null })).status, 503);
  const pk = await handle(new Request("https://x.supabase.co/functions/v1/licence/public-key"), { key });
  assertEquals(await pk.json(), { alg: "Ed25519", public_key: V.sample.public_key });
  assertEquals((await handle(new Request("https://x.supabase.co/functions/v1/licence/public-key"), { key: null })).status, 503);
});
