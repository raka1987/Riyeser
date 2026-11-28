// Minifies the BUILT website output only (website/public). The source files stay readable.
//
// Why: when the code repository goes private (docs/GOING-PRIVATE.md), the built site is the one thing the public
// can read. Minifying strips the explanatory comments, developer notes and easy-to-read structure from the files
// that ship, so the published pages don't hand out the source. It never touches the source in website/.
//
// What it does, when terser and csso are installed (website/package.json devDependencies):
//   * .js  -> terser: drop comments, mangle local names, collapse. Top-level names are kept (pages load several
//            scripts that share globals), and already-minified vendor files (vendor/*, *.min.*) are left alone.
//   * .css -> csso: drop comments, collapse.
//   * .html-> strip HTML comments, and minify the inline <script> and <style> in each page.
//   * no source maps are produced.
// If terser/csso aren't installed (e.g. a quick local build with no npm install), it still strips HTML comments and
// skips the JS/CSS minify, so a build never fails for want of them. Install them with `npm ci` in website/.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let terser = null, csso = null, warned = false;
async function tools() {
  if (terser !== null || csso !== null) return;
  try { terser = (await import('terser')).minify; } catch { terser = false; }
  try { csso = (await import('csso')).minify; } catch { csso = false; }
  if ((!terser || !csso) && !warned) { warned = true; console.warn('minify: terser/csso not installed - stripping HTML comments only (run `npm ci` in website/ to minify JS/CSS).'); }
}

const isVendor = (file) => /(^|\/)vendor\//.test(file) || /\.min\.(?:js|css|mjs)$/.test(file);

export async function minifyJs(code, { toplevel = false } = {}) {
  await tools();
  if (!terser) return code;
  try { const r = await terser(code, { sourceMap: false, mangle: { toplevel }, compress: { toplevel }, format: { comments: false } }); return typeof r.code === 'string' ? r.code : code; }
  catch (e) { console.warn('minify: left a script as-is (' + (e && e.message) + ')'); return code; }
}

export async function minifyCss(code) {
  await tools();
  if (!csso) return code;
  try { return csso(code, { sourceMap: false }).css; } catch (e) { console.warn('minify: left a stylesheet as-is (' + (e && e.message) + ')'); return code; }
}

// Strip HTML comments (never inside a script/style/pre/textarea) and minify inline <script>/<style>.
export async function minifyHtml(html) {
  await tools();
  const kept = [];
  let out = '';
  const re = /<(script|style|pre|textarea)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let last = 0, m;
  while ((m = re.exec(html))) {
    out += html.slice(last, m.index);
    last = re.lastIndex;
    const [, tag, attrs, body] = m;
    let newBody = body;
    const t = tag.toLowerCase();
    if (t === 'script') {
      const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1];
      if (/\bsrc\s*=/.test(attrs)) { /* external: nothing to minify */ }
      else if (!type || /javascript|module|text\/babel/i.test(type)) newBody = await minifyJs(body, { toplevel: false });
      else if (/json/i.test(type)) { try { newBody = JSON.stringify(JSON.parse(body)); } catch { /* leave */ } }
    } else if (t === 'style') {
      newBody = await minifyCss(body);
    }
    const token = `\u0000K${kept.length}\u0000`;
    kept.push(`<${tag}${attrs}>${newBody}</${tag}>`);
    out += token;
  }
  out += html.slice(last);
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/\u0000K(\d+)\u0000/g, (_, i) => kept[+i]);
  return out;
}

// Walk a built directory and minify every .js, .css and .html in place (source trees are never passed here).
// `skip` is a Set of absolute paths to leave untouched (e.g. pages already minified with their CSP applied).
export async function minifyDir(dir, skip = new Set()) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { await minifyDir(p, skip); continue; }
    if (skip.has(p)) continue;
    const rel = p; // absolute within the built dir; isVendor matches on the path
    if (/\.css$/i.test(name) && !isVendor(rel)) writeFileSync(p, await minifyCss(readFileSync(p, 'utf8')));
    else if (/\.(?:js|mjs)$/i.test(name) && !isVendor(rel)) writeFileSync(p, await minifyJs(readFileSync(p, 'utf8'), { toplevel: false }));
    else if (/\.html?$/i.test(name)) writeFileSync(p, await minifyHtml(readFileSync(p, 'utf8')));
  }
}
