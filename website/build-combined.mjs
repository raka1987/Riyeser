// Builds ONE site for riyeser.com:
//   /        the Riyeser Group software website (website/build.mjs) - what people see when they open riyeser.com
//   /app/    the Riyeser Services app (website/services, copied from the old riyeser.com)
//   /link/   Riyeser Link, the chat (website/team; it was called Riyeser Team)
//   /team/   the same app again at its old address, so older desktop apps, invite links and sign-up emails keep working
//   node website/build-combined.mjs        -> website/public
//
// The Services app's scripts, images and client share page (/share.html) stay at the top of the domain, so
// printed QR codes and shared links keep working. Only its pages (home, FAQ, help, terms) move into /app/.
// Old Services links (riyeser.com/?demo, riyeser.com/#/p/..., sign-in emails) are forwarded to /app/ by the home page.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'public');
const SRC = join(ROOT, 'services');
const SITE = (process.env.SITE_URL || 'https://riyeser.com').replace(/\/$/, '');
const APP_PAGES = ['index.html', 'faq.html', 'help.html', 'terms.html'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. The software website at the top of the domain.
execFileSync(process.execPath, [join(ROOT, 'build.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, OUT_DIR: OUT, SITE_BASE: '/', SITE_URL: SITE, SERVICES_APP: `${SITE}/app` },
});
const websiteFiles = [];
(function walk(dir) { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else websiteFiles.push(relative(OUT, p)); } })(OUT);

// Riyeser HQ (staff back office) at /hq/: not linked from the site, not indexed, staff sign-in only.
cpSync(join(ROOT, 'hq'), join(OUT, 'hq'), { recursive: true, filter: (src) => !basename(src).startsWith('test-') });
// 3. Riyeser Link (the chat, formerly Riyeser Team) at /link/, and the very same files at its old address /team/:
// the Riyeser Team desktop app 1.0 and Centrals before 1.8 open /team/ and only allow /team/ in their windows, invite
// links and Supabase sign-up emails point there, and older Centrals read /team/config.js. So /team/ is a full copy,
// not a redirect; it only says (for search engines) that /link/ is the main address.
// Its database setup (team-chat.sql) stays in the repository only.
for (const dir of ['link', 'team']) {
  cpSync(join(ROOT, 'team'), join(OUT, dir), { recursive: true, filter: (src) => !src.endsWith('.sql') && !/[\/]team[\/]test([\/]|$)/.test(src) });
}
{
  const f = join(OUT, 'team', 'index.html');
  writeFileSync(f, readFileSync(f, 'utf8').replace('</title>', `</title>\n<link rel="canonical" href="${SITE}/link/">`));
}
// The Link app is a sign-in and an app, not a page for search results: keep both copies out of search engines
// (the program page riyeser.com/programs/link.html is the one to find).
for (const dir of ['link', 'team']) {
  const f = join(OUT, dir, 'index.html');
  const html = readFileSync(f, 'utf8');
  if (!/name="robots"/.test(html)) writeFileSync(f, html.replace('</title>', '</title>\n<meta name="robots" content="noindex">'));
}
// Cloudflare keeps files for hours, so give the Link and HQ scripts and styles a version stamp that changes with them.
{
  const { createHash } = await import('node:crypto');
  const stamp = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8);
  for (const page of ['link/index.html', 'team/index.html', 'hq/index.html']) {
    const f = join(OUT, page); const dir = dirname(f);
    writeFileSync(f, readFileSync(f, 'utf8').replace(/(src|href)="([^":?#]+\.(?:js|css))"/g, (m, attr, url) => `${attr}="${url}?v=${stamp(join(dir, url))}"`));
  }
}

// As Built (the Services app) is only built in when ASBUILT_WEB=1, e.g. for the As Built Windows installer.
const ASBUILT = process.env.ASBUILT_WEB === '1';
if (ASBUILT) {
// 2. The Services app: everything except its pages at the top (scripts, images, share page), pages in /app/.
cpSync(SRC, OUT, { recursive: true, force: false, errorOnExist: false, filter: (src) => !APP_PAGES.includes(relative(SRC, src)) });
mkdirSync(join(OUT, 'app'), { recursive: true });

/** Replace text; stop the build if an expected piece isn't there (the app changed and needs a look). */
function swap(text, file, pairs) {
  for (const [from, to, required = true] of pairs) {
    if (!text.includes(from)) { if (required) throw new Error(`${file}: expected to find ${from}`); continue; }
    text = text.split(from).join(to);
  }
  return text;
}
const linkPairs = [
  ['href="/"', 'href="/app/"', false],
  ['href="/software/"', 'href="/"', false],
  ['href="/?', 'href="/app/?', false],
  ['href="/faq.html', 'href="/app/faq.html', false],
  ['href="/help.html', 'href="/app/help.html', false],
  ['href="/terms.html', 'href="/app/terms.html', false],
];
for (const page of APP_PAGES) {
  writeFileSync(join(OUT, 'app', page), swap(readFileSync(join(SRC, page), 'utf8'), page, linkPairs));
}
writeFileSync(join(OUT, 'app.js'), swap(readFileSync(join(SRC, 'app.js'), 'utf8'), 'app.js', [
  ...linkPairs,
  ['getAttribute("href")||"/"', 'getAttribute("href")||"/app/"'],
  ['replaceState(null,"","/")', 'replaceState(null,"","/app/")'],
  ['replaceState(null,"","/#/")', 'replaceState(null,"","/app/#/")'],
]));
writeFileSync(join(OUT, 'data.js'), swap(readFileSync(join(SRC, 'data.js'), 'utf8'), 'data.js', [['location.href="/"', 'location.href="/app/"']]));
writeFileSync(join(OUT, 'manifest.webmanifest'), swap(readFileSync(join(SRC, 'manifest.webmanifest'), 'utf8'), 'manifest', [['"start_url":"/"', '"start_url":"/app/"']]));
// Offline support: the app's pages now live in /app/; leave the website's pages to the browser.
writeFileSync(join(OUT, 'sw.js'), swap(readFileSync(join(SRC, 'sw.js'), 'utf8'), 'sw.js', [
  ['VERSION="riyeser-153"', 'VERSION="riyeser-154"'],
  ['SHELL=["/","/index.html",', 'SHELL=["/app/",'],
  ['const n=e.request.mode==="navigate"?"/index.html":e.request;', 'if(e.request.mode==="navigate"&&!t.pathname.startsWith("/app/"))return;const n=e.request.mode==="navigate"?"/app/":e.request;'],
]));

} else {
  // As Built is off the website for now. Anyone whose browser kept the old As Built app (an offline copy) gets it
  // cleared on their next visit, so riyeser.com shows the current website.
  writeFileSync(join(OUT, 'sw.js'), "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys())await caches.delete(k);await self.registration.unregister();for(const c of await self.clients.matchAll({type:'window'}))c.navigate(c.url)})()));\n");
}

// 3. Links to the old /software/ address go to the same page at the top.
for (const f of websiteFiles.filter((f) => f.endsWith('.html') && f !== '404.html')) {
  const to = '/' + f.replace(/(^|\/)index\.html$/, '$1');
  mkdirSync(dirname(join(OUT, 'software', f)), { recursive: true });
  writeFileSync(join(OUT, 'software', f), `<!doctype html><meta charset="utf-8"><title>Moved — Riyeser</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${SITE}${to}"><script>location.replace(${JSON.stringify(to)}+location.search+location.hash)</script><p>Moved to <a href="${to}">${to}</a>.</p>`);
}

console.log('Combined site ready in', OUT, ASBUILT ? '(software website at /, As Built at /app/)' : '(software website at /; As Built left out)');
