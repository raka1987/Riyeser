// Packaging-time minification of Riyeser Payroll's own JavaScript.
//
// Why: when the code repository goes private, the installer is still public and the app's .js is readable inside the
// asar. prepare.js assembles the app into build/app and then calls this to minify every .js it put there (the back
// office and the browser scripts in public/), so the shipped program carries no comments, notes or easy-to-read
// source. node_modules (added afterwards by `npm install`) are never touched, so nothing there can break.
//
// terser: drop comments, mangle local names only (top-level names kept so require()/module.exports keep lining up),
// no source maps. If terser isn't installed the files are left unchanged and a warning is printed, so a build never
// fails for want of it (terser is a devDependency, installed by `npm ci`/`npm install`).
//
// Usage: node minify-app.js <dir>   (minifies every .js under <dir>, skipping node_modules)

const fs = require('fs');
const path = require('path');

let terser = null;
try { terser = require('terser'); } catch { /* optional */ }

async function minifyFile(p) {
  if (!terser) return;
  const code = fs.readFileSync(p, 'utf8');
  try {
    const r = await terser.minify(code, { sourceMap: false, mangle: { toplevel: false }, compress: { toplevel: false }, format: { comments: false } });
    if (typeof r.code === 'string') fs.writeFileSync(p, r.code);
  } catch (e) { console.warn('minify-app: left', path.basename(p), 'as-is (' + (e && e.message) + ')'); }
}

async function minifyDir(dir) {
  if (!terser) { console.warn('minify-app: terser not installed - app JavaScript left unminified (run `npm install` so it is installed).'); return; }
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) await minifyDir(p);
    else if (/\.m?js$/.test(name)) await minifyFile(p);
  }
}

module.exports = { minifyDir };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: minify-app.js <dir>'); process.exit(2); }
  minifyDir(dir).then(() => console.log('minify-app: done', dir, terser ? '(minified)' : '(terser missing)')).catch((e) => { console.error(e); process.exit(1); });
}
