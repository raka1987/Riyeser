// deno test supabase/functions/download — the download counter against a pretend database and a pretend GitHub.
//  - a browser click: recorded once (program, release tag, country, page, browser, a daily hash), then 302 to the file
//  - mode=json (riyeser.com's page): {url, tag}, CORS only for riyeser.com
//  - the hash: no raw address or browser details sent; the same person the same day matches, the next day doesn't
//  - flags: robots and download tools, automated browsers, no JavaScript and no browser; CI and our test header;
//    staff; prefetches and HEAD not recorded
//  - never blocks: the database failing or GitHub down still sends the browser on (to the "latest" link)
//  - unknown programs are 404; file= only for our installer names (never another website); ping
import { assert, assertEquals, assertFalse, assertMatch } from "jsr:@std/assert@1";
import { BOT_RE, clearCache, countryOf, FILES, handle, OLD_REPO, programOf, referrerOf, REPO, type Rpc, visitorHash } from "./handler.ts";

const TAG = "riyeser-2026.11.27-60";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NOW = Date.parse("2026-11-27T03:00:00Z");
const fn = "https://x.supabase.co/functions/v1/download/";

function world(o: { dbFails?: boolean; githubDown?: boolean; notInDownloads?: boolean; inNeither?: boolean } = {}) {
  const calls: Record<string, unknown>[] = []; const later: Promise<unknown>[] = []; const gh: string[] = [];
  const rpc: Rpc = async (name, args) => { if (o.dbFails) throw new Error("db down"); assertEquals(name, "record_download"); calls.push(args); return { ok: true, status: 200, body: "ok" }; };
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    gh.push(String(url)); assertEquals(init?.method, "HEAD"); assertEquals(init?.redirect, "manual");
    if (o.githubDown) throw new Error("offline");
    const file = String(url).split("/").pop();
    // notInDownloads: the downloads repository has no release yet (before the first one there); inNeither: no such file anywhere
    const repo = String(url).startsWith(`https://github.com/${REPO}/`) ? REPO : OLD_REPO;
    if (o.inNeither || (o.notInDownloads && repo === REPO)) return new Response("Not Found", { status: 404 });
    return new Response(null, { status: 302, headers: { location: `https://github.com/${repo}/releases/download/${TAG}/${file}` } });
  }) as typeof fetch;
  const opts = { rpc, env: (k: string) => ({ DOWNLOAD_SALT: "pepper-for-tests" } as Record<string, string>)[k], now: () => NOW, fetch: fetchFn, waitUntil: (p: Promise<unknown>) => { later.push(p); } };
  const get = async (path: string, headers: Record<string, string> = {}, method = "GET") => {
    const r = await handle(new Request(fn + path, { method, headers: { "user-agent": CHROME, "accept-language": "en-FJ", "x-forwarded-for": "203.0.113.7, 10.0.0.1", ...headers } }), opts);
    await Promise.all(later); return r;
  };
  return { calls, gh, get, opts };
}

Deno.test("a click on riyeser.com: one row, then on to the newest file on GitHub", async () => {
  clearCache(); const w = world();
  const r = await w.get("central?js=1&from=/programs/central.html&tz=Pacific/Fiji");
  assertEquals(r.status, 302);
  assertEquals(r.headers.get("location"), `https://github.com/raka1987/riyeser-downloads/releases/download/${TAG}/RiyeserCentral-Setup.exe`);
  assertEquals(r.headers.get("cache-control"), "no-store");
  assertEquals(w.calls.length, 1);
  const c = w.calls[0];
  assertEquals([c.program, c.release_tag, c.country, c.referrer, c.browser, c.js, c.bot, c.test, c.staff], ["central", TAG, "FJ", "/programs/central.html", "Chrome", true, false, false, false]);
  assertMatch(String(c.visitor), /^[0-9a-f]{32}$/);
  const sent = JSON.stringify(w.calls);
  assertFalse(sent.includes("203.0.113.7") || sent.includes("Windows NT") || sent.includes("pepper"), "no address, browser details or salt sent");
});

