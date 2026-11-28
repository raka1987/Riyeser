// The "sign" Edge Function (index.ts serves this): the public page riyeser.com/sign/?t=… for people asked to sign a
// PDF from Riyeser PDF ("Ask someone to sign"). It is the only way in for signers: the database side (sign_pub_* in
// website/team/team-chat.sql, branch module/desk-assistant) can only be run with the service role.
//
//   GET  /sign/ping                 {ok, version}
//   POST /sign/open    {t}          what the link is for: {state, request, signer, fields…} (marks it Viewed)
//   POST /sign/doc     {t}          the PDF (the original while it can be signed; the signed copy once completed),
//                                   only if its SHA-256 still matches the one recorded when it was sent
//   POST /sign/finish  {t, agree, values, method, day}   sign; when the last person signs, the signed copy is made here
//   POST /sign/decline {t, reason}
//
// The link's token never reaches the database: only its SHA-256 (the database keeps nothing else either). Never logged.
// The internet address recorded for a signer: see clientIp (SEC-017: never the first X-Forwarded-For entry, which the
// caller can write). Rate limits: per address in the database (sign_hit), plus a small per-instance limit here.
// Clean-up: every few minutes a request also deletes files whose keeping time is up (sign_pub_files_due).
// Deployed with --no-verify-jwt: signers have no Riyeser account; the link is their key.
import { buildSigned, type Bundle, sha256Hex } from "./certificate.ts";

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; status: number; body: unknown }>;
export interface Storage {
  download(path: string): Promise<Uint8Array | null>;
  upload(path: string, bytes: Uint8Array): Promise<boolean>;
  remove(paths: string[]): Promise<boolean>;
}
type Env = (k: string) => string | undefined;
export interface Opts { rpc?: Rpc; storage?: Storage; env?: Env; now?: () => number; waitUntil?: (p: Promise<unknown>) => void }

export const VERSION = "2026-11-28";
export const BUCKET = "sign-docs";
export const MAX_BODY = 1_500_000;   // signatures are small PNGs; the PDF never comes this way
export const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * The signer's internet address, as recorded on the certificate. Never the first X-Forwarded-For entry (anyone can
 * send that header with any value; SEC-017). In order: Cloudflare's cf-connecting-ip (Cloudflare sets it and replaces
 * whatever the caller sent), else the X-Forwarded-For entry added by our own proxy: the last one, or the one
 * SIGN_TRUSTED_HOPS (default 1) from the end when there are more proxies in front, else x-real-ip.
 * chain: the whole X-Forwarded-For as received (cut to 200 characters), kept as evidence next to it.
 * Which header Supabase really sets must be checked on staging with a made-up X-Forwarded-For (SEC-017).
 */
export function clientIp(req: Request, hops = 1): { ip: string | null; chain: string | null } {
  const ok = (s: string | null | undefined) => (s && /^[0-9a-fA-F:.]{2,45}$/.test(s.trim()) ? s.trim() : null);
  const raw = req.headers.get("x-forwarded-for") ?? "";
  const chain = raw ? raw.slice(0, 200) : null;
  const cf = ok(req.headers.get("cf-connecting-ip"));
  if (cf) return { ip: cf, chain };
  const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
  const n = Math.max(1, Math.floor(hops) || 1);
  const fromProxy = list.length >= n ? ok(list[list.length - n]) : null;
  return { ip: fromProxy ?? ok(req.headers.get("x-real-ip")), chain };
}

const ORIGINS = /^(https:\/\/(www\.)?riyeser\.com|https:\/\/raka1987\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") ?? "";
  return ORIGINS.test(o) ? { "Access-Control-Allow-Origin": o, Vary: "Origin", "Access-Control-Expose-Headers": "X-Doc-Sha256, X-Doc-Kind" } : {};
}
const BASE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...BASE, ...cors(req), "Content-Type": "application/json; charset=utf-8" } });

