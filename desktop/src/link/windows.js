// The two Windows things Riyeser Link Office looks at: sleep settings (read only, never changed) and its own firewall rule.
// The firewall rule is the only system change Riyeser Link Office ever makes. The installer adds it (the installer is
// per-machine, so Windows asks once for permission); if it's missing later, the status screen offers a button that
// adds the same rule, which asks Windows for permission again. Uninstalling removes it.
const { execFile } = require('child_process');

const RULE = 'Riyeser Link Office';
const OFFICE = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16';
/** The netsh commands that add the rule for this program only (UDP 5060 and 5353 for riyeser-office.local; TCP 5060 and the phone set-up port). */
function firewallCommands(exe, httpPort = 5080) {
  const common = `dir=in action=allow program="${exe}" enable=yes profile=any remoteip=${OFFICE}`;
  return [
    `netsh advfirewall firewall delete rule name="${RULE}"`,
    `netsh advfirewall firewall add rule name="${RULE}" ${common} protocol=UDP localport=5060,5353 description="Desk phones on the office network (SIP, and finding this PC by name)"`,
    `netsh advfirewall firewall add rule name="${RULE}" ${common} protocol=TCP localport=5060,${httpPort} description="Desk phones on the office network (SIP and phone set-up)"`,
  ];
}
// stdin is closed straight away: PowerShell can otherwise sit waiting for input that never comes
const run = (cmd, args) => new Promise((resolve) => {
  const child = execFile(cmd, args, { windowsHide: true, timeout: 20000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  try { child.stdin.end(); } catch { /* no stdin */ }
});

/** true / false, 'outdated' (from before 1.2.0: no UDP 5353 for finding this PC by name), or null when it can't be told (not Windows). */
async function firewallRuleExists() {
  if (process.platform !== 'win32') return null;
  const r = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE}`]);
  return ruleState(r.ok, r.out);
}
const ruleState = (ok, out) => (!ok || !/Riyeser Link Office/i.test(out) ? false : /5353/.test(out) ? true : 'outdated');
/** Add the rule with Windows' permission prompt (UAC). Resolves when the prompt is answered. */
async function addFirewallRule(exe, httpPort) {
  if (process.platform !== 'win32') return false;
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-link-'));
  const file = path.join(dir, 'firewall.cmd');
  fs.writeFileSync(file, `@echo off\r\n${firewallCommands(exe, httpPort).join('\r\n')}\r\n`);
  try {
    const ps = `Start-Process -FilePath '${file.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ } }
  return firewallRuleExists();
}

/** Minutes from "Current AC Power Setting Index: 0x00000708" lines (seconds in hex). */
function parsePowercfg(text) {
  const pick = (k) => { const m = new RegExp(`Current ${k} Power Setting Index:\\s*0x([0-9a-f]+)`, 'i').exec(String(text || '')); return m ? Math.round(parseInt(m[1], 16) / 60) : null; };
  return { ac: pick('AC'), dc: pick('DC') };
}
/** Plain-English warning when Windows could still put this PC to sleep, or null. Reads the settings only. */
function sleepWarning({ sleep, hibernate }) {
  const after = [sleep && sleep.ac, hibernate && hibernate.ac].filter((n) => n > 0);
  if (!after.length) return null;
  const mins = Math.min(...after);
  const when = mins >= 60 && mins % 60 === 0 ? `${mins / 60} hour${mins === 60 ? '' : 's'}` : `${mins} minutes`;
  return `Windows is set to put this PC to sleep after ${when}. Riyeser Link Office asks Windows to stay awake while it runs, but a sleep button, closing a laptop's lid or a power cut will still stop the phones. To be safe, open Settings > System > Power, and set sleep to "Never" when plugged in.`;
}
async function readSleep() {
  if (process.platform !== 'win32') return { sleep: null, hibernate: null };
  const q = (setting) => run('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', setting]).then((r) => (r.ok ? parsePowercfg(r.out) : null));
  return { sleep: await q('STANDBYIDLE'), hibernate: await q('HIBERNATEIDLE') };
}

