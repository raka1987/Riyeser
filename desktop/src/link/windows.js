// The two Windows things Riyeser Link Office looks at: sleep settings (read only, never changed) and its own firewall rule.
// The firewall rule is the only system change Riyeser Link Office ever makes. The installer adds it (the installer is
// per-machine, so Windows asks once for permission); if it's missing later, the status screen offers a button that
// adds the same rule, which asks Windows for permission again. Uninstalling removes it.
const { execFile } = require('child_process');

const RULE = 'Riyeser Link Office';
const OFFICE = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16';
/** The netsh commands that add the rule for this program only (UDP 5060; TCP 5060 and the phone set-up port). */
function firewallCommands(exe, httpPort = 5080) {
  const common = `dir=in action=allow program="${exe}" enable=yes profile=any remoteip=${OFFICE}`;
  return [
    `netsh advfirewall firewall delete rule name="${RULE}"`,
    `netsh advfirewall firewall add rule name="${RULE}" ${common} protocol=UDP localport=5060 description="Desk phones on the office network (SIP)"`,
    `netsh advfirewall firewall add rule name="${RULE}" ${common} protocol=TCP localport=5060,${httpPort} description="Desk phones on the office network (SIP and phone set-up)"`,
  ];
}
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 20000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') })));

/** true / false, or null when it can't be told (not Windows). */
async function firewallRuleExists() {
  if (process.platform !== 'win32') return null;
  const r = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE}`]);
  return r.ok && /Riyeser Link Office/i.test(r.out);
}
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

module.exports = { RULE, firewallCommands, firewallRuleExists, addFirewallRule, parsePowercfg, sleepWarning, readSleep };
