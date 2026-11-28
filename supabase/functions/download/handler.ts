// The "download" Edge Function (index.ts serves this): honest download counts for Riyeser HQ → Downloads.
//
//   GET /download/<program>              records one download, then 302 to the newest installer on GitHub
//   GET /download/<program>?mode=json    the same, but answers {url, tag} (riyeser.com's download page uses this, so a
//                                        problem here never stops the download: the page goes to GitHub by itself)
//   GET /download/ping                   {ok, version}
//   HEAD                                 302 only, nothing recorded (link checkers)
//
// riyeser.com/download/<program>.html sends: js=1 (it ran JavaScript), from=<the page the button was on>, tz=<the
// browser's time zone, for a rough country when the network gives none>, staff=1 (HQ's "Don't count downloads from
// this browser"), wd=1 (an automated browser), file=<the installer's name> and test=1 off riyeser.com.
// What's recorded (record_download in website/team/team-chat.sql, module/desk-assistant): the program, the release, a
// country, the page or website it came from, the browser's name and a salted hash of the internet address and browser
// that changes every day (SHA-256 with a secret; the address and browser details are never stored or logged), plus
// bot / test / staff flags. Our own CI never comes here: it downloads from GitHub directly.
// Never blocks a download: when the database or GitHub is slow or down, the browser still gets the GitHub link.
// Deployed with --no-verify-jwt (a download is a plain link, with no sign-in).

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; status: number; body: unknown }>;
type Env = (k: string) => string | undefined;
export interface Opts {
  rpc?: Rpc;
  env?: Env;
  now?: () => number;
  fetch?: typeof fetch;                       // for finding the release on GitHub
  waitUntil?: (p: Promise<unknown>) => void;
}

export const VERSION = "2026-11-28";
// Releases live in the public downloads repository (docs/GOING-PRIVATE.md): the one place to change its name here.
export const REPO = "raka1987/riyeser-downloads";
// The code repository, where releases were published before. Asked only while the downloads repository has no such
// file yet (GitHub answers 404), so downloads work before and after the switch. Harmless once it's private (404 too).
export const OLD_REPO = "raka1987/Riyeser";
const latest = (repo: string) => `https://github.com/${repo}/releases/latest/download/`;
const LATEST = latest(REPO);
const SITE = "https://riyeser.com";

// Each program's installer (the same names as website/build.mjs). The page also sends file=, which wins when it's one
// of our installer names, so a renamed file needs no new function.
export const FILES: Record<string, string> = {
  central: "RiyeserCentral-Setup.exe", invoices: "RiyeserInvoices-Setup.exe", "accounting-basics": "RiyeserAccountingBasics-Setup.exe",
  accounting: "RiyeserAccountingPlus-Setup.exe", pos: "RiyeserPOS-Setup.exe", bookings: "RiyeserBookings-Setup.exe",
  estimate: "RiyeserEstimate-Setup.exe", payroll: "RiyeserPayroll-Setup.exe", documents: "RiyeserDeskAssistant-Setup.exe",
  link: "RiyeserTeam-Setup.exe", "link-office": "RiyeserLinkOffice-Setup.exe", pdf: "RiyeserPDF-Setup.exe", services: "RiyeserServices-Setup.exe",
};
export const FILE_RE = /^Riye?ser[A-Za-z]{2,40}-Setup\.exe$/;
const PROGRAM_RE = /^[a-z0-9-]{1,40}$/;

// Robots, link previews, scripts and download tools. (A person on a phone or PC never matches.)
export const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|scrap|curl|wget|python|httpx|aiohttp|go-http|java\/|okhttp|libwww|headless|phantom|lighthouse|preview|facebookexternalhit|whatsapp|telegram|discord|slack|skype|monitor|uptime|pingdom|scan|virustotal|axios|node-fetch|undici|powershell|winhttp|postman|insomnia|feed|checker|validator/i;
// Continuous integration and test runners.
export const CI_RE = /github-actions|actions-runner|azure-pipelines|jenkins|buildkite|gitlab-runner|circleci|travis|teamcity|bitbucket-pipelines/i;

