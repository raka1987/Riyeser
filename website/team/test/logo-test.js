// The Riyeser wordmark is drawn inline in Riyeser HQ, Riyeser Link (web), the booking page and Riyeser Central from the
// same paths as website/assets/logo-wordmark.svg, so it can't drift from the website's logo: this checks each copy
// still matches, and that the old "R + Riyeser" lockup isn't back. Run: `node website/team/test/logo-test.js`. Exits 1 on failure.
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const [sw, word] = [...read('website/assets/logo-wordmark.svg').matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
let failed = 0; const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
const copies = ['website/hq/hq.js', 'website/team/team.js', 'website/book/book.js', 'desktop/src/renderer/company.js', 'desktop/src/renderer/central.html', 'website/hq/hq-v2.js'];
for (const f of copies) {
  if (!fs.existsSync(path.join(root, f))) { check(false, `${f} exists`); continue; }
  const s = read(f);
  check(s.includes(sw) && s.includes(word), `${f}: the wordmark's swoosh and letters match logo-wordmark.svg`);
  check(!/<img src="[^"]*logo-r\.png" alt="">Riyeser/.test(s), `${f}: no old "R + Riyeser" brand lockup`);
}
// pages that show a program (Riyeser Central on the website) use that program's own icon, never the generic "R"
for (const f of ['website/build.mjs']) check(!/logo-r\.png" alt="">/.test(read(f)), `${f}: no "R" icon used as a brand lockup`);
check(/Powered by <a href="\$\{BASE\}">Riyeser<\/a>/.test(read('website/build.mjs')) && /logo-wordmark\.svg" alt="Riyeser"/.test(read('website/build.mjs')), 'the signing page: the wordmark, and "Powered by Riyeser"');
check(fs.existsSync(path.join(root, 'website/assets/logo-wordmark.png')), 'the email logo (assets/logo-wordmark.png) is there');
check(/logo-wordmark\.png" width="115" height="36" alt="Riyeser"/.test(read('website/team/team-chat.sql')), 'emails (email_html) show the wordmark, "Riyeser" if pictures are off');
// The site icon (favicon): "R." with the swoosh from the wordmark, in every head (website, booking, signing, Link, HQ).
{
  const svg = read('website/assets/favicon.svg'); const [, R, Rin] = word.match(/^(M[^M]*)(M[^M]*)/) || [];
  check(svg.includes(sw) && svg.includes(R + Rin) && svg.includes(word.slice(word.lastIndexOf('M'))), 'favicon.svg: the R, full stop and swoosh are the wordmark\'s own paths');
  check(/prefers-color-scheme:\s*dark/.test(svg), 'favicon.svg turns light in a dark browser');
  for (const f of ['favicon.ico', 'favicon-48.png', 'favicon-96.png', 'favicon-144.png', 'favicon-192.png', 'apple-touch-icon.png', 'icon-512.png']) check(fs.existsSync(path.join(root, 'website/assets', f)), `assets/${f} is there`);
  const b = read('website/build.mjs');
  check((b.match(/\$\{iconLinks\((up|BASE)\)\}/g) || []).length === 3 && /favicon\.svg/.test(b) && !/rel="(icon|apple-touch-icon)" href="[^"]*(favicon\.png|logo-r\.png)/.test(b), 'website, booking and signing pages use the new site icon');
  check(/assets\/icon-512\.png/.test(b.match(/const ORG = .*/)[0]), 'Google\'s logo (Organization) is the square icon on white');
  for (const f of ['website/team/index.html', 'website/hq/index.html']) check(/rel="icon"[^>]*favicon\.svg/.test(read(f)) && !/rel="icon"[^>]*logo-r\.png/.test(read(f)), `${f}: the new site icon`);
  check(!/logo-r\.png/.test(read('website/team/team.js')) && /'icon\.svg' : '\/assets\/favicon\.svg'/.test(read('website/team/team.js')), 'Riyeser Link: the site icon on account screens, Link\'s own icon in chat');
}
process.exit(failed ? 1 : 0);
