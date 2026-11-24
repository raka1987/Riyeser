// Builds ONE site for riyeser.com:
//   /        the Riyeser Group software website (website/build.mjs) - what people see when they open riyeser.com
//   /app/    the Riyeser Services app (website/services, copied from the old riyeser.com)
//   /team/   Riyeser Team, the team chat (website/team)
//   node website/build-combined.mjs        -> website/public
//
// The Services app's scripts, images and client share page (/share.html) stay at the top of the domain, so
// printed QR codes and shared links keep working. Only its pages (home, FAQ, help, terms) move into /app/.
// Old Services links (riyeser.com/?demo, riyeser.com/#/p/..., sign-in emails) are forwarded to /app/ by the home page.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

// 2. The Services app: everything except its pages at the top (scripts, images, share page), pages in /app/.
cpSync(SRC, OUT, { recursive: true, force: false, errorOnExist: false, filter: (src) => !APP_PAGES.includes(relative(SRC, src)) });
mkdirSync(join(OUT, 'app'), { recursive: true });

// 3. Riyeser Team (team chat) at /team/. Its database setup (team-chat.sql) stays in the repository only.
cpSync(join(ROOT, 'team'), join(OUT, 'team'), { recursive: true, filter: (src) => !src.endsWith('.sql') && !/[\/]team[\/]test([\/]|$)/.test(src) });

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

// 3. Links to the old /software/ address go to the same page at the top.
for (const f of websiteFiles.filter((f) => f.endsWith('.html') && f !== '404.html')) {
  const to = '/' + f.replace(/(^|\/)index\.html$/, '$1');
  mkdirSync(dirname(join(OUT, 'software', f)), { recursive: true });
  writeFileSync(join(OUT, 'software', f), `<!doctype html><meta charset="utf-8"><title>Moved — Riyeser</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${SITE}${to}"><script>location.replace(${JSON.stringify(to)}+location.search+location.hash)</script><p>Moved to <a href="${to}">${to}</a>.</p>`);
}

console.log('Combined site ready in', OUT, '(software website at /, Riyeser Services at /app/)');
