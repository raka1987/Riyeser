// Packaging-time minification of the Riyeser desktop apps' own JavaScript.
//
// Why: when the code repository goes private (docs/GOING-PRIVATE.md on main), the installers are still public. The
// app's own .js is readable inside the asar, so minifying it before packaging strips the comments, developer notes
// and easy-to-read structure from what ships. It never touches the source tree in desktop/src.
//
// How it's used: package-win.js mirrors desktop/src into build/app-min/src, minified, before the per-app build.
// builder.config.js then packs that mirror instead of src/ (falling back to src/ when the mirror isn't there, so a
// plain `electron-builder` and running from source are unaffected). Only OUR files are minified - node_modules are
// copied by electron-builder as usual, so nothing there can break.
//
//   * .js  -> terser: drop comments, mangle local names (top-level names kept so require()/module.exports still line
//            up across files), collapse. No source maps.
//   * .mjs -> terser in module mode.
//   * other files (.html, .css, .json, images, the relay deploy scripts, .node, .wasm) are copied unchanged - they're
//     needed as-is at runtime. The update/download code keeps its api.github.com URLs (it points at the public
//     downloads repository).
// If terser isn't installed, files are copied unchanged and a warning is printed, so a build never fails for want of
// it (terser is a devDependency, installed by `npm ci` in CI).

const fs = require('fs');
const path = require('path');

let terser = null;
try { terser = require('terser'); } catch { /* optional: copied unchanged below */ }

// Left out of the packaged app entirely (not needed at runtime, and nothing that hints at the source or the repo).
// Tests and docs already sit outside src/, so they never reach here; these are the few such files under src/.
const SKIP = [/(^|\/)README\.md$/i, /\.md$/i, /(^|\/)\.DS_Store$/, /\.map$/, /(^|[/.])test\.js$/i, /(^|\/)__tests__\//];
const skip = (rel) => SKIP.some((re) => re.test(rel));

async function minifyCode(code, isModule) {
  if (!terser) return code;
  try {
    const r = await terser.minify(code, { sourceMap: false, module: isModule, mangle: { toplevel: false }, compress: { toplevel: false }, format: { comments: false } });
    return typeof r.code === 'string' ? r.code : code;
  } catch (e) { console.warn('minify-app: left a file as-is (' + (e && e.message) + ')'); return code; }
}

/** Mirror srcDir to outDir, minifying our .js/.mjs, copying everything else, leaving out SKIP files. */
async function minifyTree(srcDir, outDir) {
  if (!terser) console.warn('minify-app: terser not installed - the app JavaScript will be copied unminified (run `npm ci` so it is installed).');
  fs.rmSync(outDir, { recursive: true, force: true });
  await walk(srcDir, outDir, srcDir);
  return outDir;
}

async function walk(dir, out, root) {
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(root, p).split(path.sep).join('/');
    const st = fs.statSync(p);
    if (st.isDirectory()) { await walk(p, path.join(out, name), root); continue; }
    if (skip(rel)) continue;
    const dest = path.join(out, name);
    if (/\.m?js$/.test(name)) fs.writeFileSync(dest, await minifyCode(fs.readFileSync(p, 'utf8'), name.endsWith('.mjs')));
    else fs.copyFileSync(p, dest);
  }
}

module.exports = { minifyTree, minifyCode };

// CLI: `node scripts/minify-app.js <srcDir> <outDir>` - used by package-win.js as a synchronous subprocess step.
if (require.main === module) {
  const [srcDir, outDir] = process.argv.slice(2);
  if (!srcDir || !outDir) { console.error('usage: minify-app.js <srcDir> <outDir>'); process.exit(2); }
  minifyTree(srcDir, outDir).then(() => console.log('minify-app: wrote', outDir, terser ? '(minified)' : '(copied, terser missing)')).catch((e) => { console.error(e); process.exit(1); });
}
