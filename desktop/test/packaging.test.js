// The packaging (minify) step runs and produces a working app tree. This is the CI check that the packing step is
// sound; the Windows workflow separately installs and launches the packed, minified installers (--self-test).
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let terser = true;
try { require.resolve('terser'); } catch { terser = false; }

test('minify-app mirrors src, keeps it valid, drops docs/tests, keeps the update endpoint', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-pack-'));
  try {
    const { minifyTree } = require('../scripts/minify-app.js');
    await minifyTree(SRC, out);

    // Every source .js/.mjs is present and still parses.
    const list = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? list(path.join(dir, d.name)) : [path.join(dir, d.name)]);
    const srcJs = list(SRC).filter((f) => /\.m?js$/.test(f) && !/(^|[/.])test\.js$/.test(f)).map((f) => path.relative(SRC, f));
    const outJs = list(out).filter((f) => /\.m?js$/.test(f)).map((f) => path.relative(out, f));
    assert.deepStrictEqual(outJs.sort(), srcJs.sort(), 'every source script is mirrored');
    for (const rel of outJs) execFileSync(process.execPath, ['--check', path.join(out, rel)]); // throws on a syntax error

    // Nothing that reveals the source or clutters the app: no markdown, no test files, no source maps.
    const all = list(out).map((f) => path.relative(out, f));
    assert.ok(!all.some((f) => /\.md$/i.test(f)), 'no .md files in the packaged tree');
    assert.ok(!all.some((f) => /(^|[/.])test\.js$/i.test(f)), 'no test files in the packaged tree');
    assert.ok(!all.some((f) => /\.map$/i.test(f)), 'no source maps in the packaged tree');

    // The entry points are there and the update code keeps the GitHub API (it points at the public downloads repo).
    assert.ok(fs.existsSync(path.join(out, 'main.js')) && fs.existsSync(path.join(out, 'central-main.js')), 'main entry points present');
    assert.match(fs.readFileSync(path.join(out, 'central', 'updates.js'), 'utf8'), /api\.github\.com/, 'Central update check keeps its API URL');

    if (terser) {
      // With terser installed the output is actually minified: comments are gone.
      const before = fs.readFileSync(path.join(SRC, 'central', 'updates.js'), 'utf8');
      const after = fs.readFileSync(path.join(out, 'central', 'updates.js'), 'utf8');
      assert.ok(after.length < before.length, 'updates.js is smaller after minify');
      assert.ok(!/\/\/ /.test(after.split('\n')[0]), 'leading comment stripped');
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
