// Notices when this PC's network addresses change (a router restart, Wi-Fi <-> Ethernet, a new network, a VPN), so
// Riyeser Link Office can move the phones to the new address within seconds instead of leaving them on the old one.
//   Polling   the adapters' addresses every few seconds (cheap: os.networkInterfaces()).
//   OS events on Windows, a small PowerShell helper listens for .NET's NetworkChange.NetworkAddressChanged and prints a
//             line each time; on Linux, `ip -o monitor address`. Either only makes the next check happen sooner: the
//             poll always works on its own, so a missing or broken helper changes nothing but the speed.
// A change is reported once things have settled (DHCP often gives a 169.254 address first, then the real one).
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { addressSignature } = require('./netinfo');

// .NET raises NetworkAddressChanged on any IPv4/IPv6 address change. Static event: registered on the type itself.
const PS_WATCH = [
  "$ErrorActionPreference = 'Stop'",
  "Register-ObjectEvent -InputObject ([System.Net.NetworkInformation.NetworkChange]) -EventName NetworkAddressChanged -SourceIdentifier RiyeserNet | Out-Null",
  "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
  'while ($true) { $e = Wait-Event -SourceIdentifier RiyeserNet; Remove-Event -SourceIdentifier RiyeserNet; [Console]::Out.WriteLine(\'changed\'); [Console]::Out.Flush() }',
].join('; ');

/** The OS's own "an address changed" signal, as an EventEmitter ('changed', 'ready'), or null where there's none. */
function osAddressEvents({ platform = process.platform, spawnFn = spawn, log = () => {} } = {}) {
  const cmd = platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_WATCH]]
    : platform === 'linux' ? ['ip', ['-o', 'monitor', 'address']] : null;
  if (!cmd) return null;
  const ev = new EventEmitter();
  let child = null; let stopped = false; let tries = 0; let timer = null;
  const start = () => {
    if (stopped) return;
    try { child = spawnFn(cmd[0], cmd[1], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { child = null; }
    if (!child || !child.stdout) { ev.emit('unavailable'); return; }
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += String(d); const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const l of lines) { if (!l.trim()) continue; if (l.trim() === 'ready') { tries = 0; ev.ready = true; ev.emit('ready'); } else ev.emit('changed', l.trim().slice(0, 200)); }
    });
    child.on('error', () => {});
    child.on('exit', () => {
      child = null; ev.ready = false;
      if (stopped) return;
      // the helper died (or PowerShell isn't allowed): try again later, less and less often; polling carries on meanwhile
      if (++tries > 5) { log('info', 'Network change events are unavailable; checking the address every few seconds instead.'); ev.emit('unavailable'); return; }
      timer = setTimeout(start, Math.min(60000, 2000 * 2 ** tries)); if (timer.unref) timer.unref();
    });
  };
  start();
  ev.stop = () => { stopped = true; clearTimeout(timer); if (child) { try { child.kill(); } catch { /* gone */ } } child = null; };
  return ev;
}

class NetWatcher extends EventEmitter {
  /**
   * opts: { ifaces: () => os.networkInterfaces()-like, interval = 5000, settle = 2500, events: EventEmitter | null | undefined
   *         (undefined: the OS's own, osAddressEvents()), log }
   * Emits 'change' { before, after, source: 'poll' | 'os' | 'resume' | 'check' } when the addresses changed and settled.
   */
  constructor(opts = {}) {
    super();
    this.ifacesFn = opts.ifaces || (() => os.networkInterfaces());
    this.interval = opts.interval || 5000; this.settle = opts.settle == null ? 2500 : opts.settle;
    this.eventsOpt = opts.events; this.log = opts.log || (() => {});
    this.sig = null; this.timer = null; this.settling = null; this.events = null;
  }
  read() { try { return addressSignature(this.ifacesFn()); } catch { return this.sig || ''; } }
  start() {
    this.sig = this.read();
    this.timer = setInterval(() => this.check('poll'), this.interval); if (this.timer.unref) this.timer.unref();
    this.events = this.eventsOpt === undefined ? osAddressEvents({ log: this.log }) : this.eventsOpt;
    if (this.events) { this.onOs = () => this.check('os'); this.events.on('changed', this.onOs); }
    return this;
  }
  stop() {
    clearInterval(this.timer); clearTimeout(this.settling); this.timer = null; this.settling = null;
    if (this.events) { this.events.off('changed', this.onOs); if (this.eventsOpt === undefined && this.events.stop) this.events.stop(); }
    this.events = null;
  }
  /** Look now (a timer, an OS event, the PC waking up). Something changed: wait for it to settle, then say so. */
  check(source = 'check') {
    if (this.read() === this.sig && !this.settling) return false;
    if (this.settling) return true;
    const before = this.sig;
    const done = () => {
      const now = this.read();
      if (now !== this.lastSeen) { this.lastSeen = now; this.settling = setTimeout(done, this.settle); if (this.settling.unref) this.settling.unref(); return; }   // still moving
      this.settling = null; this.lastSeen = null;
      if (now === before) return;
      this.sig = now;
      this.emit('change', { before, after: now, source });
    };
    this.lastSeen = this.read();
    if (!this.settle) { this.lastSeen = null; const now = this.read(); this.sig = now; this.emit('change', { before, after: now, source }); return true; }
    this.settling = setTimeout(done, this.settle); if (this.settling.unref) this.settling.unref();
    return true;
  }
}

module.exports = { NetWatcher, osAddressEvents, PS_WATCH };