Deno.test("the daily hash: the same person matches on the same day only", async () => {
  const a = await visitorHash("s", "2026-11-27", "203.0.113.7", CHROME);
  assertEquals(a, await visitorHash("s", "2026-11-27", "203.0.113.7", CHROME));
  assert(a !== await visitorHash("s", "2026-11-28", "203.0.113.7", CHROME), "a new day, a new hash");
  assert(a !== await visitorHash("s", "2026-11-27", "203.0.113.8", CHROME), "another address");
  assert(a !== await visitorHash("t", "2026-11-27", "203.0.113.7", CHROME), "another salt");
  clearCache(); const w = world(); await w.get("pos?js=1"); await w.get("pos?js=1");
  assertEquals(w.calls[0].visitor, w.calls[1].visitor);
});

Deno.test("mode=json for riyeser.com's download page, with CORS for riyeser.com only", async () => {
  clearCache(); const w = world();
  const r = await w.get("pos?js=1&mode=json", { origin: "https://riyeser.com" });
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { url: `https://github.com/raka1987/riyeser-downloads/releases/download/${TAG}/RiyeserPOS-Setup.exe`, tag: TAG });
  assertEquals(r.headers.get("access-control-allow-origin"), "https://riyeser.com");
  const e = await w.get("pos?js=1&mode=json", { origin: "https://evil.example" });
  assertEquals(e.headers.get("access-control-allow-origin"), null); await e.body?.cancel();
  assertEquals(w.calls.length, 2);
});

Deno.test("robots, tools, automated browsers and no-JavaScript non-browsers are marked bot", async () => {
  clearCache(); const w = world();
  for (const ua of ["Googlebot/2.1 (+http://www.google.com/bot.html)", "curl/8.4.0", "Wget/1.21", "python-requests/2.31", "facebookexternalhit/1.1", "WhatsApp/2.23", "Mozilla/5.0 (compatible; bingbot/2.0)", ""]) {
    (await w.get("central", { "user-agent": ua })).body?.cancel();
  }
  assert(w.calls.every((c) => c.bot === true), JSON.stringify(w.calls.map((c) => c.bot)));
  w.calls.length = 0;
  (await w.get("central?js=1&wd=1")).body?.cancel();                               // navigator.webdriver
  (await w.get("central", { "accept-language": "" })).body?.cancel();              // no JavaScript, no language: not a person's browser
  assert(w.calls.every((c) => c.bot === true));
  w.calls.length = 0;
  (await w.get("central")).body?.cancel();                                         // the plain link with JavaScript off: still a person
  assertEquals([w.calls[0].bot, w.calls[0].js], [false, false]);
  assertFalse(BOT_RE.test(CHROME) || BOT_RE.test("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"), "real browsers aren't robots");
});

Deno.test("tests: CI, our test header and test=1; staff: HQ's tick", async () => {
  clearCache(); const w = world();
  (await w.get("central?js=1", { "x-riyeser-test": "1" })).body?.cancel();
  (await w.get("central?js=1&test=1")).body?.cancel();
  (await w.get("central", { "user-agent": "GitHub-Actions-Runner/2.320" })).body?.cancel();
  assert(w.calls.every((c) => c.test === true));
  w.calls.length = 0;
  (await w.get("central?js=1&staff=1")).body?.cancel();
  assertEquals([w.calls[0].staff, w.calls[0].test, w.calls[0].bot], [true, false, false]);
});

Deno.test("prefetches and HEAD go on to the file without being counted", async () => {
  clearCache(); const w = world();
  const h = await w.get("central", {}, "HEAD"); assertEquals(h.status, 302);
  const p = await w.get("central?js=1", { "sec-purpose": "prefetch" }); assertEquals(p.status, 302);
  assertEquals(w.calls.length, 0);
});

Deno.test("never blocks: the database failing, or GitHub down, still sends the browser on", async () => {
  clearCache(); const a = world({ dbFails: true });
  const r = await a.get("central?js=1"); assertEquals(r.status, 302);
  assertMatch(r.headers.get("location") ?? "", /RiyeserCentral-Setup\.exe$/);
  clearCache(); const b = world({ githubDown: true });
  const s = await b.get("pdf?js=1"); assertEquals(s.status, 302);
  assertEquals(s.headers.get("location"), "https://github.com/raka1987/riyeser-downloads/releases/latest/download/RiyeserPDF-Setup.exe");
  assertEquals(b.calls[0].release_tag, null);
});