// ---------- this PC's network adapters (read only), and the optional fixed address ----------
// One PowerShell call: each connected adapter with its IPv4 address, prefix, router (default gateway), DNS servers,
// the network's DNS suffix, whether the address came from DHCP, the adapter's description and MAC.
const PS_NETCONFIG = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$out = foreach ($c in Get-NetIPConfiguration) {',
  '  $a = Get-NetAdapter -InterfaceIndex $c.InterfaceIndex; $i = Get-NetIPInterface -InterfaceIndex $c.InterfaceIndex -AddressFamily IPv4',
  '  $d = Get-DnsClient -InterfaceIndex $c.InterfaceIndex',
  '  foreach ($ip in @($c.IPv4Address)) { if ($ip) { [pscustomobject]@{ alias = $c.InterfaceAlias; description = $c.InterfaceDescription; address = $ip.IPAddress; prefix = $ip.PrefixLength;',
  '    gateway = @($c.IPv4DefaultGateway | ForEach-Object { $_.NextHop })[0]; dns = @($c.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses }) ;',
  '    dhcp = ($i.Dhcp -eq "Enabled"); origin = [string]$ip.PrefixOrigin; suffix = $d.ConnectionSpecificSuffix; mac = $a.MacAddress; status = [string]$a.Status } } }',
  '}',
  'ConvertTo-Json -Compress -Depth 3 @($out)',
].join('\n');
/** Windows' adapter list (PowerShell JSON) -> [{ alias, description, address, prefix, netmask, gateway, dns, dhcp, suffix, mac }] */
function parseNetConfig(json) {
  let list; try { list = JSON.parse(String(json || '').trim() || '[]'); } catch { return []; }
  if (!Array.isArray(list)) list = [list];
  const ip4 = (x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(x || ''));
  return list.filter((x) => x && ip4(x.address)).map((x) => ({ alias: String(x.alias || ''), description: String(x.description || ''), address: x.address, prefix: Number(x.prefix) || 24,
    netmask: prefixToMask(Number(x.prefix) || 24), gateway: ip4(x.gateway) ? x.gateway : '', dns: [].concat(x.dns || []).filter(ip4), dhcp: x.dhcp === true || /dhcp/i.test(String(x.origin || '')),
    suffix: String(x.suffix || ''), mac: String(x.mac || '').replace(/-/g, ':').toUpperCase() }));
}
const prefixToMask = (n) => { const m = n <= 0 ? 0 : (0xffffffff << (32 - Math.min(32, n))) >>> 0; return [24, 16, 8, 0].map((s) => (m >>> s) & 255).join('.'); };
async function readNetConfig() {
  if (process.platform !== 'win32') return [];
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_NETCONFIG]);
  return r.ok ? parseNetConfig(r.out) : [];
}

/**
 * "Use a fixed address" (optional, only when the owner chooses it): a PowerShell script, run once with Windows'
 * permission prompt, that gives one adapter a fixed IPv4 address (with the router and DNS servers it has now), then
 * checks it can still reach the router. If it can't within ~20 seconds, it puts the adapter back on automatic (DHCP)
 * by itself. It writes what happened to resultFile. Undo: dhcpScript(). A DHCP reservation in the router is better;
 * this is for when the router can't do one.
 * c: { alias, address, prefix, gateway, dns: [] }
 */
