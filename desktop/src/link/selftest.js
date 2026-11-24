// The self-test run by `Riyeser Link Office.exe --self-test=<file>` (and the Windows build check): starts the SIP
// server and the desk-phone set-up server on spare ports on this PC only, registers two simulated phones, places a
// test call between them (ring, answer, hang up), and fetches a desk phone's settings. Uses a throwaway data folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Store } = require('../core/store');
const { Directory } = require('./directory');
const { Pbx } = require('./pbx');
const { Provisioner } = require('./provision');
const { SimUA } = require('./simua');

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

async function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-link-selftest-'));
  const out = { sip: false, provisioning: false, steps: [] };
  let pbx; let prov; const uas = [];
  try {
    const store = new Store(dir);
    const directory = new Directory(store);
    const a = directory.addPerson({ name: 'Test Person A', ext: '101' });
    directory.addPerson({ name: 'Test Person B', ext: '102' });
    pbx = await new Pbx({ directory, host: '127.0.0.1', port: 0, bind: '127.0.0.1', tcp: false, multicast: false }).start();
    out.steps.push(`sip on ${pbx.port}`);
    const A = await new SimUA({ ext: '101', password: directory.password('101'), server: { host: '127.0.0.1', port: pbx.port } }).start();
    const B = await new SimUA({ ext: '102', password: directory.password('102'), server: { host: '127.0.0.1', port: pbx.port } }).start();
    uas.push(A, B);
    const ra = await A.register(); const rb = await B.register();
    if (ra.status !== 200 || rb.status !== 200) throw new Error(`register ${ra.status}/${rb.status}`);
    out.steps.push('registered');
    const { call, final } = await A.dial('102');
    if (final.status !== 200 || !call.provisional.includes(180)) throw new Error(`call ${final.status}`);
    const acked = B.waitFor('ack');
    await acked;
    const bye = await A.bye(call);
    if (bye.status !== 200) throw new Error(`bye ${bye.status}`);
    out.steps.push('called');
    out.sip = true;

    prov = await new Provisioner({ store, directory, host: '127.0.0.1', sipPort: pbx.port, httpPort: 0, bind: '127.0.0.1' }).start();
    prov.assign('00:15:65:00:00:01', a.ext);
    const cfg = await get(`http://127.0.0.1:${prov.httpPort}/yealink/001565000001.cfg`);
    const refused = await get(`http://127.0.0.1:${prov.httpPort}/yealink/001565000002.cfg`);
    if (cfg.status !== 200 || !cfg.body.includes('account.1.user_name = 101') || refused.status !== 403) throw new Error(`provisioning ${cfg.status}/${refused.status}`);
    out.provisioning = true;
  } catch (e) {
    out.error = e.message;
  } finally {
    for (const u of uas) await u.stop();
    if (pbx) await pbx.stop();
    if (prov) await prov.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ }
  }
  return out;
}

module.exports = { selfTest };
