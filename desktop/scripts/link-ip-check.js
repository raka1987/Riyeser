// The Windows check for Riyeser Link Office 1.2.0's "the PC's address changed" handling, on a real network adapter.
// Run on a throwaway Windows machine as an administrator (the GitHub runner): `node scripts/link-ip-check.js <out.json>`.
//  1. Adds a test address (192.168.77.20/24) to a Microsoft loopback adapter installed for this check (the workflow
//     installs it: the runner's own adapter is never touched, because adding an address there turns its DHCP off and
//     cuts the machine off). The loopback adapter counts as virtual, so it's chosen the way an owner would (Settings →
//     Advanced → adapter), and the Link Office engine starts on it (spare SIP and settings ports; riyeser-office.local on
//     5353), with Windows' network-change events and a pretend Riyeser Link online that records the heartbeats.
//     A simulated Yealink desk phone registers.
//  2. Adds 192.168.77.35 and removes .20, like a router giving the PC a new address. Checks the engine moved to .35
//     by itself (and what noticed it), that SIP, the phone's settings and riyeser-office.local say .35, that the phone
//     was asked to restart and pick it up, and that the website heard at once with the change listed.
//  3. Adds a second address (.50): the phones must stay on .35.
//  4. Removes the test addresses again (always).
// Only 192.168.77.x addresses are offered to the engine, so the runner's own network never matters.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const http = require('http');
const { execFileSync } = require('child_process');
const { Store } = require('../src/core/store');
const { PhoneService } = require('../src/link/service');
const { LinkCloud } = require('../src/link/cloud');
const { SimUA } = require('../src/link/simua');
const sip = require('../src/link/sip');
const { parseMessage, queryMessage } = require('../src/link/mdns');
const win = require('../src/link/windows');

const out = process.argv[2] || path.join(os.tmpdir(), 'link-ip-check.json');
const A = '192.168.77.20'; const B = '192.168.77.35'; const C = '192.168.77.50';
const report = { ok: false, steps: [], started: new Date().toISOString() };
const step = (s) => { console.log(s); report.steps.push(s); };
// stdin closed (PowerShell can wait on an open one), and never more than a minute
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(100); } throw new Error(`timed out: ${what}`); }
const has = (ip) => Object.values(os.networkInterfaces()).flat().some((a) => a && a.address === ip);
const get = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b)); }).on('error', rej));
const mdnsAsk = (port) => new Promise((resolve, reject) => {
  const s = dgram.createSocket('udp4'); const t = setTimeout(() => { s.close(); reject(new Error('no mDNS answer')); }, 2000);
  s.on('message', (buf) => { clearTimeout(t); s.close(); resolve(parseMessage(buf)); });
  s.bind(0, '127.0.0.1', () => s.send(queryMessage('riyeser-office.local', { id: 7 }), port, '127.0.0.1'));
});

