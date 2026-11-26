// Outbound webhooks: signing (HMAC-SHA256) and the dispatcher.
//
// Each delivery is POSTed as JSON with these headers:
//   Riyeser-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>", keyed with the webhook's secret (whsec_…, as UTF-8)>
//   Riyeser-Event: booking.received (etc.)      Riyeser-Delivery: <delivery id>      Content-Type: application/json
// Receivers should check the signature (constant-time) and that t is within 5 minutes, and use the body's "id" to
// ignore repeats (a delivery can arrive more than once). A 2xx answer within 10 seconds counts as delivered; anything
// else is retried after 1, 5, 30 minutes, 2, 6, 12 and 24 hours (the database keeps the schedule).
//
// The dispatcher runs (1) straight after the API takes something in, for that business, and (2) every 5 minutes from
// .github/workflows/api-webhooks.yml (POST /internal/dispatch), which also picks up what the PCs announced and retries.

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; status: number; body: unknown }>;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
/** Compare two strings without leaking where they differ (the time taken depends only on the length). */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

export async function signatureHeader(secret: string, body: string, unixSeconds: number): Promise<string> {
  return `t=${unixSeconds},v1=${await hmacHex(secret, `${unixSeconds}.${body}`)}`;
}
/** What a receiver does (also in the developer docs): true if the signature is right and recent. */
export async function verifySignature(secret: string, body: string, header: string, nowSeconds: number, toleranceSeconds = 300): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  return safeEqual(await hmacHex(secret, `${t}.${body}`), parts.v1);
}

/** Only public https addresses (checked again here, as well as when the webhook was saved). */
export function safeUrl(u: string): boolean {
  let x: URL;
  try { x = new URL(u); } catch { return false; }
  if (x.protocol !== "https:" || x.username || x.password) return false;
  const h = x.hostname.toLowerCase();
  if (!h.includes(".") || h.endsWith(".")) return false;
  if (/^[0-9.]+$/.test(h) || h.startsWith("[")) return false;                       // no bare IPv4 / IPv6
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(h)) return false;
  if (h.endsWith(".supabase.co") || h.endsWith(".supabase.in")) return false;         // never back into Supabase
  return true;
}

type Due = { id: string; url: string; secret: string; event: string; attempt: number; payload: unknown };

export async function dispatch(rpc: Rpc, o: { ws?: string; max?: number; fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const due = await rpc("api_webhooks_due", { max_n: o.max ?? 50, only_ws: o.ws ?? null });
  if (!due.ok || !Array.isArray(due.body)) return { sent: 0, failed: 0, error: "could not read deliveries" };
  let sent = 0, failed = 0;
  const one = async (d: Due) => {
    let ok = false, status: number | null = null, err: string | null = null;
    if (!safeUrl(d.url)) {
      err = "Address not allowed";
    } else {
      const body = JSON.stringify(d.payload);
      try {
        const r = await f(d.url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Riyeser-Webhooks/1",
            "Riyeser-Event": d.event,
            "Riyeser-Delivery": d.id,
            "Riyeser-Signature": await signatureHeader(d.secret, body, Math.floor(now() / 1000)),
          },
          body,
        });
        status = r.status;
        ok = r.status >= 200 && r.status < 300;
        if (!ok) err = `HTTP ${r.status}`;
        await r.body?.cancel();
      } catch (e) {
        err = e instanceof DOMException && e.name === "TimeoutError" ? "Timed out after 10 seconds" : "Could not connect";
      }
    }
    ok ? sent++ : failed++;
    await rpc("api_webhook_result", { delivery_id: d.id, ok, http_status: status, err });
  };
  const list = due.body as Due[];
  for (let i = 0; i < list.length; i += 5) await Promise.all(list.slice(i, i + 5).map(one));   // 5 at a time
  return { sent, failed };
}