function rpcFrom(env: Env): Rpc {
  const url = env("SUPABASE_URL") ?? ""; const k = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return async (name, args) => {
    const r = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    let body: unknown = null; try { body = await r.json(); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, body };
  };
}
function storageFrom(env: Env): Storage {
  const url = `${env("SUPABASE_URL") ?? ""}/storage/v1/object`; const k = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const h = { apikey: k, Authorization: `Bearer ${k}` };
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  return {
    async download(path) { const r = await fetch(`${url}/${BUCKET}/${enc(path)}`, { headers: h }); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; },
    async upload(path, bytes) {
      const r = await fetch(`${url}/${BUCKET}/${enc(path)}`, { method: "POST", headers: { ...h, "Content-Type": "application/pdf", "x-upsert": "true" }, body: bytes as BodyInit });
      await r.body?.cancel(); return r.ok;
    },
    async remove(paths) {
      const r = await fetch(`${url}/${BUCKET}`, { method: "DELETE", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: paths }) });
      await r.body?.cancel(); return r.ok;
    },
  };
}

async function readLimited(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? "0") > max) return null;
  if (!req.body) return "";
  const rd = req.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length; if (n > max) { await rd.cancel(); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return new TextDecoder().decode(all);
}

// A small per-instance limit on top of the database's: 40 requests a minute from one address.
const recent = new Map<string, number[]>();
let lastSweep = 0;
export function resetForTests() { recent.clear(); lastSweep = 0; }
function tooMany(ip: string, now: number): boolean {
  const l = (recent.get(ip) ?? []).filter((t) => now - t < 60000);
  l.push(now); recent.set(ip, l);
  if (recent.size > 5000) recent.clear();
  return l.length > 40;
}

const plainState = (body: unknown) => (body && typeof body === "object" ? body as Record<string, unknown> : {});

/** Everyone has signed: stamp the fields, add the certificate, store signed.pdf, mark it completed. */
export async function completeRequest(id: string, rpc: Rpc, storage: Storage, now: number): Promise<boolean> {
  const c = await rpc("sign_pub_claim", { req: id });
  if (!c.ok || !c.body) return false;                    // someone else is making it, or it isn't ready
  const b = c.body as Bundle;
  const original = await storage.download(b.original_path);
  if (!original) throw new Error("original missing");
  const out = await buildSigned(original, b, new Date(now).toISOString());
  const path = `${b.workspace_id}/${b.id}/signed.pdf`;
  if (!(await storage.upload(path, out.bytes))) throw new Error("upload failed");
  const done = await rpc("sign_pub_complete", { req: id, path, sha256: out.final, content_sha256: out.content });
  return done.ok && plainState(done.body).state === "completed";
}

/** Files whose keeping time is up (and drafts never sent): delete them, then tell the database. */
export async function sweepFiles(rpc: Rpc, storage: Storage): Promise<number> {
  const due = await rpc("sign_pub_files_due", { lim: 20 });
  const list = Array.isArray(due.body) ? due.body as { id: string; paths: string[] }[] : [];
  const gone: string[] = [];
  for (const d of list) { if (!d.paths.length || await storage.remove(d.paths)) gone.push(d.id); }
  if (gone.length) await rpc("sign_pub_files_gone", { ids: gone });
  return gone.length;
}