// A rough country from the browser's time zone, when the network doesn't say (the Pacific first: most customers).
export const TZ_COUNTRY: Record<string, string> = {
  "Pacific/Fiji": "FJ", "Pacific/Auckland": "NZ", "Pacific/Chatham": "NZ", "Pacific/Apia": "WS", "Pacific/Tongatapu": "TO", "Pacific/Efate": "VU",
  "Pacific/Guadalcanal": "SB", "Pacific/Port_Moresby": "PG", "Pacific/Bougainville": "PG", "Pacific/Noumea": "NC", "Pacific/Tahiti": "PF",
  "Pacific/Rarotonga": "CK", "Pacific/Niue": "NU", "Pacific/Tarawa": "KI", "Pacific/Funafuti": "TV", "Pacific/Nauru": "NR", "Pacific/Majuro": "MH",
  "Pacific/Pago_Pago": "AS", "Pacific/Guam": "GU", "Pacific/Palau": "PW", "Pacific/Honolulu": "US", "Pacific/Pohnpei": "FM", "Pacific/Chuuk": "FM",
  "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Singapore": "SG", "Asia/Manila": "PH", "Asia/Jakarta": "ID", "Asia/Kuala_Lumpur": "MY",
  "Asia/Tokyo": "JP", "Asia/Shanghai": "CN", "Asia/Hong_Kong": "HK", "Asia/Dubai": "AE", "Asia/Karachi": "PK", "Asia/Dhaka": "BD",
  "Asia/Bangkok": "TH", "Asia/Ho_Chi_Minh": "VN", "Asia/Seoul": "KR", "Asia/Colombo": "LK", "Asia/Kathmandu": "NP",
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES", "Europe/Rome": "IT",
  "Europe/Amsterdam": "NL", "America/Toronto": "CA", "America/Vancouver": "CA", "America/New_York": "US", "America/Chicago": "US",
  "America/Denver": "US", "America/Los_Angeles": "US", "America/Phoenix": "US", "America/Anchorage": "US", "America/Sao_Paulo": "BR",
  "America/Mexico_City": "MX", "Africa/Johannesburg": "ZA", "Africa/Lagos": "NG", "Africa/Nairobi": "KE",
};
const tzCountry = (tz: string) => TZ_COUNTRY[tz] ?? (/^Australia\//.test(tz) ? "AU" : null);

/** The part after the function's name: /functions/v1/download/central and /download/central are both "central". */
export function programOf(pathname: string): string {
  return pathname.replace(/\/+$/, "").replace(/^\/functions\/v1(?=\/)/, "").replace(/^\/download(?=\/|$)/, "").replace(/^\//, "").toLowerCase();
}

export function clientIp(req: Request): string {
  const raw = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
  return /^[0-9a-fA-F:.]{2,45}$/.test(raw) ? raw : "";
}

export function browserOf(ua: string): string {
  return /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung" : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Other";
}

export function countryOf(req: Request, tz: string): string | null {
  for (const h of ["cf-ipcountry", "x-country", "x-country-code", "x-vercel-ip-country", "cloudfront-viewer-country", "x-appengine-country"]) {
    const v = (req.headers.get(h) ?? "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(v) && v !== "XX" && v !== "T1") return v;
  }
  return tzCountry(tz);
}

/** Where the button was: a riyeser.com page ("/programs/pos.html") or another website's name ("google.com"). */
export function referrerOf(from: string, referer: string): string | null {
  if (/^\/[A-Za-z0-9/._-]{0,99}$/.test(from)) return from;
  if (/^[a-z0-9.-]{3,100}$/i.test(from) && from.includes(".")) return /(^|\.)riyeser\.com$/i.test(from) ? null : from.toLowerCase().replace(/^www\./, "");
  try {
    const u = new URL(referer);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (/(^|\.)riyeser\.com$/i.test(u.hostname)) return /\/download\//.test(u.pathname) ? null : u.pathname.slice(0, 100);
    return u.hostname.toLowerCase().replace(/^www\./, "").slice(0, 100);
  } catch { return null; }
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** The daily, salted visitor hash: the same person on the same UTC day gives the same value; nothing else can be told from it. */
export async function visitorHash(salt: string, day: string, ip: string, ua: string): Promise<string> {
  return (await sha256Hex(`riyeser-download|${salt}|${day}|${ip}|${ua}`)).slice(0, 32);
}

export interface Flags { js: boolean; bot: boolean; test: boolean; staff: boolean; skip: boolean }
/** bot: a robot's browser name, an automated browser, or no JavaScript and no sign of a real browser. skip: prefetches. */
export function flagsOf(req: Request, q: URLSearchParams): Flags {
  const ua = req.headers.get("user-agent") ?? "";
  const js = q.get("js") === "1";
  const purpose = `${req.headers.get("sec-purpose") ?? ""} ${req.headers.get("purpose") ?? ""} ${req.headers.get("x-moz") ?? ""}`;
  const test = q.get("test") === "1" || req.headers.has("x-riyeser-test") || CI_RE.test(ua);
  const bot = !ua || BOT_RE.test(ua) || q.get("wd") === "1"
    || (!js && (!/^Mozilla\//.test(ua) || !req.headers.get("accept-language")));
  return { js, bot, test, staff: q.get("staff") === "1", skip: /prefetch|prerender/i.test(purpose) };
}

// GitHub: the newest release's file and tag, from the "latest" link's redirect (no API, so no rate limit). Kept 10 minutes.
// The downloads repository first; the old code repository only when the downloads repository says it has no such file.
const cache = new Map<string, { at: number; url: string; tag: string | null }>();
export function clearCache() { cache.clear(); recent.clear(); }
export async function resolveAsset(file: string, f: typeof fetch, now: number): Promise<{ url: string; tag: string | null }> {
  const hit = cache.get(file);
  if (hit && now - hit.at < 10 * 60 * 1000) return hit;
  let fallback = { url: LATEST + file, tag: null as string | null };
  for (const repo of [REPO, OLD_REPO]) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
      const r = await f(latest(repo) + file, { method: "HEAD", redirect: "manual", signal: ctl.signal }).finally(() => clearTimeout(t));
      const loc = r.headers.get("location") ?? "";
      await r.body?.cancel();
      const m = new RegExp(`^https://github\\.com/${repo.replace("/", "\\/")}/releases/download/([A-Za-z0-9._-]{1,80})/${file.replace(/\./g, "\\.")}$`, "i").exec(loc);
      if (r.status >= 300 && r.status < 400 && m) { const v = { at: now, url: loc, tag: m[1] }; cache.set(file, v); return v; }
      if (r.status !== 404) break;                  // anything but "not here": don't guess, use the latest link
      // not in the downloads repository (yet): the old one's link; in neither: back to the downloads repository's
      fallback = { url: (repo === REPO ? latest(OLD_REPO) : LATEST) + file, tag: null };
    } catch { break; /* GitHub slow or down: the latest link still works */ }
  }
  return fallback;
}

// A little per-instance limit on top of the database's (30 a visitor an hour): 10 a minute.
const recent = new Map<string, number[]>();
function tooMany(visitor: string, now: number): boolean {
  const l = (recent.get(visitor) ?? []).filter((t) => now - t < 60000);
  l.push(now); recent.set(visitor, l);
  if (recent.size > 5000) recent.clear();
  return l.length > 10;
}

const ORIGINS = /^(https:\/\/(www\.)?riyeser\.com|https:\/\/raka1987\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") ?? "";
  return ORIGINS.test(o) ? { "Access-Control-Allow-Origin": o, Vary: "Origin" } : {};
}
const BASE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
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

export async function handle(req: Request, opts: Opts = {}): Promise<Response> {
  const env: Env = opts.env ?? ((k) => Deno.env.get(k));
  const now = (opts.now ?? Date.now)();
  const u = new URL(req.url);
  const program = programOf(u.pathname);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...BASE, ...cors(req), "Access-Control-Allow-Methods": "GET, HEAD" } });
  if (req.method !== "GET" && req.method !== "HEAD") return json(req, 405, { error: "GET only" });
  if (program === "ping" || program === "") return json(req, 200, { ok: true, version: VERSION });
  const q = u.searchParams;
  const asked = q.get("file") ?? "";
  const file = FILE_RE.test(asked) ? asked : PROGRAM_RE.test(program) ? FILES[program] : undefined;
  if (!file || !PROGRAM_RE.test(program)) {
    return new Response(`<!doctype html><meta charset="utf-8"><title>Not found</title><p>That download isn't here. See <a href="${SITE}/downloads.html">riyeser.com/downloads</a>.</p>`,
      { status: 404, headers: { ...BASE, "Content-Type": "text/html; charset=utf-8" } });
  }
  const asset = await resolveAsset(file, opts.fetch ?? fetch, now);
  const go = () => q.get("mode") === "json" ? json(req, 200, { url: asset.url, tag: asset.tag })
    : new Response(null, { status: 302, headers: { ...BASE, ...cors(req), Location: asset.url } });
  if (req.method === "HEAD") return go();

  const flags = flagsOf(req, q);
  if (flags.skip) return go();
  const record = (async () => {
    const ua = (req.headers.get("user-agent") ?? "").slice(0, 400);
    const salt = env("DOWNLOAD_SALT") || env("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!salt) return;   // never an unsalted hash
    const visitor = await visitorHash(salt, new Date(now).toISOString().slice(0, 10), clientIp(req), ua);
    if (tooMany(visitor, now)) return;
    const rpc = opts.rpc ?? rpcFrom(env);
    await rpc("record_download", {
      program, release_tag: asset.tag, country: countryOf(req, (q.get("tz") ?? "").slice(0, 60)),
      referrer: referrerOf(q.get("from") ?? "", req.headers.get("referer") ?? ""), visitor, browser: flags.bot ? "Other" : browserOf(ua),
      js: flags.js, bot: flags.bot, test: flags.test, staff: flags.staff,
    });
  })().catch(() => { /* never stops the download */ });
  const edge = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const later = opts.waitUntil ?? (edge ? (p: Promise<unknown>) => edge.waitUntil(p) : null);
  if (later) later(record);
  else await Promise.race([record, new Promise((r) => setTimeout(r, 1500))]);
  return go();
}