Deno.test("before the downloads repository has a release: on to the old code repository's file (and its tag)", async () => {
  clearCache(); const w = world({ notInDownloads: true });
  const r = await w.get("central?js=1");
  assertEquals(r.status, 302);
  assertEquals(r.headers.get("location"), `https://github.com/raka1987/Riyeser/releases/download/${TAG}/RiyeserCentral-Setup.exe`);
  assertEquals(w.gh, ["https://github.com/raka1987/riyeser-downloads/releases/latest/download/RiyeserCentral-Setup.exe",
    "https://github.com/raka1987/Riyeser/releases/latest/download/RiyeserCentral-Setup.exe"]);
  assertEquals(w.calls[0].release_tag, TAG);
  clearCache(); const n = world({ inNeither: true });
  const s = await n.get("pdf?js=1"); assertEquals(s.status, 302);
  assertEquals(s.headers.get("location"), "https://github.com/raka1987/riyeser-downloads/releases/latest/download/RiyeserPDF-Setup.exe");
});

Deno.test("GitHub is asked once per file every 10 minutes", async () => {
  clearCache(); const w = world();
  for (let i = 0; i < 3; i++) (await w.get("bookings?js=1")).body?.cancel();
  assertEquals(w.gh.filter((u) => u.endsWith("RiyeserBookings-Setup.exe")).length, 1);
});

Deno.test("a per-instance limit: a flood is sent on, but not all recorded", async () => {
  clearCache(); const w = world();
  for (let i = 0; i < 25; i++) (await w.get("central?js=1")).body?.cancel();
  assertEquals(w.calls.length, 10);
});

Deno.test("unknown programs, odd files and other websites", async () => {
  clearCache(); const w = world();
  const r = await w.get("not-a-program?js=1"); assertEquals(r.status, 404); await r.body?.cancel();
  const bad = await w.get("Bad%20Program"); assertEquals(bad.status, 404); await bad.body?.cancel();
  const evil = await w.get("central?file=https://evil.example/x.exe"); assertMatch(evil.headers.get("location") ?? "", /\/RiyeserCentral-Setup\.exe$/);
  const named = await w.get("documents?file=RiyeserDocuments-Setup.exe"); assertMatch(named.headers.get("location") ?? "", /\/RiyeserDocuments-Setup\.exe$/);
  const ping = await w.get("ping"); assertEquals((await ping.json()).ok, true);
  const post = await handle(new Request(fn + "central", { method: "POST" }), w.opts); assertEquals(post.status, 405); await post.body?.cancel();
  for (const f of Object.values(FILES)) assertMatch(f, /^Riyeser[A-Za-z]+-Setup\.exe$/);
});

Deno.test("helpers: the program from the path, country, referrer", () => {
  assertEquals(programOf("/functions/v1/download/central"), "central");
  assertEquals(programOf("/download/link-office/"), "link-office");
  const req = (h: Record<string, string>) => new Request(fn, { headers: h });
  assertEquals(countryOf(req({ "cf-ipcountry": "nz" }), "Pacific/Fiji"), "NZ");
  assertEquals(countryOf(req({ "cf-ipcountry": "XX" }), "Australia/Sydney"), "AU");
  assertEquals(countryOf(req({}), "Mars/Base"), null);
  assertEquals(referrerOf("/pricing.html", ""), "/pricing.html");
  assertEquals(referrerOf("", "https://www.google.com/search?q=riyeser"), "google.com");
  assertEquals(referrerOf("www.Facebook.com", ""), "facebook.com");
  assertEquals(referrerOf("riyeser.com", ""), null);
  assertEquals(referrerOf("", "https://riyeser.com/programs/pos.html?x=1"), "/programs/pos.html");
  assertEquals(referrerOf("", "https://riyeser.com/download/pos.html"), null);
  assertEquals(referrerOf("javascript:alert(1)", "not a url"), null);
});
