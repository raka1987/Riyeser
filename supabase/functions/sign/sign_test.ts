// deno test --allow-env --allow-read --allow-write --allow-net supabase/functions/sign
// The "sign" function against a pretend database and a pretend Storage:
//  - SEC-017: the address recorded is never the first X-Forwarded-For entry (cf-connecting-ip, else our proxy's entry)
//  - only the link's SHA-256 goes to the database; wrong or odd links say "unknown"; CORS only for riyeser.com
//  - the document is only shown when its SHA-256 still matches; the signed copy is a download
//  - the last signature makes the signed copy here: fields stamped (flattened), a certificate page with who, when, the
//    addresses, the fingerprints and the request ID; a PDF that doesn't match what was sent is refused
//  - errors from the database come back as plain messages; too many tries -> 429; big bodies -> 413
//  - the clean-up deletes files whose time is up, then tells the database
//  - rotated pages: fields land where they were placed
// With SIGN_TEST_PG=postgres://… (a local database with team-chat.sql) it also runs the whole thing on real
// PostgreSQL (sign_pub_* as the service role). With SIGN_OUT=folder it saves the signed PDF there to look at.
import { assert, assertEquals, assertFalse, assertMatch } from "jsr:@std/assert@1";
import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";
import { buildSigned, placeOnPage, sha256Hex, when, type Bundle } from "./certificate.ts";
import { clientIp, completeRequest, handle, resetForTests, type Rpc, type Storage, sweepFiles } from "./handler.ts";

const fn = "https://x.supabase.co/functions/v1/sign/";
const TOKEN = "a1".repeat(32);
// a 1x1 transparent PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function samplePdf(pages = 2, rotate = 0): Promise<Uint8Array> {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) { const p = d.addPage([595, 842]); p.drawText(`Synthetic agreement page ${i + 1}`, { x: 60, y: 760, size: 16, font: f }); if (rotate) p.setRotation({ type: "degrees", angle: rotate } as never); }
  return await d.save();
}
const hexOf = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
/** Every stream in the file, inflated where it's compressed (pdf-lib writes page text as hex strings in them). */
async function allText(bytes: Uint8Array): Promise<string> {
  const raw = new TextDecoder("latin1").decode(bytes); let out = raw;
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length; let end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    while (end > start && (bytes[end - 1] === 10 || bytes[end - 1] === 13)) end--;
    try {
      const s = new Blob([bytes.slice(start, end)]).stream().pipeThrough(new DecompressionStream("deflate"));
      out += new TextDecoder("latin1").decode(new Uint8Array(await new Response(s).arrayBuffer()));
    } catch { /* not compressed */ }
  }
  return out.toUpperCase();
}
const texts = new WeakMap<Uint8Array, string>();
/** Is this text written on a page of the PDF? */
async function hasText(bytes: Uint8Array, s: string) { if (!texts.has(bytes)) texts.set(bytes, await allText(bytes)); return texts.get(bytes)!.includes(hexOf(s)); }

async function bundle(original: Uint8Array): Promise<Bundle> {
  return {
    id: "0d6c3f0e-1111-4c2b-9d1e-222233334444", workspace_id: "6a1b2c3d-0000-4000-8000-000000000001", title: "Service agreement", company: "Sample Plumbing",
    sender: "Alex", sender_email: "owner@a.test", sent_at: "2026-11-28T01:00:00Z", original_path: "ws/req/original.pdf", original_sha256: await sha256Hex(original), pages: 2, ordered: true,
    fields: [{ id: "s1", kind: "signature", signer: 1, page: 1, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }, { id: "d1", kind: "date", signer: 1, page: 1, x: 0.5, y: 0.7, w: 0.2, h: 0.04 },
      { id: "n2", kind: "name", signer: 2, page: 2, x: 0.5, y: 0.7, w: 0.3, h: 0.04 }, { id: "s2", kind: "signature", signer: 2, page: 2, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }],
    signers: [
      { position: 1, name: "Pat Client", email: "pat@client.test", sent_at: "2026-11-28T01:00:00Z", viewed_at: "2026-11-28T02:00:00Z", signed_at: "2026-11-28T02:05:00Z",
        agreed_at: "2026-11-28T02:05:00Z", method: "drawn", ip: "203.0.113.9", user_agent: "Mozilla/5.0 Test", vals: { s1: PNG, d1: "28 Nov 2026" } },
      { position: 2, name: "Jo Witness", email: "jo@witness.test", sent_at: "2026-11-28T02:05:00Z", viewed_at: "2026-11-28T03:00:00Z", signed_at: "2026-11-28T03:01:00Z",
        agreed_at: "2026-11-28T03:01:00Z", method: "typed", ip: "198.51.100.20", user_agent: "Mozilla/5.0 Phone", vals: { s2: PNG, n2: "Jo Witness" } }],
    events: [{ event: "sent", at: "2026-11-28T01:00:00Z" }, { event: "viewed", at: "2026-11-28T02:00:00Z", signer: 1, ip: "203.0.113.9" }, { event: "signed", at: "2026-11-28T02:05:00Z", signer: 1, ip: "203.0.113.9" }],
  };
}

