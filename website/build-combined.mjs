// Builds ONE site for riyeser.com:
//   /            Riyeser Services, exactly as it was on riyeser.com (website/services, copied from the live site)
//   /software/   the Riyeser Group website (website/build.mjs)
//   node website/build-combined.mjs        -> website/public
// The Services app expects to be at the top of the domain, so this layout is only for riyeser.com itself.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'public');
const base = (process.env.SITE_BASE || '/').replace(/\/?$/, '/');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'services'), OUT, { recursive: true });
execFileSync(process.execPath, [join(ROOT, 'build.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, OUT_DIR: join(OUT, 'software'), SITE_BASE: `${base}software/`, SITE_URL: 'https://riyeser.com/software', SERVICES_APP: 'https://riyeser.com' },
});
rmSync(join(OUT, 'software', '404.html'), { force: true });
writeFileSync(join(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: https://riyeser.com/software/sitemap.xml\n');
writeFileSync(join(OUT, 'CNAME'), 'riyeser.com\n');
console.log('Combined site ready in', OUT, '(Services at /, Riyeser Group website at /software/)');