function fixedAddressScript(c, resultFile) {
  const ip4 = (x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(x || ''));
  if (!c || !c.alias || /["'`$\r\n]/.test(c.alias) || !ip4(c.address) || !ip4(c.gateway) || !(c.prefix >= 8 && c.prefix <= 30)) throw new Error('This adapter can\'t be given a fixed address (it needs an address and a router).');
  const dns = (c.dns || []).filter(ip4).slice(0, 2);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const mask = prefixToMask(c.prefix);
  return [
    "$ErrorActionPreference = 'Continue'",
    `$alias = ${q(c.alias)}; $result = ${q(resultFile)}`,
    'function Say($o) { $o | ConvertTo-Json -Compress | Set-Content -Path $result -Encoding UTF8 }',
    // somebody else already answering on that address (other than this PC)? Then don't take it.
    `$mine = @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $alias -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress })`,
    `if ($mine -notcontains ${q(c.address)} -and (Test-Connection -ComputerName ${q(c.address)} -Count 1 -Quiet)) { Say @{ ok = $false; why = 'in-use' }; exit 2 }`,
    `netsh interface ipv4 set address name="$alias" source=static address=${c.address} mask=${mask} gateway=${c.gateway} gwmetric=1`,
    dns.length ? `netsh interface ipv4 set dnsservers name="$alias" source=static address=${dns[0]} register=primary validate=no` : '',
    dns[1] ? `netsh interface ipv4 add dnsservers name="$alias" address=${dns[1]} index=2 validate=no` : '',
    '$ok = $false; for ($i = 0; $i -lt 10 -and -not $ok; $i++) { Start-Sleep -Seconds 2; $ok = Test-Connection -ComputerName ' + q(c.gateway) + ' -Count 1 -Quiet }',
    'if (-not $ok) {',
    '  netsh interface ipv4 set address name="$alias" source=dhcp',
    '  netsh interface ipv4 set dnsservers name="$alias" source=dhcp',
    "  Say @{ ok = $false; why = 'no-router'; rolledBack = $true }; exit 3",
    '}',
    `Say @{ ok = $true; address = ${q(c.address)} }`,
  ].filter(Boolean).join('\r\n');
}
/** Back to automatic (DHCP) for that adapter: the undo for fixedAddressScript. */
function dhcpScript(alias, resultFile) {
  if (!alias || /["'`$\r\n]/.test(alias)) throw new Error('Unknown adapter.');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return [`$alias = ${q(alias)}`, 'netsh interface ipv4 set address name="$alias" source=dhcp', 'netsh interface ipv4 set dnsservers name="$alias" source=dhcp',
    `@{ ok = $true } | ConvertTo-Json -Compress | Set-Content -Path ${q(resultFile)} -Encoding UTF8`].join('\r\n');
}
/** Run a PowerShell script with Windows' permission prompt. -> its result file's JSON, or { ok: false, why: 'cancelled' }. */
async function runElevatedScript(makeScript) {
  if (process.platform !== 'win32') throw new Error('Only on Windows.');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-link-'));
  const file = path.join(dir, 'address.ps1'); const result = path.join(dir, 'result.json');
  fs.writeFileSync(file, makeScript(result));
  try {
    const ps = `Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${file.replace(/'/g, "''")}"' -Verb RunAs -WindowStyle Hidden -Wait`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    try { return JSON.parse(fs.readFileSync(result, 'utf8').replace(/^﻿/, '')); } catch { return { ok: false, why: 'cancelled' }; }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ } }
}

/**
 * Run the Riyeser relay on this PC (the head office's main relay), with the relay's own Windows installer
 * (src/relay/deploy/windows/install-relay.ps1, unpacked from the app): a background task at boot, firewall rules,
 * router port forwarding where the router allows it, and Node from this app (ELECTRON_RUN_AS_NODE).
 */
// ddnsPasswordFile: a file (in this run's own temp folder) holding the Namecheap Dynamic DNS password; the installer
// reads it into relay.env and deletes it. The password itself is never in the script, a command line or a log.
// 1.3.1: secretFile: the relay's own key from a set-up code (made on the website), in the same kind of file. noDns: no
// web name (the default): sites use the address the relay reports. ddns: { provider: 'namecheap' | 'cloudflare', file }
// (Advanced: your own web name). The installer's last line is RESULT {json}.
function relayHostScript({ script, relayDir, domain, region, id, ddnsPasswordFile, secretFile, noDns, ddns, priority }, resultFile) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  if (!/^[A-Za-z0-9.-]{3,253}$/.test(domain || '') || !/^[a-z0-9-]{2,40}$/.test(id || '') || /[\r\n"`$]/.test(region || '')) throw new Error('Check the relay\'s name, id and region.');
  const d = ddns || (ddnsPasswordFile ? { provider: 'namecheap', file: ddnsPasswordFile } : null);
  if (d && !['namecheap', 'cloudflare'].includes(d.provider)) throw new Error('Choose Cloudflare or Namecheap for the web name.');
  const zone = d && d.provider === 'cloudflare' ? domain.split('.').slice(-2).join('.') : '';
  const dd = !d ? '' : d.provider === 'namecheap' ? ` -DdnsProvider namecheap -DdnsPasswordFile ${q(d.file)}` : ` -DdnsProvider cloudflare -DdnsZone ${q(zone)} -DdnsTokenFile ${q(d.file)}`;
  const extra = `${secretFile ? ` -RelayKeyFile ${q(secretFile)}` : ''}${noDns ? ' -NoDns' : ''}${priority ? ` -Priority ${Number(priority) | 0}` : ''}`;
  return [`$out = & ${q(script)} -LinkOffice -RelayDir ${q(relayDir)} -Domain ${q(domain)} -Region ${q(region)} -Id ${q(id)}${dd}${extra} *>&1 | Out-String`,
    `@{ ok = ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq $null); out = $out } | ConvertTo-Json -Compress | Set-Content -Path ${q(resultFile)} -Encoding UTF8`].join('\r\n');
}
/**
 * 1.3.1: Stop using this PC as the relay. The relay's own uninstaller (install-relay.ps1 -Uninstall), run once with
 * Windows' permission prompt: out of Riyeser (signed with its own key; keep: when another PC has taken over already),
 * the task stopped and removed, the router port forwarding it made and its firewall rules removed, the logs zipped
 * for support, and C:\ProgramData\Riyeser Relay (its key and settings) deleted. -> the script's text.
 */
function relayUninstallScript({ script, relayDir, keepRegistration = false }, resultFile) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  if (!script || !relayDir) throw new Error('The relay\'s uninstaller is missing.');
  return [`$out = & ${q(script)} -Uninstall -RelayDir ${q(relayDir)}${keepRegistration ? ' -KeepRegistration' : ''} *>&1 | Out-String`,
    "$r = $null; $m = [regex]::Match($out, 'RESULT (\\{.*\\})'); if ($m.Success) { try { $r = $m.Groups[1].Value | ConvertFrom-Json } catch { } }",
    `@{ ok = ($LASTEXITCODE -eq 0); out = $out; result = $r } | ConvertTo-Json -Compress -Depth 5 | Set-Content -Path ${q(resultFile)} -Encoding UTF8`].join('\r\n');
}
/** What the uninstaller's output says it did -> { ok, left, removedMappings, taskRemoved, firewallRemoved, logsZip, settingsRemoved } */
function parseUninstall(r) {
  const x = (r && r.result) || {}; const left = x.left || {};
  return { ok: !!(r && r.ok), left: !!left.left, gone: !!left.gone, leftWhy: left.why || null, switchedOff: (left.switched_off || []).length,
    removedMappings: (x.port_mappings && x.port_mappings.removed) || 0, taskRemoved: !!x.task_removed, firewallRemoved: !!x.firewall_removed,
    logsZip: x.logs_zip || null, settingsRemoved: !!x.settings_removed };
}
/** "Keep this PC awake" (the relay PC): never sleep or hibernate while plugged in. Run with Windows' permission prompt. */
function keepAwakeScript(resultFile) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return ['powercfg /change standby-timeout-ac 0', 'powercfg /change hibernate-timeout-ac 0',
    `@{ ok = $true } | ConvertTo-Json -Compress | Set-Content -Path ${q(resultFile)} -Encoding UTF8`].join('\r\n');
}
/** Can this PC be the relay? { windows, admin, diskFreeGb, onBattery } — read only. */
async function relayPcFacts({ powerMonitor } = {}) {
  const os = require('os'); const fs = require('fs');
  const rel = String(os.release()).split('.').map(Number);
  let admin = null; let disk = null;
  if (process.platform === 'win32') {
    const g = await run('whoami', ['/groups']); admin = g.ok ? /S-1-5-32-544/.test(g.out) : null;
    try { const st = fs.statfsSync(process.env.ProgramData || 'C:\\ProgramData'); disk = Math.round((st.bavail * st.bsize) / 1e8) / 10; } catch { disk = null; }
  }
  return { windows: process.platform === 'win32' ? (rel[0] >= 10 ? 'ok' : 'old') : 'not-windows', release: os.release(), admin, diskFreeGb: disk,
    onBattery: powerMonitor && powerMonitor.isOnBatteryPower ? powerMonitor.isOnBatteryPower() : null };
}
/** The relay's own checks on this PC (http://127.0.0.1:8080/check, this PC only). method GET, or POST outside / portmap / sync. */
function relayCheck(what = '', method = 'GET', timeout = 20000) {
  return new Promise((resolve) => {
    const r = require('http').request({ host: '127.0.0.1', port: 8080, path: `/check${what ? `/${what}` : ''}`, method, timeout }, (x) => { let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    r.on('error', () => resolve(null)); r.on('timeout', () => r.destroy()); r.end();
  });
}
/** Is this PC running the relay? -> { installed, health } (health from http://127.0.0.1:8080/health) */
async function relayHostState() {
  if (process.platform !== 'win32') return { installed: false };
  let installed = false;
  try { await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (Get-ScheduledTask -TaskName 'Riyeser Relay' -ErrorAction SilentlyContinue) { exit 0 } else { exit 3 }"]); installed = true; } catch { installed = false; }
  const health = await new Promise((resolve) => { const r = require('http').get('http://127.0.0.1:8080/health', { timeout: 1500 }, (x) => { let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => r.destroy()); });
  return { installed, health };
}

/** A Namecheap Dynamic DNS password as pasted (spaces around it trimmed) -> it, or throws a plain message. */
function checkDdnsPassword(pw) {
  const p = String(pw || '').trim();
  if (!/^[^\s"`$\\]{8,200}$/.test(p)) throw new Error('That doesn\'t look like a Namecheap Dynamic DNS password. Copy it again from Namecheap: Domain List → Manage → Advanced DNS → Dynamic DNS (not your account password).');
  return p;
}

module.exports = { relayHostScript, relayUninstallScript, parseUninstall, keepAwakeScript, relayPcFacts, relayCheck, relayHostState, checkDdnsPassword, RULE, firewallCommands, firewallRuleExists, ruleState, addFirewallRule, parsePowercfg, sleepWarning, readSleep,
  PS_NETCONFIG, parseNetConfig, readNetConfig, prefixToMask, fixedAddressScript, dhcpScript, runElevatedScript };
