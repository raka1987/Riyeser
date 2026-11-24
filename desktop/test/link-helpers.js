// Shared set-up for the Riyeser Link tests: a throwaway data folder, made-up people, a phone system on a
// spare port on this PC, and simulated phones.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Store } = require('../src/core/store');
const { Directory } = require('../src/link/directory');
const { Pbx } = require('../src/link/pbx');
const { SimUA } = require('../src/link/simua');

const tmp = (name = 'link') => fs.mkdtempSync(path.join(os.tmpdir(), `riyeser-${name}-test-`));
const rmTmp = (dir) => { if (dir && dir.startsWith(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true }); };

/** A phone system with people 101 (Alex Sample), 102 (Bo Example), 103 (Cam Test) and a ring group 200 (Front desk: 102, 103). */
async function setup(pbxOpts = {}) {
  const dir = tmp();
  const store = new Store(dir);
  const directory = new Directory(store);
  directory.addPerson({ name: 'Alex Sample', ext: '101' });
  directory.addPerson({ name: 'Bo Example', ext: '102' });
  directory.addPerson({ name: 'Cam Test', ext: '103' });
  directory.addGroup({ name: 'Front desk', ext: '200', members: ['102', '103'] });
  const pbx = await new Pbx({ directory, host: '127.0.0.1', port: 0, bind: '127.0.0.1', tcp: false, multicast: false, ...pbxOpts }).start();
  const uas = [];
  const ua = async (ext, opts = {}) => {
    const u = await new SimUA({ ext, password: directory.password(ext), server: { host: '127.0.0.1', port: pbx.port }, ...opts }).start();
    uas.push(u);
    return u;
  };
  const close = async () => { for (const u of uas) await u.stop(); await pbx.stop(); rmTmp(dir); };
  return { dir, store, directory, pbx, ua, close };
}

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return true; await wait(20); }
  throw new Error('timed out waiting');
}

module.exports = { setup, tmp, rmTmp, get, wait, until };