const finish = (code) => { report.finished = new Date().toISOString(); fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); process.exit(code); };
// a watchdog: whatever happens, write what was found and stop within 6 minutes
setTimeout(() => { report.error = report.error || `stopped after 6 minutes at: ${report.steps[report.steps.length - 1] || 'the start'}`; finish(1); }, 6 * 60000).unref();
(async () => {
  let alias = null; let svc = null; let cloud = null; let phone = null; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-ip-'));
  try {
    step('reading the adapters');
    const rows = await win.readNetConfig();
    report.adapters = rows.map((r) => ({ alias: r.alias, description: r.description, address: r.address, prefix: r.prefix, gateway: r.gateway, dhcp: r.dhcp }));
    alias = ps("(Get-NetAdapter | Where-Object InterfaceDescription -like '*Loopback*' | Select-Object -First 1).Name").trim();
    if (!alias) throw new Error('No loopback test adapter: the workflow installs one first');
    step(`test adapter: ${alias}; the runner's own: ${rows.filter((r) => r.gateway).map((r) => `${r.alias} ${r.address}`).join(', ')}`);
    const addIp = (ip) => ps(`New-NetIPAddress -InterfaceAlias '${alias}' -IPAddress ${ip} -PrefixLength 24 -SkipAsSource $true -PolicyStore ActiveStore | Out-Null`);
    const delIp = (ip) => { try { ps(`Remove-NetIPAddress -InterfaceAlias '${alias}' -IPAddress ${ip} -Confirm:$false -ErrorAction SilentlyContinue`); } catch { /* not there */ } };
    for (const ip of [A, B, C]) delIp(ip);
    addIp(A); await until(() => has(A), 20000, `${A} on the adapter`); step(`added ${A}`);

    // the engine on the real adapters, test addresses only
    const only = () => Object.fromEntries(Object.entries(os.networkInterfaces()).map(([n, l]) => [n, (l || []).filter((x) => x.internal || /^192\.168\.77\./.test(x.address))]));
    const store = new Store(dir);
    svc = new PhoneService({ store, appData: dir, sipPort: 0, httpPort: 0, tcp: false, multicast: false, licence: () => ({ active: true, state: 'paid' }), ifaces: only,
      mdns: { port: 5353 }, hostname: os.hostname(), netConfig: () => win.readNetConfig(), log: (l, t) => console.log(`  [${l}] ${t}`) });
    svc.addPerson({ name: 'Test Person', ext: '101' });
    svc.setSettings({ adapter: alias });   // the owner's choice (a loopback adapter is never picked automatically)
    await svc.start();
    step(`Link Office started on ${svc.host} (SIP ${svc.pbx.port}, settings ${svc.prov.httpPort}, riyeser-office.local ${svc.mdns ? `on ${svc.mdns.port}` : 'unavailable'})`);
    if (svc.host !== A) throw new Error(`expected ${A}, got ${svc.host}`);
    svc.assign('001565aabbcc', '101');
    const sent = [];
    const online = { session: { access_token: 'x' }, rpc: async (name, args) => { if (name === 'link_office_report') sent.push(args.payload); return name === 'link_office_report' ? { ok: true, pending: 0 } : []; } };
    fs.mkdirSync(path.join(dir, 'Riyeser'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Riyeser', 'company.json'), JSON.stringify({ name: 'Check', mode: 'online', workspace_id: 'ws-check' }));
    cloud = new LinkCloud({ service: svc, clients: () => [online], appData: dir, version: 'check', pcName: os.hostname() }).start();
    phone = await new SimUA({ ext: '101', password: svc.directory.password('101'), server: { host: '127.0.0.1', port: svc.pbx.port }, userAgent: 'Yealink SIP-T31P 124.86.0.40 00:15:65:aa:bb:cc' }).start();
    if ((await phone.register()).status !== 200) throw new Error('the simulated phone did not register');
    const notifies = []; phone.on('notify', (m) => notifies.push(sip.getHeader(m, 'event')));
    const w = svc.watch({ interval: 5000 });
    try { await until(() => w.events && w.events.ready, 30000, 'Windows network-change events'); step('Windows network-change events: listening'); }
    catch { step('Windows network-change events: not ready (polling only)'); }
    if (svc.mdns) report.mdnsBefore = await mdnsAsk(5353).then((m) => m.answers[0].address).catch((e) => e.message);

    // the router gives the PC a new address
    const changed = new Promise((r) => svc.once('address-changed', r));
    const t0 = Date.now();
    addIp(B); delIp(A); step(`added ${B}, removed ${A}`);
    const c = await Promise.race([changed, wait(45000).then(() => null)]);
    if (!c) throw new Error('Link Office did not notice the new address within 45 seconds');
    report.change = { from: c.from, to: c.to, source: c.source, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    step(`moved ${c.from} -> ${c.to}, noticed by ${c.source} after ${report.change.seconds} s`);
    if (c.to !== B) throw new Error(`moved to ${c.to}, not ${B}`);
    if (svc.pbx.host !== B) throw new Error('SIP still says the old address');
    const cfg = await get(`http://127.0.0.1:${svc.prov.httpPort}/yealink/001565aabbcc.cfg`);
    if (!cfg.includes(`sip_server.1.address = ${B}`)) throw new Error('the phone\'s settings still have the old address');
    step('SIP and the desk phone\'s settings: the new address');
    await until(() => notifies.length > 0, 5000, 'check-sync to the phone');
    report.notify = notifies[0]; step(`desk phone asked: Event ${notifies[0]}`);
    if (svc.mdns) {
      // Windows' own mDNS service shares port 5353, and a question sent straight to it may reach that one instead: try a few times
      let m = null; for (let i = 0; i < 5 && !m; i++) m = await mdnsAsk(5353).catch(() => null);
      report.mdnsAfter = m ? m.answers[0].address : 'no direct answer (Windows\' own mDNS service took the question)';
      if (m && m.answers[0].address !== B) throw new Error('riyeser-office.local still answers the old address');
      step(`riyeser-office.local: ${report.mdnsAfter}`);
    }
    await until(() => sent.some((p) => p.addresses[0] === B), 15000, 'the heartbeat with the new address');
    const p = sent.filter((x) => x.addresses[0] === B).pop();
    report.heartbeat = { addresses: p.addresses, address_changes: p.address_changes, mdns_name: p.mdns_name, router_name: p.router_name, phone_server: p.phone_server };
    if (!(p.address_changes[0] && p.address_changes[0].from === A && p.address_changes[0].to === B)) throw new Error('the heartbeat did not list the change');
    step(`website told: ${JSON.stringify(report.heartbeat)}`);
    report.status = { ipChanged: svc.status().ipChanged, names: svc.status().names, log: svc.logs.slice(-8).map((l) => l.text) };

    // a second address appears: the phones stay where they are
    addIp(C); await until(() => has(C), 20000, `${C} on the adapter`); await wait(9000);
    if (svc.host !== B) throw new Error(`a second address moved the phones to ${svc.host}`);
    step(`added a second address ${C}: still on ${B}`);
    report.ok = true;
  } catch (e) { report.error = e.message; console.error('FAILED:', e.message); }
  finally {
    try { if (phone) await phone.stop(); } catch { /* fine */ }
    try { if (cloud) cloud.stop(); if (svc) await svc.stop(); } catch { /* fine */ }
    if (alias) for (const ip of [A, B, C]) { try { ps(`Remove-NetIPAddress -InterfaceAlias '${alias}' -IPAddress ${ip} -Confirm:$false -ErrorAction SilentlyContinue`); } catch { /* not there */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    finish(report.ok ? 0 : 1);
  }
})();