function world(o: { pdf: Uint8Array; b: Bundle; open?: Record<string, unknown>; doc?: Record<string, unknown>; finish?: Record<string, unknown> }) {
  const calls: { name: string; args: Record<string, unknown> }[] = []; const files = new Map<string, Uint8Array>([[o.b.original_path, o.pdf]]); const removed: string[] = [];
  let claimed = false;
  const rpc: Rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === "sign_pub_open") return { ok: true, status: 200, body: { ...(o.open ?? { state: "ready", fields: [] }) } };
    if (name === "sign_pub_doc") return { ok: true, status: 200, body: o.doc ?? { state: "ready", path: o.b.original_path, sha256: o.b.original_sha256, name: "Service agreement" } };
    if (name === "sign_pub_finish") return { ok: true, status: 200, body: { ...(o.finish ?? { state: "signed" }) } };
    if (name === "sign_pub_decline") return { ok: true, status: 200, body: String(args.reason).length < 2 ? { error: "Say briefly why you're declining (up to 500 characters)." } : { state: "you_declined" } };
    if (name === "sign_pub_claim") { if (claimed) return { ok: true, status: 200, body: null }; claimed = true; return { ok: true, status: 200, body: o.b }; }
    if (name === "sign_pub_complete") return { ok: true, status: 200, body: { state: "completed" } };
    if (name === "sign_pub_files_due") return { ok: true, status: 200, body: [{ id: "old-1", paths: ["ws/old-1/original.pdf", "ws/old-1/signed.pdf"] }] };
    if (name === "sign_pub_files_gone") return { ok: true, status: 200, body: 1 };
    throw new Error(`unexpected ${name}`);
  };
  const storage: Storage = {
    download: async (p) => files.get(p) ?? null,
    upload: async (p, bytes) => { files.set(p, bytes); return true; },
    remove: async (ps) => { removed.push(...ps); ps.forEach((p) => files.delete(p)); return true; },
  };
  const later: Promise<unknown>[] = [];
  const opts = { rpc, storage, env: () => undefined, now: () => Date.parse("2026-11-28T03:01:00Z"), waitUntil: (p: Promise<unknown>) => { later.push(p); } };
  const post = async (action: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await handle(new Request(fn + action, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 Test", origin: "https://riyeser.com", "x-forwarded-for": "6.6.6.6, 203.0.113.9", ...headers } }), opts);
    await Promise.all(later); return r;
  };
  return { calls, files, removed, post, rpc, storage };
}

Deno.test("SEC-017: the recorded address is never the caller's own first X-Forwarded-For entry", () => {
  const r = (h: Record<string, string>) => new Request(fn + "open", { headers: h });
  assertEquals(clientIp(r({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })).ip, "203.0.113.9", "the entry our proxy added (the last)");
  assertEquals(clientIp(r({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2" }), 2).ip, "203.0.113.9", "two proxies in front: one further back");
  assertEquals(clientIp(r({ "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "198.51.100.7" })).ip, "198.51.100.7", "Cloudflare's header first");
  assertEquals(clientIp(r({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })).chain, "6.6.6.6, 203.0.113.9", "the whole chain is kept as evidence");
  assertEquals(clientIp(r({ "x-forwarded-for": "<script>" , "x-real-ip": "192.0.2.4" })).ip, "192.0.2.4", "nonsense is ignored");
  assertEquals(clientIp(r({})).ip, null);
});

Deno.test("open: only the link's SHA-256 goes to the database, with the trusted address; CORS for riyeser.com only", async () => {
  resetForTests(); const pdf = await samplePdf(); const b = await bundle(pdf);
  const w = world({ pdf, b, open: { state: "ready", request: { title: "Service agreement" }, fields: [{ id: "s1" }] } });
  const r = await w.post("open", { t: TOKEN });
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("access-control-allow-origin"), "https://riyeser.com");
  assertEquals(r.headers.get("cache-control"), "no-store");
  assertEquals(r.headers.get("x-robots-tag"), "noindex");
  const open = w.calls.find((c) => c.name === "sign_pub_open")!;
  assertEquals(open.args.tok_hash, await sha256Hex(TOKEN));
  assertEquals([open.args.ip, open.args.ip_chain, open.args.ua], ["203.0.113.9", "6.6.6.6, 203.0.113.9", "Mozilla/5.0 Test"]);
  assertFalse(JSON.stringify(w.calls).includes(TOKEN), "the token itself never goes to the database");
  assertEquals((await r.json()).state, "ready");
  const other = await w.post("open", { t: TOKEN }, { origin: "https://evil.test" });
  assertEquals(other.headers.get("access-control-allow-origin"), null);
});

Deno.test("odd links, methods, bodies and the per-address limit", async () => {
  resetForTests(); const pdf = await samplePdf(); const b = await bundle(pdf); const w = world({ pdf, b });
  assertEquals(await (await w.post("open", { t: "not-a-token" })).json(), { state: "unknown" });
  assertEquals(await (await w.post("open", {})).json(), { state: "unknown" });
  assertEquals(w.calls.filter((c) => c.name === "sign_pub_open").length, 0, "odd links never reach the database");
  assertEquals((await handle(new Request(fn + "open"), { rpc: w.rpc, storage: w.storage, env: () => undefined })).status, 405);
  assertEquals((await handle(new Request(fn + "other", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { rpc: w.rpc, storage: w.storage, env: () => undefined })).status, 404);
  assertEquals((await w.post("finish", { t: TOKEN, values: { s1: "x".repeat(1_600_000) } })).status, 413);
  assertEquals((await (await handle(new Request(fn + "ping"), { env: () => undefined })).json()).ok, true);
  resetForTests();
  let last = 0;
  for (let i = 0; i < 41; i++) last = (await w.post("open", { t: TOKEN }, { "cf-connecting-ip": "192.0.2.99" })).status;
  assertEquals(last, 429, "the 41st in a minute from one address");
});

Deno.test("doc: shown only while its SHA-256 matches; the signed copy is a download", async () => {
  resetForTests(); const pdf = await samplePdf(); const b = await bundle(pdf); const w = world({ pdf, b });
  const r = await w.post("doc", { t: TOKEN });
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("content-type"), "application/pdf");
  assertEquals(r.headers.get("x-doc-sha256"), b.original_sha256);
  assertEquals(new Uint8Array(await r.arrayBuffer()).length, pdf.length);
  w.files.set(b.original_path, await samplePdf(3));     // the stored file was swapped
  const bad = await w.post("doc", { t: TOKEN });
  assertEquals(bad.status, 409);
  assertMatch((await bad.json()).error, /changed since it was sent/);
  const w2 = world({ pdf, b, doc: { state: "completed", path: b.original_path, sha256: b.original_sha256, name: "Service: agreement/../" } });
  const dl = await w2.post("doc", { t: TOKEN });
  assertEquals(dl.headers.get("content-disposition"), 'attachment; filename="Service agreement.. (signed).pdf"');
  const w3 = world({ pdf, b, doc: { state: "closed" } });
  assertEquals((await w3.post("doc", { t: TOKEN })).status, 404);
});

Deno.test("finish: the last signature makes the signed copy with its certificate", async () => {
  resetForTests(); const pdf = await samplePdf(); const b = await bundle(pdf);
  const w = world({ pdf, b, finish: { state: "finishing", _complete: b.id } });
  const r = await w.post("finish", { t: TOKEN, agree: true, values: { s2: PNG, n2: "Jo Witness" }, method: "typed", day: "2026-11-28" });
  const body = await r.json();
  assertEquals(body, { state: "completed" }, "no internal ids go back to the page");
  const f = w.calls.find((c) => c.name === "sign_pub_finish")!;
  assertEquals([f.args.agreed, f.args.method, f.args.local_day], [true, "typed", "2026-11-28"]);
  const done = w.calls.find((c) => c.name === "sign_pub_complete")!;
  assertEquals(done.args.path, `${b.workspace_id}/${b.id}/signed.pdf`);
  const signed = w.files.get(String(done.args.path))!;
  assertEquals(done.args.sha256, await sha256Hex(signed), "the recorded fingerprint is the stored file's");
  const doc = await PDFDocument.load(signed);
  assertEquals(doc.getPageCount(), 3, "two pages and the certificate");
  assertEquals(doc.getForm().getFields().length, 0, "nothing left to fill in");
  for (const s of ["Certificate of completion", "Electronic signature with an audit trail, made with Riyeser", `Request ID: ${b.id}`, b.original_sha256.slice(0, 40),
    "Pat Client <pat@client.test>", "203.0.113.9", "198.51.100.20", "Jo Witness", "28 Nov 2026"]) assert(await hasText(signed, s), `the signed PDF has "${s}"`);
  for (const s of ["ESIGN", "eIDAS", "legally binding", "complies"]) assertFalse(await hasText(signed, s), `no legal claim "${s}"`);
  const again = await completeRequest(b.id, w.rpc, w.storage, Date.now());
  assertEquals(again, false, "only one copy is made");
  const sd = Deno.env.get("SIGN_OUT");
  if (sd) { await Deno.mkdir(sd, { recursive: true }); await Deno.writeFile(`${sd}/signed-sample.pdf`, signed); }
});

Deno.test("buildSigned refuses a PDF that isn't the one sent", async () => {
  const pdf = await samplePdf(); const b = await bundle(pdf);
  let err = "";
  try { await buildSigned(await samplePdf(1), b); } catch (e) { err = (e as Error).message; }
  assertMatch(err, /doesn't match the one that was sent/);
  const out = await buildSigned(pdf, b, "2026-11-28T03:01:00Z");
  assertEquals(out.original, b.original_sha256);
  assertMatch(out.final, /^[0-9a-f]{64}$/); assertMatch(out.content, /^[0-9a-f]{64}$/);
  assert(out.final !== out.content);
  assertEquals(when("2026-11-28T03:01:00Z"), "28 Nov 2026, 03:01 UTC");
});

Deno.test("rotated pages: a field lands where it was placed on the page as shown", () => {
  const f = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
  assertEquals(placeOnPage(f, 600, 800, 0), { x: 60, y: 800 - 0.3 * 800, width: 180, height: 80, angle: 0 });
  const r90 = placeOnPage(f, 600, 800, 90);    // shown 800 wide and 600 high
  assertEquals([r90.width, r90.height, r90.angle], [240, 60, 90]);
  assertEquals([Math.round(r90.x), Math.round(r90.y)], [180, 80]);
  const r180 = placeOnPage(f, 600, 800, 180);
  assertEquals([Math.round(r180.x), Math.round(r180.y), r180.angle], [540, 240, 180]);
  const r270 = placeOnPage(f, 600, 800, 270);
  assertEquals([Math.round(r270.x), Math.round(r270.y), r270.angle], [420, 720, 270]);
});

Deno.test("decline: the database's plain message comes back", async () => {
  resetForTests(); const pdf = await samplePdf(); const b = await bundle(pdf); const w = world({ pdf, b });
  const bad = await w.post("decline", { t: TOKEN, reason: "x" });
  assertEquals(bad.status, 400);
  assertMatch((await bad.json()).error, /Say briefly why/);
  assertEquals(await (await w.post("decline", { t: TOKEN, reason: "Wrong price" })).json(), { state: "you_declined" });
});

Deno.test("clean-up: files whose keeping time is up are deleted, then the database is told", async () => {
  resetForTests(); const pdf = await samplePdf(); const b = await bundle(pdf); const w = world({ pdf, b });
  assertEquals(await sweepFiles(w.rpc, w.storage), 1);
  assertEquals(w.removed, ["ws/old-1/original.pdf", "ws/old-1/signed.pdf"]);
  assertEquals(w.calls.find((c) => c.name === "sign_pub_files_gone")!.args.ids, ["old-1"]);
  resetForTests(); const w2 = world({ pdf, b });
  await w2.post("open", { t: TOKEN });
  assert(w2.calls.some((c) => c.name === "sign_pub_files_due"), "a request also runs the clean-up (at most every 10 minutes)");
  await w2.post("open", { t: TOKEN });
  assertEquals(w2.calls.filter((c) => c.name === "sign_pub_files_due").length, 1);
});

// ---- the whole thing on real PostgreSQL (team-chat.sql loaded), when SIGN_TEST_PG is set
const PG = Deno.env.get("SIGN_TEST_PG");
Deno.test({ name: "end to end on PostgreSQL: send, open, sign in order, signed copy, certificate", ignore: !PG, sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const { default: pg } = await import("npm:pg@8.13.1");
  const db = new pg.Client({ connectionString: PG }); await db.connect();
  const q = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;
  try {
    await q("begin");
    const owner = crypto.randomUUID();
    await q("insert into auth.users (id, email) values ($1, $2)", [owner, `owner-${owner.slice(0, 8)}@e2e.test`]);
    await q("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', json_build_object('sub', $1, 'aal', 'aal2')::text, true)", [owner]);
    await q("set local role authenticated");
    const ws = (await q("select public.create_team('E2E Joinery', 'Robin') as id"))[0].id;
    const pdf = await samplePdf();
    const made = (await q(`select public.sign_request_create($1, 'Joinery contract', 'Thanks!', true, null, null, $2::jsonb, $3::jsonb) as r`, [ws,
      JSON.stringify([{ id: "s1", kind: "signature", signer: 1, page: 1, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }, { id: "d1", kind: "date", signer: 1, page: 1, x: 0.5, y: 0.7, w: 0.2, h: 0.04 },
        { id: "s2", kind: "signature", signer: 2, page: 2, x: 0.1, y: 0.7, w: 0.3, h: 0.06 }, { id: "n2", kind: "name", signer: 2, page: 2, x: 0.5, y: 0.7, w: 0.3, h: 0.04 }]),
      JSON.stringify([{ name: "Pat E2E", email: "pat@e2e.test" }, { name: "Jo E2E", email: "jo@e2e.test" }])]))[0].r;
    await q("insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', $1, $2)", [made.path, { size: pdf.length }]);
    await q("select public.sign_request_send($1, $2, $3, 2)", [made.id, await sha256Hex(pdf), pdf.length]);
    await q("reset role");
    const linkFor = async (email: string) => (await q("select substring(body_text from 'sign/\\?t=([0-9a-f]+)') t from public.email_outbox where to_address = $1 order by id desc limit 1", [email]))[0]?.t as string;
    const rpc: Rpc = async (name, args) => {
      const keys = Object.keys(args);
      await q("savepoint rpc");
      try {
        await q("set local role service_role");
        const rows = await q(`select to_jsonb(public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})) as r`, keys.map((k) => {
          const v = args[k]; return v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v;
        }));
        await q("reset role"); await q("release savepoint rpc");
        return { ok: true, status: 200, body: rows[0].r };
      } catch (e) { await q("rollback to savepoint rpc"); await q("reset role"); return { ok: false, status: 400, body: { message: (e as Error).message } }; }
    };
    const files = new Map<string, Uint8Array>([[made.path, pdf]]);
    const storage: Storage = { download: async (p) => files.get(p) ?? null, upload: async (p, b) => { files.set(p, b); return true; }, remove: async () => true };
    resetForTests();
    const opts = { rpc, storage, env: () => undefined, waitUntil: () => {} };
    const call = async (action: string, body: unknown, ip: string) => {
      const r = await handle(new Request(fn + action, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "user-agent": "E2E", "x-forwarded-for": `6.6.6.6, ${ip}` } }), opts);
      return r.headers.get("content-type")?.startsWith("application/pdf") ? { pdf: new Uint8Array(await r.arrayBuffer()), status: r.status } : { ...(await r.json()), status: r.status };
    };
    const t1 = await linkFor("pat@e2e.test");
    assertEquals(await linkFor("jo@e2e.test"), undefined, "in order: Jo has no link yet");
    const o1 = await call("open", { t: t1 }, "203.0.113.31");
    assertEquals([o1.state, o1.request.title, o1.fields.length], ["ready", "Joinery contract", 2]);
    assertEquals((await call("doc", { t: t1 }, "203.0.113.31")).pdf.length, pdf.length);
    assertMatch((await call("finish", { t: t1, agree: false, values: { s1: PNG }, method: "drawn" }, "203.0.113.31")).error, /I agree to sign electronically/);
    assertEquals((await call("finish", { t: t1, agree: true, values: { s1: PNG }, method: "drawn" }, "203.0.113.31")).state, "signed");
    const t2 = await linkFor("jo@e2e.test");
    const f2 = await call("finish", { t: t2, agree: true, values: { s2: PNG, n2: "Jo E2E" }, method: "typed" }, "198.51.100.32");
    assertEquals(f2.state, "completed");
    const row = (await q("select status, signed_path, signed_sha256 from public.sign_requests where id = $1", [made.id]))[0];
    assertEquals(row.status, "completed");
    const signed = files.get(row.signed_path)!;
    assertEquals(row.signed_sha256, await sha256Hex(signed));
    assert(await hasText(signed, `Request ID: ${made.id}`) && await hasText(signed, "203.0.113.31") && await hasText(signed, "198.51.100.32") && !(await hasText(signed, "6.6.6.6")),
      "the certificate has the request, both trusted addresses and never the made-up first entry");
    const copy = await linkFor("jo@e2e.test");
    assertEquals((await call("open", { t: copy }, "198.51.100.32")).state, "completed");
    assertEquals((await call("doc", { t: copy }, "198.51.100.32")).pdf.length, signed.length, "the download link gives the signed copy");
    const sd = Deno.env.get("SIGN_OUT");
    if (sd) await Deno.writeFile(`${sd}/signed-e2e.pdf`, signed);
  } finally { await q("rollback").catch(() => {}); await db.end(); }
} });
