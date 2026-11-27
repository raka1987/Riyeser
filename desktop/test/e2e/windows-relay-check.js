// The Riyeser relay installed as a Windows service (install-relay.ps1) on this PC, with two Link Office sites
// (the real Link Office phone engine, each in its own process) connecting to it over wss with the relay's
// self-signed certificate pinned, and simulated desk phones sending sound (RTP) both ways. Then the relay's
// Windows task is restarted and the sites must reconnect by themselves.
// Run (as administrator, after install-relay.ps1):  node test/e2e/windows-relay-check.js <evidence.json>
// Also works on Linux against a relay on 127.0.0.1 (RELAY_SECRET_FILE, RELAY_HTTPS_PORT; RELAY_RESTART=command).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const tokens = require('../../src/relay/lib/tokens');

const OUT = process.argv[2] || 'relay-check.json';
const SECRET_FILE = process.env.RELAY_SECRET_FILE || path.join(process.env.ProgramData || '/etc', process.platform === 'win32' ? 'Riyeser Relay' : 'riyeser-relay', 'secret');
const HTTPS = Number(process.env.RELAY_HTTPS_PORT || 443);
const WS = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const ev = { steps: [], ok: false };
const note = (s) => { ev.steps.push(s); console.log(s); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const health = () => new Promise((res) => { const r = http.get('http://127.0.0.1:8080/health', { timeout: 2000 }, (x) => { let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => r.destroy()); });
async function until(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(250); } throw new Error(`timed out: ${what}`); }

function site(name, office, port, phones, relay, pin, secret) {
  const pass = tokens.sign(tokens.keys(secret).office, { v: 1, r: relay, ws: WS, o: office, g: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
  const cfg = { name, ws: WS, office, host: '127.0.0.1', port, people: [['101', 'Alex Suva'], ['201', 'Ned Nadi']], phones,
    relays: [{ id: relay, url: `wss://127.0.0.1:${HTTPS}/link/v1`, host: 'relay.riyeser.com', region: 'Head office', pin }], tokens: { [relay]: pass }, timing: { pingEvery: 1000, deadAfter: 3500, failbackEvery: 5000 } };
  const child = spawn(process.execPath, [path.join(__dirname, 'site-proc.js'), JSON.stringify(cfg)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let seq = 0; let buf = ''; let readyFn; const ready = new Promise((r) => { readyFn = r; });
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.log) { if (/relay|Relay/.test(m.log)) console.log(`  [${name}] ${m.log}`); continue; } if (m.ready || (m.error && m.id == null)) { readyFn(m); continue; } const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
  child.stderr.on('data', (d) => console.log(`  [${name} stderr] ${String(d).trim()}`));
  return { ready, kill: () => child.kill(), ask: (cmd, extra = {}) => new Promise((res, rej) => { const id = ++seq; const t = setTimeout(() => rej(new Error(`${name}: no answer to ${cmd}`)), 20000); waiting.set(id, (m) => { clearTimeout(t); res(m); }); child.stdin.write(`${JSON.stringify({ id, cmd, ...extra })}\n`); }) };
}

(async () => {
  const sites = [];
  try {
    const h = await until(health, 30000, 'the relay\'s /health');
    note(`Relay service answering: ${JSON.stringify(h)}`);
    if (!h.cert_sha256) throw new Error('the relay reports no certificate');
    const secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    const suva = site('Suva', 'lo-suva-ci000001', 5070, [{ ext: '101', bind: '127.0.0.1' }], h.relay, h.cert_sha256, secret); sites.push(suva);
    const nadi = site('Nadi', 'lo-nadi-ci000002', 5072, [{ ext: '201', bind: '127.0.0.1' }], h.relay, h.cert_sha256, secret); sites.push(nadi);
    for (const s of sites) { const m = await s.ready; if (!m.ready) throw new Error(m.error); }
    const both = async () => { const a = (await suva.ask('status')).relay; const b = (await nadi.ask('status')).relay; return a.connected && b.connected && a.remote >= 1 && b.remote >= 1 ? [a, b] : null; };
    const [a] = await until(both, 30000, 'both sites connected over wss (pinned certificate)');
    note(`Suva: "${a.detail}"; UDP probe: ${a.udp}`);
    const c1 = await suva.ask('call', { from: '101', to: '201', ms: 2000 });
    const r1 = (await nadi.ask('rtp', { ext: '201' })).rtp;
    note(`Call Suva 101 -> Nadi 201: ${c1.status}; Suva received ${c1.rtp && c1.rtp.received} packets (from ${c1.rtp && c1.rtp.from}), Nadi received ${r1.received}`);
    if (c1.status !== 200 || !(c1.rtp.received > 40 && r1.received > 40)) throw new Error('no sound both ways on call 1');
    await suva.ask('hangup', { from: '101' });
    // restart the relay's Windows task (or the given command): the sites reconnect by themselves
    const before = (await suva.ask('status')).relay.reconnects;
    if (process.env.RELAY_RESTART) execSync(process.env.RELAY_RESTART, { stdio: 'inherit' });
    else if (process.platform === 'win32') execSync('powershell -NoProfile -Command "Stop-ScheduledTask -TaskName \'Riyeser Relay\'; Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -match \'relay\\\\\\\\server.js\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep 2; Start-ScheduledTask -TaskName \'Riyeser Relay\'"', { stdio: 'inherit' });
    const t0 = Date.now();
    await until(async () => { const s = (await suva.ask('status')).relay; return s.reconnects > before && (await both()); }, 60000, 'reconnect after the relay restarted');
    note(`Relay task restarted: both sites back in ${Date.now() - t0} ms`);
    const c2 = await nadi.ask('call', { from: '201', to: '101', ms: 1500 });
    const r2 = (await suva.ask('rtp', { ext: '101' })).rtp;
    note(`Call Nadi 201 -> Suva 101 after the restart: ${c2.status}; Nadi received ${c2.rtp && c2.rtp.received}, Suva received ${r2.received}`);
    if (c2.status !== 200 || !(c2.rtp.received > 30 && r2.received > 30)) throw new Error('no sound both ways after the restart');
    ev.ok = true;
  } catch (e) { note(`FAILED: ${e.message}`); }
  for (const s of sites) s.kill();
  fs.writeFileSync(OUT, JSON.stringify(ev, null, 2));
  process.exit(ev.ok ? 0 : 1);
})();