export async function handle(req: Request, opts: Opts = {}): Promise<Response> {
  const env: Env = opts.env ?? ((k) => Deno.env.get(k));
  const now = (opts.now ?? Date.now)();
  const action = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...BASE, ...cors(req), "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "600" } });
  }
  if (action === "ping") return json(req, 200, { ok: true, version: VERSION });
  if (req.method !== "POST") return json(req, 405, { error: "POST only." });
  if (!["open", "doc", "finish", "decline"].includes(action)) return json(req, 404, { error: "Not found." });
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return json(req, 415, { error: "Send JSON." });

  const { ip, chain } = clientIp(req, Number(env("SIGN_TRUSTED_HOPS") ?? "1"));
  if (tooMany(ip ?? "unknown", now)) return json(req, 429, { error: "Too many tries from here. Wait a minute and try again.", state: "busy" });
  const text = await readLimited(req, MAX_BODY);
  if (text === null) return json(req, 413, { error: "That's too much to send. Draw the signature again, a little smaller." });
  let q: Record<string, unknown>;
  try { q = JSON.parse(text || "{}"); } catch { return json(req, 400, { error: "Send JSON." }); }
  const t = typeof q.t === "string" ? q.t.trim().toLowerCase() : "";
  if (!TOKEN_RE.test(t)) return json(req, 200, { state: "unknown" });
  const tok_hash = await sha256Hex(t);
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 400);
  const rpc = opts.rpc ?? rpcFrom(env); const storage = opts.storage ?? storageFrom(env);

  // the clean-up, at most every 10 minutes per instance, never holding up the signer
  if (now - lastSweep > 10 * 60 * 1000) {
    lastSweep = now;
    const p = sweepFiles(rpc, storage).catch(() => 0);
    const edge = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
    if (opts.waitUntil) opts.waitUntil(p); else if (edge) edge.waitUntil(p); else await p;
  }
  const finishUp = async (r: Record<string, unknown>) => {
    const id = typeof r._complete === "string" ? r._complete : null;
    delete r._complete;
    if (id) {
      try { if (await completeRequest(id, rpc, storage, now)) r.state = "completed"; }
      catch (e) { console.error("sign: making the signed copy failed", (e as Error).message); }   // tried again on the next open
    }
    return r;
  };

  try {
    if (action === "open") {
      const r = await rpc("sign_pub_open", { tok_hash, ip, ip_chain: chain, ua });
      if (!r.ok) return json(req, 503, { error: "Riyeser can't open this right now. Try again in a minute." });
      const body = await finishUp(plainState(r.body));
      return json(req, body.state === "busy" ? 429 : 200, body);
    }
    if (action === "doc") {
      const r = await rpc("sign_pub_doc", { tok_hash, ip });
      const d = plainState(r.body);
      if (!r.ok) return json(req, 503, { error: "Riyeser can't open this right now. Try again in a minute." });
      if (d.state === "busy") return json(req, 429, { error: "Too many tries from here. Wait a few minutes and try again.", state: "busy" });
      if (typeof d.path !== "string") return json(req, 404, { error: "This document isn't available.", state: d.state ?? "unknown" });
      const bytes = await storage.download(d.path);
      if (!bytes) return json(req, 404, { error: "This document isn't available any more.", state: "gone" });
      const sha = await sha256Hex(bytes);
      if (sha !== d.sha256) {
        console.error("sign: stored file doesn't match its recorded SHA-256");
        return json(req, 409, { error: "This document has changed since it was sent, so it can't be shown. Ask the sender to send it again.", state: "changed" });
      }
      const name = String(d.name ?? "document").replace(/[^\w .()-]+/g, "").slice(0, 80) || "document";
      return new Response(bytes as BodyInit, { status: 200, headers: { ...BASE, ...cors(req), "Content-Type": "application/pdf", "X-Doc-Sha256": sha, "X-Doc-Kind": String(d.state),
        "Content-Disposition": `${d.state === "completed" ? "attachment" : "inline"}; filename="${name}${d.state === "completed" ? " (signed)" : ""}.pdf"` } });
    }
    if (action === "finish") {
      const values = q.values && typeof q.values === "object" && !Array.isArray(q.values) ? q.values : {};
      const r = await rpc("sign_pub_finish", { tok_hash, ip, ip_chain: chain, ua, vals: values, agreed: q.agree === true,
        method: q.method === "typed" ? "typed" : q.method === "drawn" ? "drawn" : null, local_day: typeof q.day === "string" ? q.day.slice(0, 10) : null });
      if (!r.ok) return json(req, 503, { error: "Riyeser can't save this right now. Try again in a minute." });
      const body = plainState(r.body);
      if (typeof body.error === "string") return json(req, body.busy ? 429 : 400, { error: body.error });
      return json(req, 200, await finishUp(body));
    }
    const reason = typeof q.reason === "string" ? q.reason.slice(0, 600) : "";
    const r = await rpc("sign_pub_decline", { tok_hash, ip, ip_chain: chain, ua, reason });
    if (!r.ok) return json(req, 503, { error: "Riyeser can't save this right now. Try again in a minute." });
    const body = plainState(r.body);
    if (typeof body.error === "string") return json(req, body.busy ? 429 : 400, { error: body.error });
    return json(req, 200, body);
  } catch (e) {
    console.error("sign:", action, (e as Error).message);
    return json(req, 503, { error: "Riyeser can't do this right now. Try again in a minute." });
  }
}
