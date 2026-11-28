// Releases come from the public downloads repository (raka1987/riyeser-downloads), with the old code repository
// (raka1987/Riyeser) as a fallback while the downloads repository has no release yet (docs/GOING-PRIVATE.md on main).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const updates = require('../src/central/updates');

const NEW = 'https://api.github.com/repos/raka1987/riyeser-downloads/releases';
const OLD = 'https://api.github.com/repos/raka1987/Riyeser/releases';
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function world(map) {
  const asked = [];
  const get = async (url) => { asked.push(url); const a = map[url]; if (a instanceof Error) throw a; return a || answer(404, { message: 'Not Found' }); };
  return { asked, get };
}

test('downloads repository: the update addresses and the one name to change', () => {
  assert.strictEqual(updates.DOWNLOADS_REPO, 'raka1987/riyeser-downloads');
  assert.strictEqual(updates.RELEASE_API, `${NEW}/latest`);
  assert.strictEqual(updates.RELEASES_API, `${NEW}?per_page=15`);
  assert.deepStrictEqual(updates.releaseApis('stable'), [`${NEW}/latest`, `${OLD}/latest`]);
  assert.deepStrictEqual(updates.releaseApis('early'), [`${NEW}?per_page=15`, `${OLD}?per_page=15`]);
  for (const ok of ['https://github.com/raka1987/riyeser-downloads/releases/download/riyeser-1/RiyeserPDF-Setup.exe',
    'https://github.com/raka1987/Riyeser/releases/download/riyeser-1/RiyeserPDF-Setup.exe',
    'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc']) assert.ok(updates.ALLOWED_DOWNLOAD.test(ok), ok);
  for (const bad of ['https://github.com/raka1987/riyeser-downloads-evil/releases/download/x/a.exe', 'https://github.com/someone/Riyeser/releases/download/x/a.exe',
    'https://github.com/raka1987/riyeser-downloads/archive/main.zip', 'http://github.com/raka1987/riyeser-downloads/releases/download/x/a.exe']) assert.ok(!updates.ALLOWED_DOWNLOAD.test(bad), bad);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/central-main.js'), 'utf8'), /updates\.findRelease\(channel,/);
});

test('after the switch: the downloads repository\'s release, the old one never asked', async () => {
  const w = world({ [`${NEW}/latest`]: answer(200, { tag_name: 'riyeser-2', assets: [] }) });
  assert.strictEqual((await updates.findRelease('stable', w.get)).tag_name, 'riyeser-2');
  assert.deepStrictEqual(w.asked, [`${NEW}/latest`]);
});

test('before the switch: the downloads repository has no release (404 or an empty list), so the old code repository\'s', async () => {
  const w = world({ [`${OLD}/latest`]: answer(200, { tag_name: 'riyeser-1', assets: [] }) });
  assert.strictEqual((await updates.findRelease('stable', w.get)).tag_name, 'riyeser-1');
  assert.deepStrictEqual(w.asked, [`${NEW}/latest`, `${OLD}/latest`]);
  const e = world({ [`${NEW}?per_page=15`]: answer(200, []), [`${OLD}?per_page=15`]: answer(200, [{ tag_name: 'old-pre', prerelease: true, published_at: '2026-11-01' }]) });
  assert.strictEqual((await updates.findRelease('early', e.get)).tag_name, 'old-pre');
});

test('nothing published anywhere: null (Central says "No release published yet"); GitHub down: the error', async () => {
  assert.strictEqual(await updates.findRelease('stable', world({}).get), null);
  const down = world({ [`${NEW}/latest`]: answer(503, {}), [`${OLD}/latest`]: answer(404, {}) });
  await assert.rejects(updates.findRelease('stable', down.get), /Couldn't check for updates \(503\)/);
  const off = world({ [`${NEW}/latest`]: new Error('offline'), [`${OLD}/latest`]: new Error('offline') });
  await assert.rejects(updates.findRelease('stable', off.get), /offline/);
  // the downloads repository busy but the old one answers: still finds the update
  const busy = world({ [`${NEW}/latest`]: answer(502, {}), [`${OLD}/latest`]: answer(200, { tag_name: 'riyeser-1' }) });
  assert.strictEqual((await updates.findRelease('stable', busy.get)).tag_name, 'riyeser-1');
});
